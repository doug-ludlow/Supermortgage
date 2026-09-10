/** §3.6 Shortage repayment plans. */
import type { Cents } from "../../kernel/money/cents.ts";
import { divRound } from "../../kernel/money/decimal.ts";
import { type PlainDate, addMonths } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import type { Decision } from "./analysis.ts";

export interface Plan { readonly kind: "shortage" | "deficiency"; readonly total_cents: Cents; readonly months: number; readonly installment_cents: Cents; readonly final_installment_cents: Cents; readonly start_due_date: PlainDate; readonly end_due_date: PlainDate; readonly basis: "regx_12" | "regx_30day" | "workout_60" | "election" | "instrument_cap" | "nh_0pct"; collected_cents: Cents; status: "active" | "paid_lump" | "completed" | "superseded" | "retained_pending_reinstatement"; readonly interest_rate_pct: "0"; }
export interface PlanOptions { workout?: boolean; election_months?: number | null; instrument_max_months?: number | null; policy_months?: number; state?: string; deficiency_installments?: number; /** §1024.17(f)(3)(i): a shortage under one month's payment may be repaid "within 30 days" — one installment on the first due date (3.6-T2). */ thirty_day?: boolean; }

/** §1024.17(f)(3): any shortage spread is "over at least a 12-month period"; (f)(4): deficiencies in "2 or more" installments. (c)(8): an instrument allowing less than Reg X is overridden — "this section controls". */
export const REGX_MIN_MONTHS = { shortage: 12, deficiency: 2 } as const;

export function buildPlan(kind: Plan["kind"], total: Cents, start: PlainDate, o: PlanOptions): Plan | { error: string } {
  let months = kind === "deficiency" ? (o.deficiency_installments ?? 12) : (o.workout ? 60 : o.thirty_day ? 1 : (o.policy_months ?? 12));
  let basis: Plan["basis"] = o.workout ? "workout_60" : kind === "shortage" && o.thirty_day ? "regx_30day" : "regx_12";
  if (o.workout && o.election_months != null) { if (o.election_months < 12) return { error: "elections must be ≥ 12 months" }; months = o.election_months; basis = "election"; }
  if (!o.workout && o.instrument_max_months != null && o.instrument_max_months < months) {
    // The instrument cap binds only down to the Reg X floor (3.6 rule 2; 3.2 (c)(8)): a 6-month cap cannot shorten a shortage plan below 12 months.
    const floor = REGX_MIN_MONTHS[kind];
    months = Math.max(floor, o.instrument_max_months); basis = o.instrument_max_months >= floor ? "instrument_cap" : "regx_12";
  }
  if (o.state === "NH" && kind === "deficiency") { months = Math.max(12, months); basis = "nh_0pct"; }
  const inst = divRound(total, BigInt(months), "HALF_UP");
  return { kind, total_cents: total, months, installment_cents: inst, final_installment_cents: total - inst * BigInt(months - 1), start_due_date: start, end_due_date: addMonths(start, months - 1), basis, collected_cents: 0n, status: "active", interest_rate_pct: "0" };
}
export function recordInstallment(p: Plan, n: number): void { p.collected_cents += n === p.months ? p.final_installment_cents : p.installment_cents; if (p.collected_cents >= p.total_cents) p.status = "completed"; }
export function lumpSum(p: Plan, received: Cents, on: PlainDate): { paid: boolean; interim_analysis_by: PlainDate } { const paid = received >= p.total_cents - p.collected_cents; if (paid) { p.status = "paid_lump"; p.collected_cents = p.total_cents; } return { paid, interim_analysis_by: addBusinessDays(on, 10, servicer) }; }
/**
 * 3.6 edge case / T9: a later analysis recomputes the gap from the actual balance (which already holds the installments
 * collected), so the new plan is built from the analysis decision — never from `old remaining + new gap` — and the old
 * plan is `superseded`. Returns the replacement plan.
 */
export function supersedePlan(old: Plan, d: Decision, start: PlainDate, o: PlanOptions = {}): Plan {
  if (d.kind !== "shortage") throw new RangeError(`a ${d.kind} decision does not carry a repayment plan`);
  const total = old.kind === "deficiency" ? d.deficiency_cents : d.shortage_cents;
  const next = buildPlan(old.kind, total, start, o);
  if ("error" in next) throw new RangeError(next.error);
  old.status = "superseded";
  return next;
}
/** 3.6-T8 gate: deficiency from a servicer advance may not be demanded before the interim analysis ((f)(1)(ii)). */
export function demandDeficiencyGate(analysisDone: boolean): { ok: true } | { ok: false; gate: "REGX_1024_17F1_ADVANCE_DEFICIENCY_ANALYSIS_GATE" } { return analysisDone ? { ok: true } : { ok: false, gate: "REGX_1024_17F1_ADVANCE_DEFICIENCY_ANALYSIS_GATE" }; }
