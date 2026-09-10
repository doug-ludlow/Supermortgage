/** §12.9 Short sale / Mortgage Release — contribution, net proceeds, windows, incentives. */
import type { Cents } from "../../kernel/money/cents.ts";
import { divRound } from "../../kernel/money/decimal.ts";
import { type PlainDate, addDays, daysBetween, dayOfWeek } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";

/** D2-3.3-01 cash-contribution gates: not evaluated if prohibited by law, without a complete BRP, or for PCS servicemembers; required when reserves >$10,000 or the F-1-14 housing ratio ≤40%. */
export interface ContributionFacts { readonly housing_ratio_pct?: string | number | null; readonly brp_complete?: boolean; readonly pcs_servicemember?: boolean; readonly prohibited_by_law?: boolean; }
export interface Contribution { readonly evaluated: boolean; readonly required: boolean; readonly request_cents: Cents; readonly basis: string; }
export function contribution(reservesCents: Cents, pitiCents: Cents, deficiencyCents: Cents, facts: ContributionFacts = {}): Contribution {
  if (facts.prohibited_by_law) return { evaluated: false, required: false, request_cents: 0n, basis: "not evaluated: contribution prohibited by law (D2-3.3-01)" };
  if (facts.brp_complete === false) return { evaluated: false, required: false, request_cents: 0n, basis: "not evaluated: no complete BRP (D2-3.3-01)" };
  if (facts.pcs_servicemember) return { evaluated: false, required: false, request_cents: 0n, basis: "not evaluated: PCS servicemember >50 miles, principal residence (D2-3.3-01)" };
  const ratio = facts.housing_ratio_pct === undefined || facts.housing_ratio_pct === null || facts.housing_ratio_pct === "" ? null : Number(facts.housing_ratio_pct);
  const reservesTrigger = reservesCents > 1_000_000n; const ratioTrigger = ratio !== null && ratio <= 40;
  if (!reservesTrigger && !ratioTrigger) return { evaluated: true, required: false, request_cents: 0n, basis: ratio === null ? "reserves ≤ $10,000 and no housing ratio supplied (D2-3.3-01)" : `reserves ≤ $10,000 and housing ratio ${ratio.toFixed(2)}% > 40% (D2-3.3-01)` };
  const raw = [divRound(reservesCents * 20n, 100n, "HALF_UP"), 4n * pitiCents].reduce((a, b) => (b > a ? b : a));   // greater of 20% × reserves and 4 × PITI
  let req = divRound(raw, 10_000n, "HALF_UP") * 10_000n; if (req > deficiencyCents) req = deficiencyCents;   // nearest $100 (half-up), capped at the deficiency
  const trigger = reservesTrigger ? "reserves > $10,000" : `housing ratio ${ratio!.toFixed(2)}% ≤ 40%`;
  return req < 50_000n ? { evaluated: true, required: false, request_cents: 0n, basis: `${trigger}; request ${req} cents < $500 → waived (D2-3.3-01)` } : { evaluated: true, required: true, request_cents: req, basis: `${trigger} (D2-3.3-01)` };
}
export function negotiated(requestCents: Cents, offerCents: Cents): "accepted" | "fnma_referral" { return offerCents * 2n >= requestCents ? "accepted" : "fnma_referral"; }
export function relocation(contributionRequired: boolean, thirdPartyAssistance: Cents, remediationEstimate = 0n): Cents { if (contributionRequired) return 0n; const r = 750_000n - thirdPartyAssistance - remediationEstimate; return r > 0n ? r : 0n; }
export function netProceeds(price: Cents, costs: { commission: Cents; prorations: Cents; transfer_taxes: Cents; title_settlement: Cents; seller_attorney: Cents; hoa_past_due: Cents; subordinate_liens: Cents; relocation: Cents }): { net_cents: Cents; commission_ok: boolean; subordinate_ok: boolean } {
  const total = Object.values(costs).reduce((a, b) => a + b, 0n);
  return { net_cents: price - total, commission_ok: costs.commission * 100n <= price * 6n, subordinate_ok: costs.subordinate_liens <= 600_000n };
}
export function shortSaleClocks(offerOn: PlainDate, approvalOn?: PlainDate): { ack_by: PlainDate; decision_by: PlainDate; close_by: PlainDate | null } { return { ack_by: addBusinessDays(offerOn, 5, servicer), decision_by: addDays(offerOn, 30), close_by: approvalOn ? addDays(approvalOn, 60) : null }; }
/** D2-3.3-01: active MLS status for at least 5 consecutive calendar days *including a Saturday and a Sunday* before an offer is reviewed. */
export function listingRule(activeFrom: PlainDate, asOf: PlainDate): { consecutive_days: number; includes_saturday: boolean; includes_sunday: boolean; met: boolean } {
  const days = asOf < activeFrom ? 0 : daysBetween(activeFrom, asOf) + 1;
  let sat = false, sun = false;
  for (let k = 0; k < days; k++) { const w = dayOfWeek(addDays(activeFrom, k)); if (w === 6) sat = true; if (w === 0) sun = true; }
  return { consecutive_days: days, includes_saturday: sat, includes_sunday: sun, met: days >= 5 && sat && sun };
}
export function listingRuleMet(activeFrom: PlainDate, asOf: PlainDate): boolean { return listingRule(activeFrom, asOf).met; }
export function dilClocks(acceptanceOn: PlainDate): { documents_by: PlainDate; extended_by: PlainDate } { return { documents_by: addDays(acceptanceOn, 60), extended_by: addDays(acceptanceOn, 90) }; }
export function deedTiming(deedReceivedOn: PlainDate, saleOn: PlainDate): "allowed" | "fnma_prior_approval" { return daysBetween(deedReceivedOn, saleOn) >= 30 ? "allowed" : "fnma_prior_approval"; }
export function incentive(daysDelinquentAtClosing: number): Cents { return daysDelinquentAtClosing <= 210 ? 250_000n : daysDelinquentAtClosing <= 300 ? 150_000n : 75_000n; }   // tiers [UNVERIFIED boundaries]
export function leaseOption(kind: "12_month" | "3_month", inChapter13: boolean, principalResidence: boolean): boolean { return kind === "3_month" ? principalResidence : !inChapter13; }
