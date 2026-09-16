// 35.11 Operations stewardship and hosted measurement: the ops steward over cycles, exceptions and the outbox, the daily ops report, and the audit's hosted and persisted columns
// spec/sections/35-operations-runtime/35-11-operations-stewardship-and-hosted-measurement.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// The harness (35-7.spec.test.ts's): the MAIN world is this file's own database with a Runtime (fake ports, no FAKE reviewers,
// `nonprod`) and a FixedClock at 2026-09-14 08:00 ET (a Monday). 35.3's `cycle_registry` and `cycle_receipts` do not exist on this
// tree; the fixture creates them with 35.3's Data-model columns when absent (the steward reads them through its CyclesPort). Every
// 35.11 tool runs on the bus (`runtime.execute`); the steward's pass runs inside `runtime.sweep()` like production. Dead messages
// are `integration_messages` + `outbox_dispatches` rows and the outbox's own `integration.message.dead` literal; a requeued message
// is put back to `dead` or `sent` by the test before the next sweep so the FAKE adapter's drain never races the assertion.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { connect, type Db } from "../../infra/db/client.ts";
import { testDatabase } from "../../infra/db/test-db.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock, type Actor } from "../../kernel/events/index.ts";
import { Runtime } from "../../runtime/app.ts";
import { createLogger } from "../../runtime/log.ts";
import { CommandRefused } from "../../app/commands.ts";
import { EscalationService, PgEscalationRepository } from "../../app/escalations.ts";
import { StaffError } from "../../runtime/staff/roles.ts";
import { moneyFingerprint } from "../../runtime/controls/common.ts";
import { requeueMessage } from "../../runtime/controls/outbox.ts";
import { stewardshipRoutes } from "./stewardship-35-11/routes.ts";
import { canonicalJson } from "./stewardship-35-11/types.ts";
import { STEWARDSHIP_TOOLS } from "../../app/tools/section35-11.ts";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer, listen } from "../../runtime/server.ts";
import { ALL_TOOLS } from "../../app/tools/index.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { DEFAULT_PROBE_DATABASE_URL, manifestTables, newestMigration, runHostedProbe, serviceKeyTools } from "./measurement.ts";

const { url: DB_URL, skip } = await testDatabase(import.meta.url);
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
/** 2026-09-14 08:00 America/New_York (a Monday). */
const T0 = "2026-09-14T12:00:00.000Z";
const clock = new FixedClock(T0);
const MIN = 60_000; const HOUR = 3_600_000; const DAY = 86_400_000;
const at = (ms: number): string => new Date(Date.parse(clock.now()) + ms).toISOString();
type Json = Record<string, unknown>;
const QC: Actor = { kind: "agent", id: "qc-audit" };

let db: Db; let runtime: Runtime; let opsId = ""; const OPS = (): Actor => ({ kind: "human", id: opsId, role: "ops_analyst" });
const logLines: string[] = [];
const logger = createLogger("json", (line) => { logLines.push(line); if (process.env["FLOW_DEBUG"] && /error|unhandled/i.test(line)) process.stderr.write(line + "\n"); });

test.before(async () => {
  if (skip) return;
  db = connect(DB_URL);
  // the probe database T14 names (`PROBE_DATABASE_URL`, rule 10) reaches `audit.hosted.run` through the runtime's env, as main.ts hands it — a parallel session probes on its own database
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock, logger, environment: "nonprod", env: { INTEGRATIONS: "fake", ...(process.env["PROBE_DATABASE_URL"] ? { PROBE_DATABASE_URL: process.env["PROBE_DATABASE_URL"] } : {}) } as NodeJS.ProcessEnv, reviewers: null });
  // 35.3's tables as its Data model spells them (absent on this tree): the steward's CyclesPort reads them when they exist
  await db.query(`CREATE TABLE IF NOT EXISTS cycle_registry (cycle_code text PRIMARY KEY, owner_process text, owner_agent text, unit_scope text, schedule text, period_grammar text, unit_selector text, unit_runner text, receipt_event text, depends_on jsonb NOT NULL DEFAULT '[]', serves_timer text, escalation_role text NOT NULL DEFAULT 'ops_analyst', expected_by_rule text, status text NOT NULL DEFAULT 'active', paused_by text, paused_reason text, last_period_key text, last_run_id uuid, last_receipt_at timestamptz, next_period_key text, next_expected_by timestamptz, overdue_since timestamptz, registry_version text, updated_at timestamptz NOT NULL DEFAULT now())`);
  await db.query(`CREATE TABLE IF NOT EXISTS cycle_receipts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL UNIQUE, cycle_code text NOT NULL, period_key text NOT NULL, as_of_date date, units_total int, units_done int, units_dead int, units_skipped int, outcomes_sha256 char(64), receipt_event_id uuid, generic_event_id uuid, emitted_by text, created_at timestamptz NOT NULL DEFAULT now())`);
  // an active ops_analyst (34.1's row: the hand requeue and the human-only resolve need a staff member holding the role)
  opsId = (await db.query<{ id: string }>(`INSERT INTO staff_users (email_hash, email_encrypted, legal_name, roles, status, enrolled_at) VALUES ($1, '\\x00'::bytea, 'Ops Analyst', '{ops_analyst}', 'active', now()) RETURNING id::text AS id`, [createHash("sha256").update(`ops.${randomUUID()}@example.test`).digest("hex")]))[0]!.id;
});
test.after(async () => { if (!skip) await db.end(); });

// ---------------------------------------------------------------- helpers
const tool = (name: string, actor: Actor, input: Json) => runtime.execute({ process: "35.11", name, loanId: "", actor, input });
type EventRow = { id: string; type: string; actor_kind: string; actor_id: string; actor_role: string | null; aggregate_kind: string | null; aggregate_id: string | null; payload: Json; sequence: string; occurred_at: string };
const events = async (type: string, where = "", params: unknown[] = []): Promise<EventRow[]> => db.query<EventRow>(`SELECT id::text AS id, type, actor_kind::text AS actor_kind, actor_id, actor_role, aggregate_kind, aggregate_id, payload, sequence::text AS sequence, occurred_at::text AS occurred_at FROM loan_events WHERE type = $1 ${where} ORDER BY sequence`, [type, ...params]);
const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, params))[0]!.n);
type TimerRow = { id: string; code: string; status: string; subject_kind: string; subject_id: string; anchor_date: string; due_date: string | null; due_at: string | null; armed_at: string };
const timers = async (code: string, where = "", params: unknown[] = []): Promise<TimerRow[]> => db.query<TimerRow>(`SELECT id::text AS id, code, status::text AS status, subject_kind, subject_id, anchor_date::text AS anchor_date, due_date::text AS due_date, due_at::text AS due_at, armed_at::text AS armed_at FROM timers WHERE code = $1 ${where} ORDER BY armed_at, id`, [code, ...params]);
type ExRow = { id: string; source_kind: string; source_id: string; adapter: string | null; kind: string; confidence: string | null; status: string; owner_role: string; opened_at: string; classified_at: string | null; assigned_at: string | null; resolved_at: string | null; auto_requeues: number; escalation_id: string | null };
const exceptions = async (where = "", params: unknown[] = []): Promise<ExRow[]> => db.query<ExRow>(`SELECT id::text AS id, source_kind, source_id, adapter, kind, confidence::text AS confidence, status, owner_role, opened_at::text AS opened_at, classified_at::text AS classified_at, assigned_at::text AS assigned_at, resolved_at::text AS resolved_at, auto_requeues, escalation_id::text AS escalation_id FROM ops_exceptions ${where ? `WHERE ${where}` : ""} ORDER BY opened_at, id`, params);
type TriageRow = { id: string; action: string; kind: string | null; confidence: string | null; signals: Json; actor_kind: string; actor_id: string; assigned_role: string | null; reason: string | null; decision_id: string | null; event_id: string | null };
const triages = async (exceptionId: string): Promise<TriageRow[]> => db.query<TriageRow>(`SELECT id::text AS id, action, kind, confidence::text AS confidence, signals, actor_kind::text AS actor_kind, actor_id, assigned_role, reason, decision_id::text AS decision_id, event_id::text AS event_id FROM exception_triages WHERE exception_id = $1::uuid ORDER BY created_at, id`, [exceptionId]);
type EscRow = { id: string; kind: string; owner_role: string; severity: string | null; completed_at: string | null; payload: Json; opened_at: string };
const escalations = async (where: string, params: unknown[] = []): Promise<EscRow[]> => db.query<EscRow>(`SELECT id::text AS id, kind, owner_role, severity, completed_at::text AS completed_at, payload, opened_at::text AS opened_at FROM escalations WHERE ${where} ORDER BY opened_at, id`, params);
/** A global event appended the way a section appends its own (the real literal on loan_events, through a unit of work on this clock). */
const append = async (type: string, payload: Json, actor: Actor = { kind: "system", id: "35.11-spec" }, aggregate?: { kind: string; id: string }): Promise<string> => { const r = await runtime.uow.run({}, (ctx) => ctx.events.append({ type, actor, payload, ...(aggregate ? { aggregate } : {}) }), { clock }); return r.result.id; };
/** A dead message of an adapter: the row (attempts = the deaths), its last dispatch (failure_kind = the error class, rule 3's C) and the outbox's own `integration.message.dead` literal. */
async function deadMessage(adapter: string, o: { attempts?: number; failure_kind?: string; error?: string; when?: string; dispatches?: number } = {}): Promise<string> {
  const when = o.when ?? clock.now(); const attempts = o.attempts ?? 5;
  const id = (await db.query<{ id: string }>(`INSERT INTO integration_messages (adapter, direction, idempotency_key, status, attempts, last_attempt_at, error, created_at) VALUES ($1, 'out', $2, 'dead', $3, $4::timestamptz, $5, $4::timestamptz - interval '1 hour') RETURNING id::text AS id`, [adapter, `35.11-${randomUUID()}`, attempts, when, o.error ?? o.failure_kind ?? "dead"]))[0]!.id;
  for (let n = 1; n <= (o.dispatches ?? 1); n++) await dispatch(id, adapter, n === (o.dispatches ?? 1) ? "dead" : "retry", { failure_kind: o.failure_kind ?? "unknown", error: o.error ?? o.failure_kind ?? "dead", when: new Date(Date.parse(when) - ((o.dispatches ?? 1) - n) * MIN).toISOString(), attempt_no: attempts - (o.dispatches ?? 1) + n });
  await append("integration.message.dead", { message_id: id, adapter, attempts, error: o.error ?? o.failure_kind ?? "dead", dead_at: when, failure: o.failure_kind ?? "unknown", outcome: "dead", loan_id: null }, { kind: "system", id: "sweep" }, { kind: "integration_message", id });
  return id;
}
async function dispatch(messageId: string, adapter: string, outcome: string, o: { failure_kind?: string | null; error?: string | null; when?: string; attempt_no?: number } = {}): Promise<void> {
  const when = o.when ?? clock.now();
  const attempt = o.attempt_no ?? Number((await db.query<{ n: string }>(`SELECT coalesce(max(attempt_no), 0)::text AS n FROM outbox_dispatches WHERE message_id = $1::uuid`, [messageId]))[0]!.n) + 1;
  await db.query(`INSERT INTO outbox_dispatches (message_id, attempt_no, adapter, started_at, finished_at, outcome, failure_kind, error) VALUES ($1::uuid, $2, $3, $4::timestamptz - interval '1 second', $4::timestamptz, $5, $6, $7)`, [messageId, attempt, adapter, when, outcome, outcome === "acked" ? null : (o.failure_kind ?? null), outcome === "acked" ? null : (o.error ?? null)]);
}
/** A successful send of an adapter at `when`: a sent message and its acked dispatch (what 35.1's drain writes). */
async function ackedSend(adapter: string, when: string = clock.now()): Promise<string> {
  const id = (await db.query<{ id: string }>(`INSERT INTO integration_messages (adapter, direction, idempotency_key, status, attempts, last_attempt_at, sent_at, created_at) VALUES ($1, 'out', $2, 'sent', 1, $3::timestamptz, $3::timestamptz, $3::timestamptz) RETURNING id::text AS id`, [adapter, `35.11-ok-${randomUUID()}`, when]))[0]!.id;
  await dispatch(id, adapter, "acked", { when, attempt_no: 1});
  return id;
}
/** An open escalation persisted the way the runtime persists them (EscalationService + the repository in one unit of work). */
async function openEscalation(kind: string, ownerRole: string, payload: Json): Promise<string> {
  let id = "";
  await runtime.uow.run({}, (ctx) => { const es = new EscalationService(ctx.events, ctx.clock); id = es.open({ kind: kind as never, ownerRole, payload }, { kind: "system", id: "35.11-spec" }).id; return es; }, { clock, commit: async (q) => { await new PgEscalationRepository(q).save({ id, kind: kind as never, ownerRole, openedAt: clock.now(), openedBy: "system:35.11-spec", payload, status: "open" }, q); } });
  return id;
}
const sha256hex = (s: string): string => createHash("sha256").update(s).digest("hex");
const registryRow = (code: string, o: { period: string; expectedBy: string; overdueSince?: string | null }) => db.query(`INSERT INTO cycle_registry (cycle_code, owner_process, owner_agent, unit_scope, schedule, period_grammar, unit_selector, unit_runner, receipt_event, escalation_role, expected_by_rule, status, next_period_key, next_expected_by, overdue_since, registry_version) VALUES ($1, '7.1', 'notices', 'loan', 'daily 00:05 ET', 'day', 'statements_due', 'sendPeriodicStatement', 'statement.cycle.run_completed', 'ops_analyst', 'same_day 23:59 ET', 'active', $2, $3::timestamptz, $4::timestamptz, 'cycles.v1') ON CONFLICT (cycle_code) DO UPDATE SET next_period_key = EXCLUDED.next_period_key, next_expected_by = EXCLUDED.next_expected_by, overdue_since = EXCLUDED.overdue_since, updated_at = now()`, [code, o.period, o.expectedBy, o.overdueSince ?? o.expectedBy]);
void ROOT; void HOUR; void DAY; void StaffError; void CommandRefused; void moneyFingerprint; void requeueMessage; void stewardshipRoutes; void canonicalJson; void STEWARDSHIP_TOOLS; void readFileSync; void QC; void OPS; void count; void timers; void exceptions; void triages; void escalations; void deadMessage; void ackedSend; void openEscalation; void sha256hex; void registryRow; void tool; void events; void at;

let T14_DIR = "";
const dbNameOf = (url: string): string => new URL(url).pathname.replace(/^\//, "");
void spawnSync; void mkdtempSync; void writeFileSync; void tmpdir; void join; void createApiServer; void listen; void ALL_TOOLS; void D; void DEFAULT_PROBE_DATABASE_URL; void manifestTables; void newestMigration; void runHostedProbe; void serviceKeyTools; void T14_DIR; void dbNameOf;
let T17_WORLD: { url: string; run: Json } | null = null;
void T17_WORLD;

test("35.11-T1: Given a `cycle_registry` row for `statements` (35.3 rule 2's def) with `next_expected_by` two hours in the past and no `cycle_receipts` row for its period key, when the steward's pass runs, then one `ops_exceptions` row `{source_kind: cycle_registry, source_id: \"statements:<period_key>\", kind: missed_cycle, status: triaged}` exists, `ops.cycle.missed{consecutive_misses: 1}` is logged, `SM_OPS_CYCLE_MISSED_2H` is armed on it, exactly one open `ops_analyst` escalation names the cycle and its runbook, and a second pass in the same minute adds no row, event or escalation.", { skip }, async () => {
  await registryRow("statements", { period: "2026-09-14", expectedBy: at(-2 * HOUR) });
  const rep1 = await runtime.sweep(); assert.ok(rep1.stewardship, "the steward's pass ran"); assert.equal(rep1.stewardship!.errors.length, 0, rep1.stewardship!.errors.join("; "));
  const ex = await exceptions(`source_kind = 'cycle_registry' AND source_id = 'statements:2026-09-14'`);
  assert.equal(ex.length, 1); assert.equal(ex[0]!.kind, "missed_cycle"); assert.equal(ex[0]!.status, "triaged");
  const missed = await events("ops.cycle.missed", `AND payload->>'cycle_code' = 'statements'`); assert.equal(missed.length, 1); assert.equal(missed[0]!.payload["consecutive_misses"], 1); assert.equal(missed[0]!.payload["period_key"], "2026-09-14"); assert.equal(missed[0]!.payload["exception_id"], ex[0]!.id);
  const clocks = await timers("SM_OPS_CYCLE_MISSED_2H", `AND subject_id = $2`, [ex[0]!.id]); assert.equal(clocks.length, 1); assert.equal(clocks[0]!.status, "armed"); assert.equal(clocks[0]!.subject_kind, "ops_exception"); assert.equal(Date.parse(clocks[0]!.due_at!), Date.parse(clock.now()) + 2 * HOUR);
  const esc = await escalations(`completed_at IS NULL AND payload->>'cycle_code' = 'statements' AND payload->>'period_key' = '2026-09-14'`); assert.equal(esc.length, 1); assert.equal(esc[0]!.owner_role, "ops_analyst"); assert.equal(esc[0]!.kind, "sev2"); assert.ok(esc[0]!.payload["runbook"] && typeof esc[0]!.payload["runbook"] === "object", "the escalation names the runbook"); assert.equal((esc[0]!.payload["runbook"] as Json)["expected_by_rule"], "same_day 23:59 ET"); assert.equal(ex[0]!.escalation_id, esc[0]!.id);
  // a second pass in the same minute adds no row, event or escalation
  const before = { ex: await count("ops_exceptions"), ev: await count("loan_events WHERE type LIKE 'ops.%'"), esc: await count("escalations"), tr: await count("exception_triages") };
  clock.set(at(30_000)); await runtime.sweep();
  assert.deepEqual({ ex: await count("ops_exceptions"), ev: await count("loan_events WHERE type LIKE 'ops.%'"), esc: await count("escalations"), tr: await count("exception_triages") }, before);
});

test("35.11-T2: Given the exception of T1, when 35.3 emits `cycle.run.completed` for that cycle and period, then `ops.cycle.recovered` is logged, the exception is `resolved` with `resolved_at`, `SM_OPS_CYCLE_MISSED_2H` is `satisfied`, and the `ops_analyst` escalation is still open (the steward completed nothing).", { skip }, async () => {
  const [ex] = await exceptions(`source_kind = 'cycle_registry' AND source_id = 'statements:2026-09-14'`); assert.ok(ex);
  const receipt = randomUUID();
  await append("cycle.run.completed", { run_id: randomUUID(), cycle_code: "statements", period_key: "2026-09-14", units_done: 12, units_dead: 0, units_skipped: 0, completed_at: clock.now(), receipt_id: receipt }, { kind: "agent", id: "ops-steward" }, { kind: "cycle_run", id: randomUUID() });
  clock.set(at(MIN)); const rep = await runtime.sweep(); assert.equal(rep.stewardship!.errors.length, 0, rep.stewardship!.errors.join("; "));
  const rec = await events("ops.cycle.recovered", `AND payload->>'exception_id' = $2`, [ex!.id]); assert.equal(rec.length, 1); assert.equal(rec[0]!.payload["receipt_id"], receipt); assert.equal(rec[0]!.payload["period_key"], "2026-09-14");
  const [after] = await exceptions(`id = $1::uuid`, [ex!.id]); assert.equal(after!.status, "resolved"); assert.ok(after!.resolved_at);
  const clocks = await timers("SM_OPS_CYCLE_MISSED_2H", `AND subject_id = $2`, [ex!.id]); assert.equal(clocks.length, 1); assert.equal(clocks[0]!.status, "satisfied");
  const esc = await escalations(`id = $1::uuid`, [ex!.escalation_id]); assert.equal(esc.length, 1); assert.equal(esc[0]!.completed_at, null, "the steward completed nothing");
  assert.equal((await events("escalation.completed")).filter((e) => e.actor_kind === "agent").length, 0);
});

test("35.11-T3: Given the same cycle misses two consecutive period keys, when the steward detects the second, then `ops.cycle.missed{consecutive_misses: 2}` is logged and the breach action of `SM_OPS_CYCLE_MISSED_2H` opens a `sev1` escalation to `compliance` at its due instant (the timer-probe run of the override), while the first miss's breach opened `sev2` to `ops_analyst`.", { skip }, async () => {
  // the next day: the same cycle misses 2026-09-15 (consecutive 1 — 2026-09-14 had its receipt), then 2026-09-16 (consecutive 2)
  clock.set("2026-09-15T14:00:00.000Z"); await registryRow("statements", { period: "2026-09-15", expectedBy: at(-2 * HOUR) });
  const rep1 = await runtime.sweep(); assert.equal(rep1.stewardship!.errors.length, 0, rep1.stewardship!.errors.join("; "));
  const [first] = await exceptions(`source_id = 'statements:2026-09-15'`); assert.ok(first); assert.equal((await events("ops.cycle.missed", `AND payload->>'exception_id' = $2`, [first!.id]))[0]!.payload["consecutive_misses"], 1);
  clock.set("2026-09-15T15:00:00.000Z"); await registryRow("statements", { period: "2026-09-16", expectedBy: at(-2 * HOUR) });
  const rep2 = await runtime.sweep(); assert.equal(rep2.stewardship!.errors.length, 0, rep2.stewardship!.errors.join("; "));
  const [second] = await exceptions(`source_id = 'statements:2026-09-16'`); assert.ok(second);
  const missed2 = await events("ops.cycle.missed", `AND payload->>'exception_id' = $2`, [second!.id]); assert.equal(missed2.length, 1); assert.equal(missed2[0]!.payload["consecutive_misses"], 2);
  // the first miss's clock breaches at its due instant (16:00Z) into sev2 → ops_analyst
  clock.set("2026-09-15T16:00:30.000Z"); const rep3 = await runtime.sweep();
  const t1 = (await timers("SM_OPS_CYCLE_MISSED_2H", `AND subject_id = $2`, [first!.id]))[0]!; assert.equal(t1.status, "breached"); assert.ok(rep3.breaches.some((b) => b.timer_id === t1.id));
  const b1 = await escalations(`payload->>'timer_id' = $1`, [t1.id]); assert.equal(b1.length, 1); assert.equal(b1[0]!.kind, "sev2"); assert.equal(b1[0]!.owner_role, "ops_analyst"); assert.equal(b1[0]!.payload["consecutive_misses"], 1);
  // the second miss's clock breaches at its due instant (17:00Z): the row's second clause — sev1 → compliance
  clock.set("2026-09-15T17:00:30.000Z"); const rep4 = await runtime.sweep();
  const t2 = (await timers("SM_OPS_CYCLE_MISSED_2H", `AND subject_id = $2`, [second!.id]))[0]!; assert.equal(t2.status, "breached"); assert.ok(rep4.breaches.some((b) => b.timer_id === t2.id));
  const b2 = await escalations(`payload->>'timer_id' = $1`, [t2.id]); assert.equal(b2.length, 1); assert.equal(b2[0]!.kind, "sev1"); assert.equal(b2[0]!.owner_role, "compliance"); assert.equal(b2[0]!.payload["consecutive_misses"], 2); assert.equal(b2[0]!.payload["cycle_code"], "statements"); assert.equal(b2[0]!.completed_at, null);
  assert.equal(b1[0]!.completed_at, null);
});

test("35.11-T4: Given an adapter `fnma-lsdu` with four dead outcomes in the last 15 minutes and no successful send in the last hour, when `ops.exceptions.classify` runs on one of its dead messages, then the exception is `adapter_down` with confidence `0.95`, `signals = {D15: 4, S60: 0, A: 5, C: \"timeout\"}` is stored on the triage row, `ops.exception.classified` and `ops.exception.triaged` are logged, `SM_OPS_EXCEPTION_TRIAGE_1BD` is `satisfied` and `SM_OPS_ADAPTER_DOWN_1H` is armed on `classified_at`; no requeue happened.", { skip }, async () => {
  clock.set("2026-09-16T13:00:00.000Z");
  // four dead outcomes of fnma-lsdu in the last 15 minutes, no successful send in the last hour; the message under test died on its fifth attempt with a timeout
  for (let k = 0; k < 3; k++) await deadMessage("fnma-lsdu", { attempts: 5, failure_kind: "timeout", when: at(-(3 + k) * MIN) });
  const m = await deadMessage("fnma-lsdu", { attempts: 5, failure_kind: "timeout", when: at(-MIN) });
  const rep = await runtime.sweep(); assert.equal(rep.stewardship!.errors.length, 0, rep.stewardship!.errors.join("; "));
  const [ex] = await exceptions(`source_kind = 'integration_message' AND source_id = $1`, [m]); assert.ok(ex, "the dead message opened an exception");
  const r = await tool("ops.exceptions.classify", QC, { exception_id: ex!.id }); const o = r.output as Json;
  assert.equal(o["kind"], "adapter_down"); assert.equal(o["confidence"], 0.95); assert.deepEqual(o["signals"], { D15: 4, S60: 0, A: 5, C: "timeout" });
  const [after] = await exceptions(`id = $1::uuid`, [ex!.id]); assert.equal(after!.kind, "adapter_down"); assert.equal(after!.confidence, "0.9500"); assert.equal(after!.status, "triaged"); assert.ok(after!.classified_at);
  const tr = (await triages(ex!.id)).filter((t) => t.action === "classified"); assert.ok(tr.length >= 1); assert.deepEqual(tr.at(-1)!.signals, { D15: 4, S60: 0, A: 5, C: "timeout" }); assert.equal(tr.at(-1)!.confidence, "0.9500"); assert.ok(tr.at(-1)!.decision_id, "the classification's decision row");
  assert.equal((await events("ops.exception.classified", `AND payload->>'exception_id' = $2`, [ex!.id])).length, 1); assert.equal((await events("ops.exception.triaged", `AND payload->>'exception_id' = $2`, [ex!.id])).length, 1);
  const triage = await timers("SM_OPS_EXCEPTION_TRIAGE_1BD", `AND subject_id = $2`, [ex!.id]); assert.equal(triage.length, 1); assert.equal(triage[0]!.status, "satisfied");
  const down = await timers("SM_OPS_ADAPTER_DOWN_1H", `AND subject_id = $2`, [ex!.id]); assert.equal(down.length, 1); assert.equal(down[0]!.status, "armed"); assert.equal(Date.parse(down[0]!.due_at!), Date.parse(after!.classified_at!) + HOUR);
  assert.equal((await events("outbox.requeued", `AND payload->>'message_id' = $2`, [m])).length, 0, "no requeue happened");
  assert.equal((await db.query<{ status: string }>(`SELECT status FROM integration_messages WHERE id = $1::uuid`, [m]))[0]!.status, "dead");
});

test("35.11-T5: Given the adapter of T4 sends one message successfully 20 minutes later, when the steward's pass runs, then the dead message is requeued once with `outbox.requeued{by: \"agent:qc-audit\", auto: true, reason: \"adapter_recovered\"}`, `ops_exceptions.auto_requeues = 1`, the exception is `resolved` when `integration.message.sent` follows and `SM_OPS_ADAPTER_DOWN_1H` is `satisfied`; given instead no success within an hour, then the clock breaches with a `sev2` `ops_analyst` escalation naming the adapter and `D15`.", { skip }, async () => {
  const [ex] = await exceptions(`source_kind = 'integration_message' AND adapter = 'fnma-lsdu' AND kind = 'adapter_down' AND status = 'triaged'`); assert.ok(ex, "T4's exception");
  clock.set(at(20 * MIN)); await ackedSend("fnma-lsdu");
  const rep = await runtime.sweep(); assert.equal(rep.stewardship!.errors.length, 0, rep.stewardship!.errors.join("; "));
  const rq = await events("outbox.requeued", `AND payload->>'message_id' = $2`, [ex!.source_id]); assert.equal(rq.length, 1);
  assert.equal(rq[0]!.payload["by"], "agent:qc-audit"); assert.equal(rq[0]!.payload["auto"], true); assert.equal(rq[0]!.payload["reason"], "adapter_recovered"); assert.equal(rq[0]!.payload["by_role"], null); assert.equal(rq[0]!.actor_kind, "agent");
  assert.equal((await exceptions(`id = $1::uuid`, [ex!.id]))[0]!.auto_requeues, 1);
  assert.equal((await db.query<{ status: string; attempts: number }>(`SELECT status, attempts FROM integration_messages WHERE id = $1::uuid`, [ex!.source_id]))[0]!.status, "queued");
  // the drain delivers it: `integration.message.sent` follows (the outbox's literal), and the steward resolves
  await db.query(`UPDATE integration_messages SET status = 'sent', sent_at = $2::timestamptz, attempts = 1 WHERE id = $1::uuid`, [ex!.source_id, clock.now()]); await dispatch(ex!.source_id, "fnma-lsdu", "acked");
  await append("integration.message.sent", { message_id: ex!.source_id, adapter: "fnma-lsdu", attempt: 1, sent_at: clock.now() }, { kind: "system", id: "sweep" }, { kind: "integration_message", id: ex!.source_id });
  clock.set(at(MIN)); await runtime.sweep();
  assert.equal((await exceptions(`id = $1::uuid`, [ex!.id]))[0]!.status, "resolved");
  const down = await timers("SM_OPS_ADAPTER_DOWN_1H", `AND subject_id = $2`, [ex!.id]); assert.equal(down.length, 1); assert.equal(down[0]!.status, "satisfied");
  // given instead no success within an hour: another adapter classified down breaches into sev2 ops_analyst naming the adapter and D15
  clock.set("2026-09-17T13:00:00.000Z");
  for (let k = 0; k < 3; k++) await deadMessage("fnma-smdu", { attempts: 5, failure_kind: "timeout", when: at(-(2 + k) * MIN) });
  await runtime.sweep();
  const [ex2] = await exceptions(`source_kind = 'integration_message' AND adapter = 'fnma-smdu' AND status = 'triaged'`); assert.ok(ex2); assert.equal(ex2!.kind, "adapter_down");
  const c2 = (await timers("SM_OPS_ADAPTER_DOWN_1H", `AND subject_id = $2`, [ex2!.id]))[0]!; assert.equal(c2.status, "armed");
  clock.set(new Date(Date.parse(c2.due_at!) + 30_000).toISOString()); const rep3 = await runtime.sweep(); assert.ok(rep3.breaches.some((b) => b.timer_id === c2.id), JSON.stringify(rep3.breaches));
  const esc = await escalations(`payload->>'timer_id' = $1`, [c2.id]); assert.equal(esc.length, 1); assert.equal(esc[0]!.kind, "sev2"); assert.equal(esc[0]!.owner_role, "ops_analyst"); assert.equal(esc[0]!.payload["adapter"], "fnma-smdu"); assert.equal(esc[0]!.payload["D15"], 3, "the dead count the classification stored (three deaths in the window)"); assert.equal(esc[0]!.payload["S60"], 0);
  assert.equal((await timers("SM_OPS_ADAPTER_DOWN_1H", `AND subject_id = $2`, [ex2!.id]))[0]!.status, "breached");
});

test("35.11-T6: Given a dead message with `failure_kind = http_5xx` and three successful sends of its adapter in the last hour, when classified, then it is `transient` with confidence `0.90` and is requeued automatically once; given it dies again, then the second `integration.message.dead` adds a triage row `escalated`, no second automatic requeue happens (`AUTO_REQUEUE_CAP_1`), and the exception is `assigned` to `ops_analyst`; given a hand requeue by an `ops_analyst` through 34.4, then 34.4 counts it as `requeue_no: 1` — the automatic one was not a hand requeue.", { skip }, async () => {
  clock.set("2026-09-18T13:00:00.000Z");
  for (let k = 0; k < 3; k++) await ackedSend("mers", at(-(10 + k) * MIN));
  const m = await deadMessage("mers", { attempts: 5, failure_kind: "http_5xx", error: "HTTP 503 from mers", when: at(-MIN) });
  const rep = await runtime.sweep(); assert.equal(rep.stewardship!.errors.length, 0, rep.stewardship!.errors.join("; "));
  const [ex] = await exceptions(`source_kind = 'integration_message' AND source_id = $1`, [m]); assert.ok(ex);
  assert.equal(ex!.kind, "transient"); assert.equal(ex!.confidence, "0.9000"); assert.equal(ex!.auto_requeues, 1);
  const rq = await events("outbox.requeued", `AND payload->>'message_id' = $2`, [m]); assert.equal(rq.length, 1); assert.equal(rq[0]!.payload["auto"], true); assert.equal(rq[0]!.payload["requeue_no"], 1);
  assert.ok((await triages(ex!.id)).some((t) => t.action === "requeue_auto"));
  // it dies again: back to dead by the drain, the outbox's second literal
  await db.query(`UPDATE integration_messages SET status = 'dead', attempts = 5, error = 'HTTP 503 from mers' WHERE id = $1::uuid`, [m]); await dispatch(m, "mers", "dead", { failure_kind: "http_5xx", error: "HTTP 503 from mers", when: at(30_000) });
  await append("integration.message.dead", { message_id: m, adapter: "mers", attempts: 5, error: "HTTP 503 from mers", dead_at: at(30_000), failure: "http_5xx", outcome: "dead", loan_id: null }, { kind: "system", id: "sweep" }, { kind: "integration_message", id: m });
  clock.set(at(MIN)); const rep2 = await runtime.sweep(); assert.equal(rep2.stewardship!.errors.length, 0, rep2.stewardship!.errors.join("; "));
  const tr = await triages(ex!.id); assert.ok(tr.some((t) => t.action === "escalated"), JSON.stringify(tr.map((t) => t.action)));
  assert.equal((await events("outbox.requeued", `AND payload->>'message_id' = $2`, [m])).length, 1, "no second automatic requeue (AUTO_REQUEUE_CAP_1)");
  const [after] = await exceptions(`id = $1::uuid`, [ex!.id]); assert.equal(after!.status, "assigned"); assert.equal(after!.owner_role, "ops_analyst"); assert.equal(after!.auto_requeues, 1);
  const cap = await tool("ops.exceptions.requeue", QC, { exception_id: ex!.id, op: "auto" }).then(() => null, (e: unknown) => e); assert.ok(cap instanceof StaffError); assert.equal((cap as StaffError).code, "AUTO_REQUEUE_CAP_1");
  // a hand requeue by an ops_analyst through 34.4 counts as requeue_no 1 — the automatic one was not a hand requeue
  const hand = await requeueMessage(runtime, { id: m, actor: OPS(), reason: "34.4 hand requeue after the automatic one" }, clock.now());
  assert.equal(hand.requeue_no, 1); assert.equal(hand.requeues_left, 2);
  await db.query(`UPDATE integration_messages SET status = 'dead' WHERE id = $1::uuid`, [m]);
});

test("35.11-T7: Given a dead message with `failure_kind = validation` and `attempts = 5`, when classified, then it is `poison` with confidence `0.95`, `ops.exceptions.requeue{op: auto}` is refused `CONFIDENCE_FLOOR_0_85`-or-kind (the refusal names `poison`), a `requeue_proposed` triage row exists and the exception is `assigned` to `ops_analyst` with `ops.exception.assigned` logged; given an unclassifiable error, then `needs_person` with confidence `0.50` and the same assignment.", { skip }, async () => {
  clock.set("2026-09-21T13:00:00.000Z");
  const m = await deadMessage("nacha", { attempts: 5, failure_kind: "validation", error: "validation: field 12 is not a routing number", when: at(-MIN) });
  const rep = await runtime.sweep(); assert.equal(rep.stewardship!.errors.length, 0, rep.stewardship!.errors.join("; "));
  const [ex] = await exceptions(`source_kind = 'integration_message' AND source_id = $1`, [m]); assert.ok(ex);
  assert.equal(ex!.kind, "poison"); assert.equal(ex!.confidence, "0.9500"); assert.equal(ex!.status, "assigned"); assert.equal(ex!.owner_role, "ops_analyst");
  const refusal = await tool("ops.exceptions.requeue", QC, { exception_id: ex!.id, op: "auto" }).then(() => null, (e: unknown) => e);
  assert.ok(refusal instanceof StaffError, "refused"); assert.equal((refusal as StaffError).code, "CONFIDENCE_FLOOR_0_85"); assert.match((refusal as StaffError).message, /poison/);
  const tr = await triages(ex!.id); assert.ok(tr.some((t) => t.action === "requeue_proposed"), JSON.stringify(tr.map((t) => t.action))); assert.ok(tr.some((t) => t.action === "assigned" && t.assigned_role === "ops_analyst"));
  assert.equal((await events("ops.exception.assigned", `AND payload->>'exception_id' = $2`, [ex!.id])).length, 1);
  assert.equal((await events("outbox.requeued", `AND payload->>'message_id' = $2`, [m])).length, 0);
  // an unclassifiable error: needs_person at 0.50 and the same assignment
  const m2 = await deadMessage("nacha", { attempts: 2, failure_kind: "unknown", error: "something nobody named", when: clock.now() });
  clock.set(at(MIN)); await runtime.sweep();
  const [ex2] = await exceptions(`source_kind = 'integration_message' AND source_id = $1`, [m2]); assert.ok(ex2);
  assert.equal(ex2!.kind, "needs_person"); assert.equal(ex2!.confidence, "0.5000"); assert.equal(ex2!.status, "assigned"); assert.equal(ex2!.owner_role, "ops_analyst");
  assert.ok((await triages(ex2!.id)).some((t) => t.action === "requeue_proposed"));
});

test("35.11-T8: Given open `sev1`–`sev4` escalations, breached timers and dead units on the fixture, when the steward's pass runs ten times, then every escalation that was open is still open, every breached timer is still `breached` and no `escalation.completed` event carries an agent actor (contract test: `src/domain/operations-runtime/stewardship.ts` contains no call to any escalation completion or timer write; the guard `NEVER_COMPLETES_A_BREACH` refuses an input naming `escalation_id` with `complete`).", { skip }, async () => {
  clock.set("2026-09-22T13:00:00.000Z");
  const opened = [await openEscalation("sev1", "compliance", { code: "T8", n: 1 }), await openEscalation("sev2", "officer", { code: "T8", n: 2 }), await openEscalation("sev3", "ops_analyst", { code: "T8", n: 3 }), await openEscalation("sev4", "ops_analyst", { code: "T8", n: 4 })];
  const anyEvent = (await db.query<{ id: string }>(`SELECT id::text AS id FROM loan_events ORDER BY sequence LIMIT 1`))[0]!.id;
  const breachedIds = (await db.query<{ id: string }>(`INSERT INTO timers (code, subject_kind, subject_id, armed_at, armed_by_event_id, anchor_date, due_at, status, breached_at) VALUES ('SM_OUTBOX_DEAD_LETTER_REVIEW_1BD', 'global', '*', $1::timestamptz, $2::uuid, $1::date, $1::timestamptz, 'breached', $1::timestamptz), ('SM_CYCLE_RUN_STALLED_1D', 'cycle_run', $3, $1::timestamptz, $2::uuid, $1::date, $1::timestamptz, 'breached', $1::timestamptz) RETURNING id::text AS id`, [at(-DAY), anyEvent, randomUUID()])).map((r) => r.id);
  await append("job.unit.dead", { job_id: randomUUID(), cycle_code: "statements", period_key: "2026-09-21", unit_id: randomUUID(), attempts: 3, error_class: "fake_port_timeout", dead_at: clock.now() }, { kind: "agent", id: "ops-steward" }, { kind: "job", id: randomUUID() });
  const openBefore = await count("escalations WHERE completed_at IS NULL");
  for (let k = 0; k < 10; k++) { clock.set(at(MIN)); const rep = await runtime.sweep(); assert.equal(rep.stewardship!.errors.length, 0, rep.stewardship!.errors.join("; ")); }
  for (const id of opened) assert.equal((await escalations(`id = $1::uuid`, [id]))[0]!.completed_at, null);
  assert.ok((await count("escalations WHERE completed_at IS NULL")) >= openBefore, "every escalation that was open is still open");
  for (const id of breachedIds) assert.equal((await db.query<{ status: string }>(`SELECT status::text AS status FROM timers WHERE id = $1::uuid`, [id]))[0]!.status, "breached");
  assert.equal((await events("escalation.completed")).filter((e) => e.actor_kind === "agent").length, 0);
  const deadUnit = await exceptions(`source_kind = 'job'`); assert.ok(deadUnit.length >= 1); assert.equal(deadUnit.at(-1)!.kind, "dead_unit"); assert.equal(deadUnit.at(-1)!.status, "assigned");
  // the contract: stewardship.ts contains no call to any escalation completion or timer write
  const src = readFileSync(new URL("./stewardship.ts", import.meta.url), "utf8") + readFileSync(new URL("./stewardship-35-11/report.ts", import.meta.url), "utf8");
  for (const forbidden of [/\.complete\(/, /completeEscalation/, /UPDATE\s+escalations/i, /UPDATE\s+timers/i, /INSERT\s+INTO\s+timers/i, /DELETE\s+FROM\s+timers/i, /timers\.(cancel|arm|satisfy)\(/, /\.cancel\(/]) assert.ok(!forbidden.test(src), `stewardship.ts must not match ${forbidden}`);
  const guard = await tool("ops.exceptions.assign", QC, { exception_id: deadUnit.at(-1)!.id, escalation_id: opened[0], op: "complete" }).then(() => null, (e: unknown) => e);
  assert.ok(guard instanceof CommandRefused); assert.equal((guard as CommandRefused).code, "NEVER_COMPLETES_A_BREACH");
});

test("35.11-T9: Given the day's state on the fixture, when `ops.report` runs twice with nothing changed, then one `ops_daily_reports` row exists for `(nonprod, <as_of_date>)` with every column of the Data model populated (counts and codes only; no payload, name or e-mail in the JSON), its `sha256` equals the sha256 of the canonical JSON, `ops.report.run_completed{changed: true}` then `{changed: false}` are logged, and `SM_OPS_REPORT_DAILY` is `satisfied` and re-armed for the next day; given one more dead message, then a third run appends a newer row with a different hash.", { skip }, async () => {
  clock.set("2026-09-23T13:00:00.000Z");
  if ((await count("integration_messages")) === 0) await deadMessage("mers", { attempts: 5, failure_kind: "timeout", when: at(-MIN) });   // the day's state when this T-id runs alone
  await runtime.sweep();   // the day's state; the sweep's own report (yesterday's) arms the clock
  const day = "2026-09-23";
  const r1 = await tool("ops.report", QC, { environment: "nonprod", as_of_date: day }); const o1 = r1.output as Json; assert.equal(o1["changed"], true);
  const r2 = await tool("ops.report", QC, { environment: "nonprod", as_of_date: day }); const o2 = r2.output as Json; assert.equal(o2["changed"], false); assert.equal(o2["report_id"], o1["report_id"]); assert.equal(o2["sha256"], o1["sha256"]);
  type Rep = { id: string; environment: string; as_of_date: string; sweep: Json | null; cycles: Json[] | null; breaches: Json[]; escalations: Json; outbox: Json[]; exceptions: Json; fake_approvals: number; fake_roles: string[]; kill_switches: Json[]; projection: Json | null; documents: Json | null; roles: Json | null; override_rates: Json[]; sha256: string; document_id: string | null; produced_by: string };
  const rows = await db.query<Rep>(`SELECT id::text AS id, environment, as_of_date::text AS as_of_date, sweep, cycles, breaches, escalations, outbox, exceptions, fake_approvals, fake_roles, kill_switches, projection, documents, roles, override_rates, sha256, document_id::text AS document_id, produced_by FROM ops_daily_reports WHERE environment = 'nonprod' AND as_of_date = $1::date ORDER BY created_at`, [day]);
  assert.equal(rows.length, 1); const row = rows[0]!;
  const feeds = (o1["feeds"] as Record<string, string>);
  for (const col of ["sweep", "cycles", "breaches", "escalations", "outbox", "exceptions", "kill_switches", "projection", "roles", "override_rates"] as const) assert.notEqual(row[col], null, `${col} populated`);
  assert.equal(row.documents === null, feeds["document_integrity_findings"] === "absent", "documents is null exactly when 35.2's feed is absent");
  assert.ok((row.sweep as Json)["runs"] as number >= 1); assert.ok(Array.isArray(row.outbox) && row.outbox.length >= 1); assert.ok(typeof (row.exceptions as Json)["opened"] === "number"); assert.equal(typeof row.fake_approvals, "number"); assert.ok(row.document_id); assert.equal(row.produced_by, "agent:qc-audit");
  const json = JSON.stringify(row); assert.ok(!/@/.test(json), "no e-mail"); const leak = /"(payload|name|legal_name|email)"/.exec(json); assert.equal(leak, null, `no payload or name key: ${leak ? json.slice(Math.max(0, leak.index - 160), leak.index + 40) : ""}`);
  const columns = { environment: row.environment, as_of_date: row.as_of_date, sweep: row.sweep, cycles: row.cycles, breaches: row.breaches, escalations: row.escalations, outbox: row.outbox, exceptions: row.exceptions, fake_approvals: row.fake_approvals, fake_roles: row.fake_roles, kill_switches: row.kill_switches, projection: row.projection, documents: row.documents, roles: row.roles, override_rates: row.override_rates };
  assert.equal(row.sha256, sha256hex(canonicalJson(columns)));
  const done = await events("ops.report.run_completed", `AND payload->>'environment' = 'nonprod' AND payload->>'as_of_date' = $2`, [day]); assert.equal(done.length, 2); assert.equal(done[0]!.payload["changed"], true); assert.equal(done[1]!.payload["changed"], false);
  const clocks = await timers("SM_OPS_REPORT_DAILY"); assert.ok(clocks.length >= 2); const armedNow = clocks.filter((c) => c.status === "armed"); assert.equal(armedNow.length, 1, JSON.stringify(clocks)); const last = armedNow[0]!; assert.equal(last.subject_kind, "global"); assert.equal(last.anchor_date, day); assert.equal(last.due_date, "2026-09-24"); assert.equal(Date.parse(last.due_at!), Date.parse("2026-09-24T04:15:00.000Z")); assert.ok(clocks.filter((c) => c.id !== last.id).every((c) => c.status === "satisfied"), `satisfied and re-armed for the next day: ${JSON.stringify(clocks)}`);
  // one more dead message: a third run appends a newer row with a different hash
  await deadMessage("mers", { attempts: 5, failure_kind: "timeout", when: clock.now() });
  const r3 = await tool("ops.report", QC, { environment: "nonprod", as_of_date: day }); const o3 = r3.output as Json; assert.equal(o3["changed"], true); assert.notEqual(o3["sha256"], o1["sha256"]);
  assert.equal((await count("ops_daily_reports WHERE environment = 'nonprod' AND as_of_date = $1::date", [day])), 2);
});

test("35.11-T10: Given 61 overrides over 340 decisions on day 1 and 52 over 310 on day 2 for a T1 agent, when the two days' reports run, then `ai_monitoring_metrics` holds `override_rate = 0.1794` and `0.1677` for those days, `recordOverrideRate` was called with each, the agent is AI-off after day 2 with a reason naming `17.9%, 16.8%`, and `ai.kill_switch.tripped{metric: override_rate}` is logged; given day 1 were 48 over 400 (`0.1200`), then nothing trips; given a day with zero decisions, then `decision_volume = 0`, a null rate, and the null day does not count as out of band.", { skip }, async () => {
  const t1 = "cashiering", inBand = "boarding", gappy = "transfer";
  for (const code of [t1, inBand, gappy]) await db.query(`INSERT INTO ai_systems (code, name, kind, purpose, risk_tier, owner_role) VALUES ($1, $1, 'agent', '35.11-T10 fixture: a T1 bus agent', 'T1_consequential', 'ai_governance_owner') ON CONFLICT (code) DO UPDATE SET risk_tier = 'T1_consequential'`, [code]);   // 19.3's assessment: these three are T1 (the 0231 seed inventories every agent at T3_internal)
  const seed = async (agent: string, day: string, decisions: number, overrides: number): Promise<void> => { for (let k = 0; k < decisions; k++) await db.query(`INSERT INTO agent_decisions (agent, action, rule_set_version, rationale, confidence, created_at) VALUES ($1, $2, 'test.v1', '35.11-T10 fixture', 1, $3::timestamptz)`, [agent, k < overrides ? "post_payment_rejected" : "post_payment", `${day}T15:00:00.000Z`]); };
  const D1 = "2026-09-01", D2 = "2026-09-02", D3 = "2026-09-03";
  await seed(t1, D1, 340, 61); await seed(t1, D2, 310, 52);
  await seed(inBand, D1, 400, 48); await seed(inBand, D2, 310, 52);
  await seed(gappy, D1, 340, 61); await seed(gappy, D3, 340, 61);   // D2: zero decisions
  const calls: { agent: string; day: string; rate: number }[] = []; const orig = runtime.agents.recordOverrideRate.bind(runtime.agents);
  (runtime.agents as { recordOverrideRate: typeof orig }).recordOverrideRate = (agent, day, rate) => { calls.push({ agent, day, rate }); return orig(agent, day, rate); };
  for (const day of [D1, D2, D3]) { const r = await tool("ops.report", QC, { environment: "nonprod", as_of_date: day }); assert.equal((r.output as Json)["as_of_date"], day); }
  const metrics = async (code: string) => db.query<{ day: string; decision_volume: number; override_rate: string | null; tripped: boolean }>(`SELECT day::text AS day, decision_volume, override_rate::text AS override_rate, kill_switch_triggered AS tripped FROM ai_monitoring_metrics WHERE system_code = $1 AND day IN ($2::date, $3::date, $4::date) ORDER BY day`, [code, D1, D2, D3]);
  const m1 = await metrics(t1); assert.equal(m1.length, 3); assert.equal(m1[0]!.override_rate, "0.1794"); assert.equal(m1[1]!.override_rate, "0.1677"); assert.equal(m1[0]!.decision_volume, 340); assert.equal(m1[1]!.decision_volume, 310);
  assert.deepEqual(calls.filter((c) => c.agent === t1).map((c) => [c.day, c.rate]), [[D1, 0.1794], [D2, 0.1677]]);
  const state = runtime.agents.aiState(t1); assert.equal(state.off, true); assert.match(state.why ?? "", /17\.9%, 16\.8%/);
  const tripped = await events("ai.kill_switch.tripped", `AND payload->>'system_code' = $2`, [t1]); assert.equal(tripped.length, 1); assert.equal(tripped[0]!.payload["metric"], "override_rate"); assert.equal(m1[1]!.tripped, true);
  // day 1 in band (48 over 400 = 0.1200): one day out of band trips nothing
  const m2 = await metrics(inBand); assert.equal(m2[0]!.override_rate, "0.1200"); assert.equal(m2[1]!.override_rate, "0.1677"); assert.equal(runtime.agents.aiState(inBand).off, false); assert.equal((await events("ai.kill_switch.tripped", `AND payload->>'system_code' = $2`, [inBand])).length, 0);
  // a day with zero decisions: decision_volume 0, a null rate, and the null day does not count toward the two
  const m3 = await metrics(gappy); assert.equal(m3.length, 3); assert.equal(m3[1]!.day, D2); assert.equal(m3[1]!.decision_volume, 0); assert.equal(m3[1]!.override_rate, null); assert.equal(m3[0]!.override_rate, "0.1794"); assert.equal(m3[2]!.override_rate, "0.1794");
  assert.equal(runtime.agents.aiState(gappy).off, false, "a null day never counts as out of band"); assert.equal((await events("ai.kill_switch.tripped", `AND payload->>'system_code' = $2`, [gappy])).length, 0);
  assert.deepEqual(calls.filter((c) => c.agent === gappy).map((c) => c.day), [D1, D3]);
  (runtime.agents as { recordOverrideRate: typeof orig }).recordOverrideRate = orig;
});

test("35.11-T11: Given three FAKE approvals (`actor_id` starting `FAKE:`) on the day, when the report runs under `ENVIRONMENT = nonprod`, then `fake_approvals = 3`, `fake_roles` lists the roles and no escalation exists; when the same day is reported under `ENVIRONMENT = production`, then `ops.fake_in_production{count: 3}` is logged, one exception `{kind: fake_in_production}` exists and exactly one `sev1` escalation to `compliance` is open, and a second report run that day opens no second one.", { skip }, async () => {
  const day = "2026-08-20";
  for (const role of ["qc_officer", "funding_approver", "qc_officer"]) await runtime.uow.run({}, (ctx) => ctx.events.append({ type: "fake_reviewer.approved", occurredAt: `${day}T16:00:00.000Z`, actor: { kind: "human", id: `FAKE:${role}`, role }, aggregate: { kind: "fake_reviewer", id: randomUUID() }, payload: { kind: "T11", role, as_of_date: day, environment: "nonprod", origination: true } }), { clock });
  const r1 = await tool("ops.report", QC, { environment: "nonprod", as_of_date: day }); const o1 = r1.output as Json;
  const [row1] = await db.query<{ fake_approvals: number; fake_roles: string[] }>(`SELECT fake_approvals, fake_roles FROM ops_daily_reports WHERE id = $1::uuid`, [o1["report_id"]]);
  assert.equal(row1!.fake_approvals, 3); assert.deepEqual(row1!.fake_roles, ["funding_approver", "qc_officer"]);
  assert.equal((await escalations(`payload->>'code' = 'FAKE_IN_PRODUCTION'`)).length, 0); assert.equal((await exceptions(`kind = 'fake_in_production'`)).length, 0); assert.equal((await events("ops.fake_in_production")).length, 0);
  // the same day reported under ENVIRONMENT = production (a production runtime over the same database)
  const prod = new Runtime({ db, registry: loadOverriddenRegistry(), clock, logger, environment: "production", env: { INTEGRATIONS: "fake", ENVIRONMENT: "production" } as NodeJS.ProcessEnv, reviewers: null });
  const r2 = await prod.execute({ process: "35.11", name: "ops.report", loanId: "", actor: QC, input: { environment: "production", as_of_date: day } }); const o2 = r2.output as Json;
  assert.equal((o2["fake_in_production"] as Json)["exception_id"] !== undefined, true);
  const fake = await events("ops.fake_in_production", `AND payload->>'as_of_date' = $2`, [day]); assert.equal(fake.length, 1); assert.equal(fake[0]!.payload["count"], 3); assert.equal(fake[0]!.payload["environment"], "production"); assert.deepEqual(fake[0]!.payload["roles"], ["funding_approver", "qc_officer"]);
  const ex = await exceptions(`kind = 'fake_in_production'`); assert.equal(ex.length, 1); assert.equal(ex[0]!.source_kind, "fake_actor"); assert.equal(ex[0]!.source_id, day);
  const esc = await escalations(`completed_at IS NULL AND payload->>'code' = 'FAKE_IN_PRODUCTION'`); assert.equal(esc.length, 1); assert.equal(esc[0]!.kind, "sev1"); assert.equal(esc[0]!.owner_role, "compliance"); assert.equal(ex[0]!.escalation_id, esc[0]!.id);
  await prod.execute({ process: "35.11", name: "ops.report", loanId: "", actor: QC, input: { environment: "production", as_of_date: day } });
  assert.equal((await escalations(`payload->>'code' = 'FAKE_IN_PRODUCTION'`)).length, 1, "a second report run that day opens no second one"); assert.equal((await exceptions(`kind = 'fake_in_production'`)).length, 1); assert.equal((await events("ops.fake_in_production", `AND payload->>'as_of_date' = $2`, [day])).length, 1);
});

test("35.11-T12: Given any tool of this process, when its input carries a money-shaped key (`amount_cents`, `waive`, `entry_set`, `refund`) or an escalation completion, then the command is refused `NO_MONEY_FIELD` or `NEVER_COMPLETES_A_BREACH` before any read, nothing is written, and the ledger and money columns before and after every stewardship route are identical in a contract test.", { skip }, async () => {
  clock.set("2026-09-24T13:00:00.000Z");
  if (!(await exceptions(`status IN ('triaged', 'assigned')`)).length) { await deadMessage("mers", { attempts: 5, failure_kind: "timeout", when: at(-MIN) }); await runtime.sweep(); }
  if (!(await escalations(`completed_at IS NULL`)).length) await openEscalation("sev3", "ops_analyst", { code: "T12" });
  const [ex] = await exceptions(`status IN ('triaged', 'assigned')`); assert.ok(ex, "a live exception on the fixture");
  const [esc] = await escalations(`completed_at IS NULL`); assert.ok(esc);
  const snapshot = async () => ({ money: await moneyFingerprint(db), ex: await count("ops_exceptions"), tr: await count("exception_triages"), dec: await count("agent_decisions"), ev: await count("loan_events WHERE type <> 'command.refused'"), esc: await count("escalations"), rep: await count("ops_daily_reports") });
  const moneyInputs: Json[] = [{ amount_cents: 100n }, { waive: true }, { entry_set: { lines: [] } }, { refund: { amount_cents: 5n } }];
  for (const name of STEWARDSHIP_TOOLS) {
    for (const bad of moneyInputs) {
      const before = await snapshot();
      const e: unknown = await tool(name, name === "ops.exceptions.resolve" ? OPS() : QC, { exception_id: ex!.id, ...bad }).then(() => null, (x: unknown) => x);
      assert.ok(e instanceof CommandRefused, `${name} ${JSON.stringify(Object.keys(bad))} refused`); assert.equal((e as CommandRefused).code, "NO_MONEY_FIELD", name);
      assert.deepEqual(await snapshot(), before, `${name}: nothing written`);
    }
    if (name === "writeDecision" || name.endsWith(".list") || name.endsWith(".read")) continue;
    const before = await snapshot();
    const e: unknown = await tool(name, name === "ops.exceptions.resolve" ? OPS() : QC, { exception_id: ex!.id, escalation_id: esc!.id, op: "complete" }).then(() => null, (x: unknown) => x);
    assert.ok(e instanceof CommandRefused, `${name} escalation completion refused`); assert.equal((e as CommandRefused).code, "NEVER_COMPLETES_A_BREACH", name);
    assert.deepEqual(await snapshot(), before, `${name}: nothing written`);
  }
  // every stewardship route leaves the ledger and the money columns identical
  const routes = stewardshipRoutes({ runtime }); const actor = OPS(); const now = clock.now();
  const call = (method: "GET" | "POST", path: string, params: Record<string, string>, body: Json = {}, query = "") => routes.find((r) => r.method === method && r.path === path)!.handler({ actor, params, query: new URLSearchParams(query), body, now });
  const fp0 = await moneyFingerprint(db);
  const [dead] = await exceptions(`source_kind = 'integration_message' AND status IN ('triaged', 'assigned') AND auto_requeues = 0`);
  const outcomes: number[] = [];
  outcomes.push((await call("GET", "/api/stewardship/report", {}, {}, "environment=nonprod&as_of_date=2026-09-23")).status);
  outcomes.push((await call("GET", "/api/stewardship/exceptions", {}, {}, "status=live")).status);
  outcomes.push((await call("POST", "/api/stewardship/exceptions/:id/classify", { id: ex!.id })).status);
  outcomes.push((await call("POST", "/api/stewardship/exceptions/:id/assign", { id: ex!.id }, { role: "ops_analyst", reason: "T12" })).status);
  outcomes.push((await call("GET", "/api/stewardship/runbook/:code", { code: "SM_OPS_ADAPTER_DOWN_1H" })).status);
  if (dead) outcomes.push((await call("POST", "/api/stewardship/exceptions/:id/requeue", { id: dead.id }, { reason: "T12 hand requeue" })).status);
  outcomes.push((await call("POST", "/api/stewardship/exceptions/:id/resolve", { id: ex!.id }, { disposition: "abandoned", reason: "T12: abandoned by a person" })).status);
  assert.ok(outcomes.every((s) => s === 200 || s === 409), JSON.stringify(outcomes));
  assert.equal(await moneyFingerprint(db), fp0, "the ledger and money columns are identical before and after every stewardship route");
});

test("35.11-T13: Given the registry, when `ops.runbook.read{timer_code: \"SM_OPS_ADAPTER_DOWN_1H\"}` runs, then the reply carries the code, kind, trigger, anchor, offset, satisfied event, the breach text verbatim from the registry row, `owner_role: ops_analyst`, `severity: 2`, `process: 35.11` and this file's path; `{cycle_code}` returns the `cycle_registry` row with `expected_by_rule`; an unknown code is refused `UNKNOWN_CODE`.", { skip }, async () => {
  const r = await tool("ops.runbook.read", QC, { timer_code: "SM_OPS_ADAPTER_DOWN_1H" }); const o = r.output as Json; const rb = o["runbook"] as Json;
  const reg = (JSON.parse(readFileSync(`${ROOT}spec/registry/timers.json`, "utf8")) as Json[]).find((t) => t["code"] === "SM_OPS_ADAPTER_DOWN_1H")!;
  assert.equal(o["kind"], "timer"); assert.equal(rb["code"], "SM_OPS_ADAPTER_DOWN_1H"); assert.equal(rb["kind"], "deadline"); assert.equal(rb["trigger"], "ops.exception.classified"); assert.equal(rb["anchor"], "classified_at"); assert.equal(rb["offset"], "+1 hours"); assert.equal(rb["satisfied"], "ops.exception.resolved");
  assert.equal(rb["breach_text"], reg["breach"]); assert.equal(rb["owner_role"], "ops_analyst"); assert.equal(rb["severity"], 2); assert.equal(rb["process"], "35.11"); assert.equal(rb["spec_path"], "spec/sections/35-operations-runtime/35-11-operations-stewardship-and-hosted-measurement.md");
  const c = await tool("ops.runbook.read", QC, { cycle_code: "statements" }); const co = c.output as Json; assert.equal(co["kind"], "cycle"); assert.equal((co["runbook"] as Json)["expected_by_rule"], "same_day 23:59 ET"); assert.equal((co["runbook"] as Json)["owner_process"], "7.1");
  const bad = await tool("ops.runbook.read", QC, { timer_code: "SM_NO_SUCH_CODE" }).then(() => null, (e: unknown) => e); assert.ok(bad instanceof StaffError); assert.equal((bad as StaffError).code, "UNKNOWN_CODE");
  const bad2 = await tool("ops.runbook.read", QC, { cycle_code: "no_such_cycle" }).then(() => null, (e: unknown) => e); assert.ok(bad2 instanceof StaffError); assert.equal((bad2 as StaffError).code, "UNKNOWN_CODE");});

test("35.11-T14: Given `PROBE_DATABASE_URL` reachable, when `audit.hosted.run{target: probe}` runs, then `supermortgage_probe` was dropped, created and migrated to the newest file under `db/migrations`, every `ALL_TOOLS` pair was posted with `{}` over HTTP as its own agent, no result is `errored`, the only `not_wired` results are tools of the service keys `boarding`, `orig-boarding` and `tolerance-21-5`, a `hosted_probe_runs` row and `docs/audit/hosted.json` carry `migration_head` equal to that newest file and one result per pair, and `audit.hosted.run_completed` is logged with the four counts summing to `tools_total`.", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "s3511-audit-")); T14_DIR = dir;
  const probeUrl = process.env["PROBE_DATABASE_URL"] ?? DEFAULT_PROBE_DATABASE_URL; const newest = newestMigration();
  clock.set("2026-09-25T13:00:00.000Z");
  const r = await tool("audit.hosted.run", QC, { target: "probe", audit_dir: dir }); const o = r.output as Json;
  assert.equal(o["outcome"], "completed", String(o["failure"])); assert.equal(o["database_name"], dbNameOf(probeUrl)); assert.equal(o["migration_head"], newest); assert.equal(o["target"], "probe"); assert.equal(o["base_url"], "local");
  // supermortgage_probe was dropped, created and migrated to the newest file: its schema_migrations end there and the run's own row, its receipt and every request's staff_actions{surface: v1, principal_id} row are in it
  const pdb = connect(probeUrl);
  try {
    assert.equal(`${(await pdb.query<{ v: string }>(`SELECT version AS v FROM schema_migrations ORDER BY version DESC LIMIT 1`))[0]!.v}.sql`, newest);
    const prow = await pdb.query<{ migration_head: string; results: Json[]; tools_total: number; outcome: string }>(`SELECT migration_head, results, tools_total, outcome FROM hosted_probe_runs WHERE id = $1::uuid`, [o["run_id"]]);
    assert.equal(prow.length, 1); assert.equal(prow[0]!.migration_head, newest); assert.equal(prow[0]!.outcome, "completed"); assert.equal(prow[0]!.results.length, ALL_TOOLS.length); assert.equal(prow[0]!.tools_total, ALL_TOOLS.length);
    assert.equal((await pdb.query<{ n: string }>(`SELECT count(*)::text AS n FROM loan_events WHERE type = 'audit.hosted.run_completed'`))[0]!.n, "1");
    assert.ok(Number((await pdb.query<{ n: string }>(`SELECT count(*)::text AS n FROM staff_actions WHERE surface = 'v1' AND principal_id IS NOT NULL`))[0]!.n) >= ALL_TOOLS.length, "every /v1 request under a principal left its staff_actions row (35.7)");
    assert.equal((await pdb.query<{ n: string }>(`SELECT count(DISTINCT name)::text AS n FROM api_principals WHERE kind = 'service'`))[0]!.n, String(new Set(ALL_TOOLS.map((t) => t.agent)).size), "one service principal per bus agent");
  } finally { await pdb.end(); }
  const results = o["results"] as Json[]; assert.equal(results.length, ALL_TOOLS.length); assert.equal(o["tools_total"], ALL_TOOLS.length);
  for (const t of ALL_TOOLS) assert.equal(results.filter((x) => x["process"] === t.process && x["name"] === t.name).length, 1, `${t.process} ${t.name}: one result per pair`);
  assert.equal(o["errored"], 0, `errored: ${JSON.stringify(results.filter((x) => x["status"] === "errored"))}`); assert.deepEqual(o["door_refusals"], []);
  const keyProcesses = new Set([...serviceKeyTools().values()].flat());
  for (const x of results.filter((x) => x["status"] === "not_wired")) assert.ok(keyProcesses.has(String(x["process"])), `not_wired ${String(x["process"])} ${String(x["name"])} is a tool of the service keys boarding / orig-boarding / tolerance-21-5`);
  assert.deepEqual(o["not_wired_unexpected"], []);
  assert.equal(Number(o["executed"]) + Number(o["refused_typed"]) + Number(o["not_wired"]) + Number(o["errored"]), Number(o["tools_total"]));
  assert.ok(Number(o["executed"]) > 0, "tools executed over HTTP"); assert.ok(results.every((x) => x["http_status"] !== 0));
  const file = JSON.parse(readFileSync(join(dir, "hosted.json"), "utf8")) as Json; assert.equal(file["migration_head"], newest); assert.equal(file["run_id"], o["run_id"]); assert.equal((file["results"] as Json[]).length, ALL_TOOLS.length); assert.equal(file["tools_total"], ALL_TOOLS.length);
  const done = await events("audit.hosted.run_completed", `AND payload->>'run_id' = $2`, [o["run_id"]]); assert.equal(done.length, 1); const pl = done[0]!.payload;
  assert.equal(Number(pl["executed"]) + Number(pl["refused_typed"]) + Number(pl["not_wired"]) + Number(pl["errored"]), Number(pl["tools_total"])); assert.equal(pl["migration_head"], newest); assert.equal(pl["target"], "probe");
  const weekly = await timers("SM_HOSTED_PROBE_WEEKLY"); assert.ok(weekly.length >= 1); assert.equal(weekly.at(-1)!.status, "armed"); assert.equal(weekly.at(-1)!.subject_kind, "global"); assert.equal(weekly.at(-1)!.due_date, "2026-10-02");
  assert.equal((await db.query<{ h: string }>(`SELECT migration_head AS h FROM hosted_probe_runs WHERE id = $1::uuid`, [o["run_id"]]))[0]!.h, newest, "the caller's copy of the row");
});

test("35.11-T15: Given a tool whose bus guard refuses the empty input (a typed `code`), when the probe classifies it `refused_typed`, then the probe database's row counts of `loan_events`, `entity_records`, `ledger_lines`, `timers`, `escalations` and `agent_decisions` are identical before and after that call (the unit of work rolled back); given a tool that answers 500, then it is `errored` and the run's `errored` count is above zero and T14 fails by name.", { skip }, async () => {
  const probeUrl = process.env["PROBE_DATABASE_URL"] ?? DEFAULT_PROBE_DATABASE_URL;
  const TABLES = ["loan_events", "entity_records", "ledger_lines", "timers", "escalations", "agent_decisions"];
  const counts = async (q: { query: Db["query"] }): Promise<Record<string, string>> => { const out: Record<string, string> = {}; for (const t of TABLES) out[t] = (await q.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${t}`))[0]!.n; return out; };
  let before: Record<string, string> = {}, after: Record<string, string> = {}; let status = 0; let code: string | null = null;
  const run = await runHostedProbe({ target: "probe", databaseUrl: probeUrl, clock, only: [{ process: "35.7", name: "principals.issue" }], writeAuditFile: false, onReady: async (c) => {
    before = await counts(c.db!);
    const r = await fetch(`${c.base}/v1/loans/${c.loanId}/tools/35.7/principals.issue`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${c.tokenFor("security-records")}` }, body: JSON.stringify({ input: {} }) });
    status = r.status; code = ((await r.json()) as Json)["code"] as string;
    after = await counts(c.db!);
  } });
  assert.equal(run.outcome, "completed", String(run.failure)); assert.equal(status, 409); assert.equal(code, "HUMAN_ONLY", "the bus guard's typed code");
  assert.deepEqual(after, before, "the unit of work rolled back: identical row counts before and after");
  const res = run.results.find((x) => x.process === "35.7" && x.name === "principals.issue")!; assert.equal(res.status, "refused_typed"); assert.equal(res.code, "HUMAN_ONLY"); assert.equal(run.refused_typed, 1); assert.equal(run.errored, 0);
  // a tool that answers 500 is errored, the run's errored count is above zero, and T14's assertion fails by name
  const broken = await runHostedProbe({ target: "probe", databaseUrl: probeUrl, clock, only: [{ process: "35.11", name: "ops.exceptions.list" }, { process: "35.7", name: "principals.issue" }], breakTool: { process: "35.11", name: "ops.exceptions.list" }, writeAuditFile: false });
  assert.equal(broken.outcome, "completed", String(broken.failure));
  const b = broken.results.find((x) => x.process === "35.11" && x.name === "ops.exceptions.list")!; assert.equal(b.status, "errored"); assert.equal(b.http_status, 500); assert.ok(broken.errored > 0);
  assert.throws(() => assert.equal(broken.errored, 0, `35.11-T14: no result is errored (errored: ${broken.errored})`), /35\.11-T14: no result is errored/);
});

test("35.11-T16: Given `docs/audit/hosted.json` whose `migration_head` is `0136_du_preflight_results.sql` while the newest file is later, when `tools/audit.py --check` runs, then the brief prints `hosted: not measured (stale: 0136_du_preflight_results.sql vs <newest>)`, no exec total is compared and the exit code is 0; given a current `hosted.json` whose `hosted` total is one below `exec_totals.hosted.built`, then `--check` exits 1 naming `hosted`; given a process in `done` but not in `exec_done` with `hosted` below its `tools`, then `--check` exits 0; given a process in `exec_done` that drops below `hosted = tools` or `persisted = tables`, then `--check` exits 1 naming the process.", { skip }, async () => {
  assert.ok(T14_DIR, "T14's current hosted.json"); const newest = newestMigration();
  const baseline = JSON.parse(readFileSync(`${ROOT}docs/audit/baseline.json`, "utf8")) as Json;
  const hostedNow = JSON.parse(readFileSync(join(T14_DIR, "hosted.json"), "utf8")) as Json;
  const hostedBuilt = (h: Json): number => (h["results"] as Json[]).filter((x) => x["status"] === "executed" || x["status"] === "refused_typed").length;
  const check = (files: Record<string, unknown>): { code: number; out: string } => { const dir = mkdtempSync(join(tmpdir(), "s3511-t16-")); for (const [n, v] of Object.entries(files)) writeFileSync(join(dir, n), JSON.stringify(v)); const p = spawnSync("python3", ["tools/audit.py", "--check", "--audit-dir", dir], { cwd: ROOT, encoding: "utf8" }); return { code: p.status ?? -1, out: `${p.stdout}${p.stderr}` }; };
  const totalsOnly = { totals: baseline["totals"], done: baseline["done"] };
  // a stale hosted.json: the brief says so, no exec total is compared (a baseline nobody could meet), exit 0
  const r1 = check({ "baseline.json": { ...totalsOnly, exec_totals: { hosted: { spec: 1, built: 999999 }, persisted: { spec: 1, built: 999999 } }, exec_done: [] }, "hosted.json": { ...hostedNow, migration_head: "0136_du_preflight_results.sql" } });
  assert.match(r1.out, new RegExp(`hosted: not measured \\(stale: 0136_du_preflight_results\\.sql vs ${newest.replace(/\./g, "\\.")}\\)`)); assert.equal(r1.code, 0, r1.out);
  // a current hosted.json one below exec_totals.hosted.built: exit 1 naming hosted
  const r2 = check({ "baseline.json": { ...totalsOnly, exec_totals: { hosted: { spec: ALL_TOOLS.length, built: hostedBuilt(hostedNow) + 1 }, persisted: { spec: 1, built: 0 } }, exec_done: [] }, "hosted.json": hostedNow });
  assert.equal(r2.code, 1, r2.out); assert.match(r2.out, /hosted fell to \d+\/\d+/);
  // a process in done but not in exec_done with hosted below its tools: exit 0
  assert.ok((baseline["done"] as string[]).includes("35.7"), "35.7 is in done");
  const hostedLow = { ...hostedNow, results: (hostedNow["results"] as Json[]).map((x) => (x["process"] === "35.7" ? { ...x, status: "errored", code: "t16" } : x)) };
  const r3 = check({ "baseline.json": { ...totalsOnly, exec_totals: { hosted: { spec: ALL_TOOLS.length, built: 0 }, persisted: { spec: 1, built: 0 } }, exec_done: [] }, "hosted.json": hostedLow });
  assert.equal(r3.code, 0, r3.out);
  // a process in exec_done that drops below hosted = tools: exit 1 naming the process
  const r4 = check({ "baseline.json": { ...totalsOnly, exec_totals: { hosted: { spec: ALL_TOOLS.length, built: 0 }, persisted: { spec: 1, built: 0 } }, exec_done: ["35.7"] }, "hosted.json": hostedLow });
  assert.equal(r4.code, 1, r4.out); assert.match(r4.out, /process 35\.7 is in exec_done but hosted is \d+\/\d+/);
  // … or below persisted = tables (a current persisted.json with one of 35.7's tables untouched)
  const persistedNow = { migration_head: newest, tables: manifestTables().map((t) => ({ section: t.section, process: t.process, table: t.table, verdict: t.process === "35.7" && t.table === "role_grants" ? "untouched" : "persisted" })) };
  const r5 = check({ "baseline.json": { ...totalsOnly, exec_totals: { hosted: { spec: ALL_TOOLS.length, built: 0 }, persisted: { spec: 1, built: 0 } }, exec_done: ["35.7"] }, "hosted.json": hostedNow, "persisted.json": persistedNow });
  assert.equal(r5.code, 1, r5.out); assert.match(r5.out, /process 35\.7 is in exec_done but persisted is \d+\/\d+/);
  const r6 = check({ "baseline.json": { ...totalsOnly, exec_totals: { hosted: { spec: ALL_TOOLS.length, built: 0 }, persisted: { spec: 1, built: 0 } }, exec_done: ["35.7"] }, "hosted.json": hostedNow, "persisted.json": { ...persistedNow, tables: persistedNow.tables.map((t) => ({ ...t, verdict: "persisted" })) } });
  assert.equal(r6.code, 0, r6.out);
});

test("35.11-T17: Given `supermortgage_test` migrated and the journey files run under the journey lock, when `audit.persisted.count` runs, then `persisted_measurements` has one row per manifest table with `post_migrate_count`, `after_journey_count` and `delta`, `notice_templates` and `ai_systems` are `seeded_only` (delta 0, not counted), `loans`, `loan_events`, `payments`, `ledger_lines`, `timers`, `notices` and `applications` are `persisted`, a manifest table absent from the database is `missing_ddl`, `docs/audit/persisted.json` carries the run's `migration_head`, and `audit.persisted.run_completed{tables_with_rows}` equals the count of `persisted` verdicts.", { skip }, async () => {
  const w = await testDatabase(import.meta.url, { suffix: "t17" }); assert.ok(!w.skip);
  const wdb = connect(w.url); const wclock = new FixedClock("2026-09-25T14:00:00.000Z");
  const wrt = new Runtime({ db: wdb, registry: loadOverriddenRegistry(), clock: wclock, logger, environment: "nonprod", env: { INTEGRATIONS: "fake" } as NodeJS.ProcessEnv, reviewers: null });
  const token = `t17-${randomUUID()}`; const server = createApiServer({ runtime: wrt, apiToken: token, logger, console: false }); const wbase = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  const post = async (path: string, body: unknown): Promise<{ status: number; body: Json }> => { const r = await fetch(wbase + path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) }); return { status: r.status, body: (await r.json()) as Json }; };
  try {
    // the journey on its own database: the demo batch boards the book (loans, loan_events, timers, documents), an application starts, a payment is received, a notice rendered, a statement cycle opened, a payoff quoted, a ledger set posted
    const boarded = await post("/v1/transfers/batches/demo", {}); assert.equal(boarded.status, 200, JSON.stringify(boarded.body).slice(0, 300));
    const party = (await wdb.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id) VALUES ('servicer', 'T17 Partner', '123456789', '1000123') RETURNING id::text AS id`))[0]!.id;
    const app = await post("/v1/applications", { actor: { kind: "agent", id: "intake" }, application: { partner_party_id: party, channel: "organic", transaction_type: "purchase", occupancy: "primary", borrowers: [{ legal_name: "T17 Fixture" }] } }); assert.equal(app.status, 200, JSON.stringify(app.body).slice(0, 300));
    const loanId = (await wdb.query<{ id: string }>(`SELECT id::text AS id FROM loans ORDER BY created_at, id LIMIT 1`))[0]!.id;
    await wdb.query(`INSERT INTO payments (loan_id, channel, instrument, amount_cents, received_at, received_on, credited_as_of, idempotency_key) VALUES ($1::uuid, 'lockbox', 'check', 100000, $2::timestamptz, $2::date, $2::date, $3)`, [loanId, wclock.now(), `t17-${randomUUID()}`]);
    const tpl = (await wdb.query<{ code: string }>(`SELECT code FROM notice_templates ORDER BY code LIMIT 1`))[0]!; assert.ok(tpl, "the seeded catalog (0231)");
    await wdb.query(`INSERT INTO notices (template_code, template_version, loan_id, payload_hash, payload) VALUES ($1, 'v1', $2::uuid, 'sha256:t17', '{"fixture": "t17"}'::jsonb)`, [tpl.code, loanId]);
    await wdb.query(`INSERT INTO statement_cycles (loan_id, cycle_due_date, courtesy_period_end, statement_due_by, variant) VALUES ($1::uuid, '2026-10-01', '2026-10-16', '2026-10-05', 'standard')`, [loanId]);
    await wdb.query(`INSERT INTO payoff_quotes (loan_id, quote_type, good_through, accrual_start, days_partial, months_full, upb_cents, per_diem_cents, total_cents, calc_version, rule_set, hash) VALUES ($1::uuid, 'internal', '2026-10-15', '2026-10-01', 14, 0, 24831055, 4422, 24892963, '16.1-v1', 'payoff.v1', 'sha256:t17')`, [loanId]);
    if ((await wdb.query<{ n: string }>(`SELECT count(*)::text AS n FROM ledger_lines`))[0]!.n === "0") await wrt.uow.run({ loanId }, (ctx) => ctx.ledger.post({ effectiveDate: D("2026-09-25"), description: "T17 fixture set", lines: [{ account: { scope: "loan", loanId, account: "principal" }, amountCents: 100n, ruleRef: "35.11-T17" }, { account: { scope: "corporate", account: "corporate_cash" }, amountCents: -100n, ruleRef: "35.11-T17" }] }, ctx.clock.now()), { clock: wclock });
    const dir = mkdtempSync(join(tmpdir(), "s3511-persisted-"));
    const steps = [{ step: "the demo batch boards the book", writes: ["loans", "loan_events", "timers", "ledger_lines", "documents"] }, { step: "the application starts", writes: ["applications"] }, { step: "the payment, the notice, the statement cycle and the payoff quote", writes: ["payments", "notices", "statement_cycles", "payoff_quotes"] }, { step: "a step nobody ran", writes: ["bankruptcy_cases"] }];
    // the migrations lack no registry table any more (0243 built the last four), so the absent-table case is declared: the registry's rows plus one table no migration creates, which the count must call missing_ddl
    const ABSENT = "t17_absent_table"; const all = [...manifestTables(), { section: 36, process: "36.1", table: ABSENT }];
    const r = await tool("audit.persisted.count", QC, { journeys: [{ name: "35-11.spec.test.ts#t17", database_url: w.url, steps }], audit_dir: dir, tables: all }); const o = r.output as Json;
    assert.equal(o["outcome"], "completed", String(o["failure"])); assert.equal(o["migration_head"], newestMigration());
    type M = { table_name: string; post: string; after: string; delta: string; verdict: string; expected: boolean; expected_by: string | null };
    const rows = await db.query<M>(`SELECT table_name, post_migrate_count::text AS post, after_journey_count::text AS after, delta::text AS delta, verdict, expected, expected_by FROM persisted_measurements WHERE run_id = $1::uuid ORDER BY table_name`, [o["run_id"]]);
    assert.equal(rows.length, all.length, "one row per manifest table (plus the kernel's baseline tables)"); for (const t of all) assert.ok(rows.some((x) => x.table_name === t.table), t.table);
    const by = new Map(rows.map((x) => [x.table_name, x]));
    for (const t of ["notice_templates", "ai_systems"]) { const x = by.get(t)!; assert.equal(x.verdict, "seeded_only", `${t}: ${JSON.stringify(x)}`); assert.equal(x.delta, "0"); assert.ok(BigInt(x.post) > 0n); }
    for (const t of ["loans", "loan_events", "payments", "ledger_lines", "timers", "notices", "applications"]) { const x = by.get(t)!; assert.equal(x.verdict, "persisted", `${t}: ${JSON.stringify(x)}`); assert.ok(BigInt(x.delta) > 0n); assert.equal(BigInt(x.after) - BigInt(x.post), BigInt(x.delta)); }
    const missing = rows.filter((x) => x.verdict === "missing_ddl"); assert.ok(missing.length > 0, "a manifest table absent from the database is missing_ddl"); assert.ok(missing.some((x) => x.table_name === ABSENT), "the declared table no migration creates is the missing one");
    for (const x of missing) assert.equal((await wdb.query<{ r: string | null }>(`SELECT to_regclass($1)::text AS r`, [`public.${x.table_name}`]))[0]!.r, null, x.table_name);
    assert.equal(by.get("bankruptcy_cases")!.expected, true); assert.equal(by.get("bankruptcy_cases")!.verdict, "untouched"); assert.match(by.get("bankruptcy_cases")!.expected_by ?? "", /a step nobody ran/);
    const runRow = (await db.query<{ migration_head: string; journeys: string[]; tables_total: number; tables_with_rows: number }>(`SELECT migration_head, journeys, tables_total, tables_with_rows FROM persisted_measurement_runs WHERE id = $1::uuid`, [o["run_id"]]))[0]!;
    assert.equal(runRow.migration_head, newestMigration()); assert.deepEqual(runRow.journeys, ["35-11.spec.test.ts#t17"]); assert.equal(runRow.tables_total, rows.length); assert.equal(runRow.tables_with_rows, rows.filter((x) => x.verdict === "persisted").length);
    const file = JSON.parse(readFileSync(join(dir, "persisted.json"), "utf8")) as Json; assert.equal(file["migration_head"], newestMigration()); assert.equal(file["run_id"], o["run_id"]); assert.equal((file["tables"] as Json[]).length, rows.length);
    const done = await events("audit.persisted.run_completed", `AND payload->>'run_id' = $2`, [o["run_id"]]); assert.equal(done.length, 1); assert.equal(Number(done[0]!.payload["tables_with_rows"]), rows.filter((x) => x.verdict === "persisted").length); assert.equal(done[0]!.payload["migration_head"], newestMigration());
    T17_WORLD = { url: w.url, run: o };
  } finally { await new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }); await wdb.end(); }
});

test("35.11-T18: Given the §35 journeys have run (35.5's daily cashiering year, 35.6's closing and funding, 35.9's default timeline, 35.10's refinance close) and the two lifecycle tests, when the persisted count runs, then `sections_complete` includes 2, 7 and 16 (every table those journeys declare as `expected` is `persisted` and `projection_gaps` for each is 0), every `expected` table with verdict `untouched` is listed in the run's output with the journey step that should have written it, and `docs/audit/COVERAGE.md` shows `hosted` and `persisted` columns on every process row and two exec totals lines after the six unit totals.", { skip }, async () => {
  assert.ok(T17_WORLD, "T17's journey database"); const dir = mkdtempSync(join(tmpdir(), "s3511-persisted-"));
  // the §35 journeys (35.5, 35.6, 35.9, 35.10) and the two lifecycle tests declare their writes in stewardship-35-11/journeys.ts; on this tree their databases are read when present (an absent journey is not measured, never failed) — T17's journey stands in for the sections its steps wrote: 2 (payments), 7 (statement_cycles), 16 (payoff_quotes)
  // two manifest tables T17's journey left untouched, from a section its steps did not write: the step that "should have written" them is declared and never ran
  const notRun = await db.query<{ table_name: string; section: number }>(`SELECT table_name, section FROM persisted_measurements WHERE run_id = $1::uuid AND verdict = 'untouched' AND section NOT IN (0, 1, 2, 7, 16, 20) ORDER BY section, table_name LIMIT 2`, [T17_WORLD.run["run_id"]]);
  assert.equal(notRun.length, 2); const notRunSection = notRun[0]!.section;
  const steps = [{ step: "35.5 the daily cashiering year: the payment received and applied", writes: ["payments", "loans", "loan_events", "ledger_lines"] }, { step: "35.9 the default timeline: the statement cycle", writes: ["statement_cycles", "notices"] }, { step: "35.10 the refinance close: the payoff quote", writes: ["payoff_quotes"] }, { step: "35.6 the closing: a step this tree has not run", writes: notRun.map((x) => x.table_name) }];
  const r = await tool("audit.persisted.count", QC, { journeys: [{ name: "35-11.spec.test.ts#t18", database_url: T17_WORLD.url, steps }, "lifecycle.test.ts", "purchase-lifecycle.test.ts", "35-5.spec.test.ts", "35-6.spec.test.ts", "35-9.spec.test.ts", "35-10.spec.test.ts"], audit_dir: dir }); const o = r.output as Json;
  assert.equal(o["outcome"], "completed", String(o["failure"]));
  const complete = o["sections_complete"] as number[]; for (const s of [2, 7, 16]) assert.ok(complete.includes(s), `sections_complete includes ${s}: ${JSON.stringify(complete)} (measured ${JSON.stringify(o["sections_measured"])})`);
  const sectionGaps = o["sections_gaps"] as Record<string, number>; for (const s of [2, 7, 16]) assert.equal(sectionGaps[String(s)], 0, `projection_gaps for section ${s} is 0`);
  const untouched = o["untouched_expected"] as { table: string; expected_by: string }[];
  for (const t of notRun.map((x) => x.table_name)) assert.ok(untouched.some((u) => u.table === t && /35\.6 the closing/.test(u.expected_by)), `${t} listed with the step that should have written it: ${JSON.stringify(untouched)}`);
  assert.ok(!complete.includes(notRunSection), `section ${notRunSection}, whose expected table is untouched, is not complete`);
  const dbs = o["journey_databases"] as { name: string; present: boolean }[]; assert.ok(dbs.some((d) => d.name === "35-11.spec.test.ts#t18" && d.present)); for (const n of ["35-5.spec.test.ts", "35-6.spec.test.ts", "35-9.spec.test.ts", "35-10.spec.test.ts"]) assert.ok(dbs.some((d) => d.name === n), `${n} named (present or not measured)`);
  // the audit shows the two exec columns on every process row and two exec totals lines after the six unit totals
  const md = readFileSync(`${ROOT}docs/audit/COVERAGE.md`, "utf8"); const lines = md.split("\n");
  const header = lines.find((l) => l.startsWith("| Process |"))!; // hosted and persisted after figures, before units (rule 12); `retired` after units is the audit's own column (spec/registry/README.md: a retired unit is neither spec nor built)
  assert.equal(header, "| Process | T-ids | tables | timers | notices | tools | figures | hosted | persisted | units | retired | % |");
  const processRows = lines.filter((l) => /^\| \d+\.\d+ \|/.test(l)); assert.ok(processRows.length >= 200); for (const l of processRows) assert.equal(l.split("|").length - 2, 12, l);
  const totalsStart = lines.indexOf("| Unit | Built / spec | % |"); const unitRows = lines.slice(totalsStart + 2, totalsStart + 8); assert.deepEqual(unitRows.map((l) => l.split("|")[1]!.trim()), ["tids", "tables", "timers", "notices", "tools", "figures"]);
  assert.equal(lines[totalsStart + 8]!.split("|")[1]!.trim(), "hosted (runs)"); assert.equal(lines[totalsStart + 9]!.split("|")[1]!.trim(), "persisted (runs)");});

