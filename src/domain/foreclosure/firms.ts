/** §13.6 Law-firm management — E&O tiers, Form 200 clock, milestone invoice review, transfers, escalations. */
import type { Cents } from "../../kernel/money/cents.ts";
import { divRound } from "../../kernel/money/decimal.ts";
import { type PlainDate, daysBetween } from "../../kernel/calendar/date.ts";
import { addBusinessDays, fannieEt, servicer } from "../../kernel/calendar/business.ts";

export function eoTierOk(tier: 1 | 2 | 3, perClaimCents: Cents, aggregateCents: Cents): boolean { const min: Record<number, [Cents, Cents]> = { 1: [100_000_000n, 300_000_000n], 2: [100_000_000n, 200_000_000n], 3: [50_000_000n, 100_000_000n] }; const [p, a] = min[tier]!; return perClaimCents >= p && aggregateCents >= a; }
export function form200Expectation(submittedOn: PlainDate): PlainDate { return addBusinessDays(submittedOn, 15, fannieEt); }
export const MILESTONES: Record<"non_judicial" | "judicial", Record<string, number>> = { non_judicial: { referral: 0.25, first_legal: 0.85, sale_scheduled: 0.95, sale_held: 1.0 }, judicial: { referral: 0.25, first_legal: 0.5, service_complete: 0.7, judgment: 0.85, sale_held: 0.95, confirmation: 1.0 } };
export function feeEarned(method: "non_judicial" | "judicial", milestone: string, allowableCents: Cents): Cents { return divRound(allowableCents * BigInt(Math.round((MILESTONES[method][milestone] ?? 0) * 100)), 100n, "HALF_UP"); }
export const TECH_FEE_CAP_CENTS = 2_500n, OVERHEAD = new Set(["courier", "postage", "copies", "phone", "overhead"]);
export function reviewInvoice(i: { method: "non_judicial" | "judicial"; milestone: string; allowable_cents: Cents; previously_paid_cents: Cents; costs: { kind: string; cents: Cents; receipt: boolean }[]; tech_fee_cents?: Cents; continuance_caused_by_servicer?: boolean }): { fee_approved_cents: Cents; costs_approved_cents: Cents; rejected: { kind: string; cents: Cents; reason: string }[]; cites: string[] } {
  const earned = feeEarned(i.method, i.milestone, i.allowable_cents); const fee = earned - i.previously_paid_cents;
  const rejected: { kind: string; cents: Cents; reason: string }[] = []; let costs = 0n;
  for (const c of i.costs) { if (OVERHEAD.has(c.kind)) rejected.push({ kind: c.kind, cents: c.cents, reason: "overhead" }); else if (!c.receipt) rejected.push({ kind: c.kind, cents: c.cents, reason: "no receipt" }); else if (c.kind === "continuance" && i.continuance_caused_by_servicer) rejected.push({ kind: c.kind, cents: c.cents, reason: "E-3.2-05 servicer-caused postponement" }); else costs += c.cents; }
  if (i.tech_fee_cents && i.tech_fee_cents > TECH_FEE_CAP_CENTS) rejected.push({ kind: "technology_fee", cents: i.tech_fee_cents - TECH_FEE_CAP_CENTS, reason: "$25 cap" });
  return { fee_approved_cents: fee > 0n ? fee : 0n, costs_approved_cents: costs, rejected, cites: ["E-5-04", "E-5-05"] };
}
export function escalationDue(discoveredOn: PlainDate, sameDay = false): PlainDate { return sameDay ? discoveredOn : addBusinessDays(discoveredOn, 2, servicer); }
export function transferNoticeGate(transfersInSixMonths: number): boolean { return transfersInSixMonths >= 30; }
export function suspensionEffective(noticeOn: PlainDate): PlainDate { return addBusinessDays(noticeOn, 5, servicer); }
export function draEventLate(expectedOn: PlainDate, receivedOn: PlainDate | null, today: PlainDate): boolean { return receivedOn === null ? daysBetween(expectedOn, today) > 2 : Math.abs(daysBetween(expectedOn, receivedOn)) > 1; }
