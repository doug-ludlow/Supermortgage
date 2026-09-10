// 13.4 Prereferral review
// spec/sections/13-foreclosure/13-4-prereferral-review.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { offerWindowHold, nonPrLadder, disasterHold, scraHold, maLeadPaintItem, expeditedReview, modelItemGate, siiStatusItem, bankruptcyScrubItem, DISASTER_REQUEST_ELEMENTS } from "./ops.ts";
import type { Gates } from "./referral.ts";

// 13.4-T1 — implemented in src/domain/foreclosure/foreclosure.test.ts
test("13.4-T2: Given a principal residence with an offer response window open until day 125, Then outcome `hold_lossmit`; on expiry without acceptance, re-review \u2192 `refer` (no delay beyond expiry per E-3.2-01).", () => {
  assert.deepEqual(offerWindowHold({ window_ends_on: D("2026-07-04"), today: D("2026-07-01"), accepted: false }), { outcome: "hold_lossmit" });
  assert.deepEqual(offerWindowHold({ window_ends_on: D("2026-07-04"), today: D("2026-07-05"), accepted: false }), { outcome: "refer" });
  assert.deepEqual(offerWindowHold({ window_ends_on: D("2026-07-04"), today: D("2026-07-05"), accepted: true }), { outcome: "hold_performing" });
});
test("13.4-T3: Given a complete BRP on day 119 for a non-principal residence, Then `postpone_e3204`; determination on day 140 (offer sent, 14-day window) \u2192 acceptance day 150 \u2192 first payment due Aug. 1 \u2192 referral held until Aug. 31 if unpaid; paid \u2192 held until breach.", () => {
  const eu = D("2026-03-01");
  const a = nonPrLadder({ earliest_unpaid_due: eu, complete_brp_on: D("2026-06-28") }); assert.equal(a.outcome, "postpone_e3204"); assert.equal(a.state, "brp_pending");
  const b = nonPrLadder({ earliest_unpaid_due: eu, complete_brp_on: D("2026-06-28"), offer_sent_on: D("2026-07-19") }); assert.equal(b.offer_expires_on, "2026-08-02"); assert.equal(b.state, "offer_window");
  const c = nonPrLadder({ earliest_unpaid_due: eu, complete_brp_on: D("2026-06-28"), offer_sent_on: D("2026-07-19"), accepted_on: D("2026-07-29"), first_payment_due: D("2026-08-01") }); assert.equal(c.held_until, "2026-08-31"); assert.equal(c.state, "awaiting_first_payment");
  const d = nonPrLadder({ earliest_unpaid_due: eu, complete_brp_on: D("2026-06-28"), offer_sent_on: D("2026-07-19"), accepted_on: D("2026-07-29"), first_payment_due: D("2026-08-01"), first_payment_received: true }); assert.equal(d.state, "performing_until_breach"); assert.equal(d.held_until, null);
});
test("13.4-T4: Given a FEMA IA declaration and inspection damage, Then outcome `hold_disaster_approval`, request emailed within 5 days with all five content elements, gate closed until approval; approval \u2192 `refer`.", () => {
  const req = Object.fromEntries(DISASTER_REQUEST_ELEMENTS.map((e) => [e, "provided"]));
  const held = disasterHold({ fema_ia: true, inspection_damage: true, review_completed_on: D("2026-06-25"), request: req });
  assert.equal(held.outcome, "hold_disaster_approval"); assert.equal(held.request_due, "2026-06-30"); assert.equal(held.elements_present.length, 5); assert.deepEqual(held.elements_missing, []); assert.equal(held.gate, "closed");
  assert.equal(disasterHold({ fema_ia: true, inspection_damage: true, review_completed_on: D("2026-06-25"), request: { recommendation: "foreclose" } }).elements_missing.length, 4);
  const approved = disasterHold({ fema_ia: true, inspection_damage: true, review_completed_on: D("2026-06-25"), request: req, fnma_approval_id: "FNMA-D-1" }); assert.equal(approved.outcome, "refer"); assert.equal(approved.gate, "open");
});
test("13.4-T5: Given DMDC shows active duty, Then `hold_scra`; the referral command is refused even if all other items pass.", () => {
  const gates: Gates = { regx_120: true, regx_prefiling: true, no_first_filing_41k2: true, fnma_121: true, bk_stay: false, scra: false, dmdc_age_days: 10, disaster_approval: true, litigation_hold: false, environmental_hold: false, mn_dual_track: false, title_hold: false, package_ready: true };
  const r = scraHold({ active_duty: true, items_all_pass: true, gates }); assert.equal(r.outcome, "hold_scra"); assert.equal(r.referral.ok, false);
  assert.equal(scraHold({ active_duty: false, items_all_pass: true, gates }).referral.ok, true);
});
test("13.4-T6: Given MA property without the lead-paint citation search, Then refused; with search evidence, passes.", () => {
  const r = maLeadPaintItem({ state: "MA" }); assert.equal(r.required, true); assert.equal(r.passed, false); assert.match(r.refusal!, /lead-paint citation search/);
  assert.equal(maLeadPaintItem({ state: "MA", citation_search_document_id: "doc-lp" }).passed, true); assert.equal(maLeadPaintItem({ state: "TX" }).required, false);
});
test("13.4-T7: Given an abandoned property (two vacant inspections, utilities off) on a non-principal residence at day 70, Then expedited outcome permitted at breach-letter expiry; on a principal residence the Reg X gate still blocks until day 121.", () => {
  const npr = expeditedReview({ vacant_inspections: 2, utilities_off: true, principal_residence: false, breach_letter_expired: true, day: 70 }); assert.equal(npr.expedite_condition, true); assert.equal(npr.outcome, "refer_expedited"); assert.equal(npr.regx_blocks_until_day, null);
  const pr = expeditedReview({ vacant_inspections: 2, utilities_off: true, principal_residence: true, breach_letter_expired: true, day: 70 }); assert.equal(pr.outcome, "hold_lossmit"); assert.equal(pr.regx_blocks_until_day, 121);
  assert.equal(expeditedReview({ vacant_inspections: 2, utilities_off: true, principal_residence: true, breach_letter_expired: true, day: 121 }).outcome, "refer_expedited");
});
test("13.4-T8: Given a model-evaluated occupancy item with confidence 0.7, Then `human_agent` verification task; review cannot complete until resolved.", () => {
  const r = modelItemGate({ item: "occupancy", confidence: 0.7, human_resolved: false }); assert.equal(r.verification_task!.kind, "human_agent"); assert.equal(r.item_status, "pending_human"); assert.equal(r.review_can_complete, false);
  assert.equal(modelItemGate({ item: "occupancy", confidence: 0.7, human_resolved: true }).review_can_complete, true); assert.equal(modelItemGate({ item: "occupancy", confidence: 0.9, human_resolved: false }).review_can_complete, true);
});
test("13.4-T9: Given a pending successor-in-interest request, Then `SII_STATUS` fails and the review holds.", () => {
  assert.deepEqual(siiStatusItem({ pending_sii_request: true }), { item: "SII_STATUS", passed: false, outcome: "hold_sii" });
  assert.deepEqual(siiStatusItem({ pending_sii_request: false }), { item: "SII_STATUS", passed: true, outcome: "pass" });
});
test("13.4-T10: Given a bankruptcy hit in the scrub, Then `hold_bankruptcy` and 14.x case opened.", () => {
  assert.deepEqual(bankruptcyScrubItem({ pacer_hit: true, case_number: "26-10001" }), { outcome: "hold_bankruptcy", open_bk_case: { section: "14.x", case_number: "26-10001" } });
  assert.deepEqual(bankruptcyScrubItem({ pacer_hit: false }), { outcome: "pass", open_bk_case: null });
});
