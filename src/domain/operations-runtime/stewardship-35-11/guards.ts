/**
 * §35.11 bus guardrails (AI agent design): pure predicates over the input — refused before anything runs, in the
 * CommandRefused shape. NEVER_COMPLETES_A_BREACH (rule 1, T8/T12: an input naming `escalation_id` with `complete`);
 * NO_CLOCK_EDIT (the steward never satisfies, extends or cancels a timer — 34.4 rule 1); NO_MONEY_FIELD (rule 9, 34.4's
 * pattern: `_cents`, `_bps`, `_pct`, `amount`, `waive`, `refund`, `entry_set`, `post`, …); NO_PAYLOAD_IN_EXCEPTION (an input
 * that would put a payload, a name, an e-mail or a token into an exception); PROBE_NEVER_PRODUCTION (rule 10: the probe
 * never targets production); EXEC_KEYS_SEPARATE and REPORT_IS_COUNTS are structural (tools/audit.py, report.ts) and are
 * asserted by the tests rather than an input predicate. AUTO_REQUEUE_CAP_1 and CONFIDENCE_FLOOR_0_85 are refusals the
 * requeue act raises from the row's state (stewardship.ts) — they need a read, so they are not input guards.
 */
import { never, str, type ToolInput } from "../../../app/tools.ts";

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const keysOf = (i: ToolInput): string[] => [...Object.keys(i), ...Object.keys(obj(i["changes"])), ...Object.keys(obj(i["data"])), ...Object.keys(obj(i["input"]))];
/** 34.4's NO_MONEY_FIELD pattern, as rule 9 lists it: `_cents`, `_bps`, `_pct`, `amount`, `waive`, `refund`, `entry_set`, `post`, … */
export const MONEY_RE = /(_cents$|_bps$|_pct$|^amount|amount$|balance|upb|payoff|^fee|fee$|_fee|charge|waive|write_?off|refund|entry_set|^post$|^posting|reversal|reverse|ledger|disburse|remit)/i;
export const moneyKey = (i: ToolInput): string | null => { for (const k of keysOf(i)) if (MONEY_RE.test(k) && k !== "report" && k !== "reports") return k; return null; };

export const NO_MONEY_FIELD = never("NO_MONEY_FIELD", "35.11 rule 9: 'Nothing here changes a money field. The tools' inputs are ids, codes, dispositions and reasons; an input with a money-shaped key (34.4's NO_MONEY_FIELD pattern: _cents, _bps, _pct, amount, waive, refund, entry_set, post, …) is refused before any read'", (i) => moneyKey(i) !== null, "this process reads, opens, classifies, assigns and reports; a waiver, a reversal and a posting remain the owning section's officer commands");
export const NEVER_COMPLETES_A_BREACH = never("NEVER_COMPLETES_A_BREACH", "35.11 rule 1: 'it completes nothing a clock or a section opened … It never calls an escalation completion' (T8: the guard refuses an input naming escalation_id with complete)",
  (i) => (i["escalation_id"] !== undefined || i["escalation"] !== undefined) && (str(i, "op").toLowerCase().includes("complete") || str(i, "action").toLowerCase().includes("complete") || i["complete"] !== undefined || i["completed"] !== undefined || i["evidence_document_id"] !== undefined || (i["disposition"] !== undefined && i["exception_id"] === undefined))
    || ["complete_escalation", "close_escalation", "escalation_complete"].some((k) => i[k] !== undefined),
  "a breach is a person's finding: the steward opens, classifies, assigns and reports and completes nothing a clock opened");
export const NO_CLOCK_EDIT = never("NO_CLOCK_EDIT", "35.11 AI agent design: 'NO_CLOCK_EDIT' — 'never satisfies, extends or cancels a timer (34.4 rule 1)'", (i) => ["timer_id", "timer", "clock", "due_at", "due_date", "extend", "cancel_timer", "satisfy", "satisfied_at", "breached_at"].some((k) => i[k] !== undefined) || ["edit_clock", "satisfy", "extend", "cancel"].includes(str(i, "op")), "a section's clock moves only through the engine on the owner's events");
export const NO_PAYLOAD_IN_EXCEPTION = never("NO_PAYLOAD_IN_EXCEPTION", "35.11 AI agent design: 'never writes a payload or a name into an exception' (Data model: an exception names ids, adapters and error classes, never a payload, a name or an account)", (i) => ["payload", "body", "message_body", "email", "e_mail", "phone", "legal_name", "name", "token", "account_number", "ssn", "response"].some((k) => i[k] !== undefined), "an exception carries ids, adapters, error classes, counts and codes only");
export const PROBE_NEVER_PRODUCTION = never("PROBE_NEVER_PRODUCTION", "35.11 AI agent design: 'PROBE_NEVER_PRODUCTION' — rule 10: 'target: deployed runs … never against production'", (i) => ["production", "prod"].includes(str(i, "environment").toLowerCase()) || ["production", "prod"].includes(str(i, "target").toLowerCase()) || /\bprod(uction)?\b/i.test(str(i, "base_url")), "the probe runs against its own database or the deployed nonprod environment, never production");
export const COMMON_GUARDS = [NO_MONEY_FIELD, NEVER_COMPLETES_A_BREACH, NO_CLOCK_EDIT, NO_PAYLOAD_IN_EXCEPTION];
