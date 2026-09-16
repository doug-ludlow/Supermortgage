/**
 * §35.11 rules 10–13 — the audit's two execution columns (spec/sections/35-operations-runtime/35-11-*.md):
 *   hosted     `runHostedProbe`: every `ALL_TOOLS` pair posted with `{}` over HTTP to the hosted API as its own agent under a service
 *              principal (35.7), against the probe's own database (dropped, created and migrated to the newest file under db/migrations)
 *              or the deployed nonprod origin — never production (PROBE_NEVER_PRODUCTION). Status per pair: executed (2xx),
 *              refused_typed (a 4xx carrying the bus's typed code — CommandRefused, RoleDenied, a guard, the staff-only door — whose unit of
 *              work rolled back), not_wired (501 PortUnavailable), errored (500, a 400 whose reason is a TypeError-shaped message, or a
 *              door refusal — a principal or token problem can never fill the column). One `hosted_probe_runs` row in the probe database,
 *              `docs/audit/hosted.json`, `audit.hosted.run_completed` (the weekly clock's receipt).
 *   persisted  `runPersistedCount`: `count(*)` per manifest table on a database migrated to the newest file (the post-migrate baseline,
 *              seeded rows included) and again on each journey file's own database after it ran, under the journey lock; delta,
 *              verdict, `expected` from the journeys' declared writes (journeys.ts), `sections_complete`; two tables, `docs/audit/persisted.json`,
 *              `audit.persisted.run_completed`.
 * Both event types are string literals here (tools/lint-emission.ts). Counts are bigint. A failed run writes its row with the results so
 * far and emits nothing (the audit treats it as not measured).
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Clock } from "../../kernel/events/index.ts";
import { FixedClock, systemClock } from "../../kernel/events/index.ts";
import { connect, type Db, type Queryable } from "../../infra/db/client.ts";
import { adminUrlOf, baseTestDatabaseUrl, dropDatabase, ensureTemplate, provisionDatabase, testDatabaseName, withDatabase } from "../../infra/db/test-db.ts";
import { acquireJourneyLock } from "../../infra/db/test-lock.ts";
import { ALL_TOOLS } from "../../app/tools/index.ts";
import { loadAgentsFile } from "../../app/agents.ts";
import { Runtime } from "../../runtime/app.ts";
import { createApiServer, listen } from "../../runtime/server.ts";
import { createLogger, type Logger } from "../../runtime/log.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import { JOURNEY_WRITES, type JourneyDeclaration } from "./stewardship-35-11/journeys.ts";
import { ET, canonicalJson, isProduction, type Row } from "./stewardship-35-11/types.ts";

export const EV_HOSTED = "audit.hosted.run_completed";
export const EV_PERSISTED = "audit.persisted.run_completed";
export const PROBE_ENVIRONMENT = "probe";
export const DEFAULT_PROBE_DATABASE_URL = "postgresql://sm:sm@localhost/supermortgage_probe";
/** The service keys rule 13 names as the expected `not_wired` findings (the unit harness's misses; the hosted runtime wires them all). */
export const NOT_WIRED_SERVICE_KEYS: readonly string[] = ["boarding", "orig-boarding", "tolerance-21-5"];
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export function newestMigration(): string { return readdirSync(join(ROOT, "db/migrations")).filter((f) => f.endsWith(".sql")).sort().at(-1) ?? ""; }
export function gitSha(): string { try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(); } catch { return process.env["GITHUB_SHA"] ?? "unknown"; } }
export function auditDir(override?: string | null): string { return override ?? process.env["AUDIT_DIR"] ?? join(ROOT, "docs/audit"); }
const dbName = (url: string): string => new URL(url).pathname.replace(/^\//, "");

// ---------------------------------------------------------------- the hosted probe (rule 10)
export type ProbeStatus = "executed" | "refused_typed" | "not_wired" | "errored";
export interface ProbeResult { readonly process: string; readonly name: string; readonly agent: string; readonly status: ProbeStatus; readonly code: string | null; readonly http_status: number; readonly duration_ms: number }
export interface HostedProbeRun {
  readonly run_id: string; readonly target: "probe" | "deployed"; readonly database_name: string; readonly base_url: string; readonly migration_head: string; readonly git_sha: string;
  readonly started_at: string; readonly finished_at: string; readonly outcome: "completed" | "failed"; readonly failure: string | null; readonly as_of_date: string;
  readonly tools_total: number; readonly executed: number; readonly refused_typed: number; readonly not_wired: number; readonly errored: number; readonly results: readonly ProbeResult[]; readonly sha256: string;
  /** Rule 13's finding: the `not_wired` results outside the three service keys' tools (expected empty), and whether any result was a door refusal (expected none). */
  readonly not_wired_unexpected: readonly string[]; readonly door_refusals: readonly string[];
}
const DOOR_CODES = /^(PRINCIPAL_|NO_SELF_ASSERTED_ACTOR|SHARED_TOKEN_|APPROVER_)/;
const TYPE_ERROR_RE = /Cannot read|is not a function|is not iterable|Cannot convert|is not defined|Cannot destructure|Unexpected token|Unexpected end of JSON|undefined to object|null to object/;
/** Rule 10's status per reply: the body is read for its code and reason only — never stored. */
export function classifyReply(status: number, body: Row): { status: ProbeStatus; code: string | null } {
  const code = typeof body["code"] === "string" ? body["code"] : null; const error = typeof body["error"] === "string" ? body["error"] : null; const reason = typeof body["reason"] === "string" ? body["reason"] : "";
  if (status >= 200 && status < 300) return { status: "executed", code: null };
  if (status === 501) return { status: "not_wired", code: reason.replace(/^integration port /, "").slice(0, 120) || "not_wired" };
  if (status >= 500) return { status: "errored", code: error ?? `http_${status}` };
  if (code && DOOR_CODES.test(code)) return { status: "errored", code: `door:${code}` };
  if (status === 400) return TYPE_ERROR_RE.test(reason) ? { status: "errored", code: "type_error" } : { status: "refused_typed", code: code ?? "BAD_REQUEST" };
  if (code) return { status: "refused_typed", code };
  if (error === "role_denied" || error === "refused") return { status: "refused_typed", code: error.toUpperCase() };
  return { status: "errored", code: error ?? `http_${status}` };
}
const isOrigination = (process: string): boolean => { const n = Number(process.split(".")[0]); return n >= 20 && n <= 31; };
export const toolPath = (process: string, name: string, loanId: string, applicationId: string): string => (isOrigination(process) ? `/v1/applications/${applicationId}/tools/${encodeURIComponent(process)}/${encodeURIComponent(name)}` : `/v1/loans/${loanId}/tools/${encodeURIComponent(process)}/${encodeURIComponent(name)}`);
/** The tools each service key's misses would name (rule 13): the pairs whose section files call `service(rt, "<key>")`. */
export function serviceKeyTools(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const dir = join(ROOT, "src/app/tools");
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
    const txt = readFileSync(join(dir, f), "utf8");
    for (const key of NOT_WIRED_SERVICE_KEYS) if (txt.includes(`"${key}"`)) { const procs = [...txt.matchAll(/defineTools\("([\d.]+)"/g)].map((m) => m[1]!); for (const p of procs) out.set(key, [...(out.get(key) ?? []), p]); }
  }
  return out;
}

export interface HostedProbeInput {
  readonly target: "probe" | "deployed";
  /** probe: the probe database (PROBE_DATABASE_URL); dropped and created from the migrated template. */
  readonly databaseUrl?: string | null;
  /** deployed: the API's origin (PROBE_BASE_URL / infra's api_hostname), the probe loan and application, the service principal token(s). */
  readonly baseUrl?: string | null; readonly loanId?: string | null; readonly applicationId?: string | null; readonly tokens?: Readonly<Record<string, string>> | string | null;
  readonly environment?: string | null;
  readonly auditDir?: string | null; readonly writeAuditFile?: boolean;
  readonly clock?: Clock; readonly logger?: Logger; readonly perCallTimeoutMs?: number;
  /** A hook run once before the pairs are posted (T15: the probe database's row counts around one call). */
  readonly onReady?: (ctx: { readonly base: string; readonly db: Db | null; readonly tokenFor: (agent: string) => string; readonly loanId: string; readonly applicationId: string }) => Promise<void>;
  /** T15: make one pair answer 500 (the run must count it `errored`). */
  readonly breakTool?: { readonly process: string; readonly name: string } | null;
  /** A test aid: post only these pairs (a full run posts every ALL_TOOLS pair; hosted.json is never written from a partial run). */
  readonly only?: readonly { readonly process: string; readonly name: string }[] | null;
}
/** Run the probe. Never against production: the input's environment or a production origin refuses before anything is provisioned. */
export async function runHostedProbe(i: HostedProbeInput): Promise<HostedProbeRun> {
  if (isProduction(i.environment ?? undefined) || /\bprod(uction)?\b/i.test(i.baseUrl ?? "")) throw new RangeError("PROBE_NEVER_PRODUCTION: the probe runs against its own database or the deployed nonprod environment, never production");
  const clock = i.clock ?? systemClock; const logger = i.logger ?? createLogger("json", () => undefined);
  const run_id = randomUUID(); const started_at = clock.now(); const migration_head = newestMigration(); const git_sha = gitSha();
  const as_of_date = wallClock(Date.parse(started_at), ET).date;
  const results: ProbeResult[] = []; let failure: string | null = null;
  let db: Db | null = null; let server: ReturnType<typeof createApiServer> | null = null; let runtime: Runtime | null = null;
  let base = i.baseUrl ?? "local"; let loanId = i.loanId ?? ""; let applicationId = i.applicationId ?? ""; let database_name = i.target === "probe" ? dbName(i.databaseUrl ?? DEFAULT_PROBE_DATABASE_URL) : "deployed";
  const tokens = new Map<string, string>(); let sharedToken: string | null = null;
  const tokenFor = (agent: string): string => tokens.get(agent) ?? sharedToken ?? "";
  const post = async (path: string, token: string, body: unknown): Promise<{ status: number; body: Row }> => {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), i.perCallTimeoutMs ?? 20_000);
    try { const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: ac.signal }); const text = await r.text(); let parsed: Row = {}; try { parsed = text ? (JSON.parse(text) as Row) : {}; } catch { parsed = { error: "not_json" }; } return { status: r.status, body: parsed }; }
    finally { clearTimeout(t); }
  };
  try {
    if (i.target === "probe") {
      const url = i.databaseUrl ?? DEFAULT_PROBE_DATABASE_URL; database_name = dbName(url);
      // dropped and created from the template db/migrate.sh built (= migrated to the newest file under db/migrations)
      await ensureTemplate(adminUrlOf(url)); await provisionDatabase(url);
      db = connect(url);
      const head = (await db.query<{ v: string }>(`SELECT version AS v FROM schema_migrations ORDER BY version DESC LIMIT 1`))[0]?.v ?? "";
      if (`${head}.sql` !== migration_head) throw new Error(`probe database migrated to ${head}, newest file ${migration_head}`);
      sharedToken = `probe-${randomUUID()}`;
      // databaseUrl: the probe database's own connection string — 35.3's planner lock (`cycles.plan`, and 35.5's cashiering unit through it) takes a dedicated session on it, as main.ts hands the hosted runtime config.databaseUrl; absent, those tools would answer 501 not_wired (35.3 D12) outside rule 13's three keys
      runtime = new Runtime({ db, databaseUrl: url, registry: loadOverriddenRegistry(), clock, logger, environment: PROBE_ENVIRONMENT, env: { INTEGRATIONS: "fake", ENVIRONMENT: PROBE_ENVIRONMENT } as NodeJS.ProcessEnv, reviewers: null, instanceId: `probe:${run_id.slice(0, 8)}` });
      if (i.breakTool) { const def = ALL_TOOLS.find((t) => t.process === i.breakTool!.process && t.name === i.breakTool!.name); if (def) (runtime as unknown as { tools: Map<string, unknown> }).tools.set(`${def.process} ${def.name}`, { ...def, handler: () => { throw new Error("T15: a tool that answers 500"); } }); }
      server = createApiServer({ runtime, apiToken: sharedToken, logger, console: false });
      base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
      // the seed: one loan through POST /v1/transfers/batches (the demo batch, the route's own fallback actor) and one application through POST /v1/applications
      const boarded = await post("/v1/transfers/batches/demo", sharedToken, {});
      if (boarded.status !== 200) throw new Error(`seed loan refused: ${boarded.status} ${String(boarded.body["code"] ?? boarded.body["error"] ?? "")}`);
      loanId = (await db.query<{ id: string }>(`SELECT id::text AS id FROM loans ORDER BY created_at, id LIMIT 1`))[0]?.id ?? "";
      if (!loanId) throw new Error("seed loan refused: no loans row after the demo batch");
      const party = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id) VALUES ('servicer', 'Probe Partner Bank', '123456789', '1000123') RETURNING id::text AS id`))[0]!.id;
      const app = await post("/v1/applications", sharedToken, { actor: { kind: "agent", id: "intake" }, application: { partner_party_id: party, channel: "organic", transaction_type: "purchase", occupancy: "primary", borrowers: [{ legal_name: "Probe Fixture" }] } });
      applicationId = String(((app.body["application"] as Row | undefined) ?? {})["id"] ?? "");
      if (app.status !== 200 || !applicationId) throw new Error(`seed application refused: ${app.status} ${String(app.body["code"] ?? app.body["error"] ?? "")}`);
      // one service principal per bus agent (35.7): the door resolves each to its agent actor — every request leaves a staff_actions{surface: v1, principal_id} row
      const adminId = (await db.query<{ id: string }>(`INSERT INTO staff_users (email_hash, email_encrypted, legal_name, roles, status, enrolled_at) VALUES ($1, '\\x00'::bytea, 'Probe Admin', '{admin}', 'active', now()) RETURNING id::text AS id`, [sha256(`probe-admin-${run_id}`)]))[0]!.id;
      const agents = loadAgentsFile().agents;
      const expires_at = new Date(Date.parse(clock.now()) + 2 * 86_400_000).toISOString();
      for (const agent of new Set(ALL_TOOLS.map((t) => t.agent))) {
        const procs = agents.find((a) => a.agent === agent)?.processes ?? [];
        const r = await runtime.execute({ process: "35.7", name: "principals.issue", loanId: "", actor: { kind: "human", id: adminId, role: "admin" }, input: { kind: "service", name: agent, scopes: { loans: "all", applications: "all", processes: [...new Set([...procs, ...ALL_TOOLS.filter((t) => t.agent === agent).map((t) => t.process)])] }, expires_at, environment: PROBE_ENVIRONMENT } });
        tokens.set(agent, String((r.output as Row)["token"]));
      }
    } else {
      if (!i.baseUrl) throw new RangeError("target: deployed needs base_url (the deployed API's origin)");
      if (!loanId || !applicationId) throw new RangeError("target: deployed needs loan_id and application_id (the environment's probe loan and application, seeded by seed-demo)");
      if (typeof i.tokens === "string") sharedToken = i.tokens; else for (const [k, v] of Object.entries(i.tokens ?? {})) tokens.set(k, v);
      if (!sharedToken && !tokens.size) throw new RangeError("target: deployed needs a service principal token (PROBE_TOKEN or PROBE_TOKENS)");
      const health = await fetch(`${base}/healthz`).then((r) => r.status).catch(() => 0);
      if (health !== 200) throw new Error(`unreachable: ${base}/healthz answered ${health}`);
    }
    if (i.onReady) await i.onReady({ base, db, tokenFor, loanId, applicationId });
    const pairs = [...ALL_TOOLS].filter((t) => !i.only || i.only.some((o) => o.process === t.process && o.name === t.name)).sort((a, b) => a.process.localeCompare(b.process, undefined, { numeric: true }) || a.name.localeCompare(b.name));
    for (const t of pairs) {
      const t0 = Date.now();
      const r = await post(toolPath(t.process, t.name, loanId, applicationId), tokenFor(t.agent), { input: {} }).catch((e: unknown) => ({ status: 0, body: { error: "transport", reason: e instanceof Error ? e.message : String(e) } as Row }));
      const c = r.status === 0 ? { status: "errored" as const, code: `transport:${String(r.body["reason"]).slice(0, 80)}` } : classifyReply(r.status, r.body);
      results.push({ process: t.process, name: t.name, agent: t.agent, status: c.status, code: c.code, http_status: r.status, duration_ms: Date.now() - t0 });
    }
  } catch (e) { failure = e instanceof Error ? e.message : String(e); logger.error("hosted probe failed", { run_id, target: i.target, error: failure }); }
  const finished_at = clock.now();
  const count = (st: ProbeStatus): number => results.filter((r) => r.status === st).length;
  const keyTools = serviceKeyTools(); const expectedNotWired = new Set([...keyTools.values()].flat());
  const run: HostedProbeRun = { run_id, target: i.target, database_name, base_url: i.target === "probe" ? "local" : base, migration_head, git_sha, started_at, finished_at, outcome: failure ? "failed" : "completed", failure, as_of_date,
    tools_total: results.length, executed: count("executed"), refused_typed: count("refused_typed"), not_wired: count("not_wired"), errored: count("errored"), results,
    sha256: sha256(canonicalJson(results)), not_wired_unexpected: results.filter((r) => r.status === "not_wired" && !expectedNotWired.has(r.process)).map((r) => `${r.process} ${r.name}`), door_refusals: results.filter((r) => (r.code ?? "").startsWith("door:")).map((r) => `${r.process} ${r.name}: ${r.code}`) };
  // the row in the probe database (a failed run keeps its results so far and emits nothing) and the receipt
  if (db && runtime) {
    try {
      await recordHostedRun(db, run);
      if (!failure) await runtime.uow.run({}, (ctx) => ctx.events.append({ type: EV_HOSTED, aggregate: { kind: "hosted_probe", id: run.target }, actor: { kind: "agent", id: "qc-audit" }, payload: hostedPayload(run) }), { clock });
    } catch (e) { logger.error("hosted probe: the row or the receipt failed", { run_id, error: e }); }
  }
  if (server) await new Promise<void>((resolve) => { server!.closeAllConnections?.(); server!.close(() => resolve()); });
  if (db) await db.end().catch(() => undefined);
  if (!failure && i.writeAuditFile !== false && !i.only) writeHostedJson(run, i.auditDir);
  return run;
}
export const hostedPayload = (run: HostedProbeRun): Row => ({ run_id: run.run_id, target: run.target, database_name: run.database_name, migration_head: run.migration_head, git_sha: run.git_sha, tools_total: run.tools_total, executed: run.executed, refused_typed: run.refused_typed, not_wired: run.not_wired, errored: run.errored, as_of_date: run.as_of_date, sha256: run.sha256 });
export async function recordHostedRun(q: Queryable, run: HostedProbeRun): Promise<void> {
  await q.query(`INSERT INTO hosted_probe_runs (id, target, database_name, base_url, migration_head, git_sha, started_at, finished_at, outcome, failure, tools_total, executed, refused_typed, not_wired, errored, results, sha256) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17) ON CONFLICT (id) DO NOTHING`,
    [run.run_id, run.target, run.database_name, run.base_url, run.migration_head, run.git_sha, run.started_at, run.finished_at, run.outcome, run.failure, run.tools_total, run.executed, run.refused_typed, run.not_wired, run.errored, JSON.stringify(run.results), run.sha256]);
}
export function writeHostedJson(run: HostedProbeRun, dir?: string | null): string {
  const d = auditDir(dir); mkdirSync(d, { recursive: true });
  const file = join(d, "hosted.json");
  writeFileSync(file, JSON.stringify({ run_id: run.run_id, target: run.target, database_name: run.database_name, migration_head: run.migration_head, git_sha: run.git_sha, as_of_date: run.as_of_date, tools_total: run.tools_total, executed: run.executed, refused_typed: run.refused_typed, not_wired: run.not_wired, errored: run.errored, results: run.results.map((r) => ({ process: r.process, name: r.name, status: r.status, code: r.code })) }, null, 1) + "\n");
  return file;
}
export async function latestHostedRun(q: Queryable, run_id?: string | null): Promise<Row | null> {
  const rows = run_id ? await q.query<Row>(`SELECT id::text AS run_id, target, database_name, base_url, migration_head, git_sha, started_at::text AS started_at, finished_at::text AS finished_at, outcome, failure, tools_total, executed, refused_typed, not_wired, errored, results, sha256 FROM hosted_probe_runs WHERE id = $1::uuid`, [run_id])
    : await q.query<Row>(`SELECT id::text AS run_id, target, database_name, base_url, migration_head, git_sha, started_at::text AS started_at, finished_at::text AS finished_at, outcome, failure, tools_total, executed, refused_typed, not_wired, errored, results, sha256 FROM hosted_probe_runs ORDER BY started_at DESC, id DESC LIMIT 1`);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------- the persisted count (rule 11)
export type Verdict = "persisted" | "untouched" | "seeded_only" | "missing_ddl";
export interface Measurement { readonly section: number; readonly process: string; readonly table_name: string; readonly post_migrate_count: bigint; readonly after_journey_count: bigint; readonly delta: bigint; readonly expected: boolean; readonly expected_by: string | null; readonly verdict: Verdict }
export interface PersistedRun {
  readonly run_id: string; readonly database_name: string; readonly migration_head: string; readonly git_sha: string; readonly journeys: readonly string[]; readonly journey_databases: readonly { name: string; database: string; present: boolean }[];
  readonly post_migrate_at: string; readonly measured_at: string; readonly outcome: "completed" | "failed"; readonly failure: string | null; readonly as_of_date: string;
  readonly tables_total: number; readonly tables_with_rows: number; readonly sections_complete: readonly number[]; readonly sections_measured: readonly number[]; readonly sections_gaps: Readonly<Record<string, number>>; readonly untouched_expected: readonly { table: string; expected_by: string }[]; readonly projection_gaps: number; readonly measurements: readonly Measurement[]; readonly sha256: string;
}
interface ManifestRow { process: string; tables: string[] }
/** The manifest's tables (one row each, the lowest-numbered owning process) plus the kernel's own baseline tables (db/migrations/0001_baseline.sql: loan_events, timers, ledger_entries, ledger_lines, agent_decisions, … — no process's Data model names them, every journey writes them), as section 0 / process `kernel`. */
export function manifestTables(): { section: number; process: string; table: string }[] {
  const m = JSON.parse(readFileSync(join(ROOT, "spec/registry/manifest.json"), "utf8")) as ManifestRow[];
  const seen = new Set<string>(); const out: { section: number; process: string; table: string }[] = [];
  for (const p of m) for (const t of p.tables) { if (seen.has(t)) continue; seen.add(t); out.push({ section: Number(p.process.split(".")[0]), process: p.process, table: t }); }
  for (const t of readFileSync(join(ROOT, "db/migrations/0001_baseline.sql"), "utf8").matchAll(/^CREATE TABLE\s+(\w+)/gm)) { const name = t[1]!; if (seen.has(name) || name === "schema_migrations") continue; seen.add(name); out.push({ section: 0, process: "kernel", table: name }); }
  return out;
}
function findFile(dir: string, basename: string): string | null {
  for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) { const r = findFile(p, basename); if (r) return r; } else if (f === basename) return p; }
  return null;
}
/** The harness database a journey file ran on (src/infra/db/test-db.ts naming), from its basename. */
export function journeyDatabaseUrl(name: string, base: string = baseTestDatabaseUrl()): string | null {
  const file = findFile(join(ROOT, "src"), name); if (!file) return null;
  return withDatabase(base, testDatabaseName(pathToFileURL(file).href, { base }));
}
async function countTables(q: Queryable, tables: readonly string[]): Promise<Map<string, bigint | null>> {
  // a manifest "table" is a table, a view or a materialized view (tools/audit.py's `created` counts CREATE TABLE|VIEW|MATERIALIZED VIEW) in public or restricted_fl (19.x's restricted schema); counted schema-qualified, absent → null (missing_ddl)
  const present = new Map((await q.query<{ t: string; s: string }>(`SELECT c.relname AS t, n.nspname AS s FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('public', 'restricted_fl') AND c.relkind IN ('r', 'p', 'v', 'm') ORDER BY (n.nspname = 'public') DESC`)).map((r) => [r.t, r.s] as const));
  const out = new Map<string, bigint | null>();
  for (const t of tables) { const s = present.get(t); if (!s || !/^[a-z_][a-z0-9_]*$/.test(t)) { out.set(t, null); continue; } const [r] = await q.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${s}.${t}`); out.set(t, BigInt(r?.n ?? "0")); }
  return out;
}
export interface PersistedInput { readonly journeys?: readonly JourneyDeclaration[] | readonly string[] | null; /** counts every journey on this database (a test's own) unless a declaration names its own */ readonly databaseUrl?: string | null; readonly baseUrl?: string | null; readonly auditDir?: string | null; readonly writeAuditFile?: boolean; readonly clock?: Clock; readonly logger?: Logger; readonly takeLock?: boolean }
export async function runPersistedCount(i: PersistedInput = {}): Promise<PersistedRun> {
  const clock = i.clock ?? systemClock; const logger = i.logger ?? createLogger("json", () => undefined);
  const base = i.baseUrl ?? baseTestDatabaseUrl();
  const decls: JourneyDeclaration[] = (i.journeys ?? JOURNEY_WRITES).map((j) => (typeof j === "string" ? (JOURNEY_WRITES.find((d) => d.name === j) ?? { name: j, steps: [] }) : j));
  const run_id = randomUUID(); const migration_head = newestMigration(); const git_sha = gitSha(); const as_of_date = wallClock(Date.parse(clock.now()), ET).date;
  const tables = manifestTables(); const names = tables.map((t) => t.table);
  let failure: string | null = null; let postAt = clock.now(); let post = new Map<string, bigint | null>(); const after = new Map<string, bigint>(); let gaps = 0n; const gapsBy = new Map<string, bigint>();
  const journeyDbs: { name: string; database: string; present: boolean }[] = [];
  const lock = i.takeLock === false ? null : await acquireJourneyLock(base).catch(() => null);
  const measureUrl = withDatabase(base, `${dbName(base)}_measure_${run_id.slice(0, 8)}`);
  try {
    // the post-migrate baseline: a fresh database from the migrated template, counted immediately after db/migrate.sh's schema
    await ensureTemplate(adminUrlOf(base)); await provisionDatabase(measureUrl); postAt = clock.now();
    const m = connect(measureUrl); try { post = await countTables(m, names); } finally { await m.end(); }
    const admin = connect(adminUrlOf(base));
    try { for (const d of decls) {
      const url = d.database_url ?? i.databaseUrl ?? journeyDatabaseUrl(d.name, base);
      if (!url) { journeyDbs.push({ name: d.name, database: "", present: false }); continue; }
      const exists = (await admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_database WHERE datname = $1`, [dbName(url)]).catch(() => [{ n: "0" }]))[0]!.n !== "0";
      journeyDbs.push({ name: d.name, database: dbName(url), present: exists });
      if (!exists) continue;
      const c = connect(url);
      try {
        const counts = await countTables(c, names);
        for (const [t, n] of counts) if (n !== null) after.set(t, (after.get(t) ?? 0n) + n);
        const g = (await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM projection_gaps`).catch(() => [{ n: "0" }]))[0]!.n; gaps += BigInt(g); gapsBy.set(d.name, BigInt(g));
      } finally { await c.end(); }
    } } finally { await admin.end().catch(() => undefined); }
  } catch (e) { failure = e instanceof Error ? e.message : String(e); logger.error("persisted count failed", { run_id, error: failure }); }
  finally { await dropDatabase(measureUrl).catch(() => undefined); await lock?.release().catch(() => undefined); }
  // a journey's databases share the template: an `after` count exists for every present table; the sum of the journeys' rows minus the baseline once per journey
  const presentJourneys = journeyDbs.filter((j) => j.present).length;
  // `expected` comes from the journeys that ran (their database is present); an absent journey's declarations measure nothing (open question 4: not measured, never failed)
  const ran = new Set(journeyDbs.filter((j) => j.present).map((j) => j.name));
  const expectedBy = new Map<string, string>();
  for (const d of decls) { if (!ran.has(d.name)) continue; for (const st of d.steps) for (const t of st.writes) if (!expectedBy.has(t)) expectedBy.set(t, `${d.name}:${st.step}`); }
  const measurements: Measurement[] = tables.map((t) => {
    const pm = post.get(t.table) ?? null;
    if (pm === null) return { section: t.section, process: t.process, table_name: t.table, post_migrate_count: 0n, after_journey_count: 0n, delta: 0n, expected: expectedBy.has(t.table), expected_by: expectedBy.get(t.table) ?? null, verdict: "missing_ddl" as const };
    const aj = presentJourneys ? (after.get(t.table) ?? 0n) : pm * BigInt(presentJourneys || 1);
    const delta = presentJourneys ? aj - pm * BigInt(presentJourneys) : 0n;
    const verdict: Verdict = delta > 0n ? "persisted" : pm > 0n ? "seeded_only" : "untouched";
    return { section: t.section, process: t.process, table_name: t.table, post_migrate_count: pm, after_journey_count: presentJourneys ? aj : pm, delta, expected: expectedBy.has(t.table), expected_by: expectedBy.get(t.table) ?? null, verdict };
  });
  const sectionsMeasured = [...new Set(measurements.filter((m) => m.expected).map((m) => m.section))].sort((a, b) => a - b);
  // a section's projection gaps are the gaps of the journeys that declare its tables (the run that should have projected them)
  const sectionOf = new Map(tables.map((t) => [t.table, t.section] as const));
  const gapsOfSection = (s: number): bigint => decls.filter((d) => ran.has(d.name) && d.steps.some((st) => st.writes.some((w) => sectionOf.get(w) === s))).reduce((n, d) => n + (gapsBy.get(d.name) ?? 0n), 0n);
  const sectionsComplete = sectionsMeasured.filter((s) => gapsOfSection(s) === 0n && measurements.filter((m) => m.section === s && m.expected).every((m) => m.verdict === "persisted"));
  const untouched = measurements.filter((m) => m.expected && m.verdict === "untouched").map((m) => ({ table: m.table_name, expected_by: m.expected_by ?? "" }));
  const run: PersistedRun = { run_id, database_name: dbName(base), migration_head, git_sha, journeys: decls.map((d) => d.name), journey_databases: journeyDbs, post_migrate_at: postAt, measured_at: clock.now(), outcome: failure ? "failed" : "completed", failure, as_of_date,
    tables_total: measurements.length, tables_with_rows: measurements.filter((m) => m.verdict === "persisted").length, sections_complete: sectionsComplete, sections_measured: sectionsMeasured, sections_gaps: Object.fromEntries(sectionsMeasured.map((s) => [String(s), Number(gapsOfSection(s))])), untouched_expected: untouched, projection_gaps: Number(gaps), measurements, sha256: sha256(canonicalJson(measurements.map((m) => ({ t: m.table_name, p: m.post_migrate_count, a: m.after_journey_count, v: m.verdict })))) };
  if (!failure && i.writeAuditFile !== false) writePersistedJson(run, i.auditDir);
  return run;
}
export const persistedPayload = (run: PersistedRun): Row => ({ run_id: run.run_id, database_name: run.database_name, migration_head: run.migration_head, git_sha: run.git_sha, journeys: run.journeys, tables_total: run.tables_total, tables_with_rows: run.tables_with_rows, sections_complete: run.sections_complete, as_of_date: run.as_of_date, sha256: run.sha256 });
export async function recordPersistedRun(q: Queryable, run: PersistedRun): Promise<void> {
  await q.query(`INSERT INTO persisted_measurement_runs (id, database_name, migration_head, git_sha, journeys, post_migrate_at, measured_at, outcome, tables_total, tables_with_rows, sections_complete, sha256) VALUES ($1, $2, $3, $4, $5::text[], $6::timestamptz, $7::timestamptz, $8, $9, $10, $11::int[], $12)`,
    [run.run_id, run.database_name, run.migration_head, run.git_sha, run.journeys, run.post_migrate_at, run.measured_at, run.outcome, run.tables_total, run.tables_with_rows, run.sections_complete, run.sha256]);
  for (const m of run.measurements) await q.query(`INSERT INTO persisted_measurements (run_id, section, process, table_name, post_migrate_count, after_journey_count, delta, expected, expected_by, verdict) VALUES ($1, $2, $3, $4, $5::bigint, $6::bigint, $7::bigint, $8, $9, $10)`, [run.run_id, m.section, m.process, m.table_name, m.post_migrate_count.toString(), m.after_journey_count.toString(), m.delta.toString(), m.expected, m.expected_by, m.verdict]);
}
export function writePersistedJson(run: PersistedRun, dir?: string | null): string {
  const d = auditDir(dir); mkdirSync(d, { recursive: true });
  const file = join(d, "persisted.json");
  writeFileSync(file, JSON.stringify({ run_id: run.run_id, database_name: run.database_name, migration_head: run.migration_head, git_sha: run.git_sha, as_of_date: run.as_of_date, journeys: run.journeys, journey_databases: run.journey_databases, tables_total: run.tables_total, tables_with_rows: run.tables_with_rows, sections_complete: run.sections_complete, sections_measured: run.sections_measured, untouched_expected: run.untouched_expected, projection_gaps: run.projection_gaps, tables: run.measurements.map((m) => ({ section: m.section, process: m.process, table: m.table_name, post_migrate: m.post_migrate_count.toString(), after: m.after_journey_count.toString(), delta: m.delta.toString(), expected: m.expected, verdict: m.verdict })) }, null, 1) + "\n");
  return file;
}
export const auditFileExists = (name: "hosted.json" | "persisted.json", dir?: string | null): boolean => existsSync(join(auditDir(dir), name));
export { FixedClock };
