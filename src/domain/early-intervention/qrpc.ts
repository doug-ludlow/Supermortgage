/** §11.3 Quality Right Party Contact — D2-2-01 completeness, reason mapping, promise-to-pay, staleness. */
import type { Cents } from "../../kernel/money/cents.ts";
import { type PlainDate, addDays, daysBetween } from "../../kernel/calendar/date.ts";

export interface Conversation {
  readonly verified_party: "borrower" | "coborrower" | "authorized_third_party" | "unverified";
  readonly reason_primary?: string | null; readonly hardship_nature?: string | null;
  readonly occupancy_status?: string | null;
  readonly ability_to_pay?: { can_resume_full_payment_on?: PlainDate | null; stated_surplus_cents?: Cents | null; commitment_kind?: string | null } | null;
  readonly options_explained?: readonly string[] | null; readonly options_not_appropriate_reason?: string | null;
  readonly commitment_kind?: "promise_to_pay" | "workout_interest" | "no_interest" | "refused" | "callback_only" | null;
  readonly payment_importance_emphasized?: boolean;
}
export function qrpcCompleteness(c: Conversation): { complete: boolean; missing: string[] } {
  const m: string[] = [];
  if (c.verified_party === "unverified") m.push("verified_party");
  if (!c.reason_primary) m.push("reason");
  if (!c.occupancy_status) m.push("occupancy");
  if (!c.ability_to_pay || !(c.ability_to_pay.can_resume_full_payment_on || c.ability_to_pay.stated_surplus_cents != null || c.ability_to_pay.commitment_kind)) m.push("ability_to_pay");
  if (!(c.options_explained && c.options_explained.length) && !c.options_not_appropriate_reason) m.push("options");
  if (!c.commitment_kind || c.commitment_kind === "callback_only") m.push("commitment");
  if (!c.payment_importance_emphasized) m.push("payment_importance");
  return { complete: m.length === 0, missing: m };
}
export const REASON_MAP: Record<string, string> = { unemployment: "016", reduction_in_income: "006", increase_in_expenses: "007", excessive_obligations: "007", death_of_borrower: "001", death_of_family_member: "004", disability_or_illness_borrower: "002", disability_or_illness_family: "003", divorce_or_separation: "005", separation_unmarried: "005", distant_employment_transfer: "009", business_failure: "017", disaster_casualty: "019", disaster_property_problem: "011", property_problem: "011", inability_to_sell: "012", inability_to_rent: "013", military_service: "014", incarceration: "INC", payment_dispute: "027", servicing_problem: "023", other: "015", declined: "015" };
export function reasonCode(reason: string): string { return REASON_MAP[reason] ?? "015"; }

/** D2-2-02: a cadence-ceasing promise covers the full delinquent amount and is due within 30 days. */
export function promiseToPay(promisedCents: Cents, dueOn: PlainDate, recordedOn: PlainDate, totalDelinquentCents: Cents): { valid: boolean; covers: "full" | "partial"; within_30: boolean; plan: "ceased{ptp_pending}" | "active"; next_attempt_on?: PlainDate } {
  const within = daysBetween(recordedOn, dueOn) <= 30 && dueOn >= recordedOn;
  const full = promisedCents >= totalDelinquentCents;
  if (full && within) return { valid: true, covers: "full", within_30: within, plan: "ceased{ptp_pending}" };
  return { valid: false, covers: full ? "full" : "partial", within_30: within, plan: "active", next_attempt_on: addDays(dueOn, 1) };
}
export function promiseOutcome(paidCents: Cents, promisedCents: Cents): "kept" | "partial" | "broken" { return paidCents >= promisedCents ? "kept" : paidCents > 0n ? "partial" : "broken"; }
export const STALE_DAYS = 30;
export function isStale(achievedOn: PlainDate, today: PlainDate, resolved: boolean): boolean { return !resolved && daysBetween(achievedOn, today) > STALE_DAYS; }
export function thirdPartyAuthorization(kind: "written" | "oral_three_way", on: PlainDate): { scope: "discuss_only" | "full"; expires_on: PlainDate | null } { return kind === "oral_three_way" ? { scope: "discuss_only", expires_on: addDays(on, 90) } : { scope: "full", expires_on: null }; }
