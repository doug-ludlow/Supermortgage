/**
 * §35.11 rule 3 — the deterministic classifier (rule set `ops.v1`, no model). For a dead message the classifier counts, per
 * adapter, over `outbox_dispatches` and `integration_messages`: D15 = dead or retry outcomes in the last 15 minutes, S60 =
 * successful sends in the last 60 minutes, A = the message's `attempts`, C = its last failure class. Then:
 *   adapter_down  when D15 ≥ 3 and S60 = 0                                                   (confidence 0.95)
 *   transient     when C ∈ {timeout, connection_reset, http_5xx, rate_limited} and S60 ≥ 1    (0.90 when S60 ≥ 3, else 0.80)
 *   poison        when C ∈ {validation, http_4xx, schema} and A ≥ 5                          (0.95)
 *   needs_person  otherwise                                                                  (0.50)
 * `C` is the error class: `outbox_dispatches.failure_kind` when it is one of rule 3's codes; the outbox's coarse vocabulary
 * (transient | unavailable | rejected | unknown — src/infra/integrations/failures.ts) is refined from the dispatch's `error`
 * text (the message only, never a payload); an error nobody can name stays its coarse kind and is `needs_person`.
 * The other source kinds classify by their source: a registry miss is `missed_cycle`, a breached run `stalled_run`, a dead
 * unit `dead_unit`, an unstaffed queue `unstaffed_role`, a FAKE actor on a production day `fake_in_production` — confidence 1.
 */
import type { Queryable } from "../../../infra/db/client.ts";
import { D15_MINUTES, S60_MINUTES, type ExceptionKind, type SourceKind } from "./types.ts";

export const TRANSIENT_CLASSES: readonly string[] = ["timeout", "connection_reset", "http_5xx", "rate_limited"];
export const POISON_CLASSES: readonly string[] = ["validation", "http_4xx", "schema"];
export const ERROR_CLASSES: readonly string[] = [...TRANSIENT_CLASSES, ...POISON_CLASSES];

export interface Signals extends Record<string, unknown> { readonly D15: number; readonly S60: number; readonly A: number; readonly C: string }
export interface Classification { readonly kind: ExceptionKind; readonly confidence: number; readonly signals: Signals; readonly rule: string }

/** The error class of a dispatch: rule 3's code when the outbox stored one, else the code its error text names, else the coarse kind. */
export function errorClass(failureKind: string | null | undefined, error: string | null | undefined): string {
  const fk = (failureKind ?? "").trim().toLowerCase();
  if (ERROR_CLASSES.includes(fk)) return fk;
  const e = (error ?? "").toLowerCase();
  if (/\btimeout\b|timed out|etimedout/.test(e)) return "timeout";
  if (/econnreset|connection reset|socket hang up|econnrefused/.test(e)) return "connection_reset";
  if (/\b(429|rate.?limit|too many requests)\b/.test(e)) return "rate_limited";
  if (/\b5\d\d\b|http 5xx|bad gateway|service unavailable|gateway timeout/.test(e)) return "http_5xx";
  if (/\bschema\b/.test(e)) return "schema";
  if (/\bvalidation\b|invalid\b|malformed/.test(e)) return "validation";
  if (/\b4\d\d\b|http 4xx|bad request|not found|unauthori[sz]ed|forbidden/.test(e)) return "http_4xx";
  return fk || "unknown";
}

export function classifyDeadMessage(sig: Signals): Classification {
  if (sig.D15 >= 3 && sig.S60 === 0) return { kind: "adapter_down", confidence: 0.95, signals: sig, rule: "ops.v1 rule 3: D15 ≥ 3 and S60 = 0" };
  if (TRANSIENT_CLASSES.includes(sig.C) && sig.S60 >= 1) return { kind: "transient", confidence: sig.S60 >= 3 ? 0.9 : 0.8, signals: sig, rule: `ops.v1 rule 3: C = ${sig.C} and S60 = ${sig.S60}` };
  if (POISON_CLASSES.includes(sig.C) && sig.A >= 5) return { kind: "poison", confidence: 0.95, signals: sig, rule: `ops.v1 rule 3: C = ${sig.C} and A = ${sig.A}` };
  return { kind: "needs_person", confidence: 0.5, signals: sig, rule: "ops.v1 rule 3: otherwise" };
}

/** Rule 3's counted signals for a dead message, read at `nowIso` (the command clock). Counts and classes only. */
export async function messageSignals(q: Queryable, i: { message_id: string; adapter: string; now: string }): Promise<Signals> {
  const d15 = new Date(Date.parse(i.now) - D15_MINUTES * 60_000).toISOString();
  const s60 = new Date(Date.parse(i.now) - S60_MINUTES * 60_000).toISOString();
  const [c] = await q.query<{ d15: string; s60: string }>(
    `SELECT (SELECT count(*)::text FROM outbox_dispatches WHERE adapter = $1 AND outcome IN ('dead', 'retry', 'fallback') AND finished_at > $2::timestamptz AND finished_at <= $4::timestamptz) AS d15,
            (SELECT count(*)::text FROM outbox_dispatches WHERE adapter = $1 AND outcome = 'acked' AND finished_at > $3::timestamptz AND finished_at <= $4::timestamptz) AS s60`, [i.adapter, d15, s60, i.now]);
  const [m] = await q.query<{ attempts: number; error: string | null }>(`SELECT attempts, error FROM integration_messages WHERE id = $1::uuid`, [i.message_id]);
  const [last] = await q.query<{ failure_kind: string | null; error: string | null }>(`SELECT failure_kind, error FROM outbox_dispatches WHERE message_id = $1::uuid ORDER BY attempt_no DESC LIMIT 1`, [i.message_id]);
  return { D15: Number(c?.d15 ?? 0), S60: Number(c?.s60 ?? 0), A: Number(m?.attempts ?? 0), C: errorClass(last?.failure_kind, last?.error ?? m?.error) };
}

/** The classification of a non-message source: its kind is its source (confidence 1, no counted signals). */
export function classifyBySource(source_kind: SourceKind, current: ExceptionKind): Classification | null {
  const kind: ExceptionKind | null = source_kind === "cycle_registry" ? "missed_cycle" : source_kind === "cycle_run" ? "stalled_run" : source_kind === "job" ? "dead_unit" : source_kind === "role_queue" ? "unstaffed_role" : source_kind === "fake_actor" ? "fake_in_production" : source_kind === "escalation" || source_kind === "sweep_run" ? (current === "unclassified" ? "needs_person" : current) : null;
  return kind ? { kind, confidence: kind === "needs_person" ? 0.5 : 1, signals: { D15: 0, S60: 0, A: 0, C: source_kind }, rule: `ops.v1 rule 2: ${source_kind} → ${kind}` } : null;
}
