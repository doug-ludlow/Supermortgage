/**
 * §35.3 — the unit runners that have landed, attached to the code registry's rows (cycles.ts CYCLE_ROWS → `CYCLES`).
 * A def whose runner another process supplies (35.4, 35.5, 35.9, …) keeps `runner: null` and dies on its first claim with
 * `error_class: runner_missing` (edge case 3) — labelled, never silent (D14). Two shapes (D5):
 *
 *   in_command   the whole unit is the body of `cycles.run_unit`'s command under the unit's own scope — its events, ledger
 *                sets, timers, the owner agent's decision, the job's `done` write and the run's counters commit in ONE
 *                transaction (rule 5, T9, T16):
 *                  monthEndRunner            rule 4 (T15): `ledger.month.ended{period_key, period_end, origination: true}` on the global
 *                                            subject — 35.4's SM_CLOSE_PERIOD_OPEN_BD1 arms on it; once per month by the job's unique key
 *                  statementsRunner          7.1's statement body (servicing.ts statementUnitIn) for `(loan, cycle_due_date)` on the
 *                                            job's `statement_date` — the notice, `statement.sent` and the `notices` row in the unit's
 *                                            transaction (worked example A)
 *                  form1098Runner            7.1-A / 7.4 rule 11 (servicing.ts form1098UnitIn) for `(loan, tax_year)`
 *                  delinquencyCountersRunner 11.1 / 13.1's counter day (delinquency.ts delinquencyUnitIn) over the command's store
 *                  metro2MonthlyRunner       8.1's own cycle runner (credit-reporting/ops.ts CreditCycleRunner) as `credit-reporting`:
 *                                            open → build from typed rows → transmit through the FAKE bureau port when validated;
 *                                            `credit.cycle.snapshot_completed` is 8.1's code's, in the unit's transaction (T16)
 *                  cashieringDailyRunner     35.5's unit (cycles-35-5.ts): one loan's cashiering day — 2.1 posting, 2.7 daily_run,
 *                                            2.3 amount-change check as in-process commands on the unit command's own store and
 *                                            ledger (35.5 rule 6: one transaction per loan per day); `cashieringDailyReceipt` puts
 *                                            35.5's fields on the day's receipt literal
 *   pass         a runtime pass that opens its own units of work, called un-nested by the executor, followed by one global
 *                bookkeeping unit of work (service.ts runClaimed):
 *                  form496MonthlyRunner      the interim Form 496 unit (T6): section I from the FAKE custodial bank's prior-day
 *                                            statement for the period end, the cashbook from the custodial account's ledger cash,
 *                                            then 6.3's own `form496.generate` command as `custodial-recon` — the money figures are
 *                                            6.3's input under 6.3's rules (rule 12), never written here
 *                  refiDailyRunner, partnerBookReviewRunner, partnerBookReadinessRunner, partnerBookDailyReportRunner
 *                                            the four sweep-body functions (app.ts) wrapped as one unit each — unchanged code,
 *                                            idempotent by their own day gates, so the board and `expected_by` cover them
 *                  RUNNERS_35_9              35.9's four case cycles (cycles-35-9.ts): `docket.sync`, the DRA import from the law-firm port,
 *                                            `case.progress`, `claims.sweep` + `claims.package` — each the owner's bus tool as `foreclosure-ops`
 *                  busToolRunner(p, name)    the generic unit for a sibling process's cycle: `rt.execute({process, name, …})` as the
 *                                            owner agent when the pair is registered on the bus, else `runner_missing` — sibling
 *                                            processes light their cycles up at merge without touching cycles.ts
 *
 * FAKE_BUREAU_CONFIG is the FAKE bureau furnisher configuration (the one 8.1's tests use); every port here is the runtime's
 * FAKE in every build stage.
 */
import type { CommandContext } from "../../app/commands.ts";
import { PortUnavailable, type ToolRuntime } from "../../app/tools.ts";
import type { Runtime } from "../../runtime/app.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { CreditCycleRunner, type BureauConfig, type CycleRecordInput, type Metro2File } from "../credit-reporting/ops.ts";
import { buildSnapshot } from "../credit-reporting/metro2.ts";
import type { CreditLoanState } from "../credit-reporting/types.ts";
import type { Bureau } from "../credit-reporting/disputes.ts";
import type { AppliedInstallment } from "../boarding/delinquency.ts";
import { loanCashState, statementUnitIn, form1098UnitIn, unitIoOf } from "../../runtime/servicing.ts";
import { cashieringDailyRunner, cashieringDailyReceipt } from "./cycles-35-5.ts";
import { delinquencyUnitIn } from "../../runtime/delinquency.ts";
import { RUNNERS_35_9 } from "./cycles-35-9.ts";
import { refiDailyRun } from "../../runtime/refi-daily.ts";
import { partnerBookReviewRun } from "../../runtime/partner-book-review.ts";
import { readinessRun } from "../../runtime/partner-book-readiness.ts";
import { sweepDailyReports } from "../../runtime/book-ops/routes.ts";
import { CYCLE_ROWS, EVT, type CycleDef, type NamedRunner, type UnitContext } from "./cycles.ts";

type Row = Record<string, unknown>;
const runtimeOf = (toolRt: ToolRuntime): Runtime => { const r = toolRt.services["runtime"] as Runtime | undefined; if (!r) throw new PortUnavailable("service:runtime"); return r; };
const loanOf = (unit: UnitContext): string => { if (!unit.loan_id) throw new RangeError(`unit ${unit.cycle_code}:${unit.unit_id} carries no loan_id`); return unit.loan_id; };
const dateOf = (v: unknown, fallback: PlainDate): PlainDate => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? D(v) : fallback);
const c = (v: unknown): Cents => (typeof v === "bigint" ? v : v === undefined || v === null || v === "" ? 0n : BigInt(String(v)));
/** A `runner_missing` throw (edge case 3): the unit dies on its first attempt with that error class (service.ts DEAD_AT_ONCE). */
const runnerMissing = (what: string): Error => new Error(`runner_missing: ${what}`);

// ───────────────────────────── in_command runners
export const monthEndRunner: NamedRunner = { name: "monthEndRunner", runner: { mode: "in_command", run: (_toolRt: ToolRuntime, ctx: CommandContext, unit: UnitContext) => {
  // rule 4: on the global subject, exactly once per month (the job's idempotency key) — the trigger 35.4's SM_CLOSE_PERIOD_OPEN_BD1 arms on
  const e = ctx.events.append({ type: EVT.MONTH_ENDED, actor: unit.actor, payload: { period_key: unit.period_key, period_end: unit.period_end, run_id: unit.run_id, job_id: unit.job_id, origination: true } });
  return { period_key: unit.period_key, period_end: unit.period_end, event_id: e.id, outcome: "month_ended" };
} } };

export const statementsRunner: NamedRunner = { name: "statementsRunner", runner: { mode: "in_command", run: async (toolRt, ctx, unit) => {
  const rt = runtimeOf(toolRt); const loanId = loanOf(unit);
  // worked example A: the job's input is `{cycle_due_date, statement_date}` — ids and dates; the facts are derived inside the command
  const cycleDue = dateOf(unit.input["cycle_due_date"], D(unit.period_key.slice(0, 10)));
  const statementDate = dateOf(unit.input["statement_date"], unit.as_of_date);
  const r = await statementUnitIn(rt, unitIoOf(toolRt, ctx), loanId, { cycle_due_date: cycleDue, statement_date: statementDate });
  return { outcome: `statement_sent_${r.channel}`, notice_id: r.notice_id, availability_notice_id: r.availability_notice_id, channel: r.channel, statement_date: r.statement_date, cycle_due_date: cycleDue, mailed_at: r.mailed_at, bounced: r.bounced_party_ids.length };
} } };

export const form1098Runner: NamedRunner = { name: "form1098Runner", runner: { mode: "in_command", run: async (toolRt, ctx, unit) => {
  const rt = runtimeOf(toolRt); const loanId = loanOf(unit);
  const taxYear = Number(unit.input["tax_year"] ?? unit.period_key);
  if (!Number.isInteger(taxYear)) throw new RangeError(`form_1098 unit ${unit.unit_id}: tax_year is not a year (${String(unit.input["tax_year"] ?? unit.period_key)})`);
  const r = await form1098UnitIn(rt, unitIoOf(toolRt, ctx), loanId, { tax_year: taxYear, furnished_on: unit.as_of_date });
  return { outcome: `form_1098_furnished_${r.channel}`, notice_id: r.notice_id, channel: r.channel, gate_open: r.gate_open, box1_cents: r.box1_cents, box2_cents: r.box2_cents, furnished_on: r.furnished_on, tax_year: taxYear };
} } };

export const delinquencyCountersRunner: NamedRunner = { name: "delinquencyCountersRunner", runner: { mode: "in_command", run: async (toolRt, ctx, unit) => {
  const rt = runtimeOf(toolRt); const loanId = loanOf(unit);
  // 35.5 rule 9: the loan's day is its configuration row's zone at the run's planned instant (the run's opened_at — rule 10's as_of), never the ET date
  const opened = (await rt.db.query<{ at: Date | string | null }>(`SELECT opened_at AS at FROM cycle_runs WHERE id = $1`, [unit.run_id]))[0]?.at ?? null;
  return delinquencyUnitIn(rt, toolRt, ctx, loanId, opened ? new Date(opened).toISOString() : ctx.now);
} } };

/** The FAKE bureau furnisher configuration (8.1's tests' shape): one program identifier and subscriber code per bureau, the file naming with the cycle and bureau tokens. */
export const FAKE_BUREAU_CONFIG: Record<Bureau, BureauConfig> = {
  equifax: { program_identifier: "FAKE-EFX-PROG", subscriber_code: "FAKEEFX01", file_naming: "SM_{cycle}_{bureau}.m2" },
  experian: { program_identifier: "FAKE-EXP-PROG", subscriber_code: "FAKEEXP01", file_naming: "SM_{cycle}_{bureau}.m2" },
  transunion: { program_identifier: "FAKE-TU-PROG", subscriber_code: "FAKETU001", file_naming: "SM_{cycle}_{bureau}.m2" },
  innovis: { program_identifier: "FAKE-INV-PROG", subscriber_code: "FAKEINV01", file_naming: "SM_{cycle}_{bureau}.m2" },
};
/** The file as the FAKE bureau port takes it (a HEADER line, one BASE line per rendered record, a TRAILER line — credit.ts FakeMetro2 checks the structure). */
export const metro2FileContent = (f: Metro2File): string => [`HEADER ${f.header.program_identifier} ${f.header.identification_number} ${f.header.record_count}`, ...f.records.map((r) => `BASE ${JSON.stringify(r)}`), `TRAILER ${f.trailer.total_base_records}`].join("\n");
/**
 * 8.1's CreditLoanState from typed rows (`loans`, `loan_terms`, `loan_borrowers` → `borrowers.party_id`, the ledger and the
 * `payments` records through servicing.ts loanCashState — never `entity_records` directly) for every active boarded loan whose
 * facts suffice; a loan without a consumer or one `buildSnapshot` refuses is omitted with its reason (8.1's own exceptions path
 * governs the rest). `prior: null` — the boarding hand-off (24 × B) until 8.1's prior-cycle snapshot lands as a typed row.
 */
export async function metro2RecordsFromTypedRows(rt: Runtime, asOf: PlainDate): Promise<{ records: CycleRecordInput[]; omitted: { loan_id: string; reason: string }[] }> {
  const records: CycleRecordInput[] = []; const omitted: { loan_id: string; reason: string }[] = [];
  const loans = await rt.db.query<Row>(`SELECT l.id::text AS id, l.fnma_loan_number, l.instrument_date::text AS instrument_date, l.original_upb_cents::text AS original_upb_cents, l.original_term_months, l.first_payment_date::text AS first_payment_date, l.maturity_date::text AS maturity_date
    FROM loans l WHERE l.boarded_at IS NOT NULL AND l.status = 'active' AND EXISTS (SELECT 1 FROM loan_terms t WHERE t.loan_id = l.id) ORDER BY l.boarded_at, l.id`);
  for (const l of loans) {
    const id = String(l["id"]);
    try {
      const consumers = await rt.db.query<{ party_id: string }>(`SELECT b.party_id::text AS party_id FROM borrowers b JOIN loan_borrowers lb ON lb.borrower_id = b.id WHERE lb.loan_id = $1 AND b.party_id IS NOT NULL ORDER BY lb.is_primary DESC, b.created_at, b.id`, [id]);
      if (!consumers.length) { omitted.push({ loan_id: id, reason: "no_consumer" }); continue; }
      const facts = await loanCashState(rt, id, asOf);
      const due = facts.state.installments.filter((x) => x.due_date <= asOf);
      const installments: AppliedInstallment[] = due.map((x) => ({ due_date: x.due_date, amount_cents: x.pi_cents + x.escrow_cents, satisfied_on: x.status === "satisfied" ? (x.credited_as_of ?? x.satisfied_on ?? null) : null, paid_cents: x.status === "satisfied" ? x.pi_cents + x.escrow_cents : 0n }));
      const posted = facts.store.list("payments", (d) => d.loan_id === id && d.status === "posted").map((r) => r.data);
      const inMonth = posted.filter((p) => String(p.received_on ?? "").slice(0, 7) === asOf.slice(0, 7));
      const lastPayment = posted.map((p) => String(p.received_on ?? "")).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().at(-1);
      const originalTerm = Number(l["original_term_months"] ?? 360);
      const state: CreditLoanState = { loan_id: id, as_of: asOf, installments, upb_cents: facts.state.upb_cents, deferred_principal_cents: 0n, forborne_principal_cents: 0n, pi_cents: facts.terms.pi_cents, escrow_cents: facts.terms.escrow_payment_cents,
        original_amount_cents: c(l["original_upb_cents"]), note_date: D(String(l["instrument_date"])), maturity_date: D(String(l["maturity_date"])), original_term_months: originalTerm, remaining_term_months: Math.max(1, originalTerm - due.length), interest_type: "F",
        fnma_loan_number: String(l["fnma_loan_number"] ?? ""), min: null, payments_in_month_cents: inMonth.reduce((a, p) => a + c(p.amount_cents), 0n), last_payment_on: lastPayment ? D(lastPayment) : null, condition: { kind: "none" },
        consumers: consumers.map((x, i) => ({ party_id: x.party_id, position: i + 1, same_address_as_base: true, liability: consumers.length > 1 ? "joint" as const : "individual" as const })), prior: null };
      records.push({ snapshot: buildSnapshot(state), prior_status: null, prior_dofd: null });
    } catch (e) { omitted.push({ loan_id: id, reason: `facts_insufficient: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}` }); }
  }
  return { records, omitted };
}
export const metro2MonthlyRunner: NamedRunner = { name: "metro2MonthlyRunner", runner: { mode: "in_command", run: async (toolRt, ctx, unit) => {
  const rt = runtimeOf(toolRt); const asOf = unit.period_end; const cycleId = unit.period_key;
  // 8.1's own code, as the `credit-reporting` agent (unit.actor): the events ride the command's store, so the snapshot completes in the unit's transaction (T16)
  const runner = new CreditCycleRunner(ctx.events, unit.actor);
  runner.open(cycleId, asOf);
  const typed = await metro2RecordsFromTypedRows(rt, asOf);
  const b = runner.build({ cycle_id: cycleId, as_of: asOf, records: typed.records, config: FAKE_BUREAU_CONFIG });
  let transmitted: { bureau: Bureau; file_id: string }[] = [];
  if (b.status === "validated") {
    const port = rt.ports.metro2; if (!port) throw new PortUnavailable("metro2");
    for (const f of b.files) { const t = await port.transmit(f.bureau, f.file_name, metro2FileContent(f), ctx.now); transmitted.push({ bureau: f.bureau, file_id: t.fileId }); }
    runner.transmit(b, ctx.now);
  }
  return { outcome: b.status === "held" ? "snapshot_held" : "snapshot_transmitted", cycle_id: cycleId, as_of_date: asOf, record_count: b.record_count, omitted: [...typed.omitted, ...b.omitted], exceptions: b.exceptions.length, held_reasons: [...b.held_reasons], transmitted };
} } };

// ───────────────────────────── pass runners (un-nested)

/** The interim Form 496 unit (T6): section I from the FAKE bank's prior-day statement, the cashbook from the custodial ledger, 6.3's `form496.generate` as `custodial-recon`. */
export const form496MonthlyRunner: NamedRunner = { name: "form496MonthlyRunner", runner: { mode: "pass", run: async (rt, unit) => {
  const accountId = String(unit.input["custodial_account_id"] ?? unit.unit_id.split(":")[0]); const remittanceType = String(unit.input["remittance_type"] ?? "A/A");
  const bank = rt.ports.custodialBank; if (!bank) throw new PortUnavailable("custodialBank");
  const statement = await bank.priorDay(accountId, unit.period_end);
  // the cashbook: the custodial account's P&I cash on the ledger through the period end (ledger_lines, scope custodial)
  const cashbook = c((await rt.db.query<{ s: string }>(`SELECT coalesce(sum(x.amount_cents), 0)::text AS s FROM ledger_lines x JOIN ledger_entry_sets e ON e.id = x.set_id WHERE x.scope = 'custodial' AND x.custodial_account_id = $1 AND x.account = 'custodial_pi_cash' AND e.effective_date <= $2::date`, [accountId, unit.period_end]))[0]!.s);
  const section_i = { bank_closing_ledger_cents: statement.closingLedgerCents ?? 0n, deposits_in_transit_cents: 0n, disbursements_in_transit_cents: 0n, adjustments_cents: 0n };
  const kind = /^S\/S/i.test(remittanceType) ? "ss" : /^S\/A/i.test(remittanceType) ? "sa" : "aa";
  // the composition identity is 6.3's (L12 = cashbook = adjusted depository): A/A line 1 is what was collected and not yet remitted — the account's cash; S/S and S/A carry it on their principal lines until 35.4's close chain feeds the detail
  const composition: Record<string, Cents> = kind === "aa" ? { L1_collected_not_remitted: cashbook, L11_other: 0n } : kind === "sa" ? { L2_principal_current: cashbook, L3_prepaid_net: 0n, L4_curtailments: 0n, L6_interest_gain_loss: 0n, L11_other: 0n } : { L3_prepaid_net: 0n, L4_curtailments: 0n, L5_interest_fundings: 0n, L7_payoff_fixed_net: 0n, L8_delinquent_net: 0n, L9_fnma_receivable: cashbook, L10_variances: 0n, L11_other: 0n };
  const r = await rt.execute({ process: "6.3", name: "form496.generate", loanId: "", actor: unit.actor, input: { kind, period: unit.period_key, custodial_account_id: accountId, remittance_type: remittanceType, section_i, cashbook_cents: cashbook, composition, section_iii: [], preparer_run_id: `cycles:${unit.job_id}`, posting_run_ids: [] } });
  const out = r.output as Row;
  return { outcome: `form496_${String(out["status"] ?? "drafted")}`, reconciliation_id: out["id"], form_kind: out["form_kind"], status: out["status"], custodial_account_id: accountId, remittance_type: remittanceType, period: unit.period_key, bank_as_of: statement.asOfDate };
} } };

export const refiDailyRunner: NamedRunner = { name: "refiDailyRunner", runner: { mode: "pass", run: async (rt) => {
  if (!rt.rateFeed) return { outcome: "skipped_no_rate_feed", ran: false };
  const r = await refiDailyRun(rt, rt.clock.now(), { feed: rt.rateFeed, logger: rt.logger });
  return { outcome: r.ran ? "ran" : `skipped: ${r.reason ?? "not run"}`, ran: r.ran, as_of_date: r.as_of_date, line: r.line };
} } };
export const partnerBookReviewRunner: NamedRunner = { name: "partnerBookReviewRunner", runner: { mode: "pass", run: async (rt) => {
  const r = await partnerBookReviewRun(rt, rt.clock.now(), { logger: rt.logger, llm: rt.analystLlm });
  return { outcome: r.ran ? "ran" : `skipped: ${r.reason ?? "not run"}`, ran: r.ran, as_of_date: r.as_of_date, monitored_loans: r.monitored_loans, line: r.line };
} } };
export const partnerBookReadinessRunner: NamedRunner = { name: "partnerBookReadinessRunner", runner: { mode: "pass", run: async (rt) => {
  const r = await readinessRun(rt, rt.clock.now(), { logger: rt.logger });
  return { outcome: r.ran ? "ran" : `skipped: ${r.skipped || "not run"}`, ran: r.ran, as_of_date: r.as_of_date, checked: r.checked, ready: r.ready, not_ready: r.not_ready, line: r.line };
} } };
export const partnerBookDailyReportRunner: NamedRunner = { name: "partnerBookDailyReportRunner", runner: { mode: "pass", run: async (rt) => {
  const r = await sweepDailyReports(rt, rt.clock.now());
  return { outcome: "ran", report: r };
} } };

/** The generic unit of a sibling process's cycle: its bus tool as the owner agent with the unit's ids and dates, when the pair is registered; else `runner_missing` (the cycle is visible on the board, never silent). */
export const busToolRunner = (process: string, name: string, extra: Record<string, unknown> = {}): NamedRunner => ({ name: `busToolRunner(${process} ${name})`, runner: { mode: "pass", run: async (rt, unit) => {
  if (!rt.tool(process, name)) throw runnerMissing(`no bus tool (${process}, ${name}) is registered for cycle ${unit.cycle_code}`);
  // ids and dates only (rule 8): the unit's input, the day, the period, and the job / run the tool's own receipt names (35.5's file cycles)
  const r = await rt.execute({ process, name, loanId: unit.loan_id ?? "", ...(unit.application_id ? { applicationId: unit.application_id } : {}), actor: unit.actor, input: { ...extra, ...unit.input, as_of_date: unit.as_of_date, period_key: unit.period_key, run_id: unit.run_id, job_id: unit.job_id } });
  return { outcome: `${process} ${name} executed`, output: r.output };
} } });

const RUNNERS: Readonly<Record<string, NamedRunner>> = {
  month_end: monthEndRunner, statements: statementsRunner, form_1098: form1098Runner, delinquency_counters: delinquencyCountersRunner, metro2_monthly: metro2MonthlyRunner,
  cashiering_daily: cashieringDailyRunner, form_496_monthly: form496MonthlyRunner,
  refi_daily: refiDailyRunner, partner_book_review: partnerBookReviewRunner, partner_book_readiness: partnerBookReadinessRunner, partner_book_daily_report: partnerBookDailyReportRunner,
  projection_verify: busToolRunner("35.1", "record.verify"), document_integrity: busToolRunner("35.2", "documents.verify", { op: "run" }),   // 35.2: the daily integrity unit is `documents.verify{op: run}` (section35-2.ts) — the owner emits `document.integrity.run_completed` and re-arms SM_DOC_INTEGRITY_DAILY
  "roles.queue_scan": busToolRunner("35.7", "roles.queue_scan"), work_log_recon: busToolRunner("35.8", "work.log.recon"),
  "posture.check": busToolRunner("35.12", "posture.check"), "data.scan": busToolRunner("35.12", "data.scan"), "parallel_run.reconcile": busToolRunner("35.12", "parallel_run.reconcile"),
  // 35.9's four case cycles (cycles-35-9.ts): docket.sync, the DRA import from the law-firm port, case.progress, claims.sweep + claims.package — as the foreclosure-ops agent
  ...RUNNERS_35_9,
  lockbox_ingest: busToolRunner("35.5", "lockbox.ingest"), ach_file_build: busToolRunner("35.5", "ach.file.build"), ach_returns_ingest: busToolRunner("35.5", "ach.returns.ingest"),
  closing_orchestration_daily: busToolRunner("35.6", "orchestration.pass", { op: "daily_receipt" }),
  warehouse_daily_accrual: busToolRunner("27.1", "accrueInterest"), warehouse_borrowing_base: busToolRunner("27.1", "computeBorrowingBase"),
};

/** The owner-supplied fields on a receipt literal (cycles.ts `receipt_payload`) — 35.5's daily receipt. */
const RECEIPT_PAYLOADS: Readonly<Record<string, NonNullable<CycleDef["receipt_payload"]>>> = { cashiering_daily: cashieringDailyReceipt };

/** The registry: every row of rule 2's table plus `month_end`, each with the runner that has landed (or null) and its owner's receipt fields. */
export const CYCLES: readonly CycleDef[] = CYCLE_ROWS.map((row) => ({ ...row, runner: RUNNERS[row.cycle_code] ?? row.runner, ...(RECEIPT_PAYLOADS[row.cycle_code] ? { receipt_payload: RECEIPT_PAYLOADS[row.cycle_code] } : {}) }));
