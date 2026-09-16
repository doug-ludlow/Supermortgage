/**
 * §35.10 worked examples A and B — every bold figure of "Business rules and calculations" as exported cents constants
 * (the tests assert the owners' rows against these; the pass never reads them: rule 2, nothing here computes a payoff figure).
 */
import type { Cents } from "../../../kernel/money/cents.ts";
import type { PlainDate } from "../../../kernel/calendar/date.ts";
import { plainDate as D } from "../../../kernel/calendar/date.ts";

/** Worked example A — the lifecycle fixture's funded loan as the prior loan (Arizona, A/A, same-servicer credit). */
export const A = {
  prior_original_cents: 56_000_000n as Cents,          // $560,000.00 at 6.125%, 360 months, funded 2026-11-12
  prior_note_rate_pct: "6.125",
  ptr_pct: "5.875",
  upb_cents: 55_945_571n as Cents,                     // $559,455.71 after the January 1 installment (posted 2026-12-30)
  initial_escrow_deposit_cents: 206_250n as Cents,     // $2,062.50 at funding
  monthly_escrow_cents: 68_750n as Cents,              // $687.50
  escrow_balance_cents: 275_000n as Cents,             // $2,750.00 = 2,062.50 + 687.50
  lpi_due: D("2027-01-01") as PlainDate,
  consummation: D("2027-01-25") as PlainDate,
  disbursement: D("2027-01-29") as PlainDate,
  quote_on: D("2027-01-19") as PlainDate,
  days_partial: 28,                                    // Jan 1–28
  interest_cents: 262_868n as Cents,                   // 559,455.71 × 0.06125 ÷ 365 × 28 = 2,628.6766… → $2,628.68
  per_diem_cents: 9_388n as Cents,                     // 559,455.71 × 0.06125 ÷ 365 = 93.8813… → $93.88
  total_cents: 56_208_439n as Cents,                   // $562,084.39
  variance_cents: 0n as Cents,                         // $0.00
  ptr_interest_cents: 252_138n as Cents,               // 559,455.71 × 0.05875 ÷ 365 × 28 = 2,521.3772… → $2,521.38
  servicing_fee_cents: 10_730n as Cents,               // 2,628.68 − 2,521.38 = $107.30
  crs_001_cents: 56_197_709n as Cents,                 // 559,455.71 + 2,521.38 = $561,977.09
  cd_initial_deposit_cents: 343_750n as Cents,         // $3,437.50 (five months at $687.50, 30.3's figure)
  cash_to_close_escrow_cents: 68_750n as Cents,        // $687.50 after the credit
  new_loan_cents: 57_500_000n as Cents,                // $575,000.00 at 5.375%, 360 months
  new_note_rate_pct: "5.375",
  new_pi_cents: 321_983n as Cents,                     // 575,000 × (0.05375 ÷ 12) ÷ (1 − (1 + 0.05375 ÷ 12)^−360) = 3,219.8328… → $3,219.83
  release_deadline: D("2027-02-28") as PlainDate,      // 2027-01-29 + 30 (A.R.S. §33-707; no roll-forward)
  release_prepare_due: D("2027-02-05") as PlainDate,   // +5 servicer BD
  release_submit_due: D("2027-02-19") as PlainDate,
  refund_issue_on: D("2027-02-05") as PlainDate,       // after the 5-BD hold
  refund_due: D("2027-03-01") as PlainDate,            // 20 federal BD after 2027-01-29 (Presidents' Day excluded)
  short_year_statement_due: D("2027-03-30") as PlainDate,
  short_payoff_line_cents: 56_202_439n as Cents,       // $562,024.39 (T12: $60.00 short, beyond the $50 tolerance)
} as const;

/** Worked example B — partner-book demo loan 1 (Arizona, Northlight Mortgage Servicing, monitored). */
export const B = {
  servicer_loan_number: "NL-100001",
  original_cents: 45_000_000n as Cents,                // $450,000.00 at 7.250%, 360 months, first payment 2024-11-01
  note_rate_pct: "7.250",
  pi_cents: 306_979n as Cents,                         // $3,069.79
  ti_cents: 61_250n as Cents,                          // $612.50
  upb_tape_cents: 44_136_613n as Cents,                // $441,366.13 on the 2026-09-01 tape after 23 payments
  october_interest_cents: 266_659n as Cents,           // 441,366.13 × 0.0725 ÷ 12 = 2,666.5871… → $2,666.59
  october_principal_cents: 40_320n as Cents,           // 3,069.79 − 2,666.59 = $403.20
  upb_after_october_cents: 44_096_293n as Cents,       // $440,962.93
  interest_paid_through: D("2026-09-30") as PlainDate,
  per_diem_cents: 8_759n as Cents,                     // 440,962.93 × 0.0725 ÷ 365 = 87.5896… → $87.59
  request_on: D("2026-10-12") as PlainDate,
  statement_date: D("2026-10-21") as PlainDate,
  consummation: D("2026-10-26") as PlainDate,
  disbursement: D("2026-10-30") as PlainDate,
  interest_cents: 254_011n as Cents,                   // Oct 1–29 = 29 × $87.59 = $2,540.11
  total_cents: 44_350_304n as Cents,                   // $443,503.04 good through 2026-10-30
  slipped_disbursement: D("2026-11-02") as PlainDate,
  slipped_total_cents: 44_376_581n as Cents,           // 443,503.04 + 3 × 87.59 = $443,765.81
  refreshed_interest_cents: 280_288n as Cents,         // Oct 1–Nov 1 = 32 × $87.59 = $2,802.88
  partner_confirm_due: D("2026-11-23") as PlainDate,   // +21 calendar days from 2026-11-02
  confirming_tape: D("2026-11-09") as PlainDate,
  disputing_tape: D("2026-11-30") as PlainDate,
} as const;
