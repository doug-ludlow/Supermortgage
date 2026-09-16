/**
 * §35.1 rule 8 — the expected-version guard (STALE_RECORD_REFUSES_WHOLE_COMMAND). "A command may carry
 * `expected_versions: [{kind, id, version}]`; after the lock, the runtime compares each with `entity_latest_scoped` and
 * refuses `STALE_RECORD{kind, id, expected, current}` (HTTP 409) before the domain code runs — no event, no version, no
 * decision. Without a declared expectation the guard is still mechanical: `entity_records`' primary key
 * `(kind, id, version, scope_key)` (0115) makes a concurrent writer's `version + 1` collide at INSERT; the unique
 * violation is mapped to the same `STALE_RECORD` and the transaction rolls back." A refusal writes no domain row (open
 * question 5): the API log and 34.1's staff_actions carry it.
 */
import type { EntityStore } from "../../../app/tools.ts";

export class StaleRecord extends Error {
  readonly code = "STALE_RECORD";
  readonly kind: string; readonly id: string; readonly expected: number | null; readonly current: number | null;
  constructor(kind: string, id: string, expected: number | null, current: number | null) {
    super(`STALE_RECORD: ${kind} ${id} expected version ${expected ?? "(none)"}, current ${current ?? "null"}`);
    this.name = "StaleRecord"; this.kind = kind; this.id = id; this.expected = expected; this.current = current;
  }
  toJSON(): Record<string, unknown> { return { error: "refused", code: this.code, kind: this.kind, id: this.id, expected: this.expected, current: this.current, reason: this.message }; }
}

export interface ExpectedVersion { readonly kind: string; readonly id: string; readonly version: number; }

/** The `expected_versions` a tool input carries, normalised; anything malformed is a RangeError (a typed refusal, never a TypeError). */
export function expectedVersionsOf(input: Record<string, unknown> | undefined): ExpectedVersion[] {
  const raw = input?.["expected_versions"];
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new RangeError("expected_versions must be an array of {kind, id, version}");
  return raw.map((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    if (typeof o["kind"] !== "string" || typeof o["id"] !== "string" || !Number.isInteger(Number(o["version"]))) throw new RangeError("expected_versions entries are {kind: string, id: string, version: integer}");
    return { kind: o["kind"], id: o["id"], version: Number(o["version"]) };
  });
}

/** Rule 8: after the lock and the hydration, every declared expectation must match the store's current version (a kind the scope does not hold → `current: null`, edge case 9). */
export function checkExpectedVersions(store: EntityStore, expected: readonly ExpectedVersion[]): void {
  for (const e of expected) {
    const cur = store.get(e.kind, e.id);
    if ((cur?.version ?? null) !== e.version) throw new StaleRecord(e.kind, e.id, e.version, cur?.version ?? null);
  }
}

/** A Postgres unique violation on entity_records' primary key → the same STALE_RECORD (rule 8's mechanical guard); anything else is returned as is. */
export function mapEntityRecordsCollision(e: unknown): unknown {
  const err = e as { code?: string; constraint?: string; detail?: string; message?: string };
  if (err?.code !== "23505" || !/entity_records_pkey/.test(err.constraint ?? err.message ?? "")) return e;
  const m = /\(kind, id, version, scope_key\)=\(([^,]*), (.*), (\d+), ([^)]*)\)/.exec(err.detail ?? "");
  const version = m ? Number(m[3]) : null;
  return new StaleRecord(m?.[1] ?? "?", m?.[2] ?? "?", version === null ? null : version - 1, version);
}
