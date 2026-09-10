/**
 * §9.5 Force-placed cancellation/refund — the operating steps around the pure ./refund.ts calculator:
 *   - the carrier's `refund_advice` (insurance-tracking/lpi, informational: "does not gate the borrower refund") is
 *     validated and reconciled against the servicer's own removal → `fpi.carrier_refund.received` +
 *     `fpi.carrier_refund.reconciled` (satisfies INS_FPI_CARRIER_REFUND_RECON_45, armed by `fpi.lpi.cancel_requested`);
 *     the short-rate/netting difference is a servicer cost (rule 4), never the borrower's or Fannie Mae's;
 *   - rule 5 / T6: when Fannie Mae already reimbursed the premium (F-1-05) the unearned-premium refund is remitted
 *     within 30 days — the 15.2 control (`expense_claim.credit.received{fnma_reimbursed_premium=true, remit_code=336}`
 *     arms FNMA_F105_MI_REFUND_336_30 on `received_at`) is reused as the spec says ("applies the same control");
 *   - the two-sided correction's ledger sets (rule 3/6): reversal linked to the original LPI charge, and the refund
 *     money-out — balanced entry sets carrying `rule_ref`, never edits of the original `lpi_charges`;
 *   - the agent design's escalation: `officer` at day 12 if unpaid (breach-risk report) — a report, not a bar on paying.
 * bigint cents; PlainDate; all state is the append-only event trail.
 */
import { type PlainDate, addDays, daysBetween, plainDate } from "../../kernel/calendar/date.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { SYSTEM, type Actor, type DomainEvent } from "../../kernel/events/types.ts";
import type { EventStore } from "../../kernel/events/store.ts";
import type { Ledger, EntrySet, EntrySetInput, LineInput } from "../../kernel/ledger/ledger.ts";
import type { LpiBinding } from "../../infra/integrations/property.ts";
import { fnmaRemittanceDue, servicerNetCost } from "./refund.ts";

export const CARRIER_REFUND_RECON_DAYS = 45;           // INS_FPI_CARRIER_REFUND_RECON_45 (internal)
export const OFFICER_BREACH_RISK_DAY = 12;             // agent design: `officer` at day 12 if unpaid
export const FNMA_UNEARNED_PREMIUM_REMIT_DAYS = 30;    // F-1-05 / 15.2 (CRS 336)
export const HAZARD_TRACK = "regx_hazard" as const;

export interface Fpi95Escalations { open(input: { kind: "officer" | "sev3" | "human_portal_task"; loanId?: string; ownerRole?: string; severity?: string; payload: Record<string, unknown> }, by: Actor): unknown; }
export interface Fpi95Deps {
  readonly events: EventStore;
  readonly actor?: Actor;
  readonly ledger?: Ledger;
  readonly escalations?: Fpi95Escalations;
}
const actorOf = (d: Fpi95Deps): Actor => d.actor ?? SYSTEM;
const nonEmpty = (v: unknown, name: string): string => { if (typeof v !== "string" || v === "") throw new RangeError(`${name} is required`); return v; };
const payload = <T,>(e: DomainEvent): T => e.payload as T;
const byLoan = (d: Fpi95Deps, loanId: string, type: string): readonly DomainEvent[] => d.events.byLoan(loanId).filter((e) => e.type === type);
const bindingOf = (e: DomainEvent): string | null => { const b = payload<{ binding_id?: unknown }>(e).binding_id; return typeof b === "string" ? b : null; };

// ---- carrier refund_advice ingestion (INS_FPI_CARRIER_REFUND_RECON_45) ----------------------------------------------
export interface CarrierRefundAdvice {
  readonly loan_id: string;
  readonly binding_id: string;
  /** Carrier's advice/statement reference — the idempotency key (integrations: "idempotent per placement"). */
  readonly advice_id: string;
  readonly carrier: string;
  readonly carrier_refund_cents: Cents;
  readonly received_on: PlainDate;
  readonly short_rate?: boolean;
  /** Overrides the removal recorded by `fpi.refund.posted` (e.g. when the advice arrives before the posting). */
  readonly removed_cents?: Cents;
  /** Rule 5: Fannie Mae already reimbursed the LPI premium under F-1-05 → remit within 30 days (15.2). */
  readonly fnma_claim_paid?: boolean;
  readonly fnma_claim_id?: string;
}
export interface CarrierRefundReconciliation {
  readonly duplicate: boolean;
  readonly binding_id: string;
  readonly advice_id: string;
  readonly carrier_refund_cents: Cents;
  readonly removed_cents: Cents | null;
  /** Rule 4/6: removal extended to the borrower − carrier's refund (short-rate, netting, delay) — the servicer's cost. */
  readonly servicer_cost_cents: Cents | null;
  readonly fnma_remit_due: PlainDate | null;
  readonly recon_deadline: PlainDate | null;
  readonly on_time: boolean | null;
  readonly ledger_set_id: string | null;
  readonly timer_satisfied: "INS_FPI_CARRIER_REFUND_RECON_45";
}
/**
 * Validates the inbound `refund_advice` record and reconciles it: the borrower's refund was never gated on it (rule 4),
 * so reconciliation only books the carrier's money against the removal and records the difference as servicer cost.
 * Requires the servicer's own `fpi.lpi.cancel_requested` for the binding (the clock this satisfies was armed by it).
 */
export function reconcileCarrierRefund(d: Fpi95Deps, a: CarrierRefundAdvice): CarrierRefundReconciliation {
  const loanId = nonEmpty(a.loan_id, "loan_id"); const bindingId = nonEmpty(a.binding_id, "binding_id"); const adviceId = nonEmpty(a.advice_id, "advice_id"); nonEmpty(a.carrier, "carrier");
  if (typeof a.carrier_refund_cents !== "bigint" || a.carrier_refund_cents < 0n) throw new RangeError("carrier_refund_cents must be a non-negative bigint");
  const receivedOn = plainDate(a.received_on);
  const request = byLoan(d, loanId, "fpi.lpi.cancel_requested").filter((e) => bindingOf(e) === bindingId).at(-1);
  if (!request) throw new RangeError(`no LPI cancel request for binding ${bindingId} on ${loanId} to reconcile the carrier refund against`);
  const prior = byLoan(d, loanId, "fpi.carrier_refund.reconciled").find((e) => payload<{ advice_id?: unknown }>(e).advice_id === adviceId);
  const requestedOn = ((): PlainDate => { const r = payload<{ request?: unknown }>(request).request; return typeof r === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r) ? plainDate(r) : plainDate(request.occurredAt.slice(0, 10)); })();
  const reconDeadline = addDays(requestedOn, CARRIER_REFUND_RECON_DAYS);
  if (prior) { const p = payload<{ carrier_refund_cents: Cents; removed_cents: Cents | null; servicer_cost_cents: Cents | null; fnma_remit_due: PlainDate | null; on_time: boolean; ledger_set_id: string | null }>(prior);
    return { duplicate: true, binding_id: bindingId, advice_id: adviceId, carrier_refund_cents: p.carrier_refund_cents, removed_cents: p.removed_cents, servicer_cost_cents: p.servicer_cost_cents, fnma_remit_due: p.fnma_remit_due, recon_deadline: reconDeadline, on_time: p.on_time, ledger_set_id: p.ledger_set_id, timer_satisfied: "INS_FPI_CARRIER_REFUND_RECON_45" }; }
  const posted = byLoan(d, loanId, "fpi.refund.posted").filter((e) => { const b = bindingOf(e); return b === null || b === bindingId; }).at(-1);
  const removed: Cents | null = a.removed_cents ?? (posted ? payload<{ removed_cents: Cents }>(posted).removed_cents : null);
  const cost = removed === null ? null : servicerNetCost(removed, a.carrier_refund_cents);
  const fnmaRemitDue = fnmaRemittanceDue(receivedOn, a.fnma_claim_paid === true);
  const actor = actorOf(d);
  d.events.append({ type: "fpi.carrier_refund.received", loanId, actor, payload: { binding_id: bindingId, advice_id: adviceId, carrier: a.carrier, carrier_refund_cents: a.carrier_refund_cents, received_at: receivedOn, short_rate: a.short_rate === true } });
  // Rule 6: carrier refund → Dr cash / Cr the refund receivable booked at posting; the residual stays as servicer cost.
  let set: EntrySet | null = null;
  if (d.ledger && a.carrier_refund_cents > 0n) set = d.ledger.post(carrierRefundSet(receivedOn, bindingId, adviceId, a.carrier_refund_cents));
  const onTime = receivedOn <= reconDeadline;
  d.events.append({ type: "fpi.carrier_refund.reconciled", loanId, actor, payload: { binding_id: bindingId, advice_id: adviceId, carrier: a.carrier, carrier_refund_cents: a.carrier_refund_cents, removed_cents: removed, servicer_cost_cents: cost, short_rate: a.short_rate === true, fnma_claim_paid: a.fnma_claim_paid === true, fnma_remit_due: fnmaRemitDue, recon_deadline: reconDeadline, on_time: onTime, reconciled_on: receivedOn, ledger_set_id: set?.id ?? null } });
  if (!onTime && d.escalations) d.escalations.open({ kind: "sev3", loanId, ownerRole: "vendor_management", severity: "sev3", payload: { code: "INS_FPI_CARRIER_REFUND_RECON_45", binding_id: bindingId, advice_id: adviceId, due: reconDeadline, received_on: receivedOn, why: "carrier refund advice after the 45-day reconciliation window — vendor follow-up" } }, actor);
  // Rule 5 / T6: unearned-premium refund after Fannie Mae reimbursed the premium → 15.2's 30-day remittance control (CRS 336).
  if (a.fnma_claim_paid === true) {
    d.events.append({ type: "expense_claim.credit.received", loanId, actor, payload: { loan_id: loanId, claim_id: a.fnma_claim_id ?? null, kind: "lpi_unearned_premium_refund", amount_cents: a.carrier_refund_cents, received_at: receivedOn, treatment: "remit_336", remit_code: 336, remit_due: fnmaRemitDue, fnma_reimbursed_premium: true, claim_paid: true, source: "9.5 carrier refund_advice", binding_id: bindingId } });
    if (d.escalations) d.escalations.open({ kind: "human_portal_task", loanId, ownerRole: "fnma_portal_operator", payload: { task: "15.2 remit unearned LPI premium refund (CRS 336, F-1-05)", amount_cents: a.carrier_refund_cents, due: fnmaRemitDue, binding_id: bindingId, advice_id: adviceId } }, actor);
  }
  return { duplicate: false, binding_id: bindingId, advice_id: adviceId, carrier_refund_cents: a.carrier_refund_cents, removed_cents: removed, servicer_cost_cents: cost, fnma_remit_due: fnmaRemitDue, recon_deadline: reconDeadline, on_time: onTime, ledger_set_id: set?.id ?? null, timer_satisfied: "INS_FPI_CARRIER_REFUND_RECON_45" };
}
/**
 * The `insurance-tracking/lpi` port answers a cancel with the binding; when the carrier's ack already carries the
 * refund figure (`refundCents`) it is the refund_advice — ingest it. Returns null when the ack carries no advice yet
 * (the 45-day reconciliation clock keeps running; the borrower's refund is unaffected either way).
 */
export function ingestLpiCancelAck(d: Fpi95Deps, i: { readonly loan_id: string; readonly binding: LpiBinding; readonly received_on: PlainDate; readonly carrier?: string; readonly fnma_claim_paid?: boolean; readonly fnma_claim_id?: string }): CarrierRefundReconciliation | null {
  if (i.binding.refundCents === undefined || !i.binding.cancelledOn) return null;
  return reconcileCarrierRefund(d, { loan_id: i.loan_id, binding_id: i.binding.bindingId, advice_id: `${i.binding.bindingId}:cancel_ack:${i.binding.cancelledOn}`, carrier: i.carrier ?? "lpi", carrier_refund_cents: i.binding.refundCents, received_on: i.received_on, ...(i.fnma_claim_paid !== undefined ? { fnma_claim_paid: i.fnma_claim_paid } : {}), ...(i.fnma_claim_id !== undefined ? { fnma_claim_id: i.fnma_claim_id } : {}) });
}

// ---- ledger sets (rule 3 two-sided correction; rule 6 worked entries) ------------------------------------------------
const LPI_REVERSAL_RULE = "9.5 rule 3(a) / §1024.37(g)(2) remove assessed charges";
const LPI_REFUND_RULE = "9.5 rule 3(b) / §1024.37(g)(2) refund paid charges";
const CARRIER_REFUND_RULE = "9.5 rule 6 carrier refund vs. lpi_refund_expense";
/**
 * Rule 3(a): remove the overlap premium from the account. Non-escrowed: Cr loan `corporate_advance` / Dr corporate
 * `advance_receivable` (the spec's `lpi_refund_expense (corporate) … pending carrier reimbursement` — the kernel ledger
 * has no expense account, so the receivable from the carrier carries it until reconciliation). Escrowed: the 3.7
 * reversal — Cr loan `escrow` (credit back) / Dr `custodial_ti_cash` mirrors the `lpi_premium` disbursement lines.
 */
export function lpiRemovalSet(i: { readonly loan_id: string; readonly removed_cents: Cents; readonly effective: PlainDate; readonly escrowed: boolean; readonly custodial_ti?: string; readonly original_set_id?: string; readonly binding_id?: string }): EntrySetInput {
  if (i.removed_cents <= 0n) throw new RangeError("removed_cents must be positive");
  const lines: LineInput[] = i.escrowed
    ? [{ account: { scope: "loan", loanId: i.loan_id, account: "escrow" }, amountCents: -i.removed_cents, ruleRef: LPI_REVERSAL_RULE, memo: "LPI overlap premium credited back to escrow (3.7 reversal)" },
       { account: { scope: "custodial", custodialAccountId: i.custodial_ti ?? "C-TI", account: "custodial_ti_cash" }, amountCents: i.removed_cents, ruleRef: LPI_REVERSAL_RULE, memo: "servicer funds the escrow credit pending the carrier refund (rule 4)" }]
    : [{ account: { scope: "loan", loanId: i.loan_id, account: "corporate_advance" }, amountCents: -i.removed_cents, ruleRef: LPI_REVERSAL_RULE, memo: "Cr corporate_advances — overlap charge removed" },
       { account: { scope: "corporate", account: "advance_receivable" }, amountCents: i.removed_cents, ruleRef: LPI_REVERSAL_RULE, memo: "Dr lpi_refund_expense (corporate) pending carrier reimbursement" }];
  return { effectiveDate: i.effective, description: `LPI overlap removal${i.binding_id ? ` ${i.binding_id}` : ""}: ${i.removed_cents} cents`, lines, ...(i.original_set_id ? { reversesSetId: i.original_set_id } : {}) };
}
/** Rule 3(b): the portion the borrower actually paid goes back out — ACH/check from corporate cash against the credit balance the removal left on the loan. Escrow credits and account credits move no cash (the removal already credited the account). */
export function lpiRefundPaymentSet(i: { readonly loan_id: string; readonly refund_cents: Cents; readonly effective: PlainDate; readonly rail: string; readonly escrowed?: boolean; readonly binding_id?: string }): EntrySetInput | null {
  if (i.refund_cents < 0n) throw new RangeError("refund_cents must not be negative");
  if (i.refund_cents === 0n || i.rail === "escrow_credit" || i.rail === "account_credit") return null;
  const acct = i.escrowed ? "escrow" : "corporate_advance";
  return { effectiveDate: i.effective, description: `LPI refund paid by ${i.rail}${i.binding_id ? ` ${i.binding_id}` : ""}: ${i.refund_cents} cents`, lines: [
    { account: { scope: "loan", loanId: i.loan_id, account: acct }, amountCents: i.refund_cents, ruleRef: LPI_REFUND_RULE, memo: `refund of charges paid (${i.rail})` },
    { account: { scope: "corporate", account: "corporate_cash" }, amountCents: -i.refund_cents, ruleRef: LPI_REFUND_RULE, memo: `money out by ${i.rail}` }] };
}
/** Rule 6: carrier refund received → Dr cash / Cr the receivable booked by lpiRemovalSet; the short-rate residual remains the servicer's cost. */
export function carrierRefundSet(receivedOn: PlainDate, bindingId: string, adviceId: string, carrierRefundCents: Cents): EntrySetInput {
  if (carrierRefundCents <= 0n) throw new RangeError("carrier_refund_cents must be positive");
  return { effectiveDate: receivedOn, description: `LPI carrier refund ${bindingId} advice ${adviceId}: ${carrierRefundCents} cents`, lines: [
    { account: { scope: "corporate", account: "corporate_cash" }, amountCents: carrierRefundCents, ruleRef: CARRIER_REFUND_RULE, memo: "Dr cash — carrier refund_advice" },
    { account: { scope: "corporate", account: "advance_receivable" }, amountCents: -carrierRefundCents, ruleRef: CARRIER_REFUND_RULE, memo: "Cr lpi_refund_expense — carrier reimbursement" }] };
}

// ---- officer breach-risk report (agent design: `officer` at day 12 if unpaid) ---------------------------------------
export interface BreachRiskInput { readonly loan_id: string; readonly evidence_received_on: PlainDate; readonly today: PlainDate; readonly paid: boolean; readonly deadline_days?: 15 | 30; readonly binding_id?: string; }
export interface BreachRiskResult { readonly day: number; readonly report_due: PlainDate; readonly deadline: PlainDate; readonly reported: boolean; readonly escalation: unknown; }
/**
 * Day 12 of the 15-day window (calendar days, like the deadline) with the refund unpaid → officer breach-risk report.
 * It never blocks the payment: the report is the escalation, paying is the cure (§1024.37(g); automation class "a").
 */
export function officerBreachRisk(d: Fpi95Deps, i: BreachRiskInput): BreachRiskResult {
  const loanId = nonEmpty(i.loan_id, "loan_id"); plainDate(i.evidence_received_on); plainDate(i.today);
  const day = daysBetween(i.evidence_received_on, i.today);
  const reportDue = addDays(i.evidence_received_on, OFFICER_BREACH_RISK_DAY);
  const deadline = addDays(i.evidence_received_on, i.deadline_days ?? 15);
  const due = !i.paid && day >= OFFICER_BREACH_RISK_DAY;
  const already = due && byLoan(d, loanId, "fpi.refund.breach_risk").some((e) => (i.binding_id ?? null) === (bindingOf(e) ?? null));
  let escalation: unknown = null;
  if (due && !already) {
    const actor = actorOf(d);
    escalation = d.escalations?.open({ kind: "officer", loanId, ownerRole: "officer", severity: day > (i.deadline_days ?? 15) ? "sev1" : "sev2", payload: { report: "9.5 breach-risk: LPI refund unpaid at day 12", day, deadline, binding_id: i.binding_id ?? null } }, actor) ?? null;
    d.events.append({ type: "fpi.refund.breach_risk", loanId, actor, payload: { binding_id: i.binding_id ?? null, day, report_due: reportDue, deadline, evidence_received_on: i.evidence_received_on, escalated_to: "officer" } });
  }
  return { day, report_due: reportDue, deadline, reported: due && !already, escalation };
}
