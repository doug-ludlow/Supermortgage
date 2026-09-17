// 36.6 The post-refinance serviced pane contract: dark in V1, one refusal everywhere
// spec/sections/36-servicing-partner-portal/36-6-post-refinance-serviced-pane-contract.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// The harness is 36-4.spec.test.ts's (36-3's partner side over 33.2's review side, driven as 33-2.spec.test.ts drives it): own database
// `<base>_36_6`, the API server in-process with the partner prefix and the borrower router, the FAKE feed / officer / e-delivery, the
// scripted analyst, the 12-loan fixture and a second partner with one loan and its own partner_admin. T2's boarded refinance is driven
// through the owners' own functions and doors exactly as 36-4-T4 drives it — the homeowner's Yes on the OfferCard through the borrower
// API, 30.2's funding from the demo snapshot and 35.10's closeout pass — never a status written by raw SQL. T3 reads the registry and
// the spec file: the contract introduces nothing the audit could count but its three tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
import { LOAN_PAID_OFF_EVENT } from "../../runtime/borrower/flows/16-readiness.ts";
import { closeoutPass } from "../../runtime/refinance-closeout.ts";
import { demoFunded, demoSnapshot, fundApplication } from "../../runtime/origination.ts";
import { seedEntryDemo } from "../../runtime/entry-seed.ts";
import { seedPartnerPortalDemo, DEMO_PARTNER_ADMIN_EMAIL } from "../../runtime/partner-portal/seed.ts";
import { ALL_TOOLS } from "../../app/tools/index.ts";
import { scriptedClient, type Scene } from "../borrower/eval/scripted-client.ts";
import { BANNER_ACTIVE, bannerMonitored } from "./buckets.ts";
import { SERVICED_MODULES, SERVICED_PANE_CODE, SERVICED_PANE_STATUS, SERVICED_READ_SECTIONS, SERVICED_REFUSAL, SERVICED_TAB, SERVICED_TAB_COPY, paneLights, servicedFieldOf } from "./serviced.ts";

const { url: DB_URL, skip } = await testDatabase(import.meta.url);
const TOKEN = "ops-" + randomUUID();
const R = randomUUID().slice(0, 8);
type Json = Record<string, unknown>;
/** The first review day: 2026-09-15 07:05 America/New_York (33-2.spec.test.ts's instant). */
const AS_OF = "2026-09-15"; const NOW = "2026-09-15T11:05:00.000Z";
/** Funding day (30.2's demo fixture: the rescission expired 2026-11-11, disbursement 2026-11-12) — 33-3.spec.test.ts T6's instant. */
const NOW_FUNDING = "2026-11-12T18:40:00.000Z";
const clock = new FixedClock(NOW);
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

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

// ---------------------------------------------------------------- helpers over the API (36.1's / 33.3's)
type Reply = { status: number; body: Json; headers: Headers; text: string };
async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, ip = "10.36.6.1"): Promise<Reply> {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-forwarded-for": ip, "user-agent": "36.6-spec", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text(); const json = (r.headers.get("content-type") ?? "").includes("application/json");
  return { status: r.status, body: text && json ? (JSON.parse(text) as Json) : {}, headers: r.headers, text };
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
type LoanRow = { id: string; servicer_loan_number: string; status: string; refinanced_by_loan_id: string | null; origination_application_id: string | null };
const loanRow = async (id: string): Promise<LoanRow> => { const l = (await db.query<LoanRow>(`SELECT id::text AS id, servicer_loan_number, status::text AS status, refinanced_by_loan_id::text AS refinanced_by_loan_id, origination_application_id::text AS origination_application_id FROM loans WHERE id = $1`, [id]))[0]; assert.ok(l, `loan ${id}`); return l; };
const loanByNumber = async (n: number): Promise<LoanRow> => { const l = (await db.query<LoanRow>(`SELECT id::text AS id, servicer_loan_number, status::text AS status, refinanced_by_loan_id::text AS refinanced_by_loan_id, origination_application_id::text AS origination_application_id FROM loans WHERE partner_party_id = $1 AND servicer_loan_number = $2`, [partnerA, loanN(n).servicer_loan_number]))[0]; assert.ok(l, `loan ${n} on the book`); return l; };
type PartyRow = { id: string; legal_name: string; contact: Json };
const partyOfLoan = async (loanId: string): Promise<PartyRow> => { const r = (await db.query<PartyRow>(`SELECT p.id::text AS id, p.legal_name, p.contact FROM loan_borrowers lb JOIN borrowers b ON b.id = lb.borrower_id JOIN parties p ON p.id = b.party_id WHERE lb.loan_id = $1 ORDER BY lb.is_primary DESC LIMIT 1`, [loanId]))[0]; assert.ok(r, "the loan's party"); return r; };
type EventRow = { id: string; type: string; loan_id: string | null; payload: Json; occurred_at: string };
const events = async (type: string, loanId?: string): Promise<EventRow[]> => db.query<EventRow>(`SELECT id::text AS id, type, loan_id::text AS loan_id, payload, occurred_at::text AS occurred_at FROM loan_events WHERE type = $1 AND ($2::uuid IS NULL OR loan_id = $2::uuid) ORDER BY sequence`, [type, loanId ?? null]);
const programId = (): string => `prog-refi-${partnerA.slice(0, 8)}`;
const oppOf = (loanId: string, asOf = AS_OF): string => opportunityIdFor(loanId, plainDate(asOf), programId());
type AppRow = { id: string; status: string; prior_loan_id: string | null; loan_id: string | null };
const applicationsOf = async (loanId: string): Promise<AppRow[]> => db.query<AppRow>(`SELECT id::text AS id, status::text AS status, prior_loan_id::text AS prior_loan_id, loan_id::text AS loan_id FROM applications WHERE prior_loan_id = $1 ORDER BY created_at`, [loanId]);
const ui = (): PgBorrowerUiRepository => new PgBorrowerUiRepository(db);
const serviced = async (s: Session, loanId: string, sub = ""): Promise<Reply> => api("GET", `/v1/partner/loans/${loanId}/serviced${sub}`, undefined, bearer(s.token));
const page = async (s: Session, loanId: string): Promise<Reply> => api("GET", `/v1/partner/loans/${loanId}`, undefined, bearer(s.token));
/** The homeowner's sign-in by the e-mailed code (33.1's door) and the Yes on the OfferCard (32.2 offer.respond{decision=yes}) — 33-3.spec.test.ts's helpers. */
async function homeownerSignIn(email: string, ip: string): Promise<{ token: string; party_id: string }> {
  const req = await api("POST", "/v1/borrower/auth/otp", { action: "request", channel: "email", destination: email }, {}, ip); assert.equal(req.status, 200, JSON.stringify(req.body)); assert.equal(req.body["delivery"], "FAKE");
  const v = await api("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: req.body["challenge_id"], code: req.body["fake_code"] }, {}, ip); assert.equal(v.status, 200, JSON.stringify(v.body)); await settle();
  return { token: v.body["token"] as string, party_id: (v.body["party"] as Json)["party_id"] as string };
}
async function tapYes(token: string, card: CardInstanceRow, ip: string): Promise<Reply> { const r = await api("POST", `/v1/borrower/cards/${card.card_instance_id}/resolve`, { option_id: "yes", evidence: { option_id: "yes", tapped_at: clock.now() } }, bearer(token), ip); await settle(); return r; }
/** Rule 1's one answer, on the wire: 409, the body `{ available: false, code: "SERVICED_PANE_NOT_BUILT" }` and nothing else. */
const assertDark = (r: Reply, what: string): void => { assert.equal(r.status, 409, `${what}: ${JSON.stringify(r.body)}`); assert.deepEqual(r.body, { available: false, code: "SERVICED_PANE_NOT_BUILT" }, what); assert.equal(r.body["code"], SERVICED_PANE_CODE); assert.equal(SERVICED_PANE_STATUS, 409); };
/** The paths beneath the route V2 will name for its modules (Open question 1) — every one answers the same code before it is named. */
const MODULE_PATHS = ["/payments", "/escrow", "/insurance", "/delinquency", "/loss-mitigation", "/remittance", "/custodial", "/notices", "/qc", "/payoff", "/payments/history?from=2026-01-01", "/anything/v2/has/not/named"];

test("36.6-T1: Given a monitored loan, `GET /v1/partner/loans/:id/serviced` is `409 SERVICED_PANE_NOT_BUILT`.", { skip }, async () => {
  const loan9 = await loanByNumber(9); const loan1 = await loanByNumber(1); const loan11 = await loanByNumber(11);
  assert.deepEqual([loan9.status, loan1.status, loan11.status], ["monitored", "monitored", "monitored"]);
  // rule 1: the one code on the route, for a watching, a candidate (offered) and an excluded loan alike — 409, never 404 for the tenant's own loan (rule 6: existence is not a signal, but the loan exists here), never 501, never an empty 200
  for (const l of [loan9, loan1, loan11]) assertDark(await serviced(nora, l.id), `loan ${l.servicer_loan_number}`);
  // …and every path beneath it (Edge cases: a path V2 has not named answers the same as the route) — no per-module variant
  for (const sub of MODULE_PATHS) assertDark(await serviced(nora, loan9.id, sub), `beneath: ${sub}`);
  // the loan page's `serviced` field carries the same object (36.5 rule 8) and the page's banner stays Monitored; the Serviced tab is visible, disabled, rule 4's copy
  const p = await page(nora, loan9.id); assert.equal(p.status, 200);
  assert.deepEqual(p.body["serviced"], { ...SERVICED_REFUSAL }); assert.deepEqual(p.body["serviced"], { available: false, code: "SERVICED_PANE_NOT_BUILT" }); assert.equal(p.body["banner"], bannerMonitored(DEMO_PARTNER.legal_name));
  assert.deepEqual(p.body["serviced_tab"], { visible: true, disabled: true, copy: SERVICED_TAB_COPY }); assert.deepEqual({ ...SERVICED_TAB }, { visible: true, disabled: true, copy: SERVICED_TAB_COPY });
  assert.equal(SERVICED_TAB_COPY, "Serviced pane not built (V1). When Supermortgage subservices the refinanced loan, its payment, escrow, insurance, delinquency, remittance, custodial, notice, QC and payoff detail will appear here.");
  assert.doesNotMatch(SERVICED_TAB_COPY, /\$|%|\d\.\d|\d{2,}|offer|apply|rate/i, "no figure, no chart, no placeholder, no Supermortgage product or funnel on the tab (GLBA)");
  assert.deepEqual(servicedFieldOf("monitored"), SERVICED_REFUSAL); assert.equal(paneLights({ status: "monitored", origination_application_id: null }), false, "rule 3: a monitored row never lights, in any version");
  // rule 6: the tenant rule first — another tenant's loan, an unknown id and a malformed id are 404 NOT_FOUND before any 409; the answer names nothing of the row
  for (const [what, id] of [["partner B's loan", loanOfB], ["an unknown id", randomUUID()], ["a malformed id", "not-a-uuid"]] as const) { const r = await serviced(nora, id); assert.equal(r.status, 404, what); assert.equal(r.body["code"], "NOT_FOUND", what); assert.equal(r.body["available"], undefined, what); assert.doesNotMatch(JSON.stringify(r.body), /Denise|Okoro|NL-200007/); }
  const crossBeneath = await serviced(nora, loanOfB, "/payments"); assert.equal(crossBeneath.status, 404);
  const own = await serviced(sam, loanOfB); assertDark(own, "partner B's own loan, as partner B"); assert.equal((await serviced(sam, loan9.id)).status, 404, "partner A's loan, as partner B");
  // Edge cases: a POST, PUT or DELETE on the route or beneath it is not routed — the wrapper's ordinary answer for a route that does not exist; the machine token and a staff header open nothing (36.1 rule 7)
  for (const method of ["POST", "PUT", "DELETE"]) { const r = await api(method, `/v1/partner/loans/${loan9.id}/serviced`, method === "DELETE" ? undefined : { amount_cents: "100" }, bearer(nora.token)); assert.equal(r.status, 404, method); assert.equal(r.body["code"], "NOT_FOUND"); assert.equal(r.body["available"], undefined); }
  assert.equal((await api("POST", `/v1/partner/loans/${loan9.id}/serviced/payments`, { amount_cents: "100" }, bearer(nora.token))).status, 404);
  assert.equal((await api("GET", `/v1/partner/loans/${loan9.id}/serviced`, undefined, { ...bearer(TOKEN), "x-actor-id": "u-ops", "x-actor-role": "ops_analyst", "x-staff-role": "admin" })).status, 401, "the machine token and the header actor open nothing on the partner prefix");
  // 36.1 rule 5: one row per call, `partner_portal.viewed` with view `serviced`, the loan id, result refused, refusal_code SERVICED_PANE_NOT_BUILT (or NOT_FOUND across the tenant line); no PII on any row
  const rows = await actions(`partner_user_id = $1 AND subject_kind = 'serviced'`, [noraId]);
  assert.equal(rows.length, 3 + MODULE_PATHS.length + 3 + 1, "one row per GET on the route and beneath it, the three tenant refusals included");
  assert.ok(rows.filter((a) => a.subject_id === loan9.id).every((a) => a.action === "partner_portal.viewed" && a.result === "refused" && a.refusal_code === "SERVICED_PANE_NOT_BUILT" && a.role === "partner_admin" && a.partner_party_id === partnerA));
  assert.equal(rows.filter((a) => a.refusal_code === "SERVICED_PANE_NOT_BUILT").length, 3 + MODULE_PATHS.length); assert.equal(rows.filter((a) => a.refusal_code === "NOT_FOUND").length, 4);
  assert.ok(rows.some((a) => a.subject_id === loanOfB && a.refusal_code === "NOT_FOUND")); for (const a of rows) assertPartnerGrade(a.row_text, "the log row");
  // rule 3 / LOAN_MONITORED: nothing of sections 2–19 on the monitored row — no ledger line, no servicing clock, no statement, no notice of theirs; the pane read none of it and wrote nothing
  assert.equal(await count(`ledger_entry_sets WHERE loan_id = $1`, [loan9.id]), 0, "no ledger entry set on a monitored row"); assert.equal(await count(`timers WHERE loan_id = $1 AND code NOT LIKE 'SM_PARTNER_BOOK_%' AND code NOT LIKE 'SM_REFI_%'`, [loan9.id]), 0);
  assert.equal(await count(`loan_events WHERE loan_id = $1 AND occurred_at > $2::timestamptz`, [loan9.id, NOW]), 0, "no event of its own"); assert.equal(await count(`partner_actions WHERE action NOT IN ('partner_portal.viewed', 'partner_portal.door')`), 0, "no command from the partner prefix");
});

test("36.6-T2: Given an `active` boarded loan for this partner, the same endpoint is still `409 SERVICED_PANE_NOT_BUILT` in V1, and the loan page banner is already `Active`.", { skip }, async () => {
  const loan1 = await loanByNumber(1); const party = await partyOfLoan(loan1.id); const oppId = oppOf(loan1.id);
  // the homeowner's Yes (36.4-T2's harness), then funding day: 30.2 boards the new loan from the demo snapshot and 35.10's closeout in monitored_partner mode retires the prior loan (36.4-T4's harness, verbatim)
  const maria = await homeownerSignIn(loanN(1).email!, "10.36.6.11"); assert.equal(maria.party_id, party.id);
  const offer = (await ui().cardsOf(party.id)).find((c) => c.kind === "OfferCard" && c.props["flow_key"] === `offer:${oppId}`); assert.ok(offer, "the OfferCard on the rail");
  const yes = await tapYes(maria.token, offer, "10.36.6.11"); assert.equal(yes.status, 201, JSON.stringify(yes.body).slice(0, 600));
  const app = (await applicationsOf(loan1.id))[0]!; assert.ok(app, "the refinance application with prior_loan_id = the loan");
  assertDark(await serviced(nora, loan1.id), "in refinance: still monitored, still dark");
  clock.set(NOW_FUNDING); await refresh();
  const record = await runtime.applications.get(app.id); assert.ok(record);
  const funded = await fundApplication(runtime, app.id, demoSnapshot(record, { partner_name: DEMO_PARTNER.legal_name }), demoFunded(app.id), { kind: "agent", id: "funding" });
  assert.match(funded.status, /^boarded/, JSON.stringify(funded).slice(0, 600)); await settle();
  const newLoanId = (await applicationsOf(loan1.id)).find((a) => a.id === app.id)!.loan_id!; assert.ok(newLoanId); assert.notEqual(newLoanId, loan1.id);
  const newLoan = await loanRow(newLoanId); assert.deepEqual([newLoan.status, newLoan.origination_application_id], ["active", app.id], "the boarded new loan: active, linked to the application (30.2)");
  assert.equal((await db.query<{ p: string | null }>(`SELECT partner_party_id::text AS p FROM loans WHERE id = $1`, [newLoanId]))[0]!.p, partnerA, "…and this partner's");
  assert.ok((await count(`loan_terms WHERE loan_id = $1`, [newLoanId])) >= 1, "sections 2–19 already run on it (30.2's terms row)");
  const pass1 = await closeoutPass(runtime, NOW_FUNDING, { logger: runtime.logger });
  const closeout = (await db.query<{ mode: string; step: string; partner_party_id: string; payoff_demand_id: string | null }>(`SELECT mode, step, partner_party_id::text AS partner_party_id, payoff_demand_id FROM refinance_closeouts WHERE application_id = $1`, [app.id]))[0];
  assert.ok(closeout, `the closeout opened: ${pass1.line}`); assert.equal(closeout.mode, "monitored_partner"); assert.ok(closeout.payoff_demand_id);
  const demand = decodeEntityData((await db.query<{ data: Json }>(`SELECT data FROM entity_current WHERE kind = 'payoff_demands' AND id = $1`, [closeout.payoff_demand_id]))[0]!.data) as Json;
  const evidenceId = `doc-settlement-statement-${app.id}`;
  await new PgEntityRepository(db).save([{ kind: "documents", id: evidenceId, version: 1, updatedAt: NOW_FUNDING, updatedBy: "system:test", data: { application_id: app.id, kind: "settlement_statement", sha256: "fake", storage_uri: `fake://documents/${evidenceId}`, mime_type: "application/pdf", retention_class: "life_of_loan_plus_4y",
    metadata: { payoff_lines: [{ payoff_demand_id: closeout.payoff_demand_id, payee_party_id: closeout.partner_party_id, amount_cents: String(demand["total_cents"]), wire_reference: "FEDREF-36-6-T2" }] } } }], { applicationId: app.id });
  await runtime.uow.run({ applicationId: app.id }, (ctx) => ctx.events.append({ type: "funding.disbursement.confirmed", applicationId: app.id, aggregate: { kind: "application", id: app.id }, actor: { kind: "agent", id: "funder" }, payload: { application_id: app.id, evidence_document_id: evidenceId, disbursed_on: "2026-11-12", disbursement_date: "2026-11-12" } }), { clock });
  for (let i = 0; i < 3; i += 1) await closeoutPass(runtime, NOW_FUNDING, { logger: runtime.logger });
  const old = await loanRow(loan1.id); assert.deepEqual([old.status, old.refinanced_by_loan_id], ["paid_off", newLoanId]); assert.equal((await events(LOAN_PAID_OFF_EVENT, loan1.id)).length, 1);
  // the same endpoint on the active boarded loan: still 409 SERVICED_PANE_NOT_BUILT in V1 (rule 3's attach condition is true on the row — read, not branched on — and no module is built), on the route and beneath it
  assert.equal(paneLights(newLoan), true, "V2's attach condition holds on the row (active, origination_application_id set)…");
  assertDark(await serviced(nora, newLoanId), "…and V1 still answers the one code"); for (const sub of MODULE_PATHS) assertDark(await serviced(nora, newLoanId, sub), `beneath, on the active loan: ${sub}`);
  // …and the loan page banner is already Active (36.5 rule 4), its `serviced` field the same object, its tab disabled; no figure of the serviced loan on the page
  const p = await page(nora, newLoanId); assert.equal(p.status, 200, JSON.stringify(p.body).slice(0, 400));
  assert.equal(p.body["banner"], "Active — Supermortgage subservicing"); assert.equal(p.body["banner"], BANNER_ACTIVE); assert.deepEqual(p.body["serviced"], { available: false, code: "SERVICED_PANE_NOT_BUILT" }); assert.equal(p.body["bucket"], "serviced");
  assert.deepEqual(p.body["serviced_tab"], { visible: true, disabled: true, copy: SERVICED_TAB_COPY }); assert.deepEqual([(p.body["loan"] as Json)["upb_cents"], (p.body["loan"] as Json)["pi_cents"], (p.body["loan"] as Json)["next_due_date"], p.body["reviews"], p.body["offers"]], [null, null, null, [], []]);
  assert.doesNotMatch(JSON.stringify({ ...p.body, serviced_tab: undefined }), /ledger|escrow|insurance|delinquen|remittance|custodial|payoff|statement/i, "no module of sections 2–19 on the page, not even empty (the tab's copy names them only to say they are not here)");
  // the retired prior loan: 409 too (Edge cases), its page's serviced field null (36.5 rule 8), its tab disabled like every other
  assertDark(await serviced(nora, loan1.id), "the retired prior loan"); const po = await page(nora, loan1.id); assert.deepEqual([po.body["serviced"], po.body["banner"], (po.body["loan"] as Json)["status"], (po.body["serviced_tab"] as Json)["disabled"]], [null, null, "paid_off", true]);
  assert.equal(servicedFieldOf("paid_off"), null); assert.deepEqual(servicedFieldOf("active"), SERVICED_REFUSAL);
  // the tenant rule on the new loan: partner B is 404 first
  assert.equal((await serviced(sam, newLoanId)).status, 404); assert.equal((await serviced(sam, newLoanId, "/payments")).status, 404);
  // the log: the active loan's refusals with the one code; nothing written by the pane — no event, no ledger line, no clock of its own on the active loan beyond what 30.2 seeded before the first call
  const rows = await actions(`partner_user_id = $1 AND subject_id = $2 AND subject_kind = 'serviced'`, [noraId, newLoanId]); assert.equal(rows.length, 1 + MODULE_PATHS.length); for (const a of rows) { assert.deepEqual([a.result, a.refusal_code], ["refused", "SERVICED_PANE_NOT_BUILT"]); assertPartnerGrade(a.row_text, "the log row"); }
  const eventsAfterBoard = await count(`loan_events WHERE loan_id = $1 AND occurred_at > $2::timestamptz`, [newLoanId, NOW_FUNDING]); assert.equal(eventsAfterBoard, 0, "the pane emitted nothing on the active loan");
  assert.equal(await count(`partner_actions WHERE action NOT IN ('partner_portal.viewed', 'partner_portal.door')`), 0, "no command from the partner prefix in this file");
});

test("36.6-T3: 36.6 introduces **no** new money field, timer, or notice.", async () => {
  // the registry (what npm run audit counts): 36.6's units are its three tests — no table, no timer, no notice, no tool (rule 5)
  const manifest = JSON.parse(readFileSync(`${ROOT}spec/registry/manifest.json`, "utf8")) as Json[];
  const p = manifest.find((x) => x["process"] === "36.6"); assert.ok(p, "36.6 in the manifest");
  assert.deepEqual([p["tables"], p["timers"], p["notices"], p["tools"]], [[], [], [], []]); assert.equal((p["tids"] as Json[]).length, 3);
  const timers = JSON.parse(readFileSync(`${ROOT}spec/registry/timers.json`, "utf8")) as unknown; const notices = JSON.parse(readFileSync(`${ROOT}spec/registry/notices.json`, "utf8")) as unknown;
  const mentions = (v: unknown): number => (JSON.stringify(v).match(/"36\.6"/g) ?? []).length;
  assert.equal(mentions(timers), 0, "no timer row owned by or referring to 36.6"); assert.equal(mentions(notices), 0, "no notice owned by or referring to 36.6");
  // the spec file: the Timers row is `none`, the timer table has no row, the Data model says none, and no money figure sits under Business rules (the audit's worked-figure form `$1,234.56`)
  const spec = readFileSync(`${ROOT}spec/sections/36-servicing-partner-portal/36-6-post-refinance-serviced-pane-contract.md`, "utf8");
  assert.match(spec, /\| Timers \| none \|/); assert.match(spec, /#### Data model\nNew tables: none/);
  const timerTable = /#### Timers and gates\n\| Timer code[^\n]*\n\|[-| ]+\n((?:\|[^\n]*\n)*)/.exec(spec); assert.ok(timerTable); assert.equal(timerTable[1]!.trim(), "", "no timer row");
  const rules = /#### Business rules(.*?)\n#### /s.exec(spec)![1]!; assert.doesNotMatch(rules, /\$[\d,]{1,12}\.\d{2}/, "no worked figure"); assert.match(rules, /No money figure is computed here\./); assert.match(rules, /NTC_|notice/i, "the word appears only to say none is introduced");
  assert.doesNotMatch(rules, /NTC_[A-Z_]+/, "no notice code named as the process's own"); assert.doesNotMatch(rules, /\bSM_[A-Z0-9_]+\b/, "no timer code named as the process's own");
  // the code: no migration, no tool file, no bus tool, no timers-36-6 override, no money field — the contract module reads nothing and holds a code, a table of modules and a piece of copy
  const migrations = readdirSync(`${ROOT}db/migrations`); assert.ok(!migrations.some((f) => /36[-_]?6|serviced/i.test(f)), "no migration for 36.6");
  const toolFiles = readdirSync(`${ROOT}src/app/tools`); assert.ok(!toolFiles.some((f) => /section36-[56]/.test(f)), "no tool file for 36.5 or 36.6");
  assert.ok(!ALL_TOOLS.some((t) => (t as { process?: string }).process === "36.6" || (t as { process?: string }).process === "36.5"), "nothing of 36.6 on the bus");
  assert.ok(!readdirSync(`${ROOT}src/domain/servicing-partner-portal`).some((f) => /^timers-36/.test(f)), "no timer override in the section");
  const source = readFileSync(`${ROOT}src/domain/servicing-partner-portal/serviced.ts`, "utf8");
  assert.doesNotMatch(source, /^import /m, "the contract imports nothing — no ledger, no money, no clock"); assert.doesNotMatch(source, /\b(bigint|BigInt|Decimal|\w+_cents\b|armTimer|Timer\(|NoticeService|NTC_[A-Z]|SM_[A-Z0-9_]+)\b/, "no money field, no timer, no notice in the contract (the module table names sections in prose only)");
  // the contract itself: the one code, the ten modules and the eleven sections they will read and never write (rule 2), the attach condition (rule 3), the copy (rule 4)
  assert.equal(SERVICED_PANE_CODE, "SERVICED_PANE_NOT_BUILT"); assert.equal(SERVICED_PANE_STATUS, 409); assert.deepEqual({ ...SERVICED_REFUSAL }, { available: false, code: "SERVICED_PANE_NOT_BUILT" });
  assert.equal(SERVICED_MODULES.length, 10); assert.deepEqual(SERVICED_MODULES.map((m) => m.module), ["Payment history / next due", "Escrow", "Insurance / flood / lender-placed", "Delinquency / early intervention", "Loss mitigation", "Investor remittance / LAR", "Custodial P&I and T&I", "Notices", "QC exceptions", "Payoff"]);
  assert.deepEqual([...SERVICED_READ_SECTIONS], [2, 3, 5, 6, 7, 9, 10, 11, 12, 16, 18]); for (const m of SERVICED_MODULES) assert.match(m.reads, /^§\d+/);
  assert.deepEqual([paneLights({ status: "active", origination_application_id: "app" }), paneLights({ status: "active", origination_application_id: null }), paneLights({ status: "monitored", origination_application_id: "app" }), paneLights({ status: "paid_off", origination_application_id: null })], [true, false, false, false]);
  assert.deepEqual([servicedFieldOf("monitored"), servicedFieldOf("active"), servicedFieldOf("paid_off"), servicedFieldOf("transferred_out")], [SERVICED_REFUSAL, SERVICED_REFUSAL, null, null]);
  assert.equal(Object.isFrozen(SERVICED_REFUSAL), true); assert.equal(Object.isFrozen(SERVICED_MODULES), true);
});
