/** §4.1–4.5 acceptance tests. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { cents } from "../../kernel/money/cents.ts";
import * as N from "./noe.ts"; import * as R from "./rfi.ts"; import * as C from "./continuity.ts"; import * as SII from "./successor.ts"; import * as CP from "./complaints.ts";

test("4.1-T1/T2/T3/T4/T6/T8/T9: NoE clocks (Labor Day, Columbus, Veterans, Thanksgiving), payoff 7-day, foreclosure profiles, extension, exceptions, correction", () => {
  const d = N.deadlines("b2", D("2026-09-04")); assert.deepEqual([d.ack_due, d.response_due, d.document_copies_due, d.credit_reporting_bar_through, d.extendable], ["2026-09-14", "2026-10-20", "2026-09-28", "2026-11-03", true]);
  const ext = N.extend(d, D("2026-10-20")) as N.Deadlines; assert.equal(ext.response_due, "2026-11-10"); assert.deepEqual(N.extend(d, D("2026-10-21")), { error: "EXTENSION_LATE" });
  const t2 = N.deadlines("b5", D("2026-11-06")); assert.deepEqual([t2.ack_due, t2.response_due], ["2026-11-16", "2026-12-22"]);
  const po = N.deadlines("b6", D("2026-09-04")); assert.equal(po.response_due, "2026-09-16"); assert.deepEqual(N.extend(po, D("2026-09-10")), { error: "EXTENSION_NOT_PERMITTED" });
  const fc = N.deadlines("b9", D("2026-09-04"), { sale_date: D("2026-09-24") }); assert.equal(fc.profile, "fc_before_sale"); assert.equal(fc.response_due, "2026-09-23");
  const gf = N.deadlines("b10", D("2026-09-21"), { sale_date: D("2026-09-24") }); assert.equal(gf.profile, "fc_within_7_days_goodfaith"); assert.equal(gf.ack_due, null);
  assert.equal(N.exception({ similarity_to_prior: 0.9, new_material_info: false, identifiable: true, received_on: D("2026-09-04") }), "duplicative"); assert.equal(N.exception({ similarity_to_prior: 0.9, new_material_info: true, identifiable: true, received_on: D("2026-09-04") }), null);
  assert.equal(N.exception({ similarity_to_prior: 0, new_material_info: false, identifiable: true, received_on: D("2026-09-04"), transfer_out_or_discharge_on: D("2025-07-01") }), "untimely"); assert.equal(N.exception({ similarity_to_prior: 0, new_material_info: false, identifiable: true, received_on: D("2026-09-04"), transfer_out_or_discharge_on: D("2025-10-01") }), null);
  assert.equal(N.exception({ similarity_to_prior: 0, new_material_info: false, identifiable: false, received_on: D("2026-09-04") }), "overbroad"); assert.equal(N.exceptionNoticeDue(D("2026-09-04")), "2026-09-14");
  const corr = N.misappliedPaymentCorrection(cents("1842.17"), "5", D("2026-03-01")); assert.equal(corr.late_charge_reversed_cents, 9_211n); assert.equal(corr.repost_effective_date, "2026-03-01");
  assert.deepEqual(N.investigationValid("b5", ["ledger"]).missing, ["fee_schedule", "jurisdiction_rules"]);
});

test("4.2-T1/T2/T3/T4/T6/T12: RFI item clocks, owner identity, extension rules, exceptions, redaction, NY", () => {
  const own = R.itemDeadlines("owner_identity", D("2026-09-04")); assert.equal(own.response_due, "2026-09-21"); assert.deepEqual(R.extendItem(own, D("2026-09-10")), { error: "EXTENSION_NOT_PERMITTED" });
  const hist = R.itemDeadlines("standard", D("2026-09-04")); assert.equal(hist.response_due, "2026-10-20"); assert.equal((R.extendItem(hist, D("2026-10-20")) as { response_due: string }).response_due, "2026-11-10");
  assert.match(R.ownerIdentity("fnma_mbs_trust"), /Trustee/); assert.doesNotMatch(R.ownerIdentity("fnma_portfolio"), /MERS/);
  assert.equal(R.exception({ asks_for: "investor_guidelines", received_on: D("2026-09-04") }), "irrelevant"); assert.equal(R.exception({ asks_for: "own_evaluation", received_on: D("2026-09-04") }), null); assert.equal(R.exception({ asks_for: "records", pages_est: 6000, received_on: D("2026-09-04") }), "overbroad");
  assert.deepEqual(R.redactions("confirmed_successor"), ["other_borrowers.location_contact", "other_borrowers.personal_financial"]);
  assert.equal(R.itemDeadlines("owner_identity", D("2026-09-04"), "NY").response_due, "2026-09-14");
});

test("4.3-T1/T3/T6/T7/T9: assignment day 45, not required for investment, release after two on-time payments, CA SPOC 2 BD, BK reassignment", () => {
  assert.equal(C.assignmentDue(D("2026-09-01"), true), "2026-10-16"); assert.equal(C.assignmentDue(D("2026-09-01"), false), "not_required");
  const e: C.Episode = { status: "assigned", consecutive_on_time: 0, mode: "ai_first_named_human", team: "default" };
  C.onPayment(e, true, true); assert.equal(e.status, "assigned"); C.onPayment(e, true, true); assert.equal(e.status, "released");
  const e2: C.Episode = { status: "assigned", consecutive_on_time: 1, mode: "ai_first_named_human", team: "default" }; C.onPayment(e2, false, true); assert.equal(e2.consecutive_on_time, 0); assert.equal(e2.status, "assigned");
  const e3: C.Episode = { status: "assigned", consecutive_on_time: 0, mode: "ai_first_named_human", team: "default" }; C.onPayment(e3, true, false); C.onPayment(e3, true, false); assert.equal(e3.status, "assigned");   // trial payments don't count
  assert.equal(C.caSpocDue(D("2026-10-09")), "2026-10-14");   // Fri 10-09 + 2 servicer BD, Columbus Day 10-12 closed assert.equal(C.bankruptcyReassign(e3).team, "bankruptcy_specialist");
});

test("4.4-T1/T2/T3/T4/T5: successor timeline (10-08, 11-03), no probate for joint tenancy, no deed for divorce, additional documents, arm's-length sale", () => {
  assert.deepEqual(SII.timeline(D("2026-10-01"), D("2026-10-20")), { documents_letter_due: "2026-10-08", confirmation_due: "2026-11-03" });
  assert.deepEqual(SII.requiredDocuments("joint_tenancy_survivor", ["recorded_deed"]), ["death_certificate"]); assert.equal(SII.determine("joint_tenancy_survivor", ["death_certificate", "recorded_deed"], true), "confirmed");
  assert.equal(SII.determine("divorce", ["divorce_decree", "separation_agreement"], true), "confirmed"); assert.ok(!SII.requiredDocuments("divorce", []).includes("recorded_deed"));
  assert.equal(SII.determine("death_relative", ["death_certificate", "recorded_deed", "will"], false), "additional_documents_required"); assert.equal(SII.determine("arms_length_sale", [], true), "not_successor");
  assert.deepEqual(SII.rightsOnConfirmation(false), { noe_rfi_payoff: true, statements_and_ei: false, obligor: false });
});

test("4.5-T1/T2/T3/T4/T6/T10: CFPB 15/60, NY 5/30 (15 foreclosure), triage, population remediation $18,600, 48h email", () => {
  assert.deepEqual(CP.cfpbDeadlines(D("2026-09-10")), { response_by: "2026-09-25", final_by: "2026-11-09" });
  assert.deepEqual(CP.nyDeadlines(D("2026-09-10"), false), { ack_by: "2026-09-17", response_by: "2026-10-23" });   // 30 BD, Columbus Day excluded assert.equal(CP.nyDeadlines(D("2026-09-10"), true).response_by, "2026-10-01");
  const oral = CP.triage({ text: "you people keep charging me late fees", complaints_90d: 0, channel: "oral" }); assert.equal(oral.opens_noe, false); assert.equal(oral.script_1024_38b5, true);
  const written = CP.triage({ text: "you charged me a late fee I don't owe", complaints_90d: 2, channel: "written" }); assert.equal(written.opens_noe, true); assert.equal(written.repeat, true);
  assert.equal(CP.triage({ text: "my foreclosure sale is tomorrow", complaints_90d: 0, channel: "oral" }).severity, "critical");
  assert.equal(CP.populationRemediation(1240, 1_500n).total_cents, 1_860_000n);
  assert.equal(CP.emailReplyDeadlineMs(Date.parse("2026-09-14T13:00:00Z")), Date.parse("2026-09-16T13:00:00Z"));
  assert.deepEqual(CP.udaapScreen({ injury: true, avoidable: false, misleading_material: false, unreasonable_advantage: false }), { unfair: true, deceptive: false, abusive: false });
});
