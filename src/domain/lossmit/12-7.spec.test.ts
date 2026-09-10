// 12.7 Disaster Payment Deferral
// spec/sections/12-loss-mitigation/12-7-disaster-payment-deferral.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CommandBus, type CommandSpec } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime, type ToolInput, type ToolDef } from "../../app/tools.ts";
import { SECTION_12_TOOLS } from "../../app/tools/section12.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { FakeFnmaSmdu } from "../../infra/integrations/fnma.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { NoticeService } from "../../notices/service.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { disasterDeferralTimeline, disasterTwelveMonthRule, sameEventCheck, disasterIneligibleRouting, disasterForeclosureGate, disasterOfferGate, capStructure, deferralLedger, DISASTER_FC_PACKAGE_SENDERS } from "./ops.ts";
import { prepareDisasterForeclosurePackage, submitDisasterForeclosurePackage, ingestFnmaDisasterForeclosureApproval, DISASTER_FC_REQUESTS, HAZARD_LOSS_MAILBOX, type DisasterFcCtx } from "./ops-12-7.ts";
import { nib, newPayment, screen } from "./deferral.ts";
import { balanceAfter } from "./flexmod.ts";
import { evaluateGate } from "../../app/evaluators.ts";

const AGENT: Actor = { kind: "agent", id: "lossmit-underwriter" };
const FC_AGENT: Actor = { kind: "agent", id: "foreclosure-ops" };
const OFFICER: Actor = { kind: "human", id: "officer-1", role: "officer" };
const LOAN = "L-12-7";
const PROCESSES = ["12.2", "12.4", "12.5", "12.6", "12.7"];
const toolKey = (process: string, name: string): string => `${process} ${name}`;
/** The §12 bus alone (as src/domain/lossmit/lossmit-bus.test.ts binds it): the 12.4 plan lifecycle, the 12.2 offer response and the 12.6/12.7 deferral tools this process's timers arm and satisfy on. */
function bindSection12(rt: ToolRuntime, agents: AgentRegistry, defs: readonly ToolDef[]): Map<string, CommandSpec<ToolInput, unknown>> {
  const escalates = new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
  const out = new Map<string, CommandSpec<ToolInput, unknown>>();
  for (const d of defs) { const cmd = toolCommand(d, rt, escalates.get(d.process) ?? []); agents.registerTool(d.agent, cmd.name); out.set(toolKey(d.process, d.name), cmd); }
  return out;
}
function harness(nowIso: string) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const decisions: DecisionInput[] = [];
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: PROCESSES });
  const uow: UowContext = { loanId: LOAN, events, ledger: new MemoryLedger(), timers, clock, decide: (d) => { decisions.push(d); } };
  const noticeReg = buildRegistry(); publishAuthored(noticeReg);
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, notices: new NoticeService({ registry: noticeReg, events, clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() }), ports: { smdu: new FakeFnmaSmdu(), printMail: new FakePrintMail(), edelivery: new FakeEdelivery() } };
  const agents = new AgentRegistry(); const cmds = bindSection12(rt, agents, SECTION_12_TOOLS); const bus = new CommandBus(agents);
  const run = async (process: string, name: string, input: ToolInput): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey(process, name))!, AGENT, { loan_id: LOAN, ...input }, uow)).output as Record<string, unknown>;
  const timer = (code: string) => timers.byCode(code);
  const emitted = (type: string) => events.all().filter((e) => e.type === type);
  const ops = (actor: Actor): DisasterFcCtx => ({ events, actor, loanId: LOAN, now: clock.now(), store: rt.store });
  return { clock, events, rt, timers, run, timer, emitted, noticeReg, ops };
}

test("12.7-T1: Given a FEMA IA county, incident 2026-05-10, loan current at incident, disaster forbearance 2026-06-01..2026-11-30 without QRPC, when the plan expires, then the solicitation is sent by 2026-12-15 and, on acceptance 2026-12-20, the case is entered by 2026-12-31 (or processing month January under policy).", async () => {
  const r = disasterDeferralTimeline({ fema_ia: true, incident_on: D("2026-05-10"), current_at_incident: true, forbearance_start: D("2026-06-01"), forbearance_end: D("2026-11-30"), qrpc: false, acceptance_on: D("2026-12-20"), processing_month_policy: true });
  assert.equal(r.eligible, true); assert.equal(r.solicitation_by, "2026-12-15"); assert.equal(r.notice, "NTC_FNMA_D23205_SOLICIT_POST_DISASTER_FORB"); assert.equal(r.entry_by, "2026-12-31"); assert.equal(r.processing_month_entry_by, "2027-01-31");
  // The same clocks on the bus: the 12.4 disaster forbearance 2026-06-01..2026-11-30 expires without QRPC → `workout_plan.ended{status=expired, kind=forbearance, disaster=true, qrpc=false, term_end}` arms FNMA_D23205_POSTFORB_SOLICIT_15 (term_end + 15 calendar days = 2026-12-15).
  const h = harness("2026-11-30T15:00:00.000Z");
  // The 12.4 bus grants the six months as two ≤3-month increments (LL-2026-01 `FNMA_D23201_FORB_INCREMENT_MAX_3M`): 2026-06-01..2026-08-31, then 2026-09-01..2026-11-30 — the plan that expires without QRPC is the second increment.
  const first = await h.run("12.4", "workout_plan.*", { id: "wp-disaster-1", start_on: "2026-06-01", requested_months: 3, months_delinquent_at_start: 0, disaster: true });
  assert.equal(first.term_start, "2026-06-01"); assert.equal(first.term_end, "2026-08-31"); assert.equal(first.disaster, true);
  await h.run("12.4", "workout_plan.*", { id: "wp-disaster-1", op: "complete", ended_on: "2026-08-31", qrpc: false });
  const plan = await h.run("12.4", "workout_plan.*", { id: "wp-disaster", start_on: "2026-09-01", requested_months: 3, cumulative_months: 3, months_delinquent_at_start: 3, disaster: true });
  assert.equal(plan.term_start, "2026-09-01"); assert.equal(plan.term_end, "2026-11-30"); assert.equal(plan.disaster, true);
  assert.equal(h.timer("FNMA_D23205_POSTFORB_SOLICIT_15").length, 0, "the first increment's completion is not an expiry without QRPC");
  await h.run("12.4", "workout_plan.*", { id: "wp-disaster", op: "expire", ended_on: "2026-11-30", qrpc: false });
  const ended = h.emitted("workout_plan.ended").filter((e) => e.payload.status === "expired"); assert.equal(ended.length, 1); assert.equal(ended[0]!.payload.plan_id, "wp-disaster"); assert.equal(ended[0]!.payload.disaster, true); assert.equal(ended[0]!.payload.qrpc, false); assert.equal(ended[0]!.payload.term_end, "2026-11-30");
  const solicit = h.timer("FNMA_D23205_POSTFORB_SOLICIT_15"); assert.equal(solicit.length, 1); assert.equal(solicit[0]!.status, "armed"); assert.equal(solicit[0]!.anchorDate, "2026-11-30"); assert.equal(solicit[0]!.dueDate, "2026-12-15");
  assert.equal(h.timer("FNMA_D23205_POSTREPAY_SOLICIT_15TH").length, 0, "a forbearance expiry is not the repayment-plan failure clock");
  // The Post-Disaster Forbearance Plan Solicitation Cover Letter (sent 2026-12-10, inside the 15 days) satisfies it: `notice.sent{template=NTC_FNMA_D23205_SOLICIT_POST_DISASTER_FORB}`.
  h.clock.set("2026-12-10T15:00:00.000Z");
  const v = h.noticeReg.activeVersion("NTC_FNMA_D23205_SOLICIT_POST_DISASTER_FORB", D("2026-12-10"))!;
  const sent = await h.run("12.6", "notice.render_send", { template_code: "NTC_FNMA_D23205_SOLICIT_POST_DISASTER_FORB", recipients: [{ partyId: "b1", name: "Borrower", mailingAddress: "1 Test St, Testville TX 75001" }], payload: v.samplePayload });
  assert.equal(sent.status, "sent"); const notice = h.emitted("notice.sent"); assert.equal(notice.length, 1); assert.equal(notice[0]!.payload.template, "NTC_FNMA_D23205_SOLICIT_POST_DISASTER_FORB");
  assert.equal(solicit[0]!.status, "satisfied"); assert.equal(solicit[0]!.satisfiedByEventId, notice[0]!.id); assert.ok(solicit[0]!.satisfiedAt!.slice(0, 10) <= solicit[0]!.dueDate!);
  // Acceptance 2026-12-20 (`lossmit.offer.responded{response=accepted, option=disaster_payment_deferral}`) → the case is entered by the last day of that month: FNMA_D23205_DDEFERRAL_SMDU_ENTRY_EOM due 2026-12-31.
  h.clock.set("2026-12-20T15:00:00.000Z");
  await h.run("12.2", "lossmit.evaluation.*", { op: "offer_response", response: "accepted", option: "disaster_payment_deferral", accepted_via: "verbal" });
  const entry = h.timer("FNMA_D23205_DDEFERRAL_SMDU_ENTRY_EOM"); assert.equal(entry.length, 1); assert.equal(entry[0]!.status, "armed"); assert.equal(entry[0]!.dueDate, "2026-12-31");
  // Completion is the SMDU case submission (D2-3.2-05; `smdu.case.submitted{workout=disaster_payment_deferral}`) on 2026-12-28 → entered by 2026-12-31; the agreement follows within five days (FNMA_D23205_AGREEMENT_SEND_5 due 2027-01-02).
  h.clock.set("2026-12-28T15:00:00.000Z");
  await h.run("12.6", "smdu.case.submit", { workout: "disaster_payment_deferral", partner_servicer_number: "123456789", campaign_id: "DPD-2026" });
  const sub = h.emitted("smdu.case.submitted"); assert.equal(sub.length, 1); assert.equal(sub[0]!.payload.disaster, true); assert.equal(sub[0]!.payload.submitted_on, "2026-12-28");
  assert.equal(entry[0]!.status, "satisfied"); assert.equal(entry[0]!.satisfiedByEventId, sub[0]!.id); assert.equal(h.timer("FNMA_D23205_AGREEMENT_SEND_5")[0]!.dueDate, "2027-01-02");
  assert.equal(h.timer("FNMA_D23204_DEFERRAL_SMDU_ENTRY_EOM").length, 0, "the standard 12.6 entry clock does not arm on a disaster acceptance");
  assert.deepEqual(h.timers.evaluate("2027-01-01T05:00:00.000Z").filter((b) => b.def.process === "12.7").map((b) => b.def.code), [], "no 12.7 clock breached on the T1 timeline (the 12.4 outreach/disposition and 12.6 LAR clocks are other processes' steps)");
});
test("12.7-T2: (delinquency at disaster) 2 months delinquent at incident → prior-approval package; no offer until approval id recorded.", () => {
  const s = screen({ months_delinquent: 3, origination_date: D("2021-10-01"), evaluation_date: D("2026-12-20"), cumulative_deferred_months: 0, months_to_maturity: 300, disaster: { delinquency_months_at_disaster: 2, same_event_deferred_before: false } });
  assert.equal(s.eligible, false); if (!s.eligible) { assert.equal(s.reason, "INV_FNMA_D23204_DELQ_AT_DISASTER"); assert.equal(s.next, "fnma_prior_approval"); }
  const pending = disasterOfferGate({ delinquency_months_at_disaster: 2 });
  assert.equal(pending.prior_approval_required, true); assert.equal(pending.package, "F-1-24"); assert.equal(pending.offer_allowed, false); assert.equal(pending.state, "fnma_prior_approval_pending"); assert.match(pending.refusal!, /prior approval must be recorded/);
  const approved = disasterOfferGate({ delinquency_months_at_disaster: 2, fnma_prior_approval_id: "FNMA-PA-1" }); assert.equal(approved.offer_allowed, true); assert.equal(approved.state, "offerable");
  assert.deepEqual(disasterOfferGate({ delinquency_months_at_disaster: 1 }), { prior_approval_required: false, package: null, offer_allowed: true, state: "offerable", refusal: null });
});
test("12.7-T3: (12-month rule) 12 months delinquent at evaluation → contractual payment required before completion.", () => {
  assert.deepEqual(disasterTwelveMonthRule(12), { contractual_payment_required: true, eligible: true });
  assert.deepEqual(disasterTwelveMonthRule(9), { contractual_payment_required: false, eligible: true });
});
test("12.7-T4: (caps) standard cumulative months unchanged after a 9-month disaster deferral; a standard deferral 8 months later is not blocked by the 12-month prior-deferral rule.", () => {
  const base = { origination_date: D("2021-10-01"), cumulative_deferred_months: 0, months_to_maturity: 300 };
  const disaster = screen({ months_delinquent: 9, ...base, evaluation_date: D("2026-12-20"), disaster: { delinquency_months_at_disaster: 0, same_event_deferred_before: false } });
  assert.deepEqual(disaster, { eligible: true, contractual_payment_required: false, months_deferred: 9 });
  // Disaster months are tracked separately: the standard cumulative counter is still 0, so a later 4-month standard deferral has the full 12-month room.
  assert.deepEqual(capStructure({ prior_deferred_months: 0, requested_months: 4 }), { cumulative: 4, contractual_payment_required: false, months_allowed: 4, installments_to_pay: 0, alternative: null });
  const later = screen({ months_delinquent: 4, ...base, evaluation_date: D("2027-09-01"), prior_deferral_effective: D("2027-01-01"), prior_deferral_was_disaster: true });
  assert.deepEqual(later, { eligible: true, contractual_payment_required: false, months_deferred: 4 });
  const standardPrior = screen({ months_delinquent: 4, ...base, evaluation_date: D("2027-09-01"), prior_deferral_effective: D("2027-01-01") }); assert.equal(standardPrior.eligible, false);   // a *standard* prior deferral 8 months ago would block
});
test("12.7-T5: (same event) second disaster deferral request for the same `disaster_event_id` → refused; a new event → allowed.", () => {
  assert.equal(sameEventCheck({ prior_event_ids: ["DR-4999-TX"], requested_event_id: "DR-4999-TX" }).allowed, false);
  assert.equal(sameEventCheck({ prior_event_ids: ["DR-4999-TX"], requested_event_id: "DR-5100-TX" }).allowed, true);
});
test("12.7-T6: (routing) ineligible (13 months delinquent) → Flex Mod disaster-criteria evaluation started within 5 BD.", async () => {
  const r = disasterIneligibleRouting({ months_delinquent: 13, screened_on: D("2026-12-01") });
  assert.equal(r.route, "flex_mod_disaster_criteria"); assert.equal(r.evaluation_by, "2026-12-08"); assert.equal(r.timer, "FNMA_D1301_DISASTER_FLEX_ROUTE"); assert.equal(r.reviewer, "lossmit_reviewer");
  assert.equal(disasterIneligibleRouting({ months_delinquent: 9, screened_on: D("2026-12-01") }).route, "disaster_payment_deferral");
  // On the bus: the 12.6/12.7 screen at 13 months delinquent emits `payment_deferral.screened_ineligible{disaster=true, reason, next}` → FNMA_D1301_DISASTER_FLEX_ROUTE due 5 servicer BD after 2026-12-01 (Tue) = 2026-12-08; the reviewer sees it before any notice.
  const h = harness("2026-12-01T15:00:00.000Z");
  const s = await h.run("12.6", "deferral.screen", { facts: { months_delinquent: 13, origination_date: "2021-10-01", evaluation_date: "2026-12-01", cumulative_deferred_months: 0, months_to_maturity: 300, disaster: { delinquency_months_at_disaster: 0, same_event_deferred_before: false } } });
  assert.equal(s.eligible, false); assert.equal(s.reason, "INV_FNMA_D23204_DELQ_WINDOW"); assert.equal(s.next, "flex_mod");
  const inel = h.emitted("payment_deferral.screened_ineligible"); assert.equal(inel.length, 1); assert.equal(inel[0]!.payload.disaster, true); assert.equal(inel[0]!.payload.months_delinquent, 13);
  assert.equal(h.rt.escalations.opened.filter((e) => e.kind === "lossmit_reviewer" && e.loanId === LOAN).length, 1);
  const route = h.timer("FNMA_D1301_DISASTER_FLEX_ROUTE"); assert.equal(route.length, 1); assert.equal(route[0]!.status, "armed"); assert.equal(route[0]!.dueDate, "2026-12-08");
  // The 12.8 evaluation under the reduced disaster criteria (`lossmit.evaluation.started{option=flex_mod, criteria=disaster}`) on 2026-12-04 satisfies it inside the 5 BD.
  h.clock.set("2026-12-04T15:00:00.000Z");
  await h.run("12.2", "lossmit.evaluation.*", { op: "start", id: "eval-flex-disaster", option: "flex_mod", criteria: "disaster", basis: "disaster_routing" });
  const started = h.emitted("lossmit.evaluation.started"); assert.equal(started.length, 1); assert.equal(started[0]!.payload.option, "flex_mod"); assert.equal(started[0]!.payload.criteria, "disaster");
  assert.equal(route[0]!.status, "satisfied"); assert.equal(route[0]!.satisfiedByEventId, started[0]!.id);
  // A standard (non-disaster) Flex Mod start would not have satisfied the disaster-criteria route.
  const h2 = harness("2026-12-01T15:00:00.000Z");
  await h2.run("12.6", "deferral.screen", { facts: { months_delinquent: 13, origination_date: "2021-10-01", evaluation_date: "2026-12-01", cumulative_deferred_months: 0, months_to_maturity: 300, disaster: { delinquency_months_at_disaster: 0, same_event_deferred_before: false } } });
  await h2.run("12.2", "lossmit.evaluation.*", { op: "start", id: "eval-flex-standard", option: "flex_mod" });
  assert.equal(h2.timer("FNMA_D1301_DISASTER_FLEX_ROUTE")[0]!.status, "armed");
  assert.equal(h2.timers.evaluate("2026-12-09T05:00:00.000Z").map((b) => b.def.code).includes("FNMA_D1301_DISASTER_FLEX_ROUTE"), true, "breaches after 2026-12-08 (sev-3)");
});
test("12.7-T7: (foreclosure gate) pre-referral review completed 2026-12-01 on a disaster loan → referral refused until Fannie Mae approval; submission by 2026-12-06.", () => {
  const r = disasterForeclosureGate({ review_completed_on: D("2026-12-01"), sender: { kind: "agent" } });
  assert.equal(r.referral_allowed, false); assert.match(r.refusal!, /Fannie Mae foreclosure approval/); assert.equal(r.submission_by, "2026-12-06"); assert.equal(r.package_prepared, true);
  // The package is prepared by the agent and sent only by the human role (12.7 guardrail; open question 2 default `officer`).
  assert.equal(r.sent_by_role, "officer"); assert.equal(r.send_allowed, false); assert.match(r.send_refusal!, /only officer\/fnma_portal_operator/);
  assert.deepEqual([...DISASTER_FC_PACKAGE_SENDERS], ["officer", "fnma_portal_operator"]);
  assert.equal(disasterForeclosureGate({ review_completed_on: D("2026-12-01"), sender: { kind: "human", role: "officer" } }).send_allowed, true);
  assert.equal(disasterForeclosureGate({ review_completed_on: D("2026-12-01"), sender: { kind: "human", role: "lossmit_reviewer" } }).send_allowed, false);
  assert.equal(disasterForeclosureGate({ review_completed_on: D("2026-12-01"), fnma_approval_id: "FNMA-FC-1" }).referral_allowed, true);
  // On the bus: the 13.4 `complete_review` handler's `prereferral.review.completed{review_id, outcome, items}` — outcome `hold_disaster_approval` on a disaster loan (foreclosure/referral.ts reviewOutcome) — arms FNMA_LL202601_DISASTER_FC_PRIOR_APPROVAL_5: review completion 2026-12-01 + 5 calendar days = 2026-12-06.
  const h = harness("2026-12-01T15:00:00.000Z");
  const review = h.events.append({ type: "prereferral.review.completed", loanId: LOAN, actor: FC_AGENT, payload: { review_id: "rev-1", outcome: "hold_disaster_approval", items: 12 } });
  const ll = h.timer("FNMA_LL202601_DISASTER_FC_PRIOR_APPROVAL_5"); assert.equal(ll.length, 1); assert.equal(ll[0]!.status, "armed"); assert.equal(ll[0]!.armedByEventId, review.id); assert.equal(ll[0]!.anchorDate, "2026-12-01"); assert.equal(ll[0]!.dueDate, "2026-12-06");
  const h0 = harness("2026-12-01T15:00:00.000Z"); h0.events.append({ type: "prereferral.review.completed", loanId: LOAN, actor: FC_AGENT, payload: { review_id: "rev-0", outcome: "refer", items: 12 } });
  assert.equal(h0.timer("FNMA_LL202601_DISASTER_FC_PRIOR_APPROVAL_5").length, 0, "a non-disaster review completion does not arm the prior-approval clock");
  // The agent prepares the hazard_loss@fanniemae.com package (request row pending → the 13.1 gate stays closed) but may not send it; the officer sends it on 2026-12-04, inside the 5 days.
  const prep = prepareDisasterForeclosurePackage(h.ops(AGENT), { review_id: "rev-1", review_completed_on: D("2026-12-01"), disaster_event_id: "DR-4999-TX" });
  assert.equal(prep.submission_by, "2026-12-06"); assert.equal(prep.referral_allowed, false); assert.match(prep.refusal, /Fannie Mae foreclosure approval/); assert.equal(prep.event.type, "fnma.disaster_fc_approval.prepared"); assert.equal(prep.event.payload.mailbox, HAZARD_LOSS_MAILBOX);
  assert.equal(h.rt.store.get(DISASTER_FC_REQUESTS, prep.request_id)!.data.fnma_response, "pending");
  assert.throws(() => submitDisasterForeclosurePackage(h.ops(AGENT), { request_id: prep.request_id, submitted_on: D("2026-12-04") }), (e: unknown) => e instanceof RangeError && /only officer\/fnma_portal_operator/.test(e.message));
  assert.throws(() => submitDisasterForeclosurePackage(h.ops({ kind: "human", id: "rev-9", role: "lossmit_reviewer" }), { request_id: prep.request_id, submitted_on: D("2026-12-04") }), RangeError);
  assert.equal(h.emitted("fnma.disaster_fc_approval.submitted").length, 0);
  const sent = submitDisasterForeclosurePackage(h.ops(OFFICER), { request_id: prep.request_id, submitted_on: D("2026-12-04") });
  assert.equal(sent.event.payload.submitted_by, "human:officer-1"); assert.equal(sent.event.payload.mailbox, HAZARD_LOSS_MAILBOX); assert.ok(sent.submitted_on <= prep.submission_by);
  assert.equal(ll[0]!.status, "armed", "submission alone does not satisfy the clock — Fannie Mae's approval does");
  // The inbound hazard_loss@ reply is validated before anything is appended: an approval without Fannie Mae's approval id, an unknown request, another loan's request and an unknown decision are refused.
  const FNMA: Actor = { kind: "external", id: "fnma" }; const before = h.events.all().length;
  assert.throws(() => ingestFnmaDisasterForeclosureApproval(h.ops(FNMA), { request_id: prep.request_id, decision: "approved", received_on: D("2026-12-09") }), (e: unknown) => e instanceof RangeError && /approval_id/.test(e.message));
  assert.throws(() => ingestFnmaDisasterForeclosureApproval(h.ops(FNMA), { request_id: "dfa-unknown", decision: "approved", approval_id: "FNMA-FC-1", received_on: D("2026-12-09") }), (e: unknown) => e instanceof RangeError && /no disaster_fc_approval_requests/.test(e.message));
  assert.throws(() => ingestFnmaDisasterForeclosureApproval(h.ops(FNMA), { request_id: prep.request_id, loan_id: "L-other", decision: "approved", approval_id: "FNMA-FC-1", received_on: D("2026-12-09") }), RangeError);
  assert.throws(() => ingestFnmaDisasterForeclosureApproval(h.ops(FNMA), { request_id: prep.request_id, decision: "maybe", received_on: D("2026-12-09") }), RangeError);
  assert.equal(h.events.all().length, before, "a refused record appends nothing"); assert.equal(ll[0]!.status, "armed");
  // An information request keeps the gate closed; the approval (2026-12-09) satisfies the clock and opens the referral.
  h.clock.set("2026-12-07T15:00:00.000Z");
  const info = ingestFnmaDisasterForeclosureApproval(h.ops(FNMA), { request_id: prep.request_id, decision: "info_requested", received_on: D("2026-12-07"), conditions: "provide the Form 30 inspection" });
  assert.equal(info.event.type, "fnma.approval.info_requested"); assert.equal(info.referral_allowed, false); assert.equal(ll[0]!.status, "armed"); assert.equal(h.rt.store.get(DISASTER_FC_REQUESTS, prep.request_id)!.data.fnma_response, "info_requested");
  h.clock.set("2026-12-09T15:00:00.000Z");
  const ok = ingestFnmaDisasterForeclosureApproval(h.ops(FNMA), { request_id: prep.request_id, decision: "approved", approval_id: "FNMA-FC-1", received_on: D("2026-12-09"), response_document_id: "doc-fnma-fc-1" });
  assert.equal(ok.event.type, "fnma.approval.received"); assert.equal(ok.event.payload.kind, "disaster_foreclosure"); assert.equal(ok.event.payload.approval_id, "FNMA-FC-1"); assert.equal(ok.event.payload.review_id, "rev-1"); assert.equal(ok.referral_allowed, true);
  assert.equal(ll[0]!.status, "satisfied"); assert.equal(ll[0]!.satisfiedByEventId, ok.event.id);
  const row = h.rt.store.get(DISASTER_FC_REQUESTS, prep.request_id)!.data; assert.equal(row.fnma_response, "approved"); assert.equal(row.approval_id, "FNMA-FC-1"); assert.equal(row.response_document_id, "doc-fnma-fc-1");   // what the 13.1 FNMA_D1301_DISASTER_FC_APPROVAL_GATE reads
  assert.equal(disasterForeclosureGate({ review_completed_on: D("2026-12-01"), fnma_approval_id: String(row.approval_id) }).referral_allowed, true);
  // Another Fannie Mae approval (a 12.5 repayment-plan extension) never satisfies the disaster foreclosure clock.
  const h3 = harness("2026-12-01T15:00:00.000Z"); h3.events.append({ type: "prereferral.review.completed", loanId: LOAN, actor: FC_AGENT, payload: { review_id: "rev-3", outcome: "hold_disaster_approval", items: 12 } });
  h3.events.append({ type: "fnma.approval.received", loanId: LOAN, actor: FNMA, payload: { kind: "repayment_plan_extension", approval_id: "FNMA-RP-1" } });
  assert.equal(h3.timer("FNMA_LL202601_DISASTER_FC_PRIOR_APPROVAL_5")[0]!.status, "armed");
  assert.deepEqual(h3.timers.evaluate("2026-12-07T05:00:00.000Z").map((b) => [b.def.code, b.breachText]), [["FNMA_LL202601_DISASTER_FC_PRIOR_APPROVAL_5", "referral blocked (13.3 gate `LM_DISASTER_FNMA_APPROVAL`)"]]);
});
test("12.7-T8: (ledger) NIB $16,521.53 posted; IB UPB per schedule; late charges waived.", () => {
  // Nine unpaid installments on the worked loan: LPI after 50 payments; the schedule after 59.
  const pre = balanceAfter(25_000_000n, "6.500", 360, 50), scheduled = balanceAfter(25_000_000n, "6.500", 360, 59);
  const r = deferralLedger({ pi_cents: 158_017n, months_deferred: 9, escrow_advances_cents: 230_000n, servicing_advances_cents: 0n, late_charges_cents: 9n * 6_321n, pre_deferral_ib_upb_cents: pre, scheduled_ib_upb_cents: scheduled });
  assert.equal(r.balanced, true); assert.equal(r.deferred_principal_cents, 1_652_153n); assert.equal(r.postings.find((p) => p.account === "deferred_principal")!.debit, 1_652_153n);
  assert.equal(r.ib_upb_cents, scheduled); assert.equal(r.ib_upb_equals_scheduled, true); assert.equal(r.principal_portion_cents, pre - scheduled);
  assert.equal(r.postings.find((p) => p.account === "late_charge_waivers")!.debit, 56_889n); assert.equal(r.postings.find((p) => p.account === "late_charges_due")!.credit, 56_889n);
  assert.equal(newPayment(158_017n, 52_000n, 240_000n).shortage_monthly_cents, 4_000n);
});

test("12.7 D2-3.2-05 eligibility beyond the delinquency tests: not within 36 months of maturity; no recourse, approved liquidation, active repayment plan, pending trial or competing retention offer", () => {
  const base = { months_delinquent: 9, origination_date: D("2026-06-01"), evaluation_date: D("2026-12-20"), cumulative_deferred_months: 0, disaster: { delinquency_months_at_disaster: 0, same_event_deferred_before: false } };
  assert.equal(screen({ ...base, months_to_maturity: 36 }).eligible, true);   // no origination-seasoning criterion in D2-3.2-05 (verified by absence)
  const near = screen({ ...base, months_to_maturity: 35 }); assert.equal(near.eligible, false); if (!near.eligible) { assert.equal(near.reason, "INV_FNMA_D23205_MATURITY"); assert.equal(near.next, "flex_mod"); }
  const busy = screen({ ...base, months_to_maturity: 300, active_arrangements: ["active_trial_period_plan"] }); assert.equal(busy.eligible, false); if (!busy.eligible) assert.equal(busy.reason, "INV_FNMA_D23205_CONFLICTING_ARRANGEMENT");
});

test("12.7 worked figures: 9 × $1,580.17 = $14,221.53 + escrow advances $2,300.00 = $16,521.53 NIB", () => {
  assert.equal(nib(158017n, 9, 0n, 0n), 1422153n); assert.equal(nib(158017n, 9, 230000n, 0n), 1652153n);
});

test("12.7 clocks beyond T1–T8 on the bus: FNMA_D23205_POSTREPAY_SOLICIT_15TH arms on the disaster repayment-plan failure and is satisfied by NTC_FNMA_D23205_SOLICIT_POST_REPAY; the eligibility and 12-month contractual-payment gates arm on the screen", async () => {
  // D2-3.2-05: "after a missed repayment-plan payment at month-end without QRPC, solicit by the 15th of the following month" — the 12.5 `workout_plan.*` handler's `workout_plan.ended{status=failed, kind=repayment_plan, disaster=true, qrpc=false, failed_month_end}`.
  const h = harness("2026-11-01T15:00:00.000Z");
  await h.run("12.5", "workout_plan.*", { id: "rp-disaster", start_on: "2026-11-01", term_months: 8, arrears_cents: 474_051n, contractual_cents: 158_017n, days_delinquent: 95, brp_complete: true, qrpc: true, disaster: true });
  h.clock.set("2026-11-30T15:00:00.000Z");
  await h.run("12.5", "workout_plan.*", { id: "rp-disaster", op: "fail", ended_on: "2026-11-30", qrpc: false, disaster: true });
  const failed = h.emitted("workout_plan.ended"); assert.equal(failed.length, 1); assert.equal(failed[0]!.payload.status, "failed"); assert.equal(failed[0]!.payload.kind, "repayment_plan"); assert.equal(failed[0]!.payload.disaster, true); assert.equal(failed[0]!.payload.failed_month_end, "2026-11-30");
  const t = h.timer("FNMA_D23205_POSTREPAY_SOLICIT_15TH"); assert.equal(t.length, 1); assert.equal(t[0]!.status, "armed"); assert.equal(t[0]!.armedByEventId, failed[0]!.id); assert.equal(t[0]!.anchorDate, "2026-11-30"); assert.equal(t[0]!.dueDate, "2026-12-15");
  assert.equal(h.timer("FNMA_D23205_POSTFORB_SOLICIT_15").length, 0, "a repayment-plan failure is not the forbearance-expiry clock");
  assert.equal(h.timer("FNMA_D23204_POSTREPAY_DEFERRAL_SOLICIT_15TH").length, 0, "the standard 12.5 solicitation clock needs deferral_eligible=true, which a disaster failure does not assert");
  // The standard post-repayment cover letter does not satisfy the disaster clock; the Disaster Payment Deferral Post-Repayment Plan Solicitation Cover Letter (sent 2026-12-10, by the 15th) does.
  h.clock.set("2026-12-10T15:00:00.000Z");
  const std = h.noticeReg.activeVersion("NTC_FNMA_D23204_SOLICIT_POST_REPAY", D("2026-12-10"))!;
  await h.run("12.6", "notice.render_send", { template_code: "NTC_FNMA_D23204_SOLICIT_POST_REPAY", recipients: [{ partyId: "b1", name: "Borrower", mailingAddress: "1 Test St, Testville TX 75001" }], payload: std.samplePayload });
  assert.equal(t[0]!.status, "armed");
  const v = h.noticeReg.activeVersion("NTC_FNMA_D23205_SOLICIT_POST_REPAY", D("2026-12-10"))!;
  const sent = await h.run("12.6", "notice.render_send", { template_code: "NTC_FNMA_D23205_SOLICIT_POST_REPAY", recipients: [{ partyId: "b1", name: "Borrower", mailingAddress: "1 Test St, Testville TX 75001" }], payload: v.samplePayload });
  assert.equal(sent.status, "sent"); const notices = h.emitted("notice.sent"); assert.equal(notices.length, 2); assert.equal(notices[1]!.payload.template, "NTC_FNMA_D23205_SOLICIT_POST_REPAY");
  assert.equal(t[0]!.status, "satisfied"); assert.equal(t[0]!.satisfiedByEventId, notices[1]!.id); assert.ok(t[0]!.satisfiedAt!.slice(0, 10) <= t[0]!.dueDate!);
  assert.deepEqual(h.timers.evaluate("2026-12-16T05:00:00.000Z").filter((b) => b.def.process === "12.7"), [], "satisfied inside the window: no 12.7 breach after the 15th");
  // The screen at 12 months delinquent (`payment_deferral.offer_requested{disaster=true, months_delinquent=12}`) arms both evaluator-backed gates; the contractual-payment gate opens only once the full payment lands in the solicitation/processing month.
  const g = harness("2026-12-20T15:00:00.000Z");
  const s = await g.run("12.6", "deferral.screen", { facts: { months_delinquent: 12, origination_date: "2021-10-01", evaluation_date: "2026-12-20", cumulative_deferred_months: 0, months_to_maturity: 300, disaster: { delinquency_months_at_disaster: 0, same_event_deferred_before: false } } });
  assert.equal(s.eligible, true); assert.equal(s.contractual_payment_required, true); assert.equal(s.months_deferred, 12);
  const req = g.emitted("payment_deferral.offer_requested"); assert.equal(req.length, 1); assert.equal(req[0]!.payload.disaster, true); assert.equal(req[0]!.payload.months_delinquent, 12);
  for (const code of ["FNMA_D23205_DDEFERRAL_ELIGIBILITY_GATES", "FNMA_D23205_12M_CONTRACTUAL_PAYMENT_GATE"]) { const gate = g.timer(code); assert.equal(gate.length, 1, code); assert.equal(gate[0]!.status, "armed"); assert.equal(gate[0]!.armedByEventId, req[0]!.id); }
  assert.equal(evaluateGate("12.7.contractualPaymentInSolicitationMonth", { full_contractual_payment_received_in_month: false }).open, false);
  assert.equal(evaluateGate("12.7.contractualPaymentInSolicitationMonth", { full_contractual_payment_received_in_month: true }).open, true);
  const facts = { fema_disaster_basis: true, current_or_under_2_months_at_disaster: true, months_delinquent: 12, prior_same_event_deferral: false, months_to_maturity: 300, conflicting_arrangement: false };
  assert.equal(evaluateGate("12.7.disasterEligibility", facts).open, true);
  assert.equal(evaluateGate("12.7.disasterEligibility", { ...facts, current_or_under_2_months_at_disaster: false }).open, false);
  assert.equal(evaluateGate("12.7.disasterEligibility", { ...facts, current_or_under_2_months_at_disaster: false, fnma_approval: true }).open, true, "2+ months at the disaster is cured by Fannie Mae's prior approval");
  assert.equal(evaluateGate("12.7.disasterEligibility", { ...facts, months_delinquent: 13 }).open, false);
  // A 9-months-delinquent screen never arms the 12-month contractual-payment gate.
  const g9 = harness("2026-12-20T15:00:00.000Z");
  await g9.run("12.6", "deferral.screen", { facts: { months_delinquent: 9, origination_date: "2021-10-01", evaluation_date: "2026-12-20", cumulative_deferred_months: 0, months_to_maturity: 300, disaster: { delinquency_months_at_disaster: 0, same_event_deferred_before: false } } });
  assert.equal(g9.timer("FNMA_D23205_12M_CONTRACTUAL_PAYMENT_GATE").length, 0); assert.equal(g9.timer("FNMA_D23205_DDEFERRAL_ELIGIBILITY_GATES").length, 1);
});
