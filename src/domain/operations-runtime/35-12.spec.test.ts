// 35.12 Production posture: a production environment apart from nonprod, private networking, a person behind every credential, secrets and data classes, `INTEGRATIONS` as a real switch per vendor, backups and the restore drill, the go-live checklist, the four-week parallel run, and no borrower data in nonprod
// spec/sections/35-operations-runtime/35-12-production-posture.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// The harness (35-7.spec.test.ts's): the MAIN world is this file's own database with the API server of src/runtime/server.ts
// in-process (the ops console at /ops/api, the /v1 door), a FixedClock at 2026-11-16 09:00 ET (a Monday), the FAKE e-delivery port
// (the code echoed as `fake_code`) and the people invited/enrolled/signed in through the real doors (34.1), with `ciso` granted
// through 35.7's roles.grant (an independence role: the admin requests, a compliance member confirms). T-ids that own their clock
// or their staff table run on their own databases (`world`). Every 35.12 tool runs on the bus (`runtime.execute` or the console
// routes); the deploy workflow's manifest arrives on `/v1/posture/manifests` under a 35.7 service principal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { connect, type Db } from "../../infra/db/client.ts";
import { testDatabase } from "../../infra/db/test-db.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock, type Actor } from "../../kernel/events/index.ts";
import { Runtime } from "../../runtime/app.ts";
import { createApiServer, listen } from "../../runtime/server.ts";
import { createLogger } from "../../runtime/log.ts";
import { loadConfig } from "../../runtime/config.ts";
import { bootstrapStaffAdmin } from "../../runtime/staff/auth.ts";
import { PgLoanRepository } from "../../infra/db/loans.ts";
import { moneyFingerprint } from "../../runtime/controls/common.ts";
import { tinCipherKey } from "../../infra/pii/tin.ts";
import { boardTransferBatch } from "../../runtime/transfers.ts";
import { generateDemoBatch, DEMO_BATCH } from "../boarding/demo-batch.ts";
import { encodeTransferBatch } from "../boarding/tape-codec.ts";
import { seedEntryDemo } from "../../runtime/entry-seed.ts";
import { seedPartnerBookDemo } from "../../runtime/partner-book.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { buildPorts, describePorts, FakeSecretManager, RealLockbox } from "./posture-35-12/real-ports.ts";
import { VendorOff } from "./posture-35-12/refusals.ts";
import { goLiveNotBefore } from "./posture-35-12/go-live-gate.ts";
import { posturePass } from "./posture-35-12/sweep.ts";
import { parallelRunBoard, parseIncumbentFile } from "./posture-35-12/parallel-run.ts";
import { setPosturePorts, UNVERIFIED_ITEMS, type OurFigures } from "./posture-35-12/ports.ts";
import { hashedDocument, writeDocument } from "./posture-35-12/deps.ts";
import { GO_LIVE_VENDORS } from "./posture-35-12/types.ts";
import { ROLES_QUEUE_SCAN } from "./roles-35-7/queue.ts";
import { WORKED_A_UPB_CENTS, WORKED_A_ESCROW_L1_CENTS, WORKED_A_PI_CENTS, WORKED_A_LATE_CHARGE_BPS, WORKED_A_LATE_CHARGE_CENTS, WORKED_A_ESCROW_OURS_CENTS, WORKED_A_ESCROW_THEIRS_CENTS, WORKED_A_ESCROW_DELTA_CENTS, WORKED_A_MISMATCH_CENTS, WORKED_A_COMPARISONS, WORKED_A_MATCHED, WORKED_A_MISMATCHED, WORKED_B_RPO_S, WORKED_B_RTO_S, RECONCILE_FIELDS } from "./posture-35-12/types.ts";

const { url: DB_URL, skip } = await testDatabase(import.meta.url);
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TOKEN = "ops-" + randomUUID();
const R = randomUUID().slice(0, 8);
/** 2026-11-16 09:00 America/New_York (a Monday). */
const T0 = "2026-11-16T14:00:00.000Z";
const clock = new FixedClock(T0);
process.env["STAFF_EMAIL_KEY"] ??= "35.12-spec-staff-email-key";   // 34.1 requires the cipher key in production (a production runtime stands up over a test database)
const MIN = 60_000; const HOUR = 3_600_000; const DAY = 86_400_000;
const at = (ms: number, from: string = clock.now()): string => new Date(Date.parse(from) + ms).toISOString();
type Json = Record<string, unknown>;
const ENV_NONPROD = { INTEGRATIONS: "fake", ENVIRONMENT: "nonprod" } as NodeJS.ProcessEnv;
const AGENT: Actor = { kind: "agent", id: "compliance-sentinel" };
const sha256hex = (s: string): string => createHash("sha256").update(s).digest("hex");
const isUuidLike = (v: unknown): boolean => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
/** No e-mail, no name field, no 9-digit TIN pattern in a JSON blob (T18, T19). */
const PII_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|"(?:legal_name|name|email|e_mail|full_name)"\s*:\s*"[^"]+"|\b\d{3}-?\d{2}-?\d{4}\b/;
const noPii = (v: unknown, what: string): void => { const text = JSON.stringify(v); assert.ok(!PII_RE.test(text), `${what} carries no e-mail, name field or TIN: ${text.slice(0, 300)}`); };

const logLines: string[] = [];
const logger = createLogger("json", (line) => { logLines.push(line); if (process.env["FLOW_DEBUG"] && /error|unhandled|"status":[45]/i.test(line)) process.stderr.write(line + "\n"); });

// ---------------------------------------------------------------- worlds: a database, a runtime, a server, a clock and its people
interface World { readonly db: Db; readonly runtime: Runtime; readonly clock: FixedClock; readonly base: string; readonly environment: string; readonly people: People; close(): Promise<void> }
interface Person { readonly email: string; readonly name: string; readonly password: string }
const person = (tag: string): Person => ({ email: `${tag}.${R}@example.test`, name: `${tag} Person`, password: `${tag}-correct-horse-${R}` });
const PEOPLE: Record<string, Person> = { ada: person("ada"), cara: person("cara"), cora: person("cora"), cid: person("cid"), osc: person("osc"), ana: person("ana") };
type Reply = { status: number; body: Json; headers: Headers };
class People {
  readonly ids: Record<string, string> = {}; readonly sessions: Record<string, { token: string; session_id: string }> = {};
  private readonly w: { base: string; runtime: Runtime; db: Db };
  constructor(w: { base: string; runtime: Runtime; db: Db }) { this.w = w; }
  async api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
    const r = await fetch(this.w.base + path, { method, headers: { "content-type": "application/json", "x-forwarded-for": "10.35.0.12", "user-agent": "35.12-spec", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text(); return { status: r.status, body: text ? (JSON.parse(text) as Json) : {}, headers: r.headers };
  }
  bearer(tag: string): Record<string, string> { return { authorization: `Bearer ${this.sessions[tag]!.token}` }; }
  /** The session bearer acting as `role` (34.1 rule 3: the route's role is chosen, never silently substituted — x-staff-role names it). */
  as(tag: string, role: string): Record<string, string> { return { ...this.bearer(tag), "x-staff-role": role }; }
  private async codeToken(email: string): Promise<string> {
    const c = await this.api("POST", "/ops/api/auth/code", { email }); assert.equal(c.status, 200, JSON.stringify(c.body));
    const v = await this.api("POST", "/ops/api/auth/verify", { email, code: c.body["fake_code"] }); assert.equal(v.status, 200, JSON.stringify(v.body));
    return v.body["token"] as string;
  }
  private async enrol(p: Person): Promise<string> { const token = await this.codeToken(p.email); const r = await this.api("POST", "/ops/api/auth/password", { token, password: p.password }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body["staff_user_id"] as string; }
  async signIn(tag: string): Promise<void> { const p = PEOPLE[tag]!; await this.codeToken(p.email); const r = await this.api("POST", "/ops/api/auth/signin", { email: p.email, password: p.password }); assert.equal(r.status, 200, JSON.stringify(r.body)); this.sessions[tag] = { token: r.body["token"] as string, session_id: r.body["session_id"] as string }; }
  /** The bootstrap admin (once), then the person invited with 34.1 `roles`, enrolled and signed in. */
  async invite(tag: string, roles: string[]): Promise<string> {
    if (!this.ids["ada"]) { const boot = await bootstrapStaffAdmin(this.w.runtime, PEOPLE["ada"]!.email, { legal_name: PEOPLE["ada"]!.name }); this.ids["ada"] = boot.staff_user_id!; await this.enrol(PEOPLE["ada"]!); await this.signIn("ada"); }
    if (tag === "ada") return this.ids["ada"]!;
    if (this.ids[tag]) return this.ids[tag]!;
    await this.signIn("ada");
    const r = await this.api("POST", "/ops/api/staff/invite", { email: PEOPLE[tag]!.email, legal_name: PEOPLE[tag]!.name, roles }, this.bearer("ada")); assert.equal(r.status, 200, JSON.stringify(r.body));
    this.ids[tag] = await this.enrol(PEOPLE[tag]!); await this.signIn(tag);
    return this.ids[tag]!;
  }
  actor(tag: string, role: string): Actor { return { kind: "human", id: this.ids[tag]!, role }; }
  /** A reviewer role through 35.7's roles.grant — an independence role (ciso) is requested by the admin and confirmed by cara (compliance). */
  async grant(tag: string, role: string): Promise<void> {
    await this.invite("cara", ["compliance"]);
    const r = await this.w.runtime.execute({ process: "35.7", name: "roles.grant", loanId: "", actor: this.actor("ada", "admin"), input: { staff_user_id: this.ids[tag]!, role, rationale: `fixture: ${role}` } });
    const o = r.output as Json;
    if (o["status"] === "pending") await this.w.runtime.execute({ process: "35.7", name: "roles.grant", loanId: "", actor: this.actor("cara", "compliance"), input: { op: "confirm", request_id: o["request_id"] } });
    await this.signIn(tag);   // the grant revokes the sessions (35.7); sign in again with the new role
  }
  /** The usual cast: ada (admin), cara + cora (compliance), cid (ops_analyst → ciso), osc (officer), ana (ops_analyst). */
  async cast(): Promise<void> { await this.invite("ada", []); await this.invite("cara", ["compliance"]); await this.invite("cora", ["compliance"]); await this.invite("cid", ["ops_analyst"]); await this.invite("osc", ["officer"]); await this.invite("ana", ["ops_analyst"]); await this.grant("cid", "ciso"); }
  /** A 35.7 service principal for the deploy workflow (or the drill job): the token once. */
  async servicePrincipal(name: string, processes: string[] = ["35."]): Promise<{ token: string; principal_id: string }> {
    await this.signIn("ada");
    const r = await this.api("POST", "/ops/api/principals", { kind: "service", name, scopes: { loans: "all", applications: "all", processes }, expires_at: at(300 * DAY, this.w.runtime.clock.now()) }, this.bearer("ada"));
    assert.equal(r.status, 200, JSON.stringify(r.body)); return { token: r.body["token"] as string, principal_id: r.body["principal_id"] as string };
  }
}
async function world(suffix: string, nowIso: string, o: { env?: NodeJS.ProcessEnv; environment?: string } = {}): Promise<World> {
  const t = await testDatabase(import.meta.url, { suffix });
  const wdb = connect(t.url); const wclock = new FixedClock(nowIso); const environment = o.environment ?? "nonprod";
  const rt = new Runtime({ db: wdb, registry: loadOverriddenRegistry(), clock: wclock, logger, environment, env: o.env ?? { INTEGRATIONS: "fake", ENVIRONMENT: environment } as NodeJS.ProcessEnv, reviewers: null });
  const server = createApiServer({ runtime: rt, apiToken: TOKEN, logger, borrower: { environment, rpId: "localhost", allowedOrigins: ["http://localhost"], urlSecret: "test-secret" } });
  const wbase = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  const w = { db: wdb, runtime: rt, clock: wclock, base: wbase };
  return { ...w, environment, people: new People(w), close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => wdb.end().then(() => t.close()).then(() => resolve())); }) };
}
let MAIN: World;
test.before(async () => {
  if (skip) return;
  const db = connect(DB_URL);
  const runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock, logger, environment: "nonprod", env: ENV_NONPROD, reviewers: null });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger, borrower: { environment: "nonprod", rpId: "localhost", allowedOrigins: ["http://localhost"], urlSecret: "test-secret" } });
  const base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  const w = { db, runtime, clock, base };
  MAIN = { ...w, environment: "nonprod", people: new People(w), close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => db.end().then(() => resolve())); }) };
});
test.after(async () => { if (!skip) await MAIN.close(); });

// ---------------------------------------------------------------- rows and events
type EventRow = { type: string; actor_kind: string; actor_id: string; actor_role: string | null; aggregate_kind: string | null; aggregate_id: string | null; loan_id: string | null; payload: Json; sequence: string; occurred_at: string };
const events = async (db: Db, type: string, where = "", params: unknown[] = []): Promise<EventRow[]> => db.query<EventRow>(`SELECT type, actor_kind::text AS actor_kind, actor_id, actor_role, aggregate_kind, aggregate_id, loan_id::text AS loan_id, payload, sequence::text AS sequence, occurred_at::text AS occurred_at FROM loan_events WHERE type = $1 ${where} ORDER BY sequence`, [type, ...params]);
const count = async (db: Db, sql: string, params: unknown[] = []): Promise<number> => Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, params))[0]!.n);
type TimerRow = { id: string; code: string; status: string; subject_kind: string; subject_id: string; anchor_date: string; due_date: string | null; due_at: string | null; satisfied_at: string | null; breached_at: string | null; note: string | null };
const timers = async (db: Db, code: string, where = "", params: unknown[] = []): Promise<TimerRow[]> => db.query<TimerRow>(`SELECT id::text AS id, code, status::text AS status, subject_kind, subject_id, anchor_date::text AS anchor_date, due_date::text AS due_date, due_at::text AS due_at, satisfied_at::text AS satisfied_at, breached_at::text AS breached_at, note FROM timers WHERE code = $1 ${where} ORDER BY armed_at, id`, [code, ...params]);
type FindingRowT = { id: string; finding_id: string; environment: string; control_code: string; action: string; check_id: string | null; severity: string; detected_at: string; resolved_at: string | null; cause: string | null; exception_id: string | null; by: string | null; decision_id: string | null };
const findings = async (db: Db, where = "", params: unknown[] = []): Promise<FindingRowT[]> => db.query<FindingRowT>(`SELECT id::text AS id, finding_id::text AS finding_id, environment, control_code, action, check_id::text AS check_id, severity, detected_at::text AS detected_at, resolved_at::text AS resolved_at, cause, exception_id::text AS exception_id, by::text AS by, decision_id::text AS decision_id FROM posture_findings ${where ? "WHERE " + where : ""} ORDER BY created_at, id`, params);
type CheckRowT = { id: string; run_id: string; environment: string; manifest_id: string | null; control_code: string; result: string; observed: Json; expected: Json };
const checks = async (db: Db, runId: string): Promise<CheckRowT[]> => db.query<CheckRowT>(`SELECT id::text AS id, run_id::text AS run_id, environment, manifest_id::text AS manifest_id, control_code, result, observed, expected FROM posture_checks WHERE run_id = $1 ORDER BY control_code`, [runId]);
type EscRow = { id: string; kind: string; owner_role: string; severity: string | null; payload: Json; completed_at: string | null };
const escalations = async (db: Db, where: string, params: unknown[] = []): Promise<EscRow[]> => db.query<EscRow>(`SELECT id::text AS id, kind, owner_role, severity, payload, completed_at::text AS completed_at FROM escalations WHERE ${where} ORDER BY opened_at, id`, params);
type DecisionRow = { id: string; agent: string; action: string; subject_kind: string | null; subject_id: string | null; rationale: string; approved_by: string | null; rule_set_version: string; model_version: string | null; confidence: string | null };
const decisions = async (db: Db, action: string): Promise<DecisionRow[]> => db.query<DecisionRow>(`SELECT id::text AS id, agent, action, subject_kind, subject_id, rationale, approved_by::text AS approved_by, rule_set_version, model_version, confidence::text AS confidence FROM agent_decisions WHERE action = $1 ORDER BY created_at, id`, [action]);
/** A 35.12 tool on the bus (global scope). */
const tool = (w: World, name: string, actor: Actor, input: Json, run?: { runId: string; modelVersion: string; promptVersion: string; confidence?: number }) => w.runtime.execute({ process: "35.12", name, loanId: "", actor, input, ...(run ? { run } : {}) });
const refusalOf = async (p: Promise<unknown>): Promise<{ code: string; message: string; extra: Json }> => { try { await p; } catch (e) { const x = e as { code?: string; message: string; extra?: Json }; return { code: x.code ?? "", message: x.message, extra: x.extra ?? {} }; } assert.fail("expected a refusal"); };

// ---------------------------------------------------------------- manifests (Inputs and triggers), shaped from the facts the spec cites
const SECRETS = ["supermortgage-database-url", "supermortgage-staff-email-key", "supermortgage-tin-cipher-key", "supermortgage-borrower-url-secret", "supermortgage-api-token"];
const secretsFresh = (nowIso: string, daysOld = 10): Json[] => SECRETS.map((name) => ({ name, version_created_at: at(-daysOld * DAY, nowIso), placeholder: false }));
const SQL_KEY = "projects/supermortgage/locations/us-east4/keyRings/sm/cryptoKeys/sql";
/** A manifest shaped like nonprod at HEAD (T4): public IP (sql.tf:39), ZONAL (sql.tf:18), API_TOKEN among the env names (server.ts:46-48), integrations = fake (run.tf:10), roles/editor on the deployer (bootstrap.sh:121), waf_preview = true (lb.tf:45); everything else as the posture asks. */
function nonprodAtHead(environment: string, nowIso: string, digest = `sha256:abc${R}`): Json {
  return { environment, project_id: environment === "production" ? "supermortgage-prod" : "supermortgage-nonprod", region: "us-east4", image_digest: digest, migration_head: "0240", deploy_run_id: `run-${R}-${randomUUID().slice(0, 6)}`,
    terraform: { sql: { ipv4_enabled: true, private_service_access: false, availability_type: "ZONAL", pitr: true, log_retention_days: 7, retained_backups: 14, cmek_key: SQL_KEY, rotation_period_s: 7_776_000 }, registry: { cmek_key: SQL_KEY }, buckets: [{ name: "sm-documents", cmek_key: SQL_KEY }],
      run: { env_names: ["DATABASE_URL", "API_TOKEN", "ENVIRONMENT", "INTEGRATIONS", "STAFF_EMAIL_KEY", "TIN_CIPHER_KEY"], ingress: "internal-and-cloud-load-balancing", vpc_egress: "all-traffic", egress_rules: [] }, armor: { waf_preview: true, rate_limit_per_min: 600, allowlist_count: 1 }, iam: { deployer_roles: ["roles/editor"] }, org_policies: ["sql.restrictPublicIp", "iam.allowedPolicyMemberDomains", "compute.requireShieldedVm"], audit_sink: { locked: true } },
    secrets: secretsFresh(nowIso), runtime: { integrations: "fake", fake_reviewers: "on", environment, env_names: ["DATABASE_URL", "API_TOKEN", "ENVIRONMENT", "INTEGRATIONS"], demo_clock_status: 403, logs: { sample_lines: 1000, email_matches: 0, tin_matches: 0, name_fields: 0 } } };
}
/** The posture the spec asks for: private IP, REGIONAL, no shared token, real integrations, a narrowed deployer, the WAF enforced. */
function hardened(environment: string, nowIso: string, digest = `sha256:abc${R}`): Json {
  const m = nonprodAtHead(environment, nowIso, digest); const tf = m["terraform"] as Json;
  tf["sql"] = { ...(tf["sql"] as Json), ipv4_enabled: false, private_service_access: true, availability_type: "REGIONAL" };
  tf["run"] = { ...(tf["run"] as Json), env_names: ["DATABASE_URL", "ENVIRONMENT", "INTEGRATIONS", "STAFF_EMAIL_KEY", "TIN_CIPHER_KEY"] };
  tf["armor"] = { ...(tf["armor"] as Json), waf_preview: false }; tf["iam"] = { deployer_roles: ["roles/run.developer", "roles/cloudsql.client"] };
  m["runtime"] = { ...(m["runtime"] as Json), integrations: "real", fake_reviewers: "off", env_names: ["DATABASE_URL", "ENVIRONMENT", "INTEGRATIONS"] };
  return m;
}
/** 35.7's handover rows every kernel role `enabled` in the environment (PST-10's last clause), written as the fixture of a production that handed every role to a person. */
async function handoversEnabled(db: Db, environment: string, nowIso: string): Promise<void> {
  const { HUMAN_ROLES } = await import("../../app/roles.ts");
  for (const role of HUMAN_ROLES) await db.query(`INSERT INTO role_handovers (environment, role, action, holders, rationale, effective_at) VALUES ($1, $2, 'enabled', '[]'::jsonb, 'fixture: production is person-only', $3::timestamptz)`, [environment, role, nowIso]);
}
void spawnSync; void ROOT; void HOUR; void MIN; void PgLoanRepository; void moneyFingerprint; void tinCipherKey; void loadConfig; void boardTransferBatch; void generateDemoBatch; void DEMO_BATCH; void encodeTransferBatch; void seedEntryDemo; void seedPartnerBookDemo; void evaluateGate; void buildPorts; void describePorts; void FakeSecretManager; void RealLockbox; void VendorOff; void goLiveNotBefore; void posturePass; void parallelRunBoard; void parseIncumbentFile; void setPosturePorts; void (null as unknown as OurFigures); void sha256hex; void isUuidLike; void noPii; void events; void count; void timers; void findings; void checks; void escalations; void decisions; void tool; void refusalOf; void secretsFresh; void nonprodAtHead; void hardened; void handoversEnabled; void world; void at; void AGENT;
void WORKED_A_UPB_CENTS; void WORKED_A_ESCROW_L1_CENTS; void WORKED_A_PI_CENTS; void WORKED_A_LATE_CHARGE_BPS; void WORKED_A_LATE_CHARGE_CENTS; void WORKED_A_ESCROW_OURS_CENTS; void WORKED_A_ESCROW_THEIRS_CENTS; void WORKED_A_ESCROW_DELTA_CENTS; void WORKED_A_MISMATCH_CENTS; void WORKED_A_COMPARISONS; void WORKED_A_MATCHED; void WORKED_A_MISMATCHED; void WORKED_B_RPO_S; void WORKED_B_RTO_S; void RECONCILE_FIELDS;

// ---------------------------------------------------------------- the parallel run's fixtures (worked example A)
/** The three fixture loans' figures as of any day: loan 1 (all fields equal), loan 2 (our 2.7 late charge $62.50 = 5.000% × $1,250.00), loan 3 (our escrow $3,417.92). */
function workedFigures(loanIds: readonly string[]): Map<string, OurFigures> {
  return new Map<string, OurFigures>([
    [loanIds[0]!, { upb_cents: WORKED_A_UPB_CENTS, escrow_balance_cents: WORKED_A_ESCROW_L1_CENTS, next_due_date: "2026-12-01", late_charges_accrued_cents: 0n, interest_paid_ytd_cents: 1_345_002n, amount_due_cents: 0n, days_delinquent: 0, form_496_remittance_cents: 0n }],
    [loanIds[1]!, { upb_cents: 20_000_000n, escrow_balance_cents: 100_000n, next_due_date: "2026-11-01", late_charges_accrued_cents: WORKED_A_LATE_CHARGE_CENTS, interest_paid_ytd_cents: 900_000n, amount_due_cents: WORKED_A_PI_CENTS, days_delinquent: 16, form_496_remittance_cents: 0n }],
    [loanIds[2]!, { upb_cents: 30_000_000n, escrow_balance_cents: WORKED_A_ESCROW_OURS_CENTS, next_due_date: "2026-12-01", late_charges_accrued_cents: 0n, interest_paid_ytd_cents: 1_000_000n, amount_due_cents: 0n, days_delinquent: 0, form_496_remittance_cents: 0n }],
  ]);
}
const dollars = (c: bigint): string => `${c < 0n ? "-" : ""}${(c < 0n ? -c : c) / 100n}.${String((c < 0n ? -c : c) % 100n).padStart(2, "0")}`;
/** The incumbent's trial balance for a day: our figures, with the overrides a case names (loan index → field → cents / value). */
function incumbentCsv(loanIds: readonly string[], figures: Map<string, OurFigures>, overrides: Record<number, Partial<Record<string, bigint | string | number>>> = {}): string {
  const header = "servicer_loan_number,loan_id,upb,escrow_balance,next_due_date,late_charges_accrued,interest_paid_ytd,amount_due,days_delinquent,form_496_remittance";
  const rows = loanIds.map((id, k) => { const f = { ...figures.get(id)!, ...(overrides[k] ?? {}) } as Record<string, bigint | string | number | null>; const m = (key: string): string => dollars(f[key] as bigint); return [`INC-${k + 1}`, id, m("upb_cents"), m("escrow_balance_cents"), String(f["next_due_date"] ?? ""), m("late_charges_accrued_cents"), m("interest_paid_ytd_cents"), m("amount_due_cents"), String(f["days_delinquent"]), m("form_496_remittance_cents")].join(","); });
  return [header, ...rows].join("\n");
}
async function fixtureLoans(db: Db, n: number): Promise<string[]> { const repo = new PgLoanRepository(db); const out: string[] = []; for (let k = 0; k < n; k++) out.push((await repo.createFixture({ fnmaLoanNumber: `${(Date.now() + k) % 1_000_000}${Math.floor(Math.random() * 1000)}`.padStart(10, "0"), servicerLoanNumber: `SM-${randomUUID()}`, instrumentDate: "2021-07-15" as never, originalUpbCents: 26_000_000n, originalTermMonths: 360, firstPaymentDate: "2021-09-01" as never, maturityDate: "2051-08-01" as never })).loanId); return out; }
/** A world with the cast, three fixture loans and the worked-example figures port (35.5's typed rows are being built in parallel; the port is the seam). */
async function runWorld(suffix: string, nowIso: string): Promise<World & { loanIds: string[]; figures: Map<string, OurFigures> }> {
  const w = await world(suffix, nowIso); await w.people.cast();
  const loanIds = await fixtureLoans(w.db, 3); const figures = workedFigures(loanIds);
  setPosturePorts(w.runtime, { ourFigures: { figures: async (_q, loanId) => figures.get(loanId) ?? null } });
  return { ...w, loanIds, figures };
}
async function openRun(w: World, loanIds: readonly string[], openedOn: string): Promise<string> {
  const r = await w.people.api("POST", "/ops/api/parallel-run/open", { environment: "production", incumbent_servicer: "Incumbent", loan_ids: loanIds, opened_on: openedOn }, w.people.as("osc", "officer"));
  assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body["parallel_run_id"] as string;
}
const reconcile = (w: World, runId: string, asOf: string, csv: string, who: "officer" | "agent" = "agent") => (who === "agent" ? tool(w, "parallel_run.reconcile", AGENT, { parallel_run_id: runId, as_of_date: asOf, incumbent_file_csv: csv }).then((r) => ({ status: 200, body: r.output as Json })) : w.people.api("POST", `/ops/api/parallel-run/${runId}/reconcile`, { as_of_date: asOf, incumbent_file_csv: csv }, w.people.as("osc", "officer")));
/** The ledger and every numeric *_cents column of loans, fees, escrow_accounts and loan_installments, plus the notices rows — one hash (T11, T13, T19). */
async function moneyAndNotices(db: Db): Promise<string> {
  const cols = await db.query<{ t: string; c: string }>(`SELECT c.table_name AS t, c.column_name AS c FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name IN ('loans', 'fees', 'escrow_accounts', 'loan_installments') AND c.column_name LIKE '%\\_cents' AND c.data_type IN ('bigint', 'integer', 'smallint', 'numeric') ORDER BY 1, 2`);
  const lines = [await moneyFingerprint(db)];
  for (const k of cols) { const [r] = await db.query<{ n: string; sum: string; h: string }>(`SELECT count(*)::text AS n, coalesce(sum("${k.c}"), 0)::text AS sum, md5(coalesce(string_agg("${k.c}"::text, ',' ORDER BY "${k.c}"), '')) AS h FROM "${k.t}"`); lines.push(`${k.t}.${k.c}=${r!.n}/${r!.sum}/${r!.h}`); }
  const [fees] = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM fees`); lines.push(`fees=${fees!.n}`);
  const [notices] = await db.query<{ n: string; h: string }>(`SELECT count(*)::text AS n, md5(coalesce(string_agg(id::text, ',' ORDER BY id), '')) AS h FROM notices`); lines.push(`notices=${notices!.n}/${notices!.h}`);
  return sha256hex(lines.join("\n"));
}
void workedFigures; void incumbentCsv; void fixtureLoans; void runWorld; void openRun; void reconcile; void moneyAndNotices; void dollars;

// ---------------------------------------------------------------- the go-live fixture (T15, T16): production rows satisfying every item
/** The roles the cast holds beyond 34.1's staff words (35.7 roles.grant; the disjointness matrix respected): every kernel role staffed, the dual-control pairs on two people each. */
const REVIEWER_GRANTS: readonly (readonly [string, string])[] = [
  ["osc", "attorney"], ["osc", "signing_officer"], ["osc", "fnma_portal_operator"], ["osc", "human_agent"], ["osc", "lossmit_reviewer"], ["osc", "fraud_officer"], ["osc", "counsel"], ["osc", "mlo_of_record"], ["osc", "notary"], ["osc", "settlement_agent"], ["osc", "closing_attorney"], ["osc", "appraiser"], ["osc", "property_data_collector"], ["osc", "bsa_officer"], ["osc", "licensed_specialist"],
  ["ana", "underwriting_reviewer"], ["ana", "funding_approver"], ["cid", "funding_approver"], ["cora", "qc_officer"], ["quin", "qc_officer"],
];
interface GoLiveWorld extends World { readonly prod: Runtime; readonly prodBase: string; papi(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Reply>; ptool(name: string, actor: Actor, input: Json): Promise<Json>; readonly ev: { manifest_id: string; run_id: string; drill_id: string; scan_run_id: string; parallel_run_id: string; retention_doc: string; scan_ids: string[]; attestations: string[]; reports: string[]; confirmations: string[]; switch_ids: Record<string, string> } }
/**
 * A production over the world's database on 2026-11-30: the doors run nonprod (the FAKE e-delivery signs the cast in), the production
 * `Runtime` (INTEGRATIONS=real) records the manifests, runs the checks, the 35.7 board scan and the go-live tools. Rows: a hardened
 * staging manifest 25 h before the production one (PST-13); every active staff OIDC-bound, passwords revoked (PST-06); every kernel
 * role handed over (PST-10) and held by a person who signed in (GL-04); the vendors `o.vendors` switched real/live by ciso request +
 * compliance confirmation with a canary row each (GL-05; this build carries a real adapter for lockbox_bai2 only — the canaries are
 * fixture rows, [UNVERIFIED vendor-canary]); a passed drill (GL-03); thirty clean nonprod scans (GL-08); a parallel run over a book of
 * zero loans reconciled 11-02 … 11-30 and closed passed (GL-06); counsel's retention matrix and the [UNVERIFIED] confirmations as
 * documents (GL-07, GL-12); 35.4/35.11/35.5's rows through the ports (GL-10, GL-11, GL-09).
 */
async function goLiveWorld(suffix: string, o: { vendors: readonly string[] }): Promise<GoLiveWorld> {
  for (const tag of ["oli", "quin"]) PEOPLE[tag] ??= person(tag);
  const w = await world(suffix, "2026-11-01T14:00:00Z"); const db = w.db; const p = w.people;
  await p.cast(); await p.invite("oli", ["officer"]); await p.invite("quin", ["ops_analyst"]);
  for (const [tag, role] of REVIEWER_GRANTS) await p.grant(tag, role);
  const prod = new Runtime({ db, registry: loadOverriddenRegistry(), clock: w.clock, logger, environment: "production", env: { INTEGRATIONS: "real", ENVIRONMENT: "production" } as NodeJS.ProcessEnv, reviewers: null });
  const prodServer = createApiServer({ runtime: prod, apiToken: TOKEN, logger, borrower: { environment: "production", rpId: "localhost", allowedOrigins: ["http://localhost"], urlSecret: "test-secret" } });
  const prodBase = `http://127.0.0.1:${await listen(prodServer, 0, "127.0.0.1")}`;
  const papi = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> => { const r = await fetch(prodBase + path, { method, headers: { "content-type": "application/json", "x-forwarded-for": "10.35.0.12", "user-agent": "35.12-spec", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }); const text = await r.text(); return { status: r.status, body: text ? (JSON.parse(text) as Json) : {}, headers: r.headers }; };
  const ptool = async (name: string, actor: Actor, input: Json): Promise<Json> => (await prod.execute({ process: "35.12", name, loanId: "", actor, input })).output as Json;
  const attestations = [randomUUID(), randomUUID()]; const reports: string[] = []; for (let k = 6; k >= 0; k--) reports.push(randomUUID());
  setPosturePorts(prod, {
    servicingConfig: { status: async () => ({ config_rows: 0, profile_rows: 1, loans_without_config: 0, missing_tables: [] }) },
    closeAttestations: { attestations: async () => attestations.map((id, k) => ({ id, period: k === 0 ? "2026-10" : "2026-11", attested_at: k === 0 ? "2026-11-03T21:00:00Z" : "2026-11-30T13:00:00Z" })) },   // the array is the port's rows: a test pops one to open GL-10
    opsDailyReports: { reports: async () => reports.map((id, k) => ({ id, as_of_date: `2026-11-${String(24 + k).padStart(2, "0")}`, fake_approvals: 0 })) },
  });
  await handoversEnabled(db, "production", w.clock.now());
  // thirty clean nonprod scans (05:46 ET each day) and the parallel run's daily reconciliation over a book of zero loans (a header alone)
  const scan_ids: string[] = []; let parallel_run_id = "";
  for (let k = 0; k < 30; k++) {
    const d = `2026-11-${String(k + 1).padStart(2, "0")}`; w.clock.set(`${d}T10:46:00Z`);
    scan_ids.push(((await tool(w, "data.scan", AGENT, { environment: "nonprod", kind: "nonprod_real_data" })).output as Json)["scan_id"] as string);
    if (d === "2026-11-02") parallel_run_id = ((await prod.execute({ process: "35.12", name: "parallel_run.open", loanId: "", actor: p.actor("osc", "officer"), input: { environment: "production", incumbent_servicer: "Incumbent", loan_ids: [], opened_on: d } })).output as Json)["parallel_run_id"] as string;
    if (d >= "2026-11-02") { w.clock.set(`${d}T23:30:00Z`); await tool(w, "parallel_run.reconcile", AGENT, { parallel_run_id, as_of_date: d, incumbent_file_csv: "servicer_loan_number,loan_id,upb,escrow_balance,next_due_date,late_charges_accrued,interest_paid_ytd,amount_due,days_delinquent,form_496_remittance" }); }
  }
  // the staging promotion 25 hours before the production manifest
  const digest = `sha256:golive${R}`;
  w.clock.set("2026-11-29T13:00:00Z");
  const st = (await ptool("posture.record", AGENT, hardened("staging", w.clock.now(), digest)))["check"] as Json; assert.equal(st["failed"], 0, `staging: ${JSON.stringify((await checks(db, st["run_id"] as string)).filter((c) => c.result === "fail" || c.result === "unverifiable"))}`);
  // 2026-11-30: the drill, the switches with their canaries, the closed run, the documents, the OIDC bindings, the production manifest, the board scan
  w.clock.set("2026-11-30T14:00:00Z"); const now = w.clock.now();
  const tables = (await db.query<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema IN ('public', 'restricted_fl') AND table_type = 'BASE TABLE' ORDER BY 1`)).map((r) => r.t);
  const drill = await ptool("backup.drill", p.actor("cid", "ciso"), { environment: "production", source_backup_id: "backup-2026-11-30", backup_taken_at: "2026-11-30T07:00:00Z", pitr_target_at: "2026-11-30T11:00:00Z", newest_event_at: "2026-11-30T10:59:50Z", clone_instance: "supermortgage-drill-20261130", started_at: "2026-11-30T11:05:00Z", completed_at: "2026-11-30T12:30:00Z", row_checks: tables.map((t) => ({ table: t, source_count: 7, clone_count: 7 })), event_chain_ok: true, ledger_balanced: true, clone_destroyed_at: "2026-11-30T13:00:00Z", witnessed_by: p.ids["cara"] });
  assert.equal(drill["result"], "passed", JSON.stringify(drill));
  const switch_ids: Record<string, string> = {};
  for (const v of o.vendors) {
    const req = await ptool("integrations.switch", p.actor("cid", "ciso"), { op: "request", environment: "production", vendor: v, mode: "real", endpoint_class: "live", secret_ref: `supermortgage-vendor-${v}`, egress_rule: `egress-${v}`, rationale: "go-live" });
    const ok = await ptool("integrations.switch", p.actor("cara", "compliance"), { op: "confirm", request_id: req["request_id"] }); assert.equal(ok["status"], "switched", JSON.stringify(ok)); switch_ids[v] = ok["switch_id"] as string;
  }
  await prod.uow.run({}, (ctx) => { for (const v of o.vendors) ctx.events.append({ type: "integration.canary", aggregate: { kind: "integration_switch", id: `production:${v}` }, actor: { kind: "system", id: "35.12-spec-fixture" }, payload: { vendor: v, environment: "production", as_of_date: "2026-11-30", ok: true, latency_ms: 40, probe: "fixture: the vendor's real adapter is outside this build (35.12 rule 4) — [UNVERIFIED vendor-canary]", endpoint_class: "live", at: now, origination: true } }); }, { clock: w.clock });
  const closed = await prod.execute({ process: "35.12", name: "parallel_run.close", loanId: "", actor: p.actor("osc", "officer"), input: { parallel_run_id, outcome: "passed", reason: "28 days over the book, the last week clean" } }); assert.equal((closed.output as Json)["outcome"], "passed", JSON.stringify(closed.output));
  const rm = hashedDocument("retention-matrix", { version: "2026-11", signed_by_role: "counsel" }); await writeDocument(db, rm, { kind: "retention_matrix", retention: "corporate_7y", metadata: { signed_by_role: "counsel", signed_by: p.ids["osc"], bucket_lock_applied: true }, created_at: now });
  const confirmations: string[] = []; for (const key of UNVERIFIED_ITEMS) { const doc = hashedDocument("unverified-confirmation", { item_key: key, signed_by_role: "ciso" }); await writeDocument(db, doc, { kind: "unverified_confirmation", retention: "corporate_7y", metadata: { item_key: key, signed_by_role: "ciso", signed_by: p.ids["cid"] }, created_at: now }); confirmations.push(doc.id); }
  // the sessions the tests use (the doors are nonprod: a password signs in), then every active staff bound to the provider with the passwords revoked (PST-06)
  for (const tag of ["cid", "cara", "cora", "osc", "ana"]) await p.signIn(tag);
  for (const u of await db.query<{ id: string }>(`SELECT id::text AS id FROM staff_users WHERE status = 'active'`)) await db.query(`INSERT INTO staff_oidc_identities (staff_user_id, environment, issuer, subject, bound_at) VALUES ($1, 'production', 'https://accounts.google.com', $2, $3::timestamptz)`, [u.id, `sub-${u.id}`, now]);
  await db.query(`UPDATE staff_credentials SET revoked_at = $1 WHERE kind = 'password' AND revoked_at IS NULL`, [now]);
  const m = hardened("production", now, digest); ((m["terraform"] as Json)["run"] as Json)["egress_rules"] = [...o.vendors]; m["secrets"] = [...(m["secrets"] as Json[]), ...o.vendors.map((v) => ({ name: `supermortgage-vendor-${v}`, version_created_at: at(-3 * DAY, now), placeholder: false }))];
  const rec = await ptool("posture.record", AGENT, m); const chk = rec["check"] as Json;
  assert.equal(chk["failed"], 0, `production: ${JSON.stringify((await checks(db, chk["run_id"] as string)).filter((c) => c.result === "fail" || c.result === "unverifiable").map((c) => [c.control_code, c.result, c.observed]))}`); assert.equal(chk["unverifiable"], 0);
  const scan = await ROLES_QUEUE_SCAN.run(prod, { as_of: "2026-11-30", planned_by: "35.12-spec-fixture" });
  const ev = { manifest_id: rec["manifest_id"] as string, run_id: chk["run_id"] as string, drill_id: drill["drill_id"] as string, scan_run_id: (scan as unknown as Json)["scan_run_id"] as string, parallel_run_id, retention_doc: rm.id, scan_ids, attestations, reports, confirmations, switch_ids };
  return { ...w, prod, prodBase, papi, ptool, ev, close: async () => { await new Promise<void>((resolve) => { prodServer.closeAllConnections?.(); prodServer.close(() => resolve()); }); await w.close(); } };
}
void goLiveWorld; void GO_LIVE_VENDORS;

test("35.12-T1: Given `INTEGRATIONS=real` and `ENVIRONMENT=production` with `integration_switches` rows `lockbox_bai2 = real(live)` and none for `eoscar`, when the runtime loads its config and constructs its ports, then `loadConfig` accepts `real`, the lockbox port is the adapter over the row's `secret_ref`, an 8.1 furnishing tool answers the typed refusal `VENDOR_OFF{eoscar}` before any row is written (events, ledger and `integration_messages` unchanged in the contract test), and no port of vendor `FAKE` exists; given `INTEGRATIONS=fake` with `ENVIRONMENT=production`, then the process refuses to start with `NO_FAKE_IN_PRODUCTION`.", { skip }, async () => {
  const w = await world("t1", "2026-11-16T14:00:00Z");
  try {
    const db = w.db; const secretRef = "projects/supermortgage-prod/secrets/lockbox-bank-portal";
    // loadConfig accepts `real`; `fake` in production refuses to start with NO_FAKE_IN_PRODUCTION
    const cfg = loadConfig({ DATABASE_URL: "postgresql://sm:sm@localhost/x", API_TOKEN: "t", INTEGRATIONS: "real", ENVIRONMENT: "production" } as NodeJS.ProcessEnv);
    assert.equal(cfg.integrations, "real"); assert.equal(cfg.environment, "production");
    assert.throws(() => loadConfig({ DATABASE_URL: "postgresql://sm:sm@localhost/x", API_TOKEN: "t", INTEGRATIONS: "fake", ENVIRONMENT: "production" } as NodeJS.ProcessEnv), /NO_FAKE_IN_PRODUCTION/);
    assert.throws(() => loadConfig({ DATABASE_URL: "postgresql://sm:sm@localhost/x", API_TOKEN: "t", INTEGRATIONS: "sandbox", ENVIRONMENT: "nonprod" } as NodeJS.ProcessEnv), /fake \| real/);
    await assert.rejects(buildPorts({ integrations: "fake", environment: "production", db }), /NO_FAKE_IN_PRODUCTION/);
    // the switches: lockbox_bai2 = real(live) and none for eoscar
    await db.query(`INSERT INTO integration_switches (environment, vendor, mode, endpoint_class, secret_ref, egress_rule, request_id, effective_at) VALUES ('production', 'lockbox_bai2', 'real', 'live', $1, 'egress-bank-portal', $2, $3::timestamptz)`, [secretRef, randomUUID(), w.clock.now()]);
    const built = await buildPorts({ integrations: "real", environment: "production", db, secrets: new FakeSecretManager() });
    // the lockbox port is the adapter over the row's secret_ref; no port of vendor FAKE exists; eoscar is off
    assert.ok(built.ports.lockbox instanceof RealLockbox, "the lockbox port is the real adapter"); assert.equal((built.ports.lockbox as RealLockbox).secretRef, secretRef); assert.equal((built.ports.lockbox as RealLockbox).endpointClass, "live");
    const desc = describePorts(built.ports, built.modes);
    assert.ok(desc.length >= 20, `${desc.length} ports described`); assert.deepEqual(desc.filter((d) => d.adapter === "FAKE"), [], "no port of vendor FAKE");
    assert.deepEqual(desc.find((d) => d.port === "lockbox"), { port: "lockbox", vendor: "lockbox_bai2", adapter: "real", secret_ref: secretRef, endpoint_class: "live" });
    assert.equal(desc.find((d) => d.port === "eoscar")!.adapter, "off");
    assert.ok(desc.every((d) => !JSON.stringify(d).includes("FAKE-")), "the description carries no secret payload");
    // a furnishing tool that needs the e-OSCAR port answers VENDOR_OFF{eoscar} before any row is written: events, ledger and integration_messages unchanged.
    // 8.1 registers bus tools (src/app/tools/section8-1.ts) but none of them reaches the e-OSCAR port: section08.ts registers `audSubmit` (eoscar.aud.submit) under
    // 8.2/8.3 only, so the furnisher's e-OSCAR path this clause names is that AUD correction, driven under 8.3 — `validateAud` is its first call
    const prod = new Runtime({ db, registry: loadOverriddenRegistry(), clock: w.clock, logger, environment: "production", env: { INTEGRATIONS: "real", ENVIRONMENT: "production" } as NodeJS.ProcessEnv, reviewers: null, ports: built.ports });
    const f = await new PgLoanRepository(db).createFixture({ fnmaLoanNumber: `${Date.now() % 1_000_000}${Math.floor(Math.random() * 1000)}`.padStart(10, "0"), servicerLoanNumber: `SM-${randomUUID()}`, instrumentDate: "2021-07-15" as never, originalUpbCents: 26_000_000n, originalTermMonths: 360, firstPaymentDate: "2021-09-01" as never, maturityDate: "2051-08-01" as never });
    const snapshot = async (): Promise<string> => `${await count(db, "loan_events")}|${await count(db, "ledger_lines")}|${await count(db, "ledger_entry_sets")}|${await count(db, "integration_messages")}|${await moneyFingerprint(db)}`;
    const before = await snapshot();
    let refused: unknown;
    try { await prod.execute({ process: "8.3", name: "eoscar.aud.submit", loanId: f.loanId, actor: { kind: "human", id: "officer-t1", role: "officer" }, input: { aud: { audId: `aud-${R}`, bureau: "equifax", accountNumber: `acct-${R}`, fields: { date_of_first_delinquency: "20260101" }, reason: "furnisher correction" } } }); } catch (e) { refused = e; }
    assert.ok(refused instanceof VendorOff, `a typed VendorOff refusal: ${String(refused)}`); assert.equal((refused as VendorOff).code, "VENDOR_OFF"); assert.equal((refused as VendorOff).vendor, "eoscar"); assert.match((refused as VendorOff).message, /VENDOR_OFF\{eoscar\}/);
    assert.equal(await snapshot(), before, "events, ledger and integration_messages unchanged");
    assert.equal((await events(db, "eoscar.aud.submitted")).length, 0);
    // the switched vendor's adapter is the real one: a call goes to the bank portal under the secret's payload (the FAKE vault answers a deterministic payload; the fetch is the test's)
    const calls: string[] = [];
    const lb = new RealLockbox(secretRef, "live", new FakeSecretManager(), (async (url: string | URL | Request) => { calls.push(String(url)); return new Response(JSON.stringify([]), { status: 200 }); }) as typeof fetch);
    assert.deepEqual(await lb.fetch(w.clock.now()), []); assert.equal(calls.length, 1); assert.ok(calls[0]!.startsWith("https://fake-vendor.invalid/")); assert.ok(!calls[0]!.includes("FAKE-"), "the token travels in the header, never the URL");
  } finally { await w.close(); }
});

test("35.12-T2: Given a `ciso` session requests `integrations.switch{environment: production, vendor: print_mail, mode: real, endpoint_class: live, secret_ref, egress_rule}` and a `compliance` session confirms the same `request_id` 4 minutes later, then one `integration_switches` row exists with both ids and `effective_at` = the confirmation, `integration.switched{from: off, to: real}` is logged, `integrations.status` shows `print_mail: real/live`, and a request confirmed by the requester is refused `TWO_PERSON_SWITCH`; given `environment: nonprod` and `vendor: ach_nacha` with `endpoint_class: live`, then `MONEY_VENDOR_SANDBOX_ONLY` and no row.", { skip }, async () => {
  const w = MAIN; const db = w.db; const p = w.people; await p.cast();
  const t0 = clock.now(); const rows = () => db.query<{ id: string; environment: string; vendor: string; mode: string; endpoint_class: string; secret_ref: string; egress_rule: string; request_id: string; requested_by: string; confirmed_by: string; effective_at: string; decision_id: string | null }>(`SELECT id::text AS id, environment, vendor, mode, endpoint_class, secret_ref, egress_rule, request_id::text AS request_id, requested_by::text AS requested_by, confirmed_by::text AS confirmed_by, effective_at::text AS effective_at, decision_id::text AS decision_id FROM integration_switches WHERE environment = 'production' AND vendor = 'print_mail' ORDER BY created_at`);
  // the ciso session requests; no row yet — the request is an event
  const req = await p.api("POST", "/ops/api/integrations/switch", { environment: "production", vendor: "print_mail", mode: "real", endpoint_class: "live", secret_ref: "projects/supermortgage-prod/secrets/print-mail-api-key", egress_rule: "egress-print-mail", rationale: "go-live vendor" }, p.as("cid", "ciso"));
  assert.equal(req.status, 200, JSON.stringify(req.body)); assert.equal(req.body["status"], "requested"); const requestId = req.body["request_id"] as string; assert.ok(isUuidLike(requestId));
  assert.equal((await rows()).length, 0, "no row before the confirmation"); assert.equal((await events(db, "integration.switch.requested")).filter((e) => e.payload["request_id"] === requestId).length, 1);
  // a compliance session confirms the same request_id 4 minutes later: one row with both ids, effective_at = the confirmation
  clock.set(at(4 * MIN, t0));
  const ok = await p.api("POST", "/ops/api/integrations/switch", { request_id: requestId }, p.as("cara", "compliance"));
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body["status"], "switched"); assert.equal(ok.body["from"], "off"); assert.equal(ok.body["to"], "real");
  const r = await rows(); assert.equal(r.length, 1);
  assert.deepEqual({ mode: r[0]!.mode, endpoint_class: r[0]!.endpoint_class, secret_ref: r[0]!.secret_ref, egress_rule: r[0]!.egress_rule, request_id: r[0]!.request_id, requested_by: r[0]!.requested_by, confirmed_by: r[0]!.confirmed_by }, { mode: "real", endpoint_class: "live", secret_ref: "projects/supermortgage-prod/secrets/print-mail-api-key", egress_rule: "egress-print-mail", request_id: requestId, requested_by: p.ids["cid"], confirmed_by: p.ids["cara"] });
  assert.equal(Date.parse(r[0]!.effective_at), Date.parse(clock.now()), "effective_at = the confirmation"); assert.ok(r[0]!.decision_id, "the decision row on the switch row");
  const sw = (await events(db, "integration.switched")).filter((e) => e.payload["request_id"] === requestId);
  assert.equal(sw.length, 1); assert.deepEqual({ from: sw[0]!.payload["from"], to: sw[0]!.payload["to"], environment: sw[0]!.payload["environment"], vendor: sw[0]!.payload["vendor"], endpoint_class: sw[0]!.payload["endpoint_class"], by: sw[0]!.payload["by"], confirmed_by: sw[0]!.payload["confirmed_by"] }, { from: "off", to: "real", environment: "production", vendor: "print_mail", endpoint_class: "live", by: p.ids["cid"], confirmed_by: p.ids["cara"] });
  const status = await p.api("GET", "/ops/api/integrations?environment=production", undefined, p.as("cid", "ciso"));
  assert.equal(status.status, 200, JSON.stringify(status.body)); const pm = (status.body["vendors"] as Json[]).find((v) => v["vendor"] === "print_mail")!;
  assert.deepEqual({ mode: pm["mode"], endpoint_class: pm["endpoint_class"], source: pm["source"] }, { mode: "real", endpoint_class: "live", source: "switch" });
  // a request confirmed by the requester: TWO_PERSON_SWITCH
  const req2 = await p.api("POST", "/ops/api/integrations/switch", { environment: "production", vendor: "edelivery", mode: "real", endpoint_class: "live", secret_ref: "projects/supermortgage-prod/secrets/edelivery-api-key", egress_rule: "egress-edelivery" }, p.as("cid", "ciso"));
  assert.equal(req2.status, 200, JSON.stringify(req2.body));
  const self = await p.api("POST", "/ops/api/integrations/switch", { request_id: req2.body["request_id"] }, p.as("cid", "ciso"));
  assert.equal(self.status, 403, JSON.stringify(self.body)); assert.equal(self.body["code"], "TWO_PERSON_SWITCH");
  assert.equal(await count(db, "integration_switches WHERE vendor = 'edelivery'"), 0);
  // nonprod + ach_nacha + live: MONEY_VENDOR_SANDBOX_ONLY and no row
  const n0 = await count(db, "integration_switches"); const e0 = await count(db, "loan_events WHERE type = 'integration.switch.requested'");
  const money = await p.api("POST", "/ops/api/integrations/switch", { environment: "nonprod", vendor: "ach_nacha", mode: "real", endpoint_class: "live", secret_ref: "projects/supermortgage-nonprod/secrets/odfi-key", egress_rule: "egress-odfi" }, p.as("cid", "ciso"));
  assert.equal(money.status, 409, JSON.stringify(money.body)); assert.equal(money.body["code"], "MONEY_VENDOR_SANDBOX_ONLY"); assert.equal(money.body["vendor"], "ach_nacha");
  assert.equal(await count(db, "integration_switches"), n0); assert.equal(await count(db, "loan_events WHERE type = 'integration.switch.requested'"), e0, "not even a request");
  // the decision records name both people
  const dec = (await decisions(db, "integrations.switch:confirm")).filter((d) => d.subject_id === r[0]!.id); assert.equal(dec.length, 1); assert.equal(dec[0]!.approved_by, p.ids["cara"]); const rec = JSON.parse(dec[0]!.rationale) as Json; assert.equal(rec["by"], p.ids["cid"]); assert.equal(rec["confirmed_by"], p.ids["cara"]); assert.equal(rec["vendor"], "print_mail"); assert.equal(rec["prompt_version"], "35.12-v1");
});

test("35.12-T3: Given the deploy workflow's service principal posts a manifest for `staging` with image digest `sha256:abc…`, `migration_head 0137`, the terraform, secrets (names and version dates only) and runtime facts, then an `environment_manifests` row exists with an `env_hash`, a hashed `documents` row, `posture.recorded` is logged, a `posture.check` run follows within the same request, and a second identical manifest produces the same `env_hash`, a new check run and no new finding; a manifest whose `secrets` carries a value-shaped field is refused `NO_PII_IN_EVIDENCE` before any write.", { skip }, async () => {
  const w = MAIN; const db = w.db; const p = w.people; await p.cast();
  const svc = await p.servicePrincipal(`deploy-workflow-${R}`);
  const digest = `sha256:abc${R}…`;
  const manifest: Json = { ...hardened("staging", clock.now(), digest), migration_head: "0137" };
  const before = { manifests: await count(db, "environment_manifests"), docs: await count(db, "documents WHERE kind = 'environment_manifest'"), findings: await count(db, "posture_findings WHERE action = 'opened'") };
  // the deploy workflow's service principal posts the manifest on /v1/posture/manifests (the body is the input; the door resolves the principal)
  const r1 = await p.api("POST", "/v1/posture/manifests", manifest, { authorization: `Bearer ${svc.token}` });
  assert.equal(r1.status, 200, JSON.stringify(r1.body).slice(0, 600));
  const o1 = r1.body["output"] as Json; assert.ok(isUuidLike(o1["manifest_id"])); assert.equal(o1["environment"], "staging"); assert.equal(o1["image_digest"], digest); assert.equal(o1["migration_head"], "0137");
  const [row] = await db.query<{ id: string; env_hash: string; image_digest: string; migration_head: string; document_id: string; recorded_by: string | null; secrets: Json[] }>(`SELECT id::text AS id, env_hash, image_digest, migration_head, document_id::text AS document_id, recorded_by::text AS recorded_by, secrets FROM environment_manifests WHERE id = $1`, [o1["manifest_id"]]);
  assert.ok(row, "an environment_manifests row"); assert.match(row!.env_hash, /^[0-9a-f]{64}$/); assert.equal(row!.env_hash, o1["env_hash"]); assert.equal(row!.recorded_by, svc.principal_id, "recorded by the service principal");
  assert.ok(row!.secrets.every((e) => Object.keys(e).every((k) => ["name", "version_created_at", "placeholder"].includes(k))), "names and version dates only");
  const [doc] = await db.query<{ kind: string; sha256: string; byte_size: string; retention_class: string; metadata: Json }>(`SELECT kind, sha256, byte_size::text AS byte_size, retention_class::text AS retention_class, metadata FROM documents WHERE id = $1`, [row!.document_id]);
  assert.ok(doc, "a hashed documents row"); assert.equal(doc!.kind, "environment_manifest"); assert.match(doc!.sha256, /^[0-9a-f]{64}$/); assert.ok(Number(doc!.byte_size) > 100); assert.equal(doc!.retention_class, "security_logs_5y"); assert.equal(doc!.metadata["env_hash"], row!.env_hash);
  const recorded = (await events(db, "posture.recorded")).filter((e) => e.payload["manifest_id"] === row!.id);
  assert.equal(recorded.length, 1); assert.equal(recorded[0]!.payload["env_hash"], row!.env_hash); assert.equal(recorded[0]!.payload["migration_head"], "0137"); assert.equal(recorded[0]!.actor_kind, "system");
  // a posture.check run follows within the same request: check rows on this manifest, the day's receipt
  const check1 = o1["check"] as Json; assert.ok(isUuidLike(check1["run_id"])); assert.equal(check1["manifest_id"], row!.id);
  const rows1 = await checks(db, check1["run_id"] as string); assert.equal(rows1.length, 17, "one row per control"); assert.ok(rows1.every((c) => c.manifest_id === row!.id && c.environment === "staging"));
  assert.equal((await events(db, "posture.check.run_completed")).filter((e) => e.payload["run_id"] === check1["run_id"]).length, 1, "the run's receipt in the same request");
  const a1 = await p.api("POST", "/v1/posture/manifests", manifest, { authorization: `Bearer ${svc.token}` });   // a second identical manifest: the same env_hash, a new check run, no new finding
  assert.equal(a1.status, 200, JSON.stringify(a1.body).slice(0, 400));
  const o2 = a1.body["output"] as Json; assert.notEqual(o2["manifest_id"], o1["manifest_id"]); assert.equal(o2["env_hash"], o1["env_hash"], "the same facts give the same env_hash");
  const check2 = o2["check"] as Json; assert.notEqual(check2["run_id"], check1["run_id"], "a new check run"); assert.equal((await checks(db, check2["run_id"] as string)).length, 17);
  assert.deepEqual(check2["findings_opened"], [], "no new finding on the same failure"); assert.equal(await count(db, "posture_findings WHERE action = 'opened'"), before.findings + (check1["findings_opened"] as unknown[]).length);
  assert.equal(await count(db, "environment_manifests"), before.manifests + 2); assert.equal(await count(db, "documents WHERE kind = 'environment_manifest'"), before.docs + 2);
  // a value-shaped secret field: refused NO_PII_IN_EVIDENCE before any write
  const leaky = { ...manifest, secrets: [...(manifest["secrets"] as Json[]), { name: "supermortgage-api-token", version_created_at: clock.now(), placeholder: false, value: "hunter2-not-a-real-secret" }] };
  const ev0 = await count(db, "loan_events"); const doc0 = await count(db, "documents"); const chk0 = await count(db, "posture_checks");
  const refused = await p.api("POST", "/v1/posture/manifests", leaky, { authorization: `Bearer ${svc.token}` });
  assert.equal(refused.status, 409, JSON.stringify(refused.body)); assert.equal(refused.body["code"], "NO_PII_IN_EVIDENCE");
  assert.equal(await count(db, "environment_manifests"), before.manifests + 2, "no manifest row"); assert.equal(await count(db, "documents"), doc0, "no document"); assert.equal(await count(db, "loan_events"), ev0, "no event"); assert.equal(await count(db, "posture_checks"), chk0, "no check row");
  assert.equal((await db.query(`SELECT 1 FROM loan_events WHERE payload::text LIKE '%hunter2%' OR payload::text LIKE '%not-a-real-secret%'`)).length, 0, "the value reached no row");
});

test("35.12-T4: Given a `production` manifest shaped like nonprod at HEAD (`ipv4_enabled = true` per sql.tf:39, `availability_type = ZONAL` per sql.tf:18, `API_TOKEN` among the env names per server.ts:46-48, `integrations = fake` per run.tf:10, `roles/editor` on the deployer per bootstrap.sh:121, `waf_preview = true` per lb.tf:45), when `posture.check` runs, then exactly `PST-01`, `PST-02`, `PST-05`, `PST-07`, `PST-08` and `PST-10` fail among the controls those facts decide, `PST-03` and `PST-04` (SQL key, 90-day rotation) pass, six `posture_findings{opened}` rows and six `posture.drift.detected` events exist with sev 1 on `PST-01`, `PST-05`, `PST-10` and sev 2 on the others, six `SM_PROD_POSTURE_DRIFT_1BD` clocks are armed and six `ciso` escalations opened; given the same facts as a `nonprod` manifest, then only `PST-03`, `PST-04`, `PST-15` and `PST-17` are required and no finding opens.", { skip }, async () => {
  // a fresh world with no staff table and no parties, so the controls the manifest's facts do not decide (PST-06, PST-11) pass on their own facts
  const w = await world("t4", "2026-11-15T14:00:00Z");
  try {
    const db = w.db; const digest = `sha256:t4${R}`;
    // PST-13 needs the image promoted through staging first: a hardened staging manifest 25 hours earlier, whose run passes
    const staging = await tool(w, "posture.record", AGENT, hardened("staging", w.clock.now(), digest));
    const stChk = (staging.output as Json)["check"] as Json; assert.equal(stChk["failed"], 0, JSON.stringify((await checks(db, stChk["run_id"] as string)).filter((c) => c.result !== "pass" && c.result !== "not_applicable")));
    w.clock.set("2026-11-16T15:00:00Z");
    const before = await count(db, "escalations WHERE owner_role = 'ciso'");
    const r = await tool(w, "posture.record", AGENT, nonprodAtHead("production", w.clock.now(), digest));
    const run = (r.output as Json)["check"] as Json; const rows = await checks(db, run["run_id"] as string);
    const by = new Map(rows.map((c) => [c.control_code, c]));
    // exactly PST-01, 02, 05, 07, 08 and 10 fail among the controls those facts decide; PST-03 and PST-04 (SQL key, 90-day rotation) pass
    assert.deepEqual(rows.filter((c) => c.result === "fail").map((c) => c.control_code), ["PST-01", "PST-02", "PST-05", "PST-07", "PST-08", "PST-10"]);
    assert.equal(rows.filter((c) => c.result === "unverifiable").length, 0, "every production control decided by the facts");
    assert.equal(by.get("PST-03")!.result, "pass"); assert.equal(by.get("PST-04")!.result, "pass"); assert.equal(by.get("PST-04")!.observed["rotation_period_s"], 7_776_000); assert.equal(by.get("PST-04")!.observed["sql_cmek_key"], "set");
    assert.equal(by.get("PST-01")!.observed["ipv4_enabled"], true); assert.equal(by.get("PST-02")!.observed["availability_type"], "ZONAL"); assert.equal(by.get("PST-05")!.observed["api_token_in_env"], true); assert.deepEqual(by.get("PST-07")!.observed["deployer_roles"], ["roles/editor"]); assert.equal(by.get("PST-08")!.observed["waf_preview"], true); assert.equal(by.get("PST-10")!.observed["integrations"], "fake");
    assert.equal(by.get("PST-13")!.result, "pass", JSON.stringify(by.get("PST-13")!.observed));
    // six findings, six drift events with the catalogue's severities, six clocks, six ciso escalations
    const opened = await findings(db, "environment = 'production' AND action = 'opened'");
    assert.deepEqual(opened.map((f) => f.control_code).sort(), ["PST-01", "PST-02", "PST-05", "PST-07", "PST-08", "PST-10"]);
    const sev = Object.fromEntries(opened.map((f) => [f.control_code, f.severity]));
    assert.deepEqual(sev, { "PST-01": "sev1", "PST-05": "sev1", "PST-10": "sev1", "PST-02": "sev2", "PST-07": "sev2", "PST-08": "sev2" });
    assert.ok(opened.every((f) => f.check_id && rows.some((c) => c.id === f.check_id)), "each finding names its check row");
    const drift = (await events(db, "posture.drift.detected")).filter((e) => e.payload["environment"] === "production");
    assert.equal(drift.length, 6); for (const e of drift) { assert.equal(e.aggregate_kind, "posture_finding"); assert.ok(opened.some((f) => f.finding_id === e.aggregate_id && f.severity === e.payload["severity"])); assert.equal(e.loan_id, null); }
    const clocks = await timers(db, "SM_PROD_POSTURE_DRIFT_1BD");
    assert.equal(clocks.length, 6); for (const t of clocks) { assert.equal(t.status, "armed"); assert.equal(t.subject_kind, "posture_finding"); assert.ok(opened.some((f) => f.finding_id === t.subject_id)); assert.equal(t.anchor_date, "2026-11-16"); assert.equal(t.due_date, "2026-11-17", "+1 servicer business day"); }
    const esc = await escalations(db, "owner_role = 'ciso' AND payload->>'code' = 'POSTURE_DRIFT'");
    assert.equal(esc.length, before + 6); assert.deepEqual(esc.map((e) => e.kind).sort(), ["sev1", "sev1", "sev1", "sev2", "sev2", "sev2"]); assert.ok(esc.every((e) => opened.some((f) => f.finding_id === e.payload["finding_id"])));
    // the same facts as a nonprod manifest: only PST-03, PST-04, PST-15 and PST-17 are required; no finding opens
    const openedBefore = await count(db, "posture_findings WHERE action = 'opened'");
    const n = await tool(w, "posture.record", AGENT, nonprodAtHead("nonprod", w.clock.now(), digest));
    const nrun = (n.output as Json)["check"] as Json; const nrows = await checks(db, nrun["run_id"] as string);
    assert.deepEqual(nrows.filter((c) => c.result !== "not_applicable").map((c) => c.control_code), ["PST-03", "PST-04", "PST-15", "PST-17"]);
    assert.ok(nrows.filter((c) => c.result !== "not_applicable").every((c) => c.result === "pass")); assert.ok(nrows.filter((c) => c.result === "not_applicable").every((c) => c.observed["not_required_in"] === "nonprod"));
    assert.deepEqual(nrun["findings_opened"], []); assert.equal(await count(db, "posture_findings WHERE action = 'opened'"), openedBefore, "no finding opens for nonprod");
  } finally { await w.close(); }
});

test("35.12-T5: Given a production posture run completed for 2026-11-16, then `SM_PROD_POSTURE_DAILY` is armed on the global subject for 2026-11-17 05:30 America/New_York; when no run completes and the sweep passes 05:31 on the 17th, then the clock breaches sev 2 to `ciso` once; when the 17th's run completes, then it is satisfied and re-armed for the 18th; given the same day's run twice, then one clock and one receipt.", { skip }, async () => {
  // the world's runtime is nonprod: a production run is only ever the agent's or the cycle's, never this sweep's (a runtime measures its own environment)
  const w = await world("t5", "2026-11-16T12:00:00Z");
  try {
    const db = w.db; const rows = () => timers(db, "SM_PROD_POSTURE_DAILY"); const receipts = () => events(db, "posture.check.run_completed", "AND payload->>'environment' = 'production'");
    const r1 = await tool(w, "posture.record", AGENT, hardened("production", w.clock.now()));
    assert.equal(((r1.output as Json)["check"] as Json)["as_of_date"], "2026-11-16"); assert.equal(((r1.output as Json)["check"] as Json)["receipt"], "run_completed");
    // armed on the global subject for 2026-11-17 05:30 America/New_York (10:30Z)
    const t1 = await rows(); assert.equal(t1.length, 1);
    assert.equal(t1[0]!.subject_kind, "global"); assert.equal(t1[0]!.status, "armed"); assert.equal(t1[0]!.anchor_date, "2026-11-16"); assert.equal(t1[0]!.due_date, "2026-11-17"); assert.equal(Date.parse(t1[0]!.due_at!), Date.parse("2026-11-17T10:30:00Z"));
    // no run completes; the sweep passes 05:31 on the 17th: the clock breaches sev 2 to ciso once
    w.clock.set("2026-11-17T10:31:00Z");
    const rep = await w.runtime.sweep(); assert.ok(rep.breaches.some((b) => b.code === "SM_PROD_POSTURE_DAILY" && b.timer_id === t1[0]!.id), JSON.stringify(rep.breaches));
    assert.equal((await rows())[0]!.status, "breached");
    const esc = () => escalations(db, "payload->>'timer_code' = 'SM_PROD_POSTURE_DAILY'");
    assert.equal((await esc()).length, 1); assert.deepEqual({ kind: (await esc())[0]!.kind, owner_role: (await esc())[0]!.owner_role }, { kind: "sev2", owner_role: "ciso" });
    await w.runtime.sweep(); assert.equal((await esc()).length, 1, "once");
    assert.equal((await receipts()).length, 1, "no run completed for the 17th");
    // the 17th's run completes: satisfied and re-armed for the 18th
    w.clock.set("2026-11-17T10:40:00Z");
    const r2 = await tool(w, "posture.check", AGENT, { environment: "production" });
    assert.equal((r2.output as Json)["receipt"], "run_completed"); assert.equal((r2.output as Json)["as_of_date"], "2026-11-17");
    const t2 = await rows(); assert.equal(t2.length, 2);
    assert.match(t2[0]!.status, /^satisfied/, "satisfied (late: the 17th's run came after 05:30)"); assert.equal(t2[1]!.status, "armed"); assert.equal(t2[1]!.anchor_date, "2026-11-17"); assert.equal(t2[1]!.due_date, "2026-11-18"); assert.equal(Date.parse(t2[1]!.due_at!), Date.parse("2026-11-18T10:30:00Z")); assert.equal(t2[1]!.subject_kind, "global");
    // the same day's run twice: one clock and one receipt
    const r3 = await tool(w, "posture.check", AGENT, { environment: "production" });
    assert.equal((r3.output as Json)["receipt"], "run_repeated"); assert.notEqual((r3.output as Json)["run_id"], (r2.output as Json)["run_id"], "a new run all the same");
    assert.equal((await rows()).filter((t) => t.status === "armed").length, 1, "one clock"); assert.equal((await receipts()).filter((e) => e.payload["as_of_date"] === "2026-11-17").length, 1, "one receipt");
    assert.equal((await events(db, "posture.check.run_repeated")).length, 1);
  } finally { await w.close(); }
});

test("35.12-T6: Given an open `PST-02` finding, when a later production manifest reports `availability_type = REGIONAL` and its check passes, then `posture_findings{resolved, cause: manifest}` and `posture.drift.resolved` exist and the clock is satisfied; given an open `PST-08` finding and a 19.2 `control_exceptions` row approved by a `ciso` session with `expires_at` 6 months out, when `posture.drift.resolve{cause: exception}` runs, then the finding is `excepted`, the clock satisfied, and when the clock is advanced past `expires_at` with the check still failing, then a new finding opens; given `posture.drift.resolve` with no manifest and no exception, then `FINDING_CLOSES_BY_EVIDENCE` and no row.", { skip }, async () => {
  const w = await world("t6", "2026-11-16T14:00:00Z"); const p = w.people;
  try {
    const db = w.db; await p.cast(); const digest = `sha256:t6${R}`;
    // an open PST-02 finding (and PST-08's) from a nonprod-shaped production manifest
    await tool(w, "posture.record", AGENT, nonprodAtHead("production", w.clock.now(), digest));
    const open = await findings(db, "environment = 'production' AND action = 'opened'");
    const f02 = open.find((f) => f.control_code === "PST-02")!; const f08 = open.find((f) => f.control_code === "PST-08")!; assert.ok(f02 && f08);
    const clock02 = (await timers(db, "SM_PROD_POSTURE_DRIFT_1BD", "AND subject_id = $2", [f02.finding_id]))[0]!; assert.equal(clock02.status, "armed");
    // a later production manifest reports REGIONAL and its check passes: resolved{cause: manifest}, posture.drift.resolved, the clock satisfied
    w.clock.set(at(2 * HOUR, w.clock.now()));
    const m2 = nonprodAtHead("production", w.clock.now(), digest); ((m2["terraform"] as Json)["sql"] as Json)["availability_type"] = "REGIONAL";
    const r2 = await tool(w, "posture.record", AGENT, m2);
    assert.deepEqual(((r2.output as Json)["check"] as Json)["findings_resolved"], [{ finding_id: f02.finding_id, control_code: "PST-02" }]);
    const hist02 = await findings(db, "finding_id = $1", [f02.finding_id]);
    assert.deepEqual(hist02.map((f) => f.action), ["opened", "resolved"]); assert.equal(hist02[1]!.cause, "manifest"); assert.ok(hist02[1]!.resolved_at);
    const resolvedEv = (await events(db, "posture.drift.resolved")).filter((e) => e.payload["finding_id"] === f02.finding_id);
    assert.equal(resolvedEv.length, 1); assert.equal(resolvedEv[0]!.payload["cause"], "manifest"); assert.equal(resolvedEv[0]!.aggregate_id, f02.finding_id);
    assert.equal((await timers(db, "SM_PROD_POSTURE_DRIFT_1BD", "AND id = $2", [clock02.id]))[0]!.status, "satisfied");
    // an open PST-08 finding and a 19.2 control_exceptions row approved by the ciso (the Qualified Individual) with expires_at 6 months out
    const [ex] = await db.query<{ id: string }>(`INSERT INTO control_exceptions (control_code, scope, justification, compensating_controls, approved_by, approved_at, expires_at, review_due_at) VALUES ('CTL-SEC-04', 'production WAF preview', 'the WAF signatures stay in preview until the tuning window closes', 'rate limit and allow-list stay enforced', $1, $2::timestamptz, ($2::timestamptz + interval '6 months')::date, ($2::timestamptz + interval '3 months')::date) RETURNING id::text AS id`, [`human:${p.ids["cid"]}`, w.clock.now()]);
    const clock08 = (await timers(db, "SM_PROD_POSTURE_DRIFT_1BD", "AND subject_id = $2", [f08.finding_id]))[0]!; assert.equal(clock08.status, "armed");
    await p.signIn("cid");   // the clock moved past the session's idle window (34.1 rule 5)
    const rx = await p.api("POST", `/ops/api/posture/findings/${f08.finding_id}/resolve`, { cause: "exception", exception_id: ex!.id, reason: "19.2 exception approved by the Qualified Individual" }, p.as("cid", "ciso"));
    assert.equal(rx.status, 200, JSON.stringify(rx.body)); assert.equal(rx.body["action"], "excepted"); assert.equal(rx.body["exception_id"], ex!.id);
    const hist08 = await findings(db, "finding_id = $1", [f08.finding_id]);
    assert.deepEqual(hist08.map((f) => f.action), ["opened", "excepted"]); assert.equal(hist08[1]!.cause, "exception"); assert.equal(hist08[1]!.exception_id, ex!.id); assert.equal(hist08[1]!.by, p.ids["cid"]); assert.ok(hist08[1]!.decision_id, "the decision row on the finding row");
    assert.equal((await timers(db, "SM_PROD_POSTURE_DRIFT_1BD", "AND id = $2", [clock08.id]))[0]!.status, "satisfied", "the clock satisfied by posture.drift.resolved{cause: exception}");
    const dec = (await decisions(db, "posture.drift.resolve:excepted")).filter((d) => d.subject_id === f08.finding_id); assert.equal(dec.length, 1); assert.equal(dec[0]!.approved_by, p.ids["cid"]);
    // past expires_at with the check still failing: a new finding opens (the old one is expired)
    w.clock.set(at(200 * DAY, w.clock.now()));
    const m3 = nonprodAtHead("production", w.clock.now(), digest); ((m3["terraform"] as Json)["sql"] as Json)["availability_type"] = "REGIONAL";
    const r3 = await tool(w, "posture.record", AGENT, m3);
    const chk3 = (r3.output as Json)["check"] as Json;
    assert.deepEqual(chk3["findings_expired"], [{ finding_id: f08.finding_id, control_code: "PST-08" }]);
    const reopened = (chk3["findings_opened"] as Json[]).find((f) => f["control_code"] === "PST-08"); assert.ok(reopened, "a new PST-08 finding"); assert.notEqual(reopened!["finding_id"], f08.finding_id);
    assert.deepEqual((await findings(db, "finding_id = $1", [f08.finding_id])).map((f) => f.action), ["opened", "excepted", "expired"]);
    assert.equal((await timers(db, "SM_PROD_POSTURE_DRIFT_1BD", "AND subject_id = $2", [reopened!["finding_id"]])).length, 1, "a clock on the new finding");
    // posture.drift.resolve with no manifest and no exception: FINDING_CLOSES_BY_EVIDENCE and no row
    await p.signIn("cid");
    const n0 = await count(db, "posture_findings");
    const bare = await p.api("POST", `/ops/api/posture/findings/${reopened!["finding_id"]}/resolve`, { reason: "closing it by hand" }, p.as("cid", "ciso"));
    assert.equal(bare.status, 409, JSON.stringify(bare.body)); assert.equal(bare.body["code"], "FINDING_CLOSES_BY_EVIDENCE");
    const asManifest = await p.api("POST", `/ops/api/posture/findings/${reopened!["finding_id"]}/resolve`, { cause: "manifest", reason: "no later manifest passes" }, p.as("cid", "ciso"));
    assert.equal(asManifest.status, 409); assert.equal(asManifest.body["code"], "FINDING_CLOSES_BY_EVIDENCE");
    assert.equal(await count(db, "posture_findings"), n0, "no row");
  } finally { await w.close(); }
});

test("35.12-T7: Given worked example B (backup 2026-11-16T07:00:00Z, target 13:42:00Z, newest event 13:41:48Z, started 14:00:00Z, completed 15:37:20Z, every table count equal, chains contiguous, sets balanced), when `backup.drill` records it with a distinct `witnessed_by`, then `restore_drills` has `rpo_observed_s = 12`, `rto_observed_s = 5840`, `result = passed`, `backup.restore_drill.passed` and 19.2's `backup_restore_test.passed` (aggregate `control:CTL-SEC-16`) are logged, a `control_test_results` row for the mapped 19.2 control exists, `SM_PROD_RESTORE_DRILL_90D` is satisfied and re-armed for 2027-02-14, and `NYDFS_500_16D_BACKUP_RESTORE_TEST_365` is satisfied by the same event; given one table whose clone count is short by one row, then `result = failed`, `backup.restore_drill.failed`, sev 1 to `ciso`, and neither clock is satisfied; given `witnessed_by = performed_by`, then refused.", { skip }, async () => {
  const w = await world("t7", "2026-09-16T16:00:00Z"); const p = w.people;
  try {
    const db = w.db; await p.cast();
    const tables = (await db.query<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema IN ('public', 'restricted_fl') AND table_type = 'BASE TABLE' ORDER BY 1`)).map((r) => r.t);
    const rowChecks = (short?: string): Json[] => tables.map((t) => ({ table: t, source_count: 7, clone_count: t === short ? 6 : 7 }));
    const drill = (body: Json) => p.api("POST", "/ops/api/posture/drills", body, p.as("cid", "ciso"));
    const clocks = () => timers(db, "SM_PROD_RESTORE_DRILL_90D"); const nydfs = () => timers(db, "NYDFS_500_16D_BACKUP_RESTORE_TEST_365");
    // an earlier passed drill (2026-09-16) arms both recurring clocks — the quarterly one (due 2026-12-15) and 19.2's annual one on control:CTL-SEC-16
    const first = await drill({ environment: "production", source_backup_id: "backup-2026-09-16", backup_taken_at: "2026-09-16T07:00:00Z", pitr_target_at: "2026-09-16T13:00:00Z", newest_event_at: "2026-09-16T12:59:00Z", clone_instance: "supermortgage-drill-20260916", started_at: "2026-09-16T14:00:00Z", completed_at: "2026-09-16T15:00:00Z", row_checks: rowChecks(), event_chain_ok: true, ledger_balanced: true, clone_destroyed_at: "2026-09-16T16:00:00Z", witnessed_by: p.ids["cara"] });
    assert.equal(first.status, 200, JSON.stringify(first.body)); assert.equal(first.body["result"], "passed");
    const c1 = await clocks(); assert.equal(c1.length, 1); assert.equal(c1[0]!.status, "armed"); assert.equal(c1[0]!.subject_kind, "global"); assert.equal(c1[0]!.due_date, "2026-12-15");
    const n1 = await nydfs(); assert.equal(n1.length, 1); assert.equal(n1[0]!.status, "armed"); assert.equal(n1[0]!.subject_kind, "control"); assert.equal(n1[0]!.subject_id, "CTL-SEC-16");
    // worked example B on 2026-11-16: rpo 12 s, rto 5,840 s, every table equal, chains contiguous, sets balanced → passed
    w.clock.set("2026-11-16T16:10:00Z"); await p.signIn("cid");
    const ex = await drill({ environment: "production", source_backup_id: "backup-2026-11-16", backup_taken_at: "2026-11-16T07:00:00Z", pitr_target_at: "2026-11-16T13:42:00Z", newest_event_at: "2026-11-16T13:41:48Z", clone_instance: "supermortgage-drill-20261116", started_at: "2026-11-16T14:00:00Z", completed_at: "2026-11-16T15:37:20Z", row_checks: rowChecks(), event_chain_ok: true, ledger_balanced: true, clone_destroyed_at: "2026-11-16T16:02:10Z", witnessed_by: p.ids["cara"] });
    assert.equal(ex.status, 200, JSON.stringify(ex.body)); const drillId = ex.body["drill_id"] as string;
    assert.equal(ex.body["rpo_observed_s"], WORKED_B_RPO_S); assert.equal(ex.body["rto_observed_s"], WORKED_B_RTO_S); assert.equal(ex.body["result"], "passed");
    const [row] = await db.query<{ rpo_observed_s: number; rto_observed_s: number; result: string; event_chain_ok: boolean; ledger_balanced: boolean; performed_by: string; witnessed_by: string; evidence_document_id: string; clone_destroyed_at: string; decision_id: string | null }>(`SELECT rpo_observed_s, rto_observed_s, result, event_chain_ok, ledger_balanced, performed_by::text AS performed_by, witnessed_by::text AS witnessed_by, evidence_document_id::text AS evidence_document_id, clone_destroyed_at::text AS clone_destroyed_at, decision_id::text AS decision_id FROM restore_drills WHERE id = $1`, [drillId]);
    assert.deepEqual({ rpo: row!.rpo_observed_s, rto: row!.rto_observed_s, result: row!.result, chain: row!.event_chain_ok, ledger: row!.ledger_balanced, performed_by: row!.performed_by, witnessed_by: row!.witnessed_by }, { rpo: 12, rto: 5840, result: "passed", chain: true, ledger: true, performed_by: p.ids["cid"], witnessed_by: p.ids["cara"] });
    assert.ok(row!.evidence_document_id && row!.clone_destroyed_at && row!.decision_id, "evidence, the clone's destruction and the decision on the row");
    assert.equal(await count(db, "documents WHERE id = $1 AND kind = 'restore_drill_evidence' AND retention_class = 'security_logs_5y'", [row!.evidence_document_id]), 1);
    // both events; 19.2's control_test_results row for the mapped control
    const passedEv = (await events(db, "backup.restore_drill.passed")).filter((e) => e.payload["drill_id"] === drillId); assert.equal(passedEv.length, 1); assert.equal(passedEv[0]!.payload["completed_at"], "2026-11-16T15:37:20.000Z"); assert.equal(passedEv[0]!.payload["rpo_observed_s"], 12); assert.equal(passedEv[0]!.payload["rto_observed_s"], 5840);
    const nyEv = (await events(db, "backup_restore_test.passed")).filter((e) => e.payload["drill_id"] === drillId); assert.equal(nyEv.length, 1); assert.equal(nyEv[0]!.aggregate_kind, "control"); assert.equal(nyEv[0]!.aggregate_id, "CTL-SEC-16"); assert.equal(nyEv[0]!.payload["control"], "CTL-SEC-16");
    const ctr = await db.query<{ result: string; metrics: Json; evidence_document_id: string }>(`SELECT result, metrics, evidence_document_id::text AS evidence_document_id FROM control_test_results WHERE control_code = 'CTL-SEC-16' AND metrics->>'drill_id' = $1`, [drillId]);
    assert.equal(ctr.length, 1); assert.equal(ctr[0]!.result, "pass"); assert.equal(ctr[0]!.evidence_document_id, row!.evidence_document_id);
    // SM_PROD_RESTORE_DRILL_90D satisfied and re-armed for 2027-02-14; NYDFS_500_16D_BACKUP_RESTORE_TEST_365 satisfied by the same event
    const c2 = await clocks(); assert.equal(c2.length, 2); assert.match(c2[0]!.status, /^satisfied/); assert.equal(c2[1]!.status, "armed"); assert.equal(c2[1]!.anchor_date, "2026-11-16"); assert.equal(c2[1]!.due_date, "2027-02-14"); assert.equal(c2[1]!.subject_kind, "global");
    // 19.2's recurring clock (its trigger is its satisfied event, on the control aggregate): the first instance is satisfied by the same event and the engine re-arms for the next test
    const n2 = await nydfs(); assert.equal(n2.filter((t) => /^satisfied/.test(t.status)).length, 1, "NYDFS_500_16D_BACKUP_RESTORE_TEST_365 satisfied by the same event"); assert.equal(n2.find((t) => t.id === n1[0]!.id)!.status.startsWith("satisfied"), true); assert.ok(n2.some((t) => t.status === "armed"), "re-armed for the next test");
    const armedQuarterly = (await clocks()).filter((t) => t.status === "armed").length; const armedAnnual = n2.filter((t) => t.status === "armed").length; const satisfiedAnnual = 1;
    // one table short by one row: failed, the failed event, sev 1 to the ciso, neither clock satisfied
    const bad = await drill({ environment: "production", pitr_target_at: "2026-11-16T17:00:00Z", newest_event_at: "2026-11-16T16:59:50Z", started_at: "2026-11-16T17:10:00Z", completed_at: "2026-11-16T18:00:00Z", row_checks: rowChecks("loan_events"), event_chain_ok: true, ledger_balanced: true, witnessed_by: p.ids["cara"] });
    assert.equal(bad.status, 200, JSON.stringify(bad.body)); assert.equal(bad.body["result"], "failed"); assert.deepEqual(bad.body["tables_short"], ["loan_events"]); assert.match(String(bad.body["failure_reason"]), /row_counts_differ:loan_events/);
    const failedEv = (await events(db, "backup.restore_drill.failed")).filter((e) => e.payload["drill_id"] === bad.body["drill_id"]); assert.equal(failedEv.length, 1); assert.match(String(failedEv[0]!.payload["reason"]), /loan_events/);
    const esc = await escalations(db, "payload->>'code' = 'RESTORE_DRILL_FAILED'"); assert.equal(esc.length, 1); assert.deepEqual({ kind: esc[0]!.kind, owner_role: esc[0]!.owner_role }, { kind: "sev1", owner_role: "ciso" });
    assert.equal((await clocks()).filter((t) => t.status === "armed").length, armedQuarterly, "the quarterly clock still armed (not satisfied by a failed drill)"); assert.equal((await clocks()).length, 2, "no new quarterly instance");
    assert.equal((await nydfs()).filter((t) => t.status === "armed").length, armedAnnual, "19.2's clock untouched by a failed drill"); assert.equal((await nydfs()).filter((t) => /^satisfied/.test(t.status)).length, satisfiedAnnual);
    assert.equal((await db.query(`SELECT 1 FROM control_test_results WHERE control_code = 'CTL-SEC-16' AND metrics->>'drill_id' = $1 AND result = 'fail'`, [bad.body["drill_id"]])).length, 1);
    // witnessed_by = performed_by: refused, no row
    const n0 = await count(db, "restore_drills");
    const self = await drill({ environment: "production", pitr_target_at: "2026-11-16T17:00:00Z", newest_event_at: "2026-11-16T16:59:50Z", started_at: "2026-11-16T17:10:00Z", completed_at: "2026-11-16T18:00:00Z", row_checks: rowChecks(), event_chain_ok: true, ledger_balanced: true, witnessed_by: p.ids["cid"] });
    assert.equal(self.status, 409, JSON.stringify(self.body)); assert.equal(self.body["code"], "WITNESS_DISTINCT"); assert.equal(await count(db, "restore_drills"), n0);
  } finally { await w.close(); }
});

test("35.12-T8: Given a nonprod database seeded by `seed-demo` (every `parties` and `transfer_batches` row `synthetic = true`) plus one `parties` row inserted with `synthetic = false`, when the daily `data.scan{kind: nonprod_real_data}` runs, then `data_scans.findings = [{table: parties, column: synthetic, rule: synthetic_marker, count: 1}]` and nothing else (no id, no name), `real_data_found = true`, `synthetic_coverage_pct` is the fixture's rows over rows + 1 to three decimals, `posture.real_data.detected` is logged, sev 1 to `compliance`, `SM_NONPROD_REAL_DATA_PURGE_1BD` is armed; when the database is rebuilt, a new manifest recorded and a clean scan carrying the `scan_id` runs, then `posture.real_data.purged` satisfies the clock and the finding is closed.", { skip }, async () => {
  const w = await world("t8", "2026-11-16T14:00:00Z");
  try {
    const db = w.db;
    // seed-demo: the demo transfer batch, the 32.14 entry demo and the 33.1 partner book — the three seed writers main.ts runs, every row synthetic
    const demo = generateDemoBatch();
    await boardTransferBatch(w.runtime, { ...DEMO_BATCH }, encodeTransferBatch(demo, demo.coborrowers), { kind: "system", id: "seed-demo" }, { synthetic: true });
    const entry = await seedEntryDemo(w.runtime, {}); await seedPartnerBookDemo(w.runtime, { partner_id: entry.partner_id });
    const parties = await count(db, "parties"); const batches = await count(db, "transfer_batches");
    assert.ok(parties > 3 && batches >= 1, `${parties} parties, ${batches} batches seeded`);
    assert.equal(await count(db, "parties WHERE synthetic = false"), 0, "every seeded parties row is synthetic"); assert.equal(await count(db, "transfer_batches WHERE synthetic = false"), 0, "every seeded transfer_batches row is synthetic");
    // plus one parties row inserted with synthetic = false (a real person slipped in outside the doors)
    const [real] = await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, contact, synthetic) VALUES ('borrower', 'Real Person', '{"email": "real.person@example.test"}'::jsonb, false) RETURNING id::text AS id`);
    w.clock.set("2026-11-16T10:46:00Z");
    const r = await tool(w, "data.scan", AGENT, { environment: "nonprod", kind: "nonprod_real_data" }); const o = r.output as Json; const scanId = o["scan_id"] as string;
    assert.deepEqual(o["findings"], [{ table: "parties", column: "synthetic", rule: "synthetic_marker", count: 1 }]); assert.equal(o["real_data_found"], true);
    const expectedPct = (Math.round(((parties + batches) / (parties + batches + 1)) * 100_000) / 1000).toFixed(3);
    assert.equal(o["synthetic_coverage_pct"], expectedPct, "the fixture's rows over rows + 1, three decimals");
    const [row] = await db.query<{ findings: Json[]; real_data_found: boolean; synthetic_coverage_pct: string; tables_scanned: number; rows_examined: string; evidence_document_id: string }>(`SELECT findings, real_data_found, synthetic_coverage_pct::text AS synthetic_coverage_pct, tables_scanned, rows_examined::text AS rows_examined, evidence_document_id::text AS evidence_document_id FROM data_scans WHERE id = $1`, [scanId]);
    assert.deepEqual(row!.findings, [{ table: "parties", column: "synthetic", rule: "synthetic_marker", count: 1 }]); assert.equal(row!.real_data_found, true); assert.equal(row!.synthetic_coverage_pct, expectedPct); assert.equal(row!.tables_scanned, 5); assert.ok(Number(row!.rows_examined) >= parties + batches + 1);
    assert.ok(!JSON.stringify(row!.findings).includes(real!.id) && !JSON.stringify(row!.findings).includes("Real Person"), "counts only: no id, no name"); noPii(row, "the data_scans row");
    const det = (await events(db, "posture.real_data.detected")).filter((e) => e.payload["scan_id"] === scanId); assert.equal(det.length, 1); assert.equal(det[0]!.aggregate_kind, "data_scan"); assert.equal(det[0]!.aggregate_id, scanId); noPii(det[0]!.payload, "the detected event");
    const esc = await escalations(db, "payload->>'code' = 'REAL_DATA_IN_NONPROD'"); assert.equal(esc.length, 1); assert.deepEqual({ kind: esc[0]!.kind, owner_role: esc[0]!.owner_role, completed: esc[0]!.completed_at }, { kind: "sev1", owner_role: "compliance", completed: null }); noPii(esc[0], "the escalation");
    const purge = await timers(db, "SM_NONPROD_REAL_DATA_PURGE_1BD", "AND subject_id = $2", [scanId]); assert.equal(purge.length, 1); assert.equal(purge[0]!.status, "armed"); assert.equal(purge[0]!.subject_kind, "data_scan"); assert.equal(purge[0]!.anchor_date, "2026-11-16"); assert.equal(purge[0]!.due_date, "2026-11-17", "+1 servicer business day");
    // the remedy is the environment: rebuilt from db/migrations and re-seeded (here: the offending row is gone, the seed stands), the new manifest recorded, a clean scan carrying the scan_id
    await db.query(`DELETE FROM parties WHERE id = $1`, [real!.id]);
    w.clock.set("2026-11-16T15:00:00Z");
    const m = await tool(w, "posture.record", AGENT, hardened("nonprod", w.clock.now())); const manifestId = (m.output as Json)["manifest_id"] as string;
    const clean = await tool(w, "data.scan", AGENT, { environment: "nonprod", kind: "nonprod_real_data", scan_id: scanId, rebuilt_manifest_id: manifestId }); const co = clean.output as Json;
    assert.deepEqual(co["findings"], []); assert.equal(co["real_data_found"], false); assert.equal(co["purged_scan_id"], scanId);
    const purged = (await events(db, "posture.real_data.purged")).filter((e) => e.payload["scan_id"] === scanId); assert.equal(purged.length, 1); assert.equal(purged[0]!.payload["rebuilt_manifest_id"], manifestId); assert.equal(purged[0]!.aggregate_id, scanId);
    assert.match((await timers(db, "SM_NONPROD_REAL_DATA_PURGE_1BD", "AND subject_id = $2", [scanId]))[0]!.status, /^satisfied/, "the purge clock satisfied");
    const closed = await escalations(db, "payload->>'code' = 'REAL_DATA_IN_NONPROD'"); assert.equal(closed.length, 1); assert.ok(closed[0]!.completed_at, "the finding is closed (the compliance escalation completed)");
  } finally { await w.close(); }
});

test("35.12-T9: Given `ENVIRONMENT=nonprod`, when `POST /v1/transfers/batches` is called with a tape lacking `X-Supermortgage-Synthetic: true`, then 409 `REAL_DATA_REFUSED_IN_NONPROD` and no row of any table is written; with the header, then the batch boards and every `parties` and `transfer_batches` row it wrote has `synthetic = true`; given `ENVIRONMENT=production` and the header, then 409 `SYNTHETIC_REFUSED_IN_PRODUCTION`; given production and a `parties` row with `synthetic = true`, when the `production_synthetic` scan runs, then `PST-11` fails and a sev 1 finding opens.", { skip }, async () => {
  const w = await world("t9", "2026-11-16T14:00:00Z"); const p = w.people;
  try {
    const db = w.db;
    const demo = generateDemoBatch(7, { }); const files = encodeTransferBatch(demo, demo.coborrowers);
    const body = { actor: { kind: "system", id: "transfer-tape" }, batch: { ...DEMO_BATCH, batch_id: `T9-${R}`, transfer_date: String(DEMO_BATCH.transfer_date) }, files };
    // every base table's row count except staff_actions — the /v1 door logs one row per request (35.7 rule 2's action log), which is the door's, not the tape's
    const tables = (await db.query<{ t: string }>(`SELECT table_schema || '.' || table_name AS t FROM information_schema.tables WHERE table_schema IN ('public', 'restricted_fl') AND table_type = 'BASE TABLE' AND table_name <> 'staff_actions' ORDER BY 1`)).map((r) => r.t);
    const snapshot = async (): Promise<string> => { const parts: string[] = []; for (const t of tables) parts.push(`${t}=${(await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${t.split(".").map((x) => `"${x}"`).join(".")}`))[0]!.n}`); return sha256hex(parts.join("\n")); };
    const before = await snapshot();
    // nonprod, no header: 409 REAL_DATA_REFUSED_IN_NONPROD and no row of any table
    const refused = await p.api("POST", "/v1/transfers/batches", body, { authorization: `Bearer ${TOKEN}` });
    assert.equal(refused.status, 409, JSON.stringify(refused.body)); assert.equal(refused.body["code"], "REAL_DATA_REFUSED_IN_NONPROD");
    assert.equal(await snapshot(), before, "no row of any table was written");
    // with the header: the batch boards and every parties and transfer_batches row it wrote has synthetic = true
    const ok = await p.api("POST", "/v1/transfers/batches", body, { authorization: `Bearer ${TOKEN}`, "x-supermortgage-synthetic": "true" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body).slice(0, 400)); assert.ok(((ok.body["loans"] as Json)["boarded"] as number) > 0, "the batch boards");
    assert.ok((await count(db, "transfer_batches")) >= 1); assert.equal(await count(db, "transfer_batches WHERE synthetic = false"), 0); assert.ok((await count(db, "parties")) >= 2); assert.equal(await count(db, "parties WHERE synthetic = false"), 0);
    // production and the header: 409 SYNTHETIC_REFUSED_IN_PRODUCTION (a production runtime over the same database; the door admits a service principal, never the shared token)
    await p.invite("ada", []); const svc = await p.servicePrincipal(`tape-${R}`, ["transfers", "35."]);
    const prod = new Runtime({ db, registry: loadOverriddenRegistry(), clock: w.clock, logger, environment: "production", env: { INTEGRATIONS: "real", ENVIRONMENT: "production" } as NodeJS.ProcessEnv, reviewers: null });
    const prodServer = createApiServer({ runtime: prod, apiToken: TOKEN, logger, borrower: { environment: "production", rpId: "localhost", allowedOrigins: ["http://localhost"], urlSecret: "test-secret" } });
    const prodBase = `http://127.0.0.1:${await listen(prodServer, 0, "127.0.0.1")}`;
    try {
      const r = await fetch(prodBase + "/v1/transfers/batches", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${svc.token}`, "x-supermortgage-synthetic": "true" }, body: JSON.stringify({ ...body, batch: { ...body.batch, batch_id: `T9P-${R}` } }) });
      const rb = (await r.json()) as Json; assert.equal(r.status, 409, JSON.stringify(rb)); assert.equal(rb["code"], "SYNTHETIC_REFUSED_IN_PRODUCTION");
      // production and a parties row with synthetic = true: the production_synthetic scan fails PST-11 and a sev 1 finding opens
      const scan = await prod.execute({ process: "35.12", name: "data.scan", loanId: "", actor: AGENT, input: { environment: "production", kind: "production_synthetic" } }); const so = scan.output as Json;
      assert.equal(so["kind"], "production_synthetic"); assert.equal((so["findings"] as Json[])[0]!["rule"], "synthetic_marker_in_production"); assert.ok(((so["findings"] as Json[])[0]!["count"] as number) >= 2);
      const opened = so["finding_opened"] as Json; assert.equal(opened["control_code"], "PST-11");
      const f = await findings(db, "finding_id = $1", [opened["finding_id"]]); assert.equal(f.length, 1); assert.deepEqual({ action: f[0]!.action, severity: f[0]!.severity, control: f[0]!.control_code, environment: f[0]!.environment }, { action: "opened", severity: "sev1", control: "PST-11", environment: "production" });
      const chk = await db.query<{ result: string; observed: Json; manifest_id: string | null }>(`SELECT result, observed, manifest_id::text AS manifest_id FROM posture_checks WHERE id = $1`, [f[0]!.check_id]); assert.equal(chk[0]!.result, "fail"); assert.equal(chk[0]!.observed["source"], "data.scan");
      const esc = await escalations(db, "payload->>'code' = 'POSTURE_DRIFT' AND payload->>'control_code' = 'PST-11'"); assert.equal(esc.length, 1); assert.equal(esc[0]!.kind, "sev1"); assert.equal(esc[0]!.owner_role, "ciso");
      assert.equal((await timers(db, "SM_PROD_POSTURE_DRIFT_1BD", "AND subject_id = $2", [opened["finding_id"]])).length, 1);
    } finally { await new Promise<void>((resolve) => { prodServer.closeAllConnections?.(); prodServer.close(() => resolve()); }); }
  } finally { await w.close(); }
});

test("35.12-T10: Given an `officer` opens the parallel run for production with `incumbent_servicer = \"Incumbent\"` on `opened_on = 2026-11-02` over the three fixture loans, then `parallel_runs{opened}` has `planned_end_on = 2026-11-30` and `loan_count = 3`, `parallel_run.opened` is logged, `SM_PROD_GO_LIVE_ATTEST_GATE` is armed for 2026-11-30, and `go_live.attest` on 2026-11-29 is refused `GO_LIVE_GATE{not_before: 2026-11-30}`; given an `ops_analyst` opening a run, then `ROLE_REQUIRED{officer}`.", { skip }, async () => {
  const w = await runWorld("t10", "2026-11-02T15:00:00Z"); const p = w.people; const db = w.db;
  try {
    // an ops_analyst opening a run: ROLE_REQUIRED{officer} before any write
    const denied = await p.api("POST", "/ops/api/parallel-run/open", { environment: "production", incumbent_servicer: "Incumbent", loan_ids: w.loanIds, opened_on: "2026-11-02" }, p.as("ana", "ops_analyst"));
    assert.equal(denied.status, 403, JSON.stringify(denied.body)); assert.equal(denied.body["code"], "ROLE_REQUIRED"); assert.equal(denied.body["role"], "officer"); assert.equal(await count(db, "parallel_runs"), 0);
    // the officer opens the run over the three fixture loans
    const runId = await openRun(w, w.loanIds, "2026-11-02");
    const [row] = await db.query<{ action: string; incumbent_servicer: string; opened_on: string; planned_end_on: string; loan_count: number; loan_ids: string[]; by: string; decision_id: string | null; environment: string }>(`SELECT action, incumbent_servicer, opened_on::text AS opened_on, planned_end_on::text AS planned_end_on, loan_count, loan_ids::text[] AS loan_ids, by::text AS by, decision_id::text AS decision_id, environment FROM parallel_runs WHERE parallel_run_id = $1`, [runId]);
    assert.deepEqual({ action: row!.action, incumbent: row!.incumbent_servicer, opened_on: row!.opened_on, planned_end_on: row!.planned_end_on, loan_count: row!.loan_count, by: row!.by, environment: row!.environment }, { action: "opened", incumbent: "Incumbent", opened_on: "2026-11-02", planned_end_on: "2026-11-30", loan_count: 3, by: p.ids["osc"], environment: "production" });
    assert.deepEqual([...row!.loan_ids].sort(), [...w.loanIds].sort()); assert.ok(row!.decision_id);
    const opened = (await events(db, "parallel_run.opened")).filter((e) => e.payload["parallel_run_id"] === runId);
    assert.equal(opened.length, 1); assert.deepEqual({ environment: opened[0]!.payload["environment"], incumbent_servicer: opened[0]!.payload["incumbent_servicer"], opened_on: opened[0]!.payload["opened_on"], planned_end_on: opened[0]!.payload["planned_end_on"], loan_count: opened[0]!.payload["loan_count"] }, { environment: "production", incumbent_servicer: "Incumbent", opened_on: "2026-11-02", planned_end_on: "2026-11-30", loan_count: 3 });
    // SM_PROD_GO_LIVE_ATTEST_GATE armed on the global subject for 2026-11-30: the evaluator-backed gate (anchor opened_on; not_before = opened_on + 28 calendar days)
    const gate = await timers(db, "SM_PROD_GO_LIVE_ATTEST_GATE"); assert.equal(gate.length, 1); assert.equal(gate[0]!.status, "armed"); assert.equal(gate[0]!.subject_kind, "global"); assert.equal(gate[0]!.anchor_date, "2026-11-02"); assert.match(gate[0]!.note ?? "", /evaluator:35\.12\.goLiveGate/);
    assert.equal(goLiveNotBefore("2026-11-02"), "2026-11-30");
    assert.equal(evaluateGate("35.12.goLiveGate", { opened_on: "2026-11-02", as_of_date: "2026-11-29" }).open, false); assert.equal(evaluateGate("35.12.goLiveGate", { opened_on: "2026-11-02", as_of_date: "2026-11-30" }).open, true);
    assert.equal(loadOverriddenRegistry().get("SM_PROD_GO_LIVE_ATTEST_GATE")!.subjectOverride, "global");
    // go_live.attest on 2026-11-29: GO_LIVE_GATE{not_before: 2026-11-30}
    w.clock.set("2026-11-29T15:00:00Z"); await p.signIn("cid");
    const early = await p.api("POST", "/ops/api/go-live/attest", { environment: "production" }, p.as("cid", "ciso"));
    assert.equal(early.status, 409, JSON.stringify(early.body)); assert.equal(early.body["code"], "GO_LIVE_GATE"); assert.equal(early.body["not_before"], "2026-11-30"); assert.equal(early.body["as_of_date"], "2026-11-29");
    assert.equal(await count(db, "go_live_checklists"), 0); assert.equal((await events(db, "go_live.attest.requested")).length, 0);
  } finally { await w.close(); }
});

test("35.12-T11: Given worked example A's incumbent file for 2026-11-17 (loan 1 all fields equal with UPB **$248,310.55**; loan 2 late charges 0.00 against our 5.000% × **$1,250.00** = **$62.50**; loan 3 escrow **$3,412.92** against our **$3,417.92**), when `parallel_run.reconcile` runs, then the day row has `comparisons = 24`, `matched = 22`, `mismatched = 2`, `mismatch_cents = 6750n` (**$67.50**), two `parallel_run_diffs{opened}` rows exist (`late_charges_accrued_cents` delta `6250n`; `escrow_balance_cents` delta `500n` = **$5.00**), `parallel_run.day.reconciled` carries the same figures, the daily report document is hashed, and the loans' ledger and money columns are byte-identical before and after.", { skip }, async () => {
  const w = await runWorld("t11", "2026-11-17T22:00:00Z"); const db = w.db; const [l1, l2, l3] = w.loanIds as [string, string, string];
  try {
    // the figures of worked example A, asserted to the cent against the section's constants
    assert.equal(WORKED_A_UPB_CENTS, 24_831_055n); assert.equal(WORKED_A_PI_CENTS, 125_000n); assert.equal(WORKED_A_LATE_CHARGE_CENTS, 6_250n); assert.equal((WORKED_A_PI_CENTS * WORKED_A_LATE_CHARGE_BPS) / 10_000n, 6_250n, "5.000% × $1,250.00 = $62.50");
    assert.equal(WORKED_A_ESCROW_OURS_CENTS, 341_792n); assert.equal(WORKED_A_ESCROW_THEIRS_CENTS, 341_292n); assert.equal(WORKED_A_ESCROW_OURS_CENTS - WORKED_A_ESCROW_THEIRS_CENTS, 500n); assert.equal(WORKED_A_ESCROW_DELTA_CENTS, 500n); assert.equal(WORKED_A_MISMATCH_CENTS, 6_750n); assert.equal(WORKED_A_LATE_CHARGE_CENTS + WORKED_A_ESCROW_DELTA_CENTS, WORKED_A_MISMATCH_CENTS);
    assert.equal(WORKED_A_COMPARISONS, 3 * RECONCILE_FIELDS.length); assert.equal(WORKED_A_MATCHED, 22); assert.equal(WORKED_A_MISMATCHED, 2);
    const runId = await openRun(w, w.loanIds, "2026-11-02");
    // the incumbent's file for 2026-11-17: loan 1 equal (UPB $248,310.55), loan 2 late charges 0.00 against our $62.50, loan 3 escrow $3,412.92 against our $3,417.92
    const csv = incumbentCsv(w.loanIds, w.figures, { 1: { late_charges_accrued_cents: 0n }, 2: { escrow_balance_cents: WORKED_A_ESCROW_THEIRS_CENTS } });
    assert.match(csv, /248310\.55/); assert.match(csv, /3412\.92/); assert.equal(parseIncumbentFile(csv).length, 3); assert.equal(parseIncumbentFile(csv)[0]!.upb_cents, 24_831_055n); assert.equal(parseIncumbentFile(csv)[2]!.escrow_balance_cents, 341_292n);
    const money0 = await moneyAndNotices(db);
    const r = await reconcile(w, runId, "2026-11-17", csv, "officer"); assert.equal(r.status, 200, JSON.stringify(r.body));
    const o = r.body; assert.deepEqual({ comparisons: o["comparisons"], matched: o["matched"], mismatched: o["mismatched"], mismatch_cents: o["mismatch_cents"], loans: o["loans"] }, { comparisons: 24, matched: 22, mismatched: 2, mismatch_cents: "6750", loans: 3 });
    const [day] = await db.query<{ comparisons: number; matched: number; mismatched: number; mismatch_cents: string; report_document_id: string; incumbent_file_document_id: string; as_of_date: string }>(`SELECT comparisons, matched, mismatched, mismatch_cents::text AS mismatch_cents, report_document_id::text AS report_document_id, incumbent_file_document_id::text AS incumbent_file_document_id, as_of_date::text AS as_of_date FROM parallel_runs WHERE parallel_run_id = $1 AND action = 'day_reconciled'`, [runId]);
    assert.deepEqual({ comparisons: day!.comparisons, matched: day!.matched, mismatched: day!.mismatched, as_of: day!.as_of_date }, { comparisons: 24, matched: 22, mismatched: 2, as_of: "2026-11-17" }); assert.equal(BigInt(day!.mismatch_cents), 6750n);
    // two diffs: late_charges_accrued_cents delta 6250n on loan 2; escrow_balance_cents delta 500n on loan 3
    const diffs = await db.query<{ loan_id: string; field: string; ours: string; theirs: string; delta_cents: string; action: string }>(`SELECT loan_id::text AS loan_id, field, ours, theirs, delta_cents::text AS delta_cents, action FROM parallel_run_diffs WHERE parallel_run_id = $1 ORDER BY field`, [runId]);
    assert.equal(diffs.length, 2); assert.ok(diffs.every((d) => d.action === "opened"));
    const esc = diffs.find((d) => d.field === "escrow_balance_cents")!; const lc = diffs.find((d) => d.field === "late_charges_accrued_cents")!;
    assert.deepEqual({ loan: lc.loan_id, ours: lc.ours, theirs: lc.theirs }, { loan: l2, ours: "6250", theirs: "0" }); assert.equal(BigInt(lc.delta_cents), 6250n);
    assert.deepEqual({ loan: esc.loan_id, ours: esc.ours, theirs: esc.theirs }, { loan: l3, ours: "341792", theirs: "341292" }); assert.equal(BigInt(esc.delta_cents), 500n);
    assert.equal(diffs.some((d) => d.loan_id === l1), false, "loan 1 matched on every field");
    // the event carries the same figures; the daily report and the incumbent file are hashed documents
    const ev = (await events(db, "parallel_run.day.reconciled")).filter((e) => e.payload["parallel_run_id"] === runId);
    assert.equal(ev.length, 1); assert.deepEqual({ as_of_date: ev[0]!.payload["as_of_date"], loans: ev[0]!.payload["loans"], comparisons: ev[0]!.payload["comparisons"], matched: ev[0]!.payload["matched"], mismatched: ev[0]!.payload["mismatched"], mismatch_cents: ev[0]!.payload["mismatch_cents"], report_document_id: ev[0]!.payload["report_document_id"] }, { as_of_date: "2026-11-17", loans: 3, comparisons: 24, matched: 22, mismatched: 2, mismatch_cents: "6750", report_document_id: day!.report_document_id });
    const docs = await db.query<{ id: string; kind: string; sha256: string; retention_class: string; metadata: Json }>(`SELECT id::text AS id, kind, sha256, retention_class::text AS retention_class, metadata FROM documents WHERE id IN ($1, $2) ORDER BY kind`, [day!.report_document_id, day!.incumbent_file_document_id]);
    assert.deepEqual(docs.map((d) => d.kind), ["incumbent_trial_balance", "parallel_run_daily_report"]); assert.ok(docs.every((d) => /^[0-9a-f]{64}$/.test(d.sha256) && d.retention_class === "corporate_7y"));
    assert.equal(docs[1]!.metadata["mismatch_cents"], "6750"); assert.equal(docs[1]!.metadata["comparisons"], 24);
    // the loans' ledger and money columns are byte-identical before and after
    assert.equal(await moneyAndNotices(db), money0, "no ledger line, no money column, no notice moved");
    // ours came from the typed-row port for each loan (the section constants), never from the file
    assert.equal(w.figures.get(l2)!.late_charges_accrued_cents, WORKED_A_LATE_CHARGE_CENTS); assert.equal(w.figures.get(l3)!.escrow_balance_cents, WORKED_A_ESCROW_OURS_CENTS); assert.equal(w.figures.get(l1)!.upb_cents, WORKED_A_UPB_CENTS);
  } finally { await w.close(); }
});

test("35.12-T12: Given the run reconciled 2026-11-16, then `SM_PROD_PARALLEL_RUN_DAILY` is armed on the global subject for 2026-11-17 21:00 America/New_York; when the sweep passes 21:01 on the 17th with no reconciliation, then sev 2 to `officer`, and the run's clean-week count reads 0 from that day; when the 17th's file arrives at 22:30 and is reconciled, then the clock is satisfied for the 17th and re-armed for the 18th, and a second file for the 17th is refused `DAY_ALREADY_RECONCILED`.", { skip }, async () => {
  const w = await runWorld("t12", "2026-11-16T22:00:00Z"); const db = w.db;
  try {
    const runId = await openRun(w, w.loanIds, "2026-11-02");
    const clean = incumbentCsv(w.loanIds, w.figures); const rows = () => timers(db, "SM_PROD_PARALLEL_RUN_DAILY");
    // the run reconciled 2026-11-16: armed on the global subject for 2026-11-17 21:00 America/New_York (02:00Z on the 18th)
    const r16 = await reconcile(w, runId, "2026-11-16", clean); assert.equal(r16.body["mismatched"], 0);
    const t1 = await rows(); assert.equal(t1.length, 1); assert.equal(t1[0]!.status, "armed"); assert.equal(t1[0]!.subject_kind, "global"); assert.equal(t1[0]!.anchor_date, "2026-11-16"); assert.equal(t1[0]!.due_date, "2026-11-17"); assert.equal(Date.parse(t1[0]!.due_at!), Date.parse("2026-11-18T02:00:00Z"), "21:00 ET on the 17th");
    // the sweep passes 21:01 on the 17th with no reconciliation (no file arrived): sev 2 to officer; the clean-week count reads 0 from that day
    w.clock.set("2026-11-18T02:01:00Z");
    const rep = await w.runtime.sweep(); assert.ok(rep.breaches.some((b) => b.code === "SM_PROD_PARALLEL_RUN_DAILY" && b.timer_id === t1[0]!.id), JSON.stringify(rep.breaches)); assert.equal(rep.posture?.reconciled.length, 0, "nothing to reconcile without the day's file");
    const esc = await escalations(db, "payload->>'timer_code' = 'SM_PROD_PARALLEL_RUN_DAILY'"); assert.equal(esc.length, 1); assert.deepEqual({ kind: esc[0]!.kind, owner_role: esc[0]!.owner_role }, { kind: "sev2", owner_role: "officer" });
    const board0 = await parallelRunBoard(db, runId, w.clock.now()); assert.equal(board0["as_of"], "2026-11-17"); assert.equal(board0["days_clean"], 0, "the clean-week count reads 0 from the missed day"); assert.equal(board0["days_reconciled"], 1);
    // the 17th's file arrives at 22:30 and is reconciled: satisfied for the 17th and re-armed for the 18th
    w.clock.set("2026-11-18T03:30:00Z"); await w.people.signIn("osc");
    const r17 = await reconcile(w, runId, "2026-11-17", clean); assert.equal(r17.body["as_of_date"], "2026-11-17");
    const t2 = await rows(); assert.equal(t2.length, 2); assert.match(t2[0]!.status, /^satisfied/); assert.equal(t2[1]!.status, "armed"); assert.equal(t2[1]!.anchor_date, "2026-11-17"); assert.equal(t2[1]!.due_date, "2026-11-18"); assert.equal(Date.parse(t2[1]!.due_at!), Date.parse("2026-11-19T02:00:00Z"));
    const board1 = await parallelRunBoard(db, runId, w.clock.now()); assert.equal(board1["days_clean"], 2, "a late day counts once it is reconciled (edge cases)");
    // a second file for the 17th: DAY_ALREADY_RECONCILED
    const again = await w.people.api("POST", `/ops/api/parallel-run/${runId}/reconcile`, { as_of_date: "2026-11-17", incumbent_file_csv: clean }, w.people.as("osc", "officer"));
    assert.equal(again.status, 409, JSON.stringify(again.body)); assert.equal(again.body["code"], "DAY_ALREADY_RECONCILED"); assert.equal(await count(db, "parallel_runs WHERE parallel_run_id = $1 AND action = 'day_reconciled'", [runId]), 2);
    // the sweep reconciles a day itself when the day's file arrived as a document (the 21:00 ET cycle): a production run is that runtime's; here the runtime is nonprod, so the sweep finds nothing (a runtime reads its own environment)
    assert.equal((await w.runtime.sweep()).posture?.reconciled.length, 0);
  } finally { await w.close(); }
});

test("35.12-T13: Given the two open diffs of T11, when an `ops_analyst` dispositions one, then `ROLE_REQUIRED{officer}`; when an `officer` dispositions loan 2 `timing` and loan 3 `theirs_right` with reasons, then two `parallel_run_diffs{dispositioned}` rows, two `parallel_run.diff.dispositioned` events and two decision records with the reasons exist; when the agent proposes `ours_right` for loan 3 with confidence 0.62, then the decision record holds the proposal and no diff row changes; and no ledger line, `fees` row or `loans` column changed in any of these calls.", { skip }, async () => {
  const w = await runWorld("t13", "2026-11-17T22:00:00Z"); const db = w.db; const p = w.people; const [, l2, l3] = w.loanIds as [string, string, string];
  try {
    const runId = await openRun(w, w.loanIds, "2026-11-02");
    await reconcile(w, runId, "2026-11-17", incumbentCsv(w.loanIds, w.figures, { 1: { late_charges_accrued_cents: 0n }, 2: { escrow_balance_cents: WORKED_A_ESCROW_THEIRS_CENTS } }));
    const diffs = await db.query<{ diff_id: string; loan_id: string; field: string }>(`SELECT diff_id::text AS diff_id, loan_id::text AS loan_id, field FROM parallel_run_diffs WHERE parallel_run_id = $1 AND action = 'opened' ORDER BY field`, [runId]);
    assert.equal(diffs.length, 2); const d2 = diffs.find((d) => d.loan_id === l2)!; const d3 = diffs.find((d) => d.loan_id === l3)!;
    const money0 = await moneyAndNotices(db); const rowsBefore = await count(db, "parallel_run_diffs");
    // an ops_analyst dispositions one: ROLE_REQUIRED{officer}
    const denied = await p.api("POST", `/ops/api/parallel-run/${runId}/diffs/${d2.diff_id}`, { disposition: "timing", reason: "x" }, p.as("ana", "ops_analyst"));
    assert.equal(denied.status, 403, JSON.stringify(denied.body)); assert.equal(denied.body["code"], "ROLE_REQUIRED"); assert.equal(denied.body["role"], "officer"); assert.equal(await count(db, "parallel_run_diffs"), rowsBefore);
    // the officer dispositions loan 2 timing and loan 3 theirs_right with reasons
    const r2 = await p.api("POST", `/ops/api/parallel-run/${runId}/diffs/${d2.diff_id}`, { disposition: "timing", reason: "incumbent grace calendar; matches on the 18th" }, p.as("osc", "officer")); assert.equal(r2.status, 200, JSON.stringify(r2.body));
    const r3 = await p.api("POST", `/ops/api/parallel-run/${runId}/diffs/${d3.diff_id}`, { disposition: "theirs_right", reason: "fee under the incumbent's schedule; not ours to post" }, p.as("osc", "officer")); assert.equal(r3.status, 200, JSON.stringify(r3.body));
    const disp = await db.query<{ diff_id: string; disposition: string; reason: string; by: string; decision_id: string | null; field: string }>(`SELECT diff_id::text AS diff_id, disposition, reason, by::text AS by, decision_id::text AS decision_id, field FROM parallel_run_diffs WHERE parallel_run_id = $1 AND action = 'dispositioned' ORDER BY field`, [runId]);
    assert.equal(disp.length, 2); assert.deepEqual(disp.map((d) => [d.diff_id, d.disposition, d.by]), [[d3.diff_id, "theirs_right", p.ids["osc"]], [d2.diff_id, "timing", p.ids["osc"]]]); assert.ok(disp.every((d) => d.decision_id && d.reason.length > 10));
    const evs = (await events(db, "parallel_run.diff.dispositioned")).filter((e) => e.payload["parallel_run_id"] === runId); assert.equal(evs.length, 2);
    assert.deepEqual(evs.map((e) => [e.payload["loan_id"], e.payload["field"], e.payload["disposition"], e.payload["by"]]).sort(), [[l2, "late_charges_accrued_cents", "timing", p.ids["osc"]], [l3, "escrow_balance_cents", "theirs_right", p.ids["osc"]]].sort());
    const decs = (await decisions(db, "parallel_run.disposition")).filter((d) => [d2.diff_id, d3.diff_id].includes(d.subject_id ?? "")); assert.equal(decs.length, 2);
    for (const d of decs) { const rec = JSON.parse(d.rationale) as Json; assert.equal(rec["by"], p.ids["osc"]); assert.match(String(rec["reason"]), /incumbent/); assert.equal(d.approved_by, p.ids["osc"]); assert.equal(rec["rule_set_version"], "posture.v1"); assert.equal(rec["model_version"], "deterministic"); }
    // the agent proposes ours_right for loan 3 with confidence 0.62: the decision record holds the proposal; no diff row changes
    const rowsAfter = await count(db, "parallel_run_diffs");
    const prop = await tool(w, "parallel_run.disposition", AGENT, { op: "propose", diff_id: d3.diff_id, disposition: "ours_right", rationale: "our escrow analysis carries the disbursement; the incumbent's fee is not ours" }, { runId: `run-${R}`, modelVersion: "claude-opus-5", promptVersion: "35.12-v1", confidence: 0.62 });
    assert.equal((prop.output as Json)["proposed"], true); assert.equal((prop.output as Json)["confidence"], 0.62);
    const proposals = (await decisions(db, "parallel_run.disposition:propose")).filter((d) => d.subject_id === d3.diff_id); assert.equal(proposals.length, 1);
    const rec = JSON.parse(proposals[0]!.rationale) as Json; assert.equal(rec["proposed_disposition"], "ours_right"); assert.equal(rec["confidence"], 0.62); assert.equal(rec["model_version"], "claude-opus-5"); assert.equal(Number(proposals[0]!.confidence), 0.62); assert.equal(proposals[0]!.agent, "compliance-sentinel");
    assert.equal(await count(db, "parallel_run_diffs"), rowsAfter, "no diff row changes on a proposal");
    assert.equal((await db.query<{ disposition: string }>(`SELECT disposition FROM parallel_run_diffs WHERE diff_id = $1 ORDER BY created_at DESC LIMIT 1`, [d3.diff_id]))[0]!.disposition, "theirs_right", "the officer's disposition stands");
    // no ledger line, fees row or loans column changed in any of these calls
    assert.equal(await moneyAndNotices(db), money0);
  } finally { await w.close(); }
});

test("35.12-T14: Given a run opened 2026-11-02 with every day reconciled, the last seven days (2026-11-24 … 2026-11-30) at `mismatched = 0` on the six money fields and every diff dispositioned, when the officer closes it on 2026-11-30, then `parallel_runs{closed, outcome: passed, days: 28}` and `parallel_run.closed` exist and `GL-06` reads satisfied; given the same on 2026-11-29, then `PARALLEL_RUN_TOO_SHORT{days: 27}`; given one open diff, then `PARALLEL_RUN_OPEN_DIFFS{count: 1}`; given a money mismatch on 2026-11-27, then `PARALLEL_RUN_DIRTY_WEEK{days_clean: 3}`; given `abandoned` with a reason, then the gate is no longer satisfiable until a new run opens.", { skip }, async () => {
  const w = await runWorld("t14", "2026-11-29T22:00:00Z"); const db = w.db; const p = w.people;
  try {
    const clean = incumbentCsv(w.loanIds, w.figures); const days = (from: string, to: string): string[] => { const out: string[] = []; for (let d = from; d <= to; d = new Date(Date.parse(`${d}T00:00:00Z`) + DAY).toISOString().slice(0, 10)) out.push(d); return out; };
    const close = (runId: string, body: Json) => p.api("POST", `/ops/api/parallel-run/${runId}/close`, body, p.as("osc", "officer"));
    // run A: opened 2026-11-02, every day reconciled, the last seven clean, every diff dispositioned
    const A = await openRun(w, w.loanIds, "2026-11-02");
    for (const d of days("2026-11-02", "2026-11-29")) assert.equal((await reconcile(w, A, d, clean)).body["mismatched"], 0);
    // on 2026-11-29: PARALLEL_RUN_TOO_SHORT{days: 27}
    const short = await close(A, { outcome: "passed", reason: "ready" }); assert.equal(short.status, 409, JSON.stringify(short.body)); assert.equal(short.body["code"], "PARALLEL_RUN_TOO_SHORT"); assert.equal(short.body["days"], 27);
    // on 2026-11-30 with the 30th reconciled: closed passed, days 28; parallel_run.closed; GL-06 reads satisfied
    w.clock.set("2026-11-30T22:00:00Z"); await p.signIn("osc"); await reconcile(w, A, "2026-11-30", clean);
    const ok = await close(A, { outcome: "passed", reason: "28 days, last week clean" }); assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body["outcome"], "passed"); assert.equal(ok.body["days"], 28); assert.equal(ok.body["days_clean"], 29);
    const [closedRow] = await db.query<{ action: string; outcome: string; as_of_date: string; by: string }>(`SELECT action, outcome, as_of_date::text AS as_of_date, by::text AS by FROM parallel_runs WHERE parallel_run_id = $1 AND action = 'closed'`, [A]);
    assert.deepEqual(closedRow, { action: "closed", outcome: "passed", as_of_date: "2026-11-30", by: p.ids["osc"] });
    const closedEv = (await events(db, "parallel_run.closed")).filter((e) => e.payload["parallel_run_id"] === A); assert.equal(closedEv.length, 1); assert.deepEqual({ closed_on: closedEv[0]!.payload["closed_on"], outcome: closedEv[0]!.payload["outcome"], days: closedEv[0]!.payload["days"], final_week_mismatched: closedEv[0]!.payload["final_week_mismatched"] }, { closed_on: "2026-11-30", outcome: "passed", days: 28, final_week_mismatched: 0 });
    const gl = await tool(w, "go_live.check", AGENT, { environment: "production" }); const gl06 = ((gl.output as Json)["items"] as Json[]).find((it) => it["item_code"] === "GL-06")!;
    assert.equal(gl06["status"], "satisfied"); assert.equal(gl06["evidence_ref"], A, "GL-06 names the run");
    // run B: a money mismatch on 2026-11-27 (escrow $5.00 on loan 3); with the diff open → PARALLEL_RUN_OPEN_DIFFS{count: 1}; dispositioned → PARALLEL_RUN_DIRTY_WEEK{days_clean: 3}
    const B = await openRun(w, w.loanIds, "2026-11-02");
    for (const d of days("2026-11-02", "2026-11-30")) await reconcile(w, B, d, d === "2026-11-27" ? incumbentCsv(w.loanIds, w.figures, { 2: { escrow_balance_cents: WORKED_A_ESCROW_THEIRS_CENTS } }) : clean);
    const openDiff = await close(B, { outcome: "passed", reason: "x" }); assert.equal(openDiff.status, 409, JSON.stringify(openDiff.body)); assert.equal(openDiff.body["code"], "PARALLEL_RUN_OPEN_DIFFS"); assert.equal(openDiff.body["count"], 1);
    const [diff] = await db.query<{ diff_id: string }>(`SELECT diff_id::text AS diff_id FROM parallel_run_diffs WHERE parallel_run_id = $1 AND action = 'opened'`, [B]);
    const disp = await p.api("POST", `/ops/api/parallel-run/${B}/diffs/${diff!.diff_id}`, { disposition: "theirs_right", reason: "the incumbent's disbursement fee" }, p.as("osc", "officer")); assert.equal(disp.status, 200, JSON.stringify(disp.body));
    const dirty = await close(B, { outcome: "passed", reason: "x" }); assert.equal(dirty.status, 409, JSON.stringify(dirty.body)); assert.equal(dirty.body["code"], "PARALLEL_RUN_DIRTY_WEEK"); assert.equal(dirty.body["days_clean"], 3, "2026-11-28 … 2026-11-30");
    assert.equal((await parallelRunBoard(db, B, w.clock.now()))["days_clean"], 3);
    // abandoned with a reason: closed, the gate cancelled — not satisfiable until a new run opens
    const gateBefore = (await timers(db, "SM_PROD_GO_LIVE_ATTEST_GATE")).filter((t) => t.status === "armed"); assert.equal(gateBefore.length, 1, "run B's gate instance");
    const ab = await close(B, { outcome: "abandoned", reason: "the incumbent's fee schedule is not reconcilable this cycle" }); assert.equal(ab.status, 200, JSON.stringify(ab.body)); assert.equal(ab.body["outcome"], "abandoned");
    assert.equal((await timers(db, "SM_PROD_GO_LIVE_ATTEST_GATE")).filter((t) => t.status === "armed").length, 0, "no armed gate"); assert.equal((await timers(db, "SM_PROD_GO_LIVE_ATTEST_GATE", "AND id = $2", [gateBefore[0]!.id]))[0]!.status, "cancelled");
    await p.signIn("cid");
    const attest = await p.api("POST", "/ops/api/go-live/attest", { environment: "production" }, p.as("cid", "ciso")); assert.equal(attest.status, 409, JSON.stringify(attest.body)); assert.equal(attest.body["code"], "GO_LIVE_GATE"); assert.match(String(attest.body["reason"]), /abandoned/);
    const C = await openRun(w, w.loanIds, "2026-11-30"); assert.equal((await timers(db, "SM_PROD_GO_LIVE_ATTEST_GATE")).filter((t) => t.status === "armed").length, 1, "a new run re-arms the gate"); void C;
  } finally { await w.close(); }
});

test("35.12-T15: Given production rows satisfying every item but `GL-05` (the `eoscar` switch is `off`), when `go_live.check` runs, then twelve items are answered with an `evidence_ref` each (`GL-01` the manifest id, `GL-02` the run id, `GL-03` the drill id, `GL-04` the 35.7 board scan id, `GL-06` the run id, `GL-07` the counsel document id, `GL-08` the thirty scan ids, `GL-09` the config rows, `GL-10` the two 35.4 attestations, `GL-11` the seven `ops_daily_reports` ids, `GL-12` the confirmation documents), `GL-05` is `open` naming `eoscar`, and `go_live.attest` is refused `GO_LIVE_ITEM_OPEN{GL-05}`; when `compliance` waives `GL-08` with a reason, then `waived` with the person; when anyone waives `GL-05`, then refused.", { skip }, async () => {
  // production rows satisfying every item but GL-05: the eoscar switch stays off (ten of the eleven vendors real/live with a canary)
  const w = await goLiveWorld("t15", { vendors: GO_LIVE_VENDORS.filter((v) => v !== "eoscar") }); const db = w.db; const p = w.people; const ev = w.ev;
  try {
    const before = await count(db, "go_live_checklists");
    const r = await w.papi("GET", "/ops/api/go-live?environment=production", undefined, p.as("cid", "ciso"));
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 800)); const items = r.body["items"] as Json[]; assert.equal(items.length, 12);
    const by = new Map(items.map((it) => [it["item_code"] as string, it]));
    const evidence = (code: string): string => { const it = by.get(code)!; assert.equal(it["status"], "satisfied", `${code}: ${JSON.stringify(it)}`); return it["evidence_ref"] as string; };
    // every item but GL-05 satisfied, each with the evidence the spec names
    assert.equal(evidence("GL-01"), ev.manifest_id, "GL-01 the manifest id"); assert.equal(evidence("GL-02"), ev.run_id, "GL-02 the run id"); assert.equal(evidence("GL-03"), ev.drill_id, "GL-03 the drill id");
    assert.equal(evidence("GL-04"), ev.scan_run_id, "GL-04 the 35.7 board scan id"); assert.equal(evidence("GL-06"), ev.parallel_run_id, "GL-06 the run id"); assert.equal(evidence("GL-07"), ev.retention_doc, "GL-07 the counsel document id");
    const scanIds = evidence("GL-08").split(","); assert.equal(scanIds.length, 30, "GL-08 the thirty scan ids"); assert.deepEqual([...scanIds].sort(), [...ev.scan_ids].sort());
    assert.equal(evidence("GL-09"), "loan_servicing_configs:0;servicer_profiles:1", "GL-09 the config rows");
    assert.deepEqual(evidence("GL-10").split(",").sort(), [...ev.attestations].sort(), "GL-10 the two 35.4 attestations"); assert.deepEqual(evidence("GL-11").split(",").sort(), [...ev.reports].sort(), "GL-11 the seven ops_daily_reports ids");
    assert.deepEqual(evidence("GL-12").split(",").sort(), [...ev.confirmations].sort(), "GL-12 the confirmation documents");
    const gl05 = by.get("GL-05")!; assert.equal(gl05["status"], "open"); assert.equal(gl05["evidence_ref"], null); assert.deepEqual((gl05["detail"] as Json)["not_real_live"], ["eoscar"], "GL-05 names eoscar"); assert.deepEqual((gl05["detail"] as Json)["no_canary_24h"], []); assert.equal((gl05["detail"] as Json)["integrations"], "real");
    assert.deepEqual(r.body["open"], ["GL-05"]); assert.equal(r.body["manifest_id"], ev.manifest_id);
    // the check wrote one row per item (computed, never typed); a second check writes nothing new
    const rows = await db.query<{ item_code: string; status: string; evidence_ref: string | null; by: string; manifest_id: string }>(`SELECT item_code, status, evidence_ref, by::text AS by, manifest_id::text AS manifest_id FROM go_live_checklists WHERE environment = 'production' ORDER BY item_code`);
    assert.equal(rows.length, before + 12); assert.equal(rows.filter((x) => x.status === "open").map((x) => x.item_code).join(), "GL-05"); assert.ok(rows.every((x) => x.by === p.ids["cid"] && x.manifest_id === ev.manifest_id));
    assert.equal(rows.find((x) => x.item_code === "GL-08")!.evidence_ref, evidence("GL-08"));
    const again = await w.papi("GET", "/ops/api/go-live?environment=production", undefined, p.as("cid", "ciso")); assert.equal(again.status, 200); assert.equal(again.body["rows_written"], 0); assert.equal(await count(db, "go_live_checklists"), before + 12);
    // go_live.attest with GL-05 open: GO_LIVE_ITEM_OPEN{GL-05}, no request event
    const att = await w.papi("POST", "/ops/api/go-live/attest", { environment: "production" }, p.as("cid", "ciso"));
    assert.equal(att.status, 409, JSON.stringify(att.body)); assert.equal(att.body["code"], "GO_LIVE_ITEM_OPEN"); assert.equal(att.body["item_code"], "GL-05", "GO_LIVE_ITEM_OPEN{GL-05}");
    assert.equal((att.body["items"] as Json[]).length, 1); assert.equal((att.body["items"] as Json[])[0]!["item_code"], "GL-05"); assert.equal((await events(db, "go_live.attest.requested")).length, 0);
    // compliance waives GL-08 with a reason: waived with the person; the item stays waived on the next check
    const waive = await w.papi("POST", "/ops/api/go-live/waive", { environment: "production", item_code: "GL-08", reason: "the 2026-11-01 scan ran at 05:52 ET after a migration; every later day is clean" }, p.as("cara", "compliance"));
    assert.equal(waive.status, 200, JSON.stringify(waive.body)); const w08 = (waive.body["items"] as Json[]).find((it) => it["item_code"] === "GL-08")!;
    assert.deepEqual({ status: w08["status"], waived_by: w08["waived_by"], evidence_ref: w08["evidence_ref"] }, { status: "waived", waived_by: p.ids["cara"], evidence_ref: `waived_by:${p.ids["cara"]}` }); assert.match(String(w08["reason"]), /migration/);
    const [wrow] = await db.query<{ status: string; by: string; reason: string; decision_id: string | null }>(`SELECT status, by::text AS by, reason, decision_id::text AS decision_id FROM go_live_checklists WHERE environment = 'production' AND item_code = 'GL-08' ORDER BY created_at DESC, id DESC LIMIT 1`);
    assert.deepEqual({ status: wrow!.status, by: wrow!.by }, { status: "waived", by: p.ids["cara"] }); assert.ok(wrow!.decision_id && wrow!.reason.length > 10);
    const waivedEv = (await events(db, "go_live.item.waived")).filter((e) => e.payload["item_code"] === "GL-08"); assert.equal(waivedEv.length, 1); assert.equal(waivedEv[0]!.payload["by"], p.ids["cara"]);
    // computed, never typed: GL-08 is satisfied by its thirty scans, so the next check reports the evidence (the waiver row stays on the checklist); a waiver stands while its item is open —
    // GL-10 with one 35.4 attestation (the port's rows) reads open, compliance waives it, the next checks read waived until the second attestation lands
    const after = await w.papi("GET", "/ops/api/go-live?environment=production", undefined, p.as("cid", "ciso")); assert.equal(((after.body["items"] as Json[]).find((it) => it["item_code"] === "GL-08")!)["status"], "satisfied", "evidence wins over a waiver");
    const second = ev.attestations.pop()!;
    const open10 = await w.papi("GET", "/ops/api/go-live?environment=production", undefined, p.as("cid", "ciso")); assert.deepEqual(open10.body["open"], ["GL-05", "GL-10"]);
    const waive10 = await w.papi("POST", "/ops/api/go-live/waive", { environment: "production", item_code: "GL-10", reason: "October's close attested; November's closes 2026-12-01 with the tape" }, p.as("cara", "compliance")); assert.equal(waive10.status, 200, JSON.stringify(waive10.body));
    const stands = await w.papi("GET", "/ops/api/go-live?environment=production", undefined, p.as("cid", "ciso")); const it10 = (stands.body["items"] as Json[]).find((it) => it["item_code"] === "GL-10")!;
    assert.deepEqual({ status: it10["status"], waived_by: it10["waived_by"], open: stands.body["open"] }, { status: "waived", waived_by: p.ids["cara"], open: ["GL-05"] }, "the waiver stands on the next check");
    ev.attestations.push(second); const back = await w.papi("GET", "/ops/api/go-live?environment=production", undefined, p.as("cid", "ciso")); assert.equal(((back.body["items"] as Json[]).find((it) => it["item_code"] === "GL-10")!)["status"], "satisfied");
    // anyone waiving GL-05: refused — compliance GO_LIVE_ITEM_NOT_WAIVABLE (only GL-08 and GL-10 may be), the ciso ROLE_REQUIRED{compliance}; no row
    const n0 = await count(db, "go_live_checklists");
    const notWaivable = await w.papi("POST", "/ops/api/go-live/waive", { environment: "production", item_code: "GL-05", reason: "the bureau goes live next week" }, p.as("cara", "compliance"));
    assert.equal(notWaivable.status, 409, JSON.stringify(notWaivable.body)); assert.equal(notWaivable.body["code"], "GO_LIVE_ITEM_NOT_WAIVABLE"); assert.deepEqual(notWaivable.body["waivable"], ["GL-08", "GL-10"]);
    const ciso = await w.papi("POST", "/ops/api/go-live/waive", { environment: "production", item_code: "GL-05", reason: "x" }, p.as("cid", "ciso")); assert.equal(ciso.status, 403, JSON.stringify(ciso.body)); assert.equal(ciso.body["code"], "ROLE_REQUIRED");
    const officer = await w.papi("POST", "/ops/api/go-live/waive", { environment: "production", item_code: "GL-05", reason: "x" }, p.as("osc", "officer")); assert.equal(officer.status, 403, JSON.stringify(officer.body));
    const money = await w.ptool("go_live.check", AGENT, { op: "waive", environment: "production", item_code: "GL-06", reason: "x" }).then(() => null, (e: unknown) => e as { code?: string });
    assert.equal(money?.code, "ROLE_REQUIRED", "the agent has no compliance role; the money items are satisfied by evidence"); assert.equal(await count(db, "go_live_checklists"), n0, "no row from a refused waiver");
  } finally { await w.close(); }
});

test("35.12-T16: Given every item satisfied or waived on 2026-11-30, when a `ciso` requests `go_live.attest` and a `compliance` session confirms within 10 minutes, then `go_live_checklists{GL-00, attested}` names both people and the `manifest_id`, `go_live.attested` is logged, `SM_PROD_GO_LIVE_ATTEST_GATE` is satisfied, and thereafter `integrations.switch{production, any vendor, mode: fake}` is refused `NO_FAKE_IN_PRODUCTION`; given the requester confirms, then `TWO_PERSON_GO_LIVE`; given a confirmation at 11 minutes, then the request has expired and nothing is attested.", { skip }, async () => {
  // every item satisfied on 2026-11-30 (the eleven vendors real/live with a canary each) — GL-08 waived by compliance for the item's own reason is the other allowed state
  const w = await goLiveWorld("t16", { vendors: GO_LIVE_VENDORS }); const db = w.db; const p = w.people; const ev = w.ev;
  try {
    const gl = await w.papi("GET", "/ops/api/go-live?environment=production", undefined, p.as("cid", "ciso")); assert.equal(gl.status, 200, JSON.stringify(gl.body).slice(0, 600)); assert.deepEqual(gl.body["open"], [], JSON.stringify((gl.body["items"] as Json[]).filter((it) => it["status"] === "open")));
    const gate0 = (await timers(db, "SM_PROD_GO_LIVE_ATTEST_GATE")).filter((t) => t.status === "armed"); assert.equal(gate0.length, 1, "the gate armed by the run opened 2026-11-02"); assert.equal(gate0[0]!.anchor_date, "2026-11-02");
    const t0 = w.clock.now();
    // the ciso requests: an event, no row yet
    const req = await w.papi("POST", "/ops/api/go-live/attest", { environment: "production", reason: "every item satisfied; the incumbent's tape stops 2026-12-01" }, p.as("cid", "ciso"));
    assert.equal(req.status, 200, JSON.stringify(req.body)); assert.equal(req.body["status"], "requested"); const requestId = req.body["request_id"] as string; assert.ok(isUuidLike(requestId)); assert.equal(req.body["manifest_id"], ev.manifest_id); assert.equal(req.body["not_before"], "2026-11-30");
    assert.equal(await count(db, "go_live_checklists WHERE item_code = 'GL-00'"), 0, "no row before the confirmation"); assert.equal((await events(db, "go_live.attest.requested")).filter((e) => e.payload["request_id"] === requestId).length, 1);
    // the requester confirms: TWO_PERSON_GO_LIVE
    const self = await w.papi("POST", "/ops/api/go-live/attest", { environment: "production", request_id: requestId }, p.as("cid", "ciso"));
    assert.equal(self.status, 403, JSON.stringify(self.body)); assert.equal(self.body["code"], "TWO_PERSON_GO_LIVE"); assert.equal(await count(db, "go_live_checklists WHERE item_code = 'GL-00'"), 0);
    // a compliance session confirms 6 minutes later: GL-00 attested naming both people and the manifest; go_live.attested; the gate satisfied
    w.clock.set(at(6 * MIN, t0));
    const ok = await w.papi("POST", "/ops/api/go-live/attest", { environment: "production", request_id: requestId }, p.as("cara", "compliance"));
    assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.deepEqual({ status: ok.body["status"], by: ok.body["by"], confirmed_by: ok.body["confirmed_by"], manifest_id: ok.body["manifest_id"], attested_at: ok.body["attested_at"] }, { status: "attested", by: p.ids["cid"], confirmed_by: p.ids["cara"], manifest_id: ev.manifest_id, attested_at: w.clock.now() });
    const rows = await db.query<{ checklist_id: string; status: string; by: string; by_role: string; confirmed_by: string; manifest_id: string; request_id: string; decision_id: string | null; evidence_ref: string }>(`SELECT checklist_id::text AS checklist_id, status, by::text AS by, by_role, confirmed_by::text AS confirmed_by, manifest_id::text AS manifest_id, request_id::text AS request_id, decision_id::text AS decision_id, evidence_ref FROM go_live_checklists WHERE environment = 'production' AND item_code = 'GL-00'`);
    assert.equal(rows.length, 1); assert.deepEqual({ status: rows[0]!.status, by: rows[0]!.by, by_role: rows[0]!.by_role, confirmed_by: rows[0]!.confirmed_by, manifest_id: rows[0]!.manifest_id, request_id: rows[0]!.request_id, evidence_ref: rows[0]!.evidence_ref }, { status: "attested", by: p.ids["cid"], by_role: "ciso", confirmed_by: p.ids["cara"], manifest_id: ev.manifest_id, request_id: requestId, evidence_ref: `manifest:${ev.manifest_id}` });
    assert.ok(rows[0]!.decision_id, "the decision row on the attestation row"); assert.equal(rows[0]!.checklist_id, ok.body["checklist_id"]); assert.equal(rows[0]!.checklist_id, gl.body["checklist_id"], "the attempt the items were checked under");
    const attested = (await events(db, "go_live.attested")).filter((e) => e.payload["request_id"] === requestId);
    assert.equal(attested.length, 1); assert.deepEqual({ by: attested[0]!.payload["by"], confirmed_by: attested[0]!.payload["confirmed_by"], manifest_id: attested[0]!.payload["manifest_id"], environment: attested[0]!.payload["environment"], not_before: attested[0]!.payload["not_before"] }, { by: p.ids["cid"], confirmed_by: p.ids["cara"], manifest_id: ev.manifest_id, environment: "production", not_before: "2026-11-30" });
    assert.equal(attested[0]!.aggregate_kind, "go_live_checklist"); assert.equal(attested[0]!.actor_id, p.ids["cara"]);
    const gate1 = (await timers(db, "SM_PROD_GO_LIVE_ATTEST_GATE", "AND id = $2", [gate0[0]!.id]))[0]!; assert.match(gate1.status, /^satisfied/, "SM_PROD_GO_LIVE_ATTEST_GATE satisfied by go_live.attested"); assert.equal((await timers(db, "SM_PROD_GO_LIVE_ATTEST_GATE")).filter((t) => t.status === "armed").length, 0);
    const dec = (await decisions(db, "go_live.attest:confirm")).filter((d) => d.subject_id === rows[0]!.checklist_id); assert.equal(dec.length, 1); assert.equal(dec[0]!.approved_by, p.ids["cara"]); const rec = JSON.parse(dec[0]!.rationale) as Json; assert.equal(rec["by"], p.ids["cid"]); assert.equal(rec["confirmed_by"], p.ids["cara"]);
    // the check afterwards reports the attestation it was made against
    const after = await w.papi("GET", "/ops/api/go-live?environment=production", undefined, p.as("cid", "ciso")); assert.equal(after.status, 200); assert.deepEqual({ by: (after.body["attested"] as Json)["by"], confirmed_by: (after.body["attested"] as Json)["confirmed_by"], manifest_id: (after.body["attested"] as Json)["manifest_id"] }, { by: p.ids["cid"], confirmed_by: p.ids["cara"], manifest_id: ev.manifest_id });
    // thereafter integrations.switch{production, any vendor, mode: fake}: NO_FAKE_IN_PRODUCTION at the request — no event, no row (the ciso session and the bus alike)
    const s0 = await count(db, "integration_switches"); const e0 = await count(db, "loan_events WHERE type = 'integration.switch.requested'");
    for (const vendor of ["print_mail", "ach_nacha", "google_oidc"]) {
      const fake = await w.papi("POST", "/ops/api/integrations/switch", { environment: "production", vendor, mode: "fake", rationale: "a demo" }, p.as("cid", "ciso"));
      assert.equal(fake.status, 409, JSON.stringify(fake.body)); assert.equal(fake.body["code"], "NO_FAKE_IN_PRODUCTION");
    }
    const bus = await refusalOf(w.ptool("integrations.switch", p.actor("cid", "ciso"), { op: "request", environment: "production", vendor: "evault", mode: "fake" })); assert.equal(bus.code, "NO_FAKE_IN_PRODUCTION"); assert.equal(bus.extra["vendor"] ?? "evault", "evault");
    assert.equal(await count(db, "integration_switches"), s0); assert.equal(await count(db, "loan_events WHERE type = 'integration.switch.requested'"), e0, "not even a request");
    const status = await w.ptool("integrations.status", AGENT, { environment: "production" }); assert.ok((status["vendors"] as Json[]).every((v) => !GO_LIVE_VENDORS.includes(v["vendor"] as string) || v["mode"] === "real"), "the eleven vendors stay real");
    // a second request confirmed at 11 minutes: the request has expired and nothing is attested (the sweep's pass logs the expiry; a stale request never attests)
    w.clock.set(at(20 * MIN, t0)); const t1 = w.clock.now();
    const req2 = await w.papi("POST", "/ops/api/go-live/attest", { environment: "production" }, p.as("cid", "ciso")); assert.equal(req2.status, 200, JSON.stringify(req2.body)); const request2 = req2.body["request_id"] as string; assert.equal(req2.body["expires_at"], at(10 * MIN, t1));
    w.clock.set(at(11 * MIN, t1));
    const late = await refusalOf(w.ptool("go_live.attest", p.actor("cara", "compliance"), { op: "confirm", request_id: request2 }));
    assert.equal(late.code, "REQUEST_EXPIRED", late.message); assert.equal(late.extra["request_id"], request2);
    assert.equal(await count(db, "go_live_checklists WHERE item_code = 'GL-00'"), 1, "nothing new attested"); assert.equal((await events(db, "go_live.attested")).length, 1);
    const pass = await posturePass(w.prod, w.clock.now()); assert.equal(pass.attest_requests_expired, 1);
    const expired = (await events(db, "go_live.attest.request.expired")).filter((e) => e.payload["request_id"] === request2); assert.equal(expired.length, 1); assert.equal(expired[0]!.payload["requested_by"], p.ids["cid"]);
    const afterExpiry = await refusalOf(w.ptool("go_live.attest", p.actor("cara", "compliance"), { op: "confirm", request_id: request2 })); assert.equal(afterExpiry.code, "REQUEST_EXPIRED");
    assert.equal(await count(db, "go_live_checklists WHERE item_code = 'GL-00'"), 1);
  } finally { await w.close(); }
});

test("35.12-T17: Given a production manifest whose `secrets` lists `supermortgage-tin-cipher-key` with `placeholder = true` and `supermortgage-api-token` with a version created 91 days ago, when `posture.check` runs, then `PST-09` fails sev 1 naming the secret and `PST-14` fails sev 2 with `observed.age_days = 91`, and the runtime under the same env refuses to start per src/infra/pii/tin.ts:17; given every secret current and no placeholder, then both pass.", { skip }, async () => {
  const w = await world("t17", "2026-11-16T14:00:00Z");
  try {
    const db = w.db; const now = w.clock.now();
    const m = hardened("production", now);
    m["secrets"] = (m["secrets"] as Json[]).map((e) => e["name"] === "supermortgage-tin-cipher-key" ? { ...e, placeholder: true } : e["name"] === "supermortgage-api-token" ? { ...e, version_created_at: at(-91 * DAY, now) } : e);
    const r = await tool(w, "posture.record", AGENT, m);
    const rows = await checks(db, ((r.output as Json)["check"] as Json)["run_id"] as string); const by = new Map(rows.map((c) => [c.control_code, c]));
    // PST-09 fails sev 1 naming the secret; PST-14 fails sev 2 with observed.age_days = 91
    assert.equal(by.get("PST-09")!.result, "fail"); assert.deepEqual(by.get("PST-09")!.observed["placeholders"], ["supermortgage-tin-cipher-key"]);
    assert.equal(by.get("PST-14")!.result, "fail"); assert.equal(by.get("PST-14")!.observed["age_days"], 91); assert.deepEqual(by.get("PST-14")!.observed["stale"], ["supermortgage-api-token"]);
    const open = await findings(db, "environment = 'production' AND action = 'opened' AND control_code IN ('PST-09', 'PST-14')");
    assert.deepEqual(open.map((f) => [f.control_code, f.severity]).sort(), [["PST-09", "sev1"], ["PST-14", "sev2"]]);
    const esc = await escalations(db, "payload->>'code' = 'POSTURE_DRIFT' AND payload->>'control_code' IN ('PST-09', 'PST-14')");
    assert.deepEqual(esc.map((e) => [e.payload["control_code"], e.kind, e.owner_role]).sort(), [["PST-09", "sev1", "ciso"], ["PST-14", "sev2", "ciso"]]);
    // the runtime under the same env refuses to start (src/infra/pii/tin.ts:17: the placeholder reads as unset in production)
    assert.throws(() => tinCipherKey({ ENVIRONMENT: "production", TIN_CIPHER_KEY: "" } as NodeJS.ProcessEnv), /TIN_CIPHER_KEY is not set/);
    assert.throws(() => tinCipherKey({ ENVIRONMENT: "production" } as NodeJS.ProcessEnv), /required in production/);
    // every secret current and no placeholder: both pass, and the two findings resolve by manifest
    w.clock.set(at(HOUR, now));
    const r2 = await tool(w, "posture.record", AGENT, hardened("production", w.clock.now()));
    const rows2 = await checks(db, ((r2.output as Json)["check"] as Json)["run_id"] as string); const by2 = new Map(rows2.map((c) => [c.control_code, c]));
    assert.equal(by2.get("PST-09")!.result, "pass"); assert.equal(by2.get("PST-14")!.result, "pass"); assert.deepEqual(by2.get("PST-09")!.observed["placeholders"], []); assert.ok((by2.get("PST-14")!.observed["age_days"] as number) <= 90);
    assert.deepEqual((((r2.output as Json)["check"] as Json)["findings_resolved"] as Json[]).map((f) => f["control_code"]).sort(), ["PST-09", "PST-14"]);
  } finally { await w.close(); }
});

test("35.12-T18: Given a production environment with three active `staff_users`, one of which has an active `staff_credentials` row of kind `password` and no `oidc_identities` row, when `posture.check` runs, then `PST-06` fails sev 1 with `observed = {password_credentials: 1, without_oidc: 1}` and no e-mail or name in the check row, the finding or the escalation; when that account's password credential is disabled and an OIDC identity bound (34.1's commands), then the next run passes and the finding resolves by manifest.", { skip }, async () => {
  // the world's doors run nonprod (the FAKE e-delivery echoes the code); the manifest and the check are production's — PST-06 reads the staff table the check runs against
  const w = await world("t18", "2026-11-16T14:00:00Z");
  try {
    const db = w.db; const p = w.people;
    // three active staff: the bootstrap admin enrolled through the door (a password credential, no OIDC binding) and two bound to the provider with no password
    await p.invite("ada", []);
    const bound: string[] = [];
    for (const tag of ["oidc-one", "oidc-two"]) {
      const [u] = await db.query<{ id: string }>(`INSERT INTO staff_users (email_hash, email_encrypted, legal_name, roles, status, enrolled_at) VALUES ($1, $2, $3, '{ops_analyst}', 'active', $4::timestamptz) RETURNING id::text AS id`, [sha256hex(`${tag}.${R}@example.test`), Buffer.from("00", "hex"), `${tag} Person`, w.clock.now()]);
      await db.query(`INSERT INTO staff_oidc_identities (staff_user_id, environment, issuer, subject, bound_at) VALUES ($1, 'production', 'https://accounts.google.com', $2, $3::timestamptz)`, [u!.id, `sub-${tag}-${R}`, w.clock.now()]);
      bound.push(u!.id);
    }
    assert.equal(await count(db, "staff_users WHERE status = 'active'"), 3);
    assert.equal(await count(db, "staff_credentials WHERE kind = 'password' AND revoked_at IS NULL"), 1);
    const r1 = await tool(w, "posture.record", AGENT, hardened("production", w.clock.now()));
    const row1 = (await checks(db, ((r1.output as Json)["check"] as Json)["run_id"] as string)).find((c) => c.control_code === "PST-06")!;
    assert.equal(row1.result, "fail"); assert.deepEqual(row1.observed, { password_credentials: 1, without_oidc: 1 });
    const f = (await findings(db, "environment = 'production' AND control_code = 'PST-06' AND action = 'opened'"))[0]!; assert.equal(f.severity, "sev1");
    const esc = (await escalations(db, "payload->>'code' = 'POSTURE_DRIFT' AND payload->>'control_code' = 'PST-06'"))[0]!; assert.equal(esc.kind, "sev1"); assert.equal(esc.owner_role, "ciso");
    // no e-mail or name in the check row, the finding or the escalation
    noPii(row1, "the check row"); noPii(f, "the finding"); noPii(esc, "the escalation"); noPii((await events(db, "posture.drift.detected")).map((e) => e.payload), "the drift events");
    // the account's password credential disabled and an OIDC identity bound (34.1's repo revokes a password the same way; the binding is the ops-console OIDC client's row): the next run passes and the finding resolves by manifest
    await db.query(`UPDATE staff_credentials SET revoked_at = $2 WHERE staff_user_id = $1 AND kind = 'password' AND revoked_at IS NULL`, [p.ids["ada"], w.clock.now()]);
    await db.query(`INSERT INTO staff_oidc_identities (staff_user_id, environment, issuer, subject, bound_at) VALUES ($1, 'production', 'https://accounts.google.com', $2, $3::timestamptz)`, [p.ids["ada"], `sub-ada-${R}`, w.clock.now()]);
    w.clock.set(at(HOUR, w.clock.now()));
    const r2 = await tool(w, "posture.record", AGENT, hardened("production", w.clock.now()));
    const row2 = (await checks(db, ((r2.output as Json)["check"] as Json)["run_id"] as string)).find((c) => c.control_code === "PST-06")!;
    assert.equal(row2.result, "pass"); assert.deepEqual(row2.observed, { password_credentials: 0, without_oidc: 0 });
    const hist = await findings(db, "finding_id = $1", [f.finding_id]); assert.deepEqual(hist.map((x) => x.action), ["opened", "resolved"]); assert.equal(hist[1]!.cause, "manifest");
    assert.equal((await timers(db, "SM_PROD_POSTURE_DRIFT_1BD", "AND subject_id = $2", [f.finding_id]))[0]!.status, "satisfied");
    void bound;
  } finally { await w.close(); }
});

test("35.12-T19: Given any 35.12 route or cycle in a contract test over the fixture book, then the ledger, every `*_cents` column of `loans`, `fees`, `escrow_accounts` and `loan_installments`, and every `notices` row are identical before and after; every event and row this process wrote matches no e-mail, no name field and no 9-digit TIN pattern; every action route recorded a `staff_actions` row and an `agent_decisions` row naming the person and, where the rule requires, the confirmer.", { skip }, async () => {
  // the fixture book: the demo transfer batch, the 32.14 entry demo and the 33.1 partner book (every row synthetic), plus the three worked-example loans
  const w = await runWorld("t19", "2026-11-16T14:00:00Z"); const db = w.db; const p = w.people;
  try {
    const demo = generateDemoBatch(); await boardTransferBatch(w.runtime, { ...DEMO_BATCH }, encodeTransferBatch(demo, demo.coborrowers), { kind: "system", id: "seed-demo" }, { synthetic: true });
    const entry = await seedEntryDemo(w.runtime, {}); await seedPartnerBookDemo(w.runtime, { partner_id: entry.partner_id });
    assert.ok((await count(db, "ledger_lines")) > 0 && (await count(db, "notices")) > 0, "a book with a ledger and notices");
    const money0 = await moneyAndNotices(db);
    // every route once, as the person the route names; each call's new decision rows are attributed to that person
    type Call = { method: string; path: string; tag: string; command: string; status: number; decisions: { action: string; by: string; confirmed_by: string | null; approved_by: string | null }[] };
    const calls: Call[] = [];
    const decisionIds = async (): Promise<Set<string>> => new Set((await db.query<{ id: string }>(`SELECT id::text AS id FROM agent_decisions WHERE rule_set_version = 'posture.v1'`)).map((r) => r.id));
    const call = async (method: string, path: string, body: unknown, tag: string, role: string, command: string, expect: number[]): Promise<Reply> => {
      const before = await decisionIds(); const r = await p.api(method, path, body, p.as(tag, role));
      assert.ok(expect.includes(r.status), `${method} ${path} → ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`);
      const rows = (await db.query<{ id: string; action: string; rationale: string; approved_by: string | null }>(`SELECT id::text AS id, action, rationale, approved_by::text AS approved_by FROM agent_decisions WHERE rule_set_version = 'posture.v1'`)).filter((d) => !before.has(d.id));
      calls.push({ method, path, tag, command, status: r.status, decisions: rows.map((d) => { const rec = JSON.parse(d.rationale) as Json; return { action: d.action, by: String(rec["by"]), confirmed_by: (rec["confirmed_by"] as string | null | undefined) ?? null, approved_by: d.approved_by }; }) });
      return r;
    };
    const digest = `sha256:t19${R}`; const t0 = w.clock.now();
    const m1 = await call("POST", "/ops/api/posture/manifests", nonprodAtHead("production", t0, digest), "cid", "ciso", "posture.record", [200]);
    await call("POST", "/ops/api/posture/check", { environment: "production" }, "cid", "ciso", "posture.check", [200]);
    const f08 = (await findings(db, "environment = 'production' AND action = 'opened' AND control_code = 'PST-08'"))[0]!;
    const [ex] = await db.query<{ id: string }>(`INSERT INTO control_exceptions (control_code, scope, justification, compensating_controls, approved_by, approved_at, expires_at, review_due_at) VALUES ('CTL-SEC-04', 'production WAF preview', 'the WAF signatures stay in preview until the tuning window closes', 'rate limit and allow-list stay enforced', $1, $2::timestamptz, ($2::timestamptz + interval '6 months')::date, ($2::timestamptz + interval '3 months')::date) RETURNING id::text AS id`, [`human:${p.ids["cid"]}`, t0]);
    await call("POST", `/ops/api/posture/findings/${f08.finding_id}/resolve`, { cause: "exception", exception_id: ex!.id, reason: "19.2 exception approved by the Qualified Individual" }, "cid", "ciso", "posture.drift.resolve", [200]);
    const tables = (await db.query<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema IN ('public', 'restricted_fl') AND table_type = 'BASE TABLE' ORDER BY 1`)).map((r) => r.t);
    await call("POST", "/ops/api/posture/drills", { environment: "production", source_backup_id: "backup-2026-11-16", backup_taken_at: "2026-11-16T07:00:00Z", pitr_target_at: "2026-11-16T11:00:00Z", newest_event_at: "2026-11-16T10:59:50Z", clone_instance: "supermortgage-drill-20261116", started_at: "2026-11-16T11:05:00Z", completed_at: "2026-11-16T12:30:00Z", row_checks: tables.map((t) => ({ table: t, source_count: 7, clone_count: 7 })), event_chain_ok: true, ledger_balanced: true, clone_destroyed_at: "2026-11-16T13:00:00Z", witnessed_by: p.ids["cara"] }, "cid", "ciso", "backup.drill", [200]);
    const scan = await call("POST", "/ops/api/posture/scans", { environment: "nonprod", kind: "nonprod_real_data" }, "cara", "compliance", "data.scan", [200]); assert.equal(scan.body["real_data_found"], false, "the fixture book is synthetic throughout");
    const nonprodManifest = await call("POST", "/ops/api/posture/manifests", hardened("nonprod", t0, digest), "cid", "ciso", "posture.record", [200]);
    await call("POST", `/ops/api/posture/scans/${scan.body["scan_id"]}/purged`, { environment: "nonprod", rebuilt_manifest_id: nonprodManifest.body["manifest_id"] }, "cara", "compliance", "data.scan", [200, 409]);
    const sw = await call("POST", "/ops/api/integrations/switch", { environment: "nonprod", vendor: "print_mail", mode: "real", endpoint_class: "sandbox", secret_ref: "supermortgage-vendor-print-mail", egress_rule: "egress-print-mail", rationale: "canary" }, "cid", "ciso", "integrations.switch", [200]);
    await call("POST", "/ops/api/integrations/switch", { request_id: sw.body["request_id"] }, "cara", "compliance", "integrations.switch", [200]);
    await call("GET", "/ops/api/integrations?environment=nonprod", undefined, "ana", "ops_analyst", "integrations.status", [200]);
    const run = await call("POST", "/ops/api/parallel-run/open", { environment: "production", incumbent_servicer: "Incumbent", loan_ids: w.loanIds, opened_on: "2026-11-16" }, "osc", "officer", "parallel_run.open", [200]); const runId = run.body["parallel_run_id"] as string;
    await call("POST", `/ops/api/parallel-run/${runId}/reconcile`, { as_of_date: "2026-11-16", incumbent_file_csv: incumbentCsv(w.loanIds, w.figures, { 2: { escrow_balance_cents: WORKED_A_ESCROW_THEIRS_CENTS } }) }, "osc", "officer", "parallel_run.reconcile", [200]);
    const [diff] = await db.query<{ diff_id: string }>(`SELECT diff_id::text AS diff_id FROM parallel_run_diffs WHERE parallel_run_id = $1 AND action = 'opened'`, [runId]);
    await call("POST", `/ops/api/parallel-run/${runId}/diffs/${diff!.diff_id}`, { disposition: "theirs_right", reason: "the incumbent's disbursement fee, not ours to post" }, "osc", "officer", "parallel_run.disposition", [200]);
    await call("GET", `/ops/api/parallel-run/${runId}`, undefined, "ana", "ops_analyst", "parallel_run.board", [200]);
    await call("POST", `/ops/api/parallel-run/${runId}/close`, { outcome: "abandoned", reason: "the incumbent's tape format changes on the 17th; a new run opens on it" }, "osc", "officer", "parallel_run.close", [200]);
    await call("GET", "/ops/api/go-live?environment=production", undefined, "cid", "ciso", "go_live.check", [200]);
    await call("POST", "/ops/api/go-live/waive", { environment: "production", item_code: "GL-10", reason: "one month-end close in the run so far; the second closes with November" }, "cara", "compliance", "go_live.check", [200]);
    const early = await call("POST", "/ops/api/go-live/attest", { environment: "production" }, "cid", "ciso", "go_live.attest", [409]); assert.equal(early.body["code"], "GO_LIVE_GATE");
    await call("GET", "/ops/api/posture?environment=production", undefined, "ana", "ops_analyst", "posture.board", [200]);
    // the cycles on the nonprod runtime: a nonprod run reconciled by the 21:00 pass from the day's file (a document), the 05:30 check, the 05:45 scan, the canary
    const run2 = await call("POST", "/ops/api/parallel-run/open", { environment: "nonprod", incumbent_servicer: "Incumbent", loan_ids: w.loanIds, opened_on: "2026-11-16" }, "osc", "officer", "parallel_run.open", [200]); const run2Id = run2.body["parallel_run_id"] as string;
    const file = hashedDocument("incumbent-trial-balance", { parallel_run_id: run2Id, as_of_date: "2026-11-17", csv: incumbentCsv(w.loanIds, w.figures) });
    await writeDocument(db, file, { kind: "incumbent_trial_balance", retention: "corporate_7y", metadata: { parallel_run_id: run2Id, as_of_date: "2026-11-17", incumbent_servicer: "Incumbent", content: incumbentCsv(w.loanIds, w.figures), rows: 3, source: "sftp" }, created_at: t0 });
    w.clock.set("2026-11-17T10:31:00Z"); const pass1 = await posturePass(w.runtime, w.clock.now()); assert.ok(pass1.daily_check, "the 05:30 check ran on the nonprod manifest"); assert.equal(pass1.daily_check!.environment, "nonprod");
    w.clock.set("2026-11-17T10:46:00Z"); const pass2 = await posturePass(w.runtime, w.clock.now()); assert.ok(pass2.daily_scan, "the 05:45 scan ran"); assert.equal(pass2.daily_scan!.real_data_found, false);
    w.clock.set("2026-11-18T02:01:00Z"); const pass3 = await posturePass(w.runtime, w.clock.now()); assert.equal(pass3.reconciled.length, 1, "the 21:00 pass reconciled the day's file"); assert.equal(pass3.reconciled[0]!.incumbent_file_document_id, file.id); assert.equal(pass3.reconciled[0]!.mismatched, 0);
    assert.equal(pass1.canaries.length + pass2.canaries.length + pass3.canaries.length >= 1, true, "the print_mail canary ran once in the day"); await w.runtime.sweep();
    // the ledger, every *_cents column of loans, fees, escrow_accounts and loan_installments, and every notices row are identical before and after
    assert.equal(await moneyAndNotices(db), money0, "no ledger line, money column or notice moved through any route or cycle");
    // every event and row this process wrote: no e-mail, no name field of a person, no 9-digit TIN pattern (a `name` key naming a secret or a table is a resource name)
    const ROW_PII_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|"(?:legal_name|first_name|last_name|full_name|borrower_name|display_name)"\s*:\s*"[^"]+"|\b\d{3}-?\d{2}-?\d{4}\b/;
    const scrub = (rows: unknown[], what: string): void => { assert.ok(rows.length > 0, `${what}: rows exist`); for (const r of rows) { const text = JSON.stringify(r, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)); assert.ok(!ROW_PII_RE.test(text), `${what}: ${text.slice(0, 300)}`); } };
    for (const t of ["environment_manifests", "posture_checks", "posture_findings", "integration_switches", "restore_drills", "data_scans", "parallel_runs", "parallel_run_diffs", "go_live_checklists"]) scrub(await db.query(`SELECT * FROM ${t}`), t);
    scrub(await db.query(`SELECT kind, sha256, storage_uri, metadata FROM documents WHERE storage_uri LIKE 'fake-blob://posture/%'`), "the process's documents");
    scrub(await db.query(`SELECT type, actor_kind::text AS actor_kind, actor_id, aggregate_kind, aggregate_id, payload FROM loan_events WHERE type LIKE 'posture.%' OR type LIKE 'integration.%' OR type LIKE 'backup.%' OR type LIKE 'parallel_run.%' OR type LIKE 'go_live.%'`), "the process's events");
    scrub(await db.query(`SELECT action, subject_kind, subject_id, rationale FROM agent_decisions WHERE rule_set_version = 'posture.v1'`), "the process's decisions");
    // every action route recorded a staff_actions row (34.1 rule 4: one per request, written after the answer — the log is read once it has caught up) naming the person, and an agent_decisions row naming the person and, for a confirmation, the confirmer
    const posts = calls.filter((c) => c.method === "POST");
    for (let i = 0; i < 200 && (await count(db, "staff_actions WHERE method = 'POST' AND route LIKE '/ops/api/%' AND (route LIKE '/ops/api/posture%' OR route LIKE '/ops/api/integrations%' OR route LIKE '/ops/api/parallel-run%' OR route LIKE '/ops/api/go-live%')")) < posts.length; i++) await new Promise((r) => setTimeout(r, 25));
    for (const c of calls) {
      const rows = await db.query<{ staff_user_id: string; command: string | null; result: string; role: string | null }>(`SELECT staff_user_id::text AS staff_user_id, command, result, role FROM staff_actions WHERE method = $1 AND route LIKE $2 ORDER BY at`, [c.method, `${c.path.split("?")[0]}%`]);
      assert.ok(rows.some((r) => r.staff_user_id === p.ids[c.tag] && r.result === (c.status === 200 ? "ok" : "refused")), `${c.method} ${c.path}: a staff_actions row for ${c.tag} (${JSON.stringify(rows)})`);
      if (c.status === 200 && c.method === "POST") {
        assert.ok(rows.some((r) => r.staff_user_id === p.ids[c.tag] && r.command === `35.12 ${c.command}`), `${c.path}: the row names the bus command with its process (35.7 T10) ${c.command} (${JSON.stringify(rows.map((r) => r.command))})`);
        assert.ok(c.decisions.length >= 1, `${c.path}: an agent_decisions row`); assert.ok(c.decisions.every((d) => d.by === p.ids[c.tag] || d.confirmed_by === p.ids[c.tag] || d.approved_by === p.ids[c.tag]), `${c.path}: the decision names ${c.tag} (${JSON.stringify(c.decisions)})`);
      }
    }
    const confirm = calls.find((c) => c.path === "/ops/api/integrations/switch" && c.tag === "cara")!; assert.deepEqual(confirm.decisions.map((d) => [d.action, d.by, d.confirmed_by]), [["integrations.switch:confirm", p.ids["cid"], p.ids["cara"]]], "the confirmation names both people");
    assert.ok(calls.filter((c) => c.status === 200 && c.method === "POST").length >= 14, `${calls.length} routes driven`); void m1;
  } finally { await w.close(); }
});
