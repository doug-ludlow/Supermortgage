/**
 * §12.4 timer overrides (process-owned; the §12 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 12.4 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts. The emitters are in src/domain/lossmit/ops-12-4.ts (via src/app/tools/section12-4.ts).
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_12_4(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // "Satisfied by `contact.qrpc.achieved` or expiry" — QRPC is spelled `contact.qrpc.established` on the platform (11.3's `contact.qrpc.*` handler); the 12.4 `contacts.*` handler emits it when a pre-expiry contact achieves QRPC ("continue outreach attempts until either QRPC is achieved or the forbearance plan term has expired", D2-3.2-01).
  o("FNMA_D23201_FORB_PREEXPIRY_CADENCE", { satisfied: "`contact.qrpc.established`", why: "§12.4 timer table: 'every 3 calendar days until QRPC or expiry' — `contact.qrpc.achieved` is the platform's `contact.qrpc.established` (11.3); armed by the 12.4 expiry sweep's `workout_plan.expiry_approaching{days_before=30}` (D2-3.2-01)." });
  // Anchor "due date" → the schedule row's `due_date`; "`payment.received` ≥ expected" is decided by the 12.4 schedule handler when it applies the 2.x receipt to the row (an amount comparison the pattern grammar cannot express) and spelled `workout_plan_schedule.met`.
  o("FNMA_D23201_FORB_REDUCED_PAYMENT_EOM", { anchorField: "due_date", satisfied: "`workout_plan_schedule.met{payment_mode=reduced}`", why: "§12.4 timer table: `workout_plan_schedule.due_date` → last calendar day of the month; satisfied by '`payment.received` ≥ expected' — the 12.4 `workout_plan.*` op=payment applies the receipt to the row and emits `workout_plan_schedule.met` only when the cumulative receipt covers `expected_amount_cents` (D2-3.2-01: reduced payments received by the last day of the month)." });
  // "month-end with active plan" — the platform's `period.month_end` is a period-level tick with no loan; the 12.4 month-end op fans it out per active forbearance plan on the loan subject (so the loan-level acknowledgement can satisfy it).
  o("FNMA_F121_STATUS_09_BD2", { trigger: "`workout_plan.month_end{plan_kind=forbearance, workout_plan_active=true}`", anchorField: "period_end", why: "§12.4 timer table: 'month-end with active plan' → status 09 by BD2 (2 `business_days_fannie_et` from the month end, F-1-21); the 12.4 `workout_plan.*` op=month_end emits one `workout_plan.month_end{plan_kind, workout_plan_active, period_end}` per active plan (none once `smdu.plan_cases=on`, T10); satisfied by the 5.x acknowledgement `investor.event.accepted{status_code=09}` ingested by `fnma.status_code.report` op=ack." });
  // Anchor "submission" → the `submitted_on` date the submit op records.
  o("FNMA_LL202601_FORB_EXCEPTION_RESPONSE", { anchorField: "submitted_on", why: "§12.4 timer table: `fnma_exception_requests.submitted` → 10 `business_days_fannie_et` from the submission (policy follow-up; Fannie Mae states no SLA); `exception_request.prepare` op=submit emits `fnma_exception_request.submitted{submitted_on}`, op=decide records Fannie Mae's written decision as `fnma_exception_request.decided` (LL-2026-01)." });
}
