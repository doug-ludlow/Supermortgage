/**
 * §6.4 operating rules over the T&I reconciliation calculators (./reconciliation.ts, ./ops.ts) — the process's
 * event emitters. Each is a validated code path that appends the event a 6.4 registry row is armed or satisfied
 * by (src/kernel/timers/engine.ts matches them by type + payload field, same subject):
 *
 *   detectNegativeEscrow      day-close pass over the escrow trial balance (3.x negative-balance flags vs advances
 *                             funded): `reconciliation_item.opened{category=escrow_advance_unfunded}` and
 *                             `escrow.balance.negative_detected{unfunded_cents>0, detected_on}` — arms
 *                             SM_TI_ESCROW_ADVANCE_FUND_1BD (rule 2, 6.4-T2); a fully covered N emits nothing
 *   receiveLossDraft          ingestion of a 9.7 loss-draft register receipt into the `ti_loss_draft` sub-account:
 *                             `loss_draft.received{received_on}` arms FNMA_F496A_LOSS_DRAFT_AGED_7M on the receipt date
 *   disburseLossDraft         `loss_draft.disbursed{full}` — the row is satisfied only by the full disbursement
 *                             ("`loss_draft.disbursed` (full)"); a partial keeps the 7-month clock running (6.4-T3)
 *   openAttestationWindow     LL-2026-05 window for month M (BD3 of M+1 → BD2 of M+2 17:00 ET):
 *                             `escrow.attestation.window_opened{period, window_close_on}` arms
 *                             FNMA_LL202605_ESCROW_ATTEST_BD2_M2 (anchor `window_close_on`) and the
 *                             SM_F496A_BEFORE_ATTESTATION_GATE evaluator gate (6.4-T6)
 *   checkAttestationGate      the gate: opens the `human_portal_task` package (answer Yes/No + commentary) only when
 *                             the period's 496A is under review or later with a zero or explained variance; with no
 *                             draft 3 BD before the window closes → `officer` (6.4-T5/T6)
 *   restoreVoidedCheckFunds   rule 3 / 6.4-T4 after the positive-pay void: the ledger restore entry (cash back to the
 *                             originating balance) and the 6.5 unclaimed-property register row
 *
 * bigint cents; PlainDate + the servicer / Fannie Mae ET calendars; the ledger's allowed-transfer matrix (./ops.ts)
 * stays the guard on every posting the bus makes.
 */
import { type PlainDate, addMonths, endOfMonth, plainDate } from "../../kernel/calendar/date.ts";
import { wallClock, toIso } from "../../kernel/calendar/zoned.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import type { EntrySet, Ledger, LoanAccount } from "../../kernel/ledger/ledger.ts";
import { attestationVariance, attestationWindow, escrowAdvanceFunding, lossDraftAgedMonths } from "./reconciliation.ts";
import { ET, attestationGateEscalation } from "./ops.ts";

// ---- ports -----------------------------------------------------------------
/** What the 6.4 emitters need from a unit of work: the event spine, the actor and the clock; the ledger, the entity store and escalations when the caller has them. */
export interface ReconOps64 {
  readonly events: EventStore;
  readonly actor: Actor;
  /** ISO instant of the unit of work. */
  readonly now: string;
  readonly ledger?: Ledger;
  readonly store?: { get(kind: string, id: string): { readonly data: Record<string, unknown> } | undefined; put(kind: string, id: string, data: Record<string, unknown>, by: Actor, now: string): { readonly id: string; readonly data: Record<string, unknown> } };
  readonly escalations?: { open(input: { kind: "officer" | "human_portal_task"; ownerRole?: string; severity?: string; loanId?: string; payload?: Record<string, unknown> }, by: Actor): { id: string } };
}

const CUSTODIAL_ACCOUNT = "custodial_account";
const LOSS_DRAFT = "loss_draft";
/** The aggregate 3.7's `escrow.attestation.submitted` carries (escrow/ops-3-7 periodAggregate: `period` / `<servicer_number>:<period_key>`), so the platform's own submission satisfies the row this process arms. */
const periodAggregate = (servicerNumber: string, period: string): { kind: "period"; id: string } => ({ kind: "period", id: `${servicerNumber}:${period}` });
const todayOf = (ops: ReconOps64): PlainDate => wallClock(Date.parse(ops.now), ET).date;
const need = (cond: boolean, msg: string): void => { if (!cond) throw new RangeError(msg); };
const periodKey = (periodEnd: PlainDate): string => periodEnd.slice(0, 7);

// ---- rule 2: negative escrow balances → corporate advance within 1 BD --------
export interface NegativeEscrowInput { readonly custodial_account_id: string; readonly negatives: readonly { readonly loan_id: string; readonly balance_cents: Cents }[]; readonly advances_funded_cents: Cents; readonly detected_on?: PlainDate }
export interface NegativeEscrowResult extends ReturnType<typeof escrowAdvanceFunding> { readonly detected_on: PlainDate; readonly item_id: string | null; readonly event: DomainEvent | null }
/**
 * Day close: N (Σ |negative escrow balances|) against A (advances funded by the servicer). A net new negative not
 * covered by advances opens `escrow_advance_unfunded` for N − A and emits `escrow.balance.negative_detected`, which
 * arms SM_TI_ESCROW_ADVANCE_FUND_1BD on the detection date; `ledger.post_advance` (corporate → T&I) satisfies it.
 */
export function detectNegativeEscrow(ops: ReconOps64, f: NegativeEscrowInput): NegativeEscrowResult {
  need(f.custodial_account_id.length > 0, "custodial_account_id is required");
  need(f.advances_funded_cents >= 0n, "advances_funded_cents must be ≥ 0");
  for (const n of f.negatives) { need(n.loan_id.length > 0, "every negative balance carries a loan_id"); need(n.balance_cents < 0n, `${n.loan_id}: a negative-balance flag needs a balance below zero`); }
  const detected_on = f.detected_on ?? todayOf(ops);
  const r = escrowAdvanceFunding({ negatives: f.negatives, advances_funded_cents: f.advances_funded_cents, detected_on, funded_on: null, funded_cents: 0n });
  if (r.unfunded_cents === 0n || !r.item) return { ...r, detected_on, item_id: null, event: null };
  const aggregate = { kind: CUSTODIAL_ACCOUNT, id: f.custodial_account_id };
  const item_id = `eau-${f.custodial_account_id}-${detected_on}`;
  ops.events.append({ type: "reconciliation_item.opened", aggregate, actor: ops.actor, payload: { item_id, category: r.item.category, amount_cents: r.item.amount_cents, loans: r.item.loans, first_seen_on: detected_on, custodial_account_id: f.custodial_account_id, timer: r.timer, due_on: r.due_on } });
  const event = ops.events.append({ type: "escrow.balance.negative_detected", aggregate, actor: ops.actor, payload: { custodial_account_id: f.custodial_account_id, detected_on, negative_cents: r.N, advances_funded_cents: r.A, unfunded_cents: r.unfunded_cents, loans: r.item.loans, item_id, fund_by: r.due_on } });
  return { ...r, detected_on, item_id, event };
}

// ---- loss drafts (9.7 register → ti_loss_draft sub-account) ----------------
export interface LossDraftReceipt { readonly loan_id: string; readonly amount_cents: Cents; readonly received_on: PlainDate; readonly custodial_account_id: string; readonly claim_id?: string; readonly payer?: string }
/** A loss-draft receipt on the sub-account: validated, registered, and `loss_draft.received` appended (arms the 7-month flag on the receipt date). */
export function receiveLossDraft(ops: ReconOps64, f: LossDraftReceipt): { loss_draft_id: string; aged_7m_on: PlainDate; event: DomainEvent } {
  need(f.loan_id.length > 0, "loan_id is required");
  need(f.custodial_account_id.length > 0, "custodial_account_id is required");
  need(f.amount_cents > 0n, "a loss draft is a positive amount");
  need(f.received_on <= todayOf(ops), `received_on ${f.received_on} is after today ${todayOf(ops)}`);
  const loss_draft_id = f.claim_id ?? `${f.loan_id}:${f.received_on}`;
  const aged_7m_on = addMonths(f.received_on, 7);
  ops.store?.put("loss_drafts", loss_draft_id, { loan_id: f.loan_id, amount_cents: f.amount_cents, held_cents: f.amount_cents, received_on: f.received_on, custodial_account_id: f.custodial_account_id, status: "held", payer: f.payer ?? null, explanation: null, aged_7m_on }, ops.actor, ops.now);
  const event = ops.events.append({ type: "loss_draft.received", aggregate: { kind: LOSS_DRAFT, id: loss_draft_id }, actor: ops.actor, payload: { loss_draft_id, loan_id: f.loan_id, amount_cents: f.amount_cents, received_on: f.received_on, custodial_account_id: f.custodial_account_id, aged_7m_on } });
  return { loss_draft_id, aged_7m_on, event };
}
export interface LossDraftDisbursement { readonly loss_draft_id: string; readonly amount_cents: Cents; readonly disbursed_on?: PlainDate; /** funds still held before this disbursement; read from the register when omitted */ readonly held_cents?: Cents; readonly loan_id?: string }
/** A disbursement against a held loss draft: `loss_draft.disbursed{full}` — `full=true` (nothing left held) is what satisfies FNMA_F496A_LOSS_DRAFT_AGED_7M; a partial leaves the flag armed. */
export function disburseLossDraft(ops: ReconOps64, f: LossDraftDisbursement): { remaining_cents: Cents; full: boolean; age_months: number; event: DomainEvent } {
  need(f.loss_draft_id.length > 0, "loss_draft_id is required");
  need(f.amount_cents > 0n, "a disbursement is a positive amount");
  const rec = ops.store?.get("loss_drafts", f.loss_draft_id)?.data;
  const held = f.held_cents ?? (typeof rec?.held_cents === "bigint" ? rec.held_cents : undefined);
  need(held !== undefined, `${f.loss_draft_id}: held_cents is required when the draft is not on the register`);
  need(f.amount_cents <= held!, `${f.loss_draft_id}: disbursement ${f.amount_cents} exceeds the ${held} held`);
  const disbursed_on = f.disbursed_on ?? todayOf(ops);
  const remaining_cents = held! - f.amount_cents;
  const full = remaining_cents === 0n;
  const receivedOn = typeof rec?.received_on === "string" ? plainDate(rec.received_on) : disbursed_on;
  const loan_id = f.loan_id ?? (typeof rec?.loan_id === "string" ? rec.loan_id : null);
  if (rec) ops.store?.put("loss_drafts", f.loss_draft_id, { ...rec, held_cents: remaining_cents, status: full ? "disbursed" : "held", last_disbursed_on: disbursed_on }, ops.actor, ops.now);
  const event = ops.events.append({ type: "loss_draft.disbursed", aggregate: { kind: LOSS_DRAFT, id: f.loss_draft_id }, actor: ops.actor, payload: { loss_draft_id: f.loss_draft_id, loan_id, amount_cents: f.amount_cents, remaining_cents, full, disbursed_on } });
  return { remaining_cents, full, age_months: lossDraftAgedMonths(receivedOn, disbursed_on), event };
}

// ---- LL-2026-05 attestation window and the 496A gate -----------------------
/** The platform's monthly attestation window for `period_end`'s month: BD3 of M+1 (fannieEt) opens it; the event carries `window_close_on` (BD2 of M+2) as the deadline anchor. */
export function openAttestationWindow(ops: ReconOps64, f: { period_end: PlainDate; servicer_number: string; source?: "servicing_platform" | "calendar" }): { period: string; window: ReturnType<typeof attestationWindow>; event: DomainEvent } {
  need(endOfMonth(f.period_end) === f.period_end, `period_end ${f.period_end} is not a month end`);
  need(f.servicer_number.length > 0, "servicer_number is required");
  const window = attestationWindow(f.period_end);
  const today = todayOf(ops);
  need(today >= window.opens_on, `the attestation window for ${periodKey(f.period_end)} opens ${window.opens_on} (BD3 of M+1), not ${today}`);
  const period = periodKey(f.period_end);
  const event = ops.events.append({ type: "escrow.attestation.window_opened", aggregate: periodAggregate(f.servicer_number, period), actor: ops.actor, payload: { period, period_key: period, servicer_number: f.servicer_number, period_end: f.period_end, opens_on: window.opens_on, window_close_on: window.closes_on, closes_at: toIso(window.closes_at_ms), draft_warning_on: window.draft_warning_on, source: f.source ?? "servicing_platform" } });
  return { period, window, event };
}
export type Form496AStatus = Parameters<typeof attestationGateEscalation>[0]["form_496a_status"];
export interface AttestationGateInput {
  readonly period_end: PlainDate; readonly servicer_number: string; readonly form_496a_status: Form496AStatus;
  /** the tie-out (rule 4): the servicer's T&I ending balance vs Fannie Mae's computed balance, with the root-cause commentary for any difference */
  readonly servicer_ending_cents: Cents; readonly fnma_computed_cents: Cents; readonly commentary: string | null;
  readonly loan_count?: number; readonly contractual_escrow_sum_cents?: Cents;
}
export interface AttestationGateResult { readonly period: string; readonly gate_open: boolean; readonly blocks: "human_portal_task:escrow_attestation" | null; readonly variance: ReturnType<typeof attestationVariance>; readonly package: { period: string; answer: "Yes" | "No"; commentary: string | null; servicer_ending_cents: Cents; fnma_computed_cents: Cents; variance_cents: Cents; loan_count: number | null; contractual_escrow_sum_cents: Cents | null } | null; readonly portal_task_id: string | null; readonly escalation: { role: "officer"; reason: string; id: string | null } | null; readonly event: DomainEvent }
/**
 * SM_F496A_BEFORE_ATTESTATION_GATE: the attestation `human_portal_task` is created only once the period's Form 496A is
 * `under_review` or later with a zero or explained `attestation_variance`; the package answers "No" with the
 * commentary when the balances differ. Past the draft warning date (BD2 of M+2 − 3 BD) with no draft → `officer`.
 */
export function checkAttestationGate(ops: ReconOps64, f: AttestationGateInput): AttestationGateResult {
  const variance = attestationVariance(f.servicer_ending_cents, f.fnma_computed_cents, f.commentary);
  const g = attestationGateEscalation({ period_end: f.period_end, form_496a_status: f.form_496a_status, attestation_variance_cents: variance.variance_cents, variance_explained: variance.gate_open, today: todayOf(ops) });
  const period = periodKey(f.period_end);
  const aggregate = periodAggregate(f.servicer_number, period);
  need(f.servicer_number.length > 0, "servicer_number is required");
  const pkg = g.gate_open ? { period, answer: variance.answer, commentary: variance.commentary, servicer_ending_cents: f.servicer_ending_cents, fnma_computed_cents: f.fnma_computed_cents, variance_cents: variance.variance_cents, loan_count: f.loan_count ?? null, contractual_escrow_sum_cents: f.contractual_escrow_sum_cents ?? null } : null;
  const portal = pkg ? ops.escalations?.open({ kind: "human_portal_task", ownerRole: "fnma_portal_operator", payload: { task: "escrow_attestation", ...pkg } }, ops.actor) ?? null : null;
  const esc = g.escalation ? ops.escalations?.open({ kind: "officer", severity: "high", payload: { reason: g.escalation.reason, period, form_496a_status: f.form_496a_status, window_close_on: g.window.closes_on } }, ops.actor) ?? null : null;
  const event = ops.events.append({ type: g.gate_open ? "escrow.attestation.gate_opened" : "escrow.attestation.gate_blocked", aggregate, actor: ops.actor, payload: { period, form_496a_status: f.form_496a_status, attestation_variance_cents: variance.variance_cents, variance_explained: variance.gate_open, answer: variance.answer, commentary: variance.commentary, blocks: g.blocks, portal_task_id: portal?.id ?? null, officer_escalation_id: esc?.id ?? null, draft_warning_on: g.window.draft_warning_on } });
  return { period, gate_open: g.gate_open, blocks: g.blocks, variance, package: pkg, portal_task_id: portal?.id ?? null, escalation: g.escalation ? { ...g.escalation, id: esc?.id ?? null } : null, event };
}

// ---- rule 3: stale check void → funds restored, 6.5 track opened -----------
export type OriginatingBalance = "refund_payable" | "escrow" | "loss_draft_liability";
/** Ledger home of each originating balance: escrow back to the loan's escrow; a refund payable / loss-draft liability back to the borrower's unapplied funds (the 6.5 register tracks it from there). */
const RESTORE_ACCOUNT: Record<OriginatingBalance, LoanAccount> = { escrow: "escrow", refund_payable: "suspense_unapplied", loss_draft_liability: "suspense_unapplied" };
export interface VoidRestoreInput { readonly check_number: string; readonly amount_cents: Cents; readonly custodial_account_id: string; readonly loan_id: string | null; readonly originating_balance: OriginatingBalance; readonly issued_on: PlainDate; readonly next: "reissue" | "unclaimed_property_6_5" | null; readonly suspense_item: { source: "refund_returned"; reason_code: "returned_refund"; amount_cents: Cents; dormancy_start_on: PlainDate } | null }
export interface VoidRestoreResult { readonly restore_entry: EntrySet | null; readonly restore_to: OriginatingBalance; readonly suspense_item_id: string | null; readonly events: string[] }
/** After the positive-pay void (6.4-T4): cash returns to the originating balance on the ledger (a balanced set with `rule_ref` 6.4 rule 3) and, unless the payee is confirmed for reissue, the 6.5 unclaimed-property row opens with dormancy counted from issuance. */
export function restoreVoidedCheckFunds(ops: ReconOps64, f: VoidRestoreInput): VoidRestoreResult {
  need(f.check_number.length > 0, "check_number is required");
  need(f.amount_cents > 0n, "a voided check restores a positive amount");
  const today = todayOf(ops);
  const events: string[] = [];
  let restore_entry: EntrySet | null = null;
  if (ops.ledger && f.loan_id) {
    restore_entry = ops.ledger.post({ effectiveDate: today, description: `void stale check ${f.check_number}; funds restored to ${f.originating_balance}`, lines: [
      { account: { scope: "custodial", custodialAccountId: f.custodial_account_id, account: "custodial_ti_cash" }, amountCents: f.amount_cents, ruleRef: "6.4 rule 3 stale check" },
      { account: { scope: "loan", loanId: f.loan_id, account: RESTORE_ACCOUNT[f.originating_balance] }, amountCents: -f.amount_cents, ruleRef: "6.4 rule 3 stale check" }] }, ops.now);
  }
  const agg = { kind: "disbursement", id: f.check_number };
  ops.events.append({ type: "disbursement.funds_restored", ...(f.loan_id ? { loanId: f.loan_id } : {}), aggregate: agg, actor: ops.actor, payload: { check_number: f.check_number, amount_cents: f.amount_cents, restore_to: f.originating_balance, ledger_entry_id: restore_entry?.id ?? null, next: f.next } });
  events.push("disbursement.funds_restored");
  let suspense_item_id: string | null = null;
  if (f.suspense_item && f.next === "unclaimed_property_6_5") {
    suspense_item_id = `chk-${f.check_number}`;
    const row = { ...(f.loan_id ? { loan_id: f.loan_id } : {}), status: "open", reason_code: f.suspense_item.reason_code, source: f.suspense_item.source, amount_cents: f.suspense_item.amount_cents, received_on: today, dormancy_start_on: f.suspense_item.dormancy_start_on, check_number: f.check_number, custodial_account_id: f.custodial_account_id, originating_balance: f.originating_balance, track: "unclaimed_property" };
    ops.store?.put("suspense_items", suspense_item_id, row, ops.actor, ops.now);
    // the same shape 6.5's `suspense.read/write` emits, so its register timers see the item
    ops.events.append({ type: "suspense.item.created", ...(f.loan_id ? { loanId: f.loan_id } : {}), aggregate: { kind: "suspense_item", id: suspense_item_id }, actor: ops.actor, payload: { id: suspense_item_id, status: "open", reason_code: row.reason_code, source: row.source, amount_cents: row.amount_cents, received_on: today, loan_id: f.loan_id, dormancy_start_on: row.dormancy_start_on, check_number: f.check_number } });
    events.push("suspense.item.created");
  }
  return { restore_entry, restore_to: f.originating_balance, suspense_item_id, events };
}
