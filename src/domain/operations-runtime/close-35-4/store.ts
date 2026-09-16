/**
 * §35.4 — the process's own rows on the command's transaction: close_periods / close_period_steps (mutable, every change
 * journaled), the append-only journal close_period_events, and the decision rows this process writes itself
 * (PgDecisionRepository on ctx.q, so the preparer, reviewer and approval ids are known to the attestation row and every
 * state-changing call leaves exactly one row with rule_set_version close.v1 / prompt_version 35.4-v1 — T13).
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "../../../infra/db/client.ts";
import { PgDecisionRepository } from "../../../infra/db/decisions.ts";
import type { Actor } from "../../../kernel/events/index.ts";
import type { CommandContext } from "../../../app/commands.ts";
import { CLOSE_AGENT, CLOSE_MODEL_VERSION, CLOSE_PROMPT_VERSION, CLOSE_RULE_SET_VERSION, type ClosePeriodRow, type CloseStepRow, type StepCode } from "./types.ts";

const ISO = (col: string): string => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
export const PERIOD_COLS = `id::text AS id, kind, period, period_start::text AS period_start, period_end::text AS period_end, servicer_number, tax_year, status, ${ISO("opened_at")} AS opened_at, opened_by_event_id::text AS opened_by_event_id, ${ISO("attested_at")} AS attested_at, current_attestation_id::text AS current_attestation_id, ${ISO("closed_at")} AS closed_at, reopen_count, current_reopen_id::text AS current_reopen_id`;
export const STEP_COLS = `id::text AS id, close_period_id::text AS close_period_id, code, owner_process, depends_on, cycle_code, unit_scope, ${ISO("not_before")} AS not_before, owner_timer_code, ${ISO("owner_due_at")} AS owner_due_at, receipt_event_type, receipt_filter, expected_receipts, received, status, cycle_run_id::text AS cycle_run_id, ${ISO("started_at")} AS started_at, ${ISO("completed_at")} AS completed_at, skipped_reason, attempts, last_error, ${ISO("receipts_from")} AS receipts_from`;

export async function periodByKey(q: Queryable, kind: string, period: string, servicer: string, lock = false): Promise<ClosePeriodRow | undefined> {
  return (await q.query<ClosePeriodRow>(`SELECT ${PERIOD_COLS} FROM close_periods WHERE kind = $1 AND period = $2 AND servicer_number = $3${lock ? " FOR UPDATE" : ""}`, [kind, period, servicer]))[0];
}
export async function periodById(q: Queryable, id: string): Promise<ClosePeriodRow | undefined> { return (await q.query<ClosePeriodRow>(`SELECT ${PERIOD_COLS} FROM close_periods WHERE id = $1`, [id]))[0]; }
/** The period a tool input names: `period` (YYYY-MM or YYYY-TY) or `tax_year`, for the servicer. */
export async function periodOf(q: Queryable, i: { period?: string; tax_year?: number | null }, servicer: string, lock = false): Promise<ClosePeriodRow | undefined> {
  if (i.period) return periodByKey(q, /-TY$/.test(i.period) ? "tax_year" : "month", i.period, servicer, lock);
  if (i.tax_year !== undefined && i.tax_year !== null) return periodByKey(q, "tax_year", `${i.tax_year}-TY`, servicer, lock);
  return undefined;
}
export async function openPeriods(q: Queryable, servicer: string): Promise<ClosePeriodRow[]> {
  return q.query<ClosePeriodRow>(`SELECT ${PERIOD_COLS} FROM close_periods WHERE servicer_number = $1 AND status <> 'closed' ORDER BY kind, period FOR UPDATE`, [servicer]);
}
/** Rule 1's chain order (the table's row order), then the tax-year chain. */
export const STEP_ORDER: readonly string[] = ["eod_cutoff", "custodial_day_close", "metro2_snapshot", "lar", "period_close", "ledger_period_close", "balance_attestation", "form496", "form496a", "qc_cycle", "star", "eligibility", "tax_year_close", "form_1098_furnish", "form_1099_int_furnish", "form_1099_ac_furnish", "form_1098_file", "form_1099_int_file", "form_1099_ac_file"];
export async function stepsOf(q: Queryable, periodId: string): Promise<CloseStepRow[]> {
  return q.query<CloseStepRow>(`SELECT ${STEP_COLS} FROM close_period_steps WHERE close_period_id = $1 ORDER BY array_position($2::text[], code)`, [periodId, [...STEP_ORDER]]);
}
export async function stepOf(q: Queryable, periodId: string, code: string): Promise<CloseStepRow | undefined> {
  return (await q.query<CloseStepRow>(`SELECT ${STEP_COLS} FROM close_period_steps WHERE close_period_id = $1 AND code = $2`, [periodId, code]))[0];
}
/** A mutable update of a step (status, counters, timestamps) — always paired with a journal row by the caller. */
export async function patchStep(q: Queryable, id: string, patch: Record<string, unknown>, now: string): Promise<void> {
  const keys = Object.keys(patch); if (!keys.length) return;
  const sets = keys.map((k, n) => `${k} = $${n + 3}`).join(", ");
  await q.query(`UPDATE close_period_steps SET ${sets}, updated_at = $2 WHERE id = $1`, [id, now, ...keys.map((k) => patch[k])]);
}
export async function patchPeriod(q: Queryable, id: string, patch: Record<string, unknown>, now: string): Promise<void> {
  const keys = Object.keys(patch); if (!keys.length) return;
  const sets = keys.map((k, n) => `${k} = $${n + 3}`).join(", ");
  await q.query(`UPDATE close_periods SET ${sets}, updated_at = $2 WHERE id = $1`, [id, now, ...keys.map((k) => patch[k])]);
}
export interface JournalInput { readonly close_period_id: string; readonly step_id?: string | null; readonly type: string; readonly source_event_id?: string | null; readonly actor: Actor; readonly payload?: Record<string, unknown>; readonly occurred_at: string }
/** One append-only journal row; a receipt (source_event_id) is recorded once — the unique index makes a second insert a no-op (rule 11). Returns the id, or null when the receipt was already journaled. */
export async function journal(q: Queryable, j: JournalInput): Promise<string | null> {
  const id = randomUUID();
  const r = await q.query<{ id: string }>(`INSERT INTO close_period_events (id, close_period_id, step_id, type, source_event_id, actor, payload, occurred_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8) ON CONFLICT (source_event_id) WHERE source_event_id IS NOT NULL DO NOTHING RETURNING id::text AS id`,
    [id, j.close_period_id, j.step_id ?? null, j.type, j.source_event_id ?? null, JSON.stringify(j.actor), JSON.stringify(j.payload ?? {}, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), j.occurred_at]);
  return r[0]?.id ?? null;
}

/** The decision-record schema of the AI agent design paragraph, written on the command's transaction with a known id. */
export interface CloseDecision { readonly action: string; readonly subject: { kind: string; id: string }; readonly record: Record<string, unknown>; readonly rationale: string; readonly confidence?: number; readonly evidenceDocumentIds?: readonly string[]; readonly approvedBy?: Actor; readonly loanId?: string }
export async function writeCloseDecision(ctx: CommandContext, d: CloseDecision, agent: string = CLOSE_AGENT): Promise<string> {
  if (!ctx.q) throw new RangeError("35.4 tools run inside a database command (PgUnitOfWork): no transaction on this context");
  const id = randomUUID();
  const record = { ...d.record, rule_set_version: CLOSE_RULE_SET_VERSION, model_version: ctx.run?.modelVersion ?? CLOSE_MODEL_VERSION, prompt_version: CLOSE_PROMPT_VERSION, actor: ctx.actor, run_id: ctx.run?.runId ?? null, rationale: d.rationale };
  await new PgDecisionRepository(ctx.q).record({ agent, action: d.action, rationale: JSON.stringify(record, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), ruleSetVersion: CLOSE_RULE_SET_VERSION, subject: d.subject, ruleCode: "35.4",
    modelVersion: ctx.run?.modelVersion ?? CLOSE_MODEL_VERSION, promptVersion: CLOSE_PROMPT_VERSION, confidence: d.confidence ?? 1, ...(d.evidenceDocumentIds ? { evidenceDocumentIds: d.evidenceDocumentIds } : {}), ...(d.loanId ? { loanId: d.loanId } : {}),
    ...(d.approvedBy ? { approvedBy: d.approvedBy.id, ...(d.approvedBy.role ? { approvedRole: d.approvedBy.role } : {}) } : ctx.actor.kind === "human" ? { approvedBy: ctx.actor.id, ...(ctx.actor.role ? { approvedRole: ctx.actor.role } : {}) } : {}) }, ctx.q, id);
  return id;
}
export interface DecisionRow extends Record<string, unknown> { readonly id: string; readonly agent: string; readonly action: string; readonly rationale: string; readonly approved_by: string | null; readonly approved_role: string | null; readonly subject_kind: string | null; readonly subject_id: string | null; readonly created_at: string }
export async function decisionById(q: Queryable, id: string): Promise<DecisionRow | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  return (await q.query<DecisionRow>(`SELECT id::text AS id, agent, action, rationale, approved_by, approved_role, subject_kind, subject_id, ${ISO("created_at")} AS created_at FROM agent_decisions WHERE id = $1`, [id]))[0];
}
export const recordOf = (d: DecisionRow): Record<string, unknown> => { try { const v = JSON.parse(d.rationale) as unknown; return v && typeof v === "object" ? (v as Record<string, unknown>) : {}; } catch { return {}; } };
export const isStep = (s: string): s is StepCode => ["eod_cutoff", "custodial_day_close", "metro2_snapshot", "lar", "period_close", "ledger_period_close", "balance_attestation", "form496", "form496a", "qc_cycle", "star", "eligibility", "tax_year_close", "form_1098_furnish", "form_1099_int_furnish", "form_1099_ac_furnish", "form_1098_file", "form_1099_int_file", "form_1099_ac_file"].includes(s);
