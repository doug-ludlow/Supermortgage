/** §12.1 Acknowledge loss-mit application — classification, 45-day test, completeness, reasonable date, duplicative test. */
import { type PlainDate, addDays } from "../../kernel/calendar/date.ts";
import { addBusinessDays, federal, servicer } from "../../kernel/calendar/business.ts";
import { zonedEpochMs } from "../../kernel/calendar/zoned.ts";

export function classify(c: { has_evaluative_info: boolean; confidence: number }): "application" | "rfa_only" { return c.has_evaluative_info || c.confidence < 0.8 ? "application" : "rfa_only"; }
export function ackDue(receivedOn: PlainDate, loanTz = "America/New_York"): { due_on: PlainDate; due_at_ms: number } { const d = addBusinessDays(receivedOn, 5, federal); return { due_on: d, due_at_ms: zonedEpochMs(d, "23:59", loanTz) }; }
/** §1024.41(b)(2) applies only when received > 45 days before a scheduled sale; otherwise D2-2-05 plan notice within 5 servicer BD. */
export function fortyFiveDayTest(receivedOn: PlainDate, saleOn: PlainDate | null): { b2_applies: boolean; d2205_notice_due: PlainDate | null } {
  if (saleOn && receivedOn > addDays(saleOn, -45)) return { b2_applies: false, d2205_notice_due: addBusinessDays(receivedOn, 5, servicer) };
  return { b2_applies: true, d2205_notice_due: null };
}
export interface ReasonableDateInputs { readonly ack_sent_on: PlainDate; readonly earliest_unpaid_due: PlainDate | null; readonly sale_on: PlainDate | null; readonly oldest_doc_date: PlainDate | null; }
export function reasonableDate(i: ReasonableDateInputs): { date: PlainDate; basis: string; milestone_conflict: boolean } {
  const caps: [PlainDate, string][] = [[addDays(i.ack_sent_on, 30), "ack+30"]];
  if (i.earliest_unpaid_due) caps.push([addDays(i.earliest_unpaid_due, 119), "day_120_of_delinquency"]);
  if (i.sale_on) { caps.push([addDays(i.sale_on, -90), "sale-90"]); caps.push([addDays(i.sale_on, -38), "sale-38"]); }
  if (i.oldest_doc_date) caps.push([addDays(i.oldest_doc_date, 90), "doc_staleness_90"]);
  // Milestones already behind the acknowledgment date have passed and cannot cap; only future milestones do.
  const live = caps.filter((c) => c[0] >= i.ack_sent_on);
  const [earliest, basis] = (live.length ? live : caps).reduce((a, b) => (b[0] < a[0] ? b : a));
  const floor = addDays(i.ack_sent_on, 7);
  if (earliest < floor) return { date: floor, basis: `floor ack+7 (cap ${basis} earlier)`, milestone_conflict: true };
  return { date: earliest, basis, milestone_conflict: false };
}
export interface Requirement { readonly item: string; readonly source: "borrower" | "third_party"; status: "missing" | "received" | "verified" | "stale"; }
export function completeness(reqs: readonly Requirement[]): { complete: boolean; missing: string[] } { const m = reqs.filter((r) => r.source === "borrower" && (r.status === "missing" || r.status === "stale")).map((r) => r.item); return { complete: m.length === 0, missing: m }; }
export function duplicative(f: { prior_complete_by_us: boolean; prior_fully_processed: boolean; current_since_prior: boolean }): boolean { return f.prior_complete_by_us && f.prior_fully_processed && !f.current_since_prior; }
export function supplementalRequestDate(facialOn: PlainDate): PlainDate { return addDays(facialOn, 7); }
