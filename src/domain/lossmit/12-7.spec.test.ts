// 12.7 Disaster Payment Deferral
// spec/sections/12-loss-mitigation/12-7-disaster-payment-deferral.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { disasterDeferralTimeline, disasterTwelveMonthRule, sameEventCheck, disasterIneligibleRouting, disasterForeclosureGate } from "./ops.ts";
import { nib } from "./deferral.ts";

test("12.7-T1: Given a FEMA IA county, incident 2026-05-10, loan current at incident, disaster forbearance 2026-06-01..2026-11-30 without QRPC, when the plan expires, then the solicitation is sent by 2026-12-15 and, on acceptance 2026-12-20, the case is entered by 2026-12-31 (or processing month January under policy).", () => {
  const r = disasterDeferralTimeline({ fema_ia: true, incident_on: D("2026-05-10"), current_at_incident: true, forbearance_start: D("2026-06-01"), forbearance_end: D("2026-11-30"), qrpc: false, acceptance_on: D("2026-12-20"), processing_month_policy: true });
  assert.equal(r.eligible, true); assert.equal(r.solicitation_by, "2026-12-15"); assert.equal(r.notice, "NTC_FNMA_D23205_SOLICIT_POST_DISASTER_FORB"); assert.equal(r.entry_by, "2026-12-31"); assert.equal(r.processing_month_entry_by, "2027-01-31");
});
// 12.7-T2 — implemented in src/domain/lossmit/lossmit.test.ts
test("12.7-T3: (12-month rule) 12 months delinquent at evaluation \u2192 contractual payment required before completion.", () => {
  assert.deepEqual(disasterTwelveMonthRule(12), { contractual_payment_required: true, eligible: true });
  assert.deepEqual(disasterTwelveMonthRule(9), { contractual_payment_required: false, eligible: true });
});
// 12.7-T4 — implemented in src/domain/lossmit/lossmit.test.ts
test("12.7-T5: (same event) second disaster deferral request for the same `disaster_event_id` \u2192 refused; a new event \u2192 allowed.", () => {
  assert.equal(sameEventCheck({ prior_event_ids: ["DR-4999-TX"], requested_event_id: "DR-4999-TX" }).allowed, false);
  assert.equal(sameEventCheck({ prior_event_ids: ["DR-4999-TX"], requested_event_id: "DR-5100-TX" }).allowed, true);
});
test("12.7-T6: (routing) ineligible (13 months delinquent) \u2192 Flex Mod disaster-criteria evaluation started within 5 BD.", () => {
  const r = disasterIneligibleRouting({ months_delinquent: 13, screened_on: D("2026-12-01") });
  assert.equal(r.route, "flex_mod_disaster_criteria"); assert.equal(r.evaluation_by, "2026-12-08"); assert.equal(r.timer, "FNMA_D1301_DISASTER_FLEX_ROUTE"); assert.equal(r.reviewer, "lossmit_reviewer");
  assert.equal(disasterIneligibleRouting({ months_delinquent: 9, screened_on: D("2026-12-01") }).route, "disaster_payment_deferral");
});
test("12.7-T7: (foreclosure gate) pre-referral review completed 2026-12-01 on a disaster loan \u2192 referral refused until Fannie Mae approval; submission by 2026-12-06.", () => {
  const r = disasterForeclosureGate({ review_completed_on: D("2026-12-01") });
  assert.equal(r.referral_allowed, false); assert.match(r.refusal!, /Fannie Mae foreclosure approval/); assert.equal(r.submission_by, "2026-12-06"); assert.equal(r.package_prepared, true); assert.equal(r.sent_by_role, "lossmit_reviewer");
  assert.equal(disasterForeclosureGate({ review_completed_on: D("2026-12-01"), fnma_approval_id: "FNMA-FC-1" }).referral_allowed, true);
});
// 12.7-T8 — implemented in src/domain/lossmit/lossmit.test.ts

test("12.7 worked figures: 9 × $1,580.17 = $14,221.53 + escrow advances $2,300.00 = $16,521.53 NIB", () => {
  assert.equal(9n * 158017n, 1422153n); assert.equal(nib(158017n, 9, 230000n, 0n), 1652153n);
});
