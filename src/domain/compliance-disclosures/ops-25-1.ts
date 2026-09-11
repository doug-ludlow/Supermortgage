/**
 * §25.1 compliance testing engine — pure rule functions the `compliance-tester` agent runs at every checkpoint
 * (LE, lock, revised LE, CD, corrected CD, consummation, disbursement, delivery, post-closing QC). Every test is
 * deterministic executable logic over a versioned rule set; no model sits in the arithmetic path.
 *
 * Contents (one small function per rule / T-id):
 *   rule sets     RULE_SETS / ruleSet(bundle, asOf) — the 2026 dollar tiers (QM $137,958 / $82,775, P&F $4,139 / $1,380,
 *                 HOEPA $27,592 / $1,380, HPML appraisal exemption $34,200) are rule-set parameters versioned by year
 *                 (addendum §9 bundle names), never constants in code.
 *   registry      TEST_DEFINITIONS — the spec's test registry (blocking B / warning W, checkpoints, waivable=false for
 *                 every legal test).
 *   APR engine    computeApr (Appendix J actuarial method; `appendix_j_exact` and `appendix_j_disregard_17c4`),
 *                 toleranceApplied (§1026.22(a)(2)/(3)), aprAccuracyTest (§1026.22(a)(2)–(5), §1026.38(o)(2)).
 *                 21.2 owns the APR engine per the brief; src/domain/application/ops-21-2.ts does not exist yet, so the
 *                 Appendix J method lives here and the two must be reconciled when 21.2 lands.
 *   finance chg   classifyFinanceCharges (§1026.4 table), prepaidFinanceCharges, pointsAndFees (with and without
 *                 Supermortgage's flat fee — the tests block on the inclusive figure), feeReasonablenessTest.
 *   determinations determineQm / determineHpml / determineHoepa (23.4's determinations re-executed with checkpoint
 *                 figures; `error` when the APOR table for the rate-set week is missing), evaluateStateHighCost.
 *   other tests   checkLicenses, loCompTest, steeringOptionsTest, pricingExceptionTest / reviewPricingException,
 *                 respa8 tests, esignConsentTest, tcpaConsentTest, nmlsrIdTest, template tests.
 *   runs & gates  runTestSuite, deriveGate, evaluateComplianceGate / assertGateOpen (emits compliance.testrun.started,
 *                 compliance.test.passed/failed, compliance.testrun.completed{overall_result}, compliance.gate.opened{gate},
 *                 compliance.gate.blocked{gate, failing_tests}), requestWaiver (compliance.waiver.granted),
 *                 recordLicenseCheck (compliance.license.check_completed), ingestAporTable (apor.table.ingested).
 *
 * Events carry `applicationId` so the 25.1 gates arm under origination context (src/kernel/timers/engine.ts).
 * Money is bigint cents; rates and percentages are computed with src/kernel/money Decimal and exposed as fixed-place
 * numbers only at the boundary.
 */
import { createHash } from "node:crypto";
import { Decimal, divRound } from "../../kernel/money/decimal.ts";
import { type Cents, centsToDecimal, ratePercent, levelPayment, sumCents } from "../../kernel/money/cents.ts";
import { type PlainDate, addMonths, daysBetween, addDays } from "../../kernel/calendar/date.ts";
import { addBusinessDays, creditor } from "../../kernel/calendar/business.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import { perDiem365Rounded, prepaidInterest } from "../orig-boarding/ops-30-2.ts";

export { perDiem365Rounded, prepaidInterest };

const AGENT: Actor = { kind: "agent", id: "compliance-tester" };
const dec = (v: string | number | bigint): Decimal => (typeof v === "bigint" ? Decimal.fromBigInt(v) : Decimal.parse(String(v)));
const ZERO = Decimal.fromInt(0), ONE = Decimal.fromInt(1), HUNDRED = Decimal.fromInt(100);
const nonEmpty = (v: unknown, what: string): string => { if (typeof v !== "string" || !v.trim()) throw new RangeError(`${what} is required`); return v; };
/** Percentage of `part` over `whole` (cents), rounded half-up to `places` decimals, as a number. */
export function pctOf(part: Cents, whole: Cents, places = 3): number {
  if (whole === 0n) throw new RangeError("pctOf: whole is zero");
  return Number(centsToDecimal(part).div(centsToDecimal(whole)).mul(HUNDRED).toFixed(places));
}

// ============================================================ rule sets (versioned by year — addendum §9)
export interface RuleSetVersion<T = Record<string, unknown>> { readonly bundle: string; readonly version: string; readonly effective_from: PlainDate; readonly effective_to: PlainDate | null; readonly content: T; readonly source: string; }
export interface QmRuleSet { readonly apr_tier_1_min_cents: Cents; readonly apr_tier_2_min_cents: Cents; readonly apr_spread_tier_1: string; readonly apr_spread_tier_2: string; readonly apr_spread_tier_3: string; readonly hpct_spread_first_lien: string; readonly hpct_spread_subordinate: string; readonly max_term_months: number;
  readonly pf_tiers: readonly { readonly min_cents: Cents; readonly pct: string | null; readonly dollar_cents: Cents | null }[]; }
export interface HoepaRuleSet { readonly apr_spread_first_lien: string; readonly apr_spread_subordinate: string; readonly loan_amount_threshold_cents: Cents; readonly pf_pct_at_or_above: string; readonly pf_pct_below: string; readonly dollar_trigger_cents: Cents; readonly prepayment_penalty_months: number; readonly prepayment_penalty_pct: string; }
export interface HpmlRuleSet { readonly spread_first_lien: string; readonly spread_jumbo: string; readonly spread_subordinate: string; readonly conforming_limit_cents: Cents; readonly appraisal_exemption_cents: Cents; readonly escrow_years: number; }
export interface StateHighCostRuleSet { readonly statute: string; readonly verified: boolean; readonly apr_trigger_first_lien_over_treasury: string | null; readonly apr_trigger_subordinate_over_treasury: string | null; readonly apr_trigger_hoepa_referenced: boolean; readonly pf_pct_trigger: string; readonly pf_min_total_loan_amount_cents: Cents; readonly pf_small_loan_pct: string | null; readonly pf_small_loan_floor_cents: Cents | null; readonly scope_max_cents: Cents | "conforming_limit"; readonly counting_rule: "federal_1026_32" | "ny_bl_6l" | "nc_gs_24_1_1e"; readonly prepayment_penalty_months: number | null; readonly prepayment_penalty_pct: string | null; }

const c = (dollars: string): Cents => Decimal.parse(dollars).toCents();
/** Every bundle the engine reads; a new year is a new row (`SM_O61_RULESET_ANNUAL_0101`), never an edit. */
export const RULE_SETS: readonly RuleSetVersion[] = [
  { bundle: "regz.apr.appendix_j", version: "2026.09", effective_from: "2026-01-01" as PlainDate, effective_to: null, source: "Appendix J to 12 CFR 1026 (eCFR 9/08/2026); §1026.22; §1026.17(c)(4)", content: { unit_period: "month", bisection_tolerance: "0.000000000001", max_iterations: 200, disregard_max_longer_days: 32, disregard_min_term_months: 120 } },
  { bundle: "regz.finance_charge.1026_4", version: "2026.09", effective_from: "2026-01-01" as PlainDate, effective_to: null, source: "12 CFR 1026.4 (eCFR 9/04/2026)", content: {} },
  { bundle: "regz.trid.2017", version: "2018.06", effective_from: "2018-06-01" as PlainDate, effective_to: null, source: "12 CFR 1026.19(e)/(f), 1026.38 (TRID with 2017/2018 amendments)", content: { fc_understatement_tolerance_cents: 10_000n } },
  { bundle: "regz.qm.general.2021", version: "2026", effective_from: "2026-01-01" as PlainDate, effective_to: "2026-12-31" as PlainDate, source: "12 CFR 1026.43(e)(2)/(e)(3); 90 FR 57890 (Dec 15, 2025) 2026 thresholds",
    content: { apr_tier_1_min_cents: c("137958"), apr_tier_2_min_cents: c("82775"), apr_spread_tier_1: "2.25", apr_spread_tier_2: "3.5", apr_spread_tier_3: "6.5", hpct_spread_first_lien: "1.5", hpct_spread_subordinate: "3.5", max_term_months: 360,
      pf_tiers: [{ min_cents: c("137958"), pct: "3", dollar_cents: null }, { min_cents: c("82775"), pct: null, dollar_cents: c("4139") }, { min_cents: c("27592"), pct: "5", dollar_cents: null }, { min_cents: c("17245"), pct: null, dollar_cents: c("1380") }, { min_cents: 0n, pct: "8", dollar_cents: null }] } satisfies QmRuleSet },
  { bundle: "regz.hoepa", version: "2026", effective_from: "2026-01-01" as PlainDate, effective_to: "2026-12-31" as PlainDate, source: "12 CFR 1026.32(a)(1); 90 FR 57890 (2026: $27,592 / $1,380)",
    content: { apr_spread_first_lien: "6.5", apr_spread_subordinate: "8.5", loan_amount_threshold_cents: c("27592"), pf_pct_at_or_above: "5", pf_pct_below: "8", dollar_trigger_cents: c("1380"), prepayment_penalty_months: 36, prepayment_penalty_pct: "2" } satisfies HoepaRuleSet },
  { bundle: "regz.hpml", version: "2026", effective_from: "2026-01-01" as PlainDate, effective_to: "2026-12-31" as PlainDate, source: "12 CFR 1026.35(a)(1); 90 FR 58141 (2026 appraisal exemption $34,200); Fannie Mae 2026 baseline limit",
    content: { spread_first_lien: "1.5", spread_jumbo: "2.5", spread_subordinate: "3.5", conforming_limit_cents: c("832750"), appraisal_exemption_cents: c("34200"), escrow_years: 5 } satisfies HpmlRuleSet },
  { bundle: "state.high_cost.NY", version: "2014-09-22", effective_from: "2014-09-22" as PlainDate, effective_to: null, source: "N.Y. Banking Law §6-l (nysenate.gov, revision 2014-09-22) — verified 2026-09-10",
    content: { statute: "N.Y. Banking Law §6-l", verified: true, apr_trigger_first_lien_over_treasury: "8", apr_trigger_subordinate_over_treasury: "9", apr_trigger_hoepa_referenced: false, pf_pct_trigger: "5", pf_min_total_loan_amount_cents: c("50000"), pf_small_loan_pct: "6", pf_small_loan_floor_cents: c("1500"), scope_max_cents: "conforming_limit", counting_rule: "ny_bl_6l", prepayment_penalty_months: null, prepayment_penalty_pct: null } satisfies StateHighCostRuleSet },
  { bundle: "state.high_cost.NC", version: "2024-28", effective_from: "2024-07-01" as PlainDate, effective_to: null, source: "N.C.G.S. 24-1.1E (ncleg.gov, last amendment 2024-28 s. 6(a)) — verified 2026-09-10",
    content: { statute: "N.C.G.S. §24-1.1E", verified: true, apr_trigger_first_lien_over_treasury: null, apr_trigger_subordinate_over_treasury: null, apr_trigger_hoepa_referenced: true, pf_pct_trigger: "5", pf_min_total_loan_amount_cents: c("20000"), pf_small_loan_pct: null, pf_small_loan_floor_cents: null, scope_max_cents: "conforming_limit", counting_rule: "nc_gs_24_1_1e", prepayment_penalty_months: 30, prepayment_penalty_pct: "2" } satisfies StateHighCostRuleSet },
  { bundle: "regz.locomp.1026_36", version: "2026.09", effective_from: "2026-01-01" as PlainDate, effective_to: null, source: "12 CFR 1026.36(d)–(i) (eCFR 9/08/2026)", content: { allowed_components: ["salary", "flat_per_loan", "fixed_pct_of_amount", "deferred_plan", "nondeferred_profit"], nondeferred_profit_max_pct: "10", term_proxies: ["rate", "apr", "price", "margin", "points", "fees", "product", "term", "prepayment", "lock_period"] } },
  { bundle: "respa.section8", version: "2024.03", effective_from: "2024-03-15" as PlainDate, effective_to: null, source: "12 CFR 1024.14 / 1024.15; CFPB RESPA Section 8 FAQs (Mar 15, 2024)", content: { afba_required_use_exceptions: ["attorney", "credit_reporting_agency", "appraiser"], afba_retention_years: 5 } },
  { bundle: "nmls.licensing", version: "2026.09", effective_from: "2026-01-01" as PlainDate, effective_to: null, source: "12 CFR 1008.103; 12 CFR 1026.36(f)/(g); NMLS B2B Access FAQ (5/2017)", content: { freshness_days: 30, ok_statuses: ["approved", "approved_conditions"] } },
  { bundle: "esign.7001c", version: "2026.09", effective_from: "2026-01-01" as PlainDate, effective_to: null, source: "15 U.S.C. 7001(c)(1)(A)–(D)", content: { current_hw_sw_statement_version: "2026.1" } },
  { bundle: "tcpa.64_1200", version: "2026.09", effective_from: "2026-01-01" as PlainDate, effective_to: null, source: "47 CFR 64.1200(a)(10); FCC 24-17", content: { dnc_scrub_max_days: 31, revocation_honor_business_days: 10 } },
];
/** The version of `bundle` in force on `asOf` (a checkpoint uses the version in force on the checkpoint date; delivery re-runs use `as_of = consummation_at`). */
export function ruleSet<T = Record<string, unknown>>(bundle: string, asOf: PlainDate, sets: readonly RuleSetVersion[] = RULE_SETS): RuleSetVersion<T> {
  const hit = sets.filter((r) => r.bundle === bundle && r.effective_from <= asOf && (r.effective_to === null || asOf <= r.effective_to)).sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1))[0];
  if (!hit) throw new RangeError(`no rule set ${bundle} in force on ${asOf} (SM_O61_RULESET_ANNUAL_0101: load the year's thresholds before Jan 1)`);
  return hit as RuleSetVersion<T>;
}
/** code → version for every bundle in force on `asOf` (stored on `compliance_test_runs.rule_set_versions`). */
export function ruleSetVersions(asOf: PlainDate, sets: readonly RuleSetVersion[] = RULE_SETS): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of new Set(sets.map((r) => r.bundle))) { try { out[b] = ruleSet(b, asOf, sets).version; } catch { /* not in force */ } }
  return out;
}

// ============================================================ test registry (compliance_test_definitions)
export type Checkpoint = "le" | "lock" | "revised_le" | "cd" | "corrected_cd" | "consummation" | "disbursement" | "delivery" | "post_closing_qc";
export const CHECKPOINTS: readonly Checkpoint[] = ["le", "lock", "revised_le", "cd", "corrected_cd", "consummation", "disbursement", "delivery", "post_closing_qc"];
export type TestResult = "pass" | "fail" | "warn" | "not_applicable" | "error";
export interface TestDefinition { readonly test_code: string; readonly title: string; readonly citation: string; readonly blocking_default: boolean; readonly checkpoints: readonly Checkpoint[]; readonly jurisdiction_scope: "federal" | "state" | "policy"; readonly rule_set_code: string; readonly owner_process: string; readonly waivable: boolean; }
const ALL: readonly Checkpoint[] = CHECKPOINTS;
const CD_ON: readonly Checkpoint[] = ["cd", "corrected_cd", "consummation", "disbursement", "delivery", "post_closing_qc"];
const def = (test_code: string, title: string, citation: string, blocking_default: boolean, checkpoints: readonly Checkpoint[], jurisdiction_scope: TestDefinition["jurisdiction_scope"], rule_set_code: string, owner_process = "25.1", waivable = false): TestDefinition => ({ test_code, title, citation, blocking_default, checkpoints, jurisdiction_scope, rule_set_code, owner_process, waivable });
export const TEST_DEFINITIONS: readonly TestDefinition[] = [
  def("APR_1026_22_ACCURACY", "APR accuracy", "12 CFR 1026.22(a)(2)–(5); Appendix J", true, CD_ON, "federal", "regz.apr.appendix_j"),
  def("FC_1026_4_CLASSIFICATION", "Finance-charge classification", "12 CFR 1026.4", true, ALL, "federal", "regz.finance_charge.1026_4"),
  def("FC_1026_38O2_ACCURACY", "Finance-charge accuracy on the CD", "12 CFR 1026.38(o)(2)", true, CD_ON, "federal", "regz.trid.2017"),
  def("TRID_19E3_TOLERANCE", "Good-faith tolerance", "12 CFR 1026.19(e)(3) (21.5 runToleranceTest)", true, ["revised_le", ...CD_ON], "federal", "regz.trid.2017", "21.5"),
  def("QM_1026_43", "General QM / ATR", "12 CFR 1026.43(e) (23.4 determination)", true, ALL, "federal", "regz.qm.general.2021", "23.4"),
  def("HPML_1026_35", "Higher-priced mortgage loan", "12 CFR 1026.35 (23.4 determination)", true, ALL, "federal", "regz.hpml", "23.4"),
  def("HOEPA_1026_32", "High-cost mortgage", "12 CFR 1026.32 (23.4 determination); Fannie Mae B2-1.5-02", true, ALL, "federal", "regz.hoepa", "23.4"),
  def("STATE_HIGH_COST", "State high-cost / predatory statute (per state code STATE_HIGH_COST_<ST>)", "state statute per jurisdiction_rules.high_cost_statute", true, ["le", "lock", "revised_le", ...CD_ON], "state", "state.high_cost"),
  def("POINTS_FEES_3PCT_FNMA", "Fannie Mae points-and-fees eligibility", "Fannie Mae B2-1.5-02 (policy pending verification)", true, ["delivery"], "policy", "regz.qm.general.2021"),
  def("RESPA_8_UNEARNED_FEES", "No unearned fees / splits", "12 CFR 1024.14(b)–(c)", true, ["cd", "corrected_cd", "delivery"], "federal", "respa.section8"),
  def("RESPA_8_AFBA_DISCLOSURE", "Affiliated business arrangement disclosure", "12 CFR 1024.15", true, ["le", "cd", "corrected_cd"], "federal", "respa.section8"),
  def("RESPA_8_MSA_INVENTORY", "MSA fair-market-value support", "12 CFR 1024.14(g); RESPA §8 FAQs", false, ["cd", "corrected_cd"], "policy", "respa.section8", "25.1", true),
  def("FEE_REASONABLENESS", "Bona fide and reasonable (c)(7) fees", "12 CFR 1026.4(c)(7); fee_benchmarks", false, ["cd", "corrected_cd"], "policy", "regz.finance_charge.1026_4", "25.1", true),
  def("LOCOMP_1026_36D", "Loan-originator compensation", "12 CFR 1026.36(d)", true, ["le", "lock", "cd", "corrected_cd"], "federal", "regz.locomp.1026_36"),
  def("STEERING_1026_36E_OPTIONS", "Anti-steering safe-harbor options", "12 CFR 1026.36(e)(2)–(3)", true, ["lock"], "federal", "regz.locomp.1026_36"),
  def("LO_QUAL_1026_36F", "Loan-originator qualification", "12 CFR 1026.36(f)", true, ["le"], "federal", "nmls.licensing"),
  def("NMLSR_ID_1026_36G", "Name and NMLSR ID on documents", "12 CFR 1026.36(g)", true, ["le", "cd", "corrected_cd", "consummation"], "federal", "regz.locomp.1026_36"),
  def("NMLS_LICENSE_COMPANY", "Partner company license (property state)", "SAFE Act; state law; NMLS", true, ["le", "cd", "corrected_cd"], "federal", "nmls.licensing"),
  def("NMLS_LICENSE_BRANCH", "Branch license where the state licenses branches", "state law; NMLS", true, ["le", "cd", "corrected_cd"], "state", "nmls.licensing"),
  def("NMLS_LICENSE_MLO", "MLO of record license and sponsorship", "12 CFR 1008.103; 12 CFR 1026.36(f)(2)", true, ["le", "cd", "corrected_cd"], "federal", "nmls.licensing"),
  def("SM_STATE_PROCESSOR_LICENSE", "SM third-party processor/underwriter license", "12 CFR 1008.103(d); jurisdiction_rules (31.1)", true, ["le"], "state", "nmls.licensing"),
  def("ESIGN_7001C_CONSENT", "E-SIGN consent for electronic delivery", "15 U.S.C. 7001(c)(1)", true, ["le", "cd", "corrected_cd", "consummation"], "federal", "esign.7001c"),
  def("TCPA_CONSENT_OUTBOUND", "Prior express consent for AI-voice outbound contact", "47 CFR 64.1200; FCC 24-17", true, [], "federal", "tcpa.64_1200"),
  def("FAIR_LENDING_PRICING_EXCEPTION", "No discretionary pricing", "Reg B §1002.4; LL-2026-04", true, ["le", "lock", "cd", "corrected_cd"], "federal", "regz.locomp.1026_36"),
  def("ARBITRATION_1026_36H", "No mandatory arbitration clause", "12 CFR 1026.36(h)", true, ["consummation"], "federal", "regz.locomp.1026_36"),
  def("CREDIT_INSURANCE_1026_36I", "No financed credit-insurance premiums", "12 CFR 1026.36(i)", true, ["consummation"], "federal", "regz.locomp.1026_36"),
  def("AI_DISCLOSURE_STATE", "State AI-disclosure presence (31.2 owns content)", "CO/CA/UT statutes via jurisdiction_rules", true, ["le", "cd", "corrected_cd"], "state", "state.ai_disclosure"),
];
export function testDefinition(code: string): TestDefinition {
  const base = code.startsWith("STATE_HIGH_COST_") ? "STATE_HIGH_COST" : code;
  const d = TEST_DEFINITIONS.find((t) => t.test_code === base);
  if (!d) throw new RangeError(`unknown compliance test ${code}`);
  return code === base ? d : { ...d, test_code: code };
}

// ============================================================ APR engine (Appendix J)
export type AprMethod = "appendix_j_exact" | "appendix_j_disregard_17c4";
export interface AprInput {
  readonly loan_amount_cents: Cents; readonly note_rate_pct: string; readonly term_months: number;
  /** Consummation, or the later date the finance charge begins to be earned (Appendix J (b)(3)(i)) — disbursement on the fixture. */
  readonly term_start_date: PlainDate; readonly first_payment_date: PlainDate;
  readonly prepaid_finance_charges_cents: Cents; readonly prepaid_interest_cents: Cents;
  readonly method?: AprMethod;
  /** Scheduled P&I per period (the legal obligation, §1026.17(c)(1)); defaults to the level payment × term. */
  readonly pi_stream_cents?: readonly Cents[];
  /** MI (or other finance-charge) amounts per period while payable; escrow deposits are never here ((c)(7)(v)). */
  readonly mi_stream_cents?: readonly Cents[];
  readonly checkpoint?: Checkpoint; readonly as_of?: PlainDate;
}
export interface AprCalculation {
  readonly checkpoint: Checkpoint | null; readonly method: AprMethod; readonly term_start_date: PlainDate; readonly first_payment_date: PlainDate; readonly unit_period: "month";
  readonly full_unit_periods_first: number; readonly odd_days: number; readonly odd_fraction: number; readonly odd_fraction_str: string;
  readonly first_period_days: number; readonly first_period_longer_by_days: number; readonly disregard_permitted: boolean;
  readonly amount_financed_cents: Cents; readonly prepaid_finance_charges_cents: Cents; readonly prepaid_interest_cents: Cents; readonly payment_stream_hash: string;
  readonly periodic_rate: string; readonly apr: number; readonly apr_str: string; readonly apr_disclosed: number; readonly apr_disclosed_str: string;
  readonly finance_charge_cents: Cents; readonly total_of_payments_cents: Cents; readonly total_interest_cents: Cents; readonly tip_pct: number;
  readonly pi_cents: Cents; readonly iterations: number; readonly note_rate_identity: boolean; readonly rule_set_version: string;
  readonly loan_amount_cents: Cents; readonly note_rate_pct: string; readonly term_months: number;
}
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const roundHalfUp = (d: Decimal, places: number): string => d.toFixed(places, "HALF_UP");

/** Appendix J (b)(3): full unit-periods counted back from the first payment date; odd days measured forward from the term start to the beginning of the first full unit-period. */
export function countFirstPeriod(term_start_date: PlainDate, first_payment_date: PlainDate): { full_unit_periods_first: number; odd_days: number; first_period_days: number; first_period_longer_by_days: number } {
  if (first_payment_date <= term_start_date) throw new RangeError(`first_payment_date ${first_payment_date} must follow term_start_date ${term_start_date}`);
  let d = first_payment_date, full = 0;
  while (addMonths(d, -1) >= term_start_date) { d = addMonths(d, -1); full++; }
  const odd_days = daysBetween(term_start_date, d);
  const first_period_days = daysBetween(term_start_date, first_payment_date);
  const regular_period_days = daysBetween(addMonths(first_payment_date, -1), first_payment_date);
  return { full_unit_periods_first: full, odd_days, first_period_days, first_period_longer_by_days: first_period_days - regular_period_days };
}

/** The Appendix J solver's precision (`regz.apr.appendix_j` rule set: |Δ| < 10⁻¹², ≤ 200 iterations). */
export interface AppendixJSolverOptions { readonly bisection_tolerance: string; readonly max_iterations: number; }
/** The open-ended (currently in force) `regz.apr.appendix_j` version — for a caller with no as-of date (21.2's LE has none). */
export const APPENDIX_J_OPEN_ENDED = "9999-12-31" as PlainDate;
export function appendixJSolverOptions(asOf: PlainDate = APPENDIX_J_OPEN_ENDED): AppendixJSolverOptions {
  const rs = ruleSet<{ bisection_tolerance: string; max_iterations: number }>("regz.apr.appendix_j", asOf);
  return { bisection_tolerance: rs.content.bisection_tolerance, max_iterations: rs.content.max_iterations };
}
/**
 * THE Appendix J (b)(8) actuarial solver — the one function both APR engines call (21.2's LE `computeApr` and this
 * process's checkpoint `computeApr`; the maintainer reconciliation of the two engines the origination build recorded).
 * Solves A = Σ_k P_k / ((1 + f·i)(1 + i)^(t_k)), t_k = full_unit_periods_first + k − 1, for the unit-period rate i by
 * bisection on [0, 0.1] to the rule set's tolerance. Returns i and the iteration count; the callers format and round.
 */
export function solveAppendixJ(amount_financed: Decimal, payments: readonly Decimal[], full_unit_periods_first: number, odd_fraction: Decimal, opts: AppendixJSolverOptions = appendixJSolverOptions()): { i: Decimal; iterations: number } {
  const pv = (i: Decimal): Decimal => {
    const v = ONE.div(ONE.add(i));
    let fac = v.pow(full_unit_periods_first);   // discount to the first payment
    const oddFactor = ONE.div(ONE.add(odd_fraction.mul(i)));
    let sum = ZERO;
    for (const p of payments) { sum = sum.add(p.mul(fac)); fac = fac.mul(v); }
    return sum.mul(oddFactor);
  };
  const eps = Decimal.parse(opts.bisection_tolerance);
  let lo = ZERO, hi = Decimal.parse("0.1"), iterations = 0;
  while (iterations < opts.max_iterations && hi.sub(lo).cmp(eps) > 0) {
    const mid = lo.add(hi).div(Decimal.fromInt(2));
    if (pv(mid).cmp(amount_financed) > 0) lo = mid; else hi = mid;
    iterations++;
  }
  return { i: lo.add(hi).div(Decimal.fromInt(2)), iterations };
}
/**
 * The APR by the actuarial method: solve Σ_k P_k / ((1 + f·i)(1 + i)^(t_k)) = A for the monthly rate i by bisection
 * (|Δ| < 10⁻¹², ≤ 200 iterations); APR = 12·i to six decimals, disclosed rounded half-up to three. Under
 * `appendix_j_disregard_17c4` (§1026.17(c)(4)(iii): term ≥ 10 years, first period shorter than or ≤ 32 days longer than a
 * regular period) f = 0 and the periods are unchanged; PFC and A do not change.
 */
export function computeApr(input: AprInput): AprCalculation {
  const method = input.method ?? "appendix_j_exact";
  const rs = ruleSet<{ bisection_tolerance: string; max_iterations: number; disregard_max_longer_days: number; disregard_min_term_months: number }>("regz.apr.appendix_j", input.as_of ?? input.term_start_date);
  if (input.loan_amount_cents <= 0n) throw new RangeError("loan_amount_cents must be positive");
  if (!Number.isInteger(input.term_months) || input.term_months <= 0) throw new RangeError("term_months must be a positive integer");
  const pi = levelPayment(input.loan_amount_cents, ratePercent(input.note_rate_pct), input.term_months);
  const piStream = input.pi_stream_cents ?? Array.from({ length: input.term_months }, () => pi);
  if (piStream.length !== input.term_months) throw new RangeError(`pi_stream_cents has ${piStream.length} periods, term is ${input.term_months}`);
  const mi = input.mi_stream_cents ?? [];
  const stream = piStream.map((p, k) => p + (mi[k] ?? 0n));
  const count = countFirstPeriod(input.term_start_date, input.first_payment_date);
  const disregard_permitted = input.term_months >= rs.content.disregard_min_term_months && count.first_period_longer_by_days <= rs.content.disregard_max_longer_days;
  if (method === "appendix_j_disregard_17c4" && !disregard_permitted) throw new RangeError(`§1026.17(c)(4)(iii) disregard is not available: first period is ${count.first_period_longer_by_days} days longer than a regular period (max ${rs.content.disregard_max_longer_days}) or term < ${rs.content.disregard_min_term_months} months`);
  const f = method === "appendix_j_exact" ? Decimal.ratio(BigInt(count.odd_days), 30n) : ZERO;
  const A = centsToDecimal(input.loan_amount_cents - input.prepaid_finance_charges_cents);
  const P = stream.map((x) => centsToDecimal(x));
  const { i, iterations } = solveAppendixJ(A, P, count.full_unit_periods_first, f, { bisection_tolerance: rs.content.bisection_tolerance, max_iterations: rs.content.max_iterations });
  const aprExact = i.mul(Decimal.fromInt(12)).mul(HUNDRED);
  const apr_str = roundHalfUp(aprExact, 6), apr_disclosed_str = roundHalfUp(aprExact, 3);
  const total_of_payments_cents = sumCents(stream), pi_total = sumCents(piStream);
  const total_interest_cents = pi_total - input.loan_amount_cents + input.prepaid_interest_cents;
  const tip = centsToDecimal(total_interest_cents).div(centsToDecimal(input.loan_amount_cents)).mul(HUNDRED);
  const noteRate = Decimal.parse(input.note_rate_pct);
  return {
    checkpoint: input.checkpoint ?? null, method, term_start_date: input.term_start_date, first_payment_date: input.first_payment_date, unit_period: "month",
    ...count, odd_fraction: Number(roundHalfUp(f, 10)), odd_fraction_str: roundHalfUp(f, 10), disregard_permitted,
    amount_financed_cents: input.loan_amount_cents - input.prepaid_finance_charges_cents, prepaid_finance_charges_cents: input.prepaid_finance_charges_cents, prepaid_interest_cents: input.prepaid_interest_cents,
    payment_stream_hash: sha256(stream.map(String).join(",")), periodic_rate: roundHalfUp(i, 12), apr: Number(apr_str), apr_str, apr_disclosed: Number(apr_disclosed_str), apr_disclosed_str,
    finance_charge_cents: total_of_payments_cents + input.prepaid_finance_charges_cents - input.loan_amount_cents, total_of_payments_cents, total_interest_cents, tip_pct: Number(roundHalfUp(tip, 3)),
    pi_cents: pi, iterations, note_rate_identity: aprExact.sub(noteRate).abs().cmp(Decimal.parse("0.00001")) <= 0, rule_set_version: rs.version,
    loan_amount_cents: input.loan_amount_cents, note_rate_pct: input.note_rate_pct, term_months: input.term_months,
  };
}

/** §1026.22(a)(3): irregular = multiple advances, irregular payment periods or amounts — "other than an irregular first period or an irregular first or final payment". */
export interface TransactionShape { readonly multiple_advances?: boolean; readonly irregular_payment_periods?: boolean; readonly irregular_payment_amounts?: boolean; readonly irregular_first_period?: boolean; readonly irregular_first_or_final_payment?: boolean; }
export type ToleranceApplied = "eighth" | "quarter";
export function toleranceApplied(tx: TransactionShape): ToleranceApplied {
  return tx.multiple_advances === true || tx.irregular_payment_periods === true || tx.irregular_payment_amounts === true ? "quarter" : "eighth";
}
export const TOLERANCE_PCT: Record<ToleranceApplied, string> = { eighth: "0.125", quarter: "0.25" };
export const APR_CURE_PLAN = "corrected CD + new 3-business-day waiting period (25.2)";

/** The APR that "results from the disclosed finance charge" (§1026.22(a)(4)): the disclosed finance charge implies disclosed PFC = FC − (Σ P&I − loan); re-solve Appendix J on the calculation's own dates, method and level stream (an MI stream is not carried on the record — the caller passes the (a)(4) rate explicitly in that case). Null when the disclosed figure implies a negative PFC. */
export function aprFromDisclosedFinanceCharge(actual: AprCalculation, disclosed_finance_charge_cents: Cents): AprCalculation | null {
  const pfc = disclosed_finance_charge_cents - (actual.pi_cents * BigInt(actual.term_months) - actual.loan_amount_cents);
  if (pfc < 0n) return null;
  return computeApr({ loan_amount_cents: actual.loan_amount_cents, note_rate_pct: actual.note_rate_pct, term_months: actual.term_months, term_start_date: actual.term_start_date, first_payment_date: actual.first_payment_date, prepaid_finance_charges_cents: pfc, prepaid_interest_cents: actual.prepaid_interest_cents, method: actual.method, ...(actual.checkpoint ? { checkpoint: actual.checkpoint } : {}) });
}
export interface AprAccuracyInput {
  readonly disclosed_apr: number | string; readonly actual_apr: number | string; readonly transaction: TransactionShape;
  readonly disclosed_finance_charge_cents: Cents; readonly actual_finance_charge_cents: Cents;
  /** The APR that results from the disclosed finance charge (the (a)(4) rate); defaults to the disclosed APR when the disclosed figures are internally consistent. */
  readonly apr_from_disclosed_finance_charge?: number | string | null; readonly as_of?: PlainDate;
}
export interface FinanceChargeAccuracy { readonly result: "pass" | "fail"; readonly understated_by_cents: Cents; readonly basis: "o2i_understated_le_100" | "o2ii_overstated" | "exact" | "understated_over_100"; }
/** §1026.38(o)(2): the disclosed finance charge is accurate if understated by no more than $100 or greater than required. */
export function financeChargeAccuracyTest(disclosed: Cents, actual: Cents, as_of: PlainDate = "2026-09-01" as PlainDate): FinanceChargeAccuracy {
  const tol = ruleSet<{ fc_understatement_tolerance_cents: Cents }>("regz.trid.2017", as_of).content.fc_understatement_tolerance_cents;
  const understated = actual - disclosed;
  if (understated === 0n) return { result: "pass", understated_by_cents: 0n, basis: "exact" };
  if (understated < 0n) return { result: "pass", understated_by_cents: understated, basis: "o2ii_overstated" };
  return understated <= tol ? { result: "pass", understated_by_cents: understated, basis: "o2i_understated_le_100" } : { result: "fail", understated_by_cents: understated, basis: "understated_over_100" };
}
export interface AprAccuracy { readonly result: "pass" | "fail"; readonly apr_variance: number; readonly tolerance_applied: ToleranceApplied; readonly tolerance_pct: number; readonly accuracy_basis: "a2" | "a3" | "a4" | "a5" | null; readonly finance_charge: FinanceChargeAccuracy; readonly cure_plan: string | null; readonly message: string; }
/** §1026.22(a)(2)–(5) with the §1026.38(o)(2) finance-charge tolerance feeding (a)(4)/(a)(5). */
export function aprAccuracyTest(input: AprAccuracyInput): AprAccuracy {
  const disclosed = dec(input.disclosed_apr), actual = dec(input.actual_apr);
  const tolerance_applied = toleranceApplied(input.transaction);
  const tol = Decimal.parse(TOLERANCE_PCT[tolerance_applied]);
  const variance = actual.sub(disclosed).abs();
  const apr_variance = Number(roundHalfUp(variance, 3));
  const fc = financeChargeAccuracyTest(input.disclosed_finance_charge_cents, input.actual_finance_charge_cents, input.as_of);
  const base = { apr_variance, tolerance_applied, tolerance_pct: Number(TOLERANCE_PCT[tolerance_applied]), finance_charge: fc };
  const within = variance.cmp(tol) <= 0;
  const a23 = (): AprAccuracy => ({ ...base, result: "pass", accuracy_basis: tolerance_applied === "eighth" ? "a2" : "a3", cure_plan: null, message: `|${roundHalfUp(actual, 3)} − ${roundHalfUp(disclosed, 3)}| = ${apr_variance} ≤ ${TOLERANCE_PCT[tolerance_applied]} (§1026.22(a)(${tolerance_applied === "eighth" ? 2 : 3}))` });
  // the finance charge matches exactly: the (a)(2)/(a)(3) tolerance is the only question
  if (fc.basis === "exact") { if (within) return a23(); }
  else if (fc.result === "pass") {
    // the finance charge differs but is accurate under §1026.38(o)(2) — the mortgage-loan bases of (a)(4)/(a)(5) apply "in addition to" (a)(2)/(a)(3)
    // the (a)(4) rate — the APR that results from the disclosed finance charge (aprFromDisclosedFinanceCharge) — must be supplied; without it the mortgage-loan bases are unavailable (conservative)
    const a4rate = input.apr_from_disclosed_finance_charge === undefined || input.apr_from_disclosed_finance_charge === null ? null : dec(input.apr_from_disclosed_finance_charge);
    if (a4rate === null) { if (within) return a23(); }
    // (a)(4): the disclosed APR results from the disclosed finance charge, which is itself accurate under §1026.38(o)(2)
    else if (a4rate.sub(disclosed).abs().cmp(Decimal.parse("0.0005")) <= 0) return { ...base, result: "pass", accuracy_basis: "a4", cure_plan: null, message: `finance charge ${fc.basis} (§1026.38(o)(2)); disclosed APR results from the disclosed finance charge — accurate under §1026.22(a)(4) regardless of the (a)(2) arithmetic` };
    else if (within) return a23();
    // (a)(5): finance charge calculated incorrectly but accurate; an under/overstated APR is accurate if closer to the actual rate than the (a)(4) rate would be
    else if (actual.sub(disclosed).abs().cmp(actual.sub(a4rate).abs()) <= 0 && disclosed.cmp(actual) === a4rate.cmp(actual)) return { ...base, result: "pass", accuracy_basis: "a5", cure_plan: null, message: "disclosed APR is closer to the actual rate than the rate that would be accurate under (a)(4) — §1026.22(a)(5)" };
  }
  else if (within) return a23();
  return { ...base, result: "fail", accuracy_basis: null, cure_plan: APR_CURE_PLAN, message: `|${roundHalfUp(actual, 3)} − ${roundHalfUp(disclosed, 3)}| = ${apr_variance} > ${TOLERANCE_PCT[tolerance_applied]} and no finance-charge-derived basis — inaccurate as defined in §1026.22 (§1026.19(f)(2)(ii)(A) new waiting period)` };
}

// ============================================================ finance-charge classification (§1026.4)
export type FcClassification = "finance_charge" | "prepaid_finance_charge" | "excluded_c1" | "excluded_c2" | "excluded_c5" | "excluded_c7i" | "excluded_c7ii" | "excluded_c7iii" | "excluded_c7iv" | "excluded_c7v" | "excluded_d" | "excluded_e1" | "excluded_e2" | "excluded_e3" | "conditional_a2";
export type FeeServiceCode = "interest_prepaid" | "underwriting" | "origination" | "discount_points" | "application" | "appraisal" | "credit_report" | "flood_determination" | "flood_life_of_loan" | "tax_service" | "mers_registration" | "title_lender_policy" | "title_exam" | "settlement_fee" | "notary" | "document_preparation" | "survey" | "recording" | "mortgage_tax" | "hazard_premium" | "property_taxes" | "escrow_deposit" | "mi_premium_upfront" | "mi_premium_monthly" | "escrow_waiver_fee" | "late_charge" | "seller_points" | "courier" | "sm_flat_fee" | "broker_compensation" | "credit_insurance_premium" | "other";
export interface FeeItemInput {
  readonly fee_item_id: string; readonly service_code: FeeServiceCode; readonly description?: string; readonly amount_cents: Cents;
  readonly paid_by?: "borrower" | "seller" | "lender" | "sm"; readonly paid_to: string; readonly paid_to_kind?: "creditor" | "affiliate" | "third_party" | "public_official" | "sm";
  readonly creditor_requires_service?: boolean; readonly creditor_requires_charge?: boolean; readonly creditor_retains_portion?: boolean; readonly charged_to_all_applicants?: boolean;
  readonly coverage_required?: boolean; readonly insurer_freely_chosen?: boolean; readonly affirmative_written_request?: boolean; readonly financed?: boolean; readonly bona_fide_discount_points?: number;
  readonly tolerance_class?: "zero" | "ten_percent" | "unlimited";
}
export interface FcClassificationRow { readonly fee_item_id: string; readonly service_code: FeeServiceCode; readonly amount_cents: Cents; readonly classification: FcClassification; readonly basis_citation: string; readonly rationale: string; readonly reasonable: boolean | null; readonly rule_set_version: string; }
export interface FeeBenchmark { readonly state: string; readonly county?: string | null; readonly service_code: FeeServiceCode; readonly low_cents: Cents; readonly high_cents: Cents; readonly source: string; readonly as_of: PlainDate; }
const C7: Partial<Record<FeeServiceCode, [FcClassification, string]>> = {
  title_lender_policy: ["excluded_c7i", "§1026.4(c)(7)(i) title insurance"], title_exam: ["excluded_c7i", "§1026.4(c)(7)(i) title examination"], survey: ["excluded_c7i", "§1026.4(c)(7)(i) property survey"],
  document_preparation: ["excluded_c7ii", "§1026.4(c)(7)(ii) preparing loan-related documents"], notary: ["excluded_c7iii", "§1026.4(c)(7)(iii) notary fees"], credit_report: ["excluded_c7iii", "§1026.4(c)(7)(iii) credit-report fees"],
  appraisal: ["excluded_c7iv", "§1026.4(c)(7)(iv) appraisal performed prior to closing"], flood_determination: ["excluded_c7iv", "§1026.4(c)(7)(iv) flood-hazard determination prior to closing"],
};
/** One row per fee item with the §1026.4 basis; `conditional_a2` flips to `finance_charge` when the creditor requires the particular agent/charge or retains a portion; a (c)(7) fee outside the benchmark band loses its exclusion. */
export function classifyFinanceCharges(items: readonly FeeItemInput[], opts: { as_of: PlainDate; state?: string; county?: string | null; benchmarks?: readonly FeeBenchmark[] } ): FcClassificationRow[] {
  const version = ruleSet("regz.finance_charge.1026_4", opts.as_of).version;
  return items.map((it) => {
    const row = (classification: FcClassification, basis_citation: string, rationale: string, reasonable: boolean | null = null): FcClassificationRow => ({ fee_item_id: it.fee_item_id, service_code: it.service_code, amount_cents: it.amount_cents, classification, basis_citation, rationale, reasonable, rule_set_version: version });
    const required = it.creditor_requires_service === true || it.creditor_requires_charge === true || it.creditor_retains_portion === true;
    switch (it.service_code) {
      case "interest_prepaid": return row("prepaid_finance_charge", "§1026.4(b)(1)", "interest, incl. odd-days prepaid interest (26.3 convention)");
      case "underwriting": case "origination": case "discount_points": return row("prepaid_finance_charge", "§1026.4(b)(3)", "points, loan fees (creditor-retained)");
      case "sm_flat_fee": return row("prepaid_finance_charge", "§1026.4(a); §1026.4(a)(3) (loan-originator organization)", "Supermortgage flat per-loan fee imposed as an incident to the extension of credit (00-master-index 'What Supermortgage itself is')");
      case "broker_compensation": return row("prepaid_finance_charge", "§1026.4(a)(3)", "mortgage-broker fee is a finance charge even if not required or retained");
      case "application": return it.charged_to_all_applicants === true ? row("excluded_c1", "§1026.4(c)(1)", "application fee charged to all applicants whether or not credit is extended") : row("prepaid_finance_charge", "§1026.4(a)", "application fee not charged to all applicants");
      case "late_charge": return row("excluded_c2", "§1026.4(c)(2)", "charge for actual unanticipated late payment");
      case "seller_points": return row("excluded_c5", "§1026.4(c)(5)", "seller's points");
      case "flood_life_of_loan": return row("prepaid_finance_charge", "§1026.4(a); comment 4(c)(7)-3 [PARTIALLY VERIFIED]", "life-of-loan monitoring after closing is not a pre-closing inspection (policy)");
      case "tax_service": return row("prepaid_finance_charge", "§1026.4(a)", "not within (c)(7); imposed by the creditor (policy classification)");
      case "mers_registration": return row("prepaid_finance_charge", "§1026.4(a); (e)(1) inapplicable", "not paid to a public official");
      case "recording": return row("excluded_e1", "§1026.4(e)(1)", "fees paid to public officials for perfecting/releasing a security interest");
      case "mortgage_tax": return row("excluded_e3", "§1026.4(e)(3)", "tax on security instruments required for recording");
      case "hazard_premium": return it.coverage_required === false || it.insurer_freely_chosen === true ? row("excluded_d", "§1026.4(d)(2)", "property insurance from an insurer of the consumer's choice") : row("finance_charge", "§1026.4(b)(5)/(d)(2)", "property insurance conditions of (d)(2) not met");
      case "credit_insurance_premium": return it.coverage_required !== true && it.affirmative_written_request === true ? row("excluded_d", "§1026.4(d)(1)", "voluntary credit insurance with the consumer's affirmative written request") : row("finance_charge", "§1026.4(b)(7)/(d)(1)", "credit insurance not shown voluntary");
      case "property_taxes": case "escrow_deposit": return row("excluded_c7v", "§1026.4(c)(7)(v)", "amounts paid into escrow not otherwise a finance charge");
      case "mi_premium_upfront": return row("prepaid_finance_charge", "§1026.4(b)(5)", "premium for insurance protecting the creditor against default (upfront)");
      case "mi_premium_monthly": return row("finance_charge", "§1026.4(b)(5)", "mortgage insurance payable monthly");
      case "escrow_waiver_fee": return row("prepaid_finance_charge", "§1026.4(a)", "imposed as a condition of credit");
      case "settlement_fee": case "courier": {
        if (required) return row("finance_charge", "§1026.4(a)(2)", "closing-agent charge the creditor requires or retains a portion of");
        return it.service_code === "courier" ? row("conditional_a2", "§1026.4(a)(2)", "third-party closing-agent charge; finance charge only if the creditor requires the particular service or charge") : row("conditional_a2", "§1026.4(c)(7)(ii)/(a)(2)", "settlement/escrow fee — excluded if bona fide and reasonable and not required/retained by the creditor");
      }
      default: {
        const c7 = C7[it.service_code];
        if (c7) {
          const reasonable = feeReasonable(it, opts);
          if (reasonable === false) return row("prepaid_finance_charge", `${c7[1]} — exclusion withdrawn`, "outside the fee_benchmarks band: not shown bona fide and reasonable in amount (decision 25.1-Q5); paid at closing → prepaid finance charge, APR recomputed", false);
          return row(c7[0], c7[1], "bona fide real-estate-related fee", reasonable);
        }
        return row("finance_charge", "§1026.4(a)", "charge imposed by the creditor as an incident to the extension of credit (default)");
      }
    }
  });
}
/** `reasonable = low ≤ amount ≤ high` from `fee_benchmarks` for the property state/county; null when no benchmark exists. */
export function feeReasonable(it: FeeItemInput, opts: { state?: string; county?: string | null; benchmarks?: readonly FeeBenchmark[] }): boolean | null {
  const b = (opts.benchmarks ?? []).filter((x) => x.service_code === it.service_code && x.state === opts.state && (x.county == null || x.county === opts.county)).sort((x, y) => (x.county ? -1 : y.county ? 1 : 0))[0];
  if (!b) return null;
  return it.amount_cents >= b.low_cents && it.amount_cents <= b.high_cents;
}
export const prepaidFinanceCharges = (rows: readonly FcClassificationRow[]): Cents => sumCents(rows.filter((r) => r.classification === "prepaid_finance_charge").map((r) => r.amount_cents));
export interface FeeReasonablenessOutcome { readonly result: "pass" | "warn"; readonly outside_band: readonly { fee_item_id: string; service_code: FeeServiceCode; amount_cents: Cents; low_cents: Cents; high_cents: Cents }[]; readonly reclassified: readonly string[]; }
/** FEE_REASONABLENESS (W → B when a (c)(7) exclusion depended on it): a fee outside the band withdraws the exclusion and warns `officer`. */
export function feeReasonablenessTest(items: readonly FeeItemInput[], opts: { state?: string; county?: string | null; benchmarks?: readonly FeeBenchmark[] }): FeeReasonablenessOutcome {
  const outside: FeeReasonablenessOutcome["outside_band"][number][] = [];
  for (const it of items) {
    if (!C7[it.service_code]) continue;
    const b = (opts.benchmarks ?? []).find((x) => x.service_code === it.service_code && x.state === opts.state && (x.county == null || x.county === opts.county));
    if (b && (it.amount_cents < b.low_cents || it.amount_cents > b.high_cents)) outside.push({ fee_item_id: it.fee_item_id, service_code: it.service_code, amount_cents: it.amount_cents, low_cents: b.low_cents, high_cents: b.high_cents });
  }
  return { result: outside.length ? "warn" : "pass", outside_band: outside, reclassified: outside.map((o) => o.fee_item_id) };
}

// ============================================================ points and fees (§1026.32(b)(1); state counting rules)
export type PfCountingRule = StateHighCostRuleSet["counting_rule"];
export interface PointsAndFeesInput {
  readonly items: readonly FeeItemInput[]; readonly classifications: readonly FcClassificationRow[];
  readonly note_rate_pct: string; readonly undiscounted_rate_pct?: string | null; readonly apor_pct?: string | null; readonly fnma_required_net_yield_pct?: string | null;
  readonly lo_compensation_cents?: Cents; readonly max_prepayment_penalty_cents?: Cents;
}
export interface PointsAndFees { readonly counting_rule: PfCountingRule; readonly exclusive_cents: Cents; readonly inclusive_cents: Cents; readonly sm_flat_fee_cents: Cents; readonly excluded_discount_points_cents: Cents; readonly items: readonly { fee_item_id: string; amount_cents: Cents; included: boolean; basis: string }[]; }
/** Bona fide discount points excludable: federal (b)(1)(i)(E)/(F) — up to 2 points if the undiscounted rate ≤ APOR + 1, up to 1 if ≤ APOR + 2; NY §6-l benchmark is the Fannie Mae required net yield + 1 [UNVERIFIED — benchmark text not fetched; jurisdiction_rules carries the verified text]. */
export function excludableDiscountPoints(rule: PfCountingRule, inp: Pick<PointsAndFeesInput, "undiscounted_rate_pct" | "apor_pct" | "fnma_required_net_yield_pct">): number {
  const und = inp.undiscounted_rate_pct ? Decimal.parse(inp.undiscounted_rate_pct) : null;
  if (!und) return 0;
  if (rule === "ny_bl_6l") { const y = inp.fnma_required_net_yield_pct ? Decimal.parse(inp.fnma_required_net_yield_pct) : null; return y && und.cmp(y.add(ONE)) <= 0 ? 2 : 0; }
  const apor = inp.apor_pct ? Decimal.parse(inp.apor_pct) : null;
  if (!apor) return 0;
  if (und.cmp(apor.add(ONE)) <= 0) return 2;
  if (und.cmp(apor.add(Decimal.fromInt(2))) <= 0) return 1;
  return 0;
}
/**
 * Points and fees both without and with Supermortgage's flat fee ("compute points and fees both ways and block on the inclusive figure").
 * Maintainer note (build-notes defect "pf cap rounds HALF_UP where rule says floor"): the 25.1 spec text states the cap only as
 * "3 percent of the total loan amount" (§43) with no rounding direction, so `qmPointsAndFeesCap` keeps the platform's
 * round-half-up-to-the-cent convention (docs/ARCHITECTURE.md rule 1); a floor is adopted only when 23.4's determination text says so.
 * Likewise "classifyFinanceCharges ignores creditor-retained (c)(7) items": the spec's classification table (§140–147) withdraws a
 * (c)(7) exclusion only for an unreasonable amount (FEE_REASONABLENESS) and flips only `conditional_a2` on creditor retention;
 * creditor/affiliate receipt of a (c)(7) fee is counted in points and fees here (§1026.32(b)(1)(iii)), not re-classified.
 */
export function pointsAndFees(inp: PointsAndFeesInput, rule: PfCountingRule = "federal_1026_32"): PointsAndFees {
  const byId = new Map(inp.classifications.map((r) => [r.fee_item_id, r] as const));
  const maxPts = excludableDiscountPoints(rule, inp);
  let excludedPts = 0n, exclusive = 0n, sm = 0n;
  const rows: PointsAndFees["items"][number][] = [];
  for (const it of inp.items) {
    const cls = byId.get(it.fee_item_id);
    if (!cls) throw new RangeError(`fee item ${it.fee_item_id} has no finance_charge_classification`);
    let included = false, basis = "not counted";
    if (it.service_code === "interest_prepaid") { basis = "§1026.32(b)(1)(i)(A) interest excluded"; }
    else if (it.service_code === "discount_points") {
      const pts = it.bona_fide_discount_points ?? 0;
      const excl = Math.min(pts, maxPts);
      const exclCents = pts > 0 ? divRound(it.amount_cents * BigInt(Math.round(excl * 1000)), BigInt(Math.round(pts * 1000)), "HALF_UP") : 0n;
      excludedPts += exclCents; const counted = it.amount_cents - exclCents; exclusive += counted; included = counted > 0n;
      basis = excl > 0 ? `${excl} bona fide discount point(s) excluded (${rule === "ny_bl_6l" ? "NY §6-l(1)(d)" : "§1026.32(b)(1)(i)(E)/(F)"}); ${counted} cents counted` : "discount points not excludable (rate benchmark failed)";
    }
    else if (cls.classification === "prepaid_finance_charge" || cls.classification === "finance_charge") {
      if (it.service_code === "mi_premium_monthly") basis = "§1026.32(b)(1)(i)(C) premiums payable after consummation excluded";
      else if (it.service_code === "sm_flat_fee") { sm += it.amount_cents; basis = "Supermortgage flat fee — counted on the inclusive figure (§1026.36 loan-originator organization question open)"; }
      else { included = true; exclusive += it.amount_cents; basis = "§1026.32(b)(1)(i) item in the finance charge"; }
    }
    else if (["excluded_c7i", "excluded_c7ii", "excluded_c7iii", "excluded_c7iv", "conditional_a2"].includes(cls.classification)) {
      const toAffiliate = it.paid_to_kind === "creditor" || it.paid_to_kind === "affiliate";
      if (toAffiliate || cls.reasonable === false) { included = true; exclusive += it.amount_cents; basis = "§1026.32(b)(1)(iii) real-estate fee paid to the creditor/affiliate or not bona fide and reasonable"; }
      else basis = "§1026.32(b)(1)(iii) bona fide third-party charge excluded";
    }
    else if (cls.classification === "excluded_d" && it.service_code === "credit_insurance_premium") { included = true; exclusive += it.amount_cents; basis = "§1026.32(b)(1)(iv) credit-insurance premium"; }
    rows.push({ fee_item_id: it.fee_item_id, amount_cents: it.amount_cents, included, basis });
  }
  exclusive += inp.lo_compensation_cents ?? 0n; exclusive += inp.max_prepayment_penalty_cents ?? 0n;
  return { counting_rule: rule, exclusive_cents: exclusive, inclusive_cents: exclusive + sm, sm_flat_fee_cents: sm, excluded_discount_points_cents: excludedPts, items: rows };
}
/** §1026.32(b)(4)(i): total loan amount = amount financed − financed (iii)/(iv)/(vi) items. */
export function totalLoanAmount(amount_financed_cents: Cents, financed_pf_items_cents: Cents = 0n): Cents { return amount_financed_cents - financed_pf_items_cents; }

// ============================================================ QM / HPML / HOEPA (23.4's determinations re-executed with checkpoint figures)
export interface AporTable { readonly table_date: PlainDate; readonly term_years: number; readonly product: "fixed" | "adjustable"; readonly apor_pct: string; }
/**
 * The APOR as of the rate-set date: the table for the week containing `rate_set_date` (table_date ≤ rate_set_date < table_date + 7).
 * Maintainer note (build-notes defect "aporAsOf only within the rate-set week"): this is the spec's rule — "FFIEC APOR tables …
 * parsed by term and rate-set week" (§164) and "Missing APOR for the rate-set week (FFIEC late): tests `error` → gates block;
 * `officer` may not waive; wait for the table" (§189) — so an older table is never carried forward (T-test: the Sep 28 table does not cover Oct 7).
 */
export function aporAsOf(tables: readonly AporTable[], rate_set_date: PlainDate, term_years = 30, product: "fixed" | "adjustable" = "fixed"): AporTable | null {
  return tables.find((t) => t.term_years === term_years && t.product === product && t.table_date <= rate_set_date && rate_set_date < addDays(t.table_date, 7)) ?? null;
}
export interface DeterminationInput { readonly apr: number | string; readonly apor: AporTable | null; readonly rate_set_date: PlainDate; readonly as_of: PlainDate; readonly loan_amount_cents: Cents; readonly total_loan_amount_cents: Cents; readonly points_and_fees_cents: Cents; readonly lien_position: "first" | "subordinate"; readonly occupancy?: "primary" | "second_home" | "investment"; readonly term_months?: number; readonly prepayment_penalty?: { months: number; max_pct: string } | null; readonly escrow_established?: boolean; readonly checkpoint?: Checkpoint; }
export interface QmDetermination { readonly result: TestResult; readonly qm_type: "general_safe_harbor" | "general_rebuttable" | "not_qm" | null; readonly apr: number; readonly apor: string | null; readonly spread: number | null; readonly apr_tier: string | null; readonly apr_test_pass: boolean | null; readonly hpct: boolean | null; readonly points_and_fees_cents: Cents; readonly cap_cents: Cents; readonly cap_basis: string; readonly pf_pass: boolean; readonly rule_set_version: string; readonly evidence: Record<string, unknown>; readonly message: string; }
export function qmPointsAndFeesCap(rs: QmRuleSet, total_loan_amount_cents: Cents): { cap_cents: Cents; basis: string } {
  for (const t of rs.pf_tiers) if (total_loan_amount_cents >= t.min_cents) return t.pct ? { cap_cents: centsToDecimal(total_loan_amount_cents).mul(Decimal.parse(t.pct)).div(HUNDRED).toCents(), basis: `${t.pct}% of the total loan amount (≥ $${(t.min_cents / 100n).toString()})` } : { cap_cents: t.dollar_cents!, basis: `$${(t.dollar_cents! / 100n).toString()} (≥ $${(t.min_cents / 100n).toString()})` };
  throw new RangeError("no points-and-fees tier matched");
}
export function determineQm(inp: DeterminationInput): QmDetermination {
  const rsv = ruleSet<QmRuleSet>("regz.qm.general.2021", inp.as_of), rs = rsv.content;
  const apr = Number(roundHalfUp(dec(inp.apr), 3));
  const cap = qmPointsAndFeesCap(rs, inp.total_loan_amount_cents);
  const pf_pass = inp.points_and_fees_cents <= cap.cap_cents;
  const base = { apr, points_and_fees_cents: inp.points_and_fees_cents, cap_cents: cap.cap_cents, cap_basis: cap.basis, pf_pass, rule_set_version: rsv.version };
  if (!inp.apor) return { ...base, result: "error", qm_type: null, apor: null, spread: null, apr_tier: null, apr_test_pass: null, hpct: null, evidence: { rate_set_date: inp.rate_set_date, apor_table_date: null }, message: `QM_1026_43: no APOR table for the rate-set week of ${inp.rate_set_date} — error (blocks; not waivable)` };
  const spreadD = dec(inp.apr).sub(Decimal.parse(inp.apor.apor_pct));
  const spread = Number(roundHalfUp(spreadD, 3));
  const tier = inp.lien_position === "subordinate" ? rs.apr_spread_tier_3 : inp.loan_amount_cents >= rs.apr_tier_1_min_cents ? rs.apr_spread_tier_1 : inp.loan_amount_cents >= rs.apr_tier_2_min_cents ? rs.apr_spread_tier_2 : rs.apr_spread_tier_3;
  const apr_test_pass = spreadD.cmp(Decimal.parse(tier)) < 0;
  const hpct = spreadD.cmp(Decimal.parse(inp.lien_position === "first" ? rs.hpct_spread_first_lien : rs.hpct_spread_subordinate)) >= 0;
  const termOk = (inp.term_months ?? 360) <= rs.max_term_months;
  const qm = apr_test_pass && pf_pass && termOk;
  const qm_type = !qm ? "not_qm" : hpct ? "general_rebuttable" : "general_safe_harbor";
  const evidence = { rate_set_date: inp.rate_set_date, apor_table_date: inp.apor.table_date, apor: inp.apor.apor_pct, spread, apr_tier: tier, cap_cents: cap.cap_cents, pf_pct_of_total_loan_amount: pctOf(inp.points_and_fees_cents, inp.total_loan_amount_cents, 2) };
  return { ...base, result: qm ? "pass" : "fail", qm_type, apor: inp.apor.apor_pct, spread, apr_tier: tier, apr_test_pass, hpct, evidence, message: qm ? `General QM ${qm_type}: spread ${spread} < ${tier}; points and fees ${inp.points_and_fees_cents} ≤ cap ${cap.cap_cents} (${cap.basis})` : `not QM: apr_test_pass=${apr_test_pass} (spread ${spread} vs ${tier}); pf_pass=${pf_pass} (${inp.points_and_fees_cents} vs ${cap.cap_cents})` };
}
export interface HpmlDetermination { readonly result: TestResult; readonly is_hpml: boolean | null; readonly spread: number | null; readonly threshold: string | null; readonly escrow_required: boolean | null; readonly escrow_established: boolean | null; readonly rule_set_version: string; readonly message: string; readonly evidence: Record<string, unknown>; }
export function determineHpml(inp: DeterminationInput): HpmlDetermination {
  const rsv = ruleSet<HpmlRuleSet>("regz.hpml", inp.as_of), rs = rsv.content;
  if (!inp.apor) return { result: "error", is_hpml: null, spread: null, threshold: null, escrow_required: null, escrow_established: null, rule_set_version: rsv.version, message: `HPML_1026_35: no APOR table for ${inp.rate_set_date}`, evidence: { rate_set_date: inp.rate_set_date } };
  const threshold = inp.lien_position === "subordinate" ? rs.spread_subordinate : inp.loan_amount_cents > rs.conforming_limit_cents ? rs.spread_jumbo : rs.spread_first_lien;
  const spreadD = dec(inp.apr).sub(Decimal.parse(inp.apor.apor_pct));
  const is_hpml = spreadD.cmp(Decimal.parse(threshold)) >= 0;
  const escrow_required = is_hpml && inp.lien_position === "first";
  const escrow_established = inp.escrow_established ?? null;
  const atConsummation = inp.checkpoint === "consummation" || inp.checkpoint === "disbursement" || inp.checkpoint === "delivery";
  const fail = escrow_required && atConsummation && escrow_established !== true;
  return { result: fail ? "fail" : "pass", is_hpml, spread: Number(roundHalfUp(spreadD, 3)), threshold, escrow_required, escrow_established, rule_set_version: rsv.version,
    message: is_hpml ? `HPML (spread ${roundHalfUp(spreadD, 3)} ≥ ${threshold}); escrow ${escrow_required ? "required before consummation (§1026.35(b)(1), " + rs.escrow_years + "-year cancellation floor)" : "n/a"}${fail ? " — NOT established" : ""}` : `not HPML (spread ${roundHalfUp(spreadD, 3)} < ${threshold})`,
    evidence: { rate_set_date: inp.rate_set_date, apor_table_date: inp.apor.table_date, apor: inp.apor.apor_pct, conforming_limit_cents: rs.conforming_limit_cents, appraisal_exemption_cents: rs.appraisal_exemption_cents } };
}
export interface HoepaDetermination { readonly result: TestResult; readonly is_high_cost: boolean | null; readonly apr_trigger: boolean | null; readonly pf_trigger: boolean; readonly ppp_trigger: boolean; readonly pf_threshold_cents: Cents; readonly pf_basis: string; readonly rule_set_version: string; readonly message: string; readonly evidence: Record<string, unknown>; }
export function determineHoepa(inp: DeterminationInput): HoepaDetermination {
  const rsv = ruleSet<HoepaRuleSet>("regz.hoepa", inp.as_of), rs = rsv.content;
  const big = inp.loan_amount_cents >= rs.loan_amount_threshold_cents;
  const pf_threshold_cents = big ? centsToDecimal(inp.total_loan_amount_cents).mul(Decimal.parse(rs.pf_pct_at_or_above)).div(HUNDRED).toCents() : (() => { const eight = centsToDecimal(inp.total_loan_amount_cents).mul(Decimal.parse(rs.pf_pct_below)).div(HUNDRED).toCents(); return eight < rs.dollar_trigger_cents ? eight : rs.dollar_trigger_cents; })();
  const pf_basis = big ? `${rs.pf_pct_at_or_above}% of the total loan amount (loan amount ≥ $${(rs.loan_amount_threshold_cents / 100n).toString()})` : `lesser of ${rs.pf_pct_below}% or $${(rs.dollar_trigger_cents / 100n).toString()}`;
  const pf_trigger = inp.points_and_fees_cents > pf_threshold_cents;
  const ppp = inp.prepayment_penalty ?? null;
  const ppp_trigger = ppp !== null && (ppp.months > rs.prepayment_penalty_months || Decimal.parse(ppp.max_pct).cmp(Decimal.parse(rs.prepayment_penalty_pct)) > 0);
  const evidence = { rate_set_date: inp.rate_set_date, apor_table_date: inp.apor?.table_date ?? null, pf_threshold_cents, pf_pct_of_total_loan_amount: pctOf(inp.points_and_fees_cents, inp.total_loan_amount_cents, 2) };
  if (!inp.apor) return { result: pf_trigger || ppp_trigger ? "fail" : "error", is_high_cost: pf_trigger || ppp_trigger ? true : null, apr_trigger: null, pf_trigger, ppp_trigger, pf_threshold_cents, pf_basis, rule_set_version: rsv.version, message: "HOEPA_1026_32: APR trigger indeterminate without the APOR table", evidence };
  const spreadD = dec(inp.apr).sub(Decimal.parse(inp.apor.apor_pct));
  const apr_trigger = spreadD.cmp(Decimal.parse(inp.lien_position === "first" ? rs.apr_spread_first_lien : rs.apr_spread_subordinate)) > 0;
  const is_high_cost = apr_trigger || pf_trigger || ppp_trigger;
  return { result: is_high_cost ? "fail" : "pass", is_high_cost, apr_trigger, pf_trigger, ppp_trigger, pf_threshold_cents, pf_basis, rule_set_version: rsv.version, evidence: { ...evidence, spread: Number(roundHalfUp(spreadD, 3)) },
    message: is_high_cost ? `HOEPA high-cost mortgage (apr_trigger=${apr_trigger}, pf_trigger=${pf_trigger}, ppp_trigger=${ppp_trigger}) — ineligible for Fannie Mae delivery (B2-1.5-02)` : `HOEPA_1026_32 = false (spread ${roundHalfUp(spreadD, 3)}; points and fees ${inp.points_and_fees_cents} ≤ ${pf_threshold_cents})` };
}

// ============================================================ state high-cost (STATE_HIGH_COST_<ST>)
export interface StateHighCostInput { readonly state: string; readonly as_of: PlainDate; readonly apr: number | string; readonly treasury_yield_pct?: string | null; readonly hoepa_apr_trigger?: boolean | null; readonly loan_amount_cents: Cents; readonly total_loan_amount_cents: Cents; readonly points_and_fees_state_cents: Cents; readonly lien_position: "first" | "subordinate"; readonly conforming_limit_cents?: Cents; readonly prepayment_penalty?: { months: number; max_pct: string } | null; readonly jurisdiction_high_cost_statute?: string | null; }
export interface StateHighCostOutcome { readonly test_code: string; readonly result: TestResult; readonly in_scope: boolean; readonly apr_trigger: boolean | null; readonly pf_trigger: boolean; readonly pf_threshold_cents: Cents | null; readonly ppp_trigger: boolean; readonly statute: string | null; readonly rule_set_version: string | null; readonly counting_rule: PfCountingRule | null; readonly message: string; }
export function evaluateStateHighCost(inp: StateHighCostInput): StateHighCostOutcome {
  const test_code = `STATE_HIGH_COST_${inp.state.toUpperCase()}`;
  let rsv: RuleSetVersion<StateHighCostRuleSet> | null = null;
  try { rsv = ruleSet<StateHighCostRuleSet>(`state.high_cost.${inp.state.toUpperCase()}`, inp.as_of); } catch { rsv = null; }
  if (!rsv) return { test_code, result: inp.jurisdiction_high_cost_statute ? "error" : "not_applicable", in_scope: false, apr_trigger: null, pf_trigger: false, pf_threshold_cents: null, ppp_trigger: false, statute: inp.jurisdiction_high_cost_statute ?? null, rule_set_version: null, counting_rule: null, message: inp.jurisdiction_high_cost_statute ? `${test_code}: jurisdiction_rules names ${inp.jurisdiction_high_cost_statute} but no verified rule set is loaded (31.1 verifies before origination)` : `${test_code}: no high-cost statute row for ${inp.state} — not applicable` };
  const rs = rsv.content;
  const limit = rs.scope_max_cents === "conforming_limit" ? (inp.conforming_limit_cents ?? ruleSet<HpmlRuleSet>("regz.hpml", inp.as_of).content.conforming_limit_cents) : rs.scope_max_cents;
  if (inp.loan_amount_cents > limit) return { test_code, result: "not_applicable", in_scope: false, apr_trigger: null, pf_trigger: false, pf_threshold_cents: null, ppp_trigger: false, statute: rs.statute, rule_set_version: rsv.version, counting_rule: rs.counting_rule, message: `${test_code}: principal ${inp.loan_amount_cents} exceeds the statute's scope limit ${limit}` };
  let apr_trigger: boolean | null = null;
  if (rs.apr_trigger_hoepa_referenced) apr_trigger = inp.hoepa_apr_trigger ?? null;
  else if (inp.treasury_yield_pct) { const t = Decimal.parse(inp.treasury_yield_pct); const spread = dec(inp.apr).sub(t); apr_trigger = inp.lien_position === "first" ? spread.cmp(Decimal.parse(rs.apr_trigger_first_lien_over_treasury!)) > 0 : spread.cmp(Decimal.parse(rs.apr_trigger_subordinate_over_treasury!)) >= 0; }
  const small = inp.total_loan_amount_cents < rs.pf_min_total_loan_amount_cents;
  const pf_threshold_cents = small && rs.pf_small_loan_pct ? (() => { const p = centsToDecimal(inp.total_loan_amount_cents).mul(Decimal.parse(rs.pf_small_loan_pct)).div(HUNDRED).toCents(); return p > (rs.pf_small_loan_floor_cents ?? 0n) ? p : (rs.pf_small_loan_floor_cents ?? p); })() : centsToDecimal(inp.total_loan_amount_cents).mul(Decimal.parse(rs.pf_pct_trigger)).div(HUNDRED).toCents();
  const pf_trigger = inp.points_and_fees_state_cents > pf_threshold_cents;
  const ppp = inp.prepayment_penalty ?? null;
  const ppp_trigger = ppp !== null && rs.prepayment_penalty_months !== null && (ppp.months > rs.prepayment_penalty_months || Decimal.parse(ppp.max_pct).cmp(Decimal.parse(rs.prepayment_penalty_pct!)) > 0);
  const high = apr_trigger === true || pf_trigger || ppp_trigger;
  return { test_code, result: high ? "fail" : apr_trigger === null && !rs.apr_trigger_hoepa_referenced ? "error" : "pass", in_scope: true, apr_trigger, pf_trigger, pf_threshold_cents, ppp_trigger, statute: rs.statute, rule_set_version: rsv.version, counting_rule: rs.counting_rule,
    message: high ? `${test_code} = fail under ${rs.statute}: ${pf_trigger ? `points and fees ${inp.points_and_fees_state_cents} exceed ${rs.pf_pct_trigger}% (${pf_threshold_cents}) of the total loan amount` : apr_trigger ? "APR trigger" : "prepayment-penalty trigger"}` : apr_trigger === null && !rs.apr_trigger_hoepa_referenced ? `${test_code}: treasury yield missing for the APR trigger` : `${test_code} = pass under ${rs.statute}` };
}

// ============================================================ licensing (NMLS_LICENSE_*, LO_QUAL_1026_36F)
export type LicenseStatus = "approved" | "approved_conditions" | "pending" | "inactive" | "expired" | "revoked" | "not_found";
export interface LicenseCheck { readonly check_id: string; readonly party_type: "company" | "branch" | "individual"; readonly party_ref: string; readonly nmls_id: string; readonly state: string; readonly license_type: string; readonly status: LicenseStatus; readonly sponsorship_ok: boolean | null; readonly checked_at: PlainDate; readonly valid_through: PlainDate | null; readonly source: "nmls_b2b" | "nmls_consumer_access_manual"; readonly evidence_document_id: string | null; }
export interface LicenseRequirements { readonly branch_licensed_state: boolean; readonly third_party_processor_license_required?: boolean; readonly sm_processor_license?: LicenseCheck | null; readonly mlo_fitness_attested?: boolean; }
export interface LicenseOutcome { readonly test_code: "NMLS_LICENSE_COMPANY" | "NMLS_LICENSE_BRANCH" | "NMLS_LICENSE_MLO" | "SM_STATE_PROCESSOR_LICENSE" | "LO_QUAL_1026_36F"; readonly result: TestResult; readonly effective_status: LicenseStatus | null; readonly check_id: string | null; readonly stale: boolean; readonly message: string; readonly escalate_to: "officer" | "mlo_of_record" | "licensed_specialist" | null; }
/** Effective status of the freshest check for a party in the property state; older than 30 days counts as `not_found`. */
export function effectiveLicense(checks: readonly LicenseCheck[], party_type: LicenseCheck["party_type"], state: string, as_of: PlainDate, freshness_days = 30): { check: LicenseCheck | null; status: LicenseStatus; stale: boolean } {
  const hits = checks.filter((k) => k.party_type === party_type && k.state === state && k.checked_at <= as_of).sort((a, b) => (a.checked_at < b.checked_at ? 1 : -1));
  const check = hits[0] ?? null;
  if (!check) return { check: null, status: "not_found", stale: false };
  const stale = daysBetween(check.checked_at, as_of) > freshness_days;
  const expired = check.valid_through !== null && check.valid_through < as_of;
  return { check, status: stale ? "not_found" : expired ? "expired" : check.status, stale };
}
export function checkLicenses(inp: { state: string; as_of: PlainDate; checks: readonly LicenseCheck[]; requirements: LicenseRequirements }): LicenseOutcome[] {
  const rs = ruleSet<{ freshness_days: number; ok_statuses: LicenseStatus[] }>("nmls.licensing", inp.as_of).content;
  const ok = (s: LicenseStatus) => rs.ok_statuses.includes(s);
  const out: LicenseOutcome[] = [];
  const co = effectiveLicense(inp.checks, "company", inp.state, inp.as_of, rs.freshness_days);
  out.push({ test_code: "NMLS_LICENSE_COMPANY", result: ok(co.status) ? "pass" : "fail", effective_status: co.status, check_id: co.check?.check_id ?? null, stale: co.stale, escalate_to: ok(co.status) ? null : "officer", message: ok(co.status) ? `partner ${inp.state} license ${co.check!.license_type} ${co.status} (checked ${co.check!.checked_at})` : `partner ${inp.state} license status ${co.status}${co.stale ? " (check older than 30 days → not_found)" : ""}` });
  if (inp.requirements.branch_licensed_state) { const br = effectiveLicense(inp.checks, "branch", inp.state, inp.as_of, rs.freshness_days); out.push({ test_code: "NMLS_LICENSE_BRANCH", result: ok(br.status) ? "pass" : "fail", effective_status: br.status, check_id: br.check?.check_id ?? null, stale: br.stale, escalate_to: ok(br.status) ? null : "officer", message: `branch ${inp.state} license ${br.status}` }); }
  else out.push({ test_code: "NMLS_LICENSE_BRANCH", result: "not_applicable", effective_status: null, check_id: null, stale: false, escalate_to: null, message: `${inp.state} does not license branches` });
  const mlo = effectiveLicense(inp.checks, "individual", inp.state, inp.as_of, rs.freshness_days);
  const mloOk = ok(mlo.status) && mlo.check?.sponsorship_ok === true;
  out.push({ test_code: "NMLS_LICENSE_MLO", result: mloOk ? "pass" : "fail", effective_status: mlo.status, check_id: mlo.check?.check_id ?? null, stale: mlo.stale, escalate_to: mloOk ? null : "mlo_of_record", message: mloOk ? `mlo_of_record ${inp.state} license ${mlo.status}, sponsored by the partner` : `mlo_of_record ${inp.state} license ${mlo.status}${mlo.check && mlo.check.sponsorship_ok !== true ? "; sponsorship not active" : ""}` });
  out.push({ test_code: "LO_QUAL_1026_36F", result: mloOk && inp.requirements.mlo_fitness_attested === true ? "pass" : "fail", effective_status: mlo.status, check_id: mlo.check?.check_id ?? null, stale: mlo.stale, escalate_to: mloOk && inp.requirements.mlo_fitness_attested === true ? null : "mlo_of_record", message: inp.requirements.mlo_fitness_attested === true ? "licensed in the property state; background/fitness attestation on file (§1026.36(f)(3))" : "background/fitness attestation missing (§1026.36(f)(3)(ii))" });
  if (inp.requirements.third_party_processor_license_required) { const sm = inp.requirements.sm_processor_license ?? null; const smOk = sm !== null && ok(sm.status) && daysBetween(sm.checked_at, inp.as_of) <= rs.freshness_days; out.push({ test_code: "SM_STATE_PROCESSOR_LICENSE", result: smOk ? "pass" : "fail", effective_status: sm?.status ?? "not_found", check_id: sm?.check_id ?? null, stale: false, escalate_to: smOk ? null : "licensed_specialist", message: smOk ? `SM ${inp.state} processor/underwriter license ${sm!.status}` : `${inp.state} requires a licensed third-party processor/underwriter (31.1) — licensed_specialist` }); }
  else out.push({ test_code: "SM_STATE_PROCESSOR_LICENSE", result: "not_applicable", effective_status: null, check_id: null, stale: false, escalate_to: null, message: `${inp.state} does not require a third-party processor license` });
  return out;
}
/** A new `license_checks` row: appends `compliance.license.check_completed{checked_at}` (arms / re-arms SM_O61_LICENSE_CHECK_REFRESH_30). */
export function recordLicenseCheck(events: EventStore, ctx: { application_id: string; loan_id?: string | null }, check: LicenseCheck, actor: Actor = AGENT): { event: DomainEvent; refresh_due: PlainDate } {
  nonEmpty(check.check_id, "check_id"); nonEmpty(check.nmls_id, "nmls_id"); nonEmpty(check.state, "state");
  const event = events.append({ type: "compliance.license.check_completed", applicationId: ctx.application_id, ...(ctx.loan_id ? { loanId: ctx.loan_id } : {}), actor,
    payload: { application_id: ctx.application_id, check_id: check.check_id, party_type: check.party_type, party_ref: check.party_ref, nmls_id: check.nmls_id, state: check.state, status: check.status, sponsorship_ok: check.sponsorship_ok, checked_at: check.checked_at, valid_through: check.valid_through, source: check.source } });
  return { event, refresh_due: addDays(check.checked_at, 30) };
}
/** A weekly FFIEC APOR table ingested (idempotent by table date): appends `apor.table.ingested{table_date}` — 23.4's `FFIEC_APOR_TABLE_REFRESH_WEEKLY` and 25.1's `SM_O61_APOR_REFRESH_7` re-arm from it. */
export function ingestAporTable(events: EventStore, tables: readonly AporTable[], actor: Actor = { kind: "external", id: "ffiec" }): { event: DomainEvent; table_date: PlainDate; next_due: PlainDate } {
  if (!tables.length) throw new RangeError("ingestAporTable needs at least one table row");
  const table_date = tables[0]!.table_date;
  if (tables.some((t) => t.table_date !== table_date)) throw new RangeError("one ingestion = one table date");
  const event = events.append({ type: "apor.table.ingested", actor, payload: { source: "origination", table_date, products: tables.map((t) => `${t.product}/${t.term_years}y`), rows: tables.length } });
  return { event, table_date, next_due: addDays(table_date, 7) };
}
/** The annual threshold load (SM_O61_RULESET_ANNUAL_0101): appends `rule_set.version.loaded{bundle, version}` for each new year row; the Jan 1 tick arms the clock and the loads satisfy it. */
export function loadRuleSetVersion(events: EventStore, row: RuleSetVersion, actor: Actor = { kind: "human", id: "compliance", role: "compliance" }): DomainEvent {
  nonEmpty(row.bundle, "bundle"); nonEmpty(row.version, "version");
  return events.append({ type: "rule_set.version.loaded", actor, payload: { source: "origination", bundle: row.bundle, version: row.version, effective_from: row.effective_from, effective_to: row.effective_to } });
}
export function annualRuleSetTick(events: EventStore, date: PlainDate, actor: Actor = { kind: "system", id: "scheduler" }): DomainEvent {
  return events.append({ type: "schedule.tick", actor, payload: { source: "origination", cadence: "annual", job: "ruleset_annual_thresholds", date } });
}

// ============================================================ LO compensation, steering, pricing exceptions (§1026.36(d)/(e); fair lending)
export interface CompPlanComponent { readonly kind: string; readonly keyed_to?: readonly string[]; readonly pct_of_total?: string | null; }
export interface LoCompOutcome { readonly result: "pass" | "fail"; readonly offending: readonly string[]; readonly message: string; }
export function loCompTest(plan: { components: readonly CompPlanComponent[]; passthrough_by_published_formula?: boolean } | null, as_of: PlainDate): LoCompOutcome {
  const rs = ruleSet<{ allowed_components: string[]; nondeferred_profit_max_pct: string; term_proxies: string[] }>("regz.locomp.1026_36", as_of).content;
  if (!plan) return { result: "fail", offending: ["plan_missing"], message: "no LO compensation plan on file for the mlo_of_record" };
  const offending: string[] = [];
  for (const comp of plan.components) {
    if (!rs.allowed_components.includes(comp.kind)) offending.push(`${comp.kind}: not an allowed component`);
    const proxies = (comp.keyed_to ?? []).filter((k) => rs.term_proxies.includes(k));
    if (proxies.length) offending.push(`${comp.kind}: keyed to ${proxies.join("/")} (a term of the transaction or its proxy)`);
    if (comp.kind === "nondeferred_profit" && comp.pct_of_total && Decimal.parse(comp.pct_of_total).cmp(Decimal.parse(rs.nondeferred_profit_max_pct)) > 0) offending.push(`nondeferred_profit ${comp.pct_of_total}% > ${rs.nondeferred_profit_max_pct}%`);
  }
  if (plan.passthrough_by_published_formula === false) offending.push("borrower_rate_passthrough not computed by the published formula");
  return { result: offending.length ? "fail" : "pass", offending, message: offending.length ? offending.join("; ") : "components ∈ {salary, flat_per_loan, fixed_pct_of_amount}; no term-based factor (§1026.36(d)(1))" };
}
export interface LoanOptionsPresented { readonly presented_at: string; readonly transaction_type: string; readonly options: readonly { kind: "lowest_rate" | "lowest_rate_no_risky_features" | "lowest_points_fees"; rate_pct: string; points_fees_cents: Cents }[]; readonly consumer_choice: string; readonly reason_if_not_lowest_rate?: string | null; }
export interface SteeringOutcome { readonly result: "pass" | "fail"; readonly missing: readonly string[]; readonly message: string; }
/** STEERING_1026_36E_OPTIONS: the three (e)(2) options were presented and logged before the lock, with the consumer's choice (and the reason when it is not the lowest-rate option). */
export function steeringOptionsTest(record: LoanOptionsPresented | null, lock_requested_at: string): SteeringOutcome {
  if (!record) return { result: "fail", missing: ["loan_options_presented"], message: "no loan_options_presented record before the lock request — §1026.36(e)(2) safe harbor not documented; lock refused" };
  const kinds = new Set(record.options.map((o) => o.kind));
  const missing = (["lowest_rate", "lowest_rate_no_risky_features", "lowest_points_fees"] as const).filter((k) => !kinds.has(k));
  if (record.presented_at > lock_requested_at) missing.push("presented_before_lock" as never);
  if (!record.consumer_choice) missing.push("consumer_choice" as never);
  const lowest = [...record.options].sort((a, b) => Decimal.parse(a.rate_pct).cmp(Decimal.parse(b.rate_pct)))[0];
  if (lowest && record.consumer_choice !== lowest.kind && !record.reason_if_not_lowest_rate) missing.push("reason_if_not_lowest_rate" as never);
  return { result: missing.length ? "fail" : "pass", missing, message: missing.length ? `steering record incomplete: ${missing.join(", ")}` : "three §1026.36(e)(2) options presented before lock; consumer choice recorded" };
}
export type PricingReasonCode = "tolerance_cure" | "corrective_action" | "program_rule" | "rate_passthrough_recompute" | "lock_policy" | "documented_error_correction";
export const PRICING_REASON_CODES: readonly PricingReasonCode[] = ["tolerance_cure", "corrective_action", "program_rule", "rate_passthrough_recompute", "lock_policy", "documented_error_correction"];
export interface PricingExceptionReview { readonly review_id: string; readonly application_id: string; readonly deviation_ref: string; readonly deviation_bps: number; readonly reason_code: PricingReasonCode; readonly discretionary: false; readonly reviewed_by: string; readonly result: "approved" | "rejected"; readonly created_at: string; }
export interface PricingExceptionOutcome { readonly result: "pass" | "fail"; readonly deviation_bps: number; readonly review_id: string | null; readonly message: string; }
/** deviation_bps = quoted/locked price − rate_sheet price; any non-zero deviation needs a `pricing_exception_reviews` row with `discretionary=false` and a reason code. */
export function pricingExceptionTest(inp: { locked_price: string; rate_sheet_price: string; review: PricingExceptionReview | null }): PricingExceptionOutcome {
  const deviation_bps = Number(Decimal.parse(inp.locked_price).sub(Decimal.parse(inp.rate_sheet_price)).mul(HUNDRED).toFixed(2));
  if (deviation_bps === 0) return { result: "pass", deviation_bps, review_id: null, message: "no deviation from the rate sheet" };
  const r = inp.review;
  if (!r || r.discretionary !== false || !PRICING_REASON_CODES.includes(r.reason_code) || r.result !== "approved") return { result: "fail", deviation_bps, review_id: r?.review_id ?? null, message: `deviation ${deviation_bps} bps from the rate sheet has no approved non-discretionary pricing_exception_reviews row with a reason code` };
  return { result: "pass", deviation_bps, review_id: r.review_id, message: `deviation ${deviation_bps} bps reviewed: ${r.reason_code}, discretionary=false` };
}
/** Writes the review (schema: `discretionary` must be false; a reason code is required) and appends `compliance.pricing_exception.reviewed`. */
export function reviewPricingException(events: EventStore, inp: { application_id: string; review_id: string; deviation_ref: string; locked_price: string; rate_sheet_price: string; reason_code: string; discretionary: boolean; reviewed_by: string; now: string }, actor: Actor = AGENT): { review: PricingExceptionReview; event: DomainEvent } {
  nonEmpty(inp.application_id, "application_id"); nonEmpty(inp.review_id, "review_id"); nonEmpty(inp.deviation_ref, "deviation_ref");
  if (inp.discretionary !== false) throw new RangeError("pricing_exception_reviews.discretionary must be false (CHECK constraint) — discretionary pricing is not a value the agent can write");
  if (!PRICING_REASON_CODES.includes(inp.reason_code as PricingReasonCode)) throw new RangeError(`reason_code ${JSON.stringify(inp.reason_code)} is not one of ${PRICING_REASON_CODES.join("/")} — a deviation without a reason code cannot be marked non-discretionary`);
  const deviation_bps = Number(Decimal.parse(inp.locked_price).sub(Decimal.parse(inp.rate_sheet_price)).mul(HUNDRED).toFixed(2));
  const review: PricingExceptionReview = { review_id: inp.review_id, application_id: inp.application_id, deviation_ref: inp.deviation_ref, deviation_bps, reason_code: inp.reason_code as PricingReasonCode, discretionary: false, reviewed_by: inp.reviewed_by, result: "approved", created_at: inp.now };
  const event = events.append({ type: "compliance.pricing_exception.reviewed", applicationId: inp.application_id, actor, payload: { application_id: inp.application_id, review_id: review.review_id, deviation_ref: review.deviation_ref, deviation_bps, reason_code: review.reason_code, discretionary: false, result: "approved" } });
  return { review, event };
}

// ============================================================ RESPA §8, E-SIGN, TCPA, NMLSR ID, template checks
export interface AfbaDisclosure { readonly kind: "afba"; readonly delivered_at: string; readonly provider: string; readonly required_use: boolean; readonly provider_kind?: "attorney" | "credit_reporting_agency" | "appraiser" | "title" | "other"; }
export interface Respa8Input { readonly as_of: PlainDate; readonly fee_items: readonly FeeItemInput[]; readonly affiliates: readonly string[]; readonly referral_at: string; readonly afba_disclosures: readonly AfbaDisclosure[]; readonly service_evidence: readonly { paid_to: string; service_performed_at: string; report_id: string }[]; readonly msa_providers?: readonly { provider: string; fmv_support_document_id: string | null }[]; }
export interface Respa8Outcome { readonly test_code: "RESPA_8_AFBA_DISCLOSURE" | "RESPA_8_UNEARNED_FEES" | "RESPA_8_MSA_INVENTORY"; readonly result: TestResult; readonly message: string; readonly affiliate_fee_items?: readonly { fee_item_id: string; tolerance_class: "zero" }[]; readonly unsupported?: readonly string[]; }
export function checkRespa8(inp: Respa8Input): Respa8Outcome[] {
  const rs = ruleSet<{ afba_required_use_exceptions: string[] }>("respa.section8", inp.as_of).content;
  const out: Respa8Outcome[] = [];
  const affiliateItems = inp.fee_items.filter((f) => inp.affiliates.includes(f.paid_to) || f.paid_to_kind === "affiliate");
  if (!affiliateItems.length) out.push({ test_code: "RESPA_8_AFBA_DISCLOSURE", result: "not_applicable", message: "no fee paid to an affiliate of the partner", affiliate_fee_items: [] });
  else {
    const bad: string[] = [];
    for (const it of affiliateItems) {
      const d = inp.afba_disclosures.find((x) => x.kind === "afba" && x.provider === it.paid_to);
      if (!d) bad.push(`${it.paid_to}: no disclosures{kind=afba} row`);
      else if (d.delivered_at > inp.referral_at) bad.push(`${it.paid_to}: AfBA delivered ${d.delivered_at} after the referral ${inp.referral_at} (§1024.15(b)(1)) — not curable retroactively; escalate to officer`);
      else if (d.required_use && !rs.afba_required_use_exceptions.includes(d.provider_kind ?? "other")) bad.push(`${it.paid_to}: required use of an affiliate (§1024.15(b)(2))`);
    }
    // an affiliate's charge cannot be shopped for: zero tolerance (21.5 rule; §1026.19(e)(3)(i))
    const affiliate_fee_items = affiliateItems.map((it) => ({ fee_item_id: it.fee_item_id, tolerance_class: "zero" as const }));
    out.push({ test_code: "RESPA_8_AFBA_DISCLOSURE", result: bad.length ? "fail" : "pass", message: bad.length ? bad.join("; ") : `AfBA disclosure delivered at or before referral for ${affiliateItems.map((i) => i.paid_to).join(", ")}; fee tolerance class zero`, affiliate_fee_items });
  }
  const unsupported = inp.fee_items.filter((f) => f.paid_to_kind !== "public_official" && f.paid_to_kind !== "creditor" && f.service_code !== "interest_prepaid" && f.service_code !== "escrow_deposit" && f.service_code !== "property_taxes" && f.service_code !== "hazard_premium" && f.service_code !== "discount_points" && f.service_code !== "sm_flat_fee" && !inp.service_evidence.some((e) => e.paid_to === f.paid_to)).map((f) => `${f.paid_to} (${f.service_code})`);
  out.push({ test_code: "RESPA_8_UNEARNED_FEES", result: unsupported.length ? "fail" : "pass", message: unsupported.length ? `no service_performed evidence for ${unsupported.join(", ")} (§1024.14(b)–(c))` : "every third-party payee maps to a service actually performed", unsupported });
  const msa = inp.msa_providers ?? [];
  const noFmv = msa.filter((m) => !m.fmv_support_document_id).map((m) => m.provider);
  out.push({ test_code: "RESPA_8_MSA_INVENTORY", result: !msa.length ? "not_applicable" : noFmv.length ? "warn" : "pass", message: !msa.length ? "no MSA provider on the file" : noFmv.length ? `MSA provider(s) without fair-market-value support: ${noFmv.join(", ")}` : "FMV support on file for every MSA provider" });
  return out;
}
export interface EsignConsent { readonly kind: "esign"; readonly granted_at: string; readonly withdrawn_at: string | null; readonly scope: readonly string[]; readonly hw_sw_statement_version: string; readonly access_demonstrated: boolean; }
export interface EsignOutcome { readonly result: TestResult; readonly reasons: readonly string[]; readonly blocked_channels: readonly ("electronic")[]; readonly instruction: { agent: "disclosure"; channel: "paper"; mailbox_rule: true } | null; readonly message: string; }
/** ESIGN_7001C_CONSENT: consent granted before delivery, not withdrawn, scoped to the disclosure class, current hardware/software statement, access demonstrated. Paper delivery → not_applicable. */
export function esignConsentTest(inp: { consent: EsignConsent | null; delivery_channel: "electronic" | "paper" | "in_person"; delivery_at: string; disclosure_class: string; as_of: PlainDate }): EsignOutcome {
  if (inp.delivery_channel !== "electronic") return { result: "not_applicable", reasons: [], blocked_channels: [], instruction: null, message: `${inp.delivery_channel} delivery needs no E-SIGN consent` };
  const rs = ruleSet<{ current_hw_sw_statement_version: string }>("esign.7001c", inp.as_of).content;
  const c0 = inp.consent, reasons: string[] = [];
  if (!c0) reasons.push("no consents{kind=esign} row");
  else {
    if (c0.granted_at >= inp.delivery_at) reasons.push("consent not granted before the delivery time");
    if (c0.withdrawn_at !== null && c0.withdrawn_at <= inp.delivery_at) reasons.push(`consent withdrawn ${c0.withdrawn_at.slice(0, 10)} (7001(c)(1)(A))`);
    if (!c0.scope.includes(inp.disclosure_class)) reasons.push(`scope does not cover ${inp.disclosure_class}`);
    if (c0.hw_sw_statement_version !== rs.current_hw_sw_statement_version) reasons.push("hardware/software statement not current (7001(c)(1)(C))");
    if (!c0.access_demonstrated) reasons.push("access not demonstrated (7001(c)(1)(C)(ii))");
  }
  return reasons.length ? { result: "fail", reasons, blocked_channels: ["electronic"], instruction: { agent: "disclosure", channel: "paper", mailbox_rule: true }, message: `ESIGN_7001C_CONSENT = fail: ${reasons.join("; ")} — deliver on paper with the mailbox rule (25.2)` } : { result: "pass", reasons: [], blocked_channels: [], instruction: null, message: "valid E-SIGN consent for electronic delivery" };
}
export interface TcpaConsent { readonly kind: "tcpa_express" | "tcpa_express_written"; readonly number: string; readonly purposes: readonly string[]; readonly granted_at: string; readonly revoked_at: string | null; }
export interface TcpaOutcome { readonly result: "pass" | "fail"; readonly reasons: readonly string[]; readonly message: string; }
export function tcpaConsentTest(inp: { consents: readonly TcpaConsent[]; number: string; purpose: string; marketing: boolean; dnc_scrubbed_at: PlainDate | null; as_of: PlainDate; at: string }): TcpaOutcome {
  const rs = ruleSet<{ dnc_scrub_max_days: number }>("tcpa.64_1200", inp.as_of).content;
  const reasons: string[] = [];
  const cs = inp.consents.filter((k) => k.number === inp.number && k.purposes.includes(inp.purpose) && k.granted_at <= inp.at);
  const live = cs.filter((k) => k.revoked_at === null || k.revoked_at > inp.at);
  if (!live.length) reasons.push(cs.length ? "consent revoked (honored immediately; 47 CFR 64.1200(a)(10))" : "no prior express consent for this number and purpose (FCC 24-17: AI voice is artificial/prerecorded)");
  if (inp.marketing && !live.some((k) => k.kind === "tcpa_express_written")) reasons.push("marketing call needs prior express written consent");
  if (!inp.dnc_scrubbed_at || daysBetween(inp.dnc_scrubbed_at, inp.as_of) > rs.dnc_scrub_max_days) reasons.push(`DNC scrub older than ${rs.dnc_scrub_max_days} days or missing`);
  return { result: reasons.length ? "fail" : "pass", reasons, message: reasons.length ? reasons.join("; ") : "prior express consent on file, no revocation, DNC scrub current; automation disclosed at call start" };
}
export interface NmlsrTemplate { readonly form: "1003" | "le" | "cd" | "note" | "security_instrument"; readonly creditor_name: string | null; readonly creditor_nmlsr_id: string | null; readonly mlo_name: string | null; readonly mlo_nmlsr_id: string | null; }
export function nmlsrIdTest(templates: readonly NmlsrTemplate[], checkpoint: Checkpoint): { result: "pass" | "fail"; missing: readonly string[]; message: string } {
  const required: NmlsrTemplate["form"][] = checkpoint === "le" ? ["1003", "le"] : checkpoint === "consummation" ? ["note", "security_instrument", "cd"] : ["1003", "le", "cd"];
  const missing: string[] = [];
  for (const f of required) { const t = templates.find((x) => x.form === f); if (!t) { missing.push(`${f}: template not on file`); continue; } for (const k of ["creditor_name", "creditor_nmlsr_id", "mlo_name", "mlo_nmlsr_id"] as const) if (!t[k]) missing.push(`${f}: ${k}`); }
  return { result: missing.length ? "fail" : "pass", missing, message: missing.length ? `§1026.36(g): ${missing.join(", ")}` : "partner name/NMLSR ID and mlo_of_record name/NMLSR ID present on every required document" };
}

// ============================================================ runs, gates, waivers, escalation
export type GateCode = "SM_O61_COMPLIANCE_PASS_LE_GATE" | "SM_O61_COMPLIANCE_PASS_LOCK_GATE" | "SM_O61_COMPLIANCE_PASS_CD_GATE" | "SM_O61_COMPLIANCE_PASS_CONSUMMATE_GATE" | "SM_O61_COMPLIANCE_PASS_DISBURSE_GATE" | "SM_O61_COMPLIANCE_PASS_DELIVERY_GATE";
export type GateName = "le" | "lock" | "cd" | "consummation" | "disbursement" | "delivery";
export const GATES: Record<GateCode, { gate: GateName; checkpoint: Checkpoint; command: string; freshness_hours: number; breach_severity: "sev1" | "sev2" | null }> = {
  SM_O61_COMPLIANCE_PASS_LE_GATE: { gate: "le", checkpoint: "le", command: "issueLE", freshness_hours: 24, breach_severity: null },
  SM_O61_COMPLIANCE_PASS_LOCK_GATE: { gate: "lock", checkpoint: "lock", command: "lock", freshness_hours: 24, breach_severity: null },
  SM_O61_COMPLIANCE_PASS_CD_GATE: { gate: "cd", checkpoint: "cd", command: "issueCD", freshness_hours: 4, breach_severity: "sev1" },
  SM_O61_COMPLIANCE_PASS_CONSUMMATE_GATE: { gate: "consummation", checkpoint: "consummation", command: "consummate", freshness_hours: 4, breach_severity: null },
  SM_O61_COMPLIANCE_PASS_DISBURSE_GATE: { gate: "disbursement", checkpoint: "disbursement", command: "disburse", freshness_hours: 4, breach_severity: null },
  SM_O61_COMPLIANCE_PASS_DELIVERY_GATE: { gate: "delivery", checkpoint: "delivery", command: "submitDelivery", freshness_hours: 4, breach_severity: "sev1" },
};
export function gateCode(code: string): GateCode { if (!(code in GATES)) throw new RangeError(`${code} is not a 25.1 compliance gate (${Object.keys(GATES).join(", ")})`); return code as GateCode; }
/** Which checkpoint a platform event (re)runs: the gate triggers of the timer table and the run-invalidating events of the spec. The LE clock `REGZ_1026_19E1_LE_3BD` (21.2) keeps running while the LE gate is blocked. */
export const CHECKPOINT_TRIGGERS: Record<string, readonly Checkpoint[]> = {
  "application.trid_received": ["le"], "lock.requested": ["lock"], "changed_circumstance.recorded": ["revised_le"], "disclosure.cd.requested": ["cd"], "closing.scheduled": ["consummation"], "funding.authorized": ["disbursement"], "delivery.uldd.built": ["delivery"], "qc.review.opened": ["post_closing_qc"],
  "fee_items.changed": ["le", "lock", "revised_le", "cd", "consummation"], "locks.changed": ["lock", "cd", "consummation"], "du.findings.received": ["cd"], "application_borrowers.changed": ["le", "cd"], "application_properties.changed": ["le", "cd"], "mi.certificate.issued": ["cd"], "valuation.received": ["cd"],
  "disclosure.le.delivered": [], "disclosure.cd.delivered": ["consummation"], "fundings.disbursement_date.changed": ["consummation", "disbursement"], "apor.table.ingested": ["cd", "consummation", "delivery"], "rule_set.version.loaded": ["cd", "consummation", "delivery"], "compliance.license.check_completed": ["le", "cd"],
};
export function checkpointsForEvent(type: string): readonly Checkpoint[] { return CHECKPOINT_TRIGGERS[type] ?? []; }

export interface ComplianceTestRow { readonly test_code: string; readonly rule_set_version: string; readonly jurisdiction: string; readonly result: TestResult; readonly blocking: boolean; readonly measured_value: number | string | null; readonly threshold_value: number | string | null; readonly unit: string | null; readonly message: string; readonly evidence: Record<string, unknown>; readonly waiver_id: string | null; readonly waivable: boolean; readonly escalate_to?: string | null; }
export interface ComplianceWaiver { readonly waiver_id: string; readonly test_id: string; readonly test_code: string; readonly kind: "policy_only"; readonly approved_by: string; readonly rationale: string; readonly expires_at: string | null; }
export interface ComplianceSnapshot {
  readonly application_id: string; readonly loan_id?: string | null; readonly as_of: PlainDate; readonly property_state: string; readonly property_county?: string | null; readonly lien_position: "first" | "subordinate"; readonly occupancy?: "primary" | "second_home" | "investment";
  readonly loan_amount_cents: Cents; readonly note_rate_pct: string; readonly term_months: number; readonly rate_set_date: PlainDate;
  readonly apr?: { readonly actual: AprCalculation; readonly disclosed_apr: number | string | null; readonly disclosed_finance_charge_cents: Cents | null; readonly transaction: TransactionShape; readonly apr_from_disclosed_finance_charge?: number | string | null };
  readonly fees?: { readonly items: readonly FeeItemInput[]; readonly benchmarks?: readonly FeeBenchmark[]; readonly undiscounted_rate_pct?: string | null; readonly fnma_required_net_yield_pct?: string | null; readonly financed_pf_items_cents?: Cents; readonly lo_compensation_cents?: Cents };
  readonly apor_tables?: readonly AporTable[]; readonly treasury_yield_pct?: string | null; readonly prepayment_penalty?: { months: number; max_pct: string } | null; readonly escrow_established?: boolean;
  readonly jurisdiction?: { readonly high_cost_statute?: string | null; readonly branch_licensed_state?: boolean; readonly third_party_processor_license_required?: boolean; readonly ai_disclosure_required?: boolean };
  readonly tolerance?: { readonly result: TestResult; readonly message?: string; readonly tolerance_test_id?: string | null };
  readonly licenses?: { readonly checks: readonly LicenseCheck[]; readonly mlo_fitness_attested?: boolean; readonly sm_processor_license?: LicenseCheck | null };
  readonly lo_comp_plan?: { components: readonly CompPlanComponent[]; passthrough_by_published_formula?: boolean } | null;
  readonly steering?: { readonly record: LoanOptionsPresented | null; readonly lock_requested_at: string };
  readonly pricing?: { readonly locked_price: string; readonly rate_sheet_price: string; readonly review: PricingExceptionReview | null };
  readonly respa8?: Omit<Respa8Input, "as_of" | "fee_items">;
  readonly esign?: { readonly consent: EsignConsent | null; readonly delivery_channel: "electronic" | "paper" | "in_person"; readonly delivery_at: string; readonly disclosure_class: string };
  readonly nmlsr_templates?: readonly NmlsrTemplate[]; readonly arbitration_clause_present?: boolean; readonly credit_insurance_financed?: boolean; readonly ai_disclosure_present?: boolean;
}
export interface ComplianceRun { readonly run_id: string; readonly application_id: string; readonly loan_id: string | null; readonly checkpoint: Checkpoint; readonly started_at: string; readonly completed_at: string; readonly rule_set_versions: Record<string, string>; readonly inputs_hash: string; readonly overall_result: "pass" | "pass_with_warnings" | "fail" | "error"; readonly blocking_failures: number; readonly status: "passed" | "passed_with_warnings" | "failed" | "errored" | "superseded"; readonly tests: readonly ComplianceTestRow[]; readonly points_and_fees?: { exclusive_cents: Cents; inclusive_cents: Cents; total_loan_amount_cents: Cents } | null; }
/** SHA-256 of the canonical (sorted-key, bigint-as-string) snapshot — re-running a snapshot must yield identical results. */
export function inputsHash(snapshot: unknown): string {
  const canon = (v: unknown): unknown => typeof v === "bigint" ? `${v.toString()}n` : Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;
  return sha256(JSON.stringify(canon(snapshot)));
}
const row = (d: TestDefinition, version: string, jurisdiction: string, result: TestResult, message: string, extra: Partial<ComplianceTestRow> = {}): ComplianceTestRow => ({ test_code: d.test_code, rule_set_version: version, jurisdiction, result, blocking: d.blocking_default, measured_value: null, threshold_value: null, unit: null, message, evidence: {}, waiver_id: null, waivable: d.waivable, ...extra });
const missing = (d: TestDefinition, what: string): ComplianceTestRow => row(d, "n/a", "US", "error", `${d.test_code}: input missing — ${what}`);

/** Every applicable test at the checkpoint, deterministically, over the snapshot. A missing input is an `error` (blocks like a failure); a test outside its checkpoints or jurisdiction is not run. */
export function runTestSuite(checkpoint: Checkpoint, s: ComplianceSnapshot, opts: { run_id?: string; started_at: string; completed_at?: string; waivers?: readonly ComplianceWaiver[] } ): ComplianceRun {
  if (!CHECKPOINTS.includes(checkpoint)) throw new RangeError(`checkpoint ${String(checkpoint)} is not one of ${CHECKPOINTS.join("/")}`);
  nonEmpty(s.application_id, "application_id"); nonEmpty(s.property_state, "property_state");
  const versions = ruleSetVersions(s.as_of);
  const st = s.property_state.toUpperCase();
  const tests: ComplianceTestRow[] = [];
  const at = (code: string) => testDefinition(code).checkpoints.includes(checkpoint);
  const V = (bundle: string) => versions[bundle] ?? "n/a";
  // finance-charge classification and points and fees (feed APR/QM/HOEPA/state tests)
  let cls: FcClassificationRow[] | null = null, pf: PointsAndFees | null = null, pfState: PointsAndFees | null = null, tla: Cents | null = null;
  if (s.fees) {
    cls = classifyFinanceCharges(s.fees.items, { as_of: s.as_of, state: st, county: s.fees && s.property_county ? s.property_county : null, benchmarks: s.fees.benchmarks ?? [] });
    const apor = s.apor_tables ? aporAsOf(s.apor_tables, s.rate_set_date) : null;
    const pfIn: PointsAndFeesInput = { items: s.fees.items, classifications: cls, note_rate_pct: s.note_rate_pct, undiscounted_rate_pct: s.fees.undiscounted_rate_pct ?? null, apor_pct: apor?.apor_pct ?? null, fnma_required_net_yield_pct: s.fees.fnma_required_net_yield_pct ?? null, lo_compensation_cents: s.fees.lo_compensation_cents ?? 0n };
    pf = pointsAndFees(pfIn, "federal_1026_32");
    const stateRule = (() => { try { return ruleSet<StateHighCostRuleSet>(`state.high_cost.${st}`, s.as_of).content.counting_rule; } catch { return null; } })();
    pfState = stateRule ? pointsAndFees(pfIn, stateRule) : pf;
    tla = totalLoanAmount(s.loan_amount_cents - prepaidFinanceCharges(cls), s.fees.financed_pf_items_cents ?? 0n);
  }
  if (at("FC_1026_4_CLASSIFICATION")) { const d = testDefinition("FC_1026_4_CLASSIFICATION"); tests.push(cls ? row(d, V(d.rule_set_code), "US", "pass", `${cls.length} fee items classified with §1026.4 citations${cls.some((r) => r.reasonable === false) ? "; a (c)(7) fee outside the benchmark band is reclassified finance_charge and the APR recomputed" : ""}`, { evidence: { classifications: cls.map((r) => ({ fee_item_id: r.fee_item_id, classification: r.classification, basis: r.basis_citation })), prepaid_finance_charges_cents: prepaidFinanceCharges(cls) } }) : missing(d, "fee_items")); }
  // FEE_REASONABLENESS: W → B when a (c)(7) exclusion depended on it — a (c)(7) fee outside the band fails (blocking) but the test is policy (waivable by officer)
  if (at("FEE_REASONABLENESS")) { const d = testDefinition("FEE_REASONABLENESS"); if (s.fees) { const fr = feeReasonablenessTest(s.fees.items, { state: st, county: s.property_county ?? null, benchmarks: s.fees.benchmarks ?? [] }); tests.push(row(d, V(d.rule_set_code), st, fr.result === "warn" ? "fail" : "pass", fr.result === "warn" ? `fee(s) outside the fee_benchmarks band: ${fr.outside_band.map((o) => o.service_code).join(", ")} — (c)(7) exclusion withdrawn (W → B), officer warned` : "every (c)(7) fee within the benchmark band", { evidence: { outside_band: fr.outside_band }, blocking: fr.outside_band.length > 0, escalate_to: fr.outside_band.length ? "officer" : null })); } else tests.push(missing(d, "fee_items")); }
  if (at("APR_1026_22_ACCURACY")) { const d = testDefinition("APR_1026_22_ACCURACY"); if (!s.apr) tests.push(missing(d, "apr_calculations for the checkpoint")); else if (s.apr.disclosed_apr === null || s.apr.disclosed_finance_charge_cents === null) tests.push(row(d, V(d.rule_set_code), "US", "error", "no delivered CD figures to compare")); else { const a = aprAccuracyTest({ disclosed_apr: s.apr.disclosed_apr, actual_apr: s.apr.actual.apr_disclosed_str, transaction: s.apr.transaction, disclosed_finance_charge_cents: s.apr.disclosed_finance_charge_cents, actual_finance_charge_cents: s.apr.actual.finance_charge_cents, apr_from_disclosed_finance_charge: s.apr.apr_from_disclosed_finance_charge ?? aprFromDisclosedFinanceCharge(s.apr.actual, s.apr.disclosed_finance_charge_cents)?.apr_disclosed_str ?? null, as_of: s.as_of }); tests.push(row(d, V(d.rule_set_code), "US", a.result, a.message, { measured_value: a.apr_variance, threshold_value: a.tolerance_pct, unit: "percentage_points", evidence: { tolerance_applied: a.tolerance_applied, accuracy_basis: a.accuracy_basis, cure_plan: a.cure_plan, actual_apr: s.apr.actual.apr, method: s.apr.actual.method } })); } }
  if (at("FC_1026_38O2_ACCURACY")) { const d = testDefinition("FC_1026_38O2_ACCURACY"); if (!s.apr || s.apr.disclosed_finance_charge_cents === null) tests.push(missing(d, "disclosed finance charge")); else { const f = financeChargeAccuracyTest(s.apr.disclosed_finance_charge_cents, s.apr.actual.finance_charge_cents, s.as_of); tests.push(row(d, V(d.rule_set_code), "US", f.result, `finance charge ${f.basis} (understated by ${f.understated_by_cents} cents)`, { measured_value: f.understated_by_cents.toString(), threshold_value: "10000", unit: "cents", evidence: { basis: f.basis } })); } }
  if (at("TRID_19E3_TOLERANCE")) { const d = testDefinition("TRID_19E3_TOLERANCE"); tests.push(s.tolerance ? row(d, V(d.rule_set_code), "US", s.tolerance.result, s.tolerance.message ?? `21.5 runToleranceTest → ${s.tolerance.result}`, { evidence: { tolerance_test_id: s.tolerance.tolerance_test_id ?? null, delegated_to: "21.5" } }) : missing(d, "21.5 runToleranceTest result")); }
  const apor = s.apor_tables ? aporAsOf(s.apor_tables, s.rate_set_date) : null;
  const detIn = (): DeterminationInput | null => (s.apr && pf && tla !== null ? { apr: s.apr.actual.apr_disclosed_str, apor, rate_set_date: s.rate_set_date, as_of: s.as_of, loan_amount_cents: s.loan_amount_cents, total_loan_amount_cents: tla, points_and_fees_cents: pf.inclusive_cents, lien_position: s.lien_position, ...(s.occupancy ? { occupancy: s.occupancy } : {}), term_months: s.term_months, prepayment_penalty: s.prepayment_penalty ?? null, ...(s.escrow_established !== undefined ? { escrow_established: s.escrow_established } : {}), checkpoint } : null);
  let hoepaAprTrigger: boolean | null = null;
  if (at("QM_1026_43")) { const d = testDefinition("QM_1026_43"); const di = detIn(); if (!di) tests.push(missing(d, "APR, fee items and total loan amount")); else { const q = determineQm(di); tests.push(row(d, q.rule_set_version, "US", q.result, q.message, { measured_value: q.spread, threshold_value: q.apr_tier, unit: "percentage_points", evidence: { ...q.evidence, qm_type: q.qm_type, hpct: q.hpct, points_and_fees_inclusive_cents: pf!.inclusive_cents, points_and_fees_exclusive_cents: pf!.exclusive_cents } })); } }
  if (at("HPML_1026_35")) { const d = testDefinition("HPML_1026_35"); const di = detIn(); if (!di) tests.push(missing(d, "APR and APOR")); else { const h = determineHpml(di); tests.push(row(d, h.rule_set_version, "US", h.result, h.message, { measured_value: h.spread, threshold_value: h.threshold, unit: "percentage_points", evidence: { ...h.evidence, is_hpml: h.is_hpml, escrow_required: h.escrow_required } })); } }
  if (at("HOEPA_1026_32")) { const d = testDefinition("HOEPA_1026_32"); const di = detIn(); if (!di) tests.push(missing(d, "APR, APOR and points and fees")); else { const h = determineHoepa(di); hoepaAprTrigger = h.apr_trigger; tests.push(row(d, h.rule_set_version, "US", h.result, h.message, { measured_value: pf!.inclusive_cents.toString(), threshold_value: h.pf_threshold_cents.toString(), unit: "cents", evidence: { ...h.evidence, is_high_cost: h.is_high_cost, apr_trigger: h.apr_trigger, pf_trigger: h.pf_trigger } })); } }
  if (at("STATE_HIGH_COST")) { const statute = s.jurisdiction?.high_cost_statute ?? null; const hasRule = RULE_SETS.some((r) => r.bundle === `state.high_cost.${st}`); if (statute || hasRule) { const d = testDefinition(`STATE_HIGH_COST_${st}`); if (!s.apr || !pfState || tla === null) tests.push(missing(d, "APR, points and fees (state counting) and total loan amount")); else { const o = evaluateStateHighCost({ state: st, as_of: s.as_of, apr: s.apr.actual.apr_disclosed_str, treasury_yield_pct: s.treasury_yield_pct ?? null, hoepa_apr_trigger: hoepaAprTrigger, loan_amount_cents: s.loan_amount_cents, total_loan_amount_cents: tla, points_and_fees_state_cents: pfState.inclusive_cents, lien_position: s.lien_position, prepayment_penalty: s.prepayment_penalty ?? null, jurisdiction_high_cost_statute: statute }); tests.push(row(d, o.rule_set_version ?? "n/a", st, o.result, o.message, { measured_value: pfState.inclusive_cents.toString(), threshold_value: o.pf_threshold_cents?.toString() ?? null, unit: "cents", evidence: { statute: o.statute, counting_rule: o.counting_rule, apr_trigger: o.apr_trigger, pf_trigger: o.pf_trigger } })); } } }
  if (at("POINTS_FEES_3PCT_FNMA")) { const d = testDefinition("POINTS_FEES_3PCT_FNMA"); if (!pf || tla === null) tests.push(missing(d, "points and fees")); else { const cap = qmPointsAndFeesCap(ruleSet<QmRuleSet>("regz.qm.general.2021", s.as_of).content, tla); tests.push(row(d, V(d.rule_set_code), "US", pf.inclusive_cents <= cap.cap_cents ? "pass" : "fail", `points and fees ${pf.inclusive_cents} (incl. SM flat fee ${pf.sm_flat_fee_cents}) vs Fannie Mae cap ${cap.cap_cents} (${cap.basis}) [B2-1.5-02 UNVERIFIED — policy]`, { measured_value: pf.inclusive_cents.toString(), threshold_value: cap.cap_cents.toString(), unit: "cents" })); } }
  if (s.respa8 && s.fees) { for (const o of checkRespa8({ ...s.respa8, as_of: s.as_of, fee_items: s.fees.items })) if (at(o.test_code)) tests.push(row(testDefinition(o.test_code), V("respa.section8"), "US", o.result, o.message, { evidence: { affiliate_fee_items: o.affiliate_fee_items ?? [], unsupported: o.unsupported ?? [] } })); }
  else for (const code of ["RESPA_8_UNEARNED_FEES", "RESPA_8_AFBA_DISCLOSURE", "RESPA_8_MSA_INVENTORY"] as const) if (at(code)) tests.push(missing(testDefinition(code), "RESPA §8 inventories (affiliates, AfBA disclosures, service evidence)"));
  if (at("LOCOMP_1026_36D")) { const d = testDefinition("LOCOMP_1026_36D"); if (s.lo_comp_plan === undefined) tests.push(missing(d, "LO compensation plan")); else { const o = loCompTest(s.lo_comp_plan, s.as_of); tests.push(row(d, V(d.rule_set_code), "US", o.result, o.message, { evidence: { offending: o.offending } })); } }
  if (at("STEERING_1026_36E_OPTIONS")) { const d = testDefinition("STEERING_1026_36E_OPTIONS"); if (!s.steering) tests.push(missing(d, "loan_options_presented and the lock request time")); else { const o = steeringOptionsTest(s.steering.record, s.steering.lock_requested_at); tests.push(row(d, V(d.rule_set_code), "US", o.result, o.message, { evidence: { missing: o.missing } })); } }
  if (s.licenses) { for (const o of checkLicenses({ state: st, as_of: s.as_of, checks: s.licenses.checks, requirements: { branch_licensed_state: s.jurisdiction?.branch_licensed_state ?? false, ...(s.jurisdiction?.third_party_processor_license_required !== undefined ? { third_party_processor_license_required: s.jurisdiction.third_party_processor_license_required } : {}), sm_processor_license: s.licenses.sm_processor_license ?? null, ...(s.licenses.mlo_fitness_attested !== undefined ? { mlo_fitness_attested: s.licenses.mlo_fitness_attested } : {}) } })) if (at(o.test_code)) tests.push(row(testDefinition(o.test_code), V("nmls.licensing"), st, o.result, o.message, { measured_value: o.effective_status, evidence: { check_id: o.check_id, stale: o.stale }, escalate_to: o.escalate_to })); }
  else for (const code of ["NMLS_LICENSE_COMPANY", "NMLS_LICENSE_BRANCH", "NMLS_LICENSE_MLO", "LO_QUAL_1026_36F", "SM_STATE_PROCESSOR_LICENSE"] as const) if (at(code)) tests.push(missing(testDefinition(code), "license_checks"));
  if (at("NMLSR_ID_1026_36G")) { const d = testDefinition("NMLSR_ID_1026_36G"); if (!s.nmlsr_templates) tests.push(missing(d, "document templates")); else { const o = nmlsrIdTest(s.nmlsr_templates, checkpoint); tests.push(row(d, V(d.rule_set_code), "US", o.result, o.message, { evidence: { missing: o.missing } })); } }
  if (at("ESIGN_7001C_CONSENT")) { const d = testDefinition("ESIGN_7001C_CONSENT"); if (!s.esign) tests.push(missing(d, "consents{kind=esign} and the delivery channel")); else { const o = esignConsentTest({ ...s.esign, as_of: s.as_of }); tests.push(row(d, V(d.rule_set_code), "US", o.result, o.message, { evidence: { reasons: o.reasons, blocked_channels: o.blocked_channels, instruction: o.instruction } })); } }
  if (at("FAIR_LENDING_PRICING_EXCEPTION")) { const d = testDefinition("FAIR_LENDING_PRICING_EXCEPTION"); if (!s.pricing) tests.push(missing(d, "locked/quoted price and rate sheet price")); else { const o = pricingExceptionTest(s.pricing); tests.push(row(d, V(d.rule_set_code), "US", o.result, o.message, { measured_value: o.deviation_bps, threshold_value: 0, unit: "bps", evidence: { review_id: o.review_id } })); } }
  if (at("ARBITRATION_1026_36H")) { const d = testDefinition("ARBITRATION_1026_36H"); tests.push(s.arbitration_clause_present === undefined ? missing(d, "note/security-instrument template check") : row(d, V(d.rule_set_code), "US", s.arbitration_clause_present ? "fail" : "pass", s.arbitration_clause_present ? "mandatory arbitration clause present (§1026.36(h))" : "no mandatory arbitration clause")); }
  if (at("CREDIT_INSURANCE_1026_36I")) { const d = testDefinition("CREDIT_INSURANCE_1026_36I"); tests.push(s.credit_insurance_financed === undefined ? missing(d, "credit-insurance financing check") : row(d, V(d.rule_set_code), "US", s.credit_insurance_financed ? "fail" : "pass", s.credit_insurance_financed ? "credit-insurance premiums financed (§1026.36(i))" : "no financed credit-insurance premiums")); }
  if (at("AI_DISCLOSURE_STATE") && s.jurisdiction?.ai_disclosure_required) { const d = testDefinition("AI_DISCLOSURE_STATE"); tests.push(row(d, "31.2", st, s.ai_disclosure_present ? "pass" : "fail", s.ai_disclosure_present ? "state AI disclosure present (31.2 content)" : `${st} requires an AI disclosure (31.2) — not present`)); }
  // waivers attach only to waivable (policy) tests
  const withWaivers = tests.map((t) => { const w = (opts.waivers ?? []).find((x) => x.test_code === t.test_code); return w && t.waivable ? { ...t, waiver_id: w.waiver_id } : t; });
  const blocking_failures = withWaivers.filter((t) => isBlockingFailure(t)).length;
  const warnings = withWaivers.filter((t) => t.result === "warn" || (t.result === "fail" && !t.blocking)).length;
  const errors = withWaivers.some((t) => t.result === "error" && t.blocking);
  const overall_result: ComplianceRun["overall_result"] = blocking_failures ? (errors && withWaivers.every((t) => !isBlockingFailure(t) || t.result === "error") ? "error" : "fail") : warnings ? "pass_with_warnings" : "pass";
  const status: ComplianceRun["status"] = overall_result === "pass" ? "passed" : overall_result === "pass_with_warnings" ? "passed_with_warnings" : overall_result === "fail" ? "failed" : "errored";
  return { run_id: opts.run_id ?? `run-${checkpoint}-${sha256(opts.started_at + s.application_id).slice(0, 12)}`, application_id: s.application_id, loan_id: s.loan_id ?? null, checkpoint, started_at: opts.started_at, completed_at: opts.completed_at ?? opts.started_at, rule_set_versions: versions, inputs_hash: inputsHash({ checkpoint, snapshot: s }), overall_result, blocking_failures, status, tests: withWaivers, points_and_fees: pf && tla !== null ? { exclusive_cents: pf.exclusive_cents, inclusive_cents: pf.inclusive_cents, total_loan_amount_cents: tla } : null };
}
/** A row blocks unless it passed / warned / was not applicable, is non-blocking, or carries a waiver on a waivable (policy) test. `error` blocks like a failure. */
export const isBlockingFailure = (t: Pick<ComplianceTestRow, "result" | "blocking" | "waiver_id" | "waivable">): boolean => !(["pass", "warn", "not_applicable"].includes(t.result) || !t.blocking || (t.waiver_id !== null && t.waivable));
export interface GateDerivation { readonly open: boolean; readonly failing_tests: readonly string[]; readonly waived_tests: readonly string[]; readonly reason: string | null; }
/** gate_open(checkpoint) = ∀ t: t.result ∈ {pass, warn, not_applicable} ∨ ¬t.blocking ∨ (t.waiver_id ≠ null ∧ definition.waivable); an `error` blocks like a failure. */
export function deriveGate(tests: readonly ComplianceTestRow[], waivers: readonly ComplianceWaiver[] = []): GateDerivation {
  const applied = tests.map((t) => { const w = waivers.find((x) => x.test_code === t.test_code); return w && t.waivable ? { ...t, waiver_id: w.waiver_id } : t; });
  const failing = applied.filter(isBlockingFailure).map((t) => t.test_code);
  const waived = applied.filter((t) => t.waiver_id !== null && t.waivable && (t.result === "fail" || t.result === "warn")).map((t) => t.test_code);
  return { open: failing.length === 0, failing_tests: failing, waived_tests: waived, reason: failing.length ? `blocking: ${failing.join(", ")}` : null };
}
/** Gate state from a stored run: open iff the run is non-superseded, passed, and completed within the freshness window (24 h LE/lock; 4 h CD onward). */
export function gateFresh(run: Pick<ComplianceRun, "completed_at" | "status" | "checkpoint">, gate: GateCode, now: string): boolean {
  if (run.status === "superseded") return false;
  return Date.parse(now) - Date.parse(run.completed_at) <= GATES[gate].freshness_hours * 3_600_000;
}

export class ComplianceGateBlocked extends Error {
  readonly code = "COMPLIANCE_GATE_BLOCKED"; readonly gate: GateCode; readonly command: string; readonly result: GateEvaluation;
  constructor(gate: GateCode, result: GateEvaluation) { super(`${GATES[gate].command} refused [COMPLIANCE_GATE_BLOCKED]: ${gate} blocked — ${result.derivation.failing_tests.join(", ")}`); this.name = "ComplianceGateBlocked"; this.gate = gate; this.command = GATES[gate].command; this.result = result; }
}
export interface EscalationOpener { open(input: { kind: string; ownerRole?: string; loanId?: string; applicationId?: string; severity?: string; payload?: Record<string, unknown> }, by: Actor): { id: string }; }
export interface GateEvaluation { readonly gate: GateCode; readonly gate_name: GateName; readonly checkpoint: Checkpoint; readonly run: ComplianceRun; readonly derivation: GateDerivation; readonly open: boolean; readonly cure_plan: string | null; readonly review_due: PlainDate | null; readonly escalation_id: string | null; readonly escalate_to: string | null; readonly blocked_channels: readonly string[]; readonly instruction: Record<string, unknown> | null; readonly events: readonly DomainEvent[]; }
/** The cure the agent drafts for the blocking failures (deterministic text; the LLM only rewrites it for humans). */
export function cureLine(t: ComplianceTestRow): string {
  const c0 = t.evidence.cure_plan; if (typeof c0 === "string") return `${t.test_code}: ${c0}`;
  switch (t.test_code) {
    case "QM_1026_43": case "HPML_1026_35": return t.result === "error" ? `${t.test_code}: wait for the FFIEC APOR table (no waiver possible)` : `${t.test_code}: restructure per 23.2`;
    case "STEERING_1026_36E_OPTIONS": return "present and log the three §1026.36(e)(2) options before re-requesting the lock";
    case "FAIR_LENDING_PRICING_EXCEPTION": return "record a pricing_exception_reviews row with a reason code (discretionary=false) or reprice to the rate sheet";
    case "ESIGN_7001C_CONSENT": return "deliver on paper with the mailbox rule (disclosure agent) or obtain new E-SIGN consent";
    case "RESPA_8_AFBA_DISCLOSURE": return "escalate to officer — AfBA timing cannot be cured retroactively; re-evaluate the fee under (a)(2) and zero tolerance";
    default: return t.test_code.startsWith("NMLS_LICENSE") || t.test_code === "LO_QUAL_1026_36F" ? `${t.test_code}: refresh the NMLS record / cure the license before the LE or CD` : `${t.test_code}: ${t.message}`;
  }
}
/**
 * Runs (or re-uses) the checkpoint suite and derives the gate: appends `compliance.testrun.started{checkpoint}`,
 * `compliance.test.passed/failed`, `compliance.testrun.completed{overall_result}` and `compliance.gate.opened{gate}` or
 * `compliance.gate.blocked{gate, failing_tests, cure_plan}` (arms SM_O61_BLOCKING_FAILURE_REVIEW_1BD: +1 business_days_creditor),
 * opens the `officer` escalation (or `mlo_of_record` for an individual licensing failure) and returns the evaluation. Never throws for a blocked gate — `assertGateOpen` does.
 */
export function evaluateComplianceGate(events: EventStore, gate: GateCode, s: ComplianceSnapshot, opts: { now: string; waivers?: readonly ComplianceWaiver[]; escalations?: EscalationOpener; run_id?: string; existing_run?: ComplianceRun | null }, actor: Actor = AGENT): GateEvaluation {
  const g = GATES[gate]; const app = { applicationId: s.application_id, ...(s.loan_id ? { loanId: s.loan_id } : {}) };
  const out: DomainEvent[] = [];
  const reuse = opts.existing_run && opts.existing_run.checkpoint === g.checkpoint && gateFresh(opts.existing_run, gate, opts.now) ? opts.existing_run : null;
  let run: ComplianceRun;
  if (reuse) run = reuse;
  else {
    out.push(events.append({ type: "compliance.testrun.started", ...app, actor, payload: { application_id: s.application_id, checkpoint: g.checkpoint, gate: g.gate, started_at: opts.now } }));
    run = runTestSuite(g.checkpoint, s, { started_at: opts.now, ...(opts.run_id ? { run_id: opts.run_id } : {}), ...(opts.waivers ? { waivers: opts.waivers } : {}) });
    for (const t of run.tests) if (t.result !== "not_applicable") out.push(events.append({ type: t.result === "pass" || t.result === "warn" ? "compliance.test.passed" : "compliance.test.failed", ...app, actor, payload: { application_id: s.application_id, run_id: run.run_id, checkpoint: g.checkpoint, test_code: t.test_code, result: t.result, blocking: t.blocking, rule_set_version: t.rule_set_version, measured_value: t.measured_value, threshold_value: t.threshold_value, waiver_id: t.waiver_id } }));
    out.push(events.append({ type: "compliance.testrun.completed", ...app, actor, payload: { application_id: s.application_id, run_id: run.run_id, checkpoint: g.checkpoint, overall_result: run.overall_result, blocking_failures: run.blocking_failures, inputs_hash: run.inputs_hash, rule_set_versions: run.rule_set_versions } }));
  }
  const derivation = deriveGate(run.tests, opts.waivers ?? []);
  const failing = run.tests.filter(isBlockingFailure);
  const esign = run.tests.find((t) => t.test_code === "ESIGN_7001C_CONSENT" && t.result === "fail");
  const blocked_channels = (esign?.evidence.blocked_channels as string[] | undefined) ?? [];
  const instruction = (esign?.evidence.instruction as Record<string, unknown> | undefined) ?? null;
  if (derivation.open) {
    out.push(events.append({ type: "compliance.gate.opened", ...app, actor, payload: { application_id: s.application_id, gate: g.gate, gate_code: gate, run_id: run.run_id, checkpoint: g.checkpoint, waived_tests: derivation.waived_tests, overall_result: run.overall_result } }));
    return { gate, gate_name: g.gate, checkpoint: g.checkpoint, run, derivation, open: true, cure_plan: null, review_due: null, escalation_id: null, escalate_to: null, blocked_channels, instruction, events: out };
  }
  const cure_plan = failing.map(cureLine).join("; ");
  const eventDate = opts.now.slice(0, 10) as PlainDate;
  const review_due = addBusinessDays(eventDate, 1, creditor);
  const escalate_to = failing.some((t) => t.escalate_to === "mlo_of_record") && failing.every((t) => t.escalate_to === "mlo_of_record") ? "mlo_of_record" : failing.some((t) => t.escalate_to === "licensed_specialist") && failing.every((t) => t.escalate_to === "licensed_specialist") ? "licensed_specialist" : "officer";
  out.push(events.append({ type: "compliance.gate.blocked", ...app, actor, payload: { application_id: s.application_id, gate: g.gate, gate_code: gate, run_id: run.run_id, checkpoint: g.checkpoint, failing_tests: derivation.failing_tests, cure_plan, command_refused: g.command, review_due, review_timer: "SM_O61_BLOCKING_FAILURE_REVIEW_1BD", blocked_channels, waivable: failing.map((t) => ({ test_code: t.test_code, waivable: t.waivable })) } }));
  let escalation_id: string | null = null;
  if (opts.escalations) escalation_id = opts.escalations.open({ kind: escalate_to, ...(g.breach_severity ? { severity: g.breach_severity } : {}), applicationId: s.application_id, ...(s.loan_id ? { loanId: s.loan_id } : {}), payload: { gate: g.gate, gate_code: gate, command_refused: g.command, failing_tests: derivation.failing_tests, cure_plan, review_timer: "SM_O61_BLOCKING_FAILURE_REVIEW_1BD", review_due, run_id: run.run_id } }, actor).id;
  return { gate, gate_name: g.gate, checkpoint: g.checkpoint, run, derivation, open: false, cure_plan, review_due, escalation_id, escalate_to, blocked_channels, instruction, events: out };
}
/** `assertGateOpen(application_id, <gate code>)` at a checkpoint command: returns the evaluation when open, throws ComplianceGateBlocked (the command is refused) otherwise. */
export function assertGateOpen(events: EventStore, gate: GateCode, s: ComplianceSnapshot, opts: Parameters<typeof evaluateComplianceGate>[3], actor: Actor = AGENT): GateEvaluation {
  const r = evaluateComplianceGate(events, gate, s, opts, actor);
  if (!r.open) throw new ComplianceGateBlocked(gate, r);
  return r;
}
/** A `compliance_waivers` request: legal tests (waivable=false) are rejected; only `officer` may attach a policy-only waiver; appends `compliance.waiver.granted`. */
export function requestWaiver(events: EventStore, inp: { application_id: string; loan_id?: string | null; waiver_id: string; test: ComplianceTestRow & { test_id?: string }; rationale: string; expires_at?: string | null }, approver: Actor): { waiver: ComplianceWaiver; event: DomainEvent } {
  nonEmpty(inp.waiver_id, "waiver_id"); nonEmpty(inp.rationale, "rationale");
  const d = testDefinition(inp.test.test_code);
  if (!d.waivable || !inp.test.waivable) throw new RangeError(`${inp.test.test_code} is a legal test (waivable=false) — a compliance_waivers row cannot be attached; cure the failure instead`);
  if (approver.kind !== "human" || approver.role !== "officer") throw new RangeError(`only the partner officer may attach a policy-only waiver (actor ${approver.kind}:${approver.id}${approver.role ? ` role ${approver.role}` : ""})`);
  const waiver: ComplianceWaiver = { waiver_id: inp.waiver_id, test_id: inp.test.test_id ?? `${inp.test.test_code}`, test_code: inp.test.test_code, kind: "policy_only", approved_by: approver.id, rationale: inp.rationale, expires_at: inp.expires_at ?? null };
  const event = events.append({ type: "compliance.waiver.granted", applicationId: inp.application_id, ...(inp.loan_id ? { loanId: inp.loan_id } : {}), actor: approver, payload: { application_id: inp.application_id, waiver_id: waiver.waiver_id, test_code: waiver.test_code, kind: waiver.kind, approved_by: waiver.approved_by, rationale: waiver.rationale, expires_at: waiver.expires_at } });
  return { waiver, event };
}
/** Runs armed and gates opened/blocked reconstructed from the application's `compliance.*` events (the ops-console view). */
export function complianceHistoryFromEvents(events: EventStore, application_id: string): { runs: { run_id: string; checkpoint: string; overall_result: string; completed_at: string }[]; gates: { gate: string; state: "open" | "blocked"; at: string; failing_tests: string[] }[] } {
  const all = events.all().filter((e) => e.applicationId === application_id || (e.payload as Record<string, unknown>).application_id === application_id);
  const runs = all.filter((e) => e.type === "compliance.testrun.completed").map((e) => ({ run_id: String(e.payload.run_id), checkpoint: String(e.payload.checkpoint), overall_result: String(e.payload.overall_result), completed_at: e.occurredAt }));
  const gates = all.filter((e) => e.type === "compliance.gate.opened" || e.type === "compliance.gate.blocked").map((e) => ({ gate: String(e.payload.gate), state: e.type === "compliance.gate.opened" ? "open" as const : "blocked" as const, at: e.occurredAt, failing_tests: (e.payload.failing_tests as string[] | undefined) ?? [] }));
  return { runs, gates };
}
/** Decision record fields the agent writes to `agent_decisions` for a gate evaluation. */
export function decisionRecord(r: GateEvaluation, model_version: string, prompt_version: string, confidence: number): Record<string, unknown> {
  return { run_id: r.run.run_id, checkpoint: r.checkpoint, rule_set_versions: r.run.rule_set_versions, inputs_hash: r.run.inputs_hash, tests: r.run.tests.map((t) => ({ test_code: t.test_code, result: t.result, blocking: t.blocking, waiver_id: t.waiver_id })), overall_result: r.run.overall_result, gate: r.open ? "open" : "blocked", cure_plan: r.cure_plan, rationale: r.open ? `every blocking test passed at ${r.checkpoint}` : `blocked by ${r.derivation.failing_tests.join(", ")}`, model_version, prompt_version, confidence };
}
