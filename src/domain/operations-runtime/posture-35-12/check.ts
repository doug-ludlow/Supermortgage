/**
 * §35.12 rule 3 — `posture.check`: one `posture_checks` row per control per run over the manifest (the latest of the environment, or
 * the one named, or the facts just posted by posture.record) and the environment's own database facts; a `fail` on a required control
 * (unverifiable counts as a fail in production, not_applicable elsewhere) with no open finding opens `posture_findings{opened}` and
 * `posture.drift.detected` on the `posture_finding:<finding_id>` aggregate (SM_PROD_POSTURE_DRIFT_1BD's subject) with a `ciso`
 * escalation at the control's severity; a second run with the same failure appends a check row and nothing else. A required
 * control that passes resolves its open finding (`resolved{cause: manifest}`, `posture.drift.resolved`, the clock satisfied). An
 * `excepted` finding whose exception expired while the check still fails is `expired` and a new finding opens. The day's receipt
 * `posture.check.run_completed{run_id, environment, as_of_date, …}` is emitted once per (environment, as_of_date) on the global
 * subject (SM_PROD_POSTURE_DAILY); a later run the same day emits `posture.check.run_repeated`. Each check also writes 19.2's
 * `control_test_results` row for the mapped control and the run's hashed report document. Nothing here changes infrastructure.
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "../../../infra/db/client.ts";
import { toJson } from "../../../infra/db/client.ts";
import { wallClock } from "../../../kernel/calendar/zoned.ts";
import { evaluateControl, gatherDbFacts, isRequired, loadControls, type ControlResult, type ControlRow, type DbFacts, type ManifestFacts } from "./controls.ts";
import { byOf } from "./decision.ts";
import { decisionFor, hashedDocument, personId, refuse, requireRoleOrService, writeDocument, type PostureDeps } from "./deps.ts";
import { latestManifest, manifestById } from "./manifests.ts";
import { ET, P, isProduction, isUuid, type Row } from "./types.ts";

export interface FindingRow { readonly id: string; readonly finding_id: string; readonly environment: string; readonly control_code: string; readonly action: string; readonly check_id: string | null; readonly severity: string; readonly detected_at: string; readonly resolved_at: string | null; readonly cause: string | null; readonly exception_id: string | null; readonly by: string | null; readonly created_at: string }
export const FINDING_COLS = `id::text AS id, finding_id::text AS finding_id, environment, control_code, action, check_id::text AS check_id, severity, detected_at::text AS detected_at, resolved_at::text AS resolved_at, cause, exception_id::text AS exception_id, by::text AS by, created_at::text AS created_at`;
export interface CheckRow { readonly id: string; readonly control_code: string; readonly control_version: number; readonly result: "pass" | "fail" | "not_applicable" | "unverifiable"; readonly required: boolean; readonly observed: Row; readonly expected: Row }
export interface CheckRunResult { readonly run_id: string; readonly environment: string; readonly as_of_date: string; readonly manifest_id: string | null; readonly controls: number; readonly passed: number; readonly failed: number; readonly unverifiable: number; readonly not_applicable: number; readonly rows: readonly CheckRow[]; readonly findings_opened: readonly { finding_id: string; control_code: string; severity: string }[]; readonly findings_resolved: readonly { finding_id: string; control_code: string }[]; readonly findings_expired: readonly { finding_id: string; control_code: string }[]; readonly receipt: "run_completed" | "run_repeated"; readonly report_document_id: string; readonly by: string }
export const CHECK_ROLES: readonly string[] = ["compliance", "ciso", "admin"];
export const severityLevel = (sev: string): 1 | 2 | 3 => (sev === "sev1" ? 1 : sev === "sev2" ? 2 : 3);
export const findingAggregate = (finding_id: string): { kind: string; id: string } => ({ kind: "posture_finding", id: finding_id });

/** The latest row of every finding of the environment (its current state), keyed by control. */
export async function latestFindings(q: Queryable, environment: string, control?: string): Promise<Map<string, FindingRow>> {
  const rows = await q.query<FindingRow & Record<string, unknown>>(`SELECT DISTINCT ON (finding_id) ${FINDING_COLS} FROM posture_findings WHERE environment = $1 ${control ? "AND control_code = $2" : ""} ORDER BY finding_id, created_at DESC, id DESC`, control ? [environment, control] : [environment]);
  const out = new Map<string, FindingRow>();
  // per control, the newest finding decides (an older resolved finding never shadows a newer open one)
  for (const r of rows.sort((a, b) => a.created_at.localeCompare(b.created_at))) out.set(r.control_code, r);
  return out;
}
export async function findingById(q: Queryable, finding_id: string): Promise<FindingRow | undefined> {
  if (!isUuid(finding_id)) return undefined;
  return (await q.query<FindingRow & Record<string, unknown>>(`SELECT ${FINDING_COLS} FROM posture_findings WHERE finding_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [finding_id]))[0];
}
const isOpen = (f: FindingRow | undefined): boolean => !!f && (f.action === "opened" || f.action === "acknowledged");
export async function exceptionExpired(q: Queryable, exception_id: string | null, nowIso: string): Promise<boolean> {
  if (!exception_id) return true;
  const [e] = await q.query<{ expires_at: string }>(`SELECT expires_at::text AS expires_at FROM control_exceptions WHERE id = $1`, [exception_id]);
  return !e || Date.parse(`${e.expires_at}T23:59:59Z`) < Date.parse(nowIso);
}
export async function receiptExists(q: Queryable, environment: string, asOf: string): Promise<boolean> {
  return (await q.query(`SELECT 1 FROM loan_events WHERE type = 'posture.check.run_completed' AND payload->>'environment' = $1 AND payload->>'as_of_date' = $2 LIMIT 1`, [environment, asOf])).length > 0;
}

export interface CheckInput { readonly environment: string; readonly manifest_id?: string | null; readonly manifest?: ManifestFacts; readonly trigger?: "manifest" | "cycle" | "request" | "scan"; readonly pendingAssets?: DbFacts["assets"] }
/** The run: the rows, the findings, the receipt, the report and 19.2's control_test_results — all in the caller's unit of work. */
export async function runPostureCheck(d: PostureDeps, i: CheckInput): Promise<CheckRunResult> {
  const environment = i.environment;
  await requireRoleOrService(d, CHECK_ROLES, "posture.check", environment);
  let manifest: ManifestFacts | undefined = i.manifest;
  if (!manifest) {
    const row = i.manifest_id ? await manifestById(d.db, i.manifest_id) : await latestManifest(d.db, environment);
    if (!row) refuse(404, "MANIFEST_NOT_FOUND", `posture.check: no manifest recorded for ${environment}${i.manifest_id ? ` (id ${i.manifest_id})` : ""}; the deploy's posture.record step comes first (35.12 rule 1)`, { environment, manifest_id: i.manifest_id ?? null });
    if (row!.environment !== environment) refuse(409, "MANIFEST_ENVIRONMENT", `manifest ${row!.id} is ${row!.environment}'s, not ${environment}'s`, { environment, manifest_id: row!.id });
    manifest = row!;
  }
  const controls = await loadControls(d.db);
  const gathered = await gatherDbFacts(d.db, environment, d.now, manifest);
  const pending = (i.pendingAssets ?? []).filter((a) => !gathered.assets.some((x) => x.kind === a.kind && x.name === a.name));
  const db: DbFacts = pending.length ? { ...gathered, assets: [...gathered.assets, ...pending] } : gathered;
  const production = isProduction(environment);
  const run_id = randomUUID(); const as_of_date = wallClock(Date.parse(d.now), ET).date;
  const rows: CheckRow[] = [];
  for (const c of controls) {
    const required = isRequired(c, environment);
    const r: ControlResult = evaluateControl(c, { manifest, db, now: d.now });
    const result: CheckRow["result"] = !required ? "not_applicable" : r.result === "unverifiable" && !production ? "not_applicable" : r.result;
    rows.push({ id: randomUUID(), control_code: c.code, control_version: c.version, result, required, observed: { ...r.observed, ...(required ? {} : { not_required_in: environment }) }, expected: r.expected });
  }
  const failing = (r: CheckRow): boolean => r.required && (r.result === "fail" || (r.result === "unverifiable" && production));
  const latest = await latestFindings(d.db, environment);
  const byCode = new Map(controls.map((c) => [c.code, c] as const));
  const opened: { finding_id: string; control_code: string; severity: string; check_id: string; expired_from?: string }[] = [];
  const resolved: { finding_id: string; control_code: string; check_id: string }[] = [];
  const expired: { finding_id: string; control_code: string }[] = [];
  for (const r of rows) {
    const c = byCode.get(r.control_code)!; const cur = latest.get(r.control_code);
    if (failing(r)) {
      if (isOpen(cur)) continue;                                       // a second run with the same failure appends a check row and nothing else
      if (cur?.action === "excepted") { if (!(await exceptionExpired(d.db, cur.exception_id, d.now))) continue; expired.push({ finding_id: cur.finding_id, control_code: r.control_code }); }
      opened.push({ finding_id: randomUUID(), control_code: r.control_code, severity: c.severity, check_id: r.id, ...(cur?.action === "excepted" ? { expired_from: cur.finding_id } : {}) });
    } else if (r.required && r.result === "pass" && (isOpen(cur) || cur?.action === "excepted")) resolved.push({ finding_id: cur!.finding_id, control_code: r.control_code, check_id: r.id });
  }
  const counts = { passed: rows.filter((r) => r.result === "pass").length, failed: rows.filter((r) => r.result === "fail").length, unverifiable: rows.filter((r) => r.result === "unverifiable").length, not_applicable: rows.filter((r) => r.result === "not_applicable").length };
  const report = hashedDocument("posture-check", { run_id, environment, as_of_date, manifest_id: manifest.id, controls: rows.map((r) => ({ control_code: r.control_code, version: r.control_version, result: r.result, observed: r.observed })), findings_opened: opened.map((o) => o.control_code), findings_resolved: resolved.map((o) => o.control_code) });
  const receipt: CheckRunResult["receipt"] = (await receiptExists(d.db, environment, as_of_date)) ? "run_repeated" : "run_completed";
  const manifest_id = manifest.id; const now = d.now; const actor = d.actor; const by = personId(actor);
  d.deferWrite(async (q) => {
    await writeDocument(q, report, { kind: "posture_check_report", retention: "security_logs_5y", metadata: { run_id, environment, as_of_date, manifest_id, ...counts }, created_at: now });
    for (const r of rows) await q.query(`INSERT INTO posture_checks (id, run_id, environment, manifest_id, control_code, control_version, result, observed, expected, checked_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::timestamptz)`, [r.id, run_id, environment, manifest_id, r.control_code, r.control_version, r.result, toJson(r.observed), toJson(r.expected), now]);
    for (const r of rows) { const c = byCode.get(r.control_code)!; if (c.security_control_code && (r.result === "pass" || r.result === "fail")) await q.query(`INSERT INTO control_test_results (control_code, ran_at, result, metrics, evidence_document_id) VALUES ($1, $2::timestamptz, $3, $4::jsonb, $5)`, [c.security_control_code, now, r.result, toJson({ posture_control: r.control_code, run_id, environment, observed: r.observed }), report.id]); }
    const decision_id = await decisionFor(q, "check_run", run_id);
    for (const e of expired) await q.query(`INSERT INTO posture_findings (finding_id, environment, control_code, action, check_id, severity, detected_at, resolved_at, cause, by, decision_id) SELECT finding_id, environment, control_code, 'expired', $2, severity, detected_at, $3::timestamptz, 'exception', NULL, $4 FROM posture_findings WHERE finding_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [e.finding_id, opened.find((o) => o.expired_from === e.finding_id)?.check_id ?? null, now, decision_id]);
    for (const o of opened) await q.query(`INSERT INTO posture_findings (finding_id, environment, control_code, action, check_id, severity, detected_at, by, decision_id) VALUES ($1, $2, $3, 'opened', $4, $5, $6::timestamptz, $7, $8)`, [o.finding_id, environment, o.control_code, o.check_id, o.severity, now, by, decision_id]);
    for (const r of resolved) await q.query(`INSERT INTO posture_findings (finding_id, environment, control_code, action, check_id, severity, detected_at, resolved_at, cause, by, decision_id) SELECT finding_id, environment, control_code, 'resolved', $2, severity, detected_at, $3::timestamptz, 'manifest', $4, $5 FROM posture_findings WHERE finding_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [r.finding_id, r.check_id, now, by, decision_id]);
  });
  for (const o of opened) {
    d.events.append({ type: "posture.drift.detected", aggregate: findingAggregate(o.finding_id), actor, payload: P({ finding_id: o.finding_id, environment, control_code: o.control_code, severity: o.severity, detected_at: now, run_id, manifest_id, check_id: o.check_id, ...(o.expired_from ? { reopened_from: o.expired_from } : {}) }) });
    d.escalations.open({ kind: `sev${severityLevel(o.severity)}`, ownerRole: "ciso", severity: String(severityLevel(o.severity)), payload: { code: "POSTURE_DRIFT", finding_id: o.finding_id, environment, control_code: o.control_code, severity: o.severity, run_id, reason: `${o.control_code} failed in ${environment}: a production control failed and must be resolved or excepted within 1 servicer business day (35.12 rule 3)` } }, actor);
  }
  for (const r of resolved) d.events.append({ type: "posture.drift.resolved", aggregate: findingAggregate(r.finding_id), actor, payload: P({ finding_id: r.finding_id, environment, control_code: r.control_code, resolved_at: now, cause: "manifest", run_id, manifest_id, check_id: r.check_id }) });
  for (const e of expired) d.events.append({ type: "posture.exception.expired", aggregate: findingAggregate(e.finding_id), actor, payload: P({ finding_id: e.finding_id, environment, control_code: e.control_code, expired_at: now, run_id }) });
  const payload = P({ run_id, environment, as_of_date, manifest_id, trigger: i.trigger ?? "request", controls: rows.length, ...counts, report_document_id: report.id, sha256: report.sha256, by: byOf(actor) });
  d.events.append({ type: receipt === "run_completed" ? "posture.check.run_completed" : "posture.check.run_repeated", aggregate: { kind: "posture_check_run", id: run_id }, actor, payload });
  return { run_id, environment, as_of_date, manifest_id, controls: rows.length, ...counts, rows, findings_opened: opened.map(({ finding_id, control_code, severity }) => ({ finding_id, control_code, severity })), findings_resolved: resolved.map(({ finding_id, control_code }) => ({ finding_id, control_code })), findings_expired: expired, receipt, report_document_id: report.id, by: byOf(actor) };
}
