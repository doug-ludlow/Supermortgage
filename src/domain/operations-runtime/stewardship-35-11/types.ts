/**
 * §35.11 — the constants and row shapes every module of the process shares
 * (spec/sections/35-operations-runtime/35-11-operations-stewardship-and-hosted-measurement.md).
 *
 *   the agent          `qc-audit` — the process's owner (Discrepancies (1): 35.3 owns `ops-steward`; "the ops steward" is this pass's name).
 *   the rule sets      ops.v1 (the steward), audit.v1 (the measurement); model deterministic; prompt 35.11-v1.
 *   the clocks         the report at/after 00:15 ET (rule 5); classification windows 15 and 60 minutes (rule 3).
 *   the exception      source kinds, kinds and statuses exactly as the Data model's CHECK lists (0230).
 * No money field anywhere in this process (rule 9).
 */
import type { Actor } from "../../../kernel/events/index.ts";

export const PROCESS_35_11 = "35.11";
export const STEWARD_AGENT = "qc-audit";
export const OPS_RULE_SET_VERSION = "ops.v1";
export const AUDIT_RULE_SET_VERSION = "audit.v1";
export const STEWARD_MODEL_VERSION = "deterministic";
export const STEWARD_PROMPT_VERSION = "35.11-v1";
export const STEWARD_ACTOR: Actor = { kind: "agent", id: STEWARD_AGENT };
export const ET = "America/New_York";
/** Rule 5: the first run of a day happens on the first sweep at or after 00:15 ET (the previous day's report). */
export const REPORT_AT_ET = "00:15";
export const D15_MINUTES = 15;
export const S60_MINUTES = 60;
/** Rule 4: the automatic requeue needs confidence ≥ 0.85 and happens at most once per message. */
export const CONFIDENCE_FLOOR = 0.85;
export const AUTO_REQUEUE_CAP = 1;

export const SOURCE_KINDS = ["integration_message", "cycle_registry", "cycle_run", "job", "escalation", "sweep_run", "role_queue", "fake_actor"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export const EXCEPTION_KINDS = ["unclassified", "adapter_down", "transient", "poison", "needs_person", "missed_cycle", "stalled_run", "dead_unit", "unstaffed_role", "fake_in_production"] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];
export const EXCEPTION_STATUSES = ["open", "triaged", "assigned", "resolved", "abandoned"] as const;
export type ExceptionStatus = (typeof EXCEPTION_STATUSES)[number];
export const LIVE_STATUSES: readonly ExceptionStatus[] = ["open", "triaged", "assigned"];
export const TRIAGE_ACTIONS = ["opened", "classified", "requeue_auto", "requeue_proposed", "assigned", "resolved", "abandoned", "escalated"] as const;
export type TriageAction = (typeof TRIAGE_ACTIONS)[number];

export interface ExceptionRow extends Record<string, unknown> {
  readonly id: string; readonly environment: string; readonly source_kind: SourceKind; readonly source_id: string; readonly adapter: string | null;
  readonly loan_id: string | null; readonly application_id: string | null; readonly kind: ExceptionKind; readonly confidence: string | null; readonly status: ExceptionStatus;
  readonly owner_role: string; readonly opened_at: string; readonly classified_at: string | null; readonly assigned_at: string | null; readonly resolved_at: string | null;
  readonly auto_requeues: number; readonly escalation_id: string | null; readonly latest_triage_id: string | null; readonly created_at: string;
}
export const EXCEPTION_COLS = `id::text AS id, environment, source_kind, source_id, adapter, loan_id::text AS loan_id, application_id::text AS application_id, kind, confidence::text AS confidence, status, owner_role, opened_at::text AS opened_at, classified_at::text AS classified_at, assigned_at::text AS assigned_at, resolved_at::text AS resolved_at, auto_requeues, escalation_id::text AS escalation_id, latest_triage_id::text AS latest_triage_id, created_at::text AS created_at`;

export type Row = Record<string, unknown>;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);
export const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
export const minutesAfter = (iso: string, m: number): string => new Date(Date.parse(iso) + m * 60_000).toISOString();
export const isProduction = (environment: string | undefined): boolean => environment === "production" || environment === "prod";
/** `by` on a decision or an event: a human's id as is, anyone else as `<kind>:<id>` (35.7's byOf; rule 4's `by: "agent:qc-audit"`). */
export const byOf = (a: Actor): string => (a.kind === "human" ? a.id : `${a.kind}:${a.id}`);
/** Canonical JSON: keys sorted at every depth, no whitespace, bigint as a decimal string — the input of every sha256 this process stores. */
export function canonicalJson(v: unknown): string {
  const walk = (x: unknown): unknown => {
    if (typeof x === "bigint") return x.toString();
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") return Object.fromEntries(Object.keys(x as Row).sort().map((k) => [k, walk((x as Row)[k])]));
    return x === undefined ? null : x;
  };
  return JSON.stringify(walk(v));
}
