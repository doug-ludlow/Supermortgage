/**
 * §10.3 timer overrides (process-owned; the §10 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 10.3 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_10_3(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // The section override already anchors the preview on `midpoint_termination_date − 90 days` from `mi.schedule.updated`; the
  // process narrows the trigger to borrower-paid policies (the payload's `bpmi`) and keeps the completion event the preview
  // appends (src/domain/pmi/ops-10-3.ts runMidpointPreview).
  o("SM_MI_MIDPOINT_PREVIEW_90", { trigger: "`mi.schedule.updated{bpmi=true}`", anchorField: "midpoint_termination_date", offset: "−90 calendar_days", satisfied: "`mi.midpoint.preview.completed`",
    why: "§10.3 timer table: anchor `midpoint_termination_date − 90 days`, satisfied '`mi.midpoint.preview.completed` (data completeness check: schedule, original value, insurer channel)', breach 'queue to `pmi` agent'; the sweep it previews selects 'active BPMI policies with `midpoint_termination_date ≤ today`' (Operational prerequisites) — LPMI is outside 4902 (4905(b)), so only a borrower-paid schedule arms the preview." });
}
