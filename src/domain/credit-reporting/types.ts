/**
 * Section 8 — credit reporting (Metro 2 / e-OSCAR / suppression).
 *
 * Codes marked † in the spec are stated from the CRRG as recalled and must be
 * confirmed against the 2026 CRRG before go-live; they are carried here as
 * named constants so the audit can swap them in one place.
 */
import type { PlainDate } from "../../kernel/calendar/date.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import type { AppliedInstallment } from "../boarding/delinquency.ts";

/** Metro 2 Account Status codes used by this section (8.1 rules 1, 7). */
export type AccountStatus =
  | "11" | "71" | "78" | "80" | "82" | "83" | "84"      // current / delinquency buckets
  | "13" | "65" | "89" | "94" | "97" | "05";           // terminal conditions

/** Payment Rating (required with terminal statuses): delinquency bucket at close. */
export type PaymentRating = "0" | "1" | "2" | "3" | "4" | "5" | "6";

/** Special Comment codes (single field; re-stated every cycle while the condition exists). */
export type SpecialComment = "" | "CP" | "AC" | "CO" | "AW" | "BO" | "AU" | "AS" | "BA" | "H" | "AZ";

/** Compliance Condition Codes — sticky at the bureaus; only XR clears (8.1 rule 8). */
export type Ccc = "" | "XB" | "XC" | "XH" | "XR";

/** Consumer Information Indicator (bankruptcy / reaffirmation). */
export type Cii = "" | "A" | "B" | "C" | "D" | "E" | "R" | "V" | "H" | "Q" | "I" | "J" | "K" | "L" | "M" | "N" | "O" | "P";

export type Ecoa = "1" | "2" | "5" | "X" | "Z" | "T";

export type PhpChar = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "G" | "H" | "J" | "K" | "L" | "B" | "D" | "E";

export type RoundingPolicy = "truncate" | "round";
export type ForbearancePolicy = "freeze" | "contractual_aging";

export interface CreditPolicy {
  readonly metro2_rounding: RoundingPolicy;                // default truncate (8.1 rule 2)
  readonly forbearance_status: ForbearancePolicy;          // default freeze (8.1-Q4)
  readonly terms_duration: "original" | "remaining";       // 8.1 rule 6 [UNVERIFIED which]
}
export const DEFAULT_POLICY: CreditPolicy = { metro2_rounding: "truncate", forbearance_status: "freeze", terms_duration: "original" };

/** Loan condition evaluated by the 8.1 rule-7 matrix (first match on terminal conditions). */
export type LoanCondition =
  | { readonly kind: "none" }
  | { readonly kind: "forbearance"; readonly effective_on: PlainDate; readonly entry_status: AccountStatus; readonly entry_amount_past_due_cents: Cents; readonly plan_payment_cents: Cents }
  | { readonly kind: "repayment_plan"; readonly plan_payment_cents: Cents; readonly remaining_arrears_cents: Cents }
  | { readonly kind: "trial"; readonly trial_payment_cents: Cents }
  | { readonly kind: "modification"; readonly new_term_months: number; readonly new_piti_cents: Cents }
  | { readonly kind: "deferral" }
  | { readonly kind: "foreclosure_sale"; readonly closed_on: PlainDate; readonly deficiency_pursued: boolean }
  | { readonly kind: "deed_in_lieu"; readonly closed_on: PlainDate }
  | { readonly kind: "short_sale"; readonly closed_on: PlainDate; readonly foreclosure_started: boolean }
  | { readonly kind: "paid_in_full"; readonly closed_on: PlainDate; readonly by_refinance: boolean }
  | { readonly kind: "charge_off"; readonly closed_on: PlainDate; readonly charge_off_cents: Cents }
  | { readonly kind: "transfer_out"; readonly transfer_date: PlainDate };

export interface CreditConsumer {
  readonly party_id: string;
  readonly position: number;                       // 1 = base segment; others J1/J2
  readonly same_address_as_base: boolean;
  readonly liability: "individual" | "joint" | "guarantor";
  readonly deceased?: boolean;
  readonly released?: boolean;                     // released after an assumption → T
  readonly never_liable?: boolean;                 // identity theft → Z
  readonly successor_in_interest?: boolean;        // confirmed successor who has not assumed → not furnished
}

/** Per-loan input to the snapshot builder — derived from ledger/terms, never from a prior snapshot. */
export interface CreditLoanState {
  readonly loan_id: string;
  readonly as_of: PlainDate;
  readonly installments: readonly AppliedInstallment[];
  readonly upb_cents: Cents;
  readonly deferred_principal_cents: Cents;
  readonly forborne_principal_cents: Cents;
  readonly pi_cents: Cents;
  readonly escrow_cents: Cents;
  readonly original_amount_cents: Cents;
  readonly note_date: PlainDate;
  readonly maturity_date: PlainDate;
  readonly original_term_months: number;
  readonly remaining_term_months: number;
  readonly interest_type: "F" | "V";
  readonly fnma_loan_number: string;
  readonly min: string | null;
  readonly payments_in_month_cents: Cents;         // borrower payments with effective dates in the month
  readonly last_payment_on: PlainDate | null;
  readonly condition: LoanCondition;
  readonly foreclosure_referred?: boolean;         // BO while referred/pending and no terminal condition
  readonly disaster_case_open?: boolean;           // AW (yields to CP)
  readonly consumers: readonly CreditConsumer[];
  /** Prior cycle's snapshot (or boarding hand-off) — PHP is carried, never recomputed. */
  readonly prior: PriorHistory | Metro2Snapshot | null;
}

export interface PriorHistory {
  readonly php: string;                            // 24 chars
  readonly status: AccountStatus | null;           // status reported last cycle (null when the cycle was omitted → `D`)
  readonly dofd: PlainDate | null;
  readonly omitted?: boolean;
}

export interface K4Segment { readonly specialized_payment_indicator: "01"; readonly balloon_due_on: PlainDate; readonly balloon_amount_cents: Cents; }

export interface ConsumerSegment {
  readonly party_id: string;
  readonly segment: "base" | "J1" | "J2";
  readonly ecoa: Ecoa;
  readonly cii: Cii;
  readonly ccc: Ccc;
  readonly special_comment: SpecialComment;
}

export interface Metro2Snapshot {
  readonly loan_id: string;
  readonly as_of: PlainDate;
  readonly account_status: AccountStatus;
  readonly payment_rating: PaymentRating | null;
  readonly special_comment: SpecialComment;
  readonly current_balance_cents: Cents;
  readonly amount_past_due_cents: Cents;
  readonly scheduled_monthly_payment_cents: Cents;
  readonly actual_payment_cents: Cents;
  readonly original_loan_amount_cents: Cents;
  readonly original_charge_off_cents: Cents;
  readonly days_past_due: number;
  readonly dofd: PlainDate | null;
  readonly date_opened: PlainDate;
  readonly date_closed: PlainDate | null;
  readonly date_of_last_payment: PlainDate | null;
  readonly terms_duration: number;
  readonly interest_type: "F" | "V";
  readonly php: string;
  readonly k3: { readonly agency_identifier: "01"; readonly fnma_loan_number: string; readonly min: string | null };
  readonly k4: K4Segment | null;
  readonly consumers: readonly ConsumerSegment[];
  readonly final_reported: boolean;                // terminal status reported once, then stop
  readonly derivation: readonly string[];          // Appendix E III(c) substantiation trail
}

export const STATUS_TO_PHP: Readonly<Record<AccountStatus, PhpChar | null>> = {
  "11": "0", "71": "1", "78": "2", "80": "3", "82": "4", "83": "5", "84": "6",
  "94": "H", "97": "L", "13": null, "65": null, "89": null, "05": null,
};
