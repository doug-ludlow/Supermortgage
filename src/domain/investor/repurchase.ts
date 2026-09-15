/** §5.6 Repurchase reporting — pricing, appeal ladder, DPO indemnification. */
import type { Cents } from "../../kernel/money/cents.ts";
import { type PlainDate, addDays, addMonths, parts, ymd } from "../../kernel/calendar/date.ts";
import { Decimal, divRound } from "../../kernel/money/decimal.ts";
import { monthInterest, payoffInterest } from "./remittance.ts";

export function mbsRepurchasePrice(scheduledUpb: Cents, ptr: string): { principal_cents: Cents; interest_cents: Cents; price_cents: Cents; action_code: "65" } {
  const i = monthInterest(scheduledUpb, ptr); return { principal_cents: scheduledUpb, interest_cents: i, price_cents: scheduledUpb + i, action_code: "65" };
}
export function portfolioAaRepurchasePrice(actualUpb: Cents, purchasePricePct: string, ptr: string, lpi: PlainDate, effective: PlainDate, expensesCents = 0n): { principal_cents: Cents; interest_cents: Cents; price_cents: Cents } {
  const principal = divRound(actualUpb * Decimal.parse(purchasePricePct).unscaled, 100n * Decimal.ONE.unscaled, "HALF_UP");
  const interest = payoffInterest("AA", actualUpb, ptr, lpi, effective);
  return { principal_cents: principal, interest_cents: interest, price_cents: principal + interest + expensesCents };
}
/** 5.6 data model `repurchases.type` (A1-3-02): the voluntary and demanded routes plus the two mandatory ones. */
export type RepurchaseType = "voluntary_portfolio" | "voluntary_mbs_regular_4mo" | "due_on_sale" | "bk_plan_mod" | "fnma_demand" | "mandatory_24mo" | "mandatory_event" | "make_whole" | "dpo_indemnification";
export const REPURCHASE_TYPES: readonly RepurchaseType[] = ["voluntary_portfolio", "voluntary_mbs_regular_4mo", "due_on_sale", "bk_plan_mod", "fnma_demand", "mandatory_24mo", "mandatory_event", "make_whole", "dpo_indemnification"];
/** A1-3-02 "Mandatory Repurchase of Certain MBS Mortgage Loans": the events that require immediate notice to Fannie Mae and removal from the pool (`mandatory_event`). */
export type MandatoryEventTrigger = "court_or_regulator_determination" | "arm_converted_to_fixed" | "arm_index_changed" | "assumption_changed_caps_or_margin" | "government_required_property_transfer" | "insurer_required_transfer" | "mortgage_release";
export interface MandatoryRepurchaseSchedule { readonly type: "mandatory_24mo"; readonly months_past_due_at_demand: number; readonly demand_expected_on: PlainDate; readonly due_date_24th: PlainDate; readonly reporting_period: string; readonly demand_at_22_months: boolean; }
/**
 * A1-3-02: a regular servicing option loan (in its pool, or reclassified at six months with the servicer's recourse retained) must be repurchased no
 * later than 24 months past due measured from the LPI date; Fannie Mae issues the demand at 22 months past due, and the repurchase "must be reported
 * to Fannie Mae as activity occurring in the month that contains the due date of the 24th consecutive past due payment". Installments past due are
 * counted from the LPI: the n-th consecutive past-due installment is due LPI + n months.
 */
export function mandatoryRepurchaseSchedule(lpi: PlainDate, demandReceivedOn: PlainDate): MandatoryRepurchaseSchedule {
  let months = 0; while (addMonths(lpi, months + 1) <= demandReceivedOn) months++;
  const due24 = addMonths(lpi, 24); const { y, m } = parts(due24);
  return { type: "mandatory_24mo", months_past_due_at_demand: months, demand_expected_on: addMonths(lpi, 22), due_date_24th: due24, reporting_period: `${y}-${String(m).padStart(2, "0")}`, demand_at_22_months: months === 22 };
}
/** The first day of a reporting period (`YYYY-MM`) — the month of the 24th past-due installment. */
export const reportingMonthStart = (period: string): PlainDate => ymd(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 1);
/** Demand ladder: pay-by and first appeal 60 days from receipt; second appeal 15 days after a denial. */
export function appealLadder(demandReceived: PlainDate, firstDenialReceived?: PlainDate): { pay_by: PlainDate; first_appeal_by: PlainDate; second_appeal_by: PlainDate | null } {
  return { pay_by: addDays(demandReceived, 60), first_appeal_by: addDays(demandReceived, 60), second_appeal_by: firstDenialReceived ? addDays(firstDenialReceived, 15) : null };
}
/** A1-3-02 DPO arithmetic: indemnification = denied claim × payout %; a later higher payout bills the increment. */
export function dpoIndemnification(deniedClaimCents: Cents, payoutPct: string, previouslyPaidCents = 0n): Cents {
  const total = divRound(deniedClaimCents * Decimal.parse(payoutPct).unscaled, 100n * Decimal.ONE.unscaled, "HALF_UP");
  return total - previouslyPaidCents;
}
