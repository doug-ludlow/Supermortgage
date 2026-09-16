/**
 * §35.5 — the ports this process reads and writes cash through, per runtime (build plan v2 §4). The defaults are the seam to the
 * lanes not yet in the tree: 35.1 (the typed cash rows, the sweep lease, the outbox), 35.3 (the cycle rows and the receipt election)
 * and 35.2 (`documents.store`). Either replace a default here at merge or call `installPorts35_5(rt, {...})` after `new Runtime(...)`.
 *
 *   CashRowsPort   `payments`, `suspense_items`, `fees`, `autodraft_enrollments` — read through the entity store (the unit's overlay
 *                  wins over the database) and written JSONB in the exact shapes 2.x write today (section2-3.ts settle for an ACH-settled
 *                  payment, section2-1.ts for a suspense item, section02.ts feeRecord for a fee); 35.1's projectors copy them unchanged.
 *   CyclePort      `cycle_runs`-shaped global entity rows (kind `cycle_runs`, id `<cycle_code>:<period_key>`) until 35.3's typed rows;
 *                  `openRun` answers `already: true` for a period that has a run (a rerun over a grown book lifts `units_total`, never lowers it).
 *   RunLeasePort   a pass-through: the whole sweep runs under 35.1's `pg_try_advisory_lock(35_001)` once merged — no second lease exists.
 *   DocumentsPort  the baseline `documents` row (`storage_uri = worm_pending:<id>`, `metadata.storage_status = staged`) 35.2 recognises.
 *   TransmitPort   `ports.nacha.transmit` directly; 35.1's outbox replaces it (`integration_messages{adapter: nacha}`).
 *
 * Tests read through the port, never the JSONB store directly. Money is bigint cents; dates are PlainDate.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Queryable } from "../../infra/db/client.ts";
import { toJson } from "../../infra/db/client.ts";
import { decodeEntityData } from "../../infra/db/entities.ts";
import { EntityStore, PortUnavailable, type EntityRecord } from "../../app/tools.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { Actor } from "../../kernel/events/index.ts";
import type { PlainDate } from "../../kernel/calendar/date.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import type { Fee } from "../cashiering/types.ts";
import type { Runtime } from "../../runtime/app.ts";
import { CASHIERING_AGENT } from "./installments.ts";

type Row = Record<string, unknown>;
const s = (v: Cents): string => v.toString();

// ---------------------------------------------------------------- 35.1 seam: the cash rows
export interface PaymentRow { readonly id: string; readonly version: number; readonly data: Row; }
export interface ReversalRow { readonly payment_id: string; readonly reason: string; readonly return_code: string | null; readonly reversed_at: string; readonly entry_set_ids: readonly string[]; }
export interface EnrollmentRow { readonly id: string; readonly loan_id: string; readonly data: Row; }
export interface FeeRow { readonly id: string; readonly data: Row; }
/** A received payment as 2.1 rule 1 records it: the fact (amount, receipt date, channel, instrument), never an allocation. */
export interface NewPaymentRow {
  readonly loan_id: string; readonly amount_cents: Cents; readonly received_on: PlainDate; readonly credited_as_of?: PlainDate; readonly channel: string; readonly instrument?: string;
  readonly designation?: string; readonly status?: "received" | "identified"; readonly idempotency_key?: string; readonly curtailment_cents?: Cents; readonly payer_name?: string | null; readonly check_number?: string | null;
  readonly source_batch_id?: string | null; readonly source_item_id?: string | null; readonly autodraft_trace?: string | null; readonly enrollment_id?: string | null; readonly ach_entry_id?: string | null; readonly received_at?: string | null;
  /** A caller-minted uuid (the lockbox ingest posts the receipt set naming it before the row is written); else the port mints one. */
  readonly payment_id?: string;
  /**
   * 35.5 rule 7: a lockbox item's receipt set (Dr clearing_cash / Cr suspense_unapplied) is posted at ingest on its `received_on` (credit as of
   * receipt); the posting run reuses it instead of posting a second one (src/app/tools/section2-1.ts). `receipt_parked_account` names the custodial
   * suspense the credit sits in when the item was identified after the ingest parked it (6.5's unidentified item, resolved through
   * `lockbox.item.resolve`) — 2.1 releases it to the loan's suspense at posting, in its own receipt-shaped set.
   */
  readonly receipt_entry_set_id?: string | null; readonly ledger_entry_set_ids?: readonly string[]; readonly receipt_parked_account?: { readonly custodial_account_id: string; readonly account: string } | null;
  readonly match_method?: string | null; readonly scanline?: string | null;
  readonly actor?: Actor;
}
export interface NewSuspenseItem {
  readonly loan_id: string | null; readonly amount_cents: Cents; readonly received_on: PlainDate; readonly source: string; readonly reason_code: string; readonly payment_id?: string | null; readonly batch_id?: string | null; readonly item_no?: number | null; readonly receipt_entry_set_id?: string | null;
  /** 6.5's suspense is keyed by the custodial account the funds sit in (0003 suspense_items.custodial_account_id): the lockbox's clearing account for an unidentified item. */
  readonly custodial_account_id?: string | null; readonly payer_name?: string | null; readonly check_number?: string | null; readonly scanline?: string | null; readonly loan_number_read?: string | null;
  readonly actor?: Actor;
}
export interface SuspenseRow { readonly id: string; readonly version: number; readonly data: Row; }
export interface CashRowsPort {
  /** `payments` rows in `received` / `identified` for the loan, in receipt order (received_on, then version). */
  receivedPayments(loanId: string, overlay?: EntityStore): Promise<PaymentRow[]>;
  paymentById(loanId: string, paymentId: string, overlay?: EntityStore): Promise<PaymentRow | undefined>;
  /** One suspense item by id — a loan's, or a loan-less one (6.5's unidentified lockbox item is a global row until it is matched). */
  suspenseItemById(suspenseItemId: string, overlay?: EntityStore): Promise<SuspenseRow | undefined>;
  /** The reversal a returned item recorded on the payment (JSONB `payments.reversal`; 35.1's `payment_reversals` projector — Ask 1). */
  reversalsFor(loanId: string, paymentId: string): Promise<ReversalRow[]>;
  /** A uuid id; deduplicated against the store by `idempotency_key`; appends `payment.received`. */
  writeReceivedPayment(store: EntityStore, ctx: UowContext, row: NewPaymentRow): { payment_id: string; duplicate: boolean };
  writeSuspenseItem(store: EntityStore, ctx: UowContext, row: NewSuspenseItem): { suspense_item_id: string };
  writeFee(store: EntityStore, ctx: UowContext, fee: Fee & { loan_id: string }): { fee_id: string };
  /** Every active enrollment on the book (whole book: `entity_current`). */
  activeEnrollments(): Promise<EnrollmentRow[]>;
  enrollmentsFor(loanId: string, overlay?: EntityStore): Promise<EnrollmentRow[]>;
  feesFor(loanId: string, overlay?: EntityStore): Promise<FeeRow[]>;
}

/** The default: the JSONB entity store, exactly as src/runtime/servicing.ts reads it today; the overlay (a unit's store) wins over the database. */
export function jsonbCashRows(rt: Runtime): CashRowsPort {
  const loanStore = async (loanId: string, overlay?: EntityStore): Promise<EntityStore> => { if (overlay) return overlay; const st = new EntityStore(); st.seed(await rt.entities.load({ loanId })); return st; };
  const feeRecord = (f: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
  return {
    async receivedPayments(loanId, overlay) {
      const st = await loanStore(loanId, overlay);
      return st.list("payments", (d) => d.loan_id === loanId && (d.status === "received" || d.status === "identified")).map((r) => ({ id: r.id, version: r.version, data: r.data }))
        .sort((a, b) => String(a.data.received_on ?? "").localeCompare(String(b.data.received_on ?? "")) || String(a.data.received_at ?? "").localeCompare(String(b.data.received_at ?? "")) || a.version - b.version);
    },
    async paymentById(loanId, paymentId, overlay) { const r = (await loanStore(loanId, overlay)).get("payments", paymentId); return r && r.data.loan_id === loanId ? { id: r.id, version: r.version, data: r.data } : undefined; },
    async suspenseItemById(suspenseItemId, overlay) {
      const hit = overlay?.get("suspense_items", suspenseItemId) ?? (await rt.entities.current("suspense_items", suspenseItemId));
      return hit ? { id: hit.id, version: hit.version, data: hit.data } : undefined;
    },
    async reversalsFor(loanId, paymentId) {
      const r = (await loanStore(loanId)).get("payments", paymentId); const rev = r?.data.reversal as Row | undefined;
      return rev ? [{ payment_id: paymentId, reason: String(rev.reason ?? ""), return_code: (rev.return_code as string | null) ?? null, reversed_at: String(rev.reversed_at ?? ""), entry_set_ids: Array.isArray(rev.entry_set_ids) ? (rev.entry_set_ids as string[]) : [] }] : [];
    },
    writeReceivedPayment(store, ctx, row) {
      const key = row.idempotency_key ?? createHash("sha256").update(`${row.channel}|${row.loan_id}|${row.received_on}|${s(row.amount_cents)}|${row.source_batch_id ?? ""}|${row.source_item_id ?? ""}|${row.autodraft_trace ?? ""}`).digest("hex");
      const dup = store.list("payments", (d) => d.loan_id === row.loan_id && d.idempotency_key === key)[0];
      if (dup) return { payment_id: dup.id, duplicate: true };
      const payment_id = row.payment_id ?? randomUUID(); const actor = row.actor ?? CASHIERING_AGENT; const creditedAsOf = row.credited_as_of ?? row.received_on;
      if (store.get("payments", payment_id)) throw new RangeError(`payment ${payment_id} already exists on this loan`);
      // the shape section2-3.ts settle writes for an ACH-settled receipt (35.1's payments projector copies it unchanged)
      store.put("payments", payment_id, { payment_id, loan_id: row.loan_id, amount_cents: s(row.amount_cents), received_on: row.received_on, credited_as_of: creditedAsOf, channel: row.channel, instrument: row.instrument ?? (row.channel.startsWith("ach") ? "ach" : "check"), designation: row.designation ?? "contractual", status: row.status ?? "received",
        identification_confidence: 1, conforming: true, idempotency_key: key, ...(row.curtailment_cents !== undefined ? { curtailment_cents: s(row.curtailment_cents) } : {}), ...(row.payer_name ? { payer_name: row.payer_name } : {}), ...(row.check_number ? { check_number: row.check_number } : {}),
        ...(row.source_batch_id ? { source_batch_id: row.source_batch_id } : {}), ...(row.source_item_id ? { source_item_id: row.source_item_id } : {}), ...(row.autodraft_trace ? { autodraft_trace: row.autodraft_trace } : {}), ...(row.enrollment_id ? { enrollment_id: row.enrollment_id } : {}), ...(row.ach_entry_id ? { ach_entry_id: row.ach_entry_id } : {}),
        ...(row.receipt_entry_set_id ? { receipt_entry_set_id: row.receipt_entry_set_id } : {}), ...(row.ledger_entry_set_ids ? { ledger_entry_set_ids: [...row.ledger_entry_set_ids] } : {}), ...(row.receipt_parked_account ? { receipt_parked_account: { ...row.receipt_parked_account } } : {}),
        ...(row.match_method ? { match_method: row.match_method } : {}), ...(row.scanline ? { scanline: row.scanline } : {}), received_at: row.received_at ?? ctx.clock.now() }, actor, ctx.clock.now());
      ctx.events.append({ type: "payment.received", loanId: row.loan_id, aggregate: { kind: "payment", id: payment_id }, actor, payload: { payment_id, loan_id: row.loan_id, amount_cents: s(row.amount_cents), received_on: row.received_on, credited_as_of: creditedAsOf, channel: row.channel, designation: row.designation ?? "contractual", status: row.status ?? "received", idempotency_key: key, ...(row.source_batch_id ? { source_batch_id: row.source_batch_id, source_item_id: row.source_item_id ?? null } : {}) } });
      return { payment_id, duplicate: false };
    },
    writeSuspenseItem(store, ctx, row) {
      const suspense_item_id = randomUUID(); const actor = row.actor ?? CASHIERING_AGENT;
      // the section2-1.ts shape (a 2.2 hold row), with 6.5's source and reason
      store.put("suspense_items", suspense_item_id, { id: suspense_item_id, loan_id: row.loan_id, payment_id: row.payment_id ?? null, amount_cents: s(row.amount_cents), received_on: row.received_on, credited_as_of: row.received_on, source: row.source, reason_code: row.reason_code, status: "open", batch_id: row.batch_id ?? null, item_no: row.item_no ?? null, receipt_entry_set_id: row.receipt_entry_set_id ?? null,
        custodial_account_id: row.custodial_account_id ?? null, payer_name: row.payer_name ?? null, check_number: row.check_number ?? null, scanline: row.scanline ?? null, loan_number_read: row.loan_number_read ?? null, opened_at: ctx.clock.now() }, actor, ctx.clock.now());
      return { suspense_item_id };
    },
    writeFee(store, ctx, fee) { store.put("fees", fee.id, feeRecord({ ...fee }), CASHIERING_AGENT, ctx.clock.now()); return { fee_id: fee.id }; },
    async activeEnrollments() {
      const rows = await rt.db.query<{ id: string; loan_id: string | null; data: unknown }>(`SELECT id, loan_id, data FROM entity_current WHERE kind = 'autodraft_enrollments' AND data->>'status' = 'active' ORDER BY loan_id, id`);
      return rows.map((r) => { const data = decodeEntityData(r.data); return { id: r.id, loan_id: String(r.loan_id ?? data.loan_id ?? ""), data }; });
    },
    async enrollmentsFor(loanId, overlay) { return (await loanStore(loanId, overlay)).list("autodraft_enrollments", (d) => d.loan_id === loanId).map((r) => ({ id: r.id, loan_id: loanId, data: r.data })); },
    async feesFor(loanId, overlay) { return (await loanStore(loanId, overlay)).list("fees", (d) => d.loan_id === loanId).map((r) => ({ id: r.id, data: r.data })); },
  };
}

// ---------------------------------------------------------------- 35.1 seam: the sweep lease (pass-through)
export interface RunLeasePort { withRunLease<T>(name: string, fn: () => Promise<T>): Promise<T | { skipped: "lease_held"; holder: string | null }>; }
export const passThroughLease: RunLeasePort = { withRunLease: (_name, fn) => fn() };

// ---------------------------------------------------------------- 35.3 seam: the cycle rows
export interface CycleRunView { readonly run_id: string; readonly cycle_code: string; readonly period_key: string; readonly as_of_date: PlainDate; readonly status: "running" | "completed"; readonly units_total: number; readonly units_done: number; readonly units_dead: number; readonly units_skipped: number; readonly planned_by: string; readonly opened_at: string; readonly completed_at: string | null; readonly runs: number; }
export interface CyclePort {
  openRun(cycle_code: string, period_key: string, as_of_date: PlainDate, units_total: number, planned_by: string): Promise<{ run_id: string; already: boolean }>;
  completeRun(run_id: string, counters: { units_done: number; units_dead: number; units_skipped: number }): Promise<void>;
  run(cycle_code: string, period_key: string): Promise<CycleRunView | undefined>;
}
const CYCLE_KIND = "cycle_runs";
const viewOf = (r: EntityRecord): CycleRunView => { const d = r.data; return { run_id: String(d.run_id), cycle_code: String(d.cycle_code), period_key: String(d.period_key), as_of_date: String(d.as_of_date) as PlainDate, status: d.status === "completed" ? "completed" : "running", units_total: Number(d.units_total ?? 0), units_done: Number(d.units_done ?? 0), units_dead: Number(d.units_dead ?? 0), units_skipped: Number(d.units_skipped ?? 0), planned_by: String(d.planned_by ?? ""), opened_at: String(d.opened_at ?? ""), completed_at: (d.completed_at as string | null) ?? null, runs: Number(d.runs ?? 1) }; };
/** The default (plan D12): `cycle_runs`-shaped global entity rows, one version per open / complete (the transfers.ts:169 global-row precedent). */
export function entityCycleRuns(rt: Runtime): CyclePort {
  const key = (cycle: string, period: string): string => `${cycle}:${period}`;
  const put = async (id: string, data: Row): Promise<void> => {
    const cur = await rt.entities.current(CYCLE_KIND, id);
    const rec: EntityRecord = { kind: CYCLE_KIND, id, version: (cur?.version ?? 0) + 1, data: { ...(cur?.data ?? {}), ...data }, updatedAt: rt.clock.now(), updatedBy: `${CASHIERING_AGENT.kind}:${CASHIERING_AGENT.id}` };
    await rt.db.tx((q) => rt.entities.save([rec], null, q));
  };
  return {
    async openRun(cycle_code, period_key, as_of_date, units_total, planned_by) {
      const id = key(cycle_code, period_key); const cur = await rt.entities.current(CYCLE_KIND, id);
      if (cur) { const total = Math.max(Number(cur.data.units_total ?? 0), units_total); await put(id, { units_total: total, status: "running", runs: Number(cur.data.runs ?? 1) + 1, reopened_at: rt.clock.now(), reopened_by: planned_by }); return { run_id: String(cur.data.run_id), already: true }; }
      const run_id = randomUUID();
      await put(id, { run_id, cycle_code, period_key, as_of_date, planned_by, opened_at: rt.clock.now(), units_total, units_done: 0, units_dead: 0, units_skipped: 0, status: "running", completed_at: null, runs: 1, demo_offset_ms: 0 });
      return { run_id, already: false };
    },
    async completeRun(run_id, counters) {
      const found = await rt.db.query<{ id: string }>(`SELECT id FROM entity_current WHERE kind = $1 AND data->>'run_id' = $2`, [CYCLE_KIND, run_id]);
      const id = found[0]?.id; if (!id) throw new RangeError(`no cycle run ${run_id}`);
      await put(id, { ...counters, status: "completed", completed_at: rt.clock.now() });
    },
    async run(cycle_code, period_key) { const cur = await rt.entities.current(CYCLE_KIND, key(cycle_code, period_key)); return cur ? viewOf(cur) : undefined; },
  };
}

// ---------------------------------------------------------------- 35.2 seam: documents.store
export interface StoredDocument { readonly document_id: string; readonly sha256: string; }
export interface DocumentsPort { store(q: Queryable, doc: { kind: string; bytes: Uint8Array | string; mime_type: string; retention_class?: string; loan_id?: string | null; metadata?: Row }): Promise<StoredDocument>; }
/** The FAKE stage keeps a file's bytes in the row's metadata up to this size (a NACHA file for the demo book is ~10 KB; a deferred ACH file is retransmitted from them — ach.ts retransmitDeferred escalates one it cannot find); 35.2's WORM store keeps every file. */
export const FAKE_BYTES_MAX = 1 << 20;
/** The baseline `documents` row 35.2 recognises (35.2 rule 4: `storage_uri = worm_pending:<id>`, `storage_status: staged`); the bytes ride in the metadata (≤ FAKE_BYTES_MAX) until 35.2's WORM store. */
export const baselineDocuments: DocumentsPort = {
  async store(q, doc) {
    const bytes = typeof doc.bytes === "string" ? Buffer.from(doc.bytes, "utf8") : Buffer.from(doc.bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex"); const id = randomUUID();
    const metadata = { ...(doc.metadata ?? {}), storage_status: "staged", fake_store: "35.5", ...(bytes.length <= FAKE_BYTES_MAX ? { fake_bytes_b64: bytes.toString("base64") } : {}) };
    await q.query(`INSERT INTO documents (id, kind, sha256, byte_size, storage_uri, mime_type, retention_class, metadata, loan_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`, [id, doc.kind, sha256, bytes.length, `worm_pending:${id}`, doc.mime_type, doc.retention_class ?? "life_of_loan_plus_4y", toJson(metadata), doc.loan_id ?? null]);
    return { document_id: id, sha256 };
  },
};

// ---------------------------------------------------------------- 35.1 seam: the ACH file transmit (the outbox replaces it)
export interface TransmitPort { transmitAchFile(file: { file_id: string; file_name: string; content: string }, now: string): Promise<{ status: "accepted" | "rejected" | "deferred"; ack?: Row; reason?: string }>; }
export function directNachaTransmit(rt: Runtime): TransmitPort {
  return { async transmitAchFile(file, now) {
    const nacha = rt.ports.nacha; if (!nacha) throw new PortUnavailable("nacha");
    try { const ack = await nacha.transmit(file.file_name, file.content, now); return { status: ack.status === "accepted" ? "accepted" : "rejected", ack: { ...ack }, ...(ack.reason ? { reason: ack.reason } : {}) }; }
    catch (e) { return { status: "deferred", reason: e instanceof Error ? e.message : String(e) }; }
  } };
}

// ---------------------------------------------------------------- the set, per runtime
export interface Ports35_5 { readonly cashRows: CashRowsPort; readonly cycles: CyclePort; readonly runLease: RunLeasePort; readonly documents: DocumentsPort; readonly transmit: TransmitPort; }
const installed = new WeakMap<Runtime, Partial<Ports35_5>>();
export function defaultPorts35_5(rt: Runtime): Ports35_5 { return { cashRows: jsonbCashRows(rt), cycles: entityCycleRuns(rt), runLease: passThroughLease, documents: baselineDocuments, transmit: directNachaTransmit(rt) }; }
/** Replace one or more ports for this runtime (35.1 / 35.2 / 35.3 at their merge; a test double). */
export function installPorts35_5(rt: Runtime, impl: Partial<Ports35_5>): void { installed.set(rt, { ...(installed.get(rt) ?? {}), ...impl }); }
export function ports35_5(rt: Runtime): Ports35_5 { return { ...defaultPorts35_5(rt), ...(installed.get(rt) ?? {}) }; }
