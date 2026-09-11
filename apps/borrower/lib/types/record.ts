/**
 * `borrower_record` transcribed from docs/ux/02-data-contracts.md §1.1, plus
 * `thread_messages` (§1.2). Money is `Cents` (decimal string of cents), rates are
 * decimal strings — see lib/types/cards.ts.
 */
import type { Cents, Rate, Timestamptz, Uuid } from "./cards";

export type TransactionType = "purchase" | "limited_cash_out" | "cash_out";
export type Occupancy = "primary" | "second_home" | "investment";

export type RecordSubject = {
  application_id?: Uuid;
  loan_id?: Uuid;
  label: string;
  transaction_type: TransactionType;
  occupancy: Occupancy;
};

/** 01 §4 status badge catalogue. */
export type StatusBadge =
  | "Getting started"
  | "Prequalified"
  | "Preapproved"
  | "Application received"
  | "Loan Estimate sent"
  | "Ready to proceed"
  | "Rate locked"
  | "Rate floating"
  | "Verifying"
  | "Approved with conditions"
  | "Counteroffer"
  | "What's missing"
  | "Clear to close"
  | "Closing scheduled"
  | "Signed"
  | "Cancel window"
  | "Funding"
  | "Funded"
  | "Your loan"
  | "Current"
  | "Payment due"
  | "Past due"
  | "Behind"
  | "On a plan"
  | "Paused"
  | "Paid off"
  | "Closed"
  | "Decision letter sent"
  | "Withdrawn";

export type RecordStatus = {
  badge: StatusBadge;
  state_source: { state: string; table: string };
  one_liner: string; // copy key (12) — rendered through lib/copy
  one_liner_tokens?: Record<string, string>;
};

export type RecordNext = {
  label: string;
  due_at: Timestamptz;
  timer_code: string;
  calendar_note?: string;
};

export type NeededKind =
  | "condition"
  | "consent"
  | "confirmation"
  | "connector"
  | "document_request"
  | "acknowledgment"
  | "schedule"
  | "signature";

export type NeededItem = {
  item_id: string;
  kind: NeededKind;
  label: string;
  due_at?: Timestamptz;
  card_instance_id: Uuid;
};

export type LockBlock = {
  status: "none" | "requested" | "pending_mlo_approval" | "executed" | "confirmed" | "expired" | "floating";
  expires_at?: Timestamptz;
  period_days?: number;
};

export type PreFundingNumbers = {
  phase: "pre_funding";
  note_rate?: Rate;
  rate_range?: { low: Rate; high: Rate }; // R7: estimated rate as a range only
  apr?: Rate;
  pi_payment_cents?: Cents;
  escrow_payment_cents?: Cents;
  loan_amount_cents?: Cents;
  cash_to_close_cents?: Cents; // purchase
  monthly_savings_cents?: Cents; // refi
  lock: LockBlock;
  figures_source: "quote" | `le_v${number}` | `cd_v${number}` | "none";
  footer?: string; // "not a commitment to lend; rates change daily; {{partner.legal_name}} …"
};

export type PostFundingNumbers = {
  phase: "post_funding";
  upb_cents: Cents;
  next_payment: { due_on: string; amount_cents: Cents; pi_cents: Cents; escrow_cents: Cents };
  escrow_balance_cents: Cents;
  note_rate: Rate;
  days_past_due: number; // regx_days_delinquent
};

export type RecordNumbers = PreFundingNumbers | PostFundingNumbers;

export type RecordDate = {
  timer_code: string;
  label: string;
  due_at: Timestamptz;
  calendar: string;
  message_id?: Uuid; // the thread message that produced it (01 §1.4)
};

export type DocumentStatus = "pending" | "delivered" | "received" | "deemed_received" | "mailed" | "superseded";
export type RecordDocument = {
  document_id: Uuid;
  disclosure_id?: Uuid;
  notice_code?: string;
  title: string;
  kind: string;
  status: DocumentStatus;
  delivered_at?: Timestamptz;
  received_at?: Timestamptz;
  mailed_at?: Timestamptz;
  requires_ack: boolean;
  channel: "app" | "email" | "mail" | "sms";
  message_id?: Uuid;
};

export type RecordPerson = {
  party_id: Uuid;
  role:
    | "borrower"
    | "co_borrower"
    | "mlo_of_record"
    | "human_agent"
    | "notary"
    | "settlement_agent"
    | "continuity_of_contact_team"
    | "appraiser";
  display_name: string;
  progress?: { consents_ok: boolean; confirmations_ok: boolean; signed: boolean };
  nmlsr_id?: string;
  direct_number?: string;
  commission_state?: string;
  waiting?: boolean; // "invited, waiting"
};

export type RecordProperty = {
  address?: string;
  tbd: boolean;
  property_type?: string;
  units?: number;
  occupancy?: Occupancy;
  valuation?: {
    method: "value_acceptance" | "appraisal" | "pdc" | "pending";
    status: string;
    appointment_at?: Timestamptz;
    value_used_cents?: Cents;
    label?: string; // "No appraisal needed" · "Appraisal scheduled Nov 3" · "Appraisal received"
  };
  flood?: { status: string; label?: string };
  hazard?: { status: string; label?: string };
  project_review?: { status: string; label?: string };
  hoa_dues_cents?: Cents;
};

export type EscrowLine = { type: string; payee: string; next_disbursement_on?: string; annual_cents: Cents };

export type RecordLoan = {
  autodraft?: { status: string; next_draft_on?: string; amount_cents?: Cents; account_last4?: string };
  escrow_lines?: EscrowLine[];
  mi?: { status: string; projected_end_on?: string; cancellation_eligible_on?: string };
  arm?: { next_change_on: string; notice_status: string };
  year_end?: { form_1098_status: string };
  continuity_team?: { name: string; direct_number: string };
  ratewatch?: { current_rate: Rate; best_available_rate: Rate };
};

export type RecordOffer = {
  refi_opportunity_id: Uuid;
  status: "detected" | "offer_ready" | "offered" | "converted" | "declined" | "expired" | "suppressed" | "requested";
  offered_at?: Timestamptz;
  expires_at?: Timestamptz;
  terms?: { offered_rate: Rate; monthly_savings_cents: Cents };
};

export type BorrowerRecord = {
  subject: RecordSubject;
  status: RecordStatus;
  next?: RecordNext;
  needed_from_you: NeededItem[];
  numbers?: RecordNumbers;
  dates: RecordDate[];
  documents: RecordDocument[];
  people: RecordPerson[];
  property?: RecordProperty;
  loan?: RecordLoan;
  offers?: RecordOffer[];
  /** Header helpers (01 §4 row 1) */
  header: { address_line: string; purpose: "Buying" | "Refinancing" | "Your loan"; loan_label: string };
  timezone: string; // borrower time zone, e.g. America/Phoenix
};

/** 02 §1.2 `thread_messages` */
export type MessageSender = "borrower" | "agent" | "human" | "notice" | "system";
export type MessageChannel = "app" | "sms" | "email" | "voice" | "mail";

export type ThreadMessage = {
  message_id: Uuid;
  conversation_id: Uuid;
  at: Timestamptz;
  sender: MessageSender;
  sender_label: string; // "Supermortgage" · "Dana · Loan officer" · "Notice"
  channel: MessageChannel;
  body_text?: string;
  card_instance_id?: Uuid;
  subject: { application_id?: Uuid; loan_id?: Uuid; label?: string };
  voice_turn: boolean;
  delivery: { sent: boolean; delivered: boolean; read: boolean };
  /** 01 §7.1 — true on the first assistant message of a session */
  automation_marker?: boolean;
};

export type BorrowerMe = {
  party_id: Uuid;
  first_name: string;
  level: "L1" | "L2" | "L3";
  subjects: RecordSubject[];
  partner: { legal_name: string; nmlsr_id: string };
};

/** 02 §3 SSE frame */
export type StreamEvent = {
  event_name: string;
  at: Timestamptz;
  subject: { application_id?: Uuid; loan_id?: Uuid };
  payload_ref?: string;
};

/** 02 §7 error envelope */
export type ApiError = { code: string; gate?: string; copy_key: string };
