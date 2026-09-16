/**
 * §35.12 process-owned tools — the `compliance-sentinel` agent's `posture.record`, `posture.check`, `posture.drift.resolve`,
 * `integrations.switch`, `integrations.status`, `backup.drill`, `data.scan`, `parallel_run.open`, `parallel_run.reconcile`,
 * `parallel_run.disposition`, `parallel_run.close`, `go_live.check`, `go_live.attest` and `writeDecision`
 * (spec/sections/35-operations-runtime/35-12-production-posture.md "AI agent design"), defined with
 * `defineTools("35.12", "compliance-sentinel", defs)` and spread by ./index.ts; every string is one spec/registry/agents.json names
 * for 35.12. Thin bus wrappers over src/domain/operations-runtime/posture-35-12/* (the acts), run in the command's unit of work:
 * rows are deferred into the command's transaction, events ride ctx.events, so a refusal writes nothing. The agent computes every
 * check, scan, reconciliation and checklist unprompted (the cycles and the sweep run these tools as `{kind: agent, id:
 * compliance-sentinel}`); the people's acts are `humanOnly`: the ciso resolves drift, requests switches, runs drills and requests
 * the attestation; compliance confirms switches and the attestation; the officer opens, dispositions and closes the parallel run.
 * The agent never edits infrastructure (POSTURE_IS_OBSERVED), never closes a finding by hand (FINDING_CLOSES_BY_EVIDENCE), never
 * dispositions a diff (it proposes one — `parallel_run.disposition{op: propose}` — with a confidence) and never attests.
 * Decision record (every action tool): posture-35-12/decision.ts.
 */
import { defineTools, compute, decision, str, PortUnavailable, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import type { Queryable } from "../../infra/db/client.ts";
import type { Runtime } from "../../runtime/app.ts";
import { postureDecision, byOf, type DecisionSubjectKind } from "../../domain/operations-runtime/posture-35-12/decision.ts";
import type { PostureDeps } from "../../domain/operations-runtime/posture-35-12/deps.ts";
import { recordManifest } from "../../domain/operations-runtime/posture-35-12/manifests.ts";
import { runPostureCheck } from "../../domain/operations-runtime/posture-35-12/check.ts";
import { resolveFinding } from "../../domain/operations-runtime/posture-35-12/findings.ts";
import { integrationsStatus, switchVendor } from "../../domain/operations-runtime/posture-35-12/switches.ts";
import { REAL_ADAPTER_VENDORS } from "../../domain/operations-runtime/posture-35-12/real-ports.ts";
import { COMMON_GUARDS, FINDING_CLOSES_BY_EVIDENCE, NO_FAKE_IN_PRODUCTION, NO_PII_IN_EVIDENCE, NO_REAL_DATA_IN_NONPROD, TWO_PERSON_SWITCH } from "../../domain/operations-runtime/posture-35-12/guards.ts";
import { POSTURE_AGENT, POSTURE_RULE_SET_VERSION, PROCESS_35_12, obj, s } from "../../domain/operations-runtime/posture-35-12/types.ts";

type P = Record<string, unknown>;
const dbOf = (rt: ToolRuntime): Queryable => { const db = rt.services["db"] as Queryable | undefined; if (!db) throw new PortUnavailable("service:db"); return db; };
const runtimeOf = (rt: ToolRuntime): Runtime => { const r = rt.services["runtime"] as Runtime | undefined; if (!r) throw new PortUnavailable("service:runtime"); return r; };
const deferOf = (rt: ToolRuntime): PostureDeps["deferWrite"] => { const f = rt.services["deferWrite"] as PostureDeps["deferWrite"] | undefined; if (!f) throw new PortUnavailable("service:deferWrite"); return f; };
const depsOf = (ctx: CommandContext, rt: ToolRuntime): PostureDeps => ({ runtime: runtimeOf(rt), db: dbOf(rt), events: ctx.events, clock: ctx.clock, now: ctx.now, actor: ctx.actor, escalations: rt.escalations, deferWrite: deferOf(rt), decide: (d) => ctx.decide({ agent: POSTURE_AGENT, ruleSetVersion: POSTURE_RULE_SET_VERSION, ...d }) });
const envOf = (i: ToolInput, rt: ToolRuntime): string => (typeof i["environment"] === "string" && i["environment"].trim() ? i["environment"].trim() : runtimeOf(rt).environment);
const opt = (i: ToolInput, k: string): string | null => (typeof i[k] === "string" && (i[k] as string).trim() ? (i[k] as string) : null);
type Decision = NonNullable<ReturnType<NonNullable<ToolDef["decision"]>>>;
/** The decision builder of an action tool: the record schema over the output (the subject id the handler minted) and the actor. */
const dec = (kind: DecisionSubjectKind, idKey: string, action: (i: ToolInput, o: P) => string, reason: (i: ToolInput, o: P) => string, extra: (i: ToolInput, o: P) => Partial<Parameters<typeof postureDecision>[0]> = () => ({})) => (i: ToolInput, output: unknown, ctx: CommandContext): Decision => {
  const o = obj(output);
  return postureDecision({ subject: { kind, id: String(o[idKey] ?? str(i, idKey) ?? "") }, environment: String(o["environment"] ?? str(i, "environment") ?? ""), action: action(i, o), by: typeof o["by"] === "string" && o["by"] ? o["by"] : byOf(ctx.actor), by_role: ctx.actor.role ?? null, confirmed_by: (o["confirmed_by"] as string | null | undefined) ?? null, reason: reason(i, o), ...(ctx.run ? { model_version: ctx.run.modelVersion, ...(ctx.run.confidence !== undefined ? { confidence: ctx.run.confidence } : {}) } : {}), ...extra(i, o) }) as unknown as Decision;
};
const STATUS_ROLES = ["ops_analyst", "officer", "compliance", "ciso", "admin"];
const CHECK_HUMAN_ROLES = ["compliance", "ciso", "admin"];

export const TOOLS_35_12: readonly ToolDef[] = defineTools(PROCESS_35_12, POSTURE_AGENT, [
  { name: "posture.record", kind: "act", ruleSetVersion: POSTURE_RULE_SET_VERSION, humanRoles: CHECK_HUMAN_ROLES, guardrails: [...COMMON_GUARDS, NO_PII_IN_EVIDENCE, NO_REAL_DATA_IN_NONPROD],
    handler: compute(async (i, ctx, rt) => recordManifest(depsOf(ctx, rt), { ...i, environment: envOf(i, rt) })),
    decision: dec("manifest", "manifest_id", () => "posture.record", (_i, o) => { const c = obj(o["check"]); return `recorded ${String(o["environment"])} manifest ${String(o["manifest_id"])} (env_hash ${String(o["env_hash"]).slice(0, 12)}…, image ${String(o["image_digest"])}, migration_head ${String(o["migration_head"])}); check run ${String(c["run_id"])}: ${String(c["passed"])} pass, ${String(c["failed"])} fail, ${String(c["unverifiable"])} unverifiable, ${String(c["not_applicable"])} n/a; findings opened ${(c["findings_opened"] as unknown[] | undefined)?.length ?? 0}, resolved ${(c["findings_resolved"] as unknown[] | undefined)?.length ?? 0}`; }) },
  { name: "posture.check", kind: "act", ruleSetVersion: POSTURE_RULE_SET_VERSION, humanRoles: CHECK_HUMAN_ROLES, guardrails: [...COMMON_GUARDS, NO_REAL_DATA_IN_NONPROD],
    handler: compute(async (i, ctx, rt) => runPostureCheck(depsOf(ctx, rt), { environment: envOf(i, rt), manifest_id: opt(i, "manifest_id"), trigger: ctx.actor.kind === "human" ? "request" : "cycle" })),
    decision: dec("check_run", "run_id", () => "posture.check", (_i, o) => `posture run ${String(o["run_id"])} for ${String(o["environment"])} on ${String(o["as_of_date"])} over manifest ${String(o["manifest_id"])}: ${String(o["passed"])} pass, ${String(o["failed"])} fail, ${String(o["unverifiable"])} unverifiable, ${String(o["not_applicable"])} n/a; findings opened [${((o["findings_opened"] as P[] | undefined) ?? []).map((f) => String(f["control_code"])).join(", ")}], resolved [${((o["findings_resolved"] as P[] | undefined) ?? []).map((f) => String(f["control_code"])).join(", ")}]; receipt ${String(o["receipt"])}`) },
  { name: "posture.drift.resolve", kind: "act", humanOnly: true, ruleSetVersion: POSTURE_RULE_SET_VERSION, humanRoles: ["ciso"], guardrails: [...COMMON_GUARDS, FINDING_CLOSES_BY_EVIDENCE],
    handler: compute(async (i, ctx, rt) => resolveFinding(depsOf(ctx, rt), { finding_id: str(i, "finding_id"), cause: opt(i, "cause"), exception_id: opt(i, "exception_id"), reason: opt(i, "reason"), op: opt(i, "op") })),
    decision: dec("finding", "finding_id", (_i, o) => `posture.drift.resolve:${String(o["action"])}`, (i, o) => `${String(o["action"])} finding ${String(o["finding_id"])} (${String(o["control_code"])} in ${String(o["environment"])})${o["cause"] ? ` by ${String(o["cause"])}` : ""}${o["exception_id"] ? ` (exception ${String(o["exception_id"])}, expires ${String(o["expires_at"])})` : ""}; reason: ${opt(i, "reason") ?? "(none)"}`, (_i, o) => ({ control_code: s(o["control_code"]) })) },
  { name: "integrations.switch", kind: "act", humanOnly: true, ruleSetVersion: POSTURE_RULE_SET_VERSION, humanRoles: ["ciso", "compliance"], guardrails: [...COMMON_GUARDS, TWO_PERSON_SWITCH, NO_FAKE_IN_PRODUCTION, NO_PII_IN_EVIDENCE],
    handler: compute(async (i, ctx, rt) => switchVendor(depsOf(ctx, rt), { op: opt(i, "op"), environment: envOf(i, rt), vendor: opt(i, "vendor"), mode: opt(i, "mode"), endpoint_class: opt(i, "endpoint_class"), secret_ref: opt(i, "secret_ref"), egress_rule: opt(i, "egress_rule"), rationale: opt(i, "rationale"), request_id: opt(i, "request_id") })),
    decision: (i, output, ctx) => { const o = obj(output); return postureDecision({ subject: { kind: "switch", id: String(o["switch_id"] ?? o["request_id"] ?? "") }, environment: String(o["environment"] ?? ""), action: `integrations.switch:${String(o["status"]) === "switched" ? "confirm" : "request"}`, vendor: s(o["vendor"]), by: String(o["requested_by"] ?? byOf(ctx.actor)), by_role: ctx.actor.role ?? null, confirmed_by: (o["confirmed_by"] as string | null | undefined) ?? null, reason: `${String(o["status"])}: ${String(o["vendor"])} in ${String(o["environment"])} ${String(o["from"])} → ${String(o["to"])} (${String(o["endpoint_class"])}); request ${String(o["request_id"])}; rationale: ${opt(i, "rationale") ?? "(none)"}` }) as unknown as Decision; } },
  { name: "integrations.status", kind: "read", ruleSetVersion: POSTURE_RULE_SET_VERSION, humanRoles: STATUS_ROLES, guardrails: [...COMMON_GUARDS],
    handler: compute(async (i, ctx, rt) => { const r = runtimeOf(rt); return integrationsStatus(dbOf(rt), { environment: envOf(i, rt), integrations: r.env["INTEGRATIONS"], nowIso: ctx.now, realAdapters: REAL_ADAPTER_VENDORS }); }) },
  { name: "writeDecision", kind: "act", ruleSetVersion: POSTURE_RULE_SET_VERSION, handler: decision() },
]);
export const POSTURE_TOOLS = TOOLS_35_12.map((t) => t.name);
