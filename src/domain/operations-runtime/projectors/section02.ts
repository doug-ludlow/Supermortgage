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
 *   fees                 upsert (2.7's assessed / waived / collected versions), phase commit.
 *
 * Nothing here computes a cent (PROJECTOR_NEVER_COMPUTES): every figure is the one 2.1 / 2.7 rounded and wrote.
 */
import { bool, date, int, money, numeric, text, ts, uuid, type ProjectorMap } from "./types.ts";

const PAYMENT_CHANNELS = ["lockbox", "ach_debit_origin", "ach_credit_inbound", "wire", "portal_onetime", "ivr", "agent_assisted", "mail_office", "card", "third_party_contractor", "assistance_program", "bk_trustee", "transferor_forward", "transfer_in_opening"] as const;
const PAYMENT_INSTRUMENTS = ["check", "money_order", "cashiers_check", "ach", "wire", "card_debit", "card_credit", "book_transfer"] as const;
const PAYMENT_DESIGNATIONS = ["unspecified", "contractual", "curtailment", "escrow_only", "fees_only", "trial", "payoff", "reinstatement", "biweekly_half"] as const;
const PAYER_TYPES = ["borrower", "coborrower", "successor", "third_party", "contractor", "program", "trustee", "transferor"] as const;
const PAYMENT_STATUSES = ["received", "identified", "held", "allocated", "posted", "reversed", "returned", "refunded"] as const;
const ALLOCATION_OUTCOMES = ["applied", "applied_with_50_rule", "curtailment", "prepaid", "unapplied", "held_trial", "held_bk", "held_fc", "held_dispute", "refunded", "payoff_routed"] as const;
const ALLOCATION_BUCKETS = ["interest", "principal", "escrow", "late_charge", "nsf_fee", "other_fee", "curtailment", "suspense", "deferred_principal", "forborne_principal", "corporate_advance", "escrow_advance"] as const;
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
  }],
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

export const SECTION_02_PROJECTORS: readonly ProjectorMap[] = [PAYMENTS, FEES];
