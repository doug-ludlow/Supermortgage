/**
 * §35.7 process-owned tools — the `security-records` agent's `roles.grant`, `roles.revoke`, `roles.queue`, `roles.approve`,
 * `roles.breakglass`, `principals.issue`, `principals.revoke`, `handover.plan`, `handover.enable`, `handover.board` and
 * `writeDecision` (spec/sections/35-operations-runtime/35-7-*.md "AI agent design"), defined with
 * `defineTools("35.7", "security-records", defs)` and spread by ./index.ts; every string is one spec/registry/agents.json
 * names for 35.7. Thin bus wrappers over src/domain/operations-runtime/roles-35-7/* (the acts), run in the command's unit
 * of work with 34.1's StaffActDeps: rows are deferred into the command's transaction, events ride ctx.events, so a refusal
 * writes nothing. Every action tool is a person's (`humanOnly`); the agent scans the queues, keeps the board and mirrors the
 * identities unprompted from the sweep (roles-35-7/sweep.ts) and proposes nothing about people.
 *
 *   roles.grant        act   admin: a kernel role for a person other than themselves (UNKNOWN_ROLE, NO_SELF_ROLE_CHANGE, ROLE_DISJOINT);
 *                            an independence role is `pending{request_id}` until `op: confirm` by a different compliance member within
 *                            10 minutes (CONFIRMER_IS_HOLDER); the row, reviewer_roles, the identities mirror, `role.granted`, and
 *                            `role.staffed{cause: grant}` when the role's queue was unstaffed.
 *   roles.revoke       act   admin: the revoke row, the word dropped, the person's sessions revoked, `role.revoked`.
 *   roles.queue        read  the latest snapshot per role and one role's open items, paged.
 *   roles.approve      act   a distinct verified holder of the request's role: `dual_control.approved` — the only way an approval record exists.
 *   roles.breakglass   act   compliance | officer: a role for one subject and 4 hours (`op: review` by a different compliance member).
 *   principals.issue   act   admin: a /v1 credential — the token once in the output, its sha-256 in the row.
 *   principals.revoke  act   admin.
 *   handover.plan      act   compliance | admin: per role the holders, the sign-ins, the open items and what is missing (HANDOVER_NEEDS_HOLDER).
 *   handover.enable    act   `op: request` (compliance) | `confirm` (a different admin, 10 minutes; TWO_PERSON_HANDOVER) | `revert` (nonprod; the same two).
 *   handover.board     read  the 35.8 screen: twenty-two rows of ids, dates, counts and codes.
 *   writeDecision      act   the generic decision row.
 * SHARED_TOKEN_REFUSED_IN_PRODUCTION (rule 2) is the /v1 door's refusal (roles-35-7/v1-auth.ts): no tool sees the token.
 * Decision record (every action tool): {subject: {kind: grant | principal | handover | breakglass | approval | scan, id}, action, environment,
 * role?, by, by_role, confirmed_by?, reason, rule_set_version: roles.v1, model_version: deterministic, prompt_version: 35.7-v1, confidence: 1}.
 */
import { defineTools, compute, decision, str, PortUnavailable, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import type { Queryable } from "../../infra/db/client.ts";
import type { Runtime } from "../../runtime/app.ts";
import type { StaffActDeps } from "../../runtime/staff/auth.ts";
import { HUMAN_ROLES } from "../roles.ts";
import { rolesDecision, byOf, type DecisionSubjectKind } from "../../domain/operations-runtime/roles-35-7/decision.ts";
import { grantRole, confirmGrant, revokeGrant } from "../../domain/operations-runtime/roles-35-7/grants.ts";
import { breakGlass, reviewBreakGlass } from "../../domain/operations-runtime/roles-35-7/breakglass.ts";
import { issuePrincipal, revokePrincipal } from "../../domain/operations-runtime/roles-35-7/principals.ts";
import { approveRequest } from "../../domain/operations-runtime/roles-35-7/dual-control.ts";
import { roleQueue } from "../../domain/operations-runtime/roles-35-7/queue.ts";
import { handoverBoard, handoverEnable, handoverPlan } from "../../domain/operations-runtime/roles-35-7/handover.ts";
import { APPROVER_NOT_SELF_ASSERTED, COMMON_GUARDS, NO_BREAKGLASS_INDEPENDENT_ROLE, NO_CLOCK_EDIT, NO_FAKE_IN_PRODUCTION, NO_MONEY_FIELD, NO_SELF_ASSERTED_ACTOR, NO_SELF_ROLE_CHANGE, TWO_PERSON_HANDOVER, UNKNOWN_ROLE } from "../../domain/operations-runtime/roles-35-7/guards.ts";
import { PROCESS_35_7, ROLES_AGENT, ROLES_RULE_SET_VERSION } from "../../domain/operations-runtime/roles-35-7/types.ts";

type P = Record<string, unknown>;
const obj = (v: unknown): P => (v && typeof v === "object" && !Array.isArray(v) ? (v as P) : {});
const dbOf = (rt: ToolRuntime): Queryable => { const db = rt.services["db"] as Queryable | undefined; if (!db) throw new PortUnavailable("service:db"); return db; };
const runtimeOf = (rt: ToolRuntime): Runtime => { const r = rt.services["runtime"] as Runtime | undefined; if (!r) throw new PortUnavailable("service:runtime"); return r; };
const deferOf = (rt: ToolRuntime): StaffActDeps["deferWrite"] => { const f = rt.services["deferWrite"] as StaffActDeps["deferWrite"] | undefined; if (!f) throw new PortUnavailable("service:deferWrite"); return f; };
const depsOf = (ctx: CommandContext, rt: ToolRuntime): StaffActDeps => ({ runtime: runtimeOf(rt), db: dbOf(rt), events: ctx.events, clock: ctx.clock, now: ctx.now, actor: ctx.actor, escalations: rt.escalations, deferWrite: deferOf(rt), decide: (d) => ctx.decide(d) });
const envOf = (i: ToolInput, rt: ToolRuntime): string => (typeof i["environment"] === "string" && i["environment"].trim() ? i["environment"].trim() : runtimeOf(rt).environment);
const opt = (i: ToolInput, k: string): string | null => (typeof i[k] === "string" && (i[k] as string).trim() ? (i[k] as string) : null);
type Decision = NonNullable<ReturnType<NonNullable<ToolDef["decision"]>>>;
/** The decision builder of an action tool: the record schema over the output (the subject id the handler minted) and the actor. */
const dec = (kind: DecisionSubjectKind, idKey: string, action: (i: ToolInput, o: P) => string, reason: (i: ToolInput, o: P) => string, role?: (i: ToolInput, o: P) => string | null, confirmed?: (i: ToolInput, o: P) => string | null | undefined) => (i: ToolInput, output: unknown, ctx: CommandContext): Decision => {
  const o = obj(output);
  return rolesDecision({ subject: { kind, id: String(o[idKey] ?? str(i, idKey) ?? "") }, action: action(i, o), environment: String(o["environment"] ?? str(i, "environment") ?? ""), role: role ? role(i, o) : (o["role"] as string | undefined) ?? null, by: typeof o["by"] === "string" && o["by"] ? o["by"] : byOf(ctx.actor), by_role: ctx.actor.role ?? null, ...(confirmed ? { confirmed_by: confirmed(i, o) ?? null } : {}), reason: reason(i, o) }) as unknown as Decision;
};
const READ_ROLES = ["ops_analyst", "officer", "compliance", "admin"];   // handover.board (spec Inputs)
const QUEUE_ROLES = ["ops_analyst", "compliance", "admin"];             // roles.queue (spec Inputs: no officer)

export const TOOLS_35_7: readonly ToolDef[] = defineTools(PROCESS_35_7, ROLES_AGENT, [
  { name: "roles.grant", kind: "act", humanOnly: true, ruleSetVersion: ROLES_RULE_SET_VERSION, humanRoles: ["admin", "compliance"], guardrails: [...COMMON_GUARDS, UNKNOWN_ROLE, NO_SELF_ROLE_CHANGE],
    handler: compute(async (i, ctx, rt) => { const op = str(i, "op") || (opt(i, "request_id") ? "confirm" : "grant"); const d = depsOf(ctx, rt);
      if (op === "confirm") return confirmGrant(d, { request_id: str(i, "request_id"), environment: envOf(i, rt) });
      if (op !== "grant") throw new RangeError("roles.grant op ∈ {grant, confirm}");
      return grantRole(d, { staff_user_id: str(i, "staff_user_id"), role: str(i, "role"), environment: envOf(i, rt), rationale: opt(i, "rationale") }); }),
    decision: dec("grant", "grant_id", (i, o) => (o["status"] === "pending" ? "roles.grant:request" : (str(i, "op") || (opt(i, "request_id") ? "confirm" : "grant")) === "confirm" ? "roles.grant:confirm" : "roles.grant"), (i, o) => `${String(o["status"])}: ${String(o["role"])} for staff_user ${String(o["staff_user_id"])}${o["request_id"] ? ` (request ${String(o["request_id"])})` : ""}; rationale: ${opt(i, "rationale") ?? "(none)"}`, undefined, (_i, o) => (o["confirmed_by"] as string | null | undefined) ?? null) },
  { name: "roles.revoke", kind: "act", humanOnly: true, ruleSetVersion: ROLES_RULE_SET_VERSION, humanRoles: ["admin"], guardrails: [...COMMON_GUARDS, NO_SELF_ROLE_CHANGE],
    handler: compute(async (i, ctx, rt) => revokeGrant(depsOf(ctx, rt), { grant_id: opt(i, "grant_id"), staff_user_id: opt(i, "staff_user_id"), role: opt(i, "role"), environment: envOf(i, rt), rationale: opt(i, "rationale") })),
    decision: dec("grant", "grant_id", () => "roles.revoke", (i, o) => `revoked ${String(o["role"])} from staff_user ${String(o["staff_user_id"])}; sessions revoked: ${(o["sessions_revoked"] as string[] | undefined)?.length ?? 0}; rationale: ${opt(i, "rationale") ?? "(none)"}`) },
  { name: "roles.queue", kind: "read", ruleSetVersion: ROLES_RULE_SET_VERSION, humanRoles: QUEUE_ROLES, guardrails: [NO_MONEY_FIELD, NO_CLOCK_EDIT],
    handler: compute(async (i, _ctx, rt) => roleQueue(runtimeOf(rt), { environment: opt(i, "environment"), role: opt(i, "role"), page: Number(i["page"] ?? 1), page_size: Number(i["page_size"] ?? 100) })) },
  { name: "roles.approve", kind: "act", humanOnly: true, ruleSetVersion: ROLES_RULE_SET_VERSION, humanRoles: [...HUMAN_ROLES], guardrails: [...COMMON_GUARDS],
    handler: compute(async (i, ctx, rt) => approveRequest(depsOf(ctx, rt), { request_id: str(i, "request_id"), environment: envOf(i, rt) })),
    decision: dec("approval", "request_id", () => "roles.approve", (_i, o) => `approved ${String(o["command"])} on ${o["subject"] ? `${String(obj(o["subject"])["kind"])} ${String(obj(o["subject"])["id"])}` : "the platform"} requested by ${String(o["requested_by"])}`, (_i, o) => (o["approved_role"] as string | undefined) ?? null) },
  { name: "roles.breakglass", kind: "act", humanOnly: true, ruleSetVersion: ROLES_RULE_SET_VERSION, humanRoles: ["compliance", "officer"], guardrails: [...COMMON_GUARDS, UNKNOWN_ROLE, NO_BREAKGLASS_INDEPENDENT_ROLE],
    handler: compute(async (i, ctx, rt) => { const d = depsOf(ctx, rt); const op = str(i, "op") || (opt(i, "breakglass_id") ? "review" : "use");
      if (op === "review") return reviewBreakGlass(d, { breakglass_id: str(i, "breakglass_id"), disposition: str(i, "disposition"), reason: opt(i, "reason"), environment: envOf(i, rt) });
      return breakGlass(d, { role: str(i, "role"), subject: i["subject"], reason: str(i, "reason"), environment: envOf(i, rt) }); }),
    decision: dec("breakglass", "breakglass_id", (i) => ((str(i, "op") || (opt(i, "breakglass_id") ? "review" : "use")) === "review" ? "roles.breakglass:review" : "roles.breakglass"), (i, o) => (o["disposition"] ? `reviewed ${String(o["breakglass_id"])}: ${String(o["disposition"])}; ${opt(i, "reason") ?? "(no reason)"}` : `${o["existing"] ? "existing " : ""}break-glass ${String(o["role"])} on ${String(obj(o["subject"])["kind"])} ${String(obj(o["subject"])["id"])} until ${String(o["expires_at"])}; reason: ${str(i, "reason")}`)) },
  { name: "principals.issue", kind: "act", humanOnly: true, ruleSetVersion: ROLES_RULE_SET_VERSION, humanRoles: ["admin"], guardrails: [...COMMON_GUARDS],
    handler: compute(async (i, ctx, rt) => issuePrincipal(depsOf(ctx, rt), { kind: str(i, "kind"), staff_user_id: opt(i, "staff_user_id"), party_id: opt(i, "party_id"), name: str(i, "name"), scopes: i["scopes"], expires_at: str(i, "expires_at"), environment: envOf(i, rt) })),
    decision: dec("principal", "principal_id", () => "principals.issue", (_i, o) => `issued a ${String(o["kind"])} principal ${String(o["name"])}${o["staff_user_id"] ? ` for staff_user ${String(o["staff_user_id"])}` : ""}, scopes ${JSON.stringify(o["scopes"] ?? {})}, expires ${String(o["expires_at"])}`) },
  { name: "principals.revoke", kind: "act", humanOnly: true, ruleSetVersion: ROLES_RULE_SET_VERSION, humanRoles: ["admin"], guardrails: [...COMMON_GUARDS],
    handler: compute(async (i, ctx, rt) => revokePrincipal(depsOf(ctx, rt), { principal_id: str(i, "principal_id"), rationale: opt(i, "rationale"), environment: envOf(i, rt) })),
    decision: dec("principal", "principal_id", () => "principals.revoke", (i, o) => `${o["revoked"] ? "revoked" : "already revoked"} principal ${String(o["principal_id"])}; rationale: ${opt(i, "rationale") ?? "(none)"}`) },
  { name: "handover.plan", kind: "act", humanOnly: true, ruleSetVersion: ROLES_RULE_SET_VERSION, humanRoles: ["compliance", "admin"], guardrails: [NO_SELF_ASSERTED_ACTOR, APPROVER_NOT_SELF_ASSERTED, NO_FAKE_IN_PRODUCTION, NO_MONEY_FIELD, NO_CLOCK_EDIT],
    handler: compute(async (i, ctx, rt) => handoverPlan(depsOf(ctx, rt), { environment: envOf(i, rt) })),
    decision: dec("handover", "plan_id", () => "handover.plan", (_i, o) => { const rows = (o["roles"] as P[] | undefined) ?? []; return `planned ${String(o["environment"])}: ${rows.filter((r) => r["plan"] === "ready").length} ready, ${rows.filter((r) => r["plan"] !== "ready").map((r) => `${String(r["role"])}: HANDOVER_NEEDS_HOLDER{missing: ${String(r["missing"])}}`).join("; ") || "none missing"}`; }) },
  { name: "handover.enable", kind: "act", humanOnly: true, ruleSetVersion: ROLES_RULE_SET_VERSION, humanRoles: ["compliance", "admin"], guardrails: [NO_SELF_ASSERTED_ACTOR, APPROVER_NOT_SELF_ASSERTED, UNKNOWN_ROLE, NO_FAKE_IN_PRODUCTION, TWO_PERSON_HANDOVER, NO_MONEY_FIELD, NO_CLOCK_EDIT],
    handler: compute(async (i, ctx, rt) => { const op = str(i, "op") || (opt(i, "request_id") ? "confirm" : "request"); if (op !== "request" && op !== "confirm" && op !== "revert") throw new RangeError("handover.enable op ∈ {request, confirm, revert}");
      return handoverEnable(depsOf(ctx, rt), { op, environment: envOf(i, rt), role: opt(i, "role"), request_id: opt(i, "request_id"), rationale: opt(i, "rationale") }); }),
    decision: (i, output, ctx) => { const o = obj(output); return rolesDecision({ subject: { kind: "handover", id: `${String(o["environment"])}:${String(o["role"])}` }, action: `handover.enable:${str(i, "op") || (opt(i, "request_id") ? "confirm" : "request")}`, environment: String(o["environment"] ?? ""), role: (o["role"] as string | undefined) ?? null, by: byOf(ctx.actor), by_role: ctx.actor.role ?? null, confirmed_by: (o["confirmed_by"] as string | null | undefined) ?? null, reason: `${String(o["status"])}: ${String(o["role"])} in ${String(o["environment"])}${o["request_id"] ? ` (request ${String(o["request_id"])})` : ""}; holders ${JSON.stringify(o["holders"] ?? [])}; pending_items ${String(o["pending_items"] ?? "null")}` }) as unknown as Decision; } },
  { name: "handover.board", kind: "read", ruleSetVersion: ROLES_RULE_SET_VERSION, humanRoles: READ_ROLES, guardrails: [NO_MONEY_FIELD, NO_CLOCK_EDIT],
    handler: compute(async (i, _ctx, rt) => handoverBoard(runtimeOf(rt), { environment: opt(i, "environment") })) },
  { name: "writeDecision", kind: "act", ruleSetVersion: ROLES_RULE_SET_VERSION, handler: decision() },
]);
export const ROLES_TOOLS = TOOLS_35_7.map((t) => t.name);
