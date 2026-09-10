// 4.1 Notice of Error (NoE) resolution
// spec/sections/04-customer-service-borrower-communications/4-1-notice-of-error-noe-resolution.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { cents } from "../../kernel/money/cents.ts";
void cents;
import * as N from "./noe.ts";
import { federalDays } from "./clocks.ts";
import { addBusinessDays, federal } from "../../kernel/calendar/business.ts";
import { goodFaithResponse, splitOverbroad, documentRequest, earlyCorrection, nyNoeDeadline, nyExtension, triageWithConfidence, manifestWatch, noeCommunicationCheck, boardOpenNoe } from "./ops.ts";

// 4.1-T1 — implemented in src/domain/servicing-requests/servicing-requests.test.ts
// 4.1-T2 — implemented in src/domain/servicing-requests/servicing-requests.test.ts
// 4.1-T3 — implemented in src/domain/servicing-requests/servicing-requests.test.ts
// 4.1-T4 — implemented in src/domain/servicing-requests/servicing-requests.test.ts
test("4.1-T5: (\u22647 days before sale) Given `b10` received 3 days before sale, then a good-faith contact is logged before the sale and the (f)(2) path records `deadline_profile=fc_within_7_days_goodfaith`; no ack timer.", () => {
  const r = goodFaithResponse(D("2026-09-21"), D("2026-09-24"), D("2026-09-22"), "oral");
  assert.equal(r.profile, "fc_within_7_days_goodfaith"); assert.equal(r.ack_timer, null); assert.equal(r.contact.before_sale, true); assert.equal(r.satisfied, true);
});
// 4.1-T6 — implemented in src/domain/servicing-requests/servicing-requests.test.ts
test("4.1-T7: (overbroad with carve-out) Given a 40-page pleading-style letter containing one identifiable late-fee assertion, then the late fee is investigated and answered and the (g)(2) notice states the overbroad basis for the remainder, both within their clocks.", () => {
  const r = splitOverbroad([{ id: "a1", type: "b5", text: "the late fee assessed in March was not owed" }, { id: "a2", type: "unidentifiable", text: "40 pages of pleading-style allegations" }], D("2026-09-04"));
  assert.deepEqual(r.investigate.map((a) => a.id), ["a1"]); assert.deepEqual(r.overbroad_residue.map((a) => a.id), ["a2"]);
  assert.deepEqual(r.exception_notice, { template: "NTC_REGX_35G2_EXCEPTION", basis: "overbroad", due_on: "2026-09-14", carved_out: ["a1"] }); assert.equal(r.response_due, "2026-10-20");
});
// 4.1-T8 — implemented in src/domain/servicing-requests/servicing-requests.test.ts
// 4.1-T9 — implemented in src/domain/servicing-requests/servicing-requests.test.ts
test("4.1-T10: (documents) Given a no-error response and a borrower's oral request for documents, then copies (snapshots) are mailed \u226415 federal BD; a privileged memo is withheld with the written withholding notice in the same window.", () => {
  const r = documentRequest(D("2026-09-04"), [{ id: "ledger-2026-03", relied_on: true }, { id: "legal-memo-2026-09-10", relied_on: true, privileged: true }, { id: "unrelated", relied_on: false }]);
  assert.equal(r.copies_due, "2026-09-28"); assert.deepEqual(r.provided, [{ id: "ledger-2026-03", kind: "snapshot" }]);
  assert.deepEqual(r.withheld, [{ id: "legal-memo-2026-09-10", notice: "NTC_REGX_35E4_WITHHELD", basis: "privileged" }]);
});
test("4.1-T11: (early correction) Given a clear posting error fixed on day 2 with the correction letter mailed on day 3, then ack/response timers cancel with reason `early_correction`.", () => {
  const r = earlyCorrection(D("2026-09-04"), D("2026-09-08"), D("2026-09-09"));
  assert.equal(r.qualifies, true); assert.equal(r.cancel_reason, "early_correction"); assert.deepEqual(r.timers_cancelled, ["REGX_1024_35D_NOE_ACK_5", "REGX_1024_35E_NOE_RESPONSE_30"]);
  assert.equal(earlyCorrection(D("2026-09-04"), D("2026-09-08"), D("2026-09-16")).qualifies, false);
});
test("4.1-T12: (NY override) Given a NY property and a `b9` assertion with a sale in 40 days, then due = 15 servicer BD, not 30; extension for a `std_30` NY case adds 7 BD.", () => {
  const ny = nyNoeDeadline(D("2026-09-04"), { foreclosure_assertion: true, sale_on: D("2026-10-14") });
  assert.equal(ny.response_due, "2026-09-28"); assert.match(ny.basis, /15 business days/);                 // 15 servicer BD (Labor Day closed), not 30
  const std = nyNoeDeadline(D("2026-09-04"), { foreclosure_assertion: false }); assert.equal(nyExtension(std), "2026-10-27");   // +7 BD
});
test("4.1-T13: (AI escalation) Given classifier confidence 0.4, then `needs_human` queue with the ack timer running; a human classification within 1 BD does not change the receipt date.", () => {
  const r = triageWithConfidence({ confidence: 0.4, received_on: D("2026-09-04"), human_classified_on: D("2026-09-08") });
  assert.equal(r.queue, "needs_human"); assert.equal(r.ack_due, "2026-09-14"); assert.equal(r.receipt_date, "2026-09-04"); assert.equal(r.human_within_1bd, true);
});
test("4.1-T14: (mail vendor failure) Given no manifest by 18:00 ET, then an alarm fires and the manual intake protocol logs receipt dates from the physical stamp.", () => {
  assert.deepEqual(manifestWatch({ expected_by: "2026-09-04T18:00:00-04:00", received_at: null, now: "2026-09-04T18:05:00-04:00" }), { alarm: true, protocol: "manual_intake", receipt_date_source: "physical_stamp" });
  assert.equal(manifestWatch({ expected_by: "2026-09-04T18:00:00-04:00", received_at: "2026-09-04T17:10:00-04:00", now: "2026-09-04T18:05:00-04:00" }).alarm, false);
});
test("4.1-T15: (fee prohibition) Given a borrower 2 months delinquent, then no fee or payment is requested in any NoE communication (template checklist assertion).", () => {
  assert.deepEqual(noeCommunicationCheck("We received your notice of error. We will respond by October 20. You are two months behind; you may call us about options."), { ok: true, violations: [] });
  assert.equal(noeCommunicationCheck("A $25 fee applies for this dispute review.").ok, false);
  assert.equal(noeCommunicationCheck("You must bring your account current before we investigate.").ok, false);
});
test("4.1-T16: (transfer-in open case) Given a boarding file with an NoE received by the transferor 20 federal BD earlier, then the case boards with the original receipt date and a 10-day residual clock.", () => {
  const boarded = D("2026-09-04"); const received = addBusinessDays(boarded, -20, federal);              // 20 federal BD earlier
  const r = boardOpenNoe({ type: "b2", transferor_received_on: received, boarded_on: boarded });
  assert.equal(r.receipt_date, received); assert.equal(r.response_due, federalDays(received, 30)); assert.equal(r.residual_federal_bd, 10);
});

// 4.1 rule 6 worked example: $1,842.17 P&I + $612.40 escrow = $2,454.57 received 2026-03-01 but posted 2026-03-17 → 5% × 184,217¢ = 9,211¢ reversed.
test("4.1 worked example: $1,842.17 + $612.40 = $2,454.57; the $92.11 late charge is reversed and the payment re-dated to 2026-03-01", () => {
  assert.equal(cents("1842.17") + cents("612.40"), cents("2454.57"));
  const corr = N.misappliedPaymentCorrection(cents("1842.17"), "5", D("2026-03-01")); assert.equal(corr.late_charge_reversed_cents, 9_211n); assert.equal(corr.repost_effective_date, "2026-03-01");
});
