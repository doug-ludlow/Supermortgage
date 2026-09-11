/**
 * The borrower event stream (docs/ux/02-data-contracts.md §3): `GET /v1/borrower/stream` delivers
 * `{event_name, at, subject, payload_ref}` for a subscribed event after a tool executes on the bus — fed from the event
 * store through the runtime's post-commit hook, in-process, one subscriber list per party; a reconnect with
 * `Last-Event-ID` replays what was missed; the heartbeat keeps the connection alive; nothing that is not subscribed
 * (`command.executed`, `timer.*`) and nothing for another party ever reaches a connection. Skips without a database.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { connect, reachable, type Db } from "../../infra/db/client.ts";
import { loadOverriddenRegistry } from "../../domain/timer-overrides.ts";
import { FixedClock } from "../../kernel/events/index.ts";
import { Runtime } from "../app.ts";
import { createApiServer, listen } from "../server.ts";
import { createLogger } from "../log.ts";
import { createBorrowerRouter } from "./routes.ts";
import { HEARTBEAT_MS, RING_SIZE, subscribed } from "./stream.ts";

const DB_URL = process.env["TEST_DATABASE_URL"] ?? "postgresql://sm:sm@localhost/supermortgage_test";
const up = await reachable(DB_URL);
if (!up && process.env["REQUIRE_DB"]) throw new Error(`REQUIRE_DB set but ${DB_URL} is not reachable`);
const skip = up ? false : `no Postgres at ${DB_URL}`;
const TOKEN = "ops-" + randomUUID();
const R = randomUUID().slice(0, 8);
const T0 = "2026-10-05T17:41:00.000Z";
const clock = new FixedClock(T0);
const EMAIL_A = `alex-${R}@example.test`; const EMAIL_B = `blake-${R}@example.test`;

let db: Db; let runtime: Runtime; let base = ""; let close: () => Promise<void> = async () => undefined; let hub: ReturnType<typeof createBorrowerRouter>["hub"];
let appA = ""; let appB = "";

test.before(async () => {
  if (skip) return;
  execFileSync(fileURLToPath(new URL("../../../db/migrate.sh", import.meta.url)), { env: { ...process.env, DATABASE_URL: DB_URL }, stdio: "pipe" });
  db = connect(DB_URL);
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock });
  const logger = createLogger("json", () => undefined);
  const router = createBorrowerRouter({ runtime, logger, environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost"], urlSecret: "test-secret" });
  hub = router.hub;
  const server = createApiServer({ runtime, apiToken: TOKEN, logger, console: false, borrowerRouter: router });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => { router.hub.close(); server.closeAllConnections?.(); server.close(() => db.end().then(() => resolve())); });
  const partner = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number) VALUES ('servicer', $1, '123456789') RETURNING id`, [`Lender ${R}`]))[0]!.id;
  const open = async (email: string, addr: string) => { const r = await ops("POST", "/v1/applications", { actor: { kind: "agent", id: "intake" }, application: { partner_party_id: partner, channel: "organic", transaction_type: "limited_cash_out", occupancy: "primary", borrowers: [{ legal_name: "Fixture Borrower", contact: { email } }], property: { address_line1: addr, city: "Phoenix", state: "AZ", postal_code: "85018" } } }); assert.equal(r.status, 200, JSON.stringify(r.body)); return (r.body["application"] as { id: string }).id; };
  appA = await open(EMAIL_A, "1 Stream St"); appB = await open(EMAIL_B, "2 Other St");
});
test.after(async () => { if (!skip) await close(); });

type Reply = { status: number; body: Record<string, unknown> };
async function ops(method: string, path: string, body?: unknown): Promise<Reply> { const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, body: (await r.json()) as Record<string, unknown> }; }
async function api(method: string, path: string, body?: unknown, token?: string): Promise<Reply> { const r = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }); const text = await r.text(); return { status: r.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} }; }
async function signIn(email: string): Promise<string> { const req = await api("POST", "/v1/borrower/auth/otp", { action: "request", channel: "email", destination: email }); const ver = await api("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: req.body["challenge_id"], code: req.body["fake_code"] }); assert.equal(ver.status, 200, JSON.stringify(ver.body)); return ver.body["token"] as string; }

interface Frame { id: number | null; event: string | null; data: Record<string, unknown> | null; comment: string | null }
/** An SSE client over fetch: frames as they arrive; `next(pred)` waits for one; `close()` aborts. */
function sse(path: string, headers: Record<string, string>): { frames: Frame[]; next: (pred: (f: Frame) => boolean, ms?: number) => Promise<Frame>; close: () => void; status: () => number } {
  const ac = new AbortController(); const frames: Frame[] = []; const waiters: { pred: (f: Frame) => boolean; resolve: (f: Frame) => void }[] = []; let status = 0;
  const push = (f: Frame) => { frames.push(f); for (const w of [...waiters]) if (w.pred(f)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(f); } };
  (async () => {
    const r = await fetch(base + path, { headers, signal: ac.signal }); status = r.status;
    if (!r.body) return; const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = "";
    try { for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true });
      let idx: number; while ((idx = buf.indexOf("\n\n")) >= 0) { const block = buf.slice(0, idx); buf = buf.slice(idx + 2); const f: Frame = { id: null, event: null, data: null, comment: null };
        for (const line of block.split("\n")) { if (line.startsWith(":")) f.comment = line.slice(1).trim(); else if (line.startsWith("id:")) f.id = Number(line.slice(3).trim()); else if (line.startsWith("event:")) f.event = line.slice(6).trim(); else if (line.startsWith("data:")) f.data = JSON.parse(line.slice(5).trim()) as Record<string, unknown>; }
        push(f); } } } catch { /* aborted */ }
  })();
  return { frames, next: (pred, ms = 5000) => { const hit = frames.find(pred); if (hit) return Promise.resolve(hit); return new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error(`no frame within ${ms} ms; got ${JSON.stringify(frames)}`)), ms); waiters.push({ pred, resolve: (f) => { clearTimeout(t); resolve(f); } }); }); }, close: () => ac.abort(), status: () => status };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("the subscription filter is 02 §3's list: platform spellings, families, never command.* or timer.*", { skip }, () => {
  for (const t of ["application.received", "disclosure.le.delivered", "lock.executed", "payment.posted", "payment.reversed", "identity.verified", "human_transferred", "loan.funded", "refi.opportunity.offered", "card.sent"]) assert.equal(subscribed(t), true, t);
  for (const t of ["command.executed", "command.refused", "timer.armed", "timer.satisfied", "du.credit.associated", "entity.written", "rate_sheet.published"]) assert.equal(subscribed(t), false, t);
  assert.equal(HEARTBEAT_MS, 15_000); assert.equal(RING_SIZE, 500);
});

test("a tool executed on the bus reaches the party's open stream after the unit of work commits — {event_name, at, subject, payload_ref}, no payload; another party's subject never does; the ops token opens nothing", { skip }, async () => {
  const tokenA = await signIn(EMAIL_A);
  const anon = await fetch(base + "/v1/borrower/stream"); assert.equal(anon.status, 401); await anon.text();
  const opsToken = await fetch(base + "/v1/borrower/stream", { headers: { authorization: `Bearer ${TOKEN}` } }); assert.equal(opsToken.status, 401); await opsToken.text();
  const s = sse("/v1/borrower/stream", { authorization: `Bearer ${tokenA}` });
  await s.next((f) => f.comment === "connected");
  assert.equal(s.status(), 200); assert.equal(hub.connections(), 1);
  // 21.1's own tool on the bus: `application.received` (subscribed) plus `command.executed` (not) — one frame, for the application's party
  const r = await ops("POST", `/v1/applications/${appA}/tools/21.1/startInterview`, { actor: { kind: "agent", id: "intake" }, input: { session_id: `S-${R}`, partner_name: "Partner Bank", intake_channel: "web", creditor_time_zone: "America/Phoenix", property_state: "AZ", transaction_type: "limited_cash_out", occupancy: "primary", borrowers: [{ id: "B1", legal_name: "Fixture Borrower" }] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const r2 = await ops("POST", `/v1/applications/${appA}/tools/21.1/captureField`, { actor: { kind: "agent", id: "intake" }, input: { field: "credit_request", transaction_type: "limited_cash_out", occupancy: "primary", property_state: "AZ" } });
  assert.equal(r2.status, 200, JSON.stringify(r2.body)); assert.ok(r2.body["events"] && (r2.body["events"] as { type: string }[]).some((e) => e.type === "application.received"));
  const f = await s.next((x) => x.event === "application.received");
  assert.ok(f.id !== null && f.id > 0); assert.deepEqual(Object.keys(f.data!).sort(), ["at", "event_name", "payload_ref", "subject"]);
  assert.equal(f.data!["event_name"], "application.received"); assert.deepEqual(f.data!["subject"], { application_id: appA, loan_id: null }); assert.equal(f.data!["at"], clock.now());
  const ref = f.data!["payload_ref"] as Record<string, unknown>; assert.equal(ref["record"], `/v1/borrower/record?subject=${appA}`); assert.ok(typeof ref["event_id"] === "string" && typeof ref["sequence"] === "number");
  assert.ok(!s.frames.some((x) => x.event === "command.executed" || (x.event ?? "").startsWith("timer.")), "command.* and timer.* never reach the client");
  // the same tool on Blake's application: nothing on Alex's stream
  const before = s.frames.length;
  await ops("POST", `/v1/applications/${appB}/tools/21.1/startInterview`, { actor: { kind: "agent", id: "intake" }, input: { session_id: `S-${R}-b`, partner_name: "Partner Bank", intake_channel: "web", creditor_time_zone: "America/Phoenix", property_state: "AZ", transaction_type: "limited_cash_out", occupancy: "primary", borrowers: [{ id: "B1", legal_name: "Fixture Borrower" }] } });
  await ops("POST", `/v1/applications/${appB}/tools/21.1/captureField`, { actor: { kind: "agent", id: "intake" }, input: { field: "credit_request", transaction_type: "limited_cash_out", occupancy: "primary", property_state: "AZ" } });
  await wait(150);
  assert.equal(s.frames.filter((x) => x.event === "application.received").length, s.frames.slice(0, before).filter((x) => x.event === "application.received").length, "Blake's application never reaches Alex");
  // a borrower command through the API is a unit of work like any other: its events reach the stream too (a card sent by the intake agent → `card.sent`)
  const card = await runtime.execute({ process: "32.1", name: "send_card", loanId: "", applicationId: appA, actor: { kind: "agent", id: "intake" }, input: { party_id: (await db.query<{ party_id: string }>(`SELECT party_id FROM application_borrowers WHERE application_id = $1`, [appA]))[0]!.party_id, subject: { application_id: appA }, kind: "StatusCard", copy_key: "application.received" } });
  const cf = await s.next((x) => x.event === "card.sent"); assert.equal((cf.data!["subject"] as { application_id: string }).application_id, appA); assert.ok(card.output);
  s.close(); await wait(50);
  assert.equal(hub.connections(), 0, "a closed connection leaves the subscriber list");
});

test("reconnect with Last-Event-ID replays what the party missed from the ring, in order, and nothing before it; the token may ride on ?token= (EventSource cannot set headers)", { skip }, async () => {
  const tokenA = await signIn(EMAIL_A);
  const partyA = (await db.query<{ party_id: string }>(`SELECT party_id FROM application_borrowers WHERE application_id = $1`, [appA]))[0]!.party_id;
  const send = (copy_key: string) => runtime.execute({ process: "32.1", name: "send_card", loanId: "", applicationId: appA, actor: { kind: "agent", id: "intake" }, input: { party_id: partyA, subject: { application_id: appA }, kind: "StatusCard", copy_key } });
  const first = sse("/v1/borrower/stream", { authorization: `Bearer ${tokenA}` }); await first.next((f) => f.comment === "connected");
  await send("le.delivered");
  const seen = await first.next((f) => f.event === "card.sent");
  const lastId = seen.id!; assert.ok(lastId > 0);
  first.close(); await wait(50);
  // two more events while nobody is connected: a card and 22.6's identity.verified
  await send("lock.executed");
  await ops("POST", `/v1/applications/${appA}/tools/22.6/verifyIdentity`, { actor: { kind: "agent", id: "fraud-risk" }, input: { borrower_id: "B1", borrower_ids: ["B1"], scheduled_note_date: "2026-11-06" } });
  await wait(100);
  const ring = hub.ring(partyA);
  assert.ok(ring.some((e) => e.event_name === "identity.verified"), `identity.verified in the ring: ${JSON.stringify(ring.map((e) => e.event_name))}`);
  const second = sse(`/v1/borrower/stream?token=${encodeURIComponent(tokenA)}&last_event_id=${lastId}`, {});
  const replayed = await second.next((f) => f.event === "identity.verified");
  assert.ok(replayed.id !== null && replayed.id > lastId, "replayed frames carry ids after Last-Event-ID");
  const ids = second.frames.filter((f) => f.id !== null).map((f) => f.id!);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), "in order"); assert.ok(ids.every((id) => id > lastId), "nothing before the cursor is replayed"); assert.ok(ids.length >= 2, "both missed events replayed");
  assert.ok(!second.frames.some((f) => f.id === seen.id), "a frame the first connection received is not replayed");
  assert.ok(!second.frames.some((f) => f.comment === "connected"), "a replaying reconnect gets the frames, not the greeting");
  second.close(); await wait(50);
  // the header form of the cursor
  const third = sse("/v1/borrower/stream", { authorization: `Bearer ${tokenA}`, "last-event-id": String(lastId) });
  const again = await third.next((f) => f.event === "identity.verified"); assert.equal(again.id, replayed.id);
  third.close(); await wait(50);
  assert.equal(hub.connections(partyA), 0);
});

test("the heartbeat comment keeps an idle stream open (the interval is unref'd so it never pins the process); a cold party has no ring and an empty replay", { skip }, async () => {
  const tokenB = await signIn(EMAIL_B);
  const partyB = (await db.query<{ party_id: string }>(`SELECT party_id FROM application_borrowers WHERE application_id = $1`, [appB]))[0]!.party_id;
  const s = sse("/v1/borrower/stream", { authorization: `Bearer ${tokenB}`, "last-event-id": "999999" });
  await s.next((f) => f.id === null && f.event === null);   // the retry line: the connection is up
  await wait(50);
  assert.equal(s.status(), 200); assert.ok(!s.frames.some((f) => f.event !== null), "a cursor past the ring replays nothing");
  assert.equal(hub.connections(partyB), 1, `connections for ${partyB}: ${hub.connections()} in all`);
  assert.equal(hub.ring(partyB).length, 0, "Blake's application.received happened before Blake ever signed in (no party link yet): a cold party has no ring — and none of Alex's events is in it");
  // the hub's ping is what the interval calls; drive it directly so the test never waits 15 s
  (hub as unknown as { ping: () => void }).ping();
  const beat = await s.next((f) => (f.comment ?? "").startsWith("ping"));
  assert.match(beat.comment!, /^ping \d{4}-\d{2}-\d{2}T/);
  s.close(); await wait(50);
  assert.equal(hub.connections(partyB), 0);
});
