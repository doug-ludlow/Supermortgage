// 23.6 Business rule 7 — the golden-file loop: a sample loaded into a graph, re-emitted, validated against the
// vendored chain and diffed against itself container by container, arc by arc. `roundTripTests` registers one
// node:test per sample name, so the next stage runs any sample by name (`roundTripTests(sampleNames())` is T1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { xmllintErrors } from "../../../infra/integrations/du-schema/index.ts";
import { assembleDuDocument, type DuDocument } from "./emit.ts";
import { diffDuDocument, loadSample, type DuDiff, type LoadedSample } from "../fixtures/du-sample-loader.ts";

export interface RoundTrip { readonly sample: LoadedSample; readonly document: DuDocument; readonly diff: DuDiff; readonly lint: string[] }

/** Load, emit, lint (xmllint against DU_Wrapper_3.4.0_B324.xsd) and diff one sample. */
export function roundTrip(name: string): RoundTrip {
  const sample = loadSample(name);
  const document = assembleDuDocument(sample.graph, sample.casefile, sample.submission);
  const dir = mkdtempSync(join(tmpdir(), "du-roundtrip-"));
  let lint: string[];
  try {
    const file = join(dir, `${name}.xml`);
    writeFileSync(file, document.bytes);
    lint = xmllintErrors(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { sample, document, diff: diffDuDocument(document.bytes, sample.xml), lint };
}

/** One test per sample: the emitted document validates, and matches the sample after label normalization. */
export function roundTripTests(names: readonly string[]): void {
  for (const name of names) {
    test(`round trip ${name}: loaded into a graph, re-emitted, it validates and matches the sample container for container and arc for arc`, () => {
      const rt = roundTrip(name);
      assert.deepEqual(rt.lint, [], `xmllint on the emitted ${name}`);
      assert.ok(rt.diff.equal, `${name} differs at ${rt.diff.xpath}: ${rt.diff.detail}`);
      assert.equal(rt.document.stats.relationship_count + rt.document.stats.disputed_arcs_skipped, rt.sample.graph.arcs.length);
      assert.equal(rt.document.stats.container_count, rt.sample.graph.containers.length);
    });
  }
}

roundTripTests(["DI-C09", "DI-C01", "DI-C03", "DI-C02", "DI-C05", "DI-C04", "DI-C07", "DI-C06", "DI-C08", "DI-CL01", "DI-FHA01", "DI-FHA04", "DI-VA02", "DI-FHA02", "DI-FHA03", "DI-VA01", "DI-VA03", "DI-VA04"]);
