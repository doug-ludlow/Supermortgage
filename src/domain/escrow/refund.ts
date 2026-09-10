/** §3.5 Surplus refund — thresholds, eligibility, timers, methods. */
import type { Cents } from "../../kernel/money/cents.ts";
import { type PlainDate, addDays } from "../../kernel/calendar/date.ts";
import { addBusinessDays, federal } from "../../kernel/calendar/business.ts";

export const REFUND_THRESHOLD_CENTS = 5_000n;
export function refundDecision(surplus: Cents, regxDaysDelinquent: number, asOf: PlainDate, borrowerRequestsRefund = false): { action: "refund" | "credit" | "retain"; due_on: PlainDate | null } {
  if (regxDaysDelinquent > 30) return { action: "retain", due_on: null };
  if (surplus >= REFUND_THRESHOLD_CENTS || borrowerRequestsRefund) return { action: "refund", due_on: addDays(asOf, 30) };
  return { action: "credit", due_on: null };
}
/** §1024.34(b): 20 days excluding Saturdays, Sundays and legal public holidays after payoff. */
export function payoffRefundDue(payoffPostedOn: PlainDate): PlainDate { return addBusinessDays(payoffPostedOn, 20, federal); }
export function refundMethod(consents: { refund_ach?: boolean; credit_to_new_loan?: boolean }, newLoanSettlesOn?: PlainDate, consentOn?: PlainDate): "check" | "ach" | "credit_to_new_loan" {
  if (consents.credit_to_new_loan && newLoanSettlesOn && consentOn && newLoanSettlesOn >= consentOn) return "credit_to_new_loan";
  return consents.refund_ach ? "ach" : "check";
}
export const DUAL_APPROVAL_CENTS = 2_500_000n;
export function needsDualApproval(refund: Cents): boolean { return refund >= DUAL_APPROVAL_CENTS; }
