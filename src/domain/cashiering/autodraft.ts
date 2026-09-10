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
  /** 2.3-T8: enrollments from a channel whose unauthorized return rate breached the Nacha threshold are held for review — no file includes them until released. */
  held_for_review?: { reason: "return_rate_review"; since: PlainDate; channel: SecCode } | null;
  authorized_on?: PlainDate;
}

/** 2.3 guardrail "cannot originate a debit without an `active` enrollment [and] a passed validation gate" (NACHA_WEB_ACCOUNT_VALIDATION_GATE). */
export function canOriginateDebit(e: Enrollment): { ok: true } | { ok: false; reason: string; gate: "ENROLLMENT_ACTIVE" | "NACHA_WEB_ACCOUNT_VALIDATION_GATE" | "RETURN_RATE_REVIEW" } {
  if (e.status !== "active") return { ok: false, reason: `enrollment is ${e.status}, not active`, gate: "ENROLLMENT_ACTIVE" };
  if (e.validation_status !== "validated") return { ok: false, reason: `validation_status is ${e.validation_status}; WEB/TEL debits need validated_* (Nacha WEB debit rule)`, gate: "NACHA_WEB_ACCOUNT_VALIDATION_GATE" };
  if (e.held_for_review) return { ok: false, reason: `enrollment held for review since ${e.held_for_review.since} (${e.held_for_review.reason})`, gate: "RETURN_RATE_REVIEW" };
  return { ok: true };
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
export const UNAUTHORIZED_RETURN_CODES: readonly ReturnCode[] = ["R05", "R07", "R10", "R11", "R29"];   // Nacha: R11 counts toward the unauthorized return rate
export const ADMINISTRATIVE_RETURN_CODES: readonly ReturnCode[] = ["R02", "R03", "R04"];
export interface ReturnDisposition {
  readonly reverse_payment: boolean; readonly assess_nsf_fee: boolean; readonly notice: string | null; readonly retry_on: PlainDate | null;
  readonly enrollment_action: "none" | "suspended_returns" | "terminated" | "revoked" | "paused" | "correct_and_reinitiate"; readonly open_fraud_case: boolean; readonly refused?: string;
  /** "RETRY PYMT" on reinitiations (Nacha network-quality rule); null when nothing is reinitiated. */
  readonly company_entry_description: "RETRY PYMT" | null;
  /** R11 only: the corrected entry may be transmitted without re-authorization through this date — 60 calendar days from the Settlement Date of the Return Entry. */
  readonly correction_window_ends_on?: PlainDate;
}

/** R11 window (Nacha "Differentiating Unauthorized Return Reasons"): 60 calendar days from the Settlement Date of the Return Entry — anchored on the return, never on the original entry. */
export function r11CorrectionWindowEnd(returnSettlementDate: PlainDate): PlainDate { return addDays(returnSettlementDate, 60); }

/**
 * 2.3 rule 7 — return handling. `retryOn` supplies the reinitiation date (3–5 banking days later). For R11, `corrected_on` is the
 * date the corrected entry is (or will be) transmitted; it defaults to the retry date and must fall within 60 days of the return.
 */
export function handleReturn(e: Enrollment, code: ReturnCode, returnedOn: PlainDate, opts: { authorization_valid: boolean; defect_ours?: boolean; original_entry_on?: PlainDate; corrected_on?: PlainDate; retryOn: (from: PlainDate) => PlainDate }): ReturnDisposition {
  const within180 = e.reinitiations.filter((d) => daysBetween(d, returnedOn) <= 180).length;
  switch (code) {
    case "R01": case "R09": {
      e.returns_on_current_installment += 1;
      if (e.returns_on_current_installment >= 2) return { reverse_payment: true, assess_nsf_fee: true, notice: "AUTODRAFT-RETURN-v1", retry_on: null, enrollment_action: "suspended_returns", open_fraud_case: false, company_entry_description: null };
      if (within180 >= 2) return { reverse_payment: true, assess_nsf_fee: true, notice: "AUTODRAFT-RETURN-v1", retry_on: null, enrollment_action: "none", open_fraud_case: false, refused: "at most two reinitiations within 180 days (Nacha)", company_entry_description: null };
      const retry = opts.retryOn(returnedOn); e.reinitiations.push(retry);
      return { reverse_payment: true, assess_nsf_fee: true, notice: "AUTODRAFT-RETURN-v1", retry_on: retry, enrollment_action: "none", open_fraud_case: false, company_entry_description: "RETRY PYMT" };
    }
    case "R02": case "R03": case "R04": case "R20":
      return { reverse_payment: true, assess_nsf_fee: false, notice: "AUTODRAFT-SUSPENDED-v1", retry_on: null, enrollment_action: "terminated", open_fraud_case: false, company_entry_description: null };
    case "R05": case "R07": case "R10": case "R29":
      return { reverse_payment: true, assess_nsf_fee: false, notice: "AUTODRAFT-REVOKED-v1", retry_on: null, enrollment_action: "revoked", open_fraud_case: opts.authorization_valid, company_entry_description: null };
    case "R11": {
      const windowEnd = r11CorrectionWindowEnd(returnedOn);
      const correctedOn = opts.corrected_on ?? opts.retryOn(returnedOn);
      const ok = opts.defect_ours === true && correctedOn <= windowEnd;
      return ok ? { reverse_payment: true, assess_nsf_fee: false, notice: null, retry_on: correctedOn, enrollment_action: "correct_and_reinitiate", open_fraud_case: false, company_entry_description: "RETRY PYMT", correction_window_ends_on: windowEnd }
                : { reverse_payment: true, assess_nsf_fee: false, notice: "AUTODRAFT-REVOKED-v1", retry_on: null, enrollment_action: "revoked", open_fraud_case: false, company_entry_description: null, correction_window_ends_on: windowEnd,
                    refused: opts.defect_ours ? `R11 correction window is 60 days from the return settlement date ${returnedOn} (closed ${windowEnd}); new authorization required` : "defect not ours → treated as revoked" };
    }
    case "R08": return { reverse_payment: true, assess_nsf_fee: false, notice: "AUTODRAFT-SUSPENDED-v1", retry_on: null, enrollment_action: "paused", open_fraud_case: false, company_entry_description: null };
    case "R16": case "R17": return { reverse_payment: true, assess_nsf_fee: false, notice: null, retry_on: null, enrollment_action: "terminated", open_fraud_case: true, company_entry_description: null };
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

/** Nacha Network Risk thresholds (basis points): unauthorized 0.5%, administrative 3.0%, overall 15.0% — 60-day look-back. */
export const RETURN_RATE_THRESHOLDS_BPS = { unauthorized: 50, administrative: 300, overall: 1500 } as const;
export interface ReturnRateStats { readonly channel: SecCode; readonly debits: number; readonly unauthorized_returns: number; readonly administrative_returns: number; readonly total_returns: number; }
export interface ReturnRateReport {
  readonly period_end: PlainDate; readonly lookback_days: 60;
  readonly channels: readonly { channel: SecCode; debits: number; unauthorized_bps: number; administrative_bps: number; overall_bps: number; breaches: ("unauthorized" | "administrative" | "overall")[] }[];
  readonly breached_channels: readonly SecCode[];
}
const bps = (n: number, d: number): number => (d > 0 ? Math.round((n / d) * 10_000) : 0);
/** 2.3 `NACHA_RETURN_RATE_MONTHLY_WATCH`: the monthly report over a 60-day look-back per channel, with the thresholds each channel breaches. */
export function returnRateReport(stats: readonly ReturnRateStats[], periodEnd: PlainDate): ReturnRateReport {
  const channels = stats.map((s) => {
    const unauthorized_bps = bps(s.unauthorized_returns, s.debits), administrative_bps = bps(s.administrative_returns, s.debits), overall_bps = bps(s.total_returns, s.debits);
    const breaches: ("unauthorized" | "administrative" | "overall")[] = [];
    if (unauthorized_bps > RETURN_RATE_THRESHOLDS_BPS.unauthorized) breaches.push("unauthorized");
    if (administrative_bps > RETURN_RATE_THRESHOLDS_BPS.administrative) breaches.push("administrative");
    if (overall_bps > RETURN_RATE_THRESHOLDS_BPS.overall) breaches.push("overall");
    return { channel: s.channel, debits: s.debits, unauthorized_bps, administrative_bps, overall_bps, breaches };
  });
  return { period_end: periodEnd, lookback_days: 60, channels, breached_channels: channels.filter((c) => c.breaches.length > 0).map((c) => c.channel) };
}
/** 2.3-T8: enrollments from a breaching channel are held for review (no file includes them) until the officer releases them. */
export function holdChannelForReview(enrollments: readonly Enrollment[], channel: SecCode, since: PlainDate): Enrollment[] {
  const held: Enrollment[] = [];
  for (const e of enrollments) if (e.authorization.sec === channel && (e.status === "active" || e.status === "authorized" || e.status === "validating") && !e.held_for_review) { e.held_for_review = { reason: "return_rate_review", since, channel }; held.push(e); }
  return held;
}
export function releaseFromReview(e: Enrollment): Enrollment { e.held_for_review = null; return e; }

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
  return enrollments.filter((e) => e.status === "active" && !e.held_for_review && !(e.terminated_on && e.terminated_on <= buildOn)).map((e) => e.loan_id);
}
