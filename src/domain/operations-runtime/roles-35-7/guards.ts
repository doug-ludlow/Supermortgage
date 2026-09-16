/**
 * §35.7 bus guardrails (AI agent design): pure predicates over (input, ctx) — never a store — refused before anything runs
 * and returned in the CommandRefused shape. NO_SELF_ASSERTED_ACTOR / APPROVER_NOT_SELF_ASSERTED refuse an input that names an
 * actor or an approver (rule 2: the actor is the session's or the principal's); UNKNOWN_ROLE (rule 1); NO_SELF_ROLE_CHANGE
 * (34.1's, inherited); NO_BREAKGLASS_INDEPENDENT_ROLE (rule 8); NO_FAKE_IN_PRODUCTION and TWO_PERSON_HANDOVER refuse the
 * input keys that would waive rules 6–7; NO_MONEY_FIELD (rule 10) and NO_CLOCK_EDIT (the scan never touches a section's clock)
 * copy 34.4's. SHARED_TOKEN_REFUSED_IN_PRODUCTION is the /v1 door's (v1-auth.ts) — no tool sees the token.
 */
import { guard, never, str, type ToolInput } from "../../../app/tools.ts";
import type { CommandContext } from "../../../app/commands.ts";
import { HUMAN_ROLES } from "../../../app/roles.ts";
import { NO_SELF_ROLE_CHANGE as SELF, isSelfChange } from "../../../runtime/staff/roles.ts";
import { INDEPENDENCE_ROLES } from "./types.ts";

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const MONEY_RE = /(_cents|amount|balance|upb|payoff|fee|rate|charge|waive|write_?off)/i;
const moneyKey = (i: ToolInput): string | null => { for (const k of [...Object.keys(i), ...Object.keys(obj(i["changes"])), ...Object.keys(obj(i["data"]))]) if (MONEY_RE.test(k) && k !== "pending_items" && k !== "open_items") return k; return null; };

export const NO_MONEY_FIELD = never("NO_MONEY_FIELD", "35.7 rule 10: 'Nothing here changes a money field. The tools write their own rows and the mirror; a waiver stays the owning section's officer command'", (i) => moneyKey(i) !== null, "this process changes who may act, never a money field or a figure");
export const NO_CLOCK_EDIT = never("NO_CLOCK_EDIT", "35.7 AI agent design: 'NO_CLOCK_EDIT (the queue scan satisfies and arms only through its own events; it never touches a section's clock)'", (i) => ["timer_id", "timer", "clock", "due_at", "due_date", "extend", "cancel_timer", "satisfy", "satisfied_at"].some((k) => i[k] !== undefined) || str(i, "op") === "edit_clock", "a section's clock moves only through the engine on the owner's events");
export const NO_SELF_ASSERTED_ACTOR = never("NO_SELF_ASSERTED_ACTOR", "35.7 rule 2: 'Never self-asserted. On /v1 the actor is the principal's, not the body's'; on the console the session's (34.1 rule 3)", (i) => ["actor", "as_actor", "act_as", "on_behalf_of", "impersonate", "staff_user_id_override", "actor_id"].some((k) => i[k] !== undefined), "the actor is the verified principal's or the session's; an input that names one is refused");
export const APPROVER_NOT_SELF_ASSERTED = never("APPROVER_NOT_SELF_ASSERTED", "35.7 rule 2: 'a body approvedBy is refused APPROVER_NOT_SELF_ASSERTED whatever it says'; the approval is a record by roles.approve", (i) => ["approvedBy", "approved_by", "approver", "approvals", "approved_role"].some((k) => i[k] !== undefined), "an approval is a record written by a distinct verified person (roles.approve), never an input");
export const UNKNOWN_ROLE = never("UNKNOWN_ROLE", "35.7 rule 1: 'A grant of admin or of a word outside the list is refused UNKNOWN_ROLE{role} before any read'", (i) => typeof i["role"] === "string" && !(HUMAN_ROLES as readonly string[]).includes(i["role"]), "the role is one of the kernel's twenty-two human roles (src/app/roles.ts HUMAN_ROLES); admin is a console role, never a reviewer role");
export const NO_SELF_ROLE_CHANGE = guard(SELF.code, `${SELF.citation}; 35.7 edge cases: 'An admin grants a reviewer role to themselves → NO_SELF_ROLE_CHANGE'`, (i: ToolInput, ctx: CommandContext) => (ctx.actor.kind === "human" && !!str(i, "staff_user_id") && isSelfChange(ctx.actor.id, str(i, "staff_user_id")) ? `${ctx.actor.id} may not change their own roles` : undefined));
export const NO_BREAKGLASS_INDEPENDENT_ROLE = never("NO_BREAKGLASS_INDEPENDENT_ROLE", "35.7 rule 8: 'qc_officer, funding_approver, ciso and bsa_officer cannot be broken into'", (i) => str(i, "op") !== "review" && typeof i["role"] === "string" && INDEPENDENCE_ROLES.includes(i["role"]), "an independence role is never assumed by break-glass");
export const NO_FAKE_IN_PRODUCTION = never("NO_FAKE_IN_PRODUCTION", "35.7 rule 6: 'ENVIRONMENT = production forces ∅ whatever the other two say (NO_FAKE_IN_PRODUCTION)'", (i) => ["fake_reviewers", "fake_set", "fake_on", "fake_roles", "force_fake"].some((k) => i[k] !== undefined), "the FAKE set is the environment's default minus the handovers, read from Postgres — never an input");
export const TWO_PERSON_HANDOVER = never("TWO_PERSON_HANDOVER", "35.7 rule 7: 'handover.enable for a role is requested by compliance and confirmed by a different admin within 10 minutes, refused TWO_PERSON_HANDOVER when the confirmer is the requester'", (i) => ["confirmed", "confirmed_by", "self_confirm", "skip_confirmation", "force", "single_person"].some((k) => i[k] !== undefined && i[k] !== false), "the handover is two people's decision; an input that waives the second person is refused");
export const COMMON_GUARDS = [NO_SELF_ASSERTED_ACTOR, APPROVER_NOT_SELF_ASSERTED, NO_MONEY_FIELD, NO_CLOCK_EDIT];
