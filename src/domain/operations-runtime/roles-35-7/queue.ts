/**
 * §35.7 rule 5 — the role queue. For a role in an environment the open items are: `escalations` rows with `owner_role = role`
 * and `completed_at IS NULL` (timer-breach kinds sev1..sev4 count — a breach is a person's finding, 34.4 rule 1); 35.6
 * orchestration steps in `waiting_human{role}` (through OrchestrationStepsPort); the section work items a FAKE would fill —
 * a `terms.presentation.requested` with no `mlo.review.completed` (mlo_of_record) and a `qc_reviews` row selected or in review
 * (qc_officer) — the reviewers' own selectors, reused. Holders are active staff_users holding the role (roles ∪ reviewer_roles);
 * `fake` is rule 6's answer. Status: unstaffed when open_items > 0 ∧ holders = 0 ∧ ¬fake; fake when fake; staffed when
 * holders > 0 ∧ ¬fake; idle otherwise. One role_queue_snapshots row per role per scan; `role.queue.unstaffed` once per
 * (environment, role) transition into unstaffed (never again while it stays there) and `role.staffed` when it leaves it —
 * both on the `role_queue` aggregate (SM_ROLE_QUEUE_UNSTAFFED_1BD's subject); the daily scan ends with
 * `role.queue.scan_completed{scan_run_id, environment, as_of_date, roles}` on the global subject (SM_HANDOVER_BOARD_DAILY).
 * An escalations.owner_role outside HUMAN_ROLES is reported under `not_a_human_role`, never raised. ROLES_QUEUE_SCAN is the
 * runner 35.3's registry row `roles.queue_scan` (daily 06:30 ET, global) invokes; the sweep's re-scan (sweep.ts) covers the
 * roles with open items between the daily runs. Nothing here touches a section's clock (NO_CLOCK_EDIT).
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "../../../infra/db/client.ts";
import { toJson } from "../../../infra/db/client.ts";
import { HUMAN_ROLES } from "../../../app/roles.ts";
import type { Runtime } from "../../../runtime/app.ts";
import { pendingPrefundingHoldRows, pendingTermsReviewRows } from "../../../infra/integrations/reviewers.ts";
import { currentFakeSet, envDefault } from "./env.ts";
import { portsOf, type RolesPorts } from "./ports.ts";
import { latestSnapshots, roleQueueAggregate, type SnapshotRow } from "./snapshots.ts";
import { KERNEL_ROLES, P, SIGNED_IN_DAYS, daysAfter, isKernelRole, s } from "./types.ts";

export type QueueStatus = "staffed" | "fake" | "unstaffed" | "idle";
export interface OpenItem { readonly kind: "escalation" | "orchestration_step" | "terms_review" | "qc_review"; readonly id: string; readonly role: string; readonly opened_at: string | null; readonly loan_id: string | null; readonly application_id: string | null; readonly detail: Record<string, unknown> }
export interface RoleQueueRow { readonly role: string; readonly open_items: number; readonly oldest_opened_at: string | null; readonly holders: readonly string[]; readonly holders_signed_in_30d: number; readonly fake: boolean; readonly status: QueueStatus }
export interface ScanResult { readonly scan_run_id: string; readonly environment: string; readonly as_of_date: string; readonly rows: readonly RoleQueueRow[]; readonly unstaffed_raised: readonly string[]; readonly staffed_raised: readonly string[]; readonly not_a_human_role: readonly { owner_role: string; count: number }[]; readonly completed: boolean }

/** Holders per role: active staff accounts holding the role in roles ∪ reviewer_roles, with whether each signed in within 30 days (`staff.signed_in`). */
export async function holdersByRole(q: Queryable, nowIso: string): Promise<Map<string, { ids: string[]; signed_in_30d: number }>> {
  const since = daysAfter(nowIso, -SIGNED_IN_DAYS);
  const users = await q.query<{ id: string; roles: string[]; reviewer_roles: string[]; signed_in: boolean }>(`SELECT u.id::text AS id, u.roles, u.reviewer_roles, EXISTS (SELECT 1 FROM loan_events e WHERE e.type = 'staff.signed_in' AND e.payload->>'staff_user_id' = u.id::text AND e.occurred_at >= $1::timestamptz AND e.occurred_at <= $2::timestamptz) AS signed_in FROM staff_users u WHERE u.status = 'active' ORDER BY u.created_at, u.id`, [since, nowIso]);
  const out = new Map<string, { ids: string[]; signed_in_30d: number }>();
  for (const r of KERNEL_ROLES) out.set(r, { ids: [], signed_in_30d: 0 });
  for (const u of users) for (const r of new Set([...u.roles, ...u.reviewer_roles])) { const h = out.get(r); if (!h) continue; h.ids.push(u.id); if (u.signed_in) h.signed_in_30d += 1; }
  return out;
}
/** Every open item, by role (rule 5's four sources). `not_a_human_role` collects escalations whose owner is not a kernel role. */
export async function openItems(q: Queryable, ports: Required<RolesPorts>, nowIso: string): Promise<{ items: OpenItem[]; not_a_human_role: { owner_role: string; count: number }[] }> {
  const items: OpenItem[] = []; const nah = new Map<string, number>();
  for (const e of await q.query<{ id: string; kind: string; owner_role: string | null; loan_id: string | null; application_id: string | null; opened_at: string; payload: Record<string, unknown> | null }>(`SELECT id::text AS id, kind, owner_role, loan_id::text AS loan_id, application_id::text AS application_id, opened_at::text AS opened_at, payload FROM escalations WHERE completed_at IS NULL AND opened_at <= $1::timestamptz ORDER BY opened_at, id`, [nowIso])) {
    const role = s(e.owner_role);
    if (!isKernelRole(role)) { nah.set(role || "(none)", (nah.get(role || "(none)") ?? 0) + 1); continue; }
    items.push({ kind: "escalation", id: e.id, role, opened_at: e.opened_at, loan_id: e.loan_id, application_id: e.application_id, detail: { kind: e.kind, command: (e.payload ?? {})["command"] ?? null, timer_code: (e.payload ?? {})["timer_code"] ?? null } });
  }
  for (const st of await ports.orchestrationSteps.waitingHuman(q)) if (isKernelRole(st.role)) items.push({ kind: "orchestration_step", id: `step:${st.application_id ?? "?"}:${st.role}`, role: st.role, opened_at: st.since, loan_id: null, application_id: st.application_id, detail: { source: "35.6 closing_orchestrations", status: "waiting_human" } });
  for (const t of await pendingTermsReviewRows(q, nowIso)) items.push({ kind: "terms_review", id: t.quote_id, role: "mlo_of_record", opened_at: t.requested_at, loan_id: t.loan_id, application_id: t.application_id, detail: { lead_id: t.lead_id, timer: "SM_MLO_PREAPP_TERMS_REVIEW_1BH" } });
  for (const r of await pendingPrefundingHoldRows(q, nowIso)) items.push({ kind: "qc_review", id: r.review_id, role: "qc_officer", opened_at: r.updated_at, loan_id: null, application_id: r.application_id, detail: { status: r.status, timer: "SM_QC_PREFUNDING_HOLD" } });
  return { items, not_a_human_role: [...nah].map(([owner_role, count]) => ({ owner_role, count })) };
}
export const statusOf = (open: number, holders: number, fake: boolean): QueueStatus => (fake ? "fake" : open > 0 && holders === 0 ? "unstaffed" : holders > 0 ? "staffed" : "idle");

/** The rows of rule 5 for every kernel role (or `roles` only), as of `nowIso`, with the environment's current FAKE set. */
export async function queueRows(rt: Runtime, o: { environment: string; now: string; roles?: readonly string[]; ports?: RolesPorts }): Promise<{ rows: RoleQueueRow[]; items: OpenItem[]; not_a_human_role: { owner_role: string; count: number }[]; fake: readonly string[] }> {
  const ports = portsOf(o.ports);
  const fake = await currentFakeSet(rt.db, o.environment, envDefault(rt.env, rt.environment).roles);
  const [holders, open] = await Promise.all([holdersByRole(rt.db, o.now), openItems(rt.db, ports, o.now)]);
  const roles = o.roles ?? KERNEL_ROLES;
  const rows: RoleQueueRow[] = roles.map((role) => {
    const mine = open.items.filter((i) => i.role === role); const h = holders.get(role) ?? { ids: [], signed_in_30d: 0 };
    const oldest = mine.map((i) => i.opened_at).filter((x): x is string => !!x).sort()[0] ?? null;
    const isFake = fake.includes(role);
    return { role, open_items: mine.length, oldest_opened_at: oldest, holders: h.ids, holders_signed_in_30d: h.signed_in_30d, fake: isFake, status: statusOf(mine.length, h.ids.length, isFake) };
  });
  return { rows, items: open.items, not_a_human_role: open.not_a_human_role, fake };
}

export interface ScanOptions { readonly as_of: string; readonly scan_run_id?: string; readonly planned_by: string; readonly roles?: readonly string[]; readonly completion?: boolean; readonly actor?: { kind: "agent" | "system" | "human"; id: string; role?: string } }
/**
 * One scan: the rows written as snapshots, the transitions raised on the `role_queue` aggregates, and — for the daily run —
 * `role.queue.scan_completed` on the global subject. One global unit of work (the events) whose commit writes the rows.
 */
export async function scanRoleQueues(rt: Runtime, o: ScanOptions, ports?: RolesPorts): Promise<ScanResult> {
  const environment = rt.environment; const now = rt.clock.now();
  const p = portsOf(ports);
  const scan_run_id = o.scan_run_id ?? (await p.cycleRuns.openRun(rt.db, { as_of: o.as_of, planned_by: o.planned_by }));
  const { rows, not_a_human_role } = await queueRows(rt, { environment, now, ...(o.roles ? { roles: o.roles } : {}), ...(ports ? { ports } : {}) });
  const prior = await latestSnapshots(rt.db, environment);
  const actor = o.actor ?? { kind: "agent" as const, id: "security-records" };
  const unstaffed_raised: string[] = []; const staffed_raised: string[] = [];
  const completion = o.completion ?? true;
  await rt.uow.run({}, (ctx) => {
    for (const r of rows) {
      const before: SnapshotRow | undefined = prior.get(r.role);
      if (r.status === "unstaffed" && before?.status !== "unstaffed") { unstaffed_raised.push(r.role); ctx.events.append({ type: "role.queue.unstaffed", aggregate: roleQueueAggregate(environment, r.role), actor, payload: P({ environment, role: r.role, detected_at: now, open_items: r.open_items, oldest_opened_at: r.oldest_opened_at, scan_run_id }) }); }
      else if (r.status !== "unstaffed" && before?.status === "unstaffed") { staffed_raised.push(r.role); ctx.events.append({ type: "role.staffed", aggregate: roleQueueAggregate(environment, r.role), actor, payload: P({ environment, role: r.role, staff_user_id: r.holders[0] ?? null, cause: r.fake ? "fake_on" : r.holders.length ? "grant" : "exercised", scan_run_id }) }); }
    }
    if (completion) ctx.events.append({ type: "role.queue.scan_completed", actor, payload: P({ scan_run_id, environment, as_of_date: o.as_of, planned_by: o.planned_by, roles: rows.map((r) => ({ role: r.role, open_items: r.open_items, holders: r.holders.length, fake: r.fake, status: r.status })), not_a_human_role }) });
  }, { clock: rt.clock, commit: async (q) => { await writeSnapshots(q, scan_run_id, environment, o.as_of, rows); } });
  return { scan_run_id, environment, as_of_date: o.as_of, rows, unstaffed_raised, staffed_raised, not_a_human_role, completed: completion };
}
export async function writeSnapshots(q: Queryable, scanRunId: string, environment: string, asOf: string, rows: readonly RoleQueueRow[]): Promise<void> {
  for (const r of rows) await q.query(`INSERT INTO role_queue_snapshots (id, scan_run_id, environment, as_of_date, role, open_items, oldest_opened_at, holders, holders_signed_in_30d, fake, status) VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, $9, $10, $11)`,
    [randomUUID(), scanRunId, environment, asOf, r.role, r.open_items, r.oldest_opened_at, r.holders.length, r.holders_signed_in_30d, r.fake, r.status]);
}
/** Whether the day's daily scan (the completion receipt) already exists for the environment. */
export async function scanCompletedOn(q: Queryable, environment: string, asOf: string): Promise<boolean> {
  return (await q.query(`SELECT 1 FROM loan_events WHERE type = 'role.queue.scan_completed' AND payload->>'environment' = $1 AND payload->>'as_of_date' = $2 LIMIT 1`, [environment, asOf])).length > 0;
}

/** 35.3's unit: `roles.queue_scan` (owner 35.7, security-records, global scope, daily 06:30 ET) — the runner its registry row names. */
export const ROLES_QUEUE_SCAN = {
  code: "roles.queue_scan" as const, owner_process: "35.7" as const, owner_agent: "security-records" as const, unit_scope: "global" as const, receipt_event: "role.queue.scan_completed" as const, serves_timer: "SM_HANDOVER_BOARD_DAILY" as const,
  run: (rt: Runtime, o: { as_of: string; scan_run_id?: string; planned_by: string }, ports?: RolesPorts): Promise<ScanResult> => scanRoleQueues(rt, { as_of: o.as_of, ...(o.scan_run_id ? { scan_run_id: o.scan_run_id } : {}), planned_by: o.planned_by, completion: true }, ports),
};

/** `roles.queue` (read): the latest snapshot per role and the open items of one role (paged). */
export async function roleQueue(rt: Runtime, o: { environment?: string | null; role?: string | null; page?: number; page_size?: number; ports?: RolesPorts }): Promise<Record<string, unknown>> {
  const environment = o.environment || rt.environment; const now = rt.clock.now();
  const latest = await latestSnapshots(rt.db, environment);
  const live = await queueRows(rt, { environment, now, ...(o.ports ? { ports: o.ports } : {}) });
  const roles = (o.role ? [o.role] : KERNEL_ROLES).map((role) => {
    const snap = latest.get(role); const cur = live.rows.find((r) => r.role === role)!;
    return { role, status: snap?.status ?? cur.status, open_items: snap?.open_items ?? cur.open_items, oldest_opened_at: snap?.oldest_opened_at ?? cur.oldest_opened_at, holders: snap?.holders ?? cur.holders.length, holders_signed_in_30d: snap?.holders_signed_in_30d ?? cur.holders_signed_in_30d, fake: snap?.fake ?? cur.fake, scan_run_id: snap?.scan_run_id ?? null, as_of_date: snap?.as_of_date ?? null, live: { status: cur.status, open_items: cur.open_items, holders: cur.holders.length } };
  });
  const size = Math.min(Math.max(Number(o.page_size ?? 100) || 100, 1), 100); const page = Math.max(Number(o.page ?? 1) || 1, 1);
  const items = o.role ? live.items.filter((i) => i.role === o.role) : live.items;
  return { environment, as_of: now, roles, not_a_human_role: live.not_a_human_role, fake: live.fake, items: items.slice((page - 1) * size, page * size).map((i) => ({ kind: i.kind, id: i.id, role: i.role, opened_at: i.opened_at, loan_id: i.loan_id, application_id: i.application_id, detail: i.detail })), page, page_size: size, total_items: items.length };
}
export const rolesJson = (v: unknown): string => toJson(v);
export const ALL_ROLES: readonly string[] = HUMAN_ROLES;
