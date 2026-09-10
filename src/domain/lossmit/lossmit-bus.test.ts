/**
 * §12 event vocabulary on the bus: the events the §12 tools emit are the ones the §12 timer rows (after
 * src/domain/lossmit/timers.ts) arm and satisfy on — application completion (12.1), evaluation start / third-party
 * items / offer sent / offer response (12.2), plan offer / activation / end / close (12.4–12.5), deferral screen,
 * acceptance and SMDU completion (12.6–12.7), the trial gate and capitalization posting (12.8), contribution gates (12.9).
 */
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
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { FakeFnmaSmdu } from "../../infra/integrations/fnma.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { NoticeService } from "../../notices/service.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { postConversionLedger } from "./ops.ts";
import type { WaterfallInputs } from "./flexmod.ts";

const AGENT: Actor = { kind: "agent", id: "lossmit-underwriter" };
const SYSTEM: Actor = { kind: "system", id: "test" };
const LOAN = "L-12";
const PROCESSES = ["12.1", "12.2", "12.3", "12.4", "12.5", "12.6", "12.7", "12.8", "12.9"];
/** `bindTools` for the §12 defs alone (src/app/tools/index.ts binds every section; this test needs only the loss-mitigation bus). */
const toolKey = (process: string, name: string): string => `${process} ${name}`;
function bindSection12(rt: ToolRuntime, agents: AgentRegistry, defs: readonly ToolDef[]): Map<string, CommandSpec<ToolInput, unknown>> {
  const escalates = new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
  const out = new Map<string, CommandSpec<ToolInput, unknown>>();
  for (const d of defs) { const cmd = toolCommand(d, rt, escalates.get(d.process) ?? []); agents.registerTool(d.agent, cmd.name); out.set(toolKey(d.process, d.name), cmd); }
  return out;
}

function harness(nowIso = "2026-10-05T14:00:00.000Z") {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const decisions: DecisionInput[] = [];
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: PROCESSES });
  const uow: UowContext = { loanId: LOAN, events, ledger: new MemoryLedger(), timers, clock, decide: (d) => { decisions.push(d); } };
  const noticeReg = buildRegistry(); publishAuthored(noticeReg);
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, notices: new NoticeService({ registry: noticeReg, events, clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() }), ports: { smdu: new FakeFnmaSmdu(), printMail: new FakePrintMail(), edelivery: new FakeEdelivery() } };
  const agents = new AgentRegistry(); const cmds = bindSection12(rt, agents, SECTION_12_TOOLS); const bus = new CommandBus(agents);
  const run = async (process: string, name: string, input: ToolInput): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey(process, name))!, AGENT, { loan_id: LOAN, ...input }, uow)).output as Record<string, unknown>;
  const refused = (process: string, name: string, input: ToolInput, code: string) => assert.rejects(bus.execute(cmds.get(toolKey(process, name))!, AGENT, { loan_id: LOAN, ...input }, uow), (e: unknown) => e instanceof CommandRefused && e.code === code);
  const timer = (code: string) => timers.byCode(code);
  const emitted = (type: string) => events.all().filter((e) => e.type === type);
  return { uow, rt, events, timers, run, refused, timer, emitted, noticeReg };
}

test("12.1 application completion emits `lossmit.application.completed{complete_at, protection_tier}` (and `facially_complete`), which arms the (c)(1) 30-day, (c)(3) 5-day and (f)(2)/(g) hold rows", async () => {
  const h = harness();
  await h.run("12.1", "lossmit.application.open/update", { id: "lma-1", has_evaluative_info: true, received_on: "2026-09-10", state: "CA", first_lien: true, owner_occupied: true });
  assert.equal(h.emitted("lossmit.application.received").length, 1); assert.equal(h.emitted("lossmit.application.completed").length, 0);
  await h.run("12.1", "lossmit.application.open/update", { id: "lma-1", op: "update", status: "facially_complete", has_evaluative_info: true, received_on: "2026-09-10", facially_complete_on: "2026-10-01" });
  const facial = h.emitted("lossmit.application.facially_complete"); assert.equal(facial.length, 1); assert.equal(facial[0]!.payload.protection_tier, "ge_90");
  assert.equal(h.timer("REGX_1024_41F2_G_HOLD").length, 1); assert.equal(h.timer("REGX_1024_41C2IV_FACIALLY_COMPLETE_HOLD").length, 1);
  await h.run("12.1", "lossmit.application.open/update", { id: "lma-1", op: "update", status: "complete", has_evaluative_info: true, received_on: "2026-09-10", complete_on: "2026-10-07", state: "CA", first_lien: true, owner_occupied: true, oldest_income_document_date: "2026-08-20" });
  const done = h.emitted("lossmit.application.completed"); assert.equal(done.length, 1);
  assert.equal(done[0]!.payload.complete_at, "2026-10-07"); assert.equal(done[0]!.payload.complete_date, "2026-10-07"); assert.equal(done[0]!.payload.deemed_complete_date, "2026-10-01"); assert.equal(done[0]!.payload.protection_tier, "ge_90"); assert.equal(done[0]!.payload.tier, "ge_90"); assert.equal(done[0]!.payload.state, "CA"); assert.equal(done[0]!.payload.first_lien, true);
  assert.equal(h.emitted("lossmit.application.status_changed").length, 2, "the diligence follow-up satisfier still sees every status change");
  assert.equal(h.timer("REGX_1024_41C1_EVALUATE_NOTIFY_30")[0]!.dueDate, "2026-11-06");   // complete_at + 30 (12.2 worked example)
  assert.equal(h.timer("REGX_1024_41C3_COMPLETE_NOTICE_5")[0]!.dueDate, "2026-10-15");    // 5 federal BD from 2026-10-07 (Columbus Day skipped)
  assert.equal(h.timer("REGX_1024_41C2IV_FACIALLY_COMPLETE_HOLD")[0]!.status, "satisfied");
  const app = h.rt.store.get("lossmit_applications", "lma-1")!.data; assert.equal(app.complete_at, "2026-10-07"); assert.equal(app.deemed_complete_date, "2026-10-01"); assert.equal(app.protection_tier, "ge_90");
});

test("12.2 evaluation lifecycle: op=start arms the third-party clocks, op=third_party_received satisfies them, an offer notice emits `lossmit.offer.sent{tier, state}`, op=offer_response satisfies the acceptance clock and needs evidence", async () => {
  const h = harness();
  await h.run("12.2", "lossmit.evaluation.*", { op: "start", id: "eval-1", application_id: "lma-1", complete_on: "2026-10-07", state: "TX", third_party_items: ["BPO"] });
  const started = h.emitted("lossmit.evaluation.started"); assert.equal(started.length, 1); assert.equal(started[0]!.payload.third_party_items, true); assert.equal(started[0]!.payload.complete_at, "2026-10-07");
  assert.equal(h.timer("REGX_1024_41C4_THIRD_PARTY_HEIGHTEN_30")[0]!.dueDate, "2026-11-06"); assert.equal(h.timer("REGX_1024_41C4_THIRD_PARTY_REQUEST_PROMPT").length, 1);
  await h.run("12.2", "lossmit.evaluation.*", { op: "third_party_received", id: "eval-1", item: "BPO", received_on: "2026-10-20" });
  assert.equal(h.emitted("lossmit.third_party_item.received").length, 1); assert.equal(h.timer("REGX_1024_41C4_THIRD_PARTY_HEIGHTEN_30")[0]!.status, "satisfied"); assert.equal(h.rt.store.get("lossmit_evaluations", "eval-1")!.data.status, "evaluating");
  await h.run("12.2", "lossmit.evaluation.*", { id: "eval-1", application_id: "lma-1", complete_on: "2026-10-07", outcome: "offered", option: "payment_deferral", state: "TX" });
  const decided = h.emitted("lossmit.evaluation.decided"); assert.equal(decided.length, 1); assert.equal(decided[0]!.payload.option, "payment_deferral"); assert.equal(decided[0]!.payload.tier, "ge_90");
  assert.equal(h.timer("FNMA_D23204_PROCESSING_MONTH_ELECTION_15TH").length, 1);
  // The offer Evaluation Notice: sending it is "providing the offer" — `lossmit.offer.sent` arms REGX_1024_41E1_ACCEPT_14 (tier ge_90, not NY) with provided_at + 14.
  const v = h.noticeReg.activeVersion("NTC_FNMA_D23204_DEFERRAL_OFFER", D("2026-10-05"))!;
  await h.run("12.6", "notice.render_send", { template_code: "NTC_FNMA_D23204_DEFERRAL_OFFER", option: "payment_deferral", recipients: [{ partyId: "b1", name: "Borrower", mailingAddress: "1 Test St, Testville TX 75001" }], payload: v.samplePayload });
  const sent = h.emitted("lossmit.offer.sent"); assert.equal(sent.length, 1); assert.equal(sent[0]!.payload.tier, "ge_90"); assert.equal(sent[0]!.payload.state, "TX"); assert.equal(sent[0]!.payload.kind, "offer"); assert.equal(sent[0]!.payload.provided_at, "2026-10-05");
  assert.equal(h.timer("REGX_1024_41E1_ACCEPT_14")[0]!.dueDate, "2026-10-19"); assert.equal(h.timer("NY_419_7G_ACCEPT_30").length, 0); assert.equal(h.timer("REGX_1024_41E1_ACCEPT_7").length, 0);
  await h.refused("12.2", "lossmit.evaluation.*", { op: "offer_response", response: "accepted", option: "payment_deferral" }, "ACCEPTANCE_NEEDS_EVIDENCE");
  await h.run("12.2", "lossmit.evaluation.*", { op: "offer_response", evaluation_id: "eval-1", response: "accepted", option: "payment_deferral", accepted_via: "verbal" });
  const resp = h.emitted("lossmit.offer.responded"); assert.equal(resp.length, 1); assert.equal(resp[0]!.payload.response, "accepted"); assert.equal(resp[0]!.payload.tier, "ge_90");
  assert.equal(h.timer("REGX_1024_41E1_ACCEPT_14")[0]!.status, "satisfied"); assert.equal(h.rt.store.get("lossmit_offers", "offer-L-12-payment_deferral")!.data.status, "accepted");
});

test("12.4/12.5 plan lifecycle: op=offer arms the Evaluation Notice clock; activation arms the hold, pre-expiry and disposition clocks once; op=expire emits `workout_plan.ended` (releases the hold, arms the post-forbearance solicitation) without re-activating; op=close satisfies the disposition", async () => {
  const h = harness();
  await h.run("12.4", "workout_plan.*", { op: "offer", id: "wp-1", offered_on: "2026-09-15", regx_short_term: true, application_complete: false });
  assert.equal(h.emitted("workout_plan.offered").length, 1); assert.equal(h.timer("FNMA_D2205_EVAL_NOTICE_FORB")[0]!.dueDate, "2026-09-20"); assert.equal(h.timer("REGX_1024_41C2III_SHORTTERM_NOTICE_5").length, 1);
  await h.run("12.4", "workout_plan.*", { id: "wp-1", requested_months: 3, cumulative_months: 0, months_delinquent_at_start: 2, start_on: "2026-10-01", offered_on: "2026-09-15" });
  assert.equal(h.emitted("workout_plan.activated").length, 1);
  assert.equal(h.timer("REGX_1024_41C2III_PERFORMANCE_HOLD").length, 1); assert.equal(h.timer("FNMA_D23201_FORB_PREEXPIRY_CONTACT_30")[0]!.dueDate, "2026-12-01"); assert.equal(h.timer("FNMA_D23201_FORB_EXPIRY_DISPOSITION")[0]!.dueDate, "2026-12-31");
  // A termination for failed terms still needs the mitigating-circumstances check (12.4 guardrail); an expiry without QRPC ends the plan.
  await h.refused("12.4", "workout_plan.*", { id: "wp-1", op: "end", status: "terminated", terminated_reason: "failed_terms" }, "MITIGATING_CHECK_BEFORE_TERMINATION");
  await h.run("12.4", "workout_plan.*", { id: "wp-1", op: "expire", qrpc: false, deferral_eligible: true });
  const ended = h.emitted("workout_plan.ended"); assert.equal(ended.length, 1); assert.equal(ended[0]!.payload.status, "expired"); assert.equal(ended[0]!.payload.term_end, "2026-12-31"); assert.equal(ended[0]!.payload.kind, "forbearance");
  assert.equal(h.emitted("workout_plan.activated").length, 1, "ending a plan never re-arms the activation clocks");
  assert.equal(h.timer("REGX_1024_41C2III_PERFORMANCE_HOLD")[0]!.status, "satisfied"); assert.equal(h.timer("FNMA_D23201_FORB_PREEXPIRY_CONTACT_30").length, 1);
  assert.equal(h.timer("FNMA_D23204_POSTFORB_DEFERRAL_SOLICIT_15")[0]!.dueDate, "2027-01-15"); assert.equal(h.timer("FNMA_D23206_POSTFORB_FLEX_SOLICIT_15").length, 0);
  await h.run("12.4", "workout_plan.*", { id: "wp-1", op: "close", closed_reason: "converted_deferral" });
  assert.equal(h.timer("FNMA_D23201_FORB_EXPIRY_DISPOSITION")[0]!.status, "satisfied"); assert.equal(h.rt.store.get("workout_plans", "wp-1")!.data.status, "closed");
  // 12.5: a repayment plan that fails at month-end without QRPC arms the 15th-of-following-month deferral solicitation from the failure month.
  await h.run("12.5", "workout_plan.*", { id: "rp-1", start_on: "2026-11-01", term_months: 8, arrears_cents: 642_600n, contractual_cents: 210_000n, days_delinquent: 95, brp_complete: true, qrpc: true });
  await h.run("12.5", "workout_plan.*", { id: "rp-1", op: "fail", ended_on: "2026-11-30", qrpc: false, deferral_eligible: true });
  const failed = h.emitted("workout_plan.ended").at(-1)!; assert.equal(failed.payload.status, "failed"); assert.equal(failed.payload.kind, "repayment_plan"); assert.equal(failed.payload.failed_month_end, "2026-11-30");
  assert.equal(h.timer("FNMA_D23204_POSTREPAY_DEFERRAL_SOLICIT_15TH")[0]!.dueDate, "2026-12-15"); assert.equal(h.timer("REGX_1024_41C2III_PERFORMANCE_HOLD").at(-1)!.status, "satisfied");
});

test("12.6/12.7 completion is the SMDU case submission: `smdu.case.submitted{workout, submitted_on}` satisfies the entry/election clocks and arms the agreement-send and incentive clocks; the screen emits the offer/solicit gate events", async () => {
  const h = harness();
  const s = await h.run("12.6", "deferral.screen", { facts: { months_delinquent: 4, origination_date: "2026-08-01", evaluation_date: "2026-10-05", cumulative_deferred_months: 0, months_to_maturity: 348 } });
  assert.equal(s.eligible, false); assert.equal(s.reason, "INV_FNMA_D23204_SEASONING_12M");
  assert.equal(h.emitted("payment_deferral.offer_requested").length, 1); assert.equal(h.emitted("payment_deferral.screened_ineligible").length, 1); assert.equal(h.timer("FNMA_D23204_DEFERRAL_ELIGIBILITY_GATES").length, 1);
  await h.run("12.2", "lossmit.evaluation.*", { op: "offer_response", response: "accepted", option: "payment_deferral", accepted_via: "written" });
  assert.equal(h.timer("FNMA_D23204_DEFERRAL_SMDU_ENTRY_EOM")[0]!.dueDate, "2026-10-31"); assert.equal(h.timer("FNMA_F122_DEFERRAL_LAR_BEFORE_EOM_1BD").length, 1);
  await h.run("12.6", "smdu.case.submit", { workout: "payment_deferral", partner_servicer_number: "123456789", campaign_id: "PD-2026" });
  const sub = h.emitted("smdu.case.submitted"); assert.equal(sub.length, 1); assert.equal(sub[0]!.payload.submitted_on, "2026-10-05"); assert.equal(sub[0]!.payload.disaster, false);
  assert.equal(h.timer("FNMA_D23204_DEFERRAL_SMDU_ENTRY_EOM")[0]!.status, "satisfied");
  assert.equal(h.timer("FNMA_D23204_AGREEMENT_SEND_5")[0]!.dueDate, "2026-10-10"); assert.equal(h.timer("FNMA_F202_DEFERRAL_INCENTIVE_CLAIM")[0]!.dueDate, "2026-11-30"); assert.equal(h.timer("FNMA_D23205_AGREEMENT_SEND_5").length, 0);
  await h.run("12.6", "esign.send", { document_id: "doc-1", document: "DOC_FNMA_PAYMENT_DEFERRAL_AGREEMENT" });
  assert.equal(h.timer("FNMA_D23204_AGREEMENT_SEND_5")[0]!.status, "satisfied");
  // Disaster variant: the same tool, the 12.7 rows.
  await h.run("12.2", "lossmit.evaluation.*", { op: "offer_response", response: "accepted", option: "disaster_payment_deferral", accepted_via: "verbal" });
  assert.equal(h.timer("FNMA_D23205_DDEFERRAL_SMDU_ENTRY_EOM").length, 1);
  await h.run("12.6", "smdu.case.submit", { workout: "disaster_payment_deferral", partner_servicer_number: "123456789" });
  assert.equal(h.timer("FNMA_D23205_DDEFERRAL_SMDU_ENTRY_EOM")[0]!.status, "satisfied"); assert.equal(h.timer("FNMA_D23205_AGREEMENT_SEND_5")[0]!.dueDate, "2026-10-10");
});

test("12.8 the foreclosure-suspension gate arms on `tpp_active` (12.8's loan-scoped `lossmit.trial.first_payment_received{acceptance=true}`, derived from cashiering's first `trial_payment.received`) and closes on `lossmit.trial.failed`; the capitalization posting emits `ledger.posted{rule_ref=12.8.capitalization}` through the kernel ledger", async () => {
  const h = harness();
  // Cashiering's per-row `lossmit.trial.started` rides a `trial_month` aggregate with no loan subject, so it cannot arm a gate the loan-scoped `lossmit.trial.failed` closes; the `tpp_active` milestone does (timers-12-8.ts).
  h.events.append({ type: "lossmit.trial.started", actor: SYSTEM, aggregate: { kind: "trial_month", id: "c1:1" }, payload: { case_id: "c1", loan_id: LOAN, trial_number: 1, due_date: "2026-11-01" } });
  assert.equal(h.timer("FNMA_E3401_FC_SUSPEND_DURING_TRIAL").length, 0);
  h.events.append({ type: "lossmit.trial.first_payment_received", loanId: LOAN, actor: SYSTEM, payload: { case_id: "c1", modification_id: "m1", payment_date: "2026-11-30", acceptance: true, acceptance_items_missing: false } });
  assert.equal(h.timer("FNMA_E3401_FC_SUSPEND_DURING_TRIAL").length, 1); assert.equal(h.timer("FNMA_E3401_FC_SUSPEND_DURING_TRIAL")[0]!.status, "armed");
  h.events.append({ type: "lossmit.trial.failed", loanId: LOAN, actor: SYSTEM, payload: { case_id: "c1", failed_on: "2026-11-30", trial_number: 1 } });
  assert.equal(h.timer("FNMA_E3401_FC_SUSPEND_DURING_TRIAL")[0]!.status, "satisfied");
  h.events.append({ type: "lossmit.agreement.servicer_executed", loanId: LOAN, actor: SYSTEM, payload: { effective_date: "2027-01-01" } });
  assert.equal(h.timer("FNMA_F127_CAPITALIZATION_DATE")[0]!.dueDate, "2026-12-01");
  const W: WaterfallInputs = { ib_upb_cents: 23_676_547n, accrued_interest_cents: 1_025_984n, escrow_advances_cents: 420_000n, servicing_advances_cents: 18_000n, prior_nib_cents: 0n, value_cents: 29_000_000n, contract_rate_pct: "6.500", is_arm_not_final: false, remaining_term_months: 309, pre_mod_pi_cents: 158_017n, mir_pct: "6.625", delinquent_31_plus: true };
  const r = postConversionLedger({ ledger: h.uow.ledger, events: h.events, actor: AGENT, now: h.uow.clock.now() }, { ...W, loan_id: LOAN, late_charges_cents: 50_568n, effective: D("2027-01-01"), loan_data_change_acked: true });
  assert.equal(r.capitalization_date, "2026-12-01"); assert.equal(r.set.lines.reduce((a, l) => a + l.amountCents, 0n), 0n); assert.ok(r.set.lines.every((l) => l.ruleRef.startsWith("12.8.capitalization")));
  assert.equal(h.uow.ledger.balance({ scope: "loan", loanId: LOAN, account: "forborne_principal" }), 3_548_332n); assert.equal(W.ib_upb_cents + h.uow.ledger.balance({ scope: "loan", loanId: LOAN, account: "principal" }), 21_592_199n);   // pre-mod IB UPB + (capitalized − forborne) = the waterfall's IB UPB
  const posted = h.emitted("ledger.posted"); assert.equal(posted.length, 1); assert.equal(posted[0]!.payload.rule_ref, "12.8.capitalization");
  assert.equal(h.timer("FNMA_F127_CAPITALIZATION_DATE")[0]!.status, "satisfied");
});

test("12.9 contribution.compute applies the D2-3.3-01 gates: reserves ≤ $10,000 with a ratio > 40% is not required (relocation allowed); reserves $18,400 is required and blocks relocation absent Fannie Mae approval; no BRP → not evaluated", async () => {
  const h = harness();
  const small = await h.run("12.9", "contribution.compute", { reserves_cents: 200_000n, piti_cents: 210_000n, deficiency_cents: 4_100_000n, housing_ratio_pct: "45.00", brp_complete: true, relocation_requested: true });
  assert.equal(small.evaluated, true); assert.equal(small.required, false); assert.equal(small.request_cents, 0n);
  await h.refused("12.9", "contribution.compute", { reserves_cents: 1_840_000n, piti_cents: 210_000n, deficiency_cents: 4_100_000n, brp_complete: true, relocation_requested: true }, "NO_RELOCATION_WITH_CONTRIBUTION");
  const noBrp = await h.run("12.9", "contribution.compute", { reserves_cents: 1_840_000n, piti_cents: 210_000n, deficiency_cents: 4_100_000n, brp_complete: false, relocation_requested: true });
  assert.equal(noBrp.evaluated, false); assert.equal(noBrp.required, false);
});
