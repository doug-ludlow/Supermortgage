// 23.6 — the emitter's own invariants, beside the golden-file loop in emit.roundtrip.test.ts:
// (1) DU_ENUM_FOR_DATA_POINT (emit.ts) is the generator's DU_DATA_POINT_FOR_ENUM (tools/build-du.mjs) restated, so a
//     change to which enumeration governs a data point fails here rather than drifting silently between the two;
// (2) the sample loader is test-only (23.6 Open question 1): no runtime module under src/ imports it;
// (3) the root attribute set is DI-C01's, verbatim and in its order; (4) money renders as MISMOAmount.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DU_DATA_POINT_FOR_ENUM } from "../../../../tools/build-du.mjs";
import { samplePaths } from "../../../infra/integrations/du-schema/index.ts";
import { DU_ENUM_FOR_DATA_POINT, DU_ROOT_ATTRIBUTES, formatAmountCents } from "./emit.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

test("DU_ENUM_FOR_DATA_POINT restates the generator's DU_DATA_POINT_FOR_ENUM: same enumerations, data points, form fields and exclusions", () => {
  const generator = new Set<string>();
  for (const [enumeration, spec] of Object.entries(DU_DATA_POINT_FOR_ENUM as Record<string, { dataPoints?: { name: string; formFields: string[] }[]; exclude?: string[]; local?: boolean }>)) {
    if (spec.local) continue;
    for (const dp of spec.dataPoints ?? []) generator.add(`${enumeration}|${dp.name}|${dp.formFields.join(",")}|${(spec.exclude ?? []).join(",")}`);
  }
  const emitter = new Set(DU_ENUM_FOR_DATA_POINT.map((r) => `${r.enumeration}|${r.dataPoint}|${r.formFields.join(",")}|${(r.also ?? []).join(",")}`));
  assert.deepEqual([...emitter].sort(), [...generator].sort());
});

test("the sample loader is test-only: no runtime module imports du-sample-loader", () => {
  const importers: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== "node_modules") walk(p); continue; }
      if (!p.endsWith(".ts") || p.endsWith(".test.ts") || p.includes(`${join("underwriting", "fixtures")}${"/"}`)) continue;
      if (/from\s+["'][^"']*du-sample-loader/.test(readFileSync(p, "utf8"))) importers.push(p.slice(ROOT.length + 1));
    }
  };
  walk(join(ROOT, "src"));
  assert.deepEqual(importers, []);
});

test("DU_ROOT_ATTRIBUTES is DI-C01's <MESSAGE> attribute set, verbatim and in order", () => {
  const c01 = samplePaths().find((p) => p.includes("DI-C01_"));
  assert.ok(c01, "DI-C01 is in the corpus");
  const xml = readFileSync(c01!, "utf8");
  const start = xml.indexOf("<MESSAGE ");
  const tag = xml.slice(start + "<MESSAGE ".length, xml.indexOf(">", start));
  const attrs = [...tag.matchAll(/([\w:]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(DU_ROOT_ATTRIBUTES.map(([k, v]) => [k, v]), attrs);
});

test("bigint cents render as MISMOAmount with two places (DI-C08 carries a negative net)", () => {
  assert.equal(formatAmountCents(123456n), "1234.56");
  assert.equal(formatAmountCents(5n), "0.05");
  assert.equal(formatAmountCents(0n), "0.00");
  assert.equal(formatAmountCents(-67800n), "-678.00");
});
