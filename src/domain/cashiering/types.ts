/**
 * Section 2 cashiering types, following the spec's `payments`,
 * `payment_allocations`, `payment_holds` and `loan_installments` tables.
 */
import type { PlainDate } from "../../kernel/calendar/date.ts";
import type { Cents } from "../../kernel/money/cents.ts";

export type Channel = "lockbox" | "ach_debit_origin" | "ach_credit_inbound" | "wire" | "portal_onetime" | "ivr" | "agent_assisted" | "mail_office" | "card" | "third_party_contractor" | "assistance_program" | "bk_trustee" | "transferor_forward" | "transfer_in_opening";
export type Instrument = "check" | "money_order" | "cashiers_check" | "ach" | "wire" | "card_debit" | "card_credit" | "book_transfer";
export type Designation = "unspecified" | "contractual" | "curtailment" | "escrow_only" | "fees_only" | "trial" | "payoff" | "reinstatement" | "biweekly_half";
export type PayerType = "borrower" | "coborrower" | "successor" | "third_party" | "contractor" | "program" | "trustee" | "transferor";
export type PaymentStatus = "received" | "identified" | "held" | "allocated" | "posted" | "reversed" | "returned" | "refunded";
export type AllocationOutcome = "applied" | "applied_with_50_rule" | "curtailment" | "prepaid" | "unapplied" | "held_trial" | "held_bk" | "held_fc" | "held_dispute" | "held_other" | "refunded" | "payoff_routed";
export type Bucket = "interest" | "principal" | "escrow" | "late_charge" | "nsf_fee" | "other_fee" | "curtailment" | "suspense" | "deferred_principal" | "forborne_principal" | "corporate_advance" | "escrow_advance";
export type HoldType = "bankruptcy" | "foreclosure_post_referral" | "noe_dispute" | "fraud" | "deceased_estate" | "payoff_pending" | "transfer_out_cutover";
export type InstrumentProfile = "uniform_1999_plus" | "pre_1999";
export type InstallmentStatus = "due" | "satisfied" | "prepaid" | "deferred" | "forborne";

export interface ChannelConfig {
  readonly channel: Channel;
  /** Local cut-off "HH:MM" after which an item is dated the next business day (lockbox 17:00; portal 23:59 ET). */
  readonly cutoff?: { readonly hhmm: string; readonly timeZone: string };
  readonly conforming: boolean;
  /** Reg Z (c)(1)(iii): up to +5 calendar days for nonconforming payments; default policy 0. */
  readonly nonconforming_credit_days: 0 | 1 | 2 | 3 | 4 | 5;
  readonly requirements_version: string;         // written payment-requirements text version in force
  /** Cash lands directly in a custodial account (ACH/wire/direct deposit) rather than clearing. */
  readonly direct_to_custodial: boolean;
}

export interface PaymentInput {
  readonly channel: Channel;
  readonly instrument: Instrument;
  readonly amount_cents: Cents;
  /** Instant the item reached the servicer/agent (scan time, submission time, settlement instant). */
  readonly received_at: string;
  /** Settlement/value date for ACH/wire; scheduled settlement for originated debits. */
  readonly settlement_date?: PlainDate;
  /** Transferor's receipt date for forwarded items (§1024.33(c)). */
  readonly transferor_received_on?: PlainDate;
  readonly designation?: Designation;
  readonly borrower_instruction_text?: string;
  readonly instruction_source?: string;
  readonly payer_type?: PayerType;
  readonly payer_name?: string;
  readonly source_batch_id?: string;
  readonly source_item_id?: string;
  readonly loan_id?: string;                     // null until identified
  readonly custodial_account_id?: string;
  readonly trace_number?: string;
  readonly check_number?: string;
  /** Portion the borrower/contractor designated as additional principal (2.4). */
  readonly curtailment_cents?: Cents;
}

export interface Allocation {
  readonly sequence: number;
  readonly installment_due_date: PlainDate | null;
  readonly bucket: Bucket;
  readonly amount_cents: Cents;
  readonly rule_ref: string;
  readonly credited_as_of: PlainDate;
}

export interface Payment extends Omit<PaymentInput, "loan_id"> {
  readonly id: string;
  loan_id?: string;
  readonly idempotency_key: string;
  readonly received_on: PlainDate;
  readonly credited_as_of: PlainDate;
  readonly conforming: boolean;
  readonly nonconforming_reason?: string;
  readonly requirements_version: string;
  status: PaymentStatus;
  allocation_outcome?: AllocationOutcome;
  allocations: Allocation[];
  ledger_entry_set_ids: string[];
  investor_event_ids: string[];
  decision_ids: string[];
  reversal?: { reason: ReversalReason; return_code?: string; reversed_at: string; entry_set_ids: string[] };
}

export type ReversalReason = "returned_item" | "misapplied" | "duplicate" | "fraud" | "correction";

export interface InstallmentProjection {
  readonly due_date: PlainDate;
  readonly pi_cents: Cents;
  readonly escrow_cents: Cents;
  status: InstallmentStatus;
  satisfied_on?: PlainDate;
  credited_as_of?: PlainDate;
  satisfied_by_payment_id?: string;
}

/** The slice of loan state the allocation engine reads and writes. */
export interface LoanCashState {
  readonly loan_id: string;
  readonly instrument_date: PlainDate;
  readonly lien: "first" | "second" | "other";
  readonly escrowed: boolean;
  readonly note_rate_pct: string;
  readonly remittance_type: "A/A" | "S/A" | "S/S";
  upb_cents: Cents;                              // interest-bearing UPB
  lpi_date: PlainDate | null;
  installments: InstallmentProjection[];
  late_charges_due_cents: Cents;
  nsf_fees_due_cents: Cents;
  other_fees_due_cents: Cents;
  suspense_unapplied_cents: Cents;
  holds: HoldType[];
  trial_active: boolean;
  plan_active: boolean;                          // repayment/forbearance plan (12.4/12.5)
  partial_count_12m: number;
  opted_out_of_50_rule: boolean;
  // ---- fields read by 2.2–2.7 (optional so older fixtures stay valid; see `cashCfg`) ----
  deferred_principal_cents?: Cents;             // non-interest-bearing (NIB) balances, 2.4 rule 4
  forborne_principal_cents?: Cents;
  late_30_count_12m?: number;                   // 2.2 four-condition test (ii)
  nsf_count_12m?: number;                       // 2.2 (iii)
  fc_referred?: boolean;                        // 13.3 referral exists
  partial_payment_fc_risk?: boolean;            // jurisdiction_rules.partial_payment_fc_risk
  mbs_pool?: boolean;                           // 2.4 rule 5: MBS loans cannot reapply prepayments
  note_frequency?: "monthly" | "biweekly";      // 2.5 rule 5: a true biweekly note accrues 14 days' interest per installment (F-1-09)
  late_charge_pct?: string;                     // "5" = 5% of basis
  late_charge_grace_days?: number;              // 15 → last timely day = due + 15
  late_charge_cap_cents?: Cents | null;
  late_charge_basis?: "pi" | "piti";
  fees?: Fee[];                                 // 2.7 per-installment late-charge state + NSF fees
  overlays?: Overlay[];                         // 2.7 rule 3 overlays in force
  courtesy_waivers_12m?: number;
  transfer_shield_until?: PlainDate | null;     // §1024.33(c)(1) 60-day window (1.3)
}

export type LateChargeState = "not_due" | "evaluating" | "assessed" | "accrued_suspended" | "not_assessed" | "collected" | "waived" | "reversed" | "written_off";

export interface Fee {
  readonly id: string;
  readonly fee_type: "late_charge" | "nsf_fee";
  readonly installment_due_date: PlainDate | null;
  amount_cents: Cents;
  state: LateChargeState;
  readonly assessed_on: PlainDate;
  readonly grace_end_on?: PlainDate;
  suppression?: string;                        // e.g. trial_pending_waiver, bankruptcy_active
  collected_cents: Cents;
  collected_on?: PlainDate | null;             // date the charge was collected (2.7-T13: Σ collected per period → fees.collected)
  waived_reason?: string;
}

export type OverlayKind = "transfer_window_60" | "forbearance_active" | "scra_reduced_rate" | "bankruptcy_active" | "repayment_plan_pending_waiver" | "trial_pending_waiver" | "foreclosure_referred" | "noe_dispute" | "posting_backlog";
export interface Overlay { readonly kind: OverlayKind; readonly from: PlainDate; readonly to?: PlainDate | null; readonly defaulted_on?: PlainDate | null; readonly installment_due_date?: PlainDate; }

/** Resolved defaults for the optional 2.2–2.7 fields. */
export function cashCfg(s: LoanCashState) {
  return {
    deferred: s.deferred_principal_cents ?? 0n, forborne: s.forborne_principal_cents ?? 0n,
    late30: s.late_30_count_12m ?? 0, nsf12: s.nsf_count_12m ?? 0, fcReferred: s.fc_referred ?? false, fcRisk: s.partial_payment_fc_risk ?? false,
    mbs: s.mbs_pool ?? false, lcPct: s.late_charge_pct ?? "5", grace: s.late_charge_grace_days ?? 15, lcCap: s.late_charge_cap_cents ?? null, basis: s.late_charge_basis ?? "pi",
    fees: s.fees ?? [], overlays: s.overlays ?? [], courtesy: s.courtesy_waivers_12m ?? 0, shieldUntil: s.transfer_shield_until ?? null,
  };
}

export function instrumentProfile(instrumentDate: PlainDate): InstrumentProfile {
  return instrumentDate >= "1999-03-01" ? "uniform_1999_plus" : "pre_1999";
}

export const BUCKET_ORDER: Record<InstrumentProfile, readonly Exclude<Bucket, "curtailment" | "suspense" | "deferred_principal" | "forborne_principal" | "corporate_advance" | "escrow_advance" | "nsf_fee" | "other_fee">[]> = {
  uniform_1999_plus: ["interest", "principal", "escrow", "late_charge"],
  pre_1999: ["escrow", "interest", "principal", "late_charge"],
};
