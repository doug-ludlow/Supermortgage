// 25.1 Compliance testing engine (APR/finance charge, TRID tolerances, QM/ATR, HPML, HOEPA, state high-cost, fee reasonableness, RESPA §8, LO compensation and steering, licensing/NMLSR, E-SIGN, fair-lending pricing exceptions, TCPA) and the compliance gates
// spec/sections/25-compliance-testing-the-closing-disclosure-rescission-and-clo/25-1-compliance-testing-engine-apr-finance-charge-trid-tolerances.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { plainDate as D, addDays, type PlainDate } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, type Actor } from "../../kernel/events/index.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { EscalationService } from "../../app/escalations.ts";
import { Decimal } from "../../kernel/money/decimal.ts";
import { centsToDecimal, ratePercent } from "../../kernel/money/cents.ts";
import { computeApr, countFirstPeriod, toleranceApplied, aprAccuracyTest, financeChargeAccuracyTest, classifyFinanceCharges, prepaidFinanceCharges, pointsAndFees, totalLoanAmount, pctOf, determineQm, determineHpml, determineHoepa, evaluateStateHighCost, checkLicenses, effectiveLicense, steeringOptionsTest, pricingExceptionTest, reviewPricingException, checkRespa8, esignConsentTest,
  runTestSuite, deriveGate, evaluateComplianceGate, assertGateOpen, ComplianceGateBlocked, requestWaiver, testDefinition, ruleSet, aporAsOf, prepaidInterest, perDiem365Rounded, APR_CURE_PLAN, GATES,
  type AprCalculation, type ComplianceSnapshot, type FeeItemInput, type LicenseCheck, type LoanOptionsPresented, type ComplianceTestRow, type QmRuleSet, type HoepaRuleSet, type HpmlRuleSet } from "./ops-25-1.ts";
import { EVALUATORS_25_1 } from "./evaluators-25-1.ts";

const AGENT: Actor = { kind: "agent", id: "compliance-tester" };
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
const APP = "APP-REFI-1";
/** The refinance fixture: $560,000.00, 6.125%, 360, Phoenix AZ; disbursement Thu Nov 12, 2026; first payment Fri Jan 1, 2027; PFC $3,849.95 incl. prepaid interest $1,785.43 (26.3 `365_rounded_per_diem`). */
const FIXTURE = { loan_amount_cents: 56_000_000n, note_rate_pct: "6.125", term_months: 360, term_start_date: D("2026-11-12"), first_payment_date: D("2027-01-01"), prepaid_finance_charges_cents: 384_995n, prepaid_interest_cents: 178_543n } as const;
const FIXTURE_APR: AprCalculation = computeApr({ ...FIXTURE, method: "appendix_j_exact", checkpoint: "cd" });

/** Fixture fee set from the 25.1 classification table (prepaid finance charges: prepaid interest, underwriting, tax service, MERS, flood life-of-loan). */
const fees = (over: Partial<Record<string, Partial<FeeItemInput>>> = {}, extra: FeeItemInput[] = []): FeeItemInput[] => {
  const base: FeeItemInput[] = [
    { fee_item_id: "F-INT", service_code: "interest_prepaid", amount_cents: 178_543n, paid_to: "Partner Bank, N.A.", paid_to_kind: "creditor" },
    { fee_item_id: "F-UW", service_code: "underwriting", amount_cents: 195_000n, paid_to: "Partner Bank, N.A.", paid_to_kind: "creditor", creditor_retains_portion: true },
    { fee_item_id: "F-TAX", service_code: "tax_service", amount_cents: 8_400n, paid_to: "TaxServ Inc", paid_to_kind: "third_party", creditor_requires_service: true },
    { fee_item_id: "F-MERS", service_code: "mers_registration", amount_cents: 2_495n, paid_to: "MERSCORP", paid_to_kind: "third_party" },
    { fee_item_id: "F-FLOL", service_code: "flood_life_of_loan", amount_cents: 557n, paid_to: "FloodCo", paid_to_kind: "third_party", creditor_requires_service: true },
    { fee_item_id: "F-FDET", service_code: "flood_determination", amount_cents: 900n, paid_to: "FloodCo", paid_to_kind: "third_party", creditor_requires_service: true },
    { fee_item_id: "F-APPR", service_code: "appraisal", amount_cents: 55_000n, paid_by: "sm", paid_to: "Phoenix AMC", paid_to_kind: "third_party" },
    { fee_item_id: "F-CR", service_code: "credit_report", amount_cents: 5_000n, paid_to: "CreditCo", paid_to_kind: "third_party" },
    { fee_item_id: "F-TPOL", service_code: "title_lender_policy", amount_cents: 120_000n, paid_to: "Desert Title Agency LLC", paid_to_kind: "third_party" },
    { fee_item_id: "F-TEX", service_code: "title_exam", amount_cents: 35_000n, paid_to: "Desert Title Agency LLC", paid_to_kind: "third_party" },
    { fee_item_id: "F-SETT", service_code: "settlement_fee", amount_cents: 60_000n, paid_to: "Desert Title Agency LLC", paid_to_kind: "third_party" },
    { fee_item_id: "F-NOT", service_code: "notary", amount_cents: 15_000n, paid_to: "Desert Title Agency LLC", paid_to_kind: "third_party" },
    { fee_item_id: "F-REC", service_code: "recording", amount_cents: 12_000n, paid_to: "Maricopa County Recorder", paid_to_kind: "public_official" },
    { fee_item_id: "F-HAZ", service_code: "hazard_premium", amount_cents: 150_000n, paid_to: "Desert Mutual", paid_to_kind: "third_party", coverage_required: true, insurer_freely_chosen: true },
    { fee_item_id: "F-ESC", service_code: "escrow_deposit", amount_cents: 206_250n, paid_to: "Partner Bank, N.A.", paid_to_kind: "creditor" },
  ];
  return [...base.map((f) => ({ ...f, ...(over[f.fee_item_id] ?? {}) })), ...extra];
};
const EVIDENCE = ["TaxServ Inc", "MERSCORP", "FloodCo", "Phoenix AMC", "CreditCo", "Desert Title Agency LLC", "Desert Mutual"].map((p, k) => ({ paid_to: p, service_performed_at: "2026-10-20T17:00:00.000Z", report_id: `RPT-${k + 1}` }));
const OPTIONS: LoanOptionsPresented = { presented_at: "2026-10-07T15:00:00.000Z", transaction_type: "limited_cash_out_30y_fixed", options: [{ kind: "lowest_rate", rate_pct: "6.125", points_fees_cents: 206_452n }, { kind: "lowest_rate_no_risky_features", rate_pct: "6.125", points_fees_cents: 206_452n }, { kind: "lowest_points_fees", rate_pct: "6.375", points_fees_cents: 0n }], consumer_choice: "lowest_rate", reason_if_not_lowest_rate: null };
const licenses = (as_of: PlainDate, companyStatus: LicenseCheck["status"] = "approved"): LicenseCheck[] => [
  { check_id: "LC-CO", party_type: "company", party_ref: "partner", nmls_id: "123456", state: "AZ", license_type: "AZ Mortgage Banker (A.R.S. Title 6, ch. 9)", status: companyStatus, sponsorship_ok: null, checked_at: as_of, valid_through: companyStatus === "expired" ? D("2026-09-30") : D("2027-12-31"), source: "nmls_b2b", evidence_document_id: "DOC-LC-CO" },
  { check_id: "LC-MLO", party_type: "individual", party_ref: "mlo-jordan-lee", nmls_id: "987654", state: "AZ", license_type: "AZ Loan Originator", status: "approved", sponsorship_ok: true, checked_at: as_of, valid_through: D("2027-12-31"), source: "nmls_b2b", evidence_document_id: "DOC-LC-MLO" },
];
/** The canonical input snapshot for the fixture on `as_of` — passes every test at every checkpoint; each T-id mutates one aspect. */
function snapshot(as_of: string, over: Partial<ComplianceSnapshot> = {}, apr: AprCalculation = FIXTURE_APR): ComplianceSnapshot {
  const d = D(as_of);
  return {
    application_id: APP, loan_id: null, as_of: d, property_state: "AZ", property_county: "Maricopa", lien_position: "first", occupancy: "primary", loan_amount_cents: 56_000_000n, note_rate_pct: "6.125", term_months: 360, rate_set_date: D("2026-10-07"),
    apr: { actual: apr, disclosed_apr: apr.apr_disclosed_str, disclosed_finance_charge_cents: apr.finance_charge_cents, transaction: { irregular_first_period: true } },
    fees: { items: fees(), benchmarks: [] }, apor_tables: [{ table_date: D("2026-10-05"), term_years: 30, product: "fixed", apor_pct: "6.020" }], treasury_yield_pct: "4.10", prepayment_penalty: null, escrow_established: true,
    jurisdiction: { high_cost_statute: null, branch_licensed_state: false, third_party_processor_license_required: false, ai_disclosure_required: false },
    tolerance: { result: "pass", tolerance_test_id: "TT-1", message: "21.5: no tolerance violation" },
    licenses: { checks: licenses(addDays(d, -3)), mlo_fitness_attested: true },
    lo_comp_plan: { components: [{ kind: "salary" }, { kind: "flat_per_loan" }], passthrough_by_published_formula: true },
    steering: { record: OPTIONS, lock_requested_at: "2026-10-07T16:00:00.000Z" },
    pricing: { locked_price: "100.000", rate_sheet_price: "100.000", review: null },
    respa8: { affiliates: [], referral_at: "2026-10-05T17:30:00.000Z", afba_disclosures: [], service_evidence: EVIDENCE, msa_providers: [] },
    esign: { consent: { kind: "esign", granted_at: "2026-10-05T14:00:00.000Z", withdrawn_at: null, scope: ["le", "cd", "closing"], hw_sw_statement_version: "2026.1", access_demonstrated: true }, delivery_channel: "electronic", delivery_at: `${as_of}T16:14:00.000Z`, disclosure_class: "cd" },
    nmlsr_templates: (["1003", "le", "cd", "note", "security_instrument"] as const).map((form) => ({ form, creditor_name: "Partner Bank, N.A.", creditor_nmlsr_id: "123456", mlo_name: "Jordan Lee", mlo_nmlsr_id: "987654" })),
    arbitration_clause_present: false, credit_insurance_financed: false, ai_disclosure_present: false,
    ...over,
  };
}
/** The 25.1 clocks over the overridden registry, in-memory events, a fixed clock, the escalation service. */
function harness(nowIso: string) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["25.1"] });
  const escalations = new EscalationService(events, clock);
  const timer = (code: string) => timers.byCode(code).at(-1);
  const ofType = (t: string) => events.all().filter((e) => e.type === t);
  return { clock, events, timers, escalations, timer, ofType };
}
const rowOf = (tests: readonly ComplianceTestRow[], code: string): ComplianceTestRow => { const t = tests.find((x) => x.test_code === code); if (!t) throw new Error(`no ${code} row`); return t; };

test("25.1-T1: Given the fixture (loan $560,000.00, 6.125%, 360, disbursement Thu Nov 12, 2026, first payment Fri Jan 1, 2027, PFC $3,849.95 incl. prepaid interest $1,785.43 per 26.3's `365_rounded_per_diem` convention), when `computeApr(method=appendix_j_exact)` runs, then `odd_days = 19`, `odd_fraction = 0.6333333333`, `amount_financed_cents = 55615005`, `finance_charge_cents = 66879315`, `apr = 6.159363`, `apr_disclosed = 6.159`, `tip_pct = 119.059`, and P&I in the stream is `340262` cents.", () => {
  // 26.3 convention feeds the PFC: per diem round(560,000 × 0.06125 / 365) = $93.97; 19 odd days × $93.97 = $1,785.43
  const pi = prepaidInterest(56_000_000n, "6.125", D("2026-11-12"));
  assert.equal(pi.per_diem_cents, 9_397n); assert.equal(pi.days, 19); assert.equal(pi.prepaid_interest_cents, 178_543n);
  const a = computeApr({ ...FIXTURE, method: "appendix_j_exact", checkpoint: "cd" });
  // Appendix J (b)(3): one full unit-period counted back from Jan 1, 2027 lands on Dec 1, 2026; odd days Nov 12 → Dec 1 = 19; f = 19/30
  assert.equal(a.full_unit_periods_first, 1); assert.equal(a.odd_days, 19); assert.equal(a.odd_fraction, 0.6333333333); assert.equal(a.odd_fraction_str, "0.6333333333");
  assert.equal(a.term_start_date, "2026-11-12"); assert.equal(a.first_payment_date, "2027-01-01"); assert.equal(a.unit_period, "month");
  assert.equal(a.amount_financed_cents, 55_615_005n); assert.equal(a.prepaid_finance_charges_cents, 384_995n);
  assert.equal(a.pi_cents, 340_262n); assert.equal(a.total_of_payments_cents, 122_494_320n);
  assert.equal(a.finance_charge_cents, 66_879_315n);
  assert.equal(a.periodic_rate, "0.005132802455");
  assert.equal(a.apr, 6.159363); assert.equal(a.apr_str, "6.159363"); assert.equal(a.apr_disclosed, 6.159); assert.equal(a.apr_disclosed_str, "6.159");
  assert.equal(a.total_interest_cents, 66_672_863n); assert.equal(a.tip_pct, 119.059);
  assert.equal(a.method, "appendix_j_exact"); assert.equal(a.checkpoint, "cd"); assert.equal(a.rule_set_version, "2026.09");
  assert.ok(a.iterations <= 200 && a.iterations >= 30, `bisection to 10⁻¹² in ${a.iterations} iterations`);
  assert.equal(countFirstPeriod(D("2026-12-20"), D("2027-02-01")).odd_days, 12, "edge case: Dec 20 → Feb 1 counts back to Jan 1; 12 odd days");
});

test("25.1-T2: Given the same inputs with `method=appendix_j_disregard_17c4`, then `apr_disclosed = 6.190` and the two methods differ by less than 0.125, and the engine records `first_period_longer_by_days = 19 ≤ 32`.", () => {
  const exact = computeApr({ ...FIXTURE, method: "appendix_j_exact" });
  const b = computeApr({ ...FIXTURE, method: "appendix_j_disregard_17c4" });
  assert.equal(b.apr_str, "6.189949"); assert.equal(b.apr_disclosed, 6.19); assert.equal(b.apr_disclosed_str, "6.190");
  assert.equal(b.first_period_longer_by_days, 19); assert.ok(b.first_period_longer_by_days <= 32); assert.equal(b.disregard_permitted, true);
  assert.equal(b.odd_fraction, 0, "f = 0 under §1026.17(c)(4)(iii)"); assert.equal(b.amount_financed_cents, exact.amount_financed_cents, "PFC and A do not change");
  const diff = Decimal.parse(b.apr_str).sub(Decimal.parse(exact.apr_str));
  assert.equal(diff.toFixed(4), "0.0306"); assert.ok(diff.cmp(Decimal.parse("0.125")) < 0, "a CD showing either is accurate against an actual computed by the other method");
  // the option is unavailable when the first period is more than 32 days longer than a regular period (disbursement Oct 28 → first payment Jan 1: 65 − 31 = 34)
  assert.throws(() => computeApr({ ...FIXTURE, term_start_date: D("2026-10-28"), method: "appendix_j_disregard_17c4" }), RangeError);
});

test("25.1-T3: Given PFC = $0 and `odd_days = 0`, when `computeApr` runs, then `apr = 6.125000` (equals the note rate) — the Appendix J equivalence check.", () => {
  const c = computeApr({ ...FIXTURE, term_start_date: D("2026-12-01"), prepaid_finance_charges_cents: 0n, prepaid_interest_cents: 0n });
  assert.equal(c.odd_days, 0); assert.equal(c.odd_fraction, 0); assert.equal(c.amount_financed_cents, 56_000_000n); assert.equal(c.apr_disclosed_str, "6.125");
  assert.equal(c.note_rate_identity, true, "§1026.22(b) equivalence: the engine returns the note rate");
  // spec arithmetic: with the note's cent-rounded P&I $3,402.62 (exact 3,402.6190…) the solved rate is 6.1250027% → 6.125003 at six decimals, not 6.125000 (identity holds to 5 dp; discrepancy reported)
  assert.equal(c.apr_str, "6.125003");
  assert.ok(Decimal.parse(c.apr_str).sub(Decimal.parse("6.125")).abs().cmp(Decimal.parse("0.00001")) <= 0);
  assert.equal(c.finance_charge_cents, c.total_of_payments_cents - 56_000_000n); assert.equal(c.tip_pct, Number(centsToDecimal(c.finance_charge_cents).div(centsToDecimal(56_000_000n)).mul(Decimal.fromInt(100)).toFixed(3)));
});

test("25.1-T4: Given a delivered CD with APR 6.159 and a consummation-day recomputation of 6.290, when `APR_1026_22_ACCURACY` runs, then `result = fail`, `apr_variance = 0.131`, `tolerance_applied = eighth`, and `compliance.gate.blocked{gate=consummation}` is emitted with the cure plan \"corrected CD + new 3-business-day waiting period (25.2)\".", () => {
  const a = aprAccuracyTest({ disclosed_apr: "6.159", actual_apr: "6.290", transaction: { irregular_first_period: true }, disclosed_finance_charge_cents: 66_879_315n, actual_finance_charge_cents: 67_400_000n });
  assert.equal(a.result, "fail"); assert.equal(a.apr_variance, 0.131); assert.equal(a.tolerance_applied, "eighth"); assert.equal(a.tolerance_pct, 0.125); assert.equal(a.accuracy_basis, null); assert.equal(a.cure_plan, APR_CURE_PLAN);
  // the consummation gate: closing.scheduled arms it; the consummation-day run recomputes 6.290 against the delivered CD
  const h = harness("2026-11-06T15:00:00.000Z");
  h.events.append({ type: "closing.scheduled", applicationId: APP, actor: AGENT, payload: { application_id: APP, closing_date: "2026-11-06" } });
  assert.equal(h.timer("SM_O61_COMPLIANCE_PASS_CONSUMMATE_GATE")!.status, "armed");
  const recomputed: AprCalculation = { ...FIXTURE_APR, checkpoint: "consummation", apr: 6.29, apr_str: "6.290000", apr_disclosed: 6.29, apr_disclosed_str: "6.290", finance_charge_cents: 67_400_000n };
  const s = snapshot("2026-11-06", { apr: { actual: recomputed, disclosed_apr: "6.159", disclosed_finance_charge_cents: 66_879_315n, transaction: { irregular_first_period: true } } });
  const r = evaluateComplianceGate(h.events, "SM_O61_COMPLIANCE_PASS_CONSUMMATE_GATE", s, { now: h.clock.now(), escalations: h.escalations });
  assert.equal(r.open, false); assert.equal(r.checkpoint, "consummation");
  const t = rowOf(r.run.tests, "APR_1026_22_ACCURACY");
  assert.equal(t.result, "fail"); assert.equal(t.measured_value, 0.131); assert.equal(t.threshold_value, 0.125); assert.equal(t.evidence.tolerance_applied, "eighth"); assert.equal(t.evidence.cure_plan, APR_CURE_PLAN);
  assert.ok(r.derivation.failing_tests.includes("APR_1026_22_ACCURACY")); assert.equal(rowOf(r.run.tests, "FC_1026_38O2_ACCURACY").result, "fail", "a 6.290 recomputation comes with a finance charge understated by more than $100 — (a)(4) cannot rescue it");
  const blocked = h.ofType("compliance.gate.blocked");
  assert.equal(blocked.length, 1); assert.equal(blocked[0]!.payload.gate, "consummation"); assert.equal(blocked[0]!.applicationId, APP);
  assert.ok(String(blocked[0]!.payload.cure_plan).includes(APR_CURE_PLAN)); assert.equal(blocked[0]!.payload.command_refused, "consummate");
  assert.equal(h.ofType("compliance.testrun.completed")[0]!.payload.overall_result, "fail");
  assert.equal(h.timer("SM_O61_COMPLIANCE_PASS_CONSUMMATE_GATE")!.status, "armed", "the gate stays closed");
  assert.equal(h.timer("SM_O61_BLOCKING_FAILURE_REVIEW_1BD")!.dueDate, "2026-11-09", "Fri Nov 6 + 1 business_days_creditor");
  assert.equal(h.escalations.list()[0]!.kind, "officer");
  assert.throws(() => assertGateOpen(h.events, "SM_O61_COMPLIANCE_PASS_CONSUMMATE_GATE", s, { now: h.clock.now() }), (e: unknown) => e instanceof ComplianceGateBlocked && e.command === "consummate");
});

test("25.1-T5: Given a delivered CD with finance charge $668,793.15 / APR 6.159 and an actual finance charge of $668,853.15 (understated by $60.00) with the APR resulting from the disclosed finance charge, then `FC_1026_38O2_ACCURACY = pass` and `APR_1026_22_ACCURACY = pass` with `accuracy_basis = a4`.", () => {
  // the settlement agent adds a $60.00 courier fee the creditor required ((a)(2) → finance charge): actual finance charge $668,853.15
  const actual = computeApr({ ...FIXTURE, prepaid_finance_charges_cents: 384_995n + 6_000n, checkpoint: "consummation" });
  assert.equal(actual.finance_charge_cents, 66_885_315n); assert.equal(actual.apr_disclosed_str, "6.160", "the exact recomputation is ~6.160%, within 1/8 anyway");
  const fc = financeChargeAccuracyTest(66_879_315n, 66_885_315n);
  assert.equal(fc.result, "pass"); assert.equal(fc.understated_by_cents, 6_000n); assert.equal(fc.basis, "o2i_understated_le_100");
  const a = aprAccuracyTest({ disclosed_apr: "6.159", actual_apr: actual.apr_disclosed_str, transaction: { irregular_first_period: true }, disclosed_finance_charge_cents: 66_879_315n, actual_finance_charge_cents: actual.finance_charge_cents, apr_from_disclosed_finance_charge: "6.159" });
  assert.equal(a.result, "pass"); assert.equal(a.accuracy_basis, "a4"); assert.equal(a.finance_charge.result, "pass"); assert.equal(a.cure_plan, null);
  assert.equal(financeChargeAccuracyTest(66_879_315n, 66_879_315n + 10_001n).result, "fail", "understated by more than $100");
  assert.equal(financeChargeAccuracyTest(66_879_315n, 66_800_000n).basis, "o2ii_overstated");
  const run = runTestSuite("consummation", snapshot("2026-11-06", { apr: { actual, disclosed_apr: "6.159", disclosed_finance_charge_cents: 66_879_315n, transaction: { irregular_first_period: true }, apr_from_disclosed_finance_charge: "6.159" } }), { started_at: "2026-11-06T15:00:00.000Z" });
  assert.equal(rowOf(run.tests, "FC_1026_38O2_ACCURACY").result, "pass"); assert.equal(rowOf(run.tests, "FC_1026_38O2_ACCURACY").measured_value, "6000");
  assert.equal(rowOf(run.tests, "APR_1026_22_ACCURACY").result, "pass"); assert.equal(rowOf(run.tests, "APR_1026_22_ACCURACY").evidence.accuracy_basis, "a4");
  assert.equal(run.overall_result, "pass"); assert.equal(deriveGate(run.tests).open, true);
});

test("25.1-T6: Given a 30-year fixed with an irregular first period only, then `tolerance_applied = eighth`; given a construction-to-permanent style multiple-advance stream (out of scope but used as a negative test), then `tolerance_applied = quarter`.", () => {
  assert.equal(toleranceApplied({ irregular_first_period: true }), "eighth");
  assert.equal(toleranceApplied({ irregular_first_period: true, irregular_first_or_final_payment: true }), "eighth", "§1026.22(a)(3) carves out an irregular first period and an irregular first or final payment");
  assert.equal(toleranceApplied({}), "eighth");
  assert.equal(toleranceApplied({ multiple_advances: true }), "quarter");
  assert.equal(toleranceApplied({ irregular_payment_periods: true }), "quarter"); assert.equal(toleranceApplied({ irregular_payment_amounts: true }), "quarter");
  const q = aprAccuracyTest({ disclosed_apr: "6.159", actual_apr: "6.359", transaction: { multiple_advances: true }, disclosed_finance_charge_cents: 66_879_315n, actual_finance_charge_cents: 66_879_315n });
  assert.equal(q.tolerance_applied, "quarter"); assert.equal(q.tolerance_pct, 0.25); assert.equal(q.result, "pass"); assert.equal(q.accuracy_basis, "a3");
  const e = aprAccuracyTest({ disclosed_apr: "6.159", actual_apr: "6.359", transaction: { irregular_first_period: true }, disclosed_finance_charge_cents: 66_879_315n, actual_finance_charge_cents: 66_879_315n });
  assert.equal(e.tolerance_applied, "eighth"); assert.equal(e.result, "fail");
});

test("25.1-T7: Given the partner's Arizona license record in `license_checks` with `status = expired` on Mon Oct 5, 2026, when `assertGateOpen(SM_O61_COMPLIANCE_PASS_LE_GATE)` runs, then the gate is blocked, `issueLE` is refused, and an `escalation` to `officer` opens with `SM_O61_BLOCKING_FAILURE_REVIEW_1BD` due Tue Oct 6, 2026 (`business_days_creditor`).", () => {
  const h = harness("2026-10-05T16:00:00.000Z");
  h.events.append({ type: "application.trid_received", applicationId: APP, actor: AGENT, payload: { application_id: APP, trid_application_date: "2026-10-05" } });
  assert.equal(h.timer("SM_O61_COMPLIANCE_PASS_LE_GATE")!.status, "armed"); assert.equal(h.timer("SM_O61_COMPLIANCE_PASS_LE_GATE")!.dueDate, undefined, "a gate, not a deadline");
  const checks = licenses(D("2026-10-05"), "expired");
  const lic = checkLicenses({ state: "AZ", as_of: D("2026-10-05"), checks, requirements: { branch_licensed_state: false, mlo_fitness_attested: true } });
  assert.equal(lic.find((x) => x.test_code === "NMLS_LICENSE_COMPANY")!.result, "fail"); assert.equal(lic.find((x) => x.test_code === "NMLS_LICENSE_COMPANY")!.effective_status, "expired"); assert.equal(lic.find((x) => x.test_code === "NMLS_LICENSE_MLO")!.result, "pass");
  assert.equal(effectiveLicense(licenses(D("2026-09-01")), "company", "AZ", D("2026-10-05")).status, "not_found", "a check older than 30 days counts as not_found");
  const s = snapshot("2026-10-05", { licenses: { checks, mlo_fitness_attested: true }, esign: { consent: { kind: "esign", granted_at: "2026-10-05T14:00:00.000Z", withdrawn_at: null, scope: ["le", "cd"], hw_sw_statement_version: "2026.1", access_demonstrated: true }, delivery_channel: "electronic", delivery_at: "2026-10-05T16:30:00.000Z", disclosure_class: "le" } });
  let err: ComplianceGateBlocked | null = null;
  try { assertGateOpen(h.events, "SM_O61_COMPLIANCE_PASS_LE_GATE", s, { now: h.clock.now(), escalations: h.escalations }); } catch (e) { err = e as ComplianceGateBlocked; }
  assert.ok(err instanceof ComplianceGateBlocked); assert.equal(err.command, "issueLE"); assert.equal(GATES.SM_O61_COMPLIANCE_PASS_LE_GATE.command, "issueLE");
  assert.equal(err.result.open, false); assert.deepEqual(err.result.derivation.failing_tests, ["NMLS_LICENSE_COMPANY"]);
  assert.equal(err.result.review_due, "2026-10-06"); assert.equal(err.result.escalate_to, "officer");
  const esc = h.escalations.list(); assert.equal(esc.length, 1); assert.equal(esc[0]!.kind, "officer"); assert.equal(esc[0]!.ownerRole, "officer"); assert.equal(esc[0]!.applicationId, APP);
  assert.equal(esc[0]!.payload.review_timer, "SM_O61_BLOCKING_FAILURE_REVIEW_1BD"); assert.equal(esc[0]!.payload.review_due, "2026-10-06"); assert.equal(esc[0]!.payload.command_refused, "issueLE");
  const rv = h.timer("SM_O61_BLOCKING_FAILURE_REVIEW_1BD")!;
  assert.equal(rv.status, "armed"); assert.equal(rv.dueDate, "2026-10-06", "+1 business_days_creditor from Mon Oct 5"); assert.equal(rv.applicationId, APP);
  assert.equal(h.ofType("compliance.gate.blocked")[0]!.payload.gate, "le"); assert.equal(h.timer("SM_O61_COMPLIANCE_PASS_LE_GATE")!.status, "armed", "not satisfied — no compliance.gate.opened{gate=le}");
  // the evaluator the gate row names sees the same rows
  assert.equal(EVALUATORS_25_1["25.1.gateOpen"]!({ tests: err.result.run.tests, gate: "SM_O61_COMPLIANCE_PASS_LE_GATE", now: h.clock.now() }).open, false);
  // cure: a fresh approved check → the LE gate opens and the review clock is satisfied
  const cured = snapshot("2026-10-05", { licenses: { checks: licenses(D("2026-10-05")), mlo_fitness_attested: true }, esign: s.esign! });
  const r = assertGateOpen(h.events, "SM_O61_COMPLIANCE_PASS_LE_GATE", cured, { now: h.clock.now(), escalations: h.escalations });
  assert.equal(r.open, true); assert.equal(h.timer("SM_O61_COMPLIANCE_PASS_LE_GATE")!.status, "satisfied"); assert.equal(rv.status, "satisfied");
});

test("25.1-T8: Given a lock request on Wed Oct 7, 2026 with no `loan_options_presented` record, then `STEERING_1026_36E_OPTIONS = fail` and `lock` is refused; given the record with the three options and the consumer's choice, then the test passes.", () => {
  const lockAt = "2026-10-07T16:00:00.000Z";
  const none = steeringOptionsTest(null, lockAt);
  assert.equal(none.result, "fail"); assert.deepEqual(none.missing, ["loan_options_presented"]);
  const ok = steeringOptionsTest(OPTIONS, lockAt);
  assert.equal(ok.result, "pass"); assert.deepEqual(ok.missing, []);
  assert.equal(steeringOptionsTest({ ...OPTIONS, options: OPTIONS.options.slice(0, 2) }, lockAt).result, "fail", "all three (e)(2) options are required");
  assert.equal(steeringOptionsTest({ ...OPTIONS, consumer_choice: "lowest_points_fees", reason_if_not_lowest_rate: null }, lockAt).result, "fail", "a choice other than the lowest rate needs the reason");
  assert.equal(steeringOptionsTest({ ...OPTIONS, presented_at: "2026-10-07T17:00:00.000Z" }, lockAt).result, "fail", "presented after the lock request");
  const h = harness(lockAt);
  const s = snapshot("2026-10-07", { steering: { record: null, lock_requested_at: lockAt } });
  assert.throws(() => assertGateOpen(h.events, "SM_O61_COMPLIANCE_PASS_LOCK_GATE", s, { now: h.clock.now(), escalations: h.escalations }), (e: unknown) => e instanceof ComplianceGateBlocked && e.command === "lock" && e.result.derivation.failing_tests.includes("STEERING_1026_36E_OPTIONS"));
  assert.equal(h.timer("SM_O61_COMPLIANCE_PASS_LOCK_GATE")!.status, "armed", "armed by compliance.testrun.started{checkpoint=lock}, not yet opened");
  const r = assertGateOpen(h.events, "SM_O61_COMPLIANCE_PASS_LOCK_GATE", snapshot("2026-10-07", { steering: { record: OPTIONS, lock_requested_at: lockAt } }), { now: h.clock.now(), escalations: h.escalations });
  assert.equal(r.open, true); assert.equal(rowOf(r.run.tests, "STEERING_1026_36E_OPTIONS").result, "pass"); assert.equal(rowOf(r.run.tests, "LOCOMP_1026_36D").result, "pass"); assert.equal(rowOf(r.run.tests, "FAIR_LENDING_PRICING_EXCEPTION").result, "pass");
  assert.equal(h.ofType("compliance.gate.opened").at(-1)!.payload.gate, "lock"); assert.equal(h.timers.byCode("SM_O61_COMPLIANCE_PASS_LOCK_GATE").at(-1)!.status, "satisfied");
});

test("25.1-T9: Given a locked price 0.125 better than the rate sheet with no `pricing_exception_reviews` row, then `FAIR_LENDING_PRICING_EXCEPTION = fail`; given a row with `reason_code = tolerance_cure` and `discretionary = false`, then it passes; an attempt to write `discretionary = true` is rejected by the schema.", () => {
  const none = pricingExceptionTest({ locked_price: "100.125", rate_sheet_price: "100.000", review: null });
  assert.equal(none.result, "fail"); assert.equal(none.deviation_bps, 12.5); assert.equal(none.review_id, null);
  const events = new MemoryEventStore(new FixedClock("2026-10-07T16:05:00.000Z"));
  const r = reviewPricingException(events, { application_id: APP, review_id: "PER-1", deviation_ref: "LOCK-1", locked_price: "100.125", rate_sheet_price: "100.000", reason_code: "tolerance_cure", discretionary: false, reviewed_by: "compliance-tester", now: "2026-10-07T16:05:00.000Z" });
  assert.equal(r.review.reason_code, "tolerance_cure"); assert.equal(r.review.discretionary, false); assert.equal(r.review.deviation_bps, 12.5); assert.equal(r.review.result, "approved");
  assert.equal(r.event.type, "compliance.pricing_exception.reviewed"); assert.equal(r.event.applicationId, APP);
  assert.equal(pricingExceptionTest({ locked_price: "100.125", rate_sheet_price: "100.000", review: r.review }).result, "pass");
  assert.equal(pricingExceptionTest({ locked_price: "100.000", rate_sheet_price: "100.000", review: null }).result, "pass", "no deviation, no review needed");
  // discretionary = true is not a legal value: the engine refuses and the migration's CHECK constraint refuses
  assert.throws(() => reviewPricingException(events, { application_id: APP, review_id: "PER-2", deviation_ref: "LOCK-1", locked_price: "100.125", rate_sheet_price: "100.000", reason_code: "tolerance_cure", discretionary: true, reviewed_by: "compliance-tester", now: "2026-10-07T16:05:00.000Z" }), RangeError);
  assert.throws(() => reviewPricingException(events, { application_id: APP, review_id: "PER-3", deviation_ref: "LOCK-1", locked_price: "100.125", rate_sheet_price: "100.000", reason_code: "because", discretionary: false, reviewed_by: "compliance-tester", now: "2026-10-07T16:05:00.000Z" }), RangeError, "no reason code → cannot be marked non-discretionary");
  const sql = readFileSync(new URL("../../../db/migrations/0069_compliance_testing_engine.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE TABLE pricing_exception_reviews[\s\S]*discretionary\s+boolean NOT NULL DEFAULT false CHECK \(discretionary = false\)/);
  const run = runTestSuite("lock", snapshot("2026-10-07", { pricing: { locked_price: "100.125", rate_sheet_price: "100.000", review: null } }), { started_at: "2026-10-07T16:00:00.000Z" });
  assert.equal(rowOf(run.tests, "FAIR_LENDING_PRICING_EXCEPTION").result, "fail"); assert.equal(rowOf(run.tests, "FAIR_LENDING_PRICING_EXCEPTION").measured_value, 12.5);
  assert.equal(rowOf(runTestSuite("lock", snapshot("2026-10-07", { pricing: { locked_price: "100.125", rate_sheet_price: "100.000", review: r.review } }), { started_at: "2026-10-07T16:00:00.000Z" }).tests, "FAIR_LENDING_PRICING_EXCEPTION").result, "pass");
});

test("25.1-T10: Given the property state NY with loan $560,000 (≤ conforming limit) and points and fees of 5.2% of the total loan amount, then `STATE_HIGH_COST_NY = fail` (points-and-fees trigger \"five percent\") even though `HOEPA_1026_32 = false`, and the CD gate is blocked.", () => {
  // NY §6-l counts the three discount points (the NY benchmark — Fannie Mae required net yield + 1 — is failed at 6.875 vs 6.50) that §1026.32(b)(1)(i)(E) excludes (undiscounted 6.875 ≤ APOR 6.02 + 1 → two points excludable)
  const items = fees({}, [{ fee_item_id: "F-PTS", service_code: "discount_points", amount_cents: 1_680_000n, paid_to: "Partner Bank, N.A.", paid_to_kind: "creditor", bona_fide_discount_points: 3 }, { fee_item_id: "F-ORIG", service_code: "origination", amount_cents: 872_162n, paid_to: "Partner Bank, N.A.", paid_to_kind: "creditor" }]);
  const cls = classifyFinanceCharges(items, { as_of: D("2026-11-02"), state: "NY" });
  const pfc = prepaidFinanceCharges(cls); assert.equal(pfc, 384_995n + 1_680_000n + 872_162n);
  const tla = totalLoanAmount(56_000_000n - pfc); assert.equal(tla, 53_062_843n);
  const pfIn = { items, classifications: cls, note_rate_pct: "6.125", undiscounted_rate_pct: "6.875", apor_pct: "6.020", fnma_required_net_yield_pct: "5.500" };
  const ny = pointsAndFees(pfIn, "ny_bl_6l"), fed = pointsAndFees(pfIn, "federal_1026_32");
  assert.equal(ny.excluded_discount_points_cents, 0n); assert.equal(pctOf(ny.inclusive_cents, tla, 1), 5.2, "5.2% of the total loan amount under NY counting");
  assert.equal(fed.excluded_discount_points_cents, 1_120_000n); assert.ok(pctOf(fed.inclusive_cents, tla, 2) < 5, `federal counting ${pctOf(fed.inclusive_cents, tla, 2)}% < 5%`);
  const st = evaluateStateHighCost({ state: "NY", as_of: D("2026-11-02"), apr: "6.630", treasury_yield_pct: "4.10", loan_amount_cents: 56_000_000n, total_loan_amount_cents: tla, points_and_fees_state_cents: ny.inclusive_cents, lien_position: "first" });
  assert.equal(st.test_code, "STATE_HIGH_COST_NY"); assert.equal(st.result, "fail"); assert.equal(st.pf_trigger, true); assert.equal(st.apr_trigger, false); assert.equal(st.in_scope, true, "$560,000 ≤ the conforming limit"); assert.equal(st.statute, "N.Y. Banking Law §6-l"); assert.equal(st.pf_threshold_cents, 2_653_142n, "five percent of the total loan amount");
  assert.equal(evaluateStateHighCost({ ...{ state: "NY", as_of: D("2026-11-02"), apr: "6.630", treasury_yield_pct: "4.10", total_loan_amount_cents: tla, points_and_fees_state_cents: ny.inclusive_cents, lien_position: "first" as const }, loan_amount_cents: 90_000_000n }).result, "not_applicable", "above the conforming limit the statute does not apply");
  assert.equal(evaluateStateHighCost({ state: "AZ", as_of: D("2026-11-02"), apr: "6.159", loan_amount_cents: 56_000_000n, total_loan_amount_cents: 55_615_005n, points_and_fees_state_cents: 206_452n, lien_position: "first" }).result, "not_applicable", "Arizona has no high-cost statute row");
  const apr = computeApr({ ...FIXTURE, prepaid_finance_charges_cents: pfc, checkpoint: "cd" });
  const h = harness("2026-11-02T16:00:00.000Z");
  const s = snapshot("2026-11-02", { property_state: "NY", property_county: "Kings", fees: { items, benchmarks: [], undiscounted_rate_pct: "6.875", fnma_required_net_yield_pct: "5.500" }, jurisdiction: { high_cost_statute: "N.Y. Banking Law §6-l", branch_licensed_state: false, third_party_processor_license_required: false, ai_disclosure_required: false }, licenses: { checks: licenses(D("2026-10-30")).map((c) => ({ ...c, state: "NY", license_type: "NY Mortgage Banker" })), mlo_fitness_attested: true } }, apr);
  const r = evaluateComplianceGate(h.events, "SM_O61_COMPLIANCE_PASS_CD_GATE", s, { now: h.clock.now(), escalations: h.escalations });
  const nyRow = rowOf(r.run.tests, "STATE_HIGH_COST_NY"), hoepa = rowOf(r.run.tests, "HOEPA_1026_32");
  assert.equal(nyRow.result, "fail"); assert.equal(nyRow.jurisdiction, "NY"); assert.equal(nyRow.evidence.pf_trigger, true); assert.equal(nyRow.evidence.counting_rule, "ny_bl_6l");
  assert.equal(hoepa.result, "pass"); assert.equal(hoepa.evidence.is_high_cost, false); assert.equal(hoepa.evidence.pf_trigger, false, "federal points and fees below 5%");
  assert.equal(r.open, false); assert.ok(r.derivation.failing_tests.includes("STATE_HIGH_COST_NY")); assert.equal(h.ofType("compliance.gate.blocked")[0]!.payload.gate, "cd");
  assert.equal(h.timer("SM_O61_COMPLIANCE_PASS_CD_GATE")!.status, "armed", "armed by compliance.testrun.started{checkpoint=cd}; stays closed");
});

test("25.1-T11: Given a title agent that is an affiliate of the partner and no `disclosures{kind=afba}` row, then `RESPA_8_AFBA_DISCLOSURE = fail` at the CD gate; given the AfBA delivered at application (Mon Oct 5, 2026), then it passes and the fee's tolerance class in `fee_items` is `zero`.", () => {
  const titleIds = ["F-TPOL", "F-TEX", "F-SETT", "F-NOT"];
  const items = fees(Object.fromEntries(titleIds.map((id) => [id, { paid_to_kind: "affiliate" as const }])));
  const respa = { affiliates: ["Desert Title Agency LLC"], referral_at: "2026-10-05T17:30:00.000Z", service_evidence: EVIDENCE, msa_providers: [] };
  const none = checkRespa8({ as_of: D("2026-11-02"), fee_items: items, ...respa, afba_disclosures: [] });
  const afba = none.find((x) => x.test_code === "RESPA_8_AFBA_DISCLOSURE")!;
  assert.equal(afba.result, "fail"); assert.match(afba.message, /no disclosures\{kind=afba\} row/);
  const h = harness("2026-11-02T16:00:00.000Z");
  const r = evaluateComplianceGate(h.events, "SM_O61_COMPLIANCE_PASS_CD_GATE", snapshot("2026-11-02", { fees: { items, benchmarks: [] }, respa8: { ...respa, afba_disclosures: [] } }), { now: h.clock.now(), escalations: h.escalations });
  assert.equal(r.open, false); assert.deepEqual(r.derivation.failing_tests, ["RESPA_8_AFBA_DISCLOSURE"]); assert.equal(rowOf(r.run.tests, "RESPA_8_UNEARNED_FEES").result, "pass");
  assert.ok(String(r.cure_plan).includes("escalate to officer"), "affiliate detected late — not curable retroactively");
  const delivered = checkRespa8({ as_of: D("2026-11-02"), fee_items: items, ...respa, afba_disclosures: [{ kind: "afba", delivered_at: "2026-10-05T17:00:00.000Z", provider: "Desert Title Agency LLC", required_use: false, provider_kind: "title" }] });
  const ok = delivered.find((x) => x.test_code === "RESPA_8_AFBA_DISCLOSURE")!;
  assert.equal(ok.result, "pass"); assert.deepEqual(ok.affiliate_fee_items, titleIds.map((fee_item_id) => ({ fee_item_id, tolerance_class: "zero" })), "an affiliate's charge cannot be shopped for — zero tolerance (21.5)");
  assert.equal(checkRespa8({ as_of: D("2026-11-02"), fee_items: items, ...respa, afba_disclosures: [{ kind: "afba", delivered_at: "2026-10-06T17:00:00.000Z", provider: "Desert Title Agency LLC", required_use: false, provider_kind: "title" }] }).find((x) => x.test_code === "RESPA_8_AFBA_DISCLOSURE")!.result, "fail", "delivered after the referral");
  assert.equal(checkRespa8({ as_of: D("2026-11-02"), fee_items: items, ...respa, afba_disclosures: [{ kind: "afba", delivered_at: "2026-10-05T17:00:00.000Z", provider: "Desert Title Agency LLC", required_use: true, provider_kind: "title" }] }).find((x) => x.test_code === "RESPA_8_AFBA_DISCLOSURE")!.result, "fail", "required use of a title affiliate (§1024.15(b)(2))");
  const r2 = evaluateComplianceGate(h.events, "SM_O61_COMPLIANCE_PASS_CD_GATE", snapshot("2026-11-02", { fees: { items, benchmarks: [] }, respa8: { ...respa, afba_disclosures: [{ kind: "afba", delivered_at: "2026-10-05T17:00:00.000Z", provider: "Desert Title Agency LLC", required_use: false, provider_kind: "title" }] } }), { now: h.clock.now(), escalations: h.escalations });
  assert.equal(r2.open, true); assert.deepEqual((rowOf(r2.run.tests, "RESPA_8_AFBA_DISCLOSURE").evidence.affiliate_fee_items as { tolerance_class: string }[]).map((x) => x.tolerance_class), ["zero", "zero", "zero", "zero"]);
});

test("25.1-T12: Given an E-SIGN consent withdrawn on Sun Nov 1, 2026 and an `issueCD` request for e-delivery on Mon Nov 2, then `ESIGN_7001C_CONSENT = fail`, the gate blocks e-delivery, and the `disclosure` agent is instructed to deliver on paper with the mailbox rule.", () => {
  const withdrawn = { kind: "esign" as const, granted_at: "2026-10-05T14:00:00.000Z", withdrawn_at: "2026-11-01T18:00:00.000Z", scope: ["le", "cd", "closing"], hw_sw_statement_version: "2026.1", access_demonstrated: true };
  const e = esignConsentTest({ consent: withdrawn, delivery_channel: "electronic", delivery_at: "2026-11-02T16:14:00.000Z", disclosure_class: "cd", as_of: D("2026-11-02") });
  assert.equal(e.result, "fail"); assert.deepEqual(e.blocked_channels, ["electronic"]); assert.deepEqual(e.instruction, { agent: "disclosure", channel: "paper", mailbox_rule: true }); assert.match(e.reasons.join(";"), /withdrawn 2026-11-01/);
  assert.equal(esignConsentTest({ consent: withdrawn, delivery_channel: "paper", delivery_at: "2026-11-02T16:14:00.000Z", disclosure_class: "cd", as_of: D("2026-11-02") }).result, "not_applicable", "paper delivery needs no consent");
  assert.equal(esignConsentTest({ consent: withdrawn, delivery_channel: "electronic", delivery_at: "2026-10-30T16:14:00.000Z", disclosure_class: "cd", as_of: D("2026-10-30") }).result, "pass", "a CD e-delivered before the withdrawal stands");
  assert.equal(esignConsentTest({ consent: { ...withdrawn, withdrawn_at: null, hw_sw_statement_version: "2025.4" }, delivery_channel: "electronic", delivery_at: "2026-11-02T16:14:00.000Z", disclosure_class: "cd", as_of: D("2026-11-02") }).reasons[0], "hardware/software statement not current (7001(c)(1)(C))");
  const h = harness("2026-11-02T16:00:00.000Z");
  const r = evaluateComplianceGate(h.events, "SM_O61_COMPLIANCE_PASS_CD_GATE", snapshot("2026-11-02", { esign: { consent: withdrawn, delivery_channel: "electronic", delivery_at: "2026-11-02T16:14:00.000Z", disclosure_class: "cd" } }), { now: h.clock.now(), escalations: h.escalations });
  assert.equal(r.open, false); assert.deepEqual(r.derivation.failing_tests, ["ESIGN_7001C_CONSENT"]); assert.deepEqual(r.blocked_channels, ["electronic"]); assert.deepEqual(r.instruction, { agent: "disclosure", channel: "paper", mailbox_rule: true });
  const blocked = h.ofType("compliance.gate.blocked")[0]!;
  assert.equal(blocked.payload.gate, "cd"); assert.deepEqual(blocked.payload.blocked_channels, ["electronic"]); assert.match(String(blocked.payload.cure_plan), /deliver on paper with the mailbox rule \(disclosure agent\)/);
  assert.throws(() => assertGateOpen(h.events, "SM_O61_COMPLIANCE_PASS_CD_GATE", snapshot("2026-11-02", { esign: { consent: withdrawn, delivery_channel: "electronic", delivery_at: "2026-11-02T16:14:00.000Z", disclosure_class: "cd" } }), { now: h.clock.now() }), (x: unknown) => x instanceof ComplianceGateBlocked && x.command === "issueCD");
  // paper delivery with the mailbox rule passes the CD gate
  assert.equal(evaluateComplianceGate(h.events, "SM_O61_COMPLIANCE_PASS_CD_GATE", snapshot("2026-11-02", { esign: { consent: withdrawn, delivery_channel: "paper", delivery_at: "2026-11-02T16:14:00.000Z", disclosure_class: "cd" } }), { now: h.clock.now() }).open, true);
});

test("25.1-T13: Given the APOR table for the week of Wed Oct 7, 2026 missing, when the CD gate runs, then `QM_1026_43 = error`, the gate blocks, and no waiver can be attached (`waivable = false`).", () => {
  const stale = [{ table_date: D("2026-09-28"), term_years: 30, product: "fixed" as const, apor_pct: "6.010" }];
  assert.equal(aporAsOf(stale, D("2026-10-07")), null, "the Sep 28 table does not cover the week of Oct 7");
  assert.equal(aporAsOf([{ table_date: D("2026-10-05"), term_years: 30, product: "fixed", apor_pct: "6.020" }], D("2026-10-07"))!.apor_pct, "6.020");
  const det = { apr: "6.159", apor: null, rate_set_date: D("2026-10-07"), as_of: D("2026-11-02"), loan_amount_cents: 56_000_000n, total_loan_amount_cents: 55_615_005n, points_and_fees_cents: 206_452n, lien_position: "first" as const };
  const qm = determineQm(det); assert.equal(qm.result, "error"); assert.equal(qm.qm_type, null); assert.equal(qm.spread, null); assert.match(qm.message, /no APOR table for the rate-set week of 2026-10-07/);
  assert.equal(determineHpml(det).result, "error");
  // with the table (illustration: APOR 6.02 → spread 0.139 → General QM safe harbor; not HPML; not HOEPA)
  const withTable = { ...det, apor: { table_date: D("2026-10-05"), term_years: 30, product: "fixed" as const, apor_pct: "6.020" } };
  const q = determineQm(withTable); assert.equal(q.result, "pass"); assert.equal(q.qm_type, "general_safe_harbor"); assert.equal(q.spread, 0.139); assert.equal(q.apr_tier, "2.25"); assert.equal(q.hpct, false); assert.equal(q.cap_cents, 1_668_450n); assert.equal(q.evidence.apor_table_date, "2026-10-05"); assert.equal(q.evidence.pf_pct_of_total_loan_amount, 0.37);
  const hp = determineHpml(withTable); assert.equal(hp.is_hpml, false); assert.equal(hp.threshold, "1.5");
  const ho = determineHoepa(withTable); assert.equal(ho.is_high_cost, false); assert.equal(ho.pf_threshold_cents, 2_780_750n);
  const h = harness("2026-11-02T16:00:00.000Z");
  const r = evaluateComplianceGate(h.events, "SM_O61_COMPLIANCE_PASS_CD_GATE", snapshot("2026-11-02", { apor_tables: stale }), { now: h.clock.now(), escalations: h.escalations });
  const row = rowOf(r.run.tests, "QM_1026_43");
  assert.equal(row.result, "error"); assert.equal(row.waivable, false); assert.equal(rowOf(r.run.tests, "HPML_1026_35").result, "error");
  assert.equal(r.open, false); assert.ok(r.derivation.failing_tests.includes("QM_1026_43")); assert.equal(r.run.overall_result, "error");
  assert.equal(testDefinition("QM_1026_43").waivable, false); assert.equal(testDefinition("QM_1026_43").owner_process, "23.4");
  assert.throws(() => requestWaiver(h.events, { application_id: APP, waiver_id: "W-1", test: row, rationale: "APOR late" }, OFFICER), /legal test \(waivable=false\)/);
  assert.equal(deriveGate(r.run.tests, [{ waiver_id: "W-1", test_id: "x", test_code: "QM_1026_43", kind: "policy_only", approved_by: "u-officer", rationale: "x", expires_at: null }]).open, false, "a waiver row on a legal test does not re-derive the gate");
  assert.equal(h.ofType("compliance.waiver.granted").length, 0);
  assert.deepEqual((h.ofType("compliance.gate.blocked")[0]!.payload.waivable as { test_code: string; waivable: boolean }[]).find((x) => x.test_code === "QM_1026_43"), { test_code: "QM_1026_43", waivable: false });
});

test("25.1-T14: Given a `compliance_waivers` request on `APR_1026_22_ACCURACY`, then the request is rejected (legal test); given one on `FEE_REASONABLENESS` (warning) approved by `officer`, then the gate re-derives to open.", () => {
  const h = harness("2026-11-02T16:00:00.000Z");
  const base = snapshot("2026-11-02");
  const aprRow = rowOf(runTestSuite("cd", base, { started_at: h.clock.now() }).tests, "APR_1026_22_ACCURACY");
  assert.equal(testDefinition("APR_1026_22_ACCURACY").waivable, false);
  assert.throws(() => requestWaiver(h.events, { application_id: APP, waiver_id: "W-APR", test: aprRow, rationale: "within a hair" }, OFFICER), /APR_1026_22_ACCURACY is a legal test \(waivable=false\)/);
  // the appraisal fee is outside the Maricopa County band → the (c)(7)(iv) exclusion is withdrawn (W → B) and the CD gate blocks
  const benchmarks = [{ state: "AZ", county: "Maricopa", service_code: "appraisal" as const, low_cents: 40_000n, high_cents: 60_000n, source: "SM transaction history 2026Q3", as_of: D("2026-10-01") }];
  const s = snapshot("2026-11-02", { fees: { items: fees({ "F-APPR": { amount_cents: 90_000n } }), benchmarks } });
  const r = evaluateComplianceGate(h.events, "SM_O61_COMPLIANCE_PASS_CD_GATE", s, { now: h.clock.now(), escalations: h.escalations });
  const fr = rowOf(r.run.tests, "FEE_REASONABLENESS");
  assert.equal(fr.result, "fail"); assert.equal(fr.blocking, true); assert.equal(fr.waivable, true); assert.equal(fr.escalate_to, "officer");
  assert.equal(r.open, false); assert.deepEqual(r.derivation.failing_tests, ["FEE_REASONABLENESS"]);
  assert.equal((rowOf(r.run.tests, "FC_1026_4_CLASSIFICATION").evidence.classifications as { fee_item_id: string; classification: string }[]).find((x) => x.fee_item_id === "F-APPR")!.classification, "prepaid_finance_charge", "reclassified — the APR is recomputed");
  // only the officer may attach a policy-only waiver
  assert.throws(() => requestWaiver(h.events, { application_id: APP, waiver_id: "W-FEE", test: fr, rationale: "rural comp" }, AGENT), /only the partner officer/);
  const w = requestWaiver(h.events, { application_id: APP, waiver_id: "W-FEE", test: fr, rationale: "complex property — appraisal fee documented against the AMC invoice", expires_at: null }, OFFICER);
  assert.equal(w.waiver.kind, "policy_only"); assert.equal(w.waiver.approved_by, "u-officer"); assert.equal(w.event.type, "compliance.waiver.granted"); assert.equal(w.event.applicationId, APP);
  const d = deriveGate(r.run.tests, [w.waiver]);
  assert.equal(d.open, true); assert.deepEqual(d.waived_tests, ["FEE_REASONABLENESS"]);
  assert.equal(EVALUATORS_25_1["25.1.gateOpen"]!({ tests: r.run.tests, waivers: [w.waiver], gate: "SM_O61_COMPLIANCE_PASS_CD_GATE", now: h.clock.now() }).open, true);
  const r2 = evaluateComplianceGate(h.events, "SM_O61_COMPLIANCE_PASS_CD_GATE", s, { now: h.clock.now(), waivers: [w.waiver], escalations: h.escalations });
  assert.equal(r2.open, true); assert.equal(rowOf(r2.run.tests, "FEE_REASONABLENESS").waiver_id, "W-FEE"); assert.deepEqual(r2.derivation.waived_tests, ["FEE_REASONABLENESS"]);
  assert.deepEqual(h.ofType("compliance.gate.opened").at(-1)!.payload.waived_tests, ["FEE_REASONABLENESS"]);
  assert.equal(h.timer("SM_O61_BLOCKING_FAILURE_REVIEW_1BD")!.status, "satisfied", "the cure (gate re-derived open) closes the review clock");
});

test("25.1 worked figures: fixture $560,000.00 at 6.125% → per diem $93.97 × 19 = $1,785.43 (unrounded $1,785.48), PFC $3,849.95 = $1,785.43 + $1,950.00 + $84.00 + $24.95 + $5.57, A $556,150.05, P&I $3,402.62 (unrounded $3,402.61…), payments $1,224,943.20, finance charge $668,793.15, points and fees $2,064.52; buydown 0.750 points $4,200.00 at 5.875% → P&I $3,312.61, unrounded prepaid $1,712.60 (per diem $90.13…), PFC $7,977.12, A $552,022.88, finance charge $640,516.72, APR 5.979; courier $60.00 → $668,853.15; flood determination $9.00 excluded (c)(7)(iv)", () => {
  // example 1 — 26.3 convention: the per diem is rounded to the cent before multiplying
  assert.equal(perDiem365Rounded(56_000_000n, "6.125"), 9_397n);
  const pi = prepaidInterest(56_000_000n, "6.125", D("2026-11-12"));
  assert.equal(pi.prepaid_interest_cents, 178_543n); assert.equal(pi.unrounded_product_cents, 178_548n, "the unrounded product $1,785.48 is not used");
  const cls = classifyFinanceCharges(fees(), { as_of: D("2026-11-02"), state: "AZ" });
  const by = (id: string) => cls.find((r) => r.fee_item_id === id)!;
  assert.equal(by("F-UW").amount_cents, 195_000n); assert.equal(by("F-UW").classification, "prepaid_finance_charge");
  assert.equal(by("F-TAX").amount_cents, 8_400n); assert.equal(by("F-TAX").classification, "prepaid_finance_charge");
  assert.equal(by("F-MERS").amount_cents, 2_495n); assert.equal(by("F-MERS").classification, "prepaid_finance_charge");
  assert.equal(by("F-FLOL").amount_cents, 557n); assert.equal(by("F-FLOL").classification, "prepaid_finance_charge");
  assert.equal(by("F-FDET").amount_cents, 900n); assert.equal(by("F-FDET").classification, "excluded_c7iv");
  assert.equal(by("F-INT").classification, "prepaid_finance_charge"); assert.equal(by("F-REC").classification, "excluded_e1"); assert.equal(by("F-ESC").classification, "excluded_c7v"); assert.equal(by("F-HAZ").classification, "excluded_d"); assert.equal(by("F-TPOL").classification, "excluded_c7i"); assert.equal(by("F-NOT").classification, "excluded_c7iii"); assert.equal(by("F-SETT").classification, "conditional_a2");
  assert.equal(prepaidFinanceCharges(cls), 384_995n);
  const a = computeApr({ ...FIXTURE, prepaid_finance_charges_cents: prepaidFinanceCharges(cls) });
  assert.equal(a.amount_financed_cents, 55_615_005n); assert.equal(a.pi_cents, 340_262n); assert.equal(a.total_of_payments_cents, 122_494_320n); assert.equal(a.finance_charge_cents, 66_879_315n); assert.equal(a.apr_disclosed_str, "6.159"); assert.equal(a.tip_pct, 119.059);
  // the unrounded P&I 3,402.6190… (truncated $3,402.61) rounds half-up to $3,402.62 — the brief's $3,402.63 is wrong (spec discrepancy 6)
  const i = ratePercent("6.125").div(Decimal.fromInt(12));
  const exactPi = centsToDecimal(56_000_000n).mul(i).div(Decimal.fromInt(1).sub(Decimal.fromInt(1).div(Decimal.fromInt(1).add(i).pow(360))));
  assert.equal(exactPi.toScaledInt(2, "DOWN"), 340_261n); assert.equal(exactPi.toCents("HALF_UP"), 340_262n);
  // points and fees: the creditor's fees without interest = $2,064.52 = 0.37% of $560,000 (and the same with no SM flat fee on this fixture)
  const pf = pointsAndFees({ items: fees(), classifications: cls, note_rate_pct: "6.125", apor_pct: "6.020" });
  assert.equal(pf.exclusive_cents, 206_452n); assert.equal(pf.inclusive_cents, 206_452n); assert.equal(pf.sm_flat_fee_cents, 0n); assert.equal(pctOf(pf.inclusive_cents, 56_000_000n, 2), 0.37);
  // with Supermortgage's flat fee the inclusive figure is what the tests block on
  const withSm = pointsAndFees({ items: fees({}, [{ fee_item_id: "F-SM", service_code: "sm_flat_fee", amount_cents: 99_500n, paid_to: "Supermortgage", paid_to_kind: "sm" }]), classifications: classifyFinanceCharges(fees({}, [{ fee_item_id: "F-SM", service_code: "sm_flat_fee", amount_cents: 99_500n, paid_to: "Supermortgage", paid_to_kind: "sm" }]), { as_of: D("2026-11-02"), state: "AZ" }), note_rate_pct: "6.125" });
  assert.equal(withSm.exclusive_cents, 206_452n); assert.equal(withSm.inclusive_cents, 305_952n); assert.equal(withSm.sm_flat_fee_cents, 99_500n);
  // 2026 thresholds are rule-set parameters versioned by year
  const qm = ruleSet<QmRuleSet>("regz.qm.general.2021", D("2026-11-02")).content, ho = ruleSet<HoepaRuleSet>("regz.hoepa", D("2026-11-02")).content, hp = ruleSet<HpmlRuleSet>("regz.hpml", D("2026-11-02")).content;
  assert.equal(qm.apr_tier_1_min_cents, 13_795_800n); assert.equal(qm.apr_tier_2_min_cents, 8_277_500n); assert.equal(qm.pf_tiers[1]!.dollar_cents, 413_900n); assert.equal(qm.pf_tiers[3]!.dollar_cents, 138_000n);
  assert.equal(ho.loan_amount_threshold_cents, 2_759_200n); assert.equal(ho.dollar_trigger_cents, 138_000n); assert.equal(hp.appraisal_exemption_cents, 3_420_000n);
  assert.throws(() => ruleSet("regz.qm.general.2021", D("2027-01-08")), /SM_O61_RULESET_ANNUAL_0101/, "the 2027 thresholds are a new row loaded before Jan 1");
  // example 2 — the borrower buys the rate down on Wed Nov 4: 0.750 points $4,200.00, 5.875%, P&I $3,312.61
  assert.equal(Decimal.parse("560000").mul(Decimal.parse("0.0075")).toCents(), 420_000n);
  const pi2 = prepaidInterest(56_000_000n, "5.875", D("2026-11-12"));
  assert.equal(pi2.unrounded_product_cents, 171_260n, "the spec's 19 × $90.1370 = $1,712.60 (unrounded per diem)");
  assert.equal(centsToDecimal(56_000_000n).mul(ratePercent("5.875")).div(Decimal.fromInt(365)).toScaledInt(2, "DOWN"), 9_013n, "per diem $90.1370 (truncated $90.13)");
  assert.equal(pi2.per_diem_cents, 9_014n); assert.equal(pi2.prepaid_interest_cents, 171_266n, "26.3 convention: $90.14 × 19 = $1,712.66 — the spec's $1,712.60 uses the unrounded per diem (discrepancy)");
  const e2 = computeApr({ ...FIXTURE, note_rate_pct: "5.875", prepaid_finance_charges_cents: 797_712n, prepaid_interest_cents: 171_260n });
  assert.equal(e2.pi_cents, 331_261n); assert.equal(e2.prepaid_finance_charges_cents, 171_260n + 195_000n + 8_400n + 2_495n + 557n + 420_000n); assert.equal(e2.amount_financed_cents, 55_202_288n); assert.equal(e2.finance_charge_cents, 64_051_672n); assert.equal(e2.apr_str, "5.978952"); assert.equal(e2.apr_disclosed_str, "5.979");
  const acc2 = aprAccuracyTest({ disclosed_apr: "6.159", actual_apr: e2.apr_disclosed_str, transaction: { irregular_first_period: true }, disclosed_finance_charge_cents: 66_879_315n, actual_finance_charge_cents: e2.finance_charge_cents });
  assert.equal(acc2.apr_variance, 0.18); assert.equal(acc2.result, "fail", "a decrease beyond tolerance is still inaccurate — the finance charge changed by more than $100 so (a)(4) does not rescue it");
  // example 3 — the $60.00 courier fee the creditor required
  const courier = classifyFinanceCharges([{ fee_item_id: "F-COUR", service_code: "courier", amount_cents: 6_000n, paid_to: "Desert Title Agency LLC", paid_to_kind: "third_party", creditor_requires_charge: true }], { as_of: D("2026-11-06"), state: "AZ" })[0]!;
  assert.equal(courier.classification, "finance_charge"); assert.equal(courier.basis_citation, "§1026.4(a)(2)");
  assert.equal(computeApr({ ...FIXTURE, prepaid_finance_charges_cents: 384_995n + 6_000n }).finance_charge_cents, 66_885_315n);
});
