// 35.1 Persistence seam and the typed record
// spec/sections/35-operations-runtime/35-1-persistence-seam-and-the-typed-record.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// Every T-id here runs against Postgres (operational prerequisite 3: "this process's T-ids skip without a database and are
// not counted until it is on" — REQUIRE_DB=1 in CI); the file has its own database (src/infra/db/test-db.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { connect, type Db, type Queryable } from "../../infra/db/client.ts";
import { testDatabase } from "../../infra/db/test-db.ts";
import { PgLoanRepository, type Fixture } from "../../infra/db/loans.ts";
import { loadOverriddenRegistry } from "../../domain/timer-overrides.ts";
import { FixedClock, type Actor } from "../../kernel/events/index.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { Runtime } from "../../runtime/app.ts";
import { createApiServer, listen } from "../../runtime/server.ts";
import { createLogger } from "../../runtime/log.ts";
import { compute, defineTools, str, type EntityRecord, type ToolDef } from "../../app/tools.ts";
import { loadAgentsFile } from "../../app/agents.ts";
import { TOOLS_35_1 } from "../../app/tools/section35-1.ts";
import { StaleRecord } from "./seam/guard.ts";
import { SCOPE_LOCK_SQL } from "./seam/lock.ts";
import { HISTORY_KINDS } from "./projectors/index.ts";
import type { LoanCashState } from "../cashiering/types.ts";

const { url: DB_URL, skip } = await testDatabase(import.meta.url);
const TOKEN = "t-" + randomUUID();
const NOW = "2026-09-15T14:00:00.000Z";
const clock = new FixedClock(NOW);
const CASHIERING: Actor = { kind: "agent", id: "cashiering" };
const RECORDS: Actor = { kind: "agent", id: "security-records" };
const SYSTEM: Actor = { kind: "system", id: "test" };

let db: Db; let runtime: Runtime; let base = ""; let close: () => Promise<void> = async () => undefined;
let n = 0;
const uniq = (): string => `${Date.now() % 1_000_000}${(n++).toString().padStart(3, "0")}`.padStart(10, "0");
const count = async (q: Queryable, sql: string, params: unknown[] = []): Promise<number> => Number((await q.query<{ c: string }>(`SELECT count(*)::text AS c ${sql}`, params))[0]!.c);
const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
  const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) } : {}) });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

test.before(async () => {
  if (skip) return;
  db = connect(DB_URL);
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger: createLogger("json", () => undefined) });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => server.close(() => db.end().then(() => resolve())));
});
test.after(async () => { if (!skip) await close(); });

/** A boarded-looking servicing loan (loans, parties, property, the three custodial accounts). */
async function loanFixture(d: Db = db): Promise<Fixture> {
  return new PgLoanRepository(d).createFixture({ fnmaLoanNumber: uniq(), servicerLoanNumber: `SM-${randomUUID()}`, instrumentDate: D("2021-07-15"), originalUpbCents: 25_000_000n, originalTermMonths: 360, firstPaymentDate: D("2021-09-01"), maturityDate: D("2051-08-01") });
}

// ───────── worked example A: the loan 2.1 posts against (every figure is 2.1's; the projector copies) ─────────
const UPB_START = 24_831_055n;      // $248,310.55
const PI = 161_234n;                // $1,612.34
const ESCROW = 43_278n;             // $432.78
const PAYMENT = 204_512n;           // $2,045.12
const INTEREST = 134_502n;          // 248,310.55 × 6.5% ÷ 12 = 1,345.015479 → $1,345.02
const PRINCIPAL = 26_732n;          // $267.32
const UPB_AFTER = 24_804_323n;      // $248,043.23
/** The 2.x cash state of the worked-example loan with one due installment (what the runtime builds from loan_terms and the ledger; src/runtime/servicing.ts loanCashState). */
const cashState = (loanId: string, due: string[] = ["2026-09-01"]): LoanCashState => ({ loan_id: loanId, instrument_date: D("2021-07-15"), lien: "first", escrowed: true, note_rate_pct: "6.500", remittance_type: "A/A", upb_cents: UPB_START, lpi_date: D("2026-08-01"),
  installments: due.map((d) => ({ due_date: D(d), pi_cents: PI, escrow_cents: ESCROW, status: "due" as const })), late_charges_due_cents: 0n, nsf_fees_due_cents: 0n, other_fees_due_cents: 0n, suspense_unapplied_cents: 0n, holds: [], trial_active: false, plan_active: false, partial_count_12m: 0, opted_out_of_50_rule: false });
/** A received, identified 2.1 payment written through the bus (the version the typed row copies: channel, instrument, dates, idempotency key). */
async function receivePayment(rt: Runtime, f: Fixture, paymentId: string, receivedOn = "2026-09-01"): Promise<void> {
  await rt.execute({ process: "2.1", name: "payments.read/write", loanId: f.loanId, actor: CASHIERING, input: { op: "write", id: paymentId, data: { loan_id: f.loanId, custodial_account_id: f.custodial.clearing, channel: "lockbox", instrument: "check", amount_cents: PAYMENT, received_at: `${receivedOn}T15:00:00.000Z`, received_on: receivedOn, credited_as_of: receivedOn, conforming: true, designation: "contractual", payer_type: "borrower", idempotency_key: `sha256:${paymentId}`, status: "identified", identification_confidence: 1 } } });
}
const postPayment = (rt: Runtime, f: Fixture, paymentId: string, state: LoanCashState = cashState(f.loanId)): Promise<unknown> =>
  rt.execute({ process: "2.1", name: "payments.read/write", loanId: f.loanId, actor: CASHIERING, input: { op: "post", id: paymentId, loan_id: f.loanId, state, custodial: f.custodial } });

/** A test-only command on the bus (Runtime.executeDef takes any ToolDef; a `system` actor needs no allowlist). */
const testTool = (name: string, handler: ToolDef["handler"]): ToolDef => defineTools("35.1", "security-records", [{ name, kind: "act", handler: compute(handler) }])[0]!;

test("35.1-T1: Given loan with UPB $248,310.55 at 6.500%, fixed P&I $1,612.34 and escrow payment $432.78, when 2.1 posts a conforming payment of $2,045.12 through the bus against Postgres, then one `payments` row exists with `amount_cents = 204512`, `retention = 'life_of_loan_plus_4y'` and the version's idempotency key, three `payment_allocations` rows carry `amount_cents` 134502 (interest, from 248,310.55 × 6.5% ÷ 12 = 1,345.015479 → $1,345.02), 26732 (principal, $267.32) and 43278 (escrow, $432.78) with 2.1's `rule_ref` and the balanced set's `ledger_entry_set_id`, their sum is 204512, the version's UPB after is 24804323 ($248,043.23), the `entity_records` version and the typed rows carry identical values field by field, and one `entity_projections` row per version names `payments`/`payment_allocations`, `phase = commit` and the command's first event.", { skip }, async () => {
  const f = await loanFixture();
  const paymentId = randomUUID();
  await receivePayment(runtime, f, paymentId);
  const r = await runtime.execute({ process: "2.1", name: "payments.read/write", loanId: f.loanId, actor: CASHIERING, input: { op: "post", id: paymentId, loan_id: f.loanId, state: cashState(f.loanId), custodial: f.custodial } });
  const out = r.output as { interest_cents: string; principal_cents: string; escrow_cents: string; entry_set_ids: string[] };
  // 2.1's arithmetic, as the tool answered it: interest 248,310.55 × 6.500% ÷ 12 → $1,345.02; principal = P&I − interest; escrow as scheduled; the three sum to the payment
  assert.equal(BigInt(out.interest_cents), INTEREST); assert.equal(BigInt(out.principal_cents), PRINCIPAL); assert.equal(BigInt(out.escrow_cents), ESCROW);
  assert.equal(INTEREST + PRINCIPAL + ESCROW, PAYMENT);
  assert.equal(UPB_START - PRINCIPAL, UPB_AFTER);
  // the typed row exists in the command's own transaction: one payments row with the version's figures, the retention class 2.1 fixes and the version's own idempotency key
  const [pay] = await db.query<{ id: string; amount_cents: bigint; retention: string; idempotency_key: string; channel: string; instrument: string; received_on: string; credited_as_of: string; status: string; loan_id: string }>(`SELECT id, amount_cents, retention, idempotency_key, channel, instrument, received_on::text AS received_on, credited_as_of::text AS credited_as_of, status, loan_id FROM payments WHERE id = $1`, [paymentId]);
  assert.ok(pay, "one payments row"); assert.equal(pay.amount_cents, PAYMENT); assert.equal(pay.retention, "life_of_loan_plus_4y"); assert.equal(pay.idempotency_key, `sha256:${paymentId}`); assert.equal(pay.status, "posted"); assert.equal(pay.loan_id, f.loanId);
  assert.equal(await count(db, `FROM payments WHERE idempotency_key = $1`, [`sha256:${paymentId}`]), 1);
  // three payment_allocations rows in 2.1's order with 2.1's rule_ref and the balanced allocation set's id; their sum is the payment
  const allocs = await db.query<{ sequence: number; bucket: string; amount_cents: bigint; rule_ref: string; ledger_entry_set_id: string }>(`SELECT sequence, bucket, amount_cents, rule_ref, ledger_entry_set_id FROM payment_allocations WHERE payment_id = $1 ORDER BY sequence`, [paymentId]);
  assert.deepEqual(allocs.map((a) => [a.sequence, a.bucket, a.amount_cents]), [[1, "interest", INTEREST], [2, "principal", PRINCIPAL], [3, "escrow", ESCROW]]);
  assert.deepEqual(allocs.map((a) => a.rule_ref), ["2.1:r8:allocation:interest", "2.1:r8:allocation:principal", "2.1:r8:allocation:escrow"]);
  assert.equal(allocs.reduce((a, x) => a + x.amount_cents, 0n), PAYMENT);
  const allocSet = out.entry_set_ids[1]!;
  for (const a of allocs) assert.equal(a.ledger_entry_set_id, allocSet);
  const lines = await db.query<{ amount_cents: bigint; rule_ref: string }>(`SELECT amount_cents, rule_ref FROM ledger_lines WHERE set_id = $1`, [allocSet]);
  assert.equal(lines.reduce((a, l) => a + l.amount_cents, 0n), 0n, "the allocation set balances");
  for (const a of allocs) assert.equal(lines.find((l) => l.rule_ref === a.rule_ref)?.amount_cents, -a.amount_cents, `${a.bucket} matches the set's line by rule_ref`);
  // the version's UPB after, as 2.1 wrote it on the version — and the entity_records version and the typed rows carry identical values field by field
  const [ver] = await db.query<{ version: number; data: Record<string, unknown> }>(`SELECT version, data FROM entity_records WHERE kind = 'payments' AND id = $1 ORDER BY version DESC LIMIT 1`, [paymentId]);
  assert.equal(ver!.version, 2);
  assert.deepEqual(ver!.data["upb_after_cents"], { $bigint: UPB_AFTER.toString() });
  assert.deepEqual(ver!.data["amount_cents"], { $bigint: PAYMENT.toString() }); assert.equal(ver!.data["channel"], pay.channel); assert.equal(ver!.data["instrument"], pay.instrument); assert.equal(ver!.data["received_on"], pay.received_on); assert.equal(ver!.data["credited_as_of"], pay.credited_as_of); assert.equal(ver!.data["idempotency_key"], pay.idempotency_key); assert.equal(ver!.data["status"], pay.status);
  const vAlloc = ver!.data["allocations"] as { sequence: number; bucket: string; amount_cents: { $bigint: string }; rule_ref: string; ledger_entry_set_id: string }[];
  assert.deepEqual(vAlloc.map((a) => [a.sequence, a.bucket, BigInt(a.amount_cents.$bigint), a.rule_ref, a.ledger_entry_set_id]), allocs.map((a) => [a.sequence, a.bucket, a.amount_cents, a.rule_ref, a.ledger_entry_set_id]));
  // one entity_projections row per version: phase commit, the command's first event, the tables named
  const proj = await db.query<{ version: number; target_table: string; target_id: string; phase: string; command_event_id: string | null; mode: string }>(`SELECT version, target_table, target_id, phase, command_event_id, mode FROM entity_projections WHERE kind = 'payments' AND entity_id = $1 ORDER BY version`, [paymentId]);
  assert.equal(proj.length, 2);
  assert.deepEqual(proj.map((x) => [x.version, x.phase, x.mode, x.target_id]), [[1, "commit", "upsert", paymentId], [2, "commit", "upsert", paymentId]]);
  assert.equal(proj[0]!.target_table, "payments"); assert.equal(proj[1]!.target_table, "payments/payment_allocations");
  assert.equal(proj[1]!.command_event_id, r.events[0]!.id, "the command's first event");
  const [firstEv] = await db.query<{ type: string }>(`SELECT type FROM loan_events WHERE id = $1`, [proj[1]!.command_event_id!]);
  assert.ok(firstEv);
  // lag 0: the projection and the version share the transaction (a later version count equals the projection count)
  assert.equal(await count(db, `FROM entity_records WHERE kind = 'payments' AND id = $1`, [paymentId]), 2);
});
test("35.1-T2: Given a global `rate_sheets` row at version 3, when two commands each carry `expected_versions: [{rate_sheets, <id>, 3}]` and both write version 4, then the first commits and the second is refused `STALE_RECORD{kind: rate_sheets, id, expected: 3, current: 4}` with HTTP 409, and the refused command left no `loan_events` row, no `entity_records` row, no `agent_decisions` row and no ledger line (counts before and after are equal); given a command with no declared expectation whose commit collides on `entity_records`' primary key, then the same `STALE_RECORD` is returned and the transaction is rolled back whole.", { skip }, async () => {
  // a global rate_sheets row at version 3, written outside any command (the platform's rows)
  const rsId = `rs-${randomUUID().slice(0, 8)}`;
  const version = (v: number): EntityRecord => ({ kind: "rate_sheets", id: rsId, version: v, data: { rate_sheet_id: rsId, published_at: `2026-09-1${v}T12:00:00.000Z`, v }, updatedAt: NOW, updatedBy: "system:test" });
  await runtime.entities.save([version(1), version(2), version(3)], null);
  const fA = await loanFixture(); const fB = await loanFixture();
  const bump = (name: string, gate?: { started: () => void; release: Promise<void> }) => testTool(name, async (i, ctx, rt) => {
    const cur = rt.store.get("rate_sheets", str(i, "rate_sheet_id"))!;
    rt.store.put("rate_sheets", cur.id, { ...cur.data, v: cur.version + 1 }, ctx.actor, ctx.now);
    if (gate) { gate.started(); await gate.release; }
    return { wrote: cur.version + 1 };
  });
  // (a) two commands each carry expected_versions [{rate_sheets, id, 3}] and both write version 4: the first commits, the second is refused STALE_RECORD{expected: 3, current: 4}
  const first = await runtime.executeDef(bump("bump-a"), { loanId: fA.loanId, actor: SYSTEM, input: { rate_sheet_id: rsId, expected_versions: [{ kind: "rate_sheets", id: rsId, version: 3 }] } });
  assert.deepEqual(first.output, { wrote: 4 });
  const before = { events: await count(db, `FROM loan_events WHERE loan_id = $1`, [fB.loanId]), records: await count(db, `FROM entity_records WHERE kind = 'rate_sheets' AND id = $1`, [rsId]), decisions: await count(db, `FROM agent_decisions WHERE loan_id = $1`, [fB.loanId]), lines: await count(db, `FROM ledger_lines WHERE loan_id = $1`, [fB.loanId]) };
  assert.equal(before.records, 4);
  await assert.rejects(runtime.executeDef(bump("bump-b"), { loanId: fB.loanId, actor: SYSTEM, input: { rate_sheet_id: rsId, expected_versions: [{ kind: "rate_sheets", id: rsId, version: 3 }] } }),
    (e: unknown) => e instanceof StaleRecord && e.code === "STALE_RECORD" && e.kind === "rate_sheets" && e.id === rsId && e.expected === 3 && e.current === 4);
  // over HTTP the refusal is 409 STALE_RECORD (the guard runs before the domain code of any tool)
  const http = await call("POST", `/v1/loans/${fB.loanId}/tools/1.1/writeDecision`, { actor: { kind: "agent", id: "boarding" }, input: { agent: "boarding", action: "noop", rationale: "stale", rule_set_version: "x", expected_versions: [{ kind: "rate_sheets", id: rsId, version: 3 }] } });
  assert.equal(http.status, 409, JSON.stringify(http.body)); assert.equal(http.body["code"], "STALE_RECORD"); assert.equal(http.body["kind"], "rate_sheets"); assert.equal(http.body["id"], rsId); assert.equal(http.body["expected"], 3); assert.equal(http.body["current"], 4);
  const after = { events: await count(db, `FROM loan_events WHERE loan_id = $1`, [fB.loanId]), records: await count(db, `FROM entity_records WHERE kind = 'rate_sheets' AND id = $1`, [rsId]), decisions: await count(db, `FROM agent_decisions WHERE loan_id = $1`, [fB.loanId]), lines: await count(db, `FROM ledger_lines WHERE loan_id = $1`, [fB.loanId]) };
  assert.deepEqual(after, before, "the refused command left no loan_events, entity_records, agent_decisions or ledger line");
  // (b) no declared expectation: two commands on two loans both read version 4 and write version 5; the second's INSERT collides on entity_records' primary key → the same STALE_RECORD, the transaction rolled back whole
  let startedB!: () => void; let releaseA!: () => void; let releaseB!: () => void;
  const bStarted = new Promise<void>((res) => { startedB = res; }); const aGate = new Promise<void>((res) => { releaseA = res; }); const bGate = new Promise<void>((res) => { releaseB = res; });
  const pa = runtime.executeDef(bump("bump-c", { started: () => undefined, release: aGate }), { loanId: fA.loanId, actor: SYSTEM, input: { rate_sheet_id: rsId } });
  const pb = runtime.executeDef(bump("bump-d", { started: startedB, release: bGate }), { loanId: fB.loanId, actor: SYSTEM, input: { rate_sheet_id: rsId } });
  await bStarted;            // both have hydrated version 4 and put version 5
  releaseA(); const ra = await pa; assert.deepEqual(ra.output, { wrote: 5 });
  releaseB();
  await assert.rejects(pb, (e: unknown) => e instanceof StaleRecord && e.kind === "rate_sheets" && e.id === rsId && e.current === 5);
  assert.equal(await count(db, `FROM entity_records WHERE kind = 'rate_sheets' AND id = $1`, [rsId]), 5);
  assert.equal(await count(db, `FROM loan_events WHERE loan_id = $1`, [fB.loanId]), before.events, "nothing of the collided command was written");
});
test("35.1-T3: Given a loan whose `entity_records` hold 500 versions across 40 kinds including 12 versions of one `payments` row and 6 of one `counterparty_notifications` row, when any command runs, then the entity hydration issued exactly three queries (scoped latest, `HISTORY_KINDS` in full, global latest — asserted by a query-counting `Db`), the store holds one version of each non-history kind and every version of the two history kinds, `payments.history` (section02.ts:114) returns 12 versions in order, and 17.3's first-version gate (section17-3.ts:95) reads the first `counterparty_notifications` version's `status`.", { skip }, async () => {
  const f = await loanFixture();
  // 500 versions across 40 kinds on the loan: 12 versions of one payments row, 6 of one counterparty_notifications row, the rest spread over 38 kinds
  const paymentId = randomUUID(); const cnId = `cn-${randomUUID().slice(0, 8)}`;
  const rows: EntityRecord[] = [];
  for (let v = 1; v <= 12; v++) rows.push({ kind: "payments", id: paymentId, version: v, data: { loan_id: f.loanId, amount_cents: 100n * BigInt(v), status: v === 12 ? "posted" : "identified", v }, updatedAt: NOW, updatedBy: "system:seed" });
  for (let v = 1; v <= 6; v++) rows.push({ kind: "counterparty_notifications", id: cnId, version: v, data: { loan_id: f.loanId, batch_id: "B-1", status: v === 1 ? "planned" : v === 6 ? "acked" : "sent", v }, updatedAt: NOW, updatedBy: "system:seed" });
  const others = 500 - 18; const kinds = 38;
  for (let k = 0; k < others; k++) { const kind = `t3_kind_${k % kinds}`; const id = `${kind}-${Math.floor(k / kinds) % 2}`; rows.push({ kind, id, version: 1, data: { loan_id: f.loanId, k }, updatedAt: NOW, updatedBy: "system:seed" }); }
  // versions of one (kind, id) must be numbered 1..n: renumber the spread rows per (kind, id)
  const seen = new Map<string, number>();
  const numbered = rows.map((r) => { if (r.kind === "payments" || r.kind === "counterparty_notifications") return r; const key = `${r.kind} ${r.id}`; const v = (seen.get(key) ?? 0) + 1; seen.set(key, v); return { ...r, version: v }; });
  await runtime.entities.save(numbered, f.loanId);
  assert.equal(await count(db, `FROM entity_records WHERE loan_id = $1`, [f.loanId]), 500);
  assert.equal(new Set(numbered.map((r) => r.kind)).size, 40);
  // a query-counting Db around the pool: every statement that reads entity rows is counted, on the pool and inside a transaction
  const entityQueries: string[] = [];
  const countingQ = (q: Queryable): Queryable => ({ query: <R extends Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<R[]> => { if (/entity_(records|latest_scoped|current)/.test(sql) && /^\s*SELECT/i.test(sql)) entityQueries.push(sql); return q.query<R>(sql, params); } });
  const countingDb: Db = { query: (sql, params) => countingQ(db).query(sql, params), tx: (fn) => db.tx((q) => fn(countingQ(q))), dedicated: () => db.dedicated(), end: async () => undefined };
  const rt = new Runtime({ db: countingDb, registry: loadOverriddenRegistry(), clock });
  let held!: { nonHistory: number[]; paymentsHistory: number; cnHistory: number; firstCnStatus: unknown; kinds: number };
  await rt.executeDef(testTool("t3-inspect", (_i, _c, trt) => {
    const nonHistory = [...new Set(numbered.map((r) => r.kind))].filter((k) => !HISTORY_KINDS.has(k)).map((k) => trt.store.list(k).map((r) => trt.store.history(k, r.id).length)).flat();
    // 17.3's first-version gate reads the first counterparty_notifications version's status (src/app/tools/section17-3.ts:95)
    const firstCnStatus = trt.store.history("counterparty_notifications", cnId)[0]?.data.status;
    held = { nonHistory, paymentsHistory: trt.store.history("payments", paymentId).length, cnHistory: trt.store.history("counterparty_notifications", cnId).length, firstCnStatus, kinds: new Set(numbered.map((r) => r.kind)).size };
    return {};
  }), { loanId: f.loanId, actor: SYSTEM, input: {} });
  assert.equal(entityQueries.length, 3, `the entity hydration issued exactly three queries:\n${entityQueries.join("\n")}`);
  assert.match(entityQueries[0]!, /entity_latest_scoped/); assert.match(entityQueries[1]!, /FROM entity_records/); assert.match(entityQueries[2]!, /scope_key = ''/);
  assert.ok(held.nonHistory.length >= 38 && held.nonHistory.every((x) => x === 1), "one version of each non-history kind");
  assert.equal(held.paymentsHistory, 12); assert.equal(held.cnHistory, 6); assert.equal(held.firstCnStatus, "planned"); assert.equal(held.kinds, 40);
  // `payments.history` (section02.ts:114) returns the 12 versions in order
  const h = await rt.execute({ process: "2.2", name: "payments.history", loanId: f.loanId, actor: CASHIERING, input: { id: paymentId } });
  const versions = (h.output as { version: number }[]).map((x) => x.version);
  assert.deepEqual(versions, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});
test("35.1-T4: Given a tool whose handler writes a `payments` version, whose projector inserts the typed row, and which then throws, when the command runs, then the response is the tool's error, `payments` has no new row, `entity_records` and `entity_projections` have no new row, `loan_events` has no new event, and the next command on the same loan hydrates a `boarding` adapter whose maps equal those before the failed command (a hydrating adapter is rebuilt from the record, so a failed command cannot leave state in a Map).", { todo: true });
test("35.1-T5: Given two `Runtime` instances A and B over one database and a third `Runtime` acting as the sweep job, when A runs 25.2 `prepareCd` for an application, B runs 25.2 `deliverCd` for the same disclosure id, and the sweep runtime deems an LE received on its mailbox-rule day, then B never answers `no CD`, the CD B delivered is the CD A prepared (same `disclosure_id`, `data_hash` and `cd_version`), the sweep's deeming was performed by `LoanEstimateService.deemReceived` on a hydrated instance (no hand-appended `disclosure.le.deemed_received` exists in src/runtime/origination.ts: contract test greps the file for the literal), and every stateful key in `originationServices` (`cd-25-2`, `delivery-29-3`, `delivery-29-4`, `secondary`, `tolerance`, `companion`, `orig-boarding`) yields a fresh instance per command whose state after `hydrate` equals the state the instance that wrote the events held.", { todo: true });
test("35.1-T6: Given one loan and two 2.1 posts of $2,045.12 started concurrently from two connections, when both commit, then the second waited on `pg_advisory_xact_lock(hashtext('uow'), hashtext(loan_id))` (its transaction start is after the first's commit), the ledger holds two balanced sets, the loan's UPB after equals the start minus both principal portions, no unique violation and no `STALE_RECORD` occurred; given two different loans posted concurrently, then their transaction windows overlap (neither waited).", { skip }, async () => {
  // a Db that records, per transaction, when the loan lock was acquired and when the writes ended (just before COMMIT)
  const windows: { lockAt: string; preCommitAt: string; loanId: string }[] = [];
  const timing = (q: Queryable, w: { lockAt: string; preCommitAt: string; loanId: string }): Queryable => ({ query: async <R extends Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<R[]> => { const rows = await q.query<R>(sql, params); if (sql === SCOPE_LOCK_SQL) { w.loanId = String(params?.[0]); w.lockAt = (await q.query<{ t: string }>("SELECT clock_timestamp()::text AS t"))[0]!.t; } return rows; } });
  const timedDb: Db = { query: (sql, params) => db.query(sql, params), end: async () => undefined, dedicated: () => db.dedicated(), tx: (fn) => db.tx(async (q) => { const w = { lockAt: "", preCommitAt: "", loanId: "" }; const out = await fn(timing(q, w)); w.preCommitAt = (await q.query<{ t: string }>("SELECT clock_timestamp()::text AS t"))[0]!.t; if (w.lockAt) windows.push(w); return out; }) };
  const rt = new Runtime({ db: timedDb, registry: loadOverriddenRegistry(), clock });
  const f = await loanFixture();
  const p1 = randomUUID(), p2 = randomUUID();
  await receivePayment(rt, f, p1); await receivePayment(rt, f, p2, "2026-09-02");
  const startPrincipal = (await db.query<{ s: bigint }>(`SELECT coalesce(sum(amount_cents), 0)::bigint AS s FROM ledger_lines WHERE loan_id = $1 AND account = 'principal'`, [f.loanId]))[0]!.s;
  windows.length = 0;
  // two 2.1 posts of $2,045.12 on one loan, started concurrently from two connections (the pool), both against the same cash state
  const state = cashState(f.loanId, ["2026-09-01", "2026-10-01"]);
  const [r1, r2] = await Promise.all([postPayment(rt, f, p1, state), postPayment(rt, f, p2, state)]);
  for (const r of [r1, r2]) assert.equal(BigInt(((r as { output: { principal_cents: string } }).output).principal_cents), PRINCIPAL);
  const ws = windows.filter((w) => w.loanId === f.loanId).sort((a, b) => a.lockAt.localeCompare(b.lockAt));
  assert.equal(ws.length, 2);
  assert.ok(ws[1]!.lockAt > ws[0]!.preCommitAt, `the second waited on the loan lock: its transaction started after the first's commit (${ws[0]!.preCommitAt} < ${ws[1]!.lockAt})`);
  // the ledger holds two balanced sets per post (receipt, allocation, cash split): every set sums to zero
  const sets = await db.query<{ set_id: string; s: bigint }>(`SELECT set_id, sum(amount_cents)::bigint AS s FROM ledger_lines WHERE set_id IN (SELECT set_id FROM ledger_lines WHERE loan_id = $1) GROUP BY set_id`, [f.loanId]);
  const allocSets = [r1, r2].map((r) => (r as { output: { entry_set_ids: string[] } }).output.entry_set_ids[1]!);
  assert.ok(allocSets.every((id) => sets.some((x) => x.set_id === id && x.s === 0n)), "two balanced allocation sets"); assert.ok(sets.every((x) => x.s === 0n));
  const endPrincipal = (await db.query<{ s: bigint }>(`SELECT coalesce(sum(amount_cents), 0)::bigint AS s FROM ledger_lines WHERE loan_id = $1 AND account = 'principal'`, [f.loanId]))[0]!.s;
  assert.equal(endPrincipal, startPrincipal - 2n * PRINCIPAL, "the loan's UPB after equals the start minus both principal portions");
  assert.equal(await count(db, `FROM payment_allocations WHERE payment_id IN ($1, $2)`, [p1, p2]), 6, "no unique violation");
  assert.equal(await count(db, `FROM loan_events WHERE loan_id = $1 AND type = 'command.refused'`, [f.loanId]), 0, "no STALE_RECORD occurred");
  // two different loans posted concurrently: their transaction windows overlap — neither waited on the other
  const g1 = await loanFixture(); const g2 = await loanFixture();
  const q1 = randomUUID(), q2 = randomUUID();
  await receivePayment(rt, g1, q1); await receivePayment(rt, g2, q2);
  windows.length = 0;
  let release!: () => void; const gate = new Promise<void>((res) => { release = res; });
  const slow = testTool("t6-slow", async (_i, _c) => { await gate; return {}; });
  const a = rt.executeDef(slow, { loanId: g1.loanId, actor: SYSTEM, input: {} });
  await new Promise((r) => setTimeout(r, 150));
  const b = postPayment(rt, g2, q2, cashState(g2.loanId));
  await b; release(); await a;
  const wa = windows.find((w) => w.loanId === g1.loanId)!; const wb = windows.find((w) => w.loanId === g2.loanId)!;
  assert.ok(wb.lockAt > wa.lockAt && wb.preCommitAt < wa.preCommitAt, `overlapping windows: ${JSON.stringify({ wa, wb })}`);
});
test("35.1-T7: Given twelve armed timers past due and two sweeps started concurrently, when both finish, then one `sweep_runs` row is `completed` and one is `skipped{lease_held}` with `sweep.run_skipped{holder}` logged, exactly twelve `timer.breached` events and twelve escalations exist (never twenty-four), the completed run's `passes` names every pass with a duration, `sweep.run_completed{run_id, as_of_date}` is logged once, and `SM_SWEEP_HEARTBEAT_DAILY` is satisfied by it and re-armed for the next day on the global subject.", { todo: true });
test("35.1-T8: Given a queued FAKE `printMail` message and a queued message whose FAKE adapter is scripted to fail, when sweeps run at +0, +60 s, +180 s, +420 s, +900 s and +1,800 s (the `DEFAULT_RETRY` backoff instants), then the first message is `sent` on the first sweep with one `outbox_dispatches{attempt_no: 1, outcome: acked}` row and `integration.message.sent`, the failing message has five `outbox_dispatches` rows with `next_attempt_at` at the backoff instants and is `dead` after the fifth with `integration.message.dead{attempts: 5}`, a `human_portal_tasks` row and `SM_OUTBOX_DEAD_LETTER_REVIEW_1BD` armed; and when 34.4 requeues it and the adapter is un-scripted, then the next drain sends it and the clock is satisfied.", { todo: true });
test("35.1-T9: Given the hosted runtime, when `POST /v1/loans/{id}/tools/1.1/runValidation`, `POST /v1/applications/{id}/tools/30.2/snapshotOrigination` and `POST /v1/applications/{id}/tools/25.1/runToleranceTest{checkpoint: cd}` are called, then none answers 501 `not_wired`, the 25.1 result carries `delegated_to: \"21.5\"` and the `tolerance_test_id` of a `tolerance_tests` row 21.5's own tool (`21.5 runToleranceTest`) would have written for the same inputs, and `rt.services[\"tolerance-21-5\"] === rt.services[\"tolerance\"]` in a unit harness.", { todo: true });
test("35.1-T10: Given a decoded transfer tape of three loans, when `1.1 boardLoan` runs on the bus for the batch, then the transaction wrote `transfer_batches`, `properties`, `loans`, `borrowers`, `loan_borrowers`, `loan_terms`, `transfer_batch_loans`, `boarding_validations`, `parties` (transferor and servicer, found-or-inserted) and `custodial_accounts` (P&I and T&I, found-or-inserted) with the same columns `POST /v1/transfers/batches` writes (a row-by-row comparison against a batch boarded through the route on a second database), the events, the 1.6 opening ledger sets, the armed timers, one escalation per hard exception, the global `transfer_batches` entity row and one `agent_decisions` row; and `boardTransferBatch` in src/runtime/transfers.ts refuses with `SEED_ONLY` under `ENVIRONMENT=production`.", { todo: true });
test("35.1-T11: Given a command that writes a kind with no authored projector (`fee_gate_checks`) and one with a projector (`locks`), when the daily verify runs at 06:00 ET, then `locks` has its typed row and `entity_projections` row, `fee_gate_checks` has neither and one `projection_gaps{reason: no_projector, versions_unprojected: 1}` row names it, `record.gaps` lists it under `no_projector`, one `projection_runs{outcome: completed}` row and `projection.run_completed{gaps: 1, mismatches: 0}` exist, and `SM_PROJECTION_LAG_DAILY` is satisfied and re-armed; given the next day passes with no run, then the clock breaches and one sev 3 `ops_analyst` escalation names `SM_PROJECTION_LAG_DAILY`.", { todo: true });
test("35.1-T12: Given a store id `fees-3` written on two loans and a projector for `fees` authored afterwards, when `record.replay{kind: fees}` runs twice, then the first run minted two `entity_keys` rows (one per scope) with distinct uuids, wrote two `fees` rows keyed by those uuids and one `entity_projections{phase: replay}` row per version and logged `record.replayed{rows}`; the second run wrote zero rows and zero events and its decision record says `rows_written: 0`; and both JSON versions still carry the id `fees-3`.", { skip }, async () => {
  // `fees-3` written on two loans (store ids repeat across scopes, 0115) before any projector ran for the kind — the versions stand in JSONB
  const fA = await loanFixture(); const fB = await loanFixture();
  const fee = (loanId: string): Record<string, unknown> => ({ id: "fees-3", loan_id: loanId, fee_type: "late_charge", installment_due_date: "2026-09-01", amount_cents: "8062", assessed_on: "2026-09-17", grace_end_on: "2026-09-16", state: "assessed", collected_cents: "0" });
  await runtime.entities.save([{ kind: "fees", id: "fees-3", version: 1, data: fee(fA.loanId), updatedAt: NOW, updatedBy: "agent:cashiering" }], fA.loanId);
  await runtime.entities.save([{ kind: "fees", id: "fees-3", version: 1, data: fee(fB.loanId), updatedAt: NOW, updatedBy: "agent:cashiering" }], fB.loanId);
  const keysBefore = await count(db, `FROM entity_keys WHERE kind = 'fees' AND legacy_ref = 'fees-3' AND scope_key IN ($1, $2)`, [fA.loanId, fB.loanId]);
  assert.equal(keysBefore, 0);
  // the projector for `fees` is authored (src/domain/operations-runtime/projectors/section02.ts FEES); record.replay{kind: fees} runs twice
  const run = () => runtime.execute({ process: "35.1", name: "record.replay", loanId: "", actor: RECORDS, input: { kind: "fees" } });
  const first = await run();
  const o1 = first.output as { rows_written: number; versions: number; gaps: unknown[] };
  const mine = (await db.query<{ scope_key: string; target_uuid: string }>(`SELECT scope_key, target_uuid FROM entity_keys WHERE kind = 'fees' AND legacy_ref = 'fees-3' AND scope_key IN ($1, $2) ORDER BY scope_key`, [fA.loanId, fB.loanId]));
  assert.equal(mine.length, 2, "two entity_keys rows, one per scope"); assert.notEqual(mine[0]!.target_uuid, mine[1]!.target_uuid, "distinct uuids");
  const feeRows = await db.query<{ id: string; loan_id: string; amount_cents: bigint; fee_type: string }>(`SELECT id, loan_id, amount_cents, fee_type FROM fees WHERE id = ANY($1::uuid[]) ORDER BY loan_id`, [mine.map((k) => k.target_uuid)]);
  assert.equal(feeRows.length, 2); assert.deepEqual(new Set(feeRows.map((r) => r.loan_id)), new Set([fA.loanId, fB.loanId])); for (const r of feeRows) { assert.equal(r.amount_cents, 8_062n); assert.equal(r.fee_type, "late_charge"); }
  const proj = await db.query<{ phase: string; target_id: string; scope_key: string }>(`SELECT phase, target_id, scope_key FROM entity_projections WHERE kind = 'fees' AND entity_id = 'fees-3' AND scope_key IN ($1, $2) ORDER BY scope_key`, [fA.loanId, fB.loanId]);
  assert.deepEqual(proj.map((p) => p.phase), ["replay", "replay"]); assert.deepEqual(proj.map((p) => p.target_id), mine.map((k) => k.target_uuid));
  assert.ok(o1.rows_written >= 2, JSON.stringify(o1));
  assert.ok(first.events.some((e) => e.type === "record.replayed" && Number((e.payload as { rows: unknown }).rows) === o1.rows_written), "record.replayed{rows} logged");
  // the second run writes zero rows and zero events and its decision record says rows_written: 0
  const second = await run();
  const o2 = second.output as { rows_written: number };
  assert.equal(o2.rows_written, 0);
  assert.ok(!second.events.some((e) => e.type === "record.replayed"), "zero events");
  assert.equal(await count(db, `FROM entity_keys WHERE kind = 'fees' AND legacy_ref = 'fees-3' AND scope_key IN ($1, $2)`, [fA.loanId, fB.loanId]), 2);
  assert.equal(await count(db, `FROM fees WHERE id = ANY($1::uuid[])`, [mine.map((k) => k.target_uuid)]), 2);
  const [dec] = await db.query<{ rationale: string }>(`SELECT rationale FROM agent_decisions WHERE id = $1`, [second.decisions[0]!.id]);
  assert.equal((JSON.parse(dec!.rationale) as { rows_written: number }).rows_written, 0);
  // both JSON versions still carry the id fees-3
  const vers = await db.query<{ id: string; data: { id: string } }>(`SELECT id, data FROM entity_records WHERE kind = 'fees' AND loan_id IN ($1, $2)`, [fA.loanId, fB.loanId]);
  assert.equal(vers.length, 2); for (const v of vers) { assert.equal(v.id, "fees-3"); assert.equal(v.data.id, "fees-3"); }
});
test("35.1-T13: Given the projected rows of worked example A, when a test's UPDATE of `payment_allocations` is refused by its trigger and the test instead UPDATEs `payments.amount_cents` to 204513 and the verify runs, then one `projection_mismatches{column_name: amount_cents, is_money: true, json_value: '204512', row_value: '204513'}` row exists, `projection.mismatch_found{is_money: true}` is logged, one sev 1 `ciso` escalation names the row ids and the owning process 2.1, the run wrote no correction (`payments.amount_cents` is still 204513 and no `record.replayed` event exists), and the run's `outcome` is `completed`.", { todo: true });
test("35.1-T14: Given an application with 80 events across 21.2, 21.4, 21.5, 25.2 and 29.1, when `record.snapshot{service_key: cd-25-2}` writes a `service_snapshots` row at `through_sequence = N` and six more 25.2 commands run, then the next command's `cd-25-2` instance hydrated from the snapshot plus the events after N and its `state_sha256` equals the hash of an instance hydrated by full replay; and given the snapshot's `state` is tampered with, then hydration discards it, replays in full, logs `service.snapshot.written` for a fresh one and opens a sev 2 `ciso` escalation.", { todo: true });
test("35.1-T15: Given a money-field change proposed by the agent — `record.replay{kind: payments, overrides: {amount_cents: …}}` or any typed-row write that names a `*_cents` column not equal to the JSON version's — when no `officer` approval record exists, then the command is refused `NO_MONEY_FIELD_CHANGE` and nothing is written; and the seam's own tools (`record.project`, `record.replay`, `record.verify`, `record.snapshot`, `outbox.dispatch`) are absent from every money-field allowlist in `spec/registry/agents.json` (contract test).", { skip }, async () => {
  const before = { proj: await count(db, `FROM entity_projections`), keys: await count(db, `FROM entity_keys`), pay: await count(db, `FROM payments`), ev: await count(db, `FROM loan_events WHERE type = 'record.replayed'`), dec: await count(db, `FROM agent_decisions WHERE agent = 'security-records'`) };
  // a money-field change proposed by the agent with no officer approval record: refused NO_MONEY_FIELD_CHANGE, nothing written
  const attempt = await call("POST", "/v1/tools/35.1/record.replay", { actor: RECORDS, input: { kind: "payments", overrides: { amount_cents: "204513" } } });
  assert.equal(attempt.status, 409, JSON.stringify(attempt.body)); assert.equal(attempt.body["code"], "NO_MONEY_FIELD_CHANGE");
  const byHand = await call("POST", "/v1/tools/35.1/record.project", { actor: RECORDS, input: { kind: "payments", changes: { amount_cents: "1" } } });
  assert.equal(byHand.status, 409); assert.equal(byHand.body["code"], "NO_MONEY_FIELD_CHANGE");
  const after = { proj: await count(db, `FROM entity_projections`), keys: await count(db, `FROM entity_keys`), pay: await count(db, `FROM payments`), ev: await count(db, `FROM loan_events WHERE type = 'record.replayed'`), dec: await count(db, `FROM agent_decisions WHERE agent = 'security-records'`) };
  assert.deepEqual(after, before);
  // contract: the seam's own tools carry no money-field allowlist (no ToolDef.moneyFields — the bus's officer-waiver path never opens for them) and appear in no other process's allowlist in spec/registry/agents.json
  const seam = ["record.project", "record.replay", "record.verify", "record.snapshot", "outbox.dispatch"];
  for (const t of TOOLS_35_1) assert.equal(t.moneyFields, undefined, `${t.name} declares no money fields`);
  const agents = loadAgentsFile();
  for (const p of agents.processes) if (p.process !== "35.1") for (const t of seam) assert.ok(!p.tools.includes(t), `${t} is not in ${p.process}'s allowlist`);
  const raw = JSON.parse(readFileSync(fileURLToPath(new URL("../../../spec/registry/agents.json", import.meta.url)), "utf8")) as { processes: { process: string; guardrails?: string; tools: string[] }[] };
  const p351 = raw.processes.find((p) => p.process === "35.1")!;
  assert.match(p351.guardrails ?? "", /NO_MONEY_FIELD_CHANGE/);
  for (const p of raw.processes) if (p.process !== "35.1") for (const t of seam) assert.ok(!(p.guardrails ?? "").includes(t) || /never/.test(p.guardrails ?? ""), `${p.process}'s guardrails do not allow ${t} to touch money`);
});
