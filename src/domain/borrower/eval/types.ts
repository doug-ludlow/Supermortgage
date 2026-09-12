/**
 * The evaluation harness's data shapes (docs/ux/17 §6, DELTA-28; 32.16 §6).
 *
 * The five checks are pure functions over these shapes: a transcript (the thread's `messages` rows), the turn log
 * (`agent_turns`, 0119), the events (`loan_events`), the cards (`card_instances`), the borrower record (GET /v1/borrower/record)
 * and the copy library's templates. The runner (runner.ts) fills them from the tables after driving a persona through the API;
 * the unit tests (checks.test.ts) fill them by hand — no model, no database.
 */
export type Sender = "borrower" | "agent" | "human" | "notice" | "system";

/** One `messages` row as the checks see it. */
export interface EvalMessage {
  readonly message_id: string;
  readonly sender: Sender;
  readonly body_text: string | null;
  /** `messages.at`: the runtime clock's instant — one and the same for every row under the harness's FixedClock, so never an order. */
  readonly at: string;
  /** `messages.created_at`: the row's database-side instant (DEFAULT now(), real time) — the thread's append order; the runner orders the thread by it. */
  readonly created_at?: string | null;
  readonly card_instance_id?: string | null;
  /** `messages.copy_tokens`: a rates element rides on a system row as `{element: "rates", low_rate, …}`; an agent turn's reply carries `{source: "agent_turn", turn_id, fallback?}`. */
  readonly copy_tokens?: Record<string, unknown> | null;
}
/** One entry of `agent_turns.tool_calls` (name, args hash, decision id, outcome — never the args). */
export interface EvalToolCall { readonly name: string; readonly is_error?: boolean; readonly args_hash?: string; readonly decision_id?: string | null; readonly refused?: unknown; readonly error?: string }
/** One `agent_turns` row (0119). `reply_message_id` is null for an attempt the guard rejected. */
export interface EvalTurn {
  readonly turn_id: string;
  readonly message_id: string | null;
  readonly reply_message_id: string | null;
  readonly safe_classification: string | null;
  readonly guard_result: Record<string, unknown>;
  readonly tool_calls: readonly EvalToolCall[];
  readonly created_at: string;
  readonly model_version?: string;
  readonly prompt_version?: string;
}
/** One `loan_events` row the party's subjects carry. `occurred_at` is the runtime clock's; `created_at` is the database's (DEFAULT now(): the transaction's real instant — every event a command committed shares it). */
export interface EvalEvent { readonly type: string; readonly occurred_at: string; readonly created_at?: string | null; readonly payload: Record<string, unknown>; readonly application_id?: string | null; readonly loan_id?: string | null }
/** One `card_instances` row. */
export interface EvalCard {
  readonly card_instance_id: string;
  readonly kind: string;
  readonly status: string;
  readonly copy_key: string;
  readonly command_ref: string | null;
  readonly props: Record<string, unknown>;
  readonly evidence?: Record<string, unknown> | null;
  readonly created_at: string;
  readonly resolved_at: string | null;
}
/** One `card_instance_events` row (a status transition): `at` is the runtime clock's, `created_at` the database's real instant of the tap's transaction. */
export interface EvalCardEvent { readonly card_instance_id: string; readonly to_status: string; readonly at: string; readonly created_at?: string | null }
/** A docs/ux/12 copy line: the verbatim check refuses an agent message that equals one. */
export interface EvalTemplate { readonly key: string; readonly text: string }
/** The borrower record as the API serves it (src/runtime/borrower/record.ts `BorrowerRecord`), read loosely: its numbers and dates are provenance sources. */
export type EvalRecord = Record<string, unknown>;

/** What "the persona reached its target" means (docs/ux/17 §6 completion). */
export type CompletionTarget =
  | { readonly kind: "event"; readonly type: string }
  | { readonly kind: "card"; readonly copy_key: string; readonly card_kind?: string }
  /** `human.request` runs within `within_turns` of the borrower message matching `after` (the distress or the word): in the turns that answer that message and the `within_turns - 1` borrower messages after it — bounded by thread order, never by the clock. */
  | { readonly kind: "human"; readonly after: RegExp; readonly within_turns: number };

export const CHECK_NAMES = ["provenance", "verbatim", "safe_and_inquiries", "evidence", "completion"] as const;
export type CheckName = (typeof CHECK_NAMES)[number];
export interface CheckResult { readonly name: CheckName; readonly pass: boolean; readonly violations: readonly string[]; readonly detail: Record<string, unknown> }

/** Everything the five checks read for one persona run. `turns` is null when `agent_turns` is not in the database. */
export interface Transcript {
  readonly messages: readonly EvalMessage[];
  readonly turns: readonly EvalTurn[] | null;
  readonly events: readonly EvalEvent[];
  readonly cards: readonly EvalCard[];
  readonly card_events?: readonly EvalCardEvent[];
  readonly record: EvalRecord | null;
}
