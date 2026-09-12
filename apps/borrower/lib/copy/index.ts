/**
 * Typed access to 12-message-copy-library (generated into ./generated.ts) and
 * the token renderer for 01 §7.4. The UI never hard-codes sentences: every
 * borrower-facing string comes through `copy()` / `renderCopy()`.
 */
import { COPY, type CopyEntry, type CopyKey } from "./generated";

export { COPY, COPY_KEY_COUNT } from "./generated";
export type { CopyEntry, CopyKey } from "./generated";

export type TokenValue = string | number | readonly string[];
export type Tokens = Record<string, TokenValue>;

export function isCopyKey(key: string): key is CopyKey {
  return Object.prototype.hasOwnProperty.call(COPY, key);
}

export function copyEntry(key: string): CopyEntry | undefined {
  return isCopyKey(key) ? COPY[key] : undefined;
}

/** The library's markdown emphasis (`*human*`) is a writing convention, not screen text: shown plain, as the API's `copyText` and the SMS/voice renderers do. */
export const stripEmphasis = (text: string): string => text.replace(/\*([^*\n]+)\*/g, "$1");

/**
 * Replace `{{token}}` / `{{token(x)}}` placeholders. A token that appears more than
 * once in the text (`{{money}} … {{money}}`) consumes an array value in order.
 * Unknown tokens are left visible as `{{name}}` so a missing binding is caught in review.
 */
export function renderTemplate(text: string, tokens: Tokens = {}): string {
  const counters = new Map<string, number>();
  return stripEmphasis(text).replace(/\{\{([a-zA-Z0-9_.|]+)(?:\([^)]*\))?\}\}/g, (whole, rawName: string) => {
    // "{{price|requested}}" → first bound alternative
    const names = rawName.split("|");
    for (const name of names) {
      const v = tokens[name];
      if (v === undefined) continue;
      if (Array.isArray(v)) {
        const i = counters.get(name) ?? 0;
        counters.set(name, i + 1);
        return v[Math.min(i, v.length - 1)] ?? whole;
      }
      return String(v);
    }
    return whole;
  });
}

/** Text for a key, with tokens applied. Falls back to the key itself so a wrong key is visible. */
export function copy(key: string, tokens?: Tokens): string {
  const entry = copyEntry(key);
  return entry ? renderTemplate(entry.text, tokens) : key;
}

/** Same as `copy()` but returns undefined for a missing key. */
export function copyOrUndefined(key: string | undefined, tokens?: Tokens): string | undefined {
  if (!key) return undefined;
  const entry = copyEntry(key);
  return entry ? renderTemplate(entry.text, tokens) : undefined;
}

/** Options an entry lists (`A` · `B`), or []. */
export function copyOptions(key: string): readonly string[] {
  return copyEntry(key)?.options ?? [];
}

/** A named extra ("why: …", "helper: …", "footer: …", "what_we_get: …", "fallback: …") with quotes stripped. */
export function copyExtra(key: string, name: string, tokens?: Tokens): string | undefined {
  const entry = copyEntry(key);
  if (!entry) return undefined;
  const prefix = `${name}:`;
  const hit = entry.extras.find((e) => e.startsWith(prefix));
  if (!hit) return undefined;
  const raw = hit.slice(prefix.length).trim().replace(/^"/, "").replace(/"\.?$/, "");
  return renderTemplate(raw, tokens);
}

/** 13 §1 copy tests: forbidden words outside their allowed keys. */
export const FORBIDDEN_WORDS: { word: RegExp; allowedKeyPrefixes: string[] }[] = [
  { word: /guarantee/i, allowedKeyPrefixes: [] },
  { word: /pre-approved/i, allowedKeyPrefixes: ["preapproval."] },
  { word: /you don't qualify/i, allowedKeyPrefixes: [] },
  { word: /\bdenied\b/i, allowedKeyPrefixes: ["decision."] },
  { word: /skip a payment/i, allowedKeyPrefixes: [] },
  { word: /Fannie Mae/, allowedKeyPrefixes: ["boarding.fannie_letter"] },
];
