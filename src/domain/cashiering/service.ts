/**
 * Cashiering service — the `cashiering` agent's commands for 2.1:
 * payment.receive → payment.identify → payment.allocate → payment.post, plus
 * the Reversal Engine (rule 9) and the 2.2 re-evaluation on a terms change.
 * Cash is always posted the day it is received; humans never edit rows, they
 * re-run commands with a documented instruction.
 */
import { randomUUID } from "node:crypto";
import type { EventStore, Actor } from "../../kernel/events/index.ts";
import type { Ledger, AccountRef, LineInput } from "../../kernel/ledger/ledger.ts";
import { Machine } from "../../kernel/fsm/machine.ts";
import { type CalendarSet, defaultCalendars, addBusinessDays } from "../../kernel/calendar/business.ts";
import { plainDate, type PlainDate } from "../../kernel/calendar/date.ts";
import { receiptDates, idempotencyKey, assertCreditedAsOfPermitted, DEFAULT_CHANNELS } from "./receipt.ts";
import { allocate, RULE_SET, type AllocationPlan } from "./allocation.ts";
import { recordFiftyRuleEvaluation } from "./ops-2-2.ts";
import { type Payment, type PaymentInput, type PaymentStatus, type LoanCashState, type ChannelConfig, type Channel, type ReversalReason, cashCfg } from "./types.ts";

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
/** What the ledger needs to know about the funds it moves: a payment, or the zero-amount re-evaluation of already-parked funds. */
interface CashRef { readonly id: string; readonly loan_id: string; readonly amount_cents: bigint; readonly received_on: PlainDate; readonly credited_as_of: PlainDate; readonly channel: Channel | null; }

/** Channels whose receipt/confirmation goes electronically with consent (2.1 outputs: `PAY-CONFIRM-v1`). */
const CONFIRMATION_CHANNELS: ReadonlySet<Channel> = new Set(["portal_onetime", "ivr", "agent_assisted"]);

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
    // The receipt event carries the facts the 2.4/2.5 timer triggers key on (designation, delinquency, NIB balance, note type, channel).
    const state = p.loan_id ? this.deps.loans.get(p.loan_id) : undefined;
    const designation = p.designation ?? ((p.curtailment_cents ?? 0n) > 0n ? "curtailment" : "unspecified");
    // `delinquent`: an installment due on/before receipt is unpaid; `current_after_funds`: the funds (plus open suspense) cover every such installment, so a
    // curtailment submitted with the scheduled payment applies the same day once that payment is applied first (F-1-09; 2.4 example F, FNMA_C1201_CURTAILMENT_APPLY_IMMEDIATE_0BD).
    const dueNow = state ? state.installments.filter((i) => i.status === "due" && i.due_date <= p.received_on) : [];
    const loanFacts = state ? { delinquent: dueNow.length > 0, current_after_funds: p.amount_cents + state.suspense_unapplied_cents >= dueNow.reduce((t, i) => t + i.pi_cents + i.escrow_cents, 0n), non_interest_bearing_upb: Number(cashCfg(state).deferred + cashCfg(state).forborne), interest_bearing_upb_cents: state.upb_cents.toString(), note_type: state.note_frequency ?? "monthly" } : {};
    this.deps.events.append({ type: "payment.received", ...(p.loan_id ? { loanId: p.loan_id } : {}), aggregate: { kind: "payment", id: p.id }, actor: CASHIERING_AGENT,
      payload: { payment_id: p.id, channel: p.channel, amount_cents: p.amount_cents.toString(), received_on: p.received_on, received_at: p.received_at, credited_as_of: p.credited_as_of, conforming: p.conforming, requirements_version: p.requirements_version,
        received_by: p.channel === "lockbox" ? "lockbox_agent" : p.channel === "transferor_forward" ? "transferor" : "servicer", designation, curtailment_cents: (p.curtailment_cents ?? 0n).toString(), ...loanFacts, ...(p.arrangement ? { arrangement: p.arrangement } : {}), ...(p.split_half ? { half: p.split_half } : {}) } });
    if (!p.conforming) this.queueNotice(p.loan_id, p.id, "PAY-NONCONFORMING-v1", { citation: "12 CFR 1026.36(c)(1)(iii)", nonconforming_reason: p.nonconforming_reason ?? null, requirements_version: p.requirements_version });
    else if (CONFIRMATION_CHANNELS.has(p.channel)) this.queueNotice(p.loan_id, p.id, "PAY-CONFIRM-v1", { channel_rule: "electronic_only_with_consent", confirmation_number: p.id, amount_cents: p.amount_cents.toString(), received_on: p.received_on });
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
    const ref: CashRef = { id: p.id, loan_id: p.loan_id, amount_cents: p.amount_cents, received_on: p.received_on, credited_as_of: p.credited_as_of, channel: p.channel };
    const sets = this.postEntries(ref, plan);
    this.deps.loans.put(plan.next);
    p.status = "posted"; p.allocation_outcome = plan.outcome; p.allocations = [...plan.allocations]; p.ledger_entry_set_ids.push(...sets);

    if (plan.refused_instruction) {
      const decisionId = randomUUID();
      p.decision_ids.push(decisionId);
      this.deps.events.append({ type: "agent.decision", loanId: p.loan_id, aggregate: { kind: "payment", id: p.id }, actor: CASHIERING_AGENT,
        payload: { decision_id: decisionId, agent: "cashiering", action: "instruction_refused", rule_set_version: RULE_SET, cite: plan.refused_instruction.cite, rationale: plan.refused_instruction.reason, instruction: plan.refused_instruction.text } });
    }
    p.investor_event_ids.push(...this.emitApplications(ref, plan, state, { kind: "payment", id: p.id }));
    if (plan.outcome === "applied_with_50_rule") recordFiftyRuleEvaluation({ events: this.deps.events, clock: this.deps.clock }, { payment_id: p.id, loan_id: ref.loan_id }, plan, p.credited_as_of);   // 2.2 rule 2: `partial_payment_evaluations` row + the `partial_payment_50_rule` counter row (FNMA_C1102_50_RULE_COUNT_12M)
    if (plan.curtailment_cents > 0n) this.queueNotice(p.loan_id, p.id, "CURTAIL-CONFIRM-v1", { amount_cents: plan.curtailment_cents.toString(), new_upb_cents: plan.next.upb_cents.toString(), due_date_unchanged: true, pi_unchanged: true, channel_rule: "electronic_with_consent_else_next_statement" });
    if (plan.redirected_curtailment) this.queueNotice(p.loan_id, p.id, "CURTAIL-REDIRECT-v1", { held_cents: plan.to_suspense_cents.toString(), citation: "Servicing Guide C-1.2-01" });
    if (plan.late_charge_cents > 0n) this.deps.events.append({ type: "fee.collected", loanId: p.loan_id, aggregate: { kind: "payment", id: p.id }, actor: CASHIERING_AGENT, payload: { payment_id: p.id, fee_type: "late_charge", late_charge: true, amount_cents: plan.late_charge_cents.toString(), collected_on: p.received_on } });
    if (plan.installments.some((i) => i.escrow_cents > 0n)) this.deps.events.append({ type: "escrow.deposit", loanId: p.loan_id, aggregate: { kind: "payment", id: p.id }, actor: CASHIERING_AGENT, payload: { payment_id: p.id, amount_cents: plan.installments.reduce((s, i) => s + i.escrow_cents, 0n).toString() } });
    if (plan.hold) this.deps.events.append({ type: "payment.held", loanId: p.loan_id, aggregate: { kind: "payment", id: p.id }, actor: CASHIERING_AGENT, payload: { payment_id: p.id, hold: plan.hold, amount_cents: p.amount_cents.toString() } });
    // 2.4-T10 / SM_CURTAILMENT_PAYOFF_ROUTE_GATE: a designated curtailment ≥ IB UPB + NIB (or a payoff designation) is routed to 16.x with a payoff statement — no curtailment event, nothing applied.
    if (plan.outcome === "payoff_routed") this.deps.events.append({ type: "payment.payoff_routed", loanId: p.loan_id, aggregate: { kind: "payment", id: p.id }, actor: CASHIERING_AGENT, payload: { payment_id: p.id, amount_cents: p.amount_cents.toString(), designation: p.designation ?? "unspecified", route: "16.2", reason: p.designation === "curtailment" ? "curtailment ≥ interest-bearing UPB + NIB (2.4 timer table: SM_CURTAILMENT_PAYOFF_ROUTE_GATE)" : "payoff designation (2.1 rule 5 overlay)", curtailment_applied: false, received_on: p.received_on } });
    if (plan.partial_hold) this.queueHoldNotice(p, plan);
    this.deps.events.append({ type: "payment.posted", loanId: p.loan_id, aggregate: { kind: "payment", id: p.id }, actor: CASHIERING_AGENT,
      payload: { payment_id: p.id, outcome: plan.outcome, credited_as_of: p.credited_as_of, received_on: p.received_on, rule_set_version: RULE_SET, rule_path: plan.rule_path, entry_set_ids: sets, channel: p.channel, ...(p.arrangement ? { arrangement: p.arrangement } : {}), ...(p.split_half ? { half: p.split_half } : {}) } });
    return { payment: p, plan };
  }

  /**
   * 2.2 rule 4 / `SM_SUSPENSE_REEVAL_ON_TERMS_CHANGE_0`: on `loan_terms.activated` (P changes) the open unapplied balance is
   * re-tested against the new P in the same transaction; a sufficient balance is applied with `credited_as_of` = activation date.
   */
  reevaluateSuspense(loanId: string, activatedOn: PlainDate, reason = "loan_terms.activated"): { applied: boolean; plan: AllocationPlan | null; entry_set_ids: string[] } {
    const state = this.deps.loans.get(loanId);
    if (!state) throw new RangeError(`no loan cash state ${loanId}`);
    const id = `reeval:${loanId}:${activatedOn}`;
    const done = (sufficient: boolean, plan: AllocationPlan | null, sets: string[]) => {
      this.deps.events.append({ type: "suspense.accumulation.reevaluated", loanId, aggregate: { kind: "suspense_reevaluation", id }, actor: CASHIERING_AGENT,
        payload: { reason, activated_on: activatedOn, open_unapplied_cents: state.suspense_unapplied_cents.toString(), sufficient, installments_applied: plan?.installments.length ?? 0, credited_as_of: sufficient ? activatedOn : null } });
      return { applied: sufficient, plan, entry_set_ids: sets };
    };
    if (state.suspense_unapplied_cents <= 0n || state.holds.length > 0 || state.trial_active) return done(false, null, []);
    const plan = allocate(state, { payment_id: id, amount_cents: 0n, received_on: activatedOn, credited_as_of: activatedOn, designation: "contractual" });
    if (plan.installments.length === 0) return done(false, plan, []);
    const ref: CashRef = { id, loan_id: loanId, amount_cents: 0n, received_on: activatedOn, credited_as_of: activatedOn, channel: null };
    const sets = this.postEntries(ref, plan);
    this.deps.loans.put(plan.next);
    this.emitApplications(ref, plan, state, { kind: "suspense_reevaluation", id });
    return done(true, plan, sets);
  }

  /** Rule 10 (contract with 5.1) and the 2.2 accumulation event: one `payment.applied` + one investor event per installment, figures identical to the allocation payload. */
  private emitApplications(ref: CashRef, plan: AllocationPlan, state: LoanCashState, aggregate: { kind: string; id: string }): string[] {
    const ids: string[] = [];
    const first = plan.installments[0];
    if (plan.suspense_used_cents > 0n && first) {
      // Reg Z §1026.36(c)(1)(ii)(B): the accumulated funds are a periodic payment received on the accumulation date (REGZ_1026_36C_APPLY_ON_ACCUMULATION_1BD arms here, `payment.applied` closes it).
      this.deps.events.append({ type: "suspense.accumulation.sufficient", loanId: ref.loan_id, aggregate, actor: CASHIERING_AGENT,
        payload: { accumulated_on: ref.received_on, credited_as_of: ref.credited_as_of, sum_cents: (ref.amount_cents + plan.suspense_used_cents).toString(), periodic_payment_cents: (state.installments.find((i) => i.due_date === first.due_date)?.pi_cents ?? 0n) + (state.installments.find((i) => i.due_date === first.due_date)?.escrow_cents ?? 0n), suspense_used_cents: plan.suspense_used_cents.toString() } });
    }
    const lar = state.note_frequency === "biweekly" ? ["96", "97"] : ["96"];      // 2.5 rule 5: true biweekly loans are detailed-reporting (LAR 96 + 97 per payment)
    for (const inst of plan.installments) {
      const ev = this.deps.events.append({ type: inst.kind === "prepaid" ? "payment.prepaid.applied" : "payment.applied", loanId: ref.loan_id, aggregate, actor: CASHIERING_AGENT,
        payload: { payment_id: ref.id, installment_due_date: inst.due_date, interest_cents: inst.interest_cents.toString(), principal_cents: inst.principal_cents.toString(), escrow_cents: inst.escrow_cents.toString(), upb_after_cents: inst.upb_after_cents.toString(), credited_as_of: ref.credited_as_of, allocation_outcome: plan.outcome, applied_with_50_rule: inst.fifty_rule_shortfall_cents !== undefined, ...(inst.fifty_rule_shortfall_cents !== undefined ? { fifty_rule_shortfall_cents: inst.fifty_rule_shortfall_cents.toString() } : {}) } });
      const seq = (this.investorSeq.get(ref.loan_id) ?? 0) + 1; this.investorSeq.set(ref.loan_id, seq);
      const inv = this.deps.events.append({ type: "investor_events.created", loanId: ref.loan_id, aggregate, actor: CASHIERING_AGENT, causationId: ev.id,
        payload: { type: inst.kind === "prepaid" ? "payment.prepaid" : "payment.contractual", family: "payment", mode: "event", lar_codes: lar, sequence: seq, effective_date: ref.received_on, processed_at: this.deps.clock.now(), lpi_date: inst.due_date, upb_cents: inst.upb_after_cents.toString(), interest_cents: inst.interest_cents.toString(), principal_cents: inst.principal_cents.toString(), rate_pct: state.note_rate_pct, pi_cents: (inst.interest_cents + inst.principal_cents).toString(), suspense_balance_cents: plan.next.suspense_unapplied_cents.toString() } });
      ids.push(inv.id);
    }
    if (plan.curtailment_cents > 0n) {
      const nibAfter = ((plan.next.deferred_principal_cents ?? 0n) + (plan.next.forborne_principal_cents ?? 0n)).toString();
      const ev = this.deps.events.append({ type: "payment.curtailment.applied", loanId: ref.loan_id, aggregate, actor: CASHIERING_AGENT, payload: { payment_id: ref.id, amount_cents: plan.curtailment_cents.toString(), ib_applied_cents: (plan.curtailment_cents - plan.curtailment_nib_cents).toString(), nib_cents: plan.curtailment_nib_cents.toString(), upb_after_cents: plan.next.upb_cents.toString(), nib_after_cents: nibAfter, with_scheduled_payment: plan.installments.length > 0, applied_on: ref.received_on, credited_as_of: ref.credited_as_of } });
      const seq = (this.investorSeq.get(ref.loan_id) ?? 0) + 1; this.investorSeq.set(ref.loan_id, seq);
      ids.push(this.deps.events.append({ type: "investor_events.created", loanId: ref.loan_id, aggregate, actor: CASHIERING_AGENT, causationId: ev.id,
        payload: { type: "payment.curtailment", family: "payment", mode: "event", lar_codes: ["96"], sequence: seq, effective_date: ref.received_on, processed_at: this.deps.clock.now(), upb_cents: plan.next.upb_cents.toString(), nib_cents: nibAfter, amount_cents: plan.curtailment_cents.toString() } }).id);
    }
    return ids;
  }

  /** 2.2 guardrail "must send the hold notice within 1 BD of the hold": the queue entry carries its own deadline and the (d)(5)-style facts. */
  private queueHoldNotice(p: Payment, plan: AllocationPlan): void {
    const oldest = plan.next.installments.filter((i) => i.status === "due").sort((a, b) => (a.due_date < b.due_date ? -1 : 1))[0];
    const P = oldest ? oldest.pi_cents + oldest.escrow_cents : 0n;
    const held = plan.next.suspense_unapplied_cents;
    this.queueNotice(p.loan_id, p.id, "SUSP-PARTIAL-HOLD-v1", { held_cents: held.toString(), balance_needed_cents: (P > held ? P - held : 0n).toString(), installment_due_date: oldest?.due_date ?? null, received_on: p.received_on,
      due_by: addBusinessDays(p.received_on, 1, this.cals.business_days_servicer), send_within: "1 business_days_servicer", citation: "Servicing Guide C-1.1-02; 12 CFR 1026.41(d)(5)", channel_rule: "esign_consent_else_mail" });
  }

  private queueNotice(loanId: string | undefined, paymentId: string, template: string, extra: Record<string, unknown>): void {
    this.deps.events.append({ type: "notice.queued", ...(loanId ? { loanId } : {}), aggregate: { kind: "payment", id: paymentId }, actor: CASHIERING_AGENT, payload: { template, payment_id: paymentId, ...extra } });
  }

  /**
   * Rule 8 postings (2.1) and rule 7 (2.2) — every set balanced or the ledger throws:
   *   receipt      Dr clearing_cash / custodial_pi_cash (direct deposits)   Cr suspense_unapplied
   *   allocation   Dr suspense_unapplied                                     Cr interest_due, principal, escrow, late_charges …
   *   cash split   Dr custodial_pi_cash (P&I), custodial_ti_cash (escrow), corporate (fees, F-1-03), custodial_ti_unapplied_cash (held remainder)
   *                Cr the cash-in account (this receipt) and custodial_ti_unapplied_cash (parked funds an accumulation consumed)
   */
  private postEntries(ref: CashRef, plan: AllocationPlan): string[] {
    const loanId = ref.loan_id;
    const eff: PlainDate = ref.credited_as_of;
    const loan = (account: "principal" | "interest_due" | "escrow" | "suspense_unapplied" | "late_charges" | "nsf_fees" | "other_fees"): AccountRef => ({ scope: "loan", loanId, account });
    const cust = (id: string, account: "clearing_cash" | "custodial_pi_cash" | "custodial_ti_cash" | "custodial_ti_unapplied_cash"): AccountRef => ({ scope: "custodial", custodialAccountId: id, account });
    const cfg = ref.channel ? this.channel(ref.channel) : null;
    const cashIn: AccountRef = cfg?.direct_to_custodial ? cust(this.deps.custodial.pi, "custodial_pi_cash") : cust(this.deps.custodial.clearing, "clearing_cash");
    const ids: string[] = [];
    if (ref.amount_cents > 0n) {
      ids.push(this.deps.ledger.post({ effectiveDate: eff, description: `receipt ${ref.id}`, lines: [
        { account: cashIn, amountCents: ref.amount_cents, ruleRef: "2.1:r8:receipt" },
        { account: loan("suspense_unapplied"), amountCents: -ref.amount_cents, ruleRef: "2.1:r8:receipt" } ] }).id);
    }
    const sum = (b: string) => plan.allocations.filter((a) => a.bucket === b).reduce((s, a) => s + a.amount_cents, 0n);
    const interest = sum("interest"), principal = sum("principal") + sum("curtailment") + sum("deferred_principal"), escrow = sum("escrow"), lc = sum("late_charge"), nsf = sum("nsf_fee"), other = sum("other_fee");
    const appliedTotal = interest + principal + escrow + lc + nsf + other;
    if (appliedTotal > 0n) {
      const lines: LineInput[] = [{ account: loan("suspense_unapplied"), amountCents: appliedTotal, ruleRef: "2.1:r8:allocation" }];
      const cr = (a: AccountRef, amt: bigint, ref: string) => { if (amt !== 0n) lines.push({ account: a, amountCents: -amt, ruleRef: ref }); };
      cr(loan("interest_due"), interest, "2.1:r8:allocation:interest"); cr(loan("principal"), principal, "2.1:r8:allocation:principal"); cr(loan("escrow"), escrow, "2.1:r8:allocation:escrow");
      cr(loan("late_charges"), lc, "2.1:r8:allocation:late_charge"); cr(loan("nsf_fees"), nsf, "2.1:r8:allocation:nsf_fee"); cr(loan("other_fees"), other, "2.1:r8:allocation:other_fee");
      ids.push(this.deps.ledger.post({ effectiveDate: eff, description: `allocation ${ref.id}`, lines }).id);
    }
    // Cash movements, netted per account so a direct deposit that already sits in custodial P&I moves only the escrow/fee/parked portions.
    const moves = new Map<string, { account: AccountRef; amount: bigint; ruleRef: string }>();
    const move = (account: AccountRef, amount: bigint, ruleRef: string) => {
      if (amount === 0n) return;
      const k = `${account.scope}:${"custodialAccountId" in account ? account.custodialAccountId : ""}:${account.account}`;
      const cur = moves.get(k);
      if (cur) cur.amount += amount; else moves.set(k, { account, amount, ruleRef });
    };
    move(cust(this.deps.custodial.pi, "custodial_pi_cash"), interest + principal, "2.1:r8:cash_split:pi");
    move(cust(this.deps.custodial.ti, "custodial_ti_cash"), escrow, "2.1:r8:cash_split:escrow");
    move({ scope: "corporate", account: "corporate_cash" }, lc + nsf + other, "2.1:r8:cash_split:fees");
    move(cust(this.deps.custodial.ti, "custodial_ti_unapplied_cash"), plan.to_suspense_cents, "2.2:r7:park");
    move(cust(this.deps.custodial.ti, "custodial_ti_unapplied_cash"), -plan.suspense_used_cents, "2.2:r7:application");
    move(cashIn, -ref.amount_cents, "2.1:r8:cash_split");
    const split: LineInput[] = [...moves.values()].filter((m) => m.amount !== 0n).map((m) => ({ account: m.account, amountCents: m.amount, ruleRef: m.ruleRef }));
    if (split.length >= 2) ids.push(this.deps.ledger.post({ effectiveDate: eff, description: `cash split ${ref.id}`, lines: split }).id);
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
        payload: { type: "payment.reversal", family: "payment", mode: "event", sequence: seq, reverses_event_id: invId, effective_date: p.received_on, processed_at: this.deps.clock.now() } });
    }
    return p;
  }
}
