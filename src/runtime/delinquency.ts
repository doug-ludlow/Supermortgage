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
 */
import { EntityStore } from "../app/tools.ts";
import { EscalationService } from "../app/escalations.ts";
import type { Actor } from "../kernel/events/index.ts";
import { plainDate as D, type PlainDate } from "../kernel/calendar/date.ts";
import { wallClock } from "../kernel/calendar/zoned.ts";
import { delinquencyCounterJob } from "../domain/early-intervention/ops-11-1.ts";
import { sweepDelinquencyCounters } from "../domain/foreclosure/ops-13-1.ts";
import type { Runtime } from "./app.ts";
import { loanServicingConfig, loanLocalDate } from "../domain/operations-runtime/servicing-config.ts";

/** The counter job runs as the 11.1 collections agent; the loan-local civil day is the loan's `loan_servicing_configs.time_zone` (35.5 rule 9) — never a constant. */
export const COUNTER_JOB_ACTOR: Actor = { kind: "agent", id: "default-collections" };
/** The planner's civil date (America/New_York): the report's `today` and the day a loan without a configuration row is listed under. */
const PLANNER_ZONE = "America/New_York";
/** 35.5 rule 9: a loan's civil date at an instant — its configuration's zone; a loan with no row is a typed refusal (CONFIG_REQUIRED), never a default zone. */
export async function loanCivilDate(rt: Runtime, loanId: string, nowIso: string): Promise<PlainDate> {
  const cfg = await loanServicingConfig(rt.db, loanId, wallClock(Date.parse(nowIso), PLANNER_ZONE).date);
  return loanLocalDate(cfg.time_zone, nowIso);
}

export interface DelinquencySweepReport {
  readonly at: string;
  readonly today: PlainDate;
  readonly loans: { loan_id: string; local_date: PlainDate; time_zone: string; earliest_unpaid_due: PlainDate | null; regx_days_delinquent: number; windows_opened: PlainDate[]; milestone: number | null; events: string[] }[];
  /** 35.5 rule 9: loans with an unpaid row but no `loan_servicing_configs` row — no loan-local date, no count (CONFIG_REQUIRED). */
  readonly skipped_no_config: string[];
}

type Row = Record<string, unknown> & { loan_id: string; principal_residence: boolean | null; fdcpa_debt_collector_flag: boolean | null; state: string | null; occupancy: string | null; time_zone: string | null; unpaid: string[] | null };

export async function delinquencyDailySweep(rt: Runtime, nowIso: string = rt.clock.now(), only?: readonly string[]): Promise<DelinquencySweepReport> {
  const plannerDate = wallClock(Date.parse(nowIso), PLANNER_ZONE).date;
  const report: DelinquencySweepReport = { at: nowIso, today: plannerDate, loans: [], skipped_no_config: [] };
  // 35.5 rule 9: the loan-local civil date is the configuration's zone; the unpaid rows are filtered per loan below, on that date (a row due "today" in Phoenix is not yet past due while it is in New York)
  const rows = await rt.db.query<Row>(
    `SELECT l.id AS loan_id, l.principal_residence, l.fdcpa_debt_collector_flag, pr.state, pr.occupancy::text AS occupancy,
            (SELECT c.time_zone FROM loan_servicing_configs c WHERE c.loan_id = l.id AND c.effective_from <= $1::date ORDER BY c.effective_from DESC, c.created_at DESC LIMIT 1) AS time_zone,
            array_agg(i.due_date::text ORDER BY i.due_date) AS unpaid
       FROM loans l JOIN loan_installments i ON i.loan_id = l.id AND i.status = 'due' AND i.due_date < ($1::date + 1) LEFT JOIN properties pr ON pr.id = l.property_id
      WHERE l.status = 'active' AND ($2::uuid[] IS NULL OR l.id = ANY($2::uuid[])) GROUP BY l.id, pr.state, pr.occupancy ORDER BY l.created_at`, [plannerDate, only && only.length ? [...only] : null]);
  for (const row of rows) {
    const loanId = row.loan_id;
    if (!row.time_zone) { report.skipped_no_config.push(loanId); continue; }
    const today = loanLocalDate(row.time_zone, nowIso);
    const unpaidBeforeToday = (row.unpaid ?? []).filter((d) => d < today);
    if (!unpaidBeforeToday.length) continue;
    const spine = await rt.uow.events.byLoan(loanId);
    const of = (type: string) => spine.filter((e) => e.type === type);
    const windowsOpened = of("loan.delinquency.window_opened").map((e) => String(e.payload["due_date"])).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).map((d) => D(d));
    const milestonesReached = of("loan.delinquency.day_reached").map((e) => String(e.payload["on"])).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).map((d) => D(d));
    const bkFiled = of("bankruptcy.petition.filed").at(-1); const bkClosed = spine.filter((e) => /^bankruptcy\.(case\.closed|dismissed|discharged|stay\.lifted)$/.test(e.type)).at(-1);
    const bankruptcy = bkFiled && (!bkClosed || spine.indexOf(bkClosed) < spine.indexOf(bkFiled)) ? "active" as const : undefined;
    const fdcpaCease = of("fdcpa.cease.received").some((e) => e.payload["written"] === true);
    const qrpc = of("contact.qrpc.established").length > 0;
    const principalResidence = row.principal_residence !== false && row.occupancy !== "investment" && row.occupancy !== "second_home";
    const unpaid = unpaidBeforeToday.map((d) => D(d));
    const store = new EntityStore(); store.seed(await rt.entities.load({ loanId })); const mark = store.versionCount();
    let escalations: EscalationService | undefined;
    let out: DelinquencySweepReport["loans"][number] | undefined;
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
      out = { loan_id: loanId, local_date: today, time_zone: row.time_zone!, earliest_unpaid_due: r.earliest_unpaid_due, regx_days_delinquent: r.regx_days_delinquent, windows_opened: r.windows_opened, milestone: r.milestone, events: [...r.events.map((e) => e.type), ...s.events] };
    }, { clock: rt.clock, commit: async (q) => { await rt.entities.save(store.versionsSince(mark), { loanId }, q); for (const e of escalations?.list() ?? []) await rt.escalationRepo.save(e, q); } });
    if (out) report.loans.push(out);
  }
  return report;
}
