/**
 * §35.1 authored projector maps for section 21 (application and disclosures): 21.4's `locks` (db/migrations/0066) —
 * the kind 21.4's tools write as the whole `Lock` row (src/app/tools/section21-4.ts putLock), upserted because a lock
 * moves through requested → executed → confirmed → superseded on the same lock_id. Open question 4's first wave also
 * names `disclosures`, `tolerance_tests` and `tolerance_cures`; those stay listed gaps (`no_projector`) until their
 * maps are authored and signed by the disclosures officer (operational prerequisite 5).
 */
import { bool, date, int, money, numeric, text, ts, uuid, type ProjectorMap } from "./types.ts";

const LOCK_KINDS = ["initial", "extension", "relock", "float_down", "renegotiation"] as const;
const LOCK_STATUSES = ["requested", "pending_mlo_approval", "quote_expired", "executed", "confirmed", "superseded", "expired", "cancelled", "consummated"] as const;
const EXTENSION_PAYERS = ["borrower", "lender_delay", "lender_goodwill"] as const;
const STATE_VARIANTS = ["NY", "NJ", "MA"] as const;
const CANCEL_REASONS = ["borrower_withdrawal", "lender_declination", "product_change_ineligible", "expired", "superseded"] as const;

export const LOCKS: ProjectorMap = {
  kind: "locks", table: "locks", idColumn: "lock_id", mode: "upsert", phase: "commit", history: false, owner: "21.4", version: "35.1/locks@v1",
  scopeColumn: { application: "application_id" },
  columns: {
    application_id: uuid("application_id", { required: true }), lineage_id: uuid("lineage_id", { required: true }), version: int("version", { required: true }),
    kind: text("kind", { required: true, values: LOCK_KINDS }), supersedes_lock_id: uuid("supersedes_lock_id"), status: text("status", { required: true, values: LOCK_STATUSES }),
    requested_at: ts("requested_at", { required: true }), quote_id: uuid("quote_id"), quote_id_fnma: text("quote_id_fnma"),
    mlo_approval_escalation_id: uuid("mlo_approval_escalation_id"), approved_at: ts("approved_at"), mlo_nmlsr_id: text("mlo_nmlsr_id"),
    locked_at: ts("locked_at"), rate_set_date: date("rate_set_date"), note_rate: numeric("note_rate", { required: true }), price: numeric("price", { required: true }),
    points_cents: money("points_cents"), lender_credit_cents: money("lender_credit_cents"), lock_period_days: int("lock_period_days", { required: true }),
    expires_on: date("expires_on"), expires_at: ts("expires_at"), expiry_roll_applied: bool("expiry_roll_applied"), time_zone: text("time_zone"),
    product_code: text("product_code", { required: true }), loan_amount_cents: money("loan_amount_cents", { required: true }), worst_case_pricing_applied: bool("worst_case_pricing_applied"),
    extension_fee_cents: money("extension_fee_cents"), extension_payer: text("extension_payer", { values: EXTENSION_PAYERS }), float_down_fee_cents: money("float_down_fee_cents"),
    commitment_id: uuid("commitment_id"), revised_le_disclosure_id: uuid("revised_le_disclosure_id"), state_agreement_variant: text("state_agreement_variant", { values: STATE_VARIANTS }),
    property_state: text("property_state"), ny_expiry_notice_required: bool("ny_expiry_notice_required"), cancelled_reason: text("cancelled_reason", { values: CANCEL_REASONS }),
    borrower_statement: text("borrower_statement"), recorded_by: text("recorded_by", { required: true }),
  },
};

export const SECTION_21_PROJECTORS: readonly ProjectorMap[] = [LOCKS];
