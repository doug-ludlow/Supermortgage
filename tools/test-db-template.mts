/**
 * Build the migrated test-database template ONCE per CI job (or once per laptop), so every database-backed
 * suite starts on a clone made in well under a second instead of running db/migrate.sh (137 files, ~30 s)
 * into a fresh database of its own.
 *
 *   TEST_DATABASE_URL=postgresql://sm:sm@localhost:5432/supermortgage_test \
 *     node --experimental-strip-types tools/test-db-template.mts [--prune]
 *
 * `--prune` retires the templates of every other migration set on the server after this one is ready. It is the
 * only thing that ever drops a template: a test process never does, because templates carry no <base> and a
 * second checkout on the same server (a branch with one more migration) would lose its template mid-run. CI
 * runners are ephemeral and never need it; on a laptop the operator prunes when the old ones are in the way.
 *
 * The template itself is src/infra/db/test-db.ts's: `ensureTemplate(adminUrl)` builds `supermortgage_tpl_<hash>`
 * (content-addressed over db/migrations + migrate.sh, under a cluster-wide advisory lock) or finds it with one
 * catalogue query. Suites that call `testDatabase(import.meta.url)` then clone it in their own `before`; this
 * script only front-loads the one slow build so the first suite of a shard does not pay for it inside its
 * timeout, and so the CI log shows the build time on its own line.
 *
 * Bridge, self-retiring: a suite that has not yet moved to testDatabase() still reads `TEST_DATABASE_URL` (and
 * runs db/migrate.sh into it) or its own `X_TEST_DATABASE_URL` with a fixed default database name. For each
 * such variable found in src/**\/*.test.ts this script provisions a clone from the template with lane A's
 * `provisionDatabase` — `<base>` for TEST_DATABASE_URL, `<base>_<x>` for X_TEST_DATABASE_URL — and emits the
 * assignment: appended to $GITHUB_ENV in Actions, and printed to stdout as `export X=…` (so locally
 * `eval "$(node --experimental-strip-types tools/test-db-template.mts)"` sets them; logs go to stderr). With
 * every suite converted the scan finds nothing and the script is just the template build.
 */
import { appendFileSync, globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { adminUrlOf, baseTestDatabaseUrl, ensureTemplate, provisionDatabase, pruneTemplates, withDatabase } from "../src/infra/db/test-db.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const started = Date.now();
const log = (s: string) => console.error(`[test-db-template +${((Date.now() - started) / 1000).toFixed(1)}s] ${s}`);

const base = baseTestDatabaseUrl();
const baseName = new URL(base).pathname.slice(1);
const tpl = await ensureTemplate(adminUrlOf(base));
log(`template ${tpl} ready on ${adminUrlOf(base).replace(/\/\/[^@]*@/, "//…@")}`);
if (process.argv.includes("--prune")) {
  const dropped = await pruneTemplates(adminUrlOf(base));
  log(dropped.length ? `pruned ${dropped.length} stale template(s): ${dropped.join(", ")}` : "no stale template to prune");
}

// The bridge: suites still on the fixed-name pattern.
const direct = new Set<string>();   // files reading TEST_DATABASE_URL themselves (the shared-database pattern)
const suiteVars = new Set<string>();
for (const f of globSync("src/**/*.test.ts", { cwd: root })) {
  const src = readFileSync(`${root}${f}`, "utf8");
  for (const m of src.matchAll(/process\.env\["([A-Z0-9_]+TEST_DATABASE_URL)"\]/g)) {
    if (m[1] === "TEST_DATABASE_URL") direct.add(f); else suiteVars.add(m[1]!);
  }
}
const clones: Array<[db: string, envVar: string | null]> = [];
if (direct.size) clones.push([baseName, null]);
for (const v of [...suiteVars].sort()) clones.push([`${baseName}_${v.replace(/_TEST_DATABASE_URL$/, "").toLowerCase()}`, v]);
const envLines: string[] = [];
for (const [db, envVar] of clones) {
  const t0 = Date.now();
  await provisionDatabase(withDatabase(base, db));
  log(`provisioned ${db} from ${tpl} in ${((Date.now() - t0) / 1000).toFixed(2)}s${envVar ? ` (${envVar})` : ` (${direct.size} suite(s) still read TEST_DATABASE_URL directly)`}`);
  if (envVar) envLines.push(`${envVar}=${withDatabase(base, db)}`);
}
if (envLines.length && process.env["GITHUB_ENV"]) appendFileSync(process.env["GITHUB_ENV"], envLines.map((l) => `${l}\n`).join(""));
for (const l of envLines) console.log(`export ${l}`);
log(clones.length ? `${clones.length} bridge clone(s) for suites not yet on testDatabase(); the rest clone the template themselves` : "every suite provisions its own database from the template; nothing else to do");
