/**
 * §35.7 rules 6–7 — the handover is two people's decision, one role at a time. `handover.plan` lists, per role: holders,
 * holders signed in within 30 days, open items and the oldest, whether a FAKE fills it and what is missing
 * (HANDOVER_NEEDS_HOLDER{missing: holder | signed_in_30d}); it writes a role_handovers{planned} row per role and
 * `handover.planned`. `handover.enable{op: request}` (compliance) writes {requested, request_id, expires_at + 10 min};
 * `{op: confirm, request_id}` by a DIFFERENT admin within 10 minutes (TWO_PERSON_HANDOVER when the confirmer is the requester —
 * checked before the role; HANDOVER_NEEDS_HOLDER when the plan's test fails at confirmation) writes {enabled, requested_by,
 * confirmed_by, holders, pending_items} and `handover.enabled` — from that instant the FAKE stops filling the role (the
 * reviewers read the current set from Postgres per tick, env.ts); in production the only state is `person`, so the
 * confirmation is a no-op that records the holders. `{op: revert}` exists outside production only (NO_FAKE_IN_PRODUCTION) and
 * needs the same two people. The expiry of an unconfirmed request is the sweep's (sweep.ts). Enabling a role satisfies
 * nothing and arms nothing; the queue scan does the measuring. `handover.board` (read) is the 35.8 screen's contract:
 * twenty-two rows of ids, dates, counts and codes — never a name, an e-mail, a phone or a token.
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "../../../infra/db/client.ts";
import { toJson } from "../../../infra/db/client.ts";
import type { Actor } from "../../../kernel/events/index.ts";
import { wallClock } from "../../../kernel/calendar/zoned.ts";
import type { Runtime } from "../../../runtime/app.ts";
import type { StaffActDeps } from "../../../runtime/staff/auth.ts";
import { requireActiveStaff } from "./actors.ts";
import { dormantGrants } from "./cascade.ts";
import { currentFakeSet, enabledHandovers, envDefault, type FakeReason } from "./env.ts";
import { decisionIdOf } from "./grants.ts";
import type { RolesPorts } from "./ports.ts";
import { queueRows, type RoleQueueRow } from "./queue.ts";
import { RolesRefused } from "./refusals.ts";
import { CONFIRM_MINUTES, ET, KERNEL_ROLES, P, isKernelRole, isProduction, isUuid, minutesAfter, s } from "./types.ts";

export type HandoverMissing = "holder" | "signed_in_30d";
export interface PlanRow extends RoleQueueRow { readonly plan: "ready" | "HANDOVER_NEEDS_HOLDER"; readonly missing: HandoverMissing | null }
export interface HandoverRow { readonly id: string; readonly environment: string; readonly role: string; readonly action: string; readonly request_id: string | null; readonly requested_by: string | null; readonly confirmed_by: string | null; readonly holders: string[]; readonly pending_items: number | null; readonly rationale: string | null; readonly effective_at: string; readonly expires_at: string | null; readonly created_at: string }
const H_COLS = `id::text AS id, environment, role, action, request_id::text AS request_id, requested_by::text AS requested_by, confirmed_by::text AS confirmed_by, holders, pending_items, rationale, effective_at::text AS effective_at, expires_at::text AS expires_at, created_at::text AS created_at`;
const nameOf = (a: Actor): string => (a.kind === "human" ? a.id : `${a.kind}:${a.id}`);
const handoverAggregate = (environment: string, role: string): { kind: string; id: string } => ({ kind: "handover", id: `${environment}:${role}` });

/** The plan's test per role (rule 7): a holder who signed in within 30 days. */
export const planOf = (r: RoleQueueRow): { plan: "ready" | "HANDOVER_NEEDS_HOLDER"; missing: HandoverMissing | null } => (!r.holders.length ? { plan: "HANDOVER_NEEDS_HOLDER", missing: "holder" } : r.holders_signed_in_30d === 0 ? { plan: "HANDOVER_NEEDS_HOLDER", missing: "signed_in_30d" } : { plan: "ready", missing: null });
export async function planRows(rt: Runtime, environment: string, ports?: RolesPorts): Promise<PlanRow[]> {
  const { rows } = await queueRows(rt, { environment, now: rt.clock.now(), ...(ports ? { ports } : {}) });
  return rows.map((r) => ({ ...r, ...planOf(r) }));
}
async function writeHandoverRow(q: Queryable, r: { id?: string; environment: string; role: string; action: string; request_id: string | null; requested_by: string | null; confirmed_by: string | null; holders: readonly string[]; pending_items: number | null; rationale: string | null; effective_at: string; expires_at: string | null; decision?: { kind: string; id: string } | null }): Promise<string> {
  const id = r.id ?? randomUUID();
  const decision_id = r.decision ? await decisionIdOf(q, r.decision.kind, r.decision.id) : null;
  await q.query(`INSERT INTO role_handovers (id, environment, role, action, request_id, requested_by, confirmed_by, holders, pending_items, rationale, decision_id, effective_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13)`,
    [id, r.environment, r.role, r.action, r.request_id, r.requested_by, r.confirmed_by, toJson(r.holders), r.pending_items, r.rationale, decision_id, r.effective_at, r.expires_at]);
  return id;
}
export async function handoverRequest(q: Queryable, requestId: string): Promise<{ request: HandoverRow; resolved: HandoverRow | null } | undefined> {
  if (!isUuid(requestId)) return undefined;
  const rows = await q.query<HandoverRow & Record<string, unknown>>(`SELECT ${H_COLS} FROM role_handovers WHERE request_id = $1 ORDER BY created_at, id`, [requestId]);
  const request = rows.find((r) => r.action === "requested"); if (!request) return undefined;
  return { request, resolved: rows.find((r) => r.action === "enabled" || r.action === "expired" || r.action === "reverted") ?? null };
}
export async function staleHandoverRequests(q: Queryable, nowIso: string): Promise<HandoverRow[]> {
  return q.query<HandoverRow & Record<string, unknown>>(`SELECT ${H_COLS} FROM role_handovers r WHERE r.action = 'requested' AND r.expires_at <= $1::timestamptz AND NOT EXISTS (SELECT 1 FROM role_handovers x WHERE x.request_id = r.request_id AND x.action IN ('enabled', 'expired', 'reverted')) ORDER BY r.expires_at`, [nowIso]);
}
export const expireHandoverRow = (q: Queryable, r: HandoverRow, nowIso: string): Promise<string> => writeHandoverRow(q, { environment: r.environment, role: r.role, action: "expired", request_id: r.request_id, requested_by: r.requested_by, confirmed_by: null, holders: r.holders, pending_items: r.pending_items, rationale: `no admin confirmation within ${CONFIRM_MINUTES} minutes (35.7 rule 7)`, effective_at: nowIso, expires_at: r.expires_at });
export const handoverExpiredEvent = (r: HandoverRow, nowIso: string) => ({ type: "handover.request.expired", aggregate: handoverAggregate(r.environment, r.role), actor: { kind: "system" as const, id: "roles-35-7" }, payload: P({ request_id: r.request_id, environment: r.environment, role: r.role, requested_by: r.requested_by, requested_at: r.effective_at, expires_at: r.expires_at, expired_at: nowIso }) });

export interface PlanResult { readonly environment: string; readonly as_of: string; readonly plan_id: string; readonly roles: readonly (PlanRow & { holders: readonly string[] })[]; readonly by: string }
/** `handover.plan` (compliance | admin). */
export async function handoverPlan(d: StaffActDeps, i: { environment: string; ports?: RolesPorts }): Promise<PlanResult> {
  const rt = d.runtime;
  await requireActiveStaff(d.db, d.actor, ["compliance", "admin"], "handover.plan", i.environment);
  const rows = await planRows(rt, i.environment, i.ports);
  const as_of = wallClock(Date.parse(d.now), ET).date; const plan_id = `${i.environment}:plan:${as_of}`;
  d.deferWrite(async (q) => { for (const r of rows) await writeHandoverRow(q, { environment: i.environment, role: r.role, action: "planned", request_id: null, requested_by: isUuid(d.actor.id) ? d.actor.id : null, confirmed_by: null, holders: r.holders, pending_items: r.open_items, rationale: r.plan === "ready" ? "ready" : `HANDOVER_NEEDS_HOLDER{missing: ${r.missing}}`, effective_at: d.now, expires_at: null, decision: { kind: "handover", id: plan_id } }); });
  d.events.append({ type: "handover.planned", aggregate: { kind: "handover", id: plan_id }, actor: d.actor, payload: P({ environment: i.environment, as_of_date: as_of, by: nameOf(d.actor), roles: rows.map((r) => ({ role: r.role, plan: r.plan, missing: r.missing, holders: r.holders.length, holders_signed_in_30d: r.holders_signed_in_30d, open_items: r.open_items, fake: r.fake })) }) });
  return { environment: i.environment, as_of, plan_id, roles: rows, by: nameOf(d.actor) };
}

export interface EnableInput { readonly op: "request" | "confirm" | "revert"; readonly environment: string; readonly role?: string | null; readonly request_id?: string | null; readonly rationale?: string | null; readonly ports?: RolesPorts }
export interface EnableResult { readonly status: "requested" | "enabled" | "already_enabled" | "reverted" | "recorded"; readonly environment: string; readonly role: string; readonly request_id: string | null; readonly requested_by: string | null; readonly confirmed_by: string | null; readonly holders: readonly string[]; readonly pending_items: number | null; readonly expires_at?: string; readonly effective_at: string; readonly by: string }
/** `handover.enable` — request (compliance), confirm (a different admin, within 10 minutes), revert (nonprod only, the same two people). */
export async function handoverEnable(d: StaffActDeps, i: EnableInput): Promise<EnableResult> {
  const rt = d.runtime; const what = `handover.enable:${i.op}`;
  if (i.op === "request" || i.op === "revert") {
    const role = s(i.role);
    if (!isKernelRole(role)) throw new RolesRefused(409, "UNKNOWN_ROLE", `${what}: ${role || "(none)"} is not one of the kernel's human roles`, { role });
    if (i.op === "revert") return revert(d, { environment: i.environment, role, rationale: i.rationale ?? null });
    const requester = await requireActiveStaff(d.db, d.actor, ["compliance"], what, i.environment);
    const plan = (await planRows(rt, i.environment, i.ports)).find((r) => r.role === role)!;
    if (plan.plan !== "ready") throw new RolesRefused(409, "HANDOVER_NEEDS_HOLDER", `${role} in ${i.environment} has no holder who signed in within 30 days (missing: ${plan.missing})`, { role, missing: plan.missing, holders: plan.holders });
    const enabled = await enabledHandovers(d.db, i.environment);
    if (enabled.has(role)) return { status: "already_enabled", environment: i.environment, role, request_id: null, requested_by: null, confirmed_by: null, holders: plan.holders, pending_items: plan.open_items, effective_at: enabled.get(role)!, by: nameOf(d.actor) };
    const request_id = randomUUID(); const expires_at = minutesAfter(d.now, CONFIRM_MINUTES);
    d.deferWrite(async (q) => { await writeHandoverRow(q, { environment: i.environment, role, action: "requested", request_id, requested_by: requester.fake ? null : requester.id, confirmed_by: null, holders: plan.holders, pending_items: plan.open_items, rationale: (typeof i.rationale === "string" && i.rationale.trim()) || null, effective_at: d.now, expires_at, decision: { kind: "handover", id: `${i.environment}:${role}` } }); });
    d.events.append({ type: "handover.requested", aggregate: handoverAggregate(i.environment, role), actor: d.actor, payload: P({ request_id, environment: i.environment, role, by: nameOf(d.actor), expires_at, holders: plan.holders }) });
    return { status: "requested", environment: i.environment, role, request_id, requested_by: nameOf(d.actor), confirmed_by: null, holders: plan.holders, pending_items: plan.open_items, expires_at, effective_at: d.now, by: nameOf(d.actor) };
  }
  // confirm — the order of rule 7 / C12: the request, the two-person check, the confirmer's role, the plan's test
  const found = await handoverRequest(d.db, s(i.request_id));
  if (!found) throw new RolesRefused(404, "REQUEST_NOT_FOUND", `no handover request ${s(i.request_id) || "(none)"}`, { request_id: i.request_id ?? null });
  const { request, resolved } = found;
  if (resolved?.action === "enabled") return { status: "already_enabled", environment: request.environment, role: request.role, request_id: request.request_id, requested_by: request.requested_by, confirmed_by: resolved.confirmed_by, holders: resolved.holders, pending_items: resolved.pending_items, effective_at: resolved.effective_at, by: nameOf(d.actor) };
  if (resolved || Date.parse(request.expires_at ?? "") <= Date.parse(d.now)) {
    // the refusal persists nothing of this command; the sweep's stale-request pass writes the expired row and `handover.request.expired` (rolesSweepPass)
    throw new RolesRefused(409, "REQUEST_EXPIRED", `handover request ${request.request_id} expired at ${request.expires_at}; the FAKE still fills ${request.role}`, { request_id: request.request_id, expires_at: request.expires_at });
  }
  if (d.actor.kind === "human" && request.requested_by === d.actor.id) throw new RolesRefused(403, "TWO_PERSON_HANDOVER", `the handover of ${request.role} is two people's decision: ${d.actor.id} requested it and may not confirm it (35.7 rule 7)`, { request_id: request.request_id, role: request.role });
  const confirmer = await requireActiveStaff(d.db, d.actor, ["admin"], what, request.environment);
  const plan = (await planRows(rt, request.environment, i.ports)).find((r) => r.role === request.role)!;
  if (plan.plan !== "ready") throw new RolesRefused(409, "HANDOVER_NEEDS_HOLDER", `${request.role} in ${request.environment} has no holder who signed in within 30 days at confirmation (missing: ${plan.missing})`, { role: request.role, missing: plan.missing, request_id: request.request_id });
  const production = isProduction(request.environment);
  d.deferWrite(async (q) => { await writeHandoverRow(q, { environment: request.environment, role: request.role, action: "enabled", request_id: request.request_id, requested_by: request.requested_by, confirmed_by: confirmer.fake ? null : confirmer.id, holders: plan.holders, pending_items: plan.open_items, rationale: production ? "production: the only state is person (35.7 rule 6); the holders are recorded" : (request.rationale ?? null), effective_at: d.now, expires_at: null, decision: { kind: "handover", id: `${request.environment}:${request.role}` } }); });
  d.events.append({ type: "handover.enabled", aggregate: handoverAggregate(request.environment, request.role), actor: d.actor, payload: P({ request_id: request.request_id, environment: request.environment, role: request.role, by: request.requested_by, confirmed_by: nameOf(d.actor), holders: plan.holders, pending_items: plan.open_items, production }) });
  return { status: production ? "recorded" : "enabled", environment: request.environment, role: request.role, request_id: request.request_id, requested_by: request.requested_by, confirmed_by: nameOf(d.actor), holders: plan.holders, pending_items: plan.open_items, effective_at: d.now, by: nameOf(d.actor) };
}
async function revert(d: StaffActDeps, i: { environment: string; role: string; rationale: string | null }): Promise<EnableResult> {
  if (isProduction(i.environment)) throw new RolesRefused(409, "NO_FAKE_IN_PRODUCTION", `handover.revert does not exist in production: the FAKE set is empty there (35.7 rule 6)`, { environment: i.environment, role: i.role });
  const person = await requireActiveStaff(d.db, d.actor, ["compliance", "admin"], "handover.enable:revert", i.environment);
  const rows = await d.db.query<HandoverRow & Record<string, unknown>>(`SELECT ${H_COLS} FROM role_handovers WHERE environment = $1 AND role = $2 AND action IN ('enabled', 'reverted') ORDER BY created_at DESC, id DESC LIMIT 1`, [i.environment, i.role]);
  const last = rows[0];
  if (!last || last.action !== "enabled") throw new RolesRefused(409, "NOT_ENABLED", `${i.role} in ${i.environment} is not handed over; nothing to revert`, { role: i.role });
  const two = [last.requested_by, last.confirmed_by].filter((x): x is string => !!x);
  if (!person.fake && !two.includes(person.id)) throw new RolesRefused(403, "TWO_PERSON_HANDOVER", `the revert of ${i.role} is the same two people's (${two.join(", ")}) — ${person.id} was neither`, { role: i.role, requested_by: last.requested_by, confirmed_by: last.confirmed_by });
  const holders = (await planRows(d.runtime, i.environment)).find((r) => r.role === i.role)?.holders ?? [];
  d.deferWrite(async (q) => { await writeHandoverRow(q, { environment: i.environment, role: i.role, action: "reverted", request_id: last.request_id, requested_by: last.requested_by, confirmed_by: last.confirmed_by, holders, pending_items: null, rationale: i.rationale, effective_at: d.now, expires_at: null, decision: { kind: "handover", id: `${i.environment}:${i.role}` } }); });
  d.events.append({ type: "handover.reverted", aggregate: handoverAggregate(i.environment, i.role), actor: d.actor, payload: P({ environment: i.environment, role: i.role, by: last.requested_by, confirmed_by: last.confirmed_by, reverted_by: nameOf(d.actor), rationale: i.rationale }) });
  return { status: "reverted", environment: i.environment, role: i.role, request_id: last.request_id, requested_by: last.requested_by, confirmed_by: last.confirmed_by, holders, pending_items: null, effective_at: d.now, by: nameOf(d.actor) };
}

export interface BoardRow { readonly role: string; readonly status: string; readonly holders: readonly string[]; readonly holders_signed_in_30d: number; readonly dormant_grants: readonly { grant_id: string; staff_user_id: string }[]; readonly fake: boolean; readonly fake_since: string | null; readonly fake_reason: FakeReason; readonly open_items: number; readonly oldest_opened_at: string | null; readonly last_exercised_at: string | null; readonly fake_approvals_today: number; readonly plan: "ready" | "HANDOVER_NEEDS_HOLDER"; readonly missing: HandoverMissing | null }
export interface Board { readonly environment: string; readonly as_of: string; readonly fake_default: readonly string[]; readonly fake_current: readonly string[]; readonly fake_reason: FakeReason; readonly roles: readonly BoardRow[]; readonly not_a_human_role: readonly { owner_role: string; count: number }[]; readonly go_live: readonly { role: string; missing: readonly string[] }[]; readonly scan: { scan_run_id: string | null; as_of_date: string | null } }
/** `handover.board` (read): the 35.8 contract — twenty-two rows of ids, dates, counts and codes. */
export async function handoverBoard(rt: Runtime, o: { environment?: string | null; ports?: RolesPorts }): Promise<Board> {
  const environment = o.environment || rt.environment; const now = rt.clock.now(); const as_of = wallClock(Date.parse(now), ET).date;
  const dflt = envDefault(rt.env, rt.environment);
  const [live, enabled, dormant] = await Promise.all([queueRows(rt, { environment, now, ...(o.ports ? { ports: o.ports } : {}) }), enabledHandovers(rt.db, environment), dormantGrants(rt.db, environment)]);
  const current = await currentFakeSet(rt.db, environment, dflt.roles);
  const exercised = new Map((await rt.db.query<{ role: string; at: string }>(`SELECT payload->>'role' AS role, max(occurred_at)::text AS at FROM loan_events WHERE type = 'role.exercised' AND payload->>'environment' = $1 GROUP BY payload->>'role'`, [environment])).map((r) => [r.role, r.at]));
  const approvals = new Map((await rt.db.query<{ role: string; n: string }>(`SELECT payload->>'role' AS role, count(*)::text AS n FROM loan_events WHERE type = 'fake_reviewer.approved' AND payload->>'as_of_date' = $1 AND coalesce(payload->>'environment', $2) = $2 GROUP BY payload->>'role'`, [as_of, environment])).map((r) => [r.role, Number(r.n)]));
  const latest = (await rt.db.query<{ scan_run_id: string; as_of_date: string }>(`SELECT scan_run_id::text AS scan_run_id, as_of_date::text AS as_of_date FROM role_queue_snapshots WHERE environment = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [environment]))[0] ?? null;
  const roles: BoardRow[] = live.rows.map((r) => {
    const p = planOf(r); const isFake = current.includes(r.role);
    return { role: r.role, status: r.status, holders: r.holders, holders_signed_in_30d: r.holders_signed_in_30d, dormant_grants: dormant.filter((g) => g.role === r.role).map((g) => ({ grant_id: g.grant_id, staff_user_id: g.staff_user_id })), fake: isFake, fake_since: enabled.get(r.role) ?? null, fake_reason: isFake ? null : dflt.roles.includes(r.role) ? null : dflt.reason, open_items: r.open_items, oldest_opened_at: r.oldest_opened_at, last_exercised_at: exercised.get(r.role) ?? null, fake_approvals_today: approvals.get(r.role) ?? 0, plan: p.plan, missing: p.missing };
  });
  return { environment, as_of, fake_default: dflt.roles, fake_current: current, fake_reason: dflt.reason, roles, not_a_human_role: live.not_a_human_role, go_live: roles.filter((r) => r.plan !== "ready").map((r) => ({ role: r.role, missing: r.missing ? [r.missing] : [] })), scan: latest ? { scan_run_id: latest.scan_run_id, as_of_date: latest.as_of_date } : { scan_run_id: null, as_of_date: null } };
}
export const BOARD_ROLES: readonly string[] = KERNEL_ROLES;
