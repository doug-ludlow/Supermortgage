/**
 * §35.1 rule 9 — a stateful service is rebuilt from the record before every command (REPLAY_IS_IDEMPOTENT).
 *
 * The stateful section services (25.2's ClosingDisclosureService and its eight Maps, 21.2, 21.3, 21.5, 29.1, 29.3, 29.4,
 * 30.2; the servicing adapters `boarding`, `transfer`, `fpi`) keep their state in private Maps, arrays, Sets and counters.
 * Their own events name hashes and ids, not rows (`disclosure.cd.prepared` carries `figures_hash`, never the render), so a
 * fold of those event types alone cannot rebuild a Map — the seam therefore records, in the command's own transaction, one
 * `service.state.changed{service_key, state_sha256, delta}` per service whose state the command changed: the delta is the
 * service's Maps as they changed (entries set, keys deleted, arrays and counters replaced), computed from the service's own
 * events' effect on its Maps. `hydrate(snapshot | null, events)` folds those deltas — from the latest `service_snapshots`
 * row and the events after its `through_sequence`, or from every event — and the hydrated state's sha256 is compared with a
 * full replay's: a snapshot that does not reproduce the replay is discarded (a fresh one is written, a `ciso` sev 2 opens).
 * An event the service does not recognize is ignored by the fold (edge case 10). `service_snapshots` is an accelerator only.
 *
 * Encoding: Map → {"$map": [[k, v]…]} (entries sorted by key for a canonical hash), Set → {"$set": [...]}, bigint →
 * {"$bigint": "<digits>"} (entity_records' convention), everything else JSON. `private` fields are erasable TypeScript: the
 * runtime reads and writes them by name (each service spec lists its state fields — the Maps the spec cites by line).
 */
import { createHash } from "node:crypto";
import type { DomainEvent } from "../../../kernel/events/index.ts";

export const SERVICE_STATE_EVENT = "service.state.changed";
export const STATE_VERSION = "35.1/service-state@v1";

export interface ServiceSpec { readonly key: string; readonly fields: readonly string[]; readonly scope: "application" | "loan" | "global"; }
export type EncodedState = Record<string, unknown>;
/** Per Map field: the entries set and the keys deleted, plus `order` (every key, in the after-state's order) when the after-state's key order is not what set-and-delete alone would produce; any other field its whole value. */
export interface StateDelta { readonly fields: Record<string, { set?: [string, unknown][]; del?: string[]; order?: string[]; value?: unknown }>; }
export interface SnapshotRow { readonly through_sequence: number; readonly state: EncodedState; readonly state_sha256: string; }

type Rec = Record<string, unknown>;
const isPlain = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Map) && !(v instanceof Set) && !(v instanceof Date);

export function encodeValue(v: unknown): unknown {
  if (typeof v === "bigint") return { $bigint: v.toString() };
  // insertion order is state: a service's "first match" / "latest" reads iterate its Maps, so the encoding keeps the order and replay reproduces it (a delta sets in `after` order; setting an existing key keeps its position)
  if (v instanceof Map) return { $map: [...v.entries()].map(([k, x]) => [String(k), encodeValue(x)]) };
  if (v instanceof Set) return { $set: [...v.values()].map(encodeValue) };
  if (v instanceof Date) return { $date: v.toISOString() };
  if (Array.isArray(v)) return v.map(encodeValue);
  if (isPlain(v)) { const out: Rec = {}; for (const k of Object.keys(v).sort()) { const x = (v as Rec)[k]; if (x !== undefined && typeof x !== "function") out[k] = encodeValue(x); } return out; }
  return v;
}
export function decodeValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decodeValue);
  if (isPlain(v)) {
    const o = v as Rec;
    if (typeof o["$bigint"] === "string" && Object.keys(o).length === 1) return BigInt(o["$bigint"]);
    if (Array.isArray(o["$map"]) && Object.keys(o).length === 1) return new Map((o["$map"] as [string, unknown][]).map(([k, x]) => [k, decodeValue(x)]));
    if (Array.isArray(o["$set"]) && Object.keys(o).length === 1) return new Set((o["$set"] as unknown[]).map(decodeValue));
    if (typeof o["$date"] === "string" && Object.keys(o).length === 1) return new Date(o["$date"]);
    const out: Rec = {}; for (const [k, x] of Object.entries(o)) out[k] = decodeValue(x); return out;
  }
  return v;
}

/** The service's state fields, encoded (a Map field stays a `$map`, so a delta can address its entries). */
export function captureState(svc: object, fields: readonly string[]): EncodedState {
  const out: EncodedState = {};
  for (const f of fields) out[f] = encodeValue((svc as Rec)[f]);
  return out;
}
/** Key-order-independent JSON: a state read back from a jsonb column (service_snapshots.state, a delta on the log) hashes like the one written. */
const sortKeys = (v: unknown): unknown => (Array.isArray(v) ? v.map(sortKeys) : isPlain(v) ? Object.fromEntries(Object.keys(v as Rec).sort().map((k) => [k, sortKeys((v as Rec)[k])])) : v);
export const canonical = (v: unknown): string => JSON.stringify(sortKeys(v));
export const stateHash = (state: EncodedState): string => createHash("sha256").update(canonical(state)).digest("hex");

const mapEntries = (v: unknown): Map<string, unknown> | null => (isPlain(v) && Array.isArray((v as Rec)["$map"]) ? new Map((v as Rec)["$map"] as [string, unknown][]) : null);

/** The delta from `before` to `after`: per Map field the entries set and the keys deleted; any other field its whole value when it changed. Null when nothing changed. */
export function diffState(before: EncodedState, after: EncodedState): StateDelta | null {
  const fields: StateDelta["fields"] = {};
  for (const f of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[f], b = after[f];
    const am = mapEntries(a), bm = mapEntries(b);
    if (am && bm) {
      const set: [string, unknown][] = []; const del: string[] = [];
      for (const [k, v] of bm) if (!am.has(k) || canonical(am.get(k)) !== canonical(v)) set.push([k, v]);
      for (const k of am.keys()) if (!bm.has(k)) del.push(k);
      // a re-keyed entry (delete, then set at the end) moves in the live Map but a set on a known key keeps its place — the order rides along when they differ
      const naive = [...am.keys()].filter((k) => bm.has(k)); for (const k of bm.keys()) if (!am.has(k)) naive.push(k);
      const keys = [...bm.keys()]; const reordered = naive.length !== keys.length || naive.some((k, i) => k !== keys[i]);
      if (set.length || del.length || reordered) fields[f] = { ...(set.length ? { set } : {}), ...(del.length ? { del } : {}), ...(reordered ? { order: keys } : {}) };
    } else if (canonical(a) !== canonical(b)) fields[f] = { value: b };
  }
  return Object.keys(fields).length ? { fields } : null;
}

/** `state` after the delta (encoded domain; a new object). */
export function applyDelta(state: EncodedState, delta: StateDelta): EncodedState {
  const out: EncodedState = { ...state };
  for (const [f, d] of Object.entries(delta.fields)) {
    if (d.value !== undefined || (!d.set && !d.del && !d.order)) { out[f] = d.value; continue; }
    let m = mapEntries(out[f]) ?? new Map<string, unknown>();
    for (const k of d.del ?? []) m.delete(k);
    for (const [k, v] of d.set ?? []) m.set(k, v);
    if (d.order) { const re = new Map<string, unknown>(); for (const k of d.order) if (m.has(k)) re.set(k, m.get(k)); for (const [k, v] of m) if (!re.has(k)) re.set(k, v); m = re; }
    out[f] = { $map: [...m.entries()] };
  }
  return out;
}

/** Write an encoded state into the live service: Maps, Sets and arrays are refilled in place (the fields are `readonly` references), primitives assigned. */
export function restoreState(svc: object, fields: readonly string[], state: EncodedState): void {
  const o = svc as Rec;
  for (const f of fields) {
    const enc = state[f];
    const cur = o[f];
    if (enc === undefined) continue;
    const dec = decodeValue(enc);
    if (cur instanceof Map) { cur.clear(); if (dec instanceof Map) for (const [k, v] of dec) cur.set(k, v); }
    else if (cur instanceof Set) { cur.clear(); if (dec instanceof Set) for (const v of dec) cur.add(v); }
    else if (Array.isArray(cur)) { cur.length = 0; if (Array.isArray(dec)) cur.push(...dec); }
    else if (isPlain(cur) && isPlain(dec)) { for (const k of Object.keys(cur)) delete cur[k]; Object.assign(cur, dec); }
    else o[f] = dec;
  }
}

/** The deltas of one service key on a log, oldest first, optionally after a sequence. */
export function deltasOf(events: readonly DomainEvent[], key: string, afterSequence = 0): { sequence: number; delta: StateDelta; sha: string }[] {
  const out: { sequence: number; delta: StateDelta; sha: string }[] = [];
  for (const e of events) {
    if (e.type !== SERVICE_STATE_EVENT || e.sequence <= afterSequence) continue;
    const p = e.payload as { service_key?: unknown; delta?: unknown; state_sha256?: unknown };
    if (p.service_key !== key || !isPlain(p.delta)) continue;
    out.push({ sequence: e.sequence, delta: p.delta as unknown as StateDelta, sha: String(p.state_sha256 ?? "") });
  }
  return out.sort((a, b) => a.sequence - b.sequence);
}

export interface Hydration { readonly state: EncodedState; readonly sha: string; readonly through_sequence: number; readonly from_snapshot: boolean; readonly snapshot_discarded: boolean; readonly replay_sha: string; }

/**
 * The service's state from the record: the snapshot plus the deltas after it, checked against a full replay of every delta
 * (rule 9: "a hydration from snapshot + tail must equal a full replay or the snapshot is discarded"). Pure over the events.
 */
export function foldState(empty: EncodedState, key: string, events: readonly DomainEvent[], snapshot: SnapshotRow | null): Hydration {
  const all = deltasOf(events, key);
  let replay = empty; for (const d of all) replay = applyDelta(replay, d.delta);
  const replaySha = stateHash(replay);
  const through = all.length ? all[all.length - 1]!.sequence : 0;
  if (!snapshot) return { state: replay, sha: replaySha, through_sequence: through, from_snapshot: false, snapshot_discarded: false, replay_sha: replaySha };
  const tail = deltasOf(events, key, snapshot.through_sequence);
  const storedOk = stateHash(snapshot.state) === snapshot.state_sha256;
  let fromSnapshot = snapshot.state; for (const d of tail) fromSnapshot = applyDelta(fromSnapshot, d.delta);
  const sha = stateHash(fromSnapshot);
  if (!storedOk || sha !== replaySha) return { state: replay, sha: replaySha, through_sequence: through, from_snapshot: false, snapshot_discarded: true, replay_sha: replaySha };
  return { state: fromSnapshot, sha, through_sequence: Math.max(through, snapshot.through_sequence), from_snapshot: true, snapshot_discarded: false, replay_sha: replaySha };
}
