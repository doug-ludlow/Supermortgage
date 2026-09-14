/**
 * The house rules, over the DU generator and the files it writes.
 *
 * Two of them are easy to break in a file this size and invisible in review:
 * American English, and comments that explain themselves to a reader who has
 * only this repository. A comment citing a design, a plan or a commit number
 * points at something nobody can open from here, so it reads as an explanation
 * and carries none.
 *
 * This file is the one place those words are allowed to appear, because it is
 * the file that names them — so it excludes itself from its own scan.
 *
 * Ported from Homestead with its lists cut to the files that exist in this
 * tree: the generator, its type declaration and the two ported suites are the
 * hand-written ones; `writer.ts`, `identity.ts` and their test arrive with
 * Phase 4 and join HAND_WRITTEN then. The six generated tables are scanned for
 * citations only, and arcroles.ts — absent from Homestead's list — is added,
 * because it is generated and its headers are ours in the same way.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** Written by hand, so American English is on us. */
const HAND_WRITTEN = [
  "tools/build-du.mjs",
  "tools/build-du.d.mts",
  "src/domain/underwriting/du/build-du.test.ts",
  "src/domain/underwriting/du/generated.test.ts",
];

/**
 * The generated tables too, for citations only.
 *
 * Their headers are written here and their contents are not: a member name is
 * MISMO's spelling and must survive verbatim, so `PROJECT_ANALYSIS` and
 * `SalesContractAnalysisDescription` are not ours to correct.
 */
const GENERATED = [
  "src/domain/underwriting/du/generated/arcroles.ts",
  "src/domain/underwriting/du/generated/cardinality.ts",
  "src/domain/underwriting/du/generated/conditionality.ts",
  "src/domain/underwriting/du/generated/enums.ts",
  "src/domain/underwriting/du/generated/lengths.ts",
  "src/domain/underwriting/du/generated/order.ts",
];

const BRITISH =
  /\b(modelling|labelled|behaviour|colour|organis(e|ed|ing|ation)|authoris(e|ed|ing|ation)|licence|analys(e|ed|ing)|normalis(e|ed|ing)|serialis(e|ed|ing)|initialis(e|ed|ing)|whilst|centre|recognis(e|ed|ing)|cancelled)\b/i;

/**
 * A citation of something outside the repository.
 *
 * `section N` is deliberately not here: the URLA's own sections are numbered,
 * and TAB_DISAGREEMENTS has to say which one renumbered.
 */
const CITATION = /(\bcommit\s+\d|§|\bthe design\b|\bthe plan\b|\bthe reviewer\b|\bthe critic\b)/i;

function linesOf(relative: string) {
  return readFileSync(resolve(ROOT, relative), "utf8")
    .split("\n")
    .map((text, index) => ({ where: `${relative}:${index + 1}`, text }));
}

describe("house style", () => {
  for (const relative of HAND_WRITTEN) {
    it(`${relative} is in American English`, () => {
      const offenders = linesOf(relative)
        .filter((line) => BRITISH.test(line.text))
        .map((line) => `${line.where} ${line.text.trim()}`);
      assert.deepEqual(offenders, []);
    });
  }

  for (const relative of [...HAND_WRITTEN, ...GENERATED]) {
    it(`${relative} explains itself without citing anything outside this repository`, () => {
      const offenders = linesOf(relative)
        .filter((line) => CITATION.test(line.text))
        .map((line) => `${line.where} ${line.text.trim()}`);
      assert.deepEqual(offenders, []);
    });
  }
});
