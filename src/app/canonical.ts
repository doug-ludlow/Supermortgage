/**
 * Canonical JSON and its sha-256 — the one serialisation the command bus hashes into `agent_decisions.inputs_snapshot_hash`
 * for every decision (35.8 rule 3: "the canonical JSON the tool will receive (derived fields plus decision fields, keys
 * sorted, cents as strings) is hashed and stored … `work_derivations.input_sha256` is what the tool's
 * `agent_decisions.inputs_snapshot_hash` must equal"). Keys sorted at every depth, bigint as its decimal string,
 * `undefined` members dropped, Dates as ISO strings; arrays keep their order.
 */
import { createHash } from "node:crypto";

export function canonicalJson(v: unknown): string {
  return JSON.stringify(canon(v));
}
function canon(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : canon(x)));
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>; const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) { if (o[k] !== undefined) out[k] = canon(o[k]); }
    return out;
  }
  return v;
}
export const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");
/** The hash of the canonical JSON of `v`. */
export const canonicalSha256 = (v: unknown): string => sha256Hex(canonicalJson(v));
