/**
 * §6 mechanics beyond the calculators in accounts/reconciliation/suspense:
 * executed-form verification (6.1), interest-disposition breach and T&I
 * unmatched debits (6.2), the Form 496 timer outcome, unidentified-debit
 * fraud path, statement quarantine, reviewer rework, approval reminder,
 * retro-corrections and the LL-2026-05 A/A line-1 switch (6.3), paid-not-
 * issued checks and the attestation tie-out (6.4), partial accumulation,
 * day-30 returns, the $50 rule, Reg Z crediting on accumulation, suspense
 * aging and the AI-outreach warm transfer (6.5). bigint cents throughout.
 */
import { addDays, daysBetween, type PlainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { zonedEpochMs, wallClock } from "../../kernel/calendar/zoned.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { interestDispositionDueMs } from "./accounts.ts";
import { form496Deadline, shortageFunding, controlTotalsOk, matchBankLine, lossDraftAgedMonths, type BankLine, type LedgerItem } from "./reconciliation.ts";
import { agingDays } from "./suspense.ts";
import { handleUtterance } from "../servicing-requests/ops.ts";

export const ET = "America/New_York";

// ---- 6.1 -------------------------------------------------------------------
export interface FormFacts { readonly account_number: string; readonly title: string; readonly aba: string; readonly remittance_type: string; readonly effective_date: PlainDate; }
/** 6.1 agent design: the executed PDF is verified field by field against the plan; any mismatch reopens the portal task and the form is never `in_effect` without the executed document hash. */
export function verifyExecutedForm(f: { plan: FormFacts; executed: FormFacts; executed_document_hash: string | null }): { matches: boolean; mismatches: (keyof FormFacts)[]; in_effect: boolean; reopen_task: boolean; reason: string | null } {
  const keys: (keyof FormFacts)[] = ["account_number", "title", "aba", "remittance_type", "effective_date"];
  const mismatches = keys.filter((k) => f.plan[k] !== f.executed[k]);
  if (mismatches.length) return { matches: false, mismatches, in_effect: false, reopen_task: true, reason: `executed form differs from the plan: ${mismatches.join(", ")}` };
  if (!f.executed_document_hash) return { matches: true, mismatches: [], in_effect: false, reopen_task: false, reason: "no executed document hash" };
  return { matches: true, mismatches: [], in_effect: true, reopen_task: false, reason: null };
}

// ---- 6.2 -------------------------------------------------------------------
/** 6.2-T4: no disposition by day 30 → breach, `officer` medium, and the credit appears as an aged "Other" item on Form 496A line 6. */
export function interestDispositionStatus(f: { credited_on: PlainDate; amount_cents: Cents; disposed_at_ms: number | null; now_ms: number }): { due_ms: number; status: "satisfied" | "armed" | "breached"; escalation: { role: "officer"; severity: "medium" } | null; form496a_item: { line: 6; category: "Other"; description: string; amount_cents: Cents; aging_days: number } | null } {
  const due = interestDispositionDueMs(f.credited_on);
  if (f.disposed_at_ms !== null && f.disposed_at_ms <= due) return { due_ms: due, status: "satisfied", escalation: null, form496a_item: null };
  const breached = f.now_ms > due && f.disposed_at_ms === null;
  const aging = daysBetween(f.credited_on, wallClock(f.now_ms, ET).date);
  return { due_ms: due, status: breached ? "breached" : "armed", escalation: breached ? { role: "officer", severity: "medium" } : null, form496a_item: { line: 6, category: "Other", description: `interest credited ${f.credited_on} pending disposition`, amount_cents: f.amount_cents, aging_days: aging } };
}
/** 6.2-T6: a T&I statement debit with no `disbursements` match within 1 BD → `unmatched_debit` (high) and the bank's positive-pay exception list is pulled. */
export function tiUnmatchedDebit(f: { debit: BankLine; disbursements: readonly LedgerItem[]; as_of: PlainDate }): { exception: { code: "unmatched_debit"; severity: "high"; amount_cents: Cents; debit_id: string } | null; actions: string[]; matched_ids: string[] } {
  const m = matchBankLine(f.debit, f.disbursements);
  if (m.tier !== "unmatched") return { exception: null, actions: [], matched_ids: m.ledger_ids };
  if (f.as_of < addBusinessDays(f.debit.value_date, 1, servicer)) return { exception: null, actions: ["wait_1bd"], matched_ids: [] };
  return { exception: { code: "unmatched_debit", severity: "high", amount_cents: f.debit.amount_cents, debit_id: f.debit.id }, actions: ["pull_positive_pay_exception_list", "open_exception"], matched_ids: [] };
}

// ---- 6.3 -------------------------------------------------------------------
/** 6.3-T3 / 6.4-T8: the 45-day form timer is satisfied only by `custodial.reconciliation.completed`; a breach is `officer` critical + partner notice + a Compliance Sentinel line. */
export function form496TimerOutcome(f: { kind: "monthly_form_496" | "monthly_form_496a"; period_end: PlainDate; completed_at_ms: number | null; now_ms: number }): { due_at_ms: number; due_on: PlainDate; warning_on: PlainDate; status: "satisfied" | "armed" | "breached"; escalation: { role: "officer"; severity: "critical" } | null; partner_notice: boolean; sentinel_line: string | null } {
  const d = form496Deadline(f.period_end);
  if (f.completed_at_ms !== null && f.completed_at_ms <= d.due_at_ms) return { ...d, status: "satisfied", escalation: null, partner_notice: false, sentinel_line: null };
  const breached = f.now_ms > d.due_at_ms;
  return { ...d, status: breached ? "breached" : "armed", escalation: breached ? { role: "officer", severity: "critical" } : null, partner_notice: breached, sentinel_line: breached ? `${f.kind} for period ending ${f.period_end} not completed by ${d.due_on} 17:00 (45-day custodial reconciliation, Fannie Mae A4-1-02)` : null };
}
/** 6.3-T5 / rule 5: an unmatched bank debit absent from Draft Notifications and CRS reports is a suspected unauthorized debit — critical, `fraud` case, same-day bank contact, funding tier, `officer`. */
export function unidentifiedDebit(f: { amount_cents: Cents; type_code: string; in_draft_notifications: boolean; in_crs_reports: boolean; identified_on: PlainDate }): { severity: "critical" | null; fraud_case: boolean; bank_contact_by: PlainDate | null; funding: ReturnType<typeof shortageFunding> | null; escalation: "officer" | null; category: string } {
  const category = f.type_code === "451" || f.type_code === "455" || f.type_code === "469" ? "ach_debit" : f.type_code === "475" ? "check_paid" : f.type_code === "495" ? "outgoing_wire" : "other";
  if (f.in_draft_notifications || f.in_crs_reports) return { severity: null, fraud_case: false, bank_contact_by: null, funding: null, escalation: null, category };
  return { severity: "critical", fraud_case: true, bank_contact_by: f.identified_on, funding: shortageFunding(f.amount_cents, f.identified_on, true), escalation: "officer", category };
}
/** 6.3-T10 / rule 1: control totals must tie or the statement is quarantined and re-requested; the daily reconciliation closes carrying the item. */
export function ingestStatement(f: { file_id: string; credit_lines: readonly Cents[]; summary_credits: Cents; debit_lines: readonly Cents[]; summary_debits: Cents }): { ok: boolean; exception: "control_total_mismatch" | null; quarantined: boolean; bank_rerequest_logged: boolean; daily_close_item: string | null } {
  const ok = controlTotalsOk(f.credit_lines, f.summary_credits, f.debit_lines, f.summary_debits);
  return { ok, exception: ok ? null : "control_total_mismatch", quarantined: !ok, bank_rerequest_logged: !ok, daily_close_item: ok ? null : `statement ${f.file_id} quarantined: 49-record totals ≠ Σ 16 records` };
}
export interface Section3Item { readonly id: string; readonly category: string; readonly amount_cents: Cents; readonly loan_id: string | null; readonly root_cause: string | null; readonly first_seen_on: PlainDate; readonly evidence_refs: readonly string[]; }
/** 6.3-T11: the `qc-audit` reviewer requires loan / root cause / aging / evidence on every Section III item; otherwise `rework`, never `approved`. */
export function reviewerRun(items: readonly Section3Item[], f: { difference_cents: Cents; preparer_run_id: string; posting_run_ids: readonly string[] }): { status: "approved" | "rework"; findings: string[] } {
  const findings: string[] = [];
  for (const it of items) {
    if (!it.loan_id && it.category !== "bank_fee" && it.category !== "interest_credit") findings.push(`${it.id}: no loan number`);
    if (!it.root_cause) findings.push(`${it.id}: no root cause`);
    if (!it.evidence_refs.length) findings.push(`${it.id}: no evidence`);
  }
  if (f.difference_cents !== 0n) findings.push("difference ≠ 0");
  if (f.posting_run_ids.includes(f.preparer_run_id)) findings.push("segregation: preparer run also posted payments");
  return { status: findings.length ? "rework" : "approved", findings };
}
/** 6.3-T12: with `custodial.form496.human_approval = on`, no officer action within 3 servicer BD after review → reminder; the 45-day timer is untouched. */
export function approvalReminder(f: { human_approval_on: boolean; reviewed_on: PlainDate; officer_action_on: PlainDate | null; today: PlainDate }): { reminder: boolean; reminder_due_on: PlainDate | null; form_timer_affected: false; form_timer_satisfied_by: "custodial.reconciliation.completed" } {
  const dueOn = addBusinessDays(f.reviewed_on, 3, servicer);
  const reminder = f.human_approval_on && f.officer_action_on === null && f.today > dueOn;
  return { reminder, reminder_due_on: f.human_approval_on ? dueOn : null, form_timer_affected: false, form_timer_satisfied_by: "custodial.reconciliation.completed" };
}
/** 6.3-T13 / edge "Retro-corrections": a reversal after the period's form is completed never alters it; the next month's Section III carries the item with aging from the original date. */
export function retroCorrection(f: { completed_period_end: PlainDate; original_receipt_on: PlainDate; reversal_posted_on: PlainDate; amount_cents: Cents; completed_form_version: number }): { completed_form_version: number; completed_form_changed: false; carried_in_period: string; item: Section3Item & { aging_days: number } } {
  const { y, m } = { y: Number(f.reversal_posted_on.slice(0, 4)), m: Number(f.reversal_posted_on.slice(5, 7)) };
  return { completed_form_version: f.completed_form_version, completed_form_changed: false, carried_in_period: `${y}-${String(m).padStart(2, "0")}`, item: { id: `retro-${f.original_receipt_on}`, category: "returned_item", amount_cents: -f.amount_cents, loan_id: null, root_cause: `payment reversal posted ${f.reversal_posted_on} for a ${f.original_receipt_on} receipt (post-completion)`, first_seen_on: f.original_receipt_on, evidence_refs: [], aging_days: daysBetween(f.original_receipt_on, f.reversal_posted_on) } };
}
/** 6.3-T14 / edge "A/A auto-draft go-live (LL-2026-05)": line 1 logic switches and the Form 472 shortage/surplus timers are not started for A/A. */
export function aaLine1Logic(f: { autodraft_on: boolean }): { line1_basis: "collected_not_remitted" | "events_processed_draft_pending_2bd"; form472_timers_started: boolean; settle_up_category: "fnma_settle_up" | null } {
  return f.autodraft_on ? { line1_basis: "events_processed_draft_pending_2bd", form472_timers_started: false, settle_up_category: "fnma_settle_up" } : { line1_basis: "collected_not_remitted", form472_timers_started: true, settle_up_category: null };
}

// ---- 6.4 -------------------------------------------------------------------
/** 6.4-T7 / edge "Vendor outage on positive pay": a paid check with no issued record is a critical exception, `fraud` case and a bank claim within 1 BD. */
export function paidNotIssued(f: { paid: readonly { check_number: string; amount_cents: Cents; paid_on: PlainDate }[]; issued: readonly { check_number: string; amount_cents: Cents }[] }): { exceptions: { check_number: string; amount_cents: Cents; severity: "critical"; fraud_case: true; bank_claim_by: PlainDate }[] } {
  const exceptions = f.paid.filter((p) => !f.issued.some((i) => i.check_number === p.check_number && i.amount_cents === p.amount_cents)).map((p) => ({ check_number: p.check_number, amount_cents: p.amount_cents, severity: "critical" as const, fraud_case: true as const, bank_claim_by: addBusinessDays(p.paid_on, 1, servicer) }));
  return { exceptions };
}
/** 6.4 rule 4 / worked example: the attestation's per-category ending balances, loan count and Σ contractual escrow payments must equal the platform's snapshot; aged loss drafts (≥ 7 months) need a Section III explanation. */
export function attestationTieOut(f: { snapshot: { ti_ending_cents: Cents; loan_count: number; contractual_escrow_sum_cents: Cents; loss_draft_cents: Cents; loss_draft_loans: number }; attestation: { ti_ending_cents: Cents; loan_count: number; contractual_escrow_sum_cents: Cents; loss_draft_cents: Cents; loss_draft_loans: number }; loss_drafts: readonly { loan_id: string; received_on: PlainDate; explanation: string | null }[]; as_of: PlainDate }): { ties: boolean; variances: string[]; aged_loss_drafts: { loan_id: string; months: number; explanation_required: true; explanation: string | null }[]; answer: "Yes" | "No" } {
  const variances: string[] = [];
  for (const k of ["ti_ending_cents", "loan_count", "contractual_escrow_sum_cents", "loss_draft_cents", "loss_draft_loans"] as const) if (f.snapshot[k] !== f.attestation[k]) variances.push(k);
  const aged = f.loss_drafts.map((l) => ({ loan_id: l.loan_id, months: lossDraftAgedMonths(l.received_on, f.as_of), explanation: l.explanation })).filter((l) => l.months >= 7).map((l) => ({ ...l, explanation_required: true as const }));
  return { ties: variances.length === 0, variances, aged_loss_drafts: aged, answer: variances.length === 0 ? "Yes" : "No" };
}

// ---- 6.5 -------------------------------------------------------------------
export interface PartialReceipt { readonly on: PlainDate; readonly amount_cents: Cents; readonly rail: "ach_credit" | "check"; readonly originating_account_last4?: string; }
/** 6.5 rule 3 / T1: partials held under C-1.1-02 apply as one periodic payment when Σ ≥ P, `credited_as_of` the completing receipt's date (Reg Z (c)(1)(ii)(B)); the statement shows each held amount until then. */
export function partialAccumulation(f: { periodic_payment_cents: Cents; receipts: readonly PartialReceipt[]; conditions_met: boolean }): { applied: boolean; credited_as_of: PlainDate | null; suspense_cents: Cents; partial_commitment_due_on: PlainDate | null; statement_lines: { on: PlainDate; held_cents: Cents }[]; timer_satisfied: "FNMA_C1102_PARTIAL_BALANCE_30" | null; satisfied_by: "suspense.accumulation.sufficient" | null; notices: string[] } {
  if (!f.receipts.length) throw new RangeError("receipts required");
  if (!f.conditions_met) return { applied: false, credited_as_of: null, suspense_cents: 0n, partial_commitment_due_on: null, statement_lines: [], timer_satisfied: null, satisfied_by: null, notices: ["SUSP-PARTIAL-CONTACT-v1"] };
  const sorted = [...f.receipts].sort((a, b) => a.on.localeCompare(b.on));
  let sum = 0n; const lines: { on: PlainDate; held_cents: Cents }[] = []; let credited: PlainDate | null = null;
  for (const r of sorted) { sum += r.amount_cents; if (credited === null && sum >= f.periodic_payment_cents) { credited = r.on; lines.push({ on: r.on, held_cents: sum - f.periodic_payment_cents }); } else lines.push({ on: r.on, held_cents: credited ? sum - f.periodic_payment_cents : sum }); }
  const applied = credited !== null;
  return { applied, credited_as_of: credited, suspense_cents: applied ? sum - f.periodic_payment_cents : sum, partial_commitment_due_on: addDays(sorted[0]!.on, 30), statement_lines: lines, timer_satisfied: applied ? "FNMA_C1102_PARTIAL_BALANCE_30" : null, satisfied_by: applied ? "suspense.accumulation.sufficient" : null, notices: applied ? ["SUSP-PARTIAL-HELD-v1", "SUSP-PARTIAL-APPLIED-v1"] : ["SUSP-PARTIAL-HELD-v1"] };
}
/** 6.5 rule 3 / T2: nothing by day 30 → the partial returns by the original rail to the originating account with `SUSP-PARTIAL-RETURN-v1`. */
export function partialReturnSweep(f: { received_on: PlainDate; amount_cents: Cents; rail: "ach_credit" | "check"; originating_account_last4?: string; held_cents: Cents; periodic_payment_cents: Cents; today: PlainDate; active_lossmit_case: boolean }): { due_on: PlainDate; returned: boolean; returned_on: PlainDate | null; rail: "ach_credit" | "check" | null; destination: string | null; notice: "SUSP-PARTIAL-RETURN-v1" | null; status: "returned" | "open" | "lossmit_hold" } {
  const due = addDays(f.received_on, 30);
  if (f.active_lossmit_case) return { due_on: due, returned: false, returned_on: null, rail: null, destination: null, notice: null, status: "lossmit_hold" };
  if (f.today > due && f.held_cents < f.periodic_payment_cents) return { due_on: due, returned: true, returned_on: f.today, rail: f.rail, destination: f.rail === "ach_credit" ? `originating account …${f.originating_account_last4 ?? "????"}` : "remitter address on the check image", notice: "SUSP-PARTIAL-RETURN-v1", status: "returned" };
  return { due_on: due, returned: false, returned_on: null, rail: null, destination: null, notice: null, status: "open" };
}
/** C-1.1-02 $50 rule (6.5 rule 3 / T3): deficiency ≤ $50, instrument dated ≥ March 1999 and fewer than 3 such applications in 12 months → apply and reduce escrow by the deficiency. */
export function fiftyDollarRule(f: { amount_cents: Cents; periodic_payment_cents: Cents; instrument_date: PlainDate; partial_count_12m: number; received_on: PlainDate }): { applies: boolean; deficiency_cents: Cents; escrow_reduction_cents: Cents; credited_as_of: PlainDate | null; partial_count_12m_after: number; treatment: "fifty_dollar_rule" | "ordinary_partial" } {
  const deficiency = f.periodic_payment_cents - f.amount_cents;
  const applies = deficiency > 0n && deficiency <= 5_000n && f.instrument_date >= ("1999-03-01" as PlainDate) && f.partial_count_12m < 3;
  return { applies, deficiency_cents: deficiency, escrow_reduction_cents: applies ? deficiency : 0n, credited_as_of: applies ? f.received_on : null, partial_count_12m_after: applies ? f.partial_count_12m + 1 : f.partial_count_12m, treatment: applies ? "fifty_dollar_rule" : "ordinary_partial" };
}
/** Reg Z §1026.36(c)(1)(ii)(B) (6.5-T6): when Σ unapplied reaches P the payment is credited as of the accumulation date even if the job runs later; the 1-BD timer is satisfied by `payment.applied{credited_as_of=accumulation}`. */
export function applyOnAccumulation(f: { accumulated_on: PlainDate; job_run_on: PlainDate; periodic_payment_cents: Cents; held_cents: Cents }): { apply: boolean; credited_as_of: PlainDate | null; due_on: PlainDate; on_time: boolean; timer: "REGZ_1026_36C_APPLY_ON_ACCUMULATION_1BD"; satisfied_by: string | null } {
  const due = addBusinessDays(f.accumulated_on, 1, servicer);
  const apply = f.held_cents >= f.periodic_payment_cents;
  return { apply, credited_as_of: apply ? f.accumulated_on : null, due_on: due, on_time: apply && f.job_run_on <= due, timer: "REGZ_1026_36C_APPLY_ON_ACCUMULATION_1BD", satisfied_by: apply ? `payment.applied{credited_as_of=${f.accumulated_on}}` : null };
}
/** 6.5-T8 / SM_SUSPENSE_AGE_90_ESCALATE: a non-terminal item aged 90 days → `officer` high and a partner aging-report line. */
export function suspenseAging(f: { item_id: string; loan_id: string | null; amount_cents: Cents; status: string; received_on: PlainDate; today: PlainDate }): { aging_days: number; terminal: boolean; escalation: { role: "officer"; severity: "high" } | null; partner_report_line: string | null } {
  const terminal = ["applied", "returned", "refunded", "escheated", "transferred", "applied_to_oldest"].includes(f.status);
  const aging = Math.floor(agingDays(f.received_on, f.today));
  const esc = !terminal && aging >= 90;
  return { aging_days: aging, terminal, escalation: esc ? { role: "officer", severity: "high" } : null, partner_report_line: esc ? `${f.item_id} | loan ${f.loan_id ?? "—"} | ${f.status} | ${aging} days | ${f.amount_cents} cents` : null };
}
/** 6.5 guardrails (baseline §8(6)): AI outreach discloses automation; a request for a person is a warm transfer to `human_agent`, recorded on the contact. */
export function aiOutreachContact(f: { utterance: string; at: string; disclosure_given: boolean }): { mode: "ai_voice"; disclosure_given: boolean; human_transfer_requested: boolean; transfer_to: "human_agent" | null; transfer_time: string | null } {
  const u = handleUtterance(f.utterance);
  return { mode: "ai_voice", disclosure_given: f.disclosure_given, human_transfer_requested: u.human_transfer_requested, transfer_to: u.human_transfer_requested ? "human_agent" : null, transfer_time: u.human_transfer_requested ? f.at : null };
}
export const at = (d: PlainDate, hhmm: string): number => zonedEpochMs(d, hhmm, ET);
