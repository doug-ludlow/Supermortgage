/**
 * §35.6 worked examples A (the refinance fixture, Phoenix) and B (the purchase fixture, Columbus) — every bold figure of
 * "Business rules and calculations" as bigint cents. The spec tests assert them against these constants and against the
 * owners' own outputs (26.3's worksheet and per diem, 27.1's advance, 27.2's waterfall, 29.4's advice): the orchestrator
 * computes nothing new; it compares the owners' figures (rule 7).
 */
export const WORKED_A = {
  note_cents: 56_000_000n,                 // $560,000.00
  per_diem_cents: 9_397n,                  // $93.97 — 56,000,000 × 0.06125 ÷ 365 = 9,397.26 → rounded per diem
  prepaid_days: 19,
  prepaid_interest_cents: 178_543n,        // $1,785.43 = 19 × $93.97
  pi_cents: 340_262n,                      // $3,402.62
  monthly_escrow_cents: 68_750n,           // $687.50
  cushion_cents: 137_500n,                 // $1,375.00
  escrow_deposit_cents: 206_250n,          // $2,062.50 = 687.50 + 1,375.00
  lender_credit_cents: 70_000n,            // $700.00
  net_wire_cents: 55_685_207n,             // $556,852.07 = 560,000.00 − 1,785.43 − 2,062.50 + 700.00
  hand_fed_escrow_deposit_cents: 166_500n, // $1,665.00 — 26.3's example 1 deposit the orchestrated path cannot produce
  hand_fed_net_cents: 55_724_957n,         // $557,249.57 — the net that deposit yields (Discrepancies (5))
  advance_cents: 54_880_000n,              // $548,800.00 = 0.98 × 560,000.00
  partner_contribution_cents: 805_207n,    // $8,052.07 = 556,852.07 − 548,800.00
  first_installment_cents: 409_012n,       // $4,090.12 = 3,402.62 + 687.50
  price: "101.125",
  principal_proceeds_cents: 56_630_000n,   // $566,300.00 = 560,000.00 × 1.01125
  interest_deducted_cents: 109_667n,       // $1,096.67 — 12 days 30/360 at 5.875%
  llpa_cents: 70_000n,                     // $700.00
  net_proceeds_cents: 56_450_333n,         // $564,503.33
  variance_cents: 0n,                      // $0.00
  warehouse_interest_cents: 72_564n,       // $725.64 — 7 days Nov 12–18 at 6.80% act/360
  wire_fee_cents: 2_500n,                  // $25.00
  payoff_cents: 54_955_064n,               // $549,550.64
  after_payoff_cents: 1_495_269n,          // $14,952.69 = 564,503.33 − 549,550.64
  sm_cost_recovery_cents: 348_500n,        // $3,485.00
  premium_cents: 630_000n,                 // $6,300.00
  sm_retained_cents: 141_500n,             // $1,415.00 = 6,300.00 − 700.00 − 700.00 − 3,485.00
  partner_residual_cents: 1_005_269n,      // $10,052.69 = 14,952.69 − 3,485.00 − 1,415.00
} as const;
export const WORKED_B = {
  note_cents: 41_200_000n,                 // $412,000.00
  per_diem_cents: 7_196n,                  // $71.96 — 41,200,000 × 0.06375 ÷ 365 = 7,195.89 → rounded per diem
  prepaid_days: 13,
  prepaid_interest_cents: 93_548n,         // $935.48 = 13 × $71.96
  escrow_deposit_cents: 124_000n,          // $1,240.00
  lender_credit_cents: 51_500n,            // $515.00 (27.2 worked example C)
  net_wire_cents: 41_033_952n,             // $410,339.52 = 412,000.00 − 935.48 − 1,240.00 + 515.00
  advance_cents: 40_376_000n,              // $403,760.00 = 0.98 × 412,000.00
  partner_contribution_cents: 657_952n,    // $6,579.52
  interest_due_lender_cents: 7_010n,       // $70.10 — 1 day at PTR 6.125%, 30/360
  gross_proceeds_cents: 41_612_000n,       // $416,120.00 = 412,000.00 × 1.01
  net_proceeds_cents: 41_619_010n,         // $416,190.10
  warehouse_interest_cents: 106_772n,      // $1,067.72 — 14 days at 6.80% act/360
  wire_fee_cents: 2_500n,                  // $25.00
  payoff_cents: 40_485_272n,               // $404,852.72
  after_payoff_cents: 1_133_738n,          // $11,337.38
  sm_cost_recovery_cents: 277_400n,        // $2,774.00
  premium_cents: 412_000n,                 // $4,120.00 = 412,000.00 × 0.01
  gain_cents: 360_500n,                    // $3,605.00 = 4,120.00 − 515.00
  sm_retained_cents: 83_100n,              // $831.00 = 4,120.00 − 515.00 − 0.00 − 2,774.00
  partner_residual_cents: 773_238n,        // $7,732.38 = 11,337.38 − 2,774.00 − 831.00
} as const;
