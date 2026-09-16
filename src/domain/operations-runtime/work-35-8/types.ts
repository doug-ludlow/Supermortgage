/**
 * §35.8 — the constants and small helpers every module of the process shares
 * (spec/sections/35-operations-runtime/35-8-operator-work-screens.md).
 *
 *   the screens       twelve codes, each a read projection plus named actions, every action a call to the owning section's
 *                     bus tool with the engine inputs derived server-side (rule 1, rule 2).
 *   the queue         one open item per source (rule 8); a claim is one person until SM_WORK_ITEM_CLAIM_4H lapses it (rule 9).
 *   the numbers       4 hours (the claim), 2 and 5 business days (the item's age), 1 business day (an approval) — the registry
 *                     rows arm them; nothing here computes a deadline.
 *   WorkRefused       the process's own refusal (a StaffError so the console answers it in its shape): NO_CLIENT_STATE,
 *                     ROLE_REQUIRED, SAME_PERSON, STALE_DERIVATION, SCREEN_STALE, CLAIMED_BY_OTHER, ITEM_CLOSED, GATE_CLOSED,
 *                     FOUR_EYES, NOT_FOUND.
 */
import { StaffError } from "../../../runtime/staff/roles.ts";
import type { Actor } from "../../../kernel/events/index.ts";

export const PROCESS_35_8 = "35.8";
export const WORK_AGENT = "case";
export const WORK_RULE_SET_VERSION = "work.v1";
export const WORK_MODEL_VERSION = "deterministic";
export const WORK_PROMPT_VERSION = "35.8-v1";
export const DERIVATION_DOCUMENT_KIND = "work-derivation.json";
export const RECON_DOCUMENT_KIND = "work-log-recon.json";

export const CLAIM_TIMER_CODE = "SM_WORK_ITEM_CLAIM_4H";
export const CLAIM_LAPSES_BEFORE_ESCALATION = 3;
export const ERRORS_BEFORE_ESCALATION = 3;

export const SCREEN_CODES = ["le_review", "cd_review", "conditions", "closing_schedule", "funding_release", "payment_post", "payment_reverse", "escrow_analysis", "payoff_quote", "lossmit_decision", "foreclosure_case", "bankruptcy_case"] as const;
export type ScreenCode = (typeof SCREEN_CODES)[number];
export type SubjectKind = "loan" | "application";
export interface Subject { readonly kind: SubjectKind; readonly id: string }
export const SOURCE_KINDS = ["escalation", "portal_task", "held_notice", "dead_letter", "breached_timer", "job_dead", "orchestration_held", "approval_pending", "case_milestone", "manual"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export type ItemStatus = "open" | "claimed" | "waiting_approval" | "closed" | "cancelled";
export type ActionStatus = "executed" | "proposed" | "approved" | "declined" | "expired" | "refused" | "error";

export class WorkRefused extends StaffError {
  constructor(status: number, code: string, detail: string, extra: Record<string, unknown> = {}) { super(status, code, detail, extra); this.name = "WorkRefused"; }
}

export type Row = Record<string, unknown>;
export const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
export const isUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export const obj = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});
export const hoursAfter = (iso: string, h: number): string => new Date(Date.parse(iso) + h * 3_600_000).toISOString();
/** The bus actor as the log names it: a staff user id for a person, `kind:id` otherwise. */
export const actorId = (a: Actor): string => (a.kind === "human" ? a.id : `${a.kind}:${a.id}`);
export const isHuman = (a: Actor): boolean => a.kind === "human";
/** A subject from a tool input (`subject: {kind, id}`, or `loan_id` / `application_id`). */
export function subjectOf(i: Row): Subject {
  const sub = obj(i["subject"]);
  if ((sub["kind"] === "loan" || sub["kind"] === "application") && typeof sub["id"] === "string") return { kind: sub["kind"], id: sub["id"] };
  if (typeof i["loan_id"] === "string" && i["loan_id"]) return { kind: "loan", id: i["loan_id"] };
  if (typeof i["application_id"] === "string" && i["application_id"]) return { kind: "application", id: i["application_id"] };
  throw new RangeError("subject: {kind: loan | application, id} is required");
}
