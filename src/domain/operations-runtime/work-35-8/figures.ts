/**
 * §35.8 — the worked examples' figures (Business rules and calculations), in cents, as the screens' tests assert them
 * against the owning sections' own arithmetic. Nothing here is computed: each is the spec's bold figure.
 */
// Worked example A — post a received payment (2.1 worked example A, fixture loan L-1)
export const A_UPB_BEFORE_CENTS = 24_977_400n;        // $249,774.00
export const A_PAYMENT_CENTS = 219_257n;              // $2,192.57 (the cheque; the allocation sum)
export const A_INTEREST_CENTS = 135_294n;             // $1,352.94
export const A_PRINCIPAL_CENTS = 22_723n;             // $227.23
export const A_ESCROW_CENTS = 61_240n;                // $612.40
export const A_UPB_AFTER_CENTS = 24_954_677n;         // $249,546.77
export const A_PI_CENTS = 158_017n;
export const A_LPI_BEFORE = "2026-08-01";
export const A_LPI_AFTER = "2026-09-01";
// Worked example B — reverse it (R01); 2.7's late charge on the P&I basis
export const B_UPB_RESTORED_CENTS = 24_977_400n;      // $249,774.00
export const B_LATE_CHARGE_CENTS = 7_901n;            // $79.01 = 158,017 × 5% = 7,900.85 → 7,901 (half-up once)
// Worked example C — quote a payoff (16.1 worked example A, Ohio)
export const C_UPB_CENTS = 24_831_055n;               // $248,310.55
export const C_LATE_CHARGE_CENTS = 8_217n;            // $82.17
export const C_RECORDING_FEE_CENTS = 3_400n;          // $34.00
export const C_ESCROW_BALANCE_CENTS = 241_290n;       // $2,412.90 (refunded separately, never netted)
export const C_INTEREST_FULL_MONTH_CENTS = 134_502n;  // $1,345.02 (September)
export const C_INTEREST_PARTIAL_CENTS = 61_908n;      // $619.08 (14 October days)
export const C_PER_DIEM_CENTS = 4_422n;               // $44.22
export const C_TOTAL_CENTS = 25_039_082n;             // $250,390.82
// Worked example D — release funding (the lifecycle fixture; 35.6 rule 7a's escrow deposit)
export const D_GROSS_LOAN_CENTS = 56_000_000n;        // $560,000.00
export const D_PER_DIEM_CENTS = 9_397n;               // $93.97
export const D_PREPAID_INTEREST_CENTS = 178_543n;     // $1,785.43 (19 days)
export const D_ESCROW_DEPOSIT_CENTS = 206_250n;       // $2,062.50 (the consummated CD's initial escrow payment)
export const D_HAND_FED_ESCROW_CENTS = 166_500n;      // $1,665.00 — 26.3's hand-fed figure 35.6-T7 holds as money_mismatch; never the wire's
export const D_LENDER_CREDITS_CENTS = 70_000n;        // $700.00
export const D_NET_WIRE_CENTS = 55_685_207n;          // $556,852.07 = 56,000,000 − 178,543 − 206,250 + 70,000
