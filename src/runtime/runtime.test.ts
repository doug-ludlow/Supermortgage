/**
 * The hosted runtime end to end against Postgres: a tool executed over HTTP
 * commits its entity versions, events and decision; the same rows hydrate the
 * next request; refusals and auth answer the documented statuses; the sweep
 * breaches a due timer. Skips cleanly when no database answers (like db.test).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { connect, reachable, type Db } from "../infra/db/client.ts";
import { PgLoanRepository } from "../infra/db/loans.ts";
import type { PlainDate } from "../kernel/calendar/date.ts";
import { loadOverriddenRegistry } from "../domain/timer-overrides.ts";
import { FixedClock } from "../kernel/events/index.ts";
import { Runtime } from "./app.ts";
import { createApiServer, listen } from "./server.ts";
import { createLogger } from "./log.ts";
import { encodeEntityData, decodeEntityData } from "../infra/db/entities.ts";

const DB_URL = process.env["TEST_DATABASE_URL"] ?? "postgresql://sm:sm@localhost/supermortgage_test";
const up = await reachable(DB_URL);
if (!up && process.env["REQUIRE_DB"]) throw new Error(`REQUIRE_DB set but ${DB_URL} is not reachable`);
const skip = up ? false : `no Postgres at ${DB_URL}`;
const TOKEN = "test-token-" + randomUUID();

let db: Db; let base = ""; let runtime: Runtime; const lines: string[] = []; let close: () => Promise<void> = async () => undefined;
const clock = new FixedClock("2026-09-15T14:00:00.000Z");
const OFFICER = { kind: "human", id: "u-officer", role: "officer" };
let n = 0;
const uniq = () => `${Date.now() % 1_000_000}${(n++).toString().padStart(3, "0")}`.padStart(10, "0");
const D = (s: string): PlainDate => s as PlainDate;
/** A boarded loan row: the runtime keys every table by the loan's uuid. */
const newLoan = async (): Promise<string> => (await new PgLoanRepository(db).createFixture({ fnmaLoanNumber: uniq(), servicerLoanNumber: `SM-${randomUUID()}`, instrumentDate: D("2021-07-15"), originalUpbCents: 26_000_000n, originalTermMonths: 360, firstPaymentDate: D("2021-09-01"), maturityDate: D("2051-08-01") })).loanId;

test.before(async () => {
  if (skip) return;
  execFileSync(fileURLToPath(new URL("../../db/migrate.sh", import.meta.url)), { env: { ...process.env, DATABASE_URL: DB_URL }, stdio: "pipe" });
  db = connect(DB_URL);
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger: createLogger("json", (l) => lines.push(l)) });
  const port = await listen(server, 0, "127.0.0.1");
  base = `http://127.0.0.1:${port}`;
  close = () => new Promise((resolve) => server.close(() => db.end().then(() => resolve())));
});
test.after(async () => { await close(); });

const call = (method: string, path: string, body?: unknown, token: string | null = TOKEN): Promise<Response> =>
  fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

test("entity data round-trips bigint cents through JSON", () => {
  const data = { amount_cents: 12_345n, nested: { list: [1n, "x", { deep: -7n }] }, plain: "s", n: 2 };
  assert.deepEqual(decodeEntityData(encodeEntityData(data)), data);
});

test("probes answer without auth; everything else needs the bearer token", { skip }, async () => {
  assert.equal((await call("GET", "/healthz", undefined, null)).status, 200);
  const ready = await call("GET", "/readyz", undefined, null); assert.equal(ready.status, 200); assert.deepEqual(await ready.json(), { ok: true, database: "reachable" });
  assert.equal((await call("GET", "/v1/tools", undefined, null)).status, 401);
  assert.equal((await call("GET", "/v1/tools", undefined, "wrong")).status, 401);
  // /login is reachable without the header: it is how a browser presents the token; a wrong token is refused, the right one sets the cookie
  assert.equal((await fetch(`${base}/login?token=wrong`, { redirect: "manual" })).status, 401);
  const login = await fetch(`${base}/login?token=${encodeURIComponent(TOKEN)}`, { redirect: "manual" });
  assert.equal(login.status, 302); assert.match(login.headers.get("set-cookie") ?? "", /^sm_token=/);
  const viaCookie = await fetch(`${base}/v1/tools`, { headers: { cookie: `sm_token=${encodeURIComponent(TOKEN)}` } });
  assert.equal(viaCookie.status, 200);
  const tools = (await (await call("GET", "/v1/tools")).json()) as { tools: { process: string; name: string }[] };
  assert.ok(tools.tools.length > 600, `${tools.tools.length} tools on the bus`);
  assert.ok(tools.tools.some((t) => t.process === "1.1" && t.name === "mapField"));
});

test("a tool executed over HTTP commits its entity version, events and decision, and the rows hydrate the next request", { skip }, async () => {
  const loanId = await newLoan();
  const r1 = await call("POST", `/v1/loans/${loanId}/tools/1.1/mapField`, { actor: OFFICER, input: { id: `fm-${loanId}`, data: { loan_id: loanId, source_field: "UPB", target: "upb_cents", amount_cents: "1000" }, rationale: "runtime test" } });
  const t1 = await r1.text(); assert.equal(r1.status, 200, `${t1}\n${lines.join("\n")}`);
  const out1 = JSON.parse(t1) as { output: Record<string, unknown>; event: { type: string }; events: { type: string }[]; decisions: { id: string }[] };
  assert.equal(out1.output["source_field"], "UPB"); assert.equal(out1.event.type, "command.executed");
  assert.deepEqual(out1.events.map((e) => e.type), ["boarding.field_mapped", "command.executed"]); assert.equal(out1.decisions.length, 1);
  // persisted: the entity row, the events under the loan
  const rows = await db.query<{ version: number; loan_id: string; data: Record<string, unknown> }>(`SELECT version, loan_id, data FROM entity_records WHERE kind = 'tape_field_map' AND id = $1 ORDER BY version`, [`fm-${loanId}`]);
  assert.equal(rows.length, 1); assert.equal(rows[0]!.loan_id, loanId); assert.equal(rows[0]!.data["target"], "upb_cents");
  const events = (await (await call("GET", `/v1/loans/${loanId}/events`)).json()) as { events: { type: string }[] };
  assert.deepEqual(events.events.map((e) => e.type), ["boarding.field_mapped", "command.executed"]);
  // the next command sees version 1 and writes version 2
  const r2 = await call("POST", `/v1/loans/${loanId}/tools/1.1/mapField`, { actor: OFFICER, input: { id: `fm-${loanId}`, data: { loan_id: loanId, target: "upb_cents_v2" }, rationale: "runtime test" } });
  assert.equal(r2.status, 200, await r2.text());
  const cur = await runtime.entities.current("tape_field_map", `fm-${loanId}`);
  assert.equal(cur?.version, 2); assert.equal(cur?.data["source_field"], "UPB"); assert.equal(cur?.data["target"], "upb_cents_v2");
});

test("the bus's answers map to HTTP: unknown tool 404, bad actor 400, agent not allowlisted 409 with the guardrail code", { skip }, async () => {
  const loanId = await newLoan();
  assert.equal((await call("POST", `/v1/loans/${loanId}/tools/1.1/noSuchTool`, { actor: OFFICER, input: {} })).status, 404);
  assert.equal((await call("POST", `/v1/loans/${loanId}/tools/1.1/mapField`, { actor: { kind: "robot", id: "r" }, input: {} })).status, 400);
  assert.equal((await call("POST", "/v1/loans/L-x/tools/1.1/mapField", { actor: OFFICER, input: {} })).status, 400, "a loan id must be the loan's uuid");
  const refused = await call("POST", `/v1/loans/${loanId}/tools/1.1/mapField`, { actor: { kind: "agent", id: "payoff-release" }, input: { id: "fm-1", data: {} } });
  assert.equal(refused.status, 409);
  const body = (await refused.json()) as { error: string; code: string };
  assert.equal(body.error, "refused"); assert.equal(body.code, "NOT_ALLOWLISTED");
});

test("the sweep breaches a due timer, records the escalation and reports the outbox backlog", { skip }, async () => {
  const loanId = await newLoan();
  // arm a timer directly through the unit of work: the first 1.1 boarding row whose trigger event (built from its pattern's equality conditions) yields a due instant
  const candidates = runtime.registry.all().filter((d) => d.process === "1.1" && d.triggerPattern && d.offsetParsed.kind === "step");
  let armed: string | undefined;
  await runtime.uow.run(loanId, (ctx) => {
    for (const def of candidates) {
      const payload: Record<string, unknown> = {};
      for (const c of def.triggerPattern!.conditions) { if (c.op === "=" && typeof c.value === "string") payload[c.field] = c.value; else if (c.op === "truthy") payload[c.field] = true; }
      const e = ctx.events.append({ type: def.triggerPattern!.type, loanId, actor: { kind: "system", id: "test" }, payload });
      const inst = ctx.timers.arm(def, e);
      if (inst.status === "armed" && inst.dueAt !== undefined) { armed = def.code; break; }
      ctx.timers.cancel(inst.id, "test: no due instant");
    }
  }, { clock });
  assert.ok(armed, "a 1.1 step timer armed with a due instant");
  // the trigger event also arms every other registry row it matches; the sweep breaches them all
  const sweepAt = "2036-01-01T00:00:00.000Z";
  const open = (await runtime.uow.timers.open(loanId)).filter((t) => t.status === "armed" && t.dueAt !== undefined && t.dueAt <= Date.parse(sweepAt));
  assert.ok(open.some((t) => t.code === armed), `${armed} is armed (${open.length} armed and due on the loan)`);
  const report = await runtime.sweep(sweepAt);
  const mine = report.breaches.filter((b) => b.loan_id === loanId);
  assert.ok(mine.some((b) => b.code === armed)); assert.equal(mine.length, open.length);
  assert.equal((await runtime.uow.timers.open(loanId)).find((t) => t.code === armed)!.status, "breached");
  const esc = await db.query<{ kind: string; loan_id: string }>(`SELECT kind, loan_id FROM escalations WHERE loan_id = $1`, [loanId]);
  assert.equal(esc.length, mine.length); for (const e of esc) assert.match(e.kind, /^sev[1-4]$/);
  const viaHttp = await call("POST", "/v1/sweep"); assert.equal(viaHttp.status, 200);
  assert.ok(Array.isArray(((await viaHttp.json()) as { outbox: unknown[] }).outbox));
});
