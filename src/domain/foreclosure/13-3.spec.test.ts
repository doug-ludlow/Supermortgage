// 13.3 Foreclosure referral
// spec/sections/13-foreclosure/13-3-foreclosure-referral.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { referralPackage, nonPrReferral, mersAssignmentGate, ny1304, firmDocumentRequest, bankruptcyAfterReferral, reserveFallback, preSaleInspectionStop, transferredFirstFiling } from "./ops.ts";
import { totalIndebtedness, bid, thirdPartySale, reinstatementQuote } from "./referral.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";

test("13.3-T1: Given a principal residence, gates open on day 121 and review outcome `refer`, When `foreclosure.refer`, Then package sent with manifest hashes, `referral_sent_at` recorded, status 43 queued, firm ack timer 2 BD.", () => {
  const r = referralPackage({ referral_on: D("2026-06-30"), day: 121, principal_residence: true, review_outcome: "refer", documents: [{ id: "note", sha256: "a1" }, { id: "mortgage", sha256: "b2" }] });
  assert.equal(r.allowed, true); assert.deepEqual(r.manifest, [{ id: "note", sha256: "a1" }, { id: "mortgage", sha256: "b2" }]); assert.equal(r.referral_sent_at, "2026-06-30"); assert.equal(r.status_code, "43"); assert.equal(r.firm_ack_due, "2026-07-02");
  assert.equal(referralPackage({ referral_on: D("2026-06-29"), day: 120, principal_residence: true, review_outcome: "refer", documents: [{ id: "note", sha256: "a1" }] }).allowed, false);
});
test("13.3-T2: Given a non-principal residence at day 118 with review complete, Then referral must occur by day 120; if a complete BRP arrives day 119, E-3.2-04 postponement recorded and the deadline suspended.", () => {
  const a = nonPrReferral({ earliest_unpaid_due: D("2026-03-01"), today: D("2026-06-27") }); assert.equal(a.day, 118); assert.equal(a.refer_by, "2026-06-29"); assert.equal(a.postponement, null);
  const b = nonPrReferral({ earliest_unpaid_due: D("2026-03-01"), today: D("2026-06-28"), complete_brp_on: D("2026-06-28") }); assert.equal(b.postponement, "E-3.2-04"); assert.equal(b.deadline_suspended, true);
});
test("13.3-T3: Given MERS mortgagee and a pre-recordation state, When the assignment is unrecorded, Then `first_notice.authorize` refused; recorded \u21d2 allowed on the first day all gates open.", () => {
  const r = mersAssignmentGate({ mers_mortgagee: true, pre_recordation_state: true, assignment_recorded_on: null, gates_open_on: D("2026-06-30") }); assert.equal(r.allowed, false); assert.match(r.refusal!, /unrecorded/);
  assert.deepEqual(mersAssignmentGate({ mers_mortgagee: true, pre_recordation_state: true, assignment_recorded_on: D("2026-06-10"), gates_open_on: D("2026-06-30") }), { allowed: true, allowed_from: "2026-06-30", refusal: null });
});
test("13.3-T4: Given NY, Then `NTC_STATE_PREFC_NY_1304` renders with \u22655 county agencies, certified + first-class mail evidence, \u00a71306 filing within 3 BD; first notice refused before day 90.", () => {
  const r = ny1304({ mailed_on: D("2026-07-01"), county_agencies: ["a", "b", "c", "d", "e"], certified_mail_evidence: true, first_class_evidence: true, s1306_filed_on: D("2026-07-03"), first_notice_requested_on: D("2026-09-29") });
  assert.equal(r.checklist_passed, true); assert.equal(r.s1306_due, "2026-07-07"); assert.equal(r.s1306_on_time, true); assert.equal(r.first_notice_allowed_from, "2026-09-29"); assert.equal(r.first_notice_allowed, true);
  assert.equal(ny1304({ ...{ mailed_on: D("2026-07-01"), county_agencies: ["a", "b", "c", "d"], certified_mail_evidence: true, first_class_evidence: true, s1306_filed_on: D("2026-07-03"), first_notice_requested_on: D("2026-09-29") } }).checklist_passed, false);
  assert.equal(ny1304({ mailed_on: D("2026-07-01"), county_agencies: ["a", "b", "c", "d", "e"], certified_mail_evidence: true, first_class_evidence: true, s1306_filed_on: D("2026-07-03"), first_notice_requested_on: D("2026-09-28") }).first_notice_allowed, false);
  const reg = buildRegistry(); publishAuthored(reg); const v = reg.activeVersion("NTC_STATE_PREFC_NY_1304", D("2026-09-01"))!; const out = render(v.source, v.samplePayload);
  assert.match(out.text, /YOU MAY BE AT RISK OF FORECLOSURE/); assert.equal(evaluateChecklist(v, v.samplePayload, out).passed, true);
  const four = { ...v.samplePayload, agencies: ["a", "b", "c", "d"], agency_count: 4 }; assert.equal(evaluateChecklist(v, four, render(v.source, four)).passed, false);
  assert.equal(reg.template("NTC_STATE_PREFC_NY_1304").channelPolicy, "mail_only");
});
// 13.3-T5 — implemented in src/domain/foreclosure/foreclosure.test.ts
// 13.3-T6 — implemented in src/domain/foreclosure/foreclosure.test.ts
// 13.3-T7 — implemented in src/domain/foreclosure/foreclosure.test.ts
test("13.3-T8: Given the firm requests a document, When 3 BD pass without response, Then sev-1 escalation and comp-fee exposure flagged.", () => {
  const r = firmDocumentRequest({ requested_on: D("2026-07-06"), fulfilled_on: null, today: D("2026-07-10") });
  assert.equal(r.due, "2026-07-09"); assert.equal(r.breached, true); assert.equal(r.escalation!.severity, "sev1"); assert.equal(r.comp_fee_exposure_flag, true);
  assert.equal(firmDocumentRequest({ requested_on: D("2026-07-06"), fulfilled_on: D("2026-07-08"), today: D("2026-07-10") }).breached, false);
});
test("13.3-T9: Given a bankruptcy filed after referral, Then firm notified within 1 BD, case `on_hold_bankruptcy`, referral-back on relief to the same firm.", () => {
  const a = bankruptcyAfterReferral({ firm_id: "firm-1", petition_on: D("2026-08-03") }); assert.equal(a.notify_firm_by, "2026-08-04"); assert.equal(a.case_status, "on_hold_bankruptcy"); assert.equal(a.referral_back_to, null);
  const b = bankruptcyAfterReferral({ firm_id: "firm-1", petition_on: D("2026-08-03"), relief_on: D("2026-10-01") }); assert.equal(b.case_status, "active"); assert.equal(b.referral_back_to, "firm-1");
});
test("13.3-T10: Given the reserve price expires before the rescheduled sale and no refresh is available in time, Then basis falls back to total indebtedness and the decision record explains why.", () => {
  const r = reserveFallback({ reserve_cents: 31_000_000n, reserve_expires_on: D("2026-11-20"), sale_on: D("2026-12-08"), refresh_available_by: null, total_indebtedness_cents: 28_150_946n });
  assert.equal(r.basis, "indebtedness"); assert.equal(r.max_bid_cents, 28_150_946n); assert.match(r.rationale, /expired 2026-11-20 before the rescheduled sale 2026-12-08/);
  assert.equal(reserveFallback({ reserve_cents: 27_000_000n, reserve_expires_on: D("2026-11-20"), sale_on: D("2026-11-03"), refresh_available_by: null, total_indebtedness_cents: 28_150_946n }).basis, "reserve");
});
test("13.3-T11: Given the pre-sale inspection reports major uninsured fire damage, Then no bid is issued and a Servicing Representative contact task is created.", () => {
  const r = preSaleInspectionStop({ major_damage: true, insured: false, damage_kind: "fire damage" }); assert.equal(r.issue_bid, false); assert.equal(r.task!.kind, "servicing_representative_contact"); assert.match(r.task!.reason, /fire damage/);
  assert.equal(preSaleInspectionStop({ major_damage: true, insured: true }).issue_bid, true);
});
test("13.3-T12: Given a transfer-in of a case with `first_notice_filed_at` evidenced, Then no state pre-foreclosure notice is re-sent and 13.5 uses the transferor's LPI date.", () => {
  const r = transferredFirstFiling({ transferor_first_notice_filed_at: D("2026-05-20"), transferor_state_prefc_notice_sent: true, transferor_lpi_due: D("2025-12-01") });
  assert.equal(r.resend_state_prefc_notice, false); assert.equal(r.timeframe_lpi_due, "2025-12-01"); assert.equal(r.second_first_notice_allowed, false);
});

test("13.3 worked figures: UPB $250,000.00 at 6.50% from LPI 2025-09-01 to sale 2026-11-03 (428 days) → interest $19,054.79; escrow advances $6,842.17, corporate advances $1,975.00, attorney fees $2,150.00, costs $1,487.50 → $281,509.46; reserve $270,000.00 → bid $270,000.00; sale $290,000.00 → surplus $8,490.54; reinstatement 6 × $1,420.11 = $8,520.66 + $284.02 + $3,105.40 + $60.00 + fees + $612.00", () => {
  const ti = totalIndebtedness({ upb_cents: 25000000n, note_rate_pct: "6.50", lpi_due: D("2025-09-01"), sale_on: D("2026-11-03"), escrow_advances_cents: 684217n, corporate_advances_cents: 197500n, attorney_fees_cents: 215000n, costs_cents: 148750n });
  assert.equal(ti.days, 428); assert.equal(ti.interest_cents, 1905479n); assert.equal(ti.total_cents, 28150946n);
  assert.equal(bid(ti.total_cents, 27000000n).max_bid_cents, 27000000n); assert.equal(bid(ti.total_cents, 31000000n).max_bid_cents, 28150946n); assert.equal(thirdPartySale(29000000n, ti.total_cents).surplus_cents, 849054n);
  assert.equal(6n * 142011n, 852066n); assert.equal(reinstatementQuote({ delinquent_pi_cents: 852066n, late_charges_cents: 28402n, escrow_advances_cents: 310540n, corporate_advances_cents: 6000n, attorney_fees_cents: 100000n, costs_cents: 61200n }), 1358208n);
});
