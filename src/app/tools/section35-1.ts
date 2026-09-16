/**
 * §35.1 process-owned tools — the `security-records` agent's record.* and outbox.dispatch tools
 * (spec/sections/35-operations-runtime/35-1-persistence-seam-and-the-typed-record.md "AI agent design"), defined with
 * `defineTools("35.1", "security-records", defs)` and spread by ./index.ts. The seam itself is not an agent act — projectors,
 * locks and the guard run inside every command's unit of work (src/infra/db/unit-of-work.ts, src/runtime/app.ts); these
 * tools are the daily verify run, the gap report, a replay of one kind into its typed table (idempotent; dry-run first),
 * a service snapshot, the lease status and the outbox drain the sweep calls. Every one runs on the command's own
 * transaction (`ctx.q`) so what it writes commits with its decision record and events, or not at all.
 *
 *   record.project   act   {kind, entity_id?} — one kind's un-projected versions into its typed table (phase `replay`).
 *   record.replay    act   {kind, scope_key?, dry_run} — every scope's versions oldest first; keys minted once; a second run
 *                          writes zero rows and zero events (REPLAY_IS_IDEMPOTENT); `record.replayed{kind, scope_key, versions, rows}`.
 *   record.gaps      read  {as_of_date} — kinds by gap reason with counts (no writes).
 *   record.verify    act   {as_of_date, kinds?} — the daily verify run (rule 13): gaps, mismatches, one projection_runs row,
 *                          `projection.run_completed`; a money mismatch is a sev 1 `ciso` escalation and no correction.
 *   record.snapshot  act   {service_key, application_id | loan_id} — a service_snapshots row folded through the record.
 *   record.lease     read  {op: status | list} — the sweep lease's evidence (sweep_runs), never the lock.
 *   outbox.dispatch  act   {adapter?, limit?} — the sweep's own drain, runnable by hand; {op: abandon, message_id, reason} —
 *                          an ops_analyst abandons a dead letter (integration.message.abandoned; the review clock is cancelled).
 *   writeDecision    act   the decision row (records.v1; ids and column names only — NO_PII_IN_DECISION).
 *
 * Guardrails: NO_MONEY_FIELD_CHANGE (an input naming a `*_cents` override, `changes` or `data` is refused — a correction is
 * the owning section's officer command, rule 14), HOLD_BLOCKS_REPLAY (a scope under a legal hold is skipped as
 * key_conflict{hold: true} — the runner), NO_PII_IN_DECISION (the decision carries ids, counts and column names only).
 */
import { defineTools, compute, decision, never, guard, str, PortUnavailable, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import type { Queryable } from "../../infra/db/client.ts";
import type { Runtime } from "../../runtime/app.ts";
import { replayKind, gapsReport } from "../../domain/operations-runtime/seam/replay.ts";
import { verifyRun } from "../../domain/operations-runtime/seam/verify.ts";
import { leaseStatus, leaseList } from "../../domain/operations-runtime/seam/sweep.ts";
import { drainOutbox, abandonDeadLetter } from "../../domain/operations-runtime/seam/outbox.ts";
import { serviceSpec, writeSnapshot } from "../../runtime/origination.ts";

export const SEAM_PROCESS = "35.1";
export const SEAM_AGENT = "security-records";
export const SEAM_RULE_SET_VERSION = "records.v1";
export const SEAM_PROMPT_VERSION = "35.1-v1";

const has = (i: ToolInput, k: string): boolean => i[k] !== undefined && i[k] !== null && i[k] !== "";
const moneyKey = (k: string): boolean => /_cents$/.test(k) || /^(amount|cents|upb|balance)$/.test(k);
const namesMoney = (v: unknown): boolean => !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v as Record<string, unknown>).some(moneyKey);

/** Rule 14: "A projector, a replay and a verify never write a money column except by copying the owning section's version; a correction is the owning section's command with its `officer` waiver." No actor overrides it here — the officer acts through the section's command. */
export const NO_MONEY_FIELD_CHANGE = never("NO_MONEY_FIELD_CHANGE", "35.1 rule 14: 'No money field changes here. A projector, a replay and a verify never write a money column except by copying the owning section's version; a correction is the owning section's command with its officer waiver (convention 6; T15)'",
  (i) => namesMoney(i["overrides"]) || namesMoney(i["changes"]) || namesMoney(i["data"]) || Object.keys(i).some(moneyKey) || has(i, "correct") || has(i, "correction"),
  "the seam copies the owning section's version and never writes a money column by hand; a money correction is the owning section's officer command (2.1 for payments), not a replay override");

const runtimeOf = (rt: ToolRuntime): Runtime => { const r = rt.services["runtime"] as Runtime | undefined; if (!r) throw new PortUnavailable("service:runtime"); return r; };
/** The lease is never broken by a tool: an input asking to release, steal, reset or expire it is refused (LEASE_DIES_WITH_SESSION — no table row is ever the lock). */
const LEASE_KEYS = ["release", "break", "steal", "force", "reset", "expire", "unlock", "kill"];
const LEASE_DIES_WITH_SESSION = never("LEASE_DIES_WITH_SESSION", "35.1 rule 12 / guardrails: 'LEASE_DIES_WITH_SESSION (no table row is ever the lock)'; open question 3: 'the session lock is the lock and sweep_runs is the evidence'", (i) => LEASE_KEYS.some((k) => has(i, k)) || (typeof i["op"] === "string" && LEASE_KEYS.includes(i["op"])), "the lease is a session-level advisory lock that dies with its session; record.lease shows sweep_runs (status | list) and never breaks a lease");
/** An abandonment is a named person's act (the Timers note: 'a dead letter is resolved by a send or by a named person's abandonment, never by time'). */
const ABANDON_IS_HUMAN = guard("ABANDON_IS_HUMAN", "35.1 Timers note: `integration.message.abandoned{message_id, by, reason}` is 'an ops_analyst act through 34.4's controls'", (i, ctx) => (i["op"] === "abandon" && ctx.actor.kind !== "human" ? "abandoning a dead letter is an ops_analyst's act; an agent may not" : undefined));
/** The command's transaction: every seam tool reads and writes inside it (a unit harness without a database refuses with a typed reason). */
export const txOf = (ctx: CommandContext): Queryable => { if (!ctx.q) throw new RangeError("35.1 tools run inside a database command (PgUnitOfWork): no transaction on this context"); return ctx.q; };
const asOfDateOf = (i: ToolInput, ctx: CommandContext): string => { const d = str(i, "as_of_date") || ctx.now.slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new RangeError("as_of_date is a civil date YYYY-MM-DD"); return d; };

/** The decision record schema of the AI agent design paragraph: {run_id | kind | message_id, action, scope_key?, versions, rows_written, mismatches, gaps, state_sha256?, rule_set_version: records.v1, model_version: deterministic, prompt_version: 35.1-v1, confidence: 1, rationale} — ids and column names only (NO_PII_IN_DECISION). */
export function seamDecision(d: { subject: { kind: string; id: string }; action: "verify" | "replay" | "snapshot" | "dispatch"; scope_key?: string | null; versions?: number; rows_written?: number; mismatches?: number; gaps?: number; state_sha256?: string | null; rationale: string }): { action: string; rationale: string; subject: { kind: string; id: string }; ruleCode: string; modelVersion: string; promptVersion: string; confidence: number } {
  const record = { ...d.subject.kind === "run" ? { run_id: d.subject.id } : d.subject.kind === "message" ? { message_id: d.subject.id } : { kind: d.subject.id }, action: d.action, ...(d.scope_key !== undefined ? { scope_key: d.scope_key } : {}), versions: d.versions ?? 0, rows_written: d.rows_written ?? 0, mismatches: d.mismatches ?? 0, gaps: d.gaps ?? 0,
    ...(d.state_sha256 !== undefined ? { state_sha256: d.state_sha256 } : {}), rule_set_version: SEAM_RULE_SET_VERSION, model_version: "deterministic", prompt_version: SEAM_PROMPT_VERSION, confidence: 1, rationale: d.rationale };
  return { action: `record.${d.action}`, rationale: JSON.stringify(record), subject: d.subject, ruleCode: "35.1", modelVersion: "deterministic", promptVersion: SEAM_PROMPT_VERSION, confidence: 1 };
}

const replayHandler = (project: boolean) => compute(async (i, ctx) => {
  const kind = str(i, "kind"); if (!kind) throw new RangeError(`35.1 record.${project ? "project" : "replay"} needs kind`);
  const r = await replayKind(txOf(ctx), { kind, scope_key: has(i, "scope_key") ? str(i, "scope_key") : null, entity_id: project && has(i, "entity_id") ? str(i, "entity_id") : null, dry_run: !project && i["dry_run"] === true, now: ctx.now });
  // REPLAY_IS_IDEMPOTENT: the receipt is logged only when rows were written — a second run writes zero rows and zero events
  if (r.rows_written > 0) ctx.events.append({ type: "record.replayed", actor: ctx.actor, aggregate: { kind: "projection_run", id: r.run_id }, payload: { run_id: r.run_id, kind, scope_key: r.scope_key, versions: r.versions, rows: r.rows_written, gaps: r.gaps.length, dry_run: r.dry_run, projector: project ? "record.project" : "record.replay" } });
  return { run_id: r.run_id, kind, scope_key: r.scope_key, dry_run: r.dry_run, versions: r.versions, rows_written: r.rows_written, skipped: r.outcome?.skipped ?? 0, gaps: r.gaps, ...(r.reason ? { reason: r.reason } : {}) };
});
const replayDecision = (i: ToolInput, output: unknown, _ctx: CommandContext) => { const o = (output ?? {}) as Record<string, unknown>; return seamDecision({ subject: { kind: "kind", id: str(i, "kind") }, action: "replay", scope_key: (o["scope_key"] as string | null | undefined) ?? null, versions: Number(o["versions"] ?? 0), rows_written: Number(o["rows_written"] ?? 0), gaps: Array.isArray(o["gaps"]) ? (o["gaps"] as unknown[]).length : 0, rationale: o["dry_run"] === true ? `dry run: ${String(o["versions"])} version(s) would project` : `${String(o["rows_written"])} row(s) written from ${String(o["versions"])} un-projected version(s)` }); };

export const TOOLS_35_1: readonly ToolDef[] = defineTools(SEAM_PROCESS, SEAM_AGENT, [
  { name: "record.project", kind: "act", ruleSetVersion: SEAM_RULE_SET_VERSION, guardrails: [NO_MONEY_FIELD_CHANGE], handler: replayHandler(true), decision: replayDecision },
  { name: "record.replay", kind: "act", ruleSetVersion: SEAM_RULE_SET_VERSION, guardrails: [NO_MONEY_FIELD_CHANGE], handler: replayHandler(false), decision: replayDecision },
  { name: "record.gaps", kind: "read", guardrails: [NO_MONEY_FIELD_CHANGE], handler: compute(async (i, ctx) => gapsReport(txOf(ctx), asOfDateOf(i, ctx))) },
  { name: "record.verify", kind: "act", ruleSetVersion: SEAM_RULE_SET_VERSION, guardrails: [NO_MONEY_FIELD_CHANGE],
    handler: compute(async (i, ctx, rt) => { const r = await verifyRun({ q: txOf(ctx), events: ctx.events, escalations: rt.escalations, actor: ctx.actor, now: ctx.now }, { as_of_date: asOfDateOf(i, ctx), kinds: Array.isArray(i["kinds"]) ? (i["kinds"] as unknown[]).map(String) : null, ...(typeof i["sample"] === "number" ? { sample: i["sample"] } : {}) }); const { event: _e, ...rest } = r; void _e; return rest; }),
    decision: (i, output) => { const o = (output ?? {}) as Record<string, unknown>; return seamDecision({ subject: { kind: "run", id: String(o["run_id"] ?? "") }, action: "verify", versions: Number(o["rows_verified"] ?? 0), rows_written: 0, mismatches: Number(o["mismatches"] ?? 0), gaps: Number(o["gaps"] ?? 0), rationale: `verify ${String(o["as_of_date"] ?? str(i, "as_of_date"))}: ${String(o["kinds_checked"])} kind(s), ${String(o["rows_verified"])} row(s), ${String(o["mismatches"])} mismatch(es) escalated, ${String(o["gaps"])} gap(s) listed; nothing corrected` }); } },
  { name: "record.lease", kind: "read", guardrails: [LEASE_DIES_WITH_SESSION, NO_MONEY_FIELD_CHANGE], handler: compute(async (i, ctx) => { const op = str(i, "op") || "status"; if (op === "status") return leaseStatus(txOf(ctx), ctx.now); if (op === "list") return { runs: await leaseList(txOf(ctx), typeof i["limit"] === "number" ? i["limit"] : 50) }; throw new RangeError("record.lease op is status or list"); }) },
  { name: "outbox.dispatch", kind: "act", ruleSetVersion: SEAM_RULE_SET_VERSION, humanRoles: ["ops_analyst", "officer"], guardrails: [NO_MONEY_FIELD_CHANGE, ABANDON_IS_HUMAN],
    handler: compute(async (i, ctx, rt) => {
      if (i["op"] === "abandon") { const message_id = str(i, "message_id"); const reason = str(i, "reason"); if (!message_id || !reason) throw new RangeError("outbox.dispatch{op: abandon} needs message_id and reason"); const r = abandonDeadLetter({ events: ctx.events, timers: ctx.timers, actor: ctx.actor, now: ctx.now }, { message_id, reason }); return { message_id, abandoned: true, event_id: r.event.id, cancelled_timers: r.cancelled }; }
      const runtime = runtimeOf(rt);
      // the by-hand drain carries the same adapters and completion hooks as the sweep's (Runtime.drainAdapters / drainCompletions: the FAKE ports', 35.9 rule 8's `law-firm` over the lawFirm port with its `firm_dispatches` stamp, then the deps' overrides) — a `law-firm` row drained here reaches the firm, never `adapter_not_wired`
      const r = await drainOutbox({ db: runtime.db, registry: runtime.registry, clock: runtime.clock, ports: runtime.ports, adapters: runtime.drainAdapters(), completions: runtime.drainCompletions(), notify: (ev) => runtime.uow.notifyCommitted(ev) }, ctx.now, { adapter: str(i, "adapter") || null, ...(typeof i["limit"] === "number" ? { limit: i["limit"] } : {}) });
      const { events: _ev, ...rest } = r; void _ev; return { ...rest, events: r.events.length }; }),
    decision: (i, output) => { const o = (output ?? {}) as Record<string, unknown>; return i["op"] === "abandon" ? seamDecision({ subject: { kind: "message", id: str(i, "message_id") }, action: "dispatch", rationale: `dead letter abandoned by a named person: ${str(i, "reason")}` }) : seamDecision({ subject: { kind: "run", id: String(o["at"] ?? "") }, action: "dispatch", versions: Number(o["claimed"] ?? 0), rows_written: Number(o["sent"] ?? 0), rationale: `drain: ${String(o["claimed"])} claimed, ${String(o["sent"])} sent, ${String(o["retried"])} retried, ${String(o["dead"])} dead` }); } },
  // rule 9: `service_snapshots` is an accelerator only — the state folded through `through_sequence` (the log's last sequence on this command) with its sha256; hydration must reproduce a full replay from it or discards it
  { name: "record.snapshot", kind: "act", ruleSetVersion: SEAM_RULE_SET_VERSION, guardrails: [NO_MONEY_FIELD_CHANGE],
    handler: compute(async (i, ctx, rt) => {
      const key = str(i, "service_key"); const spec = serviceSpec(key); if (!spec) throw new RangeError(`record.snapshot: ${key || "(none)"} is not a stateful service key (${["cd-25-2", "le-21-2", "companion", "tolerance", "secondary", "delivery-29-3", "delivery-29-4", "orig-boarding", "boarding", "transfer", "fpi"].join(", ")})`);
      const q = txOf(ctx); const runtime = runtimeOf(rt);
      const want = spec.scope === "application" ? str(i, "application_id") : spec.scope === "loan" ? str(i, "loan_id") : "";
      const have = spec.scope === "application" ? ctx.applicationId ?? "" : spec.scope === "loan" ? ctx.loanId : "";
      if (spec.scope !== "global" && (!want || want !== have)) throw new RangeError(`record.snapshot{service_key: ${key}} runs on the ${spec.scope}'s own command: ${spec.scope}_id must name the command's ${spec.scope}`);
      const st = runtime.originationServices.stateOf(ctx, key); if (!st) throw new RangeError(`${key} is not live on this command`);
      const through = ctx.events.all().reduce((m, e) => Math.max(m, e.sequence), 0);
      const id = await writeSnapshot(q, spec, { ...(ctx.applicationId ? { applicationId: ctx.applicationId } : {}), ...(ctx.loanId ? { loanId: ctx.loanId } : {}) }, st.state, st.sha, through);
      ctx.events.append({ type: "service.snapshot.written", actor: ctx.actor, aggregate: { kind: "service", id: key }, payload: { service_key: key, through_sequence: through, state_sha256: st.sha, snapshot_id: id, reason: "record.snapshot", application_id: ctx.applicationId ?? null, loan_id: ctx.loanId || null } });
      return { snapshot_id: id, service_key: key, through_sequence: through, state_sha256: st.sha, application_id: ctx.applicationId ?? null, loan_id: ctx.loanId || null }; }),
    decision: (i, output) => { const o = (output ?? {}) as Record<string, unknown>; return seamDecision({ subject: { kind: "kind", id: str(i, "service_key") }, action: "snapshot", state_sha256: String(o["state_sha256"] ?? ""), rationale: `snapshot of ${str(i, "service_key")} through sequence ${String(o["through_sequence"])}` }); } },
  { name: "writeDecision", kind: "act", ruleSetVersion: SEAM_RULE_SET_VERSION, guardrails: [NO_MONEY_FIELD_CHANGE], handler: decision() },
]);
