/**
 * §1.6 operating rules over the pure calculators in reconciliation.ts and the emitters in inbound.ts — the code paths
 * behind the `custodial-recon` tools in src/app/tools/section1-6.ts. Each function validates its input, appends the
 * event the §1.6 timer table keys on and returns what the tool records:
 *
 *   reconcileLoanLevel          recon.loan.reconciled (SM_RECON_LOAN_LEVEL_T0) | recon.variance.raised per field (SM_RECON_VARIANCE_SLA_5),
 *                               recon.variance.resolved{transferor_corrected} when a corrected trial balance clears a raised field
 *   wireReceipt                 custodial.wire.received (bank feed; `transfer_funds_receipts` row, idempotent by wire reference in the tool)
 *   matchWireSet                recon.wires.matched (SM_RECON_WIRE_MATCH_1) | recon.variance.raised per unmatched wire (never plugged)
 *   reconcileFnmaPosition       recon.fnma_position.balanced (SM_RECON_FNMA_POSITION_EOM) | recon.variance.raised{fnma_reporting_lag | unknown}
 *   ingestFinalAccounting       transfer.final_accounting.received (FNMA_F1_11_FINAL_ACCOUNTING_30 satisfied; SM_ADVANCE_REIMBURSE_TRANSFEROR_30 armed)
 *   reimburseTransferorAdvances ledger.posted{advance_reimbursement_out} + transfer.advances.settled (SM_ADVANCE_REIMBURSE_TRANSFEROR_30)
 *   escrowContinuityDecision    escrow.computation_year.decided (SM_ESCROW_COMPUTATION_YEAR_DECISION_30) and, when the payment or the
 *                               method changes, escrow.terms.changed_at_transfer (REGX_1024_17E_INITIAL_ESCROW_STMT_60 trigger)
 *   inheritedUnappliedItem      suspense.item.created{reason_code=inherited_unapplied} — the 6.5 register row whose closure
 *                               (`suspense.item.closed`) satisfies SM_UNAPPLIED_INHERITED_REVIEW_60 (timers-1-6.ts)
 *
 * Money is bigint cents (payload money is stringified — the event log is JSON); dates are PlainDate; nothing here contacts
 * the borrower (escrow statements are Notice Registry outputs of 3.1).
 */
import { type PlainDate, addDays } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import type { EventStore, EventInput, Actor, DomainEvent } from "../../kernel/events/index.ts";
import type { Ledger, EntrySet } from "../../kernel/ledger/ledger.ts";
import { loanLevelRecon, raiseVariance, resolveVariance, fnmaPositionBalanced, finalAccountingReceived } from "./inbound.ts";
import { expectedWires, wireVariance, fnmaPositionRecon, classifyVariance, escrowContinuity, finalAccountingDue, type LoanBalances, type VarianceFacts, type VarianceCategory } from "./reconciliation.ts";

export const RULE_SET_VERSION_1_6 = { guide: "fnma.guide.f-1-11.2026-05-13", regx: "regx.1024-17.2026-09-03", ll: "fnma.ll-2026-05" } as const;
export const CUSTODIAL_RECON: Actor = { kind: "agent", id: "custodial-recon" };
export const ESCROW_AGENT: Actor = { kind: "agent", id: "escrow" };
const BATCH = (id: string) => ({ kind: "transfer_batch", id });
const money = (c: Cents): string => String(c);

// ============================================================ loan-level reconciliation (SM_RECON_LOAN_LEVEL_T0)
/** `recon_variances.field` (1.6 data model). */
export const RECON_FIELDS = ["upb", "lpi_date", "escrow_balance", "unapplied", "corporate_advances", "escrow_advances", "late_charges_due", "nsf_fees", "other_fees", "deferred_principal", "forborne_principal", "buydown_balance", "loss_draft_balance", "mi_accrual", "accrued_interest_dsi"] as const;
export type ReconField = (typeof RECON_FIELDS)[number];
export const varianceId = (batchId: string, field: string, loanId?: string | null): string => (loanId ? `${batchId}:${loanId}:${field}` : `${batchId}:${field}`);
/**
 * Loan-level reconciliation (1.6 rule 1, T3): every money field on the final tape must equal the trial balance to the
 * cent before the loan may board. Reconciled → `recon.loan.reconciled` on the loan (the not-before gate's satisfier);
 * otherwise one `recon.variance.raised` per differing field (the SLA clock arms per variance). A field raised earlier
 * that now agrees is resolved `transferor_corrected` against the corrected trial balance (`evidence_document_id`).
 */
export function reconcileLoanLevel(events: EventStore, i: { loan_id: string; batch_id: string; tape: Record<string, Cents>; trial_balance: Record<string, Cents>; reconciled_on: PlainDate; open_fields?: readonly string[]; evidence_document_id?: string | null; facts?: Omit<VarianceFacts, "difference_cents"> }, actor: Actor = CUSTODIAL_RECON): {
  status: "reconciled" | "variance"; gate: "SM_RECON_LOAN_LEVEL_T0"; boardable: boolean; variances: { variance_id: string; field: string; tape: Cents; trial_balance: Cents; difference_cents: Cents; category: VarianceCategory }[]; resolved: string[]; events: DomainEvent[];
} {
  if (!i.loan_id || !i.batch_id) throw new RangeError("loan_id and batch_id are required");
  const fields = Object.keys(i.tape);
  if (fields.length === 0) throw new RangeError("tape carries no money fields to reconcile");
  const unknown = fields.filter((f) => !(RECON_FIELDS as readonly string[]).includes(f));
  if (unknown.length) throw new RangeError(`not recon_variances.field values: ${unknown.join(", ")}`);
  const r = loanLevelRecon(i.tape, i.trial_balance);
  const out: DomainEvent[] = [];
  const variances = r.variances.map((v) => {
    const difference_cents = v.trial_balance - v.tape;
    const category = classifyVariance({ difference_cents, ...(i.facts ?? {}) });
    const variance_id = varianceId(i.batch_id, v.field, i.loan_id);
    if (!(i.open_fields ?? []).includes(v.field)) out.push(raiseVariance(events, { variance_id, batch_id: i.batch_id, loan_id: i.loan_id, field: v.field, difference_cents, category }, i.reconciled_on, actor));
    return { variance_id, field: v.field, tape: v.tape, trial_balance: v.trial_balance, difference_cents, category };
  });
  const resolved = (i.open_fields ?? []).filter((f) => !r.variances.some((v) => v.field === f) && i.tape[f] !== undefined && i.trial_balance[f] !== undefined);
  for (const f of resolved) out.push(resolveVariance(events, { variance_id: varianceId(i.batch_id, f, i.loan_id), loan_id: i.loan_id, resolution: "transferor_corrected", evidence_document_id: i.evidence_document_id ?? null }, i.reconciled_on, actor));
  if (r.status === "reconciled") out.push(events.append({ type: "recon.loan.reconciled", loanId: i.loan_id, aggregate: BATCH(i.batch_id), actor, payload: { loan_id: i.loan_id, batch_id: i.batch_id, fields, reconciled_on: i.reconciled_on, gate: r.gate } }));
  return { status: r.status, gate: r.gate, boardable: r.status === "reconciled", variances, resolved, events: out };
}

// ============================================================ wires (SM_RECON_WIRE_MATCH_1)
/** `transfer_funds_receipts.kind` (1.6 data model). */
export const RECEIPT_KINDS = ["pi_unremitted", "unapplied", "escrow", "loss_draft", "buydown", "mi_accrual", "interim_forwarded_payments", "advance_reimbursement_out"] as const;
export type ReceiptKind = (typeof RECEIPT_KINDS)[number];
export type WireKind = "ti" | "pi" | "other";
/** Which wire a receipt kind lands in: T&I = escrow; P&I (by remittance type) = unremitted P&I + unapplied + interim forwarded payments; other = loss drafts, buydown, MI accruals. */
export const wireOf = (kind: ReceiptKind): WireKind | null => (kind === "escrow" ? "ti" : kind === "pi_unremitted" || kind === "unapplied" || kind === "interim_forwarded_payments" ? "pi" : kind === "advance_reimbursement_out" ? null : "other");
export interface WireReceiptInput { readonly batch_id: string; readonly custodial_account_id: string; readonly kind: ReceiptKind; readonly amount_cents: Cents; readonly received_on: PlainDate; readonly wire_reference: string; readonly sender?: string | null; readonly expected_cents?: Cents | null; }
/** The bank feed's wire advice as a `transfer_funds_receipts` row and its `custodial.wire.received` event (idempotent by bank reference in the tool). */
export function wireReceipt(i: WireReceiptInput): { row: Record<string, unknown>; event: EventInput } {
  if (!i.batch_id || !i.custodial_account_id || !i.wire_reference) throw new RangeError("batch_id, custodial_account_id and wire_reference are required");
  if (!(RECEIPT_KINDS as readonly string[]).includes(i.kind)) throw new RangeError(`kind must be one of ${RECEIPT_KINDS.join(", ")}`);
  if (i.amount_cents <= 0n) throw new RangeError("a wire receipt is a positive amount");
  const row = { batch_id: i.batch_id, custodial_account_id: i.custodial_account_id, kind: i.kind, wire: wireOf(i.kind), expected_cents: i.expected_cents === undefined || i.expected_cents === null ? null : money(i.expected_cents), received_cents: money(i.amount_cents), received_at: i.received_on, wire_reference: i.wire_reference, sender: i.sender ?? null, matched_at: null, variance_id: null };
  return { row, event: { type: "custodial.wire.received", aggregate: BATCH(i.batch_id), actor: { kind: "external", id: "custodial-bank" }, payload: { ...row, amount_cents: money(i.amount_cents) } } };
}
/** Σ received by wire from the batch's receipt rows (money fields are stored as strings). */
export function receiptsByWire(rows: readonly Record<string, unknown>[]): Record<WireKind, Cents> {
  const out: Record<WireKind, Cents> = { ti: 0n, pi: 0n, other: 0n };
  for (const r of rows) { const w = wireOf(String(r.kind) as ReceiptKind); if (w) out[w] += BigInt(String(r.received_cents ?? 0)); }
  return out;
}
/**
 * Wire match (1.6 rule 1, T1/T2): wires must equal trial-balance totals by category. Both equal → `recon.wires.matched`
 * (SM_RECON_WIRE_MATCH_1); any difference → one `recon.variance.raised` per wire, category by evidence (an unexplained
 * amount stays `unknown` → transferor query, SLA 5 servicer business days) and the batch stays in `variances_open`.
 */
export function matchWireSet(events: EventStore, i: { batch_id: string; loans: readonly LoanBalances[]; ti_received_cents: Cents; pi_received_cents: Cents; other_received_cents?: Cents; today: PlainDate; include_escrow_interest_month?: boolean; open_variances?: readonly string[]; facts?: Omit<VarianceFacts, "difference_cents"> }, actor: Actor = CUSTODIAL_RECON): {
  expected: ReturnType<typeof expectedWires>; ti: ReturnType<typeof wireVariance>; pi: ReturnType<typeof wireVariance>; wires_matched: boolean; batch_status: "wires_matched" | "variances_open"; variances_raised: { variance_id: string; wire: WireKind; difference_cents: Cents; category: VarianceCategory; sla_due: PlainDate }[]; event: DomainEvent | null;
} {
  if (!i.batch_id) throw new RangeError("batch_id is required");
  if (i.loans.length === 0) throw new RangeError("the batch's loan balances are required to compute the expected wires");
  const expected = expectedWires(i.loans, i.include_escrow_interest_month ?? false);
  const ti = wireVariance(expected.ti_wire_cents, i.ti_received_cents, "ti", i.today, i.facts ?? {}), pi = wireVariance(expected.pi_wire_cents, i.pi_received_cents, "pi", i.today, i.facts ?? {});
  const matched = !ti.blocks_wires_matched && !pi.blocks_wires_matched;
  const variances_raised: { variance_id: string; wire: WireKind; difference_cents: Cents; category: VarianceCategory; sla_due: PlainDate }[] = [];
  for (const v of [ti, pi]) {
    if (!v.blocks_wires_matched) continue;
    const variance_id = varianceId(i.batch_id, `${v.wire}_wire`);
    if ((i.open_variances ?? []).includes(variance_id)) continue;
    raiseVariance(events, { variance_id, batch_id: i.batch_id, field: `${v.wire}_wire`, difference_cents: v.variance_cents, category: v.category }, i.today, actor);
    variances_raised.push({ variance_id, wire: v.wire, difference_cents: v.variance_cents, category: v.category, sla_due: v.sla_due ?? addBusinessDays(i.today, 5, servicer) });
  }
  const event = matched ? events.append({ type: "recon.wires.matched", aggregate: BATCH(i.batch_id), actor, payload: { batch_id: i.batch_id, ti_cents: money(expected.ti_wire_cents), pi_cents: money(expected.pi_wire_cents), other_cents: money(i.other_received_cents ?? 0n), matched_on: i.today } }) : null;
  return { expected, ti, pi, wires_matched: matched, batch_status: matched ? "wires_matched" : "variances_open", variances_raised, event };
}

// ============================================================ Fannie Mae position (SM_RECON_FNMA_POSITION_EOM)
/**
 * Σ boarded UPB by servicer number × remittance type against the LSDU position (1.6 rule 4, T7). A pre-transfer figure
 * before the transferor's transfer-month LAR posts is `fnma_reporting_lag` and must clear by the last Fannie Mae business
 * day of the transfer month; balanced → `recon.fnma_position.balanced` and the open lag variance resolves against the
 * position snapshot (`transferor_corrected`: the transferor's LAR posted).
 */
export function reconcileFnmaPosition(events: EventStore, i: { batch_id: string; transfer_date: PlainDate; as_of: PlainDate; boarded_upb_cents: Cents; fnma_position_upb_cents: Cents; transferor_pre_transfer_upb_cents?: Cents | null; transferor_lar_posted: boolean; variance_open?: boolean; snapshot_document_id?: string | null }, actor: Actor = CUSTODIAL_RECON): ReturnType<typeof fnmaPositionRecon> & { variance_id: string; raised: boolean; resolved: boolean; event: DomainEvent | null } {
  if (!i.batch_id) throw new RangeError("batch_id is required");
  const r = fnmaPositionRecon(i);
  const variance_id = varianceId(i.batch_id, "fnma_position");
  if (r.balanced) {
    const event = fnmaPositionBalanced(events, i.batch_id, { as_of: i.as_of, boarded_upb_cents: i.boarded_upb_cents, fnma_position_upb_cents: i.fnma_position_upb_cents }, actor);
    if (i.variance_open) resolveVariance(events, { variance_id, resolution: "transferor_corrected", evidence_document_id: i.snapshot_document_id ?? null }, i.as_of, actor);
    return { ...r, variance_id, raised: false, resolved: i.variance_open === true, event };
  }
  if (i.variance_open) return { ...r, variance_id, raised: false, resolved: false, event: null };
  return { ...r, variance_id, raised: true, resolved: false, event: raiseVariance(events, { variance_id, batch_id: i.batch_id, field: "upb", difference_cents: r.difference_cents, category: r.category }, i.as_of, actor) };
}

// ============================================================ final accounting (FNMA_F1_11_FINAL_ACCOUNTING_30 → SM_ADVANCE_REIMBURSE_TRANSFEROR_30)
export interface FinalAccountingInput { readonly batch_id: string; readonly document_id: string; readonly received_on: PlainDate; readonly transfer_date: PlainDate; readonly advances_claimed_cents: Cents; readonly shortage_surplus_cents: Cents; readonly fnma_adjustment_request_document_id: string | null; }
/** The transferor's post-transfer accounting from the SFTP adapter (F-1-11): validated, then `transfer.final_accounting.received` with the advances claimed and the shortage/surplus. */
export function ingestFinalAccounting(events: EventStore, i: FinalAccountingInput): { event: DomainEvent; late: boolean; due: PlainDate; advances_claimed_cents: Cents; shortage_surplus_cents: Cents; adjustment_request_evidenced: boolean } {
  if (!i.batch_id || !i.document_id) throw new RangeError("batch_id and document_id are required");
  if (i.advances_claimed_cents < 0n) throw new RangeError("advances claimed cannot be negative");
  const due = finalAccountingDue(i.transfer_date);
  const event = finalAccountingReceived(events, i.batch_id, { document_id: i.document_id, received_on: i.received_on, advances_claimed_cents: i.advances_claimed_cents, shortage_surplus_cents: i.shortage_surplus_cents, fnma_adjustment_request_document_id: i.fnma_adjustment_request_document_id });
  return { event, late: i.received_on > due, due, advances_claimed_cents: i.advances_claimed_cents, shortage_surplus_cents: i.shortage_surplus_cents, adjustment_request_evidenced: i.fnma_adjustment_request_document_id !== null };
}

// ============================================================ advances reimbursement (SM_ADVANCE_REIMBURSE_TRANSFEROR_30)
export interface ReimbursementInput { readonly batch_id: string; readonly custodial_account_id: string; readonly paid_on: PlainDate; readonly amount_cents: Cents; readonly netted_cents?: Cents; readonly substantiated_cents: Cents; readonly final_accounting_document_id: string; readonly wire_reference?: string | null; }
/**
 * F-1-11: "the transferee servicer must reimburse the transferor servicer once it receives a final accounting" — only for
 * amounts substantiated in it (1.6 rule 5). Settlement nets against the transferor's own obligations by default (open
 * question 3): Dr `transfer_in_clearing` (the due-to-transferor side of the boarded receivables) / Cr `corporate_cash` for
 * the wire / Cr `advance_receivable` for the netted portion. Emits `ledger.posted{advance_reimbursement_out}`.
 */
export function reimburseTransferorAdvances(ledger: Ledger, events: EventStore, i: ReimbursementInput, actor: Actor, now: string): { set: EntrySet; amount_cents: Cents; netted_cents: Cents; settled_cents: Cents; unsettled_cents: Cents; events: DomainEvent[] } {
  if (!i.batch_id || !i.custodial_account_id) throw new RangeError("batch_id and custodial_account_id are required");
  const netted = i.netted_cents ?? 0n;
  if (i.amount_cents < 0n || netted < 0n || i.amount_cents + netted <= 0n) throw new RangeError("the reimbursement (wire + netting) must be a positive amount");
  if (i.amount_cents + netted > i.substantiated_cents) throw new RangeError(`reimbursement ${i.amount_cents + netted} exceeds the ${i.substantiated_cents} cents substantiated in final accounting ${i.final_accounting_document_id} (F-1-11)`);
  const ruleRef = "1.6 funds: advance_reimbursement_out";
  const lines = [
    { account: { scope: "custodial" as const, custodialAccountId: i.custodial_account_id, account: "transfer_in_clearing" as const }, amountCents: i.amount_cents + netted, ruleRef, memo: `due_to_transferor settled per final accounting ${i.final_accounting_document_id}` },
    ...(i.amount_cents > 0n ? [{ account: { scope: "corporate" as const, account: "corporate_cash" as const }, amountCents: -i.amount_cents, ruleRef, memo: `wire to transferor${i.wire_reference ? ` ${i.wire_reference}` : ""}` }] : []),
    ...(netted > 0n ? [{ account: { scope: "corporate" as const, account: "advance_receivable" as const }, amountCents: -netted, ruleRef, memo: "netted against amounts due from the transferor" }] : []),
  ];
  const set = ledger.post({ effectiveDate: i.paid_on, description: `advances reimbursement to the transferor (batch ${i.batch_id})`, lines }, now);
  const settled = i.amount_cents + netted;
  const posted = events.append({ type: "ledger.posted", aggregate: BATCH(i.batch_id), actor, payload: { advance_reimbursement_out: true, batch_id: i.batch_id, amount_cents: money(i.amount_cents), netted_cents: money(netted), settled_cents: money(settled), set_id: set.id, paid_on: i.paid_on, rule_ref: ruleRef, final_accounting_document_id: i.final_accounting_document_id } });
  const done = events.append({ type: "transfer.advances.settled", aggregate: BATCH(i.batch_id), actor, payload: { batch_id: i.batch_id, settled_cents: money(settled), unsettled_cents: money(i.substantiated_cents - settled), paid_on: i.paid_on, set_id: set.id } });
  return { set, amount_cents: i.amount_cents, netted_cents: netted, settled_cents: settled, unsettled_cents: i.substantiated_cents - settled, events: [posted, done] };
}

// ============================================================ escrow continuity (SM_ESCROW_COMPUTATION_YEAR_DECISION_30 / REGX_1024_17E_INITIAL_ESCROW_STMT_60)
export type EscrowMethod = "aggregate" | "single_item";
/** The transferor's last analysis, seeded into `escrow_analyses` with `source='transferor'`. */
export interface TransferorEscrowAnalysis { readonly analysis_date: PlainDate; readonly computation_year_start: PlainDate; readonly monthly_escrow_cents: Cents; readonly cushion_cents: Cents; readonly shortage_cents: Cents; readonly surplus_cents: Cents; readonly deficiency_cents: Cents; readonly shortage_spread_months: number | null; readonly method: EscrowMethod; }
export const SURPLUS_REFUND_FLOOR_CENTS: Cents = 5_000n;   // §1024.17(f)(2)(i): surplus ≥ $50 refunded within 30 days
export const MIN_SHORTAGE_SPREAD_MONTHS = 12;               // §1024.17(f)(3): shortage spread over ≥ 12 months
/** §1024.17(f) treatment of the inherited shortage / surplus / deficiency (§1024.17(e)(1): the new servicer treats them under (f)). */
export function inheritedBalanceTreatment(a: TransferorEscrowAnalysis): { surplus: "refund_within_30_days" | "credit_or_refund" | "none"; surplus_refund_due: PlainDate | null; shortage: "spread_12_months_or_more" | "collect_30_days_or_spread" | "none"; shortage_spread_months: number | null; deficiency: "collect_30_days_or_spread_2_to_12" | "spread_2_to_12_months" | "none" } {
  const oneMonth = a.monthly_escrow_cents;
  return {
    surplus: a.surplus_cents >= SURPLUS_REFUND_FLOOR_CENTS ? "refund_within_30_days" : a.surplus_cents > 0n ? "credit_or_refund" : "none",
    surplus_refund_due: a.surplus_cents >= SURPLUS_REFUND_FLOOR_CENTS ? addDays(a.analysis_date, 30) : null,
    shortage: a.shortage_cents <= 0n ? "none" : a.shortage_cents < oneMonth ? "collect_30_days_or_spread" : "spread_12_months_or_more",
    shortage_spread_months: a.shortage_cents <= 0n ? null : Math.max(MIN_SHORTAGE_SPREAD_MONTHS, a.shortage_spread_months ?? MIN_SHORTAGE_SPREAD_MONTHS),
    deficiency: a.deficiency_cents <= 0n ? "none" : a.deficiency_cents < oneMonth ? "collect_30_days_or_spread_2_to_12" : "spread_2_to_12_months",
  };
}
export interface EscrowContinuityInput { readonly loan_id: string; readonly batch_id: string; readonly transfer_date: PlainDate; readonly decided_on: PlainDate; readonly transferor: TransferorEscrowAnalysis; readonly supermortgage: { readonly monthly_escrow_cents: Cents; readonly method?: EscrowMethod; readonly short_year_statement?: boolean }; }
/**
 * The `escrow` agent's computation-year decision (1.6 rule 3; §1024.17(e)(1)): keeping the transferor's monthly escrow
 * payment and aggregate method → no initial statement, computation year retained (default) or a short-year statement
 * (3.3); a payment or method change → initial escrow statement within 60 days of transfer and a new computation year from
 * the transfer date. §1024.17(c)(4) makes aggregate accounting mandatory, so a single-item transferor is a method change.
 */
export function escrowContinuityDecision(events: EventStore, i: EscrowContinuityInput, actor: Actor = ESCROW_AGENT): {
  decision: "retained" | "short_year" | "new_year"; computation_year_start: PlainDate; initial_statement_due: PlainDate | null; initial_statement_required: boolean; payment_changed: boolean; method_changed: boolean; method: EscrowMethod;
  inherited: ReturnType<typeof inheritedBalanceTreatment>; escrow_analysis_seed: Record<string, unknown>; events: DomainEvent[]; timer_satisfied: "SM_ESCROW_COMPUTATION_YEAR_DECISION_30";
} {
  if (!i.loan_id || !i.batch_id) throw new RangeError("loan_id and batch_id are required");
  if (i.supermortgage.monthly_escrow_cents < 0n || i.transferor.monthly_escrow_cents < 0n) throw new RangeError("monthly escrow payments cannot be negative");
  const method = i.supermortgage.method ?? "aggregate";
  const payment_changed = i.supermortgage.monthly_escrow_cents !== i.transferor.monthly_escrow_cents;
  const method_changed = method !== i.transferor.method;
  const c = escrowContinuity(!payment_changed, !method_changed, i.transfer_date);
  const retained = c.computation_year_start === "retained";
  const decision = retained ? (i.supermortgage.short_year_statement ? "short_year" : "retained") : "new_year";
  const computation_year_start = retained ? (i.supermortgage.short_year_statement ? i.transfer_date : i.transferor.computation_year_start) : (c.computation_year_start as PlainDate);
  const inherited = inheritedBalanceTreatment(i.transferor);
  const base = { loan_id: i.loan_id, batch_id: i.batch_id, transfer_date: i.transfer_date, decision, computation_year_start, payment_changed, method_changed, method, transferor_monthly_escrow_cents: money(i.transferor.monthly_escrow_cents), monthly_escrow_cents: money(i.supermortgage.monthly_escrow_cents), initial_statement_due: c.initial_statement_due, decided_on: i.decided_on, rule_ref: "§1024.17(e)(1)" };
  const out: DomainEvent[] = [events.append({ type: "escrow.computation_year.decided", loanId: i.loan_id, aggregate: BATCH(i.batch_id), actor, payload: { ...base, inherited } })];
  if (!retained) out.push(events.append({ type: "escrow.terms.changed_at_transfer", loanId: i.loan_id, aggregate: BATCH(i.batch_id), actor, payload: { ...base, statement: "NTC_REGX_1024_17G_INITIAL_ESCROW_STMT" } }));
  const escrow_analysis_seed = { loan_id: i.loan_id, source: "transferor", analysis_date: i.transferor.analysis_date, computation_year_start: i.transferor.computation_year_start, monthly_escrow_cents: money(i.transferor.monthly_escrow_cents), cushion_cents: money(i.transferor.cushion_cents), shortage_cents: money(i.transferor.shortage_cents), surplus_cents: money(i.transferor.surplus_cents), deficiency_cents: money(i.transferor.deficiency_cents), shortage_spread_months: inherited.shortage_spread_months, method: i.transferor.method, continuity: decision, supermortgage_computation_year_start: computation_year_start };
  return { decision, computation_year_start, initial_statement_due: c.initial_statement_due, initial_statement_required: !retained, payment_changed, method_changed, method, inherited, escrow_analysis_seed, events: out, timer_satisfied: "SM_ESCROW_COMPUTATION_YEAR_DECISION_30" };
}

// ============================================================ inherited unapplied (SM_UNAPPLIED_INHERITED_REVIEW_60)
export const INHERITED_UNAPPLIED_REVIEW_DAYS = 60;
export const inheritedUnappliedId = (loanId: string): string => `inherited-unapplied:${loanId}`;
/**
 * The unapplied balance boarded with the loan (Cr `suspense_unapplied` at `loan.boarded`) becomes a 6.5 register item
 * (`suspense_items`, reason_code `inherited_unapplied`, source `transfer_in`) so it is triaged, aged and resolved through
 * 6.5's own tools; its closure is what SM_UNAPPLIED_INHERITED_REVIEW_60 waits for (A2-7-03: review subsequent collection of
 * funds; 14.1: a debtor's post-petition remittances stay post-petition suspense).
 */
export function inheritedUnappliedItem(i: { loan_id: string; batch_id: string; transfer_date: PlainDate; unapplied_cents: Cents; postpetition?: boolean }): { id: string; row: Record<string, unknown>; event: EventInput; review_due: PlainDate } {
  if (!i.loan_id || !i.batch_id) throw new RangeError("loan_id and batch_id are required");
  if (i.unapplied_cents <= 0n) throw new RangeError("no inherited unapplied balance to review (unapplied_cents must be positive)");
  const id = inheritedUnappliedId(i.loan_id);
  const review_due = addDays(i.transfer_date, INHERITED_UNAPPLIED_REVIEW_DAYS);
  const row = { id, loan_id: i.loan_id, batch_id: i.batch_id, status: "open", reason_code: "inherited_unapplied", source: "transfer_in", amount_cents: money(i.unapplied_cents), received_on: i.transfer_date, transfer_date: i.transfer_date, postpetition: i.postpetition ?? false, review_due, review_timer: "SM_UNAPPLIED_INHERITED_REVIEW_60" };
  return { id, row, review_due, event: { type: "suspense.item.created", loanId: i.loan_id, aggregate: { kind: "suspense_item", id }, actor: CUSTODIAL_RECON, payload: { ...row } } };
}
