// 35.4 Month-end and year-end close: close periods, the dependency-ordered chain, the balance attestation, reopen, and the tax-year close that drives 1098 and 1099
// spec/sections/35-operations-runtime/35-4-month-end-and-year-end-close.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// Every T-id runs against Postgres (the file has its own database, src/infra/db/test-db.ts; REQUIRE_DB=1 in CI); a T-id
// whose Given contradicts the main scenario's state (T6's restated statement, T8's flag, T9's runs) gets a side database
// of its own driven to the same state. The receipts the chain waits on are the owning sections' own events: where the
// section's emitter exists it is run here (6.3 `timer.*{close_period | close_day}` and `form496.generate`, 5.1
// `closeReportingPeriod`, 18.1 `qcScheduleTicks`); where the owner is a sibling process not yet in this tree (35.5's
// `cashiering.daily.run_completed`, 35.3's `investor.lar.run_completed`) or its builder needs a book this fixture has no
// use for (8.1's snapshot) the fixture appends that literal under the owner's actor as its stand-in — the Given of the
// sentence, never production code (rule 2: this process emits none of them).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { connect, type Db } from "../../infra/db/client.ts";
import { testDatabase } from "../../infra/db/test-db.ts";
import { PgLoanRepository, type Fixture } from "../../infra/db/loans.ts";
import { PgLedgerRepository } from "../../infra/db/ledger.ts";
import { loadOverriddenRegistry } from "../../domain/timer-overrides.ts";
import { FixedClock, type Actor } from "../../kernel/events/index.ts";
import { plainDate as D, addDays } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer as servicerCal } from "../../kernel/calendar/business.ts";
import { Runtime } from "../../runtime/app.ts";
import { OffsetClock, advanceDemoClock, loadDemoClock } from "../../runtime/demo-clock.ts";
import { FakeReviewers } from "../../infra/integrations/reviewers.ts";
import { createLogger } from "../../runtime/log.ts";
import { closeReportingPeriod } from "../investor/ops-5-1.ts";
import { qcScheduleTicks } from "../qc-audit/ops-18-1.ts";
import { setClosePorts, type DocumentBytesPort, type ConfigPort } from "./close-35-4/ports.ts";
import { DEFAULT_SERVICER_NUMBER, periodAggregate, stepAggregate } from "./close-35-4/types.ts";
import { STEP_ORDER } from "./close-35-4/store.ts";
import { fannieBd, periodEndOf } from "./close-35-4/calendar.ts";
import * as FIG from "./close-35-4/figures.ts";

const { url: DB_URL, skip } = await testDatabase(import.meta.url);
const AGENT: Actor = { kind: "agent", id: "custodial-recon" };
const REVIEWER: Actor = { kind: "agent", id: "qc-audit" };
const OFFICER: Actor = { kind: "human", id: "u-officer-okafor", role: "officer" };
const OPS: Actor = { kind: "human", id: "u-ops-lee", role: "ops_analyst" };
const SN = DEFAULT_SERVICER_NUMBER;
const REMITTANCE = "S/S MBS";
const R = (runId: string) => ({ runId, modelVersion: "FAKE-llm-1", promptVersion: "35.4-v1" });
/** ET instants: EDT (UTC−4) through 2026-11-01 02:00, EST (UTC−5) after (through 2027-03-14). */
const et = (date: string, hhmm: string): string => { const [h, m] = hhmm.split(":").map(Number) as [number, number]; const edt = date < "2026-11-01" || (date === "2026-11-01" && h < 2) || date >= "2027-03-14"; return new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), h + (edt ? 4 : 5), m)).toISOString(); };
const refused = async (p: Promise<unknown>): Promise<{ code: string; detail?: Record<string, unknown>; message: string }> => { try { await p; } catch (e) { const x = e as { code?: string; detail?: Record<string, unknown>; message: string }; return { code: x.code ?? "", ...(x.detail ? { detail: x.detail } : {}), message: x.message }; } throw new Error("expected a refusal"); };
const big = (v: unknown): bigint => BigInt(String(v));

/** 6.3's worked example A as 6.3's own rows: the composition (remittance_components), the cashbook (a balanced custodial set), the statement of record (6.3's receipt + the stored bytes) and the in-transit item. */
const COMPOSITION = (l3 = FIG.EX_A_L3_PREPAID_NET): Record<string, bigint> => ({ L3_prepaid_net: l3, L4_curtail_liq_principal: FIG.EX_A_L4_CURTAILMENTS, L5_interest_funding_curtail: FIG.EX_A_L5_INTEREST_FUNDINGS, L7_payoff_fixed_installment_net: FIG.EX_A_L7_PAYOFF_FIXED_NET, L8_delinquent_pi_net: FIG.EX_A_L8_DELINQUENT_PI_NET, L9_fnma_receivable: FIG.EX_A_L9_FNMA_RECEIVABLE, L10_fnma_receivable_adj: FIG.EX_A_L10, L11_other: FIG.EX_A_L11 });
/** 6.3's own `section_i` / `composition` input shapes (src/app/tools/section06.ts form496.generate) for the form's chain. */
const FORM_496_INPUT = (bank: bigint, l3: bigint, cashbook: bigint) => ({ section_i: { bank_closing_ledger_cents: bank, deposits_in_transit_cents: FIG.EX_A_DEPOSITS_IN_TRANSIT, disbursements_in_transit_cents: 0n, adjustments_cents: 0n }, composition: { L3_prepaid_net: l3, L4_curtailments: FIG.EX_A_L4_CURTAILMENTS, L5_interest_fundings: 0n, L7_payoff_fixed_net: FIG.EX_A_L7_PAYOFF_FIXED_NET, L8_delinquent_net: FIG.EX_A_L8_DELINQUENT_PI_NET, L9_fnma_receivable: FIG.EX_A_L9_FNMA_RECEIVABLE, L10_variances: 0n, L11_other: 0n }, cashbook_cents: cashbook });
/** A BAI2 prior-day file whose 015 (closing ledger) is the balance of record — the bytes 35.2 stores and the reviewer re-reads. */
const bai2 = (asOf: string, closingCents: bigint): string => { const d = asOf.replace(/-/g, "").slice(2); return [`01,SENDER,RECEIVER,${d},1200,1,,,2/`, `02,RECEIVER,SENDER,1,${d},1200,USD,2/`, `03,1234567890,USD,010,${closingCents},,,015,${closingCents},,/`, `49,${closingCents * 2n},2/`, `98,${closingCents * 2n},1,4/`, `99,${closingCents * 2n},1,6/`].join("\n") + "\n"; };

class Scenario {
  clock: FixedClock | OffsetClock = new FixedClock("2026-09-30T16:00:00.000Z");
  /** The stand-still clock the hand-driven scenarios set instant by instant (T4's demo scenario runs an OffsetClock instead). */
  fixed(): FixedClock { if (!(this.clock instanceof FixedClock)) throw new Error("this scenario runs the demo clock"); return this.clock; }
  readonly docs = new Map<string, Buffer>();   // the stored statement bytes (35.2's staged copy stands in through the port until its table lands)
  readonly log: string[] = [];
  readonly logger = createLogger("json", (l) => { this.log.push(l); });
  humanApproval = true;                        // configuration `custodial.form496.human_approval` (rule 7) — through the port, never the request
  db!: Db; rt!: Runtime; fx!: Fixture; stmt: { document_id: string; event_id: string } | null = null; dit = ""; closeDb: () => Promise<void> = async () => undefined;
  static async open(suffix?: string, o: { demo?: boolean } = {}): Promise<Scenario> {
    const s = new Scenario();
    const t = suffix ? await testDatabase(import.meta.url, { suffix }) : { url: DB_URL, close: async () => undefined };
    s.db = connect(t.url); s.closeDb = async () => { await s.db.end(); await t.close(); };
    // T4: the hosted runtime's demo clock (an OffsetClock over a stand-still base) with the FAKE reviewers on, as the demo environment runs
    if (o.demo) s.clock = await loadDemoClock(s.db, { base: new FixedClock("2026-09-28T16:00:00.000Z") });
    s.rt = new Runtime({ db: s.db, registry: loadOverriddenRegistry(), clock: s.clock, env: { ...process.env, ENVIRONMENT: "nonprod", ...(o.demo ? {} : { CLOSE_SWEEP_RUNNERS: "off" }) }, environment: "nonprod", ...(o.demo ? { reviewers: new FakeReviewers({ delaySeconds: 0 }), logger: s.logger } : {}) });
    const bytes: DocumentBytesPort = { async read(_q, id) { return s.docs.get(id) ?? null; } };
    const config: ConfigPort = { async humanApprovalOn() { return s.humanApproval; } };
    setClosePorts(s.rt, { documents: bytes, config });
    s.fx = await new PgLoanRepository(s.db).createFixture({ fnmaLoanNumber: `${Date.now() % 1_000_000}${Math.floor(Math.random() * 1000)}`.padStart(10, "0"), servicerLoanNumber: `SM-${randomUUID()}`, instrumentDate: D("2021-07-15"), originalUpbCents: 25_000_000n, originalTermMonths: 360, firstPaymentDate: D("2021-09-01"), maturityDate: D("2051-08-01") });
    await s.db.query(`UPDATE custodial_accounts SET remittance_type = 'S/S' WHERE id = $1`, [s.fx.custodial.pi]);   // the S/S MBS P&I account of worked example A
    return s;
  }
  count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await this.db.query<{ c: string }>(`SELECT count(*)::text AS c ${sql}`, params))[0]!.c);
  tool = (name: string, actor: Actor, input: Record<string, unknown>, run?: { runId: string; modelVersion: string; promptVersion: string }) => this.rt.execute({ process: "35.4", name, loanId: "", actor, input, ...(run ? { run } : {}) });
  sweepAt = async (iso: string, holder?: string) => { this.fixed().set(iso); return this.rt.sweep(iso, { verify: false, ...(holder ? { holder } : {}) }); };
  steps = (period: string, servicer = SN) => this.db.query<{ id: string; code: string; status: string; received: number; expected_receipts: number; started_at: string | null; completed_at: string | null; receipt_filter: Record<string, unknown>; not_before: string | null; depends_on: string[] }>(`SELECT s.id::text AS id, s.code, s.status, s.received, s.expected_receipts, to_char(s.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started_at, to_char(s.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS completed_at, s.receipt_filter, to_char(s.not_before AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS not_before, s.depends_on FROM close_period_steps s JOIN close_periods p ON p.id = s.close_period_id WHERE p.kind = 'month' AND p.period = $1 AND p.servicer_number = $2 ORDER BY array_position($3::text[], s.code)`, [period, servicer, [...STEP_ORDER]]);
  status = async (period: string, code: string, servicer = SN): Promise<string> => (await this.steps(period, servicer)).find((s) => s.code === code)!.status;
  period = async (period: string, servicer = SN) => (await this.db.query<{ id: string; status: string; reopen_count: number; current_attestation_id: string | null }>(`SELECT id::text AS id, status, reopen_count, current_attestation_id::text AS current_attestation_id FROM close_periods WHERE kind = 'month' AND period = $1 AND servicer_number = $2`, [period, servicer]))[0]!;
  timer = (code: string, subjectId?: string) => this.db.query<{ id: string; status: string; due_at: string | null; subject_kind: string; subject_id: string; anchor_date: string }>(`SELECT id::text AS id, status::text AS status, to_char(due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS due_at, subject_kind, subject_id, anchor_date::text AS anchor_date FROM timers WHERE code = $1${subjectId ? " AND subject_id = $2" : ""} ORDER BY armed_at`, subjectId ? [code, subjectId] : [code]);
  /** A section's own event appended as its owner (the Given of a sentence). */
  ownerEvent = (type: string, payload: Record<string, unknown>, actor: Actor, aggregate?: { kind: string; id: string }) => this.rt.uow.run({}, (ctx) => ctx.events.append({ type, actor, payload, ...(aggregate ? { aggregate } : {}) }), { clock: this.clock });
  /** 6.3's own month-end cut-off and daily close through 6.3's own tool (`timer.*`), one per custodial account. */
  closePeriod63 = (account: string, kind: "pi" | "ti", periodEnd: string, remittance?: string) => this.rt.execute({ process: "6.3", name: "timer.*", loanId: "", actor: AGENT, input: { op: "close_period", period_end: periodEnd, custodial_account_id: account, account_kind: kind, ...(remittance ? { remittance_type: remittance } : {}) } });
  closeDay63 = (asOf: string, bank: bigint, cashbook: bigint) => this.rt.execute({ process: "6.3", name: "timer.*", loanId: "", actor: AGENT, input: { op: "close_day", custodial_account_id: this.fx.custodial.pi, as_of_date: asOf, bank_closing_ledger_cents: bank, deposits_in_transit_cents: FIG.EX_A_DEPOSITS_IN_TRANSIT, disbursements_in_transit_cents: 0n, adjustments_cents: 0n, cashbook_cents: cashbook } });
  /** 6.3's own Form 496 chain (`form496.generate`, draft → review → complete) — its receipt `custodial.reconciliation.completed{kind: monthly_form_496, period}`. */
  form496 = (period: string, bank: bigint, l3: bigint, cashbook: bigint) => this.rt.execute({ process: "6.3", name: "form496.generate", loanId: "", actor: AGENT, input: { kind: "ss", period, custodial_account_id: this.fx.custodial.pi, servicer_number: SN, remittance_type: REMITTANCE, ...FORM_496_INPUT(bank, l3, cashbook), section_iii: [{ id: this.dit, category: "deposit_in_transit", amount_cents: FIG.EX_A_DEPOSITS_IN_TRANSIT, loan_id: "LBX-0930-07 (14 loans listed)", root_cause: "lockbox batch LBX-0930-07 posted 9/30, bank credit 10/1", first_seen_on: "2026-09-30", evidence_refs: [this.dit, this.stmt?.document_id ?? ""] }], preparer_run_id: "run-prep", posting_run_ids: ["run-cashiering"], complete: true } });
  /** 5.1's own period close (`closeReportingPeriod`, rule 10's checklist complete) → `investor_reporting_periods.closed{period, checklist_complete: true}`. */
  closePeriod51 = (period: string, at: string) => this.rt.uow.run({}, (ctx) => closeReportingPeriod(ctx.events, { servicer_number: SN, escrow_events: false, closed_at_ms: Date.parse(at), actor: { kind: "agent", id: "investor-reporting" }, facts: { period, active_loans: 1, loans_with_accepted_event_or_none: 1, open_hard_or_invalid_rejects: 0, removals: [], trial_balance_diff_loans: 0, soft_rejects_without_triage: 0, cash_position_variance_cents: 0n, delinquency_file_accepted: true, escrow_attestation_prepared: "not_required" } }), { clock: this.clock });
  async bookComposition(period: string, l3 = FIG.EX_A_L3_PREPAID_NET): Promise<void> {
    for (const [code, cents] of Object.entries(COMPOSITION(l3))) await this.db.query(`INSERT INTO remittance_components (custodial_account_id, period, remittance_type, pool_class, component_code, amount_cents) VALUES ($1, $2, $3, 'mbs', $4, $5) ON CONFLICT (custodial_account_id, period, component_code) DO UPDATE SET amount_cents = EXCLUDED.amount_cents`, [this.fx.custodial.pi, period, REMITTANCE, code, cents]);
  }
  /** One balanced custodial set on the P&I account (Dr custodial_pi_cash / Cr fnma_remittance_payable): 2.1's cash-in postings in aggregate, or 2.1's reversal (negative, `reversesSetId`). */
  async bookCash(cents: bigint, effective: string, ruleRef: string, description: string, reverses?: string): Promise<string> {
    const id = randomUUID();
    await this.db.tx((q) => new PgLedgerRepository(q).post({ id, effectiveDate: D(effective), description, postedAt: this.clock.now(), ...(reverses ? { reversesSetId: reverses } : {}), lines: [
      { id: randomUUID(), setId: id, account: { scope: "custodial", custodialAccountId: this.fx.custodial.pi, account: "custodial_pi_cash" }, amountCents: cents, ruleRef, sequence: 1 },
      { id: randomUUID(), setId: id, account: { scope: "custodial", custodialAccountId: this.fx.custodial.pi, account: "fnma_remittance_payable" }, amountCents: -cents, ruleRef, sequence: 2 }] } as unknown as Parameters<PgLedgerRepository["post"]>[0], q));
    return id;
  }
  /** The stored statement: a `documents` row (sha256 of the bytes) and the bytes behind the port. */
  async storeStatement(asOf: string, closingCents: bigint, account = this.fx.custodial.pi): Promise<string> {
    const bytes = Buffer.from(bai2(asOf, closingCents), "utf8"); const id = randomUUID();
    await this.db.query(`INSERT INTO documents (id, kind, sha256, byte_size, storage_uri, mime_type, retention_class, metadata) VALUES ($1, 'bank_statement', $2, $3, $4, 'text/plain', 'corporate_7y', $5::jsonb)`, [id, createHash("sha256").update(bytes).digest("hex"), bytes.length, `fake-blob://${id}`, JSON.stringify({ custodial_account_id: account, as_of_date: asOf, format: "bai2" })]);
    this.docs.set(id, bytes);
    return id;
  }
  /** 6.3's statement of record for the day: the stored file and 6.3's own `custodial.statement.received` receipt naming it (a later receipt for the same day is a restatement). */
  async statementOfRecord(asOf: string, closingCents: bigint, account = this.fx.custodial.pi): Promise<{ document_id: string; event_id: string }> {
    const document_id = await this.storeStatement(asOf, closingCents, account);
    const r = await this.rt.uow.run({}, (ctx) => ctx.events.append({ type: "custodial.statement.received", aggregate: { kind: "custodial_account", id: account }, actor: AGENT, payload: { custodial_account_id: account, statement_id: `stmt-${asOf}-${document_id.slice(0, 8)}`, file_id: document_id, document_id, format: "bai2", as_of_date: asOf, control_totals_ok: true, closing_ledger_cents: closingCents.toString(), closing_available_cents: null, balance_of_record: "closing_ledger_015_CLBD", all_active_accounts: true, active_accounts: [account], received_accounts: [account] } }), { clock: this.clock });
    const stmt = { document_id, event_id: r.events[0]!.id };
    if (account === this.fx.custodial.pi) this.stmt = stmt;
    return stmt;
  }
  /** 6.3's in-transit item of worked example A: the lockbox batch posted 9/30, bank credit 10/1 (rule 2 iv's register). */
  async depositInTransit(cents: bigint, firstSeen: string): Promise<string> {
    const id = randomUUID();
    await this.db.query(`INSERT INTO reconciliation_items (id, custodial_account_id, category, severity, amount_cents, first_seen_on, root_cause, status) VALUES ($1, $2, 'deposit_in_transit', 'low', $3, $4::date, 'lockbox batch LBX-0930-07 posted 9/30, bank credit 10/1 (14 loans)', 'open')`, [id, this.fx.custodial.pi, cents, firstSeen]);
    this.dit = id; return id;
  }
  /** T1–T3's chain for a month, driven by the owners' own events to the state where `balance_attestation` is planned (period_close, ledger_period_close and metro2_snapshot completed); `form496` planned. */
  async driveMonth(period: string, f: { bank: bigint; cashbook: bigint; l3: bigint }): Promise<void> {
    const pe = periodEndOf(period); const next = addDays(pe, 1); const bd1 = fannieBd(pe, 1); const bd2 = fannieBd(pe, 2);
    await this.sweepAt(et(pe, "23:59"));
    await this.sweepAt(et(next, "00:05"));
    this.fixed().set(et(next, "00:06"));
    await this.bookComposition(period, f.l3);
    await this.statementOfRecord(pe, f.bank);
    await this.ownerEvent("cashiering.daily.run_completed", { as_of_date: pe, run_id: randomUUID(), cycle_code: "cashiering_daily", period_key: pe, loans: 1 }, { kind: "agent", id: "cashiering" });
    await this.closeDay63(pe, f.bank, f.cashbook);
    await this.closePeriod63(this.fx.custodial.pi, "pi", pe, REMITTANCE);
    await this.closePeriod63(this.fx.custodial.ti, "ti", pe);
    await this.ownerEvent("credit.cycle.snapshot_completed", { cycle_id: `m2-${period}`, as_of_date: pe, record_count: 1, omitted: 0, exceptions: [] }, { kind: "agent", id: "credit-reporting" }, { kind: "metro2_cycle", id: `m2-${period}` });
    await this.sweepAt(et(next, "00:10"));
    await this.ownerEvent("investor.lar.run_completed", { as_of_date: bd1, run_id: randomUUID(), cycle_code: "lar_daily", period_key: bd1, units_total: 1, units_done: 1 }, { kind: "agent", id: "investor-reporting" });
    await this.sweepAt(et(bd1, "20:31"));
    await this.closePeriod51(period, et(bd2, "16:00"));
    await this.sweepAt(et(bd2, "16:01"));
  }
  /** prepare (custodial-recon, run R1) → close.review (qc-audit, run R2) → approve (officer, when asked) → attest. */
  async attest(period: string, o: { approve?: boolean; prep?: string; review?: string; confidence?: number } = {}): Promise<{ prep: string; review: string; approval: string | null; out: Record<string, unknown> }> {
    const prep = (await this.tool("close.attest", AGENT, { period, op: "prepare", confidence: o.confidence ?? 0.99, evidence_document_ids: [this.stmt!.document_id, this.dit] }, R(o.prep ?? "R1"))).output as { preparer_decision_id: string };
    const review = (await this.tool("close.review", REVIEWER, { preparer_decision_id: prep.preparer_decision_id }, R(o.review ?? "R2"))).output as { reviewer_decision_id: string; outcome: string };
    const approval = o.approve === false ? null : ((await this.tool("close.attest", OFFICER, { period, op: "approve", rationale: "package reviewed; balances tie" })).output as { officer_approval_id: string }).officer_approval_id;
    const out = (await this.tool("close.attest", AGENT, { period, preparer_decision_id: prep.preparer_decision_id, reviewer_decision_id: review.reviewer_decision_id }, R(o.prep ?? "R1"))).output as Record<string, unknown>;
    return { prep: prep.preparer_decision_id, review: review.reviewer_decision_id, approval, out };
  }
  attestationRow = (id: string) => this.db.query<Record<string, string | null>>(`SELECT id::text AS id, kind, outcome, as_of::text AS as_of, custodial_account_id::text AS custodial_account_id, remittance_type, bank_closing_ledger_cents::text AS bank_closing_ledger_cents, deposits_in_transit_cents::text AS deposits_in_transit_cents, adjusted_depository_cents::text AS adjusted_depository_cents, composition_snapshot::text AS composition_snapshot, composition_l12_cents::text AS composition_l12_cents, cashbook_cents::text AS cashbook_cents, variance_cents::text AS variance_cents, confidence::text AS confidence, preparer_decision_id::text AS preparer_decision_id, reviewer_decision_id::text AS reviewer_decision_id, officer_approval_id::text AS officer_approval_id, human_approval_flag::text AS human_approval_flag, supersedes_attestation_id::text AS supersedes_attestation_id, created_at::text AS created_at FROM close_attestations WHERE id = $1`, [id]).then((r) => r[0]!);
}

let S: Scenario;
test.before(async () => { if (skip) return; S = await Scenario.open(); });
test.after(async () => { if (!skip) await S.closeDb(); });

test("35.4-T1: Given the demo book on the hosted runtime and the sweep's first run at/after 2026-10-01 00:05 ET, when 35.3's planner emits `ledger.month.ended{period_key: \"2026-09\", period_end: \"2026-09-30\"}` on the global subject and `close.open` runs, then exactly one `close_periods` row exists (kind month, period 2026-09, status open) with the 11 month-chain steps of rule 1 plus `eligibility` (September is a quarter-end) each carrying the table's `depends_on`, `eod_cutoff` is `planned` and `custodial_day_close`, `metro2_snapshot`, `lar`, `period_close`, `ledger_period_close`, `balance_attestation`, `form496`, `form496a`, `qc_cycle`, `star` and `eligibility` are `blocked`, `close.period.opened` is logged once, `SM_CLOSE_PERIOD_OPEN_BD1` (due 2026-10-01 17:00 ET) is satisfied and `SM_CLOSE_ATTEST_BD5` is armed with `due_at` 2026-10-07 17:00 ET; a second `close.open` for 2026-09 returns the same row, adds no step and logs no second `close.period.opened`.", { skip }, async () => {
  // the last sweep of September, then the first at/after 2026-10-01 00:05 ET: the planner's first pass in the new month emits `ledger.month.ended` once on the global subject
  await S.sweepAt(et("2026-09-30", "23:59"));
  const first = await S.sweepAt(et("2026-10-01", "00:05"));
  assert.equal(first.close?.month_ended_emitted, "2026-09", first.close?.line);
  const ended = await S.db.query<{ payload: Record<string, unknown>; aggregate_kind: string }>(`SELECT payload, aggregate_kind FROM loan_events WHERE type = 'ledger.month.ended' AND payload->>'period_key' = '2026-09'`);
  assert.equal(ended.length, 1); assert.deepEqual([ended[0]!.payload["period_key"], ended[0]!.payload["period_end"], ended[0]!.aggregate_kind], ["2026-09", "2026-09-30", "global"]);
  const periods = await S.db.query<{ id: string; kind: string; status: string; period_end: string }>(`SELECT id::text AS id, kind, status, period_end::text AS period_end FROM close_periods WHERE period = '2026-09' AND servicer_number = $1`, [SN]);
  assert.equal(periods.length, 1); assert.equal(periods[0]!.kind, "month"); assert.equal(periods[0]!.status, "open"); assert.equal(periods[0]!.period_end, "2026-09-30");
  const s = await S.steps("2026-09");
  assert.deepEqual(s.map((x) => x.code), ["eod_cutoff", "custodial_day_close", "metro2_snapshot", "lar", "period_close", "ledger_period_close", "balance_attestation", "form496", "form496a", "qc_cycle", "star", "eligibility"]);   // the 11 + eligibility (quarter end)
  assert.deepEqual(Object.fromEntries(s.map((x) => [x.code, x.depends_on])), { eod_cutoff: [], custodial_day_close: ["eod_cutoff"], metro2_snapshot: ["eod_cutoff"], lar: ["eod_cutoff"], period_close: ["lar"], ledger_period_close: ["custodial_day_close"], balance_attestation: ["ledger_period_close", "period_close", "metro2_snapshot"], form496: ["ledger_period_close", "period_close"], form496a: ["ledger_period_close"], qc_cycle: ["period_close"], star: ["period_close"], eligibility: ["period_close"] });
  assert.equal(s.find((x) => x.code === "eod_cutoff")!.status, "planned");
  for (const code of ["custodial_day_close", "metro2_snapshot", "lar", "period_close", "ledger_period_close", "balance_attestation", "form496", "form496a", "qc_cycle", "star", "eligibility"]) assert.equal(s.find((x) => x.code === code)!.status, "blocked", code);
  assert.equal(await S.count(`FROM loan_events WHERE type = 'close.period.opened' AND payload->>'period' = '2026-09'`), 1);
  const [open] = await S.timer("SM_CLOSE_PERIOD_OPEN_BD1"); assert.equal(open!.status, "satisfied"); assert.equal(open!.due_at, et("2026-10-01", "17:00")); assert.equal(open!.subject_kind, "global");
  const [attest] = await S.timer("SM_CLOSE_ATTEST_BD5", periodAggregate(SN, "2026-09").id); assert.equal(attest!.status, "armed"); assert.equal(attest!.due_at, et("2026-10-07", "17:00")); assert.equal(attest!.anchor_date, "2026-09-30");
  // a second close.open (35.3's planner re-emitting after a crash, or a hand call) returns the same row: no new step, no second `close.period.opened`, the duplicate journaled
  const again = (await S.tool("close.open", AGENT, { period: "2026-09", source_event_id: randomUUID() })).output as { created: boolean; close_period_id: string };
  assert.equal(again.created, false); assert.equal(again.close_period_id, periods[0]!.id);
  assert.equal(await S.count(`FROM close_period_steps WHERE close_period_id = $1`, [periods[0]!.id]), 12);
  assert.equal(await S.count(`FROM loan_events WHERE type = 'close.period.opened' AND payload->>'period' = '2026-09'`), 1);
  assert.equal(await S.count(`FROM close_period_events WHERE close_period_id = $1 AND type = 'close.period.opened' AND payload->>'duplicate' = 'true'`, [periods[0]!.id]), 1);
  assert.equal((await S.timer("SM_CLOSE_ATTEST_BD5", periodAggregate(SN, "2026-09").id)).length, 1, "no second clock");
});
test("35.4-T2: Given period 2026-09 open with `ledger.period.closed` recorded for every P&I account but no `investor_reporting_periods.closed{period: \"2026-09\", checklist_complete: true}`, when the planner runs, then no 35.3 `jobs` row exists for `form496`, `close.board{period: \"2026-09\"}` lists `form496` as `blocked` with `missing: [\"period_close\"]`, and `close.step.start{step: \"form496\"}` by hand is refused `STEP_BLOCKED{missing: [\"period_close\"]}` and writes nothing.", { skip }, async () => {
  S.fixed().set(et("2026-10-01", "09:00"));
  await S.bookComposition("2026-09");
  await S.bookCash(FIG.EX_A_CASHBOOK, "2026-09-29", "2.1:r8:cash_in", "September collections through 9/30 (2.1's cash-in sets, in aggregate)");
  await S.statementOfRecord("2026-09-30", FIG.EX_A_BANK_CLOSING_LEDGER);
  await S.depositInTransit(FIG.EX_A_DEPOSITS_IN_TRANSIT, "2026-09-30");
  // the owners' receipts: 35.5's day (the stand-in literal), 6.3's daily close and its month-end cut-off per account (6.3's own tool)
  await S.ownerEvent("cashiering.daily.run_completed", { as_of_date: "2026-09-30", run_id: randomUUID(), cycle_code: "cashiering_daily", period_key: "2026-09-30", loans: 1 }, { kind: "agent", id: "cashiering" });
  await S.closeDay63("2026-09-30", FIG.EX_A_BANK_CLOSING_LEDGER, FIG.EX_A_CASHBOOK);
  await S.closePeriod63(S.fx.custodial.pi, "pi", "2026-09-30", REMITTANCE);
  await S.closePeriod63(S.fx.custodial.ti, "ti", "2026-09-30");
  await S.sweepAt(et("2026-10-01", "09:01"));
  assert.equal(await S.status("2026-09", "eod_cutoff"), "completed"); assert.equal(await S.status("2026-09", "custodial_day_close"), "completed"); assert.equal(await S.status("2026-09", "ledger_period_close"), "completed");
  assert.equal(await S.status("2026-09", "form496"), "blocked");
  // no 35.3 job for form496: its table when present, else the journal (the planner records the units it plans there)
  if ((await S.db.query<{ r: string | null }>(`SELECT to_regclass('public.jobs')::text AS r`))[0]!.r) assert.equal(await S.count(`FROM jobs WHERE cycle_code = 'form_496_monthly' AND period_key = '2026-09'`), 0);
  assert.equal(await S.count(`FROM close_period_events e JOIN close_period_steps s ON s.id = e.step_id WHERE s.code = 'form496' AND e.type = 'close.step.planned'`), 0);
  const board = (await S.tool("close.board", AGENT, { period: "2026-09" })).output as { steps: { code: string; status: string; missing: string[] }[] };
  const f = board.steps.find((x) => x.code === "form496")!; assert.equal(f.status, "blocked"); assert.deepEqual(f.missing, ["period_close"]);
  const before = { j: await S.count(`FROM close_period_events`), e: await S.count(`FROM loan_events`), s: JSON.stringify(await S.steps("2026-09")), d: await S.count(`FROM agent_decisions`) };
  const r = await refused(S.tool("close.step.start", AGENT, { period: "2026-09", step: "form496" }));
  assert.equal(r.code, "STEP_BLOCKED"); assert.deepEqual(r.detail?.["missing"], ["period_close"]);
  assert.equal(await S.count(`FROM close_period_events`), before.j); assert.equal(await S.count(`FROM loan_events`), before.e); assert.equal(JSON.stringify(await S.steps("2026-09")), before.s); assert.equal(await S.count(`FROM agent_decisions`), before.d);
});
test("35.4-T3: Given period 2026-09 with `ledger.period.closed{period_end: \"2026-09-30\"}` for every P&I account and 5.1's `investor_reporting_periods.closed{period: \"2026-09\", checklist_complete: true}`, when the next sweep runs, then `form496` is `planned` with one 35.3 job per (custodial account × remittance type), `close.step.started{step_id}` is logged when the first unit is claimed and `SM_CLOSE_STEP_STALLED_2BD` is armed on the period aggregate anchored on `started_at`; given only one of the two receipts, then `form496` is still `blocked`.", { skip }, async () => {
  // only one of the two receipts (ledger.period.closed, from T2) → still blocked
  assert.equal(await S.status("2026-09", "form496"), "blocked");
  // the second receipt: 35.3's BD1 LAR run (the stand-in literal) unblocks period_close; 5.1's own close emits investor_reporting_periods.closed{checklist_complete: true}
  S.fixed().set(et("2026-10-01", "20:30"));
  await S.ownerEvent("investor.lar.run_completed", { as_of_date: "2026-10-01", run_id: randomUUID(), cycle_code: "lar_daily", period_key: "2026-10-01", units_total: 1, units_done: 1 }, { kind: "agent", id: "investor-reporting" });
  await S.sweepAt(et("2026-10-01", "20:31"));
  assert.equal(await S.status("2026-09", "lar"), "completed"); assert.equal(await S.status("2026-09", "period_close"), "planned");
  await S.closePeriod51("2026-09", et("2026-10-02", "16:00"));
  await S.sweepAt(et("2026-10-02", "16:01"));
  assert.equal(await S.status("2026-09", "period_close"), "completed");
  const f = (await S.steps("2026-09")).find((x) => x.code === "form496")!;
  assert.equal(f.status, "planned"); assert.equal(f.expected_receipts, 1, "one unit per (P&I account × remittance type): one S/S MBS account");
  const planned = await S.db.query<{ payload: { units: string[]; cycle_code: string } }>(`SELECT e.payload FROM close_period_events e JOIN close_period_steps s ON s.id = e.step_id WHERE s.code = 'form496' AND e.type = 'close.step.planned'`);
  assert.equal(planned.length, 1); assert.equal(planned[0]!.payload.cycle_code, "form_496_monthly"); assert.deepEqual(planned[0]!.payload.units, [`${S.fx.custodial.pi}:${REMITTANCE}`]);
  if ((await S.db.query<{ r: string | null }>(`SELECT to_regclass('public.jobs')::text AS r`))[0]!.r) assert.equal(await S.count(`FROM jobs WHERE cycle_code = 'form_496_monthly' AND period_key = '2026-09'`), 1);
  // the first unit claimed (35.3's executor, or by hand): close.step.started, the stall clock armed on the period aggregate from started_at
  const startedAt = et("2026-10-05", "10:00"); S.fixed().set(startedAt);
  await S.tool("close.step.start", AGENT, { period: "2026-09", step: "form496" });
  const started = await S.db.query<{ payload: Record<string, unknown>; aggregate_kind: string; aggregate_id: string }>(`SELECT payload, aggregate_kind, aggregate_id FROM loan_events WHERE type = 'close.step.started' AND payload->>'step' = 'form496'`);
  assert.equal(started.length, 1); assert.equal(started[0]!.payload["step_id"], f.id);
  assert.equal(started[0]!.aggregate_kind, "close_period"); assert.equal(started[0]!.aggregate_id, stepAggregate(SN, "2026-09", "form496").id); assert.ok(started[0]!.aggregate_id.startsWith(periodAggregate(SN, "2026-09").id + ":"));
  const [stall] = await S.timer("SM_CLOSE_STEP_STALLED_2BD", stepAggregate(SN, "2026-09", "form496").id);
  assert.equal(stall!.status, "armed"); assert.equal(stall!.subject_kind, "close_period"); assert.equal(stall!.anchor_date, "2026-10-05"); assert.equal(stall!.due_at, et("2026-10-07", "17:00"));
  assert.equal(await S.status("2026-09", "form496"), "running");
});
test("35.4-T4: Given the demo clock advanced from 2026-09-28 to 2026-11-16 with FAKE reviewers on, then `close_periods` rows exist for 2026-09 and 2026-10, every `close_period_events` receipt for each period was recorded once (unique `source_event_id`), for every step `completed_at` is at or after each of its dependencies' `completed_at` (no step completed before a dependency), 2026-09 reached `attested` no later than 2026-10-07 17:00 ET and `closed` once `form496`, `form496a`, `qc_cycle`, `star` and `eligibility` had their receipts, and the receipts appear in the journal in the order `eod_cutoff → custodial_day_close → lar → period_close → ledger_period_close → balance_attestation → form496`.", { skip }, async () => {
  // the hosted runtime's demo environment: the demo clock (an OffsetClock) stepping one ET day at a time through the sweeps, the FAKE reviewers on (35.7: every human a FAKE before go-live — the officer's approval record and the qc_officer's cycle signature), the FAKE neighbours standing in for the owners not in this tree (35.5's day, 35.3's LAR, 8.1's snapshot, 18.7's test)
  const T = await Scenario.open("t4", { demo: true });
  try {
    // the demo book before the advance, as the owners' own rows: September's worked-example figures (composition, cashbook, the 9/30 statement of record, the lockbox batch in transit until its 10/1 credit) and October's (nothing new posted; the batch credited, so the 10/31 closing ledger is the cashbook); the T&I account's statements at zero
    await T.bookComposition("2026-09"); await T.bookComposition("2026-10");
    await T.bookCash(FIG.EX_A_CASHBOOK, "2026-09-29", "2.1:r8:cash_in", "September collections through 9/30 (2.1's cash-in sets, in aggregate)");
    await T.statementOfRecord("2026-09-30", FIG.EX_A_BANK_CLOSING_LEDGER);
    const dit = await T.depositInTransit(FIG.EX_A_DEPOSITS_IN_TRANSIT, "2026-09-30");
    await T.db.query(`UPDATE reconciliation_items SET status = 'cleared', resolved_on = '2026-10-01' WHERE id = $1`, [dit]);   // bank credit 10/1 (worked example A)
    await T.statementOfRecord("2026-10-31", FIG.EX_A_CASHBOOK);
    await T.statementOfRecord("2026-09-30", 0n, T.fx.custodial.ti); await T.statementOfRecord("2026-10-31", 0n, T.fx.custodial.ti);
    const r = await advanceDemoClock({ runtime: T.rt, clock: T.clock as OffsetClock }, { to: et("2026-11-16", "12:00"), budget_ms: 900_000 });
    assert.equal(r.complete, true, "every day stepped"); assert.equal(r.days_crossed, 49); assert.equal(r.to, et("2026-11-16", "12:00"));
    const want = ["eod_cutoff", "custodial_day_close", "lar", "period_close", "ledger_period_close", "balance_attestation", "form496"];
    for (const period of ["2026-09", "2026-10"]) {
      const p = (await T.db.query<{ id: string; status: string; attested_at: string; closed_at: string }>(`SELECT id::text AS id, status, to_char(attested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS attested_at, to_char(closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS closed_at FROM close_periods WHERE kind = 'month' AND period = $1 AND servicer_number = $2`, [period, SN]))[0];
      assert.ok(p, `${period} exists`); assert.equal(p.status, "closed", `${period} closed`);
      const steps = await T.steps(period); const byCode = new Map(steps.map((s) => [s.code, s]));
      for (const s of steps) {
        assert.equal(s.status, "completed", `${period} ${s.code}`); assert.ok(s.completed_at, `${period} ${s.code} completed_at`);
        for (const d of s.depends_on) assert.ok(s.completed_at! >= byCode.get(d)!.completed_at!, `${period} ${s.code} (${s.completed_at}) completed before its dependency ${d} (${byCode.get(d)!.completed_at})`);
        assert.equal(s.received, s.expected_receipts, `${period} ${s.code} receipts`);
      }
      // every receipt recorded once: a source_event_id on each, none twice
      assert.equal(await T.count(`FROM close_period_events WHERE close_period_id = $1 AND type = 'close.receipt.recorded' AND source_event_id IS NULL`, [p.id]), 0);
      assert.equal((await T.db.query(`SELECT source_event_id FROM close_period_events WHERE close_period_id = $1 AND type = 'close.receipt.recorded' GROUP BY source_event_id HAVING count(*) > 1`, [p.id])).length, 0, `${period}: a receipt recorded twice`);
      assert.equal(await T.count(`FROM close_period_events WHERE close_period_id = $1 AND type = 'close.receipt.recorded'`, [p.id]), steps.reduce((a, s) => a + s.received, 0), `${period}: one journal row per receipt`);
      // the journal order of the receipts (first receipt of each step)
      const order = (await T.db.query<{ code: string }>(`SELECT s.code FROM close_period_events e JOIN close_period_steps s ON s.id = e.step_id WHERE e.close_period_id = $1 AND e.type = 'close.receipt.recorded' ORDER BY e.occurred_at, e.seq`, [p.id])).map((x) => x.code);
      assert.deepEqual([...new Set(order.filter((c) => want.includes(c)))], want, `${period} journal order: ${order.join(" → ")}`);
      // closed only once form496, form496a, qc_cycle, star and eligibility (September: a quarter end) had their receipts — never before the last of them
      for (const c of ["form496", "form496a", "qc_cycle", "star", ...(period === "2026-09" ? ["eligibility"] : [])]) assert.ok(p.closed_at >= byCode.get(c)!.completed_at!, `${period} closed at ${p.closed_at} before ${c} completed at ${byCode.get(c)!.completed_at}`);
      assert.ok(p.attested_at <= p.closed_at);
      // the attestation to the cent by the agent, reviewed by qc-audit, approved by the FAKE officer's own record (rule 7; 35.7), and the FAKE stand-ins marked as such
      const a = await T.db.query<{ outcome: string; variance_cents: string; approver: string | null }>(`SELECT a.outcome, a.variance_cents::text AS variance_cents, d.approved_by::text AS approver FROM close_attestations a LEFT JOIN agent_decisions d ON d.id = a.officer_approval_id WHERE a.close_period_id = $1 AND a.kind = 'balance' ORDER BY a.created_at`, [p.id]);
      assert.equal(a.length, 1, `${period}: one attestation`); assert.equal(a[0]!.outcome, "attested"); assert.equal(a[0]!.variance_cents, "0"); assert.match(a[0]!.approver ?? "", /FAKE:officer/);
    }
    // September attested no later than BD5 17:00 ET (SM_CLOSE_ATTEST_BD5, due 2026-10-07 17:00 ET) — and its clock satisfied
    const sep = (await T.db.query<{ attested_at: string }>(`SELECT to_char(attested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS attested_at FROM close_periods WHERE kind = 'month' AND period = '2026-09' AND servicer_number = $1`, [SN]))[0]!;
    assert.ok(sep.attested_at <= et("2026-10-07", "17:00"), `2026-09 attested at ${sep.attested_at}`);
    assert.equal((await T.timer("SM_CLOSE_ATTEST_BD5", periodAggregate(SN, "2026-09").id))[0]!.status, "satisfied");
    // the owners' receipts are the owners' own events under their own actors; the stand-ins say FAKE, the real runs (6.3's day close and cut-off, 5.1's close, 6.3's Form 496, 6.4's Form 496A, 18.3's compute) do not
    assert.equal(await T.count(`FROM loan_events WHERE type IN ('cashiering.daily.run_completed', 'investor.lar.run_completed', 'credit.cycle.snapshot_completed', 'qc.cycle.signed', 'eligibility.computed') AND payload->>'vendor' = 'FAKE'`), 5 + 5 - 1);   // eligibility only at the quarter end
    assert.equal(await T.count(`FROM loan_events WHERE (type IN ('custodial.reconciliation.daily_completed', 'ledger.period.closed', 'investor_reporting_periods.closed', 'star.metrics.computed') OR (type = 'custodial.reconciliation.completed' AND payload->>'kind' = 'monthly_form_496')) AND payload ? 'vendor'`), 0);
    assert.equal(await T.count(`FROM loan_events WHERE type = 'custodial.reconciliation.completed' AND payload->>'kind' = 'monthly_form_496' AND payload ? 'xlsx_sha256'`), 2, "6.3's own Form 496 per period, rendered");
    // 6.4's form496a.generate is not on the bus (spec/registry/agents.json's 6.4 row is empty — src/app/tools/section06.ts): the FAKE stands in for the T&I receipt, marked as such, until 6.4 registers it
    assert.equal(await T.count(`FROM loan_events WHERE type = 'custodial.reconciliation.completed' AND payload->>'kind' = 'monthly_form_496a' AND payload->>'vendor' = 'FAKE'`), 2);
    assert.equal(await T.count(`FROM loan_events WHERE type = 'fake_reviewer.approved' AND payload->>'kind' = 'close_attestation_approval'`), 2);
    // no reopen, no variance, no plug: nothing but the owners' own postings on the custodial ledger
    assert.equal(await T.count(`FROM close_reopens`), 0); assert.equal(await T.count(`FROM close_period_events WHERE type = 'close.attestation.variance'`), 0);
    assert.equal(await T.count(`FROM ledger_entry_sets`), 1);
  } finally { await T.closeDb(); }
});
test("35.4-T5: Given the September 2026 S/S MBS P&I account with 6.3's worked-example balances — bank closing ledger $1,254,300.55, deposits in transit $12,450.00, composition L3 $8,120.40, L4 $45,000.00, L5 $0.00, L7 $3,210.15, L8 −$22,580.00, L9 $1,233,000.00, L10 $0.00, L11 $0.00 — and a cashbook of 126,675,055 cents on `custodial_pi_cash`, when `close.attest` runs after `ledger_period_close`, `period_close` and `metro2_snapshot` completed with a passed `close.review` and an `officer` approval, then one `close_attestations` row has `adjusted_depository_cents = 126675055n` ($1,266,750.55), `composition_l12_cents = 126675055n`, `cashbook_cents = 126675055n`, `variance_cents === 0n` ($0.00), `composition_snapshot` = {L3: \"812040\", L4: \"4500000\", L5: \"0\", L7: \"321015\", L8: \"-2258000\", L9: \"123300000\", L10: \"0\", L11: \"0\"}, both decision ids and the officer approval id, `close.period.attested{attestation_id, variance_cents: \"0\"}` is logged, `SM_CLOSE_ATTEST_BD5` is satisfied, `close_periods.status = attested`, and 6.3's `FNMA_F496_PI_RECON_45` is still `armed` with `due_at` 2026-11-13 17:00.", { skip }, async () => {
  // the worked-example figures, to the cent: 125,430,055 + 1,245,000 = 126,675,055 = Σ L3..L11 = the cashbook
  assert.equal(FIG.EX_A_BANK_CLOSING_LEDGER, 125_430_055n); assert.equal(FIG.EX_A_DEPOSITS_IN_TRANSIT, 1_245_000n); assert.equal(FIG.EX_A_BANK_CLOSING_LEDGER + FIG.EX_A_DEPOSITS_IN_TRANSIT, FIG.EX_A_ADJUSTED_DEPOSITORY); assert.equal(FIG.EX_A_ADJUSTED_DEPOSITORY, 126_675_055n);
  assert.deepEqual([FIG.EX_A_L3_PREPAID_NET, FIG.EX_A_L4_CURTAILMENTS, FIG.EX_A_L5_INTEREST_FUNDINGS, FIG.EX_A_L7_PAYOFF_FIXED_NET, FIG.EX_A_L8_DELINQUENT_PI_NET, FIG.EX_A_L9_FNMA_RECEIVABLE], [812_040n, 4_500_000n, 0n, 321_015n, -2_258_000n, 123_300_000n]);
  assert.equal(812_040n + 4_500_000n + 0n + 321_015n - 2_258_000n + 123_300_000n + 0n + 0n, FIG.EX_A_L12); assert.equal(FIG.EX_A_CASHBOOK, 126_675_055n); assert.equal(FIG.EX_A_ADJUSTED_DEPOSITORY - FIG.EX_A_CASHBOOK, FIG.EX_A_VARIANCE); assert.equal(FIG.EX_A_VARIANCE, 0n);
  // 8.1's snapshot for 9/30 (its own event, the stand-in) completes metro2_snapshot; the planner plans balance_attestation
  S.fixed().set(et("2026-10-05", "12:00"));
  await S.ownerEvent("credit.cycle.snapshot_completed", { cycle_id: "m2-2026-09", as_of_date: "2026-09-30", record_count: 1, omitted: 0, exceptions: [] }, { kind: "agent", id: "credit-reporting" }, { kind: "metro2_cycle", id: "m2-2026-09" });
  await S.sweepAt(et("2026-10-05", "12:01"));
  assert.equal(await S.status("2026-09", "metro2_snapshot"), "completed"); assert.equal(await S.status("2026-09", "balance_attestation"), "planned");
  const before496 = await S.timer("FNMA_F496_PI_RECON_45");
  const a = await S.attest("2026-09");
  assert.equal(a.out["outcome"], "attested");
  const row = await S.attestationRow(String(a.out["attestation_id"]));
  assert.equal(big(row.adjusted_depository_cents), 126_675_055n); assert.equal(big(row.composition_l12_cents), 126_675_055n); assert.equal(big(row.cashbook_cents), 126_675_055n); assert.equal(big(row.variance_cents), 0n);
  assert.equal(big(row.bank_closing_ledger_cents), FIG.EX_A_BANK_CLOSING_LEDGER); assert.equal(big(row.deposits_in_transit_cents), FIG.EX_A_DEPOSITS_IN_TRANSIT);
  assert.deepEqual(JSON.parse(row.composition_snapshot!), { L3: "812040", L4: "4500000", L5: "0", L7: "321015", L8: "-2258000", L9: "123300000", L10: "0", L11: "0" });
  assert.equal(row.preparer_decision_id, a.prep); assert.equal(row.reviewer_decision_id, a.review); assert.equal(row.officer_approval_id, a.approval); assert.equal(row.human_approval_flag, "true"); assert.equal(row.remittance_type, "ss_mbs"); assert.equal(row.as_of, "2026-09-30");
  const attested = await S.db.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM loan_events WHERE type = 'close.period.attested' AND payload->>'period' = '2026-09'`);
  assert.equal(attested.length, 1); assert.equal(attested[0]!.payload["attestation_id"], row.id); assert.equal(attested[0]!.payload["variance_cents"], "0");
  const [bd5] = await S.timer("SM_CLOSE_ATTEST_BD5", periodAggregate(SN, "2026-09").id); assert.equal(bd5!.status, "satisfied");
  assert.equal((await S.period("2026-09")).status, "attested"); assert.equal((await S.period("2026-09")).current_attestation_id, row.id);
  assert.equal(await S.status("2026-09", "balance_attestation"), "completed");
  const after496 = await S.timer("FNMA_F496_PI_RECON_45");
  assert.ok(after496.length >= 1); assert.equal(after496[0]!.status, "armed"); assert.equal(after496[0]!.due_at, et("2026-11-13", "17:00")); assert.deepEqual(after496.map((t) => t.status + t.due_at), before496.map((t) => t.status + t.due_at), "6.3's clock untouched by the attestation");
});
test("35.4-T6: Given the same account with the cashbook at 126,675,055 cents but a bank closing ledger of $1,253,050.55 and no in-transit item explaining the $1,250.00, when `close.attest` runs, then a `close_attestations` row is written with `outcome = variance` and `variance_cents = -125000n`, one `qc_officer` escalation names the period, account and variance, `close.attestation.variance` is logged, `close_periods.status` stays `open`, the row counts of `ledger_lines`, `payments`, `reconciliations` and `reconciliation_items` are identical before and after, and `close.attest` called again with `force: true` (and separately with `tolerance_cents: \"125000\"`) is refused `NO_PLUG` with no row written.", { skip }, async () => {
  const s = await Scenario.open("t6");
  try {
    assert.equal(FIG.EX_B_RESTATED_CLOSING_LEDGER, 125_305_055n); assert.equal(FIG.EX_A_BANK_CLOSING_LEDGER - FIG.EX_B_RETURNED_ITEM, FIG.EX_B_RESTATED_CLOSING_LEDGER); assert.equal(FIG.EX_B_RETURNED_ITEM, 125_000n);
    assert.equal(FIG.EX_B_RESTATED_CLOSING_LEDGER + FIG.EX_A_DEPOSITS_IN_TRANSIT - FIG.EX_A_CASHBOOK, FIG.EX_B_VARIANCE_BEFORE_CORRECTION); assert.equal(FIG.EX_B_VARIANCE_BEFORE_CORRECTION, -125_000n);
    await s.bookCash(FIG.EX_A_CASHBOOK, "2026-09-29", "2.1:r8:cash_in", "September collections through 9/30");
    await s.depositInTransit(FIG.EX_A_DEPOSITS_IN_TRANSIT, "2026-09-30");
    // the statement of record reads $1,253,050.55: the returned $1,250.00 has no in-transit item (the lockbox batch's $12,450.00 is the only one)
    await s.driveMonth("2026-09", { bank: FIG.EX_B_RESTATED_CLOSING_LEDGER, cashbook: FIG.EX_A_CASHBOOK, l3: FIG.EX_A_L3_PREPAID_NET });
    assert.equal(await s.status("2026-09", "balance_attestation"), "planned");
    const tables = ["ledger_lines", "payments", "reconciliations", "reconciliation_items"];
    const counts = async () => Promise.all(tables.map((t) => s.count(`FROM ${t}`)));
    const before = await counts();
    const a = await s.attest("2026-09");
    assert.equal(a.out["outcome"], "variance");
    const row = await s.attestationRow(String(a.out["attestation_id"]));
    assert.equal(row.outcome, "variance"); assert.equal(big(row.variance_cents), -125_000n); assert.equal(big(row.bank_closing_ledger_cents), 125_305_055n); assert.equal(big(row.adjusted_depository_cents), 126_550_055n); assert.equal(big(row.cashbook_cents), 126_675_055n);
    const esc = await s.db.query<{ owner_role: string; payload: Record<string, unknown> }>(`SELECT owner_role, payload FROM escalations WHERE payload->>'attestation_id' = $1`, [row.id]);
    assert.equal(esc.length, 1); assert.equal(esc[0]!.owner_role, "qc_officer"); assert.equal(esc[0]!.payload["period"], "2026-09"); assert.equal(esc[0]!.payload["custodial_account_id"], s.fx.custodial.pi); assert.equal(esc[0]!.payload["variance_cents"], "-125000");
    assert.equal(await s.count(`FROM loan_events WHERE type = 'close.attestation.variance' AND payload->>'attestation_id' = $1`, [row.id]), 1);
    assert.equal((await s.period("2026-09")).status, "open");
    assert.deepEqual(await counts(), before, "no ledger, payment or reconciliation row written");
    // NO_PLUG: a force or a tolerance is refused before any read — no row, no decision
    const rows = await s.count(`FROM close_attestations`); const decisions = await s.count(`FROM agent_decisions`);
    const f = await refused(s.tool("close.attest", AGENT, { period: "2026-09", force: true })); assert.equal(f.code, "NO_PLUG");
    const t = await refused(s.tool("close.attest", AGENT, { period: "2026-09", tolerance_cents: "125000" })); assert.equal(t.code, "NO_PLUG");
    assert.equal(await s.count(`FROM close_attestations`), rows); assert.equal(await s.count(`FROM agent_decisions`), decisions);
  } finally { await s.closeDb(); }
});
test("35.4-T7: Given the `form496` step started 2026-10-05 10:00 ET with no `custodial.reconciliation.completed{kind: monthly_form_496}` since, when the sweep passes 2026-10-07 17:01 ET, then `SM_CLOSE_STEP_STALLED_2BD` is `breached`, exactly one `ops_analyst` escalation carries `{timer_code: \"SM_CLOSE_STEP_STALLED_2BD\", period: \"2026-09\", step: \"form496\"}`, `close.board` shows the step `stalled`, and 6.3's `FNMA_F496_PI_RECON_45` and `SM_F496_DRAFT_BD10` instances are unchanged (still `armed`, same `due_at`); when the receipt arrives 2026-10-09, then the step is `completed` and the stall label is gone.", { skip }, async () => {
  const f = (await S.steps("2026-09")).find((x) => x.code === "form496")!;
  assert.equal(f.status, "running"); assert.equal(f.started_at, et("2026-10-05", "10:00"));
  const clocksBefore = JSON.stringify([await S.timer("FNMA_F496_PI_RECON_45"), await S.timer("SM_F496_DRAFT_BD10")]);
  await S.sweepAt(et("2026-10-07", "17:01"));
  const [stall] = await S.timer("SM_CLOSE_STEP_STALLED_2BD", stepAggregate(SN, "2026-09", "form496").id); assert.equal(stall!.status, "breached");
  const esc = await S.db.query<{ owner_role: string; payload: Record<string, unknown> }>(`SELECT owner_role, payload FROM escalations WHERE payload->>'timer_code' = 'SM_CLOSE_STEP_STALLED_2BD'`);
  assert.equal(esc.length, 1); assert.equal(esc[0]!.owner_role, "ops_analyst"); assert.equal(esc[0]!.payload["period"], "2026-09"); assert.equal(esc[0]!.payload["step"], "form496");
  const board = (await S.tool("close.board", AGENT, { period: "2026-09" })).output as { steps: { code: string; status: string }[] };
  assert.equal(board.steps.find((x) => x.code === "form496")!.status, "stalled"); assert.equal(await S.status("2026-09", "form496"), "stalled");
  assert.equal(JSON.stringify([await S.timer("FNMA_F496_PI_RECON_45"), await S.timer("SM_F496_DRAFT_BD10")]), clocksBefore, "6.3's clocks untouched");
  assert.ok((await S.timer("FNMA_F496_PI_RECON_45")).every((t) => t.status === "armed") && (await S.timer("SM_F496_DRAFT_BD10")).every((t) => t.status === "armed"));
  // 2026-10-09: 6.3's own Form 496 chain completes — its receipt completes the step; the label is gone
  S.fixed().set(et("2026-10-09", "11:00"));
  const g = (await S.form496("2026-09", FIG.EX_A_BANK_CLOSING_LEDGER, FIG.EX_A_L3_PREPAID_NET, FIG.EX_A_CASHBOOK)).output as { status: string };
  assert.equal(g.status, "completed");
  await S.sweepAt(et("2026-10-09", "11:01"));
  assert.equal(await S.status("2026-09", "form496"), "completed");
  assert.equal(((await S.tool("close.board", AGENT, { period: "2026-09" })).output as { steps: { code: string; status: string }[] }).steps.find((x) => x.code === "form496")!.status, "completed");
  assert.equal((await S.timer("SM_CLOSE_STEP_STALLED_2BD", stepAggregate(SN, "2026-09", "form496").id))[0]!.status, "satisfied_late");
});
test("35.4-T8: Given configuration `custodial.form496.human_approval = on`, when `close.attest` is called by the agent with a passed review and no `officer` approval record, then it is refused `OFFICER_APPROVAL_REQUIRED` and no attestation row, event or timer change exists; when an `agent_decisions` row by `{human, <id>, officer}` with action `close.attest.approve` for the period and account exists, then the attestation is written with `officer_approval_id` and `human_approval_flag = true`; given the flag off, then the attestation is written without an approval and `human_approval_flag = false`; given a request carrying `human_approval_on: false` while the configuration is on, then the request field is ignored and the call is refused `OFFICER_APPROVAL_REQUIRED`; given an `ops_analyst` actor calling `close.attest.approve`, then `ROLE_DENIED`.", { skip }, async () => {
  const s = await Scenario.open("t8");
  try {
    await s.bookCash(FIG.EX_A_CASHBOOK, "2026-09-29", "2.1:r8:cash_in", "September collections through 9/30");
    await s.depositInTransit(FIG.EX_A_DEPOSITS_IN_TRANSIT, "2026-09-30");
    await s.driveMonth("2026-09", { bank: FIG.EX_A_BANK_CLOSING_LEDGER, cashbook: FIG.EX_A_CASHBOOK, l3: FIG.EX_A_L3_PREPAID_NET });
    s.humanApproval = true;
    const prep = ((await s.tool("close.attest", AGENT, { period: "2026-09", op: "prepare", confidence: 0.99, evidence_document_ids: [s.stmt!.document_id, s.dit] }, R("R1"))).output as { preparer_decision_id: string }).preparer_decision_id;
    const review = ((await s.tool("close.review", REVIEWER, { preparer_decision_id: prep }, R("R2"))).output as { reviewer_decision_id: string }).reviewer_decision_id;
    const snapshot = async () => JSON.stringify([await s.count(`FROM close_attestations`), await s.count(`FROM loan_events WHERE type IN ('close.period.attested', 'close.attestation.variance')`), await s.db.query(`SELECT code, status::text AS status, satisfied_at::text AS s FROM timers ORDER BY id`)]);
    const before = await snapshot();
    const r1 = await refused(s.tool("close.attest", AGENT, { period: "2026-09", preparer_decision_id: prep, reviewer_decision_id: review }, R("R1"))); assert.equal(r1.code, "OFFICER_APPROVAL_REQUIRED");
    assert.equal(await snapshot(), before, "no attestation row, event or timer change");
    // the request's own flag is ignored (FLAG_FROM_CONFIG): still refused
    const r2 = await refused(s.tool("close.attest", AGENT, { period: "2026-09", preparer_decision_id: prep, reviewer_decision_id: review, human_approval_on: false }, R("R1"))); assert.equal(r2.code, "OFFICER_APPROVAL_REQUIRED");
    assert.equal(await snapshot(), before);
    // an ops_analyst cannot approve
    const r3 = await refused(s.tool("close.attest", OPS, { period: "2026-09", op: "approve" })); assert.equal(r3.code, "ROLE_DENIED");
    // the flag on with the officer's record {human, <id>, officer} action close.attest.approve for the period and account: written with officer_approval_id, flag true
    const approval = ((await s.tool("close.attest", OFFICER, { period: "2026-09", op: "approve" })).output as { officer_approval_id: string }).officer_approval_id;
    const d = (await s.db.query<{ action: string; approved_by: string; approved_role: string }>(`SELECT action, approved_by, approved_role FROM agent_decisions WHERE id = $1`, [approval]))[0]!;
    assert.deepEqual(d, { action: "close.attest.approve", approved_by: OFFICER.id, approved_role: "officer" });
    const on = (await s.tool("close.attest", AGENT, { period: "2026-09", preparer_decision_id: prep, reviewer_decision_id: review }, R("R1"))).output as { attestation_id: string };
    const onRow = await s.attestationRow(on.attestation_id); assert.equal(onRow.outcome, "attested"); assert.equal(onRow.human_approval_flag, "true"); assert.equal(onRow.officer_approval_id, approval);
    // a written attestation is terminal until a reopen (rule 9): a second close.attest on the attested period is refused, nothing written
    const after = await snapshot();
    const r4 = await refused(s.tool("close.attest", AGENT, { period: "2026-09", preparer_decision_id: prep, reviewer_decision_id: review }, R("R1"))); assert.equal(r4.code, "PERIOD_NOT_OPEN");
    assert.equal(await snapshot(), after);
  } finally { await s.closeDb(); }
  // given the flag off: written without an approval, human_approval_flag = false — the same month on its own database (an attestation, once written, is terminal until a reopen)
  const off = await Scenario.open("t8-off");
  try {
    await off.bookCash(FIG.EX_A_CASHBOOK, "2026-09-29", "2.1:r8:cash_in", "September collections through 9/30");
    await off.depositInTransit(FIG.EX_A_DEPOSITS_IN_TRANSIT, "2026-09-30");
    await off.driveMonth("2026-09", { bank: FIG.EX_A_BANK_CLOSING_LEDGER, cashbook: FIG.EX_A_CASHBOOK, l3: FIG.EX_A_L3_PREPAID_NET });
    off.humanApproval = false;
    const a = await off.attest("2026-09", { approve: false });
    const row = await off.attestationRow(a.out["attestation_id"] as string); assert.equal(row.outcome, "attested"); assert.equal(row.human_approval_flag, "false"); assert.equal(row.officer_approval_id, null);
  } finally { await off.closeDb(); }
});
test("35.4-T9: Given a preparer decision by `custodial-recon` run R1 for the September attestation, when `close.review` is called with run R1's id or with the preparer's credentials, then it is refused `REVIEWER_NOT_INDEPENDENT`; when `qc-audit` runs it under `reviewer_roles` credentials (35.7), then the review's own query over `ledger_lines` and `remittance_components` yields `cashbook_cents = 126675055n` and `composition_l12_cents = 126675055n`, the closing ledger is re-read from the stored statement document's bytes (35.2) as 125,430,055 cents, and a reviewer decision row with `rule_set_version: close.v1` exists.", { skip }, async () => {
  const s = await Scenario.open("t9");
  try {
    await s.bookCash(FIG.EX_A_CASHBOOK, "2026-09-29", "2.1:r8:cash_in", "September collections through 9/30");
    await s.depositInTransit(FIG.EX_A_DEPOSITS_IN_TRANSIT, "2026-09-30");
    await s.driveMonth("2026-09", { bank: FIG.EX_A_BANK_CLOSING_LEDGER, cashbook: FIG.EX_A_CASHBOOK, l3: FIG.EX_A_L3_PREPAID_NET });
    const prep = ((await s.tool("close.attest", AGENT, { period: "2026-09", op: "prepare", confidence: 0.99, evidence_document_ids: [s.stmt!.document_id, s.dit] }, R("R1"))).output as { preparer_decision_id: string }).preparer_decision_id;
    // the preparer's own run id, or the preparer's credentials → REVIEWER_NOT_INDEPENDENT
    const sameRun = await refused(s.tool("close.review", REVIEWER, { preparer_decision_id: prep }, R("R1"))); assert.equal(sameRun.code, "REVIEWER_NOT_INDEPENDENT");
    const sameCreds = await refused(s.tool("close.review", AGENT, { preparer_decision_id: prep }, R("R2"))); assert.equal(sameCreds.code, "REVIEWER_NOT_INDEPENDENT");
    // qc-audit under its own credentials and run: the review's own derivation and the bytes re-read
    const r = (await s.tool("close.review", REVIEWER, { preparer_decision_id: prep }, R("R2"))).output as { reviewer_decision_id: string; outcome: string; cashbook_cents: string; composition_l12_cents: string; closing_ledger_reread_cents: string; statement_sha256: string };
    assert.equal(r.outcome, "passed"); assert.equal(BigInt(r.cashbook_cents), 126_675_055n); assert.equal(BigInt(r.composition_l12_cents), 126_675_055n); assert.equal(BigInt(r.closing_ledger_reread_cents), 125_430_055n);
    assert.equal(r.statement_sha256, createHash("sha256").update(s.docs.get(s.stmt!.document_id)!).digest("hex"));
    const d = (await s.db.query<{ agent: string; action: string; rule_set_version: string; prompt_version: string }>(`SELECT agent, action, rule_set_version, prompt_version FROM agent_decisions WHERE id = $1`, [r.reviewer_decision_id]))[0]!;
    assert.deepEqual(d, { agent: "qc-audit", action: "close.review", rule_set_version: "close.v1", prompt_version: "35.4-v1" });
  } finally { await s.closeDb(); }
});
test("35.4-T10: Given period 2026-09 `attested` at variance $0.00 (T5), when the depository restates the 9/30 statement to $1,253,050.55 because a $1,250.00 deposit was returned, then the agent's proposal writes a decision and no state change; `close.reopen{period: \"2026-09\", reason, trigger_event_id}` by an `officer` sets `status = reopened`, logs `close.period.reopened{by, reason}`, writes a `close_reopens` row with `steps_reset = [\"custodial_day_close\", \"ledger_period_close\", \"balance_attestation\", \"form496\", \"form496a\"]` and `steps_kept = [\"lar\", \"period_close\", \"metro2_snapshot\"]` (each relabelled `pre_reopen`), and after 2.1's `payment.reversed` for the $1,250.00 the re-attestation row shows `adjusted_depository_cents = 126550055n` ($1,265,500.55), L3 `687040` ($6,870.40), `composition_l12_cents = 126550055n`, `cashbook_cents = 126550055n`, `variance_cents === 0n`, `supersedes_attestation_id` = the T5 row's id, while the T5 row is byte-for-byte unchanged; a `close.reopen` by an agent or an `ops_analyst` is refused `OFFICER_REOPEN_ONLY`; a reopen of 2026-09 after 2026-10 is `attested` is refused `SUCCESSOR_ATTESTED_NO_REOPEN`.", { skip }, async () => {
  const p0 = await S.period("2026-09"); assert.equal(p0.status, "attested");
  const t5 = await S.attestationRow(p0.current_attestation_id!); assert.equal(big(t5.variance_cents), 0n);
  // the depository restates the 9/30 statement (6.3's own receipt, a later one for the same day): $1,254,300.55 − $1,250.00 = $1,253,050.55
  S.fixed().set(et("2026-10-10", "09:00"));
  const restated = await S.statementOfRecord("2026-09-30", FIG.EX_B_RESTATED_CLOSING_LEDGER);
  // the agent proposes: a decision, no state change
  const before = JSON.stringify([await S.period("2026-09"), await S.steps("2026-09")]);
  const proposal = (await S.tool("close.reopen", AGENT, { period: "2026-09", op: "propose", reason: "restated 9/30 statement, returned item $1,250.00", trigger_event_id: restated.event_id }, R("R5"))).output as { proposal_decision_id: string; changed: boolean };
  assert.equal(proposal.changed, false); assert.equal(await S.count(`FROM agent_decisions WHERE id = $1 AND action = 'close.reopen.propose'`, [proposal.proposal_decision_id]), 1);
  assert.equal(JSON.stringify([await S.period("2026-09"), await S.steps("2026-09")]), before);
  // an agent or an ops_analyst never reopens
  assert.equal((await refused(S.tool("close.reopen", AGENT, { period: "2026-09", reason: "returned item", trigger_event_id: restated.event_id }, R("R5")))).code, "OFFICER_REOPEN_ONLY");
  assert.equal((await refused(S.tool("close.reopen", OPS, { period: "2026-09", reason: "returned item", trigger_event_id: restated.event_id }))).code, "OFFICER_REOPEN_ONLY");
  // the officer reopens
  const r = (await S.tool("close.reopen", OFFICER, { period: "2026-09", reason: "restated 9/30 statement, returned item $1,250.00", trigger_event_id: restated.event_id })).output as { reopen_id: string; status: string; steps_reset: string[]; steps_kept: string[] };
  assert.equal(r.status, "reopened"); assert.equal((await S.period("2026-09")).status, "reopened");
  const ev = await S.db.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM loan_events WHERE type = 'close.period.reopened' AND payload->>'period' = '2026-09'`);
  assert.equal(ev.length, 1); assert.equal(ev[0]!.payload["by"], OFFICER.id); assert.equal(ev[0]!.payload["reason"], "restated 9/30 statement, returned item $1,250.00");
  const reopen = (await S.db.query<{ steps_reset: string[]; steps_kept: string[]; prior_status: string; trigger_event_id: string }>(`SELECT steps_reset, steps_kept, prior_status, trigger_event_id::text AS trigger_event_id FROM close_reopens WHERE id = $1`, [r.reopen_id]))[0]!;
  assert.deepEqual(reopen.steps_reset, ["custodial_day_close", "ledger_period_close", "balance_attestation", "form496", "form496a"]); assert.deepEqual(reopen.steps_kept, ["lar", "period_close", "metro2_snapshot"]); assert.equal(reopen.prior_status, "attested"); assert.equal(reopen.trigger_event_id, restated.event_id);
  for (const code of ["lar", "period_close", "metro2_snapshot"]) assert.equal(await S.status("2026-09", code), "pre_reopen", code);
  for (const code of ["custodial_day_close", "ledger_period_close", "balance_attestation", "form496", "form496a"]) assert.equal(await S.status("2026-09", code), "blocked", code);
  // 2.1 reverses the returned item (its own reversal set and event): the cashbook drops to 126,550,055; 6.3's composition L3 to 687,040
  assert.equal(FIG.EX_A_L3_PREPAID_NET - FIG.EX_B_RETURNED_ITEM, FIG.EX_B_L3_AFTER_REVERSAL); assert.equal(FIG.EX_B_L3_AFTER_REVERSAL, 687_040n); assert.equal(FIG.EX_A_CASHBOOK - FIG.EX_B_RETURNED_ITEM, FIG.EX_B_CASHBOOK); assert.equal(FIG.EX_B_ADJUSTED_DEPOSITORY, 126_550_055n);
  assert.equal(FIG.EX_B_RESTATED_CLOSING_LEDGER + FIG.EX_A_DEPOSITS_IN_TRANSIT, FIG.EX_B_ADJUSTED_DEPOSITORY); assert.equal(687_040n + 4_500_000n + 0n + 321_015n - 2_258_000n + 123_300_000n + 0n + 0n, FIG.EX_B_L12); assert.equal(FIG.EX_B_L12, FIG.EX_B_CASHBOOK);
  const original = (await S.db.query<{ id: string }>(`SELECT id::text AS id FROM ledger_entry_sets WHERE description LIKE 'September collections%'`))[0]!.id;
  await S.bookCash(-FIG.EX_B_RETURNED_ITEM, "2026-09-30", "2.1:r9:reversal", "returned item J SMITH $1,250.00 (payment.reversed)", original);
  await S.ownerEvent("payment.reversed", { payment_id: `pay-jsmith-0930`, amount_cents: FIG.EX_B_RETURNED_ITEM.toString(), reason: "returned item", custodial_account_id: S.fx.custodial.pi, reversed_on: "2026-10-10" }, { kind: "agent", id: "cashiering" }, { kind: "payment", id: "pay-jsmith-0930" });
  await S.bookComposition("2026-09", FIG.EX_B_L3_AFTER_REVERSAL);   // 6.3's own correction of its composition row
  // the reset steps complete again on the owners' new receipts, then the re-attestation
  S.fixed().set(et("2026-10-10", "10:00"));
  await S.closeDay63("2026-09-30", FIG.EX_B_RESTATED_CLOSING_LEDGER, FIG.EX_B_CASHBOOK);
  await S.closePeriod63(S.fx.custodial.pi, "pi", "2026-09-30", REMITTANCE);
  await S.closePeriod63(S.fx.custodial.ti, "ti", "2026-09-30");
  await S.sweepAt(et("2026-10-10", "10:01"));
  assert.equal(await S.status("2026-09", "custodial_day_close"), "completed"); assert.equal(await S.status("2026-09", "ledger_period_close"), "completed"); assert.equal(await S.status("2026-09", "balance_attestation"), "planned");
  const again = await S.attest("2026-09", { prep: "R6", review: "R7" });
  assert.equal(again.out["outcome"], "attested");
  const row = await S.attestationRow(String(again.out["attestation_id"]));
  assert.equal(big(row.adjusted_depository_cents), 126_550_055n); assert.equal(JSON.parse(row.composition_snapshot!)["L3"], "687040"); assert.equal(big(row.composition_l12_cents), 126_550_055n); assert.equal(big(row.cashbook_cents), 126_550_055n); assert.equal(big(row.variance_cents), 0n);
  assert.equal(row.supersedes_attestation_id, t5.id);
  assert.deepEqual(await S.attestationRow(t5.id!), t5, "the original attestation row is byte-for-byte unchanged");
  assert.equal((await S.period("2026-09")).status, "attested");
  // the successor attested → no reopen of 2026-09 (the correction is October's Section III item)
  S.fixed().set(et("2026-10-31", "09:00"));
  await S.driveMonth("2026-10", { bank: FIG.EX_B_RESTATED_CLOSING_LEDGER, cashbook: FIG.EX_B_CASHBOOK, l3: FIG.EX_B_L3_AFTER_REVERSAL });
  assert.equal(await S.status("2026-10", "balance_attestation"), "planned");
  const oct = await S.attest("2026-10", { prep: "R8", review: "R9" });
  assert.equal(oct.out["outcome"], "attested"); assert.equal((await S.period("2026-10")).status, "attested");
  const late = await refused(S.tool("close.reopen", OFFICER, { period: "2026-09", reason: "a late item", trigger_event_id: restated.event_id }));
  assert.equal(late.code, "SUCCESSOR_ATTESTED_NO_REOPEN");
});
test("35.4-T11: Given the December 2026 period with `period_close` and `ledger_period_close` completed and three reportable loans with 2026 `interest_due` credits from borrower funds of $23,412.55, $9,870.12 and $412.40 and no loan with escrow interest at or above $10.00 (`ioe_1099_loans = 0`), when the sweep first passes 2027-01-02 00:05 ET, then `close.tax_year{tax_year: 2026}` runs once, 7.1's `tax_year.closed{tax_year: 2026}` exists for each of the three loans and arms `IRS_6050H_1098_FURNISH_0131` (due 2027-01-31) and `IRS_6050H_1098_FILE_0331` per loan, a `tax_year_closes` row has `reportable_loans = 3` and `ledger_interest_sum_cents = 3369507n` ($33,695.07), a kind `tax_year` `close_periods` row for 2026 exists with steps `form_1098_furnish`, `form_1099_int_furnish`, `form_1099_ac_furnish`, `form_1098_file`, `form_1099_int_file`, `form_1099_ac_file`, `close.tax_year.closed{tax_year: 2026}` satisfies `SM_TAX_YEAR_CLOSE_3BD` (armed by `close.tax_year.planned` on the December open, `due_at` 2027-01-06 17:00 ET), and a second pass changes nothing.", { skip }, async () => {
  assert.equal(FIG.EX_C_LOAN_1_INTEREST + FIG.EX_C_LOAN_2_INTEREST + FIG.EX_C_LOAN_3_INTEREST, FIG.EX_C_LEDGER_INTEREST_SUM); assert.deepEqual([FIG.EX_C_LOAN_1_INTEREST, FIG.EX_C_LOAN_2_INTEREST, FIG.EX_C_LOAN_3_INTEREST, FIG.EX_C_LEDGER_INTEREST_SUM], [2_341_255n, 987_012n, 41_240n, 3_369_507n]);
  // three reportable loans: 2.1's allocation sets credit `interest_due` from borrower funds in 2026 (Dr custodial_pi_cash / Cr interest_due); their own custodial accounts are closed so the book keeps its one P&I account
  const loans: string[] = [];
  for (const cents of [FIG.EX_C_LOAN_1_INTEREST, FIG.EX_C_LOAN_2_INTEREST, FIG.EX_C_LOAN_3_INTEREST]) {
    const f = await new PgLoanRepository(S.db).createFixture({ fnmaLoanNumber: `${Date.now() % 1_000_000}${Math.floor(Math.random() * 1000)}`.padStart(10, "0"), servicerLoanNumber: `SM-${randomUUID()}`, instrumentDate: D("2021-07-15"), originalUpbCents: 25_000_000n, originalTermMonths: 360, firstPaymentDate: D("2021-09-01"), maturityDate: D("2051-08-01") });
    await S.db.query(`UPDATE custodial_accounts SET status = 'closed' WHERE id = ANY($1::uuid[])`, [[f.custodial.clearing, f.custodial.pi, f.custodial.ti]]);
    const id = randomUUID();
    await S.db.tx((q) => new PgLedgerRepository(q).post({ id, effectiveDate: D("2026-06-01"), description: `2026 interest received from borrower funds (2.1 allocation, in aggregate) — loan ${f.loanId}`, postedAt: S.clock.now(), lines: [
      { id: randomUUID(), setId: id, account: { scope: "custodial", custodialAccountId: S.fx.custodial.clearing, account: "clearing_cash" }, amountCents: cents, ruleRef: "2.1:r8:cash_in", sequence: 1 },
      { id: randomUUID(), setId: id, account: { scope: "loan", loanId: f.loanId, account: "interest_due" }, amountCents: -cents, ruleRef: "2.1:r8:allocation:interest", sequence: 2 }] } as unknown as Parameters<PgLedgerRepository["post"]>[0], q));
    loans.push(f.loanId);
  }
  assert.equal(await S.count(`FROM ledger_lines l JOIN loans x ON x.id = l.loan_id WHERE l.account IN ('escrow', 'escrow_liability') AND l.rule_ref LIKE '%3.9%'`), 0, "no loan with escrow interest at or above $10.00 (6.2's borrower-side credit, rule_ref '6.2 rule 2(b); 3.9')");
  // November closes and attests first (the predecessor gate, T15), then the December 2026 period: opened by the planner's first pass of January (close.tax_year.planned arms SM_TAX_YEAR_CLOSE_3BD from 12/31), its chain through period_close and ledger_period_close on the owners' receipts
  S.fixed().set(et("2026-11-30", "09:00"));
  await S.driveMonth("2026-11", { bank: FIG.EX_B_RESTATED_CLOSING_LEDGER, cashbook: FIG.EX_B_CASHBOOK, l3: FIG.EX_B_L3_AFTER_REVERSAL });
  assert.equal((await S.attest("2026-11", { prep: "R14", review: "R15" })).out["outcome"], "attested");
  await S.sweepAt(et("2026-12-31", "23:59"));
  await S.sweepAt(et("2027-01-01", "00:05"));
  assert.equal((await S.period("2026-12")).status, "open"); assert.ok((await S.steps("2026-12")).some((x) => x.code === "tax_year_close"));
  const [ty3bd] = await S.timer("SM_TAX_YEAR_CLOSE_3BD"); assert.equal(ty3bd!.status, "armed"); assert.equal(ty3bd!.anchor_date, "2026-12-31"); assert.equal(ty3bd!.due_at, et("2027-01-06", "17:00")); assert.equal(ty3bd!.subject_kind, "global");
  assert.equal(await S.count(`FROM loan_events WHERE type = 'close.tax_year.planned' AND (payload->>'tax_year')::int = 2026`), 1);
  S.fixed().set(et("2027-01-01", "00:06"));
  await S.bookComposition("2026-12", FIG.EX_B_L3_AFTER_REVERSAL);
  await S.statementOfRecord("2026-12-31", FIG.EX_B_RESTATED_CLOSING_LEDGER);
  await S.ownerEvent("cashiering.daily.run_completed", { as_of_date: "2026-12-31", run_id: randomUUID(), cycle_code: "cashiering_daily", period_key: "2026-12-31", loans: 4 }, { kind: "agent", id: "cashiering" });
  await S.closeDay63("2026-12-31", FIG.EX_B_RESTATED_CLOSING_LEDGER, FIG.EX_B_CASHBOOK);
  await S.closePeriod63(S.fx.custodial.pi, "pi", "2026-12-31", REMITTANCE);
  await S.closePeriod63(S.fx.custodial.ti, "ti", "2026-12-31");
  await S.ownerEvent("investor.lar.run_completed", { as_of_date: fannieBd(D("2026-12-31"), 1), run_id: randomUUID(), cycle_code: "lar_daily", period_key: fannieBd(D("2026-12-31"), 1), units_total: 4, units_done: 4 }, { kind: "agent", id: "investor-reporting" });
  await S.sweepAt(et("2027-01-01", "00:10"));
  await S.closePeriod51("2026-12", et("2027-01-01", "12:00"));
  await S.sweepAt(et("2027-01-01", "12:01"));
  assert.equal(await S.status("2026-12", "period_close"), "completed"); assert.equal(await S.status("2026-12", "ledger_period_close"), "completed");
  assert.equal(await S.status("2026-12", "tax_year_close"), "blocked", "not before 2 January 00:05 ET");
  assert.equal(await S.count(`FROM tax_year_closes`), 0);
  // the first sweep at/after 2027-01-02 00:05 ET: close.tax_year{2026} runs once
  const r = await S.sweepAt(et("2027-01-02", "00:05"));
  assert.deepEqual(r.close?.tax_year_closed, [2026], r.close?.line);
  const closed = await S.db.query<{ loan_id: string; payload: Record<string, unknown> }>(`SELECT loan_id::text AS loan_id, payload FROM loan_events WHERE type = 'tax_year.closed' AND (payload->>'tax_year')::int = 2026 ORDER BY loan_id`);
  assert.deepEqual(closed.map((x) => x.loan_id).sort(), [...loans].sort()); for (const c of closed) assert.equal(c.payload["source"], undefined, "7.1's close carries no source");
  for (const loanId of loans) {
    const furnish = await S.db.query<{ status: string; due_date: string }>(`SELECT status::text AS status, due_date::text AS due_date FROM timers WHERE code = 'IRS_6050H_1098_FURNISH_0131' AND loan_id = $1`, [loanId]);
    assert.equal(furnish.length, 1); assert.equal(furnish[0]!.status, "armed"); assert.equal(furnish[0]!.due_date, "2027-01-31");
    const file = await S.db.query<{ status: string }>(`SELECT status::text AS status FROM timers WHERE code = 'IRS_6050H_1098_FILE_0331' AND loan_id = $1`, [loanId]);
    assert.equal(file.length, 1); assert.equal(file[0]!.status, "armed");
  }
  const row = (await S.db.query<{ reportable_loans: number; ioe_1099_loans: number; form_1099_ac_loans: number; ledger_interest_sum_cents: string; tax_year_close_period_id: string }>(`SELECT reportable_loans, ioe_1099_loans, form_1099_ac_loans, ledger_interest_sum_cents::text AS ledger_interest_sum_cents, tax_year_close_period_id::text AS tax_year_close_period_id FROM tax_year_closes WHERE tax_year = 2026`))[0]!;
  assert.equal(row.reportable_loans, 3); assert.equal(row.ioe_1099_loans, 0); assert.equal(row.form_1099_ac_loans, 0); assert.equal(big(row.ledger_interest_sum_cents), 3_369_507n);
  const ty = (await S.db.query<{ kind: string; period: string; status: string; tax_year: number }>(`SELECT kind, period, status, tax_year FROM close_periods WHERE id = $1`, [row.tax_year_close_period_id]))[0]!;
  assert.deepEqual(ty, { kind: "tax_year", period: "2026-TY", status: "open", tax_year: 2026 });
  const tySteps = await S.db.query<{ code: string; status: string }>(`SELECT code, status FROM close_period_steps WHERE close_period_id = $1 ORDER BY array_position($2::text[], code)`, [row.tax_year_close_period_id, [...STEP_ORDER]]);
  assert.deepEqual(tySteps.map((x) => x.code), ["form_1098_furnish", "form_1099_int_furnish", "form_1099_ac_furnish", "form_1098_file", "form_1099_int_file", "form_1099_ac_file"]);
  assert.deepEqual(tySteps.filter((x) => x.status === "skipped").map((x) => x.code), ["form_1099_int_furnish", "form_1099_ac_furnish", "form_1099_int_file", "form_1099_ac_file"], "no 1099-INT loan, no 1099-A/C loan: skipped by the system");
  assert.equal(await S.count(`FROM loan_events WHERE type = 'close.tax_year.closed' AND (payload->>'tax_year')::int = 2026`), 1);
  assert.equal((await S.timer("SM_TAX_YEAR_CLOSE_3BD"))[0]!.status, "satisfied");
  assert.equal(await S.status("2026-12", "tax_year_close"), "completed");
  // a second pass changes nothing
  const snap = async () => JSON.stringify([await S.count(`FROM tax_year_closes`), await S.count(`FROM close_periods`), await S.count(`FROM close_period_steps`), await S.count(`FROM loan_events WHERE type IN ('tax_year.closed', 'close.tax_year.closed', 'close.period.opened')`), await S.count(`FROM timers WHERE code LIKE 'IRS_6050H%'`)]);
  const before = await snap();
  const again = await S.sweepAt(et("2027-01-02", "00:06"));
  assert.deepEqual(again.close?.tax_year_closed, []); assert.equal(await snap(), before);
});
test("35.4-T12: Given T11 and 7.1's 1098 run furnished all three forms (box 1 $23,412.55, $9,870.12, $412.40) and filed the two at or above $600.00, when the tax-year attestation runs, then the `close_attestations` row (kind tax_year) has `reportable_loans = 3`, `furnished_count = 3`, `filed_count = 2`, `box1_sum_cents = 3369507n`, `ledger_interest_sum_cents = 3369507n`, `variance_cents === 0n` and `outcome = attested`; given one form unfurnished, then `outcome = variance`, an `officer` escalation names the loan and the period stays `open`.", { skip }, async () => {
  const close = (await S.db.query<{ tax_year_close_period_id: string }>(`SELECT tax_year_close_period_id::text AS tax_year_close_period_id FROM tax_year_closes WHERE tax_year = 2026`))[0]!;
  const loans = (await S.db.query<{ loan_id: string; s: string }>(`SELECT l.loan_id::text AS loan_id, (-sum(l.amount_cents))::text AS s FROM ledger_lines l JOIN ledger_entry_sets e ON e.id = l.set_id WHERE l.scope = 'loan' AND l.account = 'interest_due' AND e.effective_date >= '2026-01-01' AND e.effective_date < '2027-01-01' GROUP BY l.loan_id ORDER BY sum(l.amount_cents)`)).map((x) => ({ loan_id: x.loan_id, box1: big(x.s) }));
  assert.deepEqual(loans.map((l) => l.box1), [2_341_255n, 987_012n, 41_240n]);
  assert.equal(FIG.IRS_1098_FILE_FLOOR, 60_000n); assert.equal(loans.filter((l) => l.box1 >= 60_000n).length, FIG.EX_C_FILED_LOANS);
  S.fixed().set(et("2027-01-25", "10:00"));
  // 7.1's run furnishes (its own typed rows): first with the $412.40 form still unfurnished — the earlier warning
  const furnish = async (l: { loan_id: string; box1: bigint }, filed: boolean, furnished: boolean) => S.db.query(`INSERT INTO tax_forms_1098 (loan_id, tax_year, boxes, furnished_at, channel, filed_at, irs_receipt_id) VALUES ($1, 2026, $2::jsonb, $3, $4, $5, $6)`, [l.loan_id, JSON.stringify({ box1_cents: l.box1.toString(), box2_cents: "25000000" }), furnished ? S.clock.now() : null, furnished ? "electronic" : null, filed ? S.clock.now() : null, filed ? `IRS-${l.loan_id.slice(0, 8)}` : null]);
  await furnish(loans[0]!, true, true); await furnish(loans[1]!, true, true);
  const v = (await S.tool("close.attest", AGENT, { period: "2026-TY" }, R("R10"))).output as Record<string, unknown>;
  assert.equal(v["outcome"], "variance"); assert.equal(v["furnished_count"], 2); assert.equal(v["reportable_loans"], 3);
  const esc = await S.db.query<{ owner_role: string; payload: { unfurnished_loan_ids: string[] } }>(`SELECT owner_role, payload FROM escalations WHERE payload->>'attestation_id' = $1`, [String(v["attestation_id"])]);
  assert.equal(esc.length, 1); assert.equal(esc[0]!.owner_role, "officer"); assert.deepEqual(esc[0]!.payload.unfurnished_loan_ids, [loans[2]!.loan_id]);
  assert.equal((await S.db.query<{ status: string }>(`SELECT status FROM close_periods WHERE id = $1`, [close.tax_year_close_period_id]))[0]!.status, "open");
  // all three furnished (below $600.00 too), the two at or above $600.00 filed
  await furnish(loans[2]!, false, true);
  const a = (await S.tool("close.attest", AGENT, { period: "2026-TY" }, R("R11"))).output as Record<string, unknown>;
  assert.equal(a["outcome"], "attested");
  const row = (await S.db.query<{ kind: string; outcome: string; reportable_loans: number; furnished_count: number; filed_count: number; box1_sum_cents: string; ledger_interest_sum_cents: string; variance_cents: string }>(`SELECT kind, outcome, reportable_loans, furnished_count, filed_count, box1_sum_cents::text AS box1_sum_cents, ledger_interest_sum_cents::text AS ledger_interest_sum_cents, variance_cents::text AS variance_cents FROM close_attestations WHERE id = $1`, [String(a["attestation_id"])]))[0]!;
  assert.equal(row.kind, "tax_year"); assert.equal(row.outcome, "attested"); assert.equal(row.reportable_loans, 3); assert.equal(row.furnished_count, 3); assert.equal(row.filed_count, 2); assert.equal(big(row.box1_sum_cents), 3_369_507n); assert.equal(big(row.ledger_interest_sum_cents), 3_369_507n); assert.equal(big(row.variance_cents), 0n);
  assert.equal((await S.db.query<{ status: string }>(`SELECT status FROM close_periods WHERE id = $1`, [close.tax_year_close_period_id]))[0]!.status, "attested");
});
test("35.4-T13: Given every 35.4 tool on the bus, then a contract test runs each with a valid input against the fixture and asserts that the row counts and the `*_cents` columns of `ledger_lines`, `payments`, `reconciliations`, `reconciliation_items`, `remittance_components`, `investor_reporting_periods` and `tax_forms_1098` are identical before and after, that no 35.4 tool emits any event type outside the list in \"Outputs and artifacts\", that no `timers` row of another section's code changed status, and that every state-changing call left one `agent_decisions` row with `rule_set_version: close.v1` and `prompt_version: 35.4-v1`.", { skip }, async () => {
  const OUTPUTS = new Set(["close.period.opened", "close.step.planned", "close.step.started", "close.receipt.recorded", "close.step.completed", "close.step.stalled", "close.step.skipped", "close.period.attested", "close.attestation.variance", "close.period.reopened", "close.period.closed", "close.tax_year.planned", "close.tax_year.closed", "ledger.month.ended"]);
  const PLATFORM = /^(command\.|timer\.|escalation\.|agent\.|dual_control\.|role\.)/;
  const MONEY = async () => JSON.stringify(await S.db.query(`SELECT (SELECT count(*)::text FROM ledger_lines) AS a1, (SELECT md5(string_agg(amount_cents::text, ',' ORDER BY id)) FROM ledger_lines) AS a2, (SELECT count(*)::text FROM payments) AS b1, (SELECT md5(coalesce(string_agg(amount_cents::text, ',' ORDER BY id), '')) FROM payments) AS b2, (SELECT count(*)::text FROM reconciliations) AS c1, (SELECT md5(coalesce(string_agg(coalesce(cashbook_cents::text, '') || coalesce(difference_cents::text, ''), ',' ORDER BY id), '')) FROM reconciliations) AS c2, (SELECT count(*)::text FROM reconciliation_items) AS d1, (SELECT md5(coalesce(string_agg(amount_cents::text, ',' ORDER BY id), '')) FROM reconciliation_items) AS d2, (SELECT count(*)::text FROM remittance_components) AS e1, (SELECT md5(coalesce(string_agg(amount_cents::text, ',' ORDER BY custodial_account_id, period, component_code), '')) FROM remittance_components) AS e2, (SELECT count(*)::text FROM investor_reporting_periods) AS f1, (SELECT count(*)::text FROM tax_forms_1098) AS g1, (SELECT md5(coalesce(string_agg(boxes::text, ',' ORDER BY id), '')) FROM tax_forms_1098) AS g2`));
  const OTHERS = async () => JSON.stringify(await S.db.query(`SELECT id::text AS id, status::text AS status FROM timers WHERE code NOT LIKE 'SM_CLOSE_%' AND code <> 'SM_TAX_YEAR_CLOSE_3BD' ORDER BY id`));
  const seq = async () => Number((await S.db.query<{ s: string }>(`SELECT coalesce(max(sequence), 0)::text AS s FROM loan_events`))[0]!.s);
  const decisions = async () => S.db.query<{ id: string; rule_set_version: string; prompt_version: string | null }>(`SELECT id::text AS id, rule_set_version, prompt_version FROM agent_decisions ORDER BY created_at`);
  S.fixed().set(et("2027-01-26", "10:00"));
  const prep = ((await S.tool("close.attest", AGENT, { period: "2026-10", op: "prepare", confidence: 0.99, evidence_document_ids: [S.stmt!.document_id, S.dit] }, R("R12"))).output as { preparer_decision_id: string }).preparer_decision_id;
  // 8.1's snapshot for 12/31 (its own event, the stand-in) is the receipt December's metro2_snapshot completes on by hand — appended between the start and the completion
  const snapshot81 = () => S.ownerEvent("credit.cycle.snapshot_completed", { cycle_id: "m2-2026-12", as_of_date: "2026-12-31", record_count: 4, omitted: 0, exceptions: [] }, { kind: "agent", id: "credit-reporting" }, { kind: "metro2_cycle", id: "m2-2026-12" });
  const calls: { name: string; actor: Actor; input: Record<string, unknown>; state_changing: boolean; before?: () => Promise<unknown> }[] = [
    { name: "close.open", actor: AGENT, input: { period: "2026-11" }, state_changing: true },
    { name: "close.plan", actor: AGENT, input: {}, state_changing: true },
    { name: "close.step.start", actor: AGENT, input: { period: "2026-12", step: "metro2_snapshot" }, state_changing: true },
    { name: "close.step.complete", actor: AGENT, input: { period: "2026-12", step: "metro2_snapshot" }, state_changing: true, before: snapshot81 },
    { name: "close.step.skip", actor: OFFICER, input: { period: "2026-12", step: "form496a", reason: "no_ti_account" }, state_changing: true },
    { name: "close.board", actor: AGENT, input: { period: "2026-09" }, state_changing: false },
    { name: "close.attest", actor: AGENT, input: { period: "2026-12", op: "prepare", confidence: 0.99, evidence_document_ids: [S.stmt!.document_id] }, state_changing: true },
    { name: "close.review", actor: REVIEWER, input: { preparer_decision_id: prep }, state_changing: true },
    { name: "close.reopen", actor: AGENT, input: { period: "2026-09", op: "propose", reason: "contract test proposal", trigger_event_id: S.stmt!.event_id }, state_changing: true },
    { name: "close.tax_year", actor: AGENT, input: { tax_year: 2026 }, state_changing: false },   // already closed: the idempotent no-op
    { name: "writeDecision", actor: AGENT, input: { action: "close.note", rationale: "contract test", rule_set_version: "close.v1", subject: { kind: "close_period", id: "2026-09" } }, state_changing: true },
  ];
  for (const c of calls) {
    if (c.before) await c.before();
    const money = await MONEY(); const others = await OTHERS(); const from = await seq(); const before = await decisions();
    await S.tool(c.name, c.actor, c.input, R("R13"));
    assert.equal(await MONEY(), money, `${c.name}: no money row or *_cents column moved`);
    assert.equal(await OTHERS(), others, `${c.name}: no other section's timer changed status`);
    const emitted = await S.db.query<{ type: string }>(`SELECT type FROM loan_events WHERE sequence > $1`, [from]);
    for (const e of emitted) assert.ok(OUTPUTS.has(e.type) || PLATFORM.test(e.type), `${c.name} emitted ${e.type}`);
    const after = await decisions(); const fresh = after.filter((d) => !before.some((b) => b.id === d.id));
    assert.equal(fresh.length, c.state_changing ? 1 : 0, `${c.name}: ${fresh.length} decision row(s)`);
    for (const d of fresh) { assert.equal(d.rule_set_version, "close.v1", c.name); assert.equal(d.prompt_version, "35.4-v1", c.name); }
  }
});
test("35.4-T14: Given two sweeps started within the same minute on 2026-10-02 (35.3's planner lock held by one), then one `close_periods` row and one step set exist for 2026-09, every receipt is journaled once, and `close.board{period: \"2026-09\"}` returns each step with `status`, `depends_on`, `missing`, `receipt_event_ids`, `owner_timer_code` and `owner_due_at` read from `timers` (`FNMA_F496_PI_RECON_45` → 2026-11-13 17:00 for `form496`; `FNMA_A4101_QC_CYCLE_MONTHLY`'s BD20 for `qc_cycle`), the attestation summary and the reopen history; `close.board` is a read tool and a contract test shows no row changed across the call.", { skip }, async () => {
  // 18.1's own monthly tick (BD3 = Mon 2026-10-05) arms FNMA_A4101_QC_CYCLE_MONTHLY: BD3 + 17 business_days_servicer = BD20
  const ticks = qcScheduleTicks(D("2026-10-05")); assert.ok(ticks.some((t) => t.type === "schedule.tick"));
  S.fixed().set(et("2026-10-05", "06:00"));
  await S.rt.uow.run({}, (ctx) => { for (const t of ticks) ctx.events.append(t); }, { clock: S.clock });
  const bd20 = addBusinessDays(D("2026-10-05"), 17, servicerCal);
  // two sweeps in the same minute: one holds the lease, the other writes sweep_runs{skipped, lease_held}
  const at = et("2026-10-02", "10:00"); S.fixed().set(at);
  const [a, b] = await Promise.all([S.rt.sweep(at, { verify: false, holder: "sweep-a" }), S.rt.sweep(at, { verify: false, holder: "sweep-b" })]);
  assert.deepEqual([a.outcome, b.outcome].sort(), ["completed", "skipped"]);
  assert.equal(await S.count(`FROM close_periods WHERE period = '2026-09' AND servicer_number = $1`, [SN]), 1);
  assert.equal(await S.count(`FROM close_period_steps s JOIN close_periods p ON p.id = s.close_period_id WHERE p.period = '2026-09' AND p.servicer_number = $1`, [SN]), 12);
  const receipts = await S.db.query<{ n: string; d: string }>(`SELECT count(*)::text AS n, count(DISTINCT source_event_id)::text AS d FROM close_period_events e JOIN close_periods p ON p.id = e.close_period_id WHERE p.period = '2026-09' AND e.type = 'close.receipt.recorded'`);
  assert.equal(receipts[0]!.n, receipts[0]!.d); assert.ok(Number(receipts[0]!.n) >= 5, `receipts journaled: ${receipts[0]!.n}`);
  const snapshot = async () => JSON.stringify(await S.db.query(`SELECT (SELECT count(*)::text FROM close_periods) AS a, (SELECT count(*)::text FROM close_period_steps) AS b, (SELECT count(*)::text FROM close_period_events) AS c, (SELECT count(*)::text FROM close_attestations) AS d, (SELECT count(*)::text FROM close_reopens) AS e, (SELECT count(*)::text FROM tax_year_closes) AS f, (SELECT count(*)::text FROM agent_decisions) AS g, (SELECT count(*)::text FROM escalations) AS h, (SELECT md5(string_agg(status::text || coalesce(satisfied_at::text, ''), ',' ORDER BY id)) FROM timers) AS t, (SELECT md5(string_agg(status || received::text || coalesce(started_at::text, ''), ',' ORDER BY id)) FROM close_period_steps) AS u`));
  const before = await snapshot();
  const r = await S.tool("close.board", AGENT, { period: "2026-09" });
  assert.equal(await snapshot(), before, "a read changes no row");
  assert.equal(r.decisions.length, 0, "a read leaves no decision row");
  const board = r.output as { period: { status: string }; steps: { code: string; status: string; depends_on: string[]; missing: string[]; receipt_event_ids: string[]; owner_timer_code: string | null; owner_due_at: string | null }[]; attestations: { id: string; outcome: string }[]; reopens: { id: string }[] };
  for (const s of board.steps) for (const k of ["status", "depends_on", "missing", "receipt_event_ids", "owner_timer_code", "owner_due_at"]) assert.ok(k in s, `${s.code}.${k}`);
  const f496 = board.steps.find((s) => s.code === "form496")!; assert.equal(f496.owner_timer_code, "FNMA_F496_PI_RECON_45"); assert.equal(f496.owner_due_at, et("2026-11-13", "17:00"));
  const qc = board.steps.find((s) => s.code === "qc_cycle")!; assert.equal(qc.owner_timer_code, "FNMA_A4101_QC_CYCLE_MONTHLY"); assert.equal(qc.owner_due_at, et(bd20, "23:59"), "BD20 (end of the servicer business day, ET)");
  const lpc = board.steps.find((s) => s.code === "ledger_period_close")!; assert.ok(lpc.receipt_event_ids.length >= 2); assert.deepEqual(lpc.missing, []);
  assert.ok(board.attestations.length >= 2 && board.attestations.some((x) => x.outcome === "attested")); assert.equal(board.reopens.length, 1);
});
test("35.4-T15: Given period 2026-10 (period_end Sat 2026-10-31), when the planner runs at 2026-11-01 00:05 ET, then `ledger.month.ended{period_key: \"2026-10\", period_end: \"2026-10-31\"}` is emitted once, `SM_CLOSE_PERIOD_OPEN_BD1` has `due_at` Mon 2026-11-02 17:00 ET and `SM_CLOSE_ATTEST_BD5` Fri 2026-11-06 17:00 ET (`business_days_fannie_et`), `eod_cutoff` completes on 35.5's `cashiering.daily.run_completed{as_of_date: \"2026-10-31\"}` (a Saturday run), `metro2_snapshot` is `planned` no earlier than 2026-11-01 00:05 ET with `receipt_filter {as_of_date: \"2026-10-31\"}`, and no step of 2026-10 is planned before 2026-09's `balance_attestation` completed unless 2026-09 is `attested` (a period's `form496` may still be running).", { skip }, async () => {
  // the October facts T10's drive produced on this book: the planner's first pass of November (2026-11-01 00:05 ET, driveMonth) emitted the month's end once
  const ended = await S.db.query<{ occurred_at: string; payload: Record<string, unknown> }>(`SELECT to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at, payload FROM loan_events WHERE type = 'ledger.month.ended' AND payload->>'period_key' = '2026-10'`);
  assert.equal(ended.length, 1); assert.deepEqual([ended[0]!.payload["period_key"], ended[0]!.payload["period_end"]], ["2026-10", "2026-10-31"]); assert.equal(ended[0]!.occurred_at, et("2026-11-01", "00:05"));
  assert.equal(periodEndOf("2026-10"), "2026-10-31"); assert.equal(fannieBd(D("2026-10-31"), 1), "2026-11-02"); assert.equal(fannieBd(D("2026-10-31"), 5), "2026-11-06");
  const [bd1] = (await S.timer("SM_CLOSE_PERIOD_OPEN_BD1")).filter((t) => t.anchor_date === "2026-10-31"); assert.equal(bd1!.due_at, et("2026-11-02", "17:00")); assert.equal(bd1!.status, "satisfied");
  const [bd5] = await S.timer("SM_CLOSE_ATTEST_BD5", periodAggregate(SN, "2026-10").id); assert.equal(bd5!.due_at, et("2026-11-06", "17:00"));
  const s = await S.steps("2026-10");
  const eod = s.find((x) => x.code === "eod_cutoff")!; assert.equal(eod.status, "completed");
  const eodReceipt = await S.db.query<{ type: string; payload: Record<string, unknown> }>(`SELECT le.type, le.payload FROM close_period_events e JOIN loan_events le ON le.id = e.source_event_id WHERE e.step_id = $1 AND e.type = 'close.receipt.recorded'`, [eod.id]);
  assert.equal(eodReceipt.length, 1); assert.equal(eodReceipt[0]!.type, "cashiering.daily.run_completed"); assert.equal(eodReceipt[0]!.payload["as_of_date"], "2026-10-31");
  const m2 = s.find((x) => x.code === "metro2_snapshot")!; assert.deepEqual(m2.receipt_filter, { as_of_date: "2026-10-31" }); assert.equal(m2.not_before, et("2026-11-01", "00:05"));
  const m2planned = (await S.db.query<{ occurred_at: string }>(`SELECT to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at FROM close_period_events WHERE step_id = $1 AND type = 'close.step.planned'`, [m2.id]))[0]!;
  assert.ok(m2planned.occurred_at >= et("2026-11-01", "00:05"), `metro2 planned at ${m2planned.occurred_at}`); assert.ok(["planned", "running", "completed"].includes(m2.status));
  // the predecessor gate: on a book whose September is open and unattested (its balance_attestation not completed), no step of October is planned — not even eod_cutoff
  const other = "999999999";
  await S.tool("close.open", AGENT, { period: "2026-09", servicer_number: other });
  await S.tool("close.open", AGENT, { period: "2026-10", servicer_number: other });
  assert.equal((await S.period("2026-09", other)).status, "open"); assert.equal(await S.status("2026-09", "balance_attestation", other), "blocked");
  await S.tool("close.plan", AGENT, { servicer_number: other });
  for (const x of await S.steps("2026-10", other)) assert.equal(x.status, "blocked", `${x.code} of 2026-10 (${other}) must wait for September's attestation`);
});
