/**
 * §34.1 process-owned tools — the `security-records` agent's `staff.invite`, `staff.signin`, `staff.role.set`, `staff.disable`
 * and `staff.access.review` (spec/sections/34-operator-portal/34-1-*.md "AI agent design"), defined with
 * `defineTools("34.1", "security-records", defs)` and spread by ./index.ts. Every tool string is one spec/registry/agents.json
 * names for 34.1. Thin bus wrappers over src/runtime/staff/auth.ts (the acts), run in the command's unit of work: rows are
 * deferred into the command's transaction (`services.deferWrite`), events ride `ctx.events`, escalations `rt.escalations`.
 *
 *   staff.invite         act   admin (or the bootstrap system actor): the staff_users{invited} row with the e-mail hashed and
 *                              encrypted, NTC_SM_STAFF_INVITATION by e-mail, `staff.invited{staff_user_id, invited_by, roles}`.
 *   staff.signin         act   the ONLY path to a session: the password against the scrypt hash AND a possession factor (a code
 *                              verified for this e-mail within 10 minutes, or a passkey asserted); the fifth failure locks the
 *                              account 15 minutes, logs `staff.signin.locked` and opens the `compliance` escalation. A failed
 *                              attempt is a normal output `{ok: false, code}` (never a throw — the counter, the lock event and the
 *                              escalation must commit); the console maps `code` to its status.
 *   staff.role.set       write admin decision with rationale: roles_before → roles_after, the user's sessions revoked, decision
 *                              {staff_user_id, action, roles_before, roles_after, rationale, by, rule set staff.access.v1, model
 *                              deterministic, prompt 34.1-v1, confidence 1}.
 *   staff.disable        write admin decision with rationale: status disabled, sessions revoked in the same transaction.
 *   staff.access.review  act   compliance or admin: every active user keep | change | disable; the changes run through
 *                              staff.role.set / staff.disable (their events and decisions), one staff_access_reviews row,
 *                              `staff.access_review.completed{reviewed_at}` satisfies and re-arms SM_STAFF_ACCESS_REVIEW_90.
 *
 * The acts trust no actor the request names (review finding): src/runtime/staff/auth.ts requireStaffActor checks the actor
 * against staff_users rows — an ACTIVE row holding admin (compliance | admin for the review), else ROLE_DENIED; the system
 * actor invites only the first admin while the table is empty — and src/runtime/server.ts refuses process 34.1 on the generic
 * /v1 tool routes (403 STAFF_TOOLS_ARE_SESSION_ONLY): the console's session path is the only HTTP entry to these tools.
 *
 * Guardrails (the paragraph's list): TWO_FACTORS (no session on one factor — an input that asks for one is refused; the
 * handler enforces it from rows), NO_SELF_ROLE_CHANGE (the caller's own row), LAST_ADMIN_STAYS (an input that would waive the
 * invariant is refused; the handler checks the active admins and refuses with the same code), NO_HEADER_ACTOR_IN_PRODUCTION
 * (a header-sourced actor never acts here in production), NO_PII_IN_LOG (an input asking the action log to carry a name, an
 * e-mail, a phone, a code, a token or a figure is refused — the log carries ids only).
 */
import { defineTools, compute, never, guard, str, flag, PortUnavailable, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import type { Queryable } from "../../infra/db/client.ts";
import type { Runtime } from "../../runtime/app.ts";
import { staffInvite, staffSignin, staffRoleSet, staffDisable, staffAccessReview, staffDecision, STAFF_RULE_SET_VERSION, type StaffActDeps } from "../../runtime/staff/auth.ts";
import { STAFF_ROLES, ACCESS_REVIEW_ROLES, NO_SELF_ROLE_CHANGE as SELF, LAST_ADMIN_STAYS as LAST, type ReviewInput } from "../../runtime/staff/roles.ts";

type P = Record<string, unknown>;
const PROCESS_34_1 = "34.1"; const AGENT = "security-records";
const obj = (v: unknown): P => (v && typeof v === "object" && !Array.isArray(v) ? (v as P) : {});
const dbOf = (rt: ToolRuntime): Queryable => { const db = rt.services["db"] as Queryable | undefined; if (!db) throw new PortUnavailable("service:db"); return db; };
const runtimeOf = (rt: ToolRuntime): Runtime => { const r = rt.services["runtime"] as Runtime | undefined; if (!r) throw new PortUnavailable("service:runtime"); return r; };
const deferOf = (rt: ToolRuntime): StaffActDeps["deferWrite"] => { const f = rt.services["deferWrite"] as StaffActDeps["deferWrite"] | undefined; if (!f) throw new PortUnavailable("service:deferWrite"); return f; };
// the decisions an act records on its own (the review's staff.role.set / staff.disable records) name the human the same way the bus names them on the tool's own decision (src/app/commands.ts: approved_by / approved_role = the human actor)
const depsOf = (ctx: CommandContext, rt: ToolRuntime): StaffActDeps => ({ runtime: runtimeOf(rt), db: dbOf(rt), events: ctx.events, clock: ctx.clock, now: ctx.now, actor: ctx.actor, escalations: rt.escalations, deferWrite: deferOf(rt),
  decide: (d) => ctx.decide({ ...d, ...(ctx.actor.kind === "human" ? { approvedBy: ctx.actor.id, ...(ctx.actor.role ? { approvedRole: ctx.actor.role } : {}) } : {}) }) });

// ───────── guardrails ─────────

/** Rule 1 / Verified requirement (16 CFR §314.4(c)(5); 23 NYCRR §500.12): a session opens on a possession factor AND the password; an input asking for one factor is refused outright. */
const oneFactorAsked = (i: ToolInput): string | null => {
  for (const k of ["single_factor", "one_factor", "skip_password", "skip_possession", "skip_code", "code_only", "passkey_only", "password_only", "no_second_factor", "bypass_mfa"]) if (i[k] === true) return `input carries \`${k}\``;
  if (Array.isArray(i["factors"]) && (i["factors"] as unknown[]).length < 2) return `input asks for factors [${(i["factors"] as unknown[]).map(String).join(", ")}]`;
  return null;
};
const TWO_FACTORS = never("TWO_FACTORS", "34.1 rule 1 'Two factors, always' / Verified requirement: 16 CFR §314.4(c)(5), 23 NYCRR §500.12 — 'a code alone never opens a portal session'", (i) => oneFactorAsked(i) !== null, "a portal session opens only after a possession factor (the code to the e-mail on file, or a registered passkey) AND the password; no session on one factor");
/** Rule 2: `staff.role.set` refuses the caller's own row; so does a disable, and a review that changes or disables the reviewer. */
const selfRow = (i: ToolInput, ctx: CommandContext): boolean => ctx.actor.kind === "human" && !!ctx.actor.id && str(i, "staff_user_id") === ctx.actor.id;
const selfInReview = (i: ToolInput, ctx: CommandContext): boolean => ctx.actor.kind === "human" && Array.isArray(i["decisions"]) && (i["decisions"] as unknown[]).some((d) => obj(d)["staff_user_id"] === ctx.actor.id && obj(d)["decision"] !== "keep");
const NO_SELF_ROLE_CHANGE = guard(SELF.code, SELF.citation, (i, ctx) => (selfRow(i, ctx) ? `${ctx.actor.id} may not change their own roles or standing` : selfInReview(i, ctx) ? `${ctx.actor.id} may not change or disable their own row in the review` : undefined));
/** Rule 2: at least one active admin always remains — an input that would waive the invariant is refused; the handler checks the rows and refuses with the same code. */
const LAST_ADMIN_STAYS = never(LAST.code, LAST.citation, (i) => flag(i, "remove_last_admin") || flag(i, "allow_no_admin") || flag(i, "force") || flag(i, "override_last_admin"), "the platform always keeps at least one active admin; the invariant is never waived");
/** Rule 3 / discrepancy (1): the header actor survives only for the deploy workflow behind the ops bearer token and only outside production. */
const isProduction = (): boolean => { const e = process.env["ENVIRONMENT"] ?? "nonprod"; return e === "production" || e === "prod"; };
const NO_HEADER_ACTOR_IN_PRODUCTION = never("NO_HEADER_ACTOR_IN_PRODUCTION", "34.1 rule 3: 'The header actor is honoured only when the request carries the ops bearer token (the deploy workflow) and ENVIRONMENT ≠ production'; edge cases: 'The ops bearer token leaks → … in production it opens nothing'", (i) => i["actor_source"] === "header" && isProduction(), "a header-named actor never acts in production; the session's actor is the only actor");
/** Rule 4: the action log carries ids only — an input asking it to carry a name, an e-mail, a phone, a code, a token or a figure is refused. */
const PII_KEYS = new Set(["email", "e_mail", "email_address", "phone", "phone_number", "mobile", "name", "legal_name", "first_name", "last_name", "password", "code", "token", "amount", "amount_cents", "balance_cents", "upb_cents", "ssn", "tin", "date_of_birth", "address"]);
const piiInLog = (i: ToolInput): string | null => { for (const k of ["log", "action_log", "audit", "log_fields", "staff_action"]) { const hit = Object.keys(obj(i[k])).find((x) => PII_KEYS.has(x)); if (hit) return `\`${k}.${hit}\``; } return null; };
const NO_PII_IN_LOG = never("NO_PII_IN_LOG", "34.1 rule 4 'Everything is logged, nothing sensitive is': 'the row carries subject ids, never a name, e-mail, phone or figure'", (i) => piiInLog(i) !== null, "the action log carries route, subject ids, command and result — never a name, an e-mail, a phone, a code, a token or a figure");
const GUARDS = [TWO_FACTORS, NO_SELF_ROLE_CHANGE, LAST_ADMIN_STAYS, NO_HEADER_ACTOR_IN_PRODUCTION, NO_PII_IN_LOG];

type Decision = NonNullable<ReturnType<NonNullable<ToolDef["decision"]>>>;
const asDecision = (d: ReturnType<typeof staffDecision>): Decision => ({ action: d.action, rationale: d.rationale, ...(d.subject ? { subject: d.subject } : {}), modelVersion: d.modelVersion, promptVersion: d.promptVersion, confidence: d.confidence } as unknown as Decision);

// ───────── the tools ─────────

export const TOOLS_34_1: readonly ToolDef[] = defineTools(PROCESS_34_1, AGENT, [
  { name: "staff.invite", kind: "act", ruleSetVersion: STAFF_RULE_SET_VERSION, humanRoles: ["admin"], guardrails: GUARDS,
    handler: compute(async (i, ctx, rt) => staffInvite(depsOf(ctx, rt), { email: str(i, "email"), legal_name: typeof i["legal_name"] === "string" ? i["legal_name"] : null, roles: i["roles"], rationale: typeof i["rationale"] === "string" ? i["rationale"] : null })),
    decision: () => null },   // the invitation's record is `staff.invited` and the notice row; the spec's decision records are staff.role.set, staff.disable, staff.access.review

  { name: "staff.signin", kind: "act", ruleSetVersion: STAFF_RULE_SET_VERSION, humanRoles: [...STAFF_ROLES], guardrails: GUARDS,
    handler: compute(async (i, ctx, rt) => staffSignin(depsOf(ctx, rt), { email: str(i, "email"), password: str(i, "password"), ip: typeof i["ip"] === "string" ? i["ip"] : null, user_agent: typeof i["user_agent"] === "string" ? i["user_agent"] : null })),
    decision: () => null },   // `staff.signed_in` / `staff.signin.failed` / `staff.signin.locked` are the record

  { name: "staff.role.set", kind: "write", ruleSetVersion: STAFF_RULE_SET_VERSION, humanRoles: ["admin"], guardrails: GUARDS,
    handler: compute(async (i, ctx, rt) => staffRoleSet(depsOf(ctx, rt), { staff_user_id: str(i, "staff_user_id"), roles: i["roles"], rationale: typeof i["rationale"] === "string" ? i["rationale"] : null })),
    decision: (i, output, ctx) => { const o = obj(output); return asDecision(staffDecision({ action: "staff.role.set", staff_user_id: String(o["staff_user_id"] ?? str(i, "staff_user_id")), roles_before: (o["roles_before"] as string[] | undefined) ?? [], roles_after: (o["roles_after"] as string[] | undefined) ?? [], rationale: `${str(i, "rationale") || "role change"}${o["changed"] === false ? " (no change: the roles were already these)" : ""}`, by: ctx.actor.kind === "human" ? ctx.actor.id : null })); } },

  { name: "staff.disable", kind: "write", ruleSetVersion: STAFF_RULE_SET_VERSION, humanRoles: ["admin"], guardrails: GUARDS,
    handler: compute(async (i, ctx, rt) => staffDisable(depsOf(ctx, rt), { staff_user_id: str(i, "staff_user_id"), rationale: typeof i["rationale"] === "string" ? i["rationale"] : null })),
    decision: (i, output, ctx) => { const o = obj(output); return asDecision(staffDecision({ action: "staff.disable", staff_user_id: String(o["staff_user_id"] ?? str(i, "staff_user_id")), roles_before: (o["roles_before"] as string[] | undefined) ?? [], roles_after: [], rationale: `${str(i, "rationale") || "disabled"}${o["changed"] === false ? " (no change: already disabled)" : ""}`, by: ctx.actor.kind === "human" ? ctx.actor.id : null })); } },

  { name: "staff.access.review", kind: "act", ruleSetVersion: STAFF_RULE_SET_VERSION, humanRoles: [...ACCESS_REVIEW_ROLES], guardrails: GUARDS,
    handler: compute(async (i, ctx, rt) => staffAccessReview(depsOf(ctx, rt), { decisions: (Array.isArray(i["decisions"]) ? i["decisions"] : []) as ReviewInput[], rationale: typeof i["rationale"] === "string" ? i["rationale"] : null })),
    decision: (i, output, ctx) => { const o = obj(output); const users = Array.isArray(o["users"]) ? (o["users"] as P[]) : []; return asDecision(staffDecision({ action: "staff.access.review", staff_user_id: String(o["reviewed_by"] ?? ctx.actor.id), roles_before: [], roles_after: [], subject: { kind: "staff_access_review", id: String(o["review_id"] ?? "") }, rationale: `${str(i, "rationale") || "quarterly access review"}; ${users.length} active users reviewed (${users.map((u) => `${String(u["staff_user_id"])}: ${String(u["decision"])}`).join(", ")}), ${String(o["changes"] ?? 0)} changes applied through staff.role.set / staff.disable; 34.1 rule 6 — SM_STAFF_ACCESS_REVIEW_90 satisfied and re-armed 90 days out`, by: ctx.actor.kind === "human" ? ctx.actor.id : null })); } },
]);
export const STAFF_TOOLS = TOOLS_34_1.map((t) => t.name);
