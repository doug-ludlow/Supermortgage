/**
 * §9.3 timer overrides (process-owned; the §9 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 9.3 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

/**
 * No 9.3-specific overrides are needed: every 9.3 row already matches what the platform emits.
 *   REGX_1024_37D_FPI_REMINDER_NOT_BEFORE_30 / INS_FPI_REMINDER_TARGET_30_35 — trigger `fpi.first_notice.sent`, anchor
 *     `first_notice_mailed_at`, satisfied `fpi.reminder.sent` (Fpi92Service.recordReminderMailed, ops-9-2.ts; 9.3-T1);
 *   REGX_1024_37D_FPI_REMINDER_BEFORE_CHARGE_15 / REGX_1024_37C1III_FPI_EVIDENCE_WINDOW_15 — trigger `fpi.reminder.sent`,
 *     anchor `reminder_mailed_at`, satisfied `fpi.charge.assessed` / `fpi.evidence_window.evaluated` (9.3-T5);
 *   REGX_1024_37D5_NOTICE_PRODUCTION_5BD — `notice.production{template∈MS-3 family}` → `notice.mailed{…}` from the Notice
 *     Registry (src/notices/service.ts), anchor `production_at` (9.3-T4).
 * The rows are spelled in ./timers.ts (section) and ./timers-9-2.ts (the 9.2 case service owns the clocks — spec 9.3 timer
 * table: "`fpi.reminder.sent` … sets `REGX_1024_37D_FPI_REMINDER_BEFORE_CHARGE_15` and the 15-day evidence window");
 * the reminder job itself (ops-9-3.ts) appends `fpi.reminder.produced/regenerated/cancelled`, which no row waits on.
 */
export function applySatisfiedOverrides_9_3(reg: TimerRegistry): void {
  void reg;
}
