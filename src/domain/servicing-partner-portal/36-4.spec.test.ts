// 36.4 The refinance pipeline feed: members in motion, projected from the rows that already exist
// spec/sections/36-servicing-partner-portal/36-4-refinance-pipeline-feed.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// The harness is 36-3.spec.test.ts's (36.2's partner side over 33.2's review side, driven as 33-2.spec.test.ts drives it): own database
// `<base>_36_4`, the API server in-process with the partner prefix and the borrower router, the FAKE feed / officer / e-delivery, the
// scripted analyst, the 12-loan fixture and a second partner with one loan and its own partner_admin. The motion is driven through the
// owners' own functions and doors exactly as their tests drive it — the homeowner's Yes on the OfferCard through the borrower API
// (33-3.spec.test.ts T2), 33.2's `expireOffers` (T6), 30.2's funding from the demo snapshot and 35.10's closeout pass (33-3.spec.test.ts T6)
// — never a stage written by raw SQL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connect, type Db } from "../../infra/db/client.ts";
import { testDatabase } from "../../infra/db/test-db.ts";
import { PgEntityRepository, decodeEntityData } from "../../infra/db/entities.ts";
import { PgBorrowerUiRepository, type CardInstanceRow } from "../../infra/db/borrower-ui.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock } from "../../kernel/events/index.ts";
import { plainDate } from "../../kernel/calendar/date.ts";
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
import { importPartnerBook } from "../../runtime/partner-book.ts";
import { opportunityIdFor } from "../../runtime/partner-book-review.ts";
import { expireOffers } from "../../runtime/partner-book-offers.ts";
import { readinessRead } from "../../runtime/partner-book-readiness.ts";
import { LOAN_PAID_OFF_EVENT } from "../../runtime/borrower/flows/16-readiness.ts";
import { closeoutPass } from "../../runtime/refinance-closeout.ts";
import { demoFunded, demoSnapshot, fundApplication } from "../../runtime/origination.ts";
import { seedEntryDemo } from "../../runtime/entry-seed.ts";
import { seedPartnerPortalDemo, DEMO_PARTNER_ADMIN_EMAIL } from "../../runtime/partner-portal/seed.ts";
import { scriptedClient, type Scene } from "../borrower/eval/scripted-client.ts";
import { BANNER_ACTIVE, BANNER_IN_REFINANCE, bannerOf, bucketForVerdict } from "./buckets.ts";
import { PIPELINE_STAGES, TERMINAL_STAGES, daysInStage } from "./pipeline.ts";

const { url: DB_URL, skip } = await testDatabase(import.meta.url);
const TOKEN = "ops-" + randomUUID();
const R = randomUUID().slice(0, 8);
type Json = Record<string, unknown>;
/** The first review day: 2026-09-15 07:05 America/New_York (33-2.spec.test.ts's instant). */
const AS_OF = "2026-09-15"; const NOW = "2026-09-15T11:05:00.000Z";
/** Day 31: the offers of 2026-09-15 are valid until 2026-10-15; 07:05 ET on 2026-10-16 expires them (33.2-T6). */
const AS_OF_31 = "2026-10-16"; const NOW_31 = "2026-10-16T11:05:00.000Z";
/** Funding day (30.2's demo fixture: the rescission expired 2026-11-11, disbursement 2026-11-12) — 33-3.spec.test.ts T6's instant. */
const NOW_FUNDING = "2026-11-12T18:40:00.000Z";
const clock = new FixedClock(NOW);

// the scripted analyst (33.2 rule 4): 33-3.spec.test.ts's three scenes
const CLEAN_RATIONALE = "Your rate today is {{facts.rate_now}} and this morning's sheet shows {{facts.candidate_rate}}, which lowers the payment by {{facts.monthly_delta}}. The offer is on the card here.";
const ANALYST_CANDIDATE: Scene = { when: /verdict is candidate/, calls: [{ name: "review.facts", input: {} }, { name: "review.write", input: { rationale: CLEAN_RATIONALE, flags: [] } }], text: "Written." };
const ANALYST_WATCHING: Scene = { when: /verdict is watching/, calls: [{ name: "review.facts", input: {} }, { name: "review.write", input: { rationale: "Rates are not below yours yet; the book is checked every morning.", flags: [] } }], text: "Written." };
const ANALYST_OTHER: Scene = { when: /verdict is (excluded|not_now)/, calls: [{ name: "review.facts", input: {} }, { name: "review.write", input: { rationale: "The loan is out of today's review because of what is on the partner's file; nothing is offered.", flags: [] } }], text: "Written." };
const analystScripted = scriptedClient([ANALYST_CANDIDATE, ANALYST_WATCHING, ANALYST_OTHER]);

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
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock, logger, rateFeed: new FakeRateFeed(), reviewers: new FakeReviewers({ delaySeconds: 0 }), analystLlm: new AnthropicLlm({ client: analystScripted.client, model: "scripted" }) });
  partnerA = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id, contact) VALUES ('servicer', $1, $2, $3, $4::jsonb) RETURNING id`, [DEMO_PARTNER.legal_name, DEMO_PARTNER.servicer_number, DEMO_PARTNER.mers_org_id, JSON.stringify({ phone: "+18005550199", nmlsr_id: DEMO_PARTNER.nmlsr_id })]))[0]!.id;
  const seed = await seedPartnerPortalDemo(runtime, { partner_id: partnerA }); assert.equal(seed.created, true); noraId = seed.partner_user_id;
  const entry = await seedEntryDemo(runtime, { partner_id: partnerA, nmlsr_id: DEMO_PARTNER.nmlsr_id }); assert.equal(entry.partner_id, partnerA);
  const imp = await importPartnerBook(runtime, { partner: DEMO_PARTNER, as_of_date: DEMO_AS_OF, profile: "m3-v1", tape: { filename: "partner-book-demo.xlsx", content: book.tape }, supplement: { filename: "partner-book-demo-supplement.csv", content: bytes(book.supplement) } }, { kind: "human", id: "u-ops-analyst", role: "ops_analyst" });
  assert.equal(imp.status, "loaded", JSON.stringify(imp.report).slice(0, 600)); assert.equal(imp.rows_loaded, 12);
  const col = (key: string): number => { const i = M3_V1.columns.findIndex((c) => c.key === key); assert.ok(i >= 0, `the profile's ${key} column`); return i; };
  const row = [...book.tapeRows[7]!]; row[col("borrower_name")] = DENISE.name; row[col("servicer_loan_number")] = DENISE.number; row[col("mers_min")] = demoMin(207);
  const b = await importPartnerBook(runtime, { partner: PARTNER_B, as_of_date: DEMO_AS_OF, profile: "m3-v1", tape: { filename: "second-partner.xlsx", content: writeXlsx([book.tapeRows[0]!, row], "M3") }, supplement: { filename: "second-partner-supplement.csv", content: bytes(`servicer_loan_number,borrower_email,borrower_phone,borrower_name\n${DENISE.number},${DENISE.email},${DENISE.phone},${DENISE.name}\n`) } }, { kind: "system", id: "seed-demo" });
  assert.equal(b.status, "loaded", JSON.stringify(b.report).slice(0, 600)); partnerB = b.partner_party_id; loanOfB = b.loans[0]!.loan_id; assert.notEqual(partnerB, partnerA);
  const seedB = await seedPartnerPortalDemo(runtime, { partner_id: partnerB, email: SAM.email, name: SAM.name }); assert.equal(seedB.created, true);
  router = createBorrowerRouter({ runtime, logger, environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost", "http://127.0.0.1"], urlSecret: "test-secret", defaultPartnerId: partnerA });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger, borrowerRouter: router, borrower: { environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost"], urlSecret: "test-secret" } });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => { router.hub.close(); server.closeAllConnections?.(); server.close(() => db.end().then(() => resolve())); });
  // the 33.2 daily run: 20.1's run → the review → offer delivery (loans 1 and 2 by e-mail); the FAKE MLO's terms review on the second sweep puts the OfferCard on the rail (32.11)
  await settle();
  const sweep = await runtime.sweep(); await settle();
  assert.ok(sweep.refi?.ran, `the refinance check ran: ${sweep.refi?.reason}`); assert.ok(sweep.partner_book_review.ran, `the review ran: ${sweep.partner_book_review.reason}`);
  await runtime.sweep(); await settle();
  await enrol(NORA); nora = await signIn(NORA); await enrol(SAM); sam = await signIn(SAM);
});
test.after(async () => { if (!skip) { await router.flows?.settle(); await close(); } });

// ---------------------------------------------------------------- helpers over the API (36.1's / 36.2's / 33.3's)
type Reply = { status: number; body: Json };
async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, ip = "10.36.4.1"): Promise<Reply> {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-forwarded-for": ip, "user-agent": "36.4-spec", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text(); return { status: r.status, body: text ? (JSON.parse(text) as Json) : {} };
}
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
const settle = async (): Promise<void> => { await router.flows?.settle(); await router.agent?.settle(); await router.flows?.settle(); };
async function codeToken(email: string): Promise<string> {
  const c = await api("POST", "/v1/partner/auth/code", { email }); assert.equal(c.status, 200, JSON.stringify(c.body)); assert.equal(c.body["delivery"], "FAKE");
  const v = await api("POST", "/v1/partner/auth/verify", { email, code: c.body["fake_code"] }); assert.equal(v.status, 200, JSON.stringify(v.body)); return v.body["token"] as string;
}
async function enrol(p: { email: string; password: string }): Promise<string> { const token = await codeToken(p.email); const r = await api("POST", "/v1/partner/auth/password", { token, password: p.password }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body["partner_user_id"] as string; }
async function signIn(p: { email: string; password: string }): Promise<Session> {
  await codeToken(p.email); const r = await api("POST", "/v1/partner/auth/signin", { email: p.email, password: p.password }); assert.equal(r.status, 200, JSON.stringify(r.body));
  return { token: r.body["token"] as string, session_id: r.body["session_id"] as string, partner_user_id: r.body["partner_user_id"] as string, partner_party_id: r.body["partner_party_id"] as string, role: r.body["role"] as string, body: r.body };
}
/** 36.1 rule 6: a session ends 12 hours after it opened — every jump of the clock past that reopens the doors. */
async function refresh(): Promise<void> { nora = await signIn(NORA); sam = await signIn(SAM); }
const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, params))[0]!.n);
type ActionRow = { id: string; partner_user_id: string | null; partner_party_id: string | null; role: string | null; action: string; subject_kind: string | null; subject_id: string | null; result: string; refusal_code: string | null; row_text: string };
const actions = async (where: string, params: unknown[] = []): Promise<ActionRow[]> => db.query<ActionRow>(`SELECT id::text AS id, partner_user_id::text AS partner_user_id, partner_party_id::text AS partner_party_id, role, action, subject_kind, subject_id, result, refusal_code, partner_actions::text AS row_text FROM partner_actions WHERE ${where} ORDER BY at, id`, params);
const PII = (): string[] => [...book.loans.flatMap((l) => [l.name, l.last_name, l.email, l.phone, l.supplement_email, l.supplement_phone, String(l.tape["property_address"]), String(l.tape["property_zip"])]), DENISE.name, "Okoro", DENISE.email, DENISE.phone].filter((x): x is string => typeof x === "string" && x.length > 2);
const assertPartnerGrade = (text: string, what: string): void => { for (const p of PII()) assert.ok(!text.includes(p), `${what} carries homeowner data: ${p}`); assert.doesNotMatch(text, /@|\+1\d{10}/, `${what} carries an e-mail address or a phone`); };
const FORBIDDEN_KEY = /fico|score|dti|zip|postal|address|street|county|city|investor|agency|remittance|mers|net_rate|retained|email|phone|ssn|tin|dob|birth/i;
const keysOf = (v: unknown, path = ""): string[] => (v && typeof v === "object" ? Object.entries(v as Json).flatMap(([k, x]) => [Array.isArray(v) ? path : `${path}.${k}`, ...keysOf(x, Array.isArray(v) ? path : `${path}.${k}`)]) : []);
const assertNoForbiddenKey = (body: unknown, what: string): void => { for (const k of new Set(keysOf(body))) assert.doesNotMatch(k.split(".").at(-1) ?? "", FORBIDDEN_KEY, `${what} carries the key ${k}`); };
type LoanRow = { id: string; servicer_loan_number: string; status: string; refinanced_by_loan_id: string | null; origination_application_id: string | null };
const loanRow = async (id: string): Promise<LoanRow> => { const l = (await db.query<LoanRow>(`SELECT id::text AS id, servicer_loan_number, status::text AS status, refinanced_by_loan_id::text AS refinanced_by_loan_id, origination_application_id::text AS origination_application_id FROM loans WHERE id = $1`, [id]))[0]; assert.ok(l, `loan ${id}`); return l; };
const loanByNumber = async (n: number): Promise<LoanRow> => { const l = (await db.query<LoanRow>(`SELECT id::text AS id, servicer_loan_number, status::text AS status, refinanced_by_loan_id::text AS refinanced_by_loan_id, origination_application_id::text AS origination_application_id FROM loans WHERE partner_party_id = $1 AND servicer_loan_number = $2`, [partnerA, loanN(n).servicer_loan_number]))[0]; assert.ok(l, `loan ${n} on the book`); return l; };
type PartyRow = { id: string; legal_name: string; contact: Json };
const partyOfLoan = async (loanId: string): Promise<PartyRow> => { const r = (await db.query<PartyRow>(`SELECT p.id::text AS id, p.legal_name, p.contact FROM loan_borrowers lb JOIN borrowers b ON b.id = lb.borrower_id JOIN parties p ON p.id = b.party_id WHERE lb.loan_id = $1 ORDER BY lb.is_primary DESC LIMIT 1`, [loanId]))[0]; assert.ok(r, "the loan's party"); return r; };
type EventRow = { id: string; type: string; loan_id: string | null; application_id: string | null; actor_id: string; payload: Json; occurred_at: string };
const events = async (type: string, loanId?: string): Promise<EventRow[]> => db.query<EventRow>(`SELECT id::text AS id, type, loan_id::text AS loan_id, application_id::text AS application_id, actor_id, payload, occurred_at::text AS occurred_at FROM loan_events WHERE type = $1 AND ($2::uuid IS NULL OR loan_id = $2::uuid) ORDER BY sequence`, [type, loanId ?? null]);
const appEvents = async (appId: string, type: string): Promise<EventRow[]> => db.query<EventRow>(`SELECT id::text AS id, type, loan_id::text AS loan_id, application_id::text AS application_id, actor_id, payload, occurred_at::text AS occurred_at FROM loan_events WHERE application_id = $1 AND type = $2 ORDER BY sequence`, [appId, type]);
const iso = (s: string): string => new Date(s).toISOString();
const entity = async (kind: string, id: string): Promise<Json | null> => { const r = (await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = $1 AND id = $2`, [kind, id]))[0]; return r ? decodeEntityData(r.data) as Json : null; };
const programId = (): string => `prog-refi-${partnerA.slice(0, 8)}`;
const oppOf = (loanId: string, asOf = AS_OF): string => opportunityIdFor(loanId, plainDate(asOf), programId());
type ReviewRow = { as_of_date: string; verdict: string; reasons: string[]; opportunity_id: string | null };
const latestReview = async (loanId: string): Promise<ReviewRow> => { const r = (await db.query<ReviewRow>(`SELECT as_of_date::text AS as_of_date, verdict::text AS verdict, reasons, opportunity_id FROM partner_book_reviews WHERE loan_id = $1 ORDER BY as_of_date DESC, created_at DESC LIMIT 1`, [loanId]))[0]; assert.ok(r, `a review for ${loanId}`); return r; };
type AppRow = { id: string; status: string; prior_loan_id: string | null; loan_id: string | null };
const applicationsOf = async (loanId: string): Promise<AppRow[]> => db.query<AppRow>(`SELECT id::text AS id, status::text AS status, prior_loan_id::text AS prior_loan_id, loan_id::text AS loan_id FROM applications WHERE prior_loan_id = $1 ORDER BY created_at`, [loanId]);
const ui = (): PgBorrowerUiRepository => new PgBorrowerUiRepository(db);
const pipeline = async (s: Session): Promise<Reply> => api("GET", "/v1/partner/pipeline", undefined, bearer(s.token));
const detail = async (s: Session, loanId: string): Promise<Reply> => api("GET", `/v1/partner/pipeline/${loanId}`, undefined, bearer(s.token));
const eligibility = async (s: Session, q = ""): Promise<Reply> => api("GET", `/v1/partner/eligibility${q}`, undefined, bearer(s.token));
const itemOf = (r: Reply, loanId: string): Json => { const it = (r.body["items"] as Json[]).find((i) => i["loan_id"] === loanId); assert.ok(it, `an item for ${loanId}: ${JSON.stringify(r.body["items"]).slice(0, 300)}`); return it; };
const boardRow = async (s: Session, loanId: string): Promise<Json | null> => ((await eligibility(s)).body["loans"] as Json[]).find((l) => l["loan_id"] === loanId) ?? null;
/** The homeowner's sign-in by the e-mailed code (33.1's door) and the Yes on the OfferCard (32.2 offer.respond{decision=yes}) — 33-3.spec.test.ts's helpers. */
async function homeownerSignIn(email: string, ip: string): Promise<{ token: string; party_id: string }> {
  const req = await api("POST", "/v1/borrower/auth/otp", { action: "request", channel: "email", destination: email }, {}, ip); assert.equal(req.status, 200, JSON.stringify(req.body)); assert.equal(req.body["delivery"], "FAKE");
  const v = await api("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: req.body["challenge_id"], code: req.body["fake_code"] }, {}, ip); assert.equal(v.status, 200, JSON.stringify(v.body)); await settle();
  return { token: v.body["token"] as string, party_id: (v.body["party"] as Json)["party_id"] as string };
}
async function tapYes(token: string, card: CardInstanceRow, ip: string): Promise<Reply> { const r = await api("POST", `/v1/borrower/cards/${card.card_instance_id}/resolve`, { option_id: "yes", evidence: { option_id: "yes", tapped_at: clock.now() } }, bearer(token), ip); await settle(); return r; }

test("36.4-T1: Given a monitored loan with `refi_opportunities.status=offered`, then it appears on the pipeline as `offered` and also remains on Eligible now.", { skip }, async () => {
  const loan1 = await loanByNumber(1); const loan2 = await loanByNumber(2); const loan9 = await loanByNumber(9);
  // 33.2's pass delivered the offers of loans 1 and 2 (33.2-T1: offers_delivered 2): refi_opportunities.status = offered, refi.opportunity.offered on the log
  for (const l of [loan1, loan2]) { assert.equal((await entity("refi_opportunities", oppOf(l.id)))?.["status"], "offered", `${l.servicer_loan_number} offered`); assert.equal((await events("refi.opportunity.offered", l.id)).length, 1); }
  assert.equal((await entity("refi_opportunities", oppOf(loan9.id)))?.["status"], "suppressed", "loan 9 is watching: no offer, never on the feed (rule 1)");
  // the feed: one item per member in motion — loans 1 and 2 as `offered`, entered when the offer went out, 0 days in stage, the opportunity named; nobody else
  const r = await pipeline(nora); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 400)); assert.equal(r.body["partner_party_id"], partnerA);
  const items = r.body["items"] as Json[];
  assert.deepEqual(items.map((i) => i["loan_id"]).sort(), [loan1.id, loan2.id].sort(), "the two offered members and nobody else");
  for (const l of [loan1, loan2]) {
    const it = itemOf(r, l.id); const offered = (await events("refi.opportunity.offered", l.id))[0]!;
    assert.deepEqual([it["stage"], it["opportunity_id"], it["application_id"], it["days_in_stage"], it["servicer_loan_last4"]], ["offered", oppOf(l.id), undefined, 0, l.servicer_loan_number.slice(-4)]);
    assert.equal(it["entered_at"], iso(offered.occurred_at), "entered_at is refi.opportunity.offered's instant (rule 2)"); assert.equal(it["days_in_stage"], daysInStage(String(it["entered_at"]), clock.now()));
    assert.match(String((it["homeowner"] as Json)["legal_name"]), /^[^\s]+ [A-Z]\.$/, "the first name and last initial");
  }
  assert.equal(itemOf(r, loan1.id)["homeowner"] && (itemOf(r, loan1.id)["homeowner"] as Json)["legal_name"], "Maria G.");
  // newest entered_at first (the two went out on the same pass: the tie by the last four)
  assert.ok(items.every((it, i) => i === 0 || Date.parse(String(items[i - 1]!["entered_at"])) >= Date.parse(String(it["entered_at"]))));
  assertPartnerGrade(JSON.stringify(r.body), "the feed"); assertNoForbiddenKey(r.body, "the feed"); for (const it of items) assert.equal(it["servicer_loan_number"], undefined, "the last four only on the list");
  assert.ok((PIPELINE_STAGES as readonly string[]).includes("offered") && !(TERMINAL_STAGES as readonly string[]).includes("offered"));
  // …and also remains on Eligible now (rule 5; 33.2 rule 5 continues the open offer as candidate): the board lists both with bucket eligible_now and pipeline_stage offered
  const board = await eligibility(nora); assert.equal(board.status, 200);
  for (const l of [loan1, loan2]) { const row = (board.body["loans"] as Json[]).find((x) => x["loan_id"] === l.id); assert.ok(row); assert.deepEqual([row["bucket"], row["pipeline_stage"], (row["latest_review"] as Json)["verdict"]], ["eligible_now", "offered", "candidate"]); }
  assert.deepEqual(board.body["counts"], { eligible_now: 2, likely_soon: 7, not_near: 3, on_hold: 0 }, "the feed is not a fourth bucket: the counts are 36.3's");
  const row9 = (board.body["loans"] as Json[]).find((x) => x["loan_id"] === loan9.id)!; assert.deepEqual([row9["bucket"], row9["pipeline_stage"]], ["likely_soon", null]);
  // the detail: the strip with the one stage reached and the current one; a tenant loan with no motion answers an empty strip (it exists; it is on the board); 20.1's expiry clock shown, never armed here
  const d1 = await detail(nora, loan1.id); assert.equal(d1.status, 200, JSON.stringify(d1.body).slice(0, 400));
  assert.deepEqual((d1.body["stages"] as Json[]).map((s) => [s["stage"], s["opportunity_id"]]), [["offered", oppOf(loan1.id)]]); assert.equal((d1.body["current"] as Json)["stage"], "offered");
  const dl = d1.body["loan"] as Json; assert.deepEqual([dl["loan_id"], dl["servicer_loan_number"], dl["servicer_loan_last4"], dl["bucket"], dl["status"], (dl["homeowner"] as Json)["legal_name"]], [loan1.id, loan1.servicer_loan_number, "0001", "eligible_now", "monitored", "Maria G."]);
  assert.ok((d1.body["clocks"] as Json[]).some((c) => c["code"] === "SM_REFI_OPPORTUNITY_EXPIRY_30" && c["status"] === "armed"), "20.1's 30-day clock on the detail"); assertNoForbiddenKey(d1.body, "the detail");
  const d9 = await detail(nora, loan9.id); assert.equal(d9.status, 200); assert.deepEqual([d9.body["stages"], d9.body["current"], (d9.body["loan"] as Json)["bucket"]], [[], null, "likely_soon"]);
  // 36.1 rule 5: the looks are logged with the view; nothing of the homeowner on a row
  const viewed = await actions(`partner_user_id = $1 AND action = 'partner_portal.viewed' AND subject_kind IN ('pipeline', 'pipeline.loan')`, [noraId]);
  assert.deepEqual(viewed.map((a) => [a.subject_kind, a.subject_id, a.result]), [["pipeline", partnerA, "ok"], ["pipeline.loan", loan1.id, "ok"], ["pipeline.loan", loan9.id, "ok"]]); for (const a of viewed) assertPartnerGrade(a.row_text, "the log row");
  // rule 8: nothing is emitted from the feed
  assert.equal((await events("refi.opportunity.offered", loan1.id)).length, 1); assert.equal(await count(`loan_events WHERE occurred_at > $1::timestamptz AND type LIKE 'refi.%'`, [NOW]), 0);
});

test("36.4-T2: Given that homeowner’s Yes (`engaged`) and a 33.3 readiness row with missing items, then the pipeline stage is `readiness` and `missing` is the 33.3 item list.", { skip }, async () => {
  const loan1 = await loanByNumber(1); const party = await partyOfLoan(loan1.id); const oppId = oppOf(loan1.id);
  // the homeowner of loan 1 signs in through the borrower door and taps Yes on the OfferCard (33.3-T2): 20.1's engaged, 33.3's refi.open → converted, the application with prior_loan_id, the readiness row
  const maria = await homeownerSignIn(loanN(1).email!, "10.36.4.11"); assert.equal(maria.party_id, party.id);
  const offer = (await ui().cardsOf(party.id)).find((c) => c.kind === "OfferCard" && c.props["flow_key"] === `offer:${oppId}`); assert.ok(offer, "the OfferCard on the rail"); assert.equal(offer.status, "pending");
  const yes = await tapYes(maria.token, offer, "10.36.4.11"); assert.equal(yes.status, 201, JSON.stringify(yes.body).slice(0, 600));
  const engaged = await events("refi.opportunity.engaged", loan1.id); assert.equal(engaged.length, 1);
  const apps = await applicationsOf(loan1.id); assert.equal(apps.length, 1, "one refinance application with prior_loan_id = the loan"); const app = apps[0]!; assert.equal(app.loan_id, null);
  assert.equal((await entity("refi_opportunities", oppId))?.["status"], "converted"); const opened = await events("partner_book.refinance.opened", loan1.id); assert.equal(opened.length, 1); assert.equal(opened[0]!.application_id, app.id);
  const readiness = await readinessRead(runtime, loan1.id); assert.ok(readiness, "33.3's readiness row"); assert.equal(readiness.application_id, app.id); assert.equal(readiness.ready, false); assert.ok(readiness.missing.length > 0, "missing items");
  // the feed: loan 1's item is `readiness` with the application named; `missing` is 33.3's list, in 33.3's words, in the order asked (rule 6)
  const r = await pipeline(nora); const it = itemOf(r, loan1.id);
  assert.deepEqual([it["stage"], it["application_id"], it["opportunity_id"], it["days_in_stage"]], ["readiness", app.id, oppId, 0]);
  assert.deepEqual(it["missing"], readiness.missing, "the latest readiness_checks.missing for the application"); assert.deepEqual(it["missing"], ["identity", "ssn", "income", "assets", "esign", "credit_authorization", "credit"]);
  assert.equal(it["entered_at"], iso(opened[0]!.occurred_at), "entered_at is partner_book.refinance.opened's instant");
  // the detail's strip: offered → engaged → readiness, in time order, the current one carrying `missing`
  const d = await detail(nora, loan1.id); assert.equal(d.status, 200);
  assert.deepEqual((d.body["stages"] as Json[]).map((s) => s["stage"]), ["offered", "engaged", "readiness"]);
  const cur = d.body["current"] as Json; assert.equal(cur["stage"], "readiness"); assert.deepEqual(cur["missing"], readiness.missing); assert.equal(cur["application_id"], app.id);
  assert.equal((d.body["stages"] as Json[])[1]!["entered_at"], iso(engaged[0]!.occurred_at));
  assert.ok((d.body["stages"] as Json[]).every((s, i, all) => i === 0 || Date.parse(String(all[i - 1]!["entered_at"])) <= Date.parse(String(s["entered_at"]))), "time order");
  // nothing about the items beyond their names: no figure, no document, no ask (rule 6) — and nothing of the homeowner
  assert.doesNotMatch(JSON.stringify(it["missing"]), /\d|\$|verifications|card/); assertPartnerGrade(JSON.stringify(d.body), "the detail"); assertNoForbiddenKey(d.body, "the detail");
  // the member stays on the board (rule 5): Eligible now with pipeline_stage readiness; the page's bucket reads in_refinance and the banner In refinance (36.5 rules 4–5)
  const row = await boardRow(nora, loan1.id); assert.ok(row); assert.deepEqual([row["bucket"], row["pipeline_stage"], row["banner"]], ["eligible_now", "readiness", BANNER_IN_REFINANCE]);
  assert.deepEqual([(d.body["loan"] as Json)["bucket"], (d.body["loan"] as Json)["banner"]], ["in_refinance", "In refinance — origination in progress"]);
  // loan 2 (offered, no Yes) is still `offered`; the feed has exactly the two members
  assert.equal(itemOf(r, (await loanByNumber(2)).id)["stage"], "offered"); assert.equal((r.body["items"] as Json[]).length, 2);
  // the feed ordered nothing and asked for nothing (rule 8): no vendor order on the application from the partner's looks
  assert.equal((await appEvents(app.id, "credit.report.ordered")).length, 0); assert.equal((await appEvents(app.id, "verification.ordered")).length, 0);
});

test("36.4-T3: Given offer expiry via `expireOffers`, then the item’s current stage is `expired` and a subsequent 33.2 run is free to write `not_now` with cooldown.", { skip }, async () => {
  const loan2 = await loanByNumber(2); const oppId = oppOf(loan2.id);
  assert.equal((await entity("refi_opportunities", oppId))?.["status"], "offered"); assert.equal((await entity("refi_opportunities", oppId))?.["offer_valid_until"], "2026-10-15");
  // day 31: 33.2 rule 6's expireOffers runs 20.1's date rule on the open offer (the same function the pass calls)
  clock.set(NOW_31); await refresh();
  const expired = await expireOffers(runtime, clock.now());
  assert.ok(expired.expired_ids.includes(oppId), `loan 2's offer expired: ${JSON.stringify(expired)}`);
  assert.equal((await entity("refi_opportunities", oppId))?.["status"], "expired");
  const ev = (await events("refi.opportunity.expired", loan2.id)).filter((e) => e.payload["opportunity_id"] === oppId); assert.equal(ev.length, 1);
  // the item's current stage is `expired` — terminal, entered at the expiry's instant, still on the feed (Open question 1); the strip keeps offered → expired
  const r = await pipeline(nora); const it = itemOf(r, loan2.id);
  assert.deepEqual([it["stage"], it["opportunity_id"], it["entered_at"], it["days_in_stage"]], ["expired", oppId, iso(ev[0]!.occurred_at), 0]);
  const d = await detail(nora, loan2.id); assert.deepEqual((d.body["stages"] as Json[]).map((s) => s["stage"]), ["offered", "expired"]); assert.equal((d.body["current"] as Json)["stage"], "expired");
  assert.ok((d.body["clocks"] as Json[]).some((c) => c["code"] === "SM_REFI_OPPORTUNITY_EXPIRY_30"), "20.1's 30-day clock on the detail (the sweep's breach pass closes it; the feed never touches it)");
  // the board before the next review: the latest review (09-15) still reads candidate, so the loan sits on Eligible now with pipeline_stage expired — the bucket is the stored verdict, nothing else
  const before = await boardRow(nora, loan2.id); assert.ok(before); assert.deepEqual([before["bucket"], before["pipeline_stage"], (before["latest_review"] as Json)["as_of_date"]], ["eligible_now", "expired", AS_OF]);
  // a subsequent 33.2 run (the sweep of 10-16 07:05 ET: 20.1's run, then the review) is free: the expired offer is not continued — the day's row is the engine's own verdict under 20.1's gates, whatever it is
  const sweep = await runtime.sweep(); await settle();
  assert.ok(sweep.partner_book_review.ran, `the review ran: ${sweep.partner_book_review.reason}`); assert.equal(sweep.partner_book_review.as_of_date, AS_OF_31);
  const next = await latestReview(loan2.id); assert.equal(next.as_of_date, AS_OF_31, "the day's row for loan 2");
  assert.notEqual(next.opportunity_id, oppId, "the expired offer is not the day's opportunity: the review is free of it"); assert.ok(["candidate", "watching", "not_now", "excluded"].includes(next.verdict), next.verdict);
  if (next.verdict === "not_now") assert.ok(next.reasons.some((x) => ["cooldown", "expired", "frequency_cap"].includes(x)), `not_now with the gate's reason: ${JSON.stringify(next.reasons)}`);
  // the board follows the day's verdict (36.3 rule 1); the feed follows the rows: the item stays `expired` unless the engine fired and delivered again, in which case the newer motion is the item (rule 3)
  const after = await boardRow(nora, loan2.id); assert.ok(after); assert.equal(after["bucket"], bucketForVerdict(next.verdict)); assert.equal((after["latest_review"] as Json)["as_of_date"], AS_OF_31);
  const newOpp = next.opportunity_id ? await entity("refi_opportunities", next.opportunity_id) : null;
  const again = itemOf(await pipeline(nora), loan2.id); const d2 = await detail(nora, loan2.id); const strip = (d2.body["stages"] as Json[]).map((s) => s["stage"]);
  if (newOpp && newOpp["status"] === "offered") { assert.deepEqual([again["stage"], again["opportunity_id"], after["pipeline_stage"]], ["offered", next.opportunity_id, "offered"]); assert.deepEqual(strip, ["offered", "expired", "offered"], "the history whole, the newer motion the item"); }
  else { assert.deepEqual([again["stage"], again["opportunity_id"], after["pipeline_stage"]], ["expired", oppId, "expired"]); assert.deepEqual(strip, ["offered", "expired"]); assert.notEqual(after["bucket"], "eligible_now", "off Eligible now while the day's verdict is not candidate"); }
  assert.equal(await count(`partner_book_reviews WHERE loan_id = $1 AND as_of_date = $2`, [loan2.id, AS_OF_31]), 1);
  assert.ok(((d2.body["clocks"] as Json[]).find((c) => c["code"] === "SM_REFI_OPPORTUNITY_EXPIRY_30") ?? { status: "armed" })["status"] !== "armed", "after the sweep, 20.1's 30-day clock of the expired offer is closed (33.2-T6) — shown on the detail, never armed or satisfied here");
});

test("36.4-T4: Given a boarded new loan linked from the old monitored loan (35.10 / `prior_loan_id`), then the pipeline item is `boarded`, the old loan banner is paid off / refinanced, and the new loan banner is `Active — Supermortgage subservicing`.", { skip }, async () => {
  const loan1 = await loanByNumber(1); const app = (await applicationsOf(loan1.id)).find((a) => a.status !== "funded"); assert.ok(app, "loan 1's open refinance application (T2)");
  // funding day: 30.2 boards the new loan from the demo snapshot the lifecycle tests fund with (33.3-T6's path); the funding itself flips nothing on the prior loan (35.10-T8)
  clock.set(NOW_FUNDING); await refresh();
  const record = await runtime.applications.get(app.id); assert.ok(record);
  const funded = await fundApplication(runtime, app.id, demoSnapshot(record, { partner_name: DEMO_PARTNER.legal_name }), demoFunded(app.id), { kind: "agent", id: "funding" });
  assert.match(funded.status, /^boarded/, JSON.stringify(funded).slice(0, 600)); await settle();
  const afterFunding = (await applicationsOf(loan1.id)).find((a) => a.id === app.id)!; assert.equal(afterFunding.status, "funded"); const newLoanId = afterFunding.loan_id; assert.ok(newLoanId); assert.notEqual(newLoanId, loan1.id);
  assert.equal((await appEvents(app.id, "loan.boarded")).length, 1); assert.equal((await appEvents(app.id, "loan.funded")).length, 1);
  const newLoan = await loanRow(newLoanId); assert.deepEqual([newLoan.status, newLoan.origination_application_id], ["active", app.id], "the refinance is a serviced loan now, linked to the application");
  assert.equal((await loanRow(loan1.id)).status, "monitored", "the funding itself flips nothing (35.10-T8)");
  // 35.10's closeout in monitored_partner mode: the pass quotes the partner's payoff, the settlement statement's payoff line lands with funding.disbursement.confirmed, the pass settles and retires the prior loan (33.3-T6 / 35.10-T8)
  const pass1 = await closeoutPass(runtime, NOW_FUNDING, { logger: runtime.logger });
  const closeout = (await db.query<{ mode: string; step: string; partner_party_id: string; payoff_demand_id: string | null }>(`SELECT mode, step, partner_party_id::text AS partner_party_id, payoff_demand_id FROM refinance_closeouts WHERE application_id = $1`, [app.id]))[0];
  assert.ok(closeout, `the closeout opened: ${pass1.line}`); assert.equal(closeout.mode, "monitored_partner"); assert.equal(closeout.step, "quoted", pass1.line); assert.ok(closeout.payoff_demand_id);
  const demand = decodeEntityData((await db.query<{ data: Json }>(`SELECT data FROM entity_current WHERE kind = 'payoff_demands' AND id = $1`, [closeout.payoff_demand_id]))[0]!.data) as Json;
  const evidenceId = `doc-settlement-statement-${app.id}`;
  await new PgEntityRepository(db).save([{ kind: "documents", id: evidenceId, version: 1, updatedAt: NOW_FUNDING, updatedBy: "system:test", data: { application_id: app.id, kind: "settlement_statement", sha256: "fake", storage_uri: `fake://documents/${evidenceId}`, mime_type: "application/pdf", retention_class: "life_of_loan_plus_4y",
    metadata: { payoff_lines: [{ payoff_demand_id: closeout.payoff_demand_id, payee_party_id: closeout.partner_party_id, amount_cents: String(demand["total_cents"]), wire_reference: "FEDREF-36-4-T4" }] } } }], { applicationId: app.id });
  await runtime.uow.run({ applicationId: app.id }, (ctx) => ctx.events.append({ type: "funding.disbursement.confirmed", applicationId: app.id, aggregate: { kind: "application", id: app.id }, actor: { kind: "agent", id: "funder" }, payload: { application_id: app.id, evidence_document_id: evidenceId, disbursed_on: "2026-11-12", disbursement_date: "2026-11-12" } }), { clock });
  for (let i = 0; i < 3; i += 1) await closeoutPass(runtime, NOW_FUNDING, { logger: runtime.logger });
  const old = await loanRow(loan1.id);
  assert.deepEqual([old.status, old.refinanced_by_loan_id], ["paid_off", newLoanId], "the prior loan retired and linked (35.10 rule 7)");
  assert.equal((await events(LOAN_PAID_OFF_EVENT, loan1.id)).length, 1, "partner_book.loan.paid_off on the prior loan"); assert.equal((await events("refinance.prior_loan.retired", loan1.id)).length, 1);
  // the feed: loan 1's item is `boarded` — the new loan named, the application named; the strip runs offered → engaged → readiness → closing (loan.funded) → boarded (loan.boarded)
  const r = await pipeline(nora); assert.equal(r.status, 200); const it = itemOf(r, loan1.id);
  const boardedEv = (await appEvents(app.id, "loan.boarded"))[0]!;
  assert.deepEqual([it["stage"], it["application_id"], it["entered_at"], it["days_in_stage"], it["new_loan"]], ["boarded", app.id, iso(boardedEv.occurred_at), 0, { loan_id: newLoanId, status: "active" }]);
  const d = await detail(nora, loan1.id); assert.equal(d.status, 200, JSON.stringify(d.body).slice(0, 400));
  const strip = (d.body["stages"] as Json[]).map((s) => s["stage"]); assert.deepEqual(strip.slice(0, 3), ["offered", "engaged", "readiness"]); assert.deepEqual(strip.slice(-2), ["closing", "boarded"]);
  assert.equal((d.body["current"] as Json)["stage"], "boarded"); assert.deepEqual((d.body["current"] as Json)["new_loan"], { loan_id: newLoanId, status: "active" });
  assert.ok((d.body["clocks"] as Json[]).some((c) => c["code"] === "SM_REFI_PARTNER_CONFIRM_21"), "35.10's confirmation clock on the detail, never armed here");
  // the old loan's banner: paid off / refinanced — DELTA-03: `banner` null with status paid_off and refinanced_by_loan_id = the new loan (never a sentence minted here); bucket null (36.5 rule 5)
  const dl = d.body["loan"] as Json;
  assert.deepEqual([dl["status"], dl["banner"], dl["refinanced_by_loan_id"], dl["bucket"], dl["loan_id"]], ["paid_off", null, newLoanId, null, loan1.id]);
  assert.equal(bannerOf({ status: "paid_off", partner_legal_name: DEMO_PARTNER.legal_name, open_application: false, origination_application_id: null }), null);
  // the new loan's banner: Active — Supermortgage subservicing (36.5 rule 4, from loans.status = active and origination_application_id set)
  assert.equal(bannerOf({ status: newLoan.status, partner_legal_name: DEMO_PARTNER.legal_name, open_application: false, origination_application_id: newLoan.origination_application_id }), BANNER_ACTIVE);
  assert.equal(BANNER_ACTIVE, "Active — Supermortgage subservicing");
  // the new active loan is never on the board and has no place on the feed's paths (the item is the member's; 404); the prior loan leaves the board and its counts (36.3 rule 4)
  const board = await eligibility(nora); assert.ok(!(board.body["loans"] as Json[]).some((l) => l["loan_id"] === loan1.id || l["loan_id"] === newLoanId), "neither row on the board");
  const c = board.body["counts"] as Record<string, number>; assert.equal(c["eligible_now"]! + c["likely_soon"]! + c["not_near"]! + c["on_hold"]!, 11, "eleven monitored loans remain");
  const dn = await detail(nora, newLoanId); assert.equal(dn.status, 404, JSON.stringify(dn.body)); assert.equal(dn.body["code"], "NOT_FOUND");
  // the feed's item stays: one per member, `boarded` is the end of the feed, not a refusal (discrepancy 3); the feed wrote nothing of its own
  assert.equal((r.body["items"] as Json[]).filter((x) => x["loan_id"] === loan1.id).length, 1); assertPartnerGrade(JSON.stringify(d.body), "the detail"); assertNoForbiddenKey(d.body, "the detail");
  assert.equal(await count(`partner_actions WHERE action NOT IN ('partner_portal.viewed', 'partner_portal.door')`), 0, "no command from the partner prefix in this file");
});

test("36.4-T5: Partner B cannot see partner A’s pipeline items (404 / absent).", { skip }, async () => {
  const loan1 = await loanByNumber(1); const loan2 = await loanByNumber(2);
  await refresh();
  // partner B's admin: the feed lists partner B's members only — none of partner A's items, never a refusal beside an empty list
  const b = await pipeline(sam); assert.equal(b.status, 200, JSON.stringify(b.body).slice(0, 300)); assert.equal(b.body["partner_party_id"], partnerB); assert.equal(b.body["code"], undefined);
  const bItems = b.body["items"] as Json[]; assert.ok(bItems.every((i) => i["loan_id"] === loanOfB), `only partner B's own member could be on partner B's feed: ${JSON.stringify(bItems).slice(0, 200)}`);
  assert.ok(!bItems.some((i) => i["loan_id"] === loan1.id || i["loan_id"] === loan2.id), "partner A's items are absent");
  assert.doesNotMatch(JSON.stringify(b.body), /Maria|Garcia|James|Whitfield|Northlight/);
  // partner A's items on the detail path, as partner B: 404 NOT_FOUND — never 403, never a body that names the loan — logged refused with the requested id and no homeowner field (36.1 rule 4)
  for (const id of [loan1.id, loan2.id]) {
    const d = await detail(sam, id); assert.equal(d.status, 404, JSON.stringify(d.body)); assert.equal(d.body["code"], "NOT_FOUND"); assert.doesNotMatch(JSON.stringify(d.body), new RegExp(`${loan1.servicer_loan_number}|Maria|Garcia|James|Whitfield`));
    const rows = await actions(`partner_user_id = $1 AND subject_id = $2`, [sam.partner_user_id, id]); assert.equal(rows.length, 1);
    assert.deepEqual([rows[0]!.action, rows[0]!.subject_kind, rows[0]!.result, rows[0]!.refusal_code, rows[0]!.partner_party_id], ["partner_portal.viewed", "pipeline.loan", "refused", "NOT_FOUND", partnerB]); assertPartnerGrade(rows[0]!.row_text, "the refused log row");
  }
  assert.equal((await detail(sam, randomUUID())).status, 404); assert.equal((await detail(sam, "not-a-uuid")).status, 404);
  // and the other way: partner A's admin never sees partner B's loan on the feed or its detail path
  const a = await pipeline(nora); assert.equal(a.status, 200); assert.ok(!(a.body["items"] as Json[]).some((i) => i["loan_id"] === loanOfB)); assert.doesNotMatch(JSON.stringify(a.body), /Denise|Okoro|Second Servicer/);
  const cross = await detail(nora, loanOfB); assert.equal(cross.status, 404); assert.equal(cross.body["code"], "NOT_FOUND");
  // no 403 anywhere on the feed: a read is never refused for a role, and existence is not a signal
  assert.equal(await count(`partner_actions WHERE subject_kind IN ('pipeline', 'pipeline.loan') AND refusal_code = 'ROLE_REQUIRED'`), 0);
  assert.equal(await count(`partner_actions WHERE subject_kind = 'pipeline' AND result = 'refused'`), 0, "the list is never refused");
});
