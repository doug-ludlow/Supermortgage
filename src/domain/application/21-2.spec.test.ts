// 21.2 TRID application receipt, application date, and the Loan Estimate
// spec/sections/21-application-urla-initial-disclosures-intent-to-proceed-rate/21-2-trid-application-receipt-application-date-and-the-loan-estim.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, addDays, type PlainDate } from "../../kernel/calendar/date.ts";
import { regzSpecific, addBusinessDays } from "../../kernel/calendar/business.ts";
import { Decimal } from "../../kernel/money/index.ts";
import { MemoryEventStore, FixedClock, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { EscalationService } from "../../app/escalations.ts";
import { assertGate, evaluateGate, GateClosed } from "../../app/evaluators.ts";
import { CommandBus, type CommandSpec } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EntityStore, toolCommand, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { TOOLS_21_2 } from "../../app/tools/section21-2.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { PRELE_ESTIMATE_STATEMENT } from "../../notices/authored/section21-2.ts";
import { LoanEstimateService, LeRefused, LeGateClosed, PHOENIX_CREDITOR, COLUMBUS_CREDITOR, leDueAt, deemedReceiptDate, earliestConsummationDate, latestLeIssueDateFor, le7sbdGate, closingCostsExpireAt, receiptDetermination, deriveToleranceClass, tenPercentAggregate, sectionTotals, prepaidInterest, perDiemInterest, amortize, loanEstimateCalcs, computeApr, netPrepaidFinanceCharge, buildProviderList, mloReviewSlaDueAt, type FeeItemInput, type LeRenderInput, type EsignConsent, type CreditorCalendarSpec } from "./ops-21-2.ts";

const INTAKE: Actor = { kind: "agent", id: "intake" };
const DISCLOSURE: Actor = { kind: "agent", id: "disclosure" };
/** Refinance fixture (Phoenix, AZ): loan $560,000, 30-year fixed 6.125%, fees assembled Oct 5, 2026 (worked example 1). */
const AS_OF = D("2026-10-05");
const fee = (fee_code: string, description: string, le_section: FeeItemInput["le_section"], mismo_fee_type: string, amount_cents: bigint, provider_source: FeeItemInput["provider_source"], shoppable: boolean, estimate_source: FeeItemInput["estimate_source"], estimate_source_ref: string, finance_charge: boolean, extra: Partial<FeeItemInput> = {}): FeeItemInput =>
  ({ fee_code, description, le_section, mismo_fee_type, amount_cents, provider_source, shoppable, estimate_source, estimate_source_ref, estimated_at: AS_OF, finance_charge, ...extra });
const FEES: FeeItemInput[] = [
  fee("appraisal", "Appraisal Fee to AMC", "B_cannot_shop", "AppraisalFee", 65_000n, "creditor_selected_third_party", false, "vendor_quote", "AMC-Q-88121", false),
  fee("credit_report", "Credit Report Fee", "B_cannot_shop", "CreditReportFee", 7_500n, "creditor_selected_third_party", false, "fee_schedule", "N2-price-list-2026-09", false),
  fee("flood_cert", "Flood Determination Fee", "B_cannot_shop", "FloodCertification", 1_200n, "creditor_selected_third_party", false, "fee_schedule", "N6-flood-2026-09", false),
  fee("tax_service", "Tax Service Fee", "B_cannot_shop", "TaxServiceFee", 8_500n, "creditor_selected_third_party", false, "fee_schedule", "tax-svc-2026-09", true),
  fee("title_lenders_policy", "Title – Lender's Title Policy", "C_can_shop", "TitleLendersCoveragePremium", 115_000n, "list_provider", true, "vendor_quote", "N7-rate-engine-2026-10-05", false),
  fee("title_settlement", "Title – Settlement Agent Fee", "C_can_shop", "TitleSettlementAgentFee", 49_500n, "list_provider", true, "vendor_quote", "N7-rate-engine-2026-10-05", false),
  fee("title_endorsements", "Title – Endorsements", "C_can_shop", "TitleEndorsementFee", 15_000n, "list_provider", true, "vendor_quote", "N7-rate-engine-2026-10-05", false),
  fee("recording", "Recording Fees", "E_taxes_gov", "RecordingFeeForMortgage", 7_000n, "government", false, "county_table", "maricopa-recording-2026", false),
  fee("transfer_tax", "Transfer Taxes", "E_taxes_gov", "TransferTaxes", 0n, "government", false, "county_table", "az-no-transfer-tax", false),
  fee("prepaid_interest", "Prepaid Interest ($93.97 per day for 19 days @ 6.125%)", "F_prepaids", "PrepaidInterest", 178_543n, "creditor", false, "pricing_engine", "disbursement-2026-11-12", true),
  fee("hoi_premium", "Homeowner's Insurance Premium", "F_prepaids", "HomeownersInsurancePremium", 0n, "none", false, "insurance_policy", "policy-in-force", false),
  fee("property_taxes_prepaid", "Property Taxes", "F_prepaids", "PropertyTaxes", 0n, "government", false, "tax_bill", "maricopa-2026", false),
  fee("escrow_taxes", "Property Taxes $400.00 per month for 3 mo.", "G_initial_escrow", "PropertyTaxes", 120_000n, "none", false, "tax_bill", "maricopa-2026", false),
  fee("escrow_hoi", "Homeowner's Insurance $150.00 per month for 3 mo.", "G_initial_escrow", "HomeownersInsurance", 45_000n, "none", false, "insurance_policy", "policy-in-force", false),
  fee("lender_credit", "Lender Credits", "J_lender_credit", "LenderCredit", -261_700n, "creditor", false, "pricing_engine", "Q-20-4-0001", false),
];
const PROVIDERS = { title_lenders_policy: [{ party_id: "P-GCT", name: "Grand Canyon Title Agency", affiliate: false, estimated_fee_cents: 115_000n }], title_settlement: [{ party_id: "P-GCT", name: "Grand Canyon Title Agency", affiliate: false, estimated_fee_cents: 49_500n }], title_endorsements: [{ party_id: "P-GCT", name: "Grand Canyon Title Agency", affiliate: false, estimated_fee_cents: 15_000n }] };
const PRICING = { quote_id: "Q-20-4-0001", rate_pct: "6.125", price: "100.000", points_cents: 0n, lender_credit_cents: 261_700n, locked: false };
const CREDITOR = { name: "Partner Bank, N.A.", nmlsr_id: "123456", email: "loans@partnerbank.example", phone: "(800) 555-0155" };
const MLO = { name: "Jordan Rivera", nmlsr_id: "987654" };
const renderInput = (application_id: string, disclosure_id: string, over: Partial<LeRenderInput> = {}): LeRenderInput => ({ application_id, disclosure_id, as_of: AS_OF, loan_cents: 56_000_000n, term_months: 360, transaction_type: "limited_cash_out", product: "Fixed Rate", pricing: PRICING, fees: FEES, applicants: ["Alex Borrower"], property_address: "4210 E Camelback Rd, Phoenix, AZ 85018", estimated_value_cents: 82_000_000n, creditor: CREDITOR, loan_officer: MLO, providers: PROVIDERS, ...over });
const CONSENT: EsignConsent = { id: "CNS-ESIGN-1", scope: ["disclosures", "notices"], granted_at: "2026-10-05T17:20:00.000Z" };   // Oct 5 10:20 MST (20.3)
const MST = (date: string, hhmm: string): string => new Date(`${date}T${hhmm}:00-07:00`).toISOString();

/** The 21.2 lifecycle on the event store: `LoanEstimateService` (the process's command surface), the EscalationService the MLO review rides on, and the TimerEngine arming the 21.2 rows (REGZ_1026_19E1_LE_3BD's owning registry row is 20.3's, so that process is in the filter too). */
function harness(nowIso: string, calendar: CreditorCalendarSpec = PHOENIX_CREDITOR) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["21.2", "20.3"] });
  const escalations = new EscalationService(events, clock);
  const svc = new LoanEstimateService({ events, clock, escalations, calendar });
  const tridReceived = (applicationId: string, atIso: string) => { clock.set(atIso); const a = svc.onTridReceived(applicationId, atIso); events.append({ type: "application.trid_received", applicationId, actor: INTAKE, occurredAt: atIso, payload: { application_id: applicationId, trid_received_at: atIso, trid_application_date: a.trid_application_date, six_items: ["name", "income", "ssn", "property_address", "property_value_estimate", "loan_amount_sought"] } }); return a; };
  const approved = (applicationId: string, disclosureId: string, over: Partial<LeRenderInput> = {}) => { const r = svc.render(renderInput(applicationId, disclosureId, over)); svc.openMloReview(disclosureId); svc.mloDecision(disclosureId, { review_id: `MR-${disclosureId}`, decision: "approved", data_hash: r.data_hash, nmlsr_id: MLO.nmlsr_id }); return r; };
  const emitted = (type: string) => events.all().filter((e) => e.type === type);
  const timer = (code: string) => timers.byCode(code).at(-1)!;
  return { clock, events, timers, escalations, svc, tridReceived, approved, emitted, timer };
}
const toolKey = (process: string, name: string): string => `${process} ${name}`;
function bind21_2(rt: ToolRuntime, agents: AgentRegistry): Map<string, CommandSpec<ToolInput, unknown>> {
  const escalates = new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
  const out = new Map<string, CommandSpec<ToolInput, unknown>>();
  for (const d of TOOLS_21_2) { const cmd = toolCommand(d, rt, escalates.get(d.process) ?? []); agents.registerTool(d.agent, cmd.name); out.set(toolKey(d.process, d.name), cmd); }
  return out;
}

test("21.2-T1: Given `trid_received_at` = Mon Oct 5, 2026 10:41 MST and calendar `creditor` (Mon–Fri, closed Oct 12), when the timer is created, then `le_due_at` = Thu Oct 8, 2026 23:59 MST; delivery on Fri Oct 9 → breach recorded (sev 1) and the LE still issues.", () => {
  const h = harness(MST("2026-10-05", "10:41"));
  const a = h.tridReceived("APP-T1", MST("2026-10-05", "10:41"));
  assert.equal(a.trid_application_date, "2026-10-05"); assert.equal(a.le_due_on, "2026-10-08"); assert.equal(a.le_due_at, MST("2026-10-08", "23:59"));   // Thu Oct 8, 2026 23:59 MST
  assert.equal(new Date(a.le_due_at).toISOString(), "2026-10-09T06:59:00.000Z");
  const t = h.timer("REGZ_1026_19E1_LE_3BD"); assert.equal(t.status, "armed"); assert.equal(t.anchorDate, "2026-10-05"); assert.equal(t.dueDate, "2026-10-08"); assert.equal(t.applicationId, "APP-T1");
  // Friday Oct 9: the clock passed with no delivery — breach recorded, sev 1 to compliance-sentinel + the partner officer, incident record; the LE still issues
  h.clock.set(MST("2026-10-09", "09:00"));
  const breaches = h.timers.evaluate(h.clock.now()); assert.deepEqual(breaches.map((b) => b.instance.code), ["REGZ_1026_19E1_LE_3BD"]); assert.equal(t.status, "breached");
  const b = h.svc.onLeDeadlineBreached("APP-T1", h.clock.now()); assert.equal(b.severity, 1); assert.deepEqual([...b.escalated_to], ["compliance-sentinel", "officer"]);
  const sev1 = h.escalations.list().find((e) => e.kind === "sev1")!; assert.equal(sev1.severity, "1"); assert.equal(sev1.applicationId, "APP-T1"); assert.equal(sev1.payload.root_cause_required, true);
  assert.equal(h.emitted("compliance.incident.opened").length, 1);
  h.approved("APP-T1", "LE-T1", { as_of: D("2026-10-09") });
  const row = h.svc.deliver("LE-T1", { channel: "esign_portal", consent: CONSENT });
  assert.equal(row.status, "delivered"); assert.equal(row.issued_on, "2026-10-09"); assert.equal(row.breach?.incident_id, "INC-LE3BD-APP-T1");
  assert.equal(t.status, "satisfied_late"); assert.equal(h.emitted("disclosure.le.issued").length, 1); assert.equal(h.emitted("disclosure.le.delivered")[0]!.payload.channel, "esign_portal");
});
test("21.2-T2: Given `trid_received_at` = Thu Oct 8, 2026 with the same calendar, then `le_due_at` = Wed Oct 14; with `creditor_calendars.saturday_open=true` → Tue Oct 13; with Columbus Day open → Tue Oct 13.", () => {
  const thu = D("2026-10-08");
  const base = leDueAt(thu, PHOENIX_CREDITOR); assert.equal(base.due_on, "2026-10-14"); assert.equal(base.due_at, MST("2026-10-14", "23:59"));   // Fri 9, (Sat/Sun off, Mon Oct 12 Columbus Day closed), Tue 13, Wed 14
  assert.equal(leDueAt(thu, { ...PHOENIX_CREDITOR, saturday_open: true }).due_on, "2026-10-13");                       // Fri 9, Sat 10, Tue 13
  assert.equal(leDueAt(thu, { ...PHOENIX_CREDITOR, open_on_holidays: [D("2026-10-12")] }).due_on, "2026-10-13");      // Fri 9, Mon 12, Tue 13
  // the Timer Engine derives the same date from the event: the assumption is data, not code
  const h = harness(MST("2026-10-08", "09:00")); h.tridReceived("APP-T2", MST("2026-10-08", "09:00"));
  assert.equal(h.timer("REGZ_1026_19E1_LE_3BD").dueDate, "2026-10-14");
  // edge case: six items at 23:50 on a creditor business day stay on that day in the creditor's zone (the ET civil date would already be the next day)
  const late = harness(MST("2026-10-08", "23:50")); assert.equal(late.tridReceived("APP-T2b", MST("2026-10-08", "23:50")).trid_application_date, "2026-10-08"); assert.equal(late.timer("REGZ_1026_19E1_LE_3BD").anchorDate, "2026-10-08");
});
test("21.2-T3: Given the LE is delivered via e-sign portal Mon Oct 5 16:10 with a consent dated Oct 5 10:20 and an authenticated view at 17:42, then `received_at` = Oct 5 and `effective_receipt_date` = 2026-10-05; with no view event, `deemed_receipt_date` = Thu Oct 8 and `effective_receipt_date` = 2026-10-08.", () => {
  const h = harness(MST("2026-10-05", "10:41")); h.tridReceived("APP-T3", MST("2026-10-05", "10:41")); h.approved("APP-T3", "LE-T3");
  h.clock.set(MST("2026-10-05", "16:10"));
  const row = h.svc.deliver("LE-T3", { channel: "esign_portal", consent: CONSENT });
  assert.equal(row.esign_consent_id, "CNS-ESIGN-1"); assert.equal(row.issued_on, "2026-10-05"); assert.equal(row.deemed_receipt_date, "2026-10-08"); assert.equal(row.effective_receipt_date, null);
  const mailbox = h.timer("REGZ_1026_19E1IV_LE_MAILBOX_3SBD"); assert.equal(mailbox.status, "armed"); assert.equal(mailbox.anchorDate, "2026-10-05"); assert.equal(mailbox.dueDate, "2026-10-08");
  h.svc.recordReceipt("LE-T3", { kind: "authenticated_view", at: MST("2026-10-05", "17:42"), borrower_id: "B-1" });
  const r = h.svc.get("LE-T3"); assert.equal(r.received_at, MST("2026-10-05", "17:42")); assert.equal(r.receipt_evidence, "esign_confirmed"); assert.equal(r.effective_receipt_date, "2026-10-05"); assert.equal(r.status, "received");
  assert.equal(h.emitted("disclosure.le.received")[0]!.payload.received_on, "2026-10-05"); assert.equal(mailbox.status, "satisfied");
  // no view event: the mailbox presumption sets the deemed date on the third specific business day (Tue 6, Wed 7, Thu 8)
  const g = harness(MST("2026-10-05", "10:41")); g.tridReceived("APP-T3b", MST("2026-10-05", "10:41")); g.approved("APP-T3b", "LE-T3b"); g.clock.set(MST("2026-10-05", "16:10"));
  const row2 = g.svc.deliver("LE-T3b", { channel: "esign_portal", consent: CONSENT });
  assert.equal(row2.deemed_receipt_date, "2026-10-08"); assert.equal(g.svc.deemReceived("LE-T3b", D("2026-10-07")).receipt_evidence, null, "not yet deemed on Oct 7");
  const deemed = g.svc.deemReceived("LE-T3b", D("2026-10-08")); assert.equal(deemed.receipt_evidence, "mailbox_rule"); assert.equal(deemed.effective_receipt_date, "2026-10-08"); assert.equal(deemed.status, "deemed_received"); assert.equal(deemed.received_at, null);
  assert.equal(g.emitted("disclosure.le.deemed_received")[0]!.payload.deemed_receipt_date, "2026-10-08"); assert.equal(g.timer("REGZ_1026_19E1IV_LE_MAILBOX_3SBD").status, "satisfied");
  assert.deepEqual(receiptDetermination({ channel: "email", issued_on: D("2026-10-05"), evidence_at: null, time_zone: "America/Phoenix" }).effective_receipt_date, "2026-10-08", "e-mail is not in person");
});
test("21.2-T4: Given the LE is mailed Wed Oct 14, 2026, then `deemed_receipt_date` = Sat Oct 17 and `earliest_consummation_date` = Thu Oct 22; a consummation request for Wed Oct 21 is refused by `assertGateOpen`.", () => {
  const h = harness(MST("2026-10-08", "09:00")); h.tridReceived("APP-T4", MST("2026-10-08", "09:00")); h.approved("APP-T4", "LE-T4", { as_of: D("2026-10-14") });
  h.clock.set(MST("2026-10-14", "15:00"));
  const row = h.svc.deliver("LE-T4", { channel: "mail", mailing_proof_id: "PMV-2026-10-14-0091" });
  assert.equal(row.status, "mailed"); assert.equal(row.mailed_at, MST("2026-10-14", "15:00")); assert.equal(row.deemed_receipt_date, "2026-10-17");   // Thu 15, Fri 16, Sat 17 — Saturdays count under the specific definition
  assert.equal(row.earliest_consummation_date, "2026-10-22");                                                                                            // 15, 16, 17, 19, 20, 21, 22 — Sun 18 excluded
  assert.equal(deemedReceiptDate(D("2026-10-14")), "2026-10-17"); assert.equal(earliestConsummationDate(D("2026-10-14")), "2026-10-22");
  assert.throws(() => h.svc.assertGateOpen("APP-T4", D("2026-10-21")), (e: unknown) => e instanceof LeGateClosed && e.code === "REGZ_1026_19E1III_LE_7SBD_GATE" && /precedes the earliest permitted date 2026-10-22/.test(e.reason));
  h.svc.assertGateOpen("APP-T4", D("2026-10-22"));
  // the registry gate is evaluator-backed: 26.x / 25.2 assert it through the app evaluator with the same facts
  const gate = h.timer("REGZ_1026_19E1III_LE_7SBD_GATE"); assert.equal(gate.status, "armed"); assert.equal(gate.note, "evaluator:21.2.le7sbdGateOpen"); assert.equal(gate.anchorDate, "2026-10-14");
  assert.throws(() => assertGate("21.2.le7sbdGateOpen", { ...h.svc.gateFacts("APP-T4", D("2026-10-21")) }), GateClosed);
  assert.equal(evaluateGate("21.2.le7sbdGateOpen", { ...h.svc.gateFacts("APP-T4", D("2026-10-22")) }).open, true);
  assert.equal(h.emitted("disclosure.le.mailed")[0]!.payload.mailing_proof_id, "PMV-2026-10-14-0091"); assert.equal(h.timer("REGZ_1026_19E1_LE_3BD").status, "satisfied");
  assert.equal(h.svc.openGateIfDue("LE-T4", D("2026-10-21")), false); assert.equal(h.svc.openGateIfDue("LE-T4", D("2026-10-22")), true); assert.equal(gate.status, "satisfied");
});
test("21.2-T5: Given the LE is delivered Mon Oct 5, then `earliest_consummation_date` = Wed Oct 14, 2026 (Sun Oct 11 and Mon Oct 12 excluded; Sat Oct 10 counts); a signed bona fide emergency statement recorded Oct 8 opens the gate immediately.", () => {
  const h = harness(MST("2026-10-05", "10:41")); h.tridReceived("APP-T5", MST("2026-10-05", "10:41")); h.approved("APP-T5", "LE-T5"); h.clock.set(MST("2026-10-05", "16:10"));
  const row = h.svc.deliver("LE-T5", { channel: "esign_portal", consent: CONSENT });
  assert.equal(row.earliest_consummation_date, "2026-10-14");
  // Tue 6 = 1, Wed 7 = 2, Thu 8 = 3, Fri 9 = 4, Sat 10 = 5, Sun 11 and Mon 12 excluded, Tue 13 = 6, Wed 14 = 7
  assert.equal(regzSpecific.isBusinessDay(D("2026-10-10")), true); assert.equal(regzSpecific.isBusinessDay(D("2026-10-11")), false); assert.equal(regzSpecific.isBusinessDay(D("2026-10-12")), false);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((n) => addBusinessDays(D("2026-10-05"), n, regzSpecific)), ["2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-13", "2026-10-14"]);
  assert.throws(() => h.svc.assertGateOpen("APP-T5", D("2026-10-08")), LeGateClosed);
  h.clock.set(MST("2026-10-08", "11:00"));
  assert.throws(() => h.svc.recordEmergencyWaiver("LE-T5", { consent_id: "CNS-W-1", signed_on: D("2026-10-08"), all_consumers_signed: true, printed_form: true, statement: "…" }), (e: unknown) => e instanceof LeRefused && e.code === "PRINTED_FORM");
  h.svc.recordEmergencyWaiver("LE-T5", { consent_id: "CNS-W-1", signed_on: D("2026-10-08"), all_consumers_signed: true, printed_form: false, statement: "I need to close by Oct 9 to avoid losing my job relocation allowance." });
  h.svc.assertGateOpen("APP-T5", D("2026-10-08"));
  const opened = h.emitted("gate.le_7sbd.opened")[0]!; assert.equal(opened.payload.waived, true); assert.equal(opened.payload.consent_kind, "trid_7day_waiver"); assert.equal(opened.payload.earliest_consummation_date, "2026-10-14");
  assert.equal(h.timer("REGZ_1026_19E1III_LE_7SBD_GATE").status, "satisfied");
  assert.equal(le7sbdGate({ earliest_consummation_date: "2026-10-14", requested_on: "2026-10-08", waiver_recorded_on: "2026-10-08" }).open, true);
});
test("21.2-T6: Given no unrevoked E-SIGN consent scoped to disclosures, when the agent calls `deliver(channel='esign_portal')`, then the call is refused, the print channel is used the same day, and the decision record shows the reason.", () => {
  const h = harness(MST("2026-10-05", "10:41")); h.tridReceived("APP-T6", MST("2026-10-05", "10:41")); h.approved("APP-T6", "LE-T6"); h.clock.set(MST("2026-10-05", "16:10"));
  assert.throws(() => h.svc.deliver("LE-T6", { channel: "esign_portal", consent: null }), (e: unknown) => e instanceof LeRefused && e.code === "NO_ESIGN_CONSENT");
  assert.throws(() => h.svc.deliver("LE-T6", { channel: "esign_portal", consent: { ...CONSENT, revoked_at: MST("2026-10-05", "12:00") } }), (e: unknown) => e instanceof LeRefused && e.code === "NO_ESIGN_CONSENT" && /revoked/.test(e.message));
  assert.throws(() => h.svc.deliver("LE-T6", { channel: "esign_portal", consent: { ...CONSENT, scope: ["notices"] } }), (e: unknown) => e instanceof LeRefused && /not scoped to disclosures/.test((e as Error).message));
  assert.equal(h.svc.get("LE-T6").issued_on, null); assert.equal(h.emitted("disclosure.le.delivery.refused").length, 3);
  const row = h.svc.deliver("LE-T6", { channel: "mail", mailing_proof_id: "PMV-2026-10-05-0007" });
  assert.equal(row.status, "mailed"); assert.equal(row.issued_on, "2026-10-05"); assert.equal(row.esign_consent_id, null); assert.equal(row.deemed_receipt_date, "2026-10-08");
  const rec = h.svc.decisionRecord("LE-T6", { model_version: "m-2026.09", prompt_version: "p-21.2-v3", rationale: "no valid E-SIGN consent for disclosures — print channel same day" }) as { delivery: { channel: string; refusals: { channel: string; reason: string }[] } };
  assert.equal(rec.delivery.channel, "mail"); assert.equal(rec.delivery.refusals[0]!.channel, "esign_portal"); assert.match(rec.delivery.refusals[0]!.reason, /no E-SIGN consent on file for the disclosures class/);
  assert.equal(h.timer("REGZ_1026_19E1_LE_3BD").status, "satisfied");
});
test("21.2-T7: Given the refinance fee set above, when `fee.baseline.set` fires, then B items carry `zero`, C items `ten_percent` with an aggregate baseline of $1,865 including recording, F/G items `unlimited`, and the $2,617 lender credit `zero`.", () => {
  const h = harness(MST("2026-10-05", "10:41")); h.tridReceived("APP-T7", MST("2026-10-05", "10:41")); h.approved("APP-T7", "LE-T7"); h.clock.set(MST("2026-10-05", "16:10"));
  h.svc.deliver("LE-T7", { channel: "esign_portal", consent: CONSENT });
  const ev = h.emitted("fee.baseline.set")[0]!; assert.equal(ev.applicationId, "APP-T7"); assert.equal(ev.payload.disclosure_id, "LE-T7");
  const items = ev.payload.items as { fee_code: string; le_section: string; tolerance_class: string; baseline_amount_cents: string }[];
  const cls = (code: string) => items.find((i) => i.fee_code === code)!.tolerance_class;
  for (const b of ["appraisal", "credit_report", "flood_cert", "tax_service"]) assert.equal(cls(b), "zero", b);
  for (const c of ["title_lenders_policy", "title_settlement", "title_endorsements"]) assert.equal(cls(c), "ten_percent", c);
  assert.equal(cls("recording"), "ten_percent"); assert.equal(cls("transfer_tax"), "zero");
  for (const u of ["prepaid_interest", "hoi_premium", "property_taxes_prepaid", "escrow_taxes", "escrow_hoi"]) assert.equal(cls(u), "unlimited", u);
  assert.equal(cls("lender_credit"), "zero"); assert.equal(items.find((i) => i.fee_code === "lender_credit")!.baseline_amount_cents, "-261700");
  assert.equal(ev.payload.ten_percent_baseline_cents, "186500");   // $1,865 = $1,795 (C) + $70 (recording)
  assert.equal(ev.payload.lender_credit_baseline_cents, "-261700");
  const row = h.svc.get("LE-T7"); assert.equal(tenPercentAggregate(row.fees), 186_500n); assert.ok(row.fees.every((f) => f.baseline_disclosure_id === "LE-T7" && f.baseline_amount_cents === f.amount_cents));
  // rule 4 branches the fixture does not exercise
  const c = FEES.find((f) => f.fee_code === "title_settlement")!;
  assert.equal(deriveToleranceClass({ ...c, provider_source: "affiliate" }), "zero"); assert.equal(deriveToleranceClass({ ...c, provider_source: "consumer_selected_off_list" }), "unlimited");
  assert.equal(deriveToleranceClass({ ...c, le_section: "H_other", required_by_creditor: false }), "unlimited"); assert.equal(deriveToleranceClass({ ...c, le_section: "H_other", required_by_creditor: true, shoppable: false }), "zero");
  assert.equal(deriveToleranceClass({ ...c, le_section: "A_origination" }), "zero");
});
test("21.2-T8: Given loan $560,000 at 6.125 % for 360 months, when the engine computes, then P&I = $3,402.62, TIP = 118.740 %, In-5-Years total = $206,774.20 with loan costs $2,617, principal paid $38,097.13.", async () => {
  const c = loanEstimateCalcs({ loan_cents: 56_000_000n, rate_pct: "6.125", term_months: 360, loan_costs_cents: 261_700n });
  assert.equal(c.pi_cents, 340_262n);                 // 560,000 × 0.0051041667 ÷ (1 − 1.0051041667⁻³⁶⁰) = 3,402.619… → $3,402.62 (the fixture's $3,402.63 is off by one cent — blueprint discrepancy 5)
  assert.equal(c.tip_pct, "118.740");                 // 664,942.20 ÷ 560,000
  assert.equal(c.in_5y_total_cents, 20_677_420n);     // 60 × 3,402.62 = 204,157.20 + loan costs 2,617
  assert.equal(c.in_5y_principal_cents, 3_809_713n);  // 560,000 − 521,902.87
  assert.equal(c.balance_after_60_cents, 52_190_287n);
  assert.equal(computeApr({ loan_cents: 56_000_000n, rate_pct: "6.125", term_months: 360, prepaid_finance_charge_cents: 0n }).apr_disclosed, "6.125");
  // the same figures through the process's bus tools (`computeAPR`, `renderH24`): the agent never computes terms itself
  const clock = new FixedClock(MST("2026-10-05", "15:00")); const events = new MemoryEventStore(clock);
  const ctx: UowContext = { loanId: "", applicationId: "APP-T8", events, ledger: new MemoryLedger(), timers: new TimerEngine(loadOverriddenRegistry(), events, { processes: [] }), clock, decide: () => {} };
  const agents = new AgentRegistry(); const cmds = bind21_2({ store: new EntityStore(), ports: {}, escalations: new EscalationService(events, clock), services: {} }, agents); const bus = new CommandBus(agents);
  const apr = (await bus.execute(cmds.get(toolKey("21.2", "computeAPR"))!, DISCLOSURE, { loan_cents: 56_000_000n, rate_pct: "6.125", term_months: 360, fees: FEES }, ctx)).output as { apr: { apr_disclosed: string; amount_financed_cents: bigint }; calcs: typeof c };
  assert.equal(apr.apr.apr_disclosed, "6.125"); assert.equal(apr.apr.amount_financed_cents, 56_000_000n); assert.deepEqual(apr.calcs, c);
  const h24 = (await bus.execute(cmds.get(toolKey("21.2", "renderH24"))!, DISCLOSURE, { ...renderInput("APP-T8", "LE-T8"), as_of: "2026-10-05", costs_expire_display: "10/20/2026 at 5:00 p.m. MST", escrow_monthly_cents: 55_000n }, ctx)).output as { payload: Record<string, unknown>; text: string; data_hash: string };
  assert.equal(h24.payload.pi_cents, 340_262n); assert.equal(h24.payload.tip_pct, "118.740"); assert.equal(h24.payload.apr_pct, "6.125"); assert.equal(h24.payload.in_5y_total_cents, 20_677_420n); assert.equal(h24.payload.in_5y_principal_cents, 3_809_713n);
  assert.match(h24.text, /Monthly Principal & Interest \$3,402\.62/); assert.match(h24.text, /In 5 Years: \$206,774\.20 .* \$38,097\.13 Principal you will have paid off/); assert.match(h24.text, /\(APR\) 6\.125%/); assert.match(h24.text, /\(TIP\) 118\.740%/);
  assert.match(h24.text, /LENDER Partner Bank, N\.A\. NMLS\/LICENSE ID 123456\. LOAN OFFICER Jordan Rivera NMLS\/LICENSE ID 987654/); assert.match(h24.text, /We intend \[X\] to service your loan/);
  const reg = buildRegistry(); publishAuthored(reg); const v = reg.activeVersion("NTC_REGZ_1026_37_LE", D("2026-10-05"))!;
  const check = evaluateChecklist(v, h24.payload, render(v.source, h24.payload)); assert.deepEqual(check.blocking.map((b) => b.rule_id), []); assert.equal(check.passed, true);
});
test("21.2-T9: Given the MLO approved data hash h1 and the pricing scenario then changes (rate 6.000 %), when the agent attempts delivery, then delivery is refused until a new approval for hash h2 exists.", () => {
  const h = harness(MST("2026-10-05", "10:41")); h.tridReceived("APP-T9", MST("2026-10-05", "10:41"));
  const r1 = h.approved("APP-T9", "LE-T9"); const h1 = r1.data_hash; assert.equal(r1.status, "approved"); assert.equal(r1.mlo_approved_hash, h1);
  assert.equal(h.emitted("escalation.created").filter((e) => e.payload.kind === "mlo_of_record" && e.payload.stage === "le_terms").length, 1);
  assert.equal(h.timer("SM_O22_MLO_LE_REVIEW_SLA_1BD").status, "satisfied"); assert.equal(h.emitted("disclosure.le.mlo_approved")[0]!.payload.data_hash, h1);
  // pricing scenario changes to 6.000%: re-rendered, hash h2 ≠ h1, back to `rendered`
  const r2 = h.svc.reprice("LE-T9", renderInput("APP-T9", "LE-T9", { pricing: { ...PRICING, quote_id: "Q-20-4-0002", rate_pct: "6.000" } }));
  const h2 = r2.data_hash; assert.notEqual(h2, h1); assert.equal(r2.status, "rendered"); assert.equal(r2.calcs.pi_cents, 335_748n); assert.equal(r2.mlo_approved_hash, h1);
  h.clock.set(MST("2026-10-05", "16:10"));
  assert.throws(() => h.svc.deliver("LE-T9", { channel: "esign_portal", consent: CONSENT }), (e: unknown) => e instanceof LeRefused && e.code === "MLO_APPROVAL_REQUIRED" && /pricing scenario changed/.test(e.message));
  assert.equal(h.emitted("disclosure.le.issued").length, 0);
  // an approval for the stale hash h1 does not release h2 either
  assert.throws(() => h.svc.mloDecision("LE-T9", { review_id: "MR-2", decision: "approved", data_hash: h1, nmlsr_id: MLO.nmlsr_id }), (e: unknown) => e instanceof LeRefused && e.code === "MLO_APPROVAL_HASH");
  h.svc.mloDecision("LE-T9", { review_id: "MR-3", decision: "approved", data_hash: h2, nmlsr_id: MLO.nmlsr_id });
  const row = h.svc.deliver("LE-T9", { channel: "esign_portal", consent: CONSENT }); assert.equal(row.status, "delivered"); assert.equal(row.mlo_review_id, "MR-3"); assert.equal(row.pricing.rate_pct, "6.000");
  // MLO SLA: +1 creditor BD end of day, capped at le_due_at − 2h (Oct 8 21:59 MST)
  assert.equal(mloReviewSlaDueAt(MST("2026-10-05", "15:20"), MST("2026-10-08", "23:59")), MST("2026-10-06", "23:59"));
  assert.equal(mloReviewSlaDueAt(MST("2026-10-08", "09:00"), MST("2026-10-08", "23:59")), MST("2026-10-08", "21:59"));
});
test("21.2-T10: Given an LE delivered Mon Oct 5 and no intent to proceed by Tue Oct 20, 2026 5:00 p.m. MST, then `REGZ_1026_37A13_COSTS_EXPIRE_10BD` expires and 21.5 may issue a revised LE under (e)(3)(iv)(E); intent received Tue Oct 6 blanks the expiration field on the revised LE.", () => {
  const exp = closingCostsExpireAt(D("2026-10-05"), PHOENIX_CREDITOR);
  assert.equal(exp.expires_on, "2026-10-20"); assert.equal(exp.expires_at, MST("2026-10-20", "17:00")); assert.equal(exp.display, "10/20/2026 at 5:00 p.m. MST");   // Oct 6, 7, 8, 9, 13, 14, 15, 16, 19, 20 — Oct 12 closed
  const h = harness(MST("2026-10-05", "10:41")); h.tridReceived("APP-T10", MST("2026-10-05", "10:41")); h.approved("APP-T10", "LE-T10"); h.clock.set(MST("2026-10-05", "16:10"));
  const row = h.svc.deliver("LE-T10", { channel: "esign_portal", consent: CONSENT });
  assert.equal(row.closing_costs_expire_at, MST("2026-10-20", "17:00")); assert.equal(h.svc.closingCostsExpirationField("LE-T10"), "10/20/2026 at 5:00 p.m. MST");
  const t = h.timer("REGZ_1026_37A13_COSTS_EXPIRE_10BD"); assert.equal(t.status, "armed"); assert.equal(t.anchorDate, "2026-10-05"); assert.equal(t.dueDate, "2026-10-20");
  assert.equal(h.svc.costsExpired("LE-T10", MST("2026-10-20", "16:59")), false);
  h.clock.set(MST("2026-10-20", "17:01")); assert.equal(h.svc.costsExpired("LE-T10", h.clock.now()), true);
  h.clock.set(MST("2026-10-21", "09:00")); h.timers.evaluate(h.clock.now()); assert.equal(t.status, "breached");   // expired without intent: 21.5 may reset the baseline under (e)(3)(iv)(E)
  // intent Tue Oct 6 (21.4's event): the clock is satisfied and the expiration field is blank on any later LE
  const g = harness(MST("2026-10-05", "10:41")); g.tridReceived("APP-T10b", MST("2026-10-05", "10:41")); g.approved("APP-T10b", "LE-T10b"); g.clock.set(MST("2026-10-05", "16:10"));
  g.svc.deliver("LE-T10b", { channel: "esign_portal", consent: CONSENT });
  g.clock.set(MST("2026-10-06", "09:14")); g.events.append({ type: "intent.to_proceed.received", applicationId: "APP-T10b", actor: { kind: "agent", id: "pricing" }, payload: { application_id: "APP-T10b", received_at: g.clock.now(), valid: true } });
  assert.equal(g.timer("REGZ_1026_37A13_COSTS_EXPIRE_10BD").status, "satisfied"); assert.equal(g.svc.closingCostsExpirationField("LE-T10b"), null); assert.equal(g.svc.costsExpired("LE-T10b", MST("2026-10-21", "09:00")), false);
});
test("21.2-T11: Given a pre-LE written quote generated by 20.4 on Oct 5 at 10:45, when rendered, then the first page carries \"Your actual rate, payment, and costs could be higher. Get an official Loan Estimate before choosing a loan.\" in ≥ 12-point type at the top.", () => {
  const reg = buildRegistry(); publishAuthored(reg);
  const v = reg.activeVersion("NTC_REGZ_1026_19E2II_PRELE_ESTIMATE", D("2026-10-05"))!; assert.ok(v, "the (e)(2)(ii) wrapper is authored and effective");
  const payload = { prepared_on: "2026-10-05", prepared_at: MST("2026-10-05", "10:45"), applicants: "Alex Borrower", lender_name: "Partner Bank, N.A.", lender_nmlsr_id: "123456", quote_id: "Q-20-4-0001", loan_amount_cents: 56_000_000n, interest_rate_pct: "6.125", pi_cents: 340_262n, estimated_closing_costs_cents: 350_543n };
  const r = render(v.source, payload);
  assert.equal(PRELE_ESTIMATE_STATEMENT, "Your actual rate, payment, and costs could be higher. Get an official Loan Estimate before choosing a loan.");
  assert.ok(r.text.startsWith(PRELE_ESTIMATE_STATEMENT), "statement first on the page");
  const block = r.blocks[0]!; assert.equal(block.id, "disclaimer"); assert.equal(block.page, 1); assert.ok(block.yFraction <= 0.05); assert.ok(block.pt >= 12); assert.equal(block.text, PRELE_ESTIMATE_STATEMENT);
  const check = evaluateChecklist(v, payload, r); assert.equal(check.passed, true); assert.deepEqual(check.blocking, []);
  // the same statement at 11-point, or below the top of the page, fails the §1026.19(e)(2)(ii) layout rule
  const small = evaluateChecklist(v, payload, render(v.source.replace('pt=12 bold', 'pt=11 bold'), payload)); assert.deepEqual(small.blocking.map((b) => b.rule_id), ["statement-top-12pt"]);
  const low = evaluateChecklist(v, payload, render(v.source.replace('y=0.02 pt=12', 'y=0.5 pt=12'), payload)); assert.deepEqual(low.blocking.map((b) => b.rule_id), ["statement-top-12pt"]);
  const t = reg.template("NTC_REGZ_1026_19E2II_PRELE_ESTIMATE"); assert.equal(t.ownerSection, "21.2"); assert.equal(t.channelPolicy, "electronic_ok_without_esign");
});
test("21.2-T12: Given the purchase fixture with closing Wed Nov 18, 2026, when the LE is delivered Thu Oct 22, then `earliest_consummation_date` = Fri Oct 30 (Fri 23, Sat 24, Mon 26, Tue 27, Wed 28, Thu 29, Fri 30) and the Nov 18 closing passes the gate; an LE first delivered Tue Nov 10 would set the earliest date to Thu Nov 19 (Wed Nov 11 excluded) and block the Nov 18 closing.", () => {
  const EDT = (date: string, hhmm: string): string => new Date(`${date}T${hhmm}:00-04:00`).toISOString();
  const h = harness(EDT("2026-10-19", "20:44"), COLUMBUS_CREDITOR);
  const a = h.tridReceived("APP-T12", EDT("2026-10-19", "20:44")); assert.equal(a.trid_application_date, "2026-10-19"); assert.equal(a.le_due_on, "2026-10-22");   // Tue 20, Wed 21, Thu 22
  h.clock.set(EDT("2026-10-22", "09:30"));
  h.approved("APP-T12", "LE-T12", { as_of: D("2026-10-22"), transaction_type: "purchase", loan_cents: 41_200_000n, estimated_value_cents: 45_800_000n, property_address: "1 Fixture Ln, Columbus, OH 43215", mi_monthly_cents: 14_420n });
  const row = h.svc.deliver("LE-T12", { channel: "esign_portal", consent: { ...CONSENT, granted_at: EDT("2026-10-19", "20:30") } });
  assert.equal(row.issued_on, "2026-10-22"); assert.equal(row.earliest_consummation_date, "2026-10-30");
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((n) => addBusinessDays(D("2026-10-22"), n, regzSpecific)), ["2026-10-23", "2026-10-24", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"]);
  h.svc.assertGateOpen("APP-T12", D("2026-11-18"));
  assert.equal(h.timer("REGZ_1026_19E1_LE_3BD").status, "satisfied"); assert.equal(row.calcs.in_5y_total_cents, 60n * (row.calcs.pi_cents + 14_420n) + row.totals.loan_costs_cents, "BPMI in the In-5-Years total");
  // an LE first delivered Tue Nov 10: Wed Nov 11 (Veterans Day) excluded → earliest Thu Nov 19; the Nov 18 closing is blocked; the latest issue date for Nov 18 is Mon Nov 9
  assert.equal(earliestConsummationDate(D("2026-11-10")), "2026-11-19"); assert.equal(regzSpecific.isBusinessDay(D("2026-11-11")), false);
  assert.equal(latestLeIssueDateFor(D("2026-11-18")), "2026-11-09");   // counting back: Tue 17, Mon 16, Sat 14, Fri 13, Thu 12, Tue 10, Mon 9
  const late = le7sbdGate({ earliest_consummation_date: "2026-11-19", requested_on: "2026-11-18" }); assert.equal(late.open, false); assert.match(late.reason!, /precedes the earliest permitted date 2026-11-19/);
  const g = harness(EDT("2026-11-10", "09:00"), COLUMBUS_CREDITOR); g.tridReceived("APP-T12b", EDT("2026-11-05", "09:00")); g.clock.set(EDT("2026-11-10", "09:00")); g.approved("APP-T12b", "LE-T12b", { as_of: D("2026-11-10"), transaction_type: "purchase", fees: FEES.map((f) => ({ ...f, estimated_at: D("2026-11-10") })) });
  g.svc.deliver("LE-T12b", { channel: "esign_portal", consent: { ...CONSENT, granted_at: EDT("2026-11-05", "08:00") } });
  assert.equal(g.svc.get("LE-T12b").earliest_consummation_date, "2026-11-19");
  assert.throws(() => g.svc.assertGateOpen("APP-T12b", D("2026-11-18")), LeGateClosed); g.svc.assertGateOpen("APP-T12b", D("2026-11-19"));
});

test("21.2 worked figures: refinance fixture — per diem $93.97 × 19 = $1,785.43, other costs $3,505.43, loan costs $2,617, ten-percent baseline $1,865, P&I $3,402.62, TIP 118.740%, In 5 Years $206,774.20 / $38,097.13 (balance $521,902.87), APR 6.125% (Appendix J; 6.170/6.159/6.150 with $2,687/$2,000/$1,500 PFC) and the 25.1 CD fixture 6.159363%", () => {
  const L = 56_000_000n;
  // F. prepaid interest: 560,000 × 0.06125 ÷ 365 = 93.9726… → $93.97 per day, × 19 days (assumed Nov 12 disbursement) = $1,785.43 (not the unrounded $1,785.48 — 26.3 rule 2; verification report item 50)
  assert.equal(perDiemInterest(L, "6.125"), 9_397n);
  const pp = prepaidInterest(L, "6.125", 19); assert.equal(pp.per_diem_cents, 9_397n); assert.equal(pp.total_cents, 178_543n);
  assert.equal(FEES.find((f) => f.fee_code === "prepaid_interest")!.amount_cents, pp.total_cents);
  // sections: B $822 + C $1,795 = loan costs $2,617 (A $0); E $70 + F $1,785.43 + G $1,650 = other costs $3,505.43; J −$2,617 equal to the SM-borne B + C
  const t = sectionTotals(FEES);
  assert.equal(t.A, 0n); assert.equal(t.B, 82_200n); assert.equal(t.C, 179_500n); assert.equal(t.loan_costs_cents, 261_700n);
  assert.equal(t.E, 7_000n); assert.equal(t.F, 178_543n); assert.equal(t.G, 165_000n); assert.equal(t.other_costs_cents, 350_543n);
  assert.equal(t.lender_credits_cents, -261_700n); assert.equal(t.lender_credits_cents, -(t.B + t.C)); assert.equal(t.total_closing_costs_cents, 350_543n);
  assert.equal(tenPercentAggregate(FEES.map((f) => ({ ...f, tolerance_class: deriveToleranceClass(f) }))), 186_500n);   // $1,795 + $70 recording
  // P&I and the schedule
  const a = amortize(L, "6.125", 360);
  assert.equal(a.pi_cents, 340_262n); assert.equal(a.balance_after_60_cents, 52_190_287n); assert.equal(a.principal_paid_60_cents, 3_809_713n); assert.equal(a.scheduled_interest_cents, 66_494_220n); assert.equal(a.total_of_payments_cents, 122_494_320n);
  const c = loanEstimateCalcs({ loan_cents: L, rate_pct: "6.125", term_months: 360, loan_costs_cents: t.loan_costs_cents });
  assert.equal(c.tip_pct, "118.740"); assert.equal(c.in_5y_total_cents, 20_677_420n); assert.equal(c.in_5y_principal_cents, 3_809_713n);
  // APR: the lender credit absorbs every finance-charge fee (tax service $85 + prepaid interest $1,785.43 < $2,617) → no net prepaid finance charge → 6.125%
  assert.equal(netPrepaidFinanceCharge(FEES), 0n);
  const apr0 = computeApr({ loan_cents: L, rate_pct: "6.125", term_months: 360, prepaid_finance_charge_cents: 0n });
  assert.equal(apr0.apr_disclosed, "6.125"); assert.equal(apr0.amount_financed_cents, L); assert.equal(apr0.finance_charge_cents, 66_494_320n); assert.equal(apr0.apr_pct.slice(0, 6), "6.1250");
  // 25.1's tolerance illustrations: $2,687 of unreimbursed PFC → 6.170%; $2,000 → 6.159%; $1,500 → 6.150%
  assert.equal(computeApr({ loan_cents: L, rate_pct: "6.125", term_months: 360, prepaid_finance_charge_cents: 268_700n }).apr_disclosed, "6.170");
  assert.equal(computeApr({ loan_cents: L, rate_pct: "6.125", term_months: 360, prepaid_finance_charge_cents: 200_000n }).apr_disclosed, "6.159");
  assert.equal(computeApr({ loan_cents: L, rate_pct: "6.125", term_months: 360, prepaid_finance_charge_cents: 150_000n }).apr_disclosed, "6.150");
  // the CD fixture as the verification report corrected it (25.1 worked example 1): PFC $3,849.95 incl. prepaid interest $1,785.43, 19 odd days → A $556,150.05, FC $668,793.15, APR 6.159363% → 6.159; TIP 119.059%
  const cd = computeApr({ loan_cents: L, rate_pct: "6.125", term_months: 360, prepaid_finance_charge_cents: 384_995n, odd_days: 19 });
  assert.equal(cd.amount_financed_cents, 55_615_005n); assert.equal(cd.finance_charge_cents, 66_879_315n); assert.equal(cd.odd_fraction, "0.6333333333"); assert.equal(cd.apr_pct, "6.159363"); assert.equal(cd.apr_disclosed, "6.159"); assert.equal(cd.monthly_rate.slice(0, 14), "0.005132802455");
  assert.equal(Decimal.ratio((a.scheduled_interest_cents + 178_543n) * 100n, L).toFixed(3), "119.059");
  // the provider list names at least one available provider per shoppable service
  assert.deepEqual(buildProviderList(FEES, PROVIDERS).map((s) => s.service), ["title_lenders_policy", "title_settlement", "title_endorsements"]);
  assert.throws(() => buildProviderList(FEES, { ...PROVIDERS, title_endorsements: [] }), /no available provider listed for shoppable service title_endorsements/);
  assert.equal(addDays(AS_OF, 30) >= AS_OF, true);
});
