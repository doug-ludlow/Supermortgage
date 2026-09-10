import re, pathlib
root = pathlib.Path("src/domain/foreclosure")
HEAD = {
"13-1": '''import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { occupancyDefault, preFilingAppHold, exceptionGround, nyFirstNoticeGate, refusedReferral, ruleSetSwap, transferredFirstFiling } from "./ops.ts";
''',
"13-2": '''import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { holdExitAndCertification, pendingMotion, mnReferralGate, unacknowledgedPostponement, certificationDmdcCheck, rescissionAfterViolation } from "./ops.ts";
''',
"13-3": '''import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { referralPackage, nonPrReferral, mersAssignmentGate, ny1304, firmDocumentRequest, bankruptcyAfterReferral, reserveFallback, preSaleInspectionStop, transferredFirstFiling } from "./ops.ts";
import { totalIndebtedness, bid, thirdPartySale, reinstatementQuote } from "./referral.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
''',
"13-4": '''import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { offerWindowHold, nonPrLadder, disasterHold, scraHold, maLeadPaintItem, expeditedReview, modelItemGate, siiStatusItem, bankruptcyScrubItem, DISASTER_REQUEST_ELEMENTS } from "./ops.ts";
import type { Gates } from "./referral.ts";
''',
"13-5": '''import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { exhibitVersionFor, timeframeWarning, rescissionExposure, contestedCredits, billReceived, methodDeviation } from "./ops.ts";
import { exposure } from "./timeframes.ts";
''',
"13-6": '''import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { suspensionGate, draPostponementCheck, feeApproval, scorecardReview } from "./ops.ts";
import { reviewInvoice, feeEarned } from "./firms.ts";
''',
"13-7": '''import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { maLeadPaintItem, appealFilingGate, pleadingReviewGate, quatroOutage, workoutCounselGate } from "./ops.ts";
''',
"13-8": '''import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { boardingDmdc, openScraCase, affidavitGate, certificationDmdcCheck, dmdcOutageBeforeSale, zResult, saleInViolation, waiverRequest, protectionTail } from "./ops.ts";
import { protectionEndsOn, fcGateClosed } from "./scra.ts";
''',
"13-9": '''import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { form1022Schedule, lateChargeWaiver, overpaymentElection, defaultElection, assertedServiceWithoutEvidence, lateRequest } from "./ops.ts";
import { recalculate, servicingFee } from "./scra.ts";
import { balanceAfter } from "../lossmit/flexmod.ts";
''',
}
B = {}
B["13.1-T4"] = '''
  assert.deepEqual(occupancyDefault({ occupancy: "unknown" }), { treated_as: "principal_residence", escalation: null });
  const r = occupancyDefault({ occupancy: "unknown", model_conclusion: { non_principal: true, confidence: 0.85 } });
  assert.equal(r.treated_as, "principal_residence"); assert.equal(r.escalation!.kind, "human_agent"); assert.match(r.escalation!.reason, /0\\.85/);
  assert.equal(occupancyDefault({ occupancy: "unknown", model_conclusion: { non_principal: true, confidence: 0.95 } }).treated_as, "non_principal");
'''
B["13.1-T5"] = '''
  const eu = D("2026-03-01"); const day = (n: number) => D(new Date(Date.parse(eu) + n * 86_400_000).toISOString().slice(0, 10));
  const r = preFilingAppHold({ earliest_unpaid_due: eu, complete_received_on: day(100), determination_sent_on: day(118), appeal_available: true, referral_attempt_on: day(121) });
  assert.equal(r.day_of_attempt, 121); assert.equal(r.state, "closed"); assert.equal(r.opens_on, day(133)); assert.match(r.refusal!, /REGX_1024_41F2_PRE_FILING_APP_GATE until/);
  assert.equal(preFilingAppHold({ earliest_unpaid_due: eu, complete_received_on: day(100), determination_sent_on: day(118), appeal_available: true, referral_attempt_on: day(133) }).state, "open");
  assert.equal(preFilingAppHold({ earliest_unpaid_due: eu, complete_received_on: day(100), determination_sent_on: day(118), appeal_available: true, appeal_denied_on: day(125), referral_attempt_on: day(126) }).state, "open");
'''
B["13.1-T6"] = '''
  const base = { recorded_by_role: "officer", counsel_memo_document_id: "memo-1", today: D("2026-04-30"), earliest_unpaid_due: D("2026-03-01"), principal_residence: true };
  const dos = exceptionGround({ ...base, ground: "due_on_sale" }); assert.equal(dos.allowed, true); assert.equal(dos.state, "exception_open");
  const def = exceptionGround({ ...base, ground: "default" }); assert.equal(def.allowed, false); assert.equal(def.state, "closed"); assert.match(def.refusal!, /120_DAY_GATE/);
  assert.equal(exceptionGround({ ...base, ground: "due_on_sale", recorded_by_role: "ops_analyst" }).allowed, false);
'''
B["13.1-T7"] = '''
  const r = nyFirstNoticeGate({ today: D("2026-06-30"), earliest_unpaid_due: D("2026-03-01"), s1304_mailed_on: D("2026-05-11"), s1306_filed: false });
  assert.equal(r.referral_allowed, true); assert.equal(r.first_notice_allowed, false); assert.equal(r.gate, "STATE_PREFC_NOTICE_GATE:NY"); assert.equal(r.opens_on, "2026-08-09"); assert.match(r.refusal!, /§1306 filing evidence/);
  assert.equal(nyFirstNoticeGate({ today: D("2026-08-09"), earliest_unpaid_due: D("2026-03-01"), s1304_mailed_on: D("2026-05-11"), s1306_filed: true }).first_notice_allowed, true);
'''
B["13.1-T8"] = '''
  const r = refusedReferral({ gate: "REGX_1024_41F1_120_DAY_GATE", opens_on: D("2026-06-30"), attempted_on: D("2026-06-01"), actor: "foreclosure-ops" });
  assert.equal(r.refused, true); assert.equal(r.event.type, "foreclosure.gate.refused"); assert.equal(r.escalation.severity, "sev1"); assert.equal(r.attorney_message_sent, false);
'''
B["13.1-T9"] = '''
  const before = ruleSetSwap({ effective_on: D("2027-01-01"), evaluation_on: D("2026-12-31") }); assert.equal(before.rule_set, "regx.lossmit.2013"); assert.ok(before.gate_codes.includes("REGX_1024_41F2_PRE_FILING_APP_GATE"));
  const after = ruleSetSwap({ effective_on: D("2027-01-01"), evaluation_on: D("2027-01-01") }); assert.equal(after.rule_set, "regx.lossmit.2024nprm"); assert.ok(after.gate_codes.includes("NPRM_REVIEW_CYCLE_GATE"));
  assert.deepEqual(after.diff, { added: ["NPRM_REVIEW_CYCLE_GATE", "NPRM_FEE_FREEZE"], removed: ["REGX_1024_41F2_PRE_FILING_APP_GATE"] });
'''
B["13.1-T10"] = '''
  const r = transferredFirstFiling({ transferor_first_notice_filed_at: D("2026-05-20"), transferor_state_prefc_notice_sent: true, transferor_lpi_due: D("2026-01-01") });
  assert.equal(r.second_first_notice_allowed, false); assert.equal(r.statement_flag_from_boarding, true); assert.equal(r.resend_state_prefc_notice, false);
'''
B["13.2-T2"] = '''
  const r = holdExitAndCertification({ determination_sent_on: D("2026-10-10"), appeal_available: false, sale_on: D("2026-11-03"), certify_on: D("2026-10-20") });
  assert.equal(r.hold_closes_on, "2026-10-10"); assert.deepEqual(r.window, { opens: "2026-10-19", closes: "2026-10-27" }); assert.equal(r.certification_permitted, true);
  assert.equal(holdExitAndCertification({ determination_sent_on: D("2026-10-10"), appeal_available: false, sale_on: D("2026-11-03"), certify_on: D("2026-10-28") }).certification_permitted, false);
  assert.equal(holdExitAndCertification({ determination_sent_on: D("2026-10-10"), appeal_available: false, sale_on: D("2026-11-03"), certify_on: D("2026-10-18") }).certification_permitted, false);
'''
B["13.2-T4"] = '''
  const r = pendingMotion({ application_received_on: D("2026-10-01"), motion_pending: true, firm_filed_request: true, court_ruled_anyway: true });
  assert.equal(r.instruction, "WITHDRAW_MOTION"); assert.deepEqual(r.compliance_evidence, ["instruction:WITHDRAW_MOTION", "firm_filed_request"]); assert.equal(r.breach, false);
  assert.equal(pendingMotion({ application_received_on: D("2026-10-01"), motion_pending: true, firm_filed_request: false, court_ruled_anyway: true }).breach, true);
'''
B["13.2-T6"] = '''
  const r = mnReferralGate({ state: "MN", application_status: "pending_incomplete" }); assert.equal(r.allowed, false); assert.match(r.refusal!, /582\\.043/);
  assert.equal(mnReferralGate({ state: "MN", application_status: "closed" }).allowed, true); assert.equal(mnReferralGate({ state: "TX", application_status: "pending_incomplete" }).allowed, true);
'''
B["13.2-T7"] = '''
  const r = unacknowledgedPostponement({ instruction_sent_on: D("2026-10-20"), acknowledged_on: null, dra_postponement_event_on: null, today: D("2026-10-23") });
  assert.equal(r.ack_due, "2026-10-21"); assert.equal(r.escalation!.kind, "attorney"); assert.equal(r.phone_task, true); assert.equal(r.dra_expected_by, "2026-10-22"); assert.equal(r.dra_exception, true);
  assert.equal(unacknowledgedPostponement({ instruction_sent_on: D("2026-10-20"), acknowledged_on: D("2026-10-21"), dra_postponement_event_on: D("2026-10-22"), today: D("2026-10-23") }).escalation, null);
'''
B["13.2-T9"] = '''
  const r = certificationDmdcCheck({ sale_on: D("2026-11-03"), check_on: D("2026-10-20"), active_duty: true });
  assert.equal(r.in_window, true); assert.equal(r.certification, "withheld"); assert.equal(r.instruction, "POSTPONE_SALE"); assert.equal(r.violation_suspected, false);
  assert.equal(certificationDmdcCheck({ sale_on: D("2026-11-03"), check_on: D("2026-10-20"), active_duty: false }).instruction, "CERTIFY_SALE");
'''
B["13.2-T10"] = '''
  const r = rescissionAfterViolation({ sale_on: D("2026-11-03"), violation: "dual_tracking", third_party_costs_cents: 45_000n });
  assert.equal(r.flow, "15.1.rescission"); assert.equal(r.exposure_cents, 145_000n); assert.equal(r.root_cause, "servicer:dual_tracking"); assert.deepEqual(r.escalations.map((e) => e.kind), ["attorney", "officer"]);
'''
B["13.3-T1"] = '''
  const r = referralPackage({ referral_on: D("2026-06-30"), day: 121, principal_residence: true, review_outcome: "refer", documents: [{ id: "note", sha256: "a1" }, { id: "mortgage", sha256: "b2" }] });
  assert.equal(r.allowed, true); assert.deepEqual(r.manifest, [{ id: "note", sha256: "a1" }, { id: "mortgage", sha256: "b2" }]); assert.equal(r.referral_sent_at, "2026-06-30"); assert.equal(r.status_code, "43"); assert.equal(r.firm_ack_due, "2026-07-02");
  assert.equal(referralPackage({ referral_on: D("2026-06-29"), day: 120, principal_residence: true, review_outcome: "refer", documents: [{ id: "note", sha256: "a1" }] }).allowed, false);
'''
B["13.3-T2"] = '''
  const a = nonPrReferral({ earliest_unpaid_due: D("2026-03-01"), today: D("2026-06-27") }); assert.equal(a.day, 118); assert.equal(a.refer_by, "2026-06-29"); assert.equal(a.postponement, null);
  const b = nonPrReferral({ earliest_unpaid_due: D("2026-03-01"), today: D("2026-06-28"), complete_brp_on: D("2026-06-28") }); assert.equal(b.postponement, "E-3.2-04"); assert.equal(b.deadline_suspended, true);
'''
B["13.3-T3"] = '''
  const r = mersAssignmentGate({ mers_mortgagee: true, pre_recordation_state: true, assignment_recorded_on: null, gates_open_on: D("2026-06-30") }); assert.equal(r.allowed, false); assert.match(r.refusal!, /unrecorded/);
  assert.deepEqual(mersAssignmentGate({ mers_mortgagee: true, pre_recordation_state: true, assignment_recorded_on: D("2026-06-10"), gates_open_on: D("2026-06-30") }), { allowed: true, allowed_from: "2026-06-30", refusal: null });
'''
B["13.3-T4"] = '''
  const r = ny1304({ mailed_on: D("2026-07-01"), county_agencies: ["a", "b", "c", "d", "e"], certified_mail_evidence: true, first_class_evidence: true, s1306_filed_on: D("2026-07-03"), first_notice_requested_on: D("2026-09-29") });
  assert.equal(r.checklist_passed, true); assert.equal(r.s1306_due, "2026-07-07"); assert.equal(r.s1306_on_time, true); assert.equal(r.first_notice_allowed_from, "2026-09-29"); assert.equal(r.first_notice_allowed, true);
  assert.equal(ny1304({ ...{ mailed_on: D("2026-07-01"), county_agencies: ["a", "b", "c", "d"], certified_mail_evidence: true, first_class_evidence: true, s1306_filed_on: D("2026-07-03"), first_notice_requested_on: D("2026-09-29") } }).checklist_passed, false);
  assert.equal(ny1304({ mailed_on: D("2026-07-01"), county_agencies: ["a", "b", "c", "d", "e"], certified_mail_evidence: true, first_class_evidence: true, s1306_filed_on: D("2026-07-03"), first_notice_requested_on: D("2026-09-28") }).first_notice_allowed, false);
  const reg = buildRegistry(); publishAuthored(reg); const v = reg.activeVersion("NTC_STATE_PREFC_NY_1304", D("2026-09-01"))!; const out = render(v.source, v.samplePayload);
  assert.match(out.text, /YOU MAY BE AT RISK OF FORECLOSURE/); assert.equal(evaluateChecklist(v, v.samplePayload, out).passed, true);
  const four = { ...v.samplePayload, agencies: ["a", "b", "c", "d"], agency_count: 4 }; assert.equal(evaluateChecklist(v, four, render(v.source, four)).passed, false);
  assert.equal(reg.template("NTC_STATE_PREFC_NY_1304").channelPolicy, "mail_only");
'''
B["13.3-T8"] = '''
  const r = firmDocumentRequest({ requested_on: D("2026-07-06"), fulfilled_on: null, today: D("2026-07-10") });
  assert.equal(r.due, "2026-07-09"); assert.equal(r.breached, true); assert.equal(r.escalation!.severity, "sev1"); assert.equal(r.comp_fee_exposure_flag, true);
  assert.equal(firmDocumentRequest({ requested_on: D("2026-07-06"), fulfilled_on: D("2026-07-08"), today: D("2026-07-10") }).breached, false);
'''
B["13.3-T9"] = '''
  const a = bankruptcyAfterReferral({ firm_id: "firm-1", petition_on: D("2026-08-03") }); assert.equal(a.notify_firm_by, "2026-08-04"); assert.equal(a.case_status, "on_hold_bankruptcy"); assert.equal(a.referral_back_to, null);
  const b = bankruptcyAfterReferral({ firm_id: "firm-1", petition_on: D("2026-08-03"), relief_on: D("2026-10-01") }); assert.equal(b.case_status, "active"); assert.equal(b.referral_back_to, "firm-1");
'''
B["13.3-T10"] = '''
  const r = reserveFallback({ reserve_cents: 31_000_000n, reserve_expires_on: D("2026-11-20"), sale_on: D("2026-12-08"), refresh_available_by: null, total_indebtedness_cents: 28_150_946n });
  assert.equal(r.basis, "indebtedness"); assert.equal(r.max_bid_cents, 28_150_946n); assert.match(r.rationale, /expired 2026-11-20 before the rescheduled sale 2026-12-08/);
  assert.equal(reserveFallback({ reserve_cents: 27_000_000n, reserve_expires_on: D("2026-11-20"), sale_on: D("2026-11-03"), refresh_available_by: null, total_indebtedness_cents: 28_150_946n }).basis, "reserve");
'''
B["13.3-T11"] = '''
  const r = preSaleInspectionStop({ major_damage: true, insured: false, damage_kind: "fire damage" }); assert.equal(r.issue_bid, false); assert.equal(r.task!.kind, "servicing_representative_contact"); assert.match(r.task!.reason, /fire damage/);
  assert.equal(preSaleInspectionStop({ major_damage: true, insured: true }).issue_bid, true);
'''
B["13.3-T12"] = '''
  const r = transferredFirstFiling({ transferor_first_notice_filed_at: D("2026-05-20"), transferor_state_prefc_notice_sent: true, transferor_lpi_due: D("2025-12-01") });
  assert.equal(r.resend_state_prefc_notice, false); assert.equal(r.timeframe_lpi_due, "2025-12-01"); assert.equal(r.second_first_notice_allowed, false);
'''
B["13.4-T2"] = '''
  assert.deepEqual(offerWindowHold({ window_ends_on: D("2026-07-04"), today: D("2026-07-01"), accepted: false }), { outcome: "hold_lossmit" });
  assert.deepEqual(offerWindowHold({ window_ends_on: D("2026-07-04"), today: D("2026-07-05"), accepted: false }), { outcome: "refer" });
  assert.deepEqual(offerWindowHold({ window_ends_on: D("2026-07-04"), today: D("2026-07-05"), accepted: true }), { outcome: "hold_performing" });
'''
B["13.4-T3"] = '''
  const eu = D("2026-03-01");
  const a = nonPrLadder({ earliest_unpaid_due: eu, complete_brp_on: D("2026-06-28") }); assert.equal(a.outcome, "postpone_e3204"); assert.equal(a.state, "brp_pending");
  const b = nonPrLadder({ earliest_unpaid_due: eu, complete_brp_on: D("2026-06-28"), offer_sent_on: D("2026-07-19") }); assert.equal(b.offer_expires_on, "2026-08-02"); assert.equal(b.state, "offer_window");
  const c = nonPrLadder({ earliest_unpaid_due: eu, complete_brp_on: D("2026-06-28"), offer_sent_on: D("2026-07-19"), accepted_on: D("2026-07-29"), first_payment_due: D("2026-08-01") }); assert.equal(c.held_until, "2026-08-31"); assert.equal(c.state, "awaiting_first_payment");
  const d = nonPrLadder({ earliest_unpaid_due: eu, complete_brp_on: D("2026-06-28"), offer_sent_on: D("2026-07-19"), accepted_on: D("2026-07-29"), first_payment_due: D("2026-08-01"), first_payment_received: true }); assert.equal(d.state, "performing_until_breach"); assert.equal(d.held_until, null);
'''
B["13.4-T4"] = '''
  const req = Object.fromEntries(DISASTER_REQUEST_ELEMENTS.map((e) => [e, "provided"]));
  const held = disasterHold({ fema_ia: true, inspection_damage: true, review_completed_on: D("2026-06-25"), request: req });
  assert.equal(held.outcome, "hold_disaster_approval"); assert.equal(held.request_due, "2026-06-30"); assert.equal(held.elements_present.length, 5); assert.deepEqual(held.elements_missing, []); assert.equal(held.gate, "closed");
  assert.equal(disasterHold({ fema_ia: true, inspection_damage: true, review_completed_on: D("2026-06-25"), request: { recommendation: "foreclose" } }).elements_missing.length, 4);
  const approved = disasterHold({ fema_ia: true, inspection_damage: true, review_completed_on: D("2026-06-25"), request: req, fnma_approval_id: "FNMA-D-1" }); assert.equal(approved.outcome, "refer"); assert.equal(approved.gate, "open");
'''
B["13.4-T5"] = '''
  const gates: Gates = { regx_120: true, regx_prefiling: true, no_first_filing_41k2: true, fnma_121: true, bk_stay: false, scra: false, dmdc_age_days: 10, disaster_approval: true, litigation_hold: false, environmental_hold: false, mn_dual_track: false, title_hold: false, package_ready: true };
  const r = scraHold({ active_duty: true, items_all_pass: true, gates }); assert.equal(r.outcome, "hold_scra"); assert.equal(r.referral.ok, false);
  assert.equal(scraHold({ active_duty: false, items_all_pass: true, gates }).referral.ok, true);
'''
B["13.4-T6"] = '''
  const r = maLeadPaintItem({ state: "MA" }); assert.equal(r.required, true); assert.equal(r.passed, false); assert.match(r.refusal!, /lead-paint citation search/);
  assert.equal(maLeadPaintItem({ state: "MA", citation_search_document_id: "doc-lp" }).passed, true); assert.equal(maLeadPaintItem({ state: "TX" }).required, false);
'''
B["13.4-T7"] = '''
  const npr = expeditedReview({ vacant_inspections: 2, utilities_off: true, principal_residence: false, breach_letter_expired: true, day: 70 }); assert.equal(npr.expedite_condition, true); assert.equal(npr.outcome, "refer_expedited"); assert.equal(npr.regx_blocks_until_day, null);
  const pr = expeditedReview({ vacant_inspections: 2, utilities_off: true, principal_residence: true, breach_letter_expired: true, day: 70 }); assert.equal(pr.outcome, "hold_lossmit"); assert.equal(pr.regx_blocks_until_day, 121);
  assert.equal(expeditedReview({ vacant_inspections: 2, utilities_off: true, principal_residence: true, breach_letter_expired: true, day: 121 }).outcome, "refer_expedited");
'''
B["13.4-T8"] = '''
  const r = modelItemGate({ item: "occupancy", confidence: 0.7, human_resolved: false }); assert.equal(r.verification_task!.kind, "human_agent"); assert.equal(r.item_status, "pending_human"); assert.equal(r.review_can_complete, false);
  assert.equal(modelItemGate({ item: "occupancy", confidence: 0.7, human_resolved: true }).review_can_complete, true); assert.equal(modelItemGate({ item: "occupancy", confidence: 0.9, human_resolved: false }).review_can_complete, true);
'''
B["13.4-T9"] = '''
  assert.deepEqual(siiStatusItem({ pending_sii_request: true }), { item: "SII_STATUS", passed: false, outcome: "hold_sii" });
  assert.deepEqual(siiStatusItem({ pending_sii_request: false }), { item: "SII_STATUS", passed: true, outcome: "pass" });
'''
B["13.4-T10"] = '''
  assert.deepEqual(bankruptcyScrubItem({ pacer_hit: true, case_number: "26-10001" }), { outcome: "hold_bankruptcy", open_bk_case: { section: "14.x", case_number: "26-10001" } });
  assert.deepEqual(bankruptcyScrubItem({ pacer_hit: false }), { outcome: "pass", open_bk_case: null });
'''
B["13.5-T4"] = '''
  const versions = [{ version: "2024-07", effective_on: D("2024-07-01"), days: 780 }, { version: "2025-07", effective_on: D("2025-07-01"), days: 810 }];
  assert.deepEqual(exhibitVersionFor(versions, D("2025-06-30")), { version: "2024-07", days: 780 }); assert.deepEqual(exhibitVersionFor(versions, D("2025-07-01")), { version: "2025-07", days: 810 });
'''
B["13.5-T5"] = '''
  const r = timeframeWarning({ lpi_due: D("2024-05-01"), today: D("2026-03-17"), allowable: 810, credited: 165 });
  assert.equal(r.threshold, 683); assert.equal(r.elapsed, 685); assert.equal(r.at_risk, true); assert.equal(r.event, "foreclosure.timeframe.at_risk"); assert.equal(r.instruction!.kind, "STATUS_DEMAND"); assert.equal(r.instruction!.to, "firm");
  assert.equal(timeframeWarning({ lpi_due: D("2024-05-01"), today: D("2026-03-10"), allowable: 810, credited: 165 }).at_risk, false);
'''
B["13.5-T6"] = '''
  const r = rescissionExposure({ cause: "missed_dmdc_check", third_party_costs_cents: 62_500n });
  assert.equal(r.exposure_cents, 162_500n); assert.equal(r.root_cause, "servicer:scra"); assert.equal(r.servicer_error, true);
  assert.equal(rescissionExposure({ cause: "firm_error", third_party_costs_cents: 62_500n }).exposure_cents, 0n);
'''
B["13.5-T7"] = '''
  const r = contestedCredits([{ category: "contested", from: D("2026-03-02"), to: D("2026-04-11"), reported_timely: true }, { category: "contested", from: D("2026-06-01"), to: D("2026-07-01"), reported_timely: true }]);
  assert.equal(r.credited, 40); assert.equal(r.notes.length, 1); assert.match(r.notes[0]!, /reasonable explanation/);
'''
B["13.5-T8"] = '''
  const r = billReceived({ received_on: D("2027-03-01"), bill_cents: 84_082n, exposure_cents: 84_082n });
  assert.equal(r.timer, "SM_COMP_FEE_BILL_REBUTTAL_30"); assert.equal(r.due, "2027-03-31"); assert.equal(r.package.drafted, true); assert.equal(r.package.variance_cents, 0n); assert.equal(r.escalation.kind, "officer");
'''
B["13.5-T9"] = '''
  const r = methodDeviation({ preferred_method: false }); assert.equal(r.allowed, false); assert.equal(r.gate, "FNMA_EXHIBIT_METHOD_DEVIATION_FORM20_GATE"); assert.match(r.refusal!, /Form 20/);
  assert.equal(methodDeviation({ preferred_method: false, form20_approval_id: "F20-1" }).allowed, true); assert.equal(methodDeviation({ preferred_method: true }).allowed, true);
'''
B["13.6-T5"] = '''
  const blocked = suspensionGate({ proposed_on: D("2026-08-03"), fnma_notified_on: D("2026-08-03"), plan_attached: true, implement_on: D("2026-08-07") }); assert.equal(blocked.earliest, "2026-08-10"); assert.equal(blocked.allowed, false);
  assert.equal(suspensionGate({ proposed_on: D("2026-08-03"), fnma_notified_on: D("2026-08-03"), plan_attached: true, implement_on: D("2026-08-10") }).allowed, true);
  assert.match(suspensionGate({ proposed_on: D("2026-08-03"), fnma_notified_on: null, plan_attached: false, implement_on: D("2026-08-20") }).refusal!, /notified with the transition plan/);
'''
B["13.6-T7"] = '''
  const r = draPostponementCheck({ acknowledged_on: D("2026-10-21"), dra_event_on: null, today: D("2026-10-26") });
  assert.equal(r.expected_by, "2026-10-23"); assert.equal(r.exception, true); assert.equal(r.firm_call_task, true); assert.equal(r.credit_status, "DRA unverified");
  assert.equal(draPostponementCheck({ acknowledged_on: D("2026-10-21"), dra_event_on: D("2026-10-22"), today: D("2026-10-26") }).credit_status, "verified");
'''
B["13.6-T8"] = '''
  const done = feeApproval({ method: "non_judicial", milestone: "confirmation", allowable_cents: 225_000n }); assert.equal(done.pct, 100); assert.equal(done.approved_cents, 225_000n); assert.equal(done.note, null);
  const held = feeApproval({ method: "non_judicial", milestone: "sale_held", allowable_cents: 225_000n }); assert.equal(held.pct, 95); assert.equal(held.approved_cents, 213_750n); assert.match(held.note!, /cannot be considered to be earned until/);
'''
B["13.6-T10"] = '''
  const r = scorecardReview([{ month: "2026-07", band: "middle" }, { month: "2026-08", band: "bottom" }, { month: "2026-09", band: "bottom" }]);
  assert.equal(r.trigger, true); assert.deepEqual(r.review, { kind: "risk_triggered", scheduled: true }); assert.equal(r.escalation!.kind, "officer");
  assert.equal(scorecardReview([{ month: "2026-08", band: "bottom" }, { month: "2026-09", band: "middle" }]).trigger, false);
'''
B["13.7-T5"] = '''
  assert.equal(maLeadPaintItem({ state: "MA" }).passed, false); assert.equal(maLeadPaintItem({ state: "MA", citation_search_document_id: "doc-lp" }).passed, true);
'''
B["13.7-T6"] = '''
  const r = appealFilingGate({}); assert.equal(r.allowed, false); assert.match(r.refusal!, /written approval is not stored/); assert.equal(r.gate, "FNMA_E1301_REMOVAL_APPEAL_APPROVAL_GATE");
  assert.equal(appealFilingGate({ fnma_written_approval_document_id: "doc-appr" }).allowed, true);
'''
B["13.7-T7"] = '''
  const due = D("2026-10-19");   // 12 days out from 2026-10-07
  const r = pleadingReviewGate({ filing_due: due, draft_given_on: D("2026-10-13") }); assert.equal(r.draft_due, "2026-10-09"); assert.equal(r.allowed, false); assert.match(r.refusal!, /PLEADING_REVIEW_GATE/);   // 5 servicer BD before Mon 10-19 skip Columbus Day
  assert.equal(pleadingReviewGate({ filing_due: due, draft_given_on: D("2026-10-09") }).allowed, true);
'''
B["13.7-T8"] = '''
  const r = quatroOutage({ notice_received_on: D("2026-10-07"), outage: true, restored_on: D("2026-10-08") });
  assert.equal(r.form20_due, "2026-10-09"); assert.deepEqual(r.email_sent, { on: "2026-10-07", outage_note: true }); assert.equal(r.portal_filed_on, "2026-10-08"); assert.deepEqual(r.timestamps, { email: "2026-10-07", portal: "2026-10-08" });
'''
B["13.7-T9"] = '''
  const r = workoutCounselGate({ litigated: true, counsel_notified_on: null, counsel_acknowledged: false }); assert.equal(r.allowed, false); assert.equal(r.gate, "FNMA_E1301_WORKOUT_NOTIFY_COUNSEL_GATE");
  assert.equal(workoutCounselGate({ litigated: true, counsel_notified_on: D("2026-10-07"), counsel_acknowledged: true }).allowed, true); assert.equal(workoutCounselGate({ litigated: false, counsel_notified_on: null, counsel_acknowledged: false }).allowed, true);
'''
B["13.8-T1"] = '''
  const r = boardingDmdc({ boarded_on: D("2026-06-01"), results: [{ borrower_id: "b1", status: "N", certificate_id: "CERT-1", as_of: D("2026-06-03") }, { borrower_id: "b2", status: "N", certificate_id: "CERT-2", as_of: D("2026-06-03") }] });
  assert.equal(r.due, "2026-06-08"); assert.equal(r.verified, true); assert.deepEqual(r.parsed.map((p) => p.certificate_id), ["CERT-1", "CERT-2"]); assert.deepEqual(r.missing_certificate, []);
'''
B["13.8-T3"] = '''
  const r = openScraCase({ dmdc_status: "Y", origination_on: D("2021-10-01"), service_begin_on: D("2026-03-15"), verified_on: D("2026-06-03"), late_charges_since_service_cents: 8_186n });
  assert.equal(r.opened, true); assert.equal(r.event, "scra.case.opened"); assert.equal(r.gate, "closed"); assert.equal(r.status_code, "32"); assert.equal(r.late_charges_waived_cents, 8_186n);
  assert.deepEqual(r.firm_instruction, { kind: "SCRA_STAY", to: "firm", due: "2026-06-04", sent: true }); assert.equal(r.quarterly_timer, "SM_DMDC_PERIODIC_ACTIVE_FC_90");
  assert.equal(openScraCase({ dmdc_status: "Y", origination_on: D("2026-05-01"), service_begin_on: D("2026-03-15"), verified_on: D("2026-06-03"), late_charges_since_service_cents: 0n }).opened, false);
'''
B["13.8-T5"] = '''
  const stale = affidavitGate({ judicial: true, certificate_on: D("2026-08-01"), today: D("2026-09-15"), executed_by_role: "signing_officer", filing_evidence_document_id: "f-1" }); assert.equal(stale.affidavit_valid, false); assert.match(stale.refusal!, /older than 30 days/);
  const unsigned = affidavitGate({ judicial: true, certificate_on: D("2026-09-01"), today: D("2026-09-15"), executed_by_role: "ops_analyst" }); assert.equal(unsigned.affidavit_valid, false);
  const held = affidavitGate({ judicial: true, certificate_on: D("2026-09-01"), today: D("2026-09-15"), executed_by_role: "signing_officer" }); assert.equal(held.affidavit_valid, true); assert.equal(held.motion_instruction_released, false);
  assert.equal(affidavitGate({ judicial: true, certificate_on: D("2026-09-01"), today: D("2026-09-15"), executed_by_role: "signing_officer", filing_evidence_document_id: "f-1" }).motion_instruction_released, true);
'''
B["13.8-T6"] = '''
  const r = certificationDmdcCheck({ sale_on: D("2026-11-03"), check_on: D("2026-10-27"), active_duty: true });
  assert.equal(r.certification, "withheld"); assert.equal(r.instruction, "POSTPONE_SALE"); assert.equal(r.violation_suspected, false);
'''
B["13.8-T7"] = '''
  const r = dmdcOutageBeforeSale({ sale_on: D("2026-11-03"), today: D("2026-10-30"), dmdc_available: false, last_certificate_on: D("2026-10-04") });
  assert.equal(r.instruction, "POSTPONE_SALE"); assert.match(r.reason, /postpone rather than proceed/);
  assert.equal(dmdcOutageBeforeSale({ sale_on: D("2026-11-03"), today: D("2026-10-30"), dmdc_available: false, last_certificate_on: D("2026-10-28") }).instruction, "CERTIFY_SALE");
'''
B["13.8-T8"] = '''
  const first = zResult({ attempts: [{ name_variant: "legal", dob_variant: "file", status: "Z" }] }); assert.equal(first.retry_required, true); assert.equal(first.affidavit_kind, null);
  const unresolved = zResult({ attempts: [{ name_variant: "legal", dob_variant: "file", status: "Z" }, { name_variant: "alternate", dob_variant: "alternate", status: "Z" }] });
  assert.equal(unresolved.escalation!.kind, "attorney"); assert.equal(unresolved.affidavit_kind, "unable_to_determine"); assert.notEqual(unresolved.affidavit_kind, "A_not_in_service");
  assert.equal(zResult({ attempts: [{ name_variant: "legal", dob_variant: "file", status: "Z" }, { name_variant: "alternate", dob_variant: "file", status: "N" }] }).affidavit_kind, "A_not_in_service");
'''
B["13.8-T9"] = '''
  const r = saleInViolation({ sale_on: D("2026-11-03"), discovered_on: D("2026-11-04"), third_party_costs_cents: 62_500n });
  assert.deepEqual(r.escalations.map((e) => [e.kind, e.severity]), [["attorney", "sev1"], ["officer", "sev1"]]); assert.equal(r.due, "2026-11-04"); assert.equal(r.exposure_cents, 162_500n); assert.equal(r.root_cause, "servicer:scra");
'''
B["13.8-T10"] = '''
  const r = waiverRequest({ borrower_asks_to_waive: true }); assert.equal(r.solicited, false); assert.equal(r.accepted, false); assert.equal(r.escalation!.kind, "attorney"); assert.match(r.escalation!.reason, /forbids seeking consent/);
'''
B["13.8-T12"] = '''
  const r = protectionTail(D("2028-02-29"));
  assert.equal(r.protection_ends_on, "2029-02-28"); assert.equal(r.gate_opens_on, "2029-03-01"); assert.equal(protectionEndsOn(D("2028-02-29")), "2029-02-28");
  assert.equal(fcGateClosed(D("2029-02-28"), D("2028-02-29"), false), true); assert.equal(fcGateClosed(D("2029-03-01"), D("2028-02-29"), false), false);
'''
B["13.9-T5"] = '''
  const portfolio = form1022Schedule({ reduction_month: D("2026-09-01"), mbs: false, acked_on: D("2026-10-05") }); assert.equal(portfolio.channel, "email_bd9"); assert.equal(portfolio.due, "2026-10-14");   // BD9 of October 2026 (Columbus Day excluded) assert.equal(portfolio.tracked, true); assert.equal(portfolio.acknowledged, true);
  const mbs = form1022Schedule({ reduction_month: D("2026-09-01"), mbs: true }); assert.equal(mbs.channel, "upload_cd15"); assert.equal(mbs.due, "2026-10-15"); assert.equal(mbs.acknowledged, false);
'''
B["13.9-T6"] = '''
  const charges = [{ assessed_on: D("2026-05-17"), cents: 2_047n, paid: true }, { assessed_on: D("2026-06-17"), cents: 2_047n, paid: false }, { assessed_on: D("2026-07-17"), cents: 2_046n, paid: false }, { assessed_on: D("2026-08-17"), cents: 2_046n, paid: false }];
  const r = lateChargeWaiver({ charges, cap_effective_due: D("2026-04-01"), cap_ends_on: D("2028-02-28") });
  assert.equal(r.waived_cents + r.refunded_cents, 8_186n); assert.equal(r.refunded_cents, 2_047n); assert.equal(r.new_charges_blocked, true); assert.equal(r.gate, "SCRA_3937_FEES_IN_CAP_GATE");
'''
B["13.9-T7"] = '''
  const r = overpaymentElection({ overpayment_cents: 152_830n, next_payment_cents: 174_173n, election: "refund", recorded_on: D("2026-09-20") });
  assert.deepEqual(r.postings, [{ account: "scra_overpayment_payable", debit: 152_830n, credit: 0n, rule_ref: "13.9.overpayment.refund" }, { account: "cash", debit: 0n, credit: 152_830n, rule_ref: "13.9.overpayment.refund" }]);
  assert.equal(r.balanced, true); assert.equal(r.election_recorded, true); assert.equal(r.statement_line, "SCRA interest refund"); assert.equal(r.sufficient_alone, false); assert.equal(r.shortfall_cents, 21_343n);
'''
B["13.9-T8"] = '''
  const r = defaultElection({ letter_sent_on: D("2026-09-15"), today: D("2026-10-16") });
  assert.equal(r.due, "2026-10-15"); assert.equal(r.applied, "curtailment"); assert.equal(r.defaulted, true); assert.equal(r.borrower_notice, "NTC_SCRA_3937_OVERPAYMENT_ELECTION");
  assert.equal(defaultElection({ letter_sent_on: D("2026-09-15"), today: D("2026-10-10") }).applied, null); assert.equal(defaultElection({ letter_sent_on: D("2026-09-15"), election: "refund", today: D("2026-10-20") }).defaulted, false);
'''
B["13.9-T9"] = '''
  const r = assertedServiceWithoutEvidence({ written_assertion: true, dmdc_status: "N" }); assert.equal(r.denial_allowed, false); assert.equal(r.escalation!.kind, "attorney"); assert.equal(r.request_orders, true);
  assert.equal(assertedServiceWithoutEvidence({ written_assertion: true, dmdc_status: "N", orders_document_id: "orders-1" }).request_orders, false);
'''
B["13.9-T10"] = '''
  const r = lateRequest({ release_on: D("2027-02-28"), request_on: D("2027-09-16"), service_verified: true, service_begin_on: D("2026-03-15"), mbs: false });
  assert.equal(r.statutory, false); assert.equal(r.honored, true); assert.equal(r.cap_from_due, "2026-04-01"); assert.equal(r.cap_ends_on, "2028-02-28"); assert.equal(r.retroactive, true); assert.deepEqual(r.form_1022, { channel: "email_bd9" });
  assert.equal(lateRequest({ release_on: D("2027-02-28"), request_on: D("2027-09-16"), service_verified: false, service_begin_on: D("2026-03-15"), mbs: false }).honored, false);
'''
EXTRA = {
"13-3": '''
test("13.3 worked figures: UPB $250,000.00 at 6.50% from LPI 2025-09-01 to sale 2026-11-03 (428 days) → interest $19,054.79; escrow advances $6,842.17, corporate advances $1,975.00, attorney fees $2,150.00, costs $1,487.50 → $281,509.46; reserve $270,000.00 → bid $270,000.00; sale $290,000.00 → surplus $8,490.54; reinstatement 6 × $1,420.11 = $8,520.66 + $284.02 + $3,105.40 + $60.00 + fees + $612.00", () => {
  const ti = totalIndebtedness({ upb_cents: 25000000n, note_rate_pct: "6.50", lpi_due: D("2025-09-01"), sale_on: D("2026-11-03"), escrow_advances_cents: 684217n, corporate_advances_cents: 197500n, attorney_fees_cents: 215000n, costs_cents: 148750n });
  assert.equal(ti.days, 428); assert.equal(ti.interest_cents, 1905479n); assert.equal(ti.total_cents, 28150946n);
  assert.equal(bid(ti.total_cents, 27000000n).max_bid_cents, 27000000n); assert.equal(bid(ti.total_cents, 31000000n).max_bid_cents, 28150946n); assert.equal(thirdPartySale(29000000n, ti.total_cents).surplus_cents, 849054n);
  assert.equal(6n * 142011n, 852066n); assert.equal(reinstatementQuote({ delinquent_pi_cents: 852066n, late_charges_cents: 28402n, escrow_advances_cents: 310540n, corporate_advances_cents: 6000n, attorney_fees_cents: 100000n, costs_cents: 61200n }), 1358208n);
});
''',
"13-5": '''
test("13.5 worked figures: NJ 810 allowable, LPI 2024-05-01 → sale 2027-01-19 = 993 days; credits 125 + 40 = 165; excess 18; UPB $310,000 at 5.50% → per-diem $46.71 → exposure $840.82", () => {
  const r = exposure({ lpi_due: D("2024-05-01"), sale_on: D("2027-01-19"), allowable: 810, delays: [{ category: "bankruptcy", from: D("2025-09-03"), to: D("2026-01-21"), reported_timely: true }, { category: "contested", from: D("2026-03-02"), to: D("2026-04-11"), reported_timely: true }], upb_cents: 31000000n, ptr_pct: "5.50" });
  assert.equal(r.actual_days, 993); assert.equal(r.credited_days, 165); assert.equal(r.excess_days, 18); assert.equal(r.exposure_cents, 84082n);
  assert.equal((31000000n * 550n + 365n * 5000n) / (365n * 10000n), 4671n);   // per-diem $46.71 (half-up)
});
''',
"13-6": '''
test("13.6 worked figures: allowable A = $2,250.00; first legal 85% → $1,912.50 earned; 65% paid ($1,462.50) → approve $450.00; recording $38.00 and publication $412.75 approved; courier $22.00 rejected", () => {
  assert.equal(feeEarned("non_judicial", "first_legal", 225000n), 191250n); assert.equal((225000n * 65n) / 100n, 146250n);
  const r = reviewInvoice({ method: "non_judicial", milestone: "first_legal", allowable_cents: 225000n, previously_paid_cents: 146250n, costs: [{ kind: "recording", cents: 3800n, receipt: true }, { kind: "publication", cents: 41275n, receipt: true }, { kind: "courier", cents: 2200n, receipt: true }] });
  assert.equal(r.fee_approved_cents, 45000n); assert.equal(r.costs_approved_cents, 45075n); assert.deepEqual(r.rejected.map((x) => [x.kind, x.cents]), [["courier", 2200n]]);
});
''',
"13-9": '''
test("13.9 worked figures: P&I $2,046.53; UPB after #24 $293,975.18; forgiven $1,528.30; UPB after #29 $292,606.60; new payment $278.70 + $1,463.03 = $1,741.73 (standard $1,810.42); differential $1,767.83 − $1,463.03 = $304.80; MBS pool interest $1,645.91; shortfall $213.43", () => {
  const upb24 = balanceAfter(30000000n, "7.25", 360, 24); assert.equal(upb24, 29397518n);
  const r = recalculate({ upb_cents: upb24, note_rate_pct: "7.25", pi_cents: 204653n, first_capped_due: D("2026-04-01"), first_n: 25, paid_at_note_rate_count: 5, remaining_term_after: 331 });
  assert.equal(r.forgiven_total_cents, 152830n); assert.equal(r.upb_after_cents, 29260660n); assert.equal(r.next_interest_capped_cents, 146303n); assert.equal(r.next_interest_note_cents, 176783n);
  assert.equal(r.next_payment_subsidy_cents - r.next_interest_capped_cents, 27870n); assert.equal(r.next_payment_subsidy_cents, 174173n); assert.equal(r.next_payment_standard_cents, 181042n); assert.equal(r.fnma_differential_cents, 30480n);
  assert.equal((29260660n * 675n + 60000n) / 120000n, 164591n); assert.equal(servicingFee(r.upb_after_cents, "0.25"), 6096n); assert.equal(174173n - 152830n, 21343n);
});
''',
}
for fn, head in HEAD.items():
    p = root / f"{fn}.spec.test.ts"
    s = p.read_text()
    s = s.replace('import { test } from "node:test";\n', 'import { test } from "node:test";\n' + head, 1)
    for tid, body in B.items():
        if not tid.startswith(fn.replace("-", ".") + "-"): continue
        pat = re.compile(r'^(test\("' + re.escape(tid) + r'(?:: .*?)?"), \{ todo: true \}\);$', re.M)
        assert pat.search(s), tid
        s = pat.sub(lambda m: m.group(1) + ", () => {" + body + "});", s)
    s += EXTRA.get(fn, "")
    p.write_text(s)
print("ok")
