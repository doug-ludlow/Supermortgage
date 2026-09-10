/** §12.9 Short sale / Mortgage Release — contribution, net proceeds, windows, incentives. */
import type { Cents } from "../../kernel/money/cents.ts";
import { divRound } from "../../kernel/money/decimal.ts";
import { type PlainDate, addDays, daysBetween } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";

export function contribution(reservesCents: Cents, pitiCents: Cents, deficiencyCents: Cents): { required: boolean; request_cents: Cents } {
  const raw = [divRound(reservesCents * 20n, 100n, "HALF_UP"), 4n * pitiCents].reduce((a, b) => (b > a ? b : a));
  let req = divRound(raw, 10_000n, "HALF_UP") * 10_000n; if (req > deficiencyCents) req = deficiencyCents;
  return req < 50_000n ? { required: false, request_cents: 0n } : { required: true, request_cents: req };
}
export function negotiated(requestCents: Cents, offerCents: Cents): "accepted" | "fnma_referral" { return offerCents * 2n >= requestCents ? "accepted" : "fnma_referral"; }
export function relocation(contributionRequired: boolean, thirdPartyAssistance: Cents, remediationEstimate = 0n): Cents { if (contributionRequired) return 0n; const r = 750_000n - thirdPartyAssistance - remediationEstimate; return r > 0n ? r : 0n; }
export function netProceeds(price: Cents, costs: { commission: Cents; prorations: Cents; transfer_taxes: Cents; title_settlement: Cents; seller_attorney: Cents; hoa_past_due: Cents; subordinate_liens: Cents; relocation: Cents }): { net_cents: Cents; commission_ok: boolean; subordinate_ok: boolean } {
  const total = Object.values(costs).reduce((a, b) => a + b, 0n);
  return { net_cents: price - total, commission_ok: costs.commission * 100n <= price * 6n, subordinate_ok: costs.subordinate_liens <= 600_000n };
}
export function shortSaleClocks(offerOn: PlainDate, approvalOn?: PlainDate): { ack_by: PlainDate; decision_by: PlainDate; close_by: PlainDate | null } { return { ack_by: addBusinessDays(offerOn, 5, servicer), decision_by: addDays(offerOn, 30), close_by: approvalOn ? addDays(approvalOn, 60) : null }; }
export function listingRuleMet(mlsActiveDays: number): boolean { return mlsActiveDays >= 5; }
export function dilClocks(acceptanceOn: PlainDate): { documents_by: PlainDate; extended_by: PlainDate } { return { documents_by: addDays(acceptanceOn, 60), extended_by: addDays(acceptanceOn, 90) }; }
export function deedTiming(deedReceivedOn: PlainDate, saleOn: PlainDate): "allowed" | "fnma_prior_approval" { return daysBetween(deedReceivedOn, saleOn) >= 30 ? "allowed" : "fnma_prior_approval"; }
export function incentive(daysDelinquentAtClosing: number): Cents { return daysDelinquentAtClosing <= 210 ? 250_000n : daysDelinquentAtClosing <= 300 ? 150_000n : 75_000n; }   // tiers [UNVERIFIED boundaries]
export function leaseOption(kind: "12_month" | "3_month", inChapter13: boolean, principalResidence: boolean): boolean { return kind === "3_month" ? principalResidence : !inChapter13; }
