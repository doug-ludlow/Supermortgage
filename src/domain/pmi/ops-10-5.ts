/**
 * §10.5 process-owned operations — the LL-2026-05 escrow-event leg of the refund case and the LPMI payee guard.
 *
 * Investor reporting (spec 10.5 "Investor reporting" / "Outputs"): "From Dec. 1, 2026 the insurer's refund deposited
 * to the T&I custodial account and the disbursement to the borrower are escrow events (deposit/disbursement, category
 * Taxes & Insurance) reported by 3:00 a.m. ET next business day (Section 5; LL-2026-05)." The refund tools publish
 * `mi.refund.posted{escrow_event=true}` per leg (the LL_2026_05_ESCROW_EVENT_3AM trigger); this module turns the leg
 * into the submitted investor event and ingests Fannie Mae's acknowledgement, whose accepted/accepted_warning status
 * is the `escrow.event.accepted` fact the timer waits on (§3.7 vocabulary: `investor_events.status ∈ {accepted,
 * accepted_warning}`). Audit trail: `investor_events` rows plus the "escrow events acks" the spec lists as evidence.
 */
import type { CommandContext } from "../../app/commands.ts";
import type { ToolRuntime } from "../../app/tools.ts";
import { CommandRefused } from "../../app/commands.ts";
import type { PlainDate } from "../../kernel/calendar/date.ts";
import type { DomainEvent } from "../../kernel/events/index.ts";
import { refundEscrowEvents } from "./ops.ts";

export type EscrowEventAckStatus = "accepted" | "accepted_warning" | "rejected";
/** Fannie Mae's acknowledgement record for one submitted escrow event (LSDU feedback / escrow-event API response). */
export interface EscrowEventAck {
  readonly investor_event_id: string;
  readonly loan_id: string;
  readonly status: EscrowEventAckStatus;
  /** ISO instant the investor accepted/rejected the event. */
  readonly acked_at: string;
  readonly warnings?: readonly string[];
  readonly reject_reason?: string;
}

export interface RefundEscrowEventInput {
  readonly loan_id: string;
  readonly kind: "deposit" | "disbursement";
  /** Unsigned leg amount; the event carries the §3.7 signed amount (deposit +, disbursement −). */
  readonly amount_cents: bigint;
  readonly posted_on: PlainDate;
  /** Escrow balance after the posting (§3.7 rule 11); defaults to the loan's escrow ledger balance. */
  readonly balance_cents?: bigint;
  readonly refund_id?: string | null;
  readonly disbursement_id?: string | null;
}

const ACK_STATUSES: ReadonlySet<string> = new Set(["accepted", "accepted_warning", "rejected"]);

/**
 * Submit the refund leg as an LL-2026-05 escrow event. Before 2026-12-01 nothing is reported (Form 496A reconciliation
 * captures the flows, Section 6.4) and no timer arms; from that date the event is queued to Fannie Mae and
 * `escrow.event.submitted` records the 03:00 ET next-business-day acceptance deadline the row carries.
 */
export function submitRefundEscrowEvent(ctx: CommandContext, rt: ToolRuntime, i: RefundEscrowEventInput): { investor_event_id: string | null; escrow_event: boolean; accept_by_ms: number | null; sequence: number | null; reason: string | null } {
  if (i.amount_cents <= 0n) throw new RangeError("amount_cents must be positive (the leg amount; the sign follows the kind)");
  const ev = refundEscrowEvents({ posted_on: i.posted_on, legs: [{ kind: i.kind, amount_cents: i.amount_cents }] });
  if (ev.events.length === 0) return { investor_event_id: null, escrow_event: false, accept_by_ms: null, sequence: null, reason: ev.reason };
  const signed = i.kind === "deposit" ? i.amount_cents : -i.amount_cents;
  const balance = i.balance_cents ?? ctx.ledger.balance({ scope: "loan", loanId: i.loan_id, account: "escrow" });
  const sequence = rt.store.list("investor_events", (d) => d.loan_id === i.loan_id && d.event_family === "escrow").length + 1;
  const id = `esc-${i.loan_id}-${sequence}`;
  rt.store.put("investor_events", id, { loan_id: i.loan_id, event_family: "escrow", event_type: "escrow_event", category: "taxes_insurance", item: "Mortgage Insurance", kind: i.kind, amount_cents: signed, balance_cents: balance, sequence, posted_on: i.posted_on, accept_by_ms: ev.accept_by_ms, status: "submitted", channel: "fnma-lsdu", refund_id: i.refund_id ?? null, disbursement_id: i.disbursement_id ?? null }, ctx.actor, ctx.now);
  ctx.events.append({ type: "escrow.event.submitted", loanId: i.loan_id, actor: ctx.actor, payload: { investor_event_id: id, event_type: "escrow_event", category: "taxes_insurance", kind: i.kind, amount_cents: signed, balance_cents: balance, sequence, posted_on: i.posted_on, accept_by_ms: ev.accept_by_ms, refund_id: i.refund_id ?? null } });
  return { investor_event_id: id, escrow_event: true, accept_by_ms: ev.accept_by_ms, sequence, reason: null };
}

/** Validate an inbound acknowledgement record (an integration payload — never trusted as typed). */
export function parseEscrowEventAck(raw: unknown): EscrowEventAck {
  const r = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  if (!r) throw new RangeError("escrow event ack must be an object");
  for (const k of ["investor_event_id", "loan_id", "status", "acked_at"]) if (typeof r[k] !== "string" || r[k] === "") throw new RangeError(`escrow event ack: ${k} is required`);
  const status = String(r.status);
  if (!ACK_STATUSES.has(status)) throw new RangeError(`escrow event ack: status ${status} is not accepted/accepted_warning/rejected`);
  if (Number.isNaN(Date.parse(String(r.acked_at)))) throw new RangeError("escrow event ack: acked_at is not an ISO instant");
  const warnings = Array.isArray(r.warnings) ? r.warnings.map(String) : undefined;
  return { investor_event_id: String(r.investor_event_id), loan_id: String(r.loan_id), status: status as EscrowEventAckStatus, acked_at: String(r.acked_at), ...(warnings ? { warnings } : {}), ...(typeof r.reject_reason === "string" ? { reject_reason: r.reject_reason } : {}) };
}

/**
 * Ingest Fannie Mae's acknowledgement of a submitted refund escrow event. accepted/accepted_warning → the
 * `investor_events` row is closed and `escrow.event.accepted` is appended (satisfies LL_2026_05_ESCROW_EVENT_3AM;
 * `on_time` compares the ack instant with the 03:00 ET deadline the submission carried); rejected → the row is marked
 * and `escrow.event.rejected` routes the event to the §3.7 correction path (resubmit; the timer keeps running).
 */
export function ingestEscrowEventAck(ctx: CommandContext, rt: ToolRuntime, raw: unknown): { investor_event_id: string; status: EscrowEventAckStatus; on_time: boolean; event: DomainEvent } {
  const ack = parseEscrowEventAck(raw);
  const row = rt.store.get("investor_events", ack.investor_event_id);
  if (!row) throw new RangeError(`escrow event ack: no submitted investor event ${ack.investor_event_id}`);
  if (row.data.loan_id !== ack.loan_id) throw new RangeError(`escrow event ack: ${ack.investor_event_id} belongs to loan ${String(row.data.loan_id)}, not ${ack.loan_id}`);
  if (row.data.status !== "submitted" && row.data.status !== "rejected") throw new RangeError(`escrow event ack: ${ack.investor_event_id} is already ${String(row.data.status)}`);
  const acceptBy = typeof row.data.accept_by_ms === "number" ? row.data.accept_by_ms : null;
  const onTime = acceptBy !== null && Date.parse(ack.acked_at) <= acceptBy;
  rt.store.put("investor_events", ack.investor_event_id, { ...row.data, status: ack.status, acked_at: ack.acked_at, on_time: onTime, ...(ack.warnings ? { warnings: ack.warnings } : {}), ...(ack.reject_reason ? { reject_reason: ack.reject_reason } : {}) }, ctx.actor, ctx.now);
  const base = { investor_event_id: ack.investor_event_id, event_type: "escrow_event", category: "taxes_insurance", kind: row.data.kind, amount_cents: row.data.amount_cents, sequence: row.data.sequence, posted_on: row.data.posted_on, accept_by_ms: acceptBy, acked_at: ack.acked_at, on_time: onTime, refund_id: row.data.refund_id ?? null };
  if (ack.status === "rejected") {
    const event = ctx.events.append({ type: "escrow.event.rejected", loanId: ack.loan_id, actor: ctx.actor, payload: { ...base, status: "rejected", reject_reason: ack.reject_reason ?? null, route: "3.7 correction: resubmit the escrow event; LL_2026_05_ESCROW_EVENT_3AM keeps running" } });
    return { investor_event_id: ack.investor_event_id, status: "rejected", on_time: false, event };
  }
  const event = ctx.events.append({ type: "escrow.event.accepted", loanId: ack.loan_id, actor: ctx.actor, payload: { ...base, status: ack.status, warnings: ack.warnings ?? [] } });
  return { investor_event_id: ack.investor_event_id, status: ack.status, on_time: onTime, event };
}

/**
 * 10.5 guardrail "LPMI refunds never go to the borrower (B-8.1-02)" evaluated on the loan's policy of record, not only
 * on a `plan` the agent volunteers: a borrower-payee disbursement on a loan whose `mi_policies` row carries an LPMI
 * premium plan is refused and logged like any other guardrail refusal.
 */
export function refuseLpmiBorrowerPayee(ctx: CommandContext, rt: ToolRuntime, i: { loan_id: string; plan: string; payee: string; subject_id: string | null }): void {
  const stored = String(rt.store.get("mi_policies", i.loan_id)?.data.premium_plan ?? "");
  const lpmi = i.plan === "lpmi" || stored === "lpmi" || stored.startsWith("lpmi_");
  if (!lpmi || i.payee !== "borrower") return;
  const code = "LPMI_NEVER_TO_BORROWER", citation = "10.5 guardrail: LPMI refunds never go to the borrower (B-8.1-02)", reason = `policy of record is ${stored || i.plan}: LPMI refunds are corporate receipts`;
  ctx.events.append({ type: "command.refused", loanId: i.loan_id, actor: ctx.actor, payload: { command: "disbursements.issue", code, citation, reason, subject_id: i.subject_id } });
  throw new CommandRefused("disbursements.issue", code, citation, reason);
}
