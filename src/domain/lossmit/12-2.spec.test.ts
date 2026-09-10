// 12.2 Complete-application evaluation
// spec/sections/12-loss-mitigation/12-2-complete-application-evaluation.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { denialNoticeContent, thirdPartyDelay, imminentDefaultDecline, appealExtendsAcceptance, caDenialHolds, smduOutageEvaluation, counselInstruction, streamlinedSolicitationWithOpenApp } from "./ops.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";

// 12.2-T1 — implemented in src/domain/lossmit/lossmit.test.ts
// 12.2-T2 — implemented in src/domain/lossmit/lossmit.test.ts
test("12.2-T3: (denial content) Flex Mod denied because \"loan has been modified three times previously\" \u2192 notice names Fannie Mae, quotes the criterion, states other criteria not evaluated; `lossmit_reviewer` approval recorded before mailing; mailing blocked without approval.", () => {
  const blocked = denialNoticeContent({ investor: "Fannie Mae", option: "Flex Modification", criterion: "loan has been modified three times previously" });
  assert.equal(blocked.names_investor, true); assert.equal(blocked.quotes_criterion, true); assert.equal(blocked.other_criteria_statement, "Other eligibility criteria were not evaluated."); assert.equal(blocked.mailing_allowed, false); assert.match(blocked.refusal!, /lossmit_reviewer/);
  const ok = denialNoticeContent({ investor: "Fannie Mae", option: "Flex Modification", criterion: "loan has been modified three times previously", reviewer_approval_id: "rev-1" });
  assert.equal(ok.mailing_allowed, true); assert.equal(ok.refusal, null);
});
// 12.2-T4 — implemented in src/domain/lossmit/lossmit.test.ts
test("12.2-T5: (third-party delay) BPO outstanding at day 30 \u2192 delay notice plus all determinable results sent by day 30; on BPO receipt day 38, short-sale determination sent within 5 days; `foreclosure_holds{kind=lm_third_party_pending}` held throughout.", () => {
  const r = thirdPartyDelay({ complete_on: D("2026-10-01"), item: "BPO", received_on: D("2026-11-08") });
  assert.equal(r.day30, "2026-10-31"); assert.equal(r.delay_notice_by, "2026-10-31"); assert.equal(r.determinable_results_by, "2026-10-31"); assert.equal(r.notice, "NTC_REGX_41C4IIB_THIRD_PARTY_DELAY");
  assert.equal(r.determination_by, "2026-11-13"); assert.equal(r.hold.kind, "lm_third_party_pending"); assert.equal(r.hold.from, "2026-10-01"); assert.equal(r.hold.to, "2026-11-13"); assert.equal(r.hold.active, true);
});
test("12.2-T6: (current borrower, Fannie Mae declines) imminent-default case declined in SMDU \u2192 Form 182-based notice within 30 days; Reg B timer satisfied; counteroffer accepted \u2192 timers cancelled with reason.", () => {
  const r = imminentDefaultDecline({ complete_on: D("2026-10-20"), decided_on: D("2026-11-05"), notice_provided_on: D("2026-11-10"), counteroffer_accepted_on: D("2026-11-15") });
  assert.equal(r.notice_code, "NTC_REGB_1002_9_LM_ADVERSE_ACTION"); assert.equal(r.form_basis, "Form 182"); assert.equal(r.notice_by, "2026-11-19"); assert.equal(r.on_time, true); assert.equal(r.reg_b_timer.status, "satisfied");
  assert.equal(r.cancelled.length, 3); assert.ok(r.cancelled.every((c) => c.reason === "counteroffer accepted 2026-11-15"));
});
// 12.2-T7 — implemented in src/domain/lossmit/lossmit.test.ts
test("12.2-T8: (appeal extends acceptance) appeal filed day 10 \u2192 original offer `accept_by` becomes appeal notice + 14.", () => {
  const r = appealExtendsAcceptance({ original_accept_by: D("2026-11-03"), appeal_filed_on: D("2026-10-30"), appeal_notice_provided_on: D("2026-11-25") });
  assert.equal(r.accept_by, "2026-12-09"); assert.equal(r.extended, true); assert.equal(r.timer, "REGX_1024_41E2III_ORIGINAL_OFFER_EXTENDED");
});
// 12.2-T9 — implemented in src/domain/lossmit/lossmit.test.ts
test("12.2-T10: (CA) denial \u2192 `CA_CIV_2923_6E_NOD_NOS_HOLD_31`; 13.x NOD command refused on day 20; appeal window 30 days shown in notice.", () => {
  const r = caDenialHolds({ denial_provided_on: D("2026-10-20"), nod_requested_on: D("2026-11-09") });
  assert.equal(r.timer, "CA_CIV_2923_6E_NOD_NOS_HOLD_31"); assert.equal(r.hold_until, "2026-11-20"); assert.equal(r.nod_allowed, false); assert.match(r.refusal!, /CA_CIV_2923_6E_NOD_NOS_HOLD_31/); assert.equal(r.appeal_window_days, 30); assert.equal(r.appeal_by, "2026-11-19");
  assert.equal(caDenialHolds({ denial_provided_on: D("2026-10-20"), nod_requested_on: D("2026-11-20") }).nod_allowed, true);
});
test("12.2-T11: (SMDU outage) B2B down 6 hours at day 24 \u2192 portal task filed with package; decision recorded from the operator's SMDU result; notice on time.", () => {
  const r = smduOutageEvaluation({ complete_on: D("2026-10-01"), outage_on: D("2026-10-25"), outage_hours: 6, operator_result: { decision: "approve", smdu_case_id: "SMDU-9", completed_on: D("2026-10-26") }, notice_provided_on: D("2026-10-29") });
  assert.equal(r.day_of_outage, 24); assert.deepEqual(r.portal_task, { kind: "human_portal_task", package_attached: true, filed_on: "2026-10-25" }); assert.deepEqual(r.decision, { source: "operator_smdu_result", decision: "approve", smdu_case_id: "SMDU-9" }); assert.equal(r.notice_by, "2026-10-31"); assert.equal(r.on_time, true);
});
test("12.2-T12: (counsel) hold set on a loan with a pending summary-judgment motion \u2192 instruction sent within 1 BD and acknowledged; a sale conducted anyway is detected by the 13.x sale-event reconciliation and raises a sev-1 NoE-risk incident.", () => {
  const r = counselInstruction({ hold_set_on: D("2026-10-20"), motion_pending: true, instruction_sent_on: D("2026-10-21"), acknowledged_on: D("2026-10-21"), sale_conducted_on: D("2026-11-02") });
  assert.equal(r.instruction_due, "2026-10-21"); assert.equal(r.sent_on_time, true); assert.equal(r.acknowledged, true); assert.equal(r.incident!.kind, "officer"); assert.equal(r.incident!.severity, "sev1"); assert.match(r.incident!.reason, /NoE risk/);
  assert.equal(counselInstruction({ hold_set_on: D("2026-10-20"), motion_pending: true, instruction_sent_on: D("2026-10-21"), acknowledged_on: D("2026-10-21") }).incident, null);
});
test("12.2-T13: (streamlined offer with open incomplete application) day-90 Flex Mod solicitation issued while an incomplete application is open \u2192 letter includes incomplete-application disclosures; diligence follow-ups continue; no (c)(1) clock started by the solicitation.", () => {
  const r = streamlinedSolicitationWithOpenApp({ open_incomplete_application: true, day: 90 });
  assert.equal(r.disclosures_included, true); assert.equal(r.diligence_follow_ups_continue, true); assert.equal(r.c1_clock_started, false); assert.equal(r.letter, "NTC_FNMA_D23206_SOLICIT_STREAMLINED");
  const reg = buildRegistry(); publishAuthored(reg); const v = reg.activeVersion("NTC_FNMA_D23206_SOLICIT_STREAMLINED", D("2026-11-10"))!;
  const payload = { ...v.samplePayload, open_incomplete_application: true, reasonable_date: "2026-11-30" }; const out = render(v.source, payload);
  assert.match(out.text, /application on file that is incomplete/); assert.equal(evaluateChecklist(v, payload, out).passed, true);
  assert.equal(evaluateChecklist(v, { ...payload, reasonable_date: undefined }, render(v.source, { ...payload, reasonable_date: undefined })).passed, false);
});
