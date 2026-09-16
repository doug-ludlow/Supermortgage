// 36.2 Partner tape drop on book.import: the upload with its report, the import history, the status line and the holds
// spec/sections/36-servicing-partner-portal/36-2-partner-tape-drop-on-book-import.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// The harness is 36.1's (src/domain/servicing-partner-portal/36-1.spec.test.ts) over an UNSEEDED book: own database `<base>_36_2`,
// the API server of src/runtime/server.ts in-process with the partner prefix /v1/partner/* and the borrower router (the homeowner
// door of the LOAN_MONITORED proof), the FAKE e-delivery port (the code echoed as `fake_code`), a FixedClock. The demo partner's
// parties{servicer} row exists as 33.1's import writes it (legal name, servicer number, MERS org id, the NMLSR id in `contact`) with
// its seeded partner_admin (seedPartnerPortalDemo) and NO book — T1 is the first drop, so the 12 monitored loans are the partner
// user's own import. A second partner (one loan, imported through importPartnerBook as 36.1's harness does) for the cross-tenant
// reads and T4's named field. The files are 33.1's fixture (src/domain/partner-book/fixtures/partner-book-demo.ts) and the later
// snapshots are built by 33.1-T11's own helper (the same rows, the as-of date moved, a loan removed) — no second tape is checked in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connect, type Db } from "../../infra/db/client.ts";
import { testDatabase } from "../../infra/db/test-db.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock } from "../../kernel/events/index.ts";
import { addDays, plainDate } from "../../kernel/calendar/date.ts";
import { Runtime } from "../../runtime/app.ts";
import { createApiServer, listen } from "../../runtime/server.ts";
import { createLogger } from "../../runtime/log.ts";
import { createBorrowerRouter, type BorrowerRouter } from "../../runtime/borrower/routes.ts";
import { FakeRateFeed } from "../../infra/integrations/rates.ts";
import { writeXlsx } from "../../infra/files/xlsx.ts";
import { M3_V1 } from "../partner-book/profiles/m3-v1.ts";
import { DEMO_AS_OF, DEMO_PARTNER, demoBook, demoMin, type DemoLoan } from "../partner-book/fixtures/partner-book-demo.ts";
import { holdsOf, importPartnerBook, isOnHold } from "../../runtime/partner-book.ts";
import { HOLD_REASON } from "../../runtime/partner-book-review.ts";
import { seedEntryDemo } from "../../runtime/entry-seed.ts";
import { seedPartnerPortalDemo, DEMO_PARTNER_ADMIN_EMAIL } from "../../runtime/partner-portal/seed.ts";
import { BOOK_COPY, PARTNER_PROFILE } from "../../runtime/partner-portal/book.ts";

const { url: DB_URL, skip } = await testDatabase(import.meta.url);
const TOKEN = "ops-" + randomUUID();
const R = randomUUID().slice(0, 8);
/** 2026-09-02 08:00 America/New_York — the day after the fixture's as-of date (DEMO_AS_OF 2026-09-01), so the first drop's clock reads "next expected 2026-09-08, not late". */
const T0 = "2026-09-02T12:00:00.000Z";
const clock = new FixedClock(T0);
type Json = Record<string, unknown>;

// the people: the seeded partner_admin of the demo partner (Northlight), a partner_ops and a partner_auditor she invites
const NORA = { email: DEMO_PARTNER_ADMIN_EMAIL, name: "Nora Northlight", password: `nora-northlight-admin-${R}` };
const OLI = { email: `oli.ops.${R}@northlight.example`, name: "Oli Operations", password: `oli-partner-ops-pass-${R}` };
const AUD = { email: `aud.auditor.${R}@northlight.example`, name: "Audrey Auditor", password: `audrey-auditor-pass-${R}` };
let noraId = "";
type Session = { token: string; session_id: string; partner_user_id: string; partner_party_id: string; role: string; body: Json };
let nora: Session; let oli: Session; let aud: Session;
let partnerA = ""; let partnerB = ""; let importOfB = ""; let loanOfB = "";
/** T1's import id (the first drop) and T3's later snapshot's, read by the later tests. */
let firstImportId = ""; let laterImportId = "";

let db: Db; let runtime: Runtime; let router: BorrowerRouter; let base = ""; let close: () => Promise<void> = async () => undefined;
const logLines: string[] = [];
const book = demoBook();
const loanN = (n: number): DemoLoan => book.loans.find((l) => l.n === n)!;
const DENISE = { name: "Denise Okoro", email: `denise.okoro.${R}@example.test`, phone: "+16025550177", number: "NL-200007" };
const PARTNER_B = { legal_name: `Second Servicer (FAKE partner) ${R}`, nmlsr_id: "7654321", servicer_number: "300054321" };

test.before(async () => {
  if (skip) return;
  db = connect(DB_URL);
  const logger = createLogger("json", (line) => { logLines.push(line); if (process.env["FLOW_DEBUG"] && /error|unhandled|partner|"status":[45]/i.test(line)) process.stderr.write(line + "\n"); });
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock, logger });
  // Operational prerequisites: 33.1's registration of the demo partner — the parties{servicer} row as writePartnerParty writes it (the NMLSR id in `contact`); no book yet
  partnerA = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id, contact) VALUES ('servicer', $1, $2, $3, $4::jsonb) RETURNING id`, [DEMO_PARTNER.legal_name, DEMO_PARTNER.servicer_number, DEMO_PARTNER.mers_org_id, JSON.stringify({ phone: "+18005550199", nmlsr_id: DEMO_PARTNER.nmlsr_id })]))[0]!.id;
  const seed = await seedPartnerPortalDemo(runtime, { partner_id: partnerA });
  assert.equal(seed.created, true); assert.deepEqual(seed.roles, ["partner_admin"]); noraId = seed.partner_user_id;
  // the second partner with one monitored loan of its own (36.1's harness: loan 7's row under another number, name and MIN), imported by the seed actor
  const col = (key: string): number => { const i = M3_V1.columns.findIndex((c) => c.key === key); assert.ok(i >= 0, `the profile's ${key} column`); return i; };
  const row = [...book.tapeRows[7]!]; row[col("borrower_name")] = DENISE.name; row[col("servicer_loan_number")] = DENISE.number; row[col("mers_min")] = demoMin(207);
  const b = await importPartnerBook(runtime, { partner: PARTNER_B, as_of_date: DEMO_AS_OF, profile: "m3-v1", tape: { filename: "second-partner.xlsx", content: writeXlsx([book.tapeRows[0]!, row], "M3") }, supplement: { filename: "second-partner-supplement.csv", content: new Uint8Array(Buffer.from(`servicer_loan_number,borrower_email,borrower_phone,borrower_name\n${DENISE.number},${DENISE.email},${DENISE.phone},${DENISE.name}\n`, "utf8")) }, synthetic: true }, { kind: "system", id: "seed-demo" });
  assert.equal(b.status, "loaded", JSON.stringify(b.report).slice(0, 600)); assert.equal(b.rows_loaded, 1);
  partnerB = b.partner_party_id; importOfB = b.import_id; loanOfB = b.loans[0]!.loan_id; assert.notEqual(partnerB, partnerA);
  router = createBorrowerRouter({ runtime, logger, environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost", "http://127.0.0.1"], urlSecret: "test-secret", defaultPartnerId: partnerA });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger, borrowerRouter: router, borrower: { environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost"], urlSecret: "test-secret" } });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => { router.hub.close(); server.closeAllConnections?.(); server.close(() => db.end().then(() => resolve())); });
});
test.after(async () => { if (!skip) { await router.flows?.settle(); await close(); } });

// ---------------------------------------------------------------- helpers over the API (36.1's)
type Reply = { status: number; body: Json; headers: Headers };
async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-forwarded-for": "10.36.2.1", "user-agent": "36.2-spec", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text(); return { status: r.status, body: text ? (JSON.parse(text) as Json) : {}, headers: r.headers };
}
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
/** The partner's drop as the Book page sends it: multipart/form-data with the files and `as_of_date` (36.2 Inputs), plus any field the test names (rule 2 drops it). */
async function drop(session: Session, i: { as_of_date: string; tape: Uint8Array; supplement?: Uint8Array | string | null; fields?: Record<string, string>; query?: string }): Promise<Reply> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(i.fields ?? {})) fd.set(k, v);
  fd.set("as_of_date", i.as_of_date);
  fd.set("tape", new Blob([i.tape]), "partner-book.xlsx");
  if (i.supplement) fd.set("supplement", new Blob([i.supplement]), "partner-book-supplement.csv");
  const r = await fetch(`${base}/v1/partner/book/imports${i.query ?? ""}`, { method: "POST", headers: { ...bearer(session.token), "x-forwarded-for": "10.36.2.1", "user-agent": "36.2-spec" }, body: fd });
  const text = await r.text(); return { status: r.status, body: text ? (JSON.parse(text) as Json) : {}, headers: r.headers };
}
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
async function invitedSession(admin: Session, p: { email: string; name: string; password: string }, roles: string[]): Promise<Session> {
  const r = await api("POST", "/v1/partner/users/invite", { email: p.email, name: p.name, roles }, bearer(admin.token));
  assert.equal(r.status, 200, JSON.stringify(r.body)); await enrol(p); return signIn(p);
}
const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, params))[0]!.n);
type ActionRow = { id: string; partner_user_id: string | null; partner_party_id: string | null; role: string | null; action: string; subject_kind: string | null; subject_id: string | null; result: string; refusal_code: string | null; row_text: string };
const actions = async (where: string, params: unknown[] = []): Promise<ActionRow[]> => db.query<ActionRow>(`SELECT id::text AS id, partner_user_id::text AS partner_user_id, partner_party_id::text AS partner_party_id, role, action, subject_kind, subject_id, result, refusal_code, partner_actions::text AS row_text FROM partner_actions WHERE ${where} ORDER BY at, id`, params);
const homeownerPii = (): string[] => [...book.loans.flatMap((l) => [l.name, l.first_name, l.last_name, l.email, l.phone, l.supplement_email, l.supplement_phone]), DENISE.name, "Okoro", DENISE.email, DENISE.phone].filter((x): x is string => typeof x === "string" && x.length > 2);
const assertNoPii = (text: string, what: string): void => { for (const p of homeownerPii()) assert.ok(!text.includes(p), `${what} carries homeowner data: ${p}`); assert.doesNotMatch(text, /@/, `${what} carries an e-mail address`); };
/** The partner-grade mask on a wire body (brief §4.6; 36.2 rule 9): the first name and last initial may show — never the full name, the last name, an e-mail or a phone. */
const assertPartnerGrade = (text: string, what: string): void => { for (const p of [...book.loans.flatMap((l) => [l.name, l.last_name, l.email, l.phone, l.supplement_email, l.supplement_phone]), DENISE.name, "Okoro", DENISE.email, DENISE.phone].filter((x): x is string => typeof x === "string" && x.length > 2)) assert.ok(!text.includes(p), `${what} carries homeowner data: ${p}`); assert.doesNotMatch(text, /@|\+1\d{10}/, `${what} carries an e-mail address or a phone`); };
type LoanRow = { id: string; servicer_loan_number: string; status: string; partner_party_id: string };
const loansOf = async (partnerId: string): Promise<LoanRow[]> => db.query<LoanRow>(`SELECT id, servicer_loan_number, status::text AS status, partner_party_id::text AS partner_party_id FROM loans WHERE partner_party_id = $1 ORDER BY servicer_loan_number`, [partnerId]);
const loanByNumber = async (n: number): Promise<LoanRow> => { const l = (await loansOf(partnerA)).find((x) => x.servicer_loan_number === loanN(n).servicer_loan_number); assert.ok(l, `loan ${n} on the book`); return l; };
const events = async (type: string, loanId?: string) => db.query<{ type: string; loan_id: string | null; actor_kind: string; actor_id: string; actor_role: string | null; payload: Json }>(`SELECT type, loan_id::text AS loan_id, actor_kind::text AS actor_kind, actor_id, actor_role, payload FROM loan_events WHERE type = $1 AND ($2::uuid IS NULL OR loan_id = $2::uuid) ORDER BY sequence`, [type, loanId ?? null]);
const colOf = (key: string): number => { const i = M3_V1.columns.findIndex((c) => c.key === key); assert.ok(i >= 0, `the profile's ${key} column`); return i; };
/** 33.1-T11's helper: the fixture tape as a later snapshot — every row's as-of date moved to `asOf`, the loans in `without` (by n) removed, the same facts otherwise. */
function tapeAsOf(asOf: string, without: readonly number[] = []): Uint8Array {
  const drop = new Set(without.map((n) => loanN(n).servicer_loan_number));
  const rows = book.tapeRows.filter((r, i) => i === 0 || !drop.has(String(r[colOf("servicer_loan_number")]))).map((r) => [...r]);
  for (let i = 1; i < rows.length; i += 1) rows[i]![colOf("as_of_date")] = asOf;
  return writeXlsx(rows, "M3");
}
/** 36.1 rule 6: a session ends 12 hours after it opened — every jump of the clock past that reopens the doors (the code, then the password). */
async function refresh(): Promise<void> { nora = await signIn(NORA); if (oli) oli = await signIn(OLI); if (aud) aud = await signIn(AUD); }
type BookCounts = { loans: number; facts: number; terms: number; parties: number; invitations: number; imports: number; loaded: number; timers: number; notices: number };
/** The book's rows: what a wrong layout must leave unchanged (T5) and what a repeat must not grow (T2). */
async function bookCounts(): Promise<BookCounts> {
  return { loans: await count(`loans WHERE partner_party_id = $1`, [partnerA]), facts: await count(`partner_book_facts f JOIN loans l ON l.id = f.loan_id WHERE l.partner_party_id = $1`, [partnerA]), terms: await count(`loan_terms t JOIN loans l ON l.id = t.loan_id WHERE l.partner_party_id = $1`, [partnerA]),
    parties: await count(`parties WHERE party_type = 'borrower'`), invitations: await count(`partner_book_invitations`), imports: await count(`partner_book_imports WHERE partner_party_id = $1`, [partnerA]), loaded: await count(`partner_book_imports WHERE partner_party_id = $1 AND status = 'loaded'`, [partnerA]), timers: await count(`timers`), notices: await count(`notices`) };
}

test("36.2-T1: Given the demo fixture tape + supplement and a partner_admin session for that partner, when they POST the files, then `importPartnerBook` writes the same 12 `monitored` loans 33.1-T1 already asserts, and the actor on `book.import` is the partner_user, not `ops_analyst`.", { skip }, async () => {
  assert.equal(await enrol(NORA), noraId); nora = await signIn(NORA);
  assert.deepEqual([nora.partner_party_id, nora.role], [partnerA, "partner_admin"]);
  // before the first drop: an empty book — no loans, an empty history, a status line without an as-of date and the page's sentence (rule 8)
  assert.deepEqual(await loansOf(partnerA), []);
  const empty = await api("GET", "/v1/partner/book/status", undefined, bearer(nora.token));
  assert.equal(empty.status, 200, JSON.stringify(empty.body)); assert.deepEqual([empty.body["as_of_date"], empty.body["next_expected"], empty.body["late"], empty.body["monitored_loans"], empty.body["imports"], empty.body["empty"], empty.body["copy"]], [null, null, false, 0, 0, true, BOOK_COPY.empty]);
  assert.deepEqual(((await api("GET", "/v1/partner/book/imports", undefined, bearer(nora.token))).body["imports"] as Json[]), []);
  // the drop: the fixture tape (.xlsx, 118 columns, 12 rows) and its supplement, as of 2026-09-01, by the partner_admin
  assert.equal(book.tapeRows[0]!.length, 118); assert.equal(book.tapeRows.length, 13);
  const timersBefore = await count(`timers`);
  const r = await drop(nora, { as_of_date: DEMO_AS_OF, tape: book.tape, supplement: book.supplement });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 800));
  firstImportId = r.body["import_id"] as string;
  // the answer is the report partnerBookReport returns (rule 5): loaded, 12/12, the partner the session's, the profile 33.1 registers, the copy of the page
  assert.deepEqual([r.body["status"], r.body["rows_total"], r.body["rows_loaded"], r.body["rows_exception"], r.body["partner_party_id"], r.body["loans_created"], r.body["loans_updated"], r.body["acted_as"], r.body["copy"]], ["loaded", 12, 12, 0, partnerA, 12, 0, "partner_admin", BOOK_COPY.upload]);
  assert.equal((r.body["report"] as Json)["profile"], PARTNER_PROFILE); assert.match(firstImportId, /^[0-9a-f-]{36}$/);
  assert.equal((r.body["parties_created"] as number) + (r.body["parties_linked"] as number), 12, "a party per loan"); assert.equal(r.body["invitations_sent"], 11, "an invitation for every party with an e-mail on the supplement (loan 12 has none)");
  assert.ok((((r.body["report"] as Json)["gaps_by_loan"] as Json)[loanN(12).servicer_loan_number] as string[]).includes("contact"), "loan 12: gaps: contact");
  assert.equal((r.body["loans"] as Json[]).length, 12); assertNoPii(JSON.stringify(r.body), "the report");
  // the same 12 monitored loans 33.1-T1 asserts: loans{status=monitored} with the partner's numbers, 12 loan_terms{source=partner_tape}, 12 properties, 12 borrowers with party_id, 12 facts rows
  const loans = await loansOf(partnerA);
  assert.equal(loans.length, 12); assert.deepEqual(loans.map((l) => l.servicer_loan_number), book.loans.map((l) => l.servicer_loan_number).sort());
  for (const l of loans) assert.equal(l.status, "monitored");
  const ids = loans.map((l) => l.id);
  const terms = await db.query<{ source: string; effective_to: string | null }>(`SELECT source, effective_to::text AS effective_to FROM loan_terms WHERE loan_id = ANY($1::uuid[])`, [ids]);
  assert.equal(terms.length, 12); assert.ok(terms.every((t) => t.source === "partner_tape" && t.effective_to === null));
  assert.equal(await count(`properties WHERE id IN (SELECT property_id FROM loans WHERE id = ANY($1::uuid[]))`, [ids]), 12);
  assert.equal(await count(`loan_borrowers lb JOIN borrowers b ON b.id = lb.borrower_id WHERE lb.loan_id = ANY($1::uuid[]) AND b.party_id IS NOT NULL`, [ids]), 12);
  assert.equal(await count(`partner_book_facts WHERE import_id = $1`, [firstImportId]), 12);
  // the actor on book.import is the partner user (rule 1): the import row's actor_id, the decision's approver, the completed event's actor — never ops_analyst, never a staff user
  const row = (await db.query<{ actor_id: string | null; partner_party_id: string; profile: string; status: string }>(`SELECT actor_id, partner_party_id::text AS partner_party_id, profile, status FROM partner_book_imports WHERE id = $1`, [firstImportId]))[0]!;
  assert.deepEqual([row.actor_id, row.partner_party_id, row.profile, row.status], [`human:${noraId}`, partnerA, "m3-v1", "loaded"]);
  const decision = (await db.query<{ agent: string; approved_by: string | null; approved_role: string | null; rationale: string }>(`SELECT agent, approved_by, approved_role, rationale FROM agent_decisions WHERE action = 'book.import' AND subject_id = $1`, [firstImportId]))[0]!;
  assert.deepEqual([decision.agent, decision.approved_by, decision.approved_role], ["portfolio", noraId, "partner_admin"]); assert.doesNotMatch(decision.rationale, /ops_analyst/);
  const completed = (await events("partner_book.import.completed")).filter((e) => e.payload["import_id"] === firstImportId);
  assert.equal(completed.length, 1); assert.deepEqual([completed[0]!.actor_kind, completed[0]!.actor_id, completed[0]!.actor_role, completed[0]!.payload["actor_id"], completed[0]!.payload["partner_id"], completed[0]!.payload["status"]], ["human", noraId, "partner_admin", `human:${noraId}`, partnerA, "loaded"]);
  assert.equal(await count(`agent_decisions WHERE approved_role = 'ops_analyst'`), 0); assert.equal(await count(`staff_users`), 0); assert.equal(await count(`staff_actions`), 0, "the partner prefix never writes a staff row");
  assert.equal((await events("partner_book.loan.loaded")).filter((e) => e.payload["import_id"] === firstImportId).length, 12);
  // rule 5 on the log: one partner_actions row for the drop — book.import, the import id, the person, the tenant, the role; no PII
  const logged = await actions(`partner_user_id = $1 AND action = 'book.import'`, [noraId]);
  assert.equal(logged.length, 1); assert.deepEqual([logged[0]!.subject_kind, logged[0]!.subject_id, logged[0]!.partner_party_id, logged[0]!.role, logged[0]!.result, logged[0]!.refusal_code], ["import", firstImportId, partnerA, "partner_admin", "ok", null]);
  assertNoPii(logged[0]!.row_text, "the book.import log row");
  // worked example A: 12 monitored loans, 0 servicing clocks armed — the only clocks are 33.1's; no timer of sections 1–19 on any of the 12; no ledger line
  assert.ok((await count(`timers`)) > timersBefore, "clocks were armed by the import");
  const clocks = await db.query<{ code: string; subject_kind: string; loan_id: string | null; status: string }>(`SELECT code, subject_kind, loan_id::text AS loan_id, status::text AS status FROM timers WHERE loan_id = ANY($1::uuid[]) OR (subject_kind = 'global' AND armed_at >= $2::timestamptz) ORDER BY code`, [ids, T0]);
  assert.deepEqual([...new Set(clocks.map((c) => c.code))].sort(), ["SM_PARTNER_BOOK_INVITATION_REMINDER_14", "SM_PARTNER_BOOK_TAPE_EXPECTED_7"], "only 33.1's clocks");
  assert.equal(clocks.filter((c) => c.code === "SM_PARTNER_BOOK_INVITATION_REMINDER_14" && c.loan_id !== null).length, 11, "one reminder clock per invitation");
  assert.equal(await count(`timers WHERE loan_id = ANY($1::uuid[]) AND code NOT LIKE 'SM_PARTNER_BOOK_%'`, [ids]), 0, "0 servicing clocks armed");
  assert.equal(await count(`ledger_lines WHERE loan_id = ANY($1::uuid[])`, [ids]), 0, "no ledger behind a monitored loan");
  // … and a cashiering command on one of the 12 refuses LOAN_MONITORED (33.1-T9; brief Session 2 step 4): loan 1's homeowner, through the borrower door
  const loan1 = await loanByNumber(1);
  const req = await api("POST", "/v1/borrower/auth/otp", { action: "request", channel: "email", destination: loanN(1).email });
  assert.equal(req.status, 200, JSON.stringify(req.body)); assert.equal(req.body["delivery"], "FAKE");
  const v = await api("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: req.body["challenge_id"], code: req.body["fake_code"] });
  assert.equal(v.status, 200, JSON.stringify(v.body)); await router.flows?.settle();
  const homeowner = v.body["token"] as string;
  for (const [command, body] of [["payment.makeOneTime", { amount_cents: "306979", date: "2026-09-15" }], ["autodraft.enroll", { draft_day: 1 }], ["escrow.requestAnalysis", {}]] as const) {
    const c = await api("POST", `/v1/borrower/commands/${command}`, { ...body, subject: { loan_id: loan1.id } }, bearer(homeowner));
    assert.equal(c.status, 409, `${command}: ${JSON.stringify(c.body)}`); assert.equal(c.body["code"], "LOAN_MONITORED");
  }
  assert.equal(await count(`loan_events WHERE loan_id = $1 AND type LIKE 'payment.%'`, [loan1.id]), 0, "nothing moved");
  assert.equal(await count(`timers WHERE loan_id = ANY($1::uuid[]) AND code NOT LIKE 'SM_PARTNER_BOOK_%'`, [ids]), 0, "still 0 servicing clocks");
  // the status line (rule 8): as of 2026-09-01, next expected 2026-09-08 (33.1's clock, read), not late, 12 monitored, 0 on hold, 1 import
  const status = await api("GET", "/v1/partner/book/status", undefined, bearer(nora.token));
  assert.equal(status.status, 200, JSON.stringify(status.body));
  assert.deepEqual([status.body["partner_party_id"], status.body["as_of_date"], status.body["next_expected"], status.body["late"], status.body["monitored_loans"], status.body["on_hold"], status.body["imports"], status.body["empty"], status.body["copy"]], [partnerA, DEMO_AS_OF, addDays(plainDate(DEMO_AS_OF), 7), false, 12, 0, 1, false, BOOK_COPY.upload]);
  const tapeClock = status.body["tape_clock"] as Json; assert.ok(tapeClock, "33.1's SM_PARTNER_BOOK_TAPE_EXPECTED_7 behind the line"); assert.equal(tapeClock["status"], "armed"); assert.ok(String(tapeClock["due_at"]) >= "2026-09-08" && String(tapeClock["due_at"]) < "2026-09-09T12", `due end of day 2026-09-08 ET: ${tapeClock["due_at"]}`);
  // the history (rule 7): one row, the partner user named as the uploader; the report by id (the same shape as the POST's answer)
  const history = await api("GET", "/v1/partner/book/imports", undefined, bearer(nora.token));
  assert.equal(history.status, 200); const rows = history.body["imports"] as Json[]; assert.equal(rows.length, 1);
  assert.deepEqual([rows[0]!["import_id"], rows[0]!["partner_party_id"], rows[0]!["as_of_date"], rows[0]!["status"], rows[0]!["rows_total"], rows[0]!["rows_loaded"], rows[0]!["loans_created"], rows[0]!["invitations_sent"], rows[0]!["uploaded_by"]], [firstImportId, partnerA, DEMO_AS_OF, "loaded", 12, 12, 12, 11, NORA.name]);
  const report = await api("GET", `/v1/partner/book/imports/${firstImportId}`, undefined, bearer(nora.token));
  assert.equal(report.status, 200, JSON.stringify(report.body).slice(0, 400));
  assert.deepEqual([report.body["import_id"], report.body["status"], report.body["rows_loaded"], report.body["uploaded_by"], (report.body["lines"] as Json[]).length, (report.body["loans"] as Json[]).length], [firstImportId, "loaded", 12, NORA.name, 12, 12]);
  assert.ok((report.body["loans"] as Json[]).some((l) => l["servicer_loan_number"] === loanN(1).servicer_loan_number), "the numbers in full to partner_admin (Open question 2)");
  assertNoPii(JSON.stringify(report.body), "the report"); assertNoPii(JSON.stringify(history.body), "the history");
  // rule 5 on the reads: partner_portal.viewed with the view, the person, the tenant — one row per request
  const viewed = await actions(`partner_user_id = $1 AND action = 'partner_portal.viewed' AND result = 'ok'`, [noraId]);
  assert.deepEqual(viewed.map((a) => [a.subject_kind, a.subject_id]).slice(-3), [["status", partnerA], ["imports", partnerA], ["import", firstImportId]]);
  for (const a of viewed) assertNoPii(a.row_text, `partner_actions ${a.id}`);
});

test("36.2-T2: Given the same files posted a second time, then the response is `already_loaded` and no new `partner_book_facts` rows are written.", { skip }, async () => {
  const before = await bookCounts(); assert.equal(before.facts, 12); assert.equal(before.imports, 1);
  const eventsBefore = await count(`loan_events`); const decisionsBefore = await count(`agent_decisions`); const messagesBefore = await count(`notice_deliveries`);
  // the same two files, as multipart: already_loaded with the first import id (rule 4)
  const again = await drop(nora, { as_of_date: DEMO_AS_OF, tape: book.tape, supplement: book.supplement });
  assert.equal(again.status, 200, JSON.stringify(again.body).slice(0, 400));
  assert.deepEqual([again.body["status"], again.body["import_id"], again.body["partner_party_id"], again.body["rows_loaded"]], ["already_loaded", firstImportId, partnerA, 12]);
  // … and as JSON with content_base64 (the other body 33.1 reads), a later as-of date named: the files are the key, the same answer
  const b64 = (bytes: Uint8Array | string): string => Buffer.from(bytes).toString("base64");
  const json = await api("POST", "/v1/partner/book/imports", { as_of_date: "2026-09-08", tape: { filename: "partner-book-demo.xlsx", content_base64: b64(book.tape) }, supplement: { filename: "partner-book-demo-supplement.csv", content_base64: b64(book.supplement) } }, bearer(nora.token));
  assert.equal(json.status, 200, JSON.stringify(json.body).slice(0, 400)); assert.deepEqual([json.body["status"], json.body["import_id"]], ["already_loaded", firstImportId]);
  // nothing written: no facts row, no import row, no event, no decision, no message, no clock; the history still has one row
  const after = await bookCounts();
  assert.deepEqual(after, before, "no row of the book is written by a repeat"); assert.equal(after.facts, 12, "partner_book_facts still holds 12 rows");
  assert.equal(await count(`loan_events`), eventsBefore); assert.equal(await count(`agent_decisions`), decisionsBefore); assert.equal(await count(`notice_deliveries`), messagesBefore);
  assert.equal(((await api("GET", "/v1/partner/book/imports", undefined, bearer(nora.token))).body["imports"] as Json[]).length, 1, "no second history row");
  // the log: three book.import rows now, all ok, the repeats naming the earlier import
  const logged = await actions(`partner_user_id = $1 AND action = 'book.import'`, [noraId]);
  assert.equal(logged.length, 3); assert.ok(logged.every((a) => a.subject_id === firstImportId && a.result === "ok"));
});

/** T3's later snapshot: 7 days on, loan 5's row absent; the review the next morning (07:05 ET, 20.1's run first). */
const T3_AS_OF = "2026-09-08"; const T3_NOW = "2026-09-09T12:00:00.000Z"; const T3_REVIEW = "2026-09-10T11:05:00.000Z";
test("36.2-T3: Given a later `as_of_date` tape that drops one loan, then that loan is `not_on_latest_tape` / on hold, it is absent from the next 33.2 review, and the partner GET holds lists it. `POST .../resolve` as the partner is `403`.", { skip }, async () => {
  oli = await invitedSession(nora, OLI, ["partner_ops"]); assert.equal(oli.role, "partner_ops");
  const loan5 = await loanByNumber(5); const l5 = loanN(5);
  assert.deepEqual(await holdsOf(runtime, partnerA), [], "nothing is on hold before the later tape");
  assert.deepEqual((await api("GET", "/v1/partner/book/holds", undefined, bearer(nora.token))).body["holds"], []);
  // the later full tape without loan 5's row, the same supplement — dropped by the partner_admin a week on
  clock.set(T3_NOW); await refresh();
  const r = await drop(nora, { as_of_date: T3_AS_OF, tape: tapeAsOf(T3_AS_OF, [5]), supplement: book.supplement });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 800)); laterImportId = r.body["import_id"] as string;
  assert.deepEqual([r.body["status"], r.body["rows_total"], r.body["rows_loaded"], r.body["loans_created"], r.body["loans_updated"], r.body["invitations_sent"]], ["loaded", 11, 11, 0, 0, 0]);
  const report = r.body["report"] as Json;
  assert.equal((report["gaps"] as Json)["not_on_latest_tape"], 1, "the report counts not_on_latest_tape = 1");
  assert.deepEqual(report["not_on_tape"], [{ loan_id: loan5.id, servicer_loan_number: l5.servicer_loan_number, last_as_of_date: DEMO_AS_OF }]);
  // loan 5: monitored, on hold (not_on_latest_tape), the event logged by the import (33.1's portfolio agent appends the per-loan events; the import row and its decision name the partner user)
  assert.equal((await loanByNumber(5)).status, "monitored"); assert.equal(await isOnHold(runtime, loan5.id), true); assert.equal(await isOnHold(runtime, (await loanByNumber(1)).id), false);
  const notOnTape = await events("partner_book.loan.not_on_tape", loan5.id);
  assert.equal(notOnTape.length, 1); assert.deepEqual([notOnTape[0]!.payload["as_of_date"], notOnTape[0]!.payload["import_id"], notOnTape[0]!.payload["servicer_loan_number"]], [T3_AS_OF, laterImportId, l5.servicer_loan_number]);
  assert.equal((await db.query<{ actor_id: string | null }>(`SELECT actor_id FROM partner_book_imports WHERE id = $1`, [laterImportId]))[0]!.actor_id, `human:${noraId}`, "the later tape's actor is the partner user too");
  // the partner GET holds lists it (rule 9): last four, first name + last initial, state, the last as-of it appeared on, the partner's latest as-of, held since; no resolve control, no PII
  for (const s of [nora, oli]) {
    const holds = await api("GET", "/v1/partner/book/holds", undefined, bearer(s.token));
    assert.equal(holds.status, 200, JSON.stringify(holds.body));
    const rows = holds.body["holds"] as Json[]; assert.equal(rows.length, 1); assert.equal(holds.body["count"], 1); assert.equal(holds.body["as_of_date"], T3_AS_OF);
    const h = rows[0]!;
    assert.deepEqual([h["loan_id"], h["servicer_loan_last4"], (h["homeowner"] as Json)["name"], h["state"], h["status"], h["last_as_of_date"], h["partner_as_of_date"]], [loan5.id, l5.servicer_loan_number.slice(-4), `${l5.first_name} ${l5.last_name[0]}.`, l5.state, "monitored", DEMO_AS_OF, T3_AS_OF]);
    assert.equal(typeof h["held_since"], "string"); assert.equal(h["resolutions"], undefined, "no resolve control"); assert.equal(h["servicer_loan_number"], undefined, "the last four only on a list row");
    assertPartnerGrade(JSON.stringify(holds.body), "the holds");
  }
  const status = await api("GET", "/v1/partner/book/status", undefined, bearer(nora.token));
  assert.deepEqual([status.body["as_of_date"], status.body["next_expected"], status.body["on_hold"], status.body["monitored_loans"], status.body["imports"], status.body["late"]], [T3_AS_OF, addDays(plainDate(T3_AS_OF), 7), 1, 12, 2, false]);
  // absent from the next 33.2 review (rule 9, DELTA-02): the review runtime with the FAKE rate feed, seeded as 33.2's harness seeds it; loan 5 reads not_now with reason
  // not_on_latest_tape — held out of candidacy, no opportunity, no offer — and every other loan is reviewed without the hold reason
  const rr = new Runtime({ db, registry: loadOverriddenRegistry(), clock, logger: createLogger("json", (line) => { logLines.push(line); }), rateFeed: new FakeRateFeed() });
  const seed = await seedEntryDemo(rr, { partner_id: partnerA, nmlsr_id: DEMO_PARTNER.nmlsr_id }); assert.equal(seed.partner_id, partnerA);
  clock.set(T3_REVIEW);
  const sweep = await rr.sweep();
  await refresh();
  assert.ok(sweep.refi?.ran, `the refinance check ran: ${sweep.refi?.reason}`); assert.ok(sweep.partner_book_review.ran, `the review ran: ${sweep.partner_book_review.reason}`);
  type ReviewRow = { loan_id: string; verdict: string; reasons: string[]; opportunity_id: string | null; facts: Json };
  const reviews = await db.query<ReviewRow>(`SELECT loan_id::text AS loan_id, verdict::text AS verdict, reasons, opportunity_id::text AS opportunity_id, facts FROM partner_book_reviews WHERE as_of_date = $1 AND loan_id IN (SELECT id FROM loans WHERE partner_party_id = $2) ORDER BY loan_id`, [T3_REVIEW.slice(0, 10), partnerA]);
  const review5 = reviews.find((x) => x.loan_id === loan5.id); assert.ok(review5, "loan 5's review row of the day");
  assert.equal(review5.verdict, "not_now"); assert.equal(review5.reasons[0], HOLD_REASON); assert.equal(HOLD_REASON, "not_on_latest_tape"); assert.ok((review5.facts["flags"] as string[]).includes("not_on_latest_tape"));
  const others = reviews.filter((x) => x.loan_id !== loan5.id);
  assert.equal(others.length, 11, "the rest of the book reviewed"); assert.ok(others.every((x) => !x.reasons.includes("not_on_latest_tape")), "only the absent loan carries the hold reason");
  assert.ok(!reviews.some((x) => x.loan_id === loan5.id && (x.verdict === "candidate" || x.verdict === "watching")), "absent from candidacy");
  // held out of candidacy: whatever 20.1's run detected on the loan's stored facts, the review's verdict is not_now and no offer is delivered (33.2's offer pass takes the day's candidates)
  assert.equal(await count(`refi_opportunities WHERE loan_id = $1 AND status IN ('offered', 'engaged')`, [loan5.id]), 0, "no offer on a held loan");
  assert.equal(await count(`partner_book_reviews WHERE loan_id = $1 AND verdict IN ('candidate', 'watching')`, [loan5.id]), 0);
  // POST …/resolve as the partner is 403 (rule 9): ROLE_REQUIRED{role: ops_analyst, act_as: []} before any read — the partner_admin, the partner_ops, the tenant's own loan and another tenant's alike; and no POST under …/holds
  const resolvedBefore = await count(`loan_events WHERE type = 'partner_book.loan.resolved'`);
  for (const [s, id] of [[nora, loan5.id], [oli, loan5.id], [nora, loanOfB], [nora, randomUUID()], [nora, "not-a-uuid"]] as const) {
    const d = await api("POST", `/v1/partner/book/loans/${id}/resolve`, { resolution: "paid_off", reason: "the partner reports the loan paid in full" }, bearer(s.token));
    assert.equal(d.status, 403, `${s.role} on ${id}: ${JSON.stringify(d.body)}`); assert.deepEqual([d.body["code"], d.body["role"], d.body["act_as"]], ["ROLE_REQUIRED", "ops_analyst", []]);
    assert.doesNotMatch(JSON.stringify(d.body), /Second Servicer|Okoro/, "the refusal reveals nothing");
  }
  const asAdmin = await api("POST", `/v1/partner/book/loans/${loan5.id}/resolve?role=partner_admin`, { resolution: "keep", reason: "x" }, bearer(nora.token)); assert.equal(asAdmin.status, 403); assert.equal(asAdmin.body["code"], "ROLE_REQUIRED");
  for (const p of ["/v1/partner/book/holds", `/v1/partner/book/holds/${loan5.id}`, `/v1/partner/book/holds/${loan5.id}/resolve`]) { const d = await api("POST", p, { resolution: "keep", reason: "x" }, bearer(nora.token)); assert.equal(d.status, 403, `${p}: ${JSON.stringify(d.body)}`); assert.equal(d.body["code"], "ROLE_REQUIRED"); }
  assert.equal((await loanByNumber(5)).status, "monitored"); assert.equal(await isOnHold(runtime, loan5.id), true, "the hold stands");
  assert.equal(await count(`loan_events WHERE type = 'partner_book.loan.resolved'`), resolvedBefore, "nothing written"); assert.equal(await count(`agent_decisions WHERE action = 'book.resolve'`), 0);
  const refused = await actions(`action = 'book.resolve' AND result = 'refused'`);
  assert.ok(refused.length >= 6, `${refused.length} refused resolve rows`); assert.ok(refused.every((a) => a.refusal_code === "ROLE_REQUIRED" && a.role === "ops_analyst" && a.partner_party_id === partnerA));
  assert.ok(refused.some((a) => a.subject_id === loan5.id && a.partner_user_id === noraId)); assert.ok(refused.some((a) => a.subject_id === loan5.id && a.partner_user_id === oli.partner_user_id));
  for (const a of refused) assertNoPii(a.row_text, `partner_actions ${a.id}`);
  // the partner_ops session reads the book (the history, a report, the status line) and cannot drop a tape (36.1-T2)
  assert.equal((await api("GET", "/v1/partner/book/imports", undefined, bearer(oli.token))).status, 200); assert.equal((await api("GET", `/v1/partner/book/imports/${laterImportId}`, undefined, bearer(oli.token))).status, 200); assert.equal((await api("GET", "/v1/partner/book/status", undefined, bearer(oli.token))).status, 200);
  const up = await drop(oli, { as_of_date: "2026-09-09", tape: tapeAsOf("2026-09-09"), supplement: book.supplement });
  assert.equal(up.status, 403, JSON.stringify(up.body)); assert.deepEqual([up.body["code"], up.body["role"], up.body["act_as"]], ["ROLE_REQUIRED", "partner_admin", []]);
  assert.equal(await count(`partner_book_imports WHERE partner_party_id = $1`, [partnerA]), 2, "nothing written by the refused drop");
});

/** T4's snapshot: the full book again two days on (loan 5 back — the hold lifts by itself, rule 9). */
const T4_AS_OF = "2026-09-10"; const T4_NOW = "2026-09-10T14:00:00.000Z";
test("36.2-T4: Given a partner_admin for partner A, when the multipart names partner B in a field, then that field is ignored and the import attaches to partner A.", { skip }, async () => {
  clock.set(T4_NOW); await refresh();
  const bLoansBefore = await loansOf(partnerB); assert.equal(bLoansBefore.length, 1); const bImportsBefore = await count(`partner_book_imports WHERE partner_party_id = $1`, [partnerB]);
  const aImportsBefore = await count(`partner_book_imports WHERE partner_party_id = $1`, [partnerA]);
  // partner A's admin drops the full book as of 2026-09-10 with every field a client could use to name another partner or a layout: partner (33.1's JSON field), partner_party_id, nmlsr_id, profile
  const r = await drop(nora, { as_of_date: T4_AS_OF, tape: tapeAsOf(T4_AS_OF), supplement: book.supplement, fields: { partner: JSON.stringify(PARTNER_B), partner_party_id: partnerB, nmlsr_id: PARTNER_B.nmlsr_id, profile: "other-layout-v9", legal_name: PARTNER_B.legal_name } });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 800));
  // the import attaches to partner A under m3-v1 (rules 2, 3); the answer does not mention the fields
  assert.deepEqual([r.body["status"], r.body["partner_party_id"], r.body["rows_loaded"], r.body["loans_created"], (r.body["report"] as Json)["profile"]], ["loaded", partnerA, 12, 0, "m3-v1"]);
  const importId = r.body["import_id"] as string;
  const row = (await db.query<{ partner_party_id: string; profile: string; actor_id: string | null; as_of_date: string }>(`SELECT partner_party_id::text AS partner_party_id, profile, actor_id, as_of_date::text AS as_of_date FROM partner_book_imports WHERE id = $1`, [importId]))[0]!;
  assert.deepEqual([row.partner_party_id, row.profile, row.actor_id, row.as_of_date], [partnerA, "m3-v1", `human:${noraId}`, T4_AS_OF]);
  assert.doesNotMatch(JSON.stringify(r.body), /other-layout-v9|Second Servicer/, "the dropped fields are not echoed");
  assert.ok(logLines.some((l) => l.includes("partner.book.import.fields_dropped") && l.includes("partner_party_id") && l.includes("profile")), "the dropped fields are on the server log (names only, never a value)");
  assert.ok(!logLines.some((l) => l.includes("partner.book.import.fields_dropped") && l.includes(partnerB)), "the named partner's id is not logged");
  // partner B is untouched: its one loan, its one import, its facts
  assert.deepEqual(await loansOf(partnerB), bLoansBefore); assert.equal(await count(`partner_book_imports WHERE partner_party_id = $1`, [partnerB]), bImportsBefore);
  assert.equal(await count(`partner_book_facts WHERE import_id = $1 AND loan_id = $2`, [importId, loanOfB]), 0); assert.equal(await count(`partner_book_facts WHERE loan_id = $1`, [loanOfB]), 1);
  assert.equal(await count(`partner_book_imports WHERE partner_party_id = $1`, [partnerA]), aImportsBefore + 1);
  assert.equal(await count(`partner_book_facts WHERE import_id = $1`, [importId]), 12, "12 facts rows of partner A's loans");
  // loan 5 is back on the tape: the hold lifts by itself (rule 9)
  assert.equal(await isOnHold(runtime, (await loanByNumber(5)).id), false); assert.deepEqual((await api("GET", "/v1/partner/book/holds", undefined, bearer(nora.token))).body["holds"], []);
  // rule 2 on the reads: the history is partner A's only, partner B's import is 404 NOT_FOUND to partner A (never 403), and the refusal is on the log without a homeowner field
  const history = await api("GET", "/v1/partner/book/imports", undefined, bearer(nora.token));
  const listed = (history.body["imports"] as Json[]).map((i) => i["import_id"]);
  assert.deepEqual(listed, [importId, laterImportId, firstImportId], "newest first, the tenant's only"); assert.ok(!listed.includes(importOfB));
  assert.ok((history.body["imports"] as Json[]).every((i) => i["partner_party_id"] === partnerA && i["uploaded_by"] === NORA.name));
  const other = await api("GET", `/v1/partner/book/imports/${importOfB}`, undefined, bearer(nora.token));
  assert.equal(other.status, 404, JSON.stringify(other.body)); assert.equal(other.body["code"], "NOT_FOUND"); assert.doesNotMatch(JSON.stringify(other.body), /Second Servicer|Okoro/);
  const refused = await actions(`partner_user_id = $1 AND subject_id = $2`, [noraId, importOfB]);
  assert.equal(refused.length, 1); assert.deepEqual([refused[0]!.action, refused[0]!.subject_kind, refused[0]!.result, refused[0]!.refusal_code, refused[0]!.partner_party_id], ["partner_portal.viewed", "import", "refused", "NOT_FOUND", partnerA]);
  assertNoPii(refused[0]!.row_text, "the refused log row");
  assert.equal((await api("GET", `/v1/partner/book/imports/${randomUUID()}`, undefined, bearer(nora.token))).status, 404); assert.equal((await api("GET", `/v1/partner/book/imports/not-a-uuid`, undefined, bearer(nora.token))).status, 404);
  // a partner_auditor reads the same report with the numbers as the last four (Open question 2) and cannot drop a tape
  aud = await invitedSession(nora, AUD, ["partner_auditor"]); assert.equal(aud.role, "partner_auditor");
  const audited = await api("GET", `/v1/partner/book/imports/${importId}`, undefined, bearer(aud.token));
  assert.equal(audited.status, 200, JSON.stringify(audited.body).slice(0, 300)); assert.equal(audited.body["acted_as"], "partner_auditor");
  const numbers = (audited.body["loans"] as Json[]).map((l) => String(l["servicer_loan_number"]));
  assert.equal(numbers.length, 12); assert.ok(numbers.every((n) => /^\d{4}$/.test(n)), `last four only: ${numbers.join(",")}`); assert.ok(!numbers.includes(loanN(1).servicer_loan_number));
  assert.ok(((audited.body["report"] as Json)["loans"] as Json[]).every((l) => /^\d{4}$/.test(String(l["servicer_loan_number"]))));
  assert.ok((audited.body["lines"] as Json[]).every((l) => /^\d{4}$/.test(String(l["servicer_loan_number"]))));
  const audUp = await drop(aud, { as_of_date: "2026-09-11", tape: tapeAsOf("2026-09-11"), supplement: book.supplement });
  assert.equal(audUp.status, 403); assert.deepEqual([audUp.body["code"], audUp.body["role"], audUp.body["act_as"]], ["ROLE_REQUIRED", "partner_admin", []]);
});

test("36.2-T5: Given a header that does not match `m3-v1`, then no rows are written and the partner sees the same header-refusal 33.1 already emits.", { skip }, async () => {
  const before = await bookCounts(); const eventsBefore = await count(`loan_events WHERE type LIKE 'partner_book.loan.%' OR type LIKE 'partner_book.account.%' OR type LIKE 'partner_book.invitation.%'`);
  const escalationsBefore = await count(`escalations WHERE owner_role = 'ops_analyst'`);
  // a file whose header row is not the profile's: two columns, none of m3-v1's required ones
  const bad = writeXlsx([["Loan", "Name"], ["1", "x"]], "M3");
  const r = await drop(nora, { as_of_date: "2026-09-12", tape: bad, supplement: book.supplement });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 600));
  // the same header-refusal 33.1 emits (rule 6): status rejected, the report's `rejected.missing_headers` naming the required columns the file lacks, nothing loaded
  assert.deepEqual([r.body["status"], r.body["partner_party_id"], r.body["rows_total"], r.body["rows_loaded"], r.body["loans_created"], r.body["invitations_sent"]], ["rejected", partnerA, 1, 0, 0, 0]);
  const rejected = (r.body["report"] as Json)["rejected"] as Json; assert.ok(rejected, "the report carries the refusal");
  const missing = rejected["missing_headers"] as string[];
  assert.ok(missing.includes("Servicer Loan Number"), missing.join(", "));
  for (const c of M3_V1.columns.filter((c) => c.required)) assert.ok(missing.includes(c.header), `${c.header} is named as missing`);
  assert.deepEqual((r.body["report"] as Json)["loans"], []); assert.equal((r.body["report"] as Json)["profile"], "m3-v1");
  // no row of the book is written: no loan, facts, terms, party, invitation, notice or clock; no book event (discrepancy 2: 33.1's own record of the rejected attempt stands)
  const after = await bookCounts();
  const rejectedImportId = r.body["import_id"] as string; assert.match(rejectedImportId, /^[0-9a-f-]{36}$/);
  assert.deepEqual({ ...after, imports: before.imports }, before, "no loan, facts, terms, party, invitation, notice or clock");
  assert.equal(after.imports, before.imports + 1, "33.1's rejected import row"); assert.equal(after.loaded, before.loaded, "not a loaded import");
  assert.equal((await db.query<{ status: string }>(`SELECT status FROM partner_book_imports WHERE id = $1`, [rejectedImportId]))[0]!.status, "rejected");
  assert.equal(await count(`loan_events WHERE type LIKE 'partner_book.loan.%' OR type LIKE 'partner_book.account.%' OR type LIKE 'partner_book.invitation.%'`), eventsBefore);
  const completed = (await events("partner_book.import.completed")).filter((e) => e.payload["import_id"] === rejectedImportId);
  assert.equal(completed.length, 1); assert.equal(completed[0]!.payload["status"], "rejected"); assert.equal(completed[0]!.actor_id, noraId, "the partner actor on 33.1's record");
  assert.equal(await count(`escalations WHERE owner_role = 'ops_analyst'`), escalationsBefore + 1, "33.1's escalation goes to ops_analyst, not to the partner");
  // the status line still reads the last loaded tape (rule 8); the history lists the rejected attempt with its missing headers (34.3's row) — the same shape by id
  const status = await api("GET", "/v1/partner/book/status", undefined, bearer(nora.token));
  assert.deepEqual([status.body["as_of_date"], status.body["monitored_loans"], status.body["on_hold"]], [T4_AS_OF, 12, 0]);
  const byId = await api("GET", `/v1/partner/book/imports/${rejectedImportId}`, undefined, bearer(nora.token));
  assert.equal(byId.status, 200); assert.equal(byId.body["status"], "rejected"); assert.deepEqual(((byId.body["report"] as Json)["rejected"] as Json)["missing_headers"], missing); assert.deepEqual(byId.body["lines"], []);
  const history = await api("GET", "/v1/partner/book/imports", undefined, bearer(nora.token));
  assert.equal((history.body["imports"] as Json[])[0]!["import_id"], rejectedImportId); assert.equal((history.body["imports"] as Json[])[0]!["status"], "rejected");
  // a partner_ops posting the same bad file is refused before the file is read (rule 1): no import row at all
  const imports = await count(`partner_book_imports`);
  const ops = await drop(oli, { as_of_date: "2026-09-12", tape: bad });
  assert.equal(ops.status, 403); assert.equal(ops.body["code"], "ROLE_REQUIRED"); assert.equal(await count(`partner_book_imports`), imports);
  // the same bad file again answers the recorded refusal (33.1's file key), still nothing written
  const again = await drop(nora, { as_of_date: "2026-09-12", tape: bad, supplement: book.supplement });
  assert.equal(again.status, 200); assert.deepEqual([again.body["status"], again.body["import_id"]], ["rejected", rejectedImportId]);
  assert.deepEqual(await bookCounts(), after);
  // a bad body: no tape, or no as-of date — 400 before anything runs
  const noTape = await api("POST", "/v1/partner/book/imports", { as_of_date: "2026-09-12" }, bearer(nora.token)); assert.equal(noTape.status, 400); assert.equal(noTape.body["code"], "BAD_REQUEST");
  const noDate = await api("POST", "/v1/partner/book/imports", { tape: { filename: "x.csv", content: "a,b\n" } }, bearer(nora.token)); assert.equal(noDate.status, 400);
  assert.deepEqual(await bookCounts(), after);
});
