/**
 * §35.5 rule 7 — the lockbox ingest cycle (`lockbox_ingest`, per lockbox per servicer business day; rule set `cashiering.allocation.v1`):
 * the day's remittance file is fetched from the `lockbox` adapter's queue, stored (35.2 `documents`, sha256), written as one
 * `lockbox_batches` row and one `lockbox_items` row per detail line, every item identified (scanline → loan number → coupon OCR through
 * 2.1's own `lockbox.image_ocr`, in-process) and dated (`received_on`: the agent's receipt date, or the next servicer business day when
 * scanned after the channel's cut-off — 2.1 rule 1), then posted: an identified item becomes the loan's `payments` row (`channel lockbox`,
 * `instrument check`, `status identified`, the 2.1 idempotency key) with 2.1's receipt set Dr `clearing_cash` / Cr `suspense_unapplied` on
 * its `received_on`; an unidentified item becomes 6.5's `suspense_items` row (`source lockbox`) with the same receipt set on the lockbox's
 * clearing account. Σ items ≠ the control total leaves the batch in `variance` (CONTROL_TOTAL_MATCH): nothing posts, `officer` is escalated.
 *
 *   PgFakeLockboxQueue          the FAKE bank's queue — `documents` rows (`kind lockbox_remittance_file`, `metadata.status queued`), one shared
 *                               FAKE per database as the spec requires (the sweep job and the API see the same batch), never per Runtime.
 *   receivedOnFor(...)          rule 7 / 2.1 rule 1: the receipt date, or the next servicer business day after the cut-off.
 *   ingestLockboxFile(rt, in)   the runner (35.3's `lockbox_ingest` unit): one global unit of work for the batch (`lockbox.batch.received`,
 *                               the rows, a variance escalation), one loan unit of work per identified item (the receipt set, the payment,
 *                               `lockbox.item.identified`), one global unit of work for the unidentified items (`lockbox.item.unidentified`), then
 *                               `lockbox.batch.posted` (satisfies SM_LOCKBOX_BATCH_POSTED_1BD); the same bytes again write nothing but a
 *                               decision naming the first batch; `lockbox.ingest.run_completed{…, origination: true}` per run (35.3's spelling).
 *   lockboxIngest / lockboxItemResolve   the bus tools `lockbox.ingest{lockbox_id, as_of_date}` (agent) and `lockbox.item.resolve{item_id,
 *                               loan_id | disposition, reason}` (`ops_analyst` / `officer`, human only; a money key is NO_MONEY_FIELD): a
 *                               person names the loan → the item becomes that loan's payment carrying the ingest's receipt set, parked on the
 *                               clearing account's suspense until 2.1 posts it — no ledger line here (rule 10).
 *
 * The identified payments are posted by the loan's next `cashiering_daily` unit (cashiering-cycle.ts) — 2.1 reuses the receipt set posted here
 * (src/app/tools/section2-1.ts). Money is bigint cents; dates are PlainDate; every event type is a string literal (tools/lint-emission.ts).
 */
import { createHash, randomUUID } from "node:crypto";
import type { Queryable } from "../../infra/db/client.ts";
import { toJson } from "../../infra/db/client.ts";
import { CommandRefused, type CommandContext } from "../../app/commands.ts";
import { str, type ToolInput, type ToolRuntime } from "../../app/tools.ts";
import type { AccountRef } from "../../kernel/ledger/ledger.ts";
import type { DomainEvent } from "../../kernel/events/index.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { parseRemittance, remittanceSha256, type RemittanceFile, type RemittanceItem } from "../../infra/integrations/codecs/lockbox-remittance.ts";
import type { Runtime } from "../../runtime/app.ts";
import { CASHIERING_AGENT, MODEL_VERSION_DETERMINISTIC, PROMPT_VERSION_35_5 } from "./installments.ts";
import { EXCLUDED_STATUSES, RULE_SET_ALLOCATION } from "./cashiering-cycle.ts";
import { platformServicingPartyId } from "./servicing-config.ts";
import { bindUnit, commitUnit, executeInUnit, openUnit, type BoundUnit } from "./in-process.ts";
import { ports35_5 } from "./ports-35-5.ts";

export const CYCLE_LOCKBOX_INGEST = "lockbox_ingest";
/** Event literals this file emits. */
export const BATCH_RECEIVED = "lockbox.batch.received";
export const BATCH_POSTED = "lockbox.batch.posted";
export const ITEM_IDENTIFIED = "lockbox.item.identified";
export const ITEM_UNIDENTIFIED = "lockbox.item.unidentified";
export const ITEM_RESOLVED = "lockbox.item.resolved";
export const INGEST_RUN_COMPLETED = "lockbox.ingest.run_completed";
export const LOCKBOX_FILE_KIND = "lockbox_remittance_file";
export const RULE_REF_RECEIPT = "2.1:r8:receipt";

type Row = Record<string, unknown>;
const s = (v: Cents): string => v.toString();
function refuse(command: string, code: string, citation: string, reason: string): never { throw new CommandRefused(command, code, citation, reason); }
const agg = (batchId: string): { kind: "lockbox_batch"; id: string } => ({ kind: "lockbox_batch", id: batchId });
const cust = (custodialAccountId: string, account: "clearing_cash" | "suspense_unapplied"): AccountRef => ({ scope: "custodial", custodialAccountId, account });

// ---------------------------------------------------------------- the lockboxes (the payment_channels-level lockbox: P.O. box + bank)
export interface LockboxConfig { readonly id: string; readonly po_box: string; readonly bank: string; readonly channel: "lockbox"; readonly cutoff_time: string; readonly cutoff_tz: string; }
/** The FAKE build's one lockbox (0143 seeds its channel row: cut-off 17:00 America/Chicago; the servicer profile's remittance address is its P.O. box). */
export const LOCKBOXES: Readonly<Record<string, LockboxConfig>> = { "LBX-1": { id: "LBX-1", po_box: "PO Box 7, Testville TX 75001", bank: "FAKE Lockbox Bank NA", channel: "lockbox", cutoff_time: "17:00", cutoff_tz: "America/Chicago" } };
/** The written cut-off of the lockbox channel (0003 payment_channels; 0143's seed), the config's values when the row is absent. */
export async function lockboxCutoff(db: Queryable, lockbox: LockboxConfig): Promise<{ cutoff_time: string; cutoff_tz: string }> {
  const row = (await db.query<{ cutoff_time: string; cutoff_tz: string }>(`SELECT cutoff_time::text AS cutoff_time, cutoff_tz FROM payment_channels WHERE channel = $1`, [lockbox.channel]))[0];
  return row ? { cutoff_time: row.cutoff_time.slice(0, 5), cutoff_tz: row.cutoff_tz } : { cutoff_time: lockbox.cutoff_time, cutoff_tz: lockbox.cutoff_tz };
}
/** Rule 7 / 2.1 rule 1: the lockbox agent's receipt date, or the next servicer business day when the item was scanned after the cut-off in the lockbox's zone. */
export function receivedOnFor(scannedAt: string, receiptDate: PlainDate, cutoffTime: string, cutoffTz: string): { received_on: PlainDate; after_cutoff: boolean } {
  const wc = wallClock(Date.parse(scannedAt), cutoffTz);
  const [h, m] = cutoffTime.split(":").map(Number);
  const after = wc.date > receiptDate || (wc.date === receiptDate && wc.hour * 60 + wc.minute > (h ?? 17) * 60 + (m ?? 0));
  return { received_on: after ? addBusinessDays(receiptDate, 1, servicer) : receiptDate, after_cutoff: after };
}
/** 2.1's key form for a lockbox item's payment (Data model): sha256(`lockbox|batch_id|item_no|amount_cents|received_on`). */
export const itemIdempotencyKey = (batchId: string, itemNo: number, amount: Cents, receivedOn: PlainDate): string => createHash("sha256").update(`lockbox|${batchId}|${itemNo}|${s(amount)}|${receivedOn}`).digest("hex");

// ---------------------------------------------------------------- the FAKE bank's queue: documents rows, one shared FAKE per database
export interface QueuedFile { readonly document_id: string; readonly sha256: string; readonly lockbox_id: string; readonly file_name: string; readonly content: string; readonly received_at: string; }
export const PgFakeLockboxQueue = {
  /** The bank delivers a file: a `documents` row queued for the lockbox (`storage_uri fake-queue://…`, the bytes in the metadata until the ingest stores the file). */
  async post(db: Queryable, f: { lockbox_id: string; file_name: string; content: string; received_at: string }): Promise<{ document_id: string; sha256: string }> {
    const bytes = Buffer.from(f.content, "utf8"); const sha256 = remittanceSha256(f.content); const id = randomUUID();
    await db.query(`INSERT INTO documents (id, kind, sha256, byte_size, storage_uri, mime_type, retention_class, metadata) VALUES ($1, $2, $3, $4, $5, 'text/plain', 'life_of_loan_plus_4y', $6::jsonb)`,
      [id, LOCKBOX_FILE_KIND, sha256, bytes.length, `fake-queue://lockbox/${sha256}`, toJson({ status: "queued", fake_store: "35.5", lockbox_id: f.lockbox_id, file_name: f.file_name, received_at: f.received_at, fake_bytes_b64: bytes.toString("base64") })]);
    return { document_id: id, sha256 };
  },
  /** The queued files of a lockbox, oldest first, marked dequeued (documents has no append-only trigger at HEAD; 35.2's column rule must keep `metadata` writable for this kind — plan §9 R7). */
  async fetch(q: Queryable, lockboxId: string, now: string): Promise<QueuedFile[]> {
    const rows = await q.query<{ id: string; sha256: string; metadata: Row }>(`SELECT id, sha256, metadata FROM documents WHERE kind = $1 AND metadata->>'lockbox_id' = $2 AND metadata->>'status' = 'queued' ORDER BY created_at, id`, [LOCKBOX_FILE_KIND, lockboxId]);
    const out: QueuedFile[] = [];
    for (const r of rows) {
      await q.query(`UPDATE documents SET metadata = metadata || $2::jsonb WHERE id = $1`, [r.id, toJson({ status: "dequeued", dequeued_at: now })]);
      out.push({ document_id: r.id, sha256: r.sha256, lockbox_id: lockboxId, file_name: String(r.metadata.file_name ?? r.id), content: Buffer.from(String(r.metadata.fake_bytes_b64 ?? ""), "base64").toString("utf8"), received_at: String(r.metadata.received_at ?? now) });
    }
    return out;
  },
  async mark(q: Queryable, documentId: string, status: string, extra: Row = {}): Promise<void> { await q.query(`UPDATE documents SET metadata = metadata || $2::jsonb WHERE id = $1`, [documentId, toJson({ status, ...extra })]); },
};

// ---------------------------------------------------------------- the rows
export type MatchMethod = "scanline" | "loan_number" | "coupon_ocr" | "manual" | "none";
export type Disposition = "identified" | "unidentified" | "duplicate" | "rejected";
interface ItemPlan extends RemittanceItem { readonly id: string; readonly received_on: PlainDate; readonly after_cutoff: boolean; readonly loan_id: string | null; readonly partner_party_id: string | null; readonly loan_status: string | null; readonly match_method: MatchMethod; readonly loan_number_read: string | null; readonly disposition: Disposition; clearing: string | null; payment_id: string | null; suspense_item_id: string | null; }
export interface BatchRowInput { readonly id: string; readonly lockbox_id: string; readonly file_name: string; readonly sha256: string; readonly document_id: string | null; readonly receipt_date: PlainDate; readonly cutoff_tz: string; readonly items: number; readonly control_total_cents: Cents; readonly items_identified: number; readonly items_unidentified: number; readonly items_rejected: number; readonly status: "received" | "posted" | "variance"; readonly variance_cents: Cents; }
/** One `lockbox_batches` row. */
export async function insertBatch(q: Queryable, b: BatchRowInput): Promise<void> {
  await q.query(`INSERT INTO lockbox_batches (id, lockbox_id, file_name, sha256, document_id, receipt_date, cutoff_tz, items, control_total_cents, items_identified, items_unidentified, items_rejected, status, variance_cents) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [b.id, b.lockbox_id, b.file_name, b.sha256, b.document_id, b.receipt_date, b.cutoff_tz, b.items, b.control_total_cents, b.items_identified, b.items_unidentified, b.items_rejected, b.status, b.variance_cents]);
}
/** The batch's `lockbox_items` rows (one per detail line; the payment / suspense ids land when the item is received). */
export async function insertItems(q: Queryable, batchId: string, items: readonly ItemPlan[]): Promise<void> {
  for (const it of items) {
    await q.query(`INSERT INTO lockbox_items (id, batch_id, item_no, scanline, loan_number_read, amount_cents, check_number, payer_name, scanned_at, after_cutoff, received_on, matched_loan_id, match_method, payment_id, suspense_item_id, disposition) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [it.id, batchId, it.item_no, it.scanline, it.loan_number_read, it.amount_cents, it.check_no || null, it.payer || null, it.scanned_at, it.after_cutoff, it.received_on, it.loan_id, it.match_method, it.payment_id, it.suspense_item_id, it.disposition]);
  }
}
export interface ItemRow { readonly id: string; readonly batch_id: string; readonly item_no: number; readonly scanline: string; readonly loan_number_read: string | null; readonly amount_cents: Cents; readonly check_number: string | null; readonly payer_name: string | null; readonly scanned_at: string; readonly after_cutoff: boolean; readonly received_on: PlainDate; readonly matched_loan_id: string | null; readonly match_method: MatchMethod; readonly payment_id: string | null; readonly suspense_item_id: string | null; readonly disposition: Disposition; readonly resolved_by: Row | null; }
export async function readItem(q: Queryable, itemId: string): Promise<ItemRow | undefined> {
  const r = (await q.query<Row>(`SELECT id, batch_id, item_no, scanline, loan_number_read, amount_cents::text AS amount_cents, check_number, payer_name, scanned_at::text AS scanned_at, after_cutoff, received_on::text AS received_on, matched_loan_id, match_method, payment_id, suspense_item_id, disposition, resolved_by FROM lockbox_items WHERE id = $1`, [itemId]))[0];
  return r ? { id: String(r.id), batch_id: String(r.batch_id), item_no: Number(r.item_no), scanline: String(r.scanline ?? ""), loan_number_read: (r.loan_number_read as string | null) ?? null, amount_cents: BigInt(String(r.amount_cents)), check_number: (r.check_number as string | null) ?? null, payer_name: (r.payer_name as string | null) ?? null, scanned_at: String(r.scanned_at), after_cutoff: r.after_cutoff === true, received_on: D(String(r.received_on)), matched_loan_id: (r.matched_loan_id as string | null) ?? null, match_method: r.match_method as MatchMethod, payment_id: (r.payment_id as string | null) ?? null, suspense_item_id: (r.suspense_item_id as string | null) ?? null, disposition: r.disposition as Disposition, resolved_by: (r.resolved_by as Row | null) ?? null } : undefined;
}

// ---------------------------------------------------------------- identification (deterministic: scanline → loan number → coupon OCR)
interface LoanHit extends Record<string, unknown> { readonly id: string; readonly status: string; readonly partner_party_id: string; readonly boarded_at: string | null; }
const LOAN_BY_NUMBER = `SELECT id, status::text AS status, partner_party_id, boarded_at::text AS boarded_at FROM loans WHERE servicer_loan_number = $1 OR transferor_loan_number = $1 OR fnma_loan_number = $1 ORDER BY boarded_at DESC NULLS LAST, created_at DESC LIMIT 1`;
async function identifyItem(rt: Runtime, bound: BoundUnit, batchId: string, it: RemittanceItem): Promise<{ hit: LoanHit | null; match_method: MatchMethod; loan_number_read: string | null }> {
  const scan = it.scanline.trim();
  if (scan) {
    const byScan = (await rt.db.query<LoanHit>(LOAN_BY_NUMBER, [scan]))[0];
    if (byScan) return { hit: byScan, match_method: "scanline", loan_number_read: scan };
    // the OCR-A scanline's leading digit run is the loan number (2.1's lockbox.image_ocr reads the same ten digits)
    const digits = /^(\d{6,})/.exec(scan)?.[1] ?? null;
    if (digits) { const byNo = (await rt.db.query<LoanHit>(LOAN_BY_NUMBER, [digits]))[0]; if (byNo) return { hit: byNo, match_method: "loan_number", loan_number_read: digits }; }
  }
  // coupon OCR through 2.1's own read tool, in-process (plan D1): the FAKE decodes an item it knows from the bank's images, nothing for one it does not
  let candidate: string | null = null;
  try {
    const r = await executeInUnit(rt, bound, { process: "2.1", name: "lockbox.image_ocr", actor: CASHIERING_AGENT, input: { item_key: `${batchId}:${it.item_no}`, bank_reference: it.image_name, since: bound.ctx.clock.now() } });
    const out = r.output as Row | null; candidate = out && typeof out.loan_number_candidate === "string" ? out.loan_number_candidate : null;
  } catch { candidate = null; }
  if (candidate) { const byOcr = (await rt.db.query<LoanHit>(LOAN_BY_NUMBER, [candidate]))[0]; if (byOcr) return { hit: byOcr, match_method: "coupon_ocr", loan_number_read: candidate }; }
  return { hit: null, match_method: "none", loan_number_read: candidate ?? (scan || null) };
}
const serviced = (l: LoanHit): boolean => l.boarded_at !== null && !EXCLUDED_STATUSES.includes(l.status);
/** The partner's clearing custodial account (the account 2.1's receipt set debits; loanCashStateFromRows takes the same row). */
async function clearingAccountOf(db: Queryable, partnerPartyId: string): Promise<string | null> {
  return (await db.query<{ id: string }>(`SELECT id FROM custodial_accounts WHERE partner_party_id = $1 AND kind = 'clearing' ORDER BY created_at DESC LIMIT 1`, [partnerPartyId]))[0]?.id ?? null;
}
/**
 * The lockbox's own clearing account for an item no loan claims (6.5's suspense is keyed by the custodial account the funds sit in): the batch is one bank
 * deposit, so it is the clearing account of the batch's identified loans' partner when they share one, else the platform's servicing party's.
 */
async function lockboxClearingAccount(db: Queryable, items: readonly ItemPlan[]): Promise<string | null> {
  const partners = [...new Set(items.filter((it) => it.disposition === "identified" && it.partner_party_id).map((it) => it.partner_party_id!))];
  if (partners.length === 1) return clearingAccountOf(db, partners[0]!);
  const platform = await platformServicingPartyId(db);
  return platform ? clearingAccountOf(db, platform) : null;
}

// ---------------------------------------------------------------- the runner
export interface IngestInput { readonly lockbox_id: string; readonly as_of_date: PlainDate; }
export interface ItemOutcome { readonly item_id: string; readonly item_no: number; readonly amount_cents: string; readonly received_on: PlainDate; readonly after_cutoff: boolean; readonly disposition: Disposition; readonly match_method: MatchMethod; readonly loan_id: string | null; readonly payment_id: string | null; readonly suspense_item_id: string | null; }
export interface BatchOutcome {
  readonly batch_id: string; readonly sha256: string; readonly file_name: string; readonly receipt_date: PlainDate; readonly items: number; readonly control_total_cents: string; readonly sum_cents: string; readonly variance_cents: string;
  readonly status: "posted" | "variance" | "duplicate"; readonly duplicate_of: string | null; readonly posted: number; readonly unidentified: number; readonly rejected: number; readonly item_outcomes: readonly ItemOutcome[];
  readonly received_event_id: string | null; readonly posted_event_id: string | null; readonly escalation_id: string | null; readonly document_id: string | null;
}
export interface IngestReport { readonly lockbox_id: string; readonly as_of_date: PlainDate; readonly run_id: string; readonly files: number; readonly batches: readonly BatchOutcome[]; readonly posted: number; readonly unidentified: number; readonly variance: number; readonly duplicates: readonly string[]; readonly receipt_event_id: string; }
const decisionRecord = (b: Pick<BatchOutcome, "batch_id" | "sha256" | "posted" | "unidentified" | "variance_cents" | "status" | "duplicate_of">, input: IngestInput, extra: Row = {}): Row => ({ batch_id: b.batch_id, action: "lockbox.ingest", inputs: { lockbox_id: input.lockbox_id, as_of_date: input.as_of_date, file_sha256: b.sha256 }, outputs: { posted: b.posted, unidentified: b.unidentified, variance_cents: b.variance_cents, status: b.status, duplicate_of: b.duplicate_of }, rule_set_version: RULE_SET_ALLOCATION, model_version: MODEL_VERSION_DETERMINISTIC, prompt_version: PROMPT_VERSION_35_5, confidence: 1, ...extra });

/**
 * The `lockbox_ingest` unit for one lockbox and day (rule 7) — see the header. Every queued file of the lockbox is one batch; a file whose sha256 is
 * already a batch writes nothing but a decision naming that batch. Throws CommandRefused (LOCKBOX_UNKNOWN, FILE_INVALID, CUSTODIAL_REQUIRED) with the
 * batch unwritten; the queue row is marked failed so an operator sees the file.
 */
export async function ingestLockboxFile(rt: Runtime, input: IngestInput, opts: { recordDecision: boolean } = { recordDecision: true }): Promise<IngestReport> {
  const lockbox = LOCKBOXES[input.lockbox_id];
  if (!lockbox) refuse("lockbox.ingest", "LOCKBOX_UNKNOWN", "35.5 rule 7: lockbox_ingest runs per lockbox (the payment_channels-level P.O. box + bank)", `no lockbox ${input.lockbox_id} is configured`);
  const ports = ports35_5(rt); const now = rt.clock.now();
  const cutoff = await lockboxCutoff(rt.db, lockbox);
  const files = await rt.db.tx((q) => PgFakeLockboxQueue.fetch(q, lockbox.id, now));
  const run = await ports.cycles.openRun(CYCLE_LOCKBOX_INGEST, `${lockbox.id}:${input.as_of_date}`, input.as_of_date, files.length, `lockbox.ingest:${now}`);
  const batches: BatchOutcome[] = [];
  for (const f of files) {
    try { batches.push(await ingestOneFile(rt, lockbox, cutoff, f, input, opts)); }
    catch (e) { await rt.db.tx((q) => PgFakeLockboxQueue.mark(q, f.document_id, "failed", { error: e instanceof Error ? e.message : String(e), failed_at: now })); throw e; }
  }
  const posted = batches.reduce((a, b) => a + b.posted, 0); const unidentified = batches.reduce((a, b) => a + b.unidentified, 0); const variance = batches.filter((b) => b.status === "variance").length;
  const duplicates = batches.filter((b) => b.status === "duplicate").map((b) => b.duplicate_of!);
  await ports.cycles.completeRun(run.run_id, { units_done: batches.filter((b) => b.status !== "duplicate").length, units_dead: 0, units_skipped: duplicates.length });
  // the run's receipt (35.3's spelling, emitted here so the registry finds it; deleted at 35.3's merge — plan §9 R1)
  const receipt = await rt.uow.run({}, (ctx) => ctx.events.append({ type: INGEST_RUN_COMPLETED, aggregate: { kind: "cycle_run", id: run.run_id }, actor: CASHIERING_AGENT,
    payload: { lockbox_id: lockbox.id, as_of_date: input.as_of_date, run_id: run.run_id, cycle_code: CYCLE_LOCKBOX_INGEST, period_key: `${lockbox.id}:${input.as_of_date}`, files: files.length, batches: batches.map((b) => b.batch_id), posted, unidentified, variance, duplicates, origination: true } }), { clock: rt.clock });
  return { lockbox_id: lockbox.id, as_of_date: input.as_of_date, run_id: run.run_id, files: files.length, batches, posted, unidentified, variance, duplicates, receipt_event_id: receipt.result.id };
}

async function ingestOneFile(rt: Runtime, lockbox: LockboxConfig, cutoff: { cutoff_time: string; cutoff_tz: string }, f: QueuedFile, input: IngestInput, opts: { recordDecision: boolean }): Promise<BatchOutcome> {
  const ports = ports35_5(rt);
  let parsed: RemittanceFile;
  try { parsed = parseRemittance(f.content); } catch (e) { refuse("lockbox.ingest", "FILE_INVALID", "35.5 rule 7 / Integrations `lockbox`: the FAKE remittance layout (src/infra/integrations/codecs/lockbox-remittance.ts)", `${f.file_name}: ${e instanceof Error ? e.message : String(e)}`); }
  if (parsed.lockbox_id !== lockbox.id) refuse("lockbox.ingest", "FILE_INVALID", "35.5 rule 7", `${f.file_name} names lockbox ${parsed.lockbox_id}, not ${lockbox.id}`);
  // idempotency: the file's sha256 — the same bytes again are a no-op with a decision naming the first batch (Edge cases)
  const prior = (await rt.db.query<{ id: string; status: string; receipt_date: string }>(`SELECT id, status, receipt_date::text AS receipt_date FROM lockbox_batches WHERE sha256 = $1`, [f.sha256]))[0];
  if (prior) {
    const dup: BatchOutcome = { batch_id: prior.id, sha256: f.sha256, file_name: f.file_name, receipt_date: D(prior.receipt_date), items: parsed.item_count, control_total_cents: s(parsed.control_total_cents), sum_cents: s(parsed.items.reduce((a, it) => a + it.amount_cents, 0n)), variance_cents: "0", status: "duplicate", duplicate_of: prior.id, posted: 0, unidentified: 0, rejected: 0, item_outcomes: [], received_event_id: null, posted_event_id: null, escalation_id: null, document_id: null };
    if (opts.recordDecision) await rt.uow.run({}, (ctx) => { ctx.decide({ agent: CASHIERING_AGENT.id, action: "lockbox.ingest", rationale: `DUPLICATE_FILE: ${f.file_name} (sha256 ${f.sha256}) is batch ${prior.id} (${prior.status}, received ${prior.receipt_date}) — nothing written; ${toJson(decisionRecord(dup, input))}`, ruleSetVersion: RULE_SET_ALLOCATION, subject: agg(prior.id), ruleCode: "DUPLICATE_FILE", confidence: 1, modelVersion: MODEL_VERSION_DETERMINISTIC, promptVersion: PROMPT_VERSION_35_5 }); }, { clock: rt.clock });
    await rt.db.tx((q) => PgFakeLockboxQueue.mark(q, f.document_id, "duplicate", { duplicate_of: prior.id }));
    return dup;
  }
  const batchId = randomUUID(); const receiptDate = parsed.file_date;
  const sum = parsed.items.reduce((a, it) => a + it.amount_cents, 0n); const variance = sum - parsed.control_total_cents;
  // (A) one global unit of work for the batch: every item identified (2.1's OCR tool in-process) and dated, the clearing accounts resolved (CUSTODIAL_REQUIRED
  //     refuses the batch before anything is written), `lockbox.batch.received` (arms 2.1's and 6.1's deposit clocks and SM_LOCKBOX_BATCH_POSTED_1BD, re-arms
  //     SM_LOCKBOX_FILE_EXPECTED_1BD), the stored file and the rows; a variance batch opens the officer escalation and stops here (CONTROL_TOTAL_MATCH)
  const opened = await openUnit(rt, {});
  let bound: BoundUnit | undefined; let received: DomainEvent | undefined; let escalationId: string | null = null; let documentId: string | null = null; let lockboxClearing: string | null = null;
  const items: ItemPlan[] = [];
  await rt.uow.run({}, async (uow) => {
    bound = bindUnit(rt, opened, uow); const ctx = bound.ctx;
    for (const it of parsed.items) {
      const id = await identifyItem(rt, bound, batchId, it); const ro = receivedOnFor(it.scanned_at, receiptDate, cutoff.cutoff_time, cutoff.cutoff_tz);
      const hit = id.hit; const identified = hit !== null && serviced(hit);
      items.push({ ...it, id: randomUUID(), ...ro, loan_id: hit?.id ?? null, partner_party_id: hit?.partner_party_id ?? null, loan_status: hit?.status ?? null, match_method: id.match_method, loan_number_read: id.loan_number_read, disposition: identified ? "identified" : "unidentified", clearing: null, payment_id: null, suspense_item_id: null });
    }
    if (variance === 0n) {
      for (const it of items) if (it.disposition === "identified") { it.clearing = await clearingAccountOf(rt.db, it.partner_party_id!); if (!it.clearing) refuse("lockbox.ingest", "CUSTODIAL_REQUIRED", "35.5 rule 5 / 2.1 rule 8: the receipt set debits the partner's clearing custodial account (custodial_accounts by partner_party_id)", `item ${it.item_no} of ${f.file_name}: loan ${it.loan_id} has no clearing custodial account`); }
      if (items.some((it) => it.disposition === "unidentified")) { lockboxClearing = await lockboxClearingAccount(rt.db, items); if (!lockboxClearing) refuse("lockbox.ingest", "CUSTODIAL_REQUIRED", "35.5 rule 7 / 6.5: an unidentified item's suspense is keyed by the clearing custodial account the funds sit in", `${f.file_name}: no clearing custodial account for lockbox ${lockbox.id}'s unidentified items`); }
    }
    const identifiedCount = items.filter((it) => it.disposition === "identified").length; const unidentifiedCount = items.length - identifiedCount;
    received = ctx.events.append({ type: BATCH_RECEIVED, aggregate: agg(batchId), actor: CASHIERING_AGENT, payload: { lockbox_id: lockbox.id, batch_id: batchId, file_name: f.file_name, sha256: f.sha256, file_hash: f.sha256, receipt_date: receiptDate, lockbox_receipt_date: receiptDate, received_on: receiptDate, received_at: f.received_at, received_by: "lockbox_agent", items: items.length, item_count: items.length,
      control_total_cents: s(parsed.control_total_cents), sum_cents: s(sum), variance_cents: s(variance), status: variance === 0n ? "received" : "variance", cutoff_tz: cutoff.cutoff_tz, cutoff_time: cutoff.cutoff_time, identified: identifiedCount, unidentified: unidentifiedCount, as_of_date: input.as_of_date, origination: true } });
    if (variance !== 0n) {
      const e = bound.escalations.open({ kind: "officer", ownerRole: "officer", severity: "2", payload: { rule_code: "CONTROL_TOTAL_MATCH", lockbox_id: lockbox.id, lockbox_batch_id: batchId, file_name: f.file_name, sha256: f.sha256, receipt_date: receiptDate, control_total_cents: s(parsed.control_total_cents), sum_cents: s(sum), variance_cents: s(variance), items: items.length, trigger_event_id: received.id,
        next: "nothing posts from a batch in variance: resolve the item whose amount differs — lockbox.item.resolve names a loan or a disposition; an amount change is 6.5's command with the officer (35.5 rule 10)" } }, CASHIERING_AGENT);
      escalationId = e.id;
      if (opts.recordDecision) ctx.decide({ agent: CASHIERING_AGENT.id, action: "lockbox.ingest", rationale: `CONTROL_TOTAL_MATCH: Σ items ${s(sum)} ≠ control total ${s(parsed.control_total_cents)} (variance ${s(variance)}¢) — batch ${batchId} in variance, nothing posted, officer escalation ${e.id}; ${toJson(decisionRecord({ batch_id: batchId, sha256: f.sha256, posted: 0, unidentified: 0, variance_cents: s(variance), status: "variance", duplicate_of: null }, input))}`, ruleSetVersion: RULE_SET_ALLOCATION, subject: agg(batchId), ruleCode: "CONTROL_TOTAL_MATCH", confidence: 1, modelVersion: MODEL_VERSION_DETERMINISTIC, promptVersion: PROMPT_VERSION_35_5 });
    }
  }, { clock: rt.clock, commit: async (q) => {
    const doc = await ports.documents.store(q, { kind: LOCKBOX_FILE_KIND, bytes: f.content, mime_type: "text/plain", retention_class: "life_of_loan_plus_4y", metadata: { source: "lockbox", lockbox_id: lockbox.id, batch_id: batchId, file_name: f.file_name, receipt_date: receiptDate, queue_document_id: f.document_id } });
    documentId = doc.document_id;
    await insertBatch(q, { id: batchId, lockbox_id: lockbox.id, file_name: f.file_name, sha256: f.sha256, document_id: doc.document_id, receipt_date: receiptDate, cutoff_tz: cutoff.cutoff_tz, items: items.length, control_total_cents: parsed.control_total_cents, items_identified: items.filter((it) => it.disposition === "identified").length, items_unidentified: items.filter((it) => it.disposition === "unidentified").length, items_rejected: 0, status: variance === 0n ? "received" : "variance", variance_cents: variance });
    await insertItems(q, batchId, items);
    if (bound) await commitUnit(q, rt, bound);
    await PgFakeLockboxQueue.mark(q, f.document_id, variance === 0n ? "ingested" : "variance", { batch_id: batchId });
  } });
  const outcomes = (): ItemOutcome[] => items.map((it) => ({ item_id: it.id, item_no: it.item_no, amount_cents: s(it.amount_cents), received_on: it.received_on, after_cutoff: it.after_cutoff, disposition: it.disposition, match_method: it.match_method, loan_id: it.loan_id, payment_id: it.payment_id, suspense_item_id: it.suspense_item_id }));
  const base = { batch_id: batchId, sha256: f.sha256, file_name: f.file_name, receipt_date: receiptDate, items: items.length, control_total_cents: s(parsed.control_total_cents), sum_cents: s(sum), variance_cents: s(variance), duplicate_of: null, rejected: 0, received_event_id: received!.id, document_id: documentId };
  if (variance !== 0n) return { ...base, status: "variance", posted: 0, unidentified: 0, item_outcomes: outcomes(), posted_event_id: null, escalation_id: escalationId };
  // (B) each identified item in its loan's unit of work: the receipt set on received_on, the payments row, `lockbox.item.identified`
  for (const it of items) if (it.disposition === "identified") await receiveIdentifiedItem(rt, lockbox, batchId, it, received!.id);
  // (C) the unidentified items in one global unit of work: the receipt set on the lockbox's clearing account, 6.5's suspense row, `lockbox.item.unidentified`
  const unidentified = items.filter((it) => it.disposition === "unidentified");
  if (unidentified.length) await receiveUnidentifiedItems(rt, lockbox, batchId, unidentified, lockboxClearing!, received!.id);
  // (D) every item a payment or a suspense item: `lockbox.batch.posted` satisfies SM_LOCKBOX_BATCH_POSTED_1BD (the instance armed in (A), hydrated by openGlobal); the batch row moves to posted
  const posted = items.filter((it) => it.payment_id).length; const unidentifiedCount = items.filter((it) => it.suspense_item_id).length;
  const postedResult = await rt.uow.run({}, (ctx) => {
    const e = ctx.events.append({ type: BATCH_POSTED, aggregate: agg(batchId), actor: CASHIERING_AGENT, causationId: received!.id, payload: { lockbox_id: lockbox.id, batch_id: batchId, receipt_date: receiptDate, posted, unidentified: unidentifiedCount, rejected: 0, items: items.length, payment_ids: items.filter((it) => it.payment_id).map((it) => it.payment_id), suspense_item_ids: items.filter((it) => it.suspense_item_id).map((it) => it.suspense_item_id), as_of_date: input.as_of_date } });
    if (opts.recordDecision) ctx.decide({ agent: CASHIERING_AGENT.id, action: "lockbox.ingest", rationale: `cashiering.allocation.v1: batch ${batchId} (${f.file_name}, receipt ${receiptDate}) posted — ${posted} identified to payments, ${unidentifiedCount} to 6.5 suspense, variance 0; ${toJson(decisionRecord({ batch_id: batchId, sha256: f.sha256, posted, unidentified: unidentifiedCount, variance_cents: "0", status: "posted", duplicate_of: null }, input, { payment_ids: items.filter((it) => it.payment_id).map((it) => it.payment_id), suspense_item_ids: items.filter((it) => it.suspense_item_id).map((it) => it.suspense_item_id) }))}`, ruleSetVersion: RULE_SET_ALLOCATION, subject: agg(batchId), confidence: 1, modelVersion: MODEL_VERSION_DETERMINISTIC, promptVersion: PROMPT_VERSION_35_5 });
    return e;
  }, { clock: rt.clock, commit: async (q) => { await q.query(`UPDATE lockbox_batches SET status = 'posted', items_identified = $2, items_unidentified = $3, items_rejected = 0, posted_at = $4 WHERE id = $1`, [batchId, posted, unidentifiedCount, rt.clock.now()]); } });
  return { ...base, status: "posted", posted, unidentified: unidentifiedCount, item_outcomes: outcomes(), posted_event_id: postedResult.result.id, escalation_id: null };
}

/** (B): the identified item as the loan's `payments` row with 2.1's receipt set posted on its `received_on` (credit as of receipt), in the loan's unit of work. */
async function receiveIdentifiedItem(rt: Runtime, lockbox: LockboxConfig, batchId: string, it: ItemPlan, receivedEventId: string): Promise<void> {
  const loanId = it.loan_id!; const ports = ports35_5(rt);
  const opened = await openUnit(rt, { loanId });
  let bound: BoundUnit | undefined; let paymentId = "";
  await rt.uow.run({ loanId }, async (uow) => {
    bound = bindUnit(rt, opened, uow); const ctx = bound.ctx;
    const key = itemIdempotencyKey(batchId, it.item_no, it.amount_cents, it.received_on);
    const dup = bound.store.list("payments", (d) => d.loan_id === loanId && d.idempotency_key === key)[0];
    if (dup) { paymentId = dup.id; return; }
    paymentId = randomUUID();
    const receipt = ctx.ledger.post({ effectiveDate: it.received_on, description: `receipt ${paymentId}`, lines: [{ account: cust(it.clearing!, "clearing_cash"), amountCents: it.amount_cents, ruleRef: RULE_REF_RECEIPT }, { account: { scope: "loan", loanId, account: "suspense_unapplied" }, amountCents: -it.amount_cents, ruleRef: RULE_REF_RECEIPT }] }, ctx.clock.now());
    ports.cashRows.writeReceivedPayment(bound.store, ctx, { payment_id: paymentId, loan_id: loanId, amount_cents: it.amount_cents, received_on: it.received_on, credited_as_of: it.received_on, channel: "lockbox", instrument: "check", designation: "contractual", status: "identified", idempotency_key: key, payer_name: it.payer || null, check_number: it.check_no || null, source_batch_id: batchId, source_item_id: String(it.item_no), received_at: it.scanned_at, receipt_entry_set_id: receipt.id, ledger_entry_set_ids: [receipt.id], match_method: it.match_method, scanline: it.scanline || null });
    ctx.events.append({ type: ITEM_IDENTIFIED, loanId, aggregate: agg(batchId), actor: CASHIERING_AGENT, causationId: receivedEventId, payload: { lockbox_id: lockbox.id, batch_id: batchId, item_no: it.item_no, item_id: it.id, loan_id: loanId, payment_id: paymentId, amount_cents: s(it.amount_cents), received_on: it.received_on, after_cutoff: it.after_cutoff, match_method: it.match_method, loan_number_read: it.loan_number_read, receipt_entry_set_id: receipt.id, clearing_account_id: it.clearing } });
  }, { clock: rt.clock, commit: async (q) => { if (bound) await commitUnit(q, rt, bound); await q.query(`UPDATE lockbox_items SET payment_id = $2, disposition = 'identified' WHERE id = $1`, [it.id, paymentId]); } });
  it.payment_id = paymentId;
}

/** (C): the unidentified items as 6.5's `suspense_items` rows (`source lockbox`, `reason unidentified_loan`) with the receipt set on the lockbox's clearing account, in one global unit of work. */
async function receiveUnidentifiedItems(rt: Runtime, lockbox: LockboxConfig, batchId: string, items: ItemPlan[], clearing: string, receivedEventId: string): Promise<void> {
  const ports = ports35_5(rt);
  const opened = await openUnit(rt, {});
  let bound: BoundUnit | undefined; const ids = new Map<string, string>();
  await rt.uow.run({}, async (uow) => {
    bound = bindUnit(rt, opened, uow); const ctx = bound.ctx;
    for (const it of items) {
      const receipt = ctx.ledger.post({ effectiveDate: it.received_on, description: `receipt lockbox ${batchId}#${it.item_no}`, lines: [{ account: cust(clearing, "clearing_cash"), amountCents: it.amount_cents, ruleRef: RULE_REF_RECEIPT }, { account: cust(clearing, "suspense_unapplied"), amountCents: -it.amount_cents, ruleRef: RULE_REF_RECEIPT }] }, ctx.clock.now());
      const { suspense_item_id } = ports.cashRows.writeSuspenseItem(bound.store, ctx, { loan_id: null, amount_cents: it.amount_cents, received_on: it.received_on, source: "lockbox", reason_code: "unidentified_loan", batch_id: batchId, item_no: it.item_no, receipt_entry_set_id: receipt.id, custodial_account_id: clearing, payer_name: it.payer || null, check_number: it.check_no || null, scanline: it.scanline || null, loan_number_read: it.loan_number_read });
      ids.set(it.id, suspense_item_id);
      ctx.events.append({ type: ITEM_UNIDENTIFIED, aggregate: agg(batchId), actor: CASHIERING_AGENT, causationId: receivedEventId, payload: { lockbox_id: lockbox.id, batch_id: batchId, item_no: it.item_no, item_id: it.id, suspense_item_id, amount_cents: s(it.amount_cents), received_on: it.received_on, after_cutoff: it.after_cutoff, scanline: it.scanline, loan_number_read: it.loan_number_read, match_method: it.match_method, matched_loan_id: it.loan_id, loan_status: it.loan_status, receipt_entry_set_id: receipt.id, custodial_account_id: clearing, route: "6.5 suspense_items{source=lockbox, reason_code=unidentified_loan}" } });
    }
  }, { clock: rt.clock, commit: async (q) => { if (bound) await commitUnit(q, rt, bound); for (const it of items) await q.query(`UPDATE lockbox_items SET suspense_item_id = $2, disposition = 'unidentified' WHERE id = $1`, [it.id, ids.get(it.id) ?? null]); } });
  for (const it of items) it.suspense_item_id = ids.get(it.id) ?? null;
}

// ---------------------------------------------------------------- the bus tools
type Services = { runtime?: Runtime; deferWrite?: (fn: (q: Queryable) => Promise<void>) => void };
/** `lockbox.ingest{lockbox_id, as_of_date}` — the runner through `services.runtime` (its own units of work, sequential to this command's — the 33.2 review.run shape); the decision is the bus's. */
export async function lockboxIngest(i: ToolInput, _ctx: CommandContext, rt: ToolRuntime): Promise<unknown> {
  const lockboxId = str(i, "lockbox_id"); if (!lockboxId) throw new RangeError("lockbox_id is required");
  const asOf = str(i, "as_of_date"); if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new RangeError("as_of_date (YYYY-MM-DD) is required");
  const runtime = (rt.services as Services).runtime; if (!runtime) throw new RangeError("lockbox.ingest needs the hosted runtime (services.runtime)");
  return ingestLockboxFile(runtime, { lockbox_id: lockboxId, as_of_date: D(asOf) }, { recordDecision: false });
}

/**
 * `lockbox.item.resolve{item_id, loan_id | disposition: rejected | duplicate, reason}` (`ops_analyst` / `officer`): an unidentified item resolved by a person.
 * A loan named → the item becomes that loan's `payments` row (`identified`, `match_method manual`) carrying the ingest's receipt set, parked on the clearing
 * account's suspense until 2.1 posts it (section2-1.ts releases it) — no ledger line here (rule 10 / NO_MONEY_FIELD); the suspense item is `matched`.
 * A disposition → the item and its suspense row take it; the funds stay in 6.5's suspense (a refund or return is 6.5's command).
 */
export async function lockboxItemResolve(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<unknown> {
  const itemId = str(i, "item_id"); if (!itemId) throw new RangeError("item_id is required");
  const reason = str(i, "reason"); if (!reason) throw new RangeError("reason is required");
  const loanId = str(i, "loan_id"); const disposition = str(i, "disposition");
  if (!loanId && !disposition) throw new RangeError("loan_id or disposition (rejected | duplicate) is required");
  if (loanId && disposition) throw new RangeError("loan_id and disposition are exclusive: a loan identifies the item, a disposition closes it");
  if (disposition && disposition !== "rejected" && disposition !== "duplicate") throw new RangeError(`disposition must be rejected or duplicate, not ${disposition}`);
  const services = rt.services as Services; const runtime = services.runtime; const deferWrite = services.deferWrite;
  if (!runtime || !deferWrite) throw new RangeError("lockbox.item.resolve needs the hosted runtime (services.runtime, services.deferWrite)");
  const item = await readItem(runtime.db, itemId); if (!item) throw new RangeError(`no lockbox item ${itemId}`);
  if (item.disposition !== "unidentified") refuse("lockbox.item.resolve", "ITEM_RESOLVED", "35.5 state machine: an item is identified once — a payment changes only through 2.1's commands", `item ${itemId} is ${item.disposition}${item.payment_id ? ` (payment ${item.payment_id})` : ""}`);
  const resolvedBy = { actor: `${ctx.actor.kind}:${ctx.actor.id}`, role: ctx.actor.role ?? null, reason, at: ctx.now };
  const suspense = item.suspense_item_id ? rt.store.get("suspense_items", item.suspense_item_id) : undefined;
  if (disposition) {
    if (suspense) rt.store.put("suspense_items", suspense.id, { ...suspense.data, status: disposition, resolved_by: resolvedBy }, ctx.actor, ctx.now);
    ctx.events.append({ type: ITEM_RESOLVED, aggregate: agg(item.batch_id), actor: ctx.actor, payload: { item_id: item.id, batch_id: item.batch_id, item_no: item.item_no, disposition, suspense_item_id: item.suspense_item_id, amount_cents: s(item.amount_cents), reason } });
    deferWrite((q) => q.query(`UPDATE lockbox_items SET disposition = $2, resolved_by = $3::jsonb WHERE id = $1`, [item.id, disposition, toJson(resolvedBy)]).then(() => undefined));
    return { item_id: item.id, batch_id: item.batch_id, disposition, loan_id: null, payment_id: null, suspense_item_id: item.suspense_item_id, amount_cents: s(item.amount_cents) };
  }
  const loan = (await runtime.db.query<LoanHit>(`SELECT id, status::text AS status, partner_party_id, boarded_at::text AS boarded_at FROM loans WHERE id = $1`, [loanId]))[0];
  if (!loan) throw new RangeError(`no loan ${loanId}`);
  if (!serviced(loan)) refuse("lockbox.item.resolve", "LOAN_NOT_SERVICED", "35.5 Edge cases: an item naming a paid-off or transferred-out loan stays unidentified — 6.5 refunds or forwards (17.x)", `loan ${loanId} is ${loan.status}${loan.boarded_at ? "" : " (not boarded)"}`);
  const parkedOn = suspense && typeof suspense.data.custodial_account_id === "string" ? suspense.data.custodial_account_id : null;
  const receiptSetId = suspense && typeof suspense.data.receipt_entry_set_id === "string" ? suspense.data.receipt_entry_set_id : null;
  const key = itemIdempotencyKey(item.batch_id, item.item_no, item.amount_cents, item.received_on);
  let paymentId = "";
  const write = (store: ToolRuntime["store"], uctx: CommandContext | BoundUnit["ctx"]): void => {
    const existing = store.list("payments", (d) => d.loan_id === loanId && d.idempotency_key === key)[0];
    if (existing) { paymentId = existing.id; return; }
    paymentId = randomUUID();
    ports35_5(runtime).cashRows.writeReceivedPayment(store, uctx, { payment_id: paymentId, loan_id: loanId, amount_cents: item.amount_cents, received_on: item.received_on, credited_as_of: item.received_on, channel: "lockbox", instrument: "check", designation: "contractual", status: "identified", idempotency_key: key, payer_name: item.payer_name, check_number: item.check_number, source_batch_id: item.batch_id, source_item_id: String(item.item_no), received_at: item.scanned_at,
      receipt_entry_set_id: receiptSetId, ledger_entry_set_ids: receiptSetId ? [receiptSetId] : [], receipt_parked_account: parkedOn ? { custodial_account_id: parkedOn, account: "suspense_unapplied" } : null, match_method: "manual", scanline: item.scanline || null, actor: ctx.actor });
    if (suspense) store.put("suspense_items", suspense.id, { ...suspense.data, status: "matched", loan_id: loanId, payment_id: paymentId, matched_by: resolvedBy }, ctx.actor, ctx.now);
    uctx.events.append({ type: ITEM_IDENTIFIED, loanId, aggregate: agg(item.batch_id), actor: ctx.actor, payload: { batch_id: item.batch_id, item_no: item.item_no, item_id: item.id, loan_id: loanId, payment_id: paymentId, amount_cents: s(item.amount_cents), received_on: item.received_on, match_method: "manual", suspense_item_id: item.suspense_item_id, receipt_entry_set_id: receiptSetId, parked_on: parkedOn, resolved_by: resolvedBy } });
  };
  const rowUpdate = (q: Queryable): Promise<void> => q.query(`UPDATE lockbox_items SET matched_loan_id = $2, match_method = 'manual', payment_id = $3, disposition = 'identified', resolved_by = $4::jsonb WHERE id = $1`, [item.id, loanId, paymentId, toJson(resolvedBy)]).then(() => undefined);
  if (ctx.loanId === loanId) { write(rt.store, ctx); deferWrite(rowUpdate); }
  else {
    // a global command (no loan scope): the loan's rows in the loan's own unit of work, sequential to this command's (the 33.2 pass-shaped precedent)
    const opened = await openUnit(runtime, { loanId }); let bound: BoundUnit | undefined;
    await runtime.uow.run({ loanId }, async (uow) => { bound = bindUnit(runtime, opened, uow); write(bound.store, bound.ctx); }, { clock: runtime.clock, commit: async (q) => { if (bound) await commitUnit(q, runtime, bound); await rowUpdate(q); } });
  }
  return { item_id: item.id, batch_id: item.batch_id, disposition: "identified", match_method: "manual", loan_id: loanId, payment_id: paymentId, suspense_item_id: item.suspense_item_id, amount_cents: s(item.amount_cents), parked_on: parkedOn };
}
