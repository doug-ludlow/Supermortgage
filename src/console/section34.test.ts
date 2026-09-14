/**
 * The console's section-34 mount (34.2 the directory, 34.3 book operations, 34.4 controls) over the API server on a private
 * database `<base>_console34`: the role gate before any read (34.1 rule 3), the staff context every handler receives (the
 * session's `session_id` is what an unmask / export / unmasked account needs), the action log (rule 4: a search's `q` reaches
 * `staff_actions.route` only as its hash), the generic bus route forwarding the session for 34.2 and answering 403 ROLE_REQUIRED
 * for 34.3's `book.daily_report{op: export}` outside compliance, the upload through the multipart route, the sweep hooks
 * (34.3's daily report, 34.4's kill-switch expiry / long-trip escalation) and the evidence pack's document store.
 *
 *   REQUIRE_DB=1 TEST_DATABASE_URL=postgresql://sm:sm@localhost/supermortgage_<label> node --test src/console/section34.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { connect, reachable, type Db } from "../infra/db/client.ts";
import { loadOverriddenRegistry } from "../domain/timer-overrides.ts";
import { FixedClock } from "../kernel/events/index.ts";
import { Runtime, type SweepReport } from "../runtime/app.ts";
import { createApiServer, listen } from "../runtime/server.ts";
import { createLogger } from "../runtime/log.ts";
import { bootstrapStaffAdmin } from "../runtime/staff/auth.ts";
import { FakeRateFeed } from "../infra/integrations/rates.ts";
import { queryHash } from "../runtime/directory/search.ts";
import { UNMASK_MINUTES } from "../runtime/directory/unmask.ts";
import { DEMO_AS_OF, DEMO_PARTNER, demoBook } from "../domain/partner-book/fixtures/partner-book-demo.ts";

const BASE_URL = process.env["TEST_DATABASE_URL"] ?? "postgresql://sm:sm@localhost/supermortgage_test";
const DB_URL = ((): string => { const u = new URL(BASE_URL); u.pathname = `${u.pathname}_console34`; return u.toString(); })();
const ADMIN_URL = ((): string => { const u = new URL(DB_URL); u.pathname = "/postgres"; return u.toString(); })();
const up = await reachable(ADMIN_URL);
if (!up && process.env["REQUIRE_DB"]) throw new Error(`REQUIRE_DB set but ${ADMIN_URL} is not reachable`);
const skip = up ? false : `no Postgres at ${ADMIN_URL}`;
type Json = Record<string, unknown>;

/** 2026-09-15 07:20 America/New_York: past 20.1's 06:30 run, 33.2's 07:00 review and 33.3's 07:15 pass; before 34.3's 07:45 receipt escalation. */
const NOW = "2026-09-15T11:20:00.000Z";
const TOKEN = `ops-${randomUUID()}`;
const clock = new FixedClock(NOW);
const book = demoBook();
const maria = book.loans.find((l) => l.n === 1)!;
let db: Db; let runtime: Runtime; let base = ""; let close: () => Promise<void> = async () => undefined;
type Session = { token: string; session_id: string; staff_user_id: string };
let admin: Session; let analyst: Session; let officer: Session; let compliance: Session;
let partnerId = ""; let importId = ""; let loan1 = ""; let mariaId = ""; let sweep: SweepReport;

type Reply = { status: number; body: Json };
async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  if (path.startsWith("/ops/api/")) sent += 1;   // every /ops/api request writes one staff_actions row — the doors included (34.1 rule 4), so the log's catch-up wait below counts them too
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text(); return { status: r.status, body: text ? (JSON.parse(text) as Json) : {} };
}
const as = (s: Session, role?: string): Record<string, string> => ({ authorization: `Bearer ${s.token}`, ...(role ? { "x-staff-role": role } : {}) });
async function enrolAndSignIn(email: string, password: string): Promise<Session> {
  const c = await api("POST", "/ops/api/auth/code", { email }); const v = await api("POST", "/ops/api/auth/verify", { email, code: c.body["fake_code"] });
  const p = await api("POST", "/ops/api/auth/password", { token: v.body["token"], password }); assert.equal(p.status, 200, JSON.stringify(p.body));
  const c2 = await api("POST", "/ops/api/auth/code", { email }); await api("POST", "/ops/api/auth/verify", { email, code: c2.body["fake_code"] });
  const s = await api("POST", "/ops/api/auth/signin", { email, password }); assert.equal(s.status, 200, JSON.stringify(s.body));
  return { token: s.body["token"] as string, session_id: s.body["session_id"] as string, staff_user_id: s.body["staff_user_id"] as string };
}
const count = async (sql: string, p: unknown[] = []): Promise<number> => Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, p))[0]!.n);
type ActionRow = { route: string; method: string; command: string | null; subject_kind: string | null; subject_id: string | null; result: string; refusal_code: string | null; staff_user_id: string | null; session_id: string | null };
let sent = 0;   // every /ops/api request this suite made; the staff_actions row is inserted after the answer is on the wire, so the log is read once it has caught up
const actions = async (where = "", p: unknown[] = []): Promise<ActionRow[]> => {
  for (let i = 0; i < 100 && (await count(`staff_actions`)) < sent; i++) await new Promise((r) => setTimeout(r, 20));
  return db.query(`SELECT route, method, command, subject_kind, subject_id, result, refusal_code, staff_user_id::text AS staff_user_id, session_id::text AS session_id FROM staff_actions ${where} ORDER BY created_at, id`, p);
};

test.before(async () => {
  if (skip) return;
  const name = new URL(DB_URL).pathname.slice(1);
  const a = connect(ADMIN_URL); await a.query(`DROP DATABASE IF EXISTS ${name}`); await a.query(`CREATE DATABASE ${name}`); await a.end();
  execFileSync(fileURLToPath(new URL("../../db/migrate.sh", import.meta.url)), { env: { ...process.env, DATABASE_URL: DB_URL }, stdio: "pipe" });
  db = connect(DB_URL);
  const logger = createLogger("json", (line) => { if (process.env["FLOW_DEBUG"] && /error/i.test(line)) process.stderr.write(line + "\n"); });
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock, logger, rateFeed: new FakeRateFeed(), analystLlm: null });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger, borrower: { environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost"], urlSecret: "test-secret" } });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => db.end().then(() => resolve())); });
  // the staff: the bootstrapped admin invites an analyst, an officer and a compliance user; each enrols and signs in (34.1's two factors)
  const R = randomUUID().slice(0, 6);
  await bootstrapStaffAdmin(runtime, `ada.${R}@supermortgage.example`, { legal_name: "Ada Admin" });
  admin = await enrolAndSignIn(`ada.${R}@supermortgage.example`, "correct-horse-battery-1");
  const people: [string, string, string[]][] = [[`ana.${R}@supermortgage.example`, "Ana Lyst", ["ops_analyst"]], [`ollie.${R}@supermortgage.example`, "Ollie Ficer", ["officer"]], [`cora.${R}@supermortgage.example`, "Cora Pliance", ["compliance"]]];
  for (const [email, legal_name, roles] of people) { const r = await api("POST", "/ops/api/staff/invite", { email, legal_name, roles }, as(admin)); assert.equal(r.status, 200, JSON.stringify(r.body)); }
  const sessions = await Promise.all(people.map(([email]) => enrolAndSignIn(email, "twelve-character-pass-1")));
  analyst = sessions[0]!; officer = sessions[1]!; compliance = sessions[2]!;
  // 34.3 rule 1: the upload through the console's multipart route as the analyst → 33.1 book.import with the person as actor
  const fd = new FormData();
  fd.set("partner_legal_name", DEMO_PARTNER.legal_name); fd.set("partner_nmlsr_id", DEMO_PARTNER.nmlsr_id); fd.set("partner_servicer_number", DEMO_PARTNER.servicer_number); fd.set("partner_mers_org_id", DEMO_PARTNER.mers_org_id);
  fd.set("as_of_date", DEMO_AS_OF); fd.set("profile", "m3-v1"); fd.set("tape", new Blob([book.tape]), "partner-book-demo.xlsx"); fd.set("supplement", new Blob([book.supplement]), "partner-book-demo-supplement.csv");
  sent += 1; const up = await fetch(`${base}/ops/api/partner-book/imports`, { method: "POST", headers: as(analyst, "ops_analyst"), body: fd }); const imp = (await up.json()) as Json;
  assert.equal(up.status, 200, JSON.stringify(imp).slice(0, 400)); assert.equal(imp["status"], "loaded"); assert.equal(imp["rows_loaded"], 12);
  importId = imp["import_id"] as string; partnerId = imp["partner_party_id"] as string;
  const l1 = (imp["loans"] as Json[]).find((l) => l["servicer_loan_number"] === maria.servicer_loan_number)!; loan1 = l1["loan_id"] as string; mariaId = l1["party_id"] as string;
  // the morning's passes and the section-34 hooks
  sweep = await runtime.sweep();
});
test.after(async () => { if (!skip) await close(); });

test("the role gate answers 403 ROLE_REQUIRED{role, held} before any read or write on every section-34 table; an admin-only session touches no borrower; controls read for every role", { skip }, async () => {
  const searchedBefore = await count(`loan_events WHERE type = 'directory.searched'`);
  const denied = async (r: Reply, role: string, held: string[]): Promise<void> => { assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body["code"], "ROLE_REQUIRED"); assert.equal(r.body["error"], "role_required"); assert.equal(r.body["role"], role); assert.deepEqual(r.body["held"], held); };
  await denied(await api("GET", "/ops/api/directory/search?q=Garcia", undefined, as(admin)), "ops_analyst", ["admin"]);
  assert.equal(await count(`loan_events WHERE type = 'directory.searched'`), searchedBefore, "refused before the read: no directory.searched");
  await denied(await api("GET", `/ops/api/directory/accounts/${mariaId}`, undefined, as(admin)), "ops_analyst", ["admin"]);
  await denied(await api("POST", `/ops/api/directory/accounts/${mariaId}/unmask`, { fields: ["contact"], reason: "x" }, as(analyst)), "compliance", ["ops_analyst"]);
  await denied(await api("POST", `/ops/api/directory/accounts/${mariaId}/export`, { reason: "x" }, as(analyst)), "compliance", ["ops_analyst"]);
  await denied(await api("POST", `/ops/api/directory/accounts/${mariaId}/export`, { reason: "x" }, as(officer)), "compliance", ["officer"]);
  assert.equal(await count(`directory_unmasks`), 0); assert.equal(await count(`directory_exports`), 0);
  await denied(await api("GET", "/ops/api/partner-book/partners", undefined, as(admin)), "ops_analyst", ["admin"]);
  await denied(await api("GET", "/ops/api/partner-book/loans", undefined, as(admin)), "ops_analyst", ["admin"]);
  await denied(await api("POST", "/ops/api/partner-book/daily-report/export", { partner: partnerId, as_of: "2026-09-15" }, as(analyst)), "compliance", ["ops_analyst"]);
  await denied(await api("POST", `/ops/api/partner-book/loans/${loan1}/resolve`, { resolution: "keep", reason: "x" }, as(officer)), "ops_analyst", ["officer"]);
  await denied(await api("POST", "/ops/api/controls/evidence", { subject: { loan_id: loan1 } }, as(analyst)), "compliance", ["ops_analyst"]);
  await denied(await api("GET", "/ops/api/controls/evidence", undefined, as(analyst)), "compliance", ["ops_analyst"]);
  await denied(await api("POST", "/ops/api/controls/ai/intake/kill", { reason: "x" }, as(analyst)), "compliance", ["ops_analyst"]);
  await denied(await api("POST", `/ops/api/controls/outbox/${randomUUID()}/requeue`, {}, as(compliance)), "ops_analyst", ["compliance"]);
  // a role the session holds but the route refuses, asked for by name (x-staff-role), is refused the same way
  await denied(await api("GET", "/ops/api/controls/evidence", undefined, as(compliance, "ops_analyst")), "ops_analyst", ["compliance"]);
  for (const s of [admin, analyst, officer, compliance]) { const t = await api("GET", "/ops/api/controls/timers", undefined, as(s)); assert.equal(t.status, 200, JSON.stringify(t.body).slice(0, 200)); assert.ok((t.body["count"] as number) > 0, "the fixture book's clocks are listed"); }
  // the generic /v1 tool routes refuse every section-34 process outright (review finding: there the actor is whatever the body names — one holder of the ops bearer token must not trip the kill switch alone with two fabricated staff ids, nor attribute a look or an export to a staff id with no row); the console's session path is their only HTTP entry
  const forged = (role: string): Json => ({ kind: "human", id: randomUUID(), role });
  for (const [process, name, input, actor] of [["34.4", "controls.ai.kill", { op: "request", code: "intake", action: "trip", reason: "x" }, forged("compliance")], ["34.2", "directory.search", { q: "Garcia" }, forged("compliance")], ["34.3", "book.daily_report", { op: "export", partner_id: partnerId, as_of_date: "2026-09-15" }, forged("compliance")], ["34.1", "staff.invite", { email: "m@example.test", legal_name: "M", roles: ["admin"] }, forged("admin")]] as const) {
    const v1 = await api("POST", `/v1/tools/${process}/${name}`, { actor, input }, { authorization: `Bearer ${TOKEN}` });
    assert.equal(v1.status, 403, `${process} ${name}: ${JSON.stringify(v1.body)}`); assert.equal(v1.body["code"], "STAFF_TOOLS_ARE_SESSION_ONLY");
  }
  assert.equal(await count(`loan_events WHERE type LIKE 'ai.kill_switch.%'`), 0, "nothing requested"); assert.equal(await count(`loan_events WHERE type = 'directory.searched'`), searchedBefore, "no look attributed to a forged staff id");
  // every refusal above is one staff_actions row: refused, ROLE_REQUIRED, the person, the session
  const refused = (await actions(`WHERE refusal_code = 'ROLE_REQUIRED'`));
  assert.equal(refused.length, 14, `${refused.length} ROLE_REQUIRED rows — one per refusal above`); assert.ok(refused.every((r) => r.result === "refused" && r.staff_user_id && r.session_id));
});

test("the action log (34.1 rule 4 / 34.2 rule 4): a search's route carries the query hash and no query text; every directory row names the command, the subject and the result", { skip }, async () => {
  const q = "Garcia";
  const s = await api("GET", `/ops/api/directory/search?q=${encodeURIComponent(q)}`, undefined, as(analyst)); assert.equal(s.status, 200, JSON.stringify(s.body).slice(0, 300));
  assert.ok((s.body["results"] as Json[]).some((h) => h["party_id"] === mariaId && h["email"] === "m…@example.com"), "Maria listed with masked contact");
  const byEmail = await api("GET", `/ops/api/directory/search?q=${encodeURIComponent(maria.email!)}`, undefined, as(officer)); assert.equal(byEmail.status, 200);
  const a = await api("GET", `/ops/api/directory/accounts/${mariaId}`, undefined, as(analyst)); assert.equal(a.status, 200, JSON.stringify(a.body).slice(0, 300)); assert.equal(a.body["origin"], `partner book: ${DEMO_PARTNER.legal_name}`);
  const act = await api("GET", `/ops/api/directory/accounts/${mariaId}/activity?kind=notice&from=2026-09-01`, undefined, as(compliance)); assert.equal(act.status, 200); assert.deepEqual(act.body["kinds"], ["notice"]);
  assert.equal((await api("GET", "/ops/api/directory/search?q=Ga", undefined, as(analyst))).body["code"], "QUERY_TOO_SHORT");
  const rows = await actions(`WHERE route LIKE '/ops/api/directory/%'`);
  const search = rows.find((r) => r.route.startsWith("/ops/api/directory/search") && r.staff_user_id === analyst.staff_user_id && r.result === "ok")!;
  assert.equal(search.route, `/ops/api/directory/search?q=${queryHash(q)}`); assert.equal(search.command, "directory.search"); assert.equal(search.subject_kind, "search"); assert.equal(search.subject_id, queryHash(q));
  const emailSearch = rows.find((r) => r.staff_user_id === officer.staff_user_id && r.route.startsWith("/ops/api/directory/search"))!;
  assert.equal(emailSearch.route, `/ops/api/directory/search?q=${queryHash(maria.email!)}`);
  const all = await actions();
  for (const r of all) { assert.ok(!r.route.includes("Garcia") && !r.route.includes("@") && !r.route.includes("%40") && !r.route.toLowerCase().includes("maria"), `no typed query on the log: ${r.route}`); }
  const account = rows.find((r) => r.route === `/ops/api/directory/accounts/${mariaId}` && r.result === "ok")!; assert.equal(account.command, "directory.account"); assert.equal(account.subject_kind, "party"); assert.equal(account.subject_id, mariaId);
  const activity = rows.find((r) => r.route.startsWith(`/ops/api/directory/accounts/${mariaId}/activity`))!; assert.equal(activity.command, "directory.activity"); assert.equal(activity.route, `/ops/api/directory/accounts/${mariaId}/activity?kind=notice&from=2026-09-01`);
  const tooShort = rows.find((r) => r.refusal_code === "QUERY_TOO_SHORT")!; assert.equal(tooShort.result, "refused"); assert.equal(tooShort.route, `/ops/api/directory/search?q=${queryHash("Ga")}`);
  // NO_PII_IN_LOG (review finding): a directory path that misses the table (an unknown sub-path, a wrong method, a non-uuid party id) still logs the hashed `q` and no e-mail / phone / name — as a refused request, never `ok`
  const misses: [string, string, number, string][] = [["GET", `/ops/api/directory/people?q=${encodeURIComponent(maria.email!)}&name=Maria%20Garcia&phone=%2B16025550101`, 404, "NOT_FOUND"], ["POST", `/ops/api/directory/search?q=${encodeURIComponent(maria.email!)}`, 404, "NOT_FOUND"], ["GET", `/ops/api/directory/accounts/not-a-uuid?email=${encodeURIComponent(maria.email!)}&q=Garcia`, 404, "NOT_FOUND"], ["DELETE", `/ops/api/directory/accounts/${mariaId}?q=Garcia`, 405, "METHOD_NOT_ALLOWED"]];
  for (const [method, path, status, code] of misses) { const m = await api(method, path, method === "POST" ? {} : undefined, as(analyst)); assert.equal(m.status, status, `${method} ${path}: ${JSON.stringify(m.body)}`); assert.equal(m.body["code"], code); }
  const missed = (await actions(`WHERE result = 'refused' AND refusal_code IN ('NOT_FOUND', 'METHOD_NOT_ALLOWED') AND route LIKE '/ops/api/directory/%'`));
  assert.deepEqual(missed.map((r) => [r.method, r.route, r.refusal_code, r.command]), [["GET", `/ops/api/directory/people?q=${queryHash(maria.email!)}`, "NOT_FOUND", null], ["POST", `/ops/api/directory/search?q=${queryHash(maria.email!)}`, "NOT_FOUND", null], ["GET", `/ops/api/directory/accounts/not-a-uuid?q=${queryHash("Garcia")}`, "NOT_FOUND", null], ["DELETE", `/ops/api/directory/accounts/${mariaId}?q=${queryHash("Garcia")}`, "METHOD_NOT_ALLOWED", null]]);
  // the console's own 19.2 access log carries the hashed route too (the store's row, not staff_actions)
  assert.equal(await count(`console_access_log WHERE path LIKE '%Garcia%' OR path LIKE '%@%'`).catch(() => 0), 0);
});

test("the session rides with the handler: compliance unmasks contact for 15 minutes through the route, the account and the generic bus route (34.2 forwards session_id) show the full e-mail; an analyst and the header actor do not", { skip }, async () => {
  const u = await api("POST", `/ops/api/directory/accounts/${mariaId}/unmask`, { fields: ["contact"], reason: "a support call from the homeowner" }, as(compliance));
  assert.equal(u.status, 200, JSON.stringify(u.body)); assert.deepEqual(u.body["fields"], ["contact"]); assert.equal(u.body["expires_at"], new Date(Date.parse(NOW) + UNMASK_MINUTES * 60_000).toISOString()); assert.ok(u.body["decision_id"]);
  const shown = await api("GET", `/ops/api/directory/accounts/${mariaId}`, undefined, as(compliance)); assert.equal((shown.body["contact"] as Json)["email"], maria.email, "the route hands the session to the tool");
  const bus = await api("POST", "/ops/api/tools/34.2/directory.account", { input: { party_id: mariaId, staff_user_id: analyst.staff_user_id, unmask: ["contact", "identity"] } }, as(compliance));
  assert.equal(bus.status, 200, JSON.stringify(bus.body).slice(0, 300)); assert.equal(((bus.body["output"] as Json)["contact"] as Json)["email"], maria.email, "the bus route forwards the session's session_id; the body's staff_user_id / unmask are ignored");
  assert.equal(((bus.body["output"] as Json)["identity"] as Json)["ssn_last4"], null, "identity was not unmasked");
  const analystView = await api("GET", `/ops/api/directory/accounts/${mariaId}`, undefined, as(analyst)); assert.equal((analystView.body["contact"] as Json)["email"], "m…@example.com");
  const analystBus = await api("POST", "/ops/api/tools/34.2/directory.account", { input: { party_id: mariaId } }, as(analyst)); assert.equal(((analystBus.body["output"] as Json)["contact"] as Json)["email"], "m…@example.com");
  // the deploy workflow's header actor is no staff_users row: the directory refuses it ROLE_DENIED on every route (review finding: the 34.2 tools verify the actor from rows — an unmask, a look and the bus route alike), before SESSION_REQUIRED could apply
  const header = { authorization: `Bearer ${TOKEN}`, "x-actor-id": "u-compliance", "x-actor-role": "compliance" };
  const hu = await api("POST", `/ops/api/directory/accounts/${mariaId}/unmask`, { fields: ["contact"], reason: "x" }, header); assert.equal(hu.status, 403, JSON.stringify(hu.body)); assert.equal(hu.body["code"], "ROLE_DENIED", JSON.stringify(hu.body));
  const hb = await api("POST", "/ops/api/tools/34.2/directory.unmask", { input: { party_id: mariaId, fields: ["contact"], reason: "x" } }, header); assert.equal(hb.status, 403); assert.equal(hb.body["code"], "ROLE_DENIED");
  const hg = await api("GET", `/ops/api/directory/accounts/${mariaId}`, undefined, header); assert.equal(hg.status, 403, JSON.stringify(hg.body)); assert.equal(hg.body["code"], "ROLE_DENIED");
  assert.equal(await count(`directory_unmasks WHERE staff_user_id::text = 'u-compliance'`).catch(() => 0), 0);
  const rows = await actions(`WHERE command = 'directory.unmask'`); assert.ok(rows.some((r) => r.result === "ok" && r.subject_id === mariaId && r.session_id === compliance.session_id)); assert.ok(rows.some((r) => r.refusal_code === "ROLE_DENIED"));
  const x = await api("POST", `/ops/api/directory/accounts/${mariaId}/export`, { reason: "an examiner's request" }, as(compliance)); assert.equal(x.status, 201, JSON.stringify(x.body)); assert.match(String(x.body["sha256"]), /^[0-9a-f]{64}$/); assert.ok(!("pack" in x.body));
  // the export's row names the export produced (the person's own staff_actions set is a row set of their pack); the pack is 34.4's, verifiable through the evidence route as compliance
  const xrow = (await actions(`WHERE command = 'directory.export' AND result = 'ok'`))[0]!; assert.deepEqual([xrow.subject_kind, xrow.subject_id], ["export", x.body["export_id"]]);
  const xv = await api("GET", `/ops/api/controls/evidence/${x.body["pack_id"]}?verify=1`, undefined, as(compliance)); assert.equal(xv.status, 200, JSON.stringify(xv.body).slice(0, 300)); assert.equal((xv.body["verification"] as Json)["verified"], true, JSON.stringify(xv.body["verification"]).slice(0, 400)); assert.equal(xv.body["subject_kind"], "party"); assert.equal(xv.body["document_available"], true);
});

test("34.3 mounted: the book reads answer the analyst, the export is compliance's (route and bus alike — the bus answers 403 ROLE_REQUIRED from the tool's guardrail), the upload row and the sweep's daily report are on the log and the report", { skip }, async () => {
  const reads = ["/ops/api/partner-book/partners", "/ops/api/partner-book/imports", `/ops/api/partner-book/imports/${importId}`, "/ops/api/partner-book/loans?hold=false", `/ops/api/partner-book/loans/${loan1}`, "/ops/api/partner-book/reviews?as_of=2026-09-15", "/ops/api/partner-book/readiness?as_of=2026-09-15", `/ops/api/partner-book/daily-report?partner=${partnerId}&as_of=2026-09-15`];
  for (const p of reads) { const r = await api("GET", p, undefined, as(analyst)); assert.equal(r.status, 200, `${p}: ${JSON.stringify(r.body).slice(0, 300)}`); }
  const partners = (await api("GET", "/ops/api/partner-book/partners", undefined, as(officer))).body["partners"] as Json[]; assert.equal(partners[0]!["partner_party_id"], partnerId); assert.equal(partners[0]!["loans_monitored"], 12); assert.equal(partners[0]!["last_as_of_date"], DEMO_AS_OF);
  const loans = (await api("GET", "/ops/api/partner-book/loans", undefined, as(compliance))).body; assert.equal((loans["counts"] as Json)["loans"], 12); assert.ok((loans["loans"] as Json[]).every((l) => !/[a-z0-9._%+-]{2,}@/i.test(JSON.stringify(l["homeowner"]))), "no full e-mail on the book"); assert.ok((loans["loans"] as Json[]).some((l) => /"email_masked":"[a-z]…@/.test(JSON.stringify(l["homeowner"]))), "contact masked as 34.2 masks it");
  const legacyName = await api("GET", `/ops/api/partner-book/loans?partner_party_id=${partnerId}`, undefined, as(analyst)); assert.equal((legacyName.body["counts"] as Json)["loans"], 12, "the console's older partner filter name still narrows");
  const detail = (await api("GET", `/ops/api/partner-book/imports/${importId}`, undefined, as(analyst))).body; assert.equal(detail["rows_loaded"], 12); assert.equal(detail["uploaded_by"], `human:${analyst.staff_user_id}`, "the upload ran with the person as actor"); assert.equal((detail["lines"] as Json[]).length, 12);
  const upload = (await actions(`WHERE command = 'book.import'`))[0]!; assert.equal(upload.subject_kind, "partner_book_import"); assert.equal(upload.subject_id, importId); assert.equal(upload.staff_user_id, analyst.staff_user_id);
  // the sweep hooks: the daily report row (34.3 rule 6) and the controls counts (34.4) are on the SweepReport
  assert.ok(sweep.partner_book_readiness.ran, sweep.partner_book_readiness.line); assert.ok(sweep.partner_book_daily_reports, "the hook ran"); assert.equal(sweep.partner_book_daily_reports!.produced, 1); assert.equal(sweep.partner_book_daily_reports!.escalated, 0);
  assert.deepEqual(sweep.controls, { kill_requests_expired: 0, long_trips_escalated: 0 });
  assert.equal(await count(`partner_book_daily_reports WHERE partner_party_id = $1 AND as_of_date = '2026-09-15'`, [partnerId]), 1);
  const report = (await api("GET", `/ops/api/partner-book/daily-report?partner=${partnerId}&as_of=2026-09-15`, undefined, as(analyst))).body; assert.equal(report["produced_by"], "sweep"); assert.equal((report["book"] as Json)["loans_monitored"], 12);
  // the export: the route (compliance) and the bus (the tool's EXPORT_IS_COMPLIANCE guardrail → 403 ROLE_REQUIRED with the role it names)
  const busDenied = await api("POST", "/ops/api/tools/34.3/book.daily_report", { input: { op: "export", partner_id: partnerId, as_of_date: "2026-09-15" } }, as(analyst));
  assert.equal(busDenied.status, 403, JSON.stringify(busDenied.body)); assert.equal(busDenied.body["code"], "ROLE_REQUIRED"); assert.equal(busDenied.body["role"], "compliance"); assert.deepEqual(busDenied.body["held"], ["ops_analyst"]);
  assert.equal(await count(`documents WHERE kind = 'partner_book_daily_report'`), 0, "nothing exported by the refusal");
  const x = await api("POST", "/ops/api/partner-book/daily-report/export", { partner: partnerId, as_of: "2026-09-15" }, as(compliance)); assert.equal(x.status, 201, JSON.stringify(x.body).slice(0, 300)); assert.match(String(x.body["sha256"]), /^[0-9a-f]{64}$/);
  const xrow = (await actions(`WHERE command = 'book.daily_report:export'`))[0]!; assert.equal(xrow.subject_kind, "document"); assert.equal(xrow.subject_id, x.body["document_id"]); assert.equal(xrow.result, "ok");
  const busOk = await api("POST", "/ops/api/tools/34.3/book.daily_report", { input: { op: "export", partner_id: partnerId, as_of_date: "2026-09-15" } }, as(compliance)); assert.equal(busOk.status, 200, JSON.stringify(busOk.body).slice(0, 300));
  // the resolve control is the analyst's: 33.1 book.resolve runs with the person as actor (`keep` on a loan not on hold lifts nothing and is recorded); the row names the command, the loan and the person
  const res = await api("POST", `/ops/api/partner-book/loans/${loan1}/resolve`, { resolution: "keep", reason: "probe" }, as(analyst)); assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
  assert.equal((res.body["output"] as Json)["was_on_hold"], false); assert.ok((res.body["events"] as string[]).includes("partner_book.loan.resolved"));
  assert.equal(((res.body["loan"] as Json)["resolutions"] as Json[]).at(-1)!["actor"], `human:${analyst.staff_user_id}`, "the staff member is the actor");
  const rrow = (await actions(`WHERE route = $1`, [`/ops/api/partner-book/loans/${loan1}/resolve`])).at(-1)!; assert.equal(rrow.command, "book.resolve"); assert.equal(rrow.result, "ok"); assert.equal(rrow.subject_id, loan1); assert.equal(rrow.staff_user_id, analyst.staff_user_id);
});

test("34.4 mounted: clocks with history (GET only), escalations, the outbox, the two-person kill switch through the routes, and the evidence pack stored in the console's document store and verifiable", { skip }, async () => {
  const t = (await api("GET", "/ops/api/controls/timers?status=armed", undefined, as(analyst))).body; const first = (t["timers"] as Json[])[0]!;
  const one = await api("GET", `/ops/api/controls/timers/${first["timer_id"]}`, undefined, as(officer)); assert.equal(one.status, 200); assert.ok(Array.isArray(one.body["history"]) && (one.body["history"] as unknown[]).length >= 1);
  const noWrite = await api("POST", `/ops/api/controls/timers/${first["timer_id"]}`, {}, as(analyst)); assert.equal(noWrite.status, 404, `no POST under /controls/timers: ${JSON.stringify(noWrite.body)}`); assert.equal(noWrite.body["code"], "NOT_FOUND");
  const noPut = await api("PUT", `/ops/api/controls/timers/${first["timer_id"]}`, { status: "satisfied" }, as(analyst)); assert.equal(noPut.status, 405, JSON.stringify(noPut.body)); assert.equal(noPut.body["code"], "METHOD_NOT_ALLOWED");
  // rule 4 (review finding): a write probe on a read-only surface is a refused request on the append-only log with its code — never a successful timer write
  const probes = await actions(`WHERE route = $1 AND method IN ('POST', 'PUT')`, [`/ops/api/controls/timers/${first["timer_id"]}`]);
  assert.deepEqual(probes.map((r) => [r.method, r.result, r.refusal_code, r.command, r.staff_user_id]), [["POST", "refused", "NOT_FOUND", null, analyst.staff_user_id], ["PUT", "refused", "METHOD_NOT_ALLOWED", null, analyst.staff_user_id]]);
  assert.equal((await api("GET", "/ops/api/controls/escalations?status=all", undefined, as(compliance))).status, 200);
  assert.equal((await api("GET", "/ops/api/controls/outbox?status=all", undefined, as(admin))).status, 200);
  assert.equal((await api("GET", `/ops/api/controls/outbox/${randomUUID()}`, undefined, as(admin))).status, 404);
  const ai = await api("GET", "/ops/api/controls/ai", undefined, as(analyst)); assert.equal(ai.status, 200); assert.ok((ai.body["agents"] as Json[]).some((a) => a["agent"] === "intake"));
  // the kill switch: compliance requests, the same person cannot confirm, admin confirms → tripped; reset the same way
  const req = await api("POST", "/ops/api/controls/ai/intake/kill", { reason: "a prompt regression" }, as(compliance)); assert.equal(req.status, 200, JSON.stringify(req.body).slice(0, 300));
  const requestId = (req.body["output"] as Json)["request_id"] as string; assert.ok(requestId);
  assert.equal((await api("GET", "/ops/api/controls/ai/intake", undefined, as(analyst))).body["kill_switch"] && ((await api("GET", "/ops/api/controls/ai/intake", undefined, as(analyst))).body["kill_switch"] as Json)["state"], "armed", "nothing trips on the request");
  const self = await api("POST", "/ops/api/controls/ai/intake/kill", { request_id: requestId }, as(compliance)); assert.ok(self.status === 403 || self.status === 409, JSON.stringify(self.body)); assert.ok(["TWO_PERSON_KILL", "ROLE_REQUIRED", "ROLE_DENIED"].includes(String(self.body["code"])), JSON.stringify(self.body));
  const conf = await api("POST", "/ops/api/controls/ai/intake/kill", { request_id: requestId }, as(admin)); assert.equal(conf.status, 200, JSON.stringify(conf.body).slice(0, 300)); assert.equal((conf.body["output"] as Json)["state"], "tripped");
  assert.equal(((await api("GET", "/ops/api/controls/ai/intake", undefined, as(analyst))).body["kill_switch"] as Json)["state"], "tripped"); assert.equal(runtime.agents.aiState("intake").off, true);
  const rq = await api("POST", "/ops/api/controls/ai/intake/reset", { reason: "fixed" }, as(compliance)); const rc = await api("POST", "/ops/api/controls/ai/intake/reset", { request_id: (rq.body["output"] as Json)["request_id"] }, as(admin)); assert.equal(rc.status, 200, JSON.stringify(rc.body).slice(0, 300)); assert.equal((rc.body["output"] as Json)["state"], "armed");
  const kills = await actions(`WHERE command = 'controls.ai.kill'`); assert.equal(kills.filter((r) => r.result === "ok").length, 4); assert.ok(kills.every((r) => r.subject_kind === "ai_system" && r.subject_id === "intake"));
  // the evidence pack for loan 1: the document lands in the console's blob store and reads back with the manifest; verify re-hashes the rows
  const pk = await api("POST", "/ops/api/controls/evidence", { subject: { loan_id: loan1 } }, as(compliance)); assert.equal(pk.status, 200, JSON.stringify(pk.body).slice(0, 300));
  const out = pk.body["output"] as Json; assert.match(String(out["sha256"]), /^[0-9a-f]{64}$/); assert.ok(!("document" in out), "the answer carries the manifest, not the whole document");
  const packId = out["id"] as string;
  // the packs are compliance's to read back too (34.4 rule 5 / 34.1 rule 2: an admin touches no borrower — the pack carries the homeowner's rows)
  assert.equal((await api("GET", "/ops/api/controls/evidence", undefined, as(admin))).status, 403); assert.equal((await api("GET", `/ops/api/controls/evidence/${packId}`, undefined, as(admin))).body["code"], "ROLE_REQUIRED");
  const list = await api("GET", "/ops/api/controls/evidence", undefined, as(compliance)); assert.ok((list.body["packs"] as Json[]).some((p) => p["id"] === packId));
  const got = await api("GET", `/ops/api/controls/evidence/${packId}?verify=1`, undefined, as(compliance)); assert.equal(got.status, 200, JSON.stringify(got.body).slice(0, 200));
  assert.equal(got.body["document_available"], true, "the pack's document is in the console's store"); assert.equal((got.body["verification"] as Json)["verified"], true);
  assert.ok(typeof got.body["document"] === "string" && (got.body["document"] as string).includes(loan1));
  const prow = (await actions(`WHERE command = 'controls.evidence.pack'`))[0]!; assert.equal(prow.subject_kind, "evidence_pack"); assert.equal(prow.subject_id, packId);
  // every action log row of this suite is ids and codes only
  for (const r of await actions()) assert.ok(!/@|Garcia|Maria/.test(`${r.route} ${r.subject_id ?? ""} ${r.refusal_code ?? ""}`), r.route);
});
