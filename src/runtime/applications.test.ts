/**
 * The origination side of the hosted runtime, against Postgres: an application is opened over HTTP, its record is
 * keyed by application id (events, timers, decisions, entity rows) before any loan exists, and a tool executes in
 * application scope through the same command bus the servicing tools use. Skips without a database.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { connect, reachable, type Db } from "../infra/db/client.ts";
import { loadOverriddenRegistry } from "../domain/timer-overrides.ts";
import { FixedClock } from "../kernel/events/index.ts";
import { Runtime } from "./app.ts";
import { createApiServer, listen } from "./server.ts";
import { createLogger } from "./log.ts";

const DB_URL = process.env["TEST_DATABASE_URL"] ?? "postgresql://sm:sm@localhost/supermortgage_test";
const up = await reachable(DB_URL);
if (!up && process.env["REQUIRE_DB"]) throw new Error(`REQUIRE_DB set but ${DB_URL} is not reachable`);
const skip = up ? false : `no Postgres at ${DB_URL}`;
const TOKEN = "t-" + randomUUID();

let db: Db; let runtime: Runtime; let base = ""; let close: () => Promise<void> = async () => undefined;
let partnerPartyId = "";
const clock = new FixedClock("2026-10-05T17:41:00.000Z");   // Mon Oct 5, 2026 10:41 MST — the 21.1 fixture interview

test.before(async () => {
  if (skip) return;
  execFileSync(fileURLToPath(new URL("../../db/migrate.sh", import.meta.url)), { env: { ...process.env, DATABASE_URL: DB_URL }, stdio: "pipe" });
  db = connect(DB_URL);
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger: createLogger("json", () => undefined) });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => server.close(() => db.end().then(() => resolve())));
  const partner = await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number) VALUES ('servicer', $1, $2) RETURNING id`, [`Lender of Record ${randomUUID().slice(0, 8)}`, "123456789"]);
  partnerPartyId = partner[0]!.id;
});
test.after(async () => { if (!skip) await close(); });

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}
const ACTOR = { kind: "agent", id: "intake" };

test("an application opens over HTTP: the row, its borrowers and property, and `application.started` keyed by the application id", { skip }, async () => {
  const r = await call("POST", "/v1/applications", { actor: ACTOR, application: {
    partner_party_id: partnerPartyId, channel: "refi_trigger", transaction_type: "limited_cash_out", occupancy: "primary", intake_channel: "voice", interview_language: "en-US",
    borrowers: [{ legal_name: "Avery Fixture", borrower_role: "borrower", citizenship_status: "us_citizen", language_preference: "en" }, { legal_name: "Blake Fixture", borrower_role: "co_borrower" }],
    property: { address_line1: "4821 E Camelback Rd", city: "Phoenix", state: "AZ", postal_code: "85018", county: "Maricopa", property_type: "sfr", units: 1 } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const app = r.body["application"] as Record<string, unknown>;
  assert.equal(app["status"], "started"); assert.equal(app["ai_intake_mode"], "assisted"); assert.equal(app["loan_id"], null);
  assert.equal((app["borrowers"] as unknown[]).length, 2); assert.equal((app["properties"] as { state: string }[])[0]!.state, "AZ");
  const ev = r.body["event"] as Record<string, unknown>;
  assert.equal(ev["type"], "application.started"); assert.equal(ev["applicationId"], app["id"]); assert.equal(ev["loanId"], undefined);
  // the record reads back keyed by the application id, with no loan anywhere
  const rec = await call("GET", `/v1/applications/${app["id"]}`);
  assert.equal(rec.status, 200);
  const events = rec.body["events"] as { type: string; applicationId?: string; loanId?: string; payload: { code?: string } }[];
  assert.equal(events[0]!.type, "application.started");
  // origination timers that trigger on `application.started` arm in application scope (the engine's origination-context rule) — none on a loan
  const armed = events.filter((e) => e.type === "timer.armed");
  assert.ok(armed.length >= 1, "origination timers armed on application.started");
  for (const e of events) { assert.equal(e.applicationId, app["id"], `${e.type} keyed by the application`); assert.equal(e.loanId, undefined, `${e.type} has no loan`); }
  const timers = rec.body["timers"] as { code: string; applicationId?: string; subject: { kind: string; id: string }; status: string }[];
  assert.equal(timers.length, armed.length);
  // a row whose offset the grammar cannot parse yet arms as `needs_human` until its section's timers.ts overrides it
  for (const t of timers) { assert.equal(t.applicationId, app["id"]); assert.deepEqual(t.subject, { kind: "application", id: app["id"] }); assert.ok(t.status === "armed" || t.status === "needs_human", t.status); }
  const rows = await db.query<{ application_id: string | null; loan_id: string | null }>(`SELECT application_id, loan_id FROM loan_events WHERE application_id = $1`, [app["id"] as string]);
  assert.equal(rows.length, events.length); assert.ok(rows.every((r) => r.loan_id === null));
  const trows = await db.query<{ application_id: string | null; loan_id: string | null }>(`SELECT application_id, loan_id FROM timers WHERE application_id = $1`, [app["id"] as string]);
  assert.equal(trows.length, timers.length);
  // validation: a body without borrowers is a 400, not a row
  const bad = await call("POST", "/v1/applications", { actor: ACTOR, application: { partner_party_id: partnerPartyId, channel: "organic", transaction_type: "purchase", occupancy: "primary", borrowers: [] } });
  assert.equal(bad.status, 400);
  const list = await call("GET", "/v1/applications");
  assert.ok((list.body["applications"] as { id: string }[]).some((a) => a.id === app["id"]));
});

test("a tool executes in application scope: the command, its events and its decision record are keyed by the application, and the entity rows it writes come back on the next command", { skip }, async () => {
  const opened = await call("POST", "/v1/applications", { actor: ACTOR, application: { partner_party_id: partnerPartyId, channel: "organic", transaction_type: "purchase", occupancy: "primary", borrowers: [{ legal_name: "Casey Fixture" }] } });
  const appId = (opened.body["application"] as { id: string }).id;
  // 1.1's writeDecision is a generic decision-record tool: any process may record a decision through the bus
  const r = await call("POST", `/v1/applications/${appId}/tools/1.1/writeDecision`, { actor: { kind: "agent", id: "boarding" },
    input: { agent: "boarding", action: "application.intake.reviewed", rationale: "six items not yet received; interview continues", rule_set_version: "regz.trid.2017" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(typeof r.body["decisionId"] === "string" || r.body["decisions"] !== undefined);
  const events = r.body["events"] as { type: string; applicationId?: string; loanId?: string }[];
  assert.ok(events.some((e) => e.type === "command.executed"));
  for (const e of events) { assert.equal(e.applicationId, appId, `${e.type} keyed by application`); assert.ok(!e.loanId, `${e.type} has no loan yet`); }
  const decisions = await db.query<{ application_id: string | null; loan_id: string | null }>(`SELECT application_id, loan_id FROM agent_decisions WHERE application_id = $1`, [appId]);
  assert.ok(decisions.length >= 1); assert.equal(decisions[0]!.loan_id, null);
  // a loan-only route refuses a non-loan id, an unknown application is a 404
  assert.equal((await call("POST", `/v1/applications/${randomUUID()}/tools/1.1/writeDecision`, { actor: ACTOR, input: {} })).status, 404);
  assert.equal((await call("POST", `/v1/applications/not-a-uuid/tools/1.1/writeDecision`, { actor: ACTOR, input: {} })).status, 400);
  const rec = await call("GET", `/v1/applications/${appId}`);
  assert.ok((rec.body["decisions"] as { action: string }[]).some((d) => d.action === "application.intake.reviewed"), JSON.stringify(rec.body["decisions"]));
});

test("the LE bridge (POST /v1/applications/{id}/disclosures/le) is the MLO of record's act over an application with its six items: an agent actor is refused (400), an unknown application is 404, an application without `application.trid_received` is refused (400) — and nothing is written", { skip }, async () => {
  const opened = await call("POST", "/v1/applications", { actor: ACTOR, application: { partner_party_id: partnerPartyId, channel: "organic", transaction_type: "limited_cash_out", occupancy: "primary", borrowers: [{ legal_name: "Dana Fixture" }] } });
  const appId = (opened.body["application"] as { id: string }).id;
  const render = { application_id: appId, disclosure_id: `LE-${appId.slice(0, 8)}`, as_of: "2026-10-05", loan_cents: "56000000", term_months: 360, transaction_type: "limited_cash_out", product: "Fixed Rate", pricing: { quote_id: "Q-1", rate_pct: "6.125", price: "100.000", points_cents: "0", lender_credit_cents: "0", locked: false }, fees: [], applicants: ["Dana Fixture"], property_address: "1 Palm Ln, Phoenix AZ 85001", estimated_value_cents: "80000000", creditor: { name: "Partner Bank, N.A.", nmlsr_id: "123456", email: "loans@partnerbank.example", phone: "(800) 555-0155" }, loan_officer: { name: "Jordan Rivera", nmlsr_id: "987654" } };
  const body = { render, mlo: { review_id: "MR-1", nmlsr_id: "987654" }, delivery: { channel: "esign_portal", consent: { id: "CNS-1", scope: ["disclosures"], granted_at: "2026-10-05T17:20:00.000Z" } } };
  const agent = await call("POST", `/v1/applications/${appId}/disclosures/le`, { actor: ACTOR, ...body });
  assert.equal(agent.status, 400); assert.match(String(agent.body["reason"]), /mlo_of_record/);
  const mlo = { kind: "human", id: "u-mlo", role: "mlo_of_record" };
  assert.equal((await call("POST", `/v1/applications/${randomUUID()}/disclosures/le`, { actor: mlo, ...body })).status, 404);
  const early = await call("POST", `/v1/applications/${appId}/disclosures/le`, { actor: mlo, ...body });
  assert.equal(early.status, 400); assert.match(String(early.body["reason"]), /trid_received/);
  const events = await db.query<{ type: string }>(`SELECT type FROM loan_events WHERE application_id = $1`, [appId]);
  assert.ok(events.every((e) => !e.type.startsWith("disclosure.")), "nothing was delivered");
});
