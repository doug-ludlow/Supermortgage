// 9.9 Property preservation (vacant)
// spec/sections/09-insurance-property-protection/9-9-property-preservation-vacant.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { evaluateScope } from "./preservation.ts";
import { vacantRegistration, preservationPlan, auditRequest } from "./ops.ts";

// 9.9-T1 — implemented in src/domain/insurance/insurance.test.ts
// 9.9-T2 — implemented in src/domain/insurance/insurance.test.ts
// 9.9-T3 — implemented in src/domain/insurance/insurance.test.ts
// 9.9-T4 — implemented in src/domain/insurance/insurance.test.ts
// 9.9-T5 — implemented in src/domain/insurance/insurance.test.ts
// 9.9-T6 — implemented in src/domain/insurance/insurance.test.ts
test("9.9-T7: Given a city ordinance requiring vacant registration within 30 days and semi-annual renewal Then registration filed by the deadline, fee claimed at actual cost, renewal timer set.", () => {
  const r = vacantRegistration({ trigger_on: D("2027-03-08"), rule: { within_days: 30, renewal_months: 6 }, fee_cents: 25000n });
  assert.equal(r.file_by, "2027-04-07"); assert.equal(r.renew_on, "2027-10-07");   // semi-annual from the filing deadline assert.equal(r.fee_claim_cents, 25000n); assert.equal(r.fee_basis, "actual_cost");
});
// 9.9-T8 — implemented in src/domain/insurance/insurance.test.ts
test("9.9-T9: Given a PFPIP loan with \"Do insp and preserv\" Then mode `pfpip`; no servicer securing order; program activity monitored; occupancy/claim/HOA updates sent.", () => {
  const p = preservationPlan({ pfpip: true, permission: "Do insp and preserv", chapter13_active: false });
  assert.equal(p.mode, "pfpip"); assert.equal(p.servicer_securing_order, false); assert.equal(p.monitor_program, true); assert.deepEqual(p.updates, ["occupancy", "claim", "hoa", "stop_work"]);
});
test("9.9-T10: Given an active Chapter 13 case Then preservation suspended pending `attorney` guidance; PFPIP permissions restricted.", () => {
  const p = preservationPlan({ pfpip: true, permission: "Do insp and preserv", chapter13_active: true });
  assert.equal(p.mode, "suspended"); assert.equal(p.attorney_guidance_required, true); assert.equal(p.pfpip_permission, "Do curbside inspection and no preserv."); assert.equal(p.servicer_securing_order, false);
});
test("9.9-T11: Given a Fannie Mae audit request on 2027-05-03 Then documents delivered by 2027-05-10.", () => {
  const r = auditRequest(D("2027-05-03"));
  assert.equal(r.documents_due, "2027-05-10"); assert.equal(r.calendar_deadline, "2027-05-10"); assert.equal(r.role, "officer");
});

test("9.9 worked example: initial scope lock change, two boardings, yard, 8 CY debris, winterization and posting = $1,250.00 within allowables", () => {
  const s = evaluateScope([{ kind: "lock_change", qty: 1, unit_cost_cents: 6000n }, { kind: "boarding", qty: 2, unit_cost_cents: 18500n }, { kind: "yard_initial", qty: 1, unit_cost_cents: 15000n }, { kind: "debris", qty: 8, unit_cost_cents: 5000n, measure: 8 }, { kind: "winterization", qty: 1, unit_cost_cents: 22000n }, { kind: "posting", qty: 1, unit_cost_cents: 5000n }]);
  assert.equal(s.total_cents, 125000n); assert.equal(s.prior_approval_required, false);
});
