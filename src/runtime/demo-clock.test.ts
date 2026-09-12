/**
 * The demo clock (src/runtime/demo-clock.ts) over the hosted runtime on its OWN database (`supermortgage_demo_clock_test`:
 * dropped, created and migrated here, so no other suite's rows or clocks are in play): the demo transfer batch boards,
 * POST /v1/demo/advance walks 45 days through the sweep minute one calendar day at a time, every boarding-armed clock that
 * fell due breached on its own day (not at the end), a second advance to the same instant is a no-op, the persisted offset
 * survives a new Runtime and a following clock (serve mode) adopts another instance's advance unasked, a spent budget
 * stops between steps and the next advance to the same target carries on, and the routes refuse in production. The plan
 * and the request parsing are asserted without a database. Skips the database tests without Postgres (not a spec unit).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { connect, reachable, type Db } from "../infra/db/client.ts";
import { loadOverriddenRegistry } from "../domain/timer-overrides.ts";
import { FixedClock } from "../kernel/events/index.ts";
import { wallClock } from "../kernel/calendar/zoned.ts";
import { Runtime } from "./app.ts";
import { createApiServer, listen } from "./server.ts";
import { createLogger } from "./log.ts";
import { DEMO_ZONE, MAX_ADVANCE_DAYS, DEFAULT_ADVANCE_BUDGET_MS, OffsetClock, loadDemoClock, planSteps, targetOf, budgetOf, refiDailyOutcome, advanceDemoClock } from "./demo-clock.ts";

const DB_URL = process.env["DEMO_CLOCK_TEST_DATABASE_URL"] ?? "postgresql://sm:sm@localhost/supermortgage_demo_clock_test";
const ADMIN_URL = (() => { const u = new URL(DB_URL); u.pathname = "/postgres"; return u.toString(); })();
const up = await reachable(ADMIN_URL);
if (!up && process.env["REQUIRE_DB"]) throw new Error(`REQUIRE_DB set but ${ADMIN_URL} is not reachable`);
const skip = up ? false : `no Postgres at ${ADMIN_URL}`;
const TOKEN = "t-" + randomUUID();
const DAY = 86_400_000;
/** Thu Sep 10, 2026 12:00 EDT — nine days after the demo batch's transfer date, on the wall clock the other runtime suites use. */
const T0 = "2026-09-10T16:00:00.000Z";
const plus = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString();

// ---------------------------------------------------------------- the plan and the request, without a database
test("planSteps: 45 days from noon ET → noon ET of every day crossed, then the target; kinds and dates in order", () => {
  const to = plus(T0, 45 * DAY);
  const steps = planSteps(T0, to);
  assert.equal(steps.length, 45);
  assert.equal(steps[0]!.at, "2026-09-11T16:00:00.000Z"); assert.equal(steps[0]!.date, "2026-09-11"); assert.equal(steps[0]!.kind, "day");
  assert.deepEqual(steps.at(-1), { at: to, date: "2026-10-25", kind: "target" });
  assert.equal(steps.filter((s) => s.kind === "day").length, 44);
  for (let i = 1; i < steps.length; i++) { assert.ok(steps[i]!.at > steps[i - 1]!.at, "strictly increasing"); assert.equal(Date.parse(steps[i]!.date) - Date.parse(steps[i - 1]!.date), DAY, "consecutive calendar days"); }
  for (const s of steps) assert.equal(wallClock(Date.parse(s.at), DEMO_ZONE).date, s.date, "each step lands on its own ET day");
});
test("planSteps: across the DST end (Sun Nov 1, 2026) the day steps stay at noon ET — 16:00Z before, 17:00Z after", () => {
  const steps = planSteps("2026-10-30T16:00:00.000Z", "2026-11-03T17:00:00.000Z");
  assert.deepEqual(steps.map((s) => s.at), ["2026-10-31T16:00:00.000Z", "2026-11-01T17:00:00.000Z", "2026-11-02T17:00:00.000Z", "2026-11-03T17:00:00.000Z"]);
});
test("planSteps: later the same ET day is one target step; at or before now is empty; a day boundary in ET (not UTC) is what counts", () => {
  assert.deepEqual(planSteps(T0, plus(T0, 6 * 3_600_000)), [{ at: "2026-09-10T22:00:00.000Z", date: "2026-09-10", kind: "target" }]);
  assert.deepEqual(planSteps(T0, T0), []); assert.deepEqual(planSteps(T0, plus(T0, -DAY)), []);
  // 23:30 EDT Sep 10 → 00:30 EDT Sep 11 crosses one ET day, though both are Sep 11 in UTC
  assert.deepEqual(planSteps("2026-09-11T03:30:00.000Z", "2026-09-11T04:30:00.000Z"), [{ at: "2026-09-11T04:30:00.000Z", date: "2026-09-11", kind: "target" }]);
  assert.deepEqual(planSteps("2026-09-11T02:30:00.000Z", "2026-09-11T03:00:00.000Z"), [{ at: "2026-09-11T03:00:00.000Z", date: "2026-09-10", kind: "target" }]);
});
test(`planSteps: a single advance covers at most ${MAX_ADVANCE_DAYS} days`, () => {
  assert.equal(planSteps(T0, plus(T0, MAX_ADVANCE_DAYS * DAY)).length, MAX_ADVANCE_DAYS);
  assert.throws(() => planSteps(T0, plus(T0, (MAX_ADVANCE_DAYS + 1) * DAY)), /at most 400 days/);
  assert.throws(() => planSteps(T0, "not-a-date"), RangeError);
});
test("targetOf: exactly one of to / days; days is a positive number of 24-hour days from the demo's now", () => {
  assert.equal(targetOf(T0, { days: 45 }), plus(T0, 45 * DAY));
  assert.equal(targetOf(T0, { days: "1.5" }), plus(T0, 1.5 * DAY));
  assert.equal(targetOf(T0, { to: "2026-10-25T16:00:00Z" }), "2026-10-25T16:00:00.000Z");
  for (const bad of [{}, { to: T0, days: 1 }, { days: 0 }, { days: -3 }, { days: MAX_ADVANCE_DAYS + 1 }, { days: "soon" }, { to: "tomorrow" }, { to: 12 }]) assert.throws(() => targetOf(T0, bad as { to?: unknown; days?: unknown }), RangeError, JSON.stringify(bad));
  // budget_ms: absent is the default (under Cloud Run's 300 s request timeout), 0 is allowed (exactly one step), anything negative or not a number is refused
  assert.equal(budgetOf({}), DEFAULT_ADVANCE_BUDGET_MS); assert.ok(DEFAULT_ADVANCE_BUDGET_MS < 300_000); assert.equal(budgetOf({ budget_ms: null }), DEFAULT_ADVANCE_BUDGET_MS);
  assert.equal(budgetOf({ budget_ms: 0 }), 0); assert.equal(budgetOf({ budget_ms: "1500" }), 1500);
  for (const bad of [{ budget_ms: -1 }, { budget_ms: "soon" }, { budget_ms: Infinity }, { budget_ms: {} }]) assert.throws(() => budgetOf(bad as { budget_ms?: unknown }), RangeError, JSON.stringify(bad));
});
test("OffsetClock: the base clock plus the offset; refiDailyOutcome reads the sweep report's refi pass, tolerating its absence", () => {
  const base = new FixedClock(T0);
  assert.equal(new OffsetClock(base).now(), T0); assert.equal(new OffsetClock(base).offset, 0);
  const row = { id: 1n, advance_id: randomUUID(), step: 1, steps: 1, kind: "target" as const, offset_ms: BigInt(3 * DAY), demo_now: plus(T0, 3 * DAY), real_now: T0, actor: "human:ops", created_at: T0 };
  assert.equal(new OffsetClock(base, row).now(), plus(T0, 3 * DAY));
  const sweep = { at: T0, due: 0, breaches: [], outbox: [] };
  assert.equal(refiDailyOutcome(sweep as never), "absent");
  assert.equal(refiDailyOutcome({ ...sweep, refi: null } as never), "not_wired");
  assert.equal(refiDailyOutcome({ ...sweep, refi: { ran: true, reason: null } } as never), "ran");
  assert.equal(refiDailyOutcome({ ...sweep, refi: { ran: false, reason: "before 06:30 ET" } } as never), "skipped: before 06:30 ET");
  assert.equal(refiDailyOutcome({ ...sweep, refi: { ran: false, reason: "failed: no matrix" } } as never), "failed: no matrix");
});

// ---------------------------------------------------------------- over the runtime, on its own database
let db: Db; let runtime: Runtime; let clock: OffsetClock; let base = ""; let close: () => Promise<void> = async () => undefined;
const lines: string[] = [];
const borrowerOptions = { environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost"], urlSecret: "test-secret" };

test.before(async () => {
  if (skip) return;
  const name = new URL(DB_URL).pathname.slice(1);
  const a = connect(ADMIN_URL); await a.query(`DROP DATABASE IF EXISTS ${name}`); await a.query(`CREATE DATABASE ${name}`); await a.end();
  execFileSync(fileURLToPath(new URL("../../db/migrate.sh", import.meta.url)), { env: { ...process.env, DATABASE_URL: DB_URL }, stdio: "pipe" });
  db = connect(DB_URL);
  clock = await loadDemoClock(db, { base: new FixedClock(T0) });   // the "system" clock stands still, so every instant below is exact
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger: createLogger("json", (l) => { lines.push(l); if (process.env["DEMO_CLOCK_DEBUG"]) process.stderr.write(l + "\n"); }), console: false, borrower: borrowerOptions });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => server.close(() => db.end().then(() => resolve())));
});
test.after(async () => { if (!skip) await close(); });

async function call(method: string, path: string, body?: unknown, token: string | null = TOKEN): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}
const n = async (sql: string, params: unknown[] = []): Promise<number> => Number((await db.query<{ c: string }>(sql, params))[0]!.c);

const TARGET = plus(T0, 45 * DAY);   // Sun Oct 25, 2026 12:00 EDT
let firstStepAt = ""; let batchUuid = "";

test("GET /v1/demo/clock: before any advance the runtime reads the system clock — offset 0, no rows", { skip }, async () => {
  const r = await call("GET", "/v1/demo/clock");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body["now"], T0); assert.equal(r.body["real_now"], T0); assert.equal(r.body["offset_ms"], 0); assert.equal(r.body["rows"], 0); assert.equal(r.body["latest"], null); assert.equal(r.body["date"], "2026-09-10"); assert.equal(r.body["zone"], DEMO_ZONE);
  assert.equal(runtime.clock.now(), T0);
});

test("the demo batch boards, then POST /v1/demo/advance {days: 45} walks 45 calendar days through the sweep minute: every boarding clock that fell due breached on its own day, none is left armed past due, the offset is 45 days", { skip }, async () => {
  const boarded = await call("POST", "/v1/transfers/batches/demo", {});
  assert.equal(boarded.status, 200, JSON.stringify(boarded.body));
  assert.equal((boarded.body["loans"] as { boarded: number }).boarded, 94); batchUuid = String(boarded.body["batch_uuid"]);
  // what the demo boards arms (1.1's clocks off loan.boarded / the batch cutover, the 11.x windows on the delinquent loans …): some fall due inside the window, none has breached yet
  const dueInWindow = await n(`SELECT count(*)::text AS c FROM timers WHERE status = 'armed' AND due_at <= $1`, [TARGET]);
  const dueAlready = await n(`SELECT count(*)::text AS c FROM timers WHERE status = 'armed' AND due_at <= $1`, [T0]);
  assert.ok(dueInWindow > dueAlready && dueAlready > 0, `armed and due by the target: ${dueInWindow}, already past due at T0: ${dueAlready}`);
  assert.equal(await n(`SELECT count(*)::text AS c FROM timers WHERE status = 'breached'`), 0);
  const eventsBefore = await n(`SELECT count(*)::text AS c FROM loan_events`);

  const r = await call("POST", "/v1/demo/advance", { days: 45, actor: { kind: "human", id: "u-demo", role: "ops_analyst" } });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 600));
  const report = r.body as { advanced: boolean; complete: boolean; advance_id: string; from: string; requested_to: string; to: string; days_crossed: number; steps: { at: string; date: string; kind: string; flows: string; refi_daily: string; sweep: { due?: number; breaches?: number; error?: string } }[]; steps_remaining: number; budget_ms: number; due: number; breaches: number; offset_ms: number };
  assert.equal(report.advanced, true); assert.equal(report.complete, true); assert.equal(report.steps_remaining, 0); assert.equal(report.budget_ms, DEFAULT_ADVANCE_BUDGET_MS); assert.equal(report.from, T0); assert.equal(report.requested_to, TARGET); assert.equal(report.to, TARGET); assert.equal(report.days_crossed, 45); assert.equal(report.offset_ms, 45 * DAY);
  assert.equal(report.steps.length, 45); firstStepAt = report.steps[0]!.at;
  assert.equal(firstStepAt, "2026-09-11T16:00:00.000Z"); assert.equal(report.steps.at(-1)!.kind, "target"); assert.equal(report.steps.at(-1)!.at, TARGET);
  for (const s of report.steps) { assert.equal(s.flows, "ticked", `the flows' tick ran at ${s.at}`); assert.equal(s.refi_daily, "not_wired", "no rate feed on this runtime: the sweep reports the refinance pass as not wired"); assert.equal(s.sweep.error, undefined, `sweep at ${s.at}: ${s.sweep.error}`); }
  assert.equal(report.breaches, report.steps.reduce((a, s) => a + (s.sweep.breaches ?? 0), 0));
  assert.ok(report.steps.filter((s) => (s.sweep.breaches ?? 0) > 0).length >= 3, `breaches landed on several different days: ${report.steps.map((s) => s.sweep.breaches).join(",")}`);

  // the clock everything reads
  assert.equal(clock.now(), TARGET); assert.equal(runtime.clock.now(), TARGET);
  const status = await call("GET", "/v1/demo/clock");
  assert.equal(status.body["now"], TARGET); assert.equal(status.body["rows"], 45); assert.equal(status.body["offset_days"], 45); assert.equal(status.body["date"], "2026-10-25"); assert.equal(status.body["following"], false); assert.equal(status.body["default_budget_ms"], DEFAULT_ADVANCE_BUDGET_MS);
  assert.equal((status.body["latest"] as { kind: string; step: number; steps: number; actor: string }).kind, "target"); assert.equal((status.body["latest"] as { step: number }).step, 45); assert.equal((status.body["latest"] as { actor: string }).actor, "human:u-demo");

  // the history: one row per step, one advance, one row per calendar day, the offset never decreasing
  const rows = await db.query<{ advance_id: string; step: number; steps: number; kind: string; offset_ms: bigint; demo_now: string; real_now: string }>(`SELECT advance_id, step, steps, kind, offset_ms, demo_now, real_now FROM demo_clock ORDER BY id`);
  assert.equal(rows.length, 45); assert.equal(new Set(rows.map((x) => x.advance_id)).size, 1); assert.equal(rows[0]!.advance_id, report.advance_id);
  assert.deepEqual(rows.map((x) => x.step), rows.map((_x, i) => i + 1)); assert.ok(rows.every((x) => x.steps === 45 && x.real_now === T0));
  assert.equal(rows.filter((x) => x.kind === "day").length, 44); assert.equal(rows.at(-1)!.kind, "target"); assert.equal(rows.at(-1)!.demo_now, TARGET); assert.equal(rows.at(-1)!.offset_ms, BigInt(45 * DAY));
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i]!.offset_ms >= rows[i - 1]!.offset_ms, "the offset only grows");
  assert.equal(await n(`SELECT count(DISTINCT (demo_now AT TIME ZONE 'America/New_York')::date)::text AS c FROM demo_clock`), 45);

  // the clocks: nothing armed is left past due; what fell due breached — on its own day, not at the end of the advance
  assert.equal(await n(`SELECT count(*)::text AS c FROM timers WHERE status = 'armed' AND due_at <= $1`, [TARGET]), 0, "every armed timer due by the target was swept");
  const breached = await n(`SELECT count(*)::text AS c FROM timers WHERE status = 'breached'`);
  assert.ok(breached >= dueInWindow, `breached ${breached} ≥ the ${dueInWindow} armed and due by the target when the advance began`);
  assert.equal(breached, report.breaches, "the report counts every breach the steps made");
  assert.equal(await n(`SELECT count(*)::text AS c FROM timers WHERE status = 'breached' AND due_at <= $1 AND breached_at <> $2`, [T0, firstStepAt]), 0, "what was already past due at T0 breached on the first step");
  assert.equal(await n(`SELECT count(*)::text AS c FROM timers WHERE status = 'breached' AND due_at > $1 AND (breached_at < due_at OR breached_at > due_at + interval '36 hours')`, [T0]), 0, "a timer that fell due inside the window breached within the next sweep day, never later");
  assert.ok(await n(`SELECT count(DISTINCT (breached_at AT TIME ZONE 'America/New_York')::date)::text AS c FROM timers WHERE status = 'breached' AND due_at > $1`, [T0]) >= 3, "breaches inside the window landed on at least three different ET days");
  // the record: a timer.breached event and an escalation per breach, with the loans the batch boarded
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_events WHERE type = 'timer.breached'`), breached);
  assert.ok(await n(`SELECT count(*)::text AS c FROM timers WHERE status = 'breached' AND loan_id IN (SELECT id FROM loans WHERE boarding_batch_id = $1)`, [batchUuid]) > 0, "boarded loans' clocks are among the breaches");
  assert.ok((await n(`SELECT count(*)::text AS c FROM loan_events`)) > eventsBefore);
});

test("a second advance to the same instant is a no-op: nothing written, nothing swept, the clock unchanged", { skip }, async () => {
  const rows = await n(`SELECT count(*)::text AS c FROM demo_clock`); const events = await n(`SELECT count(*)::text AS c FROM loan_events`);
  for (const body of [{ to: TARGET }, { to: T0 }, { to: plus(TARGET, -DAY) }]) {
    const r = await call("POST", "/v1/demo/advance", body);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body["advanced"], false, JSON.stringify(body)); assert.equal(r.body["complete"], true); assert.equal(r.body["steps_remaining"], 0); assert.equal(r.body["advance_id"], null); assert.equal(r.body["days_crossed"], 0); assert.deepEqual(r.body["steps"], []); assert.equal(r.body["from"], TARGET); assert.equal(r.body["to"], TARGET);
  }
  assert.equal(await n(`SELECT count(*)::text AS c FROM demo_clock`), rows); assert.equal(await n(`SELECT count(*)::text AS c FROM loan_events`), events);
  assert.equal(clock.now(), TARGET);
});

test("the offset survives a new Runtime instance: loadDemoClock over the same database reads 45 days ahead, its sweep finds nothing due, and a following clock (serve mode) adopts its advance unasked", { skip }, async () => {
  const again = await loadDemoClock(db, { base: new FixedClock(T0) });
  assert.equal(again.now(), TARGET); assert.equal(again.offset, 45 * DAY); assert.equal(again.latestRow?.kind, "target");
  const rt2 = new Runtime({ db, registry: loadOverriddenRegistry(), clock: again });
  assert.equal(rt2.clock.now(), TARGET);
  const sweep = await rt2.sweep();
  assert.equal(sweep.at, TARGET); assert.equal(sweep.due, 0);
  // a later advance from the new instance carries on from the persisted offset (same ET day, one target step)
  const later = plus(TARGET, 3_600_000);
  const before = await n(`SELECT count(*)::text AS c FROM demo_clock`);
  // the server's clock is, as far as the table is concerned, another instance: it follows the table as main.ts serve mode does, and must adopt the step without being told
  assert.equal(clock.following, false);
  const following = clock.follow(db, { everyMs: 20 });
  try {
    assert.equal(clock.following, true);
    const r = await advanceDemoClock({ runtime: rt2, clock: again }, { to: later });
    assert.equal(r.advanced, true); assert.equal(r.complete, true); assert.equal(r.days_crossed, 0); assert.equal(r.steps.length, 1); assert.equal(r.steps[0]!.kind, "target"); assert.equal(r.steps[0]!.flows, "absent");
    // without flows the three runtime-level daily sweeps ran directly (the flows' tick carries them: 4-disclosures, 8-servicing, 10-hardship)
    const s0 = r.steps[0]!;
    assert.ok(s0.origination_sweep && s0.servicing_sweep && s0.delinquency_sweep, `the three sweeps ran: ${JSON.stringify(s0)}`);
    assert.equal(s0.servicing_sweep!.errors, 0); assert.ok(s0.servicing_sweep!.loans >= 0 && s0.origination_sweep!.deemed >= 0 && s0.delinquency_sweep!.loans >= 0 && s0.delinquency_sweep!.windows_opened >= 0);
    assert.equal(again.now(), later); assert.equal(await n(`SELECT count(*)::text AS c FROM demo_clock`), before + 1);
    const deadline = Date.now() + 5_000;
    while (clock.now() !== later && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(clock.now(), later, "the following clock adopted the other instance's step within the interval"); assert.equal(runtime.clock.now(), later); assert.equal(clock.latestRow?.id, again.latestRow?.id);
    assert.equal((await call("GET", "/v1/demo/clock")).body["following"], true);
  } finally { following.stop(); }
  assert.equal(clock.following, false);
});

test("the budget: an advance stops between steps once budget_ms is spent, answers complete: false with the clock on the last swept day, and the next advance to the same target carries on from there", { skip }, async () => {
  const again = await loadDemoClock(db, { base: new FixedClock(T0) });
  const rt2 = new Runtime({ db, registry: loadOverriddenRegistry(), clock: again });
  const from = again.now();   // Sun Oct 25, 2026 13:00 EDT
  const rowsBefore = await n(`SELECT count(*)::text AS c FROM demo_clock`);
  const first = await advanceDemoClock({ runtime: rt2, clock: again, actor: "human:ops" }, { days: 3, budget_ms: 0 });
  assert.equal(first.advanced, true); assert.equal(first.complete, false); assert.equal(first.steps.length, 1); assert.equal(first.steps_remaining, 2); assert.equal(first.budget_ms, 0);
  assert.equal(first.from, from); assert.equal(first.requested_to, plus(from, 3 * DAY));
  assert.deepEqual([first.steps[0]!.kind, first.steps[0]!.at, first.steps[0]!.date], ["day", "2026-10-26T16:00:00.000Z", "2026-10-26"]);
  assert.equal(first.to, first.steps[0]!.at); assert.equal(again.now(), first.to); assert.equal(first.days_crossed, 1);
  assert.equal(await n(`SELECT count(*)::text AS c FROM demo_clock`), rowsBefore + 1);
  const [row] = await db.query<{ step: number; steps: number; kind: string; actor: string }>(`SELECT step, steps, kind, actor FROM demo_clock ORDER BY id DESC LIMIT 1`);
  assert.deepEqual(row, { step: 1, steps: 3, kind: "day", actor: "human:ops" });
  // the same target again: the two remaining steps, complete, on a fresh advance
  const second = await advanceDemoClock({ runtime: rt2, clock: again }, { to: first.requested_to });
  assert.equal(second.advanced, true); assert.equal(second.complete, true); assert.equal(second.steps.length, 2); assert.equal(second.steps_remaining, 0); assert.equal(second.budget_ms, DEFAULT_ADVANCE_BUDGET_MS);
  assert.notEqual(second.advance_id, first.advance_id); assert.equal(second.from, first.to);
  assert.deepEqual(second.steps.map((s) => [s.kind, s.at]), [["day", "2026-10-27T16:00:00.000Z"], ["target", first.requested_to]]);
  assert.equal(second.to, first.requested_to); assert.equal(again.now(), first.requested_to); assert.equal(second.days_crossed, 2);
  assert.equal(await n(`SELECT count(*)::text AS c FROM demo_clock`), rowsBefore + 3);
  assert.equal(await n(`SELECT count(*)::text AS c FROM timers WHERE status = 'armed' AND due_at <= $1`, [first.requested_to]), 0, "nothing armed is left past due once the advance completed");
  // and once more: nothing to do
  const third = await advanceDemoClock({ runtime: rt2, clock: again }, { to: first.requested_to, budget_ms: 0 });
  assert.equal(third.advanced, false); assert.equal(third.complete, true); assert.equal(third.steps_remaining, 0);
  assert.equal(await n(`SELECT count(*)::text AS c FROM demo_clock`), rowsBefore + 3);
  // the server's clock is not following here: it sees the steps on its next read of the table (the route refreshes)
  const status = await call("GET", "/v1/demo/clock");
  assert.equal(status.body["now"], first.requested_to); assert.equal(clock.now(), first.requested_to);
});

test("guards: a bad body or an advance past the cap is 400, no token is 401, production is 403 on both routes, and demo_clock is append-only", { skip }, async () => {
  const now = String((await call("GET", "/v1/demo/clock")).body["now"]);   // the earlier tests moved the clock on: the over-the-cap target counts from where it stands
  for (const body of [{}, { days: 0 }, { days: -1 }, { days: MAX_ADVANCE_DAYS + 1 }, { to: "yesterday" }, { to: plus(now, (MAX_ADVANCE_DAYS + 2) * DAY) }, { to: now, days: 1 }, { days: 1, budget_ms: -1 }, { days: 1, budget_ms: "soon" }]) {
    const r = await call("POST", "/v1/demo/advance", body);
    assert.equal(r.status, 400, JSON.stringify({ body, answer: r.body })); assert.equal(r.body["error"], "bad_request");
  }
  assert.equal((await call("GET", "/v1/demo/clock", undefined, null)).status, 401);
  assert.equal((await call("POST", "/v1/demo/advance", { days: 1 }, null)).status, 401);
  const prod = createApiServer({ runtime, apiToken: TOKEN, logger: createLogger("json", () => undefined), console: false, borrower: { ...borrowerOptions, environment: "production" } });
  const prodBase = `http://127.0.0.1:${await listen(prod, 0, "127.0.0.1")}`;
  try {
    for (const [method, path, body] of [["GET", "/v1/demo/clock", undefined], ["POST", "/v1/demo/advance", { days: 1 }]] as const) {
      const r = await fetch(prodBase + path, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.equal(r.status, 403, `${method} ${path}`); assert.equal(((await r.json()) as { error: string }).error, "forbidden");
    }
  } finally { await new Promise<void>((resolve) => prod.close(() => resolve())); }
  const rows = await n(`SELECT count(*)::text AS c FROM demo_clock`);
  await assert.rejects(db.query(`UPDATE demo_clock SET offset_ms = 0`), /append-only|immutable|not allowed|forbid/i);
  await assert.rejects(db.query(`DELETE FROM demo_clock`), /append-only|immutable|not allowed|forbid/i);
  assert.equal(await n(`SELECT count(*)::text AS c FROM demo_clock`), rows);
  assert.ok(!lines.some((l) => /"severity":"ERROR"/.test(l) && /demo clock/.test(l)), `no demo clock error was logged: ${lines.filter((l) => /"severity":"ERROR"/.test(l)).slice(0, 3).join("\n")}`);
});
