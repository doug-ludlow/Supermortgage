// §35.5 rule 8 — the branches of the ACH cycles no T-id drives: a transmit the ODFI defers (retransmitted by the next build from the stored
// document; one whose bytes the store no longer holds is the officer's, never retried silently) and an `officer`'s override of the automatic
// return action through the hosted `ach.return.action` (the returned payment still reversed and 2.7's fee assessed; no retry — the one 2.3
// scheduled leaves its counter; `reversed_suspended` suspends the enrollment with the borrower-comms hand-off; the return's own date, the
// action's ET day). The fixtures are src/domain/operations-runtime/harness-35-5.ts's (L-1 and T-7 through the transfer route).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connect, type Db } from "../../infra/db/client.ts";
import { toJson } from "../../infra/db/client.ts";
import { testDatabase } from "../../infra/db/test-db.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock, type Actor } from "../../kernel/events/index.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { CommandRefused } from "../../app/commands.ts";
import { Runtime } from "../../runtime/app.ts";
import { CASHIERING_AGENT } from "./installments.ts";
import { runCashieringUnit } from "./cashiering-cycle.ts";
import { directNachaTransmit, installPorts35_5, ports35_5 } from "./ports-35-5.ts";
import { type ActionOutcome, type BuildReport, type ReturnsIngestReport } from "./ach.ts";
import { L1_TAPE, T7_TAPE, boardTapeLoan, enrollmentData, linkBorrowerParty, partnerPartyOf, readAchEntries, readAchFiles, readAchReturns, readEvents, readEventsOfType, readRows, seedCustodial, writePayment } from "./harness-35-5.ts";

const { url: DB_URL, skip } = await testDatabase(import.meta.url);
const R = randomUUID().slice(0, 8);
const clock = new FixedClock("2026-08-20T14:00:00.000Z");
const OFFICER: Actor = { kind: "human", id: `officer-${R}`, role: "officer" };
type Row = Record<string, unknown>;
let db: Db; let runtime: Runtime;
const loans = { a: "", b: "" }; const keys = { a: `E-A-${R}`, b: `E-B-${R}` };
const writeEnrollment = (loanId: string, id: string, o: Parameters<typeof enrollmentData>[2]): Promise<unknown> => runtime.execute({ process: "2.3", name: "autodraft.read/write", loanId, actor: CASHIERING_AGENT, input: { op: "write", id, data: enrollmentData(id, loanId, o) } });
const enrollmentRow = async (loanId: string, id: string): Promise<Row> => (await ports35_5(runtime).cashRows.enrollmentsFor(loanId)).find((e) => e.id === id)!.data;
const build = async (asOf: string): Promise<BuildReport> => (await runtime.execute({ process: "35.5", name: "ach.file.build", loanId: "", actor: CASHIERING_AGENT, input: { as_of_date: asOf } })).output as BuildReport;
const ingest = async (asOf: string): Promise<ReturnsIngestReport> => (await runtime.execute({ process: "35.5", name: "ach.returns.ingest", loanId: "", actor: CASHIERING_AGENT, input: { as_of_date: asOf } })).output as ReturnsIngestReport;
const count = async (sql: string, params: unknown[] = []): Promise<bigint> => (await db.query<{ c: bigint }>(sql, params))[0]!.c;
/** A return the ingest received but could not action (its action step threw): the entry `returned`, the `ach_returns` row unactioned — what an officer's `ach.return.action` finds. */
async function seedReceivedReturn(entryId: string, code: string, asOf: string, trace: string, amount: bigint): Promise<string> {
  const id = randomUUID();
  await db.query(`UPDATE ach_entries SET status = 'returned', return_code = $2, returned_at = $3 WHERE id = $1`, [entryId, code, `${asOf}T12:00:00.000Z`]);
  await db.query(`INSERT INTO ach_returns (id, entry_id, return_code, received_at, action_taken, raw) VALUES ($1, $2, $3, $4, NULL, $5::jsonb)`, [id, entryId, code, `${asOf}T12:00:00.000Z`, toJson({ kind: "return", code, original_trace: trace, amount_cents: amount.toString(), as_of_date: asOf, return_file_id: null })]);
  return id;
}

test.before(async () => {
  if (skip) return;
  db = connect(DB_URL);
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock });
});
test.after(async () => { if (!skip) await db.end(); });

test("ach.file.build: a transmit the ODFI defers is retransmitted by the next build from the stored document; one whose bytes the store no longer holds escalates to the officer once and is never retried silently", { skip }, async () => {
  // L-1 with September paid by its unit; the enrollment's October draft (2.3 example E) builds Tue 2026-09-29 for Thu 2026-10-01
  const l1 = await boardTapeLoan(runtime, clock, L1_TAPE, `B-A-${R}`, D("2026-08-20")); loans.a = l1.loan_id;
  await seedCustodial(db, await partnerPartyOf(db)); await linkBorrowerParty(db, loans.a, `a-${R}@example.test`);
  clock.set("2026-09-03T16:00:00.000Z");
  const sept = await writePayment(runtime, loans.a, { amount_cents: 219_257n, received_on: D("2026-09-03"), channel: "ach_debit_origin", instrument: "ach", designation: "contractual" });
  const u0 = await runCashieringUnit(runtime, { loan_id: loans.a, as_of_date: D("2026-09-03"), as_of_instant: "2026-09-03T16:00:00.000Z" }); assert.equal(u0.outcome, "done", u0.error ?? ""); assert.deepEqual(u0.posted, [sept]);
  await writeEnrollment(loans.a, keys.a, { draft_day: 1, extra_principal_cents: 10_000n, next_draft_on: D("2026-10-01"), last_debit_cents: 229_257n, last4: "1101" });
  // the ODFI is unreachable: the file is built, stored and left `deferred`; its entry stays `built`
  installPorts35_5(runtime, { transmit: { transmitAchFile: async () => ({ status: "deferred", reason: "FAKE ODFI outage" }) } });
  clock.set("2026-09-29T18:00:00.000Z");
  const b1 = await build("2026-09-29");
  assert.equal(b1.entries, 1); assert.equal(b1.transmitted, false); assert.equal(b1.ack_status, "deferred"); assert.equal(b1.transmit_reason, "FAKE ODFI outage"); assert.ok(b1.file_id);
  const f1 = (await readAchFiles(db)).find((f) => f.id === b1.file_id)!; assert.equal(f1.ack_status, "deferred"); assert.equal(f1.transmitted_at, null);
  const e1 = (await readAchEntries(db, loans.a))[0]!; assert.equal(e1.status, "built"); assert.equal(e1.file_id, b1.file_id); assert.equal(e1.amount_cents, 229_257n);
  assert.equal((await readEventsOfType(db, "ach.file.transmitted")).filter((x) => x.payload["file_id"] === b1.file_id).length, 0);
  // the ODFI is back: the next build (the same day — nothing new to build) retransmits the stored bytes; the file and its entry are transmitted
  installPorts35_5(runtime, { transmit: directNachaTransmit(runtime) });
  const b2 = await build("2026-09-29");
  assert.deepEqual(b2.retransmitted, [b1.file_id]); assert.equal(b2.entries, 0); assert.ok(b2.skipped.some((x) => x.enrollment_id === keys.a && x.reason === "already_built"));
  const f2 = (await readAchFiles(db)).find((f) => f.id === b1.file_id)!; assert.equal(f2.ack_status, "accepted"); assert.equal(f2.transmitted_at !== null, true);
  assert.equal((await readAchEntries(db, loans.a))[0]!.status, "transmitted");
  assert.equal((await readEventsOfType(db, "ach.file.transmitted")).filter((x) => x.payload["file_id"] === b1.file_id).length, 1);
  // a deferred file whose bytes are gone from the store: one officer escalation, `deferred_unretrievable`, never retried again
  const docId = (await db.query<{ id: string }>(`INSERT INTO documents (id, kind, sha256, byte_size, storage_uri, mime_type, retention_class, metadata) VALUES ($1, 'ach_file', $2, 12000, $3, 'text/plain', 'respa_5y', $4::jsonb) RETURNING id`, [randomUUID(), "f".repeat(64), `worm_pending:${R}`, toJson({ storage_status: "staged", fake_store: "35.5", file_name: `SM-ACH-LOST-${R}.ach` })]))[0]!.id;
  const lostId = randomUUID();
  await db.query(`INSERT INTO ach_files (id, file_id_modifier, built_at, entry_count, total_debit_cents, total_credit_cents, ack_status, document_id, hash) VALUES ($1, 'Z', $2, 0, 0, 0, 'deferred', $3, $4)`, [lostId, "2026-09-28T18:00:00.000Z", docId, "f".repeat(64)]);
  const b3 = await build("2026-09-29"); assert.deepEqual(b3.retransmitted, []);
  assert.equal((await readAchFiles(db)).find((f) => f.id === lostId)!.ack_status, "deferred_unretrievable");
  const esc = await db.query<Row>(`SELECT owner_role, status::text AS status, payload FROM escalations WHERE payload->>'rule_code' = 'ACH_FILE_RETRANSMIT_UNAVAILABLE'`); assert.equal(esc.length, 1);
  assert.equal(esc[0]!["owner_role"], "officer"); assert.equal(esc[0]!["status"], "open"); assert.equal((esc[0]!["payload"] as Row)["file_id"], lostId);
  await build("2026-09-29");
  assert.equal(await count(`SELECT count(*)::bigint AS c FROM escalations WHERE payload->>'rule_code' = 'ACH_FILE_RETRANSMIT_UNAVAILABLE'`), 1n, "escalated once");
});

test("ach.return.action: an officer's override — none_already_paid reverses the returned payment, assesses 2.7's fee and builds no retry (the one 2.3 scheduled leaves its counter); reversed_suspended suspends the enrollment with the borrower-comms hand-off; the return's own date, the action's ET day", { skip }, async () => {
  const cash = ports35_5(runtime).cashRows;
  // the entry of the first test settles Thu 2026-10-01 and L-1's unit posts it; a return the ingest received but could not action
  clock.set("2026-10-01T13:00:00.000Z");
  const i1 = await ingest("2026-10-01"); assert.equal(i1.settled.length, 1); const p1 = i1.settled[0]!.payment_id;
  const u1 = await runCashieringUnit(runtime, { loan_id: loans.a, as_of_date: D("2026-10-01"), as_of_instant: "2026-10-01T16:00:00.000Z" }); assert.equal(u1.outcome, "done", u1.error ?? ""); assert.deepEqual(u1.posted, [p1]);
  const eA = (await readAchEntries(db, loans.a))[0]!; assert.equal(eA.status, "settled");
  const retA = await seedReceivedReturn(eA.id, "R01", "2026-10-05", eA.trace_number!, 229_257n);
  // Mon 2026-10-05 22:00 ET (2026-10-06T02:00Z): the officer's none_already_paid — the borrower paid otherwise
  clock.set("2026-10-06T02:00:00.000Z");
  await assert.rejects(runtime.execute({ process: "35.5", name: "ach.return.action", loanId: loans.a, actor: CASHIERING_AGENT, input: { entry_id: eA.id, action: "none_already_paid" } }), (e: unknown) => e instanceof CommandRefused && e.code === "RETURN_OVERRIDE_IS_OFFICER");
  assert.equal((await readAchReturns(db, eA.id))[0]!.action_taken, null, "the agent's refused override wrote nothing");
  const r1 = await runtime.execute({ process: "35.5", name: "ach.return.action", loanId: loans.a, actor: OFFICER, input: { entry_id: eA.id, action: "none_already_paid" } });
  const o1 = r1.output as ActionOutcome;
  assert.equal(o1.action, "none_already_paid"); assert.equal(o1.override, "none_already_paid"); assert.equal(o1.returned_on, "2026-10-05"); assert.equal(o1.payment_id, p1); assert.equal(o1.reversed, true); assert.equal(o1.reversal_entry_set_ids.length, 3);
  assert.equal(o1.reinitiation_entry_id, null); assert.equal(o1.retry_on, null); assert.equal(o1.retry_suppressed, "2026-10-08"); assert.equal(o1.enrollment_status, "active"); assert.equal(o1.escalation_id, null); assert.equal(o1.return_id, retA);
  assert.equal((await readAchEntries(db, loans.a)).length, 1, "no retry entry"); assert.equal((await readAchReturns(db, eA.id))[0]!.action_taken, "none_already_paid");
  assert.equal((await cash.paymentById(loans.a, p1))!.data["status"], "reversed"); assert.equal((await readRows(db, loans.a)).find((r) => r.due_date === "2026-10-01")!.status, "due");
  const enrA = await enrollmentRow(loans.a, keys.a); assert.equal(enrA["status"], "active"); assert.deepEqual(enrA["reinitiations"], [], "the retry 2.3 scheduled is not counted"); assert.equal(enrA["returns_on_current_installment"], 1);
  const nsfA = (await cash.feesFor(loans.a)).filter((x) => x.data["fee_type"] === "nsf_fee"); assert.equal(nsfA.length, 1); assert.equal(nsfA[0]!.data["amount_cents"], "2500"); assert.equal(nsfA[0]!.data["assessed_on"], "2026-10-05", "the return's date, not the action's"); assert.equal(o1.nsf_fee_id, nsfA[0]!.id);
  const actA = (await readEvents(db, loans.a)).find((x) => x.type === "ach.return.actioned" && x.payload["entry_id"] === eA.id)!; assert.ok(actA);
  assert.equal(actA.payload["override"], "none_already_paid"); assert.equal(actA.payload["returned_on"], "2026-10-05"); assert.equal(actA.payload["actioned_on"], "2026-10-05", "the ET civil date of the clock"); assert.equal(actA.payload["retry_suppressed"], "2026-10-08"); assert.equal(actA.payload["retry_on"], null); assert.equal(actA.actor_id, OFFICER.id);
  assert.equal(r1.decisions.length, 1); const d1 = (await db.query<Row>(`SELECT rule_set_version, rule_code, approved_by, approved_role, rationale FROM agent_decisions WHERE id = $1`, [r1.decisions[0]!.id]))[0]!;
  assert.equal(d1["rule_set_version"], "cashiering.returns.v1"); assert.equal(d1["rule_code"], null); assert.equal(d1["approved_by"], OFFICER.id); assert.equal(d1["approved_role"], "officer"); assert.ok(String(d1["rationale"]).includes("officer override"));
  await assert.rejects(runtime.execute({ process: "35.5", name: "ach.return.action", loanId: loans.a, actor: OFFICER, input: { entry_id: eA.id, action: "none_already_paid" } }), (e: unknown) => e instanceof CommandRefused && e.code === "RETURN_ACTIONED");
  // T-7 with its own enrollment: built Fri 2026-10-30 for Mon 2026-11-02, settled and posted; the officer's reversed_suspended on its R01 of 2026-11-04
  clock.set("2026-10-16T14:00:00.000Z");
  const t7 = await boardTapeLoan(runtime, clock, T7_TAPE, `B-B-${R}`, D("2026-10-16")); loans.b = t7.loan_id; await seedCustodial(db, await partnerPartyOf(db)); await linkBorrowerParty(db, loans.b, `b-${R}@example.test`);
  await writeEnrollment(loans.b, keys.b, { draft_day: 1, extra_principal_cents: 0n, next_draft_on: D("2026-11-01"), last_debit_cents: 230_850n, last4: "7107" });
  clock.set("2026-10-30T18:00:00.000Z");
  const b7 = await build("2026-10-30"); assert.ok(b7.entries >= 1); const eB = (await readAchEntries(db, loans.b))[0]!; assert.ok(b7.entry_ids.includes(eB.id)); assert.equal(eB.amount_cents, 230_850n); assert.equal(eB.effective_entry_date, "2026-11-02");
  clock.set("2026-11-02T13:00:00.000Z");
  const i2 = await ingest("2026-11-02"); const pB = i2.settled.find((x) => x.entry_id === eB.id)!.payment_id; assert.ok(pB);
  const u2 = await runCashieringUnit(runtime, { loan_id: loans.b, as_of_date: D("2026-11-02"), as_of_instant: "2026-11-02T16:00:00.000Z" }); assert.equal(u2.outcome, "done", u2.error ?? ""); assert.deepEqual(u2.posted, [pB]);
  await seedReceivedReturn(eB.id, "R01", "2026-11-04", eB.trace_number!, 230_850n);
  clock.set("2026-11-05T13:00:00.000Z");
  const r2 = await runtime.execute({ process: "35.5", name: "ach.return.action", loanId: loans.b, actor: OFFICER, input: { entry_id: eB.id, action: "reversed_suspended" } });
  const o2 = r2.output as ActionOutcome;
  assert.equal(o2.action, "reversed_suspended"); assert.equal(o2.override, "reversed_suspended"); assert.equal(o2.returned_on, "2026-11-04"); assert.equal(o2.reversed, true); assert.equal(o2.reinitiation_entry_id, null); assert.equal(o2.retry_suppressed, "2026-11-09"); assert.equal(o2.enrollment_status, "suspended_returns"); assert.ok(o2.escalation_id);
  assert.equal((await readAchEntries(db, loans.b)).length, 1, "no retry entry");
  const enrB = await enrollmentRow(loans.b, keys.b); assert.equal(enrB["status"], "suspended_returns"); assert.equal(enrB["suspended_reason"], "RETURN_OVERRIDE"); assert.equal(enrB["suspended_on"], "2026-11-04"); assert.deepEqual(enrB["reinitiations"], []);
  const handoff = await db.query<Row>(`SELECT id, kind, owner_role, payload FROM escalations WHERE loan_id = $1 AND owner_role = 'borrower-comms'`, [loans.b]); assert.equal(handoff.length, 1);
  assert.equal(handoff[0]!["id"], o2.escalation_id); assert.equal(handoff[0]!["kind"], "human_portal_task"); assert.equal((handoff[0]!["payload"] as Row)["rule_code"], "RETURN_OVERRIDE"); assert.equal((handoff[0]!["payload"] as Row)["override"], "reversed_suspended");
  assert.ok((await readEvents(db, loans.b)).some((x) => x.type === "autodraft.status.changed" && x.payload["status"] === "suspended_returns" && x.payload["reason"] === "RETURN_OVERRIDE"));
  assert.equal((await readRows(db, loans.b)).find((r) => r.due_date === "2026-11-01")!.status, "due");
  const nsfAllowed = (await db.query<Row>(`SELECT nsf_fee_allowed FROM loan_servicing_configs WHERE loan_id = $1 ORDER BY effective_from DESC LIMIT 1`, [loans.b]))[0]!["nsf_fee_allowed"] === true;
  assert.equal((await cash.feesFor(loans.b)).filter((x) => x.data["fee_type"] === "nsf_fee").length, nsfAllowed ? 1 : 0);
  const d2 = (await db.query<Row>(`SELECT rule_code, approved_role FROM agent_decisions WHERE id = $1`, [r2.decisions[0]!.id]))[0]!; assert.equal(d2["rule_code"], null, "the officer's override is not 2.3's MAX-2 limit"); assert.equal(d2["approved_role"], "officer");
  // the suspended enrollment originates nothing on the next build
  clock.set("2026-11-27T18:00:00.000Z");
  const b8 = await build("2026-11-27"); const bIds = new Set((await readAchEntries(db, loans.b)).map((x) => x.id));
  assert.ok(!b8.entry_ids.some((id) => bIds.has(id))); assert.equal(bIds.size, 1); assert.ok(b8.entry_ids.length >= 1, "L-1's December draft still builds");
  assert.equal((await db.query<Row>(`SELECT set_id FROM ledger_lines GROUP BY set_id HAVING sum(amount_cents) <> 0`)).length, 0, "every set balanced");
});
