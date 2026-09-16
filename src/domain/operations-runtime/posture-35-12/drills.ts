/**
 * §35.12 rule 5 — `backup.drill` (ciso): the drill job (`main.ts restore-drill`, the Cloud SQL Admin API — [UNVERIFIED]) clones the
 * production instance at a PITR target inside the last hour, connects the runtime read-only and posts what it observed here:
 * `rpo_observed_s = pitr_target_at − max(loan_events.created_at)` on the clone, `rto_observed_s = completed_at − started_at`,
 * `row_checks` per table (source count at the target instant, clone count, equal), `event_chain_ok` (every loan's sequence 1..n),
 * `ledger_balanced` (every ledger_entry_sets row sums to zero on the clone), the clone's destruction. A drill passes only when every
 * check holds and RPO ≤ 300 s, RTO ≤ 14,400 s: `restore_drills{passed}`, hashed evidence, 19.2's `control_test_results` row
 * (CTL-SEC-16), `backup.restore_drill.passed{drill_id, environment, completed_at, rpo_observed_s, rto_observed_s}` (the global
 * recurring clock SM_PROD_RESTORE_DRILL_90D) and 19.2's `backup_restore_test.passed` on aggregate control:CTL-SEC-16
 * (ops-19-2.ts:284 — NYDFS_500_16D_BACKUP_RESTORE_TEST_365 from source). A failed drill is `restore_drills{failed}`,
 * `backup.restore_drill.failed{drill_id, environment, reason}`, sev 1 to the `ciso`, a `fail` control result — and satisfies neither
 * clock. `witnessed_by` is a different ciso or compliance member than the performer (WITNESS_DISTINCT); no drill runs without one.
 */
import { randomUUID } from "node:crypto";
import { toJson } from "../../../infra/db/client.ts";
import { byOf } from "./decision.ts";
import { decisionFor, hashedDocument, personId, refuse, requireRole, writeDocument, type PostureDeps } from "./deps.ts";
import { staffRow } from "../roles-35-7/actors.ts";
import { P, RPO_MAX_S, RTO_MAX_S, arr, environmentOf, isUuid, obj, s, type Row } from "./types.ts";

export interface RowCheck { readonly table: string; readonly source_count: number; readonly clone_count: number; readonly equal: boolean }
export interface DrillInput { readonly environment: string; readonly source_backup_id?: string | null; readonly backup_taken_at?: string | null; readonly pitr_target_at: string; readonly clone_instance?: string | null; readonly started_at: string; readonly completed_at: string; readonly newest_event_at?: string | null; readonly row_checks: unknown; readonly event_chain_ok: boolean; readonly ledger_balanced: boolean; readonly clone_destroyed_at?: string | null; readonly witnessed_by: string; readonly failure_reason?: string | null }
export interface DrillResult { readonly drill_id: string; readonly environment: string; readonly result: "passed" | "failed"; readonly rpo_observed_s: number | null; readonly rto_observed_s: number; readonly row_checks: readonly RowCheck[]; readonly tables_short: readonly string[]; readonly event_chain_ok: boolean; readonly ledger_balanced: boolean; readonly failure_reason: string | null; readonly evidence_document_id: string; readonly performed_by: string; readonly witnessed_by: string; readonly completed_at: string; readonly by: string }
export const DRILL_ROLES: readonly string[] = ["ciso"];
export const WITNESS_ROLES: readonly string[] = ["ciso", "compliance"];
export const CTL_BACKUP_RESTORE = "CTL-SEC-16";
const iso = (v: unknown, k: string): string => { const t = s(v); if (!t || Number.isNaN(Date.parse(t))) throw new RangeError(`${k} is an ISO timestamp`); return new Date(Date.parse(t)).toISOString(); };
const secondsBetween = (a: string, b: string): number => Math.floor((Date.parse(b) - Date.parse(a)) / 1000);

export function parseDrill(i: Row): DrillInput {
  const row_checks: RowCheck[] = arr(i["row_checks"]).map((r) => { const o = obj(r); const source = Number(o["source_count"]); const clone = Number(o["clone_count"]); if (!s(o["table"]) || !Number.isInteger(source) || !Number.isInteger(clone)) throw new RangeError("row_checks[] is [{table, source_count, clone_count}]"); return { table: s(o["table"]), source_count: source, clone_count: clone, equal: source === clone }; });
  if (typeof i["event_chain_ok"] !== "boolean" || typeof i["ledger_balanced"] !== "boolean") throw new RangeError("event_chain_ok and ledger_balanced are booleans the drill job observed on the clone");
  if (!isUuid(i["witnessed_by"])) throw new RangeError("witnessed_by is a staff_users id (a different ciso or compliance member)");
  return { environment: environmentOf(i["environment"]), source_backup_id: s(i["source_backup_id"]) || null, backup_taken_at: i["backup_taken_at"] ? iso(i["backup_taken_at"], "backup_taken_at") : null, pitr_target_at: iso(i["pitr_target_at"], "pitr_target_at"), clone_instance: s(i["clone_instance"]) || null, started_at: iso(i["started_at"], "started_at"), completed_at: iso(i["completed_at"], "completed_at"),
    newest_event_at: i["newest_event_at"] ? iso(i["newest_event_at"], "newest_event_at") : null, row_checks, event_chain_ok: i["event_chain_ok"], ledger_balanced: i["ledger_balanced"], clone_destroyed_at: i["clone_destroyed_at"] ? iso(i["clone_destroyed_at"], "clone_destroyed_at") : null, witnessed_by: i["witnessed_by"], failure_reason: s(i["failure_reason"]) || null };
}
/** Worked example B's arithmetic: RPO = target − newest event (s), RTO = completed − started (s); the pass rule. */
export function judgeDrill(d: DrillInput): { rpo: number | null; rto: number; tables_short: string[]; passed: boolean; reason: string | null } {
  const rpo = d.newest_event_at ? secondsBetween(d.newest_event_at, d.pitr_target_at) : null;
  const rto = secondsBetween(d.started_at, d.completed_at);
  const rc = d.row_checks as RowCheck[]; const tables_short = rc.filter((r) => !r.equal).map((r) => r.table);
  const reasons: string[] = [];
  if (d.failure_reason) reasons.push(d.failure_reason);
  if (rpo === null) reasons.push("no_events_on_clone"); else if (rpo < 0) reasons.push("clone_newer_than_target"); else if (rpo > RPO_MAX_S) reasons.push(`rpo_${rpo}s_over_${RPO_MAX_S}s`);
  if (rto > RTO_MAX_S) reasons.push(`rto_${rto}s_over_${RTO_MAX_S}s`);
  if (tables_short.length) reasons.push(`row_counts_differ:${tables_short.join(",")}`);
  if (!d.event_chain_ok) reasons.push("event_chain_gap");
  if (!d.ledger_balanced) reasons.push("ledger_unbalanced");
  return { rpo, rto, tables_short, passed: reasons.length === 0, reason: reasons.length ? reasons.join("; ") : null };
}

export async function recordDrill(d: PostureDeps, raw: Row): Promise<DrillResult> {
  const i = parseDrill(raw);
  const performer = await requireRole(d, DRILL_ROLES, "backup.drill", i.environment);
  if (i.witnessed_by === performer.id) refuse(409, "WITNESS_DISTINCT", `backup.drill: the witness must be a different ciso or compliance member than the performer ${performer.id} (35.12 rule 5)`, { performed_by: performer.id, witnessed_by: i.witnessed_by });
  const witness = await staffRow(d.db, i.witnessed_by);
  if (!witness || witness.status !== "active" || ![...witness.roles, ...witness.reviewer_roles].some((r) => WITNESS_ROLES.includes(r))) refuse(409, "WITNESS_DISTINCT", `backup.drill: witnessed_by ${i.witnessed_by} is not an active ciso or compliance member`, { witnessed_by: i.witnessed_by });
  const j = judgeDrill(i); const drill_id = randomUUID(); const now = d.now; const actor = d.actor; const by = personId(actor);
  const result: "passed" | "failed" = j.passed ? "passed" : "failed";
  const evidence = hashedDocument("restore-drill", { drill_id, environment: i.environment, source_backup_id: i.source_backup_id, backup_taken_at: i.backup_taken_at, pitr_target_at: i.pitr_target_at, clone_instance: i.clone_instance, started_at: i.started_at, completed_at: i.completed_at, newest_event_at: i.newest_event_at, rpo_observed_s: j.rpo, rto_observed_s: j.rto, row_checks: i.row_checks, event_chain_ok: i.event_chain_ok, ledger_balanced: i.ledger_balanced, clone_destroyed_at: i.clone_destroyed_at, result, failure_reason: j.reason, performed_by: performer.id, witnessed_by: i.witnessed_by });
  d.deferWrite(async (q) => {
    await writeDocument(q, evidence, { kind: "restore_drill_evidence", retention: "security_logs_5y", metadata: { drill_id, environment: i.environment, result, rpo_observed_s: j.rpo, rto_observed_s: j.rto, clone_destroyed_at: i.clone_destroyed_at }, created_at: now });
    const decision_id = await decisionFor(q, "drill", drill_id);
    await q.query(`INSERT INTO restore_drills (id, environment, source_backup_id, backup_taken_at, pitr_target_at, clone_instance, started_at, completed_at, rpo_observed_s, rto_observed_s, row_checks, event_chain_ok, ledger_balanced, result, failure_reason, clone_destroyed_at, evidence_document_id, performed_by, witnessed_by, decision_id, created_at) VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7::timestamptz, $8::timestamptz, $9, $10, $11::jsonb, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21::timestamptz)`,
      [drill_id, i.environment, i.source_backup_id, i.backup_taken_at, i.pitr_target_at, i.clone_instance, i.started_at, i.completed_at, j.rpo, j.rto, toJson(i.row_checks), i.event_chain_ok, i.ledger_balanced, result, j.reason, i.clone_destroyed_at, evidence.id, by, i.witnessed_by, decision_id, now]);
    await q.query(`INSERT INTO control_test_results (control_code, ran_at, result, metrics, evidence_document_id) VALUES ($1, $2::timestamptz, $3, $4::jsonb, $5)`, [CTL_BACKUP_RESTORE, now, j.passed ? "pass" : "fail", toJson({ drill_id, environment: i.environment, rpo_observed_s: j.rpo, rto_observed_s: j.rto, rpo_max_s: RPO_MAX_S, rto_max_s: RTO_MAX_S, tables: (i.row_checks as RowCheck[]).length, tables_short: j.tables_short, event_chain_ok: i.event_chain_ok, ledger_balanced: i.ledger_balanced }), evidence.id]);
  });
  const base = { drill_id, environment: i.environment, completed_at: i.completed_at, rpo_observed_s: j.rpo, rto_observed_s: j.rto, performed_by: performer.id, witnessed_by: i.witnessed_by, evidence_document_id: evidence.id, sha256: evidence.sha256 };
  if (j.passed) {
    d.events.append({ type: "backup.restore_drill.passed", aggregate: { kind: "restore_drill", id: drill_id }, actor, payload: P({ ...base, by: byOf(actor) }) });
    // 19.2's own evidence on its aggregate (ops-19-2.ts backupRestoreTest): NYDFS_500_16D_BACKUP_RESTORE_TEST_365 is satisfied from source
    d.events.append({ type: "backup_restore_test.passed", aggregate: { kind: "control", id: CTL_BACKUP_RESTORE }, actor, payload: { control: CTL_BACKUP_RESTORE, tier: 1, hours_to_restore: Math.round((j.rto / 3600) * 1000) / 1000, rto_hours: RTO_MAX_S / 3600, passed: true, quarterly: true, ran_at: now, drill_id, environment: i.environment, rpo_observed_s: j.rpo, rto_observed_s: j.rto } });
  } else {
    d.events.append({ type: "backup.restore_drill.failed", aggregate: { kind: "restore_drill", id: drill_id }, actor, payload: P({ ...base, reason: j.reason, tables_short: j.tables_short, by: byOf(actor) }) });
    d.escalations.open({ kind: "sev1", ownerRole: "ciso", severity: "1", payload: { code: "RESTORE_DRILL_FAILED", drill_id, environment: i.environment, reason: j.reason, rpo_observed_s: j.rpo, rto_observed_s: j.rto, tables_short: j.tables_short, note: "the quarterly restore was not proven; neither SM_PROD_RESTORE_DRILL_90D nor 19.2's annual clock is satisfied (35.12 rule 5)" } }, actor);
  }
  return { drill_id, environment: i.environment, result, rpo_observed_s: j.rpo, rto_observed_s: j.rto, row_checks: i.row_checks as RowCheck[], tables_short: j.tables_short, event_chain_ok: i.event_chain_ok, ledger_balanced: i.ledger_balanced, failure_reason: j.reason, evidence_document_id: evidence.id, performed_by: performer.id, witnessed_by: i.witnessed_by, completed_at: i.completed_at, by: byOf(actor) };
}
