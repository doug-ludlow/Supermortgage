/**
 * §5.3 timer overrides (process-owned; the §5 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 5.3 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 *
 * Emitters (src/domain/investor/ops-5-3.ts, each appended to the event store by the named code path; the tools in
 * src/app/tools/section5-3.ts call them):
 *   `liquidation_facts.processed{fact_id, liquidation_type, processed_at, action_code, event_type, mode, reported_late}`
 *     — processLiquidationFact (`projectEvent{op=record_fact}`; §15.4 setRecoveryExpectation appends its own copy);
 *   `p360.liquidation_event.accepted{fact_id, liquidation_event_type, p360_case_id, accepted_at}` — acceptP360LiquidationEvent
 *     (`projectEvent{op=accept_p360}`, the parsed `fnma-p360` acceptance);
 *   `liquidation.code_change.needed{from_code, to_code, cpm_action, detected_at}` — codeChangeAfterClose (`draftCpmNotice{op=detect}`);
 *   `cpm.notification.sent{kind, sent_via, reference, sent_by}` — sendCpmNotice (`draftCpmNotice{send=true}`, fnma_portal_operator/officer);
 *   `reogram.created{receipt, source}` / `human_portal_task.created{task=reogram_confirmation}` — preCreateReogramTask
 *     (`reconcileDra` for a DRA sale-held with no `foreclosure.sale.held` of ours; `prepareReogramPackage`);
 *   `reogram.confirmed{p360_case_id, evidence_document_id}` + `human_portal_task.completed{task=reogram_confirmation}` — confirmReogram
 *     (`prepareReogramPackage{op=confirm}`); `reogram.exception.raised{raised_at}` / `.resolved` — raise/resolveReogramException;
 *   `loans.fnma_liquidated_in_error` + `case.opened{kind=qc_finding}` — recordPostCloseRemovalError (`projectEvent{op=post_close_error}`);
 *   `dra.reconciliation.recorded` — the `reconcileDra` tool.
 * Triggers owned elsewhere: `payoff.funds.received` / `payoff.funds.cleared` (§16.2), `investor_event_exceptions.detected`
 * and `investor_events.submitted` / `.resolved` (§5.1 ops-5-1.ts), `schedule.tick` (the platform scheduler).
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_5_3(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  o("FNMA_LL202605_FORECLOSURE_EVENT_NEXTBD", { trigger: "`liquidation_facts.processed{mode=event}`",
    why: "§5.3 timer table marks the row '(future)' and rule 9 scopes it: 'when `investor_reporting.removal.liquidation.*.mode = event`, the same `liquidation_facts` row projects a Property 360 liquidation event … instead of LAR 70/71/72' — so only a fact processed under `mode=event` (processLiquidationFact carries the channel mode on the event) arms the next-BD 03:00 ET P360 clock; under `legacy`/`dual` the LAR 70/71/72 clock (FNMA_IRM_LIQ_AC70_72_NEXTBD_2000) governs. Satisfied by 'P360 liquidation event accepted' → `p360.liquidation_event.accepted` (acceptP360LiquidationEvent, the parsed fnma-p360 acceptance)." });
  o("SM_LIQ_CODE_CHANGE_CPM_2BD", { anchorField: "detected_at",
    why: "§5.3 timer table: 'code change needed after close' → anchor 'detection' → the `detected_at` instant on `liquidation.code_change.needed` (codeChangeAfterClose emits it only once IRM 4-08 finality has passed — before BD2 17:00 ET the change is a correcting event, not a CPM request); 2 BD; satisfied by 'CPM notification sent (human)' → `cpm.notification.sent` from sendCpmNotice (fnma_portal_operator/officer)." });
}
