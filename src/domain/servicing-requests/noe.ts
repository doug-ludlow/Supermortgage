/** §4.1 Notice of Error — assertion profiles, deadlines, extensions, exceptions, correction arithmetic. */
import { type PlainDate, addDays, addYears } from "../../kernel/calendar/date.ts";
import { federalDays } from "./clocks.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { lateChargeAmount } from "../cashiering/latecharges.ts";

export type AssertionType = "b1" | "b2" | "b3" | "b4" | "b5" | "b6" | "b7" | "b8" | "b9" | "b10" | "b11";
/** (b)(9)/(10): the foreclosure assertions that carry the sale-or-30 clock, the FC gate and the (f)(2) good-faith path. */
export const isForeclosureAssertion = (t: AssertionType): boolean => t === "b9" || t === "b10";
/** 4.1 rule 9: assertions touching a payment (b1–b3, b5 late-fee disputes, b11 delinquency disputes) write the §1024.35(i) suppression row. */
export const isPaymentRelated = (t: AssertionType): boolean => t === "b1" || t === "b2" || t === "b3" || t === "b5" || t === "b11";
/** 4.1 guardrails: corrections above `case.correction.max_cents` (default 500,000¢ = $5,000) need human (officer) approval. */
export const CORRECTION_MAX_CENTS: Cents = 500_000n;

export interface Deadlines { readonly profile: "payoff_7" | "fc_before_sale" | "fc_within_7_days_goodfaith" | "std_30"; readonly ack_due: PlainDate | null; readonly response_due: PlainDate; readonly extendable: boolean; readonly credit_reporting_bar_through: PlainDate; readonly document_copies_due: PlainDate; }
/**
 * §1024.35(e)(3)(i)(B): a (b)(9)/(10) assertion is answered "prior to the date of a foreclosure sale or within 30 days,
 * whichever is earlier" — the computed anchor `noe_fc_response_due` of REGX_1024_35E_NOE_FC_RESPONSE_SALE_OR_30 (and, with
 * 15 servicer BD, of NY_419_6_NOE_FC_RESPONSE_15BD via ops.nyNoeDeadline); recomputed on `foreclosure.sale.rescheduled`.
 */
export function noeForeclosureDue(receivedOn: PlainDate, saleOn?: PlainDate | null): PlainDate {
  const std = federalDays(receivedOn, 30);
  if (!saleOn) return std;
  const beforeSale = addDays(saleOn, -1);
  return beforeSale < std ? beforeSale : std;
}
export function deadlines(type: AssertionType, receivedOn: PlainDate, o: { sale_date?: PlainDate | null } = {}): Deadlines {
  const ack = federalDays(receivedOn, 5), docs = federalDays(receivedOn, 15), bar = addDays(receivedOn, 60);
  if (type === "b6") return { profile: "payoff_7", ack_due: ack, response_due: federalDays(receivedOn, 7), extendable: false, credit_reporting_bar_through: bar, document_copies_due: docs };
  if (isForeclosureAssertion(type) && o.sale_date) {
    if (addDays(o.sale_date, -7) <= receivedOn) return { profile: "fc_within_7_days_goodfaith", ack_due: null, response_due: addDays(o.sale_date, -1), extendable: false, credit_reporting_bar_through: bar, document_copies_due: docs };
    return { profile: "fc_before_sale", ack_due: ack, response_due: noeForeclosureDue(receivedOn, o.sale_date), extendable: false, credit_reporting_bar_through: bar, document_copies_due: docs };
  }
  return { profile: "std_30", ack_due: ack, response_due: federalDays(receivedOn, 30), extendable: true, credit_reporting_bar_through: bar, document_copies_due: docs };
}
export function extend(d: Deadlines, noticeSentOn: PlainDate): Deadlines | { error: "EXTENSION_NOT_PERMITTED" | "EXTENSION_LATE" } {
  if (!d.extendable) return { error: "EXTENSION_NOT_PERMITTED" }; if (noticeSentOn > d.response_due) return { error: "EXTENSION_LATE" };
  return { ...d, response_due: federalDays(d.response_due, 15), extendable: false };
}
export type Exception = "duplicative" | "overbroad" | "untimely" | null;
export function exception(f: { similarity_to_prior: number; new_material_info: boolean; identifiable: boolean; received_on: PlainDate; transfer_out_or_discharge_on?: PlainDate | null; concerns_own_servicing?: boolean }): Exception {
  if (f.transfer_out_or_discharge_on && !f.concerns_own_servicing && f.received_on > addYears(f.transfer_out_or_discharge_on, 1)) return "untimely";
  if (f.similarity_to_prior >= 0.85 && !f.new_material_info) return "duplicative";
  if (!f.identifiable) return "overbroad";
  return null;
}
/** §1024.35(g)(2): the exception notice is due within 5 federal BD of the *determination* (REGX_1024_35G2_NOE_EXCEPTION_NOTICE_5 anchors on `case.noe.exception_determined`), not of receipt. */
export function exceptionNoticeDue(determinedOn: PlainDate): PlainDate { return federalDays(determinedOn, 5); }
/** 4.1 rule 6 worked example: payment received 3/01 posted 3/17 → late charge 5% × P&I reversed on re-dating. */
export function misappliedPaymentCorrection(piCents: Cents, pct: string, actualReceipt: PlainDate): { late_charge_reversed_cents: Cents; repost_effective_date: PlainDate; entries: { account: string; cents: Cents }[] } {
  const lc = lateChargeAmount(piCents, pct, null);
  return { late_charge_reversed_cents: lc, repost_effective_date: actualReceipt, entries: [{ account: "late_charges", cents: -lc }, { account: "borrower_receivable", cents: lc }] };
}
export const REQUIRED_RECORDS: Record<AssertionType, string[]> = { b1: ["ledger", "payment_images", "allocation_rules"], b2: ["ledger", "payment_images", "allocation_rules"], b3: ["ledger", "escrow_analysis"], b4: ["ledger", "escrow_analysis"], b5: ["fee_schedule", "jurisdiction_rules", "ledger"], b6: ["payoff_quotes", "ledger"], b7: ["lossmit_case_history"], b8: ["lossmit_case_history", "notice_registry"], b9: ["foreclosure_milestones", "lossmit_case_history"], b10: ["foreclosure_milestones"], b11: ["ledger", "notice_registry", "contact_logs"] };
export function investigationValid(type: AssertionType, consulted: readonly string[]): { valid: boolean; missing: string[] } { const m = REQUIRED_RECORDS[type].filter((r) => !consulted.includes(r)); return { valid: m.length === 0, missing: m }; }
