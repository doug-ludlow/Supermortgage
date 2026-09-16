// §35.5 rule 7 / rule 10 — `lockbox.item.resolve` and 2.1's posting of a lockbox item (src/domain/operations-runtime/lockbox.ts;
// src/app/tools/section2-1.ts postReceivedPayment): a person names the loan for an unidentified item (global- and loan-scoped
// commands) — the item becomes the loan's payment with no ledger line, the suspense item is matched, the decision is recorded;
// a disposition closes the item; the loan's next unit posts the item once (the ingest's receipt set reused; a credit the ingest
// parked on the clearing account's suspense released to the loan's suspense in a receipt-shaped set) and every set balances.
// The T-ids are in 35-5.spec.test.ts (T7: the batch; T16: the money contract over the tools); this file is their companion.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connect, type Db } from "../../infra/db/client.ts";
import { testDatabase } from "../../infra/db/test-db.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock, type Actor } from "../../kernel/events/index.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { CommandRefused } from "../../app/commands.ts";
import { Runtime } from "../../runtime/app.ts";
import { CASHIERING_AGENT } from "./installments.ts";
import { runCashieringUnit } from "./cashiering-cycle.ts";
import { ports35_5 } from "./ports-35-5.ts";
import { PgFakeLockboxQueue } from "./lockbox.ts";
import { encodeRemittance } from "../../infra/integrations/codecs/lockbox-remittance.ts";
import { boardTapeLoan, chicagoInstant, partnerPartyOf, readBatches, readEvents, readItems, readSet, seedCustodial, L1_TAPE, T7_TAPE } from "./harness-35-5.ts";

const { url: DB_URL, skip } = await testDatabase(import.meta.url);
const R = randomUUID().slice(0, 8);
const clock = new FixedClock("2026-10-16T14:00:00.000Z");
const ANALYST: Actor = { kind: "human", id: `analyst-${R}`, role: "ops_analyst" };
type Row = Record<string, unknown>;
let db: Db; let runtime: Runtime;
const count = async (sql: string, params: unknown[] = []): Promise<bigint> => (await db.query<{ c: bigint }>(sql, params))[0]!.c;

test.before(async () => { if (skip) return; db = connect(DB_URL); runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock }); });
test.after(async () => { if (!skip) await db.end(); });

test("35.5 rule 7: lockbox.item.resolve identifies or closes an item without a ledger line; the loan's next unit posts it once", { skip }, async () => {
  const l1 = await boardTapeLoan(runtime, clock, L1_TAPE, `B-L1-${R}`, D("2026-08-20")); const t7 = await boardTapeLoan(runtime, clock, T7_TAPE, `B-T7-${R}`, D("2026-10-16"));
  const custodial = await seedCustodial(db, await partnerPartyOf(db));
  const number = async (id: string): Promise<string> => (await db.query<{ n: string }>(`SELECT servicer_loan_number AS n FROM loans WHERE id = $1`, [id]))[0]!.n;
  const items = [
    { item_no: 1, scanline: await number(l1.loan_id), amount_cents: 219_257n, check_no: "1001", payer: "FAKE PAYER ONE", scanned_at: chicagoInstant(D("2026-11-02"), "09:14") },
    { item_no: 2, scanline: "", amount_cents: 150_000n, check_no: "2002", payer: "FAKE PAYER TWO", scanned_at: chicagoInstant(D("2026-11-02"), "10:00") },
    { item_no: 3, scanline: await number(t7.loan_id), amount_cents: 230_850n, check_no: "3003", payer: "FAKE PAYER THREE", scanned_at: chicagoInstant(D("2026-11-02"), "17:42") },
  ];
  clock.set("2026-11-02T23:55:00.000Z");
  const q1 = await PgFakeLockboxQueue.post(db, { lockbox_id: "LBX-1", file_name: "LBX1-20261102.txt", content: encodeRemittance({ lockbox_id: "LBX-1", file_date: "2026-11-02", items }), received_at: "2026-11-02T23:55:00.000Z" });
  const r1 = await runtime.execute({ process: "35.5", name: "lockbox.ingest", loanId: "", actor: CASHIERING_AGENT, input: { lockbox_id: "LBX-1", as_of_date: "2026-11-02" } });
  assert.equal((r1.output as Row).posted, 2);
  const batch = (await readBatches(db, q1.sha256))[0]!; const [i1, i2, i3] = await readItems(db, batch.id);
  const cash = ports35_5(runtime).cashRows;
  const linesBefore = await count(`SELECT count(*)::bigint AS c FROM ledger_lines`);

  // (1) global-scoped resolve to T-7 as ops_analyst — no ledger line; the suspense item matched; the payment identified with the parked account
  const res = await runtime.execute({ process: "35.5", name: "lockbox.item.resolve", loanId: "", actor: ANALYST, input: { item_id: i2!.id, loan_id: t7.loan_id, reason: "payer letter names T-7" } });
  const ro = res.output as Row; assert.equal(ro.disposition, "identified"); assert.ok(ro.payment_id); assert.equal(ro.loan_id, t7.loan_id); assert.equal(ro.parked_on, custodial.clearing);
  assert.equal(await count(`SELECT count(*)::bigint AS c FROM ledger_lines`), linesBefore, "resolve posts no ledger line");
  const i2b = (await readItems(db, batch.id))[1]!; assert.equal(i2b.disposition, "identified"); assert.equal(i2b.match_method, "manual"); assert.equal(i2b.matched_loan_id, t7.loan_id); assert.equal(i2b.payment_id, ro.payment_id); assert.equal((i2b.resolved_by as Row).role, "ops_analyst");
  const sus = await cash.suspenseItemById(i2!.suspense_item_id!); assert.ok(sus); assert.equal(sus.data.status, "matched"); assert.equal(sus.data.loan_id, t7.loan_id); assert.equal(sus.data.payment_id, ro.payment_id);
  const p2 = await cash.paymentById(t7.loan_id, String(ro.payment_id)); assert.ok(p2); assert.equal(p2.data.status, "identified"); assert.equal(p2.data.channel, "lockbox"); assert.equal(p2.data.match_method, "manual");
  assert.deepEqual(p2.data.receipt_parked_account, { custodial_account_id: custodial.clearing, account: "suspense_unapplied" }); assert.equal(p2.data.receipt_entry_set_id, sus.data.receipt_entry_set_id);
  assert.equal(res.decisions.length, 1); const d = (await db.query<Row>(`SELECT rule_set_version, action, subject_kind, subject_id FROM agent_decisions WHERE id = $1`, [res.decisions[0]!.id]))[0]!;
  assert.equal(d.rule_set_version, "cashiering.allocation.v1"); assert.equal(d.action, "lockbox.item.resolve"); assert.equal(d.subject_kind, "lockbox_item"); assert.equal(d.subject_id, i2!.id);
  assert.ok((await readEvents(db, t7.loan_id)).some((e) => e.type === "lockbox.item.identified" && e.payload.match_method === "manual" && e.payload.payment_id === ro.payment_id));
  assert.ok((await cash.receivedPayments(t7.loan_id)).some((p) => p.id === ro.payment_id));
  // resolving it again is refused; the agent is refused; a money key is refused
  await assert.rejects(runtime.execute({ process: "35.5", name: "lockbox.item.resolve", loanId: "", actor: ANALYST, input: { item_id: i2!.id, loan_id: l1.loan_id, reason: "again" } }), (e: unknown) => e instanceof CommandRefused && e.code === "ITEM_RESOLVED");
  await assert.rejects(runtime.execute({ process: "35.5", name: "lockbox.item.resolve", loanId: "", actor: CASHIERING_AGENT, input: { item_id: i2!.id, loan_id: l1.loan_id, reason: "agent" } }), (e: unknown) => e instanceof CommandRefused);
  await assert.rejects(runtime.execute({ process: "35.5", name: "lockbox.item.resolve", loanId: "", actor: ANALYST, input: { item_id: i2!.id, loan_id: l1.loan_id, reason: "money", amount_cents: 1n } }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_MONEY_FIELD");

  // (3) L-1's unit on 2026-11-02 posts item 1: 2.1 reuses the ingest's receipt set (no second `receipt <id>` set), allocation + split only
  const setsBefore = await count(`SELECT count(*)::bigint AS c FROM ledger_entry_sets`);
  clock.set("2026-11-02T20:00:00.000Z");
  const u1 = await runCashieringUnit(runtime, { loan_id: l1.loan_id, as_of_date: D("2026-11-02"), as_of_instant: "2026-11-02T20:00:00.000Z" });
  assert.equal(u1.outcome, "done", u1.error ?? ""); assert.deepEqual(u1.posted, [i1!.payment_id]);
  assert.equal((await readSet(db, `receipt ${i1!.payment_id}`)).length, 2, "one receipt set, two lines — not posted twice");
  assert.equal(await count(`SELECT count(*)::bigint AS c FROM ledger_entry_sets`), setsBefore + 2n, "allocation + cash split");
  const posted1 = (await readEvents(db, l1.loan_id)).find((e) => e.type === "payment.posted" && e.payload.payment_id === i1!.payment_id)!; assert.ok(posted1);
  const p1 = await cash.paymentById(l1.loan_id, i1!.payment_id!); assert.equal((posted1.payload.ledger_entry_set_ids as string[])[0], p1!.data.receipt_entry_set_id); assert.equal((posted1.payload.ledger_entry_set_ids as string[]).length, 3);
  assert.deepEqual(posted1.payload.installments, ["2026-09-01"]); assert.equal(posted1.payload.interest_cents, "135294"); assert.equal(posted1.payload.principal_cents, "22723"); assert.equal(posted1.payload.rule_path, "installments.applied:1");
  assert.equal(await count(`SELECT coalesce(sum(amount_cents),0)::bigint AS c FROM ledger_lines WHERE scope = 'loan' AND loan_id = $1 AND account = 'suspense_unapplied'`, [l1.loan_id]), 0n, "the receipt credit was released by the allocation");

  const linesAfterUnit1 = await count(`SELECT count(*)::bigint AS c FROM ledger_lines`);

  // (2) a second file with two unidentified items: one resolved loan-scoped (the command's scope is the loan), one rejected
  const items2 = [{ item_no: 1, scanline: "", amount_cents: 73_100n, check_no: "4004", payer: "FAKE PAYER FOUR", scanned_at: chicagoInstant(D("2026-11-03"), "09:00") }, { item_no: 2, scanline: "", amount_cents: 81_700n, check_no: "5005", payer: "FAKE PAYER FIVE", scanned_at: chicagoInstant(D("2026-11-03"), "09:30") }];
  clock.set("2026-11-03T23:55:00.000Z");
  const q2 = await PgFakeLockboxQueue.post(db, { lockbox_id: "LBX-1", file_name: "LBX1-20261103.txt", content: encodeRemittance({ lockbox_id: "LBX-1", file_date: "2026-11-03", items: items2 }), received_at: "2026-11-03T23:55:00.000Z" });
  const r2 = await runtime.execute({ process: "35.5", name: "lockbox.ingest", loanId: "", actor: CASHIERING_AGENT, input: { lockbox_id: "LBX-1", as_of_date: "2026-11-03" } });
  assert.equal((r2.output as Row).unidentified, 2); const batch2 = (await readBatches(db, q2.sha256))[0]!; assert.equal(batch2.status, "posted"); const [j1, j2] = await readItems(db, batch2.id);
  const resL = await runtime.execute({ process: "35.5", name: "lockbox.item.resolve", loanId: l1.loan_id, actor: ANALYST, input: { item_id: j1!.id, loan_id: l1.loan_id, reason: "loan-scoped" } });
  const j1b = (await readItems(db, batch2.id))[0]!; assert.equal(j1b.disposition, "identified"); assert.equal(j1b.payment_id, (resL.output as Row).payment_id);
  assert.equal((await cash.suspenseItemById(j1!.suspense_item_id!))!.data.status, "matched"); assert.ok(await cash.paymentById(l1.loan_id, String((resL.output as Row).payment_id)));
  const resR = await runtime.execute({ process: "35.5", name: "lockbox.item.resolve", loanId: "", actor: ANALYST, input: { item_id: j2!.id, disposition: "rejected", reason: "counterfeit" } });
  assert.equal((resR.output as Row).disposition, "rejected"); const j2b = (await readItems(db, batch2.id))[1]!; assert.equal(j2b.disposition, "rejected"); assert.equal(j2b.payment_id, null);
  assert.equal((await cash.suspenseItemById(j2!.suspense_item_id!))!.data.status, "rejected");
  assert.equal(await count(`SELECT count(*)::bigint AS c FROM ledger_lines`), linesAfterUnit1 + 4n, "the second batch's two receipt sets only");

  // (4) T-7's unit on 2026-11-03 posts item 3 (row 2026-11-01) and the resolved item 2: the parked credit moves from the clearing account's suspense to the loan's
  clock.set("2026-11-03T20:00:00.000Z");
  const u2 = await runCashieringUnit(runtime, { loan_id: t7.loan_id, as_of_date: D("2026-11-03"), as_of_instant: "2026-11-03T20:00:00.000Z" });
  assert.equal(u2.outcome, "done", u2.error ?? ""); assert.deepEqual([...u2.posted].sort(), [i3!.payment_id, String(ro.payment_id)].sort());
  const release = await readSet(db, `receipt ${String(ro.payment_id)}`);
  assert.deepEqual(release.map((l) => [l.scope, l.account, l.amount_cents, l.rule_ref, l.custodial_account_id ?? l.loan_id]), [["custodial", "suspense_unapplied", 150_000n, "2.1:r8:receipt", custodial.clearing], ["loan", "suspense_unapplied", -150_000n, "2.1:r8:receipt", t7.loan_id]]);
  assert.equal(await count(`SELECT coalesce(sum(amount_cents),0)::bigint AS c FROM ledger_lines WHERE scope = 'custodial' AND custodial_account_id = $1 AND account = 'suspense_unapplied'`, [custodial.clearing]), -154_800n, "item 2 released; the second batch's two items (73,100 + 81,700) still parked");
  const p2b = await cash.paymentById(t7.loan_id, String(ro.payment_id)); const p2ids = p2b!.data.ledger_entry_set_ids as string[];
  assert.equal(p2ids[0], sus.data.receipt_entry_set_id); assert.equal(p2ids[1], release[0]!.set_id);
  const post3 = (await readEvents(db, t7.loan_id)).find((e) => e.type === "payment.posted" && e.payload.payment_id === i3!.payment_id)!; assert.equal(post3.payload.interest_cents, "151915"); assert.equal(post3.payload.principal_cents, "37705");
  const row = (await db.query<Row>(`SELECT status, satisfied_by_payment_id FROM loan_installments WHERE loan_id = $1 AND due_date = '2026-11-01'`, [t7.loan_id]))[0]!; assert.equal(row.status, "satisfied"); assert.equal(row.satisfied_by_payment_id, i3!.payment_id);
  // (5) L-1's unit on 2026-11-03 posts the loan-scoped-resolved item (a partial: the parked credit released to the loan's suspense, then 2.2's hold)
  const uL = await runCashieringUnit(runtime, { loan_id: l1.loan_id, as_of_date: D("2026-11-03"), as_of_instant: "2026-11-03T20:00:00.000Z" });
  assert.equal(uL.outcome, "done", uL.error ?? ""); assert.deepEqual(uL.posted, [String((resL.output as Row).payment_id)]);
  const relL = await readSet(db, `receipt ${String((resL.output as Row).payment_id)}`);
  assert.deepEqual(relL.map((l) => [l.scope, l.account, l.amount_cents]), [["custodial", "suspense_unapplied", 73_100n], ["loan", "suspense_unapplied", -73_100n]]);
  assert.equal(await count(`SELECT coalesce(sum(amount_cents),0)::bigint AS c FROM ledger_lines WHERE scope = 'custodial' AND custodial_account_id = $1 AND account = 'suspense_unapplied'`, [custodial.clearing]), -81_700n, "only the rejected item stays parked");
  const pL = await cash.paymentById(l1.loan_id, String((resL.output as Row).payment_id)); assert.equal(pL!.data.status, "held"); assert.ok(pL!.data.suspense_item_id);
  assert.equal(await count(`SELECT coalesce(sum(amount_cents),0)::bigint AS c FROM ledger_lines WHERE scope = 'loan' AND loan_id = $1 AND account = 'suspense_unapplied'`, [l1.loan_id]), -73_100n, "the partial is held in the loan's suspense");
  // every set balanced
  const unbalanced = await db.query<Row>(`SELECT set_id FROM ledger_lines GROUP BY set_id HAVING sum(amount_cents) <> 0`); assert.equal(unbalanced.length, 0);
  assert.equal(p2b!.data.status, "held"); assert.equal(p2b!.data.allocation_outcome, "unapplied");
});
