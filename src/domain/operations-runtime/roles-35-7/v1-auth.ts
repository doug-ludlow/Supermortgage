/**
 * §35.7 rule 2 — the `/v1` door: the bearer is resolved to a principal BEFORE the route (src/runtime/server.ts). In order:
 *   1. no token → 401.
 *   2. the shared API_TOKEN → outside production honoured exactly as before (the body's actor, the deploy smoke and the demo
 *      routes) and logged `source = shared_token`; in production 403 SHARED_TOKEN_REFUSED_IN_PRODUCTION.
 *   3. an api_principals row by the token's sha-256: unknown → 401 PRINCIPAL_UNKNOWN; revoked → 401 PRINCIPAL_REVOKED; past
 *      expires_at → 401 PRINCIPAL_EXPIRED; a staff principal whose person is not active → 401 PRINCIPAL_REVOKED. A revoked or
 *      expired token counts refusals per hour; the fifth in an hour logs one `principal.refused{principal_id, code, count}` and
 *      opens ONE sev 2 `ciso` escalation (PRINCIPAL_REFUSED_5H), not again that hour.
 *   4. scopes: loans "all" | [ids], applications "all" | [ids], processes [prefixes] → 403 PRINCIPAL_SCOPE.
 *   5. the actor: a staff principal acts as {human, staff_user_id, role} for the role the request names (x-staff-role / body
 *      role) when the person holds it (roles ∪ reviewer_roles, plus an active break-glass role for the matching subject only)
 *      and the tool accepts it — 34.1 rule 3's chooseRole in act mode, 403 ROLE_REQUIRED{role, held, act_as}, never a silent
 *      substitution; naming no role acts under the person's default role (the least-privileged held); a service or partner
 *      principal acts as {system | agent, name} and never a human role (NO_HUMAN_ROLE_ON_SERVICE_PRINCIPAL); a body `actor`
 *      that disagrees → 403 NO_SELF_ASSERTED_ACTOR; a body `approvedBy` or `input.approvals` → 403 APPROVER_NOT_SELF_ASSERTED.
 *   6. `last_used_at` touched at most once a minute; one staff_actions row per request (surface v1) — ids only, never the token.
 */
import type { IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Actor } from "../../../kernel/events/index.ts";
import { EscalationService } from "../../../app/escalations.ts";
import type { Runtime } from "../../../runtime/app.ts";
import { PgStaffRepository, type StaffActionInput } from "../../../runtime/staff/repo.ts";
import { chooseRole, StaffError } from "../../../runtime/staff/roles.ts";
import { activeBreakglassOf, breakglassUsesOf } from "./breakglass.ts";
import { principalByToken, type PrincipalRow } from "./principals.ts";
import { PrincipalRefused, RolesRefused } from "./refusals.ts";
import { acceptedRoles } from "./tool-roles.ts";
import { P, REFUSALS_PER_HOUR_ANOMALY, isProduction, isUuid, s } from "./types.ts";

const same = (a: string, b: string): boolean => a.length === b.length && a.length > 0 && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const tokenOf = (req: IncomingMessage): string => {
  const h = String(req.headers["authorization"] ?? "");
  if (h.toLowerCase().startsWith("bearer ")) return h.slice(7).trim();
  const m = /(?:^|;\s*)sm_token=([^;]+)/.exec(String(req.headers["cookie"] ?? ""));
  return m ? decodeURIComponent(m[1]!) : "";
};
export interface StaffPrincipalPerson { readonly id: string; readonly roles: readonly string[]; readonly reviewer_roles: readonly string[] }
export interface PrincipalContext { readonly source: "principal" | "shared_token"; readonly principal: PrincipalRow | null; readonly person: StaffPrincipalPerson | null }
export interface Subject { readonly loanId?: string | null; readonly applicationId?: string | null }
export interface ActorResolution { readonly actor: Actor; readonly grantRole: string | null; readonly role: string | null }
const ACTOR_KINDS = new Set(["human", "agent", "system"]);

export class V1Auth {
  readonly rt: Runtime; readonly apiToken: string;
  constructor(rt: Runtime, opts: { apiToken: string }) { this.rt = rt; this.apiToken = opts.apiToken; }

  /** Steps 1–3 and 6 (the touch). */
  async resolve(req: IncomingMessage, now: string): Promise<PrincipalContext> {
    const token = tokenOf(req);
    if (!token) throw new PrincipalRefused(401, "PRINCIPAL_UNKNOWN", "Authorization: Bearer <principal token> is required (35.7 rule 2); the shared API_TOKEN opens /v1 outside production only", {});
    if (this.apiToken && same(token, this.apiToken)) {
      if (isProduction(this.rt.environment)) throw new PrincipalRefused(403, "SHARED_TOKEN_REFUSED_IN_PRODUCTION", "the shared API_TOKEN opens nothing in production (35.7 rule 2); present a principal issued by principals.issue", {});
      return { source: "shared_token", principal: null, person: null };
    }
    const p = await principalByToken(this.rt.db, token);
    if (!p) throw new PrincipalRefused(401, "PRINCIPAL_UNKNOWN", "the bearer is not a principal of this platform", {});
    // a dead token's refusal still names the principal (ids only) so the request's staff_actions row carries principal_id and the person (T13)
    const dead = (code: string, message: string): PrincipalRefused => { const e = new PrincipalRefused(401, code, message, { principal_id: p.id }); e.context = { source: "principal", principal: p, person: p.kind === "staff" && p.staff_user_id ? { id: p.staff_user_id, roles: [], reviewer_roles: [] } : null }; return e; };
    if (p.revoked_at) { await this.countRefusal(p, "PRINCIPAL_REVOKED", now); throw dead("PRINCIPAL_REVOKED", `principal ${p.id} was revoked at ${p.revoked_at} (${p.revoked_cause ?? "revoke"})`); }
    if (Date.parse(p.expires_at) <= Date.parse(now)) { await this.countRefusal(p, "PRINCIPAL_EXPIRED", now); throw dead("PRINCIPAL_EXPIRED", `principal ${p.id} expired at ${p.expires_at}`); }
    let person: StaffPrincipalPerson | null = null;
    if (p.kind === "staff") {
      const u = p.staff_user_id ? await new PgStaffRepository(this.rt.db).user(p.staff_user_id) : undefined;
      if (!u || u.status !== "active") { await this.countRefusal(p, "PRINCIPAL_REVOKED", now); throw dead("PRINCIPAL_REVOKED", `principal ${p.id}: the staff account is ${u?.status ?? "unknown"}`); }
      person = { id: u.id, roles: u.roles, reviewer_roles: u.reviewer_roles };
    }
    if (!p.last_used_at || Date.parse(now) - Date.parse(p.last_used_at) >= 60_000) await this.rt.db.query(`UPDATE api_principals SET last_used_at = $2 WHERE id = $1 AND (last_used_at IS NULL OR last_used_at <= $2::timestamptz - interval '60 seconds')`, [p.id, now]).catch(() => undefined);
    return { source: "principal", principal: p, person };
  }
  /** The anomaly counter (data model: refusals_in_hour): the fifth refusal of a dead token in an hour → one `principal.refused{count}` and one sev 2 ciso escalation per hour. */
  private async countRefusal(p: PrincipalRow, code: string, now: string): Promise<void> {
    const [r] = await this.rt.db.query<{ refusals_in_hour: number; refusals_window_started_at: string; refused_escalated_at: string | null }>(`UPDATE api_principals SET
        refusals_in_hour = CASE WHEN refusals_window_started_at IS NULL OR refusals_window_started_at < $2::timestamptz - interval '1 hour' THEN 1 ELSE refusals_in_hour + 1 END,
        refusals_window_started_at = CASE WHEN refusals_window_started_at IS NULL OR refusals_window_started_at < $2::timestamptz - interval '1 hour' THEN $2::timestamptz ELSE refusals_window_started_at END
      WHERE id = $1 RETURNING refusals_in_hour, refusals_window_started_at::text AS refusals_window_started_at, refused_escalated_at::text AS refused_escalated_at`, [p.id, now]);
    if (!r || r.refusals_in_hour !== REFUSALS_PER_HOUR_ANOMALY) return;
    if (r.refused_escalated_at && Date.parse(r.refused_escalated_at) >= Date.parse(r.refusals_window_started_at)) return;
    const actor: Actor = { kind: "system", id: "v1-auth" };
    let esc: EscalationService | undefined;
    await this.rt.uow.run({}, (ctx) => {
      ctx.events.append({ type: "principal.refused", aggregate: { kind: "api_principal", id: p.id }, actor, payload: P({ principal_id: p.id, kind: p.kind, staff_user_id: p.staff_user_id, code, count: r.refusals_in_hour, window_started_at: r.refusals_window_started_at, at: now }) });
      esc = new EscalationService(ctx.events, ctx.clock);
      esc.open({ kind: "sev2", ownerRole: "ciso", severity: "2", payload: { code: "PRINCIPAL_REFUSED_5H", principal_id: p.id, principal_kind: p.kind, refusal_code: code, count: r.refusals_in_hour, window_started_at: r.refusals_window_started_at, reason: `a ${p.revoked_at ? "revoked" : "expired"} principal was presented ${r.refusals_in_hour} times within an hour (35.7 AI agent design: the ciso anomaly, once per hour per token)` } }, actor);
    }, { clock: this.rt.clock, commit: async (q) => { for (const e of esc?.list() ?? []) await this.rt.escalationRepo.save(e, q); await q.query(`UPDATE api_principals SET refused_escalated_at = $2 WHERE id = $1`, [p.id, now]); } });
  }
  /** Step 4. `process` is the tool's process or a pseudo-process of the other routes (applications, fund, transfers, sweep, demo, partner-book, entry). */
  scopeCheck(c: PrincipalContext, subject: Subject & { process: string }): void {
    const p = c.principal; if (!p) return;
    const sc = p.scopes;
    const inList = (list: "all" | readonly string[] | undefined, id: string | null | undefined): boolean => !id || list === "all" || (Array.isArray(list) && list.includes(id));
    if (subject.loanId && !inList(sc.loans, subject.loanId)) throw new PrincipalRefused(403, "PRINCIPAL_SCOPE", `principal ${p.id} is not scoped to loan ${subject.loanId}`, { principal_id: p.id, loan_id: subject.loanId });
    if (subject.applicationId && !inList(sc.applications, subject.applicationId)) throw new PrincipalRefused(403, "PRINCIPAL_SCOPE", `principal ${p.id} is not scoped to application ${subject.applicationId}`, { principal_id: p.id, application_id: subject.applicationId });
    if (sc.processes && sc.processes.length && !sc.processes.some((pre) => subject.process === pre || subject.process.startsWith(pre))) throw new PrincipalRefused(403, "PRINCIPAL_SCOPE", `principal ${p.id} is not scoped to process ${subject.process}`, { principal_id: p.id, process: subject.process });
  }
  /**
   * Step 5. `accepted` is the tool's accepted roles (acceptedRoles(def)) or null for a route that takes any held role; the body's
   * `actor`/`approvedBy`/`input.approvals` are checked against the resolution. Under the shared token the body's actor stands (today's contract).
   */
  async actorFor(c: PrincipalContext, i: { readonly method: string; readonly headers: IncomingMessage["headers"]; readonly body: Record<string, unknown>; readonly accepted: readonly string[] | null; readonly subject: Subject; readonly now: string; readonly fallback?: Actor }): Promise<ActorResolution> {
    const bodyActor = i.body["actor"];
    if (c.source === "shared_token") {
      const a = bodyActor === undefined ? i.fallback : actorOf(bodyActor);
      if (!a) throw new RangeError("actor must be { kind: human|agent|system, id, role? }");
      return { actor: a, grantRole: null, role: a.role ?? null };
    }
    if (i.body["approvedBy"] !== undefined) throw new PrincipalRefused(403, "APPROVER_NOT_SELF_ASSERTED", "a body approvedBy is refused whatever it says: an approval is a record by roles.approve (35.7 rule 2)", { principal_id: c.principal!.id });
    const input = i.body["input"];
    if (input && typeof input === "object" && (input as Record<string, unknown>)["approvals"] !== undefined) throw new PrincipalRefused(403, "APPROVER_NOT_SELF_ASSERTED", "input.approvals is refused: the second person is an approval record by roles.approve (35.7 rule 2)", { principal_id: c.principal!.id });
    const p = c.principal!;
    if (p.kind !== "staff") {
      const name = p.name;
      const kind: Actor["kind"] = this.isAgent(name) ? "agent" : "system";
      if (bodyActor !== undefined) {
        const b = actorOf(bodyActor);
        if (b.kind === "human" || b.role) throw new PrincipalRefused(403, "NO_HUMAN_ROLE_ON_SERVICE_PRINCIPAL", `a ${p.kind} principal acts as ${kind}:${name} and never under a human role`, { principal_id: p.id });
        if (b.id !== name || b.kind !== kind) throw new PrincipalRefused(403, "NO_SELF_ASSERTED_ACTOR", `the actor is the principal's (${kind}:${name}), not ${b.kind}:${b.id}`, { principal_id: p.id });
      }
      return { actor: { kind, id: name }, grantRole: null, role: null };
    }
    const person = c.person!;
    const held: string[] = [...person.roles, ...person.reviewer_roles.filter((r) => !person.roles.includes(r))];
    const preferred = (typeof i.headers["x-staff-role"] === "string" && i.headers["x-staff-role"].trim()) || (typeof i.body["role"] === "string" && (i.body["role"] as string).trim()) || null;
    // rule 8: a broken-into role counts as held for the matching subject only, while unexpired
    const uses = await breakglassUsesOf(this.rt.db, person.id);
    const active = uses.length ? await activeBreakglassOf(this.rt.db, person.id, i.now) : [];
    const matches = (u: { subject_kind: string; subject_id: string }): boolean => (u.subject_kind === "loan" && u.subject_id === i.subject.loanId) || (u.subject_kind === "application" && u.subject_id === i.subject.applicationId);
    const grantedByBreakglass = new Set<string>();
    for (const u of active) if (matches(u) && !held.includes(u.role)) { held.push(u.role); grantedByBreakglass.add(u.role); }
    if (preferred && !held.includes(preferred) && uses.some((u) => u.role === preferred)) throw new RolesRefused(403, "ROLE_DENIED", `${preferred} was broken into for another subject or has expired; the acts under a break-glass are ordinary acts of that role on that subject only (35.7 rule 8)`, { role: preferred, subject: i.subject.loanId ? { kind: "loan", id: i.subject.loanId } : i.subject.applicationId ? { kind: "application", id: i.subject.applicationId } : null, held: [...held], act_as: [] });
    const role = chooseRole(held, i.accepted, preferred, { mode: i.method === "GET" || i.method === "HEAD" ? "read" : "act" });
    const actor: Actor = { kind: "human", id: person.id, role };
    if (bodyActor !== undefined) {
      const b = actorOf(bodyActor);
      if (b.kind !== "human" || b.id !== person.id || (b.role !== undefined && b.role !== role)) throw new PrincipalRefused(403, "NO_SELF_ASSERTED_ACTOR", `the actor is the principal's (human:${person.id} as ${role}), not ${b.kind}:${b.id}${b.role ? ` (${b.role})` : ""} (35.7 rule 2)`, { principal_id: p.id, role, held });
    }
    const grantRole = person.reviewer_roles.includes(role) || grantedByBreakglass.has(role) ? role : null;
    return { actor, grantRole, role };
  }
  private isAgent(name: string): boolean { try { return this.rt.agents.agents().some((a) => a.agent === name); } catch { return false; } }
  /** Step 6: one staff_actions row per /v1 request — ids and codes only. */
  async log(a: Omit<StaffActionInput, "surface" | "source" | "principal_id" | "staff_user_id" | "session_id"> & { context: PrincipalContext | null }): Promise<void> {
    const c = a.context;
    try { await new PgStaffRepository(this.rt.db).logAction({ staff_user_id: c?.person?.id ?? null, session_id: null, at: a.at, route: a.route, method: a.method, subject_kind: a.subject_kind, subject_id: a.subject_id, command: a.command, result: a.result, refusal_code: a.refusal_code, role: a.role ?? null, principal_id: c?.principal?.id ?? null, surface: "v1", source: c ? c.source : null }); }
    catch (e) { this.rt.logger?.error("staff_actions.write.failed", { route: a.route, error: e }); }
  }
  static acceptedFor(def: Parameters<typeof acceptedRoles>[0] | undefined): readonly string[] | null { return def ? acceptedRoles(def) : null; }
}
/** The body's `{kind, id, role?}` (today's contract for the shared token; a comparison value under a principal). */
export function actorOf(v: unknown): Actor {
  const a = v as { kind?: unknown; id?: unknown; role?: unknown } | undefined;
  if (!a || typeof a !== "object" || typeof a.kind !== "string" || !ACTOR_KINDS.has(a.kind) || typeof a.id !== "string" || !a.id) throw new RangeError("actor must be { kind: human|agent|system, id, role? }");
  if (a.role !== undefined && typeof a.role !== "string") throw new RangeError("actor.role must be a string");
  return { kind: a.kind as Actor["kind"], id: a.id, ...(typeof a.role === "string" ? { role: a.role } : {}) };
}
export const isStaffError = (e: unknown): e is StaffError => e instanceof StaffError;
export const subjectIdOf = (loanId: string, applicationId: string | undefined): { kind: string | null; id: string | null } => (applicationId && isUuid(applicationId) ? { kind: "application", id: applicationId } : loanId && isUuid(loanId) ? { kind: "loan", id: loanId } : { kind: null, id: null });
export const strOf = s;
