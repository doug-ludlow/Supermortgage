// 13.2 Dual-tracking restriction
// spec/sections/13-foreclosure/13-2-dual-tracking-restriction.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { holdExitAndCertification, pendingMotion, mnReferralGate, unacknowledgedPostponement, certificationDmdcCheck, rescissionAfterViolation } from "./ops.ts";

// 13.2-T1 — implemented in src/domain/foreclosure/foreclosure.test.ts
test("13.2-T2: Given T1 and a determination \"ineligible\" sent Oct. 10 with no appeal right (tier <90), Then hold closes Oct. 10; certification permitted inside Oct. 19\u201327.", () => {
  const r = holdExitAndCertification({ determination_sent_on: D("2026-10-10"), appeal_available: false, sale_on: D("2026-11-03"), certify_on: D("2026-10-20") });
  assert.equal(r.hold_closes_on, "2026-10-10"); assert.deepEqual(r.window, { opens: "2026-10-19", closes: "2026-10-27" }); assert.equal(r.certification_permitted, true);
  assert.equal(holdExitAndCertification({ determination_sent_on: D("2026-10-10"), appeal_available: false, sale_on: D("2026-11-03"), certify_on: D("2026-10-28") }).certification_permitted, false);
  assert.equal(holdExitAndCertification({ determination_sent_on: D("2026-10-10"), appeal_available: false, sale_on: D("2026-11-03"), certify_on: D("2026-10-18") }).certification_permitted, false);
});
// 13.2-T3 — implemented in src/domain/foreclosure/foreclosure.test.ts
test("13.2-T4: Given a pending summary-judgment motion when the application arrives, Then `WITHDRAW_MOTION`/`REQUEST_CONTINUANCE` instruction issued; court rules anyway \u2192 compliance evidence = instruction + firm's filed request; no breach.", () => {
  const r = pendingMotion({ application_received_on: D("2026-10-01"), motion_pending: true, firm_filed_request: true, court_ruled_anyway: true });
  assert.equal(r.instruction, "WITHDRAW_MOTION"); assert.deepEqual(r.compliance_evidence, ["instruction:WITHDRAW_MOTION", "firm_filed_request"]); assert.equal(r.breach, false);
  assert.equal(pendingMotion({ application_received_on: D("2026-10-01"), motion_pending: true, firm_filed_request: false, court_ruled_anyway: true }).breach, true);
});
// 13.2-T5 — implemented in src/domain/foreclosure/foreclosure.test.ts
test("13.2-T6: Given MN property, application (incomplete) received before referral, Then `foreclosure.refer` refused while pending.", () => {
  const r = mnReferralGate({ state: "MN", application_status: "pending_incomplete" }); assert.equal(r.allowed, false); assert.match(r.refusal!, /582\.043/);
  assert.equal(mnReferralGate({ state: "MN", application_status: "closed" }).allowed, true); assert.equal(mnReferralGate({ state: "TX", application_status: "pending_incomplete" }).allowed, true);
});
test("13.2-T7: Given a `POSTPONE_SALE` instruction not acknowledged in 1 BD, Then `attorney` escalation and phone task created; DRA reconciliation flags absence of a postponement event after 2 BD.", () => {
  const r = unacknowledgedPostponement({ instruction_sent_on: D("2026-10-20"), acknowledged_on: null, dra_postponement_event_on: null, today: D("2026-10-23") });
  assert.equal(r.ack_due, "2026-10-21"); assert.equal(r.escalation!.kind, "attorney"); assert.equal(r.phone_task, true); assert.equal(r.dra_expected_by, "2026-10-22"); assert.equal(r.dra_exception, true);
  assert.equal(unacknowledgedPostponement({ instruction_sent_on: D("2026-10-20"), acknowledged_on: D("2026-10-21"), dra_postponement_event_on: D("2026-10-22"), today: D("2026-10-23") }).escalation, null);
});
// 13.2-T8 — implemented in src/domain/foreclosure/foreclosure.test.ts
test("13.2-T9: Given the certification window opens and the DMDC re-check shows active duty, Then certification withheld (13.8), postponement instructed.", () => {
  const r = certificationDmdcCheck({ sale_on: D("2026-11-03"), check_on: D("2026-10-20"), active_duty: true });
  assert.equal(r.in_window, true); assert.equal(r.certification, "withheld"); assert.equal(r.instruction, "POSTPONE_SALE"); assert.equal(r.violation_suspected, false);
  assert.equal(certificationDmdcCheck({ sale_on: D("2026-11-03"), check_on: D("2026-10-20"), active_duty: false }).instruction, "CERTIFY_SALE");
});
test("13.2-T10: Given rescission after a sale held in violation, Then 15.1 rescission flow and A1-4.2-02 fee exposure recorded.", () => {
  const r = rescissionAfterViolation({ sale_on: D("2026-11-03"), violation: "dual_tracking", third_party_costs_cents: 45_000n });
  assert.equal(r.flow, "15.1.rescission"); assert.equal(r.exposure_cents, 145_000n); assert.equal(r.root_cause, "servicer:dual_tracking"); assert.deepEqual(r.escalations.map((e) => e.kind), ["attorney", "officer"]);
});
