/**
 * §3.5 process ops — the payoff-refund branch of the refund state machine: `payoff_posted` →
 * `final_disbursements_settled` → `scheduled`. Rule 1: "Payoff: refund_cents = escrow balance after posting the payoff
 * and after releasing/cancelling every scheduled disbursement whose due date is on/after the payoff date (bills due
 * before payoff and unpaid are paid first, since the lien-protection duty continues until release — Section 16.3)."
 * Timer `ESC_REFUND_FINAL_DISBURSEMENT_HOLD_5BD` (not_before_gate, `loan.paid_in_full` + 5 business_days_servicer) is
 * satisfied by "release of in-flight tax/insurance disbursements or their cancellation" — the
 * `escrow.final_disbursements.settled` fact `settleFinalDisbursements` appends — and its breach column is "refund
 * waits for settlement of in-flight items but never beyond the 20-BD deadline" (`REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD`).
 * The 3.5 `issueRefund` tool (src/app/tools/section03.ts) runs these for `kind=payoff_refund`; the agent never
 * computes the amount.
 */
import type { Cents } from "../../kernel/money/cents.ts";
import { type PlainDate, plainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import type { Actor, EventStore } from "../../kernel/events/index.ts";
import type { DisbursementStatus } from "./ops.ts";
import { payoffRefundDue } from "./refund.ts";

export const FINAL_DISBURSEMENT_HOLD_SERVICER_BD = 5;
export const FINAL_DISBURSEMENTS_SETTLED = "escrow.final_disbursements.settled" as const;

/** A scheduled tax/insurance disbursement still open when the payoff posts (3.7 `disbursements` row, the fields the hold reads). */
export interface InFlightDisbursement { readonly id: string; readonly kind: "tax" | "insurance" | "mi" | "other"; readonly amount_cents: Cents; readonly due_on: PlainDate; readonly status: DisbursementStatus }

/** Cash has left (or is leaving) the custodial account: the item reduces the refundable balance. */
export const PAID_STATUSES: ReadonlySet<DisbursementStatus> = new Set<DisbursementStatus>(["released", "sent", "confirmed"]);
/** Settled for the hold: paid, or cancelled (only an item due on/after the payoff date may be cancelled — rule 1). */
export const SETTLED_STATUSES: ReadonlySet<DisbursementStatus> = new Set<DisbursementStatus>([...PAID_STATUSES, "cancelled"]);

/** Parse the agent's `in_flight` input (unknown JSON) into validated rows; throws RangeError on a malformed row. */
export function inFlight(raw: unknown): InFlightDisbursement[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new RangeError("in_flight must be an array of disbursements");
  return raw.map((x, n) => {
    const o = (x ?? {}) as Record<string, unknown>;
    const id = String(o.id ?? ""); if (!id) throw new RangeError(`in_flight[${n}]: id is required`);
    const kind = String(o.kind ?? "other"); if (!["tax", "insurance", "mi", "other"].includes(kind)) throw new RangeError(`in_flight[${n}]: kind ${kind} is not tax|insurance|mi|other`);
    const amount = typeof o.amount_cents === "bigint" ? o.amount_cents : BigInt(String(o.amount_cents ?? "0")); if (amount <= 0n) throw new RangeError(`in_flight[${n}]: amount_cents must be positive`);
    const status = String(o.status ?? "scheduled") as DisbursementStatus;
    return { id, kind: kind as InFlightDisbursement["kind"], amount_cents: amount, due_on: plainDate(String(o.due_on ?? "")), status };
  });
}

/** Rule 1: an item due on/after the payoff date is settled when released or cancelled; a bill due before payoff must be paid (never cancelled). */
export function unsettledItems(payoffDate: PlainDate, items: readonly InFlightDisbursement[]): InFlightDisbursement[] {
  return items.filter((d) => (d.due_on >= payoffDate ? !SETTLED_STATUSES.has(d.status) : !PAID_STATUSES.has(d.status)));
}

/** Rule 1: refund = escrow balance after the payoff posting − every in-flight item that was paid (cancelled items stay in the balance). */
export function payoffRefundCents(balanceAfterPayoffCents: Cents, items: readonly InFlightDisbursement[]): Cents {
  const paid = items.filter((d) => PAID_STATUSES.has(d.status)).reduce((s, d) => s + d.amount_cents, 0n);
  const refund = balanceAfterPayoffCents - paid;
  if (refund < 0n) throw new RangeError(`escrow balance ${balanceAfterPayoffCents} cents is short of the ${paid} cents of in-flight disbursements: advance and bill the borrower (Section 16), do not refund`);
  return refund;
}

export interface FinalDisbursementHold {
  /** payoff posting date + 5 business_days_servicer — the not_before window of the policy gate. */
  readonly gate_opens_on: PlainDate;
  /** §1024.34(b): payoff posting date + 20 days excluding Saturdays, Sundays and federal legal public holidays. */
  readonly must_issue_by: PlainDate;
  readonly unsettled: string[];
  readonly settled: boolean;
  readonly hold_elapsed: boolean;
  /** Settled, or the 20-BD deadline is here ("never beyond the 20-BD deadline"). */
  readonly refund_may_issue: boolean;
  readonly reason: "settled" | "deadline" | "waiting";
}

/** ESC_REFUND_FINAL_DISBURSEMENT_HOLD_5BD as a decision: may the payoff refund issue today? */
export function finalDisbursementHold(f: { payoff_date: PlainDate; today: PlainDate; in_flight: readonly InFlightDisbursement[] }): FinalDisbursementHold {
  const unsettled = unsettledItems(f.payoff_date, f.in_flight).map((d) => d.id);
  const settled = unsettled.length === 0;
  const gateOpens = addBusinessDays(f.payoff_date, FINAL_DISBURSEMENT_HOLD_SERVICER_BD, servicer);
  const mustIssueBy = payoffRefundDue(f.payoff_date);
  const deadline = f.today >= mustIssueBy;
  return { gate_opens_on: gateOpens, must_issue_by: mustIssueBy, unsettled, settled, hold_elapsed: f.today >= gateOpens, refund_may_issue: settled || deadline, reason: settled ? "settled" : deadline ? "deadline" : "waiting" };
}

export interface FinalDisbursementsSettled {
  readonly event_type: typeof FINAL_DISBURSEMENTS_SETTLED | null;
  readonly refund_cents: Cents;
  readonly released: string[];
  readonly cancelled: string[];
  readonly hold: FinalDisbursementHold;
  /** True when the 20-BD deadline forced the refund past still-open items: nothing is settled, so no fact is appended. */
  readonly forced_by_deadline: boolean;
}

/**
 * `payoff_posted` → `final_disbursements_settled`: validates that every in-flight item is released/paid or cancelled
 * per rule 1, computes the engine's refund, and appends `escrow.final_disbursements.settled` (the gate's satisfying
 * event) with the settled items and the refund. Still-open items before the 20-BD deadline throw (the refund waits);
 * on/after the deadline the refund proceeds without the fact (breach column: "never beyond the 20-BD deadline").
 */
export function settleFinalDisbursements(events: EventStore, f: { loan_id: string; payoff_date: PlainDate; today: PlainDate; escrow_balance_after_payoff_cents: Cents; in_flight: readonly InFlightDisbursement[]; actor: Actor }): FinalDisbursementsSettled {
  if (!f.loan_id) throw new RangeError("loan_id is required");
  if (f.escrow_balance_after_payoff_cents < 0n) throw new RangeError("escrow balance after payoff cannot be negative");
  const hold = finalDisbursementHold({ payoff_date: f.payoff_date, today: f.today, in_flight: f.in_flight });
  if (!hold.refund_may_issue) throw new RangeError(`payoff refund waits for in-flight disbursements ${hold.unsettled.join(", ")} to be released or cancelled (ESC_REFUND_FINAL_DISBURSEMENT_HOLD_5BD; must issue by ${hold.must_issue_by})`);
  const refund = payoffRefundCents(f.escrow_balance_after_payoff_cents, f.in_flight);
  const released = f.in_flight.filter((d) => PAID_STATUSES.has(d.status)).map((d) => d.id);
  const cancelled = f.in_flight.filter((d) => d.status === "cancelled").map((d) => d.id);
  if (!hold.settled) return { event_type: null, refund_cents: refund, released, cancelled, hold, forced_by_deadline: true };
  events.append({ type: FINAL_DISBURSEMENTS_SETTLED, loanId: f.loan_id, actor: f.actor, payload: {
    payoff_date: f.payoff_date, settled_on: f.today, gate_opens_on: hold.gate_opens_on, must_issue_by: hold.must_issue_by,
    released, cancelled, in_flight_count: f.in_flight.length,
    escrow_balance_after_payoff_cents: String(f.escrow_balance_after_payoff_cents), released_cents: String(f.escrow_balance_after_payoff_cents - refund), refund_cents: String(refund),
  } });
  return { event_type: FINAL_DISBURSEMENTS_SETTLED, refund_cents: refund, released, cancelled, hold, forced_by_deadline: false };
}
