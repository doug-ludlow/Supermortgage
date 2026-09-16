/**
 * The database test harness: one call gives a `node:test` file its own Postgres database, freshly created from a
 * migrated TEMPLATE, so the whole suite runs concurrently with zero shared state and no file ever runs
 * db/migrate.sh itself.
 *
 *   const { url: DB_URL, skip } = await testDatabase(import.meta.url);
 *
 * - The per-file database is named from the file's path under src/ (stable across machines and worktrees, ≤ 63
 *   chars, lowercase): `<base>_t_<8 hex of the checkout root + the path under src/>_<dir>_<file>`, e.g. `supermortgage_t_1f2e3d4c_underwriting_23_6_spec`.
 *   `<base>` is the database named by TEST_DATABASE_URL (default postgresql://sm:sm@localhost/supermortgage_test)
 *   with a trailing `_test` dropped, so two checkouts sharing one server keep apart by pointing TEST_DATABASE_URL at
 *   different names; the URL's host and credentials are what every connection uses.
 * - The template is content-addressed: `supermortgage_tpl_<12 hex>` over the db/migrations file list, their contents
 *   and migrate.sh. It is built once — CREATE DATABASE, db/migrate.sh, then renamed into place — under a session
 *   advisory lock on the maintenance database (`postgres`), so parallel test workers never race to build it, and every
 *   later call finds it with one catalogue query. No connection to the template is ever held: `CREATE DATABASE …
 *   TEMPLATE` refuses while one is open.
 * - A test process never drops a template. Templates carry no `<base>`, so two checkouts on one server whose
 *   migration sets differ share the catalogue, and a build here that retired "the others" would pull the template out
 *   from under the other checkout mid-run (CREATE DATABASE … TEMPLATE then fails with 3D000, which nobody retries).
 *   Stale templates are retired only by `pruneTemplates`, run on request: `tools/test-db-template.mts --prune`.
 * - The skip semantics are the ones every suite had: the server unreachable → `skip` carries "no Postgres at …" for
 *   the `{ skip }` option, unless REQUIRE_DB is set, in which case the call throws and the file fails.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { reachable } from "./client.ts";

export const DEFAULT_TEST_DATABASE_URL = "postgresql://sm:sm@localhost/supermortgage_test";
/** The advisory-lock key the template build is serialised under (cluster-wide; test-lock.ts's journey key is 32_001). */
export const TEMPLATE_LOCK_KEY = 32_002;
export const TEMPLATE_PREFIX = "supermortgage_tpl_";
const MAX_NAME = 63;

const MIGRATE_SH = fileURLToPath(new URL("../../../db/migrate.sh", import.meta.url));
const MIGRATIONS_DIR = fileURLToPath(new URL("../../../db/migrations", import.meta.url));

export interface TestDatabase {
  /** The connection string of this file's own database. */
  readonly url: string;
  readonly name: string;
  /** The maintenance database (`postgres`) on the same server, for DROP / CREATE DATABASE. */
  readonly adminUrl: string;
  /** `false` when the database is there to use; otherwise the reason to pass as `{ skip }`. */
  readonly skip: false | string;
  /** Drops the database (WITH (FORCE)); optional — the next run drops and recreates it anyway. */
  close(): Promise<void>;
}

export interface TestDatabaseOptions {
  /** Appended to the derived name (e.g. `_eval` for a database the eval harness insists must look disposable). */
  readonly suffix?: string;
  /** `false`: create the database empty (template1) instead of from the migrated template — for a suite that stages migrations itself. */
  readonly template?: boolean;
  /** `false`: derive the name and probe the server only; the caller (a fixture such as openRefiBook) provisions the database. */
  readonly provision?: boolean;
}

const sanitize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** `postgresql://…/<db>` → the same server's maintenance database. */
export function adminUrlOf(url: string): string { const u = new URL(url); u.pathname = "/postgres"; return u.toString(); }
export function withDatabase(url: string, name: string): string { const u = new URL(url); u.pathname = `/${name}`; return u.toString(); }
export const baseTestDatabaseUrl = (): string => process.env["TEST_DATABASE_URL"] ?? DEFAULT_TEST_DATABASE_URL;

/** The per-file database name: stable, lowercase, ≤ 63 chars, unique per test file. */
export function testDatabaseName(fileUrl: string, opts: { suffix?: string; base?: string } = {}): string {
  const path = fileUrl.startsWith("file:") ? fileURLToPath(fileUrl) : fileUrl;
  const i = path.lastIndexOf("/src/");
  const rel = i >= 0 ? path.slice(i + 1) : path;
  // the hash covers the checkout root too (the prefix before /src/), so the same file in two worktrees on one server never shares a clone
  const hash = createHash("sha256").update(`${i >= 0 ? path.slice(0, i) : ""}|${rel}`).digest("hex").slice(0, 8);
  const parts = rel.split("/");
  const file = (parts[parts.length - 1] ?? "").replace(/\.test\.(ts|js|mts|mjs)$/, "");
  const dir = parts.length >= 2 ? parts[parts.length - 2]! : "";
  let label = sanitize(dir && dir !== "src" ? `${dir}_${file}` : file);
  const suffix = sanitize(opts.suffix ?? "") ? `_${sanitize(opts.suffix ?? "")}` : "";
  let base = sanitize(new URL(opts.base ?? baseTestDatabaseUrl()).pathname.slice(1).replace(/_test$/, "") || "supermortgage");
  const fixed = `_t_${hash}_`.length + suffix.length;
  if (base.length > 24) base = base.slice(0, 24);
  const room = MAX_NAME - fixed - base.length;
  if (label.length > room) label = label.slice(0, room).replace(/_+$/, "");
  return `${base}_t_${hash}_${label}${suffix}`;
}

/** The content hash of the migrations (names, contents and migrate.sh): the template's identity. */
export function migrationsHash(): string {
  const h = createHash("sha256");
  h.update(readFileSync(MIGRATE_SH));
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) { h.update(f); h.update("\0"); h.update(readFileSync(`${MIGRATIONS_DIR}/${f}`)); h.update("\0"); }
  return h.digest("hex").slice(0, 12);
}
export const templateName = (): string => `${TEMPLATE_PREFIX}${migrationsHash()}`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const sqlError = (e: unknown): { code?: string; message: string } => e as { code?: string; message: string };
/** 55006 object_in_use: "source database is being accessed by other users" / "is being accessed by other users". */
const inUse = (e: unknown): boolean => sqlError(e).code === "55006" || /being accessed by other users/.test(sqlError(e).message ?? "");

async function retryInUse<T>(fn: () => Promise<T>, deadlineMs = 20_000): Promise<T> {
  const until = Date.now() + deadlineMs;
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (e) { if (!inUse(e) || Date.now() > until) throw e; await sleep(Math.min(1000, 100 * (attempt + 1))); }
  }
}

async function adminClient(adminUrl: string): Promise<pg.Client> { const c = new pg.Client({ connectionString: adminUrl }); await c.connect(); return c; }

const templates = new Map<string, Promise<string>>();

/**
 * The migrated template on the server behind `adminUrl`, built if it is missing: returns its name. Serialised under
 * the advisory lock so concurrent workers build it once; memoised per process.
 */
export function ensureTemplate(adminUrl: string): Promise<string> {
  let p = templates.get(adminUrl);
  if (!p) { p = buildTemplate(adminUrl); templates.set(adminUrl, p); p.catch(() => templates.delete(adminUrl)); }
  return p;
}

async function buildTemplate(adminUrl: string): Promise<string> {
  const tpl = templateName();
  const c = await adminClient(adminUrl);
  try {
    // cheap path first: no lock when it is already there
    if ((await c.query("SELECT 1 FROM pg_database WHERE datname = $1", [tpl])).rowCount) return tpl;
    await c.query("SELECT pg_advisory_lock($1)", [TEMPLATE_LOCK_KEY]);
    try {
      if ((await c.query("SELECT 1 FROM pg_database WHERE datname = $1", [tpl])).rowCount) return tpl;
      const build = `${tpl}_build`;
      const started = Date.now();
      await c.query(`DROP DATABASE IF EXISTS ${build} WITH (FORCE)`);
      await c.query(`CREATE DATABASE ${build}`);
      const out = execFileSync(MIGRATE_SH, { env: { ...process.env, DATABASE_URL: withDatabase(adminUrl, build) }, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
      await retryInUse(() => c.query(`ALTER DATABASE ${build} RENAME TO ${tpl}`));
      const applied = out.split("\n").filter((l) => l.startsWith("apply ")).length;
      process.stderr.write(`test-db: built template ${tpl} — ${applied} migrations applied in ${Date.now() - started} ms\n${out}`);
      return tpl;
    } finally { await c.query("SELECT pg_advisory_unlock($1)", [TEMPLATE_LOCK_KEY]).catch(() => undefined); }
  } finally { await c.end().catch(() => undefined); }
}

/**
 * Retires every `supermortgage_tpl_*` on the server except the current migration set's template (and its in-progress
 * `_build`): returns the names dropped. Never called from a test process — see the module comment; the operator (or an
 * ephemeral CI runner that has no reason to) runs `tools/test-db-template.mts --prune`. A template a concurrent run is
 * cloning at that moment is in use (55006) and stays.
 */
export async function pruneTemplates(adminUrl: string): Promise<string[]> {
  const tpl = templateName();
  const c = await adminClient(adminUrl);
  const dropped: string[] = [];
  try {
    const stale = await c.query<{ datname: string }>("SELECT datname FROM pg_database WHERE datname LIKE $1 AND datname <> $2 AND datname <> $3 ORDER BY datname", [`${TEMPLATE_PREFIX}%`, tpl, `${tpl}_build`]);
    for (const { datname } of stale.rows) {
      const ok = await c.query(`DROP DATABASE IF EXISTS ${datname}`).then(() => true, (e: unknown) => { if (inUse(e)) return false; throw e; });
      if (ok) dropped.push(datname);
    }
  } finally { await c.end().catch(() => undefined); }
  return dropped;
}

/**
 * Drops and recreates the database named by `url` from the migrated template (or empty with `template: false`).
 * Sub-second; retries briefly while the template is being accessed by another creator.
 */
export async function provisionDatabase(url: string, opts: { template?: boolean } = {}): Promise<void> {
  const name = new URL(url).pathname.slice(1);
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`test-db: "${name}" is not a safe database name`);
  const adminUrl = adminUrlOf(url);
  const tpl = opts.template === false ? null : await ensureTemplate(adminUrl);
  const c = await adminClient(adminUrl);
  try {
    await retryInUse(() => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    await retryInUse(() => c.query(tpl ? `CREATE DATABASE ${name} TEMPLATE ${tpl}` : `CREATE DATABASE ${name}`));
  } finally { await c.end().catch(() => undefined); }
}

export async function dropDatabase(url: string): Promise<void> {
  const name = new URL(url).pathname.slice(1);
  const c = await adminClient(adminUrlOf(url));
  try { await retryInUse(() => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)); } finally { await c.end().catch(() => undefined); }
}

/** A test file's own, freshly migrated database — see the module comment. Call once, at the top of the file. */
export async function testDatabase(fileUrl: string, opts: TestDatabaseOptions = {}): Promise<TestDatabase> {
  const base = baseTestDatabaseUrl();
  const name = testDatabaseName(fileUrl, opts.suffix !== undefined ? { suffix: opts.suffix, base } : { base });
  const url = withDatabase(base, name);
  const adminUrl = adminUrlOf(base);
  const up = await reachable(adminUrl);
  if (!up && process.env["REQUIRE_DB"]) throw new Error(`REQUIRE_DB set but ${adminUrl} is not reachable`);
  const skip = up ? false : `no Postgres at ${adminUrl}`;
  if (!skip && opts.provision !== false) await provisionDatabase(url, opts.template === false ? { template: false } : {});
  return { url, name, adminUrl, skip, close: async () => { if (!skip) await dropDatabase(url).catch(() => undefined); } };
}
