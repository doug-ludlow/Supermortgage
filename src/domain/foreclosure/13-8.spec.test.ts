// 13.8 SCRA foreclosure protection
// spec/sections/13-foreclosure/13-8-scra-foreclosure-protection.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { boardingDmdc, openScraCase, affidavitGate, certificationDmdcCheck, dmdcOutageBeforeSale, zResult, saleInViolation, waiverRequest, protectionTail } from "./ops.ts";
import { protectionEndsOn, fcGateClosed } from "./scra.ts";

test("13.8-T1: Given a boarded loan, Then a DMDC verification exists within 5 BD; results parsed with certificate ids.", () => {
  const r = boardingDmdc({ boarded_on: D("2026-06-01"), results: [{ borrower_id: "b1", status: "N", certificate_id: "CERT-1", as_of: D("2026-06-03") }, { borrower_id: "b2", status: "N", certificate_id: "CERT-2", as_of: D("2026-06-03") }] });
  assert.equal(r.due, "2026-06-08"); assert.equal(r.verified, true); assert.deepEqual(r.parsed.map((p) => p.certificate_id), ["CERT-1", "CERT-2"]); assert.deepEqual(r.missing_certificate, []);
});
// 13.8-T2 — implemented in src/domain/foreclosure/foreclosure.test.ts
test("13.8-T3: Given DMDC Y on a pre-service obligation, Then `scra.case.opened`, gate closed, status 32 queued, late charges waived, firm instructed `SCRA_STAY` within 1 BD, quarterly contact timers set.", () => {
  const r = openScraCase({ dmdc_status: "Y", origination_on: D("2021-10-01"), service_begin_on: D("2026-03-15"), verified_on: D("2026-06-03"), late_charges_since_service_cents: 8_186n });
  assert.equal(r.opened, true); assert.equal(r.event, "scra.case.opened"); assert.equal(r.gate, "closed"); assert.equal(r.status_code, "32"); assert.equal(r.late_charges_waived_cents, 8_186n);
  assert.deepEqual(r.firm_instruction, { kind: "SCRA_STAY", to: "firm", due: "2026-06-04", sent: true }); assert.equal(r.quarterly_timer, "SM_DMDC_PERIODIC_ACTIVE_FC_90");
  assert.equal(openScraCase({ dmdc_status: "Y", origination_on: D("2026-05-01"), service_begin_on: D("2026-03-15"), verified_on: D("2026-06-03"), late_charges_since_service_cents: 0n }).opened, false);
});
// 13.8-T4 — implemented in src/domain/foreclosure/foreclosure.test.ts
test("13.8-T5: Given a judicial case with a proposed default-judgment motion, Then the affidavit gate requires a `signing_officer`-executed affidavit on certificates \u226430 days; motion instruction released only after filing evidence.", () => {
  const stale = affidavitGate({ judicial: true, certificate_on: D("2026-08-01"), today: D("2026-09-15"), executed_by_role: "signing_officer", filing_evidence_document_id: "f-1" }); assert.equal(stale.affidavit_valid, false); assert.match(stale.refusal!, /older than 30 days/);
  const unsigned = affidavitGate({ judicial: true, certificate_on: D("2026-09-01"), today: D("2026-09-15"), executed_by_role: "ops_analyst" }); assert.equal(unsigned.affidavit_valid, false);
  const held = affidavitGate({ judicial: true, certificate_on: D("2026-09-01"), today: D("2026-09-15"), executed_by_role: "signing_officer" }); assert.equal(held.affidavit_valid, true); assert.equal(held.motion_instruction_released, false);
  assert.equal(affidavitGate({ judicial: true, certificate_on: D("2026-09-01"), today: D("2026-09-15"), executed_by_role: "signing_officer", filing_evidence_document_id: "f-1" }).motion_instruction_released, true);
});
test("13.8-T6: Given a sale scheduled Nov. 3 and a \u22127-day check returning Y, Then certification withheld/postponement instructed and `scra.violation.suspected` is not raised (prevented).", () => {
  const r = certificationDmdcCheck({ sale_on: D("2026-11-03"), check_on: D("2026-10-27"), active_duty: true });
  assert.equal(r.certification, "withheld"); assert.equal(r.instruction, "POSTPONE_SALE"); assert.equal(r.violation_suspected, false);
});
test("13.8-T7: Given a DMDC outage the week of the sale, Then postponement instructed rather than proceeding.", () => {
  const r = dmdcOutageBeforeSale({ sale_on: D("2026-11-03"), today: D("2026-10-30"), dmdc_available: false, last_certificate_on: D("2026-10-04") });
  assert.equal(r.instruction, "POSTPONE_SALE"); assert.match(r.reason, /postpone rather than proceed/);
  assert.equal(dmdcOutageBeforeSale({ sale_on: D("2026-11-03"), today: D("2026-10-30"), dmdc_available: false, last_certificate_on: D("2026-10-28") }).instruction, "CERTIFY_SALE");
});
test("13.8-T8: Given a Z result, Then retry with alternate name/DOB; unresolved \u21d2 `attorney` decision on an \"unable to determine\" affidavit; no (A) affidavit generated.", () => {
  const first = zResult({ attempts: [{ name_variant: "legal", dob_variant: "file", status: "Z" }] }); assert.equal(first.retry_required, true); assert.equal(first.affidavit_kind, null);
  const unresolved = zResult({ attempts: [{ name_variant: "legal", dob_variant: "file", status: "Z" }, { name_variant: "alternate", dob_variant: "alternate", status: "Z" }] });
  assert.equal(unresolved.escalation!.kind, "attorney"); assert.equal(unresolved.affidavit_kind, "unable_to_determine"); assert.notEqual(unresolved.affidavit_kind, "A_not_in_service");
  assert.equal(zResult({ attempts: [{ name_variant: "legal", dob_variant: "file", status: "Z" }, { name_variant: "alternate", dob_variant: "file", status: "N" }] }).affidavit_kind, "A_not_in_service");
});
test("13.8-T9: Given a sale held in violation, Then rescission escalation to `attorney` and `officer` same day; 13.5 rescission-fee exposure booked.", () => {
  const r = saleInViolation({ sale_on: D("2026-11-03"), discovered_on: D("2026-11-04"), third_party_costs_cents: 62_500n });
  assert.deepEqual(r.escalations.map((e) => [e.kind, e.severity]), [["attorney", "sev1"], ["officer", "sev1"]]); assert.equal(r.due, "2026-11-04"); assert.equal(r.exposure_cents, 162_500n); assert.equal(r.root_cause, "servicer:scra");
});
test("13.8-T10: Given a borrower asks to waive SCRA protection so the sale can proceed, Then the agent declines to solicit/accept and routes to `attorney` (Fannie Mae forbids seeking consent).", () => {
  const r = waiverRequest({ borrower_asks_to_waive: true }); assert.equal(r.solicited, false); assert.equal(r.accepted, false); assert.equal(r.escalation!.kind, "attorney"); assert.match(r.escalation!.reason, /forbids seeking consent/);
});
// 13.8-T11 — implemented in src/domain/foreclosure/foreclosure.test.ts
test("13.8-T12: **(Feb 29 clamp)** Given `service_end_on` = **2028-02-29**, Then `protection_ends_on` = **2029-02-28** (the target date does not exist in the following year; the addition clamps to the last day of the month) and the gate opens **2029-03-01**; no exception is thrown and no null date is written.", () => {
  const r = protectionTail(D("2028-02-29"));
  assert.equal(r.protection_ends_on, "2029-02-28"); assert.equal(r.gate_opens_on, "2029-03-01"); assert.equal(protectionEndsOn(D("2028-02-29")), "2029-02-28");
  assert.equal(fcGateClosed(D("2029-02-28"), D("2028-02-29"), false), true); assert.equal(fcGateClosed(D("2029-03-01"), D("2028-02-29"), false), false);
});
