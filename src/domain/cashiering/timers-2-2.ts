/**
 * §2.2 timer overrides (process-owned; the §2 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 2.2 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_2_2(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Registry trigger "statement generation" is prose. The platform generates a periodic statement through
  // NoticeService.render (src/notices/service.ts), which emits `notice.rendered{template}` for the 7.1 statement codes and
  // `notice.held` when the template checklist (d3-past-payments / d3-ytd-suspense / d5-suspense) fails — the latter is
  // "7.1 blocks the statement". The gate itself is the evaluator over the `statement_suspense_summary` facts (ops-2-2.ts).
  o("REGZ_1026_41D5_STATEMENT_SUSPENSE_DISCLOSURE", {
    trigger: "`notice.rendered{template∈{NTC_REGZ_41_STMT_STD, NTC_REGZ_41_STMT_DELQ, NTC_REGZ_41_STMT_TPP, NTC_REGZ_41_STMT_BK7_11, NTC_REGZ_41_STMT_BK12_13}}`",
    evaluator: "2.2.statementSuspenseDisclosure",
    why: "§2.2 timer table: trigger 'statement generation' — the 7.1 periodic statement the notice service renders (`notice.rendered{template=NTC_REGZ_41_STMT_*}`); offset 'statement must include (d)(3) amount and (d)(5) instructions whenever Σ unapplied > 0' (12 CFR 1026.41(d)(3), (d)(5); 1026.36(c)(1)(ii)(A)) is the evaluator gate; breach '7.1 blocks the statement' = the checklist holds it (`notice.held`)." });
}
