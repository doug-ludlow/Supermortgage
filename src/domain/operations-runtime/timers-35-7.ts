/**
 * §35.7 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 35.7 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. A code the servicing spec
 * (sections 1–19) owns is never overridden here — reference it. Wired by src/domain/timer-overrides.ts.
 *
 * The three deadline rows (SM_ROLE_QUEUE_UNSTAFFED_1BD, SM_ROLE_GRANT_DORMANT_30D, SM_ROLE_BREAKGLASS_REVIEW_1BD) parse and arm from the registry
 * as written; their subject is the trigger event's aggregate — `role_queue:<environment>:<role>` (role.queue.unstaffed / role.staffed),
 * `role_grant:<grant_id>` (role.granted / role.exercised) and `breakglass:<breakglass_id>` (role.breakglass.used / .reviewed) — because
 * the events are global (no loan), so the payload key is the subject (src/domain/operations-runtime/roles-35-7/*.ts emit them).
 * 35.7's recurring clocks (SM_HANDOVER_BOARD_DAILY) are global: each is armed by a per-day (or per-run) completion receipt on
 * the global subject, not by a loan or application aggregate, so each takes the cited `subject: "global"` override
 * on the src/domain/partner-book/timers-33-2.ts precedent (SM_PARTNER_BOOK_REVIEW_DAILY). The deadline rows of 35.7
 * parse and arm from the registry as written and need no override.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_35_7(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Timer table row 1: a recurring global clock — the environment day's, re-armed by each completion (timers-33-2.ts precedent).
  o("SM_HANDOVER_BOARD_DAILY", { anchorField: "as_of_date", offset: "+1 calendar_days, 06:30 ET", subject: "global",
    why: "§35.7 timer table row `SM_HANDOVER_BOARD_DAILY`: recurring on `role.queue.scan_completed`, anchor `as_of_date`, offset '+1 calendar_days', satisfied by `role.queue.scan_completed`, breach 'sev 3 → `compliance` (no queue scan today: the board is stale)' — 'Trigger & frequency: On every grant, revoke, break-glass and handover command (a staff session); on every `/v1` request (the principal is resolved before the route); the role-queue scan once per calendar day at 06:30 America/New_York as a 35.3 cycle (`roles.queue_scan`, global scope) and again inside every sweep's breach pass for roles with open items; the board on demand'. The receipt is one global event per environment-day (or per run for the 90-day drill), not a loan's or an application's, so the clock is the platform's: armed on the global subject (subject: \"global\") by the first completion, satisfied by the next day's completion and re-armed for the day after at 06:30 America/New_York (anchor as_of_date + 1 calendar day, 06:30 ET — the 35.3 registry row `roles.queue_scan`'s hour; the sweep runs the scan at/after 06:30 ET before its breach pass, so a day whose scan completed never breaches) — the timers-33-2.ts precedent for a recurring global clock (SM_PARTNER_BOOK_REVIEW_DAILY)." });
}
