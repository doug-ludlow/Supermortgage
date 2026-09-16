/**
 * §35.10 — the refinance closeout's rows and vocabulary (spec/sections/35-operations-runtime/35-10-the-refinance-close-of-the-loop.md,
 * Data model and State machine). String-literal unions only (Node 22 type stripping: no enum). Money is bigint cents; dates are PlainDate.
 */
import type { PlainDate } from "../../../kernel/calendar/date.ts";
import type { Cents } from "../../../kernel/money/cents.ts";

export type CloseoutMode = "serviced_same_servicer" | "monitored_partner";
export type PriorStatus = "active" | "monitored";
/** The state machine's steps, in order; `held`, `unwound` and `cancelled` are statuses, not steps. */
export type CloseoutStep = "opened" | "awaiting_schedule" | "quoted" | "settling" | "settled" | "escrow_disposed" | "retired" | "released_or_confirmed" | "linked" | "completed";
export const STEP_ORDER: readonly CloseoutStep[] = ["opened", "awaiting_schedule", "quoted", "settling", "settled", "escrow_disposed", "retired", "released_or_confirmed", "linked", "completed"];
export type CloseoutStatus = "open" | "waiting_human" | "waiting_vendor" | "waiting_partner" | "waiting_window" | "held" | "completed" | "unwound" | "cancelled";
export type EscrowTreatment = "credit_to_new_loan" | "refund" | "none" | "partner_obligation";
export type RemittedTo = "fnma_crs" | "warehouse_paydown" | "partner_wire";
export type StepKind = "entered" | "command_run" | "command_refused" | "command_failed" | "waiting" | "completed" | "skipped" | "held" | "resumed" | "unwound" | "cancelled";
export type NotificationKind = "notified" | "acknowledged" | "confirmed" | "disputed" | "resolved";
export type ConfirmationSource = "tape" | "ack" | "ops_resolve";
export type HoldReason = "money_mismatch" | "payoff_line_missing" | "short_payoff" | "unavailable" | "attempts" | "manual";
export const TERMINAL_STATUSES: readonly CloseoutStatus[] = ["completed", "unwound", "cancelled"];
export const PROCESS = "35.10";
export const AGENT = "payoff-release";
export const RULE_SET_VERSION = "closeout.v1";
export const PROMPT_VERSION = "35.10-v1";
/** The ledger rule_ref of the internal transfer (rule 4). */
export const TRANSFER_RULE_REF = "35.10:r4:transfer";
export const RECEIPT_RULE_REF = "2.1:r8:receipt";
/** The outbox adapter of the partner's notification (rule 8, Integrations). */
export const PARTNER_NOTIFY_ADAPTER = "partner-book.notify";
export const retirementIdempotencyKey = (priorLoanId: string): string => `retirement:${priorLoanId}`;

export interface CloseoutRow {
  readonly id: string; readonly application_id: string; readonly prior_loan_id: string; readonly new_loan_id: string | null; readonly orchestration_id: string | null; readonly partner_party_id: string | null;
  readonly mode: CloseoutMode; readonly prior_status_at_open: PriorStatus; readonly step: CloseoutStep; readonly status: CloseoutStatus; readonly waiting_on: string | null; readonly hold_reason: string | null;
  readonly payoff_demand_id: string | null; readonly payoff_request_id: string | null; readonly quote_id: string | null; readonly statement_document_id: string | null;
  readonly good_through: PlainDate | null; readonly quoted_total_cents: Cents | null; readonly per_diem_cents: Cents | null; readonly projected_disbursement_date: PlainDate | null; readonly disbursement_date: PlainDate | null; readonly payoff_date: PlainDate | null;
  readonly funds_id: string | null; readonly settlement_id: string | null; readonly escrow_treatment: EscrowTreatment | null; readonly escrow_balance_cents: Cents | null; readonly escrow_consent_id: string | null; readonly escrow_credit_event_id: string | null; readonly refund_disbursement_id: string | null;
  readonly release_task_id: string | null; readonly retirement_id: string | null; readonly partner_notification_id: string | null;
  readonly last_event_sequence: bigint; readonly step_attempts: number; readonly lease_holder: string | null; readonly lease_until: string | null;
  readonly opened_at: string; readonly retired_at: string | null; readonly completed_at: string | null; readonly updated_at: string;
}
export type CloseoutPatch = Partial<Omit<CloseoutRow, "id" | "application_id" | "prior_loan_id" | "mode" | "prior_status_at_open" | "opened_at">>;

export interface StepEntry {
  readonly closeout_id: string; readonly application_id: string; readonly prior_loan_id: string; readonly step: CloseoutStep | string; readonly kind: StepKind; readonly clocked?: boolean; readonly waiting_on?: string | null;
  readonly trigger_event_id?: string | null; readonly command_process?: string | null; readonly command_name?: string | null; readonly command_op?: string | null;
  readonly actor_kind?: string | null; readonly actor_id?: string | null; readonly actor_role?: string | null; readonly decision_id?: string | null; readonly refusal_code?: string | null; readonly error_class?: string | null;
  readonly detail?: Record<string, unknown>; readonly sweep_run_id?: string | null;
}
export interface StepRow extends StepEntry { readonly id: string; readonly created_at: string; readonly clocked: boolean; readonly detail: Record<string, unknown>; }

export interface RetirementRow {
  readonly id: string; readonly prior_loan_id: string; readonly new_loan_id: string | null; readonly application_id: string; readonly closeout_id: string; readonly mode: CloseoutMode; readonly prior_status: PriorStatus;
  readonly retired_on: PlainDate | null; readonly retirement_event_id: string; readonly settlement_event_id: string | null; readonly settlement_id: string | null; readonly payoff_demand_id: string | null;
  readonly payoff_total_cents: Cents | null; readonly upb_cents: Cents | null; readonly interest_cents: Cents | null; readonly fees_cents: Cents | null; readonly remitted_to: RemittedTo | null; readonly wire_reference: string | null;
  readonly escrow_treatment: string | null; readonly escrow_balance_cents: Cents | null; readonly evidence_document_id: string | null; readonly decision_id: string | null; readonly created_at: string;
}
export interface NotificationRow {
  readonly id: string; readonly retirement_id: string; readonly prior_loan_id: string; readonly partner_party_id: string; readonly kind: NotificationKind; readonly integration_message_id: string | null; readonly channel: string | null; readonly payload_hash: string | null;
  readonly servicer_loan_number: string | null; readonly notified_on: PlainDate | null; readonly ack_reference: string | null; readonly confirmation_source: ConfirmationSource | null; readonly confirmation_import_id: string | null; readonly tape_status: string | null;
  readonly escalation_id: string | null; readonly actor_kind: string | null; readonly actor_id: string | null; readonly created_at: string;
}
export interface ReceiptCounts {
  readonly open: number; readonly by_mode: Record<string, number>; readonly by_step: Record<string, number>; readonly waiting_human: number; readonly waiting_vendor: number; readonly waiting_partner: number; readonly held: number;
  readonly retired_today: number; readonly completed_today: number; readonly unwound_today: number; readonly releases_open: number; readonly partner_unconfirmed: number; readonly oldest_open_step: string | null; readonly oldest_open_days: number | null;
}
export interface ReceiptRow extends ReceiptCounts { readonly id: string; readonly as_of_date: PlainDate; readonly report_document_id: string | null; readonly created_at: string; }

/** The decision record schema of the AI agent design paragraph (figures are cents-strings copied from the owner's row). */
export interface CloseoutDecision {
  readonly closeout_id: string; readonly application_id: string; readonly prior_loan_id: string; readonly mode: CloseoutMode; readonly step: string;
  readonly command: { readonly process: string; readonly name: string; readonly op: string | null } | null; readonly trigger_event_id: string | null; readonly owner_decision_id: string | null;
  readonly figures: { readonly quoted_total_cents: string | null; readonly per_diem_cents: string | null; readonly exact_total_cents: string | null; readonly variance_cents: string | null };
  readonly rule_set_version: typeof RULE_SET_VERSION; readonly model_version: "deterministic"; readonly prompt_version: typeof PROMPT_VERSION; readonly confidence: 1; readonly rationale: string;
}
