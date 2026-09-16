/**
 * §35.12 — the sweep's pass (src/runtime/app.ts Runtime.sweep, after 35.7's roles pass and before the verify and breach passes),
 * for the runtime's OWN environment (a runtime reads its own database; another environment's posture is that environment's runtime's):
 *   1. switch and attestation requests past 10 minutes → `integration.switch.request.expired` / `go_live.attest.request.expired`;
 *   2. under INTEGRATIONS=real the ports are rebuilt from the switches in force (rule 4: running instances re-read the table within one sweep);
 *   3. at/after 05:30 ET, when the environment has a manifest and no `posture.check.run_completed` today, the daily posture check
 *      (POSTURE_CHECK_CYCLE — the same unit 35.3's `cycles.run_unit` runs for the `posture.check` registry row);
 *   4. at/after 05:45 ET the daily data scan once per day: `nonprod_real_data` outside production, `production_synthetic` in production (DATA_SCAN_CYCLE);
 *   5. at/after 21:00 ET, when an open parallel run has the day's incumbent file as a document and the day is not reconciled, the
 *      reconciliation (PARALLEL_RUN_RECONCILE_CYCLE); a missing file leaves the day to SM_PROD_PARALLEL_RUN_DAILY's breach;
 *   6. one `integration.canary{vendor, ok, latency_ms, probe}` per `real` vendor per day — the port constructed and not an OffPort (the
 *      per-vendor read-only call is [UNVERIFIED per vendor] and lands with each real adapter); feeds GL-05.
 * Each step is its own global unit of work (deps.ts runGlobal) as the agent `compliance-sentinel`; nothing here touches a section's clock
 * or a money field. The three cycle runners are exported in the ROLES_QUEUE_SCAN shape for 35.3's registry.
 */
import type { Runtime } from "../../../runtime/app.ts";
import { wallClock } from "../../../kernel/calendar/zoned.ts";
import { runPostureCheck, receiptExists, type CheckRunResult } from "./check.ts";
import { runGlobal, SYSTEM_ACTOR } from "./deps.ts";
import { expireAttestRequests } from "./go-live.ts";
import { latestManifest } from "./manifests.ts";
import { pendingReconciliations, reconcileDay, type ReconcileResult } from "./parallel-run.ts";
import { PORT_TAG, VENDOR_PORTS, refreshPorts } from "./real-ports.ts";
import { runScan, scannedToday, type ScanKind, type ScanResult } from "./scans.ts";
import { staleSwitchRequests, switchRequestExpiredEvent, switchesInForce } from "./switches.ts";
import { DATA_SCAN_AT_ET, ET, P, POSTURE_CHECK_AT_ET, RECONCILE_AT_ET, isProduction } from "./types.ts";

export interface PostureSweepReport { readonly at: string; readonly as_of_date: string; readonly environment: string; readonly switch_requests_expired: number; readonly attest_requests_expired: number; readonly ports_refreshed: boolean; readonly daily_check: CheckRunResult | null; readonly daily_scan: ScanResult | null; readonly reconciled: readonly ReconcileResult[]; readonly canaries: readonly { vendor: string; ok: boolean; latency_ms: number }[]; readonly line: string }
const hhmm = (wc: { hour: number; minute: number }): string => `${String(wc.hour).padStart(2, "0")}:${String(wc.minute).padStart(2, "0")}`;

export async function posturePass(rt: Runtime, nowIso: string = rt.clock.now(), o: { runId?: string | null } = {}): Promise<PostureSweepReport> {
  const wc = wallClock(Date.parse(nowIso), ET); const asOf = wc.date; const clockNow = hhmm(wc); const environment = rt.environment;
  // 1. the two-person requests past 10 minutes
  const staleSwitches = await staleSwitchRequests(rt.db, nowIso);
  if (staleSwitches.length) await rt.uow.run({}, (ctx) => { for (const r of staleSwitches) ctx.events.append(switchRequestExpiredEvent(r, nowIso)); }, { clock: rt.clock });
  const attestExpired = await expireAttestRequests(rt, nowIso);
  // 2. rule 4: the ports re-read the switches
  const refreshed = (await refreshPorts(rt, rt.logger ? { logger: rt.logger } : {})) !== null;
  // 3. the daily posture check
  let daily_check: CheckRunResult | null = null;
  if (clockNow >= POSTURE_CHECK_AT_ET && (await latestManifest(rt.db, environment)) && !(await receiptExists(rt.db, environment, asOf))) daily_check = await POSTURE_CHECK_CYCLE.run(rt, { as_of: asOf, planned_by: o.runId ? `sweep:${o.runId}` : "sweep" });
  // 4. the daily scan
  let daily_scan: ScanResult | null = null;
  const kind: ScanKind = isProduction(environment) ? "production_synthetic" : "nonprod_real_data";
  if (clockNow >= DATA_SCAN_AT_ET && !(await scannedToday(rt.db, environment, kind, asOf))) daily_scan = await DATA_SCAN_CYCLE.run(rt, { as_of: asOf, planned_by: o.runId ? `sweep:${o.runId}` : "sweep" });
  // 5. the evening reconciliation of every open run whose file for the day arrived
  const reconciled: ReconcileResult[] = [];
  if (clockNow >= RECONCILE_AT_ET) for (const p of await pendingReconciliations(rt.db, environment, asOf)) reconciled.push(await runGlobal(rt, SYSTEM_ACTOR, (d) => reconcileDay(d, { parallel_run_id: p.parallel_run_id, as_of_date: p.as_of_date, incumbent_file_document_id: p.document_id })));
  // 6. the canary per real vendor, once a day
  const canaries: { vendor: string; ok: boolean; latency_ms: number }[] = [];
  const real = [...(await switchesInForce(rt.db, environment, nowIso)).values()].filter((r) => r.mode === "real");
  if (real.length) {
    const today = new Set((await rt.db.query<{ vendor: string }>(`SELECT payload->>'vendor' AS vendor FROM loan_events WHERE type = 'integration.canary' AND payload->>'environment' = $1 AND payload->>'as_of_date' = $2`, [environment, asOf])).map((r) => r.vendor));
    const due = real.filter((r) => !today.has(r.vendor));
    if (due.length) await rt.uow.run({}, (ctx) => { for (const r of due) { const t0 = Date.now(); const names = VENDOR_PORTS[r.vendor] ?? []; const constructed = names.length > 0 && names.every((n) => { const p = (rt.ports as Record<string, unknown>)[n]; return !!p && !((p as Record<symbol, unknown>)[PORT_TAG]); }); const latency_ms = Date.now() - t0; canaries.push({ vendor: r.vendor, ok: constructed, latency_ms }); ctx.events.append({ type: "integration.canary", aggregate: { kind: "integration_switch", id: `${environment}:${r.vendor}` }, actor: SYSTEM_ACTOR, payload: P({ vendor: r.vendor, environment, as_of_date: asOf, ok: constructed, latency_ms, probe: constructed ? "port_constructed" : "port_missing", endpoint_class: r.endpoint_class, at: nowIso }) }); } }, { clock: rt.clock });
  }
  const line = `posture ${asOf} ${environment}: switch_requests_expired=${staleSwitches.length} attest_requests_expired=${attestExpired} ports_refreshed=${refreshed} daily_check=${daily_check ? daily_check.run_id : "none"} daily_scan=${daily_scan ? daily_scan.scan_id : "none"} reconciled=${reconciled.length} canaries=${canaries.length}`;
  return { at: nowIso, as_of_date: asOf, environment, switch_requests_expired: staleSwitches.length, attest_requests_expired: attestExpired, ports_refreshed: refreshed, daily_check, daily_scan, reconciled, canaries, line };
}

/** 35.3's units: `posture.check` (05:30 ET, global), `data.scan` (05:45 ET, global), `parallel_run.reconcile` (21:00 ET, global) — the runners their registry rows name (the ROLES_QUEUE_SCAN shape). */
export const POSTURE_CHECK_CYCLE = {
  code: "posture.check" as const, owner_process: "35.12" as const, owner_agent: "compliance-sentinel" as const, unit_scope: "global" as const, receipt_event: "posture.check.run_completed" as const, serves_timer: "SM_PROD_POSTURE_DAILY" as const,
  run: (rt: Runtime, o: { as_of: string; planned_by: string; environment?: string }): Promise<CheckRunResult> => runGlobal(rt, SYSTEM_ACTOR, (d) => runPostureCheck(d, { environment: o.environment ?? rt.environment, trigger: "cycle" })),
};
export const DATA_SCAN_CYCLE = {
  code: "data.scan" as const, owner_process: "35.12" as const, owner_agent: "compliance-sentinel" as const, unit_scope: "global" as const, receipt_event: "posture.real_data.detected" as const, serves_timer: "SM_NONPROD_REAL_DATA_PURGE_1BD" as const,
  run: (rt: Runtime, o: { as_of: string; planned_by: string; environment?: string; kind?: ScanKind }): Promise<ScanResult> => { const environment = o.environment ?? rt.environment; return runGlobal(rt, SYSTEM_ACTOR, (d) => runScan(d, { environment, kind: o.kind ?? (isProduction(environment) ? "production_synthetic" : "nonprod_real_data") })); },
};
export const PARALLEL_RUN_RECONCILE_CYCLE = {
  code: "parallel_run.reconcile" as const, owner_process: "35.12" as const, owner_agent: "compliance-sentinel" as const, unit_scope: "global" as const, receipt_event: "parallel_run.day.reconciled" as const, serves_timer: "SM_PROD_PARALLEL_RUN_DAILY" as const,
  run: async (rt: Runtime, o: { as_of: string; planned_by: string; environment?: string }): Promise<ReconcileResult[]> => { const out: ReconcileResult[] = []; for (const p of await pendingReconciliations(rt.db, o.environment ?? rt.environment, o.as_of)) out.push(await runGlobal(rt, SYSTEM_ACTOR, (d) => reconcileDay(d, { parallel_run_id: p.parallel_run_id, as_of_date: p.as_of_date, incumbent_file_document_id: p.document_id }))); return out; },
};
