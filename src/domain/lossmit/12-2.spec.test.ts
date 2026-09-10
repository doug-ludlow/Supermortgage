// 12.2 Complete-application evaluation
// spec/sections/12-loss-mitigation/12-2-complete-application-evaluation.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
// The bus flows run the 12.2 tools (src/app/tools/section12.ts + section12-2.ts over ops-12-2.ts) against the
// TimerEngine with the overridden registry, so every timer a T-id names is armed by the trigger the tools emit and
// satisfied by the event they append.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CommandBus, CommandRefused, type CommandSpec } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime, type ToolInput, type ToolDef } from "../../app/tools.ts";
import { SECTION_12_TOOLS } from "../../app/tools/section12.ts";
import { TOOLS_12_2 } from "../../app/tools/section12-2.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { FakeFnmaSmdu } from "../../infra/integrations/fnma.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { NoticeService } from "../../notices/service.ts";
import { denialNoticeContent, thirdPartyDelay, imminentDefaultDecline, appealExtendsAcceptance, caDenialHolds, smduOutageEvaluation, counselInstruction, streamlinedSolicitationWithOpenApp, deemedRejection, nyOverlay } from "./ops.ts";
import { thirdPartyRequests, reviewerDue, draftDecision, trialFirstPayment, ingestSmduDecision, gateLapses } from "./ops-12-2.ts";
import { tier, evaluationDeadlines, hierarchyWalk, fnmaNoticeCheck, rankingReasonAllowed, appealEligible, HIERARCHY } from "./evaluation.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";

const registry = () => { const reg = buildRegistry(); publishAuthored(reg); return reg; };
/** Render the real §1024.41(c)(1)(ii)/(d) denial template for one denied modification option. */
const renderDenial = (criterion: string, investor = "Fannie Mae") => { const v = registry().activeVersion("NTC_REGX_41C1_DENIAL", D("2026-11-02"))!; const payload = { ...v.samplePayload, denied: [{ name: "Flex Modification", reason: criterion, investor_name: investor, investor_requirement: criterion }], investor_name: investor, not_evaluated_other_criteria: true }; return { v, payload, out: render(v.source, payload) }; };

// ───── bus harness (the 12.2 tools over the overridden registry; see lossmit-bus.test.ts) ─────
const AGENT: Actor = { kind: "agent", id: "lossmit-underwriter" };
const LOAN = "L-122";
const RECIPIENTS = [{ partyId: "b1", name: "Borrower", mailingAddress: "1 Test St, Testville TX 75001" }];
const toolKey = (process: string, name: string): string => `${process} ${name}`;
function bind(rt: ToolRuntime, agents: AgentRegistry, defs: readonly ToolDef[]): Map<string, CommandSpec<ToolInput, unknown>> {
  const escalates = new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
  const out = new Map<string, CommandSpec<ToolInput, unknown>>();
  for (const d of defs) { const cmd = toolCommand(d, rt, escalates.get(d.process) ?? []); agents.registerTool(d.agent, cmd.name); out.set(toolKey(d.process, d.name), cmd); }
  return out;
}
function harness(nowIso: string) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const decisions: DecisionInput[] = [];
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["12.2"] });
  const uow: UowContext = { loanId: LOAN, events, ledger: new MemoryLedger(), timers, clock, decide: (d) => { decisions.push(d); } };
  const noticeReg = registry();
  const notices = new NoticeService({ registry: noticeReg, events, clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() });
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, notices, ports: { smdu: new FakeFnmaSmdu(), printMail: new FakePrintMail(), edelivery: new FakeEdelivery() } };
  const agents = new AgentRegistry(); const cmds = bind(rt, agents, [...SECTION_12_TOOLS.filter((d) => d.process === "12.2"), ...TOOLS_12_2]); const bus = new CommandBus(agents);
  const run = async (name: string, input: ToolInput): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey("12.2", name))!, AGENT, { loan_id: LOAN, ...input }, uow)).output as Record<string, unknown>;
  const refused = (name: string, input: ToolInput, code: string) => assert.rejects(bus.execute(cmds.get(toolKey("12.2", name))!, AGENT, { loan_id: LOAN, ...input }, uow), (e: unknown) => e instanceof CommandRefused && e.code === code);
  const rejects = (name: string, input: ToolInput, re: RegExp) => assert.rejects(bus.execute(cmds.get(toolKey("12.2", name))!, AGENT, { loan_id: LOAN, ...input }, uow), (e: unknown) => e instanceof RangeError && re.test(e.message));
  const timer = (code: string) => timers.byCode(code);
  const emitted = (type: string) => events.all().filter((e) => e.type === type);
  const at = (iso: string) => clock.set(iso);
  return { rt, events, timers, run, refused, rejects, timer, emitted, noticeReg, notices, at };
}
const criterion3 = "loan has been modified three times previously";
/** A drafted denial of Flex Mod (INV_FNMA_D23206_3_PRIOR_MODS) with the other options determined (rule 5). */
const DENIAL_DRAFT = [{ option: "reinstatement", result: "denied", reason_codes: ["AFFORD_REPAY_150"] }, { option: "forbearance", result: "denied" }, { option: "repayment_plan", result: "denied" }, { option: "payment_deferral", result: "denied" }, { option: "flex_mod", result: "denied", reason_codes: ["INV_FNMA_D23206_3_PRIOR_MODS"] }, { option: "short_sale", result: "offered" }, { option: "mortgage_release", result: "not_evaluated_ranking" }];
const denialPayload = (reg: ReturnType<typeof registry>, extra: Record<string, unknown> = {}) => { const v = reg.activeVersion("NTC_REGX_41C1_DENIAL", D("2026-11-02"))!; return { ...v.samplePayload, denied: [{ name: "Flex Modification", reason: criterion3, investor_name: "Fannie Mae", investor_requirement: criterion3 }], investor_name: "Fannie Mae", not_evaluated_other_criteria: true, ...extra }; };

test("12.2-T1: Given completion 2026-10-07 and no sale scheduled, when the evaluation runs, then all options have determinations, the notice is provided by 2026-11-06, `accept_by=provided_at+14`, and appeal rights appear for every denied modification option.", () => {
  assert.equal(tier(D("2026-10-07"), null), "ge_90");
  const d = evaluationDeadlines(D("2026-10-07"), D("2026-11-02"), "ge_90");
  assert.equal(d.decision_due, "2026-11-06"); assert.equal(d.accept_by, "2026-11-16"); assert.equal(d.window_days, 14); assert.equal(d.appeal_rights, true);
  assert.equal(fnmaNoticeCheck(D("2026-10-30"), D("2026-11-02")), true);
  // Every option in the F-2-10 hierarchy gets a determination row (12.2 rule 5): the tested-and-failed retention options are `not_eligible`, the first liquidation option is offered, the one it outranks is `not_evaluated_ranking`.
  const walk = hierarchyWalk({ can_reinstate: false, hardship_temporary_unresolved: false, can_afford_repayment: false, deferral_eligible: false, flexmod_eligible: false });
  assert.equal(walk.offered, "short_sale"); assert.deepEqual(walk.path, [...HIERARCHY]); assert.deepEqual(walk.offers, ["short_sale"]);
  assert.deepEqual(walk.determinations.map((d) => [d.option, d.result]), [["reinstatement", "not_eligible"], ["forbearance", "not_eligible"], ["repayment_plan", "not_eligible"], ["payment_deferral", "not_eligible"], ["flex_mod", "not_eligible"], ["short_sale", "offered"], ["mortgage_release", "not_evaluated_ranking"]]);
  assert.ok(HIERARCHY.every((o) => walk.determinations.some((d) => d.option === o)));
  // A deferral offer leaves flex_mod and the liquidation options `not_evaluated_ranking` — the only case comment 41(d)-1 lets the notice cite the ranking (12.2-T4).
  const deferral = hierarchyWalk({ can_reinstate: false, hardship_temporary_unresolved: false, can_afford_repayment: false, deferral_eligible: true, flexmod_eligible: true });
  assert.equal(deferral.offered, "payment_deferral"); assert.equal(deferral.determinations.find((d) => d.option === "flex_mod")!.result, "not_evaluated_ranking"); assert.equal(deferral.determinations.find((d) => d.option === "repayment_plan")!.result, "not_eligible");
  assert.ok(deferral.determinations.filter((d) => d.result === "not_evaluated_ranking").every((d) => rankingReasonAllowed("payment_deferral", d.option)));
  // 12.2 rule 2: a stated liquidation request is evaluated first, then the retention path continues so every modification option still gets a stated determination.
  const asked = hierarchyWalk({ can_reinstate: false, hardship_temporary_unresolved: false, can_afford_repayment: false, deferral_eligible: false, flexmod_eligible: true, liquidation_requested: true, liquidation_option: "short_sale", liquidation_eligible: true });
  assert.equal(asked.path[0], "short_sale"); assert.equal(asked.offered, "short_sale"); assert.deepEqual(asked.offers, ["short_sale", "flex_mod"]);
  assert.deepEqual(asked.determinations.map((d) => [d.option, d.result]), [["short_sale", "offered"], ["reinstatement", "not_eligible"], ["forbearance", "not_eligible"], ["repayment_plan", "not_eligible"], ["payment_deferral", "not_eligible"], ["flex_mod", "offered"], ["mortgage_release", "not_requested"]]);
  assert.equal(hierarchyWalk({ ...asked, liquidation_eligible: false, can_reinstate: false, hardship_temporary_unresolved: false, can_afford_repayment: false, deferral_eligible: false, flexmod_eligible: false, liquidation_requested: true }).determinations[0]!.result, "not_eligible");
  assert.equal(appealEligible("ge_90", true, true), true);   // the denied modification (flex_mod) carries appeal rights at this tier
});
test("12.2-T2: (7-day tier) sale 2027-01-15, complete 2026-11-01 (75 days before) → acceptance 7 days; no appeal rights statement (tier <90) but Fannie Mae D2-2-07 appeal availability check also negative.", async () => {
  assert.equal(tier(D("2026-11-01"), D("2027-01-15")), "lt_90");
  const d = evaluationDeadlines(D("2026-11-01"), D("2026-11-20"), "lt_90");
  assert.equal(d.window_days, 7); assert.equal(d.accept_by, "2026-11-27"); assert.equal(d.appeal_rights, false); assert.equal(d.grace_days, 3); assert.equal(d.deemed_rejected_on, "2026-11-30");
  assert.equal(appealEligible("lt_90", true, true), false);   // first filing already made → neither Reg X nor D2-2-07 (complete BRP <90 days before the sale) grants an appeal
  // On the bus: the decision carries the 7-day window; providing the offer on 2026-11-20 arms REGX_1024_41E1_ACCEPT_7 (not the 14-day row) due 2026-11-27.
  const h = harness("2026-11-20T15:00:00.000Z");
  const rec = await h.run("lossmit.evaluation.*", { id: "eval-2", application_id: "lma-2", complete_on: "2026-11-01", sale_on: "2027-01-15", provided_on: "2026-11-20", outcome: "offered", option: "payment_deferral", state: "TX" });
  assert.equal(rec.tier, "lt_90"); assert.equal(rec.window_days, 7); assert.equal(rec.accept_by, "2026-11-27"); assert.equal(rec.appeal_rights, false); assert.equal(rec.deemed_rejected_on, "2026-11-30");
  const v = h.noticeReg.activeVersion("NTC_FNMA_D23204_DEFERRAL_OFFER", D("2026-11-20"))!;
  await h.run("notice.render_send", { template_code: "NTC_FNMA_D23204_DEFERRAL_OFFER", option: "payment_deferral", recipients: RECIPIENTS, payload: v.samplePayload });
  const sent = h.emitted("lossmit.offer.sent"); assert.equal(sent.length, 1); assert.equal(sent[0]!.payload.tier, "lt_90"); assert.equal(sent[0]!.payload.provided_at, "2026-11-20");
  assert.equal(h.timer("REGX_1024_41E1_ACCEPT_7").length, 1); assert.equal(h.timer("REGX_1024_41E1_ACCEPT_7")[0]!.dueDate, "2026-11-27"); assert.equal(h.timer("REGX_1024_41E1_ACCEPT_14").length, 0); assert.equal(h.timer("NY_419_7G_ACCEPT_30").length, 0);
});
test('12.2-T3: (denial content) Flex Mod denied because "loan has been modified three times previously" → notice names Fannie Mae, quotes the criterion, states other criteria not evaluated; `lossmit_reviewer` approval recorded before mailing; mailing blocked without approval.', async () => {
  const criterion = criterion3;
  const { v, payload, out } = renderDenial(criterion);
  assert.equal(evaluateChecklist(v, payload, out).passed, true);
  const blocked = denialNoticeContent({ investor: "Fannie Mae", option: "Flex Modification", criterion, rendered_text: out.text });
  assert.equal(blocked.names_investor, true); assert.equal(blocked.quotes_criterion, true); assert.equal(blocked.states_other_criteria, true); assert.equal(blocked.content_ok, true); assert.equal(blocked.mailing_allowed, false); assert.match(blocked.refusal!, /lossmit_reviewer/);
  const ok = denialNoticeContent({ investor: "Fannie Mae", option: "Flex Modification", criterion, reviewer_approval_id: "rev-1", rendered_text: out.text });
  assert.equal(ok.mailing_allowed, true); assert.equal(ok.refusal, null);
  // A rendered notice that drops the criterion or names no investor fails the content check even with the approval recorded.
  const bare = denialNoticeContent({ investor: "Fannie Mae", option: "Flex Modification", criterion, reviewer_approval_id: "rev-1", rendered_text: "We are unable to offer you a Flex Modification under investor guidelines." });
  assert.equal(bare.quotes_criterion, false); assert.equal(bare.states_other_criteria, false); assert.equal(bare.mailing_allowed, false); assert.match(bare.refusal!, /content check failed/);
  assert.equal(denialNoticeContent({ investor: "Fannie Mae", option: "Flex Modification", criterion, reviewer_approval_id: "rev-1" }).names_investor, null);   // no rendered text → nothing is claimed about the content
  // On the bus: the draft with a denial arms the reviewer SLA (SM_LM_REVIEWER_DENIAL_APPROVAL_2BD; 9 days left on the 30-day clock → policy 1 BD), the denial mailing is refused until `lossmit.evaluation.reviewed` records the approval, then the sent notice carries the three statements.
  const h = harness("2026-10-28T15:00:00.000Z");
  await h.run("lossmit.evaluation.*", { op: "start", id: "eval-3", application_id: "lma-3", complete_on: "2026-10-07", state: "TX", option: "flex_mod" });
  const draft = await h.run("lossmit.evaluation.*", { op: "draft", id: "eval-3", determinations: DENIAL_DRAFT, evaluator_run_owner: "run-owner-3" });
  assert.equal(draft.status, "reviewer_pending"); assert.equal(draft.has_denial, true); assert.equal(draft.review_due, "2026-10-29"); assert.equal(draft.review_business_days, 1); assert.equal(draft.days_remaining, 9);
  const drafted = h.emitted("lossmit.evaluation.decision_drafted"); assert.equal(drafted.length, 1); assert.equal(drafted[0]!.payload.has_denial, true); assert.equal(drafted[0]!.payload.drafted_on, "2026-10-28");
  const sla = h.timer("SM_LM_REVIEWER_DENIAL_APPROVAL_2BD"); assert.equal(sla.length, 1); assert.equal(sla[0]!.status, "armed"); assert.equal(sla[0]!.anchorDate, "2026-10-28"); assert.equal(sla[0]!.dueDate, "2026-10-30");   // registry 2 servicer BD; ops tightens to 1 BD (review_due) with <10 days left
  assert.deepEqual(reviewerDue(D("2026-10-10"), D("2026-10-07")), { due: D("2026-10-14"), business_days: 2, days_remaining: 27, day30: D("2026-11-06") });   // Sat 10/10 → Mon 10/12 (Columbus Day) skipped → Wed 10/14
  assert.equal(reviewerDue(D("2026-11-05"), D("2026-10-07")).due, "2026-11-06");   // never past the 30-day date
  await h.refused("notice.render_send", { template_code: "NTC_REGX_41C1_DENIAL", option: "Flex Modification", criterion, investor: "Fannie Mae", recipients: RECIPIENTS, payload: denialPayload(h.noticeReg) }, "DENIAL_NEEDS_REVIEWER");
  assert.equal(h.emitted("notice.sent").length, 0);
  await h.rejects("lossmit.evaluation.*", { op: "review", id: "eval-3", decision: "approved", reviewer: { id: "run-owner-3", role: "lossmit_reviewer" } }, /evaluator run owner/);
  const reviewed = await h.run("lossmit.evaluation.*", { op: "review", id: "eval-3", decision: "approved", reviewer: { id: "rev-3", role: "lossmit_reviewer" } });
  assert.equal(reviewed.status, "decided"); assert.equal(reviewed.reviewer_id, "rev-3"); assert.equal(reviewed.reviewer_decision, "approved"); assert.equal(reviewed.reviewer_approval_id, "rev-eval-3-rev-3");
  assert.equal(h.emitted("lossmit.evaluation.reviewed").length, 1); assert.equal(sla[0]!.status, "satisfied");
  const n = await h.run("notice.render_send", { template_code: "NTC_REGX_41C1_DENIAL", option: "Flex Modification", criterion, investor: "Fannie Mae", reviewer_approval_id: reviewed.reviewer_approval_id, recipients: RECIPIENTS, payload: denialPayload(h.noticeReg) }) as { id: string; status: string; rendered: { text: string } };
  assert.equal(n.status, "sent"); assert.match(n.rendered.text, /Fannie Mae/); assert.ok(n.rendered.text.includes(criterion)); assert.match(n.rendered.text, /not evaluated on any other criteria/);
  const sent = h.emitted("notice.sent"); assert.equal(sent.length, 1); assert.equal(sent[0]!.payload.template, "NTC_REGX_41C1_DENIAL");
  const provided = h.emitted("lossmit.denial.provided"); assert.equal(provided.length, 1); assert.equal(provided[0]!.payload.state, "TX"); assert.equal(provided[0]!.payload.appeal_days, 14); assert.equal(provided[0]!.payload.appeal_by, "2026-11-11");
  assert.equal(h.rt.store.get("lossmit_evaluations", "eval-3")!.data.status, "notice_provided");
  assert.equal(h.timer("CA_CIV_2923_6E_NOD_NOS_HOLD_31").length, 0);   // TX: no CA gate
  // A catalog-only reason code and the Flex Mod NPV ban hold at the draft.
  assert.throws(() => draftDecision({ evaluation_id: "x", complete_on: D("2026-10-07"), drafted_on: D("2026-10-28"), determinations: [{ option: "flex_mod", result: "denied", reason_codes: ["free text"] }] }), /not from the catalog/);
  assert.throws(() => draftDecision({ evaluation_id: "x", complete_on: D("2026-10-07"), drafted_on: D("2026-10-28"), determinations: [{ option: "flex_mod", result: "denied", reason_codes: ["NPV_NEGATIVE"] }] }), /NPV_NEGATIVE is disabled/);
  assert.equal(draftDecision({ evaluation_id: "x", complete_on: D("2026-10-07"), drafted_on: D("2026-10-10"), determinations: [{ option: "flex_mod", result: "not_evaluated_ineligible_by_loan_data", reason_codes: ["INV_FNMA_D23206_3_PRIOR_MODS"] }, { option: "short_sale", result: "offered" }] }).has_denial, true);   // rule 1: loan-data exclusion of a modification is still a (d) denial
  assert.equal(draftDecision({ evaluation_id: "x", complete_on: D("2026-10-07"), drafted_on: D("2026-10-10"), determinations: [{ option: "payment_deferral", result: "offered" }, { option: "flex_mod", result: "not_evaluated_ranking" }] }).status, "decision_drafted");
});
test(`12.2-T4: (ranking reason) Payment Deferral offered; Flex Mod not offered "because Fannie Mae's hierarchy places the deferral first" → allowed only because deferral outranks Flex Mod; the reverse ordering is rejected by the checklist.`, async () => {
  assert.equal(rankingReasonAllowed("payment_deferral", "flex_mod"), true); assert.equal(rankingReasonAllowed("flex_mod", "payment_deferral"), false);
  const { out } = renderDenial("Fannie Mae's workout hierarchy places the payment deferral ahead of a modification");
  const ok = denialNoticeContent({ investor: "Fannie Mae", option: "Flex Modification", criterion: "Fannie Mae's workout hierarchy places the payment deferral ahead of a modification", reviewer_approval_id: "rev-1", rendered_text: out.text, ranking_reason: { offered: "payment_deferral", denied: "flex_mod" } });
  assert.equal(ok.ranking_reason_allowed, true); assert.equal(ok.mailing_allowed, true);
  const reversed = denialNoticeContent({ investor: "Fannie Mae", option: "Payment Deferral", criterion: "Fannie Mae's workout hierarchy places the modification ahead of a deferral", reviewer_approval_id: "rev-1", rendered_text: out.text, ranking_reason: { offered: "flex_mod", denied: "payment_deferral" } });
  assert.equal(reversed.ranking_reason_allowed, false); assert.equal(reversed.mailing_allowed, false); assert.match(reversed.refusal!, /does not outrank/);
  // On the bus: the reversed ordering is refused by the RANKING_REASON_ORDER guardrail before anything renders; the allowed ordering mails.
  const h = harness("2026-11-02T15:00:00.000Z");
  await h.run("lossmit.evaluation.*", { op: "start", id: "eval-4", application_id: "lma-4", complete_on: "2026-10-07", state: "TX", option: "payment_deferral" });
  const reason = "Fannie Mae's workout hierarchy places the payment deferral ahead of a modification";
  const payload = denialPayload(h.noticeReg, { denied: [{ name: "Flex Modification", reason, investor_name: "Fannie Mae", investor_requirement: reason }] });
  await h.refused("notice.render_send", { template_code: "NTC_REGX_41C1_DENIAL", option: "Payment Deferral", criterion: reason, reviewer_approval_id: "rev-4", ranking_reason: { offered: "flex_mod", denied: "payment_deferral" }, recipients: RECIPIENTS, payload }, "RANKING_REASON_ORDER");
  assert.equal(h.emitted("notice.rendered").length, 0);
  const n = await h.run("notice.render_send", { template_code: "NTC_REGX_41C1_DENIAL", option: "Flex Modification", criterion: reason, reviewer_approval_id: "rev-4", ranking_reason: { offered: "payment_deferral", denied: "flex_mod" }, recipients: RECIPIENTS, payload }) as { status: string };
  assert.equal(n.status, "sent"); assert.equal(h.emitted("lossmit.denial.provided").length, 1);
});
test("12.2-T5: (third-party delay) BPO outstanding at day 30 → delay notice plus all determinable results sent by day 30; on BPO receipt day 38, short-sale determination sent within 5 days; `foreclosure_holds{kind=lm_third_party_pending}` held throughout.", async () => {
  const r = thirdPartyDelay({ complete_on: D("2026-10-01"), item: "BPO", received_on: D("2026-11-08") });
  assert.equal(r.day30, "2026-10-31"); assert.equal(r.delay_notice_by, "2026-10-31"); assert.equal(r.determinable_results_by, "2026-10-31"); assert.equal(r.notice, "NTC_REGX_41C4IIB_THIRD_PARTY_DELAY");
  assert.equal(r.determination_by, "2026-11-13"); assert.equal(r.hold.kind, "lm_third_party_pending"); assert.equal(r.hold.from, "2026-10-01"); assert.equal(r.hold.to, "2026-11-13"); assert.equal(r.hold.active, true);
  // On the bus: the evaluation starts with the BPO outstanding → REGX_1024_41C4_THIRD_PARTY_REQUEST_PROMPT (2 servicer BD from the start: Thu 10/01 → Mon 10/05) and the 30-day heightened-diligence row; placing the request for every item (`integration_messages.sent{items_remaining=0}`) satisfies the prompt row, the receipt on day 38 satisfies the 30-day row, and the hold stays until then.
  const h = harness("2026-10-01T14:00:00.000Z");
  await h.run("lossmit.evaluation.*", { op: "start", id: "eval-5", application_id: "lma-5", complete_on: "2026-10-01", state: "TX", third_party_items: ["BPO", "MI"] });
  const prompt = h.timer("REGX_1024_41C4_THIRD_PARTY_REQUEST_PROMPT"); assert.equal(prompt.length, 1); assert.equal(prompt[0]!.anchorDate, "2026-10-01"); assert.equal(prompt[0]!.dueDate, "2026-10-05");
  assert.equal(h.timer("REGX_1024_41C4_THIRD_PARTY_HEIGHTEN_30")[0]!.dueDate, "2026-10-31");
  await h.run("foreclosure_holds.set/release", { kind: "lm_third_party_pending" });
  await h.rejects("lossmit.evaluation.*", { op: "third_party_request", id: "eval-5", items: ["BPO"] }, /every outstanding item must be requested together: missing MI/);   // a partial batch never satisfies the row
  assert.equal(prompt[0]!.status, "armed"); assert.equal(h.emitted("integration_messages.sent").length, 0);
  const req = await h.run("lossmit.evaluation.*", { op: "third_party_request", id: "eval-5", items: ["BPO", "MI"], requested_on: "2026-10-02" });
  assert.deepEqual(req.requested, [{ item: "BPO", adapter: "valuation-order-api" }, { item: "MI", adapter: "mi" }]); assert.equal(req.request_by, "2026-10-05"); assert.equal(req.on_time, true);
  const msgs = h.emitted("integration_messages.sent"); assert.equal(msgs.length, 2); assert.deepEqual(msgs.map((m) => m.payload.items_remaining), [1, 0]); assert.ok(msgs.every((m) => m.payload.kind === "third_party_request"));
  assert.equal(prompt[0]!.status, "satisfied"); assert.equal(prompt[0]!.satisfiedByEventId, msgs[1]!.id);
  assert.throws(() => thirdPartyRequests({ evaluation_id: "e", outstanding: ["BPO"], items: ["TAX_CERT"], requested_on: D("2026-10-02"), started_on: D("2026-10-01") }), /not outstanding/);
  assert.equal(thirdPartyRequests({ evaluation_id: "e", outstanding: ["BPO"], items: ["BPO"], requested_on: D("2026-10-06"), started_on: D("2026-10-01") }).on_time, false);
  h.at("2026-11-08T14:00:00.000Z");
  assert.deepEqual(h.timers.evaluate("2026-11-08T14:00:00.000Z").map((b) => b.def.code), ["REGX_1024_41C4_THIRD_PARTY_HEIGHTEN_30"]);   // day 38: the 30-day row has breached (officer sev-2); the prompt row was satisfied on day 1
  await h.run("lossmit.evaluation.*", { op: "third_party_received", id: "eval-5", item: "MI", received_on: "2026-10-20" });
  assert.equal(h.rt.store.get("foreclosure_holds", `hold-${LOAN}-lm_third_party_pending`)!.data.status, "active");
  await h.run("lossmit.evaluation.*", { op: "third_party_received", id: "eval-5", item: "BPO", received_on: "2026-11-08" });
  assert.equal(h.timer("REGX_1024_41C4_THIRD_PARTY_HEIGHTEN_30")[0]!.status, "satisfied_late"); assert.equal(h.rt.store.get("lossmit_evaluations", "eval-5")!.data.status, "evaluating");
  assert.equal(h.rt.store.get("foreclosure_holds", `hold-${LOAN}-lm_third_party_pending`)!.data.status, "active");   // held throughout; released with the determination (rule 9)
});
test("12.2-T6: (current borrower, Fannie Mae declines) imminent-default case declined in SMDU → Form 182-based notice within 30 days; Reg B timer satisfied; counteroffer accepted → timers cancelled with reason.", async () => {
  const r = imminentDefaultDecline({ complete_on: D("2026-10-20"), decided_on: D("2026-11-05"), notice_provided_on: D("2026-11-10"), counteroffer_accepted_on: D("2026-11-15") });
  assert.equal(r.notice_code, "NTC_REGB_1002_9_LM_ADVERSE_ACTION"); assert.equal(r.form_basis, "Form 182"); assert.equal(r.notice_by, "2026-11-19"); assert.equal(r.on_time, true); assert.equal(r.reg_b_timer.status, "satisfied");
  assert.equal(r.cancelled.length, 3); assert.ok(r.cancelled.every((c) => c.reason === "counteroffer accepted 2026-11-15"));
  // The Form 182 notice carries the ECOA statement and, because a consumer report was used, the FCRA disclosure.
  const v = registry().activeVersion("NTC_REGB_1002_9_LM_ADVERSE_ACTION", D("2026-11-10"))!; const out = render(v.source, v.samplePayload);
  assert.match(out.text, /Equal Credit Opportunity Act/); assert.match(out.text, /Fair Credit Reporting Act/); assert.equal(evaluateChecklist(v, v.samplePayload, out).passed, true);
  const noAgency = { ...v.samplePayload, credit_agency_phone: "" }; assert.equal(evaluateChecklist(v, noAgency, render(v.source, noAgency)).blocking.some((b) => b.rule_id === "fcra-when-report-used"), true);
  // On the bus: the SMDU adapter callback is ingested as `smdu.case.decisioned{declined, borrower_current}` → FNMA_D2101_FORM182_ADVERSE_ACTION_30 due decision + 30 (2026-12-05); the sent Form 182 notice (`notice.sent{template}`) satisfies it.
  const h = harness("2026-11-05T15:00:00.000Z");
  await h.run("lossmit.evaluation.*", { op: "start", id: "eval-6", application_id: "lma-6", basis: "imminent_default", complete_on: "2026-10-20", state: "TX", option: "flex_mod" });
  await h.rejects("lossmit.evaluation.*", { op: "smdu_decision", case_id: "SMDU-6", case_type: "IMMINENT_DEFAULT", decision: "maybe", borrower_current: true }, /must be approved, declined or refer/);
  await h.rejects("lossmit.evaluation.*", { op: "smdu_decision", case_id: "SMDU-6", case_type: "IMMINENT_DEFAULT", decision: "declined" }, /borrower_current is required/);
  await h.rejects("lossmit.evaluation.*", { op: "smdu_decision", case_id: "SMDU-6", case_type: "WIDGET", decision: "declined", borrower_current: true }, /not an SMDU case type/);
  const dec = await h.run("lossmit.evaluation.*", { op: "smdu_decision", case_id: "SMDU-6", case_type: "IMMINENT_DEFAULT", decision: "declined", borrower_current: true, decided_on: "2026-11-05", reasons: ["No Eligible Financial Hardship"] });
  assert.equal(dec.status, "declined"); assert.equal(dec.form182_required, true); assert.equal(dec.form182_by, "2026-12-05"); assert.equal(dec.rep_warrant_relief, true);
  const ev = h.emitted("smdu.case.decisioned"); assert.equal(ev.length, 1); assert.equal(ev[0]!.payload.declined, true); assert.equal(ev[0]!.payload.borrower_current, true); assert.equal(ev[0]!.payload.decided_on, "2026-11-05");
  assert.equal(h.rt.store.get("lossmit_evaluations", "eval-6")!.data.reg_b_adverse, true); assert.deepEqual(h.rt.store.get("lossmit_evaluations", "eval-6")!.data.smdu_case_ids, ["SMDU-6"]);
  const f182 = h.timer("FNMA_D2101_FORM182_ADVERSE_ACTION_30"); assert.equal(f182.length, 1); assert.equal(f182[0]!.anchorDate, "2026-11-05"); assert.equal(f182[0]!.dueDate, "2026-12-05"); assert.equal(f182[0]!.status, "armed");
  h.at("2026-11-10T15:00:00.000Z");
  const n = await h.run("notice.render_send", { template_code: "NTC_REGB_1002_9_LM_ADVERSE_ACTION", reviewer_approval_id: "rev-6", recipients: RECIPIENTS, payload: v.samplePayload }) as { status: string };
  assert.equal(n.status, "sent"); const sent = h.emitted("notice.sent"); assert.equal(sent.length, 1); assert.equal(sent[0]!.payload.template, "NTC_REGB_1002_9_LM_ADVERSE_ACTION");
  assert.equal(f182[0]!.status, "satisfied"); assert.equal(f182[0]!.satisfiedByEventId, sent[0]!.id);
  // A declined case whose counteroffer is accepted: the open clocks are cancelled with the reason instead.
  const dec2 = ingestSmduDecision({ case_id: "SMDU-7", case_type: "IMMINENT_DEFAULT", decision: "declined", borrower_current: false, decided_on: D("2026-11-05") });
  assert.equal(dec2.form182_required, false); assert.equal(dec2.events[0]!.payload.borrower_current, false);   // a delinquent borrower's decline is outside Reg B §1002.2(c)(2)(ii)
  await h.run("lossmit.evaluation.*", { op: "smdu_decision", case_id: "SMDU-8", case_type: "IMMINENT_DEFAULT", decision: "declined", borrower_current: true, decided_on: "2026-11-10" });
  const second = h.timer("FNMA_D2101_FORM182_ADVERSE_ACTION_30")[1]!; assert.equal(second.status, "armed"); assert.equal(second.dueDate, "2026-12-10");
  h.at("2026-11-15T15:00:00.000Z");
  await h.run("timers.*", { op: "cancel", id: second.id, reason: "counteroffer accepted 2026-11-15" });
  assert.equal(second.status, "cancelled"); assert.equal(second.cancelledReason, "counteroffer accepted 2026-11-15");
  const cancelled = h.emitted("timer.cancelled"); assert.equal(cancelled.length, 1); assert.equal(cancelled[0]!.payload.reason, "counteroffer accepted 2026-11-15"); assert.equal(cancelled[0]!.payload.code, "FNMA_D2101_FORM182_ADVERSE_ACTION_30");
  assert.equal(ingestSmduDecision({ case_id: "SMDU-9", case_type: "FLEX_MOD_TPP", decision: "refer", borrower_current: false, decided_on: D("2026-11-05") }).status, "fnma_referral_pending");
});
test("12.2-T7: (deemed rejection) no response by day 14+5 → `deemed_rejected`; hold released only if no other pending offer/appeal.", async () => {
  const r = deemedRejection({ accept_by: D("2026-11-16"), window_days: 14, today: D("2026-11-21"), responded: false, other_pending_offer: false, appeal_pending: false });
  assert.equal(r.grace_days, 5); assert.equal(r.deemed_rejected_on, "2026-11-21"); assert.equal(r.deemed_rejected, true); assert.equal(r.hold_released, true); assert.equal(r.hold_kind, "lm_offer_pending"); assert.equal(r.g2_satisfied, true);
  assert.equal(deemedRejection({ accept_by: D("2026-11-16"), window_days: 14, today: D("2026-11-20"), responded: false, other_pending_offer: false, appeal_pending: false }).deemed_rejected, false);
  const held = deemedRejection({ accept_by: D("2026-11-16"), window_days: 14, today: D("2026-11-21"), responded: false, other_pending_offer: false, appeal_pending: true });
  assert.equal(held.deemed_rejected, true); assert.equal(held.hold_released, false);
  assert.equal(deemedRejection({ accept_by: D("2026-11-27"), window_days: 7, today: D("2026-11-30"), responded: false, other_pending_offer: false, appeal_pending: false }).grace_days, 3);
  // On the bus: the offer provided 2026-11-02 arms REGX_1024_41E1_ACCEPT_14 (accept_by 2026-11-16); it breaches at expiry, the sweep records `deemed_rejected` only from day 14+5 (2026-11-21), and the `lm_offer_pending` hold closes only when nothing else is pending.
  const h = harness("2026-11-02T15:00:00.000Z");
  await h.run("lossmit.evaluation.*", { op: "start", id: "eval-7", application_id: "lma-7", complete_on: "2026-10-07", state: "TX", option: "payment_deferral" });
  const rec = await h.run("lossmit.evaluation.*", { id: "eval-7", application_id: "lma-7", complete_on: "2026-10-07", provided_on: "2026-11-02", outcome: "offered", option: "payment_deferral", state: "TX" });
  assert.equal(rec.accept_by, "2026-11-16"); assert.equal(rec.deemed_rejected_on, "2026-11-21");
  const v = h.noticeReg.activeVersion("NTC_FNMA_D23204_DEFERRAL_OFFER", D("2026-11-02"))!;
  await h.run("notice.render_send", { template_code: "NTC_FNMA_D23204_DEFERRAL_OFFER", option: "payment_deferral", recipients: RECIPIENTS, payload: v.samplePayload });
  await h.run("foreclosure_holds.set/release", { kind: "lm_offer_pending" });
  const accept = h.timer("REGX_1024_41E1_ACCEPT_14")[0]!; assert.equal(accept.dueDate, "2026-11-16");
  h.at("2026-11-20T15:00:00.000Z");
  assert.ok(h.timers.evaluate("2026-11-20T15:00:00.000Z").some((b) => b.def.code === "REGX_1024_41E1_ACCEPT_14")); assert.equal(accept.status, "breached");   // expiry → deemed_rejected only after the grace
  const early = await h.run("lossmit.evaluation.*", { op: "deemed_rejection", evaluation_id: "eval-7", option: "payment_deferral" });
  assert.equal(early.deemed_rejected, false); assert.equal(early.deemed_rejected_on, "2026-11-21"); assert.equal(h.emitted("lossmit.offer.deemed_rejected").length, 0); assert.equal(h.rt.store.get("lossmit_offers", `offer-${LOAN}-payment_deferral`)!.data.status, "pending");
  h.at("2026-11-21T15:00:00.000Z");
  const withAppeal = await h.run("lossmit.evaluation.*", { op: "deemed_rejection", offer_id: `offer-${LOAN}-payment_deferral`, appeal_pending: true });
  assert.equal(withAppeal.deemed_rejected, true); assert.equal(withAppeal.hold_released, false); assert.equal(h.emitted("foreclosure_holds.closed").length, 0); assert.equal(h.rt.store.get("foreclosure_holds", `hold-${LOAN}-lm_offer_pending`)!.data.status, "active");
  assert.equal(h.rt.store.get("lossmit_offers", `offer-${LOAN}-payment_deferral`)!.data.status, "deemed_rejected");
  const alone = await h.run("lossmit.evaluation.*", { op: "deemed_rejection", offer_id: `offer-${LOAN}-payment_deferral`, accept_by: "2026-11-16", window_days: 14 });
  assert.equal(alone.deemed_rejected, true); assert.equal(alone.hold_released, true); assert.equal(alone.g2_satisfied, true);
  const closed = h.emitted("foreclosure_holds.closed"); assert.equal(closed.length, 1); assert.equal(closed[0]!.payload.kind, "lm_offer_pending"); assert.equal(h.rt.store.get("foreclosure_holds", `hold-${LOAN}-lm_offer_pending`)!.data.status, "released");
  assert.equal(h.emitted("lossmit.offer.deemed_rejected").length, 2); assert.equal(h.emitted("lossmit.offer.deemed_rejected")[0]!.payload.deemed_rejected_on, "2026-11-21");
});
test("12.2-T8: (appeal extends acceptance) appeal filed day 10 → original offer `accept_by` becomes appeal notice + 14.", () => {
  const r = appealExtendsAcceptance({ original_accept_by: D("2026-11-03"), appeal_filed_on: D("2026-10-30"), appeal_notice_provided_on: D("2026-11-25") });
  assert.equal(r.accept_by, "2026-12-09"); assert.equal(r.extended, true); assert.equal(r.timer, "REGX_1024_41E2III_ORIGINAL_OFFER_EXTENDED");
});
test("12.2-T9: (NY) NY loan, tier ge_90 → `accept_by=provided_at+30`; supervisory reviewer recorded for the denial.", async () => {
  assert.equal(evaluationDeadlines(D("2026-10-07"), D("2026-11-02"), "ge_90", "NY").accept_by, "2026-12-02");
  // The 30-day window is a ge_90 overlay (3 NYCRR 419.7(g); `NY_419_7G_ACCEPT_30` "offer, NY loan, tier ge_90"): a NY loan 45–90 days before a sale keeps Reg X's 7 days (+3 grace).
  const nyShort = evaluationDeadlines(D("2026-11-01"), D("2026-11-20"), "lt_90", "NY"); assert.equal(nyShort.window_days, 7); assert.equal(nyShort.accept_by, "2026-11-27"); assert.equal(nyShort.deemed_rejected_on, "2026-11-30");
  assert.equal(nyOverlay({ provided_on: D("2026-11-20"), tier: "lt_90", denial: false }).accept_by, "2026-11-27");
  const ok = nyOverlay({ provided_on: D("2026-11-02"), tier: "ge_90", denial: true, reviewer: { id: "sup-1", supervisory: true, involved_in_evaluation: false } });
  assert.equal(ok.accept_by, "2026-12-02"); assert.equal(ok.accept_by_basis, "ny_30"); assert.equal(ok.supervisory_review_required, true); assert.equal(ok.supervisory_reviewer_recorded, true); assert.equal(ok.refusal, null);
  const involved = nyOverlay({ provided_on: D("2026-11-02"), tier: "ge_90", denial: true, reviewer: { id: "rev-1", supervisory: false, involved_in_evaluation: true } });
  assert.equal(involved.supervisory_reviewer_recorded, false); assert.match(involved.refusal!, /419\.7\(f\)/);
  assert.equal(nyOverlay({ provided_on: D("2026-11-02"), tier: "ge_90", denial: false }).refusal, null);
  // On the bus: the NY ge_90 decision carries accept_by = provided_at + 30, and the denial review is refused until a supervisory reviewer not involved in the evaluation records it.
  const h = harness("2026-11-02T15:00:00.000Z");
  await h.run("lossmit.evaluation.*", { op: "start", id: "eval-9", application_id: "lma-9", complete_on: "2026-10-07", state: "NY", option: "flex_mod" });
  const rec = await h.run("lossmit.evaluation.*", { id: "eval-9", application_id: "lma-9", complete_on: "2026-10-07", provided_on: "2026-11-02", outcome: "denied", state: "NY" });
  assert.equal(rec.tier, "ge_90"); assert.equal(rec.accept_by, "2026-12-02"); assert.equal(rec.window_days, 30); assert.equal(rec.reviewer_required, true);
  const draft = await h.run("lossmit.evaluation.*", { op: "draft", id: "eval-9", determinations: DENIAL_DRAFT });
  assert.equal(draft.status, "reviewer_pending"); assert.equal(h.timer("SM_LM_REVIEWER_DENIAL_APPROVAL_2BD").length, 1);
  await h.rejects("lossmit.evaluation.*", { op: "review", id: "eval-9", decision: "approved", reviewer: { id: "rev-9", role: "lossmit_reviewer", supervisory: false } }, /419\.7\(f\)/);
  await h.rejects("lossmit.evaluation.*", { op: "review", id: "eval-9", decision: "approved", reviewer: { id: "sup-9", role: "lossmit_reviewer", supervisory: true, involved_in_evaluation: true } }, /involved in the evaluation/);
  assert.equal(h.timer("SM_LM_REVIEWER_DENIAL_APPROVAL_2BD")[0]!.status, "armed");
  const reviewed = await h.run("lossmit.evaluation.*", { op: "review", id: "eval-9", decision: "approved", reviewer: { id: "sup-9", role: "lossmit_reviewer", supervisory: true } });
  assert.equal(reviewed.reviewer_id, "sup-9"); assert.equal(reviewed.reviewer_supervisory, true); assert.equal(reviewed.status, "decided");
  const ev = h.emitted("lossmit.evaluation.reviewed"); assert.equal(ev.length, 1); assert.equal(ev[0]!.payload.supervisory, true); assert.equal(ev[0]!.payload.state, "NY"); assert.equal(h.timer("SM_LM_REVIEWER_DENIAL_APPROVAL_2BD")[0]!.status, "satisfied");
});
test("12.2-T10: (CA) denial → `CA_CIV_2923_6E_NOD_NOS_HOLD_31`; 13.x NOD command refused on day 20; appeal window 30 days shown in notice.", async () => {
  const r = caDenialHolds({ denial_provided_on: D("2026-10-20"), nod_requested_on: D("2026-11-09") });
  assert.equal(r.timer, "CA_CIV_2923_6E_NOD_NOS_HOLD_31"); assert.equal(r.hold_until, "2026-11-20"); assert.equal(r.nod_allowed, false); assert.match(r.refusal!, /CA_CIV_2923_6E_NOD_NOS_HOLD_31/); assert.equal(r.appeal_window_days, 30); assert.equal(r.appeal_by, "2026-11-19");
  assert.equal(caDenialHolds({ denial_provided_on: D("2026-10-20"), nod_requested_on: D("2026-11-20") }).nod_allowed, true);
  // On the bus: the CA denial sent 2026-10-20 emits `lossmit.denial.provided{state=CA}` → the gate arms with provided_at + 31 = 2026-11-20; the day-20 sweep lapses nothing (NOD still refused); once the day has passed the sweep records `timer.lapsed{code}` and the gate is satisfied.
  const h = harness("2026-10-20T15:00:00.000Z");
  await h.run("lossmit.evaluation.*", { op: "start", id: "eval-10", application_id: "lma-10", complete_on: "2026-10-01", state: "CA", option: "flex_mod" });
  await h.run("lossmit.evaluation.*", { op: "draft", id: "eval-10", determinations: DENIAL_DRAFT });
  const reviewed = await h.run("lossmit.evaluation.*", { op: "review", id: "eval-10", decision: "approved", reviewer: { id: "rev-10", role: "lossmit_reviewer" } });
  const n = await h.run("notice.render_send", { template_code: "NTC_REGX_41C1_DENIAL", option: "Flex Modification", criterion: criterion3, reviewer_approval_id: reviewed.reviewer_approval_id, recipients: RECIPIENTS, payload: denialPayload(h.noticeReg, { state: "CA", appeal_days: 30, appeal_by: "2026-11-19" }) }) as { status: string; rendered: { text: string } };
  assert.equal(n.status, "sent"); assert.match(n.rendered.text, /appeal our denial of a loan modification option within 30 days/);
  const provided = h.emitted("lossmit.denial.provided"); assert.equal(provided.length, 1); assert.equal(provided[0]!.payload.state, "CA"); assert.equal(provided[0]!.payload.provided_at, "2026-10-20"); assert.equal(provided[0]!.payload.appeal_days, 30); assert.equal(provided[0]!.payload.ca_nod_nos_hold_until, "2026-11-20");
  const gate = h.timer("CA_CIV_2923_6E_NOD_NOS_HOLD_31"); assert.equal(gate.length, 1); assert.equal(gate[0]!.anchorDate, "2026-10-20"); assert.equal(gate[0]!.dueDate, "2026-11-20"); assert.equal(gate[0]!.status, "armed");
  assert.equal(h.rt.store.get("lossmit_evaluations", "eval-10")!.data.ca_nod_nos_hold_until, "2026-11-20");
  h.at("2026-11-09T15:00:00.000Z");   // day 20
  const day20 = await h.run("timers.*", { op: "lapse", code: "CA_CIV_2923_6E_NOD_NOS_HOLD_31" });
  assert.deepEqual(day20.lapsed, []); assert.equal(gate[0]!.status, "armed"); assert.equal(h.emitted("timer.lapsed").length, 0);
  assert.equal(caDenialHolds({ denial_provided_on: D("2026-10-20"), nod_requested_on: D("2026-11-09") }).nod_allowed, false);
  h.at("2026-11-21T15:00:00.000Z");
  const lapsed = await h.run("timers.*", { op: "lapse", code: "CA_CIV_2923_6E_NOD_NOS_HOLD_31" });
  assert.deepEqual(lapsed.lapsed, [{ timer_id: gate[0]!.id, due_date: "2026-11-20" }]);
  const ev = h.emitted("timer.lapsed"); assert.equal(ev.length, 1); assert.equal(ev[0]!.payload.code, "CA_CIV_2923_6E_NOD_NOS_HOLD_31"); assert.equal(ev[0]!.loanId, LOAN);
  assert.equal(gate[0]!.status, "satisfied"); assert.equal(gate[0]!.satisfiedByEventId, ev[0]!.id);
  assert.deepEqual(gateLapses([{ id: "t", code: "X", status: "satisfied", dueAt: 0 }], "X", "2026-11-21T15:00:00.000Z").lapsed, []);   // only armed instances lapse
});
test("12.2-T11: (SMDU outage) B2B down 6 hours at day 24 → portal task filed with package; decision recorded from the operator's SMDU result; notice on time.", () => {
  const r = smduOutageEvaluation({ complete_on: D("2026-10-01"), outage_on: D("2026-10-25"), outage_hours: 6, operator_result: { decision: "approve", smdu_case_id: "SMDU-9", completed_on: D("2026-10-26") }, notice_provided_on: D("2026-10-29") });
  // 12.2 Integrations: the portal fallback opens only after 2 failed submissions or a B2B outage >4 hours with <7 days left on the 30-day clock — day 24 leaves 6.
  assert.equal(r.day_of_outage, 24); assert.equal(r.days_remaining, 6); assert.deepEqual(r.fallback, { applies: true, basis: "outage_over_4h_within_7_days" });
  assert.deepEqual(r.portal_task, { kind: "human_portal_task", package_attached: true, filed_on: "2026-10-25" }); assert.deepEqual(r.decision, { source: "operator_smdu_result", decision: "approve", smdu_case_id: "SMDU-9" }); assert.equal(r.notice_by, "2026-10-31"); assert.equal(r.on_time, true);
  const early = smduOutageEvaluation({ complete_on: D("2026-10-01"), outage_on: D("2026-10-11"), outage_hours: 6, operator_result: { decision: "approve", smdu_case_id: "SMDU-9", completed_on: D("2026-10-12") }, notice_provided_on: D("2026-10-29") });
  assert.deepEqual(early.fallback, { applies: false, basis: null }); assert.equal(early.portal_task, null); assert.equal(early.decision, null);   // 20 days remain → B2B retry, no portal task
  const short = smduOutageEvaluation({ complete_on: D("2026-10-01"), outage_on: D("2026-10-25"), outage_hours: 3, notice_provided_on: D("2026-10-29") }); assert.equal(short.fallback.applies, false);   // <4 hours
  const twice = smduOutageEvaluation({ complete_on: D("2026-10-01"), outage_on: D("2026-10-05"), outage_hours: 1, failed_submissions: 2 }); assert.deepEqual(twice.fallback, { applies: true, basis: "two_failed_submissions" }); assert.equal(twice.decision, null); assert.equal(twice.on_time, null);
});
test("12.2-T12: (counsel) hold set on a loan with a pending summary-judgment motion → instruction sent within 1 BD and acknowledged; a sale conducted anyway is detected by the 13.x sale-event reconciliation and raises a sev-1 NoE-risk incident.", () => {
  const r = counselInstruction({ hold_set_on: D("2026-10-20"), motion_pending: true, instruction_sent_on: D("2026-10-21"), acknowledged_on: D("2026-10-21"), sale_conducted_on: D("2026-11-02") });
  assert.equal(r.instruction_due, "2026-10-21"); assert.equal(r.sent_on_time, true); assert.equal(r.acknowledged, true); assert.equal(r.incident!.kind, "officer"); assert.equal(r.incident!.severity, "sev1"); assert.match(r.incident!.reason, /NoE risk/);
  assert.equal(counselInstruction({ hold_set_on: D("2026-10-20"), motion_pending: true, instruction_sent_on: D("2026-10-21"), acknowledged_on: D("2026-10-21") }).incident, null);
});
test("12.2-T13: (streamlined offer with open incomplete application) day-90 Flex Mod solicitation issued while an incomplete application is open → letter includes incomplete-application disclosures; diligence follow-ups continue; no (c)(1) clock started by the solicitation.", () => {
  const r = streamlinedSolicitationWithOpenApp({ open_incomplete_application: true, day: 90 });
  assert.equal(r.disclosures_included, true); assert.equal(r.diligence_follow_ups_continue, true); assert.equal(r.c1_clock_started, false); assert.equal(r.letter, "NTC_FNMA_D23206_SOLICIT_STREAMLINED");
  const v = registry().activeVersion("NTC_FNMA_D23206_SOLICIT_STREAMLINED", D("2026-11-10"))!;
  const payload = { ...v.samplePayload, open_incomplete_application: true, reasonable_date: "2026-11-30" }; const out = render(v.source, payload);
  assert.match(out.text, /application on file that is incomplete/); assert.equal(evaluateChecklist(v, payload, out).passed, true);
  assert.equal(evaluateChecklist(v, { ...payload, reasonable_date: undefined }, render(v.source, { ...payload, reasonable_date: undefined })).passed, false);
});

// ───── timer rows the T-ids do not name ─────
test("12.2 REGX_1024_41E2II_TRIAL_OTHER_REQS_REASONABLE: the first trial payment by its due date is acceptance (rule 8) and, with other acceptance items missing, opens the 14-day reasonable period; the batch that clears the items satisfies it", async () => {
  const h = harness("2026-11-02T15:00:00.000Z");
  await h.run("lossmit.evaluation.*", { op: "start", id: "eval-e", application_id: "lma-e", complete_on: "2026-10-07", state: "TX", option: "flex_mod" });
  await h.run("lossmit.evaluation.*", { id: "eval-e", application_id: "lma-e", complete_on: "2026-10-07", provided_on: "2026-11-02", outcome: "offered", option: "flex_mod", state: "TX" });
  const v = h.noticeReg.activeVersion("NTC_FNMA_D23204_DEFERRAL_OFFER", D("2026-11-02"))!;
  await h.run("notice.render_send", { template_code: "NTC_FNMA_D23204_DEFERRAL_OFFER", option: "flex_mod", recipients: RECIPIENTS, payload: v.samplePayload });
  const accept = h.timer("REGX_1024_41E1_ACCEPT_14")[0]!; assert.equal(accept.status, "armed");
  // A late or short payment is not acceptance and starts no reasonable period.
  const late = trialFirstPayment({ offer_id: "o", evaluation_id: "eval-e", option: "flex_mod", payment_date: D("2026-12-02"), due_on: D("2026-12-01"), amount_cents: 150_000n, required_cents: 150_000n, acceptance_items_outstanding: ["signed_tpp_notice"] });
  assert.equal(late.accepted_by_payment, false); assert.equal(late.reasonable_period_by, null); assert.equal(late.events.length, 1); assert.equal(late.events[0]!.payload.other_acceptance_items_missing, false);
  assert.equal(trialFirstPayment({ offer_id: "o", evaluation_id: null, option: "flex_mod", payment_date: D("2026-12-01"), due_on: D("2026-12-01"), amount_cents: 149_999n, required_cents: 150_000n, acceptance_items_outstanding: [] }).accepted_by_payment, false);
  assert.throws(() => trialFirstPayment({ offer_id: "o", evaluation_id: null, option: "flex_mod", payment_date: D("2026-12-01"), due_on: D("2026-12-01"), amount_cents: 0n, required_cents: 150_000n, acceptance_items_outstanding: [] }), /positive/);
  h.at("2026-12-01T15:00:00.000Z");
  assert.ok(h.timers.evaluate("2026-12-01T15:00:00.000Z").some((b) => b.def.code === "REGX_1024_41E1_ACCEPT_14")); assert.equal(accept.status, "breached");
  const paid = await h.run("lossmit.evaluation.*", { op: "trial_payment_received", evaluation_id: "eval-e", option: "flex_mod", payment_date: "2026-12-01", due_on: "2026-12-01", amount_cents: "150000", required_cents: "150000", acceptance_items_outstanding: ["signed_tpp_notice", "hardship_affidavit"] });
  assert.equal(paid.accepted_by_payment, true); assert.equal(paid.status, "accepted"); assert.equal(paid.accepted_via, "payment"); assert.equal(paid.grace_until, "2026-12-15");
  const trig = h.emitted("lossmit.trial.first_payment_received"); assert.equal(trig.length, 1); assert.equal(trig[0]!.payload.other_acceptance_items_missing, true); assert.equal(trig[0]!.payload.payment_date, "2026-12-01"); assert.equal(trig[0]!.payload.amount_cents, "150000");
  const responded = h.emitted("lossmit.offer.responded"); assert.equal(responded.length, 1); assert.equal(responded[0]!.payload.accepted_via, "payment"); assert.equal(accept.status, "satisfied_late");   // the (e)(1) clock had expired 2026-11-16; payment by the trial due date still accepts (rule 8)
  const reasonable = h.timer("REGX_1024_41E2II_TRIAL_OTHER_REQS_REASONABLE"); assert.equal(reasonable.length, 1); assert.equal(reasonable[0]!.anchorDate, "2026-12-01"); assert.equal(reasonable[0]!.dueDate, "2026-12-15"); assert.equal(reasonable[0]!.status, "armed");
  await h.rejects("lossmit.evaluation.*", { op: "acceptance_items_received", offer_id: `offer-${LOAN}-flex_mod`, items: ["tax_return"] }, /not outstanding/);
  const first = await h.run("lossmit.evaluation.*", { op: "acceptance_items_received", offer_id: `offer-${LOAN}-flex_mod`, items: ["signed_tpp_notice"], received_on: "2026-12-05" });
  assert.equal(first.complete, false); assert.deepEqual(first.acceptance_items_outstanding, ["hardship_affidavit"]); assert.equal(reasonable[0]!.status, "armed");   // one of two items → still open
  const second = await h.run("lossmit.evaluation.*", { op: "acceptance_items_received", offer_id: `offer-${LOAN}-flex_mod`, items: ["hardship_affidavit"], received_on: "2026-12-10" });
  assert.equal(second.complete, true); assert.equal(second.grace_until, null);
  const partial = h.emitted("lossmit.offer.acceptance_items.partial"); assert.equal(partial.length, 1); assert.equal(partial[0]!.payload.items_remaining, 1);
  const got = h.emitted("lossmit.offer.acceptance_items.received"); assert.equal(got.length, 1); assert.equal(got[0]!.payload.items_remaining, 0);   // only the clearing batch is 'items received'
  assert.equal(reasonable[0]!.status, "satisfied"); assert.equal(reasonable[0]!.satisfiedByEventId, got[0]!.id);
});
