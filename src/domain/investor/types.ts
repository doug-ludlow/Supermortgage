/** §5 Investor Reporting & Remittance — shared types (investor_events, positions, remittances). */
import type { PlainDate } from "../../kernel/calendar/date.ts";
import type { Cents } from "../../kernel/money/cents.ts";

export type InvestorEventType = "payment.contractual" | "payment.curtailment" | "payment.reversal" | "payment.none" | "payment.prepaid" | "fees.collected" | "rate_payment.change" | "loan_id.change" | "loan_data.change" | "mi.discontinuance" | "removal.payoff" | "removal.repurchase" | "removal.liquidation.uninsured" | "removal.liquidation.third_party" | "removal.liquidation.insured" | "delinquency.status" | "escrow.setup" | "escrow.deposit" | "escrow.disbursement" | "escrow.modification" | "transfer.servicing" | "scra.rate_reduction";
export type EventFamily = "payment" | "nonpayment" | "removal" | "delinquency" | "escrow" | "loan_data_change" | "mi" | "transfer" | "scra";
export type InvestorEventStatus = "pending" | "projected" | "queued" | "submitted" | "accepted" | "accepted_with_warnings" | "rejected_hard" | "rejected_soft" | "invalid" | "missing" | "superseded" | "cancelled";
export type ChannelMode = "legacy" | "dual" | "event";
export type RemittanceType = "AA" | "SA" | "SS";

export const EVENT_FAMILY: Record<InvestorEventType, EventFamily> = {
  "payment.contractual": "payment", "payment.curtailment": "payment", "payment.reversal": "payment", "payment.none": "nonpayment", "payment.prepaid": "payment", "fees.collected": "payment",
  "rate_payment.change": "loan_data_change", "loan_id.change": "loan_data_change", "loan_data.change": "loan_data_change", "mi.discontinuance": "mi",
  "removal.payoff": "removal", "removal.repurchase": "removal", "removal.liquidation.uninsured": "removal", "removal.liquidation.third_party": "removal", "removal.liquidation.insured": "removal",
  "delinquency.status": "delinquency", "escrow.setup": "escrow", "escrow.deposit": "escrow", "escrow.disbursement": "escrow", "escrow.modification": "escrow", "transfer.servicing": "transfer", "scra.rate_reduction": "scra",
};

/** Legacy LAR action codes for removal events. */
export const ACTION_CODE: Partial<Record<InvestorEventType, string>> = { "payment.contractual": "00", "payment.curtailment": "00", "payment.none": "00", "payment.prepaid": "00", "removal.payoff": "60", "removal.repurchase": "65", "removal.liquidation.uninsured": "70", "removal.liquidation.third_party": "71", "removal.liquidation.insured": "72" };

export interface InvestorEvent {
  readonly id: string; readonly loan_id: string; readonly servicer_number: string; readonly fnma_loan_number: string;
  readonly event_type: InvestorEventType; readonly event_family: EventFamily; readonly effective_date: PlainDate; readonly processed_at: string;
  readonly activity_period: string; readonly per_loan_sequence: number; readonly payload: LarPayload; readonly idempotency_key: string;
  status: InvestorEventStatus; supersedes_event_id?: string; deadline_at?: number; readonly mode: ChannelMode;
}

export interface LarPayload {
  readonly lpi_date: PlainDate | null; readonly upb_cents: Cents; readonly nib_cents: Cents; readonly interest_cents: Cents; readonly principal_cents: Cents; readonly other_fees_cents: Cents;
  readonly action_code: string; readonly action_date: PlainDate; readonly suspense_cents?: Cents; readonly note_rate_pct?: string; readonly ptr_pct?: string; readonly pi_cents?: Cents;
}

export interface InvestorLoanPosition { readonly loan_id: string; fnma_lpi_date: PlainDate | null; fnma_actual_upb_cents: Cents; fnma_scheduled_upb_cents: Cents; fnma_nib_balance_cents: Cents; fnma_ptr_pct: string; fnma_note_rate_pct: string; fnma_pi_cents: Cents; remittance_type: RemittanceType; participation_pct: string; last_accepted_sequence: number; }
