/**
 * §35.11 process-owned tools — the `qc-audit` agent's `ops.cycles.watch`, `ops.exceptions.list`, `ops.exceptions.classify`,
 * `ops.exceptions.requeue`, `ops.exceptions.assign`, `ops.exceptions.resolve`, `ops.report`, `ops.runbook.read`, `audit.hosted.run`,
 * `audit.hosted.report`, `audit.persisted.count` and `writeDecision` (spec/sections/35-operations-runtime/35-11-*.md "AI agent design"),
 * defined with `defineTools("35.11", "qc-audit", defs)` and spread by ./index.ts; every string is one spec/registry/agents.json names
 * for 35.11. Thin bus wrappers over src/domain/operations-runtime/stewardship.ts (the steward) and measurement.ts (the probe and
 * the count): the acts run in the command's unit of work — the exception row on the transaction, the events on ctx.events, the
 * triage row and the escalation link deferred to the commit — so a refusal writes nothing; each act writes its own decision row
 * (the tool's `decision` is therefore null: one record per act, never two).
 *
 *   ops.cycles.watch        act   the agent (or an ops_analyst): rule 2 — the registry's overdue cycles → exceptions, `ops.cycle.missed`, one ops_analyst escalation each.
 *   ops.exceptions.list     read  ops_analyst | compliance | officer | admin.
 *   ops.exceptions.classify act   rule 3 (the agent's own call, re-runnable by hand) with rule 4's follow-up.
 *   ops.exceptions.requeue  act   `op: auto` (the bounded automatic requeue; refused CONFIDENCE_FLOOR_0_85 / AUTO_REQUEUE_CAP_1 without a write) | `op: propose`.
 *   ops.exceptions.assign   act   the agent (needs_person, poison, the cap) or an ops_analyst.
 *   ops.exceptions.resolve  act   ops_analyst only: `disposition ∈ {resolved, abandoned}`; abandoned needs the reason.
 *   ops.report              act   rules 5–7: the day's hashed row, the 18.1 feed, the FAKE-actor control.
 *   ops.runbook.read        read  rule 8: generated from the registry; UNKNOWN_CODE otherwise.
 *   audit.hosted.run / audit.hosted.report / audit.persisted.count   rules 10–11 (measurement.ts).
 *   writeDecision           act   the generic decision row.
 * Guardrails on every tool: NO_MONEY_FIELD (rule 9), NEVER_COMPLETES_A_BREACH (rule 1), NO_CLOCK_EDIT; NO_PAYLOAD_IN_EXCEPTION on the
 * exception-writing tools; PROBE_NEVER_PRODUCTION on the probe.
 */
import { defineTools, compute, decision, str, PortUnavailable, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import type { Queryable } from "../../infra/db/client.ts";
import type { Runtime } from "../../runtime/app.ts";
import type { AgentRegistry } from "../agents.ts";
import { HUMAN_ROLES } from "../roles.ts";
import { assignException, classifyException, listExceptions, requeueException, resolveException, watchCycles, StewardRefused, type StewardDeps } from "../../domain/operations-runtime/stewardship.ts";
import { runDailyReport } from "../../domain/operations-runtime/stewardship-35-11/report.ts";
import { readRunbook } from "../../domain/operations-runtime/stewardship-35-11/runbook.ts";
import { portsOf } from "../../domain/operations-runtime/stewardship-35-11/ports.ts";
import { COMMON_GUARDS, NO_PAYLOAD_IN_EXCEPTION, PROBE_NEVER_PRODUCTION } from "../../domain/operations-runtime/stewardship-35-11/guards.ts";
import { EV_HOSTED, EV_PERSISTED, auditDir, auditFileExists, hostedPayload, latestHostedRun, persistedPayload, recordHostedRun, recordPersistedRun, runHostedProbe, runPersistedCount } from "../../domain/operations-runtime/measurement.ts";
import type { JourneyDeclaration } from "../../domain/operations-runtime/stewardship-35-11/journeys.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROCESS_35_11, STEWARD_AGENT, OPS_RULE_SET_VERSION, AUDIT_RULE_SET_VERSION, STEWARD_MODEL_VERSION, STEWARD_PROMPT_VERSION, byOf } from "../../domain/operations-runtime/stewardship-35-11/types.ts";

type P = Record<string, unknown>;
const dbOf = (rt: ToolRuntime): Queryable => { const db = rt.services["db"] as Queryable | undefined; if (!db) throw new PortUnavailable("service:db"); return db; };
const runtimeOf = (rt: ToolRuntime): Runtime => { const r = rt.services["runtime"] as Runtime | undefined; if (!r) throw new PortUnavailable("service:runtime"); return r; };
const agentsOf = (rt: ToolRuntime): AgentRegistry => { const a = rt.services["agents"] as AgentRegistry | undefined; if (!a) throw new PortUnavailable("service:agents"); return a; };
const deferOf = (rt: ToolRuntime): StewardDeps["deferWrite"] => { const f = rt.services["deferWrite"] as StewardDeps["deferWrite"] | undefined; if (!f) throw new PortUnavailable("service:deferWrite"); return f; };
const depsOf = (ctx: CommandContext, rt: ToolRuntime): StewardDeps => { const runtime = runtimeOf(rt); return { q: dbOf(rt), events: ctx.events, clock: ctx.clock, now: ctx.now, actor: ctx.actor, escalations: rt.escalations, decide: (d) => ctx.decide(d), deferWrite: deferOf(rt), environment: runtime.environment, ports: portsOf(undefined), runtime }; };
const opt = (i: ToolInput, k: string): string | null => (typeof i[k] === "string" && (i[k] as string).trim() ? (i[k] as string).trim() : null);
const uuidOf = (i: ToolInput, k: string): string => { const v = opt(i, k); if (!v) throw new RangeError(`${k} is required`); return v; };
const READ_ROLES = ["ops_analyst", "compliance", "officer", "admin"];
const ACT_ROLES = ["ops_analyst"];
const REPORT_ROLES = ["ops_analyst", "compliance"];
/** Every act writes its own agent_decisions row inside the act (stewardship.ts `decision`): the bus's default record would be a second one. */
const ownDecision = () => null;

export const TOOLS_35_11: readonly ToolDef[] = defineTools(PROCESS_35_11, STEWARD_AGENT, [
  { name: "ops.cycles.watch", kind: "act", ruleSetVersion: OPS_RULE_SET_VERSION, humanRoles: ACT_ROLES, guardrails: [...COMMON_GUARDS, NO_PAYLOAD_IN_EXCEPTION],
    handler: compute(async (i, ctx, rt) => watchCycles(depsOf(ctx, rt), { as_of: opt(i, "as_of") ?? ctx.now, cycle_codes: Array.isArray(i["cycle_codes"]) ? (i["cycle_codes"] as unknown[]).map(String) : null })), decision: ownDecision },
  { name: "ops.exceptions.list", kind: "read", ruleSetVersion: OPS_RULE_SET_VERSION, humanRoles: READ_ROLES, guardrails: [...COMMON_GUARDS],
    handler: compute(async (i, _ctx, rt) => listExceptions(dbOf(rt), { environment: opt(i, "environment"), status: opt(i, "status"), kind: opt(i, "kind"), adapter: opt(i, "adapter"), source_kind: opt(i, "source_kind"), limit: i["limit"] === undefined ? null : Number(i["limit"]) })) },
  { name: "ops.exceptions.classify", kind: "act", ruleSetVersion: OPS_RULE_SET_VERSION, humanRoles: ACT_ROLES, guardrails: [...COMMON_GUARDS, NO_PAYLOAD_IN_EXCEPTION],
    handler: compute(async (i, ctx, rt) => classifyException(depsOf(ctx, rt), { exception_id: uuidOf(i, "exception_id"), ...(i["follow_up"] === false ? { follow_up: false } : {}) })), decision: ownDecision },
  { name: "ops.exceptions.requeue", kind: "act", ruleSetVersion: OPS_RULE_SET_VERSION, humanRoles: ACT_ROLES, guardrails: [...COMMON_GUARDS, NO_PAYLOAD_IN_EXCEPTION],
    handler: compute(async (i, ctx, rt) => { const op = str(i, "op") || "auto"; if (op !== "auto" && op !== "propose") throw new RangeError("ops.exceptions.requeue op ∈ {auto, propose}"); return requeueException(depsOf(ctx, rt), { exception_id: uuidOf(i, "exception_id"), op, reason: opt(i, "reason") }); }), decision: ownDecision },
  { name: "ops.exceptions.assign", kind: "act", ruleSetVersion: OPS_RULE_SET_VERSION, humanRoles: ACT_ROLES, guardrails: [...COMMON_GUARDS, NO_PAYLOAD_IN_EXCEPTION],
    handler: compute(async (i, ctx, rt) => { const role = str(i, "role") || "ops_analyst"; if (!(HUMAN_ROLES as readonly string[]).includes(role)) throw new StewardRefused(409, "UNKNOWN_ROLE", `${role} is not a kernel human role`); return assignException(depsOf(ctx, rt), { exception_id: uuidOf(i, "exception_id"), role, reason: opt(i, "reason") ?? `assigned by ${byOf(ctx.actor)}` }); }), decision: ownDecision },
  { name: "ops.exceptions.resolve", kind: "act", humanOnly: true, ruleSetVersion: OPS_RULE_SET_VERSION, humanRoles: ACT_ROLES, guardrails: [...COMMON_GUARDS, NO_PAYLOAD_IN_EXCEPTION],
    handler: compute(async (i, ctx, rt) => { const disposition = str(i, "disposition") || "resolved"; if (disposition !== "resolved" && disposition !== "abandoned") throw new RangeError("ops.exceptions.resolve disposition ∈ {resolved, abandoned}"); return resolveException(depsOf(ctx, rt), { exception_id: uuidOf(i, "exception_id"), disposition, reason: opt(i, "reason") }); }), decision: ownDecision },
  { name: "ops.report", kind: "act", ruleSetVersion: OPS_RULE_SET_VERSION, humanRoles: REPORT_ROLES, guardrails: [...COMMON_GUARDS],
    handler: compute(async (i, ctx, rt) => { const d = depsOf(ctx, rt); const r = await runDailyReport(d, { environment: opt(i, "environment") ?? d.environment, as_of_date: opt(i, "as_of_date"), force: i["force"] === true, produced_by: ctx.actor.kind === "human" ? `human:${ctx.actor.id}` : byOf(ctx.actor), agents: agentsOf(rt) }); const { columns, ...rest } = r; return { ...rest, columns }; }), decision: ownDecision },
  { name: "ops.runbook.read", kind: "read", ruleSetVersion: OPS_RULE_SET_VERSION, humanRoles: READ_ROLES, guardrails: [...COMMON_GUARDS],
    handler: compute(async (i, _ctx, rt) => { const r = await readRunbook(dbOf(rt), { timer_code: opt(i, "timer_code"), cycle_code: opt(i, "cycle_code"), adapter: opt(i, "adapter") }); if ("refused" in r) throw new StewardRefused(404, r.refused, r.reason); return r; }) },
  // rules 10–11: the probe and the count run on their own databases and connections (never inside this command's transaction — DDL and minutes of HTTP); only the run's row, the receipt and the decision are this command's
  { name: "audit.hosted.run", kind: "act", ruleSetVersion: AUDIT_RULE_SET_VERSION, humanRoles: ["qc_officer", "ops_analyst"], guardrails: [...COMMON_GUARDS, PROBE_NEVER_PRODUCTION],
    handler: compute(async (i, ctx, rt) => {
      const target = str(i, "target"); if (target !== "probe" && target !== "deployed") throw new RangeError("audit.hosted.run needs target ∈ {probe, deployed}");
      const runtime = runtimeOf(rt);
      const run = await runHostedProbe({ target, databaseUrl: opt(i, "database_url") ?? runtime.env["PROBE_DATABASE_URL"] ?? null, baseUrl: opt(i, "base_url") ?? runtime.env["PROBE_BASE_URL"] ?? null, loanId: opt(i, "loan_id") ?? runtime.env["PROBE_LOAN_ID"] ?? null, applicationId: opt(i, "application_id") ?? runtime.env["PROBE_APPLICATION_ID"] ?? null,
        tokens: runtime.env["PROBE_TOKENS"] ? (JSON.parse(runtime.env["PROBE_TOKENS"]) as Record<string, string>) : runtime.env["PROBE_TOKEN"] ?? null, environment: opt(i, "environment") ?? runtime.env["PROBE_ENVIRONMENT"] ?? null, auditDir: opt(i, "audit_dir"), writeAuditFile: i["write_audit_file"] !== false, clock: ctx.clock, ...(runtime.logger ? { logger: runtime.logger } : {}), breakTool: (i["break_tool"] as { process: string; name: string } | undefined) ?? null });
      await recordHostedRun(dbOf(rt), run);   // the caller's copy of the row (audit.hosted.report reads it); the probe database holds its own
      if (run.outcome === "completed") ctx.events.append({ type: EV_HOSTED, aggregate: { kind: "hosted_probe", id: run.target }, actor: ctx.actor, payload: hostedPayload(run) });
      ctx.decide({ agent: STEWARD_AGENT, action: "audit.hosted.run", ruleSetVersion: AUDIT_RULE_SET_VERSION, subject: { kind: "hosted_probe_run", id: run.run_id }, confidence: 1, modelVersion: STEWARD_MODEL_VERSION, promptVersion: STEWARD_PROMPT_VERSION, rationale: `${run.target} ${run.outcome}: ${run.executed} executed, ${run.refused_typed} refused_typed, ${run.not_wired} not_wired, ${run.errored} errored of ${run.tools_total}; migration ${run.migration_head}; not_wired outside the three keys: ${run.not_wired_unexpected.length}; door refusals: ${run.door_refusals.length}${run.failure ? `; failed: ${run.failure}` : ""} (rule_set_version: ${AUDIT_RULE_SET_VERSION}, model_version: ${STEWARD_MODEL_VERSION}, prompt_version: ${STEWARD_PROMPT_VERSION})` });
      const { results, ...summary } = run; return { ...summary, results: results.map((r) => ({ process: r.process, name: r.name, status: r.status, code: r.code, http_status: r.http_status })) };
    }), decision: ownDecision },
  { name: "audit.hosted.report", kind: "read", ruleSetVersion: AUDIT_RULE_SET_VERSION, humanRoles: READ_ROLES, guardrails: [...COMMON_GUARDS],
    handler: compute(async (i, _ctx, rt) => { const run = await latestHostedRun(dbOf(rt), opt(i, "run_id")); const dir = auditDir(opt(i, "audit_dir")); const file = auditFileExists("hosted.json", dir) ? (JSON.parse(readFileSync(join(dir, "hosted.json"), "utf8")) as P) : null; return { run, audit_file: file ? { run_id: file["run_id"], migration_head: file["migration_head"], as_of_date: file["as_of_date"], tools_total: file["tools_total"], executed: file["executed"], refused_typed: file["refused_typed"], not_wired: file["not_wired"], errored: file["errored"] } : null }; }) },
  { name: "audit.persisted.count", kind: "act", ruleSetVersion: AUDIT_RULE_SET_VERSION, humanRoles: ["qc_officer", "ops_analyst"], guardrails: [...COMMON_GUARDS],
    handler: compute(async (i, ctx, rt) => {
      const j = i["journeys"]; if (!Array.isArray(j) || !j.length) throw new RangeError("audit.persisted.count needs journeys: the journey files (basenames) or declarations [{name, steps: [{step, writes}]}]");
      const journeys = j.map((x) => (typeof x === "string" ? x : x as JourneyDeclaration)) as readonly string[] | readonly JourneyDeclaration[];
      const runtime = runtimeOf(rt);
      const declared = i["tables"]; const tables = Array.isArray(declared) && declared.every((t) => t && typeof t === "object" && typeof (t as Record<string, unknown>)["table"] === "string") ? (declared as { section: number; process: string; table: string }[]) : null;   // a declared manifest (a test's); the registry's otherwise
      const run = await runPersistedCount({ journeys, ...(tables ? { tables } : {}), databaseUrl: opt(i, "database_url"), baseUrl: opt(i, "base_url"), auditDir: opt(i, "audit_dir"), writeAuditFile: i["write_audit_file"] !== false, clock: ctx.clock, ...(runtime.logger ? { logger: runtime.logger } : {}) });
      await recordPersistedRun(dbOf(rt), run);
      if (run.outcome === "completed") ctx.events.append({ type: EV_PERSISTED, aggregate: { kind: "persisted_measurement", id: run.database_name }, actor: ctx.actor, payload: persistedPayload(run) });
      ctx.decide({ agent: STEWARD_AGENT, action: "audit.persisted.count", ruleSetVersion: AUDIT_RULE_SET_VERSION, subject: { kind: "persisted_measurement_run", id: run.run_id }, confidence: 1, modelVersion: STEWARD_MODEL_VERSION, promptVersion: STEWARD_PROMPT_VERSION, rationale: `${run.outcome}: ${run.tables_with_rows} persisted of ${run.tables_total}; sections complete ${JSON.stringify(run.sections_complete)}; journeys ${run.journeys.join(", ")}; migration ${run.migration_head}${run.failure ? `; failed: ${run.failure}` : ""} (rule_set_version: ${AUDIT_RULE_SET_VERSION}, model_version: ${STEWARD_MODEL_VERSION}, prompt_version: ${STEWARD_PROMPT_VERSION})` });
      const { measurements, ...summary } = run; return { ...summary, measurements: measurements.map((m) => ({ section: m.section, process: m.process, table_name: m.table_name, post_migrate_count: m.post_migrate_count.toString(), after_journey_count: m.after_journey_count.toString(), delta: m.delta.toString(), expected: m.expected, expected_by: m.expected_by, verdict: m.verdict })) };
    }), decision: ownDecision },
  { name: "writeDecision", kind: "act", ruleSetVersion: OPS_RULE_SET_VERSION, guardrails: [...COMMON_GUARDS], handler: decision() },
]);
export const STEWARDSHIP_TOOLS = TOOLS_35_11.map((t) => t.name);
export type { P };
