// 33.1 The partner book import: the tape and the supplement become monitored loans and real accounts
// spec/sections/33-partner-book/33-1-the-partner-book-import-monitored-loans-and-real-accounts.md
// One node:test per T-id, named exactly as the spec. The book is posted to POST /v1/partner-book/imports the way the operator posts
// it (JSON with content_base64, once as multipart), the homeowners sign in through the borrower API's own doors (the FAKE code echoed
// as fake_code), the scripted model of src/domain/borrower/eval/scripted-client.ts plays the first turn, a FixedClock is advanced
// past the reminder clock's due instant (end of day, America/New_York) for the sweep. Own database `<base>_33_1`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { connect, reachable, type Db } from "../../infra/db/client.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock } from "../../kernel/events/index.ts";
import { Runtime } from "../../runtime/app.ts";
import { createApiServer, listen } from "../../runtime/server.ts";
import { createLogger } from "../../runtime/log.ts";
import { createBorrowerRouter, type BorrowerRouter } from "../../runtime/borrower/routes.ts";
import { FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { scriptedClient, parseSituation, type Scene } from "../borrower/eval/scripted-client.ts";
import { writeXlsx } from "../../infra/files/xlsx.ts";
import { scheduledUpb } from "../leads-pricing/ops-20-1.ts";
import { M3_V1 } from "./profiles/m3-v1.ts";
import { DEMO_AS_OF, DEMO_PARTNER, demoBook, demoMin, type DemoLoan } from "./fixtures/partner-book-demo.ts";

const BASE_URL = process.env["TEST_DATABASE_URL"] ?? "postgresql://sm:sm@localhost/supermortgage_test";
const DB_URL = ((): string => { const u = new URL(BASE_URL); u.pathname = `${u.pathname}_33_1`; return u.toString(); })();
const ADMIN_URL = ((): string => { const u = new URL(DB_URL); u.pathname = "/postgres"; return u.toString(); })();
const up = await reachable(ADMIN_URL);   // the database itself is dropped and created by the setup
if (!up && process.env["REQUIRE_DB"]) throw new Error(`REQUIRE_DB set but ${ADMIN_URL} is not reachable`);
const skip = up ? false : `no Postgres at ${ADMIN_URL}`;
const TOKEN = "ops-" + randomUUID();
const R = randomUUID().slice(0, 8);
/** 2026-09-14 08:00 America/New_York — the section's clocks resolve end of day in ET (src/kernel/timers/engine.ts endOfDay). */
const NOW = "2026-09-14T12:00:00.000Z";
const clock = new FixedClock(NOW);
type Json = Record<string, unknown>;

// ---------------------------------------------------------------- the scripted model: the monitored first turn (rule 5) — the name and the partner as tokens, no digit, no rate, no offer
const MONITORED_FIRST_TURN: Scene = {
  when: /signed in for the first time to the account their servicer set up/,
  text: "Hi {{party.first_name}}, I'm Michelle, the automated assistant here. Your loan with {{partner_book.partner_name}} is on the record here. {{partner_book.partner_name}} keeps servicing it, and this is where we will talk with you about it.",
};
const RETURNING: Scene = { when: /the borrower is back/, text: "Welcome back, {{party.first_name}}. Your loan with {{partner_book.partner_name}} is on the record here and nothing is needed from you now." };
const scripted = scriptedClient([MONITORED_FIRST_TURN, RETURNING]);

let db: Db; let runtime: Runtime; let router: BorrowerRouter; let base = ""; let close: () => Promise<void> = async () => undefined;
let partnerPartyId = ""; let homegrownPartyId = "";
const logLines: string[] = [];
const book = demoBook();
const loanN = (n: number): DemoLoan => book.loans.find((l) => l.n === n)!;
const edelivery = (): FakeEdelivery => runtime.ports.edelivery as FakeEdelivery;

test.before(async () => {
  if (skip) return;
  const name = new URL(DB_URL).pathname.slice(1);
  const a = connect(ADMIN_URL); await a.query(`DROP DATABASE IF EXISTS ${name}`); await a.query(`CREATE DATABASE ${name}`); await a.end();
  execFileSync(fileURLToPath(new URL("../../../db/migrate.sh", import.meta.url)), { env: { ...process.env, DATABASE_URL: DB_URL }, stdio: "pipe" });
  db = connect(DB_URL);
  const logger = createLogger("json", (line) => { logLines.push(line); if (process.env["FLOW_DEBUG"] && /flow|error|unhandled|partner|"status":[45]/i.test(line)) process.stderr.write(line + "\n"); });
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock, logger });
  // the partner's parties{servicer} row (ensurePartner finds it by legal name) doubles as the borrower surface's configured partner
  partnerPartyId = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id, contact) VALUES ('servicer', $1, $2, $3, '{"phone": "+18005550199"}'::jsonb) RETURNING id`, [DEMO_PARTNER.legal_name, DEMO_PARTNER.servicer_number, DEMO_PARTNER.mers_org_id]))[0]!.id;
  // 33.1-T5: a homegrown party already on the platform with the fixture's loan 7 e-mail and the same name, before the import
  homegrownPartyId = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, contact) VALUES ('borrower', $1, $2::jsonb) RETURNING id`, [loanN(7).name, JSON.stringify({ email: loanN(7).email })]))[0]!.id;
  router = createBorrowerRouter({ runtime, logger, environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost", "http://127.0.0.1"], urlSecret: "test-secret", defaultPartnerId: partnerPartyId, llm: { client: scripted.client, model: "scripted" } });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger, console: false, borrowerRouter: router });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => { router.hub.close(); server.closeAllConnections?.(); server.close(() => db.end().then(() => resolve())); });
});
test.after(async () => { if (!skip) { await router.flows?.settle(); await close(); } });

// ---------------------------------------------------------------- helpers over the API
type Reply = { status: number; body: Json };
async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, ip = "10.33.0.1"): Promise<Reply> {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-forwarded-for": ip, ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text(); return { status: r.status, body: text ? (JSON.parse(text) as Json) : {} };
}
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
const settle = async () => { await router.flows!.settle(); await router.agent?.settle(); await router.flows!.settle(); };
const b64 = (bytes: Uint8Array | string): string => Buffer.from(bytes).toString("base64");
const usd = (c: bigint): string => { const neg = c < 0n; const abs = neg ? -c : c; const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ","); return `${neg ? "-" : ""}$${whole}.${(abs % 100n).toString().padStart(2, "0")}`; };
type LoanRow = { id: string; servicer_loan_number: string; status: string; fnma_loan_number: string | null; min: string | null; original_upb_cents: string; property_id: string; partner_party_id: string };
const loansOf = async (partnerId: string): Promise<LoanRow[]> => db.query<LoanRow>(`SELECT id, servicer_loan_number, status, fnma_loan_number, min, original_upb_cents::text AS original_upb_cents, property_id, partner_party_id FROM loans WHERE partner_party_id = $1 ORDER BY servicer_loan_number`, [partnerId]);
const loanByNumber = async (n: number): Promise<LoanRow> => { const l = (await loansOf(partnerPartyId)).find((x) => x.servicer_loan_number === loanN(n).servicer_loan_number); assert.ok(l, `loan ${n} on the book`); return l; };
const partyOfLoan = async (loanId: string): Promise<{ id: string; legal_name: string; contact: Json; party_type: string }> => { const r = (await db.query<{ id: string; legal_name: string; contact: Json; party_type: string }>(`SELECT p.id, p.legal_name, p.contact, p.party_type FROM loan_borrowers lb JOIN borrowers b ON b.id = lb.borrower_id JOIN parties p ON p.id = b.party_id WHERE lb.loan_id = $1 ORDER BY lb.is_primary DESC LIMIT 1`, [loanId]))[0]; assert.ok(r, "the loan's party"); return r; };
const events = async (type: string, loanId?: string) => db.query<{ type: string; loan_id: string | null; payload: Json; sequence: string }>(`SELECT type, loan_id::text AS loan_id, payload, sequence::text AS sequence FROM loan_events WHERE type = $1 AND ($2::uuid IS NULL OR loan_id = $2::uuid) ORDER BY sequence`, [type, loanId ?? null]);
type TimerRow = { id: string; loan_id: string; status: string; anchor_date: string; due_date: string | null; due_at: string | null; satisfied_at: string | null; breached_at: string | null };
const reminderTimers = async (loanId?: string): Promise<TimerRow[]> => db.query<TimerRow>(`SELECT id, loan_id::text AS loan_id, status, anchor_date::text AS anchor_date, due_date::text AS due_date, due_at::text AS due_at, satisfied_at::text AS satisfied_at, breached_at::text AS breached_at FROM timers WHERE code = 'SM_PARTNER_BOOK_INVITATION_REMINDER_14' AND ($1::uuid IS NULL OR loan_id = $1::uuid) ORDER BY armed_at, id`, [loanId ?? null]);
const latestFacts = async (loanId: string): Promise<{ as_of_date: string; facts: Json; raw: Json; import_id: string }> => (await db.query<{ as_of_date: string; facts: Json; raw: Json; import_id: string }>(`SELECT as_of_date::text AS as_of_date, facts, raw, import_id::text AS import_id FROM partner_book_facts WHERE loan_id = $1 ORDER BY as_of_date DESC, created_at DESC LIMIT 1`, [loanId]))[0]!;

/** The fixture posted as the operator posts it: JSON with content_base64 (rule "Inputs and triggers"); once per file — every later test reads the same import. */
let firstImport: Json | undefined; let importLogLines: string[] = [];
async function imported(): Promise<Json> {
  if (firstImport) return firstImport;
  const from = logLines.length;
  const r = await api("POST", "/v1/partner-book/imports", { partner: DEMO_PARTNER, as_of_date: DEMO_AS_OF, profile: "m3-v1", tape: { filename: "partner-book-demo.xlsx", content_base64: b64(book.tape) }, supplement: { filename: "partner-book-demo-supplement.csv", content_base64: b64(book.supplement) } }, { ...bearer(TOKEN), "x-actor-id": "u-ops-analyst" });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 800));
  importLogLines = logLines.slice(from);
  firstImport = r.body; return r.body;
}
/** A tape with loan 1's interest-bearing UPB one payment lower (24 payments made), as of the next month — the re-upload of T3. */
function laterTape(): Uint8Array {
  const upbCol = M3_V1.columns.findIndex((c) => c.key === "upb_cents"); assert.ok(upbCol >= 0, "the profile's UPB column");
  const rows = book.tapeRows.map((r) => [...r]);
  const l1 = loanN(1);
  rows[1]![upbCol] = Number(scheduledUpb(l1.original_cents, l1.note_rate_pct, l1.term_months, l1.payments_made + 1)) / 100;
  return writeXlsx(rows, "M3");
}
/** A code sign-in on the e-mail on file (the FAKE code echoed as fake_code outside production). */
async function signInByCode(email: string, ip: string): Promise<{ token: string; party_id: string; session: Json; body: Json }> {
  const req = await api("POST", "/v1/borrower/auth/otp", { action: "request", channel: "email", destination: email }, {}, ip);
  assert.equal(req.status, 200, JSON.stringify(req.body)); assert.equal(req.body["delivery"], "FAKE"); assert.equal(typeof req.body["fake_code"], "string");
  const v = await api("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: req.body["challenge_id"], code: req.body["fake_code"] }, {}, ip);
  assert.equal(v.status, 200, JSON.stringify(v.body)); await settle();
  return { token: v.body["token"] as string, party_id: (v.body["party"] as Json)["party_id"] as string, session: v.body["session"] as Json, body: v.body };
}
const NO_FIGURE = (text: string): void => { assert.doesNotMatch(text, /\d/, `no digit: ${text}`); assert.doesNotMatch(text, /%|\brate\b|\boffer\b|\$/i, `no rate or offer: ${text}`); };

test("33.1-T1: Given the fixture tape (`.xlsx`, 118 columns, 12 rows) and its supplement posted to `POST /v1/partner-book/imports` under profile `m3-v1`, then the import is `loaded` with `rows_total = 12`, `rows_loaded = 12`, 12 `loans{status=monitored}` with `fnma_loan_number` null and `servicer_loan_number` the partner's, 12 `loan_terms{source=partner_tape}`, 12 `properties`, 12 `borrowers` each with `party_id`, 12 `partner_book_facts` rows whose `facts` carry every mapped column and whose `raw` carries the unmapped ones, and `partner_book.import.completed` on the log.", { skip }, async () => {
  assert.equal(book.tapeRows[0]!.length, 118); assert.equal(book.tapeRows.length, 13); assert.equal(M3_V1.columns.length, 118);
  const r = await imported();
  assert.equal(r["status"], "loaded"); assert.equal(r["rows_total"], 12); assert.equal(r["rows_loaded"], 12); assert.equal(r["partner_party_id"], partnerPartyId);
  const loans = await loansOf(partnerPartyId);
  assert.equal(loans.length, 12);
  assert.deepEqual(loans.map((l) => l.servicer_loan_number), book.loans.map((l) => l.servicer_loan_number).sort());
  for (const l of loans) { assert.equal(l.status, "monitored"); assert.equal(l.fnma_loan_number, null); }
  const ids = loans.map((l) => l.id);
  const terms = await db.query<{ loan_id: string; source: string; effective_to: string | null }>(`SELECT loan_id::text AS loan_id, source, effective_to::text AS effective_to FROM loan_terms WHERE loan_id = ANY($1::uuid[])`, [ids]);
  assert.equal(terms.length, 12); assert.ok(terms.every((t) => t.source === "partner_tape" && t.effective_to === null));
  const properties = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM properties WHERE id IN (SELECT property_id FROM loans WHERE id = ANY($1::uuid[]))`, [ids]);
  assert.equal(properties[0]!.n, "12");
  const borrowers = await db.query<{ loan_id: string; party_id: string | null; legal_name: string }>(`SELECT lb.loan_id::text AS loan_id, b.party_id::text AS party_id, b.legal_name FROM loan_borrowers lb JOIN borrowers b ON b.id = lb.borrower_id WHERE lb.loan_id = ANY($1::uuid[])`, [ids]);
  assert.equal(borrowers.length, 12); assert.ok(borrowers.every((b) => b.party_id !== null), "every borrower carries party_id (rule 3)");
  const facts = await db.query<{ loan_id: string; facts: Json; raw: Json }>(`SELECT loan_id::text AS loan_id, facts, raw FROM partner_book_facts WHERE import_id = $1`, [r["import_id"]]);
  assert.equal(facts.length, 12);
  const mappedHeaders = new Set(M3_V1.columns.map((c) => c.header.trim().toLowerCase()));
  const unmapped = (book.tapeRows[0] as string[]).filter((h) => !mappedHeaders.has(String(h).trim().toLowerCase()));
  for (const f of facts) {
    for (const c of M3_V1.columns) assert.ok(c.key in f.facts, `facts carries ${c.key}`);
    assert.deepEqual(Object.keys(f.raw).sort(), unmapped.map((h) => String(h).trim()).sort(), "raw carries exactly the unmapped headers");
  }
  const completed = (await events("partner_book.import.completed")).filter((e) => e.payload["import_id"] === r["import_id"]);
  assert.equal(completed.length, 1); assert.equal(completed[0]!.loan_id, null); assert.equal(completed[0]!.payload["status"], "loaded"); assert.equal(completed[0]!.payload["rows_loaded"], 12); assert.equal(completed[0]!.payload["origination"], true);
  const decision = await db.query<{ rule_set_version: string; model_version: string; prompt_version: string; confidence: string }>(`SELECT rule_set_version, model_version, prompt_version, confidence::text AS confidence FROM agent_decisions WHERE agent = 'portfolio' AND action = 'book.import' AND subject_id = $1`, [r["import_id"]]);
  assert.equal(decision.length, 1); assert.deepEqual(decision[0], { rule_set_version: "partner_book.m3.v1", model_version: "deterministic", prompt_version: "33.1-v1", confidence: "1.0000" });
});

test("33.1-T2: Given loan 1 of the fixture after import, then `loan_terms.note_rate_bps = 72500`, `pi_cents = 306979`, `escrow_payment_cents = 61250`, `remaining_term_months = 337`, `maturity_date = 2054-10-01`, `loans.original_upb_cents = 45000000`, `loans.min` is the tape's 18-digit MIN, and the facts row reads UPB $441,366.13, P&I $3,069.79, T&I $612.50 and FMV $605,000.00 as decimal-string cents with their as-of dates.", { skip }, async () => {
  await imported();
  const l1 = loanN(1); const loan = await loanByNumber(1);
  const t = (await db.query<{ note_rate_bps: number; pi_cents: string; escrow_payment_cents: string; escrowed: boolean; remaining_term_months: number; maturity_date: string; amortization: string; effective_from: string; remittance_type: string }>(`SELECT note_rate_bps, pi_cents::text AS pi_cents, escrow_payment_cents::text AS escrow_payment_cents, escrowed, remaining_term_months, maturity_date::text AS maturity_date, amortization, effective_from::text AS effective_from, remittance_type FROM loan_terms WHERE loan_id = $1 AND effective_to IS NULL`, [loan.id]))[0]!;
  assert.equal(t.note_rate_bps, 72500); assert.equal(BigInt(t.pi_cents), 306979n); assert.equal(BigInt(t.escrow_payment_cents), 61250n); assert.equal(t.escrowed, true);
  assert.equal(t.remaining_term_months, 337); assert.equal(t.maturity_date, "2054-10-01"); assert.equal(t.amortization, "fixed"); assert.equal(t.effective_from, DEMO_AS_OF); assert.equal(t.remittance_type, "A/A");
  assert.equal(BigInt(loan.original_upb_cents), 45000000n);
  assert.equal(loan.min, l1.mers_min); assert.match(loan.min!, /^\d{18}$/);
  const f = await latestFacts(loan.id);
  assert.equal(f.as_of_date, "2026-09-01"); assert.equal(f.facts["as_of_date"], "2026-09-01");
  // worked example A: the four figures as decimal-string cents
  assert.equal(f.facts["upb_cents"], "44136613"); assert.equal(BigInt(f.facts["upb_cents"] as string), 44136613n); assert.equal(usd(44136613n), "$441,366.13");
  assert.equal(f.facts["pi_cents"], "306979"); assert.equal(BigInt(f.facts["pi_cents"] as string), 306979n); assert.equal(usd(306979n), "$3,069.79");
  assert.equal(f.facts["ti_cents"], "61250"); assert.equal(BigInt(f.facts["ti_cents"] as string), 61250n); assert.equal(usd(61250n), "$612.50");
  assert.equal(f.facts["fmv_cents"], "60500000"); assert.equal(BigInt(f.facts["fmv_cents"] as string), 60500000n); assert.equal(usd(60500000n), "$605,000.00"); assert.equal(f.facts["fmv_date"], "2026-08-31");
  assert.equal(f.facts["bpo_value_cents"], "61000000"); assert.equal(BigInt(f.facts["bpo_value_cents"] as string), 61000000n); assert.equal(usd(61000000n), "$610,000.00"); assert.equal(f.facts["bpo_date"], "2026-06-15");
  assert.equal(f.facts["note_rate_pct"], "7.250"); assert.equal(f.facts["fico_current"], 748); assert.equal(f.facts["next_due_date"], "2026-10-01"); assert.equal(f.facts["last_payment_date"], "2026-09-01"); assert.equal(f.facts["pay_string"], "000000000000");
  assert.equal(f.facts["borrower_name"], "Maria Garcia"); assert.equal(f.facts["property_address"], "1200 W Maple Ave"); assert.equal(f.facts["property_state"], "AZ"); assert.equal(f.facts["original_upb_cents"], "45000000"); assert.equal(f.facts["origination_date"], "2024-09-20"); assert.equal(f.facts["first_payment_date"], "2024-11-01");
});

test("33.1-T3: Given the same two files posted again, then the answer is `already_loaded` with the first import id and no row is written; given the tape with a later as-of date and loan 1's UPB one payment lower, then a second facts row exists, the first `loan_terms` row is closed and the new one open, and `partner_book.loan.loaded{change=updated}` is logged for loan 1 and `change=unchanged` for the others.", { skip }, async () => {
  const first = await imported();
  const counts = async () => (await db.query<{ imports: string; facts: string; terms: string; loans: string; parties: string; events: string }>(`SELECT (SELECT count(*) FROM partner_book_imports)::text AS imports, (SELECT count(*) FROM partner_book_facts)::text AS facts, (SELECT count(*) FROM loan_terms)::text AS terms, (SELECT count(*) FROM loans)::text AS loans, (SELECT count(*) FROM parties)::text AS parties, (SELECT count(*) FROM loan_events)::text AS events`))[0]!;
  const before = await counts();
  const again = await api("POST", "/v1/partner-book/imports", { partner: DEMO_PARTNER, as_of_date: DEMO_AS_OF, profile: "m3-v1", tape: { filename: "partner-book-demo.xlsx", content_base64: b64(book.tape) }, supplement: { filename: "partner-book-demo-supplement.csv", content_base64: b64(book.supplement) } }, bearer(TOKEN));
  assert.equal(again.status, 200); assert.equal(again.body["status"], "already_loaded"); assert.equal(again.body["import_id"], first["import_id"]);
  assert.deepEqual(await counts(), before, "nothing written by the repeated upload");
  // the later as-of: loan 1 one payment lower
  const later = await api("POST", "/v1/partner-book/imports", { partner: DEMO_PARTNER, as_of_date: "2026-10-01", profile: "m3-v1", tape: { filename: "partner-book-2026-10.xlsx", content_base64: b64(laterTape()) }, supplement: { filename: "partner-book-demo-supplement.csv", content_base64: b64(book.supplement) } }, bearer(TOKEN));
  assert.equal(later.status, 200, JSON.stringify(later.body).slice(0, 800)); assert.equal(later.body["status"], "loaded"); assert.notEqual(later.body["import_id"], first["import_id"]);
  assert.equal(later.body["loans_created"], 0); assert.equal(later.body["loans_updated"], 1); assert.equal(later.body["rows_loaded"], 12); assert.equal(later.body["invitations_sent"], 0, "an existing party with its contact is not invited again");
  const loan1 = await loanByNumber(1);
  const facts = await db.query<{ as_of_date: string; upb: string }>(`SELECT as_of_date::text AS as_of_date, facts->>'upb_cents' AS upb FROM partner_book_facts WHERE loan_id = $1 ORDER BY as_of_date`, [loan1.id]);
  assert.equal(facts.length, 2); assert.equal(facts[0]!.upb, "44136613"); assert.equal(facts[1]!.as_of_date, "2026-10-01");
  assert.equal(facts[1]!.upb, scheduledUpb(loanN(1).original_cents, "7.250", 360, 24).toString()); assert.ok(BigInt(facts[1]!.upb) < 44136613n);
  const terms = await db.query<{ effective_from: string; effective_to: string | null }>(`SELECT effective_from::text AS effective_from, effective_to::text AS effective_to FROM loan_terms WHERE loan_id = $1 ORDER BY effective_from`, [loan1.id]);
  assert.deepEqual(terms, [{ effective_from: "2026-09-01", effective_to: "2026-10-01" }, { effective_from: "2026-10-01", effective_to: null }]);
  const loaded = (await events("partner_book.loan.loaded")).filter((e) => e.payload["import_id"] === later.body["import_id"]);
  assert.equal(loaded.length, 12);
  assert.equal(loaded.find((e) => e.loan_id === loan1.id)!.payload["change"], "updated");
  assert.deepEqual(loaded.filter((e) => e.loan_id !== loan1.id).map((e) => e.payload["change"]), Array(11).fill("unchanged"));
  // rule 2: an unchanged row "logs change=unchanged and writes no terms" (the as-of snapshot of its facts is appended; the open terms row stands)
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM loan_terms WHERE loan_id <> $1 AND loan_id IN (SELECT id FROM loans WHERE partner_party_id = $2)`, [loan1.id, partnerPartyId]))[0]!.n, "11", "an unchanged row writes no terms");
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM loan_terms WHERE effective_to IS NOT NULL AND loan_id IN (SELECT id FROM loans WHERE partner_party_id = $1)`, [partnerPartyId]))[0]!.n, "1", "only loan 1's prior row is closed");
});

test("33.1-T4: Given the import, then every provisioned party is a `parties{borrower}` row whose `legal_name` is the tape's name and whose `contact` carries the supplement's normalized e-mail and E.164 phone, `partner_book.account.provisioned` is logged per loan with `channels`, the loan without a supplement row is provisioned with `gaps: contact` and no invitation, and no destination appears in any event payload, decision rationale or log line.", { skip }, async () => {
  const r = await imported();
  for (const l of book.loans) {
    const loan = await loanByNumber(l.n); const party = await partyOfLoan(loan.id);
    assert.equal(party.party_type, "borrower"); assert.equal(party.legal_name, l.name, `loan ${l.n} party name`);
    assert.equal(party.contact["email"] ?? null, l.email, `loan ${l.n} normalized e-mail`); assert.equal(party.contact["phone"] ?? null, l.phone, `loan ${l.n} E.164 phone`);
    const provisioned = await events("partner_book.account.provisioned", loan.id);
    assert.equal(provisioned.length, 1, `one provisioning event for loan ${l.n}`);
    const p = provisioned[0]!.payload;
    assert.equal(p["party_id"], party.id); assert.equal(p["origination"], true);
    assert.deepEqual(p["channels"], l.email ? ["email"] : [], `channels of loan ${l.n} (no SMS without consent evidence)`);
    if (l.n === 12) { assert.ok((p["gaps"] as string[]).includes("contact"), "loan 12: gaps: contact"); assert.equal((await events("partner_book.invitation.sent", loan.id)).length, 0); assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM partner_book_invitations WHERE loan_id = $1`, [loan.id]))[0]!.n, "0"); }
    else assert.ok(!(p["gaps"] as string[] | undefined)?.includes("contact"), `loan ${l.n} has contact`);
  }
  const report = r["report"] as Json; assert.equal((report["gaps"] as Json)["contact"], 1); assert.ok(((report["gaps_by_loan"] as Json)[loanN(12).servicer_loan_number] as string[]).includes("contact"));
  for (const l of book.loans) if (l.n !== 12) assert.ok(!((report["gaps_by_loan"] as Json)[l.servicer_loan_number] as string[]).includes("contact"), `loan ${l.n} has contact`);
  // never a destination: every e-mail and phone of the supplement (as written and normalized) is absent from the payloads, the rationales, the report and the import's log lines
  const destinations = [...new Set(book.loans.flatMap((l) => [l.email, l.phone, l.supplement_email, l.supplement_phone].filter((x): x is string => !!x)))];
  const absent = (text: string, where: string) => { for (const d of destinations) { assert.ok(!text.toLowerCase().includes(d.toLowerCase()), `${where} carries ${d}`); } };
  for (const e of await db.query<{ type: string; payload: Json }>(`SELECT type, payload FROM loan_events`)) absent(JSON.stringify(e.payload), `event ${e.type}`);
  for (const d of await db.query<{ action: string; rationale: string }>(`SELECT action, rationale FROM agent_decisions`)) absent(d.rationale, `decision ${d.action}`);
  absent(JSON.stringify(report), "the report");
  absent(JSON.stringify((await db.query<{ report: Json }>(`SELECT report FROM partner_book_imports`)).map((x) => x.report)), "the stored reports");
  assert.ok(importLogLines.length > 0, "the import logged"); for (const line of importLogLines) absent(line, "log line");
  const hashes = await db.query<{ destination_hash: string }>(`SELECT destination_hash FROM partner_book_invitations`); assert.ok(hashes.length > 0 && hashes.every((h) => /^[0-9a-f]{64}$/.test(h.destination_hash)), "sha256 hex only");
});

test("33.1-T5: Given a homegrown party already on the platform with the fixture's loan 7 e-mail and the same name, then the import links loan 7's borrower to that party (`linked_existing_party = true`, no new party); given the same e-mail on a party with a different name, then the loan gets its own party without that e-mail and the report carries a `contact_conflict` exception.", { skip }, async () => {
  const r = await imported(); const l7 = loanN(7);
  const loan7 = await loanByNumber(7); const party = await partyOfLoan(loan7.id);
  assert.equal(party.id, homegrownPartyId, "loan 7 is linked to the homegrown party"); assert.equal(party.legal_name, l7.name); assert.equal(party.contact["email"], l7.email); assert.equal(party.contact["phone"], l7.phone, "the supplement's phone joins the party");
  assert.equal((await events("partner_book.account.provisioned", loan7.id))[0]!.payload["linked_existing_party"], true);
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM parties WHERE party_type = 'borrower' AND lower(contact->>'email') = $1`, [l7.email]))[0]!.n, "1", "no new party carries the e-mail");
  assert.equal(r["parties_linked"], 1); assert.equal(r["parties_created"], 11);
  assert.equal(((r["report"] as Json)["loans"] as Json[]).find((x) => x["servicer_loan_number"] === l7.servicer_loan_number)!["party_id"], homegrownPartyId);
  // the same e-mail on a party with a different name: a second partner's tape names another borrower on it — posted as multipart
  // (a second partner's loan carries its own number: loans.servicer_loan_number is unique platform-wide, db/migrations/0001_baseline.sql)
  const nameCol = M3_V1.columns.findIndex((c) => c.key === "borrower_name"); const numberCol = M3_V1.columns.findIndex((c) => c.key === "servicer_loan_number");
  const minCol = M3_V1.columns.findIndex((c) => c.key === "mers_min");   // loans.min is unique too
  const row = [...book.tapeRows[7]!]; assert.equal(row[numberCol], l7.servicer_loan_number); row[nameCol] = "Denise Okoro"; row[numberCol] = "NL-200007"; row[minCol] = demoMin(207);
  const tape = writeXlsx([book.tapeRows[0]!, row], "M3");
  const supplement = `servicer_loan_number,borrower_email,borrower_phone,borrower_name\nNL-200007,${l7.email},${l7.supplement_phone},Denise Okoro\n`;
  const partnerB = { legal_name: `Second Servicer (FAKE partner) ${R}`, nmlsr_id: "7654321", servicer_number: "300054321" };
  const fd = new FormData();
  fd.set("partner", JSON.stringify(partnerB)); fd.set("as_of_date", DEMO_AS_OF); fd.set("profile", "m3-v1");
  fd.set("tape", new Blob([tape]), "second-partner.xlsx"); fd.set("supplement", new Blob([supplement]), "second-partner-supplement.csv");
  const res = await fetch(base + "/v1/partner-book/imports", { method: "POST", headers: { ...bearer(TOKEN), "x-forwarded-for": "10.33.0.1" }, body: fd });
  const body = JSON.parse(await res.text()) as Json;
  assert.equal(res.status, 200, JSON.stringify(body).slice(0, 800)); assert.equal(body["status"], "loaded"); assert.equal(body["rows_loaded"], 1); assert.equal(body["parties_created"], 1); assert.equal(body["parties_linked"], 0);
  const exceptions = (body["report"] as Json)["exceptions"] as Json[];
  assert.ok(exceptions.some((e) => e["code"] === "contact_conflict" && e["servicer_loan_number"] === "NL-200007" && e["column"] === "borrower_email"), JSON.stringify(exceptions));
  assert.equal(body["rows_exception"], 1);
  const loanB = (await loansOf(body["partner_party_id"] as string))[0]!; assert.equal(loanB.status, "monitored");
  const own = await partyOfLoan(loanB.id);
  assert.notEqual(own.id, homegrownPartyId); assert.equal(own.legal_name, "Denise Okoro"); assert.equal(own.contact["email"], undefined, "the conflicting e-mail is not on the loan's own party"); assert.equal(own.contact["phone"], l7.phone, "the phone is kept");
  assert.equal((await events("partner_book.account.provisioned", loanB.id))[0]!.payload["linked_existing_party"], false);
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM parties WHERE party_type = 'borrower' AND lower(contact->>'email') = $1`, [l7.email]))[0]!.n, "1", "the e-mail stays on the homegrown party only");
});

test("33.1-T6: Given the import, then `NTC_SM_PARTNER_BOOK_INVITATION` is sent by e-mail to every party with an e-mail (the FAKE delivery port holds one message per party naming the partner and the loan's last four and no rate, offer or figure), no SMS goes to any number without TCPA consent evidence, `partner_book.invitation.sent{kind=invitation}` is logged per message and `SM_PARTNER_BOOK_INVITATION_REMINDER_14` is armed with `due_at` 14 calendar days after `sent_at`.", { skip }, async () => {
  const r = await imported(); const importId = r["import_id"] as string;
  const invited = book.loans.filter((l) => l.email !== null); assert.equal(invited.length, 11); assert.equal(r["invitations_sent"], 11);
  const messages = [...edelivery().messages.values()].filter((m) => m.messageId.startsWith(`partner_book:${importId}:`));
  assert.equal(messages.length, 11, "one FAKE message per party with an e-mail"); assert.ok(messages.every((m) => m.message.channel === "email" && m.status === "sent"));
  assert.equal(messages.length, r["invitations_sent"], "invitations_sent counts what the port holds — a held invitation is never counted as sent");
  assert.equal(((r["report"] as Json)["gaps"] as Json)["invitation_held"], 0, "no invitation held by the checklist");
  assert.equal(new Set(messages.map((m) => m.message.to)).size, 11);
  const rows = await db.query<{ loan_id: string; party_id: string; channel: string; kind: string; notice_id: string; message_id: string; sent_at: string }>(`SELECT loan_id::text AS loan_id, party_id::text AS party_id, channel, kind, notice_id::text AS notice_id, message_id, sent_at::text AS sent_at FROM partner_book_invitations WHERE import_id = $1`, [importId]);
  assert.equal(rows.length, 11); assert.ok(rows.every((x) => x.channel === "email" && x.kind === "invitation"));
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM partner_book_invitations WHERE channel = 'sms'`))[0]!.n, "0", "no SMS without TCPA consent evidence");
  assert.ok(![...edelivery().messages.values()].some((m) => m.message.channel === "sms"), "no SMS on the port");
  for (const l of invited) {
    const loan = await loanByNumber(l.n); const party = await partyOfLoan(loan.id);
    const row = rows.find((x) => x.loan_id === loan.id); assert.ok(row, `an invitation row for loan ${l.n}`); assert.equal(row.party_id, party.id);
    const m = messages.find((x) => x.messageId === row.message_id); assert.ok(m, `the FAKE message ${row.message_id}`);
    assert.equal(m.messageId, `partner_book:${importId}:${party.id}:email`); assert.equal(m.message.to, l.email); assert.equal(m.message.noticeId, row.notice_id);
    assert.equal(m.message.subject, `${DEMO_PARTNER.legal_name}: your account for the loan ending ${l.servicer_loan_number.slice(-4)}`);
    assert.equal(m.message.consentId, "policy:electronic_ok_without_esign", "a relationship message: never a marketing consent");
    const notice = runtime.noticeMemory.get(row.notice_id); assert.ok(notice, "the rendered notice"); assert.equal(notice.templateCode, "NTC_SM_PARTNER_BOOK_INVITATION"); assert.equal(notice.status, "sent");
    const text = notice.rendered.text;
    assert.ok(text.includes(DEMO_PARTNER.legal_name) && text.includes(`ending ${l.servicer_loan_number.slice(-4)}`) && text.includes("we will send a code to this e-mail") && text.includes("/app"), text);
    const body = text.split("Sign-in address:")[0]!.replaceAll(`ending ${l.servicer_loan_number.slice(-4)}`, "ending");
    NO_FIGURE(body);
    assert.doesNotMatch(text, /Reply STOP/, "the e-mail variant carries no SMS line");
    const sent = await events("partner_book.invitation.sent", loan.id);
    assert.equal(sent.length, 1); assert.equal(sent[0]!.payload["kind"], "invitation"); assert.equal(sent[0]!.payload["channel"], "email"); assert.equal(sent[0]!.payload["notice_id"], row.notice_id); assert.equal(sent[0]!.payload["origination"], true); assert.equal(sent[0]!.payload["sent_at"], NOW);
    const timers = await reminderTimers(loan.id);
    assert.equal(timers.length, 1, `one reminder clock for loan ${l.n}`);
    const t = timers[0]!;
    assert.ok(t.status === "armed" || t.status === "satisfied", `armed by the invitation (${t.status})`);
    assert.equal(t.anchor_date, "2026-09-14"); assert.equal(t.due_date, "2026-09-28", "sent_at + 14 calendar days");
    const days = (Date.parse(t.due_at!) - Date.parse(String(sent[0]!.payload["sent_at"]))) / 86_400_000; assert.ok(days >= 14 && days < 15, `due_at ${t.due_at} is 14 calendar days after sent_at (end of day ET): ${days}`);
  }
  assert.equal((await reminderTimers((await loanByNumber(12)).id)).length, 0, "no clock without an invitation");
});

let maria: { token: string; party_id: string } | undefined;
test("33.1-T7: Given a homeowner from the fixture who requests a code to the e-mail on file and verifies it, then the session opens on the provisioned party at L1, `GET /v1/borrower/me` lists the monitored loan as the subject labelled with the partner's last four, no organic application and no organic lead exist for the party, `partner_book.account.activated` is logged once and the reminder clock is satisfied.", { skip }, async () => {
  await imported(); const l1 = loanN(1); const loan1 = await loanByNumber(1); const party = await partyOfLoan(loan1.id);
  const s = await signInByCode(l1.email!, "10.33.1.1"); maria = { token: s.token, party_id: s.party_id };
  assert.equal(s.party_id, party.id, "the session opens on the provisioned party"); assert.equal(s.session["level"], "L1"); assert.equal(s.session["auth_method"], "otp_email");
  const me = await api("GET", "/v1/borrower/me", undefined, bearer(s.token));
  assert.equal(me.status, 200, JSON.stringify(me.body)); assert.equal((me.body["party"] as Json)["party_id"], party.id); assert.equal((me.body["party"] as Json)["first_name"], "Maria"); assert.equal(me.body["level"], "L1");
  const subjects = me.body["subjects"] as Json[];
  assert.equal(subjects.length, 1); assert.equal(subjects[0]!["loan_id"], loan1.id); assert.equal(subjects[0]!["application_id"], null); assert.equal(subjects[0]!["stage"], "servicing");
  assert.ok(String(subjects[0]!["label"]).endsWith(l1.servicer_loan_number.slice(-4)), `labelled with the last four: ${subjects[0]!["label"]}`);
  assert.equal((me.body["partner"] as Json)["legal_name"], DEMO_PARTNER.legal_name);
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM application_borrowers WHERE party_id = $1`, [party.id]))[0]!.n, "0", "no organic application");
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM applications a WHERE a.partner_party_id = $1`, [partnerPartyId]))[0]!.n, "0");
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM entity_current WHERE kind = 'leads' AND data->>'party_id' = $1`, [party.id]))[0]!.n, "0", "no organic lead");
  const activated = await events("partner_book.account.activated", loan1.id);
  assert.equal(activated.length, 1); assert.equal(activated[0]!.payload["party_id"], party.id); assert.equal(activated[0]!.payload["session_id"], s.session["session_id"]); assert.equal(activated[0]!.payload["activated_at"], NOW); assert.equal(activated[0]!.payload["origination"], true);
  const timer = (await reminderTimers(loan1.id))[0]!;
  assert.equal(timer.status, "satisfied", "the reminder clock is satisfied by the activation"); assert.ok(timer.satisfied_at);
  // a second session on the same party logs nothing more (once)
  await signInByCode(l1.email!, "10.33.1.2");
  assert.equal((await events("partner_book.account.activated", loan1.id)).length, 1);
});

test("33.1-T8: Given that first session, then the thread's first assistant turn greets the homeowner by first name, names the partner as the servicer and the loan, and carries no digit, rate or offer; given the same homeowner creating a password through the account door with the e-mail on file, then the code verifies on the same party and a later password sign-in reaches the same loan.", { skip }, async () => {
  await imported(); const l1 = loanN(1); const loan1 = await loanByNumber(1);
  assert.ok(maria, "T7's session"); await settle();
  const thread = await api("GET", "/v1/borrower/thread?limit=500", undefined, bearer(maria.token));
  assert.equal(thread.status, 200, JSON.stringify(thread.body));
  const messages = thread.body["messages"] as Json[];
  const first = messages.find((m) => m.sender === "agent"); assert.ok(first, `an assistant turn on the thread: ${JSON.stringify(messages.map((m) => [m["sender"], m["body_text"]]))}`);
  const text = String(first["body_text"]);
  assert.ok(text.includes("Maria"), `greets by first name: ${text}`); assert.ok(text.includes(DEMO_PARTNER.legal_name), `names the partner as the servicer: ${text}`); assert.match(text, /loan/i);
  NO_FIGURE(text);
  assert.equal(first["subject"] && (first["subject"] as Json)["loan_id"], loan1.id, "the turn is on the monitored loan");
  // the model's situation carried partner_book{monitored} and the loan; the scripted turn matched the monitored first-turn scene
  const turn = scripted.turns.find((t) => MONITORED_FIRST_TURN.when.test(t.borrower)); assert.ok(turn, "the first-sign-in turn reached the model"); assert.equal(turn.scene, MONITORED_FIRST_TURN); assert.equal(turn.regenerated, false, "the guard accepted the greeting");
  const request = scripted.requests.find((q) => { const last = q.messages.at(-1); return typeof last?.content === "string" && MONITORED_FIRST_TURN.when.test(last.content); }); assert.ok(request);
  const situation = parseSituation(String(request.messages.at(-1)!.content));
  const record = situation.situation.record as Json; const pb = record["partner_book"] as Json;
  assert.equal(pb["monitored"], true); assert.equal((situation.situation.raw["tokens"] as Json | undefined)?.["partner_book.partner_name"] ?? DEMO_PARTNER.legal_name, DEMO_PARTNER.legal_name);
  assert.ok(situation.situation.tokens_available.includes("partner_book.partner_name") && situation.situation.tokens_available.includes("partner_book.loan_last4"), JSON.stringify(situation.situation.tokens_available));
  assert.equal((record["status"] as Json)["badge"], "Monitored");
  assert.match(situation.borrower, /do not ask the goal; no rate, no offer, no figure/);
  // the account door on the e-mail on file: a code proves possession, the password lands on the same party
  const password = `pw-partner-book-${R}`;
  const create = await api("POST", "/v1/borrower/auth/account", { action: "create", email: l1.email, password }, {}, "10.33.2.1");
  assert.equal(create.status, 200, JSON.stringify(create.body)); assert.equal(typeof create.body["challenge_id"], "string"); assert.equal(create.body["delivery"], "FAKE"); assert.equal(typeof create.body["fake_code"], "string");
  const verified = await api("POST", "/v1/borrower/auth/account", { action: "verify_email", challenge_id: create.body["challenge_id"], code: create.body["fake_code"] }, {}, "10.33.2.1");
  assert.equal(verified.status, 200, JSON.stringify(verified.body)); assert.equal((verified.body["party"] as Json)["party_id"], maria.party_id, "the code verifies on the same party"); assert.equal((verified.body["session"] as Json)["auth_method"], "password"); await settle();
  const signedIn = await api("POST", "/v1/borrower/auth/account", { action: "sign_in", email: l1.email, password }, {}, "10.33.2.2");
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body)); assert.equal((signedIn.body["party"] as Json)["party_id"], maria.party_id); await settle();
  const me = await api("GET", "/v1/borrower/me", undefined, bearer(signedIn.body["token"] as string));
  assert.equal(me.status, 200); const subjects = me.body["subjects"] as Json[]; assert.equal(subjects.length, 1); assert.equal(subjects[0]!["loan_id"], loan1.id, "the password sign-in reaches the same loan");
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM application_borrowers WHERE party_id = $1`, [maria.party_id]))[0]!.n, "0", "the account door opened no organic application for a monitored party (rule 5)");
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM parties WHERE party_type = 'borrower' AND lower(contact->>'email') = $1`, [l1.email]))[0]!.n, "1", "one party carries the e-mail");
  assert.equal((await events("partner_book.account.activated", loan1.id)).length, 1, "activated once for the party");
});

test("33.1-T9: Given the monitored loan on the record, then the badge is `Monitored`, `numbers` carries the facts' UPB, note rate, P&I, T&I and next due date, the servicer of record is the partner, and `payment.makeOneTime`, `autodraft.enroll` and `escrow.requestAnalysis` refuse with `LOAN_MONITORED`.", { skip }, async () => {
  await imported(); const loan1 = await loanByNumber(1);
  const s = maria ?? (maria = await signInByCode(loanN(1).email!, "10.33.3.1"));
  const r = await api("GET", `/v1/borrower/record?subject=${loan1.id}`, undefined, bearer(s.token));
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 800));
  const status = r.body["status"] as Json;
  assert.equal(status["badge"], "Monitored"); assert.equal(status["state_source"], "loans.status=monitored"); assert.equal((status["one_liner_tokens"] as Json)["servicer"], DEMO_PARTNER.legal_name);
  const facts = await latestFacts(loan1.id);
  const numbers = r.body["numbers"] as Json; assert.ok(numbers, "numbers on the record");
  assert.equal(String(numbers["upb_cents"]), facts.facts["upb_cents"]); assert.equal(numbers["note_rate"], "7.250"); assert.equal(String(numbers["pi_payment_cents"]), "306979"); assert.equal(BigInt(String(numbers["pi_payment_cents"])), 306979n);
  assert.equal(String(numbers["escrow_payment_cents"]), "61250"); assert.equal(BigInt(String(numbers["escrow_payment_cents"])), 61250n); assert.equal(numbers["next_due_date"], facts.facts["next_due_date"]); assert.equal(numbers["next_due_date"], "2026-10-01"); assert.equal(numbers["last_payment_date"], facts.facts["last_payment_date"]);
  assert.equal(numbers["figures_source"], "partner_book_facts"); assert.equal(numbers["as_of_date"], facts.as_of_date);
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ledger_lines WHERE loan_id = $1`, [loan1.id]))[0]!.n, "0", "no ledger behind a monitored loan");
  const servicer = (r.body["people"] as Json[]).find((p) => p["role"] === "servicer_of_record"); assert.ok(servicer, "the servicer of record"); assert.equal(servicer["party_id"], partnerPartyId); assert.equal(servicer["display_name"], DEMO_PARTNER.legal_name); assert.equal(servicer["direct_number"], "+18005550199");
  const pb = r.body["partner_book"] as Json; assert.equal(pb["monitored"], true); assert.equal(pb["partner_party_id"], partnerPartyId); assert.equal(pb["loan_last4"], "0001");
  const unavailable = (pb["commands_unavailable"] as Json[]).map((c) => c["command"]);
  for (const c of ["payment.makeOneTime", "autodraft.enroll", "escrow.requestAnalysis"]) assert.ok(unavailable.includes(c), `${c} listed as unavailable`);
  assert.ok((pb["commands_unavailable"] as Json[]).every((c) => c["code"] === "LOAN_MONITORED"));
  const property = r.body["property"] as Json; assert.ok(String(property["address"]).includes("1200 W Maple Ave") && String(property["address"]).includes("Phoenix"), JSON.stringify(property)); assert.equal(property["county"], "Maricopa"); assert.equal(property["occupancy"], "primary");
  for (const [command, body] of [["payment.makeOneTime", { amount_cents: "306979", date: "2026-09-15" }], ["autodraft.enroll", { draft_day: 1 }], ["escrow.requestAnalysis", {}]] as const) {
    const c = await api("POST", `/v1/borrower/commands/${command}`, { ...body, subject: { loan_id: loan1.id } }, bearer(s.token));
    assert.equal(c.status, 409, `${command}: ${JSON.stringify(c.body)}`); assert.equal(c.body["code"], "LOAN_MONITORED");
  }
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM loan_events WHERE loan_id = $1 AND type LIKE 'payment.%'`, [loan1.id]))[0]!.n, "0", "nothing moved");
});

test("33.1-T10: Given an invitation 14 calendar days old with no session on the party, when the sweep passes, then one reminder is sent on the same channel (`kind = reminder`), `SM_PARTNER_BOOK_INVITATION_REMINDER_14` reads `breached` with the reminder as its action and a second sweep sends nothing more; given a party that activated on day 3, then no reminder is sent.", { skip }, async () => {
  const r = await imported(); const importId = r["import_id"] as string;
  const loan1 = await loanByNumber(1); const loan2 = await loanByNumber(2); const loan3 = await loanByNumber(3);
  if (!maria) maria = await signInByCode(loanN(1).email!, "10.33.4.1");   // day 0: loan 1's party activated (T7)
  // day 3: loan 2's party activates
  clock.set("2026-09-17T12:00:00.000Z");
  const james = await signInByCode(loanN(2).email!, "10.33.4.2"); assert.equal(james.party_id, (await partyOfLoan(loan2.id)).id);
  assert.equal((await reminderTimers(loan2.id))[0]!.status, "satisfied");
  // day 14 has passed: the clocks' due instant is end of day ET on 2026-09-28
  const armed = await db.query<{ due_at: string }>(`SELECT max(due_at)::text AS due_at FROM timers WHERE code = 'SM_PARTNER_BOOK_INVITATION_REMINDER_14' AND status = 'armed'`);
  const dueAt = new Date(armed[0]!.due_at); assert.equal(dueAt.toISOString().slice(0, 10) === "2026-09-29" || dueAt.toISOString().slice(0, 10) === "2026-09-28", true, armed[0]!.due_at);
  clock.set(new Date(dueAt.getTime() + 60_000).toISOString());
  const before = [...edelivery().messages.keys()].filter((k) => k.endsWith(":reminder")).length; assert.equal(before, 0);
  const sweep = await api("POST", "/v1/sweep", {}, bearer(TOKEN));
  assert.equal(sweep.status, 200, JSON.stringify(sweep.body).slice(0, 800));
  const expected = book.loans.filter((l) => l.email !== null && l.n !== 1 && l.n !== 2); assert.equal(expected.length, 9);
  assert.equal(sweep.body["partner_book_reminders"], 9, "one reminder per invited party without a session");
  const breached = (sweep.body["breaches"] as Json[]).filter((b) => b["code"] === "SM_PARTNER_BOOK_INVITATION_REMINDER_14");
  assert.equal(breached.length, 9); assert.ok(breached.some((b) => b["loan_id"] === loan3.id)); assert.ok(breached.every((b) => (b["escalate_to"] as string[]).includes("portfolio")));
  // loan 3: one reminder on the same channel, the clock breached with the reminder as its action
  const party3 = await partyOfLoan(loan3.id);
  const rows3 = await db.query<{ kind: string; channel: string; message_id: string; notice_id: string; sent_at: string }>(`SELECT kind, channel, message_id, notice_id::text AS notice_id, sent_at::text AS sent_at FROM partner_book_invitations WHERE loan_id = $1 ORDER BY sent_at`, [loan3.id]);
  assert.deepEqual(rows3.map((x) => [x.kind, x.channel]), [["invitation", "email"], ["reminder", "email"]]);
  assert.equal(rows3[1]!.message_id, `partner_book:${importId}:${party3.id}:email:reminder`);
  const reminderMsg = edelivery().messages.get(rows3[1]!.message_id); assert.ok(reminderMsg, "the FAKE port holds the reminder"); assert.equal(reminderMsg.message.channel, "email"); assert.equal(reminderMsg.message.to, loanN(3).email); assert.equal(reminderMsg.status, "sent");
  const reminderNotice = runtime.noticeMemory.get(rows3[1]!.notice_id); assert.ok(reminderNotice); assert.equal(reminderNotice.templateCode, "NTC_SM_PARTNER_BOOK_INVITATION"); assert.equal(reminderNotice.payload["kind"], "reminder");
  const timer3 = (await reminderTimers(loan3.id))[0]!; assert.equal(timer3.status, "breached"); assert.ok(timer3.breached_at);
  const evs3 = await db.query<{ type: string; payload: Json }>(`SELECT type, payload FROM loan_events WHERE loan_id = $1 AND type IN ('timer.breached', 'partner_book.invitation.sent') ORDER BY sequence`, [loan3.id]);
  assert.deepEqual(evs3.map((e) => [e.type, e.payload["kind"] ?? e.payload["code"]]), [["partner_book.invitation.sent", "invitation"], ["timer.breached", "SM_PARTNER_BOOK_INVITATION_REMINDER_14"], ["partner_book.invitation.sent", "reminder"]], "the breach, then the reminder as its action");
  assert.equal(evs3[1]!.payload["timer_id"], timer3.id); assert.deepEqual(evs3[1]!.payload["escalate_to"], ["portfolio"]);
  assert.equal(evs3[2]!.payload["notice_id"], rows3[1]!.notice_id); assert.equal(evs3[2]!.payload["channel"], "email");
  const decision3 = await db.query<{ rationale: string }>(`SELECT rationale FROM agent_decisions WHERE loan_id = $1 AND action = 'account.invite' AND rationale LIKE 'reminder by email%'`, [loan3.id]); assert.equal(decision3.length, 1);
  assert.equal((await reminderTimers(loan3.id)).length, 1, "the reminder re-arms nothing (the trigger is kind=invitation)");
  // every reminded party has exactly one reminder; the activated parties (day 0 and day 3) have none
  const reminders = await db.query<{ loan_id: string; n: string }>(`SELECT loan_id::text AS loan_id, count(*)::text AS n FROM partner_book_invitations WHERE kind = 'reminder' GROUP BY loan_id`);
  assert.equal(reminders.length, 9); assert.ok(reminders.every((x) => x.n === "1"));
  for (const l of expected) { const id = (await loanByNumber(l.n)).id; assert.ok(reminders.some((x) => x.loan_id === id), `loan ${l.n} reminded`); }
  assert.ok(!reminders.some((x) => x.loan_id === loan1.id || x.loan_id === loan2.id), "no reminder for a party that activated");
  assert.equal((await reminderTimers(loan1.id))[0]!.status, "satisfied"); assert.equal((await reminderTimers(loan2.id))[0]!.status, "satisfied");
  assert.equal([...edelivery().messages.keys()].filter((k) => k.endsWith(":reminder")).length, 9);
  // a second sweep sends nothing more
  clock.set(new Date(dueAt.getTime() + 86_400_000).toISOString());
  const again = await api("POST", "/v1/sweep", {}, bearer(TOKEN));
  assert.equal(again.status, 200); assert.equal(again.body["partner_book_reminders"], 0);
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM partner_book_invitations WHERE kind = 'reminder'`))[0]!.n, "9");
  assert.equal([...edelivery().messages.keys()].filter((k) => k.endsWith(":reminder")).length, 9);
  assert.equal((await reminderTimers(loan3.id))[0]!.status, "breached", "the clock stays closed");
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM loan_events WHERE loan_id = $1 AND type = 'partner_book.invitation.sent'`, [loan3.id]))[0]!.n, "2");
});

// ---------------------------------------------------------------- rule 4 once per party; a partner name with a digit; `rejected` writes nothing (review findings on the first build)
test("33.1 rule 4: one homeowner with two loans on the tape is provisioned per loan and invited once (one invitation row, one FAKE message, one reminder clock, one reminder); a partner whose legal name carries a digit is still invited; a rejected first upload for a partner not on the platform writes no party, entity or program", { skip }, async () => {
  const col = (key: string): number => { const i = M3_V1.columns.findIndex((c) => c.key === key); assert.ok(i >= 0, key); return i; };
  const rowFor = (n: number, number: string, name: string): (string | number | null)[] => { const r = [...book.tapeRows[n]!]; r[col("servicer_loan_number")] = number; r[col("borrower_name")] = name; r[col("mers_min")] = ""; return r; };
  const partner = { legal_name: `Probe Partner 21st Mortgage (FAKE ${R})`, nmlsr_id: "7654321", servicer_number: "300099999", mers_org_id: "1000999" };
  const email = `olivia.stone.${R}@example.com`;
  const tape = writeXlsx([book.tapeRows[0]!, rowFor(1, "NL-8809431", "Olivia Stone"), rowFor(2, "NL-8809432", "Olivia Stone")], "M3");
  const supplement = `servicer_loan_number,borrower_email,borrower_phone,borrower_name\nNL-8809431,${email},(602) 555-0188,Olivia Stone\nNL-8809432,${email},(602) 555-0188,Olivia Stone\n`;
  const servicerRows = async (): Promise<number> => (await db.query(`SELECT 1 FROM parties WHERE party_type = 'servicer' AND legal_name = $1`, [partner.legal_name])).length;
  const importRows = async (): Promise<string> => (await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM partner_book_imports`))[0]!.n;
  // state machine `rejected`: nothing is written — the partner is not created for a file that is not the profile; the answer names the missing columns
  const importsBefore = await importRows(); const programsBefore = (await runtime.entities.load({})).filter((v) => v.kind === "partner_programs").length;
  const bad = await api("POST", "/v1/partner-book/imports", { partner, as_of_date: DEMO_AS_OF, profile: "m3-v1", tape: { filename: "bad.xlsx", content_base64: b64(writeXlsx([["Loan", "Name"], ["1", "x"]], "M3")) } }, bearer(TOKEN));
  assert.equal(bad.status, 200, JSON.stringify(bad.body).slice(0, 400)); assert.equal(bad.body["status"], "rejected"); assert.equal(bad.body["partner_party_id"], ""); assert.equal(bad.body["import_id"], "");
  assert.ok((((bad.body["report"] as Json)["rejected"] as Json)["missing_headers"] as string[]).includes("Servicer Loan Number"));
  assert.equal(await servicerRows(), 0, "no parties{servicer} row for a rejected first upload"); assert.equal(await importRows(), importsBefore, "no import row"); assert.equal((await runtime.entities.load({})).filter((v) => v.kind === "partner_programs").length, programsBefore, "no program");
  // the book: two loans, one homeowner
  const r = await api("POST", "/v1/partner-book/imports", { partner, as_of_date: DEMO_AS_OF, profile: "m3-v1", tape: { filename: "probe.xlsx", content_base64: b64(tape) }, supplement: { filename: "probe-supplement.csv", content_base64: b64(supplement) } }, bearer(TOKEN));
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 800)); assert.equal(r.body["status"], "loaded"); const importId = r.body["import_id"] as string; const pid = r.body["partner_party_id"] as string;
  assert.equal(r.body["rows_loaded"], 2); assert.equal(r.body["parties_created"], 1); assert.equal(r.body["parties_linked"], 1); assert.equal(r.body["invitations_sent"], 1, "once per provisioned party");
  assert.equal(await servicerRows(), 1, "the partner's party is written with the book"); assert.ok(await runtime.entities.current("partners", pid), "the partners/<id> entity"); assert.ok((await runtime.entities.load({})).some((v) => v.kind === "partner_programs" && v.data["partner_id"] === pid), "the 20.1 program");
  const loans = await loansOf(pid); assert.equal(loans.length, 2); assert.ok(loans.every((l) => l.status === "monitored" && l.min === null));
  const party = await partyOfLoan(loans[0]!.id); assert.equal((await partyOfLoan(loans[1]!.id)).id, party.id, "one party for both loans"); assert.equal(party.legal_name, "Olivia Stone"); assert.equal(party.contact["email"], email); assert.equal(party.contact["phone"], "+16025550188");
  assert.equal((await db.query(`SELECT 1 FROM parties WHERE party_type = 'borrower' AND legal_name = 'Olivia Stone'`)).length, 1);
  assert.equal((await db.query(`SELECT 1 FROM loan_events WHERE type = 'partner_book.account.provisioned' AND payload->>'party_id' = $1`, [party.id])).length, 2, "provisioned per loan");
  const rows = await db.query<{ loan_id: string; channel: string; kind: string; message_id: string; notice_id: string }>(`SELECT loan_id::text AS loan_id, channel, kind, message_id, notice_id::text AS notice_id FROM partner_book_invitations WHERE party_id = $1 ORDER BY sent_at`, [party.id]);
  assert.deepEqual(rows.map((x) => [x.kind, x.channel, x.message_id]), [["invitation", "email", `partner_book:${importId}:${party.id}:email`]], "one invitation row");
  const messages = [...edelivery().messages.values()].filter((m) => m.messageId.startsWith(`partner_book:${importId}:`)); assert.equal(messages.length, 1, "one FAKE message"); assert.equal(messages[0]!.status, "sent");
  assert.equal((await db.query(`SELECT 1 FROM loan_events WHERE type = 'partner_book.invitation.sent' AND payload->>'party_id' = $1`, [party.id])).length, 1);
  const notice = runtime.noticeMemory.get(rows[0]!.notice_id); assert.ok(notice); assert.equal(notice.status, "sent", `a partner name with a digit is not held: ${notice.heldReason ?? ""}`); assert.ok(notice.rendered.text.includes(partner.legal_name));
  assert.equal(((r.body["report"] as Json)["gaps"] as Json)["invitation_held"], 0); assert.equal(((r.body["report"] as Json)["invitations"] as Json[]).length, 1);
  const timers = [...(await reminderTimers(loans[0]!.id)), ...(await reminderTimers(loans[1]!.id))]; assert.equal(timers.length, 1, "one reminder clock for the one invitation"); assert.equal(timers[0]!.status, "armed");
  // the breach: one reminder for the party, then nothing more
  clock.set(new Date(Date.parse(timers[0]!.due_at!) + 60_000).toISOString());
  const sweep = await api("POST", "/v1/sweep", {}, bearer(TOKEN)); assert.equal(sweep.status, 200, JSON.stringify(sweep.body).slice(0, 400)); assert.equal(sweep.body["partner_book_reminders"], 1, "one reminder per party");
  const reminders = await db.query<{ loan_id: string; channel: string }>(`SELECT loan_id::text AS loan_id, channel FROM partner_book_invitations WHERE party_id = $1 AND kind = 'reminder'`, [party.id]);
  assert.equal(reminders.length, 1); assert.equal(reminders[0]!.channel, "email"); assert.equal(reminders[0]!.loan_id, rows[0]!.loan_id, "on the invitation's loan and channel");
  assert.equal([...edelivery().messages.keys()].filter((k) => k.startsWith(`partner_book:${importId}:`) && k.endsWith(":reminder")).length, 1);
  clock.set(new Date(Date.parse(timers[0]!.due_at!) + 86_400_000).toISOString());
  const again = await api("POST", "/v1/sweep", {}, bearer(TOKEN)); assert.equal(again.status, 200); assert.equal(again.body["partner_book_reminders"], 0);
  assert.equal((await db.query(`SELECT 1 FROM partner_book_invitations WHERE party_id = $1 AND kind = 'reminder'`, [party.id])).length, 1);
});
