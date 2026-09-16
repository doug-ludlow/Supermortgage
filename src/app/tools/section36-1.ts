/**
 * §36.1 process-owned tool — the `security-records` agent's `partner.user.invite` (spec/sections/36-servicing-partner-portal/
 * 36-1-*.md "AI agent design"), defined with `defineTools("36.1", "security-records", defs)` and spread by ./index.ts. The one
 * tool this process owns: the doors are not tools (they are the partner runtime's door service, src/runtime/partner-portal/auth.ts,
 * and open the only path to a partner_sessions row); everything a partner user does after the door is a read through 34.3's
 * tools or the one write, 33.1's `book.import` (36.2) — each dispatched with the partner actor and the tenant from the session.
 *
 *   partner.user.invite  act   rule 8: `{partner_party_id, email, name, roles}` → partner_users{status = invited} with the roles named
 *                              (any subset of partner_admin / partner_ops / partner_auditor), NTC_SM_PARTNER_USER_INVITE by e-mail, the
 *                              decision {partner_user_id, partner_party_id, action: invite, roles, rationale, by, rule set
 *                              partner_portal.access.v1, model deterministic, prompt 36.1-v1, confidence 1}. Who: staff `ops_analyst` /
 *                              `admin` for any tenant (the first partner_admin — the only way a tenant gets a user), a `partner_admin`
 *                              for their own tenant only (partner_party_id from the actor's row, never the body), the seed's system
 *                              actor outside production. The act verifies the actor from rows (src/runtime/partner-portal/auth.ts
 *                              requirePartnerInviter) — a forged `{human, <id>, partner_admin}` with no row is ROLE_DENIED.
 *
 * Open question 2 (how the bus accepts the partner actor): the bus checks a tool's own `humanRoles` (src/app/commands.ts hasRole),
 * not HUMAN_ROLES — so `partner_admin` is named here beside the two staff roles, exactly as 34.1 names `admin` (a StaffRole that is
 * not a HumanRole either); the three partner roles live in src/runtime/partner-portal/roles.ts and are not added to HUMAN_ROLES.
 *
 * Guardrails (the paragraph's list, the ones an input can trip): TWO_FACTORS (34.1's — an input asking to open a session on one
 * factor is refused; no tool here opens a session at all), NO_SELF_ROLE_CHANGE (the caller's own row — `partner_user_id` naming the
 * actor; the handler also refuses the caller's own e-mail), NO_PII_IN_LOG (34.1's — an input asking the action log to carry a
 * name, an e-mail, a phone, a code, a token or a figure is refused). NOT_FOUND, ROLE_REQUIRED, LOAN_MONITORED and
 * ANALYST_NEVER_DECIDES are the routes' and the called sections' (src/runtime/partner-portal/scope.ts, roles.ts; 33.1; 33.2).
 */
import { defineTools, compute, never, guard, str, type ToolDef, type ToolInput, type ToolRuntime, PortUnavailable } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import type { Queryable } from "../../infra/db/client.ts";
import type { Runtime } from "../../runtime/app.ts";
import { partnerInvite, partnerInviteDecision, PARTNER_RULE_SET_VERSION, STAFF_PROVISION_ROLES, type PartnerActDeps } from "../../runtime/partner-portal/auth.ts";
import { NO_SELF_ROLE_CHANGE as SELF } from "../../runtime/partner-portal/roles.ts";

type P = Record<string, unknown>;
const PROCESS_36_1 = "36.1"; const AGENT = "security-records";
const obj = (v: unknown): P => (v && typeof v === "object" && !Array.isArray(v) ? (v as P) : {});
const dbOf = (rt: ToolRuntime): Queryable => { const db = rt.services["db"] as Queryable | undefined; if (!db) throw new PortUnavailable("service:db"); return db; };
const runtimeOf = (rt: ToolRuntime): Runtime => { const r = rt.services["runtime"] as Runtime | undefined; if (!r) throw new PortUnavailable("service:runtime"); return r; };
const deferOf = (rt: ToolRuntime): PartnerActDeps["deferWrite"] => { const f = rt.services["deferWrite"] as PartnerActDeps["deferWrite"] | undefined; if (!f) throw new PortUnavailable("service:deferWrite"); return f; };
const depsOf = (ctx: CommandContext, rt: ToolRuntime): PartnerActDeps => ({ runtime: runtimeOf(rt), db: dbOf(rt), events: ctx.events, clock: ctx.clock, now: ctx.now, actor: ctx.actor, escalations: rt.escalations, deferWrite: deferOf(rt),
  decide: (d) => ctx.decide({ ...d, ...(ctx.actor.kind === "human" ? { approvedBy: ctx.actor.id, ...(ctx.actor.role ? { approvedRole: ctx.actor.role } : {}) } : {}) }) });

// ───────── guardrails ─────────
const oneFactorAsked = (i: ToolInput): string | null => {
  for (const k of ["single_factor", "one_factor", "skip_password", "skip_possession", "skip_code", "code_only", "passkey_only", "password_only", "no_second_factor", "bypass_mfa", "open_session"]) if (i[k] === true) return `input carries \`${k}\``;
  if (Array.isArray(i["factors"]) && (i["factors"] as unknown[]).length < 2) return `input asks for factors [${(i["factors"] as unknown[]).map(String).join(", ")}]`;
  return null;
};
const TWO_FACTORS = never("TWO_FACTORS", "36.1 rule 1 'Two factors, always; the mechanics are 34.1's' / Verified requirement: 16 CFR §314.4(c)(5) — 'a code alone never opens a partner session, and a password alone never does'", (i) => oneFactorAsked(i) !== null, "a partner session opens only after a possession factor (the code to the e-mail on the partner user row, or a registered passkey) AND the password; no session on one factor, and no tool opens one");
const NO_SELF_ROLE_CHANGE = guard(SELF.code, SELF.citation, (i, ctx) => (ctx.actor.kind === "human" && !!ctx.actor.id && str(i, "partner_user_id") === ctx.actor.id ? `${ctx.actor.id} may not change their own roles or standing` : undefined));
const PII_KEYS = new Set(["email", "e_mail", "email_address", "phone", "phone_number", "mobile", "name", "legal_name", "first_name", "last_name", "password", "code", "token", "amount", "amount_cents", "balance_cents", "upb_cents", "ssn", "tin", "date_of_birth", "address"]);
const piiInLog = (i: ToolInput): string | null => { for (const k of ["log", "action_log", "audit", "log_fields", "partner_action"]) { const hit = Object.keys(obj(i[k])).find((x) => PII_KEYS.has(x)); if (hit) return `\`${k}.${hit}\``; } return null; };
const NO_PII_IN_LOG = never("NO_PII_IN_LOG", "36.1 rule 5 'Everything is logged, nothing sensitive is': 'the row carries ids and the role and never a homeowner's name, e-mail or phone, a money figure or a filter's text'", (i) => piiInLog(i) !== null, "the partner action log carries the person, the tenant, the role, the action, the subject ids and the result — never a name, an e-mail, a phone, a code, a token or a figure");
const GUARDS = [TWO_FACTORS, NO_SELF_ROLE_CHANGE, NO_PII_IN_LOG];

type Decision = NonNullable<ReturnType<NonNullable<ToolDef["decision"]>>>;
const asDecision = (d: ReturnType<typeof partnerInviteDecision>): Decision => ({ action: d.action, rationale: d.rationale, ...(d.subject ? { subject: d.subject } : {}), modelVersion: d.modelVersion, promptVersion: d.promptVersion, confidence: d.confidence } as unknown as Decision);

// ───────── the tool ─────────
export const TOOLS_36_1: readonly ToolDef[] = defineTools(PROCESS_36_1, AGENT, [
  { name: "partner.user.invite", kind: "act", ruleSetVersion: PARTNER_RULE_SET_VERSION, humanRoles: [...STAFF_PROVISION_ROLES, "partner_admin"], guardrails: GUARDS,
    handler: compute(async (i, ctx, rt) => partnerInvite(depsOf(ctx, rt), { partner_party_id: typeof i["partner_party_id"] === "string" ? i["partner_party_id"] : null, email: str(i, "email"), name: typeof i["name"] === "string" ? i["name"] : null, roles: i["roles"], rationale: typeof i["rationale"] === "string" ? i["rationale"] : null })),
    decision: (i, output, ctx) => { const o = obj(output); return asDecision(partnerInviteDecision({ partner_user_id: String(o["partner_user_id"] ?? ""), partner_party_id: String(o["partner_party_id"] ?? str(i, "partner_party_id")), roles: (o["roles"] as string[] | undefined) ?? [], reinvited: o["reinvited"] === true, rationale: str(i, "rationale") || "the invitee is a distinct natural person at the partner (the inviter's attestation)", by: ctx.actor.kind === "human" ? ctx.actor.id : null })); } },
]);
export const PARTNER_PORTAL_TOOLS = TOOLS_36_1.map((t) => t.name);
