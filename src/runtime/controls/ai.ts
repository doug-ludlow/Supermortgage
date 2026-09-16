/**
 * 34.4 rule 4 — the AI systems and the kill switch. The view: every `ai_systems` row with its `ai_system_versions`, the
 * latest `ai_evaluations` per version, and the kill-switch state; plus the agent registry's agents (the bus's AI-off state,
 * their tier). The kill switch is two people's decision:
 *
 *   request  — a `compliance` session names the system code, trip | reset and the reason → `ai.kill_switch.requested{request_id,
 *              code, action, reason, by, expires_at}` (loan_events, append-only; nothing trips).
 *   confirm  — an `admin` session, a DIFFERENT staff user, names the same request id within 10 minutes → 18.1's trip / reset:
 *              the feature flag `<code>.enabled = false | true` (what the borrower turn reads on every message — 32.16 T10 /
 *              T-17-10: `bypassed()` in src/runtime/borrower/agent/turn.ts) and the registry's AI-off state for the agent
 *              (`runtime.agents.setAiOff` — the bus refuses the agent's commands with AI_OFF), then
 *              `ai.kill_switch.tripped | reset{code, request_id, by, confirmed_by, reason}` with both actors.
 *   expiry   — a request not confirmed within 10 minutes expires: `ai.kill_switch.request.expired{request_id}` is logged when the
 *              late confirmation arrives or the view runs (`expireKillSwitchRequests`); nothing trips.
 *
 * A refusal's extra never carries a key named `code` (the console spreads the extra beside the refusal code on the wire — src/console/server.ts
 * `refuse`): the system code rides as `system_code`.
 * TWO_PERSON_KILL: the confirmer may not be the requester; a request from any role but compliance, a confirmation from any role
 * but admin, is ROLE_REQUIRED. State is derived from the events (the newest tripped / reset per code) — the platform keeps no
 * ai_kill_switches table (db/migrations/0130); the flag and the registry are the levers 18.1's consumers read.
 * A switch tripped for more than 24 hours opens (once) a `compliance` escalation (`escalateLongTrips`, the paragraph's rule).
 */
import { randomUUID } from "node:crypto";
import type { Actor } from "../../kernel/events/index.ts";
import type { Runtime } from "../app.ts";
import { ControlsRefused, appendEvent, minutesAfter, requireStaffRole, s, type Row } from "./common.ts";

export const KILL_CONFIRM_MINUTES = 10;
export const KILL_REQUEST_ROLES: readonly string[] = ["compliance"];
export const KILL_CONFIRM_ROLES: readonly string[] = ["admin"];
export const LONG_TRIP_HOURS = 24;
export type KillAction = "trip" | "reset";

export interface KillSwitchState { readonly code: string; readonly state: "armed" | "tripped"; readonly tripped_at: string | null; readonly by: string | null; readonly confirmed_by: string | null; readonly reason: string | null; readonly request_id: string | null; readonly flag: boolean | null; readonly ai_off: string | null; readonly history: readonly { type: string; at: string; by: string | null; confirmed_by: string | null; reason: string | null; request_id: string | null }[]; }
export interface KillRequest { readonly request_id: string; readonly code: string; readonly action: KillAction; readonly reason: string; readonly by: string; readonly by_role: string | null; readonly requested_at: string; readonly expires_at: string; readonly status: "pending" | "confirmed" | "expired"; readonly confirmed_by: string | null; readonly resolved_at: string | null; }
export interface AiSystemView { readonly code: string; readonly name: string | null; readonly kind: string | null; readonly risk_tier: string | null; readonly owner_role: string | null; readonly status: string | null; readonly model_version: string | null; readonly prompt_version: string | null; readonly deployed_at: string | null; readonly retired_at: string | null; readonly agent_package: string | null; readonly consumer_facing: boolean | null; readonly row: Row | null; readonly versions: readonly (Row & { evaluations: readonly Row[] })[]; readonly kill_switch: KillSwitchState; readonly pending_request: KillRequest | null; readonly registry_agent: { tier: string; off: boolean; why: string | null } | null; }
export interface AiView { readonly as_of: string; readonly systems: readonly AiSystemView[]; readonly agents: readonly { agent: string; tier: string; off: boolean; why: string | null; processes: readonly string[]; kill_switch: KillSwitchState; pending_request: KillRequest | null }[]; readonly requests: readonly KillRequest[]; readonly expired_now: number; }

const flagKey = (code: string): string => `${code}.enabled`;
const registryAgent = (rt: Runtime, code: string): { tier: string; off: boolean; why: string | null } | null => {
  if (!rt.agents.agents().some((a) => a.agent === code)) return null;
  const st = rt.agents.aiState(code); return { tier: st.tier, off: st.off, why: st.why ?? null };
};

/** The switch for one code: the newest tripped / reset event, the flag, the registry's AI-off state, the whole history. */
export async function killSwitchState(rt: Runtime, code: string): Promise<KillSwitchState> {
  const hist = await rt.db.query<{ type: string; at: string; payload: Row }>(`SELECT type, occurred_at::text AS at, payload FROM loan_events WHERE type IN ('ai.kill_switch.tripped', 'ai.kill_switch.reset') AND payload->>'code' = $1 ORDER BY sequence`, [code]);
  const flag = (await rt.db.query<{ value: unknown }>(`SELECT value FROM feature_flags WHERE key = $1`, [flagKey(code)]))[0];
  const last = hist[hist.length - 1] ?? null;
  const flagValue = flag ? !(flag.value === false || flag.value === "false") : null;
  const tripped = last ? last.type === "ai.kill_switch.tripped" : flagValue === false;
  const reg = registryAgent(rt, code);
  return { code, state: tripped ? "tripped" : "armed", tripped_at: tripped && last ? last.at : null, by: last ? s(last.payload["by"]) || null : null, confirmed_by: last ? s(last.payload["confirmed_by"]) || null : null, reason: last ? s(last.payload["reason"]) || null : null, request_id: last ? s(last.payload["request_id"]) || null : null,
    flag: flagValue, ai_off: reg?.off ? reg.why ?? "AI path off" : null, history: hist.map((h) => ({ type: h.type, at: h.at, by: s(h.payload["by"]) || null, confirmed_by: s(h.payload["confirmed_by"]) || null, reason: s(h.payload["reason"]) || null, request_id: s(h.payload["request_id"]) || null })) };
}

/** Every kill-switch request with its resolution (confirmed | expired | pending at `now`). */
export async function killRequests(rt: Runtime, f: { code?: string | null; status?: KillRequest["status"] | "all" | null; limit?: number } = {}, nowIso: string = rt.clock.now()): Promise<KillRequest[]> {
  const rows = await rt.db.query<{ payload: Row; at: string; resolution: Row | null; resolved_at: string | null; resolved_type: string | null }>(`SELECT r.payload, r.occurred_at::text AS at, x.payload AS resolution, x.occurred_at::text AS resolved_at, x.type AS resolved_type
    FROM loan_events r LEFT JOIN LATERAL (SELECT e.payload, e.occurred_at, e.type FROM loan_events e WHERE e.type IN ('ai.kill_switch.tripped', 'ai.kill_switch.reset', 'ai.kill_switch.request.expired') AND e.payload->>'request_id' = r.payload->>'request_id' ORDER BY e.sequence LIMIT 1) x ON true
    WHERE r.type = 'ai.kill_switch.requested' ${f.code ? "AND r.payload->>'code' = $1" : ""} ORDER BY r.sequence DESC LIMIT ${Math.min(Math.max(Number(f.limit ?? 200) || 200, 1), 2000)}`, f.code ? [f.code] : []);
  const out = rows.map((r): KillRequest => {
    const p = r.payload; const expiresAt = s(p["expires_at"]);
    const status: KillRequest["status"] = r.resolved_type === "ai.kill_switch.request.expired" ? "expired" : r.resolved_type ? "confirmed" : Date.parse(nowIso) > Date.parse(expiresAt) ? "expired" : "pending";
    return { request_id: s(p["request_id"]), code: s(p["code"]), action: s(p["action"]) as KillAction, reason: s(p["reason"]), by: s(p["by"]), by_role: s(p["by_role"]) || null, requested_at: r.at, expires_at: expiresAt, status, confirmed_by: r.resolution ? s(r.resolution["confirmed_by"]) || null : null, resolved_at: r.resolved_at };
  });
  return f.status && f.status !== "all" ? out.filter((r) => r.status === f.status) : out;
}

/** The edge case: a request the admin never confirmed expires at 10 minutes — logged once, nothing trips. Returns how many expired on this pass. */
export async function expireKillSwitchRequests(rt: Runtime, nowIso: string = rt.clock.now()): Promise<number> {
  const stale = (await killRequests(rt, { status: "expired" }, nowIso)).filter((r) => r.resolved_at === null);
  for (const r of stale) await appendEvent(rt.db, { type: "ai.kill_switch.request.expired", actor: { kind: "system", id: "controls" }, occurred_at: nowIso, payload: { request_id: r.request_id, code: r.code, action: r.action, requested_by: r.by, requested_at: r.requested_at, expires_at: r.expires_at, expired_at: nowIso, reason: `no admin confirmation within ${KILL_CONFIRM_MINUTES} minutes (34.4 rule 4); nothing ${r.action === "trip" ? "tripped" : "reset"}` } });
  return stale.length;
}

/** The paragraph's escalation: a switch tripped more than 24 hours opens (once per trip) a `compliance` escalation. */
export async function escalateLongTrips(rt: Runtime, nowIso: string = rt.clock.now()): Promise<string[]> {
  const codes = await knownCodes(rt); const opened: string[] = [];
  for (const code of codes) {
    const st = await killSwitchState(rt, code);
    if (st.state !== "tripped" || !st.tripped_at || Date.parse(nowIso) - Date.parse(st.tripped_at) < LONG_TRIP_HOURS * 3_600_000) continue;
    const dup = await rt.db.query<{ id: string }>(`SELECT id::text AS id FROM escalations WHERE payload->>'code' = 'KILL_SWITCH_TRIPPED_24H' AND payload->>'system_code' = $1 AND payload->>'request_id' = $2 LIMIT 1`, [code, st.request_id ?? ""]);
    if (dup.length) continue;
    const id = randomUUID();
    await rt.db.tx(async (q) => {
      await rt.escalationRepo.save({ id, kind: "sev2", ownerRole: "compliance", severity: "2", openedAt: nowIso, openedBy: "system:controls", status: "open", payload: { code: "KILL_SWITCH_TRIPPED_24H", system_code: code, tripped_at: st.tripped_at, request_id: st.request_id, by: st.by, confirmed_by: st.confirmed_by, reason: `${code} has been tripped since ${st.tripped_at} (> ${LONG_TRIP_HOURS} hours); compliance decides whether it stays off` } }, q);
      await appendEvent(q, { type: "escalation.created", actor: { kind: "system", id: "controls" }, aggregate: { kind: "escalation", id }, occurred_at: nowIso, payload: { escalation_id: id, kind: "sev2", owner_role: "compliance", severity: "2", code: "KILL_SWITCH_TRIPPED_24H", system_code: code, tripped_at: st.tripped_at } });
    });
    opened.push(id);
  }
  return opened;
}

async function knownCodes(rt: Runtime): Promise<string[]> {
  const rows = await rt.db.query<{ code: string }>(`SELECT code FROM ai_systems ORDER BY code`);
  return [...new Set([...rows.map((r) => r.code), ...rt.agents.agents().map((a) => a.agent)])];
}

/** `GET /ops/api/controls/ai` — the systems, versions, latest evaluations and the kill-switch state; expires stale requests as it runs. */
export async function aiView(rt: Runtime, nowIso: string = rt.clock.now()): Promise<AiView> {
  const expired = await expireKillSwitchRequests(rt, nowIso);
  const systems = await rt.db.query<{ row: Row }>(`SELECT to_jsonb(a) AS row FROM ai_systems a ORDER BY a.code`);
  const versions = await rt.db.query<{ system_code: string; row: Row; evaluations: Row[] }>(`SELECT v.system_code, to_jsonb(v) AS row, coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.run_at DESC) FROM (SELECT * FROM ai_evaluations e WHERE e.version_id = v.id ORDER BY e.run_at DESC LIMIT 5) e), '[]'::jsonb) AS evaluations FROM ai_system_versions v ORDER BY v.system_code, v.approved_at DESC NULLS LAST, v.version`);
  const requests = await killRequests(rt, {}, nowIso);
  const pending = (code: string): KillRequest | null => requests.find((r) => r.code === code && r.status === "pending") ?? null;
  const out: AiSystemView[] = [];
  for (const { row } of systems) {
    const code = s(row["code"]);
    out.push({ code, name: s(row["name"]) || null, kind: s(row["kind"]) || null, risk_tier: s(row["risk_tier"]) || null, owner_role: s(row["owner_role"]) || null, status: s(row["status"]) || null, model_version: s(row["model_version"]) || null, prompt_version: s(row["prompt_version"]) || null, deployed_at: s(row["deployed_at"]) || null, retired_at: s(row["retired_at"]) || null, agent_package: s(row["agent_package"]) || null, consumer_facing: typeof row["consumer_facing"] === "boolean" ? row["consumer_facing"] : null,
      row, versions: versions.filter((v) => v.system_code === code).map((v) => ({ ...v.row, evaluations: v.evaluations })), kill_switch: await killSwitchState(rt, code), pending_request: pending(code), registry_agent: registryAgent(rt, code) });
  }
  const agents: { agent: string; tier: string; off: boolean; why: string | null; processes: readonly string[]; kill_switch: KillSwitchState; pending_request: KillRequest | null }[] = [];
  for (const a of rt.agents.agents()) { const st = rt.agents.aiState(a.agent); agents.push({ agent: a.agent, tier: st.tier, off: st.off, why: st.why ?? null, processes: a.processes, kill_switch: await killSwitchState(rt, a.agent), pending_request: pending(a.agent) }); }
  return { as_of: nowIso, systems: out, agents, requests, expired_now: expired };
}

/** Step one: `compliance` asks. Nothing trips; the request expires in 10 minutes. */
export async function requestKillSwitch(rt: Runtime, i: { code: string; action: KillAction; reason: string; actor: Actor }, nowIso: string = rt.clock.now()): Promise<KillRequest> {
  await requireStaffRole(rt.db, i.actor, KILL_REQUEST_ROLES, `requesting the kill switch (${i.action})`);
  const code = (i.code ?? "").trim(); const reason = (i.reason ?? "").trim();
  if (i.action !== "trip" && i.action !== "reset") throw new ControlsRefused(400, "BAD_ACTION", "action is trip or reset");
  if (!code) throw new ControlsRefused(400, "CODE_REQUIRED", "the system code is required");
  if (!(await knownCodes(rt)).includes(code)) throw new ControlsRefused(404, "UNKNOWN_SYSTEM", `${code} is neither an ai_systems row nor a registry agent`, { system_code: code });
  if (!reason) throw new ControlsRefused(400, "REASON_REQUIRED", "a reason is required (18.1: the bypass and its reset are events with the actor and a reason)");
  const state = await killSwitchState(rt, code);
  if (i.action === "trip" && state.state === "tripped") throw new ControlsRefused(409, "ALREADY_TRIPPED", `${code} is already tripped (since ${state.tripped_at})`, { system_code: code, tripped_at: state.tripped_at });
  if (i.action === "reset" && state.state === "armed") throw new ControlsRefused(409, "NOT_TRIPPED", `${code} is not tripped`, { system_code: code });
  const open = (await killRequests(rt, { code, status: "pending" }, nowIso)).find((r) => r.action === i.action);
  if (open) throw new ControlsRefused(409, "REQUEST_PENDING", `a ${i.action} request ${open.request_id} for ${code} is pending until ${open.expires_at}`, { request_id: open.request_id, expires_at: open.expires_at });
  const request_id = randomUUID(); const expires_at = minutesAfter(nowIso, KILL_CONFIRM_MINUTES);
  await appendEvent(rt.db, { type: "ai.kill_switch.requested", actor: i.actor, occurred_at: nowIso, aggregate: { kind: "ai_system", id: code }, payload: { request_id, code, action: i.action, reason, by: i.actor.id, by_role: i.actor.role ?? null, requested_at: nowIso, expires_at, confirm_within_minutes: KILL_CONFIRM_MINUTES, confirm_role: KILL_CONFIRM_ROLES[0] } });
  rt.logger?.info("controls.ai.kill.requested", { request_id, code, action: i.action, by: i.actor.id });
  return { request_id, code, action: i.action, reason, by: i.actor.id, by_role: i.actor.role ?? null, requested_at: nowIso, expires_at, status: "pending", confirmed_by: null, resolved_at: null };
}

export interface KillConfirmResult { readonly request_id: string; readonly code: string; readonly action: KillAction; readonly state: "armed" | "tripped"; readonly event: "ai.kill_switch.tripped" | "ai.kill_switch.reset"; readonly by: string; readonly confirmed_by: string; readonly reason: string; readonly at: string; readonly flag: boolean; readonly ai_off: string | null; }
/** Step two: a different staff user, `admin`, confirms the request id within 10 minutes → 18.1's trip / reset with both actors and the reason. */
export async function confirmKillSwitch(rt: Runtime, i: { request_id: string; actor: Actor }, nowIso: string = rt.clock.now()): Promise<KillConfirmResult> {
  await requireStaffRole(rt.db, i.actor, KILL_CONFIRM_ROLES, "confirming a kill-switch request");
  const req = (await killRequests(rt, {}, nowIso)).find((r) => r.request_id === (i.request_id ?? "").trim());
  if (!req) throw new ControlsRefused(404, "NO_SUCH_REQUEST", `no kill-switch request ${i.request_id}`);
  if (req.status === "confirmed") throw new ControlsRefused(409, "REQUEST_CLOSED", `request ${req.request_id} was confirmed by ${req.confirmed_by} at ${req.resolved_at}`, { confirmed_by: req.confirmed_by });
  if (req.status === "expired") { await expireKillSwitchRequests(rt.root, nowIso); throw new ControlsRefused(409, "REQUEST_EXPIRED", `request ${req.request_id} expired at ${req.expires_at}; nothing ${req.action === "trip" ? "tripped" : "reset"} — ask compliance for a new request`, { request_id: req.request_id, expires_at: req.expires_at }); }
  if (i.actor.kind === "human" && i.actor.id === req.by) throw new ControlsRefused(403, "TWO_PERSON_KILL", `the kill switch is two people's decision: ${req.by} requested it and may not confirm it`, { request_id: req.request_id, requested_by: req.by });
  const type = req.action === "trip" ? "ai.kill_switch.tripped" : "ai.kill_switch.reset";
  const why = `kill switch tripped by ${req.by} (compliance), confirmed by ${i.actor.id} (admin): ${req.reason} (18.1 / 34.4 rule 4)`;
  await rt.db.tx(async (q) => {
    await q.query(`INSERT INTO feature_flags (key, value, scope, updated_by, updated_at) VALUES ($1, $2::jsonb, 'global', $3, $4::timestamptz) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`, [flagKey(req.code), req.action === "trip" ? "false" : "true", `staff:${i.actor.id} for staff:${req.by} (${req.request_id})`, nowIso]);
    await appendEvent(q, { type, actor: i.actor, occurred_at: nowIso, aggregate: { kind: "ai_system", id: req.code }, payload: { code: req.code, request_id: req.request_id, action: req.action, by: req.by, by_role: req.by_role, confirmed_by: i.actor.id, confirmed_by_role: i.actor.role ?? null, reason: req.reason, requested_at: req.requested_at, flag: flagKey(req.code), flag_value: req.action !== "trip" } });
  });
  // the registry's own AI-off state for the agent (the bus refuses its commands with AI_OFF; the borrower turn reads it first) — an ai_systems code that is not an agent has only the flag
  if (registryAgent(rt, req.code)) rt.agents.setAiOff(req.code, req.action === "trip" ? why : null);
  rt.logger?.warn(`controls.ai.kill.${req.action === "trip" ? "tripped" : "reset"}`, { request_id: req.request_id, code: req.code, by: req.by, confirmed_by: i.actor.id });
  return { request_id: req.request_id, code: req.code, action: req.action, state: req.action === "trip" ? "tripped" : "armed", event: type, by: req.by, confirmed_by: i.actor.id, reason: req.reason, at: nowIso, flag: req.action !== "trip", ai_off: registryAgent(rt, req.code)?.why ?? null };
}
