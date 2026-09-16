/**
 * §35.4 `close.board` — the Close view (35.8/35.11) and the evidence pack's period subject (34.4): per period every step
 * with status, dependencies, the unmet ones (`missing`), the receipts' event ids, the owner's clock and its due date read
 * from `timers` (mirrored, never moved — NO_CLOCK_EDIT), the attestation summary and the reopen history. A read: no row changes.
 */
import type { Queryable } from "../../../infra/db/client.ts";
import { addDays } from "../../../kernel/calendar/date.ts";
import { periodOf, stepsOf, type DecisionRow } from "./store.ts";
import { periodAggregate, stepAggregate, type ClosePeriodRow, type CloseStepRow } from "./types.ts";
import { at } from "./calendar.ts";

const DONE = new Set(["completed", "skipped", "pre_reopen"]);
export interface BoardStep { readonly id: string; readonly code: string; readonly owner_process: string; readonly status: string; readonly depends_on: readonly string[]; readonly missing: readonly string[]; readonly cycle_code: string | null; readonly cycle_run_id: string | null; readonly unit_scope: string; readonly not_before: string | null; readonly receipt_event_type: string | null; readonly receipt_filter: Record<string, unknown>; readonly expected_receipts: number; readonly received: number; readonly receipt_event_ids: readonly string[]; readonly owner_timer_code: string | null; readonly owner_due_at: string | null; readonly stall_timer: { id: string; status: string; due_at: string | null } | null; readonly started_at: string | null; readonly completed_at: string | null; readonly skipped_reason: string | null; readonly attempts: number; readonly last_error: string | null }
export interface Board { readonly period: ClosePeriodRow; readonly steps: readonly BoardStep[]; readonly attestations: readonly Record<string, unknown>[]; readonly reopens: readonly Record<string, unknown>[]; readonly clocks: readonly { code: string; status: string; due_at: string | null; subject_id: string }[] }

/** The owner's clock for the step: the newest instance of the code whose arming event names this period (`period_end`, `period` or `as_of_date` — 6.3's `ledger.period.closed{period_end}`, 5.1's `investor_reporting_periods.closed{period}`, 18.1's `schedule.tick{period_end}`), else the newest armed at or after the period end within 90 days. */
export async function ownerDueAt(q: Queryable, code: string, p: ClosePeriodRow): Promise<string | null> {
  const named = await q.query<{ due_at: string | null }>(`SELECT to_char(t.due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS due_at FROM timers t JOIN loan_events e ON e.id = t.armed_by_event_id WHERE t.code = $1 AND (e.payload->>'period_end' = $2 OR e.payload->>'period' = $3 OR e.payload->>'as_of_date' = $2 OR e.payload->>'period_key' = $3) ORDER BY t.armed_at DESC LIMIT 1`, [code, p.period_end, p.period]);
  if (named[0]) return named[0].due_at;
  const r = await q.query<{ due_at: string | null }>(`SELECT to_char(due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS due_at FROM timers WHERE code = $1 AND armed_at >= $2::timestamptz AND anchor_date <= $3::date ORDER BY armed_at DESC LIMIT 1`, [code, at(p.period_end, "00:00"), addDays(p.period_end, 90)]);
  return r[0]?.due_at ?? null;
}

export async function boardOf(q: Queryable, i: { period?: string; tax_year?: number | null }, servicer: string): Promise<Board | { periods: ClosePeriodRow[] }> {
  if (!i.period && (i.tax_year === undefined || i.tax_year === null)) {
    const periods = await q.query<ClosePeriodRow>(`SELECT id::text AS id, kind, period, period_start::text AS period_start, period_end::text AS period_end, servicer_number, tax_year, status, opened_at::text AS opened_at, opened_by_event_id::text AS opened_by_event_id, attested_at::text AS attested_at, current_attestation_id::text AS current_attestation_id, closed_at::text AS closed_at, reopen_count, current_reopen_id::text AS current_reopen_id FROM close_periods WHERE servicer_number = $1 ORDER BY period DESC`, [servicer]);
    return { periods };
  }
  const p = await periodOf(q, i, servicer);
  if (!p) throw new RangeError(`35.4 close.board: no close period ${i.period ?? i.tax_year} for servicer ${servicer}`);
  const steps = await stepsOf(q, p.id);
  const byCode = new Map(steps.map((s) => [s.code, s]));
  const out: BoardStep[] = [];
  for (const s of steps) out.push(await boardStep(q, p, s, byCode));
  const attestations = await q.query<Record<string, unknown>>(`SELECT id::text AS id, kind, outcome, as_of::text AS as_of, custodial_account_id::text AS custodial_account_id, remittance_type, adjusted_depository_cents::text AS adjusted_depository_cents, composition_l12_cents::text AS composition_l12_cents, cashbook_cents::text AS cashbook_cents, variance_cents::text AS variance_cents, reportable_loans, furnished_count, filed_count, box1_sum_cents::text AS box1_sum_cents, ledger_interest_sum_cents::text AS ledger_interest_sum_cents, confidence::text AS confidence, human_approval_flag, preparer_decision_id::text AS preparer_decision_id, reviewer_decision_id::text AS reviewer_decision_id, officer_approval_id::text AS officer_approval_id, supersedes_attestation_id::text AS supersedes_attestation_id, created_at::text AS created_at FROM close_attestations WHERE close_period_id = $1 ORDER BY created_at`, [p.id]);
  const reopens = await q.query<Record<string, unknown>>(`SELECT id::text AS id, reason, trigger_event_id::text AS trigger_event_id, requested_by, approved_by_decision_id::text AS approved_by_decision_id, prior_status, steps_reset, steps_kept, compliance_escalation_id::text AS compliance_escalation_id, reopened_at::text AS reopened_at FROM close_reopens WHERE close_period_id = $1 ORDER BY reopened_at`, [p.id]);
  const clocks = await q.query<{ code: string; status: string; due_at: string | null; subject_id: string }>(`SELECT code, status::text AS status, to_char(due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS due_at, subject_id FROM timers WHERE subject_kind = 'close_period' AND (subject_id = $1 OR subject_id LIKE $2) ORDER BY armed_at`, [periodAggregate(servicer, p.period).id, `${periodAggregate(servicer, p.period).id}:%`]);
  return { period: p, steps: out, attestations, reopens, clocks };
}

async function boardStep(q: Queryable, p: ClosePeriodRow, s: CloseStepRow, byCode: Map<string, CloseStepRow>): Promise<BoardStep> {
  const missing = s.depends_on.filter((c) => { const x = byCode.get(c); return x ? !DONE.has(x.status) : true; });
  const receipts = await q.query<{ id: string }>(`SELECT source_event_id::text AS id FROM close_period_events WHERE step_id = $1 AND type = 'close.receipt.recorded' AND source_event_id IS NOT NULL ORDER BY occurred_at, seq`, [s.id]);
  const stall = (await q.query<{ id: string; status: string; due_at: string | null }>(`SELECT id::text AS id, status::text AS status, to_char(due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS due_at FROM timers WHERE code = 'SM_CLOSE_STEP_STALLED_2BD' AND subject_kind = 'close_period' AND subject_id = $1 ORDER BY armed_at DESC LIMIT 1`, [stepAggregate(p.servicer_number, p.period, s.code).id]))[0] ?? null;
  const owner_due_at = s.owner_timer_code ? (s.owner_timer_code === "SM_CLOSE_ATTEST_BD5" || s.owner_timer_code === "SM_TAX_YEAR_CLOSE_3BD" ? await ownClock(q, s.owner_timer_code, p) : await ownerDueAt(q, s.owner_timer_code, p)) : null;
  const status = s.status === "running" && stall?.status === "breached" ? "stalled" : s.status;
  return { id: s.id, code: s.code, owner_process: s.owner_process, status, depends_on: s.depends_on, missing, cycle_code: s.cycle_code, cycle_run_id: s.cycle_run_id, unit_scope: s.unit_scope, not_before: s.not_before, receipt_event_type: s.receipt_event_type, receipt_filter: s.receipt_filter, expected_receipts: s.expected_receipts, received: s.received, receipt_event_ids: receipts.map((r) => r.id), owner_timer_code: s.owner_timer_code, owner_due_at, stall_timer: stall, started_at: s.started_at, completed_at: s.completed_at, skipped_reason: s.skipped_reason, attempts: s.attempts, last_error: s.last_error };
}
async function ownClock(q: Queryable, code: string, p: ClosePeriodRow): Promise<string | null> {
  const r = await q.query<{ due_at: string | null }>(`SELECT to_char(due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS due_at FROM timers WHERE code = $1 AND ((subject_kind = 'close_period' AND subject_id = $2) OR (subject_kind = 'global' AND anchor_date = $3::date)) ORDER BY armed_at DESC LIMIT 1`, [code, periodAggregate(p.servicer_number, p.period).id, p.period_end]);
  return r[0]?.due_at ?? null;
}
export type { DecisionRow };
