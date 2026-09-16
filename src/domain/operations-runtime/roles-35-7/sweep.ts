/**
 * §35.7 — the sweep's pass (src/runtime/app.ts Runtime.sweep, after the FAKE reviewers' tick and before the breach pass):
 *   1. at/after 06:30 ET, when the environment has no `role.queue.scan_completed` for the day, the daily queue scan
 *      (ROLES_QUEUE_SCAN — the same unit 35.3's `cycles.run_unit` runs; the receipt satisfies and re-arms
 *      SM_HANDOVER_BOARD_DAILY on the global subject before the breach pass could breach it);
 *   2. every pass, a light re-scan of the roles with open items (snapshots for those roles only; the unstaffed/staffed
 *      transitions; no completion receipt) so `role.queue.unstaffed` is raised within one sweep of the item that caused it;
 *   3. break-glass grants past their 4 hours → role_grants{breakglass_expired} + `role.revoked{cause: breakglass_expired}`;
 *   4. independence-role grant requests past 10 minutes → `role.grant.request.expired`;
 *   5. handover requests past 10 minutes → role_handovers{expired} + `handover.request.expired`;
 *   6. principals past `expires_at` → revoked_cause = expired + `principal.revoked{cause: expired}`.
 * Each step is its own global unit of work whose commit writes the rows. Nothing here touches a section's clock.
 */
import { randomUUID } from "node:crypto";
import type { Runtime } from "../../../runtime/app.ts";
import { wallClock } from "../../../kernel/calendar/zoned.ts";
import { breakglassExpiredEvent, breakglassExpiredRow, expiredBreakglass } from "./breakglass.ts";
import { grantRequestExpiredEvent, staleGrantRequests } from "./grants.ts";
import { expireHandoverRow, handoverExpiredEvent, staleHandoverRequests } from "./handover.ts";
import type { RolesPorts } from "./ports.ts";
import { PRINCIPAL_COLS, principalRevokedEvent, type PrincipalRow } from "./principals.ts";
import { ROLES_QUEUE_SCAN, openItems, scanRoleQueues, scanCompletedOn } from "./queue.ts";
import { portsOf } from "./ports.ts";
import { ET, QUEUE_SCAN_AT_ET } from "./types.ts";

export interface RolesSweepReport { readonly at: string; readonly as_of_date: string; readonly daily_scan: boolean; readonly daily_scan_run_id: string | null; readonly rescanned: number; readonly unstaffed_raised: readonly string[]; readonly staffed_raised: readonly string[]; readonly breakglass_expired: number; readonly grant_requests_expired: number; readonly handover_requests_expired: number; readonly principals_expired: number; readonly line: string }
const SYSTEM_ACTOR = { kind: "system" as const, id: "roles-35-7" };

export async function rolesSweepPass(rt: Runtime, nowIso: string = rt.clock.now(), o: { runId?: string | null; ports?: RolesPorts } = {}): Promise<RolesSweepReport> {
  const wc = wallClock(Date.parse(nowIso), ET); const asOf = wc.date;
  const [hh, mm] = QUEUE_SCAN_AT_ET.split(":").map(Number) as [number, number];
  const ports = portsOf(o.ports);
  // 1. the daily scan (35.3's unit when the registry runs it; here when nobody did)
  let daily = false; let dailyRunId: string | null = null; let unstaffed: string[] = []; let staffed: string[] = [];
  if (wc.hour * 60 + wc.minute >= hh * 60 + mm && !(await scanCompletedOn(rt.db, rt.environment, asOf))) {
    const r = await ROLES_QUEUE_SCAN.run(rt, { as_of: asOf, planned_by: o.runId ? `sweep:${o.runId}` : "sweep" }, ports);
    daily = true; dailyRunId = r.scan_run_id; unstaffed = [...r.unstaffed_raised]; staffed = [...r.staffed_raised];
  }
  // 2. the light re-scan of the roles with open items (and of the roles a snapshot says are unstaffed, so a drained queue leaves that state)
  let rescanned = 0;
  if (!daily) {
    const open = await openItems(rt.db, ports, nowIso);
    const roles = new Set(open.items.map((i) => i.role));
    for (const r of await rt.db.query<{ role: string }>(`SELECT DISTINCT ON (role) role FROM role_queue_snapshots WHERE environment = $1 AND status = 'unstaffed' ORDER BY role, created_at DESC, id DESC`, [rt.environment])) roles.add(r.role);
    if (roles.size) { const r = await scanRoleQueues(rt, { as_of: asOf, planned_by: o.runId ? `sweep:${o.runId}` : "sweep", roles: [...roles], completion: false, ...(o.runId ? { scan_run_id: o.runId } : {}) }, ports); rescanned = r.rows.length; unstaffed = r.unstaffed_raised.slice(); staffed = r.staffed_raised.slice(); }
  }
  // 3. break-glass expiry — the revoke ids are minted first so the rows (commit) and the events (the uow) name the same ids
  const bg = (await expiredBreakglass(rt.db, nowIso)).map((u) => ({ u, rid: randomUUID() }));
  if (bg.length) await rt.uow.run({}, (ctx) => { for (const { u, rid } of bg) ctx.events.append(breakglassExpiredEvent(u, rid, nowIso)); }, { clock: rt.clock, commit: async (q) => { for (const { u, rid } of bg) await breakglassExpiredRow(q, u, nowIso, rid); } });
  // 4. grant requests
  const stale = await staleGrantRequests(rt.db, nowIso);
  if (stale.length) await rt.uow.run({}, (ctx) => { for (const r of stale) ctx.events.append(grantRequestExpiredEvent(r, nowIso)); }, { clock: rt.clock });
  // 5. handover requests
  const hand = await staleHandoverRequests(rt.db, nowIso);
  if (hand.length) await rt.uow.run({}, (ctx) => { for (const r of hand) ctx.events.append(handoverExpiredEvent(r, nowIso)); }, { clock: rt.clock, commit: async (q) => { for (const r of hand) await expireHandoverRow(q, r, nowIso); } });
  // 6. principals
  const dead = await rt.db.query<PrincipalRow & Record<string, unknown>>(`UPDATE api_principals SET revoked_at = $1, revoked_cause = 'expired' WHERE revoked_at IS NULL AND expires_at <= $1::timestamptz RETURNING ${PRINCIPAL_COLS}`, [nowIso]);
  if (dead.length) await rt.uow.run({}, (ctx) => { for (const p of dead) ctx.events.append(principalRevokedEvent(p, null, "expired", SYSTEM_ACTOR)); }, { clock: rt.clock });
  const line = `roles ${asOf}: daily_scan=${daily} rescanned=${rescanned} unstaffed=[${unstaffed.join(",")}] staffed=[${staffed.join(",")}] breakglass_expired=${bg.length} grant_requests_expired=${stale.length} handover_requests_expired=${hand.length} principals_expired=${dead.length}`;
  return { at: nowIso, as_of_date: asOf, daily_scan: daily, daily_scan_run_id: dailyRunId, rescanned, unstaffed_raised: unstaffed, staffed_raised: staffed, breakglass_expired: bg.length, grant_requests_expired: stale.length, handover_requests_expired: hand.length, principals_expired: dead.length, line };
}
