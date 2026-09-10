/** §13.6 Law-firm management — F-2-04 E&O tiers, Form 200 clock, E-5-05 milestone invoice review under the E-5-04 earning rule, transfers, escalations. */
import type { Cents } from "../../kernel/money/cents.ts";
import { divRound } from "../../kernel/money/decimal.ts";
import { type PlainDate, daysBetween } from "../../kernel/calendar/date.ts";
import { addBusinessDays, fannieEt, servicer } from "../../kernel/calendar/business.ts";

export type Method = "non_judicial" | "judicial";
export type EoTier = 1 | 2 | 3;
/** F-2-04 (10/11/2023): Tier I (0–4,499 foreclosures) $1M per occurrence / $3M aggregate; Tier II (4,500–19,999) $5M/$5M; Tier III (20,000+) $8M/$8M. */
export const EO_TIERS: Readonly<Record<EoTier, { readonly max_annual_foreclosures: number | null; readonly per_occurrence_cents: Cents; readonly aggregate_cents: Cents }>> = {
  1: { max_annual_foreclosures: 4_499, per_occurrence_cents: 100_000_000n, aggregate_cents: 300_000_000n },
  2: { max_annual_foreclosures: 19_999, per_occurrence_cents: 500_000_000n, aggregate_cents: 500_000_000n },
  3: { max_annual_foreclosures: null, per_occurrence_cents: 800_000_000n, aggregate_cents: 800_000_000n },
};
export function eoTierFor(annualForeclosures: number): EoTier { return annualForeclosures <= 4_499 ? 1 : annualForeclosures <= 19_999 ? 2 : 3; }
export function eoShortfalls(tier: EoTier, perOccurrenceCents: Cents, aggregateCents: Cents): string[] {
  const min = EO_TIERS[tier]; const out: string[] = [];
  if (perOccurrenceCents < min.per_occurrence_cents) out.push(`E&O per occurrence ${perOccurrenceCents} < Tier ${tier} minimum ${min.per_occurrence_cents} (F-2-04)`);
  if (aggregateCents < min.aggregate_cents) out.push(`E&O aggregate ${aggregateCents} < Tier ${tier} minimum ${min.aggregate_cents} (F-2-04)`);
  return out;
}
export function eoTierOk(tier: EoTier, perClaimCents: Cents, aggregateCents: Cents): boolean { return eoShortfalls(tier, perClaimCents, aggregateCents).length === 0; }
/** A4-2.2-01: "Within 15 business days following the submission of Form 200, Fannie Mae expects" to respond (fannie_et calendar). */
export function form200Expectation(submittedOn: PlainDate): PlainDate { return addBusinessDays(submittedOn, 15, fannieEt); }

/** E-5-05 (02/12/2020) milestone invoicing — cumulative percentage of the allowable fee earned at the last completed milestone; no proration between milestones. */
export const MILESTONES: Readonly<Record<Method, Readonly<Record<string, number>>>> = {
  judicial: { title_requested: 30, title_reviewed: 40, complaint_filed: 50, service_started: 60, service_complete: 70, affidavit_judgment_prepared: 80, judgment_to_court: 90, bid_confirmed: 95, sale_held: 100 },
  non_judicial: { title_requested: 30, title_reviewed: 65, notices_started: 75, first_legal: 85, sale_package: 95, sale_held: 100 },
};
/** E-5-04: "Full attorney fees cannot be considered to be earned until ... any post-sale confirmation or ratification proceedings ... have been completed" — the schedule's 100% step (sale held / documents recorded) is held at the prior 95% step until then. */
export const PRE_CONFIRMATION_CAP_PCT = 95;
export type Confirmation = "pending" | "completed" | "not_required";
export function milestonePct(method: Method, milestone: string): number {
  const table = MILESTONES[method]; if (!table) throw new RangeError(`${method} is not a foreclosure method (judicial/non_judicial)`);
  const pct = table[milestone]; if (pct === undefined) throw new RangeError(`${milestone} is not on the E-5-05 ${method} milestone schedule (${Object.keys(table).join(", ")})`);
  return pct;
}
/** Percentage earned at a milestone under E-5-05 with the E-5-04 confirmation rule; `confirmation` pseudo-milestone = sale held and confirmation/ratification completed. */
export function earnedPct(method: Method, milestone: string, confirmation: Confirmation = "pending"): number {
  if (milestone === "confirmation") return 100;
  const pct = milestonePct(method, milestone);
  return pct === 100 && confirmation === "pending" ? PRE_CONFIRMATION_CAP_PCT : pct;
}
export function feeEarned(method: Method, milestone: string, allowableCents: Cents, confirmation: Confirmation = "pending"): Cents { return divRound(allowableCents * BigInt(earnedPct(method, milestone, confirmation)), 100n, "HALF_UP"); }
/** E-5-06: technology fee ≤ $25 per loan for the life of the default; never charged to the borrower or the attorney. */
export const TECH_FEE_CAP_CENTS = 2_500n, OVERHEAD = new Set(["courier", "postage", "copies", "phone", "overhead", "travel", "notary"]);
export interface InvoiceReview { readonly fee_pct: number; readonly fee_earned_cents: Cents; readonly fee_approved_cents: Cents; readonly costs_approved_cents: Cents; readonly tech_fee_approved_cents: Cents; readonly borrower_chargeable_tech_fee_cents: 0n; readonly rejected: { kind: string; cents: Cents; reason: string }[]; readonly cites: string[] }
/** Rule 3: each fee line must match the state/method schedule at the last completed milestone (cumulative; no proration); costs itemized with receipts; overhead rejected; servicer-caused continuances non-reimbursable (E-3.2-05); technology fee capped. */
export function reviewInvoice(i: { method: Method; milestone: string; allowable_cents: Cents; previously_paid_cents: Cents; costs: { kind: string; cents: Cents; receipt: boolean }[]; tech_fee_cents?: Cents; continuance_caused_by_servicer?: boolean; fee_invoiced_cents?: Cents; confirmation?: Confirmation }): InvoiceReview {
  const rejected: { kind: string; cents: Cents; reason: string }[] = []; let costs = 0n; let pct = 0; let earned = 0n;
  try { pct = earnedPct(i.method, i.milestone, i.confirmation ?? "pending"); earned = divRound(i.allowable_cents * BigInt(pct), 100n, "HALF_UP"); }
  catch (e) { rejected.push({ kind: "fee_milestone", cents: i.fee_invoiced_cents ?? 0n, reason: (e as Error).message }); }
  const fee = earned - i.previously_paid_cents;
  if (i.fee_invoiced_cents !== undefined && fee > 0n && i.fee_invoiced_cents > fee) rejected.push({ kind: "fee_milestone", cents: i.fee_invoiced_cents - fee, reason: `fee line exceeds the ${pct}% cumulative schedule at ${i.milestone} less amounts paid (E-5-05; excess fees route to SF CPM)` });
  for (const c of i.costs) { if (OVERHEAD.has(c.kind)) rejected.push({ kind: c.kind, cents: c.cents, reason: "overhead" }); else if (!c.receipt) rejected.push({ kind: c.kind, cents: c.cents, reason: "no receipt" }); else if (c.kind === "continuance" && i.continuance_caused_by_servicer) rejected.push({ kind: c.kind, cents: c.cents, reason: "E-3.2-05 servicer-caused postponement" }); else costs += c.cents; }
  let tech = 0n;
  if (i.tech_fee_cents) { tech = i.tech_fee_cents > TECH_FEE_CAP_CENTS ? TECH_FEE_CAP_CENTS : i.tech_fee_cents; if (i.tech_fee_cents > TECH_FEE_CAP_CENTS) rejected.push({ kind: "technology_fee", cents: i.tech_fee_cents - TECH_FEE_CAP_CENTS, reason: "$25 cap" }); }
  return { fee_pct: pct, fee_earned_cents: earned, fee_approved_cents: fee > 0n ? fee : 0n, costs_approved_cents: costs, tech_fee_approved_cents: tech, borrower_chargeable_tech_fee_cents: 0n, rejected, cites: ["E-5-04", "E-5-05", ...(i.tech_fee_cents ? ["E-5-06"] : [])] };
}
/** A4-2.2-02: escalate within 2 business days of discovery, "or sooner if circumstances warrant" (same day for breaches/fraud). */
export function escalationDue(discoveredOn: PlainDate, sameDay = false): PlainDate { return sameDay ? discoveredOn : addBusinessDays(discoveredOn, 2, servicer); }
/** E-1.1-01: ≥30 transfers in 6 months from one firm to another in the same state need 5 BD notice. */
export function transferNoticeGate(transfersInSixMonths: number): boolean { return transfersInSixMonths >= 30; }
export function suspensionEffective(noticeOn: PlainDate): PlainDate { return addBusinessDays(noticeOn, 5, servicer); }
export function draEventLate(expectedOn: PlainDate, receivedOn: PlainDate | null, today: PlainDate): boolean { return receivedOn === null ? daysBetween(expectedOn, today) > 2 : Math.abs(daysBetween(expectedOn, receivedOn)) > 1; }
