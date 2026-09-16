// 34.2 The account directory — module-level tests over src/runtime/directory/* and the section34-2 tools on the bus
// (spec/sections/34-operator-portal/34-2-*.md; the T-ids themselves live in src/domain/operator-portal/34-2.spec.test.ts over the
// mounted routes). Fixture: the 33.1 fixture book imported through importPartnerBook(demoBook()) with a homegrown party linked at
// import (loan 7's e-mail, 33.1-T5), a second homegrown party whose rows carry every secret shape the contract test hunts for (a
// full SSN typed into the thread, a password hash, a session token hash, a turn's context hash), a staff analyst and a staff
// compliance user with portal sessions. Own database `<base>_directory`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, toJson, type Db } from "../../infra/db/client.ts";
import { testDatabase } from "../../infra/db/test-db.ts";
import { PgBorrowerUiRepository } from "../../infra/db/borrower-ui.ts";
import { PgBorrowerSessionRepository } from "../../infra/db/borrower-sessions.ts";
import { loadOverriddenRegistry } from "../../domain/timer-overrides.ts";
import { FixedClock } from "../../kernel/events/index.ts";
import { CommandRefused } from "../../app/commands.ts";
import { Runtime } from "../app.ts";
import { createLogger } from "../log.ts";
import { copyText } from "../borrower/channels.ts";
import { importPartnerBook } from "../partner-book.ts";
import { DEMO_AS_OF, DEMO_PARTNER, demoBook, type DemoLoan } from "../../domain/partner-book/fixtures/partner-book-demo.ts";
import { TOOLS_34_2 } from "../../app/tools/section34-2.ts";
import { classifyQuery, directorySearch, queryHash, DirectorySearchRefused, SEARCH_MAX_RESULTS } from "./search.ts";
import { directoryAccount } from "./account.ts";
import { directoryActivity, renderBody, ACTIVITY_KINDS } from "./activity.ts";
import { directoryUnmask, activeUnmaskFields, DirectoryRefused, UNMASK_MINUTES, DIRECTORY_RULE_SET_VERSION, DIRECTORY_MODEL_VERSION, DIRECTORY_PROMPT_VERSION } from "./unmask.ts";
import { directoryExport } from "./export.ts";
import { EVIDENCE_SECTIONS, verifyEvidencePack } from "../controls/evidence.ts";
import { maskEmail, maskPhone, maskLevelFor, redactSsn, stripSecrets } from "./mask.ts";
import { directoryRoutes, directoryLoggedRoute, matchDirectoryRoute, type DirectoryRoute, type DirectoryStaff } from "./routes.ts";

const { url: DB_URL, skip } = await testDatabase(import.meta.url);
type Json = Record<string, unknown>;
const NOW = "2026-09-15T13:00:00.000Z";
const clock = new FixedClock(NOW);
const sha256 = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");

let db: Db; let runtime: Runtime;
let mariaId = ""; let danielId = ""; let priyaId = ""; let loan1Id = ""; let partnerPartyId = "";
let analyst = { staff_user_id: "", session_id: "", role: "ops_analyst", roles: ["ops_analyst"] } as DirectoryStaff & { session_id: string };
let compliance = { staff_user_id: "", session_id: "", role: "compliance", roles: ["compliance"] } as DirectoryStaff & { session_id: string };
let officer = { staff_user_id: "", session_id: "", role: "officer", roles: ["officer"] } as DirectoryStaff & { session_id: string };
let priyaMessageId = ""; let priyaCardId = ""; let mariaCardId = ""; let mariaTurnId = ""; let analystLookId = "";
const secrets: string[] = [];   // every hash / token the fixture rows carry — none may appear in any response (T6's contract)
const book = demoBook();
const loanN = (n: number): DemoLoan => book.loans.find((l) => l.n === n)!;
const ACTOR_IMPORT = { kind: "human" as const, id: "u-ops-analyst", role: "ops_analyst" };
const bytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "utf8"));
const actorOf = (s: DirectoryStaff) => ({ kind: "human" as const, id: s.staff_user_id, role: s.role });
/** A tool on the bus as the staff member (the routes do exactly this). */
const run = async (name: string, staff: DirectoryStaff, input: Json): Promise<unknown> => (await runtime.execute({ process: "34.2", name, loanId: "", actor: actorOf(staff), input: { ...input, staff_user_id: staff.staff_user_id, session_id: staff.session_id, roles: [...staff.roles] } })).output;
const refusedWith = async (p: Promise<unknown>, code: string): Promise<void> => { try { await p; } catch (e) { if (e instanceof CommandRefused || e instanceof DirectoryRefused || e instanceof DirectorySearchRefused) { assert.equal(e.code, code); return; } throw e; } assert.fail(`expected ${code}`); };

async function staffUser(name: string, roles: string[]): Promise<{ staff_user_id: string; session_id: string }> {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@supermortgage.example`;
  const id = (await db.query<{ id: string }>(`INSERT INTO staff_users (email_hash, email_encrypted, legal_name, roles, status, enrolled_at) VALUES ($1, $2, $3, $4::text[], 'active', $5) RETURNING id::text AS id`, [sha256(email), Buffer.from("FAKE-encrypted"), name, roles, NOW]))[0]!.id;
  const token = randomUUID(); secrets.push(sha256(token));
  const session_id = (await db.query<{ session_id: string }>(`INSERT INTO staff_sessions (staff_user_id, token_hash, factors, created_at, last_seen_at, expires_at) VALUES ($1, $2, $3::text[], $4, $4, $5) RETURNING session_id::text AS session_id`, [id, sha256(token), ["email_code", "password"], NOW, "2026-09-16T01:00:00.000Z"]))[0]!.session_id;
  return { staff_user_id: id, session_id };
}

test.before(async () => {
  if (skip) return;
  db = connect(DB_URL);
  const logger = createLogger("json", () => undefined);
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock, logger });
  // 33.1-T5's homegrown party: loan 7's e-mail and name, on the platform before the import (linked at import → one row, both doors)
  danielId = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, contact) VALUES ('borrower', $1, $2::jsonb) RETURNING id::text AS id`, [loanN(7).name, JSON.stringify({ email: loanN(7).email })]))[0]!.id;
  const danielHash = "scrypt$16384$8$1$c2FsdA$" + sha256("daniel-password"); secrets.push(danielHash);
  await db.query(`INSERT INTO party_credentials (party_id, email, password_hash, email_verified_at) VALUES ($1, $2, $3, $4)`, [danielId, loanN(7).email, danielHash, NOW]);
  // the fixture book
  clock.set("2026-09-02T12:00:00.000Z");
  const imp = await importPartnerBook(runtime, { partner: DEMO_PARTNER, as_of_date: DEMO_AS_OF, profile: "m3-v1", tape: { filename: "partner-book-demo.xlsx", content: book.tape }, supplement: { filename: "partner-book-demo-supplement.csv", content: bytes(book.supplement) } }, ACTOR_IMPORT);
  assert.equal(imp.status, "loaded"); partnerPartyId = imp.partner_party_id;
  const l1 = imp.loans.find((l) => l.servicer_loan_number === loanN(1).servicer_loan_number)!; loan1Id = l1.loan_id; mariaId = l1.party_id!;
  assert.ok(mariaId, "loan 1 has a party");
  // the supplement's identity (the fixture supplement carries no tin/dob columns; the import's supplement reader does — the borrowers row is where they land)
  await db.query(`UPDATE borrowers SET tin_last4 = '6789', date_of_birth = '1986-04-12' WHERE party_id = $1`, [mariaId]);
  // Maria signed in twice: a code to the e-mail, then the password (T2)
  const sessions = new PgBorrowerSessionRepository(db);
  const s1 = await sessions.createSession({ party_id: mariaId, level: "L1", auth_method: "otp_email", now: "2026-09-10T15:00:00.000Z", expires_at: "2026-09-10T15:30:00.000Z", last_l1_at: "2026-09-10T15:00:00.000Z" }); secrets.push(sha256(s1.token), s1.token);
  const s2 = await sessions.createSession({ party_id: mariaId, level: "L2", auth_method: "password", now: "2026-09-12T15:00:00.000Z", expires_at: "2026-09-19T15:00:00.000Z" }); secrets.push(sha256(s2.token), s2.token);
  // the activation event 15-partner-book logs on the first session of a monitored loan
  await runtime.uow.run({ loanId: loan1Id }, async (ctx) => { ctx.events.append({ type: "partner_book.account.activated", loanId: loan1Id, aggregate: { kind: "loan", id: loan1Id }, actor: { kind: "system", id: "borrower-app" }, payload: { party_id: mariaId, loan_id: loan1Id, session_id: s1.session.session_id, activated_at: "2026-09-10T15:00:00.000Z", origination: false } }); }, { clock: new FixedClock("2026-09-10T15:00:00.000Z") });
  // the thread: the disclosure line (a copy key with tokens, as the flow writes it), the assistant's first turn (already filled), a question with an SSN typed in, a card and its resolution
  const ui = new PgBorrowerUiRepository(db);
  const conv = await ui.conversationFor(mariaId);
  await ui.appendMessage({ conversation_id: conv.conversation_id, at: "2026-09-12T15:00:30.000Z", sender: "system", channel: "app", body_text: "{{copy:entry.disclosure.first}}", copy_tokens: { "partner.legal_name": DEMO_PARTNER.legal_name }, subject_loan_id: loan1Id });
  const reply = await ui.appendMessage({ conversation_id: conv.conversation_id, at: "2026-09-12T15:01:00.000Z", sender: "agent", sender_ref: "borrower-app", channel: "app", body_text: "Hi Maria, I'm Michelle, the automated assistant here. Your loan with Northlight Mortgage Servicing (FAKE partner) is on the record here.", copy_tokens: { source: "agent_turn" }, subject_loan_id: loan1Id });
  const contextHash = sha256("system prompt + situation"); secrets.push(contextHash);
  mariaTurnId = randomUUID();
  await db.query(`INSERT INTO agent_turns (turn_id, conversation_id, party_id, session_id, message_id, reply_message_id, channel, model_version, prompt_version, tier, context_hash, tool_calls, safe_classification, guard_result, latency_ms, tokens_in, tokens_out, created_at) VALUES ($1, $2, $3, $4, NULL, $5, 'app', 'claude-scripted', '32.16-v3', 'T2_borrower_facing', $6, $7::jsonb, 'safe', $8::jsonb, 420, 1200, 80, $9)`,
    [mariaTurnId, conv.conversation_id, mariaId, s2.session.session_id, reply, contextHash, JSON.stringify([{ name: "record.read", args_hash: sha256("args"), decision_id: null, is_error: false, refused: false }]), JSON.stringify({ ok: true, rejected_by: null, violation: null, regenerable: false, checks: ["provenance", "utterance"], attempt: 1 }), "2026-09-12T15:01:00.000Z"]);
  secrets.push(sha256("args"));
  await ui.appendMessage({ conversation_id: conv.conversation_id, at: "2026-09-12T15:02:00.000Z", sender: "borrower", channel: "app", body_text: "My SSN is 123-45-6789 — do you need anything else from me?", subject_loan_id: loan1Id });
  const card = await ui.createCard({ conversation_id: conv.conversation_id, party_id: mariaId, subject_loan_id: loan1Id, kind: "ConfirmCard", created_by: "agent:borrower-app", copy_key: "refi.value.confirm", props: { value_cents: "60500000" }, now: "2026-09-12T15:03:00.000Z" });
  mariaCardId = card.card_instance_id;
  await ui.transitionCard(mariaCardId, "resolved", `borrower:${mariaId}`, "2026-09-12T15:05:00.000Z", { confirmed: true });
  // the daily review (33.2) and the readiness row (33.3) of the morning, with the review's decision record
  const reviewDecision = randomUUID();
  await db.query(`INSERT INTO agent_decisions (id, agent, loan_id, subject_kind, subject_id, rule_code, action, rule_set_version, model_version, prompt_version, rationale, confidence, created_at) VALUES ($1, 'refi-analyst', $2, 'partner_book_review', $3, '33.2 rules 1–6', 'review.write', 'sm.refi_trigger.v1+partner_book.review.v1', 'deterministic', '33.2-v1', 'watching: the loan is current and eligible; rates are not below the note rate yet', 1, $4)`, [reviewDecision, loan1Id, "rev-1", "2026-09-15T11:00:00.000Z"]);
  await db.query(`INSERT INTO partner_book_reviews (id, loan_id, party_id, as_of_date, run_id, opportunity_id, verdict, reasons, facts, analyst, decision_id, created_at) VALUES ($1, $2, $3, $4, 'review-2026-09-15-P1', NULL, 'watching', '["rate_delta"]'::jsonb, '{"watch_rate_pct": "6.875"}'::jsonb, '{}'::jsonb, $5, $6)`, [randomUUID(), loan1Id, mariaId, "2026-09-15", reviewDecision, "2026-09-15T11:00:00.000Z"]);
  await db.query(`INSERT INTO readiness_checks (id, loan_id, party_id, application_id, as_of_date, items, ready, missing, created_at) VALUES ($1, $2, $3, NULL, $4, '[]'::jsonb, false, '["identity","ssn","income"]'::jsonb, $5)`, [randomUUID(), loan1Id, mariaId, "2026-09-15", "2026-09-15T11:15:00.000Z"]);
  // a second homegrown person with every secret shape on their rows — none of it may reach Maria's pack, none of it may reach any response
  priyaId = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, contact) VALUES ('borrower', 'Priya Natarajan', $1::jsonb) RETURNING id::text AS id`, [JSON.stringify({ email: "priya.natarajan@example.com", phone: "+14155550199" })]))[0]!.id;
  const priyaHash = "scrypt$16384$8$1$c2FsdA$" + sha256("priya-password"); secrets.push(priyaHash);
  await db.query(`INSERT INTO party_credentials (party_id, email, password_hash, email_verified_at) VALUES ($1, 'priya.natarajan@example.com', $2, $3)`, [priyaId, priyaHash, NOW]);
  const s3 = await sessions.createSession({ party_id: priyaId, level: "L1", auth_method: "password", now: "2026-09-11T10:00:00.000Z", expires_at: "2026-09-11T10:30:00.000Z" }); secrets.push(sha256(s3.token), s3.token);
  const pconv = await ui.conversationFor(priyaId);
  priyaMessageId = await ui.appendMessage({ conversation_id: pconv.conversation_id, at: "2026-09-11T10:01:00.000Z", sender: "borrower", channel: "app", body_text: "my social is 987-65-4321 and my number is +1 415 555 0199" });
  priyaCardId = (await ui.createCard({ conversation_id: pconv.conversation_id, party_id: priyaId, kind: "ConfirmCard", created_by: "agent:borrower-app", copy_key: "identity.ssn.title", props: { ssn: "987-65-4321" }, now: "2026-09-11T10:02:00.000Z" })).card_instance_id;
  // a loan on the book with no party yet (loaded before any supplement): listed under "no account yet"
  const propertyId = (await db.query<{ id: string }>(`INSERT INTO properties (address_line1, city, state, postal_code) VALUES ('9 Orphan Way', 'Mesa', 'AZ', '85201') RETURNING id::text AS id`))[0]!.id;
  await db.query(`INSERT INTO loans (id, servicer_loan_number, partner_party_id, property_id, status, instrument_date, original_upb_cents, original_term_months, first_payment_date, maturity_date) VALUES ($1, 'NL-999999', $2, $3, 'monitored', '2024-09-20', 45000000, 360, '2024-11-01', '2054-10-01')`, [randomUUID(), partnerPartyId, propertyId]);
  // more than 50 people whose name starts the same way: NARROW_QUERY
  for (let i = 0; i < SEARCH_MAX_RESULTS + 5; i++) await db.query(`INSERT INTO parties (party_type, legal_name, contact) VALUES ('borrower', $1, $2::jsonb)`, [`Zed Filler ${String(i).padStart(2, "0")}`, JSON.stringify({ email: `zed.filler.${i}@example.com` })]);
  // the staff: an analyst, a compliance user and an officer with portal sessions; the analyst's look at Maria's account already on 34.1's log
  analyst = { ...(await staffUser("Ana Lyst", ["ops_analyst"])), role: "ops_analyst", roles: ["ops_analyst"] };
  compliance = { ...(await staffUser("Cora Pliance", ["compliance"])), role: "compliance", roles: ["compliance"] };
  officer = { ...(await staffUser("Ollie Ficer", ["officer"])), role: "officer", roles: ["officer"] };
  analystLookId = (await db.query<{ id: string }>(`INSERT INTO staff_actions (staff_user_id, session_id, at, route, method, subject_kind, subject_id, command, result) VALUES ($1, $2, $3, $4, 'GET', 'party', $5, 'directory.account', 'ok') RETURNING id::text AS id`, [analyst.staff_user_id, analyst.session_id, "2026-09-15T12:30:00.000Z", `/ops/api/directory/accounts/${mariaId}`, mariaId]))[0]!.id;
  clock.set(NOW);
});
test.after(async () => { if (!skip) await db.end(); });

// ---------------------------------------------------------------- the contract (T6's shape): no response carries a full SSN, a credential hash, a session token, a vendor payload
const FULL_SSN = /\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/;
const FORBIDDEN_KEYS = new Set(["token_hash", "password_hash", "context_hash", "args_hash", "secret_hash", "tin_encrypted", "raw", "props", "evidence", "vendor_payload", "vendor_response", "email_encrypted", "public_key_jwk", "credential_id"]);
function assertNoSecrets(value: unknown, where: string, path = "$"): void {
  if (typeof value === "string") { assert.ok(!FULL_SSN.test(value), `${where} ${path} carries a full SSN: ${value}`); for (const s of secrets) assert.ok(!value.includes(s), `${where} ${path} carries a secret`); assert.ok(!value.startsWith("scrypt$"), `${where} ${path} carries a credential hash`); return; }
  if (Array.isArray(value)) { value.forEach((v, i) => assertNoSecrets(v, where, `${path}[${i}]`)); return; }
  if (value && typeof value === "object") for (const [k, v] of Object.entries(value as Json)) { assert.ok(!FORBIDDEN_KEYS.has(k), `${where} ${path}.${k} is a forbidden key`); assertNoSecrets(v, where, `${path}.${k}`); }
}

// ---------------------------------------------------------------- pure parts
test("mask: e-mail m…@domain, phone ···last4, SSN shapes redacted, secret keys stripped, an ops_analyst never unmasked", () => {
  assert.equal(maskEmail("maria.garcia@example.com"), "m…@example.com");
  assert.equal(maskPhone("+16025550101"), "···0101");
  assert.equal(redactSsn("My SSN is 123-45-6789 and 123456789 too"), "My SSN is •••-••-•••• and •••-••-•••• too");
  assert.deepEqual(maskLevelFor(["ops_analyst"], ["contact", "identity"]), { contact: false, identity: false });
  assert.deepEqual(maskLevelFor(["compliance"], ["contact"]), { contact: true, identity: false });
  assert.deepEqual(maskLevelFor(["officer"], ["identity"]), { contact: false, identity: true });
  assert.deepEqual(stripSecrets({ a: 1, token_hash: "x", nested: { password_hash: "y", ok: "123-45-6789" }, list: [{ context_hash: "z", keep: true }] }), { a: 1, nested: { ok: "•••-••-••••" }, list: [{ keep: true }] });
  // T2: the partner's facts as stored — a nine-digit cents figure ($1,000,000.00 and up), a servicer number or a sequence is a figure, never an SSN; a bare nine-digit run typed into free text still is
  assert.deepEqual(stripSecrets({ facts: { upb_cents: "120000000", escrow_balance_cents: "100000000", original_upb_cents: "125000000", pay_string: "000000000000" }, servicer_number: "300012345", sequence: "123456789", body_text: "my ssn is 123456789 ok", rationale: "typed 123-45-6789", summary: "987654321" }),
    { facts: { upb_cents: "120000000", escrow_balance_cents: "100000000", original_upb_cents: "125000000", pay_string: "000000000000" }, servicer_number: "300012345", sequence: "123456789", body_text: "my ssn is •••-••-•••• ok", rationale: "typed •••-••-••••", summary: "•••-••-••••" });
  assert.deepEqual(classifyQuery("0101"), { kind: "last4", value: "0101" });
  assert.deepEqual(classifyQuery("(602) 555-0101"), { kind: "phone", value: "+16025550101" });
  assert.deepEqual(classifyQuery("Maria.Garcia@Example.com"), { kind: "email", value: "maria.garcia@example.com" });
  assert.deepEqual(classifyQuery("Garcia"), { kind: "text", value: "garcia" });
  assert.equal(renderBody("{{copy:entry.disclosure.first}}", { "partner.legal_name": "Northlight" }), copyText("entry.disclosure.first", { "partner.legal_name": "Northlight" }));
  assert.equal(renderBody("Hi {{party.first_name}}, SSN 123-45-6789", { "party.first_name": "Maria" }), "Hi Maria, SSN •••-••-••••");
});

test("tools: the five 34.2 tools are defined for security-records; the reads log a look, the acts write their own decision", () => {
  assert.deepEqual(TOOLS_34_2.map((t) => t.name), ["directory.search", "directory.account", "directory.activity", "directory.unmask", "directory.export"]);
  for (const t of TOOLS_34_2) { assert.equal(t.process, "34.2"); assert.equal(t.agent, "security-records"); assert.ok((t.guardrails ?? []).some((g) => g.code === "READ_ONLY"), `${t.name} READ_ONLY`); assert.ok((t.guardrails ?? []).some((g) => g.code === "NO_FULL_SSN"), `${t.name} NO_FULL_SSN`); assert.ok((t.guardrails ?? []).some((g) => g.code === "NO_SECRETS"), `${t.name} NO_SECRETS`); assert.ok((t.guardrails ?? []).some((g) => g.code === "LOG_EVERY_LOOK"), `${t.name} LOG_EVERY_LOOK`); }
  for (const name of ["directory.search", "directory.account", "directory.activity"]) assert.ok(TOOLS_34_2.find((t) => t.name === name)!.guardrails!.some((g) => g.code === "ROLE_MASK"), `${name} ROLE_MASK`);
  for (const name of ["directory.unmask", "directory.export"]) { const t = TOOLS_34_2.find((x) => x.name === name)!; assert.equal(t.kind, "act"); assert.ok(t.guardrails!.some((g) => g.code === "REASON_REQUIRED")); assert.ok(t.guardrails!.some((g) => g.code === "ROLE_REQUIRED")); }
});

// ---------------------------------------------------------------- search (rule 4)
test("search: the last four of loan 1's number, 'Garcia', the first six characters of the e-mail and the phone's last four each list Maria Garcia once with masked contact; directory.searched carries a hash and no query text; two characters are refused; > 50 asks for a narrower query", { skip }, async () => {
  const queries = [loanN(1).servicer_loan_number.slice(-4), "Garcia", loanN(1).email!.slice(0, 6), loanN(1).phone!.slice(-4)];
  for (const q of queries) {
    const r = await run("directory.search", analyst, { q }) as { results: Json[]; count: number; query_hash: string; event_id: string };
    const maria = r.results.filter((x) => x["legal_name"] === loanN(1).name);
    assert.equal(maria.length, 1, `${q} lists Maria once`);
    assert.equal(maria[0]!["email"], maskEmail(loanN(1).email)); assert.equal(maria[0]!["phone"], maskPhone(loanN(1).phone));
    assert.equal(maria[0]!["origin"], "partner_book"); assert.equal(maria[0]!["partner_name"], DEMO_PARTNER.legal_name);
    assert.ok((maria[0]!["subjects"] as Json[]).some((s) => s["loan_id"] === loan1Id && s["loan_last4"] === `····${loanN(1).servicer_loan_number.slice(-4)}`));
    assert.equal(r.query_hash, queryHash(q));
    const ev = (await db.query<{ payload: Json; actor_id: string }>(`SELECT payload, actor_id FROM loan_events WHERE id = $1 AND type = 'directory.searched'`, [r.event_id]))[0]!;
    assert.equal(ev.payload["query_hash"], queryHash(q)); assert.equal(ev.payload["staff_user_id"], analyst.staff_user_id); assert.equal(ev.actor_id, analyst.staff_user_id);
    assert.ok(!JSON.stringify(ev.payload).includes(q), "no query text in the log"); assert.equal(ev.payload["results"], r.count);
    assertNoSecrets(r, `search ${q}`);
  }
  await refusedWith(run("directory.search", analyst, { q: "Ga" }), "QUERY_TOO_SHORT");
  await refusedWith(run("directory.search", analyst, { q: "zed" }), "NARROW_QUERY");
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM loan_events WHERE type = 'directory.searched' AND payload->>'query_hash' = $1`, [queryHash("Ga")]))[0]!.n, "0", "a refused query logs nothing");
});

test("search: a household sharing an e-mail lists both; a loan with no party lists under no_account_yet with the partner and the last four; a linked homegrown party is one row", { skip }, async () => {
  const twin = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, contact) VALUES ('borrower', 'Luis Garcia', $1::jsonb) RETURNING id::text AS id`, [JSON.stringify({ email: loanN(1).email })]))[0]!.id;
  const r = await directorySearch(db, { q: loanN(1).email!, roles: ["ops_analyst"] });
  assert.deepEqual(r.results.map((x) => x.party_id).sort(), [mariaId, twin].sort());
  const noAcct = await directorySearch(db, { q: "NL-9999", roles: ["ops_analyst"] });
  assert.equal(noAcct.results.length, 0); assert.equal(noAcct.no_account_yet.length, 1); assert.equal(noAcct.no_account_yet[0]!.loan_last4, "····9999"); assert.equal(noAcct.no_account_yet[0]!.partner_name, DEMO_PARTNER.legal_name);
  const daniel = await directorySearch(db, { q: loanN(7).email!, roles: ["ops_analyst"] });
  assert.equal(daniel.results.length, 1); assert.equal(daniel.results[0]!.party_id, danielId); assert.equal(daniel.results[0]!.origin, "partner_book");
  await db.query(`DELETE FROM parties WHERE id = $1`, [twin]);
});

// ---------------------------------------------------------------- the account page (rules 1–2)
test("search / account / activity / unmask / export: a video-door party that has not identified (`Borrower (video)`, contact {provisional: video}) is never listed and never searchable as a person — by name, id prefix or last four, its session open or closed — and every read of it answers NOT_FOUND; once `video.identify` has put an e-mail on the contact it is a row", { skip }, async () => {
  const ghost = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, contact) VALUES ('borrower', 'Borrower (video)', $1::jsonb) RETURNING id::text AS id`, [JSON.stringify({ provisional: "video" })]))[0]!.id;
  const sessions = new PgBorrowerSessionRepository(db);
  const open = await sessions.createSession({ party_id: ghost, level: "L1", auth_method: "video", now: NOW, expires_at: "2026-09-15T14:00:00.000Z" }); secrets.push(sha256(open.token), open.token);
  const listed = async (q: string): Promise<boolean> => { const r = await directorySearch(db, { q, roles: ["compliance"], staff_user_id: compliance.staff_user_id }); return r.results.some((x) => x.party_id === ghost); };
  const probes = ["Borrower", "Borrower (video)", ghost.slice(0, 8), ghost.slice(-4)];
  for (const closed of [false, true]) {
    if (closed) await db.query(`UPDATE sessions SET revoked_at = $2 WHERE party_id = $1`, [ghost, NOW]);
    for (const q of probes) assert.equal(await listed(q), false, `${q} lists the un-identified video party (session ${closed ? "closed" : "open"})`);
    assert.equal(await run("directory.account", compliance, { party_id: ghost }), null, `the account page (session ${closed ? "closed" : "open"})`);
    assert.equal(await run("directory.activity", compliance, { party_id: ghost }), null, `the stream (session ${closed ? "closed" : "open"})`);
    await refusedWith(run("directory.unmask", compliance, { party_id: ghost, fields: ["contact"], reason: "34.2 probe" }), "NOT_FOUND");
    await refusedWith(run("directory.export", compliance, { party_id: ghost, reason: "34.2 probe" }), "NOT_FOUND");
  }
  // identified (32.17 rule 12: the name and the e-mail arrive through video.identify): a person from that moment
  await db.query(`UPDATE parties SET legal_name = 'Vida Ghost', contact = $2::jsonb WHERE id = $1`, [ghost, JSON.stringify({ provisional: "video", email: "vida.ghost@example.com" })]);
  const r = await directorySearch(db, { q: "Vida Ghost", roles: ["ops_analyst"] });
  assert.deepEqual(r.results.filter((x) => x.party_id === ghost).map((x) => [x.legal_name, x.email, x.origin]), [["Vida Ghost", maskEmail("vida.ghost@example.com"), "video_door"]]);
  assert.ok(await listed(ghost.slice(0, 8)), "searchable by id once identified");
  const a = await run("directory.account", compliance, { party_id: ghost }) as Json; assert.equal(a["origin_kind"], "video_door"); assertNoSecrets(a, "the identified video party's account");
});

test("account: an ops_analyst sees origin partner book, both sessions with doors and levels and no token, the monitored loan with the partner's facts as of their date, the review verdict and the readiness summary, masked contact and no SSN or date of birth", { skip }, async () => {
  const a = await run("directory.account", analyst, { party_id: mariaId }) as Json;
  assert.equal(a["origin"], `partner book: ${DEMO_PARTNER.legal_name}`); assert.equal(a["origin_kind"], "partner_book"); assert.equal(a["status"], "active");
  const sessions = a["sessions"] as Json[]; assert.equal(sessions.length, 2);
  assert.deepEqual(sessions.map((s) => [s["auth_method"], s["level"]]), [["otp_email", "L1"], ["password", "L2"]]);
  assert.deepEqual(sessions.map((s) => s["door"]), ["one-time code (e-mail)", "password"]);
  for (const s of sessions) assert.ok(!("token" in s) && !("token_hash" in s) && !("ip" in s));
  const contact = a["contact"] as Json; assert.equal(contact["email"], "m…@example.com"); assert.equal(contact["phone"], "···0101"); assert.equal(contact["unmasked"], false);
  const identity = a["identity"] as Json; assert.equal(identity["ssn_last4"], null); assert.equal(identity["date_of_birth"], null); assert.equal(identity["on_file"], true); assert.equal(identity["unmasked"], false);
  const subjects = a["subjects"] as Json[]; const loan = subjects.find((s) => s["loan_id"] === loan1Id)!;
  assert.equal(loan["monitored"], true); assert.equal(loan["loan_last4"], `····${loanN(1).servicer_loan_number.slice(-4)}`);
  const partner = loan["partner"] as Json; assert.equal(partner["as_of_date"], DEMO_AS_OF); assert.equal(partner["partner_name"], DEMO_PARTNER.legal_name); assert.equal(partner["label"], "the partner's facts");
  const facts = partner["facts"] as Json; assert.equal(facts["upb_cents"], "44136613"); assert.equal(facts["note_rate_pct"], "7.250"); assert.equal(facts["next_due_date"], "2026-10-01"); assert.equal(facts["servicing_status"], "Active");
  const review = loan["review"] as Json; assert.equal(review["outcome"], "watching"); assert.equal(review["as_of_date"], "2026-09-15"); assert.ok(!("watch_rate_pct" in review));
  const readiness = loan["readiness"] as Json; assert.equal(readiness["ready"], false); assert.deepEqual(readiness["missing"], ["identity", "ssn", "income"]);
  assert.ok((a["invitations"] as Json[]).length >= 1, "the invitation rows (33.1)");
  const viewed = await db.query<{ payload: Json }>(`SELECT payload FROM loan_events WHERE type = 'directory.viewed' AND payload->>'party_id' = $1 AND payload->>'section' = 'account'`, [mariaId]);
  assert.ok(viewed.length >= 1); assert.equal(viewed.at(-1)!.payload["staff_user_id"], analyst.staff_user_id);
  assertNoSecrets(a, "account (ops_analyst)");
  // the homegrown party linked at import: one row, the origin line names both doors
  const d = await run("directory.account", analyst, { party_id: danielId }) as Json;
  assert.equal(d["origin_kind"], "partner_book"); assert.deepEqual(d["doors"], [`partner book: ${DEMO_PARTNER.legal_name}`, "front door"]); assert.deepEqual(d["credential_kinds"], ["password"]); assert.equal(d["status"], "invited");
  assertNoSecrets(d, "account (daniel)");
  // a servicer party is not in the directory
  assert.equal(await directoryAccount(runtime, partnerPartyId, { roles: ["compliance"] }), null);
});

test("unmask: compliance with a reason sees the full e-mail and phone and the SSN last four and date of birth for 15 minutes with a decision record and directory.unmasked{fields, reason}; after 15 minutes (or a sign-out) the fields are masked again; an ops_analyst gets ROLE_REQUIRED; no reason is REASON_REQUIRED", { skip }, async () => {
  clock.set(NOW);
  const masked = await run("directory.account", compliance, { party_id: mariaId }) as Json;
  assert.equal((masked["contact"] as Json)["email"], "m…@example.com"); assert.equal((masked["identity"] as Json)["ssn_last4"], null);
  const u = await run("directory.unmask", compliance, { party_id: mariaId, fields: ["contact", "identity"], reason: "case 4411: the homeowner asked what the partner has on file" }) as Json;
  assert.deepEqual(u["fields"], ["contact", "identity"]); assert.equal(u["granted_at"], NOW); assert.equal(u["expires_at"], new Date(Date.parse(NOW) + UNMASK_MINUTES * 60_000).toISOString());
  const row = (await db.query<Json>(`SELECT staff_user_id::text AS staff_user_id, session_id::text AS session_id, fields, reason, granted_at, expires_at FROM directory_unmasks WHERE id = $1`, [u["unmask_id"] as string]))[0]!;
  assert.equal(row["staff_user_id"], compliance.staff_user_id); assert.equal(row["session_id"], compliance.session_id); assert.deepEqual(row["fields"], ["contact", "identity"]);
  const dec = (await db.query<Json>(`SELECT agent, action, subject_kind, subject_id, rule_set_version, model_version, prompt_version, confidence::text AS confidence, rationale, approved_by, approved_role FROM agent_decisions WHERE id = $1`, [u["decision_id"] as string]))[0]!;
  assert.equal(dec["agent"], "security-records"); assert.equal(dec["action"], "directory.unmask"); assert.equal(dec["subject_kind"], "party"); assert.equal(dec["subject_id"], mariaId);
  assert.equal(dec["rule_set_version"], DIRECTORY_RULE_SET_VERSION); assert.equal(dec["model_version"], DIRECTORY_MODEL_VERSION); assert.equal(dec["prompt_version"], DIRECTORY_PROMPT_VERSION); assert.equal(Number(dec["confidence"]), 1); assert.equal(dec["approved_by"], compliance.staff_user_id); assert.equal(dec["approved_role"], "compliance");
  const ev = (await db.query<{ payload: Json; actor_kind: string; actor_id: string; actor_role: string }>(`SELECT payload, actor_kind::text AS actor_kind, actor_id, actor_role FROM loan_events WHERE id = $1`, [u["event_id"] as string]))[0]!;
  assert.deepEqual(ev.payload["fields"], ["contact", "identity"]); assert.equal(ev.payload["reason"], "case 4411: the homeowner asked what the partner has on file"); assert.equal(ev.payload["staff_user_id"], compliance.staff_user_id); assert.equal(ev.actor_kind, "human"); assert.equal(ev.actor_role, "compliance");
  assert.ok(!JSON.stringify(ev.payload).includes("@"), "no destination on the event");
  // the page asks activeUnmaskFields on every request (the routes do): open now
  const open = await activeUnmaskFields(db, { staff_user_id: compliance.staff_user_id, session_id: compliance.session_id, party_id: mariaId, now: runtime.clock.now() });
  assert.deepEqual(open.sort(), ["contact", "identity"]);
  const shown = await run("directory.account", compliance, { party_id: mariaId, unmask: open }) as Json;
  assert.equal((shown["contact"] as Json)["email"], loanN(1).email); assert.equal((shown["contact"] as Json)["phone"], loanN(1).phone); assert.equal((shown["contact"] as Json)["unmasked"], true);
  assert.equal((shown["identity"] as Json)["ssn_last4"], "6789"); assert.equal((shown["identity"] as Json)["date_of_birth"], "1986-04-12"); assert.equal((shown["identity"] as Json)["source"], "partner supplement");
  assertNoSecrets(shown, "account (compliance, unmasked)");
  // an analyst's session does not inherit compliance's unmask; an analyst asking for the unmasked view is refused by ROLE_MASK, and cannot unmask at all (ROLE_REQUIRED)
  assert.deepEqual(await activeUnmaskFields(db, { staff_user_id: analyst.staff_user_id, session_id: analyst.session_id, party_id: mariaId, now: runtime.clock.now() }), []);
  await refusedWith(run("directory.account", analyst, { party_id: mariaId, unmask: ["contact"] }), "ROLE_MASK");
  await refusedWith(run("directory.unmask", analyst, { party_id: mariaId, fields: ["contact"], reason: "curious" }), "ROLE_REQUIRED");
  await refusedWith(run("directory.unmask", compliance, { party_id: mariaId, fields: ["contact"], reason: "  " }), "REASON_REQUIRED");
  await refusedWith(run("directory.unmask", compliance, { party_id: mariaId, fields: ["contact"], reason: "x", changes: { legal_name: "Someone Else" } }), "READ_ONLY");
  await refusedWith(run("directory.account", analyst, { party_id: mariaId, include_ssn: true }), "NO_FULL_SSN");
  await refusedWith(run("directory.account", analyst, { party_id: mariaId, include_tokens: true }), "NO_SECRETS");
  await refusedWith(run("directory.account", analyst, { party_id: mariaId, no_log: true }), "LOG_EVERY_LOOK");
  // the officer may unmask too (Open question 1); the log tells them apart
  const o = await run("directory.unmask", officer, { party_id: mariaId, fields: ["identity"], reason: "waiver review" }) as Json;
  assert.equal((await db.query<{ approved_role: string }>(`SELECT approved_role FROM agent_decisions WHERE id = $1`, [o["decision_id"] as string]))[0]!.approved_role, "officer");
  assert.deepEqual(await activeUnmaskFields(db, { staff_user_id: officer.staff_user_id, session_id: officer.session_id, party_id: mariaId, now: runtime.clock.now() }), ["identity"]);
  // 15 minutes on: masked again on the next request
  clock.set(new Date(Date.parse(NOW) + UNMASK_MINUTES * 60_000 + 1000).toISOString());
  assert.deepEqual(await activeUnmaskFields(db, { staff_user_id: compliance.staff_user_id, session_id: compliance.session_id, party_id: mariaId, now: runtime.clock.now() }), []);
  const again = await directoryAccount(runtime, mariaId, { roles: ["compliance"], unmask: await activeUnmaskFields(db, { staff_user_id: compliance.staff_user_id, session_id: compliance.session_id, party_id: mariaId, now: runtime.clock.now() }) });
  assert.equal(again!.contact.email, "m…@example.com"); assert.equal(again!.identity.ssn_last4, null);
  // a sign-out ends an unmask early
  const u2 = await directoryUnmask(runtime, { staff_user_id: compliance.staff_user_id, session_id: compliance.session_id, party_id: mariaId, fields: ["contact"], reason: "case 4411 continued", roles: ["compliance"] });
  assert.deepEqual(await activeUnmaskFields(db, { staff_user_id: compliance.staff_user_id, session_id: compliance.session_id, party_id: mariaId, now: runtime.clock.now() }), ["contact"]);
  await db.query(`UPDATE staff_sessions SET revoked_at = $2 WHERE session_id = $1`, [compliance.session_id, runtime.clock.now()]);
  assert.deepEqual(await activeUnmaskFields(db, { staff_user_id: compliance.staff_user_id, session_id: compliance.session_id, party_id: mariaId, now: runtime.clock.now() }), []);
  await db.query(`UPDATE staff_sessions SET revoked_at = NULL WHERE session_id = $1`, [compliance.session_id]);
  assert.equal(u2.unmasked_today, 1, "one person unmasked today by compliance");
  clock.set(NOW);
});

test("unmask: more than 20 people in a day by one staff member opens one compliance escalation", { skip }, async () => {
  const ids = (await db.query<{ id: string }>(`SELECT id::text AS id FROM parties WHERE party_type = 'borrower' AND legal_name LIKE 'Zed Filler %' ORDER BY legal_name LIMIT 21`)).map((r) => r.id);
  const results: Awaited<ReturnType<typeof directoryUnmask>>[] = [];
  for (const id of ids) results.push(await directoryUnmask(runtime, { staff_user_id: officer.staff_user_id, session_id: officer.session_id, party_id: id, fields: ["contact"], reason: "sweep", roles: ["officer"] }));
  assert.equal(results.at(-1)!.unmasked_today, 22, "Maria and 21 fillers");
  const escalated = results.filter((r) => r.escalation_id);
  assert.equal(escalated.length, 1, "one escalation"); assert.equal(escalated[0]!.unmasked_today, 21, "the 21st person of the day escalates");
  const esc = (await db.query<{ owner_role: string; kind: string; payload: Json }>(`SELECT owner_role, kind, payload FROM escalations WHERE id = $1`, [escalated[0]!.escalation_id!]))[0]!;
  assert.equal(esc.owner_role, "compliance"); assert.equal(esc.payload["reason"], "directory.unmask.volume"); assert.equal(esc.payload["staff_user_id"], officer.staff_user_id);
  const more = await directoryUnmask(runtime, { staff_user_id: officer.staff_user_id, session_id: officer.session_id, party_id: ids[0]!, fields: ["identity"], reason: "sweep again", roles: ["officer"] });
  assert.equal(more.escalation_id, null, "one escalation per staff member per day");
});

// ---------------------------------------------------------------- the activity stream (rule 3)
test("activity: one time-ordered stream — the invitation notice, the activation event, the sessions, the turn (model, prompt, guard), the messages with tokens resolved and an SSN redacted, the card and its resolution, the review decision, the analyst's own look — each with kind and actor; kind=turn leaves the turns only; dates filter", { skip }, async () => {
  const a = await run("directory.activity", analyst, { party_id: mariaId }) as { rows: Json[]; count: number; kinds: string[] };
  const rows = a.rows;
  for (let i = 1; i < rows.length; i++) assert.ok(String(rows[i - 1]!["at"]) <= String(rows[i]!["at"]), "time order");
  const kinds = new Set(rows.map((r) => r["kind"] as string));
  for (const k of ACTIVITY_KINDS) assert.ok(kinds.has(k), `kind ${k} present`);
  const invitation = rows.find((r) => r["kind"] === "notice" && String(r["summary"]).includes("NTC_SM_PARTNER_BOOK_INVITATION"))!; assert.ok(invitation, "the invitation notice"); assert.ok(["system", "agent:portfolio"].includes(invitation["actor"] as string)); assert.equal(invitation["table"], "notices", "the notices row the import saved, not a synthetic line"); assert.equal(rows.filter((r) => r["kind"] === "notice" && String(r["summary"]).includes("NTC_SM_PARTNER_BOOK_INVITATION")).length, (await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM partner_book_invitations WHERE party_id = $1`, [mariaId]))[0]!.n === "1" ? 1 : rows.filter((r) => r["kind"] === "notice" && String(r["summary"]).includes("NTC_SM_PARTNER_BOOK_INVITATION")).length, "one line per invitation, never the row twice");
  const activated = rows.find((r) => r["kind"] === "event" && r["summary"] === "partner_book.account.activated")!; assert.ok(activated); assert.equal(activated["actor"], "system:borrower-app");
  assert.equal(rows.filter((r) => r["kind"] === "session").length, 2); assert.equal(rows.find((r) => r["kind"] === "session")!["actor"], "borrower"); assert.equal(rows.find((r) => r["kind"] === "session")!["summary"], "signed in · otp_email · L1");
  const turn = rows.find((r) => r["kind"] === "turn")!; assert.equal(turn["row_id"], mariaTurnId); assert.equal(turn["actor"], "agent:borrower-app"); assert.ok(String(turn["summary"]).includes("model claude-scripted") && String(turn["summary"]).includes("prompt 32.16-v3") && String(turn["summary"]).includes("guard passed") && String(turn["summary"]).includes("tools record.read"));
  const turnDetail = turn["detail"] as Json; assert.deepEqual((turnDetail["tools"] as Json[]).map((t) => t["name"]), ["record.read"]); assert.ok(!("args_hash" in (turnDetail["tools"] as Json[])[0]!)); assert.ok(!("context_hash" in turnDetail));
  const disclosure = rows.find((r) => r["kind"] === "message" && r["actor"] === "system")!; assert.equal(disclosure["summary"], copyText("entry.disclosure.first", { "partner.legal_name": DEMO_PARTNER.legal_name }).slice(0, 240)); assert.ok(!String(disclosure["summary"]).includes("{{"));
  const question = rows.find((r) => r["kind"] === "message" && r["actor"] === "borrower")!; assert.equal(question["summary"], "My SSN is •••-••-•••• — do you need anything else from me?"); assert.equal((question["detail"] as Json)["sender_label"], "Maria");
  const cardRows = rows.filter((r) => r["kind"] === "card"); assert.equal(cardRows.length, 2);
  assert.equal(cardRows[0]!["summary"], "ConfirmCard refi.value.confirm · pending"); assert.equal(cardRows[0]!["actor"], "agent:borrower-app"); assert.equal(cardRows[0]!["row_id"], mariaCardId);
  assert.equal(cardRows[1]!["summary"], "ConfirmCard refi.value.confirm · resolved"); assert.equal(cardRows[1]!["actor"], "borrower"); assert.equal(cardRows[1]!["table"], "card_instance_events");
  const decision = rows.find((r) => r["kind"] === "decision" && String(r["summary"]).startsWith("review.write"))!; assert.ok(decision, "the daily review decision"); assert.equal(decision["actor"], "agent:refi-analyst"); assert.ok(rows.some((r) => r["kind"] === "decision" && r["actor"] === "agent:portfolio"), "the import's own decisions (33.1) are in the stream too"); assert.ok(String(decision["summary"]).startsWith("review.write · 33.2 rules 1–6"));
  const look = rows.find((r) => r["kind"] === "staff_look" && r["row_id"] === analystLookId)!; assert.ok(look, "34.1's log row"); assert.equal(look["actor"], `staff:${analyst.staff_user_id}`); assert.ok(String(look["summary"]).includes("directory.account · ok"));
  assert.ok(rows.some((r) => r["kind"] === "staff_look" && r["table"] === "loan_events" && String(r["summary"]).startsWith("directory.viewed")), "the directory's own looks appear too");
  assertNoSecrets(a, "activity");
  const turns = await run("directory.activity", analyst, { party_id: mariaId, kind: "turn" }) as { rows: Json[]; kinds: string[] };
  assert.deepEqual(turns.kinds, ["turn"]); assert.ok(turns.rows.length >= 1); assert.ok(turns.rows.every((r) => r["kind"] === "turn"));
  const day = await directoryActivity(runtime, mariaId, { from: "2026-09-12", to: "2026-09-12" });
  assert.ok(day!.rows.length >= 5); assert.ok(day!.rows.every((r) => r.at.startsWith("2026-09-12")));
  assert.ok((await directoryActivity(runtime, mariaId, { from: "2026-09-13", to: "2026-09-13" }))!.rows.length === 0);
  assert.equal(await directoryActivity(runtime, partnerPartyId, {}), null);
});

// ---------------------------------------------------------------- the export (rule 5)
test("export: compliance produces a document on `documents` with a hash, a directory_exports row and directory.exported; the pack carries the person's rows only; an analyst gets ROLE_REQUIRED, an officer too; no reason is REASON_REQUIRED", { skip }, async () => {
  clock.set(NOW);
  // T5's shared subject: a joint application Maria and Priya are both on — Priya's consent event and her decision carry the SAME application id and are not Maria's rows; Maria's own consent on it is
  const jointAppId = randomUUID(); const mariaConsentEventId = randomUUID(); const priyaConsentEventId = randomUUID(); const mariaDecisionId = randomUUID(); const priyaDecisionId = randomUUID();
  await db.query(`INSERT INTO applications (id, partner_party_id, channel, transaction_type, occupancy) VALUES ($1, $2, 'refi_trigger', 'limited_cash_out', 'primary')`, [jointAppId, partnerPartyId]);
  await db.query(`INSERT INTO application_borrowers (application_id, borrower_role, legal_name, party_id) VALUES ($1, 'borrower', $2, $3), ($1, 'co_borrower', 'Priya Natarajan', $4)`, [jointAppId, loanN(1).name, mariaId, priyaId]);
  for (const [id, party, at] of [[mariaConsentEventId, mariaId, "2026-09-13T10:00:00.000Z"], [priyaConsentEventId, priyaId, "2026-09-13T10:05:00.000Z"]] as const)
    await db.query(`INSERT INTO loan_events (id, type, occurred_at, application_id, aggregate_kind, aggregate_id, actor_kind, actor_id, payload) VALUES ($1, 'consent.esign.granted', $2, $3::uuid, 'application', $3::text, 'system', 'borrower-app', $4::jsonb)`, [id, at, jointAppId, JSON.stringify({ party_id: party, application_id: jointAppId, kind: "esign" })]);
  for (const [id, party] of [[mariaDecisionId, mariaId], [priyaDecisionId, priyaId]] as const)
    await db.query(`INSERT INTO agent_decisions (id, agent, application_id, subject_kind, subject_id, rule_code, action, rule_set_version, model_version, prompt_version, rationale, confidence, created_at) VALUES ($1, 'borrower-app', $2, 'party', $3, '32.2 rule 1', 'consent.record', 'consent.v1', 'deterministic', '32.2-v1', 'consent recorded', 1, '2026-09-13T10:06:00.000Z')`, [id, jointAppId, party]);
  const r = await run("directory.export", compliance, { party_id: mariaId, reason: "examiner request 2026-09-15" }) as { export_id: string; pack_id: string; document_id: string; sha256: string; byte_size: number; decision_id: string; event_id: string; manifest: Json; pack: { manifest: Json; sets: Record<string, Json[]>; events: Json[] } };
  // one layout for a person (rule 5: 34.4's evidence pack with a party subject): the document `{manifest, sets}` hashed, an evidence_packs row with the manifest, the events in the parts, verifiable
  const document = toJson({ manifest: r.pack.manifest, sets: r.pack.sets });
  assert.equal(sha256(Buffer.from(document, "utf8")), r.sha256); assert.equal(Buffer.byteLength(document), r.byte_size);
  assert.deepEqual(r.manifest["subject"], { kind: "party", id: mariaId, from_date: null, to_date: null }); assert.deepEqual((r.manifest["sections"] as Json[]).map((x) => x["name"]), [...EVIDENCE_SECTIONS]);
  const doc = (await db.query<Json>(`SELECT kind, sha256, byte_size::text AS byte_size, mime_type, retention_class::text AS retention_class, metadata FROM documents WHERE id = $1`, [r.document_id]))[0]!;
  assert.equal(doc["kind"], "evidence_pack"); assert.equal(doc["sha256"], r.sha256); assert.equal(doc["byte_size"], String(r.byte_size)); assert.equal(doc["mime_type"], "application/json");
  assert.equal((doc["metadata"] as Json)["pack_id"], r.pack_id); assert.equal((doc["metadata"] as Json)["document"], document, "the document text rides with its row");
  const packRow = (await db.query<Json>(`SELECT subject_kind, subject_id, document_id::text AS document_id, sha256, produced_by::text AS produced_by, manifest FROM evidence_packs WHERE id = $1`, [r.pack_id]))[0]!;
  assert.deepEqual([packRow["subject_kind"], packRow["subject_id"], packRow["document_id"], packRow["sha256"], packRow["produced_by"]], ["party", mariaId, r.document_id, r.sha256, compliance.staff_user_id]); assert.deepEqual(packRow["manifest"], r.manifest);
  const verified = await verifyEvidencePack(runtime, r.pack_id); assert.ok(verified); assert.equal(verified.verified, true, JSON.stringify(verified.sections.filter((x) => !x.ok)));
  const row = (await db.query<Json>(`SELECT staff_user_id::text AS staff_user_id, party_id::text AS party_id, document_id::text AS document_id, sha256 FROM directory_exports WHERE id = $1`, [r.export_id]))[0]!;
  assert.deepEqual(row, { staff_user_id: compliance.staff_user_id, party_id: mariaId, document_id: r.document_id, sha256: r.sha256 });
  const ev = (await db.query<{ payload: Json; type: string }>(`SELECT payload, type FROM loan_events WHERE id = $1`, [r.event_id]))[0]!;
  assert.equal(ev.type, "directory.exported"); assert.equal(ev.payload["export_id"], r.export_id); assert.equal(ev.payload["pack_id"], r.pack_id); assert.equal(ev.payload["staff_user_id"], compliance.staff_user_id); assert.equal(ev.payload["party_id"], mariaId);
  const dec = (await db.query<Json>(`SELECT action, rule_set_version, evidence_document_ids FROM agent_decisions WHERE id = $1`, [r.decision_id]))[0]!;
  assert.equal(dec["action"], "directory.export"); assert.deepEqual(dec["evidence_document_ids"], [r.document_id]);
  // the person's rows only
  const dir = (table: string): Json[] => (r.pack.sets["directory"] ?? []).filter((x) => x["table_name"] === table).map((x) => x["data"] as Json);
  const pb = (table: string): Json[] => (r.pack.sets["partner_book"] ?? []).filter((x) => x["table_name"] === table).map((x) => x["data"] as Json);
  assert.ok(dir("messages").length >= 3); assert.ok(!dir("messages").some((m) => m["message_id"] === priyaMessageId), "no other party's message");
  assert.ok(dir("card_instances").some((c) => c["card_instance_id"] === mariaCardId)); assert.ok(!dir("card_instances").some((c) => c["card_instance_id"] === priyaCardId), "no other party's card");
  const evs = r.pack.events;
  assert.ok(evs.every((e) => e["loan_id"] === loan1Id || e["loan_id"] === null), "events of the person's loan only");
  assert.ok(evs.some((e) => e["type"] === "partner_book.account.activated"));
  assert.ok(evs.some((e) => e["id"] === mariaConsentEventId), "Maria's own consent on the joint application");
  assert.ok(!evs.some((e) => e["id"] === priyaConsentEventId), "no co-borrower's event on the shared application (T5: no other party's event appears)");
  assert.ok(r.pack.sets["decisions"]!.some((d) => d["id"] === mariaDecisionId)); assert.ok(!r.pack.sets["decisions"]!.some((d) => d["id"] === priyaDecisionId), "no co-borrower's decision on the shared application");
  const stream = (await directoryActivity(runtime, mariaId, {}))!.rows;
  assert.ok(stream.some((x) => x.row_id === mariaConsentEventId) && !stream.some((x) => x.row_id === priyaConsentEventId || x.row_id === priyaDecisionId), "the activity stream keeps the same line");
  assert.ok(r.pack.sets["agent_turns"]!.some((t) => t["turn_id"] === mariaTurnId)); assert.ok(dir("sessions").length === 2); assert.ok(pb("partner_book_facts").length >= 1); assert.ok(pb("partner_book_reviews").length === 1); assert.ok(pb("readiness_checks").length === 1);
  assert.ok(r.pack.sets["staff_actions"]!.some((s) => s["id"] === analystLookId)); assert.ok(dir("directory_unmasks").length >= 2);
  const text = document + toJson(evs);
  assert.ok(!text.includes("987-65-4321") && !text.includes("Priya") && !text.includes("123-45-6789"), "nothing of the other person; the SSN Maria typed is redacted (NO_FULL_SSN)");
  assertNoSecrets(r, "export");
  await refusedWith(run("directory.export", analyst, { party_id: mariaId, reason: "x" }), "ROLE_REQUIRED");
  await refusedWith(run("directory.export", officer, { party_id: mariaId, reason: "x" }), "ROLE_REQUIRED");
  await refusedWith(run("directory.export", compliance, { party_id: mariaId }), "REASON_REQUIRED");
  await assert.rejects(directoryExport(runtime, { staff_user_id: compliance.staff_user_id, party_id: partnerPartyId, reason: "x", roles: ["compliance"] }), (e: unknown) => e instanceof DirectoryRefused && e.code === "NOT_FOUND");
});

// ---------------------------------------------------------------- the actor (34.1 rule 3): the bus actor, never the input
test("tools: staff_user_id is the bus actor's (an input naming another staff member is ignored), a session_id is honoured only as the actor's own open session (another's → SESSION_REQUIRED for unmask and export), and directory.account unmasks only what the caller's own session holds right now — never the input's list", { skip }, async () => {
  clock.set("2026-09-15T16:00:00.000Z");   // every earlier unmask (15 minutes) has expired
  const exec = (name: string, staff: DirectoryStaff, input: Json) => runtime.execute({ process: "34.2", name, loanId: "", actor: actorOf(staff), input });
  const u = (await exec("directory.unmask", compliance, { party_id: mariaId, fields: ["contact"], reason: "attribution probe", staff_user_id: analyst.staff_user_id, session_id: compliance.session_id })).output as Json;
  const row = (await db.query<Json>(`SELECT staff_user_id::text AS staff_user_id, session_id::text AS session_id FROM directory_unmasks WHERE id = $1`, [u["unmask_id"] as string]))[0]!;
  assert.deepEqual(row, { staff_user_id: compliance.staff_user_id, session_id: compliance.session_id }, "the row is the actor's, not the input's");
  assert.equal((await db.query<Json>(`SELECT approved_by FROM agent_decisions WHERE id = $1`, [u["decision_id"] as string]))[0]!["approved_by"], compliance.staff_user_id);
  assert.equal(((await db.query<{ payload: Json }>(`SELECT payload FROM loan_events WHERE id = $1`, [u["event_id"] as string]))[0]!.payload)["staff_user_id"], compliance.staff_user_id);
  assert.deepEqual(await activeUnmaskFields(db, { staff_user_id: analyst.staff_user_id, session_id: analyst.session_id, party_id: mariaId, now: runtime.clock.now() }), [], "nothing opened for the analyst");
  // another person's session, a revoked one, none: SESSION_REQUIRED (an unmask is granted to the caller's own session; an export is produced by it)
  await refusedWith(exec("directory.unmask", officer, { party_id: mariaId, fields: ["contact"], reason: "x", session_id: compliance.session_id }), "SESSION_REQUIRED");
  await refusedWith(exec("directory.unmask", officer, { party_id: mariaId, fields: ["contact"], reason: "x" }), "SESSION_REQUIRED");
  await refusedWith(exec("directory.export", compliance, { party_id: mariaId, reason: "x" }), "SESSION_REQUIRED");
  await refusedWith(exec("directory.export", compliance, { party_id: mariaId, reason: "x", session_id: officer.session_id }), "SESSION_REQUIRED");
  assert.equal((await db.query(`SELECT 1 FROM directory_unmasks WHERE staff_user_id = $1 AND granted_at >= $2`, [officer.staff_user_id, "2026-09-15T16:00:00.000Z"])).length, 0);
  // the account page: the officer holds nothing on Maria right now — an input asking for both fields shows the masked view; compliance holds `contact` only, whatever the input asks; no session → masked
  const officerView = (await exec("directory.account", officer, { party_id: mariaId, unmask: ["contact", "identity"], session_id: officer.session_id })).output as Json;
  assert.equal((officerView["contact"] as Json)["email"], "m…@example.com"); assert.equal((officerView["identity"] as Json)["ssn_last4"], null); assert.deepEqual(officerView["mask"], { contact: false, identity: false });
  const compView = (await exec("directory.account", compliance, { party_id: mariaId, unmask: ["contact", "identity"], session_id: compliance.session_id })).output as Json;
  assert.equal((compView["contact"] as Json)["email"], loanN(1).email); assert.equal((compView["identity"] as Json)["ssn_last4"], null); assert.deepEqual(compView["mask"], { contact: true, identity: false });
  const narrowed = (await exec("directory.account", compliance, { party_id: mariaId, unmask: ["identity"], session_id: compliance.session_id })).output as Json;
  assert.equal((narrowed["contact"] as Json)["email"], "m…@example.com", "an input list can only narrow the session's unmask");
  const noSession = (await exec("directory.account", compliance, { party_id: mariaId })).output as Json;
  assert.equal((noSession["contact"] as Json)["email"], "m…@example.com"); assert.deepEqual(noSession["mask"], { contact: false, identity: false });
  const otherSession = (await exec("directory.account", compliance, { party_id: mariaId, session_id: officer.session_id })).output as Json;
  assert.equal((otherSession["contact"] as Json)["email"], "m…@example.com", "another person's session is not the caller's");
  clock.set(NOW);
});

// ---------------------------------------------------------------- the contract over every projection, with the fixture account whose rows carry each secret shape
test("contract: no directory response carries a full SSN, a credential hash, a session token or a vendor payload — the account, the stream and the pack of the party whose rows carry each", { skip }, async () => {
  clock.set(NOW);
  for (const staff of [analyst, officer, compliance]) {
    assertNoSecrets(await run("directory.search", staff, { q: "Natarajan" }), `search as ${staff.role}`);
    assertNoSecrets(await run("directory.account", staff, { party_id: priyaId }), `account as ${staff.role}`);
    assertNoSecrets(await run("directory.activity", staff, { party_id: priyaId }), `activity as ${staff.role}`);
  }
  const u = await run("directory.unmask", compliance, { party_id: priyaId, fields: ["contact", "identity"], reason: "contract" }) as Json;
  assertNoSecrets(u, "unmask result");
  assertNoSecrets(await run("directory.account", compliance, { party_id: priyaId, unmask: ["contact", "identity"] }), "account unmasked");
  const x = await run("directory.export", compliance, { party_id: priyaId, reason: "contract" }) as Json;
  assertNoSecrets(x, "export of the fixture account");
  // the thread's SSN is on the row (the record is what the section wrote) and never in a projection
  assert.ok((await db.query<{ body_text: string }>(`SELECT body_text FROM messages WHERE message_id = $1`, [priyaMessageId]))[0]!.body_text.includes("987-65-4321"));
});

// ---------------------------------------------------------------- the route table (what the integration step mounts)
test("routes: the five routes with their roles run the tools on the bus as the session's actor and answer JSON; an analyst on unmask answers 403 ROLE_REQUIRED{compliance}; the outcome carries ids and codes only", { skip }, async () => {
  clock.set(NOW);
  const routes = directoryRoutes({ runtime });
  assert.deepEqual(routes.map((r) => [r.method, r.path, [...r.roles], r.command]), [
    ["GET", "/ops/api/directory/search", ["ops_analyst", "officer", "compliance"], "directory.search"],
    ["GET", "/ops/api/directory/accounts/{party_id}", ["ops_analyst", "officer", "compliance"], "directory.account"],
    ["GET", "/ops/api/directory/accounts/{party_id}/activity", ["ops_analyst", "officer", "compliance"], "directory.activity"],
    ["POST", "/ops/api/directory/accounts/{party_id}/unmask", ["compliance", "officer"], "directory.unmask"],
    ["POST", "/ops/api/directory/accounts/{party_id}/export", ["compliance"], "directory.export"]]);
  // 34.1 rule 4 / NO_PII_IN_LOG: the search's query never reaches staff_actions.route as typed — the console logs it through directoryLoggedRoute (the hash the directory.searched event carries)
  assert.equal(routes.find((r) => r.command === "directory.search")!.logged_query, false); assert.ok(routes.filter((r) => r.command !== "directory.search").every((r) => r.logged_query));
  for (const q of ["maria.garcia@example.com", "+1 602 555 0101", "Maria Garcia"]) {
    const logged = directoryLoggedRoute(new URL(`http://127.0.0.1/ops/api/directory/search?q=${encodeURIComponent(q)}&email=${encodeURIComponent(q)}`));
    assert.equal(logged, `/ops/api/directory/search?q=${queryHash(q)}`); assert.ok(!logged.includes("maria") && !logged.includes("Maria") && !logged.includes("602") && !logged.includes("%40") && !logged.includes("@"), logged);
  }
  assert.equal(directoryLoggedRoute(new URL(`http://127.0.0.1/ops/api/directory/accounts/${mariaId}/activity?kind=turn&from=2026-09-12`)), `/ops/api/directory/accounts/${mariaId}/activity?kind=turn&from=2026-09-12`);
  let staff: DirectoryStaff = analyst; const outcomes: Json[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1"); const route: DirectoryRoute | undefined = matchDirectoryRoute(routes, req.method ?? "GET", url.pathname);
    if (!route) { res.writeHead(404); res.end(); return; }
    outcomes.push(await route.handler(req, res, { url, staff }) as unknown as Json);
  });
  const port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> => { const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, body: (await r.json()) as Json }; };
  try {
    const s = await call("GET", `/ops/api/directory/search?q=${encodeURIComponent("Garcia")}`); assert.equal(s.status, 200); assert.ok((s.body["results"] as Json[]).some((x) => x["party_id"] === mariaId));
    assert.equal((await call("GET", "/ops/api/directory/search?q=Ga")).body["code"], "QUERY_TOO_SHORT");
    const a = await call("GET", `/ops/api/directory/accounts/${mariaId}`); assert.equal(a.status, 200); assert.equal((a.body["contact"] as Json)["email"], "m…@example.com");
    const act = await call("GET", `/ops/api/directory/accounts/${mariaId}/activity?kind=session`); assert.equal(act.status, 200); assert.deepEqual(act.body["kinds"], ["session"]);
    const denied = await call("POST", `/ops/api/directory/accounts/${mariaId}/unmask`, { fields: ["contact"], reason: "x" }); assert.equal(denied.status, 403); assert.equal(denied.body["code"], "ROLE_REQUIRED"); assert.equal(denied.body["role"], "compliance");
    assert.equal((await call("GET", `/ops/api/directory/accounts/${randomUUID()}`)).status, 404);
    staff = compliance;
    const u = await call("POST", `/ops/api/directory/accounts/${mariaId}/unmask`, { fields: ["contact"], reason: "route test" }); assert.equal(u.status, 200); assert.deepEqual(u.body["fields"], ["contact"]);
    const shown = await call("GET", `/ops/api/directory/accounts/${mariaId}`); assert.equal((shown.body["contact"] as Json)["email"], loanN(1).email, "the route resolves the session's active unmask");
    const e = await call("POST", `/ops/api/directory/accounts/${mariaId}/export`, { reason: "route test" }); assert.equal(e.status, 201); assert.ok(e.body["sha256"]); assert.ok(!("pack" in e.body));
    const bad = await call("POST", `/ops/api/directory/accounts/${mariaId}/export`, {}); assert.equal(bad.status, 400); assert.equal(bad.body["code"], "REASON_REQUIRED");
    for (const o of outcomes) { assert.ok(["ok", "refused"].includes(o["result"] as string)); assert.ok(!JSON.stringify(o).includes("@") && !JSON.stringify(o).includes("Garcia"), "ids and codes only"); }
    assert.deepEqual(outcomes.map((o) => [o["command"], o["result"], o["refusal_code"] ?? null]), [["directory.search", "ok", null], ["directory.search", "refused", "QUERY_TOO_SHORT"], ["directory.account", "ok", null], ["directory.activity", "ok", null], ["directory.unmask", "refused", "ROLE_REQUIRED"], ["directory.account", "refused", "NOT_FOUND"], ["directory.unmask", "ok", null], ["directory.account", "ok", null], ["directory.export", "ok", null], ["directory.export", "refused", "REASON_REQUIRED"]]);
  } finally { server.closeAllConnections?.(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

// 34.2 rule 1's "a party id prefix": a uuid whose first eight characters are all digits classifies as a phone-ish query (≥ 5 digits) — the phone
// branch must still find the party by id prefix (the CI shard that drew such an id failed "searchable by id once identified" on 82ddc32)
test("search: a party id whose leading eight characters are all digits is still found by that prefix (the phone branch carries the id-prefix predicate)", { skip }, async () => {
  const id = "12345678-4c1e-4b8a-9f3e-0d2a5b6c7e01";
  await db.query(`INSERT INTO parties (id, party_type, legal_name, contact) VALUES ($1::uuid, 'borrower', 'Digit Prefix', $2::jsonb)`, [id, JSON.stringify({ email: "digit.prefix@example.com" })]);
  try {
    assert.equal(classifyQuery("12345678").kind, "phone");
    const r = await directorySearch(db, { q: "12345678", roles: ["ops_analyst"] });
    assert.ok(r.results.some((x) => x.party_id === id), `found by id prefix: ${JSON.stringify(r.results.map((x) => x.party_id))}`);
    const none = await directorySearch(db, { q: "87654321", roles: ["ops_analyst"] });
    assert.ok(!none.results.some((x) => x.party_id === id));
  } finally { await db.query(`DELETE FROM parties WHERE id = $1::uuid`, [id]); }
});
