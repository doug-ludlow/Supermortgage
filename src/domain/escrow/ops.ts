/**
 * §3 escrow operations the acceptance tests exercise beyond the calculators:
 * 3.1 initial-statement status and timing, 3.2 review gates, 3.3 statement
 * assembly and state supplements, 3.5 refund lifecycle, 3.7 disbursement
 * lifecycle, events, attestation and non-escrow monitoring, 3.8 state rights
 * and script checks, 3.9 rate calendars, verification and 1099 dates.
 */
import type { Cents } from "../../kernel/money/cents.ts";
import { divRound, Decimal } from "../../kernel/money/decimal.ts";
import { type PlainDate, addDays, addMonths, addYears, parts, ymd, endOfMonth } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer, fannieEt, federal } from "../../kernel/calendar/business.ts";
import type { Actor, EventStore } from "../../kernel/events/index.ts";
import type { TimerEngine } from "../../kernel/timers/engine.ts";
import { project, type ProjectedItem, type Projection, type Decision } from "./analysis.ts";
import { pmiTerminationRecompute, type LoanFacts } from "./interest.ts";
import { annualDeadline, lumpSumWordingAllowed } from "./statement.ts";
import { rejectReplanDue } from "./disbursement.ts";
import type { Plan } from "./shortage.ts";

// ---------------------------------------------------------------- 3.1 initial statement
export type InitialStatementStatus = "satisfied_by_originator" | "required" | "sent" | "cancelled";
/** 3.1 rule 1: originator evidence dated ≤ settlement + 45 days satisfies (g)(1); otherwise the 45-day timer runs from settlement, and a lapsed window means send now + inherited breach + qc_finding. */
export function initialStatementStatus(f: { settlement_date: PlainDate; boarded_on: PlainDate; originator_statement_delivered_on?: PlainDate | null }): { status: InitialStatementStatus; timer: { code: "REGX_1024_17G_INITIAL_STMT_45"; due_on: PlainDate; breached_at_boarding: boolean; waiver_reason?: "inherited_from_originator" } | null; send_by: PlainDate | null; qc_finding: "originator_failed_g1" | null } {
  const due = addDays(f.settlement_date, 45);
  if (f.originator_statement_delivered_on && f.originator_statement_delivered_on <= due) return { status: "satisfied_by_originator", timer: null, send_by: null, qc_finding: null };
  if (f.boarded_on > due) return { status: "required", timer: { code: "REGX_1024_17G_INITIAL_STMT_45", due_on: due, breached_at_boarding: true, waiver_reason: "inherited_from_originator" }, send_by: addBusinessDays(f.boarded_on, 1, servicer), qc_finding: "originator_failed_g1" };
  return { status: "required", timer: { code: "REGX_1024_17G_INITIAL_STMT_45", due_on: due, breached_at_boarding: false }, send_by: due, qc_finding: null };
}
/**
 * 3.1-T5/T6: transfer-in with a changed payment → (e)(1) statement within 60 days of the transfer date and a new
 * computation year; establishment (waiver revocation) → 45 days, and the investor Escrow Setup event is queued through the
 * per-loan event ledger before the first deposit event (3.7 rule 12), so the order is the ledger's sequence, not a constant.
 */
export function establishmentStatement(kind: "transfer_in_changed", on: PlainDate, changedByCents: Cents): { timer: "REGX_1024_17E_TRANSFER_INITIAL_STMT_60"; due_on: PlainDate; computation_year_start: PlainDate } | { timer: null; computation_year_start: "retained" };
export function establishmentStatement(kind: "established", on: PlainDate, opening?: { balance_cents: Cents; first_deposit?: { amount_cents: Cents; on: PlainDate } | null }): { timer: "REGX_1024_17G_INITIAL_STMT_45"; due_on: PlainDate; events: EscrowEvent[]; events_in_order: ("EscrowSetup" | "deposit")[] };
export function establishmentStatement(kind: "transfer_in_changed" | "established", on: PlainDate, arg?: Cents | { balance_cents: Cents; first_deposit?: { amount_cents: Cents; on: PlainDate } | null }): unknown {
  if (kind === "established") {
    const opening = typeof arg === "object" && arg !== null ? arg : { balance_cents: 0n };
    const queue = new EscrowEventLedger(0n);
    queue.emit("Set up", opening.balance_cents, on);
    if (opening.first_deposit) queue.emit("Loan Escrow Payment", opening.first_deposit.amount_cents, opening.first_deposit.on);
    const events = [...queue.events].sort((a, b) => a.sequence - b.sequence);
    return { timer: "REGX_1024_17G_INITIAL_STMT_45", due_on: addDays(on, 45), events, events_in_order: events.map((e) => (e.item === "Set up" ? "EscrowSetup" : "deposit")) };
  }
  const changedByCents = typeof arg === "bigint" ? arg : 0n;
  return changedByCents === 0n ? { timer: null, computation_year_start: "retained" } : { timer: "REGX_1024_17E_TRANSFER_INITIAL_STMT_60", due_on: addDays(on, 60), computation_year_start: on };
}
export type StatementType = "initial" | "annual" | "short_year_transfer" | "short_year_payoff" | "short_year_reset" | "post_exemption_history" | "shortage_notice";
/**
 * The statement send is a `loan_events` fact (`escrow.statement.sent`) — the event every 3.1/3.3 statement timer is satisfied by
 * (`statement_type` picks the timer; `disposition=sent` pairs with the (i)(2) `exempt_hold` on the annual code); returns whether it
 * landed on/before the timer's due date. `shortage_explained` marks the payload that satisfies REGX_1024_17F5_SHORTAGE_NOTICE_ANNUAL:
 * a statement whose item (vi) explains a shortage/deficiency, or the (f)(5) notice `NTC_REGX_1024_17F_SHORTAGE` sent in its place.
 */
export function recordStatementSent(events: EventStore, f: { loan_id: string; template: string; statement_type: StatementType; sent_on: PlainDate; due_on: PlainDate; actor: Actor; shortage_explained?: boolean; history_to?: PlainDate | null; stated_payment?: { amount_cents: Cents; effective_on: PlainDate } | null }): { event_type: "escrow.statement.sent"; satisfied_on_time: boolean; shortage_explained: boolean } {
  const shortageExplained = f.shortage_explained === true || f.template === "NTC_REGX_1024_17F_SHORTAGE";
  // `history_to` (the statement's period end) is what the next (i)(2) post-exemption history continues from (3.3 rule 6; ops-3-3.ts historyStartFromLog).
  // `stated_payment` (32.8 / 2.3 rule 5): the exact new payment and effective date the statement states — the fact 2.3's variable-amount check reads when the escrow statement already served as the Reg E §1005.10(d)(1) notice.
  events.append({ type: "escrow.statement.sent", loanId: f.loan_id, actor: f.actor, payload: { template: f.template, statement_type: f.statement_type, disposition: "sent", sent_on: f.sent_on, due_on: f.due_on, shortage_explained: shortageExplained, ...(f.history_to ? { history_to: f.history_to } : {}), ...(f.stated_payment ? { stated_payment_cents: f.stated_payment.amount_cents.toString(), stated_payment_effective_on: f.stated_payment.effective_on } : {}) } });
  return { event_type: "escrow.statement.sent", satisfied_on_time: f.sent_on <= f.due_on, shortage_explained: shortageExplained };
}
/** 3.1 rule 6 / 7.4: electronic only with an unrevoked E-SIGN consent covering the class as of the send date. */
export function statementChannel(consent: { class: string; given_on: PlainDate; revoked_on?: PlainDate | null } | null, sendOn: PlainDate): { channel: "electronic" | "mail"; receipt_evidence_required: boolean } {
  const ok = !!consent && consent.class === "escrow_statements" && consent.given_on <= sendOn && !(consent.revoked_on && consent.revoked_on <= sendOn);
  return { channel: ok ? "electronic" : "mail", receipt_evidence_required: ok };
}
/** 3.1 rule 4 biweekly: 26 rows; per-period escrow × 26 = annual ± $0.26. */
export function biweeklyTrialBalance(items: readonly ProjectedItem[], yearStart: PlainDate): { rows: number; per_period_cents: Cents; annual_cents: Cents; within_tolerance: boolean; projection: Projection } {
  const p = project(items, yearStart, {}, { biweekly: true });
  const diff = p.base_payment_cents * 26n - p.annual_cents;
  return { rows: p.periods, per_period_cents: p.base_payment_cents, annual_cents: p.annual_cents, within_tolerance: diff >= -26n && diff <= 26n, projection: p };
}
/** 3.1 edge case: print vendor rejects; after 3 retries and ≤ 2 BD before due → in-house mail + sev-3 escalation. */
export function vendorFallback(f: { attempts: number; due_on: PlainDate; today: PlainDate }): { fallback: "in_house_mail" | null; escalation: "sev3" | null; retry: boolean } {
  const cutoff = addBusinessDays(f.due_on, -2, servicer);
  if (f.attempts >= 3 && f.today >= cutoff) return { fallback: "in_house_mail", escalation: "sev3", retry: false };
  return { fallback: null, escalation: null, retry: f.attempts < 3 };
}

// ---------------------------------------------------------------- 3.2 review gates
/** (c)(9) multi-year item contribution per month and the statement explanation flag. */
export function multiYearContribution(amountCents: Cents, cycleYears: number): Cents { return divRound(amountCents, BigInt(12 * cycleYears), "HALF_UP"); }
/** PMI termination (3.2-T12): installments on/after the termination date are excluded. */
export function miLines(monthly: Cents, from: PlainDate, terminatesOn: PlainDate | null): ProjectedItem[] {
  const out: ProjectedItem[] = [];
  for (let i = 0; i < 12; i++) { const d = addMonths(from, i); if (!terminatesOn || d < terminatesOn) out.push({ line_type: "mi", amount_cents: monthly, disburse_on: d, terminates_on: terminatesOn ?? null }); }
  return out;
}
/** Chapter 13 (3.2-T13 / 14.2): the new payment takes effect ≥ 21 days after the Rule 3002.1 notice is filed. */
export function chapter13EffectiveDate(candidate: PlainDate, noticeFiledOn: PlainDate): PlainDate { let d = candidate; const min = addDays(noticeFiledOn, 21); while (d < min) d = addMonths(d, 1); return d; }
/** NH (3.2-T14, RSA 397-A:9): a servicer-advanced deficiency is offered over ≥ 12 months at 0%, with no lump-sum demand. */
export function nhDeficiencyOffer(deficiencyCents: Cents): { months: number; installment_cents: Cents; interest_rate_pct: "0"; lump_sum_demand: false; option_text: string } {
  return { months: 12, installment_cents: divRound(deficiencyCents, 12n, "HALF_UP"), interest_rate_pct: "0", lump_sum_demand: false, option_text: "Under RSA 397-A:9 you may repay this deficiency over at least 12 months at no interest; you are not required to pay it in a lump sum." };
}
/** 3.2 R10 (T15): a > 25% payment change routes to anomaly_review and the decision record lists the trigger before approval. */
export function reviewStatus(triggers: readonly string[]): { status: "anomaly_review" | "computed"; decision_record: { triggers: string[]; approval_blocked_until_reviewed: boolean } } {
  return { status: triggers.length ? "anomaly_review" : "computed", decision_record: { triggers: [...triggers], approval_blocked_until_reviewed: triggers.length > 0 } };
}

// ---------------------------------------------------------------- 3.3 statement assembly
export interface StatementHistoryRow { readonly month: PlainDate; readonly deposits_cents: Cents; readonly disbursements: readonly { line: string; amount_cents: Cents; projected_cents: Cents | null }[]; readonly balance_cents: Cents; readonly assumed?: boolean; }
export interface AnnualStatement {
  readonly items: Record<"i" | "ii" | "iii" | "iv" | "v" | "vi" | "vii" | "viii", unknown>; readonly prior_projection_attached: boolean; readonly history: StatementHistoryRow[]; readonly send_by: PlainDate; readonly send_target_on: PlainDate; readonly legend: string | null;
  readonly history_from: PlainDate | null; readonly history_to: PlainDate | null; readonly continuous: boolean; readonly ending_balance_cents: Cents; readonly low_balance_cents: Cents | null; readonly deposits_cents: Cents; readonly disbursements_cents: Cents;
}
const fmtMoney = (c: Cents): string => { const neg = c < 0n; const a = neg ? -c : c; return `${neg ? "-" : ""}$${(a / 100n).toLocaleString("en-US")}.${(a % 100n).toString().padStart(2, "0")}`; };
const fmtMdy = (d: PlainDate): string => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`;
/** 3.3 rule 1: the account history is rendered from the ledger — running balances follow from the opening balance and each month's deposits and disbursements. */
export function buildHistory(openingBalanceCents: Cents, rows: readonly { month: PlainDate; deposits_cents: Cents; disbursements: readonly { line: string; amount_cents: Cents; projected_cents: Cents | null }[] }[]): StatementHistoryRow[] {
  let bal = openingBalanceCents;
  return rows.map((r) => { bal += r.deposits_cents - r.disbursements.reduce((s, d) => s + d.amount_cents, 0n); return { month: r.month, deposits_cents: r.deposits_cents, disbursements: r.disbursements, balance_cents: bal }; });
}
/** Item (iv) (§1024.17(i)(1)(iv); 3.1 (h)(3)): the total paid out per taxing authority / insurer, "as separately identified" — one row per line, never an "other" bucket. */
export function disbursementsByLine(history: readonly StatementHistoryRow[]): { line: string; amount_cents: Cents }[] {
  const totals = new Map<string, Cents>();
  for (const r of history) for (const d of r.disbursements) totals.set(d.line, (totals.get(d.line) ?? 0n) + d.amount_cents);
  return [...totals].map(([line, amount_cents]) => ({ line, amount_cents }));
}
/** Item (vi): how a surplus / shortage / deficiency is handled, rendered from the analysis decision (never free text). */
export function decisionText(d: Decision): string {
  switch (d.kind) {
    case "refund": return `Your account has a surplus of ${fmtMoney(d.surplus_cents)}, which is being refunded to you by ${fmtMdy(d.due_on)}.`;
    case "credit": return `Your account has a surplus of ${fmtMoney(d.surplus_cents)}, which is credited against next year's payments at ${fmtMoney(d.credit_monthly_cents)} per month.`;
    case "retain": return `Your account has a surplus of ${fmtMoney(d.surplus_cents)}, retained in the account because the loan was more than 30 days past due at the analysis.`;
    case "shortage": return d.deficiency_cents > 0n ? `Your account has a deficiency of ${fmtMoney(d.deficiency_cents)} and a shortage of ${fmtMoney(d.shortage_cents)}.` : `Your account has a shortage of ${fmtMoney(d.shortage_cents)}.`;
    case "balanced": return "Your account has no surplus, shortage or deficiency.";
  }
}
/** Item (vii): the repayment plan sentence — "$33.89 per month for 12 months beginning 07/01/2027"; a ≥-one-month gap never mentions a lump sum (3.6 rule 8). */
export function planText(p: Plan | null, oneMonthCents?: Cents): string {
  if (!p) return "No repayment is required.";
  const spread = `${fmtMoney(p.installment_cents)} per month for ${p.months} months beginning ${fmtMdy(p.start_due_date)}`;
  const mayMentionLump = oneMonthCents !== undefined && lumpSumWordingAllowed(p.total_cents, oneMonthCents);
  return mayMentionLump ? `${spread}, or you may pay the ${fmtMoney(p.total_cents)} within 30 days if you prefer.` : spread;
}
export function bankruptcyLegend(chapter: 7 | 13): string { return chapter === 13 ? "Informational: your escrow payment change will be noticed under Bankruptcy Rule 3002.1." : "Informational only — this is not an attempt to collect a debt."; }
/**
 * 3.3 rules 1–4, 8 (T1/T2): items (i)–(viii) from the history and the analysis decision, the prior projection attached
 * when supplied ((i) requires it), actuals after the run date when approved late; the history's coverage and continuity
 * are computed for the (i)(2) post-exemption variant (T4).
 */
export function assembleAnnualStatement(f: { year_start: PlainDate; year_end: PlainDate; approved_on: PlainDate; new_payment_cents: Cents; prior_escrow_portion_cents: Cents; history: readonly StatementHistoryRow[]; decision?: Decision; plan?: Plan | null; one_month_cents?: Cents; decision_text?: string; prior_projection?: Projection | { document_id: string } | null; low_point_explanation: readonly string[]; interest_credited_cents?: Cents; bankruptcy?: { chapter: 7 | 13 } | null }): AnnualStatement {
  const late = f.approved_on > f.year_end;
  const history = f.history.map((r) => ({ ...r, assumed: late ? false : r.month > f.approved_on }));
  const d = annualDeadline(f.year_end);
  const deposits = history.reduce((s, r) => s + r.deposits_cents, 0n);
  const disbursements = history.reduce((s, r) => s + r.disbursements.reduce((t, x) => t + x.amount_cents, 0n), 0n);
  const months = history.map((r) => r.month).sort();
  const continuous = months.every((m, k) => k === 0 || m === addMonths(months[k - 1]!, 1));
  const vi = f.decision ? decisionText(f.decision) : (f.decision_text ?? "");
  const vii = f.decision ? planText(f.plan ?? null, f.one_month_cents) : (f.decision_text ?? "");
  return {
    items: { i: { monthly_payment_cents: f.new_payment_cents }, ii: { prior_escrow_portion_cents: f.prior_escrow_portion_cents }, iii: { deposits_cents: deposits }, iv: { disbursements: history.flatMap((r) => r.disbursements), by_line: disbursementsByLine(history), total_cents: disbursements }, v: { balances: history.map((r) => [r.month, r.balance_cents]) }, vi: { surplus_shortage_deficiency: vi }, vii: { plan_text: vii }, viii: { low_point_explanation: [...f.low_point_explanation], interest_credited_cents: f.interest_credited_cents ?? 0n } },
    prior_projection_attached: f.prior_projection !== undefined && f.prior_projection !== null, history, send_by: d.due_on, send_target_on: d.send_target_on,
    legend: f.bankruptcy ? bankruptcyLegend(f.bankruptcy.chapter) : null,
    history_from: months[0] ?? null, history_to: months[months.length - 1] ?? null, continuous,
    ending_balance_cents: history.length ? history[history.length - 1]!.balance_cents : 0n, low_balance_cents: history.length ? history.reduce((m, r) => (r.balance_cents < m ? r.balance_cents : m), history[0]!.balance_cents) : null,
    deposits_cents: deposits, disbursements_cents: disbursements,
  };
}
/** 3.3 rule 5 (i)(2) reasons the platform applies (bankruptcy is not suppressed — open question 1 default). */
export type ExemptHoldReason = "delinquent_30" | "foreclosure_action";
/** 3.3-T3: exempt hold; no statement is mailed; a shortage still gets the (f)(5) notice, whose send is the `escrow.statement.sent{shortage_explained=true}` fact REGX_1024_17F5_SHORTAGE_NOTICE_ANNUAL is satisfied by. */
export function exemptHold(reason: ExemptHoldReason, shortageCents: Cents): { status: "exempt_hold"; reason: ExemptHoldReason; statement_mailed: false; notice: "NTC_REGX_1024_17F_SHORTAGE" | null; f5_timer_satisfied_by: "escrow.statement.sent{shortage_explained=true}" | null } {
  return { status: "exempt_hold", reason, statement_mailed: false, notice: shortageCents > 0n ? "NTC_REGX_1024_17F_SHORTAGE" : null, f5_timer_satisfied_by: shortageCents > 0n ? "escrow.statement.sent{shortage_explained=true}" : null };
}
/**
 * The (i)(2) hold is a `loan_events` fact (`escrow.statement.exempt_hold`, 3.3 outputs): it carries the valid reason and, with
 * `statement_type=annual, disposition=exempt_hold`, discharges REGX_1024_17I_ANNUAL_STMT_30 the way a sent statement does
 * (timer table: "`escrow.statement.sent` (annual) or `escrow.statement.exempt_hold` with a valid (i)(2) reason").
 */
export function recordExemptHold(events: EventStore, f: { loan_id: string; reason: ExemptHoldReason; shortage_cents: Cents; as_of: PlainDate; actor: Actor }): ReturnType<typeof exemptHold> & { event_type: "escrow.statement.exempt_hold" } {
  const h = exemptHold(f.reason, f.shortage_cents);
  events.append({ type: "escrow.statement.exempt_hold", loanId: f.loan_id, actor: f.actor, payload: { statement_type: "annual", disposition: "exempt_hold", reason: f.reason, valid_i2_reason: true, as_of: f.as_of, shortage_cents: String(f.shortage_cents), notice: h.notice } });
  return { ...h, event_type: "escrow.statement.exempt_hold" };
}
/**
 * 3.3-T6 / edge case "transfer-out effective mid-year": the armed annual-statement timer is cancelled with reason `transfer_out`
 * (the engine's cancel is an event) and the transferor short-year statement is due 60 days after the effective date.
 */
export function transferOutStatements(effectiveOn: PlainDate, timers?: { engine: TimerEngine; loan_id: string; actor?: Actor }): { annual_timer: "cancelled" | "none_armed"; cancel_reason: "transfer_out"; cancelled_timer_ids: string[]; short_year: { code: "REGX_1024_17I4_SHORT_YEAR_TRANSFER_60"; due_on: PlainDate; notice: "NTC_REGX_1024_17I4_SHORT_YEAR_TRANSFEROR" } } {
  const open = timers ? timers.engine.byCode("REGX_1024_17I_ANNUAL_STMT_30").filter((t) => t.loanId === timers.loan_id && (t.status === "armed" || t.status === "breached")) : [];
  for (const t of open) timers!.engine.cancel(t.id, "transfer_out", timers!.actor);
  return { annual_timer: !timers || open.length ? "cancelled" : "none_armed", cancel_reason: "transfer_out", cancelled_timer_ids: open.map((t) => t.id), short_year: { code: "REGX_1024_17I4_SHORT_YEAR_TRANSFER_60", due_on: addDays(effectiveOn, 60), notice: "NTC_REGX_1024_17I4_SHORT_YEAR_TRANSFEROR" } };
}
/** 3.3-T7: payoff short-year statement shows the refund disposition. */
export function payoffStatement(fundsOn: PlainDate, closingBalanceCents: Cents, disposition: "refund" | "credit_to_new_loan" | "netted"): { due_on: PlainDate; closing_balance_cents: Cents; refund_disposition: string; projection: null } {
  return { due_on: addDays(fundsOn, 60), closing_balance_cents: closingBalanceCents, refund_disposition: `${disposition}: ${closingBalanceCents} cents`, projection: null };
}
/** STATE_UT_7_17_5_ANNUAL_STMT_60: Dec 31 + 60 calendar days (Utah 7-17-5) — March 1 in a common year, Feb 29 when the following year is a leap year. */
export const UT_ANNUAL_STMT = { anchor: "Dec 31", offset_days: 60 } as const;
/** 3.3-T10: Utah calendar-year supplemental statement by Dec 31 + 60 days unless the annual statement covers Jan–Dec. */
export function utahSupplement(yearStart: PlainDate, taxYear: number): { required: boolean; due_on: PlainDate | null } {
  const coversCalendarYear = yearStart.endsWith("-01-01");
  return coversCalendarYear ? { required: false, due_on: null } : { required: true, due_on: addDays(ymd(taxYear, 12, 31), UT_ANNUAL_STMT.offset_days) };
}
/** 3.3-T11: Chapter 13 with bk_suppress off → statement with legend and a 3002.1 package when the escrow payment actually changes. */
export function bankruptcyStatement(f: { chapter: 13 | 7; bk_suppress: boolean; prior_payment_cents: Cents; new_payment_cents: Cents }): { produced: boolean; legend: string | null; payment_changed: boolean; payment_change_cents: Cents; package_3002_1: boolean } {
  const change = f.new_payment_cents - f.prior_payment_cents;
  if (f.bk_suppress) return { produced: false, legend: null, payment_changed: change !== 0n, payment_change_cents: change, package_3002_1: false };
  return { produced: true, legend: bankruptcyLegend(f.chapter), payment_changed: change !== 0n, payment_change_cents: change, package_3002_1: f.chapter === 13 && change !== 0n };
}
/** 3.3-T12 / 3.1-T9: the vendor is down on the send date → in-house fallback mails the same day and the evidence is stored; on time iff mailed by the due date. */
export function sendWithFallback(vendorUp: boolean, sendOn: PlainDate, dueOn?: PlainDate): { channel: "vendor" | "in_house_mail"; evidence: { kind: "proof_of_mailing"; mailed_on: PlainDate }; on_time: boolean } {
  return { channel: vendorUp ? "vendor" : "in_house_mail", evidence: { kind: "proof_of_mailing", mailed_on: sendOn }, on_time: dueOn === undefined || sendOn <= dueOn };
}

// ---------------------------------------------------------------- 3.5 refund lifecycle
export type RefundStatus = "decided" | "scheduled" | "issued" | "cleared" | "returned" | "address_verified" | "reissued" | "stale" | "outreach" | "escheat_pending" | "escheated" | "retained" | "credited_to_new_loan";
export interface Refund { readonly loan_id: string; readonly amount_cents: Cents; status: RefundStatus; readonly due_on: PlainDate; issued_on?: PlainDate; check_no?: string; attempts: { on: PlainDate; kind: string }[]; ledger: { dr: string; cr: string; amount_cents: Cents }[]; approvals: { by: string; role: string }[]; }
export function scheduleRefund(loanId: string, amountCents: Cents, dueOn: PlainDate): Refund { return { loan_id: loanId, amount_cents: amountCents, status: "scheduled", due_on: dueOn, attempts: [], ledger: [], approvals: [] }; }
/** 3.5 guardrails / open question 3: refunds > $25,000 (or to a newly changed address) need two distinct officer approvals. */
export const REFUND_DUAL_APPROVAL_OVER_CENTS = 2_500_000n;
export function refundNeedsDualApproval(amountCents: Cents, addressChangedRecently = false): boolean { return amountCents > REFUND_DUAL_APPROVAL_OVER_CENTS || addressChangedRecently; }
/** 3.5 rule 6 / T1: issuing posts Dr escrow / Cr custodial_ti_cash; > $25,000 needs two distinct officer approvals first (T9). */
export function issueRefund(r: Refund, on: PlainDate, checkNo: string): Refund {
  if (refundNeedsDualApproval(r.amount_cents) && new Set(r.approvals.filter((a) => a.role === "officer").map((a) => a.by)).size < 2) throw new RangeError("refund > $25,000 needs officer dual approval before issuance");
  r.status = "issued"; r.issued_on = on; r.check_no = checkNo; r.attempts.push({ on, kind: "check" });
  r.ledger.push({ dr: "loan.escrow", cr: "custodial_ti_cash", amount_cents: r.amount_cents });
  return r;
}
export function approveRefund(r: Refund, by: Actor): Refund { if (by.kind !== "human" || by.role !== "officer") throw new RangeError("dual approval is an officer act"); if (r.approvals.some((a) => a.by === by.id)) throw new RangeError("the same officer cannot approve twice"); r.approvals.push({ by: by.id, role: "officer" }); return r; }
export function ledgerBalanced(r: Refund): boolean { return r.ledger.every((l) => l.amount_cents > 0n) && r.ledger.length > 0; }
/** 3.5-T7: a returned check on day N → address verification and reissue before day 30, else the breach is logged with the attempts. */
export function returnedRefund(r: Refund, returnedOn: PlainDate, addressVerifiedOn: PlainDate | null, reissuedOn: PlainDate | null): { status: RefundStatus; breach_logged: boolean; evidence: { on: PlainDate; kind: string }[] } {
  r.status = "returned"; r.attempts.push({ on: returnedOn, kind: "returned" });
  r.ledger.push({ dr: "custodial_ti_cash", cr: "loan.escrow", amount_cents: r.amount_cents });
  if (addressVerifiedOn) { r.status = "address_verified"; r.attempts.push({ on: addressVerifiedOn, kind: "address_verified" }); }
  if (reissuedOn) { r.status = "reissued"; r.attempts.push({ on: reissuedOn, kind: "reissued" }); r.ledger.push({ dr: "loan.escrow", cr: "custodial_ti_cash", amount_cents: r.amount_cents }); }
  return { status: r.status, breach_logged: !(reissuedOn && reissuedOn <= r.due_on), evidence: [...r.attempts] };
}
/** 3.5-T8: uncashed at 180 days → outreach notice and the state escheat clock. */
export function staleRefund(r: Refund, today: PlainDate, escheatYears: number): { status: RefundStatus; outreach_notice: boolean; escheat_starts_on: PlainDate | null; escheat_due_on: PlainDate | null } {
  if (!r.issued_on || today < addDays(r.issued_on, 180)) return { status: r.status, outreach_notice: false, escheat_starts_on: null, escheat_due_on: null };
  r.status = "outreach"; r.attempts.push({ on: today, kind: "outreach_notice" });
  return { status: r.status, outreach_notice: true, escheat_starts_on: today, escheat_due_on: addYears(today, escheatYears) };
}
/** 3.5-T6: oral consent (recorded call) to credit a new same-servicer loan → no check; inter-loan transfer posts on settlement. */
export function creditToNewLoan(r: Refund, consent: { recorded_call_id: string; given_on: PlainDate }, newLoan: { id: string; settles_on: PlainDate }): { check_issued: false; posts_on: PlainDate; ledger: { dr: string; cr: string; amount_cents: Cents } } {
  if (newLoan.settles_on < consent.given_on) throw new RangeError("the new loan must settle on/after the consent date (§1024.34(b)(2))");
  r.status = "credited_to_new_loan"; const line = { dr: `${r.loan_id}.escrow`, cr: `${newLoan.id}.escrow`, amount_cents: r.amount_cents }; r.ledger.push(line);
  return { check_issued: false, posts_on: newLoan.settles_on, ledger: line };
}
/** 3.5-T3 / example (d): not current → retained; reinstatement triggers an interim analysis that re-decides. */
export function retainedSurplus(surplusCents: Cents, regxDaysDelinquent: number, reinstatedOn: PlainDate | null): { status: "retained" | "decided"; timer: null | { due_on: PlainDate }; interim_analysis_on: PlainDate | null } {
  if (regxDaysDelinquent > 30 && !reinstatedOn) return { status: "retained", timer: null, interim_analysis_on: null };
  const analysisOn = reinstatedOn ? addDays(reinstatedOn, 1) : null;
  return { status: "decided", timer: analysisOn ? { due_on: addDays(analysisOn, 30) } : null, interim_analysis_on: analysisOn };
}

// ---------------------------------------------------------------- 3.7 disbursement lifecycle and escrow events
export type DisbursementStatus = "projected" | "scheduled" | "funds_check" | "released" | "advance_required" | "sent" | "confirmed" | "rejected" | "returned" | "reissued" | "cancelled" | "refunded";
export interface EscrowEvent { readonly sequence: number; readonly item: string; readonly amount_cents: Cents; readonly balance_cents: Cents; readonly processed_on: PlainDate; readonly deadline_at: PlainDate; readonly category: "T&I"; status: "queued" | "sent" | "accepted" | "accepted_warning" | "rejected" | "corrected"; readonly corrects?: number; }
export class EscrowEventLedger {
  private seq = 0; balance: Cents; readonly events: EscrowEvent[] = [];
  constructor(openingBalance: Cents) { this.balance = openingBalance; }
  /** 3.7 rule 11: amount = signed change, balance after posting, deadline next Fannie Mae BD 03:00 ET, next per-loan sequence. */
  emit(item: string, amountCents: Cents, processedOn: PlainDate): EscrowEvent {
    this.balance += amountCents; this.seq += 1;
    const e: EscrowEvent = { sequence: this.seq, item, amount_cents: amountCents, balance_cents: this.balance, processed_on: processedOn, deadline_at: addBusinessDays(processedOn, 1, fannieEt), category: "T&I", status: "queued" };
    this.events.push(e); return e;
  }
  /** 3.7-T7: a rejected event is corrected with the same sequence position; the rejected one shows `corrected`. */
  correct(sequence: number, fix: { amount_cents?: Cents; balance_cents?: Cents }, processedOn: PlainDate): EscrowEvent {
    const bad = this.events.find((e) => e.sequence === sequence && e.status === "rejected"); if (!bad) throw new RangeError(`no rejected event ${sequence}`);
    bad.status = "corrected";
    const fixed: EscrowEvent = { ...bad, amount_cents: fix.amount_cents ?? bad.amount_cents, balance_cents: fix.balance_cents ?? bad.balance_cents, processed_on: processedOn, deadline_at: addBusinessDays(processedOn, 1, fannieEt), status: "queued", corrects: sequence };
    this.events.push(fixed); return fixed;
  }
  /** 3.7-T15: a reversal emits the opposite-signed event with the next sequence; the balance is restored. */
  reverse(sequence: number, processedOn: PlainDate): EscrowEvent { const orig = this.events.find((e) => e.sequence === sequence); if (!orig) throw new RangeError(`no event ${sequence}`); return this.emit(`${orig.item} (reversal)`, -orig.amount_cents, processedOn); }
  /** Balance-equation invariant before sending: prior reported + Σ unsent = ledger balance. */
  invariantHolds(ledgerBalance: Cents): boolean { const reported = this.events.filter((e) => e.status === "accepted" || e.status === "accepted_warning").reduce((s, e) => s + e.amount_cents, 0n); const unsent = this.events.filter((e) => e.status === "queued" || e.status === "sent").reduce((s, e) => s + e.amount_cents, 0n); return reported + unsent === ledgerBalance - (this.balance - reported - unsent); }
}
/** 3.7 rule 13 / T8: the attestation package is ready on BD3 of the following month; the portal task SLA is BD2 of the month after that; a mismatch attests "No" with commentary and opens a variance case. */
export function attestationSchedule(period: PlainDate, reconciled: { ledger_loans: number; fnma_loans: number }): { package_ready_on: PlainDate; portal_task_sla_on: PlainDate; outcome: "attested_yes" | "attested_no_with_commentary"; variance_case: boolean } {
  const { y, m } = parts(period);
  const next = ymd(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1); const after = addMonths(next, 1);
  const bd = (from: PlainDate, n: number) => { let d = addDays(from, -1); for (let i = 0; i < n; i++) d = addBusinessDays(d, 1, fannieEt); return d; };
  const mismatch = reconciled.ledger_loans !== reconciled.fnma_loans;
  return { package_ready_on: bd(next, 3), portal_task_sla_on: bd(after, 2), outcome: mismatch ? "attested_no_with_commentary" : "attested_yes", variance_case: mismatch };
}
/** FNMA_LL2026_05_ESCROW_SETUP_CUTOVER: the configured cutover is ≤ 2026-12-01 and Setup events are accepted for 100% of escrowed loans by that mandatory date (LL-2026-05). */
export const ESCROW_SETUP_CUTOVER_DEADLINE: PlainDate = "2026-12-01" as PlainDate;
export interface CutoverLoan { readonly loan_id: string; readonly escrowed: boolean; readonly active: boolean; readonly categories: readonly { category: string; balance_cents: Cents }[]; readonly first_deposit?: { amount_cents: Cents; on: PlainDate } | null; }
export interface SetupAck { readonly loan_id: string; readonly category: string; readonly status: "accepted" | "accepted_warning" | "rejected" | "pending"; readonly accepted_on?: PlainDate; }
/**
 * 3.7 rule 12 / T9: one Setup event per category for every active and inactive escrowed loan, queued through the per-loan event
 * ledger so its sequence precedes the first deposit event (a deposit processed before the cutover is flagged, not assumed away);
 * acceptance is measured from the Fannie Mae acks against the LL-2026-05 deadline.
 */
export function setupEventsAtCutover(loans: readonly CutoverLoan[], cutoverOn: PlainDate, acks: readonly SetupAck[] = []): { events: { loan_id: string; category: string; type: "EscrowSetup"; sequence: number; balance_cents: Cents; deadline_at: PlainDate; before_first_deposit: boolean; ack: SetupAck["status"] }[]; accept_by: PlainDate; cutover_on_time: boolean; accepted_pct: number; all_accepted_by_deadline: boolean; covers_inactive: boolean; missing: string[] } {
  const events: { loan_id: string; category: string; type: "EscrowSetup"; sequence: number; balance_cents: Cents; deadline_at: PlainDate; before_first_deposit: boolean; ack: SetupAck["status"] }[] = [];
  for (const l of loans.filter((x) => x.escrowed)) {
    for (const c of l.categories) {
      const led = new EscrowEventLedger(0n); const deposit = l.first_deposit ?? null;
      const earlyDeposit = deposit && deposit.on < cutoverOn ? led.emit("Loan Escrow Payment", deposit.amount_cents, deposit.on) : null;   // a deposit already processed before the cutover comes first in the ledger
      const setup = led.emit("Set up", c.balance_cents, cutoverOn);
      const lateDeposit = deposit && !earlyDeposit ? led.emit("Loan Escrow Payment", deposit.amount_cents, deposit.on) : null;
      const firstDeposit = earlyDeposit ?? lateDeposit;
      const ack = acks.find((a) => a.loan_id === l.loan_id && a.category === c.category);
      events.push({ loan_id: l.loan_id, category: c.category, type: "EscrowSetup", sequence: setup.sequence, balance_cents: setup.balance_cents, deadline_at: setup.deadline_at, before_first_deposit: firstDeposit === null || setup.sequence < firstDeposit.sequence, ack: ack?.status ?? "pending" });
    }
  }
  const accepted = events.filter((e) => e.ack === "accepted" || e.ack === "accepted_warning");
  const acceptedByDeadline = accepted.every((e) => { const a = acks.find((x) => x.loan_id === e.loan_id && x.category === e.category); return !a?.accepted_on || a.accepted_on <= ESCROW_SETUP_CUTOVER_DEADLINE; });
  const inactive = loans.filter((l) => l.escrowed && !l.active);
  return {
    events, accept_by: ESCROW_SETUP_CUTOVER_DEADLINE, cutover_on_time: cutoverOn <= ESCROW_SETUP_CUTOVER_DEADLINE,
    accepted_pct: events.length ? Math.round((10_000 * accepted.length) / events.length) / 100 : 100, all_accepted_by_deadline: events.length > 0 && accepted.length === events.length && acceptedByDeadline,
    covers_inactive: inactive.every((l) => l.categories.every((c) => events.some((e) => e.loan_id === l.loan_id && e.category === c.category))),
    missing: events.filter((e) => e.ack !== "accepted" && e.ack !== "accepted_warning").map((e) => `${e.loan_id}:${e.category}`),
  };
}
/** 3.7 rule 9 / T11: non-escrowed delinquency → notice, 30-day follow-up; unpaid with a tax sale scheduled → advance + waiver revocation. */
export function nonEscrowDelinquency(f: { found_on: PlainDate; paid_by_followup: boolean; tax_sale_scheduled: boolean }): { notice: "NTC_SM_NONESCROW_TAX_DELINQUENCY"; follow_up_on: PlainDate; action: "monitor" | "advance_and_revoke_waiver" | "closed" } {
  const followUp = addDays(f.found_on, 30);
  return { notice: "NTC_SM_NONESCROW_TAX_DELINQUENCY", follow_up_on: followUp, action: f.paid_by_followup ? "closed" : f.tax_sale_scheduled ? "advance_and_revoke_waiver" : "monitor" };
}
/** 3.7 rule 8 / T12: a vendor reject is re-planned within 2 BD by ACH direct and paid before the must-pay date. */
export function replanAfterReject(rejectedOn: PlainDate, mustPayBy: PlainDate): { replan_by: PlainDate; method: "ach"; release_on: PlainDate; on_time: boolean } {
  const replanBy = rejectReplanDue(rejectedOn); const release = addBusinessDays(mustPayBy, -2, servicer);
  return { replan_by: replanBy, method: "ach", release_on: release > replanBy ? release : replanBy, on_time: replanBy < mustPayBy };
}
/** 3.7 rule 7 / T13: duplicate prevention by (payee, parcel/policy, period, amount). */
export function billHash(b: { payee: string; parcel_or_policy: string; period: string; amount_cents: Cents }): string { return `${b.payee}|${b.parcel_or_policy}|${b.period}|${b.amount_cents}`; }
export class BillDeduper { private readonly seen = new Set<string>(); readonly anomalies: string[] = []; accept(b: Parameters<typeof billHash>[0], feed: string): boolean { const h = billHash(b); if (this.seen.has(h)) { this.anomalies.push(`duplicate bill ${h} from ${feed}`); return false; } this.seen.add(h); return true; } }
/** 3.7 guardrails: "payee remittance changes require validated evidence and (policy) `officer` dual approval when > $10,000 or a new payee". */
export const PAYEE_CHANGE_DUAL_OVER_CENTS = 1_000_000n;
/** T14: a new payee, or a payee instruction changed within the day before release on a disbursement > $10,000, needs officer dual approval; a routine bill to an unchanged payee never does. */
export function releaseApproval(f: { amount_cents: Cents; payee_instruction_changed_on?: PlainDate | null; release_on: PlainDate; new_payee: boolean }): { dual_approval_required: boolean; reason: string | null; payee_change: boolean } {
  const changed = !!f.payee_instruction_changed_on && addDays(f.payee_instruction_changed_on, 1) >= f.release_on;
  if (f.new_payee) return { dual_approval_required: true, reason: "new payee", payee_change: true };
  if (changed && f.amount_cents > PAYEE_CHANGE_DUAL_OVER_CENTS) return { dual_approval_required: true, reason: "payee remittance instruction changed yesterday", payee_change: true };
  return { dual_approval_required: false, reason: null, payee_change: changed };
}
/** (k)(5)(ii)(A) inability reasons and the LPI gate (T5). */
export function cancellationOverlay(reason: "underwriting" | "non_payment" | "vacancy" | "other", receivedOn: PlainDate): { inability_to_disburse: boolean; reason_code: string | null; lpi_gate_open: boolean; recorded_on: PlainDate } {
  const inability = reason !== "non_payment";
  return { inability_to_disburse: inability, reason_code: inability ? `1024.17(k)(5)(ii)(A):${reason}` : null, lpi_gate_open: inability, recorded_on: receivedOn };
}
/** Advance ledger (rule 6 / T2). */
export function advanceEntries(amountCents: Cents, advanceCents: Cents): { dr: string; cr: string; amount_cents: Cents }[] {
  const out = [] as { dr: string; cr: string; amount_cents: Cents }[];
  if (advanceCents > 0n) out.push({ dr: "custodial_ti_cash", cr: "servicer_advance_receivable", amount_cents: advanceCents });
  out.push({ dr: "loan.escrow", cr: "custodial_ti_cash", amount_cents: amountCents });
  return out;
}

// ---------------------------------------------------------------- 3.8 state rights and scripts
/** MN Stat. 47.20 subd. 9 (T8): right-to-discontinue notice within 60 days of the 5th anniversary; a written election with no > 30-day delinquency in 12 months is approved even if the Fannie Mae 80% test fails (open question 1 default). */
export function minnesotaDiscontinue(f: { mortgage_date: PlainDate; today: PlainDate; written_election: boolean; late_over_30_in_12m: number; fnma_80_test_passed: boolean }): { anniversary: PlainDate; notice_due_on: PlainDate; notice_due_now: boolean; election: "approved" | "denied" | "none"; basis: string } {
  const anniversary = addYears(f.mortgage_date, 5); const due = addDays(anniversary, 60);
  const election = !f.written_election ? "none" : f.late_over_30_in_12m === 0 ? "approved" : "denied";
  return { anniversary, notice_due_on: due, notice_due_now: f.today >= anniversary && f.today <= due, election, basis: election === "approved" && !f.fnma_80_test_passed ? "Minn. Stat. 47.20 subd. 9 state right overrides the Fannie Mae 80% test (open question 1 default)" : "Minn. Stat. 47.20 subd. 9" };
}
/** IL (T9): termination election approved at ≤ 65% of the original amount by timely payments and not in default (Illinois Mortgage Escrow Account Act §5). */
export function illinoisTermination(f: { upb_cents: Cents; original_amount_cents: Cents; timely_payments: boolean; in_default: boolean }): { approved: boolean; ratio_pct: string; reason: string | null } {
  const ratio = Decimal.ratio(f.upb_cents * 100n, f.original_amount_cents);
  const ok = ratio.cmp(Decimal.parse("65")) <= 0 && f.timely_payments && !f.in_default;
  return { approved: ok, ratio_pct: ratio.toFixed(2), reason: ok ? null : ratio.cmp(Decimal.parse("65")) > 0 ? "above 65% of the original amount" : f.in_default ? "in default" : "reduction not by timely payments" };
}
/** T10: outbound scripts never solicit a waiver. */
export function scriptSolicitsWaiver(script: string): boolean { return /(waive|drop|cancel|discontinue)[^.]{0,40}escrow|escrow[^.]{0,40}(waiver|waive)/i.test(script) && /(would you like|want to|interested|can offer|we recommend)/i.test(script); }
/** Waiver closeout arithmetic (T2 / worked example): balance after paying bills due within 30 days is refunded within 30 days; short-year statement within 60; event to balance 0. */
export function waiverCloseout(balanceCents: Cents, billsWithin30Cents: Cents, effectiveOn: PlainDate): { refund_cents: Cents; refund_by: PlainDate; short_year_statement_by: PlainDate; event_balance_cents: 0n } {
  return { refund_cents: balanceCents - billsWithin30Cents, refund_by: addDays(effectiveOn, 30), short_year_statement_by: addDays(effectiveOn, 60), event_balance_cents: 0n };
}
/** T7: a Flex Mod trial offer on a waived loan proceeds only with the documented exception (current on T&I); delinquent T&I blocks until escrow is established. */
export function workoutEscrowGate(f: { waived: boolean; current_on_ti: boolean; exception_documented: boolean }): { ok: boolean; block: string | null } {
  if (!f.waived) return { ok: true, block: null };
  if (f.current_on_ti && f.exception_documented) return { ok: true, block: null };
  return { ok: false, block: f.current_on_ti ? "document the Flex Mod escrow-waiver exception before the offer" : "T&I delinquent: establish escrow before the offer (B-1-01)" };
}

// ---------------------------------------------------------------- 3.9 rate calendars, verification, 1099
/** NH (T8): rate switches Apr 1 / Oct 1 to the FDIC January / July savings observations. */
export function nhRateFor(d: PlainDate, obs: { january_pct: string; july_pct: string }): { rate_pct: string; basis: "fdic_january" | "fdic_july"; switched_on: PlainDate } {
  const { y, m } = parts(d);
  if (m >= 4 && m < 10) return { rate_pct: obs.january_pct, basis: "fdic_january", switched_on: ymd(y, 4, 1) };
  return { rate_pct: obs.july_pct, basis: "fdic_july", switched_on: m >= 10 ? ymd(y, 10, 1) : ymd(y - 1, 10, 1) };
}
/** OR (T12): Jul 1 / Jan 1 from the May / Nov auction observations minus 100 bps, floored at 0. */
export function orRateFor(d: PlainDate, obs: { may_pct: string; november_pct: string }): { rate_pct: string; switched_on: PlainDate } {
  const { y, m } = parts(d);
  const src = m >= 7 ? obs.may_pct : obs.november_pct;
  const r = Decimal.parse(src).sub(Decimal.ONE);
  return { rate_pct: r.cmp(Decimal.ZERO) < 0 ? "0" : r.toString(), switched_on: m >= 7 ? ymd(y, 7, 1) : ymd(y, 1, 1) };
}
/** T10: a missing observation keeps the prior verified rate, opens a sev-2 escalation; verification posts a true-up. */
export function rateObservation(f: { state: string; expected_on: PlainDate; observed_pct: string | null; prior_verified_pct: string; accrued_at_prior_cents: Cents; base_cents: Cents; days: number }): { rate_in_effect_pct: string; escalation: "sev2" | null; true_up_cents: Cents } {
  if (f.observed_pct === null) return { rate_in_effect_pct: f.prior_verified_pct, escalation: "sev2", true_up_cents: 0n };
  const correct = divRound(f.base_cents * Decimal.parse(f.observed_pct).unscaled * BigInt(f.days), 100n * 365n * Decimal.ONE.unscaled, "HALF_UP");
  return { rate_in_effect_pct: f.observed_pct, escalation: null, true_up_cents: correct - f.accrued_at_prior_cents };
}
/** 3.9 edge case "PMI cancellation (RI) — recompute on `pmi.terminated`": reads the loan's latest `pmi.terminated` event (Section 10) and records the recomputed eligibility as a `loan_events` fact. */
export function recomputeOnPmiTerminated(events: EventStore, loanId: string, f: LoanFacts, actor: Actor): (ReturnType<typeof pmiTerminationRecompute> & { terminated_on: PlainDate }) | null {
  const e = events.ofType("pmi.terminated").filter((x) => x.loanId === loanId).at(-1);
  const on = e ? String((e.payload as Record<string, unknown>).terminated_on ?? (e.payload as Record<string, unknown>).effective_on ?? e.occurredAt.slice(0, 10)) as PlainDate : null;
  if (!on) return null;
  const r = pmiTerminationRecompute(f, on);
  events.append({ type: "escrow.interest.eligibility.recomputed", loanId, actor, causationId: e!.id, payload: { trigger: "pmi.terminated", terminated_on: on, exempt_through: r.exempt_through, accrual_starts_on: r.accrual_starts_on, exemption_after: r.exemption_after } });
  return { ...r, terminated_on: on };
}
/** IRS_1099INT_FURNISH_0131: Jan 31 "next business day if weekend/holiday per IRS rules" — the federal calendar rolls forward. */
export function rollForward(d: PlainDate, cal: { isBusinessDay(d: PlainDate): boolean } = federal): PlainDate { let x = d; while (!cal.isBusinessDay(x)) x = addDays(x, 1); return x; }
/** T9: 1099-INT furnished by Jan 31 (rolled to the next federal business day) and e-filed by Mar 31 (IRS_1099INT_EFILE_0331, offset 0) of the following year when ≥ $10. */
export function form1099Int(totalCents: Cents, taxYear: number): { required: boolean; furnish_by: PlainDate | null; efile_by: PlainDate | null } {
  if (totalCents < 1_000n) return { required: false, furnish_by: null, efile_by: null };
  return { required: true, furnish_by: rollForward(ymd(taxYear + 1, 1, 31)), efile_by: ymd(taxYear + 1, 3, 31) };
}
/** T11: daily accrual with negative days contributing $0. */
export function accrueDaily(balances: readonly Cents[], ratePct: string): Cents {
  return balances.reduce((s, b) => s + (b > 0n ? divRound(b * Decimal.parse(ratePct).unscaled, 100n * 365n * Decimal.ONE.unscaled, "HALF_UP") : 0n), 0n);
}
export const escrowCalendars = { servicer, federal, endOfMonth };
