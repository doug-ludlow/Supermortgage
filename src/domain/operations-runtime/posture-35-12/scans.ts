/**
 * §35.12 rule 6 — `data.scan`: no real borrower data in nonprod, no synthetic data in production. Counts only — never a value or an
 * id of a person.
 *   nonprod_real_data (nonprod, staging; daily 05:45 ET): every `parties` row (`synthetic = true` required), every `transfer_batches`
 *     row (`synthetic = true`), every application whose identity verification event names a vendor other than FAKE, every
 *     `integration_switches` row in force against rule 4's sandbox rule, every `documents` row outside the FAKE blob store or a
 *     nonprod bucket; each failing rule contributes {table, column, rule, count}. `real_data_found` → `posture.real_data.detected`
 *     on the `data_scan:<scan_id>` aggregate (SM_NONPROD_REAL_DATA_PURGE_1BD), sev 1 to `compliance`. The remedy is the environment:
 *     rebuilt, a new manifest recorded, and a clean scan carrying the finding's `scan_id` emits `posture.real_data.purged` on the
 *     finding's aggregate (the clock satisfied, the escalation completed).
 *   production_synthetic (production): any `parties.synthetic = true` row fails PST-11 — a scan-driven check row and a sev 1 finding
 *     through the same machinery as posture.check (there is no purge in production; the finding resolves by a 19.2 exception or by
 *     proving the marker wrongly set).
 *   classification_inventory (all): 19.2 `assets` rows of the environment without a classification or data classes.
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "../../../infra/db/client.ts";
import { toJson } from "../../../infra/db/client.ts";
import { openFindingFromScan } from "./check.ts";
import { byOf } from "./decision.ts";
import { hashedDocument, refuse, requireRoleOrService, writeDocument, type PostureDeps } from "./deps.ts";
import { latestManifest } from "./manifests.ts";
import { switchesInForce } from "./switches.ts";
import { MONEY_OR_PERSON_VENDORS, P, environmentOf, isProduction, isUuid, s, type Row } from "./types.ts";

export type ScanKind = "nonprod_real_data" | "classification_inventory" | "production_synthetic";
export interface ScanFinding { readonly table: string; readonly column: string; readonly rule: string; readonly count: number }
export interface ScanInput { readonly environment: string; readonly kind: string; readonly scan_id?: string | null; readonly rebuilt_manifest_id?: string | null }
export interface ScanResult { readonly scan_id: string; readonly environment: string; readonly kind: ScanKind; readonly scanned_at: string; readonly tables_scanned: number; readonly rows_examined: number; readonly findings: readonly ScanFinding[]; readonly real_data_found: boolean; readonly synthetic_coverage_pct: string | null; readonly evidence_document_id: string; readonly purged_scan_id: string | null; readonly finding_opened: { finding_id: string; control_code: string } | null; readonly by: string }
export const SCAN_ROLES: readonly string[] = ["compliance", "ciso", "admin"];
const scanAggregate = (scan_id: string): { kind: string; id: string } => ({ kind: "data_scan", id: scan_id });
const n = async (q: Queryable, sql: string, params: unknown[] = []): Promise<number> => Number((await q.query<{ n: string }>(sql, params))[0]!.n);
/** Marked rows over examined rows × 100, half-up to three decimals (parties ∪ transfer_batches); null when nothing was examined. */
export const coveragePct = (marked: number, examined: number): string | null => (examined === 0 ? null : (Math.round((marked / examined) * 100_000) / 1000).toFixed(3));

async function nonprodRules(q: Queryable, environment: string, nowIso: string): Promise<{ findings: ScanFinding[]; tables: number; rows: number; coverage: string | null }> {
  const findings: ScanFinding[] = [];
  const parties = await n(q, `SELECT count(*)::text AS n FROM parties`); const partiesReal = await n(q, `SELECT count(*)::text AS n FROM parties WHERE synthetic = false`);
  if (partiesReal) findings.push({ table: "parties", column: "synthetic", rule: "synthetic_marker", count: partiesReal });
  const batches = await n(q, `SELECT count(*)::text AS n FROM transfer_batches`); const batchesReal = await n(q, `SELECT count(*)::text AS n FROM transfer_batches WHERE synthetic = false`);
  if (batchesReal) findings.push({ table: "transfer_batches", column: "synthetic", rule: "synthetic_marker", count: batchesReal });
  const apps = await n(q, `SELECT count(*)::text AS n FROM applications`);
  const realIdentity = await n(q, `SELECT count(DISTINCT e.application_id)::text AS n FROM loan_events e WHERE e.application_id IS NOT NULL AND e.type LIKE 'identity.%' AND e.payload ? 'vendor' AND e.payload->>'vendor' <> 'FAKE'`);
  if (realIdentity) findings.push({ table: "applications", column: "identity_vendor", rule: "fake_identity_vendor", count: realIdentity });
  const switches = await switchesInForce(q, environment, nowIso);
  const live = [...switches.values()].filter((r) => r.mode === "real" && r.endpoint_class === "live" && MONEY_OR_PERSON_VENDORS.includes(r.vendor)).length;
  if (live) findings.push({ table: "integration_switches", column: "endpoint_class", rule: "sandbox_only", count: live });
  const docs = await n(q, `SELECT count(*)::text AS n FROM documents`);
  const realBlobs = await n(q, `SELECT count(*)::text AS n FROM documents WHERE coalesce(metadata->>'blob_store', '') <> 'fake-blob' AND storage_uri NOT LIKE 'fake-blob://%' AND storage_uri NOT LIKE 'memory://%' AND storage_uri NOT LIKE '%nonprod%' AND storage_uri NOT LIKE '%FAKE%' AND storage_uri NOT LIKE 'fixture://%' AND storage_uri NOT LIKE 'file://%'`);
  if (realBlobs) findings.push({ table: "documents", column: "storage_uri", rule: "nonprod_bucket", count: realBlobs });
  return { findings, tables: 5, rows: parties + batches + apps + switches.size + docs, coverage: coveragePct(parties - partiesReal + (batches - batchesReal), parties + batches) };
}

export async function runScan(d: PostureDeps, i: ScanInput): Promise<ScanResult> {
  const environment = environmentOf(i.environment); const kind = s(i.kind) as ScanKind;
  if (!["nonprod_real_data", "classification_inventory", "production_synthetic"].includes(kind)) throw new RangeError("kind ∈ {nonprod_real_data, classification_inventory, production_synthetic}");
  if (kind === "nonprod_real_data" && isProduction(environment)) throw new RangeError("the nonprod_real_data scan runs outside production; production runs production_synthetic (35.12 rule 6)");
  if (kind === "production_synthetic" && !isProduction(environment)) throw new RangeError("the production_synthetic scan runs in production only (35.12 rule 6)");
  await requireRoleOrService(d, SCAN_ROLES, "data.scan", environment);
  const scan_id = randomUUID(); const now = d.now; const actor = d.actor;
  let findings: ScanFinding[] = []; let tables = 0; let rows = 0; let coverage: string | null = null;
  if (kind === "nonprod_real_data") { const r = await nonprodRules(d.db, environment, now); findings = r.findings; tables = r.tables; rows = r.rows; coverage = r.coverage; }
  else if (kind === "production_synthetic") { const c = await n(d.db, `SELECT count(*)::text AS n FROM parties WHERE synthetic = true`); rows = await n(d.db, `SELECT count(*)::text AS n FROM parties`); tables = 1; if (c) findings.push({ table: "parties", column: "synthetic", rule: "synthetic_marker_in_production", count: c }); }
  else { const c = await n(d.db, `SELECT count(*)::text AS n FROM assets WHERE name LIKE $1 AND (classification IS NULL OR coalesce(array_length(data_classes, 1), 0) = 0)`, [`${environment}:%`]); rows = await n(d.db, `SELECT count(*)::text AS n FROM assets WHERE name LIKE $1`, [`${environment}:%`]); tables = 1; if (c) findings.push({ table: "assets", column: "classification", rule: "unclassified", count: c }); }
  const real_data_found = kind === "nonprod_real_data" && findings.length > 0;
  // a clean scan carrying the finding's scan_id closes it — the environment was rebuilt and a new manifest recorded after the finding
  let purged_scan_id: string | null = null; let rebuilt: string | null = null;
  if (kind === "nonprod_real_data" && i.scan_id) {
    if (!isUuid(i.scan_id)) throw new RangeError("scan_id is the finding's data_scans id");
    const [prior] = await d.db.query<{ id: string; scanned_at: string; real_data_found: boolean }>(`SELECT id::text AS id, scanned_at::text AS scanned_at, real_data_found FROM data_scans WHERE id = $1 AND environment = $2`, [i.scan_id, environment]);
    if (!prior) refuse(404, "SCAN_NOT_FOUND", `no data_scans row ${i.scan_id} for ${environment}`, { scan_id: i.scan_id });
    if (!prior!.real_data_found) refuse(409, "SCAN_HAD_NO_FINDING", `scan ${i.scan_id} found no real data; nothing to purge`, { scan_id: i.scan_id });
    if (findings.length) refuse(409, "NO_REAL_DATA_IN_NONPROD", `the environment still holds real data (${findings.map((f) => `${f.table}.${f.column}:${f.count}`).join(", ")}); the purge is the environment — rebuild it, record the manifest, then scan (35.12 rule 6)`, { scan_id: i.scan_id, findings });
    const m = i.rebuilt_manifest_id ? (await d.db.query<{ id: string; created_at: string }>(`SELECT id::text AS id, created_at::text AS created_at FROM environment_manifests WHERE id = $1 AND environment = $2`, [i.rebuilt_manifest_id, environment]))[0] : await latestManifest(d.db, environment);
    if (!m || Date.parse(m.created_at) <= Date.parse(prior!.scanned_at)) refuse(409, "REBUILD_NOT_RECORDED", `no ${environment} manifest recorded after the finding's scan (${prior!.scanned_at}); the rebuilt environment's deploy records one first (35.12 rule 6)`, { scan_id: i.scan_id });
    purged_scan_id = prior!.id; rebuilt = m!.id;
  }
  const evidence = hashedDocument("data-scan", { scan_id, environment, kind, scanned_at: now, tables_scanned: tables, rows_examined: rows, findings, real_data_found, synthetic_coverage_pct: coverage, purges_scan_id: purged_scan_id, rebuilt_manifest_id: rebuilt });
  d.deferWrite(async (q) => {
    await writeDocument(q, evidence, { kind: "data_scan_evidence", retention: "security_logs_5y", metadata: { scan_id, environment, kind, real_data_found, findings: findings.length }, created_at: now });
    await q.query(`INSERT INTO data_scans (id, environment, kind, scanned_at, tables_scanned, rows_examined, findings, real_data_found, synthetic_coverage_pct, evidence_document_id, purges_scan_id, created_at) VALUES ($1, $2, $3, $4::timestamptz, $5, $6, $7::jsonb, $8, $9, $10, $11, $4::timestamptz)`, [scan_id, environment, kind, now, tables, rows, toJson(findings), real_data_found, coverage, evidence.id, purged_scan_id]);
  });
  let finding_opened: ScanResult["finding_opened"] = null;
  if (real_data_found) {
    d.events.append({ type: "posture.real_data.detected", aggregate: scanAggregate(scan_id), actor, payload: P({ scan_id, environment, detected_at: now, findings, rows_examined: rows, synthetic_coverage_pct: coverage, evidence_document_id: evidence.id, by: byOf(actor) }) });
    d.escalations.open({ kind: "sev1", ownerRole: "compliance", severity: "1", payload: { code: "REAL_DATA_IN_NONPROD", scan_id, environment, findings, reason: "a real person's data is in an environment with no controls; the environment is rebuilt and re-scanned within 1 servicer business day (35.12 rule 6)" } }, actor);
  }
  if (purged_scan_id) {
    d.events.append({ type: "posture.real_data.purged", aggregate: scanAggregate(purged_scan_id), actor, payload: P({ scan_id: purged_scan_id, environment, purged_at: now, rebuilt_manifest_id: rebuilt, clean_scan_id: scan_id, by: byOf(actor) }) });
    // the finding's compliance escalation is closed by the purge evidence (a global escalation an earlier command persisted: completed in the same transaction, its event appended here)
    const purgedId = purged_scan_id; const evidenceId = evidence.id;
    const open = await d.db.query<{ id: string }>(`SELECT id::text AS id FROM escalations WHERE completed_at IS NULL AND payload->>'code' = 'REAL_DATA_IN_NONPROD' AND payload->>'scan_id' = $1`, [purgedId]);
    d.deferWrite(async (q) => { for (const e of open) await q.query(`UPDATE escalations SET completed_at = $2::timestamptz, completed_evidence_document_id = $3, status = 'completed' WHERE id = $1 AND completed_at IS NULL`, [e.id, now, evidenceId]); });
    for (const e of open) d.events.append({ type: "escalation.completed", aggregate: { kind: "escalation", id: e.id }, actor, payload: { escalation_id: e.id, kind: "sev1", evidence_document_id: evidenceId, completed_by: byOf(actor), completed_by_role: null, completed_at: now, purged_at: now, clean_scan_id: scan_id, cause: "posture.real_data.purged" } });
  }
  if (kind === "production_synthetic" && findings.length) finding_opened = await openFindingFromScan(d, { environment, control_code: "PST-11", scan_id, observed: { synthetic_parties: findings[0]!.count, scan_id } });
  return { scan_id, environment, kind, scanned_at: now, tables_scanned: tables, rows_examined: rows, findings, real_data_found, synthetic_coverage_pct: coverage, evidence_document_id: evidence.id, purged_scan_id, finding_opened, by: byOf(actor) };
}
export async function scannedToday(q: Queryable, environment: string, kind: ScanKind, asOf: string): Promise<boolean> {
  return (await q.query(`SELECT 1 FROM data_scans WHERE environment = $1 AND kind = $2 AND (scanned_at AT TIME ZONE 'America/New_York')::date = $3::date LIMIT 1`, [environment, kind, asOf])).length > 0;
}
