/**
 * §35.4 process-owned tools — the `custodial-recon` agent's close.* tools (spec/sections/35-operations-runtime/
 * 35-4-month-end-and-year-end-close.md "AI agent design"), defined with `defineTools("35.4", "custodial-recon", defs)` and
 * spread by ./index.ts. Every tool runs on the command's own transaction (`ctx.q`, 35.1 rule 7) so what it writes commits
 * with its events, timers and decision row, or not at all. The planner (the sweep's close pass, src/domain/operations-runtime/
 * close-35-4/sweep.ts) is a system actor calling the same functions; the tools are the same acts by hand.
 *
 *   close.open           act   {period, period_end?, source_event_id?} — the period and its steps (idempotent; rule 11).
 *   close.plan           act   {} — one planning transaction: receipts, blocked → planned → running → completed, the stall label, the roll-up.
 *   close.step.start     act   {period, step} — a planned (or failed) step started by hand; a blocked step is refused STEP_BLOCKED{missing}.
 *   close.step.complete  act   {period, step} — records the receipts present now; completes only when received = expected (never a receipt of its own).
 *   close.step.skip      act   {period, step, reason} — an officer skips a step the period cannot have (records a reason, never a receipt).
 *   close.board          read  {period? | tax_year?} — the Close view; no row changes.
 *   close.attest         act   {period, custodial_account_id?, remittance_type?, op: prepare | approve | attest} — rule 3 to the cent; NO_PLUG; the flag from configuration.
 *   close.review         act   {period, preparer_decision_id} — qc-audit's independent re-derivation (rule 6).
 *   close.reopen         act   {period, reason, trigger_event_id, op: propose | reopen} — an officer's act (rule 9); an agent proposes.
 *   close.tax_year       act   {tax_year} — the December period's tax-year close (rule 10); idempotent.
 *   writeDecision        act   the decision row (close.v1).
 *
 * Guardrails: NO_PLUG (no ledger, payment, reconciliation or `*_cents` write; no force / override / tolerance input),
 * RECEIPTS_ARE_OWNERS_EVENTS (an input asking this process to emit or record a section's receipt is refused), NO_CLOCK_EDIT,
 * NO_SELF_ASSERTED_ACTOR / APPROVER_NOT_SELF_ASSERTED (35.7's), OFFICER_REOPEN_ONLY, FLAG_FROM_CONFIG (the request's
 * `human_approval_on` is ignored, never read). Every state-changing call writes its own decision row (rule_set_version
 * close.v1, prompt_version 35.4-v1) on the command's transaction so its id is known; the bus's default builder is off.
 */
import { compute, decision, defineTools, guard, never, str, type ToolDef, type ToolInput } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import type { Runtime } from "../../runtime/app.ts";
import { PortUnavailable } from "../tools.ts";
import { HUMAN_ROLES, hasRole } from "../roles.ts";
import { NO_CLOCK_EDIT, NO_SELF_ASSERTED_ACTOR, APPROVER_NOT_SELF_ASSERTED } from "../../domain/operations-runtime/roles-35-7/guards.ts";
import { openClosePeriod } from "../../domain/operations-runtime/close-35-4/open.ts";
import { planPeriods, recordReceipts } from "../../domain/operations-runtime/close-35-4/plan.ts";
import { boardOf } from "../../domain/operations-runtime/close-35-4/board.ts";
import { closePorts } from "../../domain/operations-runtime/close-35-4/ports.ts";
import { journal, patchStep, periodOf, stepOf, stepsOf, writeCloseDecision } from "../../domain/operations-runtime/close-35-4/store.ts";
import { stepDef } from "../../domain/operations-runtime/close-35-4/chain.ts";
import { periodEndOf } from "../../domain/operations-runtime/close-35-4/calendar.ts";
import { CLOSE_AGENT, CLOSE_PROCESS, CLOSE_RULE_SET_VERSION, CloseRefused, PERIOD_RE, periodAggregate, stepAggregate } from "../../domain/operations-runtime/close-35-4/types.ts";
import { attestTool, reviewTool } from "../../domain/operations-runtime/close-35-4/attest.ts";
import { reopenTool } from "../../domain/operations-runtime/close-35-4/reopen.ts";
import { taxYearTool } from "../../domain/operations-runtime/close-35-4/taxyear.ts";
import type { PlainDate } from "../../kernel/calendar/date.ts";

const has = (i: ToolInput, k: string): boolean => i[k] !== undefined && i[k] !== null && i[k] !== "";
const moneyKey = (k: string): boolean => /_cents$/.test(k) || /^(amount|cents|upb|balance|plug|adjustment)$/.test(k);
const namesMoney = (v: unknown): boolean => !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v as Record<string, unknown>).some(moneyKey);
/** Rule 4: "There is no `force`, `override` or `tolerance` input on `close.attest`; a request carrying one is refused `NO_PLUG` before any read." No tool here writes a money column (rule 12). */
export const NO_PLUG = never("NO_PLUG", "35.4 rule 4: 'Never a plug. No tool in this process writes ledger_lines, payments, reconciliations, reconciliation_items or any *_cents column of another section … There is no force, override or tolerance input on close.attest; a request carrying one is refused NO_PLUG before any read'",
  (i) => Object.keys(i).some((k) => moneyKey(k) || /^(force|override|tolerance|tolerance_cents|plug|balancing_entry|entry_set|lines)$/.test(k)) || namesMoney(i["changes"]) || namesMoney(i["data"]) || has(i, "changes") || has(i, "data"),
  "a variance is explained by the owning section's own corrections (2.1 reversal, 6.3 item, 5.1 correction) and re-attested; no figure is supplied, forced or tolerated here");
/** Rule 2 / guardrail RECEIPTS_ARE_OWNERS_EVENTS: an input that asks this process to emit, fabricate or record a receipt on a section's behalf is refused. */
export const RECEIPTS_ARE_OWNERS_EVENTS = never("RECEIPTS_ARE_OWNERS_EVENTS", "35.4 rule 2: 'Receipts are the sections' own events … 35.4 never emits a receipt on a section's behalf; a step with no receipt after its unit ran is a 35.3 failure, not a completion'",
  (i) => ["receipt", "receipts", "emit", "event_type", "receipt_event", "mark_received", "received"].some((k) => has(i, k)), "a receipt is the owning section's own event on the bus; this process records what it observes and emits none");
/** Rule 9: "Only an `officer` reopens" — an agent proposes (op: propose), an ops_analyst is refused. */
export const OFFICER_REOPEN_ONLY = guard("OFFICER_REOPEN_ONLY", "35.4 rule 9: 'Only an officer reopens, with a reason and the triggering event'; AI agent design: 'the agent proposes a reopen … and never performs it'",
  (i, ctx) => (str(i, "op") !== "propose" && !hasRole(ctx.actor, ["officer"]) ? `a reopen is the officer's act; ${ctx.actor.kind}:${ctx.actor.id}${ctx.actor.role ? ` (${ctx.actor.role})` : ""} may propose one (op: propose), never perform it` : undefined));
const COMMON = [NO_SELF_ASSERTED_ACTOR, APPROVER_NOT_SELF_ASSERTED, NO_CLOCK_EDIT, NO_PLUG, RECEIPTS_ARE_OWNERS_EVENTS];

export const txOf = (ctx: CommandContext) => { if (!ctx.q) throw new RangeError("35.4 tools run inside a database command (PgUnitOfWork): no transaction on this context"); return ctx.q; };
export const runtimeOf = (rt: { services: Record<string, unknown> }): Runtime => { const r = rt.services["runtime"] as Runtime | undefined; if (!r) throw new PortUnavailable("service:runtime"); return r; };
const periodKey = (i: ToolInput): string => { const p = str(i, "period"); if (!p) throw new RangeError("period (YYYY-MM, or YYYY-TY for a tax year) is required"); if (!PERIOD_RE.test(p) && !/^\d{4}-TY$/.test(p)) throw new RangeError("period is YYYY-MM or YYYY-TY"); return p; };
const stepCode = (i: ToolInput): string => { const s = str(i, "step"); if (!s) throw new RangeError("step is required"); stepDef(s as Parameters<typeof stepDef>[0]); return s; };
const DONE = new Set(["completed", "skipped", "pre_reopen"]);

export const TOOLS_35_4: readonly ToolDef[] = defineTools(CLOSE_PROCESS, CLOSE_AGENT, [
  { name: "close.open", kind: "act", ruleSetVersion: CLOSE_RULE_SET_VERSION, guardrails: COMMON, decision: () => null,
    handler: compute(async (i, ctx, rt) => {
      const q = txOf(ctx); const period = periodKey(i); const runtime = runtimeOf(rt);
      const servicer = str(i, "servicer_number") || await closePorts(runtime).servicer.servicerNumber(q);
      const r = await openClosePeriod(ctx, { period, ...(has(i, "period_end") ? { period_end: str(i, "period_end") as PlainDate } : {}), servicer_number: servicer, source_event_id: has(i, "source_event_id") ? str(i, "source_event_id") : null });
      await writeCloseDecision(ctx, { action: "close.open", subject: { kind: "close_period", id: r.period.id }, record: { period, servicer_number: servicer, action: "close.open", created: r.created, steps: r.steps.length }, rationale: r.created ? `period ${period} opened with ${r.steps.length} steps from rule 1's table` : `period ${period} already open: duplicate journaled, no new steps, no new clock` });
      return { close_period_id: r.period.id, period, status: r.period.status, created: r.created, steps: r.steps };
    }) },
  { name: "close.plan", kind: "act", ruleSetVersion: CLOSE_RULE_SET_VERSION, guardrails: COMMON, decision: () => null,
    handler: compute(async (i, ctx, rt) => {
      const q = txOf(ctx); const runtime = runtimeOf(rt);
      const servicer = str(i, "servicer_number") || await closePorts(runtime).servicer.servicerNumber(q);
      const r = await planPeriods({ q, events: ctx.events, now: ctx.now, actor: ctx.actor, escalations: rt.escalations, ports: closePorts(runtime), servicer, plannedBy: `${ctx.actor.kind}:${ctx.actor.id}` });
      const { units_to_run, ...rest } = r;
      await writeCloseDecision(ctx, { action: "close.plan", subject: { kind: "servicer", id: servicer }, record: { action: "close.plan", servicer_number: servicer, ...rest }, rationale: `planned ${r.planned.length}, started ${r.started.length}, completed ${r.completed.length}, receipts ${r.receipts}, closed ${r.closed.length}` });
      return { ...rest, units_planned: units_to_run.map((u) => ({ period: u.period, step: u.step, cycle_code: u.cycle_code, cycle_run_id: u.run_id, units: u.units.map((x) => x.unit_id) })) };
    }) },
  { name: "close.step.start", kind: "act", ruleSetVersion: CLOSE_RULE_SET_VERSION, guardrails: COMMON, decision: () => null,
    handler: compute(async (i, ctx, rt) => {
      const q = txOf(ctx); const period = periodKey(i); const code = stepCode(i); const runtime = runtimeOf(rt);
      const servicer = await closePorts(runtime).servicer.servicerNumber(q);
      const p = await periodOf(q, { period }, servicer, true); if (!p) throw new RangeError(`no close period ${period}`);
      const s = await stepOf(q, p.id, code); if (!s) throw new RangeError(`period ${period} has no step ${code}`);
      const all = await stepsOf(q, p.id); const byCode = new Map(all.map((x) => [x.code, x]));
      const missing = s.depends_on.filter((c) => { const x = byCode.get(c); return x ? !DONE.has(x.status) : true; });
      if (s.status === "blocked" || missing.length) throw new CloseRefused("STEP_BLOCKED", "35.4 rule 1: 'A step is planned only when every dependency is completed or skipped'", `${code} is blocked on ${missing.join(", ") || "its dependencies"}`, { missing });
      if (DONE.has(s.status)) return { period, step: code, status: s.status, started_at: s.started_at, changed: false };
      if (s.status === "running" || s.status === "stalled") return { period, step: code, status: s.status, started_at: s.started_at, changed: false };
      // planned (or failed → re-planned by hand, the `cycles.retry` of the state machine): the first claim is now
      const startedAt = ctx.now;
      ctx.events.append({ type: "close.step.started", aggregate: stepAggregate(servicer, period, code), actor: ctx.actor, payload: { close_period_id: p.id, step_id: s.id, period, step: code, started_at: startedAt, by_hand: true, cycle_run_id: s.cycle_run_id } });
      await patchStep(q, s.id, { status: "running", started_at: startedAt, attempts: s.status === "failed" ? s.attempts + 1 : s.attempts, last_error: null }, ctx.now);
      await journal(q, { close_period_id: p.id, step_id: s.id, type: "close.step.started", actor: ctx.actor, occurred_at: ctx.now, payload: { period, step: code, started_at: startedAt, by_hand: true } });
      await writeCloseDecision(ctx, { action: "close.step.start", subject: { kind: "close_period_step", id: s.id }, record: { action: "close.step.start", period, step: code, started_at: startedAt }, rationale: `${code} of ${period} started by hand` });
      return { period, step: code, status: "running", started_at: startedAt, changed: true };
    }) },
  { name: "close.step.complete", kind: "act", ruleSetVersion: CLOSE_RULE_SET_VERSION, guardrails: COMMON, decision: () => null,
    handler: compute(async (i, ctx, rt) => {
      const q = txOf(ctx); const period = periodKey(i); const code = stepCode(i); const runtime = runtimeOf(rt);
      const servicer = await closePorts(runtime).servicer.servicerNumber(q);
      const p = await periodOf(q, { period }, servicer, true); if (!p) throw new RangeError(`no close period ${period}`);
      const s0 = await stepOf(q, p.id, code); if (!s0) throw new RangeError(`period ${period} has no step ${code}`);
      if (DONE.has(s0.status)) return { period, step: code, status: s0.status, received: s0.received, expected_receipts: s0.expected_receipts, changed: false };
      // rule 2: the receipts present now, the owning section's own events — completion only when received = expected
      const r = await recordReceipts({ q, events: ctx.events, now: ctx.now, actor: ctx.actor, escalations: rt.escalations, ports: closePorts(runtime), servicer, plannedBy: `${ctx.actor.kind}:${ctx.actor.id}` }, p, s0);
      const s = (await stepOf(q, p.id, code))!;
      if (r.received < s.expected_receipts) throw new CloseRefused("RECEIPTS_ARE_OWNERS_EVENTS", "35.4 rule 2: 'A step completes when received = expected_receipts matching receipt_event_type and receipt_filter have been observed on the bus'", `${code} of ${period} has ${r.received} of ${s.expected_receipts} receipts (${s.receipt_event_type}); a step is completed by the owning section's events, never by hand`, { received: r.received, expected_receipts: s.expected_receipts });
      const startedAt = s.started_at ?? ctx.now;
      ctx.events.append({ type: "close.step.completed", aggregate: stepAggregate(servicer, period, code), actor: ctx.actor, payload: { close_period_id: p.id, step_id: s.id, period, step: code, started_at: startedAt, completed_at: ctx.now, received: r.received, expected_receipts: s.expected_receipts } });
      await patchStep(q, s.id, { status: "completed", started_at: startedAt, completed_at: ctx.now }, ctx.now);
      await journal(q, { close_period_id: p.id, step_id: s.id, type: "close.step.completed", actor: ctx.actor, occurred_at: ctx.now, payload: { period, step: code, received: r.received, expected_receipts: s.expected_receipts } });
      await writeCloseDecision(ctx, { action: "close.step.complete", subject: { kind: "close_period_step", id: s.id }, record: { action: "close.step.complete", period, step: code, received: r.received, expected_receipts: s.expected_receipts }, rationale: `${code} of ${period} completed on ${r.received} of ${s.expected_receipts} receipts` });
      return { period, step: code, status: "completed", received: r.received, expected_receipts: s.expected_receipts, changed: true };
    }) },
  { name: "close.step.skip", kind: "act", ruleSetVersion: CLOSE_RULE_SET_VERSION, humanOnly: true, humanRoles: ["officer"], guardrails: COMMON, decision: () => null,
    handler: compute(async (i, ctx, rt) => {
      const q = txOf(ctx); const period = periodKey(i); const code = stepCode(i); const reason = str(i, "reason"); const runtime = runtimeOf(rt);
      if (!reason) throw new RangeError("reason is required (no_ti_account, no_eligibility_quarter, …)");
      const servicer = await closePorts(runtime).servicer.servicerNumber(q);
      const p = await periodOf(q, { period }, servicer, true); if (!p) throw new RangeError(`no close period ${period}`);
      const s = await stepOf(q, p.id, code); if (!s) throw new RangeError(`period ${period} has no step ${code}`);
      if (s.status !== "blocked" && s.status !== "planned" && s.status !== "failed") throw new CloseRefused("STEP_NOT_SKIPPABLE", "35.4 state machine: 'blocked | planned —(close.step.skip by an officer)→ skipped'", `${code} of ${period} is ${s.status}; only a blocked or planned step is skipped`, { status: s.status });
      ctx.events.append({ type: "close.step.skipped", aggregate: periodAggregate(servicer, period), actor: ctx.actor, payload: { close_period_id: p.id, step_id: s.id, period, step: code, reason, by: ctx.actor.id } });
      await patchStep(q, s.id, { status: "skipped", skipped_reason: reason, completed_at: ctx.now }, ctx.now);
      await journal(q, { close_period_id: p.id, step_id: s.id, type: "close.step.skipped", actor: ctx.actor, occurred_at: ctx.now, payload: { period, step: code, reason, by: ctx.actor.id } });
      await writeCloseDecision(ctx, { action: "close.step.skip", subject: { kind: "close_period_step", id: s.id }, record: { action: "close.step.skip", period, step: code, reason }, rationale: `${code} of ${period} skipped by the officer: ${reason} (a reason, never a receipt)` });
      return { period, step: code, status: "skipped", reason };
    }) },
  { name: "close.board", kind: "read", guardrails: [NO_CLOCK_EDIT, NO_PLUG],
    handler: compute(async (i, ctx, rt) => { const q = txOf(ctx); const runtime = runtimeOf(rt); const servicer = str(i, "servicer_number") || await closePorts(runtime).servicer.servicerNumber(q); return boardOf(q, { ...(has(i, "period") ? { period: periodKey(i) } : {}), ...(has(i, "tax_year") ? { tax_year: Number(i["tax_year"]) } : {}) }, servicer); }) },
  { name: "close.attest", kind: "act", ruleSetVersion: CLOSE_RULE_SET_VERSION, humanRoles: ["officer"], guardrails: COMMON, decision: () => null, handler: compute(attestTool) },
  { name: "close.review", kind: "act", ruleSetVersion: CLOSE_RULE_SET_VERSION, humanRoles: ["qc_officer"], guardrails: COMMON, decision: () => null, handler: compute(reviewTool) },
  { name: "close.reopen", kind: "act", ruleSetVersion: CLOSE_RULE_SET_VERSION, humanRoles: [...HUMAN_ROLES], guardrails: [...COMMON, OFFICER_REOPEN_ONLY], decision: () => null, handler: compute(reopenTool) },
  { name: "close.tax_year", kind: "act", ruleSetVersion: CLOSE_RULE_SET_VERSION, guardrails: COMMON, decision: () => null, handler: compute(taxYearTool) },
  { name: "writeDecision", kind: "act", ruleSetVersion: CLOSE_RULE_SET_VERSION, guardrails: [NO_PLUG], handler: decision() },
]);
export const periodEndOfTool = periodEndOf;
