/** §11.4 FDCPA / Reg F — debt-collector determination, validation notice timing and content, overlays. */
import type { Cents } from "../../kernel/money/cents.ts";
import { type PlainDate, addDays } from "../../kernel/calendar/date.ts";
import { addBusinessDays, federal } from "../../kernel/calendar/business.ts";

/** §1692a(6)(F)(iii): status fixed as of the date the debt was obtained for servicing. */
export function determineDebtCollector(f: { regx_days_delinquent_at_transfer: number; bk_active: boolean; fc_active: boolean; accelerated: boolean; threshold_days?: number; originated_by_partner?: boolean }): { debt_collector: boolean; basis: string } {
  if (f.originated_by_partner) return { debt_collector: false, basis: "origination_pipeline" };
  const t = f.threshold_days ?? 0;
  if (f.regx_days_delinquent_at_transfer > t) return { debt_collector: true, basis: "default_at_obtain" };
  if (f.bk_active || f.fc_active || f.accelerated) return { debt_collector: true, basis: f.bk_active ? "bankruptcy_at_obtain" : f.fc_active ? "foreclosure_at_obtain" : "accelerated_at_obtain" };
  return { debt_collector: false, basis: "current_at_obtain" };
}
/** §1006.34(a)(1)(i)(B): written notice within five *calendar* days of the initial communication. */
export function validationNoticeDue(initialCommunicationOn: PlainDate): PlainDate { return addDays(initialCommunicationOn, 5); }
/** §1006.34(b)(5): assumed receipt five days after mailing excluding Saturdays, Sundays and legal public holidays; validation period ends 30 days later. */
export function validationPeriod(mailedOn: PlainDate): { assumed_receipt_on: PlainDate; validation_period_end_on: PlainDate } { const r = addBusinessDays(mailedOn, 5, federal); return { assumed_receipt_on: r, validation_period_end_on: addDays(r, 30) }; }

export interface Itemization { readonly itemization_date: PlainDate; readonly amount_on_itemization_cents: Cents; readonly interest_since_cents: Cents; readonly fees_since_cents: Cents; readonly payments_since_cents: Cents; readonly credits_since_cents: Cents; readonly current_amount_cents: Cents; }
export function itemizationChecks(i: Itemization): { sum_cents: Cents; consistent: boolean; rounding_difference_cents: Cents } {
  const sum = i.amount_on_itemization_cents + i.interest_since_cents + i.fees_since_cents - i.payments_since_cents - i.credits_since_cents;
  return { sum_cents: sum, consistent: sum === i.current_amount_cents, rounding_difference_cents: i.current_amount_cents - sum };
}
/** Overshadowing template check during the validation period. */
export function overshadows(text: string, validationEnd: PlainDate, refDate: PlainDate): string[] {
  const issues: string[] = [];
  const m = /within (\d+) days/i.exec(text); if (m && addDays(refDate, Number(m[1])) < validationEnd) issues.push(`demands payment within ${m[1]} days, before the validation period ends`);
  if (/immediately|final notice|legal action will/i.test(text)) issues.push("threatens action inconsistent with the dispute right");
  if (!/dispute/i.test(text)) issues.push("dispute statement missing");
  return issues;
}
export type Overlay = { dispute_open?: boolean; cease_active?: boolean; attorney_represented?: boolean; bankruptcy_stay?: boolean };
export const PERMITTED_DURING_CEASE = new Set(["NTC_REGF_1006_6C_CEASE_ACK", "remedy_notice", "regx_ei_notice", "lossmit_response", "periodic_statement", "legally_required"]);
export function communicationAllowed(o: Overlay, kind: string, direction: "outbound_collection" | "borrower_initiated"): { allowed: boolean; reason?: string } {
  if (direction === "borrower_initiated") return { allowed: true };
  if (o.bankruptcy_stay) return { allowed: false, reason: "bankruptcy_stay" };
  if (o.attorney_represented) return { allowed: false, reason: "attorney_represented (§1006.6(b)(2))" };
  if (o.dispute_open && !PERMITTED_DURING_CEASE.has(kind)) return { allowed: false, reason: "collection ceased pending verification (§1006.38)" };
  if (o.cease_active && !PERMITTED_DURING_CEASE.has(kind)) return { allowed: false, reason: "written cease (§1006.6(c))" };
  return { allowed: true };
}
