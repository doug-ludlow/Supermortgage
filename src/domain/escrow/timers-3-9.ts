/**
 * §3.9 timer overrides (process-owned; the §3 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 3.9 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 *
 * Every trigger here is qualified on a payload field the 3.9 emitter (ops-3-9.ts) writes, so a bare event of the
 * right type appended by another process never arms a 3.9 row: 7.1's Form 1098 close appends `tax_year.closed` for
 * every loan with interest received (ops-7-1.ts closeTaxYear), and 15.4 / 19.x scheduler ticks are `cadence=daily` too.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

/** `tax_year.closed.source` written by EscrowInterest1099Service.closeTaxYear — the 1099-INT year-end close, per loan with a reportable (≥ $10.00) borrower aggregate. */
export const IOE_1099_CLOSE_SOURCE = "escrow_interest_1099";
/** `schedule.tick.job` of the daily accrual sweep (spec inputs: "Daily accrual job (`timer-sweep` 00:30 servicer TZ)"). */
export const IOE_ACCRUAL_JOB = "escrow-interest-accrual";
const CLOSE = `\`tax_year.closed{source=${IOE_1099_CLOSE_SOURCE}}\``;

export function applySatisfiedOverrides_3_9(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // ---- rule 9 / state machine `aggregated → furnished → filed`: both IRS rows arm on the 1099-INT year-end close (closeTaxYear, per reportable loan) and close on the events EscrowInterest1099Service (ops-3-9.ts) appends.
  // Anchor `tax_year_end` (Dec 31 of the tax year, in the close payload): "Jan 31" / "Mar 31" are the next occurrence on or after the anchor, so a close appended after Jan 31 (or Mar 31) still yields the tax year's own deadline — already breached — instead of next year's.
  o("IRS_1099INT_EFILE_0331", { trigger: CLOSE, anchorField: "tax_year_end", satisfied: "`tax.1099int.filed{irs_accepted=true}`",
    why: "§3.9 timer table: trigger 'tax year end' — the 1099-INT year-end close `tax_year.closed{source=escrow_interest_1099}` per reportable loan (inputs: '`tax.year_closed` → 1099-INT aggregation'; closeTaxYear), anchored on its `tax_year_end`; 7.1's Form 1098 close of the same type carries no `source` and must not arm a 1099-INT row for a loan with no escrow interest. Satisfied by '`filed_at`' — escrow_interest_1099.filed_at is written only by an accepted IRIS/FIRE transmittal (recordFiled: `tax.1099int.filed{irs_accepted=true}`; a rejection is corrected and resent), Mar 31 electronic under the 10+ returns mandate." });
  o("IRS_1099INT_FURNISH_0131", { trigger: CLOSE, anchorField: "tax_year_end", satisfied: "`tax.1099int.furnished`",
    why: "§3.9 timer table: trigger 'tax year end' — the 1099-INT year-end close `tax_year.closed{source=escrow_interest_1099}` (closeTaxYear), anchored on its `tax_year_end`; satisfied by '`escrow_interest_1099.furnished_at`' — the furnished_at write is the output event `tax.1099int.furnished{furnished_at, channel}` per loan on the form (furnish); Jan 31 'next business day if weekend/holiday per IRS rules' rolls on the federal calendar (3.9-T9: 2028-01-31; tax year 2025 → 2026-02-02)." });
  // ---- rule 3 / "accrual row for the day": the daily sweep's own tick opens a loan's accrual clock; each day's `escrow.interest.accrued` row (accrueDay) satisfies the recurring row and re-arms it for the next day.
  // Anchor `accrual_clock_on` is the day the row is for: the tick carries the day it opens, the accrued row carries the *next* day (the 18.1 pattern for recurring rows), so the kernel's re-arm lands on day D+1 with its "1 day" due on D+2 rather than on the posting instant.
  o("STATE_IOE_ACCRUAL_DAILY", { trigger: `\`schedule.tick{cadence=daily, job=${IOE_ACCRUAL_JOB}}\``, anchorField: "accrual_clock_on", satisfied: "`escrow.interest.accrued`",
    why: "§3.9 timer table: eligibility → each calendar day + 1 day, recurring; satisfied by the 'accrual row for the day' — `escrow.interest.accrued` (outputs: 'escrow.interest.accrued (daily summary)'), appended per loan and day by the daily accrual job (`timer-sweep` 00:30 servicer TZ; accrueDay is idempotent: 'recompute from ledger — accruals are idempotent'). Armed by that job's own `schedule.tick{cadence=daily, job=escrow-interest-accrual}` (openAccrualClock) — not by every daily scheduler tick on the platform (15.4's position sweep, 19.1's retention sweep)." });
}
