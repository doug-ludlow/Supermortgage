/**
 * Cashiering service — the `cashiering` agent's commands for 2.1:
 * payment.receive → payment.identify → payment.allocate → payment.post, plus
 * the Reversal Engine (rule 9). Cash is always posted the day it is received;
 * humans never edit rows, they re-run commands with a documented instruction.
 */
import { randomUUID } from "node:crypto";
import type { EventStore, Actor } from "../../kernel/events/index.ts";
import type { Ledger, AccountRef, LineInput } from "../../kernel/ledger/ledger.ts";
import { Machine } from "../../kernel/fsm/machine.ts";
import { type CalendarSet, defaultCalendars } from "../../kernel/calendar/business.ts";
import { plainDate, type PlainDate } from "../../kernel/calendar/date.ts";
import { receiptDates, idempotencyKey, assertCreditedAsOfPermitted, DEFAULT_CHANNELS } from "./receipt.ts";
import { allocate, RULE_SET, type AllocationPlan } from "./allocation.ts";
import type { Payment, PaymentInput, PaymentStatus, LoanCashState, ChannelConfig, Channel, ReversalReason } from "./types.ts";

export const CASHIERING_AGENT: Actor = { kind: "agent", id: "cashiering" };

export const paymentMachine = new Machine<PaymentStatus, { hasLoan: boolean; held: boolean }>({
  name: "payment", initial: "received",
  states: ["received", "identified", "held", "allocated", "posted", "reversed", "returned", "refunded"],
  terminal: ["reversed", "returned", "refunded"],
  transitions: [
    { from: "received", to: "identified", on: "payment.identify", guard: (t) => (t.ctx.hasLoan ? undefined : "no loan match") },
    { from: "identified", to: "allocated", on: "payment.allocate", guard: (t) => (t.ctx.held ? "funds held" : undefined) },
    { from: "identified", to: "held", on: "payment.allocate", guard: (t) => (t.ctx.held ? undefined : "not held") },
    { from: ["allocated", "held"], to: "posted", on: "payment.post" },
    { from: "posted", to: "reversed", on: "payment.reverse" },
    { from: "posted", to: "refunded", on: "payment.refund" },
  ],
});

export interface CashieringDeps {
  readonly events: EventStore;
  readonly ledger: Ledger;
  readonly clock: { now(): string };
  readonly calendars?: CalendarSet;
  readonly channels?: Partial<Record<Channel, ChannelConfig>>;
  readonly loans: { get(loanId: string): LoanCashState | undefined; put(state: LoanCashState): void };
  /** Custodial account ids by kind for the partner (6.x owns the real mapping). */
  readonly custodial: { clearing: string; pi: string; ti: string };
}

export interface PostResult { readonly payment: Payment; readonly plan: AllocationPlan; }

export class CashieringService {
  private readonly payments = new Map<string, Payment>();
  private readonly byIdem = new Map<string, string>();
  private readonly snapshots = new Map<string, LoanCashState>();          // pre-payment state, for reversals
  private readonly investorSeq = new Map<string, number>();               // 5.1's investor_loan_sequences (placeholder)
  private readonly deps: CashieringDeps;
  private readonly cals: CalendarSet;

  constructor(deps: CashieringDeps) { this.deps = deps; this.cals = deps.calendars ?? defaultCalendars; }

  payment(id: string): Payment { const p = this.payments.get(id); if (!p) throw new RangeError(`no payment ${id}`); return p; }
  all(): readonly Payment[] { return [...this.payments.values()]; }
  channel(c: Channel): ChannelConfig { return this.deps.channels?.[c] ?? DEFAULT_CHANNELS[c]; }

  /** payment.receive — dates the item (rule 1), checks conformity (rule 3), dedupes (idempotency key), posts cash to clearing/suspense. */
  receive(input: PaymentInput): { payment: Payment; duplicate: boolean } {
    if (input.amount_cents <= 0n) throw new RangeError("amount must be positive");
    const cfg = this.channel(input.channel);
    const dates = receiptDates(input, cfg, this.cals.business_days_servicer);
    assertCreditedAsOfPermitted(dates.received_on, dates.credited_as_of, dates.conforming);
    const key = idempotencyKey(input, dates.received_on);
    const existing = this.byIdem.get(key);
    if (existing) {
      // 2.2-T11: a resubmitted item is rejected as a duplicate and the exception is logged, never posted twice.
      this.deps.events.append({ type: "payment.duplicate.rejected", ...(input.loan_id ? { loanId: input.loan_id } : {}), aggregate: { kind: "payment", id: existing }, actor: CASHIERING_AGENT,
        payload: { payment_id: existing, idempotency_key: key, channel: input.channel, amount_cents: input.amount_cents.toString(), source_item_id: input.source_item_id ?? null, exception: "duplicate_item" } });
      return { payment: this.payment(existing), duplicate: true };
    }
    const { loan_id, ...rest } = input;
    const p: Payment = { ...rest, ...(loan_id !== undefined ? { loan_id } : {}), id: randomUUID(), idempotency_key: key, ...dates, status: "received", allocations: [], ledger_entry_set_ids: [], investor_event_ids: [], decision_ids: [] };
    this.payments.set(p.id, p); this.byIdem.set(key, p.id);
    this.deps.events.append({ type: "payment.received", ...(p.loan_id ? { loanId: p.loan_id } : {}), aggregate: { kind: "payment", id: p.id }, actor: CASHIERING_AGENT,
      payload: { payment_id: p.id, channel: p.channel, amount_cents: p.amount_cents.toString(), received_on: p.received_on, received_at: p.received_at, credited_as_of: p.credited_as_of, conforming: p.conforming, requirements_version: p.requirements_version, received_by: p.channel === "lockbox" ? "lockbox_agent" : p.channel === "transferor_forward" ? "transferor" : "servicer" } });
    if (!p.conforming) this.deps.events.append({ type: "notice.queued", ...(p.loan_id ? { loanId: p.loan_id } : {}), actor: CASHIERING_AGENT, payload: { template: "PAY-NONCONFORMING-v1", payment_id: p.id } });
    return { payment: p, duplicate: false };
  }

  /** payment.identify — deterministic match already carried on the input (scanline/enrollment/session); fuzzy matching is 6.5. */
  identify(paymentId: string, loanId: string): Payment {
    const p = this.payment(paymentId);
    const t = paymentMachine.attempt(p.status, "payment.identify", CASHIERING_AGENT, { hasLoan: !!loanId, held: false });
    if (!t.ok) throw new Error(t.reason);
    p.loan_id = loanId; p.status = "identified";
    this.deps.events.append({ type: "payment.identified", loanId, aggregate: { kind: "payment", id: p.id }, actor: CASHIERING_AGENT, payload: { payment_id: p.id } });
    return p;
  }

  /** payment.allocate + payment.post in one transaction (rule 8: ledger entries land with the loan_events row). */
  post(paymentId: string): PostResult {
    const p = this.payment(paymentId);
    if (!p.loan_id) throw new Error("payment not identified");
    const state = this.deps.loans.get(p.loan_id);
    if (!state) throw new RangeError(`no loan cash state ${p.loan_id}`);
    const plan = allocate(state, { payment_id: p.id, amount_cents: p.amount_cents, received_on: p.received_on, credited_as_of: p.credited_as_of, designation: p.designation ?? "unspecified", ...(p.borrower_instruction_text ? { instruction_text: p.borrower_instruction_text } : {}), ...(p.curtailment_cents !== undefined ? { curtailment_cents: p.curtailment_cents } : {}) });
    const heldOutcome = plan.hold !== undefined || plan.outcome === "payoff_routed";
    const t1 = paymentMachine.attempt(p.status, "payment.allocate", CASHIERING_AGENT, { hasLoan: true, held: heldOutcome });
    if (!t1.ok) throw new Error(t1.reason);
    const t2 = paymentMachine.attempt(t1.to, "payment.post", CASHIERING_AGENT, { hasLoan: true, held: heldOutcome });
    if (!t2.ok) throw new Error(t2.reason);

    this.snapshots.set(p.id, structuredClone(state));
    const sets = this.postEntries(p, plan);
    this.deps.loans.put(plan.next);
    p.status = "posted"; p.allocation_outcome = plan.outcome; p.allocations = [...plan.allocations]; p.ledger_entry_set_ids.push(...sets);

    if (plan.refused_instruction) {
      const decisionId = randomUUID();
      p.decision_ids.push(decisionId);
      this.deps.events.append({ type: "agent.decision", loanId: p.loan_id, aggregate: { kind: "payment", id: p.id }, actor: CASHIERING_AGENT,
        payload: { decision_id: decisionId, agent: "cashiering", action: "instruction_refused", rule_set_version: RULE_SET, cite: plan.refused_instruction.cite, rationale: plan.refused_instruction.reason, instruction: plan.refused_instruction.text } });
    }
    for (const inst of plan.installments) {
      const ev = this.deps.events.append({ type: inst.kind === "prepaid" ? "payment.prepaid.applied" : "payment.applied", loanId: p.loan_id, aggregate: { kind: "payment", id: p.id }, actor: CASHIERING_AGENT,
        payload: { payment_id: p.id, installment_due_date: inst.due_date, interest_cents: inst.interest_cents.toString(), principal_cents: inst.principal_cents.toString(), escrow_cents: inst.escrow_cents.toString(), upb_after_cents: inst.upb_after_cents.toString(), credited_as_of: p.credited_as_of, applied_with_50_rule: inst.fifty_rule_shortfall_cents !== undefined, ...(inst.fifty_rule_shortfall_cents !== undefined ? { fifty_rule_shortfall_cents: inst.fifty_rule_shortfall_cents.toString() } : {}) } });
      // Rule 10 contract with 5.1: one investor event per installment, figures identical to the allocation payload.
      const seq = (this.investorSeq.get(p.loan_id) ?? 0) + 1; this.investorSeq.set(p.loan_id, seq);
      const inv = this.deps.events.append({ type: "investor_events.created", loanId: p.loan_id, aggregate: { kind: "payment", id: p.id }, actor: CASHIERING_AGENT, causationId: ev.id,
        payload: { type: inst.kind === "prepaid" ? "payment.prepaid" : "payment.contractual", mode: "event", sequence: seq, effective_date: p.received_on, processed_at: this.deps.clock.now(), lpi_date: inst.due_date, upb_cents: inst.upb_after_cents.toString(), interest_cents: inst.interest_cents.toString(), principal_cents: inst.principal_cents.toString(), rate_pct: state.note_rate_pct, pi_cents: (inst.interest_cents + inst.principal_cents).toString() } });
      p.investor_event_ids.push(inv.id);
    }
    if (plan.curtailment_cents > 0n) {
      const ev = this.deps.events.append({ type: "payment.curtailment.applied", loanId: p.loan_id, aggregate: { kind: "payment", id: p.id }, actor: CASHIERING_AGENT, payload: { payment_id: p.id, amount_cents: plan.curtailment_cents.toString(), nib_cents: plan.curtailment_nib_cents.toString(), upb_after_cents: plan.next.upb_cents.toString(), nib_after_cents: ((plan.next.deferred_principal_cents ?? 0n) + (plan.next.forborne_principal_cents ?? 0n)).toString() } });
      const seq = (this.investorSeq.get(p.loan_id) ?? 0) + 1; this.investorSeq.set(p.loan_id, seq);
      p.investor_event_ids.push(this.deps.events.append({ type: "investor_events.created", loanId: p.loan_id, aggregate: { kind: "payment", id: p.id }, actor: CASHIERING_AGENT, causationId: ev.id,
        payload: { type: "payment.curtailment", mode: "event", sequence: seq, effective_date: p.received_on, processed_at: this.deps.clock.now(), upb_cents: plan.next.upb_cents.toString(), nib_cents: ((plan.next.deferred_principal_cents ?? 0n) + (plan.next.forborne_principal_cents ?? 0n)).toString(), amount_cents: plan.curtailment_cents.toString() } }).id);
    }
    if (plan.redirected_curtailment) this.deps.events.append({ type: "notice.queued", loanId: p.loan_id, aggregate: { kind: "payment", id: p.id }, actor: CASHIERING_AGENT, payload: { template: "CURTAIL-REDIRECT-v1", payment_id: p.id, held_cents: plan.to_suspense_cents.toString() } });
    if (plan.late_charge_cents > 0n) this.deps.events.append({ type: "fee.collected", loanId: p.loan_id, aggregate: { kind: "payment", id: p.id }, actor: CASHIERING_AGENT, payload: { payment_id: p.id, fee_type: "late_charge", amount_cents: plan.late_charge_cents.toString() } });
    if (plan.installments.some((i) => i.escrow_cents > 0n)) this.deps.events.append({ type: "escrow.deposit", loanId: p.loan_id, aggregate: { kind: "payment", id: p.id }, actor: CASHIERING_AGENT, payload: { payment_id: p.id, amount_cents: plan.installments.reduce((s, i) => s + i.escrow_cents, 0n).toString() } });
    if (plan.hold) this.deps.events.append({ type: "payment.held", loanId: p.loan_id, aggregate: { kind: "payment", id: p.id }, actor: CASHIERING_AGENT, payload: { payment_id: p.id, hold: plan.hold, amount_cents: p.amount_cents.toString() } });
    this.deps.events.append({ type: "payment.posted", loanId: p.loan_id, aggregate: { kind: "payment", id: p.id }, actor: CASHIERING_AGENT,
      payload: { payment_id: p.id, outcome: plan.outcome, credited_as_of: p.credited_as_of, received_on: p.received_on, rule_set_version: RULE_SET, rule_path: plan.rule_path, entry_set_ids: sets } });
    return { payment: p, plan };
  }

  /** Rule 8 postings: receipt, allocation, cash split — every set balanced or the ledger throws. */
  private postEntries(p: Payment, plan: AllocationPlan): string[] {
    const loanId = p.loan_id!;
    const cfg = this.channel(p.channel);
    const eff: PlainDate = p.credited_as_of;
    const loan = (account: "principal" | "interest_due" | "escrow" | "suspense_unapplied" | "late_charges" | "nsf_fees" | "other_fees"): AccountRef => ({ scope: "loan", loanId, account });
    const cust = (id: string, account: "clearing_cash" | "custodial_pi_cash" | "custodial_ti_cash" | "custodial_ti_unapplied_cash"): AccountRef => ({ scope: "custodial", custodialAccountId: id, account });
    const cashIn: AccountRef = cfg.direct_to_custodial ? cust(this.deps.custodial.pi, "custodial_pi_cash") : cust(this.deps.custodial.clearing, "clearing_cash");
    const ids: string[] = [];
    // receipt: Dr cash / Cr suspense_unapplied
    ids.push(this.deps.ledger.post({ effectiveDate: eff, description: `receipt ${p.id}`, lines: [
      { account: cashIn, amountCents: p.amount_cents, ruleRef: "2.1:r8:receipt" },
      { account: loan("suspense_unapplied"), amountCents: -p.amount_cents, ruleRef: "2.1:r8:receipt" } ] }).id);
    const sum = (b: string) => plan.allocations.filter((a) => a.bucket === b).reduce((s, a) => s + a.amount_cents, 0n);
    const interest = sum("interest"), principal = sum("principal") + sum("curtailment"), escrow = sum("escrow"), lc = sum("late_charge"), nsf = sum("nsf_fee"), other = sum("other_fee");
    const appliedTotal = interest + principal + escrow + lc + nsf + other;
    if (appliedTotal > 0n) {
      // allocation: Dr suspense_unapplied / Cr interest_due, principal, escrow, late_charges …
      const lines: LineInput[] = [{ account: loan("suspense_unapplied"), amountCents: appliedTotal, ruleRef: "2.1:r8:allocation" }];
      const cr = (a: AccountRef, amt: bigint, ref: string) => { if (amt !== 0n) lines.push({ account: a, amountCents: -amt, ruleRef: ref }); };
      cr(loan("interest_due"), interest, "2.1:r8:allocation:interest"); cr(loan("principal"), principal, "2.1:r8:allocation:principal"); cr(loan("escrow"), escrow, "2.1:r8:allocation:escrow");
      cr(loan("late_charges"), lc, "2.1:r8:allocation:late_charge"); cr(loan("nsf_fees"), nsf, "2.1:r8:allocation:nsf_fee"); cr(loan("other_fees"), other, "2.1:r8:allocation:other_fee");
      ids.push(this.deps.ledger.post({ effectiveDate: eff, description: `allocation ${p.id}`, lines }).id);
      // cash split: P&I stays/lands in custodial P&I, escrow moves to T&I, fees to corporate — deducted before P&I reaches custodial (F-1-03).
      const split: LineInput[] = [];
      const fees = lc + nsf + other;
      if (cfg.direct_to_custodial) {
        if (escrow) split.push({ account: cust(this.deps.custodial.ti, "custodial_ti_cash"), amountCents: escrow, ruleRef: "2.1:r8:cash_split:escrow" });
        if (fees) split.push({ account: { scope: "corporate", account: "corporate_cash" }, amountCents: fees, ruleRef: "2.1:r8:cash_split:fees" });
        if (escrow + fees) split.push({ account: cashIn, amountCents: -(escrow + fees), ruleRef: "2.1:r8:cash_split" });
      } else {
        if (interest + principal) split.push({ account: cust(this.deps.custodial.pi, "custodial_pi_cash"), amountCents: interest + principal, ruleRef: "2.1:r8:cash_split:pi" });
        if (escrow) split.push({ account: cust(this.deps.custodial.ti, "custodial_ti_cash"), amountCents: escrow, ruleRef: "2.1:r8:cash_split:escrow" });
        if (fees) split.push({ account: { scope: "corporate", account: "corporate_cash" }, amountCents: fees, ruleRef: "2.1:r8:cash_split:fees" });
        split.push({ account: cashIn, amountCents: -appliedTotal, ruleRef: "2.1:r8:cash_split" });
      }
      if (split.length >= 2) ids.push(this.deps.ledger.post({ effectiveDate: eff, description: `cash split ${p.id}`, lines: split }).id);
    }
    // anything left in suspense: park the cash in the T&I unapplied custodial account (2.2 rule 7)
    if (plan.to_suspense_cents > 0n && !cfg.direct_to_custodial) {
      ids.push(this.deps.ledger.post({ effectiveDate: eff, description: `suspense park ${p.id}`, lines: [
        { account: cust(this.deps.custodial.ti, "custodial_ti_unapplied_cash"), amountCents: plan.to_suspense_cents, ruleRef: "2.2:r7:park" },
        { account: cashIn, amountCents: -plan.to_suspense_cents, ruleRef: "2.2:r7:park" } ] }).id);
    }
    return ids;
  }

  /** Reversal Engine (rule 9): mirror entries, restore pre-payment state, emit payment.reversed and the investor reversal. */
  reverse(paymentId: string, reason: ReversalReason, opts: { return_code?: string; actor?: Actor } = {}): Payment {
    const p = this.payment(paymentId);
    const t = paymentMachine.attempt(p.status, "payment.reverse", opts.actor ?? CASHIERING_AGENT, { hasLoan: true, held: false });
    if (!t.ok) throw new Error(t.reason);
    const before = this.snapshots.get(p.id);
    if (!before) throw new Error("no pre-payment snapshot");
    const today = plainDate(this.deps.clock.now().slice(0, 10));
    const mirror = p.ledger_entry_set_ids.map((id) => this.deps.ledger.reverse(id, today, `${reason}${opts.return_code ? ` ${opts.return_code}` : ""}`).id);
    // Restore installments/LPI/UPB to the pre-payment state; later payments are re-run by the caller if any (2.1 rule 9).
    this.deps.loans.put(structuredClone(before));
    p.status = "reversed";
    p.reversal = { reason, ...(opts.return_code ? { return_code: opts.return_code } : {}), reversed_at: this.deps.clock.now(), entry_set_ids: mirror };
    this.deps.events.append({ type: "payment.reversed", loanId: p.loan_id!, aggregate: { kind: "payment", id: p.id }, actor: opts.actor ?? CASHIERING_AGENT,
      payload: { payment_id: p.id, reason, return_code: opts.return_code ?? null, mirror_entry_set_ids: mirror, restored_upb_cents: before.upb_cents.toString(), restored_lpi_date: before.lpi_date, nsf_fee_assessed: reason === "returned_item" } });
    for (const invId of p.investor_event_ids) {
      const seq = (this.investorSeq.get(p.loan_id!) ?? 0) + 1; this.investorSeq.set(p.loan_id!, seq);
      this.deps.events.append({ type: "investor_events.created", loanId: p.loan_id!, aggregate: { kind: "payment", id: p.id }, actor: CASHIERING_AGENT, causationId: invId,
        payload: { type: "payment.reversal", mode: "event", sequence: seq, reverses_event_id: invId, effective_date: p.received_on, processed_at: this.deps.clock.now() } });
    }
    return p;
  }
}
