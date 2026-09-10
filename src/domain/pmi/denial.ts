/** 10.6 Denial notice — due date prongs, content numbers, renewal date, dispute routing. */
import { type PlainDate, addDays, addMonths } from "../../kernel/calendar/date.ts";
import { type Calendar, addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { formatCents } from "../../kernel/money/cents.ts";
import { bpsToPercent } from "./cancellation.ts";

/** R1 — min over the applicable prongs. */
export function denialDue(i: { received_on: PlainDate | null; evidence_satisfied_on: PlainDate | null; scheduled_termination_on: PlainDate | null; state: string }): PlainDate {
  const prongs: PlainDate[] = [];
  if (i.received_on !== null) {
    const anchor = i.evidence_satisfied_on !== null && i.evidence_satisfied_on > i.received_on ? i.evidence_satisfied_on : i.received_on;
    prongs.push(addDays(anchor, 30));
    if (i.state === "MN") prongs.push(addDays(i.received_on, 30));
  }
  if (i.scheduled_termination_on !== null) prongs.push(addDays(i.scheduled_termination_on, 30));
  if (prongs.length === 0) throw new Error("no denial prong applies");
  return prongs.reduce((a, b) => (b < a ? b : a));
}

export interface LtvDenialContent { readonly evaluation_upb: string; readonly value: string; readonly ltv_percent: string; readonly threshold_percent: string; readonly balance_needed: string; readonly scheduled_80_date: PlainDate | null; readonly current_value_fee: string; }

export function ltvDenialContent(i: { evaluation_upb_cents: Cents; value_cents: Cents; ltv_bps: number; threshold_bps: number; scheduled_80_date: PlainDate | null }): LtvDenialContent {
  const needed = (i.value_cents * BigInt(i.threshold_bps)) / 10000n;
  return {
    evaluation_upb: formatCents(i.evaluation_upb_cents, { symbol: true, grouping: true }), value: formatCents(i.value_cents, { symbol: true, grouping: true }),
    ltv_percent: `${bpsToPercent(i.ltv_bps)}%`, threshold_percent: `${bpsToPercent(i.threshold_bps)}%`,
    balance_needed: formatCents(needed, { symbol: true, grouping: true }), scheduled_80_date: i.scheduled_80_date, current_value_fee: "$190",
  };
}

/** Payment-history denial: renewal date once the late installment ages out (spec worked example anchors on paid date + 12 months + 1 day). */
export function historyRenewalDate(paidOn: PlainDate): PlainDate { return addDays(addMonths(paidOn, 12), 1); }

/** Valuation denial: appeal window 60 days (only when the valuation did not support termination), validity 120 days. */
export function valuationDenialWindows(deliveredOn: PlainDate): { appeal_by: PlainDate; valid_until: PlainDate } { return { appeal_by: addDays(deliveredOn, 60), valid_until: addDays(deliveredOn, 120) }; }

export type DisputeRoute = "noe" | "smdu_appeal" | "human_review";
export function disputeRoute(i: { asserts_error: boolean; valuation_disagreement: boolean; requests_human: boolean }): DisputeRoute[] {
  const out: DisputeRoute[] = [];
  if (i.asserts_error) out.push("noe");
  if (i.valuation_disagreement) out.push("smdu_appeal");
  if (i.requests_human) out.push("human_review");
  return out;
}
export function humanReviewDue(requestedOn: PlainDate, cal: Calendar = servicer): PlainDate { return addBusinessDays(requestedOn, 10, cal); }
export function noeAckDue(receivedOn: PlainDate, cal: Calendar = servicer): PlainDate { return addBusinessDays(receivedOn, 5, cal); }

/** 10.6-T9 — a denial must link an evaluation row. */
export function denialSendAllowed(evaluationId: string | null): boolean { return evaluationId !== null; }

/** 10.6 R4 / T8 — a human-review reversal grants as of the date the borrower originally qualified and refunds every premium collected since (10.5). */
export function reversalGrant(i: { qualified_on: PlainDate; premiums_collected: readonly { on: PlainDate; amount_cents: Cents }[] }): { effective_on: PlainDate; refund_cents: Cents; refunded: readonly { on: PlainDate; amount_cents: Cents }[]; route: "10.1 finalization (R-F1…R-F6)"; refund_process: "10.5" } {
  const refunded = i.premiums_collected.filter((p) => p.on >= i.qualified_on);
  return { effective_on: i.qualified_on, refund_cents: refunded.reduce((a, p) => a + p.amount_cents, 0n), refunded, route: "10.1 finalization (R-F1…R-F6)", refund_process: "10.5" };
}
