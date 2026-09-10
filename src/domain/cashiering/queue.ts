/**
 * 2.1 human path (rule "Human path when AI off"): when the cashiering agent's
 * AI path is off, every refused agent attempt lands in the Posting Queue and a
 * person runs the same command — the bus applies identical validators.
 */
import type { EventStore } from "../../kernel/events/index.ts";

export interface PostingQueueItem { readonly payment_id: string; readonly loan_id: string | null; readonly reason: string; readonly refused_at: string; readonly validators: "identical_to_ai_path"; }
export function postingQueue(events: EventStore): PostingQueueItem[] {
  return events.ofType("command.refused").filter((e) => e.payload.code === "AI_OFF" && String(e.payload.command).startsWith("cashiering."))
    .map((e) => ({ payment_id: String(e.payload.subject_id ?? ""), loan_id: e.loanId ?? null, reason: String(e.payload.reason), refused_at: e.occurredAt, validators: "identical_to_ai_path" as const }));
}
