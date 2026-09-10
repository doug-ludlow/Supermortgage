/**
 * Registry overrides for Section 1 timers whose spec rows carry conditions or
 * computed anchors the column grammar cannot express. Each override cites the
 * prose it encodes.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applyBoardingTimerOverrides(reg: TimerRegistry): void {
  // Anchor: "earliest of (transfer_date + 3 business_days_servicer) and (first next_due_date ≥ transfer_date)" — computed by the service.
  reg.override("SM_BOARD_FIRST_CYCLE", { anchorField: "first_cycle_due" });
  // Trigger prose: "`loan.boarded` (escrowed loans; investor_reporting.escrow_events flag on)".
  reg.override("LL_2026_05_ESCROW_SETUP_ACQUIRED_BD1", { trigger: "`loan.boarded{escrowed=true}`" });
  // Anchor "raised_at" is the event's own timestamp.
  reg.override("SM_BOARD_EXCEPTION_SLA_2", { anchorField: "raised_at" });
}
