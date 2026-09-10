/**
 * §5.4 operating rules over the SDA calculators (./sda.ts, ./ops.ts) and the event vocabulary every 5.4 timer row arms
 * on and is satisfied by. The tools in src/app/tools/section5-4.ts are thin shells over these:
 *   - rule 2 / T1 entry model: `sdaEntryModel` — the period in which the loan is four consecutive months delinquent is
 *     `predicted_entry_period`; Fannie Mae sets Stop Advance at BD2 of the following month with a Start Date of the 1st of
 *     that month, so the CD18 draft of that month (the 4th advance) is the last advanced and the CD18 draft of the month
 *     after is the first the funding gate excludes (5.4-T1: 2027-03 → Apr 2 / Apr 1 / Apr 16 / Tue May 18, 2027);
 *   - the period-end prediction run (FNMA_C301_SDA_PREDICT_EOM): `predictSdaEntries` → `sda_status.predicted` set per
 *     special-servicing S/S loan reaching four months, `sda_status.prediction_cleared` when a predicted loan drops below
 *     four before Fannie Mae sets the status, `reclass.selection.expected{servicing_option=regular}` for a regular
 *     servicing option loan at six consecutive months (A1-3-06), and one period-level `sda_status.predicted{scope=period}`
 *     on the period subject once every loan is set/cleared;
 *   - inbound Fannie Mae Connect reports (Integrations: inbound only): `validateConnectReport` / `ingestConnectReport` →
 *     `fnma.connect.report.available{report}` (Remittance Detail – P&I carrying Stop Advance Status/Start/Expiration and
 *     outstanding receivables = `sda_status`; Cash Adjustments; Eligible for Deselection, which also posts one
 *     `reclass.deselection.eligible` per listed loan — the CD11 decision task, due CD15);
 *   - BD3 reconciliation (FNMA_F120_SDA_STATUS_RECONCILE_BD3): `reconcileSdaReport` — every predicted/active loan against
 *     Fannie Mae's status; `sda_status.active` is set only from Fannie Mae data (state machine guard); a mismatch is the
 *     T6 sev-2 variance; `sda_status.reconciled` per loan and `sda_status.reconciled{all_reconciled=true}` on the report;
 *   - rule 4: `recordSdaContractualPayment` (only full contractual payments count → `sda.contractual_payment.applied`,
 *     the LAR clock on the 5.1 next-BD 20:00 ET deadline), `expectSdaRecovery` on the accepted LAR →
 *     `sda.recovery.expected` (Fannie Mae recovers its receivable first, then the servicer retains),
 *     `matchRecoveryDraft` → `sda.adjustment.matched{kind}` (+ `remittances.drafted{sda_recovery=true}` when the custodial
 *     debit settled, which releases the collected P&I);
 *   - rule 5 exits: `recordSdaExit` → `sda_status.exited{reason, exited_on, period_end}` (current → scheduled drafts
 *     resume at the next CD18, `resumeScheduledDraft` funds it through 5.2's funding check; deferral/reclass/liquidation →
 *     reimbursement within two cycles, `matchReimbursementCredits` → `advances.reimbursed_by_fnma{all_outstanding=true}`
 *     or the IRR package; payoff/repurchase → Fannie Mae drafts its receivable from the proceeds, `sdaPayoffRemittance`);
 *   - reclass interplay: `ingestPurchaseAdvice` → `fnma.purchase_advice.received{kind=reclass}`,
 *     `recordDeselectionDecision` → `reclass.deselection.decided{decision}` (`human_portal_task` when deselecting).
 *
 * Subjects: loan-level facts carry `loanId`; a Connect report is `{kind: "fnma_report", id: report_id}`; the period-end
 * run reports on the period subject the `period.month_end` trigger carried.
 */
import type { Cents } from "../../kernel/money/cents.ts";
import { type PlainDate, addMonths, endOfMonth, parts, ymd, plainDate } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, toIso, wallClock } from "../../kernel/calendar/zoned.ts";
import type { DomainEvent } from "../../kernel/events/index.ts";
import type { ScheduledMonth } from "./remittance.ts";
import { type SdaState, type SdaStatus, predictSda, consecutiveMonthsDelinquent, sdaApplies, applyRecovery, fmReceivableForPeriods } from "./sda.ts";
import { period as periodOf, nextMonth, calendarDraftDate, fannieBusinessDay, periodStart, larDeadlineMs } from "./period.ts";
import { ET, matchReimbursements, sdaStatusVariance, sdaPayoffRemittance, advanceTransfer, type AdvanceRow, type AdvanceTransfer } from "./ops.ts";
import { advanceEntrySet, cycleSubject, type Emitter, type Subject, type Cycle } from "./ops-5-2.ts";
import type { EntrySetInput } from "../../kernel/ledger/ledger.ts";
import type { EventStore } from "../../kernel/events/index.ts";

export const RULE_SET_VERSION_5_4 = "5.4@ops.v1";
export type ServicingOption = "special" | "regular";
export type RemittanceTypeUpper = "AA" | "SA" | "SS";
export type SdaExitReason = "current" | "deferral" | "reclass" | "payoff" | "repurchase" | "liquidation";
export type { Emitter, Subject };

const isoDate = (s: unknown): s is PlainDate => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const asPeriod = (s: string): string => { if (!/^\d{4}-\d{2}$/.test(s)) throw new RangeError(`period ${s} is not YYYY-MM`); return s; };
const etDate = (ms: number): PlainDate => wallClock(ms, ET).date;
export const reportSubject = (reportId: string): Subject => ({ kind: "fnma_report", id: reportId });
/** The period subject 5.1's `period.month_end` emitter arms the month-end rows on (ops-5-1.ts `periodAggregate`: `{kind: period, id: "<servicer>:<period>"}`) — the period-level run must report on the same subject to satisfy FNMA_C301_SDA_PREDICT_EOM. */
export const periodSubject54 = (servicerNumber: string, period: string): Subject => { if (!/^\d{9}$/.test(servicerNumber)) throw new RangeError("servicer_number (9 digits) is required to address the period subject"); return { kind: "period", id: `${servicerNumber}:${period}` }; };
/** BD3 12:00 ET of the month after the activity period — when the Remittance Detail must be reconciled (timer table). */
export function bd3ReconcileMs(period: string): number { return zonedEpochMs(fannieBusinessDay(nextMonth(periodStart(asPeriod(period))), 3), "12:00", ET); }
/** Two S/S draft cycles from a date: the CD18 draft (preceding `fannie_et` BD) of the month after next. */
export function twoCyclesFrom(d: PlainDate): PlainDate { return calendarDraftDate(nextMonth(nextMonth(d)), 18); }

/** Stop Advance as Fannie Mae reported it, read from the loan's `sda_status.*` history (`active` is set only from Fannie Mae data). */
export function sdaStatusFromEvents(events: readonly DomainEvent[]): { status: SdaStatus; reason: string | null; last: DomainEvent | null } {
  const moves = events.filter((e) => e.type === "sda_status.predicted" || e.type === "sda_status.prediction_cleared" || e.type === "sda_status.active" || e.type === "sda_status.exited");
  const last = moves[moves.length - 1];
  if (!last) return { status: "not_applicable", reason: null, last: null };
  const status: SdaStatus = last.type === "sda_status.active" ? "active" : last.type === "sda_status.predicted" ? "predicted" : last.type === "sda_status.exited" ? "exited" : "not_applicable";
  return { status, reason: typeof last.payload.reason === "string" ? last.payload.reason : null, last };
}
/** Every loan the event store shows in the process (latest move `predicted` or `active`) — the population a period-end run and a BD3 reconciliation must cover. */
export function sdaLoansInProcess(events: EventStore): Map<string, SdaStatus> {
  const ids = new Set<string>();
  for (const t of ["sda_status.predicted", "sda_status.active"]) for (const e of events.ofType(t)) if (e.loanId) ids.add(e.loanId);
  const out = new Map<string, SdaStatus>();
  for (const id of ids) { const st = sdaStatusFromEvents(events.byLoan(id)).status; if (st === "predicted" || st === "active") out.set(id, st); }
  return out;
}

// ───── rule 2 / T1: the entry model ─────
export interface SdaEntryModel { readonly predicted_entry_period: string; readonly stop_advance_set_on: PlainDate; readonly fnma_start_date: PlainDate; readonly last_advanced_draft: PlainDate; readonly first_excluded_draft: PlainDate; }
/**
 * Four-advance model (Open question 1 default): the loan is four months delinquent at the end of `predictedEntryPeriod`; Fannie Mae
 * reads that at BD2 of the following month and sets Stop Advance with a Start Date of the 1st of that month; that month's CD18
 * draft (the 4th advance, for the entry period's activity) is still advanced and the next CD18 draft is the first one excluded.
 */
export function sdaEntryModel(predictedEntryPeriod: string): SdaEntryModel {
  const following = nextMonth(periodStart(asPeriod(predictedEntryPeriod)));
  return { predicted_entry_period: predictedEntryPeriod, stop_advance_set_on: fannieBusinessDay(following, 2), fnma_start_date: following, last_advanced_draft: calendarDraftDate(following, 18), first_excluded_draft: calendarDraftDate(nextMonth(following), 18) };
}

// ───── FNMA_C301_SDA_PREDICT_EOM: the period-end prediction run ─────
export interface EomLoanFacts { readonly loan_id: string; readonly lpi: PlainDate; readonly remittance_type: RemittanceTypeUpper; readonly servicing_option: ServicingOption; readonly prior_status: SdaStatus; readonly reclass_selection_expected?: boolean; }
export interface EomLoanResult { readonly loan_id: string; readonly status: SdaStatus; readonly consecutive_months_delinquent: number; readonly predicted_entry_period: string | null; readonly action: "set" | "cleared" | "kept" | "none"; readonly reclass_selection_expected: boolean; readonly entry_model: SdaEntryModel | null; }
/**
 * The period-end run reports on the servicer's period subject (`servicer_number`, or an explicit `period_subject`), and "set/cleared for
 * every special-servicing S/S loan" is checked, not assumed: every loan the event store shows `predicted`/`active` must be in `loans`
 * (else RangeError before anything is appended), and a caller's `prior_status` may not contradict the loan's recorded history. The
 * period-level fact carries `next_period_end`, the anchor the recurring row re-arms on (the next last-calendar-day 23:59 ET).
 */
export function predictSdaEntries(em: Emitter, i: { period_end: PlainDate; loans: readonly EomLoanFacts[]; servicer_number?: string; period_subject?: Subject }): { period: string; subject: Subject; results: EomLoanResult[]; set: number; cleared: number; reclass_selection_expected: string[]; next_period_end: PlainDate } {
  if (!isoDate(i.period_end) || i.period_end !== endOfMonth(i.period_end)) throw new RangeError(`${i.period_end} is not a period end (last calendar day)`);
  if (!i.loans.length) throw new RangeError("the period-end run needs at least one loan");
  const period = periodOf(i.period_end);
  const subject = i.period_subject ?? periodSubject54(i.servicer_number ?? "", period);
  const inProcess = sdaLoansInProcess(em.events);
  const missing = [...inProcess.keys()].filter((id) => !i.loans.some((l) => l.loan_id === id));
  if (missing.length) throw new RangeError(`the period-end run must cover every predicted/active loan; missing ${missing.join(", ")}`);
  for (const l of i.loans) { const hist = sdaStatusFromEvents(em.events.byLoan(l.loan_id)); if (hist.last && hist.status !== l.prior_status) throw new RangeError(`${l.loan_id}: prior_status ${l.prior_status} contradicts the loan's recorded Stop Advance status ${hist.status}`); }
  const nextPeriodEnd = endOfMonth(nextMonth(i.period_end));
  const results: EomLoanResult[] = []; const reclass: string[] = [];
  for (const l of i.loans) {
    if (!isoDate(l.lpi)) throw new RangeError(`${l.loan_id}: lpi must be YYYY-MM-DD`);
    const months = consecutiveMonthsDelinquent(l.lpi, i.period_end);
    const pred = predictSda(l.lpi, l.remittance_type, l.servicing_option, i.period_end);
    let action: EomLoanResult["action"] = "none"; let status: SdaStatus = pred.status; let model: SdaEntryModel | null = null;
    if (sdaApplies(l.remittance_type, l.servicing_option)) {
      if (l.prior_status === "active") { status = "active"; action = "kept"; }                       // Fannie Mae's status is authoritative; only the BD3 reconciliation moves it
      else if (pred.status === "predicted") {
        model = sdaEntryModel(pred.predicted_entry_period!);
        if (l.prior_status === "predicted") action = "kept";
        else { action = "set"; em.events.append({ type: "sda_status.predicted", loanId: l.loan_id, actor: em.actor, payload: { prediction: "set", period, period_end: i.period_end, consecutive_months_delinquent: months, lpi: l.lpi, ...model, predicted_at: em.now } }); }
      } else if (l.prior_status === "predicted") { action = "cleared"; em.events.append({ type: "sda_status.prediction_cleared", loanId: l.loan_id, actor: em.actor, payload: { prediction: "cleared", period, period_end: i.period_end, consecutive_months_delinquent: months, lpi: l.lpi, cleared_at: em.now } }); }
    }
    // rule 1 / A1-3-06: regular servicing option S/S loans advance until removal; six consecutive months → reclass selection expected, deselection window CD11–CD15
    let expected = l.reclass_selection_expected === true;
    if (l.remittance_type === "SS" && l.servicing_option === "regular" && months >= 6 && !expected) {
      expected = true; reclass.push(l.loan_id); const { y, m } = parts(nextMonth(i.period_end));
      em.events.append({ type: "reclass.selection.expected", loanId: l.loan_id, actor: em.actor, payload: { servicing_option: "regular", remittance_type: "SS", consecutive_months_delinquent: months, period, period_end: i.period_end, lpi: l.lpi, deselection_window: { created_on: ymd(y, m, 11), due_on: ymd(y, m, 15) }, expected_at: em.now } });
    }
    results.push({ loan_id: l.loan_id, status, consecutive_months_delinquent: months, predicted_entry_period: pred.predicted_entry_period, action, reclass_selection_expected: expected, entry_model: model });
  }
  const set = results.filter((r) => r.action === "set").length, cleared = results.filter((r) => r.action === "cleared").length;
  em.events.append({ type: "sda_status.predicted", aggregate: subject, actor: em.actor, payload: { scope: "period", period, period_end: i.period_end, next_period_end: nextPeriodEnd, loans_evaluated: results.length, in_process_covered: inProcess.size, set, cleared, kept: results.filter((r) => r.action === "kept").length, reclass_selection_expected: reclass, run_at: em.now } });
  return { period, subject, results, set, cleared, reclass_selection_expected: reclass, next_period_end: nextPeriodEnd };
}

// ───── inbound Fannie Mae Connect reports ─────
export type ConnectReportKind = "sda_status" | "cash_adjustments" | "eligible_for_deselection";
export interface ConnectReportLoan { readonly fnma_loan_number: string; readonly loan_id: string | null; readonly stop_advance_status: "stop_advance" | "advancing" | null; readonly start_date: PlainDate | null; readonly adjusted_start_date: PlainDate | null; readonly expiration_date: PlainDate | null; readonly outstanding_pi_receivable_cents: Cents; readonly lpi: PlainDate | null; readonly amount_cents: Cents | null; readonly adjustment_type: string | null; }
export interface ConnectReportRow { readonly report: ConnectReportKind; readonly report_id: string; readonly period: string; readonly posted_on: PlainDate; readonly source: "api" | "connect_pull"; readonly document_id: string | null; readonly loans: readonly ConnectReportLoan[]; }
export function validateConnectReport(r: Record<string, unknown>): ConnectReportRow {
  const s = (k: string): string => { const v = r[k]; if (typeof v !== "string" || v === "") throw new RangeError(`connect report: ${k} is required`); return v; };
  const c = (v: unknown, k: string): Cents => { try { return typeof v === "bigint" ? v : BigInt(String(v)); } catch { throw new RangeError(`connect report: ${k} is not an amount in cents`); } };
  const d = (v: unknown, k: string): PlainDate | null => { if (v === undefined || v === null || v === "") return null; if (!isoDate(v)) throw new RangeError(`connect report: ${k} must be YYYY-MM-DD`); return plainDate(v); };
  const report = s("report"); if (report !== "sda_status" && report !== "cash_adjustments" && report !== "eligible_for_deselection") throw new RangeError("connect report: report must be sda_status (Remittance Detail – P&I), cash_adjustments or eligible_for_deselection");
  const source = typeof r.source === "string" && r.source !== "" ? r.source : "connect_pull"; if (source !== "api" && source !== "connect_pull") throw new RangeError("connect report: source must be api or connect_pull");
  const posted = s("posted_on"); if (!isoDate(posted)) throw new RangeError("connect report: posted_on must be YYYY-MM-DD");
  const rows = Array.isArray(r.loans) ? (r.loans as Record<string, unknown>[]) : [];
  const loans = rows.map((x, n) => {
    const ln = x.fnma_loan_number; if (typeof ln !== "string" || !/^\d{1,10}$/.test(ln)) throw new RangeError(`connect report: loans[${n}].fnma_loan_number`);
    const raw = x.stop_advance_status ?? null; if (raw !== null && raw !== "stop_advance" && raw !== "advancing") throw new RangeError(`connect report: loans[${n}].stop_advance_status must be stop_advance or advancing`);
    const st = raw as "stop_advance" | "advancing" | null;
    if (report === "sda_status" && st === null) throw new RangeError(`connect report: loans[${n}].stop_advance_status is required on the Remittance Detail – P&I`);
    return { fnma_loan_number: ln, loan_id: typeof x.loan_id === "string" && x.loan_id !== "" ? x.loan_id : null, stop_advance_status: st, start_date: d(x.start_date, `loans[${n}].start_date`), adjusted_start_date: d(x.adjusted_start_date, `loans[${n}].adjusted_start_date`), expiration_date: d(x.expiration_date, `loans[${n}].expiration_date`),
      outstanding_pi_receivable_cents: x.outstanding_pi_receivable_cents === undefined || x.outstanding_pi_receivable_cents === null ? 0n : c(x.outstanding_pi_receivable_cents, `loans[${n}].outstanding_pi_receivable_cents`), lpi: d(x.lpi, `loans[${n}].lpi`), amount_cents: x.amount_cents === undefined || x.amount_cents === null ? null : c(x.amount_cents, `loans[${n}].amount_cents`), adjustment_type: typeof x.adjustment_type === "string" ? x.adjustment_type : null };
  });
  const period = typeof r.period === "string" && /^\d{4}-\d{2}$/.test(r.period) ? r.period : periodOf(addMonths(plainDate(posted), -1));
  return { report, report_id: typeof r.report_id === "string" && r.report_id !== "" ? r.report_id : `${report}-${period}-${posted}`, period, posted_on: plainDate(posted), source, document_id: typeof r.document_id === "string" ? r.document_id : null, loans };
}
/** `fnma.connect.report.available{report}` on the report subject; the deselection report also posts the per-loan CD11 decision task (`reclass.deselection.eligible`, act by CD15 — F-1-25). */
export function ingestConnectReport(em: Emitter, row: ConnectReportRow): { subject: Subject; reconcile_by_at: string | null; decide_by: PlainDate | null; eligible: string[]; unmapped: string[] } {
  const subject = reportSubject(row.report_id);
  const reconcileBy = row.report === "eligible_for_deselection" ? null : toIso(bd3ReconcileMs(row.period));
  const { y, m } = parts(row.posted_on); const decideBy = row.report === "eligible_for_deselection" ? ymd(y, m, 15) : null;
  em.events.append({ type: "fnma.connect.report.available", aggregate: subject, actor: em.actor, payload: { report: row.report, report_id: row.report_id, period: row.period, period_end: endOfMonth(periodStart(row.period)), posted_on: row.posted_on, source: row.source, document_id: row.document_id, loan_count: row.loans.length, received_at: em.now, reconcile_by_at: reconcileBy, decide_by: decideBy } });
  const eligible: string[] = []; const unmapped: string[] = [];
  for (const l of row.loans) {
    if (!l.loan_id) { unmapped.push(l.fnma_loan_number); continue; }
    if (row.report === "eligible_for_deselection") {
      eligible.push(l.loan_id);
      em.events.append({ type: "reclass.deselection.eligible", loanId: l.loan_id, aggregate: subject, actor: em.actor, payload: { report_id: row.report_id, fnma_loan_number: l.fnma_loan_number, period: row.period, posted_on: row.posted_on, decide_by: decideBy, task: "deselection_decision", portal_task_if_deselecting: true } });
    } else {
      // Fannie Mae's line for the loan (Stop Advance Status/Start/Adjusted Start/Expiration, outstanding receivable, LPI; a Cash Adjustments amount/type) — what the BD3 reconciliation checks each loan against and the population it must cover
      em.events.append({ type: "fnma.connect.report.line", loanId: l.loan_id, aggregate: subject, actor: em.actor, payload: { report: row.report, report_id: row.report_id, period: row.period, posted_on: row.posted_on, fnma_loan_number: l.fnma_loan_number, stop_advance_status: l.stop_advance_status, start_date: l.start_date, adjusted_start_date: l.adjusted_start_date, expiration_date: l.expiration_date, outstanding_pi_receivable_cents: l.outstanding_pi_receivable_cents, lpi: l.lpi, amount_cents: l.amount_cents, adjustment_type: l.adjustment_type, document_id: row.document_id } });
    }
  }
  return { subject, reconcile_by_at: reconcileBy, decide_by: decideBy, eligible, unmapped };
}
/** The Remittance Detail – P&I lines ingested for a report, by loan. */
export function reportLines(events: EventStore, reportId: string): Map<string, FnmaSdaLine> {
  const out = new Map<string, FnmaSdaLine>();
  for (const e of events.ofType("fnma.connect.report.line")) {
    const p = e.payload as { report?: unknown; report_id?: unknown; stop_advance_status?: unknown; start_date?: unknown; adjusted_start_date?: unknown; expiration_date?: unknown; outstanding_pi_receivable_cents?: unknown; lpi?: unknown };
    if (!e.loanId || p.report !== "sda_status" || p.report_id !== reportId || (p.stop_advance_status !== "stop_advance" && p.stop_advance_status !== "advancing")) continue;
    const d = (v: unknown): PlainDate | null => (isoDate(v) ? v : null);
    out.set(e.loanId, { status: p.stop_advance_status, start_date: d(p.start_date), adjusted_start_date: d(p.adjusted_start_date), expiration_date: d(p.expiration_date), outstanding_pi_receivable_cents: typeof p.outstanding_pi_receivable_cents === "bigint" ? p.outstanding_pi_receivable_cents : BigInt(String(p.outstanding_pi_receivable_cents ?? 0)), lpi: d(p.lpi) });
  }
  return out;
}

// ───── FNMA_F120_SDA_STATUS_RECONCILE_BD3: every predicted/active loan against Fannie Mae's status ─────
export interface FnmaSdaLine { readonly status: "stop_advance" | "advancing"; readonly start_date: PlainDate | null; readonly adjusted_start_date: PlainDate | null; readonly expiration_date: PlainDate | null; readonly outstanding_pi_receivable_cents: Cents; readonly lpi: PlainDate | null; }
export interface SdaReconcileLoan { readonly loan_id: string; readonly our_status: SdaStatus; readonly predicted_months: number; readonly our_lpi: PlainDate; readonly fnma: FnmaSdaLine | null; readonly fm_pi_receivable_computed_cents: Cents; readonly servicer_advances_outstanding_cents: Cents; readonly reporting_history: readonly { period: string; lpi: PlainDate; status: string }[]; readonly adjustments_matched?: readonly string[]; }
/** The Agents-paragraph decision record, one per loan and cycle. */
export interface SdaDecisionRecord { readonly loan_id: string; readonly period: string; readonly predicted_status: SdaStatus; readonly fnma_status: "stop_advance" | "advancing" | "not_on_report"; readonly fm_receivable_reported: Cents; readonly fm_receivable_computed: Cents; readonly servicer_advances_outstanding: Cents; readonly adjustments_matched: readonly string[]; readonly variance: { kind: string; severity: "sev2"; our_lpi: PlainDate; fnma_lpi: PlainDate | null; receivable_variance_cents: Cents } | null; readonly action: "confirm" | "activate" | "open_sev2_variance"; readonly status_after: SdaStatus; }
/**
 * "Every predicted/active loan reconciled to Fannie Mae's status" is verified before anything is appended: the report must have been
 * ingested (`fnma.connect.report.available{report=sda_status}` for `report_id`), `loans` must cover every loan the event store shows
 * `predicted`/`active` and every loan the report lists as Stop Advance, and a loan's `fnma` line may not contradict the ingested line
 * (an omitted `fnma` is filled from it). Only then is `sda.reconciled{all_reconciled=true}` posted on the report subject.
 */
export function reconcileSdaReport(em: Emitter, i: { report_id: string; period: string; loans: readonly SdaReconcileLoan[] }): { subject: Subject; decisions: SdaDecisionRecord[]; activated: string[]; variances: SdaDecisionRecord[]; all_reconciled: true; covered: string[] } {
  asPeriod(i.period); if (!i.report_id) throw new RangeError("report_id is required");
  if (!i.loans.length) throw new RangeError("the BD3 reconciliation needs the predicted/active loans");
  const subject = reportSubject(i.report_id); const decisions: SdaDecisionRecord[] = []; const activated: string[] = [];
  if (!em.events.ofType("fnma.connect.report.available").some((e) => e.aggregate?.kind === subject.kind && e.aggregate.id === subject.id && (e.payload as { report?: unknown }).report === "sda_status")) throw new RangeError(`Remittance Detail – P&I report ${i.report_id} has not been ingested (parseRemittanceDetail{op=ingest})`);
  const lines = reportLines(em.events, i.report_id); const inProcess = sdaLoansInProcess(em.events);
  const expected = new Set<string>([...inProcess.keys(), ...[...lines].filter(([, l]) => l.status === "stop_advance").map(([id]) => id)]);
  const missing = [...expected].filter((id) => !i.loans.some((l) => l.loan_id === id));
  if (missing.length) throw new RangeError(`the BD3 reconciliation must cover every predicted/active loan and every loan the report shows Stop Advance; missing ${missing.join(", ")}`);
  const loans = i.loans.map((l) => { const line = lines.get(l.loan_id) ?? null; if (l.fnma && line && l.fnma.status !== line.status) throw new RangeError(`${l.loan_id}: fnma.status ${l.fnma.status} contradicts the ingested report line (${line.status})`); return l.fnma || !line ? l : { ...l, fnma: line }; });
  for (const l of loans) {
    const fnmaStatus = l.fnma?.status ?? "advancing";
    const v = sdaStatusVariance({ predicted: l.our_status, predicted_months: l.predicted_months, fnma_status: fnmaStatus, our_lpi: l.our_lpi, fnma_lpi: l.fnma?.lpi ?? null, reporting_history: l.reporting_history });
    const reported = l.fnma?.outstanding_pi_receivable_cents ?? 0n; const recvVar = reported - l.fm_pi_receivable_computed_cents;
    let after: SdaStatus = l.our_status; let action: SdaDecisionRecord["action"] = "confirm";
    if (fnmaStatus === "stop_advance" && l.our_status !== "active") {           // state machine guard: `active` is set only from Fannie Mae data
      after = "active"; action = "activate"; activated.push(l.loan_id);
      em.events.append({ type: "sda_status.active", loanId: l.loan_id, actor: em.actor, payload: { report_id: i.report_id, period: i.period, start_date: l.fnma!.start_date, adjusted_start_date: l.fnma!.adjusted_start_date, expiration_date: l.fnma!.expiration_date, fm_pi_receivable_cents: reported, entered_from: l.our_status, activated_at: em.now } });
    }
    const variance = v.variance ? { kind: v.variance.kind, severity: v.variance.severity, our_lpi: v.variance.our_lpi, fnma_lpi: v.variance.fnma_lpi, receivable_variance_cents: recvVar } : recvVar !== 0n && l.our_status === "active" ? { kind: "receivable_mismatch", severity: "sev2" as const, our_lpi: l.our_lpi, fnma_lpi: l.fnma?.lpi ?? null, receivable_variance_cents: recvVar } : null;
    if (variance) action = "open_sev2_variance";
    const rec: SdaDecisionRecord = { loan_id: l.loan_id, period: i.period, predicted_status: l.our_status, fnma_status: l.fnma ? fnmaStatus : "not_on_report", fm_receivable_reported: reported, fm_receivable_computed: l.fm_pi_receivable_computed_cents, servicer_advances_outstanding: l.servicer_advances_outstanding_cents, adjustments_matched: l.adjustments_matched ?? [], variance, action, status_after: after };
    decisions.push(rec);
    // `sda.reconciled` (not `sda_status.*`): reconciliation updates `sda_status.last_reconciled_report_id`, it is not a status move — readers of the loan's `sda_status.*` history (the 5.2/5.4 NO_ADVANCE_ON_STOP_ADVANCE gate) must keep seeing `active` as the last move
    em.events.append({ type: "sda.reconciled", loanId: l.loan_id, actor: em.actor, payload: { report_id: i.report_id, period: i.period, fnma_status: rec.fnma_status, status_after: after, fm_pi_receivable_reported_cents: reported, fm_pi_receivable_computed_cents: l.fm_pi_receivable_computed_cents, receivable_variance_cents: recvVar, variance: variance ? variance.kind : null, severity: variance ? variance.severity : null, action, reporting_history: l.reporting_history.length, reconciled_at: em.now } });
  }
  const variances = decisions.filter((d) => d.variance !== null);
  em.events.append({ type: "sda.reconciled", aggregate: subject, actor: em.actor, payload: { all_reconciled: true, report_id: i.report_id, period: i.period, loans_reconciled: decisions.length, expected_loans: [...expected], activated, variances: variances.map((d) => d.loan_id), reconciled_at: em.now } });
  return { subject, decisions, activated, variances, all_reconciled: true, covered: [...expected] };
}

// ───── rule 4: contractual payments during SDA ─────
export interface AppliedInstallment { readonly payment_id: string; readonly installment_due_date: PlainDate; readonly interest_cents: Cents; readonly principal_cents: Cents; readonly processed_at: string; }
/**
 * Only full contractual payments count (partials sit in suspense — Section 2 rule): each applied installment must carry the
 * full P&I and the installments must run consecutively from the LPI. `sda.contractual_payment.applied{sda_active, contractual,
 * processed_at}` arms FNMA_IRM_SDA_CONTRACTUAL_LAR_NEXTBD_2000 on the 5.1 clock (next BD 20:00 ET from processed_at).
 */
export function recordSdaContractualPayment(em: Emitter, i: { loan_id: string; state: SdaState; pi_cents: Cents; lpi_before: PlainDate; installments: readonly AppliedInstallment[] }): { lpi_after: PlainDate; installments: number; total_cents: Cents; processed_at: string; lar_due_at: string } {
  if (i.state.status !== "active") throw new RangeError(`loan ${i.loan_id} is not in the Stop Delinquency Advance process (status ${i.state.status})`);
  if (!i.installments.length) throw new RangeError("at least one applied installment is required");
  if (i.pi_cents <= 0n) throw new RangeError("pi_cents must be positive");
  let due = addMonths(i.lpi_before, 1); let total = 0n; let latest = 0;
  for (const p of i.installments) {
    if (p.interest_cents + p.principal_cents !== i.pi_cents) throw new RangeError(`${p.payment_id}: ${p.installment_due_date} is not a full contractual payment (partial funds sit in suspense until a full installment accrues)`);
    if (p.installment_due_date !== due) throw new RangeError(`${p.payment_id}: installment ${p.installment_due_date} is out of sequence (expected ${due})`);
    const ms = Date.parse(p.processed_at); if (Number.isNaN(ms)) throw new RangeError(`${p.payment_id}: processed_at is not an instant`);
    total += p.interest_cents + p.principal_cents; latest = Math.max(latest, ms); due = addMonths(due, 1);
  }
  const lpiAfter = addMonths(i.lpi_before, i.installments.length); const processedAt = toIso(latest); const larDue = toIso(larDeadlineMs(latest, false));
  em.events.append({ type: "sda.contractual_payment.applied", loanId: i.loan_id, actor: em.actor, payload: { sda_active: true, contractual: true, processed_at: processedAt, installments: i.installments.length, payment_ids: i.installments.map((p) => p.payment_id), lpi_before: i.lpi_before, lpi_after: lpiAfter, pi_cents: i.pi_cents, total_cents: total, fm_pi_receivable_cents: i.state.fm_pi_receivable_cents, servicer_advances_outstanding_cents: i.state.servicer_advances_outstanding_cents, lar_due_at: larDue, hold_custodial_pi: true } });
  return { lpi_after: lpiAfter, installments: i.installments.length, total_cents: total, processed_at: processedAt, lar_due_at: larDue };
}
export interface AcceptedContractualLar { readonly event_id: string; readonly event_type: string; readonly status: string; readonly accepted_at: string; readonly activity_period: string; }
/** On the accepted contractual-payment LAR: Fannie Mae drafts recovery equal to its receivable for the cleared periods first; only then does the servicer retain (F-1-20). Arms SM_SDA_RECOVERY_MATCH_2_CYCLES. */
export function expectSdaRecovery(em: Emitter, i: { loan_id: string; state: SdaState; accepted: AcceptedContractualLar; cleared_periods: readonly ScheduledMonth[] }): { accepted_on: PlainDate; fnma_recovery_expected_cents: Cents; servicer_retention_expected_cents: Cents; match_by: PlainDate } {
  if (i.state.status !== "active") throw new RangeError(`loan ${i.loan_id} is not in the Stop Delinquency Advance process`);
  if (i.accepted.event_type !== "payment.contractual") throw new RangeError(`accepted event ${i.accepted.event_id} is ${i.accepted.event_type}, not payment.contractual`);
  if (!i.accepted.status.startsWith("accepted")) throw new RangeError(`event ${i.accepted.event_id} is ${i.accepted.status}, not accepted`);
  if (!i.cleared_periods.length) throw new RangeError("the cleared periods' scheduled P&I is required");
  const ms = Date.parse(i.accepted.accepted_at); if (Number.isNaN(ms)) throw new RangeError("accepted_at is not an instant");
  const cleared = fmReceivableForPeriods(i.cleared_periods);
  const toFnma = cleared < i.state.fm_pi_receivable_cents ? cleared : i.state.fm_pi_receivable_cents; const toServicer = cleared - toFnma;
  const acceptedOn = etDate(ms); const matchBy = twoCyclesFrom(acceptedOn);
  em.events.append({ type: "sda.recovery.expected", loanId: i.loan_id, actor: em.actor, payload: { sda_active: true, contractual: true, event_id: i.accepted.event_id, event_type: i.accepted.event_type, activity_period: asPeriod(i.accepted.activity_period), accepted_at: i.accepted.accepted_at, accepted_on: acceptedOn, cleared_pi_cents: cleared, fnma_recovery_expected_cents: toFnma, servicer_retention_expected_cents: toServicer, fm_pi_receivable_cents: i.state.fm_pi_receivable_cents, order: ["fnma_recovery", "servicer_retention"], match_by: matchBy } });
  return { accepted_on: acceptedOn, fnma_recovery_expected_cents: toFnma, servicer_retention_expected_cents: toServicer, match_by: matchBy };
}
export interface RecoveryMatch { readonly kind: "fnma_recovery" | "servicer_retention"; readonly amount_cents: Cents; readonly fm_pi_receivable_after_cents: Cents; readonly servicer_advances_outstanding_cents: Cents; readonly advances_recovered: string[]; readonly ledger: readonly { account: string; side: "Dr" | "Cr"; amount_cents: Cents }[]; }
/** A recovery amount on the draft / Cash Adjustments report matched against the state: Fannie Mae's receivable first, then the servicer's advances FIFO (`sda.adjustment.matched{kind}`); a settled custodial debit is `remittances.drafted{sda_recovery=true}`, which releases the held P&I. */
export function matchRecoveryDraft(em: Emitter, i: { loan_id: string; state: SdaState; draft_cents: Cents; debit_id?: string | null; settled_on?: PlainDate | null; report_line_id?: string | null }): { matches: RecoveryMatch[]; to_fnma_receivable_cents: Cents; to_servicer_advances_cents: Cents; fm_pi_receivable_cents: Cents; servicer_advances_outstanding_cents: Cents } {
  if (i.draft_cents <= 0n) throw new RangeError("draft_cents must be positive");
  const before = i.state.advances.filter((a) => a.status === "outstanding").map((a) => a.period);
  const r = applyRecovery(i.state, i.draft_cents);
  const recovered = before.filter((p) => i.state.advances.find((a) => a.period === p)?.status === "recovered_from_borrower");
  const matches: RecoveryMatch[] = [];
  if (r.to_fnma_receivable_cents > 0n) matches.push({ kind: "fnma_recovery", amount_cents: r.to_fnma_receivable_cents, fm_pi_receivable_after_cents: i.state.fm_pi_receivable_cents, servicer_advances_outstanding_cents: i.state.servicer_advances_outstanding_cents, advances_recovered: [], ledger: [] });
  if (r.to_servicer_advances_cents > 0n) matches.push({ kind: "servicer_retention", amount_cents: r.to_servicer_advances_cents, fm_pi_receivable_after_cents: i.state.fm_pi_receivable_cents, servicer_advances_outstanding_cents: i.state.servicer_advances_outstanding_cents, advances_recovered: recovered, ledger: [{ account: "custodial_pi_cash", side: "Dr", amount_cents: r.to_servicer_advances_cents }, { account: "servicer_advance_receivable", side: "Cr", amount_cents: r.to_servicer_advances_cents }] });
  for (const m of matches) em.events.append({ type: "sda.adjustment.matched", loanId: i.loan_id, actor: em.actor, payload: { kind: m.kind, amount_cents: m.amount_cents, draft_cents: i.draft_cents, fm_pi_receivable_after_cents: m.fm_pi_receivable_after_cents, servicer_advances_outstanding_cents: m.servicer_advances_outstanding_cents, advances_recovered: m.advances_recovered, debit_id: i.debit_id ?? null, report_line_id: i.report_line_id ?? null, matched_at: em.now } });
  if (i.debit_id && i.settled_on) em.events.append({ type: "remittances.drafted", loanId: i.loan_id, actor: em.actor, payload: { sda_recovery: true, kind: "sda_recovery", remittance_type: "ss", amount_cents: i.draft_cents, debit_id: i.debit_id, settled_on: i.settled_on, matched_at: em.now } });
  return { matches, to_fnma_receivable_cents: r.to_fnma_receivable_cents, to_servicer_advances_cents: r.to_servicer_advances_cents, fm_pi_receivable_cents: i.state.fm_pi_receivable_cents, servicer_advances_outstanding_cents: i.state.servicer_advances_outstanding_cents };
}

// ───── rule 5: exits and reimbursement ─────
export interface SdaExit { readonly reason: SdaExitReason; readonly exited_on: PlainDate; readonly period_end: PlainDate; readonly resume_draft_on: PlainDate | null; readonly reimbursement_match_by: PlainDate | null; readonly expected: "recovery_from_contractual_payments" | "fnma_reimbursement" | "fnma_drafts_receivable_from_proceeds"; readonly fm_pi_receivable_cents: Cents; readonly advances_outstanding_cents: Cents; readonly payoff: ReturnType<typeof sdaPayoffRemittance> | null; }
/** F-1-20 exit table: `sda_status.exited{reason, exited_on, period_end}` — current → drafts resume at the next CD18 (FNMA_F120_SDA_EXIT_RESUME_DRAFT); deferral/reclass/liquidation → Fannie Mae reimburses within two cycles (SM_SDA_REIMBURSEMENT_MATCH_2_CYCLES); payoff/repurchase → Fannie Mae drafts its receivable from the proceeds (5.4-T8). */
export function recordSdaExit(em: Emitter, i: { loan_id: string; state: SdaState; reason: SdaExitReason; exited_on: PlainDate; payoff?: { payoff_upb_cents: Cents; payoff_interest_cents: Cents; proceeds_cents: Cents } }): SdaExit {
  if (i.state.status !== "active" && i.state.status !== "predicted") throw new RangeError(`loan ${i.loan_id} is not in the Stop Delinquency Advance process (status ${i.state.status})`);
  if (!isoDate(i.exited_on)) throw new RangeError("exited_on must be YYYY-MM-DD");
  const outstanding = i.state.advances.filter((a) => a.status === "outstanding").reduce((s, a) => s + a.amount_cents, 0n);
  const periodEnd = endOfMonth(i.exited_on);
  const expected: SdaExit["expected"] = i.reason === "current" ? "recovery_from_contractual_payments" : i.reason === "payoff" || i.reason === "repurchase" ? "fnma_drafts_receivable_from_proceeds" : "fnma_reimbursement";
  if ((i.reason === "payoff" || i.reason === "repurchase") && !i.payoff) throw new RangeError(`a ${i.reason} exit needs the payoff figures (UPB, interest, proceeds)`);
  const payoff = i.payoff ? sdaPayoffRemittance({ ...i.payoff, fm_pi_receivable_cents: i.state.fm_pi_receivable_cents, servicer_advances_outstanding_cents: outstanding }) : null;
  const resume = i.reason === "current" ? calendarDraftDate(nextMonth(periodEnd), 18) : null;
  const matchBy = expected === "fnma_reimbursement" ? twoCyclesFrom(i.exited_on) : null;
  i.state.status = "exited";
  em.events.append({ type: "sda_status.exited", loanId: i.loan_id, actor: em.actor, payload: { reason: i.reason, exited_on: i.exited_on, period_end: periodEnd, resume_draft_on: resume, reimbursement_match_by: matchBy, expected, fm_pi_receivable_cents: i.state.fm_pi_receivable_cents, advances_outstanding: outstanding > 0n, advances_outstanding_cents: outstanding, fnma_reimburses: expected === "fnma_reimbursement", payoff_remittance_cents: payoff?.remittance_cents ?? null, exited_at: em.now } });
  return { reason: i.reason, exited_on: i.exited_on, period_end: periodEnd, resume_draft_on: resume, reimbursement_match_by: matchBy, expected, fm_pi_receivable_cents: i.state.fm_pi_receivable_cents, advances_outstanding_cents: outstanding, payoff };
}
export interface ResumeDraftInput { readonly loan_id: string; readonly period: string; readonly cycle?: Cycle; readonly draft_date: PlainDate; readonly expected_draft_cents: Cents; readonly custodial_available_cents: Cents; readonly facility_available_cents: Cents; readonly custodial_account_id: string; readonly at_ms: number; }
export interface ResumeDraftResult { readonly advance: AdvanceTransfer; readonly entry_set: EntrySetInput | null; readonly status: "funded" | "escalated"; readonly funded_at: string | null; readonly cycle_subject: Subject; readonly resumed_from: PlainDate; }
/**
 * Exit (a): the loan's scheduled P&I is back in the next CD18 draft. The 5.2 T−1 16:00 ET funding check (`advanceTransfer`, the 5.2
 * rule-7 advance entry set) runs for the loan's own scheduled P&I and the facts are posted on the loan (`custodial.funding.verified`,
 * `remittances.funded{remittance_type=ss, kind=pi_scheduled, sda_resumed=true}`) — never on the cycle subject, whose whole-cycle
 * FNMA_F120_SS_DRAFT_CD18 check is 5.2's own `fundDraft` over the aggregate draft; the cycle is carried as a reference only.
 */
export function resumeScheduledDraft(em: Emitter, i: ResumeDraftInput): ResumeDraftResult {
  const st = sdaStatusFromEvents(em.events.byLoan(i.loan_id));
  if (st.status !== "exited" || st.reason !== "current") throw new RangeError(`loan ${i.loan_id} has not exited Stop Advance by becoming current (status ${st.status}${st.reason ? `/${st.reason}` : ""})`);
  const exitedOn = st.last && isoDate(st.last.payload.exited_on) ? st.last.payload.exited_on : etDate(Date.parse(st.last!.occurredAt));
  if (asPeriod(i.period) < periodOf(exitedOn)) throw new RangeError(`period ${i.period} precedes the exit ${exitedOn}: scheduled drafts resume from the month after the loan became current`);
  if (!isoDate(i.draft_date)) throw new RangeError("draft_date must be YYYY-MM-DD");
  if (i.expected_draft_cents < 0n) throw new RangeError("expected draft cannot be negative");
  const cycle = i.cycle ?? "standard"; const cycleRef = cycleSubject(i.period, "ss", cycle);
  const a = advanceTransfer({ expected_draft_cents: i.expected_draft_cents, custodial_available_cents: i.custodial_available_cents, facility_available_cents: i.facility_available_cents, at_ms: i.at_ms, draft_date: i.draft_date });
  const set = a.status === "funded" && a.amount_cents > 0n ? advanceEntrySet({ amount_cents: a.amount_cents, custodial_account_id: i.custodial_account_id, effective_date: etDate(i.at_ms), period: i.period, remittance_type: "ss", cycle }) : null;
  const fundedAt = a.funded_at_ms !== null ? toIso(a.funded_at_ms) : null;
  const base = { period: i.period, remittance_type: "ss", cycle, kind: "pi_scheduled", sda_resumed: true, resumed_from: exitedOn, draft_date: i.draft_date, expected_cents: i.expected_draft_cents, available_cents: i.custodial_available_cents, advance_cents: a.amount_cents, custodial_account_id: i.custodial_account_id, dual_control: a.dual_control, cycle_subject: cycleRef };
  em.events.append({ type: "custodial.funding.verified", loanId: i.loan_id, actor: em.actor, payload: { ...base, covered: a.status === "funded", verified_at: toIso(i.at_ms), funded_by_at: toIso(a.funded_by_ms), escalation: a.escalation } });
  if (a.status === "funded") em.events.append({ type: "remittances.funded", loanId: i.loan_id, actor: em.actor, payload: { ...base, funded_at: fundedAt, initiator: "fnma" } });
  return { advance: a, entry_set: set, status: a.status, funded_at: fundedAt, cycle_subject: cycleRef, resumed_from: exitedOn };
}

// ───── rule 3 / T1: the four delinquency advances booked (`advances` rows, kind = delinquency_pi) ─────
export interface AdvanceDraft { readonly period: string; readonly draft_date: PlainDate; readonly amount_cents: Cents; }
export interface BookedAdvance { readonly kind: "delinquency_pi"; readonly loan_id: string; readonly period: string; readonly amount_cents: Cents; readonly funded_from: "partner_line" | "supermortgage_corporate"; readonly drafted_at: PlainDate; readonly status: "outstanding"; readonly entry_set: EntrySetInput; }
/**
 * Data model: `advances` rows of `kind = delinquency_pi` per loan per activity period with `amount_cents`, `funded_from`, `drafted_at`,
 * `status = outstanding`; each is the 5.2 rule-7 advance posting (Dr `servicer_advance_receivable` Cr corporate cash / Dr
 * `custodial_pi_cash` Cr transfer clearing). Refused for a loan Fannie Mae has flagged Stop Advance (the event-derived status — the
 * NO_ADVANCE_ON_STOP_ADVANCE gate on the tool and this check), and never for a period on/after a predicted `first_excluded_draft`
 * unless Fannie Mae's report shows the loan still advancing (rule 2: Fannie Mae's Start Date is authoritative).
 */
export function bookDelinquencyAdvances(em: Emitter, i: { loan_id: string; custodial_account_id: string; funded_from: "partner_line" | "supermortgage_corporate"; drafts: readonly AdvanceDraft[]; cycle?: Cycle }): { advances: BookedAdvance[]; total_cents: Cents; entry_sets: EntrySetInput[] } {
  if (!i.drafts.length) throw new RangeError("at least one advance draft is required");
  if (i.funded_from !== "partner_line" && i.funded_from !== "supermortgage_corporate") throw new RangeError("funded_from must be partner_line or supermortgage_corporate");
  if (!i.custodial_account_id) throw new RangeError("custodial_account_id is required");
  const st = sdaStatusFromEvents(em.events.byLoan(i.loan_id));
  if (st.status === "active") throw new RangeError(`loan ${i.loan_id} is in the Stop Delinquency Advance process: no delinquency advance is funded (F-1-20)`);
  const booked = new Set(em.events.byLoan(i.loan_id).filter((e) => e.type === "advances.booked").map((e) => String((e.payload as { period?: unknown }).period)));
  const firstExcluded = st.status === "predicted" && st.last && isoDate(st.last.payload.first_excluded_draft) ? st.last.payload.first_excluded_draft : null;
  let prev: string | null = null; const advances: BookedAdvance[] = []; let total = 0n;
  for (const d of i.drafts) {
    asPeriod(d.period); if (!isoDate(d.draft_date)) throw new RangeError(`${d.period}: draft_date must be YYYY-MM-DD`);
    if (d.amount_cents <= 0n) throw new RangeError(`${d.period}: amount_cents must be positive`);
    if (prev !== null && d.period <= prev) throw new RangeError(`${d.period}: advance periods must be increasing`);
    if (booked.has(d.period)) throw new RangeError(`${d.period}: a delinquency advance is already booked for the period`);
    if (firstExcluded && d.draft_date >= firstExcluded) throw new RangeError(`${d.period}: the ${d.draft_date} draft is on/after the predicted first excluded draft ${firstExcluded} — Fannie Mae is expected to credit it, not draft it`);
    prev = d.period;
    const set = advanceEntrySet({ amount_cents: d.amount_cents, custodial_account_id: i.custodial_account_id, effective_date: d.draft_date, period: d.period, remittance_type: "ss", cycle: i.cycle ?? "standard" });
    advances.push({ kind: "delinquency_pi", loan_id: i.loan_id, period: d.period, amount_cents: d.amount_cents, funded_from: i.funded_from, drafted_at: d.draft_date, status: "outstanding", entry_set: set }); total += d.amount_cents;
    em.events.append({ type: "advances.booked", loanId: i.loan_id, actor: em.actor, payload: { kind: "delinquency_pi", period: d.period, amount_cents: d.amount_cents, funded_from: i.funded_from, drafted_at: d.draft_date, status: "outstanding", custodial_account_id: i.custodial_account_id, sda_status: st.status, booked_at: em.now } });
  }
  return { advances, total_cents: total, entry_sets: advances.map((a) => a.entry_set) };
}
/** Exits (b)/(c)/(e): reimbursement credits matched FIFO to `advances` rows — all reach `reimbursed_by_fnma` within two cycles or the Investor Reporting Representative package escalates to `officer`. */
export function matchReimbursementCredits(em: Emitter, i: { loan_id: string; advances: readonly AdvanceRow[]; credits: readonly Cents[]; cycles_elapsed: number; exit_reason?: SdaExitReason | null; report_line_ids?: readonly string[] }): ReturnType<typeof matchReimbursements> & { reimbursed_periods: string[]; credited_cents: Cents } {
  if (!i.advances.length) throw new RangeError("advances rows are required");
  if (i.cycles_elapsed < 0) throw new RangeError("cycles_elapsed cannot be negative");
  const m = matchReimbursements({ advances: i.advances, credits: i.credits, cycles_elapsed: i.cycles_elapsed });
  const reimbursed = m.advances.filter((a, n) => a.status === "reimbursed_by_fnma" && i.advances[n]?.status !== "reimbursed_by_fnma").map((a) => a.period);
  const credited = i.credits.reduce((s, c) => s + c, 0n);
  if (m.all_reimbursed) em.events.append({ type: "advances.reimbursed_by_fnma", loanId: i.loan_id, actor: em.actor, payload: { all_outstanding: true, rows: m.advances.length, periods: reimbursed, credited_cents: credited, unmatched_credit_cents: m.unmatched_credit_cents, exit_reason: i.exit_reason ?? null, report_line_ids: i.report_line_ids ?? [], matched_at: em.now } });
  else if (reimbursed.length) em.events.append({ type: "advances.reimbursed_by_fnma", loanId: i.loan_id, actor: em.actor, payload: { all_outstanding: false, rows: m.advances.length, periods: reimbursed, credited_cents: credited, unmatched_credit_cents: m.unmatched_credit_cents, exit_reason: i.exit_reason ?? null, report_line_ids: i.report_line_ids ?? [], matched_at: em.now } });
  return { ...m, reimbursed_periods: reimbursed, credited_cents: credited };
}

// ───── reclassification interplay (A1-3-06 / F-1-25) ─────
export interface PurchaseAdviceRow { readonly advice_id: string; readonly kind: "reclass" | "repurchase"; readonly fnma_loan_number: string; readonly loan_id: string; readonly effective_date: PlainDate; readonly received_on: PlainDate; readonly reimbursed_advances_cents: Cents; readonly new_remittance_type: "AA" | null; readonly document_id: string | null; }
export function validatePurchaseAdvice(r: Record<string, unknown>): PurchaseAdviceRow {
  const s = (k: string): string => { const v = r[k]; if (typeof v !== "string" || v === "") throw new RangeError(`purchase advice: ${k} is required`); return v; };
  const kind = s("kind"); if (kind !== "reclass" && kind !== "repurchase") throw new RangeError("purchase advice: kind must be reclass or repurchase");
  const ln = s("fnma_loan_number"); if (!/^\d{1,10}$/.test(ln)) throw new RangeError("purchase advice: fnma_loan_number");
  const eff = s("effective_date"), rec = s("received_on"); if (!isoDate(eff) || !isoDate(rec)) throw new RangeError("purchase advice: effective_date/received_on must be YYYY-MM-DD");
  if (kind === "reclass" && parts(plainDate(eff)).d !== 1) throw new RangeError("purchase advice: a reclassification is effective the 1st of the reclass month (F-1-25)");
  let cents: Cents; try { cents = typeof r.reimbursed_advances_cents === "bigint" ? r.reimbursed_advances_cents : BigInt(String(r.reimbursed_advances_cents ?? "0")); } catch { throw new RangeError("purchase advice: reimbursed_advances_cents is not an amount in cents"); }
  if (cents < 0n) throw new RangeError("purchase advice: reimbursed_advances_cents cannot be negative");
  return { advice_id: typeof r.advice_id === "string" && r.advice_id !== "" ? r.advice_id : `pa-${ln}-${eff}`, kind, fnma_loan_number: ln, loan_id: s("loan_id"), effective_date: plainDate(eff), received_on: plainDate(rec), reimbursed_advances_cents: cents, new_remittance_type: kind === "reclass" ? "AA" : null, document_id: typeof r.document_id === "string" ? r.document_id : null };
}
/** `fnma.purchase_advice.received{kind}` — the reclass purchase advice satisfies FNMA_A1306_RECLASS_SELECTION_6M and carries the reimbursement of outstanding delinquency advances (rule 5(c)). */
export function ingestPurchaseAdvice(em: Emitter, row: PurchaseAdviceRow): { remittance_type_from: PlainDate; reimbursement_credit_cents: Cents } {
  em.events.append({ type: "fnma.purchase_advice.received", loanId: row.loan_id, actor: em.actor, payload: { kind: row.kind, advice_id: row.advice_id, fnma_loan_number: row.fnma_loan_number, effective_date: row.effective_date, received_on: row.received_on, reimbursed_advances_cents: row.reimbursed_advances_cents, new_remittance_type: row.new_remittance_type, document_id: row.document_id, received_at: em.now } });
  return { remittance_type_from: row.effective_date, reimbursement_credit_cents: row.reimbursed_advances_cents };
}
/** F-1-25: the deselection decision by CD15 — `reclass.deselection.decided{decision}`; deselecting is a `human_portal_task` entry in Fannie Mae Connect. */
export function recordDeselectionDecision(em: Emitter, i: { loan_id: string; report_id: string; decision: "deselect" | "keep"; decided_on: PlainDate; rationale: string }): { portal_task: boolean; decided_on: PlainDate } {
  if (i.decision !== "deselect" && i.decision !== "keep") throw new RangeError("decision must be deselect or keep");
  if (!i.report_id) throw new RangeError("report_id is required"); if (!isoDate(i.decided_on)) throw new RangeError("decided_on must be YYYY-MM-DD"); if (!i.rationale) throw new RangeError("rationale is required");
  em.events.append({ type: "reclass.deselection.decided", loanId: i.loan_id, aggregate: reportSubject(i.report_id), actor: em.actor, payload: { decision: i.decision, report_id: i.report_id, decided_on: i.decided_on, rationale: i.rationale, portal_task: i.decision === "deselect", decided_at: em.now } });
  return { portal_task: i.decision === "deselect", decided_on: i.decided_on };
}
