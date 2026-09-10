/** §6.5 Unidentified/unapplied funds — identification scoring, deadlines, escheat. */
import type { Cents } from "../../kernel/money/cents.ts";
import { type PlainDate, addDays, addYears, ymd, parts } from "../../kernel/calendar/date.ts";
import { addBusinessDays, federal, servicer } from "../../kernel/calendar/business.ts";

/** Jaro-Winkler similarity (0..1). */
export function jaroWinkler(a: string, b: string): number {
  a = a.toLowerCase(); b = b.toLowerCase();
  if (a === b) return 1; if (!a.length || !b.length) return 0;
  const win = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array(a.length).fill(false), bm = new Array(b.length).fill(false); let m = 0;
  for (let i = 0; i < a.length; i++) for (let j = Math.max(0, i - win); j < Math.min(b.length, i + win + 1); j++) if (!bm[j] && a[i] === b[j]) { am[i] = bm[j] = true; m++; break; }
  if (!m) return 0;
  let t = 0, k = 0; for (let i = 0; i < a.length; i++) if (am[i]) { while (!bm[k]) k++; if (a[i] !== b[k]) t++; k++; }
  const jaro = (m / a.length + m / b.length + (m - t / 2) / m) / 3;
  let l = 0; while (l < 4 && l < a.length && l < b.length && a[l] === b[l]) l++;
  return jaro + l * 0.1 * (1 - jaro);
}

export interface CandidateLoan { readonly loan_id: string; readonly loan_number?: string; readonly borrower_names: readonly string[]; readonly ach_last4?: string; readonly periodic_payment_cents: Cents; readonly total_due_cents?: Cents; readonly property_address?: string; }
export interface Receipt { readonly amount_cents: Cents; readonly memo?: string; readonly payer_name?: string; readonly ach_last4?: string; readonly scanline_loan_number?: string; }

/** 6.5 rule 1 weighted score; auto-apply at ≥ 0.97 with no conflicting candidate ≥ 0.80. */
export function scoreCandidate(r: Receipt, c: CandidateLoan): number {
  let s = 0;
  if (r.scanline_loan_number && c.loan_number && r.scanline_loan_number === c.loan_number) s += 0.6;
  else if (r.memo && c.loan_number && r.memo.includes(c.loan_number)) s += 0.5;
  if (r.ach_last4 && c.ach_last4 && r.ach_last4 === c.ach_last4) s += 0.5;      // MICR/ACH account history is the strongest non-scanline signal
  const nameScore = r.payer_name ? Math.max(...c.borrower_names.map((n) => jaroWinkler(r.payer_name!, n))) : 0;
  if (nameScore >= 0.92) s += 0.3; else if (nameScore >= 0.7) s += 0.2;
  if (r.amount_cents === c.periodic_payment_cents || (c.total_due_cents !== undefined && r.amount_cents === c.total_due_cents)) s += 0.3;
  if (r.memo && c.property_address && r.memo.toLowerCase().includes(c.property_address.toLowerCase())) s += 0.2;
  return Math.min(1, Math.round(s * 100) / 100);
}
export function identify(r: Receipt, cands: readonly CandidateLoan[]): { decision: "auto_apply" | "contact_pending" | "researching"; loan_id: string | null; scores: { loan_id: string; score: number }[] } {
  const scores = cands.map((c) => ({ loan_id: c.loan_id, score: scoreCandidate(r, c) })).sort((a, b) => b.score - a.score);
  const top = scores[0], second = scores[1];
  if (top && top.score >= 0.97 && (!second || second.score < 0.8)) return { decision: "auto_apply", loan_id: top.loan_id, scores };
  if (top && top.score >= 0.6) return { decision: "contact_pending", loan_id: null, scores };
  return { decision: "researching", loan_id: null, scores };
}

export const RESEARCH_DAYS = 30, RETURN_DAYS = 60, WRITE_OFF_LIMIT_CENTS = 500n;
export function researchDeadlines(receivedOn: PlainDate): { research_by: PlainDate; return_by: PlainDate } { return { research_by: addDays(receivedOn, RESEARCH_DAYS), return_by: addDays(receivedOn, RETURN_DAYS) }; }
/** 6.5 rule 5: overpayment refund 10 servicer BD (policy); post-payoff escrow refund 20 federal BD (§1024.34(b)). */
export function refundDeadlines(on: PlainDate): { overpayment_by: PlainDate; escrow_after_payoff_by: PlainDate } { return { overpayment_by: addBusinessDays(on, 10, servicer), escrow_after_payoff_by: addBusinessDays(on, 20, federal) }; }
export function writeOffAllowed(amountCents: Cents, officer: boolean): boolean { return amountCents <= WRITE_OFF_LIMIT_CENTS || officer; }

export const DORMANCY_YEARS: Record<string, number> = { TX: 3, CA: 3, NY: 3, FL: 5, IL: 3, PA: 3, OH: 3, NJ: 3, GA: 5, DEFAULT: 3 };   // [UNVERIFIED per state]
/** 6.5 rule 7 escheat computation (default July 1–June 30 cycle, report due Nov 1). */
export function escheat(dormancyStart: PlainDate, state: string): { presumed_abandoned_on: PlainDate; cycle: string; report_due_on: PlainDate; due_diligence_window: [PlainDate, PlainDate]; officer_verification_on: PlainDate } {
  const years = DORMANCY_YEARS[state] ?? DORMANCY_YEARS.DEFAULT!;
  const pa = addYears(dormancyStart, years);
  const { y, m } = parts(pa);
  const cycleEndYear = m >= 7 ? y + 1 : y;                  // cycle Jul 1 (Y−1) – Jun 30 Y
  const report_due_on = ymd(cycleEndYear, 11, 1);
  return { presumed_abandoned_on: pa, cycle: `FY${cycleEndYear}`, report_due_on, due_diligence_window: [addDays(report_due_on, -180), addDays(report_due_on, -60)], officer_verification_on: addDays(report_due_on, -47) };
}
export function agingDays(receivedOn: PlainDate, today: PlainDate): number { return Math.max(0, (Date.parse(today) - Date.parse(receivedOn)) / 86_400_000); }

/** 6.5 state machine terminal statuses (`applied_to_oldest` is 2.5's biweekly outcome carried on the same register). */
export const SUSPENSE_TERMINAL_STATUSES: readonly string[] = ["applied", "returned", "refunded", "escheated", "transferred", "written_off", "applied_to_oldest"];
export const isSuspenseTerminal = (status: string): boolean => SUSPENSE_TERMINAL_STATUSES.includes(status);
/**
 * 6.5 state machine / guardrail / T10: `written_off` only by `officer`; ≤ $5.00 rounding items pass, above the
 * limit the officer must override with a reason ("rejected (limit $5.00) unless `officer` overrides with reason").
 */
export function suspenseWriteOff(f: { amount_cents: Cents; actor_is_officer: boolean; override_reason: string }): { allowed: boolean; refusal: string | null; limit_cents: Cents; officer_override: boolean } {
  const abs = f.amount_cents < 0n ? -f.amount_cents : f.amount_cents;
  if (!f.actor_is_officer) return { allowed: false, refusal: `written_off is an officer act (limit $5.00; ${abs} cents requested)`, limit_cents: WRITE_OFF_LIMIT_CENTS, officer_override: false };
  if (abs <= WRITE_OFF_LIMIT_CENTS) return { allowed: true, refusal: null, limit_cents: WRITE_OFF_LIMIT_CENTS, officer_override: false };
  if (!f.override_reason.trim()) return { allowed: false, refusal: `write-off of ${abs} cents rejected (limit $5.00) — an officer override needs a reason`, limit_cents: WRITE_OFF_LIMIT_CENTS, officer_override: false };
  return { allowed: true, refusal: null, limit_cents: WRITE_OFF_LIMIT_CENTS, officer_override: true };
}
/**
 * 6.5 rule 4 / T5: an unidentified receipt is researched ≤ 30 days; with a known remitter it is returned by
 * day 60 at the latest (refund check to the address on the image / ACH credit to the originator); with no
 * remitter data it goes `escheat_pending` and the unclaimed-property clock starts at `received_on`.
 */
export function unidentifiedReceiptTrack(f: { received_on: PlainDate; matched_on: PlainDate | null; remitter_known: boolean; rail: "check" | "ach"; today: PlainDate }): { research_by: PlainDate; return_by: PlainDate; status: "researching" | "matched_pending" | "returned" | "escheat_pending"; return_rail: "refund_check_to_remitter_address" | "ach_credit_to_originator" | null; dormancy_start_on: PlainDate | null; unclaimed_property_item: boolean } {
  const d = researchDeadlines(f.received_on);
  if (f.matched_on !== null && f.matched_on <= d.research_by) return { ...d, status: "matched_pending", return_rail: null, dormancy_start_on: null, unclaimed_property_item: false };
  if (f.today <= d.research_by) return { ...d, status: "researching", return_rail: null, dormancy_start_on: null, unclaimed_property_item: false };
  if (f.remitter_known) return { ...d, status: "returned", return_rail: f.rail === "check" ? "refund_check_to_remitter_address" : "ach_credit_to_originator", dormancy_start_on: null, unclaimed_property_item: false };
  return { ...d, status: "escheat_pending", return_rail: null, dormancy_start_on: f.received_on, unclaimed_property_item: true };
}
