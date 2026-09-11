/**
 * §30.3 Escrow account establishment at origination — the operating rules over the servicing escrow engine
 * (src/domain/escrow: 3.2 line projection + Appendix E `project`, 3.4 cushion checks, 3.1 initial statement, 3.5
 * payoff refund, 3.7 event chain, 3.8 waiver vocabulary) run with `analysis_type='initial'`, `source='origination'`
 * and a projection year that starts on the first payment date. Everything is bigint cents and PlainDate; nothing
 * here contacts a borrower, and every event carries the origination key (`applicationId`; `loanId` too once 30.2 has
 * created the servicing row).
 *
 * Events appended (timer subject in brackets — src/kernel/timers/engine.ts arms on `loanId`, else the application):
 *   escrow.analysis.computing / escrow.cushion.validated / escrow.cushion.cap_failed   (3.4's names; the cushion module's
 *                                                       facts — REGX_1024_17C5_CUSHION_CAP_GATE reads `cap_check_passed`)
 *   escrow.initial_analysis.computed{analysis_id, source=origination, …}              [application]
 *   escrow.initial_analysis.superseded{analysis_id, superseded_by}                   [application]
 *   escrow.initial_analysis.approved{analysis_id, hpml, …}                          [application — satisfies
 *                                                       REGX_1024_17C2_INITIAL_ANALYSIS_GATE; 23.4's HPML gate reads `hpml=true`]
 *   escrow.cd_consistency.passed / .failed{cd_version, mismatches}                   [application — REGZ_1026_38L7_CD_ESCROW_CONSISTENCY_GATE]
 *   escrow.initial_analysis.frozen{analysis_id, cd_version_id}                       [application]
 *   escrow.statement.rendered{statement_type=initial, analysis_id, checklist_passed} [application — first satisfier of 25.4's
 *                                                       SM_O64_INITIAL_ESCROW_STMT_AT_SETTLEMENT]
 *   escrow.initial_statement.required{reason=settlement, settlement_date}            [3.1's trigger of REGX_1024_17G_INITIAL_STMT_45,
 *                                                       raised at consummation]
 *   escrow.statement.sent{statement_type=initial, channel=closing_package}           [3.1's satisfier, on day 0; the 45-day
 *                                                       fallback goes through 3.1's recordStatementSent]
 *   escrow.initial_analysis.refreshed_at_funding{result∈{frozen_confirmed, superseded}} [satisfies SM_ESCROW_REFRESH_AT_FUNDING_T0]
 *   escrow.account.established{reason=origination, …}                               [3.x name — seeds 3.2/3.3's annual cycle]
 *   escrow.waiver.requested{origin=origination} / escrow.waiver.evaluating / escrow.waiver.decided   (3.8's names, keyed by the
 *                                                       application; the servicing FNMA_B101_MI_MONTHLY_ESCROW_GATE reads
 *                                                       `borrower_paid_mi_monthly` on the evaluating fact)
 *   consent.captured{kind=escrow_credit_to_new_loan}                                [old loan + application]
 *   escrow.credit_to_new_loan.posted / disbursement.issued{method=credit_to_new_loan} (3.5's names — satisfy
 *                                                       REGX_1024_34B_SAME_SERVICER_CREDIT_AGREEMENT_GATE and 3.5's 20-BD refund row)
 *   escrow.setup_event.sent / escrow.setup_event.queued{sequence=1}                 (3.7's Setup-event fact → 30.1's Escrow Setup event)
 *
 * Defects in the shared code worked around here (reported in the build notes): 3.4 recordCushionCheck and 3.8
 * recordWaiverRequest/recordWaiverEvaluation/recordWaiverDenial require a `loan_id`; before funding an origination
 * has only an application id, so the same event names and payload fields are appended here keyed by `applicationId`.
 */
import type { Cents } from "../../kernel/money/cents.ts";
import { divRound } from "../../kernel/money/decimal.ts";
import { type PlainDate, addDays, addMonths, addYears, parts, ymd, endOfMonth, plainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, creditor, servicer, fannieEt } from "../../kernel/calendar/business.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import type { Ledger, LineInput } from "../../kernel/ledger/ledger.ts";
import { project, cushion, projectLines, type Projection, type ProjectedItem, type CushionInputs, type EscrowLineInput } from "../escrow/analysis.ts";
import { ESCROW_ANALYSIS_COMPUTING, ESCROW_CUSHION_VALIDATED, ESCROW_CUSHION_CAP_FAILED, checkFromProjection, cushionCheckReasons, type CushionCheckReason } from "../escrow/ops-3-4.ts";
import { recordStatementSent, scriptSolicitsWaiver } from "../escrow/ops.ts";
import { payoffRefundDue } from "../escrow/refund.ts";
import type { DenialReason } from "../escrow/waiver.ts";
import { chainState, periodKeyOf, ITEM_TYPE } from "../escrow/ops-3-7.ts";
import { render, type Rendered } from "../../notices/render.ts";
import { evaluateChecklist, type ChecklistResult } from "../../notices/checklist.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import type { NoticeRegistry } from "../../notices/registry.ts";

export const RULE_SET_30_3 = "regx.escrow.2013" as const;
export const ESCROW_AGENT: Actor = { kind: "agent", id: "escrow" };
/** Pre-purchase T&I custodial account (30.1-Q2) that holds the closing deposit from funding until purchase. */
export const CUSTODIAL_TI_PREPURCHASE = "custodial_ti_prepurchase" as const;
/** 3.7's default Fannie Mae T&I custodial account id (the source of a same-servicer credit's cash — F-1-03 "funds due borrower"). */
export const FNMA_TI_ACCOUNT_DEFAULT = "TI-1014" as const;
export const INITIAL_STATEMENT_TEMPLATE = "NTC_REGX_1024_17G_INITIAL_ESCROW_STMT" as const;   // 3.1's template, origination edition
export const POLICY_CUSHION_MONTHS = 2;
export const WAIVER_DECISION_CREDITOR_BD = 3;
export const ET = "America/New_York";

const need = (ok: unknown, msg: string): void => { if (!ok) throw new RangeError(msg); };
const isDate = (v: unknown): v is PlainDate => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const p = (e: DomainEvent): Record<string, unknown> => e.payload as Record<string, unknown>;
const S = (c: Cents): string => String(c);
const roundHalfUpRatio = (num: Cents, den: Cents): bigint => (num <= 0n ? 0n : (2n * num + den) / (2n * den));
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** The origination keys every 30.3 event carries: the application before funding, both ids during the hand-off. */
export interface OriginationKeys { readonly application_id: string; readonly loan_id?: string | null; }
const keys = (k: OriginationKeys): { applicationId: string; loanId?: string } => ({ applicationId: k.application_id, ...(k.loan_id ? { loanId: k.loan_id } : {}) });

// ============================================================ rule 1: line construction at origination
export type OriginationLineType = "tax_county" | "tax_city" | "tax_school" | "tax_special" | "hazard" | "flood" | "ho6" | "mi_borrower_paid" | "hoa" | "ground_rent" | "special_assessment";
/** `escrow_lines.estimate_basis` (30.3 data model enum). */
export type EstimateBasis30 = "known_bill" | "prior_year" | "prior_year_cpi" | "quote" | "contract";
export interface TaxInstallment { readonly tax_year: number; readonly installment_no: number; readonly amount_cents: Cents; readonly due_on: PlainDate; readonly penalty_on: PlainDate; readonly discount?: { by: PlainDate; amount_cents: Cents } | null; readonly paid?: boolean; }
/** The tax-service parcel record (24.4 APN → installments, due and delinquency dates for the current and next tax year). */
export interface ParcelRecord { readonly apn: string; readonly state: string; readonly county: string; readonly annual_cents: Cents; readonly basis: "known_bill" | "prior_year" | "prior_year_cpi"; readonly installments: readonly TaxInstallment[]; readonly line_type?: OriginationLineType; }
/** 24.5's insurance policy: the first year is prepaid at closing, so the escrow line carries the renewal at `premium_paid_through`. */
export interface PolicyRecord { readonly policy_number: string; readonly kind: "hazard" | "flood" | "ho6"; readonly first_year_premium_cents: Cents; readonly premium_paid_through: PlainDate; readonly renewal_quote_cents?: Cents | null; readonly renewal_invoice_due_on?: PlainDate | null; readonly required_by_creditor?: boolean; readonly term_years?: number; }
/** 24.6's MI certificate (monthly BPMI renewals from escrow; scheduled 78% date ends the line). */
export interface MiRecord { readonly certificate_id: string; readonly premium_plan: "bpmi_monthly" | "bpmi_single" | "bpmi_split" | "lpmi"; readonly monthly_premium_cents: Cents; readonly scheduled_78_date: PlainDate; }
export interface ProjectedBill { readonly amount_cents: Cents; readonly due_on: PlainDate; readonly penalty_on: PlainDate | null; readonly discount_by: PlainDate | null; readonly scheduled_pay_date: PlainDate; readonly status: "projected"; readonly reference: string; }
/** An `escrow_lines` row as 30.3 writes it (3.2 owns the table; `source` gains `origination`). */
export interface EscrowLine30 {
  readonly line_type: OriginationLineType; readonly source: "origination"; readonly estimate_basis: EstimateBasis30; readonly payee_reference: string;
  readonly frequency: "annual" | "semiannual" | "quarterly" | "monthly"; readonly installment_count: number; readonly estimated_annual_cents: Cents;
  readonly terminates_on: PlainDate | null; readonly effective_from: PlainDate; readonly active: boolean; readonly escrowed: boolean;
  /** `escrow_bills` rows (status projected): due date, penalty date and the 3.7 scheduled pay date. */
  readonly bills: readonly ProjectedBill[];
  /** (c)(2)/(k): the projection disburses on the penalty-avoidance date, never the "due" date. */
  readonly disbursement_date_basis: "scheduled_pay_date";
  readonly evidence_document_id?: string | null;
}
export interface BuildLinesInput {
  readonly first_payment_date: PlainDate; readonly parcel?: ParcelRecord | null; readonly policies?: readonly PolicyRecord[]; readonly mi?: MiRecord | null;
  readonly hoa_dues_annual_cents?: Cents | null; readonly hoa_escrowed?: boolean; readonly special_assessments?: readonly { reference: string; amount_cents: Cents; due_on: PlainDate; penalty_on?: PlainDate | null }[];
}
/** 3.7 scheduled pay date: the earlier of a discount deadline and the penalty-avoidance date, never before the bill exists (its due date is the latest availability). */
export function scheduledPayDate(b: { due_on: PlainDate; penalty_on?: PlainDate | null; discount_by?: PlainDate | null }): PlainDate {
  let on = b.penalty_on ?? b.due_on;
  if (b.discount_by && b.discount_by < on) on = b.discount_by;
  return on;
}
/**
 * Rule 1: taxes from the parcel record (unpaid installments; Arizona: disbursed by the Nov 1 / May 1 delinquency deadlines, not the
 * Oct 1 / Mar 1 due dates); hazard/flood/HO-6 renewal at the policy's paid-through date (estimate = renewal quote, else the current
 * premium — no CPI); monthly BPMI from the certificate until the scheduled 78% date; HOA dues not escrowed by default (open question 4);
 * special assessments accumulate before their due date (B2-1.5-04).
 */
export function buildEscrowLines(i: BuildLinesInput): EscrowLine30[] {
  need(isDate(i.first_payment_date), "first_payment_date is required (the computation year starts there — §1024.17(b))");
  const from = i.first_payment_date; const out: EscrowLine30[] = [];
  if (i.parcel) {
    const pr = i.parcel; need(pr.installments.length > 0 && pr.annual_cents > 0n, "parcel record needs installments and an annual amount");
    const unpaid = pr.installments.filter((x) => !x.paid);
    for (const x of unpaid) need(isDate(x.due_on) && isDate(x.penalty_on) && x.penalty_on >= x.due_on, `installment ${x.tax_year}/${x.installment_no}: penalty date must be on/after the due date`);
    const perYear = pr.installments.filter((x) => x.tax_year === pr.installments[0]!.tax_year).length;
    out.push({ line_type: pr.line_type ?? "tax_county", source: "origination", estimate_basis: pr.basis, payee_reference: pr.apn, frequency: perYear >= 4 ? "quarterly" : perYear === 2 ? "semiannual" : "annual", installment_count: perYear,
      estimated_annual_cents: pr.annual_cents, terminates_on: null, effective_from: from, active: true, escrowed: true, disbursement_date_basis: "scheduled_pay_date",
      bills: unpaid.map((x) => ({ amount_cents: x.amount_cents, due_on: x.due_on, penalty_on: x.penalty_on, discount_by: x.discount?.by ?? null, scheduled_pay_date: scheduledPayDate({ due_on: x.due_on, penalty_on: x.penalty_on, discount_by: x.discount?.by ?? null }), status: "projected", reference: `${pr.apn}:${x.tax_year}:${x.installment_no}` })) });
  }
  for (const pol of i.policies ?? []) {
    need(isDate(pol.premium_paid_through) && pol.first_year_premium_cents > 0n, `policy ${pol.policy_number}: premium and paid-through date are required`);
    const renewal = pol.renewal_quote_cents ?? pol.first_year_premium_cents; const basis: EstimateBasis30 = pol.renewal_quote_cents != null ? "quote" : "prior_year";
    const due = pol.renewal_invoice_due_on ?? pol.premium_paid_through;
    out.push({ line_type: pol.kind, source: "origination", estimate_basis: basis, payee_reference: pol.policy_number, frequency: "annual", installment_count: 1, estimated_annual_cents: renewal, terminates_on: null, effective_from: from, active: true, escrowed: true, disbursement_date_basis: "scheduled_pay_date",
      bills: [{ amount_cents: renewal, due_on: due, penalty_on: pol.premium_paid_through, discount_by: null, scheduled_pay_date: scheduledPayDate({ due_on: due, penalty_on: pol.premium_paid_through }), status: "projected", reference: `${pol.policy_number}:renewal` }] });
  }
  if (i.mi && i.mi.premium_plan === "bpmi_monthly") {
    const m = i.mi; need(m.monthly_premium_cents > 0n && isDate(m.scheduled_78_date), "MI certificate needs the monthly premium and the scheduled 78% date (24.6)");
    const bills: ProjectedBill[] = [];
    for (let k = 0; k < 12; k++) { const on = addMonths(from, k); if (on >= m.scheduled_78_date) break; bills.push({ amount_cents: m.monthly_premium_cents, due_on: on, penalty_on: on, discount_by: null, scheduled_pay_date: on, status: "projected", reference: `${m.certificate_id}:${on}` }); }
    out.push({ line_type: "mi_borrower_paid", source: "origination", estimate_basis: "contract", payee_reference: m.certificate_id, frequency: "monthly", installment_count: 12, estimated_annual_cents: m.monthly_premium_cents * 12n, terminates_on: m.scheduled_78_date, effective_from: from, active: true, escrowed: true, disbursement_date_basis: "scheduled_pay_date", bills });
  }
  if (i.hoa_dues_annual_cents && i.hoa_dues_annual_cents > 0n) {
    out.push({ line_type: "hoa", source: "origination", estimate_basis: "known_bill", payee_reference: "hoa", frequency: "annual", installment_count: 1, estimated_annual_cents: i.hoa_dues_annual_cents, terminates_on: null, effective_from: from, active: i.hoa_escrowed === true, escrowed: i.hoa_escrowed === true, disbursement_date_basis: "scheduled_pay_date",
      bills: [{ amount_cents: i.hoa_dues_annual_cents, due_on: from, penalty_on: from, discount_by: null, scheduled_pay_date: from, status: "projected", reference: "hoa:annual" }] });
  }
  for (const sa of i.special_assessments ?? []) {
    out.push({ line_type: "special_assessment", source: "origination", estimate_basis: "known_bill", payee_reference: sa.reference, frequency: "annual", installment_count: 1, estimated_annual_cents: sa.amount_cents, terminates_on: null, effective_from: from, active: true, escrowed: true, disbursement_date_basis: "scheduled_pay_date",
      bills: [{ amount_cents: sa.amount_cents, due_on: sa.due_on, penalty_on: sa.penalty_on ?? null, discount_by: null, scheduled_pay_date: scheduledPayDate({ due_on: sa.due_on, penalty_on: sa.penalty_on ?? null }), status: "projected", reference: sa.reference }] });
  }
  return out;
}

/** The 3.2 R1 inputs for the escrowed lines. `as_entered=true` replays the projection on the bills' due dates (what a data-entry error would produce — T4's comparison), never the basis the analysis records. */
export function toLineInputs(lines: readonly EscrowLine30[], yearStart: PlainDate, opts: { as_entered?: boolean } = {}): EscrowLineInput[] {
  const yearEnd = addMonths(yearStart, 12);
  return lines.filter((l) => l.escrowed).map((l) => ({
    line_type: l.line_type, frequency: l.frequency, estimate_basis: l.estimate_basis === "quote" ? "quote" : l.estimate_basis, prior_year_annual_cents: l.estimated_annual_cents, prior_disbursed_on: [],
    ...(l.line_type === "mi_borrower_paid" ? { contract_annual_cents: l.estimated_annual_cents } : {}), terminates_on: l.terminates_on,
    known_bills: l.bills.filter((b) => (opts.as_entered ? b.due_on : b.scheduled_pay_date) >= yearStart && (opts.as_entered ? b.due_on : b.scheduled_pay_date) < yearEnd)
      .map((b) => ({ amount_cents: b.amount_cents, due_on: b.due_on, ...(opts.as_entered ? {} : { penalty_on: b.penalty_on, ...(b.discount_by ? { discount: { by: b.discount_by, amount_cents: 0n } } : {}) }) })),
  }));
}

// ============================================================ rules 2–4: the initial analysis
export interface TrialRow { readonly period_index: number; readonly period_date: PlainDate; readonly month: string; readonly deposit_cents: Cents; readonly disbursement_cents: Cents; readonly disbursements: readonly { line_type: string; amount_cents: Cents }[]; readonly step1_cents: Cents; readonly zeroed_cents: Cents; readonly target_cents: Cents; }
export interface CdSingleItemLine { readonly item: string; readonly line_types: readonly string[]; readonly annual_cents: Cents; readonly per_month_cents: Cents; readonly months: number; readonly amount_cents: Cents; readonly deposits_before_first_disbursement_cents: Cents; readonly first_installment_cents: Cents; }
export interface CdEscrowFigures {
  readonly g3: { readonly lines: readonly CdSingleItemLine[]; readonly aggregate_adjustment_cents: Cents; readonly total_cents: Cents };
  readonly l7: { readonly escrowed_property_costs_year1_cents: Cents; readonly non_escrowed_property_costs_year1_cents: Cents; readonly initial_escrow_payment_cents: Cents; readonly monthly_escrow_payment_cents: Cents; readonly periodic_payments_in_year1: number };
  readonly projected_payments_escrow_cents: Cents;
}
export type AnalysisStatus30 = "lines_pending" | "computed" | "anomaly_review" | "approved" | "disclosed_on_cd" | "frozen" | "established" | "superseded";
export interface InitialAnalysisInput extends OriginationKeys {
  readonly analysis_id: string; readonly lines: readonly EscrowLine30[]; readonly first_payment_date: PlainDate; readonly settlement_date: PlainDate; readonly disbursement_date?: PlainDate | null;
  readonly cushion?: CushionInputs; readonly biweekly?: boolean; readonly cd_version_id?: string | null; readonly supersedes_analysis_id?: string | null; readonly hpml?: boolean;
  readonly non_escrowed_costs_year1_cents?: Cents; readonly as_of: PlainDate; readonly actor?: Actor; readonly pi_cents?: Cents | null;
}
export interface InitialAnalysis30 {
  readonly analysis_id: string; readonly application_id: string; readonly loan_id: string | null; readonly analysis_type: "initial"; readonly source: "origination"; status: AnalysisStatus30;
  readonly cd_version_id: string | null; readonly settlement_date: PlainDate; readonly disbursement_date: PlainDate | null; readonly first_payment_date: PlainDate;
  readonly computation_year_start: PlainDate; readonly computation_year_end: PlainDate; readonly periods: 12 | 26; readonly per_period_cents: Cents;
  readonly annual_disbursements_cents: Cents; readonly base_payment_cents: Cents; readonly cushion_months: number; readonly requested_cushion_months: number; readonly cushion_cents: Cents; readonly cushion_cap_source: Projection["cushion_source"]; readonly cushion_cap_cents: Cents;
  readonly low_point_month: PlainDate; readonly low_point_cents: Cents; readonly required_start_balance_cents: Cents; readonly target_at_start_cents: Cents; readonly lowest_target_cents: Cents;
  readonly cap_check_passed: boolean; readonly preaccrual_check_passed: boolean; readonly trial_balance: readonly TrialRow[];
  readonly single_item_lines: readonly CdSingleItemLine[]; readonly aggregate_adjustment_cents: Cents; readonly escrowed_costs_year1_cents: Cents; readonly non_escrowed_costs_year1_cents: Cents; readonly cd_figures: CdEscrowFigures;
  readonly lines: readonly EscrowLine30[]; readonly all_lines_have_basis: boolean; readonly disbursement_date_basis: "scheduled_pay_date (§1024.17(c)(2)/(k): on or before the penalty-avoidance deadline)";
  readonly projection: Projection; readonly anomalies: readonly string[]; readonly supersedes_analysis_id: string | null; readonly hpml: boolean; readonly pi_cents: Cents | null;
  frozen_at?: string | null; readonly decision_record: Record<string, unknown>; readonly events: { computing: DomainEvent; validated: DomainEvent; cap_failed: DomainEvent | null; computed: DomainEvent; superseded: DomainEvent | null };
}
/** (g)(3) item labels (§1026.37(g)(3) / 25.2's CD labels) per line type. */
export const CD_ITEM_LABEL: Record<string, string> = { tax_county: "Property taxes", tax_city: "Property taxes", tax_school: "Property taxes", tax_special: "Property taxes", hazard: "Homeowner's insurance", ho6: "Homeowner's insurance", flood: "Flood insurance", mi_borrower_paid: "Mortgage insurance", hoa: "Homeowner's association dues", ground_rent: "Ground rent", special_assessment: "Special assessments" };

/** Rule 4: single-item lines — `months_i = whole months of shortfall after the deposits made before the first disbursement + cushion months` (floored at the cushion months); the aggregate adjustment absorbs the rest so the (g)(3) total equals the deposit to the cent (rule 10). */
export function cdSingleItemLines(items: readonly ProjectedItem[], lines: readonly EscrowLine30[], yearStart: PlainDate, cushionMonths: number, targetAtStart: Cents, periods: number): { lines: CdSingleItemLine[]; aggregate_adjustment_cents: Cents } {
  const groups = new Map<string, { line_types: Set<string>; annual: Cents; first: ProjectedItem | null }>();
  for (const l of lines.filter((x) => x.escrowed)) { const item = CD_ITEM_LABEL[l.line_type] ?? l.line_type; const g = groups.get(item) ?? { line_types: new Set<string>(), annual: 0n, first: null }; g.line_types.add(l.line_type); g.annual += l.estimated_annual_cents; groups.set(item, g); }
  for (const it of [...items].sort((a, b) => (a.disburse_on < b.disburse_on ? -1 : 1))) { const item = CD_ITEM_LABEL[it.line_type] ?? it.line_type; const g = groups.get(item); if (g && !g.first) g.first = it; }
  const monthsCushion = Math.max(0, Math.floor(cushionMonths));
  const out: CdSingleItemLine[] = [];
  for (const [item, g] of groups) {
    if (!g.first) continue;
    const perMonth = divRound(g.annual, BigInt(periods === 26 ? 12 : 12), "HALF_UP");
    const a = parts(yearStart), b = parts(g.first.disburse_on); const before = BigInt(Math.max(0, (b.y - a.y) * 12 + (b.m - a.m)));
    const deposits = before * perMonth; const shortfall = g.first.amount_cents - deposits;
    const months = Number(roundHalfUpRatio(shortfall, perMonth)) + monthsCushion;
    out.push({ item, line_types: [...g.line_types], annual_cents: g.annual, per_month_cents: perMonth, months: Math.max(monthsCushion, months), amount_cents: BigInt(Math.max(monthsCushion, months)) * perMonth, deposits_before_first_disbursement_cents: deposits, first_installment_cents: g.first.amount_cents });
  }
  const sum = out.reduce((s, l) => s + l.amount_cents, 0n);
  return { lines: out, aggregate_adjustment_cents: targetAtStart - sum };
}

/** Rule 2 with the (c)(1)(ii) cap applied as a *check*, not a silent clamp: a policy/instrument parameter above one-sixth fails the 3.4 cap gate (T11). */
export function cushionParameter(annual: Cents, c: CushionInputs): { months: number; requested_cents: Cents; cap_cents: Cents; within_cap: boolean; source: Projection["cushion_source"] } {
  const cu = cushion(annual, c);
  const months = c.instrument_dollars_cents != null ? 0 : Math.min(c.policy_months ?? POLICY_CUSHION_MONTHS, c.instrument_months ?? Infinity, c.state_max_months ?? Infinity);
  const requested = c.instrument_dollars_cents != null ? c.instrument_dollars_cents : (annual * BigInt(Math.round(months * 100))) / 1200n;
  return { months, requested_cents: requested, cap_cents: cu.cap_cents, within_cap: requested <= cu.cap_cents, source: cu.source };
}

/**
 * The initial analysis (3.2 R1 line projection → Appendix E Steps 1–3 via the servicing engine) with `analysis_type='initial'`,
 * `source='origination'`, projection start = first payment date; records 3.4's computing/cushion facts and the
 * `escrow.initial_analysis.computed` fact; a superseding run (rule 10 override, a changed line before consummation) also
 * appends `escrow.initial_analysis.superseded` for the version it replaces.
 */
export function runInitialAnalysis(events: EventStore, i: InitialAnalysisInput): InitialAnalysis30 {
  need(!!i.application_id && !!i.analysis_id, "application_id and analysis_id are required");
  need(isDate(i.first_payment_date) && isDate(i.settlement_date) && isDate(i.as_of), "first_payment_date, settlement_date and as_of must be ISO dates");
  need(i.first_payment_date > i.settlement_date, "the first payment date follows settlement (§1024.17(b): computation year begins with the initial payment date)");
  need(Array.isArray(i.lines) && i.lines.some((l) => l.escrowed), "at least one escrowed line is required (status lines_pending otherwise)");
  const actor = i.actor ?? ESCROW_AGENT; const yearStart = i.first_payment_date; const cu: CushionInputs = i.cushion ?? { policy_months: POLICY_CUSHION_MONTHS };
  const computing = events.append({ type: ESCROW_ANALYSIS_COMPUTING, ...keys(i), actor, payload: { analysis_id: i.analysis_id, analysis_type: "initial", source: "origination", reason: "initial", as_of: i.as_of, year_start: yearStart } });
  const lp = projectLines(toLineInputs(i.lines, yearStart), yearStart, { as_of: i.as_of });
  const pr = project(lp.items, yearStart, cu, { biweekly: i.biweekly === true });
  const param = cushionParameter(pr.annual_for_cushion_cents, cu);
  const check = checkFromProjection(pr, { loan_id: i.loan_id ?? i.application_id, analysis_id: i.analysis_id, source: "engine", cushion_months: param.months, actor });
  const capPassed = check.cap_check_passed && param.within_cap;
  const preaccrualPassed = check.preaccrual_check_passed ?? true;   // null = no dated item to check (3.4)
  const reasons: CushionCheckReason[] = cushionCheckReasons({ cap_check_passed: capPassed, preaccrual_check_passed: preaccrualPassed });
  const cushionFields = { analysis_id: i.analysis_id, source: "engine", cushion_months: param.months, cushion_cents: S(pr.cushion_cents), requested_cushion_cents: S(param.requested_cents), cushion_cap_source: pr.cushion_source, cushion_cap_cents: S(pr.cap_cents), lowest_target_cents: check.lowest_target_cents === null ? null : S(check.lowest_target_cents), cap_check_passed: capPassed, preaccrual_check_passed: preaccrualPassed };
  const validated = events.append({ type: ESCROW_CUSHION_VALIDATED, ...keys(i), actor, causationId: computing.id, payload: cushionFields });
  const capFailed = reasons.length ? events.append({ type: ESCROW_CUSHION_CAP_FAILED, ...keys(i), actor, causationId: validated.id, payload: { ...cushionFields, reason: reasons.join("+"), reasons } }) : null;
  // Trial balance rows (12 monthly or 26 biweekly): Step 1 running balance, Step 2 zeroed, Step 3 target.
  const disb = new Array<{ line_type: string; amount_cents: Cents }[]>(pr.periods).fill([]).map(() => [] as { line_type: string; amount_cents: Cents }[]);
  for (const it of pr.items) { const k = pr.periods === 12 ? (parts(it.disburse_on).y - parts(yearStart).y) * 12 + (parts(it.disburse_on).m - parts(yearStart).m) : Math.floor((Date.parse(it.disburse_on) - Date.parse(yearStart)) / (14 * 86_400_000)); if (k >= 0 && k < pr.periods) disb[k]!.push({ line_type: it.line_type, amount_cents: it.amount_cents }); }
  const rows: TrialRow[] = pr.step1.map((bal, k) => { const on = pr.periods === 12 ? addMonths(yearStart, k) : addDays(yearStart, 14 * k); return { period_index: k, period_date: on, month: pr.periods === 12 ? MONTHS[parts(on).m - 1]! : `P${k + 1}`, deposit_cents: pr.base_payment_cents, disbursement_cents: disb[k]!.reduce((s, d) => s + d.amount_cents, 0n), disbursements: disb[k]!, step1_cents: bal, zeroed_cents: bal + pr.required_start_cents, target_cents: pr.targets[k]! }; });
  const low = rows.reduce((a, r) => (r.step1_cents < a.step1_cents ? r : a), rows[0]!);
  const lowestTarget = pr.targets.reduce((a, b) => (b < a ? b : a));
  const single = cdSingleItemLines(pr.items, i.lines, yearStart, param.months, pr.target_at_start_cents, pr.periods);
  const nonEscrowed = i.non_escrowed_costs_year1_cents ?? i.lines.filter((l) => !l.escrowed).reduce((s, l) => s + l.estimated_annual_cents, 0n);
  const cd: CdEscrowFigures = { g3: { lines: single.lines, aggregate_adjustment_cents: single.aggregate_adjustment_cents, total_cents: pr.target_at_start_cents },
    l7: { escrowed_property_costs_year1_cents: pr.base_payment_cents * BigInt(pr.periods), non_escrowed_property_costs_year1_cents: nonEscrowed, initial_escrow_payment_cents: pr.target_at_start_cents, monthly_escrow_payment_cents: pr.base_payment_cents, periodic_payments_in_year1: pr.periods },
    projected_payments_escrow_cents: pr.base_payment_cents };
  const allBasis = i.lines.every((l) => !!l.estimate_basis);
  const anomalies = [...lp.anomalies, ...reasons, ...(allBasis ? [] : ["estimate_basis_missing"]), ...(pr.multi_year_low_point_flag ? ["multi_year_low_point_outside_year"] : [])];
  const status: AnalysisStatus30 = anomalies.length ? "anomaly_review" : "computed";
  const base = { analysis_id: i.analysis_id, analysis_type: "initial", source: "origination", application_id: i.application_id, cd_version_id: i.cd_version_id ?? null, settlement_date: i.settlement_date, disbursement_date: i.disbursement_date ?? null, first_payment_date: yearStart,
    annual_disbursements_cents: S(pr.annual_cents), base_payment_cents: S(pr.base_payment_cents), cushion_months: param.months, cushion_cents: S(pr.cushion_cents), low_point_month: low.period_date, low_point_cents: S(low.step1_cents), required_start_balance_cents: S(pr.required_start_cents), target_at_start_cents: S(pr.target_at_start_cents),
    aggregate_adjustment_cents: S(single.aggregate_adjustment_cents), escrowed_costs_year1_cents: S(cd.l7.escrowed_property_costs_year1_cents), cap_check_passed: capPassed, preaccrual_check_passed: preaccrualPassed, periods: pr.periods, status, anomalies, supersedes_analysis_id: i.supersedes_analysis_id ?? null, hpml: i.hpml === true, rule_set: RULE_SET_30_3 };
  const computed = events.append({ type: "escrow.initial_analysis.computed", ...keys(i), actor, causationId: validated.id, payload: base });
  const superseded = i.supersedes_analysis_id ? events.append({ type: "escrow.initial_analysis.superseded", ...keys(i), actor, causationId: computed.id, payload: { analysis_id: i.supersedes_analysis_id, superseded_by: i.analysis_id, reason: "line_changed_before_consummation" } }) : null;
  const decision_record = { application_id: i.application_id, analysis_id: i.analysis_id, lines: i.lines.map((l) => ({ type: l.line_type, basis: l.estimate_basis, amount: S(l.estimated_annual_cents), disbursement_dates: l.bills.map((b) => b.scheduled_pay_date), disbursement_date_basis: "§1024.17(c)(2)/(k): scheduled_pay_date = on or before the penalty-avoidance deadline (Arizona: Nov 1 / May 1, not the Oct 1 / Mar 1 due dates)", evidence: l.evidence_document_id ?? l.payee_reference })),
    annual: S(pr.annual_cents), base: S(pr.base_payment_cents), cushion: S(pr.cushion_cents), low_point: { month: low.period_date, cents: S(low.step1_cents) }, deposit: S(pr.target_at_start_cents), cd_lines: single.lines.map((l) => ({ item: l.item, months: l.months, per_month: S(l.per_month_cents), amount: S(l.amount_cents) })), aggregate_adjustment: S(single.aggregate_adjustment_cents),
    rule_set: RULE_SET_30_3, cushion_check: cushionFields, anomalies };
  return { analysis_id: i.analysis_id, application_id: i.application_id, loan_id: i.loan_id ?? null, analysis_type: "initial", source: "origination", status, cd_version_id: i.cd_version_id ?? null, settlement_date: i.settlement_date, disbursement_date: i.disbursement_date ?? null, first_payment_date: yearStart,
    computation_year_start: yearStart, computation_year_end: addDays(addMonths(yearStart, 12), -1), periods: pr.periods as 12 | 26, per_period_cents: pr.base_payment_cents,
    annual_disbursements_cents: pr.annual_cents, base_payment_cents: pr.base_payment_cents, cushion_months: param.months, requested_cushion_months: cu.policy_months ?? POLICY_CUSHION_MONTHS, cushion_cents: pr.cushion_cents, cushion_cap_source: pr.cushion_source, cushion_cap_cents: pr.cap_cents,
    low_point_month: low.period_date, low_point_cents: low.step1_cents, required_start_balance_cents: pr.required_start_cents, target_at_start_cents: pr.target_at_start_cents, lowest_target_cents: lowestTarget, cap_check_passed: capPassed, preaccrual_check_passed: preaccrualPassed, trial_balance: rows,
    single_item_lines: single.lines, aggregate_adjustment_cents: single.aggregate_adjustment_cents, escrowed_costs_year1_cents: cd.l7.escrowed_property_costs_year1_cents, non_escrowed_costs_year1_cents: nonEscrowed, cd_figures: cd, lines: i.lines, all_lines_have_basis: allBasis,
    disbursement_date_basis: "scheduled_pay_date (§1024.17(c)(2)/(k): on or before the penalty-avoidance deadline)", projection: pr, anomalies, supersedes_analysis_id: i.supersedes_analysis_id ?? null, hpml: i.hpml === true, pi_cents: i.pi_cents ?? null, frozen_at: null, decision_record,
    events: { computing, validated, cap_failed: capFailed, computed, superseded } };
}

/** T4's comparison: the deposit a projection on the bills' *due* dates (the data-entry error) would have produced — never used for the account. */
export function dueDateProjectionDeposit(lines: readonly EscrowLine30[], yearStart: PlainDate, c: CushionInputs = { policy_months: POLICY_CUSHION_MONTHS }): { target_at_start_cents: Cents; low_point_cents: Cents; projection: Projection } {
  const items = projectLines(toLineInputs(lines, yearStart, { as_entered: true }), yearStart, { as_of: yearStart }).items;
  const pr = project(items, yearStart, c);
  return { target_at_start_cents: pr.target_at_start_cents, low_point_cents: pr.step1.reduce((a, b) => (b < a ? b : a), 0n), projection: pr };
}

/** Rule 10 (agent guardrail): a line amount may be overridden only with a cited document — returns the corrected lines for a superseding run. */
export function overrideLineEstimate(lines: readonly EscrowLine30[], o: { line_type: OriginationLineType; new_annual_cents: Cents; reason: string; evidence_document_id?: string | null; basis?: EstimateBasis30 }): EscrowLine30[] {
  need(!!o.evidence_document_id, "a line amount may be overridden only with a cited document (bill image, declarations page, renewal quote) — evidence_document_id is required");
  need(o.new_annual_cents > 0n, "new_annual_cents must be positive");
  const idx = lines.findIndex((l) => l.line_type === o.line_type); need(idx >= 0, `no ${o.line_type} line to override`);
  const old = lines[idx]!; const ratioNum = o.new_annual_cents; const ratioDen = old.estimated_annual_cents;
  const bills = old.bills.map((b) => ({ ...b, amount_cents: old.installment_count === 1 ? o.new_annual_cents : divRound(b.amount_cents * ratioNum, ratioDen, "HALF_UP") }));
  const next: EscrowLine30 = { ...old, estimated_annual_cents: o.new_annual_cents, estimate_basis: o.basis ?? "quote", bills, evidence_document_id: o.evidence_document_id ?? null };
  return lines.map((l, k) => (k === idx ? next : l));
}

/** REGX_1024_17C2_INITIAL_ANALYSIS_GATE facts, read from the engine's record: approved, every line's basis set, cushion within the cap, no pre-accrual. */
export function initialAnalysisGateFacts(a: Pick<InitialAnalysis30, "status" | "all_lines_have_basis" | "cap_check_passed" | "preaccrual_check_passed"> | null): Record<string, unknown> {
  return { approved: a?.status === "approved" || a?.status === "disclosed_on_cd" || a?.status === "frozen" || a?.status === "established", all_lines_have_basis: a?.all_lines_have_basis === true, cap_check_passed: a?.cap_check_passed === true, preaccrual_check_passed: a?.preaccrual_check_passed === true };
}

/** The `escrow` agent's approval: refused while the 3.4 cushion/pre-accrual checks fail or an anomaly is unreviewed; the approved fact carries `hpml` for 23.4's gate. */
export function approveInitialAnalysis(events: EventStore, a: InitialAnalysis30, o: { approved_on: PlainDate; actor?: Actor; reviewed?: boolean; rationale?: string }): { event: DomainEvent; status: "approved" } {
  need(isDate(o.approved_on), "approved_on must be an ISO date");
  need(a.cap_check_passed, `REGX_1024_17C5_CUSHION_CAP_GATE: cushion ${a.cushion_cents} (requested ${a.requested_cushion_months} months) exceeds one-sixth of annual disbursements ${a.cushion_cap_cents} — approval refused (§1024.17(c)(5))`);
  need(a.preaccrual_check_passed, "REGX_1024_17C6_PREACCRUAL_GATE: a disbursement is projected before its bill is available or after its penalty date — approval refused (§1024.17(c)(6))");
  need(a.all_lines_have_basis, "every line's estimate_basis must be set before approval");
  need(a.status !== "anomaly_review" || o.reviewed === true, `anomaly_review: ${a.anomalies.join(", ")} — resolve with evidence before approval`);
  need(a.status === "computed" || a.status === "anomaly_review", `analysis ${a.analysis_id} is ${a.status}, not approvable`);
  const event = events.append({ type: "escrow.initial_analysis.approved", ...keys(a), actor: o.actor ?? ESCROW_AGENT, causationId: a.events.computed.id, payload: {
    analysis_id: a.analysis_id, analysis_type: "initial", source: "origination", hpml: a.hpml, approved_on: o.approved_on, base_payment_cents: S(a.base_payment_cents), cushion_cents: S(a.cushion_cents), target_at_start_cents: S(a.target_at_start_cents),
    computation_year_start: a.computation_year_start, computation_year_end: a.computation_year_end, all_lines_have_basis: a.all_lines_have_basis, cap_check_passed: a.cap_check_passed, preaccrual_check_passed: a.preaccrual_check_passed, reviewed: o.reviewed === true, rationale: o.rationale ?? null, rule_set: RULE_SET_30_3 } });
  a.status = "approved";
  return { event, status: "approved" };
}

// ============================================================ CD consistency (REGZ_1026_38L7_CD_ESCROW_CONSISTENCY_GATE)
export interface CdEscrowDraft {
  readonly cd_version: string; readonly g3_lines: readonly { item: string; months: number; per_month_cents: Cents; amount_cents: Cents }[]; readonly g3_aggregate_adjustment_cents: Cents; readonly g3_total_cents: Cents;
  readonly l7_escrowed_year1_cents: Cents; readonly l7_non_escrowed_year1_cents: Cents; readonly l7_initial_escrow_payment_cents: Cents; readonly l7_monthly_escrow_cents: Cents; readonly projected_payments_escrow_cents: Cents;
}
/** 25.2's `cd_figure_sources` payload: the CD draft that carries this analysis's figures. */
export function cdDraftFromAnalysis(a: InitialAnalysis30, cdVersion: string): CdEscrowDraft {
  const f = a.cd_figures;
  return { cd_version: cdVersion, g3_lines: f.g3.lines.map((l) => ({ item: l.item, months: l.months, per_month_cents: l.per_month_cents, amount_cents: l.amount_cents })), g3_aggregate_adjustment_cents: f.g3.aggregate_adjustment_cents, g3_total_cents: f.g3.total_cents,
    l7_escrowed_year1_cents: f.l7.escrowed_property_costs_year1_cents, l7_non_escrowed_year1_cents: f.l7.non_escrowed_property_costs_year1_cents, l7_initial_escrow_payment_cents: f.l7.initial_escrow_payment_cents, l7_monthly_escrow_cents: f.l7.monthly_escrow_payment_cents, projected_payments_escrow_cents: f.projected_payments_escrow_cents };
}
/** The gate's arithmetic: (g)(3) total = deposit; lines = single-item lines + aggregate adjustment; (l)(7) monthly = base; escrowed year 1 = payments × base; initial escrow payment = (g)(3) total; projected-payments escrow column = base. */
export function cdConsistencyMismatches(a: InitialAnalysis30, cd: CdEscrowDraft): string[] {
  const f = a.cd_figures; const out: string[] = [];
  const eq = (label: string, got: Cents, want: Cents) => { if (got !== want) out.push(`${label}: CD ${got} ≠ analysis ${want}`); };
  eq("(g)(3) total", cd.g3_total_cents, f.g3.total_cents);
  eq("(g)(3) aggregate adjustment", cd.g3_aggregate_adjustment_cents, f.g3.aggregate_adjustment_cents);
  for (const l of f.g3.lines) { const c = cd.g3_lines.find((x) => x.item === l.item); if (!c) { out.push(`(g)(3) line ${l.item} missing on the CD`); continue; } if (c.months !== l.months) out.push(`(g)(3) ${l.item} months: CD ${c.months} ≠ ${l.months}`); eq(`(g)(3) ${l.item} per month`, c.per_month_cents, l.per_month_cents); eq(`(g)(3) ${l.item} amount`, c.amount_cents, l.amount_cents); }
  for (const c of cd.g3_lines) if (!f.g3.lines.some((l) => l.item === c.item)) out.push(`(g)(3) line ${c.item} is not an analysis item`);
  eq("(l)(7) monthly escrow payment", cd.l7_monthly_escrow_cents, f.l7.monthly_escrow_payment_cents);
  eq("(l)(7) escrowed property costs over year 1", cd.l7_escrowed_year1_cents, f.l7.escrowed_property_costs_year1_cents);
  eq("(l)(7) non-escrowed property costs over year 1", cd.l7_non_escrowed_year1_cents, f.l7.non_escrowed_property_costs_year1_cents);
  eq("(l)(7) initial escrow payment", cd.l7_initial_escrow_payment_cents, f.l7.initial_escrow_payment_cents);
  eq("projected payments escrow column", cd.projected_payments_escrow_cents, f.projected_payments_escrow_cents);
  return out;
}
/** Runs on every `disclosure.cd.prepared{version}` draft (25.2): appends `escrow.cd_consistency.passed` or `.failed{mismatches}`; a failure means `issueCD` is refused and 25.1's ESCROW_CD_MATCH test fails. */
export function checkCdConsistency(events: EventStore, a: InitialAnalysis30, cd: CdEscrowDraft, o: { actor?: Actor; cd_prepared_event_id?: string | null } = {}): { passed: boolean; mismatches: string[]; event: DomainEvent; gate: "REGZ_1026_38L7_CD_ESCROW_CONSISTENCY_GATE" } {
  need(!!cd && typeof cd.cd_version === "string" && cd.cd_version.length > 0, "a CD draft with its version is required");
  const mismatches = cdConsistencyMismatches(a, cd);
  const passed = mismatches.length === 0;
  const event = events.append({ type: passed ? "escrow.cd_consistency.passed" : "escrow.cd_consistency.failed", ...keys(a), actor: o.actor ?? ESCROW_AGENT, ...(o.cd_prepared_event_id ? { causationId: o.cd_prepared_event_id } : {}), payload: { analysis_id: a.analysis_id, cd_version: cd.cd_version, consistent: passed, mismatches, g3_total_cents: S(cd.g3_total_cents), target_at_start_cents: S(a.target_at_start_cents), gate: "REGZ_1026_38L7_CD_ESCROW_CONSISTENCY_GATE", compliance_test: "ESCROW_CD_MATCH", rule_set: RULE_SET_30_3 } });
  if (passed && a.status === "approved") a.status = "disclosed_on_cd";
  return { passed, mismatches, event, gate: "REGZ_1026_38L7_CD_ESCROW_CONSISTENCY_GATE" };
}
/** The latest CD draft 25.2 prepared for the application (`disclosure.cd.prepared{version}`), when its payload carries the escrow figures. */
export function latestCdPrepared(events: EventStore, applicationId: string): DomainEvent | null {
  const xs = events.ofType("disclosure.cd.prepared").filter((e) => e.applicationId === applicationId || p(e).application_id === applicationId);
  return xs[xs.length - 1] ?? null;
}

/** Freeze at the final CD's `consummation_ready` (25.2): the version 25.4's closing package renders the statement from; confirmed unchanged at `closing.consummated`. */
export function freezeAnalysis(events: EventStore, a: InitialAnalysis30, o: { cd_version_id: string; frozen_at: string; actor?: Actor }): { event: DomainEvent } {
  need(a.status === "approved" || a.status === "disclosed_on_cd", `only an approved analysis freezes (status ${a.status})`);
  need(!!o.cd_version_id, "cd_version_id (the consummation_ready CD version) is required");
  const event = events.append({ type: "escrow.initial_analysis.frozen", ...keys(a), actor: o.actor ?? ESCROW_AGENT, payload: { analysis_id: a.analysis_id, cd_version_id: o.cd_version_id, frozen_at: o.frozen_at, target_at_start_cents: S(a.target_at_start_cents), base_payment_cents: S(a.base_payment_cents) } });
  a.status = "frozen"; a.frozen_at = o.frozen_at;
  return { event };
}

// ============================================================ rule 5: initial escrow statement at settlement (3.1's template)
let registryCache: NoticeRegistry | null = null;
const noticeRegistry = (): NoticeRegistry => { if (!registryCache) { registryCache = buildRegistry(); publishAuthored(registryCache); } return registryCache; };
export interface StatementInput { readonly pi_cents: Cents; readonly account_last4: string; readonly servicer_phone: string; readonly partner_name: string; readonly rendered_on: PlainDate; readonly credit_transfer_cents?: Cents | null; readonly days_after_trigger?: number; }
export interface RenderedStatement { readonly payload: Record<string, unknown>; readonly rendered: Rendered; readonly checklist: ChecklistResult; readonly template: typeof INITIAL_STATEMENT_TEMPLATE; readonly servicer_block: string; readonly cushion_text: string; readonly opening_deposit_text: string; readonly computation_year: { start: PlainDate; end: PlainDate }; readonly event: DomainEvent; }
/** The (g)(1)(i) payload for 3.1's template from the frozen (or approved) analysis: total monthly payment with the escrow portion, itemized disbursements with dates, the cushion, the trial running balance (Step 3 targets as the projected balances) and the computation year. */
export function initialStatementPayload(a: InitialAnalysis30, s: StatementInput): Record<string, unknown> {
  const use = (t: string): string => (t.startsWith("tax") ? "county tax" : t === "hazard" || t === "ho6" ? "hazard insurance" : t === "flood" ? "flood insurance" : t === "mi_borrower_paid" ? "mortgage insurance" : t.replace(/_/g, " "));
  const disbursements = a.projection.items.map((it) => { const line = a.lines.find((l) => l.line_type === it.line_type); return { payee: line?.payee_reference ?? it.line_type, use: use(it.line_type), amount_cents: it.amount_cents, on: it.disburse_on }; }).sort((x, y) => (x.on < y.on ? -1 : 1));
  const sixth = a.annual_disbursements_cents / 6n; const pct = sixth > 0n ? Number((a.cushion_cents * 100n) / sixth) : 0;
  const credit = s.credit_transfer_cents ?? 0n;
  return { monthly_payment_cents: s.pi_cents + a.base_payment_cents, pi_cents: s.pi_cents, escrow_payment_cents: a.base_payment_cents, computation_year_start: a.computation_year_start, computation_year_end: a.computation_year_end, disbursements,
    cushion_cents: a.cushion_cents, cushion_over_sixth_pct: pct, trial_balance: a.trial_balance.map((r) => ({ month: r.month, deposit_cents: r.deposit_cents, disbursement_cents: r.disbursement_cents, balance_cents: r.target_cents })),
    starting_balance_cents: a.target_at_start_cents, low_point_cents: a.lowest_target_cents, account_last4: s.account_last4, servicer_phone: s.servicer_phone, days_after_trigger: s.days_after_trigger ?? 0,
    servicer_block: `Supermortgage, servicer for ${s.partner_name}`, analysis_id: a.analysis_id, frozen_version: a.frozen_at ?? null, credit_transfer_cents: credit,
    opening_deposit_text: credit > 0n ? `Deposit at settlement ${money(a.target_at_start_cents)} (includes ${money(credit)} transferred from your prior escrow account at your request)` : `Deposit at settlement ${money(a.target_at_start_cents)}` };
}
export const money = (c: Cents): string => { const neg = c < 0n; const v = neg ? -c : c; const d = (v / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ","); return `${neg ? "-" : ""}$${d}.${(v % 100n).toString().padStart(2, "0")}`; };
/** 26.2's `closing.scheduled{closing_id, scheduled_at, …}` for the application: the consummation the package is composed for (25.4's SM_O64_INITIAL_ESCROW_STMT_AT_SETTLEMENT trigger). */
export function closingScheduled(events: EventStore, applicationId: string): { on: PlainDate; closing_id: string | null } | null {
  const e = events.ofType("closing.scheduled").filter((x) => x.applicationId === applicationId || p(x).application_id === applicationId).at(-1);
  if (!e) return null; const at = String(p(e).scheduled_at ?? p(e).consummation_at ?? ""); if (!/^\d{4}-\d{2}-\d{2}/.test(at)) return null;
  return { on: plainDate(at.slice(0, 10)), closing_id: typeof p(e).closing_id === "string" ? (p(e).closing_id as string) : null };
}
/** 25.4's package rule: the statement rides in the consummation package when the analysis is approved ≥ 1 creditor business day before the scheduled consummation; otherwise 3.1's 45-day path. */
export function packageLead(approvedOn: PlainDate, scheduledConsummation: PlainDate | null): { in_package: boolean; latest_approval_on: PlainDate | null } {
  if (!scheduledConsummation) return { in_package: false, latest_approval_on: null };
  const latest = addBusinessDays(scheduledConsummation, -1, creditor);
  return { in_package: approvedOn <= latest, latest_approval_on: latest };
}
/** Renders 3.1's template (origination edition) and runs its (g)(1)(i) checklist — no statement leaves without it; appends `escrow.statement.rendered{statement_type=initial}` with the package-lead fact from 26.2's scheduled closing. */
export function renderInitialStatement(events: EventStore, a: InitialAnalysis30, s: StatementInput, actor: Actor = ESCROW_AGENT): RenderedStatement {
  need(a.status === "frozen" || a.status === "approved" || a.status === "disclosed_on_cd" || a.status === "established", `the statement renders from the frozen/approved analysis (status ${a.status})`);
  need(typeof s.pi_cents === "bigint" && s.pi_cents > 0n && !!s.account_last4 && !!s.servicer_phone && !!s.partner_name, "pi_cents, account_last4, servicer_phone and partner_name are required");
  const v = noticeRegistry().activeVersion(INITIAL_STATEMENT_TEMPLATE, s.rendered_on); need(!!v, `${INITIAL_STATEMENT_TEMPLATE} has no active version on ${s.rendered_on}`);
  const payload = initialStatementPayload(a, s); const rendered = render(v!.source, payload); const checklist = evaluateChecklist(v!, payload, rendered);
  need(checklist.passed, `(g)(1)(i) checklist failed: ${checklist.blocking.map((r) => r.rule_id).join(", ")}`);
  const scheduled = closingScheduled(events, a.application_id); const lead = packageLead(s.rendered_on, scheduled?.on ?? a.settlement_date);
  const event = events.append({ type: "escrow.statement.rendered", ...keys(a), actor, payload: { statement_type: "initial", template: INITIAL_STATEMENT_TEMPLATE, analysis_id: a.analysis_id, frozen_version: a.frozen_at ?? null, rendered_on: s.rendered_on, payload_hash: rendered.payloadHash, checklist_passed: true, disclosure_kind: "initial_escrow_stmt", esign_scope: "origination_disclosures",
    scheduled_consummation: scheduled?.on ?? a.settlement_date, closing_id: scheduled?.closing_id ?? null, in_closing_package: lead.in_package, latest_approval_for_package_on: lead.latest_approval_on, package_timer: "SM_O64_INITIAL_ESCROW_STMT_AT_SETTLEMENT" } });
  return { payload, rendered, checklist, template: INITIAL_STATEMENT_TEMPLATE, servicer_block: String(payload.servicer_block), cushion_text: `${money(a.cushion_cents)} selected by the servicer`, opening_deposit_text: String(payload.opening_deposit_text), computation_year: { start: a.computation_year_start, end: a.computation_year_end }, event };
}
export interface SettlementDeliveryInput extends OriginationKeys { readonly settlement_date: PlainDate; readonly in_package: boolean; readonly rendered_event_id?: string | null; readonly actor?: Actor; }
export interface SettlementDelivery { readonly required: DomainEvent; readonly sent: DomainEvent | null; readonly due_on: PlainDate; readonly delivery_basis: "at_settlement" | "within_45_days"; readonly initial_statement_delivered_at: PlainDate | null; readonly timer: "REGX_1024_17G_INITIAL_STMT_45"; }
/**
 * At consummation: 3.1's `escrow.initial_statement.required{reason=settlement}` is raised on the settlement date (Reg X §1024.2(b): the
 * document-execution date, not the disbursement); the statement in the package is 3.1's `escrow.statement.sent{statement_type=initial,
 * channel=closing_package}` dated the same day, which closes the 45-day row on day 0. Omitted from the package → the row runs to
 * settlement + 45 calendar days and `mailStatementFallback` sends it.
 */
export function deliverStatementAtSettlement(events: EventStore, i: SettlementDeliveryInput): SettlementDelivery {
  need(isDate(i.settlement_date), "settlement_date must be an ISO date");
  const due_on = addDays(i.settlement_date, 45); const actor = i.actor ?? ESCROW_AGENT;
  const required = events.append({ type: "escrow.initial_statement.required", ...keys(i), actor, payload: { reason: "settlement", settlement_date: i.settlement_date, due_on, status: "required", timer: "REGX_1024_17G_INITIAL_STMT_45", rule_ref: "§1024.17(g)(1)", rule_set: RULE_SET_30_3 } });
  if (!i.in_package) return { required, sent: null, due_on, delivery_basis: "within_45_days", initial_statement_delivered_at: null, timer: "REGX_1024_17G_INITIAL_STMT_45" };
  const sent = events.append({ type: "escrow.statement.sent", ...keys(i), actor, causationId: i.rendered_event_id ?? required.id, payload: { template: INITIAL_STATEMENT_TEMPLATE, statement_type: "initial", channel: "closing_package", disposition: "sent", sent_on: i.settlement_date, due_on, delivery_basis: "at_settlement", esign_scope: "origination_disclosures", disclosure_kind: "initial_escrow_stmt" } });
  return { required, sent, due_on, delivery_basis: "at_settlement", initial_statement_delivered_at: i.settlement_date, timer: "REGX_1024_17G_INITIAL_STMT_45" };
}
/** The 45-day fallback (3.1 channel rules; print/e-delivery): 3.1's recordStatementSent closes the row when mailed by the due date. */
export function mailStatementFallback(events: EventStore, i: OriginationKeys & { settlement_date: PlainDate; mailed_on: PlainDate; actor?: Actor }): { delivery_basis: "within_45_days"; due_on: PlainDate; on_time: boolean; initial_statement_delivered_at: PlainDate } {
  need(isDate(i.mailed_on) && isDate(i.settlement_date), "mailed_on and settlement_date must be ISO dates");
  const due_on = addDays(i.settlement_date, 45);
  need(!!i.loan_id, "the 45-day fallback is a servicing send: the loan id (boarded at funding, 30.2) is required");
  const r = recordStatementSent(events, { loan_id: i.loan_id!, template: INITIAL_STATEMENT_TEMPLATE, statement_type: "initial", sent_on: i.mailed_on, due_on, actor: i.actor ?? ESCROW_AGENT });
  return { delivery_basis: "within_45_days", due_on, on_time: r.satisfied_on_time, initial_statement_delivered_at: i.mailed_on };
}

// ============================================================ rules 6 & 9: establishment at funding, HPML
/** Rule 9: `hpml_escrow_min_cancel_date = consummation + 5 years` (same month/day; §1026.35(b)(3)(i)(B)). */
export function hpmlMinCancelDate(consummation: PlainDate): PlainDate { need(isDate(consummation), "consummation date required"); return addYears(consummation, 5); }
export interface EscrowAccount30 {
  readonly loan_id: string; readonly application_id: string; readonly status: "active" | "waived"; readonly establishment_reason: "origination"; readonly established_at: PlainDate; readonly computation_year_start: PlainDate; readonly computation_year_end: PlainDate;
  readonly cushion_months: number; readonly cushion_cap_source: string; readonly monthly_escrow_payment_cents: Cents; readonly initial_deposit_cents: Cents; readonly custodial_account_id: typeof CUSTODIAL_TI_PREPURCHASE; readonly interest_rule_code: string | null;
  readonly hpml_escrow_min_cancel_date: PlainDate | null; readonly origination_waiver_id: string | null; readonly initial_statement_delivered_at: PlainDate | null; readonly initial_statement_delivery_basis: "at_settlement" | "within_45_days" | null;
  readonly analysis_id: string; readonly lines: readonly EscrowLine30[]; readonly annual_analysis_lead_on: PlainDate;
}
export interface EstablishInput extends OriginationKeys { readonly loan_id: string; readonly analysis: InitialAnalysis30; readonly funded_on: PlainDate; readonly consummation_date: PlainDate; readonly is_hpml: boolean; readonly interest_rule_code?: string | null; readonly waiver_id?: string | null; readonly waived?: boolean; readonly statement?: { delivered_at: PlainDate | null; basis: "at_settlement" | "within_45_days" | null } | null; readonly lines_changed_since_freeze?: boolean; readonly superseding_analysis_id?: string | null; readonly actor?: Actor; }
/** The `loan.funded{disbursement_date}` fact 26.3 raises for the application (the establishment date). */
export function fundedOn(events: EventStore, applicationId: string): PlainDate | null {
  const e = events.ofType("loan.funded").filter((x) => x.applicationId === applicationId || p(x).application_id === applicationId).at(-1);
  const d = e ? p(e).disbursement_date : null; return isDate(d) ? d : null;
}
/** 26.2's `closing.consummated{consummation_at, is_hpml}` for the application — the settlement date the freeze is confirmed against. */
export function consummatedOn(events: EventStore, applicationId: string): { on: PlainDate; is_hpml: boolean } | null {
  const e = events.ofType("closing.consummated").filter((x) => x.applicationId === applicationId || p(x).application_id === applicationId).at(-1);
  if (!e) return null; const at = String(p(e).consummation_at ?? ""); const on = isDate(at) ? at : plainDate(at.slice(0, 10)); return { on, is_hpml: p(e).is_hpml === true };
}
/**
 * Rule 6 at `loan.funded`: the SM_ESCROW_REFRESH_AT_FUNDING_T0 check (frozen version confirmed, or a superseding analysis with a
 * corrected CD / statement plan), then `escrow.account.established{reason=origination}` — `escrow_accounts.status='active'`,
 * computation year from the first payment date, lines active, projected bills, pre-purchase T&I custodial account, 3.9 interest
 * rule, the HPML five-year floor; the `escrow` agent takes over (3.2's annual lead arms from `computation_year_end`).
 */
export function establishEscrowAccount(events: EventStore, i: EstablishInput): { account: EscrowAccount30; refreshed: DomainEvent; established: DomainEvent } {
  need(!!i.loan_id && !!i.application_id, "loan_id (30.2's servicing row) and application_id are required at establishment");
  need(isDate(i.funded_on) && isDate(i.consummation_date), "funded_on and consummation_date must be ISO dates");
  const a = i.analysis; const actor = i.actor ?? ESCROW_AGENT;
  need(a.status === "frozen" || a.status === "approved" || a.status === "disclosed_on_cd", `REGX_1024_17C2_INITIAL_ANALYSIS_GATE: establishment needs an approved (frozen) initial analysis — ${a.analysis_id} is ${a.status}`);
  need(a.cap_check_passed && a.preaccrual_check_passed && a.all_lines_have_basis, "REGX_1024_17C2_INITIAL_ANALYSIS_GATE: cushion within cap, no pre-accrual and every line's basis set");
  const result = i.lines_changed_since_freeze ? "superseded" : "frozen_confirmed";
  need(result === "frozen_confirmed" || !!i.superseding_analysis_id, "a line changed since the freeze: a superseding analysis (3.2 interim + corrected CD/statement plan) is required before establishment");
  const refreshed = events.append({ type: "escrow.initial_analysis.refreshed_at_funding", ...keys(i), actor, payload: { analysis_id: a.analysis_id, result, frozen_version: a.frozen_at ?? null, superseding_analysis_id: i.superseding_analysis_id ?? null, disbursement_date: i.funded_on, timer: "SM_ESCROW_REFRESH_AT_FUNDING_T0" } });
  const hpmlDate = i.is_hpml ? hpmlMinCancelDate(i.consummation_date) : null;
  const yearEnd = a.computation_year_end; const lead = addDays(yearEnd, -45);
  const waived = i.waived === true; need(!(waived && i.is_hpml), "an HPML loan cannot be established waived (§1026.35(b)(1))");
  const account: EscrowAccount30 = { loan_id: i.loan_id, application_id: i.application_id, status: waived ? "waived" : "active", establishment_reason: "origination", established_at: i.funded_on, computation_year_start: a.computation_year_start, computation_year_end: yearEnd,
    cushion_months: a.cushion_months, cushion_cap_source: a.cushion_cap_source, monthly_escrow_payment_cents: a.base_payment_cents, initial_deposit_cents: a.target_at_start_cents, custodial_account_id: CUSTODIAL_TI_PREPURCHASE, interest_rule_code: i.interest_rule_code ?? null,
    hpml_escrow_min_cancel_date: hpmlDate, origination_waiver_id: i.waiver_id ?? null, initial_statement_delivered_at: i.statement?.delivered_at ?? null, initial_statement_delivery_basis: i.statement?.basis ?? null, analysis_id: a.analysis_id,
    lines: a.lines.map((l) => ({ ...l, active: !waived && l.escrowed })), annual_analysis_lead_on: lead };
  const established = events.append({ type: "escrow.account.established", ...keys(i), actor, causationId: refreshed.id, payload: { reason: "origination", established_at: i.funded_on, computation_year_start: a.computation_year_start, computation_year_end: yearEnd, next_computation_year_end: yearEnd, analysis_id: a.analysis_id,
    status: account.status, monthly_escrow_payment_cents: S(a.base_payment_cents), initial_deposit_cents: S(a.target_at_start_cents), cushion_months: a.cushion_months, custodial_account_id: CUSTODIAL_TI_PREPURCHASE, interest_rule_code: account.interest_rule_code, hpml: i.is_hpml, hpml_escrow_min_cancel_date: hpmlDate, origination_waiver_id: account.origination_waiver_id,
    initial_statement_delivered_at: account.initial_statement_delivered_at, initial_statement_delivery_basis: account.initial_statement_delivery_basis, application_id: i.application_id, rule_set: RULE_SET_30_3 } });
  a.status = "established";
  return { account, refreshed, established };
}
/** The escrow slice of 30.2's opening entry (Dr pre-purchase T&I custodial cash / Cr loan escrow) — proves the liability equals the deposit; 30.2 posts the full balanced set. */
export function closingEscrowDepositLines(loanId: string, cents: Cents): LineInput[] {
  need(cents > 0n, "closing escrow funds must be positive");
  return [{ account: { scope: "custodial", custodialAccountId: CUSTODIAL_TI_PREPURCHASE, account: "custodial_ti_cash" }, amountCents: cents, ruleRef: "30.3 rule 6: closing escrow deposit into custodial_ti_prepurchase" }, { account: { scope: "loan", loanId, account: "escrow" }, amountCents: -cents, ruleRef: "30.3 rule 6 / 30.2 opening ledger: Cr loan escrow (initial deposit)" }];
}
/** First-year actual projection with 3.7's release dates (taxes ~10 servicer BDs before the deadline; renewal likewise): month-end balances from the closing deposit — never negative on the fixture. */
export function firstYearActualBalances(a: InitialAnalysis30, leadBusinessDays = 10): { month_end: PlainDate; balance_cents: Cents }[] {
  const releases = a.projection.items.map((it) => ({ on: addBusinessDays(it.disburse_on, -leadBusinessDays, servicer), amount_cents: it.amount_cents }));
  const out: { month_end: PlainDate; balance_cents: Cents }[] = []; let bal = a.target_at_start_cents;
  for (let k = 0; k < 12; k++) { const start = addMonths(a.computation_year_start, k); const end = endOfMonth(start); bal += a.base_payment_cents; for (const r of releases) if (r.on >= start && r.on <= end) bal -= r.amount_cents; out.push({ month_end: end, balance_cents: bal }); }
  return out;
}
/** The (g)(2)/(c)(3) statement payment line: P&I + escrow (fixture $3,402.62 + $687.50 = $4,090.12). */
export function statementMonthlyPayment(piCents: Cents, a: Pick<InitialAnalysis30, "base_payment_cents">): Cents { return piCents + a.base_payment_cents; }

// ============================================================ rule 7: waiver at origination (borrower-requested; never solicited)
export interface PartnerWaiverPolicy { readonly version: string; readonly max_ltv_pct: string; readonly min_reserves_months_of_ti: number; readonly max_mortgage_lates_30_in_12m: number; readonly max_dti_pct: string; readonly pricing_adjustment_bps: number; readonly requires_lump_sum_ability_finding: boolean; }
/** `rule_sets.partner.escrow_waiver.<version>` default parameters (B2-1.5-04: not LTV alone; the ability to handle lump-sum payments). */
export const PARTNER_WAIVER_POLICY_DEFAULT: PartnerWaiverPolicy = { version: "partner.escrow_waiver.2026-09", max_ltv_pct: "80.000", min_reserves_months_of_ti: 2, max_mortgage_lates_30_in_12m: 0, max_dti_pct: "45.000", pricing_adjustment_bps: 0, requires_lump_sum_ability_finding: true };
export type OrigDenialReason = "HPML_ESCROW_REQUIRED" | "STATE_LAW_ESCROW_REQUIRED" | "REFI_FINANCING_TAXES" | "PARTNER_POLICY_LTV" | "PARTNER_POLICY_RESERVES" | "PARTNER_POLICY_PAYMENT_HISTORY" | "PARTNER_POLICY_DTI" | "PARTNER_POLICY_LUMP_SUM_ABILITY" | Extract<DenialReason, "MI_MONTHLY" | "FLOOD_MANDATORY" | "INSTRUMENT_PROHIBITS">;
export interface OriginationWaiverRequest extends OriginationKeys {
  readonly waiver_id: string; readonly requested_on: PlainDate; readonly scope: "full" | "partial"; readonly waived_line_types: readonly string[]; readonly channel: string;
  readonly is_hpml: boolean; readonly consummation_date?: PlainDate | null; readonly state: string; readonly state_requires_escrow?: boolean; readonly transaction_type: "purchase" | "refinance"; readonly taxes_financed_in_loan: boolean;
  readonly mi_premium_plan: MiRecord["premium_plan"] | "none"; readonly mi_monthly_premium_cents?: Cents | null; readonly ltv_pct: string; readonly reserves_months_of_ti: number; readonly mortgage_lates_30_in_12m: number; readonly dti_pct: string; readonly lump_sum_ability_documented: boolean;
  readonly sfha: boolean; readonly flood_election_written?: boolean; readonly partner_is_regulated_lender?: boolean; readonly instrument_permits_waiver?: boolean; readonly solicited?: boolean; readonly script?: string | null; readonly policy?: PartnerWaiverPolicy; readonly loan_amount_cents: Cents; readonly annual_ti_cents: Cents;
}
export interface OriginationWaiverDecision { readonly decision: "approved" | "partial" | "denied"; readonly reasons: OrigDenialReason[]; readonly lines_kept: string[]; readonly kept_reasons: OrigDenialReason[]; readonly policy_version: string; readonly pricing_adjustment_bps: number; readonly worksheet: Record<string, unknown>; readonly decision_due_on: PlainDate; readonly policy_exception_needed: boolean; }
const pctLE = (a: string, b: string): boolean => Number(a) <= Number(b);
/** Rule 7 in order: (a) law (HPML; state), (b) Fannie Mae (BPMI monthly line stays; refinance financing taxes), (c) the partner's written policy, (d) flood line per 24.5-Q3. Decision within 3 creditor business days. */
export function evaluateOriginationWaiver(r: OriginationWaiverRequest): OriginationWaiverDecision {
  need(isDate(r.requested_on) && !!r.waiver_id, "waiver_id and requested_on are required");
  need(r.solicited !== true && !(r.script && scriptSolicitsWaiver(r.script)), "Servicing Guide B-1-01: the servicer must not solicit borrowers to waive escrow — an origination-time waiver is the borrower's own election");
  const policy = r.policy ?? PARTNER_WAIVER_POLICY_DEFAULT; const reasons: OrigDenialReason[] = []; const kept: string[] = []; const keptReasons: OrigDenialReason[] = [];
  const steps: Record<string, unknown> = {};
  // (a) law
  if (r.is_hpml) reasons.push("HPML_ESCROW_REQUIRED");
  if (r.state_requires_escrow) reasons.push("STATE_LAW_ESCROW_REQUIRED");
  if (r.instrument_permits_waiver === false) reasons.push("INSTRUMENT_PROHIBITS");
  steps.law = { hpml: r.is_hpml, state_requires_escrow: r.state_requires_escrow === true, result: reasons.length ? "refuse" : "pass" };
  // (b) Fannie Mae B2-1.5-04
  const miMonthly = r.mi_premium_plan === "bpmi_monthly";
  if (miMonthly) { kept.push("mi_borrower_paid"); keptReasons.push("MI_MONTHLY"); }
  const refiTaxes = r.transaction_type === "refinance" && r.taxes_financed_in_loan; if (refiTaxes) reasons.push("REFI_FINANCING_TAXES");
  steps.fannie_mae = { bpmi_monthly_non_waivable: miMonthly, refi_financing_taxes: refiTaxes, result: refiTaxes ? "refuse" : miMonthly ? "partial_at_most" : "pass" };
  // (c) partner written policy — never LTV alone
  const policyFails: OrigDenialReason[] = [];
  if (!pctLE(r.ltv_pct, policy.max_ltv_pct)) policyFails.push("PARTNER_POLICY_LTV");
  if (r.reserves_months_of_ti < policy.min_reserves_months_of_ti) policyFails.push("PARTNER_POLICY_RESERVES");
  if (r.mortgage_lates_30_in_12m > policy.max_mortgage_lates_30_in_12m) policyFails.push("PARTNER_POLICY_PAYMENT_HISTORY");
  if (!pctLE(r.dti_pct, policy.max_dti_pct)) policyFails.push("PARTNER_POLICY_DTI");
  if (policy.requires_lump_sum_ability_finding && !r.lump_sum_ability_documented) policyFails.push("PARTNER_POLICY_LUMP_SUM_ABILITY");
  reasons.push(...policyFails);
  steps.partner_policy = { version: policy.version, ltv_pct: r.ltv_pct, max_ltv_pct: policy.max_ltv_pct, reserves_months: r.reserves_months_of_ti, lates_30_in_12m: r.mortgage_lates_30_in_12m, dti_pct: r.dti_pct, lump_sum_ability_documented: r.lump_sum_ability_documented, failures: policyFails, result: policyFails.length ? "refuse" : "pass" };
  // (d) flood
  const floodStays = r.sfha && !(r.flood_election_written === true && !r.is_hpml && r.partner_is_regulated_lender !== true);
  if (floodStays && r.waived_line_types.includes("flood")) { kept.push("flood"); keptReasons.push("FLOOD_MANDATORY"); }
  steps.flood = { sfha: r.sfha, line_stays_escrowed: floodStays };
  const miDenied = miMonthly && (r.scope === "full" || r.waived_line_types.includes("mi_borrower_paid"));
  const allReasons: OrigDenialReason[] = [...reasons, ...(miDenied ? (["MI_MONTHLY"] as OrigDenialReason[]) : [])];
  const denied = allReasons.length > 0;
  const decision: OriginationWaiverDecision["decision"] = denied ? "denied" : kept.length ? "partial" : "approved";
  const worksheet = { basis: "Selling Guide B2-1.5-04 (04/01/2020); 12 CFR 1026.35(b)(1); 12 CFR 22.5; partner written escrow-waiver policy", policy_version: policy.version, steps, decision, reasons: allReasons, lines_kept: kept, requested_on: r.requested_on, waiver_id: r.waiver_id, scope: r.scope };
  return { decision, reasons: allReasons, lines_kept: kept, kept_reasons: keptReasons, policy_version: policy.version, pricing_adjustment_bps: policy.pricing_adjustment_bps, worksheet, decision_due_on: addBusinessDays(r.requested_on, WAIVER_DECISION_CREDITOR_BD, creditor), policy_exception_needed: policyFails.length > 0 && reasons.length === policyFails.length && !miDenied };
}
export interface RecordedWaiver { readonly decision: OriginationWaiverDecision; readonly requested: DomainEvent; readonly evaluating: DomainEvent; readonly decided: DomainEvent; readonly worksheet_document_id: string; readonly le_revision: { changed_circumstance: "borrower_request"; process: "21.5"; escrow_waiver_fee_cents: Cents; escrowed: false; property_costs_year1_cents: Cents } | null; readonly lines_after: readonly EscrowLine30[]; }
/**
 * The origination waiver case on the bus: `escrow.waiver.requested{origin=origination}` (SM_ESCROW_WAIVER_DECISION_ORIG_3BD from the request date;
 * FNMA_B2_1_5_04_REFI_TAX_FINANCING_GATE), 3.8's `escrow.waiver.evaluating` with the gate inputs (`borrower_paid_mi_monthly` arms the servicing
 * FNMA_B101_MI_MONTHLY_ESCROW_GATE), and `escrow.waiver.decided` with the reasons, the retained decision worksheet (B2-1.5-04 "basis")
 * and — on approval — the 21.5 revised-LE request ("Escrow Waiver Fee" from `pricing_adjustment_bps`, default $0). Approved: the
 * account is `waived` and `escrow_lines` stay inactive for 3.7 monitoring; denied: the LE is unchanged.
 */
export function recordOriginationWaiver(events: EventStore, r: OriginationWaiverRequest, o: { decided_on: PlainDate; lines: readonly EscrowLine30[]; actor?: Actor; officer_exception?: { approved_by: Actor; rationale: string } | null }): RecordedWaiver {
  const actor = o.actor ?? ESCROW_AGENT; need(isDate(o.decided_on) && o.decided_on >= r.requested_on, "decided_on must be an ISO date on/after the request");
  let d = evaluateOriginationWaiver(r);
  if (o.officer_exception) { need(o.officer_exception.approved_by.kind === "human" && o.officer_exception.approved_by.role === "officer", "a waiver outside the partner's written policy is an officer decision"); need(d.policy_exception_needed, "an officer exception applies only to partner-policy failures — law and Fannie Mae refusals are not waivable"); d = { ...d, decision: d.lines_kept.length ? "partial" : "approved", reasons: [], worksheet: { ...d.worksheet, officer_exception: { by: o.officer_exception.approved_by.id, rationale: o.officer_exception.rationale } } }; }
  const requested = events.append({ type: "escrow.waiver.requested", ...keys(r), actor, payload: { waiver_id: r.waiver_id, origin: "origination", requested_on: r.requested_on, channel: r.channel, scope: r.scope, waived_line_types: [...r.waived_line_types], state: r.state, hpml: r.is_hpml, transaction_type: r.transaction_type, taxes_financed_in_loan: r.taxes_financed_in_loan, mi_premium_plan: r.mi_premium_plan, ltv_pct: r.ltv_pct, decision_due_on: d.decision_due_on, sla_timer: "SM_ESCROW_WAIVER_DECISION_ORIG_3BD", solicited: false } });
  const evaluating = events.append({ type: "escrow.waiver.evaluating", ...keys(r), actor, causationId: requested.id, payload: { waiver_id: r.waiver_id, evaluated_on: o.decided_on, requested_on: r.requested_on, waived_line_types: [...r.waived_line_types], hpml_flag: r.is_hpml, consummation_date: r.consummation_date ?? null, flood_escrow_mandatory: r.sfha && r.flood_election_written !== true, flood_line: r.waived_line_types.includes("flood") || r.sfha, borrower_paid_mi_monthly: r.mi_premium_plan === "bpmi_monthly", mi_line: r.mi_premium_plan === "bpmi_monthly", state: r.state, engine_decision: d.decision, reasons: d.reasons, lines_kept: d.lines_kept, policy_version: d.policy_version } });
  const worksheetId = `doc:escrow-waiver-worksheet:${r.waiver_id}`;
  const approved = d.decision !== "denied";
  const le_revision = approved ? { changed_circumstance: "borrower_request" as const, process: "21.5" as const, escrow_waiver_fee_cents: (r.loan_amount_cents * BigInt(d.pricing_adjustment_bps)) / 10_000n, escrowed: false as const, property_costs_year1_cents: r.annual_ti_cents } : null;
  const decided = events.append({ type: "escrow.waiver.decided", ...keys(r), actor, causationId: evaluating.id, payload: { waiver_id: r.waiver_id, origin: "origination", decision: d.decision, decided_on: o.decided_on, reasons: d.reasons, lines_kept: d.lines_kept, kept_reasons: d.kept_reasons, policy_version: d.policy_version, pricing_adjustment_bps: d.pricing_adjustment_bps, basis_document_id: worksheetId, effective_on: approved ? r.consummation_date ?? null : null, state_right_applied: false,
    le_revision: le_revision ? { ...le_revision, escrow_waiver_fee_cents: S(le_revision.escrow_waiver_fee_cents), property_costs_year1_cents: S(le_revision.property_costs_year1_cents), line_label: "Escrow Waiver Fee" } : null, le_unchanged: !approved, notice: "NTC_SM_ESCROW_WAIVER_DECISION", human_review_path: !approved, basis: "B2-1.5-04; 12 CFR 1026.35(b)(1); 12 CFR 22.5; partner written policy" } });
  const lines_after = o.lines.map((l) => ({ ...l, active: approved ? d.lines_kept.includes(l.line_type) : l.active }));
  return { decision: d, requested, evaluating, decided, worksheet_document_id: worksheetId, le_revision, lines_after };
}

// ============================================================ rule 8: same-servicer refinance escrow transfer (§1024.34(b)(2))
export interface CreditAgreementEvidence { readonly kind: "recorded_call" | "portal_esign" | "written"; readonly recorded_call_id?: string | null; readonly scripted_agreement_language_used?: boolean; readonly document_id?: string | null; }
export interface CreditAgreementInput { readonly old_loan_id: string; readonly new_application_id: string; readonly borrower_id: string; readonly evidence: CreditAgreementEvidence; readonly captured_on: PlainDate; readonly settlement_date: PlainDate; readonly actor?: Actor; }
export interface CreditConsent { readonly id: string; readonly kind: "escrow_credit_to_new_loan"; readonly old_loan_id: string; readonly new_application_id: string; readonly borrower_id: string; readonly captured_at: PlainDate; readonly evidence: CreditAgreementEvidence; readonly provenance: "supermortgage"; readonly verified: true; readonly event: DomainEvent; }
/** Comment 34(b)(2)-2: oral or written — but a spoken "yes" counts only on a recorded call using the scripted agreement language; captured on/before the new loan's settlement date. */
export function recordCreditAgreement(events: EventStore, i: CreditAgreementInput): CreditConsent {
  need(!!i.old_loan_id && !!i.new_application_id && !!i.borrower_id, "old_loan_id, new_application_id and borrower_id are required");
  need(isDate(i.captured_on) && isDate(i.settlement_date), "captured_on and settlement_date must be ISO dates");
  need(i.captured_on <= i.settlement_date, `§1024.34(b)(2): the agreement must be captured on or before the new loan's settlement date (${i.captured_on} > ${i.settlement_date})`);
  const ev = i.evidence; need(!!ev && ["recorded_call", "portal_esign", "written"].includes(ev.kind), "evidence kind must be recorded_call, portal_esign or written");
  if (ev.kind === "recorded_call") need(!!ev.recorded_call_id && ev.scripted_agreement_language_used === true, "a spoken agreement counts only when the call is recorded and the scripted agreement language was used (comment 34(b)(2)-2; agent guardrail)");
  else need(!!ev.document_id, `${ev.kind} evidence needs the document id`);
  const id = `consent:escrow_credit_to_new_loan:${i.old_loan_id}:${i.new_application_id}`;
  const event = events.append({ type: "consent.captured", loanId: i.old_loan_id, applicationId: i.new_application_id, actor: i.actor ?? ESCROW_AGENT, payload: { consent_id: id, kind: "escrow_credit_to_new_loan", borrower_id: i.borrower_id, old_loan_id: i.old_loan_id, new_application_id: i.new_application_id, captured_at: i.captured_on, settlement_date: i.settlement_date, evidence: { ...ev }, provenance: "supermortgage", verified: true, rule_ref: "§1024.34(b)(2); comment 34(b)(2)-2" } });
  return { id, kind: "escrow_credit_to_new_loan", old_loan_id: i.old_loan_id, new_application_id: i.new_application_id, borrower_id: i.borrower_id, captured_at: i.captured_on, evidence: ev, provenance: "supermortgage", verified: true, event };
}
/** REGX_1024_34B_SAME_SERVICER_CREDIT_AGREEMENT_GATE facts: an `escrow_credit_to_new_loan` consent captured ≤ the new settlement date. */
export function creditAgreementGateFacts(consent: Pick<CreditConsent, "kind" | "captured_at"> | null, settlementDate: PlainDate): Record<string, unknown> {
  return { consent_present: consent?.kind === "escrow_credit_to_new_loan", captured_at: consent?.captured_at ?? null, settlement_date: settlementDate, captured_by_settlement: !!consent && consent.captured_at <= settlementDate };
}
export interface CreditTransferInput { readonly old_loan_id: string; readonly new_loan_id: string; readonly new_application_id: string; readonly consent: CreditConsent | null; readonly payoff_date: PlainDate; readonly settlement_date: PlainDate; readonly old_balance_after_final_disbursements_cents: Cents; readonly target_at_start_cents: Cents; readonly fnma_ti_account_id?: string; readonly custodial_ti_prepurchase_id?: string; readonly actor?: Actor; }   // custodial_ti_prepurchase_id: the servicer's pre-purchase T&I custodial account row (32.11 same-servicer funding on the Postgres ledger; default the named account)
export interface EscrowCreditTransfer { readonly id: string; readonly old_loan_id: string; readonly new_loan_id: string; readonly agreement_consent_id: string; readonly old_balance_after_final_disbursements_cents: Cents; readonly credited_cents: Cents; readonly refunded_remainder_cents: Cents; readonly posted_at: PlainDate; readonly ledger_entry_ids: readonly string[]; readonly cd_line_reference: string; readonly borrower_closing_escrow_funds_cents: Cents; readonly refund_check_issued: false; readonly events: { posted: DomainEvent; disbursement: DomainEvent }; }
/**
 * At payoff of the prior loan (funding date, dry state): the remaining balance B is credited to the new loan's escrow as of settlement —
 * Dr old-loan `escrow` B / Cr new-loan `escrow` B — with cash moved from the Fannie Mae T&I account (F-1-03 "remove funds due borrowers")
 * to `custodial_ti_prepurchase`; the borrower's closing cash for escrow is `target_at_start − B`; any excess over the deposit is refunded
 * under (b)(1); no refund check is issued. Without the agreement the gate refuses and 3.5's 20-day refund runs.
 */
export function postCreditTransfer(events: EventStore, ledger: Ledger, i: CreditTransferInput): EscrowCreditTransfer {
  need(!!i.old_loan_id && !!i.new_loan_id && !!i.new_application_id, "old_loan_id, new_loan_id and new_application_id are required");
  need(isDate(i.payoff_date) && isDate(i.settlement_date), "payoff_date and settlement_date must be ISO dates");
  const facts = creditAgreementGateFacts(i.consent, i.settlement_date);
  need(facts.consent_present === true && facts.captured_by_settlement === true, "REGX_1024_34B_SAME_SERVICER_CREDIT_AGREEMENT_GATE: no escrow_credit_to_new_loan agreement captured by the new loan's settlement date — no credit; 3.5's REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD refund applies");
  need(i.old_balance_after_final_disbursements_cents > 0n, "nothing to credit: the prior escrow balance after final disbursements is not positive");
  const B = i.old_balance_after_final_disbursements_cents; const credited = B < i.target_at_start_cents ? B : i.target_at_start_cents; const remainder = B - credited;
  const actor = i.actor ?? ESCROW_AGENT; const fnmaTi = i.fnma_ti_account_id ?? FNMA_TI_ACCOUNT_DEFAULT; const prepurchaseTi = i.custodial_ti_prepurchase_id ?? CUSTODIAL_TI_PREPURCHASE;
  const set1 = ledger.post({ effectiveDate: i.settlement_date, description: `escrow credit to new loan ${i.new_loan_id} from ${i.old_loan_id} (§1024.34(b)(2))`, lines: [
    { account: { scope: "loan", loanId: i.old_loan_id, account: "escrow" }, amountCents: credited, ruleRef: "30.3 rule 8: Dr old-loan escrow (balance credited to the new loan)" },
    { account: { scope: "loan", loanId: i.new_loan_id, account: "escrow" }, amountCents: -credited, ruleRef: "30.3 rule 8: Cr new-loan escrow (credit as of settlement)" }] });
  const set2 = ledger.post({ effectiveDate: i.payoff_date, description: `T&I cash: Fannie Mae ${fnmaTi} → ${CUSTODIAL_TI_PREPURCHASE} (funds due borrower, F-1-03)`, lines: [
    { account: { scope: "custodial", custodialAccountId: prepurchaseTi, account: "custodial_ti_cash" }, amountCents: credited, ruleRef: "30.3 rule 8: Dr custodial_ti_prepurchase" },
    { account: { scope: "custodial", custodialAccountId: fnmaTi, account: "custodial_ti_cash" }, amountCents: -credited, ruleRef: "30.3 rule 8: Cr Fannie Mae T&I (authorized withdrawal: funds due borrower)" }] });
  const id = `ect:${i.old_loan_id}:${i.new_loan_id}`; const ledgerIds = [set1.id, set2.id];
  const posted = events.append({ type: "escrow.credit_to_new_loan.posted", loanId: i.old_loan_id, applicationId: i.new_application_id, actor, causationId: i.consent!.event.id, payload: { transfer_id: id, new_loan_id: i.new_loan_id, new_application_id: i.new_application_id, amount_cents: S(credited), posts_on: i.settlement_date, payoff_date: i.payoff_date, consent_id: i.consent!.id, old_balance_after_final_disbursements_cents: S(B), refunded_remainder_cents: S(remainder), ledger_entry_ids: ledgerIds, cash_from: fnmaTi, cash_to: CUSTODIAL_TI_PREPURCHASE, rule_ref: "§1024.34(b)(2); comment 34(b)(1)-1 for any excess" } });
  const disbursement = events.append({ type: "disbursement.issued", loanId: i.old_loan_id, applicationId: i.new_application_id, actor, causationId: posted.id, payload: { kind: "payoff_refund", method: "credit_to_new_loan", amount_cents: S(credited), payee_kind: "borrower", issued_on: i.settlement_date, new_loan_id: i.new_loan_id, check_issued: false } });
  return { id, old_loan_id: i.old_loan_id, new_loan_id: i.new_loan_id, agreement_consent_id: i.consent!.id, old_balance_after_final_disbursements_cents: B, credited_cents: credited, refunded_remainder_cents: remainder, posted_at: i.settlement_date, ledger_entry_ids: ledgerIds, cd_line_reference: "CD §L: credit for prior escrow balance (25.2 open question 5)", borrower_closing_escrow_funds_cents: i.target_at_start_cents - credited, refund_check_issued: false, events: { posted, disbursement } };
}
/** Prior balance after 3.7 pays what is due before payoff (fixture: $2,010.40 − the $400.00 hazard installment paid Nov 10 = $1,610.40). */
export function priorBalanceAfterFinalDisbursements(balanceCents: Cents, paidBeforePayoff: readonly { amount_cents: Cents; paid_on: PlainDate }[], payoffDate: PlainDate): Cents {
  return balanceCents - paidBeforePayoff.filter((d) => d.paid_on <= payoffDate).reduce((s, d) => s + d.amount_cents, 0n);
}
/** No agreement: 3.5's §1024.34(b)(1) refund of the full balance within 20 days (excluding Saturdays, Sundays and legal public holidays) of payoff; the closing collects the full deposit. */
export function noAgreementRefund(i: { payoff_date: PlainDate; old_balance_after_final_disbursements_cents: Cents; target_at_start_cents: Cents }): { refund_cents: Cents; due_on: PlainDate; closing_collects_cents: Cents; timer: "REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD"; credit_posted: false } {
  need(isDate(i.payoff_date), "payoff_date must be an ISO date");
  return { refund_cents: i.old_balance_after_final_disbursements_cents, due_on: payoffRefundDue(i.payoff_date), closing_collects_cents: i.target_at_start_cents, timer: "REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD", credit_posted: false };
}
/** 16.2's `payoff.funds.received` on the prior loan (the credit-agreement gate's trigger) — the funding-day payoff of a same-servicer refinance. */
export function payoffFundsReceived(events: EventStore, oldLoanId: string): DomainEvent | null { return events.ofType("payoff.funds.received").filter((e) => e.loanId === oldLoanId).at(-1) ?? null; }

// ============================================================ purchase: 30.1's Escrow Setup event (LL-2026-05) from the T&I balance
/** 30.1's `loan.purchased{purchase_date}` for the loan. */
export function purchasedOn(events: EventStore, loanId: string): PlainDate | null { const e = events.ofType("loan.purchased").filter((x) => x.loanId === loanId).at(-1); const d = e ? p(e).purchase_date : null; return isDate(d) ? d : null; }
export interface SetupEventInput { readonly loan_id: string; readonly purchase_date: PlainDate; readonly ti_balance_cents: Cents; readonly flag_on: boolean; readonly now: string; readonly actor?: Actor; }
/** Sequence 1 of the loan's T&I event chain (3.7 rule 12: the Setup event precedes the first deposit event); deadline next Fannie Mae business day 03:00 ET; queued to 30.1 (`escrow.setup_event.queued`). */
export function queueEscrowSetupAtPurchase(events: EventStore, i: SetupEventInput): { queued: boolean; sequence: number | null; balance_cents: Cents; deadline_at: string | null; events: DomainEvent[] } {
  need(!!i.loan_id && isDate(i.purchase_date), "loan_id and purchase_date are required");
  need(typeof i.ti_balance_cents === "bigint" && i.ti_balance_cents >= 0n, "the T&I balance must be a non-negative bigint");
  if (!i.flag_on) return { queued: false, sequence: null, balance_cents: i.ti_balance_cents, deadline_at: null, events: [] };
  const chain = chainState(events, i.loan_id, "taxes_insurance"); need(chain.sequence === 0, `loan ${i.loan_id} already has a T&I event chain (sequence ${chain.sequence})`);
  const sequence = 1; const deadline = toIso(zonedEpochMs(addBusinessDays(i.purchase_date, 1, fannieEt), "03:00", ET)); const actor = i.actor ?? ESCROW_AGENT;
  const payload = { event_id: `ES-${i.loan_id}-taxes_insurance`, category: "taxes_insurance", item_type: ITEM_TYPE.setup, sequence, amount_cents: S(i.ti_balance_cents), balance_cents: S(i.ti_balance_cents), processed_on: i.purchase_date, deadline_at: deadline, period_key: periodKeyOf(i.purchase_date), before_first_deposit: true, status: "sent", source: "origination", timer: "LL_2026_05_ESCROW_SETUP_ORIG_PURCHASE_BD1" };
  const sent = events.append({ type: "escrow.setup_event.sent", loanId: i.loan_id, actor, occurredAt: i.now, payload });
  const queued = events.append({ type: "escrow.setup_event.queued", loanId: i.loan_id, actor, occurredAt: i.now, causationId: sent.id, payload: { ...payload, to: "30.1 investor-reporting" } });
  return { queued: true, sequence, balance_cents: i.ti_balance_cents, deadline_at: deadline, events: [sent, queued] };
}

/** The 3.1 `biweekly` variant: 26 periods with per-period escrow round_half_up(annual/26); the cushion stays 1/6 of annual (§1024.17(a) "modified accordingly"). */
export function biweeklyProjection(lines: readonly EscrowLine30[], yearStart: PlainDate, c: CushionInputs = { policy_months: POLICY_CUSHION_MONTHS }): Projection {
  const items = projectLines(toLineInputs(lines, yearStart), yearStart, { as_of: yearStart }).items;
  return project(items, yearStart, c, { biweekly: true });
}
export { ymd };
