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
  /** Tokens for `copy(card.copy_key, …)` when `state_label` is empty — the server names the key, the library holds the sentence. */
  copy_tokens?: Record<string, string | string[]>;   // 32.8: a token used twice in the sentence ({{money}} … {{money}}) is an array consumed in order
  /** 32.7: a detail line named by copy key (`funded.no_skip`), or a list of them (`closing.package_items` → `closing.package.*`), rendered with `copy_tokens`. */
  detail_copy_key?: string;
  detail_copy_keys?: string[];
  /** 32.11 §6: a token given as a copy KEY (`autopay` → `refi.autopay.carried_over`), resolved through the library — never a sentence in props. */
  copy_token_keys?: Record<string, string>;
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
  /** Options that record the choice and issue no command (Not yet · Wait · Keep floating). */
  no_command_options?: string[];
  copy_tokens?: Record<string, string | string[]>;   // 32.8: a token used twice in the sentence ({{money}} … {{money}}) is an array consumed in order
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
  | "servicing_record"
  /** 32.3 C1: a field the FAKE contract extractor read — counts only on Confirm (T29) */
  | "document_extraction"
  /** 32.3: a value the borrower typed or edited (source=borrower — 21.1 rule 1) */
  | "borrower";
export type ConfirmField = { path: string; label: string; value: string; source: ConfirmSource; /** 32.3 T29: null until the borrower confirms */ confirmed_at?: string | null };
export type ConfirmCardProps = {
  title?: string;
  fields: ConfirmField[];
  commits_to: string; // e.g. application_income, application_properties.estimated_value
  /** 32.5 §2.4: the title's tokens (`new_debt.confirm` {{creditor}} {{date}}), a helper line from the copy library, yes/no options that map to the command's args. */
  copy_tokens?: Record<string, string>;
  helper_copy_key?: string;
  options?: { id: string; label: string; is_primary?: boolean }[];
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
  /** 32.5 §7: the title's tokens (`consent.joint_intent.title` {{other_first_name}}). */
  copy_tokens?: Record<string, string>;
  /** 32.7 §6: the autodraft authorization's 2.3 elements, each labelled by copy key, shown before the affirmation (T11). */
  elements?: ConsentElement[];
  /** 32.7 §6: the "autopay is optional" statement (Reg E §1005.10(e)(1)) as a copy key. */
  optional_statement_copy_key?: string;
  optional?: boolean;
};
/** 32.7 §6: one displayed element of a consent (2.3 rule: borrower, loan, account, amount, timing, first debit, company, revoke, date, e-sign). */
export type ConsentElement = { id: string; label_key: string; value: string; input?: string; options?: string[]; draft_day_options?: number[] };
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
/** 32.4 §5: one row of the What-changed block — the diff of two LE figure snapshots computed by the API, never free text. */
export type WhatChangedRow = { key: string; label_key?: string; label?: string; from: string | null; to: string | null; unit: "cents" | "rate" };
export type WhatChanged = { since_version: number; kind: string | null; kind_copy_key: string | null; cc_ids?: string[]; rows: WhatChangedRow[]; /** 32.7 §1: the block's title as a copy key (`cd.what_changed` for the LE→CD diff); `le.what_changed` when absent */ title_key?: string };
/** 32.7 §4: the H-8/H-9 card's quiet "How to cancel" link — a borrower message, never a primary button (T8). */
export type HowToCancelLink = { copy_key: string; message_text: string; quiet?: boolean };
export type DocumentCardProps = {
  document_id: Uuid;
  disclosure_id?: Uuid;
  notice_code?: string; // e.g. NTC_REGZ_1026_37_LE
  title: string;
  why_you_see_this: string;
  requires_ack: boolean;
  esign_scope_required: string;
  received_at?: Timestamptz;
  /** 32.4: the LE version this card carries; cards sharing a `package_id` render as one grouped message (LE + companions). */
  le_version?: number;
  package_id?: string;
  companion_kind?: string;
  channel?: string;
  mailed_at?: Timestamptz;
  /** 32.4-T1: an electronic copy of a mailed disclosure delivered once e-delivery was on. */
  electronic_copy?: boolean;
  copy_of_disclosure_id?: Uuid;
  /** 32.4 §5: present on a revised LE (v ≥ 2). */
  what_changed?: WhatChanged;
  copy_tokens?: Record<string, string>;
  /** 32.7 §4: the rescission notice's quiet link (T8). */
  how_to_cancel?: HowToCancelLink;
  /** 32.7 §1: the wire-fraud warning beside the CD, as a copy key. */
  wire_warning_copy_key?: string;
};
export type DocumentCardEvidence = { receipt_evidence: "esign_confirmed"; received_at: Timestamptz };

/** 3.7 ComparisonCard */
/** 32.6 §6: `value_key` / `title_key` name copy-library entries (an MI plan's title, its HPA cancellation line) when the literal is empty. */
export type ComparisonRow = { label: string; value: string; emphasis?: boolean; value_key?: string };
export type ComparisonColumn = { id: string; title: string; rows: ComparisonRow[]; footnote?: string; title_key?: string };
export type ComparisonCardProps = {
  title?: string;
  columns: ComparisonColumn[];
  recommended_id?: string;
  command: string;
  command_args_by_option?: Record<string, Record<string, unknown>>;
  footnote?: string;
  /** e.g. "Keep floating" — an option that is not a column */
  secondary_option?: ChoiceOption;
  /** Options that record the choice and issue no command (Keep floating). */
  no_command_options?: string[];
  /** 32.10: tokens for the copy library's title/footnote when the server named only the key (the offer's `hardship.offer.compare` deadline). */
  copy_tokens?: Record<string, string>;
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
  /** 32.5 §2.2–2.3: the freshness verdict (`upload.stale` {{date}} {{n}}), a re-request reason (`upload.rerequest.closing_moved`), the title's `{{document}}` token, and the ids the request links. */
  stale?: { date: string; n: number };
  reason_copy_key?: string;
  copy_tokens?: Record<string, string>;
  label_copy_key?: string;
  request_id?: string;
  condition_id?: string | null;
};
export type UploadCardEvidence = { document_class: string; file_name: string; uploaded_at: Timestamptz };

/** 3.10 ExplanationCard */
export type ExplanationCardProps = { subject: string; prompt: string; min_length: number; /** 32.5 §3: subject and prompt from the copy library (`explain.deposit.subject` / `explain.deposit`) with their tokens */ subject_copy_key?: string; prompt_copy_key?: string; copy_tokens?: Record<string, string> };
export type ExplanationCardEvidence = { text_hash: string; attestation: string; attested_at: Timestamptz };

/** 3.11 ScheduleCard */
export type SchedulePurpose = "appraisal_access" | "pdc_access" | "ron_session" | "callback";
export type ScheduleSlot = { id: string; starts_at: Timestamptz; ends_at: Timestamptz; label?: string; /** 32.7 §2: the closing type this slot books (ron · ipen · hybrid · wet) */ closing_type?: string };
/** 32.7 §2: one closing type 26.2's `decideClosingType` allows, labelled by copy key (`closing.schedule.type.ron` …). */
export type ClosingTypeOption = { id: string; copy_key: string; is_default?: boolean };
export type ScheduleCardProps = {
  purpose: SchedulePurpose;
  slots: ScheduleSlot[];
  constraints_text?: string;
  title?: string;
  helper?: string;
  /** 32.7 §2: the closing types offered (RON only when 26.2 says eligible); the slot list filters to the chosen type. */
  closing_type_options?: ClosingTypeOption[];
  default_closing_type?: string;
  ron_eligible?: boolean;
  /** 32.7 §2: the "you can always sign on paper" line as a copy key. */
  fallback_copy_key?: string;
  copy_tokens?: Record<string, string>;
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
  /** 32.8 §3.1: tokens for the copy-library title (`payment.due` {{money}} {{date}}) when `title` is empty. */
  copy_tokens?: Record<string, string>;
  /** 32.8 §3.1: the installment and 2.7's grace end the date options run through (never computed here). */
  installment_due_date?: string;
  grace_end_on?: string | null;
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
  | "fannie_mae_letter"
  | "hoa_management"; // SQ-08 (32.6 §3): the HOA management company sends the project documents
export type HandoffCardProps = {
  destination: HandoffDestination;
  what_to_expect: string;
  return_state: string;
  title?: string;
  launch_url?: string;
  /** 32.7: the two lines as copy keys when the literals are empty (`closing.presign.what_to_expect`, `boarding.fannie_letter.return`). */
  what_to_expect_copy_key?: string;
  return_state_copy_key?: string;
  /** 32.7 §6 item 6: 30.4's explainer for the Fannie Mae letter — its headline and points are the owning process's own plain-language block. */
  explainer_headline?: string;
  explainer_points?: string[];
  closing_type?: string;
  copy_tokens?: Record<string, string>;
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
  /** 32.11 §2: the payment statement's term, the lender's NMLSR ID, the path the offer came by, the timer the expiry copies */
  term_months?: number;
  lender_nmlsr_id?: string;
  path?: "proactive" | "borrower_request";
  expiry_timer_code?: string;
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
  /** Tokens for the copy-library line/title when the props leave them empty. */
  copy_tokens?: Record<string, string | string[]>;   // 32.8: a token used twice in the sentence ({{money}} … {{money}}) is an array consumed in order
  /** 32.6 §5: tokens given as copy KEYS (the failing insurance element, its fix) — resolved through the library, never a sentence in props. */
  copy_token_keys?: Record<string, string>;
  amount_cents?: Cents;
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
  /** 32.5 §8: until the human's own turn carries their name, the name and intro come from the copy library. */
  name_copy_key?: string;
  intro_copy_key?: string;
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
  /** 32.13 / T-X-03: on the wire the serializer carries the prompt lists as `<key>_options` (the answer-shaped names never leave the API); the component reads these first. */
  ethnicity_options?: DemographicOption[];
  race_options?: DemographicOption[];
  sex_options?: DemographicOption[];
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
