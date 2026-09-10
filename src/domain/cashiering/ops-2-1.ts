/**
 * §2.1 process-owned operations.
 *
 *  - Lockbox intake — the ingestion handler for the `lockbox.batch.received` input (2.1 Inputs and triggers: "daily
 *    file + images"). It validates the inbound batch (bank batch id, the lockbox agent's receipt date, item amounts,
 *    control total) and appends `lockbox.batch.received` for the batch — the event `FNMA_C1101_LOCKBOX_CLEARING_1BD`
 *    (1 BD to the collection clearing account) and `FNMA_C1101_LOCKBOX_CUSTODIAL_2BD` (2 BD to the custodial account)
 *    arm on, anchored on `lockbox_receipt_date` (C-1.1-01: "no later than the 1st/2nd business day after they are
 *    received by the lockbox agent"). Each fresh item is then received through `CashieringService.receive` on the
 *    `lockbox` channel (rule 1: the agent's receipt date, 5:00 p.m. local cut-off → next business day) so the Reg Z
 *    date of receipt, conformity and the written-requirements version are recorded per payment. A replayed file or a
 *    re-sent file with changed items produces `lockbox.batch.exception`, never a re-post (Edge cases: "Duplicate
 *    files/replays"). Unidentified items are routed to 6.5 (`lockbox.item.unidentified`).
 *  - The periodic-statement read model (Outputs: `statement_payment_breakdown` — Reg Z §1026.41(d)(3) amounts applied
 *    and (d)(4) transaction activity, which lists a payment and its reversal as two transactions — 2.1-T8).
 *
 * Money is bigint cents; dates are PlainDate; nothing here edits a row.
 */
import type { EventStore, Actor, DomainEvent } from "../../kernel/events/index.ts";
import { plainDate, type PlainDate } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import type { LockboxIngest } from "../../infra/integrations/banking.ts";
import type { CashieringService } from "./service.ts";
import type { Payment } from "./types.ts";
import { DEFAULT_CHANNELS } from "./receipt.ts";
import { CASHIERING_OPS_ACTOR } from "./ops.ts";

export interface LockboxBatchItem {
  readonly sequence: number;
  readonly amount_cents: Cents;
  /** OCR-A scanline (loan number + coupon fields) — the deterministic identification key (rule 4). */
  readonly scanline: string;
  readonly bank_reference: string;
}

/** One bank batch of the daily lockbox file (idempotency = bank batch id + item sequence). */
export interface LockboxBatchRecord {
  readonly batch_id: string;
  readonly file_id: string;
  readonly file_hash: string;
  /** The lockbox agent's receipt date (the bank's as-of/deposit date) — the anchor of the 1-BD / 2-BD deposit clocks. */
  readonly lockbox_receipt_date: PlainDate;
  /** Instant the agent scanned the batch (as-of date + as-of time in the lockbox's local zone); the items' `received_at`. */
  readonly received_at: string;
  readonly items: readonly LockboxBatchItem[];
}

export interface LockboxBatchReceipt {
  readonly event: DomainEvent;
  readonly payments: Payment[];
  readonly unidentified: readonly string[];
  readonly control_total_cents: Cents;
}

export interface LockboxIntakeDeps {
  readonly events: EventStore;
  readonly clock: { now(): string };
  /** When wired, every fresh item is received on the `lockbox` channel (rule 1) and identified from its scanline. */
  readonly service?: CashieringService;
  /** Deterministic scanline → loan match (rule 4); unmatched items go to 6.5 as unidentified. */
  readonly loanByScanline?: (scanline: string) => string | undefined;
  readonly actor?: Actor;
  /** The lockbox's local zone for the as-of time (defaults to the `lockbox` channel's cut-off zone). */
  readonly timeZone?: string;
}

const str = (c: Cents): string => c.toString();

/** BAI2 as-of time "1730" → "17:30" (empty when the bank omits it). */
function hhmm(asOfTime: string): string | null {
  const m = /^(\d{2})(\d{2})$/.exec(asOfTime.trim());
  return m ? `${m[1]}:${m[2]}` : null;
}

/**
 * Split an ingested lockbox file into bank batches. `received_at` is the group's as-of date + time in the lockbox's
 * zone (the scan instant the 5:00 p.m. cut-off is measured against); when the bank omits the time, the file's arrival.
 */
export function batchesFromIngest(ingest: Pick<LockboxIngest, "fileHash" | "items" | "file">, fileReceivedAt: string, timeZone = DEFAULT_CHANNELS.lockbox.cutoff!.timeZone): LockboxBatchRecord[] {
  const asOf = new Map<string, { date: PlainDate; time: string | null }>();
  for (const g of ingest.file.groups) for (const a of g.accounts) asOf.set(`${ingest.file.fileId}:${a.accountNumber}`, { date: plainDate(g.asOfDate), time: hhmm(g.asOfTime) });
  const byBatch = new Map<string, LockboxBatchItem[]>();
  for (const it of ingest.items) {
    let items = byBatch.get(it.batchId); if (!items) { items = []; byBatch.set(it.batchId, items); }
    items.push({ sequence: it.sequence, amount_cents: it.amountCents, scanline: it.scanline, bank_reference: it.bankReference });
  }
  return [...byBatch].map(([batch_id, items]) => {
    const g = asOf.get(batch_id) ?? { date: plainDate(ingest.file.fileDate), time: null };
    const received_at = g.time ? toIso(zonedEpochMs(g.date, g.time, timeZone)) : fileReceivedAt;
    return { batch_id, file_id: ingest.file.fileId, file_hash: ingest.fileHash, lockbox_receipt_date: g.date, received_at, items };
  });
}

export class LockboxIntake {
  private readonly deps: LockboxIntakeDeps;
  private readonly actor: Actor;
  constructor(deps: LockboxIntakeDeps) { this.deps = deps; this.actor = deps.actor ?? CASHIERING_OPS_ACTOR; }

  /**
   * The daily file after the adapter's idempotency pass: a replayed file is an exception (no batch event, nothing
   * posted); a re-sent file with changed items raises the exception and receives only the fresh items; otherwise every
   * batch is received.
   */
  ingest(ingest: LockboxIngest, fileReceivedAt: string): { batches: LockboxBatchReceipt[]; exception: DomainEvent | null } {
    let exception: DomainEvent | null = null;
    if (ingest.status !== "ingested") {
      exception = this.deps.events.append({ type: "lockbox.batch.exception", aggregate: { kind: "lockbox_file", id: ingest.fileHash }, actor: this.actor,
        payload: { file_id: ingest.file.fileId, file_hash: ingest.fileHash, reason: ingest.status === "duplicate" ? "duplicate_file" : "changed_items", changed: [...ingest.changed], duplicates: [...ingest.duplicates], received_at: fileReceivedAt, action: "exception_not_repost" } });
      if (ingest.status === "duplicate") return { batches: [], exception };
    }
    const batches = batchesFromIngest(ingest, fileReceivedAt, this.deps.timeZone).map((b) => this.receiveBatch(b));
    return { batches, exception };
  }

  /** Validate one bank batch and append `lockbox.batch.received`; then receive its items on the lockbox channel. */
  receiveBatch(b: LockboxBatchRecord): LockboxBatchReceipt {
    if (!b.batch_id.trim()) throw new RangeError("lockbox batch requires a bank batch id");
    if (b.items.length === 0) throw new RangeError(`lockbox batch ${b.batch_id} has no items`);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(b.received_at) || Number.isNaN(Date.parse(b.received_at))) throw new RangeError(`lockbox batch ${b.batch_id}: received_at must be an ISO instant`);
    const receiptDate = plainDate(b.lockbox_receipt_date);
    const seen = new Set<number>();
    for (const it of b.items) {
      if (it.amount_cents <= 0n) throw new RangeError(`lockbox batch ${b.batch_id} item ${it.sequence}: amount must be positive`);
      if (seen.has(it.sequence)) throw new RangeError(`lockbox batch ${b.batch_id}: duplicate item sequence ${it.sequence}`);
      seen.add(it.sequence);
    }
    const control_total_cents = b.items.reduce((s, it) => s + it.amount_cents, 0n);
    const event = this.deps.events.append({ type: "lockbox.batch.received", aggregate: { kind: "lockbox_batch", id: b.batch_id }, actor: this.actor,
      payload: { batch_id: b.batch_id, file_id: b.file_id, file_hash: b.file_hash, lockbox_receipt_date: receiptDate, received_at: b.received_at, received_by: "lockbox_agent", item_count: b.items.length,
        control_total_cents: str(control_total_cents), bank_references: b.items.map((it) => it.bank_reference), ingested_at: this.deps.clock.now() } });
    const payments: Payment[] = []; const unidentified: string[] = [];
    if (this.deps.service) {
      for (const it of b.items) {
        const loan_id = this.deps.loanByScanline?.(it.scanline);
        const { payment, duplicate } = this.deps.service.receive({ channel: "lockbox", instrument: "check", amount_cents: it.amount_cents, received_at: b.received_at, source_batch_id: b.batch_id, source_item_id: it.bank_reference || `${b.batch_id}#${it.sequence}`, payer_type: "borrower", ...(loan_id ? { loan_id } : {}) });
        if (duplicate) continue;
        payments.push(payment);
        if (loan_id) this.deps.service.identify(payment.id, loan_id);      // rule 4 / state machine: deterministic scanline match → `payment.identify` (received → identified)
        else {
          unidentified.push(payment.id);
          this.deps.events.append({ type: "lockbox.item.unidentified", aggregate: { kind: "payment", id: payment.id }, actor: this.actor, causationId: event.id,
            payload: { payment_id: payment.id, batch_id: b.batch_id, sequence: it.sequence, scanline: it.scanline, amount_cents: str(it.amount_cents), route: "6.5 suspense_items{reason=unidentified_scanline}" } });
        }
      }
    }
    return { event, payments, unidentified, control_total_cents };
  }
}

// ───────────────────────── periodic-statement read model (Reg Z §1026.41(d)(3)/(d)(4))
export interface StatementPaymentBreakdown { readonly payment_id: string; readonly principal_cents: Cents; readonly interest_cents: Cents; readonly escrow_cents: Cents; readonly fees_cents: Cents; readonly suspense_cents: Cents; }
export interface StatementTransaction { readonly date: PlainDate; readonly description: string; readonly amount_cents: Cents; readonly payment_id: string; readonly kind: "payment" | "reversal"; }

/** §1026.41(d)(3): amounts applied to principal, interest, escrow, fees and charges, and the amount sent to suspense. */
export function statementPaymentBreakdown(p: Pick<Payment, "id" | "allocations">): StatementPaymentBreakdown {
  const sum = (pred: (bucket: string) => boolean): Cents => p.allocations.filter((a) => pred(a.bucket)).reduce((s, a) => s + a.amount_cents, 0n);
  return { payment_id: p.id, principal_cents: sum((b) => b === "principal" || b === "curtailment" || b === "deferred_principal" || b === "forborne_principal"), interest_cents: sum((b) => b === "interest"), escrow_cents: sum((b) => b === "escrow"),
    fees_cents: sum((b) => b === "late_charge" || b === "nsf_fee" || b === "other_fee"), suspense_cents: sum((b) => b === "suspense") };
}

/** §1026.41(d)(4): every credit/debit since the last statement — a posted payment and its later reversal are two transactions. */
export function transactionActivity(events: EventStore, loanId: string): StatementTransaction[] {
  const amounts = new Map<string, Cents>();
  for (const e of events.ofType("payment.received")) if (e.loanId === loanId) amounts.set(String(e.payload.payment_id), BigInt(String(e.payload.amount_cents)));
  const out: StatementTransaction[] = [];
  for (const e of events.all()) {
    if (e.loanId !== loanId) continue;
    const id = String(e.payload.payment_id ?? "");
    if (e.type === "payment.posted") out.push({ date: plainDate(String(e.payload.credited_as_of)), description: `Payment received (${String(e.payload.channel)})`, amount_cents: amounts.get(id) ?? 0n, payment_id: id, kind: "payment" });
    else if (e.type === "payment.reversed") out.push({ date: plainDate(e.occurredAt.slice(0, 10)), description: `Payment reversed (${String(e.payload.reason)}${e.payload.return_code ? ` ${String(e.payload.return_code)}` : ""})`, amount_cents: -(amounts.get(id) ?? 0n), payment_id: id, kind: "reversal" });
  }
  return out;
}
