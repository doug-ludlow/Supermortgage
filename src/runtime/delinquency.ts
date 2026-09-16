/**
 * The servicing delinquency counter job in the hosted runtime (32.10 backend delta; 11.1 "counter job", 13.1 "counters"):
 *
 *   delinquencyDailySweep(rt, nowIso)
 *     for every active loan with an unpaid `loan_installments` row due before the loan-local civil date (35.5 rule 9: the
 *     loan's `loan_servicing_configs.time_zone`; no row → skipped, CONFIG_REQUIRED, never a default zone), ONE unit of work
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
 *   delinquencyUnitIn(rt, toolRt, ctx, loanId, asOfInstant)
 *     the same per-loan body as one 35.3 `delinquency_counters` unit, INSIDE `cycles.run_unit`'s command: the command's
 *     store (seeded with the loan's entities, persisted in its commit), its escalation service and its event store — one
 *     transaction with `job.unit.done`; the loan's day is its configuration row's zone at the planner's instant (rule 9), a
 *     loan without a row is refused CONFIG_REQUIRED. D13: `delinquencyDailySweep` yields to the cycle (`deferred_to_cycle`)
 *     once the registry projects an active `delinquency_counters` row with a runner, so a loan's counter day runs once — a
 *     call that names its loans (`only`) is a targeted run and never yields.
 *
 *   35.9's `delinquency_counters` unit (35.3 rule 2 assigns the runner to 35.9; runners.ts delinquencyCountersRunner → delinquencyUnitIn)
 *   also projects the loan's `regx_ei_windows` rows (`projectWindows`, a deferred write of the unit's transaction): the windows the job
 *   opened with their legs' statuses and deadlines at 23:59 loan-local, then paid / satisfied / exempt folded onto a still-open row —
 *   the table 35.9's daily universe (`default_case_daily`'s selector) and 35.8's screens read; the window's own facts, never a
 *   synthesized delinquency. `oncePerDay` (35.3 rule 3, the targeted by-hand run) skips a loan whose `delinquency.counters.updated{on}`
 *   for its civil day is already on its log, so a second run of the day's unit adds no event.
 */
import { mapLimit, UNIT_CONCURRENCY } from "../kernel/concurrency.ts";
import { EntityStore, PortUnavailable, type ToolRuntime } from "../app/tools.ts";
import { EscalationService } from "../app/escalations.ts";
import { CommandRefused, type CommandContext } from "../app/commands.ts";
import type { Actor, Clock, EventStore } from "../kernel/events/index.ts";
import { plainDate as D, type PlainDate } from "../kernel/calendar/date.ts";
import { wallClock, zonedEpochMs, toIso } from "../kernel/calendar/zoned.ts";
import type { Queryable } from "../infra/db/client.ts";
import { delinquencyCounterJob } from "../domain/early-intervention/ops-11-1.ts";
import { sweepDelinquencyCounters } from "../domain/foreclosure/ops-13-1.ts";
import type { Runtime } from "./app.ts";
import { cycleOwnsPass } from "./servicing.ts";

/** The counter job runs as the 11.1 collections agent. */
export const COUNTER_JOB_ACTOR: Actor = { kind: "agent", id: "default-collections" };
/** The zone the report's header date is read in (the planner's day, src/runtime/demo-clock.ts DEMO_ZONE) — never a loan's civil date, which is its configuration row's (35.5 rule 9). */
const REPORT_ZONE = "America/New_York";

export interface DelinquencySweepReport {
  readonly at: string;
  /** The ET civil date of the pass (the report's header); each loan's own day is `loans[].local_date`. */
  readonly today: PlainDate;
  readonly loans: { loan_id: string; local_date: PlainDate; time_zone: string; earliest_unpaid_due: PlainDate | null; regx_days_delinquent: number; windows_opened: PlainDate[]; milestone: number | null; events: string[] }[];
  /** Active loans with an unpaid row and no `loan_servicing_configs` row: no loan-local date exists for them, so nothing is counted (35.5 rule 9, CONFIG_REQUIRED) — touched by nothing; under `oncePerDay`, loans whose counters already ran for their civil day (`already_ran_today`, 35.3 rule 3). */
  readonly skipped: { loan_id: string; reason: "CONFIG_REQUIRED" | "already_ran_today" }[];
  /** 35.3 D13: the pass yielded to the registered cycle (its units run the same body through the executor) */
  readonly deferred_to_cycle?: string | null;
}
export type DelinquencyLoanOutcome = DelinquencySweepReport["loans"][number];
export interface DelinquencySweepOptions {
  /** Skip a loan whose `delinquency.counters.updated{on: <its civil day>}` is already on its log (35.3 rule 3: a second run of the day's unit adds no event). */
  readonly oncePerDay?: boolean;
}
/** The facts `projectWindows` needs, as the counter's body read them off the loan's log. */
export interface WindowProjectionInput { readonly loanId: string; readonly zone: string; readonly opened: readonly Record<string, unknown>[]; readonly spine: readonly { type: string; payload: Record<string, unknown> }[]; readonly bankruptcy: boolean; readonly fdcpaCease: boolean; readonly unpaid: readonly PlainDate[] }

const LIVE_STATUSES = new Set(["open", "satisfied_live", "satisfied_good_faith", "satisfied_ongoing_lossmit", "cancelled_paid", "exempt_bk", "exempt_fdcpa_cease", "exempt_discharge", "not_applicable"]);
const NOTICE_STATUSES = new Set(["open", "sent", "satisfied_by_prior_180", "cancelled_paid", "exempt_bk_no_option", "exempt_bk_cease", "exempt_fdcpa_no_option", "exempt_fdcpa_bk", "deferred_transferee", "not_applicable"]);
const LIVE_BASIS: Readonly<Record<string, string>> = { "contact.live.established": "satisfied_live", "good_faith_efforts.determined": "satisfied_good_faith", "lossmit.ongoing_contact": "satisfied_ongoing_lossmit" };
/**
 * 11.1's `regx_ei_windows` rows for the loan as its log leaves them (35.9 rule 2's universe; 35.8's screens): a window the job opened
 * (statuses from the event, the legs' deadlines at 23:59 loan-local), then the closing facts — the installment credited (`cancelled_paid`),
 * `regx.ei_window.live.satisfied{basis}`, an active bankruptcy or a written FDCPA cease — folded onto a still-open row.
 */
export async function projectWindows(q: Queryable, i: WindowProjectionInput): Promise<void> {
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

type Row = Record<string, unknown> & { loan_id: string; principal_residence: boolean | null; fdcpa_debt_collector_flag: boolean | null; state: string | null; occupancy: string | null; time_zone: string; local_date: string; unpaid: string[] | null };
/**
 * 35.5 rule 9 (D8): every loan's civil day is `wallClock(instant, config.time_zone).date` — the day is computed in SQL per loan from its
 * `loan_servicing_configs` row in force (`$1 AT TIME ZONE cfg.time_zone`), so a Phoenix loan and a New York loan on one pass see different
 * dates; a loan with no row is listed as skipped (CONFIG_REQUIRED), never defaulted to a zone. $1 the instant, $2 the loan filter (or NULL), $3 the ET date.
 */
const LOAN_ROWS = `SELECT l.id AS loan_id, l.principal_residence, l.fdcpa_debt_collector_flag, pr.state, pr.occupancy::text AS occupancy, cfg.time_zone, (($1::timestamptz AT TIME ZONE cfg.time_zone)::date)::text AS local_date, array_agg(i.due_date::text ORDER BY i.due_date) AS unpaid
       FROM loans l
       JOIN LATERAL (SELECT c.time_zone FROM loan_servicing_configs c WHERE c.loan_id = l.id AND c.effective_from <= $3::date ORDER BY c.effective_from DESC, c.created_at DESC LIMIT 1) cfg ON true
       JOIN loan_installments i ON i.loan_id = l.id AND i.status = 'due' AND i.due_date < ($1::timestamptz AT TIME ZONE cfg.time_zone)::date
       LEFT JOIN properties pr ON pr.id = l.property_id
      WHERE l.status = 'active' AND ($2::uuid[] IS NULL OR l.id = ANY($2::uuid[])) GROUP BY l.id, pr.state, pr.occupancy, cfg.time_zone ORDER BY l.created_at`;
const UNCONFIGURED = `SELECT l.id AS loan_id FROM loans l WHERE l.status = 'active' AND ($2::uuid[] IS NULL OR l.id = ANY($2::uuid[]))
        AND NOT EXISTS (SELECT 1 FROM loan_servicing_configs c WHERE c.loan_id = l.id AND c.effective_from <= $1::date)
        AND EXISTS (SELECT 1 FROM loan_installments i WHERE i.loan_id = l.id AND i.status = 'due' AND i.due_date < $1::date) ORDER BY l.created_at`;

/** The per-loan body (11.1's counter job, the `loans` projection, 13.1's counters and 120-day gate) over the caller's store, events and escalations — the sweep's unit of work or `cycles.run_unit`'s command; `today` is the row's loan-local date. */
async function delinquencyLoanBody(rt: Runtime, io: { readonly events: EventStore; readonly clock: Clock; readonly store: EntityStore; readonly escalations: EscalationService }, row: Row, spine: Awaited<ReturnType<Runtime["uow"]["events"]["byLoan"]>>): Promise<{ out: DelinquencyLoanOutcome; windows: WindowProjectionInput }> {
  const loanId = row.loan_id; const today = D(row.local_date);
  const of = (type: string) => spine.filter((e) => e.type === type);
  const windowsOpened = of("loan.delinquency.window_opened").map((e) => String(e.payload["due_date"])).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).map((d) => D(d));
  const milestonesReached = of("loan.delinquency.day_reached").map((e) => String(e.payload["on"])).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).map((d) => D(d));
  const bkFiled = of("bankruptcy.petition.filed").at(-1); const bkClosed = spine.filter((e) => /^bankruptcy\.(case\.closed|dismissed|discharged|stay\.lifted)$/.test(e.type)).at(-1);
  const bankruptcy = bkFiled && (!bkClosed || spine.indexOf(bkClosed) < spine.indexOf(bkFiled)) ? "active" as const : undefined;
  const fdcpaCease = of("fdcpa.cease.received").some((e) => e.payload["written"] === true);
  const qrpc = of("contact.qrpc.established").length > 0;
  const principalResidence = row.principal_residence !== false && row.occupancy !== "investment" && row.occupancy !== "second_home";
  const unpaid = (row.unpaid ?? []).map((d) => D(d));
  const r = delinquencyCounterJob({ loan_id: loanId, today, unpaid_due_dates: unpaid, windows_opened: windowsOpened, milestones_reached: milestonesReached, principal_residence: principalResidence, qrpc_established: qrpc, resolved: false,
    ...(bankruptcy ? { bankruptcy, bk_case_id: (bkFiled?.payload["case_id"] as string | undefined) ?? null, petition_date: typeof bkFiled?.payload["petition_date"] === "string" ? D(String(bkFiled.payload["petition_date"])) : null } : {}), ...(fdcpaCease ? { fdcpa_cease: true } : {}) });
  // the `loans` projection 13.1's counters read (`earliest_unpaid_due`, `principal_residence`, `state`); the loan's own row keeps its other facts
  const prev = io.store.get("loans", loanId)?.data ?? {};
  io.store.put("loans", loanId, { ...prev, loan_id: loanId, earliest_unpaid_due: r.earliest_unpaid_due, regx_days_delinquent: r.regx_days_delinquent, principal_residence: principalResidence, state: row.state ?? prev["state"] ?? "AZ", occupancy: row.occupancy ?? prev["occupancy"] ?? "primary", fdcpa_debt_collector_flag: row.fdcpa_debt_collector_flag === true, counters_as_of: today }, COUNTER_JOB_ACTOR, io.clock.now());
  for (const e of r.events) io.events.append({ type: e.type, loanId, actor: COUNTER_JOB_ACTOR, payload: e.payload });
  // 13.1: `delinquency.counters.updated` + the 120-day gate (opens 00:05 loan-local on day 121; closes when the loan is current)
  const s = sweepDelinquencyCounters({ events: io.events, store: io.store, escalations: io.escalations }, { loan_id: loanId, today, actor: COUNTER_JOB_ACTOR, now: io.clock.now() });
  const out: DelinquencyLoanOutcome = { loan_id: loanId, local_date: today, time_zone: row.time_zone, earliest_unpaid_due: r.earliest_unpaid_due, regx_days_delinquent: r.regx_days_delinquent, windows_opened: r.windows_opened, milestone: r.milestone, events: [...r.events.map((e) => e.type), ...s.events] };
  const windows: WindowProjectionInput = { loanId, zone: row.time_zone, opened: r.events.filter((e) => e.type === "loan.delinquency.window_opened").map((e) => e.payload), spine, bankruptcy: bankruptcy === "active", fdcpaCease, unpaid };
  return { out, windows };
}
/** 35.3 rule 3 (`oncePerDay`): the loan's counters already ran for its civil day — `delinquency.counters.updated{on: today}` is on its log. */
const ranToday = (spine: readonly { type: string; payload: Record<string, unknown> }[], today: PlainDate): boolean => spine.some((e) => e.type === "delinquency.counters.updated" && String(e.payload["on"]) === today);

/** One loan's counter day inside a `cycles.run_unit` command (35.3's `delinquency_counters` unit) at the planner's instant: the command's store, escalations and events; `{outcome: "no_unpaid_installment"}` when the loan has nothing due before its local day; CONFIG_REQUIRED (35.5 rule 9) when it has no configuration row. */
export async function delinquencyUnitIn(rt: Runtime, toolRt: ToolRuntime, ctx: CommandContext, loanId: string, asOfInstant: string): Promise<{ outcome: string } & Partial<DelinquencyLoanOutcome>> {
  const etToday = wallClock(Date.parse(asOfInstant), REPORT_ZONE).date;
  const row = (await rt.db.query<Row>(LOAN_ROWS, [asOfInstant, [loanId], etToday]))[0];
  if (!row) {
    const configured = await rt.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM loan_servicing_configs WHERE loan_id = $1 AND effective_from <= $2::date`, [loanId, etToday]);
    if (configured[0]!.n === "0") throw new CommandRefused("cycles.run_unit", "CONFIG_REQUIRED", "35.5 rule 9: a read with no config row is a typed refusal, never a default zone", `loan ${loanId}: no loan_servicing_configs row in force on ${etToday} — no loan-local civil date exists for the counter job`);
    return { outcome: "no_unpaid_installment", loan_id: loanId };
  }
  const spine = await rt.uow.events.byLoan(loanId);
  const { out, windows } = await delinquencyLoanBody(rt, { events: ctx.events, clock: ctx.clock, store: toolRt.store, escalations: toolRt.escalations }, row, spine);
  // 11.1's `regx_ei_windows` rows, a deferred write of the unit's own transaction (35.9 rule 2's universe reads the table the same day)
  const defer = toolRt.services["deferWrite"] as ((fn: (q: Queryable) => Promise<void>) => void) | undefined;
  if (!defer) throw new PortUnavailable("service:deferWrite");
  defer((q) => projectWindows(q, windows));
  return { outcome: out.windows_opened.length ? "windows_opened" : out.milestone !== null ? "milestone_reached" : "counters_updated", ...out };
}

export async function delinquencyDailySweep(rt: Runtime, nowIso: string = rt.clock.now(), only?: readonly string[], opts: DelinquencySweepOptions = {}): Promise<DelinquencySweepReport> {
  const etToday = wallClock(Date.parse(nowIso), REPORT_ZONE).date;
  const report: DelinquencySweepReport = { at: nowIso, today: etToday, loans: [], skipped: [], deferred_to_cycle: null };
  const filter = only && only.length ? [...only] : null;
  // 35.3 D13: once the registry projects an active `delinquency_counters` row with a runner, the cycle's units run this body and the whole-book pass yields; a targeted call (`only`) is a by-hand run of those loans
  if (!filter && await cycleOwnsPass(rt, "delinquency_counters")) return { ...report, deferred_to_cycle: "delinquency_counters" };
  const rows = await rt.db.query<Row>(LOAN_ROWS, [nowIso, filter, etToday]);
  const unconfigured = await rt.db.query<{ loan_id: string }>(UNCONFIGURED, [etToday, filter]);
  for (const u of unconfigured) report.skipped.push({ loan_id: u.loan_id, reason: "CONFIG_REQUIRED" });
  // one unit of work per loan, a few loans in flight (src/kernel/concurrency.ts) — the report keeps the rows' order
  const outcomes = await mapLimit(rows, UNIT_CONCURRENCY, async (row): Promise<{ skipped?: DelinquencySweepReport["skipped"][number]; out?: DelinquencyLoanOutcome }> => {
    const loanId = row.loan_id;
    const spine = await rt.uow.events.byLoan(loanId);
    if (opts.oncePerDay && ranToday(spine, D(row.local_date))) return { skipped: { loan_id: loanId, reason: "already_ran_today" } };
    const store = new EntityStore(); store.seed(await rt.entities.load({ loanId })); const mark = store.versionCount();
    let escalations: EscalationService | undefined;
    let out: DelinquencyLoanOutcome | undefined; let windows: WindowProjectionInput | undefined;
    await rt.uow.run({ loanId }, async (ctx) => {
      escalations = new EscalationService(ctx.events, ctx.clock);
      const r = await delinquencyLoanBody(rt, { events: ctx.events, clock: ctx.clock, store, escalations }, row, spine);
      out = r.out; windows = r.windows;
    }, { clock: rt.clock, commit: async (q) => {
      await rt.entities.save(store.versionsSince(mark), { loanId }, q); for (const e of escalations?.list() ?? []) await rt.escalationRepo.save(e, q);
      // 11.1's `regx_ei_windows` rows: the windows the job opened and the closing facts folded onto the open ones
      if (windows) await projectWindows(q, windows);
    } });
    return out ? { out } : {};
  });
  for (const o of outcomes) { if (o.skipped) report.skipped.push(o.skipped); if (o.out) report.loans.push(o.out); }
  return report;
}
