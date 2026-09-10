/**
 * §5.6 timer overrides (process-owned; the §5 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 5.6 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 *
 * Emitters (src/domain/investor/ops-5-6.ts, through src/app/tools/section5-6.ts — every event appended to the store):
 *   `repurchase.demand.received{received_at, pay_by, first_appeal_by}` — ingestRepurchaseDemand (also §18.2's remedy hand-off);
 *   `repurchase.file_review.selected{selected_on, documents_due_on}` / `repurchase.documents.submitted{document_ids}`
 *     — ingestFileReviewSelection / submitReviewDocuments;
 *   `repurchase.appeal.decided{stage, outcome}` — recordAppealDecision (officer); `repurchase.appeal.denied{stage, received_at}`
 *     — ingestAppealDenial (a second denial enters `impasse`);
 *   `repurchase.stage.entered{stage, stage_deadline_on}` / `repurchase.stage.action_recorded{stage, action}` — enterAppealStage /
 *     recordStageAction (`stageDeadline`: impasse 30, escalation 30, idr_retainer 15, next_stage 15 calendar days);
 *   `repurchase.processed{processed_at}` then `investor_events.projected{event_type=removal.repurchase, action_code}` — processRepurchase;
 *   `investor_events.submitted{event_type=removal.repurchase}` — the 5.1 adapter acknowledgement (ops-5-1 recordSubmissionAck);
 *   `repurchase.proceeds.scheduled{remittance_due_on, cycle, crs_code}` — scheduleRepurchaseProceeds (`repurchaseProceedsDue`);
 *   `remittances.funded{kind=repurchase}` + `repurchase.proceeds.matched{matched_on}` — matchRepurchaseProceeds;
 *   `repurchase.ownership.updated` — updateRepurchaseOwnership.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_5_6(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  o("FNMA_A1302_DOCS_30", { anchorField: "selected_on", why: "§5.6 timer table: 'file selected for review' / anchor 'notification' — the selection notice's date (`selected_on` on `repurchase.file_review.selected`, ingestFileReviewSelection) + 30 calendar days (A1-3-02 'documentation within 30 days of file selection'); satisfied by `repurchase.documents.submitted` (submitReviewDocuments)." });
  o("FNMA_A1302_REPURCHASE_PAY_60", { anchorField: "received_at", why: "§5.6 timer table: anchor 'receipt' = `received_at` on `repurchase.demand.received` (ingestRepurchaseDemand; the edge case 'transfer-in with an open demand: appeal clocks continue from Fannie Mae's original notice' boards the original date) + 60 calendar days; satisfied by `remittances.funded{kind=repurchase}` (matchRepurchaseProceeds — state `funded`)." });
  o("FNMA_A1302_APPEAL1_60", { anchorField: "received_at", why: "§5.6 timer table: anchor 'receipt' = `received_at` on `repurchase.demand.received` + 60 calendar days; 'appeal filed or decision not to appeal recorded' = `repurchase.appeal.decided{stage=1, outcome∈{filed, not_appealed}}` (recordAppealDecision, an officer decision)." });
  o("FNMA_A1302_APPEAL2_15", { anchorField: "received_at", why: "§5.6 timer table: 'first-appeal denial' / anchor 'receipt' = `received_at` on `repurchase.appeal.denied{stage=1}` (ingestAppealDenial) + 15 calendar days; 'second appeal filed / waived' = `repurchase.appeal.decided{stage=2, outcome∈{filed, waived}}`." });
  o("FNMA_A1302_IMPASSE_30", { trigger: "`repurchase.stage.entered`", anchorField: "stage_deadline_on", offset: "0",
    why: "§5.6 timer table: 'FNMA_A1302_IMPASSE_30 / ESCALATION_30 / IDR_RETAINER_15 / NEXT_STAGE_15 | stage entered | stage date | 30 / 30 / 15 / 15 calendar days' — one row for the whole ladder, so the stage's own deadline is the anchor: `stage_deadline_on` = stageDeadline(stage, entered_on) on `repurchase.stage.entered` (enterAppealStage, ops-5-6.ts); satisfied by `repurchase.stage.action_recorded` (recordStageAction)." });
  o("FNMA_IRM_REPURCHASE_AC65_NEXTBD_2000", { satisfied: "`investor_events.submitted{event_type=removal.repurchase}`",
    why: "§5.6 timer table: 'LAR 65/67 submitted' — the platform's LAR 65/67 is the `removal.repurchase` investor event (ACTION_CODE map, ./types.ts; 67 when the ARM modification feature was exercised) and the adapter acknowledgement `investor_events.submitted` carries `event_type`, not the action code (ops-5-1 recordSubmissionAck). Armed by `repurchase.processed{processed_at}` (processRepurchase)." });
  o("FNMA_F120_REPURCHASE_PROCEEDS_BY_TYPE", { trigger: "`repurchase.proceeds.scheduled`", anchorField: "remittance_due_on", offset: "0",
    why: "§5.6 timer table: 'LAR accepted | period | S/S CD18 / MBS Express BD4 / S/A CD20 / A/A immediate (CRS 001 by 16:00 ET)' — the 5.1 acceptance (`investor_events.accepted{event_type=removal.repurchase}`) carries no remittance type, so 5.6 schedules the proceeds from it: `repurchase.proceeds.scheduled{remittance_due_on}` (scheduleRepurchaseProceeds / repurchaseProceedsDue, ops-5-6.ts: S/S standard CD18 and S/A CD20 of the month after the activity period, MBS Express BD4 of the following month, A/A the acceptance day via CRS 001 > $2,500, else the month-end sweep). Satisfied by `remittances.funded{kind=repurchase}` (matchRepurchaseProceeds)." });
  o("SM_REPURCHASE_OWNERSHIP_UPDATE_10BD", { anchorField: "matched_on", why: "§5.6 timer table: 'proceeds matched | match | 10 BD' — `matched_on` on `repurchase.proceeds.matched` (matchRepurchaseProceeds) + 10 servicer business days; satisfied by `repurchase.ownership.updated` (updateRepurchaseOwnership: MERS TOB/TOS + custodian release + `investor` field, all three required)." });
}
