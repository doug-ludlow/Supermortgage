/**
 * 34.4 evidence and controls — what the five modules share (spec/sections/34-operator-portal/34-4-*.md).
 *
 * The refusal (`ControlsRefused`) carries an HTTP status, a code the spec names (ROLE_REQUIRED, REQUEUE_CAP_3,
 * TWO_PERSON_KILL, NO_CLOCK_EDIT, …) and the extra the console answers beside it (`{role}` on ROLE_REQUIRED, the escalation
 * id on the fourth requeue). The decision record schema of the `compliance-sentinel` agent is rendered once here
 * (`controlsDecision`): `{subject, action, disposition | reason, by, confirmed_by?, rule_set_version: controls.v1,
 * model_version: deterministic, prompt_version: 34.4-v1, confidence: 1}` — the rationale text of every agent_decisions
 * row the bus tools write, so an examiner reads the same shape on every act.
 *
 * Nothing here touches a money field (rule 6): the helpers insert events and read rows; the ledger is never written.
 */
import { createHash } from "node:crypto";
import type { Actor } from "../../kernel/events/index.ts";
import type { Queryable } from "../../infra/db/client.ts";
import { toJson } from "../../infra/db/client.ts";
import { StaffError } from "../staff/roles.ts";

export const CONTROLS_PROCESS = "34.4";
export const CONTROLS_AGENT = "compliance-sentinel";
export const CONTROLS_RULE_SET_VERSION = "controls.v1";
export const CONTROLS_MODEL_VERSION = "deterministic";
export const CONTROLS_PROMPT_VERSION = "34.4-v1";

export type Row = Record<string, unknown>;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === "string" && UUID.test(s);
export const sha256Hex = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex");
export const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
export const rowJson = (rows: readonly unknown[]): string => toJson(rows);

/** A refusal the console answers with its status and code — a StaffError (src/runtime/staff/roles.ts), so src/console/server.ts's existing catch maps it (`refuse(e.status, e.code, {reason, ...extra})`) with no new wiring. */
export class ControlsRefused extends StaffError {
  constructor(status: number, code: string, message: string, extra: Row = {}) { super(status, code, message, extra); this.name = "ControlsRefused"; }
}

/** ROLE_REQUIRED (rule 2 / 34.1 rule 3): a human holding one of `roles`; the refusal names the first role the way the console does (`{role, held}`). */
export function requireRole(actor: Actor, roles: readonly string[], what: string): void {
  if (actor.kind === "human" && actor.role && roles.includes(actor.role)) return;
  throw new ControlsRefused(403, "ROLE_REQUIRED", `${what} needs ${roles.join(" or ")}${actor.kind === "human" ? ` (acting as ${actor.role ?? "no role"})` : " (a person, not an agent)"}`, { role: roles[0], held: actor.kind === "human" && actor.role ? [actor.role] : [] });
}
/**
 * Defence in depth (review finding; the pattern of src/runtime/staff/auth.ts requireStaffActor): a human actor must be an ACTIVE
 * `staff_users` row holding the role it acts as — the role gate first (ROLE_REQUIRED, as before), then the row. A forged
 * `{human, <uuid>, admin}` handed to a control on the bus is ROLE_DENIED even though the /v1 tool routes refuse every section-34
 * process outright (src/runtime/server.ts staffToolsOnly); an agent or the system never runs a control (rule 2 / rule 4 name a person).
 */
export async function requireStaffRole(q: Queryable, actor: Actor, roles: readonly string[], what: string): Promise<void> {
  requireRole(actor, roles, what);
  const row = isUuid(actor.id) ? (await q.query<{ status: string; roles: string[] }>(`SELECT status::text AS status, roles FROM staff_users WHERE id = $1::uuid`, [actor.id]))[0] : undefined;
  if (!row || row.status !== "active" || !row.roles.includes(actor.role!)) throw new ControlsRefused(403, "ROLE_DENIED", `${what} needs an active staff member holding ${roles.join(" or ")}; the actor ${actor.id} is ${!row ? "not a staff user" : row.status !== "active" ? row.status : `[${row.roles.join(", ")}] and acts as ${actor.role}`} (34.1 rule 3: the actor on the bus is the session's)`, { role: roles[0], held: row?.status === "active" ? row.roles : [] });
}
export const humanId = (actor: Actor): string => (actor.kind === "human" ? actor.id : `${actor.kind}:${actor.id}`);

/** The decision record of the AI agent design paragraph, rendered as the rationale text (one shape on every act). */
export interface ControlsDecision { readonly subject: { readonly kind: string; readonly id: string }; readonly action: string; readonly disposition?: string | null; readonly reason: string; readonly by: string; readonly by_role?: string | null; readonly confirmed_by?: string | null; }
/** The row carries the same versions as the record (agent_decisions.model_version, prompt_version, confidence — what 34.1's staffDecision writes for its rows): an examiner reads them on the row and in the text alike. */
export function controlsDecision(d: ControlsDecision): { action: string; rationale: string; subject: { kind: string; id: string }; ruleCode: string; modelVersion: string; promptVersion: string; confidence: number } {
  const record = { subject: d.subject, action: d.action, ...(d.disposition !== undefined ? { disposition: d.disposition } : {}), reason: d.reason, by: d.by, ...(d.by_role ? { by_role: d.by_role } : {}), ...(d.confirmed_by !== undefined ? { confirmed_by: d.confirmed_by } : {}),
    rule_set_version: CONTROLS_RULE_SET_VERSION, model_version: CONTROLS_MODEL_VERSION, prompt_version: CONTROLS_PROMPT_VERSION, confidence: 1 };
  return { action: d.action, rationale: toJson(record), subject: d.subject, ruleCode: CONTROLS_RULE_SET_VERSION, modelVersion: CONTROLS_MODEL_VERSION, promptVersion: CONTROLS_PROMPT_VERSION, confidence: 1 };
}

/** One event row appended directly (the runtime functions run their own transactions, like src/console/pg-store.ts and src/runtime/book-ops do); the actor is the person. */
export async function appendEvent(q: Queryable, e: { type: string; actor: Actor; payload: Row; loan_id?: string | null; application_id?: string | null; aggregate?: { kind: string; id: string } | null; occurred_at?: string }): Promise<{ id: string; sequence: number }> {
  const r = (await q.query<{ id: string; sequence: bigint | number | string }>(`INSERT INTO loan_events (type, occurred_at, loan_id, application_id, aggregate_kind, aggregate_id, actor_kind, actor_id, actor_role, payload) VALUES ($1, coalesce($2::timestamptz, now()), $3, $4, $5, $6, $7, $8, $9, $10::jsonb) RETURNING id::text AS id, sequence`,
    [e.type, e.occurred_at ?? null, e.loan_id ?? null, e.application_id ?? null, e.aggregate?.kind ?? null, e.aggregate?.id ?? null, e.actor.kind, e.actor.id, e.actor.role ?? null, toJson(e.payload)]))[0]!;
  return { id: r.id, sequence: Number(r.sequence) };
}

/** The money columns rule 6 promises never change through the portal (T6's contract): a fingerprint of the ledger and every money column the controls could reach. */
export async function moneyFingerprint(q: Queryable): Promise<string> {
  const parts: string[] = [];
  const probes: readonly [string, string][] = [
    ["ledger_lines", `SELECT count(*)::text AS n, coalesce(sum(amount_cents), 0)::text AS sum, coalesce(sum(abs(amount_cents)), 0)::text AS abs FROM ledger_lines`],
    ["ledger_entry_sets", `SELECT count(*)::text AS n, coalesce(max(id::text), '') AS last FROM ledger_entry_sets`],
    ["loans", `SELECT count(*)::text AS n, md5(coalesce(string_agg(l.id::text || ':' || l.original_upb_cents::text, ',' ORDER BY l.id), '')) AS h FROM loans l`],
    ["loan_terms", `SELECT count(*)::text AS n, md5(coalesce(string_agg(t.id::text || ':' || t.note_rate_bps::text || ':' || t.pi_cents::text || ':' || t.escrow_payment_cents::text || ':' || t.deferred_principal_cents::text, ',' ORDER BY t.id), '')) AS h FROM loan_terms t`],
    ["partner_book_facts", `SELECT count(*)::text AS n, md5(coalesce(string_agg(id::text || ':' || (facts->>'upb_cents'), ',' ORDER BY id), '')) AS h FROM partner_book_facts`],
  ];
  for (const [name, sql] of probes) { try { parts.push(`${name}=${toJson((await q.query(sql))[0] ?? {})}`); } catch (e) { parts.push(`${name}=unavailable:${(e as Error).message.split("\n")[0]}`); } }
  return sha256Hex(parts.join("\n"));
}

export const clampLimit = (v: unknown, dflt: number, max = 2000): number => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : dflt; };
export const dayOf = (iso: string): string => iso.slice(0, 10);
export const minutesAfter = (iso: string, minutes: number): string => new Date(Date.parse(iso) + minutes * 60_000).toISOString();
export { s as str };
