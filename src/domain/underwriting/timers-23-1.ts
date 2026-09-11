/**
 * §23.1 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 23.1 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. A code the servicing spec
 * (sections 1–19) owns is never overridden here — reference it. Wired by src/domain/timer-overrides.ts.
 *
 * Referenced, not overridden: `SM_DU_RESUBMIT_SLA_1BD` (the registry resolves the owning row to 22.5, which arms it
 * on `liabilities.changed{tolerance_result=resubmission_required}` — 23.1's `du.submitted` is the resubmission that
 * closes it), `FNMA_B3_2_02_DU_CLOSE_BY_GATE` (22.3) and `FNMA_B1_1_03_CREDIT_DOCS_4M` (22.1). Every 23.1 event
 * carries `applicationId` (or `source: "origination"` on the platform rows), so the rows arm only under origination
 * context (src/kernel/timers/engine.ts isOriginationContext).
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_23_1(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  o("FNMA_B3_2_01_DU_ARCHIVE_270", { trigger: "`du.findings.received`", anchorField: "last_updated_at", offset: "+270 calendar_days", satisfied: "`du.submitted`",
    why: "§23.1 timer table: deadline (recomputed on every update) on `du.findings.received` / `du.submitted`, anchor `du_casefiles.last_updated_at` (+270 calendar_days; B3-2-01 '270 days from the date on which the loan casefile was last updated'), satisfied by 'any DU update before due (resets), or `du.casefile.superseded`' — the next `du.submitted` is the DU update that resets the clock (ops-23-1.ts submitCasefile; receiveFindings re-arms it on the new findings); breach: day 240 `du.casefile.archive_warning`, day 270 mark `archived`, open a new casefile under current policies, sev 2 to the `underwriter` agent (ops-23-1.ts archivalWatch)." });
  o("FNMA_B3_2_01_DU_ARCHIVE_540", { trigger: "`du.casefile.created`", anchorField: "created_on", offset: "+540 calendar_days", satisfied: "`loan.purchased`",
    why: "§23.1 timer table: deadline on `du.casefile.created`, anchor `du_casefiles.created_at` (+540 calendar_days; 660 for single-closing C-to-P — not built; B3-2-01 '540 days from the date on which the loan casefile was created'), satisfied by '`du.final_submission.recorded` and `loan.purchased` before due' — the purchase (30.1) is the moment Fannie Mae holds the findings, so it closes the clock; breach: same as the 270 row; 'if the loan is already delivered, no action' (archivalWatch marks the archive informational)." });
  o("FNMA_B3_2_10_DU_FINAL_MATCH_GATE", { trigger: "`closing.document_set.opened`", evaluator: "23.1.finalMatchGate", satisfied: "`du.final_submission.recorded{is_final=true, recommendation=approve_eligible}`",
    why: "§23.1 timer table: gate (blocks `generateClosingDocs`, `issueCD` second-pass check, `submitDelivery`) on `closing.document_set.opened` (26.1) / `delivery.uldd.built` (29.3); satisfied by '`du_submissions.is_final=true` with `closed_loan_snapshot_hash` = current closing-data hash and recommendation `approve_eligible`' — evaluated by 23.1.finalMatchGate over the last submission and the closing snapshot (ops-23-1.ts finalMatchGate) and closed by `du.final_submission.recorded{is_final=true, recommendation=approve_eligible}` (recordFinalSubmission); breach: block; auto-resubmit with reason `final_closed_loan_match` (assertFinalSubmissionMatches); if findings change adversely → 23.3 `decision.reopened` via `underwriting_reviewer`." });
  o("FNMA_DU_IMPACT_MEMO_SUPPORT_120", { trigger: "`du.impact_memo.published`", anchorField: "spec_available_on", offset: "+120 calendar_days", satisfied: "`du.adapter.release_tagged`",
    why: "§23.1 timer table: deadline (platform) on 'DU integration impact memo published' — recorded as `du.impact_memo.published` (ops-23-1.ts recordImpactMemo), anchor 'memo date (the memo's own rule anchors on \"the date the related specifications are made available\" — the memo distributes them, so the dates coincide; if a spec ships later, re-anchor to its release date)' = payload `spec_available_on`, +120 calendar_days ('no later than 120 days after the date the related specifications are made available'); satisfied by '`integrations/fnma-du` release tagged for the spec version' = `du.adapter.release_tagged` (tagAdapterRelease); breach: `compliance-sentinel` sev 1 (DU submissions could be rejected)." });
  o("FNMA_DU_RETURN_FILE_16_17_RETIRE", { trigger: "`du.impact_memo.published`", evaluator: "23.1.returnFileTypeGate", satisfied: "`du.return_file_format.confirmed`",
    why: "§23.1 timer table: not_after gate (platform) on the 'DU Sept 25, 2026 memo' (`du.impact_memo.published{return_file_retirement_date}`), 'fixed date Nov 30, 2026', satisfied by '`du.return_file_format` ∈ {json_v2, pdf_standard} in production before Nov 30, 2026' = `du.return_file_format.confirmed` (ops-23-1.ts confirmReturnFileFormat); the gate itself (23.1.returnFileTypeGate / buildDuRequest) blocks requests carrying types 16/17 from Dec 1, 2026 ('The requested Return File Types of 16 (Enhanced HTML) and 17 (PDF) will be retired on November 30, 2026')." });
}
