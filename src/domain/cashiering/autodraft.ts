/**
 * §2.3 Automatic draft (ACH) setup — enrollment state machine, Nacha/Reg E
 * authorization checklist, draft-day validator (C-1.1-03), amount rule,
 * the Reg E 10-day variable-amount notice check, revocation, and return
 * handling (R01 retry limits, unauthorized codes, R11 60-day correction).
 */
import { randomUUID } from "node:crypto";
import { Machine } from "../../kernel/fsm/machine.ts";
import { type PlainDate, addDays, daysBetween, parts, ymd, daysInMonth } from "../../kernel/calendar/date.ts";
import { rollBack, rollForward, type Calendar } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";

export type EnrollmentStatus = "requested" | "authorized" | "validating" | "active" | "paused" | "suspended_returns" | "revoked" | "terminated";
export type SecCode = "WEB" | "TEL" | "PPD";

export const enrollmentMachine = new Machine<EnrollmentStatus, { validated?: boolean; byBorrower?: boolean }>({
  name: "autodraft_enrollment", initial: "requested",
  states: ["requested", "authorized", "validating", "active", "paused", "suspended_returns", "revoked", "terminated"],
  terminal: ["revoked", "terminated"],
  transitions: [
    { from: "requested", to: "authorized", on: "authorize" },
    { from: "authorized", to: "validating", on: "validate" },
    { from: "validating", to: "active", on: "validation_result", guard: (t) => (t.ctx.validated ? undefined : "validation failed") },
    { from: "validating", to: "requested", on: "validation_result", guard: (t) => (t.ctx.validated ? "validated" : undefined) },
    { from: "active", to: "paused", on: "pause" },
    { from: "paused", to: "active", on: "resume" },
    { from: "active", to: "suspended_returns", on: "second_return" },
    { from: "suspended_returns", to: "active", on: "borrower_reconfirms" },
    { from: ["active", "paused", "suspended_returns", "authorized", "validating"], to: "revoked", on: "revoke" },
    { from: ["active", "paused", "suspended_returns", "authorized", "validating", "requested"], to: "terminated", on: "terminate" },
  ],
});

export interface Authorization {
  readonly borrower_name: string; readonly loan_number_masked: string; readonly routing: string; readonly account_last4: string; readonly account_type: "checking" | "savings";
  readonly amount_rule: "full_periodic_payment" | "fixed" | "range"; readonly variable_amount_statement: boolean; readonly frequency: "monthly" | "semimonthly" | "biweekly"; readonly first_debit_on: PlainDate;
  readonly authorized_on: PlainDate; readonly company_name: string; readonly revocation_instructions: boolean; readonly optional_statement: boolean; readonly esign_consent: boolean;
  readonly sec: SecCode; readonly recording_ref?: string; readonly ai_disclosure_logged_at?: string;
}

/** 2.3 rule 1 checklist — every element must be present before an enrollment can be authorized. */
export function authorizationDefects(a: Authorization): string[] {
  const d: string[] = [];
  if (!a.borrower_name) d.push("borrower_name");
  if (!/\*{2,}\d{4}$/.test(a.loan_number_masked)) d.push("loan_number_masked");
  if (!/^\d{9}$/.test(a.routing)) d.push("routing");
  if (!/^\d{4}$/.test(a.account_last4)) d.push("account_last4");
  if (a.amount_rule !== "fixed" && !a.variable_amount_statement) d.push("variable_amount_statement");
  if (a.company_name !== "SUPERMORTGAGE") d.push("company_name");
  if (!a.revocation_instructions) d.push("revocation_instructions");
  if (!a.optional_statement) d.push("optional_statement (Reg E 1005.10(e)(1))");
  if (!a.esign_consent) d.push("esign_consent");
  if (a.sec === "TEL" && !a.recording_ref) d.push("recording_ref");
  if (a.sec === "TEL" && !a.ai_disclosure_logged_at) d.push("ai_disclosure_logged_at");
  return d;
}

export interface Enrollment {
  readonly id: string; readonly loan_id: string; status: EnrollmentStatus; authorization: Authorization; draft_day: number;
  extra_principal_cents: Cents; include_fees: boolean; next_draft_on: PlainDate | null; validation_status: "pending" | "validated" | "failed";
  reinitiations: PlainDate[]; returns_on_current_installment: number; last_debit_cents: Cents | null; notices: { template: string; sent_on: PlainDate; amount_cents: Cents; debit_on: PlainDate }[];
  terminated_on?: PlainDate; termination_reason?: "transfer_out" | "borrower" | "returns" | "payoff";
}

/** 2.3 rule 3: chosen day 1–16 and never later than due + grace (C-1.1-03). */
export function validateDraftDay(day: number, dueDay: number, graceDays: number): { ok: true } | { ok: false; reason: string; latest_day: number } {
  const latest = Math.min(dueDay + graceDays, 28);
  if (!Number.isInteger(day) || day < 1 || day > latest) return { ok: false, reason: `draft day must be between 1 and ${latest} (due ${dueDay} + grace ${graceDays})`, latest_day: latest };
  return { ok: true };
}

/** Settlement date for the month containing `dueDate`: the chosen day, moved to the preceding banking day if the next one would breach the grace gate. */
export function settlementDateFor(dueDate: PlainDate, draftDay: number, graceDays: number, cal: Calendar): PlainDate {
  const { y, m } = parts(dueDate);
  const chosen = ymd(y, m, Math.min(draftDay, daysInMonth(y, m)));
  const gate = addDays(dueDate, graceDays);
  if (cal.isBusinessDay(chosen)) return chosen;
  const fwd = rollForward(chosen, cal);
  return fwd <= gate ? fwd : rollBack(chosen, cal);
}

/** 2.3 rule 4. */
export function draftAmount(e: Enrollment, periodicPaymentCents: Cents, outstandingFeesCents: Cents): Cents {
  return periodicPaymentCents + e.extra_principal_cents + (e.include_fees ? outstandingFeesCents : 0n);
}

/** 2.3 rule 5: a changed amount needs a notice sent ≥ 10 calendar days before the debit; the escrow/ARM notice counts only if it states the exact amount and date. */
export function variableAmountNoticeStatus(e: Enrollment, nextAmount: Cents, debitOn: PlainDate, today: PlainDate): { ok: true; satisfied_by: string } | { ok: false; deadline: PlainDate; action: "send_dedicated_notice" | "hold_entry_escalate" } {
  if (e.last_debit_cents === null || e.last_debit_cents === nextAmount) return { ok: true, satisfied_by: "no_change" };
  const deadline = addDays(debitOn, -10);
  const hit = e.notices.find((n) => n.amount_cents === nextAmount && n.debit_on === debitOn && n.sent_on <= deadline);
  if (hit) return { ok: true, satisfied_by: hit.template };
  return today <= deadline ? { ok: false, deadline, action: "send_dedicated_notice" } : { ok: false, deadline, action: "hold_entry_escalate" };
}

export type ReturnCode = "R01" | "R09" | "R02" | "R03" | "R04" | "R20" | "R05" | "R07" | "R10" | "R29" | "R11" | "R08" | "R16" | "R17";
export interface ReturnDisposition { readonly reverse_payment: boolean; readonly assess_nsf_fee: boolean; readonly notice: string | null; readonly retry_on: PlainDate | null; readonly enrollment_action: "none" | "suspended_returns" | "terminated" | "revoked" | "paused" | "correct_and_reinitiate"; readonly open_fraud_case: boolean; readonly refused?: string; }

/** 2.3 rule 7 — return handling. `bankingDaysLater` supplies the retry date (3–5 banking days). */
export function handleReturn(e: Enrollment, code: ReturnCode, returnedOn: PlainDate, opts: { authorization_valid: boolean; defect_ours?: boolean; original_entry_on?: PlainDate; retryOn: (from: PlainDate) => PlainDate }): ReturnDisposition {
  const within180 = e.reinitiations.filter((d) => daysBetween(d, returnedOn) <= 180).length;
  switch (code) {
    case "R01": case "R09": {
      e.returns_on_current_installment += 1;
      if (e.returns_on_current_installment >= 2) return { reverse_payment: true, assess_nsf_fee: true, notice: "AUTODRAFT-RETURN-v1", retry_on: null, enrollment_action: "suspended_returns", open_fraud_case: false };
      if (within180 >= 2) return { reverse_payment: true, assess_nsf_fee: true, notice: "AUTODRAFT-RETURN-v1", retry_on: null, enrollment_action: "none", open_fraud_case: false, refused: "at most two reinitiations within 180 days (Nacha)" };
      const retry = opts.retryOn(returnedOn); e.reinitiations.push(retry);
      return { reverse_payment: true, assess_nsf_fee: true, notice: "AUTODRAFT-RETURN-v1", retry_on: retry, enrollment_action: "none", open_fraud_case: false };
    }
    case "R02": case "R03": case "R04": case "R20":
      return { reverse_payment: true, assess_nsf_fee: false, notice: "AUTODRAFT-ACCOUNT-v1", retry_on: null, enrollment_action: "terminated", open_fraud_case: false };
    case "R05": case "R07": case "R10": case "R29":
      return { reverse_payment: true, assess_nsf_fee: false, notice: "AUTODRAFT-CANCELLED-v1", retry_on: null, enrollment_action: "revoked", open_fraud_case: opts.authorization_valid };
    case "R11": {
      const ok = opts.defect_ours && opts.original_entry_on && daysBetween(opts.original_entry_on, returnedOn) <= 60;
      return ok ? { reverse_payment: true, assess_nsf_fee: false, notice: null, retry_on: opts.retryOn(returnedOn), enrollment_action: "correct_and_reinitiate", open_fraud_case: false }
                : { reverse_payment: true, assess_nsf_fee: false, notice: "AUTODRAFT-CANCELLED-v1", retry_on: null, enrollment_action: "revoked", open_fraud_case: false, refused: opts.defect_ours ? "R11 correction window is 60 days" : "defect not ours → treated as revoked" };
    }
    case "R08": return { reverse_payment: true, assess_nsf_fee: false, notice: "AUTODRAFT-STOP-v1", retry_on: null, enrollment_action: "paused", open_fraud_case: false };
    case "R16": case "R17": return { reverse_payment: true, assess_nsf_fee: false, notice: null, retry_on: null, enrollment_action: "terminated", open_fraud_case: true };
  }
}

/** 2.3 rule 6: a revocation stops any unsent file; a debit that settles after a timely revocation is refunded same day with an officer notice. */
export function revocationEffect(revokedOn: PlainDate, fileTransmittedOn: PlainDate | null, settlesOn: PlainDate): { stop_entry: boolean; refund_same_day: boolean; officer_notice: boolean } {
  const transmitted = fileTransmittedOn !== null && fileTransmittedOn <= revokedOn;
  if (!transmitted) return { stop_entry: true, refund_same_day: false, officer_notice: false };
  return { stop_entry: false, refund_same_day: settlesOn >= revokedOn, officer_notice: true };
}

/** Nacha network-quality threshold watch (2.3-T8): unauthorized return rate ≥ 0.5% is the administrative threshold. */
export function unauthorizedReturnRateAlert(unauthorizedReturns: number, debits: number): boolean { return debits > 0 && unauthorizedReturns / debits >= 0.005; }

export function newEnrollment(loanId: string, a: Authorization, draftDay: number, extra: Cents = 0n): Enrollment {
  return { id: randomUUID(), loan_id: loanId, status: "requested", authorization: a, draft_day: draftDay, extra_principal_cents: extra, include_fees: false, next_draft_on: null, validation_status: "pending", reinitiations: [], returns_on_current_installment: 0, last_debit_cents: null, notices: [] };
}

/** 2.3-T10: on a voice/chat enrollment the AI disclosure must be logged before any account data is requested; the recording and the written confirmation are linked to the consent. */
export interface TranscriptEvent { readonly at: string; readonly kind: "ai_disclosure" | "human_offered" | "account_data_requested" | "authorization_read" | "consent_given" | "other"; readonly text?: string; }
export function voiceEnrollmentEvidence(transcript: readonly TranscriptEvent[], links: { recording_id: string | null; written_confirmation_id: string | null }): { ok: boolean; disclosure_before_account_data: boolean; problems: string[]; consent_links: { recording_id: string | null; written_confirmation_id: string | null } } {
  const sorted = [...transcript].sort((a, b) => (a.at < b.at ? -1 : 1));
  const firstDisclosure = sorted.findIndex((e) => e.kind === "ai_disclosure");
  const firstAccount = sorted.findIndex((e) => e.kind === "account_data_requested");
  const before = firstDisclosure >= 0 && (firstAccount < 0 || firstDisclosure < firstAccount);
  const problems: string[] = [];
  if (!before) problems.push("AI disclosure must be logged before any account data is requested");
  if (!sorted.some((e) => e.kind === "human_offered")) problems.push("a human must be offered at the start of every voice/chat enrollment");
  if (!links.recording_id) problems.push("recording not linked to the consent");
  if (!links.written_confirmation_id) problems.push("written confirmation not linked to the consent");
  return { ok: problems.length === 0, disclosure_before_account_data: before, problems, consent_links: links };
}

/** 2.3-T11: a transfer-out cutover terminates the enrollment; no file built after the cutover may contain the loan. */
export function terminateOnTransferOut(e: Enrollment, cutoverOn: PlainDate): Enrollment { e.status = "terminated"; e.next_draft_on = null; e.terminated_on = cutoverOn; e.termination_reason = "transfer_out"; return e; }
export function fileLoans(enrollments: readonly Enrollment[], buildOn: PlainDate): string[] {
  return enrollments.filter((e) => e.status === "active" && !(e.terminated_on && e.terminated_on <= buildOn)).map((e) => e.loan_id);
}
