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
  | "Withdrawn"
  // 32.12 §1.2 / §2: the exit states — Paying off (funds received) · Servicing moving (goodbye mailed) · Transferred out (from the effective date; read-only)
  | "Paying off"
  | "Servicing moving"
  | "Transferred out"
  | "Cancelled" // 32.7 §4: `rescission_periods.status = rescinded` — the Record is read-only
  | "Bankruptcy — protections in effect"; // 32.10 §9: a verified bankruptcy petition (14.1) — collection outreach stopped, informational notices only

export type RecordStatus = {
  badge: StatusBadge;
  state_source: { state: string; table: string };
  one_liner: string; // copy key (12) — rendered through lib/copy
  one_liner_tokens?: Record<string, string | string[]>;   // 32.8 §2: a token used twice ({{date}} · autopay on {{date}}) is an array consumed in order
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
  /** 32.5 §1: every line is the borrower's (`count(owner=you)` is the strip count); a verb-first line rendered from the copy library. */
  owner?: "you";
  label_copy_key?: string;
  copy_tokens?: Record<string, string>;
};
/** 32.5 §1 "What we're doing": an item we or a third party own, with its owner label from the copy library. */
export type DoingItem = {
  item_id: string;
  kind: "condition";
  label: string;
  owner: "us" | "title_company" | "appraiser" | "prior_servicer";
  owner_copy_key: string;
  status: string;
  source: "conditions";
  created_at?: Timestamptz;
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
  /** 32.9 §3 / 7.3: the engine's estimate once the initial ARM notice (`NTC_REGZ_20D_ARM_INITIAL`) is sent — never recomputed by the shell. */
  arm_estimate?: ArmEstimate;
};

/** 32.9 §3: `arm.initial_notice.sent` on the record — the change date and first new payment due from the schedule row the notice covers, the estimated rate and P&I the 7.3 engine disclosed. */
export type ArmEstimate = {
  basis: "estimate" | "actual";
  change_on: string | null;
  first_new_payment_due: string | null;
  estimated_rate: Rate | null;
  estimated_pi_cents: Cents | null;
  notice_id: string | null;
  sent_on: string | null;
};

export type RecordNumbers = PreFundingNumbers | PostFundingNumbers;

export type RecordDate = {
  timer_code: string;
  label: string;
  due_at: Timestamptz;
  calendar: string;
  message_id?: Uuid; // the thread message that produced it (01 §1.4)
  /** 32.4 §4.3: the lock row turns caution on SM_LOCK_EXPIRY_WARN_7's day. */
  tone?: "caution";
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
  /** 32.4: the civil date of receipt (the deemed date under the mailbox rule), the LE version, the mailed original an electronic copy stands beside. */
  received_on?: string;
  le_version?: number;
  copy_of_disclosure_id?: Uuid;
  /** 32.16 §2.2: the DocumentCard / NoticeCard this row expands to on the rail (the API names it beside the document). */
  card_instance_id?: Uuid;
  /** 32.5 §7 / 7.4 rule 4: one LE issued per consumer on their own channel — each consumer's status beside the one document. */
  deliveries?: { borrower_id: string; display_name: string; channel: string; status: "delivered" | "mailed" | "received"; at: Timestamptz }[];
};

export type RecordPerson = {
  party_id: Uuid;
  role:
    | "borrower"
    | "co_borrower"
    | "non_borrowing_spouse"
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
  /** 32.12: `ends_on` (a transfer out — the last pre-cutover draft 17.2 stored) and `terminated_on` (a payoff / transfer). */
  autodraft?: { status: string; next_draft_on?: string; amount_cents?: Cents; account_last4?: string; ends_on?: string; terminated_on?: string; termination_reason?: string };
  escrow_lines?: EscrowLine[];
  mi?: { status: string; projected_end_on?: string; cancellation_eligible_on?: string };
  arm?: { next_change_on: string; notice_status: string };
  year_end?: { form_1098_status: string; tax_year?: number | string | null; furnished_on?: string | null; channel?: string | null };   // 32.8 §5: `tax_form.1098.furnished{channel}` → mailed | available
  continuity_team?: { name: string; direct_number: string };
  ratewatch?: {
    current_rate: Rate; best_available_rate: Rate;
    /** 32.11 §1 (src/runtime/borrower/flows/11-rate-watch.ts `rateWatchSection`): the sheet the best rate came from, the block's state (passive until an opportunity exists), the copy keys the row renders, the open OfferCard / the application in progress */
    rate_sheet_id?: string | null; state?: "passive" | "offer_open" | "in_progress"; worth_it_copy_key?: string; state_copy_key?: string; offer_card_instance_id?: Uuid | null; application_id?: Uuid | null;
  };
  /** 32.12 §1.2: rate-watch ends with the loan (`refi_opportunities.void`). */
  ratewatch_status?: "void" | "active";
  /** 32.11 §5 (DELTA-05): the standing verification authorization (`consents{kind=blanket_verification_authorization, standing=true}`) and the ChoiceCard that turns it off */
  standing_connections?: { status: "active" | "withdrawn" | "none"; consent_id?: Uuid | null; captured_at?: Timestamptz | null; withdrawn_at?: Timestamptz | null; manage_card_instance_id?: Uuid | null; vendors?: string[] };
  /** 32.10 §Record "Loan": the hardship block the flow projects (src/runtime/borrower/flows/10-hardship.ts `hardshipSection`) */
  hardship?: HardshipBlock;
};

/** 32.10: the Loan section's hardship rows — trial period plan (`hardship.tpp`), forbearance (`hardship.forb`), an accepted plan, a written cease (11.4). Dates are the owning events' own. */
export type HardshipBlock = {
  status: "none" | "application_pending" | "offer_pending" | "tpp_active" | "forbearance" | "plan_accepted" | "deemed_rejected";
  application?: { application_id: string; status: string; received_on?: string; reasonable_date?: string; missing_documents?: string[] };
  offer?: { option?: string; accept_by?: string; status: string; deemed_rejected_on?: string };
  tpp?: { n: number; count: number; amount_cents: Cents; due_on: string; remaining: number };
  forbearance?: { plan_id: string; term_start: string; term_end: string; status: string; late_charges_suppressed: boolean };
  cease?: { received_on: string; scope: string };
  bankruptcy?: { chapter?: string; statement_mode?: string };
};

export type RecordOffer = {
  refi_opportunity_id: Uuid;
  status: "detected" | "offer_ready" | "offered" | "converted" | "declined" | "expired" | "suppressed" | "requested";
  offered_at?: Timestamptz;
  expires_at?: Timestamptz;
  terms?: { offered_rate: Rate; monthly_savings_cents: Cents };
};

/** 32.16 §2.2 (DELTA-26): the journey's steps — done / current / upcoming — derived by the API from the event spine and `card_instances`, never stored; the rail renders "{{done}} of {{total}}" from the counts it carries. */
export type JourneyStep = { id: string; label_copy_key: string; state: "done" | "current" | "upcoming"; at: Timestamptz | null };
export type JourneyProgress = { steps: JourneyStep[]; done: number; total: number };

export type BorrowerRecord = {
  subject: RecordSubject;
  status: RecordStatus;
  next?: RecordNext;
  needed_from_you: NeededItem[];
  /** 32.5 §1: the items we or a third party own, and the one count the status strip shows (zero → `needs.none`). */
  what_we_are_doing?: DoingItem[];
  needed_summary?: { count: number; nothing_needed: boolean; copy_key: "needs.title" | "needs.none" };
  numbers?: RecordNumbers;
  dates: RecordDate[];
  documents: RecordDocument[];
  people: RecordPerson[];
  property?: RecordProperty;
  loan?: RecordLoan;
  offers?: RecordOffer[];
  /** 32.16 §2.2: the Progress section; absent for a serviced loan. */
  journey_progress?: JourneyProgress | null;
  /** Header helpers (01 §4 row 1) */
  header: { address_line: string; purpose: "Buying" | "Refinancing" | "Your loan"; loan_label: string };
  timezone: string; // borrower time zone, e.g. America/Phoenix
  /** 32.6 §1.3 / §1.5: a terminal disposition (denied, withdrawn, closed) leaves the Record read-only. */
  read_only?: boolean;
};

/** 02 §1.2 `thread_messages` */
export type MessageSender = "borrower" | "agent" | "human" | "notice" | "system";
export type MessageChannel = "app" | "sms" | "email" | "voice" | "mail";

export type ThreadMessage = {
  /**
   * 32.14: tokens for the line's `{{copy:key}}` sentence (`entry.resumed` → `{{answers}}`); absent on most lines.
   * 32.16 §1 principle 8 / T7: `element: "rates"` names a rates element the app draws from the 20.3 range in the same
   * tokens (`product`, `low_rate`, `low_apr`, `high_rate`, `high_apr`, `lender`, `nmlsr_id`, `as_of`) — never text.
   */
  copy_tokens?: Record<string, string>;
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
  /** 32.14 §3: how the session was opened (`otp_phone` · `otp_email` · `passkey` · `oidc_google`); a Google session gets the `auth.add_mobile` prompt. */
  auth_method?: string;
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
