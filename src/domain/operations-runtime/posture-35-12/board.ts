/**
 * §35.12 Reports — the posture board (the ops console): per environment the latest manifest, the latest run's controls with results,
 * the open findings with their clocks, the switches in force, the last drill and the last scan. Ids, dates, counts and codes only.
 */
import type { Runtime } from "../../../runtime/app.ts";
import { findingsBoard } from "./findings.ts";
import { latestManifest } from "./manifests.ts";
import { integrationsStatus } from "./switches.ts";
import { REAL_ADAPTER_VENDORS } from "./real-ports.ts";
import { environmentOf, type Row } from "./types.ts";

export async function postureBoard(rt: Runtime, o: { environment?: string | null }): Promise<Row> {
  const environment = environmentOf(o.environment) || rt.environment; const now = rt.clock.now();
  const manifest = await latestManifest(rt.db, environment);
  const run = (await rt.db.query<{ run_id: string; checked_at: string }>(`SELECT run_id::text AS run_id, max(checked_at)::text AS checked_at FROM posture_checks WHERE environment = $1 GROUP BY run_id ORDER BY max(checked_at) DESC LIMIT 1`, [environment]))[0] ?? null;
  const controls = run ? await rt.db.query<Row>(`SELECT control_code, control_version, result, observed, expected FROM posture_checks WHERE run_id = $1 ORDER BY control_code`, [run.run_id]) : [];
  const findings = (await findingsBoard(rt.db, environment)).filter((f) => f.action === "opened" || f.action === "acknowledged" || f.action === "excepted");
  const clocks = findings.length ? await rt.db.query<Row>(`SELECT subject_id, code, status::text AS status, due_date::text AS due_date, due_at::text AS due_at FROM timers WHERE code IN ('SM_PROD_POSTURE_DRIFT_1BD') AND subject_kind = 'posture_finding' AND subject_id = ANY($1::text[])`, [findings.map((f) => f.finding_id)]) : [];
  const switches = await integrationsStatus(rt.db, { environment, integrations: rt.env["INTEGRATIONS"], nowIso: now, realAdapters: REAL_ADAPTER_VENDORS });
  const drill = (await rt.db.query<Row>(`SELECT id::text AS id, result, completed_at::text AS completed_at, rpo_observed_s, rto_observed_s FROM restore_drills WHERE environment = $1 ORDER BY completed_at DESC LIMIT 1`, [environment]))[0] ?? null;
  const scan = (await rt.db.query<Row>(`SELECT id::text AS id, kind, scanned_at::text AS scanned_at, real_data_found, findings FROM data_scans WHERE environment = $1 ORDER BY scanned_at DESC LIMIT 1`, [environment]))[0] ?? null;
  const daily = (await rt.db.query<Row>(`SELECT code, status::text AS status, due_at::text AS due_at FROM timers WHERE code IN ('SM_PROD_POSTURE_DAILY', 'SM_PROD_RESTORE_DRILL_90D', 'SM_PROD_PARALLEL_RUN_DAILY', 'SM_PROD_GO_LIVE_ATTEST_GATE') AND status IN ('armed', 'breached') ORDER BY code`));
  return { environment, as_of: now, manifest: manifest ? { id: manifest.id, env_hash: manifest.env_hash, image_digest: manifest.image_digest, migration_head: manifest.migration_head, created_at: manifest.created_at } : null, run: run ? { run_id: run.run_id, checked_at: run.checked_at, controls } : null,
    findings: findings.map((f) => ({ finding_id: f.finding_id, control_code: f.control_code, action: f.action, severity: f.severity, detected_at: f.detected_at, clock: clocks.find((c) => c["subject_id"] === f.finding_id) ?? null })), switches: switches.vendors.filter((v) => v.source === "switch" || v.pending_request), last_drill: drill, last_scan: scan, clocks: daily };
}
