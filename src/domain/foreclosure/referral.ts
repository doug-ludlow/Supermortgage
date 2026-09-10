/** §13.3 Referral and §13.4 Prereferral review — windows, gate check, reinstatement quote, bid, third-party surplus. */
import type { Cents } from "../../kernel/money/cents.ts";
import { Decimal, divRound } from "../../kernel/money/decimal.ts";
import { type PlainDate, addDays, daysBetween } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";

export function reviewWindow(earliestUnpaidDue: PlainDate, principalResidence: boolean): { opens: PlainDate; referral_on: PlainDate; rule: "refer_by" | "refer_no_earlier_than" } {
  return principalResidence ? { opens: addDays(earliestUnpaidDue, 106), referral_on: addDays(earliestUnpaidDue, 121), rule: "refer_no_earlier_than" } : { opens: addDays(earliestUnpaidDue, 105), referral_on: addDays(earliestUnpaidDue, 120), rule: "refer_by" };
}
export function reviewValid(completedOn: PlainDate, w: ReturnType<typeof reviewWindow>): boolean { return completedOn >= w.opens && completedOn <= w.referral_on; }
export interface Gates { regx_120: boolean; regx_prefiling: boolean; no_first_filing_41k2: boolean; fnma_121: boolean; bk_stay: boolean; scra: boolean; dmdc_age_days: number; disaster_approval: boolean; litigation_hold: boolean; environmental_hold: boolean; mn_dual_track: boolean; title_hold: boolean; package_ready: boolean; }
export function referralEligible(review: "refer" | "hold_lossmit" | "hold_disaster_approval" | "hold_scra" | "hold_bankruptcy" | "postpone_e3204", g: Gates): { ok: boolean; blocked_by: string[] } {
  const b: string[] = [];
  if (review !== "refer") b.push(`review:${review}`);
  for (const [k, v] of Object.entries(g)) { if (k === "dmdc_age_days") { if ((v as number) > 30) b.push("SCRA_DMDC_STALE_30"); } else if (k.endsWith("_hold") || k === "scra" || k === "bk_stay" || k === "mn_dual_track") { if (v) b.push(k); } else if (!v) b.push(k); }
  return { ok: b.length === 0, blocked_by: b };
}
export function reviewOutcome(f: { items_all_pass: boolean; pr_prohibition_failing: boolean; disaster_impacted: boolean; nonpr_complete_brp: boolean; scra_active: boolean; bk_hit: boolean }): "refer" | "hold_lossmit" | "hold_disaster_approval" | "hold_scra" | "hold_bankruptcy" | "postpone_e3204" {
  if (f.bk_hit) return "hold_bankruptcy"; if (f.scra_active) return "hold_scra"; if (f.pr_prohibition_failing) return "hold_lossmit"; if (f.disaster_impacted) return "hold_disaster_approval"; if (f.nonpr_complete_brp) return "postpone_e3204"; return f.items_all_pass ? "refer" : "hold_lossmit";
}
export function reinstatementQuote(q: { delinquent_pi_cents: Cents; late_charges_cents: Cents; escrow_advances_cents: Cents; corporate_advances_cents: Cents; attorney_fees_cents: Cents; costs_cents: Cents; suppress_late_charges?: boolean }): Cents { return q.delinquent_pi_cents + (q.suppress_late_charges ? 0n : q.late_charges_cents) + q.escrow_advances_cents + q.corporate_advances_cents + q.attorney_fees_cents + q.costs_cents; }
/** E-3.3-05 total indebtedness with actual/365 interest from the LPI due date to the sale date, rounded once. */
export function totalIndebtedness(b: { upb_cents: Cents; note_rate_pct: string; lpi_due: PlainDate; sale_on: PlainDate; escrow_advances_cents: Cents; corporate_advances_cents: Cents; attorney_fees_cents: Cents; costs_cents: Cents; late_charges_cents?: Cents; insurance_claims_cents?: Cents }): { days: number; interest_cents: Cents; total_cents: Cents } {
  const days = daysBetween(b.lpi_due, b.sale_on);
  const interest = divRound(b.upb_cents * Decimal.parse(b.note_rate_pct).unscaled * BigInt(days), 100n * 365n * Decimal.ONE.unscaled, "HALF_UP");
  return { days, interest_cents: interest, total_cents: b.upb_cents + interest + b.escrow_advances_cents + b.corporate_advances_cents + b.attorney_fees_cents + b.costs_cents + (b.late_charges_cents ?? 0n) - (b.insurance_claims_cents ?? 0n) };
}
/** E-3.3-05 bid = lesser of the reserve price and total indebtedness. 13.3 guardrail: a bid below total indebtedness is refused unless it rests on an *unexpired* reserve price — pass the reserve's expiry and the sale date to enforce it (an expired reserve falls back to indebtedness through `13.3 reserveFallback`, never to a lower bid). */
export function bid(totalIndebtednessCents: Cents, reservePriceCents: Cents | null, transferTaxNoExemption = false, reserve: { expires_on: PlainDate | null; sale_on: PlainDate } | null = null): { opening_bid_cents: Cents; max_bid_cents: Cents; basis: "reserve" | "indebtedness" } {
  const belowIndebtedness = reservePriceCents !== null && reservePriceCents < totalIndebtednessCents;
  if (belowIndebtedness && reserve && (reserve.expires_on === null || reserve.expires_on < reserve.sale_on)) throw new RangeError(`bid below total indebtedness refused: the reserve price ${reservePriceCents} ${reserve.expires_on === null ? "carries no expiry" : `expired ${reserve.expires_on}`} before the sale on ${reserve.sale_on} — refresh it or bid total indebtedness (13.3 guardrail; E-3.3-05)`);
  const max = belowIndebtedness ? reservePriceCents : totalIndebtednessCents;
  return { opening_bid_cents: transferTaxNoExemption ? 10_000n : max, max_bid_cents: max, basis: belowIndebtedness ? "reserve" : "indebtedness" };
}
export function thirdPartySale(winningBid: Cents, totalIndebtedness: Cents): { surplus_cents: Cents; shortfall_cents: Cents } { const d = winningBid - totalIndebtedness; return { surplus_cents: d > 0n ? d : 0n, shortfall_cents: d < 0n ? -d : 0n }; }
export function firmDocumentSla(requestedOn: PlainDate): PlainDate { return addBusinessDays(requestedOn, 3, servicer); }
export function firmAckDue(referralOn: PlainDate): PlainDate { return addBusinessDays(referralOn, 2, servicer); }
