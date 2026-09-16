/**
 * §35.4 worked examples A–C — every `$n.nn` figure under "Business rules and calculations", as the cents the tests assert
 * against (tools/audit.py counts the `<cents>n` literal in src/domain/operations-runtime/*.test.ts; each is asserted here
 * against these exports so a drift in either direction fails). Bigint cents, never a float.
 */
// Worked example A — the September 2026 S/S MBS balance attestation (6.3's own figures, 6.3 rule 7)
export const EX_A_BANK_CLOSING_LEDGER = 125_430_055n;      // $1,254,300.55
export const EX_A_DEPOSITS_IN_TRANSIT = 1_245_000n;        // $12,450.00 (lockbox batch LBX-0930-07, 14 loans)
export const EX_A_ADJUSTED_DEPOSITORY = 126_675_055n;      // $1,266,750.55 = 125,430,055 + 1,245,000 − 0 + 0
export const EX_A_L3_PREPAID_NET = 812_040n;               // $8,120.40
export const EX_A_L4_CURTAILMENTS = 4_500_000n;            // $45,000.00
export const EX_A_L5_INTEREST_FUNDINGS = 0n;               // $0.00
export const EX_A_L7_PAYOFF_FIXED_NET = 321_015n;          // $3,210.15
export const EX_A_L8_DELINQUENT_PI_NET = -2_258_000n;      // −$22,580.00 (17 loans, none in Stop Delinquency Advance)
export const EX_A_L9_FNMA_RECEIVABLE = 123_300_000n;       // $1,233,000.00
export const EX_A_L10 = 0n;
export const EX_A_L11 = 0n;
export const EX_A_L12 = 126_675_055n;                      // $1,266,750.55 = Σ L3..L11
export const EX_A_CASHBOOK = 126_675_055n;                 // $1,266,750.55 = Σ ledger_lines custodial_pi_cash through 9/30
export const EX_A_VARIANCE = 0n;                           // $0.00
// Worked example B — the reopen (a $1,250.00 returned item restates the 9/30 statement)
export const EX_B_RETURNED_ITEM = 125_000n;                // $1,250.00
export const EX_B_RESTATED_CLOSING_LEDGER = 125_305_055n;  // $1,253,050.55 = 125,430,055 − 125,000
export const EX_B_ADJUSTED_BEFORE_CORRECTION = 126_550_055n; // 125,305,055 + 1,245,000
export const EX_B_VARIANCE_BEFORE_CORRECTION = -125_000n;  // −$1,250.00 = 126,550,055 − 126,675,055 (a variance row, never a plug)
export const EX_B_L3_AFTER_REVERSAL = 687_040n;            // $6,870.40 = 812,040 − 125,000
export const EX_B_ADJUSTED_DEPOSITORY = 126_550_055n;      // $1,265,500.55
export const EX_B_L12 = 126_550_055n;
export const EX_B_CASHBOOK = 126_550_055n;
// Worked example C — the tax-year 2026 close
export const EX_C_LOAN_1_INTEREST = 2_341_255n;            // $23,412.55 (7.1-T13's loan)
export const EX_C_LOAN_2_INTEREST = 987_012n;              // $9,870.12
export const EX_C_LOAN_3_INTEREST = 41_240n;               // $412.40
export const EX_C_LEDGER_INTEREST_SUM = 3_369_507n;        // $33,695.07 = 2,341,255 + 987,012 + 41,240
export const EX_C_REPORTABLE_LOANS = 3;
export const EX_C_FILED_LOANS = 2;                         // box 1 ≥ $600.00
// The sections' floors this process reads, never redefines
export const IRS_1098_FILE_FLOOR = 60_000n;                // $600.00 (7.1 decision 5: furnish below, file at or above)
export const IRS_1099_INT_FLOOR = 1_000n;                  // $10.00 (3.9: 26 U.S.C. 6049)
