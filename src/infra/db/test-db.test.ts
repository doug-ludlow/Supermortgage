/**
 * The database test harness itself (src/infra/db/test-db.ts): the per-file names it derives, the content-addressed
 * template it builds once, the clones it hands out, and the skip-or-throw semantics every suite relies on. The
 * pure parts run everywhere; the database parts skip without Postgres like every other suite.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { connect } from "./client.ts";
import { TEMPLATE_PREFIX, adminUrlOf, migrationsHash, templateName, testDatabase, testDatabaseName, withDatabase } from "./test-db.ts";
import { acquireJourneyLock } from "./test-lock.ts";

const own = await testDatabase(import.meta.url);
const { skip } = own;

test("test-db: the per-file name is stable, lowercase, ≤ 63 chars, unique per path, and carries the base database's name", () => {
  const a = testDatabaseName("file:///anywhere/src/domain/underwriting/23-6.spec.test.ts");
  assert.equal(a, testDatabaseName("file:///anywhere/src/domain/underwriting/23-6.spec.test.ts"), "the same file in the same checkout names the same database on every run");
  assert.notEqual(a, testDatabaseName("file:///elsewhere/src/domain/underwriting/23-6.spec.test.ts"), "the same path under src/ in another checkout (a worktree on the same server) names a different database, so concurrent runs never share a clone");
  assert.match(a, /^supermortgage_t_[0-9a-f]{8}_underwriting_23_6_spec$/);
  assert.notEqual(a, testDatabaseName("file:///x/src/domain/underwriting/23-7.spec.test.ts"));
  assert.notEqual(testDatabaseName("file:///x/src/a/db.test.ts"), testDatabaseName("file:///x/src/b/db.test.ts"), "two files of one name in different directories differ (the hash is over the path)");
  const long = testDatabaseName("file:///x/src/domain/some-very-long-directory-name-indeed/an-extremely-long-file-name-that-goes-on-and-on.spec.test.ts", { base: "postgresql://sm:sm@localhost/supermortgage_a_rather_long_base_name_test", suffix: "_t21_eval" });
  assert.ok(long.length <= 63, `${long} (${long.length})`); assert.match(long, /^[a-z0-9_]+_t21_eval$/);
  assert.match(testDatabaseName("file:///x/src/domain/borrower/eval/runner.test.ts", { suffix: "_eval", base: "postgresql://sm:sm@localhost/supermortgage_test" }), /^supermortgage_t_[0-9a-f]{8}_eval_runner_eval$/);
  assert.equal(testDatabaseName("file:///x/src/runtime/runtime.test.ts", { base: "postgresql://sm:sm@localhost:5432/supermortgage_ci" }).split("_t_")[0], "supermortgage_ci", "TEST_DATABASE_URL's database name (less a trailing _test) prefixes every per-file name, so two checkouts on one server keep apart");
  assert.equal(withDatabase("postgresql://u:p@host:5433/whatever?sslmode=disable", "x_y"), "postgresql://u:p@host:5433/x_y?sslmode=disable");
  assert.equal(adminUrlOf("postgresql://u:p@host:5433/whatever"), "postgresql://u:p@host:5433/postgres");
});

test("test-db: the template is content-addressed over db/migrations and migrate.sh", () => {
  assert.match(migrationsHash(), /^[0-9a-f]{12}$/); assert.equal(migrationsHash(), migrationsHash());
  assert.equal(templateName(), `${TEMPLATE_PREFIX}${migrationsHash()}`);
});

test("test-db: a suite's database is a clone of the migrated template — every migration recorded, the template on the server, no connection held to it", { skip }, async () => {
  const db = connect(own.url);
  try {
    const [m] = await db.query<{ c: bigint }>(`SELECT count(*)::bigint AS c FROM schema_migrations`);
    assert.ok(m!.c >= 138n, `${m!.c} migrations applied`);
    assert.equal((await db.query<{ n: string }>(`SELECT current_database() AS n`))[0]!.n, own.name);
    const [tpl] = await db.query<{ datname: string; conns: bigint }>(`SELECT d.datname, (SELECT count(*)::bigint FROM pg_stat_activity a WHERE a.datname = d.datname) AS conns FROM pg_database d WHERE d.datname = $1`, [templateName()]);
    assert.ok(tpl, `the template ${templateName()} exists`); assert.equal(tpl!.conns, 0n, "nothing stays connected to the template (CREATE DATABASE … TEMPLATE would refuse)");
  } finally { await db.end(); }
});

test("test-db: a second call for another file gets its own database, sub-second, and a repeat call recreates it empty", { skip }, async () => {
  const other = await testDatabase("file:///x/src/infra/db/test-db.other.test.ts");
  try {
    assert.notEqual(other.name, own.name);
    const started = Date.now();
    const db = connect(other.url);
    await db.query(`INSERT INTO parties (party_type, legal_name) VALUES ('servicer', 'FAKE test-db')`);
    assert.equal((await db.query<{ c: bigint }>(`SELECT count(*)::bigint AS c FROM parties WHERE legal_name = 'FAKE test-db'`))[0]!.c, 1n);
    await db.end();
    const again = await testDatabase("file:///x/src/infra/db/test-db.other.test.ts");
    assert.equal(again.name, other.name);
    const db2 = connect(again.url);
    assert.equal((await db2.query<{ c: bigint }>(`SELECT count(*)::bigint AS c FROM parties WHERE legal_name = 'FAKE test-db'`))[0]!.c, 0n, "recreated from the template: the earlier run's rows are gone");
    await db2.end();
    assert.ok(Date.now() - started < 30_000, `two clones in ${Date.now() - started} ms`);
  } finally { await other.close(); }
  const c = new pg.Client({ connectionString: adminUrlOf(other.url) }); await c.connect();
  try { assert.equal((await c.query("SELECT 1 FROM pg_database WHERE datname = $1", [other.name])).rowCount, 0, "close() drops the database"); } finally { await c.end(); }
});

test("test-db: a file's clone is dropped when its process ends without close() — nothing left on the server after a run; KEEP_TEST_DB=1 keeps it", { skip }, async () => {
  const { spawnSync } = await import("node:child_process");
  const fileUrl = "file:///x/src/infra/db/test-db.hook-probe.test.ts";
  const name = testDatabaseName(fileUrl);   // the child names it from TEST_DATABASE_URL (or the default) exactly as this call does
  const child = (env: Record<string, string>): string => {
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `import { testDatabase } from ${JSON.stringify(new URL("./test-db.ts", import.meta.url).href)}; const t = await testDatabase(${JSON.stringify(fileUrl)}); process.stdout.write(t.name);`], { env: { ...process.env, ...env }, encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const c = new pg.Client({ connectionString: adminUrlOf(own.url) }); await c.connect();
  try {
    assert.equal(child({}), name);
    assert.equal((await c.query("SELECT 1 FROM pg_database WHERE datname = $1", [name])).rowCount, 0, "dropped on beforeExit");
    assert.equal(child({ KEEP_TEST_DB: "1" }), name);
    assert.equal((await c.query("SELECT 1 FROM pg_database WHERE datname = $1", [name])).rowCount, 1, "kept under KEEP_TEST_DB");
    await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally { await c.end(); }
});

test("test-db: an unreachable server skips with 'no Postgres at …', and throws instead under REQUIRE_DB", async () => {
  const saved = { url: process.env["TEST_DATABASE_URL"], req: process.env["REQUIRE_DB"] };
  process.env["TEST_DATABASE_URL"] = "postgresql://sm:sm@127.0.0.1:1/supermortgage_test"; delete process.env["REQUIRE_DB"];
  try {
    const t = await testDatabase("file:///x/src/infra/db/nowhere.test.ts");
    assert.equal(t.skip, "no Postgres at postgresql://sm:sm@127.0.0.1:1/postgres");
    process.env["REQUIRE_DB"] = "1";
    await assert.rejects(testDatabase("file:///x/src/infra/db/nowhere.test.ts"), /REQUIRE_DB set but postgresql:\/\/sm:sm@127\.0\.0\.1:1\/postgres is not reachable/);
  } finally {
    if (saved.url === undefined) delete process.env["TEST_DATABASE_URL"]; else process.env["TEST_DATABASE_URL"] = saved.url;
    if (saved.req === undefined) delete process.env["REQUIRE_DB"]; else process.env["REQUIRE_DB"] = saved.req;
  }
});

test("test-lock: a lock taken through a file's own clone is held on the maintenance database, so two suites on different clones contend for one lock", { skip }, async () => {
  const KEY = 32_999;   // a key no suite uses; the browser suites may be holding 32_003 while this runs
  const held = await acquireJourneyLock(own.url, KEY);
  const other = new pg.Client({ connectionString: withDatabase(own.url, "postgres") }); await other.connect();
  try {
    assert.equal((await other.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [KEY])).rows[0]!.ok, false, "the maintenance database sees the lock — advisory locks are per database, and the clone's would serialise nothing");
    await held.release();
    assert.equal((await other.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [KEY])).rows[0]!.ok, true, "released");
    await other.query("SELECT pg_advisory_unlock($1)", [KEY]);
  } finally { await other.end(); }
});
