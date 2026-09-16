// 35.4 Month-end and year-end close: close periods, the dependency-ordered chain, the balance attestation, reopen, and the tax-year close that drives 1098 and 1099
// spec/sections/35-operations-runtime/35-4-month-end-and-year-end-close.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// Every T-id runs against Postgres (the file has its own database, src/infra/db/test-db.ts; REQUIRE_DB=1 in CI). The
// receipts the chain waits on are the owning sections' own events: where a section's emitter exists it is run here
// (6.3 `timer.*{close_period | close_day}`, 5.1 `closeReportingPeriod`, 18.1 `qcScheduleTicks`); where the owner is a
// sibling process not yet in this tree (35.5's `cashiering.daily.run_completed`, 35.3's `investor.lar.run_completed`)
// the fixture appends that literal as the neighbour's stand-in — the Given of the sentence, never production code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connect, type Db, type Queryable } from "../../infra/db/client.ts";
import { testDatabase } from "../../infra/db/test-db.ts";
import { PgLoanRepository, type Fixture } from "../../infra/db/loans.ts";
import { PgLedgerRepository } from "../../infra/db/ledger.ts";
import { loadOverriddenRegistry } from "../../domain/timer-overrides.ts";
import { FixedClock, type Actor } from "../../kernel/events/index.ts";
import { plainDate as D, addDays } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer as servicerCal } from "../../kernel/calendar/business.ts";
import { Runtime } from "../../runtime/app.ts";
import { closeReportingPeriod } from "../investor/ops-5-1.ts";
import { qcScheduleTicks } from "../qc-audit/ops-18-1.ts";
import { setClosePorts, type DocumentBytesPort, type ConfigPort } from "./close-35-4/ports.ts";
import { DEFAULT_SERVICER_NUMBER, periodAggregate, stepAggregate } from "./close-35-4/types.ts";
import { STEP_ORDER } from "./close-35-4/store.ts";
import * as FIG from "./close-35-4/figures.ts";

const { url: DB_URL, skip } = await testDatabase(import.meta.url);
const clock = new FixedClock("2026-09-30T16:00:00.000Z");
const AGENT: Actor = { kind: "agent", id: "custodial-recon" };
const REVIEWER: Actor = { kind: "agent", id: "qc-audit" };
const OFFICER: Actor = { kind: "human", id: "u-officer-okafor", role: "officer" };
const OPS: Actor = { kind: "human", id: "u-ops-lee", role: "ops_analyst" };
const SYSTEM: Actor = { kind: "system", id: "test" };
const SN = DEFAULT_SERVICER_NUMBER;
/** ET instants: EDT (UTC−4) through 2026-11-01 02:00, EST (UTC−5) after. */
const et = (date: string, hhmm: string): string => { const [h, m] = hhmm.split(":").map(Number) as [number, number]; const edt = date < "2026-11-01" || (date === "2026-11-01" && h < 2); return new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), h + (edt ? 4 : 5), m)).toISOString(); };

let db: Db; let runtime: Runtime; let fx: Fixture;
const docs = new Map<string, Buffer>();   // the stored statement bytes (35.2's staged copy stands in through the port until its table lands)
let humanApproval = true;                  // configuration `custodial.form496.human_approval` (rule 7) — through the port, never the request
const bytesPort: DocumentBytesPort = { async read(_q, id) { return docs.get(id) ?? null; } };
const configPort: ConfigPort = { async humanApprovalOn() { return humanApproval; } };
const count = async (q: Queryable, sql: string, params: unknown[] = []): Promise<number> => Number((await q.query<{ c: string }>(`SELECT count(*)::text AS c ${sql}`, params))[0]!.c);
const tool = (name: string, actor: Actor, input: Record<string, unknown>, run?: { runId: string; modelVersion: string; promptVersion: string }) => runtime.execute({ process: "35.4", name, loanId: "", actor, input, ...(run ? { run } : {}) });
const refused = async (p: Promise<unknown>): Promise<{ code: string; detail?: Record<string, unknown>; message: string }> => { try { await p; } catch (e) { const x = e as { code?: string; detail?: Record<string, unknown>; message: string }; return { code: x.code ?? "", ...(x.detail ? { detail: x.detail } : {}), message: x.message }; } throw new Error("expected a refusal"); };
const sweepAt = async (iso: string) => { clock.set(iso); return runtime.sweep(iso, { verify: false }); };
const steps = async (period: string, servicer = SN) => db.query<{ code: string; status: string; received: number; expected_receipts: number; started_at: string | null; completed_at: string | null; receipt_filter: Record<string, unknown>; not_before: string | null; depends_on: string[] }>(`SELECT s.code, s.status, s.received, s.expected_receipts, s.started_at::text AS started_at, s.completed_at::text AS completed_at, s.receipt_filter, s.not_before::text AS not_before, s.depends_on FROM close_period_steps s JOIN close_periods p ON p.id = s.close_period_id WHERE p.kind = 'month' AND p.period = $1 AND p.servicer_number = $2 ORDER BY array_position($3::text[], s.code)`, [period, servicer, [...STEP_ORDER]]);
const stepStatus = async (period: string, code: string, servicer = SN): Promise<string> => (await steps(period, servicer)).find((s) => s.code === code)!.status;
const timer = async (code: string, subjectId?: string) => db.query<{ id: string; status: string; due_at: string | null; subject_kind: string; subject_id: string; anchor_date: string }>(`SELECT id::text AS id, status::text AS status, to_char(due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS due_at, subject_kind, subject_id, anchor_date::text AS anchor_date FROM timers WHERE code = $1${subjectId ? " AND subject_id = $2" : ""} ORDER BY armed_at`, subjectId ? [code, subjectId] : [code]);
/** A section's own event appended as its owner (the Given of a sentence): 35.5's daily receipt, 35.3's LAR run receipt, 8.1's snapshot, 18.x's signatures. */
const ownerEvent = (type: string, payload: Record<string, unknown>, actor: Actor, aggregate?: { kind: string; id: string }) => runtime.uow.run({}, (ctx) => ctx.events.append({ type, actor, payload, ...(aggregate ? { aggregate } : {}) }), { clock });
/** 6.3's own month-end cut-off and daily close through 6.3's own tool (`timer.*`), one per custodial account. */
const closePeriod63 = (account: string, kind: "pi" | "ti", periodEnd: string, remittance?: string) => runtime.execute({ process: "6.3", name: "timer.*", loanId: "", actor: AGENT, input: { op: "close_period", period_end: periodEnd, custodial_account_id: account, account_kind: kind, ...(remittance ? { remittance_type: remittance } : {}) } });
const closeDay63 = (account: string, asOf: string, bank: bigint, dit: bigint, cashbook: bigint) => runtime.execute({ process: "6.3", name: "timer.*", loanId: "", actor: AGENT, input: { op: "close_day", custodial_account_id: account, as_of_date: asOf, bank_closing_ledger_cents: bank, deposits_in_transit_cents: dit, disbursements_in_transit_cents: 0n, adjustments_cents: 0n, cashbook_cents: cashbook } });
/** 5.1's own period close (`closeReportingPeriod`, rule 10's checklist complete) → `investor_reporting_periods.closed{period, checklist_complete: true}`. */
const closePeriod51 = (period: string, at: string) => runtime.uow.run({}, (ctx) => closeReportingPeriod(ctx.events, { servicer_number: SN, escrow_events: false, closed_at_ms: Date.parse(at), actor: { kind: "agent", id: "investor-reporting" }, facts: { period, active_loans: 1, loans_with_accepted_event_or_none: 1, open_hard_or_invalid_rejects: 0, removals: [], trial_balance_diff_loans: 0, soft_rejects_without_triage: 0, cash_position_variance_cents: 0n, delinquency_file_accepted: true, escrow_attestation_prepared: "not_required" } }), { clock });

test.before(async () => {
  if (skip) return;
  db = connect(DB_URL);
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock, env: { ...process.env, ENVIRONMENT: "nonprod" }, environment: "nonprod" });
  setClosePorts(runtime, { documents: bytesPort, config: configPort });
  fx = await new PgLoanRepository(db).createFixture({ fnmaLoanNumber: `${Date.now() % 1_000_000}0001`.padStart(10, "0"), servicerLoanNumber: `SM-${randomUUID()}`, instrumentDate: D("2021-07-15"), originalUpbCents: 25_000_000n, originalTermMonths: 360, firstPaymentDate: D("2021-09-01"), maturityDate: D("2051-08-01") });
  await db.query(`UPDATE custodial_accounts SET remittance_type = 'S/S' WHERE id = $1`, [fx.custodial.pi]);   // the S/S MBS P&I account of worked example A
});
test.after(async () => { if (!skip) await db.end(); });

// ───────── worked example A as 6.3's own rows: the composition (remittance_components), the cashbook (a balanced custodial set), the statement of record (6.3's receipt + the stored bytes) ─────────
const COMPOSITION: Record<string, bigint> = { L3_prepaid_net: FIG.EX_A_L3_PREPAID_NET, L4_curtail_liq_principal: FIG.EX_A_L4_CURTAILMENTS, L5_interest_funding_curtail: FIG.EX_A_L5_INTEREST_FUNDINGS, L7_payoff_fixed_installment_net: FIG.EX_A_L7_PAYOFF_FIXED_NET, L8_delinquent_pi_net: FIG.EX_A_L8_DELINQUENT_PI_NET, L9_fnma_receivable: FIG.EX_A_L9_FNMA_RECEIVABLE, L10_fnma_receivable_adj: FIG.EX_A_L10, L11_other: FIG.EX_A_L11 };
const REMITTANCE = "S/S MBS";
async function bookComposition(period: string): Promise<void> {
  for (const [code, cents] of Object.entries(COMPOSITION)) await db.query(`INSERT INTO remittance_components (custodial_account_id, period, remittance_type, pool_class, component_code, amount_cents) VALUES ($1, $2, $3, 'mbs', $4, $5) ON CONFLICT (custodial_account_id, period, component_code) DO UPDATE SET amount_cents = EXCLUDED.amount_cents`, [fx.custodial.pi, period, REMITTANCE, code, cents]);
}
/** The custodial cash through 9/30: one balanced set (Dr custodial_pi_cash / Cr fnma_remittance_payable) — 2.1's postings in aggregate, rule_ref 2.1. */
async function bookCashbook(cents: bigint, effective: string, ruleRef: string, description: string): Promise<string> {
  const id = randomUUID();
  await db.tx((q) => new PgLedgerRepository(q).post({ id, effectiveDate: D(effective), description, postedAt: clock.now(), lines: [
    { id: randomUUID(), setId: id, account: { scope: "custodial", custodialAccountId: fx.custodial.pi, account: "custodial_pi_cash" }, amountCents: cents, ruleRef, sequence: 1 },
    { id: randomUUID(), setId: id, account: { scope: "custodial", custodialAccountId: fx.custodial.pi, account: "fnma_remittance_payable" }, amountCents: -cents, ruleRef, sequence: 2 }] } as unknown as Parameters<PgLedgerRepository["post"]>[0], q));
  return id;
}
/** A BAI2 prior-day file whose 015 (closing ledger) is the balance of record — the bytes 35.2 stores and the reviewer re-reads. */
const bai2 = (asOf: string, closingCents: bigint, credits: readonly { cents: bigint; text: string }[]): string => {
  const d = asOf.replace(/-/g, "").slice(2); const acct = "1234567890";
  const lines = [`01,SENDER,RECEIVER,${d},1200,1,,,2/`, `02,RECEIVER,SENDER,1,${d},1200,USD,2/`, `03,${acct},USD,010,${closingCents - credits.reduce((s, c) => s + c.cents, 0n)},,,015,${closingCents},,/`];
  for (const c of credits) lines.push(`16,165,${c.cents},Z,${randomUUID().slice(0, 8)},,${c.text}/`);
  const acctTotal = closingCents * 2n - credits.reduce((s, c) => s + c.cents, 0n) + credits.reduce((s, c) => s + c.cents, 0n);
  lines.push(`49,${acctTotal},${lines.length - 2 + 1}/`, `98,${acctTotal},1,${lines.length}/`, `99,${acctTotal},1,${lines.length + 1}/`);
  return lines.join("\n") + "\n";
};
/** 6.3's statement of record for the day: the `documents` row of the file (sha256 of the bytes), the bytes behind the port, and 6.3's own `custodial.statement.received` receipt naming both. */
async function statementOfRecord(asOf: string, closingCents: bigint, credits: readonly { cents: bigint; text: string }[] = []): Promise<{ document_id: string; event_id: string }> {
  const text = bai2(asOf, closingCents, credits); const bytes = Buffer.from(text, "utf8");
  const sha = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
  const document_id = randomUUID();
  await db.query(`INSERT INTO documents (id, kind, sha256, byte_size, storage_uri, mime_type, retention_class, metadata) VALUES ($1, 'bank_statement', $2, $3, $4, 'text/plain', 'corporate_7y', $5::jsonb)`, [document_id, sha, bytes.length, `fake-blob://${document_id}`, JSON.stringify({ custodial_account_id: fx.custodial.pi, as_of_date: asOf, format: "bai2" })]);
  docs.set(document_id, bytes);
  const r = await runtime.uow.run({}, (ctx) => ctx.events.append({ type: "custodial.statement.received", aggregate: { kind: "custodial_account", id: fx.custodial.pi }, actor: AGENT, payload: { custodial_account_id: fx.custodial.pi, statement_id: `stmt-${asOf}-${document_id.slice(0, 8)}`, file_id: document_id, document_id, format: "bai2", as_of_date: asOf, control_totals_ok: true, closing_ledger_cents: closingCents.toString(), closing_available_cents: null, balance_of_record: "closing_ledger_015_CLBD", all_active_accounts: true, active_accounts: [fx.custodial.pi], received_accounts: [fx.custodial.pi] } }), { clock });
  return { document_id, event_id: r.events[0]!.id };
}
/** 6.3's in-transit item of worked example A: the lockbox batch posted 9/30, bank credit 10/1 (rule 2 iv's register). */
async function depositInTransit(cents: bigint, firstSeen: string): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO reconciliation_items (id, custodial_account_id, category, severity, amount_cents, first_seen_on, root_cause, status) VALUES ($1, $2, 'deposit_in_transit', 'low', $3, $4::date, 'lockbox batch LBX-0930-07 posted 9/30, bank credit 10/1 (14 loans)', 'open')`, [id, fx.custodial.pi, cents, firstSeen]);
  return id;
}

test("35.4-T1: Given the demo book on the hosted runtime and the sweep's first run at/after 2026-10-01 00:05 ET, when 35.3's planner emits `ledger.month.ended{period_key: \"2026-09\", period_end: \"2026-09-30\"}` on the global subject and `close.open` runs, then exactly one `close_periods` row exists (kind month, period 2026-09, status open) with the 11 month-chain steps of rule 1 plus `eligibility` (September is a quarter-end) each carrying the table's `depends_on`, `eod_cutoff` is `planned` and `custodial_day_close`, `metro2_snapshot`, `lar`, `period_close`, `ledger_period_close`, `balance_attestation`, `form496`, `form496a`, `qc_cycle`, `star` and `eligibility` are `blocked`, `close.period.opened` is logged once, `SM_CLOSE_PERIOD_OPEN_BD1` (due 2026-10-01 17:00 ET) is satisfied and `SM_CLOSE_ATTEST_BD5` is armed with `due_at` 2026-10-07 17:00 ET; a second `close.open` for 2026-09 returns the same row, adds no step and logs no second `close.period.opened`.", { skip }, async () => {
  // the last sweep of September, then the first at/after 2026-10-01 00:05 ET: the planner's first pass in the new month emits `ledger.month.ended` once on the global subject
  await sweepAt(et("2026-09-30", "23:59"));
  const first = await sweepAt(et("2026-10-01", "00:05"));
  assert.equal(first.close?.month_ended_emitted, "2026-09", first.close?.line);
  const ended = await db.query<{ payload: Record<string, unknown>; aggregate_kind: string; aggregate_id: string }>(`SELECT payload, aggregate_kind, aggregate_id FROM loan_events WHERE type = 'ledger.month.ended' AND payload->>'period_key' = '2026-09'`);
  assert.equal(ended.length, 1); assert.deepEqual([ended[0]!.payload["period_key"], ended[0]!.payload["period_end"], ended[0]!.aggregate_kind], ["2026-09", "2026-09-30", "global"]);
  const periods = await db.query<{ id: string; kind: string; status: string; period_end: string }>(`SELECT id::text AS id, kind, status, period_end::text AS period_end FROM close_periods WHERE period = '2026-09' AND servicer_number = $1`, [SN]);
  assert.equal(periods.length, 1); assert.equal(periods[0]!.kind, "month"); assert.equal(periods[0]!.status, "open"); assert.equal(periods[0]!.period_end, "2026-09-30");
  const s = await steps("2026-09");
  assert.deepEqual(s.map((x) => x.code), ["eod_cutoff", "custodial_day_close", "metro2_snapshot", "lar", "period_close", "ledger_period_close", "balance_attestation", "form496", "form496a", "qc_cycle", "star", "eligibility"]);   // the 11 + eligibility (quarter end)
  const deps = Object.fromEntries(s.map((x) => [x.code, x.depends_on]));
  assert.deepEqual(deps, { eod_cutoff: [], custodial_day_close: ["eod_cutoff"], metro2_snapshot: ["eod_cutoff"], lar: ["eod_cutoff"], period_close: ["lar"], ledger_period_close: ["custodial_day_close"], balance_attestation: ["ledger_period_close", "period_close", "metro2_snapshot"], form496: ["ledger_period_close", "period_close"], form496a: ["ledger_period_close"], qc_cycle: ["period_close"], star: ["period_close"], eligibility: ["period_close"] });
  assert.equal(s.find((x) => x.code === "eod_cutoff")!.status, "planned");
  for (const code of ["custodial_day_close", "metro2_snapshot", "lar", "period_close", "ledger_period_close", "balance_attestation", "form496", "form496a", "qc_cycle", "star", "eligibility"]) assert.equal(s.find((x) => x.code === code)!.status, "blocked", code);
  assert.equal(await count(db, `FROM loan_events WHERE type = 'close.period.opened' AND payload->>'period' = '2026-09'`), 1);
  const [open] = await timer("SM_CLOSE_PERIOD_OPEN_BD1"); assert.equal(open!.status, "satisfied"); assert.equal(open!.due_at, et("2026-10-01", "17:00")); assert.equal(open!.subject_kind, "global");
  const [attest] = await timer("SM_CLOSE_ATTEST_BD5", periodAggregate(SN, "2026-09").id); assert.equal(attest!.status, "armed"); assert.equal(attest!.due_at, et("2026-10-07", "17:00")); assert.equal(attest!.anchor_date, "2026-09-30");
  // a second close.open (35.3's planner re-emitting after a crash, or a hand call) returns the same row: no new step, no second `close.period.opened`, the duplicate journaled
  const again = await tool("close.open", AGENT, { period: "2026-09", source_event_id: randomUUID() });
  assert.equal((again.output as { created: boolean; close_period_id: string }).created, false); assert.equal((again.output as { close_period_id: string }).close_period_id, periods[0]!.id);
  assert.equal(await count(db, `FROM close_period_steps WHERE close_period_id = $1`, [periods[0]!.id]), 12);
  assert.equal(await count(db, `FROM loan_events WHERE type = 'close.period.opened' AND payload->>'period' = '2026-09'`), 1);
  assert.equal(await count(db, `FROM close_period_events WHERE close_period_id = $1 AND type = 'close.period.opened' AND payload->>'duplicate' = 'true'`, [periods[0]!.id]), 1);
  assert.equal((await timer("SM_CLOSE_ATTEST_BD5", periodAggregate(SN, "2026-09").id)).length, 1, "no second clock");
});
test("35.4-T2: Given period 2026-09 open with `ledger.period.closed` recorded for every P&I account but no `investor_reporting_periods.closed{period: \"2026-09\", checklist_complete: true}`, when the planner runs, then no 35.3 `jobs` row exists for `form496`, `close.board{period: \"2026-09\"}` lists `form496` as `blocked` with `missing: [\"period_close\"]`, and `close.step.start{step: \"form496\"}` by hand is refused `STEP_BLOCKED{missing: [\"period_close\"]}` and writes nothing.", { skip }, async () => {
  clock.set(et("2026-10-01", "09:00"));
  await bookComposition("2026-09");
  await bookCashbook(FIG.EX_A_CASHBOOK, "2026-09-29", "2.1:r8:cash_in", "September collections through 9/30 (2.1's cash-in sets, in aggregate)");
  await statementOfRecord("2026-09-30", FIG.EX_A_BANK_CLOSING_LEDGER, [{ cents: 125_000n, text: "J SMITH" }]);
  await depositInTransit(FIG.EX_A_DEPOSITS_IN_TRANSIT, "2026-09-30");
  // the owners' receipts: 35.5's day (the stand-in literal), 6.3's daily close and its month-end cut-off per account (6.3's own tool)
  await ownerEvent("cashiering.daily.run_completed", { as_of_date: "2026-09-30", run_id: randomUUID(), cycle_code: "cashiering_daily", period_key: "2026-09-30", loans: 1 }, { kind: "agent", id: "cashiering" });
  await closeDay63(fx.custodial.pi, "2026-09-30", FIG.EX_A_BANK_CLOSING_LEDGER, FIG.EX_A_DEPOSITS_IN_TRANSIT, FIG.EX_A_CASHBOOK);
  await closePeriod63(fx.custodial.pi, "pi", "2026-09-30", "S/S MBS");
  await closePeriod63(fx.custodial.ti, "ti", "2026-09-30");
  await sweepAt(et("2026-10-01", "09:01"));
  assert.equal(await stepStatus("2026-09", "eod_cutoff"), "completed"); assert.equal(await stepStatus("2026-09", "custodial_day_close"), "completed"); assert.equal(await stepStatus("2026-09", "ledger_period_close"), "completed");
  assert.equal(await stepStatus("2026-09", "form496"), "blocked");
  // no 35.3 job for form496: its table when present, else the journal (the planner records the units it plans there)
  if ((await db.query<{ r: string | null }>(`SELECT to_regclass('public.jobs')::text AS r`))[0]!.r) assert.equal(await count(db, `FROM jobs WHERE cycle_code = 'form_496_monthly' AND period_key = '2026-09'`), 0);
  assert.equal(await count(db, `FROM close_period_events e JOIN close_period_steps s ON s.id = e.step_id WHERE s.code = 'form496' AND e.type = 'close.step.planned'`), 0);
  const board = (await tool("close.board", AGENT, { period: "2026-09" })).output as { steps: { code: string; status: string; missing: string[] }[] };
  const f = board.steps.find((x) => x.code === "form496")!; assert.equal(f.status, "blocked"); assert.deepEqual(f.missing, ["period_close"]);
  const before = { j: await count(db, `FROM close_period_events`), e: await count(db, `FROM loan_events`), s: JSON.stringify(await steps("2026-09")), d: await count(db, `FROM agent_decisions`) };
  const r = await refused(tool("close.step.start", AGENT, { period: "2026-09", step: "form496" }));
  assert.equal(r.code, "STEP_BLOCKED"); assert.deepEqual(r.detail?.["missing"], ["period_close"]);
  assert.equal(await count(db, `FROM close_period_events`), before.j); assert.equal(await count(db, `FROM loan_events`), before.e); assert.equal(JSON.stringify(await steps("2026-09")), before.s); assert.equal(await count(db, `FROM agent_decisions`), before.d);
});
test("35.4-T3: Given period 2026-09 with `ledger.period.closed{period_end: \"2026-09-30\"}` for every P&I account and 5.1's `investor_reporting_periods.closed{period: \"2026-09\", checklist_complete: true}`, when the next sweep runs, then `form496` is `planned` with one 35.3 job per (custodial account × remittance type), `close.step.started{step_id}` is logged when the first unit is claimed and `SM_CLOSE_STEP_STALLED_2BD` is armed on the period aggregate anchored on `started_at`; given only one of the two receipts, then `form496` is still `blocked`.", { skip }, async () => {
  // only one of the two receipts (ledger.period.closed, from T2) → still blocked
  assert.equal(await stepStatus("2026-09", "form496"), "blocked");
  // the second receipt: 35.3's BD1 LAR run (the stand-in literal) unblocks period_close; 5.1's own close emits investor_reporting_periods.closed{checklist_complete: true}
  clock.set(et("2026-10-01", "20:30"));
  await ownerEvent("investor.lar.run_completed", { as_of_date: "2026-10-01", run_id: randomUUID(), cycle_code: "lar_daily", period_key: "2026-10-01", units_total: 1, units_done: 1 }, { kind: "agent", id: "investor-reporting" });
  await sweepAt(et("2026-10-01", "20:31"));
  assert.equal(await stepStatus("2026-09", "lar"), "completed"); assert.equal(await stepStatus("2026-09", "period_close"), "planned");
  await closePeriod51("2026-09", et("2026-10-02", "16:00"));
  clock.set(et("2026-10-02", "16:01"));
  await sweepAt(et("2026-10-02", "16:01"));
  assert.equal(await stepStatus("2026-09", "period_close"), "completed");
  const f = (await steps("2026-09")).find((x) => x.code === "form496")!;
  assert.equal(f.status, "planned"); assert.equal(f.expected_receipts, 1, "one unit per (P&I account × remittance type): one S/S MBS account");
  const planned = await db.query<{ payload: { units: string[]; cycle_code: string } }>(`SELECT e.payload FROM close_period_events e JOIN close_period_steps s ON s.id = e.step_id WHERE s.code = 'form496' AND e.type = 'close.step.planned'`);
  assert.equal(planned.length, 1); assert.equal(planned[0]!.payload.cycle_code, "form_496_monthly"); assert.deepEqual(planned[0]!.payload.units, [`${fx.custodial.pi}:${REMITTANCE}`]);
  if ((await db.query<{ r: string | null }>(`SELECT to_regclass('public.jobs')::text AS r`))[0]!.r) assert.equal(await count(db, `FROM jobs WHERE cycle_code = 'form_496_monthly' AND period_key = '2026-09'`), 1);
  // the first unit claimed (35.3's executor, or by hand): close.step.started, the stall clock armed on the period aggregate from started_at
  const startedAt = et("2026-10-05", "10:00"); clock.set(startedAt);
  await tool("close.step.start", AGENT, { period: "2026-09", step: "form496" });
  const started = await db.query<{ payload: Record<string, unknown>; aggregate_kind: string; aggregate_id: string }>(`SELECT payload, aggregate_kind, aggregate_id FROM loan_events WHERE type = 'close.step.started' AND payload->>'step' = 'form496'`);
  assert.equal(started.length, 1); assert.equal(started[0]!.payload["step_id"], (await db.query<{ id: string }>(`SELECT s.id::text AS id FROM close_period_steps s JOIN close_periods p ON p.id = s.close_period_id WHERE p.period = '2026-09' AND s.code = 'form496'`))[0]!.id);
  assert.equal(started[0]!.aggregate_kind, "close_period"); assert.equal(started[0]!.aggregate_id, stepAggregate(SN, "2026-09", "form496").id); assert.ok(started[0]!.aggregate_id.startsWith(periodAggregate(SN, "2026-09").id + ":"));
  const [stall] = await timer("SM_CLOSE_STEP_STALLED_2BD", stepAggregate(SN, "2026-09", "form496").id);
  assert.equal(stall!.status, "armed"); assert.equal(stall!.subject_kind, "close_period"); assert.equal(stall!.anchor_date, "2026-10-05"); assert.equal(stall!.due_at, et("2026-10-07", "17:00"));
  assert.equal(await stepStatus("2026-09", "form496"), "running");
});
test("35.4-T4: Given the demo clock advanced from 2026-09-28 to 2026-11-16 with FAKE reviewers on, then `close_periods` rows exist for 2026-09 and 2026-10, every `close_period_events` receipt for each period was recorded once (unique `source_event_id`), for every step `completed_at` is at or after each of its dependencies' `completed_at` (no step completed before a dependency), 2026-09 reached `attested` no later than 2026-10-07 17:00 ET and `closed` once `form496`, `form496a`, `qc_cycle`, `star` and `eligibility` had their receipts, and the receipts appear in the journal in the order `eod_cutoff → custodial_day_close → lar → period_close → ledger_period_close → balance_attestation → form496`.", { todo: true });
test("35.4-T5: Given the September 2026 S/S MBS P&I account with 6.3's worked-example balances — bank closing ledger $1,254,300.55, deposits in transit $12,450.00, composition L3 $8,120.40, L4 $45,000.00, L5 $0.00, L7 $3,210.15, L8 −$22,580.00, L9 $1,233,000.00, L10 $0.00, L11 $0.00 — and a cashbook of 126,675,055 cents on `custodial_pi_cash`, when `close.attest` runs after `ledger_period_close`, `period_close` and `metro2_snapshot` completed with a passed `close.review` and an `officer` approval, then one `close_attestations` row has `adjusted_depository_cents = 126675055n` ($1,266,750.55), `composition_l12_cents = 126675055n`, `cashbook_cents = 126675055n`, `variance_cents === 0n` ($0.00), `composition_snapshot` = {L3: \"812040\", L4: \"4500000\", L5: \"0\", L7: \"321015\", L8: \"-2258000\", L9: \"123300000\", L10: \"0\", L11: \"0\"}, both decision ids and the officer approval id, `close.period.attested{attestation_id, variance_cents: \"0\"}` is logged, `SM_CLOSE_ATTEST_BD5` is satisfied, `close_periods.status = attested`, and 6.3's `FNMA_F496_PI_RECON_45` is still `armed` with `due_at` 2026-11-13 17:00.", { todo: true });
test("35.4-T6: Given the same account with the cashbook at 126,675,055 cents but a bank closing ledger of $1,253,050.55 and no in-transit item explaining the $1,250.00, when `close.attest` runs, then a `close_attestations` row is written with `outcome = variance` and `variance_cents = -125000n`, one `qc_officer` escalation names the period, account and variance, `close.attestation.variance` is logged, `close_periods.status` stays `open`, the row counts of `ledger_lines`, `payments`, `reconciliations` and `reconciliation_items` are identical before and after, and `close.attest` called again with `force: true` (and separately with `tolerance_cents: \"125000\"`) is refused `NO_PLUG` with no row written.", { todo: true });
test("35.4-T7: Given the `form496` step started 2026-10-05 10:00 ET with no `custodial.reconciliation.completed{kind: monthly_form_496}` since, when the sweep passes 2026-10-07 17:01 ET, then `SM_CLOSE_STEP_STALLED_2BD` is `breached`, exactly one `ops_analyst` escalation carries `{timer_code: \"SM_CLOSE_STEP_STALLED_2BD\", period: \"2026-09\", step: \"form496\"}`, `close.board` shows the step `stalled`, and 6.3's `FNMA_F496_PI_RECON_45` and `SM_F496_DRAFT_BD10` instances are unchanged (still `armed`, same `due_at`); when the receipt arrives 2026-10-09, then the step is `completed` and the stall label is gone.", { todo: true });
test("35.4-T8: Given configuration `custodial.form496.human_approval = on`, when `close.attest` is called by the agent with a passed review and no `officer` approval record, then it is refused `OFFICER_APPROVAL_REQUIRED` and no attestation row, event or timer change exists; when an `agent_decisions` row by `{human, <id>, officer}` with action `close.attest.approve` for the period and account exists, then the attestation is written with `officer_approval_id` and `human_approval_flag = true`; given the flag off, then the attestation is written without an approval and `human_approval_flag = false`; given a request carrying `human_approval_on: false` while the configuration is on, then the request field is ignored and the call is refused `OFFICER_APPROVAL_REQUIRED`; given an `ops_analyst` actor calling `close.attest.approve`, then `ROLE_DENIED`.", { todo: true });
test("35.4-T9: Given a preparer decision by `custodial-recon` run R1 for the September attestation, when `close.review` is called with run R1's id or with the preparer's credentials, then it is refused `REVIEWER_NOT_INDEPENDENT`; when `qc-audit` runs it under `reviewer_roles` credentials (35.7), then the review's own query over `ledger_lines` and `remittance_components` yields `cashbook_cents = 126675055n` and `composition_l12_cents = 126675055n`, the closing ledger is re-read from the stored statement document's bytes (35.2) as 125,430,055 cents, and a reviewer decision row with `rule_set_version: close.v1` exists.", { todo: true });
test("35.4-T10: Given period 2026-09 `attested` at variance $0.00 (T5), when the depository restates the 9/30 statement to $1,253,050.55 because a $1,250.00 deposit was returned, then the agent's proposal writes a decision and no state change; `close.reopen{period: \"2026-09\", reason, trigger_event_id}` by an `officer` sets `status = reopened`, logs `close.period.reopened{by, reason}`, writes a `close_reopens` row with `steps_reset = [\"custodial_day_close\", \"ledger_period_close\", \"balance_attestation\", \"form496\", \"form496a\"]` and `steps_kept = [\"lar\", \"period_close\", \"metro2_snapshot\"]` (each relabelled `pre_reopen`), and after 2.1's `payment.reversed` for the $1,250.00 the re-attestation row shows `adjusted_depository_cents = 126550055n` ($1,265,500.55), L3 `687040` ($6,870.40), `composition_l12_cents = 126550055n`, `cashbook_cents = 126550055n`, `variance_cents === 0n`, `supersedes_attestation_id` = the T5 row's id, while the T5 row is byte-for-byte unchanged; a `close.reopen` by an agent or an `ops_analyst` is refused `OFFICER_REOPEN_ONLY`; a reopen of 2026-09 after 2026-10 is `attested` is refused `SUCCESSOR_ATTESTED_NO_REOPEN`.", { todo: true });
test("35.4-T11: Given the December 2026 period with `period_close` and `ledger_period_close` completed and three reportable loans with 2026 `interest_due` credits from borrower funds of $23,412.55, $9,870.12 and $412.40 and no loan with escrow interest at or above $10.00 (`ioe_1099_loans = 0`), when the sweep first passes 2027-01-02 00:05 ET, then `close.tax_year{tax_year: 2026}` runs once, 7.1's `tax_year.closed{tax_year: 2026}` exists for each of the three loans and arms `IRS_6050H_1098_FURNISH_0131` (due 2027-01-31) and `IRS_6050H_1098_FILE_0331` per loan, a `tax_year_closes` row has `reportable_loans = 3` and `ledger_interest_sum_cents = 3369507n` ($33,695.07), a kind `tax_year` `close_periods` row for 2026 exists with steps `form_1098_furnish`, `form_1099_int_furnish`, `form_1099_ac_furnish`, `form_1098_file`, `form_1099_int_file`, `form_1099_ac_file`, `close.tax_year.closed{tax_year: 2026}` satisfies `SM_TAX_YEAR_CLOSE_3BD` (armed by `close.tax_year.planned` on the December open, `due_at` 2027-01-06 17:00 ET), and a second pass changes nothing.", { todo: true });
test("35.4-T12: Given T11 and 7.1's 1098 run furnished all three forms (box 1 $23,412.55, $9,870.12, $412.40) and filed the two at or above $600.00, when the tax-year attestation runs, then the `close_attestations` row (kind tax_year) has `reportable_loans = 3`, `furnished_count = 3`, `filed_count = 2`, `box1_sum_cents = 3369507n`, `ledger_interest_sum_cents = 3369507n`, `variance_cents === 0n` and `outcome = attested`; given one form unfurnished, then `outcome = variance`, an `officer` escalation names the loan and the period stays `open`.", { todo: true });
test("35.4-T13: Given every 35.4 tool on the bus, then a contract test runs each with a valid input against the fixture and asserts that the row counts and the `*_cents` columns of `ledger_lines`, `payments`, `reconciliations`, `reconciliation_items`, `remittance_components`, `investor_reporting_periods` and `tax_forms_1098` are identical before and after, that no 35.4 tool emits any event type outside the list in \"Outputs and artifacts\", that no `timers` row of another section's code changed status, and that every state-changing call left one `agent_decisions` row with `rule_set_version: close.v1` and `prompt_version: 35.4-v1`.", { todo: true });
test("35.4-T14: Given two sweeps started within the same minute on 2026-10-02 (35.3's planner lock held by one), then one `close_periods` row and one step set exist for 2026-09, every receipt is journaled once, and `close.board{period: \"2026-09\"}` returns each step with `status`, `depends_on`, `missing`, `receipt_event_ids`, `owner_timer_code` and `owner_due_at` read from `timers` (`FNMA_F496_PI_RECON_45` → 2026-11-13 17:00 for `form496`; `FNMA_A4101_QC_CYCLE_MONTHLY`'s BD20 for `qc_cycle`), the attestation summary and the reopen history; `close.board` is a read tool and a contract test shows no row changed across the call.", { skip }, async () => {
  // 18.1's own monthly tick (BD3 = Mon 2026-10-05) arms FNMA_A4101_QC_CYCLE_MONTHLY: BD3 + 17 business_days_servicer = BD20
  const ticks = qcScheduleTicks(D("2026-10-05"));
  assert.ok(ticks.some((t) => t.type === "schedule.tick"));
  clock.set(et("2026-10-05", "06:00"));
  await runtime.uow.run({}, (ctx) => { for (const t of ticks) ctx.events.append(t); }, { clock });
  const bd20 = addBusinessDays(D("2026-10-05"), 17, servicerCal);
  // two sweeps in the same minute: one holds the lease, the other writes sweep_runs{skipped, lease_held}
  const at = et("2026-10-02", "10:00"); clock.set(at);
  const [a, b] = await Promise.all([runtime.sweep(at, { verify: false, holder: "sweep-a" }), runtime.sweep(at, { verify: false, holder: "sweep-b" })]);
  assert.deepEqual([a.outcome, b.outcome].sort(), ["completed", "skipped"]);
  assert.equal(await count(db, `FROM close_periods WHERE period = '2026-09' AND servicer_number = $1`, [SN]), 1);
  assert.equal(await count(db, `FROM close_period_steps s JOIN close_periods p ON p.id = s.close_period_id WHERE p.period = '2026-09' AND p.servicer_number = $1`, [SN]), 12);
  const receipts = await db.query<{ n: string; d: string }>(`SELECT count(*)::text AS n, count(DISTINCT source_event_id)::text AS d FROM close_period_events e JOIN close_periods p ON p.id = e.close_period_id WHERE p.period = '2026-09' AND e.type = 'close.receipt.recorded'`);
  assert.equal(receipts[0]!.n, receipts[0]!.d); assert.ok(Number(receipts[0]!.n) >= 5, `receipts journaled: ${receipts[0]!.n}`);
  const snapshot = async () => JSON.stringify(await db.query(`SELECT (SELECT count(*)::text FROM close_periods) AS a, (SELECT count(*)::text FROM close_period_steps) AS b, (SELECT count(*)::text FROM close_period_events) AS c, (SELECT count(*)::text FROM close_attestations) AS d, (SELECT count(*)::text FROM close_reopens) AS e, (SELECT count(*)::text FROM tax_year_closes) AS f, (SELECT count(*)::text FROM agent_decisions) AS g, (SELECT count(*)::text FROM escalations) AS h, (SELECT md5(string_agg(status::text || coalesce(satisfied_at::text, ''), ',' ORDER BY id)) FROM timers) AS t, (SELECT md5(string_agg(status || received::text || coalesce(started_at::text, ''), ',' ORDER BY id)) FROM close_period_steps) AS u`));
  const before = await snapshot();
  const r = await tool("close.board", AGENT, { period: "2026-09" });
  assert.equal(await snapshot(), before, "a read changes no row");
  assert.equal(r.decisions.length, 0, "a read leaves no decision row");
  const board = r.output as { period: { status: string }; steps: { code: string; status: string; depends_on: string[]; missing: string[]; receipt_event_ids: string[]; owner_timer_code: string | null; owner_due_at: string | null }[]; attestations: unknown[]; reopens: unknown[] };
  for (const s of board.steps) for (const k of ["status", "depends_on", "missing", "receipt_event_ids", "owner_timer_code", "owner_due_at"]) assert.ok(k in s, `${s.code}.${k}`);
  const f496 = board.steps.find((s) => s.code === "form496")!; assert.equal(f496.owner_timer_code, "FNMA_F496_PI_RECON_45"); assert.equal(f496.owner_due_at, et("2026-11-13", "17:00"));
  const qc = board.steps.find((s) => s.code === "qc_cycle")!; assert.equal(qc.owner_timer_code, "FNMA_A4101_QC_CYCLE_MONTHLY"); assert.equal(qc.owner_due_at, et(bd20, "23:59"), "BD20 (end of the servicer business day, ET)");
  const lpc = board.steps.find((s) => s.code === "ledger_period_close")!; assert.equal(lpc.receipt_event_ids.length, 2); assert.deepEqual(lpc.missing, []);
  assert.ok(Array.isArray(board.attestations) && Array.isArray(board.reopens));
});
test("35.4-T15: Given period 2026-10 (period_end Sat 2026-10-31), when the planner runs at 2026-11-01 00:05 ET, then `ledger.month.ended{period_key: \"2026-10\", period_end: \"2026-10-31\"}` is emitted once, `SM_CLOSE_PERIOD_OPEN_BD1` has `due_at` Mon 2026-11-02 17:00 ET and `SM_CLOSE_ATTEST_BD5` Fri 2026-11-06 17:00 ET (`business_days_fannie_et`), `eod_cutoff` completes on 35.5's `cashiering.daily.run_completed{as_of_date: \"2026-10-31\"}` (a Saturday run), `metro2_snapshot` is `planned` no earlier than 2026-11-01 00:05 ET with `receipt_filter {as_of_date: \"2026-10-31\"}`, and no step of 2026-10 is planned before 2026-09's `balance_attestation` completed unless 2026-09 is `attested` (a period's `form496` may still be running).", { todo: true });
export const _figures = { addDays };
