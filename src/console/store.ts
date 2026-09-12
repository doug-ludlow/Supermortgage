/**
 * The ops console reads from one interface, `ConsoleStore`, so the same UI
 * runs over the in-memory kernel stores (tests, demos) and over Postgres
 * (production). Everything a human works in the console is a queue the
 * spec already defines: escalations by role, human portal tasks, held
 * notices, dead-lettered integration messages and breached timers — plus
 * the loan record (events, ledger, timers, decisions, notices) and the
 * Compliance Sentinel dashboard.
 */
import type { Actor } from "../kernel/events/index.ts";

export interface QueueItem { readonly id: string; readonly kind: "escalation" | "portal_task" | "held_notice" | "dead_letter" | "breached_timer"; readonly title: string; readonly ownerRole: string; readonly loanId?: string; readonly severity?: string; readonly openedAt: string; readonly dueAt?: string; readonly detail: Record<string, unknown>; }
export interface LoanSummary { readonly id: string; readonly fnmaLoanNumber: string; readonly servicerLoanNumber: string; readonly status: string; readonly partnerPartyId?: string; readonly boardedAt?: string | null; }
export interface LoanDetail extends LoanSummary {
  readonly events: readonly { id: string; sequence: number; type: string; occurredAt: string; actor: string; payload: Record<string, unknown> }[];
  readonly balances: readonly { account: string; cents: string }[];
  readonly timers: readonly { id: string; code: string; status: string; dueAt?: string | undefined; dueDate?: string | undefined; note?: string | undefined }[];
  readonly decisions: readonly { id: string; agent: string; action: string; ruleCode?: string | undefined; rationale: string; confidence: number | null; approvedBy?: string | undefined; approvedRole?: string | undefined; createdAt: string }[];
  readonly notices: readonly { id: string; template: string; version: string; status: string; heldReason?: string | undefined; producedAt: string; sentAt?: string | undefined }[];
}
export interface Dashboard {
  readonly asOf: string;
  readonly timers: { readonly armed: number; readonly breached: number; readonly dueNext24h: number; readonly breachedBySeverity: Record<string, number>; readonly breachedBySection: Record<string, number> };
  readonly queues: Record<QueueItem["kind"], number>;
  readonly notices: { readonly held: number; readonly sentLast7d: number; readonly returnedLast7d: number };
  readonly agents: readonly { agent: string; off: boolean; why?: string | undefined; tier: string; decisionsLast7d: number }[];
}
export interface AccessEntry { readonly at: string; readonly actor: Actor; readonly method: string; readonly path: string; readonly purpose?: string; }
/** 32.14 §1.9 / T18: the funnel read model — counts per stage from `loan_events` / lead events only, in funnel order (`GET /api/funnel?from=&to=`). */
export const FUNNEL_STAGES: readonly string[] = ["lead.created", "lead.disclosure.delivered", "lead.goal.set", "lead.range.shown", "lead.authenticated", "application.started", "credit.softpull.received", "terms.presented", "application.received", "application.trid_received", "du.findings.received", "intent.to_proceed.received", "lock.executed"];
export interface FunnelStage { readonly stage: string; readonly event_type: string; readonly count: number; }
export interface Funnel { readonly from: string; readonly to: string; readonly stages: readonly FunnelStage[]; }
/** A stage id from its event type (`lead.created` → `lead_created`); the rows keep both. */
export const funnelStageId = (eventType: string): string => eventType.replace(/\./g, "_");
export const funnelRows = (counts: ReadonlyMap<string, number>): FunnelStage[] => FUNNEL_STAGES.map((t) => ({ stage: funnelStageId(t), event_type: t, count: counts.get(t) ?? 0 }));

/** docs/ux/17 §6 / DELTA-28's console view: one party's conversation as the trace — the thread, every card, every agent turn joined to the borrower text it answered and the reply it produced. */
export interface AiConversation {
  readonly party: { readonly party_id: string; readonly email_masked: string | null; readonly legal_name: string | null };
  readonly conversation_id: string | null;
  readonly messages: readonly { message_id: string; at: string; sender: string; sender_ref: string | null; body_text: string | null; card_instance_id: string | null; copy_tokens: Record<string, unknown> | null }[];
  readonly cards: readonly { card_instance_id: string; kind: string; copy_key: string; status: string; proposal: unknown; option_id: string | null; created_at: string; resolved_at: string | null }[];
  readonly turns: readonly AiTurn[];
}
export interface AiTurn {
  readonly turn_id: string; readonly message_id: string | null; readonly reply_message_id: string | null;
  readonly borrower_text: string | null; readonly reply_text: string | null;
  readonly model_version: string; readonly prompt_version: string; readonly tool_calls: unknown[]; readonly guard_result: Record<string, unknown>; readonly safe_classification: string | null;
  readonly latency_ms: number | null; readonly tokens_in: number | null; readonly tokens_out: number | null; readonly created_at: string;
}
/** `GET /api/ai/conversation/recent`: the most recent turns across parties, the party's e-mail masked to its first two characters. */
export interface AiRecentTurn extends AiTurn { readonly party_id: string; readonly email_masked: string | null; readonly conversation_id: string; }
/** The first two characters of the address and nothing else (never the domain): `casey@example.test` → `ca***`. */
export const maskEmail = (email: string | null | undefined): string | null => (email ? `${email.slice(0, 2)}***` : null);

export interface ConsoleStore {
  queue(opts: { role?: string; kind?: QueueItem["kind"]; loanId?: string; now: string }): Promise<QueueItem[]>;
  searchLoans(q: string, limit?: number): Promise<LoanSummary[]>;
  loan(id: string, now: string): Promise<LoanDetail | undefined>;
  dashboard(now: string): Promise<Dashboard>;
  completeEscalation(id: string, actor: Actor, evidenceDocumentId: string | null, now: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  completePortalTask(id: string, actor: Actor, evidenceDocumentId: string | null, now: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  releaseHeldNotice(id: string, actor: Actor, replacementId: string, now: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  requeueDeadLetter(id: string, actor: Actor, now: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  setAiOff(agent: string, why: string | null, actor: Actor, now: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  logAccess(e: AccessEntry): Promise<void>;
  /** 32.14 T18: counts per funnel stage for events that occurred in [from, to). */
  funnel(range: { from: string; to: string }): Promise<Funnel>;
  /** DELTA-28 (docs/ux/17 §6): the conversation trace — only a store over the borrower UI tables (Postgres) carries it; the in-memory store has no thread. */
  aiPartyByEmail?(email: string): Promise<string | undefined>;
  aiConversation?(partyId: string): Promise<AiConversation | undefined>;
  aiRecentTurns?(limit: number): Promise<AiRecentTurn[]>;
}

export const READ_ONLY_ROLES = new Set(["auditor", "examiner"]);
export const CONSOLE_ROLES = ["officer", "attorney", "signing_officer", "fnma_portal_operator", "human_agent", "lossmit_reviewer", "fraud_officer", "ops_analyst", "ciso", "compliance", "counsel", "auditor", "examiner"] as const;

/** Which queue kinds a role works by default ("my queue"). */
export function queueKindsFor(role: string): QueueItem["kind"][] {
  switch (role) {
    case "fnma_portal_operator": return ["portal_task", "dead_letter", "escalation"];
    case "ops_analyst": return ["held_notice", "dead_letter", "breached_timer", "escalation"];
    case "compliance": return ["breached_timer", "held_notice", "escalation"];
    case "auditor": case "examiner": return ["escalation", "breached_timer", "held_notice", "dead_letter", "portal_task"];
    default: return ["escalation", "breached_timer"];
  }
}
