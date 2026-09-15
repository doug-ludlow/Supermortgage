/**
 * §3.3 timer overrides (process-owned; the §3 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 3.3 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 *
 * Every trigger and satisfier named here is appended to the event store by a validating code path on the bus:
 *   - the hold `escrow.statement.exempt_hold` (REGX_1024_17I_ANNUAL_STMT_30's (i)(2) satisfier, ./timers.ts): the 3.3
 *     renderStatement tool (src/app/tools/section3-3.ts renderAnnualStatement_3_3) → ops-3-3.ts applyExemptionPolicy →
 *     ops.ts recordExemptHold, over the engine's analysis record and the loan's log;
 *   - the trigger `escrow.statement.exemption_ended`: ops-3-3.ts endExemption, reached by ingesting §13.3's
 *     `loan.reinstated{reinstated_on}` / `foreclosure.case.closed{closed_on}` (ops-13-3.ts reinstatementTendered, behind
 *     section13-3.ts op fc.reinstatement), the spec's `foreclosure.case.cancelled` and §14.1's `bankruptcy.case.closed{closed_on}`
 *     — eagerly by exemptionReactors_3_3, lazily by settleExemption inside the 3.3 renderStatement tool;
 *   - the satisfier `escrow.statement.sent{statement_type=post_exemption_history}`: recordStatementSent (ops.ts) behind
 *     sendNotice (section03.ts) for NTC_REGX_1024_17I_POST_EXEMPTION_HISTORY — never by a bare literal.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_3_3(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // ---- (i)(2) post-exemption history: the anchor is a payload date, not the day the fact was recorded
  o("REGX_1024_17I2_POST_EXEMPTION_HISTORY_90", { trigger: "`escrow.statement.exemption_ended{statement_type=post_exemption_history}`", anchorField: "exemption_ended_on", satisfied: "`escrow.statement.sent{statement_type=post_exemption_history}`",
    why: "§3.3 timer table: trigger `escrow.statement.exemption_ended` — emitted only when the loan 'is reinstated or otherwise becomes current' while an (i)(2) hold is open; anchor 'date the account became current (`exemption_ended_on`)', 90 calendar days, satisfied by `escrow.statement.sent` (post_exemption_history) — §1024.17(i)(2): 'within 90 days of the date the account became current'. endExemption (ingesting `loan.reinstated` / `loan.became_current`, and `foreclosure.case.closed` (§13.3's spelling of the action ending) / `foreclosure.case.cancelled` / `bankruptcy.case.closed` only when they record the account as current — a closure on a still-delinquent loan is refused and the hold stays; eagerly via exemptionReactors_3_3, lazily via settleExemption in the 3.3 renderStatement tool; and the request path, since a borrower request on a current loan is itself the account having become current) carries that date as `exemption_ended_on` (a reinstatement recorded days later must not move the 90-day clock); 3.3-T4: ended 2027-09-10 → due 2027-12-09. The hold itself is the 3.3 renderStatement tool's rule-5 test (applyExemptionPolicy → recordExemptHold). The send is recordStatementSent's `escrow.statement.sent{statement_type=post_exemption_history}` for NTC_REGX_1024_17I_POST_EXEMPTION_HISTORY (sendNotice) — the policy 5-BD send that answers a borrower's request satisfies it early." });
}
