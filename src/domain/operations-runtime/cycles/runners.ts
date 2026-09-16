/**
 * §35.3 rule 8 — the unit runners, by the name the registry row's `unit_runner` carries. A `unit` runner runs inside the
 * unit's own command (the owning agent's actor, the command's transaction, `ctx.events` / `rt.store` / `rt.escalations`)
 * and invokes the owning section's code: its bus tools through `Runtime.runOnBus` on the same unit of work (2.1, 2.7, 2.3,
 * 6.3), or its service bodies (7.1's statementCycleIn / form1098In, 11.1+13.1's delinquencyUnitIn, 8.1's CreditCycleRunner,
 * 35.1's verifyRun). A `pass` runner is one of the sweep-body passes (20.1, 33.2, 33.3, 34.3 — "unchanged code, wrapped as
 * one unit each so the board and expected_by cover them"): it runs on the root runtime before the recording command, its
 * own idempotent units of work, and the command records its outcome. A def whose runner is absent here is registered but not
 * planned (its registry row carries `last_error_class: runner_missing` and `overdue_since` names it — the gap is visible, not
 * silent; the owning process lands the runner by adding it to RUNNERS); a planned job whose runner is gone dies
 * `runner_missing` on its first attempt.
 *
 * Every unit derives its facts server-side (35.5's LoanCashState, 35.1's hydration): the job's `input` carries ids and
 * dates only. Nothing here writes a money column by hand — every money movement is the owner's command under the owner's
 * rules (NO_MONEY_FIELD).
 */
import type { Runtime } from "../../../runtime/app.ts";
import type { CommandContext } from "../../../app/commands.ts";
import type { ToolRuntime } from "../../../app/tools.ts";
import type { Queryable } from "../../../infra/db/client.ts";
import type { Actor } from "../../../kernel/events/index.ts";
import { plainDate as D, addDays, type PlainDate } from "../../../kernel/calendar/date.ts";
import { wallClock } from "../../../kernel/calendar/zoned.ts";
import { loanCashState, prepareStatementCycle, statementCycleIn, markSuspectConsents, persistStatementNotices, prepareForm1098, form1098In, servicingParties, recipientsOf, CASHIERING_AGENT } from "../../../runtime/servicing.ts";
import { delinquentLoanRows, delinquencyLoanFacts, delinquencyUnitIn, LOAN_LOCAL_TZ } from "../../../runtime/delinquency.ts";
import { verifyRun, verifiedToday } from "../seam/verify.ts";
import { refiDailyRun } from "../../../runtime/refi-daily.ts";
import { partnerBookReviewRun } from "../../../runtime/partner-book-review.ts";
import { readinessRun } from "../../../runtime/partner-book-readiness.ts";
import { sweepDailyReports } from "../../../runtime/book-ops/routes.ts";
import { ROLES_QUEUE_SCAN, scanCompletedOn } from "../roles-35-7/queue.ts";
import { CreditCycleRunner, type CycleRecordInput, type BureauConfig } from "../../credit-reporting/ops.ts";
import type { Bureau } from "../../credit-reporting/disputes.ts";
import { graceEndFor } from "../../cashiering/latecharges.ts";
import { CYCLES, SELECTORS, monthEnd, type CycleDef, type Selector } from "./cycles.ts";
import type { JobRow } from "./jobs.ts";

export interface UnitOutcome { readonly outcome: string; readonly detail?: Record<string, unknown>; }
export interface UnitContext { readonly rt: ToolRuntime; readonly ctx: CommandContext; readonly runtime: Runtime; readonly def: CycleDef; readonly job: JobRow; /** the owning section's agent (rule 8) — the actor of every act the unit performs */ readonly owner: Actor; readonly as_of: string; readonly as_of_date: PlainDate; }
export interface PassContext { readonly def: CycleDef; readonly job: JobRow; readonly as_of: string; readonly as_of_date: PlainDate; }
export type Runner = { readonly kind: "unit"; run(u: UnitContext): Promise<UnitOutcome> } | { readonly kind: "pass"; pass(runtime: Runtime, p: PassContext): Promise<UnitOutcome> };
/** Ports for facts other sections supply (in-repo defaults): 8.1's per-loan Metro 2 records for a cycle (default: none — the book's snapshots are 8.1's/35.4's to supply). */
export interface CyclePorts { readonly metro2Records?: (db: Queryable, asOf: PlainDate) => Promise<CycleRecordInput[]>; }
export interface CyclesConfig { readonly defs: readonly CycleDef[]; readonly selectors: Record<string, Selector>; readonly runners: Record<string, Runner>; readonly ports: CyclePorts; }

const unit = (run: (u: UnitContext) => Promise<UnitOutcome>): Runner => ({ kind: "unit", run });
const pass = (fn: (runtime: Runtime, p: PassContext) => Promise<UnitOutcome>): Runner => ({ kind: "pass", pass: fn });
const loanOf = (job: JobRow): string => { if (!job.loan_id) throw new RangeError(`unit ${job.unit_id} of ${job.cycle_code} names no loan`); return job.loan_id; };
const s = (v: unknown): string => String(v ?? "");
const c = (v: unknown): bigint => (typeof v === "bigint" ? v : v === undefined || v === null || v === "" ? 0n : BigInt(String(v)));
const CUSTODIAL_RECON: Actor = { kind: "agent", id: "custodial-recon" };
/** The FAKE bureau programme identifiers (every vendor an in-repo FAKE). */
export const FAKE_BUREAU_CONFIG: Record<Bureau, BureauConfig> = { equifax: { program_identifier: "FAKE-EFX", subscriber_code: "FAKE0001", file_naming: "SM_{cycle}_{bureau}.m2" }, experian: { program_identifier: "FAKE-EXP", subscriber_code: "FAKE0002", file_naming: "SM_{cycle}_{bureau}.m2" }, transunion: { program_identifier: "FAKE-TU", subscriber_code: "FAKE0003", file_naming: "SM_{cycle}_{bureau}.m2" }, innovis: { program_identifier: "FAKE-INV", subscriber_code: "FAKE0004", file_naming: "SM_{cycle}_{bureau}.m2" } };

/** The custodial account's cashbook (its own ledger balance) and the latest bank statement the 6.3 tools stored, for the daily close and the Form 496 draft. */
async function custodialFacts(u: UnitContext, accountId: string, asOf: PlainDate): Promise<{ cashbook: bigint; bank: bigint | null }> {
  const [row] = await u.runtime.db.query<{ s: string }>(`SELECT coalesce(sum(amount_cents), 0)::text AS s FROM ledger_lines l JOIN ledger_entry_sets e ON e.id = l.set_id WHERE l.scope = 'custodial' AND l.custodial_account_id = $1 AND e.effective_date <= $2::date`, [accountId, asOf]);
  const stmt = [...u.rt.store.list("bank_statements", (d) => d.custodial_account_id === accountId && d.control_totals_ok === true && String(d.as_of_date ?? "") <= asOf)].sort((a, b) => String(a.data.as_of_date).localeCompare(String(b.data.as_of_date))).at(-1);
  return { cashbook: c(row?.s), bank: stmt && stmt.data.closing_ledger_cents !== null && stmt.data.closing_ledger_cents !== undefined ? c(stmt.data.closing_ledger_cents) : null };
}

export const RUNNERS: Record<string, Runner> = {
  /** 35.5 / 2.1, 2.7, 2.3 (`cashiering`): the servicing sweep's per-loan steps as bus commands on the unit's own unit of work — one loan's day is one transaction (open question 4 default). */
  cashiering_daily: unit(async (u) => {
    const loanId = loanOf(u.job); const today = D(u.ctx.now.slice(0, 10));
    let facts = await loanCashState(u.runtime, loanId, today, u.rt.store);
    const posted: string[] = [];
    if (facts.custodial) for (const p of facts.received_payments) {
      await u.runtime.runOnBus(u.ctx, u.rt, { process: "2.1", name: "payments.read/write", actor: CASHIERING_AGENT, input: { op: "post", id: s(p.payment_id), loan_id: loanId, state: facts.state, custodial: facts.custodial } });
      posted.push(s(p.payment_id)); facts = await loanCashState(u.runtime, loanId, today, u.rt.store);
    }
    const dueToday = facts.state.installments.some((x) => x.due_date === today);
    const graceYesterday = facts.state.installments.some((x) => x.status === "due" && graceEndFor(facts.state, x.due_date) === addDays(today, -1));
    let lateChargeRun = false;
    if (dueToday || graceYesterday) {
      const backlog = facts.received_payments.filter((p) => s(p.received_on) <= today).length;
      await u.runtime.runOnBus(u.ctx, u.rt, { process: "2.7", name: "fees.assess", actor: CASHIERING_AGENT, input: { op: "daily_run", state: facts.state, run_on: today, facts: { items_received_or_identified_on_or_before_gate_date: backlog, run_on: today }, unposted_receipts_on_or_before_grace: backlog } });
      lateChargeRun = true;
    }
    let amountChangeChecks = 0;
    for (const rec of u.rt.store.list("autodraft_enrollments", (d) => d.loan_id === loanId && d.status === "active")) {
      const e = rec.data; if (e.last_debit_cents === null || e.last_debit_cents === undefined) continue;
      const nextOn = typeof e.next_draft_on === "string" && e.next_draft_on >= today ? D(e.next_draft_on) : null; if (!nextOn || nextOn > addDays(today, 31)) continue;
      const inst = facts.state.installments.find((x) => x.due_date.slice(0, 7) === nextOn.slice(0, 7)) ?? facts.state.installments.find((x) => x.status === "due"); if (!inst) continue;
      const next = inst.pi_cents + inst.escrow_cents + c(e.extra_principal_cents); if (next === c(e.last_debit_cents)) continue;
      const notices = Array.isArray(e.notices) ? (e.notices as Record<string, unknown>[]) : []; if (notices.some((n) => c(n.amount_cents) === next && n.debit_on === nextOn)) continue;
      const parties = await servicingParties(u.runtime, loanId);
      await u.runtime.runOnBus(u.ctx, u.rt, { process: "2.3", name: "autodraft.read/write", actor: CASHIERING_AGENT, input: { op: "amount_change_check", id: rec.id, loan_id: loanId, next_amount_cents: next.toString(), debit_on: nextOn, today, prior_amount_cents: String(e.last_debit_cents), reason: "your escrow payment changed after the annual escrow analysis", recipients: recipientsOf(parties) } });
      amountChangeChecks += 1;
    }
    return { outcome: "done", detail: { posted: posted.length, late_charge_run: lateChargeRun, amount_change_checks: amountChangeChecks } };
  }),
  /** 35.9 / 11.1, 13.1 (`default-collections`): the counter job for one loan on the unit's transaction (src/runtime/delinquency.ts delinquencyUnitIn). */
  delinquency_counters: unit(async (u) => {
    const loanId = loanOf(u.job); const today = wallClock(Date.parse(u.ctx.now), LOAN_LOCAL_TZ).date;
    const [row] = await delinquentLoanRows(u.runtime, today, [loanId]);
    if (!row) return { outcome: "current", detail: { loan_id: loanId } };
    const facts = await delinquencyLoanFacts(u.runtime, row);
    const out = delinquencyUnitIn(u.ctx, u.rt.store, u.rt.escalations, facts, today);
    return { outcome: "done", detail: { regx_days_delinquent: out.regx_days_delinquent, windows_opened: out.windows_opened.length, milestone: out.milestone, events: out.events.length } };
  }),
  /** 7.1 (`disclosures`): `sendPeriodicStatement`'s body on the unit's transaction — `statement.sent` and `job.unit.done` are one batch (T9); 7.1's own idempotency (one cycle per loan and due date) governs. */
  statements: unit(async (u) => {
    const loanId = loanOf(u.job);
    const input = { cycle_due_date: D(s(u.job.input["cycle_due_date"] ?? u.job.period_key)), statement_date: D(s(u.job.input["statement_date"] ?? u.as_of_date)), now: u.ctx.now };
    const d = await prepareStatementCycle(u.runtime, loanId, input);
    const suspect: { party_id: string; consent_id: string | null }[] = [];
    const r = await statementCycleIn(u.runtime, u.ctx, loanId, input, d, suspect);
    const defer = u.rt.services["deferWrite"] as ((fn: (q: Queryable) => Promise<void>) => void) | undefined;
    if (defer) defer(async (q) => { await markSuspectConsents(q, suspect); await persistStatementNotices(u.runtime, q, r.notices ?? [], d.statementDate); });
    return { outcome: r.channel, detail: { notice_id: r.notice_id, statement_date: r.statement_date, cycle_due_date: input.cycle_due_date, bounced: r.bounced_party_ids.length } };
  }),
  /** 35.4 / 7.1-A (`disclosures`): the Form 1098 for one loan and tax year on the unit's transaction. */
  form_1098: unit(async (u) => {
    const loanId = loanOf(u.job); const y = Number(u.job.input["tax_year"] ?? u.job.period_key);
    const d = await prepareForm1098(u.runtime, loanId, { tax_year: y, now: u.ctx.now });
    const r = await form1098In(u.runtime, u.ctx, loanId, d);
    return { outcome: r.channel, detail: { notice_id: r.notice_id, tax_year: y, gate_open: r.gate_open } };
  }),
  /** 8.1 (`credit-reporting`): the snapshot builder as of the period's last day — `credit.cycle.snapshot_completed` by 8.1's own code (ops.ts CreditCycleRunner.build) in the unit's transaction (T16); the records are the port's (none until 8.1/35.4 supply the book's snapshots). */
  metro2_monthly: unit(async (u) => {
    const asOf = monthEnd(u.job.period_key); const cycleId = `metro2-${u.job.period_key}`;
    const records = u.runtime.cycles.ports.metro2Records ? await u.runtime.cycles.ports.metro2Records(u.runtime.db, asOf) : [];
    const runner = new CreditCycleRunner(u.ctx.events, u.owner);
    const b = runner.build({ cycle_id: cycleId, as_of: asOf, records, config: FAKE_BUREAU_CONFIG });
    return { outcome: b.status, detail: { cycle_id: cycleId, as_of_date: asOf, record_count: b.record_count, omitted: b.omitted.length, exceptions: b.exceptions.length } };
  }),
  /** 35.4 / 6.3 (`custodial-recon`): the Form 496 draft through 6.3's own `form496.generate` on the unit's transaction (T6: "the unit runs 6.3's chain") with the account's cashbook and latest statement as its Section I. */
  form_496_monthly: unit(async (u) => {
    const accountId = s(u.job.input["custodial_account_id"] ?? u.job.unit_id.split(":")[0]); const period = s(u.job.input["period"] ?? u.job.period_key.split(":")[0]);
    const f = await custodialFacts(u, accountId, monthEnd(period));
    // rule 8: the facts are the owner's — Section I is the bank's closing ledger from 6.3's statement of record; without one the draft cannot be true, so the unit fails (dead after the retries, escalated to the row's officer) rather than draft from the cashbook
    if (f.bank === null) throw new RangeError(`no bank statement of record for custodial account ${accountId} as of ${monthEnd(period)}: 6.3 bank.read_statement first`);
    // 6.3 rule 6: the composition by remittance type (reconciliation.ts form496SS / form496SA / form496AA) — the cashbook on its collected line, every other line zero until 6.3's own preparer fills them; the identity L12 = cashbook = adjusted depository holds
    const rt = s(u.job.input["remittance_type"] ?? "A/A"); const kind = rt === "S/S" ? "ss" : rt === "S/A" ? "sa" : "aa";
    const composition = kind === "ss" ? { L3_prepaid_net: 0n, L4_curtailments: 0n, L5_interest_fundings: 0n, L7_payoff_fixed_net: 0n, L8_delinquent_net: 0n, L9_fnma_receivable: 0n, L10_variances: 0n, L11_other: f.cashbook } : kind === "sa" ? { L2_principal_current: f.cashbook, L3_prepaid_net: 0n, L4_curtailments: 0n, L6_interest_gain_loss: 0n, L11_other: 0n } : { L1_collected_not_remitted: f.cashbook, L11_other: 0n };
    const r = await u.runtime.runOnBus(u.ctx, u.rt, { process: "6.3", name: "form496.generate", actor: CUSTODIAL_RECON, input: { kind, period, custodial_account_id: accountId, remittance_type: rt, section_i: { bank_closing_ledger_cents: f.bank, deposits_in_transit_cents: 0n, disbursements_in_transit_cents: 0n, adjustments_cents: 0n }, cashbook_cents: f.cashbook, composition, section_iii: [], preparer_run_id: `35.3:${u.job.run_id}` } });
    const o = (r.output ?? {}) as Record<string, unknown>;
    return { outcome: s(o["status"] ?? "drafted"), detail: { reconciliation_id: s(o["id"]), period, custodial_account_id: accountId } };
  }),
  /** 35.4 / 6.3 (`custodial-recon`): the month-end cut-off per custodial account — 6.3's `timer.*{op: close_period}` appends `ledger.period.closed` (and the P&I account's remittance period). */
  ledger_period_close: unit(async (u) => {
    const accountId = s(u.job.input["custodial_account_id"] ?? u.job.unit_id); const periodEnd = D(s(u.job.input["period_end"] ?? monthEnd(u.job.period_key.split(":")[0]!)));
    const r = await u.runtime.runOnBus(u.ctx, u.rt, { process: "6.3", name: "timer.*", actor: CUSTODIAL_RECON, input: { op: "close_period", period_end: periodEnd, account_kind: s(u.job.input["account_kind"] ?? "pi"), custodial_account_id: accountId, remittance_type: s(u.job.input["remittance_type"] ?? "A/A") } });
    const o = (r.output ?? {}) as Record<string, unknown>;
    return { outcome: "closed", detail: { period_end: periodEnd, custodial_account_id: accountId, event_id: s(o["id"]) } };
  }),
  /** 6.3 (`custodial-recon`): the daily three-way close per custodial account — 6.3's `timer.*{op: close_day}` with the cashbook and the day's statement (missing → `statement_missing`, 6.3's own exception path). */
  custodial_recon_daily: unit(async (u) => {
    const accountId = s(u.job.input["custodial_account_id"] ?? u.job.unit_id);
    const f = await custodialFacts(u, accountId, u.as_of_date);
    const r = await u.runtime.runOnBus(u.ctx, u.rt, { process: "6.3", name: "timer.*", actor: CUSTODIAL_RECON, input: { op: "close_day", custodial_account_id: accountId, as_of_date: u.as_of_date, section_i: { bank_closing_ledger_cents: f.bank ?? f.cashbook, deposits_in_transit_cents: 0n, disbursements_in_transit_cents: 0n, adjustments_cents: 0n }, cashbook_cents: f.cashbook, carried_item_ids: [], statement_missing: f.bank === null } });
    const o = (r.output ?? {}) as Record<string, unknown>;
    return { outcome: s(o["status"] ?? "closed"), detail: { custodial_account_id: accountId, as_of_date: u.as_of_date, statement_missing: f.bank === null } };
  }),
  /** 35.1 (`security-records`): the daily verify run on the unit's transaction (rule 13 of 35.1); once per day — a second unit the same day records `already_today`. */
  projection_verify: unit(async (u) => {
    if (await verifiedToday(u.ctx.q!, u.as_of_date)) return { outcome: "already_today", detail: { as_of_date: u.as_of_date } };
    const r = await verifyRun({ q: u.ctx.q!, events: u.ctx.events, escalations: u.rt.escalations, actor: u.owner, now: u.ctx.now }, { as_of_date: u.as_of_date });
    return { outcome: "ran", detail: { run_id: r.run_id, gaps: r.gaps, mismatches: r.mismatches, rows_verified: r.rows_verified } };
  }),
  // ---- the sweep-body passes (20.1, 33.2, 33.3, 34.3): unchanged code, wrapped as one unit each (idempotent per day)
  refi_daily: pass(async (runtime, p) => { if (!runtime.rateFeed) return { outcome: "not_wired" }; const r = await refiDailyRun(runtime, p.as_of, { feed: runtime.rateFeed, logger: runtime.logger }); return { outcome: r.ran ? "ran" : `skipped:${r.reason ?? ""}`, detail: { programs: r.programs.length } }; }),
  partner_book_review: pass(async (runtime, p) => { const r = await partnerBookReviewRun(runtime, p.as_of, { logger: runtime.logger, llm: runtime.analystLlm }); return { outcome: r.ran ? "ran" : `skipped:${r.reason ?? ""}`, detail: { monitored_loans: r.monitored_loans } }; }),
  partner_book_readiness: pass(async (runtime, p) => { const r = await readinessRun(runtime, p.as_of, { logger: runtime.logger }); return { outcome: r.ran ? "ran" : `skipped:${r.skipped ?? ""}`, detail: { checked: r.checked } }; }),
  partner_book_daily_report: pass(async (runtime, p) => { const r = await sweepDailyReports(runtime, p.as_of); return { outcome: r ? "ran" : "skipped", detail: {} }; }),
  /** 35.7 (`security-records`): the daily role-queue scan as one unit — `scan_run_id` is this run's `cycle_runs.id` (35.7's CycleRunsPort then inserts nothing); its own `role.queue.scan_completed` is the receipt literal. */
  "roles.queue_scan": pass(async (runtime, p) => { if (await scanCompletedOn(runtime.db, runtime.environment, p.as_of_date)) return { outcome: "already_today", detail: { as_of_date: p.as_of_date } }; const r = await ROLES_QUEUE_SCAN.run(runtime, { as_of: p.as_of_date, scan_run_id: p.job.run_id, planned_by: `cycles:${p.job.run_id}` }); return { outcome: r.completed ? "ran" : "skipped", detail: { rows: r.rows.length, unstaffed_raised: r.unstaffed_raised.length, staffed_raised: r.staffed_raised.length } }; }),
};

export const defaultCyclesConfig = (): CyclesConfig => ({ defs: CYCLES, selectors: SELECTORS, runners: RUNNERS, ports: {} });
