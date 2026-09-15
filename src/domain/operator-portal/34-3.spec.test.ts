// 34.3 Partner book operations: uploads, import history, the book, reviews, readiness, the daily report
// spec/sections/34-operator-portal/34-3-partner-book-operations-uploads-import-history-the-book-reviews-readiness-the-daily-report.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// The harness: own database `<base>_34_3` (dropped, created, migrated), the API server of src/runtime/server.ts in-process with
// the ops console mounted at /ops/api (createApiServer's default `console`), the FAKE e-delivery port (the door's code is echoed
// as `fake_code`), a FixedClock at 07:20 America/New_York on 2026-09-15 — past 20.1's 06:30 run, 33.2's 07:00 review and 33.3's
// 07:15 readiness pass, before 34.3's 07:45 receipt escalation — that never moves (so no staff session idles out). The staff
// (34.1): the bootstrap admin invites an ops_analyst and a compliance user; each enrols (code + password) and signs in. The
// fixture book (33.1 rule 7) is uploaded through the console's multipart route as the analyst (T1), then a second tape as of
// 2026-09-08 with loan 5 absent and loan 1 one payment further along (T2 — the second tape of 33.1 T11 / the book-ops module
// test), loan 5 is resolved `paid_off` from the portal (T3), the day's passes run on runtime.sweep() with 33.2's scripted analyst
// (T4/T5), and every partner-book route is read back against the stored rows (T6).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { connect, type Db } from "../../infra/db/client.ts";
import { testDatabase } from "../../infra/db/test-db.ts";
import { decodeEntityData } from "../../infra/db/entities.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock } from "../../kernel/events/index.ts";
import { addDays, addMonths, plainDate } from "../../kernel/calendar/date.ts";
import { Runtime, type SweepReport } from "../../runtime/app.ts";
import { createApiServer, listen } from "../../runtime/server.ts";
import { createLogger } from "../../runtime/log.ts";
import { AnthropicLlm } from "../../runtime/borrower/agent/llm.ts";
import { seedEntryDemo } from "../../runtime/entry-seed.ts";
import { bootstrapStaffAdmin } from "../../runtime/staff/auth.ts";
import { maskEmail as directoryMaskEmail, maskPhone as directoryMaskPhone } from "../../runtime/directory/mask.ts";
import { sweepDailyReports } from "../../runtime/book-ops/routes.ts";
import { REPORT_RULE_SET_VERSION, REPORT_MODEL_VERSION, REPORT_PROMPT_VERSION, REPORT_DOCUMENT_KIND, renderDailyReport, type DailyReportRow } from "../../runtime/book-ops/report.ts";
import { FakeRateFeed } from "../../infra/integrations/rates.ts";
import { FakeReviewers } from "../../infra/integrations/reviewers.ts";
import { writeXlsx } from "../../infra/files/xlsx.ts";
import { scheduledUpb } from "../leads-pricing/ops-20-1.ts";
import { scriptedClient, type Scene } from "../borrower/eval/scripted-client.ts";
import { M3_V1 } from "../partner-book/profiles/m3-v1.ts";
import { DEMO_AS_OF, DEMO_PARTNER, demoBook, type DemoLoan } from "../partner-book/fixtures/partner-book-demo.ts";

const { url: DB_URL, skip } = await testDatabase(import.meta.url);
const TOKEN = "ops-" + randomUUID();
const R = randomUUID().slice(0, 8);
type Json = Record<string, unknown>;

/** 2026-09-15 07:20 America/New_York (EDT): past 20.1's 06:30 run, 33.2's 07:00 review and 33.3's 07:15 pass; before 34.3's 07:45 escalation. */
const AS_OF = "2026-09-15"; const NOW = "2026-09-15T11:20:00.000Z";
/** The second tape's as-of date, 7 days after the first (33.1 rule 8's cadence). */
const AS_OF_2 = "2026-09-08";
const clock = new FixedClock(NOW);

// ---------------------------------------------------------------- 33.2's scripted analyst (rule 4): review_facts then review_write, every figure a {{facts.*}} token
const CLEAN_RATIONALE = "Your rate today is {{facts.rate_now}} and this morning's sheet shows {{facts.candidate_rate}}, which lowers the payment by {{facts.monthly_delta}}. The offer is on the card here.";
const CANDIDATE_FLAGS = ["value_low_confidence"];
const ANALYST_CANDIDATE: Scene = { when: /verdict is candidate/, calls: [{ name: "review.facts", input: {} }, { name: "review.write", input: { rationale: CLEAN_RATIONALE, flags: CANDIDATE_FLAGS } }], text: "Written." };
const ANALYST_WATCHING: Scene = { when: /verdict is watching/, calls: [{ name: "review.facts", input: {} }, { name: "review.write", input: { rationale: "Rates are not below yours yet; the book is checked every morning.", flags: [] } }], text: "Written." };
const ANALYST_NOT_NOW: Scene = { when: /verdict is not now/, calls: [{ name: "review.facts", input: {} }, { name: "review.write", input: { rationale: "Not today; the loan is held out of this morning's review.", flags: [] } }], text: "Written." };
const ANALYST_EXCLUDED: Scene = { when: /verdict is excluded/, calls: [{ name: "review.facts", input: {} }, { name: "review.write", input: { rationale: "The loan is out of today's review because of what is on the partner's file; nothing is offered.", flags: ["pay_string_late"] } }], text: "Written." };
const analystScripted = scriptedClient([ANALYST_CANDIDATE, ANALYST_WATCHING, ANALYST_NOT_NOW, ANALYST_EXCLUDED]);

// the people (34.1): the bootstrap admin, the analyst who uploads and resolves, the compliance user who exports
const ADA = { email: `ada.admin.${R}@example.test`, name: "Ada Admin", password: `ada-correct-horse-${R}` };
const OLI = { email: `oli.analyst.${R}@example.test`, name: "Oli Analyst", password: `oli-analyst-pass-${R}` };
const CARA = { email: `cara.compliance.${R}@example.test`, name: "Cara Compliance", password: `cara-reviewer-pass-${R}` };
type Session = { token: string; session_id: string; staff_user_id: string };
let oli: Session; let cara: Session;

let db: Db; let runtime: Runtime; let base = ""; let close: () => Promise<void> = async () => undefined;
let partnerPartyId = "";
const logLines: string[] = [];
const book = demoBook();
const loanN = (n: number): DemoLoan => book.loans.find((l) => l.n === n)!;
const col = (key: string): number => { const i = M3_V1.columns.findIndex((c) => c.key === key); assert.ok(i >= 0, `the profile's ${key} column`); return i; };
const J = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x));
const sha256hex = (s: string): string => createHash("sha256").update(s).digest("hex");

test.before(async () => {
  if (skip) return;
  db = connect(DB_URL);
  const logger = createLogger("json", (line) => { logLines.push(line); if (process.env["FLOW_DEBUG"] && /error|unhandled|partner|book|"status":[45]/i.test(line)) process.stderr.write(line + "\n"); });
  // the FAKE feed publishes the day's sheet (20.1), the FAKE MLO reviews offer terms (32.11), 33.2's scripted analyst plays rule 4's turn
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock, logger, rateFeed: new FakeRateFeed(), reviewers: new FakeReviewers({ delaySeconds: 0 }), analystLlm: new AnthropicLlm({ client: analystScripted.client, model: "scripted" }) });
  // operational prerequisites: the partner's parties{servicer} row (33.1's ensurePartner finds it by legal name) and the entry seed's program / sheet / matrix / cost schedule for 20.1's run
  partnerPartyId = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id, contact) VALUES ('servicer', $1, $2, $3, '{"phone": "+18005550199"}'::jsonb) RETURNING id`, [DEMO_PARTNER.legal_name, DEMO_PARTNER.servicer_number, DEMO_PARTNER.mers_org_id]))[0]!.id;
  const seed = await seedEntryDemo(runtime, { partner_id: partnerPartyId, nmlsr_id: DEMO_PARTNER.nmlsr_id });
  assert.equal(seed.partner_id, partnerPartyId, "the demo partner is the fixture partner");
  const server = createApiServer({ runtime, apiToken: TOKEN, logger, borrower: { environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost"], urlSecret: "test-secret" } });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => db.end().then(() => resolve())); });
  // 34.1: the bootstrap admin, enrolled and signed in, invites the analyst and the compliance user; each enrols and signs in (the code and the password)
  const boot = await bootstrapStaffAdmin(runtime, ADA.email, { legal_name: ADA.name }); assert.equal(boot.created, true);
  await enrol(ADA); const admin = await signIn(ADA);
  await invite(admin.token, OLI, ["ops_analyst"]); await invite(admin.token, CARA, ["compliance"]);
  await enrol(OLI); await enrol(CARA);
  oli = await signIn(OLI); cara = await signIn(CARA);
});
test.after(async () => { if (!skip) await close(); });

// ---------------------------------------------------------------- helpers over the API (34.1's doors, the console's routes, the action log)
type Reply = { status: number; body: Json };
let sent = 0;   // every /ops/api request this suite made; the staff_actions row lands after the answer is on the wire, so the log is read once it has caught up
async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  if (path.startsWith("/ops/api/")) sent += 1;
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-forwarded-for": "10.34.3.1", "user-agent": "34.3-spec", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text(); return { status: r.status, body: text ? (JSON.parse(text) as Json) : {} };
}
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
/** The session acting under its role (34.1 rule 3: `x-staff-role` names the role among the ones held). */
const as = (s: Session, role: string): Record<string, string> => ({ ...bearer(s.token), "x-staff-role": role });
/** The door's first half: a code to the e-mail (FAKE, echoed) verified into an enrol/step token. */
async function codeToken(email: string): Promise<string> {
  const c = await api("POST", "/ops/api/auth/code", { email });
  assert.equal(c.status, 200, JSON.stringify(c.body)); assert.equal(c.body["delivery"], "FAKE"); assert.equal(typeof c.body["fake_code"], "string");
  const v = await api("POST", "/ops/api/auth/verify", { email, code: c.body["fake_code"] });
  assert.equal(v.status, 200, JSON.stringify(v.body)); assert.equal(typeof v.body["token"], "string");
  return v.body["token"] as string;
}
async function enrol(p: { email: string; password: string }): Promise<string> {
  const token = await codeToken(p.email);
  const r = await api("POST", "/ops/api/auth/password", { token, password: p.password });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body["enrolled"], true);
  return r.body["staff_user_id"] as string;
}
async function signIn(p: { email: string; password: string }): Promise<Session> {
  await codeToken(p.email);
  const r = await api("POST", "/ops/api/auth/signin", { email: p.email, password: p.password });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { token: r.body["token"] as string, session_id: r.body["session_id"] as string, staff_user_id: r.body["staff_user_id"] as string };
}
async function invite(adminToken: string, p: { email: string; name: string }, roles: string[]): Promise<void> {
  const r = await api("POST", "/ops/api/staff/invite", { email: p.email, legal_name: p.name, roles }, bearer(adminToken));
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body["status"], "invited");
}
/** 34.3 rule 1: the upload form's multipart body (partner, as-of date, profile, the tape and the supplement) posted as the session. */
async function upload(s: Session, asOf: string, tape: Uint8Array, supplement: string | null, filename: string): Promise<Reply> {
  const fd = new FormData();
  fd.set("partner_legal_name", DEMO_PARTNER.legal_name); fd.set("partner_nmlsr_id", DEMO_PARTNER.nmlsr_id); fd.set("partner_servicer_number", DEMO_PARTNER.servicer_number); fd.set("partner_mers_org_id", DEMO_PARTNER.mers_org_id);
  fd.set("as_of_date", asOf); fd.set("profile", "m3-v1"); fd.set("tape", new Blob([tape]), filename);
  if (supplement !== null) fd.set("supplement", new Blob([supplement]), "partner-book-demo-supplement.csv");
  sent += 1;
  const r = await fetch(`${base}/ops/api/partner-book/imports`, { method: "POST", headers: { ...as(s, "ops_analyst"), "x-forwarded-for": "10.34.3.1", "user-agent": "34.3-spec" }, body: fd });
  const text = await r.text(); return { status: r.status, body: text ? (JSON.parse(text) as Json) : {} };
}
const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, params))[0]!.n);
type ActionRow = { id: string; staff_user_id: string | null; session_id: string | null; route: string; method: string; subject_kind: string | null; subject_id: string | null; command: string | null; result: string; refusal_code: string | null };
/** The action log once it has caught up with every request sent (34.1 rule 4: one row per request, written after the answer). */
async function actions(where = "", params: unknown[] = []): Promise<ActionRow[]> {
  for (let i = 0; i < 100 && (await count(`staff_actions`)) < sent; i++) await new Promise((r) => setTimeout(r, 20));
  return db.query<ActionRow>(`SELECT id::text AS id, staff_user_id::text AS staff_user_id, session_id::text AS session_id, route, method, subject_kind, subject_id, command, result, refusal_code FROM staff_actions ${where} ORDER BY at, created_at, id`, params);
}
type EventRow = { loan_id: string | null; actor_kind: string; actor_id: string; actor_role: string | null; payload: Json; occurred_at: string };
const events = async (type: string): Promise<EventRow[]> => db.query<EventRow>(`SELECT loan_id::text AS loan_id, actor_kind::text AS actor_kind, actor_id, actor_role, payload, occurred_at::text AS occurred_at FROM loan_events WHERE type = $1 ORDER BY sequence`, [type]);
type DecisionRow = { id: string; agent: string; action: string; subject_kind: string | null; subject_id: string | null; loan_id: string | null; rationale: string; approved_by: string | null; approved_role: string | null; rule_set_version: string; model_version: string | null; prompt_version: string | null; confidence: string | null };
const decisions = async (action: string, where = "", params: unknown[] = []): Promise<DecisionRow[]> => db.query<DecisionRow>(`SELECT id::text AS id, agent, action, subject_kind, subject_id, loan_id::text AS loan_id, rationale, approved_by, approved_role, rule_set_version, model_version, prompt_version, confidence::text AS confidence FROM agent_decisions WHERE action = $1 ${where} ORDER BY created_at, id`, [action, ...params]);
type LoanRow = { id: string; servicer_loan_number: string; status: string };
const loanOf = async (n: number): Promise<LoanRow> => { const r = (await db.query<LoanRow>(`SELECT id::text AS id, servicer_loan_number, status::text AS status FROM loans WHERE partner_party_id = $1 AND servicer_loan_number = $2`, [partnerPartyId, loanN(n).servicer_loan_number]))[0]; assert.ok(r, `loan ${n} on the book`); return r; };
type FactsRow = { as_of_date: string; facts: Json; raw: Json; import_id: string };
const factsOf = async (loanId: string): Promise<FactsRow[]> => db.query<FactsRow>(`SELECT as_of_date::text AS as_of_date, facts, raw, import_id::text AS import_id FROM partner_book_facts WHERE loan_id = $1 ORDER BY as_of_date, created_at`, [loanId]);
/** NO_DESTINATION / ROLE_MASK: no full e-mail of the fixture (every homeowner is @example.com), no phone number (+1 area 555-01xx) anywhere in a response. */
const noDestination = (v: unknown, where: string): void => { const s = J(v); assert.ok(!/[a-z0-9._-]{2,}@example\.com/i.test(s), `${where} carries a destination: ${s.match(/.{0,40}@example\.com/)?.[0]}`); assert.ok(!/\+1\d{10}|\b\d{3}[-. ]?555[-. ]?01\d{2}\b/.test(s), `${where} carries a phone number: ${s.match(/.{0,20}555.{0,10}/)?.[0]}`); };
const onlyTokens = (text: string, where: string): void => { assert.doesNotMatch(text.replace(/\{\{[a-zA-Z0-9_.:-]+\}\}/g, ""), /\d/, `${where} carries a digit outside a token: ${text}`); };
const programId = (): string => `prog-refi-${partnerPartyId.slice(0, 8)}`;   // seedEntryDemo's id scheme = importPartnerBook's (33.1 registers the same program when absent)

// ---------------------------------------------------------------- the second tape (T2): loan 5 absent, loan 1 one payment further along, every row as of 2026-09-08
function secondTape(): Uint8Array {
  const header = book.tapeRows[0]!;
  const rows = book.tapeRows.slice(1).filter((r) => r[col("servicer_loan_number")] !== loanN(5).servicer_loan_number).map((r) => [...r]);
  for (const r of rows) r[col("as_of_date")] = AS_OF_2;
  const one = rows.find((r) => r[col("servicer_loan_number")] === loanN(1).servicer_loan_number)!;
  const l1 = loanN(1); const upb24 = scheduledUpb(l1.original_cents, l1.note_rate_pct, l1.term_months, l1.payments_made + 1);
  one[col("upb_cents")] = Number(upb24) / 100; one[col("total_upb_cents")] = Number(upb24) / 100;
  one[col("next_due_date")] = addMonths(plainDate(l1.next_due_date), 1); one[col("last_payment_date")] = addMonths(plainDate(l1.last_payment_date), 1); one[col("interest_paid_to_date")] = addMonths(plainDate(l1.last_payment_date), 1);
  one[col("remaining_term_months")] = l1.remaining_term_months - 1;
  return writeXlsx([header, ...rows], "M3");
}
const UPB_23 = 44136613n;   // worked example A: loan 1's UPB after 23 payments, $441,366.13
const UPB_24 = scheduledUpb(loanN(1).original_cents, loanN(1).note_rate_pct, 360, loanN(1).payments_made + 1);

// what the earlier tests leave for the later ones (the file runs in spec order)
let firstImportId = ""; let secondImportId = ""; let loan1Id = ""; let loan5Id = "";
let sweep: SweepReport | undefined;
let resolveBody: Json = {}; let exportBody: Json = {};

test("34.3-T1: Given an `ops_analyst` session, when they upload the fixture tape and supplement, then the import runs with `actor = {human, <staff_user_id>, ops_analyst}` (the import's decision record and `partner_book.import.completed` name them), the report page lists 12 rows loaded, the exceptions and gap counts, and the `staff_actions` row carries the import id; given the same files again, then `already_loaded` linking the first import.", { skip }, async () => {
  // the upload through the console's multipart route as the analyst → 33.1 book.import (importPartnerBook) with the person as actor
  const r = await upload(oli, DEMO_AS_OF, book.tape, book.supplement, "partner-book-demo.xlsx");
  assert.equal(r.status, 200, J(r.body).slice(0, 600)); assert.equal(r.body["status"], "loaded"); assert.equal(r.body["rows_total"], 12); assert.equal(r.body["rows_loaded"], 12); assert.equal(r.body["loans_created"], 12); assert.equal(r.body["partner_party_id"], partnerPartyId);
  firstImportId = r.body["import_id"] as string; assert.match(firstImportId, /^[0-9a-f-]{36}$/);
  loan1Id = (await loanOf(1)).id; loan5Id = (await loanOf(5)).id;
  const stored = (await db.query<{ actor_id: string | null; status: string; rows_loaded: number; rows_exception: number; report: Json }>(`SELECT actor_id, status, rows_loaded, rows_exception, report FROM partner_book_imports WHERE id = $1`, [firstImportId]))[0]!;
  assert.equal(stored.status, "loaded"); assert.equal(Number(stored.rows_loaded), 12); assert.equal(stored.actor_id, `human:${oli.staff_user_id}`, "the import row names the analyst");
  // the report page (GET …/imports/{id}): 12 rows loaded, the exceptions by code with row and servicer loan number, the gap counts — the stored report, never recounted
  const page = await api("GET", `/ops/api/partner-book/imports/${firstImportId}`, undefined, as(oli, "ops_analyst"));
  assert.equal(page.status, 200, J(page.body).slice(0, 300));
  assert.equal(page.body["import_id"], firstImportId); assert.equal(page.body["rows_loaded"], 12); assert.equal(page.body["rows_total"], 12); assert.equal(page.body["status"], "loaded"); assert.equal(page.body["as_of_date"], DEMO_AS_OF); assert.equal(page.body["uploaded_by"], `human:${oli.staff_user_id}`);
  assert.equal(page.body["loans_created"], 12); assert.equal(page.body["loans_updated"], 0); assert.equal(page.body["loans_unchanged"], 0); assert.equal(page.body["on_hold"], 0); assert.equal((page.body["lines"] as Json[]).length, 12);
  const report = page.body["report"] as Json; const exceptions = report["exceptions"] as Json[]; const gaps = report["gaps"] as Json;
  assert.ok(Array.isArray(exceptions)); assert.equal(page.body["rows_exception"], Number(stored.rows_exception)); assert.deepEqual(exceptions, stored.report["exceptions"], "the exceptions are the stored report's, with the row number and the servicer loan number");
  for (const e of exceptions) { assert.equal(typeof e["row"], "number"); assert.equal(typeof e["code"], "string"); assert.ok("servicer_loan_number" in e); }
  const byCode: Record<string, number> = {}; for (const e of exceptions) byCode[String(e["code"])] = (byCode[String(e["code"])] ?? 0) + 1;
  assert.deepEqual(page.body["exceptions_by_code"], byCode, "the exceptions by code count the report's own rows");
  assert.deepEqual(gaps, stored.report["gaps"], "the gap counts are the stored report's");
  for (const k of ["contact", "tin", "dob", "mailing_address", "coborrower", "consents", "not_on_latest_tape", "contact_bounced", "invitation_held"]) assert.equal(typeof gaps[k], "number", `gap count ${k}`);
  assert.equal(gaps["contact"], 1, "loan 12 has no supplement row (33.1 rule 7)"); assert.equal(gaps["not_on_latest_tape"], 0);
  assert.equal((page.body["not_on_tape"] as Json[]).length, 0);
  noDestination(page.body, "the report page");
  // the staff_actions row carries the import id (34.1 rule 4): the multipart route, the bus command, the subject
  const rows = await actions(`WHERE route = '/ops/api/partner-book/imports' AND method = 'POST'`);
  assert.equal(rows.length, 1, "one action row for the upload");
  assert.deepEqual([rows[0]!.staff_user_id, rows[0]!.session_id, rows[0]!.command, rows[0]!.subject_kind, rows[0]!.subject_id, rows[0]!.result, rows[0]!.refusal_code], [oli.staff_user_id, oli.session_id, "book.import", "partner_book_import", firstImportId, "ok", null]);
  // the same files again: already_loaded, linking the first import; no second history row, nothing written
  const again = await upload(oli, DEMO_AS_OF, book.tape, book.supplement, "partner-book-demo.xlsx");
  assert.equal(again.status, 200, J(again.body).slice(0, 300)); assert.equal(again.body["status"], "already_loaded"); assert.equal(again.body["import_id"], firstImportId, "the answer links the first import");
  assert.equal(await count(`partner_book_imports WHERE partner_party_id = $1`, [partnerPartyId]), 1, "no second history row");
  assert.equal(await count(`loans WHERE partner_party_id = $1`, [partnerPartyId]), 12); assert.equal(await count(`partner_book_facts WHERE import_id = $1`, [firstImportId]), 12);
  const history = await api("GET", `/ops/api/partner-book/imports?partner=${partnerPartyId}`, undefined, as(oli, "ops_analyst"));
  assert.equal(history.status, 200); assert.equal((history.body["imports"] as Json[]).length, 1); assert.equal((history.body["imports"] as Json[])[0]!["import_id"], firstImportId);
  const againRow = (await actions(`WHERE route = '/ops/api/partner-book/imports' AND method = 'POST'`))[1]!;
  assert.deepEqual([againRow.command, againRow.subject_id, againRow.result], ["book.import", firstImportId, "ok"], "the second upload's row links the first import too");
  // the import ran with actor = {human, <staff_user_id>, ops_analyst}: the import's decision record and partner_book.import.completed name them
  const decision = await decisions("book.import", `AND subject_kind = 'partner_book_import' AND subject_id = $2`, [firstImportId]);
  assert.equal(decision.length, 1, "one book.import decision for the import"); assert.equal(decision[0]!.agent, "portfolio"); assert.equal(decision[0]!.rule_set_version, "partner_book.m3.v1");
  const completed = (await events("partner_book.import.completed")).filter((e) => e.payload["import_id"] === firstImportId);
  assert.equal(completed.length, 1); assert.equal(completed[0]!.payload["status"], "loaded"); assert.equal(completed[0]!.payload["rows_loaded"], 12); assert.equal(completed[0]!.payload["partner_id"], partnerPartyId);
  const dec = decision[0]!; const ev = completed[0]!;
  const decisionNamed = dec.approved_by === oli.staff_user_id && dec.approved_role === "ops_analyst";   // how the bus names a human on a decision (src/app/commands.ts: approvedBy / approvedRole)
  const eventNamed = (ev.actor_kind === "human" && ev.actor_id === oli.staff_user_id && ev.actor_role === "ops_analyst") || ev.payload["actor_id"] === `human:${oli.staff_user_id}` || ev.payload["staff_user_id"] === oli.staff_user_id;
  assert.ok(decisionNamed && eventNamed, [
    `34.3-T1: the import must run with actor = {human, ${oli.staff_user_id}, ops_analyst} and both the decision record and partner_book.import.completed must name them (partner_book_imports.actor_id does: ${stored.actor_id}).`,
    `  decision record (agent_decisions ${dec.id}): approved_by=${dec.approved_by} approved_role=${dec.approved_role} — ${decisionNamed ? "ok" : "NOT NAMED: src/runtime/partner-book.ts importPartnerBook's ctx.decide({ agent: \"portfolio\", action: \"book.import\", … }) passes no approvedBy / approvedRole for a human actor"}`,
    `  partner_book.import.completed: actor ${ev.actor_kind}:${ev.actor_id} (role ${ev.actor_role}), payload keys ${Object.keys(ev.payload).sort().join(",")} — ${eventNamed ? "ok" : "NOT NAMED: src/runtime/partner-book.ts importPartnerBook appends it with actor: PORTFOLIO_AGENT and no actor_id / staff_user_id in the payload"}`,
  ].join("\n"));
});

test("34.3-T2: Given a second upload with a later as-of date, loan 1's UPB one payment lower and loan 5 absent, then the history lists both imports, the second reads 1 updated / 10 unchanged / 1 on hold, its detail shows loan 1's UPB before and after, and the hold queue lists loan 5 with its last as-of date.", { skip }, async () => {
  assert.ok(firstImportId, "T1's import");
  const r = await upload(oli, AS_OF_2, secondTape(), book.supplement, "partner-book-2026-09-08.xlsx");
  assert.equal(r.status, 200, J(r.body).slice(0, 600)); assert.equal(r.body["status"], "loaded"); assert.equal(r.body["rows_loaded"], 11); assert.equal(r.body["loans_updated"], 1); assert.equal(r.body["loans_created"], 0);
  secondImportId = r.body["import_id"] as string; assert.notEqual(secondImportId, firstImportId);
  // the history lists both imports, newest first, each with what it changed
  const h = await api("GET", `/ops/api/partner-book/imports?partner=${partnerPartyId}`, undefined, as(oli, "ops_analyst"));
  assert.equal(h.status, 200, J(h.body).slice(0, 300));
  const imports = h.body["imports"] as Json[]; assert.deepEqual(imports.map((i) => i["import_id"]), [secondImportId, firstImportId]);
  const [second, first] = imports as [Json, Json];
  assert.equal(first["as_of_date"], DEMO_AS_OF); assert.equal(first["loans_created"], 12); assert.equal(first["loans_updated"], 0); assert.equal(first["loans_unchanged"], 0); assert.equal(first["on_hold"], 0); assert.equal(first["uploaded_by"], `human:${oli.staff_user_id}`);
  assert.equal(second["as_of_date"], AS_OF_2); assert.equal(second["rows_total"], 11); assert.equal(second["rows_loaded"], 11); assert.equal(second["loans_created"], 0); assert.equal(second["uploaded_by"], `human:${oli.staff_user_id}`);
  assert.deepEqual([second["loans_updated"], second["loans_unchanged"], second["on_hold"]], [1, 10, 1], "the second import reads 1 updated / 10 unchanged / 1 on hold");
  assert.equal(second["invitations_sent"], 0, "no new party, no new invitation");
  // the second import's detail: the per-loan lines, loan 1 updated with the UPB before and after (two stored facts side by side), loan 5 not on the tape
  const d = await api("GET", `/ops/api/partner-book/imports/${secondImportId}`, undefined, as(oli, "ops_analyst"));
  assert.equal(d.status, 200, J(d.body).slice(0, 300));
  const lines = d.body["lines"] as Json[]; assert.equal(lines.length, 11);
  assert.deepEqual(lines.map((l) => l["change"]).sort(), ["unchanged", "unchanged", "unchanged", "unchanged", "unchanged", "unchanged", "unchanged", "unchanged", "unchanged", "unchanged", "updated"]);
  const one = lines.find((l) => l["servicer_loan_number"] === loanN(1).servicer_loan_number)!; assert.ok(one, "loan 1's line");
  assert.equal(one["loan_id"], loan1Id); assert.equal(one["change"], "updated"); assert.equal(one["as_of_date"], AS_OF_2); assert.equal(one["previous_as_of_date"], DEMO_AS_OF);
  const diff = one["diff"] as Json[]; const upb = diff.find((x) => x["key"] === "upb_cents")!; assert.ok(upb, `the UPB differed: ${J(diff)}`);
  assert.equal(upb["label"], "UPB"); assert.equal(upb["before"], String(UPB_23)); assert.equal(upb["before"], "44136613"); assert.equal(upb["after"], String(UPB_24)); assert.ok(BigInt(String(upb["after"])) < UPB_23, "one payment lower");
  assert.ok(diff.find((x) => x["key"] === "next_due_date"), "next due differed"); assert.ok(!diff.find((x) => x["key"] === "note_rate_pct"), "the rate did not"); assert.ok(!diff.find((x) => x["key"] === "pi_cents"), "P&I did not");
  const facts = await factsOf(loan1Id); assert.equal(facts.length, 2);
  assert.equal(facts[0]!.facts["upb_cents"], upb["before"]); assert.equal(facts[1]!.facts["upb_cents"], upb["after"]); assert.equal(facts[1]!.import_id, secondImportId);
  for (const l of lines.filter((x) => x["change"] === "unchanged")) assert.equal((l["diff"] as Json[]).length, 0);
  assert.deepEqual((d.body["not_on_tape"] as Json[]).map((n) => [n["loan_id"], n["servicer_loan_number"], n["last_as_of_date"]]), [[loan5Id, loanN(5).servicer_loan_number, DEMO_AS_OF]]);
  assert.equal((d.body["report"] as Json)["not_on_tape"] !== undefined, true);
  // the hold queue lists loan 5 with the last as-of date it appeared on (33.1 rule 8), the resolve control beside it
  const q = await api("GET", `/ops/api/partner-book/loans?partner=${partnerPartyId}&hold=true`, undefined, as(oli, "ops_analyst"));
  assert.equal(q.status, 200, J(q.body).slice(0, 300));
  const queue = q.body["hold_queue"] as Json[]; assert.equal(queue.length, 1);
  assert.deepEqual([queue[0]!["loan_id"], queue[0]!["servicer_loan_number"], queue[0]!["last_as_of_date"], queue[0]!["partner_as_of_date"], queue[0]!["status"]], [loan5Id, loanN(5).servicer_loan_number, DEMO_AS_OF, AS_OF_2, "monitored"]);
  assert.deepEqual(queue[0]!["resolutions"], ["paid_off", "transferred_out", "keep"]); assert.ok(queue[0]!["not_on_tape_since"], "partner_book.loan.not_on_tape logged by the second import");
  const held = q.body["loans"] as Json[]; assert.equal(held.length, 1, "?hold=true narrows the book to the held loan"); assert.equal(held[0]!["loan_id"], loan5Id); assert.equal(held[0]!["on_hold"], true); assert.equal(held[0]!["facts_as_of"], DEMO_AS_OF);
  assert.equal((q.body["counts"] as Json)["on_hold"], 1); assert.equal((q.body["counts"] as Json)["loans"], 12);
  const notOnTape = (await events("partner_book.loan.not_on_tape")).filter((e) => e.loan_id === loan5Id); assert.equal(notOnTape.length, 1); assert.equal(notOnTape[0]!.payload["import_id"], secondImportId); assert.equal(notOnTape[0]!.payload["last_as_of_date"], DEMO_AS_OF);
  assert.equal((await loanOf(5)).status, "monitored", "never silently closed");
  noDestination(h.body, "the history"); noDestination(d.body, "the import detail"); noDestination(q.body, "the hold queue");
});

test("34.3-T3: Given loan 5 on hold, when the analyst resolves it `paid_off` with a reason, then 33.1's `book.resolve` ran with the staff actor, `loans.status = paid_off`, `partner_book.loan.resolved` is logged, the hold queue is empty and the loan's page shows the resolution.", { skip }, async () => {
  assert.ok(secondImportId, "T2's import");
  const reason = "the partner confirmed the payoff of 2026-09-03";
  // another role may not resolve (34.1 rule 3: 403 ROLE_REQUIRED{role} before any write)
  const denied = await api("POST", `/ops/api/partner-book/loans/${loan5Id}/resolve`, { resolution: "paid_off", reason }, as(cara, "compliance"));
  assert.equal(denied.status, 403); assert.equal(denied.body["code"], "ROLE_REQUIRED"); assert.equal(denied.body["role"], "ops_analyst"); assert.equal((await loanOf(5)).status, "monitored");
  // the analyst resolves it: 33.1 book.resolve on the bus with the staff member as the actor
  const r = await api("POST", `/ops/api/partner-book/loans/${loan5Id}/resolve`, { resolution: "paid_off", reason }, as(oli, "ops_analyst"));
  assert.equal(r.status, 200, J(r.body).slice(0, 600)); resolveBody = r.body;
  assert.equal(r.body["loan_id"], loan5Id); assert.equal(r.body["resolution"], "paid_off"); assert.ok(r.body["decision_id"], "the book.resolve decision");
  const out = r.body["output"] as Json; assert.equal(out["status"], "paid_off"); assert.equal(out["was_on_hold"], true); assert.equal(out["last_as_of_date"], DEMO_AS_OF); assert.equal(out["partner_as_of_date"], AS_OF_2);
  assert.ok((r.body["events"] as string[]).includes("partner_book.loan.resolved"));
  // loans.status = paid_off
  assert.equal((await loanOf(5)).status, "paid_off");
  // partner_book.loan.resolved is logged, loan-scoped, with the staff actor
  const resolved = (await events("partner_book.loan.resolved")).filter((e) => e.loan_id === loan5Id); assert.equal(resolved.length, 1);
  assert.deepEqual([resolved[0]!.actor_kind, resolved[0]!.actor_id, resolved[0]!.actor_role], ["human", oli.staff_user_id, "ops_analyst"], "the event names the staff actor");
  assert.deepEqual([resolved[0]!.payload["resolution"], resolved[0]!.payload["reason"], resolved[0]!.payload["was_on_hold"], resolved[0]!.payload["status"], resolved[0]!.payload["partner_id"]], ["paid_off", reason, true, "paid_off", partnerPartyId]);
  // the decision record: 33.1's book.resolve by the portfolio agent's rule set, approved by the person
  const dec = await decisions("book.resolve", `AND loan_id = $2`, [loan5Id]); assert.equal(dec.length, 1);
  assert.equal(dec[0]!.id, r.body["decision_id"]); assert.equal(dec[0]!.agent, "portfolio"); assert.equal(dec[0]!.rule_set_version, "partner_book.m3.v1");
  assert.deepEqual([dec[0]!.approved_by, dec[0]!.approved_role], [oli.staff_user_id, "ops_analyst"]); assert.match(dec[0]!.rationale, /paid_off .*ops_analyst/);
  // the hold queue is empty
  const q = await api("GET", `/ops/api/partner-book/loans?partner=${partnerPartyId}`, undefined, as(oli, "ops_analyst"));
  assert.equal(q.status, 200); assert.deepEqual(q.body["hold_queue"], []); assert.equal((q.body["counts"] as Json)["on_hold"], 0);
  const five = (q.body["loans"] as Json[]).find((l) => l["loan_id"] === loan5Id)!; assert.equal(five["status"], "paid_off"); assert.equal(five["on_hold"], false);
  assert.equal(((q.body["counts"] as Json)["by_status"] as Json)["paid_off"], 1); assert.equal(((q.body["counts"] as Json)["by_status"] as Json)["monitored"], 11);
  assert.equal(((await api("GET", `/ops/api/partner-book/loans?partner=${partnerPartyId}&hold=true`, undefined, as(oli, "ops_analyst"))).body["loans"] as Json[]).length, 0);
  // the loan's page shows the resolution (and the answer carried the page already)
  const p = await api("GET", `/ops/api/partner-book/loans/${loan5Id}`, undefined, as(oli, "ops_analyst"));
  assert.equal(p.status, 200, J(p.body).slice(0, 300));
  assert.equal((p.body["loan"] as Json)["status"], "paid_off"); assert.equal(p.body["on_hold"], false); assert.equal(p.body["hold"], null);
  const res = p.body["resolutions"] as Json[]; assert.equal(res.length, 1);
  assert.deepEqual([res[0]!["resolution"], res[0]!["reason"], res[0]!["actor"], res[0]!["was_on_hold"], res[0]!["status"]], ["paid_off", reason, `human:${oli.staff_user_id}`, true, "paid_off"]);
  assert.ok(res[0]!["at"]);
  assert.deepEqual(((r.body["loan"] as Json)["resolutions"] as Json[]).map((x) => x["resolution"]), ["paid_off"]);
  assert.equal(((p.body["not_on_tape"] as Json[])[0]!)["as_of_date"], AS_OF_2, "the hold's history stays on the page");
  // the action log: the resolve route, the bus command, the loan as subject, the analyst; the refused attempt with its code
  const rows = await actions(`WHERE route = $1`, [`/ops/api/partner-book/loans/${loan5Id}/resolve`]); assert.equal(rows.length, 2);
  assert.deepEqual([rows[0]!.staff_user_id, rows[0]!.result, rows[0]!.refusal_code, rows[0]!.subject_kind, rows[0]!.subject_id], [cara.staff_user_id, "refused", "ROLE_REQUIRED", "loan", loan5Id]);
  assert.deepEqual([rows[1]!.staff_user_id, rows[1]!.session_id, rows[1]!.command, rows[1]!.subject_kind, rows[1]!.subject_id, rows[1]!.result], [oli.staff_user_id, oli.session_id, "book.resolve", "loan", loan5Id, "ok"]);
  noDestination(r.body, "the resolve answer"); noDestination(p.body, "the loan page");
});

test("34.3-T4: Given the 33.2 and 33.3 passes for a day, when the analyst opens the day view, then reviews count 2 candidates / 6 watching / 0 not now / 3 excluded (the fixture's 12-row tape with loan 5 paid off in T3: 11 monitored loans), readiness counts the candidates checked with not-ready by missing item, both run receipts show with their times, and loan 1's page shows its review (verdict, reasons in words, rationale, engine facts) and readiness (items with status and source).", { skip }, async () => {
  assert.equal((await loanOf(5)).status, "paid_off", "T3's resolution");
  // the morning's passes at 07:20 ET: 20.1's run (06:30) → 33.2's review (07:00, the scripted analyst) → 33.3's readiness (07:15) → 34.3's daily-report hook
  assert.equal(clock.now(), NOW);
  sweep = await runtime.sweep();
  assert.ok(sweep.refi?.ran, `the refinance check ran: ${sweep.refi?.reason}`);
  assert.ok(sweep.partner_book_review.ran, `the review ran: ${sweep.partner_book_review.reason}`); assert.equal(sweep.partner_book_review.programs.length, 1);
  assert.ok(sweep.partner_book_readiness.ran, `the readiness pass ran: ${sweep.partner_book_readiness.skipped}`);
  const pr = sweep.partner_book_review.programs[0]!; assert.equal(pr.program_id, programId());
  // the day view (GET …/reviews?partner=&as_of=): counts by verdict — a count of the day's partner_book_reviews rows
  const day = await api("GET", `/ops/api/partner-book/reviews?partner=${partnerPartyId}&as_of=${AS_OF}`, undefined, as(oli, "ops_analyst"));
  assert.equal(day.status, 200, J(day.body).slice(0, 300)); assert.equal(day.body["as_of_date"], AS_OF); assert.equal(day.body["partner_party_id"], partnerPartyId);
  const reviews = day.body["reviews"] as Json; const byVerdict = reviews["by_verdict"] as Record<string, number>;
  const stored = await db.query<{ verdict: string; n: string }>(`SELECT r.verdict, count(*)::text AS n FROM partner_book_reviews r JOIN loans l ON l.id = r.loan_id WHERE r.as_of_date = $1 AND l.partner_party_id = $2 GROUP BY r.verdict`, [AS_OF, partnerPartyId]);
  const expected: Record<string, number> = { candidate: 0, watching: 0, not_now: 0, excluded: 0 }; for (const s of stored) expected[s.verdict] = Number(s.n);
  assert.deepEqual(byVerdict, expected, "the counts by verdict are the rows");
  // the spec's counts (review finding: the T4 row once quoted 33.2's 13-loan fixture — the 12 tape rows plus the portal-only loan 13 — which this process's own T2 title, "1 updated / 10
  // unchanged / 1 on hold", rules out; the row now states this fixture's): the 12-row tape with loan 5 resolved paid_off in T3 before the passes, so 11 monitored loans are reviewed —
  // loans 1 and 2 candidates, loans 8 (30 days late), 10 (foreclosure referral) and 11 (bankruptcy) excluded, the other 6 watching, none not_now (nothing on hold)
  assert.deepEqual(byVerdict, { candidate: 2, watching: 6, not_now: 0, excluded: 3 }, "2 candidates / 6 watching / 0 not now / 3 excluded — the spec's figures for the fixture's 12-row tape with loan 5 paid off");
  assert.equal(reviews["count"], 11); assert.equal((reviews["lines"] as Json[]).length, 11); assert.equal(reviews["on_hold"], 0);
  const numbers = (v: string): string[] => (reviews["lines"] as Json[]).filter((l) => l["verdict"] === v).map((l) => String(l["servicer_loan_number"])).sort();
  assert.deepEqual(numbers("candidate"), [loanN(1).servicer_loan_number, loanN(2).servicer_loan_number].sort()); assert.deepEqual(numbers("excluded"), [loanN(8).servicer_loan_number, loanN(10).servicer_loan_number, loanN(11).servicer_loan_number].sort());
  assert.ok(!(reviews["lines"] as Json[]).some((l) => l["loan_id"] === loan5Id), "a paid-off loan is not reviewed");
  assert.equal(reviews["analyst_turns"], 11, "the scripted analyst took every turn"); assert.deepEqual(reviews["analyst_skipped_by_reason"], {});
  // readiness: the candidates checked, not ready by missing item — a count of the day's readiness_checks rows
  const readiness = day.body["readiness"] as Json;
  const checks = await db.query<{ loan_id: string; ready: boolean; missing: string[] }>(`SELECT k.loan_id::text AS loan_id, k.ready, k.missing FROM readiness_checks k JOIN loans l ON l.id = k.loan_id WHERE k.as_of_date = $1 AND l.partner_party_id = $2`, [AS_OF, partnerPartyId]);
  assert.equal(readiness["checked"], checks.length); assert.equal(readiness["checked"], 2, "the two candidates were checked"); assert.equal(readiness["ready"], 0); assert.equal(readiness["not_ready"], 2);
  assert.deepEqual(new Set(checks.map((c) => c.loan_id)), new Set([loan1Id, (await loanOf(2)).id]));
  const byItem: Record<string, number> = {}; for (const c of checks) for (const m of c.missing) byItem[m] = (byItem[m] ?? 0) + 1;
  assert.deepEqual(readiness["by_missing_item"], byItem, "not ready by missing item counts the rows' missing lists");
  for (const m of ["identity", "ssn", "credit", "income", "assets", "esign", "credit_authorization"]) assert.equal(byItem[m], 2, `${m} missing on both candidates (33.3 T1)`);
  assert.equal((readiness["lines"] as Json[]).length, 2); for (const l of readiness["lines"] as Json[]) { assert.equal(l["ready"], false); assert.ok((l["items"] as Json[]).length > 0); }
  // both run receipts with their times against the 07:30 ET expectations
  const receipts = day.body["receipts"] as Json; const rr = (receipts["review"] as Json[])[0]!; const rd = receipts["readiness"] as Json;
  assert.equal((receipts["review"] as Json[]).length, 1);
  assert.deepEqual([rr["present"], rr["at"], rr["expected_by"], rr["late"], rr["run_id"], rr["partner_id"], rr["program_id"]], [true, NOW, "2026-09-15T11:30:00.000Z", false, pr.run_id, partnerPartyId, pr.program_id]);
  assert.equal((rr["payload"] as Json)["candidates"], 2); assert.equal((rr["payload"] as Json)["reviewed"], 11);
  assert.deepEqual([rd["present"], rd["at"], rd["expected_by"], rd["late"]], [true, NOW, "2026-09-15T11:30:00.000Z", false]); assert.equal((rd["payload"] as Json)["checked"], 2);
  assert.equal(rr["at"], (await events("partner_book.review.run_completed"))[0]!.payload["at"]); assert.equal(rd["run_id"], (await events("partner_book.readiness.run_completed"))[0]!.payload["run_id"]);
  assert.deepEqual(day.body["escalations"], [], "07:20 ET: no missing-receipt escalation");
  // the readiness route answers the same day view
  const rdv = await api("GET", `/ops/api/partner-book/readiness?partner=${partnerPartyId}&as_of=${AS_OF}`, undefined, as(oli, "ops_analyst")); assert.equal(rdv.status, 200); assert.deepEqual(rdv.body, day.body);
  const viewed = (await events("book.viewed")).filter((e) => e.payload["view"] === "reviews"); assert.ok(viewed.length >= 1); assert.equal(viewed.at(-1)!.payload["staff_user_id"], oli.staff_user_id); assert.equal(viewed.at(-1)!.payload["partner_id"], partnerPartyId);
  // loan 1's page: the review (verdict, reasons in words, the analyst's rationale, the engine's facts) and readiness (items with status and source)
  const p = await api("GET", `/ops/api/partner-book/loans/${loan1Id}`, undefined, as(oli, "ops_analyst"));
  assert.equal(p.status, 200, J(p.body).slice(0, 300));
  const rv = (p.body["reviews"] as Json[]).find((x) => x["as_of_date"] === AS_OF)!; assert.ok(rv, "the day's review on the page");
  const row = (await db.query<{ verdict: string; reasons: string[]; facts: Json; analyst: Json; decision_id: string; opportunity_id: string | null; run_id: string }>(`SELECT verdict, reasons, facts, analyst, decision_id::text AS decision_id, opportunity_id, run_id FROM partner_book_reviews WHERE loan_id = $1 AND as_of_date = $2`, [loan1Id, AS_OF]))[0]!;
  assert.equal(rv["verdict"], "candidate"); assert.equal(rv["verdict"], row.verdict); assert.ok(String(rv["verdict_words"]).length > 0); assert.equal(rv["run_id"], row.run_id); assert.equal(rv["opportunity_id"], row.opportunity_id); assert.ok(rv["opportunity_id"]);
  assert.deepEqual(rv["reasons"], row.reasons); const words = rv["reasons_in_words"] as string[]; assert.equal(words.length, row.reasons.length); for (const w of words) { assert.ok(w.length > 0); assert.doesNotMatch(w, /\d/, `reasons in words carry no digit: ${w}`); }
  const analyst = rv["analyst"] as Json; assert.equal(analyst["rationale"], CLEAN_RATIONALE, "the scripted analyst's rationale"); onlyTokens(String(analyst["rationale"]), "the rationale"); assert.deepEqual(analyst["flags"], CANDIDATE_FLAGS); assert.equal(analyst["skipped"], null); assert.equal(analyst["model_version"], "scripted"); assert.ok(analyst["turn_id"]);
  assert.deepEqual(rv["facts"], row.facts, "the engine's facts as stored"); assert.equal((rv["facts"] as Json)["upb_cents"], String(UPB_24), "the engine read the latest tape"); assert.equal((rv["facts"] as Json)["note_rate_pct"], "7.250"); assert.ok((rv["facts"] as Json)["candidate_rate_pct"]);
  assert.equal(rv["decision_id"], row.decision_id);
  const rdz = (p.body["readiness"] as Json[]).filter((x) => x["as_of_date"] === AS_OF); assert.equal(rdz.length, 1); const rz = rdz[0]!;
  assert.equal(rz["ready"], false); assert.ok((rz["missing"] as string[]).includes("identity")); assert.equal(rz["loan_id"], loan1Id); assert.ok(rz["decision_id"]);
  const items = rz["items"] as Json[]; assert.ok(items.length >= 7);
  for (const it of items) { assert.ok(["present", "stale", "missing", "not_applicable"].includes(String(it["status"])), `status ${String(it["status"])}`); assert.ok("source_table" in it && "source_id" in it && "as_of" in it && "valid_until" in it, `item ${String(it["item"])} carries its source`); assert.match(String(it["rule_ref"]), /^33\.3 rule 1/); }
  const present = items.filter((it) => it["status"] === "present"); assert.ok(present.length >= 2, "contact and value present"); for (const it of present) assert.ok(it["source_table"], `${String(it["item"])} names its source row`);
  assert.ok(items.some((it) => it["item"] === "contact" && it["status"] === "present")); assert.ok(items.some((it) => it["item"] === "value" && it["status"] === "present"));
  const storedItems = (await db.query<{ items: Json[] }>(`SELECT items FROM readiness_checks WHERE loan_id = $1 AND as_of_date = $2`, [loan1Id, AS_OF]))[0]!.items; assert.deepEqual(items, storedItems, "the items as stored");
  const offer = (p.body["offers"] as Json[]).find((o) => o["as_of_date"] === AS_OF)!; assert.ok(offer, "the day's opportunity on the page"); assert.equal(offer["opportunity_id"], row.opportunity_id);
  noDestination(day.body, "the day view"); noDestination(p.body, "loan 1's page");
});

test("34.3-T5: Given the sweep after the readiness pass, then one `partner_book_daily_reports` row exists for the partner and day with the review counts, the fair-lending extract id, the readiness counts, `last_as_of_date` and `next_expected`; given `compliance` exports it, then a hashed document exists and `staff_actions` records the export.", { skip }, async () => {
  assert.ok(sweep, "T4's passes"); const hook = sweep.partner_book_daily_reports; assert.ok(hook, "the sweep's daily-report hook ran");
  assert.equal(hook.as_of_date, AS_OF); assert.equal(hook.produced, 1); assert.equal(hook.escalated, 0, "07:20 ET is before the 07:45 escalation");
  const again = await sweepDailyReports(runtime); assert.equal(again.produced, 0, "a second sweep appends nothing (nothing changed)");
  // one row for the partner and day, produced by the sweep
  type ReportDb = { id: string; produced_by: string; document_id: string | null; review: DailyReportRow["review"]; readiness: DailyReportRow["readiness"]; book: DailyReportRow["book"] };
  const rows = await db.query<ReportDb>(`SELECT id::text AS id, produced_by, document_id::text AS document_id, review, readiness, book FROM partner_book_daily_reports WHERE partner_party_id = $1 AND as_of_date = $2 ORDER BY created_at, id`, [partnerPartyId, AS_OF]);
  assert.equal(rows.length, 1, "one partner_book_daily_reports row for the partner and day"); const row = rows[0]!;
  assert.equal(row.produced_by, "sweep"); assert.equal(row.document_id, null);
  assert.equal(await count(`partner_book_daily_reports`), 1, "one row on the platform: one partner, one day");
  // the review counts: the day's partner_book.review.run_completed receipt, figure for figure
  const receipt = (await events("partner_book.review.run_completed")).find((e) => e.payload["partner_id"] === partnerPartyId)!.payload;
  assert.equal(row.review.absent, false); assert.equal(row.review.source, "receipt"); assert.equal(row.review.run_id, receipt["run_id"]); assert.equal(row.review.program_id, programId());
  for (const k of ["reviewed", "candidates", "watching", "not_now", "excluded", "offers_delivered", "expired", "analyst_turns", "analyst_skipped"] as const) assert.equal(row.review[k], receipt[k], `review.${k} is the receipt's`);
  assert.deepEqual([row.review.reviewed, row.review.candidates, row.review.watching, row.review.not_now, row.review.excluded], [11, 2, 6, 0, 3]);
  assert.deepEqual(row.review.analyst_skipped_by_reason, receipt["analyst_skipped_by_reason"]);
  // the fair-lending extract id: 20.1's run of the day names it, and the extract entity exists
  const run = (await db.query<{ id: string; data: unknown }>(`SELECT id, data FROM entity_current WHERE kind = 'refi_trigger_runs' AND data->>'program_id' = $1 AND data->>'as_of_date' = $2`, [programId(), AS_OF]))[0]!; assert.ok(run, "20.1's run of the day");
  const extractId = String(decodeEntityData(run.data)["fair_lending_extract_document_id"]); assert.equal(extractId, `fle-${programId()}-${AS_OF}`);
  assert.equal(row.review.fair_lending_extract_id, extractId); assert.equal(row.review.refi_run_id, run.id);
  assert.equal(await count(`entity_current WHERE kind = 'fair_lending_extracts' AND id = $1`, [extractId]), 1, "the extract entity exists");
  // the readiness counts: the day's partner_book.readiness.run_completed receipt
  const rd = (await events("partner_book.readiness.run_completed"))[0]!.payload;
  assert.equal(row.readiness.absent, false); assert.equal(row.readiness.run_id, rd["run_id"]); assert.equal(row.readiness.checked, rd["checked"]); assert.equal(row.readiness.ready, rd["ready"]); assert.equal(row.readiness.not_ready, rd["not_ready"]);
  assert.deepEqual([row.readiness.checked, row.readiness.ready, row.readiness.not_ready, row.readiness.applications_opened, row.readiness.du_runs], [2, 0, 2, 0, 0]);
  const byItem: Record<string, number> = {}; for (const l of rd["loans"] as Json[]) for (const m of l["missing"] as string[]) byItem[m] = (byItem[m] ?? 0) + 1;
  assert.deepEqual(row.readiness.not_ready_by_item, byItem);
  // the book summary: loans by status (counts of rows), last_as_of_date and next_expected (last + 7 days: SM_PARTNER_BOOK_TAPE_EXPECTED_7)
  assert.deepEqual(row.book, { loans_monitored: 11, on_hold: 0, paid_off: 1, transferred_out: 0, last_as_of_date: AS_OF_2, next_expected: addDays(plainDate(AS_OF_2), 7), imports: 2 });
  assert.equal(row.book.next_expected, "2026-09-15");
  // the decision record (AI agent design)
  const dec = await decisions("book.daily_report", `AND subject_kind = 'partner_book_daily_report' AND subject_id = $2`, [row.id]); assert.equal(dec.length, 1);
  assert.equal(dec[0]!.agent, "portfolio"); assert.equal(dec[0]!.rule_set_version, REPORT_RULE_SET_VERSION); assert.equal(dec[0]!.rule_set_version, "partner_book.report.v1"); assert.equal(dec[0]!.model_version, REPORT_MODEL_VERSION); assert.equal(dec[0]!.model_version, "deterministic"); assert.equal(dec[0]!.prompt_version, REPORT_PROMPT_VERSION); assert.equal(dec[0]!.prompt_version, "34.3-v1"); assert.equal(Number(dec[0]!.confidence), 1);
  assert.ok(dec[0]!.rationale.includes(extractId)); assert.ok(dec[0]!.rationale.includes(partnerPartyId)); assert.ok(dec[0]!.rationale.includes(AS_OF));
  // the analyst may not export (rule 6: compliance's); the refusal is logged with its code
  const notCompliance = await api("POST", "/ops/api/partner-book/daily-report/export", { partner: partnerPartyId, as_of: AS_OF }, as(oli, "ops_analyst"));
  assert.equal(notCompliance.status, 403); assert.equal(notCompliance.body["code"], "ROLE_REQUIRED"); assert.equal(notCompliance.body["role"], "compliance"); assert.equal(await count(`documents WHERE kind = $1`, [REPORT_DOCUMENT_KIND]), 0);
  // compliance exports it: a hashed document
  const x = await api("POST", "/ops/api/partner-book/daily-report/export", { partner: partnerPartyId, as_of: AS_OF }, as(cara, "compliance"));
  assert.equal(x.status, 201, J(x.body).slice(0, 300)); exportBody = x.body;
  assert.equal(x.body["created"], true); assert.equal(x.body["report_id"] !== row.id, true, "the export is a newer row"); assert.equal(x.body["partner_party_id"], partnerPartyId); assert.equal(x.body["as_of_date"], AS_OF);
  const content = x.body["content"] as string; assert.equal(x.body["sha256"], sha256hex(content)); assert.equal(x.body["byte_size"], Buffer.byteLength(content, "utf8")); assert.ok(content.includes(extractId));
  const documentId = x.body["document_id"] as string; assert.match(documentId, /^[0-9a-f-]{36}$/);
  const doc = (await db.query<{ kind: string; sha256: string; byte_size: string; mime_type: string; metadata: Json }>(`SELECT kind, sha256, byte_size::text AS byte_size, mime_type, metadata FROM documents WHERE id = $1`, [documentId]))[0]!;
  assert.ok(doc, "the documents row"); assert.equal(doc.kind, REPORT_DOCUMENT_KIND); assert.equal(doc.sha256, x.body["sha256"]); assert.equal(Number(doc.byte_size), x.body["byte_size"]); assert.equal(doc.mime_type, "application/json");
  assert.deepEqual([doc.metadata["exported_by"], doc.metadata["exported_role"], doc.metadata["report_id"], doc.metadata["as_of_date"]], [`human:${cara.staff_user_id}`, "compliance", row.id, AS_OF]);
  // append-only: the export is a newer row carrying document_id with the same content; the first row is untouched
  const after = await db.query<ReportDb>(`SELECT id::text AS id, produced_by, document_id::text AS document_id, review, readiness, book FROM partner_book_daily_reports WHERE partner_party_id = $1 AND as_of_date = $2 ORDER BY created_at, id`, [partnerPartyId, AS_OF]);
  assert.equal(after.length, 2); assert.equal(after[0]!.id, row.id); assert.equal(after[0]!.document_id, null); assert.equal(after[1]!.id, x.body["report_id"]); assert.equal(after[1]!.document_id, documentId); assert.deepEqual(after[1]!.review, row.review); assert.deepEqual(after[1]!.book, row.book);
  assert.equal(content, renderDailyReport({ id: row.id, partner_party_id: partnerPartyId, partner_legal_name: DEMO_PARTNER.legal_name, as_of_date: AS_OF, review: row.review, readiness: row.readiness, book: row.book, produced_by: row.produced_by, document_id: null, created_at: NOW, decision_id: null }), "the hash covers the report's substance");
  await assert.rejects(db.query(`UPDATE partner_book_daily_reports SET produced_by = 'x' WHERE id = $1`, [row.id]));
  // the same export again is the same document; the sweep still appends nothing
  const x2 = await api("POST", "/ops/api/partner-book/daily-report/export", { partner: partnerPartyId, as_of: AS_OF }, as(cara, "compliance")); assert.equal(x2.status, 200); assert.equal(x2.body["created"], false); assert.equal(x2.body["document_id"], documentId);
  assert.equal((await sweepDailyReports(runtime)).produced, 0); assert.equal(await count(`partner_book_daily_reports`), 2);
  // staff_actions records the export: the route, the command, the document as subject, the compliance user
  const rows2 = await actions(`WHERE route = '/ops/api/partner-book/daily-report/export'`); assert.equal(rows2.length, 3);
  assert.deepEqual([rows2[0]!.staff_user_id, rows2[0]!.result, rows2[0]!.refusal_code], [oli.staff_user_id, "refused", "ROLE_REQUIRED"]);
  assert.deepEqual([rows2[1]!.staff_user_id, rows2[1]!.session_id, rows2[1]!.method, rows2[1]!.command, rows2[1]!.subject_kind, rows2[1]!.subject_id, rows2[1]!.result, rows2[1]!.refusal_code], [cara.staff_user_id, cara.session_id, "POST", "book.daily_report:export", "document", documentId, "ok", null]);
  assert.deepEqual([rows2[2]!.command, rows2[2]!.subject_id, rows2[2]!.result], ["book.daily_report:export", documentId, "ok"]);
  noDestination(row, "the report row"); noDestination(content, "the export");
});

test("34.3-T6: Given every partner-book response, then homeowners' contact is masked as 34.2 masks it, invitations show hashes and dates only, and no figure on any page differs from the stored facts, the engine's opportunity row or a row count (contract test over the routes against the fixture).", { skip }, async () => {
  assert.ok(sweep && exportBody["document_id"], "T4's passes and T5's export");
  const maria = loanN(1); assert.equal(maria.email, "maria.garcia@example.com"); assert.equal(maria.phone, "+16025550101");
  // every partner-book route of the spec's Inputs, read as the analyst
  const paths = ["/ops/api/partner-book/partners", `/ops/api/partner-book/imports?partner=${partnerPartyId}`, `/ops/api/partner-book/imports/${firstImportId}`, `/ops/api/partner-book/imports/${secondImportId}`, `/ops/api/partner-book/loans?partner=${partnerPartyId}`, "/ops/api/partner-book/loans?hold=true", `/ops/api/partner-book/loans/${loan1Id}`, `/ops/api/partner-book/loans/${loan5Id}`, `/ops/api/partner-book/reviews?partner=${partnerPartyId}&as_of=${AS_OF}`, `/ops/api/partner-book/readiness?partner=${partnerPartyId}&as_of=${AS_OF}`, `/ops/api/partner-book/daily-report?partner=${partnerPartyId}&as_of=${AS_OF}`, "/ops/api/partner-book/daily-report"];
  const bodies = new Map<string, Json>();
  for (const path of paths) { const r = await api("GET", path, undefined, as(oli, "ops_analyst")); assert.equal(r.status, 200, `${path}: ${J(r.body).slice(0, 200)}`); bodies.set(path, r.body); }
  // (a) no destination anywhere: every GET of this test, the resolve answer (T3) and the export (T5)
  for (const [path, body] of bodies) noDestination(body, path);
  noDestination(resolveBody, "the resolve answer"); noDestination(exportBody, "the export");
  // (b) the homeowner's contact is masked as 34.2 masks it (src/runtime/directory/mask.ts): `m…@example.com`, `···0101`
  const loans = bodies.get(`/ops/api/partner-book/loans?partner=${partnerPartyId}`)!["loans"] as Json[]; assert.equal(loans.length, 12);
  const one = loans.find((l) => l["loan_id"] === loan1Id)!; const owner = one["homeowner"] as Json;
  assert.equal(owner["email_masked"], directoryMaskEmail(maria.email)); assert.equal(owner["email_masked"], "m…@example.com"); assert.equal(owner["phone_masked"], directoryMaskPhone(maria.phone)); assert.equal(owner["phone_masked"], "···0101"); assert.equal(owner["legal_name"], maria.name);
  for (const l of loans) { const h = l["homeowner"] as Json; const d = book.loans.find((x) => x.servicer_loan_number === l["servicer_loan_number"])!; assert.equal(h["email_masked"], directoryMaskEmail(d.email), `${d.servicer_loan_number} e-mail masked as 34.2`); assert.equal(h["phone_masked"], directoryMaskPhone(d.phone), `${d.servicer_loan_number} phone masked as 34.2`); assert.ok(!("email" in h) && !("phone" in h)); }
  const page1 = bodies.get(`/ops/api/partner-book/loans/${loan1Id}`)!; assert.deepEqual((page1["homeowner"] as Json)["email_masked"], "m…@example.com"); assert.deepEqual((page1["homeowner"] as Json)["phone_masked"], "···0101");
  for (const line of (bodies.get(`/ops/api/partner-book/reviews?partner=${partnerPartyId}&as_of=${AS_OF}`)!["reviews"] as Json)["lines"] as Json[]) { const h = line["homeowner"] as Json; assert.ok(h["email_masked"] === null || /^.…@example\.com$/.test(String(h["email_masked"]))); assert.ok(h["phone_masked"] === null || /^···\d{4}$/.test(String(h["phone_masked"]))); }
  // (c) invitations: hashes and dates only — the loan page's rows and the import report's list
  const invitations = page1["invitations"] as Json[]; assert.ok(invitations.length >= 1, "loan 1's invitation of the first import");
  const storedInv = await db.query<{ id: string; destination_hash: string; sent_at: string; channel: string; kind: string }>(`SELECT id::text AS id, destination_hash, sent_at::text AS sent_at, channel, kind FROM partner_book_invitations WHERE loan_id = $1 ORDER BY sent_at, id`, [loan1Id]);
  assert.equal(invitations.length, storedInv.length);
  for (const [k, i] of invitations.entries()) { assert.match(String(i["destination_hash"]), /^[0-9a-f]{64}$/); assert.equal(i["destination_hash"], storedInv[k]!.destination_hash); assert.ok(i["sent_at"]); assert.equal(i["kind"], storedInv[k]!.kind); assert.equal(i["channel"], storedInv[k]!.channel); for (const key of ["destination", "email", "phone", "address"]) assert.ok(!(key in i), `no ${key} on an invitation`); }
  const reportInv = (bodies.get(`/ops/api/partner-book/imports/${firstImportId}`)!["report"] as Json)["invitations"] as Json[]; assert.equal(reportInv.length, 11, "one invitation per homeowner with a supplement row (loan 12 has none)");
  for (const i of reportInv) { assert.match(String(i["destination_hash"]), /^[0-9a-f]{64}$/); assert.deepEqual(Object.keys(i).sort(), ["bounced", "channel", "destination_hash", "held_reason", "loan_id", "notice_id", "party_id"]); }
  // (d) no figure differs from the stored facts: the book's table against each loan's latest partner_book_facts row
  const latest = await db.query<{ loan_id: string; as_of_date: string; facts: Json }>(`SELECT DISTINCT ON (loan_id) loan_id::text AS loan_id, as_of_date::text AS as_of_date, facts FROM partner_book_facts WHERE partner_party_id = $1 ORDER BY loan_id, as_of_date DESC, created_at DESC`, [partnerPartyId]);
  for (const l of loans) {
    const f = latest.find((x) => x.loan_id === l["loan_id"])!; assert.ok(f, `facts of ${String(l["servicer_loan_number"])}`);
    assert.equal(l["facts_as_of"], f.as_of_date); assert.equal(l["upb_cents"], f.facts["upb_cents"]); assert.equal(l["note_rate_pct"], f.facts["note_rate_pct"]); assert.equal(l["pi_cents"], f.facts["pi_cents"]); assert.equal(l["ti_cents"], f.facts["ti_cents"]); assert.equal(l["next_due_date"], f.facts["next_due_date"]); assert.equal(l["last_payment_date"], f.facts["last_payment_date"]); assert.equal(l["servicing_status"], f.facts["servicing_status"]);
    const value = l["value"] as Json | null; if (value) { const stored = [f.facts["fmv_cents"], f.facts["bpo_value_cents"], f.facts["appraised_value_cents"]].map((v) => (v === null || v === undefined ? null : String(v))); assert.ok(stored.includes(String(value["value_cents"])), `${String(l["servicer_loan_number"])}'s value is a stored fact (${String(value["value_cents"])} ∈ ${J(stored)})`); }
  }
  assert.equal(one["facts_as_of"], AS_OF_2); assert.equal(one["upb_cents"], String(UPB_24)); assert.equal(one["pi_cents"], "306979"); assert.equal(one["ti_cents"], "61250"); assert.equal((one["value"] as Json)["value_cents"], "60500000"); assert.equal((one["value"] as Json)["as_of"], "2026-08-31"); assert.equal(one["note_rate_pct"], "7.250");
  const five = loans.find((l) => l["loan_id"] === loan5Id)!; assert.equal(five["facts_as_of"], DEMO_AS_OF); assert.equal(five["status"], "paid_off"); assert.equal(five["latest_review"], null, "never reviewed after the payoff");
  // the latest review / readiness columns are the newest rows
  for (const l of loans) {
    const rv = (await db.query<{ as_of_date: string; verdict: string; reasons: string[] }>(`SELECT as_of_date::text AS as_of_date, verdict, reasons FROM partner_book_reviews WHERE loan_id = $1 ORDER BY as_of_date DESC, created_at DESC LIMIT 1`, [l["loan_id"] as string]))[0] ?? null;
    assert.deepEqual(l["latest_review"], rv ? { as_of_date: rv.as_of_date, verdict: rv.verdict, reasons: rv.reasons } : null, `latest review of ${String(l["servicer_loan_number"])}`);
    const rz = (await db.query<{ as_of_date: string; ready: boolean; missing: string[] }>(`SELECT as_of_date::text AS as_of_date, ready, missing FROM readiness_checks WHERE loan_id = $1 ORDER BY created_at DESC LIMIT 1`, [l["loan_id"] as string]))[0] ?? null;
    assert.deepEqual(l["latest_readiness"], rz ? { as_of_date: rz.as_of_date, ready: rz.ready, missing: rz.missing } : null, `latest readiness of ${String(l["servicer_loan_number"])}`);
  }
  const counts = bodies.get(`/ops/api/partner-book/loans?partner=${partnerPartyId}`)!["counts"] as Json;
  assert.deepEqual(counts, { loans: 12, on_hold: 0, by_status: { monitored: 11, paid_off: 1 }, by_verdict: { candidate: 2, watching: 6, excluded: 3 }, ready: 0, not_ready: 2, unchecked: 10 }, "every count is a count of rows");
  assert.equal(await count(`loans WHERE partner_party_id = $1 AND status = 'monitored'`, [partnerPartyId]), 11); assert.equal(await count(`readiness_checks`), 2);
  assert.deepEqual(bodies.get("/ops/api/partner-book/loans?hold=true")!["loans"], []);
  // the loan page: facts by as-of date are the rows (mapped and raw), terms history the loan_terms rows, reviews' facts the stored engine facts, offers the opportunity entity
  const factsRows = await factsOf(loan1Id); const byAsOf = page1["facts_by_as_of"] as Json[]; assert.equal(byAsOf.length, 2);
  for (const [k, f] of byAsOf.entries()) { assert.equal(f["as_of_date"], factsRows[k]!.as_of_date); assert.equal(f["import_id"], factsRows[k]!.import_id); assert.deepEqual(f["facts"], factsRows[k]!.facts); assert.deepEqual(f["raw"], factsRows[k]!.raw); assert.equal(f["raw_columns"], Object.keys(factsRows[k]!.raw).length); }
  assert.deepEqual(byAsOf.map((f) => (f["facts"] as Json)["upb_cents"]), [String(UPB_23), String(UPB_24)]);
  const terms = await db.query<{ effective_from: string; effective_to: string | null; note_rate_bps: number; pi_cents: string }>(`SELECT effective_from::text AS effective_from, effective_to::text AS effective_to, note_rate_bps, pi_cents::text AS pi_cents FROM loan_terms WHERE loan_id = $1 ORDER BY effective_from, id`, [loan1Id]);
  assert.deepEqual((page1["terms"] as Json[]).map((t) => [t["effective_from"], t["effective_to"], t["note_rate_bps"], t["pi_cents"]]), terms.map((t) => [t.effective_from, t.effective_to, Number(t.note_rate_bps), t.pi_cents]));
  assert.equal(terms.length, 2); assert.equal(terms[0]!.note_rate_bps, 72500); assert.equal(terms[0]!.pi_cents, "306979");
  const loanRow = (await db.query<{ original_upb_cents: string; original_term_months: number; origination_date: string; first_payment_date: string; maturity_date: string }>(`SELECT original_upb_cents::text AS original_upb_cents, original_term_months, origination_date::text AS origination_date, first_payment_date::text AS first_payment_date, maturity_date::text AS maturity_date FROM loans WHERE id = $1`, [loan1Id]))[0]!;
  const pl = page1["loan"] as Json; assert.deepEqual([pl["original_upb_cents"], pl["original_term_months"], pl["origination_date"], pl["first_payment_date"], pl["maturity_date"]], [loanRow.original_upb_cents, Number(loanRow.original_term_months), loanRow.origination_date, loanRow.first_payment_date, loanRow.maturity_date]);
  assert.equal(pl["original_upb_cents"], "45000000");
  for (const rv of page1["reviews"] as Json[]) { const s = (await db.query<{ facts: Json; verdict: string; reasons: string[] }>(`SELECT facts, verdict, reasons FROM partner_book_reviews WHERE id = $1`, [rv["id"] as string]))[0]!; assert.deepEqual(rv["facts"], s.facts); assert.equal(rv["verdict"], s.verdict); assert.deepEqual(rv["reasons"], s.reasons); }
  for (const o of page1["offers"] as Json[]) {
    const opp = decodeEntityData((await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = 'refi_opportunities' AND id = $1`, [o["opportunity_id"] as string]))[0]!.data);
    assert.equal(o["status"], opp["status"]); assert.equal(o["offer_valid_until"], opp["offer_valid_until"] ?? null); assert.equal(o["as_of_date"], opp["as_of_date"]); assert.equal(o["campaign_id"], opp["campaign_id"] ?? null); assert.equal(o["expired"], opp["status"] === "expired");
  }
  assert.ok((page1["offers"] as Json[]).length >= 1);
  const clocks = page1["clocks"] as Json[]; assert.equal(clocks.length, await count(`timers WHERE loan_id = $1`, [loan1Id])); assert.ok(clocks.some((c) => c["code"] === "SM_PARTNER_BOOK_INVITATION_REMINDER_14"));
  // the day view: every count is a count of rows (T4 checked the numbers; here the two routes and the receipt's own figures)
  const dayBody = bodies.get(`/ops/api/partner-book/reviews?partner=${partnerPartyId}&as_of=${AS_OF}`)!; assert.deepEqual(bodies.get(`/ops/api/partner-book/readiness?partner=${partnerPartyId}&as_of=${AS_OF}`), dayBody);
  assert.equal((dayBody["reviews"] as Json)["count"], await count(`partner_book_reviews r JOIN loans l ON l.id = r.loan_id WHERE r.as_of_date = $1 AND l.partner_party_id = $2`, [AS_OF, partnerPartyId]));
  assert.equal((dayBody["readiness"] as Json)["checked"], await count(`readiness_checks WHERE as_of_date = $1`, [AS_OF]));
  const rr = ((dayBody["receipts"] as Json)["review"] as Json[])[0]!; const receipt = (await events("partner_book.review.run_completed"))[0]!.payload; assert.deepEqual(rr["payload"], receipt);
  // the daily report route: the newest row (the export's, carrying document_id), nothing produced anew, its figures the receipts' and the row counts
  const report = bodies.get(`/ops/api/partner-book/daily-report?partner=${partnerPartyId}&as_of=${AS_OF}`)!;
  assert.equal(report["produced"], false); assert.equal(report["id"], exportBody["report_id"]); assert.equal(report["document_id"], exportBody["document_id"]); assert.equal(report["produced_by"], "sweep");
  const review = report["review"] as Json; for (const k of ["reviewed", "candidates", "watching", "not_now", "excluded", "offers_delivered", "expired", "analyst_turns", "analyst_skipped"]) assert.equal(review[k], receipt[k], `daily report review.${k}`);
  assert.equal(review["fair_lending_extract_id"], `fle-${programId()}-${AS_OF}`);
  const bookSummary = report["book"] as Json;
  assert.equal(bookSummary["loans_monitored"], await count(`loans WHERE partner_party_id = $1 AND status = 'monitored'`, [partnerPartyId])); assert.equal(bookSummary["paid_off"], await count(`loans WHERE partner_party_id = $1 AND status = 'paid_off'`, [partnerPartyId])); assert.equal(bookSummary["imports"], await count(`partner_book_imports WHERE partner_party_id = $1`, [partnerPartyId]));
  assert.equal(bookSummary["last_as_of_date"], (await db.query<{ d: string }>(`SELECT max(as_of_date)::text AS d FROM partner_book_imports WHERE partner_party_id = $1 AND status = 'loaded'`, [partnerPartyId]))[0]!.d); assert.equal(bookSummary["next_expected"], "2026-09-15");
  assert.equal((report["history"] as Json[]).length, 2, "the examiner's list: both rows of the day"); assert.equal((bodies.get("/ops/api/partner-book/daily-report")!["reports"] as Json[]).length, 2);
  // the partners: loans monitored, on hold, imports, last as-of, next expected — counts and stored dates; the tape clock is 33.1's timer row
  const partners = bodies.get("/ops/api/partner-book/partners")!["partners"] as Json[]; assert.equal(partners.length, 1); const p = partners[0]!;
  assert.deepEqual([p["partner_party_id"], p["legal_name"], p["loans_monitored"], p["on_hold"], p["imports"], p["last_as_of_date"], p["next_expected"], p["clock_status"], p["late"]], [partnerPartyId, DEMO_PARTNER.legal_name, 11, 0, 2, AS_OF_2, "2026-09-15", "armed", false]);
  const timer = (await db.query<{ id: string; status: string; due_date: string }>(`SELECT id::text AS id, status::text AS status, due_date::text AS due_date FROM timers WHERE code = 'SM_PARTNER_BOOK_TAPE_EXPECTED_7' AND status = 'armed'`))[0]!; assert.equal((p["tape_clock"] as Json)["timer_id"], timer.id); assert.equal((p["tape_clock"] as Json)["due_date"], timer.due_date);
  // the history: each import's figures are its partner_book_imports row's
  for (const i of bodies.get(`/ops/api/partner-book/imports?partner=${partnerPartyId}`)!["imports"] as Json[]) {
    const s = (await db.query<{ rows_total: number; rows_loaded: number; rows_exception: number; loans_created: number; loans_updated: number; parties_created: number; parties_linked: number; invitations_sent: number; report: Json }>(`SELECT rows_total, rows_loaded, rows_exception, loans_created, loans_updated, parties_created, parties_linked, invitations_sent, report FROM partner_book_imports WHERE id = $1`, [i["import_id"] as string]))[0]!;
    assert.deepEqual([i["rows_total"], i["rows_loaded"], i["rows_exception"], i["loans_created"], i["loans_updated"], i["loans_unchanged"], i["parties_created"], i["parties_linked"], i["invitations_sent"], i["on_hold"]], [Number(s.rows_total), Number(s.rows_loaded), Number(s.rows_exception), Number(s.loans_created), Number(s.loans_updated), Number(s.rows_loaded) - Number(s.loans_created) - Number(s.loans_updated), Number(s.parties_created), Number(s.parties_linked), Number(s.invitations_sent), (s.report["not_on_tape"] as Json[]).length]);
  }
  // every read of this test is on the action log as the analyst, ok, with no destination or name (34.1 rule 4)
  const rows = await actions(`WHERE staff_user_id = $1 AND method = 'GET' AND route LIKE '/ops/api/partner-book/%'`, [oli.staff_user_id]);
  for (const path of paths) assert.ok(rows.some((r) => r.route === path && r.result === "ok" && r.command === null), `logged: ${path}`);
  for (const r of rows) { assert.doesNotMatch(r.route, /@/); assert.ok(!r.route.includes(maria.last_name)); }
});
