/**
 * §35.3 rule 2 — "The registry is code; the table is its projection." `CYCLES` is the export the planner upserts into
 * `cycle_registry` (`registry_version` = CYCLES_VERSION); every def names its selector (a SQL read over typed rows —
 * never `entity_records`) and its runner (src/domain/operations-runtime/cycles/runners.ts; a def whose runner has not
 * landed is planned and dies `runner_missing` on its first attempt — the gap is visible, not silent). The event literals
 * of the process live here so tools/lint-emission.ts counts them (Outputs: "all string literals in `cycles.ts` / `service.ts`").
 *
 * A cycle is added by adding a def; a def is retired by removing it (the table row goes `retired`, its runs stay).
 */
import type { Queryable } from "../../../infra/db/client.ts";
import { plainDate as D, addDays, addMonths, endOfMonth, parts, ymd, type PlainDate } from "../../../kernel/calendar/date.ts";

export const CYCLES_VERSION = "cycles.v1";
export const PROMPT_VERSION = "35.3-v1";
/** The planner's own session-level lock (rule 1) — distinct from 35.1's sweep lease (35_001): the demo advance runs the planner from a `serve` instance that holds no lease. */
export const PLANNER_LOCK_KEY = 35_003;
export const OPS_STEWARD = { kind: "agent", id: "ops-steward" } as const;
/** Worked example A (one statement unit through the engine, to the cent): UPB $248,310.55 at 6.500%, P&I $1,612.34, escrow $432.78, late charge 5% of P&I = $80.62, interest 248,310.55 × 0.065 ÷ 12 = 1,345.0155 → $1,345.02, principal $267.32, amount due $2,125.74 — every figure asserted by T9 against the unit's own derivation. */
export const WORKED_EXAMPLE_A = { upb_cents: 24_831_055n, pi_cents: 161_234n, escrow_cents: 43_278n, late_charge_cents: 8_062n, interest_cents: 134_502n, principal_cents: 26_732n, amount_due_cents: 212_574n, note_rate_bps: 65_000 } as const;

/** Every event this process emits (Inputs and triggers: "Events this process emits"), one literal each. */
export const EV = {
  plan_completed: "cycles.plan.run_completed",
  plan_skipped: "cycles.plan.skipped",
  run_opened: "cycle.run.opened",
  run_completed: "cycle.run.completed",
  run_cancelled: "cycle.run.cancelled",
  unit_claimed: "job.unit.claimed",
  unit_done: "job.unit.done",
  unit_failed: "job.unit.failed",
  unit_dead: "job.unit.dead",
  unit_resolved: "job.unit.resolved",
  lease_expired: "job.lease.expired",
  month_ended: "ledger.month.ended",
} as const;

/** The events the planner reacts to (dependencies): 6.3's period close and 5.1/5.2's investor close (open question 2: the emitted literal, not the spec's `fnma.reporting_period.closed`), 7.1's tax year close, 3.x's analysis approval. */
export const DEP_EVENTS = { ledger_period_closed: "ledger.period.closed", investor_period_closed: "investor_reporting_periods.closed", tax_year_closed: "tax_year.closed", escrow_analysis_approved: "escrow.analysis.approved", statement_cycle_opened: "statement.cycle.opened" } as const;

export type UnitScope = "loan" | "account" | "period" | "global";
export type PeriodGrammar = "day" | "month" | "tax_year" | "billing_cycle" | "event";
export type RunnerKind = "unit" | "pass";

/** The window the planner derives from the planned instant (rule 3: `as_of`, never `clock.now()` read twice). */
export interface CycleWindow { readonly as_of: string; readonly as_of_date: PlainDate; }
/** One planned unit: ids and dates only (rule 8 — the job's `input` never carries `state`, `custodial`, a `*_cents` field or `changes`). */
export interface Unit { readonly period_key: string; readonly unit_id: string; readonly loan_id?: string | null; readonly application_id?: string | null; readonly input?: Record<string, unknown>; readonly priority?: number; }
/** A dependency: another cycle's receipt for a period (`same` period key, the window's `as_of_date`, or the period's last day) or an event whose `key` field names the period (the first `:`-segment of the unit's period key). */
export type Dependency = { readonly cycle_code: string; readonly period?: "same" | "as_of_date" | "period_end" } | { readonly event: string; readonly key: string };
export type Selector = (db: Queryable, w: CycleWindow) => Promise<Unit[]>;

export interface CycleDef {
  readonly cycle_code: string;
  readonly owner_process: string;
  readonly owner_agent: string;
  readonly unit_scope: UnitScope;
  readonly schedule: string;
  readonly period_grammar: PeriodGrammar;
  readonly selector: string;
  readonly runner: string;
  readonly receipt_event: string;
  readonly depends_on: readonly Dependency[];
  readonly serves_timer: string | null;
  readonly escalation_role: string;
  /** How `expected_by` is derived: `same_day HH:MM ET`, `BDn HH:MM ET` (Fannie business days after the period end), `+n calendar_days`. */
  readonly expected_by: string;
  /** The period keys due in a window even with no unit (a daily cycle looks every day). Default by grammar: day → the date; month → the prior month; the rest → none (the units carry their periods). */
  readonly periods?: (w: CycleWindow) => string[];
  /** The wall time of day (ET) from which the day's period is due; before it the planner leaves the day unplanned. */
  readonly not_before?: string;
}

// ---------------------------------------------------------------- periods
export const monthKey = (d: PlainDate): string => d.slice(0, 7);
export const priorMonthKey = (d: PlainDate): string => monthKey(addMonths(ymd(parts(d).y, parts(d).m, 1), -1));
export const monthEnd = (key: string): PlainDate => endOfMonth(D(`${key}-01`));
export function defaultPeriods(def: CycleDef, w: CycleWindow): string[] {
  if (def.periods) return def.periods(w);
  if (def.period_grammar === "day") return [w.as_of_date];
  if (def.period_grammar === "month") return [priorMonthKey(w.as_of_date)];
  return [];
}
/** The period's last civil day (a day key is its own; a month key its last day; a composite key's first segment decides). */
export function periodEnd(key: string): PlainDate {
  const head = key.split(":")[0]!;
  if (/^\d{4}-\d{2}-\d{2}$/.test(head)) return D(head);
  if (/^\d{4}-\d{2}$/.test(head)) return monthEnd(head);
  if (/^\d{4}$/.test(head)) return D(`${head}-12-31`);
  return D(head.slice(0, 10));
}

// ---------------------------------------------------------------- selectors (typed rows only)
const ACTIVE_LOANS = `SELECT l.id FROM loans l WHERE l.status = 'active' AND l.boarded_at IS NOT NULL ORDER BY l.boarded_at, l.id`;
const hasTable = async (db: Queryable, name: string): Promise<boolean> => (await db.query<{ ok: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS ok`, [name]))[0]?.ok === true;

export const SELECTORS: Record<string, Selector> = {
  /** a def with no units (the month_end clock): the run is opened and completed in the same pass with a receipt of zeros */
  none: async () => [],
  /** every active boarded loan, one unit per loan per day */
  active_loans_daily: async (db, w) => (await db.query<{ id: string }>(ACTIVE_LOANS)).map((r) => ({ period_key: w.as_of_date, unit_id: r.id, loan_id: r.id })),
  /** every active loan with an unpaid `loan_installments` row due before the loan-local day (src/runtime/delinquency.ts:37-43) */
  delinquent_loans_daily: async (db, w) => (await db.query<{ id: string }>(`SELECT DISTINCT l.id FROM loans l JOIN loan_installments i ON i.loan_id = l.id AND i.status = 'due' AND i.due_date < $1::date WHERE l.status = 'active' ORDER BY l.id`, [w.as_of_date])).map((r) => ({ period_key: w.as_of_date, unit_id: r.id, loan_id: r.id })),
  /** 7.1: the loans whose cycle's courtesy period closed yesterday — statement_date = today, cycle_due_date = the installment (the period key), Reg Z §1026.41(b) "within 4 days of the courtesy period's close" */
  statements_due: async (db, w) => {
    const rows = await db.query<{ id: string; first_payment_date: string; grace: number | null }>(`SELECT l.id, l.first_payment_date::text AS first_payment_date, t.late_charge_grace_days AS grace FROM loans l JOIN LATERAL (SELECT late_charge_grace_days FROM loan_terms WHERE loan_id = l.id ORDER BY effective_from DESC, created_at DESC LIMIT 1) t ON true WHERE l.status = 'active' AND l.boarded_at IS NOT NULL ORDER BY l.boarded_at, l.id`);
    const out: Unit[] = [];
    for (const r of rows) {
      const grace = r.grace ?? 15; const courtesyEnd = addDays(w.as_of_date, -1); const due = addDays(courtesyEnd, -grace);
      const first = D(r.first_payment_date);
      if (due < first || due.slice(8, 10) !== first.slice(8, 10)) continue;
      out.push({ period_key: due, unit_id: r.id, loan_id: r.id, input: { cycle_due_date: due, statement_date: w.as_of_date, courtesy_period_end: courtesyEnd } });
    }
    return out;
  },
  /** 7.1-A: every `tax_year.closed{tax_year}` on the log → every active loan boarded in or before that year */
  form_1098_loans: async (db) => {
    const years = await db.query<{ y: string }>(`SELECT DISTINCT payload->>'tax_year' AS y FROM loan_events WHERE type = '${DEP_EVENTS.tax_year_closed}' AND payload->>'tax_year' ~ '^\\d{4}$' ORDER BY 1`);
    const out: Unit[] = [];
    for (const { y } of years) for (const l of await db.query<{ id: string }>(`SELECT id FROM loans WHERE status IN ('active', 'paid_off') AND boarded_at IS NOT NULL AND instrument_date <= $1::date ORDER BY id`, [`${y}-12-31`])) out.push({ period_key: y, unit_id: l.id, loan_id: l.id, input: { tax_year: Number(y) } });
    return out;
  },
  /** 3.x: escrowed loans whose approved analysis names this month as the statement month (`escrow.analysis.approved{loan_id}` this month) */
  escrow_analysis_month: async (db, w) => (await db.query<{ id: string }>(`SELECT DISTINCT loan_id AS id FROM loan_events WHERE type = '${DEP_EVENTS.escrow_analysis_approved}' AND loan_id IS NOT NULL AND to_char(occurred_at AT TIME ZONE 'America/New_York', 'YYYY-MM') = $1 ORDER BY 1`, [monthKey(w.as_of_date)])).map((r) => ({ period_key: monthKey(w.as_of_date), unit_id: r.id, loan_id: r.id })),
  /** 5.1: the day's investor events not yet submitted (typed rows) — the day is the unit */
  lar_day: async (db, w) => ((await hasTable(db, "investor_events")) && (await db.query<{ c: string }>(`SELECT count(*)::text AS c FROM investor_events WHERE coalesce(submitted_at, NULL) IS NULL`)).at(0)?.c !== "0" ? [{ period_key: w.as_of_date, unit_id: w.as_of_date }] : []),
  /** one unit per period (the period is the unit) */
  period_global: async (_db, w) => [{ period_key: w.as_of_date, unit_id: "global" }],
  month_global: async (_db, w) => [{ period_key: priorMonthKey(w.as_of_date), unit_id: "global" }],
  /** 5.2: each P&I custodial account × remittance type for the prior month */
  remittance_accounts: async (db, w) => (await db.query<{ id: string; rt: string | null }>(`SELECT id, remittance_type::text AS rt FROM custodial_accounts WHERE kind = 'pi' AND status = 'active' ORDER BY created_at, id`)).map((r) => ({ period_key: `${priorMonthKey(w.as_of_date)}:${r.rt ?? "A/A"}`, unit_id: r.id, input: { custodial_account_id: r.id, remittance_type: r.rt ?? "A/A" } })),
  /** 6.3: every active custodial account, daily */
  custodial_accounts_daily: async (db, w) => (await db.query<{ id: string; kind: string }>(`SELECT id, kind::text AS kind FROM custodial_accounts WHERE status = 'active' ORDER BY created_at, id`)).map((r) => ({ period_key: w.as_of_date, unit_id: r.id, input: { custodial_account_id: r.id, account_kind: r.kind } })),
  /** 6.3 Form 496: every month 6.3 closed (`ledger.period.closed{period_key}`) × every P&I account × remittance type */
  form_496_accounts: async (db) => {
    const periods = await db.query<{ p: string }>(`SELECT DISTINCT payload->>'period_key' AS p FROM loan_events WHERE type = '${DEP_EVENTS.ledger_period_closed}' AND payload->>'period_key' ~ '^\\d{4}-\\d{2}$' ORDER BY 1`);
    const accounts = await db.query<{ id: string; rt: string | null }>(`SELECT id, remittance_type::text AS rt FROM custodial_accounts WHERE kind = 'pi' AND status = 'active' ORDER BY created_at, id`);
    return periods.flatMap(({ p }) => accounts.map((a) => ({ period_key: `${p}:${a.id}:${a.rt ?? "A/A"}`, unit_id: `${a.id}:${a.rt ?? "A/A"}`, input: { custodial_account_id: a.id, remittance_type: a.rt ?? "A/A", period: p } })));
  },
  /** 6.4 Form 496A: every closed month × every T&I account */
  form_496a_accounts: async (db) => {
    const periods = await db.query<{ p: string }>(`SELECT DISTINCT payload->>'period_key' AS p FROM loan_events WHERE type = '${DEP_EVENTS.ledger_period_closed}' AND payload->>'period_key' ~ '^\\d{4}-\\d{2}$' ORDER BY 1`);
    const accounts = await db.query<{ id: string }>(`SELECT id FROM custodial_accounts WHERE kind = 'ti' AND status = 'active' ORDER BY created_at, id`);
    return periods.flatMap(({ p }) => accounts.map((a) => ({ period_key: `${p}:${a.id}`, unit_id: a.id, input: { custodial_account_id: a.id, period: p } })));
  },
  /** 35.4 / 6.3 month-end close: every custodial account for the prior month, after its daily recon ran for the period end */
  ledger_close_accounts: async (db, w) => (await db.query<{ id: string; kind: string; rt: string | null }>(`SELECT id, kind::text AS kind, remittance_type::text AS rt FROM custodial_accounts WHERE status = 'active' ORDER BY created_at, id`)).map((r) => ({ period_key: `${priorMonthKey(w.as_of_date)}:${r.id}`, unit_id: r.id, input: { custodial_account_id: r.id, account_kind: r.kind, remittance_type: r.rt ?? "A/A", period_end: monthEnd(priorMonthKey(w.as_of_date)) } })),
  /** 7.2: every `arm_schedule` row whose notice window opens today (first_new_payment_due − 120 days) */
  arm_windows_today: async (db, w) => (await hasTable(db, "arm_schedule")) ? (await db.query<{ loan_id: string; d: string }>(`SELECT loan_id, first_new_payment_due::text AS d FROM arm_schedule WHERE first_new_payment_due - 120 = $1::date ORDER BY loan_id`, [w.as_of_date]).catch(() => [])).map((r) => ({ period_key: r.d, unit_id: r.loan_id, loan_id: r.loan_id, input: { first_new_payment_due: r.d } })) : [],
  /** 10.x: every `mi_schedules` row whose 80% / 78% / midpoint date is today or passed unhandled */
  mi_dates_today: async (db, w) => (await hasTable(db, "mi_schedules")) ? (await db.query<{ loan_id: string }>(`SELECT DISTINCT loan_id FROM mi_schedules WHERE coalesce(handled_at, NULL) IS NULL AND least(coalesce(ltv_80_date, 'infinity'::date), coalesce(ltv_78_date, 'infinity'::date), coalesce(midpoint_date, 'infinity'::date)) <= $1::date ORDER BY loan_id`, [w.as_of_date]).catch(() => [])).map((r) => ({ period_key: w.as_of_date, unit_id: r.loan_id, loan_id: r.loan_id })) : [],
  /** 35.5: per lockbox per servicer business day (`lockbox_batches` is 35.5's) */
  lockboxes_daily: async (db, w) => (await hasTable(db, "lockboxes")) ? (await db.query<{ id: string }>(`SELECT id FROM lockboxes WHERE status = 'active' ORDER BY id`).catch(() => [])).map((r) => ({ period_key: `${w.as_of_date}:${r.id}`, unit_id: r.id, input: { lockbox_id: r.id } })) : [],
  /** 27.1: every open warehouse advance */
  open_advances_daily: async (db, w) => (await hasTable(db, "warehouse_advances")) ? (await db.query<{ id: string }>(`SELECT id FROM warehouse_advances WHERE status = 'open' ORDER BY id`).catch(() => [])).map((r) => ({ period_key: w.as_of_date, unit_id: r.id, input: { advance_id: r.id } })) : [],
  /** 14.x: every open bankruptcy case's loan */
  open_bk_loans_daily: async (db, w) => (await hasTable(db, "bankruptcy_cases")) ? (await db.query<{ loan_id: string }>(`SELECT DISTINCT loan_id FROM bankruptcy_cases WHERE status NOT IN ('closed', 'dismissed', 'discharged') AND loan_id IS NOT NULL ORDER BY loan_id`).catch(() => [])).map((r) => ({ period_key: w.as_of_date, unit_id: r.loan_id, loan_id: r.loan_id })) : [],
  /** 35.9: every loan with an open Reg X EI window, case or claim candidate */
  default_case_loans_daily: async (db, w) => {
    const out = new Set<string>();
    for (const [t, col] of [["regx_ei_windows", "loan_id"], ["cases", "loan_id"], ["claim_candidates", "loan_id"]] as const) if (await hasTable(db, t)) for (const r of await db.query<{ id: string }>(`SELECT DISTINCT ${col} AS id FROM ${t} WHERE ${col} IS NOT NULL AND coalesce(status::text, 'open') NOT IN ('closed', 'completed', 'withdrawn', 'denied', 'paid')`).catch(() => [])) out.add(r.id);
    return [...out].sort().map((id) => ({ period_key: w.as_of_date, unit_id: id, loan_id: id }));
  },
  /** 15.x: loans with a liquidation milestone in the last 120 calendar days or an open candidate */
  claims_loans_daily: async (db, w) => (await db.query<{ id: string }>(`SELECT DISTINCT loan_id AS id FROM loan_events WHERE loan_id IS NOT NULL AND type IN ('foreclosure.sale.completed', 'reo.acquired', 'deed_in_lieu.accepted', 'short_sale.closed', 'claim.candidate.opened') AND occurred_at >= ($1::date - 120)::timestamptz ORDER BY 1`, [w.as_of_date])).map((r) => ({ period_key: w.as_of_date, unit_id: r.id, loan_id: r.id })),
  /** 35.12: the day's parallel-run reconciliation while a `parallel_runs` row is open */
  open_parallel_runs_daily: async (db, w) => (await hasTable(db, "parallel_runs")) ? (await db.query<{ id: string }>(`SELECT id FROM parallel_runs WHERE status = 'open' ORDER BY id`).catch(() => [])).map((r) => ({ period_key: w.as_of_date, unit_id: r.id, input: { parallel_run_id: r.id } })) : [],
};

// ---------------------------------------------------------------- the registry (rule 2's table, at first commit)
const dep = (cycle_code: string, period: "same" | "as_of_date" | "period_end" = "same"): Dependency => ({ cycle_code, period });
const evt = (event: string, key: string): Dependency => ({ event, key });
const daily = (o: Omit<CycleDef, "period_grammar" | "unit_scope"> & { unit_scope?: UnitScope }): CycleDef => ({ period_grammar: "day", unit_scope: "global", ...o });

export const CYCLES: readonly CycleDef[] = [
  daily({ cycle_code: "cashiering_daily", owner_process: "35.5", owner_agent: "cashiering", unit_scope: "loan", schedule: "daily, every active loan (2.1 post received payments, 2.7 daily_run, 2.3 amount-change check)", selector: "active_loans_daily", runner: "cashiering_daily", receipt_event: "cashiering.daily.run_completed", depends_on: [], serves_timer: "NOTE_6A_LATE_CHARGE_GRACE_GATE", escalation_role: "ops_analyst", expected_by: "same_day 23:59 ET" }),
  daily({ cycle_code: "delinquency_counters", owner_process: "35.9", owner_agent: "default-collections", unit_scope: "loan", schedule: "daily, every active loan with an unpaid installment (delinquency.ts:37-43)", selector: "delinquent_loans_daily", runner: "delinquency_counters", receipt_event: "delinquency.counters.run_completed", depends_on: [dep("cashiering_daily")], serves_timer: "REGX_1024_39A_LIVE_CONTACT_36", escalation_role: "ops_analyst", expected_by: "same_day 23:59 ET" }),
  { cycle_code: "statements", owner_process: "7.1", owner_agent: "disclosures", unit_scope: "loan", period_grammar: "billing_cycle", schedule: "per loan, on the cycle's statement_date (7.1: within 4 days of courtesy_period_end, Reg Z §1026.41(b))", selector: "statements_due", runner: "statements", receipt_event: "statement.cycle.run_completed", depends_on: [dep("cashiering_daily", "as_of_date")], serves_timer: "REGZ_1026_41B_STATEMENT_PROMPT_4", escalation_role: "ops_analyst", expected_by: "same_day 23:59 ET" },
  { cycle_code: "form_1098", owner_process: "35.4", owner_agent: "disclosures", unit_scope: "loan", period_grammar: "tax_year", schedule: "on tax_year.closed{tax_year}, every reportable loan (≥ $600 interest, 7.1-A); by January 31", selector: "form_1098_loans", runner: "form_1098", receipt_event: "tax_form.1098.run_completed", depends_on: [evt(DEP_EVENTS.tax_year_closed, "tax_year")], serves_timer: "IRS_6050H_1098_FURNISH_0131", escalation_role: "ops_analyst", expected_by: "+31 calendar_days" },
  { cycle_code: "escrow_analysis_annual", owner_process: "3.3", owner_agent: "escrow", unit_scope: "loan", period_grammar: "month", schedule: "monthly on the 1st, every escrowed loan whose analysis month is this month; 3.3's statement within 30 days of the computation year end", selector: "escrow_analysis_month", runner: "escrow_analysis_annual", receipt_event: "escrow.analysis.run_completed", depends_on: [dep("cashiering_daily", "as_of_date")], serves_timer: "REGX_1024_17I_ANNUAL_STMT_30", escalation_role: "ops_analyst", expected_by: "+30 calendar_days", periods: () => [] },
  daily({ cycle_code: "lar_daily", owner_process: "5.1", owner_agent: "investor-reporting", unit_scope: "period", schedule: "every business day (business_days_fannie_et) by 20:00 ET, the day's investor_events not yet submitted, in sequence order (batch.ts:1-25)", selector: "lar_day", runner: "lar_daily", receipt_event: "investor.lar.run_completed", depends_on: [dep("cashiering_daily")], serves_timer: "FNMA_C4301_LAR_NONREMOVAL_NEXTBD_2000", escalation_role: "fnma_portal_operator", expected_by: "BD1 20:00 ET", periods: () => [] }),
  { cycle_code: "investor_period_close", owner_process: "35.4", owner_agent: "investor-reporting", unit_scope: "period", period_grammar: "month", schedule: "BD2 17:00 ET each month for the prior month — the removal close; the period's non-removal LARs and corrections closed at BD1 20:00 ET (IRM 2-01)", selector: "month_global", runner: "investor_period_close", receipt_event: "investor.period_close.run_completed", depends_on: [], serves_timer: "FNMA_IRM_PERIOD_CLOSE_BD2_1700", escalation_role: "officer", expected_by: "BD2 17:00 ET" },
  { cycle_code: "remittance", owner_process: "5.2", owner_agent: "investor-reporting", unit_scope: "account", period_grammar: "month", schedule: "A/A: BD1 16:00 ET (F-1-20: prior-month collections received after the 4 p.m. ET cut-off); draft notices BD3; S/S per F-1-20 (portfolio: 18th calendar day; MBS: per remittance cycle)", selector: "remittance_accounts", runner: "remittance", receipt_event: "investor.remittance.run_completed", depends_on: [dep("investor_period_close", "same")], serves_timer: "FNMA_F120_AA_BD1_PRIOR_MONTH", escalation_role: "officer", expected_by: "BD1 16:00 ET", periods: () => [] },
  daily({ cycle_code: "custodial_recon_daily", owner_process: "6.3", owner_agent: "custodial-recon", unit_scope: "account", schedule: "daily, every custodial account (6.3's three-way)", selector: "custodial_accounts_daily", runner: "custodial_recon_daily", receipt_event: "custodial.recon.run_completed", depends_on: [dep("cashiering_daily")], serves_timer: "FNMA_C1101_DEPOSIT_CUSTODIAL_24H", escalation_role: "ops_analyst", expected_by: "same_day 23:59 ET" }),
  { cycle_code: "form_496_monthly", owner_process: "35.4", owner_agent: "custodial-recon", unit_scope: "account", period_grammar: "event", schedule: "after both closes; drafted by BD10 (6.3 policy), completed within 45 days (6.3's reading of the Form 496 instructions; Servicing Guide F-1-03)", selector: "form_496_accounts", runner: "form_496_monthly", receipt_event: "custodial.form496.run_completed", depends_on: [evt(DEP_EVENTS.ledger_period_closed, "period_key"), evt(DEP_EVENTS.investor_period_closed, "period_key")], serves_timer: "FNMA_F496_PI_RECON_45", escalation_role: "officer", expected_by: "+45 calendar_days" },
  { cycle_code: "metro2_monthly", not_before: "00:05", owner_process: "8.1", owner_agent: "credit-reporting", unit_scope: "period", period_grammar: "month", schedule: "00:05 ET on the 1st, as of the last day of the prior month; built by 12:00 ET", selector: "month_global", runner: "metro2_monthly", receipt_event: "credit.cycle.run_completed", depends_on: [dep("cashiering_daily", "period_end")], serves_timer: "FNMA_C41_01_METRO2_SNAPSHOT_EOM", escalation_role: "officer", expected_by: "+1 calendar_days" },
  { cycle_code: "arm_changes", owner_process: "7.2", owner_agent: "disclosures", unit_scope: "loan", period_grammar: "billing_cycle", schedule: "daily: every arm_schedule row whose notice window opens today (first_new_payment_due − 120 days; mail by − 60)", selector: "arm_windows_today", runner: "arm_changes", receipt_event: "arm.adjustment.run_completed", depends_on: [], serves_timer: "REGZ_1026_20C_ADJ_NOTICE_60", escalation_role: "ops_analyst", expected_by: "+60 calendar_days" },
  daily({ cycle_code: "mi_changes", owner_process: "10.3", owner_agent: "pmi", unit_scope: "loan", schedule: "daily: every mi_schedules row whose 80% / 78% / midpoint date is today or passed unhandled", selector: "mi_dates_today", runner: "mi_changes", receipt_event: "mi.schedule.run_completed", depends_on: [dep("cashiering_daily")], serves_timer: "HPA_4902C_MIDPOINT_TERMINATE_0", escalation_role: "ops_analyst", expected_by: "same_day 23:59 ET", periods: () => [] }),
  daily({ cycle_code: "document_integrity", not_before: "02:30", owner_process: "35.2", owner_agent: "security-records", schedule: "daily 02:30 ET", selector: "period_global", runner: "document_integrity", receipt_event: "document.integrity.run_completed", depends_on: [], serves_timer: "SM_DOC_INTEGRITY_DAILY", escalation_role: "ops_analyst", expected_by: "same_day 23:59 ET" }),
  daily({ cycle_code: "projection_verify", not_before: "06:00", owner_process: "35.1", owner_agent: "security-records", schedule: "daily 06:00 ET", selector: "period_global", runner: "projection_verify", receipt_event: "projection.run_completed", depends_on: [], serves_timer: "SM_PROJECTION_LAG_DAILY", escalation_role: "ops_analyst", expected_by: "same_day 23:59 ET" }),
  daily({ cycle_code: "refi_daily", not_before: "06:30", owner_process: "20.1", owner_agent: "ops-steward", schedule: "as 20.1 states (already in the sweep body, app.ts): once per calendar day at/after 06:30 ET", selector: "period_global", runner: "refi_daily", receipt_event: "refi.trigger.run_completed", depends_on: [], serves_timer: "SM_REFI_TRIGGER_DAILY", escalation_role: "ops_analyst", expected_by: "same_day 23:59 ET" }),
  daily({ cycle_code: "partner_book_review", not_before: "07:00", owner_process: "33.2", owner_agent: "ops-steward", schedule: "as 33.2 states (already in the sweep body): daily at/after 07:00 ET", selector: "period_global", runner: "partner_book_review", receipt_event: "partner_book.review.run_completed", depends_on: [dep("refi_daily")], serves_timer: "SM_PARTNER_BOOK_REVIEW_DAILY", escalation_role: "ops_analyst", expected_by: "same_day 23:59 ET" }),
  daily({ cycle_code: "partner_book_readiness", not_before: "07:15", owner_process: "33.3", owner_agent: "ops-steward", schedule: "as 33.3 states (already in the sweep body): daily at/after 07:15 ET", selector: "period_global", runner: "partner_book_readiness", receipt_event: "partner_book.readiness.run_completed", depends_on: [dep("partner_book_review")], serves_timer: "SM_PARTNER_BOOK_READINESS_DAILY", escalation_role: "ops_analyst", expected_by: "same_day 23:59 ET" }),
  daily({ cycle_code: "partner_book_daily_report", not_before: "07:45", owner_process: "34.3", owner_agent: "ops-steward", schedule: "as 34.3 states (already in the sweep body): the daily report per partner-day", selector: "period_global", runner: "partner_book_daily_report", receipt_event: "partner_book.daily_report.run_completed", depends_on: [dep("partner_book_readiness")], serves_timer: "SM_PARTNER_BOOK_DAILY_REPORT_0745", escalation_role: "ops_analyst", expected_by: "same_day 23:59 ET" }),
  { cycle_code: "ledger_period_close", owner_process: "35.4", owner_agent: "custodial-recon", unit_scope: "account", period_grammar: "month", schedule: "month-end: every custodial account, after custodial_recon_daily ran for period_end", selector: "ledger_close_accounts", runner: "ledger_period_close", receipt_event: "custodial.ledger_close.run_completed", depends_on: [dep("custodial_recon_daily", "period_end")], serves_timer: "SM_CLOSE_STEP_STALLED_2BD", escalation_role: "ops_analyst", expected_by: "BD1 17:00 ET", periods: () => [] },
  { cycle_code: "form_496a_monthly", owner_process: "35.4", owner_agent: "custodial-recon", unit_scope: "account", period_grammar: "event", schedule: "after ledger_period_close; completed within 45 days after month-end (6.4's reading of the Form 496A instructions; Servicing Guide F-1-03)", selector: "form_496a_accounts", runner: "form_496a_monthly", receipt_event: "custodial.form496a.run_completed", depends_on: [evt(DEP_EVENTS.ledger_period_closed, "period_key")], serves_timer: "FNMA_F496A_TI_RECON_45", escalation_role: "officer", expected_by: "+45 calendar_days" },
  { cycle_code: "star_monthly", owner_process: "35.4", owner_agent: "qc-audit", unit_scope: "period", period_grammar: "month", schedule: "BD5 (business_days_fannie_et) after the period close", selector: "month_global", runner: "star_monthly", receipt_event: "star.metrics.run_completed", depends_on: [evt(DEP_EVENTS.investor_period_closed, "period_key")], serves_timer: "SM_STAR_COMPUTE_MONTHLY_BD5", escalation_role: "ops_analyst", expected_by: "BD5 17:00 ET" },
  daily({ cycle_code: "lockbox_ingest", owner_process: "35.5", owner_agent: "cashiering", unit_scope: "account", schedule: "per lockbox per business_days_servicer; the file by 10:00 in lockbox_batches.cutoff_tz", selector: "lockboxes_daily", runner: "lockbox_ingest", receipt_event: "lockbox.ingest.run_completed", depends_on: [], serves_timer: "SM_LOCKBOX_FILE_EXPECTED_1BD", escalation_role: "ops_analyst", expected_by: "same_day 10:00 ET", periods: () => [] }),
  daily({ cycle_code: "ach_file_build", owner_process: "35.5", owner_agent: "cashiering", schedule: "every banking day (business_days_federal) by 14:00 ET", selector: "period_global", runner: "ach_file_build", receipt_event: "ach.file_build.run_completed", depends_on: [dep("cashiering_daily")], serves_timer: "SM_ACH_FILE_BUILD_1BD", escalation_role: "ops_analyst", expected_by: "same_day 14:00 ET" }),
  daily({ cycle_code: "ach_returns_ingest", not_before: "08:00", owner_process: "35.5", owner_agent: "cashiering", schedule: "every banking day 08:00 ET", selector: "period_global", runner: "ach_returns_ingest", receipt_event: "ach.returns_ingest.run_completed", depends_on: [], serves_timer: "SM_ACH_RETURN_ACTIONED_1BD", escalation_role: "ops_analyst", expected_by: "same_day 23:59 ET" }),
  daily({ cycle_code: "closing_orchestration_daily", not_before: "06:00", owner_process: "35.6", owner_agent: "disclosures", schedule: "daily 06:00 ET", selector: "period_global", runner: "closing_orchestration_daily", receipt_event: "orchestration.daily.run_completed", depends_on: [dep("cashiering_daily")], serves_timer: "SM_ORCH_OPEN_BOOK_DAILY", escalation_role: "ops_analyst", expected_by: "same_day 23:59 ET" }),
  daily({ cycle_code: "warehouse_daily_accrual", not_before: "00:30", owner_process: "35.6", owner_agent: "warehouse", unit_scope: "account", schedule: "daily 00:30 ET, every open warehouse_advances row", selector: "open_advances_daily", runner: "warehouse_daily_accrual", receipt_event: "warehouse.accrual.run_completed", depends_on: [], serves_timer: "SM_WH_DAILY_ACCRUAL", escalation_role: "ops_analyst", expected_by: "same_day 23:59 ET" }),
  daily({ cycle_code: "warehouse_borrowing_base", not_before: "07:00", owner_process: "35.6", owner_agent: "warehouse", schedule: "07:00 ET each business_days_servicer", selector: "period_global", runner: "warehouse_borrowing_base", receipt_event: "warehouse.borrowing_base.run_completed", depends_on: [dep("warehouse_daily_accrual")], serves_timer: "SM_WH_BORROWING_BASE_DAILY", escalation_role: "ops_analyst", expected_by: "same_day 23:59 ET" }),
  daily({ cycle_code: "roles.queue_scan", not_before: "06:30", owner_process: "35.7", owner_agent: "security-records", schedule: "daily 06:30 ET", selector: "period_global", runner: "roles.queue_scan", receipt_event: "role.queue.scan_completed", depends_on: [], serves_timer: "SM_HANDOVER_BOARD_DAILY", escalation_role: "ops_analyst", expected_by: "same_day 23:59 ET" }),
  daily({ cycle_code: "work_log_recon", not_before: "01:00", owner_process: "35.8", owner_agent: "case", schedule: "once per calendar day", selector: "period_global", runner: "work_log_recon", receipt_event: "work.log.recon.run_completed", depends_on: [], serves_timer: "SM_WORK_LOG_RECON_DAILY", escalation_role: "ops_analyst", expected_by: "same_day 23:59 ET" }),
  daily({ cycle_code: "bk_docket_sync_daily", not_before: "05:00", owner_process: "35.9", owner_agent: "bankruptcy-ops", unit_scope: "loan", schedule: "daily, every open bankruptcy_cases row, before default_case_daily", selector: "open_bk_loans_daily", runner: "bk_docket_sync_daily", receipt_event: "bk_docket_sync.run_completed", depends_on: [dep("delinquency_counters")], serves_timer: "SM_DOCKET_REACTION_1BD", escalation_role: "ops_analyst", expected_by: "same_day 23:59 ET" }),
  daily({ cycle_code: "dra_import_daily", not_before: "07:00", owner_process: "35.9", owner_agent: "foreclosure-ops", schedule: "07:00 ET, 13.6 dra.snapshot.import from the law-firm port", selector: "period_global", runner: "dra_import_daily", receipt_event: "dra_import.run_completed", depends_on: [], serves_timer: "SM_DRA_RECONCILE_DAILY", escalation_role: "ops_analyst", expected_by: "same_day 23:59 ET" }),
  daily({ cycle_code: "default_case_daily", not_before: "05:30", owner_process: "35.9", owner_agent: "foreclosure-ops", unit_scope: "loan", schedule: "daily 05:30 ET, every loan with an open regx_ei_windows, cases or claim_candidates row; expected_by 06:30 ET", selector: "default_case_loans_daily", runner: "default_case_daily", receipt_event: "default_case.daily.run_completed", depends_on: [dep("delinquency_counters"), dep("bk_docket_sync_daily"), dep("dra_import_daily")], serves_timer: "SM_DEFAULT_CASE_DAILY", escalation_role: "ops_analyst", expected_by: "same_day 06:30 ET" }),
  daily({ cycle_code: "claims_sweep_daily", not_before: "06:30", owner_process: "35.9", owner_agent: "claims-reo", unit_scope: "loan", schedule: "daily, loans with a liquidation milestone in the last 120 calendar days or an open candidate", selector: "claims_loans_daily", runner: "claims_sweep_daily", receipt_event: "claims_sweep.run_completed", depends_on: [dep("default_case_daily")], serves_timer: "SM_CLAIM_PACKAGE_5BD", escalation_role: "ops_analyst", expected_by: "same_day 23:59 ET" }),
  daily({ cycle_code: "posture.check", not_before: "05:30", owner_process: "35.12", owner_agent: "compliance-sentinel", schedule: "daily 05:30 ET and on every manifest", selector: "period_global", runner: "posture.check", receipt_event: "posture.check.run_completed", depends_on: [], serves_timer: "SM_PROD_POSTURE_DAILY", escalation_role: "ops_analyst", expected_by: "same_day 23:59 ET" }),
  daily({ cycle_code: "data.scan", not_before: "05:45", owner_process: "35.12", owner_agent: "compliance-sentinel", schedule: "daily 05:45 ET on nonprod", selector: "period_global", runner: "data.scan", receipt_event: "posture.data_scan.run_completed", depends_on: [], serves_timer: null, escalation_role: "ops_analyst", expected_by: "same_day 23:59 ET" }),
  daily({ cycle_code: "parallel_run.reconcile", not_before: "21:00", owner_process: "35.12", owner_agent: "compliance-sentinel", schedule: "daily 21:00 ET while a parallel_runs row is open", selector: "open_parallel_runs_daily", runner: "parallel_run.reconcile", receipt_event: "parallel_run.day.reconciled", depends_on: [dep("cashiering_daily")], serves_timer: "SM_PROD_PARALLEL_RUN_DAILY", escalation_role: "ops_analyst", expected_by: "same_day 23:59 ET", periods: () => [] }),
  // rule 4: "The planner is the month's clock" — a built-in def with no units whose zero-unit run's receipt is `ledger.month.ended{period_key: <prior YYYY-MM>, period_end}` (35.4's `SM_CLOSE_PERIOD_OPEN_BD1` arms on it); the run/receipt unique keys are the once-only bookkeeping (T15).
  { cycle_code: "month_end", owner_process: "35.3", owner_agent: "ops-steward", unit_scope: "period", period_grammar: "month", schedule: "the first planner pass whose as_of civil date (America/New_York) is in a new month closes the prior month", selector: "none", runner: "none", receipt_event: EV.month_ended, depends_on: [], serves_timer: "SM_CLOSE_PERIOD_OPEN_BD1", escalation_role: "ops_analyst", expected_by: "+1 calendar_days" },
];

// The four sweep-body cycles above run as `ops-steward`: the wrapper is the steward's act (their sections' agents write only their own actions — 33.3-T1), and the receipt literal stays the section's own (OWN_RECEIPT_CYCLES).
/** The cycles whose receipt literal is their own section's (35.1's and 35.2's; the four sweep-body passes): the election emits `cycle.run.completed` only (rule 2, "the election emits nothing extra"). */
export const OWN_RECEIPT_CYCLES: ReadonlySet<string> = new Set(["document_integrity", "projection_verify", "refi_daily", "partner_book_review", "partner_book_readiness", "partner_book_daily_report", "roles.queue_scan", "parallel_run.reconcile"]);

export const defOf = (defs: readonly CycleDef[], code: string): CycleDef | undefined => defs.find((d) => d.cycle_code === code);
export const idempotencyKey = (cycle_code: string, period_key: string, unit_id: string): string => `${cycle_code}:${period_key}:${unit_id}`;
