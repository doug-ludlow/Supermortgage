/**
 * §35.2 rules 9 and 10 — mail is a manifest in and a manifest out. `mail.batch` renders nothing: every piece's PDF already
 * exists; it writes one outbound `mail_manifests` row with one `mail_manifest_pieces` row per notice delivery (sheets =
 * ceil(page_count ÷ 2), the template's separate_document as separate_envelope, the address snapshot from the notice), the
 * manifest file (NDJSON) stored as a document and hashed, one `integration_messages` row to the print-mail adapter
 * (idempotency key = the batch id; 35.1's dispatcher delivers it — nothing here calls the vendor), and arms SM_MAIL_MANIFEST_2BD
 * on `mail.batch.submitted{submitted_at}`. `mail.manifest.ingest` parses the vendor's proof-of-mailing file (or an analyst's,
 * after the in-house fallback), matches pieces by notice_id + attempt_no, writes the inbound rows, sets
 * notice_deliveries.mailed_at / imb / mail_manifest_id (manifest_id keeps naming the 0009 batch), marks the manifest reconciled
 * when the counts match, emits `mail.manifest.ingested` (the clock's satisfier) and `mail.piece.mailed` per piece, and opens an
 * ops_analyst escalation naming every piece the vendor did not mail (and every piece the outbound manifest did not name).
 * `mail.fallback` builds the same manifest with vendor = in_house, one merged PDF per mail class in page order with a cover
 * sheet per piece, emits `mail.batch.submitted{vendor: in_house}` and escalates to ops_analyst to print and post.
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "../../../infra/db/client.ts";
import { toJson } from "../../../infra/db/client.ts";
import { PgOutbox } from "../../../infra/integrations/pg-outbox.ts";
import type { PrintMailPort, ProofOfMailing } from "../../../infra/integrations/delivery.ts";
import { mergePdfs, pageFromBlocks, sha256Hex, type TextOp } from "../../../infra/files/pdf.ts";
import { wallClock } from "../../../kernel/calendar/zoned.ts";
import { storeDocument } from "./store.ts";
import { documentBytes } from "./open.ts";
import { requireDocument, DocumentsRefused, type DocsDeps } from "./shared.ts";

export const MANIFEST_KIND = "mail_manifest";
export const MERGED_KIND = "mail_merged";
export const MANIFEST_MIME = "application/x-ndjson";
export const MAIL_CLASSES = new Set(["first_class", "certified", "certified_rrr", "priority"]);
export const PRINT_MAIL_ADAPTER = "print-mail";

export interface PieceLine { readonly piece_id: string; readonly notice_id: string; readonly attempt_no: number; readonly document_id: string; readonly sha256: string; readonly page_count: number; readonly sheets: number; readonly mail_class: string; readonly separate_envelope: boolean; readonly address: { name: string; address: string }; readonly vendor_piece_id: string | null; }
export interface ManifestRow extends Record<string, unknown> { id: string; notice_batch_id: string | null; direction: "outbound" | "inbound"; vendor: string; file_name: string | null; sha256: string | null; piece_count: number; sheet_count: number | null; submitted_at: string | null; received_at: string | null; document_id: string | null; reconciled: boolean | null; status: string; created_at: string; }
export interface PieceRow extends Record<string, unknown> { id: string; manifest_id: string; notice_id: string | null; attempt_no: number | null; document_id: string | null; sha256: string | null; page_count: number | null; sheets: number | null; mail_class: string | null; separate_envelope: boolean | null; address_snapshot: { name?: string; address?: string } | null; vendor_piece_id: string | null; imb: string | null; mailed_on: string | null; }

const isUuid = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const sheetsOf = (pages: number): number => Math.max(1, Math.ceil(pages / 2));
const batchKey = (batchId: string) => ({ aggregate: { kind: "mail_batch", id: batchId } });
export async function readManifest(q: Queryable, id: string): Promise<ManifestRow | undefined> { return (await q.query<ManifestRow>(`SELECT id, notice_batch_id, direction, vendor, file_name, sha256, piece_count, sheet_count, submitted_at, received_at, document_id, reconciled, status, created_at FROM mail_manifests WHERE id = $1`, [id]))[0]; }
export async function manifestPieces(q: Queryable, manifestId: string): Promise<PieceRow[]> { return q.query<PieceRow>(`SELECT id, manifest_id, notice_id, attempt_no, document_id, sha256, page_count, sheets, mail_class, separate_envelope, address_snapshot, vendor_piece_id, imb, mailed_on::text AS mailed_on FROM mail_manifest_pieces WHERE manifest_id = $1 ORDER BY created_at, id`, [manifestId]); }

/** The manifest file: a header line, then one line per piece (piece id, notice id, document sha256, mail class, address). */
export function manifestNdjson(header: Record<string, unknown>, pieces: readonly PieceLine[]): Buffer {
  return Buffer.from([JSON.stringify(header), ...pieces.map((p) => JSON.stringify({ piece_id: p.piece_id, notice_id: p.notice_id, attempt_no: p.attempt_no, document_id: p.document_id, sha256: p.sha256, page_count: p.page_count, sheets: p.sheets, mail_class: p.mail_class, separate_envelope: p.separate_envelope, address: p.address }))].join("\n") + "\n", "utf8");
}
async function insertManifest(q: Queryable, m: { id: string; notice_batch_id: string | null; direction: "outbound" | "inbound"; vendor: string; file_name: string; sha256: string; piece_count: number; sheet_count: number | null; submitted_at: string | null; received_at: string | null; document_id: string; reconciled: boolean | null; status: string }): Promise<void> {
  await q.query(`INSERT INTO mail_manifests (id, notice_batch_id, direction, vendor, file_name, sha256, piece_count, sheet_count, submitted_at, received_at, document_id, reconciled, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz, $11, $12, $13)`,
    [m.id, m.notice_batch_id, m.direction, m.vendor, m.file_name, m.sha256, m.piece_count, m.sheet_count, m.submitted_at, m.received_at, m.document_id, m.reconciled, m.status]);
}
async function insertPieces(q: Queryable, manifestId: string, pieces: readonly (PieceLine & { imb?: string | null; mailed_on?: string | null })[]): Promise<void> {
  for (const p of pieces) await q.query(`INSERT INTO mail_manifest_pieces (id, manifest_id, notice_id, attempt_no, document_id, sha256, page_count, sheets, mail_class, separate_envelope, address_snapshot, vendor_piece_id, imb, mailed_on) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14::date)`,
    [p.piece_id, manifestId, p.notice_id, p.attempt_no, p.document_id, p.sha256, p.page_count, p.sheets, p.mail_class, p.separate_envelope, toJson(p.address), p.vendor_piece_id, p.imb ?? null, p.mailed_on ?? null]);
}

// ───────── mail.batch ─────────
export interface BatchInput { readonly notice_ids?: readonly string[]; readonly notice_batch_id?: string | null; readonly mail_class?: string | null; }
export interface BatchResult { readonly batch_id: string; readonly manifest_id: string; readonly document_id: string; readonly file_sha256: string; readonly piece_count: number; readonly sheet_count: number; readonly vendor: string; readonly submitted_at: string; readonly pieces: readonly PieceLine[]; readonly outbox_message_id: string; }
interface DeliveryRow extends Record<string, unknown> { id: string; notice_id: string; attempt_no: number; channel: string; vendor_piece_id: string | null; party_id?: string | null; }
interface NoticeRow extends Record<string, unknown> { id: string; template_code: string; document_id: string | null; address_snapshot: { party_id?: string; name?: string; address?: string | null }[] | null; channel_decision: { partyId?: string; channel?: string; held?: string }[] | null; }
/** The recipient a mail delivery went to: the k-th mail delivery (by attempt) is the k-th non-held mail decision's party (NoticeService.mail walks the decisions in order); its address is that party's snapshot entry. */
function addressFor(n: NoticeRow, delivery: DeliveryRow, mailDeliveries: readonly DeliveryRow[]): { name: string; address: string } {
  const snapshot = n.address_snapshot ?? [];
  // the delivery names its recipient (0166); a row written before that column maps the k-th mail delivery to the k-th unheld mail decision, which holds only while every mail delivery is a decision
  let party = delivery.party_id ?? null;
  if (!party) {
    const decisions = (n.channel_decision ?? []).filter((d) => typeof d.channel === "string" && d.channel.startsWith("mail") && !d.held);
    const k = mailDeliveries.findIndex((d) => d.id === delivery.id);
    if (decisions.length !== mailDeliveries.length) throw new RangeError(`notice ${n.id}: delivery ${delivery.attempt_no} names no recipient and its ${mailDeliveries.length} mail deliveries do not match its ${decisions.length} mail decisions — the address cannot be guessed`);
    party = decisions[k]?.partyId ?? null;
  }
  const withAddress = snapshot.filter((x) => x.address);
  const r = (party ? withAddress.find((x) => x.party_id === party) : undefined) ?? (withAddress.length === 1 ? withAddress[0] : undefined);
  if (!r?.address) throw new RangeError(`notice ${n.id} carries no mailing address for delivery ${delivery.attempt_no}${party ? ` (party ${party})` : ""}`);
  return { name: r.name ?? "", address: r.address };
}
/** One piece per mail delivery awaiting a manifest: the notice's stored PDF, its hash and pages, the template's separate_document, the delivery's own recipient. */
async function piecesForDeliveries(q: Queryable, deliveries: readonly DeliveryRow[], mailClass: string | null): Promise<PieceLine[]> {
  const out: PieceLine[] = [];
  const byNotice = new Map<string, DeliveryRow[]>();
  for (const d of deliveries) byNotice.set(d.notice_id, [...(byNotice.get(d.notice_id) ?? []), d]);
  for (const [nid, ds] of byNotice) {
    const n = (await q.query<NoticeRow>(`SELECT id, template_code, document_id, address_snapshot, channel_decision FROM notices WHERE id = $1`, [nid]))[0];
    if (!n) throw new RangeError(`no notices row ${nid}`);
    if (!n.document_id) throw new RangeError(`notice ${nid} has no rendered document (documents.render stores the PDF before a batch)`);
    const doc = await requireDocument(q, n.document_id);
    if (doc.storage_status === "disposed") throw new RangeError(`notice ${nid}: its document was disposed`);
    const t = (await q.query<{ separate_document: boolean }>(`SELECT separate_document FROM notice_templates WHERE code = $1`, [n.template_code]))[0];
    const allMail = await q.query<DeliveryRow>(`SELECT id, notice_id, attempt_no, channel, vendor_piece_id, party_id FROM notice_deliveries WHERE notice_id = $1 AND channel LIKE 'mail%' ORDER BY attempt_no`, [nid]);
    const pages = doc.page_count ?? 1;
    for (const d of ds.sort((a, b) => Number(a.attempt_no) - Number(b.attempt_no))) {
      const cls = mailClass ?? (d.channel === "mail_certified" ? "certified" : "first_class");
      out.push({ piece_id: randomUUID(), notice_id: n.id, attempt_no: Number(d.attempt_no), document_id: doc.id, sha256: doc.sha256, page_count: pages, sheets: sheetsOf(pages), mail_class: cls, separate_envelope: t?.separate_document ?? false, address: addressFor(n, d, allMail), vendor_piece_id: d.vendor_piece_id });
    }
  }
  return out;
}
export async function mailBatch(deps: DocsDeps, i: BatchInput): Promise<BatchResult> {
  const q = deps.q;
  if (i.mail_class && !MAIL_CLASSES.has(i.mail_class)) throw new RangeError(`mail_class ${i.mail_class} is not first_class, certified, certified_rrr or priority`);
  let deliveries: DeliveryRow[]; let batchId: string; let ownBatch = false;
  if (i.notice_batch_id) {
    // 7.x's batch: the deliveries assigned to it (notice_deliveries.manifest_id, 0009) that no manifest has carried yet — the batch row is theirs, this is its one submission
    if (!isUuid(i.notice_batch_id)) throw new RangeError("notice_batch_id is a uuid");
    if (!(await q.query(`SELECT 1 FROM notice_batches WHERE id = $1`, [i.notice_batch_id])).length) throw new RangeError(`no notice_batches row ${i.notice_batch_id}`);
    if ((await q.query(`SELECT 1 FROM mail_manifests WHERE notice_batch_id = $1 AND direction = 'outbound' LIMIT 1`, [i.notice_batch_id])).length) throw new DocumentsRefused("BATCH_ALREADY_SUBMITTED", "35.2 rule 9: one outbound manifest per batch (the print-mail outbox key is the batch id); a piece the vendor did not mail is the fallback's", `batch ${i.notice_batch_id} already has its outbound manifest`);
    deliveries = await q.query<DeliveryRow>(`SELECT id, notice_id, attempt_no, channel, vendor_piece_id, party_id FROM notice_deliveries WHERE manifest_id = $1 AND channel LIKE 'mail%' AND mail_manifest_id IS NULL AND mailed_at IS NULL ORDER BY notice_id, attempt_no`, [i.notice_batch_id]);
    batchId = i.notice_batch_id;
  } else {
    const ids = [...new Set((i.notice_ids ?? []).map(String))];
    if (!ids.length) throw new RangeError("mail.batch needs notice_ids (or a notice_batch_id with mail deliveries awaiting a manifest)");
    for (const nid of ids) if (!isUuid(nid)) throw new RangeError(`notice id ${nid} is not a uuid`);
    deliveries = await q.query<DeliveryRow>(`SELECT id, notice_id, attempt_no, channel, vendor_piece_id, party_id FROM notice_deliveries WHERE notice_id = ANY($1::uuid[]) AND channel LIKE 'mail%' AND manifest_id IS NULL ORDER BY notice_id, attempt_no`, [ids]);
    const covered = new Set(deliveries.map((d) => d.notice_id));
    const missing = ids.filter((nid) => !covered.has(nid));
    if (missing.length) throw new RangeError(`notice ${missing[0]} has no mail delivery awaiting a manifest (its channel decision was not mail, or it is on a batch already)`);
    batchId = randomUUID(); ownBatch = true;
  }
  if (!deliveries.length) throw new RangeError(`batch ${i.notice_batch_id ?? ""}: no mail delivery awaiting a manifest`);
  const pieces = await piecesForDeliveries(q, deliveries, i.mail_class ?? null);
  const manifestId = randomUUID();
  const businessDate = String(wallClock(Date.parse(deps.now), "America/New_York").date);
  const sheetCount = pieces.reduce((n, p) => n + p.sheets, 0);
  if (ownBatch) await q.query(`INSERT INTO notice_batches (id, batch_type, business_date, counts, status) VALUES ($1, 'mail', $2::date, $3::jsonb, 'submitted')`, [batchId, businessDate, toJson({ pieces: pieces.length, sheets: sheetCount })]);
  const file = manifestNdjson({ manifest_id: manifestId, batch_id: batchId, vendor: "FAKE", submitted_at: deps.now, piece_count: pieces.length, sheet_count: sheetCount }, pieces);
  const fileName = `manifest-${batchId}.ndjson`;
  const stored = await storeDocument(deps, { kind: MANIFEST_KIND, bytes: file, mime_type: MANIFEST_MIME, retention_class: "corporate_7y", metadata: { title: "Outbound mail manifest", batch_id: batchId, manifest_id: manifestId, vendor: "FAKE", piece_count: pieces.length, file_name: fileName } });
  await insertManifest(q, { id: manifestId, notice_batch_id: batchId, direction: "outbound", vendor: "FAKE", file_name: fileName, sha256: stored.sha256, piece_count: pieces.length, sheet_count: sheetCount, submitted_at: deps.now, received_at: null, document_id: stored.document_id, reconciled: null, status: "submitted" });
  await insertPieces(q, manifestId, pieces);
  if (ownBatch) for (const p of pieces) await q.query(`UPDATE notice_deliveries SET manifest_id = $3 WHERE notice_id = $1 AND attempt_no = $2`, [p.notice_id, p.attempt_no, batchId]);
  // the file to the adapter rides the outbox (35.1's dispatcher delivers it; the key is the batch id, so a retry is one file); each piece names the single job the render submitted, so the vendor dedupes
  const { message } = await new PgOutbox(q).enqueue({ adapter: PRINT_MAIL_ADAPTER, idempotencyKey: batchId, payload: { method: "submitManifest", args: [{ manifest_id: manifestId, batch_id: batchId, vendor: "FAKE", submitted_at: deps.now, pieces }] }, payloadSummary: { manifest_id: manifestId, batch_id: batchId, piece_count: pieces.length, sheet_count: sheetCount, file_sha256: stored.sha256 } }, deps.now);
  deps.events.append({ type: "mail.batch.submitted", ...batchKey(batchId), actor: deps.actor, payload: { batch_id: batchId, manifest_id: manifestId, vendor: "FAKE", piece_count: pieces.length, sheet_count: sheetCount, submitted_at: deps.now, document_id: stored.document_id, file_sha256: stored.sha256, notice_ids: [...new Set(pieces.map((p) => p.notice_id))] } });
  return { batch_id: batchId, manifest_id: manifestId, document_id: stored.document_id, file_sha256: stored.sha256, piece_count: pieces.length, sheet_count: sheetCount, vendor: "FAKE", submitted_at: deps.now, pieces, outbox_message_id: message.id };
}

// ───────── mail.manifest.ingest ─────────
export interface IngestInput { readonly manifest_id: string; readonly source: "vendor" | "analyst"; readonly pieces?: readonly { notice_id: string; attempt_no: number; mailed_on: string; imb?: string | null; vendor_piece_id?: string | null }[]; }
export interface IngestResult { readonly manifest_id: string; readonly inbound_manifest_id: string; readonly batch_id: string | null; readonly piece_count: number; readonly matched: number; readonly unmatched: readonly { notice_id: string; attempt_no: number }[]; readonly unmailed: readonly { notice_id: string; attempt_no: number }[]; readonly reconciled: boolean; readonly escalation_ids: readonly string[]; }
export async function ingestManifest(deps: DocsDeps, port: PrintMailPort | undefined, i: IngestInput): Promise<IngestResult> {
  const q = deps.q;
  if (!isUuid(i.manifest_id)) throw new RangeError("manifest_id is a uuid");
  const outbound = await readManifest(q, i.manifest_id);
  if (!outbound || outbound.direction !== "outbound") throw new RangeError(`no outbound mail_manifests row ${i.manifest_id}`);
  if ((await q.query(`SELECT 1 FROM mail_manifests WHERE direction = 'inbound' AND notice_batch_id = $1 AND vendor = $2 AND reconciled LIMIT 1`, [outbound.notice_batch_id, outbound.vendor])).length) throw new DocumentsRefused("MANIFEST_ALREADY_INGESTED", "35.2 rule 9: the manifest was reconciled — every piece has its proof of mailing; the inbound rows are append-only", `manifest ${outbound.id} is reconciled`);
  const pieces = await manifestPieces(q, outbound.id);
  const byKey = new Map(pieces.map((p) => [`${p.notice_id}|${p.attempt_no}`, p] as const));
  const batchNotices = new Set(pieces.map((p) => p.notice_id));
  const mailed = new Set((await q.query<{ notice_id: string; attempt_no: number }>(`SELECT notice_id, attempt_no FROM notice_deliveries WHERE mailed_at IS NOT NULL AND notice_id = ANY($1::uuid[])`, [[...batchNotices]])).map((d) => `${d.notice_id}|${d.attempt_no}`));
  let lines: { notice_id: string; attempt_no: number; mailed_on: string; mailed_at: string | null; imb: string | null; vendor_piece_id: string | null }[];
  if (i.source === "vendor") {
    if (!port?.manifests) throw new RangeError("the print-mail adapter has no proof-of-mailing feed wired");
    const feed: readonly ProofOfMailing[] = await port.manifests(outbound.submitted_at ?? outbound.created_at);
    // the vendor's file is one feed for every batch: this manifest's lines are the ones naming its notices (any attempt — a piece the outbound did not name is the edge case) or its batch
    lines = feed.filter((l) => batchNotices.has(l.notice_id) || (l.batch_id !== undefined && l.batch_id === outbound.notice_batch_id)).map((l) => ({ notice_id: l.notice_id, attempt_no: l.attempt_no, mailed_on: l.mailed_on, mailed_at: l.mailed_at ?? null, imb: l.imb, vendor_piece_id: l.vendor_piece_id }));
  } else {
    if (deps.actor.kind !== "human") throw new RangeError("an analyst's manifest is a human act (the in-house fallback's proof of mailing)");
    if (!Array.isArray(i.pieces) || !i.pieces.length) throw new RangeError("pieces [{notice_id, attempt_no, mailed_on, imb?}] are required for source: analyst");
    for (const p of i.pieces) if (!isUuid(p.notice_id) || !Number.isInteger(p.attempt_no) || !/^\d{4}-\d{2}-\d{2}$/.test(String(p.mailed_on))) throw new RangeError(`piece ${String(p.notice_id)}:${String(p.attempt_no)} is malformed (mailed_on is YYYY-MM-DD)`);
    lines = i.pieces.map((p) => ({ notice_id: p.notice_id, attempt_no: p.attempt_no, mailed_on: String(p.mailed_on), mailed_at: null, imb: p.imb ?? null, vendor_piece_id: p.vendor_piece_id ?? null }));
  }
  // a foreign line an earlier file of this batch already flagged (its inbound row has notice_id null) is not flagged again: keyed by the vendor's piece id, else the IMB and attempt
  const flaggedBefore = new Set((await q.query<{ vendor_piece_id: string | null; imb: string | null; attempt_no: number }>(`SELECT p.vendor_piece_id, p.imb, p.attempt_no FROM mail_manifest_pieces p JOIN mail_manifests i ON i.id = p.manifest_id WHERE i.direction = 'inbound' AND i.notice_batch_id IS NOT DISTINCT FROM $1 AND p.notice_id IS NULL`, [outbound.notice_batch_id])).map((r) => r.vendor_piece_id ?? `imb:${r.imb ?? ""}|${r.attempt_no}`));
  const foreignKey = (l: { vendor_piece_id: string | null; imb: string | null; attempt_no: number }): string => l.vendor_piece_id ?? `imb:${l.imb ?? ""}|${l.attempt_no}`;
  const fresh = lines.filter((l) => !mailed.has(`${l.notice_id}|${l.attempt_no}`) && (byKey.has(`${l.notice_id}|${l.attempt_no}`) || !flaggedBefore.has(foreignKey(l))));
  if (!fresh.length) throw new DocumentsRefused("NO_PROOF_OF_MAILING_YET", "35.2 rule 9 / SM_MAIL_MANIFEST_2BD: the vendor's file names no piece of this manifest that is not already mailed — nothing is ingested, the clock keeps running", `manifest ${outbound.id}: ${lines.length} line(s), none new`);
  const matched: (PieceLine & { imb: string | null; mailed_on: string; mailed_at: string | null })[] = []; const unmatched: { notice_id: string; attempt_no: number }[] = [];
  type InboundLine = PieceLine & { imb: string | null; mailed_on: string; mailed_at: string | null; known: boolean };
  const inboundLines: InboundLine[] = [];
  for (const l of fresh) {
    const p = byKey.get(`${l.notice_id}|${l.attempt_no}`);
    if (!p) { unmatched.push({ notice_id: l.notice_id, attempt_no: l.attempt_no }); inboundLines.push({ piece_id: randomUUID(), notice_id: l.notice_id, attempt_no: l.attempt_no, document_id: "", sha256: "", page_count: 0, sheets: 0, mail_class: "", separate_envelope: false, address: { name: "", address: "" }, vendor_piece_id: l.vendor_piece_id, imb: l.imb, mailed_on: l.mailed_on, mailed_at: l.mailed_at, known: false }); continue; }
    const line: InboundLine = { piece_id: randomUUID(), notice_id: p.notice_id!, attempt_no: Number(p.attempt_no), document_id: p.document_id!, sha256: p.sha256 ?? "", page_count: p.page_count ?? 0, sheets: p.sheets ?? 0, mail_class: p.mail_class ?? "first_class", separate_envelope: p.separate_envelope ?? false, address: { name: p.address_snapshot?.name ?? "", address: p.address_snapshot?.address ?? "" }, vendor_piece_id: l.vendor_piece_id ?? p.vendor_piece_id, imb: l.imb, mailed_on: l.mailed_on, mailed_at: l.mailed_at, known: true };
    matched.push(line); inboundLines.push(line);
  }
  const nowMailed = new Set([...mailed, ...matched.map((m) => `${m.notice_id}|${m.attempt_no}`)]);
  const unmailed = pieces.filter((p) => !nowMailed.has(`${p.notice_id}|${p.attempt_no}`)).map((p) => ({ notice_id: p.notice_id!, attempt_no: Number(p.attempt_no) }));
  const reconciled = unmailed.length === 0 && unmatched.length === 0;
  const inboundId = randomUUID();
  const file = manifestNdjson({ inbound_manifest_id: inboundId, outbound_manifest_id: outbound.id, batch_id: outbound.notice_batch_id, vendor: outbound.vendor, source: i.source, received_at: deps.now, piece_count: fresh.length, matched: matched.length, unmatched: unmatched.length, already_mailed: lines.length - fresh.length, reconciled }, inboundLines.map((l) => ({ ...l, notice_id: l.known ? l.notice_id : "", document_id: l.known ? l.document_id : "" })));
  const fileName = `proof-of-mailing-${outbound.notice_batch_id ?? outbound.id}-${inboundId.slice(0, 8)}.ndjson`;
  const stored = await storeDocument(deps, { kind: MANIFEST_KIND, bytes: file, mime_type: MANIFEST_MIME, retention_class: "corporate_7y", metadata: { title: "Inbound proof-of-mailing manifest", batch_id: outbound.notice_batch_id, outbound_manifest_id: outbound.id, source: i.source, piece_count: fresh.length, file_name: fileName } });
  await insertManifest(q, { id: inboundId, notice_batch_id: outbound.notice_batch_id, direction: "inbound", vendor: outbound.vendor, file_name: fileName, sha256: stored.sha256, piece_count: fresh.length, sheet_count: null, submitted_at: null, received_at: deps.now, document_id: stored.document_id, reconciled, status: "received" });
  // the inbound pieces: a matched line copies the outbound piece's facts; a line the outbound did not name is written with notice_id = null and nothing else invented
  for (const l of inboundLines) await q.query(`INSERT INTO mail_manifest_pieces (id, manifest_id, notice_id, attempt_no, document_id, sha256, page_count, sheets, mail_class, separate_envelope, address_snapshot, vendor_piece_id, imb, mailed_on) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14::date)`,
    [l.piece_id, inboundId, l.known ? l.notice_id : null, l.attempt_no, l.known ? l.document_id : null, l.known ? l.sha256 : null, l.known ? l.page_count : null, l.known ? l.sheets : null, l.known ? l.mail_class : null, l.known ? l.separate_envelope : null, l.known ? toJson(l.address) : null, l.vendor_piece_id, l.imb, l.mailed_on]);
  for (const m of matched) {
    await q.query(`UPDATE notice_deliveries SET mailed_at = coalesce(mailed_at, $3::timestamptz), imb = coalesce($4, imb), mail_manifest_id = $5 WHERE notice_id = $1 AND attempt_no = $2`, [m.notice_id, m.attempt_no, m.mailed_at ?? `${m.mailed_on}T12:00:00.000Z`, m.imb, outbound.id]);
    deps.events.append({ type: "mail.piece.mailed", ...batchKey(outbound.notice_batch_id ?? outbound.id), actor: deps.actor, payload: { notice_id: m.notice_id, attempt_no: m.attempt_no, imb: m.imb, mailed_on: m.mailed_on, manifest_id: outbound.id, inbound_manifest_id: inboundId, vendor: outbound.vendor } });
  }
  const escalationIds: string[] = [];
  if (deps.escalations && unmatched.length) escalationIds.push(deps.escalations.open({ kind: "sev3", ownerRole: "ops_analyst", severity: "3", payload: { kind: "manifest_unmatched_pieces", manifest_id: outbound.id, inbound_manifest_id: inboundId, batch_id: outbound.notice_batch_id, unmatched, rule: "35.2 edge case: a vendor manifest names a piece the outbound manifest does not — the inbound row is written with notice_id = null; nothing on notice_deliveries changes" } }, deps.actor).id);
  if (deps.escalations && unmailed.length) escalationIds.push(deps.escalations.open({ kind: "sev3", ownerRole: "ops_analyst", severity: "3", payload: { kind: "manifest_unmailed_pieces", manifest_id: outbound.id, inbound_manifest_id: inboundId, batch_id: outbound.notice_batch_id, unmailed, rule: "35.2 rule 9: an ops_analyst escalation naming every piece the vendor did not mail" } }, deps.actor).id);
  // the clock's satisfier: proof of mailing for at least one piece of this manifest (a file naming only foreign pieces satisfies nothing)
  if (matched.length) deps.events.append({ type: "mail.manifest.ingested", ...batchKey(outbound.notice_batch_id ?? outbound.id), actor: deps.actor, payload: { manifest_id: outbound.id, inbound_manifest_id: inboundId, batch_id: outbound.notice_batch_id, vendor: outbound.vendor, source: i.source, piece_count: fresh.length, matched: matched.length, unmatched: unmatched.length, unmailed: unmailed.length, reconciled, received_at: deps.now, document_id: stored.document_id } });
  return { manifest_id: outbound.id, inbound_manifest_id: inboundId, batch_id: outbound.notice_batch_id, piece_count: fresh.length, matched: matched.length, unmatched, unmailed, reconciled, escalation_ids: escalationIds };
}

// ───────── mail.fallback ─────────
export interface FallbackResult { readonly batch_id: string; readonly manifest_id: string; readonly document_id: string; readonly piece_count: number; readonly merged: readonly { mail_class: string; document_id: string; sha256: string; page_count: number; pieces: number }[]; readonly merged_document_ids: readonly string[]; readonly escalation_id: string | null; readonly submitted_at: string; }
/** The cover sheet of a piece: who it goes to, what it is — the page the in-house printer stuffs first. */
function coverOps(p: PieceRow, k: number, n: number, batchId: string): readonly TextOp[] {
  return pageFromBlocks([
    { id: "cover", page: 1, yFraction: 0.05, pt: 14, bold: true, text: `In-house mail — piece ${k} of ${n} — ${p.mail_class ?? "first_class"}${p.separate_envelope ? " — separate envelope" : ""}` },
    { id: "cover_address", page: 1, yFraction: 0.14, pt: 12, bold: false, text: `${p.address_snapshot?.name ?? ""}\n${p.address_snapshot?.address ?? ""}` },
    { id: "cover_piece", page: 1, yFraction: 0.3, pt: 9, bold: false, text: `Batch ${batchId} · notice ${p.notice_id ?? ""} attempt ${p.attempt_no ?? ""} · document ${p.document_id ?? ""} · sha256 ${p.sha256 ?? ""} · ${p.page_count ?? 0} page(s), ${p.sheets ?? 0} sheet(s)` },
  ]);
}
export async function mailFallback(deps: DocsDeps, i: { batch_id: string }): Promise<FallbackResult> {
  const q = deps.q;
  if (!isUuid(i.batch_id)) throw new RangeError("batch_id is a uuid (the notice_batches row mail.batch wrote)");
  const outbound = (await q.query<ManifestRow>(`SELECT id, notice_batch_id, direction, vendor, file_name, sha256, piece_count, sheet_count, submitted_at, received_at, document_id, reconciled, status, created_at FROM mail_manifests WHERE notice_batch_id = $1 AND direction = 'outbound' AND vendor <> 'in_house' ORDER BY created_at DESC LIMIT 1`, [i.batch_id]))[0];
  if (!outbound) throw new RangeError(`batch ${i.batch_id} has no outbound vendor manifest`);
  if ((await q.query(`SELECT 1 FROM mail_manifests WHERE notice_batch_id = $1 AND vendor = 'in_house' LIMIT 1`, [i.batch_id])).length) throw new DocumentsRefused("FALLBACK_ALREADY_BUILT", "35.2 rule 10: one in-house manifest per batch", `batch ${i.batch_id} already has its in-house manifest`);
  const all = await manifestPieces(q, outbound.id);
  if (!all.length) throw new RangeError(`manifest ${outbound.id} has no pieces`);
  const mailedKeys = new Set((await q.query<{ notice_id: string; attempt_no: number }>(`SELECT notice_id, attempt_no FROM notice_deliveries WHERE mailed_at IS NOT NULL AND notice_id = ANY($1::uuid[])`, [[...new Set(all.map((p) => p.notice_id!))]])).map((d) => `${d.notice_id}|${d.attempt_no}`));
  const pieces = all.filter((p) => !mailedKeys.has(`${p.notice_id}|${p.attempt_no}`));   // a piece the vendor mailed is never printed again
  if (!pieces.length) throw new DocumentsRefused("BATCH_ALREADY_MAILED", "35.2 rule 10: the fallback is for the pieces the vendor did not mail", `batch ${i.batch_id}: every piece has its proof of mailing`);
  const manifestId = randomUUID();
  const byClass = new Map<string, PieceRow[]>();
  for (const p of pieces) { const c = p.mail_class ?? "first_class"; byClass.set(c, [...(byClass.get(c) ?? []), p]); }
  const merged: { mail_class: string; document_id: string; sha256: string; page_count: number; pieces: number }[] = [];
  for (const [cls, group] of byClass) {
    const parts: { doc: Buffer; cover: readonly TextOp[] }[] = [];
    for (const [k, p] of group.entries()) {
      const row = await requireDocument(q, p.document_id!);
      const got = await documentBytes(q, deps.blobs, row);
      if (!got) throw new DocumentsRefused("DOCUMENT_CONTENT_UNAVAILABLE", "35.2 rule 10: the merged PDF needs every piece's bytes", `piece ${p.id}: document ${p.document_id} has no readable bytes`);
      if (sha256Hex(got.bytes) !== row.sha256) throw new DocumentsRefused("INTEGRITY_FAILED", "35.2 rule 7: a piece whose bytes do not match its hash is never printed", `document ${p.document_id}`);
      parts.push({ doc: got.bytes, cover: coverOps(p, k + 1, group.length, i.batch_id) });
    }
    const pdf = mergePdfs(parts, { title: `In-house mail ${cls} — batch ${i.batch_id}`, creationDate: deps.now, idSeed: `mail-merged:${i.batch_id}:${cls}` });
    const stored = await storeDocument(deps, { kind: MERGED_KIND, bytes: pdf.bytes, mime_type: "application/pdf", retention_class: "corporate_7y", page_count: pdf.page_count, text_layer: true, locale: "en", metadata: { title: `In-house mail (${cls})`, batch_id: i.batch_id, manifest_id: manifestId, mail_class: cls, piece_ids: group.map((p) => p.id) } });
    merged.push({ mail_class: cls, document_id: stored.document_id, sha256: stored.sha256, page_count: pdf.page_count, pieces: group.length });
  }
  const lines: PieceLine[] = pieces.map((p) => ({ piece_id: randomUUID(), notice_id: p.notice_id!, attempt_no: Number(p.attempt_no), document_id: p.document_id!, sha256: p.sha256 ?? "", page_count: p.page_count ?? 0, sheets: p.sheets ?? 0, mail_class: p.mail_class ?? "first_class", separate_envelope: p.separate_envelope ?? false, address: { name: p.address_snapshot?.name ?? "", address: p.address_snapshot?.address ?? "" }, vendor_piece_id: null }));
  const sheetCount = lines.reduce((n, p) => n + p.sheets, 0);
  const file = manifestNdjson({ manifest_id: manifestId, batch_id: i.batch_id, vendor: "in_house", submitted_at: deps.now, piece_count: lines.length, sheet_count: sheetCount, merged_document_ids: merged.map((m) => m.document_id), merged: merged }, lines);
  const fileName = `manifest-${i.batch_id}-in-house.ndjson`;
  const stored = await storeDocument(deps, { kind: MANIFEST_KIND, bytes: file, mime_type: MANIFEST_MIME, retention_class: "corporate_7y", metadata: { title: "In-house mail manifest", batch_id: i.batch_id, manifest_id: manifestId, vendor: "in_house", piece_count: lines.length, merged_document_ids: merged.map((m) => m.document_id), file_name: fileName } });
  await insertManifest(q, { id: manifestId, notice_batch_id: i.batch_id, direction: "outbound", vendor: "in_house", file_name: fileName, sha256: stored.sha256, piece_count: lines.length, sheet_count: sheetCount, submitted_at: deps.now, received_at: null, document_id: stored.document_id, reconciled: null, status: "in_house" });
  await insertPieces(q, manifestId, lines);
  const escalationId = deps.escalations ? deps.escalations.open({ kind: "sev3", ownerRole: "ops_analyst", severity: "3", payload: { kind: "in_house_print", batch_id: i.batch_id, manifest_id: manifestId, merged_document_ids: merged.map((m) => m.document_id), piece_count: lines.length, rule: "35.2 rule 10: print and post the merged PDF per mail class; the inbound manifest is the analyst's mail.manifest.ingest with mailed_on per piece" } }, deps.actor).id : null;
  deps.events.append({ type: "mail.batch.submitted", ...batchKey(i.batch_id), actor: deps.actor, payload: { batch_id: i.batch_id, manifest_id: manifestId, vendor: "in_house", piece_count: lines.length, sheet_count: sheetCount, submitted_at: deps.now, document_id: stored.document_id, file_sha256: stored.sha256, merged_document_ids: merged.map((m) => m.document_id), fallback_of: outbound.id } });
  return { batch_id: i.batch_id, manifest_id: manifestId, document_id: stored.document_id, piece_count: lines.length, merged, merged_document_ids: merged.map((m) => m.document_id), escalation_id: escalationId, submitted_at: deps.now };
}
