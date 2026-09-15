// 35.2 Documents and artifacts: the object store, the PDF writer, stored-byte integrity, legal holds, e-sign envelopes, the borrower viewer and print/mail manifests
// spec/sections/35-operations-runtime/35-2-documents-and-artifacts.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { connect, type Db, type Queryable } from "../../infra/db/client.ts";
import { testDatabase } from "../../infra/db/test-db.ts";
import { PgLoanRepository, type Fixture } from "../../infra/db/loans.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock, type Actor } from "../../kernel/events/index.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { Runtime, fakePorts, type ExecuteResponse } from "../../runtime/app.ts";
import { CommandRefused } from "../../app/commands.ts";
import type { ToolInput } from "../../app/tools.ts";
import { PgFakeBlobStore } from "../../infra/blobs/pg-fake-blob-store.ts";
import type { FakePrintMail } from "../../infra/integrations/delivery.ts";

// ───────── the harness: this file's own database, one runtime over it, the FAKE object store (document_blobs), the FAKE ports
const { url: DB_URL, skip } = await testDatabase(import.meta.url);
const T0 = "2026-09-17T05:00:00.000Z";                                   // worked example A's clock (01:00 EDT, Sept 17)
const clock = new FixedClock(T0);
const RECORDS: Actor = { kind: "agent", id: "security-records" };
const COMPLIANCE: Actor = { kind: "human", id: "u-comp-1", role: "compliance" };
const OFFICER: Actor = { kind: "human", id: "u-off-1", role: "officer" };
const ANALYST: Actor = { kind: "human", id: "u-ops-1", role: "ops_analyst" };
let db: Db; let runtime: Runtime; let blobs: PgFakeBlobStore; let printMail: FakePrintMail | undefined;
let n = 0;
const uniq = (): string => `${Date.now() % 1_000_000}${(n++).toString().padStart(3, "0")}`.padStart(10, "0");
const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
const one = async <R extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R> => { const r = (await db.query<R>(sql, params))[0]; if (!r) throw new Error(`no row: ${sql}`); return r; };
const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await db.query<{ c: string }>(`SELECT count(*)::text AS c ${sql}`, params))[0]!.c);
/** A 35.2 tool through the bus on the runtime: {} = a global command, {loanId} / {applicationId} = the subject's (its clocks are hydrated there). */
const run = (name: string, input: ToolInput, actor: Actor = RECORDS, scope: { loanId?: string; applicationId?: string } = {}): Promise<ExecuteResponse> =>
  runtime.execute({ process: "35.2", name, loanId: scope.loanId ?? "", ...(scope.applicationId ? { applicationId: scope.applicationId } : {}), actor, input });
const refused = (p: Promise<unknown>, code: string): Promise<void> => assert.rejects(p, (e: unknown) => { assert.ok(e instanceof CommandRefused, `expected CommandRefused ${code}, got ${(e as Error).message}`); assert.equal(e.code, code, e.message); return true; });
const rejectsSql = (p: Promise<unknown>, re: RegExp): Promise<void> => assert.rejects(p, (e: unknown) => { assert.match((e as Error).message, re); return true; });
async function loanFixture(): Promise<Fixture> {
  return new PgLoanRepository(db).createFixture({ fnmaLoanNumber: uniq(), servicerLoanNumber: `SM-${randomUUID()}`, instrumentDate: D("2021-07-15"), originalUpbCents: 40_000_000n, originalTermMonths: 360, firstPaymentDate: D("2026-10-01"), maturityDate: D("2056-09-01") });
}
/** A small but real PDF-shaped artifact for the store tests (the writer's own PDFs are T1's subject). */
const PDF_BYTES = (tag: string): Buffer => Buffer.from(`%PDF-1.4\n% 35.2 fixture ${tag}\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`, "latin1");
const storeInput = (tag: string, extra: Record<string, unknown> = {}): ToolInput => ({ kind: "upload", bytes_base64: PDF_BYTES(tag).toString("base64"), mime_type: "application/pdf", retention_class: "life_of_loan_plus_4y", metadata: { filename: `${tag}.pdf` }, ...extra });

test.before(async () => {
  if (skip) return;
  db = connect(DB_URL);
  blobs = new PgFakeBlobStore(db);
  const ports = fakePorts(); printMail = ports.printMail as FakePrintMail;
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock, ports, blobs });
});
test.after(async () => { if (!skip) await db.end(); });
void ANALYST;

test("35.2-T1: Given the `NTC_REGZ_41_STMT_STD` template at its counsel-approved version and worked example A's payload, when `documents.render` runs twice with the clock at 2026-09-17T05:00:00Z, then the two PDFs are byte-identical with one `sha256`, the file begins `%PDF-1.4`, every page's content stream carries a text layer from which the rendered `text` is recovered in reading order, and changing one payload field (the late charge) changes the hash.", { todo: true });
test("35.2-T2: Given worked example A rendered through the command path, then a `documents` row exists with `mime_type = application/pdf`, `kind = rendered_notice`, `sha256` and `byte_size` equal to the bytes, `page_count ≥ 1`, `retention_class = life_of_loan_plus_4y`, `payload_hash` equal to the canonical payload hash, `notices.document_id` equals that row, exactly one `notice_checklist_results` row exists for the notice across render-then-send, and the text layer contains `$2,334.29`, `$612.50`, `$2,946.79`, `$116.71` and `$6,010.29` each exactly once in the amount-due box.", { todo: true });
test("35.2-T3: Given 10.4's annual PMI disclosure for an MN property, when it renders, then the writer's placements report every body block at ≥ 12 pt and page 1, 10.4's checklist passes from those placements alone (no browser is started), and given the same template with a 10 pt body the checklist fails `layout` and the notice is `held`.", { todo: true });
test("35.2-T4: Given the FAKE blob store in outage, when `documents.store` runs, then the `documents` row is written with `storage_uri = worm_pending:<id>` and `storage_status = staged`, a `document_blobs` row holds the bytes, `document.staged` is logged and `SM_DOC_WORM_DRAIN_1D` is armed; when the outage clears and the drain runs, then `storage_uri` becomes `fake-blob://<id>#1`, `storage_status = stored`, `stored_generation = 1`, `document.stored` satisfies the clock; a second attempt to change `storage_uri` is refused by the trigger (`URI_SWAP_ONCE`) and a store whose re-read hash differs never swaps.", { skip }, async () => {
  const f = await loanFixture();
  // the object store is down: the row is staged with its bytes beside it, the clock arms
  blobs.outage = true;
  const r = await run("documents.store", storeInput("t4-a"), RECORDS, { loanId: f.loanId });
  const out = r.output as { document_id: string; sha256: string; storage_status: string };
  const id = out.document_id;
  const row = await one<{ storage_uri: string; storage_status: string; sha256: string; byte_size: bigint; stored_generation: string | null }>(`SELECT storage_uri, storage_status, sha256, byte_size, stored_generation FROM documents WHERE id = $1`, [id]);
  assert.equal(row.storage_uri, `worm_pending:${id}`); assert.equal(row.storage_status, "staged"); assert.equal(row.stored_generation, null);
  assert.equal(row.sha256, sha256(PDF_BYTES("t4-a"))); assert.equal(Number(row.byte_size), PDF_BYTES("t4-a").length);
  const blob = await one<{ content: Buffer; staged_at: string; drained_at: string | null }>(`SELECT content, staged_at, drained_at FROM document_blobs WHERE document_id = $1`, [id]);
  assert.ok(Buffer.from(blob.content).equals(PDF_BYTES("t4-a")), "document_blobs holds the bytes"); assert.equal(blob.staged_at, T0); assert.equal(blob.drained_at, null);
  const staged = r.events.find((e) => e.type === "document.staged"); assert.ok(staged, "document.staged is logged");
  assert.equal(staged.payload["document_id"], id); assert.equal(staged.payload["staged_at"], T0); assert.equal(staged.loanId, f.loanId);
  assert.ok(!r.events.some((e) => e.type === "document.stored"), "nothing stored while the store is down");
  const t = r.timers.find((x) => x.code === "SM_DOC_WORM_DRAIN_1D"); assert.ok(t, "SM_DOC_WORM_DRAIN_1D is armed");
  assert.equal(t.status, "armed"); assert.deepEqual(t.subject, { kind: "loan", id: f.loanId }); assert.equal(t.anchorDate, "2026-09-17"); assert.equal(t.dueDate, "2026-09-18");
  // the outage clears and the drain runs: put, re-read, compare, the one swap, document.stored satisfies the clock
  blobs.outage = false;
  const r2 = await run("documents.store", { op: "drain" }, RECORDS, { loanId: f.loanId });
  const drained = r2.output as { drained: number; failed: number };
  assert.equal(drained.drained, 1); assert.equal(drained.failed, 0);
  const row2 = await one<{ storage_uri: string; storage_status: string; stored_generation: string | null; sha256: string }>(`SELECT storage_uri, storage_status, stored_generation, sha256 FROM documents WHERE id = $1`, [id]);
  assert.equal(row2.storage_uri, `fake-blob://${id}#1`); assert.equal(row2.storage_status, "stored"); assert.equal(row2.stored_generation, "1"); assert.equal(row2.sha256, row.sha256, "the hash is the bytes: unchanged by the swap");
  const blob2 = await one<{ drained_at: string | null; drain_generation: string | null }>(`SELECT drained_at, drain_generation FROM document_blobs WHERE document_id = $1`, [id]);
  assert.equal(blob2.drained_at, T0); assert.equal(blob2.drain_generation, "1");
  const stored = r2.events.find((e) => e.type === "document.stored"); assert.ok(stored, "document.stored is logged by the drain");
  assert.equal(stored.payload["document_id"], id); assert.equal(stored.payload["storage_uri"], `fake-blob://${id}#1`); assert.equal(stored.payload["stored_generation"], "1");
  assert.ok(blobs.log.some((l) => l.op === "put" && l.document_id === id) && blobs.log.some((l) => l.op === "get" && l.document_id === id), "the drain put the object and re-read it");
  const timer = await one<{ status: string }>(`SELECT status FROM timers WHERE id = $1`, [t.id]); assert.equal(timer.status, "satisfied");
  // a second attempt to change storage_uri is refused by the trigger
  await rejectsSql(db.query(`UPDATE documents SET storage_uri = $2, stored_generation = '2' WHERE id = $1`, [id, `fake-blob://${id}#2`]), /URI_SWAP_ONCE/);
  await rejectsSql(db.query(`UPDATE documents SET storage_uri = $2 WHERE id = $1`, [id, `worm_pending:${id}`]), /URI_SWAP_ONCE/);
  // a store whose re-read hash differs never swaps: the attempt is counted, the staged copy stays the served copy
  blobs.outage = true;
  const id2 = ((await run("documents.store", storeInput("t4-b"), RECORDS, { loanId: f.loanId })).output as { document_id: string }).document_id;
  blobs.outage = false; blobs.corruptOnPut(id2);
  const r3 = await run("documents.store", { op: "drain" }, RECORDS, { loanId: f.loanId });
  assert.equal((r3.output as { failed: number }).failed, 1);
  const row3 = await one<{ storage_uri: string; storage_status: string; stored_generation: string | null }>(`SELECT storage_uri, storage_status, stored_generation FROM documents WHERE id = $1`, [id2]);
  assert.equal(row3.storage_status, "staged"); assert.equal(row3.storage_uri, `worm_pending:${id2}`); assert.equal(row3.stored_generation, null);
  const blob3 = await one<{ drain_attempts: number; last_drain_error: string | null; drained_at: string | null }>(`SELECT drain_attempts, last_drain_error, drained_at FROM document_blobs WHERE document_id = $1`, [id2]);
  assert.equal(blob3.drain_attempts, 1); assert.equal(blob3.last_drain_error, "HASH_MISMATCH_ON_PUT"); assert.equal(blob3.drained_at, null);
  assert.ok(r3.events.some((e) => e.type === "document.drain.failed" && e.payload["document_id"] === id2 && e.payload["attempts"] === 1), "the failed attempt is logged");
  assert.ok(!r3.events.some((e) => e.type === "document.stored" && e.payload["document_id"] === id2), "no document.stored for the row whose re-read differed");
  // the next drain retries under a new generation and stores it
  const r4 = await run("documents.store", { op: "drain" }, RECORDS, { loanId: f.loanId });
  assert.equal((r4.output as { drained: number }).drained, 1);
  assert.equal((await one<{ storage_uri: string }>(`SELECT storage_uri FROM documents WHERE id = $1`, [id2])).storage_uri, `fake-blob://${id2}#2`, "retries with a new object name");
});
test("35.2-T5: Given a stored `documents` row, then a raw `UPDATE` of `sha256`, `byte_size`, `kind`, `mime_type`, `retention_class` or `created_at` is refused by `documents_column_restricted`, a `DELETE` is refused, an `UPDATE` of `legal_hold` without `sm.document_hold` set to the row id is refused, and the migration adding the trigger leaves every §1–34 test that inserts `documents` rows green.", { skip }, async () => {
  const f = await loanFixture();
  const id = ((await run("documents.store", storeInput("t5"), RECORDS, { loanId: f.loanId })).output as { document_id: string }).document_id;
  assert.equal((await one<{ storage_status: string }>(`SELECT storage_status FROM documents WHERE id = $1`, [id])).storage_status, "stored");
  // the write-once columns
  for (const set of [`sha256 = repeat('0', 64)`, `byte_size = 1`, `kind = 'something_else'`, `mime_type = 'text/plain'`, `retention_class = 'corporate_7y'`, `created_at = now()`, `metadata = '{"x":1}'::jsonb`, `doc_class = 'paystub'`, `payload_hash = repeat('a', 64)`])
    await rejectsSql(db.query(`UPDATE documents SET ${set} WHERE id = $1`, [id]), /documents_column_restricted/);
  await rejectsSql(db.query(`DELETE FROM documents WHERE id = $1`, [id]), /documents_column_restricted/);
  // legal_hold only under the command's setting, and only with the hold log's row
  await rejectsSql(db.query(`UPDATE documents SET legal_hold = true WHERE id = $1`, [id]), /documents_column_restricted: legal_hold changes only inside documents.hold/);
  await rejectsSql(db.tx(async (q) => { await q.query(`SELECT set_config('sm.document_hold', $1, true)`, [id]); await q.query(`UPDATE documents SET legal_hold = true WHERE id = $1`, [id]); }), /needs an open document_holds\{placed\} row/);
  await db.tx(async (q) => {
    await q.query(`SELECT set_config('sm.document_hold', $1, true)`, [id]);
    await q.query(`INSERT INTO document_holds (document_id, action, reason, matter_ref, actor_kind, actor_id) VALUES ($1, 'placed', 't5', 'M-T5', 'agent', 'security-records')`, [id]);
    await q.query(`UPDATE documents SET legal_hold = true WHERE id = $1`, [id]);
  });
  assert.equal((await one<{ legal_hold: boolean }>(`SELECT legal_hold FROM documents WHERE id = $1`, [id])).legal_hold, true);
  await rejectsSql(db.tx(async (q) => { await q.query(`SELECT set_config('sm.document_hold', $1, true)`, [id]); await q.query(`UPDATE documents SET legal_hold = false WHERE id = $1`, [id]); }), /needs a human document_holds\{released\} row/);
  // the integrity and disposal columns are the unit's and the run's
  await rejectsSql(db.query(`UPDATE documents SET verify_status = 'verified', last_verified_at = now() WHERE id = $1`, [id]), /sm.integrity_run/);
  await rejectsSql(db.query(`UPDATE documents SET storage_status = 'disposed', disposed_at = now(), disposal_run_id = $2 WHERE id = $1`, [id, randomUUID()]), /disposal only by the attested 19.1 run/);
  // the migration leaves every §1–34 INSERT site green: the shapes of src/runtime/book-ops/report.ts, src/runtime/controls/evidence.ts, src/app/tools/section32-2.ts, section20-3.ts and src/domain/underwriting/du/persist.ts, verbatim in their columns
  const app = await runtime.createApplication({ partner_party_id: f.partnerPartyId, channel: "organic", transaction_type: "limited_cash_out", occupancy: "primary", borrowers: [{ legal_name: "Tee Five" }] }, { kind: "system", id: "test" });
  const shapes: [string, unknown[]][] = [
    [`INSERT INTO documents (id, kind, sha256, byte_size, storage_uri, mime_type, retention_class, metadata, created_at) VALUES ($1, 'partner_book_daily_report', $2, 12, 'report://x', 'application/json', 'corporate_7y', '{}', now())`, [randomUUID(), sha256("a")]],
    [`INSERT INTO documents (id, loan_id, application_id, kind, sha256, byte_size, storage_uri, mime_type, retention_class, metadata, created_at) VALUES ($1, $2, NULL, 'evidence_pack', $3, 12, 'evidence://packs/x', 'application/json', 'corporate_7y', '{}', now())`, [randomUUID(), f.loanId, sha256("b")]],
    [`INSERT INTO documents (id, kind, sha256, byte_size, storage_uri, mime_type, application_id, doc_class, source_channel, sender_identity, received_at, subject_borrower_id, page_count, metadata) VALUES ($1, 'origination_document', $2, 3, 'fake-blob://x', 'application/pdf', $3, NULL, 'borrower_upload', '{}', now(), NULL, 0, '{}')`, [randomUUID(), sha256("c"), app.application.id]],
    [`INSERT INTO documents (id, kind, sha256, byte_size, storage_uri, mime_type, application_id, retention_class, metadata) VALUES ($1, 'rendered_notice', $2, 3, 'store://documents/x', 'text/html', $3, 'regb_25m', '{}')`, [randomUUID(), sha256("d"), app.application.id]],
    [`INSERT INTO documents (id, kind, sha256, byte_size, storage_uri, mime_type, application_id, retention_class, metadata) VALUES ($1, 'du_request', $2, 3, 'du://x', 'application/xml', $3, 'fnma_loan_file_life_plus_4y', '{}')`, [randomUUID(), sha256("e"), app.application.id]],
  ];
  for (const [sql, params] of shapes) {
    await db.query(sql, params);
    const inserted = await one<{ storage_status: string; verify_status: string }>(`SELECT storage_status, verify_status FROM documents WHERE id = $1`, [params[0]]);
    assert.equal(inserted.storage_status, "staged"); assert.equal(inserted.verify_status, "unverified");
  }
});
test("35.2-T6: Given `documents.hold{place}` by the agent with a `matter_ref`, then `legal_hold = true`, a `document_holds{placed}` row and the FAKE store's hold reference exist and `document.hold.placed` is logged; `documents.dispose` on it is refused `HOLD_ACTIVE`; `documents.hold{release}` by the agent is refused `HOLD_RELEASE_HUMAN_ONLY`; by a human `compliance` actor with a reason it writes the `released` row before the flag clears and `document.hold.released` is logged.", { skip }, async () => {
  const f = await loanFixture();
  const id = ((await run("documents.store", storeInput("t6"), RECORDS, { loanId: f.loanId })).output as { document_id: string }).document_id;
  // the agent places a hold with a matter reference
  const placed = await run("documents.hold", { op: "place", document_id: id, reason: "subpoena", matter_ref: "MATTER-1" }, RECORDS, { loanId: f.loanId });
  assert.equal((await one<{ legal_hold: boolean }>(`SELECT legal_hold FROM documents WHERE id = $1`, [id])).legal_hold, true);
  const hold = await one<{ action: string; matter_ref: string; actor_kind: string; actor_id: string; blob_hold_ref: string | null; reason: string }>(`SELECT action, matter_ref, actor_kind, actor_id, blob_hold_ref, reason FROM document_holds WHERE document_id = $1 ORDER BY seq`, [id]);
  assert.equal(hold.action, "placed"); assert.equal(hold.matter_ref, "MATTER-1"); assert.equal(hold.actor_kind, "agent"); assert.equal(hold.actor_id, "security-records"); assert.equal(hold.reason, "subpoena");
  assert.match(hold.blob_hold_ref ?? "", /^FAKE:hold:\d+$/, "the FAKE store's hold reference"); assert.equal(blobs.heldObjects().get(id), hold.blob_hold_ref, "the object store honours the hold");
  const ev = placed.events.find((e) => e.type === "document.hold.placed"); assert.ok(ev, "document.hold.placed is logged");
  assert.equal(ev.payload["document_id"], id); assert.equal(ev.payload["reason"], "subpoena"); assert.equal(ev.payload["matter_ref"], "MATTER-1"); assert.equal(ev.payload["by"], "agent:security-records");
  // a held document is never disposed
  await refused(run("documents.dispose", { document_id: id, disposal_run_id: randomUUID() }, OFFICER, { loanId: f.loanId }), "HOLD_ACTIVE");
  // the agent may never release; a human compliance actor with a reason may
  await refused(run("documents.hold", { op: "release", document_id: id, reason: "done" }, RECORDS, { loanId: f.loanId }), "HOLD_RELEASE_HUMAN_ONLY");
  assert.equal((await one<{ legal_hold: boolean }>(`SELECT legal_hold FROM documents WHERE id = $1`, [id])).legal_hold, true, "the refusal wrote nothing");
  const released = await run("documents.hold", { op: "release", document_id: id, reason: "matter closed" }, COMPLIANCE, { loanId: f.loanId });
  assert.equal((await one<{ legal_hold: boolean }>(`SELECT legal_hold FROM documents WHERE id = $1`, [id])).legal_hold, false);
  const rows = await db.query<{ action: string; actor_kind: string; actor_role: string | null; reason: string }>(`SELECT action, actor_kind, actor_role, reason FROM document_holds WHERE document_id = $1 ORDER BY seq`, [id]);
  assert.deepEqual(rows.map((r) => [r.action, r.actor_kind, r.actor_role]), [["placed", "agent", null], ["released", "human", "compliance"]]); assert.equal(rows[1]!.reason, "matter closed");
  assert.equal(blobs.heldObjects().has(id), false, "the object store's hold is lifted");
  const rel = released.events.find((e) => e.type === "document.hold.released"); assert.ok(rel, "document.hold.released is logged");
  assert.equal(rel.payload["document_id"], id); assert.equal(rel.payload["reason"], "matter closed"); assert.equal(rel.payload["by"], "human:u-comp-1(compliance)");
  // the released row is written before the flag clears: with the hold placed again, a flip without a released row is refused by the trigger even under the command's setting
  await run("documents.hold", { op: "place", document_id: id, reason: "litigation", matter_ref: "MATTER-2" }, RECORDS, { loanId: f.loanId });
  await rejectsSql(db.tx(async (q) => { await q.query(`SELECT set_config('sm.document_hold', $1, true)`, [id]); await q.query(`UPDATE documents SET legal_hold = false WHERE id = $1`, [id]); }), /needs a human document_holds\{released\} row/);
  // a release for a document under a second, open matter is refused naming the other matter
  await run("documents.hold", { op: "place", document_id: id, reason: "subpoena", matter_ref: "MATTER-3" }, RECORDS, { loanId: f.loanId });
  await refused(run("documents.hold", { op: "release", document_id: id, reason: "one down" }, COMPLIANCE, { loanId: f.loanId }), "HOLD_STILL_REQUIRED");
  const partial = await run("documents.hold", { op: "release", document_id: id, reason: "one down", matter_ref: "MATTER-2" }, COMPLIANCE, { loanId: f.loanId });
  assert.deepEqual((partial.output as { open_matters: string[]; legal_hold: boolean }).open_matters, ["MATTER-3"]); assert.equal((partial.output as { legal_hold: boolean }).legal_hold, true);
  assert.equal((await one<{ legal_hold: boolean }>(`SELECT legal_hold FROM documents WHERE id = $1`, [id])).legal_hold, true, "still held for MATTER-3");
});
test("35.2-T7: Given three notices of one batch decided `mail`, when `mail.batch` runs, then one outbound `mail_manifests` row with `piece_count = 3` and a hashed manifest document exists, each `mail_manifest_pieces` row carries the piece's `document_id`, `sha256`, `page_count`, `sheets = ceil(page_count ÷ 2)`, mail class and address snapshot, one `integration_messages` row addresses the `print-mail` adapter with the batch id as idempotency key, and `SM_MAIL_MANIFEST_2BD` is armed; when the FAKE vendor's proof-of-mailing manifest is ingested, then `notice_deliveries.mailed_at`, `imb` and `mail_manifest_id` are set for all three (and `manifest_id` is the `notice_batches` id, 0009's FK), the inbound manifest is `reconciled`, `mail.manifest.ingested` satisfies the clock and `mail.piece.mailed` is logged three times.", { todo: true });
test("35.2-T8: Given a Spanish-language notice whose payload contains `ñ`, `á`, `¿` and `—`, when it renders, then the text layer round-trips those characters exactly; given a payload containing a character outside WinAnsi (`≥`), then the render is refused `GLYPH_UNSUPPORTED` naming the character and the block and no row is written.", { todo: true });
test("35.2-T9: Given a borrower session at L2 whose party owns a stored statement, when the app requests `GET /v1/borrower/documents/{id}` and then the signed `…/content` URL, then the response is the stored bytes with `Content-Type: application/pdf`, `Cache-Control: private, no-store`, a hash equal to `documents.sha256`, a `document_access_log{purpose=borrower_view}` row and a `ui_events{document_opened}` row; a session of another party receives 404; an expired or altered signature receives 401; a `staged` document is served from `document_blobs` with `served_from = staged_blob`.", { todo: true });
test("35.2-T10: Given 16.1 renders `NTC_REGZ_36C3_PAYOFF_STMT` for the fixture loan, then the PDF's text layer contains the 12-character verification token and the wire fraud warning, `payoff_statements.delivered_to[].evidence_document_id` names the `documents` row, and `GET /verify/{token}` answers the statement hash equal to that row's `sha256`, its good-through date and total, and writes `document_access_log{purpose=verify_portal}`.", { todo: true });
test("35.2-T11: Given the FAKE store is told to alter one stored object's bytes, when the daily integrity unit completes, then a `document_integrity_runs` row counts it, a `document_integrity_findings{mismatch}` row carries the expected and actual hashes, `documents.verify_status = mismatch`, `document.integrity.mismatch` is logged, a sev 1 escalation to `ciso` exists, `documents.dispose` on it is refused (19.1-T12), the run never re-rendered anything (the writer is not invoked), and `document.integrity.run_completed` satisfies today's `SM_DOC_INTEGRITY_DAILY` and re-arms it for tomorrow at 02:30 ET.", { todo: true });
test("35.2-T12: Given worked example B's `tax_forms_1098` row, when `documents.render{document_kind=irs_1098_copy_b}` runs, then the PDF's text layer shows `$5,743.99` in Box 1 and `$400,000.00` in Box 2, the payer TIN as `XXX-XX-1234`, the recipient/lender TIN in full and no other full TIN, the tax year, form number and form name together in one area, a direct-access telephone number, the two Pub. 1179 §4.4.1 legends, and the row's `box1_cents = 574399` and `box2_cents = 40000000` are what the page reproduces; the monthly interest figures `$1,916.67`, `$1,914.67` and `$1,912.65` are the 2.1 allocations the box sums.", { todo: true });
test("35.2-T13: Given a borrower with an active E-SIGN consent covering `disclosure_ack` and a rendered CD, when `esign.envelope.create` and `esign.envelope.send` run, then the envelope is `sent`, `esign.envelope.sent` is logged and `SM_ESIGN_ENVELOPE_EXPIRY_30` is armed on `sent_at`; when the FAKE signer signs every required field through an L2 session, then `esign_signature_events` holds `viewed`, `authenticated`, `consent_affirmed`, one `field_signed` per field and `completed`, each with `auth_method`, `ip`, `user_agent` and a valid hash chain, a signed `documents` row exists with `supersedes_document_id` = the unsigned row and a different `sha256`, `esign_envelope_documents.signed_document_id` is set once, `evidence_document_id` names an audit-trail PDF whose text lists every event, and `esign.envelope.completed` satisfies the clock.", { todo: true });
test("35.2-T14: Given a party with no active E-SIGN consent, when `esign.envelope.send` runs, then it is refused `NO_ENVELOPE_WITHOUT_CONSENT` and nothing is written; given a sent envelope whose signer emits `consent.esign.withdrawn`, then the envelope is `voided` with the reason and an audit-trail PDF; given a sent envelope untouched for 30 calendar days, then the breach voids it as `expired`, logs `esign.envelope.expired` and opens an `ops_analyst` escalation; a `completed` envelope refuses `esign.envelope.void`.", { todo: true });
test("35.2-T15: Given 26.2's FAKE RON session completes worked example 1 of 26.2, when the platform's audit trail arrives, then `documents.store` writes it with `retention_class = fnma_enote_signing_life_plus_7y`, `signing_sessions.audit_trail_document_id` names the row and `audit_trail_hash` equals its `sha256`, the signed closing documents are rows with `closing_documents.signed_document_id` set, and 26.2's `SM_O72_AUDIT_TRAIL_BEFORE_FUNDING_GATE` evaluator opens on that hash.", { todo: true });
test("35.2-T16: Given a document rendered and stored on runtime A, when runtime B (a second `Runtime` over the same database, its own process) serves `…/content` and runs `documents.verify` on it, then the bytes and hash are the stored ones — the FAKE object store is `document_blobs`, not process memory — and the borrower's `/doc/{id}` page renders the PDF with its text layer from that response.", { todo: true });
test("35.2-T17: Given the FAKE print vendor in outage for two consecutive sweeps with a batch submitted, when `mail.fallback` runs, then a `mail_manifests{vendor=in_house}` row exists with one merged PDF per mail class whose page count is the sum of the pieces' plus one cover sheet each, `mail.batch.submitted{vendor=in_house}` is logged, an `ops_analyst` escalation names the batch, and the analyst's `mail.manifest.ingest` with `mailed_on` per piece writes `notice_deliveries.mailed_at` and satisfies `SM_MAIL_MANIFEST_2BD`.", { todo: true });
test("35.2-T18: Given every 35.2 tool run over the fixture, then no ledger line and no money column changed (a contract test compares the ledger and every `*_cents` column before and after), `documents.dispose` without a 19.1 disposal run carrying an `officer` attestation is refused `DISPOSE_NEEDS_OFFICER_ATTESTATION`, an agent actor calling `esign.envelope.sign` is refused `NO_AGENT_SIGNS`, every state-changing tool left an `agent_decisions` row with `rule_set_version = docs.v1` and no decision row contains a TIN, an address or rendered text.", { todo: true });
