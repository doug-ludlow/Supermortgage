/**
 * §35.2 rule 1 (VERIFY_STORED_BYTES_ONLY) — `documents.verify`. The daily integrity unit (02:30 America/New_York;
 * SM_DOC_INTEGRITY_DAILY) re-reads every stored object and hashes it; it never re-renders, so a change of the writer, of
 * `node:zlib` or of a template can never open a sev 1 on an old document. Scope: a full scan up to 250,000 stored rows; above
 * that, every row not verified in 7 days plus a 2% random sample (`rolling_7d_plus_sample`, said in the run row). A row whose
 * re-read hash differs → finding `mismatch`, `documents.verify_status = mismatch`, `document.integrity.mismatch`, a sev 1
 * escalation to `ciso`, disposal blocked (19.1-T12); an object the store no longer holds → `missing` (the finding says whether
 * the staged blob still exists); a store that cannot answer → `unreadable`. A mismatch never returns to verified by a later run
 * (the trigger refuses it). The run's own report is NDJSON stored as a `documents` row (`corporate_7y`) — no PDF, the writer is
 * not invoked. `document.integrity.run_completed{run_id, as_of_date, documents_checked, mismatches, missing}` satisfies the
 * day's clock and re-arms it for tomorrow.
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "../../../infra/db/client.ts";
import { AdapterUnavailable } from "../../../infra/integrations/failures.ts";
import { sha256Hex } from "../../../infra/blobs/pg-fake-blob-store.ts";
import { storeDocument } from "./store.ts";
import { docKey, requireDocument, type DocsDeps } from "./shared.ts";

export const FULL_SCAN_LIMIT = 250_000;
export const ROLLING_DAYS = 7;
export const ROLLING_SAMPLE = 0.02;
export const REPORT_KIND = "integrity_report";
export const REPORT_MIME = "application/x-ndjson";

export interface Finding { readonly document_id: string; readonly finding: "mismatch" | "missing" | "unreadable"; readonly expected_sha256: string; readonly actual_sha256: string | null; readonly stored_generation: string | null; readonly staged_copy_exists: boolean; readonly escalation_id: string | null; readonly loan_id: string | null; readonly application_id: string | null; }
export interface IntegrityRunResult {
  readonly run_id: string; readonly as_of_date: string; readonly scope: "full" | "rolling_7d_plus_sample"; readonly documents_checked: number; readonly verified: number; readonly mismatches: number; readonly missing: number; readonly unreadable: number;
  readonly skipped_staged: number; readonly skipped_foreign: number; readonly report_document_id: string | null; readonly findings: readonly Finding[]; readonly started_at: string; readonly finished_at: string;
}
interface StoredRow extends Record<string, unknown> { id: string; sha256: string; stored_generation: string | null; loan_id: string | null; application_id: string | null; verify_status: string; has_staged: boolean; }

/** The check of one stored object: re-read and hash; never render. */
async function checkOne(deps: DocsDeps, row: StoredRow): Promise<{ status: "verified" | "mismatch" | "missing" | "unreadable"; actual: string | null }> {
  let blob: Awaited<ReturnType<DocsDeps["blobs"]["get"]>>;
  try { blob = await deps.blobs.get(row.id, deps.q); } catch (e) { if (e instanceof AdapterUnavailable) return { status: "unreadable", actual: null }; throw e; }
  if (!blob) return { status: "missing", actual: null };
  const actual = sha256Hex(blob.bytes);
  return actual === row.sha256 ? { status: "verified", actual } : { status: "mismatch", actual };
}

/** The verify_status write under the unit's setting; a mismatch/missing row never returns to verified (the trigger refuses; the run leaves it). */
async function markVerified(q: Queryable, runId: string, row: StoredRow, status: "verified" | "mismatch" | "missing", now: string): Promise<void> {
  if (status === "verified" && (row.verify_status === "mismatch" || row.verify_status === "missing")) return;
  await q.query(`SELECT set_config('sm.integrity_run', $1, true)`, [runId]);
  await q.query(`UPDATE documents SET verify_status = $2, last_verified_at = $3::timestamptz WHERE id = $1`, [row.id, status, now]);
  await q.query(`SELECT set_config('sm.integrity_run', '', true)`);
}

function escalate(deps: DocsDeps, row: StoredRow, finding: Finding["finding"], actual: string | null, runId: string | null): string | null {
  if (!deps.escalations) return null;
  const e = deps.escalations.open({ kind: "sev1", ownerRole: "ciso", severity: "1", ...docKey(row), payload: { document_id: row.id, finding, expected_sha256: row.sha256, actual_sha256: actual, stored_generation: row.stored_generation, run_id: runId, control: "CTL-SEC-22", rule: "35.2 rule 1 / 19.1-T12: the WORM integrity check failed for one object — its disposal is blocked and a sev-1 incident is opened" } }, deps.actor);
  return e.id;
}

/** `documents.verify{op: run}` — the daily unit over every stored row the store holds. `deferWrite` takes the findings rows (they reference the escalations the runtime saves at commit). */
export async function integrityRun(deps: DocsDeps & { deferWrite: (fn: (q: Queryable) => Promise<void>) => void }, i: { as_of_date: string }): Promise<IntegrityRunResult> {
  const q = deps.q; const runId = randomUUID(); const startedAt = deps.now;
  const total = Number((await q.query<{ c: string }>(`SELECT count(*)::text AS c FROM documents WHERE storage_status = 'stored' AND (storage_uri LIKE 'fake-blob://%' OR storage_uri LIKE 'gs://%')`))[0]!.c);
  const scope: IntegrityRunResult["scope"] = total > FULL_SCAN_LIMIT ? "rolling_7d_plus_sample" : "full";
  const rolling = scope === "rolling_7d_plus_sample" ? `AND (d.last_verified_at IS NULL OR d.last_verified_at < $1::timestamptz - interval '${ROLLING_DAYS} days' OR random() < ${ROLLING_SAMPLE})` : "";
  const rows = await q.query<StoredRow>(`SELECT d.id, d.sha256, d.stored_generation, d.loan_id, d.application_id, d.verify_status, (b.content IS NOT NULL) AS has_staged FROM documents d LEFT JOIN document_blobs b ON b.document_id = d.id WHERE d.storage_status = 'stored' AND (d.storage_uri LIKE 'fake-blob://%' OR d.storage_uri LIKE 'gs://%') ${rolling} ORDER BY d.created_at, d.id`, scope === "full" ? [] : [deps.now]);
  const skippedStaged = Number((await q.query<{ c: string }>(`SELECT count(*)::text AS c FROM documents WHERE storage_status = 'staged'`))[0]!.c);
  const skippedForeign = Number((await q.query<{ c: string }>(`SELECT count(*)::text AS c FROM documents WHERE storage_status = 'stored' AND NOT (storage_uri LIKE 'fake-blob://%' OR storage_uri LIKE 'gs://%')`))[0]!.c);
  const findings: Finding[] = []; let verified = 0, mismatches = 0, missing = 0, unreadable = 0;
  for (const row of rows) {
    const r = await checkOne(deps, row);
    if (r.status === "verified") { verified++; await markVerified(q, runId, row, "verified", deps.now); continue; }
    if (r.status === "unreadable") { unreadable++; findings.push({ document_id: row.id, finding: "unreadable", expected_sha256: row.sha256, actual_sha256: null, stored_generation: row.stored_generation, staged_copy_exists: row.has_staged, escalation_id: null, loan_id: row.loan_id, application_id: row.application_id }); continue; }
    if (r.status === "mismatch") mismatches++; else missing++;
    await markVerified(q, runId, row, r.status, deps.now);
    const escalationId = escalate(deps, row, r.status, r.actual, runId);
    findings.push({ document_id: row.id, finding: r.status, expected_sha256: row.sha256, actual_sha256: r.actual, stored_generation: row.stored_generation, staged_copy_exists: row.has_staged, escalation_id: escalationId, loan_id: row.loan_id, application_id: row.application_id });
    deps.events.append({ type: "document.integrity.mismatch", ...docKey(row), aggregate: { kind: "document", id: row.id }, actor: deps.actor, payload: { document_id: row.id, finding: r.status, expected_sha256: row.sha256, actual_sha256: r.actual, stored_generation: row.stored_generation, escalation_id: escalationId, run_id: runId, staged_copy_exists: row.has_staged } });
  }
  const finishedAt = deps.now;
  // the run's own report: NDJSON, one line per finding after a header line — stored as a document (corporate_7y); no PDF, the writer is never invoked
  const report = [JSON.stringify({ run_id: runId, as_of_date: i.as_of_date, scope, documents_checked: rows.length, verified, mismatches, missing, unreadable, skipped_staged: skippedStaged, skipped_foreign: skippedForeign, started_at: startedAt, finished_at: finishedAt }), ...findings.map((f) => JSON.stringify({ document_id: f.document_id, finding: f.finding, expected_sha256: f.expected_sha256, actual_sha256: f.actual_sha256, stored_generation: f.stored_generation, staged_copy_exists: f.staged_copy_exists, escalation_id: f.escalation_id }))].join("\n") + "\n";
  const stored = await storeDocument(deps, { kind: REPORT_KIND, bytes: Buffer.from(report, "utf8"), mime_type: REPORT_MIME, retention_class: "corporate_7y", metadata: { run_id: runId, as_of_date: i.as_of_date, scope, findings: findings.length } });
  await q.query(`INSERT INTO document_integrity_runs (id, as_of_date, started_at, finished_at, scope, documents_checked, verified, mismatches, missing, skipped_staged, skipped_foreign, report_document_id) VALUES ($1, $2::date, $3::timestamptz, $4::timestamptz, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [runId, i.as_of_date, startedAt, finishedAt, scope, rows.length, verified, mismatches, missing, skippedStaged, skippedForeign, stored.document_id]);
  // the findings reference the escalations the runtime persists at commit: written in the commit transaction, after them
  if (findings.length) deps.deferWrite(async (dq) => { for (const f of findings) await dq.query(`INSERT INTO document_integrity_findings (run_id, document_id, finding, expected_sha256, actual_sha256, stored_generation, escalation_id, staged_copy_exists) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [runId, f.document_id, f.finding, f.expected_sha256, f.actual_sha256, f.stored_generation, f.escalation_id, f.staged_copy_exists]); });
  deps.events.append({ type: "document.integrity.run_completed", aggregate: { kind: "integrity_run", id: runId }, actor: deps.actor, payload: { run_id: runId, as_of_date: i.as_of_date, scope, documents_checked: rows.length, verified, mismatches, missing, unreadable, skipped_staged: skippedStaged, skipped_foreign: skippedForeign, report_document_id: stored.document_id, started_at: startedAt, finished_at: finishedAt } });
  return { run_id: runId, as_of_date: i.as_of_date, scope, documents_checked: rows.length, verified, mismatches, missing, unreadable, skipped_staged: skippedStaged, skipped_foreign: skippedForeign, report_document_id: stored.document_id, findings, started_at: startedAt, finished_at: finishedAt };
}

/** `documents.verify{op: one}` — the same check for one row (T16: runtime B verifies what runtime A stored); no run row, no clock. */
export async function verifyOne(deps: DocsDeps, i: { document_id: string }): Promise<{ document_id: string; status: "verified" | "mismatch" | "missing" | "unreadable" | "staged" | "foreign"; expected_sha256: string; actual_sha256: string | null; escalation_id: string | null }> {
  const d = await requireDocument(deps.q, i.document_id);
  if (d.storage_status !== "stored") return { document_id: d.id, status: "staged", expected_sha256: d.sha256, actual_sha256: null, escalation_id: null };
  if (!(d.storage_uri.startsWith("fake-blob://") || d.storage_uri.startsWith("gs://"))) return { document_id: d.id, status: "foreign", expected_sha256: d.sha256, actual_sha256: null, escalation_id: null };
  const row: StoredRow = { id: d.id, sha256: d.sha256, stored_generation: d.stored_generation, loan_id: d.loan_id, application_id: d.application_id, verify_status: d.verify_status, has_staged: false };
  const r = await checkOne(deps, row);
  if (r.status === "unreadable") return { document_id: d.id, status: "unreadable", expected_sha256: d.sha256, actual_sha256: null, escalation_id: null };
  const runId = `one:${randomUUID()}`;
  await markVerified(deps.q, runId, row, r.status, deps.now);
  let escalationId: string | null = null;
  if (r.status !== "verified") {
    escalationId = escalate(deps, row, r.status, r.actual, null);
    deps.events.append({ type: "document.integrity.mismatch", ...docKey(row), aggregate: { kind: "document", id: row.id }, actor: deps.actor, payload: { document_id: row.id, finding: r.status, expected_sha256: row.sha256, actual_sha256: r.actual, stored_generation: row.stored_generation, escalation_id: escalationId, run_id: null } });
  }
  return { document_id: d.id, status: r.status, expected_sha256: d.sha256, actual_sha256: r.actual, escalation_id: escalationId };
}
