/**
 * Canonical (post-mapping) view of one loan on a boarding tape, plus the
 * external positions the 1.1 data-quality gate compares it against. Field
 * names follow the spec's `loan_terms`/`loans` columns so the mapping layer
 * (transferor column → MISMO path → these fields) is the only translation.
 */
import type { PlainDate } from "../../kernel/calendar/date.ts";
import type { Cents } from "../../kernel/money/cents.ts";

export type RemittanceType = "A/A" | "S/A" | "S/S";
export type InterestMethod = "30_360" | "actual_360" | "actual_365" | "daily_simple";
export type Amortization = "fixed" | "arm" | "step" | "balloon" | "interest_only" | "buydown";

export interface Installment { readonly due_date: PlainDate; readonly amount_cents: Cents; }
export interface HistoricalPayment { readonly received_on: PlainDate; readonly amount_cents: Cents; }

export interface StagedLoan {
  readonly transferor_loan_number: string;
  readonly fnma_loan_number: string | null;
  readonly min: string | null;
  readonly mers_eligible: boolean;
  readonly remittance_type: string | null;
  readonly upb_cents: Cents | null;
  readonly scheduled_upb_cents?: Cents | null;          // S/S loans: scheduled UPB per Fannie Mae position
  readonly next_due_date: PlainDate | null;
  readonly note_rate_pct: string | null;                // "6.375"
  readonly pi_cents: Cents | null;
  readonly escrow_payment_cents: Cents;
  readonly maturity_date: PlainDate | null;
  readonly original_term_months: number | null;
  readonly original_upb_cents: Cents | null;
  readonly instrument_date: PlainDate;
  readonly origination_date: PlainDate | null;
  readonly first_payment_date: PlainDate | null;
  readonly interest_method: InterestMethod | null;
  readonly amortization: Amortization;
  readonly arm?: {
    readonly index?: string | null; readonly margin_bps?: number | null;
    readonly initial_cap_bps?: number | null; readonly periodic_cap_bps?: number | null; readonly lifetime_cap_bps?: number | null;
    readonly lookback_days?: number | null; readonly next_change_date?: PlainDate | null;
  };
  readonly escrowed: boolean;
  readonly escrow_balance_cents: Cents;
  readonly escrow_lines: readonly { readonly line_type: string; readonly annual_amount_cents: Cents; readonly next_due_date?: PlainDate }[];
  /** False when the escrow history shows disbursements that contradict the balance sign (HF-007, second clause). */
  readonly escrow_sign_consistent: boolean;
  readonly last_escrow_analysis_date: PlainDate | null;
  readonly late_charge_pct: string | null;
  readonly late_charge_grace_days: number | null;
  readonly deferred_principal_cents: Cents;
  readonly forborne_principal_cents: Cents;
  /** True when deferred/forborne balances are carried separately from interest-bearing UPB (HF-016). */
  readonly nib_separated: boolean;
  readonly bankruptcy: { readonly active: boolean; readonly chapter?: string | null; readonly case_number?: string | null; readonly filed_on?: PlainDate | null };
  readonly foreclosure: { readonly active: boolean; readonly referral_date?: PlainDate | null; readonly attorney?: string | null };
  readonly lossmit: { readonly in_process: boolean; readonly application_status?: string | null; readonly received_on?: PlainDate | null };
  readonly scra: { readonly active: boolean; readonly rate_cap_reason?: string | null };
  readonly borrower: { readonly legal_name: string | null; readonly tin: string | null; readonly phone?: string | null; readonly email?: string | null; readonly preferred_language?: string | null };
  readonly property: { readonly address_line1: string | null; readonly city: string | null; readonly state: string | null; readonly postal_code: string | null; readonly occupancy?: string | null };
  readonly custody: { readonly custodian?: string | null; readonly certification_status?: string | null; readonly enote_evault_ref?: string | null } | null;
  readonly consents: { readonly esign_evidence: boolean; readonly tcpa_voice_evidence: boolean };
  readonly tax_parcel_verified: boolean;
  readonly hazard_policy_expires: PlainDate | null;
  readonly mi: { readonly flag: boolean; readonly certificate_number?: string | null };
  readonly flood_determination_life_of_loan: boolean;
  readonly sii: { readonly present: boolean; readonly complete: boolean };
  readonly unapplied_cents: Cents;
  readonly fair_lending_present: boolean;
  readonly acp_enrolled: boolean;
  readonly fees_advances_cents: Cents;
  readonly fees_itemized: boolean;
  readonly corporate_advances_cents: Cents;
  readonly late_charges_due_cents: Cents;
  readonly mers_investor_is_fnma: boolean | null;
  /** Transferor payment history: the installment schedule and receipts. FIFO application derives delinquency (never the tape's code). */
  readonly installments: readonly Installment[];
  readonly payments: readonly HistoricalPayment[];
  /** Principal applied by the transferor on the last posted installment, when supplied (interest-method review). */
  readonly last_principal_applied_cents?: Cents | null;
}

export interface FnmaPosition {
  readonly fnma_loan_number: string;
  readonly on_approved_list: boolean;
  readonly remittance_type: RemittanceType;
  readonly upb_cents: Cents;                // actual UPB (A/A, S/A)
  readonly scheduled_upb_cents?: Cents;     // S/S
}

export interface MersRecord { readonly min: string; readonly status: "Active" | "Inactive" | "Deactivated"; readonly servicer_org_id: string; readonly investor_org_id?: string; }

export interface BatchContext {
  readonly batch_id: string;
  readonly transfer_date: PlainDate;
  readonly transferor_party_id: string;
  readonly transferor_servicer_number: string;
  readonly partner_servicer_number: string;
  readonly rule_set_version: string;
  /** MERS Org IDs acceptable as the current servicer on the MIN (partner and transferor). */
  readonly acceptable_mers_org_ids: ReadonlySet<string>;
}

export interface ExternalPositions {
  fnma(loanNumber: string): FnmaPosition | undefined;
  trialBalanceUpb(transferorLoanNumber: string): Cents | undefined;
  mers(min: string): MersRecord | undefined;
  licensed(state: string): boolean;
  /** fnma_loan_number / MIN already on the platform (HF-017). */
  onPlatform(kind: "fnma_loan_number" | "min", value: string): boolean;
}

export type Severity = "hard" | "warning";

export interface RuleResult {
  readonly code: string;
  readonly severity: Severity;
  readonly result: "pass" | "fail";
  readonly money_field: boolean;
  readonly message?: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
}
