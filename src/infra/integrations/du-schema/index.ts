/**
 * The vendored DU schema chain, the eighteen shipped samples, and the one
 * thing you can do with them.
 *
 * Nothing here is derived or generated. `xsd/` and `samples/` are somebody
 * else's bytes, copied in and never edited — README.md says which bytes, from
 * where, and what the assembly traps are. This module is only the paths and a
 * validator, so that schema.test.ts here, the emitter's golden-file loop in
 * `src/domain/underwriting/du` and the FAKE DU port in
 * `src/infra/integrations/du.ts` reach the chain the same way.
 *
 * Read README.md before trusting a green result. The XSD enforces element
 * order, enumerated values and boolean casing, and essentially nothing about
 * the relationship graph: a dangling `xlink:to`, a duplicate label, an invented
 * arcrole, five borrowers and a deleted `RELATIONSHIPS` container all validate.
 * Schema validity is a lint. The gate is 23.7's preflight and our database.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * This directory. Node 22 runs the `.ts` source in place, so there is no
 * `dist/` to be one level below and `xsd/` and `samples/` sit beside this
 * file — `PACKAGE_ROOT` is the directory the module is in, not its parent.
 */
const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url));

/** The nine XSDs, flat, because the imports between them name no directory. */
export const XSD_DIR = join(PACKAGE_ROOT, "xsd");

/**
 * The entry point of the chain.
 *
 * `DU_Wrapper_3.4.0_B324.xsd` and not `MISMO_3.4.0_B324.xsd`: the wrapper is
 * what redefines fourteen MISMO extension types into their DU forms, and
 * validating against MISMO alone accepts a document DU would reject.
 */
export const DU_WRAPPER_XSD = join(XSD_DIR, "DU_Wrapper_3.4.0_B324.xsd");

/** Fannie Mae's own test-case suite, verbatim, filenames and all. */
export const SAMPLES_DIR = join(PACKAGE_ROOT, "samples");

/** Every sample, absolute, in filename order. */
export function samplePaths(): string[] {
  return readdirSync(SAMPLES_DIR)
    .filter((name) => name.endsWith(".xml"))
    .sort()
    .map((name) => join(SAMPLES_DIR, name));
}

/**
 * Validate one document against the chain. Empty means it validated.
 *
 * `xmllint` rather than a library, and the choice is worth stating because it
 * looks like the lazy one. There is no XML schema validator in this repository's
 * dependency tree and no small one to add: compiling a 6.9M XSD with 3,228
 * complex types is libxml2's job, and the JavaScript packages that do it are
 * either native bindings to that same library or many megabytes of their own.
 * `xmllint` ships with macOS and with every Linux image this repo builds on
 * (`libxml2-utils` in the Dockerfile and the CI job), so shelling out costs
 * nothing and adds nothing to what everybody installs.
 *
 * A missing `xmllint` throws rather than returning "valid". A validator that
 * reports success when it did not run is worse than no validator, because the
 * green tick is the whole of what anyone reads.
 */
export function xmllintErrors(file: string): string[] {
  const result = spawnSync("xmllint", ["--noout", "--schema", DU_WRAPPER_XSD, file], {
    encoding: "utf8",
  });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
    throw new Error(
      "xmllint is not on PATH, so the DU schema chain cannot be checked.\n" +
        "  macOS ships it; on Debian and Ubuntu it is the libxml2-utils package.",
    );
  }
  if (result.error) throw result.error;
  if (result.status === 0) return [];
  const errors = result.stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.endsWith(" validates"));
  if (errors.length === 0) {
    throw new Error(
      `xmllint ended with ${result.signal ? `signal ${result.signal}` : `status ${result.status}`} and no diagnostics, so the DU schema chain was not checked.`,
    );
  }
  return errors;
}

/**
 * `xmllintErrors` over bytes in memory — the emitted document as 23.6 hands it
 * to the port, not a file on disk. The bytes go to a private temporary file
 * for the length of one `xmllint` run and nowhere else; the FAKE DU port
 * (`../du.ts`) validates every submission this way before it answers, so a
 * FAKE run exercises the same chain a real Direct Integration adapter would
 * be refused by.
 */
export function xmllintErrorsOf(bytes: Uint8Array | string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "du-xmllint-"));
  try {
    const file = join(dir, "document.xml");
    writeFileSync(file, bytes);
    // The diagnostics name the file by its path; the temporary directory is nobody's evidence, so they name `document.xml`.
    return xmllintErrors(file).map((line) => line.split(file).join("document.xml"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
