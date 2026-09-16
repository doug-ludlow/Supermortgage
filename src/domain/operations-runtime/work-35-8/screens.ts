/**
 * §35.8 — the screen catalogue (rule 1, rule 2): twelve codes, each a read projection plus named actions; every action names
 * the owning section's bus tool (and op), the decision fields the person supplies (its `decision_schema`: only the fields
 * the person is the source of — ids, a disposition, a date choice, a reason, a figure only where the person is its source),
 * the engine fields the deriver owns (`derived_fields`, refused NO_CLIENT_STATE when a decision names one) and the deriver
 * (src/domain/operations-runtime/derivers-35-8.ts, one exported function per action, versioned).
 *
 * Roles are the tool's (rule 4: from `humanRoles`, copied at registration by registry.ts, never restated here); `needs`
 * narrows to the role the owning section's rule names for the act (Verified requirement "Money fields and legal acts stay
 * with the roles the sections name": a condition clearance and the clear-to-close are underwriting_reviewer (23.3), a wire
 * release is funding_approver (26.3), LE approval is mlo_of_record, a loss-mitigation review is lossmit_reviewer (12.2)) —
 * the effective roles are the tool's ∩ needs. `money` marks the actions the sections treat as money-field acts (rule 5:
 * a payment reversal, a trustee-payment application, a payoff figure override, an escrow approval past tolerance).
 */
import type { ScreenCode, SubjectKind } from "./types.ts";

export type FieldType = "string" | "uuid" | "date" | "cents" | "boolean" | "enum" | "text";
export interface FieldSpec { readonly type: FieldType; readonly required?: boolean; readonly values?: readonly string[]; /** the person is the source of this figure (a cheque amount, a trustee payment) */ readonly person_source?: boolean }
export interface ActionSpec {
  readonly code: string; readonly process: string; readonly tool: string; readonly op?: string;
  readonly money: boolean; readonly needs?: readonly string[];
  readonly decision_schema: Readonly<Record<string, FieldSpec>>;
  readonly derived_fields: readonly string[];
  readonly deriver: string; readonly deriver_version: string;
}
export interface ScreenSpec { readonly code: ScreenCode; readonly subject_kind: SubjectKind; readonly owning_process: string; readonly read_tools: readonly string[]; readonly actions: readonly ActionSpec[] }

const V = "35.8-v1";
const id = (required = true): FieldSpec => ({ type: "string", required });
const date = (required = false): FieldSpec => ({ type: "date", required });
const text = (required = false): FieldSpec => ({ type: "text", required });
const en = (values: readonly string[], required = false): FieldSpec => ({ type: "enum", values, required });
const bool = (): FieldSpec => ({ type: "boolean" });

export const SCREENS: readonly ScreenSpec[] = [
  { code: "payment_post", subject_kind: "loan", owning_process: "2.1", read_tools: ["2.1 payments.read/write{op: read}", "installments.read", "ledger balances"], actions: [
    { code: "post", process: "2.1", tool: "payments.read/write", op: "post", money: false, deriver: "derivePaymentPost", deriver_version: V,
      decision_schema: { payment_id: id(), credited_as_of: date(), designation_override: en(["contractual", "curtailment", "escrow_only", "fees_only"]), reason: text() },
      derived_fields: ["op", "id", "loan_id", "state", "custodial", "installments", "upb_cents", "days_delinquent", "lpi_date", "balances"] } ] },
  { code: "payment_reverse", subject_kind: "loan", owning_process: "2.1", read_tools: ["2.1 payments.read/write{op: read}", "installments.read", "ledger balances"], actions: [
    { code: "reverse", process: "2.1", tool: "payments.read/write", op: "reverse", money: true, deriver: "derivePaymentReverse", deriver_version: V,
      decision_schema: { payment_id: id(), reason: en(["returned_item", "misapplied", "duplicate", "fraud", "correction"], true), return_code: id(false), nsf_fee: bool() },
      derived_fields: ["op", "id", "loan_id", "state", "custodial", "allocation", "ledger_entry_set_ids", "run_on", "installments", "upb_cents", "lpi_date", "balances"] } ] },
  { code: "le_review", subject_kind: "application", owning_process: "21.2", read_tools: ["21.2 assembleFees", "21.2 computeAPR"], actions: [
    { code: "approve", process: "21.2", tool: "renderH24", op: "approve", money: false, needs: ["mlo_of_record"], deriver: "deriveLeApprove", deriver_version: V,
      decision_schema: { disclosure_id: id(), reason: text() }, derived_fields: ["application_id", "data_hash", "approved_data_hash", "fees", "apr", "release", "ai_intake_mode"] } ] },
  { code: "cd_review", subject_kind: "application", owning_process: "25.2", read_tools: ["25.2 assembleCdFigures", "25.2 runToleranceTest"], actions: [
    { code: "deliver", process: "25.2", tool: "deliverDisclosure", money: false, deriver: "deriveCdDeliver", deriver_version: V,
      decision_schema: { disclosure_id: id(), method: en(["electronic", "mail", "in_person", "courier"]) }, derived_fields: ["application_id", "consumer_id", "channel", "gate_run", "figures"] },
    { code: "receipt", process: "25.2", tool: "recordReceipt", money: false, deriver: "deriveCdReceipt", deriver_version: V,
      decision_schema: { disclosure_id: id(), received_on: date(), evidence_document_id: id(false) }, derived_fields: ["application_id", "consumer_id", "evidence", "at"] },
    { code: "corrected", process: "25.2", tool: "scheduleCorrectedCd", money: false, deriver: "deriveCdCorrected", deriver_version: V,
      decision_schema: { disclosure_id: id(), reason: text(true) }, derived_fields: ["application_id", "event_on", "info_received_on", "figures"] } ] },
  { code: "conditions", subject_kind: "application", owning_process: "23.3", read_tools: ["23.3 evaluateClearance", "23.3 runCtcChecklist"], actions: [
    { code: "clear", process: "23.3", tool: "clearCondition", op: "clear", money: false, needs: ["underwriting_reviewer"], deriver: "deriveConditionClear", deriver_version: V,
      decision_schema: { condition_id: id(), evidence_document_id: id(false), note: text() }, derived_fields: ["application_id", "condition", "evaluation", "evidence"] },
    { code: "reopen", process: "23.3", tool: "reopenCondition", money: false, needs: ["underwriting_reviewer"], deriver: "deriveConditionReopen", deriver_version: V,
      decision_schema: { condition_id: id(), note: text(true) }, derived_fields: ["application_id", "condition"] },
    { code: "ctc", process: "23.3", tool: "issueClearToClose", money: false, needs: ["underwriting_reviewer"], deriver: "deriveCtc", deriver_version: V,
      decision_schema: {}, derived_fields: ["application_id", "decision", "checklist", "facts"] } ] },
  { code: "closing_schedule", subject_kind: "application", owning_process: "26.2", read_tools: ["25.2 computeEarliestConsummation", "26.2 runPreSessionChecks"], actions: [
    { code: "confirm", process: "26.2", tool: "runPreSessionChecks", op: "schedule", money: false, deriver: "deriveClosingConfirm", deriver_version: V,
      decision_schema: { closing_id: id(), slot_at: date(true) }, derived_fields: ["application_id", "state", "settlement_agent_party_id", "transaction_type", "earliest_consummation", "scheduled_at"] },
    { code: "assign_notary", process: "26.2", tool: "assignNotary", money: false, deriver: "deriveAssignNotary", deriver_version: V,
      decision_schema: { closing_id: id(), notary_id: id() }, derived_fields: ["application_id", "notary_party_id", "commission_state", "physical_location_state", "commission_verified"] },
    { code: "open_session", process: "26.2", tool: "openSigningSession", money: false, deriver: "deriveOpenSession", deriver_version: V,
      decision_schema: { closing_id: id() }, derived_fields: ["application_id", "signer_party_ids", "notary"] } ] },
  { code: "funding_release", subject_kind: "application", owning_process: "26.3", read_tools: ["26.3 evaluateFundingConditions", "35.6 orchestration"], actions: [
    { code: "release", process: "26.3", tool: "prepareWire", op: "release", money: false, needs: ["funding_approver"], deriver: "deriveFundingRelease", deriver_version: V,
      decision_schema: { funding_id: id(), wire_id: id() }, derived_fields: ["application_id", "conditions", "rescission", "ptf", "cash_to_close", "released_at", "bank_ref", "amount_cents", "orchestration_id"] } ] },
  { code: "escrow_analysis", subject_kind: "loan", owning_process: "3.1", read_tools: ["3.1 runEscrowAnalysis", "ledger balances"], actions: [
    { code: "run", process: "3.1", tool: "runEscrowAnalysis", money: false, deriver: "deriveEscrowRun", deriver_version: V,
      decision_schema: { analysis_year: id(), effective_on: date(true) }, derived_fields: ["loan_id", "year_start", "as_of", "cushion", "disbursements", "balances", "bills", "regx_days_delinquent"] },
    { code: "approve", process: "3.1", tool: "approveAnalysis", money: true, deriver: "deriveEscrowApprove", deriver_version: V,
      decision_schema: { analysis_id: id() }, derived_fields: ["loan_id", "anomalies", "tolerance", "payment_change_cents"] } ] },
  { code: "payoff_quote", subject_kind: "loan", owning_process: "16.1", read_tools: ["16.1 computePayoffQuote", "ledger balances", "loan_terms"], actions: [
    { code: "quote", process: "16.1", tool: "computePayoffQuote", money: false, deriver: "derivePayoffQuote", deriver_version: V,
      decision_schema: { requester_kind: en(["borrower", "third_party", "attorney", "title"], true), good_through: date(true), delivery: en(["portal", "mail", "fax"], true) },
      derived_fields: ["loan_id", "upb_cents", "rate_pct", "lpi_due", "late_charges_cents", "recording_fee_cents", "escrow_balance_cents", "nib_deferred_cents", "accrual_method", "rate_segments", "state", "total_cents", "per_diem_cents", "interest_cents", "ledger_snapshot_id", "received_on", "quote_id", "request_id", "requester_type", "channel", "delivery_channel_requested"] },
    { code: "statement", process: "16.1", tool: "renderStatement", money: false, deriver: "derivePayoffStatement", deriver_version: V,
      decision_schema: { quote_id: id(), delivery: en(["portal", "mail", "fax"], true) }, derived_fields: ["loan_id", "active_wire_instruction_version_id", "figures", "total_cents"] } ] },
  { code: "lossmit_decision", subject_kind: "loan", owning_process: "12.2", read_tools: ["12.2 lossmit.evaluation.*{op: read}"], actions: [
    { code: "decide", process: "12.2", tool: "lossmit.evaluation.*", op: "draft", money: false, deriver: "deriveLossmitDecide", deriver_version: V,
      decision_schema: { request_id: id(), disposition: en(["approve", "deny", "counter"], true), option_code: id(false), denial_reasons: { type: "string" } },
      derived_fields: ["op", "id", "loan_id", "determinations", "evaluator_run_owner", "complete_on", "plan_terms", "evaluation"] },
    { code: "review", process: "12.2", tool: "lossmit.evaluation.*", op: "review", money: false, needs: ["lossmit_reviewer"], deriver: "deriveLossmitReview", deriver_version: V,
      decision_schema: { request_id: id(), decision: en(["approved", "edited", "returned"], true), reason: text() }, derived_fields: ["op", "id", "loan_id", "reviewer", "reviewer_id", "reviewer_role", "evaluation", "notice"] },
    { code: "notify", process: "12.2", tool: "notice.render_send", money: false, deriver: "deriveLossmitNotify", deriver_version: V,
      decision_schema: { request_id: id() }, derived_fields: ["template_code", "loan_id", "option", "criterion", "reviewer_approval_id", "recipients", "payload"] } ] },
  { code: "foreclosure_case", subject_kind: "loan", owning_process: "13.1", read_tools: ["13.1 foreclosure.gates.evaluate", "13.1 foreclosure.case.get"], actions: [
    { code: "refer", process: "13.1", tool: "foreclosure.gates.evaluate", money: false, deriver: "deriveForeclosureRefer", deriver_version: V,
      decision_schema: { case_id: id(), firm_id: id(false) }, derived_fields: ["loan_id", "step", "gates", "counters", "occupancy"] },
    { code: "instruct", process: "13.2", tool: "attorney.instruction.send", money: false, needs: ["officer", "ops_analyst", "human_agent"], deriver: "deriveForeclosureInstruct", deriver_version: V,
      decision_schema: { case_id: id(), instruction_code: id(), firm_id: id(false) }, derived_fields: ["loan_id", "kind", "gates", "bid_cents", "case"] },
    { code: "hold", process: "13.2", tool: "attorney.instruction.send", op: "HOLD", money: false, deriver: "deriveForeclosureHold", deriver_version: V,
      decision_schema: { case_id: id(), hold_reason: text(true) }, derived_fields: ["loan_id", "kind", "case"] },
    { code: "milestone", process: "13.2", tool: "attorney.instruction.status", money: false, deriver: "deriveForeclosureMilestone", deriver_version: V,
      decision_schema: { case_id: id(), milestone_code: id(), occurred_on: date(true) }, derived_fields: ["loan_id", "case", "timeframe"] } ] },
  { code: "bankruptcy_case", subject_kind: "loan", owning_process: "14.1", read_tools: ["14.1 bk.case.read/write{op: read}", "14.1 ledger.snapshot"], actions: [
    { code: "docket", process: "14.1", tool: "docket.classify", op: "apply", money: false, deriver: "deriveBkDocket", deriver_version: V,
      decision_schema: { case_id: id(), docket_entry_id: id() }, derived_fields: ["loan_id", "entry", "case"] },
    { code: "apply_trustee", process: "14.1", tool: "bk.ledger.apply_trustee", money: true, deriver: "deriveBkApplyTrustee", deriver_version: V,
      decision_schema: { case_id: id(), amount_cents: { type: "cents", required: true, person_source: true }, received_on: date(true) },
      derived_fields: ["loan_id", "state", "ledgers", "ledger_snapshot", "plan", "schedule", "note", "claim", "chapter", "plan_designation", "conduit_district", "case_number_full", "claim_no"] },
    { code: "apply_postpetition", process: "14.1", tool: "bk.ledger.apply_postpetition", money: true, deriver: "deriveBkApplyPostpetition", deriver_version: V,
      decision_schema: { case_id: id(), amount_cents: { type: "cents", required: true, person_source: true }, received_on: date(true) }, derived_fields: ["loan_id", "ledgers", "ledger_snapshot", "counsel_directs_arrears"] },
    { code: "statement_mode", process: "14.1", tool: "bk.case.read/write", op: "statement_mode", money: false, deriver: "deriveBkStatementMode", deriver_version: V,
      decision_schema: { case_id: id(), mode: en(["suppressed", "informational", "regular"], true) }, derived_fields: ["loan_id", "case", "chapter"] } ] },
];
export const screenOf = (code: string): ScreenSpec | undefined => SCREENS.find((s) => s.code === code);
export const actionOf = (screen: ScreenSpec, code: string): ActionSpec | undefined => screen.actions.find((a) => a.code === code);
