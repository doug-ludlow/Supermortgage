/**
 * 34.2 `directory.unmask` — rule 2 / state machine: `granted —(15 minutes | sign-out)→ expired`.
 *
 * A compliance or officer staff member names the fields (`contact`, `identity`) and a reason; one append-only
 * `directory_unmasks` row is written for THEIR SESSION with expires_at = granted_at + 15 minutes, beside the decision record
 * ({party_id, action, fields, reason, by, rule_set_version: directory.mask.v1, model_version: deterministic, prompt_version:
 * 34.2-v1, confidence: 1}) and `directory.unmasked{staff_user_id, party_id, fields, reason}` (global; no destination, no name).
 * The account projection asks `activeUnmaskFields` on every request: an unmask that expired mid-page re-masks on the next
 * request (edge case 4), and a revoked staff session ends it early (34.1 rule 5).
 *
 * Escalation (AI agent design): `compliance` when one staff member unmasks more than 20 people in a day — counted over the
 * distinct parties of the day's rows (America/New_York), one open escalation per staff member per day.
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "../../infra/db/client.ts";
import type { Actor } from "../../kernel/events/index.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import { EscalationService } from "../../app/escalations.ts";
import type { Runtime } from "../app.ts";
import { UNMASK_ROLES, isUnmaskField, type UnmaskField } from "./mask.ts";
import { unidentifiedVideoPartySql } from "./scope.ts";

export const UNMASK_MINUTES = 15;
export const UNMASK_ESCALATION_PER_DAY = 20;
export const DIRECTORY_AGENT = "security-records";
export const DIRECTORY_RULE_SET_VERSION = "directory.mask.v1";
export const DIRECTORY_MODEL_VERSION = "deterministic";
export const DIRECTORY_PROMPT_VERSION = "34.2-v1";
const ET = "America/New_York";

export class DirectoryRefused extends RangeError {
  readonly code: string; readonly status: number; readonly extra: Record<string, unknown>;
  constructor(status: number, code: string, detail: string, extra: Record<string, unknown> = {}) { super(detail); this.name = "DirectoryRefused"; this.code = code; this.status = status; this.extra = extra; }
}

export interface DirectoryUnmaskInput { readonly staff_user_id: string; readonly session_id: string | null; readonly party_id: string; readonly fields: readonly string[]; readonly reason: string; readonly roles?: readonly string[] }
export interface DirectoryUnmaskResult { readonly unmask_id: string; readonly party_id: string; readonly fields: readonly UnmaskField[]; readonly granted_at: string; readonly expires_at: string; readonly decision_id: string | null; readonly event_id: string | null; readonly escalation_id: string | null; readonly unmasked_today: number }

export const normalizeFields = (v: unknown): UnmaskField[] => { const arr = Array.isArray(v) ? v : typeof v === "string" ? v.split(",").map((s) => s.trim()) : []; const out: UnmaskField[] = []; for (const f of arr) { if (!isUnmaskField(f)) throw new DirectoryRefused(400, "UNKNOWN_FIELD", `unmask fields are contact and identity; got ${String(f)}`); if (!out.includes(f)) out.push(f); } return out; };

/** The fields open right now for this staff member on this party (their session's rows not yet expired; a revoked staff session ends every unmask it held). */
export async function activeUnmaskFields(db: Queryable, i: { staff_user_id: string; session_id?: string | null; party_id: string; now: string }): Promise<UnmaskField[]> {
  const rows = await db.query<{ fields: string[] }>(
    `SELECT u.fields FROM directory_unmasks u LEFT JOIN staff_sessions s ON s.session_id = u.session_id
     WHERE u.staff_user_id = $1 AND u.party_id = $2 AND u.expires_at > $3::timestamptz AND u.granted_at <= $3::timestamptz
       AND ($4::uuid IS NULL OR u.session_id = $4::uuid) AND (s.session_id IS NULL OR s.revoked_at IS NULL)`, [i.staff_user_id, i.party_id, i.now, i.session_id ?? null]);
  const out = new Set<UnmaskField>();
  for (const r of rows) for (const f of r.fields) if (isUnmaskField(f)) out.add(f);
  return [...out];
}

/** The number of distinct parties this staff member unmasked on the calendar day (America/New_York) of `now`. */
export async function unmaskedToday(db: Queryable, staffUserId: string, now: string): Promise<number> {
  const day = wallClock(Date.parse(now), ET).date;
  const r = (await db.query<{ n: string }>(`SELECT count(DISTINCT party_id)::text AS n FROM directory_unmasks WHERE staff_user_id = $1 AND (granted_at AT TIME ZONE $2)::date = $3::date`, [staffUserId, ET, String(day)]))[0];
  return Number(r?.n ?? "0");
}

export async function directoryUnmask(rt: Runtime, i: DirectoryUnmaskInput, actor?: Actor): Promise<DirectoryUnmaskResult> {
  const roles = i.roles ?? (actor?.role ? [actor.role] : []);
  if (roles.length && !roles.some((r) => UNMASK_ROLES.includes(r))) throw new DirectoryRefused(403, "ROLE_REQUIRED", `unmask needs ${UNMASK_ROLES.join(" or ")}`, { role: "compliance", roles: UNMASK_ROLES });
  const fields = normalizeFields(i.fields);
  if (!fields.length) throw new DirectoryRefused(400, "FIELDS_REQUIRED", "name at least one of contact, identity");
  const reason = String(i.reason ?? "").trim();
  if (!reason) throw new DirectoryRefused(400, "REASON_REQUIRED", "an unmask needs a reason");
  if (!i.staff_user_id) throw new DirectoryRefused(401, "SESSION_REQUIRED", "an unmask is granted to a staff session");
  const party = (await rt.db.query<{ id: string }>(`SELECT id::text AS id FROM parties WHERE id = $1 AND party_type = 'borrower' AND NOT ${unidentifiedVideoPartySql("parties")}`, [i.party_id]))[0];   // an un-identified video party is no person (scope.ts)
  if (!party) throw new DirectoryRefused(404, "NOT_FOUND", `no account ${i.party_id}`);
  const now = rt.clock.now();
  const granted_at = now; const expires_at = new Date(Date.parse(now) + UNMASK_MINUTES * 60_000).toISOString();
  const unmask_id = randomUUID();
  const by: Actor = actor ?? { kind: "human", id: i.staff_user_id, role: roles[0] ?? "compliance" };
  const before = await unmaskedToday(rt.db, i.staff_user_id, now);
  const alreadyCounted = (await rt.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM directory_unmasks WHERE staff_user_id = $1 AND party_id = $2 AND (granted_at AT TIME ZONE $3)::date = $4::date`, [i.staff_user_id, i.party_id, ET, String(wallClock(Date.parse(now), ET).date)]))[0];
  const unmasked_today = before + (Number(alreadyCounted?.n ?? "0") > 0 ? 0 : 1);
  const openEscalation = unmasked_today > UNMASK_ESCALATION_PER_DAY && !(await rt.db.query<{ id: string }>(`SELECT id::text AS id FROM escalations WHERE completed_at IS NULL AND kind = 'sev3' AND owner_role = 'compliance' AND payload->>'reason' = 'directory.unmask.volume' AND payload->>'staff_user_id' = $1 AND payload->>'day' = $2`, [i.staff_user_id, String(wallClock(Date.parse(now), ET).date)]))[0];
  let escalation_id: string | null = null; let escalations: EscalationService | undefined;
  const w = await rt.uow.run({}, async (ctx) => {
    escalations = new EscalationService(ctx.events, ctx.clock);
    ctx.events.append({ type: "directory.unmasked", aggregate: { kind: "party", id: i.party_id }, actor: by, payload: { staff_user_id: i.staff_user_id, ...(i.session_id ? { session_id: i.session_id } : {}), party_id: i.party_id, fields, reason, unmask_id, granted_at, expires_at } });
    ctx.decide({ agent: DIRECTORY_AGENT, action: "directory.unmask", subject: { kind: "party", id: i.party_id }, rationale: reason, ruleSetVersion: DIRECTORY_RULE_SET_VERSION, ruleCode: "34.2 rule 2", modelVersion: DIRECTORY_MODEL_VERSION, promptVersion: DIRECTORY_PROMPT_VERSION, confidence: 1, approvedBy: i.staff_user_id, ...(by.role ? { approvedRole: by.role } : {}) });
    if (openEscalation) { const e = escalations.open({ kind: "sev3", ownerRole: "compliance", severity: "3", payload: { reason: "directory.unmask.volume", staff_user_id: i.staff_user_id, day: String(wallClock(Date.parse(now), ET).date), unmasked_today, threshold: UNMASK_ESCALATION_PER_DAY, note: "34.2 escalations: one staff member unmasked more than 20 people in a day" } }, by); escalation_id = e.id; }
  }, { clock: rt.clock, commit: async (q) => {
    await q.query(`INSERT INTO directory_unmasks (id, staff_user_id, session_id, party_id, fields, reason, granted_at, expires_at, created_at) VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8, $7)`, [unmask_id, i.staff_user_id, i.session_id ?? null, i.party_id, fields, reason, granted_at, expires_at]);
    for (const e of escalations?.list() ?? []) await rt.escalationRepo.save(e, q);
  } });
  return { unmask_id, party_id: i.party_id, fields, granted_at, expires_at, decision_id: w.decisions[0]?.id ?? null, event_id: w.events[0]?.id ?? null, escalation_id, unmasked_today };
}
