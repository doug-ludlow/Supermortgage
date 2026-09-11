// 32.10 Servicing: hardship and delinquency
// spec/sections/32-borrower-experience/32-10-servicing-hardship-and-delinquency.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// Every T-id drives the real runtime over HTTP: the journey fixture's serviced prior loan adopted by the signed-in
// party (Journey.adoptPriorLoan), the 32.10 flow's daily tick (the 11.1 counter job through src/runtime/delinquency.ts,
// the 12.2 deemed-rejection sweep), the owning processes' own bus tools (11.2 notices, 11.3 contacts / QRPC / cease,
// 12.1 intake, 12.2 evaluation and notices, 12.4 forbearance, 13.x referral, 14.x bankruptcy) through the real Timer
// Engine and Notice Registry, and the borrower API (messages, cards, record, thread). What the borrower SEES — the Loan
// section rows, the offer's deadline line, the trial PaymentCard — is asserted on the real components in
// apps/borrower/tests/cards/flow-10-hardship.test.tsx. Skips without a database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { connect, reachable, type Db } from "../../infra/db/client.ts";
import { acquireJourneyLock, type TestLock } from "../../infra/db/test-lock.ts";
import { decodeEntityData } from "../../infra/db/entities.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock } from "../../kernel/events/index.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { Runtime } from "../../runtime/app.ts";
import { createApiServer, listen } from "../../runtime/server.ts";
import { createLogger } from "../../runtime/log.ts";
import { createBorrowerRouter, type BorrowerRouter } from "../../runtime/borrower/routes.ts";
import { Journey, MST } from "../../runtime/borrower/fixtures/journey.ts";
import { classifyHardship, NOTICE_CODES_32_10 } from "../../runtime/borrower/flows/10-hardship.ts";
import { hardshipSection } from "../../runtime/borrower/flows/10-hardship-record.ts";

const DB_URL = process.env["TEST_DATABASE_URL"] ?? "postgresql://sm:sm@localhost/supermortgage_test";
const up = await reachable(DB_URL);
if (!up && process.env["REQUIRE_DB"]) throw new Error(`REQUIRE_DB set but ${DB_URL} is not reachable`);
const skip = up ? false : `no Postgres at ${DB_URL}`;
const TOKEN = "ops-" + randomUUID();
const clock = new FixedClock("2026-09-01T16:00:00.000Z");
const COLLECTIONS = { kind: "agent" as const, id: "default-collections" }; const COMMS = { kind: "agent" as const, id: "borrower-comms" }; const LOSSMIT = { kind: "agent" as const, id: "lossmit-underwriter" }; const FC = { kind: "agent" as const, id: "foreclosure-ops" }; const BK = { kind: "agent" as const, id: "bankruptcy-ops" };
const REVIEWER = { kind: "human" as const, id: "u-lossmit-reviewer", role: "lossmit_reviewer" };
const PROPERTY = "100 N Central Ave, Phoenix, AZ 85004";
const FAKE_TEAM = { team_name: "Team 7", direct_number: "(800) 555-0177", named_human_first_name: "Sam" };   // FAKE fixture values (555-01xx)

let journeyLock: TestLock | undefined;
let db: Db; let runtime: Runtime; let router: BorrowerRouter; let base = ""; let close: () => Promise<void> = async () => undefined; let partnerPartyId = "";

test.before(async () => {
  if (skip) return;
  journeyLock = await acquireJourneyLock(DB_URL);
  execFileSync(fileURLToPath(new URL("../../../db/migrate.sh", import.meta.url)), { env: { ...process.env, DATABASE_URL: DB_URL }, stdio: "pipe" });
  db = connect(DB_URL);
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock });
  const logger = createLogger("json", (line) => { if (process.env["FLOW_DEBUG"] === "2" || (process.env["FLOW_DEBUG"] && /flow|ERROR|unhandled|internal/i.test(line))) process.stderr.write(line + "\n"); });
  router = createBorrowerRouter({ runtime, logger, environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost"], urlSecret: "test-secret" });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger, console: false, borrowerRouter: router });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => server.close(() => db.end().then(() => resolve())));
  const partner = await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id) VALUES ('servicer', $1, '123456789', '1000123') RETURNING id`, [`Partner Bank ${randomUUID().slice(0, 8)}`]);
  partnerPartyId = partner[0]!.id;
});
test.after(async () => { if (!skip) { await close(); await journeyLock?.release(); } });

// ---------------------------------------------------------------- helpers over the borrower API and the flows
type Reply = { status: number; body: Record<string, unknown> };
type P = Record<string, unknown>;
async function api(method: string, path: string, body?: unknown, token?: string): Promise<Reply> {
  const r = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text(); return { status: r.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}
async function signIn(email: string): Promise<{ token: string; party_id: string }> {
  const req = await api("POST", "/v1/borrower/auth/otp", { action: "request", channel: "email", destination: email });
  const ver = await api("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: req.body["challenge_id"], code: req.body["fake_code"] });
  assert.equal(ver.status, 200, JSON.stringify(ver.body));
  return { token: ver.body["token"] as string, party_id: (ver.body["party"] as { party_id: string }).party_id };
}
const settle = () => router.flows!.settle();
const tick = async (now: string) => { clock.set(now); await router.flows!.tick(now); await runtime.sweep(now); await settle(); };
const record = async (email: string, subject: string): Promise<P> => { await settle(); const r = await api("GET", `/v1/borrower/record?subject=${subject}`, undefined, (await signIn(email)).token); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 600)); return r.body; };
const thread = async (email: string): Promise<P[]> => { await settle(); const r = await api("GET", "/v1/borrower/thread?limit=500", undefined, (await signIn(email)).token); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300)); return r.body["messages"] as P[]; };
interface CardRow { card_instance_id: string; party_id: string; kind: string; status: string; copy_key: string; props: P; evidence: P | null; command_ref: string | null; expires_at: string | null; created_at: string; resolved_at: string | null }
const cardsOf = async (loanId: string): Promise<CardRow[]> => { await settle(); return db.query<CardRow & Record<string, unknown>>(`SELECT card_instance_id, party_id, kind, status, copy_key, props, evidence, command_ref, expires_at, created_at, resolved_at FROM card_instances WHERE subject_loan_id = $1 ORDER BY created_at, card_instance_id`, [loanId]); };
const events = (loanId: string, type?: string) => db.query<{ type: string; occurred_at: string; payload: P }>(`SELECT type, occurred_at, payload FROM loan_events WHERE loan_id = $1 AND ($2::text IS NULL OR type = $2) ORDER BY sequence`, [loanId, type ?? null]);
const timer = async (loanId: string, code: string) => (await db.query<{ status: string; due_at: string | null; due_date: string | null }>(`SELECT status::text AS status, due_at, due_date::text AS due_date FROM timers WHERE loan_id = $1 AND code = $2 ORDER BY armed_at DESC LIMIT 1`, [loanId, code]))[0];
const entitiesOf = async (kind: string, loanId: string): Promise<(P & { id: string })[]> => { const rows = await db.query<{ id: string; data: unknown }>(`SELECT id, data FROM entity_current WHERE kind = $1 AND data->>'loan_id' = $2 ORDER BY updated_at, id`, [kind, loanId]); return rows.map((r) => ({ id: r.id, ...(decodeEntityData(r.data) as P) })); };
const sample = (code: string, on: string): P => ({ ...(runtime.noticeRegistry.activeVersion(code, D(on))?.samplePayload ?? {}) });
type ToolReply = { output: unknown; events: { type: string; payload: P }[] };
/** A loan-scoped bus tool over HTTP (the tool name URL-encoded: 12.1's `lossmit.application.open/update` carries a slash). */
async function tool(j: Journey, loanId: string, process: string, name: string, input: P, actor: { kind: "agent" | "human"; id: string; role?: string }): Promise<ToolReply> {
  const r = await j.call("POST", `/v1/loans/${loanId}/tools/${encodeURIComponent(process)}/${encodeURIComponent(name)}`, { actor, input });
  assert.equal(r.status, 200, `${process} ${name}: ${JSON.stringify(r.body).slice(0, 900)}`);
  return r.body as unknown as ToolReply;
}
const refused = async (j: Journey, loanId: string, process: string, name: string, input: P, actor: { kind: "agent" | "human"; id: string; role?: string }): Promise<Reply> => j.call("POST", `/v1/loans/${loanId}/tools/${encodeURIComponent(process)}/${encodeURIComponent(name)}`, { actor, input });
const noticeText = (noticeId: unknown): string => (typeof noticeId === "string" ? runtime.noticeMemory.get(noticeId)?.rendered.text ?? "" : "");
const byLoan = async (loanId: string) => { const [evs, ents] = await Promise.all([events(loanId), db.query<{ kind: string; id: string; data: unknown; updated_at: string }>(`SELECT kind, id, data, updated_at FROM entity_current WHERE data->>'loan_id' = $1`, [loanId])]); return hardshipSection(evs.map((e) => ({ type: e.type, payload: e.payload, occurred_at: e.occurred_at })), (k) => ents.filter((e) => e.kind === k).map((e) => ({ kind: e.kind, id: e.id, data: decodeEntityData(e.data) as P, updated_at: e.updated_at }))); };

/** One serviced loan on the shared runtime: the journey's prior loan ($565,000 / 7.000% / 360; Phoenix, AZ) adopted by a freshly signed-in party, with the unpaid installments the T-id needs. */
async function servicedLoan(o: { at: string; first_unpaid_due?: string; unpaid_months?: number; fdcpa_debt_collector?: boolean; regx_days_delinquent_at_boarding?: number }): Promise<{ j: Journey; email: string; partyId: string; loanId: string; last4: string; recipients: P[] }> {
  const R = randomUUID().slice(0, 8); const email = `alex-${R}@example.test`;
  clock.set(o.at);
  const j = new Journey({ runtime, db, base, token: TOKEN, clock, borrowerEmail: email, coBorrowerEmail: `blake-${R}@example.test`, partnerPartyId });
  await j.seedBook();
  const partyId = (await signIn(email)).party_id;
  const loanId = await j.adoptPriorLoan(partyId, { ...(o.first_unpaid_due ? { first_unpaid_due: o.first_unpaid_due } : {}), ...(o.unpaid_months !== undefined ? { unpaid_months: o.unpaid_months } : {}), ...(o.fdcpa_debt_collector !== undefined ? { fdcpa_debt_collector: o.fdcpa_debt_collector } : {}), ...(o.regx_days_delinquent_at_boarding !== undefined ? { regx_days_delinquent_at_boarding: o.regx_days_delinquent_at_boarding } : {}) });
  const last4 = (await db.query<{ n: string }>(`SELECT servicer_loan_number AS n FROM loans WHERE id = $1`, [loanId]))[0]!.n.slice(-4);
  await settle();
  return { j, email, partyId, loanId, last4, recipients: [{ partyId, name: "Alex Borrower", mailingAddress: PROPERTY, email, portalUser: true }] };
}
/** 12.1: a complete first-lien application received `on` (evaluative information; complete the same day) — the lossmit_applications row the 12.2 evaluation names. */
async function completeApplication(j: Journey, loanId: string, on: string, extra: P = {}): Promise<string> {
  clock.set(MST(on, "09:00"));
  // receipt (an application inside 45 days of a scheduled sale takes 12.1's expedited path — `lossmit.application.received_within_45_days`), then the completeness determination the same day
  const opened = await tool(j, loanId, "12.1", "lossmit.application.open/update", { loan_id: loanId, received_on: on, has_evaluative_info: true, confidence: 1, state: "AZ", status: "incomplete", income: { monthly_cents: "620000" }, expenses: { monthly_cents: "410000" }, ...extra }, LOSSMIT);
  const appId = String((opened.output as P)["application_id"] ?? (opened.output as P)["id"] ?? `lma-${loanId}-${on}`);
  const r = await tool(j, loanId, "12.1", "lossmit.application.open/update", { op: "update", id: appId, loan_id: loanId, received_on: on, state: "AZ", status: "complete", complete_on: on, ...extra }, LOSSMIT);
  assert.ok(r.events.some((e) => e.type === "lossmit.application.completed"), r.events.map((e) => e.type).join(","));
  return appId;
}
/** 13.3 through 13.6's fc.* ops: the loan eligible for referral today (every gate open) and the package sent to the FAKE firm on `day`. */
async function referLoan(j: Journey, loanId: string, caseId: string, today: string, day: number): Promise<void> {
  const gates = { regx_120: true, regx_prefiling: true, no_first_filing_41k2: true, fnma_121: true, bk_stay: false, scra: false, dmdc_age_days: 3, disaster_approval: true, litigation_hold: false, environmental_hold: false, mn_dual_track: false, title_hold: false, package_ready: true };
  const e = await tool(j, loanId, "13.6", "attorney.message.send", { op: "fc.referral_eligible", loan_id: loanId, case_id: caseId, review_outcome: "refer", gates, today, principal_residence: true }, FC);
  assert.ok(e.events.some((x) => x.type === "foreclosure.referral.eligible"), e.events.map((x) => x.type).join(","));
  const s = await tool(j, loanId, "13.6", "attorney.message.send", { op: "fc.send_referral", loan_id: loanId, case_id: caseId, firm_id: "FAKE-FIRM-1", referral_on: today, day, principal_residence: true, review_outcome: "refer", documents: [{ id: "doc-note-copy", sha256: "a".repeat(64) }, { id: "doc-payment-history", sha256: "b".repeat(64) }] }, FC);
  assert.ok(s.events.some((x) => x.type === "foreclosure.referral.sent"), s.events.map((x) => x.type).join(","));
}
const findCard = (cards: readonly CardRow[], copyKey: string, status?: string): CardRow | undefined => cards.filter((c) => c.copy_key === copyKey && (!status || c.status === status)).at(-1);
const cardMessage = (messages: readonly P[], copyKey: string): P | undefined => messages.find((m) => ((m["card"] as P | null)?.["copy_key"]) === copyKey);

test("32.10-T1: Given a payment due Sep 1, 2026 unpaid, then live-contact attempts are logged by Oct 7 (day 36) using only channels with consent, the EI notice and continuity assignment exist by Oct 16 (day 45), and the `PersonCard` shows a reachable direct number (4.3 T1).", { skip }, async () => {
  const { j, email, partyId, loanId, last4, recipients } = await servicedLoan({ at: MST("2026-09-02", "06:05"), first_unpaid_due: "2026-09-01", unpaid_months: 1 });
  // day 16 (Sep 17): the counter job (11.1, through the flow's tick) opens the Reg X windows for the Sep 1 due date — the 36-day and 45-day clocks anchor on the due date the registry names
  await tick(MST("2026-09-17", "06:05"));
  assert.deepEqual((await events(loanId, "loan.delinquency.window_opened")).map((e) => e.payload["due_date"]), ["2026-09-01"]);
  assert.equal((await events(loanId, "loan.delinquency.day_reached")).at(-1)?.payload["day"], 16);
  const live = await timer(loanId, "REGX_1024_39A_LIVE_CONTACT_36"); assert.ok(live, "REGX_1024_39A_LIVE_CONTACT_36 armed"); assert.equal(live.due_date, "2026-10-07");
  const written = await timer(loanId, "REGX_1024_39B_WRITTEN_NOTICE_45"); assert.ok(written, "REGX_1024_39B_WRITTEN_NOTICE_45 armed"); assert.equal(written.due_date, "2026-10-16");
  assert.equal(findCard(await cardsOf(loanId), "hardship.open")?.kind, "StatusCard");
  // Oct 5: the live-contact attempts — only channels with consent. SMS (tcpa_sms consent active) is logged; the AI dialer without tcpa_voice consent is refused by the pre-dial check; a human dial (no TCPA consent needed) is logged no_answer.
  clock.set(MST("2026-10-05", "10:00"));
  const facts = (over: P = {}): P => ({ dial_at: clock.now(), time_zones: ["America/Phoenix"], line_type: "wireless", tcpa_sms_consent_active: true, tcpa_voice_consent_active: false, counted_call_attempts_at: [], days_since_conversation: 999, days_until_sale: 9999, state: "AZ", ...over });
  const sms = await tool(j, loanId, "11.3", "contact.log", { id: `ct-${loanId.slice(0, 8)}-sms`, loan_id: loanId, mode: "sms", direction: "outbound", outcome: "delivered", party_id: partyId, on: "2026-10-05", pre_dial_facts: facts() }, COMMS);
  assert.ok(sms.events.some((e) => e.type === "contact.attempted"), "the SMS attempt is logged");
  const ai = await refused(j, loanId, "11.3", "contact.log", { id: `ct-${loanId.slice(0, 8)}-ai`, loan_id: loanId, mode: "ai_voice", direction: "outbound", outcome: "no_answer", party_id: partyId, on: "2026-10-05", pre_dial_facts: facts() }, COMMS);
  assert.equal(ai.status, 409, JSON.stringify(ai.body)); assert.equal(ai.body["code"], "PRE_DIAL_CHECKS_REQUIRED");
  const human = await tool(j, loanId, "11.3", "contact.log", { id: `ct-${loanId.slice(0, 8)}-hv`, loan_id: loanId, mode: "human_voice", direction: "outbound", outcome: "no_answer", party_id: partyId, on: "2026-10-05", pre_dial_facts: facts() }, COMMS);
  assert.ok(human.events.some((e) => e.type === "contact.attempted"));
  await tick(MST("2026-10-07", "06:05"));   // day 36
  const attempts = await events(loanId, "contact.attempted");
  assert.equal(attempts.length, 2, "two attempts logged by day 36 — none on the unconsented AI-voice channel");
  assert.deepEqual(attempts.map((a) => a.payload["mode"]).sort(), ["human_voice", "sms"]);
  assert.ok(attempts.every((a) => String(a.payload["on"]) <= "2026-10-07"));
  // Oct 9: the written early-intervention notice (11.2) — the render is first a 4.3 written-notice request: no assignment exists, so the default team is auto-assigned (`continuity.assigned`) and the notice carries its block; the print request sends it
  clock.set(MST("2026-10-09", "09:00"));
  const rendered = await tool(j, loanId, "11.2", "notice.render", { template_code: NOTICE_CODES_32_10.ei_standard, loan_id: loanId, recipients, payload: { ...sample(NOTICE_CODES_32_10.ei_standard, "2026-10-09"), notice_date: "2026-10-09", account_last4: last4, property_address: PROPERTY, due_date: "2026-09-01" }, default_team: FAKE_TEAM, due_unpaid: "2026-09-01", principal_residence: true }, COLLECTIONS);
  const assigned = rendered.events.find((e) => e.type === "continuity.assigned"); assert.ok(assigned, rendered.events.map((e) => e.type).join(","));
  assert.equal(assigned!.payload["direct_number"], FAKE_TEAM.direct_number); assert.equal(assigned!.payload["auto_assigned"], true);
  const noticeId = String((rendered.output as P)["id"]);
  const sent = await tool(j, loanId, "11.2", "print.request", { notice_id: noticeId, loan_id: loanId, template: NOTICE_CODES_32_10.ei_standard, party_id: partyId }, COLLECTIONS);
  const ns = sent.events.find((e) => e.type === "notice.sent"); assert.ok(ns, sent.events.map((e) => e.type).join(",")); assert.equal(ns!.payload["template"], NOTICE_CODES_32_10.ei_standard);
  await tick(MST("2026-10-16", "06:05"));   // day 45
  // by day 45: the EI notice and the continuity assignment exist; the written-notice clock is satisfied by the send
  assert.equal((await events(loanId, "notice.sent")).filter((e) => e.payload["template"] === NOTICE_CODES_32_10.ei_standard).length, 1);
  assert.equal((await events(loanId, "continuity.assigned")).length, 1);
  const w2 = await timer(loanId, "REGX_1024_39B_WRITTEN_NOTICE_45"); assert.match(w2!.status, /^satisfied/, `the 45-day written-notice clock is ${w2!.status}`);
  const episodes = await entitiesOf("continuity_episodes", loanId); assert.equal(episodes.at(-1)?.["direct_number"], FAKE_TEAM.direct_number);
  // the PersonCard names the team and a reachable direct number; the Record's People row carries the same number; the EI notice is a NoticeCard
  const cards = await cardsOf(loanId);
  const person = findCard(cards, "team.assigned"); assert.ok(person, "PersonCard team.assigned"); assert.equal(person!.kind, "PersonCard"); assert.equal(person!.props["role"], "continuity_of_contact_team"); assert.equal(person!.props["reach"], FAKE_TEAM.direct_number); assert.equal(person!.props["name"], FAKE_TEAM.team_name);
  const ei = findCard(cards, "hardship.notice.ei"); assert.ok(ei, "NoticeCard hardship.notice.ei"); assert.equal(ei!.props["notice_code"], NOTICE_CODES_32_10.ei_standard); assert.equal(ei!.props["channel"], "mail");
  const rec = await record(email, loanId);
  const team = (rec["people"] as P[]).find((p) => p["role"] === "continuity_of_contact_team"); assert.ok(team, "People: the continuity-of-contact team"); assert.equal(team!["direct_number"], FAKE_TEAM.direct_number); assert.equal(team!["display_name"], FAKE_TEAM.team_name);
  assert.equal((rec["status"] as P)["badge"], "Behind");
  assert.ok((rec["documents"] as P[]).some((d) => d["notice_code"] === NOTICE_CODES_32_10.ei_standard), "Documents lists the EI notice");
});

test("32.10-T2: Given the borrower types \"I lost my job and can't pay next month\" while current, then a QRPC record and an 11.5 imminent-default evaluation exist, and a `lossmit_applications` row is `received` (evaluative information present) with the 5-day ack.", { skip }, async () => {
  assert.deepEqual(classifyHardship("I lost my job and can't pay next month"), { kind: "hardship", reason: "unemployment" });
  const { email, partyId, loanId } = await servicedLoan({ at: MST("2026-09-10", "10:00") });   // current: every installment satisfied
  const { token } = await signIn(email);
  const r = await api("POST", "/v1/borrower/messages", { text: "I lost my job and can't pay next month", subject: { loan_id: loanId } }, token);
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal((r.body["reply"] as P)["copy_key"], "hardship.heard"); assert.equal(r.body["command"], "lossmit.requestAssistance"); assert.equal(r.body["routed_to"], "borrower-comms");
  await settle();
  // 11.3: the inbound contact and the QRPC record from the borrower's own words — conversation_only until a person verifies it (rule 6); reason unemployment (FNMA 016)
  const qrpc = await entitiesOf("qrpc_records", loanId); assert.equal(qrpc.length, 1); assert.equal(qrpc[0]!["status"], "conversation_only"); assert.equal(qrpc[0]!["reason_primary"], "unemployment"); assert.equal(qrpc[0]!["fnma_reason_code"], "016"); assert.equal(qrpc[0]!["conducted_by"], "ai_agent");
  assert.ok((await events(loanId, "contact.qrpc.captured")).length === 1);
  assert.equal((await events(loanId, "contact.inbound.received")).length, 1);
  // 11.5: the imminent-default evaluation exists on the current loan (regx_days_delinquent 0) and waits on the BRP the application will carry
  const ide = await entitiesOf("imminent_default_evaluations", loanId); assert.equal(ide.length, 1); assert.equal(ide[0]!["status"], "awaiting_brp"); assert.equal(ide[0]!["regx_days_delinquent"], 0); assert.equal(ide[0]!["hardship_type"], "unemployment"); assert.equal(ide[0]!["source"], "lossmit.request.create");
  assert.equal((await events(loanId, "imminent_default.evaluating")).length, 1);
  // 12.1: a stated hardship is evaluative information — an application, not a bare RFA: `lossmit.application.received`, the row received today, the 5-day (federal business days) acknowledgment clock
  const received = await events(loanId, "lossmit.application.received"); assert.equal(received.length, 1); assert.equal(received[0]!.payload["received_date"], "2026-09-10");
  assert.equal((await events(loanId, "lossmit.rfa.received")).length, 0);
  const apps = await entitiesOf("lossmit_applications", loanId); assert.equal(apps.length, 1); assert.equal(apps[0]!["received_on"], "2026-09-10"); assert.ok(["received", "incomplete"].includes(String(apps[0]!["status"])), `status ${String(apps[0]!["status"])}: received, awaiting the (b)(2) acknowledgment`); assert.equal(apps[0]!["hardship_reason"], "unemployment"); assert.equal(apps[0]!["qrpc_id"], qrpc[0]!.id); assert.equal(apps[0]!["ack_due"], "2026-09-17");
  const ack = await timer(loanId, "REGX_1024_41B2_LM_ACK_5"); assert.ok(ack, "REGX_1024_41B2_LM_ACK_5 armed"); assert.equal(ack.status, "armed"); assert.equal(ack.due_date, "2026-09-17");
  // the Thread: the reply, the ConfirmCard of what was understood (pending, in Needed-from-you), the received status with the ack clock
  const msgs = await thread(email);
  assert.ok(msgs.some((m) => m["body_text"] === "{{copy:hardship.heard}}"), "the reply is the hardship.heard copy");
  const cards = await cardsOf(loanId);
  const confirm = findCard(cards, "hardship.qrpc.confirm", "pending"); assert.ok(confirm, "ConfirmCard hardship.qrpc.confirm pending"); assert.equal(confirm!.party_id, partyId); assert.equal(confirm!.command_ref, "lossmit.requestAssistance");
  assert.equal(((confirm!.props["fields"] as P[]).find((f) => f["path"] === "hardship.reason"))?.["value"], "unemployment");
  const status = findCard(cards, "hardship.application.received"); assert.ok(status, "StatusCard hardship.application.received"); assert.equal(status!.props["next_event_at"], ack.due_at);
  const rec = await record(email, loanId);
  assert.ok((rec["needed_from_you"] as P[]).some((n) => n["card_instance_id"] === confirm!.card_instance_id));
  assert.ok((rec["dates"] as P[]).some((d) => d["timer_code"] === "REGX_1024_41B2_LM_ACK_5"), "Dates: the acknowledgment clock");
  assert.equal(((rec["loan"] as P)["hardship"] as P)["status"], "application_pending");
});

test("32.10-T3: Given an incomplete application, then `NTC_REGX_41B2_ACK_INCOMPLETE` lists the missing items and the reasonable date, and the same items appear in Needed-from-you.", { skip }, async () => {
  const { j, email, loanId, last4, recipients } = await servicedLoan({ at: MST("2026-09-10", "10:00") });
  const ITEMS = ["two most recent pay stubs", "most recent bank statement"];
  // 12.1: the application received Sep 10 with evaluative information; incomplete
  const opened = await tool(j, loanId, "12.1", "lossmit.application.open/update", { loan_id: loanId, received_on: "2026-09-10", has_evaluative_info: true, confidence: 1, state: "AZ", status: "incomplete", income: { monthly_cents: "620000" } }, LOSSMIT);
  const appId = String((opened.output as P)["id"] ?? `lma-${loanId}-2026-09-10`);
  assert.ok(opened.events.some((e) => e.type === "lossmit.application.received"));
  // Sep 14 (within 5 BD): the reasonable-date decision on the acknowledgment (12.1 rule: 30 days from the ack, the sale and doc-staleness milestones absent) and the missing items on the row
  clock.set(MST("2026-09-14", "09:00"));
  await tool(j, loanId, "12.1", "lossmit.application.open/update", { op: "update", id: appId, loan_id: loanId, received_on: "2026-09-10", ack_sent_on: "2026-09-14", status: "incomplete", changes: { missing_documents: ITEMS } }, LOSSMIT);
  const app = (await entitiesOf("lossmit_applications", loanId)).find((a) => a.id === appId)!;
  const reasonable = String(app["reasonable_date"]); assert.match(reasonable, /^\d{4}-\d{2}-\d{2}$/, "12.1 set the reasonable date"); assert.ok(reasonable > "2026-09-14"); assert.deepEqual(app["missing_documents"], ITEMS);
  // the (b)(2)(i)(B) acknowledgment through the Notice Registry — the notice lists the items and the reasonable date
  const n = await tool(j, loanId, "12.1", "notice.render_send", { template_code: NOTICE_CODES_32_10.ack_incomplete, loan_id: loanId, recipients, payload: { ...sample(NOTICE_CODES_32_10.ack_incomplete, "2026-09-14"), notice_date: "2026-09-14", received_date: "2026-09-10", missing_documents: ITEMS, reasonable_date: reasonable, account_last4: last4, property_address: PROPERTY, spoc_phone: FAKE_TEAM.direct_number, days_to_reasonable_date: Math.round((Date.parse(reasonable) - Date.parse("2026-09-14")) / 86_400_000) } }, LOSSMIT);
  const sent = n.events.find((e) => e.type === "notice.sent"); assert.ok(sent, n.events.map((e) => e.type).join(",")); assert.equal(sent!.payload["template"], NOTICE_CODES_32_10.ack_incomplete);
  const text = noticeText(sent!.payload["notice_id"]); for (const item of ITEMS) assert.ok(text.includes(item), `the notice lists ${item}`);
  assert.ok(text.includes(new Date(`${reasonable}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })), "the notice states the reasonable date");
  const ack = await timer(loanId, "REGX_1024_41B2_LM_ACK_5"); assert.match(ack!.status, /^satisfied/);
  await settle();
  // the NoticeCard carries the same items and date; one UploadCard per item — the same items under Needed-from-you with the reasonable date as their due date
  const cards = await cardsOf(loanId);
  const notice = findCard(cards, "hardship.ack.incomplete"); assert.ok(notice, "NoticeCard hardship.ack.incomplete"); assert.deepEqual(notice!.props["missing_documents"], ITEMS); assert.equal(notice!.props["reasonable_date"], reasonable); assert.equal((notice!.props["copy_tokens"] as P)["items"], ITEMS.join(", ")); assert.ok(String(notice!.props["plain_language"]).includes(ITEMS[0]!));
  const uploads = cards.filter((c) => c.copy_key === "hardship.needs.item" && c.status === "pending"); assert.equal(uploads.length, ITEMS.length); assert.deepEqual(uploads.map((u) => u.props["needed_label"]).sort(), [...ITEMS].sort());
  const rec = await record(email, loanId);
  const needed = rec["needed_from_you"] as P[];
  const loanLocalDay = (iso: unknown): string => new Date(String(iso)).toLocaleDateString("en-CA", { timeZone: "America/Phoenix" });   // the due instant is 23:59 loan-local on the reasonable date
  for (const item of ITEMS) { const row = needed.find((x) => x["label"] === item); assert.ok(row, `Needed-from-you lists ${item}`); assert.equal(loanLocalDay(row!["due_at"]), reasonable); assert.equal(row!["kind"], "document_request"); }
  assert.equal(((rec["loan"] as P)["hardship"] as P)["status"], "application_pending");
  assert.deepEqual((((rec["loan"] as P)["hardship"] as P)["application"] as P)["missing_documents"], ITEMS);
});

test("32.10-T4: Given a complete application received 40 days before a scheduled sale, then the Thread shows the protection sentence and `REGX_1024_41G_DUAL_TRACK_GATE` blocks the sale internally.", { skip }, async () => {
  const { j, email, loanId } = await servicedLoan({ at: MST("2026-10-01", "06:05"), first_unpaid_due: "2026-05-01", unpaid_months: 6 });
  await tick(MST("2026-10-01", "06:05"));   // day 153: the counters and the 120-day gate (13.1)
  const CASE = `fc-${loanId.slice(0, 8)}`;
  await referLoan(j, loanId, CASE, "2026-10-01", 153);
  // the firm's milestones: first legal (NOD recorded Oct 15) and a sale scheduled for Dec 10
  clock.set(MST("2026-10-15", "15:00"));
  const nod = await tool(j, loanId, "13.2", "attorney.instruction.status", { op: "firm_message", loan_id: loanId, kind: "MILESTONE", case_id: CASE, firm_id: "FAKE-FIRM-1", code: "NOD_RECORDED", occurred_on: "2026-10-15", source: "firm" }, FC);
  assert.ok(nod.events.some((e) => e.type === "foreclosure.first_notice.filed"), nod.events.map((e) => e.type).join(","));
  const sale = await tool(j, loanId, "13.2", "attorney.instruction.status", { op: "firm_message", loan_id: loanId, kind: "SALE_SCHEDULED", case_id: CASE, firm_id: "FAKE-FIRM-1", sale_at: "2026-12-10", method: "non_judicial" }, FC);
  assert.ok(sale.events.some((e) => e.type === "foreclosure.sale.scheduled"));
  // Oct 31: the complete application — 40 days before the Dec 10 sale (> 37: §1024.41(g) protection; 12.1 names the tier and the days)
  const appId = await completeApplication(j, loanId, "2026-10-31", { sale_on: "2026-12-10" });
  const completed = (await events(loanId, "lossmit.application.completed")).at(-1)!;
  assert.equal(completed.payload["days_before_sale"], 40); assert.equal(completed.payload["sale_on"], "2026-12-10"); assert.equal(completed.payload["application_id"], appId);
  await settle();
  // the Thread shows the protection sentence (the copy key `hardship.protection`, the sentence itself in the library)
  const msgs = await thread(email);
  const protection = cardMessage(msgs, "hardship.protection"); assert.ok(protection, "the protection sentence is in the Thread");
  assert.equal(((protection!["card"] as P)["props"] as P)["days_before_sale"], 40); assert.equal(((protection!["card"] as P)["props"] as P)["gate"], "REGX_1024_41G_DUAL_TRACK_GATE");
  assert.ok(cardMessage(msgs, "hardship.application.complete"), "the complete status");
  // internally: 13.1's gate evaluation for the sale — REGX_1024_41G_DUAL_TRACK_GATE closed by the complete application after the first notice (13.2)
  const g = await tool(j, loanId, "13.1", "foreclosure.gates.evaluate", { loan_id: loanId, step: "sale_conduct" }, FC);
  const out = g.output as { open: boolean; blocked_by: string[] };
  assert.ok(out.blocked_by.includes("REGX_1024_41G_DUAL_TRACK_GATE"), `blocked_by ${out.blocked_by.join(",")}`); assert.equal(out.open, false);
  const evaluations = await entitiesOf("foreclosure_gate_evaluations", loanId);
  const dual = evaluations.filter((x) => x["gate_code"] === "REGX_1024_41G_DUAL_TRACK_GATE" && x["step"] === "sale_conduct"); assert.ok(dual.length > 0, "the 13.1 evaluation row for the dual-track gate"); assert.equal(dual.at(-1)!["result"], "closed");
  assert.equal(((dual.at(-1)!["inputs"] as P)["complete_app_after_first_notice"]), true, "closed because a complete application arrived after the first notice, more than 37 days before the sale");
});

test("32.10-T5: Given an offer notice on Nov 2, then Dates shows the 14-day acceptance deadline; silence → `deemed_rejected` on Nov 17 with the copy that said so on Nov 2.", { skip }, async () => {
  const { j, email, loanId, last4, recipients } = await servicedLoan({ at: MST("2026-10-20", "09:00"), first_unpaid_due: "2026-07-01", unpaid_months: 3 });
  const appId = await completeApplication(j, loanId, "2026-10-20");
  await tool(j, loanId, "12.2", "lossmit.evaluation.*", { op: "start", loan_id: loanId, application_id: appId, complete_on: "2026-10-20", basis: "complete_application", option: "payment_deferral", state: "AZ" }, LOSSMIT);
  // Nov 2: the decision (the calculator's terms, kept on the evaluation) and the offer notice — `lossmit.offer.sent{tier=ge_90}` arms REGX_1024_41E1_ACCEPT_14 on provided_at
  clock.set(MST("2026-11-02", "10:00"));
  const TERMS = { months_deferred: 3, deferred_cents: "1127625", advances_cents: "0", late_charges_waived_cents: "18794", new_payment_cents: "444625", first_due: "2026-12-01" };
  const decided = await tool(j, loanId, "12.2", "lossmit.evaluation.*", { loan_id: loanId, application_id: appId, complete_on: "2026-10-20", provided_on: "2026-11-02", outcome: "offered", option: "payment_deferral", state: "AZ", terms: TERMS, calculator_run_id: "calc-deferral-1", source: "rules_engine" }, LOSSMIT);
  const ev = decided.output as P; assert.equal(ev["accept_by"], "2026-11-16"); assert.equal(ev["tier"], "ge_90"); assert.equal(ev["window_days"], 14); assert.equal(ev["grace_days"], 5);
  const offer = await tool(j, loanId, "12.2", "notice.render_send", { template_code: "NTC_FNMA_D23204_DEFERRAL_OFFER", loan_id: loanId, recipients, option: "payment_deferral", calculator_run_id: "calc-deferral-1", payload: { ...sample("NTC_FNMA_D23204_DEFERRAL_OFFER", "2026-11-02"), notice_date: "2026-11-02", complete_application: true, complete_on: "2026-10-20", accept_by: "2026-11-16", months_deferred: 3, deferred_cents: TERMS.deferred_cents, advances_cents: "0", late_charges_waived_cents: TERMS.late_charges_waived_cents, new_payment_cents: TERMS.new_payment_cents, first_due: "2026-12-01", contractual_payment_required: false, account_last4: last4, property_address: PROPERTY, appeal_available: false } }, LOSSMIT);
  const sent = offer.events.find((e) => e.type === "lossmit.offer.sent"); assert.ok(sent, offer.events.map((e) => e.type).join(",")); assert.equal(sent!.payload["provided_at"], "2026-11-02"); assert.equal(sent!.payload["tier"], "ge_90");
  const accept = await timer(loanId, "REGX_1024_41E1_ACCEPT_14"); assert.ok(accept, "REGX_1024_41E1_ACCEPT_14 armed"); assert.equal(accept.status, "armed"); assert.equal(accept.due_date, "2026-11-16");
  await settle();
  // Dates shows the acceptance deadline (the 32.2 allow-list row; the date is the engine's due_at)
  const rec = await record(email, loanId);
  const dateRow = (rec["dates"] as P[]).find((d) => d["timer_code"] === "REGX_1024_41E1_ACCEPT_14"); assert.ok(dateRow, "Dates: the 14-day acceptance deadline"); assert.equal(dateRow!["due_at"], accept.due_at, "the engine's due_at (23:59 loan-local on Nov 16), never recomputed");
  assert.equal(rec["next"] && (rec["next"] as P)["timer_code"], "REGX_1024_41E1_ACCEPT_14");
  // the offer's ComparisonCard says what silence means, in the copy of Nov 2 (`hardship.offer.deadline` "Please respond by {{date}}. If we don't hear from you, the offer is treated as declined."), and expires at accept_by
  const cards = await cardsOf(loanId);
  const compare = findCard(cards, "hardship.offer.compare", "pending"); assert.ok(compare, "ComparisonCard hardship.offer.compare"); assert.equal(compare!.props["accept_by"], "2026-11-16"); assert.equal((compare!.props["copy_tokens"] as P)["date"], "2026-11-16"); assert.equal(compare!.props["deadline_copy_key"], "hardship.offer.deadline"); assert.equal(String(compare!.expires_at).slice(0, 10), "2026-11-17"); assert.equal(compare!.command_ref, "lossmit.respondToOffer");
  assert.ok(findCard(cards, "hardship.offer.notice"), "NoticeCard hardship.offer.notice");
  assert.equal(((rec["loan"] as P)["hardship"] as P)["status"], "offer_pending"); assert.equal((((rec["loan"] as P)["hardship"] as P)["offer"] as P)["accept_by"], "2026-11-16");
  // Nov 17 (silence): the card expires and the Record says so — as the offer said; 12.2's own deemed rejection follows its 5-day policy grace (12.2 open question 1: accept_by + 5)
  await tick(MST("2026-11-17", "06:05"));
  const after = await cardsOf(loanId);
  assert.equal(after.find((c) => c.card_instance_id === compare!.card_instance_id)!.status, "expired");
  const deemedCard = findCard(after, "hardship.offer.deemed_rejected"); assert.ok(deemedCard, "StatusCard hardship.offer.deemed_rejected on Nov 17"); assert.equal((deemedCard!.props["copy_tokens"] as P)["date"], "2026-11-16"); assert.equal(deemedCard!.props["said_on_copy_key"], "hardship.offer.deadline");
  assert.equal((await events(loanId, "lossmit.offer.deemed_rejected")).length, 0, "12.2 deems the rejection only after the policy grace (Nov 21)");
  const a2 = await timer(loanId, "REGX_1024_41E1_ACCEPT_14"); assert.equal(a2!.status, "breached");
  await tick(MST("2026-11-21", "06:05"));
  const deemed = await events(loanId, "lossmit.offer.deemed_rejected"); assert.equal(deemed.length, 1); assert.equal(deemed[0]!.payload["accept_by"], "2026-11-16"); assert.equal(deemed[0]!.payload["deemed_rejected_on"], "2026-11-21"); assert.equal(deemed[0]!.payload["grace_days"], 5);
  assert.equal((await entitiesOf("lossmit_offers", loanId)).at(-1)?.["status"], "deemed_rejected");
  const rec2 = await record(email, loanId); assert.equal(((rec2["loan"] as P)["hardship"] as P)["status"], "deemed_rejected");
});

test("32.10-T6: Given a Flex Mod TPP offer, then the first trial payment received by its due date moves the case to `tpp_active` without any other tap, and the `PaymentCard` default equals the trial amount.", { skip }, async () => {
  const { j, email, partyId, loanId, last4, recipients } = await servicedLoan({ at: MST("2026-10-20", "09:00"), first_unpaid_due: "2026-07-01", unpaid_months: 3 });
  const appId = await completeApplication(j, loanId, "2026-10-20");
  await tool(j, loanId, "12.2", "lossmit.evaluation.*", { op: "start", loan_id: loanId, application_id: appId, complete_on: "2026-10-20", basis: "complete_application", option: "flex_mod", state: "AZ" }, LOSSMIT);
  clock.set(MST("2026-11-02", "10:00"));
  const TRIAL = "444625"; const DUE = ["2026-12-01", "2027-01-01", "2027-02-01"];
  const TERMS = { trial_payment_cents: TRIAL, pi_cents: "375875", escrow_cents: "68750", trial_count: 3, first_due: DUE[0], due_dates: DUE, rate_pct: "6.500", term_months: 480, effective: "2027-03-01", ib_upb_cents: "55000000", forborne_cents: "3500000" };
  await tool(j, loanId, "12.2", "lossmit.evaluation.*", { loan_id: loanId, application_id: appId, complete_on: "2026-10-20", provided_on: "2026-11-02", outcome: "offered", option: "flex_mod", state: "AZ", terms: TERMS, calculator_run_id: "wf-flex-1", source: "rules_engine" }, LOSSMIT);
  const offer = await tool(j, loanId, "12.2", "notice.render_send", { template_code: NOTICE_CODES_32_10.tpp_offer, loan_id: loanId, recipients, option: "flex_mod", calculator_run_id: "wf-flex-1", payload: { ...sample(NOTICE_CODES_32_10.tpp_offer, "2026-11-02"), notice_date: "2026-11-02", complete_application: true, complete_on: "2026-10-20", trial_count: 3, trial_payment_cents: TRIAL, pi_cents: TERMS.pi_cents, escrow_cents: TERMS.escrow_cents, due_dates: DUE, first_due: DUE[0], effective: TERMS.effective, rate_pct: TERMS.rate_pct, term_months: TERMS.term_months, ib_upb_cents: TERMS.ib_upb_cents, forborne_cents: TERMS.forborne_cents, waterfall_run_id: "wf-flex-1", waterfall: { rate_pct: TERMS.rate_pct, term_months: TERMS.term_months, ib_upb_cents: TERMS.ib_upb_cents, forborne_cents: TERMS.forborne_cents, pi_cents: TERMS.pi_cents, trial_payment_cents: TRIAL }, account_last4: last4, property_address: PROPERTY, appeal_available: false } }, LOSSMIT);   // the notice's checklist: terms equal the waterfall's; trial = P&I + escrow (F-1-27)
  assert.ok(offer.events.some((e) => e.type === "lossmit.offer.sent" && e.payload["template"] === NOTICE_CODES_32_10.tpp_offer), offer.events.map((e) => e.type).join(","));
  await settle();
  // the PaymentCard defaults to the trial amount the evaluation carries (never computed here), not editable, due by the first trial due date
  const cards = await cardsOf(loanId);
  const pay = findCard(cards, "hardship.tpp.pay", "pending"); assert.ok(pay, "PaymentCard hardship.tpp.pay"); assert.equal(pay!.kind, "PaymentCard"); assert.equal(pay!.props["amount_default_cents"], TRIAL); assert.equal(pay!.props["amount_editable"], false); assert.equal(pay!.props["mode"], "one_time"); assert.equal(pay!.command_ref, "payment.makeOneTime"); assert.equal((pay!.props["command_args"] as P)["designation"], "trial"); assert.equal(String(pay!.expires_at).slice(0, 10), "2026-12-02");
  assert.ok(findCard(cards, "hardship.tpp.notice"), "NoticeCard hardship.tpp.notice");
  assert.equal(cards.filter((c) => c.status === "pending" && c.props["flow"] === "32.10").length, 1, "the payment is the only ask");
  // Nov 20 (before the Dec 1 due date): the borrower pays from the card — a fresh L1 code, the card's own default amount; nothing else to tap
  clock.set(MST("2026-11-20", "10:00"));
  const { token } = await signIn(email);
  const paid = await api("POST", `/v1/borrower/cards/${pay!.card_instance_id}/resolve`, { evidence: { amount_cents: TRIAL, date: "2026-11-20", account_id: "acct-0001", include_late_charge: false, submitted_at: clock.now() }, option_id: "one_time" }, token);
  assert.ok(paid.status === 200 || paid.status === 201, JSON.stringify(paid.body).slice(0, 600)); assert.ok((paid.body["events"] as string[]).includes("payment.received"), JSON.stringify(paid.body["events"]));
  await settle();
  // cashiering's receipt → 12.2's `trial_payment_received` (the flow's bridge): acceptance by payment (D2-2-05), the offer accepted via payment, the 12.8 gate armed (tpp_active)
  const received = await events(loanId, "payment.received"); assert.equal(received.length, 1); assert.equal(received[0]!.payload["designation"], "trial"); assert.equal(received[0]!.payload["amount_cents"], TRIAL);
  const first = await events(loanId, "lossmit.trial.first_payment_received"); assert.equal(first.length, 1); assert.equal(first[0]!.payload["acceptance"], true); assert.equal(first[0]!.payload["accepted_by_payment"], true); assert.equal(first[0]!.payload["payment_date"], "2026-11-20"); assert.equal(first[0]!.payload["due_on"], DUE[0]);
  const responded = await events(loanId, "lossmit.offer.responded"); assert.equal(responded.length, 1); assert.equal(responded[0]!.payload["response"], "accepted"); assert.equal(responded[0]!.payload["accepted_via"], "payment");
  const offers = await entitiesOf("lossmit_offers", loanId); assert.equal(offers.at(-1)?.["status"], "accepted"); assert.equal(offers.at(-1)?.["accepted_via"], "payment"); assert.equal(offers.at(-1)?.["first_trial_payment_on"], "2026-11-20");
  const gate = await timer(loanId, "FNMA_E3401_FC_SUSPEND_DURING_TRIAL"); assert.ok(gate, "FNMA_E3401_FC_SUSPEND_DURING_TRIAL armed (tpp_active)"); assert.equal(gate.status, "armed");
  const after = await cardsOf(loanId);
  assert.equal(after.find((c) => c.card_instance_id === pay!.card_instance_id)!.status, "resolved");
  assert.equal(after.filter((c) => c.status === "pending" && c.props["flow"] === "32.10").length, 0, "no other tap");
  assert.ok(findCard(after, "hardship.tpp.active"), "StatusCard hardship.tpp.active");
  const rec = await record(email, loanId);
  assert.equal((rec["status"] as P)["badge"], "On a plan");
  const h = (rec["loan"] as P)["hardship"] as P; assert.equal(h["status"], "tpp_active"); assert.equal((h["tpp"] as P)["amount_cents"], TRIAL); assert.equal((h["tpp"] as P)["count"], 3); assert.equal((h["tpp"] as P)["n"], 2); assert.equal((h["tpp"] as P)["due_on"], DUE[1]);
  assert.equal(partyId, pay!.party_id);
});

test("32.10-T7: Given a forbearance plan, then the Loan section shows the paused period; a request beyond 12 cumulative months is refused with the LL-2026-01 copy; expiry renders the exit `ComparisonCard`.", { skip }, async () => {
  const { j, email, loanId } = await servicedLoan({ at: MST("2026-11-01", "09:00"), first_unpaid_due: "2026-09-01", unpaid_months: 2 });
  // 12.4: a 3-month term after 9 forborne months (the LL-2026-01 cumulative cap of 12 is reached by this term) — past the short-term boundary, on a recorded Reg X basis
  const PLAN = `wp-${loanId.slice(0, 8)}`;
  const activated = await tool(j, loanId, "12.4", "workout_plan.*", { loan_id: loanId, id: PLAN, requested_months: 3, cumulative_months: 9, months_delinquent_at_start: 2, start_on: "2026-11-01", regx_basis: "complete_application", status: "active" }, LOSSMIT);
  const act = activated.events.find((e) => e.type === "workout_plan.activated"); assert.ok(act, activated.events.map((e) => e.type).join(",")); assert.equal(act!.payload["term_start"], "2026-11-01");
  const termEnd = String(act!.payload["term_end"]); assert.match(termEnd, /^2027-01-/);
  const term = activated.events.find((e) => e.type === "workout_plan.term.create"); assert.equal(term?.payload["cumulative_months_after"], 12);
  await settle();
  // the Loan section shows the paused period (hardship.forb "Payments paused through {{date}}"), the badge reads Paused
  const rec = await record(email, loanId);
  const h = (rec["loan"] as P)["hardship"] as P; assert.equal(h["status"], "forbearance"); assert.equal((h["forbearance"] as P)["term_end"], termEnd); assert.equal((h["forbearance"] as P)["status"], "active"); assert.equal((h["forbearance"] as P)["late_charges_suppressed"], true);
  assert.equal((rec["status"] as P)["badge"], "Paused");
  const status = findCard(await cardsOf(loanId), "hardship.forb.active"); assert.ok(status, "StatusCard hardship.forb.active"); assert.equal((status!.props["copy_tokens"] as P)["date"], termEnd);
  // "extend my forbearance": 12.4's pre-screen finds the caps reached (cumulative 12) — refused with the LL-2026-01 copy, no extension card
  clock.set(MST("2027-01-05", "10:00"));
  const { token } = await signIn(email);
  const r = await api("POST", "/v1/borrower/messages", { text: "Can you extend my forbearance? I need more time.", subject: { loan_id: loanId } }, token);
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal((r.body["reply"] as P)["copy_key"], "hardship.forb.limit");
  const prescreen = (await events(loanId, "workout_plan.prescreen.completed")).at(-1); assert.ok(prescreen, "the 12.4 pre-screen ran"); assert.equal(prescreen!.payload["result"], "exception_required"); assert.equal(prescreen!.payload["extension_months"], 0);
  assert.equal((await cardsOf(loanId)).filter((c) => c.copy_key === "hardship.forb.extension").length, 0);
  // expiry: the plan ends at term end (12.4 op=expire → `workout_plan.ended{status=expired}`) — the exit ComparisonCard (reinstate / repayment plan / payment deferral / Flex Modification / payoff)
  clock.set(MST(termEnd, "06:05"));
  const ended = await tool(j, loanId, "12.4", "workout_plan.*", { op: "expire", loan_id: loanId, id: PLAN, ended_on: termEnd, deferral_eligible: true }, LOSSMIT);
  const end = ended.events.find((e) => e.type === "workout_plan.ended"); assert.ok(end); assert.equal(end!.payload["status"], "expired");
  await settle();
  const exit = findCard(await cardsOf(loanId), "hardship.forb.exit", "pending"); assert.ok(exit, "ComparisonCard hardship.forb.exit"); assert.equal(exit!.kind, "ComparisonCard");
  assert.deepEqual((exit!.props["columns"] as P[]).map((c) => c["id"]), ["reinstate", "repayment_plan", "payment_deferral", "flex_mod", "payoff"]); assert.equal((exit!.props["copy_tokens"] as P)["date"], termEnd); assert.equal(exit!.props["command"], "lossmit.requestAssistance");
  const rec2 = await record(email, loanId); assert.notEqual((rec2["status"] as P)["badge"], "Paused"); assert.equal((((rec2["loan"] as P)["hardship"] as P)["forbearance"] as P)["status"], "expired");
});

test("32.10-T8: Given a denial, then `NTC_REGX_41C1_DENIAL` renders with specific reasons and the appeal link; an appeal on day 15 → `NTC_REGX_41H_APPEAL_INELIGIBLE`.", { skip }, async () => {
  const { j, email, loanId, last4, recipients } = await servicedLoan({ at: MST("2026-10-20", "09:00"), first_unpaid_due: "2026-07-01", unpaid_months: 3 });
  const appId = await completeApplication(j, loanId, "2026-10-20");
  await tool(j, loanId, "12.2", "lossmit.evaluation.*", { op: "start", loan_id: loanId, application_id: appId, complete_on: "2026-10-20", basis: "complete_application", option: "flex_mod", state: "AZ" }, LOSSMIT);
  const CRITERION = "the modified payment would not reduce your payment and the loan is not 60+ days delinquent";
  // 12.2: the draft determination (denied, catalog reason code), the reviewer's approval, the decision; the denial notice renders only with the recorded approval and is checked against its own text (names the investor, quotes the criterion, states no other criteria were evaluated)
  await tool(j, loanId, "12.2", "lossmit.evaluation.*", { op: "draft", loan_id: loanId, complete_on: "2026-10-20", determinations: [{ option: "flex_mod", result: "denied", reason_codes: ["FNMA_D23207_NO_PAYMENT_REDUCTION"] }] }, LOSSMIT);
  await tool(j, loanId, "12.2", "lossmit.evaluation.*", { op: "review", loan_id: loanId, decision: "approved", reviewer: { id: REVIEWER.id, role: "lossmit_reviewer" }, reviewer_approval_id: "rev-denial-1" }, REVIEWER);
  clock.set(MST("2026-11-02", "10:00"));
  const decided = await tool(j, loanId, "12.2", "lossmit.evaluation.*", { loan_id: loanId, application_id: appId, complete_on: "2026-10-20", provided_on: "2026-11-02", outcome: "denied", option: "flex_mod", state: "AZ", source: "rules_engine" }, LOSSMIT);
  assert.equal((decided.output as P)["appeal_rights"], true);
  const denial = await tool(j, loanId, "12.2", "notice.render_send", { template_code: NOTICE_CODES_32_10.denial, loan_id: loanId, recipients, reviewer_approval_id: "rev-denial-1", option: "flex_mod", criterion: CRITERION, investor: "Fannie Mae",
    payload: { ...sample(NOTICE_CODES_32_10.denial, "2026-11-02"), notice_date: "2026-11-02", complete_date: "2026-10-20", denied: [{ name: "Flex Modification", reason: CRITERION, investor_name: "Fannie Mae", investor_requirement: "Servicing Guide D2-3.2-07 eligibility: payment reduction or 60+ days delinquent" }], investor_based: true, investor_name: "Fannie Mae", not_evaluated_other_criteria: true, appeal_days: 14, appeal_by: "2026-11-16", account_last4: last4, property_address: PROPERTY, state: "AZ", state_block: null, spoc_name: FAKE_TEAM.team_name, spoc_phone: FAKE_TEAM.direct_number } }, REVIEWER);
  const provided = denial.events.find((e) => e.type === "lossmit.denial.provided"); assert.ok(provided, denial.events.map((e) => e.type).join(",")); assert.equal(provided!.payload["appeal_by"], "2026-11-16");
  const text = noticeText(denial.events.find((e) => e.type === "notice.sent")!.payload["notice_id"]);
  assert.ok(text.includes("Flex Modification") && text.includes(CRITERION), "the denial states the specific reason"); assert.match(text, /appeal .* within 14 days, by November 16, 2026/); assert.match(text, /not evaluated on any other criteria/i);
  await settle();
  // the NoticeCard carries the reasons; the appeal link is the ChoiceCard (32.2 `lossmit.appeal`), open until appeal_by
  const cards = await cardsOf(loanId);
  const card = findCard(cards, "hardship.denial.notice"); assert.ok(card, "NoticeCard hardship.denial.notice"); assert.equal(card!.props["notice_code"], NOTICE_CODES_32_10.denial); assert.deepEqual(card!.props["reasons"], [CRITERION]); assert.equal(card!.props["denied_option"], "Flex Modification"); assert.equal(card!.props["appeal_by"], "2026-11-16"); assert.ok(String(card!.props["plain_language"]).includes(CRITERION));
  const appeal = findCard(cards, "hardship.appeal.choice", "pending"); assert.ok(appeal, "ChoiceCard hardship.appeal.choice (the appeal link)"); assert.equal(appeal!.command_ref, "lossmit.appeal"); assert.equal(((appeal!.props["command_args_by_option"] as P)["appeal"] as P)["application_id"], appId); assert.equal(String(appeal!.expires_at).slice(0, 10), "2026-11-17");
  // day 15 (Nov 17): the borrower's own appeal through the API — received, ineligible as late (§1024.41(h)(2)); the written explanation follows through the registry
  clock.set(MST("2026-11-17", "10:00"));
  const { token } = await signIn(email);
  const late = await api("POST", "/v1/borrower/commands/lossmit.appeal", { subject: { loan_id: loanId }, application_id: appId, text: "I want to appeal the denial of my modification. My income has changed since you reviewed it." }, token);
  assert.equal(late.status, 200, JSON.stringify(late.body).slice(0, 600));
  const received = (await events(loanId, "lossmit.appeal.received")).at(-1); assert.ok(received, "lossmit.appeal.received"); assert.equal(received!.payload["eligible"], false); assert.equal(received!.payload["ineligibility_reason"], "late"); assert.equal(received!.payload["appeal_window_ends"], "2026-11-16");
  const appeals = await entitiesOf("lossmit_appeals", loanId); assert.equal(appeals.at(-1)?.["status"], "ineligible"); assert.equal(appeals.at(-1)?.["received_date"], "2026-11-17");
  const ineligible = await tool(j, loanId, "12.2", "notice.render_send", { template_code: NOTICE_CODES_32_10.appeal_ineligible, loan_id: loanId, recipients, reviewer_approval_id: "rev-appeal-1", payload: { ...sample(NOTICE_CODES_32_10.appeal_ineligible, "2026-11-17"), notice_date: "2026-11-17", received_on: "2026-11-17", denial_on: "2026-11-02", appeal_days: 14, appeal_by: "2026-11-16", new_information: ["a changed-income statement"], reviewer_approval_id: "rev-appeal-1", account_last4: last4, property_address: PROPERTY } }, REVIEWER);
  assert.ok(ineligible.events.some((e) => e.type === "notice.sent" && e.payload["template"] === NOTICE_CODES_32_10.appeal_ineligible));
  await settle();
  const after = await cardsOf(loanId);
  assert.ok(findCard(after, "hardship.appeal.late"), "StatusCard hardship.appeal.late");
  const inel = findCard(after, "hardship.appeal.ineligible"); assert.ok(inel, "NoticeCard hardship.appeal.ineligible"); assert.equal(inel!.props["notice_code"], NOTICE_CODES_32_10.appeal_ineligible);
  assert.notEqual(after.find((c) => c.card_instance_id === appeal!.card_instance_id)!.status, "pending");
});

test("32.10-T9: Given a bankruptcy notice, then the badge changes, outbound collection stops, the statement variant switches, and `NTC_BK_PAYMENT_INSTRUCTIONS` renders without collection language.", { skip }, async () => {
  const { j, email, partyId, loanId, last4, recipients } = await servicedLoan({ at: MST("2026-11-01", "09:00"), first_unpaid_due: "2026-09-01", unpaid_months: 2 });
  await tick(MST("2026-11-01", "06:05"));
  clock.set(MST("2026-11-01", "10:00"));   // inside the calling window (11.1 quiet hours)
  const facts = (over: P = {}): P => ({ dial_at: clock.now(), time_zones: ["America/Phoenix"], line_type: "wireless", tcpa_voice_consent_active: true, tcpa_sms_consent_active: true, counted_call_attempts_at: [], days_since_conversation: 999, days_until_sale: 9999, state: "AZ", bk_active: false, ...over });
  // before the notice: a collection call is a normal outbound contact
  const before = await tool(j, loanId, "11.3", "contact.log", { id: `ct-${loanId.slice(0, 8)}-1`, loan_id: loanId, mode: "human_voice", direction: "outbound", outcome: "no_answer", party_id: partyId, on: "2026-11-01", pre_dial_facts: facts() }, COMMS);
  assert.ok(before.events.some((e) => e.type === "contact.attempted"));
  // the bankruptcy notice (from the borrower's contact) — 14.1 gates immediately, then verifies against the PCL hit: the petition is filed, the stay in effect
  clock.set(MST("2026-11-03", "11:00"));
  const CASE_NO = "2:26-bk-12345";
  const ingest = await tool(j, loanId, "14.1", "bk.case.read/write", { op: "ingest_notice", loan_id: loanId, source: "contact", received_at: clock.now(), chapter: "13", case_number_full: CASE_NO, notice_id: "bkn-1", scheduled_contacts: [] }, BK);
  assert.ok(ingest.events.length > 0);
  const verified = await tool(j, loanId, "14.1", "bk.case.read/write", { op: "verify", loan_id: loanId, notice_id: "bkn-1", borrower: { last_name: "Borrower", ssn4: "6789", first_name: "Alex", property_address: PROPERTY }, hits: [{ last_name: "Borrower", ssn4: "6789", first_name: "Alex", address: PROPERTY, case_number_full: CASE_NO, chapter: "13", date_filed: "2026-11-02" }], case_number_from_notice: CASE_NO }, BK);
  const filed = verified.events.find((e) => e.type === "bankruptcy.petition.filed"); assert.ok(filed, verified.events.map((e) => e.type).join(",")); assert.equal(filed!.payload["chapter"], "13");
  await settle();
  // the badge changes; the flow's status card says what stopped
  const rec = await record(email, loanId);
  assert.equal((rec["status"] as P)["badge"], "Bankruptcy — protections in effect");
  assert.ok(findCard(await cardsOf(loanId), "hardship.bk.protections"), "StatusCard hardship.bk.protections");
  // outbound collection stops: the loan's bankruptcy fact (11.2 `bk.status`, the 14.1 record) fails the pre-dial check; a collection template is refused by 14.1's informational-only allowlist
  const bk = await tool(j, loanId, "11.2", "bk.status", { loan_id: loanId }, COLLECTIONS);
  const active = (bk.output as P)["active"] === true || (bk.output as P)["bk_active"] === true || /active|in_effect|pending/.test(JSON.stringify(bk.output));
  assert.ok(active, `bk.status: ${JSON.stringify(bk.output).slice(0, 200)}`);
  clock.set(MST("2026-11-04", "10:00"));
  const stopped = await refused(j, loanId, "11.3", "contact.log", { id: `ct-${loanId.slice(0, 8)}-2`, loan_id: loanId, mode: "human_voice", direction: "outbound", outcome: "no_answer", party_id: partyId, on: "2026-11-04", pre_dial_facts: facts({ bk_active: true }) }, COMMS);
  assert.equal(stopped.status, 409, JSON.stringify(stopped.body)); assert.equal(stopped.body["code"], "PRE_DIAL_CHECKS_REQUIRED");
  const collection = await refused(j, loanId, "14.1", "notice.send", { template_code: NOTICE_CODES_32_10.ei_standard, loan_id: loanId, recipients, payload: sample(NOTICE_CODES_32_10.ei_standard, "2026-11-04") }, BK);
  assert.equal(collection.status, 409); assert.equal(collection.body["code"], "INFORMATIONAL_TEMPLATES_ONLY");
  // the statement variant switches (14.3: the Chapter 12/13 modified statement)
  const mode = await tool(j, loanId, "14.3", "bk.statement_mode.set", { loan_id: loanId, mode: "modified_ch12_13", case_id: `bkcase-${loanId}`, effective_on: "2026-11-04", addressing: "debtor", addressing_basis: "no counsel of record" }, BK);
  const set = mode.events.find((e) => e.type === "bankruptcy.statement_mode.set"); assert.ok(set, mode.events.map((e) => e.type).join(",")); assert.equal(set!.payload["mode"], "modified_ch12_13");
  // NTC_BK_PAYMENT_INSTRUCTIONS: informational, no collection language (the registry's own no-demand rule; the disclaimer up top)
  const n = await tool(j, loanId, "14.1", "notice.send", { template_code: NOTICE_CODES_32_10.bk_payment_instructions, loan_id: loanId, recipients, payload: { ...sample(NOTICE_CODES_32_10.bk_payment_instructions, "2026-11-04"), notice_date: "2026-11-04", chapter: "13", case_number_full: CASE_NO, account_last4: last4, property_address: PROPERTY, borrower_name: "Alex Borrower", represented: false, counsel_name: null, conduit: true, postpetition_amount_cents: "444625", prior_amount_cents: null, effective_due_date: "2026-12-01", form_410s1_filed_on: null, form_410s1_docket_no: null, shortfall_cents: null, shortfall_due_date: null } }, BK);
  const sent = n.events.find((e) => e.type === "notice.sent"); assert.ok(sent, n.events.map((e) => e.type).join(",")); assert.equal(sent!.payload["template"], NOTICE_CODES_32_10.bk_payment_instructions);
  const text = noticeText(sent!.payload["notice_id"]);
  assert.ok(text.includes("not an attempt to collect a debt from you personally")); assert.doesNotMatch(text, /you must pay|please remit|you owe|personally liable|failure to pay|immediate payment|pay now/i); assert.ok(text.includes("not a demand for payment"));
  await settle();
  const cards = await cardsOf(loanId);
  const notice = findCard(cards, "hardship.bk.notice"); assert.ok(notice, "NoticeCard hardship.bk.notice"); assert.equal(notice!.props["notice_code"], NOTICE_CODES_32_10.bk_payment_instructions); assert.doesNotMatch(String(notice!.props["plain_language"]), /you must pay|please remit|you owe|pay now/i);
  assert.ok(findCard(cards, "hardship.bk.statements"), "StatusCard hardship.bk.statements");
  const rec2 = await record(email, loanId);
  assert.equal((((rec2["loan"] as P)["hardship"] as P)["bankruptcy"] as P)["statement_mode"], "modified_ch12_13"); assert.equal((((rec2["loan"] as P)["hardship"] as P)["bankruptcy"] as P)["chapter"], "13");
});

test("32.10-T10: Given day 121 with no pending application and all state notices sent, then `NTC_SM_FC_REFERRAL_ADVICE` renders with the help-still-available paragraph and the reinstatement `ChoiceCard`.", { skip }, async () => {
  const { j, email, loanId, last4, recipients } = await servicedLoan({ at: MST("2026-09-02", "06:05"), first_unpaid_due: "2026-09-01", unpaid_months: 4 });
  await tick(MST("2026-12-31", "06:05"));   // day 121 from the Sep 1 due date
  const counters = (await events(loanId, "delinquency.counters.updated")).at(-1); assert.ok(counters, "13.1 counters"); assert.equal(counters!.payload["regx_days_delinquent"], 121); assert.equal(counters!.payload["earliest_unpaid_due_date"], "2026-09-01");
  assert.ok((await events(loanId, "foreclosure.gate.opened")).some((e) => e.payload["code"] === "REGX_1024_41F1_120_DAY_GATE"), "the 120-day gate opened on day 121");
  assert.equal((await entitiesOf("lossmit_applications", loanId)).length, 0, "no application pending");
  // AZ names no NTC_STATE_PREFC_* notice: every state pre-foreclosure notice is sent (vacuously); the referral gate check at step=refer does not name the 120-day gate
  const g = await tool(j, loanId, "13.1", "foreclosure.gates.evaluate", { loan_id: loanId, step: "refer" }, FC);
  assert.ok(!(g.output as { blocked_by: string[] }).blocked_by.includes("REGX_1024_41F1_120_DAY_GATE"), JSON.stringify((g.output as P)["blocked_by"]));
  const CASE = `fc-${loanId.slice(0, 8)}`;
  await referLoan(j, loanId, CASE, "2026-12-31", 121);
  const referral = (await events(loanId, "foreclosure.referral.sent")).at(-1)!; assert.equal(referral.payload["regx_day"], 121); assert.equal(referral.payload["principal_residence"], true);
  // the optional advice letter (13.3 outputs): what happened and that help remains available — a complete application ≥37 days before a sale stops it (REGX_1024_41G_DUAL_TRACK_GATE), reinstatement, payoff
  const rendered = await tool(j, loanId, "11.2", "notice.render", { template_code: NOTICE_CODES_32_10.fc_referral_advice, loan_id: loanId, recipients, payload: { ...sample(NOTICE_CODES_32_10.fc_referral_advice, "2026-12-31"), notice_date: "2026-12-31", referral_on: "2026-12-31", firm_name: "FAKE Foreclosure Firm LLP", firm_phone: "(800) 555-0177", fdcpa_debt_collector: false, account_last4: last4, property_address: PROPERTY } }, COLLECTIONS);
  const noticeId = String((rendered.output as P)["id"]);
  const sent = await tool(j, loanId, "11.2", "print.request", { notice_id: noticeId, loan_id: loanId, template: NOTICE_CODES_32_10.fc_referral_advice }, COLLECTIONS);
  assert.ok(sent.events.some((e) => e.type === "notice.sent" && e.payload["template"] === NOTICE_CODES_32_10.fc_referral_advice));
  const text = noticeText(noticeId);
  assert.ok(text.includes("This does not end your options") && text.includes("apply for mortgage assistance at any time"), "the help-still-available paragraph"); assert.ok(text.includes("reinstate the loan"));
  await settle();
  const cards = await cardsOf(loanId);
  const advice = findCard(cards, "hardship.fc.advice"); assert.ok(advice, "NoticeCard hardship.fc.advice"); assert.equal(advice!.props["notice_code"], NOTICE_CODES_32_10.fc_referral_advice); assert.ok(String(advice!.props["plain_language"]).includes("apply for mortgage assistance at any time"), "the card carries the notice's own help-still-available paragraph");
  const reinstate = findCard(cards, "hardship.fc.reinstate", "pending"); assert.ok(reinstate, "ChoiceCard hardship.fc.reinstate"); assert.equal(reinstate!.command_ref, "case.open"); assert.equal(((reinstate!.props["command_args_by_option"] as P)["send"] as P)["kind"], "rfi"); assert.deepEqual((reinstate!.props["options"] as P[]).map((o) => o["id"]), ["send", "not_now"]);
  const rec = await record(email, loanId);
  assert.ok((rec["needed_from_you"] as P[]).some((n) => n["card_instance_id"] === reinstate!.card_instance_id), "the reinstatement ask is the open item");
  assert.ok((rec["documents"] as P[]).some((d) => d["notice_code"] === NOTICE_CODES_32_10.fc_referral_advice), "Documents lists the advice letter");
});

test("32.10-T11: Given a `cease_communication` request on an FDCPA-covered loan, then outbound collection messages stop within the 11.4 window and the Thread confirms with `NTC_REGF_1006_6C_CEASE_ACK`; inbound remains open.", { skip }, async () => {
  assert.equal(classifyHardship("Please stop contacting me about this debt.").kind, "cease");
  const { j, email, partyId, loanId } = await servicedLoan({ at: MST("2026-10-20", "10:00"), first_unpaid_due: "2026-07-01", unpaid_months: 3, fdcpa_debt_collector: true, regx_days_delinquent_at_boarding: 61 });
  const { token } = await signIn(email);
  const r = await api("POST", "/v1/borrower/messages", { text: "Please stop contacting me about this debt.", subject: { loan_id: loanId } }, token);
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal((r.body["reply"] as P)["copy_key"], "hardship.cease.confirmed"); assert.equal(r.body["command"], "preference.set");
  await settle();
  // 11.4 rule 6: the written cease on the loan's fdcpa_status (§1006.6(c)) — the permanent gate armed at once (the "window" is the commit), the cadence suspended, the acknowledgment sent through the registry
  const cease = (await events(loanId, "fdcpa.cease.received")).at(-1); assert.ok(cease, "fdcpa.cease.received"); assert.equal(cease!.payload["written"], true); assert.equal(cease!.payload["on"], "2026-10-20");
  const gate = await timer(loanId, "REGF_1006_6C_CEASE_GATE"); assert.ok(gate, "REGF_1006_6C_CEASE_GATE armed"); assert.equal(gate.status, "armed");
  const status = (await entitiesOf("fdcpa_status", loanId)).at(-1); assert.ok(status); assert.equal(status!["cease_scope"], "written_full"); assert.equal(status!["debt_collector"], true);
  const ack = (await events(loanId, "notice.sent")).find((e) => e.payload["template"] === NOTICE_CODES_32_10.cease_ack); assert.ok(ack, "NTC_REGF_1006_6C_CEASE_ACK sent");
  const text = noticeText(ack!.payload["notice_id"]); assert.ok(text.includes("We will not contact you further to collect")); assert.ok(text.includes("You may still contact us about assistance options at any time"));
  // outbound collection messages stop: the very next outbound attempt is refused by the store's own cease record
  clock.set(MST("2026-10-21", "10:00"));
  const stopped = await refused(j, loanId, "11.3", "contact.log", { id: `ct-${loanId.slice(0, 8)}-out`, loan_id: loanId, mode: "human_voice", direction: "outbound", outcome: "no_answer", party_id: partyId, on: "2026-10-21", fdcpa_debt_collector: true, pre_dial_facts: { dial_at: clock.now(), time_zones: ["America/Phoenix"], line_type: "wireless", tcpa_voice_consent_active: true, counted_call_attempts_at: [], days_since_conversation: 999, days_until_sale: 9999, state: "AZ" } }, COMMS);
  assert.equal(stopped.status, 409, JSON.stringify(stopped.body)); assert.equal(stopped.body["code"], "REGF_1006_6C_CEASE_GATE");
  // the Thread confirms: the acknowledgment as a NoticeCard, the status in the borrower's words
  const cards = await cardsOf(loanId);
  const notice = findCard(cards, "hardship.cease.ack"); assert.ok(notice, "NoticeCard hardship.cease.ack"); assert.equal(notice!.props["notice_code"], NOTICE_CODES_32_10.cease_ack); assert.ok(String(notice!.props["plain_language"]).includes("We will not contact you further to collect"));
  assert.ok(findCard(cards, "hardship.cease.confirmed"), "StatusCard hardship.cease.confirmed");
  const msgs = await thread(email); assert.ok(msgs.some((m) => m["body_text"] === "{{copy:hardship.cease.confirmed}}"));
  const rec = await record(email, loanId); assert.equal((((rec["loan"] as P)["hardship"] as P)["cease"] as P)["received_on"], "2026-10-20");
  // inbound remains open: the borrower's next message is answered, and an inbound contact is logged without refusal
  const again = await api("POST", "/v1/borrower/messages", { text: "What options do I have to keep my home?", subject: { loan_id: loanId } }, (await signIn(email)).token);
  assert.equal(again.status, 200, JSON.stringify(again.body)); assert.ok((again.body["reply"] as P)["copy_key"]);
  const inbound = await tool(j, loanId, "11.3", "contact.log", { id: `ct-${loanId.slice(0, 8)}-in`, loan_id: loanId, mode: "chat", direction: "inbound", outcome: "conversation", party_id: partyId, on: "2026-10-21" }, COMMS);
  assert.ok(inbound.events.some((e) => e.type === "contact.inbound.received"));
  const h = await byLoan(loanId); assert.equal(h.cease?.scope, "written_full");
});
