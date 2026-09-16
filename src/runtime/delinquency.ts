/**
 * The servicing delinquency counter job in the hosted runtime (32.10 backend delta; 11.1 "counter job", 13.1 "counters"):
 *
 *   delinquencyDailySweep(rt, nowIso)
 *     for every active loan with an unpaid `loan_installments` row due before the loan-local civil date, ONE unit of work
 *     per loan: 11.1's pure `delinquencyCounterJob` opens the Reg X windows (`loan.delinquency.window_opened{due_date}`,
 *     which arms REGX_1024_39A_LIVE_CONTACT_36 / REGX_1024_39B_WRITTEN_NOTICE_45 on the registry) and emits the day
 *     milestones (`loan.delinquency.day_reached{day}`), the `loans` projection carries the counters 13.1 reads
 *     (`earliest_unpaid_due`, `principal_residence`, `state`), and 13.1's `sweepDelinquencyCounters` appends
 *     `delinquency.counters.updated` and opens / closes the 120-day gate (REGX_1024_41F1_120_DAY_GATE) — the platform's
 *     own events, entity versions and escalations, or nothing.
 *
 *   Idempotent by day: windows already opened and milestones already reached (read off the loan's event spine) are
 *   never emitted twice; the 13.1 sweep is its own idempotent record.
 *
 *   35.9's `delinquency_counters` cycle unit (35.3 rule 2 assigns the runner to 35.9) calls this per loan with `opts`:
 *   `oncePerDay` makes the unit idempotent per loan-day (35.3 rule 3: a loan whose counters already ran for its civil day is
 *   skipped, so a second run of the day's unit adds no event). Every caller resolves the loan's civil day from 35.5's
 *   `loan_servicing_configs.time_zone` (`loanZoneOf`; 35.5 rule 9, "in place of LOAN_LOCAL_TZ"; LOAN_LOCAL_TZ until 35.5 boards
 *   the loan). The loan's `regx_ei_windows` rows (the table 35.9's daily universe and 35.8's screens read) are projected from
 *   its log on every run (`projectWindows`): the windows opened with their legs' statuses and deadlines at 23:59 loan-local, then
 *   paid / satisfied / exempt — the window's own facts, never a synthesized delinquency.
 */
import { EntityStore } from "../app/tools.ts";
import type { Queryable } from "../infra/db/client.ts";
import { EscalationService } from "../app/escalations.ts";
import type { Actor } from "../kernel/events/index.ts";
import { plainDate as D, type PlainDate } from "../kernel/calendar/date.ts";
import { wallClock, zonedEpochMs, toIso } from "../kernel/calendar/zoned.ts";
import { delinquencyCounterJob } from "../domain/early-intervention/ops-11-1.ts";
import { sweepDelinquencyCounters } from "../domain/foreclosure/ops-13-1.ts";
import type { Runtime } from "./app.ts";

/** The counter job runs as the 11.1 collections agent; the loan-local civil day is the property's (AZ book: America/Phoenix). */
export const COUNTER_JOB_ACTOR: Actor = { kind: "agent", id: "default-collections" };
export const LOAN_LOCAL_TZ = "America/Phoenix";

export interface DelinquencySweepReport {
  readonly at: string;
  readonly today: PlainDate;
  readonly loans: { loan_id: string; earliest_unpaid_due: PlainDate | null; regx_days_delinquent: number; windows_opened: PlainDate[]; milestone: number | null; events: string[]; today?: PlainDate; time_zone?: string }[];
  /** Loans the run skipped and why (`already_ran_today` under `oncePerDay`; `not_yet_due` when the loan's own civil day has not passed the installment). */
  readonly skipped?: { loan_id: string; reason: string }[];
}
/** 35.5 rule 9: the loan's civil time zone from `loan_servicing_configs.time_zone` when 35.5's table is in the tree, else LOAN_LOCAL_TZ — every caller of the runner resolves through this unless it passes its own. */
export async function loanZoneOf(db: Queryable, loanId: string, asOf: PlainDate): Promise<string> {
  const t = await db.query<{ r: string | null }>(`SELECT to_regclass('public.loan_servicing_configs')::text AS r`);
  if (t[0]?.r === null) return LOAN_LOCAL_TZ;
  const rows = await db.query<{ tz: string | null }>(`SELECT time_zone AS tz FROM loan_servicing_configs WHERE loan_id = $1::uuid AND effective_from <= $2::date ORDER BY effective_from DESC LIMIT 1`, [loanId, asOf]);
  return rows[0]?.tz ?? LOAN_LOCAL_TZ;
}
const LIVE_STATUSES = new Set(["open", "satisfied_live", "satisfied_good_faith", "satisfied_ongoing_lossmit", "cancelled_paid", "exempt_bk", "exempt_fdcpa_cease", "exempt_discharge", "not_applicable"]);
const NOTICE_STATUSES = new Set(["open", "sent", "satisfied_by_prior_180", "cancelled_paid", "exempt_bk_no_option", "exempt_bk_cease", "exempt_fdcpa_no_option", "exempt_fdcpa_bk", "deferred_transferee", "not_applicable"]);
const LIVE_BASIS: Readonly<Record<string, string>> = { "contact.live.established": "satisfied_live", "good_faith_efforts.determined": "satisfied_good_faith", "lossmit.ongoing_contact": "satisfied_ongoing_lossmit" };
/**
 * 11.1's `regx_ei_windows` rows for the loan as its log leaves them: a window the job opened (statuses from the event), then the
 * closing facts — the installment credited (`cancelled_paid`), `regx.ei_window.live.satisfied{basis}`, an active bankruptcy or a
 * written FDCPA cease — folded onto a still-open row. The table is what 35.9's daily universe and 35.8's screens read.
 */
export async function projectWindows(q: Queryable, i: { loanId: string; zone: string; opened: readonly Record<string, unknown>[]; spine: readonly { type: string; payload: Record<string, unknown> }[]; bankruptcy: boolean; fdcpaCease: boolean; unpaid: readonly PlainDate[] }): Promise<void> {
  const at = (d: unknown): string => toIso(zonedEpochMs(D(String(d).slice(0, 10)), "23:59", i.zone));
  for (const w of i.opened) {
    const live = LIVE_STATUSES.has(String(w["live_status"])) ? String(w["live_status"]) : "open", notice = NOTICE_STATUSES.has(String(w["notice_status"])) ? String(w["notice_status"]) : "open";
    await q.query(`INSERT INTO regx_ei_windows (loan_id, due_date, principal_residence, live_due_at, notice_due_at, live_status, notice_status) VALUES ($1::uuid, $2::date, $3, $4::timestamptz, $5::timestamptz, $6, $7) ON CONFLICT (loan_id, due_date) DO NOTHING`,
      [i.loanId, String(w["due_date"]), w["principal_residence"] !== false, at(w["live_due_at"] ?? w["due_date"]), at(w["notice_due_at"] ?? w["due_date"]), live, notice]);
  }
  const open = await q.query<{ due_date: string; live_status: string; notice_status: string }>(`SELECT due_date::text AS due_date, live_status, notice_status FROM regx_ei_windows WHERE loan_id = $1::uuid AND (live_status = 'open' OR notice_status = 'open')`, [i.loanId]);
  const satisfied = i.spine.filter((e) => e.type === "regx.ei_window.live.satisfied");
  for (const w of open) {
    let live = w.live_status, notice = w.notice_status;
    const paid = !i.unpaid.some((d) => d === w.due_date);
    if (paid) { if (live === "open") live = "cancelled_paid"; if (notice === "open") notice = "cancelled_paid"; }
    else if (i.bankruptcy) { if (live === "open") live = "exempt_bk"; }
    else if (i.fdcpaCease) { if (live === "open") live = "exempt_fdcpa_cease"; }
    const sat = satisfied.find((e) => e.payload["due_dates"] === null || (Array.isArray(e.payload["due_dates"]) && (e.payload["due_dates"] as unknown[]).includes(w.due_date)));
    if (live === "open" && sat) live = LIVE_BASIS[String(sat.payload["basis"])] ?? "satisfied_live";
    if (live !== w.live_status || notice !== w.notice_status) await q.query(`UPDATE regx_ei_windows SET live_status = $3, notice_status = $4, cancelled_at = CASE WHEN $3 = 'cancelled_paid' THEN now() ELSE cancelled_at END, cancel_reason = CASE WHEN $3 = 'cancelled_paid' THEN 'paid' ELSE cancel_reason END WHERE loan_id = $1::uuid AND due_date = $2::date`, [i.loanId, w.due_date, live, notice]);
  }
}
export interface DelinquencySweepOptions {
  /** The loan's civil time zone (35.5 rule 9); `loanZoneOf` (the 35.5 table, else LOAN_LOCAL_TZ) when absent. */
  readonly zoneOf?: (loanId: string, today: PlainDate) => Promise<string>;
  /** Skip a loan whose `delinquency.counters.updated{on: today}` is already on its log (35.3 rule 3). */
  readonly oncePerDay?: boolean;
}

type Row = Record<string, unknown> & { loan_id: string; principal_residence: boolean | null; fdcpa_debt_collector_flag: boolean | null; state: string | null; occupancy: string | null; unpaid: string[] | null };

export async function delinquencyDailySweep(rt: Runtime, nowIso: string = rt.clock.now(), only?: readonly string[], opts: DelinquencySweepOptions = {}): Promise<DelinquencySweepReport> {
  const defaultToday = wallClock(Date.parse(nowIso), LOAN_LOCAL_TZ).date;
  const skipped: { loan_id: string; reason: string }[] = [];
  const report: DelinquencySweepReport = { at: nowIso, today: defaultToday, loans: [], skipped };
  // the prefilter admits an installment due through the latest civil day any zone can be on (UTC+14); the loan's own zone decides below
  const latestDay = wallClock(Date.parse(nowIso), "Pacific/Kiritimati").date;
  const rows = await rt.db.query<Row>(
    `SELECT l.id AS loan_id, l.principal_residence, l.fdcpa_debt_collector_flag, pr.state, pr.occupancy::text AS occupancy, array_agg(i.due_date::text ORDER BY i.due_date) AS unpaid
       FROM loans l JOIN loan_installments i ON i.loan_id = l.id AND i.status = 'due' AND i.due_date < $1::date LEFT JOIN properties pr ON pr.id = l.property_id
      WHERE l.status = 'active' AND ($2::uuid[] IS NULL OR l.id = ANY($2::uuid[])) GROUP BY l.id, pr.state, pr.occupancy ORDER BY l.created_at`, [latestDay, only && only.length ? [...only] : null]);
  const zoneOf = opts.zoneOf ?? ((l: string, d: PlainDate) => loanZoneOf(rt.db, l, d));
  for (const row of rows) {
    const loanId = row.loan_id;
    const zone = await zoneOf(loanId, defaultToday);
    const today = zone === LOAN_LOCAL_TZ ? defaultToday : wallClock(Date.parse(nowIso), zone).date;
    if (!(row.unpaid ?? []).some((d) => D(d) < today)) { skipped.push({ loan_id: loanId, reason: "not_yet_due" }); continue; }
    const spine = await rt.uow.events.byLoan(loanId);
    const of = (type: string) => spine.filter((e) => e.type === type);
    if (opts.oncePerDay && of("delinquency.counters.updated").some((e) => String(e.payload["on"]) === today)) { skipped.push({ loan_id: loanId, reason: "already_ran_today" }); continue; }
    const windowsOpened = of("loan.delinquency.window_opened").map((e) => String(e.payload["due_date"])).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).map((d) => D(d));
    const milestonesReached = of("loan.delinquency.day_reached").map((e) => String(e.payload["on"])).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).map((d) => D(d));
    const bkFiled = of("bankruptcy.petition.filed").at(-1); const bkClosed = spine.filter((e) => /^bankruptcy\.(case\.closed|dismissed|discharged|stay\.lifted)$/.test(e.type)).at(-1);
    const bankruptcy = bkFiled && (!bkClosed || spine.indexOf(bkClosed) < spine.indexOf(bkFiled)) ? "active" as const : undefined;
    const fdcpaCease = of("fdcpa.cease.received").some((e) => e.payload["written"] === true);
    const qrpc = of("contact.qrpc.established").length > 0;
    const principalResidence = row.principal_residence !== false && row.occupancy !== "investment" && row.occupancy !== "second_home";
    const unpaid = (row.unpaid ?? []).map((d) => D(d));
    const store = new EntityStore(); store.seed(await rt.entities.load({ loanId })); const mark = store.versionCount();
    let escalations: EscalationService | undefined;
    let out: DelinquencySweepReport["loans"][number] | undefined; let opened: Record<string, unknown>[] = [];
    await rt.uow.run({ loanId }, async (ctx) => {
      escalations = new EscalationService(ctx.events, ctx.clock);
      const r = delinquencyCounterJob({ loan_id: loanId, today, unpaid_due_dates: unpaid, windows_opened: windowsOpened, milestones_reached: milestonesReached, principal_residence: principalResidence, qrpc_established: qrpc, resolved: false,
        ...(bankruptcy ? { bankruptcy, bk_case_id: (bkFiled?.payload["case_id"] as string | undefined) ?? null, petition_date: typeof bkFiled?.payload["petition_date"] === "string" ? D(String(bkFiled.payload["petition_date"])) : null } : {}), ...(fdcpaCease ? { fdcpa_cease: true } : {}) });
      // the `loans` projection 13.1's counters read (`earliest_unpaid_due`, `principal_residence`, `state`); the loan's own row keeps its other facts
      const prev = store.get("loans", loanId)?.data ?? {};
      store.put("loans", loanId, { ...prev, loan_id: loanId, earliest_unpaid_due: r.earliest_unpaid_due, regx_days_delinquent: r.regx_days_delinquent, principal_residence: principalResidence, state: row.state ?? prev["state"] ?? "AZ", occupancy: row.occupancy ?? prev["occupancy"] ?? "primary", fdcpa_debt_collector_flag: row.fdcpa_debt_collector_flag === true, counters_as_of: today }, COUNTER_JOB_ACTOR, ctx.clock.now());
      for (const e of r.events) ctx.events.append({ type: e.type, loanId, actor: COUNTER_JOB_ACTOR, payload: e.payload });
      // 13.1: `delinquency.counters.updated` + the 120-day gate (opens 00:05 loan-local on day 121; closes when the loan is current)
      const s = sweepDelinquencyCounters({ events: ctx.events, store, escalations }, { loan_id: loanId, today, actor: COUNTER_JOB_ACTOR, now: ctx.clock.now() });
      out = { loan_id: loanId, earliest_unpaid_due: r.earliest_unpaid_due, regx_days_delinquent: r.regx_days_delinquent, windows_opened: r.windows_opened, milestone: r.milestone, events: [...r.events.map((e) => e.type), ...s.events], today, time_zone: zone };
      opened = r.events.filter((e) => e.type === "loan.delinquency.window_opened").map((e) => e.payload);
    }, { clock: rt.clock, commit: async (q) => {
      await rt.entities.save(store.versionsSince(mark), { loanId }, q); for (const e of escalations?.list() ?? []) await rt.escalationRepo.save(e, q);
      // 11.1's `regx_ei_windows` rows: the windows the job opened (deadlines at 23:59 loan-local) and the closing facts folded onto the open ones
      await projectWindows(q, { loanId, zone, opened, spine, bankruptcy: bankruptcy === "active", fdcpaCease, unpaid });
    } });
    if (out) report.loans.push(out);
  }
  return report;
}
