// 12.6 Payment Deferral
// spec/sections/12-loss-mitigation/12-6-payment-deferral.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { capStructure, deferralSolicitationClocks, deferralOfferOnCompleteApp, deferralLedger, smduDeferralOutage, recordableAgreement } from "./ops.ts";
import { nib, newPayment, timeline, screen } from "./deferral.ts";

// 12.6-T1 — implemented in src/domain/lossmit/lossmit.test.ts
// 12.6-T2 — implemented in src/domain/lossmit/lossmit.test.ts
// 12.6-T3 — implemented in src/domain/lossmit/lossmit.test.ts
test("12.6-T4: (cap) cumulative 9 months deferred previously + 4 now = 13 \u2192 gate requires the contractual payment and the deferral is limited to 3 months (cap 12) with the 4th installment paid \u2014 engine offers the compliant structure or routes to Flex Mod (policy).", () => {
  const r = capStructure({ prior_deferred_months: 9, requested_months: 4 });
  assert.equal(r.cumulative, 13); assert.equal(r.contractual_payment_required, true); assert.equal(r.months_allowed, 3); assert.equal(r.installments_to_pay, 1); assert.equal(r.alternative, "flex_mod");
  const s = screen({ months_delinquent: 4, origination_date: D("2021-10-01"), evaluation_date: D("2026-09-20"), cumulative_deferred_months: 9, months_to_maturity: 348 }); assert.ok(s.eligible && s.contractual_payment_required && s.months_deferred === 3);
});
// 12.6-T5 — implemented in src/domain/lossmit/lossmit.test.ts
test("12.6-T6: (solicitation clocks) forbearance expired 2026-12-31 without QRPC \u2192 solicitation by 2027-01-15; repayment failure at 2026-11-30 \u2192 solicitation by 2026-12-15.", () => {
  assert.deepEqual(deferralSolicitationClocks({ forbearance_expired_on: D("2026-12-31"), repayment_failed_month_end: D("2026-11-30") }), { post_forbearance_by: "2027-01-15", post_repayment_by: "2026-12-15" });
});
test("12.6-T7: (Reg X) deferral offered on a complete application \u2192 notice carries (c)(1) content and a 14-day window; deemed rejection after the grace releases holds.", () => {
  const r = deferralOfferOnCompleteApp({ provided_on: D("2026-10-02") });
  assert.equal(r.c1_content, true); assert.equal(r.window_days, 14); assert.equal(r.accept_by, "2026-10-16"); assert.equal(r.deemed_rejected_on, "2026-10-19"); assert.equal(r.holds_released_on, "2026-10-19"); assert.equal(r.notice, "NTC_FNMA_D23204_DEFERRAL_OFFER");
});
test("12.6-T8: (ledger) postings balance; IB UPB equals the scheduled balance; `deferred_principal` = $7,370.68; payoff statement shows the NIB line.", () => {
  const r = deferralLedger({ pi_cents: 158_017n, months_deferred: 4, escrow_advances_cents: 105_000n, servicing_advances_cents: 0n, late_charges_cents: 25_200n, scheduled_ib_upb_cents: 22_800_000n });
  assert.equal(r.balanced, true); assert.equal(r.deferred_principal_cents, 737_068n); assert.equal(r.ib_upb_cents, 22_800_000n);
  assert.ok(r.postings.every((p) => p.rule_ref.startsWith("12.6.deferral"))); assert.deepEqual(r.payoff_lines[1], { line: "Deferred principal (non-interest-bearing)", cents: 737_068n });
});
test("12.6-T9: (SMDU outage) B2B failure on 2026-09-28 \u2192 portal task filed; operator completes 2026-09-29; case evidence attached.", () => {
  const tl = timeline(D("2026-09-20")); const r = smduDeferralOutage({ evaluation_on: D("2026-09-20"), failed_on: D("2026-09-28"), operator_completed_on: D("2026-09-29"), entry_deadline: tl.entry_deadline, evidence_document_id: "doc-smdu-1" });
  assert.deepEqual(r.portal_task, { kind: "human_portal_task", filed_on: "2026-09-28" }); assert.equal(r.completed_on, "2026-09-29"); assert.equal(r.within_entry_deadline, true); assert.deepEqual(r.case_evidence, { document_id: "doc-smdu-1", attached: true });
});
test("12.6-T10: (recording state) `deferral_recording=true` \u2192 recordable agreement executed by `signing_officer`, e-recorded, certified copy to custodian \u226425 days, original \u22645 BD after receipt.", () => {
  const r = recordableAgreement({ recording_required: true, executed_by_role: "signing_officer", borrower_signed_on: D("2026-09-25"), erecorded_on: D("2026-10-02"), recorded_original_received_on: D("2026-10-20") });
  assert.equal(r.allowed, true); assert.equal(r.certified_copy_to_custodian_by, "2026-10-20"); assert.equal(r.erecorded_on, "2026-10-02"); assert.equal(r.original_to_custodian_by, "2026-10-27"); assert.equal(r.unrecorded_original_by, null);
  assert.equal(recordableAgreement({ recording_required: true, executed_by_role: "ops_analyst", borrower_signed_on: D("2026-09-25") }).allowed, false);
});

test("12.6 worked figures: P&I $1,580.17 × 4 + tax advance $1,050.00 = $7,370.68 NIB; late charges 4 × $63.00 = $252.00 waived; shortage $1,860.00 → $31.00/month; T&I $520.00 → payment $2,131.17", () => {
  assert.equal(nib(158017n, 4, 105000n, 0n), 737068n); assert.equal(4n * 6300n, 25200n);
  assert.deepEqual(newPayment(158017n, 52000n, 186000n), { shortage_monthly_cents: 3100n, payment_cents: 213117n });
});
