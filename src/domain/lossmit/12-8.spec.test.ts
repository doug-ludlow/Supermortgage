// 12.8 Fannie Mae Flex Modification
// spec/sections/12-loss-mitigation/12-8-fannie-mae-flex-modification.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { streamlinedSolicitationWindow, mbsExecutionGate, modDocumentClocks, conversionLedger, flexIncentive, flexEligibilityDenial, mirLookup } from "./ops.ts";
import { waterfall, balanceAfter, accruedInterest, trialSchedule, type WaterfallInputs } from "./flexmod.ts";

// 12.8-T1 — implemented in src/domain/lossmit/lossmit.test.ts
// 12.8-T2 — implemented in src/domain/lossmit/lossmit.test.ts
// 12.8-T3 — implemented in src/domain/lossmit/lossmit.test.ts
// 12.8-T4 — implemented in src/domain/lossmit/lossmit.test.ts
// 12.8-T5 — implemented in src/domain/lossmit/lossmit.test.ts
test("12.8-T6: (solicitation window) day 90 on 2026-11-02 with no BRP \u2192 solicitation by 2026-11-17; a non-judicial sale scheduled 2026-11-25 \u2192 solicitation refused.", () => {
  const ok = streamlinedSolicitationWindow({ day90_on: D("2026-11-02"), brp_complete: false, sale_on: null, judicial: false }); assert.equal(ok.solicit_by, "2026-11-17"); assert.equal(ok.allowed, true);
  const near = streamlinedSolicitationWindow({ day90_on: D("2026-11-02"), brp_complete: false, sale_on: D("2026-11-25"), judicial: false }); assert.equal(near.allowed, false); assert.match(near.refusal!, /SALE_PROXIMITY/);
});
test("12.8-T7: (MBS) MBS loan \u2192 servicer execution blocked until `smdu.case.reclassified`; effective date re-dated if needed.", () => {
  const blocked = mbsExecutionGate({ mbs: true, reclassified_on: null, effective: D("2027-01-01") }); assert.equal(blocked.execution_allowed, false); assert.match(blocked.refusal!, /smdu\.case\.reclassified/);
  const late = mbsExecutionGate({ mbs: true, reclassified_on: D("2027-01-05"), effective: D("2027-01-01") }); assert.equal(late.execution_allowed, true); assert.equal(late.effective, "2027-02-01"); assert.equal(late.redated, true);
  assert.equal(mbsExecutionGate({ mbs: false, reclassified_on: null, effective: D("2027-01-01") }).execution_allowed, true);
});
test("12.8-T8: (documents) Form 3179 sent 2026-12-01; borrower e-signs 2026-12-10; `signing_officer` executes 2026-12-28; recording required \u2192 certified copy of the executed agreement to the custodian by 2027-01-04 (25 days from 2026-12-10), e-recorded 2027-01-05, original to the custodian within 5 BD of receipt from the recorder; an unrecorded agreement instead goes as the fully executed original by 2027-01-04.", () => {
  const r = modDocumentClocks({ form_3179_sent_on: D("2026-12-01"), borrower_signed_on: D("2026-12-10"), servicer_executed_on: D("2026-12-28"), servicer_role: "signing_officer", recording_required: true, erecorded_on: D("2027-01-05"), recorded_original_received_on: D("2027-01-20") });
  assert.equal(r.allowed, true); assert.equal(r.certified_copy_to_custodian_by, "2027-01-04"); assert.equal(r.erecorded_on, "2027-01-05"); assert.equal(r.original_to_custodian_by, "2027-01-27"); assert.equal(r.servicer_executed_on, "2026-12-28");
  const unrecorded = modDocumentClocks({ form_3179_sent_on: D("2026-12-01"), borrower_signed_on: D("2026-12-10"), servicer_executed_on: D("2026-12-28"), servicer_role: "signing_officer", recording_required: false }); assert.equal(unrecorded.unrecorded_original_by, "2027-01-04"); assert.equal(unrecorded.erecorded_on, null);
});
test("12.8-T9: (conversion ledger) capitalization entries balance; late charges $505.68 waived; NIB $35,483.32 in `forborne_principal`; loan terms versioned effective 2027-01-01; delinquency reset; loan-data change acked.", () => {
  const W: WaterfallInputs = { ib_upb_cents: 23_676_547n, accrued_interest_cents: 1_025_984n, escrow_advances_cents: 420_000n, servicing_advances_cents: 18_000n, prior_nib_cents: 0n, value_cents: 29_000_000n, contract_rate_pct: "6.500", is_arm_not_final: false, remaining_term_months: 309, pre_mod_pi_cents: 158_017n, mir_pct: "6.625", delinquent_31_plus: true };
  const r = conversionLedger({ ...W, late_charges_cents: 50_568n, effective: D("2027-01-01"), loan_data_change_acked: true });
  assert.equal(r.balanced, true); assert.equal(r.late_charges_waived_cents, 50_568n); assert.equal(r.forborne_principal_cents, 3_548_332n);
  assert.deepEqual(r.loan_terms_version, { effective: "2027-01-01", rate_pct: "6.500", term_months: 480, ib_upb_cents: 21_592_199n }); assert.equal(r.next_due, "2027-01-01"); assert.equal(r.delinquency_reset, true); assert.deepEqual(r.loan_data_change, { reported: true, acked: true });
  assert.ok(r.postings.every((p) => p.rule_ref.startsWith("12.8.capitalization")));
});
test("12.8-T10: (incentive) SMDU close by 2027-02-28 \u2192 $1,000 claimed; close on 2027-03-02 \u2192 no claim, sev-3 logged.", () => {
  const ok = flexIncentive({ effective: D("2027-01-01"), smdu_closed_on: D("2027-02-28") }); assert.equal(ok.deadline, "2027-02-28"); assert.equal(ok.claim_cents, 100_000n); assert.equal(ok.claimed, true); assert.equal(ok.escalation, null);
  const late = flexIncentive({ effective: D("2027-01-01"), smdu_closed_on: D("2027-03-02") }); assert.equal(late.claim_cents, 0n); assert.equal(late.escalation!.severity, "sev3");
});
test("12.8-T11: (three prior mods) denial with the specific Fannie Mae criterion; reviewer approval; appeal rights.", () => {
  const r = flexEligibilityDenial({ prior_modifications: 3, reviewer_approval_id: "rev-9", tier: "ge_90", first_filing_made: false });
  assert.equal(r.denied, true); assert.match(r.criterion, /three or more times/); assert.equal(r.notice!.names_investor, true); assert.equal(r.notice!.quotes_criterion, true); assert.equal(r.notice!.mailing_allowed, true); assert.equal(r.reviewer_required, true); assert.equal(r.appeal_rights, true);
  assert.equal(flexEligibilityDenial({ prior_modifications: 3, tier: "ge_90", first_filing_made: false }).notice!.mailing_allowed, false);
  assert.equal(flexEligibilityDenial({ prior_modifications: 2, tier: "ge_90", first_filing_made: false }).denied, false);
});
test("12.8-T12: (MIR feed) MIR table lacks a rate for the evaluation date \u2192 waterfall refuses to run; `officer` alert.", () => {
  const empty = mirLookup([{ effective: D("2026-09-15"), rate_pct: "6.625" }], D("2026-09-09"));
  assert.equal(empty.rate_pct, null); assert.match(empty.refusal!, /no Modification Interest Rate/); assert.equal(empty.escalation!.kind, "officer");
  const ok = mirLookup([{ effective: D("2026-08-14"), rate_pct: "6.625" }, { effective: D("2026-09-15"), rate_pct: "6.750" }], D("2026-09-09")); assert.equal(ok.rate_pct, "6.625"); assert.equal(ok.effective, "2026-08-14"); assert.equal(ok.refusal, null);
});

test("12.8 worked figures: IB UPB $236,765.47; interest $1,282.48 × 8 = $10,259.84; advances $4,200.00 + $180.00; gross $251,405.31; value $290,000.00; target P&I $1,264.13; 480-month P&I $1,471.87; IB UPB $215,921.99; forbearance $35,483.32 vs (b) $106,405.31 / (c) $75,421.59; trial $1,815.13 = $1,264.13 + $520.00 + $31.00 (shortage $1,860.00); late charges $505.68 (8 × $63.21)", () => {
  const W: WaterfallInputs = { ib_upb_cents: 23_676_547n, accrued_interest_cents: 1_025_984n, escrow_advances_cents: 420_000n, servicing_advances_cents: 18_000n, prior_nib_cents: 0n, value_cents: 29_000_000n, contract_rate_pct: "6.500", is_arm_not_final: false, remaining_term_months: 309, pre_mod_pi_cents: 158_017n, mir_pct: "6.625", delinquent_31_plus: true };
  assert.equal(balanceAfter(25_000_000n, "6.500", 360, 51), 23676547n); assert.equal(accruedInterest(23676547n, "6.500", 1), 128248n); assert.equal(accruedInterest(23676547n, "6.500", 8), 1025984n);
  assert.equal(W.escrow_advances_cents + W.servicing_advances_cents, 420000n + 18000n); assert.equal(W.value_cents, 29000000n);
  const w = waterfall(W); assert.equal(w.gross_upb_cents, 25140531n); assert.equal(w.target_pi_cents, 126413n); assert.equal(w.ib_upb_cents, 21592199n); assert.equal(w.forborne_cents, 3548332n); assert.equal(w.pi_cents, 126413n);
  assert.equal(w.forbearance_caps!.b, 10640531n); assert.equal(w.forbearance_caps!.c, 7542159n); assert.ok(w.trace.some((t) => t.includes("pi=147187")));
  const ts = trialSchedule(D("2026-09-11"), 3, 52000n, 3100n, 126413n); assert.equal(ts.trial_payment_cents, 181513n); assert.equal(186000n / 60n, 3100n); assert.equal(8n * 6321n, 50568n);
});
