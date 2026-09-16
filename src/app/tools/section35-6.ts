/**
 * §35.6 process-owned tools — the `disclosures` agent's orchestration.* tools (spec "AI agent design"), defined with
 * `defineTools("35.6", "disclosures", defs)` and spread by ./index.ts. The pass itself runs from the sweep
 * (src/runtime/app.ts, `orchestration.pass` after the FAKE reviewers and before the breach pass) and inline per demo-clock day;
 * these tools are the same pass on demand, the hand-off, the reconciliation, the human holds and the board.
 *
 *   orchestration.open       act   {application_id} — one row for the application, folded from its log (ALREADY_OPEN otherwise).
 *   orchestration.pass       act   {as_of?, application_id?, limit?} — the pass; {op: daily_receipt} — the day's receipt and board.
 *   orchestration.step       act   {application_id, op: retry} — re-run the row's step now (an ops_analyst act from 35.8's screen).
 *   orchestration.snapshot   act   {application_id} — build a funding_snapshots row from the record (rule 6).
 *   orchestration.fund       act   {application_id, snapshot_id?, snapshot?} — 30.2's hand-off from the snapshot row; `snapshot`
 *                                  overrides are an officer's correction only (a replaced snapshot, never an edit); NOT_FUNDED before loan.funded.
 *   orchestration.reconcile  act   {application_id} — the three-sided purchase reconciliation (rule 8) for a purchased loan.
 *   orchestration.hold       act   {application_id, reason} (ops_analyst/officer) · orchestration.release {application_id} · orchestration.unwind {application_id, reason} (officer).
 *   orchestration.board      read  the open book (35.8's Closing screen).
 *   writeDecision            write the decision row (orchestration.v1).
 *
 * Guardrails (rules 1–12): ONE_STEP_PER_PASS, PASS_IS_IDEMPOTENT, NO_CLIENT_STATE, OWNER_EMITS, HUMAN_ACTS_STAY_HUMAN,
 * NO_GATE_RECOMPUTE, NO_CLOCK_EDIT, SNAPSHOT_CITES_SOURCES, FIXTURE_REFUSED_IN_PRODUCTION, THREE_SIDES_ONE_ADVICE, NO_MONEY_FIELD.
 */
import { defineTools, compute, never, guard, needsRole, str, PortUnavailable, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import { CommandRefused, type CommandContext } from "../commands.ts";
import type { Runtime } from "../../runtime/app.ts";
import { hasRole } from "../roles.ts";
import { runOrchestrationPass, processRow, orchestrationByApplication, orchestrationBoard, dailyReceipt, holdOrchestration, releaseOrchestration, unwindOrchestration, discoverApplication, decisionOf, ORCH_AGENT, ORCH_PROCESS, ORCH_RULE_SET_VERSION, ORCH_PROMPT_VERSION, sha256 } from "../../domain/operations-runtime/orchestration-35-6.ts";
import { buildFundingSnapshot, fundFromSnapshot } from "../../domain/operations-runtime/snapshot-35-6.ts";
import { reconcilePurchase } from "../../domain/operations-runtime/reconcile-35-6.ts";

const runtimeOf = (rt: ToolRuntime): Runtime => { const r = rt.services["runtime"] as Runtime | undefined; if (!r) throw new PortUnavailable("service:runtime"); return r; };
const has = (i: ToolInput, k: string): boolean => i[k] !== undefined && i[k] !== null && i[k] !== "";
/** Rule 2 / T14: the hand-fed objects the harnesses assemble — `conditions`, `facts`, `state`, a `*_cents` field, 26.3's `rescission`/`ptf`/`cash_to_close`/`gifts`, 29.4's `gate_facts`, 30.1's `loan`/`advice` — are refused before anything is written; the readers are the single source. */
export const CLIENT_STATE_KEYS: readonly string[] = ["conditions", "facts", "state", "rescission", "ptf", "cash_to_close", "gifts", "gate_facts", "loan", "advice", "worksheet", "snapshot_overrides"];
const namesClientState = (i: ToolInput): boolean => CLIENT_STATE_KEYS.some((k) => has(i, k)) || Object.keys(i).some((k) => /_cents$/.test(k));
export const NO_CLIENT_STATE = never("NO_CLIENT_STATE", "35.6 rule 2: 'On the hosted API a request to `orchestration.step` (or to any owning tool the pass is responsible for) whose input carries such an object, a `*_cents` field or `state` is refused `NO_CLIENT_STATE` before anything is written (T14); the readers are the single source in both the pass and the screens.'", namesClientState, "every command input is derived from the record inside the pass; nothing is hand-fed");
export const ONE_STEP_PER_PASS = never("ONE_STEP_PER_PASS", "35.6 rule 1: 'runs at most one step per row per pass in that row's own unit of work'", (i) => has(i, "steps") || has(i, "run_all") || has(i, "through_step"), "the pass advances a row by its own fold; a caller never names a step count or a target step");
export const PASS_IS_IDEMPOTENT = never("PASS_IS_IDEMPOTENT", "35.6 rule 1: 'A pass with no new fact and no due wait writes nothing (T12).'", (i) => has(i, "force") || has(i, "replay") || has(i, "rerun_commands"), "a pass is never forced: the record decides what runs");
export const OWNER_EMITS = never("OWNER_EMITS", "35.6 rule 3: 'The only events this process appends are its own (`orchestration.*`, `funding_snapshot.built`).'", (i) => has(i, "event") || has(i, "events") || has(i, "append"), "the pass never appends an owning section's event");
export const HUMAN_ACTS_STAY_HUMAN = never("HUMAN_ACTS_STAY_HUMAN", "35.6 rule 4: 'A step whose next command is reserved for a role enters waiting_human{role} and the pass does nothing on that row until the role's event arrives.'", (i) => has(i, "release_wire") || has(i, "submit_delivery") || has(i, "as_role") || has(i, "act_as") || str(i, "op") === "release", "the wire release, the Loan Delivery submission, reviewer-only conditions, waivers and unwinds are a person's acts");
export const NO_GATE_RECOMPUTE = never("NO_GATE_RECOMPUTE", "35.6 rule 5: 'Gates are asserted through their owners, never recomputed.'", (i) => has(i, "gate_open") || has(i, "gates") || has(i, "assume_gate_open"), "a gate's answer is the owner's; the pass reads it");
export const NO_CLOCK_EDIT = never("NO_CLOCK_EDIT", "35.6 rule 5: 'The registry's clocks are never satisfied, extended or cancelled by this process (34.4 rule 1).'", (i) => has(i, "timer_id") || has(i, "satisfy") || has(i, "extend") || has(i, "cancel_timer") || str(i, "op") === "satisfy" || str(i, "op") === "extend", "no timer is satisfied, extended or cancelled here");
export const SNAPSHOT_CITES_SOURCES = never("SNAPSHOT_CITES_SOURCES", "35.6 rule 6: 'The hand-off snapshot is built from the record, field by field, and its sources are stored.'", (i) => has(i, "sources") || has(i, "gaps") || has(i, "fixture_used"), "the sources and the gaps are the builder's findings, never an input");
export const FIXTURE_REFUSED_IN_PRODUCTION = guard("FIXTURE_REFUSED_IN_PRODUCTION", "35.6 rule 6: 'Under ENVIRONMENT=production any gap refuses the hand-off FIXTURE_REFUSED'", (i, ctx) => (has(i, "fixture") || has(i, "use_fixture") || has(i, "demo") ? `a fixture is never an input to the hand-off (${ctx.actor.kind}:${ctx.actor.id})` : undefined));
export const THREE_SIDES_ONE_ADVICE = never("THREE_SIDES_ONE_ADVICE", "35.6 rule 8: 'A purchase is reconciled on three sides of the same loan id, or it is an exception.'", (i) => has(i, "advice") || has(i, "net_proceeds") || has(i, "sides") || has(i, "bank_received") || has(i, "match"), "the advice, 30.1's match and the bank credit are read from the record; a one-sided figure is never accepted");
export const NO_MONEY_FIELD = never("NO_MONEY_FIELD", "35.6 rule 12: 'Nothing here moves money or edits a clock … a money-field change proposed by the agent without an officer approval record is refused and writes nothing.'", (i) => has(i, "changes") || has(i, "data") || Object.keys(i).some((k) => /_cents$/.test(k) || /^(amount|cents|upb|balance)$/.test(k)), "every ledger set, wire, advance, payoff and residual is the owner's tool under the owner's guardrails");
/** Rule 6: `snapshot` overrides on the hand-off are an officer's correction (a replaced snapshot, never an edit) — with an officer approval record (the officer's own act, or `approvedBy`); any other caller's overrides are NO_CLIENT_STATE. */
export const OFFICER_OVERRIDES_ONLY = guard("NO_CLIENT_STATE", "35.6 rule 6: 'accepts `snapshot` overrides only from an `officer` actor (a correction under 30.2's rule: a snapshot is replaced, never edited), refusing any other caller's overrides `NO_CLIENT_STATE`'", (i, ctx) => (has(i, "snapshot") && !hasRole(ctx.actor, ["officer"]) ? "a snapshot override is an officer's correction (the officer's own act is the approval record); every other caller's snapshot is the record's" : undefined));

const ALL: readonly ReturnType<typeof never>[] = [ONE_STEP_PER_PASS, PASS_IS_IDEMPOTENT, NO_CLIENT_STATE, OWNER_EMITS, HUMAN_ACTS_STAY_HUMAN, NO_GATE_RECOMPUTE, NO_CLOCK_EDIT, NO_MONEY_FIELD];
const appOf = (i: ToolInput, ctx: CommandContext): string => { const a = str(i, "application_id") || ctx.applicationId || ""; if (!a) throw new RangeError("35.6 tools need application_id (or an application-scoped command)"); return a; };
const decision = (action: string) => (i: ToolInput, output: unknown, ctx: CommandContext) => { const o = (output ?? {}) as Record<string, unknown>; const d = decisionOf({ orchestration_id: String(o["orchestration_id"] ?? o["id"] ?? ""), application_id: str(i, "application_id") || ctx.applicationId || "", loan_id: (o["loan_id"] as string | null | undefined) ?? null, step: String(o["step"] ?? ""), action, command: null, trigger_event_id: null, sources_sha256: sha256(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v))), rationale: String(o["line"] ?? o["rationale"] ?? `${action} by ${ctx.actor.kind}:${ctx.actor.id}`) }); return { action: d.action, rationale: d.rationale, subject: d.subject, ruleCode: d.ruleCode }; };

export const TOOLS_35_6: readonly ToolDef[] = defineTools(ORCH_PROCESS, ORCH_AGENT, [
  { name: "orchestration.open", kind: "act", ruleSetVersion: ORCH_RULE_SET_VERSION, guardrails: [...ALL], handler: compute(async (i, ctx, rt) => {
      const runtime = runtimeOf(rt); const applicationId = appOf(i, ctx);
      const existing = await orchestrationByApplication(runtime.db, applicationId);
      if (existing) throw new CommandRefused("orchestration.open", "ALREADY_OPEN", "35.6 edge cases: a second `orchestration.open` for the same application → refused `ALREADY_OPEN` with the existing id", `orchestration ${existing.id} is open for application ${applicationId} (${existing.step}, ${existing.status})`);
      await discoverApplication(runtime, applicationId, str(i, "at") || ctx.now);
      const row = (await orchestrationByApplication(runtime.db, applicationId))!;
      return { orchestration_id: row.id, application_id: applicationId, step: row.step, status: row.status, opened_at: row.opened_at }; }),
    decision: decision("opened") },
  { name: "orchestration.pass", kind: "act", ruleSetVersion: ORCH_RULE_SET_VERSION, guardrails: [...ALL], handler: compute(async (i, ctx, rt) => {
      const runtime = runtimeOf(rt); const at = str(i, "as_of") || str(i, "at") || ctx.now;
      if (str(i, "op") === "daily_receipt") { const r = await dailyReceipt(runtime, at); return { op: "daily_receipt", ...r, line: `daily receipt ${r.as_of_date}: open=${r.open} held=${r.held}${r.ran ? "" : " (already produced)"}` }; }
      const r = await runOrchestrationPass(runtime, at, { ...(str(i, "application_id") ? { applicationId: str(i, "application_id") } : ctx.applicationId ? { applicationId: ctx.applicationId } : {}), ...(typeof i["limit"] === "number" ? { limit: i["limit"] } : {}), holder: `tool:${ctx.actor.kind}:${ctx.actor.id}` });
      return { ...r, orchestration_id: r.rows[0]?.orchestration_id ?? "", step: r.rows[0]?.to ?? "", status: r.rows[0]?.status ?? "" }; }),
    decision: decision("pass") },
  { name: "orchestration.step", kind: "act", ruleSetVersion: ORCH_RULE_SET_VERSION, humanRoles: ["ops_analyst", "officer"], guardrails: [...ALL], handler: compute(async (i, ctx, rt) => {
      const runtime = runtimeOf(rt); const applicationId = appOf(i, ctx);
      if ((str(i, "op") || "retry") !== "retry") throw new RangeError("orchestration.step takes op: retry (the owners' tools are the other acts; 35.8's screens dispatch them)");
      const row = await orchestrationByApplication(runtime.db, applicationId); if (!row) throw new RangeError(`no orchestration for application ${applicationId}`);
      const forced = { ...row, status: row.status === "held" && row.hold_reason !== "failed" ? row.status : row.status === "held" ? ("open" as const) : row.status, step_attempts: 0, hold_reason: row.status === "held" && row.hold_reason === "failed" ? null : row.hold_reason };
      const r = await processRow(runtime, forced, str(i, "at") || ctx.now, runtime.sweepRunId);
      return { ...r, orchestration_id: row.id, application_id: applicationId, step: r.to }; }),
    decision: decision("retried") },
  { name: "orchestration.snapshot", kind: "act", ruleSetVersion: ORCH_RULE_SET_VERSION, guardrails: [...ALL, SNAPSHOT_CITES_SOURCES, FIXTURE_REFUSED_IN_PRODUCTION], handler: compute(async (i, ctx, rt) => {
      const runtime = runtimeOf(rt); const applicationId = appOf(i, ctx);
      const r = await buildFundingSnapshot(runtime, applicationId, { now: str(i, "at") || ctx.now, actor: ctx.actor, persist: true });
      return { snapshot_id: r.snapshot_id, application_id: applicationId, snapshot_hash: r.snapshot_hash, gaps: r.gaps, fixture_used: r.fixture_used, environment: r.environment, refused_code: r.refused_code, sources: r.sources, step: "funded", orchestration_id: r.orchestration_id }; }),
    decision: decision("snapshot_built") },
  { name: "orchestration.fund", kind: "act", ruleSetVersion: ORCH_RULE_SET_VERSION, moneyFields: ["pi_cents", "initial_escrow_deposit_cents", "prepaid_interest_cents", "amount_cents", "monthly_escrow_cents"], guardrails: [ONE_STEP_PER_PASS, PASS_IS_IDEMPOTENT, OWNER_EMITS, HUMAN_ACTS_STAY_HUMAN, NO_GATE_RECOMPUTE, NO_CLOCK_EDIT, SNAPSHOT_CITES_SOURCES, FIXTURE_REFUSED_IN_PRODUCTION, OFFICER_OVERRIDES_ONLY,
      never("NO_CLIENT_STATE", "35.6 rule 2 / rule 6: only an officer's `snapshot` correction rides on the hand-off; `funded`, `state`, `facts` or a `*_cents` field at the top level are refused", (i) => has(i, "funded") || has(i, "state") || has(i, "facts") || Object.keys(i).some((k) => /_cents$/.test(k)), "26.3's loan.funded is read from the log; the snapshot is the record's")],
    handler: compute(async (i, ctx, rt) => {
      const runtime = runtimeOf(rt); const applicationId = appOf(i, ctx);
      const r = await fundFromSnapshot(runtime, applicationId, { now: str(i, "at") || ctx.now, actor: ctx.actor, snapshot_id: str(i, "snapshot_id") || null, overrides: (i["snapshot"] as Record<string, unknown> | undefined) ?? null });
      return { ...r, step: "funded" }; }),
    decision: decision("funded") },
  { name: "orchestration.reconcile", kind: "act", ruleSetVersion: ORCH_RULE_SET_VERSION, guardrails: [...ALL, THREE_SIDES_ONE_ADVICE], handler: compute(async (i, ctx, rt) => {
      const runtime = runtimeOf(rt); const applicationId = appOf(i, ctx);
      return reconcilePurchase(runtime, applicationId, { now: str(i, "at") || ctx.now, actor: ctx.actor }); }),
    decision: decision("reconciled") },
  { name: "orchestration.hold", kind: "act", ruleSetVersion: ORCH_RULE_SET_VERSION, humanRoles: ["ops_analyst", "officer"], guardrails: [...ALL, needsRole("HOLD_IS_HUMAN", "35.6 Inputs: `orchestration.hold{reason}` and `orchestration.release` (`ops_analyst`)", () => true, ["ops_analyst", "officer"], "a hold is an ops_analyst's act from 35.8's screen")], handler: compute(async (i, ctx, rt) => {
      const runtime = runtimeOf(rt); const applicationId = appOf(i, ctx); if (!str(i, "reason")) throw new RangeError("orchestration.hold needs reason");
      const row = await holdOrchestration(runtime, applicationId, str(i, "reason"), ctx.actor, str(i, "at") || ctx.now);
      return { orchestration_id: row.id, application_id: applicationId, step: row.step, status: row.status, hold_reason: row.hold_reason }; }),
    decision: decision("held") },
  { name: "orchestration.release", kind: "act", ruleSetVersion: ORCH_RULE_SET_VERSION, humanRoles: ["ops_analyst", "officer"], guardrails: [...ALL, needsRole("RELEASE_IS_HUMAN", "35.6 Inputs: `orchestration.release` (`ops_analyst`)", () => true, ["ops_analyst", "officer"], "a release is an ops_analyst's act")], handler: compute(async (i, ctx, rt) => {
      const runtime = runtimeOf(rt); const applicationId = appOf(i, ctx);
      const row = await releaseOrchestration(runtime, applicationId, ctx.actor, str(i, "at") || ctx.now);
      return { orchestration_id: row.id, application_id: applicationId, step: row.step, status: row.status }; }),
    decision: decision("released") },
  { name: "orchestration.unwind", kind: "act", ruleSetVersion: ORCH_RULE_SET_VERSION, humanRoles: ["officer"], guardrails: [...ALL, needsRole("UNWIND_IS_OFFICER", "35.6 Inputs: `orchestration.unwind{reason}` (`officer`)", () => true, ["officer"], "an unwind is an officer's act (rule 11)")], handler: compute(async (i, ctx, rt) => {
      const runtime = runtimeOf(rt); const applicationId = appOf(i, ctx); if (!str(i, "reason")) throw new RangeError("orchestration.unwind needs reason");
      const row = await unwindOrchestration(runtime, applicationId, str(i, "reason"), ctx.actor, str(i, "at") || ctx.now);
      return { orchestration_id: row.id, application_id: applicationId, step: row.step, status: row.status }; }),
    decision: decision("unwound") },
  { name: "orchestration.board", kind: "read", humanRoles: ["ops_analyst", "officer", "compliance", "funding_approver", "fnma_portal_operator", "settlement_agent", "underwriting_reviewer"], guardrails: [NO_CLIENT_STATE, NO_MONEY_FIELD], handler: compute(async (i, ctx, rt) => { const runtime = runtimeOf(rt); const rows = await orchestrationBoard(runtime.db, str(i, "at") || ctx.now); return { at: str(i, "at") || ctx.now, rows, open: rows.length }; }) },
  { name: "writeDecision", kind: "write", ruleSetVersion: ORCH_RULE_SET_VERSION, guardrails: [...ALL], handler: compute((i, ctx) => { const applicationId = appOf(i, ctx); return { recorded: true, application_id: applicationId, rule_set_version: ORCH_RULE_SET_VERSION, prompt_version: ORCH_PROMPT_VERSION, action: str(i, "action") || "note" }; }),
    decision: (i, _o, ctx) => { const d = decisionOf({ orchestration_id: str(i, "orchestration_id"), application_id: str(i, "application_id") || ctx.applicationId || "", loan_id: str(i, "loan_id") || null, step: str(i, "step"), action: str(i, "action") || "note", command: null, trigger_event_id: str(i, "trigger_event_id") || null, sources_sha256: str(i, "sources_sha256") || sha256("{}"), rationale: str(i, "rationale") || "35.6 writeDecision" }); return { action: d.action, rationale: d.rationale, subject: d.subject, ruleCode: d.ruleCode }; } },
]);
