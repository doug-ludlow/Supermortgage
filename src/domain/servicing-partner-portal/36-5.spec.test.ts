// 36.5 Home, the daily report and the two-mode loan page
// spec/sections/36-servicing-partner-portal/36-5-partner-home-reports-two-mode-loan-page.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// The harness is 36-4.spec.test.ts's (36-3's partner side over 33.2's review side, driven as 33-2.spec.test.ts drives it): own database
// `<base>_36_5`, the API server in-process with the partner prefix and the borrower router, the FAKE feed / officer / e-delivery, the
// scripted analyst, the 12-loan fixture and a second partner with one loan and its own partner_admin; a third partner with no book for
// the empty Home. The day's passes run on runtime.sweep(): at 07:05 ET 20.1's run, 33.2's review and the offers (T1's counts), at 07:20 ET
// 33.3's readiness pass and 34.3's daily-report hook (T2's row — produced by the sweep, never by the partner). The motion is driven through
// the owners' own functions and doors exactly as 36-4 drives it — the homeowner's Yes on the OfferCard through the borrower API, 30.2's
// funding from the demo snapshot and 35.10's closeout pass (T4's boarded refinance) — never a status written by raw SQL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connect, type Db } from "../../infra/db/client.ts";
import { testDatabase } from "../../infra/db/test-db.ts";
import { PgEntityRepository, decodeEntityData } from "../../infra/db/entities.ts";
import { PgBorrowerUiRepository, type CardInstanceRow } from "../../infra/db/borrower-ui.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock } from "../../kernel/events/index.ts";
import { addDays, plainDate } from "../../kernel/calendar/date.ts";
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
import { importPartnerBook, partnerBookStatus } from "../../runtime/partner-book.ts";
import { opportunityIdFor, reviewTokenValues, type ReviewFacts } from "../../runtime/partner-book-review.ts";
import { readinessRead } from "../../runtime/partner-book-readiness.ts";
import { bookDailyReport, latestDailyReport, listDailyReports, renderDailyReport } from "../../runtime/book-ops/report.ts";
import { LOAN_PAID_OFF_EVENT } from "../../runtime/borrower/flows/16-readiness.ts";
import { closeoutPass } from "../../runtime/refinance-closeout.ts";
import { demoFunded, demoSnapshot, fundApplication } from "../../runtime/origination.ts";
import { seedEntryDemo } from "../../runtime/entry-seed.ts";
import { seedPartnerPortalDemo, DEMO_PARTNER_ADMIN_EMAIL } from "../../runtime/partner-portal/seed.ts";
import { BOOK_COPY } from "../../runtime/partner-portal/book.ts";
import { dailyReportCsv, renderRationale } from "../../runtime/partner-portal/home.ts";
import { scriptedClient, type Scene } from "../borrower/eval/scripted-client.ts";
import { BANNER_ACTIVE, BANNER_IN_REFINANCE, bannerMonitored } from "./buckets.ts";
import { isInFlightStage } from "./pipeline.ts";
import { SERVICED_PANE_CODE, SERVICED_REFUSAL, SERVICED_TAB_COPY } from "./serviced.ts";

const { url: DB_URL, skip } = await testDatabase(import.meta.url);
const TOKEN = "ops-" + randomUUID();
const R = randomUUID().slice(0, 8);
type Json = Record<string, unknown>;
/** The first review day: 2026-09-15 07:05 America/New_York (33-2.spec.test.ts's instant) — after 20.1's 06:30 run and 33.2's 07:00 pass, before 33.3's 07:15 readiness pass. */
const AS_OF = "2026-09-15"; const NOW = "2026-09-15T11:05:00.000Z";
/** 07:20 ET the same day (34-3.spec.test.ts's instant): past 33.3's 07:15 pass, so the sweep's daily-report hook produces the day's row. */
const NOW_REPORT = "2026-09-15T11:20:00.000Z";
/** Funding day (30.2's demo fixture: the rescission expired 2026-11-11, disbursement 2026-11-12) — 33-3.spec.test.ts T6's instant. */
const NOW_FUNDING = "2026-11-12T18:40:00.000Z";
const clock = new FixedClock(NOW);

// the scripted analyst (33.2 rule 4): 33-3.spec.test.ts's three scenes — every figure a {{facts.<key>}} token
const CLEAN_RATIONALE = "Your rate today is {{facts.rate_now}} and this morning's sheet shows {{facts.candidate_rate}}, which lowers the payment by {{facts.monthly_delta}}. The offer is on the card here.";
const WATCHING_RATIONALE = "Rates are not below yours yet; the book is checked every morning.";
const OTHER_RATIONALE = "The loan is out of today's review because of what is on the partner's file; nothing is offered.";
const ANALYST_CANDIDATE: Scene = { when: /verdict is candidate/, calls: [{ name: "review.facts", input: {} }, { name: "review.write", input: { rationale: CLEAN_RATIONALE, flags: [] } }], text: "Written." };
const ANALYST_WATCHING: Scene = { when: /verdict is watching/, calls: [{ name: "review.facts", input: {} }, { name: "review.write", input: { rationale: WATCHING_RATIONALE, flags: [] } }], text: "Written." };
const ANALYST_OTHER: Scene = { when: /verdict is (excluded|not_now)/, calls: [{ name: "review.facts", input: {} }, { name: "review.write", input: { rationale: OTHER_RATIONALE, flags: [] } }], text: "Written." };
const analystScripted = scriptedClient([ANALYST_CANDIDATE, ANALYST_WATCHING, ANALYST_OTHER]);

// the people: the seeded partner_admin of the demo partner, the partner_ops and partner_auditor she invites, the second partner's admin, the empty partner's admin
const NORA = { email: DEMO_PARTNER_ADMIN_EMAIL, name: "Nora Northlight", password: `nora-northlight-admin-${R}` };
const OLI = { email: `oli.ops.${R}@northlight.example`, name: "Oli Operations", password: `oli-partner-ops-pass-${R}` };
const AUD = { email: `aud.auditor.${R}@northlight.example`, name: "Audrey Auditor", password: `audrey-auditor-pass-${R}` };
const SAM = { email: `sam.second.${R}@second-servicer.example`, name: "Sam Second", password: `sam-second-admin-pass-${R}` };
const EMMA = { email: `emma.empty.${R}@empty-servicer.example`, name: "Emma Empty", password: `emma-empty-admin-pass-${R}` };
type Session = { token: string; session_id: string; partner_user_id: string; partner_party_id: string; role: string; body: Json };
let nora: Session; let sam: Session; let emma: Session; let oli: Session | null = null; let aud: Session | null = null; let noraId = "";
let partnerA = ""; let partnerB = ""; let partnerC = ""; let loanOfB = "";
const DENISE = { name: "Denise Okoro", email: `denise.okoro.${R}@example.test`, phone: "+16025550177", number: "NL-200007" };
const PARTNER_B = { legal_name: `Second Servicer (FAKE partner) ${R}`, nmlsr_id: "7654321", servicer_number: "300054321" };
const PARTNER_C = { legal_name: `Empty Servicer (FAKE partner) ${R}`, nmlsr_id: "7777777", servicer_number: "300077777", mers_org_id: "1000777" };
/** The new loan 30.2 boards in T4 and its application, read by T5. */
let newLoanId = ""; let refiApplicationId = "";

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
  // the third partner: a parties{servicer} row with its partner_admin and NO book (Edge cases: "No import yet")
  partnerC = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id, contact) VALUES ('servicer', $1, $2, $3, $4::jsonb) RETURNING id`, [PARTNER_C.legal_name, PARTNER_C.servicer_number, PARTNER_C.mers_org_id, JSON.stringify({ phone: "+18005550177", nmlsr_id: PARTNER_C.nmlsr_id })]))[0]!.id;
  const seedC = await seedPartnerPortalDemo(runtime, { partner_id: partnerC, email: EMMA.email, name: EMMA.name }); assert.equal(seedC.created, true);
  router = createBorrowerRouter({ runtime, logger, environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost", "http://127.0.0.1"], urlSecret: "test-secret", defaultPartnerId: partnerA });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger, borrowerRouter: router, borrower: { environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost"], urlSecret: "test-secret" } });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => { router.hub.close(); server.closeAllConnections?.(); server.close(() => db.end().then(() => resolve())); });
  // the 33.2 daily run: 20.1's run → the review → offer delivery (loans 1 and 2 by e-mail); the FAKE MLO's terms review on the second sweep puts the OfferCard on the rail (32.11)
  await settle();
  const sweep = await runtime.sweep(); await settle();
  assert.ok(sweep.refi?.ran, `the refinance check ran: ${sweep.refi?.reason}`); assert.ok(sweep.partner_book_review.ran, `the review ran: ${sweep.partner_book_review.reason}`);
  assert.equal(sweep.partner_book_readiness.ran, false, "07:05 ET: 33.3's 07:15 pass has not run — no daily report yet");
  await runtime.sweep(); await settle();
  await enrol(NORA); nora = await signIn(NORA); await enrol(SAM); sam = await signIn(SAM); await enrol(EMMA); emma = await signIn(EMMA);
});
test.after(async () => { if (!skip) { await router.flows?.settle(); await close(); } });

// ---------------------------------------------------------------- helpers over the API (36.1's / 36.2's / 33.3's)
type Reply = { status: number; body: Json; headers: Headers; text: string };
async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, ip = "10.36.5.1"): Promise<Reply> {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-forwarded-for": ip, "user-agent": "36.5-spec", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
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
/** 36.1 rule 8 / 36-2's helper: a partner_admin invites a colleague through the partner prefix; the invitee enrols and signs in. */
async function invitedSession(admin: Session, p: { email: string; name: string; password: string }, roles: string[]): Promise<Session> {
  const r = await api("POST", "/v1/partner/users/invite", { email: p.email, name: p.name, roles }, bearer(admin.token));
  assert.equal(r.status, 200, JSON.stringify(r.body)); await enrol(p); return signIn(p);
}
/** 36.1 rule 6: a session ends 12 hours after it opened — every jump of the clock past that reopens the doors. */
async function refresh(): Promise<void> { nora = await signIn(NORA); sam = await signIn(SAM); emma = await signIn(EMMA); if (oli) oli = await signIn(OLI); if (aud) aud = await signIn(AUD); }
/** 36-2's helper: the partner's drop as the Book page sends it (multipart with the files and `as_of_date`). */
async function drop(session: Session, i: { as_of_date: string; tape: Uint8Array; supplement?: Uint8Array | string | null }): Promise<Reply> {
  const fd = new FormData(); fd.set("as_of_date", i.as_of_date); fd.set("tape", new Blob([i.tape]), "partner-book.xlsx"); if (i.supplement) fd.set("supplement", new Blob([i.supplement]), "partner-book-supplement.csv");
  const r = await fetch(`${base}/v1/partner/book/imports`, { method: "POST", headers: { ...bearer(session.token), "x-forwarded-for": "10.36.5.1", "user-agent": "36.5-spec" }, body: fd });
  const text = await r.text(); return { status: r.status, body: text ? (JSON.parse(text) as Json) : {}, headers: r.headers, text };
}
const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, params))[0]!.n);
type ActionRow = { id: string; partner_user_id: string | null; partner_party_id: string | null; role: string | null; action: string; subject_kind: string | null; subject_id: string | null; result: string; refusal_code: string | null; row_text: string };
const actions = async (where: string, params: unknown[] = []): Promise<ActionRow[]> => db.query<ActionRow>(`SELECT id::text AS id, partner_user_id::text AS partner_user_id, partner_party_id::text AS partner_party_id, role, action, subject_kind, subject_id, result, refusal_code, partner_actions::text AS row_text FROM partner_actions WHERE ${where} ORDER BY at, id`, params);
const PII = (): string[] => [...book.loans.flatMap((l) => [l.name, l.last_name, l.email, l.phone, l.supplement_email, l.supplement_phone, String(l.tape["property_address"]), String(l.tape["property_zip"])]), DENISE.name, "Okoro", DENISE.email, DENISE.phone].filter((x): x is string => typeof x === "string" && x.length > 2);
const assertPartnerGrade = (text: string, what: string): void => { for (const p of PII()) assert.ok(!text.includes(p), `${what} carries homeowner data: ${p}`); assert.doesNotMatch(text, /@|\+1\d{10}/, `${what} carries an e-mail address or a phone`); };
/** Rule 7 / rule 10: no key of a score, DTI, ZIP, street, investor column, SSN, TIN or DOB anywhere on the page; the masked contact (admin / ops only) is checked apart. */
const FORBIDDEN_KEY = /fico|score|dti|zip|postal|address|street|county|city|investor|agency|remittance|mers|net_rate|retained|ssn|tin\b|dob|birth|raw/i;
/** Rule 9: no Pay, Escrow, Draft, Statement, ACH, Payoff-request, Resolve, Exclude, Message or Re-offer control — no key of any such name, at any depth. */
const CONTROL_KEY = /^(pay|payment|escrow|draft|ach|statement|payoff|payoff_request|resolve|resolution|exclude|message|send|re_?offer|controls?|actions?|buttons?|commands?)$/i;
const keysOf = (v: unknown, path = ""): string[] => (v && typeof v === "object" ? Object.entries(v as Json).flatMap(([k, x]) => [Array.isArray(v) ? path : `${path}.${k}`, ...keysOf(x, Array.isArray(v) ? path : `${path}.${k}`)]) : []);
const assertNoForbiddenKey = (body: unknown, what: string): void => { for (const k of new Set(keysOf(body))) { const leaf = k.split(".").at(-1) ?? ""; assert.doesNotMatch(leaf, FORBIDDEN_KEY, `${what} carries the key ${k}`); assert.doesNotMatch(leaf, CONTROL_KEY, `${what} carries a control: ${k}`); } };
/** The page without its masked contact (admin / ops see `m…@` and `···0101`, never the raw destination), for the PII assertion on the rest. */
/** Every leaf value of the body (a string, number, boolean or null), for the value-level PII assertions — a three-digit figure compared as a whole value, never as a substring of the JSON (an id can carry any three digits by chance). */
const leafValuesOf = (v: unknown): unknown[] => (Array.isArray(v) ? v.flatMap(leafValuesOf) : v && typeof v === "object" ? Object.values(v as Record<string, unknown>).flatMap(leafValuesOf) : [v]);
const withoutMaskedContact = (body: Json): Json => { const loan = { ...(body["loan"] as Json) }; const h = { ...(loan["homeowner"] as Json) }; delete h["email_masked"]; delete h["phone_masked"]; loan["homeowner"] = h; return { ...body, loan }; };
type LoanRow = { id: string; servicer_loan_number: string; status: string; refinanced_by_loan_id: string | null; origination_application_id: string | null };
const loanRow = async (id: string): Promise<LoanRow> => { const l = (await db.query<LoanRow>(`SELECT id::text AS id, servicer_loan_number, status::text AS status, refinanced_by_loan_id::text AS refinanced_by_loan_id, origination_application_id::text AS origination_application_id FROM loans WHERE id = $1`, [id]))[0]; assert.ok(l, `loan ${id}`); return l; };
const loanByNumber = async (n: number): Promise<LoanRow> => { const l = (await db.query<LoanRow>(`SELECT id::text AS id, servicer_loan_number, status::text AS status, refinanced_by_loan_id::text AS refinanced_by_loan_id, origination_application_id::text AS origination_application_id FROM loans WHERE partner_party_id = $1 AND servicer_loan_number = $2`, [partnerA, loanN(n).servicer_loan_number]))[0]; assert.ok(l, `loan ${n} on the book`); return l; };
type PartyRow = { id: string; legal_name: string; contact: Json };
const partyOfLoan = async (loanId: string): Promise<PartyRow> => { const r = (await db.query<PartyRow>(`SELECT p.id::text AS id, p.legal_name, p.contact FROM loan_borrowers lb JOIN borrowers b ON b.id = lb.borrower_id JOIN parties p ON p.id = b.party_id WHERE lb.loan_id = $1 ORDER BY lb.is_primary DESC LIMIT 1`, [loanId]))[0]; assert.ok(r, "the loan's party"); return r; };
type EventRow = { id: string; type: string; loan_id: string | null; application_id: string | null; actor_id: string; payload: Json; occurred_at: string };
const events = async (type: string, loanId?: string): Promise<EventRow[]> => db.query<EventRow>(`SELECT id::text AS id, type, loan_id::text AS loan_id, application_id::text AS application_id, actor_id, payload, occurred_at::text AS occurred_at FROM loan_events WHERE type = $1 AND ($2::uuid IS NULL OR loan_id = $2::uuid) ORDER BY sequence`, [type, loanId ?? null]);
const iso = (s: string): string => new Date(s).toISOString();
const entity = async (kind: string, id: string): Promise<Json | null> => { const r = (await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = $1 AND id = $2`, [kind, id]))[0]; return r ? decodeEntityData(r.data) as Json : null; };
const programId = (): string => `prog-refi-${partnerA.slice(0, 8)}`;
const oppOf = (loanId: string, asOf = AS_OF): string => opportunityIdFor(loanId, plainDate(asOf), programId());
type ReviewRow = { as_of_date: string; verdict: string; reasons: string[]; facts: Json; analyst: Json; opportunity_id: string | null };
const latestReview = async (loanId: string): Promise<ReviewRow> => { const r = (await db.query<ReviewRow>(`SELECT as_of_date::text AS as_of_date, verdict::text AS verdict, reasons, facts, analyst, opportunity_id FROM partner_book_reviews WHERE loan_id = $1 ORDER BY as_of_date DESC, created_at DESC LIMIT 1`, [loanId]))[0]; assert.ok(r, `a review for ${loanId}`); return r; };
type AppRow = { id: string; status: string; prior_loan_id: string | null; loan_id: string | null };
const applicationsOf = async (loanId: string): Promise<AppRow[]> => db.query<AppRow>(`SELECT id::text AS id, status::text AS status, prior_loan_id::text AS prior_loan_id, loan_id::text AS loan_id FROM applications WHERE prior_loan_id = $1 ORDER BY created_at`, [loanId]);
const ui = (): PgBorrowerUiRepository => new PgBorrowerUiRepository(db);
const home = async (s: Session, q = ""): Promise<Reply> => api("GET", `/v1/partner/home${q}`, undefined, bearer(s.token));
const eligibility = async (s: Session, q = ""): Promise<Reply> => api("GET", `/v1/partner/eligibility${q}`, undefined, bearer(s.token));
const pipeline = async (s: Session): Promise<Reply> => api("GET", "/v1/partner/pipeline", undefined, bearer(s.token));
const reports = async (s: Session, q = ""): Promise<Reply> => api("GET", `/v1/partner/reports/daily${q}`, undefined, bearer(s.token));
const exportReport = async (s: Session, q: string): Promise<Reply> => api("GET", `/v1/partner/reports/daily/export${q}`, undefined, bearer(s.token));
const page = async (s: Session, loanId: string, q = ""): Promise<Reply> => api("GET", `/v1/partner/loans/${loanId}${q}`, undefined, bearer(s.token));
/** The homeowner's sign-in by the e-mailed code (33.1's door) and the Yes on the OfferCard (32.2 offer.respond{decision=yes}) — 33-3.spec.test.ts's helpers. */
async function homeownerSignIn(email: string, ip: string): Promise<{ token: string; party_id: string }> {
  const req = await api("POST", "/v1/borrower/auth/otp", { action: "request", channel: "email", destination: email }, {}, ip); assert.equal(req.status, 200, JSON.stringify(req.body)); assert.equal(req.body["delivery"], "FAKE");
  const v = await api("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: req.body["challenge_id"], code: req.body["fake_code"] }, {}, ip); assert.equal(v.status, 200, JSON.stringify(v.body)); await settle();
  return { token: v.body["token"] as string, party_id: (v.body["party"] as Json)["party_id"] as string };
}
async function tapYes(token: string, card: CardInstanceRow, ip: string): Promise<Reply> { const r = await api("POST", `/v1/borrower/cards/${card.card_instance_id}/resolve`, { option_id: "yes", evidence: { option_id: "yes", tapped_at: clock.now() } }, bearer(token), ip); await settle(); return r; }

test("36.5-T1: Home counts equal 36.3 counts + 36.4 in-flight for the same `as_of`.", { skip }, async () => {
  const h = await home(nora); assert.equal(h.status, 200, JSON.stringify(h.body).slice(0, 600));
  const board = await eligibility(nora); assert.equal(board.status, 200); const feed = await pipeline(nora); assert.equal(feed.status, 200);
  // the same as_of: Home carries 36.3's board date (discrepancy 1) — the latest review's day
  assert.equal(h.body["as_of_date"], AS_OF); assert.equal(board.body["as_of_date"], AS_OF); assert.equal(h.body["partner_party_id"], partnerA); assert.equal(h.body["acted_as"], "partner_admin");
  // the eligibility line is 36.3's counts, figure for figure (rule 1): worked example A's 2 / 7 / 3 on the first review; the held count is the book line's
  const counts = board.body["counts"] as Record<string, number>;
  assert.deepEqual(h.body["eligibility"], { eligible_now: counts["eligible_now"], likely_soon: counts["likely_soon"], not_near: counts["not_near"] });
  assert.deepEqual(h.body["eligibility"], { eligible_now: 2, likely_soon: 7, not_near: 3 });
  // the pipeline line is 36.4's: in_flight = the items whose current stage is neither terminal nor boarded (loans 1 and 2, offered); boarded this month: none
  const items = feed.body["items"] as Json[]; const inFlight = items.filter((i) => isInFlightStage(String(i["stage"]))).length;
  assert.deepEqual(h.body["pipeline"], { in_flight: inFlight, boarded_mtd: 0 }); assert.equal(inFlight, 2, "the two offered members");
  // counts + in-flight for the same as_of: every monitored loan is in exactly one bucket or on Holds, and the members in flight are also on the board (36.3 rule 4; 36.4 rule 5)
  const e = h.body["eligibility"] as Record<string, number>; const b = h.body["book"] as Json;
  assert.equal(e["eligible_now"]! + e["likely_soon"]! + e["not_near"]! + Number(b["on_hold"]), 12); assert.equal(b["loans_monitored"], 12); assert.equal(b["on_hold"], counts["on_hold"]);
  assert.ok(items.every((i) => (board.body["loans"] as Json[]).some((l) => l["loan_id"] === i["loan_id"])), "the members in flight are on the board too — the feed is not a fourth bucket");
  // the book line is 33.1's status for the tenant (partnerBookStatus): the last as-of date, the next expected on SM_PARTNER_BOOK_TAPE_EXPECTED_7 (+7 calendar days), its late state — read back, never recomputed here
  const status = (await partnerBookStatus(runtime, clock.now())).find((p) => p.partner_party_id === partnerA)!; assert.ok(status);
  assert.deepEqual([b["last_as_of"], b["next_tape_due"], b["late"], b["imports"]], [status.as_of_date, status.next_expected, status.late, status.imports]);
  assert.deepEqual([b["last_as_of"], b["next_tape_due"]], [DEMO_AS_OF, String(addDays(plainDate(DEMO_AS_OF), 7))]); assert.equal(b["late"], true, "2026-09-15 is past 2026-09-08: the next tape is late (the badge)");
  const line = await api("GET", "/v1/partner/book/status", undefined, bearer(nora.token)); assert.deepEqual([line.body["as_of_date"], line.body["next_expected"], line.body["late"], line.body["on_hold"]], [b["last_as_of"], b["next_tape_due"], b["late"], b["on_hold"]], "the same line 36.2's status route answers");
  // the partner on the page: the tenant's legal name and NMLSR id (GLBA — never a Supermortgage name); no report yet at 07:05 (33.3's pass has not run)
  assert.deepEqual(h.body["partner"], { legal_name: DEMO_PARTNER.legal_name, nmlsr_id: DEMO_PARTNER.nmlsr_id }); assert.doesNotMatch(JSON.stringify(h.body["partner"]), /Supermortgage/);
  assert.equal(h.body["latest_report_id"], null); assert.equal(h.body["empty"], false); assert.equal(h.body["copy"], BOOK_COPY.upload);
  assertPartnerGrade(JSON.stringify(h.body), "Home"); assertNoForbiddenKey(h.body, "Home");
  // the tenant rule: partner B's Home counts partner B's one loan and nothing of partner A's
  const hb = await home(sam); assert.equal(hb.status, 200); const eb = hb.body["eligibility"] as Record<string, number>; const bb = hb.body["book"] as Json;
  assert.equal(eb["eligible_now"]! + eb["likely_soon"]! + eb["not_near"]! + Number(bb["on_hold"]), 1); assert.equal(bb["loans_monitored"], 1); assert.deepEqual(hb.body["pipeline"], { in_flight: 0, boarded_mtd: 0 }); assert.equal((hb.body["partner"] as Json)["legal_name"], PARTNER_B.legal_name);
  // before the first import (Edge cases): every count 0, the dates null, no report, and the page says "Upload a tape to open the book."
  const hc = await home(emma); assert.equal(hc.status, 200, JSON.stringify(hc.body));
  assert.deepEqual(hc.body["book"], { loans_monitored: 0, on_hold: 0, last_as_of: null, next_tape_due: null, late: false, imports: 0 }); assert.deepEqual(hc.body["eligibility"], { eligible_now: 0, likely_soon: 0, not_near: 0 }); assert.deepEqual(hc.body["pipeline"], { in_flight: 0, boarded_mtd: 0 });
  assert.deepEqual([hc.body["as_of_date"], hc.body["latest_report_id"], hc.body["empty"], hc.body["copy"]], [null, null, true, "Upload a tape to open the book."]); assert.equal((hc.body["partner"] as Json)["legal_name"], PARTNER_C.legal_name);
  // 36.1 rule 5: each look is one row with the view `home`, the tenant as the subject, the role; nothing of a homeowner
  const viewed = await actions(`action = 'partner_portal.viewed' AND subject_kind = 'home'`);
  assert.deepEqual(viewed.map((a) => [a.partner_user_id, a.subject_id, a.role, a.result]), [[noraId, partnerA, "partner_admin", "ok"], [sam.partner_user_id, partnerB, "partner_admin", "ok"], [emma.partner_user_id, partnerC, "partner_admin", "ok"]]);
  for (const a of viewed) assertPartnerGrade(a.row_text, "the log row");
  // Home wrote nothing: no report row, no review, no event of its own
  assert.equal(await count(`partner_book_daily_reports`), 0); assert.equal(await count(`loan_events WHERE occurred_at > $1::timestamptz`, [NOW]), 0);
});

test("36.5-T2: Daily report for the partner matches 34.3 `bookDailyReport` for that `partner_party_id` (same ids, same counts). No other partner’s report is listed.", { skip }, async () => {
  // 07:20 ET: 33.3's readiness pass, then 34.3's daily-report hook — the row is produced by the sweep after 33.3's pass, never by the partner (rule 2, Open question 3)
  clock.set(NOW_REPORT); await refresh();
  assert.equal((await reports(nora, `?as_of=${AS_OF}`)).status, 404, "before the sweep reaches the day: 404, not a trigger");
  const sweep = await runtime.sweep(); await settle();
  assert.ok(sweep.partner_book_readiness.ran, `the readiness pass ran: ${sweep.partner_book_readiness.skipped}`); assert.ok(sweep.partner_book_daily_reports, "the daily-report hook ran");
  assert.ok(sweep.partner_book_daily_reports.produced >= 1, JSON.stringify(sweep.partner_book_daily_reports));
  // 34.3's row for the tenant and the day: bookDailyReport answers the stored row (idempotent — nothing new is appended) and the partner's read is the same row
  const staff = await bookDailyReport(runtime, { partner: partnerA, as_of: AS_OF }); assert.equal(staff.produced, false, "the sweep's row stands; the read appends nothing");
  const stored = await latestDailyReport(runtime, partnerA, AS_OF); assert.ok(stored); assert.equal(stored.id, staff.report.id); assert.equal(stored.produced_by, "sweep");
  const r = await reports(nora, `?as_of=${AS_OF}`); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 600));
  assert.equal(r.body["id"], staff.report.id, "the same id"); assert.equal(r.body["partner_party_id"], partnerA); assert.equal(r.body["as_of_date"], AS_OF); assert.equal(r.body["partner_legal_name"], DEMO_PARTNER.legal_name);
  assert.deepEqual(r.body["review"], JSON.parse(JSON.stringify(staff.report.review)), "the same review counts and the fair-lending extract id"); assert.deepEqual(r.body["readiness"], JSON.parse(JSON.stringify(staff.report.readiness))); assert.deepEqual(r.body["book"], JSON.parse(JSON.stringify(staff.report.book)));
  assert.deepEqual([r.body["decision_id"], r.body["document_id"], r.body["produced_by"], r.body["created_at"]], [staff.report.decision_id, null, "sweep", staff.report.created_at]); assert.ok(r.body["decision_id"], "34.3's decision on the row");
  const review = r.body["review"] as Json; const bk = r.body["book"] as Json;
  assert.deepEqual([review["reviewed"], review["candidates"], review["watching"], review["excluded"], review["offers_delivered"]], [12, 2, 7, 3, 2], "the receipt's counts: 33.2-T1's day on the 12-loan fixture");
  assert.deepEqual([bk["loans_monitored"], bk["last_as_of_date"], bk["next_expected"]], [12, DEMO_AS_OF, String(addDays(plainDate(DEMO_AS_OF), 7))]);
  // the list without as_of: the tenant's rows newest first — the same ids 34.3 lists for the partner, and no other partner's row
  const list = await reports(nora); assert.equal(list.status, 200); const rows = list.body["reports"] as Json[];
  assert.deepEqual(rows.map((x) => x["id"]), (await listDailyReports(runtime, partnerA)).map((x) => x.id)); assert.ok(rows.length >= 1); assert.ok(rows.every((x) => x["partner_party_id"] === partnerA));
  const bRows = await db.query<{ id: string }>(`SELECT id::text AS id FROM partner_book_daily_reports WHERE partner_party_id = $1`, [partnerB]);
  assert.ok(bRows.length >= 1, "partner B has its own row (the sweep produces one per partner with a book)"); assert.ok(!rows.some((x) => bRows.some((y) => y.id === x["id"])), "partner B's row is not listed"); assert.doesNotMatch(JSON.stringify(list.body), new RegExp(`${partnerB}|Second Servicer`));
  // partner B's admin reads partner B's row and none of partner A's; the empty partner lists nothing
  const bl = await reports(sam); assert.equal(bl.status, 200); assert.ok((bl.body["reports"] as Json[]).every((x) => x["partner_party_id"] === partnerB)); assert.ok(!(bl.body["reports"] as Json[]).some((x) => x["id"] === staff.report.id));
  const bd = await reports(sam, `?as_of=${AS_OF}`); assert.equal(bd.status, 200); assert.notEqual(bd.body["id"], staff.report.id); assert.equal(bd.body["partner_party_id"], partnerB);
  const cl = await reports(emma); assert.equal(cl.status, 200); assert.deepEqual(cl.body["reports"], []); assert.equal((await reports(emma, `?as_of=${AS_OF}`)).status, 404);
  // a day with no row: 404 NOT_FOUND (the same answer another tenant's day gets); a malformed date: 400
  const none = await reports(nora, "?as_of=2026-09-14"); assert.equal(none.status, 404); assert.equal(none.body["code"], "NOT_FOUND"); assert.equal((await reports(nora, "?as_of=yesterday")).status, 400);
  // rule 3: the export is the stored row as a file — its JSON is 34.3's own document text (hash for hash what compliance exports), the CSV its counts; no documents row, no newer report row, no PII
  const before = await count(`partner_book_daily_reports`); const docsBefore = await count(`documents`);
  const xj = await exportReport(nora, `?as_of=${AS_OF}`); assert.equal(xj.status, 200, xj.text.slice(0, 300));
  assert.match(xj.headers.get("content-type") ?? "", /^application\/json/); assert.match(xj.headers.get("content-disposition") ?? "", new RegExp(`attachment; filename="daily-report-${AS_OF}.json"`));
  assert.equal(xj.text, renderDailyReport(stored)); assert.equal((JSON.parse(xj.text) as Json)["as_of_date"], AS_OF);
  const xc = await exportReport(nora, `?as_of=${AS_OF}&format=csv`); assert.equal(xc.status, 200); assert.match(xc.headers.get("content-type") ?? "", /^text\/csv/); assert.equal(xc.text, dailyReportCsv(stored));
  const [header, values] = xc.text.trim().split("\n"); assert.ok(header!.startsWith("report_id,partner_party_id,")); assert.equal(header!.split(",").length, values!.split(",").length); assert.ok(values!.startsWith(`${staff.report.id},`));
  for (const k of ["reviewed", "candidates", "watching", "not_now", "excluded", "readiness_checked", "loans_monitored", "on_hold", "fair_lending_extract_id"]) assert.ok(header!.split(",").includes(k), `the CSV carries ${k}`);
  assert.equal(await count(`partner_book_daily_reports`), before, "no newer report row"); assert.equal(await count(`documents`), docsBefore, "no documents row (34.3's hashed export stays compliance's on /ops)");
  assertPartnerGrade(xj.text, "the export"); assertPartnerGrade(JSON.stringify(r.body), "the report");
  assert.equal((await exportReport(nora, "?as_of=2026-09-14")).status, 404); assert.equal((await exportReport(nora, "")).status, 400); assert.equal((await exportReport(sam, `?as_of=${AS_OF}`)).text.includes(staff.report.id), false, "partner B's export is partner B's row");
  // Edge cases: a partner_ops-only session opens Reports → 403 ROLE_REQUIRED{role: partner_auditor, act_as: []} before any read; Home and the loan page still open
  oli = await invitedSession(nora, OLI, ["partner_ops"]); assert.equal(oli.role, "partner_ops");
  for (const q of ["", `?as_of=${AS_OF}`]) { const denied = await reports(oli, q); assert.equal(denied.status, 403, JSON.stringify(denied.body)); assert.deepEqual([denied.body["code"], denied.body["role"], denied.body["held"], denied.body["act_as"]], ["ROLE_REQUIRED", "partner_auditor", ["partner_ops"], []]); assert.equal(denied.body["id"], undefined, "nothing of the row on the refusal"); }
  const deniedExport = await exportReport(oli, `?as_of=${AS_OF}`); assert.equal(deniedExport.status, 403); assert.equal(deniedExport.body["code"], "ROLE_REQUIRED");
  assert.equal((await home(oli)).status, 200); assert.equal((await page(oli, (await loanByNumber(9)).id)).status, 200);
  // Home now links the newest row
  const h = await home(nora); assert.equal(h.body["latest_report_id"], staff.report.id); assert.equal(h.body["latest_report_as_of"], AS_OF);
  // 36.1 rule 5: the looks on the log — `report` with the report id, `reports` for the list, `report.export` with the report id; the refused ones with their code; no PII
  const mine = await actions(`partner_user_id = $1 AND subject_kind IN ('report', 'reports', 'report.export')`, [noraId]);
  assert.ok(mine.some((a) => a.subject_kind === "report" && a.subject_id === staff.report.id && a.result === "ok" && a.role === "partner_admin"));
  assert.ok(mine.some((a) => a.subject_kind === "reports" && a.subject_id === partnerA && a.result === "ok")); assert.ok(mine.filter((a) => a.subject_kind === "report.export" && a.subject_id === staff.report.id && a.result === "ok").length >= 2);
  assert.ok(mine.some((a) => a.subject_kind === "report" && a.result === "refused" && a.refusal_code === "NOT_FOUND"));
  const denied = await actions(`partner_user_id = $1 AND subject_kind IN ('report', 'report.export') AND result = 'refused'`, [oli.partner_user_id]); assert.equal(denied.length, 3); for (const a of denied) assert.equal(a.refusal_code, "ROLE_REQUIRED");
  for (const a of [...mine, ...denied]) assertPartnerGrade(a.row_text, "the log row");
});

test("36.5-T3: Loan page for a monitored loan shows banner `Monitored — {partner} remains servicer`, no Pay control, and `serviced.available === false`.", { skip }, async () => {
  const loan9 = await loanByNumber(9); const loan1 = await loanByNumber(1); const loan11 = await loanByNumber(11); const turnsBefore = await count(`agent_turns`);
  // loan 9 (watching at 5.625, 33.2-T3): the monitored mode — the banner with the tenant's legal name, the page's bucket, no stage, the row in full for the partner_admin, the review with the analyst's words, the dark serviced field
  const p9 = await page(nora, loan9.id); assert.equal(p9.status, 200, JSON.stringify(p9.body).slice(0, 600));
  assert.equal(p9.body["banner"], `Monitored — ${DEMO_PARTNER.legal_name} remains servicer`); assert.equal(p9.body["banner"], bannerMonitored(DEMO_PARTNER.legal_name)); assert.equal(p9.body["banner"], "Monitored — Northlight Mortgage Servicing (FAKE partner) remains servicer");
  assert.deepEqual([p9.body["bucket"], p9.body["pipeline_stage"], p9.body["loan_id"], p9.body["partner_party_id"], p9.body["acted_as"]], ["likely_soon", null, loan9.id, partnerA, "partner_admin"]);
  const l9 = p9.body["loan"] as Json;
  assert.deepEqual([l9["status"], l9["servicer_loan_number"], l9["servicer_loan_last4"], l9["state"], l9["note_rate_pct"], l9["watch_rate_pct"], l9["bucket"], l9["banner"], l9["on_hold"], l9["hold"]], ["monitored", loan9.servicer_loan_number, "0009", "AZ", "5.875", "5.625", "likely_soon", p9.body["banner"], false, null]);
  assert.match(String((l9["homeowner"] as Json)["legal_name"]), /^[^\s]+ [A-Z]\.$/, "the first name and last initial"); assert.match(String((l9["homeowner"] as Json)["email_masked"]), /^.…@/, "34.3's mask for partner_admin, never raw"); assert.match(String((l9["homeowner"] as Json)["phone_masked"]), /^···\d{4}$/);
  // serviced: the refusal object, never a pane (36.5-T3: serviced.available === false); the Serviced tab visible, disabled, 36.6's copy
  assert.deepEqual(p9.body["serviced"], { available: false, code: "SERVICED_PANE_NOT_BUILT" }); assert.equal((p9.body["serviced"] as Json)["available"], false); assert.deepEqual(p9.body["serviced"], { ...SERVICED_REFUSAL }); assert.equal(SERVICED_PANE_CODE, "SERVICED_PANE_NOT_BUILT");
  assert.deepEqual(p9.body["serviced_tab"], { visible: true, disabled: true, copy: SERVICED_TAB_COPY }); assert.doesNotMatch(SERVICED_TAB_COPY, /\$|%|\d\.\d|\d{2,}/, "no figure on the tab's copy (V1 names the version, not a figure)");
  // no Pay control — nor Escrow, Draft, Statement, ACH, Payoff-request, Resolve, Exclude, Message or Re-offer: no key of any such name at any depth (rule 9), and no such route under the loan
  assertNoForbiddenKey(p9.body, "the loan page");
  for (const path of ["pay", "escrow", "draft", "statement", "ach", "payoff", "resolve", "exclude", "message", "reoffer"]) {
    const post = await api("POST", `/v1/partner/loans/${loan9.id}/${path}`, { amount_cents: "100" }, bearer(nora.token)); assert.equal(post.status, 404, `${path}: no such partner route`); assert.equal(post.body["code"], "NOT_FOUND");
  }
  assert.equal(await count(`partner_actions WHERE action NOT IN ('partner_portal.viewed', 'partner_portal.door') AND partner_party_id = $1 AND action <> 'partner.user.invite'`, [partnerA]), 0, "no command from the loan page"); assert.equal(await count(`timers WHERE loan_id = $1 AND code NOT LIKE 'SM_PARTNER_BOOK_%' AND code NOT LIKE 'SM_REFI_%'`, [loan9.id]), 0, "LOAN_MONITORED: no servicing clock on the row");
  // rule 6: the reviews newest first — the verdict, the engine's codes with 33.2's words, the watch rate on the watching row, the analyst's rationale as stored and as rendered (no token in it)
  const reviews9 = p9.body["reviews"] as Json[]; assert.equal(reviews9.length, 1); const rv9 = reviews9[0]!; const stored9 = await latestReview(loan9.id);
  assert.deepEqual([rv9["as_of_date"], rv9["verdict"], rv9["reasons"], rv9["watch_rate_pct"], rv9["analyst_rationale_tokens"], rv9["analyst_rationale"], rv9["analyst_skipped"]], [AS_OF, "watching", stored9.reasons, "5.625", WATCHING_RATIONALE, WATCHING_RATIONALE, null]);
  assert.equal((rv9["reasons_in_words"] as string[])[0], "the rate reduction is under the program's floor"); assert.equal(rv9["facts"], undefined, "the engine's facts stay on the review row; the page shows the words and the rendered rationale");
  // loan 1 (candidate, offered): the rationale's tokens rendered from that review row's own facts exactly as the surface resolves them (33.2's reviewTokenValues) — 7.250% and 6.375% appear because the analyst tokenized them; nothing else
  const p1 = await page(nora, loan1.id); assert.equal(p1.status, 200); const rv1 = (p1.body["reviews"] as Json[])[0]!; const stored1 = await latestReview(loan1.id);
  assert.equal(rv1["analyst_rationale_tokens"], CLEAN_RATIONALE, "the stored rationale, tokens and all"); assert.match(String(rv1["analyst_rationale_tokens"]), /\{\{facts\.rate_now\}\}/);
  const values = reviewTokenValues(stored1.facts as unknown as ReviewFacts);
  assert.equal(rv1["analyst_rationale"], renderRationale(CLEAN_RATIONALE, stored1.facts)); assert.doesNotMatch(String(rv1["analyst_rationale"]), /\{\{/, "no token left");
  assert.equal(rv1["analyst_rationale"], `Your rate today is ${values["facts.rate_now"]} and this morning's sheet shows ${values["facts.candidate_rate"]}, which lowers the payment by ${values["facts.monthly_delta"]}. The offer is on the card here.`);
  assert.match(String(rv1["analyst_rationale"]), /7\.250%/); assert.match(String(rv1["analyst_rationale"]), /6\.375%/); assert.equal(values["facts.rate_now"], "7.250%"); assert.equal(values["facts.candidate_rate"], "6.375%");
  assert.equal(renderRationale("{{facts.watch_rate}} and {{facts.rate_now}}", stored1.facts), `and ${values["facts.rate_now"]}`, "a token the facts lack renders as absent, never as a figure the page made up");
  assert.deepEqual([rv1["verdict"], rv1["watch_rate_pct"], p1.body["bucket"], p1.body["pipeline_stage"], p1.body["banner"]], ["candidate", null, "eligible_now", "offered", bannerMonitored(DEMO_PARTNER.legal_name)], "an offered member with no application yet: Monitored, on Eligible now, stage offered");
  // rule 7: facts history as names — the first tape's row is `created` (33.1 rule 2's word) with nothing changed; never a raw fact, never a before/after value
  assert.deepEqual(p1.body["facts_history"], [{ as_of_date: DEMO_AS_OF, import_id: (await db.query<{ import_id: string }>(`SELECT import_id::text AS import_id FROM partner_book_facts WHERE loan_id = $1`, [loan1.id]))[0]!.import_id, change: "created", changed: [] }]);
  const l1 = p1.body["loan"] as Json; assert.deepEqual([l1["upb_cents"], l1["pi_cents"], (l1["value"] as Json)["value_cents"], l1["facts_as_of"]], ["44136613", "306979", "60500000", DEMO_AS_OF], "the row's current figures are 33.2-T2's, read from the facts row (36.3 rule 5)");
  // rule 8: readiness — 33.3's latest row (07:20's pass checked the candidates): ready, the missing names in the order asked, the items by name and status only; the offer with 20.1's word, when it went out and when it expires — no rate, payment or NPV
  const rd = p1.body["readiness"] as Json; const stored = await readinessRead(runtime, loan1.id); assert.ok(stored);
  assert.deepEqual([rd["as_of_date"], rd["ready"], rd["missing"]], [stored.as_of_date, false, stored.missing]); assert.ok((rd["missing"] as string[]).includes("identity"));
  assert.deepEqual(rd["items"], stored.items.map((it) => ({ item: it.item, status: it.status }))); for (const it of rd["items"] as Json[]) assert.deepEqual(Object.keys(it).sort(), ["item", "status"], "no source id, no document, no ask");
  const offers = p1.body["offers"] as Json[]; assert.equal(offers.length, 1); const touch = (await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = 'marketing_touches' AND data->>'opportunity_id' = $1 ORDER BY id LIMIT 1`, [oppOf(loan1.id)]))[0];
  assert.deepEqual([offers[0]!["opportunity_id"], offers[0]!["status"], offers[0]!["expires_at"], offers[0]!["expired"]], [oppOf(loan1.id), "offered", "2026-10-15", false]);
  assert.ok(touch, "20.2's touch"); assert.equal(offers[0]!["delivered_at"], iso(String((decodeEntityData(touch.data) as Json)["sent_at"])), "delivered_at is the touch's sent_at"); assert.deepEqual(Object.keys(offers[0]!).sort(), ["as_of_date", "delivered_at", "delivered_channels", "expired", "expires_at", "opportunity_id", "status"]);
  assert.equal(p9.body["readiness"], null, "no readiness row for a watching loan");
  for (const o of p9.body["offers"] as Json[]) assert.deepEqual([o["status"], o["delivered_at"], o["expires_at"]], ["suppressed", null, null], "a watching loan's opportunity row is 20.1's `suppressed` one (34.3's list, 20.1's word): nothing delivered, nothing to expire");
  // loan 11 (excluded for bankruptcy): the code and its words, the analyst's text — never the chapter, never a diagnosis
  const p11 = await page(nora, loan11.id); const rv11 = (p11.body["reviews"] as Json[])[0]!;
  assert.deepEqual([p11.body["bucket"], rv11["verdict"], rv11["reasons"], rv11["reasons_in_words"], rv11["analyst_rationale"]], ["not_near", "excluded", ["bankruptcy_active"], ["an active bankruptcy"], OTHER_RATIONALE]);
  // rule 10: the partner-grade mask on every page — no raw contact, no FICO, DTI, ZIP, street, investor column, SSN, TIN or DOB in any form; the partner_ops sees the same page (the full number, the masked contact)
  for (const [what, body] of [["loan 9's page", p9.body], ["loan 1's page", p1.body], ["loan 11's page", p11.body]] as const) { assertPartnerGrade(JSON.stringify(withoutMaskedContact(body)), what); assertNoForbiddenKey(body, what); assert.ok(!leafValuesOf(body).some((v) => String(v) === String(loanN(1).tape["fico_current"])), `${what} carries the tape's FICO as a value`); }
  const ops = await page(oli!, loan9.id); assert.equal(ops.status, 200); assert.equal(ops.body["acted_as"], "partner_ops"); assert.equal((ops.body["loan"] as Json)["servicer_loan_number"], loan9.servicer_loan_number); assert.equal(ops.body["banner"], p9.body["banner"]);
  // the tenant rule: partner B's loan on partner A's page path is 404 NOT_FOUND, logged refused with the requested id and no field of the row; an unknown id the same
  const cross = await page(nora, loanOfB); assert.equal(cross.status, 404); assert.equal(cross.body["code"], "NOT_FOUND"); assert.doesNotMatch(JSON.stringify(cross.body), /Denise|Okoro|NL-200007/);
  assert.equal((await page(nora, randomUUID())).status, 404); assert.equal((await page(nora, "not-a-uuid")).status, 404);
  const refused = await actions(`partner_user_id = $1 AND subject_kind = 'loan' AND result = 'refused'`, [noraId]); assert.ok(refused.some((a) => a.subject_id === loanOfB && a.refusal_code === "NOT_FOUND")); for (const a of refused) assertPartnerGrade(a.row_text, "the refused row");
  const viewed = await actions(`partner_user_id = $1 AND subject_kind = 'loan' AND result = 'ok'`, [noraId]); assert.ok(viewed.some((a) => a.subject_id === loan9.id && a.role === "partner_admin")); for (const a of viewed) assertPartnerGrade(a.row_text, "the log row");
  // the page wrote nothing: no verdict, no flag, no note, no model turn from the portal (ANALYST_NEVER_DECIDES, PROVENANCE)
  assert.equal(await count(`partner_book_reviews WHERE loan_id = $1`, [loan9.id]), 1); assert.equal(await count(`agent_turns`), turnsBefore, "no analyst turn from the portal");
});

test("36.5-T4: Loan page for a boarded refinance shows banner `Active — Supermortgage subservicing` and `serviced.code === \"SERVICED_PANE_NOT_BUILT\"` in V1.", { skip }, async () => {
  const loan1 = await loanByNumber(1); const party = await partyOfLoan(loan1.id); const oppId = oppOf(loan1.id);
  // the homeowner of loan 1 signs in through the borrower door and taps Yes on the OfferCard (33.3-T2 / 36.4-T2): 20.1's engaged, 33.3's refi.open, the application with prior_loan_id
  const maria = await homeownerSignIn(loanN(1).email!, "10.36.5.11"); assert.equal(maria.party_id, party.id);
  const offer = (await ui().cardsOf(party.id)).find((c) => c.kind === "OfferCard" && c.props["flow_key"] === `offer:${oppId}`); assert.ok(offer, "the OfferCard on the rail"); assert.equal(offer.status, "pending");
  const yes = await tapYes(maria.token, offer, "10.36.5.11"); assert.equal(yes.status, 201, JSON.stringify(yes.body).slice(0, 600));
  const apps = await applicationsOf(loan1.id); assert.equal(apps.length, 1); const app = apps[0]!; refiApplicationId = app.id;
  // the second mode: In refinance — the same row, its banner flipped, the page's bucket in_refinance, the stage readiness, the application linked (rules 4–5)
  const inRefi = await page(nora, loan1.id); assert.equal(inRefi.status, 200);
  assert.deepEqual([inRefi.body["banner"], inRefi.body["bucket"], inRefi.body["pipeline_stage"], (inRefi.body["links"] as Json)["refinance_application_id"], (inRefi.body["links"] as Json)["pipeline"]], [BANNER_IN_REFINANCE, "in_refinance", "readiness", app.id, `/partners/pipeline/${loan1.id}`]);
  assert.equal(inRefi.body["banner"], "In refinance — origination in progress"); assert.deepEqual(inRefi.body["serviced"], { available: false, code: "SERVICED_PANE_NOT_BUILT" }, "still monitored: the pane is dark");
  const boardRow = ((await eligibility(nora)).body["loans"] as Json[]).find((l) => l["loan_id"] === loan1.id)!; assert.deepEqual([boardRow["bucket"], boardRow["banner"]], ["eligible_now", BANNER_IN_REFINANCE], "the board's bucket names the list, the page's the state (Open question 1)");
  // funding day: 30.2 boards the new loan from the demo snapshot (33.3-T6's path); then 35.10's closeout in monitored_partner mode retires the prior loan (36.4-T4's harness, verbatim)
  clock.set(NOW_FUNDING); await refresh();
  const record = await runtime.applications.get(app.id); assert.ok(record);
  const funded = await fundApplication(runtime, app.id, demoSnapshot(record, { partner_name: DEMO_PARTNER.legal_name }), demoFunded(app.id), { kind: "agent", id: "funding" });
  assert.match(funded.status, /^boarded/, JSON.stringify(funded).slice(0, 600)); await settle();
  const afterFunding = (await applicationsOf(loan1.id)).find((a) => a.id === app.id)!; assert.equal(afterFunding.status, "funded"); newLoanId = afterFunding.loan_id!; assert.ok(newLoanId); assert.notEqual(newLoanId, loan1.id);
  const newLoan = await loanRow(newLoanId); assert.deepEqual([newLoan.status, newLoan.origination_application_id], ["active", app.id]);
  assert.equal((await db.query<{ p: string | null }>(`SELECT partner_party_id::text AS p FROM loans WHERE id = $1`, [newLoanId]))[0]!.p, partnerA, "the new loan is the tenant's (the application's partner)");
  const pass1 = await closeoutPass(runtime, NOW_FUNDING, { logger: runtime.logger });
  const closeout = (await db.query<{ mode: string; step: string; partner_party_id: string; payoff_demand_id: string | null }>(`SELECT mode, step, partner_party_id::text AS partner_party_id, payoff_demand_id FROM refinance_closeouts WHERE application_id = $1`, [app.id]))[0];
  assert.ok(closeout, `the closeout opened: ${pass1.line}`); assert.equal(closeout.mode, "monitored_partner"); assert.equal(closeout.step, "quoted", pass1.line); assert.ok(closeout.payoff_demand_id);
  const demand = decodeEntityData((await db.query<{ data: Json }>(`SELECT data FROM entity_current WHERE kind = 'payoff_demands' AND id = $1`, [closeout.payoff_demand_id]))[0]!.data) as Json;
  const evidenceId = `doc-settlement-statement-${app.id}`;
  await new PgEntityRepository(db).save([{ kind: "documents", id: evidenceId, version: 1, updatedAt: NOW_FUNDING, updatedBy: "system:test", data: { application_id: app.id, kind: "settlement_statement", sha256: "fake", storage_uri: `fake://documents/${evidenceId}`, mime_type: "application/pdf", retention_class: "life_of_loan_plus_4y",
    metadata: { payoff_lines: [{ payoff_demand_id: closeout.payoff_demand_id, payee_party_id: closeout.partner_party_id, amount_cents: String(demand["total_cents"]), wire_reference: "FEDREF-36-5-T4" }] } } }], { applicationId: app.id });
  await runtime.uow.run({ applicationId: app.id }, (ctx) => ctx.events.append({ type: "funding.disbursement.confirmed", applicationId: app.id, aggregate: { kind: "application", id: app.id }, actor: { kind: "agent", id: "funder" }, payload: { application_id: app.id, evidence_document_id: evidenceId, disbursed_on: "2026-11-12", disbursement_date: "2026-11-12" } }), { clock });
  for (let i = 0; i < 3; i += 1) await closeoutPass(runtime, NOW_FUNDING, { logger: runtime.logger });
  const old = await loanRow(loan1.id); assert.deepEqual([old.status, old.refinanced_by_loan_id], ["paid_off", newLoanId], "the prior loan retired and linked (35.10 rule 7)"); assert.equal((await events(LOAN_PAID_OFF_EVENT, loan1.id)).length, 1);
  // the third mode: the new loan's page — banner Active (loans.status = active and origination_application_id set), bucket serviced, no stage, the link back to the prior loan, the dark serviced field with 36.6's one code (36.5-T4)
  const pn = await page(nora, newLoanId); assert.equal(pn.status, 200, JSON.stringify(pn.body).slice(0, 600));
  assert.equal(pn.body["banner"], "Active — Supermortgage subservicing"); assert.equal(pn.body["banner"], BANNER_ACTIVE);
  assert.equal((pn.body["serviced"] as Json)["code"], "SERVICED_PANE_NOT_BUILT"); assert.deepEqual(pn.body["serviced"], { available: false, code: "SERVICED_PANE_NOT_BUILT" });
  assert.deepEqual([pn.body["bucket"], pn.body["pipeline_stage"], pn.body["loan_id"], (pn.body["links"] as Json)["prior_loan_id"], (pn.body["links"] as Json)["refinance_application_id"], (pn.body["links"] as Json)["refinanced_by_loan_id"]], ["serviced", null, newLoanId, loan1.id, app.id, null]);
  const ln = pn.body["loan"] as Json;
  assert.deepEqual([ln["status"], ln["servicer_loan_number"], ln["servicer_loan_last4"], ln["origination_application_id"], ln["bucket"], ln["banner"], ln["on_hold"]], ["active", newLoan.servicer_loan_number, newLoan.servicer_loan_number.slice(-4), app.id, "serviced", BANNER_ACTIVE, false]);
  assert.match(String((ln["homeowner"] as Json)["legal_name"]), /^[^\s]+ [A-Z]\.$/);
  // V1 shows no figure of the serviced loan and no history of its own: the pane is 36.6's contract — no payment, escrow, insurance, delinquency, remittance, custodial, notice, QC or payoff detail, no empty chart
  assert.deepEqual([pn.body["facts_history"], pn.body["reviews"], pn.body["readiness"], pn.body["offers"]], [[], [], null, []]);
  assert.deepEqual([ln["upb_cents"], ln["note_rate_pct"], ln["pi_cents"], ln["next_due_date"], ln["facts_as_of"], ln["value"], ln["latest_review"]], [null, null, null, null, null, null, null], "no figure of the active loan on the page (nothing computed, nothing of sections 2–19 read)");
  assert.deepEqual(pn.body["serviced_tab"], { visible: true, disabled: true, copy: SERVICED_TAB_COPY }); assertNoForbiddenKey(pn.body, "the new loan's page"); assertPartnerGrade(JSON.stringify(withoutMaskedContact(pn.body)), "the new loan's page");
  assert.ok((await count(`loan_terms WHERE loan_id = $1`, [newLoanId])) >= 1, "sections 2–19 already run on the active loan (30.2's terms row) — and none of it is on the page");
  // the retired prior loan's page (DELTA-03): banner null with status paid_off and refinanced_by_loan_id = the new loan (never a sentence minted here); bucket null; serviced null; the stage stays boarded; its history whole
  const po = await page(nora, loan1.id); assert.equal(po.status, 200);
  assert.deepEqual([po.body["banner"], po.body["bucket"], po.body["pipeline_stage"], po.body["serviced"], (po.body["loan"] as Json)["status"], (po.body["links"] as Json)["refinanced_by_loan_id"], (po.body["loan"] as Json)["refinanced_by_loan_id"]], [null, null, "boarded", null, "paid_off", newLoanId, newLoanId]);
  assert.equal((po.body["reviews"] as Json[]).length, 1); assert.equal((po.body["facts_history"] as Json[]).length, 1); assert.deepEqual(po.body["serviced_tab"], { visible: true, disabled: true, copy: SERVICED_TAB_COPY }, "the tab is disabled on every loan page");
  // Home after the board: the member left the board (36.3 rule 4), boarded this month counts one, the report link stands
  const h = await home(nora); const e = h.body["eligibility"] as Record<string, number>; const feed = (await pipeline(nora)).body["items"] as Json[];
  assert.equal(e["eligible_now"]! + e["likely_soon"]! + e["not_near"]! + Number((h.body["book"] as Json)["on_hold"]), 11); assert.equal((h.body["book"] as Json)["loans_monitored"], 11);
  assert.deepEqual(h.body["pipeline"], { in_flight: feed.filter((i) => isInFlightStage(String(i["stage"]))).length, boarded_mtd: 1 }); assert.ok(feed.some((i) => i["loan_id"] === loan1.id && i["stage"] === "boarded"));
  // the new active loan is never on the board and has no place on the feed's paths (36.4); its page is 36.5's (this test) and its pane 36.6's
  assert.ok(!((await eligibility(nora)).body["loans"] as Json[]).some((l) => l["loan_id"] === newLoanId)); assert.equal((await api("GET", `/v1/partner/pipeline/${newLoanId}`, undefined, bearer(nora.token))).status, 404);
  // the tenant rule on the new loan: partner B's admin gets 404, logged refused; nothing was written by the partner prefix but log rows
  const cross = await page(sam, newLoanId); assert.equal(cross.status, 404); assert.equal(cross.body["code"], "NOT_FOUND");
  assert.equal(await count(`partner_actions WHERE action NOT IN ('partner_portal.viewed', 'partner_portal.door') AND action <> 'partner.user.invite'`), 0, "no command from the partner prefix in this file but the invitation");
});

test("36.5-T5: A `partner_auditor` can GET home, eligibility, pipeline, reports, and loan pages, and cannot POST imports.", { skip }, async () => {
  aud = await invitedSession(nora, AUD, ["partner_auditor"]); assert.deepEqual([aud.partner_party_id, aud.role, aud.body["roles"]], [partnerA, "partner_auditor", ["partner_auditor"]]);
  const loan9 = await loanByNumber(9); const staff = await latestDailyReport(runtime, partnerA, AS_OF); assert.ok(staff); assert.ok(newLoanId && refiApplicationId, "T4's boarded refinance");
  // home, eligibility, pipeline, reports (the list, a day, the export) and loan pages (a monitored loan, the retired prior loan, the new active loan): 200, acted as partner_auditor, the tenant's rows
  const reads: [string, Reply][] = [
    ["home", await home(aud)], ["eligibility", await eligibility(aud)], ["pipeline", await pipeline(aud)], ["reports", await reports(aud)], ["report", await reports(aud, `?as_of=${AS_OF}`)],
    ["loan 9", await page(aud, loan9.id)], ["the prior loan", await page(aud, (await loanByNumber(1)).id)], ["the new loan", await page(aud, newLoanId)],
  ];
  for (const [what, r] of reads) { assert.equal(r.status, 200, `${what}: ${JSON.stringify(r.body).slice(0, 300)}`); assert.equal(r.body["acted_as"], "partner_auditor", what); assert.equal(r.body["partner_party_id"], partnerA, what); assertPartnerGrade(JSON.stringify(r.body), what); if (!what.startsWith("report")) assertNoForbiddenKey(r.body, what); }
  // the report rows are 34.3's shape as stored: `readiness.not_ready_by_item` is keyed by 33.3's item names (`ssn` is the item asked for, a count of rows — never a number of anyone's)
  for (const row of [reads[4]![1].body, ...(reads[3]![1].body["reports"] as Json[])]) { const byItem = (row["readiness"] as Json)["not_ready_by_item"] as Json; for (const [k, v] of Object.entries(byItem)) { assert.match(k, /^[a-z_]+$/); assert.equal(typeof v, "number"); } assertNoForbiddenKey({ ...row, readiness: { ...(row["readiness"] as Json), not_ready_by_item: undefined } }, "the report"); }
  const x = await exportReport(aud, `?as_of=${AS_OF}`); assert.equal(x.status, 200); assert.equal(x.text, renderDailyReport(staff)); assert.equal((await exportReport(aud, `?as_of=${AS_OF}&format=csv`)).status, 200);
  const h = reads[0]![1]; assert.deepEqual(h.body["eligibility"], (await home(nora)).body["eligibility"], "the same counts the admin sees"); assert.equal(h.body["latest_report_id"], staff.id);
  assert.equal(reads[4]![1].body["id"], staff.id); assert.ok((reads[3]![1].body["reports"] as Json[]).some((r) => r["id"] === staff.id));
  // rule 10: the auditor's loan page carries the servicer loan number's last four only, and no masked contact
  for (const [what, r] of reads.slice(5)) { const l = r.body["loan"] as Json; assert.equal(l["servicer_loan_number"], undefined, `${what}: the last four only for partner_auditor`); assert.match(String(l["servicer_loan_last4"]), /^\d{4}$/); assert.equal((l["homeowner"] as Json)["email_masked"], undefined, what); assert.equal((l["homeowner"] as Json)["phone_masked"], undefined, what); }
  assert.deepEqual([reads[5]![1].body["banner"], reads[6]![1].body["banner"], reads[7]![1].body["banner"]], [bannerMonitored(DEMO_PARTNER.legal_name), null, BANNER_ACTIVE], "the three modes read the same to the auditor");
  assert.deepEqual([reads[5]![1].body["serviced"], reads[7]![1].body["serviced"]], [{ available: false, code: "SERVICED_PANE_NOT_BUILT" }, { available: false, code: "SERVICED_PANE_NOT_BUILT" }]);
  // …and cannot POST imports: 403 ROLE_REQUIRED{role: partner_admin, act_as: []} before any read of the files (36.1-T2's answer for the auditor); no import row, no facts row
  const importsBefore = await count(`partner_book_imports`); const factsBefore = await count(`partner_book_facts`);
  const up = await drop(aud, { as_of_date: "2026-11-12", tape: book.tape, supplement: book.supplement });
  assert.equal(up.status, 403, JSON.stringify(up.body)); assert.deepEqual([up.body["code"], up.body["role"], up.body["held"], up.body["act_as"]], ["ROLE_REQUIRED", "partner_admin", ["partner_auditor"], []]);
  assert.equal((await api("POST", "/v1/partner/book/imports", {}, bearer(aud.token))).status, 403);
  assert.equal(await count(`partner_book_imports`), importsBefore); assert.equal(await count(`partner_book_facts`), factsBefore);
  // nor the Admin area, nor a resolve, nor a role the account does not hold
  assert.equal((await api("GET", "/v1/partner/users", undefined, bearer(aud.token))).status, 403); assert.equal((await api("POST", "/v1/partner/users/invite", { email: `z.${R}@northlight.example`, name: "Z", roles: ["partner_ops"] }, bearer(aud.token))).status, 403);
  assert.equal((await api("POST", `/v1/partner/book/loans/${loan9.id}/resolve`, { resolution: "keep", reason: "x" }, bearer(aud.token))).status, 403); assert.equal((await home(aud, "?role=partner_admin")).status, 403);
  // 36.1 rule 5: every look on the log under partner_auditor, the refused act with its code; no PII
  const mine = await actions(`partner_user_id = $1`, [aud.partner_user_id]);
  const views = mine.filter((a) => a.action === "partner_portal.viewed" && a.result === "ok").map((a) => a.subject_kind);
  for (const v of ["home", "eligibility", "pipeline", "reports", "report", "report.export", "loan"]) assert.ok(views.includes(v), `${v} on the log`);
  assert.ok(mine.filter((a) => a.action === "partner_portal.viewed" && a.result === "ok").every((a) => a.role === "partner_auditor"));
  const refusedUploads = mine.filter((a) => a.action === "book.import"); assert.equal(refusedUploads.length, 2); for (const a of refusedUploads) assert.deepEqual([a.result, a.refusal_code, a.role], ["refused", "ROLE_REQUIRED", "partner_admin"]);
  for (const a of mine) assertPartnerGrade(a.row_text, "the log row");
});
