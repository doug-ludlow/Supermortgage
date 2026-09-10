// 11.3 Quality Right Party Contact (QRPC)
// spec/sections/11-early-intervention-collections/11-3-quality-right-party-contact-qrpc.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { thirdPartyCall, threeWayAuthorization, qrpcRecordStatus, humanVerify, awReporting, licensedNegotiationGate, disasterReasonType, validateExtraction, representedDebtorCall } from "./ops.ts";
import { promiseToPay } from "./qrpc.ts";

// 11.3-T1 — implemented in src/domain/early-intervention/early-intervention.test.ts
// 11.3-T2 — implemented in src/domain/early-intervention/early-intervention.test.ts
// 11.3-T3 — implemented in src/domain/early-intervention/early-intervention.test.ts
// 11.3-T4 — implemented in src/domain/early-intervention/early-intervention.test.ts
test("11.3-T5: Given a caller claiming to be the borrower's sister with no authorization, then no account details are disclosed, the authorization form is offered, and no QRPC is recorded.", () => {
  const r = thirdPartyCall({ claimed_relation: "sister", authorization_valid: false });
  assert.equal(r.disclose_account_details, false); assert.equal(r.offer, "FRM_SM_THIRD_PARTY_AUTH"); assert.equal(r.qrpc_recorded_allowed, false); assert.equal(r.outcome, "answered_unverified_third_party");
});
test("11.3-T6: Given a three-way call where the verified borrower authorizes a HUD counselor, then a 90-day `discuss_only` authorization is recorded and the counselor may complete QRPC.", () => {
  const r = threeWayAuthorization({ borrower_verified: true, on: D("2026-12-11"), party: "hud_counselor" })!;
  assert.equal(r.scope, "discuss_only"); assert.equal(r.expires_on, D("2027-03-11")); assert.equal(r.may_complete_qrpc, true); assert.equal(r.party_role, "trusted_advisor");
  assert.equal(threeWayAuthorization({ borrower_verified: false, on: D("2026-12-11"), party: "hud_counselor" }), null);
});
test("11.3-T7: Given the flag is off for the state, then the AI record is `pending_human_verification`, `SM_QRPC_HUMAN_VERIFY_1BD` runs, and only `qrpc_verified` emits `contact.qrpc.established`.", () => {
  const r = qrpcRecordStatus({ complete: true, ai_voice_counts: false, achieved_on: D("2026-12-11") });
  assert.equal(r.status, "pending_human_verification"); assert.deepEqual(r.timer, { code: "SM_QRPC_HUMAN_VERIFY_1BD", due: D("2026-12-14") }); assert.deepEqual([...r.events], []);
  assert.deepEqual(humanVerify("qrpc_verified"), { status: "qrpc_verified", events: ["contact.qrpc.established"], task: null });
  assert.deepEqual(humanVerify("qrpc_rejected"), { status: "qrpc_rejected", events: [], task: "human_call" });
  assert.deepEqual([...qrpcRecordStatus({ complete: true, ai_voice_counts: true, achieved_on: D("2026-12-11") }).events], ["contact.qrpc.established"]);
});
test("11.3-T8: Given QRPC on 2026-10-20 with no resolution, then the November delinquency file shows AW effective 20261020 with reason 016 (5.7 example) and AW is not repeated in December.", () => {
  const rows = awReporting({ qrpc_on: D("2026-10-20"), reason: "unemployment", report_months: ["2026-11", "2026-12"] });
  assert.deepEqual(rows[0], { month: "2026-11", status: "AW", effective: "20261020", reason_code: "016" });
  assert.deepEqual(rows[1], { month: "2026-12", status: null, effective: null, reason_code: null });
});
// 11.3-T9 — implemented in src/domain/early-intervention/early-intervention.test.ts
test("11.3-T10: Given the borrower asks \"what rate would a modification give me?\" in a state with `mlo_licensing_for_lossmit=true`, then the AI declines to quote terms and warm-transfers to `licensed_specialist`; the transcript shows no terms.", () => {
  const r = licensedNegotiationGate({ question: "what rate would a modification give me?", mlo_licensing_for_lossmit: true });
  assert.equal(r.asks_terms, true); assert.equal(r.decline_quote, true); assert.equal(r.warm_transfer, "licensed_specialist"); assert.doesNotMatch(r.response, /\d|%/);
  assert.equal(licensedNegotiationGate({ question: "what rate would a modification give me?", mlo_licensing_for_lossmit: false }).decline_quote, false);
});
test("11.3-T11: Given a disaster hardship in a FEMA IA county, then the event-rail reason type is \"Disaster Impact \u2013 FEMA-declared IA area\" and \"Property Problem\" is not also set.", () => {
  const r = disasterReasonType({ fema_ia_county: true });
  assert.equal(r.reason_type, "Disaster Impact \u2013 FEMA-declared IA area"); assert.equal(r.property_problem_set, false); assert.equal(r.fnma_reason_code, "019");
  assert.equal(disasterReasonType({ fema_ia_county: false }).reason_type, "Casualty Loss");
});
// 11.3-T12 — implemented in src/domain/early-intervention/early-intervention.test.ts
test("11.3-T13: Given the extractor proposes `ability_to_pay=can_pay_by_date` with no transcript evidence span, then validation fails and the record is `conversation_only`.", () => {
  const r = validateExtraction({ reason: { value: "unemployment", evidence_span: "00:41-00:52" }, ability_to_pay: { value: "can_pay_by_date", evidence_span: null } });
  assert.equal(r.valid, false); assert.deepEqual([...r.missing_evidence], ["ability_to_pay"]); assert.equal(r.record_status, "conversation_only");
  assert.equal(validateExtraction({ reason: { value: "unemployment", evidence_span: "00:41-00:52" } }).record_status, "qrpc_candidate");
});
test("11.3-T14: Given a Chapter 13 debtor represented by counsel calls in, then the AI verifies, confines the discussion to information counsel permits per 14.x rules, and no QRPC is recorded without counsel's involvement.", () => {
  const r = representedDebtorCall({ chapter: 13, represented_by_counsel: true, counsel_involved: false });
  assert.equal(r.verify, true); assert.equal(r.discussion_scope, "counsel_permitted_information"); assert.equal(r.qrpc_recorded, false); assert.equal(r.route, "counsel");
  assert.equal(representedDebtorCall({ chapter: 13, represented_by_counsel: true, counsel_involved: true }).qrpc_recorded, true);
});

test("11.3 worked figures: promise $4,165.00 covers 2 × $2,000.00 + 2 × $82.50; $2,000.00 is partial", () => {
  const total = 2n * 200000n + 2n * 8250n; assert.equal(total, 416500n);
  assert.equal(promiseToPay(416500n, D("2026-12-28"), D("2026-12-11"), total).covers, "full"); assert.equal(promiseToPay(200000n, D("2026-12-28"), D("2026-12-11"), total).covers, "partial");
});
