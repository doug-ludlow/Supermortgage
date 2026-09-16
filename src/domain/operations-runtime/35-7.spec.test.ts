// 35.7 Operating roles, identity and the FAKE handover: a person for every kernel role, credentials that cannot be self-asserted on `/v1`, reviewer-role disjointness, the role queues and the handover board
// spec/sections/35-operations-runtime/35-7-operating-roles-identity-and-the-fake-handover.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// The harness (34-1.spec.test.ts's, extended): the MAIN world is this file's own database with the API server of
// src/runtime/server.ts in-process (the ops console at /ops/api, the /v1 door), a FixedClock at 2026-09-14 08:00 ET, the
// FAKE e-delivery port (the code echoed as `fake_code`), and the people invited/enrolled/signed in through the real doors.
// T1 stages the migrations file by file on an empty database (`t1`); T11 and T16 run on their own databases and clocks
// (`t11`, `t16`) because a breached dormant clock and the platform day's clock must not see the MAIN world's rows.
// Every 35.7 tool runs on the bus (`runtime.execute` or the console routes); the FAKE reviewers are constructed per test
// from their own environment variables (rule 6) over the same database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { connect, type Db } from "../../infra/db/client.ts";
import { testDatabase, withDatabase, baseTestDatabaseUrl, dropDatabase } from "../../infra/db/test-db.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock, type Actor } from "../../kernel/events/index.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import { Runtime } from "../../runtime/app.ts";
import { createApiServer, listen } from "../../runtime/server.ts";
import { createLogger } from "../../runtime/log.ts";
import { PgConsoleStore } from "../../console/pg-store.ts";
import { HUMAN_ROLES } from "../../app/roles.ts";
import { EscalationService, PgEscalationRepository } from "../../app/escalations.ts";
import { PgLoanRepository } from "../../infra/db/loans.ts";
import { bootstrapStaffAdmin } from "../../runtime/staff/auth.ts";
import { hashToken } from "../../runtime/staff/repo.ts";
import { FAKE_REVIEWER_ROLES, FakeReviewers, fakeReviewerRolesFromEnv, type FakeReviewerReport } from "../../infra/integrations/reviewers.ts";
import { DUAL_CONTROL_SINGLE_TRANSFER_CENTS } from "../../app/tools/section5-2.ts";
import { fundingDecision } from "../investor/remittance.ts";
import { PAYEE_CHANGE_DUAL_OVER_CENTS, releaseApproval } from "../escrow/ops.ts";
import { ROLES_QUEUE_SCAN } from "./roles-35-7/queue.ts";
import { currentFakeSet, envDefault } from "./roles-35-7/env.ts";
import { moneyFingerprint } from "../../runtime/controls/common.ts";

const { url: DB_URL, skip } = await testDatabase(import.meta.url);
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TOKEN = "ops-" + randomUUID();
const R = randomUUID().slice(0, 8);
/** 2026-09-14 08:00 America/New_York (a Monday). */
const T0 = "2026-09-14T12:00:00.000Z";
const clock = new FixedClock(T0);
process.env["STAFF_EMAIL_KEY"] ??= "35.7-spec-staff-email-key";   // 34.1 requires the cipher key in production (T3 stands a production runtime up over the same database)
const MIN = 60_000; const HOUR = 3_600_000; const DAY = 86_400_000;
const at = (ms: number): string => new Date(Date.parse(clock.now()) + ms).toISOString();
type Json = Record<string, unknown>;
const ENV_NONPROD = { INTEGRATIONS: "fake" } as NodeJS.ProcessEnv;

let db: Db; let runtime: Runtime; let base = ""; let close: () => Promise<void> = async () => undefined;
const logLines: string[] = [];
const logger = createLogger("json", (line) => { logLines.push(line); if (process.env["FLOW_DEBUG"] && /error|unhandled|"status":[45]/i.test(line)) process.stderr.write(line + "\n"); });

// the people of the MAIN world (every account is invited by the bootstrap admin and enrolled through the doors)
const person = (tag: string) => ({ email: `${tag}.${R}@example.test`, name: `${tag} Person`, password: `${tag}-correct-horse-${R}` });
const ADA = person("ada");      // the bootstrap admin
const CARA = person("cara");    // compliance
const CORA = person("cora");    // a second compliance member (T12's reviewer)
const ORA = person("ora");      // officer (T2's conflict)
const OLI = person("oli");      // ops_analyst → qc_officer (T2)
const PAM = person("pam");      // ops_analyst → mlo_of_record (T3), underwriting_reviewer (T10)
const AMY = person("amy");      // officer A (T4/T5)
const BEN = person("ben");      // officer B (T4/T5)
const ATT = person("att");      // ops_analyst → attorney (T6)
const FIN = person("fin");      // ops_analyst → funding_approver (T8)
const QUE = person("que");      // ops_analyst → qc_officer (T9)
const SAM = person("sam");      // ops_analyst → settlement_agent (T9)
const PAT = person("pat");      // ops_analyst (T13's principal)
const POL = person("pol");      // officer + fnma_portal_operator (T14)
const QUI = person("qui");      // ops_analyst with no reviewer role (T10)
const TIA = person("tia");      // ops_analyst (T17's grants and principal)
const UMA = person("uma");      // ops_analyst → underwriting_reviewer (T10; PAM holds mlo_of_record from T3, which rule 3 keeps apart)
const ids: Record<string, string> = {};
const sessions: Record<string, { token: string; session_id: string }> = {};

test.before(async () => {
  if (skip) return;
  db = connect(DB_URL);
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock, logger, environment: "nonprod", env: ENV_NONPROD, reviewers: null });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger, borrower: { environment: "nonprod", rpId: "localhost", allowedOrigins: ["http://localhost"], urlSecret: "test-secret" } });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => db.end().then(() => resolve())); });
});
test.after(async () => { if (!skip) await close(); });

// ---------------------------------------------------------------- helpers over the API (34-1's)
type Reply = { status: number; body: Json; headers: Headers };
async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, origin: string = base): Promise<Reply> {
  const r = await fetch(origin + path, { method, headers: { "content-type": "application/json", "x-forwarded-for": "10.35.0.7", "user-agent": "35.7-spec", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text(); return { status: r.status, body: text ? (JSON.parse(text) as Json) : {}, headers: r.headers };
}
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
async function codeToken(email: string): Promise<string> {
  const c = await api("POST", "/ops/api/auth/code", { email }); assert.equal(c.status, 200, JSON.stringify(c.body));
  const v = await api("POST", "/ops/api/auth/verify", { email, code: c.body["fake_code"] }); assert.equal(v.status, 200, JSON.stringify(v.body));
  return v.body["token"] as string;
}
async function enrol(p: { email: string; password: string }): Promise<string> {
  const token = await codeToken(p.email);
  const r = await api("POST", "/ops/api/auth/password", { token, password: p.password }); assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body["staff_user_id"] as string;
}
async function signIn(p: { email: string; password: string }): Promise<{ token: string; session_id: string; staff_user_id: string }> {
  await codeToken(p.email);
  const r = await api("POST", "/ops/api/auth/signin", { email: p.email, password: p.password }); assert.equal(r.status, 200, JSON.stringify(r.body));
  return { token: r.body["token"] as string, session_id: r.body["session_id"] as string, staff_user_id: r.body["staff_user_id"] as string };
}
/** The bootstrap admin (once), then the person invited with 34.1 `roles`, enrolled and signed in; the id and the session are kept by tag. */
async function bootAdmin(): Promise<void> {
  if (ids["ada"]) return;
  const boot = await bootstrapStaffAdmin(runtime, ADA.email, { legal_name: ADA.name }); ids["ada"] = boot.staff_user_id!;
  await enrol(ADA); sessions["ada"] = await signIn(ADA);
}
async function invite(tag: string, p: { email: string; name: string; password: string }, roles: string[]): Promise<string> {
  await bootAdmin();
  if (ids[tag]) return ids[tag]!;
  sessions["ada"] = await signIn(ADA);   // the clock moves between T-ids (34.1 rule 5 idles a session out); the admin signs in for the invitation
  const r = await api("POST", "/ops/api/staff/invite", { email: p.email, legal_name: p.name, roles }, bearer(sessions["ada"]!.token)); assert.equal(r.status, 200, JSON.stringify(r.body));
  ids[tag] = await enrol(p); sessions[tag] = await signIn(p);
  return ids[tag]!;
}
const adminActor = (): Actor => ({ kind: "human", id: ids["ada"]!, role: "admin" });
const asHuman = (tag: string, role: string): Actor => ({ kind: "human", id: ids[tag]!, role });
/** A 35.7 tool on the bus (global scope) — the admin's or the named person's own act. */
const tool = (name: string, actor: Actor, input: Json) => runtime.execute({ process: "35.7", name, loanId: "", actor, input });
/** A grant activated for the test's fixture: a plain role at once; an independence role requested by the admin and confirmed by CARA. */
async function grant(tag: string, role: string): Promise<string> {
  const r = await tool("roles.grant", adminActor(), { staff_user_id: ids[tag]!, role, rationale: `fixture: ${role}` });
  const o = r.output as Json;
  if (o["status"] === "pending") { await invite("cara", CARA, ["compliance"]); const c = await tool("roles.grant", asHuman("cara", "compliance"), { op: "confirm", request_id: o["request_id"] }); return (c.output as Json)["grant_id"] as string; }
  return o["grant_id"] as string;
}
type EventRow = { type: string; actor_kind: string; actor_id: string; actor_role: string | null; aggregate_kind: string | null; aggregate_id: string | null; loan_id: string | null; application_id: string | null; payload: Json; sequence: string; occurred_at: string };
const events = async (type: string, where = "", params: unknown[] = []): Promise<EventRow[]> => db.query<EventRow>(`SELECT type, actor_kind::text AS actor_kind, actor_id, actor_role, aggregate_kind, aggregate_id, loan_id::text AS loan_id, application_id::text AS application_id, payload, sequence::text AS sequence, occurred_at::text AS occurred_at FROM loan_events WHERE type = $1 ${where} ORDER BY sequence`, [type, ...params]);
const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, params))[0]!.n);
type TimerRow = { id: string; code: string; status: string; subject_kind: string; subject_id: string; anchor_date: string; due_date: string | null; due_at: string | null; satisfied_at: string | null; breached_at: string | null; loan_id: string | null };
const timers = async (code: string, where = "", params: unknown[] = []): Promise<TimerRow[]> => db.query<TimerRow>(`SELECT id::text AS id, code, status::text AS status, subject_kind, subject_id, anchor_date::text AS anchor_date, due_date::text AS due_date, due_at::text AS due_at, satisfied_at::text AS satisfied_at, breached_at::text AS breached_at, loan_id::text AS loan_id FROM timers WHERE code = $1 ${where} ORDER BY armed_at, id`, [code, ...params]);
type DecisionRow = { id: string; agent: string; action: string; subject_kind: string | null; subject_id: string | null; rationale: string; approved_by: string | null; approved_role: string | null; rule_set_version: string; loan_id: string | null };
const decisions = async (action: string): Promise<DecisionRow[]> => db.query<DecisionRow>(`SELECT id::text AS id, agent, action, subject_kind, subject_id, rationale, approved_by, approved_role, rule_set_version, loan_id::text AS loan_id FROM agent_decisions WHERE action = $1 ORDER BY created_at, id`, [action]);
type GrantRow = { id: string; staff_user_id: string; role: string; environment: string; action: string; request_id: string | null; granted_by: string | null; confirmed_by: string | null; cause: string | null; decision_id: string | null; effective_at: string; expires_at: string | null };
const grants = async (staffUserId: string, role?: string): Promise<GrantRow[]> => db.query<GrantRow>(`SELECT id::text AS id, staff_user_id::text AS staff_user_id, role, environment, action, request_id::text AS request_id, granted_by::text AS granted_by, confirmed_by::text AS confirmed_by, cause, decision_id::text AS decision_id, effective_at::text AS effective_at, expires_at::text AS expires_at FROM role_grants WHERE staff_user_id = $1 ${role ? "AND role = $2" : ""} ORDER BY created_at, id`, role ? [staffUserId, role] : [staffUserId]);
type ActionRow = { staff_user_id: string | null; session_id: string | null; route: string; method: string; subject_kind: string | null; subject_id: string | null; command: string | null; result: string; refusal_code: string | null; role: string | null; principal_id: string | null; surface: string; source: string | null };
const actions = async (where: string, params: unknown[] = []): Promise<ActionRow[]> => db.query<ActionRow>(`SELECT staff_user_id::text AS staff_user_id, session_id::text AS session_id, route, method, subject_kind, subject_id, command, result, refusal_code, role, principal_id::text AS principal_id, surface, source FROM staff_actions WHERE ${where} ORDER BY at, id`, params);
const sha256hex = (s: string): string => createHash("sha256").update(s).digest("hex");
const fixtureLoan = async (): Promise<{ loanId: string; custodial: { clearing: string; pi: string; ti: string } }> => { const f = await new PgLoanRepository(db).createFixture({ fnmaLoanNumber: `${Date.now() % 1_000_000}${Math.floor(Math.random() * 1000)}`.padStart(10, "0"), servicerLoanNumber: `SM-${randomUUID()}`, instrumentDate: D("2021-07-15"), originalUpbCents: 26_000_000n, originalTermMonths: 360, firstPaymentDate: D("2021-09-01"), maturityDate: D("2051-08-01") }); return { loanId: f.loanId, custodial: f.custodial }; };
/** An open escalation persisted the way the runtime persists them (EscalationService + the repository in one unit of work). */
async function openEscalation(i: { kind: string; ownerRole: string; loanId?: string; applicationId?: string; payload: Json }, actor: Actor): Promise<string> {
  let id = "";
  await runtime.uow.run({ ...(i.loanId ? { loanId: i.loanId } : {}), ...(i.applicationId ? { applicationId: i.applicationId } : {}) }, (ctx) => { const es = new EscalationService(ctx.events, ctx.clock); const e = es.open({ kind: i.kind as never, ownerRole: i.ownerRole, ...(i.loanId ? { loanId: i.loanId } : {}), ...(i.applicationId ? { applicationId: i.applicationId } : {}), payload: i.payload }, actor); id = e.id; return es; }, { clock, commit: async (q) => { const es = new PgEscalationRepository(q); for (const e of (await Promise.resolve([]))) void e; await es.save({ id, kind: i.kind as never, ownerRole: i.ownerRole, ...(i.loanId ? { loanId: i.loanId } : {}), ...(i.applicationId ? { applicationId: i.applicationId } : {}), openedAt: clock.now(), openedBy: `${actor.kind}:${actor.id}`, payload: i.payload, status: "open" }, q); } });
  return id;
}
/** A fresh world for the T-ids that own their clock: its own database, runtime and server. */
async function world(suffix: string, nowIso: string, env: NodeJS.ProcessEnv = ENV_NONPROD): Promise<{ db: Db; runtime: Runtime; clock: FixedClock; base: string; close: () => Promise<void> }> {
  const t = await testDatabase(import.meta.url, { suffix });
  const wdb = connect(t.url); const wclock = new FixedClock(nowIso);
  const rt = new Runtime({ db: wdb, registry: loadOverriddenRegistry(), clock: wclock, logger, environment: "nonprod", env, reviewers: null });
  const server = createApiServer({ runtime: rt, apiToken: TOKEN, logger, borrower: { environment: "nonprod", rpId: "localhost", allowedOrigins: ["http://localhost"], urlSecret: "test-secret" } });
  const wbase = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  return { db: wdb, runtime: rt, clock: wclock, base: wbase, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => wdb.end().then(() => t.close()).then(() => resolve())); }) };
}
/** The staff_actions row lands after the answer is sent (the surfaces log in `finally`); poll until `n` rows match. */
async function actionsAtLeast(n: number, where: string, params: unknown[] = []): Promise<ActionRow[]> { let rows: ActionRow[] = []; for (let i = 0; i < 100; i++) { rows = await actions(where, params); if (rows.length >= n) return rows; await new Promise((r) => setTimeout(r, 20)); } return rows; }
const isUuidLike = (v: unknown): boolean => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const usesOf = (o: unknown): Json[] => (Array.isArray(o) ? (o as Json[]) : []);
void usesOf; void sha256hex; void addBusinessDays; void servicer; void wallClock; void HUMAN_ROLES; void FAKE_REVIEWER_ROLES; void FakeReviewers; void fakeReviewerRolesFromEnv; void DUAL_CONTROL_SINGLE_TRANSFER_CENTS; void fundingDecision; void PAYEE_CHANGE_DUAL_OVER_CENTS; void releaseApproval; void ROLES_QUEUE_SCAN; void currentFakeSet; void envDefault; void moneyFingerprint; void PgConsoleStore; void hashToken; void fixtureLoan; void openEscalation; void world; void grants; void actions; void decisions; void timers; void events; void count; void at; void MIN; void HOUR; void DAY; void asHuman; void grant; void spawnSync; void execFileSync; void readdirSync; void withDatabase; void baseTestDatabaseUrl; void dropDatabase; void ROOT; void CORA; void ORA; void OLI; void PAM; void AMY; void BEN; void ATT; void FIN; void QUE; void SAM; void PAT; void POL; void QUI; void invite;

test("35.7-T1: Given a fresh database, when every file under db/migrations is applied, then five new base tables exist (`to_regclass` non-null for `role_grants`, `role_queue_snapshots`, `role_handovers`, `breakglass_uses`, `api_principals`) and the base-table count (public + restricted_fl, the query of db.test.ts:40-46) equals the count taken just before this process's migration file plus 5 (776 at HEAD through 0141 — 0138 to 0141 create no table; the absolute number depends on which §35 migrations precede it and is never asserted), `staff_users.reviewer_roles` exists with a CHECK whose literal list equals `HUMAN_ROLES` from src/app/roles.ts (twenty-two words, no `admin`), the three disjointness CHECKs exist, and every 34.1 T-id (`34.1-T1` … `34.1-T9`) passes unchanged.", { skip }, async () => {
  // the "before" count is staged by hand: db/migrate.sh applies every file in one run, so an empty database gets the files before 0170 one by one
  const t1 = await testDatabase(import.meta.url, { suffix: "t1", template: false });
  const psql = (args: string[]): void => { execFileSync("psql", ["-v", "ON_ERROR_STOP=1", "-q", t1.url, ...args], { stdio: "pipe" }); };
  psql(["-c", "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());"]);
  const dir = `${ROOT}db/migrations`; const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const mine = "0170_operating_roles.sql"; assert.ok(files.includes(mine), "this process's migration file exists");
  for (const f of files) { if (f >= mine) break; psql(["-f", `${dir}/${f}`]); psql(["-c", `INSERT INTO schema_migrations(version) VALUES ('${f.replace(/\.sql$/, "")}')`]); }
  const t1db = connect(t1.url);
  const baseTables = async (): Promise<number> => Number((await t1db.query<{ c: string }>(`SELECT count(*)::text AS c FROM information_schema.tables WHERE table_schema IN ('public', 'restricted_fl') AND table_type = 'BASE TABLE'`))[0]!.c);
  const before = await baseTables();
  for (const t of ["role_grants", "role_queue_snapshots", "role_handovers", "breakglass_uses", "api_principals"]) assert.equal((await t1db.query<{ r: string | null }>(`SELECT to_regclass($1)::text AS r`, [`public.${t}`]))[0]!.r, null, `${t} does not exist before 0170`);
  execFileSync(`${ROOT}db/migrate.sh`, { env: { ...process.env, DATABASE_URL: t1.url }, stdio: "pipe" });
  const after = await baseTables();
  // db/migrate.sh applies every later file too: the five of 0170 plus the tables the §35 migrations after 0171 create (0230: 35.11's six) — the absolute number moves with them, the five are checked by name below
  const later = files.filter((f) => f > "0171_operating_roles_controls.sql").reduce((n, f) => n + (readFileSync(`${dir}/${f}`, "utf8").match(/^CREATE TABLE\s/gm)?.length ?? 0), 0);
  assert.equal(after, before + 5 + later, `five new base tables (before ${before}, after ${after}, later migrations ${later})`);
  for (const t of ["role_grants", "role_queue_snapshots", "role_handovers", "breakglass_uses", "api_principals"]) assert.equal((await t1db.query<{ r: string | null }>(`SELECT to_regclass($1)::text AS r`, [`public.${t}`]))[0]!.r, t, `to_regclass non-null for ${t}`);
  // staff_users.reviewer_roles with a CHECK whose literal list equals HUMAN_ROLES (twenty-two words, no admin); the three disjointness CHECKs; the constraint trigger
  const [col] = await t1db.query<{ data_type: string; column_default: string }>(`SELECT data_type, column_default FROM information_schema.columns WHERE table_name = 'staff_users' AND column_name = 'reviewer_roles'`);
  assert.ok(col, "staff_users.reviewer_roles exists"); assert.equal(col!.data_type, "ARRAY");
  const [chk] = await t1db.query<{ def: string }>(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'staff_users'::regclass AND conname = 'staff_users_reviewer_roles_check'`);
  const literals = [...chk!.def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]!);
  assert.deepEqual(literals, [...HUMAN_ROLES]); assert.equal(literals.length, 22); assert.ok(!(literals as string[]).includes("admin"));
  const disjoint = await t1db.query<{ conname: string }>(`SELECT conname FROM pg_constraint WHERE conrelid = 'staff_users'::regclass AND conname IN ('staff_users_disjoint_qc_officer', 'staff_users_disjoint_funding_approver', 'staff_users_disjoint_underwriting_reviewer') ORDER BY conname`);
  assert.deepEqual(disjoint.map((r) => r.conname), ["staff_users_disjoint_funding_approver", "staff_users_disjoint_qc_officer", "staff_users_disjoint_underwriting_reviewer"]);
  const [trg] = await t1db.query<{ tgdeferrable: boolean; tginitdeferred: boolean }>(`SELECT tgdeferrable, tginitdeferred FROM pg_trigger WHERE tgname = 'staff_users_role_change_needs_grant'`);
  assert.ok(trg && trg.tgdeferrable && trg.tginitdeferred, "ROLE_CHANGE_WITHOUT_GRANT is a deferred constraint trigger");
  await t1db.end(); await t1.close();
  // every 34.1 T-id passes unchanged: the 34-1 suite as a child run on its own database base (never this run's)
  const childBase = withDatabase(baseTestDatabaseUrl(), "supermortgage_35_7_child_test");
  const env: NodeJS.ProcessEnv = { ...process.env, REQUIRE_DB: "1", TEST_DATABASE_URL: childBase }; delete env["NODE_TEST_CONTEXT"];   // a child test run of its own, reporting TAP text, not the parent's IPC reporter
  const child = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--experimental-strip-types", "src/domain/operator-portal/34-1.spec.test.ts"], { cwd: ROOT, env, encoding: "utf8", timeout: 900_000, maxBuffer: 64 * 1024 * 1024 });
  const out = `${child.stdout}\n${child.stderr}`;
  assert.equal(child.status, 0, `the 34.1 suite passes unchanged:\n${out.split("\n").filter((l) => /^not ok|^# (pass|fail)|Error|expected|actual/.test(l)).join("\n")}`);
  assert.ok(/^# fail 0$/m.test(out), "34.1: no failures");
  for (let n = 1; n <= 9; n++) assert.ok(new RegExp(`^ok \\d+ - 34\\.1-T${n}: `, "m").test(out), `34.1-T${n} passed`);
  try { await dropDatabase(withDatabase(baseTestDatabaseUrl(), "supermortgage_35_7_child_t_placeholder")); } catch { /* the child's database name is derived by the child; nothing to drop here */ }
});

test("35.7-T2: Given an active staff user holding `officer`, when an `admin` calls `roles.grant{role: qc_officer}` for that user, then it is refused `ROLE_DISJOINT{role: qc_officer, conflicts_with: [officer]}` and no `role_grants` row exists; given a direct `UPDATE staff_users SET reviewer_roles = '{qc_officer}'` on the same row, then Postgres raises the CHECK; given an active `ops_analyst` with no conflicting role, when the same grant is confirmed by a different `compliance` member within 10 minutes, then one `role_grants{action: grant, confirmed_by}` row, `role.granted`, an `identities` row with `privileged = true` and `entitlements.reviewer_roles = [qc_officer]`, and an `agent_decisions` row naming both people exist.", { skip }, async () => {
  await bootAdmin();
  await invite("ora", ORA, ["officer"]); await invite("oli", OLI, ["ops_analyst"]); await invite("cara", CARA, ["compliance"]);
  const ada = sessions["ada"]!;
  // an officer may not hold qc_officer (D1-1-02): refused by the tool, no row
  const refused = await api("POST", "/ops/api/roles/grants", { staff_user_id: ids["ora"], role: "qc_officer", environment: "nonprod", rationale: "t2" }, bearer(ada.token));
  assert.equal(refused.status, 409, JSON.stringify(refused.body)); assert.equal(refused.body["code"], "ROLE_DISJOINT"); assert.equal(refused.body["role"], "qc_officer"); assert.deepEqual(refused.body["conflicts_with"], ["officer"]);
  assert.equal((await grants(ids["ora"]!)).length, 0, "no role_grants row"); assert.equal((await decisions("roles.grant")).length, 0);
  // the CHECK on a hand-written UPDATE
  await assert.rejects(db.query(`UPDATE staff_users SET reviewer_roles = '{qc_officer}' WHERE id = $1`, [ids["ora"]]), /staff_users_disjoint_qc_officer/);
  // an ops_analyst with no conflicting role: the admin's grant is pending until a different compliance member confirms the request within 10 minutes
  const pending = await api("POST", "/ops/api/roles/grants", { staff_user_id: ids["oli"], role: "qc_officer", environment: "nonprod", rationale: "t2 qc" }, bearer(ada.token));
  assert.equal(pending.status, 200, JSON.stringify(pending.body)); assert.equal(pending.body["status"], "pending"); const requestId = pending.body["request_id"] as string; assert.ok(requestId);
  assert.equal((await grants(ids["oli"]!)).length, 0, "no row before the confirmation");
  // the grantee may not confirm their own grant (CONFIRMER_IS_HOLDER): OLI holds no compliance → ROLE_REQUIRED at the route; CARA confirming a grant of herself → CONFIRMER_IS_HOLDER
  const self = await api("POST", "/ops/api/roles/grants", { staff_user_id: ids["cara"], role: "ciso", environment: "nonprod", rationale: "t2 self" }, bearer(ada.token)); assert.equal(self.body["status"], "pending");
  const holder = await api("POST", `/ops/api/roles/grants/${self.body["request_id"]}/confirm`, {}, bearer(sessions["cara"]!.token));
  assert.equal(holder.status, 409, JSON.stringify(holder.body)); assert.equal(holder.body["code"], "CONFIRMER_IS_HOLDER");
  clock.set(at(9 * MIN));
  const confirmed = await api("POST", `/ops/api/roles/grants/${requestId}/confirm`, {}, bearer(sessions["cara"]!.token));
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body)); assert.equal(confirmed.body["status"], "active"); const grantId = confirmed.body["grant_id"] as string;
  const rows = await grants(ids["oli"]!, "qc_officer"); assert.equal(rows.length, 1);
  assert.deepEqual({ action: rows[0]!.action, granted_by: rows[0]!.granted_by, confirmed_by: rows[0]!.confirmed_by, request_id: rows[0]!.request_id, environment: rows[0]!.environment, cause: rows[0]!.cause }, { action: "grant", granted_by: ids["ada"], confirmed_by: ids["cara"], request_id: requestId, environment: "nonprod", cause: "grant" });
  assert.ok(rows[0]!.decision_id, "the decision row's id on the grant row");
  assert.deepEqual((await db.query<{ reviewer_roles: string[] }>(`SELECT reviewer_roles FROM staff_users WHERE id = $1`, [ids["oli"]]))[0]!.reviewer_roles, ["qc_officer"]);
  const granted = (await events("role.granted")).filter((e) => e.payload["grant_id"] === grantId);
  assert.equal(granted.length, 1); assert.equal(granted[0]!.aggregate_kind, "role_grant"); assert.equal(granted[0]!.aggregate_id, grantId); assert.equal(granted[0]!.loan_id, null);
  assert.deepEqual({ staff_user_id: granted[0]!.payload["staff_user_id"], role: granted[0]!.payload["role"], environment: granted[0]!.payload["environment"], by: granted[0]!.payload["by"], confirmed_by: granted[0]!.payload["confirmed_by"] }, { staff_user_id: ids["oli"], role: "qc_officer", environment: "nonprod", by: ids["ada"], confirmed_by: ids["cara"] });
  const [idn] = await db.query<{ kind: string; privileged: boolean; entitlements: Json }>(`SELECT kind, privileged, entitlements FROM identities WHERE subject = $1`, [`staff:${ids["oli"]}`]);
  assert.ok(idn, "an identities row for the holder"); assert.equal(idn!.kind, "human"); assert.equal(idn!.privileged, true); assert.deepEqual(idn!.entitlements["reviewer_roles"], ["qc_officer"]); assert.deepEqual(idn!.entitlements["roles"], ["ops_analyst"]);
  const dec = (await decisions("roles.grant:confirm")).filter((d) => d.subject_id === grantId);
  assert.equal(dec.length, 1); assert.equal(dec[0]!.subject_kind, "grant"); assert.equal(dec[0]!.rule_set_version, "roles.v1"); assert.equal(dec[0]!.approved_by, ids["cara"]); assert.equal(rows[0]!.decision_id, dec[0]!.id);
  const record = JSON.parse(dec[0]!.rationale) as Json; assert.equal(record["by"], ids["ada"]); assert.equal(record["confirmed_by"], ids["cara"]); assert.equal(record["role"], "qc_officer"); assert.equal(record["prompt_version"], "35.7-v1");
  const dormant = await timers("SM_ROLE_GRANT_DORMANT_30D", "AND subject_id = $2", [grantId]);
  assert.equal(dormant.length, 1); assert.equal(dormant[0]!.status, "armed"); assert.equal(dormant[0]!.subject_kind, "role_grant"); assert.equal(dormant[0]!.due_date, "2026-10-14");
  // the confirmation arriving after 10 minutes → expired, the grant never activates, logged
  const late = await api("POST", "/ops/api/roles/grants", { staff_user_id: ids["oli"], role: "bsa_officer", environment: "nonprod", rationale: "t2 late" }, bearer(ada.token)); assert.equal(late.body["status"], "pending");
  clock.set(at(11 * MIN));
  const expired = await api("POST", `/ops/api/roles/grants/${late.body["request_id"]}/confirm`, {}, bearer(sessions["cara"]!.token));
  assert.equal(expired.status, 409, JSON.stringify(expired.body)); assert.equal(expired.body["code"], "REQUEST_EXPIRED");
  await runtime.sweep();   // the sweep's stale-request pass logs the expiry (a refused command persists nothing)
  assert.equal((await events("role.grant.request.expired")).filter((e) => e.payload["request_id"] === late.body["request_id"]).length, 1);
  assert.equal((await grants(ids["oli"]!, "bsa_officer")).length, 0);
});

test("35.7-T3: Given a staff principal issued to person P who holds `mlo_of_record`, when `POST /v1/applications/{id}/tools/20.3/requestQuote` is sent under P's bearer with no body `actor`, then the command runs as `{human, <P.staff_user_id>, mlo_of_record}` and the event's `actor_id` is P's id; when the body carries `actor: {kind: human, id: <another id>, role: mlo_of_record}`, then 403 `NO_SELF_ASSERTED_ACTOR` and nothing ran; when a service principal sends `actor: {kind: human, …}`, then 403 `NO_HUMAN_ROLE_ON_SERVICE_PRINCIPAL`; when the shared `API_TOKEN` is presented with `ENVIRONMENT=production`, then 403 `SHARED_TOKEN_REFUSED_IN_PRODUCTION`, and outside production the same request is honoured and its `staff_actions` row reads `surface = v1, source = shared_token`.", { skip }, async () => {
  await bootAdmin(); await invite("pam", PAM, ["ops_analyst"]);
  await grant("pam", "mlo_of_record");
  const ada = sessions["ada"]!;
  // the principals: a staff principal for P, a service principal
  const issued = await api("POST", "/ops/api/principals", { kind: "staff", staff_user_id: ids["pam"], name: "pam-cli", scopes: { applications: "all", processes: ["20."] }, expires_at: at(30 * DAY) }, bearer(ada.token));
  assert.equal(issued.status, 200, JSON.stringify(issued.body)); const tokenP = issued.body["token"] as string; assert.ok(tokenP);
  const svc = await api("POST", "/ops/api/principals", { kind: "service", name: "batch-t3", scopes: { applications: "all", processes: ["20."] }, expires_at: at(300 * DAY) }, bearer(ada.token));
  assert.equal(svc.status, 200, JSON.stringify(svc.body)); const tokenS = svc.body["token"] as string;
  // the application and its lead (20.3 deliverDisclosure{op: create} as the intake agent)
  const app = await runtime.createApplication({ partner_party_id: (await db.query<{ id: string }>(`SELECT id::text AS id FROM parties ORDER BY created_at LIMIT 1`))[0]?.id ?? (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name) VALUES ('servicer', 'T3 Partner') RETURNING id::text AS id`))[0]!.id, channel: "organic", transaction_type: "purchase", occupancy: "primary", borrowers: [{ legal_name: "T3 Borrower" }] } as never, { kind: "system", id: "test" });
  const appId = app.application.id;
  await runtime.execute({ process: "20.3", name: "deliverDisclosure", loanId: "", applicationId: appId, actor: { kind: "agent", id: "intake" }, input: { op: "create", lead_id: `lead-t3-${R}`, partner_id: "partner-1", partner_name: "Partner", channel: "organic" } });
  const body = { input: { op: "assign_mlo", lead_id: `lead-t3-${R}`, mlo_of_record_id: ids["pam"], mlo_name: "P", mlo_nmlsr_id: "12345" } };
  const before = await count("loan_events");
  // no body actor: the command runs as {human, P, mlo_of_record} — the role the request names among the roles P holds
  const ok = await api("POST", `/v1/applications/${appId}/tools/20.3/requestQuote`, body, { ...bearer(tokenP), "x-staff-role": "mlo_of_record" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const ev = ok.body["event"] as Json; assert.deepEqual((ev["actor"] as Json)["id"], ids["pam"]); assert.equal((ev["actor"] as Json)["role"], "mlo_of_record");
  const executed = (await events("command.executed", "AND application_id = $2", [appId])).filter((e) => e.payload["command"] === "requestQuote");
  assert.ok(executed.length >= 1); assert.equal(executed[executed.length - 1]!.actor_id, ids["pam"]); assert.equal(executed[executed.length - 1]!.actor_role, "mlo_of_record");
  // a body actor naming another id: refused, nothing ran
  const mid = await count("loan_events");
  const forged = await api("POST", `/v1/applications/${appId}/tools/20.3/requestQuote`, { ...body, actor: { kind: "human", id: randomUUID(), role: "mlo_of_record" } }, { ...bearer(tokenP), "x-staff-role": "mlo_of_record" });
  assert.equal(forged.status, 403, JSON.stringify(forged.body)); assert.equal(forged.body["code"], "NO_SELF_ASSERTED_ACTOR"); assert.equal(await count("loan_events"), mid, "nothing ran");
  const forgedRow = await actionsAtLeast(1, "surface = 'v1' AND refusal_code = 'NO_SELF_ASSERTED_ACTOR' AND principal_id = $1", [issued.body["principal_id"]]);
  assert.equal(forgedRow.length, 1); assert.equal(forgedRow[0]!.source, "principal"); assert.equal(forgedRow[0]!.staff_user_id, ids["pam"]); assert.equal(forgedRow[0]!.command, "20.3 requestQuote"); assert.equal(forgedRow[0]!.result, "refused");
  // a service principal sending a human actor
  const svcHuman = await api("POST", `/v1/applications/${appId}/tools/20.3/requestQuote`, { ...body, actor: { kind: "human", id: ids["pam"], role: "mlo_of_record" } }, bearer(tokenS));
  assert.equal(svcHuman.status, 403, JSON.stringify(svcHuman.body)); assert.equal(svcHuman.body["code"], "NO_HUMAN_ROLE_ON_SERVICE_PRINCIPAL");
  // the shared API_TOKEN: refused in production (a second runtime + server over the same database with ENVIRONMENT=production), honoured outside it and logged shared_token
  const prod = new Runtime({ db, registry: loadOverriddenRegistry(), clock, logger, environment: "production", env: { INTEGRATIONS: "fake", ENVIRONMENT: "production" } as NodeJS.ProcessEnv, reviewers: null });
  const prodServer = createApiServer({ runtime: prod, apiToken: TOKEN, logger, borrower: { environment: "production", rpId: "localhost", allowedOrigins: ["http://localhost"], urlSecret: "test-secret" } });
  const prodBase = `http://127.0.0.1:${await listen(prodServer, 0, "127.0.0.1")}`;
  try {
    const refusedProd = await api("POST", `/v1/applications/${appId}/tools/20.3/requestQuote`, { ...body, actor: { kind: "human", id: ids["pam"], role: "mlo_of_record" } }, bearer(TOKEN), prodBase);
    assert.equal(refusedProd.status, 403, JSON.stringify(refusedProd.body)); assert.equal(refusedProd.body["code"], "SHARED_TOKEN_REFUSED_IN_PRODUCTION");
  } finally { await new Promise<void>((resolve) => { prodServer.closeAllConnections?.(); prodServer.close(() => resolve()); }); }
  const shared = await api("POST", `/v1/applications/${appId}/tools/20.3/requestQuote`, { ...body, actor: { kind: "human", id: ids["pam"], role: "mlo_of_record" } }, bearer(TOKEN));
  assert.equal(shared.status, 200, JSON.stringify(shared.body));
  const sharedRows = await actionsAtLeast(1, "surface = 'v1' AND source = 'shared_token' AND route = $1", [`/v1/applications/${appId}/tools/20.3/requestQuote`]);
  assert.ok(sharedRows.length >= 1); assert.equal(sharedRows[sharedRows.length - 1]!.principal_id, null); assert.equal(sharedRows[sharedRows.length - 1]!.result, "ok");
  assert.ok((await count("loan_events")) > before);
});

test("35.7-T4: Given officers A and B with their own principals and a 5.2 custodial advance transfer of $260,000.00 (26,000,000 cents, greater than the $250,000.00 threshold), when A submits it with `approvedBy: {kind: human, id: B, role: officer}` in the body, then it is refused `APPROVER_NOT_SELF_ASSERTED`; when A submits it without an approver, then it is refused `APPROVER_DISTINCT` with a `request_id`; when B calls `roles.approve{request_id}` under B's principal, then `dual_control.approved{requested_by: A, approved_by: B}` is logged and the transfer commits with `agent_decisions.approved_by = B` and `approved_role = officer`; when A calls `roles.approve` on A's own request, then `APPROVER_DISTINCT`; given the same transfer for $249,999.99 (24,999,999 cents), then A alone commits it and `approved_by = A`.", { skip }, async () => {
  await bootAdmin(); await invite("amy", AMY, ["officer"]); await invite("ben", BEN, ["officer"]);
  const ada = sessions["ada"]!; const f = await fixtureLoan();
  // the sections' own constants carry the figures: $250,000.00 strict, and the T−1 funding check's shortfall
  assert.equal(DUAL_CONTROL_SINGLE_TRANSFER_CENTS, 25_000_000n);
  assert.equal(fundingDecision(26_000_000n, 0n).shortfall_cents, 26_000_000n);
  assert.ok(26_000_000n > DUAL_CONTROL_SINGLE_TRANSFER_CENTS); assert.ok(!(25_000_000n > DUAL_CONTROL_SINGLE_TRANSFER_CENTS)); assert.ok(!(24_999_999n > DUAL_CONTROL_SINGLE_TRANSFER_CENTS));
  const principalFor = async (tag: string): Promise<string> => { const r = await api("POST", "/ops/api/principals", { kind: "staff", staff_user_id: ids[tag], name: `${tag}-cli`, scopes: { loans: "all", processes: ["5.", "35."] }, expires_at: at(30 * DAY) }, bearer(ada.token)); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body["token"] as string; };
  const A = await principalFor("amy"); const Bt = await principalFor("ben");
  const X = { op: "fund_draft", period: "2026-09", remittance_type: "ss", cycle: "standard", draft_date: "2026-09-18", custodial_account_id: f.custodial.pi, facility_available_cents: "50000000", expected_draft_cents: "26000000", custodial_available_cents: "0" };
  const post = (token: string, body: Json) => api("POST", `/v1/loans/${f.loanId}/tools/5.2/postLedger`, body, { ...bearer(token), "x-staff-role": "officer" });
  const before = await count("loan_events WHERE loan_id = $1", [f.loanId]);
  // a body approvedBy, or input.approvals, is refused whatever it says
  const forged = await post(A, { input: X, approvedBy: { kind: "human", id: ids["ben"], role: "officer" } });
  assert.equal(forged.status, 403, JSON.stringify(forged.body)); assert.equal(forged.body["code"], "APPROVER_NOT_SELF_ASSERTED");
  const forged2 = await post(A, { input: { ...X, approvals: [{ kind: "human", id: ids["ben"], role: "officer" }] } });
  assert.equal(forged2.status, 403, JSON.stringify(forged2.body)); assert.equal(forged2.body["code"], "APPROVER_NOT_SELF_ASSERTED");
  assert.equal(await count("loan_events WHERE loan_id = $1", [f.loanId]), before, "nothing ran");
  // without an approver: APPROVER_DISTINCT with the request the second officer approves
  const first = await post(A, { input: X });
  assert.equal(first.status, 409, JSON.stringify(first.body)); assert.equal(first.body["code"], "APPROVER_DISTINCT"); assert.equal(first.body["command"], "5.2 postLedger"); assert.equal(first.body["role"], "officer"); assert.deepEqual(first.body["subject"], { kind: "loan", id: f.loanId });
  const reqId = first.body["request_id"] as string; assert.ok(isUuidLike(reqId));
  const requested = (await events("dual_control.requested")).filter((e) => e.payload["request_id"] === reqId);
  assert.equal(requested.length, 1); assert.equal(requested[0]!.loan_id, null); assert.equal(requested[0]!.payload["requested_by"], ids["amy"]); assert.equal(requested[0]!.payload["command"], "5.2 postLedger");
  assert.equal(await count("ledger_lines WHERE loan_id = $1", [f.loanId]), 0);
  const again = await post(A, { input: X }); assert.equal(again.status, 409); assert.equal(again.body["request_id"], reqId, "the same open request");
  // B approves under B's principal
  const approve = (token: string, request_id: string) => api("POST", "/v1/tools/35.7/roles.approve", { input: { request_id } }, { ...bearer(token), "x-staff-role": "officer" });
  const ok = await approve(Bt, reqId); assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const approvedEv = (await events("dual_control.approved")).filter((e) => e.payload["request_id"] === reqId);
  assert.equal(approvedEv.length, 1); assert.equal(approvedEv[0]!.payload["requested_by"], ids["amy"]); assert.equal(approvedEv[0]!.payload["approved_by"], ids["ben"]); assert.equal(approvedEv[0]!.payload["approved_role"], "officer");
  const approvalDecisions = (await decisions("roles.approve")).filter((d) => d.subject_id === reqId); assert.equal(approvalDecisions.length, 1); assert.equal(approvalDecisions[0]!.subject_kind, "approval");
  // A re-submits with the request: the transfer commits, approved by B
  const committed = await post(A, { input: X, request_id: reqId }); assert.equal(committed.status, 200, JSON.stringify(committed.body));
  const fundDecisions = (await decisions("postLedger:fund_draft")).filter((d) => d.loan_id === f.loanId);
  assert.equal(fundDecisions.length, 1); assert.equal(fundDecisions[0]!.approved_by, ids["ben"]); assert.equal(fundDecisions[0]!.approved_role, "officer");
  const consumed = (await events("dual_control.consumed")).filter((e) => e.payload["request_id"] === reqId); assert.equal(consumed.length, 1); assert.equal(consumed[0]!.loan_id, f.loanId);
  // A on A's own fresh request: APPROVER_DISTINCT; B again on the consumed one: APPROVAL_STALE
  const fresh = await post(A, { input: { ...X, draft_date: "2026-09-21" } }); assert.equal(fresh.status, 409); const reqId2 = fresh.body["request_id"] as string; assert.notEqual(reqId2, reqId);
  const self = await approve(A, reqId2); assert.equal(self.status, 409, JSON.stringify(self.body)); assert.equal(self.body["code"], "APPROVER_DISTINCT");
  const stale = await approve(Bt, reqId); assert.equal(stale.status, 409, JSON.stringify(stale.body)); assert.equal(stale.body["code"], "APPROVAL_STALE");
  // $249,999.99: A alone commits it
  const alone = await post(A, { input: { ...X, expected_draft_cents: "24999999", draft_date: "2026-09-25" } }); assert.equal(alone.status, 200, JSON.stringify(alone.body));
  const aloneDecisions = (await decisions("postLedger:fund_draft")).filter((d) => d.loan_id === f.loanId);
  assert.equal(aloneDecisions.length, 2); assert.equal(aloneDecisions[1]!.approved_by, ids["amy"]);
  // exactly $250,000.00 (25,000,000 cents) is not greater than the threshold: A alone commits it too
  const exact = await post(A, { input: { ...X, expected_draft_cents: "25000000", draft_date: "2026-09-28" } }); assert.equal(exact.status, 200, JSON.stringify(exact.body));
  const exactDecisions = (await decisions("postLedger:fund_draft")).filter((d) => d.loan_id === f.loanId); assert.equal(exactDecisions.length, 3); assert.equal(exactDecisions[2]!.approved_by, ids["amy"]);
});

test("35.7-T5: Given a 3.7 payee remittance change for an existing payee of $10,000.01 (1,000,001 cents), when one `officer` submits it, then `APPROVER_DISTINCT` until a second officer's `roles.approve`; given the same change for exactly $10,000.00 (1,000,000 cents), then one officer commits it; given a new payee for $500.00, then two officers are required whatever the amount.", { skip }, async () => {
  await bootAdmin(); await invite("amy", AMY, ["officer"]); await invite("ben", BEN, ["officer"]);
  const ada = sessions["ada"]!; const f = await fixtureLoan();
  const principalFor = async (tag: string): Promise<string> => { const r = await api("POST", "/ops/api/principals", { kind: "staff", staff_user_id: ids[tag], name: `${tag}-3-7`, scopes: { loans: "all", processes: ["3.", "35."] }, expires_at: at(30 * DAY) }, bearer(ada.token)); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body["token"] as string; };
  const A = await principalFor("amy"); const Bt = await principalFor("ben");
  const D0 = wallClock(Date.parse(clock.now()), "America/New_York").date; const Y0 = new Date(Date.parse(`${D0}T12:00:00Z`) - DAY).toISOString().slice(0, 10);
  // the section's own constant and rule: > $10,000.00 with a payee change, or a new payee whatever the amount
  assert.equal(PAYEE_CHANGE_DUAL_OVER_CENTS, 1_000_000n); assert.ok(1_000_001n > PAYEE_CHANGE_DUAL_OVER_CENTS); assert.ok(!(1_000_000n > PAYEE_CHANGE_DUAL_OVER_CENTS));
  assert.equal(releaseApproval({ amount_cents: 1_000_001n, payee_instruction_changed_on: D(Y0), release_on: D(D0), new_payee: false }).dual_approval_required, true);
  assert.equal(releaseApproval({ amount_cents: 1_000_000n, payee_instruction_changed_on: D(Y0), release_on: D(D0), new_payee: false }).dual_approval_required, false);
  assert.equal(releaseApproval({ amount_cents: 50_000n, payee_instruction_changed_on: null, release_on: D(D0), new_payee: true }).dual_approval_required, true);
  const Rin = { op: "release", kind: "tax", amount_cents: "1000001", escrow_balance_cents: "5000000", reserved_within_5bd_cents: "0", payee_instruction_changed_on: Y0, release_on: D0, payee_evidence_document_id: randomUUID(), disbursement_id: `d-${R}-1` };
  const post = (token: string, body: Json) => api("POST", `/v1/loans/${f.loanId}/tools/3.7/releaseDisbursement`, body, { ...bearer(token), "x-staff-role": "officer" });
  const approve = (token: string, request_id: string) => api("POST", "/v1/tools/35.7/roles.approve", { input: { request_id } }, { ...bearer(token), "x-staff-role": "officer" });
  const released = () => decisions("disbursement.released").then((ds) => ds.filter((d) => d.loan_id === f.loanId));
  // $10,000.01 with a payee change: two officers
  const one = await post(A, { input: Rin }); assert.equal(one.status, 409, JSON.stringify(one.body)); assert.equal(one.body["code"], "APPROVER_DISTINCT"); const req1 = one.body["request_id"] as string;
  assert.equal((await released()).length, 0);
  assert.equal((await approve(Bt, req1)).status, 200);
  const two = await post(A, { input: Rin, request_id: req1 }); assert.equal(two.status, 200, JSON.stringify(two.body));
  const d1 = await released(); assert.equal(d1.length, 1); assert.equal(d1[0]!.approved_by, ids["ben"]); assert.equal(d1[0]!.approved_role, "officer");
  // exactly $10,000.00: one officer commits it
  const exact = await post(A, { input: { ...Rin, amount_cents: "1000000", disbursement_id: `d-${R}-2` } }); assert.equal(exact.status, 200, JSON.stringify(exact.body));
  const d2 = await released(); assert.equal(d2.length, 2); assert.equal(d2[1]!.approved_by, ids["amy"]);
  // a self-asserted approvals list is refused even under the threshold
  const forged = await post(A, { input: { ...Rin, amount_cents: "1000000", approvals: [{ kind: "human", id: ids["ben"], role: "officer" }] } }); assert.equal(forged.status, 403, JSON.stringify(forged.body)); assert.equal(forged.body["code"], "APPROVER_NOT_SELF_ASSERTED");
  // a new payee for $500.00: two officers whatever the amount
  const newPayee = { ...Rin, amount_cents: "50000", new_payee: true, payee_instruction_changed_on: undefined, disbursement_id: `d-${R}-3` };
  const np = await post(A, { input: newPayee }); assert.equal(np.status, 409, JSON.stringify(np.body)); assert.equal(np.body["code"], "APPROVER_DISTINCT"); const req3 = np.body["request_id"] as string;
  assert.equal((await approve(Bt, req3)).status, 200);
  const np2 = await post(A, { input: newPayee, request_id: req3 }); assert.equal(np2.status, 200, JSON.stringify(np2.body));
  const d3 = await released(); assert.equal(d3.length, 3); assert.equal(d3[2]!.approved_by, ids["ben"]);
});

test("35.7-T6: Given the fixture book with two open `attorney` escalations, one 35.6 step in `waiting_human{funding_approver}` and a pending terms review, under `INTEGRATIONS=fake` with the FAKE set on, when the daily `roles.queue_scan` unit runs through `cycles.run_unit`, then twenty-two `role_queue_snapshots` rows exist for the scan with `attorney = {open_items: 2, holders: 0, fake: false, status: unstaffed}`, `funding_approver = {open_items: 1, fake: true, status: fake}` and `mlo_of_record = {open_items: 1, fake: true, status: fake}`, exactly one `role.queue.unstaffed{role: attorney}` is logged and `SM_ROLE_QUEUE_UNSTAFFED_1BD` is armed on `{environment, role: attorney}` with the due date one servicer business day after `detected_at`; a second scan the same day logs no second event and arms no second clock; when `roles.grant{role: attorney}` activates for a person, then `role.staffed{cause: grant}` satisfies the clock.", { skip }, async () => {
  await bootAdmin(); await invite("att", ATT, ["ops_analyst"]);
  const f = await fixtureLoan();
  const app1 = (await runtime.createApplication({ partner_party_id: (await db.query<{ id: string }>(`SELECT id::text AS id FROM parties ORDER BY created_at LIMIT 1`))[0]!.id, channel: "organic", transaction_type: "purchase", occupancy: "primary", borrowers: [{ legal_name: "T6 Borrower" }] } as never, { kind: "system", id: "test" })).application.id;
  const sys: Actor = { kind: "system", id: "test-35.7" };
  for (const n of [1, 2]) await openEscalation({ kind: "attorney", ownerRole: "attorney", loanId: f.loanId, payload: { reason: `counsel ${n}` } }, sys);
  await runtime.uow.run({ applicationId: app1 }, (ctx) => { ctx.events.append({ type: "terms.presentation.requested", applicationId: app1, actor: sys, payload: { quote_id: `q-${R}`, lead_id: `lead-${R}`, origination: true } }); }, { clock });
  const ports = { orchestrationSteps: { waitingHuman: async () => [{ role: "funding_approver", application_id: app1, since: T0 }] } };
  const planned_by = `human:${ids["ada"]}`;
  const run1 = randomUUID(); await ROLES_QUEUE_SCAN.run(runtime, { as_of: "2026-09-14", scan_run_id: run1, planned_by }, ports);
  type Snap = { role: string; open_items: number; holders: number; fake: boolean; status: string };
  const snaps = async (run: string): Promise<Snap[]> => db.query<Snap>(`SELECT role, open_items, holders, fake, status FROM role_queue_snapshots WHERE scan_run_id = $1 AND environment = 'nonprod' ORDER BY role`, [run]);
  const s1 = await snaps(run1); assert.equal(s1.length, 22); assert.deepEqual(new Set(s1.map((r) => r.role)), new Set(HUMAN_ROLES));
  const row = (rows: Snap[], role: string): Omit<Snap, "role"> => { const r = rows.find((x) => x.role === role)!; return { open_items: r.open_items, holders: r.holders, fake: r.fake, status: r.status }; };
  assert.deepEqual(row(s1, "attorney"), { open_items: 2, holders: 0, fake: false, status: "unstaffed" });
  assert.deepEqual({ open_items: row(s1, "funding_approver").open_items, fake: row(s1, "funding_approver").fake, status: row(s1, "funding_approver").status }, { open_items: 1, fake: true, status: "fake" });
  assert.deepEqual({ open_items: row(s1, "mlo_of_record").open_items, fake: row(s1, "mlo_of_record").fake, status: row(s1, "mlo_of_record").status }, { open_items: 1, fake: true, status: "fake" });
  const unstaffed = () => events("role.queue.unstaffed", "AND aggregate_kind = 'role_queue' AND aggregate_id = 'nonprod:attorney'");
  const u1 = await unstaffed(); assert.equal(u1.length, 1); assert.equal(u1[0]!.payload["role"], "attorney"); assert.equal(u1[0]!.payload["environment"], "nonprod"); assert.equal(u1[0]!.loan_id, null);
  const clock1 = await timers("SM_ROLE_QUEUE_UNSTAFFED_1BD", "AND subject_kind = 'role_queue' AND subject_id = 'nonprod:attorney'");
  assert.equal(clock1.length, 1); assert.equal(clock1[0]!.status, "armed");
  const detectedAt = u1[0]!.payload["detected_at"] as string; assert.ok(detectedAt);
  assert.equal(clock1[0]!.due_date, addBusinessDays(D(wallClock(Date.parse(detectedAt), "America/New_York").date), 1, servicer).toString()); assert.equal(clock1[0]!.due_date, "2026-09-15");
  // a second scan the same day: 22 more rows, no second event, no second clock
  const run2 = randomUUID(); await ROLES_QUEUE_SCAN.run(runtime, { as_of: "2026-09-14", scan_run_id: run2, planned_by }, ports);
  assert.equal((await snaps(run2)).length, 22); assert.equal((await unstaffed()).length, 1);
  assert.equal((await timers("SM_ROLE_QUEUE_UNSTAFFED_1BD", "AND subject_id = 'nonprod:attorney'")).length, 1);
  // the grant staffs the role and satisfies the clock
  const g = await tool("roles.grant", adminActor(), { staff_user_id: ids["att"], role: "attorney", environment: "nonprod", rationale: "T6" });
  assert.equal((g.output as Json)["status"], "active"); assert.equal((g.output as Json)["staffed"], true);
  const staffed = (await events("role.staffed", "AND aggregate_id = 'nonprod:attorney'")); assert.equal(staffed.length, 1); assert.equal(staffed[0]!.payload["cause"], "grant"); assert.equal(staffed[0]!.payload["staff_user_id"], ids["att"]);
  const after = await timers("SM_ROLE_QUEUE_UNSTAFFED_1BD", "AND subject_id = 'nonprod:attorney'"); assert.equal(after.length, 1); assert.equal(after[0]!.status, "satisfied");
});

test("35.7-T7: Given `FAKE_REVIEWERS=off` and no holder of `funding_approver`, when a 26.3 wire waits for release for two sweeps, then nothing approves it, `roles.queue` shows `funding_approver` as `unstaffed` and `handover.board` shows the FAKE off for every role; given `ENVIRONMENT=production`, `INTEGRATIONS=fake` and `FAKE_REVIEWERS` unset, then the environment's FAKE set is empty (`fakeReviewerRolesFromEnv` returns `[]`), the reviewers' tick approves nothing, and the board shows `NO_FAKE_IN_PRODUCTION` as the reason.", { skip }, async () => {
  await bootAdmin();
  const envOff = { INTEGRATIONS: "fake", FAKE_REVIEWERS: "off" } as NodeJS.ProcessEnv;
  assert.deepEqual(fakeReviewerRolesFromEnv(envOff), []);
  // the runtime carries FAKE reviewers whose set resolves from the environment (FAKE_REVIEWERS=off → nothing): the tick runs and approves nothing
  const runtimeOff = new Runtime({ db, registry: loadOverriddenRegistry(), clock, logger, environment: "nonprod", env: envOff, reviewers: new FakeReviewers({ delaySeconds: 0 }) });
  const app1 = (await db.query<{ id: string }>(`SELECT application_id::text AS id FROM loan_events WHERE type = 'terms.presentation.requested' AND payload->>'quote_id' = $1`, [`q-${R}`]))[0]!.id;
  // a 26.3 wire waiting for release: the funding_approver escalation the tool opens (section26-3.ts), saved as the runtime saves it
  const escId = await openEscalation({ kind: "funding_approver", ownerRole: "funding_approver", applicationId: app1, payload: { funding_id: `fnd-${R}`, wire_id: `w-${R}`, amount_cents: "100000", four_eyes_check: { preparer: "a", releaser: "b" }, sla: "SM_O73_DUAL_CONTROL_RELEASE_1H" } }, { kind: "system", id: "test-35.7" });
  const executedBefore = await count("loan_events WHERE type = 'command.executed' AND payload->>'command' = 'prepareWire'");
  const sweepA = await runtimeOff.sweep(); clock.set(at(MIN)); const sweepB = await runtimeOff.sweep();
  for (const rep of [sweepA, sweepB]) { assert.ok(rep.reviewers, "the tick ran"); assert.equal(rep.reviewers!.actions.filter((a) => a.outcome === "approved").length, 0, "the FAKE approved nothing with FAKE_REVIEWERS=off"); }
  assert.deepEqual([...runtimeOff.reviewers!.roles], [], "the set resolved to nothing"); assert.equal(runtimeOff.reviewers!.fills("funding_approver"), false);
  assert.equal((await db.query<{ c: string | null }>(`SELECT completed_at::text AS c FROM escalations WHERE id = $1`, [escId]))[0]!.c, null, "nothing approved the wire");
  assert.equal(await count("loan_events WHERE type = 'command.executed' AND payload->>'command' = 'prepareWire'"), executedBefore);
  const q = await runtimeOff.execute({ process: "35.7", name: "roles.queue", loanId: "", actor: adminActor(), input: { environment: "nonprod", role: "funding_approver" } });
  const fa = ((q.output as Json)["roles"] as Json[])[0]!;
  assert.deepEqual({ role: fa["role"], status: fa["status"], open_items: fa["open_items"], holders: fa["holders"], fake: fa["fake"] }, { role: "funding_approver", status: "unstaffed", open_items: 1, holders: 0, fake: false });
  const boardOff = (await runtimeOff.execute({ process: "35.7", name: "handover.board", loanId: "", actor: adminActor(), input: { environment: "nonprod" } })).output as Json;
  assert.equal(boardOff["fake_reason"], "FAKE_REVIEWERS_OFF"); assert.deepEqual(boardOff["fake_current"], []);
  assert.ok((boardOff["roles"] as Json[]).every((r) => r["fake"] === false && r["fake_reason"] === "FAKE_REVIEWERS_OFF"), "the FAKE is off for every role");
  // production: the FAKE set is empty whatever INTEGRATIONS says; the tick approves nothing; the board names the reason
  assert.deepEqual(fakeReviewerRolesFromEnv({ ENVIRONMENT: "production", INTEGRATIONS: "fake" } as NodeJS.ProcessEnv), []);
  const runtimeProd = new Runtime({ db, registry: loadOverriddenRegistry(), clock, logger, environment: "production", env: { INTEGRATIONS: "fake", ENVIRONMENT: "production" } as NodeJS.ProcessEnv, reviewers: null });
  const rev = new FakeReviewers({ roles: FAKE_REVIEWER_ROLES, delaySeconds: 0 });
  const rep = await rev.tick(runtimeProd);
  assert.equal(rep.actions.filter((a) => a.outcome === "approved").length, 0); assert.equal(rev.fills("funding_approver"), false); assert.deepEqual([...rev.roles], []);
  assert.equal((await db.query<{ c: string | null }>(`SELECT completed_at::text AS c FROM escalations WHERE id = $1`, [escId]))[0]!.c, null);
  const boardProd = (await runtimeProd.execute({ process: "35.7", name: "handover.board", loanId: "", actor: adminActor(), input: { environment: "production" } })).output as Json;
  assert.equal(boardProd["fake_reason"], "NO_FAKE_IN_PRODUCTION"); assert.ok((boardProd["roles"] as Json[]).every((r) => r["fake"] === false && r["fake_reason"] === "NO_FAKE_IN_PRODUCTION"));
});

test("35.7-T8: Given nonprod with a holder of `funding_approver` who signed in within 30 days, when `compliance` calls `handover.enable{role: funding_approver}` and a different `admin` confirms the `request_id` within 10 minutes, then `role_handovers{action: enabled, requested_by, confirmed_by, holders, pending_items}` and `handover.enabled` exist, `FakeReviewers.fills(\"funding_approver\")` is false on a second `Runtime` over the same database while the other five roles are still filled, and the console marks no `funding_approver` row \"— FAKE reviewer\"; when the requester confirms their own request, then `TWO_PERSON_HANDOVER`; when no confirmation arrives in 10 minutes, then `handover.request.expired` and the FAKE still fills the role.", { skip }, async () => {
  await bootAdmin(); await invite("fin", FIN, ["ops_analyst"]); await invite("cara", CARA, ["compliance"]);
  const G = await grant("fin", "funding_approver");   // requested by the admin, confirmed by CARA; FIN signed in today
  assert.ok(G);
  const cara = await signIn(CARA); const ada = await signIn(ADA);
  const enable = (token: string, body: Json) => api("POST", "/ops/api/handover/enable", { environment: "nonprod", ...body }, bearer(token));
  const req = await enable(cara.token, { role: "funding_approver" });
  assert.equal(req.status, 200, JSON.stringify(req.body)); assert.equal(req.body["status"], "requested"); const reqId = req.body["request_id"] as string; assert.ok(reqId);
  assert.equal(Date.parse(req.body["expires_at"] as string) - Date.parse(clock.now()), 10 * MIN);
  assert.equal(await count("role_handovers WHERE request_id = $1 AND action = 'requested'", [reqId]), 1);
  const self = await enable(cara.token, { request_id: reqId }); assert.equal(self.status, 403, JSON.stringify(self.body)); assert.equal(self.body["code"], "TWO_PERSON_HANDOVER");
  const ok = await enable(ada.token, { request_id: reqId }); assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body["status"], "enabled");
  type HRow = { action: string; environment: string; role: string; requested_by: string; confirmed_by: string; holders: string[]; pending_items: number; decision_id: string | null; effective_at: string };
  const [h] = await db.query<HRow>(`SELECT action, environment, role, requested_by::text AS requested_by, confirmed_by::text AS confirmed_by, holders, pending_items, decision_id::text AS decision_id, effective_at::text AS effective_at FROM role_handovers WHERE request_id = $1 AND action = 'enabled'`, [reqId]);
  assert.deepEqual({ action: h!.action, environment: h!.environment, role: h!.role, requested_by: h!.requested_by, confirmed_by: h!.confirmed_by, holders: h!.holders }, { action: "enabled", environment: "nonprod", role: "funding_approver", requested_by: ids["cara"], confirmed_by: ids["ada"], holders: [ids["fin"]] });
  assert.equal(typeof h!.pending_items, "number"); assert.ok(h!.decision_id);
  const enabledEv = (await events("handover.enabled")).filter((e) => e.payload["request_id"] === reqId); assert.equal(enabledEv.length, 1); assert.equal(enabledEv[0]!.payload["by"], ids["cara"]); assert.equal(enabledEv[0]!.payload["confirmed_by"], ids["ada"]); assert.deepEqual(enabledEv[0]!.payload["holders"], [ids["fin"]]);
  // a second Runtime over the same database: the FAKE no longer fills funding_approver, still fills the other five
  const rt2 = new Runtime({ db, registry: loadOverriddenRegistry(), clock, logger, environment: "nonprod", env: ENV_NONPROD, reviewers: new FakeReviewers({ delaySeconds: 0 }) });
  await rt2.reviewers!.refresh(rt2);
  assert.equal(rt2.reviewers!.fills("funding_approver"), false);
  for (const r of FAKE_REVIEWER_ROLES.filter((x) => x !== "funding_approver")) assert.equal(rt2.reviewers!.fills(r), true, r);
  // the console queue: no funding_approver row is marked; an mlo_of_record row still is
  await openEscalation({ kind: "mlo_of_record", ownerRole: "mlo_of_record", payload: { reason: "T8 marker" } }, { kind: "system", id: "test-35.7" });
  const store = new PgConsoleStore(db, loadOverriddenRegistry(), runtime.agents, { fakeReviewers: { roles: [...FAKE_REVIEWER_ROLES], delaySeconds: 0, resolve: () => currentFakeSet(db, "nonprod", envDefault(ENV_NONPROD, "nonprod").roles) } });
  const faRows = await store.queue({ role: "funding_approver", now: clock.now() }); assert.ok(faRows.length >= 1); assert.ok(faRows.every((i) => !i.title.endsWith("— FAKE reviewer")), JSON.stringify(faRows.map((i) => i.title)));
  const mloRows = await store.queue({ role: "mlo_of_record", now: clock.now() }); assert.ok(mloRows.some((i) => i.title.endsWith("— FAKE reviewer")), JSON.stringify(mloRows.map((i) => i.title)));
  // a request nobody confirms expires after 10 minutes; the FAKE still fills that role
  await grant("fin", "signing_officer");
  const req2 = await enable(cara.token, { role: "signing_officer" }); assert.equal(req2.status, 200, JSON.stringify(req2.body)); const reqId2 = req2.body["request_id"] as string;
  clock.set(at(11 * MIN)); await runtime.sweep();
  assert.equal(await count("role_handovers WHERE request_id = $1 AND action = 'expired'", [reqId2]), 1);
  assert.equal((await events("handover.request.expired")).filter((e) => e.payload["request_id"] === reqId2).length, 1);
  await rt2.reviewers!.refresh(rt2); assert.equal(rt2.reviewers!.fills("signing_officer"), true); assert.equal(rt2.reviewers!.fills("funding_approver"), false);
});

test("35.7-T9: Given nonprod where nobody holds `settlement_agent` and the only `qc_officer` holder last signed in 45 days ago, when `handover.plan` runs, then its rows read `settlement_agent: HANDOVER_NEEDS_HOLDER{missing: holder}` and `qc_officer: HANDOVER_NEEDS_HOLDER{missing: signed_in_30d}`, `handover.enable` for either is refused with the same code, and after a `settlement_agent` grant and a fresh `qc_officer` sign-in both rows read `ready` with the holders' ids and the open-item counts.", { skip }, async () => {
  await bootAdmin(); await invite("cara", CARA, ["compliance"]);
  // QUE is invited and enrolled today; the only sign-in is 45 days ago (the clock steps back for that one sign-in and returns)
  const adaNow = await signIn(ADA);
  const inv = await api("POST", "/ops/api/staff/invite", { email: QUE.email, legal_name: QUE.name, roles: ["ops_analyst"] }, bearer(adaNow.token)); assert.equal(inv.status, 200, JSON.stringify(inv.body));
  const back = clock.now(); try { clock.set(new Date(Date.parse(T0) - 45 * DAY).toISOString()); ids["que"] = await enrol(QUE); await signIn(QUE); } finally { clock.set(back); }
  await grant("que", "qc_officer");
  // QUE is the ONLY qc_officer holder: T2's grant to OLI (this world) is revoked first
  if (ids["oli"]) for (const g of (await grants(ids["oli"]!, "qc_officer")).filter((x) => x.action === "grant")) { const rv = await tool("roles.revoke", adminActor(), { grant_id: g.id, rationale: "T9: one holder" }); assert.ok(rv.output); }
  const cara = await signIn(CARA);
  const plan = async (): Promise<Json[]> => { const r = await api("POST", "/ops/api/handover/plan", { environment: "nonprod" }, bearer(cara.token)); assert.equal(r.status, 200, JSON.stringify(r.body)); const rows = r.body["roles"] as Json[]; assert.equal(rows.length, 22); return rows; };
  const rowOf = (rows: Json[], role: string): Json => rows.find((r) => r["role"] === role)!;
  const p1 = await plan();
  assert.deepEqual({ plan: rowOf(p1, "settlement_agent")["plan"], missing: rowOf(p1, "settlement_agent")["missing"], holders: rowOf(p1, "settlement_agent")["holders"], signed: rowOf(p1, "settlement_agent")["holders_signed_in_30d"] }, { plan: "HANDOVER_NEEDS_HOLDER", missing: "holder", holders: [], signed: 0 });
  assert.deepEqual({ plan: rowOf(p1, "qc_officer")["plan"], missing: rowOf(p1, "qc_officer")["missing"], holders: rowOf(p1, "qc_officer")["holders"], signed: rowOf(p1, "qc_officer")["holders_signed_in_30d"] }, { plan: "HANDOVER_NEEDS_HOLDER", missing: "signed_in_30d", holders: [ids["que"]], signed: 0 });
  assert.ok(await count("role_handovers WHERE action = 'planned' AND role = 'settlement_agent'") >= 1); assert.ok((await events("handover.planned")).length >= 1);
  for (const [role, missing] of [["settlement_agent", "holder"], ["qc_officer", "signed_in_30d"]] as const) {
    const r = await api("POST", "/ops/api/handover/enable", { environment: "nonprod", role }, bearer(cara.token));
    assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body["code"], "HANDOVER_NEEDS_HOLDER"); assert.equal(r.body["role"], role); assert.equal(r.body["missing"], missing);
  }
  // a settlement_agent grant to a fresh signed-in person and a fresh qc_officer sign-in
  await invite("sam", SAM, ["ops_analyst"]); await grant("sam", "settlement_agent"); await signIn(QUE);
  const p2 = await plan();
  assert.deepEqual({ plan: rowOf(p2, "settlement_agent")["plan"], holders: rowOf(p2, "settlement_agent")["holders"], signed: rowOf(p2, "settlement_agent")["holders_signed_in_30d"] }, { plan: "ready", holders: [ids["sam"]], signed: 1 });
  assert.deepEqual({ plan: rowOf(p2, "qc_officer")["plan"], holders: rowOf(p2, "qc_officer")["holders"], signed: rowOf(p2, "qc_officer")["holders_signed_in_30d"] }, { plan: "ready", holders: [ids["que"]], signed: 1 });
  assert.equal(typeof rowOf(p2, "settlement_agent")["open_items"], "number"); assert.equal(typeof rowOf(p2, "qc_officer")["open_items"], "number");
});

test("35.7-T10: Given person P granted `underwriting_reviewer` in `reviewer_roles`, when P's session calls `POST /ops/api/tools/21.6/openReviewerEscalation` with `x-staff-role: underwriting_reviewer`, then the command commits with `actor = {human, <P.staff_user_id>, underwriting_reviewer}`, a `staff_actions` row carries `command = 21.6 openReviewerEscalation`, `role.exercised{grant_id}` is logged once (the second act logs none) and satisfies `SM_ROLE_GRANT_DORMANT_30D`; given a session that holds no such role, then 403 `ROLE_REQUIRED{underwriting_reviewer}` before any read (no `loan_events` row, no `agent_decisions` row).", { skip }, async () => {
  await bootAdmin(); await invite("uma", UMA, ["ops_analyst"]); await invite("qui", QUI, ["ops_analyst"]);
  const G = await grant("uma", "underwriting_reviewer");
  const app = await runtime.createApplication({ partner_party_id: (await db.query<{ id: string }>(`SELECT id::text AS id FROM parties ORDER BY created_at LIMIT 1`))[0]!.id, channel: "organic", transaction_type: "purchase", occupancy: "primary", borrowers: [{ legal_name: "T10 Borrower" }] } as never, { kind: "system", id: "test" });
  const appId = app.application.id;
  const body = { application_id: appId, input: { op: "officer", partner_name: "Partner", partner_address: "1 Main St, Sacramento, CA 95814", application_date: "2026-09-01", property_state: "CA", applicants: [{ id: "a1", name: "Ann", mailing_address: "1 Main St, Sacramento, CA 95814", esign_consent: false, primary: true }] } };
  const uma = await signIn(UMA);
  const r1 = await api("POST", "/ops/api/tools/21.6/openReviewerEscalation", body, { ...bearer(uma.token), "x-staff-role": "underwriting_reviewer" });
  assert.equal(r1.status, 200, JSON.stringify(r1.body)); assert.deepEqual(r1.body["actor"], { kind: "human", id: ids["uma"], role: "underwriting_reviewer" });
  const executed = (await events("command.executed", "AND application_id = $2", [appId])).filter((e) => e.payload["command"] === "openReviewerEscalation");
  assert.equal(executed.length, 1); assert.equal(executed[0]!.actor_id, ids["uma"]); assert.equal(executed[0]!.actor_role, "underwriting_reviewer");
  const logged = await actionsAtLeast(1, "route = '/ops/api/tools/21.6/openReviewerEscalation' AND session_id = $1", [uma.session_id]);
  assert.equal(logged.length, 1); assert.deepEqual({ command: logged[0]!.command, role: logged[0]!.role, surface: logged[0]!.surface, source: logged[0]!.source, staff_user_id: logged[0]!.staff_user_id, result: logged[0]!.result }, { command: "21.6 openReviewerEscalation", role: "underwriting_reviewer", surface: "ops", source: "session", staff_user_id: ids["uma"], result: "ok" });
  const ex1 = (await events("role.exercised")).filter((e) => e.payload["grant_id"] === G);
  assert.equal(ex1.length, 1); assert.equal(ex1[0]!.aggregate_kind, "role_grant"); assert.equal(ex1[0]!.aggregate_id, G); assert.equal(ex1[0]!.loan_id, null); assert.equal(ex1[0]!.payload["command"], "21.6 openReviewerEscalation"); assert.equal(ex1[0]!.payload["staff_user_id"], ids["uma"]);
  const dormant = await timers("SM_ROLE_GRANT_DORMANT_30D", "AND subject_id = $2", [G]); assert.equal(dormant.length, 1); assert.equal(dormant[0]!.status, "satisfied");
  // the second act logs no second role.exercised
  const r2 = await api("POST", "/ops/api/tools/21.6/openReviewerEscalation", body, { ...bearer(uma.token), "x-staff-role": "underwriting_reviewer" }); assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.equal((await events("role.exercised")).filter((e) => e.payload["grant_id"] === G).length, 1);
  // a session holding no such role: 403 ROLE_REQUIRED before any read — no event, no decision
  const qui = sessions["qui"]!;
  const ev = await count("loan_events"); const dec = await count("agent_decisions");
  const denied = await api("POST", "/ops/api/tools/21.6/openReviewerEscalation", body, { ...bearer(qui.token), "x-staff-role": "underwriting_reviewer" });
  assert.equal(denied.status, 403, JSON.stringify(denied.body)); assert.equal(denied.body["code"], "ROLE_REQUIRED"); assert.equal(denied.body["role"], "underwriting_reviewer"); assert.deepEqual(denied.body["held"], ["ops_analyst"]); assert.deepEqual(denied.body["act_as"], []);
  assert.equal(await count("loan_events"), ev); assert.equal(await count("agent_decisions"), dec);
  const deniedRow = await actionsAtLeast(1, "route = '/ops/api/tools/21.6/openReviewerEscalation' AND session_id = $1", [qui.session_id]);
  assert.equal(deniedRow.length, 1); assert.equal(deniedRow[0]!.result, "refused"); assert.equal(deniedRow[0]!.refusal_code, "ROLE_REQUIRED"); assert.equal(deniedRow[0]!.role, "underwriting_reviewer");
});

test("35.7-T11: Given a grant of `lossmit_reviewer` with no `role.exercised` for 30 calendar days, when the sweep's breach pass runs, then `SM_ROLE_GRANT_DORMANT_30D` breaches into one sev 3 `compliance` escalation naming the grant, the grant is still active, the board flags it `dormant`, and the next 34.1 access review's `keep` for that user without a `rationale` naming the grant is refused `DORMANT_GRANT_NEEDS_RATIONALE` while a `keep` with one succeeds and is recorded.", { skip }, async () => {
  const w = await world("t11", T0);
  try {
    const LM = person("lm");
    const wapi = (m: string, p: string, b?: unknown, h: Record<string, string> = {}) => api(m, p, b, h, w.base);
    const wCode = async (email: string): Promise<string> => { const c = await wapi("POST", "/ops/api/auth/code", { email }); assert.equal(c.status, 200, JSON.stringify(c.body)); const v = await wapi("POST", "/ops/api/auth/verify", { email, code: c.body["fake_code"] }); assert.equal(v.status, 200, JSON.stringify(v.body)); return v.body["token"] as string; };
    const wEnrol = async (p: { email: string; password: string }): Promise<string> => { const token = await wCode(p.email); const r = await wapi("POST", "/ops/api/auth/password", { token, password: p.password }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body["staff_user_id"] as string; };
    const wSignIn = async (p: { email: string; password: string }): Promise<string> => { await wCode(p.email); const r = await wapi("POST", "/ops/api/auth/signin", { email: p.email, password: p.password }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body["token"] as string; };
    const boot = await bootstrapStaffAdmin(w.runtime, ADA.email, { legal_name: ADA.name }); const adaId = boot.staff_user_id!; await wEnrol(ADA); let adaTok = await wSignIn(ADA);
    const wInvite = async (p: { email: string; name: string; password: string }, roles: string[]): Promise<string> => { const r = await wapi("POST", "/ops/api/staff/invite", { email: p.email, legal_name: p.name, roles }, bearer(adaTok)); assert.equal(r.status, 200, JSON.stringify(r.body)); const id = await wEnrol(p); await wSignIn(p); return id; };
    const caraId = await wInvite(CARA, ["compliance"]); const lmId = await wInvite(LM, ["ops_analyst"]);
    const wtool = (name: string, actor: Actor, input: Json) => w.runtime.execute({ process: "35.7", name, loanId: "", actor, input });
    const g = await wtool("roles.grant", { kind: "human", id: adaId, role: "admin" }, { staff_user_id: lmId, role: "lossmit_reviewer", rationale: "T11" });
    const G2 = (g.output as Json)["grant_id"] as string; assert.ok(G2); assert.equal((g.output as Json)["status"], "active");
    const wTimers = (code: string, subject: string) => w.db.query<{ id: string; status: string; due_date: string | null }>(`SELECT id::text AS id, status::text AS status, due_date::text AS due_date FROM timers WHERE code = $1 AND subject_id = $2 ORDER BY armed_at`, [code, subject]);
    const armed = await wTimers("SM_ROLE_GRANT_DORMANT_30D", G2); assert.equal(armed.length, 1); assert.equal(armed[0]!.status, "armed"); assert.equal(armed[0]!.due_date, "2026-10-14");
    // 31 days of silence: the breach pass raises one sev 3 compliance escalation naming the grant's clock; the grant is still active
    w.clock.set(new Date(Date.parse(T0) + 31 * DAY).toISOString());
    const rep = await w.runtime.sweep();
    assert.ok(rep.breaches.some((b) => b.code === "SM_ROLE_GRANT_DORMANT_30D" && b.timer_id === armed[0]!.id), JSON.stringify(rep.breaches));
    const esc = await w.db.query<{ kind: string; owner_role: string; timer_code: string; timer_id: string }>(`SELECT kind, owner_role, payload->>'timer_code' AS timer_code, payload->>'timer_id' AS timer_id FROM escalations WHERE payload->>'timer_code' = 'SM_ROLE_GRANT_DORMANT_30D'`);
    assert.equal(esc.length, 1); assert.equal(esc[0]!.kind, "sev3"); assert.equal(esc[0]!.owner_role, "compliance"); assert.equal(esc[0]!.timer_id, armed[0]!.id);
    assert.equal((await wTimers("SM_ROLE_GRANT_DORMANT_30D", G2))[0]!.status, "breached");
    const [latest] = await w.db.query<{ action: string }>(`SELECT action FROM role_grants WHERE staff_user_id = $1 AND role = 'lossmit_reviewer' ORDER BY created_at DESC, id DESC LIMIT 1`, [lmId]); assert.equal(latest!.action, "grant");
    const board = (await wtool("handover.board", { kind: "human", id: adaId, role: "admin" }, { environment: "nonprod" })).output as Json;
    const lmRow = (board["roles"] as Json[]).find((r) => r["role"] === "lossmit_reviewer")!; assert.deepEqual(lmRow["dormant_grants"], [{ grant_id: G2, staff_user_id: lmId }]);
    // the next 34.1 access review: keep without a rationale naming the grant is refused; with one it is recorded
    const caraTok = await wSignIn(CARA); adaTok = await wSignIn(ADA); void adaTok;
    const reviewsBefore = Number((await w.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM staff_access_reviews`))[0]!.n);
    const bare = await wapi("POST", "/ops/api/staff/access-review", { decisions: [{ staff_user_id: adaId, decision: "keep" }, { staff_user_id: caraId, decision: "keep" }, { staff_user_id: lmId, decision: "keep" }], rationale: "Q3" }, bearer(caraTok));
    assert.equal(bare.status, 409, JSON.stringify(bare.body)); assert.equal(bare.body["code"], "DORMANT_GRANT_NEEDS_RATIONALE"); assert.equal(bare.body["staff_user_id"], lmId); assert.equal(bare.body["grant_id"], G2);
    assert.equal(Number((await w.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM staff_access_reviews`))[0]!.n), reviewsBefore);
    const kept = await wapi("POST", "/ops/api/staff/access-review", { decisions: [{ staff_user_id: adaId, decision: "keep" }, { staff_user_id: caraId, decision: "keep" }, { staff_user_id: lmId, decision: "keep", rationale: `keeps lossmit_reviewer (grant ${G2}) for the Q4 pilot` }], rationale: "Q3" }, bearer(caraTok));
    assert.equal(kept.status, 200, JSON.stringify(kept.body));
    const [rev] = await w.db.query<{ users: Json[] }>(`SELECT users FROM staff_access_reviews WHERE id = $1`, [kept.body["review_id"]]);
    const lmEntry = rev!.users.find((u) => u["staff_user_id"] === lmId)!; assert.equal(lmEntry["decision"], "keep"); assert.match(String(lmEntry["rationale"]), new RegExp(G2)); assert.deepEqual(lmEntry["reviewer_roles"], ["lossmit_reviewer"]);
    assert.equal((await w.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM loan_events WHERE type = 'staff.access_review.completed' AND payload->>'review_id' = $1`, [kept.body["review_id"]]))[0]!.n, "1");
  } finally { await w.close(); }
});

test("35.7-T12: Given an active `compliance` member C who holds no reviewer role, when C calls `roles.breakglass{role: attorney, subject: {loan_id: L}, reason}`, then `role_grants{action: breakglass, expires_at = used_at + 4 hours}`, a `breakglass_uses` row, `role.breakglass.used` and an armed `SM_ROLE_BREAKGLASS_REVIEW_1BD` exist; an `attorney` act by C on loan L commits and the same act on loan M is `ROLE_DENIED`; after 4 hours the act on L is `ROLE_DENIED` and `role.revoked{cause: breakglass_expired}` is logged; `roles.breakglass{role: qc_officer}` is refused `NO_BREAKGLASS_INDEPENDENT_ROLE`; a review by C is refused `APPROVER_DISTINCT`, a review by another `compliance` member logs `role.breakglass.reviewed` and satisfies the clock.", { skip }, async () => {
  await bootAdmin(); await invite("cara", CARA, ["compliance"]); await invite("cora", CORA, ["compliance"]);
  const C = sessions["cara"]!; const L = await fixtureLoan(); const M = await fixtureLoan();
  const used = await api("POST", "/ops/api/roles/breakglass", { role: "attorney", subject: { loan_id: L.loanId }, reason: "counsel unreachable, sale tomorrow" }, bearer(C.token));
  assert.equal(used.status, 200, JSON.stringify(used.body));
  const bg = used.body["breakglass_id"] as string; const grantId = used.body["grant_id"] as string; const usedAt = used.body["used_at"] as string; const expiresAt = used.body["expires_at"] as string;
  assert.equal(Date.parse(expiresAt) - Date.parse(usedAt), 4 * HOUR);
  const g = (await grants(ids["cara"]!, "attorney")); assert.equal(g.length, 1); assert.deepEqual({ id: g[0]!.id, action: g[0]!.action, effective_at: g[0]!.effective_at.slice(0, 19), expires_at: g[0]!.expires_at!.slice(0, 19), granted_by: g[0]!.granted_by }, { id: grantId, action: "breakglass", effective_at: usedAt.slice(0, 19).replace("T", " "), expires_at: expiresAt.slice(0, 19).replace("T", " "), granted_by: ids["cara"] });
  const [use] = await db.query<{ grant_id: string; staff_user_id: string; role: string; subject_kind: string; subject_id: string; reason: string }>(`SELECT grant_id::text AS grant_id, staff_user_id::text AS staff_user_id, role, subject_kind, subject_id::text AS subject_id, reason FROM breakglass_uses WHERE id = $1`, [bg]);
  assert.deepEqual(use, { grant_id: grantId, staff_user_id: ids["cara"], role: "attorney", subject_kind: "loan", subject_id: L.loanId, reason: "counsel unreachable, sale tomorrow" });
  const usedEv = (await events("role.breakglass.used")).filter((e) => e.payload["breakglass_id"] === bg); assert.equal(usedEv.length, 1); assert.equal(usedEv[0]!.aggregate_kind, "breakglass"); assert.equal(usedEv[0]!.aggregate_id, bg);
  const clockRows = await timers("SM_ROLE_BREAKGLASS_REVIEW_1BD", "AND subject_id = $2", [bg]); assert.equal(clockRows.length, 1); assert.equal(clockRows[0]!.status, "armed"); assert.equal(clockRows[0]!.due_date, addBusinessDays(D(wallClock(Date.parse(usedAt), "America/New_York").date), 1, servicer));
  // an attorney act by C on L commits; the same act on M is ROLE_DENIED (19.2 portal_task.create: ciso | officer | attorney | ops_analyst on the bus, an act that opens an escalation; 4.1's case commands sit on the case agent's bus, not the runtime's)
  let cTok = C.token;
  const act = (loanId: string) => api("POST", "/ops/api/tools/19.2/portal_task.create", { loan_id: loanId, input: { portal: "fnma-servicing", owner_role: "attorney", loan_id: loanId } }, { ...bearer(cTok), "x-staff-role": "attorney" });
  const escBefore = await count("escalations WHERE kind = 'human_portal_task' AND payload->>'portal' = 'fnma-servicing'");
  const onL = await act(L.loanId); assert.equal(onL.status, 200, JSON.stringify(onL.body)); assert.deepEqual(onL.body["actor"], { kind: "human", id: ids["cara"], role: "attorney" });
  assert.equal(await count("escalations WHERE kind = 'human_portal_task' AND payload->>'portal' = 'fnma-servicing'"), escBefore + 1, "the act committed (the portal task's escalation row)");
  assert.equal((await events("command.executed", "AND loan_id = $2", [L.loanId])).filter((e) => e.payload["command"] === "portal_task.create" && e.actor_id === ids["cara"] && e.actor_role === "attorney").length, 1);
  const onM = await act(M.loanId); assert.equal(onM.status, 403, JSON.stringify(onM.body)); assert.equal(onM.body["code"], "ROLE_DENIED"); assert.equal(onM.body["role"], "attorney");
  // qc_officer cannot be broken into
  const indep = await api("POST", "/ops/api/roles/breakglass", { role: "qc_officer", subject: { loan_id: L.loanId }, reason: "no" }, bearer(C.token));
  assert.equal(indep.status, 409, JSON.stringify(indep.body)); assert.equal(indep.body["code"], "NO_BREAKGLASS_INDEPENDENT_ROLE");
  // a second break-glass by C for the same subject and role inside the 4 hours returns the existing use
  const again = await api("POST", "/ops/api/roles/breakglass", { role: "attorney", subject: { loan_id: L.loanId }, reason: "again" }, bearer(C.token)); assert.equal(again.status, 200); assert.equal(again.body["breakglass_id"], bg); assert.equal(again.body["existing"], true);
  // the review: by C refused APPROVER_DISTINCT; by another compliance member logged and satisfies the clock
  const selfReview = await api("POST", `/ops/api/roles/breakglass/${bg}/review`, { disposition: "justified", reason: "ok" }, bearer(C.token));
  assert.equal(selfReview.status, 409, JSON.stringify(selfReview.body)); assert.equal(selfReview.body["code"], "APPROVER_DISTINCT");
  const reviewed = await api("POST", `/ops/api/roles/breakglass/${bg}/review`, { disposition: "justified", reason: "the sale was real" }, bearer(sessions["cora"]!.token));
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  const revEv = (await events("role.breakglass.reviewed")).filter((e) => e.payload["breakglass_id"] === bg); assert.equal(revEv.length, 1); assert.equal(revEv[0]!.payload["reviewed_by"], ids["cora"]); assert.equal(revEv[0]!.payload["disposition"], "justified");
  assert.equal((await timers("SM_ROLE_BREAKGLASS_REVIEW_1BD", "AND subject_id = $2", [bg]))[0]!.status, "satisfied");
  assert.equal((await decisions("roles.breakglass:review")).filter((d) => d.subject_id === bg).length, 1);
  // after 4 hours: the act on L is ROLE_DENIED; the sweep logs the expiry
  clock.set(at(4 * HOUR + MIN)); cTok = (await signIn(CARA)).token;   // the session idled out over the jump (34.1 rule 5); the break-glass is what expired, not the person
  const late = await act(L.loanId); assert.equal(late.status, 403, JSON.stringify(late.body)); assert.equal(late.body["code"], "ROLE_DENIED");
  await runtime.sweep();
  const expiredRows = (await grants(ids["cara"]!, "attorney")).filter((x) => x.action === "breakglass_expired"); assert.equal(expiredRows.length, 1);
  const revoked = (await events("role.revoked")).filter((e) => e.payload["grant_id"] === grantId); assert.equal(revoked.length, 1); assert.equal(revoked[0]!.payload["cause"], "breakglass_expired");
  const lateAgain = await act(L.loanId); assert.equal(lateAgain.status, 403); assert.equal(lateAgain.body["code"], "ROLE_DENIED");
});

test("35.7-T13: Given an `admin` issues a staff principal for P with `scopes: {loans: [L1]}`, then the response carries the token once, `api_principals.token_hash` is its sha-256 and no column holds the token; a `/v1` command on L1 under it runs and on L2 answers 403 `PRINCIPAL_SCOPE`; after `principals.revoke` the next request is 401 `PRINCIPAL_REVOKED`; five presentations of the revoked token within an hour log one `principal.refused{count: 5}` and open one sev 2 `ciso` escalation, and a sixth opens no second one that hour; every request wrote a `staff_actions` row with `principal_id` and `surface = v1` and none contains the token.", { skip }, async () => {
  await bootAdmin(); await invite("pat", PAT, ["ops_analyst"]);
  const ada = sessions["ada"]!;
  const L1 = await fixtureLoan(); const L2 = await fixtureLoan();
  const issued = await api("POST", "/ops/api/principals", { kind: "staff", staff_user_id: ids["pat"], name: "pat-cli", scopes: { loans: [L1.loanId], processes: ["2."] }, expires_at: at(30 * DAY) }, bearer(ada.token));
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  const token = issued.body["token"] as string; const pid = issued.body["principal_id"] as string;
  assert.ok(token && token.length >= 40); assert.equal(issued.body["token_shown_once"], true);
  // the row holds the sha-256, never the token; no table holds it
  const [row] = await db.query<{ token_hash: string; text: string }>(`SELECT token_hash, api_principals::text AS text FROM api_principals WHERE id = $1`, [pid]);
  assert.equal(row!.token_hash, hashToken(token)); assert.equal(row!.token_hash, sha256hex(token)); assert.ok(!row!.text.includes(token));
  for (const t of ["staff_actions", "loan_events", "agent_decisions", "identities", "role_grants"]) assert.equal(await count(`${t} WHERE ${t}::text LIKE $1`, [`%${token}%`]), 0, `${t} never holds the token`);
  assert.equal((await events("principal.issued")).filter((e) => e.payload["principal_id"] === pid).length, 1);
  const [idn] = await db.query<{ entitlements: Json }>(`SELECT entitlements FROM identities WHERE subject = $1`, [`staff:${ids["pat"]}`]); assert.ok((idn!.entitlements["principals"] as string[]).includes(pid));
  // a /v1 command on L1 runs; on L2 the scope refuses
  const okL1 = await api("POST", `/v1/loans/${L1.loanId}/tools/2.1/suspense.read`, { input: {} }, bearer(token));
  assert.equal(okL1.status, 200, JSON.stringify(okL1.body));
  const scope = await api("POST", `/v1/loans/${L2.loanId}/tools/2.1/suspense.read`, { input: {} }, bearer(token));
  assert.equal(scope.status, 403, JSON.stringify(scope.body)); assert.equal(scope.body["code"], "PRINCIPAL_SCOPE"); assert.equal(scope.body["loan_id"], L2.loanId);
  // revoke, then the dead token: 401 PRINCIPAL_REVOKED; five presentations in the hour → one principal.refused{count: 5} and one ciso escalation; a sixth adds none
  const revoked = await api("POST", `/ops/api/principals/${pid}/revoke`, { rationale: "t13" }, bearer(ada.token)); assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  assert.equal((await events("principal.revoked")).filter((e) => e.payload["principal_id"] === pid && e.payload["cause"] === "revoke").length, 1);
  for (let n = 1; n <= 6; n++) {
    clock.set(at(MIN));
    const dead = await api("POST", `/v1/loans/${L1.loanId}/tools/2.1/suspense.read`, { input: {} }, bearer(token));
    assert.equal(dead.status, 401, JSON.stringify(dead.body)); assert.equal(dead.body["code"], "PRINCIPAL_REVOKED");
    const refusedEvents = (await events("principal.refused")).filter((e) => e.payload["principal_id"] === pid);
    const anomalies = await db.query<{ id: string; kind: string; owner_role: string }>(`SELECT id::text AS id, kind, owner_role FROM escalations WHERE owner_role = 'ciso' AND payload->>'principal_id' = $1`, [pid]);
    if (n < 5) { assert.equal(refusedEvents.length, 0, `no anomaly before the fifth (${n})`); assert.equal(anomalies.length, 0); }
    else { assert.equal(refusedEvents.length, 1, `one principal.refused after ${n}`); assert.equal(refusedEvents[0]!.payload["count"], 5); assert.equal(refusedEvents[0]!.payload["code"], "PRINCIPAL_REVOKED"); assert.equal(anomalies.length, 1); assert.equal(anomalies[0]!.kind, "sev2"); }
  }
  // every /v1 request wrote a row with the principal and surface v1; none contains the token
  const rows = await actionsAtLeast(8, "surface = 'v1' AND principal_id = $1", [pid]);
  assert.equal(rows.length, 1 + 1 + 6); assert.ok(rows.every((r) => r.source === "principal" && r.staff_user_id === ids["pat"] && r.command === "2.1 suspense.read"));
  assert.deepEqual(rows.map((r) => r.result), ["ok", "refused", "refused", "refused", "refused", "refused", "refused", "refused"]);
  assert.equal(await count(`staff_actions WHERE staff_actions::text LIKE $1`, [`%${token}%`]), 0);
});

test("35.7-T14: Given P holds `officer` in `roles`, `fnma_portal_operator` in `reviewer_roles`, an open session and an active principal, when an `admin` runs 34.1's `staff.disable` on P, then in the same transaction a `role_grants{action: revoke, cause: disabled}` row exists for `fnma_portal_operator`, the session and the principal are revoked, `identities.entitlements` for P is empty, and the next queue scan counts P among no role's holders.", { skip }, async () => {
  await bootAdmin(); await invite("pol", POL, ["officer"]);
  const ada = sessions["ada"]!;
  const G3 = await grant("pol", "fnma_portal_operator");
  const session = sessions["pol"]!;
  const issued = await api("POST", "/ops/api/principals", { kind: "staff", staff_user_id: ids["pol"], name: "pol-cli", scopes: { loans: "all" }, expires_at: at(30 * DAY) }, bearer(ada.token)); assert.equal(issued.status, 200, JSON.stringify(issued.body));
  const pid = issued.body["principal_id"] as string;
  const disabled = await api("POST", `/ops/api/staff/${ids["pol"]}/disable`, { rationale: "t14: left the company" }, bearer(ada.token));
  assert.equal(disabled.status, 200, JSON.stringify(disabled.body)); assert.equal(disabled.body["changed"], true);
  // all in the one transaction (asserted after the response): the revoke row, the word dropped, the session and the principal revoked, the mirror emptied
  const rows = await grants(ids["pol"]!, "fnma_portal_operator"); const last = rows[rows.length - 1]!;
  assert.deepEqual({ action: last.action, cause: last.cause, granted_by: last.granted_by }, { action: "revoke", cause: "disabled", granted_by: null }); assert.equal(rows[0]!.id, G3);
  assert.deepEqual((await db.query<{ reviewer_roles: string[]; status: string }>(`SELECT reviewer_roles, status::text AS status FROM staff_users WHERE id = $1`, [ids["pol"]]))[0], { reviewer_roles: [], status: "disabled" });
  assert.ok((await db.query<{ revoked_at: string | null }>(`SELECT revoked_at::text AS revoked_at FROM staff_sessions WHERE session_id = $1`, [session.session_id]))[0]!.revoked_at, "the session is revoked");
  const [p] = await db.query<{ revoked_at: string | null; revoked_by: string | null; revoked_cause: string | null }>(`SELECT revoked_at::text AS revoked_at, revoked_by::text AS revoked_by, revoked_cause FROM api_principals WHERE id = $1`, [pid]);
  assert.ok(p!.revoked_at); assert.equal(p!.revoked_by, ids["ada"]); assert.equal(p!.revoked_cause, "disabled");
  const [idn] = await db.query<{ entitlements: Json; disabled_at: string | null }>(`SELECT entitlements, disabled_at::text AS disabled_at FROM identities WHERE subject = $1`, [`staff:${ids["pol"]}`]);
  assert.deepEqual(idn!.entitlements, {}); assert.ok(idn!.disabled_at);
  assert.equal((await events("role.revoked")).filter((e) => e.payload["grant_id"] === G3 && e.payload["cause"] === "disabled").length, 1);
  assert.equal((await events("principal.revoked")).filter((e) => e.payload["principal_id"] === pid && e.payload["cause"] === "disabled").length, 1);
  assert.equal((await events("staff.disabled")).filter((e) => e.payload["staff_user_id"] === ids["pol"]).length, 1);
  // the next queue scan counts P among no role's holders
  const scan = await ROLES_QUEUE_SCAN.run(runtime, { as_of: wallClock(Date.parse(clock.now()), "America/New_York").date, scan_run_id: randomUUID(), planned_by: `human:${ids["ada"]}` });
  assert.equal(scan.rows.find((r) => r.role === "fnma_portal_operator")!.holders.includes(ids["pol"]!), false);
  assert.equal(scan.rows.find((r) => r.role === "officer")!.holders.includes(ids["pol"]!), false);
});

test("35.7-T15: Given the nonprod fixture after T6 and T8, when `handover.board` runs, then it lists exactly twenty-two roles with status, holders, signed-in-within-30-days, dormant grants, FAKE on/off with the `enabled` instant for `funding_approver`, open items and the oldest wait, last exercised and today's FAKE approvals, the FAKE-approval total equals the sum of `approved` in the day's reviewers' reports (`FakeReviewerReport.actions`), and no field of the payload is an e-mail, a phone or a token (a contract test over every string in the response).", { skip }, async () => {
  await bootAdmin();
  const runtimeFake = new Runtime({ db, registry: loadOverriddenRegistry(), clock, logger, environment: "nonprod", env: ENV_NONPROD, reviewers: new FakeReviewers({ delaySeconds: 0 }) });
  const reports: FakeReviewerReport[] = [];
  for (let n = 0; n < 2; n++) { const rep = await runtimeFake.sweep(); assert.ok(rep.reviewers, "the tick ran"); reports.push(rep.reviewers!); }
  const ada = await signIn(ADA);
  const r = await api("GET", "/ops/api/handover/board?environment=nonprod", undefined, bearer(ada.token)); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  const board = r.body; const rows = board["roles"] as Json[];
  assert.equal(rows.length, 22); assert.deepEqual(new Set(rows.map((x) => x["role"])), new Set(HUMAN_ROLES));
  const KEYS = ["status", "holders", "holders_signed_in_30d", "dormant_grants", "fake", "fake_since", "fake_reason", "open_items", "oldest_opened_at", "last_exercised_at", "fake_approvals_today"];
  for (const row of rows) for (const k of KEYS) assert.ok(k in row, `${String(row["role"])} carries ${k}`);
  const fa = rows.find((x) => x["role"] === "funding_approver")!; assert.equal(fa["fake"], false);
  const [enabled] = await db.query<{ effective_at: string }>(`SELECT effective_at::text AS effective_at FROM role_handovers WHERE environment = 'nonprod' AND role = 'funding_approver' AND action = 'enabled' ORDER BY created_at DESC LIMIT 1`);
  assert.equal(Date.parse(fa["fake_since"] as string), Date.parse(enabled!.effective_at));
  assert.ok(rows.filter((x) => x["fake"] === true).length >= 1, "the other FAKE roles are still on");
  // the day's FAKE approvals equal the sum of approved actions in the day's reviewers' reports
  const asOf = board["as_of"] as string; assert.equal(asOf, wallClock(Date.parse(clock.now()), "America/New_York").date);
  const approvedInReports = reports.filter((x) => wallClock(Date.parse(x.at), "America/New_York").date === asOf).reduce((n, x) => n + x.actions.filter((a) => a.outcome === "approved").length, 0);
  const onBoard = rows.reduce((n, x) => n + Number(x["fake_approvals_today"]), 0);
  assert.equal(onBoard, approvedInReports);
  assert.equal(await count("loan_events WHERE type = 'fake_reviewer.approved' AND occurred_at >= $1::timestamptz", [`${asOf}T04:00:00Z`]), approvedInReports);
  // the contract: no e-mail, phone or token anywhere in the payload
  const strings: string[] = []; const walk = (v: unknown): void => { if (typeof v === "string") strings.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") Object.values(v as Json).forEach(walk); }; walk(board);
  assert.ok(strings.length > 22);
  for (const s of strings) assert.doesNotMatch(s, /@|^\+?\d{10,}$|^[A-Za-z0-9_-]{43}$/, `no e-mail, phone or token: ${s}`);
});

test("35.7-T16: Given the first `role.queue.scan_completed{as_of_date: D}` on the global subject, then `SM_HANDOVER_BOARD_DAILY` is armed for D + 1 calendar day at 06:30 America/New_York through the `subject: \"global\"` override in src/domain/operations-runtime/timers-35-7.ts; the next day's completion satisfies and re-arms it; a day with no completion breaches it into one sev 3 `compliance` escalation, and `npm run spec:lint -- --verbose` lists the code as armable and satisfiable.", { skip }, async () => {
  const w = await world("t16", "2026-09-14T11:00:00Z");
  try {
    const rows = () => w.db.query<{ id: string; status: string; subject_kind: string; subject_id: string; anchor_date: string; due_date: string | null; due_at: string | null }>(`SELECT id::text AS id, status::text AS status, subject_kind, subject_id, anchor_date::text AS anchor_date, due_date::text AS due_date, due_at::text AS due_at FROM timers WHERE code = 'SM_HANDOVER_BOARD_DAILY' ORDER BY armed_at, id`);
    const completions = () => w.db.query<{ as_of: string }>(`SELECT payload->>'as_of_date' AS as_of FROM loan_events WHERE type = 'role.queue.scan_completed' ORDER BY sequence`);
    // 07:00 ET, no completion yet: the pass runs the daily scan; its receipt arms the clock for 06:30 ET tomorrow on the global subject
    const rep1 = await w.runtime.sweep(); assert.ok(rep1.roles?.daily_scan, JSON.stringify(rep1.roles));
    assert.deepEqual((await completions()).map((c) => c.as_of), ["2026-09-14"]);
    const t1 = await rows(); assert.equal(t1.length, 1);
    assert.equal(t1[0]!.subject_kind, "global"); assert.equal(t1[0]!.status, "armed"); assert.equal(t1[0]!.anchor_date, "2026-09-14"); assert.equal(t1[0]!.due_date, "2026-09-15"); assert.equal(Date.parse(t1[0]!.due_at!), Date.parse("2026-09-15T10:30:00Z"));
    const rep2 = await w.runtime.sweep(); assert.equal(rep2.roles?.daily_scan, false); assert.equal((await rows()).length, 1, "a second sweep the same day arms no second instance");
    // the next day's completion satisfies it and re-arms one for the day after
    w.clock.set("2026-09-15T10:31:00Z"); await w.runtime.sweep();
    assert.deepEqual((await completions()).map((c) => c.as_of), ["2026-09-14", "2026-09-15"]);
    const t2 = await rows(); assert.equal(t2.length, 2); assert.equal(t2[0]!.status, "satisfied"); assert.equal(t2[1]!.status, "armed"); assert.equal(t2[1]!.anchor_date, "2026-09-15"); assert.equal(t2[1]!.due_date, "2026-09-16"); assert.equal(t2[1]!.subject_id, t1[0]!.subject_id);
    // a day with no completion breaches it into one sev 3 compliance escalation
    w.clock.set("2026-09-17T09:00:00Z"); const rep3 = await w.runtime.sweep(); assert.equal(rep3.roles?.daily_scan, false, "05:00 ET is before the scan window");
    const t3 = await rows(); assert.equal(t3.find((t) => t.id === t2[1]!.id)!.status, "breached");
    assert.ok(rep3.breaches.some((b) => b.code === "SM_HANDOVER_BOARD_DAILY" && b.timer_id === t2[1]!.id), JSON.stringify(rep3.breaches));
    const esc = await w.db.query<{ kind: string; owner_role: string }>(`SELECT kind, owner_role FROM escalations WHERE payload->>'timer_code' = 'SM_HANDOVER_BOARD_DAILY'`);
    assert.equal(esc.length, 1); assert.deepEqual(esc[0], { kind: "sev3", owner_role: "compliance" });
    // the registry lint (npm run spec:lint -- --verbose) lists the code as armable and satisfiable, through the cited override
    const lint = spawnSync(process.execPath, ["--experimental-strip-types", "tools/lint-registry.ts", "--json"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(lint.status, 0, lint.stderr);
    const row = (JSON.parse(lint.stdout) as Json[]).find((x) => x["code"] === "SM_HANDOVER_BOARD_DAILY")!;
    assert.deepEqual({ armable: row["armable"], satisfiable: row["satisfiable"], emitted: row["emitted"], triggered: row["triggered"] }, { armable: true, satisfiable: true, emitted: true, triggered: true }, "npm run spec:lint -- --verbose lists SM_HANDOVER_BOARD_DAILY as armable and satisfiable");
    const def = loadOverriddenRegistry().get("SM_HANDOVER_BOARD_DAILY")!; assert.equal(def.subjectOverride, "global"); assert.equal(def.offset, "+1 calendar_days, 06:30 ET");
  } finally { await w.close(); }
});

test("35.7-T17: Given any command of this process (`roles.*`, `principals.*`, `handover.*`), then no ledger line and no `*_cents` column of any table changed (counts and sums before and after every tool in a contract test are identical), no section timer was satisfied, extended or cancelled by it, and every action tool wrote one `agent_decisions` row naming the person and one `staff_actions` row.", { skip }, async () => {
  await bootAdmin(); await invite("tia", TIA, ["ops_analyst"]); await invite("amy", AMY, ["officer"]); await invite("ben", BEN, ["officer"]); await invite("cara", CARA, ["compliance"]); await invite("cora", CORA, ["compliance"]); await invite("att", ATT, ["ops_analyst"]);
  const s = { ada: await signIn(ADA), amy: await signIn(AMY), ben: await signIn(BEN), cara: await signIn(CARA), cora: await signIn(CORA) };
  const N = await fixtureLoan();
  const attLatest = (await grants(ids["att"]!, "attorney")).at(-1); if (attLatest?.action !== "grant") await grant("att", "attorney");   // the handover below needs a holder signed in within 30 days
  // the fingerprints: the ledger (controls/common.ts) and every numeric *_cents column of every base table; the non-35.7 clocks
  const cols = await db.query<{ t: string; c: string; s: string }>(`SELECT c.table_schema AS s, c.table_name AS t, c.column_name AS c FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name WHERE t.table_type = 'BASE TABLE' AND c.table_schema IN ('public', 'restricted_fl') AND c.column_name LIKE '%\\_cents' AND c.data_type IN ('bigint', 'integer', 'smallint', 'numeric') ORDER BY 1, 2, 3`);
  assert.ok(cols.length > 100, `${cols.length} money columns`);
  const fingerprint = async (): Promise<string> => { const lines = [await moneyFingerprint(db)]; for (const k of cols) { const [r] = await db.query<{ n: string; sum: string }>(`SELECT count(*)::text AS n, coalesce(sum("${k.c}"), 0)::text AS sum FROM "${k.s}"."${k.t}"`); lines.push(`${k.s}.${k.t}.${k.c}=${r!.n}/${r!.sum}`); } return sha256hex(lines.join("\n")); };
  const clocks = async (): Promise<string> => sha256hex((await db.query<{ line: string }>(`SELECT id::text || ':' || status::text || ':' || coalesce(satisfied_at::text, '') || ':' || coalesce(breached_at::text, '') || ':' || coalesce(cancelled_reason, '') || ':' || coalesce(due_at::text, '') AS line FROM timers WHERE code NOT LIKE 'SM_ROLE_%' AND code <> 'SM_HANDOVER_BOARD_DAILY' ORDER BY id`)).map((r) => r.line).join("\n"));
  const money0 = await fingerprint(); const clocks0 = await clocks();
  type DecRow = { agent: string; rationale: string; approved_by: string | null };
  const lastDecisions = async (n: number): Promise<DecRow[]> => db.query<DecRow>(`SELECT agent, rationale, approved_by::text AS approved_by FROM agent_decisions ORDER BY created_at DESC, id DESC LIMIT $1`, [n]);
  // every command through the console's bus route: one staff_actions row `35.7 <name>`; action tools one decision naming the person
  const run = async (name: string, who: keyof typeof s, role: string, input: Json, kind: "act" | "read", expectBy: string = ids[who]!): Promise<Json> => {
    const decBefore = await count("agent_decisions"); const actBefore = await count("staff_actions WHERE command = $1", [`35.7 ${name}`]);
    const r = await api("POST", `/ops/api/tools/35.7/${name}`, { input }, { ...bearer(s[who].token), "x-staff-role": role });
    assert.equal(r.status, 200, `${name}: ${JSON.stringify(r.body).slice(0, 400)}`);
    assert.equal(await fingerprint(), money0, `${name} moved no money`); assert.equal(await clocks(), clocks0, `${name} touched no section clock`);
    assert.equal(await count("staff_actions WHERE command = $1", [`35.7 ${name}`]), actBefore + 1, `${name} on the log`);
    if (kind === "read") assert.equal(await count("agent_decisions"), decBefore, `${name} writes no decision`);
    else {
      // writeDecision is the generic row writer: the act's own decision row plus the one its handler records (src/app/tools.ts decision()) — both name the person
      const n = name === "writeDecision" ? 2 : 1; assert.equal(await count("agent_decisions"), decBefore + n, `${name} writes ${n === 1 ? "one decision" : "its two decision rows"}`);
      const ds = await lastDecisions(n); assert.ok(ds.some((d) => d.approved_by === ids[who]), `${name}: approved by the actor`); if (n === 1) assert.equal(ds[0]!.approved_by, ids[who]);
      const by = name === "writeDecision" ? ds.map((d) => d.agent) : [(JSON.parse(ds[0]!.rationale) as Json)["by"]]; assert.ok(by.includes(expectBy), `${name} names the person (${by.join(",")})`);
    }
    return r.body["output"] as Json;
  };
  const issued = await run("principals.issue", "ada", "admin", { kind: "staff", staff_user_id: ids["tia"], name: "tia-cli", scopes: { loans: "all" }, expires_at: at(DAY) }, "act");
  const plain = await run("roles.grant", "ada", "admin", { staff_user_id: ids["tia"], role: "notary", rationale: "T17 plain" }, "act"); assert.equal(plain["status"], "active");
  const pending = await run("roles.grant", "ada", "admin", { staff_user_id: ids["tia"], role: "bsa_officer", rationale: "T17 independence" }, "act"); assert.equal(pending["status"], "pending");
  await run("roles.grant", "cara", "compliance", { op: "confirm", request_id: pending["request_id"] }, "act", ids["ada"]);
  await run("roles.revoke", "ada", "admin", { grant_id: plain["grant_id"], rationale: "T17 revoke" }, "act");
  await run("roles.queue", "ada", "admin", { environment: "nonprod" }, "read");
  // a real open dual-control request (a refusal persists nothing but the request), approved by a distinct officer
  const X = { op: "fund_draft", period: "2026-09", remittance_type: "ss", cycle: "standard", draft_date: "2026-09-18", custodial_account_id: N.custodial.pi, facility_available_cents: "50000000", expected_draft_cents: "26000000", custodial_available_cents: "0" };
  const asked = await api("POST", "/ops/api/tools/5.2/postLedger", { loan_id: N.loanId, input: X }, { ...bearer(s.amy.token), "x-staff-role": "officer" }); assert.equal(asked.status, 409, JSON.stringify(asked.body)); assert.equal(asked.body["code"], "APPROVER_DISTINCT");
  assert.equal(await fingerprint(), money0);
  await run("roles.approve", "ben", "officer", { request_id: asked.body["request_id"] }, "act");
  const bg = await run("roles.breakglass", "cora", "compliance", { role: "attorney", subject: { loan_id: N.loanId }, reason: "T17" }, "act");
  await run("roles.breakglass", "cara", "compliance", { op: "review", breakglass_id: bg["breakglass_id"], disposition: "justified", reason: "T17" }, "act");
  await run("principals.revoke", "ada", "admin", { principal_id: issued["principal_id"], rationale: "T17" }, "act");
  await run("handover.plan", "cara", "compliance", { environment: "nonprod" }, "act");
  const hreq = await run("handover.enable", "cara", "compliance", { op: "request", environment: "nonprod", role: "attorney" }, "act"); assert.equal(hreq["status"], "requested");
  await run("handover.enable", "ada", "admin", { op: "confirm", request_id: hreq["request_id"], environment: "nonprod" }, "act");
  const rreq = await run("handover.enable", "cara", "compliance", { op: "revert", environment: "nonprod", role: "attorney", rationale: "T17 revert" }, "act"); assert.equal(rreq["status"], "revert_requested");
  const rself = await api("POST", "/ops/api/tools/35.7/handover.enable", { input: { op: "revert", request_id: rreq["request_id"], environment: "nonprod" } }, { ...bearer(s.cara.token), "x-staff-role": "compliance" }); assert.equal(rself.status, 403, JSON.stringify(rself.body)); assert.equal(rself.body["code"], "TWO_PERSON_HANDOVER");
  const rdone = await run("handover.enable", "ada", "admin", { op: "revert", request_id: rreq["request_id"], environment: "nonprod" }, "act"); assert.equal(rdone["status"], "reverted");
  assert.equal(await count("role_handovers WHERE request_id = $1 AND action = 'reverted'", [rreq["request_id"]]), 1);
  await run("handover.board", "ada", "admin", { environment: "nonprod" }, "read");
  await run("writeDecision", "amy", "officer", { action: "roles.note", rationale: "T17: a generic decision row", subject: { kind: "staff_user", id: ids["tia"] } }, "act");
});
