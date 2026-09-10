/** §3.6 Shortage repayment plans. */
import type { Cents } from "../../kernel/money/cents.ts";
import { divRound } from "../../kernel/money/decimal.ts";
import { type PlainDate, addMonths } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";

export interface Plan { readonly kind: "shortage" | "deficiency"; readonly total_cents: Cents; readonly months: number; readonly installment_cents: Cents; readonly final_installment_cents: Cents; readonly start_due_date: PlainDate; readonly end_due_date: PlainDate; readonly basis: "regx_12" | "workout_60" | "election" | "instrument_cap" | "nh_0pct"; collected_cents: Cents; status: "active" | "paid_lump" | "completed" | "superseded" | "retained_pending_reinstatement"; readonly interest_rate_pct: "0"; }

export function buildPlan(kind: Plan["kind"], total: Cents, start: PlainDate, o: { workout?: boolean; election_months?: number | null; instrument_max_months?: number | null; policy_months?: number; state?: string; deficiency_installments?: number }): Plan | { error: string } {
  let months = kind === "deficiency" ? (o.deficiency_installments ?? 12) : (o.workout ? 60 : (o.policy_months ?? 12));
  let basis: Plan["basis"] = o.workout ? "workout_60" : "regx_12";
  if (o.workout && o.election_months != null) { if (o.election_months < 12) return { error: "elections must be ≥ 12 months" }; months = o.election_months; basis = "election"; }
  if (!o.workout && o.instrument_max_months != null && o.instrument_max_months < months) { months = o.instrument_max_months; basis = "instrument_cap"; }
  if (o.state === "NH" && kind === "deficiency") { months = Math.max(12, months); basis = "nh_0pct"; }
  const inst = divRound(total, BigInt(months), "HALF_UP");
  return { kind, total_cents: total, months, installment_cents: inst, final_installment_cents: total - inst * BigInt(months - 1), start_due_date: start, end_due_date: addMonths(start, months - 1), basis, collected_cents: 0n, status: "active", interest_rate_pct: "0" };
}
export function recordInstallment(p: Plan, n: number): void { p.collected_cents += n === p.months ? p.final_installment_cents : p.installment_cents; if (p.collected_cents >= p.total_cents) p.status = "completed"; }
export function lumpSum(p: Plan, received: Cents, on: PlainDate): { paid: boolean; interim_analysis_by: PlainDate } { const paid = received >= p.total_cents - p.collected_cents; if (paid) { p.status = "paid_lump"; p.collected_cents = p.total_cents; } return { paid, interim_analysis_by: addBusinessDays(on, 10, servicer) }; }
/** 3.6-T8 gate: deficiency from a servicer advance may not be demanded before the interim analysis ((f)(1)(ii)). */
export function demandDeficiencyGate(analysisDone: boolean): { ok: true } | { ok: false; gate: "REGX_1024_17F1_ADVANCE_DEFICIENCY_ANALYSIS_GATE" } { return analysisDone ? { ok: true } : { ok: false, gate: "REGX_1024_17F1_ADVANCE_DEFICIENCY_ANALYSIS_GATE" }; }
