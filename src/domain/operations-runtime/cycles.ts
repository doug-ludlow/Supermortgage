/**
 * §35.3 rule 2 — the code registry of every scheduled cycle. `CYCLES` is the source; `cycle_registry` is its projection
 * (the planner upserts every def with `registry_version = CYCLES_VERSION` and adds the runtime columns). Per cycle:
 *
 *   cycle_code / owner_process / owner_agent   the row; every unit runs as `{kind: "agent", id: owner_agent}` (rule 8)
 *   unit_scope, period_grammar, period_of      what a unit is and which period keys a planner pass plans (`periodKeysDue`)
 *   selector                                   a SQL read over typed rows — `loans`, `loan_terms`, `loan_installments` (0003),
 *                                              `custodial_accounts`, `arm_schedule`, `mi_schedules`, `loan_events` — never `entity_records`
 *   runner                                     `in_command` (the whole unit is the body of `cycles.run_unit`'s command — one transaction)
 *                                              or `pass` (a runtime pass that opens its own units of work), or null: the owning process
 *                                              (35.2, 35.4–35.12) has not landed it — the unit dies `runner_missing` on its first claim
 *   receipt_event, depends_on, serves_timer, escalation_role, expected_by_rule   the row's remaining columns (spec table)
 *
 * The event literals this process emits are bare strings here (`EVT`) so tools/lint-emission.ts counts them; the planner and the
 * executor (service.ts) append them. The period-key grammar (rule 3): `day` → the as-of civil date (ET); `month` → the prior month
 * on the first pass of a new month (`period_of: prior_month`) or the as-of month (`current_month`); `tax_year` → the years
 * `tax_year.closed{tax_year}` named; `billing_cycle` → the `statement.cycle.opened` due dates whose statement date has arrived;
 * `event` → the as-of date whenever the named event is present. A `period` unit is the period itself (`unit_id = period_key`);
 * an `account` unit is a custodial account (`<account_id>` or `<account_id>:<remittance_type>` — T6's `2026-09:<account>:A/A`
 * spelling of `<cycle_code>:<period_key>:<unit_id>`); a `global` unit is `global`.
 */
import type { Queryable } from "../../infra/db/client.ts";
import type { Actor } from "../../kernel/events/index.ts";
import type { ToolRuntime } from "../../app/tools.ts";
import type { CommandContext } from "../../app/commands.ts";
import type { Runtime } from "../../runtime/app.ts";
import { type PlainDate, plainDate as D, addDays, endOfMonth, startOfMonth, parts } from "../../kernel/calendar/date.ts";
import { addBusinessDays, defaultCalendars, type CalendarSet, type DayUnit } from "../../kernel/calendar/business.ts";
import { zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import { CLAIM_MILESTONE_EVENT_TYPES, OPEN_BK_STATUSES, OPEN_CANDIDATE_STATUSES, OPEN_CASE_TYPES } from "./default-35-9.ts";

/** The export's semver — `cycle_registry.registry_version`. */
export const CYCLES_VERSION = "1.0.0";
export const ET = "America/New_York";

/** Every event this process appends (spec "Events this process emits"), as bare literals. */
export const EVT = {
  PLAN_COMPLETED: "cycles.plan.run_completed",
  PLAN_SKIPPED: "cycles.plan.skipped",
  RUN_OPENED: "cycle.run.opened",
  RUN_COMPLETED: "cycle.run.completed",
  RUN_CANCELLED: "cycle.run.cancelled",
  CLAIMED: "job.unit.claimed",
  DONE: "job.unit.done",
  FAILED: "job.unit.failed",
  DEAD: "job.unit.dead",
  RESOLVED: "job.unit.resolved",
  LEASE_EXPIRED: "job.lease.expired",
  MONTH_ENDED: "ledger.month.ended",
} as const;
/** The events the dependency matcher reads (spec "Events this process reacts to"). */
export const DEP_EVENTS = { LEDGER_PERIOD_CLOSED: "ledger.period.closed", INVESTOR_PERIOD_CLOSED: "investor_reporting_periods.closed", TAX_YEAR_CLOSED: "tax_year.closed", STATEMENT_CYCLE_OPENED: "statement.cycle.opened", STATEMENT_SENT: "statement.sent" } as const;

export type UnitScope = "loan" | "account" | "period" | "global";
export type PeriodGrammar = "day" | "month" | "tax_year" | "billing_cycle" | "event";
export type PeriodOf = "prior_month" | "current_month";
/** `depends_on`: a receipt of another cycle for a period derived from the unit's own, or a named event for the unit's period. */
export type Dependency = { readonly cycle_code: string; readonly period_of?: "same_day" | "last_day_of_month" | "bd1_following_month" } | { readonly event: string };

export interface Unit {
  readonly unit_id: string;
  readonly loan_id?: string;
  readonly application_id?: string;
  /** ids and dates only — never `*_cents`, `state`, `custodial` or `changes` (rule 8, NO_CLIENT_STATE). */
  readonly input?: Record<string, unknown>;
  readonly priority?: number;
}
export interface PeriodDue { readonly period_key: string; readonly period_end: PlainDate; }
export interface SelectorWindow extends PeriodDue { readonly as_of_date: PlainDate; readonly as_of: string; }
export type Selector = (q: Queryable, window: SelectorWindow) => Promise<Unit[]>;
export interface NamedSelector { readonly name: string; readonly select: Selector; }

export interface UnitContext {
  readonly job_id: string; readonly run_id: string; readonly cycle_code: string; readonly period_key: string; readonly period_end: PlainDate; readonly unit_id: string;
  readonly loan_id: string | null; readonly application_id: string | null; readonly as_of_date: PlainDate; readonly input: Record<string, unknown>; readonly actor: Actor; readonly attempt: number;
}
/** `in_command`: the unit is the body of `cycles.run_unit`'s command (one transaction — D5); `pass`: a runtime pass that opens its own units of work, called un-nested by the executor. */
export type Runner =
  | { readonly mode: "in_command"; readonly run: (toolRt: ToolRuntime, ctx: CommandContext, unit: UnitContext) => Promise<unknown> | unknown }
  | { readonly mode: "pass"; readonly run: (rt: Runtime, unit: UnitContext) => Promise<unknown> | unknown };
export interface NamedRunner { readonly name: string; readonly runner: Runner; }

export interface CycleDef {
  readonly cycle_code: string;
  readonly owner_process: string;
  readonly owner_agent: string;
  readonly unit_scope: UnitScope;
  /** The row's own words (the owner's timing rule). */
  readonly schedule: string;
  readonly period_grammar: PeriodGrammar;
  readonly period_of?: PeriodOf;
  /** `period_grammar: event | tax_year`: the `loan_events` type whose presence plans a run. */
  readonly event?: string;
  /** The calendar a `day` cycle runs on (a non-business day plans nothing) and the one `BDn` in `expected_by_rule` counts on — taken from the def, never a default. */
  readonly calendar?: DayUnit;
  readonly selector: NamedSelector;
  /** null: the owning process supplies it later — dead on first claim with `error_class: runner_missing` (edge case 3). */
  readonly runner: NamedRunner | null;
  readonly receipt_event: string;
  /** Who appends `receipt_event` at the election: 35.3 (`election`, the default) or the cycle's owner (`owner` — 35.1's `projection_verify`, 35.2's `document_integrity`, 35.12's `parallel_run.reconcile`, 35.5's `lockbox_ingest` / `ach_file_build` / `ach_returns_ingest` whose tools emit their own receipt literal: "the election emits `cycle.run.completed` only", rule 2; `cycle_receipts.receipt_event_id` is then NULL). */
  readonly receipt_emitted_by: "election" | "owner";
  /** The owner's fields on its receipt literal beside rule 5's standard payload (35.5 rule 6: `cashiering.daily.run_completed{loans, posted, late_charges_assessed, amount_change_checks, …}`), read from the run's own rows at the election; runners.ts attaches it with the runner. */
  readonly receipt_payload?: (q: Queryable, run: { readonly run_id: string; readonly period_key: string; readonly as_of_date: string; readonly units_total: number }) => Promise<Record<string, unknown>>;
  readonly depends_on: readonly Dependency[];
  readonly serves_timer: string | null;
  readonly escalation_role: string;
  readonly expected_by_rule: string | null;
  /**
   * Who plans the cycle's runs: the sweep's cycles pass and the demo step (`sweep`, the default — every pass at the as-of date plans the
   * period keys due), or the owner's own pass (`owner`: planned only by a `cycles.plan{cycle_codes}` that names the code — 35.9's four case
   * cycles, which its daily pass plans in dependency order at/after 05:30 ET, each after the previous one's receipt, so rule 2's universe
   * is read after the day's counters opened their windows; src/domain/operations-runtime/default-35-9/daily-run.ts). The row's `schedule`
   * states it; the registry table carries no column for it.
   */
  readonly plan_mode?: "sweep" | "owner";
}

// ─────────────────────────── period keys (rule 3, rule 10)
const ym = (d: PlainDate): string => d.slice(0, 7);
export const priorMonthOf = (asOf: PlainDate): { period_key: string; period_end: PlainDate } => { const end = addDays(startOfMonth(asOf), -1); return { period_key: ym(end), period_end: end }; };
export const monthOf = (asOf: PlainDate): { period_key: string; period_end: PlainDate } => ({ period_key: ym(asOf), period_end: endOfMonth(asOf) });
const isBusinessDay = (d: PlainDate, unit: DayUnit | undefined, cals: CalendarSet): boolean => !unit || cals[unit].isBusinessDay(d);

/** The period keys a pass at `asOfDate` plans for `def` — each with its `period_end` (the anchor of `expected_by_rule` and of the month-end dependencies). */
export async function periodKeysDue(q: Queryable, def: CycleDef, asOfDate: PlainDate, cals: CalendarSet = defaultCalendars): Promise<PeriodDue[]> {
  switch (def.period_grammar) {
    case "day": return isBusinessDay(asOfDate, def.calendar, cals) ? [{ period_key: asOfDate, period_end: asOfDate }] : [];
    case "month": return [def.period_of === "current_month" ? monthOf(asOfDate) : priorMonthOf(asOfDate)];
    case "tax_year": {
      const rows = await q.query<{ y: string }>(`SELECT DISTINCT payload->>'tax_year' AS y FROM loan_events WHERE type = $1 AND payload ? 'tax_year' AND occurred_at <= $2::timestamptz + interval '1 day' ORDER BY y`, [def.event ?? DEP_EVENTS.TAX_YEAR_CLOSED, `${asOfDate}T23:59:59Z`]);
      return rows.filter((r) => /^\d{4}$/.test(r.y)).map((r) => ({ period_key: r.y, period_end: D(`${r.y}-12-31`) }));
    }
    case "billing_cycle": {
      // 7.1's cycle rows: every `statement.cycle.opened{cycle_due_date, courtesy_period_end}` whose statement date (courtesy_period_end + 1) has arrived
      const rows = await q.query<{ due: string }>(`SELECT DISTINCT payload->>'cycle_due_date' AS due FROM loan_events WHERE type = $1 AND (payload->>'courtesy_period_end')::date + 1 <= $2::date ORDER BY due`, [DEP_EVENTS.STATEMENT_CYCLE_OPENED, asOfDate]);
      return rows.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.due)).map((r) => ({ period_key: r.due, period_end: D(r.due) }));
    }
    case "event": {
      if (!def.event) return [];
      const rows = await q.query<{ n: string }>(`SELECT count(*)::text AS n FROM loan_events WHERE type = $1`, [def.event]);
      return Number(rows[0]?.n ?? "0") > 0 ? [{ period_key: asOfDate, period_end: asOfDate }] : [];
    }
  }
}

// ─────────────────────────── expected_by (rule 11)
/**
 * `expected_by_rule` grammar: `same_day HH:MM ET`, `BDn HH:MM ET` (on the def's named calendar), `+N calendar_days`, `HH:MM ET`;
 * anything else → null (`next_expected_by` NULL, never overdue — a 35.11 finding). `anchor` is the period's end (a day's date, a month's last day).
 */
export function expectedBy(rule: string | null, anchor: PlainDate, calendar: DayUnit | undefined, cals: CalendarSet = defaultCalendars): number | null {
  if (!rule) return null;
  const r = rule.trim();
  let m = /^same_day\s+(\d{1,2}:\d{2})\s*ET$/i.exec(r);
  if (m) return zonedEpochMs(anchor, m[1]!.padStart(5, "0"), ET);
  m = /^BD(\d+)\s+(\d{1,2}:\d{2})\s*ET$/i.exec(r);
  if (m) { const cal = cals[calendar ?? "business_days_fannie_et"]; return zonedEpochMs(addBusinessDays(anchor, Number(m[1]), cal), m[2]!.padStart(5, "0"), ET); }
  m = /^\+(\d+)\s+calendar_days$/i.exec(r);
  if (m) return zonedEpochMs(addDays(anchor, Number(m[1])), "23:59", ET);
  m = /^(\d{1,2}:\d{2})\s*ET$/i.exec(r);
  if (m) return zonedEpochMs(anchor, m[1]!.padStart(5, "0"), ET);
  return null;
}

// ─────────────────────────── dependencies (rule 3's blocked → queued)
/**
 * The period key of a `{cycle_code, period_of}` dependency for a unit of period `period_key` / `period_end`. `same_day` (the
 * table's "cashiering_daily (same day)" / "the day's postings are on the statement") is the day the unit was PLANNED — the run's
 * `as_of_date` — not the unit's own period key: a statement for `cycle_due_date 2026-10-01` planned on its statement date
 * 2026-10-17 waits on `cashiering_daily:2026-10-17` (worked example A / T9), an escrow analysis for `2026-10` on the day it was
 * planned; for a `day` cycle the two coincide. Without an as-of (a caller that has none) the unit's period key stands.
 */
export function dependencyPeriod(dep: { readonly period_of?: "same_day" | "last_day_of_month" | "bd1_following_month" }, period: PeriodDue, cals: CalendarSet = defaultCalendars, asOfDate?: PlainDate): string {
  switch (dep.period_of ?? "same_day") {
    case "same_day": return asOfDate ?? period.period_key;
    case "last_day_of_month": return endOfMonth(period.period_end);
    // amendment order 11: `investor_period_close` depends on `lar_daily` for BD1 of the following month (the period's last non-removal LARs), on `business_days_fannie_et`
    case "bd1_following_month": return addBusinessDays(endOfMonth(period.period_end), 1, cals.business_days_fannie_et);
  }
}
/** The period an event-typed dependency names: `payload.period_key ?? payload.period ?? period_end.slice(0, 7)` (A2); `ledger.period.closed` must also name the unit's custodial account. */
export async function dependencyMet(q: Queryable, dep: Dependency, unit: { readonly period: PeriodDue; readonly input: Record<string, unknown>; /** the run's as_of_date — what a `same_day` receipt dependency names */ readonly as_of_date?: PlainDate }, cals: CalendarSet = defaultCalendars): Promise<boolean> {
  if ("event" in dep) {
    const rows = await q.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM loan_events WHERE type = $1`, [dep.event]);
    const period = unit.period.period_key;
    const account = typeof unit.input["custodial_account_id"] === "string" ? unit.input["custodial_account_id"] : null;
    return rows.some((r) => {
      const p = r.payload;
      const key = typeof p["period_key"] === "string" ? p["period_key"] : typeof p["period"] === "string" ? p["period"] : typeof p["period_end"] === "string" ? String(p["period_end"]).slice(0, 7) : null;
      if (key !== period && key !== unit.period.period_end) return false;
      if (dep.event === DEP_EVENTS.LEDGER_PERIOD_CLOSED && account && typeof p["custodial_account_id"] === "string" && p["custodial_account_id"] !== account) return false;
      return true;
    });
  }
  const rows = await q.query<{ n: string }>(`SELECT count(*)::text AS n FROM cycle_receipts WHERE cycle_code = $1 AND period_key = $2`, [dep.cycle_code, dependencyPeriod(dep, unit.period, cals, unit.as_of_date)]);
  return Number(rows[0]?.n ?? "0") > 0;
}

// ─────────────────────────── selectors (typed rows only)
const isUndefinedTable = (e: unknown): boolean => (e as { code?: unknown } | null)?.code === "42P01";
/** A read over a table another process creates later (35.5's lockboxes, 35.9's cases, …): absent → no unit, never a failed pass. */
async function rowsOf<R extends Record<string, unknown>>(q: Queryable, sql: string, params: readonly unknown[] = []): Promise<R[]> {
  try { return await q.query<R>(sql, params); } catch (e) { if (isUndefinedTable(e)) return []; throw e; }
}
const ACTIVE_LOAN = `l.boarded_at IS NOT NULL AND l.status NOT IN ('paid_off', 'transferred_out', 'repurchased', 'charged_off', 'monitored')`;
const loanUnits = (rows: readonly { id: string }[], input: (id: string) => Record<string, unknown> = () => ({})): Unit[] => rows.map((r) => ({ unit_id: r.id, loan_id: r.id, input: { loan_id: r.id, ...input(r.id) } }));
const one = (id: string, input: Record<string, unknown> = {}): Unit[] => [{ unit_id: id, input }];

export const selectors = {
  /** every active boarded loan (the spec's row: "daily, every active loan") */
  active_loans: { name: "active_loans", select: async (q) => loanUnits(await q.query<{ id: string }>(`SELECT l.id FROM loans l WHERE ${ACTIVE_LOAN} ORDER BY l.boarded_at, l.id`)) } satisfies NamedSelector,
  /** 35.5 rule 6's selector for `cashiering_daily`: every active boarded loan with its `loan_servicing_configs` row in force on the day (rule 9: a loan without one has no civil day — it is never a unit; the boarding clock SM_LOAN_SERVICING_CONFIG_AT_BOARD_0 and cashieringDailyRun's failed CONFIG_REQUIRED row name it), no origination_application_id condition */
  active_loans_configured: { name: "active_loans_configured", select: async (q, w) => loanUnits(await rowsOf<{ id: string }>(q, `SELECT l.id FROM loans l WHERE ${ACTIVE_LOAN} AND EXISTS (SELECT 1 FROM loan_servicing_configs c WHERE c.loan_id = l.id AND c.effective_from <= $1::date) ORDER BY l.boarded_at, l.id`, [w.as_of_date])) } satisfies NamedSelector,
  /** every active loan with an unpaid installment before the day (delinquency.ts:37-43) */
  delinquent_loans: { name: "delinquent_loans", select: async (q, w) => loanUnits(await q.query<{ id: string }>(`SELECT DISTINCT l.id FROM loans l JOIN loan_installments i ON i.loan_id = l.id AND i.status = 'due' AND i.due_date < $1::date WHERE l.status = 'active' ORDER BY l.id`, [w.as_of_date])) } satisfies NamedSelector,
  /** 7.1: the loans whose `statement.cycle.opened{cycle_due_date = period}` has reached its statement date and has no `statement.sent{cycle_due_date}` */
  statements_due: { name: "statements_due", select: async (q, w) => {
    const rows = await q.query<{ loan_id: string; courtesy: string }>(
      `SELECT DISTINCT ON (o.loan_id) o.loan_id::text AS loan_id, o.payload->>'courtesy_period_end' AS courtesy FROM loan_events o
        WHERE o.type = $1 AND o.payload->>'cycle_due_date' = $2 AND o.loan_id IS NOT NULL AND (o.payload->>'courtesy_period_end')::date + 1 <= $3::date
          AND NOT EXISTS (SELECT 1 FROM loan_events s WHERE s.type = $4 AND s.loan_id = o.loan_id AND s.payload->>'cycle_due_date' = $2)
        ORDER BY o.loan_id, o.sequence DESC`, [DEP_EVENTS.STATEMENT_CYCLE_OPENED, w.period_key, w.as_of_date, DEP_EVENTS.STATEMENT_SENT]);
    // worked example A: courtesy_period_end 2026-10-16 → statement_date 2026-10-17 — ids and dates only, no cents, no state
    return rows.map((r) => ({ unit_id: r.loan_id, loan_id: r.loan_id, input: { loan_id: r.loan_id, cycle_due_date: w.period_key, statement_date: addDays(D(r.courtesy), 1) } }));
  } } satisfies NamedSelector,
  /** 7.1-A: every boarded loan with ≥ $600 of interest credited in the tax year (the ledger's `interest_due` allocation lines) */
  reportable_1098_loans: { name: "reportable_1098_loans", select: async (q, w) => loanUnits(await q.query<{ id: string }>(
    `SELECT l.id FROM loans l WHERE l.boarded_at IS NOT NULL AND (SELECT coalesce(-sum(x.amount_cents), 0) FROM ledger_lines x JOIN ledger_entry_sets e ON e.id = x.set_id WHERE x.scope = 'loan' AND x.loan_id = l.id AND x.account = 'interest_due' AND x.amount_cents < 0 AND e.effective_date >= $1::date AND e.effective_date < $2::date) >= 60000 ORDER BY l.id`,
    [`${w.period_key}-01-01`, `${Number(w.period_key) + 1}-01-01`]), () => ({ tax_year: Number(w.period_key) })) } satisfies NamedSelector,
  /** 3.x: every escrowed loan whose analysis month (the first payment date's month) is the period's month */
  escrowed_loans_analysis_month: { name: "escrowed_loans_analysis_month", select: async (q, w) => loanUnits(await q.query<{ id: string }>(
    `SELECT l.id FROM loans l WHERE ${ACTIVE_LOAN} AND EXTRACT(MONTH FROM l.first_payment_date) = $1 AND EXISTS (SELECT 1 FROM loan_terms t WHERE t.loan_id = l.id AND t.escrowed = true) ORDER BY l.id`, [parts(w.period_end).m]), () => ({ analysis_month: w.period_key })) } satisfies NamedSelector,
  /** the period itself is the unit (`lar_daily`, `investor_period_close`, `star_monthly`) */
  period: { name: "period", select: async (_q, w) => one(w.period_key, { period_key: w.period_key, period_end: w.period_end }) } satisfies NamedSelector,
  /** every custodial account (6.3's three-way) */
  custodial_accounts: { name: "custodial_accounts", select: async (q) => (await q.query<{ id: string; kind: string; rt: string | null }>(`SELECT id::text AS id, kind, remittance_type::text AS rt FROM custodial_accounts ORDER BY created_at, id`)).map((r) => ({ unit_id: r.id, input: { custodial_account_id: r.id, kind: r.kind, remittance_type: r.rt } })) } satisfies NamedSelector,
  /** the P&I custodial accounts by remittance type (`<account_id>:<remittance_type>`) */
  pi_accounts_by_remittance: { name: "pi_accounts_by_remittance", select: async (q) => (await q.query<{ id: string; rt: string | null }>(`SELECT id::text AS id, remittance_type::text AS rt FROM custodial_accounts WHERE kind = 'pi' ORDER BY created_at, id`)).map((r) => ({ unit_id: `${r.id}:${r.rt ?? "A/A"}`, input: { custodial_account_id: r.id, remittance_type: r.rt ?? "A/A" } })) } satisfies NamedSelector,
  /** the T&I custodial accounts (6.4's Form 496A) */
  ti_accounts: { name: "ti_accounts", select: async (q) => (await q.query<{ id: string }>(`SELECT id::text AS id FROM custodial_accounts WHERE kind IN ('ti', 'ti_unapplied') ORDER BY created_at, id`)).map((r) => ({ unit_id: r.id, input: { custodial_account_id: r.id } })) } satisfies NamedSelector,
  /** 7.2: every `arm_schedule` row whose notice window opens today (`first_new_payment_due` − 120 days, or the row's own `notice_window_open`) */
  arm_windows_opening: { name: "arm_windows_opening", select: async (q, w) => (await rowsOf<{ loan_id: string; due: string }>(q, `SELECT loan_id::text AS loan_id, first_new_payment_due::text AS due FROM arm_schedule WHERE status = 'scheduled' AND coalesce(notice_window_open, first_new_payment_due - 120) = $1::date ORDER BY loan_id`, [w.as_of_date])).map((r) => ({ unit_id: r.loan_id, loan_id: r.loan_id, input: { loan_id: r.loan_id, first_new_payment_due: r.due } })) } satisfies NamedSelector,
  /** 10.x: every current `mi_schedules` row whose 80% / 78% / midpoint date is today or has passed */
  mi_dates_reached: { name: "mi_dates_reached", select: async (q, w) => (await rowsOf<{ loan_id: string }>(q, `SELECT DISTINCT loan_id::text AS loan_id FROM mi_schedules WHERE superseded_by IS NULL AND (derived_80_date <= $1::date OR derived_78_date <= $1::date OR derived_midpoint_date <= $1::date) ORDER BY loan_id`, [w.as_of_date])).map((r) => ({ unit_id: r.loan_id, loan_id: r.loan_id, input: { loan_id: r.loan_id } })) } satisfies NamedSelector,
  /** one global unit per period */
  global: { name: "global", select: async (_q, w) => one("global", { period_key: w.period_key, period_end: w.period_end, as_of_date: w.as_of_date }) } satisfies NamedSelector,
  /** 35.5: every lockbox with a batch row (the table lands with 35.5; absent → no unit) */
  lockboxes: { name: "lockboxes", select: async (q, w) => (await rowsOf<{ id: string }>(q, `SELECT DISTINCT lockbox_id::text AS id FROM lockbox_batches ORDER BY id`)).map((r) => ({ unit_id: r.id, input: { lockbox_id: r.id, as_of_date: w.as_of_date } })) } satisfies NamedSelector,
  /** 27.1: every open warehouse advance (absent table → no unit) */
  open_warehouse_advances: { name: "open_warehouse_advances", select: async (q, w) => (await rowsOf<{ id: string }>(q, `SELECT id::text AS id FROM warehouse_advances WHERE repaid_at IS NULL ORDER BY id`)).map((r) => ({ unit_id: r.id, input: { advance_id: r.id, as_of_date: w.as_of_date } })) } satisfies NamedSelector,
  /** 35.9: every loan with an open bankruptcy case — 14.1's `bankruptcy_cases` rows as the entity store holds them (the typed table stays 14.x's record of what its tools wrote; the open statuses are default-35-9.ts OPEN_BK_STATUSES) */
  open_bankruptcy_loans: { name: "open_bankruptcy_loans", select: async (q) => loanUnits((await rowsOf<{ id: string | null }>(q, `SELECT DISTINCT coalesce(loan_id::text, data->>'loan_id') AS id FROM entity_current WHERE kind = 'bankruptcy_cases' AND coalesce(data->>'status', 'open') = ANY($1::text[]) ORDER BY 1`, [OPEN_BK_STATUSES])).filter((r): r is { id: string } => !!r.id)) } satisfies NamedSelector,
  /** 35.9 rule 2's universe: every loan with an open `regx_ei_windows` row (live leg open), an open `cases` row of type lossmit / foreclosure / bankruptcy / reo / claim, or an open `claim_candidates` row (absent tables → no unit) */
  default_case_loans: { name: "default_case_loans", select: async (q) => {
    const ids = new Set<string>();
    for (const [sql, params] of [[`SELECT DISTINCT loan_id::text AS id FROM regx_ei_windows WHERE live_status = 'open'`, []], [`SELECT DISTINCT loan_id::text AS id FROM cases WHERE loan_id IS NOT NULL AND closed_at IS NULL AND case_type = ANY($1::text[]) AND status NOT LIKE 'closed%'`, [OPEN_CASE_TYPES]], [`SELECT DISTINCT loan_id::text AS id FROM claim_candidates WHERE status = ANY($1::text[])`, [OPEN_CANDIDATE_STATUSES]]] as const)
      for (const r of await rowsOf<{ id: string | null }>(q, sql, params)) if (r.id) ids.add(String(r.id));
    return loanUnits([...ids].sort().map((id) => ({ id })));
  } } satisfies NamedSelector,
  /** 35.9 / 15.x: loans with a liquidation or completion milestone on the timeline in the last 120 calendar days, or an open claim candidate (absent tables → no unit) */
  claim_loans: { name: "claim_loans", select: async (q, w) => loanUnits(await rowsOf<{ id: string }>(q, `SELECT DISTINCT loan_id::text AS id FROM (SELECT loan_id FROM case_timelines WHERE event_type = ANY($1::text[]) AND occurred_on >= $2::date UNION SELECT loan_id FROM claim_candidates WHERE status = ANY($3::text[])) u ORDER BY 1`, [CLAIM_MILESTONE_EVENT_TYPES, addDays(w.as_of_date, -120), OPEN_CANDIDATE_STATUSES])) } satisfies NamedSelector,
  /** 35.12: one global unit while a `parallel_runs` row is open (absent table → no unit) */
  open_parallel_runs: { name: "open_parallel_runs", select: async (q, w) => (await rowsOf<{ id: string }>(q, `SELECT id::text AS id FROM parallel_runs WHERE closed_at IS NULL ORDER BY id`)).map((r) => ({ unit_id: r.id, input: { parallel_run_id: r.id, as_of_date: w.as_of_date } })) } satisfies NamedSelector,
} as const;

// ─────────────────────────── the registry at first commit (rule 2's table, plus `month_end` — rule 4)
type DefInput = Omit<CycleDef, "runner" | "receipt_emitted_by" | "depends_on" | "serves_timer" | "escalation_role" | "expected_by_rule"> & Partial<Pick<CycleDef, "runner" | "receipt_emitted_by" | "depends_on" | "serves_timer" | "escalation_role" | "expected_by_rule">>;
export const def = (d: DefInput): CycleDef => ({ runner: null, receipt_emitted_by: "election", depends_on: [], serves_timer: null, escalation_role: "ops_analyst", expected_by_rule: null, ...d });
const onCashiering = (period_of?: "same_day" | "last_day_of_month"): Dependency[] => [{ cycle_code: "cashiering_daily", ...(period_of ? { period_of } : {}) }];

/** The registry rows without their runners — src/domain/operations-runtime/runners.ts attaches the runners that have landed and exports `CYCLES`. */
export const CYCLE_ROWS: readonly CycleDef[] = [
  // 35.5 rule 6: the whole book (no origination_application_id condition), each loan with its configuration row; 35.5's four rows escalate to `officer` (35.5 Integrations: "the four runners registered … with owner_agent: cashiering, escalation_role: officer")
  def({ cycle_code: "cashiering_daily", owner_process: "35.5", owner_agent: "cashiering", unit_scope: "loan", schedule: "daily, every active loan with its loan_servicing_configs row (35.5 rule 6 — the whole book, no origination_application_id condition)", period_grammar: "day", selector: selectors.active_loans_configured, receipt_event: "cashiering.daily.run_completed", serves_timer: "NOTE_6A_LATE_CHARGE_GRACE_GATE", escalation_role: "officer", expected_by_rule: "same_day 23:59 ET" }),
  def({ cycle_code: "delinquency_counters", owner_process: "35.9", owner_agent: "default-collections", unit_scope: "loan", schedule: "daily, every active loan with an unpaid installment (delinquency.ts:37-43)", period_grammar: "day", selector: selectors.delinquent_loans, receipt_event: "delinquency.counters.run_completed", depends_on: onCashiering(), serves_timer: "REGX_1024_39A_LIVE_CONTACT_36", expected_by_rule: "same_day 23:59 ET" }),
  def({ cycle_code: "statements", owner_process: "7.1", owner_agent: "disclosures", unit_scope: "loan", schedule: "per loan, on the cycle's statement_date (7.1: within 4 days of courtesy_period_end, Reg Z §1026.41(b))", period_grammar: "billing_cycle", selector: selectors.statements_due, receipt_event: "statement.cycle.run_completed", depends_on: onCashiering(), serves_timer: "REGZ_1026_41B_STATEMENT_PROMPT_4", expected_by_rule: "+4 calendar_days" }),
  def({ cycle_code: "form_1098", owner_process: "35.4", owner_agent: "disclosures", unit_scope: "loan", schedule: "on tax_year.closed{tax_year}, every reportable loan (≥ $600 interest, 7.1-A); by January 31", period_grammar: "tax_year", event: DEP_EVENTS.TAX_YEAR_CLOSED, selector: selectors.reportable_1098_loans, receipt_event: "tax_form.1098.run_completed", depends_on: [{ event: DEP_EVENTS.TAX_YEAR_CLOSED }], serves_timer: "IRS_6050H_1098_FURNISH_0131", expected_by_rule: "+31 calendar_days" }),
  def({ cycle_code: "escrow_analysis_annual", owner_process: "3.x", owner_agent: "escrow", unit_scope: "loan", schedule: "monthly on the 1st, every escrowed loan whose analysis month is this month; 3.3's statement within 30 days of the computation year end", period_grammar: "month", period_of: "current_month", selector: selectors.escrowed_loans_analysis_month, receipt_event: "escrow.analysis.run_completed", depends_on: onCashiering(), serves_timer: "REGX_1024_17I_ANNUAL_STMT_30", expected_by_rule: "+30 calendar_days" }),
  def({ cycle_code: "lar_daily", owner_process: "5.1", owner_agent: "investor-reporting", unit_scope: "period", schedule: "every business day (business_days_fannie_et) by 20:00 ET, the day's investor_events not yet submitted, in sequence order (batch.ts:1-25)", period_grammar: "day", calendar: "business_days_fannie_et", selector: selectors.period, receipt_event: "investor.lar.run_completed", depends_on: onCashiering(), serves_timer: "FNMA_C4301_LAR_NONREMOVAL_NEXTBD_2000", escalation_role: "fnma_portal_operator", expected_by_rule: "same_day 20:00 ET" }),
  // amendment order 11: depends on `lar_daily` for BD1 of the following month (the period's last non-removal LARs), on business_days_fannie_et
  def({ cycle_code: "investor_period_close", owner_process: "35.4", owner_agent: "investor-reporting", unit_scope: "period", schedule: "BD2 17:00 ET each month for the prior month — the removal close; the period's non-removal LARs and corrections closed at BD1 20:00 ET (IRM 2-01)", period_grammar: "month", period_of: "prior_month", calendar: "business_days_fannie_et", selector: selectors.period, receipt_event: "investor.period_close.run_completed", depends_on: [{ cycle_code: "lar_daily", period_of: "bd1_following_month" }], serves_timer: "FNMA_IRM_PERIOD_CLOSE_BD2_1700", expected_by_rule: "BD2 17:00 ET" }),
  def({ cycle_code: "remittance", owner_process: "5.2", owner_agent: "investor-reporting", unit_scope: "account", schedule: "A/A: BD1 16:00 ET (F-1-20: prior-month collections received after the 4 p.m. ET cut-off); draft notices BD3 (F-1-20; the 12:00 ET is 5.2's); S/S per F-1-20 (portfolio: 18th calendar day; MBS: per remittance cycle)", period_grammar: "month", period_of: "prior_month", calendar: "business_days_fannie_et", selector: selectors.pi_accounts_by_remittance, receipt_event: "investor.remittance.run_completed", depends_on: [{ cycle_code: "investor_period_close" }], serves_timer: "FNMA_F120_AA_BD1_PRIOR_MONTH", escalation_role: "officer", expected_by_rule: "BD1 16:00 ET" }),
  def({ cycle_code: "custodial_recon_daily", owner_process: "6.3", owner_agent: "custodial-recon", unit_scope: "account", schedule: "daily, every custodial account (6.3's three-way)", period_grammar: "day", selector: selectors.custodial_accounts, receipt_event: "custodial.recon.run_completed", depends_on: onCashiering(), serves_timer: "FNMA_C1101_DEPOSIT_CUSTODIAL_24H", expected_by_rule: "same_day 23:59 ET" }),
  def({ cycle_code: "form_496_monthly", owner_process: "35.4", owner_agent: "custodial-recon", unit_scope: "account", schedule: "after both closes; drafted by BD10 (6.3 policy), completed within 45 days (6.3's reading of the Form 496 instructions; Servicing Guide F-1-03 requires the monthly reconciliation and its retention)", period_grammar: "month", period_of: "prior_month", calendar: "business_days_fannie_et", selector: selectors.pi_accounts_by_remittance, receipt_event: "custodial.form496.run_completed", depends_on: [{ event: DEP_EVENTS.LEDGER_PERIOD_CLOSED }, { event: DEP_EVENTS.INVESTOR_PERIOD_CLOSED }], serves_timer: "FNMA_F496_PI_RECON_45", escalation_role: "officer", expected_by_rule: "BD10 23:59 ET" }),
  // the table's unit scope is `period (month)`: the unit is the period itself (`unit_id = period_key`, the decision's subject_id — T16)
  def({ cycle_code: "metro2_monthly", owner_process: "8.1", owner_agent: "credit-reporting", unit_scope: "period", schedule: "00:05 ET on the 1st, as of the last day of the prior month; built by 12:00 ET", period_grammar: "month", period_of: "prior_month", selector: selectors.period, receipt_event: "credit.cycle.run_completed", depends_on: onCashiering("last_day_of_month"), serves_timer: "FNMA_C41_01_METRO2_SNAPSHOT_EOM", escalation_role: "officer", expected_by_rule: "+1 calendar_days" }),
  def({ cycle_code: "arm_changes", owner_process: "7.2", owner_agent: "disclosures", unit_scope: "loan", schedule: "daily: every arm_schedule row whose notice window opens today (first_new_payment_due − 120 days; mail by − 60)", period_grammar: "day", selector: selectors.arm_windows_opening, receipt_event: "arm.adjustment.run_completed", serves_timer: "REGZ_1026_20C_ADJ_NOTICE_60", expected_by_rule: "same_day 23:59 ET" }),
  def({ cycle_code: "mi_changes", owner_process: "10.x", owner_agent: "pmi", unit_scope: "loan", schedule: "daily: every mi_schedules row whose 80% / 78% / midpoint date is today or passed unhandled", period_grammar: "day", selector: selectors.mi_dates_reached, receipt_event: "mi.schedule.run_completed", depends_on: onCashiering(), serves_timer: "HPA_4902C_MIDPOINT_TERMINATE_0", expected_by_rule: "same_day 23:59 ET" }),
  def({ cycle_code: "document_integrity", owner_process: "35.2", owner_agent: "security-records", unit_scope: "global", schedule: "daily 02:30 ET", period_grammar: "day", selector: selectors.global, receipt_event: "document.integrity.run_completed", receipt_emitted_by: "owner", serves_timer: "SM_DOC_INTEGRITY_DAILY", expected_by_rule: "same_day 23:59 ET" }),
  def({ cycle_code: "projection_verify", owner_process: "35.1", owner_agent: "security-records", unit_scope: "global", schedule: "daily 06:00 ET", period_grammar: "day", selector: selectors.global, receipt_event: "projection.run_completed", receipt_emitted_by: "owner", serves_timer: "SM_PROJECTION_LAG_DAILY", expected_by_rule: "same_day 23:59 ET" }),
  def({ cycle_code: "refi_daily", owner_process: "20.1", owner_agent: "intake", unit_scope: "global", schedule: "as its section states (already in the sweep body, app.ts:254-271): once per calendar day at/after 06:30 ET", period_grammar: "day", selector: selectors.global, receipt_event: "refi.trigger.run_completed", serves_timer: "SM_REFI_TRIGGER_DAILY", expected_by_rule: "same_day 23:59 ET" }),
  def({ cycle_code: "partner_book_review", owner_process: "33.2", owner_agent: "refi-analyst", unit_scope: "global", schedule: "as its section states (already in the sweep body): once per day at/after 07:00 ET", period_grammar: "day", selector: selectors.global, receipt_event: "partner_book.review.run_completed", depends_on: [{ cycle_code: "refi_daily" }], serves_timer: "SM_PARTNER_BOOK_REVIEW_DAILY", expected_by_rule: "same_day 23:59 ET" }),
  def({ cycle_code: "partner_book_readiness", owner_process: "33.3", owner_agent: "refi-readiness", unit_scope: "global", schedule: "as its section states (already in the sweep body): once per day at/after 07:15 ET", period_grammar: "day", selector: selectors.global, receipt_event: "partner_book.readiness.run_completed", depends_on: [{ cycle_code: "partner_book_review" }], serves_timer: "SM_PARTNER_BOOK_READINESS_DAILY", expected_by_rule: "same_day 23:59 ET" }),
  def({ cycle_code: "partner_book_daily_report", owner_process: "34.3", owner_agent: "portfolio", unit_scope: "global", schedule: "as its section states (already in the sweep body): the daily report per partner-day once 33.3's receipt exists", period_grammar: "day", selector: selectors.global, receipt_event: "partner_book.daily_report.run_completed", depends_on: [{ cycle_code: "partner_book_readiness" }], serves_timer: "SM_PARTNER_BOOK_DAILY_REPORT", expected_by_rule: "same_day 23:59 ET" }),
  def({ cycle_code: "ledger_period_close", owner_process: "35.4", owner_agent: "custodial-recon", unit_scope: "account", schedule: "month-end: every custodial account, after custodial_recon_daily ran for period_end", period_grammar: "month", period_of: "prior_month", selector: selectors.custodial_accounts, receipt_event: "custodial.ledger_close.run_completed", depends_on: [{ cycle_code: "custodial_recon_daily", period_of: "last_day_of_month" }], serves_timer: "SM_CLOSE_STEP_STALLED_2BD", expected_by_rule: "+1 calendar_days" }),
  def({ cycle_code: "form_496a_monthly", owner_process: "35.4", owner_agent: "custodial-recon", unit_scope: "account", schedule: "after ledger_period_close; completed within 45 days after month-end (6.4's reading of the Form 496A instructions; Servicing Guide F-1-03)", period_grammar: "month", period_of: "prior_month", selector: selectors.ti_accounts, receipt_event: "custodial.form496a.run_completed", depends_on: [{ event: DEP_EVENTS.LEDGER_PERIOD_CLOSED }], serves_timer: "FNMA_F496A_TI_RECON_45", expected_by_rule: "+45 calendar_days" }),
  def({ cycle_code: "star_monthly", owner_process: "35.4", owner_agent: "qc-audit", unit_scope: "period", schedule: "BD5 (business_days_fannie_et) after the period close", period_grammar: "month", period_of: "prior_month", calendar: "business_days_fannie_et", selector: selectors.period, receipt_event: "star.metrics.run_completed", depends_on: [{ event: DEP_EVENTS.INVESTOR_PERIOD_CLOSED }], serves_timer: "SM_STAR_COMPUTE_MONTHLY_BD5", expected_by_rule: "BD5 23:59 ET" }),
  // 35.5 rules 7–8: the three file cycles' tools emit their own receipt literal (`lockbox.ingest.run_completed`, `ach.file_build.run_completed`, `ach.returns_ingest.run_completed` — src/domain/operations-runtime/lockbox.ts, ach.ts), so the election appends `cycle.run.completed` only (rule 2)
  def({ cycle_code: "lockbox_ingest", owner_process: "35.5", owner_agent: "cashiering", unit_scope: "account", schedule: "per lockbox per business_days_servicer; the file by 10:00 in lockbox_batches.cutoff_tz", period_grammar: "day", calendar: "business_days_servicer", selector: selectors.lockboxes, receipt_event: "lockbox.ingest.run_completed", receipt_emitted_by: "owner", serves_timer: "SM_LOCKBOX_FILE_EXPECTED_1BD", escalation_role: "officer", expected_by_rule: "10:00 ET" }),
  def({ cycle_code: "ach_file_build", owner_process: "35.5", owner_agent: "cashiering", unit_scope: "global", schedule: "every banking day (business_days_federal) by 14:00 ET", period_grammar: "day", calendar: "business_days_federal", selector: selectors.global, receipt_event: "ach.file_build.run_completed", receipt_emitted_by: "owner", depends_on: onCashiering(), serves_timer: "SM_ACH_FILE_BUILD_1BD", escalation_role: "officer", expected_by_rule: "14:00 ET" }),
  def({ cycle_code: "ach_returns_ingest", owner_process: "35.5", owner_agent: "cashiering", unit_scope: "global", schedule: "every banking day 08:00 ET", period_grammar: "day", calendar: "business_days_federal", selector: selectors.global, receipt_event: "ach.returns_ingest.run_completed", receipt_emitted_by: "owner", serves_timer: "SM_ACH_RETURN_ACTIONED_1BD", escalation_role: "officer", expected_by_rule: "08:00 ET" }),
  def({ cycle_code: "closing_orchestration_daily", owner_process: "35.6", owner_agent: "disclosures", unit_scope: "global", schedule: "daily 06:00 ET", period_grammar: "day", selector: selectors.global, receipt_event: "orchestration.daily.run_completed", depends_on: onCashiering(), serves_timer: "SM_ORCH_OPEN_BOOK_DAILY", expected_by_rule: "same_day 23:59 ET" }),
  def({ cycle_code: "warehouse_daily_accrual", owner_process: "35.6", owner_agent: "warehouse", unit_scope: "account", schedule: "daily 00:30 ET, every open warehouse_advances row", period_grammar: "day", selector: selectors.open_warehouse_advances, receipt_event: "warehouse.accrual.run_completed", serves_timer: "SM_WH_DAILY_ACCRUAL", expected_by_rule: "same_day 23:59 ET" }),
  def({ cycle_code: "warehouse_borrowing_base", owner_process: "35.6", owner_agent: "warehouse", unit_scope: "global", schedule: "07:00 ET each business_days_servicer", period_grammar: "day", calendar: "business_days_servicer", selector: selectors.global, receipt_event: "warehouse.borrowing_base.run_completed", depends_on: [{ cycle_code: "warehouse_daily_accrual" }], serves_timer: "SM_WH_BORROWING_BASE_DAILY", expected_by_rule: "07:00 ET" }),
  def({ cycle_code: "roles.queue_scan", owner_process: "35.7", owner_agent: "security-records", unit_scope: "global", schedule: "daily 06:30 ET", period_grammar: "day", selector: selectors.global, receipt_event: "role.queue.scan_completed", serves_timer: "SM_HANDOVER_BOARD_DAILY", expected_by_rule: "same_day 23:59 ET" }),
  def({ cycle_code: "work_log_recon", owner_process: "35.8", owner_agent: "case", unit_scope: "global", schedule: "once per calendar day", period_grammar: "day", selector: selectors.global, receipt_event: "work.log.recon.run_completed", serves_timer: "SM_WORK_LOG_RECON_DAILY", expected_by_rule: "same_day 23:59 ET" }),
  // 35.9 Trigger & frequency: the four case cycles are planned by 35.9's daily pass at/after 05:30 ET in this order, each after the previous one's receipt (`plan_mode: owner` — rule 2's universe is read after the counters opened the day's windows); `default_case_daily`'s receipt literal is that pass's own, written with the `default_case_daily_runs` row (`receipt_emitted_by: owner`), so the election appends `cycle.run.completed` only
  def({ cycle_code: "bk_docket_sync_daily", owner_process: "35.9", owner_agent: "bankruptcy-ops", unit_scope: "loan", schedule: "daily at/after 05:30 ET (35.9's daily pass plans it), every open bankruptcy_cases row, before default_case_daily", period_grammar: "day", selector: selectors.open_bankruptcy_loans, receipt_event: "bk_docket_sync.run_completed", depends_on: [{ cycle_code: "delinquency_counters" }], serves_timer: "SM_DOCKET_REACTION_1BD", expected_by_rule: "same_day 23:59 ET", plan_mode: "owner" }),
  def({ cycle_code: "dra_import_daily", owner_process: "35.9", owner_agent: "foreclosure-ops", unit_scope: "global", schedule: "daily at/after 05:30 ET (35.9's daily pass plans it), 13.6 dra.snapshot.import from the law-firm port", period_grammar: "day", selector: selectors.global, receipt_event: "dra_import.run_completed", serves_timer: "SM_DRA_RECONCILE_DAILY", expected_by_rule: "same_day 23:59 ET", plan_mode: "owner" }),
  def({ cycle_code: "default_case_daily", owner_process: "35.9", owner_agent: "foreclosure-ops", unit_scope: "loan", schedule: "daily 05:30 ET (35.9's daily pass plans it after the counters, the docket sync and the DRA import), every loan with an open regx_ei_windows, cases or claim_candidates row; expected_by 06:30 ET", period_grammar: "day", selector: selectors.default_case_loans, receipt_event: "default_case.daily.run_completed", receipt_emitted_by: "owner", depends_on: [{ cycle_code: "delinquency_counters" }, { cycle_code: "bk_docket_sync_daily" }, { cycle_code: "dra_import_daily" }], serves_timer: "SM_DEFAULT_CASE_DAILY", expected_by_rule: "06:30 ET", plan_mode: "owner" }),
  def({ cycle_code: "claims_sweep_daily", owner_process: "35.9", owner_agent: "claims-reo", unit_scope: "loan", schedule: "daily at/after 05:30 ET (35.9's daily pass plans it after default_case_daily), loans with a liquidation milestone in the last 120 calendar days or an open candidate", period_grammar: "day", selector: selectors.claim_loans, receipt_event: "claims_sweep.run_completed", depends_on: [{ cycle_code: "default_case_daily" }], serves_timer: "SM_CLAIM_PACKAGE_5BD", expected_by_rule: "same_day 23:59 ET", plan_mode: "owner" }),
  def({ cycle_code: "posture.check", owner_process: "35.12", owner_agent: "compliance-sentinel", unit_scope: "global", schedule: "daily 05:30 ET and on every manifest", period_grammar: "day", selector: selectors.global, receipt_event: "posture.check.run_completed", serves_timer: "SM_PROD_POSTURE_DAILY", expected_by_rule: "same_day 23:59 ET" }),
  def({ cycle_code: "data.scan", owner_process: "35.12", owner_agent: "compliance-sentinel", unit_scope: "global", schedule: "daily 05:45 ET on nonprod", period_grammar: "day", selector: selectors.global, receipt_event: "posture.data_scan.run_completed", expected_by_rule: "same_day 23:59 ET" }),
  def({ cycle_code: "parallel_run.reconcile", owner_process: "35.12", owner_agent: "compliance-sentinel", unit_scope: "global", schedule: "daily 21:00 ET while a parallel_runs row is open", period_grammar: "day", selector: selectors.open_parallel_runs, receipt_event: "parallel_run.day.reconciled", receipt_emitted_by: "owner", depends_on: onCashiering(), serves_timer: "SM_PROD_PARALLEL_RUN_DAILY", expected_by_rule: "21:00 ET" }),
  // rule 4: the planner is the month's clock — one global unit per month whose command appends `ledger.month.ended{period_key, period_end}` (35.4's SM_CLOSE_PERIOD_OPEN_BD1 arms on it; T15)
  def({ cycle_code: "month_end", owner_process: "35.3", owner_agent: "ops-steward", unit_scope: "global", schedule: "the first planner pass whose as_of civil date (America/New_York) is in a new month, for the month that ended", period_grammar: "month", period_of: "prior_month", selector: selectors.global, receipt_event: "ledger.month_end.run_completed", serves_timer: "SM_CLOSE_PERIOD_OPEN_BD1", expected_by_rule: "+1 calendar_days" }),
];

export const cycleByCode = (defs: readonly CycleDef[], code: string): CycleDef | undefined => defs.find((d) => d.cycle_code === code);
/** `period_end` of a period key (a day, a month or a tax year); the key itself when it is a date. */
export function periodEndOf(def: Pick<CycleDef, "period_grammar">, periodKey: string): PlainDate {
  if (/^\d{4}-\d{2}-\d{2}$/.test(periodKey)) return D(periodKey);
  if (/^\d{4}-\d{2}$/.test(periodKey)) return endOfMonth(D(`${periodKey}-01`));
  if (/^\d{4}$/.test(periodKey)) return D(`${periodKey}-12-31`);
  return def.period_grammar === "month" ? endOfMonth(D(`${periodKey.slice(0, 7)}-01`)) : D(periodKey.slice(0, 10));
}
