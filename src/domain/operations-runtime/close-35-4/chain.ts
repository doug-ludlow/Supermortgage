/**
 * §35.4 rule 1 — "The chain is data, not code." The month chain and the tax-year chain as the rows `close.open` writes
 * into close_period_steps; the planner reads `depends_on`, `not_before` and the receipts and never consults a hard-coded
 * order. Each step names the owning section, the 35.3 cycle it plans (spelled as 35.3 rule 2 registers it — null for a
 * receipt-only step), the receipt event and the filter that identifies the period's receipt among that event's rows
 * (the fields the emitters actually carry, verified at HEAD: 6.3 `periodClosedEvent` carries `period_end`, 5.1's close
 * carries `period` and `checklist_complete`, 8.1's builder `as_of_date`, 18.3's compute `as_of_month`, 18.7's certify
 * `period_end`; 3.9's furnish/file events are `tax.1099int.*` — the spec's `escrow_interest_1099.furnished/.filed` are
 * that table's column names, see src/domain/escrow/timers-3-9.ts), and the owner's own clock the board mirrors.
 */
import type { PlainDate } from "../../../kernel/calendar/date.ts";
import { bd1Of, isDecember, isQuarterEnd, metro2NotBefore, periodEndOf, qcNotBefore, taxYearCloseNotBefore, taxYearOf } from "./calendar.ts";
import type { StepCode, UnitScope } from "./types.ts";

export interface StepDef {
  readonly code: StepCode;
  readonly owner_process: string;
  readonly depends_on: readonly StepCode[];
  readonly cycle_code: string | null;
  readonly unit_scope: UnitScope;
  readonly receipt_event_type: string;
  /** The receipt filter for a month period (`period` = YYYY-MM) or a tax-year period (`tax_year`). */
  readonly receipt_filter: (p: { period: string; period_end: PlainDate; tax_year: number | null }) => Record<string, unknown>;
  readonly not_before: ((p: { period: string; tax_year: number | null }) => string) | null;
  readonly owner_timer_code: string | null;
  /** Which of the period's units the receipts are counted over (the planner derives the count from typed rows). */
  readonly expected: "one" | "pi_accounts" | "pi_units" | "ti_accounts" | "all_accounts" | "reportable_loans" | "filed_loans" | "ioe_loans" | "ac_loans";
}

/** The three steps a reopen never resets (rule 9: Fannie Mae's and the bureaus' record of the period — IRM 4-08; C-4.1-01). */
export const FINAL_STEPS: readonly StepCode[] = ["lar", "period_close", "metro2_snapshot"];

/** Rule 1's month chain, row for row. December adds `tax_year_close`; Mar/Jun/Sep/Dec add `eligibility`. */
export const MONTH_STEPS: readonly StepDef[] = [
  { code: "eod_cutoff", owner_process: "35.5", depends_on: [], cycle_code: null, unit_scope: "global", receipt_event_type: "cashiering.daily.run_completed", receipt_filter: (p) => ({ as_of_date: p.period_end }), not_before: null, owner_timer_code: "SM_CASHIERING_DAILY_RECEIPT_1D", expected: "one" },
  { code: "custodial_day_close", owner_process: "6.3", depends_on: ["eod_cutoff"], cycle_code: null, unit_scope: "per_custodial_account", receipt_event_type: "custodial.reconciliation.daily_completed", receipt_filter: (p) => ({ as_of_date: p.period_end }), not_before: null, owner_timer_code: "FNMA_C1101_DEPOSIT_CUSTODIAL_24H", expected: "pi_accounts" },
  { code: "metro2_snapshot", owner_process: "8.1", depends_on: ["eod_cutoff"], cycle_code: "metro2_monthly", unit_scope: "global", receipt_event_type: "credit.cycle.snapshot_completed", receipt_filter: (p) => ({ as_of_date: p.period_end }), not_before: (p) => metro2NotBefore(p.period), owner_timer_code: "FNMA_C41_01_METRO2_SNAPSHOT_EOM", expected: "one" },
  { code: "lar", owner_process: "5.1", depends_on: ["eod_cutoff"], cycle_code: "lar_daily", unit_scope: "global", receipt_event_type: "investor.lar.run_completed", receipt_filter: (p) => ({ as_of_date: bd1Of(p.period) }), not_before: null, owner_timer_code: "FNMA_C4301_LAR_NONREMOVAL_NEXTBD_2000", expected: "one" },
  { code: "period_close", owner_process: "5.1", depends_on: ["lar"], cycle_code: "investor_period_close", unit_scope: "global", receipt_event_type: "investor_reporting_periods.closed", receipt_filter: (p) => ({ period: p.period, checklist_complete: true }), not_before: null, owner_timer_code: "FNMA_IRM_PERIOD_CLOSE_BD2_1700", expected: "one" },
  { code: "ledger_period_close", owner_process: "6.3", depends_on: ["custodial_day_close"], cycle_code: "ledger_period_close", unit_scope: "per_custodial_account", receipt_event_type: "ledger.period.closed", receipt_filter: (p) => ({ period_end: p.period_end }), not_before: null, owner_timer_code: null, expected: "all_accounts" },
  { code: "balance_attestation", owner_process: "35.4", depends_on: ["ledger_period_close", "period_close", "metro2_snapshot"], cycle_code: null, unit_scope: "per_custodial_account", receipt_event_type: "close.period.attested", receipt_filter: (p) => ({ period: p.period }), not_before: null, owner_timer_code: "SM_CLOSE_ATTEST_BD5", expected: "pi_units" },
  { code: "form496", owner_process: "6.3", depends_on: ["ledger_period_close", "period_close"], cycle_code: "form_496_monthly", unit_scope: "per_custodial_account", receipt_event_type: "custodial.reconciliation.completed", receipt_filter: (p) => ({ kind: "monthly_form_496", period: p.period }), not_before: null, owner_timer_code: "FNMA_F496_PI_RECON_45", expected: "pi_units" },
  { code: "form496a", owner_process: "6.4", depends_on: ["ledger_period_close"], cycle_code: "form_496a_monthly", unit_scope: "per_custodial_account", receipt_event_type: "custodial.reconciliation.completed", receipt_filter: (p) => ({ kind: "monthly_form_496a", period: p.period }), not_before: null, owner_timer_code: "FNMA_F496A_TI_RECON_45", expected: "ti_accounts" },
  { code: "qc_cycle", owner_process: "18.1", depends_on: ["period_close"], cycle_code: null, unit_scope: "global", receipt_event_type: "qc.cycle.signed", receipt_filter: (p) => ({ period_end: p.period_end }), not_before: (p) => qcNotBefore(p.period), owner_timer_code: "FNMA_A4101_QC_CYCLE_MONTHLY", expected: "one" },
  { code: "star", owner_process: "18.3", depends_on: ["period_close"], cycle_code: "star_monthly", unit_scope: "global", receipt_event_type: "star.metrics.computed", receipt_filter: (p) => ({ as_of_month: p.period }), not_before: null, owner_timer_code: "SM_STAR_COMPUTE_MONTHLY_BD5", expected: "one" },
  { code: "eligibility", owner_process: "18.7", depends_on: ["period_close"], cycle_code: null, unit_scope: "global", receipt_event_type: "eligibility.computed", receipt_filter: (p) => ({ period_end: p.period_end }), not_before: null, owner_timer_code: "FHFA_ELIG_QUARTERLY_TEST", expected: "one" },
  { code: "tax_year_close", owner_process: "35.4", depends_on: ["period_close", "ledger_period_close"], cycle_code: null, unit_scope: "global", receipt_event_type: "close.tax_year.closed", receipt_filter: (p) => ({ tax_year: p.tax_year ?? taxYearOf(p.period) }), not_before: (p) => taxYearCloseNotBefore(p.tax_year ?? taxYearOf(p.period)), owner_timer_code: "SM_TAX_YEAR_CLOSE_3BD", expected: "one" },
];

/** The kind `tax_year` period's six steps (rule 1, last paragraph; rule 10). */
export const TAX_YEAR_STEPS: readonly StepDef[] = [
  { code: "form_1098_furnish", owner_process: "7.1", depends_on: [], cycle_code: "form_1098", unit_scope: "per_loan", receipt_event_type: "tax_form.1098.furnished", receipt_filter: (p) => ({ tax_year: p.tax_year }), not_before: null, owner_timer_code: "IRS_6050H_1098_FURNISH_0131", expected: "reportable_loans" },
  { code: "form_1099_int_furnish", owner_process: "3.9", depends_on: [], cycle_code: null, unit_scope: "per_loan", receipt_event_type: "tax.1099int.furnished", receipt_filter: (p) => ({ tax_year: p.tax_year }), not_before: null, owner_timer_code: "IRS_1099INT_FURNISH_0131", expected: "ioe_loans" },
  { code: "form_1099_ac_furnish", owner_process: "15.x", depends_on: [], cycle_code: null, unit_scope: "per_loan", receipt_event_type: "tax_form.1099ac.furnished", receipt_filter: (p) => ({ tax_year: p.tax_year }), not_before: null, owner_timer_code: null, expected: "ac_loans" },
  { code: "form_1098_file", owner_process: "7.1", depends_on: ["form_1098_furnish"], cycle_code: null, unit_scope: "per_loan", receipt_event_type: "tax_form.1098.filed", receipt_filter: (p) => ({ tax_year: p.tax_year, irs_accepted: true }), not_before: null, owner_timer_code: "IRS_6050H_1098_FILE_0331", expected: "filed_loans" },
  { code: "form_1099_int_file", owner_process: "3.9", depends_on: ["form_1099_int_furnish"], cycle_code: null, unit_scope: "per_loan", receipt_event_type: "tax.1099int.filed", receipt_filter: (p) => ({ tax_year: p.tax_year, irs_accepted: true }), not_before: null, owner_timer_code: "IRS_1099INT_EFILE_0331", expected: "ioe_loans" },
  { code: "form_1099_ac_file", owner_process: "15.x", depends_on: ["form_1099_ac_furnish"], cycle_code: null, unit_scope: "per_loan", receipt_event_type: "tax_form.1099ac.filed", receipt_filter: (p) => ({ tax_year: p.tax_year, form_1100_submitted: true }), not_before: null, owner_timer_code: null, expected: "ac_loans" },
];

export const stepDef = (code: StepCode): StepDef => { const d = [...MONTH_STEPS, ...TAX_YEAR_STEPS].find((s) => s.code === code); if (!d) throw new RangeError(`35.4: no step ${code}`); return d; };
/** The steps a month period gets: the eleven, plus `eligibility` at a quarter end and `tax_year_close` in December. */
export function monthChain(period: string): readonly StepDef[] {
  return MONTH_STEPS.filter((s) => (s.code === "eligibility" ? isQuarterEnd(period) : s.code === "tax_year_close" ? isDecember(period) : true));
}
/** Every step downstream of `changed` in the dependency graph (transitively), in chain order. */
export function downstreamOf(defs: readonly StepDef[], changed: StepCode): StepCode[] {
  const out = new Set<StepCode>(); let grew = true;
  while (grew) { grew = false; for (const d of defs) if (!out.has(d.code) && d.depends_on.some((x) => x === changed || out.has(x))) { out.add(d.code); grew = true; } }
  return defs.filter((d) => out.has(d.code)).map((d) => d.code);
}
export const periodEndOfDef = periodEndOf;
