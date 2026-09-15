/**
 * The origination side of the hosted runtime, against Postgres: an application is opened over HTTP, its record is
 * keyed by application id (events, timers, decisions, entity rows) before any loan exists, and a tool executes in
 * application scope through the same command bus the servicing tools use. Skips without a database.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { connect, type Db } from "../infra/db/client.ts";
import { testDatabase } from "../infra/db/test-db.ts";
import { persistDuDocument } from "../domain/underwriting/du/persist.ts";
import { DU_PREFLIGHT_RULE_SET, persistDuPreflight } from "../domain/underwriting/du/preflight.ts";
import type { DuDocument } from "../domain/underwriting/du/emit.ts";
import { loadOverriddenRegistry } from "../domain/timer-overrides.ts";
import { FixedClock } from "../kernel/events/index.ts";
import { Runtime } from "./app.ts";
import { createApiServer, listen } from "./server.ts";
import { createLogger } from "./log.ts";

const { url: DB_URL, skip } = await testDatabase(import.meta.url);
const TOKEN = "t-" + randomUUID();

let db: Db; let runtime: Runtime; let base = ""; let close: () => Promise<void> = async () => undefined;
let partnerPartyId = "";
const clock = new FixedClock("2026-10-05T17:41:00.000Z");   // Mon Oct 5, 2026 10:41 MST — the 21.1 fixture interview

test.before(async () => {
  if (skip) return;
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

test("the ops record carries the DU hand-off's facts: `application.du_casefile_id` (null until DU's first ack; write-once thereafter) and a `du` block — the application's du_documents rows (id, casefile_id, submission_number, sha256 hex, required_missing, emitted_at) and the preflight results", { skip }, async () => {
  const opened = await call("POST", "/v1/applications", { actor: ACTOR, application: { partner_party_id: partnerPartyId, channel: "organic", transaction_type: "limited_cash_out", occupancy: "primary", borrowers: [{ legal_name: "Erin Fixture" }] } });
  const appId = (opened.body["application"] as { id: string }).id;
  const fresh = await call("GET", `/v1/applications/${appId}`);
  assert.equal(fresh.status, 200);
  assert.equal((fresh.body["application"] as Record<string, unknown>)["du_casefile_id"], null, "no casefile id before a submission has been answered");
  assert.deepEqual(fresh.body["du"], { documents: [], preflight: [] });
  // an emitted document (23.6 persist.ts, the same writer 23.1's buildDuRequest comes through) and DU's own identifier on the row (23.7 writes it from the ack — migration 0133)
  const bytes = new TextEncoder().encode(`<MESSAGE application="${appId}"/>`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const document: DuDocument = { bytes, sha256, stats: { container_count: 3, relationship_count: 1, borrower_count: 1, disputed_arcs_skipped: 0 }, labels: new Map(), gaps: [] };
  const casefile_id = `CF-${appId.slice(0, 8)}`;
  const persisted = await persistDuDocument(db, { application_id: appId, casefile_id, submission_number: 1, document, emitted_at: "2026-10-05T17:45:00.000Z" });
  // two preflight runs over it (23.7 persistDuPreflight, migration 0136): a refusal, then a pass — the record lists both, oldest first, each with its checks
  const refused = await persistDuPreflight(db, { application_id: appId, du_document_id: persisted.du_document_id, document_id: persisted.document_id, casefile_id, submission_number: 1, ran_at: "2026-10-05T17:45:01.000Z",
    result: { passed: false, rule_set_version: DU_PREFLIGHT_RULE_SET, checks: [{ code: "DU_PREFLIGHT_CREDENTIALS", passed: true }, { code: "DU_PREFLIGHT_DANGLING_ARC", passed: false, xpath: "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/RELATIONSHIPS/RELATIONSHIP[1]", detail: "an arc names a label that is not in the document" }], refusal: { code: "DU_PREFLIGHT_DANGLING_ARC", xpath: "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/RELATIONSHIPS/RELATIONSHIP[1]", rule: "23.7 rule 1", detail: "an arc names a label that is not in the document" } } });
  const passed = await persistDuPreflight(db, { application_id: appId, du_document_id: persisted.du_document_id, document_id: persisted.document_id, casefile_id, submission_number: 1, ran_at: "2026-10-05T17:46:00.000Z",
    result: { passed: true, rule_set_version: DU_PREFLIGHT_RULE_SET, checks: [{ code: "DU_PREFLIGHT_CREDENTIALS", passed: true }, { code: "DU_PREFLIGHT_DANGLING_ARC", passed: true }], refusal: null } });
  await db.query(`UPDATE applications SET du_casefile_id = $2 WHERE id = $1`, [appId, "1234567890"]);
  const rec = await call("GET", `/v1/applications/${appId}`);
  assert.equal(rec.status, 200);
  assert.equal((rec.body["application"] as Record<string, unknown>)["du_casefile_id"], "1234567890");
  const du = rec.body["du"] as { documents: Record<string, unknown>[]; preflight: unknown[] };
  assert.equal(du.documents.length, 1);
  const d = du.documents[0]!;
  assert.equal(d["id"], persisted.du_document_id); assert.equal(d["casefile_id"], casefile_id); assert.equal(d["submission_number"], 1); assert.equal(d["submission_id"], null);
  assert.equal(d["sha256"], sha256); assert.equal(d["required_missing"], 0); assert.equal(d["container_count"], 3); assert.equal(d["borrower_count"], 1);
  assert.match(String(d["emitted_at"]), /^2026-10-05/); assert.equal(d["xml"], undefined, "never the bytes on the record");
  // the du_preflight_results rows, oldest first, each with its checks — the refusal is a row too (23.7: every run is recorded), never the bytes
  const pf = du.preflight as Record<string, unknown>[];
  assert.deepEqual(pf.map((p) => [p["id"], p["passed"], p["du_document_id"], p["submission_number"], p["casefile_id"]]), [[refused.id, false, persisted.du_document_id, 1, casefile_id], [passed.id, true, persisted.du_document_id, 1, casefile_id]]);
  assert.deepEqual((pf[0]!["checks"] as Record<string, unknown>[]).map((c) => [c["code"], c["passed"]]), [["DU_PREFLIGHT_CREDENTIALS", true], ["DU_PREFLIGHT_DANGLING_ARC", false]]);
  assert.equal((pf[0]!["checks"] as Record<string, unknown>[])[1]!["xpath"], "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/RELATIONSHIPS/RELATIONSHIP[1]"); assert.match(String(pf[0]!["ran_at"]), /^2026-10-05/); assert.match(String(pf[1]!["ran_at"]), /^2026-10-05/);
  assert.ok(pf[0]!["ran_at"]! < pf[1]!["ran_at"]!, "oldest first");
  // write-once: a different casefile id on the same application is refused by the row itself (0133's trigger)
  await assert.rejects(db.query(`UPDATE applications SET du_casefile_id = $2 WHERE id = $1`, [appId, "0987654321"]), /DU_CASEFILE_ID_WRITE_ONCE/);
});
