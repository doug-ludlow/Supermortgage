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
 *   outbox.dispatch  act   {adapter?, limit?} — the sweep's own drain, runnable by hand.
 *   writeDecision    act   the decision row (records.v1; ids and column names only — NO_PII_IN_DECISION).
 *
 * Guardrails: NO_MONEY_FIELD_CHANGE (an input naming a `*_cents` override, `changes` or `data` is refused — a correction is
 * the owning section's officer command, rule 14), HOLD_BLOCKS_REPLAY (a scope under a legal hold is skipped as
 * key_conflict{hold: true} — the runner), NO_PII_IN_DECISION (the decision carries ids, counts and column names only).
 */
import { defineTools, compute, decision, never, str, type ToolDef, type ToolInput } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import type { Queryable } from "../../infra/db/client.ts";
import { replayKind, gapsReport } from "../../domain/operations-runtime/seam/replay.ts";

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
  { name: "writeDecision", kind: "act", ruleSetVersion: SEAM_RULE_SET_VERSION, guardrails: [NO_MONEY_FIELD_CHANGE], handler: decision() },
]);
