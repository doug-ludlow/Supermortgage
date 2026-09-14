/**
 * 34.4 rule 1 — the clocks view: every armed, due and breached clock across the platform with its code, subject, due date,
 * the registry's severity and breach role, the breach action text, and the events that armed it and will satisfy it
 * (the registry row's trigger and satisfied-by patterns; the arming event row itself; the satisfying event once one did).
 *
 * Clocks are shown, never edited: this module has no write; the only path that changes a timer row is the owning process's
 * events through the kernel engine (the registry rule) — `controls.timers` is a read tool and every `/ops/api/controls/timers*`
 * route is GET (T1's contract, NO_CLOCK_EDIT in src/app/tools/section34-4.ts).
 *
 * The severity and breach role come from the registry the sweep uses (src/runtime/app.ts sweep: `escalateTo[0] ?? ops_analyst`),
 * so the view agrees with the escalation the breach opened.
 */
import type { Runtime } from "../app.ts";
import { clampLimit, isUuid, s, type Row } from "./common.ts";

export type ClockStatus = "armed" | "due" | "breached" | "open" | "satisfied" | "all";
export interface ControlsTimersFilter { readonly status?: string | null; readonly code?: string | null; readonly subject?: string | null; readonly due_before?: string | null; readonly limit?: number | null; /** one clock by id (the detail route) */ readonly timer_id?: string | null; }
export interface ControlsTimerRow {
  readonly timer_id: string; readonly code: string; readonly status: string; readonly due: boolean;
  readonly subject_kind: string; readonly subject_id: string; readonly loan_id: string | null; readonly application_id: string | null;
  readonly armed_at: string; readonly anchor_date: string; readonly due_date: string | null; readonly due_at: string | null;
  readonly satisfied_at: string | null; readonly breached_at: string | null; readonly cancelled_reason: string | null; readonly note: string | null;
  /** The registry row: process, kind, severity level, the breach role (the first escalation role — who the breach escalation is opened to) and the breach action text. */
  readonly process: string | null; readonly kind: string | null; readonly severity: number | null; readonly breach_role: string | null; readonly escalate_to: readonly string[]; readonly breach: string | null;
  /** The events: the registry's arming pattern and satisfying pattern (verbatim), the arming event row, the satisfying event row when one has. */
  readonly armed_by: string | null; readonly satisfied_by: string | null;
  readonly arming_event: { id: string; type: string; occurred_at: string } | null;
  readonly satisfying_event: { id: string; type: string; occurred_at: string } | null;
}
export interface ControlsTimersView { readonly as_of: string; readonly filter: { status: ClockStatus; code: string | null; subject: string | null; due_before: string | null }; readonly count: number; readonly counts: { armed: number; due: number; breached: number }; readonly timers: readonly ControlsTimerRow[]; }

const STATUSES: readonly ClockStatus[] = ["armed", "due", "breached", "open", "satisfied", "all"];
const statusOf = (v: unknown): ClockStatus => (typeof v === "string" && (STATUSES as readonly string[]).includes(v) ? (v as ClockStatus) : "open");

/** `GET /ops/api/controls/timers?status=&code=&subject=&due_before=` → the rows; `status` open (armed + breached, the default) | armed | due (armed and past due at `now`) | breached | satisfied | all. */
export async function controlsTimers(rt: Runtime, f: ControlsTimersFilter = {}, nowIso: string = rt.clock.now()): Promise<ControlsTimersView> {
  const status = statusOf(f.status); const code = f.code?.trim() || null; const subject = f.subject?.trim() || null; const dueBefore = f.due_before?.trim() || null;
  if (dueBefore && Number.isNaN(Date.parse(dueBefore))) throw new RangeError("due_before is a date or instant (YYYY-MM-DD or ISO)");
  const where: string[] = []; const p: unknown[] = [nowIso];
  switch (status) {
    case "armed": where.push(`t.status = 'armed'`); break;
    case "due": where.push(`t.status = 'armed' AND ((t.due_at IS NOT NULL AND t.due_at <= $1::timestamptz) OR (t.due_at IS NULL AND t.due_date IS NOT NULL AND t.due_date <= ($1::timestamptz)::date))`); break;
    case "breached": where.push(`t.status = 'breached'`); break;
    case "satisfied": where.push(`t.status IN ('satisfied', 'satisfied_late')`); break;
    case "open": where.push(`t.status IN ('armed', 'breached')`); break;
    case "all": break;
  }
  if (code) { p.push(code); where.push(`t.code = $${p.length}`); }
  if (subject) { p.push(subject); where.push(`(t.subject_id = $${p.length} OR ${isUuid(subject) ? `t.loan_id = $${p.length}::uuid OR t.application_id = $${p.length}::uuid OR` : ""} t.subject_kind = $${p.length})`); }
  if (f.timer_id) { if (!isUuid(f.timer_id)) throw new RangeError("timer_id is a uuid"); p.push(f.timer_id); where.push(`t.id = $${p.length}::uuid`); }
  if (dueBefore) { p.push(dueBefore); where.push(`((t.due_at IS NOT NULL AND t.due_at < $${p.length}::timestamptz) OR (t.due_at IS NULL AND t.due_date IS NOT NULL AND t.due_date < ($${p.length}::timestamptz)::date))`); }
  p.push(clampLimit(f.limit, 500, 5000));
  const rows = await rt.db.query<Row>(`SELECT t.id::text AS timer_id, t.code, t.status::text AS status, t.subject_kind, t.subject_id, t.loan_id::text AS loan_id, t.application_id::text AS application_id,
      t.armed_at::text AS armed_at, t.anchor_date::text AS anchor_date, t.due_date::text AS due_date, t.due_at::text AS due_at, t.satisfied_at::text AS satisfied_at, t.breached_at::text AS breached_at, t.cancelled_reason, t.note,
      (t.status = 'armed' AND ((t.due_at IS NOT NULL AND t.due_at <= $1::timestamptz) OR (t.due_at IS NULL AND t.due_date IS NOT NULL AND t.due_date <= ($1::timestamptz)::date))) AS due,
      a.id::text AS arming_event_id, a.type AS arming_event_type, a.occurred_at::text AS arming_event_at,
      sb.id::text AS satisfying_event_id, sb.type AS satisfying_event_type, sb.occurred_at::text AS satisfying_event_at
    FROM timers t
    LEFT JOIN loan_events a ON a.id = t.armed_by_event_id
    LEFT JOIN loan_events sb ON sb.id = t.satisfied_by_event_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY (t.status = 'breached') DESC, coalesce(t.due_at, t.due_date::timestamptz) ASC NULLS LAST, t.armed_at ASC
    LIMIT $${p.length}`, p);
  const timers = rows.map((r): ControlsTimerRow => {
    const def = rt.registry.get(s(r["code"]));
    return { timer_id: s(r["timer_id"]), code: s(r["code"]), status: s(r["status"]), due: r["due"] === true, subject_kind: s(r["subject_kind"]), subject_id: s(r["subject_id"]), loan_id: r["loan_id"] ? s(r["loan_id"]) : null, application_id: r["application_id"] ? s(r["application_id"]) : null,
      armed_at: s(r["armed_at"]), anchor_date: s(r["anchor_date"]), due_date: r["due_date"] ? s(r["due_date"]) : null, due_at: r["due_at"] ? s(r["due_at"]) : null, satisfied_at: r["satisfied_at"] ? s(r["satisfied_at"]) : null, breached_at: r["breached_at"] ? s(r["breached_at"]) : null, cancelled_reason: r["cancelled_reason"] ? s(r["cancelled_reason"]) : null, note: r["note"] ? s(r["note"]) : null,
      process: def?.process ?? null, kind: def?.kindNorm ?? null, severity: def?.severity.level ?? null, breach_role: def ? (def.severity.escalateTo[0] ?? "ops_analyst") : null, escalate_to: def ? [...def.severity.escalateTo] : [], breach: def?.breach ?? null,
      armed_by: def?.trigger ?? null, satisfied_by: def?.satisfied ?? null,
      arming_event: r["arming_event_id"] ? { id: s(r["arming_event_id"]), type: s(r["arming_event_type"]), occurred_at: s(r["arming_event_at"]) } : null,
      satisfying_event: r["satisfying_event_id"] ? { id: s(r["satisfying_event_id"]), type: s(r["satisfying_event_type"]), occurred_at: s(r["satisfying_event_at"]) } : null };
  });
  const [c] = await rt.db.query<{ armed: number; due: number; breached: number }>(`SELECT count(*) FILTER (WHERE status = 'armed')::int AS armed, count(*) FILTER (WHERE status = 'armed' AND ((due_at IS NOT NULL AND due_at <= $1::timestamptz) OR (due_at IS NULL AND due_date IS NOT NULL AND due_date <= ($1::timestamptz)::date)))::int AS due, count(*) FILTER (WHERE status = 'breached')::int AS breached FROM timers`, [nowIso]);
  return { as_of: nowIso, filter: { status, code, subject, due_before: dueBefore }, count: timers.length, counts: { armed: Number(c?.armed ?? 0), due: Number(c?.due ?? 0), breached: Number(c?.breached ?? 0) }, timers };
}

/** One clock with its history — the timer.* events that carry its id (armed, satisfied, breached, cancelled), oldest first. */
export async function controlsTimer(rt: Runtime, timerId: string, nowIso: string = rt.clock.now()): Promise<(ControlsTimerRow & { history: { id: string; type: string; occurred_at: string; payload: Row }[] }) | null> {
  const t = (await controlsTimers(rt, { status: "all", timer_id: timerId, limit: 1 }, nowIso)).timers[0];
  if (!t) return null;
  const history = await rt.db.query<{ id: string; type: string; occurred_at: string; payload: Row }>(`SELECT id::text AS id, type, occurred_at::text AS occurred_at, payload FROM loan_events WHERE type LIKE 'timer.%' AND payload->>'timer_id' = $1 ORDER BY sequence`, [timerId]);
  return { ...t, history };
}
