/**
 * §35.9 Trigger & frequency / rule 2 — the daily pass `Runtime.sweep` runs once per calendar day at/after 05:30 America/New_York
 * (`logged("default_case.daily")`, before the breach-action reconciliation and the breach pass, so a day whose run completed
 * never breaches SM_DEFAULT_CASE_DAILY): the cycles this process owns in 35.3's registry, each as one run per (cycle, day)
 * through the CyclesPort (35.3's `cycle_runs` / `cycle_receipts` when its tables exist), each unit one bus command as the
 * owning agent, each cycle electing its own receipt (35.3 rule 5), in dependency order —
 *
 *   delinquency_counters   loan   every active loan with a `loan_installments` row still `due` → `delinquencyDailySweep` per loan with
 *                                 the loan's zone from 35.5 (`loan_servicing_configs.time_zone`) and the once-per-day guard (35.3 rule 3);
 *                                 receipt `delinquency.counters.run_completed`
 *   bk_docket_sync_daily   loan   every loan with an open bankruptcy case → `docket.sync` (PACER's FAKE); receipt `bk_docket_sync.run_completed`
 *   dra_import_daily       global 13.6 `dra.snapshot.import` per retained firm from the `law-firm` port's reported milestones (the FAKE's
 *                                 replies are a pure function of the delivered dispatches); receipt `dra_import.run_completed`
 *   default_case_daily     loan   every loan with an open `regx_ei_windows` row, an open `cases` row of type lossmit / foreclosure /
 *                                 bankruptcy / reo / claim, or an open `claim_candidates` row → `case.progress{loan_id, as_of_date}`
 *                                 (rule 2's steps in order); receipt `default_case.daily.run_completed` — the one SM_DEFAULT_CASE_DAILY waits on
 *   claims_sweep_daily     loan   loans with a liquidation milestone in the last 120 calendar days or an open candidate → `claims.sweep`
 *                                 then `claims.package` for each `opened` candidate; receipt `claims_sweep.run_completed`
 *
 * then one `default_case_daily_runs` row (unique `as_of_date` — a second sweep the same day writes no second run), the daily
 * default report stored through 35.2's documents port (`corporate_7y`; 35.11's input), and the receipt event in one global unit
 * of work. A unit that throws is recorded `failed` (35.3 `job_events.failed` when 35.3 is in the tree) and the later units still
 * run; the run's outcome is `completed` when every unit ran, `partial` otherwise. Nothing here moves money or edits a clock.
 */
import type { Runtime } from "../../../runtime/app.ts";
import type { Queryable } from "../../../infra/db/client.ts";
import { wallClock, zonedEpochMs, toIso } from "../../../kernel/calendar/zoned.ts";
import { addDays, plainDate as D, type PlainDate } from "../../../kernel/calendar/date.ts";
import { delinquencyDailySweep } from "../../../runtime/delinquency.ts";
import { CYCLES_35_9, ET, EV, PROCESS_35_9, STEP_AGENTS, SWEEP_ACTOR } from "../default-35-9.ts";
import { portsOf, type CycleRunHandle, type DefaultOpsPorts, type UnitOutcome } from "./ports.ts";
import { MILESTONE_OF_EVENT } from "./claims.ts";
import { messagePayload, type DispatchRow } from "./firm.ts";
import type { Row } from "./store.ts";

export interface UnitReport { readonly unit_id: string; readonly loan_id: string | null; readonly outcome: UnitOutcome; readonly detail?: Row }
export interface CycleReport { readonly cycle_code: string; readonly run_id: string; readonly recorded: boolean; readonly period_key: string; readonly units: UnitReport[]; readonly receipt_event_id: string | null; readonly failed: number; readonly done: number; readonly skipped: number }
export interface DailyRunReport {
  readonly as_of_date: PlainDate; readonly already: boolean; readonly run_id: string | null; readonly outcome: "completed" | "partial" | "failed" | null;
  readonly cycles: CycleReport[]; readonly loans_scanned: number; readonly report_document_id: string | null; readonly receipt_event_id: string | null; readonly counts: Row;
}
export interface DailyRunOptions { readonly runId?: string | null; readonly ports?: DefaultOpsPorts; readonly plannedBy?: string }

const AGENT = (id: string) => ({ kind: "agent" as const, id });
const OPEN_CASE_TYPES = ["lossmit", "foreclosure", "bankruptcy", "reo", "claim"];
const OPEN_CANDIDATE = ["opened", "package_building", "package_built", "filed"];
const OPEN_BK = ["open", "active", "verifying", "pending", "stay_in_effect"];

/** Already run today? (`default_case_daily_runs.as_of_date` is unique.) */
export async function dailyRunOf(q: Queryable, asOf: PlainDate): Promise<{ id: string; outcome: string; receipt_event_id: string | null } | null> {
  return (await q.query<{ id: string; outcome: string; receipt_event_id: string | null }>(`SELECT id::text AS id, outcome, receipt_event_id::text AS receipt_event_id FROM default_case_daily_runs WHERE as_of_date = $1::date`, [asOf]))[0] ?? null;
}

/** rule 2's universe: the loans the daily unit progresses. */
export async function selectDefaultCaseLoans(q: Queryable): Promise<string[]> {
  const rows = await q.query<{ loan_id: string }>(
    `SELECT DISTINCT loan_id::text AS loan_id FROM (
       SELECT loan_id FROM regx_ei_windows WHERE live_status = 'open'
       UNION SELECT loan_id FROM cases WHERE loan_id IS NOT NULL AND closed_at IS NULL AND case_type = ANY($1::text[]) AND status NOT LIKE 'closed%'
       UNION SELECT loan_id FROM claim_candidates WHERE status = ANY($2::text[])
     ) u WHERE loan_id IS NOT NULL ORDER BY loan_id`, [OPEN_CASE_TYPES, OPEN_CANDIDATE]);
  return rows.map((r) => r.loan_id);
}
async function selectCounterLoans(q: Queryable): Promise<string[]> {
  return (await q.query<{ loan_id: string }>(`SELECT DISTINCT l.id::text AS loan_id FROM loans l JOIN loan_installments i ON i.loan_id = l.id AND i.status = 'due' WHERE l.status = 'active' ORDER BY 1`)).map((r) => r.loan_id);
}
async function selectBankruptcyLoans(q: Queryable): Promise<string[]> {
  return (await q.query<{ loan_id: string }>(`SELECT DISTINCT coalesce(loan_id::text, data->>'loan_id') AS loan_id FROM entity_current WHERE kind = 'bankruptcy_cases' AND coalesce(data->>'status', 'open') = ANY($1::text[]) ORDER BY 1`, [OPEN_BK])).map((r) => r.loan_id).filter((l) => !!l);
}
async function selectClaimsLoans(q: Queryable, asOf: PlainDate): Promise<string[]> {
  return (await q.query<{ loan_id: string }>(
    `SELECT DISTINCT loan_id::text AS loan_id FROM (
       SELECT loan_id FROM case_timelines WHERE event_type = ANY($1::text[]) AND occurred_on >= $2::date
       UNION SELECT loan_id FROM claim_candidates WHERE status = ANY($3::text[])) u ORDER BY 1`, [Object.keys(MILESTONE_OF_EVENT), addDays(asOf, -120), OPEN_CANDIDATE])).map((r) => r.loan_id);
}

/** One cycle: open the run, run every unit (a throw is `failed`, the later units still run), elect the receipt in one global unit of work (35.3 rule 5). */
async function runCycle(rt: Runtime, ports: Required<DefaultOpsPorts>, i: { cycle_code: string; receipt: string | null; as_of: PlainDate; now: string; planned_by: string; loans: readonly (string | null)[]; unit: (loanId: string | null) => Promise<Row | void> }): Promise<CycleReport> {
  const periodKey = i.as_of;
  const run: CycleRunHandle = await ports.cycles.openRun(rt.db, { cycle_code: i.cycle_code, period_key: periodKey, as_of_date: i.as_of, planned_by: i.planned_by, units_total: i.loans.length, now: i.now });
  const units: UnitReport[] = [];
  for (const loanId of i.loans) {
    const unitId = loanId ?? "global";
    let outcome: UnitOutcome; let detail: Row | undefined;
    try { const d = await i.unit(loanId); detail = d ?? undefined; outcome = { status: d && d["skipped"] ? "skipped" : "done", decision_id: (d?.["decision_id"] as string | undefined) ?? null }; }
    catch (e) { outcome = { status: "failed", error: e instanceof Error ? e.message : String(e) }; rt.logger?.warn(`35.9 ${i.cycle_code} unit failed`, { at: i.now, loan_id: loanId, error: outcome.error }); }
    await ports.cycles.unitDone(rt.db, run, { cycle_code: i.cycle_code, period_key: periodKey, as_of_date: i.as_of, unit_id: unitId, loan_id: loanId, planned_by: i.planned_by, now: i.now }, outcome);
    units.push({ unit_id: unitId, loan_id: loanId, outcome, ...(detail ? { detail } : {}) });
  }
  const done = units.filter((u) => u.outcome.status === "done").length, failed = units.filter((u) => u.outcome.status === "failed").length, skipped = units.filter((u) => u.outcome.status === "skipped").length;
  let receiptId: string | null = null;
  // a cycle whose receipt is elected by the pass itself (`default_case_daily`: `default_case.daily.run_completed` with the run row) is completed there
  if (i.receipt === null) return { cycle_code: i.cycle_code, run_id: run.run_id, recorded: run.recorded, period_key: periodKey, units, receipt_event_id: null, failed, done, skipped };
  await rt.uow.run({}, async (ctx) => {
    const ev = ctx.events.append({ type: i.receipt!, aggregate: { kind: "cycle_run", id: run.run_id }, actor: SWEEP_ACTOR, payload: { cycle_code: i.cycle_code, run_id: run.run_id, period_key: periodKey, as_of_date: i.as_of, planned_by: i.planned_by, units_total: units.length, units_done: done, units_dead: failed, units_skipped: skipped, failed_units: units.filter((u) => u.outcome.status === "failed").map((u) => ({ unit_id: u.unit_id, error: u.outcome.error ?? null })) } });
    receiptId = ev.id;
  }, { clock: rt.clock, commit: async (q) => { await ports.cycles.complete(q, run, { cycle_code: i.cycle_code, period_key: periodKey, as_of_date: i.as_of, units: units.map((u) => ({ unit_id: u.unit_id, outcome: u.outcome })), receipt_event_id: receiptId, now: i.now }); } });
  return { cycle_code: i.cycle_code, run_id: run.run_id, recorded: run.recorded, period_key: periodKey, units, receipt_event_id: receiptId, failed, done, skipped };
}

/** The `law-firm` port's DRA rows for the day: every milestone the port has reported on a delivered referral by `asOf`, grouped by firm (13.6's snapshot is per firm). */
async function draRowsByFirm(rt: Runtime, asOf: PlainDate): Promise<Map<string, Row[]>> {
  const out = new Map<string, Row[]>();
  const port = rt.ports.lawFirm; if (!port) return out;
  const SEL = `id::text AS id, loan_id::text AS loan_id, case_id::text AS case_id, firm_id, kind, owning_event_id::text AS owning_event_id, integration_message_id::text AS integration_message_id, document_id::text AS document_id, sent_at::text AS sent_at, acknowledged_at::text AS acknowledged_at, ack_source, created_at::text AS created_at`;
  const dispatches = await rt.db.query<DispatchRow>(`SELECT ${SEL} FROM firm_dispatches WHERE kind = 'referral_package' AND sent_at IS NOT NULL ORDER BY created_at, id`);
  for (const d of dispatches) {
    const m = await messagePayload(rt.db, d); if (!m) continue;
    const rows = out.get(d.firm_id) ?? [];
    for (const r of port.repliesFor(m, asOf)) {
      if (r.kind === "milestone") rows.push({ loan_id: d.loan_id, event_name: String(r.payload["code"] ?? "").toLowerCase(), event_date: String(r.payload["occurred_on"] ?? r.due_on), entered_by_firm: d.firm_id });
      if (r.kind === "sale") rows.push({ loan_id: d.loan_id, event_name: "sale_scheduled", event_date: String(r.payload["scheduled_on"] ?? r.due_on), entered_by_firm: d.firm_id });
    }
    out.set(d.firm_id, rows);
  }
  return out;
}

const n = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" ? Number(v) : 0);
const count = async (q: Queryable, sql: string, params: unknown[]): Promise<number> => Number((await q.query<{ c: string }>(`SELECT count(*)::text AS c ${sql}`, params))[0]?.c ?? 0);

/** The day's pass. `already: true` when the day's run exists (a second sweep the same day). */
export async function runDefaultCaseDay(rt: Runtime, nowIso: string, o: DailyRunOptions = {}): Promise<DailyRunReport> {
  const asOf: PlainDate = D(wallClock(Date.parse(nowIso), ET).date);
  const ports = portsOf(o.ports);
  const existing = await dailyRunOf(rt.db, asOf);
  if (existing) return { as_of_date: asOf, already: true, run_id: existing.id, outcome: existing.outcome as DailyRunReport["outcome"], cycles: [], loans_scanned: 0, report_document_id: null, receipt_event_id: existing.receipt_event_id, counts: {} };
  const now = nowIso; const plannedBy = o.plannedBy ?? (o.runId ? `sweep:${o.runId}` : `sweep:${rt.instanceId}`);
  const dayStart = toIso(zonedEpochMs(asOf, "00:00", ET));
  await rt.caseFolder.settle();
  const cycles: CycleReport[] = [];
  const cycle = (c: Parameters<typeof runCycle>[2]) => runCycle(rt, ports, c).then((r) => { cycles.push(r); return r; });
  const exec = async (process: string, name: string, loanId: string, agent: string, input: Row): Promise<Row> => {
    const r = await rt.execute({ process, name, loanId, actor: AGENT(agent), input });
    return { ...((r.output ?? {}) as Row), decision_id: r.decisionId ?? null };
  };
  // 1. delinquency_counters (after 35.5's cashiering_daily, before default_case_daily): the counter per loan in the loan's zone
  await cycle({ cycle_code: CYCLES_35_9.counters, receipt: EV.countersRunCompleted, as_of: asOf, now, planned_by: plannedBy, loans: await selectCounterLoans(rt.db),
    unit: async (loanId) => {
      const r = await delinquencyDailySweep(rt, now, [loanId!], { oncePerDay: true, zoneOf: (l, today) => ports.servicingConfig.zoneOf(rt.db, l, today) });
      const loan = r.loans[0]; const sk = r.skipped?.[0];
      return loan ? { today: loan.today ?? null, time_zone: loan.time_zone ?? null, windows_opened: loan.windows_opened, milestone: loan.milestone, events: loan.events } : { skipped: sk?.reason ?? "no_installments" };
    } });
  // 2. bk_docket_sync_daily: PACER's new entries for every open bankruptcy case
  await cycle({ cycle_code: CYCLES_35_9.docketSync, receipt: EV.docketSyncRunCompleted, as_of: asOf, now, planned_by: plannedBy, loans: await selectBankruptcyLoans(rt.db),
    unit: (loanId) => exec(PROCESS_35_9, "docket.sync", loanId!, STEP_AGENTS.foreclosure, { loan_id: loanId, as_of_date: asOf }) });
  // 3. dra_import_daily (global): 13.6's import per firm from the port's reported milestones; the receipt also satisfies nothing of 13.6's — SM_DRA_RECONCILE_DAILY is 13.6's own, armed by its import
  await cycle({ cycle_code: CYCLES_35_9.draImport, receipt: EV.draImportRunCompleted, as_of: asOf, now, planned_by: plannedBy, loans: [null],
    unit: async () => {
      const byFirm = await draRowsByFirm(rt, asOf); const imports: Row[] = [];
      for (const [firmId, rows] of byFirm) imports.push(await exec("13.6", "dra.snapshot.import", "", STEP_AGENTS.foreclosure, { id: `dra-${firmId}-${asOf}`, firm_id: firmId, as_of: asOf, source: "portal_export", rows, today: asOf }));
      return { firms: byFirm.size, rows: [...byFirm.values()].reduce((a, r) => a + r.length, 0), imports: imports.length };
    } });
  // 4. default_case_daily: rule 2 per loan of the universe
  const universe = await selectDefaultCaseLoans(rt.db);
  const daily = await cycle({ cycle_code: CYCLES_35_9.dailyCase, receipt: null, as_of: asOf, now, planned_by: plannedBy, loans: universe,
    unit: (loanId) => exec(PROCESS_35_9, "case.progress", loanId!, STEP_AGENTS.foreclosure, { loan_id: loanId, as_of_date: asOf }) });
  // 5. claims_sweep_daily (depends on default_case_daily): the sweep and the packages of the opened candidates
  await cycle({ cycle_code: CYCLES_35_9.claimsSweep, receipt: EV.claimsSweepRunCompleted, as_of: asOf, now, planned_by: plannedBy, loans: await selectClaimsLoans(rt.db, asOf),
    unit: async (loanId) => {
      const swept = await exec(PROCESS_35_9, "claims.sweep", loanId!, STEP_AGENTS.foreclosure, { loan_id: loanId, as_of_date: asOf });
      const opened = await rt.db.query<{ id: string }>(`SELECT id::text AS id FROM claim_candidates WHERE loan_id = $1::uuid AND status = 'opened' ORDER BY opened_at, id`, [loanId]);
      const packaged: string[] = [];
      for (const c of opened) { await exec(PROCESS_35_9, "claims.package", loanId!, STEP_AGENTS.foreclosure, { candidate_id: c.id }); packaged.push(c.id); }
      return { opened: ((swept["opened"] as Row[] | undefined) ?? []).length, packaged: packaged.length, decision_id: swept["decision_id"] ?? null };
    } });
  // the run's counters: the units' own reports plus the day's rows (the breach side is the sweep's, read from the tables)
  const sum = (key: string): number => daily.units.reduce((a, u) => a + n(u.detail?.[key]), 0);
  const stepCount = (step: string, key: string): number => daily.units.reduce((a, u) => { const st = (u.detail?.["steps"] as Record<string, { detail?: Row }> | undefined)?.[step]; return a + n(st?.detail?.[key]) + (Array.isArray(st?.detail?.[key]) ? (st!.detail![key] as unknown[]).length : 0); }, 0);
  const reconRow = (await rt.db.query<{ payload: Row }>(`SELECT payload FROM loan_events WHERE type = $1 ORDER BY sequence DESC LIMIT 1`, [EV.breachReconCompleted]))[0];
  const counts: Row = {
    loans_scanned: universe.length, events_folded: sum("events_folded"), milestones_due: sum("milestones_due"),
    milestones_expected: await count(rt.db, `FROM case_milestone_expectations WHERE created_at >= $1::timestamptz`, [dayStart]),
    milestones_satisfied: await count(rt.db, `FROM case_milestone_expectations WHERE status = 'satisfied' AND updated_at >= $1::timestamptz`, [dayStart]),
    docket_events_reacted: stepCount("docket", "reacted"), docket_events_deferred: stepCount("docket", "deferred"),
    breach_actions_executed: await count(rt.db, `FROM breach_actions WHERE outcome = 'executed' AND created_at >= $1::timestamptz`, [dayStart]),
    breach_actions_deferred: await count(rt.db, `FROM breach_actions WHERE outcome = 'deferred' AND created_at >= $1::timestamptz`, [dayStart]),
    breach_actions_missing: n(reconRow?.payload["missing"]),
    claims_opened: cycles.filter((c) => c.cycle_code === CYCLES_35_9.claimsSweep).flatMap((c) => c.units).reduce((a, u) => a + n(u.detail?.["opened"]), 0) + stepCount("claims", "opened"),
    claims_packaged: cycles.filter((c) => c.cycle_code === CYCLES_35_9.claimsSweep).flatMap((c) => c.units).reduce((a, u) => a + n(u.detail?.["packaged"]), 0) + stepCount("claims", "packaged"),
    firm_dispatches: await count(rt.db, `FROM firm_dispatches WHERE created_at >= $1::timestamptz`, [dayStart]),
    firm_acks: await count(rt.db, `FROM firm_dispatches WHERE acknowledged_at >= $1::timestamptz`, [dayStart]),
    exposure_recomputed: stepCount("exposure", "projected"),
  };
  const failedUnits = cycles.reduce((a, c) => a + c.failed, 0);
  const outcome: "completed" | "partial" = failedUnits === 0 ? "completed" : "partial";
  // the daily default report (35.2 documents port, corporate_7y): cases by status, milestones due and overdue, docket entries deferred, breach actions by outcome, claims by status and legal due date, firm dispatches unacknowledged
  const report = {
    as_of_date: asOf, planned_by: plannedBy, outcome, cycles: cycles.map((c) => ({ cycle_code: c.cycle_code, run_id: c.run_id, units_total: c.units.length, units_done: c.done, units_dead: c.failed, units_skipped: c.skipped, failed_units: c.units.filter((u) => u.outcome.status === "failed").map((u) => ({ unit_id: u.unit_id, error: u.outcome.error })) })),
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
    const ev = ctx.events.append({ type: EV.dailyRunCompleted, aggregate: { kind: "default_case_daily_run", id: asOf }, actor: SWEEP_ACTOR,
      payload: { as_of_date: asOf, planned_by: plannedBy, outcome, cycle_run_ids: cycles.map((c) => c.run_id), ...counts, units_failed: failedUnits } });
    receiptId = ev.id;
  }, { clock: rt.clock, commit: async (q) => {
    const stored = await ports.documents.store(q, { loan_id: null, kind: "default_case_daily_report", body: JSON.stringify(report, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), mime_type: "application/json", retention_class: "corporate_7y", metadata: { as_of_date: asOf, process: PROCESS_35_9, outcome }, now });
    documentId = stored.document_id;
    const ins = await q.query<{ id: string }>(
      `INSERT INTO default_case_daily_runs (as_of_date, cycle_run_ids, loans_scanned, events_folded, milestones_expected, milestones_due, milestones_satisfied, docket_events_reacted, docket_events_deferred, breach_actions_executed, breach_actions_deferred, breach_actions_missing, claims_opened, claims_packaged, firm_dispatches, firm_acks, exposure_recomputed, outcome, report_document_id, receipt_event_id, created_at)
       VALUES ($1::date, $2::uuid[], $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::uuid, $20::uuid, $21::timestamptz) ON CONFLICT (as_of_date) DO NOTHING RETURNING id::text AS id`,
      [asOf, cycles.filter((c) => c.recorded).map((c) => c.run_id), counts["loans_scanned"], counts["events_folded"], counts["milestones_expected"], counts["milestones_due"], counts["milestones_satisfied"], counts["docket_events_reacted"], counts["docket_events_deferred"], counts["breach_actions_executed"], counts["breach_actions_deferred"], counts["breach_actions_missing"], counts["claims_opened"], counts["claims_packaged"], counts["firm_dispatches"], counts["firm_acks"], counts["exposure_recomputed"], outcome, documentId, receiptId, now]);
    runId = ins[0]?.id ?? null;
    // the daily cycle's own receipt is this event (35.3 rule 5: the run's receipt row points at it)
    const dc = cycles.find((c) => c.cycle_code === CYCLES_35_9.dailyCase);
    if (dc) await ports.cycles.complete(q, { run_id: dc.run_id, recorded: dc.recorded }, { cycle_code: dc.cycle_code, period_key: dc.period_key, as_of_date: asOf, units: dc.units.map((u) => ({ unit_id: u.unit_id, outcome: u.outcome })), receipt_event_id: receiptId, now });
  } });
  return { as_of_date: asOf, already: false, run_id: runId, outcome, cycles, loans_scanned: universe.length, report_document_id: documentId, receipt_event_id: receiptId, counts };
}
