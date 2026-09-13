/**
 * The rules of the current step (docs/ux/17 §3.2, 32.16-T30): the "Business rules and calculations" section of the process the
 * borrower's current journey step belongs to, handed to the model beside the Journey so it knows what the step requires and why —
 * for its understanding, never to be quoted. Worked examples are dropped and every figure is replaced by "[figure]": the model
 * writes no digits (the guard's provenance check), so it is given none to copy. Internal processes (underwriting, fraud, QC) get no
 * text: the model says the file is with underwriting and nothing more (docs/ux/17 §3.5 (5)).
 *
 * Read from spec/sections at first use and cached; the spec is the source of truth and ships in the image for this purpose.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { INTERNAL_PROCESSES } from "./journey.ts";

const SPEC_DIR = fileURLToPath(new URL("../../../../spec/sections", import.meta.url));
/** Longer than this and the model is reading law, not a brief: the section is cut at a paragraph boundary. */
export const RULES_MAX_CHARS = 6000;
const cache = new Map<string, string | null>();

/** The process file for `21.2`: the file named 21-2-… inside the section directory named 21-… under spec/sections, or null. */
export function processFile(processId: string): string | null {
  const [section, n] = processId.split("."); if (!section || !n || !existsSync(SPEC_DIR)) return null;
  const sec = readdirSync(SPEC_DIR).find((d) => d.startsWith(`${section.padStart(2, "0")}-`)); if (!sec) return null;
  const dir = join(SPEC_DIR, sec);
  const file = readdirSync(dir).find((f) => f.startsWith(`${section}-${n}-`) && f.endsWith(".md")); return file ? join(dir, file) : null;
}

/** Figures out, worked examples out, markdown emphasis out: what is left is the rule in words with its citation. */
export function scrubRules(section: string): string {
  // a worked example is dropped whole; a sentence that points at one ("see the worked example", "worked example A") goes too
  const paragraphs = section.split(/\n\s*\n/).filter((p) => !/worked example/i.test(p) || !/^\s*(\*\*)?worked example/i.test(p.trim()) ? !/^\s*(\*\*)?worked example/i.test(p.trim()) : false)
    .map((p) => p.replace(/[^.\n]*worked example[^.\n]*\.?/gi, "").trim()).filter((p) => p.length > 0);
  let text = paragraphs.join("\n\n")
    .replace(/\*\*\$[\d,]+(?:\.\d+)?\*\*/g, "[figure]")
    .replace(/\$[\d,]+(?:\.\d+)?/g, "[figure]")
    .replace(/\b\d+(?:\.\d+)?\s?%/g, "[figure]")
    .replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");
  if (text.length > RULES_MAX_CHARS) { const cut = text.lastIndexOf("\n", RULES_MAX_CHARS); text = `${text.slice(0, cut > 0 ? cut : RULES_MAX_CHARS)}\n…`; }
  return text.trim();
}

/** The scrubbed rules of a process, or null when the process is internal, unknown, or has no rules section. */
export function rulesFor(processId: string | null | undefined): string | null {
  if (!processId || INTERNAL_PROCESSES.has(processId)) return null;
  if (cache.has(processId)) return cache.get(processId) ?? null;
  const file = processFile(processId);
  let out: string | null = null;
  if (file) {
    const md = readFileSync(file, "utf8");
    const m = /#### Business rules and calculations\n([\s\S]*?)(?=\n#### |\n### |$)/.exec(md);
    if (m && m[1]) out = scrubRules(m[1]);
  }
  cache.set(processId, out); return out;
}
