// 32.14 Entry, sign-up and sign-in
// spec/sections/32-borrower-experience/32-14-entry-sign-up-and-sign-in.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// The Phase 2 T-ids (T1–T7, T19) and the funnel (T18) drive the real runtime over HTTP: POST /v1/borrower/lead with the lead
// token carried as the proxy's `x-borrower-lead` header (src/runtime/borrower/lead-routes.ts), the 32.14 tools on the bus
// (src/app/tools/section32-14.ts → 20.3 set_fact / show_range, 31.1 readiness, 20.2's checklist), the OTP verify route with
// the lead cookie, and the 32.x flows (flows/3-entry.ts, flows/14-entry-lead.ts) reacting to the committed events; then the
// tables, the lead's own events and the borrower read models are asserted. The 31.1 registry rows that open AZ / CO / UT / CA
// are seeded as global entity rows (a state with no rows is unverified and fail-closed — NY). Skips without a database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { connect, reachable, type Db } from "../../infra/db/client.ts";
import { acquireJourneyLock, type TestLock } from "../../infra/db/test-lock.ts";
import { decodeEntityData, encodeEntityData } from "../../infra/db/entities.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock } from "../../kernel/events/index.ts";
import { Runtime } from "../../runtime/app.ts";
import { createApiServer, listen } from "../../runtime/server.ts";
import { createLogger } from "../../runtime/log.ts";
import { createBorrowerRouter, type BorrowerRouter } from "../../runtime/borrower/routes.ts";
// Phase 1 (the doors — T8–T12, T16, T17): Continue with Google through the FAKE provider, the passkey offer and the return visit, the deep link, the servicing-book borrower's code
import { readFileSync } from "node:fs";
import { generateKeyPairSync, randomBytes, sign as cryptoSign } from "node:crypto";
import { toJson } from "../../infra/db/client.ts";
import { DEEP_LINK_DAYS } from "../../infra/db/borrower-ui.ts";
import { FAKE_OIDC_MARKER, GOOGLE_ISSUERS, fakeOidcCode, fakeOidcSubject, type FakeOidcIdentity } from "../../infra/integrations/oidc.ts";
import { OIDC_MINUTES } from "../../runtime/borrower/oidc.ts";
import { PASSKEY_OFFER_COPY_KEY } from "../../runtime/borrower/flows/14-entry-sign-in.ts";
import { b64url } from "../../runtime/borrower/webauthn.ts";
import { Journey, MST } from "../../runtime/borrower/fixtures/journey.ts";
import { LEAD_HEADER } from "../../runtime/borrower/lead-routes.ts";
import { PgLeadTokenRepository } from "../../infra/db/lead-tokens.ts";
import { ALL_ALLOWED_FIELDS, FORBIDDEN_FIELDS, serialize } from "../../runtime/borrower/serialize.ts";
import { PgConsoleStore } from "../../console/pg-store.ts";
import { FUNNEL_STAGES } from "../../console/store.ts";
import { FakeEdelivery } from "../../infra/integrations/delivery.ts";   // T20: what the e-delivery FAKE texted to a number

const DB_URL = process.env["TEST_DATABASE_URL"] ?? "postgresql://sm:sm@localhost/supermortgage_test";
const up = await reachable(DB_URL);
if (!up && process.env["REQUIRE_DB"]) throw new Error(`REQUIRE_DB set but ${DB_URL} is not reachable`);
const skip = up ? false : `no Postgres at ${DB_URL}`;
const TOKEN = "ops-" + randomUUID();
const R = randomUUID().slice(0, 8);
const NOW = "2026-09-10T16:00:00.000Z";
const clock = new FixedClock(NOW);
const PRICING = { kind: "agent" as const, id: "pricing" };
const PARTNER_NMLSR = "123456";
const RATES = ["6.375", "6.250", "6.125", "6.000", "5.875"];   // the journey's 45-day FRM30 grid (src/runtime/borrower/fixtures/journey.ts)
const phoneOf = (seed: string): string => `+1602555${(parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 6), 16) % 10000).toString().padStart(4, "0")}`;
type Json = Record<string, unknown>;

let journeyLock: TestLock | undefined;
let db: Db; let runtime: Runtime; let router: BorrowerRouter; let base = ""; let close: () => Promise<void> = async () => undefined; let partnerPartyId = ""; let partnerName = ""; let guaranteedPartnerId = "";
let rateSheetId = "";

test.before(async () => {
  if (skip) return;
  journeyLock = await acquireJourneyLock(DB_URL);   // the rate sheet and the 31.1 registry rows are global rows
  execFileSync(fileURLToPath(new URL("../../../db/migrate.sh", import.meta.url)), { env: { ...process.env, DATABASE_URL: DB_URL }, stdio: "pipe" });
  db = connect(DB_URL);
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock });
  partnerName = `Partner Bank ${R}`;
  partnerPartyId = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id) VALUES ('servicer', $1, '123456789', '1000123') RETURNING id`, [partnerName]))[0]!.id;
  // T4's failing checklist: a partner whose name is a §1026.24 / MAP claim the 20.2 checklist refuses in an advertisement's footer
  guaranteedPartnerId = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id) VALUES ('servicer', $1, '123456790', '1000124') RETURNING id`, [`Guaranteed Home Bank ${R}`]))[0]!.id;
  process.env["BORROWER_DEFAULT_PARTNER_NMLSR_ID"] = PARTNER_NMLSR;
  const logger = createLogger("json", (line) => { if (process.env["FLOW_DEBUG"] && /flow|error|unhandled|lead|"status":[45]/i.test(line)) process.stderr.write(line + "\n"); });
  router = createBorrowerRouter({ runtime, logger, environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost"], urlSecret: "test-secret", defaultPartnerId: partnerPartyId });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger, console: false, borrowerRouter: router });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => { router.hub.close(); server.closeAllConnections?.(); server.close(() => db.end().then(() => resolve())); });
  await seedStateReadiness(["AZ", "CO", "UT", "CA"]);
  // the active rate sheet (20.4 publishRateSheet as the pricing agent): the range is its FRM30 low–high (20.3 rule 7)
  rateSheetId = `rs-t32-14-${R}`;
  await runtime.execute({ process: "20.4", name: "publishRateSheet", loanId: "", actor: PRICING, input: { rate_sheet_id: rateSheetId, partner_id: partnerPartyId, source: "pe_whole_loan_api", published_at: NOW, expires_at: new Date(Date.parse(NOW) + 12 * 3_600_000).toISOString(), prices: RATES.map((r) => ({ product_code: "FRM30", term_months: 360, note_rate_pct: r, lock_period_days: 45, price: "100.000" })) } });
});
test.after(async () => { if (!skip) { await close(); await journeyLock?.release(); } });

// ---------------------------------------------------------------- the 31.1 registry rows that open a state (global entity rows; a state with none is unverified → closed)
async function seedStateReadiness(states: readonly string[]): Promise<void> {
  const put = async (kind: string, id: string, data: Json): Promise<void> => { await db.query(`INSERT INTO entity_records (kind, id, version, loan_id, application_id, data, updated_at, updated_by) VALUES ($1, $2, 1, NULL, NULL, $3::jsonb, $4, 'system:test-32-14') ON CONFLICT DO NOTHING`, [kind, id, encodeEntityData(data), NOW]); };
  const license = (id: string, over: Json): Json => ({ license_id: id, nmls_id: `N-${id}`, authority_citation: "state statute", status: "approved", issued_at: "2025-01-05", expires_at: "2027-12-31", renewal_window_opens: null, renewal_requested_at: null, renewed_at: null, reinstatement_deadline: null, sponsor_license_id: null, bond_amount_cents: null, bond_expires_at: null, qualifying_individual_id: null, evidence_document_id: "DOC-EVIDENCE-32-14", nmls_status_raw: "Approved", ce_completed_at: "2026-06-01", ce_hours: 8, ...over });
  const requirement = (st: string, applies_to: "partner" | "sm", activity: string, requirement_kind: string, code: string | null): Json => ({ requirement_id: `R-${st}-${applies_to}-${activity}-32-14`, jurisdiction: st, activity, applies_to, requirement_kind, license_type_code: code, citation: `${st} statute`, quoted_text: "…", verification_status: "verified", verified_at: "2026-01-15", verified_by: "u-counsel", source_url: null, effective_from: "2026-01-01", superseded_by: null });
  for (const st of states) {
    await put("licenses", `L-${st}-PARTNER-32-14`, license(`L-${st}-PARTNER-32-14`, { holder_kind: "partner_company", holder_ref: partnerPartyId, jurisdiction: st, license_type_code: `${st}_LENDER`, activity_scope: ["lend"] }));
    await put("licenses", `L-${st}-MLO-32-14`, license(`L-${st}-MLO-32-14`, { holder_kind: "partner_individual", holder_ref: "p-mlo-32-14", jurisdiction: st, license_type_code: `${st}_MLO`, activity_scope: ["mlo_individual"], sponsor_license_id: `L-${st}-PARTNER-32-14` }));
    for (const r of [requirement(st, "partner", "lend", "license", `${st}_LENDER`), requirement(st, "partner", "mlo_individual", "license", `${st}_MLO`), requirement(st, "sm", "processing_underwriting_entity", "none", null)]) await put("license_requirements", String(r["requirement_id"]), r);
    await put("ai_intake_legal_positions", `${st}-32-14`, { jurisdiction: st, position: "assisted_required", memo_document_id: `DOC-AI-${st}`, counsel: "u-counsel", issued_at: "2026-08-01", review_due_at: "2027-08-01" });
  }
  await put("mlo_roster", "M-32-14", { mlo_id: "M-32-14", person_id: "p-mlo-32-14", name: "Jordan Rivera", nmls_id: "N-987654", employer: "partner", sponsor_license_id: null, state_licenses: states.map((st) => `L-${st}-MLO-32-14`), states_assignable: [...states], lo_comp_plan_id: "LOCOMP-1", capacity_per_day: 10, status: "active", assignable: true, open_queue: 0 });
}

// ---------------------------------------------------------------- helpers over the lead API (the proxy's header carries the cookie's token)
type Reply = { status: number; body: Json };
async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text(); return { status: r.status, body: text ? (JSON.parse(text) as Json) : {} };
}
const withLead = (token: string): Record<string, string> => ({ [LEAD_HEADER]: token });
async function startLead(extra: Json = {}): Promise<{ token: string; id: string; body: Json }> {
  const r = await api("POST", "/v1/borrower/lead", { action: "start", channel: "web_chat", ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.body)); return { token: r.body["lead_token"] as string, id: r.body["lead_id"] as string, body: r.body };
}
const answer = (token: string, step: string, value: unknown): Promise<Reply> => api("POST", "/v1/borrower/lead", { action: "answer", step, value }, withLead(token));
const range = (token: string): Promise<Reply> => api("POST", "/v1/borrower/lead", { action: "range" }, withLead(token));
const state = (token: string): Promise<Reply> => api("POST", "/v1/borrower/lead", { action: "state" }, withLead(token));
const settle = () => router.flows!.settle();
const entity = async (kind: string, id: string): Promise<Json | null> => { const rows = await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = $1 AND id = $2`, [kind, id]); return rows[0] ? decodeEntityData(rows[0].data) : null; };
const entityVersion = async (kind: string, id: string): Promise<number> => Number((await db.query<{ v: string }>(`SELECT version::text AS v FROM entity_current WHERE kind = $1 AND id = $2`, [kind, id]))[0]?.v ?? 0);
type Ev = { type: string; sequence: string; occurred_at: string; payload: Json };
/** The lead's own events: its aggregate, and the ones the owning processes key on the lead's id (31.1's gate, 21.6's pre-use notice). */
const leadEvents = (leadId: string): Promise<Ev[]> => db.query<Ev & Record<string, unknown>>(`SELECT type, sequence::text AS sequence, occurred_at, payload FROM loan_events WHERE (aggregate_kind = 'lead' AND aggregate_id = $1) OR payload->>'lead_id' = $1 OR payload->>'application_id' = $1 ORDER BY loan_events.sequence`, [leadId]);   // the qualified input column: a bare `sequence` would name the text alias and sort "105" before "89"
const seqOf = (evs: readonly Ev[], type: string, nth = 0): number => { const e = evs.filter((x) => x.type === type)[nth]; assert.ok(e, `${type}[${nth}] logged`); return Number(e.sequence); };
const count = async (table: string): Promise<number> => Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`))[0]!.n);
/** A refinance lead through the chips up to (and including) the estimate: goal · occupancy · state · estimate. */
async function refiLead(st: string, goal: "lower_rate" | "cash_out" = "lower_rate", opts: { estimate?: boolean } = {}): Promise<{ token: string; id: string }> {
  const l = await startLead();
  for (const [step, value] of [["goal", goal], ["occupancy", "primary"], ["state", st]] as const) { const r = await answer(l.token, step, value); assert.equal(r.status, 200, `${step}: ${JSON.stringify(r.body)}`); }
  if (opts.estimate !== false) { const r = await answer(l.token, "estimate", { value_estimate_cents: "50000000", stated_existing_balance_cents: "30000000" }); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body["step"], null); }
  return l;
}
const options = (step: Json | null): string[] => ((step?.["options"] as { id: string }[] | undefined) ?? []).map((o) => o.id);

// ---------------------------------------------------------------- Phase 1 (the doors): the servicing book's borrowers and the sign-in helpers
// The journey fixture's refi-trigger application (Alex / Blake with contact e-mails on application_borrowers — the servicing book's borrowers)
// through the interview and the LE, so the Record has figures behind L2; NO ONE signs in before the T-ids do: Alex's FIRST session ever is T8's Google sign-in.
const INTAKE = { kind: "agent" as const, id: "intake" };
const EMAIL_A = `alex-${R}@example.test`; const EMAIL_B = `blake-${R}@example.test`;
const ALEX_PHONE = phoneOf(`alex-${R}`);
/** The app's callback page under the allowed origin (the FAKE provider's "authorization URL" is this page carrying the FAKE code). */
const REDIRECT_URI = "http://localhost/app/auth/google/callback";
const COPY_MD = `${fileURLToPath(new URL("../../../", import.meta.url))}spec/sections/32-borrower-experience/copy-library.md`;
let journey: Journey;
const alex = { partyId: "", token: "", sessionId: "", sub: "" };
const blake = { partyId: "", token: "", sub: `1${R.replace(/\D/g, "").padEnd(20, "7").slice(0, 20)}` };
let journeyOnce: Promise<void> | undefined;
/** The servicing book's journey, seeded on first use by the Phase 1 T-ids (top-level `before` hooks start concurrently, so this is lazy rather than a second hook). */
const journeyReady = (): Promise<void> => (journeyOnce ??= (async () => {
  journey = new Journey({ runtime, db, base, token: TOKEN, clock, borrowerEmail: EMAIL_A, coBorrowerEmail: EMAIL_B, partnerPartyId });
  const was = clock.now();
  await journey.seedBook(); await journey.openApplication(); await journey.interview(); await journey.quoteAndLe(); await settle();
  alex.sub = fakeOidcSubject(EMAIL_A);
  clock.set(was);   // the journey moved the clock; the T-ids set their own
})());
/** The session-authenticated borrower API (a bearer, the way the app's proxy forwards the cookie). */
const sapi = (method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}): Promise<Reply> => api(method, path, body, { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers });
/** A one-time code (the FAKE e-delivery echoes it): an L1 session with `last_l1_at`. */
async function signIn(destination: string, channel: "email" | "sms" = "email"): Promise<{ token: string; party_id: string; session_id: string; level: string; body: Json }> {
  const req = await sapi("POST", "/v1/borrower/auth/otp", { action: "request", channel, destination });
  assert.equal(req.status, 200, JSON.stringify(req.body));
  const ver = await sapi("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: req.body["challenge_id"], code: req.body["fake_code"] });
  assert.equal(ver.status, 200, JSON.stringify(ver.body));
  return { token: ver.body["token"] as string, party_id: (ver.body["party"] as { party_id: string }).party_id, session_id: (ver.body["session"] as { session_id: string }).session_id, level: String(ver.body["level"]), body: ver.body };
}
/** Continue with Google, step 1: `start` with the FAKE identity hint → the authorization URL (the app's callback carrying the FAKE code) and the state. */
async function oidcStart(fake: FakeOidcIdentity, extra: Json = {}): Promise<Reply & { code: string; state: string }> {
  const r = await sapi("POST", "/v1/borrower/auth/oidc", { action: "start", provider: "google", redirect_uri: REDIRECT_URI, fake, ...extra });
  if (r.status !== 200) return { ...r, code: "", state: "" };
  const u = new URL(r.body["authorization_url"] as string);
  return { ...r, code: u.searchParams.get("code") ?? "", state: u.searchParams.get("state") ?? "" };
}
/** Step 2: the callback page posts {code, state} with the FAKE marker (the app sends it in fake/dev mode only). */
const oidcCallback = (code: string, oauthState: string, opts: { marker?: string | null } = {}): Promise<Reply> => sapi("POST", "/v1/borrower/auth/oidc", { action: "callback", provider: "google", code, state: oauthState }, undefined, opts.marker === null ? {} : { "x-fake-oidc": opts.marker ?? FAKE_OIDC_MARKER });
/** The whole Google round trip for a canned identity. */
async function google(fake: FakeOidcIdentity): Promise<Reply & { state: string }> { const s = await oidcStart(fake); assert.equal(s.status, 200, JSON.stringify(s.body)); const r = await oidcCallback(s.code, s.state); await settle(); return { ...r, state: s.state }; }
const challengeByState = async (oauthState: string) => (await db.query<{ challenge_id: string; kind: string; provider: string | null; party_id: string | null; nonce: string | null; code_verifier_hash: string | null; destination: string | null; consumed_at: string | null; expires_at: string }>(`SELECT challenge_id, kind, provider, party_id, nonce, code_verifier_hash, destination, consumed_at, expires_at FROM auth_challenges WHERE kind = 'oidc' AND challenge = $1`, [oauthState]))[0];
const identityOf = async (sub: string) => (await db.query<{ party_id: string; issuer: string; subject: string; email: string | null; email_verified: boolean; name: string | null; revoked_at: string | null }>(`SELECT party_id, issuer, subject, email, email_verified, name, revoked_at FROM oidc_identities WHERE issuer = $1 AND subject = $2`, [GOOGLE_ISSUERS[0], sub]))[0];
const partiesWithEmail = async (email: string): Promise<number> => Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM parties WHERE party_type = 'borrower' AND lower(contact->>'email') = lower($1)`, [email]))[0]!.n);
const messagesOf = (partyId: string) => db.query<{ message_id: string; at: string; sender: string; channel: string; body_text: string | null; card_instance_id: string | null }>(`SELECT m.message_id, m.at, m.sender, m.channel, m.body_text, m.card_instance_id FROM messages m JOIN conversations c ON c.conversation_id = m.conversation_id WHERE c.party_id = $1 ORDER BY m.at, m.created_at, m.message_id`, [partyId]);
const record = async (token: string, subject: string): Promise<Json> => { await settle(); const r = await sapi("GET", `/v1/borrower/record?subject=${subject}`, undefined, token); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 600)); return r.body; };
const thread = async (token: string): Promise<{ messages: Json[]; pinned: Json | null }> => { await settle(); const r = await sapi("GET", "/v1/borrower/thread?limit=500", undefined, token); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300)); return { messages: r.body["messages"] as Json[], pinned: (r.body["pinned_card"] as Json | null) ?? null }; };
const appEvents = (appId: string, type?: string) => db.query<{ type: string; payload: Json }>(`SELECT type, payload FROM loan_events WHERE application_id = $1 AND ($2::text IS NULL OR type = $2) ORDER BY sequence`, [appId, type ?? null]);
/** A copy key's text as the generated library states it (the shell renders the key; the API answers its own error keys — the 32.14 names are asserted by text). */
function copyText(key: string): string {
  const line = readFileSync(COPY_MD, "utf8").split("\n").find((l) => l.startsWith(`- \`${key}\` —`));
  assert.ok(line, `copy key ${key} is in the library`);
  const m = /— "((?:[^"\\]|\\.)*)"/.exec(line!); assert.ok(m, `copy key ${key} has a text`); return m![1]!;
}
/** Cards through 32.1's `send_card` as the intake agent (the flows' own seam). */
async function sendCard(partyId: string, appId: string, kind: string, copy_key: string, props: Json): Promise<string> {
  const r = await runtime.execute({ process: "32.1", name: "send_card", loanId: "", applicationId: appId, actor: INTAKE, run: { runId: "test:32.14", modelVersion: "harness", promptVersion: "32.14" },
    input: { party_id: partyId, kind, copy_key, props: { ...props, flow_key: `t14:${kind}:${randomUUID().slice(0, 8)}`, flow: "32.14-harness" }, command_ref: null, subject: { application_id: appId }, created_by: "agent:intake", rationale: `32.14 harness ${kind}` } });
  await settle(); return (r.output as { card_instance_id: string }).card_instance_id;
}
// a tiny CBOR encoder for the WebAuthn fixture (the server decodes; a real authenticator encodes)
type C = number | string | Buffer | CList | CMap | CObj;
interface CList extends Array<C> {}
interface CMap extends Map<C, C> {}
interface CObj { [k: string]: C; }
function cbor(v: C): Buffer {
  const head = (major: number, n: number): Buffer => n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : n < 65536 ? Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]) : Buffer.concat([Buffer.from([(major << 5) | 26]), Buffer.from(new Uint32Array([n]).buffer).reverse()]);
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") { const b = Buffer.from(v, "utf8"); return Buffer.concat([head(3, b.length), b]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  const entries = Object.entries(v); return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}
const sha = (s: string | Buffer): Buffer => createHash("sha256").update(s).digest();
const clientData = (type: string, challenge: string): string => b64url.encode(Buffer.from(JSON.stringify({ type, challenge, origin: "http://localhost" })));

test("32.14-T1: Given a new browser with no cookies, when `/app` renders, then the first assistant content is `entry.disclosure.first`, a `leads` row exists at `L0_contact_unverified` with `party_id = null`, `lead.disclosure.delivered` and `consent.granted{kind=ai_disclosure_ack}` precede any other lead event, no `sessions` row exists, and the next step is the goal card with exactly `buy`, `lower_rate`, `cash_out`.", { skip }, async () => {
  const sessionsBefore = await count("sessions"); const partiesBefore = await count("parties");
  const r = await api("POST", "/v1/borrower/lead", { action: "start", channel: "web_chat" });   // no cookie, no session: the root's first render
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const token = r.body["lead_token"]; const leadId = r.body["lead_id"] as string;
  assert.ok(typeof token === "string" && token.length > 30 && typeof leadId === "string", "the API answers the lead token once (the proxy turns it into the sm_borrower_lead cookie) and the lead id");
  // the first assistant content is the disclosure, with the automation marker, before anything else
  const lines = r.body["lines"] as Json[];
  assert.ok(lines.length >= 1, "a line"); assert.equal(lines[0]!["copy_key"], "entry.disclosure.first"); assert.equal(lines[0]!["automation_marker"], true); assert.equal(lines[0]!["sender"], "agent");
  assert.deepEqual(r.body["partner"], { legal_name: partnerName, nmlsr_id: PARTNER_NMLSR });
  // the next step is the goal card with exactly the three tiles, nothing preselected
  const step = r.body["step"] as Json; assert.equal(step["id"], "goal"); assert.equal(step["kind"], "ChoiceCard"); assert.equal(step["copy_key"], "entry.goal.question");
  assert.deepEqual(options(step), ["buy", "lower_rate", "cash_out"]); assert.equal(step["preselected"], null);
  // the leads row: L0, party-less
  const lead = await entity("leads", leadId); assert.ok(lead, "a leads row");
  assert.equal(lead["assurance_level"], "L0_contact_unverified"); assert.equal(lead["party_id"], null); assert.equal(lead["channel"], "organic"); assert.equal(lead["status"], "disclosed");
  // lead.disclosure.delivered and consent.granted{ai_disclosure_ack} precede any other lead event (only the lead's creation and the interaction's start come before them)
  const evs = await leadEvents(leadId); const types = evs.map((e) => e.type);
  const disclosure = seqOf(evs, "lead.disclosure.delivered"); const consent = evs.find((e) => e.type === "consent.granted" && e.payload["kind"] === "ai_disclosure_ack"); assert.ok(consent, "consent.granted{kind=ai_disclosure_ack}");
  assert.ok(Number(consent.sequence) > disclosure, "the acknowledgment follows the delivery");
  for (const e of evs) if (Number(e.sequence) < disclosure) assert.ok(["lead.created", "lead.interaction.started"].includes(e.type), `${e.type} before the disclosure`);
  assert.ok(!types.some((t) => /^lead\.(goal|state|estimate)\.set$|^lead\.range\.shown$|^lead\.authenticated$/.test(t)), "no substantive lead event yet");
  // no session, no party: the anonymous minute lives on the lead alone
  assert.equal(await count("sessions"), sessionsBefore); assert.equal(await count("parties"), partiesBefore);
  const tokens = await new PgLeadTokenRepository(db).byLead(leadId); assert.equal(tokens.length, 1); assert.equal(tokens[0]!.linked_party_id, null); assert.equal(tokens[0]!.partner_party_id, partnerPartyId);
  // the token is never echoed again: a reload (the cookie's header) answers the same state without it
  const again = await state(token as string); assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.ok(!("lead_token" in again.body)); assert.equal(again.body["lead_id"], leadId); assert.equal((again.body["step"] as Json)["id"], "goal"); assert.equal((again.body["lines"] as Json[])[0]!["copy_key"], "entry.disclosure.first");
  // a second start with a live cookie answers that lead, never a second one
  const second = await api("POST", "/v1/borrower/lead", { action: "start", channel: "web_chat" }, withLead(token as string)); assert.equal(second.status, 200); assert.equal(second.body["lead_id"], leadId); assert.ok(!("lead_token" in second.body));
});

test("32.14-T2: Given the lead answers state `CO`, then `co_admt.preuse_notice.delivered` is logged before `lead.range.shown`; given `UT` or `CA`, then a second `lead.disclosure.delivered{state_variant}` is logged before the next chip.", { skip }, async () => {
  // Colorado: the pre-use notice at the state step, before anything priced
  const co = await refiLead("CO");
  const coRange = await range(co.token); assert.equal(coRange.status, 200, JSON.stringify(coRange.body)); assert.ok(coRange.body["range"], "a range for CO");
  const coEvs = await leadEvents(co.id);
  assert.ok(seqOf(coEvs, "co_admt.preuse_notice.delivered") < seqOf(coEvs, "lead.range.shown"), "the pre-use notice precedes the range");
  assert.ok(seqOf(coEvs, "lead.state.set") < seqOf(coEvs, "co_admt.preuse_notice.delivered"), "the notice follows the state answer");
  // Utah and California: the disclosure re-delivered with the state variant, logged before the next chip (the estimate)
  for (const [st, variant] of [["UT", "ut_high_risk_upfront"], ["CA", "ca_admt_preuse"]] as const) {
    const l = await startLead();
    for (const [step, value] of [["goal", "lower_rate"], ["occupancy", "primary"]] as const) assert.equal((await answer(l.token, step, value)).status, 200);
    const r = await answer(l.token, "state", st); assert.equal(r.status, 200, JSON.stringify(r.body));
    const relogged = (r.body["lines"] as Json[]).find((x) => x["copy_key"] === "entry.disclosure.first"); assert.ok(relogged, `${st}: the re-delivered disclosure is a line of the state answer`);
    assert.equal((r.body["step"] as Json)["id"], "estimate", `${st}: the next chip follows`);
    const est = await answer(l.token, "estimate", { value_estimate_cents: "50000000", stated_existing_balance_cents: "30000000" }); assert.equal(est.status, 200, JSON.stringify(est.body));
    const evs = await leadEvents(l.id); const delivered = evs.filter((e) => e.type === "lead.disclosure.delivered");
    assert.equal(delivered.length, 2, `${st}: two deliveries`); assert.equal(delivered[1]!.payload["state_variant"], variant); assert.equal(delivered[0]!.payload["state_variant"], null);
    assert.ok(Number(delivered[1]!.sequence) > seqOf(evs, "lead.state.set") && Number(delivered[1]!.sequence) < seqOf(evs, "lead.estimate.set"), `${st}: the second delivery sits between the state and the next chip`);
  }
});

test("32.14-T3: Given the lead answers state `NY`, then `licensing.gate.blocked{state=NY}` is logged, the lead is `closed_lost{reason=state_not_licensed}`, the reply is `lead.state_closed`, and no range and no identity ask are rendered.", { skip }, async () => {
  const l = await startLead();
  for (const [step, value] of [["goal", "lower_rate"], ["occupancy", "primary"]] as const) assert.equal((await answer(l.token, step, value)).status, 200);
  const r = await answer(l.token, "state", "NY"); assert.equal(r.status, 200, JSON.stringify(r.body));
  // the reply is lead.state_closed, with the state token; no further step
  const closed = r.body["closed"] as Json; assert.equal(closed["reason"], "state_not_licensed"); assert.equal(closed["copy_key"], "lead.state_closed"); assert.equal(closed["state"], "NY");
  const line = (r.body["lines"] as Json[]).find((x) => x["copy_key"] === "lead.state_closed"); assert.ok(line, "the lead.state_closed line"); assert.equal((line["copy_tokens"] as Json)["state"], "NY");
  assert.equal(r.body["step"], null);
  // the gate and the lead's own record
  const evs = await leadEvents(l.id); const blocked = evs.find((e) => e.type === "licensing.gate.blocked"); assert.ok(blocked, "licensing.gate.blocked");
  assert.equal(blocked.payload["state"], "NY"); assert.equal(blocked.payload["gate"], "SM_LICENSE_STATE_GATE"); assert.equal(blocked.payload["lead_id"], l.id);
  const lead = await entity("leads", l.id); assert.equal(lead!["status"], "closed_lost"); assert.equal(lead!["closed_reason"], "state_not_licensed");
  assert.ok(evs.some((e) => e.type === "lead.closed" && e.payload["reason"] === "state_not_licensed"), "lead.closed{reason=state_not_licensed}");
  // no range and no identity ask: the give-back refuses (STATE_GATE_FIRST) and the reload shows the closed state alone
  const rg = await range(l.token); assert.equal(rg.status, 409, JSON.stringify(rg.body)); assert.equal(rg.body["code"], "STATE_GATE_FIRST"); assert.ok(!("next" in rg.body) && !("range" in rg.body));
  assert.ok(!evs.some((e) => e.type === "lead.range.shown"));
  const st = await state(l.token); assert.equal(st.status, 200); assert.equal(st.body["step"], null); assert.equal(st.body["range"], null); assert.equal((st.body["closed"] as Json)["reason"], "state_not_licensed");
  assert.ok(!JSON.stringify(st.body).includes("auth.choose_method"), "no identity ask");
  // nothing further is written on a closed lead
  const again = await answer(l.token, "estimate", { value_estimate_cents: "50000000", stated_existing_balance_cents: "30000000" }); assert.equal(again.status, 409); assert.ok(["STATE_GATE_FIRST", "LEAD_CLOSED"].includes(String(again.body["code"])), JSON.stringify(again.body));
});

test("32.14-T4: Given the active rate sheet, when the range renders, then `lead.range.shown` carries the sheet's `FRM30` low and high, the rendered text contains an APR beside each rate and the not-a-commitment footer, `regz_1026_24.apr_stated = true` in the checklist result, and no tier, LLPA or borrower-specific figure appears; given the checklist fails, then no range is shown and the identity ask still renders.", { skip }, async () => {
  const l = await refiLead("AZ");
  const r = await range(l.token); assert.equal(r.status, 200, JSON.stringify(r.body));
  const rg = r.body["range"] as Json; assert.ok(rg, "a range");
  const low = RATES.map(Number).sort((a, b) => a - b); const [sheetLow, sheetHigh] = [low[0]!.toFixed(3), low[low.length - 1]!.toFixed(3)];
  assert.equal(rg["product_code"], "FRM30"); assert.equal(rg["rate_sheet_id"], rateSheetId);
  assert.equal(rg["low_pct"], sheetLow); assert.equal(rg["high_pct"], sheetHigh);
  for (const k of ["low_pct", "high_pct", "apr_low_pct", "apr_high_pct"]) assert.ok(typeof rg[k] === "string" && /^\d+\.\d+$/.test(rg[k] as string), `${k} is a decimal string, never a number`);
  // lead.range.shown carries the sheet's low and high, the APRs, the product, the sheet and the checklist run
  const evs = await leadEvents(l.id); const shown = evs.find((e) => e.type === "lead.range.shown"); assert.ok(shown, "lead.range.shown");
  assert.equal(shown.payload["low_pct"], sheetLow); assert.equal(shown.payload["high_pct"], sheetHigh); assert.equal(shown.payload["product_code"], "FRM30"); assert.equal(shown.payload["rate_sheet_id"], rateSheetId);
  assert.equal(shown.payload["apr_low_pct"], rg["apr_low_pct"]); assert.equal(shown.payload["apr_high_pct"], rg["apr_high_pct"]); assert.ok(typeof shown.payload["checklist_run_id"] === "string");
  // the rendered text: an APR beside each rate, the not-a-commitment footer, the partner and NMLSR ID
  const text = String(rg["text"]);
  for (const rate of [sheetLow, sheetHigh]) { const i = text.indexOf(`${rate}%`); assert.ok(i >= 0, `${rate}% in the text`); assert.ok(/(APR|annual percentage rate)/i.test(text.slice(i, i + 80)), `an APR beside ${rate}%: ${text.slice(i, i + 80)}`); }
  assert.match(text, /not a commitment/i); assert.match(text, /rates change daily/i); assert.ok(text.includes(partnerName)); assert.ok(text.includes(`NMLSR ID ${PARTNER_NMLSR}`));
  // the checklist result: regz_1026_24.apr_stated = true (20.2's own run, kept with its id)
  const run = await entity("content_checklist_runs", String(shown.payload["checklist_run_id"])); assert.ok(run, "the checklist run");
  const checklist = run["checklist"] as Json; assert.equal((checklist["regz_1026_24"] as Json)["apr_stated"], true); assert.equal((checklist["regz_1026_24"] as Json)["not_a_commitment"], true); assert.equal((checklist["regz_1026_24"] as Json)["d2_disclosures_present"], true);
  assert.deepEqual(run["failures"], []); assert.equal(run["passes"], true);
  // no tier, LLPA or borrower-specific figure: the published range alone (a dollar figure, a score, a tier or an LLPA never appears; the card is not personal)
  assert.doesNotMatch(text, /\btier\b|\bllpa\b|\$\s?\d|\bscore\b|\bpayment of\b/i);
  const card = r.body["card"] as Json; assert.equal(card["kind"], "StatusCard"); assert.equal(card["copy_key"], "entry.range.card"); assert.equal(card["personal_terms"], false);
  assert.equal(r.body["promise_copy_key"], "entry.range.promise"); assert.equal(r.body["disclaimer_copy_key"], "entry.range.disclaimer");
  const next = r.body["next"] as Json; assert.equal(next["id"], "identify"); assert.equal(next["copy_key"], "auth.choose_method");
  for (const k of Object.keys(shown.payload)) assert.ok(!FORBIDDEN_FIELDS.includes(k), k);
  // the checklist fails (a partner whose name is a guarantee claim in the footer): no range is shown, the identity ask still renders
  const g = await startLead({ referral: { partner_party_id: guaranteedPartnerId } });
  for (const [step, value] of [["goal", "lower_rate"], ["occupancy", "primary"], ["state", "AZ"]] as const) assert.equal((await answer(g.token, step, value)).status, 200);
  assert.equal((await answer(g.token, "estimate", { value_estimate_cents: "50000000", stated_existing_balance_cents: "30000000" })).status, 200);
  const refused = await range(g.token); assert.equal(refused.status, 200, JSON.stringify(refused.body));
  assert.equal(refused.body["range"], null); assert.equal(refused.body["refused"], "RANGE_CONTENT_CHECK"); assert.equal(refused.body["card"], null);
  assert.equal((refused.body["next"] as Json)["id"], "identify"); assert.equal((refused.body["next"] as Json)["copy_key"], "auth.choose_method");
  assert.ok(!(await leadEvents(g.id)).some((e) => e.type === "lead.range.shown"), "no range shown on the refused lead");
});

test("32.14-T5: Given the goal tiles, then each resolves to exactly one `transaction_type` (`purchase`, `limited_cash_out`, `cash_out`); Buy asks contract status; refi and cash-out ask occupancy with no default tapped.", { skip }, async () => {
  const tiles = { buy: "purchase", lower_rate: "limited_cash_out", cash_out: "cash_out" } as const;
  const start = await startLead(); const goalStep = start.body["step"] as Json;
  assert.deepEqual((goalStep["options"] as Json[]).map((o) => [o["id"], o["transaction_type"]]), Object.entries(tiles), "each tile names exactly one transaction_type");
  for (const [tile, transaction_type] of Object.entries(tiles)) {
    const l = await startLead();
    const r = await answer(l.token, "goal", tile); assert.equal(r.status, 200, JSON.stringify(r.body));
    const lead = await entity("leads", l.id); assert.equal(lead!["transaction_intent"], transaction_type, tile);
    const set = (await leadEvents(l.id)).find((e) => e.type === "lead.goal.set"); assert.ok(set, "lead.goal.set"); assert.equal(set.payload["transaction_intent"], transaction_type);
    const step = r.body["step"] as Json;
    if (tile === "buy") { assert.equal(step["id"], "contract"); assert.equal(step["copy_key"], "entry.buy.contract_question"); assert.deepEqual(options(step), ["signed", "looking"]); }
    else { assert.equal(step["id"], "occupancy"); assert.equal(step["copy_key"], "entry.occupancy.question"); assert.deepEqual(options(step), ["primary", "second_home", "investment"]); }
    // no default tapped: nothing preselected, no option marked, the fact stays empty until the tap
    assert.equal(step["preselected"], null); for (const o of step["options"] as Json[]) assert.ok(!o["is_primary"] && !o["selected"] && !o["default"], JSON.stringify(o));
    assert.equal(lead!["occupancy"], null); assert.equal(lead!["contract_status"], null);
    // the tap is required: the state is refused before the chip is answered (STEP_ORDER), and the chip resolves once tapped
    const early = await answer(l.token, "state", "AZ"); assert.equal(early.status, 409, JSON.stringify(early.body)); assert.equal(early.body["code"], "STEP_ORDER");
    const tap = await answer(l.token, tile === "buy" ? "contract" : "occupancy", tile === "buy" ? "looking" : "primary"); assert.equal(tap.status, 200, JSON.stringify(tap.body)); assert.equal((tap.body["step"] as Json)["id"], "state");
    const after = await entity("leads", l.id); if (tile === "buy") assert.equal(after!["contract_status"], "looking"); else assert.equal(after!["occupancy"], "primary");
  }
  // a cash-out estimate carries the 80% cap as a plain limit (a decimal string), never a decline; a purchase estimate asks the price range and down payment
  const cash = await refiLead("AZ", "cash_out", { estimate: false }); const cashState = await state(cash.token); const est = cashState.body["step"] as Json;
  assert.equal(est["id"], "estimate"); assert.deepEqual(est["limit"], { max_ltv_pct: "80" }); assert.ok(!("copy_key" in est), "the estimate step names no copy_key of its own"); assert.deepEqual((est["fields"] as Json[]).map((f) => f["id"]), ["value_estimate_cents", "stated_existing_balance_cents"]);
  const buy = await startLead(); for (const [step, value] of [["goal", "buy"], ["contract", "signed"], ["state", "AZ"]] as const) assert.equal((await answer(buy.token, step, value)).status, 200);
  const buyEst = (await state(buy.token)).body["step"] as Json; assert.deepEqual((buyEst["fields"] as Json[]).map((f) => f["id"]), ["price_range_cents", "down_payment_cents"]); assert.ok(!("limit" in buyEst));
});

test("32.14-T6: Given a lead at L0, when a client posts income, a name, an SSN, a demographic answer, marital status or citizenship as a lead fact, then `lead.answer` refuses with `L0_FACTS_ONLY` and nothing is written.", { skip }, async () => {
  const l = await startLead(); assert.equal((await answer(l.token, "goal", "lower_rate")).status, 200);
  const version = await entityVersion("leads", l.id); const before = (await leadEvents(l.id)).length; const lead = await entity("leads", l.id);
  const posts: Json[] = [
    { step: "income", value: "850000" }, { step: "name", value: "Jane Q. Public" }, { step: "ssn", value: "123-45-6789" }, { step: "demographics", value: { ethnicity: ["hispanic_or_latino"], race: ["white"], sex: "female" } },
    { step: "marital_status", value: "married" }, { step: "citizenship", value: "us_citizen" }, { step: "email", value: "jane@example.test" }, { step: "phone", value: "+16025550100" },
    { step: "occupancy", value: "primary", fact: { income_cents: "850000" } }, { step: "occupancy", value: { occupancy: "primary", ssn: "123456789" } }, { step: "military_service", value: "none" }, { step: "documents", value: { paystub: "…" } },
  ];
  for (const p of posts) {
    const r = await api("POST", "/v1/borrower/lead", { action: "answer", ...p }, withLead(l.token));
    assert.equal(r.status, 409, `${JSON.stringify(p)} → ${JSON.stringify(r.body)}`); assert.equal(r.body["code"], "L0_FACTS_ONLY", JSON.stringify(p)); assert.ok(typeof r.body["copy_key"] === "string");
    assert.ok(!JSON.stringify(r.body).includes("850000") && !JSON.stringify(r.body).includes("Jane") && !JSON.stringify(r.body).includes("6789"), "the refusal echoes no value");
  }
  // nothing is written: the lead's record is unchanged, no lead event followed, no session, no party
  assert.equal(await entityVersion("leads", l.id), version); assert.deepEqual(await entity("leads", l.id), lead);
  assert.equal((await leadEvents(l.id)).length, before); assert.equal((await entity("leads", l.id))!["party_id"], null);
  assert.ok(!(await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM loan_events WHERE (aggregate_kind = 'lead' AND aggregate_id = $1) AND type LIKE 'lead.%.set'`, [l.id]))[0] || Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM loan_events WHERE aggregate_kind = 'lead' AND aggregate_id = $1 AND type LIKE 'lead.%.set'`, [l.id]))[0]!.n) === 1, "only the goal was ever written");
  // the same chip in its permitted form still resolves afterwards (the lead is live)
  const ok = await answer(l.token, "occupancy", "primary"); assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test("32.14-T7: Given a lead with goal `limited_cash_out`, occupancy `primary`, state `AZ`, when the visitor verifies an SMS code with the lead cookie, then `lead.linked{party_id}` and `lead.authenticated{level=L1}` are logged, an `applications` row exists with `channel=organic`, `transaction_type=limited_cash_out`, `occupancy=primary`, the property `tbd` with state `AZ`, the thread shows the session's disclosure line then `entry.resumed`, and no goal card is sent.", { skip }, async () => {
  const l = await refiLead("AZ"); assert.equal((await range(l.token)).status, 200);
  const phone = phoneOf(`t7-${R}`);
  const req = await api("POST", "/v1/borrower/auth/otp", { action: "request", channel: "sms", destination: phone }); assert.equal(req.status, 200, JSON.stringify(req.body));
  // the verify carries the lead cookie (the proxy's header): the lead is linked to the party before the session hook runs
  const ver = await api("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: req.body["challenge_id"], code: req.body["fake_code"] }, withLead(l.token));
  assert.equal(ver.status, 200, JSON.stringify(ver.body)); const token = ver.body["token"] as string; const partyId = (ver.body["party"] as Json)["party_id"] as string; assert.equal(ver.body["level"], "L1");
  await settle();
  // lead.linked{party_id} and lead.authenticated{level=L1} on the lead; the lead is linked, never copied
  const evs = await leadEvents(l.id); const linked = evs.find((e) => e.type === "lead.linked"); assert.ok(linked, "lead.linked"); assert.equal(linked.payload["party_id"], partyId);
  const authed = evs.find((e) => e.type === "lead.authenticated"); assert.ok(authed, "lead.authenticated"); assert.equal(authed.payload["level"], "L1"); assert.equal(authed.payload["method"], "otp_sms");
  assert.ok(Number(linked.sequence) < Number(authed.sequence), "linked before the session's authentication");
  const lead = await entity("leads", l.id); assert.equal(lead!["party_id"], partyId); assert.equal(lead!["assurance_level"], "L1_channel_otp");
  const tokens = await new PgLeadTokenRepository(db).byLead(l.id); assert.equal(tokens[0]!.linked_party_id, partyId); assert.ok(tokens[0]!.linked_at);
  assert.equal(Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM entity_current WHERE kind = 'leads' AND data->>'party_id' = $1`, [partyId]))[0]!.n), 1, "one lead for the party — never a second lead.start");
  // the application from the lead: organic, the goal, the occupancy, the property TBD in AZ, the party as its borrower
  const apps = await db.query<{ id: string; channel: string; transaction_type: string; occupancy: string; partner_party_id: string; address_line1: string | null; state: string | null }>(
    `SELECT a.id, a.channel::text AS channel, a.transaction_type::text AS transaction_type, a.occupancy::text AS occupancy, a.partner_party_id, ap.address_line1, ap.state FROM applications a JOIN application_borrowers ab ON ab.application_id = a.id LEFT JOIN application_properties ap ON ap.application_id = a.id AND ap.is_subject WHERE ab.party_id = $1`, [partyId]);
  assert.equal(apps.length, 1, JSON.stringify(apps)); const app = apps[0]!;
  assert.equal(app.channel, "organic"); assert.equal(app.transaction_type, "limited_cash_out"); assert.equal(app.occupancy, "primary"); assert.equal(app.partner_party_id, partnerPartyId);
  assert.equal(app.state, "AZ"); assert.ok(!app.address_line1, "the property is TBD: no address");
  assert.ok((await db.query<{ type: string }>(`SELECT type FROM loan_events WHERE application_id = $1 AND type = 'application.started'`, [app.id])).length === 1, "application.started");
  const intake = await entity("applications", app.id); assert.ok(intake, "21.1's interview started from the lead's facts (application.setGoal)"); assert.equal(intake["transaction_type"], "limited_cash_out");
  // the estimates rode as a prefill only (32.3 T18): never a captured six-item
  const ab = (await db.query<{ prefill: Json }>(`SELECT prefill FROM application_borrowers WHERE application_id = $1`, [app.id]))[0]!;
  assert.equal((ab.prefill["value_estimate_cents"] as Json)["value"], "50000000"); assert.equal((ab.prefill["value_estimate_cents"] as Json)["confirmed_at"], null);
  assert.ok(!(await db.query<{ type: string }>(`SELECT type FROM loan_events WHERE application_id = $1 AND type = 'application.field.captured' AND payload->>'field' = 'property_value_estimate'`, [app.id])).length, "the value estimate is not captured");
  // the thread: the session's disclosure line, then entry.resumed — and no goal card
  const thread = await api("GET", "/v1/borrower/thread?limit=500", undefined, { authorization: `Bearer ${token}` }); assert.equal(thread.status, 200, JSON.stringify(thread.body).slice(0, 300));
  const agentMessages = (thread.body["messages"] as Json[]).filter((m) => m["sender"] === "agent"); const agentLines = agentMessages.map((m) => String(m["body_text"] ?? ""));
  assert.equal(agentLines[0], "{{copy:entry.disclosure.first}}"); assert.equal(agentLines[1], "{{copy:entry.resumed}}");
  assert.equal(agentLines.filter((x) => x === "{{copy:entry.resumed}}").length, 1, "one receipt line");
  // the receipt's answers ride as the line's copy tokens (composed from the lead's facts), never as a sentence in body_text
  assert.deepEqual(agentMessages[1]!["copy_tokens"], { answers: "refinance · primary home · Arizona" }); assert.equal(agentMessages[0]!["copy_tokens"], null);
  const cards = await db.query<{ copy_key: string; kind: string }>(`SELECT copy_key, kind FROM card_instances WHERE party_id = $1`, [partyId]);
  assert.ok(!cards.some((c) => c.copy_key === "entry.goal.question"), `no goal card: ${JSON.stringify(cards)}`);
  // me: the party's subject is the application from the lead
  const me = await api("GET", "/v1/borrower/me", undefined, { authorization: `Bearer ${token}` }); assert.equal(me.status, 200);
  assert.equal(((me.body["subjects"] as Json[])[0] as Json)["application_id"], app.id);
});

test("32.14-T18: Given the funnel read model, when queried for a date range, then counts per stage come from `loan_events`/lead events only (`lead.created`, `lead.disclosure.delivered`, `lead.goal.set`, `lead.range.shown`, `lead.authenticated`, `application.started`, `credit.softpull.received`, `terms.presented`, `application.received`, `application.trid_received`, `du.findings.received`, `intent.to_proceed.received`, `lock.executed`) and the response passes the serializer allow-list.", { skip }, async () => {
  const store = new PgConsoleStore(db, runtime.registry, runtime.agents);
  const from = "2026-09-10T00:00:00.000Z", to = "2026-09-11T00:00:00.000Z";
  const f = await store.funnel({ from, to });
  assert.equal(f.from, from); assert.equal(f.to, to);
  assert.deepEqual(f.stages.map((s) => s.event_type), [...FUNNEL_STAGES], "the thirteen stages in funnel order");
  assert.deepEqual(FUNNEL_STAGES, ["lead.created", "lead.disclosure.delivered", "lead.goal.set", "lead.range.shown", "lead.authenticated", "application.started", "credit.softpull.received", "terms.presented", "application.received", "application.trid_received", "du.findings.received", "intent.to_proceed.received", "lock.executed"]);
  // every count is the count of loan_events rows of that type in the window — nothing else (no lead row, no UI table)
  for (const s of f.stages) {
    const n = Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM loan_events WHERE type = $1 AND occurred_at >= $2::timestamptz AND occurred_at < $3::timestamptz`, [s.event_type, from, to]))[0]!.n);
    assert.equal(s.count, n, s.event_type); assert.equal(typeof s.count, "number"); assert.equal(s.stage, s.event_type.replace(/\./g, "_"));
  }
  const by = new Map(f.stages.map((s) => [s.event_type, s.count]));
  assert.ok(by.get("lead.created")! >= 8 && by.get("lead.disclosure.delivered")! >= by.get("lead.created")!, "this run's leads and their disclosures are in the window");
  assert.ok(by.get("lead.goal.set")! >= 1 && by.get("lead.range.shown")! >= 1 && by.get("lead.authenticated")! >= 1 && by.get("application.started")! >= 1, JSON.stringify(f.stages));
  // an empty window counts nothing; the window is half-open
  const empty = await store.funnel({ from: "2020-01-01T00:00:00.000Z", to: "2020-01-02T00:00:00.000Z" }); assert.ok(empty.stages.every((s) => s.count === 0));
  // the response passes the serializer allow-list: the `funnel` shape keeps every field, names nothing forbidden
  const out = serialize("funnel", f); assert.deepEqual(out, JSON.parse(JSON.stringify(f)));
  const keys = new Set<string>(); const walk = (v: unknown): void => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Json)) { keys.add(k); walk(x); } }; walk(out);
  for (const k of keys) { assert.ok(ALL_ALLOWED_FIELDS.has(k), `${k} is allow-listed`); assert.ok(!FORBIDDEN_FIELDS.includes(k), k); }
});

test("32.14-T19: Given a lead created 91 days ago that never authenticated, when the inactivity sweep runs, then the lead is `expired`, its `lead_tokens` row is purged, and no `parties`, `sessions`, `conversations` or `messages` row was ever created for it.", { skip }, async () => {
  const counts = async () => ({ parties: await count("parties"), sessions: await count("sessions"), conversations: await count("conversations"), messages: await count("messages") });
  const before = await counts();
  // 91 days ago: the visitor answered the goal and left
  clock.set(new Date(Date.parse(NOW) - 91 * 86_400_000).toISOString());
  const l = await startLead(); assert.equal((await answer(l.token, "goal", "lower_rate")).status, 200);
  const created = await entity("leads", l.id); assert.equal(created!["expires_on"], "2026-09-09"); assert.equal(created!["party_id"], null);
  const tokens = new PgLeadTokenRepository(db); assert.equal((await tokens.byLead(l.id)).length, 1);
  const timer = (await db.query<{ status: string; due_date: string }>(`SELECT status::text AS status, due_date::text AS due_date FROM timers WHERE code = 'SM_LEAD_INACTIVITY_EXPIRY_90' AND subject_kind = 'lead' AND subject_id = $1`, [l.id]))[0];
  assert.ok(timer, "SM_LEAD_INACTIVITY_EXPIRY_90 armed on the lead"); assert.equal(timer.status, "armed"); assert.equal(timer.due_date, "2026-09-09");
  // today: the inactivity sweep (the flows' tick — POST /v1/sweep)
  clock.set(NOW);
  await router.flows!.tick(NOW); await settle();
  const lead = await entity("leads", l.id); assert.equal(lead!["status"], "expired"); assert.equal(lead!["closed_reason"], "inactivity_90d");
  const evs = await leadEvents(l.id); assert.ok(evs.some((e) => e.type === "lead.expired"), "lead.expired"); assert.ok(!evs.some((e) => e.type === "lead.authenticated" || e.type === "lead.linked"));
  assert.equal((await tokens.byLead(l.id)).length, 0, "the lead_tokens row is purged");
  // the stale cookie is unknown now; nothing personal was ever created for the lead
  const st = await state(l.token); assert.equal(st.status, 404); assert.equal(st.body["code"], "LEAD_UNKNOWN");
  assert.deepEqual(await counts(), before, "no parties, sessions, conversations or messages row was created for the lead");
  assert.equal(lead!["party_id"], null);
  // the sweep is idempotent: a second pass expires nothing twice
  const n = evs.filter((e) => e.type === "lead.expired").length; await router.flows!.tick(NOW); assert.equal((await leadEvents(l.id)).filter((e) => e.type === "lead.expired").length, n);
});

test("32.14-T8: Given `INTEGRATIONS=fake`, when the visitor completes Continue with Google, then `auth_challenges{kind=oidc}` is consumed once, `oidc_identities` holds `(issuer, sub)`, the session is L1 with `auth_method=oidc_google` and `last_l1_at = null`, `flows.sessionOpened` ran, and a subsequent `payment.makeOneTime` refuses with `FRESH_L1_REQUIRED`.", { skip }, async () => {
  await journeyReady();
  clock.set(MST("2026-10-06", "09:00"));
  // start: Authorization Code + PKCE on the server — the challenge row carries the state, the nonce and the verifier's hash; the response carries none of them but the state
  const started = await oidcStart({ email: EMAIL_A, email_verified: true, name: "Alex G. Borrower" });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.deepEqual(Object.keys(started.body).sort(), ["authorization_url", "delivery", "expires_at", "state"]); assert.equal(started.body["delivery"], "FAKE");
  assert.equal(started.body["expires_at"], new Date(Date.parse(clock.now()) + OIDC_MINUTES * 60_000).toISOString(), "10 minutes");
  const u = new URL(started.body["authorization_url"] as string); assert.equal(`${u.origin}${u.pathname}`, REDIRECT_URI, "the FAKE provider sends the visitor straight back to the app's callback"); assert.equal(u.searchParams.get("state"), started.state); assert.equal(u.searchParams.get("fake"), "FAKE");
  const ch0 = await challengeByState(started.state); assert.ok(ch0, "the oidc challenge row"); assert.equal(ch0!.kind, "oidc"); assert.equal(ch0!.provider, "google"); assert.equal(ch0!.consumed_at, null); assert.match(ch0!.nonce ?? "", /^[0-9a-f]{32}$/); assert.match(ch0!.code_verifier_hash ?? "", /^[0-9a-f]{64}$/); assert.equal(ch0!.destination, REDIRECT_URI);
  assert.equal(JSON.stringify(started.body).includes(ch0!.nonce!), false, "the nonce never leaves the API"); assert.equal(JSON.stringify(started.body).includes(ch0!.code_verifier_hash!), false);
  // the FAKE provider redeems a code only with the x-fake-oidc marker; a callback without it consumes nothing
  const noMarker = await oidcCallback(started.code, started.state, { marker: null });
  assert.equal(noMarker.status, 400, JSON.stringify(noMarker.body)); assert.equal(noMarker.body["code"], "OIDC_FAKE_MARKER_REQUIRED"); assert.equal(noMarker.body["copy_key"], "auth.google.failed");
  assert.equal((await challengeByState(started.state))!.consumed_at, null);
  // the callback: the same session body as a one-time code — L1, auth_method oidc_google, no last_l1_at
  const ok = await oidcCallback(started.code, started.state); await settle();
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(Object.keys(ok.body).sort(), ["level", "party", "session", "token"]);
  const session = ok.body["session"] as Json; const party = ok.body["party"] as Json;
  assert.equal(ok.body["level"], "L1"); assert.equal(session["level"], "L1"); assert.equal(session["auth_method"], "oidc_google"); assert.equal(session["last_l1_at"], null); assert.equal(session["fresh_l1"], false);
  assert.equal(party["display_name"], "Alex Borrower", "the party is the application borrower the verified e-mail belongs to — the Google name is a prefill, not the party's name");
  alex.partyId = party["party_id"] as string; alex.token = ok.body["token"] as string; alex.sessionId = session["session_id"] as string;
  // consumed once: the row is consumed, bound to the party, and a replay of the same code + state is refused without touching it
  const ch1 = (await challengeByState(started.state))!; assert.ok(ch1.consumed_at, "consumed"); assert.equal(ch1.party_id, alex.partyId);
  const replay = await oidcCallback(started.code, started.state); assert.equal(replay.status, 401); assert.equal(replay.body["code"], "OIDC_INVALID"); assert.equal(replay.body["copy_key"], "auth.google.failed");
  assert.equal((await challengeByState(started.state))!.consumed_at, ch1.consumed_at, "consumed exactly once");
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM sessions WHERE party_id = $1`, [alex.partyId]))[0]!.n, "1", "the replay opened no second session");
  // oidc_identities holds (issuer, sub) → the party, with the verified e-mail and the provider's name
  const id = await identityOf(alex.sub); assert.ok(id, "the identity row"); assert.equal(id!.party_id, alex.partyId); assert.equal(id!.issuer, "https://accounts.google.com"); assert.equal(id!.email, EMAIL_A); assert.equal(id!.email_verified, true); assert.equal(id!.name, "Alex G. Borrower");
  const sess = (await db.query<{ auth_method: string; level: string; last_l1_at: string | null; passkey_id: string | null }>(`SELECT auth_method, level, last_l1_at, passkey_id FROM sessions WHERE session_id = $1`, [alex.sessionId]))[0]!;
  assert.deepEqual(sess, { auth_method: "oidc_google", level: "L1", last_l1_at: null, passkey_id: null });
  // the verified e-mail linked the servicing book's application borrower to the party (the same resolver a code uses); the provider's name is a prefill pending the identity ConfirmCard
  const ab = (await db.query<{ party_id: string | null; legal_name: string; prefill: Json }>(`SELECT party_id, legal_name, prefill FROM application_borrowers WHERE application_id = $1 AND contact->>'email' = $2`, [journey.appId, EMAIL_A]))[0]!;
  assert.equal(ab.party_id, alex.partyId); assert.equal(ab.legal_name, "Alex Borrower");
  assert.deepEqual(ab.prefill["legal_name"], { value: "Alex G. Borrower", source: "oidc_google", extracted_at: clock.now(), confirmed_at: null });
  // flows.sessionOpened ran: the disclosure is the first assistant content (32.3 E2) and 20.3 logged lead.authenticated{level=L1, method=oidc_google} on the application's lead
  const lines = await messagesOf(alex.partyId); assert.ok(lines.length >= 1); assert.equal(lines[0]!.body_text, "{{copy:entry.disclosure.first}}"); assert.equal(lines[0]!.sender, "agent"); assert.equal(lines[0]!.channel, "app");
  const authed = (await appEvents(journey.appId, "lead.authenticated")).filter((e) => e.payload["method"] === "oidc_google"); assert.equal(authed.length, 1, "lead.authenticated{method=oidc_google}");
  assert.ok(["L1", "L2"].includes(String(authed[0]!.payload["level"])), "the lead's level is 20.3's (the journey's lead was portal-authenticated before; a Google sign-in never lowers it) — the SESSION is L1, asserted on its row above");
  assert.equal(((authed[0]!.payload["evidence"] as Json)["session_id"]), alex.sessionId);
  // me: the session, the subject the e-mail linked
  const me = await sapi("GET", "/v1/borrower/me", undefined, alex.token); assert.equal(me.status, 200); assert.equal((me.body["session"] as Json)["auth_method"], "oidc_google"); assert.ok((me.body["subjects"] as Json[]).some((s) => s["application_id"] === journey.appId));
  // the fresh-L1 rule is unchanged: money movement on a Google session asks for a code
  const pay = await sapi("POST", "/v1/borrower/commands/payment.makeOneTime", { amount_cents: "100000", date: "2026-10-07", subject: { application_id: journey.appId } }, alex.token);
  assert.equal(pay.status, 403, JSON.stringify(pay.body)); assert.equal(pay.body["code"], "FRESH_L1_REQUIRED"); assert.equal(pay.body["copy_key"], "auth.fresh_code"); assert.deepEqual(Object.keys(pay.body).sort(), ["code", "copy_key"]);
});
test("32.14-T9: Given a Google id token with `email_verified=false`, then the callback answers 401 `OIDC_EMAIL_UNVERIFIED`, no party, session or `oidc_identities` row is created.", { skip }, async () => {
  await journeyReady();
  const email = `unverified-${R}@example.test`; const sub = fakeOidcSubject(email);
  const sessionsBefore = await count("sessions");
  const started = await oidcStart({ email, email_verified: false, name: "Nobody Unverified" }); assert.equal(started.status, 200, JSON.stringify(started.body));
  const r = await oidcCallback(started.code, started.state); await settle();
  assert.equal(r.status, 401, JSON.stringify(r.body)); assert.equal(r.body["code"], "OIDC_EMAIL_UNVERIFIED"); assert.equal(r.body["copy_key"], "auth.google.failed"); assert.deepEqual(Object.keys(r.body).sort(), ["code", "copy_key"]);
  assert.equal(await partiesWithEmail(email), 0, "no party");
  assert.equal(await identityOf(sub), undefined, "no oidc_identities row");
  assert.equal(await count("sessions"), sessionsBefore, "no session");
  const ch = (await challengeByState(started.state))!; assert.ok(ch.consumed_at, "the challenge is spent even on a refusal"); assert.equal(ch.party_id, null);
  const again = await oidcCallback(started.code, started.state); assert.equal(again.status, 401); assert.equal(again.body["code"], "OIDC_INVALID");
});
test("32.14-T10: Given an existing borrower party whose contact e-mail equals the verified Google e-mail, when they sign in with Google, then the session's party is that party (no new party); given they later sign in with the same `sub` and a changed e-mail, then the same party is resolved by `sub`.", { skip }, async () => {
  await journeyReady();
  // Blake exists: a code to the e-mail on file made the party (and linked the application borrower)
  const s = await signIn(EMAIL_B); await settle(); blake.partyId = s.party_id; blake.token = s.token;
  assert.equal(await partiesWithEmail(EMAIL_B), 1);
  // Continue with Google on the same verified e-mail: the same party, no new one; the identity row points at it
  const g1 = await google({ email: EMAIL_B, email_verified: true, name: "Blake Borrower", sub: blake.sub });
  assert.equal(g1.status, 200, JSON.stringify(g1.body)); assert.equal((g1.body["party"] as Json)["party_id"], blake.partyId); assert.equal((g1.body["session"] as Json)["auth_method"], "oidc_google");
  assert.equal(await partiesWithEmail(EMAIL_B), 1, "no new party");
  const id1 = (await identityOf(blake.sub))!; assert.equal(id1.party_id, blake.partyId); assert.equal(id1.email, EMAIL_B); assert.equal(id1.email_verified, true);
  // later, the same sub with a changed e-mail: resolved by sub — the same party, the identity row's e-mail refreshed, still no new party
  const changed = `blake-renamed-${R}@example.test`;
  const g2 = await google({ email: changed, email_verified: true, name: "Blake Borrower", sub: blake.sub });
  assert.equal(g2.status, 200, JSON.stringify(g2.body)); assert.equal((g2.body["party"] as Json)["party_id"], blake.partyId);
  const id2 = (await identityOf(blake.sub))!; assert.equal(id2.party_id, blake.partyId); assert.equal(id2.email, changed);
  assert.equal(await partiesWithEmail(changed), 0, "the changed e-mail made no party"); assert.equal(await partiesWithEmail(EMAIL_B), 1);
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM oidc_identities WHERE party_id = $1`, [blake.partyId]))[0]!.n, "1", "one identity row per (issuer, sub)");
  // the party's name came from the application borrower row, not from Google (it was never just an e-mail)
  assert.equal((await db.query<{ legal_name: string }>(`SELECT legal_name FROM parties WHERE id = $1`, [blake.partyId]))[0]!.legal_name, "Blake Borrower");
});
test("32.14-T11: Given a replayed or foreign `state`, or a `nonce` that does not match the challenge, then the callback answers 401 `OIDC_INVALID` and the challenge is not consumable again.", { skip }, async () => {
  await journeyReady();
  const who: FakeOidcIdentity = { email: `carol-${R}@example.test`, email_verified: true, name: "Carol Nonce" };
  // a foreign state: a code presented with a state no challenge names — refused; the genuine challenge is untouched and still redeems once, then never again
  const a = await oidcStart(who); assert.equal(a.status, 200);
  const foreign = await oidcCallback(a.code, randomBytes(32).toString("base64url")); assert.equal(foreign.status, 401); assert.equal(foreign.body["code"], "OIDC_INVALID"); assert.equal(foreign.body["copy_key"], "auth.google.failed");
  assert.equal((await challengeByState(a.state))!.consumed_at, null, "a foreign state consumes nothing");
  const first = await oidcCallback(a.code, a.state); await settle(); assert.equal(first.status, 200, JSON.stringify(first.body));
  const replayed = await oidcCallback(a.code, a.state); assert.equal(replayed.status, 401); assert.equal(replayed.body["code"], "OIDC_INVALID");
  // a nonce that does not match: a code whose claims carry another nonce, on a genuine state — refused, and the challenge is spent (its own code no longer redeems)
  const b = await oidcStart(who); assert.equal(b.status, 200);
  const forged = fakeOidcCode(who, "not-the-challenge-nonce", clock.now());
  const mismatch = await oidcCallback(forged, b.state); assert.equal(mismatch.status, 401, JSON.stringify(mismatch.body)); assert.equal(mismatch.body["code"], "OIDC_INVALID");
  const chB = (await challengeByState(b.state))!; assert.ok(chB.consumed_at, "consumed on the refusal"); assert.equal(chB.party_id, null, "no party was resolved");
  const genuine = await oidcCallback(b.code, b.state); assert.equal(genuine.status, 401); assert.equal(genuine.body["code"], "OIDC_INVALID");
  // a state older than 10 minutes: refused and spent
  const c = await oidcStart(who); assert.equal(c.status, 200);
  clock.set(new Date(Date.parse(clock.now()) + (OIDC_MINUTES + 1) * 60_000).toISOString());
  const late = await oidcCallback(c.code, c.state); assert.equal(late.status, 401); assert.equal(late.body["code"], "OIDC_INVALID"); assert.ok((await challengeByState(c.state))!.consumed_at);
  // none of the refusals opened a session on Carol's party; the one success did
  const carol = (await db.query<{ id: string }>(`SELECT id FROM parties WHERE lower(contact->>'email') = $1`, [who.email]))[0]!; assert.ok(carol);
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM sessions WHERE party_id = $1`, [carol.id]))[0]!.n, "1");
  // a start refuses a redirect outside the allowed origins (the FAKE identity hint itself is accepted here only because the provider is FAKE)
  const bad = await sapi("POST", "/v1/borrower/auth/oidc", { action: "start", provider: "google", redirect_uri: "https://evil.example/callback", fake: who }); assert.equal(bad.status, 400); assert.equal(bad.body["code"], "BAD_REQUEST");
});
test("32.14-T12: Given a first successful session, then `auth.passkey.offer` renders once; given a registered passkey, when the visitor returns, then Use my passkey is offered first and a successful assertion lands in the thread with the Record open to `next`.", { skip }, async () => {
  await journeyReady();
  const offer = `{{copy:${PASSKEY_OFFER_COPY_KEY}}}`;
  // Alex's first session was T8's Google sign-in: the offer rendered once, after the session's disclosure line; a second sign-in adds no second offer
  const after1 = await messagesOf(alex.partyId);
  assert.equal(after1.filter((m) => m.body_text === offer).length, 1, "the offer renders once"); assert.ok(after1.findIndex((m) => m.body_text === offer) > 0, "after the disclosure line"); assert.equal(after1.find((m) => m.body_text === offer)!.card_instance_id, null, "no card");
  const again = await google({ email: EMAIL_A, email_verified: true, name: "Alex G. Borrower" }); assert.equal(again.status, 200, JSON.stringify(again.body)); assert.equal((again.body["party"] as Json)["party_id"], alex.partyId);
  assert.equal((await messagesOf(alex.partyId)).filter((m) => m.body_text === offer).length, 1, "still once after the second session");
  assert.ok((await thread(again.body["token"] as string)).messages.some((m) => m["body_text"] === offer), "the line is in the thread the shell renders");
  // the offer taken: the existing passkey registration path on the session (a P-256 credential; attestation `none`)
  const token = again.body["token"] as string;
  const opts = await sapi("POST", "/v1/borrower/auth/passkey", { action: "register_options" }, token); assert.equal(opts.status, 200, JSON.stringify(opts.body));
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const cose = new Map<C, C>([[1, 2], [3, -7], [-1, 1], [-2, b64url.decode(jwk.x)], [-3, b64url.decode(jwk.y)]]);
  const credId = Buffer.from(randomUUID().replace(/-/g, ""), "hex");
  const authData = Buffer.concat([sha("localhost"), Buffer.from([0x41]), Buffer.from([0, 0, 0, 0]), Buffer.alloc(16), Buffer.from([credId.length >> 8, credId.length & 0xff]), credId, cbor(cose)]);
  const reg = await sapi("POST", "/v1/borrower/auth/passkey", { action: "register", challenge_id: opts.body["challenge_id"], credential: { id: b64url.encode(credId), response: { clientDataJSON: clientData("webauthn.create", opts.body["challenge"] as string), attestationObject: b64url.encode(cbor({ fmt: "none", attStmt: {}, authData })), transports: ["internal"] } } }, token);
  assert.equal(reg.status, 200, JSON.stringify(reg.body)); assert.equal(reg.body["attestation_verified"], "FAKE");
  // S3 "Mobile after Google" (auth.add_mobile): a code to a mobile on file for no one, verified on the live Google session, attaches the number to the party — the same session, now with a fresh code; no new party, no PARTY_SCOPE
  const mobile = phoneOf(`alex-mobile-${R}`); const partiesBefore = await count("parties");
  const askM = await sapi("POST", "/v1/borrower/auth/otp", { action: "request", channel: "sms", destination: mobile }); assert.equal(askM.status, 200, JSON.stringify(askM.body));
  const addM = await sapi("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: askM.body["challenge_id"], code: askM.body["fake_code"] }, token);
  assert.equal(addM.status, 200, JSON.stringify(addM.body)); assert.equal(addM.body["token"], token, "the same session continues"); assert.equal((addM.body["party"] as Json)["party_id"], alex.partyId); assert.equal((addM.body["session"] as Json)["fresh_l1"], true, "the code is the session's fresh L1");
  assert.equal((await db.query<{ phone: string | null }>(`SELECT contact->>'phone' AS phone FROM parties WHERE id = $1`, [alex.partyId]))[0]!.phone, mobile, "the mobile is the party's contact"); assert.equal(await count("parties"), partiesBefore, "no new party");
  // a code to another party's destination never refreshes or re-homes this session (the e-mail stays Blake's)
  const askB = await sapi("POST", "/v1/borrower/auth/otp", { action: "request", channel: "email", destination: EMAIL_B });
  const cross = await sapi("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: askB.body["challenge_id"], code: askB.body["fake_code"] }, token);
  assert.equal(cross.status, 403, JSON.stringify(cross.body)); assert.equal(cross.body["code"], "PARTY_SCOPE"); assert.equal(await partiesWithEmail(EMAIL_B), 1); assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM parties WHERE id = $1 AND (contact->>'email' = $2 OR contact->'emails' ? $2)`, [alex.partyId, EMAIL_B]))[0]!.n, "0");
  // the return visit: Use my passkey first (the device holds a credential — the shell's chooser lists it first; the API's assertion needs no code and no session)
  const ao = await sapi("POST", "/v1/borrower/auth/passkey", { action: "assert_options" }); assert.equal(ao.status, 200, JSON.stringify(ao.body));
  const authData2 = Buffer.concat([sha("localhost"), Buffer.from([0x05]), Buffer.from([0, 0, 0, 1])]);
  const cdj = clientData("webauthn.get", ao.body["challenge"] as string);
  const signature = b64url.encode(cryptoSign("sha256", Buffer.concat([authData2, sha(b64url.decode(cdj))]), { key: privateKey, dsaEncoding: "der" }));
  const landed = await sapi("POST", "/v1/borrower/auth/passkey", { action: "assert", challenge_id: ao.body["challenge_id"], credential: { id: b64url.encode(credId), response: { clientDataJSON: cdj, authenticatorData: b64url.encode(authData2), signature } } }); await settle();
  assert.equal(landed.status, 200, JSON.stringify(landed.body)); assert.equal((landed.body["party"] as Json)["party_id"], alex.partyId); assert.equal((landed.body["session"] as Json)["auth_method"], "passkey"); assert.equal((landed.body["session"] as Json)["fresh_l1"], false);
  // lands in the thread with the Record open to `next`
  const t = await thread(landed.body["token"] as string); assert.equal(t.messages[0]!["body_text"], "{{copy:entry.disclosure.first}}"); assert.equal(t.messages.filter((m) => m["body_text"] === offer).length, 1, "no offer for a passkey session");
  const rec = await record(landed.body["token"] as string, journey.appId);
  const next = rec["next"] as Json | null; assert.ok(next, "the Record's next"); assert.equal(typeof next!["due_at"], "string"); assert.equal(typeof next!["timer_code"], "string"); assert.equal(typeof next!["label"], "string");
  assert.equal((rec["subject"] as Json)["application_id"], journey.appId);
});
// ---------------------------------------------------------------- Phase 3 S4 (DELTA-13 — T13, T14, T15): the prequalified rate for a borrower who typed their identity
// Two organic borrowers who came in through the anonymous minute (goal, occupancy, state and the estimate pair as 20.3 lead facts — DELTA-11
// set_fact), signed in by code and typed name / address / DOB / SSN: Pat (T13, then T14 proceeds) and Sam (T15 says Not yet). The pricing rows
// are the journey's (the active LLPA matrix, the AZ cost schedule); the day's rate sheet and the partner's MLO roster are seeded here.
import { DISCLAIMER_STATEMENT, DISCLAIMER_TEMPLATE } from "../leads-pricing/ops-20-4.ts";
import { IDENTITY_ENTRY_FIELD, quoteIdOf } from "../../runtime/borrower/flows/14-prequal.ts";
const EDT = (date: string, hhmm: string): string => new Date(`${date}T${hhmm}:00-04:00`).toISOString();
const PRICING_AGENT = { kind: "agent" as const, id: "pricing" };
const S4_MLO = { mlo_id: `u-mlo-s4-${R}`, name: "Jordan Rivera", nmlsr_id: "987654", licensed_states: ["AZ"], nmls_status: "active", open_queue: 0 };
const MLO_S4 = { kind: "human" as const, id: S4_MLO.mlo_id, role: "mlo_of_record" };
const PAT = { email: `pat-${R}@example.test`, name: "Pat Nguyen", dob: "1991-05-20", ssn: "123-45-4141", ssn_last4: "4141", address: "9 Cactus Rd, Phoenix, AZ 85018", value_cents: "55000000", balance_cents: "40000000" };
const SAM = { email: `sam-${R}@example.test`, name: "Sam Okoro", dob: "1987-09-03", ssn: "123-45-2323", ssn_last4: "2323", address: "41 Mesa Ln, Tucson, AZ 85701", value_cents: "48000000", balance_cents: "31000000" };
/** T14: the visitor who comes in through the real organic path (the lead API, the code with the lead cookie) — the estimates are the ones `refiLead` answered on the lead. */
const QUINN = { email: `quinn-${R}@example.test`, name: "Quinn Park", dob: "1989-12-11", ssn: "123-45-5151", ssn_last4: "5151", address: "77 Saguaro Way, Mesa, AZ 85201", value_cents: "50000000", balance_cents: "30000000" };
type S4Borrower = typeof PAT;
type S4Party = { appId: string; partyId: string; token: string; sessionId: string; quoteId: string };
type CardRow = { card_instance_id: string; party_id: string; kind: string; status: string; copy_key: string; props: Json; evidence: Json | null; command_ref: string | null; created_at: string };
const cardsOf = async (appId: string, partyId?: string): Promise<CardRow[]> => { await settle(); return db.query<CardRow & Json>(`SELECT card_instance_id, party_id, kind, status, copy_key, props, evidence, command_ref, created_at FROM card_instances WHERE subject_application_id = $1 AND ($2::uuid IS NULL OR party_id = $2) ORDER BY created_at, card_instance_id`, [appId, partyId ?? null]); };
const pendingCard = async (appId: string, partyId: string, copyKey: string): Promise<CardRow> => { const c = (await cardsOf(appId, partyId)).filter((x) => x.copy_key === copyKey && x.status === "pending").at(-1); assert.ok(c, `pending ${copyKey} card for ${partyId}`); return c; };
const resolve = async (token: string, cardId: string, body: Json): Promise<Reply> => { const r = await sapi("POST", `/v1/borrower/cards/${cardId}/resolve`, body, token); await settle(); return r; };
const fieldsEvidence = (card: CardRow, edits: Record<string, string> = {}) => ({ evidence: { fields: (card.props["fields"] as { path: string; value: string; source: string }[]).map((f) => ({ path: f.path, value_confirmed: edits[f.path] ?? f.value, source: f.source, confirmed_at: clock.now() })), edited: Object.keys(edits).length > 0 } });
/** The application's clocks — the lead's own rows too (the lead shares the application's id: one id space). */
const timersOf = (appId: string) => db.query<{ code: string; status: string; due_at: string | null; subject_kind: string }>(`SELECT code, status::text AS status, due_at, subject_kind FROM timers WHERE application_id = $1::uuid OR subject_id = $1::text ORDER BY armed_at, code`, [appId]);
const sessionLevel = async (sessionId: string): Promise<string> => (await db.query<{ level: string }>(`SELECT level FROM sessions WHERE session_id = $1`, [sessionId]))[0]!.level;
const s4 = { pat: { appId: "", partyId: "", token: "", sessionId: "", quoteId: "" } as S4Party, sam: { appId: "", partyId: "", token: "", sessionId: "", quoteId: "" } as S4Party, quinn: { appId: "", partyId: "", token: "", sessionId: "", quoteId: "" } as S4Party };
let s4Seeded = false;
/** Once: the partner's MLO roster row (21.1's shape, a global entity — 31.1 owns the roster) and the day's rate sheet (the journey's grid, in force Wed Oct 21 06:35–17:00 ET). */
async function seedS4(): Promise<void> {
  if (s4Seeded) return; s4Seeded = true;
  await journeyReady();   // the journey's pricing rows: the active LLPA matrix and the AZ cost schedule (20.4's quote needs both)
  await runtime.entities.save([{ kind: "mlo_roster", id: S4_MLO.mlo_id, data: { ...S4_MLO }, version: 1, updatedAt: clock.now(), updatedBy: "test:32.14" }], null);
  const grid = [["6.375", "101.875"], ["6.250", "101.375"], ["6.125", "100.875"], ["6.000", "100.375"], ["5.875", "99.750"]].map(([r, p]) => ({ product_code: "FRM30", term_months: 360, note_rate_pct: r, lock_period_days: 45, price: p }));
  await journey.tool({}, "20.4", "publishRateSheet", { rate_sheet_id: `rs-2026-10-21-${R}`, partner_id: "partner-1", source: "pe_whole_loan_api", published_at: EDT("2026-10-21", "06:35"), expires_at: EDT("2026-10-21", "17:00"), prices: grid }, PRICING_AGENT);
}
/** S0–S3 for an organic borrower as the lead flow leaves them: the application (started — the Reg B request waits for Proceed) with its TBD property in AZ, the interview opened, the S1 facts on the lead through 20.3 set_fact (rule 6, nothing personal), then a second session — the one S4's identity ask opens on. */
async function openS4(b: S4Borrower, at: string): Promise<S4Party> {
  await seedS4(); clock.set(at);
  const r = await sapi("POST", "/v1/applications", { actor: INTAKE, application: { partner_party_id: partnerPartyId, channel: "organic", transaction_type: "limited_cash_out", occupancy: "primary", intake_channel: "web", interview_language: "en-US", borrowers: [{ legal_name: b.name, borrower_role: "borrower", contact: { email: b.email } }], property: null } }, TOKEN);
  assert.equal(r.status, 200, JSON.stringify(r.body)); const appId = (r.body["application"] as { id: string }).id;
  await db.query(`INSERT INTO application_properties (application_id, state, is_subject) VALUES ($1, 'AZ', true)`, [appId]);   // the property is TBD, in the state the visitor named (S3 (ii))
  await journey.tool({ app: appId }, "21.1", "startInterview", { session_id: `S4-${appId.slice(0, 8)}`, partner_name: `Partner Bank ${R}`, partner_nmlsr_id: "123456", intake_channel: "web", creditor_time_zone: "America/New_York", property_state: "AZ", transaction_type: "limited_cash_out", occupancy: "primary", borrowers: [{ id: "B1", legal_name: b.name }], model_version: "intake-2026.09", prompt_version: "p-1.4" }, INTAKE);
  // the first session: 3-entry's E1/E2/E4 open the lead on the application (lead id = application id, the party linked, L1) — no goal card: the interview is open and the goal comes from the lead
  const first = await signIn(b.email); await settle();
  for (const fact of [{ kind: "goal", transaction_intent: "limited_cash_out" }, { kind: "occupancy", occupancy: "primary" }, { kind: "state", consumer_state: "AZ" }, { kind: "estimate", value_estimate_cents: b.value_cents, stated_existing_balance_cents: b.balance_cents }]) await journey.tool({ app: appId }, "20.3", "explainProgram", { op: "set_fact", lead_id: appId, fact }, INTAKE);
  assert.equal((await cardsOf(appId, first.party_id)).filter((c) => c.copy_key === "entry.goal.question").length, 0, "no goal card: the lead carries the goal");
  // the session S4 opens on: the lead carries a goal and the application is not received — the identity ask is the first card
  clock.set(new Date(Date.parse(at) + 60_000).toISOString());
  const s = await signIn(b.email); await settle();
  assert.equal(s.party_id, first.party_id); assert.equal(s.level, "L1");
  return { appId, partyId: s.party_id, token: s.token, sessionId: s.session_id, quoteId: "" };
}
/** S4's identity: Type it in → the same ConfirmCard 32.3 E5 sends, empty → the SSN card (3-entry E5, unchanged); the session stays L1. */
async function typeIdentity(b: S4Borrower, x: S4Party): Promise<void> {
  const how = await pendingCard(x.appId, x.partyId, "auth.identity.how");
  assert.equal(how.kind, "ChoiceCard"); assert.deepEqual((how.props["options"] as { id: string; label: string }[]).map((o) => [o.id, o.label]), [["scan", "Scan my ID (30 seconds)"], ["type", "Type it in"]]); assert.deepEqual(how.props["no_command_options"], ["scan"], "Scan my ID is the client's Stripe FAKE session (32.3 E5 unchanged)");
  const chose = await resolve(x.token, how.card_instance_id, { option_id: "type", evidence: { option_id: "type", tapped_at: clock.now() } }); assert.equal(chose.status, 201, JSON.stringify(chose.body));
  assert.ok((await appEvents(x.appId, "application.field.captured")).some((e) => e.payload["field"] === IDENTITY_ENTRY_FIELD), "the choice is a plain 21.1 field on the interview");
  const idc = await pendingCard(x.appId, x.partyId, "identity.confirm.title");
  assert.deepEqual((idc.props["fields"] as { path: string; value: string; source: string }[]).map((f) => [f.path, f.value, f.source]), [["legal_name", "", "borrower"], ["date_of_birth", "", "borrower"], ["current_address", "", "borrower"]], "the same ConfirmCard, empty, source=borrower");
  const confirmed = await resolve(x.token, idc.card_instance_id, fieldsEvidence(idc, { legal_name: b.name, date_of_birth: b.dob, current_address: b.address })); assert.equal(confirmed.status, 201, JSON.stringify(confirmed.body));
  const ssn = await pendingCard(x.appId, x.partyId, "identity.ssn.title"); assert.deepEqual(ssn.props["masked_paths"], ["ssn"]);
  const stored = await resolve(x.token, ssn.card_instance_id, fieldsEvidence(ssn, { ssn: b.ssn })); assert.equal(stored.status, 201, JSON.stringify(stored.body));
  assert.equal(await sessionLevel(x.sessionId), "L1", "typing keeps the session at L1");
}
/** The soft-pull consent affirmed (checkbox + typed name) — at L1, through the FAKE bureau to the review request. */
async function affirmSoftPull(b: S4Borrower, x: S4Party): Promise<Reply> {
  const consent = await pendingCard(x.appId, x.partyId, "consent.credit.soft.title");
  return resolve(x.token, consent.card_instance_id, { evidence: { affirmation_method: "checkbox_with_text", typed_name: b.name, checkbox: true, disclosure_version_shown: consent.props["disclosure_version_id"] } });
}
/** The MLO of record approves the review on the application (20.3's own tool, the mlo_of_record's act) → 20.3 presents → the terms card and the proceed card. */
async function approveReview(x: S4Party, at: string): Promise<void> {
  clock.set(at);
  const review = await journey.tool({ app: x.appId }, "20.3", "requestQuote", { op: "review", lead_id: x.appId, quote_id: x.quoteId, review_id: `MR-S4-${x.appId.slice(0, 8)}`, outcome: "approved" }, MLO_S4);
  assert.ok(review.events.some((e) => e.type === "mlo.review.completed" && e.payload["outcome"] === "approved")); await settle();
}

test("32.14-T13: Given L1 and consumer-entered name, address, DOB and SSN, when the borrower affirms the soft-pull consent, then `credit.authorization.captured{kind=soft_prequal}` and `credit.softpull.requested` are logged, `credit.softpull.received{tier}` follows from the FAKE bureau, `terms.presentation.requested` is logged, and under `assisted` no personal rate renders before `mlo.review.completed{approved}` (`NO_RATE_BEFORE_MLO_REVIEW` refuses `send_card{personal_terms}`); after approval `terms.presented` renders with the attribution and the 20.4 disclaimer.", { skip }, async () => {
  const x = await openS4(PAT, EDT("2026-10-21", "09:00")); Object.assign(s4.pat, x);
  clock.set(EDT("2026-10-21", "09:02")); await typeIdentity(PAT, x);
  // consumer-entered: the row the cards wrote — name, DOB and address confirmed by the consumer (source borrower, confirmed_at), the SSN stored once (its last four)
  const ab = (await db.query<{ prefill: Json; tin_last4: string | null; date_of_birth: string | null; legal_name: string }>(`SELECT prefill, tin_last4, date_of_birth::text AS date_of_birth, legal_name FROM application_borrowers WHERE application_id = $1`, [x.appId]))[0]!;
  for (const k of ["legal_name", "date_of_birth", "current_address"]) { const p = ab.prefill[k] as Json; assert.equal(p["source"], "borrower", k); assert.ok(p["confirmed_at"], `${k} confirmed_at`); }
  assert.equal(ab.legal_name, PAT.name); assert.equal(ab.date_of_birth, PAT.dob); assert.equal(ab.tin_last4, PAT.ssn_last4);
  const consent = await pendingCard(x.appId, x.partyId, "consent.credit.soft.title");
  assert.equal(consent.kind, "ConsentCard"); assert.equal(consent.command_ref, "credit.authorize"); assert.equal(consent.props["consent_kind"], "credit_authorization"); assert.deepEqual(consent.props["scope"], ["soft_pull"]); assert.equal(consent.props["requires_typed_name"], true); assert.equal(consent.props["requires_level"], "L1");
  const args = consent.props["command_args"] as Json; assert.equal(args["kind"], "soft_pull"); assert.equal(args["consumer_entered_identity"], true); assert.equal(args["authorization_kind"], "soft_prequal"); assert.equal(args["lead_id"], x.appId);
  assert.equal(String(consent.props["body_text"]), `I authorize Partner Bank ${R} to obtain my credit report to prequalify me. This is a soft inquiry and does not affect my credit score. A full credit check happens only if I choose to apply.`);
  // the affirmation at L1 (DELTA-13): 32.2 credit.authorize{soft_pull} → 20.3 captureCreditAuthorization{soft_prequal} + orderSoftPull
  clock.set(EDT("2026-10-21", "09:05"));
  const r = await affirmSoftPull(PAT, x); assert.equal(r.status, 201, JSON.stringify(r.body));
  const out = r.body["result"] as Json; assert.equal(out["kind"], "soft_pull"); assert.equal(out["soft_pull_requested"], true); assert.equal(out["consumer_entered_identity"], true);
  assert.equal(await sessionLevel(x.sessionId), "L1", "still L1 after the pull");
  const captured = await appEvents(x.appId, "credit.authorization.captured");
  const soft = captured.find((e) => e.payload["kind"] === "soft_prequal"); assert.ok(soft, "20.3's credit.authorization.captured{kind=soft_prequal}"); assert.equal(soft!.payload["end_user"], "partner"); assert.equal(soft!.payload["permissible_purpose"], "consumer_initiated_credit_transaction_1681b_a3A");
  assert.ok(captured.some((e) => e.payload["kind"] === "soft_pull" && e.payload["consumer_entered_identity"] === true && e.payload["assurance_level"] === "L1"), "32.2's record carries the fact the API stated");
  const requested = await appEvents(x.appId, "credit.softpull.requested"); assert.equal(requested.length, 1); assert.equal(requested[0]!.payload["requested_by"], "consumer"); assert.equal(requested[0]!.payload["idempotency_key"], soft!.payload["authorization_id"]);
  // the FAKE bureau answered: the tier from the last four (deterministic), the report linked to the authorization, no freeze, no alert
  const received = await appEvents(x.appId, "credit.softpull.received"); assert.equal(received.length, 1, "credit.softpull.received follows from the FAKE bureau");
  assert.equal(received[0]!.payload["tier"], "760–779"); assert.equal(received[0]!.payload["frozen"], false); assert.equal(received[0]!.payload["fraud_alert"], false); assert.equal(received[0]!.payload["authorization_id"], soft!.payload["authorization_id"]); assert.match(String(received[0]!.payload["report_id"]), /^rpt-FAKE-/);
  const lead = (await entity("leads", x.appId))!; assert.equal((lead["soft_pull_report"] as Json)["tier"], "760–779"); assert.equal(lead["status"], "terms_review"); assert.equal(lead["mlo_name"], "Jordan Rivera"); assert.equal(lead["mlo_nmlsr_id"], "987654");
  assert.equal((await appEvents(x.appId, "prequal.requested")).length, 1); assert.equal((await appEvents(x.appId, "prequal.information_provided")).length, 1);
  const prequal = (lead["prequalifications"] as Json[])[0]!; assert.equal(prequal["basis"], "soft_pull"); assert.equal(String(prequal["value_estimate_cents"]), PAT.value_cents); assert.deepEqual((prequal["loan_amount_range_cents"] as unknown[]).map(String), [PAT.balance_cents, PAT.balance_cents], "20.3's prequalification on the tier and the S1 estimates");
  // the review requested (20.3 rule 7): SM_MLO_PREAPP_TERMS_REVIEW_1BH.due_at from `timers` on the pending StatusCard, the MLO PersonCard — and no rate anywhere
  const requestedTerms = await appEvents(x.appId, "terms.presentation.requested"); assert.equal(requestedTerms.length, 1); x.quoteId = String(requestedTerms[0]!.payload["quote_id"]); s4.pat.quoteId = x.quoteId;
  assert.equal(x.quoteId, quoteIdOf(x.appId, String(received[0]!.payload["report_id"])), "one quote per soft-pull report"); assert.match(String(requestedTerms[0]!.payload["mlo_of_record_id"]), /^u-mlo-s4-/, "the MLO of record from the partner's roster (a global row; earlier runs' rows on the same database are the same person)");
  const t = (await timersOf(x.appId)).find((z) => z.code === "SM_MLO_PREAPP_TERMS_REVIEW_1BH"); assert.ok(t, "the review clock"); assert.equal(t!.status, "armed"); assert.equal(t!.due_at, EDT("2026-10-21", "10:05"), "+1 business hour inside the MLO's window");
  const cards = await cardsOf(x.appId, x.partyId);
  const pending = cards.find((c) => c.copy_key === "terms.pending_mlo" && c.kind === "StatusCard"); assert.ok(pending, "terms.pending_mlo"); assert.equal(pending!.props["next_event_at"], t!.due_at); assert.equal((pending!.props["copy_tokens"] as Json)["mlo.name"], "Jordan Rivera"); assert.equal((pending!.props["copy_tokens"] as Json)["mlo.nmlsr_id"], "987654");
  assert.ok(cards.some((c) => c.kind === "PersonCard" && c.props["role"] === "mlo_of_record" && c.props["name"] === "Jordan Rivera"), "the MLO PersonCard");
  assert.equal(cards.filter((c) => c.props["personal_terms"] === true).length, 0, "no personal rate before mlo.review.completed{approved}");
  assert.ok(!JSON.stringify(cards.map((c) => c.props)).includes("note_rate"), "no rate on any card");
  const rec1 = await record(x.token, x.appId); assert.equal("numbers" in rec1, false, "no numbers at L1 before the review");
  // NO_RATE_BEFORE_MLO_REVIEW: 32.1 refuses a personal-terms card without the approved review
  const refused = await journey.call("POST", `/v1/applications/${x.appId}/tools/32.1/send_card`, { actor: INTAKE, input: { party_id: x.partyId, kind: "StatusCard", copy_key: "terms.presented", props: { quote_id: x.quoteId }, personal_terms: true, subject: { application_id: x.appId }, created_by: "agent:intake" } });
  assert.notEqual(refused.status, 200); assert.match(JSON.stringify(refused.body), /NO_RATE_BEFORE_MLO_REVIEW/);
  assert.equal((await cardsOf(x.appId, x.partyId)).filter((c) => c.copy_key === "terms.presented").length, 0);
  // the typed identity proves the party to the API (SSN last four + DOB → L2: personal terms render at L2+, 01 §5); the MLO of record approves at 09:20
  const l2 = await sapi("POST", "/v1/borrower/auth/l2", { ssn_last4: PAT.ssn_last4, date_of_birth: PAT.dob }, x.token); assert.equal(l2.status, 200, JSON.stringify(l2.body));
  await approveReview(x, EDT("2026-10-21", "09:20"));
  const presented = await appEvents(x.appId, "terms.presented"); assert.equal(presented.length, 1, "20.3 presentTerms after the approval");
  assert.equal(presented[0]!.payload["attribution"], "reviewed by Jordan Rivera, NMLSR ID 987654"); assert.equal(presented[0]!.payload["disclaimer_template"], DISCLAIMER_TEMPLATE);
  assert.equal((await timersOf(x.appId)).find((z) => z.code === "SM_MLO_PREAPP_TERMS_REVIEW_1BH")!.status, "satisfied");
  const card = (await cardsOf(x.appId, x.partyId)).find((c) => c.copy_key === "terms.presented"); assert.ok(card, "the terms StatusCard"); assert.equal(card!.props["personal_terms"], true); assert.equal(card!.props["mlo_review_approved"], true);
  assert.equal(card!.props["attribution"], "reviewed by Jordan Rivera, NMLSR ID 987654"); assert.deepEqual(card!.props["disclaimer"], { template: DISCLAIMER_TEMPLATE, statement: DISCLAIMER_STATEMENT }, "the 20.4 written-quote disclaimer block");
  assert.deepEqual([(card!.props["copy_tokens"] as Json)["mlo.name"], (card!.props["copy_tokens"] as Json)["mlo.nmlsr_id"]], ["Jordan Rivera", "987654"]); assert.match(String((card!.props["copy_tokens"] as Json)["rate"]), /^\d\.\d{3}%$/, "the rate is 20.4's quote");
  assert.equal((await entity("leads", x.appId))!["status"], "terms_presented");
  const rec2 = await record(x.token, x.appId); assert.equal((rec2["numbers"] as Json)["figures_source"], "quote", "the Record's Numbers block from the quote");
  const proceed = await pendingCard(x.appId, x.partyId, "entry.proceed.question"); assert.equal(proceed.command_ref, "lead.proceed"); assert.deepEqual((proceed.props["options"] as { id: string }[]).map((o) => o.id), ["proceed", "not_yet"]);
});
test("32.14-T14: Given `terms_presented`, when the borrower taps Get my real numbers, then `application.received` is logged, `REGB_1002_9_DECISION_30` is armed, 32.3's E6 cards (`consent.esign.title`, `consent.tcpa.title`, `consent.credit.title{hard_pull}`) are sent, and `credit.authorize{hard_pull}` is still refused below L3 (32.3 T4 unchanged).", { skip }, async () => {
  // the REAL organic path, end to end: the anonymous minute on the lead (S0–S2), the code with the lead cookie (S3), the application from the lead, S4, then Proceed
  await seedS4(); clock.set(EDT("2026-10-21", "11:00"));
  const l = await refiLead("AZ"); const shown = await range(l.token); assert.equal(shown.status, 200, JSON.stringify(shown.body)); assert.ok(shown.body["range"], "the published range before any identity");
  const req = await api("POST", "/v1/borrower/auth/otp", { action: "request", channel: "email", destination: QUINN.email }); assert.equal(req.status, 200, JSON.stringify(req.body));
  const ver = await api("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: req.body["challenge_id"], code: req.body["fake_code"] }, withLead(l.token)); assert.equal(ver.status, 200, JSON.stringify(ver.body));
  const x: S4Party = { appId: l.id, partyId: (ver.body["party"] as Json)["party_id"] as string, token: ver.body["token"] as string, sessionId: (ver.body["session"] as Json)["session_id"] as string, quoteId: "" }; await settle(); Object.assign(s4.quinn, x);
  // the application from the lead keeps the lead's id (one id space: 20.3's conversion names it), the interview is open, the thread reads disclosure → entry.resumed, no goal card — and NO Reg B request yet
  const leadEvs = await leadEvents(l.id); for (const t of ["lead.goal.set", "lead.state.set", "lead.estimate.set", "lead.range.shown", "lead.linked", "lead.authenticated"]) assert.ok(leadEvs.some((e) => e.type === t), `${t} on the lead`);
  assert.equal((await db.query<{ channel: string }>(`SELECT channel::text AS channel FROM applications WHERE id = $1`, [l.id]))[0]?.channel, "organic", "the application is the lead's id");
  assert.ok(await entity("applications", x.appId), "21.1's interview is open on it"); assert.equal((await entity("applications", x.appId))!["transaction_type"], "limited_cash_out");
  assert.equal((await appEvents(x.appId, "application.received")).length, 0, "no Reg B request at sign-in");
  const agentLines = (await thread(x.token)).messages.filter((m) => m["sender"] === "agent").map((m) => String(m["body_text"] ?? "")); assert.equal(agentLines[0], "{{copy:entry.disclosure.first}}"); assert.equal(agentLines[1], "{{copy:entry.resumed}}");
  assert.equal((await cardsOf(x.appId, x.partyId)).filter((c) => c.copy_key === "entry.goal.question" || c.copy_key === "consent.credit.title").length, 0, "no goal card, no hard-pull card: S4 opens instead");
  // S4 on the real lead: the identity typed at L1, the soft pull at L1, the FAKE bureau's tier, the review, the terms
  clock.set(EDT("2026-10-21", "11:02")); await typeIdentity(QUINN, x);
  clock.set(EDT("2026-10-21", "11:05")); const affirmed = await affirmSoftPull(QUINN, x); assert.equal(affirmed.status, 201, JSON.stringify(affirmed.body));
  assert.equal((await appEvents(x.appId, "credit.softpull.received"))[0]!.payload["tier"], "760–779");
  const requested = await appEvents(x.appId, "terms.presentation.requested"); assert.equal(requested.length, 1); x.quoteId = String(requested[0]!.payload["quote_id"]); s4.quinn.quoteId = x.quoteId;
  assert.equal((await sapi("POST", "/v1/borrower/auth/l2", { ssn_last4: QUINN.ssn_last4, date_of_birth: QUINN.dob }, x.token)).status, 200);
  await approveReview(x, EDT("2026-10-21", "11:20"));
  assert.equal((await entity("leads", x.appId))!["status"], "terms_presented"); clock.set(EDT("2026-10-21", "11:30"));
  assert.equal((await appEvents(x.appId, "application.received")).length, 0, "no Reg B request before Proceed");
  const proceed = await pendingCard(x.appId, x.partyId, "entry.proceed.question");
  // Get my real numbers → 32.14 lead.proceed → 20.3 explainProgram{convert} → application.received (Reg B)
  const r = await resolve(x.token, proceed.card_instance_id, { option_id: "proceed", evidence: { option_id: "proceed", tapped_at: clock.now() } }); assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body["command"], "lead.proceed"); assert.ok((r.body["events"] as string[]).includes("application.received"), JSON.stringify(r.body["events"])); assert.equal((r.body["result"] as Json)["choice"], "proceed");
  const received = await appEvents(x.appId, "application.received"); assert.ok(received.length >= 1); assert.equal(received[0]!.payload["transaction_type"], "limited_cash_out"); assert.equal(received[0]!.payload["occupancy"], "primary");
  const lead = (await entity("leads", x.appId))!; assert.equal(lead["status"], "converted"); assert.equal(lead["application_id"], x.appId);
  const regb = (await timersOf(x.appId)).find((t) => t.code === "REGB_1002_9_DECISION_30"); assert.ok(regb, "REGB_1002_9_DECISION_30 armed"); assert.equal(regb!.status, "armed");
  // 32.3's E6 cards fire exactly as built: e-sign, TCPA (optional), the hard-pull authorization that needs L3
  const esign = await pendingCard(x.appId, x.partyId, "consent.esign.title"); assert.equal(esign.command_ref, "consent.capture"); assert.equal(esign.props["consent_kind"], "esign");
  const tcpa = await pendingCard(x.appId, x.partyId, "consent.tcpa.title"); assert.equal(tcpa.props["optional"], true);
  const hard = await pendingCard(x.appId, x.partyId, "consent.credit.title"); assert.equal(hard.command_ref, "credit.authorize"); assert.deepEqual(hard.props["scope"], ["hard_pull"]); assert.equal(hard.props["requires_level"], "L3"); assert.equal(hard.props["gate"], "SM_IDENTITY_IAL2_GATE"); assert.equal((hard.props["command_args"] as Json)["kind"], "hard_pull");
  assert.equal((await cardsOf(x.appId, x.partyId)).filter((c) => c.copy_key === "consent.credit.soft.title").length, 1, "the soft-pull card is not sent again");
  // the hard pull still needs L3 (32.3 T4 unchanged): the L2 session is refused with the identity gate and nothing is written
  assert.equal(await sessionLevel(x.sessionId), "L2");
  const refused = await resolve(x.token, hard.card_instance_id, { evidence: { affirmation_method: "checkbox_with_text", typed_name: QUINN.name, checkbox: true, disclosure_version_shown: hard.props["disclosure_version_id"] } });
  assert.equal(refused.status, 403); assert.equal(refused.body["code"], "LEVEL_REQUIRED"); assert.equal(refused.body["gate"], "SM_IDENTITY_IAL2_GATE"); assert.equal(refused.body["copy_key"], "gate.identity.verify_first"); assert.deepEqual(Object.keys(refused.body).sort(), ["code", "copy_key", "gate"]);
  const direct = await sapi("POST", "/v1/borrower/commands/credit.authorize", { kind: "hard_pull", lead_id: x.appId, text_hash: "sha256:hard", subject: { application_id: x.appId } }, x.token); assert.equal(direct.status, 403); assert.equal(direct.body["gate"], "SM_IDENTITY_IAL2_GATE");
  assert.equal((await cardsOf(x.appId, x.partyId)).find((c) => c.card_instance_id === hard.card_instance_id)!.status, "pending", "the card stays pending");
  assert.equal((await appEvents(x.appId, "credit.authorization.captured")).filter((e) => e.payload["kind"] === "hard_application" || e.payload["kind"] === "hard_pull").length, 0);
  assert.equal((await appEvents(x.appId, "credit.report.ordered")).length, 0, "nothing ordered");
});
test("32.14-T15: Given `terms_presented`, when the borrower taps Not yet, then nothing is ordered or pulled, `intent.deferred` is logged, the lead stays `terms_presented`, and `SM_LEAD_INACTIVITY_EXPIRY_90` remains the only clock.", { skip }, async () => {
  // Sam: the same S4 path to terms_presented (the FAKE bureau's tier from the last four 2323: 620 + 123 → 740–759)
  const x = await openS4(SAM, EDT("2026-10-21", "10:00")); Object.assign(s4.sam, x);
  // the clocks the application row and the lead carry before S4 (application.started's own — e.g. 21.3's anti-coercion gate — and SM_LEAD_INACTIVITY_EXPIRY_90 from lead.created)
  const armedBeforeS4 = new Set((await timersOf(x.appId)).filter((t) => t.status === "armed").map((t) => t.code)); assert.ok(armedBeforeS4.has("SM_LEAD_INACTIVITY_EXPIRY_90"));
  clock.set(EDT("2026-10-21", "10:02")); await typeIdentity(SAM, x);
  clock.set(EDT("2026-10-21", "10:05")); const affirmed = await affirmSoftPull(SAM, x); assert.equal(affirmed.status, 201, JSON.stringify(affirmed.body));
  assert.equal((await appEvents(x.appId, "credit.softpull.received"))[0]!.payload["tier"], "740–759");
  const requested = await appEvents(x.appId, "terms.presentation.requested"); assert.equal(requested.length, 1); x.quoteId = String(requested[0]!.payload["quote_id"]); s4.sam.quoteId = x.quoteId;
  assert.equal((await sapi("POST", "/v1/borrower/auth/l2", { ssn_last4: SAM.ssn_last4, date_of_birth: SAM.dob }, x.token)).status, 200);
  await approveReview(x, EDT("2026-10-21", "10:20"));
  assert.equal((await entity("leads", x.appId))!["status"], "terms_presented");
  const before = { events: (await appEvents(x.appId)).length, cards: (await cardsOf(x.appId)).length };
  // Not yet → lead.proceed{not_yet} → 20.3 defer_intent → intent.deferred: no order, no pull, no document, no application
  clock.set(EDT("2026-10-21", "10:25"));
  const proceed = await pendingCard(x.appId, x.partyId, "entry.proceed.question");
  const r = await resolve(x.token, proceed.card_instance_id, { option_id: "not_yet", evidence: { option_id: "not_yet", tapped_at: clock.now() } }); assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok((r.body["events"] as string[]).includes("intent.deferred"), JSON.stringify(r.body["events"])); const out = r.body["result"] as Json; assert.equal(out["deferred"], true); assert.equal(out["ordered"], false); assert.equal(out["pulled"], false); assert.equal(out["document"], null);
  const deferred = await appEvents(x.appId, "intent.deferred"); assert.equal(deferred.length, 1); assert.equal(deferred[0]!.payload["lead_id"], x.appId); assert.equal(deferred[0]!.payload["status"], "terms_presented"); assert.deepEqual(deferred[0]!.payload["clocks"], ["SM_LEAD_INACTIVITY_EXPIRY_90"]);
  const lead = (await entity("leads", x.appId))!; assert.equal(lead["status"], "terms_presented"); assert.equal(lead["application_id"], null); assert.deepEqual(lead["quote_ids"], [x.quoteId], "the presented quote stays (SM_QUOTE_VALIDITY_GATE governs a re-quote)");
  const after = await appEvents(x.appId); assert.deepEqual([...new Set(after.slice(before.events).map((e) => e.type))].filter((t) => t !== "command.executed"), ["intent.deferred"], "the deferral is the only new fact (beside the bus's own command record)");
  for (const t of ["application.received", "credit.report.ordered", "document.received", "lead.qualified", "quote.render.requested"]) assert.equal(after.filter((e) => e.type === t).length, 0, `no ${t}`);
  assert.equal(after.filter((e) => e.type === "credit.softpull.requested").length, 1, "the one soft pull, from before");
  assert.equal((await cardsOf(x.appId)).length, before.cards, "no new card");
  const th = await thread(x.token); assert.ok(th.messages.some((m) => m["body_text"] === "{{copy:entry.proceed.not_yet}}"), "the not-yet line");
  // SM_LEAD_INACTIVITY_EXPIRY_90 is the only clock: still armed; the review clock is satisfied; no Reg B decision clock, no LE clock; S4 armed nothing else but the quote's gates
  const timers = await timersOf(x.appId); const armed = timers.filter((t) => t.status === "armed");
  assert.ok(armed.some((t) => t.code === "SM_LEAD_INACTIVITY_EXPIRY_90"), `the inactivity clock: ${JSON.stringify(timers)}`); assert.ok(armed.find((t) => t.code === "SM_LEAD_INACTIVITY_EXPIRY_90")!.due_at, "a clock with a due date");
  assert.equal(timers.find((t) => t.code === "SM_MLO_PREAPP_TERMS_REVIEW_1BH")!.status, "satisfied");
  for (const t of armed) if (!armedBeforeS4.has(t.code)) assert.ok(t.code.endsWith("_GATE") && t.due_at === null, `${t.code} is armed since S4 — not a clock a deferred lead carries`);
  assert.ok(!timers.some((t) => t.code === "REGB_1002_9_DECISION_30" || t.code === "REGZ_1026_19E1_LE_3BD"));
});
test("32.14-T16: Given a deep-link token for a pending card, when opened without a session, then the sign-in chooser renders with the token retained; after the code, `ui_events{deep_link_opened}` is written and the card is pinned; given an expired token, then `deep_link.expired` renders with the sign-in offer; given another party's token, then `error.party_scope` and no target is revealed.", { skip }, async () => {
  await journeyReady();
  // a pending card for Alex (the intake agent's send_card) and the deep link a touch would carry
  const cardId = await sendCard(alex.partyId, journey.appId, "ChoiceCard", "entry.goal.question", { title: "", options: [{ id: "buy", label: "Buy a home" }, { id: "lower_rate", label: "Lower my rate or payment" }, { id: "cash_out", label: "Take cash out" }] });
  const link = await router.ui.createDeepLink({ party_id: alex.partyId, target: { card_instance_id: cardId }, now: clock.now() });
  // opened without a session: the API answers 401 with the sign-in key — the app keeps the token and renders the chooser (S5); nothing about the target is revealed
  const anon = await sapi("GET", `/v1/borrower/deeplink/${link.token}`);
  assert.equal(anon.status, 401); assert.equal(anon.body["code"], "AUTH_REQUIRED"); assert.equal(anon.body["copy_key"], "auth.sign_in"); assert.deepEqual(Object.keys(anon.body).sort(), ["code", "copy_key"]);
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ui_events WHERE kind = 'deep_link_opened' AND card_instance_id = $1`, [cardId]))[0]!.n, "0");
  // after the code: the token resolves to the card, ui_events{deep_link_opened} is written on the session, the card is the thread's pinned ask
  const s = await signIn(EMAIL_A); await settle(); assert.equal(s.party_id, alex.partyId);
  const ok = await sapi("GET", `/v1/borrower/deeplink/${link.token}`, undefined, s.token);
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.deepEqual(ok.body["target"], { card_instance_id: cardId }); assert.deepEqual(Object.keys(ok.body).sort(), ["expires_at", "target", "token"]);
  const opened = await db.query<{ party_id: string; session_id: string | null; card_instance_id: string | null; payload: Json }>(`SELECT party_id, session_id, card_instance_id, payload FROM ui_events WHERE kind = 'deep_link_opened' AND card_instance_id = $1`, [cardId]);
  assert.equal(opened.length, 1); assert.equal(opened[0]!.party_id, alex.partyId); assert.equal(opened[0]!.session_id, s.session_id); assert.deepEqual(opened[0]!.payload["target"], { card_instance_id: cardId });
  const t = await thread(s.token); assert.ok(t.pinned, "a pinned card"); assert.equal(t.pinned!["card_instance_id"], cardId); assert.equal(t.pinned!["status"], "pending"); assert.equal(t.pinned!["copy_key"], "entry.goal.question");
  // an expired token: 410 with the expired key — the shell renders deep_link.expired with the sign-in offer (the same text the library states for the API's key)
  const old = await router.ui.createDeepLink({ party_id: alex.partyId, target: { card_instance_id: cardId }, now: new Date(Date.parse(clock.now()) - (DEEP_LINK_DAYS * 24 * 3600 * 1000 + 60_000)).toISOString() });
  const gone = await sapi("GET", `/v1/borrower/deeplink/${old.token}`, undefined, s.token);
  assert.equal(gone.status, 410, JSON.stringify(gone.body)); assert.equal(gone.body["code"], "DEEP_LINK_EXPIRED"); assert.deepEqual(Object.keys(gone.body).sort(), ["code", "copy_key"]);
  assert.equal(copyText(gone.body["copy_key"] as string), copyText("deep_link.expired"));
  // an unknown token: 404 — deep_link.unknown
  const unknown = await sapi("GET", `/v1/borrower/deeplink/nope-${randomUUID().slice(0, 8)}`, undefined, s.token);
  assert.equal(unknown.status, 404); assert.equal(unknown.body["code"], "DEEP_LINK_UNKNOWN"); assert.equal(copyText(unknown.body["copy_key"] as string), copyText("deep_link.unknown"));
  // another party's token: the party-scope refusal — no target, no hint that the link exists, and no ui_events row for the other party
  const b = await signIn(EMAIL_B); await settle(); assert.equal(b.party_id, blake.partyId);
  const other = await sapi("GET", `/v1/borrower/deeplink/${link.token}`, undefined, b.token);
  assert.equal(other.status, 403, JSON.stringify(other.body)); assert.equal(other.body["code"], "PARTY_SCOPE"); assert.equal(other.body["copy_key"], "error.not_yours"); assert.deepEqual(Object.keys(other.body).sort(), ["code", "copy_key"]); assert.equal("target" in other.body, false);
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ui_events WHERE kind = 'deep_link_opened' AND party_id = $1`, [blake.partyId]))[0]!.n, "0");
  assert.equal((await sapi("GET", `/v1/borrower/deeplink/${link.token}`, undefined, s.token)).status, 200, "the link still resolves for its own party");
});
test("32.14-T17: Given a servicing-book borrower whose phone is on `application_borrowers.contact`, when they open Sign in and verify a code to that phone, then the session resolves to their existing party, the thread renders with the Record, and on-file numbers stay hidden until L2.", { skip }, async () => {
  await journeyReady();
  // the book's borrower: Alex on the refi-trigger application of the prior loan, the mobile on file beside the e-mail the earlier sessions used
  await db.query(`UPDATE application_borrowers SET contact = contact || $2::jsonb WHERE application_id = $1 AND contact->>'email' = $3`, [journey.appId, toJson({ phone: ALEX_PHONE }), EMAIL_A]);   // Alex's row by its e-mail: the journey's two borrower rows share a created_at, so `abIds[0]` is uuid-ordered (Blake in some runs)
  const partiesBefore = await count("parties");
  // Sign in → Text me a code → the code to that phone
  const s = await signIn(ALEX_PHONE, "sms"); await settle();
  assert.equal(s.party_id, alex.partyId, "the existing party, resolved by the phone on file"); assert.equal(s.level, "L1"); assert.equal((s.body["session"] as Json)["auth_method"], "otp_phone");
  assert.equal(await count("parties"), partiesBefore, "no new party");
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM parties WHERE contact->>'phone' = $1`, [ALEX_PHONE]))[0]!.n, "0", "the phone stays on the application borrower row; no 'Borrower (phone)' party");
  // the thread renders — the session's disclosure line first — with the Record of the application the party is a borrower on
  const t = await thread(s.token); assert.equal(t.messages[0]!["body_text"], "{{copy:entry.disclosure.first}}"); assert.ok(t.messages.some((m) => m["channel"] === "sms" && m["body_text"] === "{{copy:entry.disclosure.first}}"), "the SMS code's session opened on the SMS thread (32.3 E1)");
  const me = await sapi("GET", "/v1/borrower/me", undefined, s.token); assert.equal(me.status, 200); assert.ok((me.body["subjects"] as Json[]).some((x) => x["application_id"] === journey.appId));
  const rec = await record(s.token, journey.appId);
  assert.equal((rec["subject"] as Json)["application_id"], journey.appId); assert.equal(typeof (rec["status"] as Json)["badge"], "string", "the status renders at L1");
  // on-file numbers stay hidden until L2 (01 §5; 32.3 T3): the LE's figures exist and are omitted at L1
  assert.equal("numbers" in rec, false, "numbers omitted at L1");
  const miss = await sapi("POST", "/v1/borrower/auth/l2", { ssn_last4: "0000", date_of_birth: "1985-06-15" }, s.token); assert.equal(miss.status, 403); assert.equal(miss.body["code"], "L2_MATCH_FAILED");
  assert.equal("numbers" in (await record(s.token, journey.appId)), false, "still hidden after a failed step-up");
  const l2 = await sapi("POST", "/v1/borrower/auth/l2", { ssn_last4: "6789", date_of_birth: "1985-06-15" }, s.token); assert.equal(l2.status, 200, JSON.stringify(l2.body)); assert.equal(l2.body["level"], "L2");
  const rec2 = await record(s.token, journey.appId); const numbers = rec2["numbers"] as Json | null; assert.ok(numbers, "numbers render at L2"); assert.equal(numbers!["figures_source"], "le_v1"); assert.equal(numbers!["note_rate"], "6.125");
});
// ---------------------------------------------------------------- T20: SMS and voice entry on the same lead (§4) — the FAKE telephony webhooks (src/runtime/borrower/channels.ts)
/** The FAKE vendor's inbound webhook (x-fake-telephony: FAKE): an SMS or a call leg from a number. */
const smsIn = (from: string, text: string, sid = `SM-${randomUUID().slice(0, 8)}`) => api("POST", "/v1/webhooks/sms", { from, to: "+15550001000", body: text, message_sid: sid }, { "x-fake-telephony": "FAKE" });
const voiceIn = (from: string, call_sid: string, input: { digits?: string; speech?: string } = {}) => api("POST", "/v1/webhooks/voice", { from, to: "+15550001000", call_sid, ...input }, { "x-fake-telephony": "FAKE" });
/** What the e-delivery FAKE sent to a number on channel sms, in send order (noticeId = the copy key; subject = the rendered text). */
const textsTo = (number: string) => [...(runtime.ports.edelivery as FakeEdelivery).messages.values()].filter((m) => m.message.channel === "sms" && m.message.to === number).map((m) => ({ copy_key: m.message.noticeId, text: m.message.subject, message_id: m.messageId, consent_id: m.message.consentId }));
const evOf = async (leadId: string, type: string): Promise<Ev[]> => (await leadEvents(leadId)).filter((e) => e.type === type);
const kinds = (evs: readonly Ev[]): string[] => evs.map((e) => `${e.type}${e.payload["kind"] ? `{${String(e.payload["kind"])}}` : ""}`);

test("32.14-T20: Given an inbound SMS from an unknown number (phase 3), then the first outbound message is the disclosure, the goal prompt follows, the lead is keyed to the number, and identity is the code sent to that number.", { skip }, async () => {
  const NUMBER = phoneOf(`sms-${R}`); const spelled = `(602) 555-${NUMBER.slice(-4)}`;
  const at = (hhmm: string): string => `2026-09-10T${hhmm}:00.000Z`;   // inside the active sheet's window (published at NOW, 12 hours)
  clock.set(at("17:00"));
  // the webhook carries the vendor's signature (FAKE for the fake adapter) or it is refused before anything is read
  const unsigned = await api("POST", "/v1/webhooks/sms", { from: NUMBER, to: "+15550001000", body: "hi" }); assert.equal(unsigned.status, 400, JSON.stringify(unsigned.body)); assert.equal(unsigned.body["code"], "BAD_REQUEST");
  // an unknown number texts in: the lead, the disclosure FIRST, then the goal prompt with the three options spelled out
  const first = await smsIn(spelled, "hi", `SM-first-${R}`); await settle();
  assert.equal(first.status, 200, JSON.stringify(first.body)); assert.equal(first.body["vendor"], "FAKE"); assert.equal(first.body["channel"], "sms"); assert.equal(first.body["step"], "goal");
  const leadId = String(first.body["lead_id"]); assert.ok(leadId);
  const out1 = first.body["outbound"] as Json[]; assert.equal(out1[0]!["copy_key"], "entry.disclosure.first", "the first outbound message is the disclosure"); assert.equal(out1[1]!["copy_key"], "entry.goal.question", "the goal prompt follows");
  assert.match(String(out1[0]!["text"]), /automated assistant/); assert.ok(String(out1[0]!["text"]).includes(partnerName), "the disclosure names the lead's partner");
  for (const label of ["1) Buy a home", "2) Lower my rate or payment", "3) Take cash out"]) assert.ok(String(out1[1]!["text"]).includes(label), `the goal prompt spells out ${label}`);
  const sent1 = textsTo(NUMBER); assert.equal(sent1[0]!.copy_key, "entry.disclosure.first", "e-delivery FAKE: the disclosure went out first"); assert.equal(sent1[1]!.copy_key, "entry.goal.question"); assert.equal(sent1.length, 2);
  // the lead is keyed to the number (prospect.phone), global, party-less, L0 — and the same number, however spelled, resolves to the same lead
  const lead1 = (await entity("leads", leadId))!; assert.equal((lead1["prospect"] as Json)["phone"], NUMBER); assert.equal(lead1["party_id"], null); assert.equal(lead1["assurance_level"], "L0_contact_unverified"); assert.equal(lead1["channel"], "organic"); assert.equal(((lead1["interactions"] as Json[])[0])!["channel"], "sms");
  assert.equal((await router.channels.leadForNumber(spelled))?.lead_id, leadId); assert.equal((await router.channels.leadForNumber(NUMBER))?.lead_id, leadId);
  assert.equal((await db.query<{ n: string }>(`SELECT count(DISTINCT id)::text AS n FROM entity_records WHERE kind = 'leads' AND data->'prospect'->>'phone' = $1`, [NUMBER]))[0]!.n, "1", "one lead per number");
  // the lead's own log: created, the interaction, the disclosure and its acknowledgment before any other lead event; rule 10's informational consent from the number given; no session, no party
  const ev1 = kinds(await leadEvents(leadId));
  assert.deepEqual(ev1.slice(0, 4), ["lead.created", "lead.interaction.started", "lead.disclosure.delivered", "consent.granted{ai_disclosure_ack}"], JSON.stringify(ev1));
  assert.ok(ev1.includes("consent.granted{tcpa_sms}"), "the number given in the inquiry is prior express consent for informational texts about it (20.3 rule 10)"); assert.ok(!ev1.includes("lead.authenticated"));
  assert.equal((await evOf(leadId, "lead.interaction.started"))[0]!.payload["channel"], "sms");
  assert.equal(((lead1["classifier_log"] as Json[]) ?? []).length, 1, "the goal prompt passed 20.3's utterance classifier (delivered, not blocked)"); assert.equal(((lead1["classifier_log"] as Json[])[0])!["delivered"], true);
  // the replies map onto the S1 chips exactly as the app's: "2" → lower_rate → limited_cash_out, "1" → primary, "Arizona" → AZ (31.1 readiness open), two amounts → the estimates; each through lead.answer, each followed by the next prompt
  clock.set(at("17:01"));
  const goal = await smsIn(NUMBER, "2"); await settle(); assert.equal(goal.status, 200, JSON.stringify(goal.body)); assert.equal(goal.body["refused"], undefined, JSON.stringify(goal.body));
  assert.ok((goal.body["events"] as string[]).includes("lead.goal.set"), JSON.stringify(goal.body["events"])); assert.equal(goal.body["step"], "occupancy"); assert.equal((goal.body["outbound"] as Json[])[0]!["copy_key"], "entry.occupancy.question");
  assert.equal((await entity("leads", leadId))!["transaction_intent"], "limited_cash_out");
  const occ = await smsIn(NUMBER, "1"); await settle(); assert.equal(occ.status, 200, JSON.stringify(occ.body)); assert.equal(occ.body["refused"], undefined, JSON.stringify(occ.body));
  assert.equal((await entity("leads", leadId))!["occupancy"], "primary"); assert.equal(occ.body["step"], "state"); assert.equal((occ.body["outbound"] as Json[])[0]!["copy_key"], "entry.state.question");
  // something that is not an answer to the chip: the same prompt again, nothing written
  const again = await smsIn(NUMBER, "maybe later"); assert.equal(again.body["step"], "state"); assert.equal((again.body["outbound"] as Json[])[0]!["copy_key"], "entry.state.question"); assert.equal((await entity("leads", leadId))!["consumer_state"], null);
  // "human" at any time → 20.3's warm transfer on the lead's own interaction; "are you a real person?" → 20.3's truthful answer with the disclosure re-logged
  const human = await smsIn(NUMBER, "I want a human"); assert.ok((human.body["events"] as string[]).includes("human.transfer.requested"), JSON.stringify(human.body)); assert.equal((human.body["outbound"] as Json[])[0]!["copy_key"], "thread.human_requested");
  const disclosedBefore = (await evOf(leadId, "lead.disclosure.delivered")).length;
  const real = await smsIn(NUMBER, "are you a real person?"); assert.equal((real.body["outbound"] as Json[])[0]!["copy_key"], "entry.disclosure.real_person"); assert.match(String((real.body["outbound"] as Json[])[0]!["text"]), /^No — I'm Partner Bank/);
  assert.equal((await evOf(leadId, "lead.disclosure.delivered")).length, disclosedBefore + 1, "the disclosure re-logged (reason direct_question)");
  clock.set(at("17:02"));
  const st = await smsIn(NUMBER, "Arizona"); await settle(); assert.equal(st.status, 200, JSON.stringify(st.body)); assert.equal(st.body["refused"], undefined, JSON.stringify(st.body));
  assert.equal((await entity("leads", leadId))!["consumer_state"], "AZ"); assert.equal(st.body["step"], "estimate"); assert.deepEqual((st.body["outbound"] as Json[]).map((l) => l["copy_key"]), ["entry.estimate.value", "entry.estimate.balance"]);
  // the estimates (bigint cents, never a float) complete the chips: the published range (20.3 rule 7 through 20.2's checklist) goes out, then identity — the code to that number
  const est = await smsIn(NUMBER, "worth about $450,000 and I owe $300,000"); await settle(); assert.equal(est.status, 200, JSON.stringify(est.body)); assert.equal(est.body["refused"], undefined, JSON.stringify(est.body));
  const lead3 = (await entity("leads", leadId))!; assert.equal(String(lead3["value_estimate_cents"]), "45000000"); assert.equal(String(lead3["stated_existing_balance_cents"]), "30000000");
  const estOut = (est.body["outbound"] as Json[]).map((l) => String(l["copy_key"]));
  assert.deepEqual(estOut.slice(0, 3), ["entry.range.card", "entry.range.promise", "entry.range.disclaimer"], `the range card, the promise and the 1026.24 footer (${estOut.join(", ")})`);
  const shown = await evOf(leadId, "lead.range.shown"); assert.equal(shown.length, 1); assert.equal(shown[0]!.payload["product_code"], "FRM30"); assert.equal(shown[0]!.payload["low_pct"], "5.875"); assert.equal(shown[0]!.payload["high_pct"], "6.375");
  assert.match(String((est.body["outbound"] as Json[])[0]!["text"]), /5\.875%.*6\.375%/, "the sheet's FRM30 low and high"); assert.ok(!/tier|LLPA/i.test(JSON.stringify(est.body["outbound"])), "no tier, no LLPA, no borrower figure");
  // identity is the code sent to that number: the same auth_challenges row and the same e-delivery send as POST /v1/borrower/auth/otp {channel: sms}
  assert.equal(est.body["step"], "identify"); assert.match(String(est.body["fake_code"]), /^\d{6}$/, "non-production: the FAKE code is echoed (as the OTP route does)");
  assert.deepEqual(estOut.slice(3), ["auth.code.sent", "auth.code.enter"]); assert.match(String((est.body["outbound"] as Json[])[3]!["message_id"]), /^otp:/);
  const challenge = (await db.query<{ challenge_id: string; kind: string; channel: string; destination: string; delivery: string; consumed_at: string | null; party_id: string | null }>(`SELECT challenge_id, kind, channel, destination, delivery, consumed_at, party_id FROM auth_challenges WHERE destination = $1 ORDER BY created_at DESC LIMIT 1`, [NUMBER]))[0]!;
  assert.equal(challenge.kind, "otp"); assert.equal(challenge.channel, "sms"); assert.equal(challenge.destination, NUMBER, "the code went to the number the message came from"); assert.equal(challenge.delivery, "FAKE"); assert.equal(challenge.consumed_at, null);
  const codeText = textsTo(NUMBER).find((m) => m.message_id === `otp:${challenge.challenge_id}`); assert.ok(codeText, "the code was texted to the number through the e-delivery FAKE"); assert.equal(codeText!.consent_id, "policy:authentication_otp");
  assert.equal(String((est.body["outbound"] as Json[])[3]!["message_id"]), `otp:${challenge.challenge_id}`);
  const code = String(est.body["fake_code"]); const wrong = code === "000000" ? "000001" : "000000";
  const bad = await smsIn(NUMBER, wrong); assert.equal((bad.body["outbound"] as Json[])[0]!["copy_key"], "auth.code_wrong"); assert.equal(bad.body["session_opened"], false); assert.equal((await entity("leads", leadId))!["party_id"], null);
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM sessions s JOIN parties p ON p.id = s.party_id WHERE p.contact->>'phone' = $1`, [NUMBER]))[0]!.n, "0", "no session before the right code");
  // the right code: the party resolved by the destination, the lead linked to it (never copied), an L1 otp_phone session, the session hook on channel sms — on the SAME lead
  clock.set(at("17:03"));
  const good = await smsIn(NUMBER, code); await settle(); assert.equal(good.status, 200, JSON.stringify(good.body)); assert.equal(good.body["session_opened"], true); assert.equal(good.body["level"], "L1"); assert.equal(good.body["step"], null);
  assert.ok(!("token" in good.body) && !JSON.stringify(good.body).includes(NUMBER), "no session token and no number leaves on the vendor's channel");
  const consumed = (await db.query<{ consumed_at: string | null; party_id: string | null }>(`SELECT consumed_at, party_id FROM auth_challenges WHERE challenge_id = $1`, [challenge.challenge_id]))[0]!; assert.ok(consumed.consumed_at); assert.ok(consumed.party_id);
  const partyId = consumed.party_id!;
  const session = (await db.query<{ session_id: string; level: string; auth_method: string; last_l1_at: string | null; user_agent: string | null }>(`SELECT session_id, level, auth_method, last_l1_at, user_agent FROM sessions WHERE party_id = $1 ORDER BY created_at DESC LIMIT 1`, [partyId]))[0]!;
  assert.equal(session.level, "L1"); assert.equal(session.auth_method, "otp_phone"); assert.equal(session.last_l1_at, at("17:03"), "a code was verified: the fresh-L1 rule's timestamp"); assert.match(String(session.user_agent), /^telephony:FAKE:sms$/);
  assert.equal((await db.query<{ phone: string }>(`SELECT contact->>'phone' AS phone FROM parties WHERE id = $1`, [partyId]))[0]!.phone, NUMBER, "the party is the destination's");
  const lead4 = (await entity("leads", leadId))!; assert.equal(lead4["party_id"], partyId, "lead.linked{party_id}: the same lead, linked"); assert.equal(lead4["assurance_level"], "L1_channel_otp");
  const linked = await evOf(leadId, "lead.linked"); assert.equal(linked.length, 1); assert.equal(linked[0]!.payload["party_id"], partyId); assert.equal(linked[0]!.payload["method"], "otp_sms");
  const authed = await evOf(leadId, "lead.authenticated"); assert.equal(authed.length, 1, "lead.authenticated{level=L1} on the number's lead, not on a second lead"); assert.equal(authed[0]!.payload["level"], "L1");
  assert.equal((await db.query<{ n: string }>(`SELECT count(DISTINCT id)::text AS n FROM entity_records WHERE kind = 'leads' AND data->>'party_id' = $1`, [partyId]))[0]!.n, "1", "the SMS lead is the party's only lead (nothing copied, nothing duplicated)");
  // 32.3 E2 on the SMS session: the conversation's first agent line on channel sms is the disclosure, then the lead's answers as one receipt (32.14 S3); both texted to the number (the SMS thread is the conversation)
  const conv = (await db.query<{ conversation_id: string }>(`SELECT conversation_id FROM conversations WHERE party_id = $1`, [partyId]))[0]!;
  const lines = await db.query<{ sender: string; channel: string; body_text: string | null }>(`SELECT sender, channel, body_text FROM messages WHERE conversation_id = $1 ORDER BY at, created_at, message_id`, [conv.conversation_id]);
  assert.equal(lines[0]!.sender, "agent"); assert.equal(lines[0]!.channel, "sms"); assert.equal(lines[0]!.body_text, "{{copy:entry.disclosure.first}}");
  const forwarded = (good.body["outbound"] as Json[]).map((l) => String(l["copy_key"])); assert.equal(forwarded[0], "entry.disclosure.first", "the session's first line went out to the number"); assert.ok(forwarded.includes("entry.resumed"), `the lead's answers resumed as one receipt line (${forwarded.join(", ")})`);
  const app = (await db.query<{ id: string; channel: string; transaction_type: string; occupancy: string }>(`SELECT a.id, a.channel::text AS channel, a.transaction_type::text AS transaction_type, a.occupancy::text AS occupancy FROM applications a JOIN application_borrowers ab ON ab.application_id = a.id WHERE ab.party_id = $1`, [partyId]))[0];
  assert.ok(app, "the application from the lead (S3 ii)"); assert.equal(app!.channel, "organic"); assert.equal(app!.transaction_type, "limited_cash_out"); assert.equal(app!.occupancy, "primary");
  // after L1 a text from the number is a borrower message on the party's conversation: "are you a real person?" → 32.3 T2's answer, texted back
  clock.set(at("17:04"));
  const after = await smsIn(NUMBER, "are you a real person?"); await settle(); assert.equal(after.status, 200, JSON.stringify(after.body)); assert.equal(after.body["level"], "L1"); assert.equal((after.body["outbound"] as Json[])[0]!["copy_key"], "entry.disclosure.real_person");
  const borrowerLines = await db.query<{ channel: string; body_text: string | null }>(`SELECT channel, body_text FROM messages WHERE conversation_id = $1 AND sender = 'borrower'`, [conv.conversation_id]); assert.equal(borrowerLines.length, 1); assert.equal(borrowerLines[0]!.channel, "sms"); assert.equal(borrowerLines[0]!.body_text, "are you a real person?");
  // voice on the same lead model (§4): an unknown caller → lead.start{channel: voice_inbound}, the spoken disclosure first (T-03-01), the goal prompt spoken; the chips by keypad and speech; a state 31.1 has no rows for closes the lead (no range, no code); consents are never taken by voice
  const CALLER = phoneOf(`voice-${R}`); const CALL = `CA-${R}`;
  clock.set(at("17:10"));
  const ring = await voiceIn(CALLER, CALL); await settle(); assert.equal(ring.status, 200, JSON.stringify(ring.body)); assert.equal(ring.body["vendor"], "FAKE"); assert.equal(ring.body["channel"], "voice"); assert.equal(ring.body["call_id"], CALL);
  const say = ring.body["say"] as Json[]; assert.equal(say[0]!["copy_key"], "entry.disclosure.first", "the spoken disclosure first"); assert.equal(say[1]!["copy_key"], "entry.voice.started"); assert.equal(say.at(-1)!["copy_key"], "entry.goal.question"); assert.deepEqual(ring.body["texted"], [], "nothing is texted on the first leg");
  const voiceLead = String(ring.body["lead_id"]); assert.notEqual(voiceLead, leadId); const vl = (await entity("leads", voiceLead))!; assert.equal((vl["prospect"] as Json)["phone"], CALLER); assert.equal(((vl["interactions"] as Json[])[0])!["channel"], "voice_inbound"); assert.equal(((vl["interactions"] as Json[])[0])!["interaction_id"], CALL);
  const vev = kinds(await leadEvents(voiceLead)); assert.deepEqual(vev.slice(0, 4), ["lead.created", "lead.interaction.started", "lead.disclosure.delivered", "consent.granted{ai_disclosure_ack}"]); assert.ok(vev.includes("consent.granted{tcpa_voice}"));
  const d1 = await voiceIn(CALLER, CALL, { digits: "3" }); await settle(); assert.equal(d1.body["refused"], undefined, JSON.stringify(d1.body)); assert.equal((d1.body["say"] as Json[])[0]!["copy_key"], "entry.occupancy.question"); assert.equal((await entity("leads", voiceLead))!["transaction_intent"], "cash_out");
  const d2 = await voiceIn(CALLER, CALL, { digits: "1" }); await settle(); assert.equal((d2.body["say"] as Json[])[0]!["copy_key"], "entry.state.question");
  const d3 = await voiceIn(CALLER, CALL, { speech: "New York" }); await settle(); assert.equal(d3.status, 200, JSON.stringify(d3.body));
  assert.equal((await entity("leads", voiceLead))!["consumer_state"], "NY"); assert.equal((await entity("leads", voiceLead))!["status"], "closed_lost", "a state 31.1 readiness closes ends the lead"); assert.equal(d3.body["step"], "closed");
  assert.ok((d3.body["say"] as Json[]).some((l) => l["copy_key"] === "lead.state_closed"), JSON.stringify(d3.body["say"])); assert.ok((await evOf(voiceLead, "licensing.gate.blocked")).length >= 1);
  assert.deepEqual(d3.body["texted"], [], "no range and no identity code for a closed state"); assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM auth_challenges WHERE destination = $1`, [CALLER]))[0]!.n, "0");
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM consents WHERE party_id::text = $1`, [voiceLead]))[0]!.n, "0", "no consents row was ever captured by voice (CONSENT_VOICE_VOID)");
  // the vendor's retry of the same inbound post sends nothing twice (idempotent by message id)
  const before = textsTo(NUMBER).length; const retry = await smsIn(NUMBER, "hi", `SM-first-${R}`); assert.equal(retry.status, 200); assert.equal(textsTo(NUMBER).length, before, "a retried inbound post re-sends nothing");
});

// ---------------------------------------------------------------- DELTA-16 (32.14 §2 S6, §6): link my loan — not a T-id; the fourth 32.14 tool on the bus (party.linkLoan)
test("32.14 DELTA-16: party.linkLoan — an exact match on loan_last4 (or property_zip) + ssn_last4 + date_of_birth sets borrowers.party_id and raises the session to L2; any single mismatch refuses with one code and never says which field", { skip }, async () => {
  const seedLoan = async (n: number, zip: string): Promise<{ loan_id: string; borrower_id: string; last4: string }> => {
    const prop = (await db.query<{ id: string }>(`INSERT INTO properties (address_line1, city, state, postal_code, county, property_type, occupancy, units) VALUES ($1, 'Phoenix', 'AZ', $2, 'Maricopa', 'sfr', 'primary', 1) RETURNING id`, [`${n} W Link St`, zip]))[0]!.id;
    const fnma = String(1_000_000_000 + ((parseInt(R, 16) + n * 7919) % 8_999_999_999)); const last4 = String(1000 + n);
    const loan = (await db.query<{ id: string }>(`INSERT INTO loans (fnma_loan_number, servicer_loan_number, partner_party_id, property_id, status, instrument_date, origination_date, original_upb_cents, original_term_months, first_payment_date, maturity_date, boarded_at) VALUES ($1, $2, $3, $4, 'active', '2024-09-18', '2024-09-18', 56500000, 360, '2024-11-01', '2054-10-01', '2025-01-15T00:00:00Z') RETURNING id`, [fnma, `LINK-${R}-${last4}`, partnerPartyId, prop]))[0]!.id;
    const borrower = (await db.query<{ id: string }>(`INSERT INTO borrowers (legal_name, tin_last4, date_of_birth) VALUES ($1, '4321', '1979-03-09') RETURNING id`, [`Link Borrower ${n}`]))[0]!.id;
    await db.query(`INSERT INTO loan_borrowers (loan_id, borrower_id, role, is_primary) VALUES ($1, $2, 'borrower', true)`, [loan, borrower]);
    return { loan_id: loan, borrower_id: borrower, last4 };
  };
  const signIn = async (email: string): Promise<{ token: string; party_id: string; session_id: string }> => {
    const req = await api("POST", "/v1/borrower/auth/otp", { action: "request", channel: "email", destination: email }); assert.equal(req.status, 200, JSON.stringify(req.body));
    const ver = await api("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: req.body["challenge_id"], code: req.body["fake_code"] }); assert.equal(ver.status, 200, JSON.stringify(ver.body));
    await settle(); return { token: ver.body["token"] as string, party_id: (ver.body["party"] as Json)["party_id"] as string, session_id: (ver.body["session"] as Json)["session_id"] as string };
  };
  const auth = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
  const link = (token: string, facts: Json): Promise<Reply> => api("POST", "/v1/borrower/commands/party.linkLoan", facts, auth(token));
  const partyOf = async (borrowerId: string): Promise<string | null> => (await db.query<{ party_id: string | null }>(`SELECT party_id FROM borrowers WHERE id = $1`, [borrowerId]))[0]!.party_id;
  const levelOf = async (sessionId: string): Promise<string> => (await db.query<{ level: string }>(`SELECT level FROM sessions WHERE session_id = $1`, [sessionId]))[0]!.level;
  const a = await seedLoan(1, "85004"); const b = await seedLoan(2, "85012");
  // a signed-in party with no application or loan yet runs the subject-free command (no SUBJECT_REQUIRED): the exact match links and the session rises to L2
  const p1 = await signIn(`link-a-${R}@example.test`);
  const before = await api("GET", "/v1/borrower/me", undefined, auth(p1.token)); assert.equal(before.body["level"], "L1"); assert.deepEqual(before.body["subjects"], []);
  const ok = await link(p1.token, { loan_last4: a.last4, ssn_last4: "4321", date_of_birth: "1979-03-09" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body["command"], "party.linkLoan");
  const result = ok.body["result"] as Json; assert.equal(result["level"], "L2"); assert.equal(result["matched_by"], "loan_last4"); assert.deepEqual(result["loans"], [a.loan_id]);
  assert.ok((ok.body["events"] as string[]).includes("party.loan.linked"), JSON.stringify(ok.body["events"]));
  assert.equal(await partyOf(a.borrower_id), p1.party_id); assert.equal(await levelOf(p1.session_id), "L2");
  const after = await api("GET", "/v1/borrower/me", undefined, auth(p1.token)); assert.equal(after.body["level"], "L2"); assert.equal(((after.body["subjects"] as Json[])[0] as Json)["loan_id"], a.loan_id);
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM loan_events WHERE loan_id = $1 AND type = 'party.loan.linked' AND payload->>'party_id' = $2`, [a.loan_id, p1.party_id]))[0]!.n, "1");
  // any single mismatch — SSN last four, date of birth, loan number, ZIP — refuses with one code, never the field, and writes nothing
  const p2 = await signIn(`link-b-${R}@example.test`);
  for (const bad of [{ loan_last4: b.last4, ssn_last4: "9999", date_of_birth: "1979-03-09" }, { loan_last4: b.last4, ssn_last4: "4321", date_of_birth: "1979-03-10" }, { loan_last4: "0000", ssn_last4: "4321", date_of_birth: "1979-03-09" }, { property_zip: "85099", ssn_last4: "4321", date_of_birth: "1979-03-09" }]) {
    const r = await link(p2.token, bad);
    assert.equal(r.status, 409, `${JSON.stringify(bad)} → ${JSON.stringify(r.body)}`); assert.equal(r.body["code"], "LINK_LOAN_MISMATCH"); assert.equal(r.body["copy_key"], "auth.link_loan");
    assert.deepEqual(Object.keys(r.body).sort(), ["code", "copy_key"], "one code, never which field");
  }
  assert.equal(await partyOf(b.borrower_id), null); assert.equal(await levelOf(p2.session_id), "L1");
  // the alternate key: the property ZIP
  const zip = await link(p2.token, { property_zip: "85012", ssn_last4: "4321", date_of_birth: "1979-03-09" });
  assert.equal(zip.status, 200, JSON.stringify(zip.body)); assert.equal((zip.body["result"] as Json)["matched_by"], "property_zip"); assert.deepEqual((zip.body["result"] as Json)["loans"], [b.loan_id]);
  assert.equal(await partyOf(b.borrower_id), p2.party_id); assert.equal(await levelOf(p2.session_id), "L2");
  // a borrower another party already holds never re-links
  const p3 = await signIn(`link-c-${R}@example.test`);
  const taken = await link(p3.token, { loan_last4: a.last4, ssn_last4: "4321", date_of_birth: "1979-03-09" }); assert.equal(taken.status, 409); assert.equal(taken.body["code"], "LINK_LOAN_MISMATCH");
  assert.equal(await partyOf(a.borrower_id), p1.party_id); assert.equal(await levelOf(p3.session_id), "L1");
});
