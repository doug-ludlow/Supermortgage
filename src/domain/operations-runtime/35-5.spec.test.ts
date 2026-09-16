// 35.5 The installment schedule and the daily cashiering cycle: `loan_installments` at fund and at transfer boarding, the whole-book 2.1/2.7/2.3 sweep, lockbox ingest, ACH origination and NACHA returns as cycles, and the per-loan jurisdiction, time-zone and servicer-identity configuration
// spec/sections/35-operations-runtime/35-5-the-installment-schedule-and-the-daily-cashiering-cycle.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { connect, type Db } from "../../infra/db/client.ts";
import { testDatabase } from "../../infra/db/test-db.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock, type Actor } from "../../kernel/events/index.ts";
import { plainDate as D, addDays } from "../../kernel/calendar/date.ts";
import { addBusinessDays, federal } from "../../kernel/calendar/business.ts";
import { levelPayment, ratePercent } from "../../kernel/money/cents.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import { CommandRefused } from "../../app/commands.ts";
import { Runtime } from "../../runtime/app.ts";
import { createApiServer, listen } from "../../runtime/server.ts";
import { createLogger } from "../../runtime/log.ts";
import { OffsetClock, type AdvanceReport } from "../../runtime/demo-clock.ts";
import { boardTransferBatch } from "../../runtime/transfers.ts";
import { DEMO_BATCH, generateDemoBatch } from "../boarding/demo-batch.ts";
import { encodeTransferBatch } from "../boarding/tape-codec.ts";
import { DEMO_NOTE } from "../../runtime/origination.ts";
import { loanCashState, sendPeriodicStatement, servicingDailySweep } from "../../runtime/servicing.ts";
import { delinquencyDailySweep } from "../../runtime/delinquency.ts";
import { FAKE_SERVICER_CONTACT } from "../../runtime/borrower/flows/9-servicing-requests.ts";
import { noteTermsHash, prepaidInterest } from "../orig-boarding/ops-30-2.ts";
import { assessLateCharge, graceEnd, lateChargeAmount, lateChargeTerms, nsfFee } from "../cashiering/latecharges.ts";
import { draftAmount, settlementDateFor, type Enrollment } from "../cashiering/autodraft.ts";
import type { FakeOdfi } from "../../infra/integrations/banking.ts";
import { EI_NOTICE_VARIANTS, writtenNoticeRequest } from "../early-intervention/ops-11-2.ts";
import { CASHIERING_AGENT, monthlyInterestBps, registerReprojectionReactor, satisfyInstallments } from "./installments.ts";
import { cashieringDailyRun, loanCashStateFromRows, runCashieringUnit, selectBook } from "./cashiering-cycle.ts";
import { ports35_5 } from "./ports-35-5.ts";
import { LOCKBOXES, PgFakeLockboxQueue, itemIdempotencyKey, lockboxCutoff, receivedOnFor } from "./lockbox.ts";
import { PgFakeOdfiQueue, enrollmentOf, fakeReturnFile, type ActionOutcome, type BuildReport, type ReturnsIngestReport } from "./ach.ts";
import { encodeRemittance, parseRemittance, remittanceSha256 } from "../../infra/integrations/codecs/lockbox-remittance.ts";
import { FAKE_SERVICER_PROFILE_V1, STATE_DEFAULT_TIME_ZONE, servicerBlockFor } from "./servicing-config.ts";
import { boardTapeLoan, chicagoInstant, enrollmentData, fundDemoNote, fundDemoNoteRaw, insertUnconfiguredLoan, linkBorrowerParty, partnerPartyOf, readAchEntries, readAchFiles, readAchReturns, readBatches, readEvents, readEventsOfType, readGlobalTimer, readItems, readReturnFiles, readRows, readRuns, readSet, readSubjectTimer, readTimer, readUnitRuns, rowsJson, seedCustodial, writePayment, AZ_TAPE, L1_TAPE, NY_TAPE, SEED, T7_TAPE, type ItemRead, type SetLineRead } from "./harness-35-5.ts";

// The harness (src/domain/operations-runtime/harness-35-5.ts): this file's own database from the migrated template (0142/0143 in
// place), one Runtime over it with a FixedClock the T-ids move, the fund path's partner party opened here, the transfer path's
// partner keyed by its servicer number as boardTransferBatch keys it. T-ids run in file order and hand each other their loans
// (T1's funded note and T2's tape T-7 are T12's two boarding paths; T13 boards L-1 itself).
const { url: DB_URL, skip } = await testDatabase(import.meta.url);
const R = randomUUID().slice(0, 8);
const clock = new FixedClock("2026-10-16T14:00:00.000Z");
const COMPLIANCE: Actor = { kind: "human", id: `compliance-${R}`, role: "compliance" };
const ANALYST: Actor = { kind: "human", id: `analyst-${R}`, role: "ops_analyst" };
const TOKEN = `ops-${randomUUID()}`;
let db: Db; let runtime: Runtime; let partnerPartyId = "";
const loans = { t1: "", t2: "", t3: "", l1: "", l1ach: "" };
const OFFICER: Actor = { kind: "human", id: `officer-${R}`, role: "officer" };
const sha256 = (v: string): string => createHash("sha256").update(v, "utf8").digest("hex");
/** A fixture enrollment through 2.3's own `autodraft.read/write{op: write}` (the JSONB row 2.3 reads). */
const writeEnrollment = (loanId: string, id: string, o: Parameters<typeof enrollmentData>[2]): Promise<unknown> => runtime.execute({ process: "2.3", name: "autodraft.read/write", loanId, actor: CASHIERING_AGENT, input: { op: "write", id, data: enrollmentData(id, loanId, o) } });
const enrollmentRow = async (loanId: string, id: string): Promise<Row> => (await ports35_5(runtime).cashRows.enrollmentsFor(loanId)).find((e) => e.id === id)!.data;
const eventsOn = async (loanId: string, type: string): Promise<{ id: string; payload: Row; actor_id: string; sequence: bigint }[]> => (await readEvents(db, loanId)).filter((e) => e.type === type);
const documentOf = async (id: string): Promise<{ sha256: string; storage_uri: string; kind: string; retention_class: string; metadata: Row }> => (await db.query<{ sha256: string; storage_uri: string; kind: string; retention_class: string; metadata: Row }>(`SELECT sha256, storage_uri, kind, retention_class::text AS retention_class, metadata FROM documents WHERE id = $1`, [id]))[0]!;
const fileBytes = async (documentId: string): Promise<string> => Buffer.from(String((await documentOf(documentId)).metadata["fake_bytes_b64"] ?? ""), "base64").toString("utf8");
/** Σ ledger lines per (scope, account) over a list of entry sets. */
const setTotals = async (setIds: readonly string[]): Promise<Record<string, bigint>> => Object.fromEntries((await db.query<{ k: string; total: bigint }>(`SELECT scope::text || ':' || account AS k, sum(amount_cents)::bigint AS total FROM ledger_lines WHERE set_id = ANY($1::uuid[]) GROUP BY 1 ORDER BY 1`, [[...setIds]])).map((r) => [r.k, r.total]));
type Row = Record<string, unknown>;
const count = async (sql: string, params: unknown[] = []): Promise<bigint> => (await db.query<{ c: bigint }>(sql, params))[0]!.c;
const sum = (xs: readonly Record<string, unknown>[], k: string): bigint => xs.reduce((a, r) => a + (r[k] as bigint), 0n);
const profileV1 = async (): Promise<Row> => (await db.query<Row>(`SELECT id, legal_name, tin_encrypted, tin_last4, toll_free_phone, servicer_address, exclusive_address, remittance_address, portal_url, counselor_url, hud_phone, status::text AS status, effective_from::text AS effective_from, effective_to::text AS effective_to, version FROM servicer_profiles WHERE version = 1 AND legal_name = 'Supermortgage LLC' ORDER BY created_at LIMIT 1`))[0]!;

test.before(async () => {
  if (skip) return;
  db = connect(DB_URL);
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock, databaseUrl: DB_URL });   // databaseUrl: 35.3's planner lock (`pg_try_advisory_lock(35_003)`) on a dedicated client — the daily run plans through the engine
  partnerPartyId = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id) VALUES ('servicer', $1, $2, '1000123') RETURNING id`, [`Partner Bank ${R}`, String(100_000_000 + Math.floor(Math.random() * 899_999_999))]))[0]!.id;
});
test.after(async () => { if (!skip) await db.end(); });

test("35.5-T1: Given the demo snapshot's note ($560,000.00 at 6.125%, 360 months, first payment 2027-01-01) funded through `POST /v1/applications/{id}/fund`, when the hand-off commits, then `loan_installments` has 360 rows for the loan in the same transaction as `loan.boarded`, the run row shows `pi_cents` **$3,402.62**, row 1 interest **$2,858.33** and principal **$544.29** with `upb_after_cents` **$559,455.71**, row 2 interest **$2,855.56** and principal **$547.06**, row 360 interest **$17.27**, principal **$3,384.35**, `pi_cents` **$3,401.62** and `absorbs_rounding = true`, Σ `principal_cents` = **$560,000.00**, Σ `interest_cents` = **$664,942.20**, `maturity_variance_cents = 0`, and `SM_INSTALLMENT_SCHEDULE_AT_BOARD_0` is satisfied by `installment.schedule.written` in the same commit.", { skip }, async () => {
  clock.set("2026-11-12T18:40:00.000Z");
  const funded = await fundDemoNote(runtime, partnerPartyId);
  const loanId = funded.result.loan_id; loans.t1 = loanId;
  assert.match(funded.result.status, /^boarded/);
  // 360 rows from the first payment date, the run row, worked example A's figures
  const rows = await readRows(db, loanId); assert.equal(rows.length, 360);
  const runs = await readRuns(db, loanId); assert.equal(runs.length, 1); const run = runs[0]!;
  assert.equal(run.source, "fund"); assert.equal(run.rows, 360); assert.equal(run.pi_cents, 340_262n); assert.equal(run.maturity_variance_cents, 0n); assert.equal(run.upb_start_cents, 56_000_000n); assert.equal(run.rate_bps, 61250); assert.ok(run.decision_id);
  assert.equal(run.terms_id, rows[0]!.terms_id); assert.ok(run.terms_id);
  const r1 = rows[0]!; assert.equal(r1.due_date, "2027-01-01"); assert.equal(r1.sequence, 1); assert.equal(r1.upb_before_cents, 56_000_000n);
  assert.equal(r1.interest_cents, 285_833n); assert.equal(r1.principal_cents, 54_429n); assert.equal(r1.upb_after_cents, 55_945_571n); assert.equal(r1.pi_cents, 340_262n); assert.equal(r1.status, "due");
  const r2 = rows[1]!; assert.equal(r2.due_date, "2027-02-01"); assert.equal(r2.interest_cents, 285_556n); assert.equal(r2.principal_cents, 54_706n); assert.equal(r2.upb_after_cents, 55_890_865n);
  const r360 = rows[359]!; assert.equal(r360.due_date, "2056-12-01"); assert.equal(r360.sequence, 360); assert.equal(r360.upb_before_cents, 338_435n); assert.equal(r360.interest_cents, 1_727n); assert.equal(r360.principal_cents, 338_435n); assert.equal(r360.pi_cents, 340_162n); assert.equal(r360.absorbs_rounding, true); assert.equal(r360.upb_after_cents, 0n);
  assert.ok(rows.slice(0, 359).every((r) => !r.absorbs_rounding && r.pi_cents === 340_262n));
  assert.equal(sum(rows, "principal_cents"), 56_000_000n); assert.equal(sum(rows, "interest_cents"), 66_494_220n);
  assert.equal(run.total_principal_cents, 56_000_000n); assert.equal(run.total_interest_cents, 66_494_220n);
  assert.equal(run.pi_cents, levelPayment(56_000_000n, ratePercent("6.125"), 360));
  // the same transaction as loan.boarded: the rows carry the loans row's xmin; the written event lies between loan.boarded and the last event of that commit
  const loanXmin = (await db.query<{ xmin: string }>(`SELECT xmin::text AS xmin FROM loans WHERE id = $1`, [loanId]))[0]!.xmin;
  assert.ok(rows.every((r) => r.xmin === loanXmin), "loan_installments rows committed in the boarding transaction");
  const events = await readEvents(db, loanId);
  const boarded = events.find((e) => e.type === "loan.boarded"); const written = events.find((e) => e.type === "installment.schedule.written");
  assert.ok(boarded && written, "loan.boarded and installment.schedule.written on the loan's log");
  assert.ok(written.sequence > boarded.sequence && written.sequence <= events[events.length - 1]!.sequence); assert.equal(written.xmin, boarded.xmin);
  assert.equal(written.payload["rows"], 360); assert.equal(written.payload["pi_cents"], "340262"); assert.equal(written.payload["sha256"], run.sha256); assert.equal(written.payload["run_id"], run.id); assert.equal(written.payload["source"], "fund"); assert.equal(written.actor_id, "cashiering");
  const timers = await readTimer(db, loanId, "SM_INSTALLMENT_SCHEDULE_AT_BOARD_0");
  assert.equal(timers.length, 1); assert.equal(timers[0]!.status, "satisfied"); assert.equal(timers[0]!.satisfied_by_event_id, written.id); assert.equal(timers[0]!.armed_by_event_id, boarded.id); assert.equal(timers[0]!.anchor_date, "2026-11-12");
  const decision = (await db.query<Row>(`SELECT rule_set_version, action, rationale, subject_kind, subject_id FROM agent_decisions WHERE id = $1`, [run.decision_id]))[0]!;
  assert.equal(decision["rule_set_version"], "cashiering.schedule.v1"); assert.equal(decision["action"], "installments.write"); assert.equal(decision["subject_id"], run.id);
  assert.equal(JSON.parse(String(decision["rationale"])).outputs.maturity_variance_cents, "0");
  // the refusal branch: a note whose maturity precedes its first payment date has no installment → SCHEDULE_REQUIRED, and no loans row commits
  const bad = await fundDemoNoteRaw(runtime, partnerPartyId, { snapshot: (base) => { const note = { ...DEMO_NOTE, maturity_date: D("2026-12-01") }; return { note: { ...base.note, maturity_date: D("2026-12-01") }, closing: { ...base.closing, note_terms_hash: noteTermsHash(note) } }; } });
  await assert.rejects(bad.run(), (e: unknown) => e instanceof CommandRefused && e.code === "SCHEDULE_REQUIRED");
  assert.equal(await count(`SELECT count(*)::bigint AS c FROM loans WHERE origination_application_id = $1`, [bad.application_id]), 0n);
  assert.equal((await db.query<{ loan_id: string | null }>(`SELECT loan_id FROM applications WHERE id = $1`, [bad.application_id]))[0]!.loan_id, null);
  assert.equal(await count(`SELECT count(*)::bigint AS c FROM loan_events WHERE application_id = $1 AND type = 'loan.boarded'`, [bad.application_id]), 0n);
});
test("35.5-T2: Given tape loan T-7 ($300,000.00 at 6.500%, 360 months, first payment 2021-10-01, next due 2026-11-01, UPB $280,458.24, P&I $1,896.20, escrow $412.30) boarded through `POST /v1/transfers/batches` on 2026-10-16, when the batch commits, then 299 rows exist from 2026-11-01 to 2051-09-01 with `sequence` 62 … 360, HF-005 recomputes **$1,896.20** with difference 0¢, row 2026-11-01 has interest **$1,519.15**, principal **$377.05**, escrow $412.30 and `upb_after_cents` **$280,081.19**, row 2026-12-01 has interest **$1,517.11** and principal **$379.09**, row 2051-09-01 has interest **$10.24**, principal **$1,890.67** and `pi_cents` **$1,900.91**, `maturity_variance_cents = 0`, and the delinquency counter job's selector (`JOIN loan_installments … status = 'due'`) returns the loan once 2026-11-01 has passed unpaid in its zone.", { skip }, async () => {
  const t7 = await boardTapeLoan(runtime, clock, T7_TAPE, `B-T7-${R}`, D("2026-10-16")); const loanId = t7.loan_id; loans.t2 = loanId;
  const rows = await readRows(db, loanId);
  assert.equal(rows.length, 299); assert.equal(rows[0]!.due_date, "2026-11-01"); assert.equal(rows[298]!.due_date, "2051-09-01"); assert.equal(rows[0]!.sequence, 62); assert.equal(rows[298]!.sequence, 360);
  assert.ok(rows.every((r, k) => r.sequence === 62 + k && r.status === "due"));
  const runs = await readRuns(db, loanId); assert.equal(runs.length, 1); const run = runs[0]!;
  assert.equal(run.source, "transfer"); assert.equal(run.rows, 299); assert.equal(run.pi_cents, 189_620n); assert.equal(run.upb_start_cents, 28_045_824n); assert.equal(run.rate_bps, 65000); assert.equal(run.maturity_variance_cents, 0n);
  const terms = (await db.query<{ id: string }>(`SELECT id FROM loan_terms WHERE loan_id = $1`, [loanId])); assert.equal(terms.length, 1); assert.equal(run.terms_id, terms[0]!.id); assert.ok(rows.every((r) => r.terms_id === terms[0]!.id && r.schedule_run_id === run.id));
  // HF-005 on the original terms: the level payment reproduces the tape's P&I to the cent
  assert.equal(levelPayment(30_000_000n, ratePercent("6.500"), 360), 189_620n);
  const decision = (await db.query<Row>(`SELECT rationale, rule_set_version FROM agent_decisions WHERE id = $1`, [run.decision_id]))[0]!;
  assert.equal(decision["rule_set_version"], "cashiering.schedule.v1");
  const rec = JSON.parse(String(decision["rationale"])); assert.equal(rec.inputs.hf005.diff_cents, "0"); assert.equal(rec.inputs.hf005.level_payment_cents, "189620"); assert.equal(rec.inputs.terms_id, terms[0]!.id);
  // worked example B
  const nov = rows[0]!; assert.equal(nov.upb_before_cents, 28_045_824n); assert.equal(nov.interest_cents, 151_915n); assert.equal(nov.principal_cents, 37_705n); assert.equal(nov.escrow_cents, 41_230n); assert.equal(nov.upb_after_cents, 28_008_119n); assert.equal(nov.pi_cents, 189_620n);
  const dec = rows[1]!; assert.equal(dec.due_date, "2026-12-01"); assert.equal(dec.interest_cents, 151_711n); assert.equal(dec.principal_cents, 37_909n); assert.equal(dec.upb_after_cents, 27_970_210n);
  const rowLast = rows[298]!; assert.equal(rowLast.upb_before_cents, 189_067n); assert.equal(rowLast.interest_cents, 1_024n); assert.equal(rowLast.principal_cents, 189_067n); assert.equal(rowLast.pi_cents, 190_091n); assert.equal(rowLast.absorbs_rounding, true); assert.equal(rowLast.upb_after_cents, 0n);
  assert.equal(rowLast.pi_cents - run.pi_cents, 471n);
  assert.equal(sum(rows, "principal_cents"), 28_045_824n); assert.equal(run.total_principal_cents, 28_045_824n);
  assert.equal(await count(`SELECT count(*)::bigint AS c FROM escalations WHERE loan_id = $1`, [loanId]), 0n, "a consistent tape raises no HF-005 exception");
  // the batch's transaction: the rows, the events and the clock share the loans row's xmin; the clock was armed on the servicing-side loan.boarded and satisfied in the same commit
  const loanXmin = (await db.query<{ xmin: string }>(`SELECT xmin::text AS xmin FROM loans WHERE id = $1`, [loanId]))[0]!.xmin;
  assert.ok(rows.every((r) => r.xmin === loanXmin));
  const events = await readEvents(db, loanId);
  const boarded = events.find((e) => e.type === "loan.boarded"); const written = events.find((e) => e.type === "installment.schedule.written");
  assert.ok(boarded && written); assert.equal(written.xmin, loanXmin); assert.ok(written.sequence > boarded.sequence);
  assert.equal(written.payload["rows"], 299); assert.equal(written.payload["first_due"], "2026-11-01"); assert.equal(written.payload["last_due"], "2051-09-01");
  const timers = await readTimer(db, loanId, "SM_INSTALLMENT_SCHEDULE_AT_BOARD_0");
  assert.equal(timers.length, 1); assert.equal(timers[0]!.status, "satisfied"); assert.equal(timers[0]!.satisfied_by_event_id, written.id); assert.equal(timers[0]!.armed_by_event_id, boarded.id); assert.equal(timers[0]!.subject_kind, "loan"); assert.equal(timers[0]!.subject_id, loanId);
  // the delinquency counter job's selector (JOIN loan_installments … status = 'due'): not before 2026-11-01 has passed unpaid in the loan's zone, listed once it has
  const notYet = await delinquencyDailySweep(runtime, "2026-11-01T03:00:00.000Z", [loanId]);   // 22:00 Chicago on 2026-10-31
  assert.equal(notYet.loans.length, 0);
  clock.set("2026-11-02T14:00:00.000Z");
  const listed = await delinquencyDailySweep(runtime, "2026-11-02T14:00:00.000Z", [loanId]);
  assert.equal(listed.loans.length, 1); assert.equal(listed.loans[0]!.loan_id, loanId); assert.equal(listed.loans[0]!.earliest_unpaid_due, "2026-11-01");
});
test("35.5-T3: Given 7.2's Plan 4927 loan boarded at fund ($400,000.00 at 5.750%, 360 months, first payment 2021-12-01, first change 2026-11-01), then the schedule's P&I is **$2,334.29** and row 60's `upb_after_cents` is **$371,048.86**; when 7.2 activates `loan_terms` v2 (`loan_terms.version.activated`, `arm_change`, `effective_on` 2026-12-01, 6.375%, P&I **$2,476.44**), then `installments.reproject` records `rows_kept = 60`, `rows_replaced = 300`, row 2026-12-01 has interest **$1,971.20**, principal **$505.24**, `upb_after_cents` **$370,543.62**, `rate_bps = 63750` and `terms_id` = v2, rows 1–60 are byte-identical to before, `installment.schedule.reprojected` satisfies `SM_INSTALLMENT_REPROJECT_1BD`, and a reprojection whose `effective_from` names a satisfied row is refused `SATISFIED_ROW_FROZEN` with no row changed.", { skip }, async () => {
  // 7.2's Plan 4927 loan funded through the hand-off with 2021 dates (every OB rule against the 2021 calendar: rescission cleared, the CD's prepaid interest by the note)
  clock.set("2021-11-12T18:40:00.000Z");
  const note = { amount_cents: 40_000_000n, note_rate_pct: "5.750", term_months: 360, first_payment_date: D("2021-12-01"), maturity_date: D("2051-11-01"), late_charge_pct: DEMO_NOTE.late_charge_pct, late_charge_grace_days: DEMO_NOTE.late_charge_grace_days };
  const prepaid = prepaidInterest(40_000_000n, "5.750", D("2021-11-12"));
  const funded = await fundDemoNote(runtime, partnerPartyId, {
    snapshot: (base) => ({
      note: { ...base.note, ...note, note_date: D("2021-11-06"), amortization: "arm", arm: { index: "SOFR30", margin_bps: 275, initial_cap_bps: 200, periodic_cap_bps: 100, lifetime_cap_bps: 500, lookback_days: 45, first_change_date: D("2026-11-01"), rounding: "nearest_eighth" } },
      closing: { ...base.closing, consummation_date: D("2021-11-06"), note_terms_hash: noteTermsHash(note) },
      final_cd: { ...base.final_cd, pi_cents: 233_429n, monthly_escrow_cents: 61_250n, initial_escrow_deposit_cents: 183_750n, prepaid_interest_cents: prepaid.prepaid_interest_cents, prepaid_interest_days: prepaid.days },
      escrow_analysis: { ...base.escrow_analysis!, required_start_balance_cents: 61_250n, cushion_cents: 122_500n, monthly_escrow_cents: 61_250n, lines: [{ line_type: "county_tax", annual_amount_cents: 540_000n, monthly_cents: 45_000n }, { line_type: "hazard", annual_amount_cents: 195_000n, monthly_cents: 16_250n }] },
      rescission_expires_at: "2021-11-11T06:59:59.000Z", hazard: { ...base.hazard, expires_on: D("2022-11-12") },
    }),
    funded: { funded_at: "2021-11-12T18:40:00.000Z", funding_date: D("2021-11-12"), disbursement_date: D("2021-11-12"), rescission_expires_at: "2021-11-11T06:59:59.000Z", funded_amount_cents: 40_000_000n, per_diem_cents: prepaid.per_diem_cents, prepaid_interest_cents: prepaid.prepaid_interest_cents, wire_id: "IMAD-20211112-001" },
  });
  const loanId = funded.result.loan_id; loans.t3 = loanId; assert.match(funded.result.status, /^boarded/);
  const before = await readRows(db, loanId); assert.equal(before.length, 360);
  const run1 = (await readRuns(db, loanId))[0]!; assert.equal(run1.pi_cents, 233_429n); assert.equal(run1.upb_start_cents, 40_000_000n); assert.equal(run1.rate_bps, 57500); assert.equal(run1.maturity_variance_cents, 0n);
  assert.equal(levelPayment(40_000_000n, ratePercent("5.750"), 360), 233_429n);
  const row60 = before[59]!; assert.equal(row60.due_date, "2026-11-01"); assert.equal(row60.sequence, 60); assert.equal(row60.upb_after_cents, 37_104_886n);
  assert.equal(before[60]!.due_date, "2026-12-01"); assert.equal(before[60]!.rate_bps, 57500); assert.equal(before[60]!.upb_before_cents, 37_104_886n);
  const v1TermsId = row60.terms_id; const keptBefore = (await rowsJson(db, loanId)).slice(0, 60);
  // 7.2 activates loan_terms v2 (arm_change, effective 2026-12-01, 6.375%, P&I $2,476.44 = levelPayment on the expected UPB over the remaining 300 months) under its own spelling
  // (ops-7-2.ts:486 appends the event and stores the version; no emitter writes a typed loan_terms row): the reactor arms the clock and runs installments.reproject on the bus after the commit,
  // and the reprojection writes the typed v2 keyed by the event (source_event_id) — the `terms_id` every replaced row and the run carry
  assert.equal(levelPayment(37_104_886n, ratePercent("6.375"), 300), 247_644n);
  clock.set("2026-11-15T15:00:00.000Z");
  const reactor = registerReprojectionReactor(runtime, () => undefined);
  await runtime.uow.run({ loanId }, async (ctx) => {
    ctx.events.append({ type: "loan_terms.version.activated", loanId, actor: { kind: "agent", id: "disclosures" }, payload: { version: 2, effective_on: "2026-12-01", rate_pct: "6.375", pi_cents: "247644", payment_effective_due: "2026-12-01", next_change_date: "2027-11-01", reason: "arm_adjustment" } });
  }, { clock });
  await reactor.settle();
  const termsRows = await db.query<Row>(`SELECT id, source, source_event_id, effective_from::text AS effective_from, effective_to::text AS effective_to, note_rate_bps, pi_cents, escrow_payment_cents, maturity_date::text AS maturity_date, remaining_term_months, amortization::text AS amortization, arm_next_change_date::text AS arm_next_change_date FROM loan_terms WHERE loan_id = $1 ORDER BY effective_from`, [loanId]);
  assert.equal(termsRows.length, 2, "the boarding terms and the version 7.2's activation projected");
  const v2 = termsRows[1]!; const v2Id = String(v2["id"]);
  assert.equal(v2["source"], "arm_change"); assert.equal(v2["effective_from"], "2026-12-01"); assert.equal(v2["note_rate_bps"], 63750); assert.equal(v2["pi_cents"], 247_644n); assert.equal(v2["escrow_payment_cents"], 61_250n); assert.equal(v2["maturity_date"], "2051-11-01"); assert.equal(v2["remaining_term_months"], 300); assert.equal(v2["amortization"], "arm"); assert.equal(v2["arm_next_change_date"], "2027-11-01");
  assert.equal(termsRows[0]!["id"], v1TermsId); assert.equal(termsRows[0]!["effective_to"], "2026-12-01", "the prior version closes at the change date");
  const runs = await readRuns(db, loanId); assert.equal(runs.length, 2); const run2 = runs[1]!;
  assert.equal(run2.source, "reprojection"); assert.equal(run2.rows_kept, 60); assert.equal(run2.rows_replaced, 300); assert.equal(run2.rows, 300); assert.equal(run2.terms_id, v2Id); assert.equal(run2.pi_cents, 247_644n); assert.equal(run2.rate_bps, 63750); assert.equal(run2.upb_start_cents, 37_104_886n); assert.equal(run2.replaced.length, 300); assert.ok(run2.decision_id);
  const after = await readRows(db, loanId); assert.equal(after.length, 360);
  const rowDec = after[60]!; assert.equal(rowDec.due_date, "2026-12-01"); assert.equal(rowDec.sequence, 61); assert.equal(rowDec.interest_cents, 197_120n); assert.equal(rowDec.principal_cents, 50_524n); assert.equal(rowDec.upb_after_cents, 37_054_362n); assert.equal(rowDec.rate_bps, 63750); assert.equal(rowDec.terms_id, v2Id); assert.equal(rowDec.pi_cents, 247_644n); assert.equal(rowDec.schedule_run_id, run2.id);
  assert.equal(rowDec.escrow_cents, 61_250n);
  assert.ok(after.slice(0, 60).every((r) => r.terms_id === v1TermsId && r.rate_bps === 57500 && r.schedule_run_id === run1.id)); assert.ok(after.slice(60).every((r) => r.terms_id === v2Id && r.rate_bps === 63750));
  assert.deepEqual((await rowsJson(db, loanId)).slice(0, 60), keptBefore, "rows 1–60 byte-identical before and after");
  assert.equal(after[359]!.due_date, "2051-11-01"); assert.equal(after[359]!.absorbs_rounding, true); assert.equal(run2.maturity_variance_cents, 0n);
  const events = await readEvents(db, loanId);
  const activatedEvt = events.find((e) => e.type === "loan_terms.version.activated"); const reprojected = events.find((e) => e.type === "installment.schedule.reprojected");
  assert.ok(activatedEvt && reprojected); assert.equal(reprojected.payload["rows_kept"], 60); assert.equal(reprojected.payload["rows_replaced"], 300); assert.equal(reprojected.payload["terms_id"], v2Id); assert.equal(reprojected.payload["effective_from"], "2026-12-01"); assert.equal(reprojected.payload["run_id"], run2.id);
  assert.equal(v2["source_event_id"], activatedEvt.id); assert.equal(reprojected.payload["terms_version_written"], true); assert.equal(run2.trigger_event_id, activatedEvt.id);
  const clockRows = await readTimer(db, loanId, "SM_INSTALLMENT_REPROJECT_1BD");
  assert.equal(clockRows.length, 1); assert.equal(clockRows[0]!.status, "satisfied"); assert.equal(clockRows[0]!.satisfied_by_event_id, reprojected.id); assert.equal(clockRows[0]!.armed_by_event_id, activatedEvt.id); assert.equal(clockRows[0]!.anchor_date, "2026-12-01");
  assert.ok(events.some((e) => e.type === "command.executed" && e.payload["command"] === "installments.reproject"));
  // the 2.3 amount-change check on the next unit: Plan 4927's draft is 247,644 + 61,250 against a last debit of 233,429 + 61,250 (worked example C)
  const authorization = { borrower_name: "Ada Fixture", loan_number_masked: "****4927", routing: "021000021", account_last4: "4927", account_type: "checking", amount_rule: "full_periodic_payment", variable_amount_statement: true, frequency: "monthly", first_debit_on: "2021-12-01", authorized_on: "2021-11-20", company_name: "Supermortgage LLC", revocation_instructions: true, optional_statement: true, esign_consent: true, sec: "WEB" } as const;
  const enrollment: Enrollment = { id: `E-4927-${R}`, loan_id: loanId, status: "active", authorization: { ...authorization, first_debit_on: D("2021-12-01"), authorized_on: D("2021-11-20") }, draft_day: 1, extra_principal_cents: 0n, include_fees: false, next_draft_on: D("2026-12-01"), validation_status: "validated", reinitiations: [], returns_on_current_installment: 0, last_debit_cents: 294_679n, notices: [] };
  assert.equal(233_429n + 61_250n, 294_679n); assert.equal(enrollment.last_debit_cents, 294_679n);
  assert.equal(draftAmount(enrollment, 247_644n + 61_250n, 0n), 308_894n); assert.equal(draftAmount(enrollment, rowDec.pi_cents + rowDec.escrow_cents, 0n), 308_894n);
  await runtime.execute({ process: "2.3", name: "autodraft.read/write", loanId, actor: CASHIERING_AGENT, input: { op: "write", id: enrollment.id, data: { enrollment_id: enrollment.id, loan_id: loanId, status: "active", authorization, draft_day: 1, extra_principal_cents: "0", include_fees: false, next_draft_on: "2026-12-01", validation_status: "validated_api", reinitiations: [], returns_on_current_installment: 0, last_debit_cents: "294679", notices: [], account_last4: "4927" } } });
  clock.set("2026-11-16T16:00:00.000Z");
  const sweep = await servicingDailySweep(runtime, "2026-11-16T16:00:00.000Z");
  assert.ok(sweep.amount_change_checks.includes(enrollment.id), JSON.stringify(sweep.errors));
  const afterSweep = await readEvents(db, loanId);
  assert.ok(afterSweep.some((e) => e.type === "command.executed" && e.payload["command"] === "autodraft.read/write"));
  const noticed = afterSweep.find((e) => e.type === "notice.sent" && e.payload["kind"] === "variable_amount_10d");
  assert.ok(noticed, "2.3 rule 5: the changed draft amount needs the 10-day notice"); assert.equal(noticed.payload["amount_cents"], "308894"); assert.equal(noticed.payload["debit_on"], "2026-12-01"); assert.equal(noticed.payload["enrollment_id"], enrollment.id);
  assert.equal(await count(`SELECT count(*)::bigint AS c FROM installment_schedule_runs WHERE loan_id = $1`, [loanId]), 2n, "a unit never re-projects the schedule");
  // the frozen branch: a reprojection whose effective date names a satisfied row is refused SATISFIED_ROW_FROZEN with no row changed —
  // on the reactor's path (3.6's `loan_terms.versioned{effective_from}` naming the satisfied 2026-12-01 row) the refusal rolls its unit of work back, leaves the
  // clock it armed to breach, writes no terms version and opens rule 3's officer escalation; and on the direct command
  await db.tx((q) => satisfyInstallments(q, loanId, [{ due_date: D("2026-12-01"), payment_id: null, credited_as_of: D("2026-12-01"), satisfied_on: D("2026-12-01") }]));   // a row satisfied by hand (no typed payment behind it — 35.1's 0151 FK names one when set): the frozen-row rule is the point
  const frozenBefore = await rowsJson(db, loanId);
  const escalationsBefore = await count(`SELECT count(*)::bigint AS c FROM escalations WHERE loan_id = $1`, [loanId]);
  await runtime.uow.run({ loanId }, async (ctx) => {
    ctx.events.append({ type: "loan_terms.versioned", loanId, actor: { kind: "agent", id: "escrow" }, payload: { version: 3, reason: "escrow_repayment_plan", plan_id: `plan-${R}`, escrow_payment_cents: "63000", effective_from: "2026-12-01", step_down_on: null, step_down_to_cents: "61250" } });
  }, { clock });
  await reactor.settle();
  assert.deepEqual(await rowsJson(db, loanId), frozenBefore, "the refused reprojection changed no row"); assert.equal((await readRuns(db, loanId)).length, 2);
  assert.equal(await count(`SELECT count(*)::bigint AS c FROM loan_terms WHERE loan_id = $1`, [loanId]), 2n, "no terms version is written by a refused reprojection");
  const versionedEvt = (await readEvents(db, loanId)).find((e) => e.type === "loan_terms.versioned")!; assert.ok(versionedEvt);
  const clocksAfter = await readTimer(db, loanId, "SM_INSTALLMENT_REPROJECT_1BD");
  assert.equal(clocksAfter.length, 2); assert.equal(clocksAfter[0]!.status, "satisfied"); assert.equal(clocksAfter[1]!.status, "armed"); assert.equal(clocksAfter[1]!.armed_by_event_id, versionedEvt.id); assert.equal(clocksAfter[1]!.anchor_date, "2026-12-01");
  const officer = await db.query<Row>(`SELECT owner_role, kind, status::text AS status, payload FROM escalations WHERE loan_id = $1 ORDER BY opened_at DESC LIMIT 1`, [loanId]);
  assert.equal(await count(`SELECT count(*)::bigint AS c FROM escalations WHERE loan_id = $1`, [loanId]), escalationsBefore + 1n);
  assert.equal(officer[0]!["owner_role"], "officer"); assert.equal((officer[0]!["payload"] as Row)["rule_code"], "SATISFIED_ROW_FROZEN"); assert.equal((officer[0]!["payload"] as Row)["trigger_event_id"], versionedEvt.id);
  reactor.stop();
  await assert.rejects(runtime.execute({ process: "35.5", name: "installments.reproject", loanId, actor: CASHIERING_AGENT, input: { loan_id: loanId, terms_id: v2Id, effective_from: "2026-12-01" } }), (e: unknown) => e instanceof CommandRefused && e.code === "SATISFIED_ROW_FROZEN");
  assert.deepEqual(await rowsJson(db, loanId), frozenBefore); assert.equal((await readRuns(db, loanId)).length, 2);
  // the row trigger holds the same line without the tool: a money column of the satisfied row cannot be updated
  await assert.rejects(db.query(`UPDATE loan_installments SET pi_cents = pi_cents + 1 WHERE loan_id = $1 AND due_date = '2026-12-01'`, [loanId]), /SATISFIED_ROW_FROZEN/);
  await assert.rejects(db.query(`DELETE FROM loan_installments WHERE loan_id = $1 AND due_date = '2051-11-01'`, [loanId]), /append-only/);
});
test("35.5-T4: Given the 100-loan demo book (transfer-boarded, `origination_application_id IS NULL`) and one originated loan, when the `cashiering_daily` cycle runs for a day, then `cycle_runs` shows `units_total = 101`, every loan has one `cashiering_unit_runs` row with `outcome = done` for that `as_of_date`, `cashiering.daily.run_completed{loans: 101}` is appended exactly once and satisfies `SM_CASHIERING_DAILY_RECEIPT_1D`, and running the cycle again for the same day writes no payment, fee, ledger line or unit row (the second run's decision records name the existing rows).", { skip }, async () => {
  // the 100-loan demo book through the transfer route on its transfer date, 2026-09-01 (six planted hard exceptions — seq 7, 13, 21, 34, 42, 58 — stay staged: 94 board)
  clock.set("2026-09-01T16:00:00.000Z");
  const demo = generateDemoBatch();
  const batch = await boardTransferBatch(runtime, { ...DEMO_BATCH }, encodeTransferBatch(demo, demo.coborrowers), SEED);
  assert.equal(batch.status, "boarded"); assert.equal(batch.loans.boarded, 94); assert.equal(batch.loans.staged, 100);
  const demoIds = Object.values(batch.loan_ids);
  assert.equal(await count(`SELECT count(*)::bigint AS c FROM loans WHERE id = ANY($1::uuid[]) AND boarded_at IS NOT NULL AND origination_application_id IS NULL`, [demoIds]), 94n);
  // the whole book as of the day (rule 6's selector: every loan boarded by the as-of instant, no origination_application_id condition): the 94 demo loans plus the one
  // originated loan boarded by then — T3's Plan 4927 (funded 2021-11-12); T1's note (funded 2026-11-12) and T-7 (boarded 2026-10-16) are not yet on the book on 2026-09-02.
  // The spec's 101 assumes every demo loan boards; the count here is the fixture's 94 plus that one originated loan, and nothing is excluded for lacking an application
  const AT = "2026-09-02T16:00:00.000Z";
  const selected = await selectBook(db, D("2026-09-02"), AT); const book = selected.loans.length;
  assert.equal(book, 94 + 1); assert.deepEqual(selected.unconfigured, []); assert.ok(selected.loans.some((l) => l.loan_id === loans.t3)); assert.ok(demoIds.filter((id) => selected.loans.some((l) => l.loan_id === id)).length === 94);
  assert.ok(!selected.loans.some((l) => l.loan_id === loans.t1) && !selected.loans.some((l) => l.loan_id === loans.t2), "boarded after the as-of instant");
  assert.equal(await count(`SELECT count(*)::bigint AS c FROM loans WHERE id = ANY($1::uuid[]) AND boarded_at > $2::timestamptz`, [[loans.t1, loans.t2], AT]), 2n);
  assert.equal(await count(`SELECT count(*)::bigint AS c FROM loans WHERE id = ANY($1::uuid[]) AND origination_application_id IS NOT NULL`, [[loans.t3]]), 1n);
  clock.set(AT);
  const r1 = await cashieringDailyRun(runtime, "2026-09-02T16:00:00.000Z");
  assert.deepEqual(r1.errors, []); assert.deepEqual(r1.skipped, []); assert.equal(r1.already, false); assert.equal(r1.as_of_date, "2026-09-02"); assert.equal(r1.loans, book); assert.equal(r1.units.done, book); assert.equal(r1.units.failed, 0);
  const cycles = ports35_5(runtime).cycles;
  const run = await cycles.run("cashiering_daily", "2026-09-02");
  assert.ok(run); assert.equal(run.run_id, r1.run_id); assert.equal(run.units_total, book); assert.equal(run.units_done, book); assert.equal(run.units_dead, 0); assert.equal(run.status, "completed"); assert.equal(run.period_key, "2026-09-02");
  const UNITS = `SELECT count(*)::bigint AS c FROM cashiering_unit_runs WHERE as_of_date = '2026-09-02' AND outcome = 'done'`;
  assert.equal(await count(UNITS), BigInt(book)); assert.equal(await count(`SELECT count(DISTINCT loan_id)::bigint AS c FROM cashiering_unit_runs WHERE as_of_date = '2026-09-02' AND outcome = 'done'`), BigInt(book));
  assert.equal(await count(`SELECT count(*)::bigint AS c FROM cashiering_unit_runs WHERE as_of_date = '2026-09-02' AND run_id = $1`, [r1.run_id]), BigInt(book));
  assert.ok((await db.query<Row>(`SELECT decision_id FROM cashiering_unit_runs WHERE as_of_date = '2026-09-02' AND outcome = 'done'`)).every((u) => typeof u["decision_id"] === "string"), "every unit row names its decision");
  // the receipt: appended exactly once, on the global subject with origination context, and it arms SM_CASHIERING_DAILY_RECEIPT_1D for the next day
  const RECEIPTS = `SELECT id, payload, actor_id, aggregate_kind, aggregate_id FROM loan_events WHERE type = 'cashiering.daily.run_completed' AND payload->>'as_of_date' = '2026-09-02' ORDER BY sequence`;
  const receipts = await db.query<Row>(RECEIPTS); assert.equal(receipts.length, 1); const receipt = receipts[0]!; const rp = receipt["payload"] as Row;
  assert.equal(rp["loans"], book); assert.equal(rp["run_id"], r1.run_id); assert.equal(rp["units_done"], book); assert.equal(rp["units_dead"], 0); assert.equal(rp["posted"], 0); assert.equal(rp["origination"], true); assert.equal(receipt["actor_id"], "cashiering"); assert.equal(receipt["id"], r1.receipt_event_id);
  // (T3's sweep on 2026-11-16 already ran the whole book once and armed the day's clock; this receipt satisfies that instance and arms the one for the day after 09-02 — one global instance armed at a time)
  const g1 = await readGlobalTimer(db, "SM_CASHIERING_DAILY_RECEIPT_1D");
  const armed1 = g1.filter((x) => x.status === "armed"); assert.equal(armed1.length, 1); const mine = armed1[0]!;
  assert.equal(mine.anchor_date, "2026-09-02"); assert.equal(mine.due_date, "2026-09-03"); assert.equal(mine.armed_by_event_id, receipt["id"]); assert.equal(mine.subject_id, "*");
  assert.ok(g1.filter((x) => x.status !== "armed").every((x) => x.status === "satisfied" && x.satisfied_by_event_id === receipt["id"]), "the earlier day's instance is satisfied by this receipt");
  // the same day again: nothing posted, assessed or written — the second run's decisions name the existing unit rows (ONE_UNIT_PER_LOAN_PER_DAY)
  const snapshot = async () => ({ cash: await count(`SELECT count(*)::bigint AS c FROM entity_records WHERE kind IN ('payments', 'fees', 'suspense_items')`), lines: await count(`SELECT count(*)::bigint AS c FROM ledger_lines`), units: await count(`SELECT count(*)::bigint AS c FROM cashiering_unit_runs`), events: await count(`SELECT count(*)::bigint AS c FROM loan_events WHERE type NOT IN ('command.executed')`), receipts: (await db.query<Row>(RECEIPTS)).length });
  const before = await snapshot();
  clock.set("2026-09-02T18:00:00.000Z");
  const r2 = await cashieringDailyRun(runtime, "2026-09-02T18:00:00.000Z");
  assert.equal(r2.already, true); assert.equal(r2.run_id, r1.run_id); assert.equal(r2.units.already, book); assert.equal(r2.units.done, 0); assert.deepEqual(r2.posted, []); assert.deepEqual(r2.errors, []); assert.equal(r2.receipt_event_id, null);
  assert.deepEqual(await snapshot(), before, "a second run the same day writes no payment, fee, ledger line, unit row, event or receipt");
  const unitByLoan = new Map((await db.query<{ loan_id: string; id: string }>(`SELECT loan_id, id FROM cashiering_unit_runs WHERE as_of_date = '2026-09-02' AND outcome = 'done'`)).map((u) => [u.loan_id, u.id]));
  const decisions = await db.query<Row>(`SELECT loan_id, subject_kind, subject_id, rationale, rule_set_version FROM agent_decisions WHERE action = 'cashiering.run_unit' AND rule_code = 'ONE_UNIT_PER_LOAN_PER_DAY'`);
  assert.equal(decisions.length, book);
  assert.ok(decisions.every((d) => String(d["rationale"]).startsWith("ONE_UNIT_PER_LOAN_PER_DAY: unit ") && d["subject_kind"] === "cashiering_unit_run" && d["subject_id"] === unitByLoan.get(String(d["loan_id"])) && String(d["rationale"]).includes(String(d["subject_id"])) && d["rule_set_version"] === "cashiering.allocation.v1"), "each names the existing unit row");
  const run2 = await cycles.run("cashiering_daily", "2026-09-02"); assert.ok(run2); assert.equal(run2.units_total, book); assert.equal(run2.units_done, book); assert.equal(run2.run_id, r1.run_id, "35.3 rule 3: the same (cycle, period) is one run — the rerun opened nothing");
  // the next day's receipt satisfies the day's clock and re-arms it (recurring, global)
  clock.set("2026-09-03T16:00:00.000Z");
  const r3 = await cashieringDailyRun(runtime, "2026-09-03T16:00:00.000Z");
  assert.equal(r3.already, false); assert.deepEqual(r3.errors, []); assert.equal(await count(`SELECT count(*)::bigint AS c FROM cashiering_unit_runs WHERE as_of_date = '2026-09-03' AND outcome = 'done'`), BigInt(book));
  const g2 = await readGlobalTimer(db, "SM_CASHIERING_DAILY_RECEIPT_1D");
  assert.equal(g2.length, g1.length + 1);
  const first = g2.find((x) => x.id === mine.id)!; assert.equal(first.status, "satisfied"); assert.equal(first.satisfied_by_event_id, r3.receipt_event_id);
  const armed2 = g2.filter((x) => x.status === "armed"); assert.equal(armed2.length, 1); assert.equal(armed2[0]!.anchor_date, "2026-09-03"); assert.equal(armed2[0]!.due_date, "2026-09-04"); assert.equal(armed2[0]!.armed_by_event_id, r3.receipt_event_id);
});
test("35.5-T5: Given loan L-1 with a `payments` row in `received` for **$2,192.57** on 2026-09-03, when its unit runs on 2026-09-03, then 2.1 posts interest **$1,352.94**, principal **$227.23** and escrow **$612.40** with the balanced sets of 2.1 rule 8 (`rule_ref` on every line), row 2026-09-01 is `satisfied` with `satisfied_by_payment_id` set and `credited_as_of` 2026-09-03, and `POST /v1/loans/{id}/tools/2.1/payments.read%2Fwrite` with an `input.state` whose UPB differs from the ledger is refused `NO_CLIENT_STATE` before any write (contract test over `payments.read/write{op=post}`, `fees.assess{op=daily_run}` and `autodraft.read/write{op=amount_change_check}`).", { skip }, async () => {
  // 2.1's fixture L-1 through the transfer route: a tape that does not amortize to zero boards (worked example B), the run's variance is HF-005's exception to officer
  const l1 = await boardTapeLoan(runtime, clock, L1_TAPE, `B-L1-T5-${R}`, D("2026-08-20")); const loanId = l1.loan_id;
  await seedCustodial(db, await partnerPartyOf(db));
  assert.equal(levelPayment(25_000_000n, ratePercent("6.500"), 360), 158_017n);
  const run = (await readRuns(db, loanId))[0]!; assert.equal(run.pi_cents, 158_017n); assert.equal(run.upb_start_cents, 24_977_400n); assert.notEqual(run.maturity_variance_cents, 0n); assert.equal(run.rows, 300);
  const esc = await db.query<Row>(`SELECT owner_role, payload FROM escalations WHERE loan_id = $1`, [loanId]); assert.equal(esc.length, 1); assert.equal(esc[0]!["owner_role"], "officer"); assert.equal((esc[0]!["payload"] as Row)["rule_code"], "HF-005");
  const first = (await readRows(db, loanId))[0]!; assert.equal(first.due_date, "2026-09-01"); assert.equal(first.status, "due"); assert.equal(first.pi_cents, 158_017n); assert.equal(first.escrow_cents, 61_240n); assert.equal(first.upb_before_cents, 24_977_400n); assert.equal(first.interest_cents, 135_294n);
  // the state the server derives from the rows (rule 4): the ledger's UPB, the tape's P&I, the LPI before the first unpaid row, the partner's custodial accounts
  const before = await loanCashStateFromRows(db, loanId, D("2026-09-03"));
  assert.equal(before.state.upb_cents, 24_977_400n); assert.equal(before.terms.pi_cents, 158_017n); assert.equal(before.state.lpi_date, "2026-08-01"); assert.equal(before.state.late_charge_pct, "5.000"); assert.ok(before.custodial); assert.equal(before.state.installments[0]!.due_date, "2026-09-01"); assert.equal(before.state.installments[0]!.status, "due"); assert.deepEqual(before.state.holds, []);
  // the payments row in `received` for $2,192.57 on 2026-09-03, written through the cash-rows port (a uuid id)
  const paymentId = await writePayment(runtime, loanId, { amount_cents: 219_257n, received_on: D("2026-09-03"), channel: "ach_debit_origin", instrument: "ach", designation: "contractual" });
  assert.match(paymentId, /^[0-9a-f]{8}-/);
  const received = await ports35_5(runtime).cashRows.receivedPayments(loanId); assert.equal(received.length, 1); assert.equal(received[0]!.id, paymentId); assert.equal(received[0]!.data["status"], "received"); assert.equal(received[0]!.data["amount_cents"], "219257");
  assert.ok((await readEvents(db, loanId)).some((e) => e.type === "payment.received" && e.payload["payment_id"] === paymentId));
  // its unit on 2026-09-03 through the bus tool: 2.1 posts interest $1,352.94, principal $227.23, escrow $612.40 with the rule-8 sets; the row is satisfied by the uuid, credited as of the receipt date
  clock.set("2026-09-03T16:00:00.000Z");
  const unit = await runtime.execute({ process: "35.5", name: "cashiering.run_unit", loanId, actor: CASHIERING_AGENT, input: { loan_id: loanId, as_of_date: "2026-09-03" } });
  const out = unit.output as Row; assert.equal(out["outcome"], "done"); assert.deepEqual(out["posted"], [paymentId]); assert.equal(out["local_date"], "2026-09-03"); assert.equal(out["time_zone"], "America/Chicago"); assert.equal(out["interest_variance_cents"], "0");
  const events = await readEvents(db, loanId);
  const posted = events.find((e) => e.type === "payment.posted" && e.payload["payment_id"] === paymentId); assert.ok(posted);
  assert.equal(posted.payload["interest_cents"], "135294"); assert.equal(posted.payload["principal_cents"], "22723"); assert.equal(posted.payload["escrow_cents"], "61240"); assert.equal(posted.payload["upb_after_cents"], "24954677"); assert.deepEqual(posted.payload["installments"], ["2026-09-01"]); assert.equal(posted.payload["credited_as_of"], "2026-09-03"); assert.equal(posted.actor_id, "cashiering");
  assert.equal(135_294n + 22_723n + 61_240n, 219_257n);
  assert.ok(events.some((e) => e.type === "command.executed" && e.payload["command"] === "payments.read/write" && e.actor_id === "cashiering"), "2.1's own command ran in the unit");
  const sets = await db.query<{ id: string; description: string; total: bigint; lines: bigint; r8: boolean }>(`SELECT s.id, s.description, sum(l.amount_cents)::bigint AS total, count(*)::bigint AS lines, bool_and(l.rule_ref LIKE '2.1:r8:%') AS r8 FROM ledger_entry_sets s JOIN ledger_lines l ON l.set_id = s.id WHERE s.description LIKE '%' || $1 GROUP BY s.id, s.description ORDER BY s.description`, [paymentId]);
  assert.equal(sets.length, 3); assert.ok(sets.every((x) => x.total === 0n && x.r8 && x.lines >= 2n), JSON.stringify(sets, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  assert.deepEqual(sets.map((x) => x.description.split(" ")[0]).sort(), ["allocation", "cash", "receipt"]);
  assert.equal(await count(`SELECT count(*)::bigint AS c FROM ledger_lines WHERE set_id = ANY($1::uuid[]) AND (rule_ref IS NULL OR rule_ref NOT LIKE '2.1:r8:%')`, [sets.map((x) => x.id)]), 0n, "rule_ref on every line");
  const row = (await readRows(db, loanId))[0]!; assert.equal(row.due_date, "2026-09-01"); assert.equal(row.status, "satisfied"); assert.equal(row.satisfied_by_payment_id, paymentId); assert.equal(row.credited_as_of, "2026-09-03"); assert.equal(row.interest_cents, 135_294n);
  const satisfiedEvt = events.find((e) => e.type === "installment.satisfied"); assert.ok(satisfiedEvt); assert.equal(satisfiedEvt.payload["due_date"], "2026-09-01"); assert.equal(satisfiedEvt.payload["payment_id"], paymentId); assert.equal(satisfiedEvt.payload["credited_as_of"], "2026-09-03"); assert.equal(satisfiedEvt.payload["interest_variance_cents"], "0");
  assert.equal(await count(`SELECT coalesce(sum(amount_cents), 0)::bigint AS c FROM ledger_lines WHERE scope = 'loan' AND loan_id = $1 AND account = 'principal'`, [loanId]), 24_954_677n);
  const after = await loanCashStateFromRows(db, loanId, D("2026-09-03")); assert.equal(after.state.upb_cents, 24_954_677n); assert.equal(after.state.lpi_date, "2026-09-01"); assert.equal(after.received_payments.length, 0);
  const units = await readUnitRuns(db, loanId); assert.equal(units.length, 1); assert.equal(units[0]!.outcome, "done"); assert.deepEqual(units[0]!.payments_posted, [paymentId]); assert.equal(units[0]!.as_of_date, "2026-09-03"); assert.equal(units[0]!.local_date, "2026-09-03"); assert.ok(units[0]!.decision_id);
  const decision = (await db.query<Row>(`SELECT rule_set_version, action, subject_kind, subject_id FROM agent_decisions WHERE id = $1`, [units[0]!.decision_id]))[0]!;
  assert.equal(decision["rule_set_version"], "cashiering.allocation.v1"); assert.equal(decision["action"], "cashiering.run_unit"); assert.equal(decision["subject_id"], units[0]!.id); assert.equal(unit.decisionId !== undefined, true);
  // the contract (rule 5): the hosted route refuses a caller's own state before any write — 409 NO_CLIENT_STATE over the three state-deriving commands; no event, no line
  const server = createApiServer({ runtime, apiToken: TOKEN, logger: createLogger("json", () => undefined), console: false });
  const base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  try {
    const eventsBefore = await count(`SELECT count(*)::bigint AS c FROM loan_events WHERE loan_id = $1`, [loanId]); const linesBefore = await count(`SELECT count(*)::bigint AS c FROM ledger_lines`); const refusedBefore = await count(`SELECT count(*)::bigint AS c FROM loan_events WHERE type = 'command.refused'`);
    const stateBad = { ...before.state, upb_cents: 1n };
    const calls: [string, string, Record<string, unknown>][] = [["2.1", "payments.read/write", { op: "post", id: paymentId, state: stateBad, custodial: before.custodial }], ["2.7", "fees.assess", { op: "daily_run", state: stateBad, run_on: "2026-09-03" }], ["2.3", "autodraft.read/write", { op: "amount_change_check", id: "E-1", state: stateBad, next_amount_cents: "1", debit_on: "2026-10-01" }]];
    for (const [p, name, input] of calls) {
      const r = await fetch(`${base}/v1/loans/${loanId}/tools/${p}/${encodeURIComponent(name)}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ actor: CASHIERING_AGENT, input }, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)) });
      const body = (await r.json()) as Row;
      assert.equal(r.status, 409, `${p} ${name}: ${JSON.stringify(body)}`); assert.equal(body["error"], "refused"); assert.equal(body["code"], "NO_CLIENT_STATE"); assert.equal(body["command"], name);
    }
    assert.equal(await count(`SELECT count(*)::bigint AS c FROM loan_events WHERE loan_id = $1`, [loanId]), eventsBefore, "refused before any write: no event"); assert.equal(await count(`SELECT count(*)::bigint AS c FROM ledger_lines`), linesBefore); assert.equal(await count(`SELECT count(*)::bigint AS c FROM loan_events WHERE type = 'command.refused'`), refusedBefore, "the bus never ran");
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
test("35.5-T6: Given L-1's row 2026-09-01 unpaid past the 15-day grace (grace end Wed 2026-09-16), when the unit runs on 2026-09-17 in the loan's zone, then 2.7's `daily_run` assesses **$79.01** (`fees{late_charge, assessed_on 2026-09-17, grace_end_on 2026-09-16}`, Dr `late_charges` / Cr `late_charge_income` 7,901), `installment.due_date_reached` was emitted by the unit on 2026-09-01 and not by any borrower flow, and the unit on 2026-09-18 assesses nothing (`late_charge_run = false`).", { skip }, async () => {
  // a fresh L-1 (T5's is paid for September): row 2026-09-01 unpaid, grace 15 → grace end Wed 2026-09-16 (no roll), the assessment on the 17th in the loan's zone (America/Chicago)
  const l1 = await boardTapeLoan(runtime, clock, L1_TAPE, `B-L1-T6-${R}`, D("2026-08-20")); const loanId = l1.loan_id;
  assert.equal(graceEnd(D("2026-09-01"), 15), "2026-09-16");
  const at = (d: string): string => `${d}T16:00:00.000Z`;
  const outcomes: Record<string, Awaited<ReturnType<typeof runCashieringUnit>>> = {};
  for (const d of ["2026-09-01", "2026-09-17", "2026-09-18"]) { clock.set(at(d)); outcomes[d] = await runCashieringUnit(runtime, { loan_id: loanId, as_of_date: D(d), as_of_instant: at(d) }); assert.equal(outcomes[d]!.outcome, "done", `${d}: ${outcomes[d]!.error ?? ""}`); assert.equal(outcomes[d]!.local_date, d); }
  // 2.7's daily_run on 2026-09-17 assessed $79.01 on the P&I basis (2.7 example K): the fee row, its accrual set, the unit that ran it
  const fees = await ports35_5(runtime).cashRows.feesFor(loanId); assert.equal(fees.length, 1); const fee = fees[0]!;
  assert.equal(fee.data["fee_type"], "late_charge"); assert.equal(fee.data["amount_cents"], "7901"); assert.equal(fee.data["assessed_on"], "2026-09-17"); assert.equal(fee.data["grace_end_on"], "2026-09-16"); assert.equal(fee.data["installment_due_date"], "2026-09-01"); assert.equal(fee.data["state"], "assessed"); assert.equal(fee.data["loan_id"], loanId);
  assert.equal(BigInt(String(fee.data["amount_cents"])), 7_901n); assert.equal(lateChargeAmount(158_017n, "5.000", null), 7_901n);
  const accrual = await db.query<{ scope: string; account: string; amount_cents: bigint; rule_ref: string; effective_date: string }>(`SELECT l.scope, l.account, l.amount_cents, l.rule_ref, s.effective_date::text AS effective_date FROM ledger_lines l JOIN ledger_entry_sets s ON s.id = l.set_id WHERE s.description = $1 ORDER BY l.amount_cents DESC`, [`late charge accrual ${fee.id}`]);
  assert.equal(accrual.length, 2);
  assert.deepEqual(accrual.map((l) => ({ scope: l.scope, account: l.account, amount_cents: l.amount_cents, rule_ref: l.rule_ref })), [{ scope: "loan", account: "late_charges", amount_cents: 7_901n, rule_ref: "2.7:r1:accrual" }, { scope: "corporate", account: "late_charge_income", amount_cents: -7_901n, rule_ref: "2.7:r1:accrual" }]);
  assert.equal(accrual[0]!.effective_date, "2026-09-17"); assert.equal(accrual[0]!.amount_cents + accrual[1]!.amount_cents, 0n);
  const events = await readEvents(db, loanId);
  const assessed = events.find((e) => e.type === "fee.assessed"); assert.ok(assessed); assert.equal(assessed.payload["fee_id"] ?? assessed.payload["id"], fee.id);
  // `installment.due_date_reached` was emitted by the unit on 2026-09-01 (the cashiering agent) and by no borrower flow
  const reached = events.filter((e) => e.type === "installment.due_date_reached");
  assert.ok(reached.length >= 1); assert.ok(reached.every((e) => e.actor_id === "cashiering"), "every due-date event is the unit's"); assert.ok(reached.every((e) => e.actor_id !== "borrower-app"));
  assert.equal(reached.filter((e) => e.payload["due_date"] === "2026-09-01").length, 1); assert.equal(reached.find((e) => e.payload["due_date"] === "2026-09-01")!.occurred_at ?? true, true);
  const reachedRow = (await db.query<{ occurred_at: string; grace_end_on: string }>(`SELECT occurred_at::text AS occurred_at, payload->>'grace_end_on' AS grace_end_on FROM loan_events WHERE loan_id = $1 AND type = 'installment.due_date_reached' AND payload->>'due_date' = '2026-09-01'`, [loanId]))[0]!;
  assert.equal(reachedRow.grace_end_on, "2026-09-16"); assert.ok(reachedRow.occurred_at.startsWith("2026-09-01"));
  assert.ok((await db.query<{ status: string }>(`SELECT status::text AS status FROM timers WHERE loan_id = $1 AND code = 'NOTE_6A_LATE_CHARGE_GRACE_GATE'`, [loanId])).length >= 1, "2.7's grace gate armed on the unit's event");
  // the unit rows: the 1st ran 2.7 (due reached), the 17th assessed, the 18th assessed nothing (late_charge_run = false)
  const units = await readUnitRuns(db, loanId); assert.deepEqual(units.map((u) => u.as_of_date), ["2026-09-01", "2026-09-17", "2026-09-18"]);
  const u01 = units[0]!, u17 = units[1]!, u18 = units[2]!;
  assert.equal(u01.late_charge_run, true); assert.equal(u01.due_today, true); assert.deepEqual(u01.late_charge_fee_ids, []);
  assert.equal(u17.late_charge_run, true); assert.equal(u17.grace_ended_yesterday, true); assert.equal(u17.due_today, false); assert.deepEqual(u17.late_charge_fee_ids, [fee.id]); assert.equal(u17.time_zone, "America/Chicago");
  assert.equal(u18.late_charge_run, false); assert.equal(u18.grace_ended_yesterday, false); assert.deepEqual(u18.late_charge_fee_ids, []); assert.equal(outcomes["2026-09-18"]!.late_charge_run, false);
  assert.equal(events.filter((e) => e.type === "command.executed" && e.payload["command"] === "fees.assess").length, 2, "2.7 ran on the 1st and the 17th, not the 18th");
  const state = await loanCashStateFromRows(db, loanId, D("2026-09-18")); assert.equal(state.state.late_charges_due_cents, 7_901n); assert.equal(state.state.fees?.length, 1);
});
test("35.5-T7: Given lockbox `LBX-1` (cut-off 17:00 `America/Chicago`) and the FAKE bank's file for 2026-11-02 with items $2,192.57 (L-1, scanned 09:14), $1,500.00 (no scanline) and $2,308.50 (T-7, scanned 17:42) and control total **$6,001.07**, when `lockbox_ingest` runs, then `lockbox_batches` has one row with `items = 3`, `variance_cents = 0` and `status = posted`, item 1 is a `payments` row (`channel = lockbox`, `received_on` 2026-11-02, `status = identified`), item 2 is a `suspense_items` row (`source = lockbox`) with `lockbox.item.unidentified`, item 3 is a `payments` row with `received_on` 2026-11-03, three receipt sets Dr `clearing_cash` / Cr `suspense_unapplied` exist for 219,257, 150,000 and 230,850, `lockbox.batch.received` armed `FNMA_C1101_LOCKBOX_CLEARING_1BD`, `lockbox.batch.posted{posted: 2, unidentified: 1}` satisfied `SM_LOCKBOX_BATCH_POSTED_1BD`, the same file ingested again writes nothing, and the file with control total $6,000.07 leaves the batch in `variance` with no payment row and an `officer` escalation.", { skip }, async () => {
  // L-1 (boarded 2026-08-20) and T-7 (boarded 2026-10-16) through the transfer route; the partner's clearing / pi / ti accounts (seedCustodial is idempotent); the lockbox's channel row is 0143's (cut-off 17:00 America/Chicago)
  const l1 = await boardTapeLoan(runtime, clock, L1_TAPE, `B-L1-T7-${R}`, D("2026-08-20")); const t7 = await boardTapeLoan(runtime, clock, T7_TAPE, `B-T7-T7-${R}`, D("2026-10-16"));
  const custodial = await seedCustodial(db, await partnerPartyOf(db));
  const number = async (id: string): Promise<string> => (await db.query<{ n: string }>(`SELECT servicer_loan_number AS n FROM loans WHERE id = $1`, [id]))[0]!.n;
  const l1No = await number(l1.loan_id); const t7No = await number(t7.loan_id);
  const lockbox = LOCKBOXES["LBX-1"]!; assert.equal(lockbox.cutoff_tz, "America/Chicago"); assert.deepEqual(await lockboxCutoff(db, lockbox), { cutoff_time: "17:00", cutoff_tz: "America/Chicago" });
  // the FAKE bank's file for 2026-11-02: three items scanned at Chicago wall-clock times (DST ended 2026-11-01 — the instants are computed, not offsets); T-7's item is P&I $1,896.20 + escrow $412.30
  const items = [
    { item_no: 1, scanline: l1No, amount_cents: 219_257n, check_no: "1001", payer: "FAKE PAYER ONE", scanned_at: chicagoInstant(D("2026-11-02"), "09:14") },
    { item_no: 2, scanline: "", amount_cents: 150_000n, check_no: "2002", payer: "FAKE PAYER TWO", scanned_at: chicagoInstant(D("2026-11-02"), "10:00") },
    { item_no: 3, scanline: t7No, amount_cents: 230_850n, check_no: "3003", payer: "FAKE PAYER THREE", scanned_at: chicagoInstant(D("2026-11-02"), "17:42") },
  ];
  assert.equal(wallClock(Date.parse(items[0]!.scanned_at), "America/Chicago").hour, 9); assert.equal(wallClock(Date.parse(items[2]!.scanned_at), "America/Chicago").hour, 17); assert.equal(wallClock(Date.parse(items[2]!.scanned_at), "America/Chicago").minute, 42);
  assert.equal(219_257n + 150_000n + 230_850n, 600_107n); assert.equal(189_620n + 41_230n, 230_850n);
  const content = encodeRemittance({ lockbox_id: "LBX-1", file_date: "2026-11-02", items, control_total_cents: 600_107n });
  const parsed = parseRemittance(content); assert.equal(parsed.control_total_cents, 600_107n); assert.equal(parsed.items.length, 3); assert.equal(parsed.file_date, "2026-11-02"); assert.equal(parsed.items[2]!.amount_cents, 230_850n);
  assert.equal(receivedOnFor(items[0]!.scanned_at, D("2026-11-02"), "17:00", "America/Chicago").after_cutoff, false); assert.deepEqual(receivedOnFor(items[2]!.scanned_at, D("2026-11-02"), "17:00", "America/Chicago"), { received_on: "2026-11-03", after_cutoff: true });
  // the file arrives on the FAKE bank's queue (one shared FAKE per database: a documents row) and `lockbox.ingest` runs through the bus as the cashiering agent
  clock.set("2026-11-02T23:55:00.000Z");
  const q1 = await PgFakeLockboxQueue.post(db, { lockbox_id: "LBX-1", file_name: "LBX1-20261102.txt", content, received_at: "2026-11-02T23:55:00.000Z" });
  assert.equal(q1.sha256, remittanceSha256(content));
  const ingest = () => runtime.execute({ process: "35.5", name: "lockbox.ingest", loanId: "", actor: CASHIERING_AGENT, input: { lockbox_id: "LBX-1", as_of_date: "2026-11-02" } });
  const r1 = await ingest();
  const o1 = r1.output as { files: number; batches: Row[]; posted: number; unidentified: number; variance: number; run_id: string };
  assert.equal(o1.files, 1); assert.equal(o1.batches.length, 1); assert.equal(o1.posted, 2); assert.equal(o1.unidentified, 1); assert.equal(o1.variance, 0); assert.equal(o1.batches[0]!["status"], "posted");
  // one lockbox_batches row: items 3, control total 600,107, variance 0, posted, 2 identified + 1 unidentified, the stored file (documents, same sha256, staged for 35.2's WORM store)
  const batches = await readBatches(db, q1.sha256); assert.equal(batches.length, 1); const batch = batches[0]!;
  assert.equal(o1.batches[0]!["batch_id"], batch.id); assert.equal(batch.lockbox_id, "LBX-1"); assert.equal(batch.file_name, "LBX1-20261102.txt");
  assert.equal(batch.items, 3); assert.equal(batch.control_total_cents, 600_107n); assert.equal(batch.variance_cents, 0n); assert.equal(batch.status, "posted"); assert.equal(batch.items_identified, 2); assert.equal(batch.items_unidentified, 1); assert.equal(batch.items_rejected, 0);
  assert.equal(batch.receipt_date, "2026-11-02"); assert.equal(batch.cutoff_tz, "America/Chicago"); assert.ok(batch.posted_at); assert.ok(batch.document_id);
  const doc = (await db.query<Row>(`SELECT sha256, storage_uri, kind, metadata FROM documents WHERE id = $1`, [batch.document_id]))[0]!;
  assert.equal(doc["sha256"], q1.sha256); assert.ok(String(doc["storage_uri"]).startsWith("worm_pending:")); assert.equal((doc["metadata"] as Row)["batch_id"], batch.id); assert.equal((doc["metadata"] as Row)["storage_status"], "staged");
  assert.equal(((await db.query<Row>(`SELECT metadata FROM documents WHERE id = $1`, [q1.document_id]))[0]!["metadata"] as Row)["status"], "ingested");
  const its = await readItems(db, batch.id); assert.equal(its.length, 3); const [i1, i2, i3] = its as [ItemRead, ItemRead, ItemRead];
  const cash = ports35_5(runtime).cashRows;
  // item 1: L-1's scanline, scanned 09:14 → received_on 2026-11-02; a payments row on L-1: channel lockbox, instrument check, status identified, credited as of receipt, 2.1's idempotency key
  assert.equal(i1.item_no, 1); assert.equal(i1.amount_cents, 219_257n); assert.equal(i1.received_on, "2026-11-02"); assert.equal(i1.after_cutoff, false); assert.equal(i1.match_method, "scanline"); assert.equal(i1.disposition, "identified"); assert.equal(i1.matched_loan_id, l1.loan_id); assert.equal(i1.loan_number_read, l1No); assert.ok(i1.payment_id); assert.equal(i1.suspense_item_id, null); assert.equal(i1.payer_name, "FAKE PAYER ONE"); assert.equal(i1.check_number, "1001");
  const p1 = await cash.paymentById(l1.loan_id, i1.payment_id!); assert.ok(p1, "item 1 is a payments row on L-1");
  assert.equal(p1.data["channel"], "lockbox"); assert.equal(p1.data["status"], "identified"); assert.equal(p1.data["received_on"], "2026-11-02"); assert.equal(p1.data["credited_as_of"], "2026-11-02"); assert.equal(p1.data["amount_cents"], "219257"); assert.equal(p1.data["instrument"], "check"); assert.equal(p1.data["designation"], "contractual");
  assert.equal(p1.data["source_batch_id"], batch.id); assert.equal(p1.data["source_item_id"], "1"); assert.equal(p1.data["check_number"], "1001"); assert.equal(p1.data["idempotency_key"], itemIdempotencyKey(batch.id, 1, 219_257n, D("2026-11-02"))); assert.equal(p1.data["match_method"], "scanline");
  assert.ok((await cash.receivedPayments(l1.loan_id)).some((p) => p.id === i1.payment_id), "the loan's next unit posts it");
  const l1Events = await readEvents(db, l1.loan_id);
  const rec1 = l1Events.find((e) => e.type === "payment.received" && e.payload["payment_id"] === i1.payment_id); assert.ok(rec1); assert.equal(rec1.payload["channel"], "lockbox"); assert.equal(rec1.payload["source_batch_id"], batch.id);
  const ident1 = l1Events.find((e) => e.type === "lockbox.item.identified"); assert.ok(ident1);
  assert.equal(ident1.payload["batch_id"], batch.id); assert.equal(ident1.payload["item_no"], 1); assert.equal(ident1.payload["loan_id"], l1.loan_id); assert.equal(ident1.payload["payment_id"], i1.payment_id); assert.equal(ident1.payload["match_method"], "scanline"); assert.equal(ident1.actor_id, "cashiering");
  // item 2: no readable scanline, coupon OCR (2.1's lockbox.image_ocr, in-process) finds no loan → 6.5's suspense item (source lockbox, reason unidentified_loan, keyed by the clearing account) and lockbox.item.unidentified
  assert.equal(i2.item_no, 2); assert.equal(i2.amount_cents, 150_000n); assert.equal(i2.disposition, "unidentified"); assert.equal(i2.match_method, "none"); assert.equal(i2.matched_loan_id, null); assert.equal(i2.payment_id, null); assert.ok(i2.suspense_item_id); assert.equal(i2.received_on, "2026-11-02"); assert.equal(i2.after_cutoff, false);
  const sus = await cash.suspenseItemById(i2.suspense_item_id!); assert.ok(sus, "item 2 is a suspense_items row");
  assert.equal(sus.data["source"], "lockbox"); assert.equal(sus.data["reason_code"], "unidentified_loan"); assert.equal(sus.data["amount_cents"], "150000"); assert.equal(sus.data["status"], "open"); assert.equal(sus.data["loan_id"], null); assert.equal(sus.data["batch_id"], batch.id); assert.equal(sus.data["item_no"], 2); assert.equal(sus.data["received_on"], "2026-11-02"); assert.equal(sus.data["custodial_account_id"], custodial.clearing);
  const unidentifiedEvents = await readEventsOfType(db, "lockbox.item.unidentified"); const u2 = unidentifiedEvents.find((e) => e.payload["batch_id"] === batch.id); assert.ok(u2);
  assert.equal(u2.payload["item_no"], 2); assert.equal(u2.payload["suspense_item_id"], i2.suspense_item_id); assert.equal(u2.payload["amount_cents"], "150000"); assert.equal(u2.aggregate_kind, "lockbox_batch"); assert.equal(u2.aggregate_id, batch.id); assert.equal(u2.loan_id, null); assert.equal(u2.actor_id, "cashiering");
  assert.ok((await readEventsOfType(db, "command.executed")).some((e) => e.payload["command"] === "lockbox.image_ocr" && e.payload["process"] === "2.1" && e.loan_id === null), "coupon OCR ran through 2.1's own read tool");
  // item 3: T-7's scanline, scanned 17:42 — after the 17:00 cut-off → received_on the next servicer business day, Tue 2026-11-03; identified, a payments row credited as of the 3rd
  assert.equal(i3.item_no, 3); assert.equal(i3.amount_cents, 230_850n); assert.equal(i3.after_cutoff, true); assert.equal(i3.received_on, "2026-11-03"); assert.equal(i3.disposition, "identified"); assert.equal(i3.match_method, "scanline"); assert.equal(i3.matched_loan_id, t7.loan_id); assert.ok(i3.payment_id);
  const p3 = await cash.paymentById(t7.loan_id, i3.payment_id!); assert.ok(p3, "item 3 is a payments row on T-7");
  assert.equal(p3.data["received_on"], "2026-11-03"); assert.equal(p3.data["credited_as_of"], "2026-11-03"); assert.equal(p3.data["status"], "identified"); assert.equal(p3.data["channel"], "lockbox"); assert.equal(p3.data["amount_cents"], "230850"); assert.equal(p3.data["idempotency_key"], itemIdempotencyKey(batch.id, 3, 230_850n, D("2026-11-03")));
  assert.ok((await readEvents(db, t7.loan_id)).some((e) => e.type === "lockbox.item.identified" && e.payload["payment_id"] === i3.payment_id && e.payload["received_on"] === "2026-11-03"));
  // three receipt sets Dr clearing_cash / Cr suspense_unapplied (rule_ref 2.1:r8:receipt on every line), effective on each item's received_on: the loans' suspense for items 1 and 3, 6.5's suspense on the lockbox's clearing account for item 2
  const set1 = await readSet(db, `receipt ${i1.payment_id}`); const set2 = await readSet(db, `receipt lockbox ${batch.id}#2`); const set3 = await readSet(db, `receipt ${i3.payment_id}`);
  const shape = (ls: readonly SetLineRead[]): unknown[] => ls.map((l) => [l.scope, l.account, l.amount_cents, l.rule_ref]);
  assert.deepEqual(shape(set1), [["custodial", "clearing_cash", 219_257n, "2.1:r8:receipt"], ["loan", "suspense_unapplied", -219_257n, "2.1:r8:receipt"]]);
  assert.equal(set1[0]!.custodial_account_id, custodial.clearing); assert.equal(set1[1]!.loan_id, l1.loan_id); assert.equal(set1[0]!.effective_date, "2026-11-02"); assert.equal(set1[0]!.set_id, set1[1]!.set_id);
  assert.deepEqual(shape(set2), [["custodial", "clearing_cash", 150_000n, "2.1:r8:receipt"], ["custodial", "suspense_unapplied", -150_000n, "2.1:r8:receipt"]]);
  assert.equal(set2[0]!.custodial_account_id, custodial.clearing); assert.equal(set2[1]!.custodial_account_id, custodial.clearing); assert.equal(set2[0]!.effective_date, "2026-11-02");
  assert.deepEqual(shape(set3), [["custodial", "clearing_cash", 230_850n, "2.1:r8:receipt"], ["loan", "suspense_unapplied", -230_850n, "2.1:r8:receipt"]]);
  assert.equal(set3[1]!.loan_id, t7.loan_id); assert.equal(set3[0]!.effective_date, "2026-11-03");
  assert.equal(p1.data["receipt_entry_set_id"], set1[0]!.set_id); assert.deepEqual(p1.data["ledger_entry_set_ids"], [set1[0]!.set_id]); assert.equal(sus.data["receipt_entry_set_id"], set2[0]!.set_id); assert.equal(p3.data["receipt_entry_set_id"], set3[0]!.set_id);
  assert.equal(await count(`SELECT coalesce(sum(amount_cents), 0)::bigint AS c FROM ledger_lines WHERE scope = 'loan' AND loan_id = $1 AND account = 'suspense_unapplied'`, [l1.loan_id]), -219_257n, "the credit sits in the loan's suspense until its unit posts it");
  assert.equal(await count(`SELECT coalesce(sum(amount_cents), 0)::bigint AS c FROM ledger_lines WHERE scope = 'custodial' AND custodial_account_id = $1 AND account = 'clearing_cash'`, [custodial.clearing]), 600_107n, "the whole deposit is in clearing");
  // lockbox.batch.received (the batch aggregate, origination context for this section's clocks) armed 2.1's FNMA_C1101_LOCKBOX_CLEARING_1BD on the batch — anchor the receipt date, due the next servicer business day — and 6.1's deposit clock
  const received = (await readEventsOfType(db, "lockbox.batch.received")).find((e) => e.payload["batch_id"] === batch.id); assert.ok(received);
  assert.equal(received.payload["items"], 3); assert.equal(received.payload["control_total_cents"], "600107"); assert.equal(received.payload["receipt_date"], "2026-11-02"); assert.equal(received.payload["lockbox_receipt_date"], "2026-11-02"); assert.equal(received.payload["received_on"], "2026-11-02");
  assert.equal(received.payload["sha256"], q1.sha256); assert.equal(received.payload["lockbox_id"], "LBX-1"); assert.equal(received.payload["origination"], true); assert.equal(received.aggregate_kind, "lockbox_batch"); assert.equal(received.aggregate_id, batch.id); assert.equal(received.actor_id, "cashiering"); assert.equal(received.loan_id, null);
  const clearing = await readSubjectTimer(db, "FNMA_C1101_LOCKBOX_CLEARING_1BD", "lockbox_batch", batch.id);
  assert.equal(clearing.length, 1); assert.equal(clearing[0]!.status, "armed"); assert.equal(clearing[0]!.armed_by_event_id, received.id); assert.equal(clearing[0]!.anchor_date, "2026-11-02"); assert.equal(clearing[0]!.due_date, "2026-11-03");
  assert.equal((await readSubjectTimer(db, "FNMA_C1101_LOCKBOX_CUSTODIAL_2BD", "lockbox_batch", batch.id)).length, 1); assert.equal((await readSubjectTimer(db, "FNMA_C1101_LOCKBOX_DEPOSIT_2BD", "lockbox_batch", batch.id)).length, 1);
  // lockbox.batch.posted{posted: 2, unidentified: 1, rejected: 0} in the same run satisfied SM_LOCKBOX_BATCH_POSTED_1BD (armed by the received event on the batch, anchor 2026-11-02, due +1 servicer BD)
  const postedEvt = (await readEventsOfType(db, "lockbox.batch.posted")).find((e) => e.payload["batch_id"] === batch.id); assert.ok(postedEvt);
  assert.equal(postedEvt.payload["posted"], 2); assert.equal(postedEvt.payload["unidentified"], 1); assert.equal(postedEvt.payload["rejected"], 0); assert.ok(postedEvt.sequence > received.sequence); assert.equal(postedEvt.aggregate_id, batch.id); assert.deepEqual(postedEvt.payload["payment_ids"], [i1.payment_id, i3.payment_id]); assert.deepEqual(postedEvt.payload["suspense_item_ids"], [i2.suspense_item_id]);
  const postedClock = await readSubjectTimer(db, "SM_LOCKBOX_BATCH_POSTED_1BD", "lockbox_batch", batch.id);
  assert.equal(postedClock.length, 1); assert.equal(postedClock[0]!.status, "satisfied"); assert.equal(postedClock[0]!.armed_by_event_id, received.id); assert.equal(postedClock[0]!.satisfied_by_event_id, postedEvt.id); assert.equal(postedClock[0]!.anchor_date, "2026-11-02"); assert.equal(postedClock[0]!.due_date, "2026-11-03");
  // the global recurring SM_LOCKBOX_FILE_EXPECTED_1BD is armed by this process's own receipt (anchor the receipt date, due the next servicer business day)
  const expected1 = await readGlobalTimer(db, "SM_LOCKBOX_FILE_EXPECTED_1BD"); const armedExpected = expected1.filter((t) => t.status === "armed");
  assert.equal(armedExpected.length, 1); assert.equal(armedExpected[0]!.anchor_date, "2026-11-02"); assert.equal(armedExpected[0]!.due_date, "2026-11-03"); assert.equal(armedExpected[0]!.armed_by_event_id, received.id); assert.equal(armedExpected[0]!.subject_id, "*");
  // the decision (the bus's): rule set cashiering.allocation.v1, subject the batch; the run's receipt in 35.3's spelling
  assert.equal(r1.decisions.length, 1, "one decision per ingest run");
  const d1 = (await db.query<Row>(`SELECT rule_set_version, action, subject_kind, subject_id, rule_code, rationale FROM agent_decisions WHERE id = $1`, [r1.decisions[0]!.id]))[0]!;
  assert.equal(d1["rule_set_version"], "cashiering.allocation.v1"); assert.equal(d1["action"], "lockbox.ingest"); assert.equal(d1["subject_kind"], "lockbox_batch"); assert.equal(d1["subject_id"], batch.id); assert.equal(d1["rule_code"], null); assert.ok(String(d1["rationale"]).includes("posted: 2 to payments, 1 to 6.5 suspense"));
  assert.ok((await readEventsOfType(db, "lockbox.ingest.run_completed")).some((e) => e.payload["lockbox_id"] === "LBX-1" && e.payload["as_of_date"] === "2026-11-02" && e.payload["run_id"] === o1.run_id && (e.payload["batches"] as string[]).includes(batch.id) && e.payload["posted"] === 2 && e.payload["origination"] === true));
  // the same file ingested again (the same bytes, a second queue delivery) writes nothing — no batch, item, payment, suspense item, ledger line, lockbox event, timer or escalation — and its decision names the first batch
  const snapshot = async () => ({ batches: await count(`SELECT count(*)::bigint AS c FROM lockbox_batches`), items: await count(`SELECT count(*)::bigint AS c FROM lockbox_items`), lines: await count(`SELECT count(*)::bigint AS c FROM ledger_lines`), cash: await count(`SELECT count(*)::bigint AS c FROM entity_records WHERE kind IN ('payments', 'suspense_items')`), lockboxEvents: await count(`SELECT count(*)::bigint AS c FROM loan_events WHERE type LIKE 'lockbox.batch.%' OR type LIKE 'lockbox.item.%' OR type = 'payment.received'`), timers: await count(`SELECT count(*)::bigint AS c FROM timers`), escalations: await count(`SELECT count(*)::bigint AS c FROM escalations`), documents: await count(`SELECT count(*)::bigint AS c FROM documents WHERE storage_uri LIKE 'worm_pending:%'`) });
  const before = await snapshot();
  clock.set("2026-11-03T00:10:00.000Z");
  const q2 = await PgFakeLockboxQueue.post(db, { lockbox_id: "LBX-1", file_name: "LBX1-20261102-resend.txt", content, received_at: "2026-11-03T00:10:00.000Z" }); assert.equal(q2.sha256, q1.sha256);
  const r2 = await ingest();
  const o2 = r2.output as { files: number; batches: Row[]; duplicates: string[]; posted: number; unidentified: number };
  assert.equal(o2.files, 1); assert.equal(o2.batches.length, 1); assert.equal(o2.batches[0]!["status"], "duplicate"); assert.equal(o2.batches[0]!["duplicate_of"], batch.id); assert.deepEqual(o2.duplicates, [batch.id]); assert.equal(o2.posted, 0); assert.equal(o2.unidentified, 0);
  assert.deepEqual(await snapshot(), before, "the same file again writes nothing");
  assert.equal(r2.decisions.length, 1, "one decision per ingest run"); const d2 = (await db.query<Row>(`SELECT rule_code, subject_id, rationale FROM agent_decisions WHERE id = $1`, [r2.decisions[0]!.id]))[0]!;
  assert.equal(d2["rule_code"], "DUPLICATE_FILE"); assert.equal(d2["subject_id"], batch.id); assert.ok(String(d2["rationale"]).includes(`duplicate of batch ${batch.id}`), String(d2["rationale"]));
  assert.equal(((await db.query<Row>(`SELECT metadata FROM documents WHERE id = $1`, [q2.document_id]))[0]!["metadata"] as Row)["status"], "duplicate");
  // the file with control total $6,000.07 (different bytes): Σ items 600,107 ≠ 600,007 → a second batch in variance ($1.00), nothing posted — no payment or suspense row, no ledger line — one officer escalation (CONTROL_TOTAL_MATCH); the deposit and posting clocks arm (the checks are in the bank), no lockbox.batch.posted
  const varianceContent = encodeRemittance({ lockbox_id: "LBX-1", file_date: "2026-11-02", items, control_total_cents: 600_007n });
  assert.notEqual(remittanceSha256(varianceContent), q1.sha256); assert.equal(parseRemittance(varianceContent).control_total_cents, 600_007n); assert.equal(600_107n - 600_007n, 100n);
  const paymentsBefore = await count(`SELECT count(*)::bigint AS c FROM entity_records WHERE kind = 'payments'`); const suspenseBefore = await count(`SELECT count(*)::bigint AS c FROM entity_records WHERE kind = 'suspense_items'`); const linesBefore = await count(`SELECT count(*)::bigint AS c FROM ledger_lines`);
  const q3 = await PgFakeLockboxQueue.post(db, { lockbox_id: "LBX-1", file_name: "LBX1-20261102-v2.txt", content: varianceContent, received_at: "2026-11-03T00:20:00.000Z" });
  const r3 = await ingest();
  const o3 = r3.output as { batches: Row[]; variance: number; posted: number; unidentified: number };
  assert.equal(o3.variance, 1); assert.equal(o3.posted, 0); assert.equal(o3.unidentified, 0); assert.equal(o3.batches[0]!["status"], "variance"); assert.equal(o3.batches[0]!["variance_cents"], "100"); assert.equal(o3.batches[0]!["control_total_cents"], "600007"); assert.equal(o3.batches[0]!["sum_cents"], "600107");
  const varianceBatch = (await readBatches(db, q3.sha256))[0]!;
  assert.equal(varianceBatch.status, "variance"); assert.equal(varianceBatch.variance_cents, 100n); assert.equal(varianceBatch.control_total_cents, 600_007n); assert.equal(varianceBatch.items, 3); assert.equal(varianceBatch.posted_at, null); assert.notEqual(varianceBatch.id, batch.id);
  const vItems = await readItems(db, varianceBatch.id); assert.equal(vItems.length, 3); assert.ok(vItems.every((it) => it.payment_id === null && it.suspense_item_id === null), "no payment, no suspense item from a batch in variance");
  assert.equal(await count(`SELECT count(*)::bigint AS c FROM entity_records WHERE kind = 'payments'`), paymentsBefore); assert.equal(await count(`SELECT count(*)::bigint AS c FROM entity_records WHERE kind = 'suspense_items'`), suspenseBefore); assert.equal(await count(`SELECT count(*)::bigint AS c FROM ledger_lines`), linesBefore);
  const esc = await db.query<Row>(`SELECT owner_role, kind, status::text AS status, opened_by, payload FROM escalations WHERE payload->>'lockbox_batch_id' = $1`, [varianceBatch.id]);
  assert.equal(esc.length, 1); assert.equal(esc[0]!["owner_role"], "officer"); assert.equal(esc[0]!["kind"], "officer"); assert.equal(esc[0]!["status"], "open"); assert.equal(esc[0]!["opened_by"], "agent:cashiering");
  assert.equal((esc[0]!["payload"] as Row)["rule_code"], "CONTROL_TOTAL_MATCH"); assert.equal((esc[0]!["payload"] as Row)["variance_cents"], "100"); assert.equal((esc[0]!["payload"] as Row)["control_total_cents"], "600007"); assert.equal((esc[0]!["payload"] as Row)["sum_cents"], "600107");
  const vReceived = (await readEventsOfType(db, "lockbox.batch.received")).find((e) => e.payload["batch_id"] === varianceBatch.id); assert.ok(vReceived); assert.equal(vReceived.payload["status"], "variance"); assert.equal(vReceived.payload["variance_cents"], "100");
  assert.ok(!(await readEventsOfType(db, "lockbox.batch.posted")).some((e) => e.payload["batch_id"] === varianceBatch.id), "no lockbox.batch.posted for a batch in variance");
  const vClock = await readSubjectTimer(db, "SM_LOCKBOX_BATCH_POSTED_1BD", "lockbox_batch", varianceBatch.id); assert.equal(vClock.length, 1); assert.equal(vClock[0]!.status, "armed"); assert.equal(vClock[0]!.due_date, "2026-11-03");
  assert.equal(r3.decisions.length, 1, "one decision per ingest run"); const d3 = (await db.query<Row>(`SELECT rule_code, subject_id, rule_set_version FROM agent_decisions WHERE id = $1`, [r3.decisions[0]!.id]))[0]!;
  assert.equal(d3["rule_code"], "CONTROL_TOTAL_MATCH"); assert.equal(d3["subject_id"], varianceBatch.id); assert.equal(d3["rule_set_version"], "cashiering.allocation.v1");
  // the recurring global clock: the second receipt satisfied the first instance and re-armed one (never two armed)
  const expected2 = await readGlobalTimer(db, "SM_LOCKBOX_FILE_EXPECTED_1BD");
  assert.equal(expected2.filter((t) => t.status === "armed").length, 1); assert.equal(expected2.find((t) => t.id === armedExpected[0]!.id)!.status, "satisfied"); assert.equal(expected2.find((t) => t.id === armedExpected[0]!.id)!.satisfied_by_event_id, vReceived.id);
  // the tables hold the money line without the tools: an amount on an item is frozen (NO_MONEY_FIELD), a batch is never deleted
  await assert.rejects(db.query(`UPDATE lockbox_items SET amount_cents = amount_cents + 1 WHERE id = $1`, [i1.id]), /NO_MONEY_FIELD/);
  await assert.rejects(db.query(`DELETE FROM lockbox_batches WHERE id = $1`, [varianceBatch.id]), /append-only/);
  // worked example E's units: "L-1's unit on 2026-11-02 posts item 1" — 2.1 reuses the receipt set the ingest posted on received_on (credit as of receipt: one receipt set, never a
  // second) and the credit already in the loan's suspense is the payment itself, not accumulated suspense (2.1 rule 3's pool) — the check applies once, to L-1's oldest due row
  // (the fixture's L-1 is unpaid since September; T5's figures), and the loan's suspense is back to zero
  const before1 = await loanCashStateFromRows(db, l1.loan_id, D("2026-11-02")); assert.equal(before1.state.suspense_unapplied_cents, 0n, "a pending lockbox receipt is not accumulated suspense"); assert.deepEqual(before1.received_payments.map((p) => p["payment_id"]), [i1.payment_id]);
  const setsBeforeUnit = await count(`SELECT count(*)::bigint AS c FROM ledger_entry_sets`);
  const u1 = await runCashieringUnit(runtime, { loan_id: l1.loan_id, as_of_date: D("2026-11-02"), as_of_instant: "2026-11-03T00:20:00.000Z" });
  assert.equal(u1.outcome, "done", u1.error ?? ""); assert.deepEqual(u1.posted, [i1.payment_id]); assert.equal(u1.local_date, "2026-11-02");
  const posted1 = (await readEvents(db, l1.loan_id)).find((e) => e.type === "payment.posted" && e.payload["payment_id"] === i1.payment_id); assert.ok(posted1);
  assert.deepEqual(posted1.payload["installments"], ["2026-09-01"]); assert.equal(posted1.payload["interest_cents"], "135294"); assert.equal(posted1.payload["principal_cents"], "22723"); assert.equal(posted1.payload["escrow_cents"], "61240"); assert.equal(posted1.payload["rule_path"], "installments.applied:1");
  assert.equal((posted1.payload["ledger_entry_set_ids"] as string[])[0], set1[0]!.set_id); assert.equal((posted1.payload["ledger_entry_set_ids"] as string[]).length, 3);
  assert.equal(await count(`SELECT count(*)::bigint AS c FROM ledger_entry_sets`), setsBeforeUnit + 2n, "allocation and cash split only — the receipt set is the ingest's");
  assert.equal((await readSet(db, `receipt ${i1.payment_id}`)).length, 2, "one receipt set for the item, two lines");
  assert.equal(await count(`SELECT coalesce(sum(amount_cents), 0)::bigint AS c FROM ledger_lines WHERE scope = 'loan' AND loan_id = $1 AND account = 'suspense_unapplied'`, [l1.loan_id]), 0n, "the receipt credit was applied exactly once");
  // a file of only unidentified checks (the ordinary lockbox day) still lands in 6.5's suspense on the lockbox's own clearing account: the partner's when the loans that remit to the
  // lockbox (rule 9 lockbox_id) share one, else the platform servicing party's — this fixture's LBX-1 serves T1's fund-path partner and the transfer partner, so the platform's
  clock.set("2026-11-03T23:55:00.000Z");
  const q4 = await PgFakeLockboxQueue.post(db, { lockbox_id: "LBX-1", file_name: "LBX1-20261103.txt", content: encodeRemittance({ lockbox_id: "LBX-1", file_date: "2026-11-03", items: [{ item_no: 1, scanline: "", amount_cents: 73_100n, check_no: "4004", payer: "FAKE PAYER FOUR", scanned_at: chicagoInstant(D("2026-11-03"), "09:00") }] }), received_at: "2026-11-03T23:55:00.000Z" });
  const r4 = await runtime.execute({ process: "35.5", name: "lockbox.ingest", loanId: "", actor: CASHIERING_AGENT, input: { lockbox_id: "LBX-1", as_of_date: "2026-11-03" } });
  const o4 = r4.output as { posted: number; unidentified: number; variance: number }; assert.equal(o4.unidentified, 1); assert.equal(o4.posted, 0); assert.equal(o4.variance, 0);
  const batch4 = (await readBatches(db, q4.sha256))[0]!; assert.equal(batch4.status, "posted"); assert.equal(batch4.items_unidentified, 1); const i4 = (await readItems(db, batch4.id))[0]!; assert.equal(i4.disposition, "unidentified"); assert.ok(i4.suspense_item_id);
  const platformClearing = (await db.query<{ id: string }>(`SELECT a.id FROM custodial_accounts a JOIN parties p ON p.id = a.partner_party_id WHERE p.party_type = 'servicer' AND p.legal_name = 'Supermortgage LLC' AND p.servicer_number IS NULL AND a.kind = 'clearing' ORDER BY a.created_at LIMIT 1`))[0]?.id;
  assert.ok(platformClearing, "the platform servicing party's clearing account (opened on first use, the transfers.ts custodialAccount precedent)"); assert.notEqual(platformClearing, custodial.clearing);
  const sus4 = await cash.suspenseItemById(i4.suspense_item_id!); assert.ok(sus4); assert.equal(sus4.data["custodial_account_id"], platformClearing); assert.equal(sus4.data["source"], "lockbox");
  const set4 = await readSet(db, `receipt lockbox ${batch4.id}#1`);
  assert.deepEqual(shape(set4), [["custodial", "clearing_cash", 73_100n, "2.1:r8:receipt"], ["custodial", "suspense_unapplied", -73_100n, "2.1:r8:receipt"]]); assert.equal(set4[0]!.custodial_account_id, platformClearing); assert.equal(set4[1]!.custodial_account_id, platformClearing);
  assert.ok((await readEventsOfType(db, "lockbox.batch.posted")).some((e) => e.payload["batch_id"] === batch4.id && e.payload["posted"] === 0 && e.payload["unidentified"] === 1));
  // "T-7's unit on 2026-11-03 posts item 3 against its 2026-11-01 row (the first row of example B: interest $1,519.15, principal $377.05, escrow $412.30)"
  const u3 = await runCashieringUnit(runtime, { loan_id: t7.loan_id, as_of_date: D("2026-11-03"), as_of_instant: "2026-11-03T23:55:00.000Z" });
  assert.equal(u3.outcome, "done", u3.error ?? ""); assert.deepEqual(u3.posted, [i3.payment_id]);
  const posted3 = (await readEvents(db, t7.loan_id)).find((e) => e.type === "payment.posted" && e.payload["payment_id"] === i3.payment_id); assert.ok(posted3);
  assert.deepEqual(posted3.payload["installments"], ["2026-11-01"]); assert.equal(posted3.payload["interest_cents"], "151915"); assert.equal(posted3.payload["principal_cents"], "37705"); assert.equal(posted3.payload["escrow_cents"], "41230"); assert.equal(posted3.payload["credited_as_of"], "2026-11-03");
  assert.equal((posted3.payload["ledger_entry_set_ids"] as string[])[0], set3[0]!.set_id);
  const row3 = (await db.query<Row>(`SELECT status, satisfied_by_payment_id, credited_as_of::text AS credited_as_of FROM loan_installments WHERE loan_id = $1 AND due_date = '2026-11-01'`, [t7.loan_id]))[0]!; assert.equal(row3["status"], "satisfied"); assert.equal(row3["satisfied_by_payment_id"], i3.payment_id); assert.equal(row3["credited_as_of"], "2026-11-03");
  assert.equal((await db.query<Row>(`SELECT set_id FROM ledger_lines GROUP BY set_id HAVING sum(amount_cents) <> 0`)).length, 0, "every set balanced");
});
test("35.5-T8: Given L-1's active enrollment (draft day = due date, extra principal $100.00, validated) and the demo clock at Tue 2026-09-29 14:00 ET, when `ach_file_build` runs, then one `ach_files` row exists with one `ach_entries` row of **$2,292.57**, `effective_entry_date` 2026-10-01, description \"MORTGAGE PMT\" and `status = transmitted`, the file is a `documents` row with `sha256`, `ach.file.built` satisfied `SM_ACH_FILE_BUILD_1BD`; and given a second enrollment whose amount changed without a sent variable-amount notice and a third whose `validation_status = pending` (WEB), then neither has an entry and the build's decision names `REGE_1005_10D_VARIABLE_AMOUNT_NOTICE_10` and `NACHA_WEB_ACCOUNT_VALIDATION_GATE` as the refusals.", { skip }, async () => {
  // L-1 (worked example D) through the transfer route, September paid by its unit (2.1's example A: LPI 2026-09-01, UPB $249,546.77), a borrower party for 2.3's return notice
  const l1 = await boardTapeLoan(runtime, clock, L1_TAPE, `B-L1-T8-${R}`, D("2026-08-20")); const loanId = l1.loan_id; loans.l1ach = loanId;
  await seedCustodial(db, await partnerPartyOf(db)); await linkBorrowerParty(db, loanId, `l1-ach-${R}@example.test`);
  clock.set("2026-09-03T16:00:00.000Z");
  const sept = await writePayment(runtime, loanId, { amount_cents: 219_257n, received_on: D("2026-09-03"), channel: "ach_debit_origin", instrument: "ach", designation: "contractual" });
  const u0 = await runCashieringUnit(runtime, { loan_id: loanId, as_of_date: D("2026-09-03"), as_of_instant: "2026-09-03T16:00:00.000Z" }); assert.equal(u0.outcome, "done", u0.error ?? ""); assert.deepEqual(u0.posted, [sept]);
  const st0 = await loanCashStateFromRows(db, loanId, D("2026-09-04")); assert.equal(st0.state.upb_cents, 24_954_677n); assert.equal(st0.state.lpi_date, "2026-09-01");
  const rows = await readRows(db, loanId); assert.equal(rows[0]!.due_date, "2026-09-01"); assert.equal(rows[0]!.status, "satisfied"); const octRow = rows[1]!; assert.equal(octRow.due_date, "2026-10-01"); assert.equal(octRow.status, "due"); assert.equal(octRow.pi_cents, 158_017n); assert.equal(octRow.escrow_cents, 61_240n);
  // the enrollment (2.3 example E: draft day = due date, extra principal $100.00, validated) written through 2.3's own tool; 2.3 rule 4's amount over the October row; 2.3 rule 3's settlement date Thu 2026-10-01 = T+2 banking days from Tue 2026-09-29
  const E1 = `E-L1-${R}`;
  await writeEnrollment(loanId, E1, { draft_day: 1, extra_principal_cents: 10_000n, next_draft_on: D("2026-10-01"), last_debit_cents: 229_257n, last4: "1001" });
  const view = enrollmentOf(E1, loanId, await enrollmentRow(loanId, E1)); assert.equal(view.e.status, "active"); assert.equal(view.e.validation_status, "validated"); assert.equal(view.raw_validation_status, "validated_api");
  assert.equal(158_017n + 61_240n, 219_257n); assert.equal(219_257n + 10_000n, 229_257n); assert.equal(view.e.extra_principal_cents, 10_000n);
  assert.equal(draftAmount(view.e, octRow.pi_cents + octRow.escrow_cents, 0n), 229_257n);
  assert.equal(settlementDateFor(D("2026-10-01"), 1, 15, federal), "2026-10-01"); assert.equal(addBusinessDays(D("2026-09-29"), 2, federal), "2026-10-01"); assert.equal(addBusinessDays(D("2026-09-29"), 1, federal), "2026-09-30");
  // the demo clock at Tue 2026-09-29 14:00 ET; `ach.file.build` through the bus as the cashiering agent
  clock.set("2026-09-29T18:00:00.000Z"); assert.equal(wallClock(Date.parse(clock.now()), "America/New_York").hour, 14);
  const filesBefore = (await readAchFiles(db)).length;
  const r1 = await runtime.execute({ process: "35.5", name: "ach.file.build", loanId: "", actor: CASHIERING_AGENT, input: { as_of_date: "2026-09-29" } });
  const o1 = r1.output as BuildReport;
  assert.equal(o1.entries, 1); assert.equal(o1.total_debit_cents, "229257"); assert.ok(o1.file_id); assert.equal(o1.transmitted, true); assert.equal(o1.ack_status, "accepted"); assert.deepEqual(o1.window, { t1: "2026-09-30", t2: "2026-10-01" }); assert.deepEqual(o1.refused, []);
  // one ach_files row: one entry, total debits $2,292.57, transmitted, the hash = sha256 of the stored file's bytes, the file a documents row with the same sha256 (staged for 35.2's WORM store, respa_5y)
  const files = await readAchFiles(db); assert.equal(files.length, filesBefore + 1); const f = files.find((x) => x.id === o1.file_id)!; assert.ok(f);
  assert.equal(f.entry_count, 1); assert.equal(f.total_debit_cents, 229_257n); assert.equal(f.total_credit_cents, 0n); assert.ok(f.transmitted_at); assert.equal(f.ack_status, "accepted"); assert.equal(f.file_id_modifier, "A"); assert.ok(f.document_id);
  const doc = await documentOf(f.document_id!); const bytes = await fileBytes(f.document_id!);
  assert.equal(doc.kind, "ach_file"); assert.equal(doc.retention_class, "respa_5y"); assert.ok(doc.storage_uri.startsWith("worm_pending:")); assert.equal(doc.sha256, f.hash); assert.equal(sha256(bytes), f.hash); assert.equal(o1.sha256, f.hash);
  assert.ok(bytes.split("\n").filter(Boolean).every((line) => line.length === 94), "94-character NACHA records"); assert.ok(bytes.includes("MORTGAGE P"), "the batch header's 10-character company entry description"); assert.ok(bytes.includes("0000229257"));
  // one ach_entries row: $2,292.57, effective 2026-10-01, "MORTGAGE PMT", transmitted, the loan and the enrollment key, a trace number, 2.3's idempotency key
  const entries = await readAchEntries(db, loanId); assert.equal(entries.length, 1); const e = entries[0]!;
  assert.equal(e.amount_cents, 229_257n); assert.equal(e.effective_entry_date, "2026-10-01"); assert.equal(e.company_entry_description, "MORTGAGE PMT"); assert.equal(e.status, "transmitted"); assert.equal(e.loan_id, loanId); assert.equal(e.enrollment_key, E1); assert.equal(e.file_id, f.id);
  assert.equal(e.direction, "debit"); assert.equal(e.sec_code, "WEB"); assert.equal(e.reinitiation_count, 0); assert.equal(e.reinitiation_of_entry_id, null); assert.equal(e.settlement_date, null); assert.match(e.trace_number ?? "", /^\d{15}$/); assert.ok(bytes.includes(e.trace_number!));
  assert.equal(e.idempotency_key, sha256(`${E1}|2026-10-01|229257|0`)); assert.deepEqual(o1.entry_ids, [e.id]);
  // 2.3's own nacha.build_entry ran in the loan's unit of work (GATES_ARE_2_3S): its command.executed and its nacha_entries record
  assert.ok((await eventsOn(loanId, "command.executed")).some((x) => x.payload["command"] === "nacha.build_entry" && x.payload["process"] === "2.3" && x.actor_id === "cashiering"));
  assert.ok((await runtime.entities.load({ loanId })).some((x) => x.kind === "nacha_entries" && x.data["enrollment_id"] === E1 && x.data["settlement_date"] === "2026-10-01" && x.data["amount_cents"] === 229_257n), "2.3's own nacha_entries record (its bigint round-trips through the entity store)");
  // the FAKE ODFI has the file; ach.file.built (global, origination context) armed SM_ACH_FILE_BUILD_1BD — anchor 2026-09-29, due the next banking day at 14:00 ET; ach.file.transmitted followed
  const odfi = runtime.ports.nacha as FakeOdfi; assert.ok([...odfi.files.values()].some((x) => x.fileName === o1.file_name), "FakeOdfi.files has the file");
  const built = (await readEventsOfType(db, "ach.file.built")).find((x) => x.payload["file_id"] === f.id); assert.ok(built);
  assert.equal(built.payload["as_of_date"], "2026-09-29"); assert.equal(built.payload["entries"], 1); assert.equal(built.payload["total_debit_cents"], "229257"); assert.equal(built.payload["sha256"], f.hash); assert.equal(built.payload["origination"], true); assert.equal(built.loan_id, null); assert.equal(built.aggregate_kind, "ach_file"); assert.equal(built.aggregate_id, f.id); assert.equal(built.actor_id, "cashiering"); assert.equal(built.id, o1.built_event_id);
  const transmitted = (await readEventsOfType(db, "ach.file.transmitted")).find((x) => x.payload["file_id"] === f.id); assert.ok(transmitted); assert.equal(transmitted.payload["transmitted_at"], clock.now()); assert.ok(transmitted.sequence > built.sequence);
  const g1 = await readGlobalTimer(db, "SM_ACH_FILE_BUILD_1BD"); const armed1 = g1.filter((t) => t.status === "armed");
  assert.equal(armed1.length, 1); assert.equal(armed1[0]!.armed_by_event_id, built.id); assert.equal(armed1[0]!.anchor_date, "2026-09-29"); assert.equal(armed1[0]!.due_date, "2026-09-30"); assert.equal(armed1[0]!.subject_id, "*");
  const dueAt = (await db.query<{ due_at: string }>(`SELECT due_at::text AS due_at FROM timers WHERE id = $1`, [armed1[0]!.id]))[0]!.due_at; assert.ok(dueAt.startsWith("2026-09-30 18:00"), `14:00 ET on the next banking day: ${dueAt}`);
  // the receipt (35.3's spelling) and the bus's decision: rule set cashiering.returns.v1, subject the file
  assert.ok((await readEventsOfType(db, "ach.file_build.run_completed")).some((x) => x.payload["as_of_date"] === "2026-09-29" && x.payload["file_id"] === f.id && x.payload["run_id"] === o1.run_id && x.payload["origination"] === true));
  assert.equal(r1.decisions.length, 1); const d1 = (await db.query<Row>(`SELECT rule_set_version, action, subject_kind, subject_id, rule_code FROM agent_decisions WHERE id = $1`, [r1.decisions[0]!.id]))[0]!;
  assert.equal(d1["rule_set_version"], "cashiering.returns.v1"); assert.equal(d1["action"], "ach.file.build"); assert.equal(d1["subject_kind"], "ach_file"); assert.equal(d1["subject_id"], f.id); assert.equal(d1["rule_code"], null);
  // a second enrollment whose amount changed without a sent variable-amount notice (E-2: the last debit was $2,192.57, the draft $2,292.57, no notice) and a third whose validation is pending (E-3, WEB): neither has an entry; the decision names 2.3's gates
  const E2 = `E-2-${R}`; const E3 = `E-3-${R}`;
  await writeEnrollment(loanId, E2, { draft_day: 1, extra_principal_cents: 10_000n, next_draft_on: D("2026-10-01"), last_debit_cents: 219_257n, last4: "2002" });
  await writeEnrollment(loanId, E3, { draft_day: 1, extra_principal_cents: 0n, next_draft_on: D("2026-10-01"), last_debit_cents: null, validation_status: "pending", sec: "WEB", last4: "3003" });
  const entriesBefore = await count(`SELECT count(*)::bigint AS c FROM ach_entries`); const linesBefore = await count(`SELECT count(*)::bigint AS c FROM ledger_lines`);
  const r2 = await runtime.execute({ process: "35.5", name: "ach.file.build", loanId: "", actor: CASHIERING_AGENT, input: { as_of_date: "2026-09-29" } });
  const o2 = r2.output as BuildReport;
  assert.equal(o2.entries, 0); assert.equal(o2.file_id, null); assert.equal(o2.transmitted, false);
  const byE = new Map(o2.refused.map((x) => [x.enrollment_id, x])); assert.equal(o2.refused.length, 2);
  assert.equal(byE.get(E2)?.gate, "REGE_1005_10D_VARIABLE_AMOUNT_NOTICE_10"); assert.equal(byE.get(E2)?.code, "TEN_DAY_NOTICE"); assert.equal(byE.get(E3)?.gate, "NACHA_WEB_ACCOUNT_VALIDATION_GATE"); assert.equal(byE.get(E3)?.code, "2.3.accountValidated");
  assert.ok(o2.skipped.some((x) => x.enrollment_id === E1 && x.reason === "already_built" && x.entry_id === e.id), "E-L1's entry is not built twice");
  assert.equal(await count(`SELECT count(*)::bigint AS c FROM ach_entries`), entriesBefore); assert.equal((await readAchFiles(db)).length, files.length, "no empty file"); assert.equal(await count(`SELECT count(*)::bigint AS c FROM ledger_lines`), linesBefore);
  assert.equal(await count(`SELECT count(*)::bigint AS c FROM ach_entries WHERE enrollment_key = ANY($1::text[])`, [[E2, E3]]), 0n);
  assert.equal(r2.decisions.length, 1); const d2 = (await db.query<Row>(`SELECT rationale, rule_code, rule_set_version, subject_kind FROM agent_decisions WHERE id = $1`, [r2.decisions[0]!.id]))[0]!;
  assert.ok(String(d2["rationale"]).includes("REGE_1005_10D_VARIABLE_AMOUNT_NOTICE_10") && String(d2["rationale"]).includes(E2), String(d2["rationale"])); assert.ok(String(d2["rationale"]).includes("NACHA_WEB_ACCOUNT_VALIDATION_GATE") && String(d2["rationale"]).includes(E3));
  assert.equal(d2["rule_code"], "GATES_ARE_2_3S"); assert.equal(d2["rule_set_version"], "cashiering.returns.v1"); assert.equal(d2["subject_kind"], "cycle_run");
  // the day's second `ach.file.built{entries: 0}` satisfied the first instance and re-armed the recurring clock (one armed at a time)
  const g2 = await readGlobalTimer(db, "SM_ACH_FILE_BUILD_1BD");
  assert.equal(g2.filter((t) => t.status === "armed").length, 1); assert.equal(g2.find((t) => t.id === armed1[0]!.id)!.status, "satisfied"); assert.equal(g2.find((t) => t.id === armed1[0]!.id)!.satisfied_by_event_id, o2.built_event_id);
  assert.ok(o2.built_event_id);
});
test("35.5-T9: Given the entry of T8 settled 2026-10-01 and posted by L-1's unit (interest **$1,351.71**, principal **$228.46**, escrow **$612.40**, curtailment **$100.00**, row 2026-10-01 `satisfied`), when the FAKE ODFI's return file for Mon 2026-10-05 carries R01 on its trace number and `ach_returns_ingest` runs, then `ach_return_files` has one row, `ach.return.received{code: R01}` and a `payment_reversals` row (`reason = returned_item`, `return_code = R01`) exist with the mirror set for $2,292.57, row 2026-10-01 is `due` again with `installment.restored`, UPB and LPI are back to $249,546.77 and 2026-09-01, a `fees{nsf_fee}` row of **$25.00** exists, a reinitiation `ach_entries` row of **$2,292.57** with description \"RETRY PYMT\", `effective_entry_date` Thu 2026-10-08 and `reinitiation_count = 1` exists, `ach.return.actioned{action: reversed_reinitiated}` satisfied `SM_ACH_RETURN_ACTIONED_1BD`, and the same return file ingested again writes nothing.", { skip }, async () => {
  const loanId = loans.l1ach; assert.ok(loanId, "T8's L-1"); const cash = ports35_5(runtime).cashRows;
  const entry = (await readAchEntries(db, loanId))[0]!; assert.equal(entry.status, "transmitted"); const E1 = entry.enrollment_key!;
  // the FAKE ODFI's settlement feed at the start of `ach_returns_ingest` on Thu 2026-10-01: the entry settles on its effective entry date → `ach.entry.settled`, a `payments` row in `received` (channel ach_debit_origin, received_on 2026-10-01, the $100.00 curtailment), the enrollment's last debit
  clock.set("2026-10-01T13:00:00.000Z");
  const ing1 = await runtime.execute({ process: "35.5", name: "ach.returns.ingest", loanId: "", actor: CASHIERING_AGENT, input: { as_of_date: "2026-10-01" } });
  const o1 = ing1.output as ReturnsIngestReport; assert.equal(o1.files.length, 0); assert.equal(o1.settled.length, 1); assert.equal(o1.settled[0]!.entry_id, entry.id); assert.equal(o1.settled[0]!.settlement_date, "2026-10-01");
  const settledRow = (await readAchEntries(db, loanId))[0]!; assert.equal(settledRow.status, "settled"); assert.equal(settledRow.settlement_date, "2026-10-01");
  const received = await cash.receivedPayments(loanId); assert.equal(received.length, 1); const p1 = received[0]!; const pid = p1.id; assert.match(pid, /^[0-9a-f]{8}-/);
  assert.equal(p1.data["channel"], "ach_debit_origin"); assert.equal(p1.data["received_on"], "2026-10-01"); assert.equal(p1.data["credited_as_of"], "2026-10-01"); assert.equal(p1.data["status"], "received"); assert.equal(p1.data["amount_cents"], "229257"); assert.equal(p1.data["curtailment_cents"], "10000"); assert.equal(p1.data["designation"], "contractual");
  assert.equal(p1.data["ach_entry_id"], entry.id); assert.equal(p1.data["enrollment_id"], E1); assert.equal(p1.data["autodraft_trace"], entry.trace_number); assert.equal(p1.data["instrument"], "ach");
  const settledEvt = (await eventsOn(loanId, "ach.entry.settled")).find((x) => x.payload["entry_id"] === entry.id); assert.ok(settledEvt); assert.equal(settledEvt.payload["settlement_date"], "2026-10-01"); assert.equal(settledEvt.payload["amount_cents"], "229257"); assert.equal(settledEvt.payload["payment_id"], pid); assert.equal(settledEvt.payload["curtailment_cents"], "10000");
  assert.ok((await eventsOn(loanId, "payment.received")).some((x) => x.payload["payment_id"] === pid && x.payload["channel"] === "ach_debit_origin"));
  const enr1 = await enrollmentRow(loanId, E1); assert.equal(enr1["last_debit_cents"], "229257"); assert.equal(enr1["next_draft_on"], "2026-11-02"); assert.equal(settlementDateFor(D("2026-11-01"), 1, 15, federal), "2026-11-02");
  // L-1's unit on 2026-10-01 posts it: interest $1,351.71 on the UPB as of LPI, principal $228.46, escrow $612.40, curtailment $100.00 (2.4); row 2026-10-01 satisfied; UPB $249,218.31
  const u1 = await runCashieringUnit(runtime, { loan_id: loanId, as_of_date: D("2026-10-01"), as_of_instant: "2026-10-01T16:00:00.000Z" }); assert.equal(u1.outcome, "done", u1.error ?? ""); assert.deepEqual(u1.posted, [pid]);
  const posted = (await eventsOn(loanId, "payment.posted")).find((x) => x.payload["payment_id"] === pid); assert.ok(posted);
  assert.equal(posted.payload["interest_cents"], "135171"); assert.equal(posted.payload["principal_cents"], "22846"); assert.equal(posted.payload["escrow_cents"], "61240"); assert.equal(posted.payload["curtailment_cents"], "10000"); assert.deepEqual(posted.payload["installments"], ["2026-10-01"]); assert.equal(posted.payload["credited_as_of"], "2026-10-01");
  assert.equal(monthlyInterestBps(24_954_677n, 65000), 135_171n); assert.equal(158_017n - 135_171n, 22_846n); assert.equal(135_171n + 22_846n + 61_240n + 10_000n, 229_257n); assert.equal(24_954_677n - 22_846n - 10_000n, 24_921_831n);
  // the loan's UPB after the posting is $249,218.31 (the installment's principal and the curtailment): the ledger and the state the server derives; 2.1's event carries the last applied installment's own upb_after (before the curtailment)
  const stPosted = await loanCashStateFromRows(db, loanId, D("2026-10-02")); assert.equal(stPosted.state.upb_cents, 24_921_831n); assert.equal(stPosted.state.lpi_date, "2026-10-01");
  assert.equal(await count(`SELECT coalesce(sum(amount_cents), 0)::bigint AS c FROM ledger_lines WHERE scope = 'loan' AND loan_id = $1 AND account = 'principal'`, [loanId]), 24_921_831n);
  const octPosted = (await readRows(db, loanId)).find((r) => r.due_date === "2026-10-01")!; assert.equal(octPosted.status, "satisfied"); assert.equal(octPosted.satisfied_by_payment_id, pid); assert.equal(octPosted.credited_as_of, "2026-10-01");
  const originalSets = (await cash.paymentById(loanId, pid))!.data["ledger_entry_set_ids"] as string[]; assert.equal(originalSets.length, 3);
  const originalTotals = await setTotals(originalSets); assert.equal(originalTotals[`loan:principal`], -(22_846n + 10_000n)); assert.equal(originalTotals[`custodial:clearing_cash`], 0n);
  // Mon 2026-10-05: the FAKE ODFI's return file carries R01 on the entry's trace number; `ach_returns_ingest` runs
  const content = fakeReturnFile([{ trace_number: entry.trace_number!, amount_cents: 229_257n, code: "R01", returned_on: D("2026-10-05"), routing: "021000021", account: "FAKE1001", individual_id: "****1001", name: "Ada Fixture" }], D("2026-10-05"));
  assert.ok(content.split("\n").filter(Boolean).every((line) => line.length === 94));
  const q1 = await PgFakeOdfiQueue.postReturns(db, { as_of_date: "2026-10-05", file_name: "RET-20261005.ach", content, received_at: "2026-10-05T12:00:00.000Z" }); assert.equal(q1.sha256, sha256(content));
  clock.set("2026-10-05T13:00:00.000Z");
  const ing2 = await runtime.execute({ process: "35.5", name: "ach.returns.ingest", loanId: "", actor: CASHIERING_AGENT, input: { as_of_date: "2026-10-05" } });
  const o2 = ing2.output as ReturnsIngestReport; assert.equal(o2.settled.length, 0); assert.equal(o2.files.length, 1); assert.equal(o2.returns, 1); assert.equal(o2.nocs, 0); assert.equal(o2.actioned, 1); assert.deepEqual(o2.errors, []);
  const fo = o2.files[0]!; assert.equal(fo.status, "processed"); assert.equal(fo.matched, 1); assert.equal(fo.unmatched, 0); assert.equal(fo.items[0]!.action, "reversed_reinitiated"); assert.equal(fo.items[0]!.entry_id, entry.id);
  // one ach_return_files row (sha256 = the file's, the stored document, processed), the ach_returns row, the entry `returned` R01
  const rfiles = await readReturnFiles(db); assert.equal(rfiles.length, 1); const rf = rfiles[0]!;
  assert.equal(rf.id, fo.file_id); assert.equal(rf.as_of_date, "2026-10-05"); assert.equal(rf.returns, 1); assert.equal(rf.nocs, 0); assert.equal(rf.entries_matched, 1); assert.equal(rf.entries_unmatched, 0); assert.equal(rf.sha256, q1.sha256); assert.ok(rf.processed_at); assert.equal(rf.file_name, "RET-20261005.ach");
  const rdoc = await documentOf(rf.document_id!); assert.equal(rdoc.kind, "ach_return_file"); assert.equal(rdoc.sha256, q1.sha256); assert.ok(rdoc.storage_uri.startsWith("worm_pending:")); assert.equal(rdoc.retention_class, "respa_5y");
  const rets = await readAchReturns(db, entry.id); assert.equal(rets.length, 1); assert.equal(rets[0]!.return_code, "R01"); assert.equal(rets[0]!.action_taken, "reversed_reinitiated"); assert.equal((rets[0]!.raw as Row)["original_trace"], entry.trace_number);
  const returnedRow = (await readAchEntries(db, loanId)).find((x) => x.id === entry.id)!; assert.equal(returnedRow.status, "returned"); assert.equal(returnedRow.return_code, "R01"); assert.ok(returnedRow.returned_at);
  // ach.return.received{code: R01} (this process's, with 2.3's fields and the anchor received_on) on the loan; ach.return_file.received on the file
  const rec = (await eventsOn(loanId, "ach.return.received")).filter((x) => x.payload["entry_id"] === entry.id && x.payload["received_on"] === "2026-10-05"); assert.equal(rec.length, 1); const recEvt = rec[0]!;
  assert.equal(recEvt.payload["code"], "R01"); assert.equal(recEvt.payload["reason_code"], "R01"); assert.equal(recEvt.payload["R01"], true); assert.equal(recEvt.payload["original_settlement_date"], "2026-10-01"); assert.equal(recEvt.payload["payment_id"], pid); assert.equal(recEvt.payload["origination"], true); assert.equal(recEvt.payload["return_file_id"], rf.id); assert.equal(recEvt.actor_id, "cashiering");
  assert.ok((await readEventsOfType(db, "ach.return_file.received")).some((x) => x.payload["file_id"] === rf.id && x.payload["as_of_date"] === "2026-10-05" && x.payload["returns"] === 1 && x.payload["nocs"] === 0));
  // the reversal (2.1 rule 9 through 2.3's own op=return): payment_reversals through the port — reason returned_item, return_code R01, the three mirror sets negating the original sets per account
  const reversals = await cash.reversalsFor(loanId, pid); assert.equal(reversals.length, 1); assert.equal(reversals[0]!.reason, "returned_item"); assert.equal(reversals[0]!.return_code, "R01"); assert.equal(reversals[0]!.entry_set_ids.length, 3);
  assert.equal((await cash.paymentById(loanId, pid))!.data["status"], "reversed");
  const mirrorTotals = await setTotals(reversals[0]!.entry_set_ids);
  for (const k of new Set([...Object.keys(originalTotals), ...Object.keys(mirrorTotals)])) assert.equal(mirrorTotals[k] ?? 0n, -(originalTotals[k] ?? 0n), `mirror of ${k}`);
  assert.equal(mirrorTotals[`loan:principal`], 22_846n + 10_000n); assert.equal(mirrorTotals[`loan:escrow`], 61_240n); assert.equal(mirrorTotals[`loan:interest_due`], 135_171n);
  assert.equal((await db.query<Row>(`SELECT set_id FROM ledger_lines WHERE set_id = ANY($1::uuid[]) GROUP BY set_id HAVING sum(amount_cents) <> 0`, [reversals[0]!.entry_set_ids])).length, 0, "every mirror set balanced");
  assert.ok((await eventsOn(loanId, "payment.reversed")).some((x) => x.payload["payment_id"] === pid && x.payload["return_code"] === "R01" && x.payload["reason"] === "returned_item"));
  // row 2026-10-01 `due` again with installment.restored; UPB and LPI back to $249,546.77 and 2026-09-01
  const octRestored = (await readRows(db, loanId)).find((r) => r.due_date === "2026-10-01")!; assert.equal(octRestored.status, "due"); assert.equal(octRestored.satisfied_by_payment_id, null); assert.equal(octRestored.credited_as_of, null);
  const restoredEvt = (await eventsOn(loanId, "installment.restored")).find((x) => x.payload["payment_id"] === pid); assert.ok(restoredEvt); assert.equal(restoredEvt.payload["due_date"], "2026-10-01"); assert.equal(restoredEvt.payload["return_code"], "R01");
  const stBack = await loanCashStateFromRows(db, loanId, D("2026-10-06")); assert.equal(stBack.state.upb_cents, 24_954_677n); assert.equal(stBack.state.lpi_date, "2026-09-01");
  assert.equal(await count(`SELECT coalesce(sum(amount_cents), 0)::bigint AS c FROM ledger_lines WHERE scope = 'loan' AND loan_id = $1 AND account = 'principal'`, [loanId]), 24_954_677n);
  // the NSF fee through 2.7 rule 7: $25.00 = min(2,500¢, TX's cap) — L-1's configuration allows it; Dr nsf_fees / Cr nsf_fee_income with rule_ref 2.7:r7:nsf; fee.assessed{nsf_fee}
  const fees = await cash.feesFor(loanId); const nsf = fees.filter((x) => x.data["fee_type"] === "nsf_fee"); assert.equal(nsf.length, 1); const fee = nsf[0]!;
  assert.equal(fee.data["amount_cents"], "2500"); assert.equal(BigInt(String(fee.data["amount_cents"])), 2_500n); assert.equal(fee.data["returned_payment_id"], pid); assert.equal(fee.data["assessed_on"], "2026-10-05"); assert.equal(fee.data["state"], "assessed"); assert.equal(fee.data["loan_id"], loanId);
  assert.equal((await db.query<Row>(`SELECT nsf_fee_allowed FROM loan_servicing_configs WHERE loan_id = $1`, [loanId]))[0]!["nsf_fee_allowed"], true);
  const nsfSet = await db.query<{ scope: string; account: string; amount_cents: bigint; rule_ref: string; effective_date: string }>(`SELECT l.scope::text AS scope, l.account, l.amount_cents, l.rule_ref, s.effective_date::text AS effective_date FROM ledger_lines l JOIN ledger_entry_sets s ON s.id = l.set_id WHERE s.description = $1 ORDER BY l.amount_cents DESC`, [`nsf fee ${fee.id}`]);
  assert.deepEqual(nsfSet.map((l) => [l.scope, l.account, l.amount_cents, l.rule_ref]), [["loan", "nsf_fees", 2_500n, "2.7:r7:nsf"], ["corporate", "nsf_fee_income", -2_500n, "2.7:r7:nsf"]]); assert.equal(nsfSet[0]!.effective_date, "2026-10-05");
  assert.ok((await eventsOn(loanId, "fee.assessed")).some((x) => x.payload["fee_id"] === fee.id && x.payload["fee_type"] === "nsf_fee" && x.payload["return_code"] === "R01"));
  // the reinitiation: $2,292.57 "RETRY PYMT", effective Thu 2026-10-08 (the third banking day after the return's settlement date, ≤ the penalty-free date 2026-10-16), reinitiation_count 1, built and unfiled
  const entriesAfter = await readAchEntries(db, loanId); assert.equal(entriesAfter.length, 2); const retry = entriesAfter.find((x) => x.reinitiation_of_entry_id === entry.id)!; assert.ok(retry);
  assert.equal(retry.amount_cents, 229_257n); assert.equal(retry.company_entry_description, "RETRY PYMT"); assert.equal(retry.effective_entry_date, "2026-10-08"); assert.equal(retry.reinitiation_count, 1); assert.equal(retry.status, "built"); assert.equal(retry.file_id, null); assert.equal(retry.trace_number, null); assert.equal(retry.enrollment_key, E1); assert.equal(retry.sec_code, "WEB");
  assert.equal(addBusinessDays(D("2026-10-05"), 3, federal), "2026-10-08"); assert.ok(D("2026-10-08") <= addDays(D("2026-10-01"), 15)); assert.equal(retry.idempotency_key, sha256(`${E1}|2026-10-08|229257|1`));
  const enr2 = await enrollmentRow(loanId, E1); assert.deepEqual(enr2["reinitiations"], ["2026-10-08"]); assert.equal(enr2["returns_on_current_installment"], 1); assert.equal(enr2["status"], "active");
  assert.ok((await eventsOn(loanId, "ach.entry.reinitiation_scheduled")).some((x) => x.payload["retry_on"] === "2026-10-08" && x.payload["company_entry_description"] === "RETRY PYMT"), "2.3's own reinitiation event");
  // ach.return.actioned{action: reversed_reinitiated} satisfied SM_ACH_RETURN_ACTIONED_1BD (armed by this process's ach.return.received, anchor received_on 2026-10-05, due the next banking day)
  const act = (await eventsOn(loanId, "ach.return.actioned")).filter((x) => x.payload["entry_id"] === entry.id); assert.equal(act.length, 1); const actEvt = act[0]!;
  assert.equal(actEvt.payload["action"], "reversed_reinitiated"); assert.equal(actEvt.payload["code"], "R01"); assert.equal(actEvt.payload["payment_id"], pid); assert.equal(actEvt.payload["nsf_fee_id"], fee.id); assert.equal(actEvt.payload["reinitiation_entry_id"], retry.id); assert.equal(actEvt.payload["retry_on"], "2026-10-08"); assert.equal(actEvt.payload["notice_template"], "AUTODRAFT-RETURN-v1"); assert.ok(actEvt.payload["notice_id"], "2.3's return notice went to the linked borrower");
  const clocks = await readTimer(db, loanId, "SM_ACH_RETURN_ACTIONED_1BD"); assert.equal(clocks.length, 1);
  assert.equal(clocks[0]!.status, "satisfied"); assert.equal(clocks[0]!.armed_by_event_id, recEvt.id); assert.equal(clocks[0]!.satisfied_by_event_id, actEvt.id); assert.equal(clocks[0]!.anchor_date, "2026-10-05"); assert.equal(clocks[0]!.subject_id, loanId);
  assert.equal((await db.query<{ due_date: string }>(`SELECT due_date::text AS due_date FROM timers WHERE id = $1`, [clocks[0]!.id]))[0]!.due_date, "2026-10-06");
  // the decisions: the return's own (cashiering.returns.v1, subject the entry) and the run's (the bus's)
  const dAct = await db.query<Row>(`SELECT rule_set_version, subject_kind, subject_id, rationale FROM agent_decisions WHERE loan_id = $1 AND action = 'ach.return.action'`, [loanId]); assert.equal(dAct.length, 1);
  assert.equal(dAct[0]!["rule_set_version"], "cashiering.returns.v1"); assert.equal(dAct[0]!["subject_kind"], "ach_entry"); assert.equal(dAct[0]!["subject_id"], entry.id); assert.ok(String(dAct[0]!["rationale"]).includes("reversed_reinitiated"));
  assert.equal(ing2.decisions.length, 1); const dRun = (await db.query<Row>(`SELECT rule_set_version, action, subject_kind, subject_id FROM agent_decisions WHERE id = $1`, [ing2.decisions[0]!.id]))[0]!; assert.equal(dRun["rule_set_version"], "cashiering.returns.v1"); assert.equal(dRun["action"], "ach.returns.ingest"); assert.equal(dRun["subject_kind"], "ach_return_file"); assert.equal(dRun["subject_id"], rf.id);
  assert.ok((await readEventsOfType(db, "ach.returns_ingest.run_completed")).some((x) => x.payload["as_of_date"] === "2026-10-05" && x.payload["returns"] === 1 && x.payload["actioned"] === 1 && x.payload["origination"] === true));
  // the same return file ingested again writes nothing: no return file, return, entry, fee, ledger line, loan event or clock — the decision names the first file
  const snapshot = async () => ({ files: await count(`SELECT count(*)::bigint AS c FROM ach_return_files`), returns: await count(`SELECT count(*)::bigint AS c FROM ach_returns`), entries: await count(`SELECT count(*)::bigint AS c FROM ach_entries`), lines: await count(`SELECT count(*)::bigint AS c FROM ledger_lines`), cash: await count(`SELECT count(*)::bigint AS c FROM entity_records WHERE kind IN ('payments', 'fees', 'autodraft_enrollments')`), loanEvents: await count(`SELECT count(*)::bigint AS c FROM loan_events WHERE loan_id = $1`, [loanId]), achEvents: await count(`SELECT count(*)::bigint AS c FROM loan_events WHERE type LIKE 'ach.return.%' OR type = 'ach.return_file.received' OR type = 'ach.entry.settled' OR type = 'ach.noc.received'`), timers: await count(`SELECT count(*)::bigint AS c FROM timers`), escalations: await count(`SELECT count(*)::bigint AS c FROM escalations`) });
  const before = await snapshot();
  const q2 = await PgFakeOdfiQueue.postReturns(db, { as_of_date: "2026-10-05", file_name: "RET-20261005-resend.ach", content, received_at: "2026-10-05T14:00:00.000Z" }); assert.equal(q2.sha256, q1.sha256);
  const ing3 = await runtime.execute({ process: "35.5", name: "ach.returns.ingest", loanId: "", actor: CASHIERING_AGENT, input: { as_of_date: "2026-10-05" } });
  const o3 = ing3.output as ReturnsIngestReport; assert.equal(o3.files.length, 1); assert.equal(o3.files[0]!.status, "duplicate"); assert.equal(o3.files[0]!.duplicate_of, rf.id); assert.deepEqual(o3.duplicates, [rf.id]); assert.equal(o3.returns, 0); assert.equal(o3.actioned, 0);
  assert.deepEqual(await snapshot(), before, "the same return file again writes nothing");
  assert.equal(ing3.decisions.length, 1); const d3 = (await db.query<Row>(`SELECT rule_code, subject_id, rationale FROM agent_decisions WHERE id = $1`, [ing3.decisions[0]!.id]))[0]!; assert.equal(d3["rule_code"], "DUPLICATE_FILE"); assert.ok(String(d3["rationale"]).includes(rf.id));
  assert.equal(((await db.query<Row>(`SELECT metadata FROM documents WHERE id = $1`, [q2.document_id]))[0]!["metadata"] as Row)["status"], "duplicate");
  // the table holds the line without the tool: the return file row is never changed or deleted
  await assert.rejects(db.query(`UPDATE ach_return_files SET returns = 2 WHERE id = $1`, [rf.id]), /append-only|immutable|forbid/i); await assert.rejects(db.query(`DELETE FROM ach_return_files WHERE id = $1`, [rf.id]), /append-only|immutable|forbid/i);
});
test("35.5-T10: Given the reinitiation of T9 is also returned R01 on 2026-10-12, when the return is actioned and the unit runs on 2026-10-17, then no further reinitiation is built (`NACHA_NSF_REINITIATION_180_MAX2` exhausted), the enrollment is `suspended_returns` with a hand-off escalation to `borrower-comms`, the 2026-10-17 run assesses **$79.01** on row 2026-10-01, and a second `fees{nsf_fee}` row exists for the second item; given instead a return coded R11, then no NSF fee exists and the corrected entry carries `reinitiation_of_entry_id`.", { skip }, async () => {
  const loanId = loans.l1ach; assert.ok(loanId, "T9's L-1"); const cash = ports35_5(runtime).cashRows;
  const [original, retry] = await readAchEntries(db, loanId) as [Awaited<ReturnType<typeof readAchEntries>>[number], Awaited<ReturnType<typeof readAchEntries>>[number]]; assert.equal(original.status, "returned"); assert.equal(retry.status, "built"); const E1 = original.enrollment_key!;
  // Tue 2026-10-06: the build carries the reinitiation alone (T+2 = Thu 2026-10-08; E-L1's next draft is November's, out of the window) and transmits it
  clock.set("2026-10-06T18:00:00.000Z"); assert.equal(addBusinessDays(D("2026-10-06"), 2, federal), "2026-10-08");
  const b1 = (await runtime.execute({ process: "35.5", name: "ach.file.build", loanId: "", actor: CASHIERING_AGENT, input: { as_of_date: "2026-10-06" } })).output as BuildReport;
  assert.equal(b1.entries, 1); assert.deepEqual(b1.entry_ids, [retry.id]); assert.equal(b1.total_debit_cents, "229257"); assert.equal(b1.transmitted, true); assert.ok(b1.skipped.some((x) => x.enrollment_id === E1 && x.reason === "settlement_after_window" && x.settlement_date === "2026-11-02"));
  const retryT = (await readAchEntries(db, loanId)).find((x) => x.id === retry.id)!; assert.equal(retryT.status, "transmitted"); assert.equal(retryT.file_id, b1.file_id); assert.match(retryT.trace_number ?? "", /^\d{15}$/); assert.notEqual(retryT.trace_number, original.trace_number); assert.equal(retryT.company_entry_description, "RETRY PYMT");
  assert.ok((await fileBytes((await readAchFiles(db)).find((f) => f.id === b1.file_id)!.document_id!)).includes("RETRY PYMT"));
  // Thu 2026-10-08: the retry settles (the feed) and L-1's unit posts it again (row 2026-10-01 satisfied by the second payment, the same figures)
  clock.set("2026-10-08T13:00:00.000Z");
  const i8 = (await runtime.execute({ process: "35.5", name: "ach.returns.ingest", loanId: "", actor: CASHIERING_AGENT, input: { as_of_date: "2026-10-08" } })).output as ReturnsIngestReport;
  assert.equal(i8.settled.length, 1); assert.equal(i8.settled[0]!.entry_id, retry.id); const p2 = i8.settled[0]!.payment_id; assert.notEqual(p2, (await cash.reversalsFor(loanId, p2)).length ? "" : "x");
  const u8 = await runCashieringUnit(runtime, { loan_id: loanId, as_of_date: D("2026-10-08"), as_of_instant: "2026-10-08T16:00:00.000Z" }); assert.equal(u8.outcome, "done", u8.error ?? ""); assert.deepEqual(u8.posted, [p2]);
  const posted2 = (await eventsOn(loanId, "payment.posted")).find((x) => x.payload["payment_id"] === p2); assert.ok(posted2); assert.equal(posted2.payload["interest_cents"], "135171"); assert.equal(posted2.payload["principal_cents"], "22846"); assert.equal(posted2.payload["curtailment_cents"], "10000"); assert.deepEqual(posted2.payload["installments"], ["2026-10-01"]); assert.equal(posted2.payload["received_on"], "2026-10-08");
  assert.equal((await loanCashStateFromRows(db, loanId, D("2026-10-09"))).state.upb_cents, 24_921_831n);
  // Mon 2026-10-12: the reinitiation is also returned R01 → no further reinitiation (NACHA_NSF_REINITIATION_180_MAX2 exhausted: the second return on the installment), the enrollment suspended_returns, the borrower-comms hand-off, a second NSF fee for the second item
  const r2content = fakeReturnFile([{ trace_number: retryT.trace_number!, amount_cents: 229_257n, code: "R01", returned_on: D("2026-10-12"), account: "FAKE1001", individual_id: "****1001", name: "Ada Fixture" }], D("2026-10-12"));
  await PgFakeOdfiQueue.postReturns(db, { as_of_date: "2026-10-12", file_name: "RET-20261012.ach", content: r2content, received_at: "2026-10-12T12:00:00.000Z" });
  clock.set("2026-10-12T13:00:00.000Z");
  const i12 = (await runtime.execute({ process: "35.5", name: "ach.returns.ingest", loanId: "", actor: CASHIERING_AGENT, input: { as_of_date: "2026-10-12" } })).output as ReturnsIngestReport;
  assert.equal(i12.returns, 1); assert.equal(i12.actioned, 1); assert.deepEqual(i12.errors, []); assert.equal(i12.files[0]!.items[0]!.action, "reversed_suspended");
  assert.equal(await count(`SELECT count(*)::bigint AS c FROM ach_entries WHERE loan_id = $1`, [loanId]), 2n, "no third entry");
  assert.equal((await readAchEntries(db, loanId)).find((x) => x.id === retry.id)!.status, "returned");
  const enr = await enrollmentRow(loanId, E1); assert.equal(enr["status"], "suspended_returns"); assert.equal(enr["returns_on_current_installment"], 2);
  const act2 = (await eventsOn(loanId, "ach.return.actioned")).find((x) => x.payload["entry_id"] === retry.id); assert.ok(act2); assert.equal(act2.payload["action"], "reversed_suspended"); assert.equal(act2.payload["reinitiation_entry_id"], null); assert.equal(act2.payload["payment_id"], p2); assert.ok(act2.payload["nsf_fee_id"]); assert.equal(act2.payload["enrollment_status"], "suspended_returns"); assert.ok(act2.payload["escalation_id"]);
  const handoff = await db.query<Row>(`SELECT id, kind, owner_role, status::text AS status, payload FROM escalations WHERE loan_id = $1 AND owner_role = 'borrower-comms'`, [loanId]); assert.equal(handoff.length, 1);
  assert.equal(handoff[0]!["kind"], "human_portal_task"); assert.equal(handoff[0]!["status"], "open"); assert.equal(handoff[0]!["id"], act2.payload["escalation_id"]); assert.equal((handoff[0]!["payload"] as Row)["rule_code"], "MAX_2_REINITIATIONS_180"); assert.equal((handoff[0]!["payload"] as Row)["timer_code"], "NACHA_NSF_REINITIATION_180_MAX2"); assert.equal((handoff[0]!["payload"] as Row)["enrollment_id"], E1);
  assert.ok((await eventsOn(loanId, "autodraft.status.changed")).some((x) => x.payload["status"] === "suspended_returns" && x.payload["enrollment_id"] === E1), "2.3's own status change");
  const nsfFees = (await cash.feesFor(loanId)).filter((x) => x.data["fee_type"] === "nsf_fee"); assert.equal(nsfFees.length, 2);
  assert.ok(nsfFees.every((x) => x.data["amount_cents"] === "2500")); assert.deepEqual(new Set(nsfFees.map((x) => x.data["returned_payment_id"])).size, 2); assert.ok(nsfFees.some((x) => x.data["returned_payment_id"] === p2));
  assert.equal((await readRows(db, loanId)).find((r) => r.due_date === "2026-10-01")!.status, "due"); assert.equal((await loanCashStateFromRows(db, loanId, D("2026-10-13"))).state.upb_cents, 24_954_677n);
  const clocks = await readTimer(db, loanId, "SM_ACH_RETURN_ACTIONED_1BD"); assert.equal(clocks.length, 2); assert.ok(clocks.every((t) => t.status === "satisfied"));
  const dSusp = (await db.query<Row>(`SELECT rule_code FROM agent_decisions WHERE loan_id = $1 AND action = 'ach.return.action' ORDER BY created_at DESC LIMIT 1`, [loanId]))[0]!; assert.equal(dSusp["rule_code"], "MAX_2_REINITIATIONS_180");
  // the 2026-10-17 run (grace end Fri 2026-10-16) assesses $79.01 on row 2026-10-01 — the retry did not settle in time (2.3 rule 8)
  assert.equal(graceEnd(D("2026-10-01"), 15), "2026-10-16");
  clock.set("2026-10-17T16:00:00.000Z");
  const u17 = await runCashieringUnit(runtime, { loan_id: loanId, as_of_date: D("2026-10-17"), as_of_instant: "2026-10-17T16:00:00.000Z" }); assert.equal(u17.outcome, "done", u17.error ?? ""); assert.equal(u17.late_charge_run, true); assert.equal(u17.grace_ended_yesterday, true); assert.equal(u17.late_charge_fee_ids.length, 1);
  const lc = (await cash.feesFor(loanId)).filter((x) => x.data["fee_type"] === "late_charge"); assert.equal(lc.length, 1); const lcFee = lc[0]!;
  assert.equal(lcFee.data["amount_cents"], "7901"); assert.equal(BigInt(String(lcFee.data["amount_cents"])), 7_901n); assert.equal(lcFee.data["installment_due_date"], "2026-10-01"); assert.equal(lcFee.data["assessed_on"], "2026-10-17"); assert.equal(lcFee.data["grace_end_on"], "2026-10-16"); assert.equal(lateChargeAmount(158_017n, "5.000", null), 7_901n); assert.equal(u17.late_charge_fee_ids[0], lcFee.id);
  assert.equal((await cash.feesFor(loanId)).length, 3, "two NSF fees and one late charge");
  // given instead a return coded R11 (our error): T-7 with its own enrollment — built Fri 2026-10-30 for Mon 2026-11-02 (the 1st is a Sunday), settled and posted, returned R11 on 2026-11-04 → no NSF fee, the corrected entry carries reinitiation_of_entry_id, action corrected_entry
  const t7 = await boardTapeLoan(runtime, clock, T7_TAPE, `B-T7-T10-${R}`, D("2026-10-16")); const t7Id = t7.loan_id; await seedCustodial(db, await partnerPartyOf(db));
  const E7 = `E-T7-${R}`; await writeEnrollment(t7Id, E7, { draft_day: 1, extra_principal_cents: 0n, next_draft_on: D("2026-11-01"), last_debit_cents: 230_850n, last4: "7007" });
  assert.equal(settlementDateFor(D("2026-11-01"), 1, 15, federal), "2026-11-02"); assert.equal(addBusinessDays(D("2026-10-30"), 1, federal), "2026-11-02"); assert.equal(189_620n + 41_230n, 230_850n);
  clock.set("2026-10-30T18:00:00.000Z");
  const b7 = (await runtime.execute({ process: "35.5", name: "ach.file.build", loanId: "", actor: CASHIERING_AGENT, input: { as_of_date: "2026-10-30" } })).output as BuildReport;
  assert.equal(b7.entries, 1); const e7 = (await readAchEntries(db, t7Id))[0]!; assert.deepEqual(b7.entry_ids, [e7.id]); assert.equal(e7.amount_cents, 230_850n); assert.equal(e7.effective_entry_date, "2026-11-02"); assert.equal(e7.status, "transmitted"); assert.equal(e7.company_entry_description, "MORTGAGE PMT");
  assert.ok(!b7.entry_ids.includes(original.id) && !b7.entry_ids.includes(retry.id), "the suspended enrollment originates nothing");
  clock.set("2026-11-02T13:00:00.000Z");
  const i2 = (await runtime.execute({ process: "35.5", name: "ach.returns.ingest", loanId: "", actor: CASHIERING_AGENT, input: { as_of_date: "2026-11-02" } })).output as ReturnsIngestReport; assert.equal(i2.settled.length, 1); const p7 = i2.settled[0]!.payment_id;
  const u2 = await runCashieringUnit(runtime, { loan_id: t7Id, as_of_date: D("2026-11-02"), as_of_instant: "2026-11-02T16:00:00.000Z" }); assert.equal(u2.outcome, "done", u2.error ?? ""); assert.deepEqual(u2.posted, [p7]);
  const posted7 = (await eventsOn(t7Id, "payment.posted")).find((x) => x.payload["payment_id"] === p7); assert.ok(posted7); assert.deepEqual(posted7.payload["installments"], ["2026-11-01"]); assert.equal(posted7.payload["interest_cents"], "151915"); assert.equal(posted7.payload["principal_cents"], "37705");
  const r11 = fakeReturnFile([{ trace_number: e7.trace_number!, amount_cents: 230_850n, code: "R11", returned_on: D("2026-11-04"), account: "FAKE7007", individual_id: "****7007", name: "Ada Fixture" }], D("2026-11-04"));
  await PgFakeOdfiQueue.postReturns(db, { as_of_date: "2026-11-04", file_name: "RET-20261104.ach", content: r11, received_at: "2026-11-04T12:00:00.000Z" });
  clock.set("2026-11-04T13:00:00.000Z");
  const i4 = (await runtime.execute({ process: "35.5", name: "ach.returns.ingest", loanId: "", actor: CASHIERING_AGENT, input: { as_of_date: "2026-11-04" } })).output as ReturnsIngestReport;
  assert.equal(i4.returns, 1); assert.equal(i4.actioned, 1); assert.deepEqual(i4.errors, []); assert.equal(i4.files[0]!.items[0]!.action, "corrected_entry");
  const t7Entries = await readAchEntries(db, t7Id); assert.equal(t7Entries.length, 2); const corrected = t7Entries.find((x) => x.reinitiation_of_entry_id === e7.id)!; assert.ok(corrected, "the corrected entry carries reinitiation_of_entry_id");
  assert.equal(corrected.amount_cents, 230_850n); assert.equal(corrected.status, "built"); assert.equal(corrected.reinitiation_count, 1); assert.equal(corrected.effective_entry_date, "2026-11-09"); assert.equal(addBusinessDays(D("2026-11-04"), 3, federal), "2026-11-09");
  assert.equal(t7Entries.find((x) => x.id === e7.id)!.return_code, "R11");
  assert.equal((await cash.feesFor(t7Id)).filter((x) => x.data["fee_type"] === "nsf_fee").length, 0, "no NSF fee on an R11");
  const act7 = (await eventsOn(t7Id, "ach.return.actioned")).find((x) => x.payload["entry_id"] === e7.id); assert.ok(act7); assert.equal(act7.payload["action"], "corrected_entry"); assert.equal(act7.payload["code"], "R11"); assert.equal(act7.payload["nsf_fee_id"], null); assert.equal(act7.payload["reinitiation_entry_id"], corrected.id); assert.equal(act7.payload["payment_id"], p7);
  assert.equal((await readRows(db, t7Id)).find((r) => r.due_date === "2026-11-01")!.status, "due", "the R11 reversal restored the row");
  assert.ok((await eventsOn(t7Id, "ach.r11.resolved")).some((x) => x.payload["outcome"] === "corrected_reinitiated"), "2.3's own R11 resolution");
  assert.equal((await readAchReturns(db, e7.id))[0]!.action_taken, "corrected_entry");
  assert.equal((await db.query<Row>(`SELECT set_id FROM ledger_lines GROUP BY set_id HAVING sum(amount_cents) <> 0`)).length, 0, "every set balanced");
});
test("35.5-T11: Given loan P (AZ, `America/Phoenix`) and loan N (NY, `America/New_York`) each with a `due` row for 2026-10-01, when the planner's `as_of` is 2026-10-02T06:30:00Z, then N's `cashiering_unit_runs.local_date` is 2026-10-02 and P's is 2026-10-01, `installment.due_date_reached{due_date: 2026-10-01}` was emitted for P on that pass and for N on the earlier pass whose local date was 2026-10-01, `LOAN_LOCAL_TZ` no longer exists in `src/runtime` (grep = 0), and a loan with no `loan_servicing_configs` row is refused `CONFIG_REQUIRED` by the unit with nothing written.", { skip }, async () => {
  // loan P (AZ, America/Phoenix) and loan N (NY, America/New_York), each with a `due` row for 2026-10-01 (worked example F); a third loan inserted by hand with no configuration row
  const p = await boardTapeLoan(runtime, clock, AZ_TAPE, `B-AZ-${R}`, D("2026-09-15")); const n = await boardTapeLoan(runtime, clock, NY_TAPE, `B-NY11-${R}`, D("2026-09-15"));
  const zone = async (id: string): Promise<string> => String((await db.query<Row>(`SELECT time_zone FROM loan_servicing_configs WHERE loan_id = $1`, [id]))[0]!["time_zone"]);
  assert.equal(await zone(p.loan_id), "America/Phoenix"); assert.equal(await zone(n.loan_id), "America/New_York");
  for (const id of [p.loan_id, n.loan_id]) { const r = (await readRows(db, id))[0]!; assert.equal(r.due_date, "2026-10-01"); assert.equal(r.status, "due"); }
  const orphan = await insertUnconfiguredLoan(db, await partnerPartyOf(db));
  const orphanEvents = await count(`SELECT count(*)::bigint AS c FROM loan_events WHERE loan_id = $1`, [orphan]);
  assert.equal(await count(`SELECT count(*)::bigint AS c FROM loan_servicing_configs WHERE loan_id = $1`, [orphan]), 0n);
  // the earlier pass, 2026-10-01T04:30:00Z: 00:30 in New York (N's due date reached), 21:30 on the 30th in Phoenix (nothing for P)
  clock.set("2026-10-01T04:30:00.000Z");
  const r1 = await cashieringDailyRun(runtime, "2026-10-01T04:30:00.000Z");
  assert.equal(r1.as_of_date, "2026-10-01"); assert.deepEqual(r1.errors, []); assert.deepEqual(r1.skipped, [{ loan_id: orphan, reason: "CONFIG_REQUIRED" }]);
  // the planner's as_of 2026-10-02T06:30:00Z: 02:30 on the 2nd in New York, 23:30 on the 1st in Phoenix — P's due date reached on this pass
  clock.set("2026-10-02T06:30:00.000Z");
  const r2 = await cashieringDailyRun(runtime, "2026-10-02T06:30:00.000Z");
  assert.equal(r2.as_of_date, "2026-10-02"); assert.deepEqual(r2.errors, []); assert.deepEqual(r2.skipped, [{ loan_id: orphan, reason: "CONFIG_REQUIRED" }]);
  const unitsN = await readUnitRuns(db, n.loan_id); const unitsP = await readUnitRuns(db, p.loan_id);
  assert.deepEqual(unitsN.map((u) => [u.as_of_date, u.local_date, u.time_zone, u.outcome]), [["2026-10-01", "2026-10-01", "America/New_York", "done"], ["2026-10-02", "2026-10-02", "America/New_York", "done"]]);
  assert.deepEqual(unitsP.map((u) => [u.as_of_date, u.local_date, u.time_zone, u.outcome]), [["2026-10-01", "2026-09-30", "America/Phoenix", "done"], ["2026-10-02", "2026-10-01", "America/Phoenix", "done"]]);
  assert.deepEqual(unitsN.map((u) => u.due_today), [true, false]); assert.deepEqual(unitsP.map((u) => u.due_today), [false, true]);
  const reachedN = (await readEvents(db, n.loan_id)).filter((e) => e.type === "installment.due_date_reached"); const reachedP = (await readEvents(db, p.loan_id)).filter((e) => e.type === "installment.due_date_reached");
  assert.equal(reachedN.length, 1); assert.equal(reachedN[0]!.payload["due_date"], "2026-10-01"); assert.equal(reachedN[0]!.actor_id, "cashiering");
  assert.equal(reachedP.length, 1); assert.equal(reachedP[0]!.payload["due_date"], "2026-10-01"); assert.equal(reachedP[0]!.actor_id, "cashiering");
  const at = async (id: string): Promise<string> => (await db.query<{ t: string }>(`SELECT occurred_at::text AS t FROM loan_events WHERE id = $1`, [id]))[0]!.t;
  assert.ok((await at(reachedN[0]!.id)).startsWith("2026-10-01 04:30"), "N's on the earlier pass"); assert.ok((await at(reachedP[0]!.id)).startsWith("2026-10-02 06:30"), "P's on the 2026-10-02T06:30Z pass");
  // the constant is gone from src/runtime (every .ts file under it; grep = 0)
  const runtimeDir = fileURLToPath(new URL("../../runtime", import.meta.url));
  const offenders = readdirSync(runtimeDir, { recursive: true }).map(String).filter((f) => f.endsWith(".ts")).filter((f) => readFileSync(`${runtimeDir}/${f}`, "utf8").includes("LOAN_LOCAL_TZ"));
  assert.deepEqual(offenders, []);
  // a loan with no loan_servicing_configs row is refused CONFIG_REQUIRED by the unit with nothing written: the daily run's failed rows name it, its log is untouched, the bus tool rejects
  const orphanUnits = await readUnitRuns(db, orphan);
  assert.deepEqual(orphanUnits.map((u) => [u.as_of_date, u.outcome, u.error_class, u.local_date, u.time_zone]), [["2026-10-01", "failed", "CONFIG_REQUIRED", null, null], ["2026-10-02", "failed", "CONFIG_REQUIRED", null, null]]);
  assert.equal(await count(`SELECT count(*)::bigint AS c FROM loan_events WHERE loan_id = $1`, [orphan]), orphanEvents);
  await assert.rejects(runtime.execute({ process: "35.5", name: "cashiering.run_unit", loanId: orphan, actor: CASHIERING_AGENT, input: { loan_id: orphan, as_of_date: "2026-10-02" } }), (e: unknown) => e instanceof CommandRefused && e.code === "CONFIG_REQUIRED");
  assert.equal(await count(`SELECT count(*)::bigint AS c FROM loan_events WHERE loan_id = $1`, [orphan]), orphanEvents); assert.equal((await readUnitRuns(db, orphan)).length, 2);
  assert.equal(await count(`SELECT count(*)::bigint AS c FROM agent_decisions WHERE loan_id = $1`, [orphan]), 0n);
  // the counter job (11.1) reads the same rows in the same zones: it lists the orphan as skipped, never under a default zone
  const dq = await delinquencyDailySweep(runtime, "2026-10-02T06:30:00.000Z", [p.loan_id, n.loan_id, orphan]);
  assert.deepEqual(dq.skipped, [{ loan_id: orphan, reason: "CONFIG_REQUIRED" }]); assert.deepEqual(dq.loans.map((l) => l.loan_id), [n.loan_id], "N's row is past due on its day; P's day is still the 1st");
});
test("35.5-T12: Given both boarding paths, when a loan boards, then a `loan_servicing_configs` row exists in the same transaction with `time_zone` from the reviewed state map for `properties.state`, `jurisdiction_state`, `servicer_profile_id` = the active profile, `late_charge_terms` = 2.7's `lateChargeTerms` for the note and `jurisdiction_rules.rules.late_charge`, `nsf_fee_allowed` from `jurisdiction_rules.rules.nsf_fee`, and `loan.servicing_config.written` satisfied `SM_LOAN_SERVICING_CONFIG_AT_BOARD_0`; given a note late-charge rate above the state's `max_pct`, then `late_charge_terms.conflict` names it and the state's bound is what 2.7 assesses.", { skip }, async () => {
  assert.ok(loans.t1 && loans.t2, "T1's funded note and T2's tape T-7 are the two boarding paths");
  const v1 = await profileV1();
  for (const [loanId, state] of [[loans.t1, "AZ"], [loans.t2, "TX"]] as const) {
    const cfgs = await db.query<Row>(`SELECT c.*, c.xmin::text AS cxmin, (SELECT l.xmin::text FROM loans l WHERE l.id = c.loan_id) AS lxmin, effective_from::text AS effective_from_text FROM loan_servicing_configs c WHERE c.loan_id = $1 ORDER BY c.effective_from DESC`, [loanId]);
    assert.equal(cfgs.length, 1); const cfg = cfgs[0]!;
    assert.equal(cfg["time_zone"], STATE_DEFAULT_TIME_ZONE[state]); assert.equal(cfg["time_zone"], state === "AZ" ? "America/Phoenix" : "America/Chicago"); assert.equal(cfg["time_zone_source"], "state_default");
    assert.equal(cfg["jurisdiction_state"], state); assert.equal(cfg["servicer_profile_id"], v1["id"]);
    assert.deepEqual(cfg["late_charge_terms"], lateChargeTerms({ pct: "5.000", grace_days: 15 }, { max_pct: "5.000", min_grace_days: 15, state })); assert.equal((cfg["late_charge_terms"] as Row)["conflict"], null);
    assert.equal(cfg["nsf_fee_allowed"], true); assert.ok(cfg["decision_id"]); assert.equal(cfg["cxmin"], cfg["lxmin"], "the config row committed in the boarding transaction");
    const decision = (await db.query<Row>(`SELECT rule_set_version, action, subject_id FROM agent_decisions WHERE id = $1`, [cfg["decision_id"]]))[0]!;
    assert.equal(decision["rule_set_version"], "35.5@config.v1"); assert.equal(decision["action"], "servicing_config.write"); assert.equal(decision["subject_id"], cfg["id"]);
    const events = await readEvents(db, loanId);
    const written = events.find((e) => e.type === "loan.servicing_config.written"); const boarded = events.find((e) => e.type === "loan.boarded");
    assert.ok(written && boarded); assert.equal(written.xmin, boarded.xmin); assert.equal(written.payload["time_zone"], cfg["time_zone"]); assert.equal(written.payload["jurisdiction_state"], state); assert.equal(written.payload["servicer_profile_id"], v1["id"]);
    const timers = await readTimer(db, loanId, "SM_LOAN_SERVICING_CONFIG_AT_BOARD_0");
    assert.equal(timers.length, 1); assert.equal(timers[0]!.status, "satisfied"); assert.equal(timers[0]!.satisfied_by_event_id, written.id); assert.equal(timers[0]!.armed_by_event_id, boarded.id);
  }
  // the jurisdiction row's nsf_fee block the TX config selects is what 2.7 rule 7 assesses on a returned item: min(2,500¢, cap) = $25.00 (worked example D: "L-1's jurisdiction allows it"), nothing where a jurisdiction forbids it
  const txRules = (await db.query<{ rules: Row }>(`SELECT rules FROM jurisdiction_rules WHERE state = 'TX'`))[0]!.rules;
  const txCfg = (await db.query<Row>(`SELECT nsf_fee_allowed FROM loan_servicing_configs WHERE loan_id = $1`, [loans.t2]))[0]!;
  const txState = (await loanCashState(runtime, loans.t2, D("2026-10-05"))).state;
  const nsf = nsfFee(txState, { allowed: txCfg["nsf_fee_allowed"] === true, cap_cents: BigInt(String((txRules["nsf_fee"] as Row)["cap_cents"])) }, { our_error: false, returned_on: D("2026-10-05"), payment_id: randomUUID() });
  assert.ok(nsf); assert.equal(nsf.fee_type, "nsf_fee"); assert.equal(nsf.amount_cents, 2_500n); assert.equal((txRules["nsf_fee"] as Row)["cap_cents"], 2500);
  assert.equal(nsfFee(txState, { allowed: false, cap_cents: 2_500n }, { our_error: false, returned_on: D("2026-10-05") }), null);
  // a note late-charge rate above the state's max_pct: the conflict is recorded and the state's bound is what 2.7 assesses
  const ny = await boardTapeLoan(runtime, clock, NY_TAPE, `B-NY-${R}`, D("2026-09-15"));
  const cfg = (await db.query<Row>(`SELECT * FROM loan_servicing_configs WHERE loan_id = $1`, [ny.loan_id]))[0]!;
  const terms = cfg["late_charge_terms"] as { pct: string; grace_days: number; conflict: null | Row };
  assert.equal(cfg["jurisdiction_state"], "NY"); assert.equal(cfg["time_zone"], "America/New_York"); assert.equal(terms.pct, "2.000"); assert.equal(terms.grace_days, 15);
  assert.deepEqual(terms.conflict, { state: "NY", note: { pct: "5.000", grace_days: 15 }, cap: "2.000%/15 days", applied: "lower_cap" });
  assert.deepEqual(terms, lateChargeTerms({ pct: "5.000", grace_days: 15 }, { max_pct: "2.000", min_grace_days: 15, state: "NY" }));
  clock.set("2026-10-17T16:00:00.000Z");
  const facts = await loanCashState(runtime, ny.loan_id, D("2026-10-17"));
  assert.equal(facts.state.late_charge_pct, "2.000"); assert.equal(facts.terms.late_charge_pct, "2.000");
  const run = assessLateCharge({ state: facts.state, installment_due_date: D("2026-10-01"), run_on: D("2026-10-17"), unposted_receipts_on_or_before_grace: 0 });
  assert.equal(run.outcome, "assessed"); assert.equal(run.grace_end_on, "2026-10-16");
  const pi = facts.terms.pi_cents; assert.equal(pi, 189_620n);
  assert.equal(run.fee.amount_cents, lateChargeAmount(pi, "2.000", null)); assert.notEqual(run.fee.amount_cents, lateChargeAmount(pi, "5.000", null)); assert.equal(run.fee.amount_cents, 3_792n);
});
test("35.5-T13: Given the FAKE build's seeded `servicer_profiles` v1 (the former `SERVICER_CONTACT` values), when 7.1's statement for L-1 renders, then its servicer block (name, phone, servicer address, exclusive address, remittance address, portal URL, counselor URL, HUD phone) equals v1's columns and `SERVICER_CONTACT` no longer exists in `src/runtime/servicing.ts`; when `compliance` activates v2 with a new exclusive address effective tomorrow, then today's statement still renders v1, tomorrow's renders v2, `servicer_profile.activated{version: 2}` carries the decision id, and an `ops_analyst` activating a version is refused `ROLE_DENIED` with nothing written.", { skip }, async () => {
  const l1 = await boardTapeLoan(runtime, clock, L1_TAPE, `B-L1-${R}`, D("2026-08-20")); const loanId = l1.loan_id; loans.l1 = loanId;
  await seedCustodial(db, await partnerPartyOf(db)); await linkBorrowerParty(db, loanId);
  // the seeded version 1 is the former constant's values (and the code's FAKE_SERVICER_PROFILE_V1 spells the same row)
  const v1 = await profileV1(); assert.equal(v1["status"], "active"); assert.equal(v1["effective_from"], "2020-01-01"); assert.equal(v1["effective_to"], null);
  for (const k of ["legal_name", "toll_free_phone", "servicer_address", "exclusive_address", "remittance_address", "portal_url", "counselor_url", "hud_phone"] as const) assert.equal(v1[k], FAKE_SERVICER_PROFILE_V1[k], k);
  // the EIN at rest is the tree's encrypted pair (never the digits in a column): tin_last4 for display, tin_encrypted opened only for the rendered block
  assert.equal(v1["tin_last4"], "6789"); assert.ok(v1["tin_encrypted"] instanceof Uint8Array && (v1["tin_encrypted"] as Uint8Array).length > 28); assert.ok(!Buffer.from(v1["tin_encrypted"] as Uint8Array).toString("latin1").includes("123456789"));
  assert.equal(await count(`SELECT count(*)::bigint AS c FROM information_schema.columns WHERE table_name = 'servicer_profiles' AND column_name = 'tin'`), 0n);
  clock.set("2026-09-20T16:00:00.000Z");
  const s1 = await sendPeriodicStatement(runtime, loanId, { cycle_due_date: D("2026-10-01"), statement_date: D("2026-09-20") });
  const p1 = runtime.noticeMemory.get(s1.notice_id)!.payload;
  assert.equal(p1["servicer_name"], v1["legal_name"]); assert.equal(p1["servicer_phone"], v1["toll_free_phone"]); assert.equal(p1["servicer_address"], v1["servicer_address"]); assert.equal(p1["exclusive_address"], v1["exclusive_address"]);
  assert.equal(p1["remittance_address"], v1["remittance_address"]); assert.equal(p1["portal_url"], v1["portal_url"]); assert.equal(p1["counselor_url"], v1["counselor_url"]); assert.equal(p1["hud_phone"], v1["hud_phone"]);
  const source = readFileSync(fileURLToPath(new URL("../../runtime/servicing.ts", import.meta.url)), "utf8");
  assert.ok(!source.includes("SERVICER_CONTACT"), "the constant is gone from src/runtime/servicing.ts");
  // amendment 43 (batch 35-consistency-pass): the exclusive address rides on every 11.x/12.x notice that carries contact information — 11.2's written EI request sees it present
  const block = await servicerBlockFor(db, loanId, D("2026-09-20"));
  assert.equal(block.exclusive_address, v1["exclusive_address"]); assert.equal(block.servicer_profile_id, v1["id"]); assert.equal(block.servicer_tin, FAKE_SERVICER_PROFILE_V1.tin, "the 1098's servicer TIN is the profile's, decrypted for the block only");
  const ei = writtenNoticeRequest({ template: Object.keys(EI_NOTICE_VARIANTS)[0]!, payload: { ...block, team_name: "Servicing Team", team_phone: block.servicer_phone }, active_assignment: null, requested_on: D("2026-09-20") });
  assert.equal(ei.gate.send_allowed, true); assert.ok(ei.event); assert.equal(ei.event.payload["exclusive_address_present"], true); assert.equal(ei.payload["exclusive_address"], v1["exclusive_address"]);
  // the 4.x / 9.x contact blocks (FAKE_SERVICER_CONTACT) carry the profile's fields
  assert.equal(FAKE_SERVICER_CONTACT.servicer_phone, v1["toll_free_phone"]); assert.equal(FAKE_SERVICER_CONTACT.servicer_address, v1["servicer_address"]); assert.equal(FAKE_SERVICER_CONTACT.exclusive_address, v1["exclusive_address"]);
  // compliance activates v2 with a new exclusive address effective tomorrow
  const act = await runtime.execute({ process: "35.5", name: "servicer_profile.write", loanId: "", actor: COMPLIANCE, input: { op: "activate", version: 2, exclusive_address: "PO Box 9, Testville TX 75001", effective_from: "2026-09-21", reason: "go-live address" } });
  const activated = act.events.find((e) => e.type === "servicer_profile.activated");
  assert.ok(activated); assert.equal(activated.payload["version"], 2); assert.equal(activated.payload["effective_from"], "2026-09-21");
  const decisionId = String(activated.payload["decision_id"]);
  const d = (await db.query<Row>(`SELECT rule_set_version, action, approved_role, approved_by, subject_id FROM agent_decisions WHERE id = $1`, [decisionId]))[0];
  assert.ok(d, "the activation's decision"); assert.equal(d["rule_set_version"], "35.5@config.v1"); assert.equal(d["action"], "servicer_profile.activate"); assert.equal(d["approved_role"], "compliance"); assert.equal(d["approved_by"], COMPLIANCE.id);
  const v2 = (await db.query<Row>(`SELECT id, version, status::text AS status, effective_from::text AS effective_from, effective_to::text AS effective_to, exclusive_address, servicer_address, approved_by_decision_id, tin_last4, tin_encrypted = (SELECT tin_encrypted FROM servicer_profiles WHERE version = 1 AND legal_name = 'Supermortgage LLC') AS same_tin FROM servicer_profiles WHERE version = 2 AND legal_name = 'Supermortgage LLC'`))[0]!;
  assert.equal(v2["status"], "active"); assert.equal(v2["effective_from"], "2026-09-21"); assert.equal(v2["exclusive_address"], "PO Box 9, Testville TX 75001"); assert.equal(v2["servicer_address"], v1["servicer_address"]); assert.equal(v2["approved_by_decision_id"], decisionId); assert.equal(d["subject_id"], v2["id"]);
  assert.equal(v2["tin_last4"], "6789"); assert.equal(v2["same_tin"], true, "a version that keeps the EIN carries the prior blob unchanged"); assert.ok(!("tin" in activated.payload) && !("tin_encrypted" in activated.payload));
  const v1After = await profileV1(); assert.equal(v1After["status"], "superseded"); assert.equal(v1After["effective_to"], "2026-09-21");
  // today's statement still renders v1; tomorrow's renders v2
  const s2 = await sendPeriodicStatement(runtime, loanId, { cycle_due_date: D("2026-10-01"), statement_date: D("2026-09-20") });
  assert.equal(runtime.noticeMemory.get(s2.notice_id)!.payload["exclusive_address"], v1["exclusive_address"]);
  clock.set("2026-09-21T16:00:00.000Z");
  const s3 = await sendPeriodicStatement(runtime, loanId, { cycle_due_date: D("2026-10-01"), statement_date: D("2026-09-21") });
  const p3 = runtime.noticeMemory.get(s3.notice_id)!.payload; assert.equal(p3["exclusive_address"], "PO Box 9, Testville TX 75001"); assert.equal(p3["servicer_name"], v1["legal_name"]); assert.equal(p3["remittance_address"], v1["remittance_address"]);
  assert.equal((await servicerBlockFor(db, loanId, D("2026-09-21"))).servicer_profile_version, 2); assert.equal((await servicerBlockFor(db, loanId, D("2026-09-20"))).servicer_profile_version, 1);
  // an ops_analyst activating a version is refused ROLE_DENIED with nothing written
  const profiles = await count(`SELECT count(*)::bigint AS c FROM servicer_profiles`); const decisions = await count(`SELECT count(*)::bigint AS c FROM agent_decisions WHERE action LIKE 'servicer_profile.%'`);
  await assert.rejects(runtime.execute({ process: "35.5", name: "servicer_profile.write", loanId: "", actor: ANALYST, input: { op: "activate", version: 3, exclusive_address: "PO Box 10, Testville TX 75001", effective_from: "2026-09-22", reason: "not mine to make" } }), (e: unknown) => e instanceof CommandRefused && e.code === "ROLE_DENIED");
  assert.equal(await count(`SELECT count(*)::bigint AS c FROM servicer_profiles`), profiles); assert.equal(await count(`SELECT count(*)::bigint AS c FROM agent_decisions WHERE action LIKE 'servicer_profile.%'`), decisions);
  assert.equal(await count(`SELECT count(*)::bigint AS c FROM servicer_profiles WHERE version = 3`), 0n);
  assert.equal((await servicerBlockFor(db, loanId, D("2026-09-22"))).exclusive_address, "PO Box 9, Testville TX 75001");
});
test("35.5-T14: Given a 2.4 curtailment of $1,000.00 received on 2026-11-10 on T-7 (after row 2026-11-01 was satisfied), when the 2026-12-01 payment posts, then interest is `round_half_up((28,008,119 − 100,000) × 0.065 ÷ 12)` = $1,511.69 rather than the row's $1,517.11, the unit records the 542¢ difference against the row, and the schedule is re-projected only when 2.4's re-amortization activates new terms.", { skip }, async () => {
  // T-7 as T2 boarded it (rows from 2026-11-01 under the boarding terms): the 2026-11-01 payment posts through its unit, then the $1,000.00 curtailment, then the 2026-12-01 payment
  const loanId = loans.t2; assert.ok(loanId);
  const runsBefore = await count(`SELECT count(*)::bigint AS c FROM installment_schedule_runs WHERE loan_id = $1`, [loanId]); assert.equal(runsBefore, 1n);
  const at = (d: string): string => `${d}T16:00:00.000Z`;
  clock.set(at("2026-11-01"));
  const p1 = await writePayment(runtime, loanId, { amount_cents: 230_850n, received_on: D("2026-11-01"), channel: "lockbox", instrument: "check" });
  const u1 = await runCashieringUnit(runtime, { loan_id: loanId, as_of_date: D("2026-11-01"), as_of_instant: at("2026-11-01") }); assert.equal(u1.outcome, "done", u1.error ?? ""); assert.deepEqual(u1.posted, [p1]); assert.equal(u1.interest_variance_cents, 0n);
  const nov = (await readRows(db, loanId))[0]!; assert.equal(nov.due_date, "2026-11-01"); assert.equal(nov.status, "satisfied"); assert.equal(nov.satisfied_by_payment_id, p1);
  assert.equal((await loanCashStateFromRows(db, loanId, D("2026-11-02"))).state.upb_cents, 28_008_119n); assert.equal(nov.upb_after_cents, 28_008_119n);
  clock.set(at("2026-11-10"));
  const p2 = await writePayment(runtime, loanId, { amount_cents: 100_000n, received_on: D("2026-11-10"), channel: "portal_onetime", instrument: "ach", designation: "curtailment" });
  const u2 = await runCashieringUnit(runtime, { loan_id: loanId, as_of_date: D("2026-11-10"), as_of_instant: at("2026-11-10") }); assert.equal(u2.outcome, "done", u2.error ?? ""); assert.deepEqual(u2.posted, [p2]);
  const curt = (await readEvents(db, loanId)).find((e) => e.type === "payment.posted" && e.payload["payment_id"] === p2); assert.ok(curt);
  assert.equal(curt.payload["outcome"], "curtailment"); assert.equal(curt.payload["curtailment_cents"], "100000"); assert.deepEqual(curt.payload["installments"], []); assert.equal(curt.payload["upb_after_cents"], "27908119");
  assert.equal((await loanCashStateFromRows(db, loanId, D("2026-11-11"))).state.upb_cents, 27_908_119n); assert.equal(28_008_119n - 100_000n, 27_908_119n);
  // the 2026-12-01 payment: interest on the actual UPB (rule 4), $1,511.69, not the row's $1,517.11 — the 542¢ difference recorded against the row; the schedule is not re-projected
  clock.set(at("2026-12-01"));
  const p3 = await writePayment(runtime, loanId, { amount_cents: 230_850n, received_on: D("2026-12-01"), channel: "lockbox", instrument: "check" });
  const u3 = await runCashieringUnit(runtime, { loan_id: loanId, as_of_date: D("2026-12-01"), as_of_instant: at("2026-12-01") }); assert.equal(u3.outcome, "done", u3.error ?? ""); assert.deepEqual(u3.posted, [p3]);
  const posted = (await readEvents(db, loanId)).find((e) => e.type === "payment.posted" && e.payload["payment_id"] === p3); assert.ok(posted);
  assert.equal(posted.payload["interest_cents"], "151169"); assert.equal(posted.payload["principal_cents"], "38451"); assert.equal(posted.payload["escrow_cents"], "41230"); assert.deepEqual(posted.payload["installments"], ["2026-12-01"]);
  assert.equal(monthlyInterestBps(27_908_119n, 65000), 151_169n); assert.equal(151_711n - 151_169n, 542n); assert.equal(189_620n - 151_169n, 38_451n);
  assert.equal(u3.interest_variance_cents, 542n);
  const unit = (await readUnitRuns(db, loanId)).find((u) => u.as_of_date === "2026-12-01")!; assert.equal(unit.interest_variance_cents, 542n); assert.deepEqual(unit.payments_posted, [p3]);
  const satisfied = (await readEvents(db, loanId)).find((e) => e.type === "installment.satisfied" && e.payload["due_date"] === "2026-12-01"); assert.ok(satisfied);
  assert.equal(satisfied.payload["interest_variance_cents"], "542"); assert.equal(satisfied.payload["row_interest_cents"], "151711"); assert.equal(satisfied.payload["engine_interest_cents"], "151169"); assert.equal(satisfied.payload["payment_id"], p3);
  const dec = (await db.query<Row>(`SELECT status::text AS status, interest_cents, principal_cents, interest_variance_cents, satisfied_by_payment_id FROM loan_installments WHERE loan_id = $1 AND due_date = '2026-12-01'`, [loanId]))[0]!;
  assert.equal(dec["status"], "satisfied"); assert.equal(dec["interest_cents"], 151_711n); assert.equal(dec["principal_cents"], 37_909n); assert.equal(dec["interest_variance_cents"], 542n); assert.equal(dec["satisfied_by_payment_id"], p3);
  assert.equal(await count(`SELECT count(*)::bigint AS c FROM installment_schedule_runs WHERE loan_id = $1`, [loanId]), 1n, "re-projected only when 2.4's re-amortization activates new terms");
  assert.equal((await loanCashStateFromRows(db, loanId, D("2026-12-02"))).state.upb_cents, 27_908_119n - 38_451n);
});
test("35.5-T15: Given the demo clock at 2026-10-01 12:00 ET and the fixture book, when `POST /v1/demo/advance {days: 3}` runs, then `cycle_runs` holds one `cashiering_daily` run per day 2026-10-02 … 2026-10-04 with `units_total` = the active book, each loan has exactly one `done` unit row per day, `cashiering.daily.run_completed` was appended three times with the three `as_of_date`s, and `SM_CASHIERING_DAILY_RECEIPT_1D` never breached.", { skip }, async () => {
  // the demo clock at 2026-10-01 12:00 ET over the fixture book (T4's demo batch and every loan this file boarded): a second Runtime over the same database with the OffsetClock the demo advance steps
  const demoClock = new OffsetClock(new FixedClock("2026-10-01T16:00:00.000Z"));
  const rt2 = new Runtime({ db, registry: loadOverriddenRegistry(), clock: demoClock, databaseUrl: DB_URL });
  assert.equal(demoClock.now(), "2026-10-01T16:00:00.000Z"); assert.equal(wallClock(Date.parse(demoClock.now()), "America/New_York").hour, 12);
  const days = ["2026-10-02", "2026-10-03", "2026-10-04"] as const;
  // the spec's "when": `POST /v1/demo/advance {days: 3}` on the hosted API over rt2 — the route steps the OffsetClock through advanceDemoClock: each day crossed is
  // 35.3's cycles pass inline (the planner's `cashiering_daily` run, its units drained, the receipt elected — 35.3 rule 10), the flows' tick (servicingDailySweep yields
  // to the cycle, 35.3 D13) and the breach pass
  const server = createApiServer({ runtime: rt2, apiToken: TOKEN, logger: createLogger("json", () => undefined), console: false });
  const base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  let r: AdvanceReport;
  try {
    const res = await fetch(`${base}/v1/demo/advance`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ days: 3 }) });
    const body = (await res.json()) as Row; assert.equal(res.status, 200, JSON.stringify(body)); r = body as unknown as AdvanceReport;
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  assert.equal(r.advanced, true); assert.equal(r.complete, true); assert.equal(r.days_crossed, 3); assert.equal(r.to, "2026-10-04T16:00:00.000Z"); assert.equal(demoClock.now(), "2026-10-04T16:00:00.000Z");
  for (const d of days) assert.ok(r.steps.some((s) => s.date === d), `a step crossed ${d}`);
  assert.ok(r.steps.every((s) => s.flows === "ticked" && !("error" in s.sweep)), JSON.stringify(r.steps.map((s) => [s.date, s.flows, s.sweep])));
  // one cashiering_daily run per day with units_total = the active book, every loan one done unit row per day
  const book = (await selectBook(db, D("2026-10-04"), "2026-10-04T16:00:00.000Z")).loans.map((l) => l.loan_id); assert.ok(book.length >= 94 + 5, `the demo book, Plan 4927, both L-1s, P and N and the NY loan: ${book.length}`);
  assert.ok(!book.includes(loans.t1) && !book.includes(loans.t2), "T1's note and T-7 board after 2026-10-04");
  const cycles = ports35_5(rt2).cycles;
  for (const d of days) {
    const run = await cycles.run("cashiering_daily", d); assert.ok(run, d);
    // the active book as the day's planner saw it: a (cycle, period) is planned once (35.3 rule 3 — T11 planned 2026-10-02 before T12's NY loan and T13's L-1 were boarded into the past by this file's rewound clock; they join the next day's run), so the day's units are the book's loans that existed at its plan
    const planned = (await db.query<{ id: string }>(`SELECT l.id FROM loans l WHERE l.id = ANY($1::uuid[]) AND l.created_at <= (SELECT r.created_at FROM cycle_runs WHERE r.id = $2)`.replace("FROM cycle_runs WHERE r.id", "FROM cycle_runs r WHERE r.id"), [(await selectBook(db, D(d), `${d}T16:00:00.000Z`)).loans.map((l) => l.loan_id), run.run_id])).map((r) => r.id);
    assert.ok(planned.length >= 94 + 3, `${d}: the demo book and the loans boarded before the day's plan (${planned.length})`);
    assert.equal(run.period_key, d); assert.equal(run.as_of_date, d); assert.equal(run.status, "completed"); assert.equal(run.units_total, planned.length, d); assert.equal(run.units_done, run.units_total, d); assert.equal(run.units_dead, 0);
    const done = await db.query<{ loan_id: string; c: bigint }>(`SELECT loan_id, count(*)::bigint AS c FROM cashiering_unit_runs WHERE as_of_date = $1 AND outcome = 'done' GROUP BY loan_id`, [d]);
    assert.equal(done.length, planned.length, `${d}: one done row per active loan`); assert.ok(done.every((x) => x.c === 1n), `${d}: exactly one`); assert.deepEqual(new Set(done.map((x) => x.loan_id)), new Set(planned));
  }
  assert.equal((await cycles.run("cashiering_daily", "2026-10-04"))!.units_total, book.length, "by the last day every loan of the book is a unit");
  // the receipt appended once per day with the three as_of_dates; SM_CASHIERING_DAILY_RECEIPT_1D never breached — armed for the day after the last
  const receipts = await db.query<{ d: string; c: bigint }>(`SELECT payload->>'as_of_date' AS d, count(*)::bigint AS c FROM loan_events WHERE type = 'cashiering.daily.run_completed' AND payload->>'as_of_date' = ANY($1::text[]) GROUP BY 1 ORDER BY 1`, [[...days]]);
  assert.deepEqual(receipts, days.map((d) => ({ d, c: 1n })));
  assert.equal(await count(`SELECT count(*)::bigint AS c FROM loan_events WHERE type = 'timer.breached' AND payload->>'code' = 'SM_CASHIERING_DAILY_RECEIPT_1D'`), 0n);
  assert.equal(await count(`SELECT count(*)::bigint AS c FROM timers WHERE code = 'SM_CASHIERING_DAILY_RECEIPT_1D' AND status::text IN ('breached', 'satisfied_late')`), 0n);
  assert.equal(await count(`SELECT count(*)::bigint AS c FROM escalations WHERE payload->>'timer_code' = 'SM_CASHIERING_DAILY_RECEIPT_1D'`), 0n);
  const clocks = await readGlobalTimer(db, "SM_CASHIERING_DAILY_RECEIPT_1D");
  const armed = clocks.filter((t) => t.status === "armed"); assert.equal(armed.length, 1); assert.equal(armed[0]!.anchor_date, "2026-10-04"); assert.equal(armed[0]!.due_date, "2026-10-05");
  assert.ok(clocks.filter((t) => t.status !== "armed").every((t) => t.status === "satisfied"));
  assert.ok(r.breaches >= 0 && r.due >= 0);
});
test("35.5-T16: Given any tool of this process, then no tool changed a money column of `loan_installments` on a `satisfied` row, of `payments`, `fees` or `ledger_lines` except through 2.1's, 2.7's or 2.3's own commands (contract test: the ledger's line count and sums before and after `installments.write`, `installments.reproject`, `lockbox.item.resolve`, `servicing_config.write` and `servicer_profile.write` are identical), every write left an `agent_decisions` row with `rule_set_version`, and a fee waiver, a variance resolution changing an amount, or a return-action override by an agent actor is refused with nothing written.", { skip }, async () => {
  // the state after T7 / T8: T7's posted batch (item 1 to its L-1, item 2 unidentified, item 3 to its T-7 — both loans with a satisfied row), the 2026-11-03 batch's unidentified item, T8/T9's returned entry
  const batch = (await db.query<Row>(`SELECT id FROM lockbox_batches WHERE status = 'posted' AND items = 3 AND items_unidentified = 1 ORDER BY created_at LIMIT 1`))[0]!; assert.ok(batch);
  const [i1, i2, i3] = await readItems(db, String(batch["id"])) as [ItemRead, ItemRead, ItemRead]; assert.equal(i2.disposition, "unidentified"); const l1 = i1.matched_loan_id!; const t7 = i3.matched_loan_id!; assert.ok(l1 && t7);
  const i4 = (await db.query<ItemRead>(`SELECT id, disposition FROM lockbox_items WHERE disposition = 'unidentified' AND id <> $1 ORDER BY created_at LIMIT 1`, [i2.id]))[0]!; assert.ok(i4);
  const entry = (await readAchEntries(db, loans.l1ach))[0]!; assert.equal(entry.status, "returned");
  const OK = new Set(["cashiering.schedule.v1", "cashiering.allocation.v1", "cashiering.returns.v1", "35.5@config.v1"]);
  const snapshot = async () => ({ lines: await count(`SELECT count(*)::bigint AS c FROM ledger_lines`), sum: await count(`SELECT coalesce(sum(amount_cents), 0)::bigint AS c FROM ledger_lines`), abs: await count(`SELECT coalesce(sum(abs(amount_cents)), 0)::bigint AS c FROM ledger_lines`), sets: await count(`SELECT count(*)::bigint AS c FROM ledger_entry_sets`),
    satisfied: (await db.query<{ j: string }>(`SELECT to_jsonb(i)::text AS j FROM loan_installments i WHERE status IN ('satisfied', 'prepaid') ORDER BY loan_id, due_date`)).map((r) => r.j), fees: await count(`SELECT count(*)::bigint AS c FROM entity_records WHERE kind = 'fees'`), payments: await count(`SELECT count(*)::bigint AS c FROM entity_records WHERE kind = 'payments'`), returns: (await readAchReturns(db, entry.id)).map((r) => r.action_taken) });
  const dueMoney = async (loanId: string): Promise<string[]> => (await db.query<{ j: string }>(`SELECT to_jsonb(json_build_object('due_date', due_date, 'sequence', sequence, 'pi_cents', pi_cents, 'interest_cents', interest_cents, 'principal_cents', principal_cents, 'escrow_cents', escrow_cents, 'upb_before_cents', upb_before_cents, 'upb_after_cents', upb_after_cents, 'rate_bps', rate_bps, 'terms_id', terms_id, 'absorbs_rounding', absorbs_rounding, 'status', status))::text AS j FROM loan_installments WHERE loan_id = $1 AND status = 'due' ORDER BY due_date`, [loanId])).map((r) => r.j);
  const ruleSetOf = async (id: string): Promise<string> => String((await db.query<Row>(`SELECT rule_set_version FROM agent_decisions WHERE id = $1`, [id]))[0]?.["rule_set_version"]);
  const before = await snapshot();
  const unchanged = async (label: string, o: { payments?: boolean } = {}) => { const after = await snapshot(); assert.equal(after.lines, before.lines, `${label}: ledger line count`); assert.equal(after.sum, before.sum, `${label}: ledger sum`); assert.equal(after.abs, before.abs, `${label}: ledger |sum|`); assert.equal(after.sets, before.sets, `${label}: entry sets`); assert.deepEqual(after.satisfied, before.satisfied, `${label}: satisfied rows byte-identical`); assert.equal(after.fees, before.fees, `${label}: fees`); if (!o.payments) assert.equal(after.payments, before.payments, `${label}: payments`); assert.deepEqual(after.returns, before.returns, `${label}: return actions`); };
  // installments.write{loan_id, source: transfer} on L-1 (its 2026-09-01 row satisfied): rule 3 from the first due row — the due rows' money columns identical, the satisfied rows untouched, a decision under cashiering.schedule.v1
  const dueL1 = await dueMoney(l1); const runsL1 = await count(`SELECT count(*)::bigint AS c FROM installment_schedule_runs WHERE loan_id = $1`, [l1]);
  const w = await runtime.execute({ process: "35.5", name: "installments.write", loanId: l1, actor: CASHIERING_AGENT, input: { loan_id: l1, source: "transfer" } });
  assert.deepEqual(await dueMoney(l1), dueL1, "an idempotent re-run: identical due rows"); assert.equal(await count(`SELECT count(*)::bigint AS c FROM installment_schedule_runs WHERE loan_id = $1`, [l1]), runsL1 + 1n); await unchanged("installments.write");
  assert.equal(w.decisions.length, 1); assert.equal(await ruleSetOf(w.decisions[0]!.id), "cashiering.schedule.v1");
  // installments.reproject{loan_id, source: reprojection, effective_from: the first due row} on T-7 (its 2026-11-01 row satisfied — an effective date on it would be SATISFIED_ROW_FROZEN): the same result
  const firstDueT7 = (await readRows(db, t7)).find((r) => r.status === "due")!.due_date; const dueT7 = await dueMoney(t7);
  const rp = await runtime.execute({ process: "35.5", name: "installments.reproject", loanId: t7, actor: CASHIERING_AGENT, input: { loan_id: t7, source: "reprojection", effective_from: firstDueT7 } });
  assert.deepEqual(await dueMoney(t7), dueT7); await unchanged("installments.reproject"); assert.equal(await ruleSetOf(rp.decisions[0]!.id), "cashiering.schedule.v1");
  await assert.rejects(runtime.execute({ process: "35.5", name: "installments.reproject", loanId: t7, actor: CASHIERING_AGENT, input: { loan_id: t7, source: "reprojection", effective_from: "2026-11-01" } }), (e: unknown) => e instanceof CommandRefused && e.code === "SATISFIED_ROW_FROZEN"); await unchanged("installments.reproject (frozen)");
  // lockbox.item.resolve{item_id, loan_id, reason} by an ops_analyst: the item becomes L-1's payment (a payments version), no ledger line, the decision under cashiering.allocation.v1
  const rs = await runtime.execute({ process: "35.5", name: "lockbox.item.resolve", loanId: "", actor: ANALYST, input: { item_id: i2.id, loan_id: l1, reason: "payer letter names L-1" } });
  assert.equal((rs.output as Row)["disposition"], "identified"); assert.ok((rs.output as Row)["payment_id"]); await unchanged("lockbox.item.resolve", { payments: true }); assert.equal(await count(`SELECT count(*)::bigint AS c FROM entity_records WHERE kind = 'payments'`), before.payments + 1n);
  assert.equal(await ruleSetOf(rs.decisions[0]!.id), "cashiering.allocation.v1"); before.payments = before.payments + 1n;
  // servicing_config.write{loan_id} by the agent: a new row with the same defaults (the zone, the jurisdiction, the terms), under 35.5@config.v1
  const cfgBefore = (await db.query<Row>(`SELECT time_zone, time_zone_source, jurisdiction_state, nsf_fee_allowed, late_charge_terms FROM loan_servicing_configs WHERE loan_id = $1 ORDER BY effective_from DESC, created_at DESC LIMIT 1`, [l1]))[0]!; const cfgCount = await count(`SELECT count(*)::bigint AS c FROM loan_servicing_configs WHERE loan_id = $1`, [l1]);
  const cw = await runtime.execute({ process: "35.5", name: "servicing_config.write", loanId: l1, actor: CASHIERING_AGENT, input: { loan_id: l1 } });
  const cfgAfter = (await db.query<Row>(`SELECT time_zone, time_zone_source, jurisdiction_state, nsf_fee_allowed, late_charge_terms FROM loan_servicing_configs WHERE loan_id = $1 ORDER BY effective_from DESC, created_at DESC LIMIT 1`, [l1]))[0]!;
  assert.deepEqual(cfgAfter, cfgBefore); assert.equal(await count(`SELECT count(*)::bigint AS c FROM loan_servicing_configs WHERE loan_id = $1`, [l1]), cfgCount + 1n); await unchanged("servicing_config.write"); assert.equal(await ruleSetOf(cw.decisions[0]!.id), "35.5@config.v1");
  // servicer_profile.write{op: draft} by the agent: a draft version, its own decision under 35.5@config.v1, nothing rendered changes
  const pw = await runtime.execute({ process: "35.5", name: "servicer_profile.write", loanId: "", actor: CASHIERING_AGENT, input: { op: "draft", dba: "Supermortgage Servicing (draft)", reason: "T16 contract" } });
  const draft = pw.output as Row; assert.equal(draft["status"], "draft"); await unchanged("servicer_profile.write");
  assert.equal(await ruleSetOf(String(draft["decision_id"])), "35.5@config.v1"); assert.equal((await db.query<Row>(`SELECT status::text AS status FROM servicer_profiles WHERE id = $1`, [draft["profile_id"]]))[0]!["status"], "draft");
  // ach.return.action by the agent with no override: idempotent — the return was actioned (RETURN_ACTIONED), nothing written
  await assert.rejects(runtime.execute({ process: "35.5", name: "ach.return.action", loanId: loans.l1ach, actor: CASHIERING_AGENT, input: { entry_id: entry.id } }), (e: unknown) => e instanceof CommandRefused && e.code === "RETURN_ACTIONED"); await unchanged("ach.return.action (actioned)");
  // refused with nothing written: a fee waiver beyond 2.7 rule 5's courtesy limit by the agent (2.7's own guardrail — "requires officer"), a variance resolution naming an amount (NO_MONEY_FIELD, for the analyst and the officer alike — an amount is 6.5's command), a return-action override by an agent actor (officer only)
  const fee = (await db.query<{ id: string; loan_id: string }>(`SELECT id, loan_id FROM entity_current WHERE kind = 'fees' AND data->>'fee_type' = 'late_charge' AND data->>'state' = 'assessed' ORDER BY id LIMIT 1`))[0]!; assert.ok(fee);
  const feeVersions = await count(`SELECT count(*)::bigint AS c FROM entity_records WHERE kind = 'fees' AND id = $1`, [fee.id]);
  await assert.rejects(runtime.execute({ process: "2.7", name: "fees.waive", loanId: fee.loan_id, actor: CASHIERING_AGENT, input: { fee_id: fee.id, reason: "courtesy", beyond_courtesy_limit: true } }), (e: unknown) => e instanceof CommandRefused && e.code === "COURTESY_LIMIT" && /officer/.test(e.message));
  assert.equal(await count(`SELECT count(*)::bigint AS c FROM entity_records WHERE kind = 'fees' AND id = $1`, [fee.id]), feeVersions); assert.equal((await db.query<Row>(`SELECT data->>'state' AS st FROM entity_current WHERE kind = 'fees' AND id = $1`, [fee.id]))[0]!["st"], "assessed"); await unchanged("fees.waive");
  for (const actor of [ANALYST, OFFICER]) await assert.rejects(runtime.execute({ process: "35.5", name: "lockbox.item.resolve", loanId: "", actor, input: { item_id: i4.id, loan_id: l1, reason: "wrong amount", amount_cents: "1" } }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_MONEY_FIELD");
  assert.equal((await db.query<Row>(`SELECT disposition FROM lockbox_items WHERE id = $1`, [i4.id]))[0]!["disposition"], "unidentified"); await unchanged("lockbox.item.resolve (amount)");
  for (const actor of [CASHIERING_AGENT, ANALYST]) await assert.rejects(runtime.execute({ process: "35.5", name: "ach.return.action", loanId: loans.l1ach, actor, input: { entry_id: entry.id, action: "none_already_paid" } }), (e: unknown) => e instanceof CommandRefused && e.code === "RETURN_OVERRIDE_IS_OFFICER");
  await assert.rejects(runtime.execute({ process: "35.5", name: "ach.return.action", loanId: loans.l1ach, actor: CASHIERING_AGENT, input: { entry_id: entry.id, nsf_fee_cents: "1" } }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_MONEY_FIELD");
  await unchanged("ach.return.action (override)");
  // every write of this process's tools (the T-ids before this one and the calls above) left an agent_decisions row under one of its rule sets — none without rule_set_version
  const TOOLS = ["installments.write", "installments.reproject", "cashiering.run_unit", "lockbox.ingest", "lockbox.item.resolve", "ach.file.build", "ach.returns.ingest", "ach.return.action", "servicing_config.write", "servicer_profile.draft", "servicer_profile.activate"];   // servicer_profile.write records per op
  const written = await db.query<{ action: string; rule_set_version: string | null; n: bigint }>(`SELECT action, rule_set_version, count(*)::bigint AS n FROM agent_decisions WHERE action = ANY($1::text[]) GROUP BY 1, 2 ORDER BY 1, 2`, [TOOLS]);
  assert.deepEqual([...new Set(written.map((w) => w.action))].sort(), [...TOOLS].sort(), "a decision row for every tool of this process that wrote");
  for (const w of written) assert.ok(w.rule_set_version !== null && OK.has(w.rule_set_version), `${w.action}: rule_set_version ${String(w.rule_set_version)} (${w.n} rows)`);
});
