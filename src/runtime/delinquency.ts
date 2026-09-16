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
 *   `zoneOf` resolves the loan's civil day from 35.5's `loan_servicing_configs.time_zone` (35.5 rule 9, "in place of
 *   LOAN_LOCAL_TZ"), and `oncePerDay` makes the unit idempotent per loan-day (35.3 rule 3: a loan whose counters already
 *   ran for its civil day is skipped, so a second run of the day's unit adds no event). A window the job opens is also
 *   projected into 11.1's `regx_ei_windows` row (the table 35.9's daily universe and 35.8's screens read), with the two legs'
 *   deadlines at 23:59 loan-local — the window's own facts, never a synthesized delinquency.
 */
import { EntityStore } from "../app/tools.ts";
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
export interface DelinquencySweepOptions {
  /** The loan's civil time zone (35.5 rule 9); LOAN_LOCAL_TZ when absent. */
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
      WHERE l.status = 'active' AND ($2::uuid[] IS NULL OR l.id = ANY($2::uuid[])) GROUP BY l.id, pr.state, pr.occupancy ORDER BY l.created_at`, [opts.zoneOf ? latestDay : defaultToday, only && only.length ? [...only] : null]);
  for (const row of rows) {
    const loanId = row.loan_id;
    const zone = opts.zoneOf ? await opts.zoneOf(loanId, defaultToday) : LOAN_LOCAL_TZ;
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
      // 11.1's `regx_ei_windows` row for each window the job opened: the legs' deadlines at 23:59 loan-local (11.1 timer table), unique per (loan, due_date)
      for (const w of opened) {
        const at = (d: unknown): string => toIso(zonedEpochMs(D(String(d).slice(0, 10)), "23:59", zone));
        await q.query(`INSERT INTO regx_ei_windows (loan_id, due_date, principal_residence, live_due_at, notice_due_at, live_status, notice_status) VALUES ($1::uuid, $2::date, $3, $4::timestamptz, $5::timestamptz, 'open', 'open') ON CONFLICT (loan_id, due_date) DO NOTHING`,
          [loanId, String(w["due_date"]), w["principal_residence"] !== false, at(w["live_due_at"] ?? w["due_date"]), at(w["notice_due_at"] ?? w["due_date"])]);
      }
    } });
    if (out) report.loans.push(out);
  }
  return report;
}
