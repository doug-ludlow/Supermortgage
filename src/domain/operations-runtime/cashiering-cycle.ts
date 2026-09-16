/**
 * §35.5 rule 6 — one cashiering unit per loan per day, over the whole book (`cashiering_daily`), and the day's receipt.
 *
 *   runCashieringUnit(i, ctx, rt)     the body of `cashiering.run_unit{loan_id, as_of}` — a loan-scoped command (35.1: one
 *                                     transaction, the loan's lock): the loan's configuration (rule 9; none → CONFIG_REQUIRED,
 *                                     nothing written), `local_date` = the planner's instant in the loan's zone, then in order
 *                                     (0) `installments.reproject` for every un-consumed `loan_terms.*` event (rule 3),
 *                                     (a) 2.1 `payments.read/write{op=post}` per `received`/`identified` payment in receipt order,
 *                                     (b) 2.7 `fees.assess{op=daily_run}` when a row is due today or a grace end was yesterday
 *                                         (`installment.due_date_reached` and the assessment are 2.7's own emissions),
 *                                     (c) 2.3 `autodraft.read/write{op=amount_change_check}` per active enrollment drafting within 31 days,
 *                                     then one `cashiering_unit_runs` row, its decision and `cashiering.unit.completed`.
 *                                     Every step is the owning engine's command on this command's unit of work (section32-2.ts
 *                                     `delegate`: same transaction, same log, the engine derives its own state — rule 5); a
 *                                     `payment_holds` row skips (b)–(c) and records `skipped_hold`. Idempotent by
 *                                     (loan_id, as_of_date): a second unit finds the `done` row and records a decision naming it
 *                                     (ONE_UNIT_PER_LOAN_PER_DAY) — nothing else is written.
 *   cashieringDailyPass(rt, nowIso)   the whole-book pass the sweep runs (src/runtime/app.ts `cashiering.daily`; the demo clock and
 *                                     the borrower flows' tick reach it through servicing.ts servicingDailySweep): the selector of
 *                                     rule 6 (no `origination_application_id` condition), one `cashiering.run_unit` command per
 *                                     loan, the 35.3 run row through the cycles port, and the receipt election — one
 *                                     `cashiering.daily.run_completed{as_of_date, loans, posted, late_charges_assessed,
 *                                     amount_change_checks, units_dead}` per `as_of_date` under the global lock, the trigger and
 *                                     satisfier of SM_CASHIERING_DAILY_RECEIPT_1D (timers-35-5.ts) and 35.4's `eod_cutoff` receipt.
 *
 * Nothing here decides a money figure (rule 10): every posting, assessment and notice is 2.1's, 2.7's or 2.3's command under
 * its own rules; this file writes the unit row, the decision and the two receipts.
 */
import { randomUUID } from "node:crypto";
import { isUuid, type Queryable } from "../../infra/db/client.ts";
import type { Actor } from "../../kernel/events/index.ts";
import { plainDate as D, addDays, type PlainDate } from "../../kernel/calendar/date.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { CommandRefused, type CommandContext } from "../../app/commands.ts";
import type { ToolInput, ToolRuntime } from "../../app/tools.ts";
import { EscalationService } from "../../app/escalations.ts";
import { delegate } from "../../app/tools/section32-2.ts";
import { graceEndFor } from "../cashiering/latecharges.ts";
import type { LoanCashState } from "../cashiering/types.ts";
import type { Runtime } from "../../runtime/app.ts";
import { REPROJECT_TRIGGERS, readInstallments, scheduleRuns } from "./installments.ts";
import { loanServicingConfigOrNull, loanLocalDate } from "./servicing-config.ts";
import { defaultCyclesPort, type CyclesPort } from "./cycles-port.ts";
import { custodialAccount } from "../../runtime/transfers.ts";

export const CASHIERING_CYCLE_EVENTS = {
  unitCompleted: "cashiering.unit.completed",
  unitRefused: "cashiering.unit.refused",
  runCompleted: "cashiering.daily.run_completed",
} as const;
export const CASHIERING_CYCLE_CODE = "cashiering_daily";
/** The planner's zone: `as_of_date` is the environment day (America/New_York), the same key 35.3's `period_key` carries. */
export const PLANNER_ZONE = "America/New_York";
export const CASHIERING_ACTOR: Actor = { kind: "agent", id: "cashiering" };
/** Rule 6's selector: every boarded loan not paid off, transferred out, repurchased or charged off — no `origination_application_id` condition. */
export const ACTIVE_BOOK_SQL = `SELECT id::text AS id FROM loans WHERE boarded_at IS NOT NULL AND status NOT IN ('paid_off', 'transferred_out', 'repurchased', 'charged_off') ORDER BY boarded_at, id`;

type Row = Record<string, unknown>;
const s = (v: unknown): string => String(v ?? "");
const c = (v: unknown): Cents => (typeof v === "bigint" ? v : v === undefined || v === null || v === "" ? 0n : BigInt(String(v)));
const uuidsOf = (ids: readonly string[]): string[] => ids.filter((x) => isUuid(x));
const refsOf = (ids: readonly string[]): string[] => ids.filter((x) => !isUuid(x));

export interface UnitOutcome {
  readonly loan_id: string; readonly as_of_date: PlainDate; readonly local_date: PlainDate; readonly time_zone: string;
  readonly unit_run_id: string; readonly decision_id: string; readonly outcome: "done" | "skipped_hold";
  /** True when this call found the day's `done` row and wrote nothing but its decision (ONE_UNIT_PER_LOAN_PER_DAY). */
  readonly already: boolean;
  readonly posted: string[]; readonly late_charge_run: boolean; readonly late_charge_fee_ids: string[]; readonly amount_change_checks: string[]; readonly reprojections: string[];
  readonly row_variances: { due_date: PlainDate; payment_id: string; row_interest_cents: string; posted_interest_cents: string; difference_cents: string; upb_before_cents: string | null; actual_upb_cents: string }[];
  readonly due_today: boolean; readonly grace_ended_yesterday: boolean; readonly duration_ms: number;
}

/** The instant the unit runs "as of" — the planner's `as_of` when given, else the command's now. */
const asOfInstant = (i: ToolInput, ctx: CommandContext): string => { const v = s(i["as_of"]); if (!v) return ctx.now; if (!Number.isFinite(Date.parse(v))) throw new RangeError(`as_of must be an ISO instant, got ${JSON.stringify(v)}`); return new Date(Date.parse(v)).toISOString(); };

export async function runCashieringUnit(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<UnitOutcome> {
  const t0 = Date.now();
  const q = ctx.q; if (!q) throw new RangeError("cashiering.run_unit runs inside a database command (PgUnitOfWork): no transaction on this context");
  const loanId = s(i["loan_id"]) || ctx.loanId; if (!loanId) throw new RangeError("loan_id is required");
  const asOf = asOfInstant(i, ctx);
  const asOfDate = wallClock(Date.parse(asOf), PLANNER_ZONE).date;
  // rule 9: the loan's configuration, or a typed refusal before any write
  const config = await loanServicingConfigOrNull(q, loanId, asOfDate);
  if (!config) throw new CommandRefused("cashiering.run_unit", "CONFIG_REQUIRED", "35.5 rule 9: 'a read with no config row is a typed refusal (`CONFIG_REQUIRED`), never a default zone'", `loan ${loanId} has no loan_servicing_configs row on ${asOfDate}: the unit cannot compute its local date`);
  const localDate = loanLocalDate(config.time_zone, asOf);
  const decisionId = randomUUID();
  // ONE_UNIT_PER_LOAN_PER_DAY: the day's `done` row ends the unit with a decision naming it
  const done = (await q.query<Row>(`SELECT id::text AS id, local_date::text AS local_date, payments_posted_refs, late_charge_fee_refs, amount_change_check_refs FROM cashiering_unit_runs WHERE loan_id = $1 AND as_of_date = $2::date AND outcome = 'done'`, [loanId, asOfDate]))[0];
  if (done) {
    ctx.decide({ id: decisionId, agent: CASHIERING_ACTOR.id, action: "cashiering.run_unit", ruleSetVersion: "cashiering.allocation.v1", loanId, subject: { kind: "cashiering_unit_run", id: s(done.id) }, ruleCode: "ONE_UNIT_PER_LOAN_PER_DAY",
      rationale: JSON.stringify({ loan_id: loanId, as_of_date: asOfDate, action: "cashiering.run_unit", outcome: "already_done", existing_unit_run_id: done.id, existing_rows: { payments_posted: done.payments_posted_refs, late_charge_fees: done.late_charge_fee_refs, amount_change_checks: done.amount_change_check_refs }, rule_set_version: "cashiering.allocation.v1", model_version: "deterministic", prompt_version: "35.5-v1", confidence: 1, rationale: "a second unit the same day posts nothing, assesses nothing and records nothing new (rule 6)" }), modelVersion: "deterministic", promptVersion: "35.5-v1", confidence: 1 });
    return { loan_id: loanId, as_of_date: asOfDate, local_date: D(s(done.local_date)), time_zone: config.time_zone, unit_run_id: s(done.id), decision_id: decisionId, outcome: "done", already: true, posted: [], late_charge_run: false, late_charge_fee_ids: [], amount_change_checks: [], reprojections: [], row_variances: [], due_today: false, grace_ended_yesterday: false, duration_ms: Date.now() - t0 };
  }
  const hold = (await q.query(`SELECT 1 FROM payment_holds WHERE loan_id = $1 AND released_at IS NULL LIMIT 1`, [loanId])).length > 0;
  const { loanFactsFrom, balancesFromLedger, servicingParties, recipientsOf } = await import("../../runtime/servicing.ts");
  const runtime = rt.services["runtime"] as Runtime;
  // (0) rule 3: a terms activation the schedule has not consumed is re-projected first, so (a)–(c) read the new rows
  const reprojections: string[] = [];
  const consumed = new Set((await scheduleRuns(q, loanId)).map((r) => r.trigger_event_id).filter((x): x is string => !!x));
  for (const ev of ctx.events.all().filter((e) => e.loanId === loanId && REPROJECT_TRIGGERS.includes(e.type) && !consumed.has(e.id))) {
    try { const out = (await delegate(rt, ctx, "35.5", "installments.reproject", { loan_id: loanId, trigger_event_id: ev.id })) as Row; if (out["run_id"]) reprojections.push(s(out["run_id"])); }
    catch (e) {
      if (e instanceof CommandRefused && e.code === "SATISFIED_ROW_FROZEN") rt.escalations.open({ kind: "officer", ownerRole: "officer", loanId, severity: "2", payload: { code: e.code, trigger_event_id: ev.id, event_type: ev.type, reason: e.message, next: "2.1 reversal first (rule 3), then installments.reproject" } }, ctx.actor);
      else if (!(e instanceof RangeError)) throw e;   // a terms event that names no effective date is not a reprojection (RangeError) — recorded on the unit's decision below
      reprojections.push(`skipped:${ev.id}`);
    }
  }
  const factsNow = () => loanFactsFrom(q, { loanId, asOf: localDate, store: rt.store, balances: balancesFromLedger(ctx.ledger, loanId), config });
  let facts = await factsNow();
  // the per-loan custodial accounts come from `custodial_accounts` by partner (rule 5); a partner still without its servicing set (clearing · pi · ti — 30.1's prerequisite, which a transfer boarding leaves at `clearing` alone) gets the missing rows on this transaction before anything posts
  if (!facts.custodial) { for (const kind of ["clearing", "pi", "ti"]) await custodialAccount(q, facts.loan.partner_party_id, kind); facts = await factsNow(); }
  if (!facts.custodial) throw new RangeError(`loan ${loanId}: no custodial accounts for partner ${facts.loan.partner_party_id}`);
  // (a) 2.1: every received / identified payment in receipt order — the engine derives the state on this transaction (rule 5)
  const posted: string[] = []; const variances: { due_date: PlainDate; payment_id: string; row_interest_cents: string; posted_interest_cents: string; difference_cents: string; upb_before_cents: string | null; actual_upb_cents: string }[] = [];
  const received = [...facts.received_payments].sort((a, b) => s(a.received_on).localeCompare(s(b.received_on)) || s(a.payment_id).localeCompare(s(b.payment_id)));
  if (facts.custodial) for (const p of received) {
    const rowsBefore = new Map(facts.state.installments.map((x) => [x.due_date, x] as const)); const upbBefore = facts.state.upb_cents;
    const mark = ctx.events.all().length;
    await delegate(rt, ctx, "2.1", "payments.read/write", { op: "post", id: s(p.payment_id), loan_id: loanId });
    // rule 4: the interest 2.1 posted against the row's interest_cents — they differ only when the UPB no longer equals the row's upb_before (a curtailment between rows); the difference is recorded on the unit
    const rowInterest = new Map((await readInstallments(q, loanId, { from: addDays(localDate, -62), through: addDays(localDate, 62) })).map((r) => [r.due_date, r] as const));
    for (const ev of ctx.events.all().slice(mark).filter((e) => e.type === "payment.applied" && e.loanId === loanId)) {
      const pl = ev.payload as Row; const due = D(s(pl.due_date ?? pl.installment_due_date)); const row = rowInterest.get(due); if (!row) continue;
      const postedInterest = c(pl.interest_cents);
      if (postedInterest !== row.interest_cents) variances.push({ due_date: due, payment_id: s(p.payment_id), row_interest_cents: row.interest_cents.toString(), posted_interest_cents: postedInterest.toString(), difference_cents: (row.interest_cents - postedInterest).toString(), upb_before_cents: row.upb_before_cents === null ? null : row.upb_before_cents.toString(), actual_upb_cents: upbBefore.toString() });
      void rowsBefore;
    }
    posted.push(s(p.payment_id)); facts = await factsNow();
  }
  // (b) 2.7: the 00:30 run on a due date and the day after a grace end — its own `installment.due_date_reached` and assessment decisions
  const state: LoanCashState = facts.state;
  const dueToday = state.installments.some((x) => x.due_date === localDate);
  const graceYesterday = state.installments.some((x) => x.status === "due" && graceEndFor(state, x.due_date) === addDays(localDate, -1));
  let lateChargeRun = false; const feeIds: string[] = [];
  if (!hold && (dueToday || graceYesterday)) {
    const backlog = facts.received_payments.filter((p) => s(p.received_on) <= localDate).length;
    const out = (await delegate(rt, ctx, "2.7", "fees.assess", { op: "daily_run", loan_id: loanId, run_on: localDate, facts: { items_received_or_identified_on_or_before_gate_date: backlog, run_on: localDate }, unposted_receipts_on_or_before_grace: backlog })) as { decisions?: { outcome: string; fee?: { id: string } }[] };
    lateChargeRun = true;
    for (const d of out.decisions ?? []) if ((d.outcome === "assessed" || d.outcome === "accrued_suspended") && d.fee?.id) feeIds.push(d.fee.id);
    facts = await factsNow();
  }
  // (c) 2.3 rule 5: a changed draft amount within the 31-day window needs the Reg E notice (or the statement that stated it)
  const checks: string[] = [];
  if (!hold) for (const rec of rt.store.list("autodraft_enrollments", (d) => d.loan_id === loanId && d.status === "active")) {
    const e = rec.data; if (e.last_debit_cents === null || e.last_debit_cents === undefined) continue;
    const nextOn = typeof e.next_draft_on === "string" && e.next_draft_on >= localDate ? D(e.next_draft_on) : null; if (!nextOn || nextOn > addDays(localDate, 31)) continue;
    const inst = state.installments.find((x) => x.due_date.slice(0, 7) === nextOn.slice(0, 7)) ?? state.installments.find((x) => x.status === "due"); if (!inst) continue;
    const next = inst.pi_cents + inst.escrow_cents + c(e.extra_principal_cents); if (next === c(e.last_debit_cents)) continue;
    const notices = Array.isArray(e.notices) ? (e.notices as Row[]) : []; if (notices.some((n) => c(n.amount_cents) === next && n.debit_on === nextOn)) continue;
    const stmt = ctx.events.all().filter((x) => x.loanId === loanId && x.type === "escrow.statement.sent" && typeof (x.payload as Row).stated_payment_cents === "string").at(-1);
    const parties = await servicingParties(runtime, loanId);
    await delegate(rt, ctx, "2.3", "autodraft.read/write", { op: "amount_change_check", id: rec.id, loan_id: loanId, next_amount_cents: next.toString(), debit_on: nextOn, today: localDate, prior_amount_cents: String(e.last_debit_cents), reason: "your escrow payment changed after the annual escrow analysis", recipients: recipientsOf(parties),
      ...(stmt ? { statement: { template: String((stmt.payload as Row).template), sent_on: String((stmt.payload as Row).sent_on), amount_cents: String((stmt.payload as Row).stated_payment_cents), debit_on: String((stmt.payload as Row).stated_payment_effective_on) } } : {}) });
    checks.push(rec.id);
  }
  // the unit row, its decision and the receipt — one transaction with everything above
  const outcome: UnitOutcome["outcome"] = hold ? "skipped_hold" : "done";
  const unitRunId = randomUUID(); const duration = Date.now() - t0;
  await q.query(`INSERT INTO cashiering_unit_runs (id, loan_id, as_of_date, job_id, run_id, time_zone, local_date, payments_posted, payments_posted_refs, late_charge_run, late_charge_fee_ids, late_charge_fee_refs, amount_change_checks, amount_change_check_refs, reprojections, row_variances, due_today, grace_ended_yesterday, outcome, duration_ms, decision_id)
    VALUES ($1, $2, $3::date, $4::uuid, $5::uuid, $6, $7::date, $8::uuid[], $9::text[], $10, $11::uuid[], $12::text[], $13::uuid[], $14::text[], $15::uuid[], $16::jsonb, $17, $18, $19, $20, $21)`,
    [unitRunId, loanId, asOfDate, isUuid(s(i["job_id"])) ? s(i["job_id"]) : null, isUuid(s(i["run_id"])) ? s(i["run_id"]) : null, config.time_zone, localDate, uuidsOf(posted), refsOf(posted), lateChargeRun, uuidsOf(feeIds), refsOf(feeIds), uuidsOf(checks), refsOf(checks), uuidsOf(reprojections), JSON.stringify(variances), dueToday, graceYesterday, outcome, duration, decisionId]);
  ctx.decide({ id: decisionId, agent: CASHIERING_ACTOR.id, action: "cashiering.run_unit", ruleSetVersion: "cashiering.allocation.v1", loanId, subject: { kind: "cashiering_unit_run", id: unitRunId }, ruleCode: "35.5",
    rationale: JSON.stringify({ loan_id: loanId, as_of_date: asOfDate, local_date: localDate, time_zone: config.time_zone, action: "cashiering.run_unit", inputs: { as_of: asOf, hold }, outputs: { outcome, posted, late_charge_run: lateChargeRun, late_charge_fee_ids: feeIds, amount_change_checks: checks, reprojections, row_variances: variances, due_today: dueToday, grace_ended_yesterday: graceYesterday }, rule_set_version: "cashiering.allocation.v1", model_version: "deterministic", prompt_version: "35.5-v1", confidence: 1, rationale: "rule 6: 2.1 posted every received item, 2.7 ran on the due date / the day after the grace end, 2.3 checked the drafts within 31 days — each the owning engine's command on this transaction" }), modelVersion: "deterministic", promptVersion: "35.5-v1", confidence: 1 });
  ctx.events.append({ type: CASHIERING_CYCLE_EVENTS.unitCompleted, loanId, aggregate: { kind: "cashiering_unit_run", id: unitRunId }, actor: ctx.actor,
    payload: { loan_id: loanId, unit_run_id: unitRunId, as_of_date: asOfDate, local_date: localDate, time_zone: config.time_zone, outcome, posted, late_charge_run: lateChargeRun, late_charge_fee_ids: feeIds, amount_change_checks: checks, reprojections, row_variances: variances, due_today: dueToday, grace_ended_yesterday: graceYesterday, decision_id: decisionId, run_id: s(i["run_id"]) || null } });
  return { loan_id: loanId, as_of_date: asOfDate, local_date: localDate, time_zone: config.time_zone, unit_run_id: unitRunId, decision_id: decisionId, outcome, already: false, posted, late_charge_run: lateChargeRun, late_charge_fee_ids: feeIds, amount_change_checks: checks, reprojections, row_variances: variances, due_today: dueToday, grace_ended_yesterday: graceYesterday, duration_ms: duration };
}

// ---------------------------------------------------------------- the whole-book pass and the day's receipt
export interface CashieringDailyReport {
  readonly at: string; readonly as_of_date: PlainDate; readonly ran: boolean; readonly reason: string | null; readonly run_id: string | null;
  readonly loans: number; readonly units_done: number; readonly units_already: number; readonly units_skipped_hold: number; readonly units_failed: number; readonly units_no_config: number;
  readonly posted: string[]; readonly late_charge_runs: string[]; readonly late_charges_assessed: string[]; readonly amount_change_checks: string[]; readonly reprojections: string[];
  readonly errors: { loan_id: string; step: string; error: string }[]; readonly receipt_event_id: string | null; readonly line: string;
}
export interface CashieringPassOptions { readonly cycles?: CyclesPort; readonly only?: readonly string[]; readonly planned_by?: string; readonly job_ids?: ReadonlyMap<string, string>; /** The sweep's pass: a day already receipted is not re-walked (the flows' tick or the demo clock ran it this minute); a direct caller re-runs every unit, each recording the decision that names its existing row. */ readonly skipIfReceipted?: boolean; }

/** The day's receipt, if the election already ran (any emitter — 35.3's receipt for the same `as_of_date` counts). */
export async function dailyReceiptFor(q: Queryable, asOfDate: PlainDate): Promise<{ id: string } | null> {
  const rows = await q.query<{ id: string }>(`SELECT id::text AS id FROM loan_events WHERE type = $1 AND payload->>'as_of_date' = $2 ORDER BY sequence LIMIT 1`, [CASHIERING_CYCLE_EVENTS.runCompleted, asOfDate]);
  return rows[0] ?? null;
}

const refusalCode = (e: unknown): string | null => (e instanceof CommandRefused ? e.code : e && typeof e === "object" && typeof (e as { code?: unknown }).code === "string" ? String((e as { code: string }).code) : null);

export async function cashieringDailyPass(rt: Runtime, nowIso: string = rt.clock.now(), opts: CashieringPassOptions = {}): Promise<CashieringDailyReport> {
  const cycles = opts.cycles ?? defaultCyclesPort;
  const asOfDate = wallClock(Date.parse(nowIso), PLANNER_ZONE).date;
  const base = { at: nowIso, as_of_date: asOfDate, run_id: null as string | null, loans: 0, units_done: 0, units_already: 0, units_skipped_hold: 0, units_failed: 0, units_no_config: 0, posted: [] as string[], late_charge_runs: [] as string[], late_charges_assessed: [] as string[], amount_change_checks: [] as string[], reprojections: [] as string[], errors: [] as { loan_id: string; step: string; error: string }[], receipt_event_id: null as string | null };
  const receipted = await dailyReceiptFor(rt.db, asOfDate);
  if (receipted && opts.skipIfReceipted) return { ...base, ran: false, reason: `receipted (${CASHIERING_CYCLE_EVENTS.runCompleted} for ${asOfDate} exists)`, receipt_event_id: receipted.id, line: `cashiering daily ${asOfDate}: not run (receipted)` };
  const all = (await rt.db.query<{ id: string }>(ACTIVE_BOOK_SQL)).map((r) => r.id);
  const loans = opts.only ? all.filter((id) => opts.only!.includes(id)) : all;
  const plannedBy = opts.planned_by ?? "sweep:cashiering.daily";
  const demoOffset = Number((rt.clock as { offset?: number }).offset ?? 0);
  const runId = await rt.db.tx((q) => cycles.openRun(q, { cycle_code: CASHIERING_CYCLE_CODE, as_of_date: asOfDate, planned_by: plannedBy, units_total: loans.length, now: nowIso, demo_offset_ms: Number.isFinite(demoOffset) ? demoOffset : 0 }));
  const r = { ...base, run_id: runId, loans: loans.length };
  for (const loanId of loans) {
    try {
      const out = await rt.execute({ process: "35.5", name: "cashiering.run_unit", loanId, actor: CASHIERING_ACTOR, input: { loan_id: loanId, as_of: nowIso, ...(isUuid(runId) ? { run_id: runId } : {}), ...(opts.job_ids?.get(loanId) ? { job_id: opts.job_ids.get(loanId)! } : {}) } });
      const u = out.output as UnitOutcome;
      if (u.already) r.units_already += 1; else if (u.outcome === "skipped_hold") r.units_skipped_hold += 1; else r.units_done += 1;
      r.posted.push(...u.posted); if (u.late_charge_run) r.late_charge_runs.push(loanId); r.late_charges_assessed.push(...u.late_charge_fee_ids); r.amount_change_checks.push(...u.amount_change_checks); r.reprojections.push(...u.reprojections.filter((x) => !x.startsWith("skipped:")));
    } catch (e) {
      const code = refusalCode(e); const message = e instanceof Error ? e.message : String(e);
      if (code === "CONFIG_REQUIRED") { r.units_no_config += 1; await escalateNoConfig(rt, loanId, asOfDate, nowIso, message); }
      else { r.units_failed += 1; rt.logger?.error("cashiering unit failed", { loan_id: loanId, as_of_date: asOfDate, error: message }); }
      r.errors.push({ loan_id: loanId, step: code ?? "unit", error: message });
    }
  }
  // the receipt election: once per as_of_date, under the global lock (35.3 rule 5) — SM_CASHIERING_DAILY_RECEIPT_1D's trigger and satisfier
  let receiptId: string | null = null;
  const receipt = await rt.uow.run({}, async (ctx) => {
    const again = ctx.q ? await dailyReceiptFor(ctx.q, asOfDate) : null;
    if (again) return again.id;
    return ctx.events.append({ type: CASHIERING_CYCLE_EVENTS.runCompleted, aggregate: { kind: "cycle_run", id: isUuid(runId) ? runId : `${CASHIERING_CYCLE_CODE}:${asOfDate}` }, actor: CASHIERING_ACTOR,
      payload: { cycle_code: CASHIERING_CYCLE_CODE, run_id: runId, as_of_date: asOfDate, at: nowIso, loans: loans.length, units_done: r.units_done, units_already: r.units_already, units_skipped_hold: r.units_skipped_hold, units_no_config: r.units_no_config, units_dead: r.units_failed, posted: r.posted.length, late_charge_runs: r.late_charge_runs.length, late_charges_assessed: r.late_charges_assessed.length, amount_change_checks: r.amount_change_checks.length, reprojections: r.reprojections.length, planned_by: plannedBy } }).id;
  }, { clock: rt.clock, globalLock: true });
  receiptId = receipt.result;
  await rt.db.tx((q) => cycles.completeRun(q, runId, { units_total: loans.length, units_done: r.units_done + r.units_already + r.units_skipped_hold, units_dead: r.units_failed, units_skipped: r.units_no_config, now: rt.clock.now() }));
  const line = `cashiering daily ${asOfDate}: loans=${loans.length} done=${r.units_done} already=${r.units_already} hold=${r.units_skipped_hold} no_config=${r.units_no_config} failed=${r.units_failed} posted=${r.posted.length} late_charge_runs=${r.late_charge_runs.length} assessed=${r.late_charges_assessed.length} amount_change_checks=${r.amount_change_checks.length}`;
  return { ...r, ran: true, reason: null, receipt_event_id: receiptId, line };
}

/** OQ 8: a boarded loan without a configuration row is reported and escalated to `compliance` once per day — never defaulted. */
async function escalateNoConfig(rt: Runtime, loanId: string, asOfDate: PlainDate, nowIso: string, message: string): Promise<void> {
  const already = await rt.db.query(`SELECT 1 FROM loan_events WHERE loan_id = $1 AND type = $2 AND payload->>'as_of_date' = $3 LIMIT 1`, [loanId, CASHIERING_CYCLE_EVENTS.unitRefused, asOfDate]);
  if (already.length) return;
  let pending: ReturnType<EscalationService["open"]> | null = null;
  await rt.uow.run({ loanId }, async (ctx) => {
    ctx.events.append({ type: CASHIERING_CYCLE_EVENTS.unitRefused, loanId, aggregate: { kind: "loan", id: loanId }, actor: CASHIERING_ACTOR, payload: { loan_id: loanId, as_of_date: asOfDate, code: "CONFIG_REQUIRED", reason: message, at: nowIso } });
    pending = new EscalationService(ctx.events, ctx.clock).open({ kind: "sev2", ownerRole: "compliance", loanId, severity: "2", payload: { code: "CONFIG_REQUIRED", as_of_date: asOfDate, reason: message, next: "compliance: servicing_config.write (35.5 rule 9)" } }, CASHIERING_ACTOR);
  }, { clock: rt.clock, commit: async (q) => { if (pending) await rt.escalationRepo.save(pending, q); } });
}
