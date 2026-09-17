/**
 * 35.8 queue pass: one item per source key within a pass (work_items_open_source_idx), and the log names a Postgres error's
 * detail and constraint (the deployed sweep's "work.breaches failed — duplicate key value violates unique constraint
 * work_items_open_source_idx" carried neither, so the key could not be read from the log).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeSources } from "./items.ts";
import { createLogger } from "../../../runtime/log.ts";

test("dedupeSources keeps the first of a repeated source key, drops and names the second, keeps distinct kinds apart", () => {
  const dropped: string[] = [];
  const out = dedupeSources([
    { source_kind: "escalation", source_id: "a", screen_code: "one" },
    { source_kind: "escalation", source_id: "a", screen_code: "two" },
    { source_kind: "breached_timer", source_id: "a", screen_code: "three" },
    { source_kind: "job_dead", source_id: "b", screen_code: "four" },
  ], (d) => dropped.push(`${d.source_kind}:${d.source_id}:${d.screen_code}`));
  assert.deepEqual(out.map((x) => x.screen_code), ["one", "three", "four"]);
  assert.deepEqual(dropped, ["escalation:a:two"]);
  assert.deepEqual(dedupeSources([]), []);
});

test("the JSON log carries a driver error's code, detail, constraint and table beside name, message and stack", () => {
  const lines: string[] = []; const log = createLogger("json", (l) => lines.push(l));
  const e = Object.assign(new Error('duplicate key value violates unique constraint "work_items_open_source_idx"'), { code: "23505", detail: "Key (source_kind, source_id)=(escalation, 1234) already exists.", constraint: "work_items_open_source_idx", table: "work_items", severity: "ERROR" });
  log.error("work.breaches failed", { error: e });
  const row = JSON.parse(lines[0]!) as { error: Record<string, unknown> };
  assert.equal(row.error["code"], "23505"); assert.equal(row.error["detail"], "Key (source_kind, source_id)=(escalation, 1234) already exists."); assert.equal(row.error["constraint"], "work_items_open_source_idx"); assert.equal(row.error["table"], "work_items");
  assert.equal(row.error["message"], e.message); assert.ok(typeof row.error["stack"] === "string"); assert.equal(row.error["severity"], undefined);
  const plainErr = new Error("plain"); log.error("x", { error: plainErr }); const row2 = JSON.parse(lines[1]!) as { error: Record<string, unknown> }; assert.deepEqual(Object.keys(row2.error).sort(), ["message", "name", "stack"]);
});
