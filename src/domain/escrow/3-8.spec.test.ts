// 3.8 Escrow waiver administration
// spec/sections/03-escrow-administration/3-8-escrow-waiver-administration.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, addMonths, addDays } from "../../kernel/calendar/date.ts";
import { cents } from "../../kernel/money/cents.ts";
import { project, decide, newPayment, cushion, effectiveDate, anomalies } from "./analysis.ts";
const E = [{ line_type: "school_tax", amount_cents: cents("360"), disburse_on: D("2026-09-15") }, { line_type: "county_tax", amount_cents: cents("500"), disburse_on: D("2026-07-15") }, { line_type: "county_tax", amount_cents: cents("700"), disburse_on: D("2026-12-15") }];
const A = [{ line_type: "county_tax", amount_cents: cents("520"), disburse_on: D("2027-07-15") }, { line_type: "county_tax", amount_cents: cents("760"), disburse_on: D("2027-12-15") }, { line_type: "school_tax", amount_cents: cents("380"), disburse_on: D("2027-09-15") }];
void E; void A; void addMonths; void addDays; void project; void decide; void newPayment; void cushion; void effectiveDate; void anomalies;
import { evaluateWaiver, revocation, type WaiverRequest } from "./waiver.ts";
import { buildPlan, type Plan } from "./shortage.ts";
import { waiverCloseout, workoutEscrowGate, minnesotaDiscontinue, illinoisTermination, scriptSolicitsWaiver } from "./ops.ts";
import { escrowBus, ESCROW_AGENT } from "./spec-harness.ts";
import { buildRegistry } from "../../notices/catalog.ts";
import { waiverDecisionPayload } from "../../notices/authored/section03.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { render } from "../../notices/render.ts";
import { recordWaiverRequest, recordWaiverDenial, trialOfferEscrowGate, isWaived, minnesotaAnniversaryJob, minnesotaDiscontinuePayload } from "./ops-3-8.ts";
import { ingestTrialPlanOfferPrepared } from "./ops-3-2.ts";
import { MemoryEventStore, FixedClock } from "../../kernel/events/index.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { eventMatches } from "../../kernel/events/match.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { publishAuthored } from "../../notices/catalog.ts";
import { NoticeService } from "../../notices/service.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
const BASE: Omit<WaiverRequest, "upb_cents"> = { requested_on: D("2027-03-02"), original_appraised_value_cents: cents("310000"), hpml: true, consummation_date: D("2021-06-15"), original_property_value_cents: cents("300000"), regx_days_delinquent: 0, late_30_in_12m: 0, late_60_in_24m: 0, prior_modification: false, prior_waiver_missed_payments: false, monthly_mi_line: false, flood_escrow_mandatory: false, instrument_permits: true, next_due_dates: [D("2027-04-01"), D("2027-05-01")] };

test("3.8-T1: Given the worked-example loan at UPB $240,000 (HPML), then decision = denied with reason HPML_LTV_GE_80_ORIG_VALUE and a re-request date.", async () => {
  const den = evaluateWaiver({ ...BASE, upb_cents: cents("240000") });
  assert.equal(den.decision, "denied"); assert.deepEqual(den.reasons, ["HPML_LTV_GE_80_ORIG_VALUE"]); assert.equal(den.state_right_applied, false);
  assert.equal(den.re_request_on, "2027-04-01");                                                                                      // the next principal payment takes the UPB below $240,000.00
  assert.equal(evaluateWaiver({ ...BASE, upb_cents: cents("240000"), projected_upb: [{ on: D("2027-04-01"), upb_cents: cents("240000") }, { on: D("2027-05-01"), upb_cents: cents("239950") }] }).re_request_on, "2027-05-01");   // dated from the amortization schedule when supplied
  // The agent cannot approve it: approveWaiver runs the engine itself and refuses the denial before anything is written.
  const bus = escrowBus(); const refused = await bus.refusal("3.8", "approveWaiver", ESCROW_AGENT, { waiver_id: "W-1", request: { ...BASE, upb_cents: cents("240000") }, decision: "approved", effective_on: "2027-06-01" });
  assert.equal(refused?.code, "RULE_OUTCOMES_BINDING"); assert.match(refused!.message, /HPML_LTV_GE_80_ORIG_VALUE/); assert.equal(bus.rt.store.get("escrow_waivers", "W-1"), undefined);
  assert.equal((await bus.refusal("3.8", "approveWaiver", ESCROW_AGENT, { waiver_id: "W-1", effective_on: "2027-06-01" }))?.code, "RULE_OUTCOMES_BINDING");   // no request → nothing to approve
  // The written decision (NTC_SM_ESCROW_WAIVER_DECISION) always passes its checklist: the re-request date where one exists, the permanent-reason statement where B-1-01 gives none (prior modification).
  const v = buildRegistry().versionsOf("NTC_SM_ESCROW_WAIVER_DECISION")[0]!; const contact = { servicer_phone: "(800) 555-0100", exclusive_address: "PO Box 2, Testville TX 75001" };
  const dated = waiverDecisionPayload(den, "2027-03-02", 7, contact); const r1 = render(v.source, dated); assert.equal(evaluateChecklist(v, dated, r1).passed, true); assert.match(r1.text, /You may request again on or after April 1, 2027\./);
  const permanent = evaluateWaiver({ ...BASE, upb_cents: cents("239900"), prior_modification: true }); assert.deepEqual([permanent.decision, permanent.reasons, permanent.re_request_on], ["denied", ["PRIOR_MOD_OR_WAIVER_MISSED"], null]);
  const perm = waiverDecisionPayload(permanent, "2027-03-02", 7, contact); const r2 = render(v.source, perm); assert.equal(evaluateChecklist(v, perm, r2).passed, true, evaluateChecklist(v, perm, r2).blocking.map((b) => b.rule_id).join(","));
  assert.match(r2.text, /modified previously.*This reason is permanent under the Fannie Mae Servicing Guide/); assert.doesNotMatch(r2.text, /on or after \./);
});
test("3.8-T2: Given UPB $239,900, no lates in 24 months, no prior mod, annual MI, no flood, then approved; effective next due date ≥ 15 days; refund within 30 days; short-year statement within 60 days; escrow event to balance 0.", async () => {
  const ok = evaluateWaiver({ ...BASE, upb_cents: cents("239900") });
  assert.equal(ok.decision, "approved"); assert.equal(ok.effective_on, "2027-04-01");                       // next due date ≥ 15 days after a same-day (2027-03-02) approval
  // Rule 2 dates the effective date from the *approval*: decided 2027-03-18 (still inside the 10-BD SLA) → 04-01 is < 15 days out → 2027-05-01, the worked example's effective date.
  assert.equal(evaluateWaiver({ ...BASE, upb_cents: cents("239900") }, D("2027-03-18")).effective_on, "2027-05-01");
  assert.equal(evaluateWaiver({ ...BASE, upb_cents: cents("239900") }, D("2027-03-17")).effective_on, "2027-04-01");
  const c = waiverCloseout(cents("1206.68"), cents("520"), ok.effective_on!);                              // $1,206.68 less the April county installment paid before closure
  assert.deepEqual(c, { refund_cents: 68_668n, refund_by: "2027-05-01", short_year_statement_by: "2027-05-31", event_balance_cents: 0n });
  // Through the bus the stored decision is the engine's, dated from the approval: a caller-supplied effective date is ignored and the HPML gates run on the request's facts.
  const bus = escrowBus(); const rec = (await bus.run("3.8", "approveWaiver", ESCROW_AGENT, { waiver_id: "W-2", request: { ...BASE, upb_cents: cents("239900") }, effective_on: "2027-03-05" })) as Record<string, unknown>;
  assert.equal(rec.decision, "approved"); assert.equal(rec.effective_on, "2027-04-01"); assert.equal(rec.scope, "full"); assert.equal(bus.events.ofType("escrow.waiver.decided").length, 1);
  const late = escrowBus("L-1", "2027-03-24T15:00:00.000Z"); assert.equal(((await late.run("3.8", "approveWaiver", ESCROW_AGENT, { waiver_id: "W-2b", request: { ...BASE, upb_cents: cents("239900") } })) as Record<string, unknown>).effective_on, "2027-05-01");   // approved on the SLA's last day
  // Closure on the effective date: the escrow event to balance 0 (`escrow.account.closed`) arms the refund-within-30 and short-year-within-60 rows on the closure date; the waiver refund is the engine's closing balance and satisfies the refund row.
  const close = escrowBus("L-1", "2027-04-01T15:00:00.000Z", ["3.3", "3.8"]);
  await close.run("3.5", "emitEscrowEvent", ESCROW_AGENT, { type: "escrow.account.closed", payload: { amount_cents: String(-c.refund_cents), balance_cents: "0", sequence: 7, closed_on: "2027-04-01", refund_cents: String(c.refund_cents), reason: "waiver_approved" } });
  const refundTimer = close.ctx.timers.byCode("ESC_WAIVER_REFUND_30")[0]!; const resetTimer = close.ctx.timers.byCode("REGX_1024_17I4_SHORT_YEAR_RESET_60")[0]!;
  assert.deepEqual([refundTimer.status, refundTimer.dueDate, resetTimer.status, resetTimer.dueDate], ["armed", "2027-05-01", "armed", "2027-05-31"]);
  assert.equal((await close.refusal("3.5", "issueRefund", ESCROW_AGENT, { kind: "waiver_refund", amount_cents: 60_000n, payee_kind: "borrower" }))?.code, "ENGINE_AMOUNT");
  await close.run("3.5", "issueRefund", ESCROW_AGENT, { kind: "waiver_refund", amount_cents: c.refund_cents, payee_kind: "borrower", check_no: "W-1" });
  assert.equal(refundTimer.status, "satisfied"); assert.equal(resetTimer.status, "armed");
  const young = await bus.refusal("3.8", "approveWaiver", ESCROW_AGENT, { waiver_id: "W-3", request: { ...BASE, upb_cents: cents("239900"), consummation_date: D("2023-06-15") } });
  assert.equal(young?.code, "RULE_OUTCOMES_BINDING"); assert.match(young!.message, /HPML_LT_5Y/);                                   // §1026.35(b)(3): not before consummation + 5 years
  assert.equal((await bus.refusal("3.8", "approveWaiver", ESCROW_AGENT, { waiver_id: "W-4", request: { ...BASE, upb_cents: cents("239900"), regx_days_delinquent: 12 } }))?.code, "RULE_OUTCOMES_BINDING");
});
test("3.8-T3: Given one 30-day delinquency 8 months ago, then denied DELINQ_12M; given a 60-day delinquency 20 months ago, then denied DELINQ_60D_24M.", () => {
  const d12 = evaluateWaiver({ ...BASE, upb_cents: cents("239900"), late_30_in_12m: 1, last_late_30_on: D("2026-07-02") });
  assert.deepEqual(d12.reasons, ["DELINQ_12M"]); assert.equal(d12.re_request_on, "2027-07-03");                                      // the day the delinquency leaves the 12-month window
  const d24 = evaluateWaiver({ ...BASE, upb_cents: cents("239900"), late_60_in_24m: 1, last_late_60_on: D("2025-07-02") });
  assert.deepEqual(d24.reasons, ["DELINQ_60D_24M"]); assert.equal(d24.re_request_on, "2027-07-03");
  assert.equal(evaluateWaiver({ ...BASE, upb_cents: cents("239900"), late_30_in_12m: 1 }).re_request_on, "2028-03-03");            // undated: 12 months from the request
});
test("3.8-T4: Given monthly borrower-paid MI, then the MI line is excluded from the waiver and the decision is partial.", async () => {
  const part = evaluateWaiver({ ...BASE, upb_cents: cents("239900"), monthly_mi_line: true }); assert.equal(part.decision, "partial"); assert.deepEqual(part.lines_kept, ["mi"]); assert.deepEqual(part.kept_reasons, ["MI_MONTHLY"]);
  const bus = escrowBus(); const req = { ...BASE, upb_cents: cents("239900"), monthly_mi_line: true };
  assert.equal((await bus.refusal("3.8", "approveWaiver", ESCROW_AGENT, { waiver_id: "W-5", request: req, waived_line_types: ["tax", "hazard", "mi"] }))?.code, "3.8.miMonthlyEscrowRequired");   // FNMA_B101_MI_MONTHLY_ESCROW_GATE
  const rec = (await bus.run("3.8", "approveWaiver", ESCROW_AGENT, { waiver_id: "W-5", request: req, waived_line_types: ["tax", "hazard"] })) as Record<string, unknown>;
  assert.deepEqual([rec.decision, rec.scope, rec.lines_kept, rec.waived_line_types], ["partial", "partial", ["mi"], ["tax", "hazard"]]);
});
test("3.8-T5: Given `flood_escrow_mandatory=true`, then the flood line cannot be waived.", async () => {
  const part = evaluateWaiver({ ...BASE, upb_cents: cents("239900"), flood_escrow_mandatory: true }); assert.equal(part.decision, "partial"); assert.equal(part.lines_kept[0], "flood"); assert.deepEqual(part.kept_reasons, ["FLOOD_MANDATORY"]);
  const bus = escrowBus(); const req = { ...BASE, upb_cents: cents("239900"), flood_escrow_mandatory: true };
  assert.equal((await bus.refusal("3.8", "approveWaiver", ESCROW_AGENT, { waiver_id: "W-6", request: req }))?.code, "3.8.floodEscrowMandatory");                                     // FLOOD_12CFR22_5_ESCROW_GATE: a full waiver is refused
  const rec = (await bus.run("3.8", "approveWaiver", ESCROW_AGENT, { waiver_id: "W-6", request: req, waived_line_types: ["tax", "hazard"] })) as Record<string, unknown>;
  assert.deepEqual([rec.decision, rec.lines_kept], ["partial", ["flood"]]);
});
test("3.8-T6: Given an advance for unpaid taxes on a waived loan on 2027-12-11, then the waiver is revoked the same day, the account is established with the deficiency, and the initial statement timer is due 2028-01-25.", async () => {
  const rv = revocation(D("2027-12-11"), cents("2400"), cents("120"));
  assert.deepEqual([rv.revoked_on, rv.opening_balance_cents, rv.initial_statement_due_on, rv.deficiency_cents], ["2027-12-11", -252_000n, "2028-01-25", 252_000n]);
  assert.equal((buildPlan("deficiency", rv.deficiency_cents, D("2028-02-01"), {}) as Plan).installment_cents, cents("210.00"));   // 12 × $210.00
  // Through the bus: the 3.7 advance on a waived loan performs the same-day revocation itself (rule 5) — the advance arms FNMA_B101_WAIVER_REVOKE_ON_ADVANCE_0 and the establishment it emits satisfies it; the (g)(2) initial-statement row (3.1) is armed for 2028-01-25.
  const bus = escrowBus("L-1", "2027-12-11T15:00:00.000Z", ["3.1", "3.8"]);
  const out = (await bus.run("3.7", "postAdvance", ESCROW_AGENT, { amount_cents: cents("2400"), advance_cents: cents("2400"), penalty_cents: cents("120"), cause: "unpaid_tax_waived_loan", item: "county tax", waived: true })) as { revocation: ReturnType<typeof revocation> | null };
  assert.deepEqual(out.revocation, rv);
  assert.deepEqual(bus.events.all().map((e) => e.type).filter((t) => t.startsWith("escrow.")), ["escrow.advance.posted", "escrow.waiver.revoked", "escrow.account.established", "escrow.initial_statement.required"]);
  const est = bus.events.ofType("escrow.account.established")[0]!; assert.deepEqual([est.payload.reason, est.payload.established_at, est.payload.opening_balance_cents, est.payload.deficiency_cents], ["waiver_revoked", "2027-12-11", "-252000", "252000"]);
  const revoke = bus.ctx.timers.byCode("FNMA_B101_WAIVER_REVOKE_ON_ADVANCE_0")[0]!; assert.equal(revoke.dueDate, "2027-12-11"); assert.equal(revoke.status, "satisfied");
  const initial = bus.ctx.timers.byCode("REGX_1024_17G_INITIAL_STMT_45")[0]!; assert.equal(initial.status, "armed"); assert.equal(initial.dueDate, "2028-01-25");
  // An advance on an escrowed loan neither revokes anything nor arms the revocation row.
  const escrowed = escrowBus("L-1", "2027-12-11T15:00:00.000Z", ["3.8"]); await escrowed.run("3.7", "postAdvance", ESCROW_AGENT, { amount_cents: 76_000n, advance_cents: 26_000n });
  assert.equal(escrowed.events.ofType("escrow.waiver.revoked").length, 0); assert.equal(escrowed.ctx.timers.byCode("FNMA_B101_WAIVER_REVOKE_ON_ADVANCE_0").length, 0);
});
test("3.8-T7: Given a Flex Mod trial offer being prepared for a waived loan current on T&I, then the exception is documented and the offer proceeds; given T&I delinquent, then the offer is blocked until escrow is established.", async () => {
  assert.deepEqual(workoutEscrowGate({ waived: true, current_on_ti: true, exception_documented: true }), { ok: true, block: null });
  assert.match(workoutEscrowGate({ waived: true, current_on_ti: false, exception_documented: true }).block!, /establish escrow before the offer/);
  assert.match(workoutEscrowGate({ waived: true, current_on_ti: true, exception_documented: false }).block!, /document the Flex Mod/);
  // Through the engine: the §12 hand-off (3.2 ingestTrialPlanOfferPrepared) arms FNMA_B101_WAIVER_REVOKE_BEFORE_TRIAL_GATE on the waived loan; the documented Flex Mod exception (current on T&I) clears it and the offer proceeds.
  const current = escrowBus("L-1", "2027-12-01T15:00:00.000Z", ["3.8"]);
  await current.run("3.8", "approveWaiver", ESCROW_AGENT, { waiver_id: "W-7", request: { ...BASE, upb_cents: cents("239900"), requested_on: D("2027-11-20"), next_due_dates: [D("2028-01-01"), D("2028-02-01")] } });
  assert.equal(isWaived(current.events, "L-1"), true);
  ingestTrialPlanOfferPrepared(current.events, { loan_id: "L-1", offer_id: "O-1", program: "flex_modification", offer_date: D("2027-12-05") }, ESCROW_AGENT);
  const gate = current.ctx.timers.byCode("FNMA_B101_WAIVER_REVOKE_BEFORE_TRIAL_GATE")[0]!; assert.deepEqual([gate.status, gate.note], ["armed", "evaluator:3.8.escrowEstablishedOrExceptionDocumented"]);
  const ok = trialOfferEscrowGate(current.events, { loan_id: "L-1", offer_id: "O-1", program: "flex_modification", current_on_ti: true }, ESCROW_AGENT);
  assert.deepEqual([ok.proceed, ok.basis, ok.block], [true, "exception_documented", null]);
  assert.deepEqual(current.events.all().map((e) => e.type).filter((t) => t.startsWith("escrow.waiver.")), ["escrow.waiver.requested", "escrow.waiver.evaluating", "escrow.waiver.decided", "escrow.waiver.exception_documented", "escrow.waiver.trial_gate.cleared"]);
  assert.equal(current.events.ofType("escrow.waiver.exception_documented")[0]!.payload.exception, "flex_mod_current_on_ti"); assert.equal(gate.status, "satisfied");
  assert.equal(evaluateGate("3.8.escrowEstablishedOrExceptionDocumented", { escrow_established: false, exception_documented: true }).open, true);
  // T&I delinquent: the offer is blocked (the gate stays armed) until the 3.7 advance revokes the waiver and establishes escrow; the re-run offer then clears the gate on the establishment.
  const delinquent = escrowBus("L-1", "2027-12-10T15:00:00.000Z", ["3.8"]);
  await delinquent.run("3.8", "approveWaiver", ESCROW_AGENT, { waiver_id: "W-8", request: { ...BASE, upb_cents: cents("239900"), requested_on: D("2027-11-20"), next_due_dates: [D("2028-01-01"), D("2028-02-01")] } });
  ingestTrialPlanOfferPrepared(delinquent.events, { loan_id: "L-1", offer_id: "O-2", program: "flex_modification", offer_date: D("2027-12-15") }, ESCROW_AGENT);
  const blocked = trialOfferEscrowGate(delinquent.events, { loan_id: "L-1", offer_id: "O-2", program: "flex_modification", current_on_ti: false }, ESCROW_AGENT);
  assert.deepEqual([blocked.proceed, blocked.basis], [false, null]); assert.match(blocked.block!, /T&I delinquent: establish escrow before the offer/);
  const gate2 = delinquent.ctx.timers.byCode("FNMA_B101_WAIVER_REVOKE_BEFORE_TRIAL_GATE")[0]!; assert.equal(gate2.status, "armed");
  assert.equal(evaluateGate("3.8.escrowEstablishedOrExceptionDocumented", { escrow_established: false, exception_documented: false }).open, false);
  await delinquent.run("3.7", "postAdvance", ESCROW_AGENT, { amount_cents: cents("2400"), advance_cents: cents("2400"), penalty_cents: cents("120"), cause: "unpaid_tax_waived_loan", item: "county tax", waived: true });
  assert.equal(isWaived(delinquent.events, "L-1"), false);
  const cleared = trialOfferEscrowGate(delinquent.events, { loan_id: "L-1", offer_id: "O-2", program: "flex_modification", current_on_ti: false }, ESCROW_AGENT);
  assert.deepEqual([cleared.proceed, cleared.basis, gate2.status], [true, "escrow_established", "satisfied"]);
  // A payment deferral has no Flex Mod exception: a waived loan current on T&I is still blocked (B-1-01: revoke before the trial period).
  const deferral = escrowBus("L-1", "2027-12-01T15:00:00.000Z", ["3.8"]);
  await deferral.run("3.8", "approveWaiver", ESCROW_AGENT, { waiver_id: "W-9", request: { ...BASE, upb_cents: cents("239900"), requested_on: D("2027-11-20"), next_due_dates: [D("2028-01-01"), D("2028-02-01")] } });
  ingestTrialPlanOfferPrepared(deferral.events, { loan_id: "L-1", offer_id: "O-3", program: "other_modification", offer_date: D("2027-12-05") }, ESCROW_AGENT);
  assert.match(trialOfferEscrowGate(deferral.events, { loan_id: "L-1", offer_id: "O-3", program: "other_modification", current_on_ti: true }, ESCROW_AGENT).block!, /no escrow-waiver exception/);
  assert.throws(() => trialOfferEscrowGate(deferral.events, { loan_id: "L-1", offer_id: "O-9", program: "flex_modification", current_on_ti: true }, ESCROW_AGENT), /ingest the §12 hand-off first/);
});
test("3.8-T8: Given a Minnesota loan reaching its 5th anniversary, then the right-to-discontinue notice is sent within 60 days; a written election with no >30-day delinquency in 12 months is approved even if the Fannie Mae 80% test fails (per open question 1 default).", async () => {
  const r = minnesotaDiscontinue({ mortgage_date: D("2022-03-15"), today: D("2027-03-20"), written_election: true, late_over_30_in_12m: 0, fnma_80_test_passed: false });
  assert.deepEqual([r.anniversary, r.notice_due_on, r.notice_due_now, r.election], ["2027-03-15", "2027-05-14", true, "approved"]); assert.match(r.basis, /state right overrides the Fannie Mae 80% test/);
  assert.equal(minnesotaDiscontinue({ mortgage_date: D("2022-03-15"), today: D("2027-03-20"), written_election: true, late_over_30_in_12m: 1, fnma_80_test_passed: true }).election, "denied");
  // The state right overrides only the Fannie Mae denial tests: a non-HPML MN loan at 82% of the original appraisal is approved on the election …
  const mn = evaluateWaiver({ ...BASE, hpml: false, state: "MN", state_right_met: r.election === "approved", upb_cents: cents("254200") });
  assert.deepEqual([mn.decision, mn.reasons, mn.state_right_applied, mn.effective_on], ["approved", ["LTV_GE_80_ORIG_APPRAISED"], true, "2027-04-01"]);
  // … but never a Reg Z HPML rule: the same election on an HPML loan at 80% of the original value stays denied.
  const hpml = evaluateWaiver({ ...BASE, state: "MN", state_right_met: true, upb_cents: cents("240000") });
  assert.deepEqual([hpml.decision, hpml.reasons, hpml.state_right_applied], ["denied", ["HPML_LTV_GE_80_ORIG_VALUE"], false]);
  // Through the engine: the MN anniversary job's `loan.anniversary{years=5}` arms STATE_MN_47_20_DISCONTINUE_NOTICE_60 on the anniversary (2027-03-15 + 60 = 2027-05-14); the notice service's send of NTC_MN_47_20_9_DISCONTINUE_RIGHT satisfies it.
  const clock = new FixedClock("2027-04-04T15:00:00.000Z"); const events = new MemoryEventStore(clock); const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["3.8"] });
  assert.equal(minnesotaAnniversaryJob(events, { loan_id: "L-MN", state: "MN", mortgage_date: D("2022-03-15"), today: D("2027-03-14") }, ESCROW_AGENT).event, null);        // the day before: nothing
  assert.equal(minnesotaAnniversaryJob(events, { loan_id: "L-MN", state: "TX", mortgage_date: D("2022-03-15"), today: D("2027-03-20") }, ESCROW_AGENT).event, null);        // not a Minnesota loan
  const job = minnesotaAnniversaryJob(events, { loan_id: "L-MN", state: "MN", mortgage_date: D("2022-03-15"), today: D("2027-03-20") }, ESCROW_AGENT);
  assert.deepEqual([job.due, job.anniversary, job.notice_due_on, job.event!.type, job.event!.payload.years], [true, "2027-03-15", "2027-05-14", "loan.anniversary", 5]);
  assert.equal(minnesotaAnniversaryJob(events, { loan_id: "L-MN", state: "MN", mortgage_date: D("2022-03-15"), today: D("2027-03-21") }, ESCROW_AGENT).already_recorded, true);   // once per loan
  const t = timers.byCode("STATE_MN_47_20_DISCONTINUE_NOTICE_60"); assert.equal(t.length, 1); assert.deepEqual([t[0]!.status, t[0]!.anchorDate, t[0]!.dueDate], ["armed", "2027-03-15", "2027-05-14"]);
  const reg = buildRegistry(); publishAuthored(reg); const svc = new NoticeService({ registry: reg, events, clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() });
  const payload = minnesotaDiscontinuePayload(job.event!, D("2027-04-04"), { servicer_phone: "(800) 555-0100", exclusive_address: "PO Box 2, Testville TX 75001" }); assert.equal(payload.days_after_anniversary, 20);
  const n = svc.render({ templateCode: "NTC_MN_47_20_9_DISCONTINUE_RIGHT", loanId: "L-MN", recipients: [{ partyId: "B", name: "B", mailingAddress: "1 Test St" }], payload, asOf: D("2027-04-04") });
  assert.equal(n.status, "rendered"); await svc.send(n.id);
  const sent = events.ofType("notice.sent").at(-1)!; assert.deepEqual([sent.loanId, sent.payload.template], ["L-MN", "NTC_MN_47_20_9_DISCONTINUE_RIGHT"]);
  assert.equal(t[0]!.status, "satisfied"); assert.equal(t[0]!.satisfiedByEventId, sent.id);
});
test("3.8-T9: Given an Illinois loan at 64% of original amount by timely payments and not in default, then the termination election is approved.", () => {
  const r = illinoisTermination({ upb_cents: 6_400_000n, original_amount_cents: 10_000_000n, timely_payments: true, in_default: false });
  assert.equal(r.approved, true); assert.equal(r.ratio_pct, "64.00");
  assert.equal(illinoisTermination({ upb_cents: 6_600_000n, original_amount_cents: 10_000_000n, timely_payments: true, in_default: false }).reason, "above 65% of the original amount");
  // 765 ILCS 910/5 election with a prior modification on file: the state right overrides the B-1-01 test; a flood mandate or the instrument still binds.
  const il = evaluateWaiver({ ...BASE, hpml: false, state: "IL", state_right_met: r.approved, upb_cents: 6_400_000n, prior_modification: true });
  assert.deepEqual([il.decision, il.reasons, il.state_right_applied], ["approved", ["PRIOR_MOD_OR_WAIVER_MISSED"], true]);
  assert.equal(evaluateWaiver({ ...BASE, hpml: false, state: "IL", state_right_met: true, upb_cents: 6_400_000n, prior_modification: true, instrument_permits: false }).decision, "denied");
  assert.equal(evaluateWaiver({ ...BASE, hpml: false, state: "IL", state_right_met: true, upb_cents: 6_400_000n, prior_modification: true, flood_escrow_mandatory: true }).decision, "partial");
});
test("3.8-T10: Given any outbound script, then a content test confirms no waiver solicitation language.", () => {
  assert.equal(scriptSolicitsWaiver("Would you like to waive your escrow account and pay taxes yourself?"), true);
  assert.equal(scriptSolicitsWaiver("Your escrow analysis is complete; your new payment is $172.22 starting July 1."), false);
  assert.equal(scriptSolicitsWaiver("If you ask, we can explain how an escrow waiver request is evaluated."), false);
});

// 3.8 worked example: UPB $240,000.00 is not below 80% of the $300,000 original value → denied.
test("3.8 worked example: UPB $240,000.00 vs $300,000 original value → HPML_LTV_GE_80_ORIG_VALUE", () => {
  assert.deepEqual(evaluateWaiver({ ...BASE, upb_cents: 24_000_000n }).reasons, ["HPML_LTV_GE_80_ORIG_VALUE"]);
});

// 3.8 timer table: the `escrow_waiver` case opened (`escrow.waiver.requested`) starts the 10-BD decision SLA from the request date; the evaluation fact arms the HPML / flood / MI gates (and an IL election the 765 ILCS 910/5 gate); the decision closes every one of them.
test("3.8 timers: ESC_WAIVER_DECISION_SLA_10BD runs 10 servicer BD from the request (2027-03-02 → 2027-03-16); the evaluation gates arm on escrow.waiver.evaluating and close on escrow.waiver.decided", async () => {
  const bus = escrowBus("L-1", "2027-03-02T15:00:00.000Z", ["3.8"]);
  const req = { ...BASE, upb_cents: cents("240000"), state: "IL", flood_escrow_mandatory: true, monthly_mi_line: true };
  const out = (await bus.run("3.8", "evaluateWaiver", ESCROW_AGENT, { waiver_id: "W-10", request: req })) as ReturnType<typeof evaluateWaiver>;
  assert.equal(out.decision, "denied");
  assert.deepEqual(bus.events.all().map((e) => e.type).filter((t) => t.startsWith("escrow.")), ["escrow.waiver.requested", "escrow.waiver.evaluating", "escrow.waiver.decided"]);
  const requested = bus.events.ofType("escrow.waiver.requested")[0]!, evaluating = bus.events.ofType("escrow.waiver.evaluating")[0]!, decided = bus.events.ofType("escrow.waiver.decided")[0]!;
  assert.deepEqual([requested.payload.case_type, requested.payload.requested_on, requested.payload.state, requested.payload.hpml, requested.payload.decision_due_on], ["escrow_waiver", "2027-03-02", "IL", true, "2027-03-16"]);   // Tue Mar 2 + 10 servicer BD (no holidays) = Tue Mar 16
  assert.deepEqual([evaluating.payload.hpml_flag, evaluating.payload.flood_escrow_mandatory, evaluating.payload.flood_line, evaluating.payload.borrower_paid_mi_monthly], [true, true, true, true]);
  assert.deepEqual([decided.payload.decision, decided.payload.reasons, decided.payload.re_request_on], ["denied", ["HPML_LTV_GE_80_ORIG_VALUE"], "2027-04-01"]);
  const reg = loadOverriddenRegistry();
  for (const code of ["REGZ_1026_35B3_HPML_ESCROW_5Y_GATE", "REGZ_1026_35B3_HPML_LTV_GATE", "FLOOD_12CFR22_5_ESCROW_GATE", "FNMA_B101_MI_MONTHLY_ESCROW_GATE"]) assert.equal(eventMatches(reg.get(code)!.triggerPattern!, evaluating), true, code);
  assert.equal(eventMatches(reg.get("STATE_IL_765ILCS910_5_TERMINATION_RIGHT_GATE")!.triggerPattern!, requested), true);
  const sla = bus.ctx.timers.byCode("ESC_WAIVER_DECISION_SLA_10BD"); assert.equal(sla.length, 1); assert.deepEqual([sla[0]!.anchorDate, sla[0]!.dueDate, sla[0]!.status, sla[0]!.satisfiedByEventId], ["2027-03-02", "2027-03-16", "satisfied", decided.id]);
  for (const code of ["REGZ_1026_35B3_HPML_ESCROW_5Y_GATE", "REGZ_1026_35B3_HPML_LTV_GATE", "FLOOD_12CFR22_5_ESCROW_GATE", "FNMA_B101_MI_MONTHLY_ESCROW_GATE", "STATE_IL_765ILCS910_5_TERMINATION_RIGHT_GATE"]) {
    const t = bus.ctx.timers.byCode(code); assert.equal(t.length, 1, code); assert.deepEqual([t[0]!.status, t[0]!.satisfiedByEventId], ["satisfied", decided.id], code); assert.match(t[0]!.note ?? "", /^evaluator:3\.8\./, code);
  }
  // A second evaluation of the same case re-runs the engine but neither reopens the case nor re-decides it (append-only, idempotent per waiver id).
  await bus.run("3.8", "evaluateWaiver", ESCROW_AGENT, { waiver_id: "W-10", request: req });
  assert.deepEqual([bus.events.ofType("escrow.waiver.requested").length, bus.events.ofType("escrow.waiver.evaluating").length, bus.events.ofType("escrow.waiver.decided").length, bus.ctx.timers.byCode("ESC_WAIVER_DECISION_SLA_10BD").length], [1, 2, 1, 1]);
  assert.equal(recordWaiverRequest(bus.events, { loan_id: "L-1", waiver_id: "W-10", request: req }, ESCROW_AGENT).already_open, true);
  assert.throws(() => recordWaiverDenial(bus.events, { loan_id: "L-1", waiver_id: "W-11", decision: evaluateWaiver({ ...BASE, upb_cents: cents("239900") }), decided_on: D("2027-03-02") }, ESCROW_AGENT), /records the engine's denial/);
  // A non-HPML, non-IL request arms neither the Reg Z gates nor the Illinois gate; without a waiver_id the engine runs but no case opens.
  const plain = escrowBus("L-2", "2027-03-02T15:00:00.000Z", ["3.8"]);
  await plain.run("3.8", "evaluateWaiver", ESCROW_AGENT, { waiver_id: "W-12", request: { ...BASE, upb_cents: cents("239900"), hpml: false } });
  assert.deepEqual(["REGZ_1026_35B3_HPML_ESCROW_5Y_GATE", "REGZ_1026_35B3_HPML_LTV_GATE", "FLOOD_12CFR22_5_ESCROW_GATE", "FNMA_B101_MI_MONTHLY_ESCROW_GATE", "STATE_IL_765ILCS910_5_TERMINATION_RIGHT_GATE"].map((c) => plain.ctx.timers.byCode(c).length), [0, 0, 0, 0, 0]);
  assert.deepEqual([plain.ctx.timers.byCode("ESC_WAIVER_DECISION_SLA_10BD")[0]!.status, plain.events.ofType("escrow.waiver.decided").length], ["armed", 0]);   // approved by the engine: the SLA waits for approveWaiver's decision
  await plain.run("3.8", "evaluateWaiver", ESCROW_AGENT, { request: { ...BASE, upb_cents: cents("239900"), hpml: false } });
  assert.equal(plain.events.ofType("escrow.waiver.requested").length, 1);
  // approveWaiver on the open case closes the SLA with its own `escrow.waiver.decided` (SLA anchor: the request date, not the approval day).
  const late = escrowBus("L-3", "2027-03-15T15:00:00.000Z", ["3.8"]);
  await late.run("3.8", "approveWaiver", ESCROW_AGENT, { waiver_id: "W-13", request: { ...BASE, upb_cents: cents("239900"), hpml: false } });
  const s3 = late.ctx.timers.byCode("ESC_WAIVER_DECISION_SLA_10BD")[0]!; assert.deepEqual([s3.anchorDate, s3.dueDate, s3.status], ["2027-03-02", "2027-03-16", "satisfied"]);
});
