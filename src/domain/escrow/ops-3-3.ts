/**
 * §3.3 operating rules over the pure calculators in ./ops.ts and ./statement.ts — the event-appending (i)(2) exemption
 * lifecycle. The 3.3 agents row names only renderStatement / validateChecklist / sendNotice, so the hold is the render
 * step's own decision (state machine: `due` → `exempt_hold` | `rendered`) and the exemption's end is the ingestion of
 * §13's / §14's own events:
 *
 *   applyExemptionPolicy (here)   rule 5's exemption test at the analysis `as_of` over the engine's facts (the approved
 *                                 analysis's `regx_days_delinquent`, the log's open foreclosure action / bankruptcy case —
 *                                 exemptionFactsFromLog) → recordExemptHold (./ops.ts) appends
 *                                 escrow.statement.exempt_hold{statement_type=annual, disposition=exempt_hold, reason}
 *                                 — discharges REGX_1024_17I_ANNUAL_STMT_30 with a valid (i)(2) reason (3.3-T3). Policy
 *                                 (rule 5 / open question 1): only delinquent_30 and foreclosure_action hold; a
 *                                 bankruptcy loan's statement is produced with the §14 legend. Called by the 3.3
 *                                 renderStatement tool (src/app/tools/section3-3.ts renderAnnualStatement_3_3).
 *   recordBorrowerRequest (here)  `exempt_hold` → `borrower_requested_while_current` → `rendered`: the request is logged as
 *                                 escrow.statement.requested{requested_on, send_target_on = +5 business days} and the
 *                                 annual statement's send closes the hold — "provide (no new timer; log request date and
 *                                 send within 5 business days as policy)".
 *   settleExemption / exemptionReactors_3_3 (here)
 *                                 ingest `loan.reinstated` (§13.3 reinstatementTendered), `foreclosure.case.closed` (§13.3's
 *                                 spelling of the action ending; the spec's `foreclosure.case.cancelled` is accepted too)
 *                                 and `bankruptcy.case.closed` (§14.1) "where an (i)(2) exemption was applied" — eagerly
 *                                 as subscribers, and lazily by the 3.3 tools over the cause events already on the log —
 *                                 through endExemptionFromEvent → endExemption; a cause that cannot end the open hold is
 *                                 recorded as `escrow.statement.exemption_end.refused{reason}` (never silently dropped).
 *   endExemption (here)           escrow.statement.exemption_ended{exemption_ended_on, history_from, history_to, …}
 *                                 — the REGX_1024_17I2_POST_EXEMPTION_HISTORY_90 trigger, anchored on `exemption_ended_on`
 *                                 (§1024.17(i)(2): "a history of the account since the last annual statement (which may be
 *                                 longer than 1 year) within 90 days" of the date the servicer stops applying the exemption;
 *                                 spec inputs: "anchor = the date the servicer stops applying the exemption (system: the
 *                                 reinstatement/closure event date)"). State machine: exempt_hold → exemption_ended →
 *                                 history_due (90-day timer) → rendered → sent.
 *   sendNotice (section03.ts)     escrow.statement.sent{statement_type=post_exemption_history} through recordStatementSent —
 *                                 what the row is satisfied by.
 *
 * Money is bigint cents; dates are PlainDate; every function validates its input against the loan's own event log (the
 * hold must exist, be open, and be one the cause actually ends) and throws RangeError otherwise — never a bare emit.
 */
import { type PlainDate, plainDate, addDays, addMonths } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import type { EventStore, Actor, DomainEvent } from "../../kernel/events/index.ts";
import { exemption, postExemptionDeadline } from "./statement.ts";
import { recordExemptHold, type StatementType, type ExemptHoldReason } from "./ops.ts";

export const RULE_SET_3_3 = "regx.escrow.2014" as const;   // 3.3 templates' rule set (notices/authored/section03.ts)
export const POST_EXEMPTION_NOTICE = "NTC_REGX_1024_17I_POST_EXEMPTION_HISTORY" as const;
export const EXEMPTION_ENDED_EVENT = "escrow.statement.exemption_ended" as const;
export const EXEMPT_HOLD_EVENT = "escrow.statement.exempt_hold" as const;
export const STATEMENT_REQUESTED_EVENT = "escrow.statement.requested" as const;
export const EXEMPTION_END_REFUSED_EVENT = "escrow.statement.exemption_end.refused" as const;
export const ESCROW_AGENT: Actor = { kind: "agent", id: "escrow" };

/**
 * 3.3 inputs: the events that stop an (i)(2) exemption "where an (i)(2) exemption was applied" — the spec's spellings
 * (`loan.reinstated` / `bankruptcy.case.closed` / `foreclosure.case.cancelled`) plus `foreclosure.case.closed`, which is how
 * §13.3 actually records a foreclosure action ending (ops-13-3.ts reinstatementTendered: `foreclosure.case.closed{reason,
 * closed_on}` alongside `loan.reinstated{reinstated_on}`; a dismissal closes the case the same way).
 */
export type ExemptionEndedBy = "loan.reinstated" | "bankruptcy.case.closed" | "foreclosure.case.cancelled" | "foreclosure.case.closed";
export const EXEMPTION_ENDING_EVENTS: readonly ExemptionEndedBy[] = ["loan.reinstated", "bankruptcy.case.closed", "foreclosure.case.cancelled", "foreclosure.case.closed"];
/** Exemption reasons (data model `exemption_reason`) and the cause that ends each: delinquency ends when the loan is current/reinstated; a foreclosure action ends by reinstatement or by the case closing (dismissal); a bankruptcy hold by the case closing. */
type ExemptionReason = "delinquent_30" | "foreclosure_action" | "bankruptcy";
const ENDS: Record<ExemptionReason, readonly ExemptionEndedBy[]> = { delinquent_30: ["loan.reinstated"], foreclosure_action: ["loan.reinstated", "foreclosure.case.cancelled", "foreclosure.case.closed"], bankruptcy: ["bankruptcy.case.closed"] };
/** The date field each cause event carries (the "reinstatement/closure event date"); the event's own date otherwise. */
const CAUSE_DATE_FIELDS: Record<ExemptionEndedBy, readonly string[]> = { "loan.reinstated": ["reinstated_on", "tendered_on", "effective_on"], "bankruptcy.case.closed": ["closed_on"], "foreclosure.case.cancelled": ["cancelled_on", "dismissed_on"], "foreclosure.case.closed": ["closed_on", "dismissed_on"] };
/** Statement types whose `history_to` is a period end the next history continues from (rule 6: "[last statement end, exemption end]"). */
const HISTORY_BEARING: readonly StatementType[] = ["annual", "short_year_transfer", "short_year_payoff", "short_year_reset", "post_exemption_history"];
/** Bankruptcy case events after which the case is no longer open (§14.1 docket ingestion: `bankruptcy.case.closed{closed_on}` and its siblings). */
const BANKRUPTCY_CASE_ENDS = ["bankruptcy.case.closed", "bankruptcy.case.dismissed", "bankruptcy.case.discharged"] as const;
const FORECLOSURE_ACTION_ENDS = ["foreclosure.case.closed", "foreclosure.case.cancelled"] as const;

const isDate = (v: unknown): v is PlainDate => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isReason = (v: unknown): v is ExemptionReason => v === "delinquent_30" || v === "foreclosure_action" || v === "bankruptcy";
const isCause = (v: unknown): v is ExemptionEndedBy => (EXEMPTION_ENDING_EVENTS as readonly unknown[]).includes(v);
const p = (e: DomainEvent): Record<string, unknown> => e.payload as Record<string, unknown>;
const ofLoan = (events: EventStore, loanId: string, type: string): DomainEvent[] => events.ofType(type).filter((e) => e.loanId === loanId);
const last = <T>(xs: readonly T[]): T | undefined => xs[xs.length - 1];
const causeDate = (cause: DomainEvent): PlainDate => (isCause(cause.type) ? CAUSE_DATE_FIELDS[cause.type].map((f) => p(cause)[f]).find(isDate) : undefined) ?? plainDate(cause.occurredAt.slice(0, 10));

// ───────────────────────────── the hold (rule 5; 3.3-T3) ─────────────────────────────
export interface ExemptionFacts {
  /** The log carries a `foreclosure.first_notice.filed` (§13.1/13.3: "brought an action for foreclosure") with no case closing after it. */
  readonly foreclosure_first_legal_filed: boolean;
  /** The log carries a `bankruptcy.case.opened` (§14.1) with no closing / dismissal / discharge after it. */
  readonly bankruptcy_open: boolean;
  readonly bankruptcy_chapter: 7 | 13 | null;
}
/** Rule 5's case facts read off the loan's own log — "`cases` has an open `foreclosure` case with `first_legal_filed=true` OR an open `bankruptcy` case" — never off the caller's input. */
export function exemptionFactsFromLog(events: EventStore, loanId: string): ExemptionFacts {
  if (!loanId) throw new RangeError("loan_id is required");
  const filed = last(ofLoan(events, loanId, "foreclosure.first_notice.filed"));
  const fcOpen = !!filed && !FORECLOSURE_ACTION_ENDS.some((t) => ofLoan(events, loanId, t).some((e) => e.sequence > filed.sequence));
  const opened = last(ofLoan(events, loanId, "bankruptcy.case.opened"));
  const bkOpen = !!opened && !BANKRUPTCY_CASE_ENDS.some((t) => ofLoan(events, loanId, t).some((e) => e.sequence > opened.sequence));
  const chapter = bkOpen ? Number(p(opened!).chapter) : NaN;
  return { foreclosure_first_legal_filed: fcOpen, bankruptcy_open: bkOpen, bankruptcy_chapter: chapter === 7 || chapter === 13 ? chapter : null };
}

export interface ApplyExemptionInput {
  readonly loan_id: string;
  readonly analysis_id: string;
  /** The analysis `as_of_date` — rule 5: "Exemption test at `as_of_date` of the analysis". */
  readonly as_of: PlainDate;
  /** The engine's `regx_days_delinquent` on the analysis record (§1024.17(i)(2): "more than 30 days overdue"). */
  readonly regx_days_delinquent: number;
  readonly facts: ExemptionFacts;
  /** The analysis decision's shortage / deficiency — a hold with a shortage still owes the (f)(5) notice (3.3-T3). */
  readonly shortage_cents: Cents;
  readonly actor: Actor;
}
export type ExemptionPolicyResult =
  | { readonly status: "exempt_hold"; readonly reason: ExemptHoldReason; readonly statement_mailed: false; readonly notice: "NTC_REGX_1024_17F_SHORTAGE" | null; readonly event_type: typeof EXEMPT_HOLD_EVENT; readonly hold_event_id: string; readonly already_held: boolean; readonly as_of: PlainDate; readonly analysis_id: string }
  | { readonly status: "render"; readonly exemption: null; readonly bankruptcy: { readonly chapter: 7 | 13 } | null; readonly as_of: PlainDate; readonly analysis_id: string };

/**
 * Rule 5 at the analysis `as_of`: `regx_days_delinquent > 30` → `delinquent_30`; an open foreclosure action with first legal
 * filed → `foreclosure_action`; either records the `escrow.statement.exempt_hold` fact (once — a second render on a held
 * loan returns the open hold, never a second one). An open bankruptcy case never holds (policy: "still produce the
 * statement and route it per Section 14 (informational legend …)"; `escrow.statements.bk_suppress` default off) — the
 * render proceeds with the §14 legend.
 */
export function applyExemptionPolicy(events: EventStore, i: ApplyExemptionInput): ExemptionPolicyResult {
  if (!i.loan_id) throw new RangeError("loan_id is required");
  if (!i.analysis_id) throw new RangeError("analysis_id is required (the approved annual analysis the statement renders from)");
  if (!isDate(i.as_of)) throw new RangeError("as_of must be a date (the analysis as_of_date)");
  if (!Number.isFinite(i.regx_days_delinquent) || i.regx_days_delinquent < 0) throw new RangeError("regx_days_delinquent must be a non-negative number");
  if (typeof i.shortage_cents !== "bigint" || i.shortage_cents < 0n) throw new RangeError("shortage_cents must be non-negative bigint cents");
  const ex = exemption({ regx_days_delinquent: i.regx_days_delinquent, foreclosure_first_legal_filed: i.facts.foreclosure_first_legal_filed, bankruptcy_open: i.facts.bankruptcy_open });
  if (ex === "delinquent_30" || ex === "foreclosure_action") {
    const open = openExemptHold(events, i.loan_id);
    if (open) {
      const notice = p(open).notice === "NTC_REGX_1024_17F_SHORTAGE" ? "NTC_REGX_1024_17F_SHORTAGE" : null;
      return { status: "exempt_hold", reason: p(open).reason as ExemptHoldReason, statement_mailed: false, notice, event_type: EXEMPT_HOLD_EVENT, hold_event_id: open.id, already_held: true, as_of: i.as_of, analysis_id: i.analysis_id };
    }
    const h = recordExemptHold(events, { loan_id: i.loan_id, reason: ex, shortage_cents: i.shortage_cents, as_of: i.as_of, actor: i.actor });
    const hold = last(ofLoan(events, i.loan_id, EXEMPT_HOLD_EVENT))!;
    return { status: "exempt_hold", reason: h.reason, statement_mailed: false, notice: h.notice, event_type: EXEMPT_HOLD_EVENT, hold_event_id: hold.id, already_held: false, as_of: i.as_of, analysis_id: i.analysis_id };
  }
  return { status: "render", exemption: null, bankruptcy: i.facts.bankruptcy_open && i.facts.bankruptcy_chapter ? { chapter: i.facts.bankruptcy_chapter } : null, as_of: i.as_of, analysis_id: i.analysis_id };
}

/**
 * The loan's open (i)(2) hold: the latest `escrow.statement.exempt_hold` with neither an `escrow.statement.exemption_ended`
 * nor an annual `escrow.statement.sent` after it — the statement the hold withheld, provided on the borrower's request
 * while current (edge case: "provide (no new timer …)"; state machine `exempt_hold → borrower_requested_while_current →
 * rendered`), leaves nothing to catch up, so a later reinstatement owes no 90-day history.
 */
export function openExemptHold(events: EventStore, loanId: string): DomainEvent | null {
  const hold = last(ofLoan(events, loanId, EXEMPT_HOLD_EVENT));
  if (!hold) return null;
  const ended = ofLoan(events, loanId, EXEMPTION_ENDED_EVENT).some((e) => e.sequence > hold.sequence);
  const provided = ofLoan(events, loanId, "escrow.statement.sent").some((e) => e.sequence > hold.sequence && p(e).statement_type === "annual");
  return ended || provided ? null : hold;
}

export interface BorrowerRequestInput {
  readonly loan_id: string;
  readonly requested_on: PlainDate;
  /** The loan's delinquency on the request date (the (i)(2) request path applies only once "the loan becomes current"). */
  readonly regx_days_delinquent_at_request: number;
  readonly actor: Actor;
}
/**
 * Edge case "Exemption applied, then borrower becomes current and requests statement → provide (no new timer; log request
 * date and send within 5 business days as policy)": validates the open hold and that the loan is current, logs the request
 * as `escrow.statement.requested{disposition=borrower_requested_while_current, requested_on, send_target_on}`; the annual
 * statement's `escrow.statement.sent` then closes the hold (openExemptHold) — no exemption_ended, no 90-day clock.
 */
export function recordBorrowerRequest(events: EventStore, i: BorrowerRequestInput): { status: "borrower_requested_while_current"; event: DomainEvent; requested_on: PlainDate; send_target_on: PlainDate; hold_event_id: string; new_timer: null } {
  if (!i.loan_id) throw new RangeError("loan_id is required");
  if (!isDate(i.requested_on)) throw new RangeError("requested_on must be a date");
  if (!Number.isFinite(i.regx_days_delinquent_at_request) || i.regx_days_delinquent_at_request < 0) throw new RangeError("regx_days_delinquent_at_request must be a non-negative number");
  const hold = openExemptHold(events, i.loan_id);
  if (!hold) throw new RangeError(`no open (i)(2) exemption on loan ${i.loan_id}: the statement is not held — render it on the ordinary path`);
  if (i.regx_days_delinquent_at_request > 30) throw new RangeError(`loan ${i.loan_id} is ${i.regx_days_delinquent_at_request} days delinquent on ${i.requested_on}: §1024.17(i)(2) provides the held statement on request only once the loan becomes current`);
  const startedAt = isDate(p(hold).as_of) ? p(hold).as_of as PlainDate : plainDate(hold.occurredAt.slice(0, 10));
  if (i.requested_on < startedAt) throw new RangeError(`requested_on ${i.requested_on} is before the exemption was applied (${startedAt})`);
  const sendTarget = addBusinessDays(i.requested_on, 5, servicer);
  const event = events.append({ type: STATEMENT_REQUESTED_EVENT, loanId: i.loan_id, actor: i.actor, causationId: hold.id, payload: { statement_type: "annual", disposition: "borrower_requested_while_current", requested_on: i.requested_on, regx_days_delinquent_at_request: i.regx_days_delinquent_at_request, send_target_on: sendTarget, send_target_rule: "5 business_days_servicer (3.3 edge case, policy)", hold_event_id: hold.id, new_timer: null } });
  return { status: "borrower_requested_while_current", event, requested_on: i.requested_on, send_target_on: sendTarget, hold_event_id: hold.id, new_timer: null };
}

// ───────────────────────────── the exemption's end (3.3-T4) ─────────────────────────────
export interface EndExemptionInput {
  readonly loan_id: string;
  readonly ended_by: ExemptionEndedBy;
  /** The date the servicer stops applying the exemption — the reinstatement / dismissal / closure date. */
  readonly ended_on: PlainDate;
  /** First day the history covers when the loan's log carries no prior statement period end (the day after the last statement's period). */
  readonly history_from?: PlainDate | null;
  readonly actor: Actor;
  readonly causation_id?: string;
}
export interface ExemptionEnded {
  readonly status: "history_due";
  readonly event: DomainEvent;
  readonly event_type: typeof EXEMPTION_ENDED_EVENT;
  readonly timer: "REGX_1024_17I2_POST_EXEMPTION_HISTORY_90";
  readonly exemption_reason: ExemptionReason;
  readonly exemption_started_at: PlainDate;
  readonly exemption_ended_on: PlainDate;
  readonly ended_by: ExemptionEndedBy;
  readonly history_from: PlainDate;
  readonly history_to: PlainDate;
  /** (i)(2): the history "may be longer than 1 year". */
  readonly exceeds_12_months: boolean;
  readonly due_on: PlainDate;
  readonly notice: typeof POST_EXEMPTION_NOTICE;
  readonly statement_type: "post_exemption_history";
}

/**
 * Rule 6: the history starts the day after the last statement's period end — `history_to` on the loan's last history-bearing
 * `escrow.statement.sent`; failing that, the start of the computation year the held statement was for (the last annual
 * statement ran to the previous `computation_year_end`, 12 months before the one on the analysis approved at or before the hold).
 */
export function historyStartFromLog(events: EventStore, loanId: string, before: DomainEvent): PlainDate | null {
  const prior = last(ofLoan(events, loanId, "escrow.statement.sent").filter((e) => e.sequence < before.sequence && (HISTORY_BEARING as readonly unknown[]).includes(p(e).statement_type) && isDate(p(e).history_to)));
  if (prior) return addDays(p(prior).history_to as PlainDate, 1);
  const approval = last(ofLoan(events, loanId, "escrow.analysis.approved").filter((e) => e.sequence < before.sequence && isDate(p(e).computation_year_end)));
  return approval ? addDays(addMonths(p(approval).computation_year_end as PlainDate, -12), 1) : null;
}

/**
 * 3.3 inputs: `loan.reinstated` / `bankruptcy.case.closed` / `foreclosure.case.cancelled` (§13.3: `foreclosure.case.closed`)
 * where an (i)(2) exemption was applied → the post-exemption history becomes due. Validates the hold (exists, still open,
 * ended by this cause, ended on or after it started), fixes the history period and appends `escrow.statement.exemption_ended`
 * — the REGX_1024_17I2_POST_EXEMPTION_HISTORY_90 trigger, anchored on its `exemption_ended_on` (+ 90 calendar days).
 */
export function endExemption(events: EventStore, i: EndExemptionInput): ExemptionEnded {
  if (!i.loan_id) throw new RangeError("loan_id is required");
  if (!isCause(i.ended_by)) throw new RangeError(`ended_by must be one of ${EXEMPTION_ENDING_EVENTS.join(", ")}`);
  if (!isDate(i.ended_on)) throw new RangeError("ended_on must be a date (the reinstatement / dismissal / closure date)");
  const hold = openExemptHold(events, i.loan_id);
  if (!hold) throw new RangeError(`no open (i)(2) exemption on loan ${i.loan_id}: nothing to end (§1024.17(i)(2) applies only where the exemption was applied)`);
  const reason = p(hold).reason;
  if (!isReason(reason)) throw new RangeError(`exempt hold on loan ${i.loan_id} carries no valid (i)(2) reason`);
  if (!ENDS[reason].includes(i.ended_by)) throw new RangeError(`${i.ended_by} does not end a ${reason} exemption (${reason === "delinquent_30" ? "the loan must become current: loan.reinstated" : reason === "foreclosure_action" ? "loan.reinstated, foreclosure.case.closed or foreclosure.case.cancelled" : "bankruptcy.case.closed"})`);
  const startedAt = isDate(p(hold).as_of) ? p(hold).as_of as PlainDate : plainDate(hold.occurredAt.slice(0, 10));
  if (i.ended_on < startedAt) throw new RangeError(`ended_on ${i.ended_on} is before the exemption was applied (${startedAt})`);
  const historyFrom = historyStartFromLog(events, i.loan_id, hold) ?? (isDate(i.history_from) ? i.history_from : null);   // the log first: the caller cannot shorten the history
  if (!historyFrom) throw new RangeError("history_from is required: the loan's log carries neither a prior statement period end nor an approved analysis to continue from (rule 6: the history covers [last statement end, exemption end])");
  if (historyFrom > i.ended_on) throw new RangeError(`history_from ${historyFrom} is after the exemption end ${i.ended_on}`);
  const dueOn = postExemptionDeadline(i.ended_on);
  const payload = { statement_type: "post_exemption_history" as const, disposition: "exemption_ended" as const, exemption_reason: reason, exemption_started_at: startedAt, exemption_ended_on: i.ended_on, ended_by: i.ended_by,
    history_from: historyFrom, history_to: i.ended_on, exceeds_12_months: addMonths(historyFrom, 12) <= i.ended_on, history_due_on: dueOn, notice: POST_EXEMPTION_NOTICE, status: "history_due" as const, hold_event_id: hold.id };
  const event = events.append({ type: EXEMPTION_ENDED_EVENT, loanId: i.loan_id, actor: i.actor, payload, ...(i.causation_id ? { causationId: i.causation_id } : {}) });
  return { status: "history_due", event, event_type: EXEMPTION_ENDED_EVENT, timer: "REGX_1024_17I2_POST_EXEMPTION_HISTORY_90", exemption_reason: reason, exemption_started_at: startedAt, exemption_ended_on: i.ended_on, ended_by: i.ended_by,
    history_from: historyFrom, history_to: i.ended_on, exceeds_12_months: payload.exceeds_12_months, due_on: dueOn, notice: POST_EXEMPTION_NOTICE, statement_type: "post_exemption_history" };
}

/**
 * Ingestion of the cause itself: a `loan.reinstated` (§13.3) / `foreclosure.case.closed` (§13.3) / `foreclosure.case.cancelled`
 * / `bankruptcy.case.closed` (§14.1) event already on the loan's log ends the exemption on the date it carries (the
 * reinstatement / closure date), else on its own civil date. Returns null when the loan has no open hold (the ordinary case
 * — most reinstatements owe no history).
 */
export function endExemptionFromEvent(events: EventStore, cause: DomainEvent, actor: Actor, opts: { history_from?: PlainDate | null } = {}): ExemptionEnded | null {
  if (!isCause(cause.type)) throw new RangeError(`${cause.type} is not an exemption-ending event (${EXEMPTION_ENDING_EVENTS.join(", ")})`);
  if (!cause.loanId) throw new RangeError(`${cause.type} ${cause.id} carries no loan`);
  if (!openExemptHold(events, cause.loanId)) return null;
  return endExemption(events, { loan_id: cause.loanId, ended_by: cause.type, ended_on: causeDate(cause), history_from: opts.history_from ?? null, actor, causation_id: cause.id });
}

/** One cause against the open hold: ended, or the refusal recorded as `escrow.statement.exemption_end.refused` (the hold stays visible); null when there is nothing to end. */
function ingestCause(events: EventStore, cause: DomainEvent, actor: Actor): ExemptionEnded | { refused: DomainEvent } | null {
  if (!cause.loanId || !openExemptHold(events, cause.loanId)) return null;
  try { return endExemptionFromEvent(events, cause, actor); }
  catch (err) {
    if (!(err instanceof RangeError)) throw err;
    return { refused: events.append({ type: EXEMPTION_END_REFUSED_EVENT, loanId: cause.loanId, actor, causationId: cause.id, payload: { cause: cause.type, cause_event_id: cause.id, cause_date: causeDate(cause), reason: err.message, hold_open: true } }) };
  }
}

/**
 * Lazy ingestion — the 3.3 tools call it before acting on a loan: every exemption-ending event appended after the open hold
 * (in log order, each once — a cause already refused is not re-tried) is ingested as the subscribers would have, so a
 * reinstatement / closure recorded while no reactor was listening still ends the hold on the date it carries. Returns the
 * ending, if one happened, and the refusals recorded.
 */
export function settleExemption(events: EventStore, loanId: string, actor: Actor = ESCROW_AGENT): { ended: ExemptionEnded | null; refused: DomainEvent[] } {
  if (!loanId) throw new RangeError("loan_id is required");
  const refused: DomainEvent[] = [];
  const hold = openExemptHold(events, loanId);
  if (!hold) return { ended: null, refused };
  const tried = new Set(ofLoan(events, loanId, EXEMPTION_END_REFUSED_EVENT).map((e) => String(p(e).cause_event_id)));
  const causes = events.all().filter((e) => e.loanId === loanId && e.sequence > hold.sequence && isCause(e.type) && !tried.has(e.id)).sort((a, b) => a.sequence - b.sequence);
  for (const cause of causes) {
    const r = ingestCause(events, cause, actor);
    if (!r) break;                                               // the hold is closed — later causes owe nothing
    if ("refused" in r) refused.push(r.refused); else return { ended: r, refused };
  }
  return { ended: null, refused };
}

/**
 * 3.3 inputs, wired on the event store (eager ingestion): §13.3's `loan.reinstated` / `foreclosure.case.closed`, the spec's
 * `foreclosure.case.cancelled` and §14.1's `bankruptcy.case.closed` end an open (i)(2) hold on the date they carry
 * (endExemptionFromEvent). A cause that cannot end the open hold (e.g. a bankruptcy case closing on a delinquency hold) or
 * an unusable date is recorded as `escrow.statement.exemption_end.refused{reason}` so the hold stays visible; a loan with
 * no hold owes nothing. Returns the unsubscribe. Wire it wherever the app builds its unit of work; settleExemption covers
 * the causes appended while nothing was listening.
 */
export function exemptionReactors_3_3(events: EventStore, actor: Actor = ESCROW_AGENT): () => void {
  const offs = EXEMPTION_ENDING_EVENTS.map((type) => events.subscribe(type, (e) => { ingestCause(events, e, actor); }));
  return () => { for (const off of offs) off(); };
}
