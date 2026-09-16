// 36.3 The eligibility board: three buckets projected from the daily review
// spec/sections/36-servicing-partner-portal/36-3-eligibility-board-three-buckets.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// The harness is 36.2's partner side (own database `<base>_36_3`, the API server of src/runtime/server.ts in-process with the partner
// prefix /v1/partner/* and the borrower router, the FAKE e-delivery port, a FixedClock, the demo partner's parties{servicer} row with its
// seeded partner_admin, a second partner with one loan for the cross-tenant test) over 33.2's review side, driven exactly as
// src/domain/partner-book/33-2.spec.test.ts drives it: the FAKE sheet / program / LLPA matrix / cost schedules seeded by seedEntryDemo, the
// 12-loan fixture imported through importPartnerBook, the clock at 07:05 America/New_York on 2026-09-15 and runtime.sweep() taking the day's
// passes (20.1's run, 33.2's review with a scripted analyst, offer delivery; a second sweep for the FAKE MLO's terms review). No verdict is
// written by raw SQL. The worked figures are 33.2-T2's, read back from the review row and quoted to the cent — never recomputed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connect, type Db } from "../../infra/db/client.ts";
import { testDatabase } from "../../infra/db/test-db.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock } from "../../kernel/events/index.ts";
import { Runtime } from "../../runtime/app.ts";
import { createApiServer, listen } from "../../runtime/server.ts";
import { createLogger } from "../../runtime/log.ts";
import { createBorrowerRouter, type BorrowerRouter } from "../../runtime/borrower/routes.ts";
import { AnthropicLlm } from "../../runtime/borrower/agent/llm.ts";
import { FakeRateFeed } from "../../infra/integrations/rates.ts";
import { FakeReviewers } from "../../infra/integrations/reviewers.ts";
import { writeXlsx } from "../../infra/files/xlsx.ts";
import { M3_V1 } from "../partner-book/profiles/m3-v1.ts";
import { DEMO_AS_OF, DEMO_PARTNER, demoBook, demoMin, type DemoLoan } from "../partner-book/fixtures/partner-book-demo.ts";
import { holdsOf, importPartnerBook } from "../../runtime/partner-book.ts";
import { EXCLUSION_REASONS, reasonsInWords } from "../../runtime/partner-book-review.ts";
import { seedEntryDemo } from "../../runtime/entry-seed.ts";
import { seedPartnerPortalDemo, DEMO_PARTNER_ADMIN_EMAIL } from "../../runtime/partner-portal/seed.ts";
import { scriptedClient, type Scene } from "../borrower/eval/scripted-client.ts";
import { BOARD_BUCKETS, REVIEW_PENDING_WORDS, bucketForVerdict } from "./buckets.ts";

const { url: DB_URL, skip } = await testDatabase(import.meta.url);
const TOKEN = "ops-" + randomUUID();
const R = randomUUID().slice(0, 8);
type Json = Record<string, unknown>;
/** The first review day: 2026-09-15 07:05 America/New_York (EDT) — after 20.1's 06:30 run and 33.2's 07:00 pass (33-2.spec.test.ts's instant). */
const AS_OF = "2026-09-15"; const NOW = "2026-09-15T11:05:00.000Z";
const clock = new FixedClock(NOW);

// the scripted analyst (33.2 rule 4): review_facts then review_write, the figures only as tokens — 33-3.spec.test.ts's three scenes
const CLEAN_RATIONALE = "Your rate today is {{facts.rate_now}} and this morning's sheet shows {{facts.candidate_rate}}, which lowers the payment by {{facts.monthly_delta}}. The offer is on the card here.";
const ANALYST_CANDIDATE: Scene = { when: /verdict is candidate/, calls: [{ name: "review.facts", input: {} }, { name: "review.write", input: { rationale: CLEAN_RATIONALE, flags: [] } }], text: "Written." };
const ANALYST_WATCHING: Scene = { when: /verdict is watching/, calls: [{ name: "review.facts", input: {} }, { name: "review.write", input: { rationale: "Rates are not below yours yet; the book is checked every morning.", flags: [] } }], text: "Written." };
const ANALYST_OTHER: Scene = { when: /verdict is (excluded|not_now)/, calls: [{ name: "review.facts", input: {} }, { name: "review.write", input: { rationale: "The loan is out of today's review because of what is on the partner's file; nothing is offered.", flags: [] } }], text: "Written." };
const analystScripted = scriptedClient([ANALYST_CANDIDATE, ANALYST_WATCHING, ANALYST_OTHER]);

// the people: the seeded partner_admin of the demo partner (Northlight) and the seeded partner_admin of the second partner
const NORA = { email: DEMO_PARTNER_ADMIN_EMAIL, name: "Nora Northlight", password: `nora-northlight-admin-${R}` };
const SAM = { email: `sam.second.${R}@second-servicer.example`, name: "Sam Second", password: `sam-second-admin-pass-${R}` };
type Session = { token: string; session_id: string; partner_user_id: string; partner_party_id: string; role: string; body: Json };
let nora: Session; let sam: Session; let noraId = "";
let partnerA = ""; let partnerB = ""; let loanOfB = "";
const DENISE = { name: "Denise Okoro", email: `denise.okoro.${R}@example.test`, phone: "+16025550177", number: "NL-200007" };
const PARTNER_B = { legal_name: `Second Servicer (FAKE partner) ${R}`, nmlsr_id: "7654321", servicer_number: "300054321" };

let db: Db; let runtime: Runtime; let router: BorrowerRouter; let base = ""; let close: () => Promise<void> = async () => undefined;
const logLines: string[] = [];
const book = demoBook();
const loanN = (n: number): DemoLoan => book.loans.find((l) => l.n === n)!;
const bytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "utf8"));

test.before(async () => {
  if (skip) return;
  db = connect(DB_URL);
  const logger = createLogger("json", (line) => { logLines.push(line); if (process.env["FLOW_DEBUG"] && /error|unhandled|partner|"status":[45]/i.test(line)) process.stderr.write(line + "\n"); });
  // 33.2's runtime: the FAKE feed publishes the day's sheet, the FAKE officer approves the partner's campaign, the scripted analyst plays rule 4's turn
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock, logger, rateFeed: new FakeRateFeed(), reviewers: new FakeReviewers({ delaySeconds: 0 }), analystLlm: new AnthropicLlm({ client: analystScripted.client, model: "scripted" }) });
  // the demo partner's parties{servicer} row as 33.1's import writes it (36.2's harness), its seeded partner_admin (36.1 Operational prerequisites), the entry seed (33.2's harness) and the 12-loan fixture
  partnerA = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id, contact) VALUES ('servicer', $1, $2, $3, $4::jsonb) RETURNING id`, [DEMO_PARTNER.legal_name, DEMO_PARTNER.servicer_number, DEMO_PARTNER.mers_org_id, JSON.stringify({ phone: "+18005550199", nmlsr_id: DEMO_PARTNER.nmlsr_id })]))[0]!.id;
  const seed = await seedPartnerPortalDemo(runtime, { partner_id: partnerA }); assert.equal(seed.created, true); noraId = seed.partner_user_id;
  const entry = await seedEntryDemo(runtime, { partner_id: partnerA, nmlsr_id: DEMO_PARTNER.nmlsr_id }); assert.equal(entry.partner_id, partnerA, "the demo partner is the fixture partner");
  const imp = await importPartnerBook(runtime, { partner: DEMO_PARTNER, as_of_date: DEMO_AS_OF, profile: "m3-v1", tape: { filename: "partner-book-demo.xlsx", content: book.tape }, supplement: { filename: "partner-book-demo-supplement.csv", content: bytes(book.supplement) } }, { kind: "human", id: "u-ops-analyst", role: "ops_analyst" });
  assert.equal(imp.status, "loaded", JSON.stringify(imp.report).slice(0, 600)); assert.equal(imp.rows_loaded, 12); assert.equal(imp.partner_party_id, partnerA);
  // the second partner with one monitored loan of its own (36.1's harness: loan 7's row under another number, name and MIN) and its own seeded partner_admin
  const col = (key: string): number => { const i = M3_V1.columns.findIndex((c) => c.key === key); assert.ok(i >= 0, `the profile's ${key} column`); return i; };
  const row = [...book.tapeRows[7]!]; row[col("borrower_name")] = DENISE.name; row[col("servicer_loan_number")] = DENISE.number; row[col("mers_min")] = demoMin(207);
  const b = await importPartnerBook(runtime, { partner: PARTNER_B, as_of_date: DEMO_AS_OF, profile: "m3-v1", tape: { filename: "second-partner.xlsx", content: writeXlsx([book.tapeRows[0]!, row], "M3") }, supplement: { filename: "second-partner-supplement.csv", content: bytes(`servicer_loan_number,borrower_email,borrower_phone,borrower_name\n${DENISE.number},${DENISE.email},${DENISE.phone},${DENISE.name}\n`) } }, { kind: "system", id: "seed-demo" });
  assert.equal(b.status, "loaded", JSON.stringify(b.report).slice(0, 600)); assert.equal(b.rows_loaded, 1);
  partnerB = b.partner_party_id; loanOfB = b.loans[0]!.loan_id; assert.notEqual(partnerB, partnerA);
  const seedB = await seedPartnerPortalDemo(runtime, { partner_id: partnerB, email: SAM.email, name: SAM.name }); assert.equal(seedB.created, true); assert.equal(seedB.partner_party_id, partnerB);
  router = createBorrowerRouter({ runtime, logger, environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost", "http://127.0.0.1"], urlSecret: "test-secret", defaultPartnerId: partnerA });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger, borrowerRouter: router, borrower: { environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost"], urlSecret: "test-secret" } });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => { router.hub.close(); server.closeAllConnections?.(); server.close(() => db.end().then(() => resolve())); });
  // the 33.2 daily run (T1's "after a 33.2 daily run"): 20.1's run → the review → offer delivery; the FAKE MLO's terms review on the second sweep
  await settle();
  const sweep = await runtime.sweep(); await settle();
  assert.ok(sweep.refi?.ran, `the refinance check ran: ${sweep.refi?.reason}`); assert.ok(sweep.partner_book_review.ran, `the review ran: ${sweep.partner_book_review.reason}`); assert.equal(sweep.partner_book_review.as_of_date, AS_OF);
  await runtime.sweep(); await settle();
});
test.after(async () => { if (!skip) { await router.flows?.settle(); await close(); } });

// ---------------------------------------------------------------- helpers over the API (36.1's / 36.2's)
type Reply = { status: number; body: Json; headers: Headers };
async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-forwarded-for": "10.36.3.1", "user-agent": "36.3-spec", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text(); return { status: r.status, body: text ? (JSON.parse(text) as Json) : {}, headers: r.headers };
}
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
const settle = async (): Promise<void> => { await router.flows?.settle(); await router.agent?.settle(); await router.flows?.settle(); };
async function codeToken(email: string): Promise<string> {
  const c = await api("POST", "/v1/partner/auth/code", { email });
  assert.equal(c.status, 200, JSON.stringify(c.body)); assert.equal(c.body["delivery"], "FAKE");
  const v = await api("POST", "/v1/partner/auth/verify", { email, code: c.body["fake_code"] });
  assert.equal(v.status, 200, JSON.stringify(v.body)); return v.body["token"] as string;
}
async function enrol(p: { email: string; password: string }): Promise<string> {
  const token = await codeToken(p.email);
  const r = await api("POST", "/v1/partner/auth/password", { token, password: p.password });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body["enrolled"], true); return r.body["partner_user_id"] as string;
}
async function signIn(p: { email: string; password: string }): Promise<Session> {
  await codeToken(p.email);
  const r = await api("POST", "/v1/partner/auth/signin", { email: p.email, password: p.password });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { token: r.body["token"] as string, session_id: r.body["session_id"] as string, partner_user_id: r.body["partner_user_id"] as string, partner_party_id: r.body["partner_party_id"] as string, role: r.body["role"] as string, body: r.body };
}
/** 36.1 rule 6: a session ends 12 hours after it opened — every jump of the clock past that reopens the doors. */
async function refresh(): Promise<void> { nora = await signIn(NORA); if (sam) sam = await signIn(SAM); }
const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, params))[0]!.n);
type ActionRow = { id: string; partner_user_id: string | null; partner_party_id: string | null; role: string | null; action: string; subject_kind: string | null; subject_id: string | null; result: string; refusal_code: string | null; row_text: string };
const actions = async (where: string, params: unknown[] = []): Promise<ActionRow[]> => db.query<ActionRow>(`SELECT id::text AS id, partner_user_id::text AS partner_user_id, partner_party_id::text AS partner_party_id, role, action, subject_kind, subject_id, result, refusal_code, partner_actions::text AS row_text FROM partner_actions WHERE ${where} ORDER BY at, id`, params);
/** The partner-grade mask on a wire body (36.3 rule 5): the first name and last initial may show — never the full name, the last name, an e-mail, a phone, a street or a ZIP. */
const PII = (): string[] => [...book.loans.flatMap((l) => [l.name, l.last_name, l.email, l.phone, l.supplement_email, l.supplement_phone, String(l.tape["property_address"]), String(l.tape["property_zip"])]), DENISE.name, "Okoro", DENISE.email, DENISE.phone].filter((x): x is string => typeof x === "string" && x.length > 2);
const assertPartnerGrade = (text: string, what: string): void => { for (const p of PII()) assert.ok(!text.includes(p), `${what} carries homeowner data: ${p}`); assert.doesNotMatch(text, /@|\+1\d{10}/, `${what} carries an e-mail address or a phone`); };
/** Rule 5's "never on the row": no key of a score, DTI, ZIP, street, investor column, e-mail, phone, SSN or DOB anywhere in the answer. */
const FORBIDDEN_KEY = /fico|score|dti|zip|postal|address|street|county|city|investor|agency|remittance|mers|net_rate|retained|email|phone|ssn|tin|dob|birth/i;
const keysOf = (v: unknown, path = ""): string[] => (v && typeof v === "object" ? Object.entries(v as Json).flatMap(([k, x]) => [Array.isArray(v) ? path : `${path}.${k}`, ...keysOf(x, Array.isArray(v) ? path : `${path}.${k}`)]) : []);
/** Every leaf value of an answer as a string (a figure or a code is compared whole, never as a substring of an id or a date). */
const leafValues = (v: unknown, out = new Set<string>()): Set<string> => { if (v && typeof v === "object") for (const x of Object.values(v as Json)) leafValues(x, out); else if (v !== null && v !== undefined) out.add(String(v)); return out; };
const assertNoForbiddenKey = (body: unknown, what: string): void => { for (const k of new Set(keysOf(body))) assert.doesNotMatch(k.split(".").at(-1) ?? "", FORBIDDEN_KEY, `${what} carries the key ${k}`); };
type LoanRow = { id: string; servicer_loan_number: string; status: string };
const loansOf = async (partnerId: string, status = "monitored"): Promise<LoanRow[]> => db.query<LoanRow>(`SELECT id, servicer_loan_number, status::text AS status FROM loans WHERE partner_party_id = $1 AND status::text = $2 ORDER BY servicer_loan_number`, [partnerId, status]);
const loanByNumber = async (n: number): Promise<LoanRow> => { const l = (await loansOf(partnerA)).find((x) => x.servicer_loan_number === loanN(n).servicer_loan_number); assert.ok(l, `loan ${n} on the book`); return l; };
type ReviewRow = { loan_id: string; as_of_date: string; verdict: string; reasons: string[]; facts: Json; analyst: Json };
const latestReview = async (loanId: string): Promise<ReviewRow> => { const r = (await db.query<ReviewRow>(`SELECT loan_id::text AS loan_id, as_of_date::text AS as_of_date, verdict::text AS verdict, reasons, facts, analyst FROM partner_book_reviews WHERE loan_id = $1 ORDER BY as_of_date DESC, created_at DESC LIMIT 1`, [loanId]))[0]; assert.ok(r, `a review row for ${loanId}`); return r; };
const eligibility = async (s: Session, query = ""): Promise<Reply> => api("GET", `/v1/partner/eligibility${query}`, undefined, bearer(s.token));
const rowOf = (r: Reply, loanId: string): Json => { const row = (r.body["loans"] as Json[]).find((l) => l["loan_id"] === loanId); assert.ok(row, `loan ${loanId} on the answer`); return row; };
const usd = (c: bigint): string => { const whole = (c / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ","); return `$${whole}.${(c % 100n).toString().padStart(2, "0")}`; };
const colOf = (key: string): number => { const i = M3_V1.columns.findIndex((c) => c.key === key); assert.ok(i >= 0, `the profile's ${key} column`); return i; };
/** 33.1-T11's helper: the fixture tape as a later snapshot — every row's as-of date moved to `asOf`, the loans in `without` (by n) removed, the same facts otherwise. */
function tapeAsOf(asOf: string, without: readonly number[] = []): Uint8Array {
  const drop = new Set(without.map((n) => loanN(n).servicer_loan_number));
  const rows = book.tapeRows.filter((r, i) => i === 0 || !drop.has(String(r[colOf("servicer_loan_number")]))).map((r) => [...r]);
  for (let i = 1; i < rows.length; i += 1) rows[i]![colOf("as_of_date")] = asOf;
  return writeXlsx(rows, "M3");
}

test("36.3-T1: Given the demo book after a 33.2 daily run, when eligibility is fetched as the partner, then every monitored loan appears in exactly one of the three buckets or Holds, and the sum of counts equals monitored-not-held + held.", { skip }, async () => {
  assert.equal(await enrol(NORA), noraId); nora = await signIn(NORA); assert.deepEqual([nora.partner_party_id, nora.role], [partnerA, "partner_admin"]);
  const monitored = await loansOf(partnerA); assert.equal(monitored.length, 12, "the 12 monitored loans of the fixture");
  assert.equal(await count(`partner_book_reviews WHERE as_of_date = $1 AND loan_id IN (SELECT id FROM loans WHERE partner_party_id = $2)`, [AS_OF, partnerA]), 12, "33.2's daily run wrote a row per loan");
  assert.deepEqual(await holdsOf(runtime, partnerA), [], "nothing on hold after the first tape");
  // the board as the partner: as of the review's day, four counts, twelve rows
  const r = await eligibility(nora);
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 600));
  assert.equal(r.body["as_of_date"], AS_OF); assert.equal(r.body["partner_party_id"], partnerA); assert.equal(r.body["acted_as"], "partner_admin");
  const counts = r.body["counts"] as Record<string, number>;
  assert.deepEqual(counts, { eligible_now: 2, likely_soon: 7, not_near: 3, on_hold: 0 }, "worked example A's counts on the 12-loan demo's first review");
  const loans = r.body["loans"] as Json[]; assert.equal(loans.length, 12);
  // every monitored loan in exactly one of the three buckets or Holds; the bucket is the stored verdict, projected (rule 1) — read back from partner_book_reviews, never recomputed here
  const ids = loans.map((l) => l["loan_id"]); assert.equal(new Set(ids).size, 12); assert.deepEqual([...ids].sort(), monitored.map((l) => l.id).sort());
  for (const l of loans) {
    assert.ok((BOARD_BUCKETS as readonly string[]).includes(String(l["bucket"])), `${l["servicer_loan_last4"]}: bucket ${l["bucket"]}`); assert.equal(l["on_hold"], false); assert.equal(l["status"], "monitored");
    const review = await latestReview(String(l["loan_id"]));
    assert.equal(l["bucket"], bucketForVerdict(review.verdict), `${l["servicer_loan_last4"]}: the verdict ${review.verdict} is the bucket`);
    assert.deepEqual((l["latest_review"] as Json)["verdict"], review.verdict); assert.deepEqual(l["reasons"], review.reasons); assert.equal((l["latest_review"] as Json)["as_of_date"], AS_OF);
    assert.deepEqual(l["reasons_in_words"], reasonsInWords(review.reasons), "33.2's words for the codes (rule 6)");
    assert.equal(l["banner"], `Monitored — ${DEMO_PARTNER.legal_name} remains servicer`, "36.5 rule 4's sentence for a monitored row with no refinance application");
  }
  // rule 4: the sum of counts equals monitored-not-held + held
  const held = await holdsOf(runtime, partnerA);
  assert.equal(counts["eligible_now"]! + counts["likely_soon"]! + counts["not_near"]!, monitored.length - held.length); assert.equal(counts["on_hold"], held.length);
  assert.equal(counts["eligible_now"]! + counts["likely_soon"]! + counts["not_near"]! + counts["on_hold"]!, monitored.length, "12 in all, every monitored loan in exactly one place");
  const numberOf = (l: Json): string => monitored.find((m) => m.id === l["loan_id"])!.servicer_loan_number; const inBucket = (b: string): string[] => loans.filter((l) => l["bucket"] === b).map(numberOf).sort();
  assert.deepEqual(inBucket("eligible_now"), [loanN(1).servicer_loan_number, loanN(2).servicer_loan_number], "loans 1 and 2 on Eligible now");
  assert.deepEqual(inBucket("not_near"), [loanN(8).servicer_loan_number, loanN(10).servicer_loan_number, loanN(11).servicer_loan_number], "loans 8, 10 and 11 on Not near");
  assert.equal(inBucket("likely_soon").length, 7);
  // rule 2: the order within the board is 34.3's book order — by servicer loan number, never by a figure or a name
  assert.deepEqual(loans.map(numberOf), monitored.map((m) => m.servicer_loan_number));
  // worked example A: loan 1's row — the figures 33.2-T2 asserts, read from the review's facts and the tape's facts row, quoted to the cent (never recomputed here)
  const loan1 = await loanByNumber(1); const row1 = rowOf(r, loan1.id); const f1 = (await latestReview(loan1.id)).facts;
  assert.deepEqual([row1["servicer_loan_last4"], (row1["homeowner"] as Json)["legal_name"], row1["state"], row1["bucket"], row1["note_rate_pct"], row1["next_due_date"], (row1["value"] as Json)["as_of"], (row1["latest_review"] as Json)["as_of_date"]], ["0001", "Maria G.", "AZ", "eligible_now", "7.250", "2026-10-01", "2026-08-31", AS_OF]);
  assert.equal(row1["upb_cents"], "44136613"); assert.equal(BigInt(String(row1["upb_cents"])), 44136613n); assert.equal(usd(44136613n), "$441,366.13"); assert.equal(f1["upb_cents"], row1["upb_cents"]);
  assert.equal(row1["pi_cents"], "306979"); assert.equal(BigInt(String(row1["pi_cents"])), 306979n); assert.equal(usd(306979n), "$3,069.79"); assert.equal(f1["pi_cents"], row1["pi_cents"]);
  assert.equal((row1["value"] as Json)["value_cents"], "60500000"); assert.equal(BigInt(String((row1["value"] as Json)["value_cents"])), 60500000n); assert.equal(usd(60500000n), "$605,000.00"); assert.equal(f1["value_cents"], (row1["value"] as Json)["value_cents"]);
  assert.deepEqual([f1["note_rate_pct"], f1["ltv"], f1["candidate_rate_pct"], f1["rate_delta_bps"]], ["7.250", "0.7295", "6.375", 87.5], "the engine's figures behind the verdict (33.2-T2), on the review row and never on the board");
  assert.equal(row1["watch_rate_pct"], null, "no watch rate on a candidate"); assert.equal(row1["pipeline_stage"], "offered", "the offer 33.2's pass delivered: the member is also on the pipeline (36.4) and stays here");
  assert.ok(!JSON.stringify(row1).includes("87.5") && !JSON.stringify(row1).includes("6.375") && !JSON.stringify(row1).includes("0.7295"), "rule 2: no engine figure beyond the stored facts on the row");
  // rule 5: the partner-grade mask — no e-mail, phone, street, ZIP, FICO, DTI or investor column anywhere on the answer; the last four only; the first name and last initial only
  assertPartnerGrade(JSON.stringify(r.body), "the board"); assertNoForbiddenKey(r.body, "the board");
  for (const l of loans) { assert.match(String(l["servicer_loan_last4"]), /^\d{4}$/); assert.equal(l["servicer_loan_number"], undefined, "the last four only on a list row"); assert.match(String((l["homeowner"] as Json)["legal_name"]), /^[^\s]+ [A-Z]\.$/); }
  assert.ok(!leafValues(r.body).has(String(loanN(1).tape["fico_current"])), "the tape's FICO stays a fact of 33.1's file: never a value on the board");
  // 36.1 rule 5 on the log: one partner_portal.viewed row with the view, the person, the tenant, the role; no PII
  const viewed = await actions(`partner_user_id = $1 AND action = 'partner_portal.viewed' AND subject_kind = 'eligibility'`, [noraId]);
  assert.equal(viewed.length, 1); assert.deepEqual([viewed[0]!.subject_id, viewed[0]!.partner_party_id, viewed[0]!.role, viewed[0]!.result, viewed[0]!.refusal_code], [partnerA, partnerA, "partner_admin", "ok", null]);
  assertPartnerGrade(viewed[0]!.row_text, "the log row"); assert.ok(!viewed[0]!.row_text.includes("Maria"), "not even the first name on the log row");
  // rule 1's precedence — Holds: the partner's next tape (a day on) drops loan 5; the held loan leaves the three buckets for Holds and the counts still add up to the book
  clock.set("2026-09-16T12:00:00.000Z"); await refresh();
  const later = await importPartnerBook(runtime, { partner: DEMO_PARTNER, as_of_date: "2026-09-16", profile: "m3-v1", tape: { filename: "partner-book-2026-09-16.xlsx", content: tapeAsOf("2026-09-16", [5]) }, supplement: { filename: "partner-book-demo-supplement.csv", content: bytes(book.supplement) } }, { kind: "human", id: "u-ops-analyst", role: "ops_analyst" });
  assert.equal(later.status, "loaded", JSON.stringify(later.report).slice(0, 400)); assert.equal(later.rows_loaded, 11);
  const loan5 = await loanByNumber(5); const holds = await holdsOf(runtime, partnerA); assert.deepEqual(holds.map((h) => h.loan_id), [loan5.id], "loan 5 on hold (33.1 rule 8)");
  const heldBoard = await eligibility(nora); assert.equal(heldBoard.status, 200);
  const c2 = heldBoard.body["counts"] as Record<string, number>;
  assert.deepEqual(c2, { eligible_now: 2, likely_soon: 6, not_near: 3, on_hold: 1 }, "loan 5 (watching) leaves Likely soon for Holds");
  assert.equal(c2["eligible_now"]! + c2["likely_soon"]! + c2["not_near"]!, 12 - holds.length); assert.equal(c2["eligible_now"]! + c2["likely_soon"]! + c2["not_near"]! + c2["on_hold"]!, 12);
  assert.ok(!(heldBoard.body["loans"] as Json[]).some((l) => l["loan_id"] === loan5.id), "a held loan is in none of the three lists"); assert.equal((heldBoard.body["loans"] as Json[]).length, 11);
  assert.equal(heldBoard.body["as_of_date"], AS_OF, "the board is as of the latest review, not the tape");
  const holdsView = await eligibility(nora, "?on_hold=true"); assert.equal(holdsView.status, 200);
  const heldRows = holdsView.body["loans"] as Json[]; assert.equal(heldRows.length, 1); assert.deepEqual([heldRows[0]!["loan_id"], heldRows[0]!["on_hold"], heldRows[0]!["bucket"], (heldRows[0]!["hold"] as Json)["last_as_of_date"], (heldRows[0]!["latest_review"] as Json)["verdict"]], [loan5.id, true, null, DEMO_AS_OF, "watching"]);
  assert.deepEqual(holdsView.body["counts"], c2, "the counts are the whole book's under any query (rule 4)");
  // the next tape carries loan 5 again: the hold lifts by itself and the loan is back in its verdict's bucket
  clock.set("2026-09-17T12:00:00.000Z"); await refresh();
  const full = await importPartnerBook(runtime, { partner: DEMO_PARTNER, as_of_date: "2026-09-17", profile: "m3-v1", tape: { filename: "partner-book-2026-09-17.xlsx", content: tapeAsOf("2026-09-17") }, supplement: { filename: "partner-book-demo-supplement.csv", content: bytes(book.supplement) } }, { kind: "human", id: "u-ops-analyst", role: "ops_analyst" });
  assert.equal(full.status, "loaded"); assert.deepEqual(await holdsOf(runtime, partnerA), []);
  const back = await eligibility(nora); assert.deepEqual(back.body["counts"], { eligible_now: 2, likely_soon: 7, not_near: 3, on_hold: 0 }); assert.equal(rowOf(back, loan5.id)["bucket"], "likely_soon");
  assert.equal(await count(`partner_book_reviews WHERE loan_id = $1`, [loan5.id]), 1, "no review was written by the tapes: the bucket followed the hold, the verdict stood");
});

test("36.3-T2: Given a loan whose review verdict is `watching` with `watch_rate_pct` set, then the partner row shows bucket `likely_soon` and that watch rate, and does not show investor, DTI, or score fields.", { skip }, async () => {
  const loan9 = await loanByNumber(9); const review = await latestReview(loan9.id);
  assert.equal(review.verdict, "watching"); assert.equal(review.facts["watch_rate_pct"], "5.625", "33.2-T3: loan 9 (5.875 %, current) watching at 5.625");
  const r = await eligibility(nora); assert.equal(r.status, 200);
  const row = rowOf(r, loan9.id);
  assert.deepEqual([row["bucket"], row["watch_rate_pct"], (row["latest_review"] as Json)["verdict"], row["note_rate_pct"], row["state"], row["servicer_loan_last4"]], ["likely_soon", "5.625", "watching", "5.875", "AZ", "0009"]);
  assert.equal(row["watch_rate_pct"], review.facts["watch_rate_pct"], "the watch rate is the review's facts.watch_rate_pct, carried across unchanged");
  assert.match(String(review.reasons[0]), /^rate_delta_bps/, "the fire rule's rate-delta miss is the first reason"); assert.deepEqual(row["reasons"], review.reasons); assert.equal((row["reasons_in_words"] as string[])[0], "the rate reduction is under the program's floor");
  // every watching row carries its watch rate; no other row does
  for (const l of r.body["loans"] as Json[]) { const v = (l["latest_review"] as Json)["verdict"]; if (v === "watching") { assert.equal(l["bucket"], "likely_soon"); assert.match(String(l["watch_rate_pct"]), /^\d+\.\d{3}$/, `${l["servicer_loan_last4"]}: the watch rate`); } else assert.equal(l["watch_rate_pct"], null, `${l["servicer_loan_last4"]}: no watch rate on a ${v} row`); }
  // no investor, DTI or score field on the row — not merely no filter on them: no such key anywhere, and the tape's own figures for loan 9 nowhere on the answer
  assertNoForbiddenKey(row, "loan 9's row"); assertNoForbiddenKey(r.body, "the board");
  const tape = loanN(9).tape as Record<string, unknown>; const values = leafValues(row);
  for (const k of ["fico_current", "fico_original", "dti_pct", "agency_remittance_type", "mers_min", "property_zip", "investor_name"]) if (tape[k] !== undefined && tape[k] !== null && String(tape[k]).length > 2) assert.ok(!values.has(String(tape[k])), `${k} (${tape[k]}) is not a value on the row`);
  for (const k of Object.keys(tape).filter((x) => FORBIDDEN_KEY.test(x))) assert.ok(!(k in row), `the tape's ${k} column never reaches the row`);
  assertPartnerGrade(JSON.stringify(r.body), "the board");
  // rule 7: nothing on the board writes — the row carries no control and a POST on the board is not a route
  const post = await api("POST", "/v1/partner/eligibility", { loan_id: loan9.id, verdict: "candidate" }, bearer(nora.token)); assert.equal(post.status, 404);
  assert.equal((await latestReview(loan9.id)).verdict, "watching");
});

test("36.3-T3: Given a loan `excluded` for bankruptcy, then it is `not_near` with the engine reason code, not a free-text diagnosis.", { skip }, async () => {
  const loan11 = await loanByNumber(11); const review = await latestReview(loan11.id);
  assert.equal(review.verdict, "excluded"); assert.deepEqual(review.reasons, ["bankruptcy_active"], "33.2-T3: loan 11's active Chapter 13");
  const r = await eligibility(nora); assert.equal(r.status, 200);
  const row = rowOf(r, loan11.id);
  assert.deepEqual([row["bucket"], (row["latest_review"] as Json)["verdict"], row["reasons"], row["reasons_in_words"], row["watch_rate_pct"], row["servicer_loan_last4"], row["state"]], ["not_near", "excluded", ["bankruptcy_active"], ["an active bankruptcy"], null, "0011", "CO"]);
  // the code, not a diagnosis: the engine's code as stored (33.2's exclusion list), the words the copy library gives it, and no analyst rationale or free text on the board
  assert.ok(EXCLUSION_REASONS.includes("bankruptcy_active")); for (const c of row["reasons"] as string[]) assert.match(c, /^[a-z_]+$/, `${c} is a code`);
  assert.ok(typeof review.analyst["rationale"] === "string" || typeof review.analyst["explanation_text"] === "string", "the analyst's or the engine's text is on the review row…");
  for (const text of [review.analyst["rationale"], review.analyst["explanation_text"]].filter((x): x is string => typeof x === "string" && x.length > 0)) assert.ok(!JSON.stringify(row).includes(text), "…and never on the board (the loan page renders the rationale's tokens, 36.5)");
  assert.doesNotMatch(JSON.stringify(row), /rationale|explanation|analyst|chapter|bankrupt[^c]/i, "no free-text diagnosis, no chapter of the case — the code and its words only");
  assert.ok(!leafValues(row).has(String(loanN(11).tape["bk_chapter"] ?? "13")), "the chapter is a fact of 33.1's file, not a value on the board");
  // every Not near row carries codes: 33.2's exclusion / suppression codes, a fire-rule miss by its prefix, or this board's own review_pending
  for (const l of (r.body["loans"] as Json[]).filter((x) => x["bucket"] === "not_near")) { assert.ok(["not_now", "excluded"].includes(String((l["latest_review"] as Json)["verdict"]))); assert.ok((l["reasons"] as string[]).length > 0); assert.deepEqual(l["reasons_in_words"], reasonsInWords(l["reasons"] as string[])); }
  assert.equal(REVIEW_PENDING_WORDS, "the first review has not run");
});

test("36.3-T4: Given a query `?bucket=eligible_now&state=CA`, then only `candidate` loans in CA return. Adding `?fico=` or `?dti=` is ignored (unknown query keys dropped, not applied).", { skip }, async () => {
  const full = await eligibility(nora); const counts = full.body["counts"]; assert.deepEqual(counts, { eligible_now: 2, likely_soon: 7, not_near: 3, on_hold: 0 });
  const stateOf = (n: number): string => loanN(n).state;
  assert.deepEqual([stateOf(1), stateOf(2), stateOf(3)], ["AZ", "CO", "CA"], "the fixture: the two candidates are in AZ and CO; loan 3 (watching) is the CA loan");
  // ?bucket=eligible_now&state=CA: only candidate loans in CA — the fixture has none, so the list is empty and the counts are still the whole book's (rule 4)
  const ca = await eligibility(nora, "?bucket=eligible_now&state=CA"); assert.equal(ca.status, 200, JSON.stringify(ca.body));
  const caRows = ca.body["loans"] as Json[]; assert.ok(caRows.every((l) => (l["latest_review"] as Json)["verdict"] === "candidate" && l["state"] === "CA"));
  assert.deepEqual(caRows, [], "no candidate in CA on the first review"); assert.deepEqual(ca.body["counts"], counts); assert.deepEqual((ca.body["query"] as Json)["applied"], ["bucket", "state"]);
  // the same narrowing where the book has a row: ?bucket=eligible_now&state=CO is loan 2 and nothing else; ?state=CA alone is loan 3
  const co = await eligibility(nora, "?bucket=eligible_now&state=CO"); const coRows = co.body["loans"] as Json[];
  assert.equal(coRows.length, 1); assert.deepEqual([coRows[0]!["loan_id"], coRows[0]!["state"], coRows[0]!["bucket"], (coRows[0]!["latest_review"] as Json)["verdict"]], [(await loanByNumber(2)).id, "CO", "eligible_now", "candidate"]); assert.deepEqual(co.body["counts"], counts);
  const caOnly = await eligibility(nora, "?state=CA"); assert.deepEqual((caOnly.body["loans"] as Json[]).map((l) => [l["loan_id"], l["bucket"]]), [[(await loanByNumber(3)).id, "likely_soon"]]);
  const eligible = await eligibility(nora, "?bucket=eligible_now"); assert.deepEqual((eligible.body["loans"] as Json[]).map((l) => l["loan_id"]).sort(), [(await loanByNumber(1)).id, (await loanByNumber(2)).id].sort());
  // ?fico=, ?dti= and every other spelling are dropped unread: the answer is the same as without them, key by key
  const before = logLines.length;
  const noisy = await eligibility(nora, "?bucket=eligible_now&state=CO&fico=700&dti=40&zip=80220&name=James&age=40&investor=FNMA&score=1&ready=true&verdict=watching");
  assert.equal(noisy.status, 200); assert.deepEqual(noisy.body["loans"], co.body["loans"]); assert.deepEqual(noisy.body["counts"], co.body["counts"]); assert.deepEqual(noisy.body["query"], co.body["query"]);
  const dropped = logLines.slice(before).find((l) => l.includes("partner.eligibility.keys_dropped")); assert.ok(dropped, "the dropped keys are named on the server log…");
  for (const k of ["fico", "dti", "zip", "name", "age", "investor", "score", "ready", "verdict"]) assert.ok(dropped.includes(`"${k}"`), `…${k} by name`);
  for (const v of ["700", "80220", "James", "FNMA"]) assert.ok(!dropped.includes(v), `…never a value (${v})`);
  // a value outside the set is dropped as an unknown key is: ?bucket=serviced answers the whole board; ?state=co is CO; ?state=XX is an empty list with the full counts; ?on_hold=false is the board
  const serviced = await eligibility(nora, "?bucket=serviced"); assert.equal((serviced.body["loans"] as Json[]).length, 12); assert.deepEqual((serviced.body["query"] as Json)["applied"], []);
  const lower = await eligibility(nora, "?state=co"); assert.deepEqual(lower.body["loans"], (await eligibility(nora, "?state=CO")).body["loans"]); assert.equal((lower.body["query"] as Json)["state"], "CO");
  const xx = await eligibility(nora, "?state=XX"); assert.deepEqual(xx.body["loans"], []); assert.deepEqual(xx.body["counts"], counts);
  assert.deepEqual((await eligibility(nora, "?on_hold=false")).body["loans"], full.body["loans"]);
  // the same loan is in the same bucket under every query (rule 3: the query never widens or re-selects membership)
  const bucketOfLoan = new Map((full.body["loans"] as Json[]).map((l) => [l["loan_id"], l["bucket"]]));
  for (const reply of [ca, co, caOnly, eligible, noisy, serviced, lower]) for (const l of reply.body["loans"] as Json[]) assert.equal(l["bucket"], bucketOfLoan.get(l["loan_id"]));
  // 36.1 rule 5: the log rows carry the view and never a filter's text
  const viewed = await actions(`partner_user_id = $1 AND subject_kind = 'eligibility'`, [noraId]);
  assert.ok(viewed.length >= 10); for (const a of viewed) { assert.equal(a.result, "ok"); assert.doesNotMatch(a.row_text, /fico|dti|James|FNMA|80220/, "no filter text on the log row"); }
});

test("36.3-T5: Given partner A, when they request eligibility, then partner B’s loans are absent (not empty-with-403).", { skip }, async () => {
  const bLoans = await loansOf(partnerB); assert.deepEqual(bLoans.map((l) => l.id), [loanOfB], "partner B's one monitored loan");
  // partner A's admin: 200, the twelve rows, partner B's loan and its homeowner nowhere — no refusal, no empty list beside an error
  const a = await eligibility(nora);
  assert.equal(a.status, 200, JSON.stringify(a.body).slice(0, 300)); assert.equal(a.body["code"], undefined); assert.equal(a.body["error"], undefined);
  const aRows = a.body["loans"] as Json[]; assert.equal(aRows.length, 12); assert.ok(!aRows.some((l) => l["loan_id"] === loanOfB), "partner B's loan is absent"); assert.ok(aRows.every((l) => l["partner_party_id"] === partnerA));
  assert.deepEqual(a.body["counts"], { eligible_now: 2, likely_soon: 7, not_near: 3, on_hold: 0 }, "the counts are the tenant's, not the platform's");
  assert.doesNotMatch(JSON.stringify(a.body), new RegExp(`${loanOfB}|Denise|Okoro|Second Servicer`), "nothing of partner B on the answer");
  // partner B's own admin sees its own book — the one loan, its own counts — and nothing of partner A's twelve
  await enrol(SAM); sam = await signIn(SAM); assert.deepEqual([sam.partner_party_id, sam.role], [partnerB, "partner_admin"]);
  const b = await eligibility(sam);
  assert.equal(b.status, 200, JSON.stringify(b.body).slice(0, 300));
  const bRows = b.body["loans"] as Json[]; assert.deepEqual(bRows.map((l) => l["loan_id"]), [loanOfB]); assert.equal(bRows[0]!["partner_party_id"], partnerB); assert.equal((bRows[0]!["homeowner"] as Json)["legal_name"], "Denise O.");
  const bc = b.body["counts"] as Record<string, number>; assert.equal(bc["eligible_now"]! + bc["likely_soon"]! + bc["not_near"]! + bc["on_hold"]!, 1);
  const aIds = new Set(aRows.map((l) => l["loan_id"])); assert.ok(!bRows.some((l) => aIds.has(l["loan_id"])));
  assert.doesNotMatch(JSON.stringify(b.body), /Maria|Garcia|Northlight/, "nothing of partner A on partner B's answer");
  // the same under every role's fallback and every query: partner B's loan never appears for partner A
  for (const q of ["?bucket=eligible_now", "?bucket=likely_soon", "?bucket=not_near", "?on_hold=true", `?state=${loanN(7).state}`, "?role=partner_admin"]) { const r = await eligibility(nora, q); assert.equal(r.status, 200, q); assert.ok(!(r.body["loans"] as Json[]).some((l) => l["loan_id"] === loanOfB), q); }
  // 36.1 rule 5: both looks are on the log, each under its own tenant, none refused
  const logA = await actions(`partner_user_id = $1 AND subject_kind = 'eligibility'`, [noraId]); assert.ok(logA.every((x) => x.partner_party_id === partnerA && x.result === "ok"));
  const logB = await actions(`partner_user_id = $1 AND subject_kind = 'eligibility'`, [sam.partner_user_id]); assert.equal(logB.length, 1); assert.deepEqual([logB[0]!.partner_party_id, logB[0]!.subject_id, logB[0]!.result], [partnerB, partnerB, "ok"]);
  assert.equal(await count(`partner_actions WHERE subject_kind = 'eligibility' AND result = 'refused'`), 0, "a read is never 403");
});
