/**
 * §35.11 rule 11 — the persisted count (`npm run test:persisted`): `count(*)` per manifest table on a database migrated to the newest
 * file (the post-migrate baseline) and on each journey file's own database after it ran (src/infra/db/test-db.ts naming from
 * TEST_DATABASE_URL, default postgresql://sm:sm@localhost/supermortgage_test), under the journey lock; the two tables in a measurement
 * database provisioned for the run, `docs/audit/persisted.json` (AUDIT_DIR overrides the directory) and `audit.persisted.run_completed`.
 * Run it after the journey files (`REQUIRE_DB=1 node --test --experimental-strip-types src/runtime/lifecycle.test.ts
 * src/runtime/purchase-lifecycle.test.ts src/domain/operations-runtime/35-{5,6,9,10}.spec.test.ts`): the declarations in
 * src/domain/operations-runtime/stewardship-35-11/journeys.ts name what each step writes.
 *   PERSISTED_JOURNEYS   a comma list of journey basenames (default: every declaration)
 */
import { randomUUID } from "node:crypto";
import { connect } from "../src/infra/db/client.ts";
import { execFileSync } from "node:child_process";
import { baseTestDatabaseUrl, ensureTemplate, adminUrlOf, provisionDatabase, withDatabase } from "../src/infra/db/test-db.ts";
import { Runtime } from "../src/runtime/app.ts";
import { loadOverriddenRegistry } from "../src/domain/timer-overrides.ts";
import { createLogger } from "../src/runtime/log.ts";
import { JOURNEY_WRITES } from "../src/domain/operations-runtime/stewardship-35-11/journeys.ts";

const base = baseTestDatabaseUrl();
const names = (process.env["PERSISTED_JOURNEYS"] ?? JOURNEY_WRITES.map((j) => j.name).join(",")).split(",").map((s) => s.trim()).filter(Boolean);
// the measurement database keeps every run's persisted_measurement_runs / persisted_measurements rows (rule 11's evidence): provisioned from the migrated template once, migrated forward by db/migrate.sh, never dropped
const measureUrl = process.env["MEASURE_DATABASE_URL"] ?? withDatabase(base, `${new URL(base).pathname.replace(/^\//, "")}_measure`);
await ensureTemplate(adminUrlOf(base));
{ const admin = connect(adminUrlOf(base)); const exists = (await admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_database WHERE datname = $1`, [new URL(measureUrl).pathname.replace(/^\//, "")]))[0]!.n !== "0"; await admin.end(); if (!exists) await provisionDatabase(measureUrl); else execFileSync(new URL("../db/migrate.sh", import.meta.url).pathname, { env: { ...process.env, DATABASE_URL: measureUrl }, stdio: "ignore" }); }
void randomUUID;
const db = connect(measureUrl);
const logger = createLogger("json", (line) => { if (/error/i.test(line)) process.stderr.write(line + "\n"); });
const runtime = new Runtime({ db, registry: loadOverriddenRegistry(), logger, environment: "nonprod", env: { INTEGRATIONS: "fake" } as NodeJS.ProcessEnv, reviewers: null });
let code = 0;
try {
  const r = await runtime.execute({ process: "35.11", name: "audit.persisted.count", loanId: "", actor: { kind: "agent", id: "qc-audit" }, input: { journeys: names, base_url: base, audit_dir: process.env["AUDIT_DIR"] ?? null } });
  const o = r.output as Record<string, unknown>;
  process.stdout.write(`persisted count ${String(o["outcome"])}: ${String(o["tables_with_rows"])} persisted of ${String(o["tables_total"])} manifest tables; sections complete ${JSON.stringify(o["sections_complete"])} of measured ${JSON.stringify(o["sections_measured"])}; journeys ${JSON.stringify(o["journey_databases"])} (migration ${String(o["migration_head"])})\n`);
  const untouched = (o["untouched_expected"] as { table: string; expected_by: string }[] | undefined) ?? [];
  for (const u of untouched) process.stdout.write(`  expected but untouched: ${u.table} ← ${u.expected_by}\n`);
  if (o["outcome"] !== "completed") { process.stdout.write(`  failure: ${String(o["failure"])}\n`); code = 1; }
} catch (e) { process.stderr.write(`persisted count failed: ${e instanceof Error ? e.message : String(e)}\n`); code = 1; }
finally { await db.end().catch(() => undefined); }
process.exit(code);
