// 25.2 Closing Disclosure: preparation, delivery and receipt evidence, the three-business-day waiting period, redisclosure, post-consummation corrections, the seller's CD, and UCD generation/submission
// spec/sections/25-compliance-testing-the-closing-disclosure-rescission-and-clo/25-2-closing-disclosure-preparation-delivery-and-receipt-evidence.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { regzSpecific } from "../../kernel/calendar/business.ts";
import { MemoryEventStore, FixedClock, type Actor } from "../../kernel/events/index.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { EscalationService } from "../../app/escalations.ts";
import { assertGateOpen as assertLeGateOpen, LeGateClosed } from "../application/ops-21-2.ts";
import { computeApr, aprAccuracyTest } from "./ops-25-1.ts";
import { ClosingDisclosureService, CdRefused, CdGateClosed, UcdGateClosed, addSpecificBusinessDays, presumedReceiptDate, earliestConsummationDate, latestReceiptDateFor, latestMailingDateFor, cdTargetDeliveryDate, settlementFiguresDueDate, scheduleDelivery, correctedCdDueDate, clericalCdDueDate, postConsummationEventWindow, ucdResubmitDueDate,
  computeEarliestConsummation, receiptOnDelivery, rebutPresumption, cd3sbdGate, evaluateRedisclosure, validateWaiverStatement, waiverEarliestConsummation, renderCd, validateCdFees, runCdConsistencyChecks, closingDocumentsBlocked, assertClosingDocumentsUnblocked, classifyPostConsummationCorrection, ucdAcceptedGate, generateUcd, PROHIBITED_CD_FEE,
  type CdRenderInput, type CdFeeLine, type CdReceipt } from "./ops-25-2.ts";
import { EVALUATORS_25_2 } from "./evaluators-25-2.ts";

const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
const AGENT: Actor = { kind: "agent", id: "disclosure" };
const REFI = "APP-REFI-1", PUR = "APP-PUR-1";
const B1 = "BRW-1", B2 = "BRW-2", SPOUSE = "NBS-1";
/** The refinance fixture (25.1 worked example 1): $560,000.00 at 6.125%, 360, Phoenix AZ; disbursement Thu Nov 12, 2026; first payment Fri Jan 1, 2027; PFC $3,849.95 with prepaid interest $1,785.43 (26.3 `365_rounded_per_diem`). */
const APR_V1 = computeApr({ loan_amount_cents: 56_000_000n, note_rate_pct: "6.125", term_months: 360, term_start_date: D("2026-11-12"), first_payment_date: D("2027-01-01"), prepaid_finance_charges_cents: 384_995n, prepaid_interest_cents: 178_543n, method: "appendix_j_exact", checkpoint: "cd" });
/** INT-O6-2 buydown: 0.750 points ($4,200.00) at 5.875% → P&I $3,312.61, APR 5.979 (25.1 worked example 2). */
const APR_BUYDOWN = computeApr({ loan_amount_cents: 56_000_000n, note_rate_pct: "5.875", term_months: 360, term_start_date: D("2026-11-16"), first_payment_date: D("2027-01-01"), prepaid_finance_charges_cents: 384_995n + 420_000n - 178_543n + 135_205n, prepaid_interest_cents: 135_205n, method: "appendix_j_exact", checkpoint: "corrected_cd" });

const fees = (recordingCents = 3_000n, extra: CdFeeLine[] = []): CdFeeLine[] => [
  { fee_code: "underwriting", description: "Underwriting fee", amount_cents: 195_000n, section: "A_origination", tolerance_class: "zero", source_id: "SRC-CREDITOR-1" },
  { fee_code: "tax_service", description: "Tax service fee", amount_cents: 8_400n, section: "B_cannot_shop", tolerance_class: "zero", source_id: "SRC-CREDITOR-1" },
  { fee_code: "title_lender_policy", description: "Title — Lender's policy", amount_cents: 120_000n, section: "C_can_shop", tolerance_class: "ten_percent", source_id: "SRC-SA-1" },
  { fee_code: "settlement_fee", description: "Title — Settlement fee", amount_cents: 60_000n, section: "C_can_shop", tolerance_class: "ten_percent", source_id: "SRC-SA-1" },
  { fee_code: "recording", description: "Recording fees", amount_cents: recordingCents, section: "E_taxes_gov", tolerance_class: "ten_percent", source_id: "SRC-SA-1" },
  { fee_code: "prepaid_interest", description: "Prepaid interest ($93.97 per day from 11/12/2026 to 12/01/2026)", amount_cents: 178_543n, section: "F_prepaids", tolerance_class: "unlimited", source_id: "SRC-CREDITOR-1" },
  { fee_code: "escrow_deposit", description: "Initial escrow payment at closing", amount_cents: 187_500n, section: "G_initial_escrow", tolerance_class: "unlimited", source_id: "SRC-ESCROW-1" },
  ...extra,
];
const renderInput = (over: Partial<CdRenderInput> & { application_id?: string; disclosure_id: string; cd_version: number }, sources: CdRenderInput["figure_sources"], feeSet: CdFeeLine[] = fees()): CdRenderInput => ({
  application_id: REFI, cd_reason: over.cd_version === 1 ? "initial" : "pre_consummation_no_wait", transaction_type: "refinance", state: "AZ",
  loan: { loan_amount_cents: 56_000_000n, rate_pct: "6.125", term_months: 360, pi_cents: 340_262n, product: "Fixed Rate", loan_type: "Conventional", purpose: "Refinance", prepayment_penalty: false, balloon: false, arm: false, loan_id_number: "APP-REFI-1", mic_number: null, first_payment_date: D("2027-01-01"), maturity_date: D("2056-12-01") },
  apr: { apr_calculation_id: "APR-CD-1", apr_pct: APR_V1.apr_disclosed_str, finance_charge_cents: APR_V1.finance_charge_cents, amount_financed_cents: APR_V1.amount_financed_cents, total_of_payments_cents: APR_V1.total_of_payments_cents, tip_pct: APR_V1.tip_pct.toFixed(3) },
  fees: feeSet, figure_sources: sources, escrow: { established: true, monthly_escrow_cents: 52_500n, initial_escrow_payment_cents: 187_500n, escrowed_costs_year1_cents: 630_000n, non_escrowed_costs_year1_cents: 0n },
  parties: { borrowers: ["Alex Rivera", "Jordan Rivera"], creditor_name: "Partner Bank, N.A.", creditor_nmlsr_id: "123456", mlo_name: "Jordan Lee", mlo_nmlsr_id: "987654", settlement_agent_name: "Desert Title Agency LLC", settlement_agent_license_id: "AZ-TA-4471" },
  dates: { date_issued: D("2026-11-02"), closing_date: D("2026-11-06"), disbursement_date: D("2026-11-12") }, property_address: "4821 E Camelback Rd, Phoenix AZ 85018", cash_to_close_cents: 552_943n, lender_credits_cents: 0n, payoffs_and_payments_cents: 54_820_000n, rescindable: true, ...over,
});

function harness(o: { le_earliest?: PlainDate; tolerance?: boolean } = {}) {
  const clock = new FixedClock("2026-10-30T16:00:00.000Z");
  const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["25.2"] });
  const escalations = new EscalationService(events, clock);
  const leCalls: { application_id: string; requested_on: PlainDate }[] = [];
  const toleranceRuns: { application_id: string; stage: string; disclosure_id: string; fee_items: readonly CdFeeLine[] }[] = [];
  // 21.2's 7-SBD LE gate (evaluator 21.2.le7sbdGateOpen) asserted before a CD is issued: the initial LE was mailed Wed Oct 7 → earliest consummation Thu Oct 15, 2026
  const le = { assertGateOpen: (application_id: string, requested_on: PlainDate) => { leCalls.push({ application_id, requested_on }); assertLeGateOpen({ earliest_consummation_date: o.le_earliest ?? D("2026-10-15"), requested_on }); } };
  const tolerance = o.tolerance === false ? undefined : { runToleranceTest: (i: { application_id: string; stage: "cd_initial" | "cd_corrected" | "post_consummation"; disclosure_id: string; fee_items: readonly CdFeeLine[] }) => { toleranceRuns.push(i); return { result: "pass", test_code: "TRID_19E3_TOLERANCE" }; } };
  const svc = new ClosingDisclosureService({ events, clock, escalations, le, ...(tolerance ? { tolerance } : {}) });
  const timer = (code: string) => timers.byCode(code).at(-1);
  const ofType = (t: string) => events.ofType(t);
  const schedule = (app: string, on: string, transaction_type: "purchase" | "refinance") => { const s = svc.onClosingScheduled(app, { scheduled_consummation_date: D(on), transaction_type }); events.append({ type: "closing.scheduled", applicationId: app, actor: { kind: "agent", id: "closer" }, payload: { application_id: app, closing_id: `CLS-${app}`, scheduled_at: `${on}T16:00:00.000Z`, scheduled_consummation_date: on, transaction_type } }); return s; };
  const sources = (app: string, recording = 3_000n) => { svc.recordFigureSource({ source_id: `SRC-SA-${app}`, application_id: app, party: "settlement_agent", payload: { fees: [{ fee_code: "title_lender_policy", amount_cents: "120000" }, { fee_code: "settlement_fee", amount_cents: "60000" }, { fee_code: "recording", amount_cents: recording.toString() }] }, payload_document_id: "DOC-SA-FEES" }); svc.recordFigureSource({ source_id: `SRC-ESC-${app}`, application_id: app, party: "escrow", payload: { monthly_cents: "52500", deposit_cents: "187500" } }); return svc.reconcileFigureSources(app, fees(recording)); };
  /** CD v1 for the refinance fixture: figures reconciled, prepared, 25.1 CD gate open. */
  const cdV1 = (required: string[] = [B1, B2], app = REFI) => { const src = sources(app); const row = svc.prepare({ ...renderInput({ application_id: app, disclosure_id: `${app}-CD-1`, cd_version: 1 }, src), required_consumer_ids: required }); svc.recordGateRun(row.disclosure_id, { run_id: "RUN-CD-1", open: true, apr_verdict: "pass", blocked_channels: [] }); return row; };
  const esignAll = (disclosureId: string, at: string, consumers: string[] = [B1, B2]) => { for (const c of consumers) { svc.deliver(disclosureId, { consumer_id: c, channel: "esign_portal", at, esign_consent_id: `ESIGN-${c}` }); } for (const c of consumers) svc.recordReceipt(disclosureId, { consumer_id: c, evidence: "esign_confirmed", at, evidence_document_id: `DOC-ESIGN-${c}` }); };
  return { clock, events, timers, escalations, svc, timer, ofType, schedule, sources, cdV1, esignAll, leCalls, toleranceRuns };
}

test("25.2-T1: Given CD v1 e-delivered Mon Nov 2, 2026 and both borrowers' e-sign acknowledgements the same day, when `computeEarliestConsummation` runs, then `earliest_consummation_date = 2026-11-05` and `consummate` on Fri Nov 6 passes `REGZ_1026_19F1_CD_3SBD_GATE`.", () => {
  const h = harness(); h.schedule(REFI, "2026-11-06", "refinance");
  const v1 = h.cdV1();
  assert.equal(v1.status, "gated"); assert.deepEqual(h.leCalls, [{ application_id: REFI, requested_on: "2026-11-06" }], "21.2's LE 7-SBD gate is asserted for the scheduled consummation date before the CD is issued");
  assert.equal(h.ofType("disclosure.cd.prepared").at(-1)!.payload.version, "CD-1"); assert.equal(h.ofType("disclosure.cd.prepared").at(-1)!.applicationId, REFI, "30.3's escrow-consistency gate runs on this event");
  // e-delivered Mon Nov 2, 2026 09:14 MST (16:14Z) to both borrowers; both e-sign the acknowledgement the same day
  h.esignAll(v1.disclosure_id, "2026-11-02T16:14:00.000Z");
  const wp = h.svc.computeEarliestConsummation(v1.disclosure_id);
  assert.equal(wp.complete, true); assert.equal(wp.latest_effective_receipt_date, "2026-11-02");
  assert.equal(wp.earliest_consummation_date, "2026-11-05", "Tue Nov 3 (1), Wed Nov 4 (2), Thu Nov 5 (3)");
  assert.deepEqual(wp.receipts.map((r) => r.evidence), ["esign_confirmed", "esign_confirmed"]);
  assert.equal(h.ofType("disclosure.cd.waiting_period.computed").at(-1)!.payload.earliest_consummation_date, "2026-11-05");
  assert.equal(h.svc.get(v1.disclosure_id).status, "waiting");
  // the gate armed on disclosure.cd.received{all_required=true} (evaluator-backed) and opens for Fri Nov 6
  const received = h.ofType("disclosure.cd.received"); assert.equal(received.length, 2); assert.equal(received[0]!.payload.all_required, false); assert.equal(received[1]!.payload.all_required, true);
  const gate = h.timer("REGZ_1026_19F1_CD_3SBD_GATE")!; assert.equal(gate.status, "armed"); assert.equal(gate.anchorDate, "2026-11-02"); assert.equal(gate.applicationId, REFI);
  const facts = h.svc.gateFacts(REFI, D("2026-11-06"));
  assert.deepEqual(EVALUATORS_25_2["25.2.cd3sbdGateOpen"]!(facts as Record<string, unknown>), { open: true });
  assert.equal(EVALUATORS_25_2["25.2.cd3sbdGateOpen"]!({ ...facts, requested_on: "2026-11-04" } as Record<string, unknown>).open, false, "Wed Nov 4 is inside the waiting period");
  assert.deepEqual(cd3sbdGate({ earliest_consummation_date: "2026-11-05", requested_on: "2026-11-05", receipts_complete: true }), { open: true }, "consummation may occur on the third business day itself");
  const row = h.svc.consummate(REFI, { at: "2026-11-06T17:00:00.000Z", requested_on: D("2026-11-06") });
  assert.equal(row.status, "consummated"); assert.equal(h.ofType("disclosure.cd.consummated").at(-1)!.payload.version, "CD-1");
  assert.equal(h.timer("REGZ_1026_19F1_CD_3SBD_GATE")!.status, "satisfied", "closed by disclosure.cd.consummated");
  assert.equal(h.timer("SM_O62_CD_TARGET_4SBD")!.status, "satisfied", "the policy target (−4 SBD from Fri Nov 6: Thu 5, Wed 4, Tue 3, Mon 2) is met by the Nov 2 delivery event");
  assert.equal(h.timer("SM_O62_CD_TARGET_4SBD")!.dueDate, "2026-11-02");
});

test("25.2-T2: Given CD v1 placed in the mail Mon Nov 2 with no acknowledgement, then `presumed_receipt_date = 2026-11-05`, `earliest_consummation_date = 2026-11-09`, and `consummate` on Fri Nov 6 is refused.", () => {
  const h = harness(); h.schedule(REFI, "2026-11-06", "refinance");
  const v1 = h.cdV1();
  for (const c of [B1, B2]) { const r = h.svc.deliver(v1.disclosure_id, { consumer_id: c, channel: "mail", at: "2026-11-02T20:00:00.000Z", mailing_proof_id: "PMV-2026-11-02-0142" }); assert.equal(r.presumed_receipt_date, "2026-11-05", "Tue 3, Wed 4, Thu 5"); assert.equal(r.receipt_evidence, null); assert.equal(r.mailed_at, "2026-11-02T20:00:00.000Z"); }
  assert.equal(h.svc.get(v1.disclosure_id).status, "delivered");
  const mailbox = h.timer("REGZ_1026_19F1III_CD_MAILBOX_3SBD")!; assert.equal(mailbox.status, "armed"); assert.equal(mailbox.dueDate, "2026-11-05"); assert.equal(mailbox.anchorDate, "2026-11-02");
  assert.equal(h.timer("REGZ_1026_19F1_CD_3SBD_GATE"), undefined, "no receipt yet — the gate has not armed");
  // worked example 2: the borrower's Wed Nov 4 phone call that the package arrived is not evidence the platform accepts (decision 25.2-Q2)
  assert.throws(() => h.svc.recordReceipt(v1.disclosure_id, { consumer_id: B1, evidence: "oral_confirmation", at: "2026-11-04T18:00:00.000Z", evidence_document_id: null }), (e: unknown) => e instanceof CdRefused && e.code === "RECEIPT_EVIDENCE_KIND");
  assert.throws(() => h.svc.recordReceipt(v1.disclosure_id, { consumer_id: B1, evidence: "email_opened", at: "2026-11-04T18:00:00.000Z", evidence_document_id: "DOC-X" }), (e: unknown) => e instanceof CdRefused && e.code === "RECEIPT_EVIDENCE_KIND");
  assert.equal(h.svc.computeEarliestConsummation(v1.disclosure_id).complete, false, "before the presumed date nothing is received");
  assert.equal(h.svc.deemReceived(v1.disclosure_id, D("2026-11-04")).complete, false, "the sweep does nothing before Thu Nov 5");
  const wp = h.svc.deemReceived(v1.disclosure_id, D("2026-11-05"));
  assert.equal(wp.complete, true); assert.equal(wp.latest_effective_receipt_date, "2026-11-05"); assert.deepEqual(wp.receipts.map((r) => r.evidence), ["mailbox_rule", "mailbox_rule"]);
  assert.equal(wp.earliest_consummation_date, "2026-11-09", "Fri 6 (1), Sat 7 (2), Sun 8 excluded, Mon 9 (3)");
  assert.equal(h.svc.get(v1.disclosure_id).earliest_consummation_date, "2026-11-09");
  assert.equal(h.timer("REGZ_1026_19F1III_CD_MAILBOX_3SBD")!.status, "satisfied", "the deemed disclosure.cd.received closes the presumption row");
  assert.throws(() => h.svc.consummate(REFI, { at: "2026-11-06T17:00:00.000Z", requested_on: D("2026-11-06") }), (e: unknown) => e instanceof CdGateClosed && e.code === "REGZ_1026_19F1_CD_3SBD_GATE" && /precedes the earliest permitted date 2026-11-09/.test(e.message));
  assert.equal(h.ofType("disclosure.cd.consummated").length, 0);
  assert.equal(EVALUATORS_25_2["25.2.cd3sbdGateOpen"]!(h.svc.gateFacts(REFI, D("2026-11-06")) as Record<string, unknown>).open, false);
  assert.equal(h.svc.consummate(REFI, { at: "2026-11-09T17:00:00.000Z", requested_on: D("2026-11-09") }).status, "consummated", "the Nov 6 closing moves to Mon Nov 9");
});

test("25.2-T3: Given receipt Mon Nov 9, 2026, then `earliest_consummation_date = 2026-11-13` (Veterans Day excluded); given receipt Tue Nov 10, then `2026-11-14` (Saturday counts).", () => {
  assert.equal(regzSpecific.isBusinessDay(D("2026-11-11")), false, "Wed Nov 11, 2026 — Veterans Day on its statutory date");
  assert.equal(regzSpecific.isBusinessDay(D("2026-11-14")), true, "Saturday counts under §1026.2(a)(6) second sentence");
  assert.equal(regzSpecific.isBusinessDay(D("2026-11-15")), false, "Sunday does not");
  assert.equal(earliestConsummationDate(D("2026-11-09")), "2026-11-13", "Tue 10 (1), Wed 11 excluded, Thu 12 (2), Fri 13 (3)");
  assert.equal(earliestConsummationDate(D("2026-11-10")), "2026-11-14", "Wed 11 excluded, Thu 12 (1), Fri 13 (2), Sat 14 (3)");
  assert.equal(addSpecificBusinessDays(D("2026-11-10"), 3), "2026-11-14");
  // the same arithmetic through the service: e-sign acknowledgements on Mon Nov 9 / Tue Nov 10
  const h = harness(); h.schedule(REFI, "2026-11-20", "refinance"); const v1 = h.cdV1();
  h.svc.deliver(v1.disclosure_id, { consumer_id: B1, channel: "esign_portal", at: "2026-11-09T17:00:00.000Z", esign_consent_id: "ESIGN-BRW-1" }); h.svc.deliver(v1.disclosure_id, { consumer_id: B2, channel: "esign_portal", at: "2026-11-09T17:00:00.000Z", esign_consent_id: "ESIGN-BRW-2" });
  h.svc.recordReceipt(v1.disclosure_id, { consumer_id: B1, evidence: "esign_confirmed", at: "2026-11-09T18:00:00.000Z", evidence_document_id: "DOC-E1" }); h.svc.recordReceipt(v1.disclosure_id, { consumer_id: B2, evidence: "esign_confirmed", at: "2026-11-09T18:30:00.000Z", evidence_document_id: "DOC-E2" });
  assert.equal(h.svc.computeEarliestConsummation(v1.disclosure_id).earliest_consummation_date, "2026-11-13");
  const g = harness(); g.schedule(REFI, "2026-11-20", "refinance"); const w1 = g.cdV1();
  g.svc.deliver(w1.disclosure_id, { consumer_id: B1, channel: "esign_portal", at: "2026-11-09T17:00:00.000Z", esign_consent_id: "ESIGN-BRW-1" }); g.svc.deliver(w1.disclosure_id, { consumer_id: B2, channel: "esign_portal", at: "2026-11-09T17:00:00.000Z", esign_consent_id: "ESIGN-BRW-2" });
  g.svc.recordReceipt(w1.disclosure_id, { consumer_id: B1, evidence: "esign_confirmed", at: "2026-11-09T18:00:00.000Z", evidence_document_id: "DOC-E1" }); g.svc.recordReceipt(w1.disclosure_id, { consumer_id: B2, evidence: "portal_acknowledged", at: "2026-11-10T22:00:00.000Z", evidence_document_id: "DOC-E2" });
  assert.equal(g.svc.computeEarliestConsummation(w1.disclosure_id).earliest_consummation_date, "2026-11-14", "the gate uses the latest required consumer's receipt (Tue Nov 10) — a Saturday closing is lawful");
  assert.equal(g.svc.consummate(REFI, { at: "2026-11-14T18:00:00.000Z", requested_on: D("2026-11-14") }).status, "consummated");
});

test("25.2-T4: Given the purchase fixture closing Wed Nov 18, 2026 and a mailed CD, when the agent schedules delivery, then the mailing date is no later than Tue Nov 10 and `SM_O62_CD_TARGET_4SBD` targets e-delivery by Fri Nov 13.", () => {
  assert.equal(latestReceiptDateFor(D("2026-11-18")), "2026-11-14", "Tue 17 (1), Mon 16 (2), Sun 15 excluded, Sat 14 (3)");
  assert.equal(latestMailingDateFor(D("2026-11-18")), "2026-11-10", "Fri 13 (1), Thu 12 (2), Wed 11 excluded, Tue 10 (3)");
  assert.equal(presumedReceiptDate(D("2026-11-10")), "2026-11-14", "mailed Tue Nov 10 → presumed receipt Sat Nov 14");
  assert.equal(cdTargetDeliveryDate(D("2026-11-18")), "2026-11-13", "Tue 17, Mon 16, Sat 14, Fri 13");
  assert.equal(settlementFiguresDueDate(D("2026-11-18")), "2026-11-12", "Tue 17, Mon 16, Sat 14, Fri 13, Thu 12");
  const s = scheduleDelivery(D("2026-11-18"), "mail");
  assert.deepEqual(s, { scheduled_consummation_date: "2026-11-18", latest_receipt_date: "2026-11-14", latest_mailing_date: "2026-11-10", target_edelivery_date: "2026-11-13", settlement_figures_due: "2026-11-12", recommended_channel: "mail", send_no_later_than: "2026-11-10" });
  assert.equal(scheduleDelivery(D("2026-11-18")).send_no_later_than, "2026-11-13");
  const h = harness();
  const sched = h.schedule(PUR, "2026-11-18", "purchase"); assert.equal(sched.latest_mailing_date, "2026-11-10");
  const target = h.timer("SM_O62_CD_TARGET_4SBD")!; assert.equal(target.status, "armed"); assert.equal(target.dueDate, "2026-11-13"); assert.equal(target.anchorDate, "2026-11-18"); assert.equal(target.applicationId, PUR);
  const figures = h.timer("SM_O62_SETTLEMENT_FIGURES_5SBD")!; assert.equal(figures.status, "armed"); assert.equal(figures.dueDate, "2026-11-12");
  h.sources(PUR); assert.equal(h.timer("SM_O62_SETTLEMENT_FIGURES_5SBD")!.status, "satisfied", "reconciled settlement-agent figures (cd.figure_source.reconciled{party=settlement_agent})");
  // purchase fixture: $412,000 at 6.375%, P&I $2,570.34, funding Thu Nov 19 → 12 days of prepaid interest ($863.51), 0.500 points ($2,060.00)
  const aprPur = computeApr({ loan_amount_cents: 41_200_000n, note_rate_pct: "6.375", term_months: 360, term_start_date: D("2026-11-19"), first_payment_date: D("2027-01-01"), prepaid_finance_charges_cents: 86_351n + 206_000n + 195_000n, prepaid_interest_cents: 86_351n, method: "appendix_j_exact", checkpoint: "cd" });
  assert.equal(aprPur.pi_cents, 257_034n);
  const v1 = h.svc.prepare({ ...renderInput({ application_id: PUR, disclosure_id: "APP-PUR-1-CD-1", cd_version: 1, transaction_type: "purchase", state: "OH", apr: { apr_calculation_id: "APR-PUR-CD-1", apr_pct: aprPur.apr_disclosed_str, finance_charge_cents: aprPur.finance_charge_cents, amount_financed_cents: aprPur.amount_financed_cents, total_of_payments_cents: aprPur.total_of_payments_cents, tip_pct: aprPur.tip_pct.toFixed(3) }, dates: { date_issued: D("2026-11-10"), closing_date: D("2026-11-18"), disbursement_date: D("2026-11-19") }, parties: { borrowers: ["Taylor Brooks", "Casey Brooks"], creditor_name: "Partner Bank, N.A.", creditor_nmlsr_id: "123456", mlo_name: "Jordan Lee", mlo_nmlsr_id: "987654", settlement_agent_name: "Buckeye Title Agency LLC", settlement_agent_license_id: "OH-TA-2210", seller_name: "Morgan Hale" }, loan: { loan_amount_cents: 41_200_000n, rate_pct: "6.375", term_months: 360, pi_cents: 257_034n, product: "Fixed Rate", loan_type: "Conventional", purpose: "Purchase", prepayment_penalty: false, balloon: false, arm: false, loan_id_number: "APP-PUR-1", mic_number: "MIC-4471", first_payment_date: D("2027-01-01"), maturity_date: D("2056-12-01") } }, h.svc.figureSources(PUR)), required_consumer_ids: [B1, B2] });
  assert.deepEqual(h.leCalls, [{ application_id: PUR, requested_on: "2026-11-18" }], "the LE 7-SBD gate is asserted for Nov 18 before the CD is issued");
  h.svc.recordGateRun(v1.disclosure_id, { run_id: "RUN-PUR-CD-1", open: true, apr_verdict: "pass" });
  const r = h.svc.deliver(v1.disclosure_id, { consumer_id: B1, channel: "mail", at: "2026-11-10T21:00:00.000Z", mailing_proof_id: "PMV-2026-11-10-0007" });
  assert.equal(r.delivered_on, "2026-11-10"); assert.equal(r.presumed_receipt_date, "2026-11-14", "mailed on the last permitted day still lands the presumption three specific business days before Nov 18");
  assert.equal(h.timer("SM_O62_CD_TARGET_4SBD")!.status, "satisfied");
  // a CD prepared for a consummation date inside the LE's seven-business-day period is refused by 21.2's gate
  const early = harness({ le_earliest: D("2026-11-20") }); early.schedule(PUR, "2026-11-18", "purchase"); early.sources(PUR);
  assert.throws(() => early.svc.prepare({ ...renderInput({ application_id: PUR, disclosure_id: "APP-PUR-1-CD-1", cd_version: 1 }, early.svc.figureSources(PUR)), required_consumer_ids: [B1] }), (e: unknown) => e instanceof LeGateClosed);
});

test("25.2-T5: Given CD v1 APR 6.159 and a Wed Nov 4 rate change producing actual APR 5.979, when `evaluateRedisclosure` runs, then `new_wait = true` with trigger `(f)(2)(ii)(A)`, `NTC_REGZ_1026_38_CD_CORRECTED` is delivered, and after same-day e-sign `earliest_consummation_date = 2026-11-07`.", () => {
  assert.equal(APR_V1.apr_disclosed_str, "6.159"); assert.equal(APR_BUYDOWN.apr_disclosed_str, "5.979", "25.1 worked example 2 (0.750 points at 5.875%)"); assert.equal(APR_BUYDOWN.pi_cents, 331_261n);
  const h = harness(); h.schedule(REFI, "2026-11-06", "refinance"); const v1 = h.cdV1(); h.esignAll(v1.disclosure_id, "2026-11-02T16:14:00.000Z");
  assert.equal(h.svc.get(v1.disclosure_id).earliest_consummation_date, "2026-11-05");
  const next = { apr_actual: APR_BUYDOWN.apr_disclosed_str, finance_charge_cents: APR_BUYDOWN.finance_charge_cents, product: "Fixed Rate", prepayment_penalty: false };
  const ev = h.svc.evaluateRedisclosure(v1.disclosure_id, next, { transaction: { irregular_first_period: true } });
  assert.equal(ev.new_wait, true); assert.deepEqual(ev.triggers, ["(f)(2)(ii)(A)"]); assert.equal(ev.cd_reason, "pre_consummation_new_wait");
  assert.equal(ev.apr_accuracy.result, "fail"); assert.equal(ev.apr_accuracy.apr_variance, 0.18, "Δ 0.180 > 1/8 (regular transaction — the 1/4 tolerance never applies merely for odd days)"); assert.equal(ev.apr_accuracy.tolerance_applied, "eighth");
  assert.equal(ev.product_changed, false); assert.equal(ev.prepayment_penalty_added, false); assert.ok(ev.test_ids.includes("APR_1026_22_ACCURACY"));
  // the same verdict straight from 25.1's APR_1026_22_ACCURACY
  assert.equal(aprAccuracyTest({ disclosed_apr: "6.159", actual_apr: "5.979", transaction: {}, disclosed_finance_charge_cents: APR_V1.finance_charge_cents, actual_finance_charge_cents: APR_BUYDOWN.finance_charge_cents }).result, "fail");
  const input = { ...renderInput({ disclosure_id: "APP-REFI-1-CD-2", cd_version: 2 }, h.svc.figureSources(REFI), fees(3_000n, [{ fee_code: "discount_points", description: "0.750% of loan amount (points)", amount_cents: 420_000n, section: "A_origination", tolerance_class: "zero", source_id: "SRC-CREDITOR-2" }])), loan: { ...renderInput({ disclosure_id: "x", cd_version: 2 }, []).loan, rate_pct: "5.875", pi_cents: APR_BUYDOWN.pi_cents }, apr: { apr_calculation_id: "APR-CD-2", apr_pct: APR_BUYDOWN.apr_disclosed_str, finance_charge_cents: APR_BUYDOWN.finance_charge_cents, amount_financed_cents: APR_BUYDOWN.amount_financed_cents, total_of_payments_cents: APR_BUYDOWN.total_of_payments_cents, tip_pct: APR_BUYDOWN.tip_pct.toFixed(3) }, dates: { date_issued: D("2026-11-04"), closing_date: D("2026-11-09"), disbursement_date: D("2026-11-13") } };
  const { application_id: _a, disclosure_id: _d, cd_version: _v, cd_reason: _r, ...rest } = input;
  // a "no-wait" corrected CD is refused while 25.1's APR verdict is fail
  assert.throws(() => h.svc.scheduleCorrectedCd(REFI, { disclosure_id: "APP-REFI-1-CD-2", cd_reason: "pre_consummation_no_wait", input: rest, evaluation: ev, gate: { run_id: "RUN-CD-2", apr_verdict: "fail" }, deliveries: [{ consumer_id: B1, channel: "esign_portal", at: "2026-11-04T18:00:00.000Z", esign_consent_id: "ESIGN-BRW-1" }] }), (e: unknown) => e instanceof CdRefused && e.code === "NO_WAIT_WITH_APR_FAIL");
  const r = h.svc.scheduleCorrectedCd(REFI, { disclosure_id: "APP-REFI-1-CD-2", cd_reason: "pre_consummation_new_wait", input: rest, evaluation: ev, gate: { run_id: "RUN-CD-2", apr_verdict: "fail" }, deliveries: [B1, B2].map((c) => ({ consumer_id: c, channel: "esign_portal" as const, at: "2026-11-04T18:00:00.000Z", esign_consent_id: `ESIGN-${c}` })) });
  assert.equal(r.row.cd_version, 2); assert.equal(r.row.kind, "corrected_cd"); assert.equal(r.row.new_waiting_period, true); assert.deepEqual(r.row.redisclosure_triggers, ["(f)(2)(ii)(A)"]);
  assert.equal(r.row.render.notice_code, "NTC_REGZ_1026_38_CD_CORRECTED"); assert.equal(h.ofType("disclosure.cd.delivered").at(-1)!.payload.notice_code, "NTC_REGZ_1026_38_CD_CORRECTED"); assert.equal(h.ofType("disclosure.cd.delivered").at(-1)!.payload.cd_version, 2);
  assert.equal(r.corrected_event.payload.reason, "pre_consummation_new_wait"); assert.equal(r.corrected_event.payload.new_waiting_period, true); assert.equal(r.corrected_event.payload.post_consummation, false);
  assert.equal(h.svc.get(v1.disclosure_id).status, "superseded"); assert.equal(h.svc.waitVersion(REFI)!.disclosure_id, "APP-REFI-1-CD-2");
  for (const c of [B1, B2]) h.svc.recordReceipt("APP-REFI-1-CD-2", { consumer_id: c, evidence: "esign_confirmed", at: "2026-11-04T19:30:00.000Z", evidence_document_id: `DOC-ESIGN2-${c}` });
  assert.equal(h.svc.computeEarliestConsummation("APP-REFI-1-CD-2").earliest_consummation_date, "2026-11-07", "Thu 5, Fri 6, Sat 7");
  assert.equal(h.ofType("disclosure.cd.waiting_period.computed").at(-1)!.payload.earliest_consummation_date, "2026-11-07");
  assert.throws(() => h.svc.consummate(REFI, { at: "2026-11-06T17:00:00.000Z", requested_on: D("2026-11-06") }), (e: unknown) => e instanceof CdGateClosed, "the Fri Nov 6 closing is rescheduled");
  assert.equal(h.svc.consummate(REFI, { at: "2026-11-09T17:00:00.000Z", requested_on: D("2026-11-09") }).cd_version, 2, "the borrower chooses Mon Nov 9");
  // the other two triggers
  assert.deepEqual(evaluateRedisclosure({ prev: { apr_disclosed: "6.159", finance_charge_cents: APR_V1.finance_charge_cents, product: "Fixed Rate", prepayment_penalty: false }, next: { apr_actual: "6.159", finance_charge_cents: APR_V1.finance_charge_cents, product: "5/6 Adjustable Rate", prepayment_penalty: true } }).triggers, ["(f)(2)(ii)(B)", "(f)(2)(ii)(C)"]);
});

test("25.2-T6: Given a recording-fee increase of $12 on Thu Nov 5 with no APR or product change, then `new_wait = false`, `cd_reason = pre_consummation_no_wait`, and the corrected CD is delivered for receipt at or before the Fri Nov 6 consummation; `runToleranceTest` is invoked.", () => {
  const h = harness(); h.schedule(REFI, "2026-11-06", "refinance"); const v1 = h.cdV1(); h.esignAll(v1.disclosure_id, "2026-11-02T16:14:00.000Z");
  // Thu Nov 5: the title agent's recording fee estimate rises from $30.00 to $42.00 — recording fees are excluded from the finance charge (§1026.4(e)(1)), so the APR is unchanged
  const increase = 4_200n - 3_000n; assert.equal(increase, 1_200n, "$12.00");
  const ev = h.svc.evaluateRedisclosure(v1.disclosure_id, { apr_actual: "6.159", finance_charge_cents: APR_V1.finance_charge_cents, product: "Fixed Rate", prepayment_penalty: false }, { transaction: { irregular_first_period: true } });
  assert.equal(ev.new_wait, false); assert.deepEqual(ev.triggers, []); assert.equal(ev.cd_reason, "pre_consummation_no_wait"); assert.equal(ev.apr_accuracy.result, "pass"); assert.equal(ev.apr_accuracy.accuracy_basis, "a2");
  h.svc.recordFigureSource({ source_id: "SRC-SA-2", application_id: REFI, party: "settlement_agent", payload: { fees: [{ fee_code: "title_lender_policy", amount_cents: "120000" }, { fee_code: "settlement_fee", amount_cents: "60000" }, { fee_code: "recording", amount_cents: "4200" }] } });
  assert.equal(h.svc.reconcileFigureSources(REFI, fees(4_200n)).every((s) => s.reconciled), true, "the new settlement-agent version reconciles to the corrected fee items");
  const input = renderInput({ disclosure_id: "APP-REFI-1-CD-2", cd_version: 2, dates: { date_issued: D("2026-11-05"), closing_date: D("2026-11-06"), disbursement_date: D("2026-11-12") }, cash_to_close_cents: 552_943n + increase }, h.svc.figureSources(REFI), fees(4_200n));
  const { application_id: _a, disclosure_id: _d, cd_version: _v, cd_reason: _r, ...rest } = input;
  const r = h.svc.scheduleCorrectedCd(REFI, { disclosure_id: "APP-REFI-1-CD-2", cd_reason: "pre_consummation_no_wait", input: rest, evaluation: ev, gate: { run_id: "RUN-CD-2", apr_verdict: "pass" }, deliveries: [B1, B2].map((c) => ({ consumer_id: c, channel: "esign_portal" as const, at: "2026-11-05T16:00:00.000Z", esign_consent_id: `ESIGN-${c}` })) });
  assert.equal(r.row.cd_reason, "pre_consummation_no_wait"); assert.equal(r.row.new_waiting_period, false); assert.equal(r.corrected_event.payload.reason, "pre_consummation_no_wait"); assert.equal(r.corrected_event.payload.new_waiting_period, false);
  assert.equal(r.tolerance_test_invoked, true, "21.5's runToleranceTest runs at every CD version (10-percent category)");
  assert.equal(h.toleranceRuns.length, 1); assert.equal(h.toleranceRuns[0]!.stage, "cd_corrected"); assert.equal(h.toleranceRuns[0]!.disclosure_id, "APP-REFI-1-CD-2"); assert.equal(h.toleranceRuns[0]!.fee_items.find((f) => f.fee_code === "recording")!.amount_cents, 4_200n);
  for (const c of [B1, B2]) h.svc.recordReceipt("APP-REFI-1-CD-2", { consumer_id: c, evidence: "esign_confirmed", at: "2026-11-05T17:00:00.000Z", evidence_document_id: `DOC-ESIGN2-${c}` });
  assert.equal(h.svc.computeEarliestConsummation("APP-REFI-1-CD-2").latest_effective_receipt_date, "2026-11-05", "received before the Fri Nov 6 signing");
  assert.equal(h.svc.waitVersion(REFI)!.disclosure_id, v1.disclosure_id, "the waiting period is still v1's (received Nov 2 → earliest Nov 5)");
  assert.equal(h.svc.get("APP-REFI-1-CD-2").earliest_consummation_date, "2026-11-05");
  assert.equal(h.ofType("disclosure.cd.waiting_period.computed").length, 1, "a no-wait correction does not restart the clock");
  const facts = h.svc.gateFacts(REFI, D("2026-11-06")); assert.equal(facts.receipts_complete, true); assert.equal(facts.earliest_consummation_date, "2026-11-05");
  assert.equal(h.svc.consummate(REFI, { at: "2026-11-06T17:00:00.000Z", requested_on: D("2026-11-06") }).cd_version, 2, "consummation Fri Nov 6 on the corrected CD");
  // the same no-wait correction mailed Nov 5 would not be received at or before consummation (presumed Mon Nov 9)
  const g = harness(); g.schedule(REFI, "2026-11-06", "refinance"); const w1 = g.cdV1(); g.esignAll(w1.disclosure_id, "2026-11-02T16:14:00.000Z");
  g.svc.scheduleCorrectedCd(REFI, { disclosure_id: "APP-REFI-1-CD-2", cd_reason: "pre_consummation_no_wait", input: rest, evaluation: ev, gate: { run_id: "RUN-CD-2", apr_verdict: "pass" }, deliveries: [B1, B2].map((c) => ({ consumer_id: c, channel: "mail" as const, at: "2026-11-05T16:00:00.000Z", mailing_proof_id: "PMV-2026-11-05-0009" })) });
  g.svc.deemReceived("APP-REFI-1-CD-2", D("2026-11-09"));
  assert.equal(g.svc.gateFacts(REFI, D("2026-11-06")).receipts_complete, false, "a mailed no-wait CD presumed received Mon Nov 9 is not received at or before a Fri Nov 6 consummation");
});

test("25.2-T7: Given consummation Fri Nov 6 and recording-fee information received Mon Nov 16, then `REGZ_1026_19F2_CORRECTED_CD_30` is due Wed Dec 16, 2026 and is satisfied by a corrected CD mailed Tue Nov 17; given a clerical name error, `REGZ_1026_19F2_CLERICAL_CD_60` is due Tue Jan 5, 2027.", () => {
  assert.deepEqual(postConsummationEventWindow(D("2026-11-06")), { from: "2026-11-07", to: "2026-12-06" }, "30 calendar days after consummation; day 1 = Nov 7");
  assert.equal(correctedCdDueDate(D("2026-11-16")), "2026-12-16"); assert.equal(clericalCdDueDate(D("2026-11-06")), "2027-01-05");
  const h = harness(); h.schedule(REFI, "2026-11-06", "refinance"); const v1 = h.cdV1(); h.esignAll(v1.disclosure_id, "2026-11-02T16:14:00.000Z");
  h.svc.consummate(REFI, { at: "2026-11-06T17:00:00.000Z", requested_on: D("2026-11-06") });
  // Mon Nov 16: the recorder returns the deed of trust with an actual recording fee $12.00 higher than disclosed (an event in connection with the settlement; an amount actually paid changed)
  const c = h.svc.recordCorrectionEvent(REFI, { event_on: D("2026-11-16"), info_received_on: D("2026-11-16"), info_received_at: "2026-11-16T18:00:00.000Z", numeric: true, amount_paid_changed: true, in_connection_with_settlement: true, description: "recording fee $30.00 → $42.00 (+$12.00)" });
  assert.equal(c.regime, "post_consummation_event"); assert.equal(c.timer, "REGZ_1026_19F2_CORRECTED_CD_30"); assert.equal(c.due_on, "2026-12-16"); assert.equal(c.within_window, true);
  const t30 = h.timer("REGZ_1026_19F2_CORRECTED_CD_30")!; assert.equal(t30.status, "armed"); assert.equal(t30.anchorDate, "2026-11-16"); assert.equal(t30.dueDate, "2026-12-16", "Nov 16 + 30 calendar days");
  h.svc.recordFigureSource({ source_id: "SRC-SA-3", application_id: REFI, party: "settlement_agent", payload: { fees: [{ fee_code: "title_lender_policy", amount_cents: "120000" }, { fee_code: "settlement_fee", amount_cents: "60000" }, { fee_code: "recording", amount_cents: "4200" }] } }); h.svc.reconcileFigureSources(REFI, fees(4_200n));
  const input = renderInput({ disclosure_id: "APP-REFI-1-CD-2", cd_version: 2, dates: { date_issued: D("2026-11-17"), closing_date: D("2026-11-06"), disbursement_date: D("2026-11-12") }, cash_to_close_cents: 554_143n }, h.svc.figureSources(REFI), fees(4_200n));
  const { application_id: _a, disclosure_id: _d, cd_version: _v, cd_reason: _r, ...rest } = input;
  const r = h.svc.scheduleCorrectedCd(REFI, { disclosure_id: "APP-REFI-1-CD-2", cd_reason: "post_consummation_event", input: rest, gate: { run_id: "RUN-CD-2", apr_verdict: "pass" }, deliveries: [B1, B2].map((c2) => ({ consumer_id: c2, channel: "mail" as const, at: "2026-11-17T20:00:00.000Z", mailing_proof_id: "PMV-2026-11-17-0031" })) });
  assert.equal(r.corrected_event.payload.reason, "post_consummation_event"); assert.equal(r.corrected_event.payload.post_consummation, true); assert.equal(r.corrected_event.payload.delivered_on, "2026-11-17"); assert.equal(r.corrected_event.payload.channel, "mail");
  assert.equal(h.timer("REGZ_1026_19F2_CORRECTED_CD_30")!.status, "satisfied", "placed in the mail Tue Nov 17, before the Dec 16 deadline"); assert.equal(r.row.status, "final"); assert.equal(r.row.retention_class, "regz_cd_5y");
  assert.equal(h.toleranceRuns.at(-1)!.stage, "post_consummation");
  // a borrower's middle initial is wrong on page 1 (non-numeric clerical)
  const cl = h.svc.recordCorrectionEvent(REFI, { event_on: D("2026-11-20"), info_received_on: D("2026-11-20"), info_received_at: "2026-11-20T18:00:00.000Z", numeric: false, amount_paid_changed: false, in_connection_with_settlement: false, description: "borrower middle initial wrong on page 1" });
  assert.equal(cl.regime, "clerical"); assert.equal(cl.timer, "REGZ_1026_19F2_CLERICAL_CD_60"); assert.equal(cl.due_on, "2027-01-05", "Nov 6 + 60 calendar days");
  const t60 = h.timer("REGZ_1026_19F2_CLERICAL_CD_60")!; assert.equal(t60.status, "armed"); assert.equal(t60.anchorDate, "2026-11-06"); assert.equal(t60.dueDate, "2027-01-05");
  assert.equal(classifyPostConsummationCorrection({ consummation_on: D("2026-11-06"), event_on: D("2026-11-20"), info_received_on: D("2026-11-20"), numeric: false, amount_paid_changed: false, in_connection_with_settlement: false, tolerance_refund: true }).due_on, "2027-01-05", "tolerance refunds (21.5): also Jan 5, 2027");
  assert.throws(() => classifyPostConsummationCorrection({ consummation_on: D("2026-11-06"), event_on: D("2026-12-10"), info_received_on: D("2026-12-10"), numeric: true, amount_paid_changed: true, in_connection_with_settlement: true }), RangeError, "an event after Dec 6 is outside the (f)(2)(iii) window");
  // breach of the 30-day clock: sev 1 to officer
  const id = h.svc.onCorrectionClockBreached(REFI, "REGZ_1026_19F2_CORRECTED_CD_30"); assert.ok(id); assert.equal(h.escalations.list().at(-1)!.kind, "officer"); assert.equal(h.escalations.list().at(-1)!.severity, "sev1");
});

test("25.2-T8: Given a purchase closing Wed Nov 18 and no seller CD copy received by end of day Nov 18, then `REGZ_1026_19F4_SELLER_CD_GATE` breaches, an escalation to `settlement_agent` opens, and the delivery package is marked incomplete.", () => {
  const h = harness(); h.schedule(PUR, "2026-11-18", "purchase");
  const gate = h.timer("REGZ_1026_19F4_SELLER_CD_GATE")!; assert.equal(gate.status, "armed"); assert.equal(gate.dueDate, "2026-11-18", "no later than the day of consummation (§1026.19(f)(4)(ii))"); assert.equal(gate.applicationId, PUR);
  const seller = (at: string) => h.timers.evaluate(at).filter((b) => b.def.code === "REGZ_1026_19F4_SELLER_CD_GATE");
  assert.equal(seller("2026-11-19T04:00:00.000Z").length, 0, "still Nov 18 23:00 ET — not yet breached");
  const breaches = seller("2026-11-19T05:30:00.000Z"); assert.equal(breaches.length, 1); assert.equal(breaches[0]!.def.code, "REGZ_1026_19F4_SELLER_CD_GATE"); assert.deepEqual(breaches[0]!.escalateTo, ["settlement_agent"]);
  const r = h.svc.onSellerCdGateBreached(PUR, "2026-11-19T05:30:00.000Z");
  assert.equal(r.package_complete, false); assert.ok(r.escalation_id);
  const esc = h.escalations.list().at(-1)!; assert.equal(esc.kind, "settlement_agent"); assert.equal(esc.ownerRole, "settlement_agent"); assert.equal(esc.applicationId, PUR); assert.equal(esc.payload.sla_due, "2026-11-19", "SLA 1 business_days_creditor"); assert.equal(esc.payload.timer, "REGZ_1026_19F4_SELLER_CD_GATE");
  assert.deepEqual(h.svc.delivery(PUR), { ucd_casefile_id: null, package_complete: false, incomplete_reasons: ["seller_cd_missing"] });
  assert.equal(h.ofType("delivery.package.incomplete").at(-1)!.payload.reason, "seller_cd_missing");
  // the settlement agent's copy arrives the next morning: the row closes late and the package is complete again
  const e = h.svc.recordSellerCd(PUR, { document_id: "DOC-SELLER-CD-1", received_at: "2026-11-19T14:00:00.000Z", provided_by: "Buckeye Title Agency LLC" });
  assert.equal(e.type, "disclosure.seller_cd.received"); assert.equal(e.payload.notice_code, "NTC_REGZ_1026_38_SELLER_CD");
  assert.equal(h.timer("REGZ_1026_19F4_SELLER_CD_GATE")!.status, "satisfied_late"); assert.equal(h.svc.delivery(PUR).package_complete, true);
  // a refinance schedules no seller CD gate
  const g = harness(); g.schedule(REFI, "2026-11-06", "refinance"); assert.equal(g.timer("REGZ_1026_19F4_SELLER_CD_GATE"), undefined);
});

test("25.2-T9: Given a consumer waiver typed into a pre-filled template, then `cd_waivers` creation is rejected (\"printed forms prohibited\"); given a consumer-authored dated signed statement accepted by `officer` on Thu Nov 5, then `earliest_consummation_date = 2026-11-05` (not earlier than receipt).", () => {
  const h = harness(); h.schedule(REFI, "2026-11-06", "refinance"); const v1 = h.cdV1();
  // both borrowers e-sign Wed Nov 4 → the ordinary earliest consummation is Sat Nov 7
  h.esignAll(v1.disclosure_id, "2026-11-04T16:00:00.000Z"); assert.equal(h.svc.get(v1.disclosure_id).earliest_consummation_date, "2026-11-07");
  const base = { waiver_id: "WV-1", application_id: REFI, consumer_ids: [B1, B2], statement_document_id: "DOC-WAIVER-1", statement_text: "We must close by November 5 because our lease ends and the seller of our next home will not extend; the bridge loan payoff is due that day.", dated_on: D("2026-11-05"), signed_by: [B1, B2], emergency_summary: "lease expiry and bridge-loan payoff due Nov 5", received_at: "2026-11-05T15:00:00.000Z" };
  assert.throws(() => h.svc.acceptWaiver(v1.disclosure_id, { ...base, template_used: true }, { by: OFFICER, at: "2026-11-05T16:00:00.000Z" }), (e: unknown) => e instanceof CdRefused && e.code === "PRINTED_FORM" && /printed forms prohibited/.test(e.message));
  assert.throws(() => validateWaiverStatement({ ...base, printed_form: true }, [B1, B2], D("2026-11-04")), (e: unknown) => e instanceof CdRefused && e.code === "PRINTED_FORM");
  assert.throws(() => h.svc.acceptWaiver(v1.disclosure_id, { ...base, signed_by: [B1] }, { by: OFFICER }), (e: unknown) => e instanceof CdRefused && e.code === "ALL_CONSUMERS_SIGN");
  assert.throws(() => h.svc.acceptWaiver(v1.disclosure_id, { ...base, dated_on: D("2026-11-03") }, { by: OFFICER }), (e: unknown) => e instanceof CdRefused && e.code === "WAIVER_BEFORE_RECEIPT", "a statement dated before receipt of the CD is not a waiver 'after receiving the disclosures'");
  assert.throws(() => h.svc.acceptWaiver(v1.disclosure_id, base, { by: AGENT }), (e: unknown) => e instanceof CdRefused && e.code === "OFFICER_ONLY");
  assert.equal(h.svc.waiver("WV-1"), undefined); assert.equal(h.ofType("disclosure.cd.waiver.accepted").length, 0);
  const w = h.svc.acceptWaiver(v1.disclosure_id, base, { by: OFFICER, at: "2026-11-05T16:00:00.000Z" });
  assert.equal(w.accepted_by, "u-officer"); assert.equal(w.accepted_on, "2026-11-05"); assert.equal(w.earliest_consummation_date, "2026-11-05");
  assert.equal(h.svc.get(v1.disclosure_id).status, "consummation_ready"); assert.equal(h.svc.get(v1.disclosure_id).earliest_consummation_date, "2026-11-05");
  assert.equal(h.ofType("disclosure.cd.waiver.accepted").at(-1)!.payload.accepted_role, "officer"); assert.equal(h.ofType("disclosure.cd.waiver.accepted").at(-1)!.payload.not_before_receipt, "2026-11-04");
  assert.equal(waiverEarliestConsummation(D("2026-11-01"), D("2026-11-04")), "2026-11-04", "never earlier than receipt");
  const facts = h.svc.gateFacts(REFI, D("2026-11-05")); assert.equal(facts.waiver_accepted_on, "2026-11-05"); assert.deepEqual(cd3sbdGate(facts), { open: true });
  assert.equal(cd3sbdGate(h.svc.gateFacts(REFI, D("2026-11-04"))).open, false, "the waiver does not reach back before its acceptance");
  assert.equal(h.svc.consummate(REFI, { at: "2026-11-05T22:00:00.000Z", requested_on: D("2026-11-05") }).status, "consummated");
  assert.equal(h.ofType("disclosure.cd.consummated").at(-1)!.payload.waiver_id, "WV-1");
});

test("25.2-T10: Given the final CD v2 and a UCD v2.0 submission returning two critical-edit failures, then `FNMA_UCD_ACCEPTED_GATE` stays closed and `submitDelivery` is refused; after regeneration with `critical_edit_failures = 0`, the gate opens and `deliveries.ucd_casefile_id` is populated.", () => {
  const h = harness(); h.schedule(REFI, "2026-11-06", "refinance"); const v1 = h.cdV1(); h.esignAll(v1.disclosure_id, "2026-11-02T16:14:00.000Z");
  assert.throws(() => h.svc.assertUcdGateOpen(REFI), (e: unknown) => e instanceof UcdGateClosed && /no consummated \(final\) Closing Disclosure/.test(e.message));
  // the no-wait correction of T6 makes v2 the version in force at consummation
  h.svc.recordFigureSource({ source_id: "SRC-SA-2", application_id: REFI, party: "settlement_agent", payload: { fees: [{ fee_code: "recording", amount_cents: "4200" }] } }); h.svc.reconcileFigureSources(REFI, fees(4_200n));
  const input = renderInput({ disclosure_id: "APP-REFI-1-CD-2", cd_version: 2, dates: { date_issued: D("2026-11-05"), closing_date: D("2026-11-06"), disbursement_date: D("2026-11-12") } }, h.svc.figureSources(REFI), fees(4_200n));
  const { application_id: _a, disclosure_id: _d, cd_version: _v, cd_reason: _r, ...rest } = input;
  h.svc.scheduleCorrectedCd(REFI, { disclosure_id: "APP-REFI-1-CD-2", cd_reason: "pre_consummation_no_wait", input: rest, gate: { run_id: "RUN-CD-2", apr_verdict: "pass" }, deliveries: [B1, B2].map((c) => ({ consumer_id: c, channel: "esign_portal" as const, at: "2026-11-05T16:00:00.000Z", esign_consent_id: `ESIGN-${c}` })) });
  for (const c of [B1, B2]) h.svc.recordReceipt("APP-REFI-1-CD-2", { consumer_id: c, evidence: "esign_confirmed", at: "2026-11-05T17:00:00.000Z", evidence_document_id: `DOC-ESIGN2-${c}` });
  const finalCd = h.svc.consummate(REFI, { at: "2026-11-06T17:00:00.000Z", requested_on: D("2026-11-06") }); assert.equal(finalCd.cd_version, 2);
  const ucdGate = h.timer("FNMA_UCD_ACCEPTED_GATE")!; assert.equal(ucdGate.status, "armed"); assert.equal(ucdGate.note, "evaluator:25.2.ucdAcceptedGateOpen");
  // a superseded version can never be embedded
  assert.throws(() => h.svc.generateUcd(REFI, { ucd_submission_id: "UCD-0", du_casefile_id: "DU-1234567", disclosure_id: v1.disclosure_id }), (e: unknown) => e instanceof CdRefused && e.code === "SUPERSEDED_CD");
  const u1 = h.svc.generateUcd(REFI, { ucd_submission_id: "UCD-1", du_casefile_id: "DU-1234567", flags: {} });
  assert.equal(u1.ucd_version, "2.0"); assert.equal(u1.schema, "MISMO v3.3.0299"); assert.equal(u1.embedded_cd_disclosure_id, "APP-REFI-1-CD-2"); assert.equal(u1.status, "generated");
  assert.equal(generateUcd({ application_id: REFI, ucd_submission_id: "UCD-F", cd: { disclosure_id: "x", cd_version: 2, status: "final", pdf_document_id: "DOC", figures_hash: "h" }, du_casefile_id: "DU-1", flags: { "fnma.ucd.version": "1.5" } }).ucd_version, "1.5", "v1.5 on the flag until the Q4 2026 mandate date");
  const rej = h.svc.submitUcd(REFI, "UCD-1", { status: "rejected", casefile_id_ucd: null, critical_edit_failures: 2, feedback_messages: ["UCD-2.0 critical edit: LoanPurposeType required", "UCD-2.0 critical edit: EscrowItemType missing"], at: "2026-11-10T15:00:00.000Z" });
  assert.equal(rej.status, "rejected"); assert.equal(rej.is_final, false); assert.equal(h.ofType("ucd.rejected").at(-1)!.payload.critical_edit_failures, 2);
  const closed = ucdAcceptedGate(h.svc.ucdGateFacts(REFI)); assert.equal(closed.open, false); assert.match(closed.reason!, /rejected with 2 critical-edit failure/);
  assert.equal(EVALUATORS_25_2["25.2.ucdAcceptedGateOpen"]!(h.svc.ucdGateFacts(REFI) as Record<string, unknown>).open, false);
  assert.throws(() => h.svc.assertUcdGateOpen(REFI), (e: unknown) => e instanceof UcdGateClosed && e.code === "FNMA_UCD_ACCEPTED_GATE" && /submitDelivery refused/.test(e.message));
  assert.equal(h.svc.delivery(REFI).ucd_casefile_id, null); assert.equal(h.timer("FNMA_UCD_ACCEPTED_GATE")!.status, "armed");
  // critical edits fixed at the source → regenerate → accepted with zero critical-edit failures
  const u2 = h.svc.generateUcd(REFI, { ucd_submission_id: "UCD-2", du_casefile_id: "DU-1234567" });
  const acc = h.svc.submitUcd(REFI, "UCD-2", { status: "accepted", casefile_id_ucd: "UCD-CF-88213", critical_edit_failures: 0, at: "2026-11-12T15:00:00.000Z" });
  assert.equal(acc.is_final, true); assert.equal(acc.casefile_id_ucd, "UCD-CF-88213"); assert.equal(u2.embedded_cd_disclosure_id, "APP-REFI-1-CD-2");
  assert.deepEqual(EVALUATORS_25_2["25.2.ucdAcceptedGateOpen"]!(h.svc.ucdGateFacts(REFI) as Record<string, unknown>), { open: true });
  h.svc.assertUcdGateOpen(REFI);
  assert.equal(h.svc.delivery(REFI).ucd_casefile_id, "UCD-CF-88213", "copied to deliveries.ucd_casefile_id (29.3/29.4 read)");
  assert.equal(h.timer("FNMA_UCD_ACCEPTED_GATE")!.status, "satisfied", "ucd.accepted{is_final=true}");
});

test("25.2-T11: Given a corrected CD delivered Tue Nov 17 before Loan Delivery on Mon Nov 16 is moved to Wed Nov 18, then `SM_O62_UCD_RESUBMIT_ON_CORRECTION` requires a new accepted UCD by Thu Nov 19 (2 `business_days_fannie_et`) with `embedded_cd_disclosure_id` = v3 and `is_final = true`.", () => {
  assert.equal(ucdResubmitDueDate(D("2026-11-17")), "2026-11-19", "Wed 18 (1), Thu 19 (2) on the Fannie Mae ET calendar");
  const h = harness(); h.schedule(REFI, "2026-11-06", "refinance"); const v1 = h.cdV1(); h.esignAll(v1.disclosure_id, "2026-11-02T16:14:00.000Z");
  h.svc.recordFigureSource({ source_id: "SRC-SA-2", application_id: REFI, party: "settlement_agent", payload: { fees: [{ fee_code: "recording", amount_cents: "4200" }] } }); h.svc.reconcileFigureSources(REFI, fees(4_200n));
  const mk = (id: string, ver: number, issued: string) => { const input = renderInput({ disclosure_id: id, cd_version: ver, dates: { date_issued: D(issued), closing_date: D("2026-11-06"), disbursement_date: D("2026-11-12") } }, h.svc.figureSources(REFI), fees(4_200n)); const { application_id: _a, disclosure_id: _d, cd_version: _v, cd_reason: _r, ...rest } = input; return rest; };
  h.svc.scheduleCorrectedCd(REFI, { disclosure_id: "APP-REFI-1-CD-2", cd_reason: "pre_consummation_no_wait", input: mk("APP-REFI-1-CD-2", 2, "2026-11-05"), gate: { run_id: "RUN-CD-2", apr_verdict: "pass" }, deliveries: [B1, B2].map((c) => ({ consumer_id: c, channel: "esign_portal" as const, at: "2026-11-05T16:00:00.000Z", esign_consent_id: `ESIGN-${c}` })) });
  for (const c of [B1, B2]) h.svc.recordReceipt("APP-REFI-1-CD-2", { consumer_id: c, evidence: "esign_confirmed", at: "2026-11-05T17:00:00.000Z", evidence_document_id: `DOC-ESIGN2-${c}` });
  h.svc.consummate(REFI, { at: "2026-11-06T17:00:00.000Z", requested_on: D("2026-11-06") });
  h.svc.generateUcd(REFI, { ucd_submission_id: "UCD-1", du_casefile_id: "DU-1234567" }); h.svc.submitUcd(REFI, "UCD-1", { status: "accepted", casefile_id_ucd: "UCD-CF-88213", critical_edit_failures: 0, at: "2026-11-12T15:00:00.000Z" });
  h.svc.assertUcdGateOpen(REFI); assert.equal(h.timer("FNMA_UCD_ACCEPTED_GATE")!.status, "satisfied");
  // Loan Delivery planned Mon Nov 16 slips to Wed Nov 18; the recorder's information arrives Nov 16 and the corrected CD v3 is delivered Tue Nov 17 — before delivery and before purchase
  h.svc.recordCorrectionEvent(REFI, { event_on: D("2026-11-16"), info_received_on: D("2026-11-16"), numeric: true, amount_paid_changed: true, in_connection_with_settlement: true, description: "recording fee +$12.00" });
  const r = h.svc.scheduleCorrectedCd(REFI, { disclosure_id: "APP-REFI-1-CD-3", cd_reason: "post_consummation_event", input: mk("APP-REFI-1-CD-3", 3, "2026-11-17"), gate: { run_id: "RUN-CD-3", apr_verdict: "pass" }, deliveries: [B1, B2].map((c) => ({ consumer_id: c, channel: "esign_portal" as const, at: "2026-11-17T16:00:00.000Z", esign_consent_id: `ESIGN-${c}` })) });
  assert.equal(r.row.cd_version, 3); assert.equal(r.corrected_event.payload.post_consummation, true); assert.equal(r.corrected_event.payload.before_purchase, true); assert.equal(r.corrected_event.payload.ucd_resubmit_due, "2026-11-19");
  const resubmit = h.timer("SM_O62_UCD_RESUBMIT_ON_CORRECTION")!; assert.equal(resubmit.status, "armed"); assert.equal(resubmit.anchorDate, "2026-11-17"); assert.equal(resubmit.dueDate, "2026-11-19", "+2 business_days_fannie_et");
  const facts = h.svc.ucdGateFacts(REFI); assert.equal(facts.final_cd_disclosure_id, "APP-REFI-1-CD-3");
  assert.throws(() => h.svc.assertUcdGateOpen(REFI), (e: unknown) => e instanceof UcdGateClosed && /final CD is APP-REFI-1-CD-3 — resubmit/.test(e.message), "the delivery gate re-blocks: the accepted UCD embeds v2, not the version in force");
  assert.equal(h.svc.ucdSubmissions(REFI)[0]!.is_final, true, "until the resubmission, the v2 row is still the last accepted one");
  const u2 = h.svc.generateUcd(REFI, { ucd_submission_id: "UCD-2", du_casefile_id: "DU-1234567" }); assert.equal(u2.embedded_cd_disclosure_id, "APP-REFI-1-CD-3"); assert.equal(u2.embedded_cd_version, 3);
  const acc = h.svc.submitUcd(REFI, "UCD-2", { status: "accepted_with_warnings", casefile_id_ucd: "UCD-CF-88213", critical_edit_failures: 0, feedback_messages: ["warning: LenderCreditsAmount"], at: "2026-11-18T14:00:00.000Z" });
  assert.equal(acc.is_final, true); assert.equal(acc.embedded_cd_disclosure_id, "APP-REFI-1-CD-3"); assert.equal(h.svc.ucdSubmissions(REFI)[0]!.is_final, false, "only one final row");
  assert.equal(h.timer("SM_O62_UCD_RESUBMIT_ON_CORRECTION")!.status, "satisfied", "ucd.accepted{is_final=true} on Wed Nov 18, before the Thu Nov 19 deadline");
  h.svc.assertUcdGateOpen(REFI); h.svc.onLoanDelivered(REFI, D("2026-11-18"));
  // a correction after purchase needs no resubmission (FAQ: 'if the loan has closed, but has not been delivered')
  h.svc.onLoanPurchased(REFI, D("2026-11-25"));
  h.svc.recordCorrectionEvent(REFI, { event_on: D("2026-11-30"), info_received_on: D("2026-11-30"), numeric: false, amount_paid_changed: false, in_connection_with_settlement: false, description: "clerical" });
  const post = h.svc.scheduleCorrectedCd(REFI, { disclosure_id: "APP-REFI-1-CD-4", cd_reason: "clerical", input: mk("APP-REFI-1-CD-4", 4, "2026-12-01"), gate: { run_id: "RUN-CD-4", apr_verdict: "pass" }, deliveries: [B1, B2].map((c) => ({ consumer_id: c, channel: "mail" as const, at: "2026-12-01T20:00:00.000Z", mailing_proof_id: "PMV-2026-12-01-0002" })) });
  assert.equal(post.corrected_event.payload.before_purchase, false); assert.equal(post.corrected_event.payload.ucd_resubmit_due, null); assert.equal(h.timers.byCode("SM_O62_UCD_RESUBMIT_ON_CORRECTION").length, 1, "no second resubmission clock after purchase; the corrected CD is retained in the loan file");
});

test("25.2-T12: Given `cd_consistency_checks` with `CD_NOTE_PI` mismatch (CD $3,402.63 vs note $3,402.62), then 26.1's `generateClosingDocuments` is blocked until the CD is corrected.", () => {
  const h = harness(); h.schedule(REFI, "2026-11-06", "refinance"); h.sources(REFI);
  // a CD rendered with P&I $3,402.63 (the brief's rounding) against the note's $3,402.62
  const wrong = h.svc.prepare({ ...renderInput({ disclosure_id: "APP-REFI-1-CD-1", cd_version: 1, loan: { ...renderInput({ disclosure_id: "x", cd_version: 1 }, []).loan, pi_cents: 340_263n } }, h.svc.figureSources(REFI)), required_consumer_ids: [B1, B2] });
  const note = { CD_NOTE_LOAN_AMOUNT: 56_000_000n, CD_NOTE_RATE: "6.125", CD_NOTE_TERM: 360, CD_NOTE_FIRST_PAYMENT_DATE: "2027-01-01", CD_NOTE_MATURITY_DATE: "2056-12-01", CD_NOTE_PI: 340_262n, CD_NOTE_PREPAY: false, CD_BORROWER_NAMES_VESTING: ["Alex Rivera", "Jordan Rivera"], CD_PROPERTY_ADDRESS: "4821 E Camelback Rd, Phoenix AZ 85018", CD_NMLSR_IDS: { creditor: "123456", mlo: "987654" }, CD_ESCROW_VS_O11_3: { initial: 187_500n, monthly: 52_500n }, CD_CASH_TO_CLOSE_VS_SETTLEMENT_LEDGER: 552_943n };
  const r = h.svc.runCdConsistencyChecks(wrong.disclosure_id, note);
  assert.equal(r.result, "mismatch"); assert.equal(r.blocked.blocked, true); assert.deepEqual(r.blocked.mismatches.map((m) => m.check_code), ["CD_NOTE_PI"]);
  const pi = r.checks.find((c) => c.check_code === "CD_NOTE_PI")!; assert.equal(pi.cd_value, "340263"); assert.equal(pi.note_or_source_value, "340262"); assert.equal(pi.result, "mismatch");
  assert.equal(r.checks.find((c) => c.check_code === "CD_NOTE_LOAN_AMOUNT")!.result, "match"); assert.equal(r.checks.find((c) => c.check_code === "CD_NOTE_FIRST_PAYMENT_DATE")!.result, "match"); assert.equal(r.checks.find((c) => c.check_code === "CD_NOTE_MATURITY_DATE")!.result, "match"); assert.equal(r.checks.find((c) => c.check_code === "CD_MI_VS_CERT")!.result, "n/a", "no MI on the refinance fixture");
  assert.equal(r.checks.length, 16);
  assert.throws(() => assertClosingDocumentsUnblocked(r.checks), (e: unknown) => e instanceof CdRefused && e.code === "CD_CONSISTENCY_MISMATCH" && /generateClosingDocuments blocked — cd_consistency_checks mismatch: CD_NOTE_PI \(CD 340263 vs 340262\)/.test(e.message));
  assert.equal(h.ofType("cd.consistency.checked").at(-1)!.payload.result, "mismatch"); assert.deepEqual(h.ofType("cd.consistency.checked").at(-1)!.payload.mismatches, ["CD_NOTE_PI"]);
  assert.equal(closingDocumentsBlocked(h.svc.consistencyChecks(REFI, 1)).blocked, true);
  // corrected CD with the note's $3,402.62 → match → 26.1 may generate
  h.svc.recordGateRun(wrong.disclosure_id, { run_id: "RUN-CD-1", open: true, apr_verdict: "pass" });
  const fixed = h.svc.prepare({ ...renderInput({ disclosure_id: "APP-REFI-1-CD-2", cd_version: 2 }, h.svc.figureSources(REFI)), required_consumer_ids: [B1, B2], supersedes: wrong.disclosure_id });
  const r2 = h.svc.runCdConsistencyChecks(fixed.disclosure_id, note);
  assert.equal(r2.result, "match"); assert.equal(r2.blocked.blocked, false); assert.doesNotThrow(() => assertClosingDocumentsUnblocked(r2.checks));
  assert.equal(closingDocumentsBlocked(h.svc.consistencyChecks(REFI, 2)).blocked, false);
  assert.equal(runCdConsistencyChecks({ application_id: REFI, cd_version: 2, cd: { CD_NOTE_PI: 340_262n }, source: { CD_NOTE_PI: 340_262n }, now: "2026-11-05T00:00:00.000Z" }).find((c) => c.check_code === "CD_NOTE_PI")!.result, "match");
});

test("25.2-T13: Given three required recipients (two borrowers and a non-borrower spouse on title, refinance), when only two have receipts, then the CD version stays `delivered` (not `received`) and the gate remains closed.", () => {
  const h = harness(); h.schedule(REFI, "2026-11-06", "refinance");
  // the non-borrower spouse is a rescinding consumer (§1026.17(d); 25.3's rescission list) — a required recipient
  const v1 = h.cdV1([B1, B2, SPOUSE]);
  for (const c of [B1, B2, SPOUSE]) h.svc.deliver(v1.disclosure_id, { consumer_id: c, channel: "esign_portal", at: "2026-11-02T16:14:00.000Z", esign_consent_id: `ESIGN-${c}` });
  for (const c of [B1, B2]) h.svc.recordReceipt(v1.disclosure_id, { consumer_id: c, evidence: "esign_confirmed", at: "2026-11-02T18:00:00.000Z", evidence_document_id: `DOC-ESIGN-${c}` });
  assert.equal(h.svc.get(v1.disclosure_id).status, "delivered");
  const wp = h.svc.computeEarliestConsummation(v1.disclosure_id);
  assert.equal(wp.complete, false); assert.deepEqual(wp.missing_consumer_ids, [SPOUSE]); assert.equal(wp.earliest_consummation_date, null); assert.equal(h.svc.get(v1.disclosure_id).earliest_consummation_date, null);
  assert.equal(h.ofType("disclosure.cd.received").length, 2); assert.ok(h.ofType("disclosure.cd.received").every((e) => e.payload.all_required === false));
  assert.equal(h.timer("REGZ_1026_19F1_CD_3SBD_GATE"), undefined, "the gate arms only on disclosure.cd.received{all_required=true}");
  assert.equal(h.ofType("disclosure.cd.waiting_period.computed").length, 0);
  const facts = h.svc.gateFacts(REFI, D("2026-11-06")); assert.equal(facts.receipts_complete, false);
  assert.match(cd3sbdGate(facts).reason!, /not every required consumer has received the Closing Disclosure/);
  assert.throws(() => h.svc.consummate(REFI, { at: "2026-11-06T17:00:00.000Z", requested_on: D("2026-11-06") }), (e: unknown) => e instanceof CdGateClosed);
  assert.throws(() => h.svc.deliver(v1.disclosure_id, { consumer_id: "STRANGER", channel: "mail", at: "2026-11-02T16:14:00.000Z", mailing_proof_id: "PMV-1" }), (e: unknown) => e instanceof CdRefused && e.code === "NOT_A_REQUIRED_CONSUMER");
  // the spouse's courier-signed receipt on Wed Nov 4 completes the set: the gate uses her date
  h.svc.recordReceipt(v1.disclosure_id, { consumer_id: SPOUSE, evidence: "courier_signed", at: "2026-11-04T17:00:00.000Z", evidence_document_id: "DOC-COURIER-1" });
  assert.equal(h.svc.get(v1.disclosure_id).status, "waiting"); assert.equal(h.svc.computeEarliestConsummation(v1.disclosure_id).earliest_consummation_date, "2026-11-07", "two acknowledge Nov 2, one Nov 4 → earliest Sat Nov 7");
  assert.equal(h.timer("REGZ_1026_19F1_CD_3SBD_GATE")!.status, "armed");
  const pure = computeEarliestConsummation([receiptOnDelivery({ receipt_id: "r1", disclosure_id: "d", consumer_id: B1, channel: "in_person", at: "2026-11-02T18:00:00.000Z", time_zone: "America/Phoenix", evidence_document_id: "DOC-SA-RECEIPT" })], [B1, B2]);
  assert.equal(pure.complete, false); assert.deepEqual(pure.missing_consumer_ids, [B2]);
  const mailed = receiptOnDelivery({ receipt_id: "r2", disclosure_id: "d", consumer_id: B2, channel: "mail", at: "2026-11-02T18:00:00.000Z", time_zone: "America/Phoenix" });
  assert.equal(rebutPresumption(mailed, { evidence: "portal_acknowledged", at: "2026-11-06T18:00:00.000Z", time_zone: "America/Phoenix", evidence_document_id: "DOC-P" }).effective_receipt_date, "2026-11-05", "evidence later than the presumed date never extends it");
});

test("25.2-T14: Given any fee item labeled \"CD preparation fee\" or \"disclosure delivery fee\", then `renderCd` fails validation ((f)(5)).", () => {
  const h = harness(); h.schedule(REFI, "2026-11-06", "refinance"); const src = h.sources(REFI);
  for (const label of ["CD preparation fee", "Disclosure delivery fee", "Closing Disclosure prep fee"]) {
    const bad = fees(3_000n, [{ fee_code: "doc_fee_x", description: label, amount_cents: 2_500n, section: "A_origination", tolerance_class: "zero" }]);
    assert.match(label, PROHIBITED_CD_FEE); assert.equal(validateCdFees(bad).length, 1);
    assert.throws(() => renderCd(renderInput({ disclosure_id: "APP-REFI-1-CD-1", cd_version: 1 }, src, bad)), (e: unknown) => e instanceof CdRefused && e.code === "F5_CD_FEE" && e.citation === "§1026.19(f)(5)" && e.message.includes(label));
    assert.throws(() => h.svc.prepare({ ...renderInput({ disclosure_id: "APP-REFI-1-CD-1", cd_version: 1 }, src, bad), required_consumer_ids: [B1] }), (e: unknown) => e instanceof CdRefused && e.code === "F5_CD_FEE");
  }
  assert.equal(validateCdFees([{ fee_code: "cd_preparation_fee", description: "Document fee", amount_cents: 2_500n }]).length, 1, "the fee code itself names the prohibited charge");
  assert.equal(h.ofType("disclosure.cd.prepared").length, 0, "nothing was prepared");
  const ok = renderCd(renderInput({ disclosure_id: "APP-REFI-1-CD-1", cd_version: 1 }, src));
  assert.equal(ok.notice_code, "NTC_REGZ_1026_38_CD"); assert.ok(ok.checklist.every((c) => c.ok)); assert.equal(ok.checklist.find((c) => c.item === "no_cd_fee")!.ok, true);
  assert.deepEqual(ok.checklist.map((c) => c.item), ["closing_information", "transaction_information", "loan_terms", "projected_payments", "costs_at_closing", "loan_costs_other_costs", "calculating_cash_to_close", "payoffs_and_payments", "loan_disclosures_escrow", "ap_air_tables", "loan_calculations", "other_disclosures", "questions", "contact_information", "confirm_receipt", "no_cd_fee", "figures_from_versioned_sources"]);
  assert.equal(ok.h25.escrowed_property_costs_year1_cents, 630_000n); assert.equal(ok.h25.apr, "6.159"); assert.equal(ok.h25.tip_pct, "119.059");
  // figures never typed: an unreconciled figure source fails the render too
  const stale = [{ ...src[0]!, reconciled: false }];
  assert.throws(() => renderCd(renderInput({ disclosure_id: "APP-REFI-1-CD-1", cd_version: 1 }, stale)), (e: unknown) => e instanceof CdRefused && e.code === "FIGURES_UNRECONCILED");
});

test("25.2 worked figures: recording fee +$12.00 (worked examples 6–7); loan calculations (o) on the refinance fixture — amount financed $556,150.00 and finance charge $668,793.20 as the spec states them from an unrounded prepaid interest of $1,785.48 (PFC $3,850.00), against 25.1's engine figures $556,150.05 / $668,793.15 from the 26.3 rounded per diem ($1,785.43, PFC $3,849.95); APR 6.159%, TIP 119.059%, P&I $3,402.62, total of payments $1,224,943.20; the (l)(7) escrow figures $525.00 / $1,875.00 / $6,300.00", () => {
  // worked examples 6 and 7: the recording fee rises from $30.00 to $42.00 — the +$12.00 delta is 1,200 cents in both the pre- and post-consummation variants
  const delta = fees(4_200n).find((f) => f.fee_code === "recording")!.amount_cents - fees(3_000n).find((f) => f.fee_code === "recording")!.amount_cents;
  assert.equal(delta, 1_200n); assert.equal(fees(4_200n).find((f) => f.fee_code === "recording")!.amount_cents, 4_200n);
  // the spec's loan-calculation figures arise from the unrounded prepaid interest (19 × $93.9726… = $1,785.48 → PFC $3,850.00): amount financed $556,150.00 and finance charge $668,793.20
  const specApr = computeApr({ loan_amount_cents: 56_000_000n, note_rate_pct: "6.125", term_months: 360, term_start_date: D("2026-11-12"), first_payment_date: D("2027-01-01"), prepaid_finance_charges_cents: 385_000n, prepaid_interest_cents: 178_548n, method: "appendix_j_exact", checkpoint: "cd" });
  assert.equal(specApr.amount_financed_cents, 55_615_000n, "$556,150.00 = $560,000.00 − $3,850.00");
  assert.equal(specApr.total_of_payments_cents, 122_494_320n, "$1,224,943.20 = 360 × $3,402.62");
  assert.equal(specApr.finance_charge_cents, 66_879_320n, "$668,793.20 = total of payments − amount financed");
  assert.equal(specApr.apr_disclosed_str, "6.159"); assert.equal(specApr.tip_pct.toFixed(3), "119.059"); assert.equal(specApr.pi_cents, 340_262n);
  // discrepancy (25.1 / 26.3 convention `365_rounded_per_diem`): the engine's CD figures are $556,150.05 and $668,793.15 — the per diem is rounded to the cent before multiplying ($93.97 × 19 = $1,785.43)
  assert.equal(APR_V1.prepaid_interest_cents, 178_543n); assert.equal(APR_V1.amount_financed_cents, 55_615_005n); assert.equal(APR_V1.finance_charge_cents, 66_879_315n); assert.equal(APR_V1.total_of_payments_cents, 122_494_320n);
  assert.equal(APR_V1.apr_disclosed_str, "6.159", "the five-cent difference does not move the disclosed APR"); assert.equal(APR_V1.tip_pct.toFixed(3), "119.059");
  assert.equal(aprAccuracyTest({ disclosed_apr: specApr.apr_disclosed_str, actual_apr: APR_V1.apr_disclosed_str, transaction: { irregular_first_period: true }, disclosed_finance_charge_cents: specApr.finance_charge_cents, actual_finance_charge_cents: APR_V1.finance_charge_cents }).result, "pass", "a CD carrying the spec's figures is accurate under §1026.22 / §1026.38(o)(2) (overstated by $0.05)");
  // the (l)(7) escrow figures come from 30.3's initial analysis: monthly $525.00, initial escrow payment $1,875.00, escrowed property costs over year 1 = 12 × $525.00 = $6,300.00
  const h = harness(); h.schedule(REFI, "2026-11-06", "refinance"); const src = h.sources(REFI);
  const render = renderCd(renderInput({ disclosure_id: "APP-REFI-1-CD-1", cd_version: 1 }, src));
  assert.equal(render.h25.escrow_cents, 52_500n); assert.equal(render.h25.initial_escrow_payment_cents, 187_500n); assert.equal(render.h25.escrowed_property_costs_year1_cents, 630_000n);
  assert.equal(render.h25.pi_cents, 340_262n); assert.equal(render.h25.finance_charge_cents, 66_879_315n); assert.equal(render.h25.amount_financed_cents, 55_615_005n); assert.equal(render.h25.total_of_payments_cents, 122_494_320n);
  assert.equal(render.checklist.find((c) => c.item === "loan_disclosures_escrow")!.note, "escrowed costs year 1 = 12 × 52500");
  assert.throws(() => renderCd(renderInput({ disclosure_id: "APP-REFI-1-CD-1", cd_version: 1, escrow: { established: true, monthly_escrow_cents: 52_500n, initial_escrow_payment_cents: 187_500n, escrowed_costs_year1_cents: 620_000n, non_escrowed_costs_year1_cents: 0n } }, src)), (e: unknown) => e instanceof CdRefused && e.code === "H25_CONTENT" && /loan_disclosures_escrow/.test(e.message), "an escrowed-costs figure that is not 12 × monthly fails the (l)(7) checklist");
  // the mailbox presumption is symmetric: mailed Mon Nov 2 → presumed Thu Nov 5 → earliest Mon Nov 9 (worked example 2)
  assert.equal(presumedReceiptDate(D("2026-11-02")), "2026-11-05"); assert.equal(earliestConsummationDate(presumedReceiptDate(D("2026-11-02"))), "2026-11-09");
});
