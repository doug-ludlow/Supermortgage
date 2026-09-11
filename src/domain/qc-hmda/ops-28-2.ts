/**
 * §28.2 post-closing QC — pure rule functions and the event-store writes behind them (one small function per rule /
 * T-id). The monthly cycle (D1-3-01: population by month of disbursement, the 90-day cycle from month-end, random 10 % /
 * statistical sample, discretionary targeting, arrears notice), the review scope engine (D1-3-02/-03 exemptions),
 * liability reconciliation, occupancy and collateral assessment, the shadow re-underwrite, findings and the rebuttal
 * window, defect rates and the monthly report (D1-1-03), the partner's 10 % vendor re-review (D1-1-02), Loan Quality
 * Connect cases (D2-1: file requests, NOPDs, Resolution Requests — portal-only, operator-confirmed), the remedies ladder
 * (A2-3.2-01/-03: payment 60, appeal 60/60/15/60/15/30/15/30/15, repurchase price with LLPAs excluded), the QC-defect and
 * compliance-with-laws self-reports (D1-1-01, A3-2-01), and the 36-payment relief tracker (A2-3.2-02) confirmed only from
 * Fannie Mae's report.
 *
 * Reuse (one product, one id grammar): servicing 18.x owns the `qc_*` tables and the review/finding event names
 * (`qc.review.selected/opened/closed`, `qc.finding.released/rebutted`, `qc.report.issued`, `qc.reverification.*`); 30.4
 * raises `epd.flag.raised{definition=sm_qc_p1_6_60}` (consumed here through its `qcSelectionFromEpd`); 29.4 emits
 * `loan.purchased` and `rep_warrant_relief.delivered/confirmed/lost`; 23.3 opens the `payment_history_36` ledger row and
 * `RELIEF_36TH_PAYMENT` (29.4) is the 36th due date; 27.1's `completeRepurchase` repays the warehouse advance on a
 * partner repurchase (`warehouse.advance.repaid{repaid_from=partner_repurchase}`); 28.4 owns fraud/SAR — a review that
 * reveals misrepresentation emits `qc.fraud.referred` for the `bsa_officer` and 28.4's `fnma.fraud.reasonable_basis` /
 * `fnma.fraud.report.submitted` run the A3-4-03 clock, never this process.
 *
 * Events appended here (timer subject in brackets — every 28.2 row is an origination row, so each event carries
 * `applicationId` or `payload.source = "origination"`; src/kernel/timers/engine.ts isOriginationContext):
 *   schedule.tick{cadence, job∈{qc_post_closing_select, qc_post_closing_report, qc_epd_monitor, qc_target_rate}, source=origination}  [global]
 *   qc.cycle.planned{cycle_id, production_month, production_month_end, cycle_due_on, population}     [qc_cycle — arms FNMA_D1_3_QC_CYCLE_90]
 *   qc.cycle.selected{random_count, discretionary_count, select_by}                                   [qc_cycle — satisfies FNMA_D1_3_01_QC_SELECT_MONTHLY]
 *   qc.cycle.completed{completed_on, vendor_review_clock_from, on_time}                               [qc_cycle — satisfies the 90-day row; arms the vendor-review row]
 *   qc.cycle.in_arrears{cycle_due_on, arrears_notice_due_on}                                          [qc_cycle — arms FNMA_D1_3_01_QC_ARREARS_NOTICE]
 *   qc.arrears_notice.sent{sent_by_role=officer, arrears_notice_sent_at}                              [qc_cycle — satisfies it]
 *   qc.review.selected{review_id, kind, selection_basis, selected_at}                                 [loan — arms SM_QC_POST_CLOSING_REVIEW_SLA_45]
 *   qc.review.closed{review_completed_at, outcome, eligible_as_delivered, confirmed_by_role, confirmed_on}  [loan — satisfies it; `eligible_as_delivered=false` by the qc_officer arms FNMA_D1_1_01_QC_SELF_REPORT_30]
 *   qc.review.reunderwrite_required · qc.reverification.requested/received (28.1's) · qc.finding.drafted · qc.finding.released{released_at, rebuttal_due_on}  [loan — arms SM_QC_REBUTTAL_WINDOW_10]
 *   qc.finding.rebutted{outcome, final_severity}                                                      [loan — satisfies it]
 *   qc.epd_selections.created{month_end, count}                                                       [global — satisfies SM_QC_EPD_MONITOR_MONTHLY]
 *   qc.report.issued{kind∈{post_closing_monthly, post_closing_quarterly, vendor_review_monthly}, …}   [satisfies the three D1-1 reporting rows]
 *   qc.self_report.drafted/approved/submitted{report_type, lqc_reference, submitted_by_role}          [loan — `submitted` satisfies the self-report rows]
 *   compliance.breach.confirmed{fnma_reporting_category, self_report_clock_from}                      [compliance_breach — arms FNMA_A3_2_01_COMPLIANCE_SELF_REPORT_60]
 *   fnma.qc.case.opened{case_type, notified_at, notified_on, due_on} · fnma.qc.package.ready{package_hash} · fnma.qc.package.submitted{case_type, submitted_by_role, lqc_reference} · fnma.qc.case.resolved · fnma.qc.case.closed  [loan]
 *   remedy.demand.received{demand_received_on, payment_due_on, appeal_1_due_on} · remedy.appeal.filed{stage, filed_on, new_information} · remedy.appeal.responded{stage, outcome, notified_on}
 *   remedy.impasse.declared{declared_on} · remedy.impasse.concluded{outcome, concluded_on} · remedy.management_escalation.filed · remedy.management_escalation.decided{notified_on} · remedy.idr.initiated · remedy.paid{paid_by_role=officer}  [loan]
 *   rep_warrant_relief.confirmed{relief_basis, fnma_report_id} (29.4's name) · rep_warrant_relief.lost · qc.fraud.referred  [loan]
 */
import { createHash } from "node:crypto";
import { type PlainDate, plainDate as D, addDays, addMonths, endOfMonth, startOfMonth, parts, ymd, daysBetween, daysInMonth } from "../../kernel/calendar/date.ts";
import { addBusinessDays, rollBack, creditor, type Calendar } from "../../kernel/calendar/business.ts";
import type { Actor, DomainEvent, EventInput, EventStore } from "../../kernel/events/index.ts";
import { type Cents, ratePercent } from "../../kernel/money/cents.ts";
import { Decimal } from "../../kernel/money/decimal.ts";
import { hasRole } from "../../app/roles.ts";
import { seededDraw } from "../qc-audit/sampling.ts";
import { qcSelectionFromEpd } from "../orig-boarding/ops-30-4.ts";
import { RELIEF_36TH_PAYMENT } from "../secondary/ops-29-4.ts";
import { completeRepurchase, type AdvanceRecord } from "../warehouse/ops-27-1.ts";

export const RULE_SET_28_2 = "fnma.qc.post_closing.v1";
export const TAXONOMY_28_2 = "fnma.qc.taxonomy.v1";
const AGENT: Actor = { kind: "agent", id: "qc-audit" };
const SCHEDULER: Actor = { kind: "system", id: "qc-scheduler" };
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const need = (ok: boolean, msg: string): void => { if (!ok) throw new RangeError(msg); };
const nonEmpty = (v: unknown, what: string): string => { if (typeof v !== "string" || !v.trim()) throw new RangeError(`${what} is required`); return v; };
const isDate = (v: unknown): v is PlainDate => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
/** Noon Eastern on a civil date — the instant a dated act is stamped with when only its date is known. */
export const noonEt = (d: PlainDate): string => `${d}T17:00:00.000Z`;
/** A refusal a rule makes on its own authority (role, sequence, evidence) — a RangeError with a code the console shows. */
export class QcRefusal extends RangeError { readonly code: string; constructor(code: string, message: string) { super(`${code}: ${message}`); this.name = "QcRefusal"; this.code = code; } }
const requireRole = (actor: Actor, roles: readonly string[], code: string, what: string): void => { if (!hasRole(actor, roles)) throw new QcRefusal(code, `${what} requires ${roles.join("/")}; actor is ${actor.kind}:${actor.id}${actor.role ? ` (${actor.role})` : ""}`); };
const pct1 = (num: number, den: number): string => (den === 0 ? "0.0" : Decimal.ratio(BigInt(Math.round(num * 1000)), BigInt(den * 10)).toFixed(1));

// ============================================================ subjects and event helpers
export interface LoanCtx { readonly loan_id: string; readonly application_id: string; }
const loanEvent = (events: EventStore, c: LoanCtx, type: string, payload: Record<string, unknown>, at: string, actor: Actor = AGENT): DomainEvent =>
  events.append({ type, loanId: c.loan_id, applicationId: c.application_id, actor, occurredAt: at, payload: { ...payload, loan_id: c.loan_id, application_id: c.application_id } });
const cycleEvent = (events: EventStore, cycle_id: string, type: string, payload: Record<string, unknown>, at: string, actor: Actor = AGENT): DomainEvent =>
  events.append({ type, aggregate: { kind: "qc_cycle", id: cycle_id }, actor, occurredAt: at, payload: { ...payload, cycle_id, source: "origination" } });

// ============================================================ rule 1: population and the 90-day cycle (D1-3-01)
export const CYCLE_DAYS = 90;
export const ARREARS_CYCLE_DAYS = 30;
export const SELECTION_POLICY_DAY = 10;
export type ProductionMonth = string;   // "YYYY-MM"
export const productionMonthOf = (d: PlainDate): ProductionMonth => d.slice(0, 7);
export function monthBounds(pm: ProductionMonth): { start: PlainDate; end: PlainDate } {
  need(/^\d{4}-\d{2}$/.test(pm), `production_month ${pm} must be YYYY-MM`);
  const start = D(`${pm}-01`); return { start, end: endOfMonth(start) };
}
/** `cycle_due_on = last_day(M) + 90 calendar days` (D1-3-01 "within 90 days from the month of the disbursement date"). */
export const cycleDueOn = (pm: ProductionMonth): PlainDate => addDays(monthBounds(pm).end, CYCLE_DAYS);
/** Policy: a Fannie Mae date on a weekend/holiday is met on the prior business day, never the next; internal targets sit two calendar days before the due date, rolled back to a creditor business day (Jan 15 → Wed Jan 13; Sun Feb 28 → Fri Feb 26). */
export const policySubmitBy = (due: PlainDate, cal: Calendar = creditor): PlainDate => rollBack(addDays(due, -2), cal);
export const cycleReportScheduledOn = (pm: ProductionMonth, cal: Calendar = creditor): PlainDate => policySubmitBy(cycleDueOn(pm), cal);
export function firstBusinessDayOfMonth(y: number, m: number, cal: Calendar = creditor): PlainDate { let d = ymd(y, m, 1); while (!cal.isBusinessDay(d)) d = addDays(d, 1); return d; }
export const isFirstBusinessDayOfMonth = (d: PlainDate, cal: Calendar = creditor): boolean => { const p = parts(d); return firstBusinessDayOfMonth(p.y, p.m, cal) === d; };
export const selectionDueOn = (pm: ProductionMonth): PlainDate => { const n = parts(addMonths(monthBounds(pm).start, 1)); return ymd(n.y, n.m, SELECTION_POLICY_DAY); };

export type Transaction = "purchase" | "lcor" | "cash_out";
export type Occupancy = "primary" | "second_home" | "investment";
export interface FundedLoan {
  readonly loan_id: string; readonly application_id: string; readonly fnma_loan_number: string | null;
  readonly disbursement_date: PlainDate; readonly consummation_date: PlainDate | null; readonly purchase_date?: PlainDate | null;
  readonly product: string; readonly transaction: Transaction; readonly occupancy: Occupancy; readonly channel: string;
  readonly units?: number; readonly manufactured?: boolean; readonly tx_50a6?: boolean;
}
export type CycleStatus = "planned" | "selected" | "in_review" | "rebuttal" | "reported" | "in_arrears";
export interface QcCycle {
  readonly cycle_id: string; readonly kind: "monthly"; readonly partner_id: string; readonly production_month: ProductionMonth;
  readonly period_start: PlainDate; readonly period_end: PlainDate; readonly population: number; readonly population_hash: string;
  readonly random_method: RandomMethod; readonly random_target: number; readonly statistical_params: StatisticalParams | null; readonly discretionary_count: number;
  readonly frozen_on: PlainDate; readonly selected_at: PlainDate | null; readonly cycle_due_on: PlainDate; readonly report_scheduled_on: PlainDate;
  readonly reviews_completed_at: PlainDate | null; readonly rebuttals_closed_at: PlainDate | null; readonly report_issued_at: PlainDate | null;
  readonly status: CycleStatus; readonly arrears_notice_sent_at: PlainDate | null;
}
/** Loans whose `fundings.disbursement_date` falls in M — a loan consummated Nov 30 and disbursed Dec 3 belongs to December. */
export function populationFor(pm: ProductionMonth, loans: readonly FundedLoan[]): FundedLoan[] {
  const { start, end } = monthBounds(pm);
  return loans.filter((l) => l.disbursement_date >= start && l.disbursement_date <= end);
}
export interface BuildPopulationInput { readonly partner_id: string; readonly production_month: ProductionMonth; readonly loans: readonly FundedLoan[]; readonly frozen_on: PlainDate; readonly random_method?: RandomMethod; readonly statistical_params?: StatisticalParams | null; readonly at?: string; readonly cal?: Calendar; }
/** `buildCyclePopulation`: freezes the month's population on the 1st business day of M+1 and appends `qc.cycle.planned` (arms the 90-day clock on `production_month_end`). */
export function buildCyclePopulation(events: EventStore, i: BuildPopulationInput): { cycle: QcCycle; population: FundedLoan[]; event: DomainEvent } {
  nonEmpty(i.partner_id, "partner_id"); need(isDate(i.frozen_on), "frozen_on must be a PlainDate");
  const { start, end } = monthBounds(i.production_month);
  need(i.frozen_on > end, `the population of ${i.production_month} is frozen after the month ends (${i.frozen_on} ≤ ${end})`);
  const population = populationFor(i.production_month, i.loans);
  const method = i.random_method ?? "ten_percent";
  const target = randomTarget(population.length, method, i.statistical_params ?? null);
  const cycle: QcCycle = { cycle_id: `qcc-${i.partner_id}-${i.production_month}`, kind: "monthly", partner_id: i.partner_id, production_month: i.production_month, period_start: start, period_end: end, population: population.length,
    population_hash: sha256(population.map((l) => l.loan_id).sort().join("\n")), random_method: method, random_target: target, statistical_params: method === "statistical" ? (i.statistical_params ?? null) : null, discretionary_count: 0,
    frozen_on: i.frozen_on, selected_at: null, cycle_due_on: cycleDueOn(i.production_month), report_scheduled_on: cycleReportScheduledOn(i.production_month, i.cal ?? creditor), reviews_completed_at: null, rebuttals_closed_at: null, report_issued_at: null, status: "planned", arrears_notice_sent_at: null };
  const event = cycleEvent(events, cycle.cycle_id, "qc.cycle.planned", { production_month: cycle.production_month, production_month_end: end, cycle_due_on: cycle.cycle_due_on, population: cycle.population, population_hash: cycle.population_hash, frozen_on: i.frozen_on, random_method: method, random_target: target, select_by: selectionDueOn(i.production_month) }, i.at ?? noonEt(i.frozen_on));
  return { cycle, population, event };
}

// ============================================================ rule 2: random sample (10 % or statistical)
export type RandomMethod = "ten_percent" | "statistical";
export interface StatisticalParams { readonly confidence: number; readonly precision: number; readonly statement_months: number; readonly expected_defect_rate: number; readonly six_month_population: number; }
export const Z_95 = 1.96;
/** `random_target = ceil(0.10 × population)` (D1-3-01 "a 10% sample of all monthly loan production"). */
export const tenPercentTarget = (population: number): number => Math.ceil(population / 10);
/** `n₀ = z² p(1−p) / e²` then the finite-population correction `n = n₀ / (1 + (n₀ − 1)/N)` over the six-month statement population (95 % / 2 % / six months). */
export function statisticalSample(p: StatisticalParams): { n0: number; n: number; z: number } {
  need(p.confidence === 0.95 && p.precision === 0.02 && p.statement_months === 6, "D1-3-01 statistical sampling: 95% confidence, 2% precision, six-month statement");
  need(p.expected_defect_rate > 0 && p.expected_defect_rate < 1, "expected_defect_rate must be a proportion");
  const n0 = (Z_95 * Z_95 * p.expected_defect_rate * (1 - p.expected_defect_rate)) / (p.precision * p.precision);
  const n = n0 / (1 + (n0 - 1) / p.six_month_population);
  return { n0, n, z: Z_95 };
}
export function randomTarget(population: number, method: RandomMethod, params: StatisticalParams | null): number {
  if (method === "ten_percent") return tenPercentTarget(population);
  need(params !== null, "statistical method needs its parameters (plan-recorded)");
  return Math.min(population, Math.ceil(statisticalSample(params!).n));
}
/** Policy Q1: `ten_percent` until six months of history exist and the plan adopts the statistical method — and only when the statistical sample is the smaller one. */
export function chooseRandomMethod(i: { population: number; history_months: number; plan_adopts_statistical: boolean; params: StatisticalParams | null }): { method: RandomMethod; ten_percent: number; statistical: number | null } {
  const ten = tenPercentTarget(i.population);
  const stat = i.params ? Math.ceil(statisticalSample(i.params).n) : null;
  const method: RandomMethod = i.history_months >= 6 && i.plan_adopts_statistical && stat !== null && stat < ten ? "statistical" : "ten_percent";
  return { method, ten_percent: ten, statistical: stat };
}
export const stratumOf = (l: FundedLoan): string => `${l.product}|${l.transaction}|${l.occupancy}|${l.channel}`;
/** Stratified seeded draw: one loan from every product × transaction × occupancy × channel stratum present, the balance at random ("representative of the lender's overall book of business"). */
export function drawRandomSample(population: readonly FundedLoan[], target: number, seed: number): { selected: FundedLoan[]; strata: Record<string, number>; every_stratum_represented: boolean } {
  const groups = new Map<string, FundedLoan[]>();
  for (const l of population) { const k = stratumOf(l); if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(l); }
  const keys = [...groups.keys()].sort();
  const selected: FundedLoan[] = [];
  const firstRound = target >= keys.length ? keys : seededDraw(keys, target, seed);
  firstRound.forEach((k, idx) => { selected.push(seededDraw(groups.get(k)!, 1, seed + idx + 1)[0]!); });
  const chosen = new Set(selected.map((l) => l.loan_id));
  const rest = population.filter((l) => !chosen.has(l.loan_id));
  for (const l of seededDraw(rest, Math.max(0, target - selected.length), seed)) selected.push(l);
  const strata: Record<string, number> = {}; for (const l of selected) strata[stratumOf(l)] = (strata[stratumOf(l)] ?? 0) + 1;
  return { selected, strata, every_stratum_represented: keys.every((k) => (strata[k] ?? 0) > 0) };
}

// ============================================================ rule 3: discretionary sample
export type DiscretionaryReason = "epd" | "prefunding_finding_sev_le_2" | "fraud_case_open" | "document_integrity_fail" | "occupancy_red_flag" | "fnma_top_defect_focus" | "agent_version_stratum" | "data_revision_29_4" | "high_risk_stratum:cash_out" | "high_risk_stratum:investment" | "high_risk_stratum:2_4_units" | "high_risk_stratum:manufactured" | "high_risk_stratum:tx_50a6";
export interface DiscretionarySignals { readonly epd?: boolean; readonly prefunding_max_severity?: number | null; readonly fraud_case_open?: boolean; readonly document_integrity_fail?: boolean; readonly occupancy_red_flag?: boolean; readonly fnma_top_defect_focus?: boolean; readonly agent_version_stratum?: boolean; readonly data_revision?: boolean; }
export const HIGH_RISK_MIN_PER_STRATUM = 2;
const highRiskStrata = (l: FundedLoan): DiscretionaryReason[] => [
  ...(l.transaction === "cash_out" ? ["high_risk_stratum:cash_out" as const] : []), ...(l.occupancy === "investment" ? ["high_risk_stratum:investment" as const] : []),
  ...((l.units ?? 1) >= 2 ? ["high_risk_stratum:2_4_units" as const] : []), ...(l.manufactured ? ["high_risk_stratum:manufactured" as const] : []), ...(l.tx_50a6 ? ["high_risk_stratum:tx_50a6" as const] : [])];
/** Every signalled loan plus at least two per high-risk stratum where volume exists; loans already drawn at random are never double-counted. Tagged `post_closing_discretionary` — outside the random defect-rate denominator. */
export function selectDiscretionary(population: readonly (FundedLoan & { readonly signals?: DiscretionarySignals })[], i: { readonly exclude: ReadonlySet<string>; readonly seed: number; readonly min_per_stratum?: number }): { loan: FundedLoan; reasons: DiscretionaryReason[] }[] {
  const out = new Map<string, { loan: FundedLoan; reasons: DiscretionaryReason[] }>();
  const add = (l: FundedLoan, r: DiscretionaryReason) => { if (i.exclude.has(l.loan_id)) return; const cur = out.get(l.loan_id) ?? { loan: l, reasons: [] }; if (!cur.reasons.includes(r)) cur.reasons.push(r); out.set(l.loan_id, cur); };
  for (const l of population) {
    const s = l.signals ?? {};
    if (s.epd) add(l, "epd"); if (s.prefunding_max_severity !== null && s.prefunding_max_severity !== undefined && s.prefunding_max_severity <= 2) add(l, "prefunding_finding_sev_le_2");
    if (s.fraud_case_open) add(l, "fraud_case_open"); if (s.document_integrity_fail) add(l, "document_integrity_fail"); if (s.occupancy_red_flag) add(l, "occupancy_red_flag");
    if (s.fnma_top_defect_focus) add(l, "fnma_top_defect_focus"); if (s.agent_version_stratum) add(l, "agent_version_stratum"); if (s.data_revision) add(l, "data_revision_29_4");
  }
  const min = i.min_per_stratum ?? HIGH_RISK_MIN_PER_STRATUM;
  const byStratum = new Map<DiscretionaryReason, FundedLoan[]>();
  for (const l of population) for (const r of highRiskStrata(l)) { if (!byStratum.has(r)) byStratum.set(r, []); byStratum.get(r)!.push(l); }
  let n = 0;
  for (const [r, loans] of [...byStratum].sort(([a], [b]) => a.localeCompare(b))) {
    const already = loans.filter((l) => out.get(l.loan_id)?.reasons.includes(r)).length;
    for (const l of seededDraw(loans.filter((l) => !i.exclude.has(l.loan_id) && !out.has(l.loan_id)), Math.max(0, min - already), i.seed + 100 + n++)) add(l, r);
  }
  return [...out.values()];
}

// ============================================================ reviews (28.1 columns + post-closing additions)
export type ReviewKind = "post_closing_random" | "post_closing_discretionary" | "epd" | "fnma_lqc";
export type ReviewStatus = "selected" | "in_review" | "findings_released" | "reunderwrite" | "closed";
export type DefectClass = "underwriting_eligibility" | "compliance";
export interface QcReview {
  readonly review_id: string; readonly cycle_id: string | null; readonly loan_id: string; readonly application_id: string; readonly kind: ReviewKind; readonly selection_basis: readonly string[];
  readonly selected_at: PlainDate; readonly review_sla_due_on: PlainDate; readonly fnma_loan_number: string | null; readonly disbursement_date: PlainDate | null;
  readonly review_scope: ReviewScope | null; readonly du_validation_components: readonly string[]; readonly close_by_date_met: boolean | null;
  readonly reunderwrite_required: boolean; readonly eligible_as_delivered: boolean | null; readonly self_report_id: string | null; readonly rebuttal_due_at: PlainDate | null;
  readonly initial_severity: number | null; readonly final_severity: number | null; readonly defect_class: DefectClass | null; readonly status: ReviewStatus; readonly review_completed_at: PlainDate | null; readonly outcome: "no_defect" | "defect" | null;
}
export const REVIEW_SLA_DAYS = 45;
const newReview = (l: FundedLoan, cycle_id: string | null, kind: ReviewKind, basis: readonly string[], selected_at: PlainDate): QcReview => ({
  review_id: `qcr-${l.loan_id}-${kind}-${selected_at}`, cycle_id, loan_id: l.loan_id, application_id: l.application_id, kind, selection_basis: basis, selected_at, review_sla_due_on: addDays(selected_at, REVIEW_SLA_DAYS),
  fnma_loan_number: l.fnma_loan_number, disbursement_date: l.disbursement_date, review_scope: null, du_validation_components: [], close_by_date_met: null, reunderwrite_required: false, eligible_as_delivered: null, self_report_id: null,
  rebuttal_due_at: null, initial_severity: null, final_severity: null, defect_class: null, status: "selected", review_completed_at: null, outcome: null });
const reviewSelected = (events: EventStore, r: QcReview, at: string): DomainEvent => loanEvent(events, r, "qc.review.selected", { review_id: r.review_id, cycle_id: r.cycle_id, kind: r.kind, selection_basis: r.selection_basis, selected_at: r.selected_at, review_sla_due_on: r.review_sla_due_on, fnma_loan_number: r.fnma_loan_number, disbursement_date: r.disbursement_date, source: "origination" }, at);
/** The selection step: random and discretionary reviews created, `qc.review.selected` per loan (arms the 45-day SLA) and `qc.cycle.selected` (closes the monthly selection clock; carries next month's `select_by` for the kernel's re-arm). */
export function selectCycle(events: EventStore, cycle: QcCycle, random: readonly FundedLoan[], discretionary: readonly { loan: FundedLoan; reasons: DiscretionaryReason[] }[], i: { readonly selected_on: PlainDate; readonly at?: string }): { cycle: QcCycle; reviews: QcReview[]; events: DomainEvent[] } {
  need(cycle.status === "planned", `cycle ${cycle.cycle_id} is ${cycle.status}; only a planned cycle is selected`);
  need(random.length === cycle.random_target, `random draw ${random.length} ≠ random_target ${cycle.random_target}`);
  const at = i.at ?? noonEt(i.selected_on);
  const reviews: QcReview[] = [...random.map((l) => newReview(l, cycle.cycle_id, "post_closing_random", ["random"], i.selected_on)), ...discretionary.map((d) => newReview(d.loan, cycle.cycle_id, "post_closing_discretionary", d.reasons, i.selected_on))];
  const out = reviews.map((r) => reviewSelected(events, r, at));
  const next = parts(addMonths(cycle.period_start, 2));
  out.push(cycleEvent(events, cycle.cycle_id, "qc.cycle.selected", { random_count: random.length, discretionary_count: discretionary.length, selected_on: i.selected_on, on_time: i.selected_on <= selectionDueOn(cycle.production_month), select_by: ymd(next.y, next.m, SELECTION_POLICY_DAY) }, at));
  return { cycle: { ...cycle, status: "selected", selected_at: i.selected_on, discretionary_count: discretionary.length }, reviews, events: out };
}
/** 30.4's `epd.flag.raised{definition=sm_qc_p1_6_60}` → an immediate discretionary full-file review outside the monthly draw; `qc.epd_selections.created` closes the month-end EPD monitor. */
export function selectEpd(events: EventStore, flags: readonly DomainEvent[], loans: readonly FundedLoan[], i: { readonly month_end: PlainDate; readonly selected_on: PlainDate; readonly at?: string }): { reviews: QcReview[]; event: DomainEvent } {
  need(isDate(i.month_end) && i.month_end === endOfMonth(i.month_end), "month_end must be the month-end snapshot date");
  const at = i.at ?? noonEt(i.selected_on); const reviews: QcReview[] = [];
  for (const f of flags) {
    const sel = qcSelectionFromEpd(f); if (!sel || !f.loanId) continue;
    const loan = loans.find((l) => l.loan_id === f.loanId); need(!!loan, `no funded loan ${f.loanId} for EPD flag ${sel.flag_id}`);
    const r: QcReview = { ...newReview(loan!, null, "epd", ["epd", sel.flag_id], i.selected_on), selection_basis: ["epd", `flag:${sel.flag_id}`, `installment:${sel.installment_no}`] };
    reviews.push(r); reviewSelected(events, r, at);
  }
  const event = events.append({ type: "qc.epd_selections.created", actor: AGENT, occurredAt: at, payload: { month_end: i.month_end, count: reviews.length, review_ids: reviews.map((r) => r.review_id), source: "origination" } });
  return { reviews, event };
}

// ============================================================ rule 4: scope engine (D1-3-02 / D1-3-03 exemptions)
export type VerificationSource = "du_validated" | "approved_vendor_automated" | "manual";
export interface ScopeFacts {
  readonly income_source: VerificationSource; readonly employment_source: VerificationSource; readonly assets_source: VerificationSource;
  readonly relief_conditions_met: boolean; readonly consummation_date: PlainDate; readonly close_by_date: PlainDate | null;
  readonly tax_returns_relied_upon: boolean; readonly tax_years_required?: readonly number[]; readonly preclosing_transcript_years?: readonly number[];
  readonly credit_type: "traditional" | "nontraditional"; readonly cu_score: string | null; readonly units?: number; readonly value_acceptance?: boolean; readonly collateral_assessment_completable?: boolean;
}
export interface ReviewScope {
  readonly income_reverify_required: boolean; readonly employment_reverify_required: boolean; readonly assets_reverify_required: boolean; readonly transcripts_required: boolean; readonly transcripts_reused_from_preclosing: boolean;
  readonly credit_refresh_required: boolean; readonly credit_references_reverify_required: boolean; readonly occupancy_required: true; readonly collateral_assessment_required: true; readonly comps_reverify_required: boolean; readonly desk_or_field_review_ordered: boolean;
  readonly du_validation_components: string[]; readonly close_by_date_met: boolean | null; readonly rationale: string[];
}
export const CU_RELIEF_MAX = "2.5";
export const closeByDateMet = (consummation: PlainDate, closeBy: PlainDate | null): boolean | null => (closeBy === null ? null : consummation <= closeBy);
export function computeScope(f: ScopeFacts): ReviewScope {
  const cbMet = closeByDateMet(f.consummation_date, f.close_by_date);
  const rationale: string[] = []; const du: string[] = [];
  const exempt = (component: string, src: VerificationSource): boolean => {
    if (src === "approved_vendor_automated") { rationale.push(`${component}: automated verification from an approved Fannie Mae vendor — reverification not required (D1-3-03)`); return true; }
    if (src === "du_validated" && f.relief_conditions_met && cbMet === true) { du.push(component); rationale.push(`${component}: DU-validated, relief conditions met, closed ${f.consummation_date} by the Close by Date ${f.close_by_date} — exempt (D1-3-03 DU validation service)`); return true; }
    rationale.push(`${component}: ${src === "du_validated" ? "DU-validated but relief conditions/Close by Date not met" : "manually verified"} — reverify`); return false;
  };
  const income = !exempt("income", f.income_source), employment = !exempt("employment", f.employment_source), assets = !exempt("assets", f.assets_source);
  const yearsReq = f.tax_years_required ?? []; const have = f.preclosing_transcript_years ?? [];
  const reuse = f.tax_returns_relied_upon && yearsReq.length > 0 && yearsReq.every((y) => have.includes(y));
  if (!f.tax_returns_relied_upon) rationale.push("transcripts: no tax returns relied upon in underwriting — no 4506-C order"); else rationale.push(reuse ? `transcripts: pre-closing IRS transcripts cover ${yearsReq.join("/")} — reused, no new order` : "transcripts: tax returns relied upon — 4506-C submission required");
  const comps = !(f.cu_score !== null && Decimal.parse(f.cu_score).cmp(Decimal.parse(CU_RELIEF_MAX)) <= 0 && f.relief_conditions_met) && !f.value_acceptance;
  rationale.push(f.value_acceptance ? "collateral: value acceptance exercised — property eligibility check only, no comparables" : comps ? `collateral: CU ${f.cu_score ?? "unscored"} — comparables reverified` : `collateral: CU ${f.cu_score} ≤ 2.5 with relief conditions met — comparables not reverified (D1-3-03)`);
  rationale.push(f.credit_type === "traditional" ? "credit: new tri-merge (soft, no trended data) with liability reconciliation — always" : "credit: nontraditional — each credit reference reverified");
  const completable = f.collateral_assessment_completable ?? true;
  return { income_reverify_required: income, employment_reverify_required: employment, assets_reverify_required: assets, transcripts_required: f.tax_returns_relied_upon && !reuse, transcripts_reused_from_preclosing: reuse,
    credit_refresh_required: f.credit_type === "traditional", credit_references_reverify_required: f.credit_type === "nontraditional", occupancy_required: true, collateral_assessment_required: true, comps_reverify_required: comps, desk_or_field_review_ordered: !completable,
    du_validation_components: du, close_by_date_met: cbMet, rationale };
}
export function applyScope(events: EventStore, r: QcReview, f: ScopeFacts, at: string): { review: QcReview; scope: ReviewScope; event: DomainEvent } {
  const scope = computeScope(f);
  const review: QcReview = { ...r, review_scope: scope, du_validation_components: scope.du_validation_components, close_by_date_met: scope.close_by_date_met, status: "in_review" };
  const event = loanEvent(events, r, "qc.review.opened", { review_id: r.review_id, kind: r.kind, review_scope: scope, scope_rationale: scope.rationale, rule_set_version: RULE_SET_28_2 }, at);
  return { review, scope, event };
}

// ============================================================ reverifications (28.1's events; QC purpose codes)
export type ReverificationKind = "vvoe" | "written_voe" | "vod" | "transcripts_4506c" | "cbsv" | "gift_donor" | "credit_refresh" | "desk_review" | "field_review" | "occupancy";
export interface Reverification { readonly reverification_id: string; readonly review_id: string; readonly kind: ReverificationKind; readonly source: string; readonly requested_on: PlainDate; readonly received_on: PlainDate | null; readonly result: "consistent" | "variance" | "unable" | null; readonly purpose_code: "qc_post_closing"; readonly fee_cents: Cents; }
export function orderReverification(events: EventStore, r: QcReview, i: { readonly kind: ReverificationKind; readonly source: string; readonly requested_on: PlainDate; readonly fee_cents?: Cents; readonly at?: string }): { reverification: Reverification; event: DomainEvent } {
  nonEmpty(i.source, "source"); need(isDate(i.requested_on), "requested_on must be a PlainDate");
  if (i.kind === "credit_refresh") need(r.review_scope?.credit_refresh_required !== false, "credit refresh is outside the review scope");
  if (i.kind === "transcripts_4506c") need(r.review_scope === null || r.review_scope.transcripts_required, "transcripts are not ordered when no tax returns were relied upon (D1-3-03)");
  const reverification: Reverification = { reverification_id: `rv-${r.review_id}-${i.kind}-${i.requested_on}`, review_id: r.review_id, kind: i.kind, source: i.source, requested_on: i.requested_on, received_on: null, result: null, purpose_code: "qc_post_closing", fee_cents: i.fee_cents ?? 0n };
  const event = loanEvent(events, r, "qc.reverification.requested", { reverification_id: reverification.reverification_id, review_id: r.review_id, kind: i.kind, source: i.source, requested_at: i.requested_on, purpose_code: "qc_post_closing", trended_data: false }, i.at ?? noonEt(i.requested_on));
  return { reverification, event };
}
export function recordReverification(events: EventStore, r: QcReview, rv: Reverification, i: { readonly received_on: PlainDate | null; readonly result: "consistent" | "variance" | "unable"; readonly detail?: string; readonly at?: string }): { reverification: Reverification; event: DomainEvent } {
  need(i.result !== "unable" || i.received_on === null, "an `unable` result documents the request date and that the information was not obtained");
  const reverification: Reverification = { ...rv, received_on: i.received_on, result: i.result };
  const event = loanEvent(events, r, i.result === "unable" ? "qc.reverification.unable" : "qc.reverification.received", { reverification_id: rv.reverification_id, kind: rv.kind, requested_at: rv.requested_on, received_at: i.received_on, result: i.result, detail: i.detail ?? null }, i.at ?? noonEt(i.received_on ?? rv.requested_on));
  return { reverification, event };
}

// ============================================================ rule 5 / T11: liabilities, DU tolerances and the shadow re-underwrite
export interface Tradeline { readonly creditor: string; readonly kind: string; readonly opened_on: PlainDate; readonly balance_cents: Cents; readonly payment_cents: Cents; }
/** B3-2-10 DU tolerance as applied here: the DTI may not rise more than 3 percentage points above the final submission and may never exceed the 50 % DU maximum [policy reading of B3-2-10]. */
export const DU_DTI_TOLERANCE_PP = "3";
export const DU_MAX_DTI_PCT = "50";
export const dtiPct = (debts: Cents, income: Cents): string => (income <= 0n ? "0.0" : Decimal.ratio(debts * 100n, income).toFixed(1));
export interface LiabilityReconciliation { readonly new_tradelines: { tradeline: Tradeline; classification: "post_closing" | "undisclosed_pre_note"; finding: boolean }[]; readonly undisclosed_payment_cents: Cents; readonly dti_before_pct: string; readonly dti_after_pct: string; readonly within_tolerance: boolean; readonly reunderwrite_required: boolean; }
/** A tradeline opened after the note date is post-closing (no finding); one opened before it is undisclosed debt → DTI recomputed against B3-2-10. */
export function reconcileLiabilities(f: { readonly note_date: PlainDate; readonly underwritten_tradelines: readonly Tradeline[]; readonly refreshed_tradelines: readonly Tradeline[]; readonly qualifying_income_monthly_cents: Cents; readonly underwritten_debts_monthly_cents: Cents }): LiabilityReconciliation {
  need(isDate(f.note_date), "note_date must be a PlainDate"); need(f.qualifying_income_monthly_cents > 0n, "qualifying income must be positive");
  const known = new Set(f.underwritten_tradelines.map((t) => `${t.creditor}|${t.kind}|${t.opened_on}`));
  const fresh = f.refreshed_tradelines.filter((t) => !known.has(`${t.creditor}|${t.kind}|${t.opened_on}`));
  const rows = fresh.map((t) => ({ tradeline: t, classification: (t.opened_on > f.note_date ? "post_closing" : "undisclosed_pre_note") as "post_closing" | "undisclosed_pre_note", finding: t.opened_on <= f.note_date }));
  const undisclosed = rows.filter((r) => r.classification === "undisclosed_pre_note").reduce((s, r) => s + r.tradeline.payment_cents, 0n);
  const before = dtiPct(f.underwritten_debts_monthly_cents, f.qualifying_income_monthly_cents), after = dtiPct(f.underwritten_debts_monthly_cents + undisclosed, f.qualifying_income_monthly_cents);
  const within = Decimal.parse(after).sub(Decimal.parse(before)).cmp(Decimal.parse(DU_DTI_TOLERANCE_PP)) <= 0 && Decimal.parse(after).cmp(Decimal.parse(DU_MAX_DTI_PCT)) <= 0;
  return { new_tradelines: rows, undisclosed_payment_cents: undisclosed, dti_before_pct: before, dti_after_pct: after, within_tolerance: within, reunderwrite_required: undisclosed > 0n && !within };
}
export interface IncomeComponent { readonly name: string; readonly monthly_cents: Cents; readonly source: string; }
export interface ShadowReunderwrite { readonly du_shadow_casefile: string; readonly production_touched: false; readonly income_before_cents: Cents; readonly income_after_cents: Cents; readonly dti_before_pct: string; readonly dti_after_pct: string; readonly eligible_as_delivered: boolean; readonly reunderwrite_required: true; readonly variance_pct: string; readonly rationale: string; }
/** Rule 5: a reverification variance beyond DU tolerance → the 23.3 risk assessment re-run in shadow on a QC-purpose casefile copy (23.1) — production records untouched; `eligible_as_delivered` = DTI within the DU maximum. */
export function shadowReunderwrite(f: { readonly review_id: string; readonly income_components: readonly IncomeComponent[]; readonly variance: { component: string; annual_used_cents: Cents; annual_verified_cents: Cents }; readonly monthly_debts_cents: Cents; readonly max_dti_pct?: string }): ShadowReunderwrite {
  need(f.income_components.some((c) => c.name === f.variance.component), `income component ${f.variance.component} is not on the file`);
  const before = f.income_components.reduce((s, c) => s + c.monthly_cents, 0n);
  const delta = Decimal.ratio(f.variance.annual_used_cents - f.variance.annual_verified_cents, 12n).toScaledInt(0, "HALF_UP");
  const after = before - delta;
  const dtiBefore = dtiPct(f.monthly_debts_cents, before), dtiAfter = dtiPct(f.monthly_debts_cents, after);
  const max = f.max_dti_pct ?? DU_MAX_DTI_PCT;
  const eligible = after > 0n && Decimal.parse(dtiAfter).cmp(Decimal.parse(max)) <= 0;
  const variancePct = Decimal.ratio((f.variance.annual_used_cents - f.variance.annual_verified_cents) * 1000n, f.variance.annual_used_cents * 10n).toFixed(1);
  return { du_shadow_casefile: `qc-shadow:${f.review_id}`, production_touched: false, income_before_cents: before, income_after_cents: after, dti_before_pct: dtiBefore, dti_after_pct: dtiAfter, eligible_as_delivered: eligible, reunderwrite_required: true, variance_pct: variancePct,
    rationale: `${f.variance.component}: ${f.variance.annual_verified_cents} verified vs ${f.variance.annual_used_cents} used (−${variancePct}%); DTI ${dtiBefore}% → ${dtiAfter}% against the ${max}% DU maximum → ${eligible ? "eligible" : "not eligible"} as delivered` };
}
export function recordReunderwrite(events: EventStore, r: QcReview, s: ShadowReunderwrite, at: string): { review: QcReview; event: DomainEvent } {
  const event = loanEvent(events, r, "qc.review.reunderwrite_required", { review_id: r.review_id, du_shadow_casefile: s.du_shadow_casefile, dti_before_pct: s.dti_before_pct, dti_after_pct: s.dti_after_pct, eligible_as_delivered: s.eligible_as_delivered, production_touched: false }, at);
  return { review: { ...r, reunderwrite_required: true, eligible_as_delivered: s.eligible_as_delivered, status: "reunderwrite" }, event };
}

// ============================================================ occupancy, collateral (T13), closing documents, DU final match
export interface OccupancyFacts { readonly documented_occupancy: Occupancy; readonly insurance_policy_form: string; readonly mailing_address_matches_subject: boolean; readonly ncoa_change_to_subject_effective?: PlainDate | null; readonly other_reo_claimed_primary?: boolean; readonly lease_on_subject?: boolean; readonly transcript_address_matches?: boolean | null; }
export function assessOccupancy(f: OccupancyFacts): { consistent: boolean; red_flags: string[]; further_investigation_required: boolean; evidence: string[] } {
  const flags: string[] = []; const evidence: string[] = [`insurance ${f.insurance_policy_form}`];
  const ownerForms = ["HO-3", "HO-5", "HO-6", "HO-8"]; const landlord = /^(DP|landlord|rental)/i.test(f.insurance_policy_form);
  if (f.documented_occupancy === "primary") {
    if (landlord) flags.push("landlord/dwelling-fire policy on a primary residence"); else if (ownerForms.includes(f.insurance_policy_form)) evidence.push("owner-occupied policy form");
    if (!f.mailing_address_matches_subject && !f.ncoa_change_to_subject_effective) flags.push("mailing address differs from the subject with no USPS change of address"); else evidence.push(f.ncoa_change_to_subject_effective ? `USPS change of address to the subject effective ${f.ncoa_change_to_subject_effective}` : "mailing address = subject");
    if (f.other_reo_claimed_primary) flags.push("another REO is claimed as the primary residence"); else evidence.push("no other REO claimed as primary");
    if (f.lease_on_subject) flags.push("lease agreement on the subject property");
    if (f.transcript_address_matches === false) flags.push("tax transcript address differs from the subject");
  }
  return { consistent: flags.length === 0, red_flags: flags, further_investigation_required: flags.length > 0, evidence };
}
export interface CollateralFacts { readonly cu_score: string | null; readonly units?: number; readonly relief_conditions_met: boolean; readonly value_acceptance?: boolean; readonly assessment_completable: boolean; readonly property_eligible: boolean; readonly unacceptable_practice_findings?: readonly string[]; readonly cu_messages?: readonly string[]; }
export interface CollateralAssessment { readonly comps_reverify_required: boolean; readonly property_eligibility_checked: true; readonly unacceptable_practices_checked: true; readonly cu_messages_reconciled: boolean; readonly desk_or_field_review_ordered: boolean; readonly review_kind: "desk" | "field" | null; readonly issues: string[]; readonly basis: string; }
/** D1-3-03 collateral: comps not reverified at CU ≤ 2.5 with relief conditions met (A2-2-06), but eligibility, B4-1.1-04 unacceptable-practice checks and CU message reconciliation always run; a desk/field review only when the assessment cannot be completed. */
export function assessCollateral(f: CollateralFacts): CollateralAssessment {
  const scored = f.cu_score !== null;
  const relief = scored && Decimal.parse(f.cu_score!).cmp(Decimal.parse(CU_RELIEF_MAX)) <= 0 && f.relief_conditions_met && (f.units ?? 1) === 1;
  const comps = !f.value_acceptance && !relief;
  const issues = [...(f.property_eligible ? [] : ["property eligibility (LTV/CLTV/HCLTV or property type) not met"]), ...(f.unacceptable_practice_findings ?? []).map((x) => `B4-1.1-04: ${x}`)];
  const order = comps && !f.assessment_completable;
  return { comps_reverify_required: comps, property_eligibility_checked: true, unacceptable_practices_checked: true, cu_messages_reconciled: scored, desk_or_field_review_ordered: order, review_kind: order ? "desk" : null, issues,
    basis: f.value_acceptance ? "value acceptance — property eligibility only" : relief ? `CU ${f.cu_score} ≤ ${CU_RELIEF_MAX} with relief conditions met — comparables exempt` : `CU ${f.cu_score ?? "unscored"} — comparables reverified${order ? "; assessment could not be completed → desk review ordered from a licensed appraiser" : ""}` };
}
export const CLOSING_DOCUMENT_SET = ["recorded_security_instrument", "note", "title_evidence", "final_settlement_statement"] as const;
export function reviewClosingDocuments(f: { readonly present: readonly string[]; readonly mi_required: boolean; readonly mi_certificate_present?: boolean; readonly mi_coverage_pct?: number; readonly mi_required_coverage_pct?: number; readonly recorded_copy_reviewed: boolean; readonly consistent_with_underwriting: boolean }): { complete: boolean; missing: string[]; mi_adequate: boolean | null; issues: string[] } {
  const missing = CLOSING_DOCUMENT_SET.filter((d) => !f.present.includes(d)); const issues: string[] = [];
  if (!f.recorded_copy_reviewed) issues.push("copy of the document sent for recordation not reviewed (D1-3-02)");
  if (!f.consistent_with_underwriting) issues.push("closing documents inconsistent with the underwriting decision");
  let mi: boolean | null = null;
  if (f.mi_required) { mi = f.mi_certificate_present === true && (f.mi_coverage_pct ?? 0) >= (f.mi_required_coverage_pct ?? 0); if (!mi) issues.push("mortgage insurance certificate missing or coverage below the required percentage"); }
  return { complete: missing.length === 0 && issues.length === 0, missing, mi_adequate: mi, issues };
}
export function matchDuFinalData(f: { readonly du_final: Record<string, string | number>; readonly closed_loan: Record<string, string | number>; readonly tolerances?: Record<string, number> }): { discrepancies: { field: string; du: string | number; closed: string | number; within_tolerance: boolean }[]; resubmission_required: boolean; limited_waiver_invalidated: boolean } {
  const tol = f.tolerances ?? {}; const discrepancies: { field: string; du: string | number; closed: string | number; within_tolerance: boolean }[] = [];
  for (const k of Object.keys(f.du_final)) {
    const a = f.du_final[k]!, b = f.closed_loan[k]; if (b === undefined || a === b) continue;
    const within = typeof a === "number" && typeof b === "number" && tol[k] !== undefined ? Math.abs(a - b) <= tol[k]! : false;
    discrepancies.push({ field: k, du: a, closed: b, within_tolerance: within });
  }
  const outside = discrepancies.some((d) => !d.within_tolerance);
  return { discrepancies, resubmission_required: outside, limited_waiver_invalidated: outside };
}

// ============================================================ findings and the rebuttal window (SM_QC_REBUTTAL_WINDOW_10)
export const REBUTTAL_WINDOW_DAYS = 10;
export type FindingStatus = "drafted" | "officer_review" | "released" | "rebutted" | "corrected" | "sustained";
export interface QcFinding { readonly finding_id: string; readonly review_id: string; readonly loan_id: string; readonly application_id: string; readonly category: string; readonly sub_category: string; readonly defect: string; readonly severity: 1 | 2 | 3 | 4; readonly defect_class: DefectClass; readonly description: string; readonly evidence_document_ids: readonly string[]; readonly status: FindingStatus; readonly released_at: PlainDate | null; readonly rebuttal_due_on: PlainDate | null; readonly initial_severity: 1 | 2 | 3 | 4; readonly final_severity: 1 | 2 | 3 | 4 | null; readonly rebuttal_outcome: string | null; }
export interface FindingDraft { readonly category: string; readonly sub_category: string; readonly defect: string; readonly severity: 1 | 2 | 3 | 4; readonly defect_class: DefectClass; readonly description: string; readonly evidence_document_ids: readonly string[]; }
export function draftFinding(events: EventStore, r: QcReview, d: FindingDraft, at: string): { finding: QcFinding; event: DomainEvent } {
  nonEmpty(d.category, "category"); nonEmpty(d.sub_category, "sub_category"); nonEmpty(d.defect, "defect"); need([1, 2, 3, 4].includes(d.severity), "severity is 1–4");
  need(d.evidence_document_ids.length > 0, "a finding names its evidence");
  const finding: QcFinding = { finding_id: `qcf-${r.review_id}-${d.category}-${d.sub_category}`.replace(/\s+/g, "_"), review_id: r.review_id, loan_id: r.loan_id, application_id: r.application_id, ...d, status: "drafted", released_at: null, rebuttal_due_on: null, initial_severity: d.severity, final_severity: null, rebuttal_outcome: null };
  const event = loanEvent(events, r, "qc.finding.drafted", { finding_id: finding.finding_id, review_id: r.review_id, severity: d.severity, category: d.category, sub_category: d.sub_category, defect: d.defect, defect_class: d.defect_class, taxonomy: TAXONOMY_28_2 }, at);
  return { finding, event };
}
/** The income-miscalculation finding of worked example 1: transcripts below the income used → severity 1 when the shadow re-underwrite loses eligibility (severity 2 otherwise), category Income/Employment → Income Calculation → "Income miscalculated". */
export function incomeVarianceFinding(s: ShadowReunderwrite, evidence: readonly string[]): FindingDraft {
  return { category: "Income/Employment", sub_category: "Income Calculation", defect: "Income miscalculated", severity: s.eligible_as_delivered ? 2 : 1, defect_class: "underwriting_eligibility", description: s.rationale, evidence_document_ids: evidence };
}
/** Release: severity ≤ 2 only on the `qc_officer`'s approval (an agent draft never reaches `released` on its own); `qc.finding.released` arms the 10-day production-side rebuttal window. */
export function releaseFinding(events: EventStore, finding: QcFinding, i: { readonly released_on: PlainDate; readonly actor: Actor; readonly at?: string }): { finding: QcFinding; event: DomainEvent } {
  need(finding.status === "drafted" || finding.status === "officer_review", `finding ${finding.finding_id} is ${finding.status}`);
  if (finding.severity <= 2) requireRole(i.actor, ["qc_officer"], "FINDING_SEV_LE_2_NEEDS_QC_OFFICER", `releasing a severity-${finding.severity} finding`);
  const due = addDays(i.released_on, REBUTTAL_WINDOW_DAYS);
  const out: QcFinding = { ...finding, status: "released", released_at: i.released_on, rebuttal_due_on: due };
  const event = loanEvent(events, finding, "qc.finding.released", { finding_id: finding.finding_id, review_id: finding.review_id, severity: finding.severity, initial_severity: finding.initial_severity, released_at: i.released_on, rebuttal_due_on: due, released_by_role: i.actor.role ?? i.actor.kind }, i.at ?? noonEt(i.released_on), i.actor);
  return { finding: out, event };
}
export type RebuttalOutcome = "corrected" | "rebuttal_accepted" | "sustained" | "sustained_by_default";
/** `evaluateRebuttal`: the production side's rebuttal or correction inside the window → final severity (a correction downgrades; an accepted rebuttal withdraws; sustained keeps the initial severity). */
export function evaluateRebuttal(events: EventStore, finding: QcFinding, i: { readonly outcome: RebuttalOutcome; readonly on: PlainDate; readonly evidence_document_ids?: readonly string[]; readonly final_severity?: 1 | 2 | 3 | 4; readonly at?: string }): { finding: QcFinding; event: DomainEvent } {
  need(finding.status === "released", `finding ${finding.finding_id} is ${finding.status}; only a released finding is rebutted`);
  if (i.outcome === "corrected") need((i.evidence_document_ids ?? []).length > 0, "a correction is evidenced");
  const finalSeverity: 1 | 2 | 3 | 4 = i.outcome === "corrected" ? (i.final_severity ?? 3) : i.outcome === "rebuttal_accepted" ? 4 : finding.initial_severity;
  const status: FindingStatus = i.outcome === "corrected" ? "corrected" : i.outcome === "rebuttal_accepted" ? "rebutted" : "sustained";
  const out: QcFinding = { ...finding, status, final_severity: finalSeverity, rebuttal_outcome: i.outcome };
  const event = loanEvent(events, finding, "qc.finding.rebutted", { finding_id: finding.finding_id, review_id: finding.review_id, outcome: i.outcome, initial_severity: finding.initial_severity, final_severity: finalSeverity, recorded_on: i.on, within_window: finding.rebuttal_due_on !== null && i.on <= finding.rebuttal_due_on, evidence_document_ids: i.evidence_document_ids ?? [] }, i.at ?? noonEt(i.on));
  return { finding: out, event };
}
/** Breach action of SM_QC_REBUTTAL_WINDOW_10: "finding sustained by default". */
export const sustainByDefault = (events: EventStore, finding: QcFinding, on: PlainDate): { finding: QcFinding; event: DomainEvent } => evaluateRebuttal(events, finding, { outcome: "sustained_by_default", on });

// ============================================================ closing a review; the qc_officer's ineligible-as-delivered confirmation (self-report anchor)
export interface CloseReviewInput { readonly completed_on: PlainDate; readonly outcome: "no_defect" | "defect"; readonly initial_severity?: number | null; readonly final_severity?: number | null; readonly defect_class?: DefectClass | null; readonly eligible_as_delivered?: boolean; readonly at?: string; }
export function closeReview(events: EventStore, r: QcReview, i: CloseReviewInput): { review: QcReview; event: DomainEvent } {
  need(r.status !== "closed", `review ${r.review_id} is already closed`);
  need(i.eligible_as_delivered !== false, "an ineligible-as-delivered close is the qc_officer's confirmation — use confirmIneligibleAsDelivered");
  const review: QcReview = { ...r, status: "closed", review_completed_at: i.completed_on, outcome: i.outcome, initial_severity: i.initial_severity ?? null, final_severity: i.final_severity ?? null, defect_class: i.defect_class ?? null, eligible_as_delivered: i.outcome === "no_defect" ? true : (i.eligible_as_delivered ?? r.eligible_as_delivered) };
  const event = loanEvent(events, r, "qc.review.closed", { review_id: r.review_id, kind: r.kind, cycle_id: r.cycle_id, outcome: i.outcome, review_completed_at: i.completed_on, initial_severity: review.initial_severity, final_severity: review.final_severity, eligible_as_delivered: review.eligible_as_delivered, source: "origination" }, i.at ?? noonEt(i.completed_on));
  return { review, event };
}
export const SELF_REPORT_DAYS = 30;
export const selfReportDueOn = (confirmed_on: PlainDate): PlainDate => addDays(confirmed_on, SELF_REPORT_DAYS);
export type SelfReportType = "qc_findings" | "compliance_with_laws" | "fraud";
export type SelfReportStatus = "required" | "drafted" | "approved" | "submitted" | "fnma_responded";
export interface Deficiency { readonly category: string; readonly sub_category: string; readonly defect: string; }
export interface QcSelfReport { readonly self_report_id: string; readonly loan_id: string; readonly application_id: string; readonly fnma_loan_number: string | null; readonly seller_loan_number: string | null; readonly borrower_last_name: string | null; readonly note_date: PlainDate | null; readonly report_type: SelfReportType; readonly trigger: "post_closing_qc" | "prefunding_survivor" | "servicing_discovery" | "fnma_inquiry" | "fraud_case"; readonly confirmed_at: string; readonly confirmed_on: PlainDate; readonly due_on: PlainDate; readonly synopsis: string | null; readonly deficiencies: readonly Deficiency[]; readonly documents: readonly string[]; readonly approved_by_officer_at: string | null; readonly submitted_at: string | null; readonly lqc_reference: string | null; readonly status: SelfReportStatus; readonly submission_count: number; }
/** Rule 7 / Q6: the `qc_officer`'s sustain decision is the D1-1-01 "confirmation" — `confirmed_at` anchors the 30-day self-report clock; `self_report_required` only for a loan sold to Fannie Mae. */
export function confirmIneligibleAsDelivered(events: EventStore, r: QcReview, i: { readonly confirmed_at: string; readonly actor: Actor; readonly sold_to_fnma: boolean; readonly initial_severity: number; readonly final_severity: number; readonly defect_class: DefectClass; readonly loan: { fnma_loan_number: string | null; seller_loan_number: string | null; borrower_last_name: string | null; note_date: PlainDate | null } }): { review: QcReview; self_report: QcSelfReport | null; event: DomainEvent } {
  requireRole(i.actor, ["qc_officer"], "INELIGIBLE_CONFIRMATION_NEEDS_QC_OFFICER", "confirming a loan ineligible as delivered");
  need(r.reunderwrite_required, "an ineligible-as-delivered confirmation follows the shadow re-underwrite (rule 5)");
  const confirmed_on = D(i.confirmed_at.slice(0, 10));
  const sr: QcSelfReport | null = i.sold_to_fnma ? { self_report_id: `qsr-${r.loan_id}-${confirmed_on}`, loan_id: r.loan_id, application_id: r.application_id, fnma_loan_number: i.loan.fnma_loan_number, seller_loan_number: i.loan.seller_loan_number, borrower_last_name: i.loan.borrower_last_name, note_date: i.loan.note_date, report_type: "qc_findings", trigger: r.kind === "post_closing_discretionary" && r.selection_basis.includes("prefunding_finding_sev_le_2") ? "prefunding_survivor" : "post_closing_qc",
    confirmed_at: i.confirmed_at, confirmed_on, due_on: selfReportDueOn(confirmed_on), synopsis: null, deficiencies: [], documents: [], approved_by_officer_at: null, submitted_at: null, lqc_reference: null, status: "required", submission_count: 0 } : null;
  const review: QcReview = { ...r, status: "closed", review_completed_at: confirmed_on, outcome: "defect", eligible_as_delivered: false, initial_severity: i.initial_severity, final_severity: i.final_severity, defect_class: i.defect_class, self_report_id: sr?.self_report_id ?? null };
  const event = loanEvent(events, r, "qc.review.closed", { review_id: r.review_id, kind: r.kind, cycle_id: r.cycle_id, outcome: "defect", review_completed_at: confirmed_on, initial_severity: i.initial_severity, final_severity: i.final_severity, eligible_as_delivered: false, confirmed_by_role: "qc_officer", confirmed_at: i.confirmed_at, confirmed_on, self_report_required: sr !== null, self_report_id: sr?.self_report_id ?? null, self_report_due_on: sr?.due_on ?? null, source: "origination" }, i.confirmed_at, i.actor);
  return { review, self_report: sr, event };
}
export const LQC_SELF_REPORT_TYPES: Record<SelfReportType, string> = { qc_findings: "Self Report of Lender QC Findings", compliance_with_laws: "Self Report of Compliance with Laws", fraud: "Self Report of Lender QC Findings (fraud — 28.4)" };
/** `draftSelfReport`: the LQC job-aid fields — Fannie Mae loan number, 9-digit seller/servicer loan number, borrower last name, note date, synopsis, Category → Sub-Category → Defect, supporting documents. */
export function draftSelfReport(events: EventStore, sr: QcSelfReport, i: { readonly synopsis: string; readonly deficiencies: readonly Deficiency[]; readonly documents: readonly string[]; readonly at: string }): { self_report: QcSelfReport; event: DomainEvent; lqc_form: Record<string, unknown> } {
  need(sr.status === "required" || sr.status === "drafted", `self-report ${sr.self_report_id} is ${sr.status}`);
  need(/^\d{10}$/.test(sr.fnma_loan_number ?? ""), "the Fannie Mae loan number (10 digits) is required — the loan must have been purchased");
  need(/^\d{9}$/.test(sr.seller_loan_number ?? ""), "the 9-digit seller/servicer loan number is required"); nonEmpty(sr.borrower_last_name, "borrower last name"); need(isDate(sr.note_date), "note date is required");
  nonEmpty(i.synopsis, "synopsis"); need(i.deficiencies.length > 0 && i.deficiencies.every((d) => d.category && d.sub_category && d.defect), "every deficiency names category, sub-category and defect"); need(i.documents.length > 0, "supporting documents are attached");
  const out: QcSelfReport = { ...sr, synopsis: i.synopsis, deficiencies: i.deficiencies, documents: i.documents, status: "drafted" };
  const lqc_form = { report_type: LQC_SELF_REPORT_TYPES[sr.report_type], fnma_loan_number: sr.fnma_loan_number, seller_loan_number: sr.seller_loan_number, borrower_last_name: sr.borrower_last_name, note_date: sr.note_date, synopsis: i.synopsis, deficiencies: i.deficiencies, documents: i.documents, warning: "Once you click Save and Submit, you will not be able to edit or add documents. The Self Report form for a loan should NOT be submitted more than once." };
  const event = loanEvent(events, sr, "qc.self_report.drafted", { self_report_id: sr.self_report_id, report_type: sr.report_type, due_on: sr.due_on, deficiencies: i.deficiencies, document_count: i.documents.length }, i.at);
  return { self_report: out, event, lqc_form };
}
export function approveSelfReport(events: EventStore, sr: QcSelfReport, i: { readonly actor: Actor; readonly at: string }): { self_report: QcSelfReport; event: DomainEvent } {
  requireRole(i.actor, ["officer"], "SELF_REPORT_NEEDS_PARTNER_OFFICER", "authorizing a self-report"); need(sr.status === "drafted", `self-report ${sr.self_report_id} is ${sr.status}`);
  const out: QcSelfReport = { ...sr, approved_by_officer_at: i.at, status: "approved" };
  return { self_report: out, event: loanEvent(events, sr, "qc.self_report.approved", { self_report_id: sr.self_report_id, approved_by_role: "officer", approved_at: i.at }, i.at, i.actor) };
}
/** Portal-only: the `fnma_portal_operator` confirms the LQC submission with its reference; an agent is refused; a second submission of the same loan's form is refused (job aid). `qc.self_report.submitted` closes FNMA_D1_1_01_QC_SELF_REPORT_30 / FNMA_A3_2_01_COMPLIANCE_SELF_REPORT_60. */
export function submitSelfReport(events: EventStore, sr: QcSelfReport, i: { readonly submitted_at: string; readonly lqc_reference: string; readonly actor: Actor }): { self_report: QcSelfReport; event: DomainEvent; response_case: FnmaQcCase } {
  requireRole(i.actor, ["fnma_portal_operator"], "LQC_SUBMISSION_IS_OPERATOR_ONLY", "submitting an LQC self-report");
  if (sr.submission_count > 0 || sr.status === "submitted") throw new QcRefusal("SELF_REPORT_ALREADY_SUBMITTED", `self-report ${sr.self_report_id} was submitted ${sr.submitted_at} (${sr.lqc_reference}) — the form is not submitted more than once`);
  need(sr.status === "approved", `self-report ${sr.self_report_id} is ${sr.status}; the partner officer's authorization precedes submission`); nonEmpty(i.lqc_reference, "lqc_reference");
  const out: QcSelfReport = { ...sr, submitted_at: i.submitted_at, lqc_reference: i.lqc_reference, status: "submitted", submission_count: 1 };
  const event = loanEvent(events, sr, "qc.self_report.submitted", { self_report_id: sr.self_report_id, report_type: sr.report_type, lqc_reference: i.lqc_reference, submitted_at: i.submitted_at, submitted_by_role: "fnma_portal_operator", due_on: sr.due_on, on_time: D(i.submitted_at.slice(0, 10)) <= sr.due_on }, i.submitted_at, i.actor);
  const response_case = openFnmaCase(events, { loan_id: sr.loan_id, application_id: sr.application_id, fnma_loan_number: sr.fnma_loan_number ?? "", case_type: "self_report_response", notified_at: i.submitted_at, lqc_task_id: i.lqc_reference, parent_case_id: null }, []).case;
  return { self_report: out, event, response_case };
}

// ============================================================ A3-2-01 compliance-with-laws self-report clock
export const COMPLIANCE_SELF_REPORT_DAYS = 60;
export const COMPLIANCE_THRESHOLD_LOANS = 500;
export type ComplianceCategory = "category_1" | "category_2" | null;
export function complianceSelfReportClock(i: { readonly affected_loans: number; readonly prior_year_deliveries: number; readonly all_delivered_same_quarter: boolean; readonly delivery_quarter_end: PlainDate | null; readonly discovery_on: PlainDate; readonly could_warrant_repurchase: boolean; readonly remedied_within_60: boolean }): { category: ComplianceCategory; threshold: number; clock_from: PlainDate | null; due_on: PlainDate | null; notice_required: boolean; basis: string } {
  const threshold = Math.min(COMPLIANCE_THRESHOLD_LOANS, Math.floor(i.prior_year_deliveries / 100));
  if (i.affected_loans > threshold && i.all_delivered_same_quarter) {
    need(i.delivery_quarter_end !== null, "Category 1 needs the delivery quarter end");
    const from = i.delivery_quarter_end! > i.discovery_on ? i.delivery_quarter_end! : i.discovery_on;
    return { category: "category_1", threshold, clock_from: from, due_on: addDays(from, COMPLIANCE_SELF_REPORT_DAYS), notice_required: true, basis: `A3-2-01 Reporting Category 1: ${i.affected_loans} loans exceed the lesser of 500 or 1% of prior-year deliveries (${threshold}), all delivered in the same quarter — 60 days from the later of quarter-end ${i.delivery_quarter_end} and discovery ${i.discovery_on}` };
  }
  if (i.could_warrant_repurchase && !i.remedied_within_60) return { category: "category_2", threshold, clock_from: i.discovery_on, due_on: addDays(i.discovery_on, COMPLIANCE_SELF_REPORT_DAYS), notice_required: true, basis: "A3-2-01 Reporting Category 2: the breach could warrant a repurchase demand and is not remedied within 60 days — notify within 60 days of confirmation" };
  return { category: null, threshold, clock_from: null, due_on: null, notice_required: false, basis: i.could_warrant_repurchase ? "A3-2-01: remedied within 60 days — no notice required" : "below the Category 1 threshold and no repurchase exposure — loan-level QC self-report path applies where eligibility is affected" };
}
export function confirmComplianceBreach(events: EventStore, i: { readonly breach_id: string; readonly loan_ids: readonly string[]; readonly application_id: string | null; readonly description: string; readonly at: string } & Parameters<typeof complianceSelfReportClock>[0]): { clock: ReturnType<typeof complianceSelfReportClock>; event: DomainEvent | null } {
  nonEmpty(i.breach_id, "breach_id"); nonEmpty(i.description, "description");
  const clock = complianceSelfReportClock(i);
  if (!clock.notice_required) return { clock, event: null };
  const event = events.append({ type: "compliance.breach.confirmed", aggregate: { kind: "compliance_breach", id: i.breach_id }, ...(i.application_id ? { applicationId: i.application_id } : {}), actor: AGENT, occurredAt: i.at,
    payload: { breach_id: i.breach_id, loan_ids: i.loan_ids, affected_loans: i.affected_loans, fnma_reporting_category: clock.category, self_report_clock_from: clock.clock_from, due_on: clock.due_on, description: i.description, basis: clock.basis, source: "origination" } });
  return { clock, event };
}

// ============================================================ rule 6 / T8: defect rates and the monthly report (D1-1-03)
export const TARGET_NET_SEV1_PCT = "3.0";
export interface DefectRates { readonly random_completed: number; readonly gross_sev1: number; readonly net_sev1: number; readonly gross_pct: string; readonly net_pct: string; readonly discretionary_completed: number; readonly discretionary_sev1_final: number; readonly above_target: boolean; readonly target_pct: string; }
export function computeDefectRates(reviews: readonly QcReview[], target: string = TARGET_NET_SEV1_PCT): DefectRates {
  const random = reviews.filter((r) => r.kind === "post_closing_random" && r.status === "closed"), disc = reviews.filter((r) => r.kind !== "post_closing_random" && r.status === "closed");
  const gross = random.filter((r) => r.initial_severity === 1).length, net = random.filter((r) => r.final_severity === 1).length;
  const netPct = pct1(net, random.length);
  return { random_completed: random.length, gross_sev1: gross, net_sev1: net, gross_pct: pct1(gross, random.length), net_pct: netPct, discretionary_completed: disc.length, discretionary_sev1_final: disc.filter((r) => r.final_severity === 1).length, above_target: Decimal.parse(netPct).cmp(Decimal.parse(target)) > 0, target_pct: target };
}
export interface MonthRate { readonly production_month: ProductionMonth; readonly gross_pct: string; readonly net_pct: string; }
export interface VendorReviewResult { readonly cycle_id: string; readonly performed_by: "partner"; readonly reviewed_count: number; readonly required_count: number; readonly coverage_met: boolean; readonly concurrence_rate_pct: string; readonly recorded_on: PlainDate; }
export interface CorrectiveAction { readonly action: string; readonly owner: string; readonly due_on: PlainDate; readonly process_ref: string; }
export interface CycleReport {
  readonly cycle_id: string; readonly production_month: ProductionMonth; readonly defect_rates: DefectRates; readonly three_month_trend: MonthRate[]; readonly quarterly_target_comparison: { highest_severity_rate_pct: string; target_pct: string; above_target: boolean; quarter_months: ProductionMonth[] };
  readonly compliance_vs_underwriting: { compliance: number; underwriting_eligibility: number }; readonly sample_description: { method: RandomMethod; criteria: string; random_selected: number; discretionary_selected: number; population: number; random_pct: string };
  readonly discretionary_results: { reviews: number; sev1_final: number; reported_separately: true }; readonly corrective_action_plan: { required: boolean; actions: CorrectiveAction[] };
  readonly vendor_review: { performed: boolean; statement: string; result: VendorReviewResult | null }; readonly text: string;
}
export const vendorReviewRequirement = (reviews: number): number => Math.ceil(reviews / 10);
export function vendorReviewGapStatement(cycle: QcCycle, result: VendorReviewResult | null, today: PlainDate): string {
  if (result?.coverage_met) return `Partner 10% re-review (D1-1-02): ${result.reviewed_count} of ${result.required_count} required reviews re-reviewed by partner staff on ${result.recorded_on}; concurrence ${result.concurrence_rate_pct}%.`;
  const due = addDays(cycleDueOn(cycle.production_month), 0);
  return `GAP — the partner has not performed the D1-1-02 monthly review of at least 10% of the post-closing QC sample reviewed by the vendor for the ${cycle.production_month} cycle as of ${today} (cycle due ${due}); this review must be performed by the lender itself and may not be contracted out — SM cannot perform it in the partner's place; escalated sev 1 to the partner officer.`;
}
export function draftCycleReport(i: { readonly cycle: QcCycle; readonly reviews: readonly QcReview[]; readonly prior_months: readonly MonthRate[]; readonly target_pct?: string; readonly vendor_review: VendorReviewResult | null; readonly today: PlainDate; readonly corrective_actions?: readonly CorrectiveAction[] }): CycleReport {
  const rates = computeDefectRates(i.reviews.filter((r) => r.cycle_id === i.cycle.cycle_id), i.target_pct ?? TARGET_NET_SEV1_PCT);
  const trend = [...i.prior_months.slice(-2), { production_month: i.cycle.production_month, gross_pct: rates.gross_pct, net_pct: rates.net_pct }];
  need(trend.length === 3, "D1-1-03: defect trending for at least three months — supply the two prior months");
  const closed = i.reviews.filter((r) => r.cycle_id === i.cycle.cycle_id && r.status === "closed" && r.outcome === "defect");
  const split = { compliance: closed.filter((r) => r.defect_class === "compliance").length, underwriting_eligibility: closed.filter((r) => r.defect_class === "underwriting_eligibility").length };
  const random = i.reviews.filter((r) => r.cycle_id === i.cycle.cycle_id && r.kind === "post_closing_random").length, disc = i.reviews.filter((r) => r.cycle_id === i.cycle.cycle_id && r.kind === "post_closing_discretionary").length;
  const actions: CorrectiveAction[] = rates.above_target ? [...(i.corrective_actions ?? [])] : [];
  if (rates.above_target && actions.length === 0) actions.push({ action: "Corrective action required: net severity-1 rate above the target — root cause and owner to be assigned by the qc_officer", owner: "qc_officer", due_on: addDays(i.today, 30), process_ref: "28.2 rule 6" });
  const vr = { performed: i.vendor_review?.coverage_met === true, statement: vendorReviewGapStatement(i.cycle, i.vendor_review, i.today), result: i.vendor_review };
  const sample = { method: i.cycle.random_method, criteria: `${i.cycle.random_method === "ten_percent" ? "10% of monthly production" : "statistical (95%/2%/six months)"}, stratified by product × transaction × occupancy × channel; discretionary targeting per rule 3`, random_selected: random, discretionary_selected: disc, population: i.cycle.population, random_pct: pct1(random, i.cycle.population) };
  const text = [`Post-closing QC report — production month ${i.cycle.production_month} (cycle ${i.cycle.cycle_id}, due ${i.cycle.cycle_due_on})`,
    `Random sample: ${sample.random_selected} of ${sample.population} loans (${sample.random_pct}%); discretionary: ${disc} (reported separately).`,
    `Gross severity-1 defect rate ${rates.gross_pct}% (${rates.gross_sev1}/${rates.random_completed}); net ${rates.net_pct}% (${rates.net_sev1}/${rates.random_completed}) after rebuttal and correction; target net ≤ ${rates.target_pct}% → ${rates.above_target ? "ABOVE TARGET — corrective-action plan attached" : "within target"}.`,
    `Three-month trend: ${trend.map((t) => `${t.production_month} gross ${t.gross_pct}% / net ${t.net_pct}%`).join("; ")}.`,
    `Compliance-with-laws defects ${split.compliance}; underwriting/eligibility defects ${split.underwriting_eligibility}.`, vr.statement, ...actions.map((a) => `Corrective action: ${a.action} — owner ${a.owner}, due ${a.due_on} (${a.process_ref})`)].join("\n");
  return { cycle_id: i.cycle.cycle_id, production_month: i.cycle.production_month, defect_rates: rates, three_month_trend: trend, quarterly_target_comparison: { highest_severity_rate_pct: rates.net_pct, target_pct: rates.target_pct, above_target: rates.above_target, quarter_months: trend.map((t) => t.production_month) },
    compliance_vs_underwriting: split, sample_description: sample, discretionary_results: { reviews: rates.discretionary_completed, sev1_final: rates.discretionary_sev1_final, reported_separately: true }, corrective_action_plan: { required: rates.above_target, actions }, vendor_review: vr, text };
}
const nextMonthEnd = (d: PlainDate): PlainDate => endOfMonth(addMonths(startOfMonth(d), 1));
const nextQuarterEnd = (d: PlainDate): PlainDate => { const p = parts(d); const qEndMonth = Math.ceil(p.m / 3) * 3; const thisQ = ymd(p.y, qEndMonth, daysInMonth(p.y, qEndMonth)); return d < thisQ ? thisQ : endOfMonth(addMonths(thisQ, 3)); };
/** `qc.report.issued{post_closing_monthly}` signed by the `qc_officer` — closes FNMA_D1_1_03_POST_CLOSING_REPORT_MONTHLY; carries the next month's due date for the kernel's re-arm. */
export function issueCycleReport(events: EventStore, cycle: QcCycle, report: CycleReport, i: { readonly issued_on: PlainDate; readonly actor: Actor; readonly at?: string }): { cycle: QcCycle; event: DomainEvent } {
  requireRole(i.actor, ["qc_officer"], "REPORT_SIGNATURE_NEEDS_QC_OFFICER", "signing the monthly post-closing report");
  const event = cycleEvent(events, cycle.cycle_id, "qc.report.issued", { kind: "post_closing_monthly", report_kind: "post_closing_monthly", signed_by_role: "qc_officer", issued_on: i.issued_on, gross_pct: report.defect_rates.gross_pct, net_pct: report.defect_rates.net_pct, above_target: report.defect_rates.above_target, corrective_action_required: report.corrective_action_plan.required, vendor_review_performed: report.vendor_review.performed, report_hash: sha256(report.text), report_due_on: nextMonthEnd(i.issued_on) }, i.at ?? noonEt(i.issued_on), i.actor);
  return { cycle: { ...cycle, report_issued_at: i.issued_on, status: "reported" }, event };
}
export function issueQuarterlyTargetSection(events: EventStore, i: { readonly quarter_end: PlainDate; readonly highest_severity_rate_pct: string; readonly target_pct: string; readonly issued_on: PlainDate; readonly actor: Actor }): DomainEvent {
  requireRole(i.actor, ["qc_officer"], "REPORT_SIGNATURE_NEEDS_QC_OFFICER", "issuing the quarterly target-rate section");
  return events.append({ type: "qc.report.issued", actor: i.actor, occurredAt: noonEt(i.issued_on), payload: { kind: "post_closing_quarterly", report_kind: "post_closing_quarterly", section: "highest severity defect rate vs target", quarter_end_covered: i.quarter_end, highest_severity_rate_pct: i.highest_severity_rate_pct, target_pct: i.target_pct, above_target: Decimal.parse(i.highest_severity_rate_pct).cmp(Decimal.parse(i.target_pct)) > 0, issued_on: i.issued_on, signed_by_role: "qc_officer", quarter_end: nextQuarterEnd(addDays(i.quarter_end, 1)), source: "origination" } });
}
/** `qc.cycle.completed`: reviews, rebuttals and the signed management report done (the report is the final step) — satisfies FNMA_D1_3_QC_CYCLE_90 and arms the partner's 15-day vendor-review row on `vendor_review_clock_from`. */
export function completeCycle(events: EventStore, cycle: QcCycle, reviews: readonly QcReview[], i: { readonly completed_on: PlainDate; readonly management_ack_on: PlainDate; readonly at?: string }): { cycle: QcCycle; event: DomainEvent; on_time: boolean } {
  need(cycle.report_issued_at !== null, "the signed monthly report is the final step of the cycle (QC FAQs) — issue it first");
  const open = reviews.filter((r) => r.cycle_id === cycle.cycle_id && r.status !== "closed"); need(open.length === 0, `${open.length} review(s) still open`);
  const on_time = i.completed_on <= cycle.cycle_due_on;
  const event = cycleEvent(events, cycle.cycle_id, "qc.cycle.completed", { production_month: cycle.production_month, completed_on: i.completed_on, management_ack_on: i.management_ack_on, cycle_due_on: cycle.cycle_due_on, on_time, reviews: reviews.filter((r) => r.cycle_id === cycle.cycle_id).length, vendor_review_clock_from: i.completed_on, vendor_review_due_on: addDays(i.completed_on, VENDOR_REVIEW_DAYS) }, i.at ?? noonEt(i.completed_on));
  return { cycle: { ...cycle, status: "reported", reviews_completed_at: cycle.reviews_completed_at ?? i.completed_on, rebuttals_closed_at: cycle.rebuttals_closed_at ?? i.completed_on }, event, on_time };
}

// ============================================================ D1-1-02: the partner's own 10 % re-review (T9)
export const VENDOR_REVIEW_DAYS = 15;
export interface TimerHandle { byCode(code: string): readonly { id: string; code: string; status: string; armedByEventId: string }[]; cancel(id: string, reason: string, actor?: Actor): void; }
/** "This review must be performed by the lender itself and may not be contracted out": only partner staff; coverage ≥ 10 % of the cycle's reviews with concurrence recorded → `qc.report.issued{vendor_review_monthly}`; the kernel's recurring re-arm from the satisfying event is retired (the next cycle's completion arms its own). */
export function recordVendorReview(events: EventStore, cycle: QcCycle, reviews: readonly QcReview[], i: { readonly reviewed_review_ids: readonly string[]; readonly performed_by: "partner" | "sm" | "contractor"; readonly concurrence: readonly { review_id: string; concurs: boolean }[]; readonly recorded_on: PlainDate; readonly actor: Actor; readonly at?: string }, timers?: TimerHandle): { result: VendorReviewResult; event: DomainEvent; retired_rearm_id: string | null } {
  if (i.performed_by !== "partner") throw new QcRefusal("VENDOR_REVIEW_NOT_CONTRACTED_OUT", `D1-1-02: the 10% review of the vendor's post-closing work must be performed by the lender itself and may not be contracted out (performed_by=${i.performed_by})`);
  requireRole(i.actor, ["officer"], "VENDOR_REVIEW_RECORDED_BY_PARTNER_OFFICER", "recording the partner's re-review");
  const total = reviews.filter((r) => r.cycle_id === cycle.cycle_id).length; const required = vendorReviewRequirement(total);
  const ids = new Set(reviews.filter((r) => r.cycle_id === cycle.cycle_id).map((r) => r.review_id)); need(i.reviewed_review_ids.every((id) => ids.has(id)), "every re-reviewed id belongs to the cycle");
  need(i.reviewed_review_ids.every((id) => i.concurrence.some((c) => c.review_id === id)), "concurrence is recorded for every re-reviewed review");
  const concurring = i.concurrence.filter((c) => c.concurs).length;
  const result: VendorReviewResult = { cycle_id: cycle.cycle_id, performed_by: "partner", reviewed_count: i.reviewed_review_ids.length, required_count: required, coverage_met: i.reviewed_review_ids.length >= required, concurrence_rate_pct: pct1(concurring, Math.max(1, i.concurrence.length)), recorded_on: i.recorded_on };
  const event = cycleEvent(events, cycle.cycle_id, "qc.report.issued", { kind: "vendor_review_monthly", report_kind: "vendor_review_monthly", performed_by: "partner", reviewed_count: result.reviewed_count, required_count: required, coverage_met: result.coverage_met, concurrence_rate_pct: result.concurrence_rate_pct, recorded_on: i.recorded_on, signed_by_role: "officer" }, i.at ?? noonEt(i.recorded_on), i.actor);
  let retired: string | null = null;
  if (timers && result.coverage_met) for (const t of timers.byCode("FNMA_D1_1_02_VENDOR_REVIEW_10PCT_MONTHLY")) if (t.status === "armed" && t.armedByEventId === event.id) { timers.cancel(t.id, `vendor re-review of cycle ${cycle.cycle_id} recorded ${i.recorded_on}; the next cycle's completion arms its own`, i.actor); retired = t.id; }
  return { result, event, retired_rearm_id: retired };
}

// ============================================================ rule 11 / T7: arrears (FNMA_D1_3_01_QC_ARREARS_NOTICE)
export function cycleArrears(cycle: QcCycle, today: PlainDate): { overdue: boolean; days_overdue: number; more_than_one_cycle: boolean; arrears_notice_due_on: PlainDate; status: CycleStatus } {
  const reported = cycle.status === "reported"; const overdue = !reported && today > cycle.cycle_due_on; const days = overdue ? daysBetween(cycle.cycle_due_on, today) : 0;
  const more = overdue && days > ARREARS_CYCLE_DAYS;
  return { overdue, days_overdue: days, more_than_one_cycle: more, arrears_notice_due_on: addDays(cycle.cycle_due_on, ARREARS_CYCLE_DAYS), status: more ? "in_arrears" : cycle.status };
}
/** The 90-day breach (`timer.breached{code=FNMA_D1_3_QC_CYCLE_90}`) starts arrears tracking: `qc.cycle.in_arrears` carries `cycle_due_on`, from which the written-notice clock (+30) arms. */
export function startArrearsTracking(events: EventStore, cycle: QcCycle, breach: { readonly id: string; readonly type: string; readonly payload: Record<string, unknown> }, at: string): { cycle: QcCycle; event: DomainEvent } {
  need(breach.type === "timer.breached" && breach.payload.code === "FNMA_D1_3_QC_CYCLE_90", "arrears tracking starts from the 90-day cycle breach");
  need(cycle.status !== "reported", `cycle ${cycle.cycle_id} is reported`);
  const event = events.append({ type: "qc.cycle.in_arrears", aggregate: { kind: "qc_cycle", id: cycle.cycle_id }, actor: AGENT, occurredAt: at, causationId: breach.id, payload: { cycle_id: cycle.cycle_id, production_month: cycle.production_month, cycle_due_on: cycle.cycle_due_on, arrears_notice_due_on: addDays(cycle.cycle_due_on, ARREARS_CYCLE_DAYS), breached_timer_id: breach.payload.timer_id ?? null, severity: 1, escalate_to: ["qc_officer", "officer"], source: "origination" } });
  return { cycle: { ...cycle, status: "in_arrears" }, event };
}
export function draftArrearsNotice(i: { readonly cycles: readonly QcCycle[]; readonly recovery_plan: string; readonly partner_name: string; readonly recipient: string; readonly drafted_on: PlainDate }): { text: string; cycles_affected: ProductionMonth[]; ready: true; recipient: string } {
  need(i.cycles.length > 0, "at least one cycle in arrears"); nonEmpty(i.recovery_plan, "recovery_plan");
  const affected = i.cycles.map((c) => c.production_month);
  const text = [`To: ${i.recipient} (Fannie Mae customer account team / QC Specialist)`, `From: ${i.partner_name} — written notice under Selling Guide D1-3-01 (QC cycle in arrears more than one 30-day cycle)`, `Date: ${i.drafted_on}`,
    `Cycles affected: ${i.cycles.map((c) => `${c.production_month} (due ${c.cycle_due_on}, status ${c.status})`).join("; ")}`, `Recovery plan: ${i.recovery_plan}`, "Prepared by the qc-audit agent for the partner officer's signature; sent by the officer."].join("\n");
  return { text, cycles_affected: affected, ready: true, recipient: i.recipient };
}
/** The partner `officer` sends the notice the same day → `arrears_notice_sent_at`; `qc.arrears_notice.sent{sent_by_role=officer}` satisfies the row. */
export function sendArrearsNotice(events: EventStore, cycle: QcCycle, i: { readonly sent_on: PlainDate; readonly actor: Actor; readonly notice_text: string; readonly recipient: string; readonly at?: string }): { cycle: QcCycle; event: DomainEvent } {
  requireRole(i.actor, ["officer"], "ARREARS_NOTICE_SENT_BY_PARTNER_OFFICER", "sending the written arrears notice to Fannie Mae"); nonEmpty(i.notice_text, "notice_text");
  const event = cycleEvent(events, cycle.cycle_id, "qc.arrears_notice.sent", { sent_by_role: "officer", arrears_notice_sent_at: i.sent_on, recipient: i.recipient, notice_hash: sha256(i.notice_text), production_month: cycle.production_month }, i.at ?? noonEt(i.sent_on), i.actor);
  return { cycle: { ...cycle, arrears_notice_sent_at: i.sent_on }, event };
}

// ============================================================ schedule ticks (the four schedule-triggered rows)
export function quarterEnd(d: PlainDate): PlainDate { const p = parts(d); const m = Math.ceil(p.m / 3) * 3; return ymd(p.y, m, daysInMonth(p.y, m)); }
/** The 28.2 scheduler: 1st business day (population freeze / selection by the 10th; the monthly report), month-end (EPD snapshot), quarter-end (target-rate section) — global subject, `source=origination`. */
export function postClosingScheduleTicks(today: PlainDate, cal: Calendar = creditor): EventInput[] {
  const out: EventInput[] = []; const p = parts(today);
  if (isFirstBusinessDayOfMonth(today, cal)) {
    const prev = productionMonthOf(addMonths(startOfMonth(today), -1));
    out.push({ type: "schedule.tick", actor: SCHEDULER, occurredAt: noonEt(today), payload: { cadence: "monthly", job: "qc_post_closing_select", date: today, production_month: prev, population_frozen_on: today, select_by: selectionDueOn(prev), source: "origination" } });
    out.push({ type: "schedule.tick", actor: SCHEDULER, occurredAt: noonEt(today), payload: { cadence: "monthly", job: "qc_post_closing_report", date: today, report_due_on: endOfMonth(today), source: "origination" } });
  }
  if (today === endOfMonth(today)) out.push({ type: "schedule.tick", actor: SCHEDULER, occurredAt: noonEt(today), payload: { cadence: "monthly", job: "qc_epd_monitor", date: today, month_end: today, source: "origination" } });
  if (today === quarterEnd(today)) out.push({ type: "schedule.tick", actor: SCHEDULER, occurredAt: noonEt(today), payload: { cadence: "quarterly", job: "qc_target_rate", date: today, quarter_end: today, target_rate_section_due_on: addDays(today, 30), source: "origination", year: p.y } });
  return out;
}
export const emitPostClosingScheduleTicks = (today: PlainDate, events: EventStore, cal: Calendar = creditor): DomainEvent[] => postClosingScheduleTicks(today, cal).map((e) => events.append(e));

// ============================================================ D2-1: Loan Quality Connect cases (portal-only)
export type FnmaCaseType = "file_request" | "missing_documents" | "data_validation" | "nopd" | "resolution_request" | "demand_repurchase" | "demand_indemnification" | "demand_make_whole" | "pal" | "appeal_1" | "appeal_2" | "impasse" | "management_escalation" | "idr" | "relief_report" | "self_report_response";
export type FnmaCaseStatus = "open" | "package_ready" | "submitted" | "fnma_responded" | "closed";
export type FnmaCaseOutcome = "no_defect" | "finding" | "pal" | "significant_defect" | "corrected" | "repurchased" | "alternative_remedy" | "appeal_granted" | "appeal_denied";
export interface FnmaQcCase { readonly case_id: string; readonly loan_id: string; readonly application_id: string; readonly fnma_loan_number: string; readonly case_type: FnmaCaseType; readonly lqc_task_id: string; readonly notified_at: string; readonly notified_on: PlainDate; readonly due_on: PlainDate | null; readonly policy_submit_by: PlainDate | null; readonly package_document_id: string | null; readonly package_hash: string | null; readonly package_page_count: number | null; readonly package_file_name: string | null; readonly operator_escalation_id: string | null; readonly submitted_at: string | null; readonly lqc_reference: string | null; readonly status: FnmaCaseStatus; readonly outcome: FnmaCaseOutcome | null; readonly amount_cents: Cents | null; readonly parent_case_id: string | null; }
export const LQC_RESPONSE_DAYS = 30; export const NOPD_UPLOAD_DAYS = 30; export const RESOLUTION_REQUEST_DAYS = 60;
export function caseDueOn(t: FnmaCaseType, notified_on: PlainDate): PlainDate | null {
  switch (t) { case "file_request": case "data_validation": case "missing_documents": return addDays(notified_on, LQC_RESPONSE_DAYS); case "nopd": return addDays(notified_on, NOPD_UPLOAD_DAYS); case "resolution_request": return addDays(notified_on, RESOLUTION_REQUEST_DAYS); case "demand_repurchase": case "demand_indemnification": case "demand_make_whole": case "pal": return addDays(notified_on, REMEDY_PAYMENT_DAYS); default: return null; }
}
const etDate = (iso: string): PlainDate => { const d = new Date(Date.parse(iso)); const s = d.toLocaleDateString("en-CA", { timeZone: "America/New_York" }); return D(s); };
/** The LQC e-mail parser (no API: notifications are ingested from the monitored mailbox and confirmed by the operator). */
export function parseLqcNotification(mail: { readonly subject: string; readonly body: string; readonly received_at: string }): { case_type: FnmaCaseType; fnma_loan_number: string; lqc_task_id: string; notified_at: string; notified_on: PlainDate } {
  const s = `${mail.subject}\n${mail.body}`;
  const type: FnmaCaseType | null = /notice of potential defect|NOPD/i.test(s) ? "nopd" : /resolution request/i.test(s) ? "resolution_request" : /repurchase/i.test(s) ? "demand_repurchase" : /indemnification/i.test(s) ? "demand_indemnification" : /make[- ]whole/i.test(s) ? "demand_make_whole" : /price[- ]adjusted|PAL/i.test(s) ? "pal" : /missing document/i.test(s) ? "missing_documents" : /data validation/i.test(s) ? "data_validation" : /relief report/i.test(s) ? "relief_report" : /loan file requested|file request/i.test(s) ? "file_request" : null;
  need(type !== null, `unrecognized Loan Quality Connect notification: ${mail.subject}`);
  const ln = /\b(\d{10})\b/.exec(s); need(ln !== null, "no 10-digit Fannie Mae loan number in the notification");
  const task = /task[#: ]+\s*([A-Za-z0-9-]+)/i.exec(s)?.[1] ?? `${type}-${ln![1]}-${mail.received_at.slice(0, 10)}`;
  return { case_type: type!, fnma_loan_number: ln![1]!, lqc_task_id: task, notified_at: mail.received_at, notified_on: etDate(mail.received_at) };
}
export interface OpenCaseInput { readonly loan_id: string; readonly application_id: string; readonly fnma_loan_number: string; readonly case_type: FnmaCaseType; readonly notified_at: string; readonly lqc_task_id: string; readonly parent_case_id: string | null; readonly amount_cents?: Cents | null; }
/** Idempotent by LQC task: a duplicate notification links to the existing case; `fnma.qc.case.opened{case_type, notified_on}` arms the D2-1 rows. */
export function openFnmaCase(events: EventStore, i: OpenCaseInput, existing: readonly FnmaQcCase[], at?: string): { case: FnmaQcCase; created: boolean; event: DomainEvent | null } {
  nonEmpty(i.lqc_task_id, "lqc_task_id"); nonEmpty(i.notified_at, "notified_at");
  const dup = existing.find((c) => c.lqc_task_id === i.lqc_task_id && c.case_type === i.case_type); if (dup) return { case: dup, created: false, event: null };
  const notified_on = etDate(i.notified_at); const due = caseDueOn(i.case_type, notified_on);
  const c: FnmaQcCase = { case_id: `fqc-${i.loan_id}-${i.case_type}-${notified_on}`, loan_id: i.loan_id, application_id: i.application_id, fnma_loan_number: i.fnma_loan_number, case_type: i.case_type, lqc_task_id: i.lqc_task_id, notified_at: i.notified_at, notified_on, due_on: due, policy_submit_by: due ? policySubmitBy(due) : null,
    package_document_id: null, package_hash: null, package_page_count: null, package_file_name: null, operator_escalation_id: null, submitted_at: null, lqc_reference: null, status: "open", outcome: null, amount_cents: i.amount_cents ?? null, parent_case_id: i.parent_case_id };
  const event = loanEvent(events, c, "fnma.qc.case.opened", { case_id: c.case_id, case_type: c.case_type, fnma_loan_number: c.fnma_loan_number, lqc_task_id: c.lqc_task_id, notified_at: c.notified_at, notified_on, due_on: due, policy_submit_by: c.policy_submit_by, parent_case_id: c.parent_case_id }, at ?? i.notified_at);
  return { case: c, created: true, event };
}
/** Form 1032 stacking order (Post-Closing Loan File Document Checklist) for the bookmarked single PDF. */
export const FORM_1032_ORDER = ["application_1003_initial", "application_1003_final", "du_final_findings", "du_validation_reports", "credit_report", "income_documents", "asset_documents", "valuation_evidence", "title_commitment_policy", "le_cd_set", "note", "recorded_security_instrument", "closing_instructions", "rescission_evidence", "compliance_test_results", "prefunding_qc_record", "servicing_file"] as const;
export const LQC_MAX_BYTES = 400 * 1024 * 1024; export const LQC_MAX_PAGES = 3000;
export interface PackageDocument { readonly document_id: string; readonly kind: string; readonly pages: number; readonly bytes: number; readonly content_hash: string; }
export const lqcFileName = (fnma_loan_number: string): string => `${fnma_loan_number}_LoanFile.pdf`;
/** `buildLqcPackage`: Form 1032 order, ≤ 400 MB / 3,000 pages, `FannieMaeLoanNumber_LoanFile.pdf`, hash frozen (`fnma.qc.package.ready`) before any operator escalation. */
export function buildLqcPackage(events: EventStore, c: FnmaQcCase, docs: readonly PackageDocument[], at: string): { case: FnmaQcCase; package: { file_name: string; order: string[]; pages: number; bytes: number; hash: string; form_1032_index: { kind: string; document_id: string; pages: number }[] }; event: DomainEvent } {
  need(c.status === "open", `case ${c.case_id} is ${c.status}`); need(docs.length > 0, "the package needs the loan file documents"); need(/^\d{10}$/.test(c.fnma_loan_number), "a 10-digit Fannie Mae loan number names the file");
  const rank = (k: string) => { const i = (FORM_1032_ORDER as readonly string[]).indexOf(k); return i < 0 ? FORM_1032_ORDER.length : i; };
  const ordered = [...docs].sort((a, b) => rank(a.kind) - rank(b.kind) || a.document_id.localeCompare(b.document_id));
  const pages = ordered.reduce((s, d) => s + d.pages, 0), bytes = ordered.reduce((s, d) => s + d.bytes, 0);
  need(pages <= LQC_MAX_PAGES && bytes <= LQC_MAX_BYTES, `Bulk Document Upload limit: ≤ ${LQC_MAX_PAGES} pages and ≤ 400 MB per PDF (package ${pages} pages / ${bytes} bytes)`);
  const hash = sha256(ordered.map((d) => `${d.kind}:${d.document_id}:${d.content_hash}`).join("\n"));
  const file_name = lqcFileName(c.fnma_loan_number);
  const out: FnmaQcCase = { ...c, package_hash: hash, package_page_count: pages, package_file_name: file_name, package_document_id: `pkg-${c.case_id}`, status: "package_ready" };
  const event = loanEvent(events, c, "fnma.qc.package.ready", { case_id: c.case_id, case_type: c.case_type, package_hash: hash, page_count: pages, bytes, file_name, form_1032_index: ordered.map((d) => d.kind), frozen_at: at }, at);
  return { case: out, package: { file_name, order: ordered.map((d) => d.kind), pages, bytes, hash, form_1032_index: ordered.map((d) => ({ kind: d.kind, document_id: d.document_id, pages: d.pages })) }, event };
}
export const OPERATOR_SLA_BD = 2; export const OPERATOR_SLA_BD_NEAR_DEADLINE = 1; export const OPERATOR_NEAR_DEADLINE_DAYS = 5;
export interface OperatorTask { readonly kind: "human_portal_task"; readonly owner_role: "fnma_portal_operator"; readonly case_id: string; readonly package_hash: string; readonly sla_due_on: PlainDate; readonly sla_business_days: number; readonly checklist: string[]; readonly deadline: PlainDate | null; readonly policy_submit_by: PlainDate | null; }
/** The operator escalation (every LQC action is a human portal act): refused until the package hash is frozen; SLA 2 business days, 1 when a Fannie Mae deadline is within 5 days; the checklist carries the portal conventions. */
export function operatorTaskFor(c: FnmaQcCase, today: PlainDate, cal: Calendar = creditor): OperatorTask {
  if (!c.package_hash) throw new QcRefusal("PACKAGE_HASH_NOT_FROZEN", `case ${c.case_id}: the operator escalation opens only after the package hash is frozen`);
  const near = c.due_on !== null && daysBetween(today, c.due_on) <= OPERATOR_NEAR_DEADLINE_DAYS; const bd = near ? OPERATOR_SLA_BD_NEAR_DEADLINE : OPERATOR_SLA_BD;
  const checklist = [`file name ${c.package_file_name}`, `≤ 400 MB / ${LQC_MAX_PAGES} pages per PDF (${c.package_page_count} pages)`, `Fannie Mae loan number ${c.fnma_loan_number}`, `LQC task ${c.lqc_task_id} (${c.case_type})`, "record the LQC reference / confirmation screenshot on the case", ...(c.case_type === "self_report_response" ? ["\"Save and Submit\" is single-submission — never submit a self-report twice"] : [])];
  return { kind: "human_portal_task", owner_role: "fnma_portal_operator", case_id: c.case_id, package_hash: c.package_hash, sla_due_on: addBusinessDays(today, bd, cal), sla_business_days: bd, checklist, deadline: c.due_on, policy_submit_by: c.policy_submit_by };
}
/** `confirmSubmission`: only the `fnma_portal_operator` confirms an upload (`submitted_at` + LQC reference) — the agent is refused; `fnma.qc.package.submitted` satisfies the D2-1 rows. */
export function confirmSubmission(events: EventStore, c: FnmaQcCase, i: { readonly submitted_at: string; readonly lqc_reference: string; readonly actor: Actor; readonly evidence_document_id?: string | null }): { case: FnmaQcCase; event: DomainEvent } {
  requireRole(i.actor, ["fnma_portal_operator"], "LQC_SUBMISSION_IS_OPERATOR_ONLY", "confirming a Loan Quality Connect upload");
  need(c.status === "package_ready", `case ${c.case_id} is ${c.status}; the package must be ready (hash frozen) before submission`); nonEmpty(i.lqc_reference, "lqc_reference");
  const submitted_on = etDate(i.submitted_at);
  const out: FnmaQcCase = { ...c, submitted_at: i.submitted_at, lqc_reference: i.lqc_reference, status: "submitted" };
  const event = loanEvent(events, c, "fnma.qc.package.submitted", { case_id: c.case_id, case_type: c.case_type, submitted_at: i.submitted_at, submitted_on, lqc_reference: i.lqc_reference, submitted_by_role: "fnma_portal_operator", package_hash: c.package_hash, due_on: c.due_on, days_early: c.due_on ? daysBetween(submitted_on, c.due_on) : null, evidence_document_id: i.evidence_document_id ?? null }, i.submitted_at, i.actor);
  return { case: out, event };
}
export function draftNopdResponse(c: FnmaQcCase, i: { readonly defect_text: string; readonly evidence: readonly { document_id: string; source: string; kind: string }[] }): { case_id: string; response: string; evidence: { document_id: string; source: string; kind: string }[]; upload_by: PlainDate | null } {
  need(c.case_type === "nopd", `case ${c.case_id} is a ${c.case_type}, not an NOPD`); need(i.evidence.length > 0, "an NOPD response attaches the corrective documents"); nonEmpty(i.defect_text, "defect_text");
  return { case_id: c.case_id, response: `Response to Notice of Potential Defect (${c.lqc_task_id}): "${i.defect_text}" — corrective documents: ${i.evidence.map((e) => `${e.kind} (${e.source}, ${e.document_id})`).join("; ")}.`, evidence: [...i.evidence], upload_by: c.policy_submit_by };
}
export function resolveResolutionRequest(events: EventStore, c: FnmaQcCase, i: { readonly resolution: "correction_accepted" | "alternative_remedy_agreed" | "appeal_1_filed"; readonly on: PlainDate; readonly actor: Actor; readonly at?: string }): { case: FnmaQcCase; event: DomainEvent } {
  need(c.case_type === "resolution_request", `case ${c.case_id} is a ${c.case_type}`); if (i.resolution !== "correction_accepted") requireRole(i.actor, ["officer"], "REMEDY_DECISION_NEEDS_PARTNER_OFFICER", "agreeing an alternative remedy or authorizing an appeal");
  const out: FnmaQcCase = { ...c, status: "fnma_responded", outcome: i.resolution === "correction_accepted" ? "corrected" : i.resolution === "alternative_remedy_agreed" ? "alternative_remedy" : null };
  return { case: out, event: loanEvent(events, c, "fnma.qc.case.resolved", { case_id: c.case_id, case_type: c.case_type, resolution: i.resolution, resolved_on: i.on }, i.at ?? noonEt(i.on), i.actor) };
}
export function closeFnmaCase(events: EventStore, c: FnmaQcCase, i: { readonly outcome: FnmaCaseOutcome; readonly on: PlainDate; readonly at?: string }): { case: FnmaQcCase; event: DomainEvent } {
  const out: FnmaQcCase = { ...c, status: "closed", outcome: i.outcome };
  return { case: out, event: loanEvent(events, c, "fnma.qc.case.closed", { case_id: c.case_id, case_type: c.case_type, outcome: i.outcome, closed_on: i.on }, i.at ?? noonEt(i.on)) };
}

// ============================================================ A2-3.2: demands, the appeals ladder and the repurchase price (T6, rule 9)
export const REMEDY_PAYMENT_DAYS = 60; export const APPEAL1_DAYS = 60; export const FNMA_RESPONSE_DAYS = 60; export const APPEAL2_DAYS = 15; export const IMPASSE_DAYS = 15; export const IMPASSE_RESOLVE_DAYS = 30; export const MGMT_ESCALATION_DAYS = 15; export const FNMA_MGMT_REVIEW_DAYS = 30; export const IDR_DAYS = 15; export const MAX_APPEALS = 2;
export type RemedyType = "repurchase" | "indemnification" | "make_whole" | "pal_llpa" | "pricing_adjustment" | "recourse" | "collateralized_indemnification" | "mi_stand_in" | "split_loss" | "loss_reimbursement";
export type AppealStage = "appeal_1" | "appeal_2";
export type LadderStatus = "demanded" | "appeal_1_filed" | "appeal_1_denied" | "appeal_1_granted" | "appeal_2_filed" | "appeal_2_denied" | "appeal_2_granted" | "impasse" | "impasse_resolved" | "impasse_expired" | "management_escalation" | "management_escalation_decided" | "idr" | "paid" | "resolved";
export interface AppealRecord { readonly stage: AppealStage; readonly filed_on: PlainDate; readonly new_information: boolean; readonly attachments: readonly string[]; readonly response_expected_by: PlainDate; readonly responded_on: PlainDate | null; readonly outcome: "granted" | "denied" | null; }
export interface RemedyLedger { readonly remedy_id: string; readonly case_id: string; readonly loan_id: string; readonly application_id: string; readonly remedy_type: RemedyType; readonly demand_received_on: PlainDate; readonly demand_event_id: string; readonly payment_due_on: PlainDate; readonly appeal_1_due_on: PlainDate; readonly amount_cents: Cents | null; readonly components: RepurchasePrice | null; readonly appeals: readonly AppealRecord[]; readonly appeal_status: LadderStatus; readonly payment_timer: "running" | "suspended" | "paid"; readonly impasse_declared_on: PlainDate | null; readonly impasse_resolve_by: PlainDate | null; readonly management_escalation_filed_on: PlainDate | null; readonly idr_initiated_on: PlainDate | null; readonly paid_at: string | null; readonly ledger_entry_id: string | null; readonly sm_indemnity_share_cents: Cents | null; }
const remedyTypeOf = (t: FnmaCaseType): RemedyType => (t === "demand_repurchase" ? "repurchase" : t === "demand_indemnification" ? "indemnification" : t === "demand_make_whole" ? "make_whole" : "pal_llpa");
/** A demand (repurchase / indemnification / make-whole / PAL) received: `remedy.demand.received` arms the 60-day payment and first-appeal clocks on `demand_received_on`. */
export function receiveDemand(events: EventStore, c: FnmaQcCase, i: { readonly demand_received_on: PlainDate; readonly amount_cents: Cents | null; readonly at?: string }): { ledger: RemedyLedger; event: DomainEvent } {
  need(["demand_repurchase", "demand_indemnification", "demand_make_whole", "pal"].includes(c.case_type), `case ${c.case_id} (${c.case_type}) is not a demand`);
  const payment_due_on = addDays(i.demand_received_on, REMEDY_PAYMENT_DAYS), appeal_1_due_on = addDays(i.demand_received_on, APPEAL1_DAYS);
  const remedy_type = remedyTypeOf(c.case_type);
  const event = loanEvent(events, c, "remedy.demand.received", { case_id: c.case_id, remedy_type, demand_received_on: i.demand_received_on, payment_due_on, appeal_1_due_on, amount_cents: i.amount_cents === null ? null : String(i.amount_cents), llpa_excluded: true }, i.at ?? noonEt(i.demand_received_on));
  const ledger: RemedyLedger = { remedy_id: `rem-${c.case_id}`, case_id: c.case_id, loan_id: c.loan_id, application_id: c.application_id, remedy_type, demand_received_on: i.demand_received_on, demand_event_id: event.id, payment_due_on, appeal_1_due_on, amount_cents: i.amount_cents, components: null, appeals: [], appeal_status: "demanded", payment_timer: "running", impasse_declared_on: null, impasse_resolve_by: null, management_escalation_filed_on: null, idr_initiated_on: null, paid_at: null, ledger_entry_id: null, sm_indemnity_share_cents: null };
  return { ledger, event };
}
export interface AppealAttachment { readonly document_id: string; readonly kind: string; readonly new_information?: boolean; }
/** `draftAppeal`: the console refuses an appeal-2 draft without a "new information" attachment (A2-3.2-03 second appeal "only with new information"); a third appeal is never drafted (LQC: maximum of two). */
export function draftAppeal(ledger: RemedyLedger, i: { readonly stage: AppealStage; readonly grounds: string; readonly attachments: readonly AppealAttachment[] }): { stage: AppealStage; brief: string; attachments: AppealAttachment[]; new_information: boolean; file_by: PlainDate } {
  nonEmpty(i.grounds, "grounds"); need(i.attachments.length > 0, "an appeal attaches its evidence");
  const newInfo = i.attachments.some((a) => a.new_information === true);
  if (i.stage === "appeal_2") { if (!newInfo) throw new QcRefusal("APPEAL2_NEW_INFORMATION_REQUIRED", "A2-3.2-03: a second appeal is filed only with new information — attach and flag the new information"); need(ledger.appeal_status === "appeal_1_denied", `appeal 2 follows a denied first appeal (status ${ledger.appeal_status})`); }
  else need(ledger.appeal_status === "demanded", `appeal 1 follows the demand (status ${ledger.appeal_status})`);
  need(ledger.appeals.length < MAX_APPEALS, "the lender is allowed to submit a maximum of two appeals");
  const file_by = i.stage === "appeal_1" ? ledger.appeal_1_due_on : addDays(ledger.appeals.find((a) => a.stage === "appeal_1")!.responded_on!, APPEAL2_DAYS);
  return { stage: i.stage, brief: `${i.stage === "appeal_1" ? "First" : "Second"} appeal of the ${ledger.remedy_type} demand received ${ledger.demand_received_on} (case ${ledger.case_id}): ${i.grounds}${newInfo ? " — with new information" : ""}. Attachments: ${i.attachments.map((a) => `${a.kind} (${a.document_id})`).join("; ")}.`, attachments: [...i.attachments], new_information: newInfo, file_by };
}
/** `fileAppeal`: the partner `officer` authorizes; appeal 1 suspends the payment clock (A2-3.2-01 "unless an appeal is made") — the armed FNMA_A2_3_2_01_REMEDY_PAYMENT_60 instance for this demand is retired with the reason on record; `remedy.appeal.filed{stage}` satisfies the appeal rows and arms Fannie Mae's 60-day response expectation. */
export function fileAppeal(events: EventStore, ledger: RemedyLedger, i: { readonly stage: AppealStage; readonly filed_on: PlainDate; readonly attachments: readonly AppealAttachment[]; readonly grounds: string; readonly actor: Actor; readonly at?: string }, timers?: TimerHandle): { ledger: RemedyLedger; event: DomainEvent; suspended_timer_id: string | null } {
  requireRole(i.actor, ["officer"], "APPEAL_NEEDS_PARTNER_OFFICER", "filing an appeal");
  const draft = draftAppeal(ledger, { stage: i.stage, grounds: i.grounds, attachments: i.attachments });
  need(i.filed_on <= draft.file_by, `${i.stage} window closed ${draft.file_by} (filing ${i.filed_on})`);
  const rec: AppealRecord = { stage: i.stage, filed_on: i.filed_on, new_information: draft.new_information, attachments: i.attachments.map((a) => a.document_id), response_expected_by: addDays(i.filed_on, FNMA_RESPONSE_DAYS), responded_on: null, outcome: null };
  let suspended: string | null = null;
  if (i.stage === "appeal_1" && timers) for (const t of timers.byCode("FNMA_A2_3_2_01_REMEDY_PAYMENT_60")) if (t.status === "armed" && t.armedByEventId === ledger.demand_event_id) { timers.cancel(t.id, `suspended: appeal 1 filed ${i.filed_on} (A2-3.2-01 "within 60 days after receipt of the demand … unless an appeal is made")`, i.actor); suspended = t.id; }
  const out: RemedyLedger = { ...ledger, appeals: [...ledger.appeals, rec], appeal_status: i.stage === "appeal_1" ? "appeal_1_filed" : "appeal_2_filed", payment_timer: "suspended" };
  const event = loanEvent(events, ledger, "remedy.appeal.filed", { remedy_id: ledger.remedy_id, case_id: ledger.case_id, stage: i.stage, filed_on: i.filed_on, new_information: draft.new_information, response_expected_by: rec.response_expected_by, filed_by_role: "officer", payment_timer: "suspended", suspended_timer_id: suspended }, i.at ?? noonEt(i.filed_on), i.actor);
  return { ledger: out, event, suspended_timer_id: suspended };
}
/** Fannie Mae's written response ingested: a denial of appeal 1 opens the 15-day second-appeal window, a denial of appeal 2 the 15-day impasse window. */
export function ingestAppealResponse(events: EventStore, ledger: RemedyLedger, i: { readonly stage: AppealStage; readonly outcome: "granted" | "denied"; readonly notified_on: PlainDate; readonly at?: string }): { ledger: RemedyLedger; event: DomainEvent; next: { step: string; due_on: PlainDate } | null } {
  const idx = ledger.appeals.findIndex((a) => a.stage === i.stage && a.responded_on === null); need(idx >= 0, `no open ${i.stage} on ${ledger.remedy_id}`);
  const appeals = ledger.appeals.map((a, k) => (k === idx ? { ...a, responded_on: i.notified_on, outcome: i.outcome } : a));
  const status: LadderStatus = i.outcome === "granted" ? (i.stage === "appeal_1" ? "appeal_1_granted" : "appeal_2_granted") : i.stage === "appeal_1" ? "appeal_1_denied" : "appeal_2_denied";
  const next = i.outcome === "granted" ? null : i.stage === "appeal_1" ? { step: "appeal_2 (new information only)", due_on: addDays(i.notified_on, APPEAL2_DAYS) } : { step: "impasse declaration", due_on: addDays(i.notified_on, IMPASSE_DAYS) };
  const out: RemedyLedger = { ...ledger, appeals, appeal_status: status, ...(i.outcome === "granted" ? { payment_timer: "paid" as const } : {}) };
  const event = loanEvent(events, ledger, "remedy.appeal.responded", { remedy_id: ledger.remedy_id, case_id: ledger.case_id, stage: i.stage, outcome: i.outcome, notified_on: i.notified_on, within_expectation: i.notified_on <= ledger.appeals[idx]!.response_expected_by, next_step: next?.step ?? null, next_due_on: next?.due_on ?? null }, i.at ?? noonEt(i.notified_on));
  return { ledger: out, event, next };
}
export function declareImpasse(events: EventStore, ledger: RemedyLedger, i: { readonly declared_on: PlainDate; readonly actor: Actor }): { ledger: RemedyLedger; event: DomainEvent } {
  requireRole(i.actor, ["officer"], "IMPASSE_NEEDS_PARTNER_OFFICER", "initiating the impasse process"); need(ledger.appeal_status === "appeal_2_denied", `impasse follows a denied second appeal (status ${ledger.appeal_status})`);
  const resolve_by = addDays(i.declared_on, IMPASSE_RESOLVE_DAYS);
  return { ledger: { ...ledger, appeal_status: "impasse", impasse_declared_on: i.declared_on, impasse_resolve_by: resolve_by }, event: loanEvent(events, ledger, "remedy.impasse.declared", { remedy_id: ledger.remedy_id, case_id: ledger.case_id, declared_on: i.declared_on, resolve_by }, noonEt(i.declared_on), i.actor) };
}
export function concludeImpasse(events: EventStore, ledger: RemedyLedger, i: { readonly outcome: "resolved" | "expired"; readonly concluded_on: PlainDate }): { ledger: RemedyLedger; event: DomainEvent } {
  need(ledger.appeal_status === "impasse", `no open impasse on ${ledger.remedy_id}`);
  return { ledger: { ...ledger, appeal_status: i.outcome === "resolved" ? "impasse_resolved" : "impasse_expired" }, event: loanEvent(events, ledger, "remedy.impasse.concluded", { remedy_id: ledger.remedy_id, case_id: ledger.case_id, outcome: i.outcome, concluded_on: i.concluded_on, management_escalation_by: i.outcome === "expired" ? addDays(i.concluded_on, MGMT_ESCALATION_DAYS) : null }, noonEt(i.concluded_on)) };
}
export function fileManagementEscalation(events: EventStore, ledger: RemedyLedger, i: { readonly filed_on: PlainDate; readonly actor: Actor }): { ledger: RemedyLedger; event: DomainEvent } {
  requireRole(i.actor, ["officer"], "MGMT_ESCALATION_NEEDS_PARTNER_OFFICER", "initiating the management escalation"); need(ledger.appeal_status === "impasse_expired", `management escalation follows an unresolved impasse (status ${ledger.appeal_status})`);
  return { ledger: { ...ledger, appeal_status: "management_escalation", management_escalation_filed_on: i.filed_on }, event: loanEvent(events, ledger, "remedy.management_escalation.filed", { remedy_id: ledger.remedy_id, case_id: ledger.case_id, filed_on: i.filed_on, fnma_review_by: addDays(i.filed_on, FNMA_MGMT_REVIEW_DAYS) }, noonEt(i.filed_on), i.actor) };
}
export function recordManagementEscalationDecision(events: EventStore, ledger: RemedyLedger, i: { readonly notified_on: PlainDate; readonly outcome: "upheld" | "withdrawn" }): { ledger: RemedyLedger; event: DomainEvent } {
  need(ledger.appeal_status === "management_escalation", `no open management escalation on ${ledger.remedy_id}`);
  return { ledger: { ...ledger, appeal_status: i.outcome === "withdrawn" ? "resolved" : "management_escalation_decided" }, event: loanEvent(events, ledger, "remedy.management_escalation.decided", { remedy_id: ledger.remedy_id, case_id: ledger.case_id, notified_on: i.notified_on, outcome: i.outcome, idr_by: i.outcome === "upheld" ? addDays(i.notified_on, IDR_DAYS) : null }, noonEt(i.notified_on)) };
}
export function initiateIdr(events: EventStore, ledger: RemedyLedger, i: { readonly initiated_on: PlainDate; readonly actor: Actor }): { ledger: RemedyLedger; event: DomainEvent } {
  requireRole(i.actor, ["officer"], "IDR_NEEDS_PARTNER_OFFICER", "initiating independent dispute resolution"); need(ledger.appeal_status === "management_escalation_decided", `IDR follows the management-escalation decision (status ${ledger.appeal_status})`);
  return { ledger: { ...ledger, appeal_status: "idr", idr_initiated_on: i.initiated_on }, event: loanEvent(events, ledger, "remedy.idr.initiated", { remedy_id: ledger.remedy_id, case_id: ledger.case_id, initiated_on: i.initiated_on }, noonEt(i.initiated_on), i.actor) };
}
/** The full A2-3.2-03 ladder from a demand date (rule 9 worked example: Mar 15 → May 14 / Jun 15 / Jun 30 / Aug 31 / Sep 30 / Oct 15). */
export function remedyLadder(demand_received_on: PlainDate, i: { appeal_1_filed_on?: PlainDate | undefined; appeal_1_denied_on?: PlainDate | undefined; appeal_2_denied_on?: PlainDate | undefined; impasse_declared_on?: PlainDate | undefined; management_escalation_filed_on?: PlainDate | undefined; management_decision_on?: PlainDate | undefined } = {}): Record<string, PlainDate | null> {
  return { payment_due_on: addDays(demand_received_on, REMEDY_PAYMENT_DAYS), appeal_1_due_on: addDays(demand_received_on, APPEAL1_DAYS), fnma_response_1_by: i.appeal_1_filed_on ? addDays(i.appeal_1_filed_on, FNMA_RESPONSE_DAYS) : null, appeal_2_due_on: i.appeal_1_denied_on ? addDays(i.appeal_1_denied_on, APPEAL2_DAYS) : null,
    impasse_declare_by: i.appeal_2_denied_on ? addDays(i.appeal_2_denied_on, IMPASSE_DAYS) : null, impasse_resolve_by: i.impasse_declared_on ? addDays(i.impasse_declared_on, IMPASSE_RESOLVE_DAYS) : null, management_escalation_by: i.impasse_declared_on ? addDays(addDays(i.impasse_declared_on, IMPASSE_RESOLVE_DAYS), MGMT_ESCALATION_DAYS) : null,
    fnma_management_review_by: i.management_escalation_filed_on ? addDays(i.management_escalation_filed_on, FNMA_MGMT_REVIEW_DAYS) : null, idr_by: i.management_decision_on ? addDays(i.management_decision_on, IDR_DAYS) : null };
}
export interface RepurchasePrice { readonly upb_cents: Cents; readonly accrued_interest_cents: Cents; readonly interest_days: number; readonly interest_basis: "actual/365 at the note rate"; readonly expenses_cents: Cents; readonly llpa_excluded: true; readonly llpa_cents_excluded: Cents; readonly total_cents: Cents; }
/** Rule 9: repurchase price = UPB + accrued interest at the note rate from the last paid installment date through the repurchase date + Fannie Mae's property-related expenses; LLPAs never included (A2-3.2-01). */
export function computeRepurchasePrice(i: { readonly upb_cents: Cents; readonly note_rate_pct: string; readonly interest_from: PlainDate; readonly through: PlainDate; readonly expenses_cents?: Cents; readonly llpa_cents?: Cents }): RepurchasePrice {
  need(i.upb_cents > 0n, "upb_cents must be positive"); const days = daysBetween(i.interest_from, i.through); need(days >= 0, `through ${i.through} precedes interest_from ${i.interest_from}`);
  const interest = Decimal.ratio(i.upb_cents, 1n).mul(ratePercent(i.note_rate_pct)).mul(Decimal.fromInt(days)).div(Decimal.fromInt(365)).toScaledInt(0, "HALF_UP");
  const expenses = i.expenses_cents ?? 0n;
  return { upb_cents: i.upb_cents, accrued_interest_cents: interest, interest_days: days, interest_basis: "actual/365 at the note rate", expenses_cents: expenses, llpa_excluded: true, llpa_cents_excluded: i.llpa_cents ?? 0n, total_cents: i.upb_cents + interest + expenses };
}
/** PAL = the LLPA that should have been paid at purchase (`llpa_tables` version at the purchase date) × UPB. */
export const computePalAmount = (llpa_pct: string, upb_cents: Cents): Cents => Decimal.ratio(upb_cents, 1n).mul(ratePercent(llpa_pct)).toScaledInt(0, "HALF_UP");
export interface RemedyPayment { readonly ledger: RemedyLedger; readonly event: DomainEvent; readonly entry_set: { effectiveDate: PlainDate; description: string; lines: { account: { scope: "corporate"; account: string }; amountCents: Cents; ruleRef: string }[] }; readonly warehouse: { record: AdvanceRecord; events: DomainEvent[] } | null; }
/** `payRemedy`: the partner `officer` authorizes the payment (never the agent); `remedy.paid` satisfies the payment clock; the ledger set reverses purchase proceeds (27.2 mechanics) and a repurchase repays the warehouse advance through 27.1 `completeRepurchase` (`warehouse.advance.repaid{repaid_from=partner_repurchase}`). */
export function payRemedy(events: EventStore, ledger: RemedyLedger, i: { readonly paid_at: string; readonly wire_ref: string; readonly amount_cents: Cents; readonly actor: Actor; readonly sm_indemnity_share_cents?: Cents | null; readonly advance?: AdvanceRecord | null; readonly advance_payoff_cents?: Cents }): RemedyPayment {
  requireRole(i.actor, ["officer"], "REMEDY_PAYMENT_NEEDS_PARTNER_OFFICER", "paying a demand"); nonEmpty(i.wire_ref, "wire_ref"); need(i.amount_cents > 0n, "amount_cents must be positive");
  need(ledger.paid_at === null, `remedy ${ledger.remedy_id} was paid ${ledger.paid_at}`);
  const paid_on = etDate(i.paid_at);
  const event = loanEvent(events, ledger, "remedy.paid", { remedy_id: ledger.remedy_id, case_id: ledger.case_id, remedy_type: ledger.remedy_type, amount_cents: String(i.amount_cents), paid_at: i.paid_at, paid_on, wire_ref: i.wire_ref, paid_by_role: "officer", on_time: ledger.payment_timer === "suspended" || paid_on <= ledger.payment_due_on, llpa_excluded: true, sm_indemnity_share_cents: i.sm_indemnity_share_cents === null || i.sm_indemnity_share_cents === undefined ? null : String(i.sm_indemnity_share_cents) }, i.paid_at, i.actor);
  const ruleRef = "28.2 rule 9 / A2-3.2-01";
  const entry_set = { effectiveDate: paid_on, description: `${ledger.remedy_type} remedy paid to Fannie Mae (${i.wire_ref})`, lines: [{ account: { scope: "corporate" as const, account: ledger.remedy_type === "repurchase" ? "warehouse_advance_receivable" : "remedy_expense" }, amountCents: i.amount_cents, ruleRef }, { account: { scope: "corporate" as const, account: "purchase_proceeds_receivable" }, amountCents: -i.amount_cents, ruleRef }] };
  const warehouse = ledger.remedy_type === "repurchase" && i.advance ? completeRepurchase(events, i.advance, { paid_at: i.paid_at, wire_in_ref: i.wire_ref, amount_cents: i.amount_cents, payoff_cents: i.advance_payoff_cents ?? i.amount_cents }) : null;
  return { ledger: { ...ledger, paid_at: i.paid_at, appeal_status: "paid", payment_timer: "paid", ledger_entry_id: event.id, sm_indemnity_share_cents: i.sm_indemnity_share_cents ?? null, amount_cents: i.amount_cents }, event, entry_set, warehouse };
}

// ============================================================ rule 10 / T10: the 36-payment relief tracker (A2-3.2-02)
export const LIFE_OF_LOAN_EXCLUSIONS = ["charter", "misrepresentation", "data_inaccuracy", "title_lien", "compliance_with_laws", "unacceptable_products"] as const;
export type ReliefBasis = "payment_history_36" | "fnma_full_file_qc" | "du_limited_waiver" | "d1c_component" | "value_acceptance" | "cu_2_5";
export interface ReliefTracking { readonly relief_id: string; readonly application_id: string; readonly loan_id: string; readonly component: "payment_history_36"; readonly relief_basis: ReliefBasis; readonly status: "eligible" | "at_risk" | "lost" | "confirmed_by_fnma"; readonly purchase_date: PlainDate; readonly first_payment_due: PlainDate; readonly target_36th_due_on: PlainDate; readonly payments_made: number; readonly delinquencies_30: number; readonly delinquencies_60_plus: number; readonly at_risk: boolean; readonly confirmed_at: string | null; readonly relief_report_id: string | null; readonly excluded_matters: readonly string[]; }
/** 29.4's `loan.purchased` (23.3 opens the ledger row) → the 28.2 tracker opens on the loan: `rep_warrant_relief.tracking_opened{target_36th_due_on}` carries the 36th due date (first payment + 35 months) the informational FNMA_A2_3_2_02_RELIEF_36_PAYMENTS row anchors on — `loan.purchased` itself carries no first-payment date. */
export function openReliefTracking(events: EventStore, i: { readonly application_id: string; readonly loan_id: string; readonly purchase_date: PlainDate; readonly first_payment_due: PlainDate; readonly at: string; readonly purchased_event_id?: string | null }): { row: ReliefTracking; event: DomainEvent } {
  need(i.first_payment_due > i.purchase_date, "the first payment due follows the acquisition date");
  const row: ReliefTracking = { relief_id: `rwr:${i.application_id}:payment_history_36`, application_id: i.application_id, loan_id: i.loan_id, component: "payment_history_36", relief_basis: "payment_history_36", status: "eligible", purchase_date: i.purchase_date, first_payment_due: i.first_payment_due, target_36th_due_on: RELIEF_36TH_PAYMENT(i.first_payment_due), payments_made: 0, delinquencies_30: 0, delinquencies_60_plus: 0, at_risk: false, confirmed_at: null, relief_report_id: null, excluded_matters: [...LIFE_OF_LOAN_EXCLUSIONS] };
  const event = events.append({ type: "rep_warrant_relief.tracking_opened", loanId: i.loan_id, applicationId: i.application_id, actor: AGENT, occurredAt: i.at, ...(i.purchased_event_id ? { causationId: i.purchased_event_id } : {}), payload: { relief_id: row.relief_id, component: "payment_history_36", relief_basis: "payment_history_36", purchase_date: i.purchase_date, first_payment_due: i.first_payment_due, target_36th_due_on: row.target_36th_due_on, excluded_matters: row.excluded_matters, basis_ref: "A2-3.2-02" } });
  return { row, event };
}
export interface PaymentHistoryRow { readonly installment_no: number; readonly due_date: PlainDate; readonly paid_on: PlainDate | null; readonly days_late: number; }
/** Servicing's payment history (5.1) → counts; `at_risk = delinquencies_30 ≥ 3 OR delinquencies_60_plus ≥ 1`; never `confirmed_by_fnma` from the count. */
export function trackRelief(row: ReliefTracking, history: readonly PaymentHistoryRow[], as_of: PlainDate): ReliefTracking {
  need(row.status !== "confirmed_by_fnma" && row.status !== "lost", `relief ${row.relief_id} is ${row.status}`);
  const inWindow = history.filter((h) => h.installment_no >= 1 && h.installment_no <= 36 && h.due_date <= as_of);
  const paid = inWindow.filter((h) => h.paid_on !== null).length;
  const d30 = inWindow.filter((h) => h.days_late >= 30 && h.days_late < 60).length, d60 = inWindow.filter((h) => h.days_late >= 60).length;
  const at_risk = d30 >= 3 || d60 >= 1;
  return { ...row, payments_made: paid, delinquencies_30: d30, delinquencies_60_plus: d60, at_risk, status: at_risk ? "at_risk" : "eligible" };
}
export interface ReliefReport { readonly relief_report_id: string; readonly source: "fannie_mae_connect"; readonly downloaded_by_role: string; readonly report_date: PlainDate; readonly loans: readonly { fnma_loan_number: string; relief_basis: ReliefBasis }[]; }
/** `status = confirmed_by_fnma` only from a parsed Fannie Mae relief report that lists the loan (never from the platform's own 36-payment count); emits 29.4's `rep_warrant_relief.confirmed`. */
export function confirmReliefFromReport(events: EventStore, row: ReliefTracking, fnma_loan_number: string, report: ReliefReport | null, at: string): { row: ReliefTracking; event: DomainEvent } {
  if (!report) throw new QcRefusal("RELIEF_REPORT_REQUIRED", "relief is confirmed only from Fannie Mae's relief report — the platform's own 36-payment count never confirms it");
  need(report.source === "fannie_mae_connect" && report.downloaded_by_role === "fnma_portal_operator", "the relief report is downloaded from Fannie Mae Connect by the fnma_portal_operator");
  const listed = report.loans.find((l) => l.fnma_loan_number === fnma_loan_number); if (!listed) throw new QcRefusal("LOAN_NOT_ON_RELIEF_REPORT", `${fnma_loan_number} is not listed on relief report ${report.relief_report_id}`);
  const out: ReliefTracking = { ...row, status: "confirmed_by_fnma", confirmed_at: at, relief_report_id: report.relief_report_id, relief_basis: listed.relief_basis };
  const event = loanEvent(events, row, "rep_warrant_relief.confirmed", { relief_id: row.relief_id, component: row.component, fnma_report_id: report.relief_report_id, relief_report_id: report.relief_report_id, relief_basis: listed.relief_basis, confirmed_at: at, excluded_matters: row.excluded_matters }, at);
  return { row: out, event };
}
export function loseRelief(events: EventStore, row: ReliefTracking, i: { readonly finding: string; readonly qc_case_id: string | null; readonly at: string }): { row: ReliefTracking; event: DomainEvent } {
  return { row: { ...row, status: "lost" }, event: loanEvent(events, row, "rep_warrant_relief.lost", { relief_id: row.relief_id, component: row.component, finding: i.finding, qc_case_id: i.qc_case_id, owner: "28.2" }, i.at) };
}

// ============================================================ fraud referral (28.4 owns the A3-4-03 clock) and the decision record
export function referToFraud(events: EventStore, r: QcReview, i: { readonly indicators: readonly string[]; readonly at: string }): DomainEvent {
  need(i.indicators.length > 0, "a fraud referral names its indicators");
  return loanEvent(events, r, "qc.fraud.referred", { review_id: r.review_id, indicators: i.indicators, escalate_to: "bsa_officer", owner: "28.4", note: "28.4 evaluates; its fnma.fraud.reasonable_basis starts FNMA_A3_4_03_FRAUD_SELF_REPORT_30 — not this process" }, i.at);
}
export const QC_WRITABLE_TABLES = ["qc_cycles", "qc_reviews", "qc_findings", "qc_reverifications", "qc_reports", "fnma_qc_cases", "qc_self_reports", "remedy_ledger", "rep_warrant_relief", "escalations", "agent_decisions", "loan_events"] as const;
export const qcAuditMayWrite28_2 = (table: string): boolean => (QC_WRITABLE_TABLES as readonly string[]).includes(table);
export const FORBIDDEN_READS = ["applicant_demographics", "restricted_fl.applicant_demographics"] as const;
export interface DecisionRecord28_2 { readonly review_id: string | null; readonly case_id: string | null; readonly cycle_id: string | null; readonly scope_rationale: readonly string[]; readonly reverifications: readonly { kind: string; source: string; requested_at: PlainDate; result: string | null }[]; readonly findings: readonly string[]; readonly reunderwrite: { du_shadow_casefile_id: string; dti_before: string; dti_after: string; eligible: boolean } | null; readonly self_report: { required: boolean; confirmed_at: string | null; due_at: PlainDate | null } | null; readonly package: { form_1032_index: readonly string[]; hash: string; page_count: number } | null; readonly timers: readonly string[]; readonly escalations: readonly string[]; readonly rule_set_versions: readonly string[]; readonly model_version: string; readonly prompt_version: string; readonly inputs_hash: string; readonly rationale: string; readonly confidence: number; readonly demographic_fields_read: 0; }
export function decisionRecord28_2(i: Partial<Omit<DecisionRecord28_2, "inputs_hash" | "demographic_fields_read" | "rule_set_versions">> & { readonly inputs: Record<string, unknown>; readonly rationale: string; readonly model_version: string; readonly prompt_version: string; readonly confidence: number }): DecisionRecord28_2 {
  need(i.confidence >= 0 && i.confidence <= 1, "confidence is a proportion"); nonEmpty(i.rationale, "rationale");
  const keys = JSON.stringify(i.inputs); need(!FORBIDDEN_READS.some((f) => keys.includes(f)), "the QC agent never reads applicant_demographics");
  return { review_id: i.review_id ?? null, case_id: i.case_id ?? null, cycle_id: i.cycle_id ?? null, scope_rationale: i.scope_rationale ?? [], reverifications: i.reverifications ?? [], findings: i.findings ?? [], reunderwrite: i.reunderwrite ?? null, self_report: i.self_report ?? null, package: i.package ?? null, timers: i.timers ?? [], escalations: i.escalations ?? [],
    rule_set_versions: [RULE_SET_28_2, TAXONOMY_28_2], model_version: i.model_version, prompt_version: i.prompt_version, inputs_hash: sha256(keys), rationale: i.rationale, confidence: i.confidence, demographic_fields_read: 0 };
}
