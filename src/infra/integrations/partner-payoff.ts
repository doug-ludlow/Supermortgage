/**
 * §35.10 Integrations — the partner side of a monitored loan's payoff, FAKE in every build stage:
 *
 *   PartnerPayoffDemandPort   24.4's external-servicer channel (`payoff_demand`): the written demand goes to the partner as the
 *                             existing servicer and comes back as the partner's statement. `FakePartnerPayoffDemand` answers from the
 *                             partner's own tape terms (33.1 partner_book_facts: UPB, note rate, P&I, next due) with the partner's
 *                             arithmetic — the installments due through the statement date applied (monthly interest = UPB × rate ÷ 12,
 *                             principal = P&I − interest), the per diem rounded once for display, interest from the paid-through date
 *                             to but not including the good-through date (funds received that day) = days × the printed per diem —
 *                             worked example B's figures are this fake's. A refresh keeps the loan's remembered principal and paid-through
 *                             (the servicer does not assume the next installment) and extends the interest. `unavailable = true` is the
 *                             outage (T13): every request throws AdapterUnavailable.
 *   FakePartnerBookNotify     the outbox adapter `partner-book.notify` (rule 8): delivers each retirement notification into the FAKE
 *                             partner's inbox keyed by servicer loan number (33.1's FAKE tape generator can read it so the next tape
 *                             carries the loan as paid); `outage = true` makes the row stay `queued` under 35.1's retry.
 *
 * The money helpers are the kernel's (src/kernel/money) and 16.1's per diem (src/domain/payoff/quote.ts): the partner computes with the
 * platform's arithmetic, never a re-implementation of it.
 */
import { createHash } from "node:crypto";
import type { Cents } from "../../kernel/money/cents.ts";
import { monthlyInterest, ratePercent } from "../../kernel/money/cents.ts";
import { perDiem } from "../../domain/payoff/quote.ts";
import { addDays, addMonths, daysBetween, type PlainDate } from "../../kernel/calendar/date.ts";
import { AdapterUnavailable } from "./failures.ts";
import type { OutboundAdapter, OutboxMessage } from "./outbox.ts";

/** What the partner's servicing system knows about the loan (from the latest tape, 33.1). */
export interface PartnerLoanTerms { readonly servicer_loan_number: string; readonly upb_cents: Cents; readonly note_rate_pct: string; readonly pi_cents: Cents; readonly next_due_date: PlainDate; readonly as_of_date: PlainDate; readonly escrow_balance_cents: Cents | null; }
export interface PartnerStatementRequest { readonly servicer_party_id: string; readonly servicer_loan_number: string; readonly requested_on: PlainDate; readonly statement_date: PlainDate; readonly good_through: PlainDate; readonly refresh: boolean; readonly terms: PartnerLoanTerms; }
/** The partner's statement as 24.4 `parsePayoffStatement` reads it (the servicer's printed figures, never corrected). */
export interface PartnerStatement { readonly statement_document_id: string; readonly statement_date: PlainDate; readonly principal_cents: Cents; readonly rate_pct: string; readonly interest_paid_through: PlainDate; readonly per_diem_cents: Cents; readonly good_through_date: PlainDate; readonly interest_cents: Cents; readonly total_cents: Cents; readonly fees_cents: Cents; readonly escrow_balance_cents: Cents | null; readonly wire_instructions_document_id: string; readonly account_of_record_last4: string; readonly text: string; }
export interface PartnerPayoffDemandPort { readonly name: "payoff_demand"; statement(r: PartnerStatementRequest): Promise<PartnerStatement>; }

interface Remembered { principal: Cents; paid_through: PlainDate; }
export class FakePartnerPayoffDemand implements PartnerPayoffDemandPort {
  readonly name = "payoff_demand" as const;
  /** T13: the port is out; every request throws AdapterUnavailable until it is cleared. */
  unavailable = false;
  readonly requests: PartnerStatementRequest[] = [];
  private readonly memory = new Map<string, Remembered>();
  async statement(r: PartnerStatementRequest): Promise<PartnerStatement> {
    this.requests.push(r);
    if (this.unavailable) throw new AdapterUnavailable("payoff_demand", "partner_statement_manual", `payoff_demand unavailable: the partner's statement channel is out`);
    const key = `${r.servicer_party_id}:${r.servicer_loan_number}`;
    let m = this.memory.get(key);
    if (!m || !r.refresh) {
      // the installments due on or before the statement date are applied by the partner's servicing system: interest UPB × rate ÷ 12, principal = P&I − interest
      let principal = r.terms.upb_cents; let due = r.terms.next_due_date; const rate = ratePercent(r.terms.note_rate_pct);
      while (due <= r.statement_date) { const i = monthlyInterest(principal, rate); principal -= r.terms.pi_cents - i; due = addMonths(due, 1); }
      // interest is paid in arrears: the installment due on the 1st pays the prior month, so the loan is paid through the day before the last applied due date (worked example B: the October installment applied → paid through 2026-09-30, 29 days to 2026-10-30)
      m = { principal, paid_through: addDays(addMonths(due, -1), -1) }; this.memory.set(key, m);
    }
    const per_diem = perDiem(m.principal, r.terms.note_rate_pct);
    // interest from the day after the paid-through date to but not including the good-through date (F-1-09: funds received that day)
    const days = Math.max(0, daysBetween(addDays(m.paid_through, 1), r.good_through));
    const interest = BigInt(days) * per_diem;
    const total = m.principal + interest;
    const text = [`PAYOFF STATEMENT — ${r.servicer_loan_number}`, `Statement date ${r.statement_date}`, `Principal balance $${dollars(m.principal)}`, `Interest paid through ${m.paid_through}`, `Per diem $${dollars(per_diem)} (${r.terms.note_rate_pct}%)`, `Interest to ${r.good_through} (${days} days) $${dollars(interest)}`, `TOTAL DUE good through ${r.good_through}: $${dollars(total)}`, `After ${r.good_through} add $${dollars(per_diem)} per day`, `Escrow balance refunded under 12 CFR 1024.34(b) within 20 business days of payoff`, `Wire to the servicer's account of record ····4417 (instructions on file)`].join("\n");
    const sha = createHash("sha256").update(text).digest("hex");
    return { statement_document_id: `doc-partner-payoff-${sha.slice(0, 16)}`, statement_date: r.statement_date, principal_cents: m.principal, rate_pct: r.terms.note_rate_pct, interest_paid_through: m.paid_through, per_diem_cents: per_diem, good_through_date: r.good_through, interest_cents: interest, total_cents: total, fees_cents: 0n, escrow_balance_cents: r.terms.escrow_balance_cents, wire_instructions_document_id: `doc-partner-wire-${r.servicer_party_id.slice(0, 8)}`, account_of_record_last4: "4417", text };
  }
}
const dollars = (c: Cents): string => { const neg = c < 0n; const a = neg ? -c : c; const s = a.toString().padStart(3, "0"); return `${neg ? "-" : ""}${s.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${s.slice(-2)}`; };

/** Rule 8 / PARTNER_PAYLOAD_MINIMAL: the servicer loan number, the payoff date, the amount wired, the wire reference and the program flag — never the new loan's number, rate or amount. */
export interface PartnerRetirementNotice { readonly servicer_loan_number: string; readonly payoff_date: PlainDate; readonly amount_cents: string; readonly wire_reference: string | null; readonly refinance_program: true; readonly channel: "partner_api"; }
export class FakePartnerBookNotify implements OutboundAdapter<PartnerRetirementNotice, { delivered: true; ack_reference: string }> {
  readonly name = "partner-book.notify";
  readonly fallbackKind = "partner_notification_manual";
  readonly fallbackRole = "ops_analyst";
  outage = false;
  /** The FAKE partner's inbox by servicer loan number — what its next tape reads. */
  readonly inbox = new Map<string, PartnerRetirementNotice & { received_at: string; message_id: string }>();
  async send(payload: PartnerRetirementNotice, m: OutboxMessage): Promise<{ delivered: true; ack_reference: string }> {
    if (this.outage) throw new AdapterUnavailable(this.name, this.fallbackKind, "partner-book.notify outage");
    const at = m.lastAttemptAt ?? m.createdAt;
    this.inbox.set(payload.servicer_loan_number, { ...payload, received_at: at, message_id: m.id });
    return { delivered: true, ack_reference: `NL-ACK-${createHash("sha256").update(m.id).digest("hex").slice(0, 10)}` };
  }
}
