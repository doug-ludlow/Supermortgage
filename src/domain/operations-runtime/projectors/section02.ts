/**
 * §35.1 authored projector maps for section 2 (cashiering) — rule 1's model: "2.1's `payments` (baseline table, fixed
 * here …)": the section's Data model names the table and its money, date, retention and encryption columns
 * (db/migrations/0003_cashiering.sql:18-47; allocations :55-67); the map copies the version's fields onto them.
 *
 *   payments             upsert (no mutation trigger; 2.1's later versions — identified, allocated, reversed — update the
 *                        same row; rule 4), phase commit, history: true (the four `payments.history` tools, rule 6).
 *   payment_allocations  insert once per (payment_id, sequence) from the version's `allocations[]` — the rows 2.1 stamped
 *                        with its rule_ref and the balanced set's id (worked example A); `payment_allocations_immutable`
 *                        forbids any later change, so a re-projection is `ON CONFLICT DO NOTHING`, never a duplicate.
 *   payment_reversals    insert once per (payment_id, reversed_at) from 2.3's `reversal` object on the reversed version
 *                        (section2-3.ts: reason, return_code, reversed_at, entry_set_ids — the first is the mirror set the
 *                        row's `ledger_entry_set_id` names); 0151's unique index makes the re-projection a no-op.
 *   fees                 upsert (2.7's assessed / waived / collected versions), phase commit; an nsf_fee's
 *                        `returned_item_payment_id` (35.5) has no column and rides in the JSON version.
 *   suspense_items       upsert (2.1's partial-payment items, 6.x's register, 16.2's payoff items, 35.5's lockbox
 *                        `unidentified_loan` rows), phase commit — 0003's NOT NULL columns are required: a version that
 *                        lacks `custodial_account_id` or `source`, or carries a status outside the enum, is a listed
 *                        `schema_mismatch` gap until its tool carries the field (rule 3: never guessed).
 *   autodraft_enrollments upsert (2.3's enrollment versions), phase commit — the same rule: 0003 requires borrower_id,
 *                        sec_code, authorization_kind, bank_account_token, routing_number and account_type, which 2.3's
 *                        JSON does not carry yet; the map publishes the legacy-id → uuid key (entity_keys) the moment a
 *                        version projects, which is what 35.5's `ach_entries.enrollment_key` backfill reads.
 *
 * Nothing here computes a cent (PROJECTOR_NEVER_COMPUTES): every figure is the one 2.1 / 2.3 / 2.7 rounded and wrote.
 */
import { bool, date, int, json, money, numeric, text, ts, uuid, type ProjectorMap } from "./types.ts";

const PAYMENT_CHANNELS = ["lockbox", "ach_debit_origin", "ach_credit_inbound", "wire", "portal_onetime", "ivr", "agent_assisted", "mail_office", "card", "third_party_contractor", "assistance_program", "bk_trustee", "transferor_forward", "transfer_in_opening"] as const;
const PAYMENT_INSTRUMENTS = ["check", "money_order", "cashiers_check", "ach", "wire", "card_debit", "card_credit", "book_transfer"] as const;
const PAYMENT_DESIGNATIONS = ["unspecified", "contractual", "curtailment", "escrow_only", "fees_only", "trial", "payoff", "reinstatement", "biweekly_half"] as const;
const PAYER_TYPES = ["borrower", "coborrower", "successor", "third_party", "contractor", "program", "trustee", "transferor"] as const;
const PAYMENT_STATUSES = ["received", "identified", "held", "allocated", "posted", "reversed", "returned", "refunded"] as const;
const ALLOCATION_OUTCOMES = ["applied", "applied_with_50_rule", "curtailment", "prepaid", "unapplied", "held_trial", "held_bk", "held_fc", "held_dispute", "refunded", "payoff_routed"] as const;
const ALLOCATION_BUCKETS = ["interest", "principal", "escrow", "late_charge", "nsf_fee", "other_fee", "curtailment", "suspense", "deferred_principal", "forborne_principal", "corporate_advance", "escrow_advance"] as const;
const REVERSAL_REASONS = ["returned_item", "misapplied", "duplicate", "servicer_error", "borrower_request", "court_order"] as const;
const RETENTION = ["permanent", "life_of_loan_plus_4y", "life_of_loan_plus_7y", "tpsc_2y_post_revocation", "corporate_7y", "fcra_furnishing_5y", "security_logs_5y"] as const;

export const PAYMENTS: ProjectorMap = {
  kind: "payments", table: "payments", idColumn: "id", mode: "upsert", phase: "commit", history: true, owner: "2.1", version: "35.1/payments@v1",
  scopeColumn: { loan: "loan_id" },
  columns: {
    loan_id: uuid("loan_id"), custodial_account_id: uuid("custodial_account_id"),
    channel: text("channel", { required: true, values: PAYMENT_CHANNELS }), instrument: text("instrument", { required: true, values: PAYMENT_INSTRUMENTS }),
    amount_cents: money("amount_cents", { required: true }),
    received_at: ts("received_at", { required: true }), received_on: date("received_on", { required: true }), credited_as_of: date("credited_as_of", { required: true }),
    conforming: bool("conforming"), nonconforming_reason: text("nonconforming_reason"),
    designation: text("designation", { values: PAYMENT_DESIGNATIONS }), borrower_instruction_text: text("borrower_instruction_text"), instruction_source: text("instruction_source"),
    payer_type: text("payer_type", { values: PAYER_TYPES }), payer_name: text("payer_name"), payer_bank_last4: text("payer_bank_last4"), check_number: text("check_number"), trace_number: text("trace_number"),
    image_document_id: uuid("image_document_id"), idempotency_key: text("idempotency_key", { required: true }),
    status: text("status", { values: PAYMENT_STATUSES }), allocation_outcome: text("allocation_outcome", { values: ALLOCATION_OUTCOMES }),
    source_batch_id: text("source_batch_id"), source_item_id: text("source_item_id"), settlement_date: date("settlement_date"), good_funds_at: ts("good_funds_at"),
    retention: text("retention", { values: RETENTION }),
  },
  children: [{
    field: "allocations", table: "payment_allocations", parentColumn: "payment_id", conflictColumns: ["payment_id", "sequence"],
    columns: {
      sequence: int("sequence", { required: true }), installment_due_date: date("installment_due_date"), bucket: text("bucket", { required: true, values: ALLOCATION_BUCKETS }),
      amount_cents: money("amount_cents", { required: true }), ledger_entry_set_id: uuid("ledger_entry_set_id"), rule_ref: text("rule_ref", { required: true }), credited_as_of: date("credited_as_of", { required: true }),
    },
  }, {
    field: "reversal", table: "payment_reversals", parentColumn: "payment_id", conflictColumns: ["payment_id", "reversed_at"],
    columns: {
      reason: text("reason", { required: true, values: REVERSAL_REASONS }), return_code: text("return_code"), reversed_at: ts("reversed_at", { required: true }),
      ledger_entry_set_id: uuid("ledger_entry_set_id", { path: ["entry_set_ids", "0"] }), decision_id: uuid("decision_id"),
    },
  }],
};

const SUSPENSE_SOURCES = ["lockbox", "ach", "wire", "card", "bank_credit_unposted", "refund_returned", "trustee", "third_party", "transfer_in", "other"] as const;
const SUSPENSE_REASONS = ["partial_payment", "partial_payment_50_rule", "unidentified_loan", "unidentified_payer", "overpayment", "duplicate_payment", "post_payoff_receipt", "pending_modification_hold", "bankruptcy_hold", "dispute_hold", "foreclosure_hold", "rental_income", "third_party_unverified", "returned_refund", "transfer_in_inherited", "remainder_under_p", "prepaid_pending", "biweekly_accumulation"] as const;
const SUSPENSE_STATUSES = ["open", "researching", "contact_pending", "matched_pending", "applied", "returned", "refunded", "transferred", "escheat_pending", "escheated", "written_off"] as const;

export const SUSPENSE_ITEMS: ProjectorMap = {
  kind: "suspense_items", table: "suspense_items", idColumn: "id", mode: "upsert", phase: "commit", history: false, owner: "2.1", version: "35.1/suspense_items@v1",
  scopeColumn: { loan: "loan_id" },
  columns: {
    loan_id: uuid("loan_id"), custodial_account_id: uuid("custodial_account_id", { required: true }), ledger_entry_set_id: uuid("ledger_entry_set_id"), payment_id: uuid("payment_id"),
    source: text("source", { required: true, values: SUSPENSE_SOURCES }), reason_code: text("reason_code", { required: true, values: SUSPENSE_REASONS }),
    amount_cents: money("amount_cents", { required: true }), received_on: date("received_on", { required: true }), credited_as_of: date("credited_as_of"),
    payer_name: text("payer_name"), payer_account_last4: text("payer_account_last4"), memo: text("memo"), image_document_id: uuid("image_document_id"), bank_statement_line_id: uuid("bank_statement_line_id"), case_id: uuid("case_id"),
    status: text("status", { values: SUSPENSE_STATUSES }), resolution_due_on: date("resolution_due_on"), aging_days: int("aging_days"), resolved_on: date("resolved_on"), resolution_event_id: uuid("resolution_event_id"), decision_id: uuid("decision_id"),
    partial_commitment_due_on: date("partial_commitment_due_on"), partial_count_12m: int("partial_count_12m"),
  },
};

const ENROLLMENT_STATUSES = ["pending_validation", "pending_authorization", "active", "suspended", "revoked", "terminated"] as const;
const SEC_CODES = ["PPD", "WEB", "TEL", "CCD"] as const;
const AMOUNT_RULES = ["full_periodic_payment", "periodic_plus_fixed_extra", "fixed_amount", "half_payment_semimonthly", "biweekly_half"] as const;
const DRAFT_DAY_RULES = ["due_date", "fixed_day", "split_1_15", "every_14_days"] as const;
const VALIDATION_STATUSES = ["pending", "validated_api", "validated_prenote", "validated_microentry", "validated_history", "validated_noc", "failed"] as const;

export const AUTODRAFT_ENROLLMENTS: ProjectorMap = {
  kind: "autodraft_enrollments", table: "autodraft_enrollments", idColumn: "id", mode: "upsert", phase: "commit", history: false, owner: "2.3", version: "35.1/autodraft_enrollments@v1",
  scopeColumn: { loan: "loan_id" },
  columns: {
    loan_id: uuid("loan_id", { required: true }), borrower_id: uuid("borrower_id", { required: true }), status: text("status", { values: ENROLLMENT_STATUSES }),
    sec_code: text("sec_code", { required: true, values: SEC_CODES }), authorization_kind: text("authorization_kind", { required: true, values: ["recurring", "standing"] }),
    amount_rule: text("amount_rule", { required: true, values: AMOUNT_RULES, path: ["authorization", "amount_rule"] }), extra_principal_cents: money("extra_principal_cents"), fixed_amount_cents: money("fixed_amount_cents"),
    draft_day_rule: text("draft_day_rule", { required: true, values: DRAFT_DAY_RULES }), draft_day: int("draft_day"), next_draft_on: date("next_draft_on"),
    bank_account_token: text("bank_account_token", { required: true }), bank_account_last4: text("bank_account_last4", { required: true, path: ["authorization", "account_last4"] }),
    routing_number: text("routing_number", { required: true, path: ["authorization", "routing"] }), account_type: text("account_type", { required: true, values: ["checking", "savings"], path: ["authorization", "account_type"] }),
    validation_status: text("validation_status", { values: VALIDATION_STATUSES }), validated_at: ts("validated_at"), consent_id: uuid("consent_id"), authorization_document_id: uuid("authorization_document_id"),
    authorization_copy_delivered_at: ts("authorization_copy_delivered_at"), revocation_instructions_version: text("revocation_instructions_version"), range_notice_election: json("range_notice_election"),
    created_via: text("created_via", { values: PAYMENT_CHANNELS }), revoked_at: ts("revoked_at"), revocation_source: text("revocation_source"), termination_reason: text("termination_reason"), retention_until: date("retention_until"), rule_set_version: text("rule_set_version"),
  },
};

const FEE_TYPES = ["late_charge", "nsf_fee", "other_fee"] as const;
const FEE_STATES = ["assessed", "accrued_suspended", "collected", "partially_collected", "waived", "reversed", "written_off"] as const;
const FEE_SUPPRESSION = ["forbearance_active", "repayment_plan_pending_waiver", "trial_pending_waiver", "scra_reduced_rate", "bankruptcy_active", "transfer_window_60", "noe_dispute", "foreclosure_referred", "posting_backlog"] as const;
const FEE_WAIVER = ["workout_completion", "trial_conversion", "scra", "transfer_misdirected", "error_correction", "courtesy", "disaster_policy", "fnma_request", "bk_plan"] as const;

export const FEES: ProjectorMap = {
  kind: "fees", table: "fees", idColumn: "id", mode: "upsert", phase: "commit", history: false, owner: "2.7", version: "35.1/fees@v1",
  scopeColumn: { loan: "loan_id" },
  columns: {
    loan_id: uuid("loan_id", { required: true }), fee_type: text("fee_type", { required: true, values: FEE_TYPES }), installment_due_date: date("installment_due_date"),
    basis_cents: money("basis_cents"), pct: numeric("pct"), amount_cents: money("amount_cents", { required: true }), assessed_on: date("assessed_on", { required: true }), grace_end_on: date("grace_end_on"),
    state: text("state", { values: FEE_STATES }), suppression: text("suppression_reason", { values: FEE_SUPPRESSION }), collected_cents: money("collected_cents"), waived_cents: money("waived_cents"),
    waived_reason: text("waiver_reason", { values: FEE_WAIVER }), by: text("waived_by"), investor_reported_period: text("investor_reported_period"), nonreimbursable_reason: text("nonreimbursable_reason"),
  },
};

export const SECTION_02_PROJECTORS: readonly ProjectorMap[] = [PAYMENTS, FEES, SUSPENSE_ITEMS, AUTODRAFT_ENROLLMENTS];
