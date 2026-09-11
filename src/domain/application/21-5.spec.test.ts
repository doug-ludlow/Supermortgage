// 21.5 Changed circumstances, revised Loan Estimates, and tolerance management (good-faith baseline, 4-business-day rule, resets, cure)
// spec/sections/21-application-urla-initial-disclosures-intent-to-proceed-rate/21-5-changed-circumstances-revised-loan-estimates-and-tolerance-m.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, addDays } from "../../kernel/calendar/date.ts";
import { regzSpecific, addBusinessDays } from "../../kernel/calendar/business.ts";
import { MemoryEventStore, FixedClock, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { EscalationService } from "../../app/escalations.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { CommandBus, type CommandSpec } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EntityStore, toolCommand, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { TOOLS_21_5 } from "../../app/tools/section21-5.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import { LoanEstimateService, PHOENIX_CREDITOR, COLUMBUS_CREDITOR, prepaidInterest, amortize, deriveToleranceClass, tenPercentAggregate, type FeeItemInput, type LeRenderInput, type EsignConsent, type CreditorCalendarSpec } from "./ops-21-2.ts";
import { evaluateFeeGate, type IntentRecord } from "./ops-21-4.ts";
import {
  ToleranceService, ToleranceRefused, classifyFeeChange, baselineFromFees, tenPercentLimitCents, resetThresholdCents, bucketBaselineSum, bucketThresholdTest, evaluateChangedCircumstance, revisedLeDueAt, latestRevisedLeReceipt, earliestConsummationAfterRevisedLe, fourDayRule, refundDueOn,
  toleranceTest, lenderCreditShortfall, cureStatement, revisedLeFourDayGate, TOLERANCE_CURE_EXPENSE, BORROWER_REFUNDS_PAYABLE, CORPORATE_CASH, type BaselineItem, type RevisedAmount,
} from "./ops-21-5.ts";

const INTAKE: Actor = { kind: "agent", id: "intake" };
const PRICING: Actor = { kind: "agent", id: "pricing" };
const CD_AGENT: Actor = { kind: "agent", id: "disclosure" };
const OFFICER = { kind: "human" as const, id: "u-officer", role: "officer" };
const MST = (date: string, hhmm: string): string => new Date(`${date}T${hhmm}:00-07:00`).toISOString();
const EDT = (date: string, hhmm: string): string => new Date(`${date}T${hhmm}:00-04:00`).toISOString();
/** Refinance fixture (Phoenix, AZ): loan $560,000, 30-year fixed 6.125 %, the 21.2 fee set assembled Oct 5, 2026 (21.2 worked example 1). */
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
/** The CPL the creditor requires from the list provider, not on the LE (worked example 1: baseline 0, ten-percent by its facts). */
const CPL = (amount_cents: bigint): FeeItemInput => fee("title_cpl", "Title – Closing Protection Letter", "C_can_shop", "TitleClosingProtectionLetterFee", amount_cents, "list_provider", true, "vendor_quote", "N7-rate-engine-2026-11-02", false, { estimated_at: D("2026-11-02") });
/** Purchase fixture (Columbus, OH; worked example 2): lender's title $1,395, settlement $550, endorsements $125, recording $150 (Franklin County) → bucket 222,000 cents. */
const PURCHASE_AS_OF = D("2026-10-22");
const PURCHASE_FEES: FeeItemInput[] = [
  fee("appraisal", "Appraisal Fee", "B_cannot_shop", "AppraisalFee", 65_000n, "creditor_selected_third_party", false, "vendor_quote", "AMC-Q-90001", false, { estimated_at: PURCHASE_AS_OF }),
  fee("title_lenders_policy", "Title – Lender's Title Policy", "C_can_shop", "TitleLendersCoveragePremium", 139_500n, "list_provider", true, "vendor_quote", "OH-title-2026-10-22", false, { estimated_at: PURCHASE_AS_OF }),
  fee("title_settlement", "Title – Settlement Agent Fee", "C_can_shop", "TitleSettlementAgentFee", 55_000n, "list_provider", true, "vendor_quote", "OH-title-2026-10-22", false, { estimated_at: PURCHASE_AS_OF }),
  fee("title_endorsements", "Title – Endorsements", "C_can_shop", "TitleEndorsementFee", 12_500n, "list_provider", true, "vendor_quote", "OH-title-2026-10-22", false, { estimated_at: PURCHASE_AS_OF }),
  fee("recording", "Recording Fees", "E_taxes_gov", "RecordingFeeForMortgage", 15_000n, "government", false, "county_table", "franklin-recording-2026", false, { estimated_at: PURCHASE_AS_OF }),
  fee("lender_credit", "Lender Credits", "J_lender_credit", "LenderCredit", -100_000n, "creditor", false, "pricing_engine", "Q-20-4-0002", false, { estimated_at: PURCHASE_AS_OF }),
];
const PROVIDERS = { title_lenders_policy: [{ party_id: "P-GCT", name: "Grand Canyon Title Agency", affiliate: false, estimated_fee_cents: 115_000n }], title_settlement: [{ party_id: "P-GCT", name: "Grand Canyon Title Agency", affiliate: false, estimated_fee_cents: 49_500n }], title_endorsements: [{ party_id: "P-GCT", name: "Grand Canyon Title Agency", affiliate: false, estimated_fee_cents: 15_000n }] };
const PRICING_Q = { quote_id: "Q-20-4-0001", rate_pct: "6.125", price: "100.000", points_cents: 0n, lender_credit_cents: 261_700n, locked: false };
const LOCKED_Q = { ...PRICING_Q, locked: true, lock_expires_at: MST("2026-11-23", "17:00"), lock_time_zone: "America/Phoenix" };
const CREDITOR = { name: "Partner Bank, N.A.", nmlsr_id: "123456", email: "loans@partnerbank.example", phone: "(800) 555-0155" };
const MLO = { name: "Jordan Rivera", nmlsr_id: "987654" };
const CONSENT: EsignConsent = { id: "CNS-ESIGN-1", scope: ["disclosures", "notices"], granted_at: MST("2026-10-05", "10:20") };
const renderInput = (application_id: string, disclosure_id: string, over: Partial<LeRenderInput> = {}): LeRenderInput => ({ application_id, disclosure_id, as_of: AS_OF, loan_cents: 56_000_000n, term_months: 360, transaction_type: "limited_cash_out", product: "Fixed Rate", pricing: PRICING_Q, fees: FEES, applicants: ["Alex Borrower"], property_address: "4210 E Camelback Rd, Phoenix, AZ 85018", estimated_value_cents: 82_000_000n, creditor: CREDITOR, loan_officer: MLO, providers: PROVIDERS, ...over });
/** The same fee set re-dated (rule 5 freshness) with amount overrides — the revised LE's fee list. */
const feesAsOf = (asOf: string, over: Record<string, bigint> = {}, extra: FeeItemInput[] = []): FeeItemInput[] => [...FEES.map((f) => ({ ...f, estimated_at: D(asOf), amount_cents: over[f.fee_code] ?? f.amount_cents })), ...extra];
const A3_NARRATIVE = "the AMC reports a detached ADU whose rent the borrower wants counted (Form 1007 + complex-assignment fee): new information specific to the transaction that the creditor did not rely on when providing the original disclosures — the 1003 listed a 1-unit with no ADU";

/** The 21.2 → 21.4 → 21.5 lifecycle on one event store: LoanEstimateService (LE v1 + fee.baseline.set), the 21.4 events appended as that process emits them, ToleranceService consuming them, the TimerEngine arming the 21.5 rows. */
function harness(nowIso: string, calendar: CreditorCalendarSpec = PHOENIX_CREDITOR) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["21.5", "21.4", "21.2"] });
  const escalations = new EscalationService(events, clock); const ledger = new MemoryLedger();
  const le = new LoanEstimateService({ events, clock, escalations, calendar });
  const svc = new ToleranceService({ events, clock, ledger, escalations, calendar });
  const emitted = (type: string) => events.all().filter((e) => e.type === type);
  const timer = (code: string) => timers.byCode(code).at(-1)!;
  /** LE v1: six items → render → MLO approval → e-sign delivery (viewed the same evening) → `fee.baseline.set`. */
  const initialLe = (app: string, disclosureId: string, receivedAt: string, deliveredAt: string, viewedAt: string, over: Partial<LeRenderInput> = {}) => {
    clock.set(receivedAt); const a = le.onTridReceived(app, receivedAt);
    events.append({ type: "application.trid_received", applicationId: app, actor: INTAKE, occurredAt: receivedAt, payload: { application_id: app, trid_received_at: receivedAt, trid_application_date: a.trid_application_date } });
    const r = le.render(renderInput(app, disclosureId, over)); le.openMloReview(disclosureId); le.mloDecision(disclosureId, { review_id: `MR-${disclosureId}`, decision: "approved", data_hash: r.data_hash, nmlsr_id: MLO.nmlsr_id });
    clock.set(deliveredAt); le.deliver(disclosureId, { channel: "esign_portal", consent: { ...CONSENT, granted_at: receivedAt } }); le.recordReceipt(disclosureId, { kind: "authenticated_view", at: viewedAt, borrower_id: "B-1" });
    return le.get(disclosureId);
  };
  /** 21.4's `lock.executed` + `changed_circumstances{kind='rate_lock'}` exactly as ops-21-4 emits them (basis D; its own 3-day clock). */
  const lock = (app: string, executedAt: string) => {
    const on = executedAt.slice(0, 10) as ReturnType<typeof D>; const due = revisedLeDueAt(executedAt, calendar);
    events.append({ type: "lock.executed", applicationId: app, aggregate: { kind: "application", id: app }, actor: PRICING, occurredAt: executedAt, payload: { application_id: app, lock_id: "LOCK-1", lineage_id: "LIN-1", version: 1, note_rate: "6.125", price: "100.000", points_cents: "0", lender_credit_cents: "261700", lock_period_days: 45, expires_at: LOCKED_Q.lock_expires_at, expires_on: "2026-11-23", rate_set_date: on, locked_at: executedAt, revised_le_due_at: due.due_at, revised_le_reflected_on: "le", property_state: "AZ", ny_expiry_notice_required: false } });
    return events.append({ type: "changed_circumstance.recorded", applicationId: app, aggregate: { kind: "application", id: app }, actor: PRICING, occurredAt: executedAt, payload: { application_id: app, cc_id: `CC-LOCK-${app}`, kind: "rate_lock", basis: "D", discovered_at: executedAt, revised_le_due_at: due.due_at, revised_le_due_on: due.due_on, reflected_on: "le", lock_id: "LOCK-1", source_event_id: "lock", affected_amount_cents: "0", narrative: `interest rate locked ${on} at 6.125% / 100.000 (§1026.19(e)(3)(iv)(D))` } });
  };
  const revised = (app: string, disclosureId: string, ccIds: string[], asOf: string, over: Partial<LeRenderInput> & { costs_expire_at?: string | null } = {}) => { const { costs_expire_at, ...rest } = over; return svc.renderRevisedLE({ ...renderInput(app, disclosureId, { as_of: D(asOf), fees: feesAsOf(asOf), pricing: LOCKED_Q, ...rest }), cc_ids: ccIds, ...(costs_expire_at !== undefined ? { costs_expire_at } : {}) }); };
  const appraisalCc = (app: string, at: string, narrative = A3_NARRATIVE, evidence: string[] = ["DOC-AMC-MSG-1", "DOC-PROPERTY-DATA-1"]) => svc.recordChangedCircumstance({ application_id: app, basis: "A3", narrative, evidence_document_ids: evidence, information_received_at: at, revised: [{ fee_code: "appraisal", amount_cents: 85_000n }], source_event_id: "EVT-AMC-1" });
  /** CD-stage actuals: everything at the LE figure except the overrides; the lender credit as the CD shows it. */
  const actuals = (over: Record<string, bigint> = {}, extra: { fee_code: string; amount_cents: bigint; item: FeeItemInput }[] = []) => [...FEES.filter((f) => f.le_section !== "J_lender_credit").map((f) => ({ fee_code: f.fee_code, amount_cents: over[f.fee_code] ?? f.amount_cents })), ...extra];
  const cdDelivered = (app: string, at: string, disclosureId = "CD-1") => events.append({ type: "disclosure.cd.delivered", applicationId: app, actor: CD_AGENT, occurredAt: at, payload: { application_id: app, disclosure_id: disclosureId, kind: "cd", version: 1, channel: "esign_portal", delivered_at: at, issued_on: at.slice(0, 10) } });
  return { clock, events, timers, escalations, ledger, le, svc, emitted, timer, initialLe, lock, revised, appraisalCc, actuals, cdDelivered };
}
const toolKey = (process: string, name: string): string => `${process} ${name}`;
function bind21_5(rt: ToolRuntime, agents: AgentRegistry): Map<string, CommandSpec<ToolInput, unknown>> {
  const escalates = new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
  const out = new Map<string, CommandSpec<ToolInput, unknown>>();
  for (const d of TOOLS_21_5) { const cmd = toolCommand(d, rt, escalates.get(d.process) ?? []); agents.registerTool(d.agent, cmd.name); out.set(toolKey(d.process, d.name), cmd); }
  return out;
}
const baselineItems = (): BaselineItem[] => baselineFromFees(FEES.map((f) => ({ ...f, tolerance_class: deriveToleranceClass(f), baseline_amount_cents: f.amount_cents, baseline_disclosure_id: "LE-1" })), "LE-1", MST("2026-10-05", "16:10"));

test("21.5-T1: Given the 21.2 fee set, when `fee.baseline.set` fires, then classes derive as: appraisal/credit/flood/tax service `zero` (cannot shop); title/settlement/endorsements `ten_percent` (on-list, non-affiliate); recording `ten_percent`; prepaid interest/escrow `unlimited`; lender credit `zero`; and `limit_cents` for the bucket = 205,150.", () => {
  const h = harness(MST("2026-10-05", "10:41"));
  h.initialLe("APP-T1", "LE-T1", MST("2026-10-05", "10:41"), MST("2026-10-05", "16:10"), MST("2026-10-05", "17:42"));
  const set = h.emitted("fee.baseline.set"); assert.equal(set.length, 1); assert.equal(set[0]!.payload.ten_percent_baseline_cents, "186500"); assert.equal(set[0]!.payload.lender_credit_baseline_cents, "-261700");
  // the service consumed the event: classes are the 21.2 derivation from facts (rule 1), never entered by hand
  const cls = (code: string) => h.svc.baselineOf("APP-T1", code).tolerance_class;
  for (const c of ["appraisal", "credit_report", "flood_cert", "tax_service"]) assert.equal(cls(c), "zero", `${c}: cannot shop → zero`);
  for (const c of ["title_lenders_policy", "title_settlement", "title_endorsements"]) assert.equal(cls(c), "ten_percent", `${c}: on-list, non-affiliate → ten_percent`);
  assert.equal(cls("recording"), "ten_percent", "a recording fee is ten_percent regardless of shopping");
  for (const c of ["prepaid_interest", "escrow_taxes", "escrow_hoi", "hoi_premium", "property_taxes_prepaid"]) assert.equal(cls(c), "unlimited", `${c}: (e)(3)(iii) → unlimited`);
  assert.equal(cls("lender_credit"), "zero"); assert.equal(cls("transfer_tax"), "zero");
  const items = h.svc.baseline("APP-T1"); assert.equal(bucketBaselineSum(items), 186_500n); assert.equal(tenPercentLimitCents(bucketBaselineSum(items)), 205_150n); assert.equal(tenPercentAggregate(FEES.map((f) => ({ ...f, tolerance_class: deriveToleranceClass(f) }))), bucketBaselineSum(items));
  assert.equal(h.svc.baselineOf("APP-T1", "appraisal").baseline_amount_cents, 65_000n); assert.equal(h.svc.baselineOf("APP-T1", "appraisal").baseline_disclosure_id, "LE-T1");
  // step (2): the appraisal increase matters (zero); a settlement decrease never does; a CPL added later is ten_percent by its facts
  const up = classifyFeeChange(FEES[0]!, 85_000n); assert.equal(up.class_after, "zero"); assert.equal(up.direction, "increase"); assert.equal(up.delta_cents, 20_000n); assert.equal(up.matters, true);
  const down = classifyFeeChange(FEES[5]!, 47_000n); assert.equal(down.direction, "decrease"); assert.equal(down.matters, false); assert.match(down.why, /never requires a revised LE/);
  assert.equal(deriveToleranceClass(CPL(2_500n)), "ten_percent");
});
test("21.5-T2: Given the appraisal changes $650 → $850 on Tue Oct 20, 2026 14:30 MST with basis (A)(3) evidence, then `revised_le_due_at` = Fri Oct 23, 2026 23:59 MST, the baseline resets to 85,000 cents on `evaluated_valid`, and LE v3 delivered Oct 21 satisfies `REGZ_1026_19E4_REVISED_LE_3BD`.", () => {
  const h = harness(MST("2026-10-05", "10:41"));
  h.initialLe("APP-T2", "LE-T2-1", MST("2026-10-05", "10:41"), MST("2026-10-05", "16:10"), MST("2026-10-05", "17:42"));
  // LE v2 Thu Oct 8 carries 21.4's rate-lock row (basis D — its own clock, satisfied by disclosure.le.revised{reason=rate_lock})
  h.lock("APP-T2", MST("2026-10-07", "10:19")); assert.equal(h.timer("REGZ_1026_19E3IVD_LOCK_REVISED_LE_3BD").status, "armed"); assert.equal(h.timer("REGZ_1026_19E3IVD_LOCK_REVISED_LE_3BD").dueDate, "2026-10-13");
  assert.equal(h.svc.cc("CC-LOCK-APP-T2").basis, "D"); assert.equal(h.timers.byCode("REGZ_1026_19E4_REVISED_LE_3BD").length, 0, "basis D never arms 21.5's clock");
  h.clock.set(MST("2026-10-08", "09:00")); h.revised("APP-T2", "LE-T2-2", ["CC-LOCK-APP-T2"], "2026-10-08"); h.svc.deliverRevisedLE("LE-T2-2", { channel: "esign_portal", consent: CONSENT });
  assert.equal(h.svc.revisedLe("LE-T2-2").le_version, 2); assert.equal(h.emitted("disclosure.le.revised")[0]!.payload.reason, "rate_lock"); assert.equal(h.timer("REGZ_1026_19E3IVD_LOCK_REVISED_LE_3BD").status, "satisfied");
  // Tue Oct 20 14:30 MST: the AMC's ADU finding — basis (A)(3), valid, evidenced
  const at = MST("2026-10-20", "14:30"); h.clock.set(at);
  const { cc, evaluation } = h.appraisalCc("APP-T2", at);
  assert.equal(evaluation.valid, true); assert.equal(cc.kind, "new_info"); assert.equal(cc.status, "revised_le_scheduled"); assert.equal(cc.information_received_on, "2026-10-20");
  assert.equal(cc.revised_le_due_on, "2026-10-23"); assert.equal(cc.revised_le_due_at, MST("2026-10-23", "23:59"));   // Wed 21 (1), Thu 22 (2), Fri Oct 23 (3) 23:59 MST
  assert.equal(new Date(cc.revised_le_due_at!).toISOString(), "2026-10-24T06:59:00.000Z");
  assert.equal(h.svc.baselineOf("APP-T2", "appraisal").baseline_amount_cents, 85_000n); assert.equal(h.svc.baselineOf("APP-T2", "appraisal").baseline_reset_cc_id, cc.cc_id); assert.equal(cc.baseline_reset, true);
  assert.equal(h.svc.baselineOf("APP-T2", "lender_credit").baseline_amount_cents, -261_700n, "the lender credit is unchanged (SM absorbs the $200 through the term sheet)");
  assert.deepEqual(h.emitted("fee.baseline.reset").map((e) => e.payload.fee_codes), [["appraisal"]]);
  const t = h.timer("REGZ_1026_19E4_REVISED_LE_3BD"); assert.equal(t.status, "armed"); assert.equal(t.anchorDate, "2026-10-20"); assert.equal(t.dueDate, "2026-10-23"); assert.equal(t.applicationId, "APP-T2");
  // LE v3 Wed Oct 21 10:05 via e-sign (viewed 10:40 → received Oct 21) satisfies the clock; receipt limit for Nov 6 consummation is Mon Nov 2
  h.clock.set(MST("2026-10-21", "10:05")); h.svc.scheduleConsummation("APP-T2", D("2026-11-06"));
  const v3 = h.revised("APP-T2", "LE-T2-3", [cc.cc_id], "2026-10-21", { fees: feesAsOf("2026-10-21", { appraisal: 85_000n }) });
  assert.equal(v3.le_version, 3); assert.equal(v3.fees.find((f) => f.fee_code === "appraisal")!.baseline_amount_cents, 85_000n); assert.deepEqual(v3.revision_reason_cc_ids, [cc.cc_id]); assert.equal(v3.rate_lock_block?.locked, true);
  h.svc.deliverRevisedLE("LE-T2-3", { channel: "esign_portal", consent: CONSENT, receipt_evidence_at: MST("2026-10-21", "10:40") });
  const row = h.svc.revisedLe("LE-T2-3"); assert.equal(row.status, "received"); assert.equal(row.effective_receipt_date, "2026-10-21"); assert.equal(row.latest_receipt_on, "2026-11-02"); assert.equal(row.late, false);
  assert.equal(t.status, "satisfied"); assert.equal(h.svc.cc(cc.cc_id).status, "revised_le_delivered"); assert.equal(h.svc.cc(cc.cc_id).reflected_on, "le");
  const rev = h.emitted("disclosure.le.revised").at(-1)!; assert.deepEqual(rev.payload.cc_ids, [cc.cc_id]); assert.equal(rev.payload.version, 3); assert.equal(rev.payload.reason, "new_info");
  assert.equal(h.emitted("changed_circumstance.reflected").at(-1)!.payload.reflected_on, "le");
  h.svc.assertGateOpen("APP-T2", D("2026-11-06"));
});
test("21.5-T3: Given the same $850 with narrative \"AMC rate card increase Oct 15\", then `valid=false`, no reset, and the CD-stage test yields `cure_required` $200.00 applied as a lender credit on the CD.", () => {
  const h = harness(MST("2026-10-05", "10:41"));
  h.initialLe("APP-T3", "LE-T3-1", MST("2026-10-05", "10:41"), MST("2026-10-05", "16:10"), MST("2026-10-05", "17:42"));
  const at = MST("2026-10-20", "14:30"); h.clock.set(at);
  const { cc, evaluation, event } = h.appraisalCc("APP-T3", at, "AMC rate card increase Oct 15");
  assert.equal(evaluation.valid, false); assert.equal(cc.valid, false); assert.equal(cc.status, "evaluated_invalid"); assert.equal(cc.reflected_on, "none_invalid"); assert.match(cc.invalid_reason!, /general price increase/);
  assert.equal(event.type, "changed_circumstance.rejected"); assert.equal(h.emitted("changed_circumstance.recorded").length, 0); assert.equal(h.timers.byCode("REGZ_1026_19E4_REVISED_LE_3BD").length, 0);
  assert.equal(h.svc.baselineOf("APP-T3", "appraisal").baseline_amount_cents, 65_000n, "no reset"); assert.equal(h.svc.baselineOf("APP-T3", "appraisal").current_amount_cents, 85_000n, "the estimate still moves; the increase is a cure candidate");
  assert.throws(() => h.svc.resetBaseline(cc.cc_id), (e: unknown) => e instanceof ToleranceRefused && e.code === "NO_RESET_WITHOUT_VALID_CC");
  // CD stage (Mon Nov 2): appraisal $850 against the $650 baseline → excess 20,000 cents → cure_required → lender credit on the CD
  h.clock.set(MST("2026-11-02", "09:00"));
  const { test: t } = h.svc.runToleranceTest({ application_id: "APP-T3", stage: "cd_initial", run_at: h.clock.now(), comparison_disclosure_id: "CD-1", actuals: h.actuals({ appraisal: 85_000n }), lender_credit_actual_cents: -261_700n });
  assert.equal(t.status, "cure_required"); assert.equal(t.total_excess_cents, 20_000n); assert.deepEqual(t.zero_results.find((z) => z.fee_code === "appraisal"), { fee_code: "appraisal", baseline_cents: 65_000n, actual_cents: 85_000n, excess_cents: 20_000n });
  assert.equal(t.ten_pct_result.excess_cents, 0n); assert.equal(t.lender_credit_result.shortfall_cents, 0n); assert.equal(t.cure_route, "lender_credit_at_closing");
  assert.equal(h.emitted("tolerance.test.completed").at(-1)!.payload.total_excess_cents, "20000");
  const { cure, ledger_set } = h.svc.applyCure(t.test_id, { funded_by: "sm", cd_disclosure_id: "CD-1" });
  assert.equal(cure.amount_cents, 20_000n); assert.equal(cure.method, "lender_credit_at_closing"); assert.equal(cure.cd_statement, "Includes $200.00 credit for increase in closing costs above legal limit"); assert.equal(h.svc.test(t.test_id).status, "cured_at_closing");
  assert.equal(ledger_set!.lines.length, 2); assert.equal(h.ledger.balance(TOLERANCE_CURE_EXPENSE), 20_000n); assert.equal(h.ledger.balance(CORPORATE_CASH), -20_000n);
  assert.equal(h.emitted("tolerance.cure.applied")[0]!.payload.cash_to_close_reduction_cents, "20000");
  assert.throws(() => h.svc.issueRefund(t.test_id, { instrument: "ach", sent_at: h.clock.now(), funded_by: "sm", released_by: OFFICER }), (e: unknown) => e instanceof ToleranceRefused && e.code === "CURE_AT_CLOSING_MANDATORY");
});
test("21.5-T4: Given bucket baseline 186,500 cents and CD actuals title 115,000, settlement 70,000, endorsements 15,000, recording 7,000, CPL 7,500 (new, baseline 0), then `actual_sum` = 214,500, `excess` = 9,350 cents and the CD carries a $93.50 cure.", () => {
  const items = baselineItems(); assert.equal(bucketBaselineSum(items), 186_500n);
  const cpl = CPL(7_500n);
  const t = toleranceTest(items, { application_id: "APP-T4", stage: "cd_initial", run_at: MST("2026-11-02", "09:00"), comparison_disclosure_id: "CD-1", lender_credit_actual_cents: -261_700n,
    actuals: [...FEES.filter((f) => f.le_section !== "J_lender_credit").map((f) => ({ fee_code: f.fee_code, amount_cents: f.fee_code === "title_settlement" ? 70_000n : f.amount_cents })), { fee_code: "title_cpl", amount_cents: 7_500n, item: cpl }] });
  assert.equal(t.ten_pct_result.baseline_sum_cents, 186_500n); assert.equal(t.ten_pct_result.limit_cents, 205_150n); assert.equal(t.ten_pct_result.actual_sum_cents, 214_500n); assert.equal(t.ten_pct_result.excess_cents, 9_350n);
  assert.deepEqual(t.ten_pct_result.items.find((x) => x.fee_code === "title_cpl"), { fee_code: "title_cpl", baseline_cents: 0n, actual_cents: 7_500n });
  assert.equal(t.zero_results.reduce((a, z) => a + z.excess_cents, 0n), 0n); assert.equal(t.total_excess_cents, 9_350n); assert.equal(t.status, "cure_required");
  assert.equal(cureStatement(t.total_excess_cents), "Includes $93.50 credit for increase in closing costs above legal limit");
  // through the service: the cure posts on the CD as a lender credit
  const h = harness(MST("2026-10-05", "10:41")); h.initialLe("APP-T4", "LE-T4", MST("2026-10-05", "10:41"), MST("2026-10-05", "16:10"), MST("2026-10-05", "17:42")); h.clock.set(MST("2026-11-02", "09:00"));
  const r = h.svc.runToleranceTest({ application_id: "APP-T4", stage: "cd_initial", run_at: h.clock.now(), comparison_disclosure_id: "CD-1", actuals: h.actuals({ title_settlement: 70_000n }, [{ fee_code: "title_cpl", amount_cents: 7_500n, item: cpl }]), lender_credit_actual_cents: -261_700n });
  assert.equal(r.test.total_excess_cents, 9_350n);
  const { cure } = h.svc.applyCure(r.test.test_id, { funded_by: "sm", cd_disclosure_id: "CD-1" }); assert.equal(cure.amount_cents, 9_350n); assert.match(cure.cd_statement, /\$93\.50/);
  // worked example 1's actual CD: settlement +$25 and a $25 CPL → 191,500 ≤ 205,150 → pass
  const ok = toleranceTest(items, { application_id: "APP-T4", stage: "cd_initial", run_at: MST("2026-11-02", "09:00"), comparison_disclosure_id: "CD-1", lender_credit_actual_cents: -261_700n, actuals: [...FEES.filter((f) => f.le_section !== "J_lender_credit").map((f) => ({ fee_code: f.fee_code, amount_cents: f.fee_code === "title_settlement" ? 52_000n : f.amount_cents })), { fee_code: "title_cpl", amount_cents: 2_500n, item: CPL(2_500n) }] });
  assert.equal(ok.ten_pct_result.actual_sum_cents, 191_500n); assert.equal(ok.status, "pass"); assert.equal(ok.total_excess_cents, 0n);
});
test("21.5-T5: Given a bucket baseline of 186,505 cents, then `limit_cents` = 205,155 (floor of 205,155.5) and the reset `threshold_cents` = 18,651 (ceil of 18,650.5).", () => {
  assert.equal(tenPercentLimitCents(186_505n), 205_155n); assert.equal(resetThresholdCents(186_505n), 18_651n);
  assert.equal(tenPercentLimitCents(186_500n), 205_150n); assert.equal(resetThresholdCents(186_500n), 18_650n);
  assert.equal(tenPercentLimitCents(222_000n), 244_200n); assert.equal(resetThresholdCents(222_000n), 22_200n);
  assert.equal(tenPercentLimitCents(0n), 0n); assert.equal(resetThresholdCents(0n), 0n); assert.equal(resetThresholdCents(1n), 1n, "ceil: any positive bucket needs a positive increase");
  // the threshold is strict: an increase equal to the threshold does not exceed it
  const items = baselineItems().map((f) => (f.fee_code === "recording" ? { ...f, baseline_amount_cents: 7_005n, current_amount_cents: 7_005n } : f)); assert.equal(bucketBaselineSum(items), 186_505n);
  const exact = bucketThresholdTest(items, [{ fee_code: "title_settlement", amount_cents: 49_500n + 18_651n }]); assert.equal(exact.threshold_cents, 18_651n); assert.equal(exact.increase_cents, 18_651n); assert.equal(exact.exceeds, false);
  const over = bucketThresholdTest(items, [{ fee_code: "title_settlement", amount_cents: 49_500n + 18_652n }]); assert.equal(over.exceeds, true);
  assert.throws(() => tenPercentLimitCents(-1n), RangeError);
});
test("21.5-T6: Given the purchase fixture bucket baseline 222,000 and a Nov 9 fee sheet moving recording 15,000 → 18,000 and settlement 55,000 → 60,000, then `increase` = 8,000 < 22,200 → `exceeds=false`, no baseline reset, and the CD test passes with actual 230,000 ≤ 244,200.", () => {
  const items = baselineFromFees(PURCHASE_FEES.map((f) => ({ ...f, tolerance_class: deriveToleranceClass(f), baseline_amount_cents: f.amount_cents, baseline_disclosure_id: "LE-P1" })), "LE-P1", EDT("2026-10-22", "09:30"));
  assert.equal(bucketBaselineSum(items), 222_000n);
  const sheet: RevisedAmount[] = [{ fee_code: "recording", amount_cents: 18_000n }, { fee_code: "title_settlement", amount_cents: 60_000n }];
  const tt = bucketThresholdTest(items, sheet); assert.deepEqual({ ...tt, items: undefined }, { bucket_baseline_cents: 222_000n, bucket_revised_cents: 230_000n, increase_cents: 8_000n, threshold_cents: 22_200n, exceeds: false, items: undefined });
  const ev = evaluateChangedCircumstance(items, { basis: "A3", narrative: "the title company's final fee sheet: the county's per-page count for the mortgage rider set raises the recording fee; settlement $600", evidence_document_ids: ["DOC-FEE-SHEET-1109"], information_received_at: EDT("2026-11-09", "10:00"), revised: sheet });
  assert.equal(ev.valid, false); assert.equal(ev.threshold_test?.exceeds, false); assert.equal(ev.reset_scope, "none"); assert.equal(ev.reflected_if_invalid, "none_invalid"); assert.match(ev.invalid_reason!, /not more than the 22200-cent threshold/);
  // through the service on the Columbus calendar: LE v1 Thu Oct 22 → the Nov 9 sheet → valid=false for reset purposes, reflected_on='none_invalid', CD Fri Nov 13 passes
  const h = harness(EDT("2026-10-19", "20:44"), COLUMBUS_CREDITOR);
  h.initialLe("APP-T6", "LE-P1", EDT("2026-10-19", "20:44"), EDT("2026-10-22", "09:30"), EDT("2026-10-22", "11:00"), { as_of: PURCHASE_AS_OF, transaction_type: "purchase", loan_cents: 41_200_000n, estimated_value_cents: 45_800_000n, property_address: "1 Fixture Ln, Columbus, OH 43215", fees: PURCHASE_FEES, pricing: { ...PRICING_Q, quote_id: "Q-20-4-0002", lender_credit_cents: 100_000n }, providers: { title_lenders_policy: PROVIDERS.title_lenders_policy, title_settlement: PROVIDERS.title_settlement, title_endorsements: PROVIDERS.title_endorsements } });
  assert.equal(bucketBaselineSum(h.svc.baseline("APP-T6")), 222_000n);
  h.clock.set(EDT("2026-11-09", "10:00"));
  const { cc } = h.svc.recordChangedCircumstance({ application_id: "APP-T6", basis: "A3", narrative: "the title company's final fee sheet (per-page count for the mortgage rider set): recording $180, settlement $600", evidence_document_ids: ["DOC-FEE-SHEET-1109"], information_received_at: h.clock.now(), revised: sheet, consummation_on: D("2026-11-18") });
  assert.equal(cc.valid, false); assert.equal(cc.reflected_on, "none_invalid"); assert.equal(cc.ten_pct_threshold_test?.increase_cents, 8_000n); assert.equal(cc.baseline_reset, false);
  assert.equal(h.svc.baselineOf("APP-T6", "recording").baseline_amount_cents, 15_000n); assert.equal(h.svc.baselineOf("APP-T6", "title_settlement").baseline_amount_cents, 55_000n); assert.equal(h.timers.byCode("REGZ_1026_19E4_REVISED_LE_3BD").length, 0);
  h.clock.set(EDT("2026-11-13", "09:00"));
  const { test: t } = h.svc.runToleranceTest({ application_id: "APP-T6", stage: "cd_initial", run_at: h.clock.now(), comparison_disclosure_id: "CD-P1", actuals: PURCHASE_FEES.filter((f) => f.le_section !== "J_lender_credit").map((f) => ({ fee_code: f.fee_code, amount_cents: f.fee_code === "recording" ? 18_000n : f.fee_code === "title_settlement" ? 60_000n : f.amount_cents })), lender_credit_actual_cents: -100_000n });
  assert.equal(t.ten_pct_result.actual_sum_cents, 230_000n); assert.equal(t.ten_pct_result.limit_cents, 244_200n); assert.equal(t.status, "pass"); assert.equal(t.total_excess_cents, 0n);
  // timing check had a reset been permitted: latest receipt for Wed Nov 18 = Fri Nov 13 (Tue 17, Mon 16, Sat 14, Fri 13); a mailed LE learned Thu Nov 12 is deemed received Mon Nov 16 → CD
  assert.equal(latestRevisedLeReceipt(D("2026-11-18")), "2026-11-13");
  assert.equal(fourDayRule({ consummation_on: D("2026-11-18"), cd_delivered_on: null, today: D("2026-11-12"), channel: "mail" }).effective_receipt_date, "2026-11-16");
  assert.equal(fourDayRule({ consummation_on: D("2026-11-18"), cd_delivered_on: null, today: D("2026-11-12"), channel: "mail" }).route, "cd");
  assert.equal(fourDayRule({ consummation_on: D("2026-11-18"), cd_delivered_on: null, today: D("2026-11-09"), channel: "esign_portal", receipt_evidence_on: D("2026-11-09") }).permitted, true);
});
test("21.5-T7: Given consummation Fri Nov 6, 2026, then `latest_receipt` for a revised LE = Mon Nov 2, 2026; a revised LE mailed Fri Oct 30 (deemed received Tue Nov 3: Sat 31, Mon 2, Tue 3) fails the gate and the engine routes the change to the CD; a revised LE e-delivered and viewed Fri Oct 30 passes.", () => {
  assert.equal(latestRevisedLeReceipt(D("2026-11-06")), "2026-11-02");   // Nov 5 (1), Nov 4 (2), Nov 3 (3), Nov 2 (4); Sunday Nov 1 excluded
  assert.deepEqual([1, 2, 3].map((n) => addBusinessDays(D("2026-10-30"), n, regzSpecific)), ["2026-10-31", "2026-11-02", "2026-11-03"]);
  const mailed = fourDayRule({ consummation_on: D("2026-11-06"), cd_delivered_on: null, today: D("2026-10-30"), channel: "mail", issue_on: D("2026-10-30") });
  assert.equal(mailed.latest_receipt, "2026-11-02"); assert.equal(mailed.effective_receipt_date, "2026-11-03"); assert.equal(mailed.permitted, false); assert.equal(mailed.route, "cd");
  const viewed = fourDayRule({ consummation_on: D("2026-11-06"), cd_delivered_on: null, today: D("2026-10-30"), channel: "esign_portal", issue_on: D("2026-10-30"), receipt_evidence_on: D("2026-10-30") });
  assert.equal(viewed.effective_receipt_date, "2026-10-30"); assert.equal(viewed.permitted, true); assert.equal(viewed.route, "le");
  // the gate evaluator: receipt Nov 3 + 4 SBD = Sat Nov 7 → Nov 6 closed; receipt Oct 30 + 4 SBD = Wed Nov 4 → open
  assert.equal(evaluateGate("21.5.revisedLeFourDayGate", { requested_on: "2026-11-06", effective_receipt_date: "2026-11-03", revised_le_version: 3 }).open, false);
  assert.match(revisedLeFourDayGate({ requested_on: "2026-11-06", effective_receipt_date: "2026-11-03" }).reason!, /earlier than 2026-11-07/);
  assert.equal(earliestConsummationAfterRevisedLe(D("2026-10-30")), "2026-11-04"); assert.equal(evaluateGate("21.5.revisedLeFourDayGate", { requested_on: "2026-11-06", effective_receipt_date: "2026-10-30" }).open, true);
  // the engine, mailing: refused with FOUR_DAY_LIMIT, logged, the change routed to the CD (25.2 receives the estimate)
  const h = harness(MST("2026-10-05", "10:41")); h.initialLe("APP-T7", "LE-T7-1", MST("2026-10-05", "10:41"), MST("2026-10-05", "16:10"), MST("2026-10-05", "17:42"));
  h.clock.set(MST("2026-10-29", "09:00")); h.svc.scheduleConsummation("APP-T7", D("2026-11-06"));
  const { cc } = h.appraisalCc("APP-T7", h.clock.now()); assert.equal(cc.four_day_check?.route, "le", "on Oct 29 an e-delivered revised LE can still land in time");
  h.clock.set(MST("2026-10-30", "09:00")); h.revised("APP-T7", "LE-T7-3", [cc.cc_id], "2026-10-30", { fees: feesAsOf("2026-10-30", { appraisal: 85_000n }) });
  assert.throws(() => h.svc.deliverRevisedLE("LE-T7-3", { channel: "mail", mailing_proof_id: "PRINT-1" }), (e: unknown) => e instanceof ToleranceRefused && e.code === "FOUR_DAY_LIMIT" && /received 2026-11-03/.test(e.message));
  const refused = h.emitted("disclosure.le.revised.refused")[0]!; assert.equal(refused.payload.code, "FOUR_DAY_LIMIT"); assert.equal(refused.payload.route, "cd"); assert.equal(refused.payload.latest_receipt, "2026-11-02");
  assert.equal(h.svc.cc(cc.cc_id).reflected_on, "cd"); assert.equal(h.emitted("disclosure.cd.revised_estimate.requested")[0]!.payload.to_process, "25.2"); assert.equal(h.emitted("disclosure.le.revised").length, 0);
  // the engine, e-delivered and viewed Fri Oct 30: passes; the 4-SBD gate row opens for the Nov 6 consummation
  const g = harness(MST("2026-10-05", "10:41")); g.initialLe("APP-T7b", "LE-T7b-1", MST("2026-10-05", "10:41"), MST("2026-10-05", "16:10"), MST("2026-10-05", "17:42"));
  g.clock.set(MST("2026-10-29", "09:00")); g.svc.scheduleConsummation("APP-T7b", D("2026-11-06")); const b = g.appraisalCc("APP-T7b", g.clock.now()).cc;
  g.clock.set(MST("2026-10-30", "09:00")); g.revised("APP-T7b", "LE-T7b-3", [b.cc_id], "2026-10-30", { fees: feesAsOf("2026-10-30", { appraisal: 85_000n }) });
  const row = g.svc.deliverRevisedLE("LE-T7b-3", { channel: "esign_portal", consent: CONSENT, receipt_evidence_at: MST("2026-10-30", "15:12") });
  assert.equal(row.status, "received"); assert.equal(row.effective_receipt_date, "2026-10-30"); assert.equal(row.deemed_receipt_date, "2026-11-03"); assert.equal(row.earliest_consummation_date, "2026-11-04"); assert.ok(row.gate_opened_at);
  const gate = g.timer("REGZ_1026_19E4_REVISED_LE_4SBD_GATE"); assert.equal(gate.anchorDate, "2026-11-03"); assert.equal(gate.status, "satisfied"); assert.equal(g.emitted("gate.revised_le_4sbd.opened")[0]!.payload.earliest_consummation_date, "2026-11-04");
  g.svc.assertGateOpen("APP-T7b", D("2026-11-06")); assert.throws(() => g.svc.assertGateOpen("APP-T7b", D("2026-11-03")), (e: unknown) => e instanceof ToleranceRefused && e.code === "REGZ_1026_19E4_REVISED_LE_4SBD_GATE");
  assert.equal(g.timer("REGZ_1026_19E4_REVISED_LE_3BD").status, "satisfied");
});
test("21.5-T8: Given the CD was delivered Mon Nov 2, 2026, when a valid changed circumstance is recorded Tue Nov 3, then `issueRevisedLE` is refused, `reflected_on='corrected_cd'`, 25.2 receives the estimate, and the 3-day clock (due Fri Nov 6) is satisfied by the corrected CD delivered Nov 4.", () => {
  const h = harness(MST("2026-10-05", "10:41")); h.initialLe("APP-T8", "LE-T8-1", MST("2026-10-05", "10:41"), MST("2026-10-05", "16:10"), MST("2026-10-05", "17:42"));
  h.cdDelivered("APP-T8", MST("2026-11-02", "10:00")); assert.equal(h.svc.facts("APP-T8").cd_delivered_on, "2026-11-02");
  h.clock.set(MST("2026-11-03", "11:00")); h.svc.scheduleConsummation("APP-T8", D("2026-11-06"));
  const { cc, event } = h.appraisalCc("APP-T8", h.clock.now());
  assert.equal(cc.valid, true); assert.equal(event.type, "changed_circumstance.recorded"); assert.equal(cc.reflected_on, "corrected_cd"); assert.equal(cc.four_day_check?.route, "corrected_cd"); assert.match(cc.four_day_check!.reason, /no revised Loan Estimate on or after that date/);
  assert.equal(h.svc.baselineOf("APP-T8", "appraisal").baseline_amount_cents, 85_000n, "a valid basis still resets; the CD carries the revised estimate");
  const handoff = h.emitted("disclosure.cd.revised_estimate.requested")[0]!; assert.equal(handoff.payload.cc_id, cc.cc_id); assert.equal(handoff.payload.route, "corrected_cd"); assert.equal(handoff.payload.to_process, "25.2"); assert.deepEqual(handoff.payload.amounts, { appraisal: "85000" });
  assert.throws(() => h.revised("APP-T8", "LE-T8-3", [cc.cc_id], "2026-11-03"), (e: unknown) => e instanceof ToleranceRefused && e.code === "NO_REVISED_LE_AFTER_CD");
  assert.equal(h.emitted("disclosure.le.revised.refused")[0]!.payload.code, "NO_REVISED_LE_AFTER_CD"); assert.equal(h.emitted("disclosure.le.rendered").length, 1, "only LE v1 was ever rendered");
  const t = h.timer("REGZ_1026_19E4_REVISED_LE_3BD"); assert.equal(t.status, "armed"); assert.equal(t.anchorDate, "2026-11-03"); assert.equal(t.dueDate, "2026-11-06");   // Wed 4, Thu 5, Fri Nov 6
  assert.equal(cc.revised_le_due_at, MST("2026-11-06", "23:59"));
  // 25.2's corrected CD delivered Wed Nov 4 naming the row satisfies the clock
  h.events.append({ type: "disclosure.cd.corrected", applicationId: "APP-T8", actor: CD_AGENT, occurredAt: MST("2026-11-04", "09:30"), payload: { application_id: "APP-T8", disclosure_id: "CD-2", kind: "corrected_cd", version: 2, reason: "changed_circumstance", cc_ids: [cc.cc_id], delivered_at: MST("2026-11-04", "09:30"), issued_on: "2026-11-04" } });
  assert.equal(t.status, "satisfied"); assert.equal(t.satisfiedAt, MST("2026-11-04", "09:30"));
  const reflected = h.emitted("changed_circumstance.reflected")[0]!; assert.equal(reflected.payload.reflected_on, "corrected_cd"); assert.equal(reflected.payload.disclosure_id, "CD-2");
  assert.equal(h.svc.cc(cc.cc_id).status, "reflected_on_cd"); assert.equal(h.svc.cc(cc.cc_id).revised_le_disclosure_id, "CD-2");
});
test("21.5-T9: Given a $200.00 excess discovered by post-closing QC on Fri Nov 20, 2026 for a loan consummated Fri Nov 6, then `REGZ_1026_19F2V_TOLERANCE_REFUND_60` is due Tue Jan 5, 2027, the refund is sent by ACH by that date, and 25.2's corrected CD is delivered or mailed by that date; a refund sent Jan 6 breaches.", () => {
  assert.equal(refundDueOn(D("2026-11-06")), "2027-01-05"); assert.equal(addDays(D("2026-11-06"), 60), "2027-01-05");
  const run = (refundSentAt: string) => {
    const h = harness(MST("2026-10-05", "10:41")); h.initialLe("APP-T9", "LE-T9-1", MST("2026-10-05", "10:41"), MST("2026-10-05", "16:10"), MST("2026-10-05", "17:42"));
    h.cdDelivered("APP-T9", MST("2026-11-02", "10:00"));
    h.events.append({ type: "closing.consummated", applicationId: "APP-T9", actor: { kind: "agent", id: "closing" }, occurredAt: MST("2026-11-06", "14:00"), payload: { application_id: "APP-T9", consummation_at: MST("2026-11-06", "14:00"), consummation_on: "2026-11-06" } });
    const t = h.timer("REGZ_1026_19F2V_TOLERANCE_REFUND_60"); assert.equal(t.status, "armed"); assert.equal(t.anchorDate, "2026-11-06"); assert.equal(t.dueDate, "2027-01-05");
    // post-closing QC Fri Nov 20: the $850 appraisal against the $650 baseline (the invalid rate-card row never reset it) → refund_required $200.00
    h.clock.set(MST("2026-11-20", "10:00"));
    const { test: q } = h.svc.runToleranceTest({ application_id: "APP-T9", stage: "qc", run_at: h.clock.now(), comparison_disclosure_id: "CD-1", actuals: h.actuals({ appraisal: 85_000n }), lender_credit_actual_cents: -261_700n });
    assert.equal(q.status, "refund_required"); assert.equal(q.total_excess_cents, 20_000n); assert.equal(q.cure_route, "refund_post_consummation");
    assert.equal(h.ledger.balance(BORROWER_REFUNDS_PAYABLE), -20_000n); assert.equal(h.ledger.balance(TOLERANCE_CURE_EXPENSE), 20_000n);
    assert.throws(() => h.svc.applyCure(q.test_id, { funded_by: "sm", cd_disclosure_id: "CD-1" }), (e: unknown) => e instanceof ToleranceRefused && e.code === "CURE_AT_CLOSING_ONLY");
    assert.throws(() => h.svc.closeRefundWindow("APP-T9"), (e: unknown) => e instanceof ToleranceRefused && e.code === "REFUND_OUTSTANDING", "the window cannot close trivially while an excess is unrefunded");
    assert.throws(() => h.svc.issueRefund(q.test_id, { instrument: "ach", sent_at: refundSentAt, funded_by: "sm", released_by: { kind: "human", id: "u-analyst", role: "ops_analyst" } }), (e: unknown) => e instanceof ToleranceRefused && e.code === "OFFICER_RELEASE");
    h.clock.set(refundSentAt);
    const r = h.svc.issueRefund(q.test_id, { instrument: "ach", sent_at: refundSentAt, funded_by: "sm", released_by: OFFICER });
    assert.equal(r.due_on, "2027-01-05"); assert.equal(r.cure.amount_cents, 20_000n); assert.equal(r.cure.refund_instrument, "ach"); assert.equal(h.ledger.balance(BORROWER_REFUNDS_PAYABLE), 0n, "borrower_refunds_payable cleared"); assert.equal(h.ledger.balance(CORPORATE_CASH), -20_000n);
    assert.equal(h.emitted("disclosure.cd.correction.requested")[0]!.payload.reason, "tolerance_refund"); assert.equal(h.svc.test(q.test_id).status, "refunded");
    return { h, t, r };
  };
  // refund by ACH Tue Jan 5, 2027 and 25.2's corrected CD delivered the same day: both duties recorded → satisfied
  const a = run(MST("2027-01-05", "09:00"));
  assert.equal(a.t.status, "armed", "the refund alone does not satisfy the row (two duties)"); assert.equal(a.h.emitted("tolerance.refund.issued")[0]!.payload.late, false);
  a.h.events.append({ type: "disclosure.cd.corrected", applicationId: "APP-T9", actor: CD_AGENT, occurredAt: MST("2027-01-05", "15:00"), payload: { application_id: "APP-T9", disclosure_id: "CD-3", kind: "corrected_cd", version: 3, reason: "tolerance_refund", cure_id: a.r.cure.cure_id, delivered_at: MST("2027-01-05", "15:00"), issued_on: "2027-01-05" } });
  assert.equal(a.t.status, "satisfied"); const done = a.h.emitted("tolerance.refund.completed")[0]!; assert.equal(done.payload.refund_sent, true); assert.equal(done.payload.corrected_cd_delivered, true);
  assert.deepEqual(a.h.timers.evaluate(MST("2027-01-06", "09:00")).filter((x) => x.instance.code === "REGZ_1026_19F2V_TOLERANCE_REFUND_60"), []);
  // a refund sent Wed Jan 6 breaches: the row is overdue at 23:59 on Jan 5; sev 1 to the partner officer; the refund still issues (late)
  const b = run(MST("2027-01-06", "09:00"));
  const breaches = b.h.timers.evaluate(MST("2027-01-06", "09:00")).filter((x) => x.instance.code === "REGZ_1026_19F2V_TOLERANCE_REFUND_60"); assert.equal(breaches.length, 1); assert.equal(breaches[0]!.severity, 1); assert.ok(breaches[0]!.escalateTo.includes("officer"));
  assert.equal(b.t.status, "breached"); assert.equal(b.h.emitted("tolerance.refund.issued")[0]!.payload.late, true);
});
test("21.5-T10: Given the lender credit baseline −$2,617 and a CD showing −$2,417, then `shortfall` = 20,000 cents and the cure restores the credit to at least −$2,617.", () => {
  assert.equal(lenderCreditShortfall(-261_700n, -241_700n), 20_000n); assert.equal(lenderCreditShortfall(-261_700n, -261_700n), 0n); assert.equal(lenderCreditShortfall(-261_700n, -281_700n), 0n, "raising the credit is never an increase");
  assert.throws(() => lenderCreditShortfall(261_700n, -241_700n), RangeError);
  const t = toleranceTest(baselineItems(), { application_id: "APP-T10", stage: "cd_initial", run_at: MST("2026-11-02", "09:00"), comparison_disclosure_id: "CD-1", actuals: FEES.filter((f) => f.le_section !== "J_lender_credit").map((f) => ({ fee_code: f.fee_code, amount_cents: f.amount_cents })), lender_credit_actual_cents: -241_700n });
  assert.deepEqual(t.lender_credit_result, { baseline_cents: -261_700n, actual_cents: -241_700n, shortfall_cents: 20_000n }); assert.equal(t.total_excess_cents, 20_000n); assert.equal(t.status, "cure_required");
  // the cure is a further lender credit equal to the shortfall: −2,417 − 200 = −2,617, never less than the baseline
  const h = harness(MST("2026-10-05", "10:41")); h.initialLe("APP-T10", "LE-T10", MST("2026-10-05", "10:41"), MST("2026-10-05", "16:10"), MST("2026-10-05", "17:42")); h.clock.set(MST("2026-11-02", "09:00"));
  const r = h.svc.runToleranceTest({ application_id: "APP-T10", stage: "cd_initial", run_at: h.clock.now(), comparison_disclosure_id: "CD-1", actuals: h.actuals(), lender_credit_actual_cents: -241_700n });
  assert.equal(r.test.lender_credit_result.shortfall_cents, 20_000n);
  const { cure } = h.svc.applyCure(r.test.test_id, { funded_by: "partner", cd_disclosure_id: "CD-1" });
  assert.equal(cure.amount_cents, 20_000n); assert.ok(-241_700n - cure.amount_cents <= -261_700n); assert.equal(-241_700n - cure.amount_cents, -261_700n); assert.equal(cure.funded_by, "partner");
  // guardrail: a revised LE may never carry a lower credit
  h.clock.set(MST("2026-10-20", "14:30")); const { cc } = h.appraisalCc("APP-T10", h.clock.now());
  assert.throws(() => h.revised("APP-T10", "LE-T10-2", [cc.cc_id], "2026-10-20", { fees: feesAsOf("2026-10-20", { appraisal: 85_000n, lender_credit: -241_700n }) }), (e: unknown) => e instanceof ToleranceRefused && e.code === "NO_LENDER_CREDIT_REDUCTION");
  const raised = h.revised("APP-T10", "LE-T10-2", [cc.cc_id], "2026-10-20", { fees: feesAsOf("2026-10-20", { appraisal: 85_000n, lender_credit: -281_700n }) }); assert.equal(raised.totals.lender_credits_cents, -281_700n, "raising the credit is fine");
});
test("21.5-T11: Given the borrower first indicates intent Thu Oct 22, 2026 09:00 after the Oct 20 5:00 p.m. expiration, then basis (E) is recorded, all baselines reset to Oct 22 estimates on LE v2 due Tue Oct 27, and the 21.4 fee gate opens on Oct 22 regardless.", () => {
  const h = harness(MST("2026-10-05", "10:41")); const v1 = h.initialLe("APP-T11", "LE-T11-1", MST("2026-10-05", "10:41"), MST("2026-10-05", "16:10"), MST("2026-10-05", "17:42"));
  assert.equal(v1.closing_costs_expire_at, MST("2026-10-20", "17:00")); assert.equal(h.svc.facts("APP-T11").costs_expire_at, MST("2026-10-20", "17:00"));
  const intentAt = MST("2026-10-22", "09:00"); h.clock.set(intentAt);
  assert.equal(h.le.costsExpired("LE-T11-1", intentAt), true, "the offer expired Tue Oct 20 5:00 p.m. MST with no intent");
  h.events.append({ type: "intent.to_proceed.received", applicationId: "APP-T11", aggregate: { kind: "application", id: "APP-T11" }, actor: PRICING, occurredAt: intentAt, payload: { application_id: "APP-T11", intent_id: "INT-1", disclosure_id: "LE-T11-1", channel: "app_button", valid: true, received_at: intentAt, le_effective_receipt_date: "2026-10-05" } });
  assert.equal(h.svc.facts("APP-T11").intent_at, intentAt);
  // basis (E): the agent re-prices every fee from current sources — a new offer
  const { cc, evaluation } = h.svc.recordChangedCircumstance({ application_id: "APP-T11", basis: "E", narrative: "the consumer indicated an intent to proceed more than 10 business days after the disclosures were provided (offer expired 2026-10-20 17:00 MST; intent 2026-10-22 09:00 MST): re-priced from current sources", evidence_document_ids: ["INT-1"], information_received_at: intentAt,
    revised: [{ fee_code: "appraisal", amount_cents: 67_500n }, { fee_code: "title_lenders_policy", amount_cents: 118_000n }, { fee_code: "recording", amount_cents: 7_200n }, { fee_code: "prepaid_interest", amount_cents: prepaidInterest(56_000_000n, "6.125", 18).total_cents }] });
  assert.equal(cc.basis, "E"); assert.equal(cc.kind, "le_expired"); assert.equal(evaluation.reset_scope, "all"); assert.equal(cc.valid, true);
  assert.equal(cc.revised_le_due_on, "2026-10-27"); assert.equal(cc.revised_le_due_at, MST("2026-10-27", "23:59"));   // Fri 23, Mon 26, Tue Oct 27
  const t = h.timer("REGZ_1026_19E4_REVISED_LE_3BD"); assert.equal(t.anchorDate, "2026-10-22"); assert.equal(t.dueDate, "2026-10-27");
  assert.equal(h.svc.baselineOf("APP-T11", "appraisal").baseline_amount_cents, 67_500n); assert.equal(h.svc.baselineOf("APP-T11", "title_lenders_policy").baseline_amount_cents, 118_000n); assert.equal(h.svc.baselineOf("APP-T11", "recording").baseline_amount_cents, 7_200n); assert.equal(h.svc.baselineOf("APP-T11", "prepaid_interest").baseline_amount_cents, 169_146n);
  assert.equal(bucketBaselineSum(h.svc.baseline("APP-T11")), 189_700n, "the bucket baseline is the Oct 22 estimate"); assert.equal(cc.affected_fee_codes.length, FEES.length, "every item is in scope");
  assert.deepEqual(h.emitted("fee.baseline.reset")[0]!.payload.fee_codes, ["appraisal", "title_lenders_policy", "recording", "prepaid_interest"]);
  // LE v2 within the clock with a new expiration (open question 4): rendered Oct 23 with the Oct 22 estimates
  h.clock.set(MST("2026-10-23", "09:00"));
  const v2 = h.revised("APP-T11", "LE-T11-2", [cc.cc_id], "2026-10-23", { pricing: PRICING_Q, fees: feesAsOf("2026-10-23", { appraisal: 67_500n, title_lenders_policy: 118_000n, recording: 7_200n, prepaid_interest: 169_146n }), costs_expire_at: MST("2026-11-06", "17:00") });
  assert.equal(v2.le_version, 2); assert.equal(v2.reason, "le_expired"); assert.equal(v2.costs_expire_at, MST("2026-11-06", "17:00"), "intent arrived after the period: the new offer states a new expiration");
  h.svc.deliverRevisedLE("LE-T11-2", { channel: "esign_portal", consent: CONSENT }); assert.equal(t.status, "satisfied");
  // 21.4's fee gate opens on the intent regardless of the expiration
  const intent: IntentRecord = { intent_id: "INT-1", application_id: "APP-T11", disclosure_id: "LE-T11-1", le_effective_receipt_date: D("2026-10-05"), received_at: intentAt, channel: "app_button", statement_text: "I want to proceed", evidence_document_id: "DOC-INT-1", recorded_by: "agent:pricing", valid: true, withdrawn_at: null };
  const gate = evaluateFeeGate({ application_id: "APP-T11", command: "order_appraisal", fee_kind: "appraisal", amount_cents: 67_500n, checked_at: MST("2026-10-22", "09:05"), le_effective_receipt_date: D("2026-10-05"), intent });
  assert.equal(gate.result, "open"); assert.equal(gate.collected_cents, 67_500n);
  assert.equal(evaluateFeeGate({ ...{ application_id: "APP-T11", command: "order_appraisal", fee_kind: "appraisal", amount_cents: 67_500n, le_effective_receipt_date: D("2026-10-05") }, checked_at: MST("2026-10-21", "09:05"), intent: null }).result, "closed_no_intent");
});
test("21.5-T12: Given a valid changed circumstance whose revised LE is delivered one creditor business day late, then the timer breach withdraws the reset, the CD-stage test uses the original baseline, and the excess is cured — with an incident record for the exam file.", () => {
  const h = harness(MST("2026-10-05", "10:41")); h.initialLe("APP-T12", "LE-T12-1", MST("2026-10-05", "10:41"), MST("2026-10-05", "16:10"), MST("2026-10-05", "17:42"));
  const at = MST("2026-10-20", "14:30"); h.clock.set(at); const { cc } = h.appraisalCc("APP-T12", at);
  assert.equal(h.svc.baselineOf("APP-T12", "appraisal").baseline_amount_cents, 85_000n); const t = h.timer("REGZ_1026_19E4_REVISED_LE_3BD"); assert.equal(t.dueDate, "2026-10-23");
  // Mon Oct 26 (one creditor business day after the Fri Oct 23 deadline): the clock breaches — sev 1, the reset is withdrawn, an incident for the exam file
  h.clock.set(MST("2026-10-26", "09:00"));
  const breaches = h.timers.evaluate(h.clock.now()).filter((x) => x.instance.code === "REGZ_1026_19E4_REVISED_LE_3BD"); assert.equal(breaches.length, 1);   // 21.2's cost-expiry row breaches too in this fixture (no intent); only the 21.5 clock is under test assert.equal(breaches[0]!.severity, 1); assert.ok(breaches[0]!.escalateTo.includes("compliance-sentinel") && breaches[0]!.escalateTo.includes("officer"));
  const b = h.svc.onRevisedLeBreached(cc.cc_id, h.clock.now());
  assert.deepEqual([...b.reset_withdrawn], ["appraisal"]); assert.deepEqual([...b.escalated_to], ["compliance-sentinel", "officer"]); assert.equal(b.incident_id, `INC-REVLE3BD-APP-T12-${cc.cc_id.slice(0, 8)}`);
  assert.equal(h.svc.baselineOf("APP-T12", "appraisal").baseline_amount_cents, 65_000n, "the original baseline governs"); assert.equal(h.svc.baselineOf("APP-T12", "appraisal").baseline_reset_cc_id, null); assert.equal(h.svc.cc(cc.cc_id).baseline_reset, false);
  assert.equal(h.emitted("fee.baseline.reset.withdrawn")[0]!.payload.cc_id, cc.cc_id); assert.equal(h.emitted("compliance.incident.opened")[0]!.payload.exam_file, true);
  const sev1 = h.escalations.list().find((e) => e.kind === "sev1")!; assert.equal(sev1.severity, "1"); assert.equal(sev1.applicationId, "APP-T12"); assert.equal(sev1.payload.root_cause_required, true);
  assert.deepEqual(h.svc.incidents("APP-T12").map((x) => x.code), ["REGZ_1026_19E4_REVISED_LE_3BD"]);
  // the revised disclosure still issues (late); the clock closes satisfied_late
  h.revised("APP-T12", "LE-T12-3", [cc.cc_id], "2026-10-26", { fees: feesAsOf("2026-10-26", { appraisal: 85_000n }) });
  const row = h.svc.deliverRevisedLE("LE-T12-3", { channel: "esign_portal", consent: CONSENT }); assert.equal(row.late, true); assert.equal(t.status, "satisfied_late"); assert.equal(h.emitted("changed_circumstance.reflected")[0]!.payload.late, true);
  // CD stage Mon Nov 2: the $850 appraisal against the $650 baseline → excess 20,000 cents cured on the CD; the closing is not blocked
  h.clock.set(MST("2026-11-02", "09:00"));
  const { test: cd } = h.svc.runToleranceTest({ application_id: "APP-T12", stage: "cd_initial", run_at: h.clock.now(), comparison_disclosure_id: "CD-1", actuals: h.actuals({ appraisal: 85_000n }), lender_credit_actual_cents: -261_700n });
  assert.equal(cd.zero_results.find((z) => z.fee_code === "appraisal")!.baseline_cents, 65_000n); assert.equal(cd.total_excess_cents, 20_000n); assert.equal(cd.status, "cure_required");
  const { cure } = h.svc.applyCure(cd.test_id, { funded_by: "sm", cd_disclosure_id: "CD-1" }); assert.equal(cure.amount_cents, 20_000n); assert.equal(h.svc.test(cd.test_id).status, "cured_at_closing");
  assert.equal(h.escalations.list().filter((e) => e.kind === "sev1").length, 1); assert.equal(h.svc.decisionRecord({ cc_id: cc.cc_id, test_id: cd.test_id, application_id: "APP-T12", model_version: "m1", prompt_version: "p1", rationale: "late revised LE; original baseline; cure" }).cure_cents, "20000");
});

test("21.5 worked figures: bucket 186,500 → limit $2,051.50 and threshold $186.50; CD 1,150 + 700 + 150 + 70 + 75 = $2,145.00 → $93.50 cure; purchase bucket 222,000 → $2,442.00 / $222.00; 18 days × $93.97 = $1,691.46; $575,000 at 6.125 % → P&I $3,493.76 (basis C, due Thu Oct 29); the $200.00 cure and Tue Jan 5, 2027 refund", () => {
  const items = baselineItems();
  assert.equal(tenPercentLimitCents(186_500n), 205_150n);   // $2,051.50
  assert.equal(resetThresholdCents(186_500n), 18_650n);     // $186.50
  const cd = toleranceTest(items, { application_id: "APP-WF", stage: "cd_initial", run_at: MST("2026-11-02", "09:00"), comparison_disclosure_id: "CD-1", lender_credit_actual_cents: -261_700n, actuals: [...FEES.filter((f) => f.le_section !== "J_lender_credit").map((f) => ({ fee_code: f.fee_code, amount_cents: f.fee_code === "title_settlement" ? 70_000n : f.amount_cents })), { fee_code: "title_cpl", amount_cents: 7_500n, item: CPL(7_500n) }] });
  assert.equal(cd.ten_pct_result.actual_sum_cents, 214_500n);   // $2,145.00 = 1,150 + 700 + 150 + 70 + 75
  assert.equal(cd.ten_pct_result.excess_cents, 9_350n); assert.equal(cureStatement(cd.total_excess_cents), "Includes $93.50 credit for increase in closing costs above legal limit");
  assert.equal(tenPercentLimitCents(222_000n), 244_200n);   // $2,442.00
  assert.equal(resetThresholdCents(222_000n), 22_200n);     // $222.00
  // rule 4: a Nov 13 disbursement gives 18 days × $93.97 = $1,691.46 — a decrease, no issue (LE v1: 19 days = $1,785.43)
  const pp = prepaidInterest(56_000_000n, "6.125", 18); assert.equal(pp.per_diem_cents, 9_397n); assert.equal(pp.total_cents, 169_146n); assert.equal(prepaidInterest(56_000_000n, "6.125", 19).total_cents, 178_543n);
  assert.equal(classifyFeeChange(FEES.find((f) => f.fee_code === "prepaid_interest")!, 169_146n).direction, "decrease");
  // worked example 3: basis (C) — loan amount $560,000 → $575,000: P&I $3,493.76 (from $3,402.62); title $1,150 → $1,180 is a $30 bucket increase < $186.50 → no bucket reset; due Mon Oct 26 + 3 creditor BD = Thu Oct 29
  assert.equal(amortize(57_500_000n, "6.125", 360).pi_cents, 349_376n); assert.equal(amortize(56_000_000n, "6.125", 360).pi_cents, 340_262n);
  const c = evaluateChangedCircumstance(items, { basis: "C", narrative: "the consumer requests revisions to the credit terms: loan amount $560,000 → $575,000; title premium rises with the amount", evidence_document_ids: ["DOC-REQ-1026"], information_received_at: MST("2026-10-26", "10:00"), revised: [{ fee_code: "title_lenders_policy", amount_cents: 118_000n }] });
  assert.equal(c.valid, false); assert.equal(c.threshold_test?.increase_cents, 3_000n); assert.equal(c.threshold_test?.exceeds, false); assert.equal(c.reset_scope, "none");
  assert.equal(revisedLeDueAt(MST("2026-10-26", "10:00")).due_on, "2026-10-29");   // Tue 27, Wed 28, Thu Oct 29
  // the counterfactual cure and the 60-day refund
  const inv = toleranceTest(items, { application_id: "APP-WF", stage: "cd_initial", run_at: MST("2026-11-02", "09:00"), comparison_disclosure_id: "CD-1", lender_credit_actual_cents: -261_700n, actuals: FEES.filter((f) => f.le_section !== "J_lender_credit").map((f) => ({ fee_code: f.fee_code, amount_cents: f.fee_code === "appraisal" ? 85_000n : f.amount_cents })) });
  assert.equal(inv.total_excess_cents, 20_000n); assert.equal(cureStatement(inv.total_excess_cents), "Includes $200.00 credit for increase in closing costs above legal limit"); assert.equal(refundDueOn(D("2026-11-06")), "2027-01-05");
  // the 21.2 figures the tests above lean on: lender credit −$2,617 = B $822 + C $1,795; ten-percent baseline $1,865
  assert.equal(items.find((f) => f.fee_code === "lender_credit")!.baseline_amount_cents, -261_700n); assert.equal(bucketBaselineSum(items), 186_500n);
});

test("21.5 integrations: 30.3's `escrow.waiver.decided{origin=origination, le_revision}` becomes a basis (C) row with the waiver fee as a new zero item; the escalated cure SLA; the tools on the bus", async () => {
  const h = harness(MST("2026-10-05", "10:41")); h.initialLe("APP-INT", "LE-INT-1", MST("2026-10-05", "10:41"), MST("2026-10-05", "16:10"), MST("2026-10-05", "17:42"));
  h.clock.set(MST("2026-10-14", "11:00"));
  h.events.append({ type: "escrow.waiver.decided", applicationId: "APP-INT", actor: { kind: "agent", id: "escrow" }, occurredAt: h.clock.now(), payload: { application_id: "APP-INT", waiver_id: "WV-1", origin: "origination", decision: "approved", decided_on: "2026-10-14", basis_document_id: "DOC-WV-WORKSHEET-1", le_revision: { changed_circumstance: "borrower_request", process: "21.5", escrow_waiver_fee_cents: "140000", escrowed: false, property_costs_year1_cents: "660000", line_label: "Escrow Waiver Fee" } } });
  const cc = [...h.emitted("changed_circumstance.recorded")].map((e) => h.svc.cc(String(e.payload.cc_id))).find((c) => c.basis === "C")!;
  assert.equal(cc.kind, "borrower_request"); assert.equal(cc.valid, true); assert.equal(cc.revised_le_due_on, "2026-10-19");   // Thu 15, Fri 16, Mon Oct 19
  assert.equal(h.svc.baselineOf("APP-INT", "escrow_waiver_fee").tolerance_class, "zero"); assert.equal(h.svc.baselineOf("APP-INT", "escrow_waiver_fee").baseline_amount_cents, 140_000n); assert.equal(h.svc.baselineOf("APP-INT", "escrow_taxes").current_amount_cents, 0n); assert.equal(h.svc.baselineOf("APP-INT", "escrow_taxes").baseline_amount_cents, 120_000n, "a decrease on an unlimited item is not reset");
  assert.equal(h.timer("REGZ_1026_19E4_REVISED_LE_3BD").dueDate, "2026-10-19");
  // a cure above $500 is posted and escalated: SM_TOLERANCE_CURE_REVIEW_SLA_1BD arms on run_on, satisfied by the compliance-sentinel review
  h.clock.set(MST("2026-11-02", "09:00"));
  const { test: big } = h.svc.runToleranceTest({ application_id: "APP-INT", stage: "cd_initial", run_at: h.clock.now(), comparison_disclosure_id: "CD-1", actuals: h.actuals({ appraisal: 65_000n + 60_000n }), lender_credit_actual_cents: -261_700n });
  assert.equal(big.status, "escalated"); assert.equal(big.total_excess_cents, 60_000n); assert.equal(big.cure_route, "lender_credit_at_closing");
  const sla = h.timer("SM_TOLERANCE_CURE_REVIEW_SLA_1BD"); assert.equal(sla.status, "armed"); assert.equal(sla.anchorDate, "2026-11-02"); assert.equal(sla.dueDate, "2026-11-03");
  assert.ok(h.escalations.list().some((e) => e.kind === "sev2" && e.ownerRole === "compliance"));
  h.svc.applyCure(big.test_id, { funded_by: "sm", cd_disclosure_id: "CD-1" }); assert.equal(h.svc.test(big.test_id).status, "cured_at_closing", "the cure still posts");
  h.svc.recordCureReview(big.test_id, { reviewer_id: "u-sentinel", outcome: "root_cause_recorded" }); assert.equal(sla.status, "satisfied");
  // the tools: every agents.json string is on the bus for the `disclosure` agent; missing input is a RangeError; guardrails refuse the never-sentences
  const agents = new AgentRegistry(); const store = new EntityStore();
  const ctx: UowContext = { loanId: "", applicationId: "APP-INT", events: h.events, ledger: h.ledger, timers: h.timers, clock: h.clock, decide: () => {} };
  const rt: ToolRuntime = { store, escalations: h.escalations, services: { tolerance: h.svc }, ports: {} };
  const cmds = bind21_5(rt, agents); const bus = new CommandBus(agents); const DISCLOSURE: Actor = { kind: "agent", id: "disclosure" };
  const exec = (name: string, input: ToolInput) => bus.execute(cmds.get(toolKey("21.5", name))!, DISCLOSURE, input, { ...ctx, actor: DISCLOSURE, now: h.clock.now() } as never);
  assert.deepEqual([...cmds.keys()].map((k) => k.split(" ")[1]).sort(), ["applyCure", "checkFourDayRule", "classifyFeeChange", "computeRevisedLEDueDate", "deliverDisclosure", "evaluateChangedCircumstance", "issueRefund", "reflectOnCD", "renderRevisedLE", "resetBaseline", "runToleranceTest", "writeDecision"]);
  const due = (await exec("computeRevisedLEDueDate", { information_received_at: MST("2026-10-20", "14:30") })).output as { due_on: string; due_at: string }; assert.equal(due.due_on, "2026-10-23"); assert.equal(due.due_at, MST("2026-10-23", "23:59"));
  const four = (await exec("checkFourDayRule", { application_id: "APP-INT", today: "2026-10-30", channel: "mail", consummation_on: "2026-11-06" })).output as { route: string; latest_receipt: string }; assert.equal(four.route, "cd"); assert.equal(four.latest_receipt, "2026-11-02");
  await assert.rejects(exec("resetBaseline", {}), (e: unknown) => e instanceof RangeError);
  await assert.rejects(exec("evaluateChangedCircumstance", { application_id: "APP-INT", basis: "A3", narrative: "our own estimation error on the appraisal", information_received_at: h.clock.now(), revised: [{ fee_code: "appraisal", amount_cents: "85000" }], declare_valid: true }), (e: unknown) => /NOT_A_CHANGED_CIRCUMSTANCE/.test((e as Error).message));
  await assert.rejects(exec("applyCure", { test_id: big.test_id, cd_disclosure_id: "CD-1", funded_by: "borrower" }), (e: unknown) => /NO_BORROWER_FUNDED_CURE/.test((e as Error).message));
  await assert.rejects(exec("renderRevisedLE", { application_id: "APP-INT", disclosure_id: "LE-X", as_of: "2026-11-03", cd_delivered_on: "2026-11-02" }), (e: unknown) => /NO_REVISED_LE_AFTER_CD/.test((e as Error).message));
  const tt = (await exec("runToleranceTest", { application_id: "APP-INT", stage: "pre_funding", comparison_disclosure_id: "CD-2", actuals: h.actuals({ appraisal: 65_000n }).map((a) => ({ ...a, amount_cents: a.amount_cents.toString() })), lender_credit_actual_cents: "-261700" })).output as { test: { status: string } }; assert.equal(tt.test.status, "pass");
});
