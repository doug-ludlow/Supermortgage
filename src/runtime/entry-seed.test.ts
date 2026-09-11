// The 32.14 demo seed (src/runtime/entry-seed.ts) on its own database: idempotent, opens the demo states for 31.1, gives the
// partner an NMLSR ID and an active FAKE rate sheet. Uses a dedicated database so its global rows never reach the shared suites
// (skipped when it is not reachable — it is not a spec unit).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { connect, reachable, type Db } from "../infra/db/index.ts";
import { FixedClock } from "../kernel/events/index.ts";
import { loadOverriddenRegistry } from "../domain/timer-overrides.ts";
import { Runtime } from "./app.ts";
import { seedEntryDemo, FAKE_PARTNER_NMLSR_ID } from "./entry-seed.ts";

const DB_URL = process.env["ENTRY_SEED_TEST_DATABASE_URL"] ?? "postgresql://sm:sm@localhost/supermortgage_entry_seed";
const up = await reachable(DB_URL);
const skip = up ? false : `no Postgres at ${DB_URL}`;
let db: Db; let runtime: Runtime;
test.before(async () => {
  if (skip) return;
  // a fresh database every run (the seed is idempotent, and the test asserts what the FIRST run writes)
  const name = new URL(DB_URL).pathname.slice(1); const admin = new URL(DB_URL); admin.pathname = "/postgres";
  const a = connect(admin.toString()); await a.query(`DROP DATABASE IF EXISTS ${name}`); await a.query(`CREATE DATABASE ${name}`); await a.end();
  execFileSync(fileURLToPath(new URL("../../db/migrate.sh", import.meta.url)), { env: { ...process.env, DATABASE_URL: DB_URL }, stdio: "pipe" });
  db = connect(DB_URL);
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock: new FixedClock("2025-01-10T15:00:00.000Z") });
});
test.after(async () => { if (!skip) await db.end(); });

test("entry seed: readiness rows, partner NMLSR ID and a FAKE rate sheet, idempotent on a second run", { skip }, async () => {
  const first = await seedEntryDemo(runtime, { states: ["AZ", "CO"] });
  assert.ok(first.partner_id, JSON.stringify(first)); assert.ok(first.written.includes("partners/" + first.partner_id), JSON.stringify(first));
  assert.ok(first.written.includes("licenses/L-AZ-PARTNER") && first.written.includes("license_requirements/R-CO-sm-processing_underwriting_entity") && first.written.includes("mlo_roster/M-FAKE-DEMO"));
  assert.equal(first.rate_sheet_published, true); assert.match(String(first.rate_sheet_id), /^rs-FAKE-demo-/);
  const second = await seedEntryDemo(runtime, { states: ["AZ", "CO"] });
  assert.deepEqual(second.written, []); assert.equal(second.rate_sheet_published, false); assert.equal(second.rate_sheet_id, first.rate_sheet_id);
  // 31.1 answers open for a seeded state and closed for one without rows; the partner row carries the NMLSR ID the 20.2 checklist needs
  const az = await runtime.execute({ process: "31.1", name: "nmls.sync", loanId: "", actor: { kind: "agent", id: "compliance-sentinel" }, input: { op: "readiness", state: "AZ" } });
  assert.equal((az.output as { open: boolean }).open, true, JSON.stringify(az.output));
  const ny = await runtime.execute({ process: "31.1", name: "nmls.sync", loanId: "", actor: { kind: "agent", id: "compliance-sentinel" }, input: { op: "readiness", state: "NY" } });
  assert.equal((ny.output as { open: boolean }).open, false);
  const partner = await db.query<{ data: { nmlsr_id: string } }>(`SELECT data FROM entity_current WHERE kind = 'partners' AND id = $1`, [first.partner_id]);
  assert.equal(partner[0]?.data.nmlsr_id, FAKE_PARTNER_NMLSR_ID);
});
