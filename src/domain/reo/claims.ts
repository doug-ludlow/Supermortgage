/** 15.2 Expense reimbursement (571) — line validation, deadlines, credits, follow-on clocks. */
import { type PlainDate, addDays, daysBetween } from "../../kernel/calendar/date.ts";
import { type Calendar, addBusinessDays, fannieEt } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { Decimal } from "../../kernel/money/decimal.ts";

export type LineKind = "taxes" | "hazard" | "flood" | "mi_premium" | "inspection" | "preservation" | "attorney_fee" | "attorney_cost" | "technology" | "einvoice" | "hoa" | "mortgage_release_doc" | "registration" | "code_violation" | "delinquency_pi" | "delinquency_interest_sa" | "overhead";

export interface ClaimLine {
  readonly kind: LineKind; readonly unit_cents: Cents; readonly quantity: number; readonly paid_on: PlainDate | null; readonly invoice: boolean;
  readonly approval_id?: string | null; readonly milestone_pct?: number; readonly inspection_type?: "curbside" | "exterior" | "interior";
  readonly service_date?: PlainDate; readonly hometracker_bid_id?: string | null; readonly cause?: "servicer" | "other";
}
export interface ClaimContext { readonly event_date: PlainDate; readonly state: string; readonly attorney_fee_exhibit_cents: Cents; readonly servicing_option: "special" | "regular_mbs" | "portfolio"; readonly reclassified?: boolean; readonly preservation_cap_cents?: Cents; }

export interface LineValidation { readonly ok: boolean; readonly amount_cents: Cents; readonly messages: readonly string[]; readonly allowable_code: string; readonly cap_cents: Cents | null; }

const INSPECTION_CAPS = { curbside: 3_000n, exterior: 4_500n, interior: 6_000n } as const;

/** Rules 1, 2, 4 and 15.4 rule 5. */
export function validateLine(l: ClaimLine, c: ClaimContext): LineValidation {
  const msgs: string[] = [];
  const amount = l.unit_cents * BigInt(l.quantity);
  let cap: Cents | null = null;
  let code: string = l.kind;
  if (!Number.isInteger(l.quantity) || l.quantity <= 0) msgs.push("quantity_not_integer");
  if (l.kind === "delinquency_pi" || l.kind === "delinquency_interest_sa") msgs.push("pi_advances_not_claimable");
  if (l.kind === "overhead") msgs.push("overhead_rejected");
  if (c.servicing_option === "regular_mbs" && !c.reclassified) msgs.push("ineligible_regular_servicing");
  if (l.paid_on === null) msgs.push("not_paid");
  if (!l.invoice) msgs.push("missing_invoice");
  switch (l.kind) {
    case "attorney_fee": {
      const pct = l.milestone_pct ?? 100;
      cap = Decimal.fromBigInt(c.attorney_fee_exhibit_cents).mul(Decimal.fromInt(pct)).div(Decimal.fromInt(100)).toScaledInt(0, "HALF_UP");
      if (amount > cap && !l.approval_id) msgs.push(`attorney_fee_over_exhibit cap=${cap}`);
      code = `attorney_fee_${c.state}_${pct}`;
      break;
    }
    case "technology": cap = 2_500n; if (amount > cap) msgs.push("technology_fee_over_cap"); break;
    case "einvoice": cap = 500n; if (l.unit_cents > cap) msgs.push("einvoice_over_cap"); break;
    case "inspection": cap = INSPECTION_CAPS[l.inspection_type ?? "exterior"]; if (l.unit_cents > cap) msgs.push("inspection_over_cap"); break;
    case "preservation": cap = c.preservation_cap_cents ?? null; if (cap !== null && amount > cap && !l.hometracker_bid_id) msgs.push("preservation_over_allowable"); break;
    case "hazard": case "flood": case "hoa":
      if (l.paid_on !== null && l.paid_on > addDays(c.event_date, 14)) msgs.push("post_sale_nonreimbursable");
      if (l.kind === "hoa" && l.cause === "servicer") msgs.push("hoa_penalties_servicer_caused");
      break;
    case "taxes": if (l.cause === "servicer") msgs.push("tax_penalties_servicer_caused"); break;
    case "mortgage_release_doc": cap = 65_000n; if (amount > cap) msgs.push("doc_prep_over_cap"); break;
    case "code_violation": cap = 100_000n; if (l.unit_cents > cap) msgs.push("code_violation_over_cap"); break;
    default: break;
  }
  return { ok: msgs.length === 0, amount_cents: amount, messages: msgs, allowable_code: code, cap_cents: cap };
}

/** Rule 3 — final_due_at = min(milestone + 60, F-1-06 + 30 if MI-insured); uninsured REO waits for disposition (policy: file at sale + 60). */
export function finalDueAt(i: { event_date: PlainDate; mi_insured: boolean; disposition_date: PlainDate | null; kind: "reo" | "tps" | "short_sale" | "mortgage_release" | "workout" }): { final_due: PlainDate | null; policy_due: PlainDate; internal_target: PlainDate } {
  const policy = addDays(i.event_date, 60);
  const cands: PlainDate[] = [];
  if (i.mi_insured) cands.push(addDays(i.event_date, 30));
  if (i.kind !== "reo") cands.push(policy);
  else if (i.disposition_date !== null) cands.push(addDays(i.disposition_date, 60));
  const final = cands.length === 0 ? null : cands.reduce((a, b) => (b < a ? b : a));
  return { final_due: final, policy_due: policy, internal_target: addDays(i.event_date, 20) };
}

/** Rule 7/9 — unearned hazard premium credit for the remaining term (166/365 × $1,450 = $659.45). */
export function unearnedPremiumCredit(premium: Cents, termStart: PlainDate, termEnd: PlainDate, eventDate: PlainDate): Cents {
  const remaining = Math.max(0, daysBetween(addDays(eventDate, 1), termEnd));   // event day is earned
  void termStart;                                                                // annual premiums prorate over 365 per the F-1-05 worked example
  return Decimal.fromBigInt(premium).mul(Decimal.fromInt(remaining)).div(Decimal.fromInt(365)).toScaledInt(0, "HALF_UP");
}

export function claimTotals(lines: readonly LineValidation[], credits: readonly Cents[]): { gross_cents: Cents; credits_cents: Cents; net_cents: Cents; blocked: number } {
  const ok = lines.filter((l) => l.ok);
  const gross = ok.reduce((s, l) => s + l.amount_cents, 0n);
  const cr = credits.reduce((s, c) => s + c, 0n);
  return { gross_cents: gross, credits_cents: cr, net_cents: gross - cr, blocked: lines.length - ok.length };
}

/** Rule 7 — refunds received after payment are remitted: 318 hazard, 336 MI within 30 days, 571 other. */
export function postPaymentRefund(kind: "hazard" | "mi" | "other", receivedOn: PlainDate): { code: "318" | "336" | "571"; due: PlainDate } {
  return { code: kind === "hazard" ? "318" : kind === "mi" ? "336" : "571", due: addDays(receivedOn, 30) };
}
/** Rule 8 — recovered advances repaid within 60 days via CRS 353 (352 for payoff/repurchase). */
export function recoveryRepayment(completionOn: PlainDate, source: "borrower_reinstatement" | "payoff" | "repurchase"): { code: "353" | "352"; due: PlainDate } {
  return { code: source === "borrower_reinstatement" ? "353" : "352", due: addDays(completionOn, 60) };
}
export function psaClocks(enteredOn: PlainDate): { internal_due: PlainDate; response_due: PlainDate } { return { internal_due: addDays(enteredOn, 10), response_due: addDays(enteredOn, 60) }; }
export function achExpected(paidOn: PlainDate, cal: Calendar = fannieEt): { expected: PlainDate; escalate_after: PlainDate } { return { expected: addBusinessDays(paidOn, 3, cal), escalate_after: addBusinessDays(paidOn, 5, cal) }; }
export function irtClocks(deniedOn: PlainDate, fnmaResponseOn: PlainDate | null, cal: Calendar = fannieEt): { inquiry_due: PlainDate; reply_due: PlainDate | null } {
  return { inquiry_due: addBusinessDays(deniedOn, 5, cal), reply_due: fnmaResponseOn === null ? null : addDays(fnmaResponseOn, 7) };
}
export function denialTriage(reason: "missing_invoice" | "wrong_subtype" | "over_allowable" | "late_claim" | "late_claim_fnma_outage"): "irt_inquiry" | "write_off" | "dispute_with_outage_evidence" {
  if (reason === "missing_invoice" || reason === "wrong_subtype") return "irt_inquiry";
  if (reason === "late_claim_fnma_outage") return "dispute_with_outage_evidence";
  return "write_off";
}
/** 15.2-T13 — attachments are screened for PII before packaging. */
export function attachmentContainsSsn(text: string): boolean { return /\b\d{3}-\d{2}-\d{4}\b/.test(text); }
