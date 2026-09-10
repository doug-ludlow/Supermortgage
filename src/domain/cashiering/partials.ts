/**
 * §2.2 Partial payment / suspense handling — the four-condition hold
 * (C-1.1-02), the 30-day return sweep, and re-evaluation on a P change.
 * The $50 rule itself lives in the Allocation Engine (evaluated first).
 */
import { randomUUID } from "node:crypto";
import { type PlainDate, addDays } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer, type Calendar } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { type LoanCashState, cashCfg } from "./types.ts";

export type SuspenseReason = "partial_payment" | "biweekly_accumulation" | "remainder_under_p" | "trial_hold" | "foreclosure_hold";
export type SuspenseStatus = "open" | "contact_pending" | "applied" | "returned" | "refunded" | "transferred" | "applied_to_oldest";

export interface SuspenseItem {
  readonly id: string; readonly loan_id: string; readonly payment_id: string;
  amount_cents: Cents; readonly received_on: PlainDate; reason_code: SuspenseReason; status: SuspenseStatus;
  partial_commitment_due_on: PlainDate | null; rule_path: string; decision_cite?: string; return_rail?: "ach_credit" | "check";
  /** `foreclosure_hold` items: the foreclosure case owner decides accept-and-apply vs return within 2 BD (2.2 rule 3). */
  fc_decision_due_on?: PlainDate;
  fc_decision?: { decision: "accept_and_apply" | "return"; decided_on: PlainDate; decided_by: string; on_time: boolean };
}

export interface Commitment { readonly kind: "coupon_note" | "portal_note" | "history_completes_partials" | "active_workout_case" | "contact_intent"; readonly stated_date?: PlainDate | null; }

export interface PartialContext { readonly state: LoanCashState; readonly days_delinquent: number; readonly commitment?: Commitment | null; readonly received_on: PlainDate; readonly amount_cents: Cents; readonly payment_id: string; readonly rail: "ach_credit" | "check"; }

export type PartialDecision =
  | { kind: "hold"; due_on: PlainDate; rule_path: string; cite: string }
  | { kind: "hold_policy_override"; due_on: PlainDate; rule_path: string; cite: string }
  | { kind: "foreclosure_hold"; decision_due_bd: 2; rule_path: string; cite: string }
  | { kind: "contact_pending"; rule_path: string; cite: string };

/** 2.2 rule 3 (i)–(iv) as the four booleans the `partial_payment_evaluations` row records (ops-2-2.ts). */
export function partialConditions(ctx: PartialContext): { commitment: boolean; not_habitual: boolean; no_nsf_history: boolean; thirty_day_commitment: boolean } {
  const c = cashCfg(ctx.state);
  return { commitment: !!ctx.commitment || ctx.state.plan_active || ctx.state.trial_active, not_habitual: c.late30 < 3, no_nsf_history: c.nsf12 === 0,
    thirty_day_commitment: !!ctx.commitment && (ctx.commitment.kind !== "coupon_note" && ctx.commitment.kind !== "portal_note" ? true : !ctx.commitment.stated_date || ctx.commitment.stated_date <= addDays(ctx.received_on, 30)) };
}

/** 2.2 rule 3 — the four-condition test, with the platform's hold-not-return default. */
export function decidePartial(ctx: PartialContext): PartialDecision {
  const c = cashCfg(ctx.state);
  const cite = "Servicing Guide C-1.1-02";
  if (c.fcReferred && c.fcRisk) return { kind: "foreclosure_hold", decision_due_bd: 2, rule_path: "2.2:r3:foreclosure_hold", cite };
  const { commitment, not_habitual: notHabitual, no_nsf_history: noNsf, thirty_day_commitment: thirty } = partialConditions(ctx);
  const due_on = addDays(ctx.received_on, 30);
  if (commitment && notHabitual && noNsf && thirty) return { kind: "hold", due_on, rule_path: "2.2:r3:four_conditions", cite };
  if (!commitment) return { kind: "contact_pending", rule_path: "2.2:r3:commitment_needed", cite };
  // (ii)/(iii) failed → Guide "authorized to return"; policy holds ≤60 days delinquent with no referral.
  if (ctx.days_delinquent <= 60 && !c.fcReferred) return { kind: "hold_policy_override", due_on, rule_path: "2.2:r3:hold_policy_override", cite: `${cite} "authorized to return"` };
  return { kind: "foreclosure_hold", decision_due_bd: 2, rule_path: "2.2:r3:return_path_referred", cite };
}

export function openSuspenseItem(ctx: PartialContext, d: PartialDecision, reason: SuspenseReason = "partial_payment", cal: Calendar = servicer): SuspenseItem {
  return { id: randomUUID(), loan_id: ctx.state.loan_id, payment_id: ctx.payment_id, amount_cents: ctx.amount_cents, received_on: ctx.received_on, reason_code: d.kind === "foreclosure_hold" ? "foreclosure_hold" : reason,
    status: d.kind === "contact_pending" ? "contact_pending" : "open", partial_commitment_due_on: d.kind === "hold" || d.kind === "hold_policy_override" ? d.due_on : null, rule_path: d.rule_path, decision_cite: d.cite, return_rail: ctx.rail,
    ...(d.kind === "foreclosure_hold" ? { fc_decision_due_on: addBusinessDays(ctx.received_on, d.decision_due_bd, cal) } : {}) };
}

/** 2.2 rule 3 / T6: the foreclosure case owner's decision on a `foreclosure_hold` item, recorded against its 2-BD clock. */
export function recordForeclosureHoldDecision(item: SuspenseItem, decision: "accept_and_apply" | "return", decidedOn: PlainDate, decidedBy: string): SuspenseItem {
  if (item.reason_code !== "foreclosure_hold" || !item.fc_decision_due_on) throw new RangeError("not a foreclosure_hold item");
  item.fc_decision = { decision, decided_on: decidedOn, decided_by: decidedBy, on_time: decidedOn <= item.fc_decision_due_on };
  item.status = decision === "return" ? "returned" : "applied_to_oldest";
  return item;
}

/** 2.2 rule 6 — day-30 sweep: items past their commitment date with the balance still short are returned by the original rail. */
export function sweepReturns(items: SuspenseItem[], today: PlainDate, pFor: (loanId: string) => Cents, sumOpen: (loanId: string) => Cents): SuspenseItem[] {
  const out: SuspenseItem[] = [];
  for (const it of items) {
    if (it.status !== "open" || it.reason_code !== "partial_payment" || !it.partial_commitment_due_on) continue;
    if (today > it.partial_commitment_due_on && sumOpen(it.loan_id) < pFor(it.loan_id)) { it.status = "returned"; out.push(it); }
  }
  return out;
}

/** 2.5: a biweekly half unmatched for > 45 days becomes an ordinary partial and the 30-day clock starts. */
export function reclassifyStaleHalves(items: SuspenseItem[], today: PlainDate): SuspenseItem[] {
  const out: SuspenseItem[] = [];
  for (const it of items) if (it.status === "open" && it.reason_code === "biweekly_accumulation" && addDays(it.received_on, 45) < today) {
    it.reason_code = "partial_payment"; it.partial_commitment_due_on = addDays(today, 30); it.rule_path += ";2.5:stale_half→partial"; out.push(it);
  }
  return out;
}
