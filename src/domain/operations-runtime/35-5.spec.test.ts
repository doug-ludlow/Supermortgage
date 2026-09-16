// 35.5 The installment schedule and the daily cashiering cycle: `loan_installments` at fund and at transfer boarding, the whole-book 2.1/2.7/2.3 sweep, lockbox ingest, ACH origination and NACHA returns as cycles, and the per-loan jurisdiction, time-zone and servicer-identity configuration
// spec/sections/35-operations-runtime/35-5-the-installment-schedule-and-the-daily-cashiering-cycle.md
// One node:test per T-id, named exactly as the spec (assembled by tools/s35_5/gen_spec_test.py from the manifest's text;
// the bodies live in tools/s35_5/bodies). `todo: true` = not implemented yet (tools/audit.py does not count it).
//
// Every T-id runs against Postgres (operational prerequisite: "every T-id here runs against Postgres" — REQUIRE_DB=1 in CI);
// the file has its own database (src/infra/db/test-db.ts). Every money figure below is one the spec states, asserted to the
// cent against the rows, the ledger or the events the build wrote — never a hand-fed figure the test then reads back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { connect, type Db, type Queryable } from "../../infra/db/client.ts";
import { testDatabase } from "../../infra/db/test-db.ts";
import { PgLoanRepository, type Fixture } from "../../infra/db/loans.ts";
import { loadOverriddenRegistry } from "../../domain/timer-overrides.ts";
import { FixedClock, type Actor } from "../../kernel/events/index.ts";
import { plainDate as D, addMonths, type PlainDate } from "../../kernel/calendar/date.ts";
import { levelPayment, type Cents } from "../../kernel/money/cents.ts";
import { Decimal } from "../../kernel/money/decimal.ts";
import { Runtime, type RuntimeDeps } from "../../runtime/app.ts";
import { createApiServer, listen } from "../../runtime/server.ts";
import { createLogger } from "../../runtime/log.ts";
import { compute, defineTools, type ToolDef } from "../../app/tools.ts";
import { noteTermsHash } from "../orig-boarding/ops-30-2.ts";
import { generateDemoBatch, DEMO_BATCH } from "../boarding/demo-batch.ts";
import { encodeTransferBatch, type TransferBatchData } from "../boarding/tape-codec.ts";
import type { StagedLoan, Installment, HistoricalPayment } from "../boarding/types.ts";
import { boardTransferBatch, type TransferBatchInput } from "../../runtime/transfers.ts";
import { sendPeriodicStatement, loanCashState } from "../../runtime/servicing.ts";
import { fundApplication, demoSnapshot, demoFunded } from "../../runtime/origination.ts";
import { lateChargeAmount } from "../cashiering/latecharges.ts";
import { delinquencyDailySweep } from "../../runtime/delinquency.ts";
import { projectSchedule, readInstallments, scheduleRuns, rowInterest, levelPaymentBps, INSTALLMENT_EVENTS } from "./installments.ts";
import { FAKE_SERVICER_CONTACT, FAKE_SERVICER_PROFILE_V1_ID, servicerProfileVersions, loanServicingConfig, STATE_TIME_ZONES } from "./servicing-config.ts";

const { url: DB_URL, skip } = await testDatabase(import.meta.url);
const TOKEN = "t-" + randomUUID();
/** The file's base instant: after the demo hand-off's funding (2026-11-12T18:40Z) so `POST /v1/applications/{id}/fund` boards the demo note. */
const NOW = "2026-11-16T15:00:00.000Z";
const CASHIERING: Actor = { kind: "agent", id: "cashiering" };
const SYSTEM: Actor = { kind: "system", id: "test" };
const FUNDING: Actor = { kind: "human", id: "u-funder", role: "funding_approver" };
const OFFICER: Actor = { kind: "human", id: "u-officer-1", role: "officer" };
const COMPLIANCE: Actor = { kind: "human", id: "u-compliance-1", role: "compliance" };
const OPS_ANALYST: Actor = { kind: "human", id: "u-analyst-1", role: "ops_analyst" };

let db: Db; let runtime: Runtime; let base = ""; let close: () => Promise<void> = async () => undefined;
let n = 0;
const uniq = (): string => `${Date.now() % 1_000_000}${(n++).toString().padStart(3, "0")}`.padStart(10, "0");
const count = async (q: Queryable, sql: string, params: unknown[] = []): Promise<number> => Number((await q.query<{ c: string }>(`SELECT count(*)::text AS c ${sql}`, params))[0]!.c);
const one = async <T extends Record<string, unknown>>(q: Queryable, sql: string, params: unknown[] = []): Promise<T> => { const r = await q.query<T>(sql, params); assert.ok(r[0], `no row: ${sql}`); return r[0]!; };
const big = (v: unknown): Cents => BigInt(String(v));
const call = async (method: string, path: string, body?: unknown, at: string = base): Promise<{ status: number; body: Record<string, unknown> }> => {
  const r = await fetch(at + path, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) } : {}) });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
/** A runtime over this file's database on its own clock (the boarding, the unit and the statement each run "on" a stated day). */
const rtAt = (iso: string, deps: Partial<RuntimeDeps> = {}): Runtime => new Runtime({ db, registry: loadOverriddenRegistry(), clock: new FixedClock(iso), ...deps });
/** The same, with an HTTP door (T1, T2, T5 and T15 drive the routes). */
async function serverAt(iso: string, deps: Partial<RuntimeDeps> = {}): Promise<{ rt: Runtime; base: string; close: () => Promise<void> }> {
  const rt = rtAt(iso, deps);
  const server = createApiServer({ runtime: rt, apiToken: TOKEN, logger: createLogger("json", () => undefined) });
  const b = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  return { rt, base: b, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
/** An ad-hoc tool on the bus (a test's way to append an event a sibling process would have emitted, inside a real command on the loan). */
const testTool = (name: string, handler: Parameters<typeof compute>[0]): ToolDef => defineTools("35.5", "cashiering", [{ name, kind: "act", handler: compute(handler) }])[0]!;
const events = async (loanId: string, type?: string): Promise<{ id: string; type: string; payload: Record<string, unknown>; actor_kind: string; actor_id: string; occurred_at: string }[]> =>
  db.query(`SELECT id::text AS id, type, payload, actor_kind, actor_id, occurred_at::text AS occurred_at FROM loan_events WHERE loan_id = $1 AND ($2::text IS NULL OR type = $2) ORDER BY sequence`, [loanId, type ?? null]);
const timer = async (code: string, loanId: string | null): Promise<{ status: string; anchor_date: string; due_date: string | null; satisfied_by_event_id: string | null }[]> =>
  db.query(`SELECT status::text AS status, anchor_date::text AS anchor_date, due_date::text AS due_date, satisfied_by_event_id::text AS satisfied_by_event_id FROM timers WHERE code = $1 AND ($2::uuid IS NULL OR loan_id = $2) ORDER BY armed_at`, [code, loanId]);

test.before(async () => {
  if (skip) return;
  db = connect(DB_URL);
  runtime = rtAt(NOW);
  const server = createApiServer({ runtime, apiToken: TOKEN, logger: createLogger("json", () => undefined) });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => server.close(() => db.end().then(() => resolve())));
});
test.after(async () => { if (!skip) await close(); });

// ───────── worked example A: the demo hand-off's note (every figure is the spec's; the test asserts the rows the build wrote) ─────────
const A = { upb: 56_000_000n, rate_bps: 61_250, pi: 340_262n, row1_interest: 285_833n, row1_principal: 54_429n, row1_after: 55_945_571n, row2_interest: 285_556n, row2_principal: 54_706n, row2_after: 55_890_865n, row360_interest: 1_727n, row360_principal: 338_435n, row360_pi: 340_162n, sum_interest: 66_494_220n } as const;
// ───────── worked example B: tape loan T-7 ─────────
const B = { original: 30_000_000n, rate_bps: 65_000, pi: 189_620n, escrow: 41_230n, upb: 28_045_824n, row62_interest: 151_915n, row62_principal: 37_705n, row62_after: 28_008_119n, row63_interest: 151_711n, row63_principal: 37_909n, row63_after: 27_970_210n, row360_interest: 1_024n, row360_principal: 189_067n, row360_pi: 190_091n, absorbed: 471n } as const;
// ───────── worked example C: 7.2's Plan 4927 ARM ─────────
const C = { original: 40_000_000n, rate_bps: 57_500, pi: 233_429n, row60_after: 37_104_886n, v2_rate_bps: 63_750, v2_pi: 247_644n, row61_interest: 197_120n, row61_principal: 50_524n, row61_after: 37_054_362n, escrow: 61_250n, next_draft: 308_894n, last_debit: 294_679n } as const;
// ───────── worked example D / 2.7 example K: fixture L-1 ─────────
const L1 = { original: 25_000_000n, rate_bps: 65_000, pi: 158_017n, escrow: 61_240n, payment: 219_257n, upb: 24_977_400n, interest_sep: 135_294n, principal_sep: 22_723n, upb_after_sep: 24_954_677n, interest_oct: 135_171n, principal_oct: 22_846n, curtailment: 10_000n, upb_after_oct: 24_921_831n, draft: 229_257n, nsf_fee: 2_500n, late_charge: 7_901n } as const;
// ───────── worked example E: lockbox LBX-1 ─────────
const E = { item1: 219_257n, item2: 150_000n, item3: 230_850n, control: 600_107n, control_short: 600_007n, variance: 100n } as const;

/** The demo snapshot's note funded through the route on a bare application (the record carries no CD; the FAKE snapshot fills it; `final_cd.pi_cents` is the note's P&I). */
async function fundDemoNote(at: { rt: Runtime; base: string }, overrides: { snapshot?: Record<string, unknown>; funded?: Record<string, unknown>; property?: Record<string, unknown> } = {}): Promise<{ appId: string; loanId: string; fund: Record<string, unknown> }> {
  const partner = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number) VALUES ('servicer', $1, $2) RETURNING id`, [`Lender ${randomUUID().slice(0, 6)}`, "123456789"]))[0]!.id;
  const app = (await at.rt.createApplication({ partner_party_id: partner, channel: "organic", transaction_type: "limited_cash_out", occupancy: "primary", borrowers: [{ legal_name: "Alex Borrower", borrower_role: "borrower" }], property: { address_line1: "100 N Central Ave", city: "Phoenix", state: "AZ", postal_code: "85004", county: "Maricopa", property_type: "sfr", units: 1, ...(overrides.property ?? {}) } }, SYSTEM)).application;
  const r = await call("POST", `/v1/applications/${app.id}/fund`, { actor: FUNDING, snapshot: { final_cd: { document_id: "DOC-CD", pi_cents: "340262", monthly_escrow_cents: "68750", initial_escrow_deposit_cents: "206250", prepaid_interest_cents: "178543", prepaid_interest_days: 19, compliance_tests_passed: true }, ...(overrides.snapshot ?? {}) }, ...(overrides.funded ? { funded: overrides.funded } : {}) }, at.base);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { appId: app.id, loanId: String(r.body["loan_id"]), fund: r.body };
}

/** Tape loan T-7 (worked example B) as a one-loan transfer batch: original $300,000.00 at 6.500% / 360, first payment 2021-10-01, 61 installments paid through 2026-10-01, next due 2026-11-01, tape UPB $280,458.24, P&I $1,896.20, escrow $412.30. */
function tapeT7(numbering: { prefix: string; fnma: string; min_seq: number }, state = "TX", loanNumber = "T-7"): TransferBatchData & { coborrowers: Map<string, string> } {
  const demo = generateDemoBatch(DEMO_BATCH.seed, { prefix: numbering.prefix, fnma_base: 5_100_000_000, min_sequence_base: numbering.min_seq });
  const template = demo.loans.find((l) => !l.bankruptcy.active && !l.foreclosure.active && !l.lossmit.in_process && !l.scra.active && l.amortization === "fixed" && l.deferred_principal_cents === 0n && l.escrowed)!;
  const first = D("2021-10-01"); const installments: Installment[] = []; const payments: HistoricalPayment[] = [];
  for (let k = 0; k < 62; k++) { const due = addMonths(first, k); installments.push({ due_date: due, amount_cents: B.pi + B.escrow }); if (k < 61) payments.push({ received_on: due, amount_cents: B.pi + B.escrow }); }
  const loan: StagedLoan = { ...template, transferor_loan_number: loanNumber, fnma_loan_number: numbering.fnma, min: null, mers_eligible: false, remittance_type: "A/A", upb_cents: B.upb, next_due_date: D("2026-11-01"), note_rate_pct: "6.500", pi_cents: B.pi, escrow_payment_cents: B.escrow,
    maturity_date: D("2051-09-01"), original_term_months: 360, original_upb_cents: B.original, instrument_date: D("2021-08-16"), origination_date: D("2021-08-16"), first_payment_date: first, interest_method: "30_360", amortization: "fixed", escrowed: true, escrow_balance_cents: B.escrow * 3n,
    escrow_lines: [{ line_type: "county_tax", annual_amount_cents: 494_760n, next_due_date: D("2027-01-31") }], escrow_sign_consistent: true, last_escrow_analysis_date: D("2026-06-01"), late_charge_pct: "5", late_charge_grace_days: 15, deferred_principal_cents: 0n, forborne_principal_cents: 0n, nib_separated: true,
    bankruptcy: { active: false }, foreclosure: { active: false }, lossmit: { in_process: false }, scra: { active: false }, borrower: { legal_name: "Taylor Seven", tin: "000-77-0007", email: "taylor.seven@example.test" }, property: { address_line1: "7 Tape Rd", city: "Austin", state, postal_code: "78701", occupancy: "owner_occupied" },
    custody: { custodian: "Bank Custodian NA", certification_status: "certified" }, consents: { esign_evidence: true, tcpa_voice_evidence: true }, tax_parcel_verified: true, hazard_policy_expires: D("2027-06-01"), mi: { flag: false }, flood_determination_life_of_loan: true, sii: { present: false, complete: true },
    unapplied_cents: 0n, fair_lending_present: true, acp_enrolled: false, fees_advances_cents: 0n, fees_itemized: true, corporate_advances_cents: 0n, late_charges_due_cents: 0n, mers_investor_is_fnma: null, installments, payments };
  return { loans: [loan], fnma: [{ fnma_loan_number: numbering.fnma, on_approved_list: true, remittance_type: "A/A", upb_cents: B.upb }], trialBalance: [{ transferor_loan_number: loanNumber, fnma_loan_number: numbering.fnma, upb_cents: B.upb }], mers: [], images: demo.images.filter((x) => x.transferor_loan_number === template.transferor_loan_number).map((x) => ({ ...x, transferor_loan_number: loanNumber })), fairLending: [{ transferor_loan_number: loanNumber, ethnicity: "Not provided", race: "Not provided", sex: "Not provided", age: "44", preferred_language: "en" }], coborrowers: new Map() };
}
const tapeInput = (batchId: string, transferDate: PlainDate): TransferBatchInput => ({ ...DEMO_BATCH, batch_id: batchId, transfer_date: transferDate, respa_effective_date: transferDate, sale_date: D("2026-09-16") });
/** T-7 boarded through the transfer route on 2026-10-16 (worked example B); the loan id from the batch summary. */
async function boardT7(at: { rt: Runtime; base: string }, state = "TX"): Promise<{ loanId: string; batchId: string; summary: Record<string, unknown> }> {
  // the tape's loan number is T-7; each boarding of the fixture in this file carries its own suffix (loans.servicer_loan_number `SM-<transferor number>` is unique on the platform)
  const loanNumber = `T-7-${uniq().slice(-5)}`;
  const batchId = `B-T7-${randomUUID().slice(0, 8)}`; const tape = tapeT7({ prefix: `T7${uniq().slice(-4)}`, fnma: uniq(), min_seq: 900 + n }, state, loanNumber);
  const r = await call("POST", "/v1/transfers/batches", { actor: SYSTEM, batch: tapeInput(batchId, D("2026-10-16")), files: encodeTransferBatch(tape, tape.coborrowers) }, at.base);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const loanIds = r.body["loan_ids"] as Record<string, string>; const loanId = loanIds[loanNumber]!;
  assert.equal((r.body["loans"] as Record<string, number>)["boarded"], 1, JSON.stringify(r.body["hard_by_loan"]));
  return { loanId, batchId, summary: r.body };
}

/** Fixture L-1 (2.1 rule 11 / worked example D): $250,000 at 6.500% from 2021-09-01, LPI 2026-08-01, UPB $249,774.00 as an opening set, P&I $1,580.17, escrow $612.40 — its schedule from the next due date and its configuration written by the 35.5 tools; a borrower party for the notices. */
async function l1Fixture(rt: Runtime, opts: { state?: string; nextDue?: PlainDate; nsf?: boolean } = {}): Promise<Fixture & { partyId: string }> {
  const state = opts.state ?? "AZ"; const nextDue = opts.nextDue ?? D("2026-09-01");
  const f = await new PgLoanRepository(db).createFixture({ fnmaLoanNumber: uniq(), servicerLoanNumber: `SM-${randomUUID()}`, instrumentDate: D("2021-07-15"), originalUpbCents: L1.original, originalTermMonths: 360, firstPaymentDate: D("2021-09-01"), maturityDate: D("2051-08-01"), property: { line1: "1 Fixture Way", city: state === "AZ" ? "Phoenix" : "Testville", state, postalCode: "85004" } });
  await db.query(`INSERT INTO loan_terms (loan_id, effective_from, source, amortization, note_rate_bps, pi_cents, escrow_payment_cents, escrowed, interest_method, remittance_type, late_charge_pct_bps, late_charge_grace_days, maturity_date, remaining_term_months) VALUES ($1, '2021-07-15', 'boarding', 'fixed', $2, $3, $4, true, '30_360', 'A/A', 5000, 15, '2051-08-01', 300)`, [f.loanId, L1.rate_bps, L1.pi.toString(), L1.escrow.toString()]);
  await db.query(`UPDATE loans SET boarded_at = '2026-08-15T12:00:00Z', principal_residence = true WHERE id = $1`, [f.loanId]);
  if (opts.nsf !== false) await db.query(`INSERT INTO jurisdiction_rules (state, licensed, rules) VALUES ($1, true, '{"nsf_fee": {"allowed": true, "cap_cents": null}}'::jsonb) ON CONFLICT (state) DO UPDATE SET rules = jurisdiction_rules.rules || EXCLUDED.rules`, [state]);
  // 1.6's opening set: the tape's UPB as of the LPI (the ledger's principal balance is the engine's UPB)
  await rt.uow.run({ loanId: f.loanId }, (ctx) => ctx.ledger.post({ effectiveDate: D("2026-08-15"), description: "opening balance (fixture L-1)", lines: [{ account: { scope: "loan", loanId: f.loanId, account: "principal" }, amountCents: L1.upb, ruleRef: "1.6:opening:principal" }, { account: { scope: "custodial", custodialAccountId: f.custodial.clearing, account: "transfer_in_clearing" }, amountCents: -L1.upb, ruleRef: "1.6:opening:clearing" }] }, ctx.clock.now()), { clock: rt.clock });
  await rt.execute({ process: "35.5", name: "installments.write", loanId: f.loanId, actor: CASHIERING, input: { loan_id: f.loanId, source: "transfer", next_due_date: nextDue } });
  await rt.execute({ process: "35.5", name: "servicing_config.write", loanId: f.loanId, actor: CASHIERING, input: { loan_id: f.loanId } });
  const party = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, contact) VALUES ('other', 'Alex Borrower', '{"email": "alex.l1@example.test"}'::jsonb) RETURNING id`))[0]!.id;
  const b = (await db.query<{ id: string }>(`INSERT INTO borrowers (legal_name, tin_last4, party_id) VALUES ('Alex Borrower', '6789', $1) RETURNING id`, [party]))[0]!.id;
  await db.query(`INSERT INTO loan_borrowers (loan_id, borrower_id, role, is_primary) VALUES ($1, $2, 'borrower', true)`, [f.loanId, b]);
  return { ...f, partyId: party };
}

test("35.5-T1: Given the demo snapshot's note ($560,000.00 at 6.125%, 360 months, first payment 2027-01-01) funded through `POST /v1/applications/{id}/fund`, when the hand-off commits, then `loan_installments` has 360 rows for the loan in the same transaction as `loan.boarded`, the run row shows `pi_cents` **$3,402.62**, row 1 interest **$2,858.33** and principal **$544.29** with `upb_after_cents` **$559,455.71**, row 2 interest **$2,855.56** and principal **$547.06**, row 360 interest **$17.27**, principal **$3,384.35**, `pi_cents` **$3,401.62** and `absorbs_rounding = true`, Σ `principal_cents` = **$560,000.00**, Σ `interest_cents` = **$664,942.20**, `maturity_variance_cents = 0`, and `SM_INSTALLMENT_SCHEDULE_AT_BOARD_0` is satisfied by `installment.schedule.written` in the same commit.", { skip }, async () => {
  const s = await serverAt(NOW);
  try {
    const { appId, loanId } = await fundDemoNote(s);
    // 360 rows in the boarding transaction: the run row and the rows exist, the boarded event and the schedule event share the commit
    const rows = await readInstallments(db, loanId);
    assert.equal(rows.length, 360);
    const runs = await scheduleRuns(db, loanId); assert.equal(runs.length, 1); const run = runs[0]!;
    assert.equal(run.source, "fund"); assert.equal(run.rows, 360); assert.equal(run.pi_cents, A.pi); assert.equal(run.maturity_variance_cents, 0n);
    assert.equal(levelPayment(A.upb, Decimal.parse("0.06125"), 360), A.pi, "the level payment is the note's P&I ($3,402.62)");
    const r1 = rows[0]!, r2 = rows[1]!, r360 = rows[359]!;
    assert.equal(r1.due_date, "2027-01-01"); assert.equal(r1.sequence, 1); assert.equal(r1.upb_before_cents, A.upb); assert.equal(r1.interest_cents, A.row1_interest); assert.equal(r1.principal_cents, A.row1_principal); assert.equal(r1.upb_after_cents, A.row1_after); assert.equal(r1.pi_cents, A.pi); assert.equal(r1.absorbs_rounding, false);
    assert.equal(r2.due_date, "2027-02-01"); assert.equal(r2.interest_cents, A.row2_interest); assert.equal(r2.principal_cents, A.row2_principal); assert.equal(r2.upb_after_cents, A.row2_after);
    assert.equal(r360.due_date, "2056-12-01"); assert.equal(r360.sequence, 360); assert.equal(r360.interest_cents, A.row360_interest); assert.equal(r360.principal_cents, A.row360_principal); assert.equal(r360.pi_cents, A.row360_pi); assert.equal(r360.absorbs_rounding, true); assert.equal(r360.upb_after_cents, 0n);
    assert.equal(rows.reduce((a, r) => a + r.principal_cents, 0n), A.upb, "Σ principal = $560,000.00");
    assert.equal(rows.reduce((a, r) => a + r.interest_cents, 0n), A.sum_interest, "Σ interest = $664,942.20");
    assert.equal(rowInterest(A.upb, A.rate_bps), A.row1_interest);
    assert.ok(rows.every((r) => r.status === "due" && r.terms_id !== null && r.schedule_run_id === run.id && r.rate_bps === A.rate_bps));
    // the same transaction as `loan.boarded`: one commit — the schedule event follows the boarded event on the loan's log at the same instant, and the clock it satisfies was armed by that boarded event
    const boarded = (await events(loanId, "loan.boarded"))[0]!; const written = (await events(loanId, INSTALLMENT_EVENTS.written))[0]!;
    assert.equal(written.payload["run_id"], run.id); assert.equal(written.payload["rows"], 360); assert.equal(written.payload["pi_cents"], "340262"); assert.equal(written.payload["source"], "fund"); assert.equal(written.payload["sha256"], run.sha256);
    assert.equal(written.occurred_at, boarded.occurred_at, "one commit, one instant");
    const t = await timer("SM_INSTALLMENT_SCHEDULE_AT_BOARD_0", loanId); assert.equal(t.length, 1); assert.equal(t[0]!.status, "satisfied"); assert.equal(t[0]!.satisfied_by_event_id, written.id); assert.equal(t[0]!.anchor_date, "2026-11-16", "anchored on the boarding instant's civil date (offset 0)");
    assert.equal(await count(db, `FROM loan_events WHERE loan_id = $1 AND type = 'installment.schedule.written'`, [loanId]), 1);
    // and the transaction is one: a database that refuses the schedule run row boards nothing — no `loans` row, no `loan.boarded`, no rows (rule 1: "no `loans` row is committed without its rows")
    const faulty = { query: db.query.bind(db), dedicated: db.dedicated.bind(db), end: async () => undefined, tx: <T,>(fn: (q: Queryable) => Promise<T>): Promise<T> => db.tx((q) => fn({ query: (sql: string, params?: readonly unknown[]) => (sql.includes("INSERT INTO installment_schedule_runs") ? Promise.reject(new Error("FAULT: schedule run row refused")) : q.query(sql, params)) })) } as unknown as Db;
    const faultyRt = new Runtime({ db: faulty, registry: loadOverriddenRegistry(), clock: new FixedClock(NOW) });
    const partner = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number) VALUES ('servicer', 'Lender F', '123456789') RETURNING id`))[0]!.id;
    const app2 = (await faultyRt.createApplication({ partner_party_id: partner, channel: "organic", transaction_type: "limited_cash_out", occupancy: "primary", borrowers: [{ legal_name: "Alex Borrower", borrower_role: "borrower" }], property: { address_line1: "100 N Central Ave", city: "Phoenix", state: "AZ", postal_code: "85004", county: "Maricopa", property_type: "sfr", units: 1 } }, SYSTEM)).application;
    await assert.rejects(fundApplication(faultyRt, app2.id, demoSnapshot(app2), demoFunded(app2.id), FUNDING), /FAULT: schedule run row refused/);
    assert.equal(await count(db, `FROM loans WHERE origination_application_id = $1`, [app2.id]), 0, "no loans row without its schedule");
    assert.equal(await count(db, `FROM loan_events WHERE application_id = $1 AND type = 'loan.boarded'`, [app2.id]), 0);
    assert.equal(await count(db, `FROM loan_installments i JOIN loans l ON l.id = i.loan_id WHERE l.origination_application_id = $1`, [app2.id]), 0);
    void appId;
  } finally { await s.close(); }
});

test("35.5-T2: Given tape loan T-7 ($300,000.00 at 6.500%, 360 months, first payment 2021-10-01, next due 2026-11-01, UPB $280,458.24, P&I $1,896.20, escrow $412.30) boarded through `POST /v1/transfers/batches` on 2026-10-16, when the batch commits, then 299 rows exist from 2026-11-01 to 2051-09-01 with `sequence` 62 … 360, HF-005 recomputes **$1,896.20** with difference 0¢, row 2026-11-01 has interest **$1,519.15**, principal **$377.05**, escrow $412.30 and `upb_after_cents` **$280,081.19**, row 2026-12-01 has interest **$1,517.11** and principal **$379.09**, row 2051-09-01 has interest **$10.24**, principal **$1,890.67** and `pi_cents` **$1,900.91**, `maturity_variance_cents = 0`, and the delinquency counter job's selector (`JOIN loan_installments … status = 'due'`) returns the loan once 2026-11-01 has passed unpaid in its zone.", { skip }, async () => {
  const s = await serverAt("2026-10-16T15:00:00.000Z");
  try {
    const { loanId } = await boardT7(s);
    const rows = await readInstallments(db, loanId);
    assert.equal(rows.length, 299); assert.equal(rows[0]!.due_date, "2026-11-01"); assert.equal(rows[298]!.due_date, "2051-09-01");
    assert.equal(rows[0]!.sequence, 62); assert.equal(rows[298]!.sequence, 360);
    // HF-005: the level payment on the original terms is the tape's P&I to the cent (difference 0¢)
    assert.equal(levelPaymentBps(B.original, B.rate_bps, 360), B.pi); assert.equal(levelPayment(B.original, Decimal.parse("0.065"), 360), B.pi);
    const written = (await events(loanId, INSTALLMENT_EVENTS.written))[0]!; assert.equal(written.payload["hf005_difference_cents"], "0"); assert.equal(written.payload["source"], "transfer"); assert.equal(written.payload["upb_start_cents"], "28045824");
    const r62 = rows[0]!, r63 = rows[1]!, r360 = rows[298]!;
    assert.equal(r62.upb_before_cents, B.upb); assert.equal(r62.interest_cents, B.row62_interest); assert.equal(r62.principal_cents, B.row62_principal); assert.equal(r62.escrow_cents, B.escrow); assert.equal(r62.upb_after_cents, B.row62_after); assert.equal(r62.pi_cents, B.pi);
    assert.equal(r63.due_date, "2026-12-01"); assert.equal(r63.interest_cents, B.row63_interest); assert.equal(r63.principal_cents, B.row63_principal); assert.equal(r63.upb_after_cents, B.row63_after);
    assert.equal(r360.interest_cents, B.row360_interest); assert.equal(r360.principal_cents, B.row360_principal); assert.equal(r360.pi_cents, B.row360_pi); assert.equal(r360.absorbs_rounding, true); assert.equal(r360.pi_cents - B.pi, B.absorbed, "the final row absorbs $4.71 of rounding");
    const run = (await scheduleRuns(db, loanId))[0]!; assert.equal(run.rows, 299); assert.equal(run.maturity_variance_cents, 0n); assert.equal(run.source, "transfer");
    // the tape's UPB is what the note's own schedule leaves after 61 rows (28,045,824¢), and the run's hash is the rows'
    const fromNote = projectSchedule({ upb_cents: B.original, note_rate_bps: B.rate_bps, pi_cents: B.pi, escrow_cents: B.escrow, first_due: D("2021-10-01"), sequence_start: 1, maturity_date: D("2051-09-01") });
    assert.equal(fromNote.rows[60]!.upb_after_cents, B.upb); assert.equal(fromNote.rows.length, 360); assert.equal(B.original, 30_000_000n);
    assert.equal(projectSchedule({ upb_cents: B.upb, note_rate_bps: B.rate_bps, pi_cents: B.pi, escrow_cents: B.escrow, first_due: D("2026-11-01"), sequence_start: 62, maturity_date: D("2051-09-01") }).sha256, run.sha256);
    // the delinquency counter job's selector (`JOIN loan_installments … status = 'due'`) returns the loan once 2026-11-01 has passed unpaid in its zone (TX: America/Chicago) — not before
    const before = await delinquencyDailySweep(rtAt("2026-11-01T23:00:00.000Z"), "2026-11-01T23:00:00.000Z", [loanId]);   // 18:00 Chicago on the due date: not yet past due
    assert.equal(before.loans.length, 0);
    const after = await delinquencyDailySweep(rtAt("2026-11-02T12:00:00.000Z"), "2026-11-02T12:00:00.000Z", [loanId]);
    assert.equal(after.loans.length, 1); assert.equal(after.loans[0]!.loan_id, loanId); assert.equal(after.loans[0]!.earliest_unpaid_due, "2026-11-01"); assert.equal(after.loans[0]!.time_zone, "America/Chicago"); assert.equal(after.loans[0]!.local_date, "2026-11-02");
    assert.ok(after.loans[0]!.windows_opened.includes(D("2026-11-01")), "the Reg X window opened for 2026-11-01");
  } finally { await s.close(); }
});

test("35.5-T3: Given 7.2's Plan 4927 loan boarded at fund ($400,000.00 at 5.750%, 360 months, first payment 2021-12-01, first change 2026-11-01), then the schedule's P&I is **$2,334.29** and row 60's `upb_after_cents` is **$371,048.86**; when 7.2 activates `loan_terms` v2 (`loan_terms.version.activated`, `arm_change`, `effective_on` 2026-12-01, 6.375%, P&I **$2,476.44**), then `installments.reproject` records `rows_kept = 60`, `rows_replaced = 300`, row 2026-12-01 has interest **$1,971.20**, principal **$505.24**, `upb_after_cents` **$370,543.62**, `rate_bps = 63750` and `terms_id` = v2, rows 1–60 are byte-identical to before, `installment.schedule.reprojected` satisfies `SM_INSTALLMENT_REPROJECT_1BD`, and a reprojection whose `effective_from` names a satisfied row is refused `SATISFIED_ROW_FROZEN` with no row changed.", { skip }, async () => {
  // boarded at fund on 2021-10-15 (the note's first payment 2021-12-01 is within C2-2-01's window of that disbursement)
  const s = await serverAt("2021-10-20T15:00:00.000Z");
  const armNote = { amount_cents: "40000000", note_rate_pct: "5.750", term_months: 360, first_payment_date: "2021-12-01", maturity_date: "2051-11-01", note_date: "2021-10-15", late_charge_pct: "5.00", late_charge_grace_days: 15, amortization: "arm", arm: { index: "SOFR_30D_AVG", margin_bps: 275, initial_cap_bps: 200, periodic_cap_bps: 100, lifetime_cap_bps: 500, lookback_days: 45, first_change_date: "2026-11-01", rounding: "nearest_eighth" } };
  let loanId = "";
  try {
    const funded = await fundDemoNote(s, { snapshot: { note: armNote, closing: { consummation_date: "2021-10-15", note_terms_hash: noteTermsHash({ amount_cents: C.original, note_rate_pct: "5.750", term_months: 360, first_payment_date: D("2021-12-01"), maturity_date: D("2051-11-01"), late_charge_pct: "5.00", late_charge_grace_days: 15 }) }, rescission_expires_at: "2021-10-14T06:59:59.000Z",
      final_cd: { document_id: "DOC-CD", pi_cents: "233429", monthly_escrow_cents: "61250", initial_escrow_deposit_cents: "183750", prepaid_interest_cents: "0", prepaid_interest_days: 0, compliance_tests_passed: true },
      escrow_analysis: { source: "origination", type: "initial", required_start_balance_cents: "61250", cushion_cents: "122500", monthly_escrow_cents: "61250", lines: [{ line_type: "county_tax", annual_amount_cents: "735000", monthly_cents: "61250" }], status: "active" }, hazard: { verified: true, mortgagee_clause_partner_isaoa_co_sm: true, expires_on: "2022-10-15" } },
      funded: { funded_at: "2021-10-15T18:40:00.000Z", funding_date: "2021-10-15", disbursement_date: "2021-10-15", funded_amount_cents: "40000000", per_diem_cents: "0", prepaid_interest_cents: "0", interest_credit: true, rescission_expires_at: "2021-10-14T06:59:59.000Z" } });
    loanId = funded.loanId;
  } finally { await s.close(); }
  const before = await readInstallments(db, loanId);
  assert.equal(before.length, 360); assert.equal(before[0]!.due_date, "2021-12-01");
  const run1 = (await scheduleRuns(db, loanId))[0]!; assert.equal(run1.pi_cents, C.pi, "the schedule's P&I is $2,334.29"); assert.equal(levelPaymentBps(C.original, C.rate_bps, 360), C.pi); assert.equal(C.original, 40_000_000n);
  assert.equal(before[59]!.due_date, "2026-11-01"); assert.equal(before[59]!.upb_after_cents, C.row60_after, "row 60's UPB after is $371,048.86 — 7.2's expected UPB");
  assert.ok(before.every((r) => r.escrow_cents === C.escrow && r.rate_bps === C.rate_bps));
  // 7.2 activates v2 on the change date: `loan_terms.version.activated{version: 2, effective_on: 2026-11-01, rate_pct: 6.375, pi_cents: 247644, payment_effective_due: 2026-12-01, reason: arm_adjustment}` (ops-7-2.ts makeEffective's shape)
  const rt = rtAt("2026-11-01T16:00:00.000Z");
  assert.equal(levelPaymentBps(C.row60_after, C.v2_rate_bps, 300), C.v2_pi, "7.2's new P&I is $2,476.44 on the expected UPB over 300 months");
  const activated = await rt.executeDef(testTool("arm.activate.v2", (_i, ctx) => { const e = ctx.events.append({ type: "loan_terms.version.activated", loanId, aggregate: { kind: "loan_terms", id: loanId }, actor: { kind: "agent", id: "disclosures" }, payload: { version: 2, effective_on: "2026-11-01", rate_pct: "6.375", pi_cents: "247644", payment_effective_due: "2026-12-01", next_change_date: "2027-05-01", reason: "arm_adjustment" } }); return { event_id: e.id }; }), { loanId, actor: SYSTEM, input: {} });
  const triggerId = String((activated.output as { event_id: string }).event_id);
  const armedT = await timer("SM_INSTALLMENT_REPROJECT_1BD", loanId); assert.equal(armedT.length, 1); assert.equal(armedT[0]!.status, "armed"); assert.equal(armedT[0]!.anchor_date, "2026-11-01");
  const re = await rt.execute({ process: "35.5", name: "installments.reproject", loanId, actor: CASHIERING, input: { loan_id: loanId, trigger_event_id: triggerId } });
  const o = re.output as Record<string, unknown>;
  assert.equal(o["rows_kept"], 60); assert.equal(o["rows_replaced"], 300); assert.equal(o["effective_from"], "2026-12-01"); assert.equal(o["rate_bps"], C.v2_rate_bps); assert.equal(o["pi_cents"], "247644");
  const after = await readInstallments(db, loanId);
  const r61 = after[60]!; assert.equal(r61.due_date, "2026-12-01"); assert.equal(r61.upb_before_cents, C.row60_after); assert.equal(r61.interest_cents, C.row61_interest); assert.equal(r61.principal_cents, C.row61_principal); assert.equal(r61.upb_after_cents, C.row61_after); assert.equal(r61.rate_bps, 63_750); assert.equal(r61.pi_cents, C.v2_pi);
  assert.equal(r61.terms_id, o["terms_id"], "`terms_id` = v2");
  const v2 = await one<Record<string, unknown>>(db, `SELECT source, effective_from::text AS effective_from, note_rate_bps, pi_cents::text AS pi_cents, source_event_id::text AS source_event_id FROM loan_terms WHERE id = $1`, [o["terms_id"]]);
  assert.equal(v2["source"], "arm_change"); assert.equal(v2["effective_from"], "2026-12-01"); assert.equal(v2["note_rate_bps"], 63_750); assert.equal(v2["pi_cents"], "247644"); assert.equal(v2["source_event_id"], triggerId);
  assert.deepEqual(JSON.stringify(after.slice(0, 60), (_k, v) => (typeof v === "bigint" ? v.toString() : v)), JSON.stringify(before.slice(0, 60), (_k, v) => (typeof v === "bigint" ? v.toString() : v)), "rows 1–60 are byte-identical");
  assert.ok(after.slice(60).every((r) => r.terms_id === o["terms_id"] && r.rate_bps === 63_750 && r.schedule_run_id === o["run_id"]));
  const run2 = (await scheduleRuns(db, loanId)).find((r) => r.id === o["run_id"])!; assert.equal(run2.rows_kept, 60); assert.equal(run2.rows_replaced, 300); assert.equal(run2.trigger_event_id, triggerId); assert.equal(run2.source, "reprojection");
  const replaced = await one<{ replaced: Record<string, unknown>[] }>(db, `SELECT replaced FROM installment_schedule_runs WHERE id = $1`, [o["run_id"]]); assert.equal(replaced.replaced.length, 300); assert.equal(replaced.replaced[0]!["due_date"], "2026-12-01"); assert.equal(replaced.replaced[0]!["pi_cents"], "233429");
  const reprojected = (await events(loanId, INSTALLMENT_EVENTS.reprojected))[0]!; assert.equal(reprojected.payload["rows_kept"], 60); assert.equal(reprojected.payload["rows_replaced"], 300); assert.equal(reprojected.payload["trigger_event_id"], triggerId);
  const satisfied = await timer("SM_INSTALLMENT_REPROJECT_1BD", loanId); assert.equal(satisfied[0]!.status, "satisfied"); assert.equal(satisfied[0]!.satisfied_by_event_id, reprojected.id);
  assert.ok(re.decisions.length >= 1, "the reprojection left its decision record");
  // a second run on the same terms event writes nothing (idempotent per trigger)
  const again = await rt.execute({ process: "35.5", name: "installments.reproject", loanId, actor: CASHIERING, input: { loan_id: loanId, trigger_event_id: triggerId } });
  assert.equal((again.output as Record<string, unknown>)["reprojected"], false); assert.equal((await scheduleRuns(db, loanId)).length, 2);
  // a reprojection whose `effective_from` names a satisfied row is refused SATISFIED_ROW_FROZEN with no row changed
  await db.query(`UPDATE loan_installments SET status = 'satisfied', satisfied_on = '2026-12-01', credited_as_of = '2026-12-01' WHERE loan_id = $1 AND due_date = '2026-12-01'`, [loanId]);
  const snapshot = JSON.stringify(await readInstallments(db, loanId), (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  await assert.rejects(rt.execute({ process: "35.5", name: "installments.reproject", loanId, actor: OFFICER, input: { loan_id: loanId, effective_from: "2026-12-01", note_rate_bps: 63_750, pi_cents: 247_644n } }), (e: Error & { code?: string }) => e.code === "SATISFIED_ROW_FROZEN");
  assert.equal(JSON.stringify(await readInstallments(db, loanId), (_k, v) => (typeof v === "bigint" ? v.toString() : v)), snapshot, "no row changed");
  assert.equal((await scheduleRuns(db, loanId)).length, 2, "no run row written by the refused reprojection");
  assert.equal(await count(db, `FROM loan_terms WHERE loan_id = $1`, [loanId]), 2, "no terms row written by the refused reprojection");
});

test("35.5-T4: Given the 100-loan demo book (transfer-boarded, `origination_application_id IS NULL`) and one originated loan, when the `cashiering_daily` cycle runs for a day, then `cycle_runs` shows `units_total = 101`, every loan has one `cashiering_unit_runs` row with `outcome = done` for that `as_of_date`, `cashiering.daily.run_completed{loans: 101}` is appended exactly once and satisfies `SM_CASHIERING_DAILY_RECEIPT_1D`, and running the cycle again for the same day writes no payment, fee, ledger line or unit row (the second run's decision records name the existing rows).", { todo: true });
test("35.5-T5: Given loan L-1 with a `payments` row in `received` for **$2,192.57** on 2026-09-03, when its unit runs on 2026-09-03, then 2.1 posts interest **$1,352.94**, principal **$227.23** and escrow **$612.40** with the balanced sets of 2.1 rule 8 (`rule_ref` on every line), row 2026-09-01 is `satisfied` with `satisfied_by_payment_id` set and `credited_as_of` 2026-09-03, and `POST /v1/loans/{id}/tools/2.1/payments.read%2Fwrite` with an `input.state` whose UPB differs from the ledger is refused `NO_CLIENT_STATE` before any write (contract test over `payments.read/write{op=post}`, `fees.assess{op=daily_run}` and `autodraft.read/write{op=amount_change_check}`).", { todo: true });
test("35.5-T6: Given L-1's row 2026-09-01 unpaid past the 15-day grace (grace end Wed 2026-09-16), when the unit runs on 2026-09-17 in the loan's zone, then 2.7's `daily_run` assesses **$79.01** (`fees{late_charge, assessed_on 2026-09-17, grace_end_on 2026-09-16}`, Dr `late_charges` / Cr `late_charge_income` 7,901), `installment.due_date_reached` was emitted by the unit on 2026-09-01 and not by any borrower flow, and the unit on 2026-09-18 assesses nothing (`late_charge_run = false`).", { todo: true });
test("35.5-T7: Given lockbox `LBX-1` (cut-off 17:00 `America/Chicago`) and the FAKE bank's file for 2026-11-02 with items $2,192.57 (L-1, scanned 09:14), $1,500.00 (no scanline) and $2,308.50 (T-7, scanned 17:42) and control total **$6,001.07**, when `lockbox_ingest` runs, then `lockbox_batches` has one row with `items = 3`, `variance_cents = 0` and `status = posted`, item 1 is a `payments` row (`channel = lockbox`, `received_on` 2026-11-02, `status = identified`), item 2 is a `suspense_items` row (`source = lockbox`) with `lockbox.item.unidentified`, item 3 is a `payments` row with `received_on` 2026-11-03, three receipt sets Dr `clearing_cash` / Cr `suspense_unapplied` exist for 219,257, 150,000 and 230,850, `lockbox.batch.received` armed `FNMA_C1101_LOCKBOX_CLEARING_1BD`, `lockbox.batch.posted{posted: 2, unidentified: 1}` satisfied `SM_LOCKBOX_BATCH_POSTED_1BD`, the same file ingested again writes nothing, and the file with control total $6,000.07 leaves the batch in `variance` with no payment row and an `officer` escalation.", { todo: true });
test("35.5-T8: Given L-1's active enrollment (draft day = due date, extra principal $100.00, validated) and the demo clock at Tue 2026-09-29 14:00 ET, when `ach_file_build` runs, then one `ach_files` row exists with one `ach_entries` row of **$2,292.57**, `effective_entry_date` 2026-10-01, description \"MORTGAGE PMT\" and `status = transmitted`, the file is a `documents` row with `sha256`, `ach.file.built` satisfied `SM_ACH_FILE_BUILD_1BD`; and given a second enrollment whose amount changed without a sent variable-amount notice and a third whose `validation_status = pending` (WEB), then neither has an entry and the build's decision names `REGE_1005_10D_VARIABLE_AMOUNT_NOTICE_10` and `NACHA_WEB_ACCOUNT_VALIDATION_GATE` as the refusals.", { todo: true });
test("35.5-T9: Given the entry of T8 settled 2026-10-01 and posted by L-1's unit (interest **$1,351.71**, principal **$228.46**, escrow **$612.40**, curtailment **$100.00**, row 2026-10-01 `satisfied`), when the FAKE ODFI's return file for Mon 2026-10-05 carries R01 on its trace number and `ach_returns_ingest` runs, then `ach_return_files` has one row, `ach.return.received{code: R01}` and a `payment_reversals` row (`reason = returned_item`, `return_code = R01`) exist with the mirror set for $2,292.57, row 2026-10-01 is `due` again with `installment.restored`, UPB and LPI are back to $249,546.77 and 2026-09-01, a `fees{nsf_fee}` row of **$25.00** exists, a reinitiation `ach_entries` row of **$2,292.57** with description \"RETRY PYMT\", `effective_entry_date` Thu 2026-10-08 and `reinitiation_count = 1` exists, `ach.return.actioned{action: reversed_reinitiated}` satisfied `SM_ACH_RETURN_ACTIONED_1BD`, and the same return file ingested again writes nothing.", { todo: true });
test("35.5-T10: Given the reinitiation of T9 is also returned R01 on 2026-10-12, when the return is actioned and the unit runs on 2026-10-17, then no further reinitiation is built (`NACHA_NSF_REINITIATION_180_MAX2` exhausted), the enrollment is `suspended_returns` with a hand-off escalation to `borrower-comms`, the 2026-10-17 run assesses **$79.01** on row 2026-10-01, and a second `fees{nsf_fee}` row exists for the second item; given instead a return coded R11, then no NSF fee exists and the corrected entry carries `reinitiation_of_entry_id`.", { todo: true });
test("35.5-T11: Given loan P (AZ, `America/Phoenix`) and loan N (NY, `America/New_York`) each with a `due` row for 2026-10-01, when the planner's `as_of` is 2026-10-02T06:30:00Z, then N's `cashiering_unit_runs.local_date` is 2026-10-02 and P's is 2026-10-01, `installment.due_date_reached{due_date: 2026-10-01}` was emitted for P on that pass and for N on the earlier pass whose local date was 2026-10-01, `LOAN_LOCAL_TZ` no longer exists in `src/runtime` (grep = 0), and a loan with no `loan_servicing_configs` row is refused `CONFIG_REQUIRED` by the unit with nothing written.", { todo: true });
test("35.5-T12: Given both boarding paths, when a loan boards, then a `loan_servicing_configs` row exists in the same transaction with `time_zone` from the reviewed state map for `properties.state`, `jurisdiction_state`, `servicer_profile_id` = the active profile, `late_charge_terms` = 2.7's `lateChargeTerms` for the note and `jurisdiction_rules.rules.late_charge`, `nsf_fee_allowed` from `jurisdiction_rules.rules.nsf_fee`, and `loan.servicing_config.written` satisfied `SM_LOAN_SERVICING_CONFIG_AT_BOARD_0`; given a note late-charge rate above the state's `max_pct`, then `late_charge_terms.conflict` names it and the state's bound is what 2.7 assesses.", { skip }, async () => {
  const rules = async (state: string): Promise<{ allowed: boolean }> => { const r = await db.query<{ rules: Record<string, unknown> }>(`SELECT rules FROM jurisdiction_rules WHERE state = $1`, [state]); const nsf = (r[0]?.rules?.["nsf_fee"] ?? null) as { allowed?: boolean } | null; return { allowed: nsf ? nsf.allowed !== false : false }; };
  // the fund path (AZ property, the demo note's 5.00% / 15-day late-charge terms)
  const s = await serverAt(NOW);
  let fundLoan = ""; let gaLoan = "";
  try {
    fundLoan = (await fundDemoNote(s)).loanId;
    const v1 = (await servicerProfileVersions(db)).find((v) => v.version === 1)!; assert.equal(v1.id, FAKE_SERVICER_PROFILE_V1_ID); assert.equal(v1.status, "active");
    // a note late-charge rate above the state's max_pct: the conflict is named and the state's bound is what 2.7 assesses (GA: max 4%)
    await db.query(`INSERT INTO jurisdiction_rules (state, licensed, rules) VALUES ('GA', true, '{"late_charge": {"max_pct": "4", "min_grace_days": 15}}'::jsonb) ON CONFLICT (state) DO UPDATE SET rules = jurisdiction_rules.rules || EXCLUDED.rules`);
    gaLoan = (await fundDemoNote(s, { property: { address_line1: "9 Peachtree St", city: "Atlanta", state: "GA", postal_code: "30303", county: "Fulton" } })).loanId;
  } finally { await s.close(); }
  const v1 = (await servicerProfileVersions(db)).find((v) => v.version === 1)!;
  for (const [loanId, expectTz, expectState, boardedOn] of [[fundLoan, "America/Phoenix", "AZ", "2026-11-12"], [gaLoan, "America/New_York", "GA", "2026-11-12"]] as const) {
    const cfg = await one<Record<string, unknown>>(db, `SELECT time_zone, time_zone_source, jurisdiction_state, servicer_profile_id::text AS servicer_profile_id, late_charge_terms, nsf_fee_allowed, effective_from::text AS effective_from, created_at FROM loan_servicing_configs WHERE loan_id = $1`, [loanId]);
    assert.equal(cfg["time_zone"], expectTz); assert.equal(cfg["time_zone"], STATE_TIME_ZONES[expectState]); assert.equal(cfg["time_zone_source"], "state_default"); assert.equal(cfg["jurisdiction_state"], expectState); assert.equal(cfg["servicer_profile_id"], v1.id); assert.equal(cfg["effective_from"], boardedOn);
    assert.equal(cfg["nsf_fee_allowed"], (await rules(expectState)).allowed, "`nsf_fee_allowed` from jurisdiction_rules.rules.nsf_fee");
    const lc = cfg["late_charge_terms"] as Record<string, unknown>; assert.equal(lc["grace_days"], 15);
    // in the same transaction as the board: the config event is on the boarded event's commit and satisfies the board-0 clock
    const boarded = (await events(loanId, "loan.boarded"))[0]!; const written = (await events(loanId, "loan.servicing_config.written"))[0]!;
    assert.equal(written.occurred_at, boarded.occurred_at); assert.equal(written.payload["time_zone"], expectTz); assert.equal(written.payload["servicer_profile_id"], v1.id);
    const t = await timer("SM_LOAN_SERVICING_CONFIG_AT_BOARD_0", loanId); assert.equal(t.length, 1); assert.equal(t[0]!.status, "satisfied"); assert.equal(t[0]!.satisfied_by_event_id, written.id);
  }
  const azLc = (await one<{ late_charge_terms: Record<string, unknown> }>(db, `SELECT late_charge_terms FROM loan_servicing_configs WHERE loan_id = $1`, [fundLoan])).late_charge_terms;
  assert.equal(azLc["pct"], "5.00"); assert.equal(azLc["conflict"], null, "AZ has no late-charge bound on file: the note's terms stand");
  const gaLc = (await one<{ late_charge_terms: Record<string, unknown> }>(db, `SELECT late_charge_terms FROM loan_servicing_configs WHERE loan_id = $1`, [gaLoan])).late_charge_terms;
  assert.equal(gaLc["pct"], "4"); const conflict = gaLc["conflict"] as Record<string, unknown>; assert.equal(conflict["state"], "GA"); assert.equal(conflict["applied"], "lower_cap"); assert.deepEqual(conflict["note"], { pct: "5.00", grace_days: 15 }); assert.equal(conflict["cap"], "4%/15 days");
  const facts = await loanCashState(runtime, gaLoan, D("2027-01-01"));
  assert.equal(facts.state.late_charge_pct, "4", "the state's bound is what 2.7 assesses"); assert.equal(lateChargeAmount(A.pi, facts.state.late_charge_pct!, null), 13_610n); assert.equal(lateChargeAmount(A.pi, "5.00", null), 17_013n);
  assert.equal((await loanCashState(runtime, fundLoan, D("2027-01-01"))).state.late_charge_pct, "5.00");
  // the transfer path (T-7 in TX)
  const s2 = await serverAt("2026-10-16T15:00:00.000Z");
  try {
    const { loanId } = await boardT7(s2);
    const cfg = await loanServicingConfig(db, loanId, D("2026-10-16"));
    assert.equal(cfg.time_zone, "America/Chicago"); assert.equal(cfg.jurisdiction_state, "TX"); assert.equal(cfg.servicer_profile_id, v1.id); assert.equal(cfg.effective_from, "2026-10-16"); assert.equal(cfg.late_charge_terms.pct, "5"); assert.equal(cfg.late_charge_terms.grace_days, 15); assert.equal(cfg.nsf_fee_allowed, (await rules("TX")).allowed);
    const boarded = (await events(loanId, "loan.boarded"))[0]!; const written = (await events(loanId, "loan.servicing_config.written"))[0]!;
    assert.equal(written.occurred_at, boarded.occurred_at);
    const t = await timer("SM_LOAN_SERVICING_CONFIG_AT_BOARD_0", loanId); assert.equal(t[0]!.status, "satisfied"); assert.equal(t[0]!.satisfied_by_event_id, written.id);
  } finally { await s2.close(); }
});

test("35.5-T13: Given the FAKE build's seeded `servicer_profiles` v1 (the former `SERVICER_CONTACT` values), when 7.1's statement for L-1 renders, then its servicer block (name, phone, servicer address, exclusive address, remittance address, portal URL, counselor URL, HUD phone) equals v1's columns and `SERVICER_CONTACT` no longer exists in `src/runtime/servicing.ts`; when `compliance` activates v2 with a new exclusive address effective tomorrow, then today's statement still renders v1, tomorrow's renders v2, `servicer_profile.activated{version: 2}` carries the decision id, and an `ops_analyst` activating a version is refused `ROLE_DENIED` with nothing written.", { skip }, async () => {
  const today = "2026-09-15"; const tomorrow = "2026-09-16";
  const rt = rtAt(`${today}T14:00:00.000Z`);
  const f = await l1Fixture(rt);
  // the seeded v1 carries the former SERVICER_CONTACT values
  const v1 = (await servicerProfileVersions(db)).find((v) => v.version === 1)!;
  assert.equal(v1.legal_name, FAKE_SERVICER_CONTACT.servicer_name); assert.equal(v1.toll_free_phone, FAKE_SERVICER_CONTACT.servicer_phone); assert.equal(v1.servicer_address, FAKE_SERVICER_CONTACT.servicer_address); assert.equal(v1.exclusive_address, FAKE_SERVICER_CONTACT.exclusive_address); assert.equal(v1.remittance_address, FAKE_SERVICER_CONTACT.remittance_address); assert.equal(v1.portal_url, FAKE_SERVICER_CONTACT.portal_url); assert.equal(v1.counselor_url, FAKE_SERVICER_CONTACT.counselor_url); assert.equal(v1.hud_phone, FAKE_SERVICER_CONTACT.hud_phone);
  assert.equal(v1.tin_last4, "6789"); assert.equal(v1.status, "active"); assert.equal(v1.effective_from, "2020-01-01");
  // 7.1's statement for L-1 renders the block from v1's columns
  const run1 = await sendPeriodicStatement(rt, f.loanId, { cycle_due_date: D("2026-10-01") });
  const st1 = rt.noticeMemory.get(run1.notice_id)!; assert.ok(st1, "the rendered statement is readable");
  const block = (p: Record<string, unknown>) => ({ name: p["servicer_name"], phone: p["servicer_phone"], servicer_address: p["servicer_address"], exclusive_address: p["exclusive_address"], remittance_address: p["remittance_address"], portal_url: p["portal_url"], counselor_url: p["counselor_url"], hud_phone: p["hud_phone"] });
  assert.deepEqual(block(st1.payload), { name: v1.legal_name, phone: v1.toll_free_phone, servicer_address: v1.servicer_address, exclusive_address: v1.exclusive_address, remittance_address: v1.remittance_address, portal_url: v1.portal_url, counselor_url: v1.counselor_url, hud_phone: v1.hud_phone });
  assert.equal(st1.payload["servicer_profile_id"], v1.id); assert.equal(st1.payload["servicer_profile_version"], 1);
  // `SERVICER_CONTACT` no longer exists in src/runtime/servicing.ts
  const servicingSrc = readFileSync(new URL("../../runtime/servicing.ts", import.meta.url), "utf8");
  assert.equal(/SERVICER_CONTACT/.test(servicingSrc), false, "SERVICER_CONTACT is gone from src/runtime/servicing.ts");
  // compliance activates v2 with a new exclusive address effective tomorrow
  const newExclusive = "PO Box 9, Testville TX 75001";
  const act = await rt.execute({ process: "35.5", name: "servicer_profile.write", loanId: "", actor: COMPLIANCE, input: { op: "activate", effective_from: tomorrow, exclusive_address: newExclusive } });
  const ao = act.output as Record<string, unknown>; assert.equal(ao["version"], 2); assert.equal(ao["effective_from"], tomorrow); assert.equal(ao["exclusive_address"], newExclusive);
  const versions = await servicerProfileVersions(db); assert.equal(versions.length, 2);
  const v2 = versions.find((v) => v.version === 2)!; assert.equal(v2.status, "active"); assert.equal(v2.exclusive_address, newExclusive); assert.equal(v2.legal_name, v1.legal_name); assert.equal(v2.approved_by_decision_id, ao["decision_id"]);
  const v1after = versions.find((v) => v.version === 1)!; assert.equal(v1after.effective_to, tomorrow); assert.equal(v1after.status, "active", "v1 still governs today");
  // `servicer_profile.activated{version: 2}` carries the decision id — the decision row exists, approved by compliance
  const activated = act.events.find((e) => e.type === "servicer_profile.activated")!; assert.equal(activated.payload["version"], 2); assert.equal(activated.payload["decision_id"], ao["decision_id"]); assert.equal(activated.payload["effective_from"], tomorrow);
  const decision = await one<Record<string, unknown>>(db, `SELECT agent, action, rule_set_version, approved_by, approved_role FROM agent_decisions WHERE id = $1`, [ao["decision_id"]]);
  assert.equal(decision["agent"], "cashiering"); assert.equal(decision["action"], "servicer_profile.activate"); assert.equal(decision["rule_set_version"], "cashiering.schedule.v1"); assert.equal(decision["approved_by"], COMPLIANCE.id); assert.equal(decision["approved_role"], "compliance");
  // today's statement still renders v1; tomorrow's renders v2
  const run2 = await sendPeriodicStatement(rt, f.loanId, { cycle_due_date: D("2026-10-01"), cycle: 2 });
  assert.equal(rt.noticeMemory.get(run2.notice_id)!.payload["exclusive_address"], v1.exclusive_address); assert.equal(rt.noticeMemory.get(run2.notice_id)!.payload["servicer_profile_version"], 1);
  const rtTomorrow = rtAt(`${tomorrow}T14:00:00.000Z`);
  const run3 = await sendPeriodicStatement(rtTomorrow, f.loanId, { cycle_due_date: D("2026-10-01"), cycle: 3 });
  const st3 = rtTomorrow.noticeMemory.get(run3.notice_id)!; assert.equal(st3.payload["exclusive_address"], newExclusive); assert.equal(st3.payload["servicer_profile_version"], 2); assert.equal(st3.payload["servicer_profile_id"], v2.id); assert.equal(st3.payload["servicer_phone"], v1.toll_free_phone, "the unchanged fields carry over");
  // an ops_analyst activating a version is refused ROLE_DENIED with nothing written
  const versionsBefore = await count(db, `FROM servicer_profiles`); const decisionsBefore = await count(db, `FROM agent_decisions WHERE action = 'servicer_profile.activate'`);
  await assert.rejects(rt.execute({ process: "35.5", name: "servicer_profile.write", loanId: "", actor: OPS_ANALYST, input: { op: "activate", effective_from: "2026-09-20", exclusive_address: "PO Box 10, Testville TX 75001" } }), (e: Error & { code?: string }) => e.code === "ROLE_DENIED");
  assert.equal(await count(db, `FROM servicer_profiles`), versionsBefore); assert.equal(await count(db, `FROM agent_decisions WHERE action = 'servicer_profile.activate'`), decisionsBefore);
  assert.equal(await count(db, `FROM loan_events WHERE type = 'servicer_profile.activated'`), 1);
});

test("35.5-T14: Given a 2.4 curtailment of $1,000.00 received on 2026-11-10 on T-7 (after row 2026-11-01 was satisfied), when the 2026-12-01 payment posts, then interest is `round_half_up((28,008,119 − 100,000) × 0.065 ÷ 12)` = $1,511.69 rather than the row's $1,517.11, the unit records the 542¢ difference against the row, and the schedule is re-projected only when 2.4's re-amortization activates new terms.", { todo: true });
test("35.5-T15: Given the demo clock at 2026-10-01 12:00 ET and the fixture book, when `POST /v1/demo/advance {days: 3}` runs, then `cycle_runs` holds one `cashiering_daily` run per day 2026-10-02 … 2026-10-04 with `units_total` = the active book, each loan has exactly one `done` unit row per day, `cashiering.daily.run_completed` was appended three times with the three `as_of_date`s, and `SM_CASHIERING_DAILY_RECEIPT_1D` never breached.", { todo: true });
test("35.5-T16: Given any tool of this process, then no tool changed a money column of `loan_installments` on a `satisfied` row, of `payments`, `fees` or `ledger_lines` except through 2.1's, 2.7's or 2.3's own commands (contract test: the ledger's line count and sums before and after `installments.write`, `installments.reproject`, `lockbox.item.resolve`, `servicing_config.write` and `servicer_profile.write` are identical), every write left an `agent_decisions` row with `rule_set_version`, and a fee waiver, a variance resolution changing an amount, or a return-action override by an agent actor is refused with nothing written.", { todo: true });
