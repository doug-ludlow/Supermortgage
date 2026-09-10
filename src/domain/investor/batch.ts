/**
 * Per-loan sequencing and the LAR batch builder (5.1 rules 1, 8 and the
 * head-of-line rule of the state machine):
 *
 *   - `SequenceAllocator` is the in-memory shape of `investor_loan_sequences`
 *     (`loan_id`, `next_sequence`, row-locked in Postgres): sequences are
 *     allocated in processing order, never reused; a correction takes a new
 *     sequence and `supersedes_event_id`.
 *   - `buildLarBatch` places records loan by loan in sequence order, drops
 *     duplicates by idempotency key (LSDU would apply a duplicate LAR 96 as a
 *     second payment) and keeps LAR 96 + LAR 97 / LAR 96 + LAR 83 pairs together.
 *   - `applyBatch` is the idempotent `investor_events` writer: a replay of the
 *     same batch (same keys, same file content) produces zero new rows.
 */
import { createHash } from "node:crypto";
import { headOfLine, type QueuedEvent } from "./ops.ts";

export class SequenceAllocator {
  private readonly next = new Map<string, number>();
  constructor(seed: Readonly<Record<string, number>> = {}) { for (const [loan, n] of Object.entries(seed)) this.next.set(loan, n); }
  /** `SELECT next_sequence … FOR UPDATE` + increment: monotonic per loan, never reused. */
  allocate(loanId: string): number { const n = this.next.get(loanId) ?? 1; this.next.set(loanId, n + 1); return n; }
  peek(loanId: string): number { return this.next.get(loanId) ?? 1; }
}

export interface BatchEvent extends QueuedEvent {
  readonly idempotency_key: string;
  readonly record: string;
  /** Legacy record type the projection rendered (96/97/81/83/89/32). */
  readonly legacy_record?: string;
  readonly fnma_loan_number?: string;
}
export interface LarBatch {
  readonly file_content: string;
  readonly file_sha256: string;
  /** Event ids in file order. */
  readonly order: readonly string[];
  readonly record_count: number;
  /** Events dropped because an earlier record in the batch carried the same idempotency key (rule 8). */
  readonly duplicates_dropped: readonly string[];
  /** Events held back by the head-of-line rule (an open hard/invalid reject on the loan). */
  readonly held: readonly string[];
}

/** Rule 8 batch builder: sendable events only, loan by loan in sequence order, de-duplicated by idempotency key before file creation. */
export function buildLarBatch(events: readonly BatchEvent[]): LarBatch {
  const { sendable, blocked } = headOfLine(events);
  const byId = new Map(events.map((e) => [e.id, e] as const));
  const seen = new Set<string>(); const order: string[] = []; const dropped: string[] = []; const records: string[] = [];
  for (const q of sendable) {
    const e = byId.get(q.id)!;
    if (seen.has(e.idempotency_key)) { dropped.push(e.id); continue; }
    seen.add(e.idempotency_key); order.push(e.id); records.push(e.record.endsWith("\r") ? e.record : e.record + "\r");
  }
  const file_content = records.join("");
  return { file_content, file_sha256: createHash("sha256").update(file_content).digest("hex"), order, record_count: order.length, duplicates_dropped: dropped, held: blocked.map((b) => b.id) };
}

export interface InvestorEventRow { readonly idempotency_key: string; readonly event_id: string; readonly loan_id: string; readonly sequence: number; status: string; readonly submission_sha256: string }
/** Idempotent writer over `investor_events` keyed by `idempotency_key`: new keys insert, known keys are a no-op replay. */
export function applyBatch(store: Map<string, InvestorEventRow>, batch: LarBatch, events: readonly BatchEvent[]): { new_rows: number; replayed: number; rows: InvestorEventRow[] } {
  const byId = new Map(events.map((e) => [e.id, e] as const));
  let created = 0, replayed = 0; const rows: InvestorEventRow[] = [];
  for (const id of batch.order) {
    const e = byId.get(id)!;
    const existing = store.get(e.idempotency_key);
    if (existing) { replayed++; rows.push(existing); continue; }
    const row: InvestorEventRow = { idempotency_key: e.idempotency_key, event_id: e.id, loan_id: e.loan_id, sequence: e.sequence, status: "queued", submission_sha256: batch.file_sha256 };
    store.set(e.idempotency_key, row); rows.push(row); created++;
  }
  return { new_rows: created, replayed, rows };
}
