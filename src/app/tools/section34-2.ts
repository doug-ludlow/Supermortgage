/**
 * §34.2 process-owned tools — the `security-records` agent's `directory.search`, `directory.account`, `directory.activity`,
 * `directory.unmask` and `directory.export` (spec/sections/34-operator-portal/34-2-*.md "AI agent design"), defined with
 * `defineTools("34.2", "security-records", defs)` and spread by ./index.ts. Every tool string is one spec/registry/agents.json
 * names for 34.2. Thin bus wrappers over src/runtime/directory/*: the projections are masked for the CALLER'S ROLE before they
 * leave the tool (the bus actor's role — never a role the input asserts), every look is logged as its own event, and the two
 * writing tools write only their own log rows (a directory_unmasks / directory_exports row, a decision, an event).
 *
 *   directory.search    read   rule 4: ≥ 3 characters, prefix on the normalized value, ≤ 50 results (NARROW_QUERY), names and
 *                              masked contact only; `directory.searched{staff_user_id, query_hash, results}` — no query text.
 *   directory.account   read   the account page for the role (rules 1–2), unmasked only by what the caller's own session holds in
 *                              directory_unmasks right now (never by the input); `directory.viewed{…, section: account}`.
 *   directory.activity  read   the stream (rule 3) filtered by kind and date; `directory.viewed{…, section: activity}`.
 *   directory.unmask    act    rule 2: compliance | officer, a reason, 15 minutes for the caller's session; the row, the
 *                              decision (directory.mask.v1 / deterministic / 34.2-v1 / confidence 1) and `directory.unmasked`
 *                              are written by the runtime function (the tool's own decision hook returns null — 33.3's pattern).
 *   directory.export    act    rule 5: compliance, a reason; the one-person pack on `documents` with its hash, the
 *                              directory_exports row, the decision and `directory.exported`.
 *
 * Guardrails (the paragraph's list): ROLE_MASK (a request for an unmasked or raw projection is refused for a role outside
 * compliance/officer — and the projection itself is masked by the actor's role regardless), NO_FULL_SSN (no input can ask
 * for a full SSN / TIN), NO_SECRETS (no input can ask for hashes, tokens, vendor payloads or the model's raw inputs),
 * REASON_REQUIRED (unmask and export carry a non-empty reason), LOG_EVERY_LOOK (no input can switch the look's log off),
 * READ_ONLY (no input may carry a write: `changes`, `op: write`, an update / set / delete — the directory writes nothing to a
 * borrower's record; rule 6), ROLE_REQUIRED (unmask: compliance | officer; export: compliance — the spec's refusal code, T3).
 * The actor is the bus actor (34.1 rule 3): `staff_user_id` is never read from the input, and an input `session_id` counts only
 * when it is the actor's own open staff session (staffOf) — unmask and export refuse SESSION_REQUIRED without one.
 */
import { defineTools, compute, guard, never, str, flag, PortUnavailable, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import type { Runtime } from "../../runtime/app.ts";
import { DIRECTORY_ROLES, EXPORT_ROLES, UNMASK_ROLES } from "../../runtime/directory/mask.ts";
import { directorySearchLogged } from "../../runtime/directory/search.ts";
import { directoryAccountLogged } from "../../runtime/directory/account.ts";
import { directoryActivityLogged } from "../../runtime/directory/activity.ts";
import { DIRECTORY_RULE_SET_VERSION, DirectoryRefused, activeUnmaskFields, directoryUnmask } from "../../runtime/directory/unmask.ts";
import { directoryExport } from "../../runtime/directory/export.ts";

const PROCESS_34_2 = "34.2"; const AGENT = "security-records";
const runtimeOf = (rt: ToolRuntime): Runtime => { const r = rt.services["runtime"] as Runtime | undefined; if (!r) throw new PortUnavailable("service:runtime"); return r; };
/** The roles the projection is masked for: the bus actor's role when a person calls; an agent is always fully masked (ROLE_MASK). */
const rolesOf = (ctx: CommandContext): string[] => (ctx.actor.kind === "human" && ctx.actor.role ? [ctx.actor.role] : []);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
interface StaffLook { readonly staff_user_id: string; readonly session_id: string | null }
/**
 * 34.1 rule 3: the session's actor is the actor. `staff_user_id` is the BUS ACTOR's id — an input `staff_user_id` is never read, so
 * no look, unmask or export can be attributed to another staff member. `session_id` is honoured only when the row is the actor's
 * own open staff session (`staff_sessions.staff_user_id = actor, revoked_at IS NULL`); a session asserted for someone else, a
 * revoked one or none at all leaves the look session-less — and an unmask or an export then refuses SESSION_REQUIRED (below).
 */
async function staffOf(i: ToolInput, ctx: CommandContext, rt: Runtime): Promise<StaffLook> {
  const staff_user_id = ctx.actor.id;
  await requireStaffRow(ctx, rt);
  const claimed = str(i, "session_id");
  if (ctx.actor.kind !== "human" || !claimed || !UUID_RE.test(claimed) || !UUID_RE.test(staff_user_id)) return { staff_user_id, session_id: null };
  const own = await rt.db.query<{ ok: number }>(`SELECT 1 AS ok FROM staff_sessions WHERE session_id = $1::uuid AND staff_user_id = $2::uuid AND revoked_at IS NULL`, [claimed, staff_user_id]);
  return { staff_user_id, session_id: own.length ? claimed : null };
}
/**
 * Defence in depth (review finding; src/runtime/staff/auth.ts requireStaffActor's pattern): a human actor must be an ACTIVE
 * staff_users row holding the role it acts as (`rolesOf` masks by that role) — a forged `{human, <uuid>, compliance}` on the bus is
 * ROLE_DENIED and no look, unmask or export is attributed to a staff id with no row; the /v1 tool routes refuse every section-34
 * process outright (src/runtime/server.ts staffToolsOnly) — this is the inner layer. An agent actor reads the masked view as before.
 */
async function requireStaffRow(ctx: CommandContext, rt: Runtime): Promise<void> {
  if (ctx.actor.kind !== "human") return;
  const row = UUID_RE.test(ctx.actor.id) ? (await rt.db.query<{ status: string; roles: string[] }>(`SELECT status::text AS status, roles FROM staff_users WHERE id = $1::uuid`, [ctx.actor.id]))[0] : undefined;
  if (!row || row.status !== "active" || !ctx.actor.role || !row.roles.includes(ctx.actor.role)) throw new DirectoryRefused(403, "ROLE_DENIED", `the directory acts for an active staff member holding the role it acts as (34.1 rule 3: the actor on the bus is the session's); the actor ${ctx.actor.id} is ${!row ? "not a staff user" : row.status !== "active" ? row.status : `[${row.roles.join(", ")}] and acts as ${ctx.actor.role ?? "no role"}`}`, { role: ctx.actor.role ?? null, held: row?.status === "active" ? row.roles : [] });
}
/** An unmask is granted to — and an export produced by — the caller's own staff session; without one there is nothing to time-box (rule 2) or to attribute (rule 5). */
const sessionRequired = (s: StaffLook, what: string): StaffLook & { session_id: string } => { if (!s.session_id) throw new DirectoryRefused(401, "SESSION_REQUIRED", `${what} needs the caller's own open staff session (34.1 rule 3: the session's actor is the actor)`); return { staff_user_id: s.staff_user_id, session_id: s.session_id }; };
const partyOf = (i: ToolInput): string => { const p = str(i, "party_id"); if (!p) throw new RangeError("34.2 tool needs party_id"); return p; };
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);

// ───────── guardrails ─────────

const UNMASK_ASKS = ["unmasked", "full", "raw", "unmask_all", "show_pii", "plain"];
const ROLE_MASK = guard("ROLE_MASK", "34.2 Verified requirement / rule 2 / guardrails: the projection is masked for the role before it leaves the tool — an ops_analyst sees masked contact and no SSN or date of birth; only compliance / officer may hold an unmask", (i, ctx) => {
  const asks = UNMASK_ASKS.some((k) => flag(i, k)) || list(i["unmask"]).length > 0;
  if (!asks) return undefined;
  const ok = ctx.actor.kind === "human" && !!ctx.actor.role && UNMASK_ROLES.includes(ctx.actor.role);
  return ok ? undefined : `an unmasked projection needs ${UNMASK_ROLES.join(" or ")}; the ${ctx.actor.kind}${ctx.actor.role ? ` ${ctx.actor.role}` : ""} reads the masked view`;
});
const SSN_ASKS = new Set(["ssn", "full_ssn", "include_ssn", "tin", "full_tin", "include_tin", "ssn_full", "tin_encrypted"]);
const NO_FULL_SSN = never("NO_FULL_SSN", "34.2 rule 2 ('Never shown to anyone: full SSN') / guardrails / GLBA §1016.13", (i) => Object.keys(i).some((k) => SSN_ASKS.has(k) && i[k] !== false && i[k] !== null && i[k] !== undefined && i[k] !== ""), "no directory projection carries a full SSN or TIN; identity shows the last four under an unmask only");
const SECRET_ASKS = new Set(["include_tokens", "tokens", "token_hash", "include_hashes", "hashes", "password_hash", "credential_hash", "include_payloads", "vendor_payloads", "vendor_payload", "include_raw", "raw_tool_inputs", "tool_inputs", "context_hash", "secrets"]);
const NO_SECRETS = never("NO_SECRETS", "34.2 rule 2 ('credential hashes, session tokens, vendor payloads, the model's raw tool inputs') / guardrails", (i) => Object.keys(i).some((k) => SECRET_ASKS.has(k) && i[k] !== false && i[k] !== null && i[k] !== undefined && i[k] !== ""), "hashes, tokens, vendor payloads and the model's raw inputs are never projected");
const REASON_REQUIRED = never("REASON_REQUIRED", "34.2 Verified requirement ('Every unmask is its own logged action with a reason') / rule 5 / guardrails", (i) => !str(i, "reason").trim(), "an unmask or an export needs a reason");
const LOG_ASKS = ["unlogged", "no_log", "quiet", "silent", "skip_log", "without_log"];
const LOG_EVERY_LOOK = never("LOG_EVERY_LOOK", "34.2 Blueprint row ('every look logged') / guardrails / 19.2 access logging", (i) => LOG_ASKS.some((k) => flag(i, k)), "every directory look is logged (directory.searched / directory.viewed and 34.1's staff_actions row); the log cannot be switched off");
const WRITE_KEYS = new Set(["changes", "update", "set", "delete", "merge", "patch", "edit", "write", "correct", "amend"]);
const READ_ONLY = never("READ_ONLY", "34.2 rule 6 ('The directory writes nothing to a borrower's record') / guardrails", (i) => i.op === "write" || Object.keys(i).some((k) => WRITE_KEYS.has(k) && i[k] !== false && i[k] !== null && i[k] !== undefined && i[k] !== ""), "the directory projects; an action on the account is the owning section's command with the staff actor (34.1 rule 3)");
const roleRequired = (roles: readonly string[], what: string) => guard("ROLE_REQUIRED", `34.2 Inputs and triggers (${what}: ${roles.join(" | ")}) / 34.1 rule 3 (ROLE_REQUIRED{role} before any read)`, (_i, ctx) => (ctx.actor.kind === "human" && !!ctx.actor.role && roles.includes(ctx.actor.role) ? undefined : `${what} requires ${roles.join("/")}`));
const READ_GUARDS = [ROLE_MASK, NO_FULL_SSN, NO_SECRETS, LOG_EVERY_LOOK, READ_ONLY];
/** The roles the human path admits at all (34.1 rule 2: admin manages staff and touches no borrower) — the finer ROLE_REQUIRED is the guardrail above, so the spec's code is what a caller sees. */
const HUMAN_ROLES = DIRECTORY_ROLES;

// ───────── the tools ─────────

export const TOOLS_34_2: readonly ToolDef[] = defineTools(PROCESS_34_2, AGENT, [
  { name: "directory.search", kind: "read", humanRoles: HUMAN_ROLES, guardrails: READ_GUARDS,
    handler: compute(async (i, ctx, rt) => { const runtime = runtimeOf(rt); const s = await staffOf(i, ctx, runtime); return directorySearchLogged(runtime, { q: str(i, "q") || str(i, "query"), roles: rolesOf(ctx), ...s }, ctx.actor); }) },

  { name: "directory.account", kind: "read", humanRoles: HUMAN_ROLES, guardrails: READ_GUARDS,
    // rule 2: the unmask is never the input's — it is what the caller's OWN session holds right now (directory_unmasks, 15 minutes, a reason, `directory.unmasked` logged); an input list can only narrow it
    handler: compute(async (i, ctx, rt) => { const runtime = runtimeOf(rt); const s = await staffOf(i, ctx, runtime); const party_id = partyOf(i);
      const active = s.session_id ? await activeUnmaskFields(runtime.db, { staff_user_id: s.staff_user_id, session_id: s.session_id, party_id, now: ctx.now || runtime.clock.now() }) : [];
      const asked = list(i["unmask"]); const unmask = asked.length ? active.filter((f) => asked.includes(f)) : active;
      return directoryAccountLogged(runtime, party_id, { roles: rolesOf(ctx), unmask, now: ctx.now }, s, ctx.actor); }) },

  { name: "directory.activity", kind: "read", humanRoles: HUMAN_ROLES, guardrails: READ_GUARDS,
    handler: compute(async (i, ctx, rt) => { const runtime = runtimeOf(rt); const s = await staffOf(i, ctx, runtime); const limit = Number(i["limit"] ?? 0); return directoryActivityLogged(runtime, partyOf(i), { from: str(i, "from") || null, to: str(i, "to") || null, kind: list(i["kind"]).length ? list(i["kind"]) : null, ...(limit > 0 ? { limit } : {}) }, s, ctx.actor); }) },

  { name: "directory.unmask", kind: "act", humanRoles: HUMAN_ROLES, ruleSetVersion: DIRECTORY_RULE_SET_VERSION, guardrails: [roleRequired(UNMASK_ROLES, "directory.unmask"), REASON_REQUIRED, NO_FULL_SSN, NO_SECRETS, LOG_EVERY_LOOK, READ_ONLY],
    handler: compute(async (i, ctx, rt) => { const runtime = runtimeOf(rt); const s = sessionRequired(await staffOf(i, ctx, runtime), "directory.unmask"); return directoryUnmask(runtime, { ...s, party_id: partyOf(i), fields: list(i["fields"]), reason: str(i, "reason"), roles: rolesOf(ctx) }, ctx.actor); }),
    decision: () => null },   // the decision row is written with the unmask row (directoryUnmask: agent security-records, action directory.unmask, rule set directory.mask.v1, model deterministic, prompt 34.2-v1, confidence 1)

  { name: "directory.export", kind: "act", humanRoles: HUMAN_ROLES, ruleSetVersion: DIRECTORY_RULE_SET_VERSION, guardrails: [roleRequired(EXPORT_ROLES, "directory.export"), REASON_REQUIRED, NO_FULL_SSN, NO_SECRETS, LOG_EVERY_LOOK, READ_ONLY],
    handler: compute(async (i, ctx, rt) => { const runtime = runtimeOf(rt); const s = sessionRequired(await staffOf(i, ctx, runtime), "directory.export"); return directoryExport(runtime, { ...s, party_id: partyOf(i), reason: str(i, "reason"), roles: rolesOf(ctx) }, ctx.actor); }),
    decision: () => null },   // written with the directory_exports row (directoryExport)
]);
export const DIRECTORY_TOOLS = TOOLS_34_2.map((t) => t.name);
