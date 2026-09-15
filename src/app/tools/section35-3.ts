/**
 * §35.3 process-owned tools — the `ops-steward` agent's bus tools (spec/sections/35-operations-runtime/35-3-*.md "AI agent
 * design"), defined with `defineTools("35.3", "ops-steward", defs)` and spread by ./index.ts. Every tool string is one
 * spec/registry/agents.json names for 35.3; src/app/tools.test.ts refuses the rest. Thin bus wrappers over
 * src/domain/operations-runtime/service.ts (the runtime seam the sweep, the demo step and the boards call through the bus,
 * so the actor is the actor and the decision record names them):
 *
 *   cycles.registry   op=list (read: every registry row, overdue first — rule 11 / T11) | op=pause | op=resume (an `ops_analyst`
 *                     act with a reason: a paused cycle's planned / running runs are cancelled, blocked / queued jobs skipped,
 *                     the stall clock cancelled — ROLE_REQUIRED for anything but a human ops_analyst). Decision on pause / resume.
 *   cycles.plan       act (agent or ops_analyst): the planner under its lock (rules 1, 3, 4, 10, 11) — `{as_of?, cycle_codes?,
 *                     planned_by?}` → the counts, or `{skipped: true, holder}` when the lock is held (no decision then).
 *   cycles.receipt    read `{run_id}`: the receipt row, the two events with their sequences, the units' final job_events.
 *   jobs.list         read `{cycle_code?, status?, period_key?, loan_id?, run_id?, limit?}`.
 *   writeDecision     the kernel's decision row (src/app/tools.ts decision(); the section01.ts precedent).
 *   cycles.run_unit, cycles.retry, cycles.escalate, jobs.requeue land with the executor's commit group.
 *
 * Guardrails (the paragraph's list): NO_MONEY_FIELD (34.4's regex: no money key, `changes`, `data`, waiver or refund — rule 12),
 * NO_CLOCK_EDIT (34.4's keys: nothing here satisfies, extends, cancels or re-dates a timer — rule 12), UNIT_RUNS_AS_OWNER (an input
 * naming an actor or agent to run as is refused — rule 8), ROLE_REQUIRED (pause, resume, requeue, abandon, cancel are an
 * `ops_analyst`'s: an agent is refused by the guardrail, not by HUMAN_ONLY, so the refusal code is the paragraph's — T13).
 */
import { defineTools, compute, decision, guard, never, str, PortUnavailable, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import type { Runtime } from "../../runtime/app.ts";
import { CYCLES_PROCESS, OPS_STEWARD, cyclesOf, type PlanOutput } from "../../domain/operations-runtime/service.ts";

const runtimeOf = (rt: ToolRuntime): Runtime => { const r = rt.services["runtime"] as Runtime | undefined; if (!r) throw new PortUnavailable("service:runtime"); return r; };
const has = (i: ToolInput, k: string): boolean => i[k] !== undefined && i[k] !== null && i[k] !== "" && i[k] !== false;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const by = (ctx: CommandContext): string => (ctx.actor.kind === "human" ? ctx.actor.id : `${ctx.actor.kind}:${ctx.actor.id}`);

// ───────── guardrails ─────────

/** Rule 12 (34.4 rule 6's shape): nothing here changes a money field — a money key, `changes`, `data`, a waiver or a refund in the input is refused; a waiver remains the owning section's officer command. */
const MONEY_RE = /(_cents|_bps|_pct)$|^(amount|cents|rate|upb|balance|fee|waive|waiver|refund|credit|payment|principal|interest|escrow|late_charge|ledger|entry_set|post)$/i;
export const NO_MONEY_FIELD = never("NO_MONEY_FIELD", "35.3 rule 12: 'Nothing here moves money or edits a clock … a money field changes only inside the owner's command under the owner's rules and waivers (`officer`)'", (i) => Object.keys(i).some((k) => MONEY_RE.test(k)) || has(i, "changes") || has(i, "data"), "no money field is written by the cycle engine; a waiver, a refund or a posting is the owning section's officer command");
/** Rule 12 (34.4 rule 1's keys): a timer moves only through the engine on the owner's events — an instruction to satisfy, extend, cancel, re-date or re-arm a clock is refused. */
const CLOCK_EDIT_KEYS = ["satisfy", "satisfied", "extend", "extension", "cancel", "cancelled", "due_at", "due_date", "new_due", "new_due_date", "rearm", "re_arm", "arm", "breach", "unbreach", "timer_status", "set_status", "timer_id", "timer_code"];
const CLOCK_EDIT_OPS = new Set(["satisfy", "extend", "cancel", "arm", "rearm", "edit", "update", "write", "breach", "set"]);
export const NO_CLOCK_EDIT = never("NO_CLOCK_EDIT", "35.3 rule 12: 'a timer moves only through the engine on the owner's events (34.4 rule 1)'", (i) => CLOCK_EDIT_KEYS.some((k) => has(i, k)) || (typeof i.op === "string" && CLOCK_EDIT_OPS.has(i.op)), "clocks are shown, never edited: no cycle tool satisfies, extends, cancels or re-dates a timer — the owning process's events do");
/** Rule 8: a unit runs as its owner's agent — an input naming an actor or agent to run as is refused. */
const RUN_AS_KEYS = ["actor", "agent", "as_agent", "run_as", "owner_agent", "as_role", "act_as", "impersonate", "on_behalf_of", "override_role", "assume_role"];
export const UNIT_RUNS_AS_OWNER = never("UNIT_RUNS_AS_OWNER", "35.3 AI agent design: 'UNIT_RUNS_AS_OWNER (an input naming an actor or agent to run as is refused)'; rule 8: 'A unit is its owner's command with its owner's actor'", (i) => RUN_AS_KEYS.some((k) => has(i, k)), "a unit runs as the registry row's owner_agent; an input naming an actor, agent or role to run as is refused");
/** Requeue, abandon, pause and cancel are an `ops_analyst`'s acts: an agent (or a human without the role) is refused ROLE_REQUIRED naming the role (T13). */
export const roleRequired = (when: (i: ToolInput) => boolean, what: string): ReturnType<typeof guard> =>
  guard("ROLE_REQUIRED", "35.3 AI agent design: 'ROLE_REQUIRED (requeue, abandon, pause, cancel are `ops_analyst`)'; rule 7: 'an agent actor is refused ROLE_REQUIRED (T13)'", (i, ctx) => (!when(i) ? undefined : ctx.actor.kind !== "human" || ctx.actor.role !== "ops_analyst" ? `${what} is an ops_analyst's act; ${ctx.actor.kind}:${ctx.actor.id}${ctx.actor.role ? ` (${ctx.actor.role})` : ""} is refused — requires ops_analyst` : undefined));
/** A reason is required on every human act here (pause, resume, requeue, abandon, escalate). */
export const reasonRequired = (when: (i: ToolInput) => boolean): ReturnType<typeof guard> => guard("REASON_REQUIRED", "35.3 state machine: 'active ⇄ paused (ops_analyst with a reason, logged)'; rule 7: 'requeues with a reason'", (i) => (when(i) && !str(i, "reason") ? "a reason is required" : undefined));

const isPauseOrResume = (i: ToolInput): boolean => i.op === "pause" || i.op === "resume";
const LIST_ROLES: readonly string[] = ["ops_analyst"];

// ───────── the tools ─────────

export const TOOLS_35_3: readonly ToolDef[] = defineTools(CYCLES_PROCESS, OPS_STEWARD.id, [
  { name: "cycles.registry", kind: "act", humanRoles: LIST_ROLES, guardrails: [NO_MONEY_FIELD, NO_CLOCK_EDIT, UNIT_RUNS_AS_OWNER, roleRequired(isPauseOrResume, "pausing or resuming a cycle"), reasonRequired(isPauseOrResume)],
    handler: compute(async (i, ctx, rt) => {
      const svc = cyclesOf(runtimeOf(rt)); const op = str(i, "op") || "list";
      if (op === "list") return svc.registryList();
      if (op === "pause") return svc.pauseCycle(ctx, rt, str(i, "cycle_code"), str(i, "reason"));
      if (op === "resume") return svc.resumeCycle(ctx, rt, str(i, "cycle_code"), str(i, "reason"));
      throw new RangeError("cycles.registry op is list, pause or resume");
    }),
    decision: (i, output, ctx) => (isPauseOrResume(i) ? { action: `cycles.registry:${String(i.op)}`, subject: { kind: "cycle", id: str(i, "cycle_code") }, rationale: `${String(i.op)} by ${by(ctx)}: ${str(i, "reason")}${Array.isArray(obj(output)["runs_cancelled"]) ? ` (runs cancelled: ${(obj(output)["runs_cancelled"] as unknown[]).length})` : ""}` } : null) },
  { name: "cycles.plan", kind: "act", ruleSetVersion: "cycles.v1", guardrails: [NO_MONEY_FIELD, NO_CLOCK_EDIT, UNIT_RUNS_AS_OWNER],
    handler: compute((i, ctx, rt) => cyclesOf(runtimeOf(rt)).planIn(ctx, rt, i)),
    decision: (_i, output) => { const o = output as PlanOutput | undefined; if (!o || o.skipped) return null;
      return { action: "cycles.plan", subject: { kind: "planner", id: o.as_of_date }, rationale: JSON.stringify({ as_of_date: o.as_of_date, planned_by: o.planned_by, runs_opened: o.runs_opened, jobs_planned: o.jobs_planned, leases_reclaimed: o.leases_reclaimed, unblocked: o.unblocked, requeued: o.requeued, receipts_reconciled: o.receipts_reconciled, overdue: o.overdue, errors: o.errors.length, duration_ms: o.duration_ms }) }; } },
  { name: "cycles.receipt", kind: "read", humanRoles: LIST_ROLES, guardrails: [NO_MONEY_FIELD, NO_CLOCK_EDIT],
    handler: compute((i, _ctx, rt) => cyclesOf(runtimeOf(rt)).readReceipt(str(i, "run_id"))) },
  { name: "jobs.list", kind: "read", humanRoles: LIST_ROLES, guardrails: [NO_MONEY_FIELD, NO_CLOCK_EDIT],
    handler: compute((i, _ctx, rt) => cyclesOf(runtimeOf(rt)).listJobs({ cycle_code: str(i, "cycle_code") || null, status: str(i, "status") || null, period_key: str(i, "period_key") || null, loan_id: str(i, "loan_id") || null, run_id: str(i, "run_id") || null, ...(typeof i["limit"] === "number" ? { limit: i["limit"] } : {}) })) },
  { name: "writeDecision", kind: "act", handler: decision() },
]);
