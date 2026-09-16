/**
 * §35.9 Trigger & frequency / rule 2 — the daily pass `Runtime.sweep` runs once per calendar day at/after 05:30 America/New_York
 * (`logged("default_case.daily")`, before the breach-action reconciliation and the breach pass, so a day whose run completed
 * never breaches SM_DEFAULT_CASE_DAILY): the cycles this process owns in 35.3's registry (cycles.ts CYCLE_ROWS, the runners in
 * cycles-35-9.ts), planned and drained through 35.3's engine in dependency order — under the planner lock (35.3 rule 1: one
 * planner at a time, `pg_try_advisory_lock(35_003)` on a dedicated client; refused → the pass yields as the sweep's cycles pass
 * does and the next sweep of the day completes it), one `planCycle` transaction per (cycle, period) (rule 3: idempotent by the
 * run's and the jobs' unique keys, `cycle.run.opened` arming the stall clock), a zero-unit run's receipt elected at once (edge
 * case 6), then the executor drained for that cycle until its queue is empty (the last unit elects the receipt, rule 5) —
 * never a second `cycles.plan` command: the sweep's cycles pass is the day's planner event (35.3-T8 counts one
 * `cycles.plan.run_completed` per day), the owner's pass is its own units' planner —
 *
 *   delinquency_counters   loan   the sweep's own cycles pass plans it (plan_mode `sweep`, after `cashiering_daily`); this pass makes sure
 *                                 the day's run exists and is drained before the case cycles read the windows it opened
 *   bk_docket_sync_daily   loan   every loan with an open bankruptcy case → `docket.sync` (PACER's FAKE); receipt `bk_docket_sync.run_completed`
 *   dra_import_daily       global 13.6 `dra.snapshot.import` per (firm, loan) from the `law-firm` port's reported milestones; receipt `dra_import.run_completed`
 *   default_case_daily     loan   every loan with an open `regx_ei_windows` row, an open `cases` row of type lossmit / foreclosure /
 *                                 bankruptcy / reo / claim, or an open `claim_candidates` row → `case.progress{loan_id, as_of_date}`
 *                                 (rule 2's steps in order); its receipt literal `default_case.daily.run_completed` is this pass's own
 *                                 (`receipt_emitted_by: owner` — the one SM_DEFAULT_CASE_DAILY waits on), with the run row
 *   claims_sweep_daily     loan   loans with a liquidation milestone in the last 120 calendar days or an open candidate → `claims.sweep`
 *                                 then `claims.package` for each `opened` candidate; receipt `claims_sweep.run_completed`
 *
 * The four case cycles are `plan_mode: "owner"` in the registry: the sweep's cycles pass and the demo step do not plan them, this
 * pass does, each one after the previous one's receipt — rule 2's universe (`default_case_daily`'s selector) is read after the
 * counters opened the day's windows (35.9-T17: a loan is selected on the day its window opened), and the units run at/after
 * 05:30 ET as the row states. 35.3 rule 3 keeps one run per (cycle, day): a second pass of the day plans nothing new.
 *
 * Then one `default_case_daily_runs` row (unique `as_of_date` — a second sweep the same day writes no second run), the daily
 * default report stored through 35.2's documents port (`corporate_7y`; 35.11's input), and the receipt event in one global unit
 * of work. A unit that throws is 35.3's `failed` / `dead` job (rule 7's retry policy, the executor's escalation) and the later
 * units still run; the day's outcome is `completed` when every unit of the five runs is done, `partial` otherwise. Nothing here
 * moves money or edits a clock. A runtime without `databaseUrl` (no planner lock — a unit harness) reports the pass skipped.
 */
import type { Runtime } from "../../../runtime/app.ts";
import type { Queryable } from "../../../infra/db/client.ts";
import { wallClock, zonedEpochMs, toIso } from "../../../kernel/calendar/zoned.ts";
import { addDays, plainDate as D, type PlainDate } from "../../../kernel/calendar/date.ts";
import { cyclesOf, runExecutor } from "../service.ts";
import type { PeriodDue } from "../cycles.ts";
import { PLANNER_LOCK_KEY, PgSessionLock } from "../planner-lock.ts";
import { CYCLES_35_9, ET, EV, OPEN_CASE_TYPES, PROCESS_35_9, SWEEP_ACTOR } from "../default-35-9.ts";
import { portsOf, type DefaultOpsPorts } from "./ports.ts";
import type { Row } from "./store.ts";

export interface UnitOutcome { readonly status: "done" | "failed" | "dead" | "skipped" | "queued" | "blocked" | "running" | "abandoned"; readonly decision_id?: string | null; readonly error?: string | null }
export interface UnitReport { readonly unit_id: string; readonly loan_id: string | null; readonly outcome: UnitOutcome }
export interface CycleReport {
  readonly cycle_code: string; readonly run_id: string; readonly period_key: string; readonly status: string; readonly units_total: number;
  readonly units: UnitReport[]; readonly receipt_id: string | null; readonly receipt_event_id: string | null; readonly failed: number; readonly done: number; readonly skipped: number;
  /** true when this pass opened the run (a run 35.3's sweep pass or an earlier pass of the day opened is read, not re-planned) */
  readonly planned: boolean;
}
export interface DailyRunReport {
  readonly as_of_date: PlainDate; readonly already: boolean; readonly run_id: string | null; readonly outcome: "completed" | "partial" | "failed" | null;
  /** Why the pass wrote nothing (no `databaseUrl` for the planner lock; the planner lock held elsewhere) — a later sweep of the day completes it. */
  readonly skipped?: string | null;
  readonly cycles: CycleReport[]; readonly loans_scanned: number; readonly report_document_id: string | null; readonly receipt_event_id: string | null; readonly counts: Row;
}
export interface DailyRunOptions { readonly runId?: string | null; readonly ports?: DefaultOpsPorts; readonly plannedBy?: string }

/** The day's cycles in dependency order: the counters (planned by the sweep's cycles pass — made sure of here), then the four case cycles this pass plans. */
export const DAILY_CYCLE_ORDER: readonly string[] = [CYCLES_35_9.counters, CYCLES_35_9.docketSync, CYCLES_35_9.draImport, CYCLES_35_9.dailyCase, CYCLES_35_9.claimsSweep];

/** Already run today? (`default_case_daily_runs.as_of_date` is unique.) */
export async function dailyRunOf(q: Queryable, asOf: PlainDate): Promise<{ id: string; outcome: string; receipt_event_id: string | null } | null> {
  return (await q.query<{ id: string; outcome: string; receipt_event_id: string | null }>(`SELECT id::text AS id, outcome, receipt_event_id::text AS receipt_event_id FROM default_case_daily_runs WHERE as_of_date = $1::date`, [asOf]))[0] ?? null;
}

type RunRow = { id: string; cycle_code: string; period_key: string; status: string; units_total: number; units_done: number; units_dead: number; units_skipped: number; receipt_id: string | null; receipt_event_id: string | null };
const RUN_SQL = `SELECT r.id::text AS id, r.cycle_code, r.period_key, r.status, r.units_total, r.units_done, r.units_dead, r.units_skipped, c.id::text AS receipt_id, c.receipt_event_id::text AS receipt_event_id FROM cycle_runs r LEFT JOIN cycle_receipts c ON c.run_id = r.id WHERE r.cycle_code = $1 AND r.period_key = $2`;
/** The run as 35.3's tables hold it, with its units from `jobs` (the report's shape; a run that was never planned is null). */
async function readRun(q: Queryable, code: string, periodKey: string, planned: boolean): Promise<CycleReport | null> {
  const run = (await q.query<RunRow>(RUN_SQL, [code, periodKey]))[0];
  if (!run) return null;
  const jobs = await q.query<{ unit_id: string; loan_id: string | null; status: UnitOutcome["status"]; decision_id: string | null; last_error: string | null }>(`SELECT unit_id, loan_id::text AS loan_id, status, decision_id::text AS decision_id, last_error FROM jobs WHERE run_id = $1::uuid ORDER BY created_at, id`, [run.id]);
  const units: UnitReport[] = jobs.map((j) => ({ unit_id: j.unit_id, loan_id: j.loan_id, outcome: { status: j.status, decision_id: j.decision_id, error: j.last_error } }));
  return { cycle_code: code, run_id: run.id, period_key: run.period_key, status: run.status, units_total: run.units_total, units, receipt_id: run.receipt_id, receipt_event_id: run.receipt_event_id, planned,
    failed: units.filter((u) => u.outcome.status === "failed" || u.outcome.status === "dead").length, done: units.filter((u) => u.outcome.status === "done").length, skipped: units.filter((u) => u.outcome.status === "skipped" || u.outcome.status === "abandoned").length };
}

const count = async (q: Queryable, sql: string, params: unknown[]): Promise<number> => Number((await q.query<{ c: string }>(`SELECT count(*)::text AS c ${sql}`, params))[0]?.c ?? 0);

/** The day's pass. `already: true` when the day's run exists (a second sweep the same day); `skipped` when nothing could be planned. */
export async function runDefaultCaseDay(rt: Runtime, nowIso: string, o: DailyRunOptions = {}): Promise<DailyRunReport> {
  const asOf: PlainDate = D(wallClock(Date.parse(nowIso), ET).date);
  const ports = portsOf(o.ports);
  const existing = await dailyRunOf(rt.db, asOf);
  if (existing) return { as_of_date: asOf, already: true, run_id: existing.id, outcome: existing.outcome as DailyRunReport["outcome"], cycles: [], loans_scanned: 0, report_document_id: null, receipt_event_id: existing.receipt_event_id, counts: {} };
  if (!rt.databaseUrl) return { as_of_date: asOf, already: false, skipped: "no databaseUrl for the planner lock (35.3 rule 1) — the day's cycles are not planned on this runtime", run_id: null, outcome: null, cycles: [], loans_scanned: 0, report_document_id: null, receipt_event_id: null, counts: {} };
  const now = nowIso; const plannedBy = o.plannedBy ?? (o.runId ? `sweep:${o.runId}` : `sweep:${rt.instanceId}`);
  const cycles: CycleReport[] = [];
  try { return await runDay(rt, ports, { asOf, now, plannedBy, cycles }); }
  catch (e) {
    // the day is recorded as failed (unique as_of_date: the day does not re-run; no receipt, so SM_DEFAULT_CASE_DAILY breaches to `officer` and the row names the failure); the cycles that elected their receipts stay elected
    const msg = e instanceof Error ? e.message : String(e);
    rt.logger?.error("35.9 daily pass failed", { at: now, as_of_date: asOf, error: msg, cycles: cycles.map((c) => `${c.cycle_code}:${c.receipt_id ? "receipted" : "open"}`) });
    const ins = await rt.db.query<{ id: string }>(`INSERT INTO default_case_daily_runs (as_of_date, cycle_run_ids, loans_scanned, outcome, created_at) VALUES ($1::date, $2::uuid[], $3, 'failed', $4::timestamptz) ON CONFLICT (as_of_date) DO NOTHING RETURNING id::text AS id`, [asOf, cycles.map((c) => c.run_id), cycles.find((c) => c.cycle_code === CYCLES_35_9.dailyCase)?.units_total ?? 0, now]).catch(() => [] as { id: string }[]);
    return { as_of_date: asOf, already: false, run_id: ins[0]?.id ?? null, outcome: "failed", cycles, loans_scanned: 0, report_document_id: null, receipt_event_id: null, counts: { error: msg } };
  }
}

/** The demo clock's persisted offset when the runtime runs on one (service.ts planIn reads the same field): `cycle_runs.demo_offset_ms`. */
const demoOffsetOf = (rt: Runtime): number => { const row = (rt.clock as { latestRow?: { offset_ms?: bigint | number } | null }).latestRow; return row && row.offset_ms !== undefined ? Number(row.offset_ms) : 0; };

async function runDay(rt: Runtime, ports: Required<DefaultOpsPorts>, d: { asOf: PlainDate; now: string; plannedBy: string; cycles: CycleReport[] }): Promise<DailyRunReport> {
  const { asOf, now, plannedBy, cycles } = d;
  const dayStart = toIso(zonedEpochMs(asOf, "00:00", ET));
  await rt.caseFolder.settle();
  const svc = cyclesOf(rt);
  // 35.3 rule 1: the planner lock on a dedicated client for the whole pass (the four case cycles are planned one after another, each after the previous one's receipt); refused → the pass yields, a later sweep of the day completes it
  const lock = await new PgSessionLock(rt.databaseUrl!).acquire(PLANNER_LOCK_KEY, `${plannedBy}:35.9`);
  if (!lock.held) { rt.logger?.warn("35.9 daily pass skipped: planner lock held", { at: now, as_of_date: asOf, holder: lock.holder }); return { as_of_date: asOf, already: false, skipped: `planner lock held by ${lock.holder ?? "another pass"}`, run_id: null, outcome: null, cycles, loans_scanned: 0, report_document_id: null, receipt_event_id: null, counts: {} }; }
  try {
    const period: PeriodDue = { period_key: asOf, period_end: asOf }; const demoOffsetMs = demoOffsetOf(rt);
    for (const code of DAILY_CYCLE_ORDER) {
      const def = svc.def(code); if (!def) throw new Error(`def_missing: no registered cycle ${code}`);
      // rule 3: one transaction per (cycle, period) — a run the sweep's cycles pass opened (the counters) is found, not re-planned; the selector runs now, after the previous cycle's units
      const planned = await svc.planCycle(def, period, { asOf: now, asOfDate: asOf, plannedBy, demoOffsetMs });
      // rule 6: the executor claims this cycle's units until its queue is empty (the last unit elects the receipt); a zero-unit run's receipt is elected here (edge case 6), so the next cycle's dependency is met
      await runExecutor(rt, { drain: "all", cycleCodes: [code], holder: `${plannedBy}:35.9` });
      const run = await readRun(rt.db, code, asOf, planned.opened);
      if (!run) { rt.logger?.warn("35.9 daily pass: no run for the day's cycle", { at: now, as_of_date: asOf, cycle_code: code }); continue; }
      if (!run.receipt_id) await svc.electReceipt(run.run_id, `planner:${run.run_id}`);
      cycles.push((await readRun(rt.db, code, asOf, planned.opened)) ?? run);
    }
  } finally { await lock.release(); }
  const daily = cycles.find((c) => c.cycle_code === CYCLES_35_9.dailyCase);
  const universe = daily?.units_total ?? 0;
  // the run's counters from the day's rows (the units' own reports are 35.3's job rows; the breach side is the sweep's, read from the tables)
  const dailyOpened = daily ? (await rt.db.query<{ at: string }>(`SELECT opened_at::text AS at FROM cycle_runs WHERE id = $1::uuid`, [daily.run_id]))[0]?.at ?? dayStart : dayStart;
  // rule 7's count on the run row is the previous day's reconciliation (the day's own `breach.recon` runs after this pass, before the breach pass; its receipt is the day's record)
  const reconRow = (await rt.db.query<{ payload: Row }>(`SELECT payload FROM loan_events WHERE type = $1 AND payload->>'as_of_date' = $2 ORDER BY sequence DESC LIMIT 1`, [EV.breachReconCompleted, addDays(asOf, -1)]))[0];
  const counts: Row = {
    loans_scanned: universe,
    events_folded: await count(rt.db, `FROM loan_events WHERE type = $1 AND occurred_at >= $2::timestamptz`, [EV.timelineAppended, dailyOpened]),
    milestones_expected: await count(rt.db, `FROM case_milestone_expectations WHERE created_at >= $1::timestamptz`, [dayStart]),
    milestones_due: await count(rt.db, `FROM loan_events WHERE type = $1 AND payload->>'as_of_date' = $2`, [EV.milestoneDue, asOf]),
    milestones_satisfied: await count(rt.db, `FROM case_milestone_expectations WHERE status = 'satisfied' AND updated_at >= $1::timestamptz`, [dayStart]),
    docket_events_reacted: await count(rt.db, `FROM docket_reactions WHERE NOT needs_human AND created_at >= $1::timestamptz`, [dayStart]),
    docket_events_deferred: await count(rt.db, `FROM docket_reactions WHERE needs_human AND created_at >= $1::timestamptz`, [dayStart]),
    breach_actions_executed: await count(rt.db, `FROM breach_actions WHERE outcome = 'executed' AND created_at >= $1::timestamptz`, [dayStart]),
    breach_actions_deferred: await count(rt.db, `FROM breach_actions WHERE outcome = 'deferred' AND created_at >= $1::timestamptz`, [dayStart]),
    breach_actions_missing: Number(reconRow?.payload["missing"] ?? 0), breach_actions_missing_as_of: reconRow ? addDays(asOf, -1) : null,
    claims_opened: await count(rt.db, `FROM claim_candidates WHERE opened_at >= $1::timestamptz`, [dayStart]),
    claims_packaged: await count(rt.db, `FROM loan_events WHERE type = $1 AND occurred_at >= $2::timestamptz`, [EV.claimPackageBuilt, dayStart]),
    firm_dispatches: await count(rt.db, `FROM firm_dispatches WHERE created_at >= $1::timestamptz`, [dayStart]),
    firm_acks: await count(rt.db, `FROM firm_dispatches WHERE acknowledged_at >= $1::timestamptz`, [dayStart]),
    exposure_recomputed: await count(rt.db, `FROM loan_events WHERE type = 'comp_fee.exposure.updated' AND payload->>'basis' = 'daily_projection' AND payload->>'as_of' = $1`, [asOf]),
  };
  const failedUnits = cycles.reduce((a, c) => a + c.failed + c.units.filter((u) => !["done", "skipped", "abandoned", "failed", "dead"].includes(u.outcome.status)).length, 0);
  const outcome: "completed" | "partial" = failedUnits === 0 && cycles.every((c) => c.status === "completed") ? "completed" : "partial";
  // the daily default report (35.2 documents port, corporate_7y): cases by status, milestones due and overdue, docket entries deferred, breach actions by outcome, claims by status and legal due date, firm dispatches unacknowledged
  const report = {
    as_of_date: asOf, planned_by: plannedBy, outcome, cycles: cycles.map((c) => ({ cycle_code: c.cycle_code, run_id: c.run_id, status: c.status, units_total: c.units_total, units_done: c.done, units_dead: c.failed, units_skipped: c.skipped, receipt_id: c.receipt_id, failed_units: c.units.filter((u) => u.outcome.status === "failed" || u.outcome.status === "dead").map((u) => ({ unit_id: u.unit_id, error: u.outcome.error ?? null })) })),
    cases_by_status: await rt.db.query<Row>(`SELECT case_type, status, count(*)::int AS n FROM cases WHERE closed_at IS NULL AND case_type = ANY($1::text[]) GROUP BY 1, 2 ORDER BY 1, 2`, [OPEN_CASE_TYPES]),
    milestones: await rt.db.query<Row>(`SELECT status, count(*)::int AS n FROM case_milestone_expectations WHERE status IN ('expected', 'due') GROUP BY 1 ORDER BY 1`),
    milestones_overdue: await rt.db.query<Row>(`SELECT loan_id::text AS loan_id, case_id::text AS case_id, milestone_code, due_on::text AS due_on FROM case_milestone_expectations WHERE status = 'due' ORDER BY due_on, id`),
    docket_entries_deferred: await rt.db.query<Row>(`SELECT loan_id::text AS loan_id, docket_event_id, classification, classifier_confidence FROM docket_reactions WHERE needs_human ORDER BY created_at, id`),
    breach_actions_by_outcome: await rt.db.query<Row>(`SELECT outcome, count(*)::int AS n FROM breach_actions WHERE created_at >= $1::timestamptz GROUP BY 1 ORDER BY 1`, [dayStart]),
    claims: await rt.db.query<Row>(`SELECT status, legal_due_on::text AS legal_due_on, count(*)::int AS n FROM claim_candidates WHERE status <> 'closed' GROUP BY 1, 2 ORDER BY 2, 1`),
    firm_dispatches_unacknowledged: await rt.db.query<Row>(`SELECT id::text AS id, loan_id::text AS loan_id, firm_id, kind, sent_at FROM firm_dispatches WHERE kind = 'referral_package' AND acknowledged_at IS NULL ORDER BY created_at, id`),
    counts,
  };
  let receiptId: string | null = null; let documentId: string | null = null; let runId: string | null = null;
  await rt.uow.run({}, async (ctx) => {
    // the receipt this process emits for its `default_case_daily` cycle (cycles.ts `receipt_emitted_by: owner`; 35.3 rule 2) — SM_DEFAULT_CASE_DAILY's trigger and satisfying event, on the global subject
    const ev = ctx.events.append({ type: EV.dailyRunCompleted, aggregate: { kind: "default_case_daily_run", id: asOf }, actor: SWEEP_ACTOR,
      payload: { as_of_date: asOf, planned_by: plannedBy, outcome, cycle_run_ids: cycles.map((c) => c.run_id), run_id: daily?.run_id ?? null, cycle_code: CYCLES_35_9.dailyCase, period_key: asOf, units_total: daily?.units_total ?? 0, units_done: daily?.done ?? 0, units_dead: daily?.failed ?? 0, units_skipped: daily?.skipped ?? 0, ...counts, units_failed: failedUnits, origination: true } });
    receiptId = ev.id;
  }, { clock: rt.clock, commit: async (q) => {
    const stored = await ports.documents.store(q, { loan_id: null, kind: "default_case_daily_report", body: JSON.stringify(report, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), mime_type: "application/json", retention_class: "corporate_7y", metadata: { as_of_date: asOf, process: PROCESS_35_9, outcome }, now });
    documentId = stored.document_id;
    const ins = await q.query<{ id: string }>(
      `INSERT INTO default_case_daily_runs (as_of_date, cycle_run_ids, loans_scanned, events_folded, milestones_expected, milestones_due, milestones_satisfied, docket_events_reacted, docket_events_deferred, breach_actions_executed, breach_actions_deferred, breach_actions_missing, claims_opened, claims_packaged, firm_dispatches, firm_acks, exposure_recomputed, outcome, report_document_id, receipt_event_id, created_at)
       VALUES ($1::date, $2::uuid[], $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::uuid, $20::uuid, $21::timestamptz) ON CONFLICT (as_of_date) DO NOTHING RETURNING id::text AS id`,
      [asOf, cycles.map((c) => c.run_id), counts["loans_scanned"], counts["events_folded"], counts["milestones_expected"], counts["milestones_due"], counts["milestones_satisfied"], counts["docket_events_reacted"], counts["docket_events_deferred"], counts["breach_actions_executed"], counts["breach_actions_deferred"], counts["breach_actions_missing"], counts["claims_opened"], counts["claims_packaged"], counts["firm_dispatches"], counts["firm_acks"], counts["exposure_recomputed"], outcome, documentId, receiptId, now]);
    runId = ins[0]?.id ?? null;
  } });
  return { as_of_date: asOf, already: false, run_id: runId, outcome, cycles, loans_scanned: universe, report_document_id: documentId, receipt_event_id: receiptId, counts };
}
