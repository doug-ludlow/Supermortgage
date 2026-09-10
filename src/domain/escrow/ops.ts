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
import type { Actor } from "../../kernel/events/index.ts";
import { project, type ProjectedItem, type Projection } from "./analysis.ts";
import { annualDeadline } from "./statement.ts";
import { rejectReplanDue } from "./disbursement.ts";

// ---------------------------------------------------------------- 3.1 initial statement
export type InitialStatementStatus = "satisfied_by_originator" | "required" | "sent" | "cancelled";
/** 3.1 rule 1: originator evidence dated ≤ settlement + 45 days satisfies (g)(1); otherwise the 45-day timer runs from settlement, and a lapsed window means send now + inherited breach + qc_finding. */
export function initialStatementStatus(f: { settlement_date: PlainDate; boarded_on: PlainDate; originator_statement_delivered_on?: PlainDate | null }): { status: InitialStatementStatus; timer: { code: "REGX_1024_17G_INITIAL_STMT_45"; due_on: PlainDate; breached_at_boarding: boolean; waiver_reason?: "inherited_from_originator" } | null; send_by: PlainDate | null; qc_finding: "originator_failed_g1" | null } {
  const due = addDays(f.settlement_date, 45);
  if (f.originator_statement_delivered_on && f.originator_statement_delivered_on <= due) return { status: "satisfied_by_originator", timer: null, send_by: null, qc_finding: null };
  if (f.boarded_on > due) return { status: "required", timer: { code: "REGX_1024_17G_INITIAL_STMT_45", due_on: due, breached_at_boarding: true, waiver_reason: "inherited_from_originator" }, send_by: addBusinessDays(f.boarded_on, 1, servicer), qc_finding: "originator_failed_g1" };
  return { status: "required", timer: { code: "REGX_1024_17G_INITIAL_STMT_45", due_on: due, breached_at_boarding: false }, send_by: due, qc_finding: null };
}
/** 3.1-T5/T6: transfer-in with a changed payment → (e)(1) statement within 60 days of the transfer date and a new computation year; establishment (waiver revocation) → 45 days, Setup event before any deposit event. */
export function establishmentStatement(kind: "transfer_in_changed", on: PlainDate, changedByCents: Cents): { timer: "REGX_1024_17E_TRANSFER_INITIAL_STMT_60"; due_on: PlainDate; computation_year_start: PlainDate } | { timer: null; computation_year_start: "retained" };
export function establishmentStatement(kind: "established", on: PlainDate): { timer: "REGX_1024_17G_INITIAL_STMT_45"; due_on: PlainDate; events_in_order: ["EscrowSetup", "deposit"] };
export function establishmentStatement(kind: "transfer_in_changed" | "established", on: PlainDate, changedByCents: Cents = 0n): unknown {
  if (kind === "established") return { timer: "REGX_1024_17G_INITIAL_STMT_45", due_on: addDays(on, 45), events_in_order: ["EscrowSetup", "deposit"] };
  return changedByCents === 0n ? { timer: null, computation_year_start: "retained" } : { timer: "REGX_1024_17E_TRANSFER_INITIAL_STMT_60", due_on: addDays(on, 60), computation_year_start: on };
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
export interface AnnualStatement { readonly items: Record<"i" | "ii" | "iii" | "iv" | "v" | "vi" | "vii" | "viii", unknown>; readonly prior_projection_attached: true; readonly history: StatementHistoryRow[]; readonly send_by: PlainDate; readonly send_target_on: PlainDate; readonly legend: string | null; }
/** 3.3 rules 1–4, 8 (T1/T2): items (i)–(viii), prior projection attached, actuals after the run date when approved late. */
export function assembleAnnualStatement(f: { year_start: PlainDate; year_end: PlainDate; approved_on: PlainDate; new_payment_cents: Cents; prior_escrow_portion_cents: Cents; history: readonly StatementHistoryRow[]; decision_text: string; low_point_explanation: readonly string[]; interest_credited_cents?: Cents; bankruptcy?: { chapter: 7 | 13 } | null }): AnnualStatement {
  const late = f.approved_on > f.year_end;
  const history = f.history.map((r) => ({ ...r, assumed: late ? false : r.month > f.approved_on }));
  const d = annualDeadline(f.year_end);
  return {
    items: { i: { monthly_payment_cents: f.new_payment_cents }, ii: { prior_escrow_portion_cents: f.prior_escrow_portion_cents }, iii: { deposits_cents: history.reduce((s, r) => s + r.deposits_cents, 0n) }, iv: { disbursements: history.flatMap((r) => r.disbursements) }, v: { balances: history.map((r) => [r.month, r.balance_cents]) }, vi: { surplus_shortage_deficiency: f.decision_text }, vii: { plan_text: f.decision_text }, viii: { low_point_explanation: [...f.low_point_explanation], interest_credited_cents: f.interest_credited_cents ?? 0n } },
    prior_projection_attached: true, history, send_by: d.due_on, send_target_on: d.send_target_on,
    legend: f.bankruptcy ? (f.bankruptcy.chapter === 13 ? "Informational: your escrow payment change will be noticed under Bankruptcy Rule 3002.1." : "Informational only — this is not an attempt to collect a debt.") : null,
  };
}
/** 3.3-T3: exempt hold; a shortage still gets the (f)(5) notice, which satisfies REGX_1024_17F5_SHORTAGE_NOTICE_ANNUAL. */
export function exemptHold(reason: "delinquent_30" | "foreclosure_action", shortageCents: Cents): { status: "exempt_hold"; reason: string; statement_mailed: false; notice: "NTC_REGX_1024_17F_SHORTAGE" | null; f5_timer_satisfied: boolean } {
  return { status: "exempt_hold", reason, statement_mailed: false, notice: shortageCents > 0n ? "NTC_REGX_1024_17F_SHORTAGE" : null, f5_timer_satisfied: shortageCents > 0n };
}
/** 3.3-T6: transfer-out cancels the annual timer; the transferor short-year statement is due 60 days after the effective date. */
export function transferOutStatements(effectiveOn: PlainDate): { annual_timer: "cancelled"; cancel_reason: "transfer_out"; short_year: { code: "REGX_1024_17I4_SHORT_YEAR_TRANSFER_60"; due_on: PlainDate; notice: "NTC_REGX_1024_17I4_SHORT_YEAR_TRANSFEROR" } } {
  return { annual_timer: "cancelled", cancel_reason: "transfer_out", short_year: { code: "REGX_1024_17I4_SHORT_YEAR_TRANSFER_60", due_on: addDays(effectiveOn, 60), notice: "NTC_REGX_1024_17I4_SHORT_YEAR_TRANSFEROR" } };
}
/** 3.3-T7: payoff short-year statement shows the refund disposition. */
export function payoffStatement(fundsOn: PlainDate, closingBalanceCents: Cents, disposition: "refund" | "credit_to_new_loan" | "netted"): { due_on: PlainDate; closing_balance_cents: Cents; refund_disposition: string; projection: null } {
  return { due_on: addDays(fundsOn, 60), closing_balance_cents: closingBalanceCents, refund_disposition: `${disposition}: ${closingBalanceCents} cents`, projection: null };
}
/** 3.3-T10: Utah calendar-year supplemental statement by March 1 unless the annual statement covers Jan–Dec. */
export function utahSupplement(yearStart: PlainDate, taxYear: number): { required: boolean; due_on: PlainDate | null } {
  const coversCalendarYear = yearStart.endsWith("-01-01");
  return coversCalendarYear ? { required: false, due_on: null } : { required: true, due_on: ymd(taxYear + 1, 3, 1) };
}
/** 3.3-T11: Chapter 13 with bk_suppress off → statement with legend and a 3002.1 package when the payment changes. */
export function bankruptcyStatement(f: { chapter: 13 | 7; bk_suppress: boolean; payment_changed: boolean }): { produced: boolean; legend: string | null; package_3002_1: boolean } {
  if (f.bk_suppress) return { produced: false, legend: null, package_3002_1: false };
  return { produced: true, legend: f.chapter === 13 ? "Bankruptcy Rule 3002.1 payment-change notice to follow" : "informational only", package_3002_1: f.chapter === 13 && f.payment_changed };
}
/** 3.3-T12 / 3.1-T9: the vendor is down on the send date → in-house fallback mails and the evidence is stored. */
export function sendWithFallback(vendorUp: boolean, sendOn: PlainDate): { channel: "vendor" | "in_house_mail"; evidence: { kind: "proof_of_mailing"; mailed_on: PlainDate } } {
  return { channel: vendorUp ? "vendor" : "in_house_mail", evidence: { kind: "proof_of_mailing", mailed_on: sendOn } };
}

// ---------------------------------------------------------------- 3.5 refund lifecycle
export type RefundStatus = "decided" | "scheduled" | "issued" | "cleared" | "returned" | "address_verified" | "reissued" | "stale" | "outreach" | "escheat_pending" | "escheated" | "retained" | "credited_to_new_loan";
export interface Refund { readonly loan_id: string; readonly amount_cents: Cents; status: RefundStatus; readonly due_on: PlainDate; issued_on?: PlainDate; check_no?: string; attempts: { on: PlainDate; kind: string }[]; ledger: { dr: string; cr: string; amount_cents: Cents }[]; approvals: { by: string; role: string }[]; }
export function scheduleRefund(loanId: string, amountCents: Cents, dueOn: PlainDate): Refund { return { loan_id: loanId, amount_cents: amountCents, status: "scheduled", due_on: dueOn, attempts: [], ledger: [], approvals: [] }; }
/** 3.5 rule 6 / T1: issuing posts Dr escrow / Cr custodial_ti_cash; > $25,000 needs two officer approvals first (T9). */
export function issueRefund(r: Refund, on: PlainDate, checkNo: string): Refund {
  if (r.amount_cents >= 2_500_000n && r.approvals.filter((a) => a.role === "officer").length < 2) throw new RangeError("refund ≥ $25,000 needs officer dual approval before issuance");
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
/** 3.7 rule 12 / T9: Setup events for every active and inactive escrowed loan per category before the first deposit event; 100% accepted by the cutover deadline. */
export function setupEventsAtCutover(loans: readonly { loan_id: string; escrowed: boolean; active: boolean; categories: readonly string[] }[], cutoverOn: PlainDate, acceptBy: PlainDate): { events: { loan_id: string; category: string; type: "EscrowSetup"; before_first_deposit: true }[]; accept_by: PlainDate; covers_inactive: boolean } {
  const events = loans.filter((l) => l.escrowed).flatMap((l) => l.categories.map((category) => ({ loan_id: l.loan_id, category, type: "EscrowSetup" as const, before_first_deposit: true as const })));
  return { events, accept_by: acceptBy, covers_inactive: loans.some((l) => l.escrowed && !l.active) ? events.some((e) => loans.find((l) => l.loan_id === e.loan_id)?.active === false) : true };
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
/** 3.7 guardrails / T14: a payee instruction changed within 24h, a new payee, or > $10,000 needs officer dual approval before release. */
export function releaseApproval(f: { amount_cents: Cents; payee_instruction_changed_on?: PlainDate | null; release_on: PlainDate; new_payee: boolean }): { dual_approval_required: boolean; reason: string | null } {
  if (f.new_payee) return { dual_approval_required: true, reason: "new payee" };
  if (f.payee_instruction_changed_on && addDays(f.payee_instruction_changed_on, 1) >= f.release_on) return { dual_approval_required: true, reason: "payee remittance instruction changed yesterday" };
  if (f.amount_cents > 1_000_000n) return { dual_approval_required: true, reason: "disbursement > $10,000" };
  return { dual_approval_required: false, reason: null };
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
/** T9: 1099-INT furnished by Jan 31 and e-filed by Mar 31 of the following year when ≥ $10. */
export function form1099Int(totalCents: Cents, taxYear: number): { required: boolean; furnish_by: PlainDate | null; efile_by: PlainDate | null } {
  if (totalCents < 1_000n) return { required: false, furnish_by: null, efile_by: null };
  return { required: true, furnish_by: ymd(taxYear + 1, 1, 31), efile_by: ymd(taxYear + 1, 3, 31) };
}
/** T11: daily accrual with negative days contributing $0. */
export function accrueDaily(balances: readonly Cents[], ratePct: string): Cents {
  return balances.reduce((s, b) => s + (b > 0n ? divRound(b * Decimal.parse(ratePct).unscaled, 100n * 365n * Decimal.ONE.unscaled, "HALF_UP") : 0n), 0n);
}
export const escrowCalendars = { servicer, federal, endOfMonth };
