// §35.6 worked examples A and B — the spec's arithmetic reproduced as assertions against the section's constants (figures-35-6.ts);
// the spec tests assert the same constants against the owners' outputs (26.3's worksheet and per diem, 27.1's advance, 27.2's waterfall, 29.4's advice).
import { test } from "node:test";
import assert from "node:assert/strict";
import { WORKED_A, WORKED_B } from "./figures-35-6.ts";

test("35.6 worked example A — the refinance fixture's escrow, payment and funding arithmetic", () => {
  // 26.3 per diem: 56,000,000 × 0.06125 ÷ 365 = 9,397.26 cents → $93.97 (rounded per diem); 19 days of prepaid interest = $1,785.43
  assert.equal(WORKED_A.per_diem_cents, 9_397n); assert.equal(WORKED_A.prepaid_interest_cents, 178_543n); assert.equal(BigInt(WORKED_A.prepaid_days) * WORKED_A.per_diem_cents, WORKED_A.prepaid_interest_cents);
  // 30.3: monthly escrow $687.50, a two-month cushion $1,375.00, the initial deposit $2,062.50 = 687.50 + 1,375.00
  assert.equal(WORKED_A.monthly_escrow_cents, 68_750n); assert.equal(WORKED_A.cushion_cents, 137_500n); assert.equal(WORKED_A.cushion_cents, 2n * WORKED_A.monthly_escrow_cents);
  assert.equal(WORKED_A.escrow_deposit_cents, 206_250n); assert.equal(WORKED_A.escrow_deposit_cents, WORKED_A.monthly_escrow_cents + WORKED_A.cushion_cents);
  // 26.1 P&I $3,402.62; the first installment $4,090.12 = 3,402.62 + 687.50 (30.4's first statement)
  assert.equal(WORKED_A.pi_cents, 340_262n); assert.equal(WORKED_A.first_installment_cents, 409_012n); assert.equal(WORKED_A.first_installment_cents, WORKED_A.pi_cents + WORKED_A.monthly_escrow_cents);
  // 26.3 net wire $556,852.07 = 560,000.00 − 1,785.43 − 2,062.50 + 700.00; the hand-fed deposit $1,665.00 the orchestrated path cannot produce yields $557,249.57 (Discrepancies (5))
  assert.equal(WORKED_A.net_wire_cents, 55_685_207n); assert.equal(WORKED_A.net_wire_cents, WORKED_A.note_cents - WORKED_A.prepaid_interest_cents - WORKED_A.escrow_deposit_cents + WORKED_A.lender_credit_cents);
  assert.equal(WORKED_A.hand_fed_escrow_deposit_cents, 166_500n); assert.equal(WORKED_A.hand_fed_net_cents, 55_724_957n); assert.equal(WORKED_A.hand_fed_net_cents, WORKED_A.note_cents - WORKED_A.prepaid_interest_cents - WORKED_A.hand_fed_escrow_deposit_cents + WORKED_A.lender_credit_cents);
  // 27.1 advance $548,800.00 = 98 % of the note; the partner's contribution $8,052.07 = 556,852.07 − 548,800.00
  assert.equal(WORKED_A.advance_cents, 54_880_000n); assert.equal(WORKED_A.advance_cents, (WORKED_A.note_cents * 98n) / 100n); assert.equal(WORKED_A.partner_contribution_cents, 805_207n); assert.equal(WORKED_A.partner_contribution_cents, WORKED_A.net_wire_cents - WORKED_A.advance_cents);
});

test("35.6 worked example A — the purchase advice, the warehouse payoff and the waterfall", () => {
  // 29.4: price 101.125 on UPB $560,000.00 → principal proceeds $566,300.00; interest deducted $1,096.67 (12 days 30/360 at the 5.875 % pass-through); LLPA $700.00; net $564,503.33
  assert.equal(WORKED_A.principal_proceeds_cents, 56_630_000n); assert.equal(WORKED_A.principal_proceeds_cents, (WORKED_A.note_cents * 101_125n) / 100_000n);
  assert.equal(WORKED_A.interest_deducted_cents, 109_667n); assert.equal(WORKED_A.interest_deducted_cents, (WORKED_A.note_cents * 5_875n * 12n + 18_000_000n) / 36_000_000n);
  assert.equal(WORKED_A.llpa_cents, 70_000n); assert.equal(WORKED_A.net_proceeds_cents, 56_450_333n); assert.equal(WORKED_A.net_proceeds_cents, WORKED_A.principal_proceeds_cents - WORKED_A.interest_deducted_cents - WORKED_A.llpa_cents); assert.equal(WORKED_A.variance_cents, 0n);
  // 27.1 / 27.2: warehouse interest $725.64 (7 days Nov 12–18 at 6.80 % act/360 on the $548,800.00 advance), the $25.00 wire fee, the payoff $549,550.64; after the payoff $14,952.69
  assert.equal(WORKED_A.warehouse_interest_cents, 72_564n); assert.equal(WORKED_A.warehouse_interest_cents, (WORKED_A.advance_cents * 680n * 7n + 1_800_000n) / 3_600_000n);
  assert.equal(WORKED_A.wire_fee_cents, 2_500n); assert.equal(WORKED_A.payoff_cents, 54_955_064n); assert.equal(WORKED_A.payoff_cents, WORKED_A.advance_cents + WORKED_A.warehouse_interest_cents + WORKED_A.wire_fee_cents);
  assert.equal(WORKED_A.after_payoff_cents, 1_495_269n); assert.equal(WORKED_A.after_payoff_cents, WORKED_A.net_proceeds_cents - WORKED_A.payoff_cents);
  // 27.2 waterfall: the premium $6,300.00; SM's cost recovery $3,485.00; SM retained $1,415.00 = 6,300.00 − 700.00 − 700.00 − 3,485.00; the partner's residual $10,052.69 = 14,952.69 − 3,485.00 − 1,415.00
  assert.equal(WORKED_A.premium_cents, 630_000n); assert.equal(WORKED_A.sm_cost_recovery_cents, 348_500n); assert.equal(WORKED_A.sm_retained_cents, 141_500n); assert.equal(WORKED_A.sm_retained_cents, WORKED_A.premium_cents - WORKED_A.lender_credit_cents - WORKED_A.llpa_cents - WORKED_A.sm_cost_recovery_cents);
  assert.equal(WORKED_A.partner_residual_cents, 1_005_269n); assert.equal(WORKED_A.partner_residual_cents, WORKED_A.after_payoff_cents - WORKED_A.sm_cost_recovery_cents - WORKED_A.sm_retained_cents);
});

test("35.6 worked example B — the purchase fixture's funding and purchase arithmetic", () => {
  // the note $412,000.00; 30.3's initial deposit $1,240.00; the lender credit $515.00 (27.2 worked example C); 27.1 warehouse interest $1,067.72 (14 days at 6.80 % act/360 on $403,760.00)
  assert.equal(WORKED_B.note_cents, 41_200_000n); assert.equal(WORKED_B.escrow_deposit_cents, 124_000n); assert.equal(WORKED_B.lender_credit_cents, 51_500n);
  assert.equal(WORKED_B.warehouse_interest_cents, 106_772n); assert.equal(WORKED_B.warehouse_interest_cents, (WORKED_B.advance_cents * 680n * 14n + 1_800_000n) / 3_600_000n);
  // 26.3: per diem $71.96 (41,200,000 × 0.06375 ÷ 365 = 7,195.89 → rounded), 13 days = $935.48; net wire $410,339.52 = 412,000.00 − 935.48 − 1,240.00 + 515.00
  assert.equal(WORKED_B.per_diem_cents, 7_196n); assert.equal(WORKED_B.prepaid_interest_cents, 93_548n); assert.equal(BigInt(WORKED_B.prepaid_days) * WORKED_B.per_diem_cents, WORKED_B.prepaid_interest_cents);
  assert.equal(WORKED_B.net_wire_cents, 41_033_952n); assert.equal(WORKED_B.net_wire_cents, WORKED_B.note_cents - WORKED_B.prepaid_interest_cents - WORKED_B.escrow_deposit_cents + WORKED_B.lender_credit_cents);
  // 27.1: advance $403,760.00 = 98 %; contribution $6,579.52
  assert.equal(WORKED_B.advance_cents, 40_376_000n); assert.equal(WORKED_B.advance_cents, (WORKED_B.note_cents * 98n) / 100n); assert.equal(WORKED_B.partner_contribution_cents, 657_952n); assert.equal(WORKED_B.partner_contribution_cents, WORKED_B.net_wire_cents - WORKED_B.advance_cents);
  // 29.4 / 27.2: gross proceeds $416,120.00 = 412,000.00 × 1.01; net $416,190.10 = gross + $70.10 interest due the lender; the premium $4,120.00 = 1 % of the note; the gain $3,605.00 = 4,120.00 − 515.00
  assert.equal(WORKED_B.gross_proceeds_cents, 41_612_000n); assert.equal(WORKED_B.gross_proceeds_cents, (WORKED_B.note_cents * 101n) / 100n); assert.equal(WORKED_B.net_proceeds_cents, 41_619_010n); assert.equal(WORKED_B.net_proceeds_cents, WORKED_B.gross_proceeds_cents + WORKED_B.interest_due_lender_cents);
  assert.equal(WORKED_B.premium_cents, 412_000n); assert.equal(WORKED_B.premium_cents, WORKED_B.note_cents / 100n); assert.equal(WORKED_B.gain_cents, 360_500n); assert.equal(WORKED_B.gain_cents, WORKED_B.premium_cents - WORKED_B.lender_credit_cents);
  // 27.2: after the warehouse payoff $404,852.72 the remainder $11,337.38; SM's cost recovery $2,774.00 and retained $831.00 = 4,120.00 − 515.00 − 0.00 − 2,774.00; the partner's residual $7,732.38 = 11,337.38 − 2,774.00 − 831.00
  assert.equal(WORKED_B.payoff_cents, 40_485_272n); assert.equal(WORKED_B.after_payoff_cents, 1_133_738n); assert.equal(WORKED_B.after_payoff_cents, WORKED_B.net_proceeds_cents - WORKED_B.payoff_cents);
  assert.equal(WORKED_B.sm_retained_cents, 83_100n); assert.equal(WORKED_B.sm_retained_cents, WORKED_B.premium_cents - WORKED_B.lender_credit_cents - WORKED_B.sm_cost_recovery_cents); assert.equal(WORKED_B.partner_residual_cents, 773_238n); assert.equal(WORKED_B.partner_residual_cents, WORKED_B.after_payoff_cents - WORKED_B.sm_cost_recovery_cents - WORKED_B.sm_retained_cents);
});
