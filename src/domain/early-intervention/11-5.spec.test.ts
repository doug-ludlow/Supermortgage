// 11.5 Imminent default evaluation
// spec/sections/11-early-intervention-collections/11-5-imminent-default-evaluation.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { evaluate, hti, type Evaluation } from "./imminent-default.ts";
import { adverseNoticeSchedule, counterofferAcceptance, bspSendCheck, brpCompleteness, coloradoDecisionFlow, smduB2bOutage, completePortalTask, evaluationMatrix, chapter13Substitution } from "./ops.ts";

// 11.5-T1 — implemented in src/domain/early-intervention/early-intervention.test.ts
// 11.5-T2 — implemented in src/domain/early-intervention/early-intervention.test.ts
// 11.5-T3 — implemented in src/domain/early-intervention/early-intervention.test.ts
// 11.5-T4 — implemented in src/domain/early-intervention/early-intervention.test.ts
// 11.5-T5 — implemented in src/domain/early-intervention/early-intervention.test.ts
// 11.5-T6 — implemented in src/domain/early-intervention/early-intervention.test.ts
test("11.5-T7: Given a current borrower declined by SMDU on 2026-10-21 with no counteroffer, then a Form 182/Reg B combined notice is due 2026-11-19 (earlier of 11-19 and 11-20) and issues only after `lossmit_reviewer` approval.", () => {
  const held = adverseNoticeSchedule({ declined_on: D("2026-10-21"), brp_complete_on: D("2026-10-20"), current_at_evaluation: true, counteroffer_accepted: false, reviewer_id: null });
  assert.equal(held.form182_due, D("2026-11-20")); assert.equal(held.regb_due, D("2026-11-19")); assert.equal(held.combined_due, D("2026-11-19")); assert.equal(held.can_issue, false); assert.match(held.blocked_by!, /reviewer_id/);
  assert.equal(adverseNoticeSchedule({ declined_on: D("2026-10-21"), brp_complete_on: D("2026-10-20"), current_at_evaluation: true, counteroffer_accepted: false, reviewer_id: "reviewer-42" }).can_issue, true);
});
test("11.5-T8: Given a counteroffer accepted on day 10 of the 14-day window, then `FNMA_D2101_FORM182_ADVERSE_30` is cancelled.", () => {
  assert.deepEqual(counterofferAcceptance({ offer_sent_on: D("2026-10-23"), accepted_on: D("2026-11-02") }), { within_window: true, form182_timer: "cancelled" });
  assert.equal(counterofferAcceptance({ offer_sent_on: D("2026-10-23"), accepted_on: D("2026-11-07") }).form182_timer, "running");
});
test("11.5-T9: Given a borrower 12 days delinquent who has not asked for help, then any Form 745/BSP send is refused by `FNMA_D2101_NO_SOLICIT_LT30`; given the borrower asks \"what help is there?\" on a call, then the BSP is permitted with the request logged.", () => {
  const refused = bspSendCheck({ regx_days: 12, borrower_asked_for_help: false });
  assert.equal(refused.permitted, false); assert.equal(refused.refused_by, "FNMA_D2101_NO_SOLICIT_LT30");
  const asked = bspSendCheck({ regx_days: 12, borrower_asked_for_help: true, request_logged_at: "2026-10-12T15:04:00Z" });
  assert.equal(asked.permitted, true); assert.match(asked.basis!, /borrower request logged 2026-10-12/);
});
test("11.5-T10: Given income documents dated 95 days before completeness, then the BRP is incomplete and the 12.1 missing-items notice lists them.", () => {
  const r = brpCompleteness({ completeness_on: D("2026-10-20"), documents: [{ kind: "pay stub", dated: D("2026-07-17") }, { kind: "bank statement", dated: D("2026-10-01") }] });
  assert.equal(r.complete, false); assert.equal(r.missing_items.length, 1); assert.match(r.missing_items[0]!, /pay stub dated 2026-07-17/); assert.equal(r.notice, "NTC_REGX_41B2_ACK_INCOMPLETE");
  assert.equal(brpCompleteness({ completeness_on: D("2026-10-20"), documents: [{ kind: "pay stub", dated: D("2026-07-17") }], disaster_impacted: true }).complete, true);
});
test("11.5-T11: Given a Colorado loan with an AI-influenced ineligible result, then the pre-decision notice precedes the determination, the explanation lists the failed tests, and the appeal channel is offered.", () => {
  const r = coloradoDecisionFlow({ state: "CO", ai_influenced: true, result: { outcome: "ineligible", failed: ["cash_reserves", "fico_gt_620"] } });
  assert.deepEqual([...r.steps], ["NTC_CO_AI_ACT_PRE_DECISION", "determination"]); assert.deepEqual([...r.explanation], ["cash_reserves", "fico_gt_620"]); assert.match(r.appeal_channel!, /appeal/);
  assert.deepEqual([...coloradoDecisionFlow({ state: "TX", ai_influenced: true, result: { outcome: "ineligible", failed: ["occupancy"] } }).steps], ["determination"]);
});
test("11.5-T12: Given SMDU B2B unavailable for 5 hours, then a `human_portal_task` with the full package is created and completed within 1 Fannie Mae BD, and the decision PDF is attached to the evaluation.", () => {
  const r = smduB2bOutage({ unavailable_hours: 5, created_on: D("2026-10-21"), package: { loan: "L1", hardship: "death_of_borrower_or_wage_earner", imminent_default_indicator: true } });
  assert.equal(r.human_portal_task!.kind, "smdu"); assert.equal(r.human_portal_task!.owner_role, "fnma_portal_operator"); assert.equal(r.human_portal_task!.due, D("2026-10-22")); assert.equal(r.human_portal_task!.package.loan, "L1");
  assert.deepEqual(completePortalTask({ decision_pdf_document_id: "doc-smdu-1" }), { completed: true, attached: true });
  assert.equal(smduB2bOutage({ unavailable_hours: 2, created_on: D("2026-10-21"), package: {} }).retry, true);
});
test("11.5-T13: Given AI mode off, then the deterministic evaluation job produces the same test matrix for examples A and B (golden-file comparison) and the reviewer/notice steps are unchanged.", () => {
  const A: Evaluation = { evaluation_date: D("2026-10-20"), regx_days_delinquent: 0, principal_residence: true, brp_complete: true, oldest_doc_date: D("2026-09-26"), cash_reserves_cents: 840000n, hardship_type: "death_of_borrower_or_wage_earner", hardship_documented: true };
  const Bx: Evaluation = { ...A, hardship_type: "reduction_in_income", credit: { scores: [601, 612, 620], fico_date: D("2026-10-20"), delinquencies_30_in_6m: 1, pitia_cents: 241250n, gross_income_cents: 560000n } };
  const goldenA = { outcome: "eligible_hardship", path: "modification", tests: { occupancy: true, brp_complete: true, doc_age: true, cash_reserves: true } };
  const goldenB = { outcome: "eligible_credit", path: "modification", tests: { occupancy: true, brp_complete: true, doc_age: true, cash_reserves: true, fico: true, fico_age: true, delinquency: false, hti: true } };
  for (const ai of [false, true]) { assert.deepEqual(evaluationMatrix(A, ai).result, goldenA); assert.deepEqual(evaluationMatrix(Bx, ai).result, goldenB); assert.equal(evaluationMatrix(A, ai).reviewer_step, "lossmit_reviewer_on_adverse"); }
  assert.deepEqual(evaluationMatrix(A, false).result, evaluationMatrix(A, true).result);
});
test("11.5-T14: Given a Chapter 13 debtor, then bankruptcy schedules \u226490 days old substitute for Form 710 and communications go through counsel.", () => {
  const r = chapter13Substitution({ chapter: 13, schedules_dated: D("2026-08-01"), evaluation_date: D("2026-10-20") });
  assert.equal(r.substitute_for_form_710, true); assert.equal(r.schedule_age_days, 80); assert.equal(r.communications, "through_counsel");
  assert.equal(chapter13Substitution({ chapter: 13, schedules_dated: D("2026-07-01"), evaluation_date: D("2026-10-20") }).substitute_for_form_710, false);
  assert.equal(chapter13Substitution({ chapter: 7, schedules_dated: D("2026-10-01"), evaluation_date: D("2026-10-20") }).communications, "borrower");
});

test("11.5 worked figures: PITIA $2,412.50 = $1,650.00 + $612.50 + $150.00; income $5,600.00 → HTI 0.43 passes; $6,031.25 → 0.40 fails; reserves $8,400.00", () => {
  assert.equal(165000n + 61250n + 15000n, 241250n);
  assert.equal(hti(241250n, 560000n).pass, true); assert.equal(hti(241250n, 560000n).display, "0.43"); assert.equal(hti(241250n, 603125n).pass, false);
  assert.ok(840000n < 2500000n);
  const e: Evaluation = { evaluation_date: D("2026-10-20"), regx_days_delinquent: 0, principal_residence: true, brp_complete: true, oldest_doc_date: D("2026-09-26"), cash_reserves_cents: 840000n, hardship_type: "reduction_in_income", hardship_documented: true, credit: { scores: [601, 612, 620], fico_date: D("2026-10-20"), delinquencies_30_in_6m: 1, pitia_cents: 241250n, gross_income_cents: 603125n } };
  assert.equal(evaluate(e).outcome, "ineligible");
});
