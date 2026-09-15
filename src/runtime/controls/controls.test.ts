// 34.4 evidence and controls — module tests over src/runtime/controls/* on a private database `<base>_controls`
// (spec/sections/34-operator-portal/34-4-*.md; the spec's T-ids live in src/domain/operator-portal/34-4.spec.test.ts).
// The fixture book (33.1 rule 7) is seeded as of 2026-09-01, the clock moves to 2026-09-15 07:20 America/New_York and
// runtime.sweep() breaches the fourteen-day invitation reminders and arms the daily review clock; three staff users
// (ops_analyst, compliance, admin) act through the 34.4 bus tools. Asserted: the clocks view and its GET-only contract, an
// escalation completed with and without the role, the requeue cap, the two-person kill switch with its expiry and the
// placeholder-turn levers (32.16 T10's mechanism), loan 1's evidence pack (manifest, hashes, no other loan's row), and that
// no money column changed across every controls call while every act left a decision naming the person.
//   REQUIRE_DB=1 TEST_DATABASE_URL=postgresql://sm:sm@localhost/supermortgage_<label> node --test src/runtime/controls/controls.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connect, type Db } from "../../infra/db/client.ts";
import { testDatabase } from "../../infra/db/test-db.ts";
import { loadOverriddenRegistry } from "../../domain/timer-overrides.ts";
import { FixedClock } from "../../kernel/events/index.ts";
import type { Actor } from "../../kernel/events/index.ts";
import { CommandRefused } from "../../app/commands.ts";
import { Runtime } from "../app.ts";
import { createLogger } from "../log.ts";
import { seedPartnerBookDemo } from "../partner-book.ts";
import { PgStaffRepository, emailHash, encryptEmail, staffEmailKey } from "../staff/repo.ts";
import { TOOLS_34_4 } from "../../app/tools/section34-4.ts";
import { ControlsRefused, moneyFingerprint, sha256Hex, CONTROLS_AGENT } from "./common.ts";
import { controlsTimer, controlsTimers } from "./timers.ts";
import { completeEscalation, listEscalations } from "./escalations.ts";
import { REQUEUE_CAP, getOutboxMessage, listOutbox } from "./outbox.ts";
import { KILL_CONFIRM_MINUTES, aiView, confirmKillSwitch, expireKillSwitchRequests, killRequests, killSwitchState, requestKillSwitch } from "./ai.ts";
import { EVIDENCE_SECTIONS, buildEvidencePack, getEvidencePack, verifyEvidencePack } from "./evidence.ts";
import { assertNoTimerWrite, controlsRoutes, matchControlsRoute, type ControlsRoute } from "./routes.ts";

const { url: DB_URL, skip } = await testDatabase(import.meta.url);
type Json = Record<string, unknown>;

const SEED_AT = "2026-09-01T16:00:00.000Z";                 // the fixture book's as-of day: the invitations go out, the reminders arm +14 calendar days
const NOW = "2026-09-16T11:20:00.000Z";                     // 07:20 America/New_York the day after the reminders' due day (due_at = end of 2026-09-15 ET): the sweep breaches them; the daily passes arm their clocks
const clock = new FixedClock(SEED_AT);
let db: Db; let runtime: Runtime; let repo: PgStaffRepository;
let OPS: Actor; let COMPLIANCE: Actor; let ADMIN: Actor; let OFFICER: Actor;
let loan1 = ""; let loan2 = ""; let party1 = ""; let party2 = "";
let moneyBefore = "";
const logLines: string[] = [];

const staff = async (email: string, roles: readonly ("ops_analyst" | "officer" | "compliance" | "admin")[]): Promise<Actor> => {
  const u = await repo.createUser({ email_hash: emailHash(email), email_encrypted: encryptEmail(email, staffEmailKey()), legal_name: email.split("@")[0]!, roles, invited_by: null, now: clock.now() });
  await repo.markEnrolled(u.id, clock.now());
  return { kind: "human", id: u.id, role: roles[0]! };
};
const events = async (type: string, where = "", p: unknown[] = []): Promise<{ id: string; loan_id: string | null; actor_id: string; actor_role: string | null; payload: Json; occurred_at: string }[]> =>
  db.query(`SELECT id::text AS id, loan_id::text AS loan_id, actor_id, actor_role, payload, occurred_at::text AS occurred_at FROM loan_events WHERE type = $1 ${where} ORDER BY sequence`, [type, ...p]);
const decisions = async (): Promise<{ id: string; action: string; rationale: string; subject_kind: string | null; subject_id: string | null; rule_set_version: string }[]> =>
  db.query(`SELECT id::text AS id, action, rationale, subject_kind, subject_id, rule_set_version FROM agent_decisions WHERE agent = $1 ORDER BY created_at, id`, [CONTROLS_AGENT]);
const run = (name: string, actor: Actor, input: Json) => runtime.execute({ process: "34.4", name, loanId: "", actor, input });
const refused = async (p: Promise<unknown>, code: string, extra?: (e: ControlsRefused) => void): Promise<void> => {
  try { await p; } catch (e) { assert.ok(e instanceof ControlsRefused, `a ControlsRefused, got ${(e as Error).name}: ${(e as Error).message}`); assert.equal(e.code, code, e.message); extra?.(e); return; }
  assert.fail(`expected ${code}`);
};
const busRefused = async (p: Promise<unknown>, code: string): Promise<void> => {
  try { await p; } catch (e) { assert.ok(e instanceof CommandRefused, `a CommandRefused, got ${(e as Error).name}: ${(e as Error).message}`); assert.equal(e.code, code, e.message); return; }
  assert.fail(`expected the bus to refuse ${code}`);
};
const openEscalation = async (ownerRole: string, loanId: string | null, payload: Json): Promise<string> => {
  const id = randomUUID();
  await runtime.escalationRepo.save({ id, kind: "sev4", ownerRole, ...(loanId ? { loanId } : {}), severity: "4", openedAt: clock.now(), openedBy: "system:test", status: "open", payload });
  return id;
};

test.before(async () => {
  if (skip) return;
  db = connect(DB_URL); repo = new PgStaffRepository(db);
  const logger = createLogger("json", (line) => { logLines.push(line); if (process.env["FLOW_DEBUG"] && /error/i.test(line)) process.stderr.write(line + "\n"); });
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock, logger, rateFeed: null, reviewers: null, analystLlm: null });
  OPS = await staff("ops.analyst@example.test", ["ops_analyst"]); COMPLIANCE = await staff("compliance@example.test", ["compliance"]); ADMIN = await staff("admin@example.test", ["admin"]); OFFICER = await staff("officer@example.test", ["officer"]);
  // the fixture book as of 2026-09-01 (33.1 rule 7): twelve monitored loans, the invitations, the fourteen-day reminder clocks
  const seeded = await seedPartnerBookDemo(runtime);
  assert.equal(seeded.status, "loaded", JSON.stringify(seeded.report).slice(0, 400));
  loan1 = seeded.loans.find((l) => l.servicer_loan_number === "NL-100001")!.loan_id; party1 = seeded.loans.find((l) => l.loan_id === loan1)!.party_id!;
  loan2 = seeded.loans.find((l) => l.servicer_loan_number !== "NL-100001" && l.party_id)!.loan_id; party2 = seeded.loans.find((l) => l.loan_id === loan2)!.party_id!;
  // two weeks on: the sweep breaches the reminders (their breach action sends one reminder) and runs 33.2's review and 33.3's readiness pass, which arm their daily clocks
  clock.set(NOW);
  const sweep = await runtime.sweep(NOW);
  assert.ok(sweep.breaches.some((b) => b.code === "SM_PARTNER_BOOK_INVITATION_REMINDER_14"), `the reminder clocks breached: ${JSON.stringify(sweep.breaches.map((b) => b.code))}`);
  // the staff actions the pack must find (loan 1's) and must not (loan 2's) — ids only (34.1 rule 4)
  await repo.logAction({ staff_user_id: OPS.id, session_id: null, at: NOW, route: `/api/loans/${loan1}`, method: "GET", subject_kind: "loan", subject_id: loan1, command: null, result: "ok", refusal_code: null });
  await repo.logAction({ staff_user_id: OPS.id, session_id: null, at: NOW, route: `/api/loans/${loan2}`, method: "GET", subject_kind: "loan", subject_id: loan2, command: null, result: "ok", refusal_code: null });
  moneyBefore = await moneyFingerprint(db);
});
test.after(async () => { if (!skip) await db.end(); });

// ---------------------------------------------------------------- rule 1: the clocks view; every timers route GET
test("controlsTimers: every armed, due and breached clock with code, subject, due, the registry's severity and breach role, the arming and satisfying events; the filters; the detail with its history", { skip }, async () => {
  const view = await controlsTimers(runtime, {}, NOW);
  assert.ok(view.counts.breached > 0 && view.counts.armed > 0, JSON.stringify(view.counts));
  const reminder = view.timers.find((t) => t.code === "SM_PARTNER_BOOK_INVITATION_REMINDER_14" && t.loan_id === loan1);
  assert.ok(reminder, "loan 1's reminder clock"); assert.equal(reminder.status, "breached"); assert.equal(reminder.severity, 3); assert.equal(reminder.breach_role, "portfolio"); assert.equal(reminder.process, "33.1");
  assert.equal(reminder.due_date, "2026-09-15"); assert.equal(reminder.subject_kind, "loan"); assert.equal(reminder.subject_id, loan1);
  assert.match(reminder.armed_by ?? "", /partner_book\.invitation\.sent/); assert.match(reminder.satisfied_by ?? "", /partner_book\.account\.activated/); assert.match(reminder.breach ?? "", /one reminder/);
  assert.ok(reminder.arming_event && reminder.arming_event.type === "partner_book.invitation.sent", JSON.stringify(reminder.arming_event)); assert.equal(reminder.satisfying_event, null);
  const daily = view.timers.find((t) => t.code === "SM_PARTNER_BOOK_REVIEW_DAILY") ?? view.timers.find((t) => t.code === "SM_PARTNER_BOOK_READINESS_DAILY");
  assert.ok(daily, "a daily book clock (33.2's review or 33.3's readiness) armed by today's pass"); assert.equal(daily.status, "armed"); assert.equal(daily.due, false); assert.ok(daily.breach_role && typeof daily.severity === "number", JSON.stringify(daily)); assert.match(daily.armed_by ?? "", /run_completed/);
  // the filters: status, code, subject (a loan id), due_before
  const breached = await controlsTimers(runtime, { status: "breached" }, NOW); assert.ok(breached.timers.length > 0 && breached.timers.every((t) => t.status === "breached"));
  const armed = await controlsTimers(runtime, { status: "armed" }, NOW); assert.ok(armed.timers.every((t) => t.status === "armed"));
  const byCode = await controlsTimers(runtime, { code: daily.code, status: "all" }, NOW); assert.ok(byCode.timers.length >= 1 && byCode.timers.every((t) => t.code === daily.code));
  const bySubject = await controlsTimers(runtime, { subject: loan1, status: "all" }, NOW); assert.ok(bySubject.timers.length >= 1 && bySubject.timers.every((t) => t.loan_id === loan1 || t.subject_id === loan1));
  const dueBefore = await controlsTimers(runtime, { due_before: "2026-09-16T12:00:00Z", status: "all" }, NOW); assert.ok(dueBefore.timers.some((t) => t.timer_id === reminder.timer_id)); assert.ok(dueBefore.timers.every((t) => (t.due_at ?? t.due_date ?? "") < "2026-09-16T12:00:00Z"));
  const due = await controlsTimers(runtime, { status: "due" }, NOW); assert.ok(due.timers.every((t) => t.status === "armed" && t.due));
  await assert.rejects(controlsTimers(runtime, { due_before: "not a date" }, NOW), RangeError);
  // one clock with its history: the timer.armed and timer.breached events that carry its id
  const one = await controlsTimer(runtime, reminder.timer_id, NOW);
  assert.ok(one); assert.deepEqual(one.history.map((h) => h.type), ["timer.armed", "timer.breached"]); assert.ok(one.history.every((h) => h.payload["timer_id"] === reminder.timer_id));
  assert.equal(await controlsTimer(runtime, randomUUID(), NOW), null);
  // the read tool on the bus, for an ops_analyst; an instruction to edit a clock is NO_CLOCK_EDIT
  const tool = await run("controls.timers", OPS, { status: "breached" });
  assert.ok(((tool.output as Json)["timers"] as unknown[]).length > 0); assert.equal(tool.decisionId, undefined, "a read tool records no decision");
  await busRefused(run("controls.timers", OPS, { op: "cancel", timer_id: reminder.timer_id }), "NO_CLOCK_EDIT");
  await busRefused(run("controls.timers", OPS, { extend: true, timer_id: reminder.timer_id, new_due_date: "2026-10-01" }), "NO_CLOCK_EDIT");
});
test("the route table: every /api/controls/timers* route is GET (T1's contract), the matcher binds :params, a table with a timer write never mounts", { skip }, () => {
  const routes = controlsRoutes({ runtime });
  const timerRoutes = routes.filter((r) => r.path.startsWith("/api/controls/timers"));
  assert.ok(timerRoutes.length >= 2); assert.ok(timerRoutes.every((r) => r.method === "GET"), JSON.stringify(timerRoutes.map((r) => `${r.method} ${r.path}`)));
  assert.deepEqual(routes.map((r) => `${r.method} ${r.path}`), ["GET /api/controls/timers", "GET /api/controls/timers/:id", "GET /api/controls/escalations", "GET /api/controls/escalations/:id", "POST /api/controls/escalations/:id/complete", "GET /api/controls/outbox", "GET /api/controls/outbox/:id", "POST /api/controls/outbox/:id/requeue", "GET /api/controls/ai", "GET /api/controls/ai/:code", "POST /api/controls/ai/:code/kill", "POST /api/controls/ai/:code/reset", "POST /api/controls/evidence", "GET /api/controls/evidence", "GET /api/controls/evidence/:id"]);
  assert.ok(routes.filter((r) => r.method === "POST").every((r) => r.command !== null), "every action route names its bus command for the staff_actions row");
  assert.deepEqual(routes.find((r) => r.path === "/api/controls/evidence" && r.method === "POST")!.roles, ["compliance"]);
  const m = matchControlsRoute(routes, "POST", `/api/controls/escalations/${loan1}/complete`); assert.ok(m); assert.equal(m.route.command, "controls.escalation.complete"); assert.equal(m.params["id"], loan1);
  assert.equal(matchControlsRoute(routes, "POST", "/api/controls/timers/x/cancel"), null); assert.equal(matchControlsRoute(routes, "DELETE", "/api/controls/timers"), null);
  const bad: ControlsRoute = { method: "POST", path: "/api/controls/timers/:id/satisfy", roles: ["admin"], command: "x", handler: async () => ({ status: 200, body: null }) };
  assert.throws(() => assertNoTimerWrite([...routes, bad]), /NO_CLOCK_EDIT/);
});

// ---------------------------------------------------------------- rule 2: an escalation completed by a named person, with and without the role
test("completeEscalation: an ops_analyst completes their escalation with a disposition and a reason on the bus — escalation.completed{disposition, reason, by} and a decision naming the person; a compliance escalation refuses the analyst ROLE_REQUIRED{compliance}; bad dispositions, a second completion, an agent", { skip }, async () => {
  const mine = await openEscalation("ops_analyst", loan1, { command: "book.import", reason: "row exception review" });
  const theirs = await openEscalation("compliance", loan1, { timer_code: "SM_STAFF_ACCESS_REVIEW_90" });
  const open = await listEscalations(runtime, { status: "open", role: "ops_analyst" });
  const row = open.escalations.find((e) => e.id === mine); assert.ok(row); assert.equal(row.completion, "row"); assert.deepEqual(row.dispositions, ["resolved", "dismissed", "referred"]); assert.equal(row.disposition, null);
  // without the role: 403 ROLE_REQUIRED{compliance} before any write
  await refused(completeEscalation(runtime, { id: theirs, disposition: "resolved", reason: "not mine", actor: OPS }), "ROLE_REQUIRED", (e) => assert.equal(e.extra["role"], "compliance"));
  await refused(run("controls.escalation.complete", OPS, { escalation_id: theirs, disposition: "resolved", reason: "not mine" }), "ROLE_REQUIRED", (e) => assert.equal(e.extra["role"], "compliance"));
  assert.equal((await listEscalations(runtime, { status: "open", role: "compliance" })).escalations.some((e) => e.id === theirs), true, "still open");
  // a disposition outside the set, a missing reason
  await refused(run("controls.escalation.complete", OPS, { escalation_id: mine, disposition: "approved", reason: "x" }), "DISPOSITION_REQUIRED");
  await refused(run("controls.escalation.complete", OPS, { escalation_id: mine, disposition: "resolved", reason: "  " }), "REASON_REQUIRED");
  // with the role, on the bus: the row completes, the receipt names the person, the decision carries the reason
  const out = await run("controls.escalation.complete", OPS, { escalation_id: mine, disposition: "resolved", reason: "the row exceptions were re-keyed from the supplement" });
  const o = out.output as Json; assert.equal(o["via"], "row"); assert.equal(o["disposition"], "resolved"); assert.equal(o["completed_by"], OPS.id); assert.equal(o["completed_by_role"], "ops_analyst");
  const receipt = (await events("escalation.completed", "AND payload->>'escalation_id' = $2", [mine]));
  assert.equal(receipt.length, 1); assert.equal(receipt[0]!.actor_id, OPS.id); assert.equal(receipt[0]!.actor_role, "ops_analyst"); assert.equal(receipt[0]!.loan_id, loan1);
  assert.equal(receipt[0]!.payload["disposition"], "resolved"); assert.equal(receipt[0]!.payload["reason"], "the row exceptions were re-keyed from the supplement"); assert.equal(receipt[0]!.payload["by"], OPS.id);
  const [e] = await db.query<{ status: string; completed_at: string | null }>(`SELECT status, completed_at::text AS completed_at FROM escalations WHERE id = $1`, [mine]); assert.equal(e!.status, "completed"); assert.ok(e!.completed_at);
  const done = (await listEscalations(runtime, { status: "completed", loan_id: loan1 })).escalations.find((x) => x.id === mine); assert.ok(done); assert.equal(done.completed_by, OPS.id); assert.equal(done.reason, "the row exceptions were re-keyed from the supplement");
  const d = (await decisions()).find((x) => x.subject_id === mine); assert.ok(d, "the decision record"); assert.equal(d.action, "controls.escalation.complete"); assert.equal(d.rule_set_version, "controls.v1");
  const record = JSON.parse(d.rationale) as Json; assert.equal(record["by"], OPS.id); assert.equal(record["disposition"], "resolved"); assert.equal(record["reason"], "the row exceptions were re-keyed from the supplement"); assert.equal(record["prompt_version"], "34.4-v1"); assert.equal(record["model_version"], "deterministic"); assert.equal(record["confidence"], 1);
  assert.ok(out.decisions.some((x) => x.id === d.id));
  // a second completion, an agent actor (a human act), a role the tool does not admit
  await refused(run("controls.escalation.complete", OPS, { escalation_id: mine, disposition: "resolved", reason: "again" }), "ALREADY_COMPLETED");
  await assert.rejects(run("controls.escalation.complete", { kind: "agent", id: "compliance-sentinel" }, { escalation_id: theirs, disposition: "resolved", reason: "x" }), CommandRefused);
  await busRefused(run("controls.escalation.complete", ADMIN, { escalation_id: theirs, disposition: "resolved", reason: "x" }), "ROLE_DENIED");   // 34.1 rule 2: admin touches no borrower row
  // the compliance officer completes their own
  const c = await run("controls.escalation.complete", COMPLIANCE, { escalation_id: theirs, disposition: "referred", reason: "the quarterly review is on the calendar" });
  assert.equal((c.output as Json)["completed_by"], COMPLIANCE.id);
});

// ---------------------------------------------------------------- rule 3: the requeue cap
test("requeueMessage: a dead message requeued three times by hand, each logged with the actor and the message queued; the fourth is REQUEUE_CAP_3 with one ops_analyst escalation; a fifth names the same escalation; a queued message is not requeueable; the guardrail refuses a forced count", { skip }, async () => {
  const id = (await db.query<{ id: string }>(`INSERT INTO integration_messages (adapter, direction, idempotency_key, status, error, attempts, loan_id, payload_summary) VALUES ('print-mail', 'out', $1, 'dead', 'FAKE vendor: 503', 5, $2, '{"kind": "notice"}'::jsonb) RETURNING id::text AS id`, [`test-${randomUUID()}`, loan1]))[0]!.id;
  const before = await getOutboxMessage(runtime, id); assert.ok(before); assert.equal(before.status, "dead"); assert.equal(before.requeues, 0); assert.equal(before.requeues_left, REQUEUE_CAP);
  for (let n = 1; n <= REQUEUE_CAP; n++) {
    const actor = n === 2 ? OFFICER : OPS;
    const out = await run("controls.outbox.requeue", actor, { message_id: id, reason: `hand requeue ${n}` });
    const o = out.output as Json; assert.equal(o["status"], "queued"); assert.equal(o["requeue_no"], n); assert.equal(o["by"], actor.id);
    const m = await getOutboxMessage(runtime, id); assert.ok(m); assert.equal(m.status, "queued"); assert.equal(m.attempts, 0); assert.equal(m.error, null); assert.equal(m.requeues, n); assert.equal(m.requeued_by[n - 1]!.by, actor.id); assert.equal(m.requeued_by[n - 1]!.role, actor.role);
    const d = (await decisions()).filter((x) => x.subject_id === id); assert.equal(d.length, n); assert.equal((JSON.parse(d[n - 1]!.rationale) as Json)["by"], actor.id);
    // the FAKE adapter fails it again (the sweep's delivery is not under test): back to dead
    await db.query(`UPDATE integration_messages SET status = 'dead', error = 'FAKE vendor: 503', attempts = 5 WHERE id = $1`, [id]);
  }
  const logged = await events("outbox.requeued", "AND payload->>'message_id' = $2", [id]); assert.equal(logged.length, 3); assert.deepEqual(logged.map((e) => e.actor_id), [OPS.id, OFFICER.id, OPS.id]); assert.deepEqual(logged.map((e) => e.payload["requeue_no"]), [1, 2, 3]);
  // the fourth: refused, the row untouched, one ops_analyst escalation
  let escalationId = "";
  await refused(run("controls.outbox.requeue", OPS, { message_id: id }), "REQUEUE_CAP_3", (e) => { escalationId = String(e.extra["escalation_id"]); assert.equal(e.extra["requeues"], 3); });
  assert.ok(escalationId);
  const [esc] = await db.query<{ owner_role: string; kind: string; payload: Json; loan_id: string | null }>(`SELECT owner_role, kind, payload, loan_id::text AS loan_id FROM escalations WHERE id = $1 AND completed_at IS NULL`, [escalationId]);
  assert.ok(esc); assert.equal(esc.owner_role, "ops_analyst"); assert.equal(esc.payload["code"], "REQUEUE_CAP_3"); assert.equal(esc.payload["message_id"], id); assert.equal(esc.payload["attempted_by"], OPS.id); assert.equal(esc.loan_id, loan1);
  const after = await getOutboxMessage(runtime, id); assert.ok(after); assert.equal(after.status, "dead"); assert.equal(after.requeues, 3); assert.equal(after.requeues_left, 0); assert.equal(after.cap_escalation_id, escalationId);
  assert.equal((await events("outbox.requeued", "AND payload->>'message_id' = $2", [id])).length, 3, "no fourth receipt");
  // a fifth attempt names the same open escalation; no second escalation
  await refused(run("controls.outbox.requeue", OFFICER, { message_id: id }), "REQUEUE_CAP_3", (e) => assert.equal(e.extra["escalation_id"], escalationId));
  assert.equal(Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM escalations WHERE payload->>'message_id' = $1`, [id]))[0]!.n), 1);
  // the list shows the message with its receipts and the cap escalation; a queued message is not requeueable; the guardrail refuses a forced count; compliance does not requeue
  const list = await listOutbox(runtime, { adapter: "print-mail", status: "dead" }); const row = list.messages.find((m) => m.id === id); assert.ok(row); assert.equal(row.requeued_by.length, 3); assert.equal(row.cap_escalation_id, escalationId);
  const queued = (await db.query<{ id: string }>(`INSERT INTO integration_messages (adapter, direction, idempotency_key, status) VALUES ('print-mail', 'out', $1, 'queued') RETURNING id::text AS id`, [`test-${randomUUID()}`]))[0]!.id;
  await refused(run("controls.outbox.requeue", OPS, { message_id: queued }), "NOT_REQUEUEABLE");
  await busRefused(run("controls.outbox.requeue", OPS, { message_id: id, force: true }), "REQUEUE_CAP_3");
  await busRefused(run("controls.outbox.requeue", OPS, { message_id: id, reset_count: true }), "REQUEUE_CAP_3");
  await busRefused(run("controls.outbox.requeue", COMPLIANCE, { message_id: id }), "ROLE_DENIED");
  await refused(run("controls.outbox.requeue", OPS, { message_id: randomUUID() }), "NO_SUCH_MESSAGE");
  // the analyst completes the cap escalation like any other (rule 2: the row path — 34.4 owns no completion command)
  const done = await run("controls.escalation.complete", OPS, { escalation_id: escalationId, disposition: "referred", reason: "the print vendor's 503s are with the vendor desk" });
  assert.equal((done.output as Json)["via"], "row");
});

// ---------------------------------------------------------------- rule 4: the two-person kill switch, its expiry, the placeholder turn's levers
test("the kill switch: compliance requests intake with a reason and nothing trips; the requester cannot confirm; an admin confirms within 10 minutes → ai.kill_switch.tripped{by, confirmed_by, reason}, the flag and the registry's AI-off (32.16 T10's levers), the AI view shows it; the reset needs the same two roles; an unconfirmed request expires at 10 minutes with nothing tripped", { skip }, async () => {
  clock.set(NOW);
  assert.equal((await killSwitchState(runtime, "intake")).state, "armed"); assert.equal(runtime.agents.aiState("intake").off, false);
  // roles: ops_analyst may not request; admin may not request; compliance may not confirm
  await busRefused(run("controls.ai.kill", OPS, { op: "request", code: "intake", action: "trip", reason: "x" }), "ROLE_DENIED");   // the tool admits compliance and admin only
  await refused(requestKillSwitch(runtime, { code: "intake", action: "trip", reason: "x", actor: OPS }, NOW), "ROLE_REQUIRED", (e) => assert.equal(e.extra["role"], "compliance"));
  await refused(run("controls.ai.kill", ADMIN, { op: "request", code: "intake", action: "trip", reason: "x" }), "ROLE_REQUIRED", (e) => assert.equal(e.extra["role"], "compliance"));
  await refused(run("controls.ai.kill", COMPLIANCE, { op: "request", code: "no-such-system", action: "trip", reason: "x" }), "UNKNOWN_SYSTEM");
  await refused(run("controls.ai.kill", COMPLIANCE, { op: "request", code: "intake", action: "trip", reason: "" }), "REASON_REQUIRED");
  await busRefused(run("controls.ai.kill", COMPLIANCE, { op: "request", code: "intake", action: "trip", reason: "x", skip_confirmation: true }), "TWO_PERSON_KILL");
  // step one: the request — nothing trips
  const req = await run("controls.ai.kill", COMPLIANCE, { op: "request", code: "intake", action: "trip", reason: "prompt 32.16-v3 is answering rate questions with figures (18.1 rule D.5)" });
  const r = req.output as Json; const requestId = String(r["request_id"]); assert.equal(r["status"], "pending"); assert.equal(r["expires_at"], new Date(Date.parse(NOW) + KILL_CONFIRM_MINUTES * 60_000).toISOString());
  assert.equal((await killSwitchState(runtime, "intake")).state, "armed"); assert.equal(runtime.agents.aiState("intake").off, false);
  assert.equal((await db.query(`SELECT 1 FROM feature_flags WHERE key = 'intake.enabled' AND value = 'false'::jsonb`)).length, 0, "no flag on a request alone");
  assert.equal((await events("ai.kill_switch.tripped")).length, 0);
  await refused(run("controls.ai.kill", COMPLIANCE, { op: "request", code: "intake", action: "trip", reason: "again" }), "REQUEST_PENDING");
  // the requester claiming a role their staff_users row does not hold is ROLE_DENIED before anything else (review finding: the actor is verified from rows — src/runtime/controls/common.ts requireStaffRole); compliance cannot confirm; an unknown request id
  await refused(confirmKillSwitch(runtime, { request_id: requestId, actor: { kind: "human", id: COMPLIANCE.id, role: "admin" } }, NOW), "ROLE_DENIED", (e) => assert.deepEqual(e.extra["held"], ["compliance"]));
  await refused(confirmKillSwitch(runtime, { request_id: requestId, actor: { kind: "human", id: randomUUID(), role: "admin" } }, NOW), "ROLE_DENIED", (e) => assert.deepEqual(e.extra["held"], []));
  await refused(confirmKillSwitch(runtime, { request_id: requestId, actor: { kind: "human", id: "forged-admin", role: "admin" } }, NOW), "ROLE_DENIED");
  await refused(run("controls.ai.kill", COMPLIANCE, { op: "confirm", request_id: requestId }), "ROLE_REQUIRED", (e) => assert.equal(e.extra["role"], "admin"));
  await refused(run("controls.ai.kill", ADMIN, { op: "confirm", request_id: randomUUID() }), "NO_SUCH_REQUEST");
  // step two: a different person, admin, within 10 minutes
  clock.set(new Date(Date.parse(NOW) + 4 * 60_000).toISOString());
  const conf = await run("controls.ai.kill", ADMIN, { op: "confirm", request_id: requestId });
  const c = conf.output as Json; assert.equal(c["state"], "tripped"); assert.equal(c["event"], "ai.kill_switch.tripped"); assert.equal(c["by"], COMPLIANCE.id); assert.equal(c["confirmed_by"], ADMIN.id);
  const tripped = await events("ai.kill_switch.tripped"); assert.equal(tripped.length, 1); assert.equal(tripped[0]!.payload["code"], "intake"); assert.equal(tripped[0]!.payload["by"], COMPLIANCE.id); assert.equal(tripped[0]!.payload["confirmed_by"], ADMIN.id); assert.match(String(tripped[0]!.payload["reason"]), /32\.16-v3/); assert.equal(tripped[0]!.actor_id, ADMIN.id);
  // 32.16 T10 / T-17-10's mechanism: the borrower turn's `bypassed()` reads the registry's AI-off state first, then the `<agent>.enabled` flag — both are set, so every turn of intake returns the placeholder until reset
  assert.equal((await db.query<{ value: unknown }>(`SELECT value FROM feature_flags WHERE key = 'intake.enabled'`))[0]!.value, false);
  assert.equal(runtime.agents.aiState("intake").off, true); assert.match(runtime.agents.aiState("intake").why ?? "", /kill switch tripped by .* confirmed by/);
  const state = await killSwitchState(runtime, "intake"); assert.equal(state.state, "tripped"); assert.equal(state.by, COMPLIANCE.id); assert.equal(state.confirmed_by, ADMIN.id); assert.equal(state.flag, false); assert.ok(state.ai_off);
  const view = await aiView(runtime, clock.now()); const intake = view.agents.find((a) => a.agent === "intake"); assert.ok(intake); assert.equal(intake.kill_switch.state, "tripped"); assert.equal(intake.off, true); assert.equal(intake.pending_request, null);
  assert.ok(view.requests.some((x) => x.request_id === requestId && x.status === "confirmed" && x.confirmed_by === ADMIN.id));
  const dec = (await decisions()).filter((d) => d.subject_id === "intake"); assert.equal(dec.length, 2);
  assert.equal((JSON.parse(dec[0]!.rationale) as Json)["by"], COMPLIANCE.id); assert.equal((JSON.parse(dec[1]!.rationale) as Json)["confirmed_by"], ADMIN.id); assert.equal((JSON.parse(dec[1]!.rationale) as Json)["by"], COMPLIANCE.id);
  // a second confirmation of the same request; a trip request while tripped
  await refused(run("controls.ai.kill", ADMIN, { op: "confirm", request_id: requestId }), "REQUEST_CLOSED");
  await refused(run("controls.ai.kill", COMPLIANCE, { op: "request", code: "intake", action: "trip", reason: "x" }), "ALREADY_TRIPPED");
  // the reset needs the same two roles: compliance requests, admin confirms
  await refused(run("controls.ai.kill", ADMIN, { op: "request", code: "intake", action: "reset", reason: "fixed" }), "ROLE_REQUIRED");
  const rreq = await run("controls.ai.kill", COMPLIANCE, { op: "request", code: "intake", action: "reset", reason: "prompt 32.16-v4 evaluated and approved" });
  assert.equal(runtime.agents.aiState("intake").off, true, "still tripped on the request alone");
  const rconf = await run("controls.ai.kill", ADMIN, { op: "confirm", request_id: (rreq.output as Json)["request_id"] });
  assert.equal((rconf.output as Json)["state"], "armed"); assert.equal((await killSwitchState(runtime, "intake")).state, "armed");
  assert.equal((await db.query<{ value: unknown }>(`SELECT value FROM feature_flags WHERE key = 'intake.enabled'`))[0]!.value, true); assert.equal(runtime.agents.aiState("intake").off, false);
  const reset = await events("ai.kill_switch.reset"); assert.equal(reset.length, 1); assert.equal(reset[0]!.payload["by"], COMPLIANCE.id); assert.equal(reset[0]!.payload["confirmed_by"], ADMIN.id);
  // expiry: an unconfirmed request; at 10 minutes and a second it has expired — the late confirmation is refused, the expiry is logged, nothing tripped
  const t0 = clock.now();
  const exp = await requestKillSwitch(runtime, { code: "intake", action: "trip", reason: "a second look", actor: COMPLIANCE }, t0);
  const late = new Date(Date.parse(t0) + KILL_CONFIRM_MINUTES * 60_000 + 1000).toISOString();
  assert.equal((await killRequests(runtime, { code: "intake" }, new Date(Date.parse(t0) + 9 * 60_000).toISOString())).find((x) => x.request_id === exp.request_id)!.status, "pending");
  await refused(confirmKillSwitch(runtime, { request_id: exp.request_id, actor: ADMIN }, late), "REQUEST_EXPIRED");
  const expired = await events("ai.kill_switch.request.expired"); assert.equal(expired.length, 1); assert.equal(expired[0]!.payload["request_id"], exp.request_id);
  assert.equal((await killSwitchState(runtime, "intake")).state, "armed"); assert.equal(runtime.agents.aiState("intake").off, false); assert.equal((await events("ai.kill_switch.tripped")).length, 1, "nothing tripped");
  assert.equal(await expireKillSwitchRequests(runtime, late), 0, "logged once");
  assert.equal((await killRequests(runtime, { code: "intake" }, late)).find((x) => x.request_id === exp.request_id)!.status, "expired");
  clock.set(NOW);
  // the requester as confirmer, genuinely holding both roles, is TWO_PERSON_KILL (rule 4: two people's decision) — on a second system, after intake's flow, so its own pending request counts among no expiry above
  const BOTH = await staff("both@example.test", ["compliance", "admin"]);
  const own = await requestKillSwitch(runtime, { code: "portfolio", action: "trip", reason: "a one-person attempt", actor: BOTH }, NOW);
  await refused(confirmKillSwitch(runtime, { request_id: own.request_id, actor: { kind: "human", id: BOTH.id, role: "admin" } }, NOW), "TWO_PERSON_KILL", (e) => assert.equal(e.extra["requested_by"], BOTH.id));
  assert.equal((await killSwitchState(runtime, "portfolio")).state, "armed", "nothing tripped by one person"); assert.equal((await events("ai.kill_switch.tripped")).length, 1);
});

// ---------------------------------------------------------------- rule 5: loan 1's evidence pack
test("buildEvidencePack: compliance packs loan 1 — one document with a hash, the manifest with a count and a sha256 per row set (events, decisions, notices with checklists, timers with histories, escalations, ledger sets, agent turns, consents, verifications, credit reports, the partner-book rows, the staff actions), no row of another loan or person, reproducible; parts of ≤ n events; the roles", { skip }, async () => {
  clock.set(NOW);
  const out = await run("controls.evidence.pack", COMPLIANCE, { subject: { loan_id: loan1 } });
  const o = out.output as Json; const manifest = o["manifest"] as Json; const sections = manifest["sections"] as Json[];
  assert.deepEqual(sections.map((x) => x["name"]), [...EVIDENCE_SECTIONS]);
  for (const x of sections) { assert.equal(typeof x["count"], "number"); assert.match(String(x["sha256"]), /^[0-9a-f]{64}$/); }
  const count = (name: string): number => Number(sections.find((x) => x["name"] === name)!["count"]);
  assert.ok(count("events") > 0 && count("timers") > 0 && count("partner_book") > 0 && count("escalations") > 0 && count("staff_actions") === 1 && count("decisions") >= 1, JSON.stringify(sections.map((x) => [x["name"], x["count"]])));
  assert.equal(count("ledger_sets"), 0, "a monitored loan has no ledger set (33.1: the partner's servicing figures are facts, not postings)");
  const detail = sections.find((x) => x["name"] === "timers")!["detail"] as Json; assert.ok(Number(detail["history_events"]) >= count("timers"), "every timer with its history");
  assert.ok((sections.find((x) => x["name"] === "partner_book")!["detail"] as Json)["partner_book_facts"], "the facts row");
  // the document: one, hashed, stored with its hash; the row; the event
  const document = String(o["document"]); assert.equal(o["sha256"], sha256Hex(document)); assert.equal(o["byte_size"], Buffer.byteLength(document, "utf8")); assert.equal(o["part_count"], 1);
  const packId = String(o["id"]); const docId = String(o["document_id"]);
  const [doc] = await db.query<{ kind: string; sha256: string; loan_id: string; storage_uri: string; byte_size: bigint }>(`SELECT kind, sha256, loan_id::text AS loan_id, storage_uri, byte_size FROM documents WHERE id = $1`, [docId]);
  assert.ok(doc); assert.equal(doc.kind, "evidence_pack"); assert.equal(doc.sha256, o["sha256"]); assert.equal(doc.loan_id, loan1); assert.equal(doc.storage_uri, `evidence://packs/${packId}`); assert.equal(Number(doc.byte_size), o["byte_size"]);
  const row = await getEvidencePack(runtime, packId); assert.ok(row); assert.equal(row.subject_kind, "loan"); assert.equal(row.subject_id, loan1); assert.equal(row.sha256, o["sha256"]); assert.equal(row.document_id, docId); assert.equal(row.produced_by, COMPLIANCE.id); assert.deepEqual(row.sections, [...EVIDENCE_SECTIONS]); assert.deepEqual(row.manifest.sections, sections);
  const produced = await events("evidence.pack.produced", "AND payload->>'pack_id' = $2", [packId]); assert.equal(produced.length, 1); assert.equal(produced[0]!.actor_id, COMPLIANCE.id); assert.equal(produced[0]!.payload["sha256"], o["sha256"]); assert.equal(produced[0]!.loan_id, loan1);
  await assert.rejects(db.query(`UPDATE evidence_packs SET sha256 = 'x' WHERE id = $1`, [packId]), /append-only/);
  // the parts: the events part document, hashed and stored; the manifest's events hash chains the parts
  const parts = o["parts"] as Json[]; assert.equal(parts.length, 1); const part = JSON.parse(String(parts[0]!["content"])) as Json;
  assert.equal((part["events"] as unknown[]).length, count("events")); assert.equal(parts[0]!["sha256"], sha256Hex(String(parts[0]!["content"])));
  assert.equal(sections.find((x) => x["name"] === "events")!["sha256"], sha256Hex(String(parts[0]!["sha256"])));
  assert.equal((await db.query<{ sha256: string }>(`SELECT sha256 FROM documents WHERE id = $1 AND kind = 'evidence_pack_part'`, [String(parts[0]!["document_id"])]))[0]!.sha256, parts[0]!["sha256"]);
  // the pack is the stored rows: every event is loan 1's; the staff action is loan 1's; the partner-book rows are loan 1's; no other loan's or person's id anywhere in the text
  const body = JSON.parse(document) as { manifest: Json; sets: Record<string, Json[]> };
  assert.ok((part["events"] as Json[]).every((e) => e["loan_id"] === loan1)); assert.ok(body.sets["timers"]!.every((t) => t["loan_id"] === loan1)); assert.ok(body.sets["escalations"]!.every((e) => e["loan_id"] === loan1));
  assert.deepEqual(body.sets["staff_actions"]!.map((a) => a["subject_id"]), [loan1]); assert.ok(body.sets["partner_book"]!.every((r) => (r["data"] as Json)["loan_id"] === loan1));
  assert.ok(body.sets["timers"]!.every((t) => Array.isArray(t["history"]) && (t["history"] as Json[]).every((h) => (h["payload"] as Json)["timer_id"] === t["id"])));
  assert.equal(document.includes(loan2), false, "no row of another loan"); assert.equal(document.includes(party2), false, "no row of another person");
  assert.equal(String(parts[0]!["content"]).includes(loan2), false);
  for (const inv of body.sets["partner_book"]!.filter((r) => r["table_name"] === "partner_book_invitations")) { const d = inv["data"] as Json; assert.match(String(d["destination_hash"]), /^[0-9a-f]{64}$/); assert.equal("message_id" in d, false); assert.equal(Object.values(d).some((v) => /@example\.com/.test(String(v))), false, "a hash and a date, never a destination"); }
  // the decision names the person; the manifest and the re-hashed rows agree (verify)
  const d = (await decisions()).find((x) => x.subject_id === packId); assert.ok(d); assert.equal((JSON.parse(d.rationale) as Json)["by"], COMPLIANCE.id); assert.match(d.rationale, new RegExp(String(o["sha256"])));
  const v = await verifyEvidencePack(runtime, packId); assert.ok(v); assert.equal(v.verified, true, JSON.stringify(v.sections.filter((x) => !x.ok)));
  // a chosen section set; parts of ≤ 3 events with one manifest; a period; a party; the roles and the guardrails
  const some = await buildEvidencePack(runtime, { subject: { loan_id: loan1 }, sections: ["events", "timers"], produced_by: COMPLIANCE, part_size: 3 }, NOW);
  const n2 = some.manifest.sections.find((x) => x.name === "events")!.count; assert.equal(n2, count("events") + 1, "the first pack's own evidence.pack.produced is loan 1's newest event");
  assert.deepEqual(some.sections, ["events", "timers"]); assert.equal(some.part_count, Math.ceil(n2 / 3)); assert.ok(some.parts.every((p) => (JSON.parse(p.content) as { events: unknown[] }).events.length <= 3)); assert.equal(some.parts.reduce((n, p) => n + (JSON.parse(p.content) as { events: unknown[] }).events.length, 0), n2);
  assert.equal(some.manifest.parts.length, some.part_count); assert.equal(new Set(some.parts.flatMap((p) => (JSON.parse(p.content) as { events: Json[] }).events.map((e) => e["id"]))).size, n2, "a part never repeats a row");
  assert.equal(some.manifest.sections.find((x) => x.name === "events")!.sha256, sha256Hex(some.parts.map((p) => p.sha256).join("\n")), "the events hash chains the parts");
  const period = await buildEvidencePack(runtime, { subject: { period: { from: "2026-09-01", to: "2026-09-16" } }, produced_by: COMPLIANCE }, NOW);
  assert.equal(period.subject_kind, "period"); assert.equal(period.from_date, "2026-09-01"); assert.equal(period.to_date, "2026-09-16"); assert.ok(period.manifest.sections.find((x) => x.name === "events")!.count > count("events"), "the period holds every loan's events");
  const person = await buildEvidencePack(runtime, { subject: { party_id: party1 }, produced_by: COMPLIANCE }, NOW);
  assert.equal(person.subject_kind, "party"); assert.ok(person.manifest.sections.find((x) => x.name === "partner_book")!.count >= 1, "the person's invitation"); assert.equal(person.document.includes(party2), false);
  await busRefused(run("controls.evidence.pack", OPS, { subject: { loan_id: loan1 } }), "ROLE_DENIED");
  await busRefused(run("controls.evidence.pack", ADMIN, { subject: { loan_id: loan1 } }), "ROLE_DENIED");
  await busRefused(run("controls.evidence.pack", COMPLIANCE, { subject: { loan_id: loan1 }, summarize: true }), "PACK_IS_STORED_ROWS");
  await busRefused(run("controls.evidence.pack", COMPLIANCE, { subject: { loan_id: loan1 }, waiver: true }), "NO_MONEY_FIELD");
  await refused(run("controls.evidence.pack", COMPLIANCE, { subject: { loan_id: randomUUID() } }), "NO_SUCH_SUBJECT");
  await refused(run("controls.evidence.pack", COMPLIANCE, { subject: { period: { from: "2026-09-15", to: "2026-09-01" } } }), "BAD_SUBJECT");
  await refused(run("controls.evidence.pack", COMPLIANCE, { subject: { loan_id: loan1 }, sections: ["events", "ledger"] }), "BAD_SECTION");
});

// ---------------------------------------------------------------- rule 6: no money field written; every act with a decision naming the person
test("the money contract: the ledger and every money column are identical before and after every controls call; every act recorded a compliance-sentinel decision naming the person under controls.v1", { skip }, async () => {
  assert.equal(await moneyFingerprint(db), moneyBefore, "no money column changed across the controls calls");
  const all = await decisions(); assert.ok(all.length >= 9, `${all.length} decisions`);
  const people = new Set([OPS.id, OFFICER.id, COMPLIANCE.id, ADMIN.id]);
  for (const d of all) { const r = JSON.parse(d.rationale) as Json; assert.ok(people.has(String(r["by"])) || people.has(String(r["confirmed_by"])), d.rationale); assert.equal(r["rule_set_version"], "controls.v1"); assert.equal(d.rule_set_version, "controls.v1"); assert.ok(d.subject_id); }
  assert.ok(TOOLS_34_4.filter((t) => t.kind !== "read").every((t) => t.humanOnly === true), "every act is a person's");
  assert.deepEqual(TOOLS_34_4.map((t) => t.name), ["controls.timers", "controls.escalation.complete", "controls.outbox.requeue", "controls.ai.kill", "controls.evidence.pack"]);
  for (const t of TOOLS_34_4) assert.ok(t.guardrails!.some((g) => g.code === "NO_MONEY_FIELD"), `${t.name} carries NO_MONEY_FIELD`);
  assert.ok(logLines.every((l) => !/error/i.test(l) || /partner book/.test(l)), logLines.filter((l) => /error/i.test(l)).slice(0, 3).join("\n"));
});
