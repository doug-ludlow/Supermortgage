// 32.3 Entry and the five-minute qualification
// spec/sections/32-borrower-experience/32-3-entry-and-the-five-minute-qualification.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// Every T-id drives the real runtime over HTTP: the borrower API (sign-in on each channel, cards resolved with their
// evidence, the direct commands, the FAKE Stripe / Truv webhooks) and the owning processes' own bus tools (20.3, 20.4,
// 21.x, 22.x, 23.x through the journey fixture), with the 32.3 flow of src/runtime/borrower/flows/3-entry.ts reacting to
// the committed events through the real Timer Engine and Notice Registry; then the tables, the events and the borrower
// read models are asserted. What the borrower SEES of these facts is asserted on the real components in
// apps/borrower/tests/cards/flow-3-entry.test.tsx. Four parties on one runtime: the journey's Alex/Blake (T3, T9, T19,
// T20), Jane — the refinance path card by card (T1, T2, T4–T6, T8, T11–T14, T16, T17, T21, T22, T24, T25), Kim — a second
// refinance whose E-SIGN stays pending at the LE (T7, T10, T18, T23), Casey — the preapproval on a TBD property (T26–T28,
// T30), Dana — the purchase with a contract (T29), Lee — a lead-stage party (T15). Skips without a database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { connect, reachable, type Db } from "../../infra/db/client.ts";
import { acquireJourneyLock, type TestLock } from "../../infra/db/test-lock.ts";
import { decodeEntityData } from "../../infra/db/entities.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock } from "../../kernel/events/index.ts";
import { Runtime } from "../../runtime/app.ts";
import { createApiServer, listen } from "../../runtime/server.ts";
import { createLogger } from "../../runtime/log.ts";
import { createBorrowerRouter, type BorrowerRouter } from "../../runtime/borrower/routes.ts";
import { FakeStripeIdentity } from "../../runtime/borrower/vendors/fake-stripe-identity.ts";
import { Journey, MST, EDT, MLO, OFFICER } from "../../runtime/borrower/fixtures/journey.ts";
import { FORBIDDEN_FIELDS } from "../../runtime/borrower/serialize.ts";
import { deliverLeByConsent, DECLARATIONS_LIST_HASH, CREDIT_AUTHORIZATION_HASH } from "../../runtime/borrower/flows/3-entry.ts";
import { esignVerificationToken } from "../../app/tools/section32-2.ts";
import { newDecisionFile } from "../application/ops-21-6.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import { plainDate } from "../../kernel/calendar/date.ts";

const DB_URL = process.env["TEST_DATABASE_URL"] ?? "postgresql://sm:sm@localhost/supermortgage_test";
const up = await reachable(DB_URL);
if (!up && process.env["REQUIRE_DB"]) throw new Error(`REQUIRE_DB set but ${DB_URL} is not reachable`);
const skip = up ? false : `no Postgres at ${DB_URL}`;
const TOKEN = "ops-" + randomUUID();
const R = randomUUID().slice(0, 8);
const clock = new FixedClock("2026-09-10T16:00:00.000Z");
const INTAKE = { kind: "agent" as const, id: "intake" }; const PRICING = { kind: "agent" as const, id: "pricing" }; const DISCLOSURE = { kind: "agent" as const, id: "disclosure" }; const VERIFICATION = { kind: "agent" as const, id: "verification" }; const UNDERWRITER = { kind: "agent" as const, id: "underwriter" };
const EMAIL_A = `alex-${R}@example.test`; const EMAIL_B = `blake-${R}@example.test`;
const phoneOf = (seed: string): string => `+1602555${(parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 6), 16) % 10000).toString().padStart(4, "0")}`;   // one phone per party per run: the OTP resolves a phone to one party
const JANE = { email: `jane-${R}@example.test`, phone: phoneOf(`jane-${R}`), name: "Jane Q. Public", tin_last4: "1111", dob: "1990-04-01" };
const KIM = { email: `kim-${R}@example.test`, name: "Kim Sato", tin_last4: "2222", dob: "1984-02-14" };
const CASEY = { email: `casey-${R}@example.test`, phone: phoneOf(`casey-${R}`), name: "Casey Rivera", tin_last4: "3333", dob: "1992-08-30" };
const DANA = { email: `dana-${R}@example.test`, name: "Dana Okafor", tin_last4: "4444", dob: "1988-11-02" };
const LEE = { email: `lee-${R}@example.test` };
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

let journeyLock: TestLock | undefined;
let db: Db; let runtime: Runtime; let router: BorrowerRouter; let base = ""; let close: () => Promise<void> = async () => undefined; let partnerPartyId = "";
let journey: Journey; let partyA = ""; let partyB = ""; let duSubmissionId = "";
// per-party state the T-ids hand forward (the tests run in T order)
const jane = { appId: "", partyId: "", token: "", sessionId: "", leadId: "", quoteId: "", leId: "", lockId: "", verificationId: "", incomeCardId: "" };
const kim = { appId: "", partyId: "", token: "", leadId: "", leId: "", consentId: "", reportId: "" };
const casey = { appId: "", partyId: "", token: "", leadId: "", quoteId: "", casefileId: "", prequalId: "", connectCardId: "", incomeCardId: "" };
const dana = { appId: "", partyId: "", token: "", leadId: "" };

test.before(async () => {
  if (skip) return;
  journeyLock = await acquireJourneyLock(DB_URL);   // serialize journey-driving files on the shared test database
  execFileSync(fileURLToPath(new URL("../../../db/migrate.sh", import.meta.url)), { env: { ...process.env, DATABASE_URL: DB_URL }, stdio: "pipe" });
  db = connect(DB_URL);
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock });
  const logger = createLogger("json", (line) => { if (process.env["FLOW_DEBUG"] && /flow|ERROR|error/.test(line)) process.stderr.write(line + "\n"); });
  router = createBorrowerRouter({ runtime, logger, environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost"], urlSecret: "test-secret" });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger, console: false, borrowerRouter: router });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => { router.hub.close(); server.closeAllConnections?.(); server.close(() => db.end().then(() => resolve())); });
  const partner = await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id) VALUES ('servicer', $1, '123456789', '1000123') RETURNING id`, [`Partner Bank ${R}`]);
  partnerPartyId = partner[0]!.id;
  // the journey (Alex/Blake): the pricing rows, the refi-trigger lead, the application, the interview (TRID Oct 5 10:41 MST), the LE e-signed Oct 5, credit for both, DU findings Tue Oct 6 14:00 MST interpreted at 14:12 (T20)
  journey = new Journey({ runtime, db, base, token: TOKEN, clock, borrowerEmail: EMAIL_A, coBorrowerEmail: EMAIL_B, partnerPartyId });
  await journey.seedBook(); await journey.openApplication();
  partyA = (await signIn(EMAIL_A)).party_id; partyB = (await signIn(EMAIL_B)).party_id;
  await journey.interview(); await journey.quoteAndLe(); await journey.orderCredit(); await settle();
  duSubmissionId = (await journey.duSubmitAndInterpret({ findings_at: MST("2026-10-06", "14:00"), interpreted_at: MST("2026-10-06", "14:12") })).submission_id; await settle();
});
test.after(async () => { if (!skip) { await close(); await journeyLock?.release(); } });

// ---------------------------------------------------------------- helpers
type Reply = { status: number; body: Record<string, unknown> };
async function api(method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}): Promise<Reply> {
  const r = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)) } : {}) });
  const text = await r.text(); return { status: r.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}
async function signIn(email: string, channel: "email" | "sms" = "email", destination = email): Promise<{ token: string; party_id: string; session_id: string; level: string }> {
  const req = await api("POST", "/v1/borrower/auth/otp", { action: "request", channel, destination });
  const ver = await api("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: req.body["challenge_id"], code: req.body["fake_code"] });
  assert.equal(ver.status, 200, JSON.stringify(ver.body));
  return { token: ver.body["token"] as string, party_id: (ver.body["party"] as { party_id: string }).party_id, session_id: (ver.body["session"] as { session_id: string }).session_id, level: String(ver.body["level"]) };
}
const settle = () => router.flows!.settle();
type CardRow = { card_instance_id: string; party_id: string; kind: string; status: string; copy_key: string; props: Record<string, unknown>; evidence: Record<string, unknown> | null; command_ref: string | null; created_at: string; resolved_at: string | null };
const cardsOf = async (appId: string, partyId?: string): Promise<CardRow[]> => { await settle(); return db.query<CardRow & Record<string, unknown>>(`SELECT card_instance_id, party_id, kind, status, copy_key, props, evidence, command_ref, created_at, resolved_at FROM card_instances WHERE subject_application_id = $1 AND ($2::uuid IS NULL OR party_id = $2) ORDER BY created_at, card_instance_id`, [appId, partyId ?? null]); };
const pendingCard = async (appId: string, partyId: string, copyKey: string): Promise<CardRow> => { const c = (await cardsOf(appId, partyId)).filter((x) => x.copy_key === copyKey && x.status === "pending").at(-1); assert.ok(c, `pending ${copyKey} card for ${partyId}`); return c; };
const events = async (appId: string, type?: string) => db.query<{ type: string; sequence: string; occurred_at: string; payload: Record<string, unknown> }>(`SELECT type, sequence::text AS sequence, occurred_at, payload FROM loan_events WHERE application_id = $1 AND ($2::text IS NULL OR type = $2) ORDER BY sequence`, [appId, type ?? null]);
const entity = async (kind: string, id: string): Promise<Record<string, unknown> | null> => { const rows = await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = $1 AND id = $2`, [kind, id]); return rows[0] ? decodeEntityData(rows[0].data) : null; };
const timer = async (appId: string, code: string) => (await db.query<{ status: string; due_at: string | null; due_date: string | null; satisfied_at: string | null }>(`SELECT status::text AS status, due_at, due_date::text AS due_date, satisfied_at FROM timers WHERE application_id = $1 AND code = $2 ORDER BY armed_at DESC LIMIT 1`, [appId, code]))[0];
const resolve = async (token: string, cardId: string, body: Record<string, unknown>): Promise<Reply> => { const r = await api("POST", `/v1/borrower/cards/${cardId}/resolve`, body, token); await settle(); return r; };
const command = async (token: string, name: string, body: Record<string, unknown>): Promise<Reply> => { const r = await api("POST", `/v1/borrower/commands/${name}`, body, token); await settle(); return r; };
const record = async (token: string, subject: string): Promise<Record<string, unknown>> => { await settle(); const r = await api("GET", `/v1/borrower/record?subject=${subject}`, undefined, token); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 600)); return r.body; };
const thread = async (token: string): Promise<{ messages: Record<string, unknown>[]; pinned: Record<string, unknown> | null }> => { await settle(); const r = await api("GET", "/v1/borrower/thread?limit=500", undefined, token); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300)); return { messages: r.body["messages"] as Record<string, unknown>[], pinned: (r.body["pinned_card"] as Record<string, unknown> | null) ?? null }; };
const tool = (scope: { app?: string }, process: string, name: string, input: Record<string, unknown>, actor: Record<string, unknown> = INTAKE) => journey.tool(scope, process, name, input, actor as never);
/** The walk for rendered content: identifier fields (`*_id`, `id`, `*_key`, `*_ref`, `*_hash`, `stamp`) are opaque handles — a 23.2 condition id embeds the DU message code it was materialized from, and 32.5's needs card stamps the condition set it was built from — never text the borrower reads. */
const walkContent = (v: unknown, strings: string[]): void => { if (Array.isArray(v)) v.forEach((x) => walkContent(x, strings)); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) { if (/(^|_)(id|key|ref|hash|stamp)$/.test(k)) continue; walkContent(x, strings); } else if (typeof v === "string") strings.push(v); };
/** The serializer contract walk: every key an API response names, except inside `props` — the card props the serializer declares opaque (UI option lists such as a DemographicsCard's `ethnicity` choices carry no answer). */
const walkShape = (v: unknown, keys: Set<string>): void => { if (Array.isArray(v)) v.forEach((x) => walkShape(x, keys)); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) { keys.add(k); if (k !== "props") walkShape(x, keys); } };
const walk = (v: unknown, keys: Set<string>, strings: string[]): void => { if (Array.isArray(v)) v.forEach((x) => walk(x, keys, strings)); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) { keys.add(k); walk(x, keys, strings); } else if (typeof v === "string") strings.push(v); };
const fieldsEvidence = (card: CardRow, edits: Record<string, string> = {}, at = clock.now()) => ({ evidence: { fields: (card.props["fields"] as { path: string; value: string; source: string }[]).map((f) => ({ path: f.path, value_confirmed: edits[f.path] ?? f.value, source: f.source, confirmed_at: at })), edited: Object.keys(edits).length > 0 } });
const lead = async (id: string): Promise<Record<string, unknown>> => { const l = await entity("leads", id); assert.ok(l, `lead ${id}`); return l; };
const tridItem = (l: Record<string, unknown>, k: string): { present: boolean; source: string | null; at: string | null } => (l["trid_items"] as Record<string, { present: boolean; source: string | null; at: string | null }>)[k]!;
const isoEt = (date: string, hhmm: string): string => EDT(date, hhmm);
/** Sessions idle out after 30 minutes (01 §5): a fresh sign-in, stepped up to L2 (SSN last four + DOB) where the party has an application_borrowers row. */
async function fresh(b: { email: string; tin_last4: string; dob: string }): Promise<string> { const s = await signIn(b.email); const l2 = await api("POST", "/v1/borrower/auth/l2", { ssn_last4: b.tin_last4, date_of_birth: b.dob }, s.token); assert.equal(l2.status, 200, JSON.stringify(l2.body)); await settle(); return s.token; }
/** A borrower's own application on the shared runtime (organic channel: the goal ChoiceCard is the flow's, unlike a refi-trigger lead). */
async function openBorrower(b: { email: string; name: string; tin_last4: string; dob: string }, transaction_type: "purchase" | "limited_cash_out", property: Record<string, unknown> | null): Promise<string> {
  const r = await api("POST", "/v1/applications", { actor: INTAKE, application: { partner_party_id: partnerPartyId, channel: "organic", transaction_type, occupancy: "primary", intake_channel: "web", interview_language: "en-US", borrowers: [{ legal_name: b.name, borrower_role: "borrower", tin_last4: b.tin_last4, date_of_birth: b.dob, contact: { email: b.email } }], property } }, TOKEN);
  assert.equal(r.status, 200, JSON.stringify(r.body)); return (r.body["application"] as { id: string }).id;
}
/** E3 for an organic lead: the goal ChoiceCard the session hook sent, resolved → application.setGoal → application.received (Reg B). */
async function setGoal(appId: string, partyId: string, token: string, option: "buy" | "lower_rate" | "cash_out"): Promise<void> {
  const goal = await pendingCard(appId, partyId, "entry.goal.question");
  const r = await resolve(token, goal.card_instance_id, { option_id: option, evidence: { option_id: option, tapped_at: clock.now() } });
  assert.equal(r.status, 201, JSON.stringify(r.body)); assert.ok((r.body["events"] as string[]).includes("application.received"), JSON.stringify(r.body["events"]));
}
/** The journey's private H-24 render input, re-keyed for another application. */
function leRender(appId: string, over: Record<string, unknown>): Record<string, unknown> {
  const base = (journey as unknown as { LE_RENDER(): Record<string, unknown> }).LE_RENDER();
  // the wire form (decimal-string cents, ISO dates) revived the way POST /v1/applications/{id}/disclosures/le does before the bridge
  const revive = (v: unknown): unknown => (Array.isArray(v) ? v.map(revive) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, k.endsWith("_cents") && (typeof x === "string" || typeof x === "number") && x !== "" ? BigInt(x) : revive(x)])) : v);
  const r = revive({ ...base, application_id: appId, disclosure_id: `LE-${appId.slice(0, 8)}`, ...over }) as Record<string, unknown>;
  return { ...r, as_of: plainDate(String(r["as_of"])), fees: ((r["fees"] as Record<string, unknown>[] | undefined) ?? []).map((f) => ({ ...f, estimated_at: plainDate(String(f["estimated_at"])) })) };
}
const QUOTE_INPUTS = (loan: string, value: string, transaction_type: "limited_cash_out" | "purchase", purchase_price: string | null = null) => ({ product_code: "FRM30", term_months: 360, amortization: "fixed", transaction_type, occupancy: "primary", property_type: "sfr", units: 1, loan_amount_cents: loan, value_cents: value, purchase_price_cents: purchase_price, representative_score: 742, score_model: "classic_fico", score_source: "tri_merge_2026-10-20", borrower_score_models: ["classic_fico"],
  state: "AZ", county: "Maricopa", county_limit_cents: "83275000", subordinate_financing_cents: "0", mi_option: "none", homeready: false, homeready_evaluation: null, first_time_homebuyer: transaction_type === "purchase", fthb_ami_waiver: false, dts_waiver: false, very_low_income: false, lock_period_days: 45, expected_purchase_ready_date: "2026-12-01", escrowed: true, valuation_method: "hybrid", borrower_pays_third_party_costs: false,
  taxes_annual_cents: "420000", insurance_annual_cents: "150000", mi_annual_rate_pct: null, assumed_disbursement_date: "2026-12-01", first_payment_date: "2027-02-01" });
const grid = (rows: [string, string][]) => rows.map(([r, p]) => ({ product_code: "FRM30", term_months: 360, note_rate_pct: r, lock_period_days: 45, price: p }));
const PRICES = grid([["6.375", "101.875"], ["6.250", "101.375"], ["6.125", "100.875"], ["6.000", "100.375"], ["5.875", "99.750"]]);
async function publishSheet(id: string, published_at: string, expires_at: string, prices = PRICES): Promise<void> { await tool({}, "20.4", "publishRateSheet", { rate_sheet_id: id, partner_id: "partner-1", source: "pe_whole_loan_api", published_at, expires_at, prices }, PRICING); }

test("32.3-T1: Given a new web session, when the first assistant message renders, then it contains the automation disclosure and `lead.disclosure.delivered` is logged before any other assistant content; same for voice (spoken) and SMS (first outbound).", { skip }, async () => {
  jane.appId = await openBorrower(JANE, "limited_cash_out", { address_line1: "14 Elm St", city: "Phoenix", state: "AZ", postal_code: "85018", county: "Maricopa", property_type: "sfr", units: 1 });
  await db.query(`UPDATE application_properties SET estimated_value_cents = 55000000 WHERE application_id = $1`, [jane.appId]);   // DELTA-03: the FAKE AVM the R7 card shows
  clock.set(isoEt("2026-10-19", "09:00"));
  // web: the OTP sign-in opens the session; the hook runs before the response returns
  const s = await signIn(JANE.email); jane.token = s.token; jane.partyId = s.party_id; jane.sessionId = s.session_id; jane.leadId = jane.appId;
  await settle();
  const t = await thread(jane.token);
  const assistant = t.messages.filter((m) => m["sender"] !== "borrower");
  assert.ok(assistant.length >= 1); assert.equal(assistant[0]!["body_text"], "{{copy:entry.disclosure.first}}"); assert.equal(assistant[0]!["automation_marker"], true); assert.equal(assistant[0]!["channel"], "app");
  const delivered = await events(jane.appId, "lead.disclosure.delivered"); assert.equal(delivered.length, 1, "the disclosure is logged once for the first web session");
  assert.ok(delivered[0]!.occurred_at <= String(assistant[1]?.["at"] ?? "9999"), "logged before any other assistant content");
  assert.ok((await events(jane.appId, "lead.created")).length === 1 && (await events(jane.appId, "lead.interaction.started")).length === 1 && (await events(jane.appId, "lead.authenticated")).length === 1, "E1/E4: lead.created, the interaction, lead.authenticated{L1}");
  // E3: the goal ChoiceCard is the first ask — nothing else rendered before the disclosure
  const goalMsg = t.messages.find((m) => (m["card"] as { copy_key?: string } | null)?.copy_key === "entry.goal.question"); assert.ok(goalMsg, "the goal ChoiceCard"); assert.ok(String(goalMsg!["at"]) >= String(assistant[0]!["at"]));
  await setGoal(jane.appId, jane.partyId, jane.token, "lower_rate");
  // voice: the in-app call — the disclosure is the first spoken line, re-logged on the voice interaction
  clock.set(isoEt("2026-10-19", "09:05"));
  const v = await api("POST", "/v1/borrower/voice/session", { application_id: jane.appId }, jane.token); assert.equal(v.status, 200, JSON.stringify(v.body)); assert.equal(v.body["vendor"], "FAKE");
  const first = v.body["first_message"] as Record<string, unknown>; assert.equal(first["body_text"], "{{copy:entry.disclosure.first}}"); assert.equal(first["voice_turn"], true); assert.equal(first["channel"], "voice"); assert.equal(first["automation_marker"], true);
  assert.equal((await events(jane.appId, "lead.disclosure.delivered")).length, 2, "re-logged on the voice interaction");
  // SMS: a code texted to Jane's phone opens an SMS session — the first outbound on that channel is the disclosure
  await db.query(`UPDATE parties SET contact = coalesce(contact, '{}'::jsonb) || $2::jsonb WHERE id = $1`, [jane.partyId, JSON.stringify({ phones: [JANE.phone] })]);
  clock.set(isoEt("2026-10-19", "09:06"));
  const sms = await signIn(JANE.email, "sms", JANE.phone); assert.equal(sms.party_id, jane.partyId, "the phone resolves to the same party");
  const t2 = await thread(jane.token);
  const outboundSms = t2.messages.filter((m) => m["channel"] === "sms" && m["sender"] !== "borrower");
  assert.ok(outboundSms.length >= 1); assert.equal(outboundSms[0]!["body_text"], "{{copy:entry.disclosure.first}}");
  assert.equal((await events(jane.appId, "lead.disclosure.delivered")).length, 3);
  assert.ok((await events(jane.appId, "consent.granted")).some((e) => e.payload["kind"] === "ai_disclosure_ack"), "20.3 logs the acknowledgment as consent.granted{kind=ai_disclosure_ack} (consents.kind=ai_disclosure_ack)");
});

test("32.3-T2: Given the borrower types \"are you a real person?\", then the reply is the 20.3 T11 script and a second `lead.disclosure.delivered` row exists.", { skip }, async () => {
  clock.set(isoEt("2026-10-19", "09:08"));
  const before = (await events(jane.appId, "lead.disclosure.delivered")).length;
  const r = await api("POST", "/v1/borrower/messages", { text: "are you a real person?", channel: "app" }, jane.token); assert.equal(r.status, 200, JSON.stringify(r.body));
  const reply = r.body["reply"] as Record<string, unknown>;
  assert.equal(reply["copy_key"], "entry.disclosure.real_person");
  assert.match(String(reply["body_text"]), /^No — I'm Partner Bank .*automated assistant, operated by Supermortgage\. I'm an AI, not a person\./, "20.3's own script (areYouHumanAnswer)");
  assert.equal(r.body["command_executed"], false, "not the human path: no human.transfer.requested");
  const after = await events(jane.appId, "lead.disclosure.delivered"); assert.equal(after.length, before + 1, "the disclosure re-logged (reason direct_question)"); assert.equal(after.at(-1)!.payload["reason"], "direct_question");
  assert.equal((await events(jane.appId, "human.transfer.requested")).length, 0);
  const t = await thread(jane.token); const line = t.messages.find((m) => m["body_text"] === String(reply["body_text"])); assert.ok(line); assert.equal(line!["sender"], "agent");
});

test("32.3-T3: Given `sessions.level = L1`, when the client requests `borrower_record` for an application with personal terms, then `numbers` is omitted and cards requiring L2+ are not created.", { skip }, async () => {
  // Alex at L1 on the journey's application: the LE (le_v1) exists — personal terms
  const a = await signIn(EMAIL_A); assert.equal(a.level, "L1");
  const rec = await record(a.token, journey.appId);
  assert.equal("numbers" in rec, false, "numbers omitted at L1"); assert.equal(typeof (rec["status"] as { badge: string }).badge, "string", "the status still renders at L1");
  assert.equal((await cardsOf(journey.appId, partyA)).filter((c) => c.props["personal_terms"] === true).length, 0, "no personal-terms card exists for an L1-only party");
  // the same session stepped up to L2 (SSN last four + DOB): the numbers render, from the LE
  const l2 = await api("POST", "/v1/borrower/auth/l2", { ssn_last4: "6789", date_of_birth: "1985-06-15" }, a.token); assert.equal(l2.status, 200, JSON.stringify(l2.body));
  const rec2 = await record(a.token, journey.appId); const numbers = rec2["numbers"] as Record<string, unknown>; assert.ok(numbers); assert.equal(numbers["figures_source"], "le_v1"); assert.equal(numbers["note_rate"], "6.125");
});

test("32.3-T4: Given L1 only, when `credit.authorize{hard_pull}` is called, then the API returns `{gate: SM_IDENTITY_IAL2_GATE}` and no `credit_authorizations` row is written.", { skip }, async () => {
  clock.set(isoEt("2026-10-19", "09:10"));
  assert.equal((await db.query<{ level: string }>(`SELECT level FROM sessions WHERE session_id = $1`, [jane.sessionId]))[0]!.level, "L1");
  const card = await pendingCard(jane.appId, jane.partyId, "consent.credit.title"); assert.equal(card.command_ref, "credit.authorize"); assert.equal(card.props["requires_level"], "L3");
  const r = await resolve(jane.token, card.card_instance_id, { evidence: { affirmation_method: "checkbox_with_text", typed_name: JANE.name, disclosure_version_shown: card.props["disclosure_version_id"] } });
  assert.equal(r.status, 403); assert.equal(r.body["code"], "LEVEL_REQUIRED"); assert.equal(r.body["gate"], "SM_IDENTITY_IAL2_GATE"); assert.equal(r.body["copy_key"], "gate.identity.verify_first"); assert.deepEqual(Object.keys(r.body).sort(), ["code", "copy_key", "gate"]);
  const direct = await command(jane.token, "credit.authorize", { kind: "hard_pull", lead_id: jane.leadId, text_hash: CREDIT_AUTHORIZATION_HASH }); assert.equal(direct.status, 403); assert.equal(direct.body["gate"], "SM_IDENTITY_IAL2_GATE");
  assert.equal((await events(jane.appId, "credit.authorization.captured")).length, 0); assert.deepEqual((await lead(jane.leadId))["credit_authorizations"], []);
  assert.equal((await db.query(`SELECT 1 FROM consents WHERE party_id = $1 AND kind = 'credit_authorization'`, [jane.partyId])).length, 0);
  assert.equal(((await cardsOf(jane.appId, jane.partyId)).find((c) => c.card_instance_id === card.card_instance_id))!.status, "pending", "the card stays pending");
});

test("32.3-T5: Given Stripe extracted \"Jane Q. Public, 1990-04-01, 14 Elm St\", when the borrower taps Edit on the address and confirms \"22 Elm St\", then `application_borrowers.current_address = \"22 Elm St\"` with `source = borrower`, and name/DOB carry `source = stripe_identity`, all with `confirmed_at`.", { skip }, async () => {
  clock.set(isoEt("2026-10-19", "09:15"));
  const vs = await api("POST", "/v1/borrower/identity/stripe/session", { application_id: jane.appId }, jane.token); assert.equal(vs.status, 200, JSON.stringify(vs.body));
  (router.stripe as FakeStripeIdentity).complete(vs.body["vendor_session_id"] as string, clock.now(), { legal_name: "Jane Q. Public", date_of_birth: "1990-04-01", address: "14 Elm St" });
  const hook = await api("POST", "/v1/webhooks/stripe", { id: `evt-${R}`, type: "identity.verification_session.verified", data: { object: { id: vs.body["vendor_session_id"], status: "verified" } } }, undefined, { "stripe-signature": "FAKE" });
  assert.equal(hook.status, 200, JSON.stringify(hook.body)); assert.equal(hook.body["outcome"], "verified"); assert.equal(hook.body["level"], "L3");
  await settle();
  assert.equal((await db.query<{ level: string }>(`SELECT level FROM sessions WHERE session_id = $1`, [jane.sessionId]))[0]!.level, "L3", "every live session of the party rose to L3");
  const card = await pendingCard(jane.appId, jane.partyId, "identity.confirm.title");
  const fields = card.props["fields"] as { path: string; value: string; source: string }[];
  assert.deepEqual(fields.map((f) => [f.path, f.value, f.source]), [["legal_name", "Jane Q. Public", "stripe_identity"], ["date_of_birth", "1990-04-01", "stripe_identity"], ["current_address", "14 Elm St", "stripe_identity"]]);
  clock.set(isoEt("2026-10-19", "09:20"));
  const r = await resolve(jane.token, card.card_instance_id, fieldsEvidence(card, { current_address: "22 Elm St" })); assert.equal(r.status, 201, JSON.stringify(r.body));
  const ab = (await db.query<{ prefill: Record<string, { value: string; source: string; confirmed_at: string | null }>; legal_name: string; date_of_birth: string }>(`SELECT prefill, legal_name, date_of_birth::text AS date_of_birth FROM application_borrowers WHERE application_id = $1`, [jane.appId]))[0]!;
  assert.equal(ab.prefill["current_address"]!.value, "22 Elm St"); assert.equal(ab.prefill["current_address"]!.source, "borrower"); assert.equal(ab.prefill["current_address"]!.confirmed_at, isoEt("2026-10-19", "09:20"));
  assert.equal(ab.prefill["legal_name"]!.source, "stripe_identity"); assert.equal(ab.prefill["legal_name"]!.confirmed_at, isoEt("2026-10-19", "09:20")); assert.equal(ab.prefill["date_of_birth"]!.source, "stripe_identity"); assert.equal(ab.prefill["date_of_birth"]!.confirmed_at, isoEt("2026-10-19", "09:20"));
  assert.equal(ab.legal_name, "Jane Q. Public"); assert.equal(ab.date_of_birth, "1990-04-01");
  // 21.1 rule 1: the extracted name counts as submitted only now; the lead's trid item follows
  const intake = (await entity("applications", jane.appId))!; assert.equal((intake["six_items"] as Record<string, { source: string }>)["name"]!.source, "borrower_confirmed_prefill");
  assert.equal(tridItem(await lead(jane.leadId), "name").present, true);
  assert.equal((await events(jane.appId, "application.trid_received")).length, 0);
});

test("32.3-T6: Given an in-app voice call, when the borrower says \"yes, e-delivery is fine\", then no `consents{kind=esign}` row becomes `active`; the assistant sends the E-SIGN invitation link (20.3 T8).", { skip }, async () => {
  clock.set(isoEt("2026-10-19", "09:22"));
  const esign = await pendingCard(jane.appId, jane.partyId, "consent.esign.title");
  await api("POST", "/v1/borrower/voice/session", { application_id: jane.appId }, jane.token);
  const r = await api("POST", "/v1/borrower/messages", { text: "yes, e-delivery is fine", channel: "voice" }, jane.token); assert.equal(r.status, 200, JSON.stringify(r.body));
  const reply = r.body["reply"] as Record<string, unknown>;
  assert.equal(r.body["command_executed"], false); assert.equal(reply["copy_key"], "consent.esign.title"); assert.equal(reply["card_instance_id"], esign.card_instance_id);
  const link = reply["deep_link"] as { token: string; path: string } | null; assert.ok(link && link.path === `/d/${link.token}`, "the E-SIGN invitation link (the card's deep link)");
  assert.equal(reply["channel"], "voice"); assert.equal(reply["voice_turn"], true);
  assert.equal((await db.query(`SELECT 1 FROM consents WHERE party_id = $1 AND kind = 'esign'`, [jane.partyId])).length, 0, "no consents row at all from a spoken yes");
  assert.equal(((await cardsOf(jane.appId, jane.partyId)).find((c) => c.card_instance_id === esign.card_instance_id))!.status, "pending");
  // a voice resolve of the ConsentCard itself is refused too (01 §3.5)
  const voiceTap = await resolve(jane.token, esign.card_instance_id, { channel: "voice", evidence: { affirmation_method: "voice" } }); assert.equal(voiceTap.status, 409); assert.equal(voiceTap.body["code"], "CARD_VOICE_CONSENT");
  assert.equal((await db.query(`SELECT 1 FROM consents WHERE party_id = $1 AND kind = 'esign' AND status = 'active'`, [jane.partyId])).length, 0);
});

test("32.3-T7: Given `consents{esign}` is `consented_pending_verification` when the LE is approved, then `disclosure.le.mailed` fires, the Record shows *Mailed*, and no `DocumentCard` for the LE is created until `active` and a re-delivery is made.", { skip }, async () => {
  // Kim: a second refinance; the E-SIGN card is affirmed (pending verification) and the six items arrive through 21.1's own tools
  kim.appId = await openBorrower(KIM, "limited_cash_out", { address_line1: "41 Palm Dr", city: "Phoenix", state: "AZ", postal_code: "85018", county: "Maricopa", property_type: "sfr", units: 1 });
  await db.query(`UPDATE application_properties SET estimated_value_cents = 52000000 WHERE application_id = $1`, [kim.appId]);
  clock.set(isoEt("2026-10-19", "09:30"));
  const s = await signIn(KIM.email); kim.token = s.token; kim.partyId = s.party_id; kim.leadId = kim.appId;
  await setGoal(kim.appId, kim.partyId, kim.token, "lower_rate");
  const esign = await pendingCard(kim.appId, kim.partyId, "consent.esign.title");
  const r = await resolve(kim.token, esign.card_instance_id, { evidence: { affirmation_method: "checkbox_with_text", typed_name: KIM.name, checkbox: true, disclosure_version_shown: esign.props["disclosure_version_id"] } }); assert.equal(r.status, 201, JSON.stringify(r.body));
  kim.consentId = String((r.body["result"] as Record<string, unknown>)["consent_id"]);
  const row = (await db.query<{ status: string; verified: boolean; scope: string[] }>(`SELECT status, verified, scope FROM consents WHERE id = $1`, [kim.consentId]))[0]!;
  assert.equal(row.status, "pending_verification"); assert.equal(row.verified, false); assert.ok(row.scope.includes("disclosures"));
  assert.ok((await events(kim.appId, "consent.esign.pending")).length === 1, "the verification e-mail went out (NTC_ESIGN_VERIFICATION_EMAIL, FAKE mailer)");
  // the six items through 21.1 (the interview record the goal card opened), TRID Mon Oct 19 09:40 ET
  const scope = { app: kim.appId };
  await tool(scope, "21.1", "confirmPrefill", { op: "offer", item: "name", value: KIM.name }); await tool(scope, "21.1", "confirmPrefill", { item: "name" });
  await tool(scope, "21.1", "captureField", { field: "ssn", value: "123-45-2222", borrower_id: "B1" });
  await tool(scope, "21.1", "confirmPrefill", { op: "offer", item: "property_address", value: "41 Palm Dr, Phoenix, AZ 85018" }); await tool(scope, "21.1", "confirmPrefill", { item: "property_address" });
  await tool(scope, "21.1", "captureField", { field: "income", value: "900000", borrower_id: "B1" });
  await tool(scope, "21.1", "captureField", { field: "property_value_estimate", value: "52000000" });
  clock.set(isoEt("2026-10-19", "09:40"));
  const sixth = await tool(scope, "21.1", "captureField", { field: "loan_amount_sought", value: "40000000" }); assert.equal(sixth.output["trid_emitted"], true);
  await settle();
  // the LE approved the same afternoon: 21.2's guard — no active E-SIGN for the disclosures class → mail with the print vendor's proof
  clock.set(isoEt("2026-10-19", "16:00"));
  const le = await deliverLeByConsent(runtime, kim.appId, { render: leRender(kim.appId, { as_of: "2026-10-19", loan_cents: "40000000", applicants: [KIM.name], property_address: "41 Palm Dr, Phoenix, AZ 85018", estimated_value_cents: "52000000" }) as never, mlo: { review_id: `MR-LE-K-${R}`, nmlsr_id: "987654" }, actor: MLO });
  kim.leId = le.result.disclosure_id; kim.token = await fresh(KIM);
  assert.equal(le.channel, "mail"); assert.equal(le.result.status, "mailed"); assert.deepEqual(le.consent_ids, []);
  await settle();
  const mailed = await events(kim.appId, "disclosure.le.mailed"); assert.equal(mailed.length, 1); assert.match(String(mailed[0]!.payload["mailing_proof_id"]), /^PMV-FAKE-/);
  assert.equal((await events(kim.appId, "disclosure.le.delivered")).length, 0, "no electronic delivery");
  const rec = await record(kim.token, kim.appId); const doc = (rec["documents"] as Record<string, unknown>[]).find((d) => d["disclosure_id"] === kim.leId);
  assert.ok(doc, "the LE in Documents"); assert.equal(doc!["status"], "mailed"); assert.equal(doc!["channel"], "mail"); assert.ok(doc!["mailed_at"]); assert.equal(doc!["received_at"], null);
  const cards = await cardsOf(kim.appId, kim.partyId);
  assert.equal(cards.filter((c) => c.kind === "DocumentCard" && (c.props["disclosure_id"] === kim.leId || c.props["copy_of_disclosure_id"] === kim.leId)).length, 0, "no DocumentCard for a mailed LE while E-SIGN is pending");
  assert.ok(cards.some((c) => c.kind === "StatusCard" && c.copy_key === "le.mailed"), "the Mailed StatusCard");
  // the demonstration test completes (the e-mailed link + PDF code): active → the electronic copy is re-delivered as a DocumentCard (32.4-T1 / DELTA-08); the mailing stays the delivery of record
  clock.set(isoEt("2026-10-19", "16:20"));
  const verify = await command(kim.token, "consent.capture", { op: "verify", consent_id: kim.consentId, token: esignVerificationToken(kim.consentId), scope: ["disclosures", "notices"] }); assert.equal(verify.status, 200, JSON.stringify(verify.body));
  assert.equal((await db.query<{ status: string }>(`SELECT status FROM consents WHERE id = $1`, [kim.consentId]))[0]!.status, "active");
  assert.equal((await events(kim.appId, "consent.esign.active")).length, 1);
  const after = await cardsOf(kim.appId, kim.partyId);
  const copy = after.find((c) => c.kind === "DocumentCard" && c.props["copy_of_disclosure_id"] === kim.leId); assert.ok(copy, "the LE DocumentCard now exists (the electronic re-delivery)"); assert.equal(copy!.status, "pending"); assert.equal(copy!.props["electronic_copy"], true);
  const rec2 = await record(kim.token, kim.appId); const docs2 = (rec2["documents"] as Record<string, unknown>[]).filter((d) => d["disclosure_id"] === kim.leId || d["copy_of_disclosure_id"] === kim.leId);
  assert.ok(docs2.some((d) => d["status"] === "mailed" && d["channel"] === "mail"), "the mailing evidence stays"); assert.ok(docs2.some((d) => d["copy_of_disclosure_id"] === kim.leId && d["channel"] === "esign_portal"), "the electronic copy beside it");
});

test("32.3-T8: Given the borrower confirms the property address, then `trid_items.property_address.present = true` and `application.trid_received` has not fired.", { skip }, async () => {
  clock.set(isoEt("2026-10-19", "09:25"));
  const before = await lead(jane.leadId); assert.equal(tridItem(before, "property_address").present, false);
  const card = await pendingCard(jane.appId, jane.partyId, "refi.home.confirm");
  const fields = card.props["fields"] as { path: string; value: string; source: string }[];
  assert.equal(fields.find((f) => f.path === "property_address")!.value, "22 Elm St", "the address Jane confirmed (edited) is the candidate property"); assert.equal(fields.find((f) => f.path === "property_address")!.source, "borrower");
  const r = await resolve(jane.token, card.card_instance_id, fieldsEvidence(card)); assert.equal(r.status, 201, JSON.stringify(r.body));
  const after = await lead(jane.leadId); const item = tridItem(after, "property_address");
  assert.equal(item.present, true); assert.equal(item.source, "consumer_stated"); assert.equal(item.at, isoEt("2026-10-19", "09:25"));
  assert.equal(after["trid_application_at"], null); assert.equal((await events(jane.appId, "application.trid_received")).length, 0);
  assert.equal((await events(jane.appId, "application.six_item.captured")).filter((e) => e.payload["item"] === "property_address").length, 1);
  assert.equal(((await entity("applications", jane.appId))!["six_items"] as Record<string, { source: string }>)["property_address"]!.source, "borrower_stated");
});

test("32.3-T9: Given two borrowers with different score models, then the UI shows the neutral re-run message and no scores; DU association is refused until re-ordered (23.1 T11).", { skip }, async () => {
  // the journey's reports: Alex/Blake under classic_fico; a VantageScore 4.0 report for Blake beside it → 23.1 refuses the association (SCORE_MODEL_MIXED) until 22.2 re-orders
  const report = (await entity("credit_reports", journey.creditReportId))!;
  const mixed = { ...report, report_id: `R-VS-${R}`, borrower_ids: ["B2"], score_model: "vantagescore_4" };
  clock.set(MST("2026-10-06", "15:00"));
  const cf = await entity("du_casefiles", journey.casefileId);
  const refused = await journey.call("POST", `/v1/applications/${journey.appId}/tools/23.1/associateCredit`, { actor: UNDERWRITER, input: { casefile: { ...cf, status: "draft", credit_association: [] }, reports: [{ ...report, borrower_ids: ["B1"] }, mixed], borrowers: [{ borrower_id: "B1", last_name: "Borrower", suffix: null, ssn_last4: "6789" }, { borrower_id: "B2", last_name: "Borrower", suffix: null, ssn_last4: "4321" }], app_score_model: "classic_fico" } });
  assert.notEqual(refused.status, 200); assert.match(JSON.stringify(refused.body), /SCORE_MODEL_MIXED/);
  // 22.2 re-orders Blake under the application's model: the flow's neutral line, never a score
  clock.set(MST("2026-10-06", "15:10"));
  const reorder = await tool({ app: journey.appId }, "22.2", "orderCreditReport", { borrower_ids: ["B2"], permissible_purpose: "credit_transaction_604a3A", certification_ref: "CERT-PARTNER-1681E-2026", borrower_authorization_ref: "AUTH-BLANKET-2026-10-05", subscriber_code: "SUB-PARTNER-0417", joint_intent_facts: (journey as unknown as { JOINT_INTENT: unknown }).JOINT_INTENT, at: MST("2026-10-06", "15:10"), attempt: 2 }, VERIFICATION);
  assert.ok(reorder.events.some((e) => e.type === "credit.report.ordered"));
  await settle();
  const cards = await cardsOf(journey.appId, partyA);
  assert.ok(cards.some((c) => c.kind === "StatusCard" && c.copy_key === "credit.rerun.neutral"), "the neutral re-run StatusCard");
  const b = await signIn(EMAIL_B); const keys = new Set<string>(); const strings: string[] = [];
  walk(await record(b.token, journey.appId), keys, strings); walk(await thread(b.token), keys, strings);
  for (const c of cards) walk({ props: c.props, evidence: c.evidence }, keys, strings);
  for (const f of ["scores", "score", "credit_score", "representative_score", "borrower_applicable_scores", "score_model", "key_factors"]) assert.ok(!keys.has(f), `${f} never reaches a client payload`);
  for (const n of ["742", "751", "760", "698", "712", "705"]) assert.ok(!strings.some((s) => s === n), `bureau score ${n} never renders`);
});

test("32.3-T10: Given `credit.report.received` at 09:00 Tuesday, then `NTC_FCRA_609G_CREDIT_SCORE` is delivered by end of Wednesday (`FCRA_609G_SCORE_NOTICE_1BD`).", { skip }, async () => {
  // Kim's tri-merge Tue Oct 20 09:00 ET (E-SIGN active since T7 → the score notice is e-delivered by 21.3 the same morning)
  clock.set(isoEt("2026-10-20", "09:00")); kim.token = await fresh(KIM);
  const order = await tool({ app: kim.appId }, "22.2", "orderCreditReport", { borrower_ids: ["B1"], permissible_purpose: "credit_transaction_604a3A", certification_ref: "CERT-PARTNER-1681E-2026", borrower_authorization_ref: `AUTH-KIM-${R}`, subscriber_code: "SUB-PARTNER-0417", fee_sm_borne: true, at: isoEt("2026-10-20", "09:00") }, VERIFICATION);
  kim.reportId = order.output["report_id"] as string; assert.ok(order.events.some((e) => e.type === "credit.report.received"));
  await settle();
  const delivered = (await events(kim.appId, "score_disclosure.delivered")); assert.equal(delivered.length, 1, "21.3 delivered the §609(g) notice"); assert.equal(delivered[0]!.payload["all_borrowers_covered"], true); assert.equal(delivered[0]!.payload["channel"], "esign_portal");
  const t = await timer(kim.appId, "FCRA_609G_SCORE_NOTICE_1BD"); assert.ok(t, "the timer armed on credit.report.received");
  assert.equal(wallClock(Date.parse(t!.due_at!), "America/New_York").date, "2026-10-21", "end of Wednesday, creditor calendar"); assert.equal(t!.status, "satisfied"); assert.ok(delivered[0]!.occurred_at <= t!.due_at!);
  const cards = await cardsOf(kim.appId, kim.partyId);
  const notice = cards.find((c) => c.kind === "DocumentCard" && c.copy_key === "companion.score_notice"); assert.ok(notice, "the score notice DocumentCard (requires_ack=false)"); assert.equal(notice!.props["notice_code"], "NTC_FCRA_609G_CREDIT_SCORE"); assert.equal(notice!.props["requires_ack"], false);
  assert.ok(cards.some((c) => c.copy_key === "credit.liabilities.confirm"), "the liabilities ConfirmCard");
  const keys = new Set<string>(); const strings: string[] = []; walk(await thread(kim.token), keys, strings); for (const n of ["742", "751", "760"]) assert.ok(!strings.includes(n), "no score in the thread");
});

test("32.3-T11: Given Truv returns $8,200 monthly base, when the borrower confirms, then `application_income` has `amount_cents = 820000, source = payroll_connection, confirmed_at set` and `trid_items.income.present = true`; given the borrower instead types $8,000, then `source = borrower`.", { skip }, async () => {
  clock.set(isoEt("2026-10-19", "09:40"));
  const connect = await pendingCard(jane.appId, jane.partyId, "income.connect.purpose"); assert.equal(connect.props["vendor"], "truv_income"); assert.equal(connect.props["vendor_fake"], "FAKE");
  const started = await resolve(jane.token, connect.card_instance_id, { evidence: { vendor: "truv_income", started_at: clock.now() } }); assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.equal((started.body["result"] as Record<string, unknown>)["vendor_fake"], "FAKE");
  const vs = await api("POST", "/v1/borrower/connect/truv_income/session", { card_instance_id: connect.card_instance_id }, jane.token); assert.equal(vs.status, 200, JSON.stringify(vs.body)); assert.equal(vs.body["delivery"], "FAKE");
  clock.set(isoEt("2026-10-19", "09:42"));
  const hook = await api("POST", "/v1/webhooks/truv", { type: "voie.report.ready", data: { vendor_session_id: vs.body["vendor_session_id"], report: { employer: "Acme Manufacturing (FAKE payroll)", monthly_base_cents: "820000" } } }, undefined, { "x-truv-signature": "FAKE" });
  assert.equal(hook.status, 200, JSON.stringify(hook.body)); assert.equal(hook.body["outcome"], "connected"); assert.ok((hook.body["events"] as string[]).includes("verification.received"));
  jane.verificationId = String(hook.body["verification_id"]);
  await settle();
  const income = await pendingCard(jane.appId, jane.partyId, "income.confirm.title"); jane.incomeCardId = income.card_instance_id;
  const fields = income.props["fields"] as { path: string; value: string; source: string }[];
  assert.equal(fields.find((f) => f.path === "monthly_base_cents")!.value, "820000"); assert.equal(fields.find((f) => f.path === "monthly_base_cents")!.source, "payroll_connection"); assert.equal(fields.find((f) => f.path === "employer")!.value, "Acme Manufacturing (FAKE payroll)");
  clock.set(isoEt("2026-10-19", "09:45"));
  const r = await resolve(jane.token, income.card_instance_id, fieldsEvidence(income)); assert.equal(r.status, 201, JSON.stringify(r.body));
  const rows = await db.query<{ monthly_amount_cents: string; source_kind: string; calculation: Record<string, unknown>; employer: Record<string, unknown> }>(`SELECT monthly_amount_cents::text AS monthly_amount_cents, source_kind, calculation, employer FROM application_income WHERE application_id = $1 ORDER BY created_at`, [jane.appId]);
  assert.equal(rows.length, 1); assert.equal(rows[0]!.monthly_amount_cents, "820000"); assert.equal(rows[0]!.calculation["source"], "payroll_connection"); assert.equal(rows[0]!.calculation["confirmed_at"], isoEt("2026-10-19", "09:45")); assert.equal(rows[0]!.calculation["verification_id"], jane.verificationId); assert.equal(rows[0]!.employer["name"], "Acme Manufacturing (FAKE payroll)");
  const l = await lead(jane.leadId); assert.equal(tridItem(l, "income").present, true); assert.equal(tridItem(l, "income").source, "consumer_stated");
  assert.equal(((await entity("applications", jane.appId))!["six_items"] as Record<string, { source: string }>)["income"]!.source, "borrower_confirmed_prefill", "21.1: the prefilled income counts at the confirmation");
  // the typed fallback (SQ-03): $8,000 stated by the borrower → source = borrower
  clock.set(isoEt("2026-10-19", "09:50"));
  const typed = await command(jane.token, "application.confirmField", { path: "income", fields: [{ path: "monthly_base_cents", value: "800000", source: "borrower" }], application_id: jane.appId }); assert.equal(typed.status, 200, JSON.stringify(typed.body));
  const rows2 = await db.query<{ monthly_amount_cents: string; calculation: Record<string, unknown> }>(`SELECT monthly_amount_cents::text AS monthly_amount_cents, calculation FROM application_income WHERE application_id = $1 ORDER BY created_at`, [jane.appId]);
  assert.equal(rows2.length, 2); assert.equal(rows2[1]!.monthly_amount_cents, "800000"); assert.equal(rows2[1]!.calculation["source"], "borrower");
  assert.equal(((await entity("applications", jane.appId))!["six_items"] as Record<string, { source: string }>)["income"]!.source, "borrower_stated");
});

test("32.3-T12: Given a DU validation report with `close_by_date`, then the date exists in `verifications` and nowhere in any client payload.", { skip }, async () => {
  clock.set(isoEt("2026-10-19", "09:52"));
  const r = await tool({ app: jane.appId }, "22.3", "orderVerificationReport", { op: "du_validation", borrower_id: "B1", component: "income", outcome: "validated", report_reference_id: `TRUV-FAKE-${R}`, supplier_code: "TRUV", close_by_date: "2027-01-15", verification_id: jane.verificationId, message_date: "2026-10-19" }, VERIFICATION);
  assert.equal(r.output["close_by_date"], "2027-01-15");
  const v = await entity("verifications", jane.verificationId); assert.ok(v); assert.equal(v!["close_by_date"], "2027-01-15"); assert.equal(v!["du_validation_outcome"], "validated");
  await settle();
  const keys = new Set<string>(); const strings: string[] = [];
  walk(await record(jane.token, jane.appId), keys, strings); walk(await thread(jane.token), keys, strings);
  for (const c of await cardsOf(jane.appId, jane.partyId)) walk({ props: c.props, evidence: c.evidence }, keys, strings);
  assert.ok(!keys.has("close_by_date"), "close_by_date never leaves the API"); assert.ok(!strings.includes("2027-01-15"), "the date itself never renders");
  assert.ok(FORBIDDEN_FIELDS.includes("close_by_date"), "the serializer's contract names it");
  for (const f of FORBIDDEN_FIELDS) assert.ok(!keys.has(f), `${f} leaked`);
});

test("32.3-T13: Given the Profile card, when the borrower taps Confirm without choosing citizenship, then the card refuses and the field is not written.", { skip }, async () => {
  clock.set(isoEt("2026-10-19", "09:54"));
  const profile = await pendingCard(jane.appId, jane.partyId, "profile.title"); assert.equal(profile.kind, "ProfileCard"); assert.ok((profile.props["required_paths"] as string[]).includes("citizenship_status"));
  const r = await resolve(jane.token, profile.card_instance_id, { option_id: "submit", evidence: { fields: [{ path: "citizenship_status", value: "", answered_at: clock.now() }, { path: "marital_status", value: "unmarried", answered_at: clock.now() }, { path: "dependents", value: "0", answered_at: clock.now() }, { path: "military_service", value: "none", answered_at: clock.now() }, { path: "language_preference", value: "english", answered_at: clock.now() }] } });
  assert.equal(r.status, 409); assert.equal(r.body["code"], "CARD_FIELD_REQUIRED"); assert.equal(r.body["copy_key"], "thread.card_field_required");
  assert.equal(((await cardsOf(jane.appId, jane.partyId)).find((c) => c.card_instance_id === profile.card_instance_id))!.status, "pending");
  const ab = (await db.query<{ citizenship_status: string | null; marital_status: string | null }>(`SELECT citizenship_status, marital_status FROM application_borrowers WHERE application_id = $1`, [jane.appId]))[0]!;
  assert.equal(ab.citizenship_status, null); assert.equal(ab.marital_status, null, "nothing on the card is written until every required tap is made");
  assert.equal((await events(jane.appId, "application.field.captured")).filter((e) => e.payload["field"] === "marital_status").length, 0);
});

test("32.3-T14: Given \"None of these apply\", then thirteen `declarations` values are `false` and `evidence.list_version_hash` is set.", { skip }, async () => {
  clock.set(isoEt("2026-10-19", "09:56"));
  const profile = await pendingCard(jane.appId, jane.partyId, "profile.title");
  const ok = await resolve(jane.token, profile.card_instance_id, { option_id: "submit", evidence: { fields: [{ path: "citizenship_status", value: "us_citizen", answered_at: clock.now() }, { path: "marital_status", value: "unmarried", answered_at: clock.now() }, { path: "dependents", value: "0", answered_at: clock.now() }, { path: "military_service", value: "none", answered_at: clock.now() }, { path: "language_preference", value: "english", answered_at: clock.now() }] } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const ab = (await db.query<{ citizenship_status: string | null; marital_status: string | null; language_preference: string | null }>(`SELECT citizenship_status, marital_status, language_preference FROM application_borrowers WHERE application_id = $1`, [jane.appId]))[0]!;
  assert.deepEqual(ab, { citizenship_status: "us_citizen", marital_status: "unmarried", language_preference: "english" });
  const decl = await pendingCard(jane.appId, jane.partyId, "declarations.title"); assert.equal(decl.kind, "ChoiceCard"); assert.equal((decl.props["list"] as string[]).length, 13); assert.equal(decl.props["list_version_hash"], DECLARATIONS_LIST_HASH);
  const r = await resolve(jane.token, decl.card_instance_id, { option_id: "none", evidence: { option_id: "none", tapped_at: clock.now() } }); assert.equal(r.status, 201, JSON.stringify(r.body));
  const card = (r.body["card"] as Record<string, unknown>); const evidence = card["evidence"] as Record<string, unknown>;
  assert.equal(evidence["list_version_hash"], DECLARATIONS_LIST_HASH); assert.equal(evidence["option_id"], "none");
  const row = await entity("declarations", `${jane.appId}:B1`); assert.ok(row); assert.equal((row!["declarations"] as boolean[]).length, 13); assert.ok((row!["declarations"] as boolean[]).every((v) => v === false)); assert.equal(row!["none_apply"], true);
  assert.equal((await events(jane.appId, "application.declarations.answered")).length, 1);
});

test("32.3-T15: Given `applications.status = started` is not yet reached, when a client posts `application.answerDemographics`, then the API refuses (20.3 T12).", { skip }, async () => {
  // Lee: a lead-stage party — a session, a lead, no application
  clock.set(isoEt("2026-10-19", "09:57"));
  const s = await signIn(LEE.email); await settle();
  assert.equal((await db.query(`SELECT 1 FROM application_borrowers WHERE party_id = $1`, [s.party_id])).length, 0, "no application on this party");
  const r = await command(s.token, "application.answerDemographics", { borrower_id: "B1", collection_method: "internet", declined_ethnicity: true, declined_race: true, declined_sex: true });
  assert.equal(r.status, 409); assert.equal(r.body["code"], "NO_DEMOGRAPHIC_AT_LEAD"); assert.equal(r.body["copy_key"], "gate.demographics.application_first");
  assert.equal((await db.query(`SELECT 1 FROM restricted_fl.applicant_demographics d JOIN application_borrowers ab ON ab.id = d.application_borrower_id WHERE ab.party_id = $1`, [s.party_id])).length, 0);
  // 20.3's own refusal at the lead stage: the demographic request does not exist there
  const leadRow = (await db.query<{ id: string }>(`SELECT id FROM entity_current WHERE kind = 'leads' AND data->>'party_id' = $1`, [s.party_id]))[0]; assert.ok(leadRow, "Lee's lead");
  const refused = await journey.call("POST", `/v1/tools/20.3/explainProgram`, { actor: INTAKE, input: { op: "demographics", lead_id: leadRow!.id } }); assert.notEqual(refused.status, 200); assert.match(JSON.stringify(refused.body), /NO_DEMOGRAPHIC_AT_LEAD/);
  assert.equal(s.level, "L1");
});

test("32.3-T16: Given the borrower selects \"I do not wish to provide\" for ethnicity, then `applicant_demographics.ethnicity = declined` and `collection_method = internet`.", { skip }, async () => {
  clock.set(isoEt("2026-10-19", "09:58"));
  const card = await pendingCard(jane.appId, jane.partyId, "demographics.title"); assert.equal(card.kind, "DemographicsCard"); assert.equal(card.props["collection_method"], "internet"); assert.equal(card.props["available"], true);
  const r = await resolve(jane.token, card.card_instance_id, { option_id: "submit", evidence: { collection_method: "internet", answered_at: clock.now(), answers: { ethnicity: ["do_not_wish"], race: ["white"], sex: "female" } } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const stored = (r.body["card"] as Record<string, unknown>)["evidence"] as Record<string, unknown>;
  assert.equal("answers" in stored, false, "the answers never stay on the card (01 §3.19)"); for (const k of ["ethnicity", "race", "sex"]) assert.equal(k in stored, false);
  const b = ((await entity("applications", jane.appId))!["borrowers"] as Record<string, unknown>[]).find((x) => x["legal_name"] === JANE.name)!;
  const d = b["demographics"] as Record<string, unknown>; assert.ok(d, "21.1's applicant_demographics row");
  assert.equal(d["declined_ethnicity"], true); assert.equal(d["ethnicity"], null); assert.equal(d["collection_method"], "internet"); assert.deepEqual(d["race"], ["white"]); assert.equal(d["declined_race"], false); assert.equal(d["sex"], "female");
  const ev = (await events(jane.appId, "application.demographics.collected")).at(-1)!; assert.equal(ev.payload["collection_method"], "internet"); assert.equal(ev.payload["declined_ethnicity"], true);
  for (const k of ["ethnicity", "race", "sex"]) assert.ok(!(k in ev.payload), `${k} never on the event`);
  const keys = new Set<string>(); walk(await record(jane.token, jane.appId), keys, []); walk(await thread(jane.token), keys, []); for (const k of ["ethnicity", "race", "sex", "declined_ethnicity"]) assert.ok(!keys.has(k), `${k} never read back`);
});

test("32.3-T17: Given income confirmed at 10:02, SSN authorization at 10:03, address at 10:04, value at 10:05 and loan amount at 10:06 (ET), then `trid_application_date = 10:06` and `REGZ_1026_19E1_LE_3BD.due_at` is end of the third creditor business day after.", { skip }, async () => {
  // R7's cards arrived with the demographics; the six items complete in the stated order (the earlier income/address confirmations are re-stated at their times)
  clock.set(isoEt("2026-10-19", "10:02")); jane.token = await fresh(JANE);
  assert.equal((await command(jane.token, "application.confirmField", { path: "income", fields: [{ path: "monthly_base_cents", value: "820000", source: "borrower" }], application_id: jane.appId })).status, 200);
  clock.set(isoEt("2026-10-19", "10:03"));
  const ssn = await pendingCard(jane.appId, jane.partyId, "identity.ssn.title"); assert.deepEqual(ssn.props["masked_paths"], ["ssn"]);
  const s = await resolve(jane.token, ssn.card_instance_id, fieldsEvidence(ssn, { ssn: "123-45-1111" })); assert.equal(s.status, 201, JSON.stringify(s.body));
  const ssnCard = ((await cardsOf(jane.appId, jane.partyId)).find((c) => c.card_instance_id === ssn.card_instance_id))!;
  assert.ok(!JSON.stringify(ssnCard.evidence).includes("123-45-1111") && !JSON.stringify(ssnCard.evidence).includes("123451111"), "the SSN is never echoed on the card"); assert.equal(((ssnCard.evidence!["fields"] as { value_confirmed: string }[])[0]!).value_confirmed, "••••1111");
  assert.equal((await db.query<{ tin_last4: string }>(`SELECT tin_last4 FROM application_borrowers WHERE application_id = $1`, [jane.appId]))[0]!.tin_last4, "1111");
  clock.set(isoEt("2026-10-19", "10:04"));
  assert.equal((await command(jane.token, "application.confirmField", { path: "property_address", fields: [{ path: "property_address", value: "22 Elm St, Phoenix, AZ 85018", source: "borrower" }], application_id: jane.appId })).status, 200);
  clock.set(isoEt("2026-10-19", "10:05"));
  const value = await pendingCard(jane.appId, jane.partyId, "refi.value.confirm"); assert.equal((value.props["fields"] as { source: string; value: string }[])[0]!.source, "avm"); assert.equal((value.props["fields"] as { value: string }[])[0]!.value, "55000000");
  assert.equal((await resolve(jane.token, value.card_instance_id, fieldsEvidence(value))).status, 201);
  assert.equal((await events(jane.appId, "application.trid_received")).length, 0, "five of six");
  clock.set(isoEt("2026-10-19", "10:06"));
  const amount = await pendingCard(jane.appId, jane.partyId, "refi.loan_amount.confirm");
  const a = await resolve(jane.token, amount.card_instance_id, fieldsEvidence(amount, { loan_amount_sought: "50000000" })); assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.ok((a.body["events"] as string[]).includes("application.trid_received"), JSON.stringify(a.body["events"]));
  const trid = (await events(jane.appId, "application.trid_received"))[0]!;
  assert.equal(trid.payload["trid_received_at"], isoEt("2026-10-19", "10:06"), "the six-item timestamp is the last confirmation"); assert.equal(trid.payload["trid_application_date"], "2026-10-19");
  const intake = (await entity("applications", jane.appId))!; assert.equal(intake["trid_received_at"], isoEt("2026-10-19", "10:06")); assert.equal(intake["trid_application_date"], "2026-10-19"); assert.equal(intake["status"], "trid_received");
  const l = await lead(jane.leadId); assert.equal(l["trid_application_at"], isoEt("2026-10-19", "10:06"), "20.3's own six-item evidence agrees"); for (const k of ["name", "income", "ssn_for_credit", "property_address", "value_estimate", "loan_amount_sought"]) assert.equal(tridItem(l, k).present, true, k);
  const t = await timer(jane.appId, "REGZ_1026_19E1_LE_3BD"); assert.ok(t); assert.equal(t!.status, "armed");
  assert.equal(t!.due_at, "2026-10-23T03:59:00.000Z", "Mon Oct 19 → Thu Oct 22, 23:59 creditor (Eastern) time"); assert.equal(wallClock(Date.parse(t!.due_at!), "America/New_York").date, "2026-10-22");
  await settle();
  const rec = await record(jane.token, jane.appId); assert.equal((rec["status"] as { badge: string }).badge, "Application received"); assert.equal((rec["next"] as { timer_code: string; due_at: string }).timer_code, "REGZ_1026_19E1_LE_3BD"); assert.equal((rec["next"] as { due_at: string }).due_at, t!.due_at);
  const status = (await cardsOf(jane.appId, jane.partyId)).find((c) => c.copy_key === "application.received"); assert.ok(status, "the StatusCard"); assert.equal(status!.props["next_event_at"], t!.due_at);
});

test("32.3-T18: Given the AVM card is shown and the borrower edits to $600,000, then `property_value_estimate.present = true` with `source = borrower`; given no action, then `present = false`.", { skip }, async () => {
  // Kim's R7 cards follow her demographics (21.1's own tool); her six items came through the interview, so the lead's value_estimate evidence is still absent
  clock.set(isoEt("2026-10-20", "09:30")); kim.token = await fresh(KIM);
  await tool({ app: kim.appId }, "21.1", "askDemographics", { borrower_id: "B1", collection_method: "internet", declined_ethnicity: true, declined_race: true, declined_sex: true });
  await settle();
  const card = await pendingCard(kim.appId, kim.partyId, "refi.value.confirm");
  const f = (card.props["fields"] as { path: string; value: string; source: string }[])[0]!; assert.equal(f.source, "avm"); assert.equal(f.value, "52000000"); assert.equal(card.props["avm_vendor"], "FAKE");
  // no action: the AVM shown does not count (21.2 rule 2)
  const before = await lead(kim.leadId); assert.equal(tridItem(before, "value_estimate").present, false); assert.equal(tridItem(before, "value_estimate").source, null);
  clock.set(isoEt("2026-10-20", "09:32"));
  const r = await resolve(kim.token, card.card_instance_id, fieldsEvidence(card, { property_value_estimate: "60000000" })); assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(((r.body["card"] as Record<string, unknown>)["evidence"] as { edited: boolean }).edited, true);
  const after = await lead(kim.leadId); assert.equal(tridItem(after, "value_estimate").present, true); assert.equal(tridItem(after, "value_estimate").source, "consumer_stated");
  const intake = (await entity("applications", kim.appId))!; assert.equal((intake["six_items"] as Record<string, { source: string }>)["property_value_estimate"]!.source, "borrower_stated"); assert.equal(String(intake["property_value_estimate_cents"]), "60000000");
});

test("32.3-T19: Given any `du.findings.received`, then no field of the findings appears in `/v1/borrower/*` responses (contract test on serializers).", { skip }, async () => {
  const findings = await events(journey.appId, "du.findings.received"); assert.ok(findings.length >= 1);
  const payloadKeys = Object.keys(findings[0]!.payload).filter((k) => !["casefile_id", "submission_number", "application_id", "messages"].includes(k));   // `messages` is the thread envelope's own list; the DU messages themselves are asserted below by id and wording
  const a = await signIn(EMAIL_A); await api("POST", "/v1/borrower/auth/l2", { ssn_last4: "6789", date_of_birth: "1985-06-15" }, a.token);
  const keys = new Set<string>(); const strings: string[] = []; const content: string[] = [];
  for (const path of [`/v1/borrower/record?subject=${journey.appId}`, "/v1/borrower/thread?limit=500"]) { const r = await api("GET", path, undefined, a.token); assert.equal(r.status, 200, path); walkShape(r.body, keys); walk(r.body, new Set(), strings); walkContent(r.body, content); }
  for (const c of await cardsOf(journey.appId, partyA)) { walk({ props: c.props, evidence: c.evidence }, new Set(), strings); walkContent({ props: c.props, evidence: c.evidence }, content); }   // the stored cards: content checks only (the API shapes are the responses above)
  for (const k of payloadKeys) assert.ok(!keys.has(k), `findings field ${k} never leaves the API`);
  for (const m of (journey as unknown as { DU_MESSAGES: { id: string; text: string }[] }).DU_MESSAGES) { assert.ok(!content.some((s) => s.includes(m.id)), `DU message id ${m.id} never renders`); assert.ok(!strings.some((s) => s === m.text), "DU wording never renders"); }
  for (const f of FORBIDDEN_FIELDS) assert.ok(!keys.has(f), `${f} leaked`);
  assert.ok(["recommendation", "messages_hash", "validation_results", "value_acceptance_offer", "mi_requirement", "risk_factors", "findings_hash"].every((k) => payloadKeys.includes(k) ? !keys.has(k) : true));
  assert.ok(FORBIDDEN_FIELDS.includes("findings") && FORBIDDEN_FIELDS.includes("validation_results") && FORBIDDEN_FIELDS.includes("findings_hash"), "the serializer's contract names the findings fields");
});

test("32.3-T20: Given findings at 14:00, then a `ChecklistCard` with materialized conditions exists by 18:00 the same creditor business day (`SM_DU_CONDITIONS_SLA_4H`).", { skip }, async () => {
  const received = (await events(journey.appId, "du.findings.received"))[0]!; assert.equal(received.occurred_at, MST("2026-10-06", "14:00"));
  const t = await timer(journey.appId, "SM_DU_CONDITIONS_SLA_4H"); assert.ok(t, "the 23.2 SLA clock"); assert.equal(t!.due_at, MST("2026-10-06", "18:00"), "+4 hours"); assert.equal(t!.status, "satisfied");
  const cards = await cardsOf(journey.appId, partyA);
  const checklist = cards.find((c) => c.kind === "ChecklistCard" && c.copy_key === "conditions.checklist"); assert.ok(checklist, "the ChecklistCard");
  assert.ok(checklist!.created_at <= MST("2026-10-06", "18:00"), `created ${checklist!.created_at} by 18:00 MST`); assert.equal(checklist!.props["du_submission_id"], duSubmissionId);
  const items = checklist!.props["items"] as { condition_id: string; label: string; owner: string; status: string }[]; assert.ok(items.length >= 3, "materialized conditions");
  const conditions = (await db.query<{ data: unknown }>(`SELECT DISTINCT ON (id) data FROM entity_records WHERE kind = 'conditions' AND application_id = $1 ORDER BY id, version DESC`, [journey.appId])).map((r) => decodeEntityData(r.data));
  for (const it of items) { const c = conditions.find((x) => x["condition_id"] === it.condition_id); assert.ok(c, `condition ${it.condition_id} is a 23.2 row`); assert.equal(c!["borrower_visible"], true); assert.equal(it.label, c!["text"]); assert.ok(["you", "us", "third_party"].includes(it.owner)); }
  for (const m of (journey as unknown as { DU_MESSAGES: { id: string; text: string }[] }).DU_MESSAGES) for (const it of items) { assert.ok(!it.label.includes(m.id)); assert.notEqual(it.label, m.text); }
  assert.ok(cards.some((c) => c.copy_key === "du.running" && c.kind === "StatusCard"), "the neutral DU StatusCard");
  const t2 = await thread((await signIn(EMAIL_A)).token); assert.ok(t2.messages.some((m) => m["card_instance_id"] === checklist!.card_instance_id));
});

test("32.3-T21: Given `origination.ai_mlo_intake = assisted` and `terms.presentation.requested` at 08:50, then no personal rate renders before `mlo.review.completed{approved}`; the `StatusCard` shows `due_at = 09:50` (20.3 T7).", { skip }, async () => {
  // Tue Oct 20: the day's sheet, Jane's personalized quote (20.4), the MLO of record on the lead, the review requested 08:50 MST
  await publishSheet(`rs-2026-10-20-${R}`, isoEt("2026-10-20", "06:35"), isoEt("2026-10-20", "17:00"));
  clock.set(MST("2026-10-20", "08:45")); jane.token = await fresh(JANE);
  const q = await tool({ app: jane.appId }, "20.4", "solvePassThrough", { inputs: QUOTE_INPUTS("50000000", "55000000", "limited_cash_out"), quote_id: `Q-J-${R}`, purpose: "lead_quote", partner_id: "partner-1", lead_id: jane.leadId }, PRICING); jane.quoteId = q.output["quote_id"] as string;
  await tool({ app: jane.appId }, "20.3", "requestQuote", { op: "assign_mlo", lead_id: jane.leadId, mlo_of_record_id: "u-mlo-rivera", mlo_name: "Jordan Rivera", mlo_nmlsr_id: "987654", mlo_time_zone: "America/Phoenix" });
  clock.set(MST("2026-10-20", "08:50"));
  const req = await tool({ app: jane.appId }, "20.3", "requestQuote", { op: "request_review", lead_id: jane.leadId, quote_id: jane.quoteId });
  assert.equal(req.output["due_at"], MST("2026-10-20", "09:50")); assert.ok(req.events.some((e) => e.type === "terms.presentation.requested"));
  await settle();
  const t = await timer(jane.appId, "SM_MLO_PREAPP_TERMS_REVIEW_1BH"); assert.ok(t); assert.equal(t!.due_at, MST("2026-10-20", "09:50")); assert.equal(t!.status, "armed");
  const cards = await cardsOf(jane.appId, jane.partyId);
  const pending = cards.find((c) => c.kind === "StatusCard" && c.copy_key === "terms.pending_mlo" && c.props["quote_id"] === jane.quoteId); assert.ok(pending, "the review StatusCard");
  assert.equal(pending!.props["next_event_at"], MST("2026-10-20", "09:50")); assert.equal((pending!.props["copy_tokens"] as Record<string, string>)["mlo.name"], "Jordan Rivera"); assert.equal((pending!.props["copy_tokens"] as Record<string, string>)["mlo.nmlsr_id"], "987654");
  assert.ok(!JSON.stringify(pending!.props).includes("6.125") && !JSON.stringify(pending!.props).includes("note_rate"), "no rate on the card");
  assert.equal(cards.filter((c) => c.props["personal_terms"] === true).length, 0, "no personal-terms card before the approval");
  const rec = await record(jane.token, jane.appId); assert.equal(rec["numbers"], null, "no personal rate renders before mlo.review.completed{approved} (L3 session)");
  assert.equal((rec["next"] as { timer_code: string; due_at: string }).timer_code, "SM_MLO_PREAPP_TERMS_REVIEW_1BH"); assert.equal((rec["next"] as { due_at: string }).due_at, MST("2026-10-20", "09:50"));
  // the MLO of record approves at 09:20 → 20.3 presents (the flow) → the personal terms render
  clock.set(MST("2026-10-20", "09:20")); jane.token = await fresh(JANE);
  const review = await tool({ app: jane.appId }, "20.3", "requestQuote", { op: "review", lead_id: jane.leadId, quote_id: jane.quoteId, review_id: `MR-J-${R}`, outcome: "approved" }, MLO);
  assert.ok(review.events.some((e) => e.type === "mlo.review.completed" && e.payload["outcome"] === "approved"));
  await settle();
  assert.equal((await events(jane.appId, "terms.presented")).length, 1, "20.3 presentTerms after the approval");
  assert.equal((await timer(jane.appId, "SM_MLO_PREAPP_TERMS_REVIEW_1BH"))!.status, "satisfied");
  const presented = (await cardsOf(jane.appId, jane.partyId)).find((c) => c.copy_key === "terms.presented"); assert.ok(presented, "the terms StatusCard (L3 party)"); assert.equal(presented!.props["personal_terms"], true); assert.match(String((presented!.props["copy_tokens"] as Record<string, string>)["rate"]), /^\d\.\d{3}%$/);
  const rec2 = await record(jane.token, jane.appId); const numbers = rec2["numbers"] as Record<string, unknown>; assert.ok(numbers, "the numbers render after the approval"); assert.equal(numbers["figures_source"], "quote"); assert.ok(numbers["note_rate"]);
});

test("32.3-T22: Given active E-SIGN scoped to `origination_disclosures`, when the LE is approved, then the `DocumentCard` renders and `disclosure.le.delivered{channel=esign_portal}` is logged; **Confirm receipt** writes `received_at` and `receipt_evidence = esign_confirmed`.", { skip }, async () => {
  // Jane's E-SIGN: the card (checkbox + typed name) → pending verification → the e-mailed code → active, scoped to the origination disclosures
  clock.set(isoEt("2026-10-20", "12:00")); jane.token = await fresh(JANE);
  const esign = await pendingCard(jane.appId, jane.partyId, "consent.esign.title"); assert.deepEqual(esign.props["scope"], ["disclosures", "notices"]);
  const c = await resolve(jane.token, esign.card_instance_id, { evidence: { affirmation_method: "checkbox_with_text", typed_name: JANE.name, checkbox: true, disclosure_version_shown: esign.props["disclosure_version_id"] } }); assert.equal(c.status, 201, JSON.stringify(c.body));
  const consentId = String((c.body["result"] as Record<string, unknown>)["consent_id"]);
  assert.equal((await db.query<{ status: string }>(`SELECT status FROM consents WHERE id = $1`, [consentId]))[0]!.status, "pending_verification");
  const bad = await command(jane.token, "consent.capture", { op: "verify", consent_id: consentId, token: "WRONG1" }); assert.equal(bad.status, 400);
  clock.set(isoEt("2026-10-20", "12:05"));
  const verify = await command(jane.token, "consent.capture", { op: "verify", consent_id: consentId, token: esignVerificationToken(consentId), scope: ["disclosures", "notices"] }); assert.equal(verify.status, 200, JSON.stringify(verify.body));
  const row = (await db.query<{ status: string; verified: boolean; scope: string[] }>(`SELECT status, verified, scope FROM consents WHERE id = $1`, [consentId]))[0]!; assert.equal(row.status, "active"); assert.equal(row.verified, true); assert.ok(row.scope.includes("disclosures"));
  // the LE approved Tue Oct 20 16:10 ET: 21.2 delivers electronically under the active consent
  clock.set(isoEt("2026-10-20", "16:10")); jane.token = await fresh(JANE);
  const le = await deliverLeByConsent(runtime, jane.appId, { render: leRender(jane.appId, { as_of: "2026-10-20", loan_cents: "50000000", applicants: [JANE.name], property_address: "22 Elm St, Phoenix, AZ 85018", estimated_value_cents: "55000000", pricing: { quote_id: jane.quoteId, rate_pct: "6.125", price: "100.000", points_cents: "0", lender_credit_cents: "261700", locked: false } }) as never, mlo: { review_id: `MR-LE-J-${R}`, nmlsr_id: "987654" }, actor: MLO });
  jane.leId = le.result.disclosure_id; assert.equal(le.channel, "esign_portal"); assert.deepEqual(le.consent_ids, [consentId]); assert.equal(le.result.status, "delivered");
  await settle();
  const delivered = await events(jane.appId, "disclosure.le.delivered"); assert.equal(delivered.length, 1); assert.equal(delivered[0]!.payload["channel"], "esign_portal"); assert.equal(delivered[0]!.payload["esign_consent_id"], consentId);
  assert.equal((await events(jane.appId, "disclosure.le.mailed")).length, 0);
  const card = await pendingCard(jane.appId, jane.partyId, "le.delivered"); assert.equal(card.kind, "DocumentCard"); assert.equal(card.props["notice_code"], "NTC_REGZ_1026_37_LE"); assert.equal(card.props["requires_ack"], true); assert.equal(card.props["disclosure_id"], jane.leId); assert.equal(card.props["channel"], "esign_portal");
  const rec = await record(jane.token, jane.appId); const doc = (rec["documents"] as Record<string, unknown>[]).find((d) => d["disclosure_id"] === jane.leId)!; assert.equal(doc["status"], "delivered"); assert.equal(doc["channel"], "esign_portal"); assert.equal(doc["received_at"], null);
  // Confirm receipt
  clock.set(isoEt("2026-10-20", "17:42")); jane.token = await fresh(JANE);
  const r = await resolve(jane.token, card.card_instance_id, { option_id: "confirm", evidence: { opened_at: isoEt("2026-10-20", "17:40"), scrolled_to_end: true } }); assert.equal(r.status, 201, JSON.stringify(r.body));
  const received = await events(jane.appId, "disclosure.le.received"); assert.equal(received.length, 1); assert.equal(received[0]!.payload["receipt_evidence"], "esign_confirmed"); assert.equal(received[0]!.payload["received_at"], isoEt("2026-10-20", "17:42")); assert.equal(received[0]!.payload["received_on"], "2026-10-20");
  const disc = await entity("disclosures", jane.leId); assert.equal(disc!["status"], "received"); assert.equal(disc!["receipt_evidence"], "esign_confirmed"); assert.equal(disc!["received_at"], isoEt("2026-10-20", "17:42"));
  const rec2 = await record(jane.token, jane.appId); const doc2 = (rec2["documents"] as Record<string, unknown>[]).find((d) => d["disclosure_id"] === jane.leId)!; assert.equal(doc2["status"], "received"); assert.equal(doc2["received_at"], isoEt("2026-10-20", "17:42"));
  assert.equal((rec2["numbers"] as { figures_source: string }).figures_source, "le_v1");
});

test("32.3-T23: Given the borrower taps Proceed before the LE's effective receipt date, then `intent_records.valid = false`, the fee gate stays closed, and the assistant explains the order.", { skip }, async () => {
  // Kim's LE was placed in the mail Mon Oct 19: the mailbox rule makes Thu Oct 22 her effective receipt date; she taps Proceed on Tue Oct 20
  const issued = (await events(kim.appId, "disclosure.le.issued"))[0]!; assert.equal(issued.payload["deemed_receipt_date"], "2026-10-22");
  clock.set(isoEt("2026-10-20", "10:00")); kim.token = await fresh(KIM);
  const r = await command(kim.token, "intent.record", { disclosure_id: kim.leId, statement_text: "I want to proceed with this Loan Estimate", application_id: kim.appId }); assert.equal(r.status, 200, JSON.stringify(r.body));
  const out = r.body["result"] as Record<string, unknown>; assert.equal(out["valid"], false); assert.equal(out["le_effective_receipt_date"], "2026-10-22");
  const intent = await entity("intent_records", String(out["intent_id"])); assert.ok(intent); assert.equal(intent!["valid"], false);
  assert.equal((await events(kim.appId, "intent.to_proceed.rejected_premature")).length, 1); assert.equal((await events(kim.appId, "intent.to_proceed.received")).length, 0);
  // the fee gate stays closed: 21.4 refuses an appraisal fee (nothing but the credit report before intent)
  const gate = await journey.call("POST", `/v1/applications/${kim.appId}/tools/21.4/checkFeeGate`, { actor: PRICING, input: { command: "order_appraisal", fee_kind: "appraisal", amount_cents: "65000", checked_at: isoEt("2026-10-20", "10:01") } });
  assert.notEqual(gate.status, 200, JSON.stringify(gate.body)); assert.match(JSON.stringify(gate.body), /closed|no_intent|premature|CLOSED|INTENT/i);
  const checks = await events(kim.appId, "fee.gate.checked"); assert.ok(checks.length === 0 || checks.every((e) => e.payload["result"] !== "open"), "no fee gate opened");
  // the assistant explains the order
  await settle();
  const t = await thread(kim.token); const line = t.messages.filter((m) => m["body_text"] === "{{copy:intent.too_early}}"); assert.equal(line.length, 1); assert.equal(line[0]!["sender"], "agent");
  assert.equal(((await record(kim.token, kim.appId))["status"] as { badge: string }).badge !== "Rate floating", true);
});

test("32.3-T24: Given no valid intent, then no lock `ComparisonCard` is created; `lock.request` returns the gate error.", { skip }, async () => {
  clock.set(isoEt("2026-10-20", "18:00")); jane.token = await fresh(JANE); kim.token = await fresh(KIM);
  assert.equal((await events(jane.appId, "intent.to_proceed.received")).length, 0);
  assert.equal((await cardsOf(jane.appId, jane.partyId)).filter((c) => c.kind === "ComparisonCard").length, 0, "no lock card before intent");
  const r = await command(jane.token, "lock.request", { quote_id: jane.quoteId, period_days: 45, application_id: jane.appId });
  assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body["gate"], "REGZ_1026_19E2_INTENT_FEE_GATE"); assert.equal(r.body["code"], "REGZ_1026_19E2_INTENT_FEE_GATE"); assert.equal(r.body["copy_key"], "gate.intent.before_fees"); assert.deepEqual(Object.keys(r.body).sort(), ["code", "copy_key", "gate"]);
  assert.equal((await events(jane.appId, "lock.requested")).length, 0);
  // Kim's premature intent is no intent either
  const k = await command(kim.token, "lock.request", { quote_id: jane.quoteId, period_days: 45, application_id: kim.appId }); assert.equal(k.status, 409); assert.equal(k.body["gate"], "REGZ_1026_19E2_INTENT_FEE_GATE");
  assert.equal((await cardsOf(kim.appId, kim.partyId)).filter((c) => c.kind === "ComparisonCard").length, 0);
});

test("32.3-T25: Given `lock.executed` on Monday, then a revised LE `DocumentCard` exists by Thursday (`REGZ_1026_19E3IVD_LOCK_REVISED_LE_3BD`) and Numbers show `le_v2`.", { skip }, async () => {
  // Wed Oct 21: Jane proceeds (valid — on/after the LE receipt); Mon Oct 26: the day's sheet, 21.4's quote, the lock requested through the API and approved by the MLO
  clock.set(isoEt("2026-10-21", "09:00")); jane.token = await fresh(JANE);
  const intentCard = (await cardsOf(jane.appId, jane.partyId)).find((c) => c.copy_key === "intent.title" && c.status === "pending"); assert.ok(intentCard, "the Proceed ChoiceCard after receipt");
  const p = await resolve(jane.token, intentCard!.card_instance_id, { option_id: "proceed", evidence: { option_id: "proceed", tapped_at: clock.now() } }); assert.equal(p.status, 201, JSON.stringify(p.body));
  assert.equal(((p.body["result"] as Record<string, unknown>)["valid"]), true);
  await publishSheet(`rs-2026-10-26-${R}`, isoEt("2026-10-26", "06:35"), isoEt("2026-10-26", "17:00"));
  clock.set(MST("2026-10-26", "10:05")); jane.token = await fresh(JANE);
  const quote = await tool({ app: jane.appId }, "21.4", "getQuote", { loan_amount_cents: "50000000", product_code: "FRM30_CONV", note_rate_pct: "6.125", lock_period_days: 45, at: MST("2026-10-26", "10:05") }, PRICING);
  const lockQuote = quote.output["quote_id"] as string;
  const req = await command(jane.token, "lock.request", { quote_id: lockQuote, period_days: 45, application_id: jane.appId }); assert.equal(req.status, 200, JSON.stringify(req.body));
  jane.lockId = String((req.body["result"] as Record<string, unknown>)["lock_id"]); assert.equal((req.body["result"] as Record<string, unknown>)["status"], "pending_mlo_approval");
  clock.set(MST("2026-10-26", "10:19"));
  await tool({ app: jane.appId }, "21.4", "executeLock", { lock_id: jane.lockId, op: "approve", quote_id: lockQuote, mlo_nmlsr_id: "987654", approved_at: MST("2026-10-26", "10:19") }, MLO);
  const lock = await tool({ app: jane.appId }, "21.4", "executeLock", { lock_id: jane.lockId, executed_at: MST("2026-10-26", "10:19") }, PRICING);
  assert.equal(lock.output["status"], "executed"); assert.equal(wallClock(Date.parse(MST("2026-10-26", "10:19")), "America/Phoenix").date, "2026-10-26", "a Monday");
  const cc = lock.events.find((e) => e.type === "changed_circumstance.recorded"); assert.ok(cc, "the rate-lock changed circumstance"); assert.equal(cc!.payload["kind"], "rate_lock");
  await settle();
  const t = await timer(jane.appId, "REGZ_1026_19E3IVD_LOCK_REVISED_LE_3BD"); assert.ok(t, "the 3-business-day clock"); assert.equal(wallClock(Date.parse(t!.due_at!), "America/New_York").date, "2026-10-29", "Thursday"); assert.equal(t!.status, "armed");
  assert.ok((await cardsOf(jane.appId, jane.partyId)).some((c) => c.copy_key === "lock.executed"), "the lock StatusCard");
  // Tue Oct 27: 21.5 renders and delivers the revised LE (v2) under Jane's E-SIGN consent
  clock.set(isoEt("2026-10-27", "09:00"));
  const consent = (await db.query<{ id: string; scope: string[]; captured_at: string }>(`SELECT id, scope, captured_at FROM consents WHERE party_id = $1 AND kind = 'esign' AND status = 'active'`, [jane.partyId]))[0]!;
  const render = leRender(jane.appId, { as_of: "2026-10-27", loan_cents: "50000000", applicants: [JANE.name], property_address: "22 Elm St, Phoenix, AZ 85018", estimated_value_cents: "55000000", disclosure_id: `LE-${jane.appId.slice(0, 8)}-2`, pricing: { quote_id: lockQuote, rate_pct: "6.125", price: "100.000", points_cents: "0", lender_credit_cents: "261700", locked: true, lock_expires_at: String(lock.output["expires_at"] ?? MST("2026-12-10", "17:00")), lock_time_zone: "America/Phoenix" }, cc_ids: [cc!.payload["cc_id"]] });
  const fees = (render["fees"] as Record<string, unknown>[]).map((f) => ({ ...f, estimated_at: "2026-10-27" }));
  const v2 = await tool({ app: jane.appId }, "21.5", "renderRevisedLE", { ...render, fees }, DISCLOSURE); assert.equal(v2.output["le_version"], 2);
  const d = await tool({ app: jane.appId }, "21.5", "deliverDisclosure", { disclosure_id: render["disclosure_id"], channel: "esign_portal", at: isoEt("2026-10-27", "09:05"), consent: { id: consent.id, scope: consent.scope, granted_at: consent.captured_at } }, DISCLOSURE);
  assert.ok(d.events.some((e) => e.type === "disclosure.le.revised"));
  await settle(); jane.token = await fresh(JANE);
  const card = (await cardsOf(jane.appId, jane.partyId)).find((c) => c.kind === "DocumentCard" && c.copy_key === "revised_le.delivered"); assert.ok(card, "the revised LE DocumentCard");
  assert.ok(card!.created_at <= t!.due_at!, `by Thursday: ${card!.created_at} ≤ ${t!.due_at}`); assert.equal(card!.props["le_version"], 2);
  assert.equal((await timer(jane.appId, "REGZ_1026_19E3IVD_LOCK_REVISED_LE_3BD"))!.status, "satisfied");
  const rec = await record(jane.token, jane.appId); const numbers = rec["numbers"] as Record<string, unknown>;
  assert.equal(numbers["figures_source"], "le_v2"); assert.equal((numbers["lock"] as { status: string }).status, "executed");
  const docs = rec["documents"] as Record<string, unknown>[]; assert.ok(docs.some((x) => x["le_version"] === 2 && x["status"] === "delivered")); assert.ok(docs.some((x) => x["disclosure_id"] === jane.leId && x["status"] === "superseded"), "v1 superseded");
});

test("32.3-T26: Given a preapproval request with `property = TBD`, then `application.received` fires, `application.trid_received` does not, and `REGB_1002_9_DECISION_30` runs.", { skip }, async () => {
  casey.appId = await openBorrower(CASEY, "purchase", null);
  clock.set(isoEt("2026-11-02", "09:00"));
  const s = await signIn(CASEY.email); casey.token = s.token; casey.partyId = s.party_id; casey.leadId = casey.appId;
  await api("POST", "/v1/borrower/auth/l2", { ssn_last4: CASEY.tin_last4, date_of_birth: CASEY.dob }, casey.token);   // personal terms render from L2 (P9)
  const goal = await pendingCard(casey.appId, casey.partyId, "entry.goal.question"); assert.equal(((goal.props["command_args_by_option"] as Record<string, { property: { tbd: boolean } }>)["buy"]!).property.tbd, true);
  await setGoal(casey.appId, casey.partyId, casey.token, "buy");
  const received = await events(casey.appId, "application.received"); assert.equal(received.length, 1); assert.equal(received[0]!.payload["application_date"], "2026-11-02");
  assert.equal((await events(casey.appId, "application.trid_received")).length, 0, "no address, no TRID application (20.3 T5)");
  const t = await timer(casey.appId, "REGB_1002_9_DECISION_30"); assert.ok(t, "Reg B's 30-day clock"); assert.equal(t!.status, "armed"); assert.equal(t!.due_date, "2026-12-02");
  assert.equal(await timer(casey.appId, "REGZ_1026_19E1_LE_3BD"), undefined, "no LE clock without an address");
  // P1: the where-and-how-much card → 20.3's prequalification request (kind preapproval — DELTA-01)
  const where = await pendingCard(casey.appId, casey.partyId, "preapproval.where");
  const r = await resolve(casey.token, where.card_instance_id, fieldsEvidence(where, { state: "AZ", price_min_cents: "45000000", price_max_cents: "52500000", down_payment_cents: "10500000", first_time_buyer: "yes" })); assert.equal(r.status, 201, JSON.stringify(r.body));
  const l = await lead(casey.leadId); const pq = (l["prequalifications"] as Record<string, unknown>[]).at(-1)!; casey.prequalId = String(pq["prequal_id"]); assert.equal(pq["kind"], "preapproval"); assert.equal(l["status"], "prequal_requested");
  const rec = await record(casey.token, casey.appId); assert.equal((rec["property"] as { tbd: boolean } | null)?.tbd ?? true, true); assert.equal((rec["status"] as { badge: string }).badge, "Application received");
  assert.ok((await cardsOf(casey.appId, casey.partyId)).some((c) => c.copy_key === "preapproval.intro"));
});

test("32.3-T27: Given a preapproval letter is issued, then it names `partner.legal_name`, `mlo.name`/NMLSR ID, `valid_until`, the general conditions, and contains no occurrence of \"guarantee\".", { skip }, async () => {
  const scope = { app: casey.appId };
  // the amount and product the DU casefile runs on (P8), the credit report (fee SM-borne, a TBD hard pull), the personalized quote under the MLO's review, the casefile on a TBD property, 23.3's decision
  clock.set(isoEt("2026-11-02", "09:10")); casey.token = await fresh(CASEY);
  assert.equal((await command(casey.token, "application.confirmField", { path: "preapproval.target", fields: [{ path: "target_price_cents", value: "52500000", source: "borrower" }, { path: "down_payment_cents", value: "10500000", source: "borrower" }, { path: "loan_amount_sought", value: "42000000", source: "borrower" }, { path: "product_code", value: "FRM30", source: "borrower" }], application_id: casey.appId })).status, 200);
  await tool(scope, "21.1", "captureField", { field: "ssn", value: "123-45-3333", borrower_id: "B1" }); await tool(scope, "21.1", "captureField", { field: "income", value: "1150000", borrower_id: "B1" });
  const order = await tool(scope, "22.2", "orderCreditReport", { borrower_ids: ["B1"], permissible_purpose: "credit_transaction_604a3A", certification_ref: "CERT-PARTNER-1681E-2026", borrower_authorization_ref: `AUTH-CASEY-${R}`, subscriber_code: "SUB-PARTNER-0417", fee_sm_borne: true, trid_received: true, at: isoEt("2026-11-02", "09:12") }, VERIFICATION);
  const reportId = order.output["report_id"] as string; await tool(scope, "22.2", "parseCreditReport", { report_id: reportId }, VERIFICATION);
  await tool({}, "20.4", "buildFeeItems", { op: "cost_schedule", cost_schedule_id: `cs-az-purchase-hybrid-${R}`, partner_id: "partner-1", state: "AZ", transaction_type: "purchase", valuation_method: "hybrid", items: (journey as unknown as { COST_ITEMS: unknown[] }).COST_ITEMS, effective_from: "2026-09-01" }, OFFICER);
  await publishSheet(`rs-2026-11-02-${R}`, isoEt("2026-11-02", "06:35"), isoEt("2026-11-02", "17:00"));
  clock.set(isoEt("2026-11-02", "09:20"));
  const q = await tool(scope, "20.4", "solvePassThrough", { inputs: QUOTE_INPUTS("42000000", "52500000", "purchase", "52500000"), quote_id: `Q-C-${R}`, purpose: "lead_quote", partner_id: "partner-1", lead_id: casey.leadId }, PRICING); casey.quoteId = q.output["quote_id"] as string;
  await tool(scope, "20.3", "requestQuote", { op: "assign_mlo", lead_id: casey.leadId, mlo_of_record_id: "u-mlo-rivera", mlo_name: "Jordan Rivera", mlo_nmlsr_id: "987654", mlo_time_zone: "America/Phoenix" });
  await tool(scope, "20.3", "requestQuote", { op: "request_review", lead_id: casey.leadId, quote_id: casey.quoteId });
  clock.set(isoEt("2026-11-02", "09:40"));
  await tool(scope, "20.3", "requestQuote", { op: "review", lead_id: casey.leadId, quote_id: casey.quoteId, review_id: `MR-C-${R}`, outcome: "approved" }, MLO); await settle();
  assert.equal((await events(casey.appId, "terms.presented")).length, 1);
  // DU on the TBD casefile (23.1) and 23.2's interpretation
  clock.set(isoEt("2026-11-02", "10:00"));
  const { createCasefile } = await import("../underwriting/ops-23-1.ts"); const { MemoryEventStore } = await import("../../kernel/events/index.ts");
  const cf0 = createCasefile(new MemoryEventStore(clock), { application_id: casey.appId, seller_number: "123456789", system_id_ref: "SYS-PARTNER-01", tsp_product_ref: "SM-TSP", score_model: "classic_fico", created_at: clock.now() }).casefile; casey.casefileId = cf0.casefile_id;
  const borrowers = [{ borrower_id: "B1", last_name: "Rivera", suffix: null, ssn_last4: "3333" }];
  await tool(scope, "23.1", "associateCredit", { casefile: cf0, reports: [await entity("credit_reports", reportId)], borrowers, app_score_model: "classic_fico" }, UNDERWRITER);
  const snapshot = { application_id: casey.appId, loan_purpose: "purchase", occupancy: "principal_residence", product: "fixed_30", amortization: "fixed", loan_term: 360, property_type: "sfr_detached", sales_price_cents: "52500000", appraised_value_cents: "52500000", loan_amount_cents: "42000000", note_rate_pct: "6.125", qualifying_income_cents: "1150000", total_obligations_cents: "380000", borrowers, max_ltv_pct: "97.00" };
  const built = await tool(scope, "23.1", "buildDuRequest", { casefile_id: casey.casefileId, submission_type: "credit_and_underwriting", reason: "initial", snapshot }, UNDERWRITER);
  await tool(scope, "23.1", "submitCasefile", { casefile_id: casey.casefileId, request: built.output["request"], projected_note_date: "2026-12-15", scif_facts: { borrowers: [{ id: "B1", scif_presented_at: isoEt("2026-11-02", "09:10") }] } }, UNDERWRITER);
  const findings = await tool(scope, "23.1", "fetchFindings", { casefile_id: casey.casefileId, submission_number: 1 }, UNDERWRITER); const submission = findings.output["submission"] as Record<string, unknown>;
  clock.set(isoEt("2026-11-02", "10:12"));
  const messages = [{ id: "V1001", category: "verification", text: "Verify base income with the most recent paystub (30 days) and W-2 (1 year)", borrower_id: "B1" }, { id: "V1008", category: "verification", text: "Obtain evidence of hazard insurance coverage", borrower_id: null }, { id: "V1012", category: "verification", text: "Verify the borrowers' identity", borrower_id: null }];
  const interp = await tool(scope, "23.2", "parseFindings", { op: "interpret", submission_id: submission["submission_id"], submission_number: 1, recommendation: "approve_eligible", messages, validation_results: [], value_acceptance_offer: { offered: false }, mi_requirement: { required: false, coverage_pct: null }, du_release: "2026-09-25", policy_generation: "2026_09_26", request_hash: built.output["request_hash"], findings_received_at: isoEt("2026-11-02", "10:00"), facts: { transaction_type: "purchase", product: "standard", term_months: 360, ltv_x100: 8000, loan_amount_cents: "42000000", units: 1, county_limit_cents: null, score_model: "classic_fico", borrower_ids: ["B1"], all_occupying_first_time: true, all_borrowers_first_time: true, du_no_tradelines: false, closing_date: "2026-12-15" } }, UNDERWRITER);
  // 23.3: the risk assessment and the conditional approval (valid_until = the earliest expiring component)
  clock.set(isoEt("2026-11-03", "09:00"));
  const decisionId = `D-PA-${R}`;
  await tool(scope, "23.3", "assessRisk", { risk_input: { credit: { score_model: "classic_fico", representative_score: 742, history_summary: "no 30-day lates in 24 months" }, capacity: { dti_bps: 3300, residual_income_cents: "770000", income_sources: ["base_salary"], income_reconciled_to_22_3: true }, capital: { funds_to_close_cents: "11500000", reserves_months: 4, assets_reconciled_to_22_4: true }, collateral: { ltv_x100: 8000, cltv_x100: 8000, hcltv_x100: 8000, valuation_method: "traditional", cu_score: null }, du_risk_factors: [], eligibility_outside_du_confirmed: true, legal_compliance_confirmed: true }, decision_id: decisionId }, UNDERWRITER);
  const file = newDecisionFile({ application_id: casey.appId, partner_name: "Partner Bank", partner_address: "100 Partner Plaza, Phoenix, AZ 85004", creditor_time_zone: "America/New_York", application_date: "2026-11-02", property_state: "AZ", applicants: [{ id: "B1", name: CASEY.name, mailing_address: "7 Mesa Ct, Phoenix AZ 85018", email: CASEY.email, esign_consent: false, primary: true }] });
  const guard = { policy_outcome: "proceed", qm_facts: { qm_type: "general_safe_harbor", apr_test_pass: true, pf_pass: true, product_tests_pass: true, consider_verify_complete: true, consider_verify_missing: [], stage: "le", apor_stale: false, blocked_reason: null, computed_from_final_cd: false }, is_hoepa: false, is_state_high_cost: false, open_red_flag_investigations: 0 };
  const approval = await tool(scope, "23.3", "issueConditionalApproval", { decision_id: decisionId, file, guard, validity: { credit_expires_at: "2027-03-02", lock_expires_at: null, valuation_expires_at: null, du_close_by_date: null }, inputs: { ulad_snapshot_hash: built.output["request_hash"], verification_ids: [], findings_hash: "findings:sub1" }, du_submission_id: submission["submission_id"], interpretation_id: (interp.output["interpretation"] as { interpretation_id?: string } | undefined)?.interpretation_id, evidence_document_ids: [], rationale: "Approve/Eligible on a TBD property; income and credit within policy.", confidence: 0.93 }, UNDERWRITER);
  assert.equal(approval.output["valid_until"], "2027-02-01", "90 days from issuance is the earliest component");
  await settle(); casey.token = await fresh(CASEY);
  // DELTA-01: the flow issued the letter through 20.3 on the decision
  const issued = await events(casey.appId, "preapproval.letter.issued"); assert.equal(issued.length, 1);
  const p = issued[0]!.payload; assert.equal(p["kind"], "preapproval"); assert.equal(p["du_casefile_id"], casey.casefileId); assert.equal(p["approved_amount_cents"], "42000000"); assert.equal(p["valid_until"], "2027-02-01"); assert.equal(p["hmda_preapproval_program"], true); assert.equal(p["quote_id"], casey.quoteId);
  const l = await lead(casey.leadId); const pq = (l["prequalifications"] as Record<string, unknown>[]).find((x) => x["prequal_id"] === p["prequal_id"])!; assert.equal(pq["kind"], "preapproval"); assert.equal(pq["du_casefile_id"], casey.casefileId); assert.equal(String(pq["approved_amount_cents"]), "42000000"); assert.equal(pq["valid_until"], "2027-02-01"); assert.equal(pq["outcome"], "letter_issued");
  const row = (await db.query<{ kind: string; du_casefile_id: string; approved_amount_cents: string; valid_until: string }>(`SELECT kind, du_casefile_id, approved_amount_cents::text AS approved_amount_cents, valid_until::text AS valid_until FROM prequalifications WHERE lead_id = $1`, [casey.leadId]))[0];
  assert.ok(row, "the prequalifications row (0113 columns)"); assert.equal(row!.kind, "preapproval"); assert.equal(row!.du_casefile_id, casey.casefileId); assert.equal(row!.approved_amount_cents, "42000000"); assert.equal(row!.valid_until, "2027-02-01");
  const doc = (await db.query<{ metadata: Record<string, unknown> }>(`SELECT metadata FROM documents WHERE id = $1`, [p["letter_document_id"]]))[0]; assert.ok(doc, "the rendered letter as a documents row");
  const text = String(doc!.metadata["text"]);
  assert.match(text, /PREAPPROVAL LETTER/); assert.match(text, new RegExp(`by Partner Bank ${R} \\(NMLSR ID`), "partner.legal_name"); assert.match(text, /Jordan Rivera, NMLSR ID 987654/, "mlo.name and NMLSR ID"); assert.match(text, /valid through February 1, 2027/, "valid_until"); assert.match(text, /\$420,000\.00/, "the approved amount");
  assert.match(text, /general conditions: .*must appraise.*; no material change/, "the general conditions"); assert.doesNotMatch(text, /guarantee/i, "no occurrence of guarantee");
  const card = (await cardsOf(casey.appId, casey.partyId)).find((c) => c.kind === "DocumentCard" && c.copy_key === "preapproval.letter"); assert.ok(card, "the letter DocumentCard"); assert.equal(card!.props["requires_ack"], false); assert.equal(card!.props["notice_code"], "NTC_SM_PREAPPROVAL_LETTER"); assert.equal(card!.props["valid_until"], "2027-02-01");
  const rec = await record(casey.token, casey.appId); assert.equal((rec["status"] as { badge: string }).badge, "Preapproved");
  const letterDoc = (rec["documents"] as Record<string, unknown>[]).find((d) => d["notice_code"] === "NTC_SM_PREAPPROVAL_LETTER"); assert.ok(letterDoc, "the letter in Documents");
});

test("32.3-T28: Given a preapproved borrower sends a listing at a different price, then the payment estimate uses the approved quote id; if `SM_QUOTE_VALIDITY_GATE` is closed, the new rate renders only after `mlo.review.completed{approved}` (`assisted`).", { skip }, async () => {
  // Mon Nov 2, 15:00 ET: the approved quote is still inside its validity (the day's sheet runs to 17:00)
  clock.set(isoEt("2026-11-02", "15:00")); casey.token = await fresh(CASEY);
  const approved = (await entity("pricing_quotes", casey.quoteId))!; assert.ok(Date.parse(String(approved["valid_until"])) > Date.parse(clock.now()));
  const r1 = await api("POST", "/v1/borrower/messages", { text: "Send me the numbers for this listing: 9 Saguaro Way, Phoenix, AZ 85018 — $499,000", channel: "app" }, casey.token); assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal((r1.body["reply"] as Record<string, unknown>)["copy_key"], "preapproval.listing_numbers");
  const first = (await cardsOf(casey.appId, casey.partyId)).filter((c) => c.copy_key === "preapproval.listing_numbers"); assert.equal(first.length, 1);
  assert.equal(first[0]!.props["quote_id"], casey.quoteId, "the estimate uses the approved quote"); assert.equal(first[0]!.props["note_rate_pct"], approved["note_rate_pct"]); assert.equal(first[0]!.props["listing_price_cents"], "49900000"); assert.equal((first[0]!.props["property_pull"] as { vendor: string }).vendor, "FAKE");
  // Tue Nov 3: the quote's validity has passed (SM_QUOTE_VALIDITY_GATE closed) — today's pricing is re-solved and routed through the MLO review; no new rate renders before the approval
  await publishSheet(`rs-2026-11-03-${R}`, isoEt("2026-11-03", "06:35"), isoEt("2026-11-03", "17:00"), grid([["6.500", "101.875"], ["6.375", "101.375"], ["6.250", "100.875"], ["6.125", "100.375"], ["6.000", "99.750"]]));
  clock.set(isoEt("2026-11-03", "10:00")); casey.token = await fresh(CASEY);
  assert.ok(Date.parse(String(approved["valid_until"])) < Date.parse(clock.now()), "the approved quote has expired");
  const r2 = await api("POST", "/v1/borrower/messages", { text: "Another listing at $545,000: 12 Ocotillo Ln, Phoenix, AZ 85018", channel: "app" }, casey.token); assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.equal((r2.body["reply"] as Record<string, unknown>)["copy_key"], "preapproval.listing_pending");
  await settle();
  const requested = (await events(casey.appId, "terms.presentation.requested")).at(-1)!; const newQuoteId = String(requested.payload["quote_id"]); assert.notEqual(newQuoteId, casey.quoteId);
  const mid = await cardsOf(casey.appId, casey.partyId);
  assert.equal(mid.filter((c) => c.copy_key === "preapproval.listing_numbers").length, 1, "no new estimate before the review"); assert.ok(mid.some((c) => c.copy_key === "preapproval.listing_pending" && c.props["quote_id"] === newQuoteId)); assert.ok(mid.some((c) => c.copy_key === "terms.pending_mlo" && c.props["quote_id"] === newQuoteId));
  const t = await timer(casey.appId, "SM_MLO_PREAPP_TERMS_REVIEW_1BH"); assert.equal(t!.status, "armed");
  assert.equal(((await record(casey.token, casey.appId))["numbers"]), null, "no personal rate while the review is pending");
  clock.set(isoEt("2026-11-03", "10:30")); casey.token = await fresh(CASEY);
  await tool({ app: casey.appId }, "20.3", "requestQuote", { op: "review", lead_id: casey.leadId, quote_id: newQuoteId, review_id: `MR-C2-${R}`, outcome: "approved" }, MLO); await settle();
  const after = (await cardsOf(casey.appId, casey.partyId)).filter((c) => c.copy_key === "preapproval.listing_numbers"); assert.equal(after.length, 2);
  const freshCard = after.find((c) => c.props["quote_id"] === newQuoteId); assert.ok(freshCard, "the new rate renders only now"); assert.equal(freshCard!.props["listing_price_cents"], "54500000"); assert.ok(freshCard!.created_at >= isoEt("2026-11-03", "10:30"));
  assert.equal((await entity("pricing_quotes", newQuoteId))!["status"], "presented");
});

test("32.3-T29: Given a contract is uploaded, then extracted fields are written with `source = document_extraction` and `confirmed_at null` until Confirm; `application.trid_received` fires only after the address confirmation.", { skip }, async () => {
  dana.appId = await openBorrower(DANA, "purchase", null);
  clock.set(isoEt("2026-11-04", "09:00"));
  const s = await signIn(DANA.email); dana.token = s.token; dana.partyId = s.party_id; dana.leadId = dana.appId;
  await setGoal(dana.appId, dana.partyId, dana.token, "buy");
  // five of the six items before the contract: name, SSN, income, the value (target price) and the loan amount
  await command(dana.token, "application.confirmField", { path: "identity", fields: [{ path: "legal_name", value: DANA.name, source: "borrower" }], application_id: dana.appId });
  await command(dana.token, "application.confirmField", { path: "ssn", fields: [{ path: "ssn", value: "123-45-4444", source: "borrower" }], application_id: dana.appId });
  await command(dana.token, "application.confirmField", { path: "income", fields: [{ path: "monthly_base_cents", value: "1000000", source: "borrower" }], application_id: dana.appId });
  await command(dana.token, "application.confirmField", { path: "preapproval.target", fields: [{ path: "target_price_cents", value: "48000000", source: "borrower" }, { path: "down_payment_cents", value: "9600000", source: "borrower" }, { path: "loan_amount_sought", value: "38400000", source: "borrower" }], application_id: dana.appId });
  assert.equal((await events(dana.appId, "application.trid_received")).length, 0, "no address yet");
  // C1: the signed contract (the FAKE extractor reads the upload's own field list)
  const contract = { property_address: "9 Saguaro Way, Phoenix, AZ 85018", purchase_price_cents: "48000000", contract_date: "2026-11-03", closing_date: "2026-12-15", earnest_money_cents: "1000000", earnest_money_holder: "Desert Title Agency LLC", financing_contingency_date: "2026-11-24", appraisal_contingency_date: "2026-11-24", seller_concessions_cents: "500000", seller_names: ["S. Seller"] };
  clock.set(isoEt("2026-11-04", "09:20"));
  const up = await api("POST", "/v1/borrower/documents", { application_id: dana.appId, document_class: "purchase_contract", filename: "contract.json", mime_type: "application/json", content_base64: Buffer.from(JSON.stringify(contract)).toString("base64") }, dana.token);
  assert.equal(up.status, 201, JSON.stringify(up.body)); const documentId = up.body["document_id"] as string;
  await settle();
  assert.ok((await events(dana.appId, "document.classified")).some((e) => e.payload["document_id"] === documentId && e.payload["doc_class"] === "purchase_contract"));
  const extracted = (await events(dana.appId, "document.extracted")).find((e) => e.payload["document_id"] === documentId); assert.ok(extracted, "22.1's extraction"); assert.equal(extracted!.payload["extractor_version"], "FAKE-contract-extractor-2026.09");
  const x = (await db.query<{ data: unknown }>(`SELECT DISTINCT ON (id) data FROM entity_records WHERE kind = 'document_extractions' AND application_id = $1 ORDER BY id, version DESC`, [dana.appId])).map((r) => decodeEntityData(r.data)).find((d) => d["document_id"] === documentId)!;
  assert.equal((x["fields"] as Record<string, unknown>)["property_address"], contract.property_address);
  const card = await pendingCard(dana.appId, dana.partyId, "contract.confirm");
  const fields = card.props["fields"] as { path: string; value: string; source: string; confirmed_at: string | null }[];
  assert.ok(fields.length >= 8); for (const f of fields) { assert.equal(f.source, "document_extraction"); assert.equal(f.confirmed_at, null); }
  assert.equal(fields.find((f) => f.path === "property_address")!.value, contract.property_address); assert.equal(fields.find((f) => f.path === "purchase_price_cents")!.value, "48000000");
  assert.equal((await events(dana.appId, "application.trid_received")).length, 0, "extracted, not submitted"); assert.equal((await db.query(`SELECT 1 FROM purchase_contracts WHERE application_id = $1`, [dana.appId])).length, 0);
  assert.equal(((await entity("applications", dana.appId))!["six_items"] as Record<string, { submitted_at: string | null }>)["property_address"]!.submitted_at, null);
  // Confirm: the address completes the six items (C2)
  clock.set(isoEt("2026-11-04", "09:35"));
  const r = await resolve(dana.token, card.card_instance_id, fieldsEvidence(card)); assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok((r.body["events"] as string[]).includes("application.trid_received"), JSON.stringify(r.body["events"]));
  const trid = (await events(dana.appId, "application.trid_received"))[0]!; assert.equal(trid.payload["trid_received_at"], isoEt("2026-11-04", "09:35"));
  const pc = await entity("purchase_contracts", documentId); assert.ok(pc); assert.equal(((pc!["fields"] as Record<string, { source: string; confirmed_at: string }>)["property_address"]!).source, "document_extraction"); assert.equal(((pc!["fields"] as Record<string, { confirmed_at: string }>)["property_address"]!).confirmed_at, isoEt("2026-11-04", "09:35"));
  const row = (await db.query<{ sales_price_cents: string; closing_date: string; seller_concessions_cents: string }>(`SELECT sales_price_cents::text AS sales_price_cents, closing_date::text AS closing_date, seller_concessions_cents::text AS seller_concessions_cents FROM purchase_contracts WHERE application_id = $1`, [dana.appId]))[0]!;
  assert.equal(row.sales_price_cents, "48000000"); assert.equal(row.closing_date, "2026-12-15"); assert.equal(row.seller_concessions_cents, "500000");
  assert.equal(((await entity("applications", dana.appId))!["six_items"] as Record<string, { source: string }>)["property_address"]!.source, "borrower_confirmed_prefill");
  assert.ok(await timer(dana.appId, "REGZ_1026_19E1_LE_3BD"), "the LE clock starts with the address");
});

test("32.3-T30: Given SMS reply \"yes that's my income\" to a pending income `ConfirmCard`, then the card stays pending and the assistant replies with the deep link (32.1 §6.4).", { skip }, async () => {
  // Casey's payroll connection (fee SM-borne, pre-intent): the FAKE report lands → the income ConfirmCard waits for a tap
  clock.set(isoEt("2026-11-04", "10:00")); casey.token = await fresh(CASEY);
  const connect = await pendingCard(casey.appId, casey.partyId, "income.connect.purpose");
  assert.equal((await resolve(casey.token, connect.card_instance_id, { evidence: { vendor: "truv_income", started_at: clock.now() } })).status, 201);
  const vs = await api("POST", "/v1/borrower/connect/truv_income/session", { card_instance_id: connect.card_instance_id }, casey.token); assert.equal(vs.status, 200, JSON.stringify(vs.body));
  const hook = await api("POST", "/v1/webhooks/truv", { type: "voie.report.ready", data: { vendor_session_id: vs.body["vendor_session_id"] } }, undefined, { "x-truv-signature": "FAKE" }); assert.equal(hook.status, 200, JSON.stringify(hook.body));
  await settle();
  const income = await pendingCard(casey.appId, casey.partyId, "income.confirm.title"); casey.incomeCardId = income.card_instance_id;
  // the SMS reply: an affirmative answers no card — the deep link does (T-X-05; 32.1 §6.4)
  await db.query(`UPDATE parties SET contact = coalesce(contact, '{}'::jsonb) || $2::jsonb WHERE id = $1`, [casey.partyId, JSON.stringify({ phones: [CASEY.phone] })]);
  const sms = await signIn(CASEY.email, "sms", CASEY.phone); assert.equal(sms.party_id, casey.partyId);
  const r = await api("POST", "/v1/borrower/messages", { text: "yes that's my income", channel: "sms" }, sms.token); assert.equal(r.status, 200, JSON.stringify(r.body));
  const reply = r.body["reply"] as Record<string, unknown>;
  assert.equal(r.body["command_executed"], false); assert.equal(reply["copy_key"], "thread.card_affirmative_deep_link"); assert.equal(reply["card_instance_id"], income.card_instance_id); assert.equal(reply["channel"], "sms");
  const link = reply["deep_link"] as { token: string; path: string; expires_at: string }; assert.ok(link?.token); assert.equal(link.path, `/d/${link.token}`); assert.match(String(reply["body_text"]), new RegExp(`/d/${link.token}$`));
  const still = ((await cardsOf(casey.appId, casey.partyId)).find((c) => c.card_instance_id === income.card_instance_id))!; assert.equal(still.status, "pending"); assert.equal(still.evidence, null);
  assert.equal((await db.query(`SELECT 1 FROM application_income WHERE application_id = $1`, [casey.appId])).length, 0, "nothing committed from the text");
  // the link resolves to the card for the same party after L1
  const target = await api("GET", `/v1/borrower/deeplink/${link.token}`, undefined, sms.token); assert.equal(target.status, 200); assert.deepEqual(target.body["target"], { card_instance_id: income.card_instance_id });
});
