/**
 * §35.3 process-owned tools — the `ops-steward` agent's cycle tools (spec/sections/35-operations-runtime/35-3-cycles-jobs-and-receipts.md
 * "AI agent design"), defined with `defineTools("35.3", "ops-steward", defs)` and spread by ./index.ts. The planner and the
 * executor are runtime passes (src/domain/operations-runtime/cycles/planner.ts, executor.ts — the sweep and the demo step run
 * them); these tools are the same acts on the bus, runnable by hand, plus the board's reads and the ops_analyst's requeue.
 *
 *   cycles.registry  act   {op: list | pause | resume, cycle_code?, reason?} — the board's rows (overdue first); pause/resume are ops_analyst acts (a pause cancels the cycle's open runs).
 *   cycles.plan      act   {as_of?, cycle_codes?} — the planner under its own lock (35_003), from within the command.
 *   cycles.run_unit  act   {job_id} — the executor's own call, also runnable by hand for one job (rule 8; NO_CLIENT_STATE, UNIT_RUNS_AS_OWNER, JOB_NOT_CLAIMABLE).
 *   cycles.receipt   read  {run_id} — the receipt and its unit outcomes.
 *   cycles.retry     act   {job_id} — an agent's early retry of a `failed` unit before its run_after.
 *   cycles.escalate  act   {run_id | job_id, reason} — a sev 3 to ops_analyst.
 *   jobs.list        read  {cycle_code?, status?, period_key?, loan_id?, run_id?}.
 *   jobs.requeue     act   {job_id, op: requeue | abandon, reason} — ops_analyst only (ROLE_REQUIRED); `job.unit.resolved` satisfies SM_JOB_DEAD_2H.
 *   writeDecision    act   the decision row (cycles.v1).
 *
 * Guardrails: NO_MONEY_FIELD (an input naming a `*_cents` key or `changes` is refused on every tool — rule 12), NO_CLOCK_EDIT (an
 * input naming a timer to move is refused — a timer moves only through the engine on the owner's events), NO_CLIENT_STATE and
 * UNIT_RUNS_AS_OWNER on `cycles.run_unit`, ROLE_REQUIRED on requeue/abandon/pause/resume.
 */
import { defineTools, compute, decision, never, guard, str, PortUnavailable, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { Runtime } from "../../runtime/app.ts";
import { runUnitHandler, runUnitDecision, unitDecision, RUN_UNIT_TOOL } from "../../domain/operations-runtime/cycles/executor.ts";
import { planCycles } from "../../domain/operations-runtime/cycles/planner.ts";
import { registryList, pauseCycle, resumeCycle, readReceipt, retryJob, escalateCycle, listJobs, requeueJob } from "../../domain/operations-runtime/cycles/service.ts";
import { CYCLES_VERSION } from "../../domain/operations-runtime/cycles/cycles.ts";

export const CYCLES_PROCESS = "35.3";
export const CYCLES_AGENT = "ops-steward";

const has = (i: ToolInput, k: string): boolean => i[k] !== undefined && i[k] !== null && i[k] !== "";
const moneyKey = (k: string): boolean => /_cents$/.test(k) || /^(amount|cents|upb|balance)$/.test(k);
const deepMoney = (v: unknown, depth = 0): boolean => !!v && typeof v === "object" && depth < 3 && (Array.isArray(v) ? v.some((x) => deepMoney(x, depth + 1)) : Object.entries(v as Record<string, unknown>).some(([k, x]) => moneyKey(k) || deepMoney(x, depth + 1)));
const runtimeOf = (rt: ToolRuntime): Runtime => { const r = rt.services["runtime"] as Runtime | undefined; if (!r) throw new PortUnavailable("service:runtime"); return r; };
const txOf = (ctx: { q?: unknown }) => { if (!ctx.q) throw new RangeError("35.3 tools run inside a database command (PgUnitOfWork): no transaction on this context"); };

/** Rule 12: "Nothing here moves money or edits a clock." */
export const NO_MONEY_FIELD = never("NO_MONEY_FIELD", "35.3 rule 12: 'a money field changes only inside the owner's command under the owner's rules and waivers (officer)'; guardrail NO_MONEY_FIELD", (i) => Object.keys(i).some(moneyKey) || has(i, "changes") || deepMoney(i["data"]) || deepMoney(i["overrides"]), "no 35.3 tool writes a money column; a money field changes only inside the owning section's command");
export const NO_CLOCK_EDIT = never("NO_CLOCK_EDIT", "35.3 rule 12: 'a timer moves only through the engine on the owner's events (34.4 rule 1)'; guardrail NO_CLOCK_EDIT", (i) => ["timer_id", "due_at", "due_date", "timer", "arm", "cancel_timer"].some((k) => has(i, k)) || ["arm", "cancel", "edit_timer", "move_timer"].includes(str(i, "op")), "no 35.3 tool edits a clock; a timer moves only through the engine on the owner's events");
/** Rule 8 / T13: an input that carries `state`, `custodial`, a `*_cents` field or `changes` is refused before anything is written. */
export const NO_CLIENT_STATE = never("NO_CLIENT_STATE", "35.3 rule 8: 'an input that carries state, custodial, a *_cents field or a changes object is refused NO_CLIENT_STATE before anything is written (T13)' — the unit derives its facts server-side", (i) => has(i, "state") || has(i, "custodial") || has(i, "changes") || Object.keys(i).some(moneyKey) || deepMoney(i["input"]), "a unit derives its facts server-side; the input carries ids and dates only");
/** Guardrail UNIT_RUNS_AS_OWNER: an input naming an actor or agent to run as is refused. */
export const UNIT_RUNS_AS_OWNER = never("UNIT_RUNS_AS_OWNER", "35.3 AI agent design: 'UNIT_RUNS_AS_OWNER (an input naming an actor or agent to run as is refused)' — every unit runs as the owning section's agent (rule 8)", (i) => ["actor", "agent", "run_as", "as_agent", "owner_agent"].some((k) => has(i, k)), "a unit runs as the registry row's owner_agent; the caller names no actor");
/** Guardrail ROLE_REQUIRED: requeue, abandon, pause and cancel are `ops_analyst` acts (rule 7; T13: an agent actor is refused ROLE_REQUIRED{ops_analyst}). */
const opsAnalystOnly = (ops: readonly string[]) => guard("ROLE_REQUIRED", "35.3 rule 7 / AI agent design: 'ROLE_REQUIRED (requeue, abandon, pause, cancel are ops_analyst)'", (i, ctx) => (ops.includes(str(i, "op")) && !(ctx.actor.kind === "human" && ctx.actor.role === "ops_analyst") ? `ROLE_REQUIRED{ops_analyst}: ${str(i, "op")} is an ops_analyst's act` : undefined));

const COMMON = [NO_MONEY_FIELD, NO_CLOCK_EDIT];
const plannedBy = (ctx: { actor: { kind: string; id: string } }): string => (ctx.actor.kind === "human" ? `human:${ctx.actor.id}` : `${ctx.actor.kind}:${ctx.actor.id}`);
const by = (ctx: { actor: { kind: string; id: string } }): string => `${ctx.actor.kind}:${ctx.actor.id}`;

export const TOOLS_35_3: readonly ToolDef[] = defineTools(CYCLES_PROCESS, CYCLES_AGENT, [
  { name: "cycles.registry", kind: "act", ruleSetVersion: CYCLES_VERSION, humanRoles: ["ops_analyst", "officer", "compliance", "fnma_portal_operator"], guardrails: [...COMMON, opsAnalystOnly(["pause", "resume"])],
    handler: compute(async (i, ctx) => { txOf(ctx); const op = str(i, "op") || "list";
      if (op === "list") return { rows: await registryList(ctx.q!, str(i, "cycle_code") || null) };
      const code = str(i, "cycle_code"); if (!code) throw new RangeError(`cycles.registry{op: ${op}} needs cycle_code`);
      if (op === "pause") { const reason = str(i, "reason"); if (!reason) throw new RangeError("cycles.registry{op: pause} needs a reason"); return pauseCycle(ctx, code, reason); }
      if (op === "resume") return resumeCycle(ctx, code);
      throw new RangeError("cycles.registry op is list, pause or resume"); }),
    decision: (i, output, ctx) => { const op = str(i, "op") || "list"; if (op === "list") return null; const o = (output ?? {}) as Record<string, unknown>; return unitDecision({ subject: { kind: "cycle_registry", id: str(i, "cycle_code") }, action: `cycles.registry:${op}`, outcome: String(o["status"] ?? op), by: by(ctx), reason: str(i, "reason") || null, rationale: `${op} ${str(i, "cycle_code")} by ${by(ctx)}: ${str(i, "reason") || "no reason given"}` }); } },
  { name: "cycles.plan", kind: "act", ruleSetVersion: CYCLES_VERSION, guardrails: COMMON,
    // the planner is a runtime pass (its own idempotent units of work under its own lock, a selector's failure tolerated per cycle): it runs on the root runtime, never inside this command's transaction (a tolerated statement failure would abort the enclosing transaction); this command records the decision
    handler: compute(async (i, ctx, rt) => { const runtime = runtimeOf(rt).root; const r = await planCycles(runtime, { ...(has(i, "as_of") ? { as_of: str(i, "as_of") } : { as_of: ctx.now }), planned_by: plannedBy(ctx), cycle_codes: Array.isArray(i["cycle_codes"]) ? (i["cycle_codes"] as unknown[]).map(String) : null }); return r; }),
    decision: (_i, output, ctx) => { const o = (output ?? {}) as Record<string, unknown>; return unitDecision({ subject: { kind: "planner_run", id: String(o["run_id"] ?? "") }, action: "cycles.plan", period_key: String(o["as_of_date"] ?? ""), outcome: o["skipped"] === true ? "skipped" : "completed", by: by(ctx), rationale: o["skipped"] === true ? `planner skipped: ${String(o["skipped_reason"])}` : `planned ${String(o["runs_opened"])} run(s), ${String(o["jobs_planned"])} job(s); ${String(o["leases_reclaimed"])} lease(s) reclaimed, ${String(o["receipts_reconciled"])} receipt(s) reconciled` }); } },
  { name: RUN_UNIT_TOOL, kind: "act", ruleSetVersion: CYCLES_VERSION, guardrails: [NO_CLIENT_STATE, UNIT_RUNS_AS_OWNER, ...COMMON], handler: compute(runUnitHandler), decision: runUnitDecision },
  { name: "cycles.receipt", kind: "read", guardrails: COMMON, handler: compute(async (i, ctx) => { txOf(ctx); const id = str(i, "run_id"); if (!id) throw new RangeError("cycles.receipt needs run_id"); return readReceipt(ctx.q!, id); }) },
  { name: "cycles.retry", kind: "act", ruleSetVersion: CYCLES_VERSION, guardrails: COMMON, handler: compute(async (i, ctx) => { txOf(ctx); const id = str(i, "job_id"); if (!id) throw new RangeError("cycles.retry needs job_id"); return retryJob(ctx, id); }),
    decision: (i, output, ctx) => { const o = (output ?? {}) as Record<string, unknown>; return unitDecision({ subject: { kind: "job", id: str(i, "job_id") }, action: "cycles.retry", attempt: Number(o["attempts"] ?? 0), outcome: "queued", by: by(ctx), rationale: `early retry of failed job ${str(i, "job_id")} by ${by(ctx)}` }); } },
  { name: "cycles.escalate", kind: "act", ruleSetVersion: CYCLES_VERSION, guardrails: COMMON,
    handler: compute((i, ctx, rt) => { const reason = str(i, "reason"); if (!reason) throw new RangeError("cycles.escalate needs a reason"); if (!has(i, "run_id") && !has(i, "job_id")) throw new RangeError("cycles.escalate needs run_id or job_id"); return escalateCycle(ctx, rt, { ...(has(i, "run_id") ? { run_id: str(i, "run_id") } : {}), ...(has(i, "job_id") ? { job_id: str(i, "job_id") } : {}), reason }); }),
    decision: (i, output, ctx) => { const o = (output ?? {}) as Record<string, unknown>; return unitDecision({ subject: has(i, "run_id") ? { kind: "cycle_run", id: str(i, "run_id") } : { kind: "job", id: str(i, "job_id") }, action: "cycles.escalate", outcome: `escalated:${String(o["owner_role"])}`, by: by(ctx), reason: str(i, "reason"), rationale: `escalation ${String(o["escalation_id"])} to ${String(o["owner_role"])}: ${str(i, "reason")}` }); } },
  { name: "jobs.list", kind: "read", guardrails: COMMON, handler: compute(async (i, ctx) => { txOf(ctx); return { jobs: await listJobs(ctx.q!, { cycle_code: str(i, "cycle_code") || null, status: str(i, "status") || null, period_key: str(i, "period_key") || null, loan_id: str(i, "loan_id") || null, run_id: str(i, "run_id") || null, limit: i["limit"] === undefined || i["limit"] === null || i["limit"] === "" ? null : Number(i["limit"]) }) }; }) },
  { name: "jobs.requeue", kind: "act", ruleSetVersion: CYCLES_VERSION, humanRoles: ["ops_analyst"], guardrails: [...COMMON, opsAnalystOnly(["requeue", "abandon"]), never("ROLE_REQUIRED", "35.3 rule 7: 'A dead unit is requeued or abandoned only by jobs.requeue from an ops_analyst'", (i) => !["requeue", "abandon"].includes(str(i, "op")), "jobs.requeue op is requeue or abandon")],
    handler: compute(async (i, ctx) => { txOf(ctx); const id = str(i, "job_id"); const reason = str(i, "reason"); if (!id || !reason) throw new RangeError("jobs.requeue needs job_id and reason"); return requeueJob(ctx, id, str(i, "op") as "requeue" | "abandon", reason); }),
    decision: (i, output, ctx) => { const o = (output ?? {}) as Record<string, unknown>; return unitDecision({ subject: { kind: "job", id: str(i, "job_id") }, action: "jobs.requeue", outcome: String(o["disposition"] ?? str(i, "op")), by: by(ctx), reason: str(i, "reason"), rationale: `${str(i, "op")} of dead job ${str(i, "job_id")} by ${by(ctx)} (${ctx.actor.role ?? "no role"}): ${str(i, "reason")}` }); } },
  { name: "writeDecision", kind: "act", ruleSetVersion: CYCLES_VERSION, guardrails: COMMON, handler: decision() },
]);
