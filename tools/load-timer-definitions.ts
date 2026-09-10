/**
 * Load spec/registry/timers.json into `timer_definitions` (migration 0026).
 *   DATABASE_URL=… node --experimental-strip-types tools/load-timer-definitions.ts
 * Idempotent: rows are upserted by code; the registry hash records the source file.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { connect } from "../src/infra/db/client.ts";
import { loadRegistry } from "../src/kernel/timers/registry.ts";

const raw = readFileSync(new URL("../spec/registry/timers.json", import.meta.url), "utf8");
const hash = createHash("sha256").update(raw).digest("hex");
const reg = loadRegistry();
const unit = (kind: string): string => ({ step: "calendar_days", calendar_day: "calendar_days", window: "calendar_days", same_day: "same_day", next_business_day: "business_days_servicer", recurring: "recurring", until: "evaluator", evaluator: "evaluator", prose: "prose", none: "prose" }[kind] ?? "prose");
const db = connect(process.env.DATABASE_URL ?? "postgresql://sm:sm@localhost/supermortgage");
let n = 0;
for (const t of reg.unique()) {
  const u = /business_days_federal/.test(t.offset) ? "business_days_federal" : /business_days_fannie_et/.test(t.offset) ? "business_days_fannie_et" : /business_days_servicer/.test(t.offset) ? "business_days_servicer" : /banking/.test(t.offset) ? "banking_days" : /\bhours?\b/.test(t.offset) ? "hours" : /\bminutes?\b/.test(t.offset) ? "minutes" : /\bmonths?\b/.test(t.offset) ? "months" : /\byears?\b/.test(t.offset) ? "years" : unit(t.offsetParsed.kind);
  await db.query(`INSERT INTO timer_definitions (code, section, process, kind, trigger_text, anchor_text, offset_text, satisfied_text, breach_text, unit, registry_hash)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (code) DO UPDATE SET section=$2, process=$3, kind=$4, trigger_text=$5, anchor_text=$6, offset_text=$7, satisfied_text=$8, breach_text=$9, unit=$10, registry_hash=$11, loaded_at=now()`,
    [t.code, t.section, t.process, t.kind, t.trigger, t.anchor, t.offset, t.satisfied, t.breach, u, hash]);
  n++;
}
console.log(`timer_definitions: ${n} rows (registry ${hash.slice(0, 12)})`);
await db.end();
