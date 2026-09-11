/**
 * Card types transcribed from docs/ux/01-foundations.md §3 ("Component library — cards").
 * Every card renders from a `card_instances` row (02 §1.6): `{...CardBase, props, evidence}`.
 *
 * Money on the wire is a decimal string of cents (`Cents`), never a JS number
 * (docs/ARCHITECTURE.md: bigint cents; the runtime's wire form is a decimal string).
 * Rates are decimal strings in percent units ("6.125"). The client never does float
 * arithmetic on either — see lib/format.
 */

export type Uuid = string;
/** Decimal string of integer cents, e.g. "56000000" = $560,000.00. Signed. */
export type Cents = string;
/** Decimal string of a rate in percent units, e.g. "6.125". */
export type Rate = string;
/** ISO-8601 timestamp with zone. */
export type Timestamptz = string;

export type CardKind =
  | "StatusCard"
  | "ChoiceCard"
  | "ConfirmCard"
  | "ConnectCard"
  | "ConsentCard"
  | "DocumentCard"
  | "ComparisonCard"
  | "ChecklistCard"
  | "UploadCard"
  | "ExplanationCard"
  | "ScheduleCard"
  | "PaymentCard"
  | "InviteCard"
  | "HandoffCard"
  | "OfferCard"
  | "NoticeCard"
  | "PersonCard"
  | "ProfileCard"
  | "DemographicsCard";

export const CARD_KINDS: readonly CardKind[] = [
  "StatusCard",
  "ChoiceCard",
  "ConfirmCard",
  "ConnectCard",
  "ConsentCard",
  "DocumentCard",
  "ComparisonCard",
  "ChecklistCard",
  "UploadCard",
  "ExplanationCard",
  "ScheduleCard",
  "PaymentCard",
  "InviteCard",
  "HandoffCard",
  "OfferCard",
  "NoticeCard",
  "PersonCard",
  "ProfileCard",
  "DemographicsCard",
];

export type CardStatus = "pending" | "resolved" | "expired" | "superseded" | "cancelled";

export type CardCreatedBy =
  | "agent:intake"
  | "agent:borrower-comms"
  | "agent:disclosure"
  | "agent:verification"
  | "agent:underwriter"
  | "agent:title-closing"
  | "agent:escrow"
  | "agent:cashiering"
  | "agent:pmi"
  | "agent:insurance-property"
  | "agent:default-collections"
  | "agent:lossmit-underwriter"
  | "agent:payoff-release"
  | `human:${string}`
  | "system";

/** 01 §3 `CardBase`, verbatim field set. */
export type CardBase = {
  card_instance_id: Uuid;
  conversation_id: Uuid; // per party (§6.1)
  party_id: Uuid; // the borrower this card is for
  subject: { application_id?: Uuid; loan_id?: Uuid };
  kind: CardKind;
  status: CardStatus;
  created_by: CardCreatedBy;
  copy_key: string; // 12-message-copy-library
  expires_at?: Timestamptz; // rendered as a countdown when < 72h
  evidence?: Record<string, unknown>; // persisted on resolve
};

// ---------------------------------------------------------------------------
// Per-kind props (01 §3.1–3.19)
// ---------------------------------------------------------------------------

/** 3.1 StatusCard — no action. */
export type StatusCardProps = {
  state_label: string;
  next_event_label?: string;
  next_event_at?: Timestamptz; // from timers.due_at, allow-listed codes only
  detail?: string;
};

/** 3.2 ChoiceCard — 2–4 mutually exclusive options; never captures a consent. */
export type ChoiceOption = { id: string; label: string; sublabel?: string; is_primary?: boolean };
export type ChoiceCardProps = {
  title?: string;
  helper?: string;
  options: ChoiceOption[];
  command: string;
  command_args_by_option: Record<string, Record<string, unknown>>;
  disclosure_version_shown?: string;
};
export type ChoiceCardEvidence = { option_id: string; tapped_at: Timestamptz; disclosure_version_shown?: string };

/** 3.3 ConfirmCard */
export type ConfirmSource =
  | "stripe_identity"
  | "credit_report"
  | "payroll_connection"
  | "asset_report"
  | "public_records"
  | "avm"
  | "recorded_instrument"
  | "prior_application"
  | "servicing_record";
export type ConfirmField = { path: string; label: string; value: string; source: ConfirmSource };
export type ConfirmCardProps = {
  title?: string;
  fields: ConfirmField[];
  commits_to: string; // e.g. application_income, application_properties.estimated_value
};
export type ConfirmCardEvidence = {
  fields: { path: string; value_confirmed: string; source: ConfirmSource; confirmed_at: Timestamptz }[];
  edited: boolean;
};

/** 3.4 ConnectCard */
export type ConnectVendor = "stripe_identity" | "plaid_assets" | "truv_income" | "irs_ives" | "carrier_connect";
export type ConnectState = "not_started" | "in_progress" | "connected" | "failed" | "fallback_chosen";
export type ConnectCardProps = {
  vendor: ConnectVendor;
  purpose_text: string;
  what_we_get: string[];
  fallback: { label: string; document_class?: string }; // upload path — always present
  state: ConnectState;
  pre_intent_optional?: boolean; // "optional now, saves paperwork later" pre-LE
};
export type ConnectCardEvidence = {
  vendor: ConnectVendor;
  vendor_session_id: string;
  started_at: Timestamptz;
  completed_at?: Timestamptz;
  outcome: ConnectState;
};

/** 3.5 ConsentCard */
export type ConsentKind =
  | "esign"
  | "credit_authorization"
  | "tcpa_voice"
  | "tcpa_sms"
  | "ai_disclosure_ack"
  | "irs_estatement"
  | "autodraft_authorization"
  | "joint_intent"
  | "blanket_verification_authorization";
export type AffirmationMethod = "checkbox_with_text" | "single_tap";
export type ConsentCardProps = {
  consent_kind: ConsentKind;
  disclosure_version_id: string; // from consent_disclosure_versions
  scope: string[]; // E-SIGN classes
  affirmation_method: AffirmationMethod;
  title: string;
  body_text: string;
  footer_text?: string;
  helper_text?: string;
  phone_number?: string; // tcpa
  purpose?: "informational" | "marketing";
  requires_typed_name: boolean;
  /** esign only: consented_pending_verification until consent.esign.verified */
  verification_state?: "none" | "pending_verification" | "active";
};
export type ConsentCardEvidence = {
  consent_kind: ConsentKind;
  disclosure_version_id: string;
  method: AffirmationMethod;
  text_hash: string;
  ip?: string;
  user_agent?: string;
  affirmed_at: Timestamptz;
  party_id: Uuid;
  typed_name?: string;
};

/** 3.6 DocumentCard */
export type DocumentCardProps = {
  document_id: Uuid;
  disclosure_id?: Uuid;
  notice_code?: string; // e.g. NTC_REGZ_1026_37_LE
  title: string;
  why_you_see_this: string;
  requires_ack: boolean;
  esign_scope_required: string;
  received_at?: Timestamptz;
};
export type DocumentCardEvidence = { receipt_evidence: "esign_confirmed"; received_at: Timestamptz };

/** 3.7 ComparisonCard */
export type ComparisonRow = { label: string; value: string; emphasis?: boolean };
export type ComparisonColumn = { id: string; title: string; rows: ComparisonRow[]; footnote?: string };
export type ComparisonCardProps = {
  title?: string;
  columns: ComparisonColumn[];
  recommended_id?: string;
  command: string;
  command_args_by_option?: Record<string, Record<string, unknown>>;
  footnote?: string;
  /** e.g. "Keep floating" — an option that is not a column */
  secondary_option?: ChoiceOption;
};

/** 3.8 ChecklistCard */
export type ChecklistOwner = "you" | "us" | "third_party";
export type ChecklistStatus =
  | "open"
  | "waiting_borrower"
  | "waiting_third_party"
  | "satisfied_pending_review"
  | "cleared"
  | "waived"
  | "reopened";
export type ChecklistActionKind = "upload" | "connect" | "explain" | "schedule";
export type ChecklistItem = {
  condition_id: string;
  label: string;
  owner: ChecklistOwner;
  status: ChecklistStatus;
  due_at?: Timestamptz;
  action?: { kind: ChecklistActionKind; card_kind: CardKind; card_instance_id?: Uuid };
};
export type ChecklistCardProps = { title?: string; items: ChecklistItem[] };

/** 3.9 UploadCard */
export type UploadCardProps = {
  document_class: string; // O3.1 document_classes.code
  accepted_examples: string[];
  why: string;
  freshness_hint?: string;
  title?: string;
  mismatch?: { detected: string; expected: string };
};
export type UploadCardEvidence = { document_class: string; file_name: string; uploaded_at: Timestamptz };

/** 3.10 ExplanationCard */
export type ExplanationCardProps = { subject: string; prompt: string; min_length: number };
export type ExplanationCardEvidence = { text_hash: string; attestation: string; attested_at: Timestamptz };

/** 3.11 ScheduleCard */
export type SchedulePurpose = "appraisal_access" | "pdc_access" | "ron_session" | "callback";
export type ScheduleSlot = { id: string; starts_at: Timestamptz; ends_at: Timestamptz; label?: string };
export type ScheduleCardProps = {
  purpose: SchedulePurpose;
  slots: ScheduleSlot[];
  constraints_text?: string;
  title?: string;
  helper?: string;
};
export type ScheduleCardEvidence = { slot_id: string; chosen_at: Timestamptz };

/** 3.12 PaymentCard (servicing) */
export type PaymentMode = "one_time" | "extra_principal" | "autopay_change";
export type PaymentAccount = { id: string; last4: string; label?: string };
export type PaymentCardProps = {
  mode: PaymentMode;
  amount_default_cents: Cents;
  amount_editable: boolean;
  date_options: string[]; // ISO dates within due_date + grace_days
  accounts: PaymentAccount[];
  add_account: boolean;
  include_late_charge_option?: { late_charge_cents: Cents };
  effect_line?: string; // extra principal: "brings your balance to {{money}}"
  title?: string;
};
export type PaymentCardEvidence = {
  amount_cents: Cents;
  date: string;
  account_id: string;
  include_late_charge: boolean;
  submitted_at: Timestamptz;
};

/** 3.13 InviteCard */
export type PartyRole = "co_borrower" | "non_borrowing_spouse" | "poa" | "authorized_third_party";
export type InviteCardProps = {
  party_role: PartyRole;
  title: string;
  contact_fields: ("first_name" | "last_name" | "email" | "phone")[];
};
export type InviteCardEvidence = { party_role: PartyRole; contact: Record<string, string>; invited_at: Timestamptz };

/** 3.14 HandoffCard */
export type HandoffDestination =
  | "ron_platform"
  | "settlement_agent"
  | "appraiser"
  | "notary_wet"
  | "prior_servicer"
  | "fannie_mae_letter";
export type HandoffCardProps = {
  destination: HandoffDestination;
  what_to_expect: string;
  return_state: string;
  title?: string;
  launch_url?: string;
};

/** 3.15 OfferCard (servicing → origination) */
export type OfferCardProps = {
  refi_opportunity_id: Uuid;
  current_rate: Rate;
  offered_rate: Rate;
  apr: Rate;
  new_pi_payment_cents: Cents;
  monthly_savings_cents: Cents;
  costs_to_borrower_cents: Cents; // program default 0
  lender_legal_name: string;
  mlo_name: string;
  mlo_nmlsr_id: string;
  expires_at: Timestamptz; // SM_REFI_OPPORTUNITY_EXPIRY_30
  not_a_commitment_text: string;
  rates_change_daily_text: string;
};
export type OfferDecision = "yes" | "not_now" | "never";
export type OfferCardEvidence = { decision: OfferDecision; decided_at: Timestamptz };

/** 3.16 NoticeCard */
export type NoticeCardProps = {
  notice_code: string;
  title: string;
  rendered_document_id: Uuid; // notices.rendered_document_id
  plain_language: string; // the template's own plain-language block
  template_version?: string;
  delivered_at?: Timestamptz;
  channel?: "app" | "mail" | "email";
  mailed_at?: Timestamptz;
  line?: string; // 12: "NoticeCard line" copy
};

/** 3.17 PersonCard */
export type PersonRole =
  | "mlo_of_record"
  | "human_agent"
  | "notary"
  | "settlement_agent"
  | "continuity_of_contact_team"
  | "appraiser";
export type PersonCardProps = {
  role: PersonRole;
  name: string;
  credentials?: string; // NMLSR ID; commission state
  reach?: string; // direct number (4.3 team)
  intro?: string;
};

/** 3.18 ProfileCard */
export type ProfileField = {
  path: string;
  label: string;
  required: true;
  options?: { id: string; label: string }[];
  input?: "text" | "number";
  statement?: string; // Form 1103 SCIF statement for language preference
};
export type ProfileCardProps = { title: string; fields: ProfileField[] };
export type ProfileCardEvidence = { fields: { path: string; value: string; answered_at: Timestamptz }[] };

/** 3.19 DemographicsCard */
export type CollectionMethod = "internet" | "telephone" | "video";
export type DemographicOption = { id: string; label: string; sub?: DemographicOption[] };
export type DemographicsCardProps = {
  collection_method: CollectionMethod;
  statement_text: string;
  ethnicity: DemographicOption[];
  race: DemographicOption[];
  sex: DemographicOption[];
  /** applications.status >= started (O1.3 T12) */
  available: boolean;
};
/** Evidence carries only {collection_method, answered_at} — values are never copied to ui_events. */
export type DemographicsCardEvidence = { collection_method: CollectionMethod; answered_at: Timestamptz };

// ---------------------------------------------------------------------------
// The discriminated union a `card_instances` row deserializes to
// ---------------------------------------------------------------------------

export type CardPropsByKind = {
  StatusCard: StatusCardProps;
  ChoiceCard: ChoiceCardProps;
  ConfirmCard: ConfirmCardProps;
  ConnectCard: ConnectCardProps;
  ConsentCard: ConsentCardProps;
  DocumentCard: DocumentCardProps;
  ComparisonCard: ComparisonCardProps;
  ChecklistCard: ChecklistCardProps;
  UploadCard: UploadCardProps;
  ExplanationCard: ExplanationCardProps;
  ScheduleCard: ScheduleCardProps;
  PaymentCard: PaymentCardProps;
  InviteCard: InviteCardProps;
  HandoffCard: HandoffCardProps;
  OfferCard: OfferCardProps;
  NoticeCard: NoticeCardProps;
  PersonCard: PersonCardProps;
  ProfileCard: ProfileCardProps;
  DemographicsCard: DemographicsCardProps;
};

export type CardInstance<K extends CardKind = CardKind> = CardBase & {
  kind: K;
  props: CardPropsByKind[K];
  created_at: Timestamptz;
  resolved_at?: Timestamptz;
  command_ref?: string;
};

export type AnyCardInstance = { [K in CardKind]: CardInstance<K> }[CardKind];

/** Body of POST /v1/borrower/cards/{id}/resolve (02 §7); idempotency key = card_instance_id. */
export type ResolveRequest = { evidence: Record<string, unknown>; option_id?: string };
export type ResolveResponse = { card: AnyCardInstance; events?: string[] };
