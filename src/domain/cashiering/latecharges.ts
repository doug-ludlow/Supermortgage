/**
 * §2.7 Late charge assessment — grace-gate test, overlays in precedence
 * order, no pyramiding by construction, collection only from remainder,
 * waivers (policy limits), reversal on re-dating, and the NSF fee.
 */
import { randomUUID } from "node:crypto";
import { type PlainDate, addDays } from "../../kernel/calendar/date.ts";
import { divRound, Decimal } from "../../kernel/money/decimal.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import type { Actor } from "../../kernel/events/types.ts";
import { type LoanCashState, type Fee, type Overlay, cashCfg } from "./types.ts";

export interface AssessmentInput {
  readonly state: LoanCashState;
  readonly installment_due_date: PlainDate;
  /** Funds credited toward the installment's basis with credited_as_of ≤ grace end. */
  readonly received_toward_basis_cents: Cents;
  readonly run_on: PlainDate;
  /** Receipts dated ≤ grace end that are not yet posted (SM_CASHIERING_POSTING_BACKLOG_GATE). */
  readonly unposted_receipts_on_or_before_grace: number;
}
export type AssessmentResult =
  | { outcome: "deferred_backlog"; grace_end_on: PlainDate }
  | { outcome: "not_assessed"; reason: string; grace_end_on: PlainDate }
  | { outcome: "assessed" | "accrued_suspended"; fee: Fee; grace_end_on: PlainDate };

export function graceEnd(due: PlainDate, graceDays: number): PlainDate { return addDays(due, graceDays); }

export function lateChargeAmount(basisCents: Cents, pct: string, cap: Cents | null): Cents {
  const raw = divRound(basisCents * Decimal.parse(pct).unscaled, 100n * Decimal.ONE.unscaled, "HALF_UP");
  return cap !== null && raw > cap ? cap : raw;
}

function activeOverlay(overlays: readonly Overlay[], kind: Overlay["kind"], due: PlainDate): Overlay | undefined {
  return overlays.find((o) => o.kind === kind && o.from <= due && (o.to == null || o.to >= due));
}

/** 2.7 rule 1 + rule 3 (overlays in precedence order). */
export function assessLateCharge(i: AssessmentInput): AssessmentResult {
  const c = cashCfg(i.state);
  const inst = i.state.installments.find((x) => x.due_date === i.installment_due_date);
  if (!inst) throw new RangeError(`no installment ${i.installment_due_date}`);
  const grace_end_on = graceEnd(inst.due_date, c.grace);
  if (i.run_on <= grace_end_on) return { outcome: "not_assessed", reason: "not_due: before grace end", grace_end_on };
  if (c.fees.some((f) => f.fee_type === "late_charge" && f.installment_due_date === inst.due_date && f.state !== "reversed")) return { outcome: "not_assessed", reason: "already evaluated (once per installment)", grace_end_on };
  if (i.unposted_receipts_on_or_before_grace > 0) return { outcome: "deferred_backlog", grace_end_on };
  const basis = c.basis === "piti" ? inst.pi_cents + inst.escrow_cents : inst.pi_cents;
  if (i.received_toward_basis_cents >= basis) return { outcome: "not_assessed", reason: "paid within grace", grace_end_on };
  const ov = c.overlays;
  if (c.shieldUntil && inst.due_date <= c.shieldUntil || activeOverlay(ov, "transfer_window_60", inst.due_date)) return { outcome: "not_assessed", reason: "transfer_window_60 shield (§1024.33(c)(1))", grace_end_on };
  const fb = ov.find((o) => o.kind === "forbearance_active" && o.from <= inst.due_date);
  if (fb && (fb.to == null || fb.to >= inst.due_date) && (!fb.defaulted_on || inst.due_date < fb.defaulted_on)) return { outcome: "not_assessed", reason: "forbearance_active: no accrual (D2-3.2-01)", grace_end_on };
  if (activeOverlay(ov, "scra_reduced_rate", inst.due_date)) return { outcome: "not_assessed", reason: "scra_reduced_rate", grace_end_on };
  const mk = (state: Fee["state"], suppression?: string): Fee => ({ id: randomUUID(), fee_type: "late_charge", installment_due_date: inst.due_date, amount_cents: lateChargeAmount(basis, c.lcPct, c.lcCap), state, assessed_on: i.run_on, grace_end_on, collected_cents: 0n, ...(suppression ? { suppression } : {}) });
  for (const k of ["bankruptcy_active", "repayment_plan_pending_waiver", "trial_pending_waiver"] as const) if (activeOverlay(ov, k, inst.due_date)) { const fee = mk("accrued_suspended", k); return { outcome: "accrued_suspended", fee, grace_end_on }; }
  if (activeOverlay(ov, "foreclosure_referred", inst.due_date)) return { outcome: "not_assessed", reason: "foreclosure_referred: no new charges after referral (2.7-Q4 default)", grace_end_on };
  if (ov.some((o) => o.kind === "noe_dispute" && o.installment_due_date === inst.due_date && (o.to == null || o.to >= i.run_on))) return { outcome: "not_assessed", reason: "noe_dispute open on this installment", grace_end_on };
  const fee = mk("assessed");
  return { outcome: "assessed", fee, grace_end_on };
}

/** Record the fee on the state (and the receivable). */
export function recordFee(state: LoanCashState, fee: Fee): void {
  state.fees = [...(state.fees ?? []), fee];
  if (fee.state === "assessed") { if (fee.fee_type === "late_charge") state.late_charges_due_cents += fee.amount_cents; else state.nsf_fees_due_cents += fee.amount_cents; }
}

export type WaiverReason = "workout_completion" | "trial_conversion" | "scra" | "error_correction" | "transfer_misdirected" | "fnma_request" | "bankruptcy_plan" | "courtesy";
export type WaiverResult = { ok: true; waived_cents: Cents } | { ok: false; code: "NEEDS_OFFICER" | "NOT_WAIVABLE"; reason: string };

/** 2.7 rule 5: automatic reasons always; one courtesy waiver per loan per 12 months by the agent, more only with `officer`. */
export function waiveLateCharge(state: LoanCashState, feeId: string, reason: WaiverReason, actor: Actor): WaiverResult {
  const fee = (state.fees ?? []).find((f) => f.id === feeId);
  if (!fee || (fee.state !== "assessed" && fee.state !== "accrued_suspended")) return { ok: false, code: "NOT_WAIVABLE", reason: "fee not open" };
  if (reason === "courtesy" && cashCfg(state).courtesy >= 1 && actor.role !== "officer") return { ok: false, code: "NEEDS_OFFICER", reason: "one courtesy waiver per loan per 12 months; further waivers need officer approval" };
  if (fee.state === "assessed") state.late_charges_due_cents -= fee.amount_cents - fee.collected_cents;
  fee.state = "waived"; fee.waived_reason = reason;
  if (reason === "courtesy") state.courtesy_waivers_12m = cashCfg(state).courtesy + 1;
  return { ok: true, waived_cents: fee.amount_cents - fee.collected_cents };
}

/** Waive every open late charge on the loan (trial conversion, workout completion, SCRA). */
export function waiveAll(state: LoanCashState, reason: WaiverReason, actor: Actor): Cents {
  let total = 0n;
  for (const f of state.fees ?? []) if (f.fee_type === "late_charge" && (f.state === "assessed" || f.state === "accrued_suspended")) { const r = waiveLateCharge(state, f.id, reason, actor); if (r.ok) total += r.waived_cents; }
  return total;
}

/** On plan/trial failure suspended charges become collectible (D2-3.2-06). */
export function releaseSuspended(state: LoanCashState, suppression: string): Fee[] {
  const out: Fee[] = [];
  for (const f of state.fees ?? []) if (f.state === "accrued_suspended" && f.suppression === suppression) { f.state = "assessed"; delete f.suppression; state.late_charges_due_cents += f.amount_cents; out.push(f); }
  return out;
}

/** 2.7 rule 6: a payment re-dated to on-time reverses the charge (refund if collected) and 8.1 gets a correction. */
export function reverseOnRedate(state: LoanCashState, installmentDueDate: PlainDate, newCreditedAsOf: PlainDate): { reversed: Fee | null; refund_cents: Cents; credit_reporting_correction: boolean } {
  const c = cashCfg(state);
  const fee = (state.fees ?? []).find((f) => f.fee_type === "late_charge" && f.installment_due_date === installmentDueDate && (f.state === "assessed" || f.state === "collected"));
  if (!fee || newCreditedAsOf > graceEnd(installmentDueDate, c.grace)) return { reversed: null, refund_cents: 0n, credit_reporting_correction: false };
  const refund = fee.collected_cents;
  if (fee.state === "assessed") state.late_charges_due_cents -= fee.amount_cents - fee.collected_cents;
  fee.state = "reversed";
  return { reversed: fee, refund_cents: refund, credit_reporting_correction: true };
}

export interface NsfJurisdiction { readonly allowed: boolean; readonly cap_cents: Cents | null; }
export const NSF_POLICY_CENTS = 2_500n;

/** 2.7 rule 7. */
export function nsfFee(state: LoanCashState, j: NsfJurisdiction, opts: { our_error: boolean; returned_on: PlainDate }): Fee | null {
  const c = cashCfg(state);
  if (!j.allowed || opts.our_error) return null;
  if (c.overlays.some((o) => (o.kind === "bankruptcy_active" || o.kind === "scra_reduced_rate" || o.kind === "forbearance_active") && o.from <= opts.returned_on && (o.to == null || o.to >= opts.returned_on))) return null;
  const amount = j.cap_cents !== null && j.cap_cents < NSF_POLICY_CENTS ? j.cap_cents : NSF_POLICY_CENTS;
  return { id: randomUUID(), fee_type: "nsf_fee", installment_due_date: null, amount_cents: amount, state: "assessed", assessed_on: opts.returned_on, collected_cents: 0n };
}

/** 2.7 rule 9: statement/reminder data for an unpaid installment. */
export function lateFeeDisclosure(state: LoanCashState, due: PlainDate): { late_fee_amount_if_unpaid: Cents; late_fee_date: PlainDate } {
  const c = cashCfg(state);
  const inst = state.installments.find((x) => x.due_date === due)!;
  const basis = c.basis === "piti" ? inst.pi_cents + inst.escrow_cents : inst.pi_cents;
  return { late_fee_amount_if_unpaid: lateChargeAmount(basis, c.lcPct, c.lcCap), late_fee_date: addDays(graceEnd(due, c.grace), 1) };
}

/** 2.7-T9: note terms apply unless the state's percentage cap is stricter; a conflict is flagged at boarding and the lower cap applied.
 *  The state grace figure is carried for the jurisdiction table but not enforced against the note (spec 2.7-T9: 4%/10 applies under a 5%/15 cap; the state table is [UNVERIFIED]). */
export function lateChargeTerms(note: { pct: string; grace_days: number }, state: { max_pct: string; min_grace_days: number; state: string } | null): { pct: string; grace_days: number; conflict: null | { state: string; note: typeof note; cap: string; applied: "lower_cap" } } {
  if (!state) return { pct: note.pct, grace_days: note.grace_days, conflict: null };
  if (Decimal.parse(note.pct).cmp(Decimal.parse(state.max_pct)) <= 0) return { pct: note.pct, grace_days: note.grace_days, conflict: null };
  return { pct: state.max_pct, grace_days: note.grace_days, conflict: { state: state.state, note, cap: `${state.max_pct}%/${state.min_grace_days} days`, applied: "lower_cap" } };
}
/** 2.7-T13: late charges collected in a period — the `fees.collected` figure 5.1 carries on the period's LAR/event. */
export function collectedForPeriod(fees: readonly Fee[], period: string): Cents {
  return fees.filter((f) => f.fee_type === "late_charge" && f.collected_on !== undefined && f.collected_on !== null && String(f.collected_on).startsWith(period)).reduce((s, f) => s + (f.collected_cents ?? 0n), 0n);
}
