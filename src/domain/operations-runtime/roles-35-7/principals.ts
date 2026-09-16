/**
 * §35.7 — the `/v1` principals (rule 2; data model `api_principals`): `principals.issue` (admin) mints a 32-byte token,
 * stores only its sha-256 with the kind, the scopes and an expiry (≤ 90 days staff, ≤ 365 days service/partner), mirrors the
 * identity (a service or partner principal is a `kind = system` identity; a staff principal rides on the person's row) and
 * returns the token ONCE in the output — never in an event, a decision or a log. `principals.revoke` (admin) and the
 * cascades (34.1's disable, the sweep's expiry) set `revoked_at/by/cause` and log `principal.revoked{cause}`. The door that
 * resolves a token is v1-auth.ts.
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "../../../infra/db/client.ts";
import { toJson } from "../../../infra/db/client.ts";
import type { Actor } from "../../../kernel/events/index.ts";
import type { StaffActDeps } from "../../../runtime/staff/auth.ts";
import { hashToken, newToken } from "../../../runtime/staff/repo.ts";
import { mirrorPrincipalIdentity, mirrorStaffIdentity } from "./identities.ts";
import { RolesRefused } from "./refusals.ts";
import { requireActiveStaff, staffRow } from "./actors.ts";
import { PRINCIPAL_MAX_DAYS, P, isUuid, s, type Row } from "./types.ts";
import { decisionIdOf } from "./grants.ts";

export type PrincipalKind = "staff" | "service" | "partner";
export interface PrincipalScopes { readonly loans?: "all" | readonly string[]; readonly applications?: "all" | readonly string[]; readonly partner_id?: string; readonly processes?: readonly string[] }
export interface PrincipalRow { readonly id: string; readonly kind: PrincipalKind; readonly staff_user_id: string | null; readonly party_id: string | null; readonly name: string; readonly scopes: PrincipalScopes; readonly issued_by: string | null; readonly issued_at: string; readonly expires_at: string; readonly last_used_at: string | null; readonly revoked_at: string | null; readonly revoked_by: string | null; readonly revoked_cause: string | null; readonly refusals_in_hour: number; readonly refusals_window_started_at: string | null; readonly refused_escalated_at: string | null }
export const PRINCIPAL_COLS = `id::text AS id, kind, staff_user_id::text AS staff_user_id, party_id::text AS party_id, name, scopes, issued_by::text AS issued_by, issued_at::text AS issued_at, expires_at::text AS expires_at, last_used_at::text AS last_used_at, revoked_at::text AS revoked_at, revoked_by::text AS revoked_by, revoked_cause, refusals_in_hour, refusals_window_started_at::text AS refusals_window_started_at, refused_escalated_at::text AS refused_escalated_at`;
const nameOf = (a: Actor): string => (a.kind === "human" ? a.id : `${a.kind}:${a.id}`);

export async function principalById(q: Queryable, id: string): Promise<PrincipalRow | undefined> { return isUuid(id) ? (await q.query<PrincipalRow & Record<string, unknown>>(`SELECT ${PRINCIPAL_COLS} FROM api_principals WHERE id = $1`, [id]))[0] : undefined; }
export async function principalByToken(q: Queryable, token: string): Promise<PrincipalRow | undefined> { return (await q.query<PrincipalRow & Record<string, unknown>>(`SELECT ${PRINCIPAL_COLS} FROM api_principals WHERE token_hash = $1`, [hashToken(token)]))[0]; }

/** The scopes as JSON: `loans`/`applications` "all" or a list of uuids, `processes` a list of prefixes, `partner_id` optional. */
export function normalizeScopes(v: unknown): PrincipalScopes {
  const o = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Row;
  const list = (x: unknown, what: string): "all" | string[] | undefined => {
    if (x === undefined || x === null) return undefined;
    if (x === "all") return "all";
    if (!Array.isArray(x)) throw new RangeError(`scopes.${what} is "all" or a list of ids`);
    for (const id of x) if (!isUuid(id)) throw new RangeError(`scopes.${what}: ${String(id)} is not a uuid`);
    return x.map(String);
  };
  const processes = o["processes"] === undefined ? undefined : Array.isArray(o["processes"]) ? o["processes"].map((p) => String(p)) : (() => { throw new RangeError("scopes.processes is a list of process prefixes"); })();
  const loans = list(o["loans"], "loans"); const applications = list(o["applications"], "applications");
  return { ...(loans !== undefined ? { loans } : {}), ...(applications !== undefined ? { applications } : {}), ...(processes !== undefined ? { processes } : {}), ...(typeof o["partner_id"] === "string" && o["partner_id"] ? { partner_id: o["partner_id"] } : {}) };
}

export interface IssueInput { readonly kind: string; readonly staff_user_id?: string | null; readonly party_id?: string | null; readonly name: string; readonly scopes: unknown; readonly expires_at: string; readonly environment: string }
export interface IssueResult { readonly principal_id: string; readonly kind: PrincipalKind; readonly staff_user_id: string | null; readonly party_id: string | null; readonly name: string; readonly scopes: PrincipalScopes; readonly expires_at: string; readonly token: string; readonly token_shown_once: true; readonly by: string }
/** `principals.issue` (admin). The token is in the output only. */
export async function issuePrincipal(d: StaffActDeps, i: IssueInput): Promise<IssueResult> {
  const what = "principals.issue";
  if (i.kind !== "staff" && i.kind !== "service" && i.kind !== "partner") throw new RangeError("kind ∈ {staff, service, partner} is required");
  const kind: PrincipalKind = i.kind;
  if (typeof i.name !== "string" || !i.name.trim()) throw new RangeError("name is required");
  const expiresMs = Date.parse(String(i.expires_at ?? "")); if (!Number.isFinite(expiresMs)) throw new RangeError("expires_at is required (an ISO instant)");
  const maxDays = PRINCIPAL_MAX_DAYS[kind];
  if (expiresMs <= Date.parse(d.now)) throw new RangeError("expires_at is in the past");
  if (expiresMs - Date.parse(d.now) > maxDays * 86_400_000) throw new RangeError(`a ${kind} principal expires within ${maxDays} days`);
  const admin = await requireActiveStaff(d.db, d.actor, ["admin"], what, i.environment);
  const scopes = normalizeScopes(i.scopes);
  let staffUserId: string | null = null; let partyId: string | null = null;
  if (kind === "staff") {
    if (!isUuid(i.staff_user_id)) throw new RangeError("a staff principal names staff_user_id");
    const u = await staffRow(d.db, i.staff_user_id); if (!u) throw new RangeError(`no staff user ${i.staff_user_id}`);
    if (u.status !== "active") throw new RolesRefused(409, "STAFF_NOT_ACTIVE", `staff user ${u.id} is ${u.status}; a principal is issued to an active account`, { staff_user_id: u.id, status: u.status });
    staffUserId = u.id;
  } else if (kind === "partner") {
    if (!isUuid(i.party_id)) throw new RangeError("a partner principal names party_id (a parties row)");
    partyId = i.party_id;
  }
  const principal_id = randomUUID(); const token = newToken(); const token_hash = hashToken(token); const expires_at = new Date(expiresMs).toISOString();
  d.deferWrite(async (q) => {
    await q.query(`INSERT INTO api_principals (id, kind, staff_user_id, party_id, name, token_hash, scopes, issued_by, issued_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)`, [principal_id, kind, staffUserId, partyId, i.name.trim(), token_hash, toJson(scopes), admin.fake ? null : admin.id, d.now, expires_at]);
    if (staffUserId) await mirrorStaffIdentity(q, staffUserId, d.now); else await mirrorPrincipalIdentity(q, principal_id);
  });
  d.events.append({ type: "principal.issued", aggregate: { kind: "api_principal", id: principal_id }, actor: d.actor, payload: P({ principal_id, kind, staff_user_id: staffUserId, party_id: partyId, scopes, expires_at, by: nameOf(d.actor) }) });
  return { principal_id, kind, staff_user_id: staffUserId, party_id: partyId, name: i.name.trim(), scopes, expires_at, token, token_shown_once: true, by: nameOf(d.actor) };
}

export interface RevokePrincipalInput { readonly principal_id: string; readonly rationale?: string | null; readonly environment: string }
export interface RevokePrincipalResult { readonly principal_id: string; readonly revoked: boolean; readonly cause: "revoke"; readonly by: string }
/** `principals.revoke` (admin): revoked_at/by/cause, the mirror, `principal.revoked{cause: revoke}`; idempotent on an already revoked row. */
export async function revokePrincipal(d: StaffActDeps, i: RevokePrincipalInput): Promise<RevokePrincipalResult> {
  const what = "principals.revoke";
  const admin = await requireActiveStaff(d.db, d.actor, ["admin"], what, i.environment);
  const p = await principalById(d.db, s(i.principal_id));
  if (!p) throw new RangeError(`no principal ${s(i.principal_id) || "(none)"}`);
  if (p.revoked_at) return { principal_id: p.id, revoked: false, cause: "revoke", by: nameOf(d.actor) };
  const rationale = (typeof i.rationale === "string" && i.rationale.trim()) || null;
  d.deferWrite(async (q) => {
    await q.query(`UPDATE api_principals SET revoked_at = $2, revoked_by = $3, revoked_cause = 'revoke' WHERE id = $1 AND revoked_at IS NULL`, [p.id, d.now, admin.fake ? null : admin.id]);
    if (p.staff_user_id) await mirrorStaffIdentity(q, p.staff_user_id, d.now); else await mirrorPrincipalIdentity(q, p.id);
    void (await decisionIdOf(q, "principal", p.id));
  });
  d.events.append({ type: "principal.revoked", aggregate: { kind: "api_principal", id: p.id }, actor: d.actor, payload: P({ principal_id: p.id, kind: p.kind, staff_user_id: p.staff_user_id, by: nameOf(d.actor), cause: "revoke", rationale }) });
  return { principal_id: p.id, revoked: true, cause: "revoke", by: nameOf(d.actor) };
}

/** The cascade's revocation of a person's principals (34.1's disable): rows in the caller's transaction; the caller appends the events from what is returned. */
export async function revokePrincipalsOf(q: Queryable, staffUserId: string, by: string | null, cause: "disabled" | "expired", nowIso: string): Promise<PrincipalRow[]> {
  const rows = await q.query<PrincipalRow & Record<string, unknown>>(`UPDATE api_principals SET revoked_at = $2, revoked_by = $3, revoked_cause = $4 WHERE staff_user_id = $1 AND revoked_at IS NULL RETURNING ${PRINCIPAL_COLS}`, [staffUserId, nowIso, by, cause]);
  return rows;
}
export const principalRevokedEvent = (p: PrincipalRow, by: string | null, cause: string, actor: Actor) => ({ type: "principal.revoked", aggregate: { kind: "api_principal", id: p.id }, actor, payload: P({ principal_id: p.id, kind: p.kind, staff_user_id: p.staff_user_id, by, cause }) });
