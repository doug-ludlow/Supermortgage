/**
 * Boarding the demo transfer batch in the hosted runtime, against Postgres:
 * 100 loans staged, 94 boarded with terms, opening ledger sets, timers and
 * escalations, the summary readable over HTTP, a second run idempotent, and
 * the sweep working the timers boarding armed. Skips without a database.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { connect, reachable, type Db } from "../infra/db/client.ts";
import { loadOverriddenRegistry } from "../domain/timer-overrides.ts";
import { FixedClock } from "../kernel/events/index.ts";
import { generateDemoBatch, DEMO_BATCH } from "../domain/boarding/demo-batch.ts";
import { encodeTransferBatch } from "../domain/boarding/tape-codec.ts";
import { Runtime } from "./app.ts";
import { boardTransferBatch, batchUuid } from "./transfers.ts";
import { createApiServer, listen } from "./server.ts";
import { createLogger } from "./log.ts";

const DB_URL = process.env["TEST_DATABASE_URL"] ?? "postgresql://sm:sm@localhost/supermortgage_test";
const up = await reachable(DB_URL);
if (!up && process.env["REQUIRE_DB"]) throw new Error(`REQUIRE_DB set but ${DB_URL} is not reachable`);
const skip = up ? false : `no Postgres at ${DB_URL}`;
const TOKEN = "t-" + randomUUID();
// the batch id is unique per test run so re-running the suite against the same database boards a fresh batch each time
const BATCH_ID = `${DEMO_BATCH.batch_id}-${randomUUID().slice(0, 8)}`;

let db: Db; let runtime: Runtime; let base = ""; let close: () => Promise<void> = async () => undefined;
const clock = new FixedClock("2026-09-10T15:00:00.000Z");   // nine days after the transfer date

test.before(async () => {
  if (skip) return;
  execFileSync(fileURLToPath(new URL("../../db/migrate.sh", import.meta.url)), { env: { ...process.env, DATABASE_URL: DB_URL }, stdio: "pipe" });
  db = connect(DB_URL);
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger: createLogger("json", () => undefined) });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => server.close(() => db.end().then(() => resolve())));
});
test.after(async () => { await close(); });

test("the demo batch boards into Postgres: 94 loans active with terms and opening entries, 6 exceptions escalated, timers armed, idempotent on a second run", { skip }, async () => {
  // identifiers must be unique on the platform (HF-017): number this copy of the batch per run so repeated suites do not collide
  const run = Date.now() % 100_000;
  const demo = generateDemoBatch(DEMO_BATCH.seed, { prefix: `T${run}`, fnma_base: 5_000_000_000 + run * 1000, min_sequence_base: run * 1000 });
  const loans = demo.loans;
  const files = encodeTransferBatch(demo, demo.coborrowers);
  const input = { ...DEMO_BATCH, batch_id: BATCH_ID };
  const r = await boardTransferBatch(runtime, input, files, { kind: "system", id: "test" });
  assert.equal(r.status, "boarded"); assert.equal(r.batch_uuid, batchUuid(BATCH_ID));
  assert.deepEqual(r.loans, { staged: 100, validated: 94, exception: 6, boarded: 94 });
  assert.equal(Object.keys(r.hard_by_loan).length, 6); assert.ok(r.events > 300 && r.timers > 94 && r.escalations === 6, JSON.stringify({ e: r.events, t: r.timers, esc: r.escalations }));
  // the rows the console reads
  const n = async (sql: string, params: unknown[] = []): Promise<number> => Number((await db.query<{ c: string }>(sql, params))[0]!.c);
  assert.equal(await n(`SELECT count(*)::text AS c FROM loans WHERE boarding_batch_id = $1`, [r.batch_uuid]), 100);
  assert.equal(await n(`SELECT count(*)::text AS c FROM loans WHERE boarding_batch_id = $1 AND status = 'active'`, [r.batch_uuid]), 94);
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_terms WHERE loan_id IN (SELECT id FROM loans WHERE boarding_batch_id = $1)`, [r.batch_uuid]), 94);
  assert.equal(await n(`SELECT count(*)::text AS c FROM transfer_batch_loans WHERE batch_id = $1 AND boarding_status = 'boarded'`, [r.batch_uuid]), 94);
  assert.equal(await n(`SELECT count(*)::text AS c FROM transfer_batch_loans WHERE batch_id = $1 AND boarding_status = 'exception'`, [r.batch_uuid]), 6);
  assert.equal(await n(`SELECT count(*)::text AS c FROM escalations WHERE batch_id = $1 AND completed_at IS NULL`, [r.batch_uuid]), 6);
  assert.ok(await n(`SELECT count(*)::text AS c FROM boarding_validations WHERE batch_loan_id IN (SELECT id FROM transfer_batch_loans WHERE batch_id = $1) AND result = 'fail'`, [r.batch_uuid]) >= 6 + 41);
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_events WHERE type = 'loan.boarded' AND loan_id IN (SELECT id FROM loans WHERE boarding_batch_id = $1)`, [r.batch_uuid]), 94);
  // 1.6 opening entries: every boarded loan's principal balance equals its tape UPB, and each set balances to zero
  const principal = await db.query<{ loan_id: string; cents: string }>(`SELECT loan_id, sum(amount_cents)::text AS cents FROM ledger_lines WHERE scope = 'loan' AND account = 'principal' AND loan_id IN (SELECT id FROM loans WHERE boarding_batch_id = $1) GROUP BY loan_id`, [r.batch_uuid]);
  assert.equal(principal.length, 94);
  const byId = new Map(loans.map((l) => [r.loan_ids[l.transferor_loan_number]!, l]));
  for (const p of principal) assert.equal(BigInt(p.cents), byId.get(p.loan_id)!.upb_cents);
  assert.equal(await n(`SELECT count(*)::text AS c FROM (SELECT set_id FROM ledger_lines GROUP BY set_id HAVING sum(amount_cents) <> 0) x`), 0);
  // delinquent loans carry their derived flags; the first-cycle clock was satisfied by boarding on the transfer date
  // FDCPA debt-collector flag = delinquent at transfer OR bankruptcy OR foreclosure: the 18 delinquent loans (which include both foreclosures and one bankruptcy) plus the current chapter-7 loan
  assert.equal(await n(`SELECT count(*)::text AS c FROM loans WHERE boarding_batch_id = $1 AND fdcpa_debt_collector_flag`, [r.batch_uuid]), 19);
  assert.equal(await n(`SELECT count(*)::text AS c FROM timers WHERE code = 'SM_BOARD_FIRST_CYCLE' AND status = 'satisfied' AND loan_id IN (SELECT id FROM loans WHERE boarding_batch_id = $1)`, [r.batch_uuid]), 94);
  // the summary over HTTP, and the second run writes nothing
  const res = await fetch(`${base}/v1/transfers/batches/${encodeURIComponent(BATCH_ID)}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 200); assert.equal(((await res.json()) as { loans: { boarded: number } }).loans.boarded, 94);
  const again = await boardTransferBatch(runtime, input, files, { kind: "system", id: "test" });
  assert.equal(again.status, "already_on_platform");
  assert.equal(await n(`SELECT count(*)::text AS c FROM loans WHERE boarding_batch_id = $1`, [r.batch_uuid]), 100);
  // the sweep nine days after the transfer date breaches the clocks that fell due in between (MERS registration, hello notices, escrow setup …) and escalates them
  const sweep = await runtime.sweep(clock.now());
  const mine = sweep.breaches.filter((b) => b.loan_id && byId.has(b.loan_id));
  assert.ok(mine.length > 0, "some boarding-armed timers are past due by 09/10");
  assert.equal(await n(`SELECT count(*)::text AS c FROM timers WHERE status = 'breached' AND loan_id IN (SELECT id FROM loans WHERE boarding_batch_id = $1)`, [r.batch_uuid]), mine.length);
});

test("a batch whose transfer date is still ahead is staged and validated, not boarded", { skip }, async () => {
  const run = (Date.now() + 7) % 100_000;
  const demo = generateDemoBatch(DEMO_BATCH.seed, { prefix: `F${run}`, fnma_base: 6_000_000_000 + run * 1000, min_sequence_base: 50_000_000 + run * 1000 });
  const five = new Set(demo.loans.slice(0, 5).map((l) => l.transferor_loan_number));
  const data = { ...demo, loans: demo.loans.slice(0, 5), fnma: demo.fnma.slice(0, 5), trialBalance: demo.trialBalance.filter((t) => five.has(t.transferor_loan_number)), images: [], fairLending: [] };
  const r = await boardTransferBatch(runtime, { ...DEMO_BATCH, batch_id: `${BATCH_ID}-future`, transfer_date: "2026-11-02" as typeof DEMO_BATCH.transfer_date }, encodeTransferBatch(data, new Map()), { kind: "system", id: "test" });
  assert.equal(r.status, "staged"); assert.equal(r.loans.boarded, 0); assert.equal(r.loans.staged, 5);
  assert.equal(Number((await db.query<{ c: string }>(`SELECT count(*)::text AS c FROM loans WHERE boarding_batch_id = $1 AND status = 'staged'`, [r.batch_uuid]))[0]!.c), 5);
});
