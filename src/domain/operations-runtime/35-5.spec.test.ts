// 35.5 The installment schedule and the daily cashiering cycle: `loan_installments` at fund and at transfer boarding, the whole-book 2.1/2.7/2.3 sweep, lockbox ingest, ACH origination and NACHA returns as cycles, and the per-loan jurisdiction, time-zone and servicer-identity configuration
// spec/sections/35-operations-runtime/35-5-the-installment-schedule-and-the-daily-cashiering-cycle.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { connect, type Db } from "../../infra/db/client.ts";
import { testDatabase } from "../../infra/db/test-db.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock, type Actor } from "../../kernel/events/index.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { levelPayment, ratePercent } from "../../kernel/money/cents.ts";
import { CommandRefused } from "../../app/commands.ts";
import { Runtime } from "../../runtime/app.ts";
import { DEMO_NOTE } from "../../runtime/origination.ts";
import { loanCashState, sendPeriodicStatement, servicingDailySweep } from "../../runtime/servicing.ts";
import { delinquencyDailySweep } from "../../runtime/delinquency.ts";
import { FAKE_SERVICER_CONTACT } from "../../runtime/borrower/flows/9-servicing-requests.ts";
import { noteTermsHash, prepaidInterest } from "../orig-boarding/ops-30-2.ts";
import { assessLateCharge, lateChargeAmount, lateChargeTerms, nsfFee } from "../cashiering/latecharges.ts";
import { draftAmount, type Enrollment } from "../cashiering/autodraft.ts";
import { EI_NOTICE_VARIANTS, writtenNoticeRequest } from "../early-intervention/ops-11-2.ts";
import { CASHIERING_AGENT, registerReprojectionReactor, satisfyInstallments } from "./installments.ts";
import { FAKE_SERVICER_PROFILE_V1, STATE_DEFAULT_TIME_ZONE, servicerBlockFor } from "./servicing-config.ts";
import { boardTapeLoan, fundDemoNote, fundDemoNoteRaw, linkBorrowerParty, partnerPartyOf, readEvents, readRows, readRuns, readTimer, rowsJson, seedCustodial, L1_TAPE, NY_TAPE, T7_TAPE } from "./harness-35-5.ts";

// The harness (src/domain/operations-runtime/harness-35-5.ts): this file's own database from the migrated template (0142/0143 in
// place), one Runtime over it with a FixedClock the T-ids move, the fund path's partner party opened here, the transfer path's
// partner keyed by its servicer number as boardTransferBatch keys it. T-ids run in file order and hand each other their loans
// (T1's funded note and T2's tape T-7 are T12's two boarding paths; T13 boards L-1 itself).
const { url: DB_URL, skip } = await testDatabase(import.meta.url);
const R = randomUUID().slice(0, 8);
const clock = new FixedClock("2026-10-16T14:00:00.000Z");
const COMPLIANCE: Actor = { kind: "human", id: `compliance-${R}`, role: "compliance" };
const ANALYST: Actor = { kind: "human", id: `analyst-${R}`, role: "ops_analyst" };
let db: Db; let runtime: Runtime; let partnerPartyId = "";
const loans = { t1: "", t2: "", t3: "", l1: "" };
type Row = Record<string, unknown>;
const count = async (sql: string, params: unknown[] = []): Promise<bigint> => (await db.query<{ c: bigint }>(sql, params))[0]!.c;
const sum = (xs: readonly Record<string, unknown>[], k: string): bigint => xs.reduce((a, r) => a + (r[k] as bigint), 0n);
const profileV1 = async (): Promise<Row> => (await db.query<Row>(`SELECT id, legal_name, tin_encrypted, tin_last4, toll_free_phone, servicer_address, exclusive_address, remittance_address, portal_url, counselor_url, hud_phone, status::text AS status, effective_from::text AS effective_from, effective_to::text AS effective_to, version FROM servicer_profiles WHERE version = 1 AND legal_name = 'Supermortgage LLC' ORDER BY created_at LIMIT 1`))[0]!;

test.before(async () => {
  if (skip) return;
  db = connect(DB_URL);
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock });
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
  await db.tx((q) => satisfyInstallments(q, loanId, [{ due_date: D("2026-12-01"), payment_id: randomUUID(), credited_as_of: D("2026-12-01"), satisfied_on: D("2026-12-01") }]));
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
test("35.5-T4: Given the 100-loan demo book (transfer-boarded, `origination_application_id IS NULL`) and one originated loan, when the `cashiering_daily` cycle runs for a day, then `cycle_runs` shows `units_total = 101`, every loan has one `cashiering_unit_runs` row with `outcome = done` for that `as_of_date`, `cashiering.daily.run_completed{loans: 101}` is appended exactly once and satisfies `SM_CASHIERING_DAILY_RECEIPT_1D`, and running the cycle again for the same day writes no payment, fee, ledger line or unit row (the second run's decision records name the existing rows).", { todo: true });
test("35.5-T5: Given loan L-1 with a `payments` row in `received` for **$2,192.57** on 2026-09-03, when its unit runs on 2026-09-03, then 2.1 posts interest **$1,352.94**, principal **$227.23** and escrow **$612.40** with the balanced sets of 2.1 rule 8 (`rule_ref` on every line), row 2026-09-01 is `satisfied` with `satisfied_by_payment_id` set and `credited_as_of` 2026-09-03, and `POST /v1/loans/{id}/tools/2.1/payments.read%2Fwrite` with an `input.state` whose UPB differs from the ledger is refused `NO_CLIENT_STATE` before any write (contract test over `payments.read/write{op=post}`, `fees.assess{op=daily_run}` and `autodraft.read/write{op=amount_change_check}`).", { todo: true });
test("35.5-T6: Given L-1's row 2026-09-01 unpaid past the 15-day grace (grace end Wed 2026-09-16), when the unit runs on 2026-09-17 in the loan's zone, then 2.7's `daily_run` assesses **$79.01** (`fees{late_charge, assessed_on 2026-09-17, grace_end_on 2026-09-16}`, Dr `late_charges` / Cr `late_charge_income` 7,901), `installment.due_date_reached` was emitted by the unit on 2026-09-01 and not by any borrower flow, and the unit on 2026-09-18 assesses nothing (`late_charge_run = false`).", { todo: true });
test("35.5-T7: Given lockbox `LBX-1` (cut-off 17:00 `America/Chicago`) and the FAKE bank's file for 2026-11-02 with items $2,192.57 (L-1, scanned 09:14), $1,500.00 (no scanline) and $2,308.50 (T-7, scanned 17:42) and control total **$6,001.07**, when `lockbox_ingest` runs, then `lockbox_batches` has one row with `items = 3`, `variance_cents = 0` and `status = posted`, item 1 is a `payments` row (`channel = lockbox`, `received_on` 2026-11-02, `status = identified`), item 2 is a `suspense_items` row (`source = lockbox`) with `lockbox.item.unidentified`, item 3 is a `payments` row with `received_on` 2026-11-03, three receipt sets Dr `clearing_cash` / Cr `suspense_unapplied` exist for 219,257, 150,000 and 230,850, `lockbox.batch.received` armed `FNMA_C1101_LOCKBOX_CLEARING_1BD`, `lockbox.batch.posted{posted: 2, unidentified: 1}` satisfied `SM_LOCKBOX_BATCH_POSTED_1BD`, the same file ingested again writes nothing, and the file with control total $6,000.07 leaves the batch in `variance` with no payment row and an `officer` escalation.", { todo: true });
test("35.5-T8: Given L-1's active enrollment (draft day = due date, extra principal $100.00, validated) and the demo clock at Tue 2026-09-29 14:00 ET, when `ach_file_build` runs, then one `ach_files` row exists with one `ach_entries` row of **$2,292.57**, `effective_entry_date` 2026-10-01, description \"MORTGAGE PMT\" and `status = transmitted`, the file is a `documents` row with `sha256`, `ach.file.built` satisfied `SM_ACH_FILE_BUILD_1BD`; and given a second enrollment whose amount changed without a sent variable-amount notice and a third whose `validation_status = pending` (WEB), then neither has an entry and the build's decision names `REGE_1005_10D_VARIABLE_AMOUNT_NOTICE_10` and `NACHA_WEB_ACCOUNT_VALIDATION_GATE` as the refusals.", { todo: true });
test("35.5-T9: Given the entry of T8 settled 2026-10-01 and posted by L-1's unit (interest **$1,351.71**, principal **$228.46**, escrow **$612.40**, curtailment **$100.00**, row 2026-10-01 `satisfied`), when the FAKE ODFI's return file for Mon 2026-10-05 carries R01 on its trace number and `ach_returns_ingest` runs, then `ach_return_files` has one row, `ach.return.received{code: R01}` and a `payment_reversals` row (`reason = returned_item`, `return_code = R01`) exist with the mirror set for $2,292.57, row 2026-10-01 is `due` again with `installment.restored`, UPB and LPI are back to $249,546.77 and 2026-09-01, a `fees{nsf_fee}` row of **$25.00** exists, a reinitiation `ach_entries` row of **$2,292.57** with description \"RETRY PYMT\", `effective_entry_date` Thu 2026-10-08 and `reinitiation_count = 1` exists, `ach.return.actioned{action: reversed_reinitiated}` satisfied `SM_ACH_RETURN_ACTIONED_1BD`, and the same return file ingested again writes nothing.", { todo: true });
test("35.5-T10: Given the reinitiation of T9 is also returned R01 on 2026-10-12, when the return is actioned and the unit runs on 2026-10-17, then no further reinitiation is built (`NACHA_NSF_REINITIATION_180_MAX2` exhausted), the enrollment is `suspended_returns` with a hand-off escalation to `borrower-comms`, the 2026-10-17 run assesses **$79.01** on row 2026-10-01, and a second `fees{nsf_fee}` row exists for the second item; given instead a return coded R11, then no NSF fee exists and the corrected entry carries `reinitiation_of_entry_id`.", { todo: true });
test("35.5-T11: Given loan P (AZ, `America/Phoenix`) and loan N (NY, `America/New_York`) each with a `due` row for 2026-10-01, when the planner's `as_of` is 2026-10-02T06:30:00Z, then N's `cashiering_unit_runs.local_date` is 2026-10-02 and P's is 2026-10-01, `installment.due_date_reached{due_date: 2026-10-01}` was emitted for P on that pass and for N on the earlier pass whose local date was 2026-10-01, `LOAN_LOCAL_TZ` no longer exists in `src/runtime` (grep = 0), and a loan with no `loan_servicing_configs` row is refused `CONFIG_REQUIRED` by the unit with nothing written.", { todo: true });
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
test("35.5-T14: Given a 2.4 curtailment of $1,000.00 received on 2026-11-10 on T-7 (after row 2026-11-01 was satisfied), when the 2026-12-01 payment posts, then interest is `round_half_up((28,008,119 − 100,000) × 0.065 ÷ 12)` = $1,511.69 rather than the row's $1,517.11, the unit records the 542¢ difference against the row, and the schedule is re-projected only when 2.4's re-amortization activates new terms.", { todo: true });
test("35.5-T15: Given the demo clock at 2026-10-01 12:00 ET and the fixture book, when `POST /v1/demo/advance {days: 3}` runs, then `cycle_runs` holds one `cashiering_daily` run per day 2026-10-02 … 2026-10-04 with `units_total` = the active book, each loan has exactly one `done` unit row per day, `cashiering.daily.run_completed` was appended three times with the three `as_of_date`s, and `SM_CASHIERING_DAILY_RECEIPT_1D` never breached.", { todo: true });
test("35.5-T16: Given any tool of this process, then no tool changed a money column of `loan_installments` on a `satisfied` row, of `payments`, `fees` or `ledger_lines` except through 2.1's, 2.7's or 2.3's own commands (contract test: the ledger's line count and sums before and after `installments.write`, `installments.reproject`, `lockbox.item.resolve`, `servicing_config.write` and `servicer_profile.write` are identical), every write left an `agent_decisions` row with `rule_set_version`, and a fee waiver, a variance resolution changing an amount, or a return-action override by an agent actor is refused with nothing written.", { todo: true });
