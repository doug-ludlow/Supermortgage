/**
 * §14.3 operating rules over the pure calculators in ./statement.ts (variant,
 * single-statement skip, Chapter 12/13 arithmetic, Reg F addressing): the 7.1
 * cycle geometry the (e)(5)(iv) single-statement exemption is measured against,
 * the per-cycle records a transition writes (`single_statement_skip`, the
 * template the resumed cycle renders), the exemption-ending events (written
 * request for statements, plan amended to retain, dismissal, reaffirmation), the
 * cease request (effective on receipt, statement held, evidence linked), the
 * rule-4 addressing precedence, the H-30(F) statement content (explanation,
 * past payments, transaction activity, (d)(5) text, arrearage block, (f)(3)(vi)
 * disclosures), the Chapter 7/11 and discharged-loan content (H-30(E)), the
 * scheduled post-petition split, the §1024.39(c) early intervention overlay
 * (45th day after the petition, once per case, the post-discharge written
 * notice, the resume gate after dismissal) and the versioned communications
 * matrix that suppresses D2-2-03 reminders while the stay is in effect. One
 * small pure function per rule / T-id.
 *
 * Defect in the shared calculator (statement.ts, read-only here): its `Mode`
 * spells the plan-surrender exemption `exempt_surrender_plan` and lacks
 * `exempt_charged_off_n_a`; the spec data model and the bk_statement_status
 * CHECK constraint (db/migrations/0016_bankruptcy.sql) say `exempt_plan_surrender`
 * and include `exempt_charged_off_n_a`. `toStatementMode` normalises, and every
 * mode this module returns is the spec enum. statement.ts also renders the
 * (f)(3)(v) arrearage as raw cents (`"1424194"`); `ch13Statement` formats it.
 */
import { type PlainDate, addDays, addMonths, daysBetween, parts, ymd } from "../../kernel/calendar/date.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { monthlyInterest, ratePercent, formatCents, levelPayment } from "../../kernel/money/cents.ts";
import { balanceAfter } from "../lossmit/flexmod.ts";
import { mode as legacyMode, singleStatementSkip, ch13Content, addressing as regFAddressing, type Mode as LegacyMode } from "./statement.ts";
import { openWindow, BK_NOTICE_DAYS, LIVE_DAYS, NOTICE_DAYS } from "../early-intervention/windows.ts";

export const BK_EI_NOTICE = "NTC_REGX_39B_EARLY_INTERVENTION_BK";
export type Chapter = "7" | "11" | "12" | "13";

// ============================================================ data model — bk_statement_status.mode (spec enum)
/** `bk_statement_status.mode` exactly as the spec data model and the 0016 CHECK constraint list it. */
export const STATEMENT_MODES = ["standard", "modified_ch7_11", "modified_ch12_13", "exempt_cease_request", "exempt_plan_surrender", "exempt_court_order", "exempt_soi_surrender", "exempt_charged_off_n_a", "single_statement_skip"] as const;
export type StatementMode = (typeof STATEMENT_MODES)[number];
export type StatementTemplate = "NTC_REGZ_41_STMT_BK12_13" | "NTC_REGZ_41_STMT_BK7_11" | "NTC_REGZ_41_STMT_STD";
export function isStatementMode(v: unknown): v is StatementMode { return typeof v === "string" && (STATEMENT_MODES as readonly string[]).includes(v); }
/** statement.ts's `exempt_surrender_plan` is the spec's `exempt_plan_surrender`; every other value is shared. */
export function toStatementMode(m: LegacyMode | StatementMode): StatementMode { return m === "exempt_surrender_plan" ? "exempt_plan_surrender" : m; }
/** Rule 1(a)–(c) variant decision in the spec enum (statement.ts computes it; the (e)(6) charged-off exemption is 7.1's and is passed through as a fact). */
export function variantMode(f: Parameters<typeof legacyMode>[0] & { charged_off_e6?: boolean }): StatementMode {
  if (f.charged_off_e6 && f.debtor_or_discharged) return "exempt_charged_off_n_a";
  return toStatementMode(legacyMode(f));
}
/** The variant a mode renders: H-30(F) for Chapter 12/13, H-30(E) for Chapter 7/11 and discharged loans, the standard statement otherwise; an exemption or a skipped cycle renders nothing. */
export function statementTemplateFor(m: StatementMode): StatementTemplate | null {
  return m === "modified_ch12_13" ? "NTC_REGZ_41_STMT_BK12_13" : m === "modified_ch7_11" ? "NTC_REGZ_41_STMT_BK7_11" : m === "standard" ? "NTC_REGZ_41_STMT_STD" : null;
}

// ============================================================ cycle geometry (7.1 as 14.3 uses it)
/** A 7.1 cycle: opens on its payment due date, the 15-day courtesy period ends on due + 15, the statement is due 4 days after that (`REGZ_1026_41B_STATEMENT_PROMPT_4`) and shows the next due date's amount. */
export interface StatementCycle { readonly due_date: PlainDate; readonly courtesy_period_end: PlainDate; readonly statement_due_by: PlainDate; readonly amount_due_date: PlainDate; }
export function statementCycle(dueDate: PlainDate): StatementCycle {
  const courtesy = addDays(dueDate, 15);
  return { due_date: dueDate, courtesy_period_end: courtesy, statement_due_by: addDays(courtesy, 4), amount_due_date: addMonths(dueDate, 1) };
}
/** The cycle open on a date: the latest due day (default the 1st) on or before it. */
export function openCycleOn(on: PlainDate, dueDay = 1): StatementCycle {
  const { y, m, d } = parts(on);
  const start = d >= dueDay ? ymd(y, m, dueDay) : addMonths(ymd(y, m, dueDay), -1);
  return statementCycle(start);
}
/** §1024.39(c)(2): "after the next payment due date that follows" the event — the first due date strictly after it. */
export function nextDueDateAfter(on: PlainDate, dueDay = 1): PlainDate { return openCycleOn(on, dueDay).amount_due_date; }

// ============================================================ rule 1(d) — the (e)(5)(iv) single-statement exemption
const isModified = (m: StatementMode): boolean => m === "modified_ch7_11" || m === "modified_ch12_13";
const isExempt = (m: StatementMode): boolean => m.startsWith("exempt_");
export interface Transition { readonly skippable: boolean; readonly decision: "skip_this_cycle" | "send_unmodified_skip_next" | "none"; readonly skipped_cycle: StatementCycle | null; readonly resumes_with: StatementCycle; readonly resume_mode: StatementMode; readonly basis: string; }
/**
 * §1026.41(e)(5)(iv)(A): only (1) becoming subject to (f), (2) ceasing to be subject to (f) or (3) ceasing to qualify for the
 * (i) exemption earns the single-statement exemption; an event that leaves the loan under (f) (a discharge on a loan modified since
 * the petition, comment 41(f)-1) skips nothing. Default per 14.3-Q1: skip the open cycle when the event precedes its courtesy end and
 * nothing was rendered; otherwise send the rendered statement unmodified and skip the following cycle (comment 41(e)(5)(iv)(B)-1).
 */
export function transitionAfterEvent(i: { event_on: PlainDate; mode_before: LegacyMode | StatementMode; mode_after: LegacyMode | StatementMode; rendered_for_open_cycle: boolean; due_day?: number }): Transition {
  const before = toStatementMode(i.mode_before), after = toStatementMode(i.mode_after);
  const open = openCycleOn(i.event_on, i.due_day ?? 1);
  const becomesSubject = !isModified(before) && !isExempt(before) && isModified(after);
  const ceasesSubject = isModified(before) && after === "standard";
  const exemptionEnds = isExempt(before) && !isExempt(after);
  if (!(becomesSubject || ceasesSubject || exemptionEnds)) {
    return { skippable: false, decision: "none", skipped_cycle: null, resumes_with: open, resume_mode: after, basis: `${before} → ${after} is not an (e)(5)(iv)(A) event — no statement is skipped (comment 41(f)-1)` };
  }
  const d = singleStatementSkip(i.event_on, open.courtesy_period_end, i.rendered_for_open_cycle);
  const next = statementCycle(addMonths(open.due_date, 1));
  const skipped = d === "skip_this_cycle" ? open : next;
  const resumes = statementCycle(addMonths(skipped.due_date, 1));
  const which = becomesSubject ? "(A)(1) becomes subject to (f)" : ceasesSubject ? "(A)(2) ceases to be subject to (f)" : "(A)(3) ceases to qualify for the (e)(5)(i) exemption";
  return { skippable: true, decision: d, skipped_cycle: skipped, resumes_with: resumes, resume_mode: after, basis: `§1026.41(e)(5)(iv)${which}; ${d === "skip_this_cycle" ? "event before the courtesy end with nothing rendered → skip this cycle" : "statement already rendered → send unmodified, skip the following cycle"} (comment 41(e)(5)(iv)(B)-1)` };
}
/** What `bk_statement_status` records per cycle for a transition: the skipped cycle as `single_statement_skip` (logged with the event id), the resumed cycle in its variant with the template it renders. */
export interface CycleRecord { readonly cycle: StatementCycle; readonly recorded_mode: StatementMode; readonly template: StatementTemplate | null; readonly statement: "skipped" | "sent_unmodified" | "rendered"; readonly basis_event_id: string | null; }
export function cycleRecords(t: Transition, i: { mode_before: LegacyMode | StatementMode; event_id?: string | null }): CycleRecord[] {
  const before = toStatementMode(i.mode_before); const ev = i.event_id ?? null;
  const resumed: CycleRecord = { cycle: t.resumes_with, recorded_mode: t.resume_mode, template: statementTemplateFor(t.resume_mode), statement: "rendered", basis_event_id: ev };
  if (t.decision === "none") return [resumed];
  const skipped: CycleRecord = { cycle: t.skipped_cycle!, recorded_mode: "single_statement_skip", template: null, statement: "skipped", basis_event_id: ev };
  if (t.decision === "skip_this_cycle") return [skipped, resumed];
  const sentUnmodified: CycleRecord = { cycle: statementCycle(addMonths(t.skipped_cycle!.due_date, -1)), recorded_mode: before, template: statementTemplateFor(before), statement: "sent_unmodified", basis_event_id: ev };
  return [sentUnmodified, skipped, resumed];
}
/** The petition is the (A)(1) event (T1): the loan becomes subject to (f) in the chapter's variant; the open cycle is skipped when nothing was rendered before its courtesy end. */
export function petitionTransition(i: { petition_on: PlainDate; chapter: Chapter; rendered_for_open_cycle: boolean; event_id?: string | null; due_day?: number }): { mode_after: StatementMode; transition: Transition; records: CycleRecord[]; status: { mode: StatementMode; single_statement_used_for_cycle: PlainDate | null; resume_from_cycle: PlainDate; basis_event_id: string | null } } {
  const after = variantMode({ debtor_or_discharged: true, chapter: i.chapter, court_order_cease: false, plan_surrenders: false, ch7_soi_surrender_no_payment: false, cease_request: false, later_request_for_statements: false, reaffirmed_final: false, dismissed_no_discharge: false });
  const t = transitionAfterEvent({ event_on: i.petition_on, mode_before: "standard", mode_after: after, rendered_for_open_cycle: i.rendered_for_open_cycle, due_day: i.due_day ?? 1 });
  const records = cycleRecords(t, { mode_before: "standard", event_id: i.event_id ?? null });
  const skipped = records.find((r) => r.statement === "skipped") ?? null;
  return { mode_after: after, transition: t, records, status: { mode: skipped ? "single_statement_skip" : after, single_statement_used_for_cycle: skipped ? skipped.cycle.amount_due_date : null, resume_from_cycle: t.resumes_with.amount_due_date, basis_event_id: i.event_id ?? null } };
}

// ============================================================ rule 5 — written requests (T4, T5)
export type RequestFrom = "debtor" | "co_borrower" | "counsel" | "agent";
export type RequestChannel = "mail" | "email" | "fax" | "portal_authenticated" | "phone" | "counsel_letter";
/**
 * A written cease request from any obligor, counsel or agent at the exclusive address — or received anywhere from counsel — is effective on
 * receipt (comment 41(e)(5)-3): the open cycle's statement is held if not yet mailed, the request image is the exemption evidence, and a request
 * received elsewhere than the exclusive address is honoured anyway (policy) and logged. Never from a phone call; never without the image.
 */
export function ceaseRequest(i: { received_on: PlainDate; from: RequestFrom; channel: RequestChannel; at_exclusive_address: boolean; document_id: string | null; statement_mailed_for_open_cycle: boolean; chapter: Chapter; mode_before?: StatementMode | null; due_day?: number }): {
  honoured: boolean; refusal: string | null; mode_after: StatementMode; effective_on: PlainDate | null; effective_basis: string | null; timer: "REGZ_1026_41E5_CEASE_EFFECTIVE_0";
  held_statement: { cycle: StatementCycle; amount_due_date: PlainDate; held: boolean; reason: string } | null; evidence: { basis_document_id: string; kind: "written_request_image" } | null; logged_off_address: boolean;
  status: { mode: StatementMode; basis_document_id: string; exclusive_address_used: boolean; last_request: { kind: "cease"; from: RequestFrom; received_at: PlainDate } } | null;
} {
  const timer = "REGZ_1026_41E5_CEASE_EFFECTIVE_0" as const;
  // a refused request changes nothing: the mode reported back is the loan's current mode — the chapter's (f) variant unless the caller says otherwise
  const unchanged: StatementMode = i.mode_before ?? modifiedModeFor(i.chapter);
  const refuse = (refusal: string) => ({ honoured: false, refusal, mode_after: unchanged, effective_on: null, effective_basis: null, timer, held_statement: null, evidence: null, logged_off_address: false, status: null });
  if (i.channel === "phone") return refuse("a cease request is never inferred from a phone call — answer the call with instructions for a written request (§1026.41(e)(5)(i)(B)(1); 14.3 guardrail)");
  if (!i.document_id) return refuse("no exemption without a linked evidence document — attach the written request image (14.3 guardrail)");
  const open = openCycleOn(i.received_on, i.due_day ?? 1);
  const basis = i.from === "counsel" ? "received from the debtor's counsel — effective wherever received (comment 41(e)(5)-1)" : i.at_exclusive_address ? "received at the exclusive address (§1026.41(e)(5)(i)(B)(1))" : "received elsewhere than the exclusive address — honoured anyway (policy) and logged";
  return { honoured: true, refusal: null, mode_after: "exempt_cease_request", effective_on: i.received_on, effective_basis: basis, timer,
    held_statement: { cycle: open, amount_due_date: open.amount_due_date, held: !i.statement_mailed_for_open_cycle, reason: i.statement_mailed_for_open_cycle ? "the open cycle's statement was already mailed — the exemption applies from the next cycle" : "effective on receipt (comment 41(e)(5)-3): the open cycle's statement is held" },
    evidence: { basis_document_id: i.document_id, kind: "written_request_image" }, logged_off_address: !i.at_exclusive_address,
    status: { mode: "exempt_cease_request", basis_document_id: i.document_id, exclusive_address_used: i.at_exclusive_address, last_request: { kind: "cease", from: i.from, received_at: i.received_on } } };
}
/**
 * A later written request for statements from any obligor (either spouse — comment 41(e)(5)-6; counsel or agent deemed the consumer —
 * comment -1; the most recent request controls — comment -2) ends the cease-request exemption from the next cycle, with the single-statement
 * exemption available; the first statement may limit activity to the period since the last due date while exempt (comment 41(f)(3)-3).
 */
export function resumeRequest(i: { received_on: PlainDate; from: RequestFrom; in_writing: boolean; chapter: Chapter; court_order_cease: boolean; rendered_for_open_cycle: boolean; exempt_since: PlainDate; due_day?: number }): { honoured: boolean; refusal: string | null; mode_after: StatementMode; exemption_ends_on: PlainDate | null; transition: Transition | null; first_statement_activity_from: PlainDate | null; timer: "REGZ_1026_41E5II_RESUME_NEXT_CYCLE" } {
  const timer = "REGZ_1026_41E5II_RESUME_NEXT_CYCLE" as const;
  if (!i.in_writing) return { honoured: false, refusal: "a request for statements must be in writing (§1026.41(e)(5)(ii)); answer the call with instructions for a written request", mode_after: "exempt_cease_request", exemption_ends_on: null, transition: null, first_statement_activity_from: null, timer };
  if (i.court_order_cease) return { honoured: false, refusal: "a court order requires the servicer to cease — the request does not end the exemption (§1026.41(e)(5)(ii))", mode_after: "exempt_court_order", exemption_ends_on: null, transition: null, first_statement_activity_from: null, timer };
  const modeAfter = variantMode({ debtor_or_discharged: true, chapter: i.chapter, court_order_cease: false, plan_surrenders: false, ch7_soi_surrender_no_payment: false, cease_request: true, later_request_for_statements: true, reaffirmed_final: false, dismissed_no_discharge: false });
  const t = transitionAfterEvent({ event_on: i.received_on, mode_before: "exempt_cease_request", mode_after: modeAfter, rendered_for_open_cycle: i.rendered_for_open_cycle, due_day: i.due_day ?? 1 });
  const lastDueWhileExempt = openCycleOn(i.received_on, i.due_day ?? 1).due_date;
  return { honoured: true, refusal: null, mode_after: modeAfter, exemption_ends_on: i.received_on, transition: t, first_statement_activity_from: lastDueWhileExempt >= i.exempt_since ? lastDueWhileExempt : i.exempt_since, timer };
}

// ============================================================ edge case — plan amended from surrender to retain (T6)
export function planTreatmentChanged(i: { amended_on: PlainDate; from: "surrender" | "lien_avoidance" | "retain_and_cure" | "pay_outside"; to: "surrender" | "lien_avoidance" | "retain_and_cure" | "pay_outside"; chapter: "12" | "13"; rendered_for_open_cycle: boolean; due_day?: number }): { exemption_ends: boolean; mode_after: StatementMode; transition: Transition; basis: string } {
  const wasExempt = i.from === "surrender" || i.from === "lien_avoidance";
  const nowExempt = i.to === "surrender" || i.to === "lien_avoidance";
  const before: StatementMode = wasExempt ? "exempt_plan_surrender" : "modified_ch12_13";
  const after: StatementMode = nowExempt ? "exempt_plan_surrender" : "modified_ch12_13";
  const t = transitionAfterEvent({ event_on: i.amended_on, mode_before: before, mode_after: after, rendered_for_open_cycle: i.rendered_for_open_cycle, due_day: i.due_day ?? 1 });
  return { exemption_ends: wasExempt && !nowExempt, mode_after: after, transition: t, basis: "the most recently filed plan controls (comment 41(e)(5)(i)(B)(2)-1); a plan amended to retain/pay ends the exemption (comment 41(e)(5)(iv)(A)-2)" };
}

// ============================================================ rule 4 — addressing (T8)
export type Addressing = "debtor" | "counsel" | "counsel_and_debtor" | "trustee_copy";
/**
 * Order of precedence: (i) court order / local rule → follow (an order or local rule restricting debtor contact goes to `attorney`);
 * (ii) counsel's written instruction (cease → exemption; "send to my office" → counsel; "send to client" → debtor); (iii) an FDCPA
 * debt-collector loan with a debtor's attorney of record → counsel, with a debtor copy only if counsel consents (Reg F §1006.6(b)(2);
 * 14.3-Q2 default); (iv) otherwise the debtor at the address of record, with a courtesy copy to counsel on request.
 */
export function addressingDecision(i: { court_directs?: "counsel" | "debtor" | null; local_rule_bars_debtor_contact?: boolean; counsel_instruction?: "cease" | "send_to_counsel" | "send_to_debtor" | null; fdcpa_debt_collector: boolean; attorney_of_record: boolean; counsel_consents_debtor_copy: boolean; counsel_requests_courtesy_copy?: boolean }): { addressing: Addressing; recipients: readonly ("counsel" | "debtor")[]; debtor_copy_mailed: boolean; precedence: "i" | "ii" | "iii" | "iv"; addressing_basis: string; exemption: "exempt_cease_request" | null; escalate: "attorney" | null } {
  if (i.court_directs || i.local_rule_bars_debtor_contact) {
    const to: Addressing = i.court_directs === "debtor" ? "debtor" : "counsel";
    return { addressing: to, recipients: [to], debtor_copy_mailed: to === "debtor", precedence: "i", addressing_basis: i.court_directs ? `court order directs ${to} (rule 4(i); comment 41(f)-4)` : "local rule bars direct debtor contact → counsel (rule 4(i); comment 41(f)-4; CFPB FAQ)", exemption: null, escalate: "attorney" };
  }
  if (i.counsel_instruction === "cease") return { addressing: "counsel", recipients: [], debtor_copy_mailed: false, precedence: "ii", addressing_basis: "counsel's written cease instruction → exemption (rule 4(ii); §1026.41(e)(5)(i)(B)(1))", exemption: "exempt_cease_request", escalate: null };
  if (i.counsel_instruction === "send_to_counsel") return { addressing: "counsel", recipients: ["counsel"], debtor_copy_mailed: false, precedence: "ii", addressing_basis: "counsel's written instruction: send to my office (rule 4(ii))", exemption: null, escalate: null };
  if (i.counsel_instruction === "send_to_debtor") return { addressing: "debtor", recipients: ["debtor"], debtor_copy_mailed: true, precedence: "ii", addressing_basis: "counsel's written instruction: send to client (rule 4(ii))", exemption: null, escalate: null };
  if (i.fdcpa_debt_collector && i.attorney_of_record) {
    const r = regFAddressing({ fdcpa_covered: true, attorney_of_record: true, counsel_consents_debtor_copy: i.counsel_consents_debtor_copy });
    const both = r.includes("debtor");
    return { addressing: both ? "counsel_and_debtor" : "counsel", recipients: r, debtor_copy_mailed: both, precedence: "iii", addressing_basis: both ? "FDCPA debt collector with a debtor's attorney of record; counsel consented to the debtor copy (Reg F §1006.6(b)(2); 14.3-Q2)" : "FDCPA debt collector with a debtor's attorney of record: counsel-addressed, no debtor copy without counsel's consent (Reg F §1006.6(b)(2); 14.3-Q2 default)", exemption: null, escalate: null };
  }
  const courtesy = i.attorney_of_record && (i.counsel_requests_courtesy_copy ?? false);
  return { addressing: courtesy ? "counsel_and_debtor" : "debtor", recipients: courtesy ? ["debtor", "counsel"] : ["debtor"], debtor_copy_mailed: true, precedence: "iv", addressing_basis: courtesy ? "debtor at the address of record with a courtesy copy to counsel on request (rule 4(iv))" : "debtor at the address of record (rule 4(iv))", exemption: null, escalate: null };
}

// ============================================================ rule 1(f) + rule 6 — dismissal (T9)
export interface EarlyInterventionResume { readonly gate: "REGX_1024_39C2_RESUME_GATE"; readonly resume_from_due_date: PlainDate; readonly live_contact_due: PlainDate; readonly written_notice_due: PlainDate; readonly live_contact: "re_armed"; readonly written_notice: "re_armed"; }
/** §1024.39(c)(2)(i): after dismissal/closure/reaffirmation the 11.1/11.2 clocks re-arm from the next payment due date that follows the event. */
export function earlyInterventionResume(eventOn: PlainDate, dueDay = 1): EarlyInterventionResume {
  const due = nextDueDateAfter(eventOn, dueDay); const w = openWindow(due, { principal_residence: true });
  return { gate: "REGX_1024_39C2_RESUME_GATE", resume_from_due_date: due, live_contact_due: w.live_due_at, written_notice_due: w.notice_due_at, live_contact: "re_armed", written_notice: "re_armed" };
}
export function dismissal(i: { dismissed_on: PlainDate; discharge_entered: boolean; chapter: Chapter; rendered_for_open_cycle: boolean; due_day?: number }): { mode_after: StatementMode; transition: Transition; early_intervention: EarlyInterventionResume | null; basis: string } {
  const before: StatementMode = modifiedModeFor(i.chapter);
  if (i.discharge_entered) return { mode_after: before, transition: transitionAfterEvent({ event_on: i.dismissed_on, mode_before: before, mode_after: before, rendered_for_open_cycle: i.rendered_for_open_cycle, due_day: i.due_day ?? 1 }), early_intervention: null, basis: "a discharged loan stays under (f) after the case closes (comment 41(f)-1)" };
  const after = variantMode({ debtor_or_discharged: true, chapter: i.chapter, court_order_cease: false, plan_surrenders: false, ch7_soi_surrender_no_payment: false, cease_request: false, later_request_for_statements: false, reaffirmed_final: false, dismissed_no_discharge: true });
  return { mode_after: after, transition: transitionAfterEvent({ event_on: i.dismissed_on, mode_before: before, mode_after: after, rendered_for_open_cycle: i.rendered_for_open_cycle, due_day: i.due_day ?? 1 }), early_intervention: earlyInterventionResume(i.dismissed_on, i.due_day ?? 1), basis: "dismissal without discharge → `standard` after one skippable cycle (comment 41(e)(5)(iv)(A)-2); 11.1/11.2 resume after the next due date (§1024.39(c)(2)(i))" };
}

// ============================================================ rule 1(e) — reaffirmation (T11)
/** 11 U.S.C. §524(c)(4): the debtor may rescind "at any time prior to discharge or within sixty days after such agreement is filed with the court, whichever occurs later". */
export function reaffirmationRescissionEnds(filedOn: PlainDate, dischargeOn: PlainDate): PlainDate { const sixty = addDays(filedOn, 60); return sixty > dischargeOn ? sixty : dischargeOn; }
export function reaffirmationVariant(i: { filed_on: PlainDate; discharge_on: PlainDate; chapter: Chapter; as_of: PlainDate; rescinded_on?: PlainDate | null }): { rescission_window_ends: PlainDate; reaffirmation_final: boolean; mode: StatementMode; basis: string } {
  const ends = reaffirmationRescissionEnds(i.filed_on, i.discharge_on);
  const rescinded = Boolean(i.rescinded_on && i.rescinded_on <= ends);
  const final = !rescinded && i.as_of > ends;
  const mode = variantMode({ debtor_or_discharged: true, chapter: i.chapter, court_order_cease: false, plan_surrenders: false, ch7_soi_surrender_no_payment: false, cease_request: false, later_request_for_statements: false, reaffirmed_final: final, dismissed_no_discharge: false });
  return { rescission_window_ends: ends, reaffirmation_final: final, mode, basis: final ? "reaffirmed and the §524(c)(4) rescission window lapsed — a reaffirming consumer is not a debtor in bankruptcy (comment 41(f)-6)" : `modified until the §524(c)(4) window ends ${ends} (later of 60 days after filing and the discharge)` };
}

// ============================================================ rule 2 — Chapter 12/13 content, H-30(F) (T2)
const mdy = (d: PlainDate): string => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`;
export interface Ch13Receipt { readonly on: PlainDate; readonly cents: Cents; readonly source: "debtor" | "trustee"; readonly applied_to: "postpetition" | "prepetition" | "unapplied"; }
export interface Ch13Statement {
  readonly template: "NTC_REGZ_41_STMT_BK12_13"; readonly amount_due_date: PlainDate; readonly statement_date: PlainDate;
  readonly installment_cents: Cents; readonly amount_due_cents: Cents; readonly amount_due_display: string; readonly past_due_postpetition_cents: Cents; readonly past_due_postpetition_display: string;
  readonly explanation: { readonly principal_cents: Cents; readonly interest_cents: Cents; readonly escrow_cents: Cents; readonly escrow_display: string; readonly fees_since_last_cents: Cents; readonly fees_since_last_display: string; readonly past_due_postpetition_cents: Cents; readonly allowed_noticed_fees_unpaid_cents: Cents };
  readonly past_payments: { readonly since_last_statement_cents: Cents; readonly since_last_statement_display: string; readonly unapplied_since_last_cents: Cents; readonly ytd_cents: Cents; readonly unapplied_held_cents: Cents; readonly unapplied_held_display: string; readonly trustee_since_last_cents: Cents };
  readonly transactions: readonly string[]; readonly suspense_disclosed: boolean; readonly shortfall_cents: Cents | null; readonly d5_partial_payment_text: string | null;
  readonly prepetition_arrearage: { readonly received_since_last_cents: Cents; readonly received_since_last_display: string; readonly received_since_filing_cents: Cents; readonly received_since_filing_display: string; readonly balance_cents: Cents | null; readonly display: string; readonly acknowledgment_shown: boolean; readonly defect: string | null };
  readonly postpetition_days_delinquent: number; readonly over_45_sentence: boolean; readonly disclosures: readonly string[]; readonly legend: string;
  readonly late_fee_line: false; readonly delinquency_box: false; readonly foreclosure_language: false; readonly informational_only: true;
}
/**
 * §1026.41(f)(3)(vi), as applicable: (A) the amount due includes only post-petition payments; (B) if the plan requires the post-petition payments
 * to go to the trustee (conduit), that the consumer should pay the trustee, not the servicer; (C) the statement may not reflect payments made to
 * the trustee and may not be consistent with the trustee's records — with the arrearage aside only when the trustee pays the arrearage; (D)
 * contact your attorney or the trustee; (E) when more than 45 days delinquent on post-petition payments, that the servicer has not received all
 * the payments that became due since the filing. Selected by `trustee_pays_postpetition` / `trustee_pays_arrearage` / `postpetition_days_delinquent > 45` (rule 2).
 */
export function ch13Disclosures(i: { trustee_pays_postpetition: boolean; trustee_pays_arrearage: boolean; over_45: boolean }): string[] {
  return [
    "The amount due includes only post-petition amounts.",
    ...(i.trustee_pays_postpetition ? ["Your bankruptcy plan requires you to make your post-petition mortgage payments to the trustee. You should send those payments to the trustee, not to us."] : []),
    i.trustee_pays_arrearage ? "This statement may not reflect payments made to the trustee and may not be consistent with the trustee's records; the trustee pays the pre-petition arrearage." : "This statement may not reflect payments made to the trustee and may not be consistent with the trustee's records.",
    "Contact your attorney or the trustee with questions about your bankruptcy case.",
    ...(i.over_45 ? ["We have not received all the payments that became due since you filed for bankruptcy."] : []),
  ];
}
/**
 * H-30(F) from `bankruptcy_ledger_views`: amount due = this cycle's post-petition installment + unpaid post-petition installments (FIFO on the
 * post-petition ledger) + allowed noticed fees (memo-only fees never shown — comment 41(f)(3)-2); suspense disclosed under (d)(3)/(d)(5), never
 * netted; the explanation is the scheduled P&I/escrow split (14.1 rule 6); every receipt is tagged pre-/post-petition and "trustee"; the arrearage
 * block shows the three (f)(3)(v) figures, or the "amount not yet determined" acknowledgment until the POC is computed and always after the bar
 * date (comment (v)-1); the (f)(3)(vi) statements follow the trustee flags and `postpetition_days_delinquent > 45`; no late fee, delinquency box
 * or foreclosure language.
 */
export function ch13Statement(i: { statement_date: PlainDate; amount_due_date: PlainDate; chapter: "12" | "13"; case_number: string; installment: { principal_cents: Cents; interest_cents: Cents; escrow_cents: Cents }; postpetition_unpaid: readonly { due: PlainDate; cents: Cents }[]; allowed_noticed_fees_unpaid_cents: Cents; postpetition_fees_since_last_cents: Cents; receipts_since_last: readonly Ch13Receipt[]; ytd_received_cents: Cents; suspense_cents: Cents; prepetition: { received_since_last_cents: Cents; received_since_filing_cents: Cents; arrearage_cents: Cents | null; bar_date_passed: boolean }; trustee_pays_postpetition: boolean; trustee_pays_arrearage: boolean }): Ch13Statement {
  const installment = i.installment.principal_cents + i.installment.interest_cents + i.installment.escrow_cents;
  const core = ch13Content({ statement_date: i.statement_date, postpetition_installment_cents: installment, postpetition_unpaid: i.postpetition_unpaid.map((u) => ({ due: u.due, cents: u.cents })), allowed_noticed_fees_unpaid_cents: i.allowed_noticed_fees_unpaid_cents, suspense_cents: i.suspense_cents, prepetition_arrearage_cents: i.prepetition.arrearage_cents, trustee_pays_postpetition: i.trustee_pays_postpetition });
  const oldest = [...i.postpetition_unpaid].sort((a, b) => (a.due < b.due ? -1 : 1))[0] ?? null;
  const days = oldest ? daysBetween(oldest.due, i.statement_date) : 0;
  const sum = (rs: readonly Ch13Receipt[]): Cents => rs.reduce((s, r) => s + r.cents, 0n);
  const sinceLast = sum(i.receipts_since_last), unapplied = sum(i.receipts_since_last.filter((r) => r.applied_to === "unapplied")), trustee = sum(i.receipts_since_last.filter((r) => r.source === "trustee"));
  const tx = i.receipts_since_last.map((r) => `${mdy(r.on)} ${r.source === "trustee" ? "Trustee payment received" : "Payment received"} — ${formatCents(r.cents)} — ${r.applied_to === "unapplied" ? "held in unapplied funds (post-petition)" : r.applied_to === "postpetition" ? "applied to the post-petition installment (post-petition)" : "applied to the pre-petition arrearage (pre-petition)"}${r.source === "trustee" ? " (trustee)" : ""}`);
  if (i.postpetition_fees_since_last_cents > 0n) tx.push(`${mdy(i.statement_date)} Post-petition fees imposed — ${formatCents(i.postpetition_fees_since_last_cents)} — noticed under Rule 3002.1(c) (post-petition)`);
  const arrears = i.prepetition.arrearage_cents;
  const acknowledgment = arrears === null;
  const disclosures = ch13Disclosures({ trustee_pays_postpetition: i.trustee_pays_postpetition, trustee_pays_arrearage: i.trustee_pays_arrearage, over_45: core.over_45_sentence });
  return { template: "NTC_REGZ_41_STMT_BK12_13", amount_due_date: i.amount_due_date, statement_date: i.statement_date, installment_cents: installment, amount_due_cents: core.amount_due_cents, amount_due_display: formatCents(core.amount_due_cents), past_due_postpetition_cents: core.past_due_postpetition_cents, past_due_postpetition_display: formatCents(core.past_due_postpetition_cents),
    explanation: { principal_cents: i.installment.principal_cents, interest_cents: i.installment.interest_cents, escrow_cents: i.installment.escrow_cents, escrow_display: formatCents(i.installment.escrow_cents), fees_since_last_cents: i.postpetition_fees_since_last_cents, fees_since_last_display: formatCents(i.postpetition_fees_since_last_cents), past_due_postpetition_cents: core.past_due_postpetition_cents, allowed_noticed_fees_unpaid_cents: i.allowed_noticed_fees_unpaid_cents },
    past_payments: { since_last_statement_cents: sinceLast, since_last_statement_display: formatCents(sinceLast), unapplied_since_last_cents: unapplied, ytd_cents: i.ytd_received_cents, unapplied_held_cents: i.suspense_cents, unapplied_held_display: formatCents(i.suspense_cents), trustee_since_last_cents: trustee },
    transactions: tx, suspense_disclosed: i.suspense_cents > 0n, shortfall_cents: core.shortfall_text_cents, d5_partial_payment_text: core.shortfall_text_cents !== null && core.shortfall_text_cents > 0n ? `We need ${formatCents(core.shortfall_text_cents)} more to apply a full post-petition payment.` : null,
    prepetition_arrearage: { received_since_last_cents: i.prepetition.received_since_last_cents, received_since_last_display: formatCents(i.prepetition.received_since_last_cents), received_since_filing_cents: i.prepetition.received_since_filing_cents, received_since_filing_display: formatCents(i.prepetition.received_since_filing_cents), balance_cents: arrears, display: acknowledgment ? "amount not yet determined" : formatCents(arrears), acknowledgment_shown: acknowledgment, defect: acknowledgment && i.prepetition.bar_date_passed ? "the arrearage figure is required after the bar date (comment 41(f)(3)(v)-1)" : null },
    postpetition_days_delinquent: days, over_45_sentence: core.over_45_sentence, disclosures, legend: `You are a debtor in a Chapter ${i.chapter} bankruptcy case (No. ${i.case_number}) — this statement is for informational purposes only.`,
    late_fee_line: false, delinquency_box: false, foreclosure_language: false, informational_only: true };
}

// ============================================================ rule 3 — Chapter 7/11 and discharged content, H-30(E) (T3)
export interface Ch7Content {
  readonly template: "NTC_REGZ_41_STMT_BK7_11"; readonly installment_cents: Cents; readonly installment_display: string; readonly prepetition_late_charges_cents: Cents; readonly prepetition_late_charges_display: string;
  readonly amount_to_bring_current_cents: Cents; readonly amount_to_bring_current_display: string; readonly amount_due_cents: Cents; readonly amount_due_display: string; readonly unpaid_installments_cents: Cents; readonly unpaid_installments_display: string; readonly unpaid_installment_count: number;
  readonly account_history: { due: PlainDate; remaining_cents: Cents; line: string }[]; readonly regx_days_delinquent: number; readonly new_late_charges_cents: 0n;
  readonly status_legend: string; readonly informational_only: true; readonly omitted: readonly string[]; readonly retained: readonly string[];
  readonly delinquency_start_date_shown: false; readonly risk_of_foreclosure_shown: false; readonly first_notice_statement_shown: false; readonly late_fee_line: false;
}
/** H-30(E): contractual figures, no new late charges post-petition/post-discharge (14.3-Q4), (d)(1)(ii) and (d)(8)(i)/(ii)/(v) omitted, history / amount to bring current / counselor retained. */
export function ch7Content(f: { statement_date: PlainDate; next_due: PlainDate; installment_cents: Cents; unpaid_due_dates: readonly PlainDate[]; prepetition_late_charges_cents: Cents; prepetition_other_fees_cents?: Cents; status: "debtor" | "discharged"; chapter: Chapter; case_number: string; history_months?: number }): Ch7Content {
  const unpaid = [...f.unpaid_due_dates].sort();
  const installments = BigInt(unpaid.length) * f.installment_cents;
  const toCure = installments + f.prepetition_late_charges_cents + (f.prepetition_other_fees_cents ?? 0n);
  const months = f.history_months ?? 6;
  const history: Ch7Content["account_history"] = [];
  for (let k = months; k >= 1; k--) { const due = addMonths(f.next_due, -k); const remaining = unpaid.includes(due) ? f.installment_cents : 0n; history.push({ due, remaining_cents: remaining, line: remaining > 0n ? `${due}: ${formatCents(remaining)} remaining` : `${due}: paid` }); }
  const earliest = unpaid[0] ?? null;
  const legend = f.status === "discharged"
    ? `You received a discharge of your personal liability for this mortgage loan in your Chapter ${f.chapter} bankruptcy case (No. ${f.case_number}). This statement is for informational purposes only and is not an attempt to collect a debt from you personally.`
    : `You are a debtor in a Chapter ${f.chapter} bankruptcy case (No. ${f.case_number}). This statement is for informational purposes only and is not an attempt to collect a debt from you personally.`;
  return { template: "NTC_REGZ_41_STMT_BK7_11", installment_cents: f.installment_cents, installment_display: formatCents(f.installment_cents), prepetition_late_charges_cents: f.prepetition_late_charges_cents, prepetition_late_charges_display: formatCents(f.prepetition_late_charges_cents),
    amount_to_bring_current_cents: toCure, amount_to_bring_current_display: formatCents(toCure), amount_due_cents: toCure + f.installment_cents, amount_due_display: formatCents(toCure + f.installment_cents), unpaid_installments_cents: installments, unpaid_installments_display: formatCents(installments), unpaid_installment_count: unpaid.length, account_history: history,
    regx_days_delinquent: earliest ? daysBetween(earliest, f.statement_date) : 0, new_late_charges_cents: 0n, status_legend: legend, informational_only: true,
    omitted: ["d1ii_late_fee", "d8i_delinquency_start_date", "d8ii_risk_of_foreclosure", "d8v_first_notice_statement"], retained: ["d8iii_account_history", "d8iv_lossmit_program", "d8vi_amount_to_bring_current", "d8vii_counselor_reference"],
    delinquency_start_date_shown: false, risk_of_foreclosure_shown: false, first_notice_statement_shown: false, late_fee_line: false };
}
/** The (f) variant a chapter renders while the consumer is a debtor: H-30(F) for Chapter 12/13, H-30(E) for Chapter 7/11 (rule 1(c)). */
export function modifiedModeFor(chapter: Chapter): "modified_ch7_11" | "modified_ch12_13" { return chapter === "12" || chapter === "13" ? "modified_ch12_13" : "modified_ch7_11"; }
/**
 * Comment 41(f)-1: a loan already modified since the petition stays under (f) at discharge — no (e)(5)(iv) event, no skipped cycle. With a
 * reaffirmation on file the discharge changes nothing either: rule 1(e) keeps `modified_*` until the §524(c)(4) rescission window lapses (the
 * later of 60 days after the agreement was filed and the discharge — the 14.1 gate), and only then does the variant switch to `standard`
 * (T11: filed 2026-11-20, discharge 2026-12-15 → modified through 2027-01-19). `standard_from` is that date; null without a reaffirmation.
 */
export function dischargeTransition(i: { petition_on: PlainDate; discharge_on: PlainDate; reaffirmed: boolean; reaffirmation_filed_on?: PlainDate | null; chapter: Chapter; rendered_for_open_cycle: boolean }): Transition & { standard_from: PlainDate | null } {
  const before = modifiedModeFor(i.chapter);
  if (i.reaffirmed) {
    if (!i.reaffirmation_filed_on) throw new RangeError("reaffirmation_filed_on is required with reaffirmed=true — the §524(c)(4) rescission window runs from the filing (rule 1(e))");
    const ends = reaffirmationRescissionEnds(i.reaffirmation_filed_on, i.discharge_on);
    const t = transitionAfterEvent({ event_on: i.discharge_on, mode_before: before, mode_after: before, rendered_for_open_cycle: i.rendered_for_open_cycle });
    return { ...t, resume_mode: before, basis: `reaffirmation filed ${i.reaffirmation_filed_on}: modified_* continues until the §524(c)(4) rescission window lapses ${ends} (rule 1(e); comment 41(f)-6) — then standard; the discharge itself is not an (e)(5)(iv)(A) event (comment 41(f)-1)`, standard_from: ends };
  }
  return { ...transitionAfterEvent({ event_on: i.discharge_on, mode_before: before, mode_after: "modified_ch7_11", rendered_for_open_cycle: i.rendered_for_open_cycle }), standard_from: null };
}

// ============================================================ rule 2 — scheduled split (14.1 rule 6) for a post-petition installment
/**
 * The plan-terms view applies each post-petition installment per the note's schedule as if the pre-petition installments had been paid. The
 * scheduled P&I is the note's level payment (kernel `levelPayment`) unless the ledger view supplies `pi_cents` (a plan-modified or ARM amount).
 */
export function postpetitionSplit(f: { original_upb_cents: Cents; rate_pct: string; term_months: number; payment_number: number; pi_cents?: Cents; escrow_cents: Cents }): { payment_number: number; upb_before_cents: Cents; pi_cents: Cents; interest_cents: Cents; principal_cents: Cents; escrow_cents: Cents; installment_cents: Cents } {
  const pi = f.pi_cents ?? levelPayment(f.original_upb_cents, ratePercent(f.rate_pct), f.term_months);
  const upb = balanceAfter(f.original_upb_cents, f.rate_pct, f.term_months, f.payment_number - 1);
  const interest = monthlyInterest(upb, ratePercent(f.rate_pct));
  return { payment_number: f.payment_number, upb_before_cents: upb, pi_cents: pi, interest_cents: interest, principal_cents: pi - interest, escrow_cents: f.escrow_cents, installment_cents: pi + f.escrow_cents };
}

// ============================================================ rule 6 — early intervention in bankruptcy (T7, T10)
export interface BkEarlyIntervention { readonly required: boolean; readonly reason: string | null; readonly timer: "REGX_1024_39C1_BK_WRITTEN_NOTICE_45" | "REGX_1024_39B_BK_LATER_DELINQUENCY_45" | null; readonly deadline: PlainDate | null; readonly recipient: "borrower" | "counsel"; readonly notice_code: typeof BK_EI_NOTICE; readonly payment_request: false; readonly live_contact: "exempt_bk"; readonly once_per_case_satisfied: boolean; }
/** §1024.39(c)(1)(iii)(A): delinquent at the petition → the modified written notice by the 45th day after the petition; (B) no payment request; (C) once per case; (c)(1)(ii) exemptions. */
export function earlyInterventionAtPetition(i: { petition_on: PlainDate; regx_days_delinquent_at_petition: number; lossmit_available: boolean; fdcpa_cease_on_file: boolean; prior_notice_this_case: boolean; attorney_of_record: boolean }): BkEarlyIntervention {
  const base: Omit<BkEarlyIntervention, "required" | "reason" | "timer" | "deadline"> = { recipient: i.attorney_of_record ? "counsel" : "borrower", notice_code: BK_EI_NOTICE, payment_request: false, live_contact: "exempt_bk", once_per_case_satisfied: i.prior_notice_this_case };
  if (!i.lossmit_available) return { ...base, required: false, reason: "no loss mitigation option is available (§1024.39(c)(1)(ii))", timer: null, deadline: null };
  if (i.fdcpa_cease_on_file) return { ...base, required: false, reason: "a borrower has provided an FDCPA §805(c) cease notification (§1024.39(c)(1)(ii))", timer: null, deadline: null };
  if (i.prior_notice_this_case) return { ...base, required: false, reason: "not more than once during a single bankruptcy case (§1024.39(c)(1)(iii)(C))", timer: null, deadline: null };
  if (i.regx_days_delinquent_at_petition <= 0) return { ...base, required: false, reason: "not delinquent at the petition — a later delinquency starts the ordinary 45-day clock (§1024.39(c)(1)(iii)(A))", timer: null, deadline: null };
  return { ...base, required: true, reason: null, timer: "REGX_1024_39C1_BK_WRITTEN_NOTICE_45", deadline: addDays(i.petition_on, BK_NOTICE_DAYS) };
}
/** A delinquency arising during the case starts the ordinary 45-day clock — unless the case's one notice has already gone out. */
export function laterDelinquencyDuringCase(i: { unpaid_due_date: PlainDate; once_per_case_satisfied: boolean; attorney_of_record: boolean }): BkEarlyIntervention {
  const base: Omit<BkEarlyIntervention, "required" | "reason" | "timer" | "deadline"> = { recipient: i.attorney_of_record ? "counsel" : "borrower", notice_code: BK_EI_NOTICE, payment_request: false, live_contact: "exempt_bk", once_per_case_satisfied: i.once_per_case_satisfied };
  if (i.once_per_case_satisfied) return { ...base, required: false, reason: "the bankruptcy-modified notice was already provided in this case — not more than once during a single bankruptcy case (§1024.39(c)(1)(iii)(C); comment 39(c)(2)-1)", timer: null, deadline: null };
  return { ...base, required: true, reason: null, timer: "REGX_1024_39B_BK_LATER_DELINQUENCY_45", deadline: openWindow(i.unpaid_due_date, { principal_residence: true }).notice_due_at };
}
/** The `bk_early_intervention` row a decision writes (case_id PK; `once_per_case_satisfied` flips when the notice id is linked). */
export type EiTimer = "REGX_1024_39C1_BK_WRITTEN_NOTICE_45" | "REGX_1024_39B_BK_LATER_DELINQUENCY_45" | "REGX_1024_39C2_DISCHARGE_WRITTEN_NOTICE" | "REGX_1024_39C2_RESUME_GATE";
export interface EiDecisionLike { readonly required: boolean; readonly deadline: PlainDate | null; readonly recipient: "borrower" | "counsel"; readonly timer: EiTimer | null; readonly reason: string | null; readonly once_per_case_satisfied: boolean; }
export function earlyInterventionRecord(i: { case_id: string; loan_id: string; decision: EiDecisionLike; notice_id?: string | null; sent_at?: string | null }): { case_id: string; loan_id: string; required: boolean; deadline: PlainDate | null; sent_at: string | null; recipient: "borrower" | "counsel"; notice_id: string | null; once_per_case_satisfied: boolean; timer: EiTimer | null; reason: string | null } {
  const noticeId = i.notice_id ?? null;
  return { case_id: i.case_id, loan_id: i.loan_id, required: i.decision.required, deadline: i.decision.deadline, sent_at: i.sent_at ?? null, recipient: i.decision.recipient, notice_id: noticeId, once_per_case_satisfied: i.decision.once_per_case_satisfied || noticeId !== null, timer: i.decision.timer, reason: i.decision.reason };
}
/** §1024.39(c)(2)(ii): after a discharge live contact never resumes; the written notice resumes if the borrower makes any partial or periodic payment — measured 45 days from the next due date, never with a payment request. */
export interface PostDischargeNotice { readonly applies: boolean; readonly reason: string | null; readonly timer: "REGX_1024_39C2_DISCHARGE_WRITTEN_NOTICE" | null; readonly next_due_date: PlainDate; readonly written_notice_due: PlainDate | null; readonly live_contact: "exempt_discharge"; readonly live_contact_due: null; readonly notice_code: typeof BK_EI_NOTICE; readonly payment_request: false; }
export function postDischargePayment(i: { discharge_on: PlainDate; reaffirmed: boolean; payment_received_on: PlainDate; payment_cents: Cents; delinquent: boolean; due_day?: number }): PostDischargeNotice {
  const due = nextDueDateAfter(i.payment_received_on, i.due_day ?? 1);
  const base: Omit<PostDischargeNotice, "applies" | "reason" | "timer" | "written_notice_due"> = { next_due_date: due, live_contact: "exempt_discharge", live_contact_due: null, notice_code: BK_EI_NOTICE, payment_request: false };
  if (i.payment_received_on < i.discharge_on) return { ...base, applies: false, reason: "payment before the discharge — the case rules apply", timer: null, written_notice_due: null };
  if (i.reaffirmed) return { ...base, applies: false, reason: "reaffirmed — 11.1/11.2 resume through REGX_1024_39C2_RESUME_GATE, not the discharge rule", timer: null, written_notice_due: null };
  if (i.payment_cents <= 0n) return { ...base, applies: false, reason: "no payment received", timer: null, written_notice_due: null };
  if (!i.delinquent) return { ...base, applies: false, reason: "loan is not delinquent", timer: null, written_notice_due: null };
  return { ...base, applies: true, reason: null, timer: "REGX_1024_39C2_DISCHARGE_WRITTEN_NOTICE", written_notice_due: addDays(due, NOTICE_DAYS) };
}
export const EI_DAYS = { live: LIVE_DAYS, notice: NOTICE_DAYS, bk_after_petition: BK_NOTICE_DAYS } as const;

// ------------------------------------------------------------ the event the §1024.39(c) rows arm on
/**
 * `bankruptcy.early_intervention.evaluated` — the rule-6 decision as bankruptcy-ops publishes it (bk.statement_mode.set). The platform's
 * petition, payment and dismissal events carry none of the §1024.39(c) facts the spec's trigger columns qualify them with (`regx_days_delinquent
 * > 0` at the petition, loss-mit available, no FDCPA cease; "after discharge (no reaffirmation) on a delinquent loan"; "next payment due date
 * after the event"), so the four early-intervention timers arm on this event: `{required=true, timer=<code>}` with the anchor the registry
 * row names carried in the payload — `petition_date` (REGX_1024_39C1_BK_WRITTEN_NOTICE_45, +45), `unpaid_due_date` (REGX_1024_39B_BK_LATER_
 * DELINQUENCY_45, +45 = the 45th day of delinquency), `next_due_date` (REGX_1024_39C2_DISCHARGE_WRITTEN_NOTICE, +45 per 11.2) and
 * `resume_from_due_date` (REGX_1024_39C2_RESUME_GATE, the `14.3.earlyInterventionResumeGate` facts). `payment_request` is always false.
 */
export const EI_EVENT = "bankruptcy.early_intervention.evaluated";
export type EiTrigger = "petition" | "later_delinquency" | "discharge_payment" | "resume";
export type EiInput =
  | { trigger: "petition"; petition_on: PlainDate; regx_days_delinquent_at_petition: number; lossmit_available: boolean; fdcpa_cease_on_file: boolean; prior_notice_this_case: boolean; attorney_of_record: boolean }
  | { trigger: "later_delinquency"; unpaid_due_date: PlainDate; once_per_case_satisfied: boolean; attorney_of_record: boolean }
  | { trigger: "discharge_payment"; discharge_on: PlainDate; reaffirmed: boolean; payment_received_on: PlainDate; payment_cents: Cents; delinquent: boolean; attorney_of_record: boolean; due_day?: number }
  | { trigger: "resume"; event_on: PlainDate; status: "dismissed" | "closed" | "reaffirmed"; debt_discharged: boolean; reaffirmed: boolean; due_day?: number };
export interface EiEvaluation { readonly decision: EiDecisionLike; readonly payload: Record<string, unknown> & { trigger: EiTrigger; required: boolean; timer: EiTimer | null; deadline: PlainDate | null; payment_request: false; notice_code: typeof BK_EI_NOTICE }; readonly writes_row: boolean; }
export function earlyInterventionEvaluation(i: EiInput): EiEvaluation {
  switch (i.trigger) {
    case "petition": {
      const d = earlyInterventionAtPetition(i);
      return { decision: d, writes_row: true, payload: { trigger: "petition", required: d.required, timer: d.timer, deadline: d.deadline, recipient: d.recipient, notice_code: d.notice_code, payment_request: false, live_contact: d.live_contact, once_per_case_satisfied: d.once_per_case_satisfied, reason: d.reason, petition_date: i.petition_on, regx_days_delinquent_at_petition: i.regx_days_delinquent_at_petition, lossmit_available: i.lossmit_available, fdcpa_cease: i.fdcpa_cease_on_file } };
    }
    case "later_delinquency": {
      const d = laterDelinquencyDuringCase(i);
      return { decision: d, writes_row: true, payload: { trigger: "later_delinquency", required: d.required, timer: d.timer, deadline: d.deadline, recipient: d.recipient, notice_code: d.notice_code, payment_request: false, live_contact: d.live_contact, once_per_case_satisfied: d.once_per_case_satisfied, reason: d.reason, unpaid_due_date: i.unpaid_due_date, during_bankruptcy: true, prior_notice_this_case: i.once_per_case_satisfied } };
    }
    case "discharge_payment": {
      const p = postDischargePayment(i);
      const d: EiDecisionLike = { required: p.applies, deadline: p.written_notice_due, recipient: i.attorney_of_record ? "counsel" : "borrower", timer: p.timer, reason: p.reason, once_per_case_satisfied: false };
      return { decision: d, writes_row: true, payload: { trigger: "discharge_payment", required: p.applies, timer: p.timer, deadline: p.written_notice_due, recipient: d.recipient, notice_code: p.notice_code, payment_request: false, live_contact: p.live_contact, live_contact_due: null, reason: p.reason, next_due_date: p.next_due_date, payment_received_on: i.payment_received_on, payment_cents: i.payment_cents.toString(), discharge_date: i.discharge_on, debt_discharged: true, reaffirmed: i.reaffirmed, delinquent: i.delinquent, after_discharge: i.payment_received_on >= i.discharge_on } };
    }
    case "resume": {
      const r = earlyInterventionResume(i.event_on, i.due_day ?? 1);
      const neverResumes = i.debt_discharged && !i.reaffirmed;
      const d: EiDecisionLike = { required: !neverResumes, deadline: null, recipient: "borrower", timer: neverResumes ? null : r.gate, reason: neverResumes ? "discharged without reaffirmation: live contact never resumes; the written notice re-arms only on a payment (§1024.39(c)(2)(ii))" : null, once_per_case_satisfied: false };
      return { decision: d, writes_row: false, payload: { trigger: "resume", required: d.required, timer: d.timer, deadline: null, recipient: "borrower", notice_code: BK_EI_NOTICE, payment_request: false, reason: d.reason, status: i.status, event_on: i.event_on, resume_from_due_date: r.resume_from_due_date, live_contact_due: neverResumes ? null : r.live_contact_due, written_notice_due: neverResumes ? null : r.written_notice_due, debt_discharged: i.debt_discharged, reaffirmed: i.reaffirmed } };
    }
  }
}

// ------------------------------------------------------------ the event REGZ_1026_41E5II_RESUME_NEXT_CYCLE arms on
/**
 * `bankruptcy.statement_resumption.scheduled` — an exemption ending: the written request for statements (requests.classify, at receipt) or the
 * reaffirmation / plan amended to pay / payment after a surrender SOI / dismissal recorded by bk.statement_mode.set. The payload carries the
 * cycle the (e)(5)(iv)(B) single-statement exemption may skip and the statement that must go out (`resume_statement_due_by`, the timer's
 * anchor; T5: request 2027-03-03 → skippable statement due by 2027-03-20, resumed statement due by 2027-04-20). Null when `mode_before` is
 * not an exemption — nothing resumes on a loan whose statements never stopped.
 */
export const RESUMPTION_EVENT = "bankruptcy.statement_resumption.scheduled";
export type ResumptionBasis = "written_request" | "reaffirmation" | "plan_amended_to_pay" | "payment_after_soi_surrender" | "dismissal" | "revived_case";
export function statementResumption(i: { basis: ResumptionBasis; event_on: PlainDate; mode_before: StatementMode; mode_after: StatementMode; rendered_for_open_cycle: boolean; due_day?: number }): (Record<string, unknown> & { basis: ResumptionBasis; resume_statement_due_by: PlainDate; skippable_statement_due_by: PlainDate | null }) | null {
  if (!isExempt(i.mode_before) || isExempt(i.mode_after)) return null;
  const t = transitionAfterEvent({ event_on: i.event_on, mode_before: i.mode_before, mode_after: i.mode_after, rendered_for_open_cycle: i.rendered_for_open_cycle, due_day: i.due_day ?? 1 });
  return { basis: i.basis, event_on: i.event_on, mode_before: i.mode_before, mode_after: i.mode_after, decision: t.decision, skippable_statement_due_by: t.skipped_cycle?.statement_due_by ?? null, skipped_cycle_due_date: t.skipped_cycle?.due_date ?? null, resume_statement_due_by: t.resumes_with.statement_due_by, resumes_with_due_date: t.resumes_with.due_date, resumes_with_amount_due_date: t.resumes_with.amount_due_date, template: statementTemplateFor(t.resume_mode), basis_text: t.basis };
}

// ============================================================ rule 7 — communications matrix, versioned rule table (T12)
export type CommsMode = "stay_in_effect" | "stay_relief_granted" | "discharged_no_reaffirm" | "dismissed" | "codebtor_protected";
export type CommsAction = "send" | "send_modified" | "send_via_counsel" | "suppress";
export interface MatrixRow { readonly version: string; readonly communication_code: string; readonly mode: CommsMode; readonly action: CommsAction; readonly legend_required: boolean; readonly citation: string; readonly classified: boolean; }
export const COMMUNICATIONS_MATRIX_VERSION = "14.3.communications_matrix.2026-09";
const STAY_CITE = "11 U.S.C. §362(a)(6); Fannie Mae E-2.1-03 (suspend any and all debt collection efforts); D2-2-03 (payment reminders are collection communications)";
const DISCHARGE_CITE = "11 U.S.C. §524(a)(2), §524(j); comment 41(f)-1";
const INFO_CITE = "12 CFR 1026.41(f); 12 CFR 1024.39(c); Fannie Mae E-2.1-09; A4-2.1-04 (channels as permitted by law)";
const RESUME_CITE = "12 CFR 1024.39(c)(2)(i); comment 41(e)(5)(iv)(A)-2 — full resumption after the next payment due date that follows the dismissal";
const COLLECTION = ["D2_2_03_PAYMENT_REMINDER", "COLLECTION_CALL", "COLLECTION_TEXT", "COLLECTION_EMAIL", "BREACH_LETTER", "ACCELERATION_LETTER", "LATE_CHARGE_NOTICE", "FORECLOSURE_NOTICE", "DEBT_VALIDATION_FOLLOWUP", "AUTODRAFT_SOLICITATION"] as const;
const INFORMATIONAL = ["PERIODIC_STATEMENT", "ESCROW_STATEMENT", "ARM_NOTICE", "PRIVACY_NOTICE", "INSURANCE_FPI_NOTICE", "PMI_NOTICE", "FORM_1098", "PAYOFF_REINSTATEMENT_ON_REQUEST", "NOE_RFI_RESPONSE", "SCRA_NOTICE", "EARLY_INTERVENTION_BK", "LOSSMIT_VIA_COUNSEL", "BK_PAYMENT_INSTRUCTIONS"] as const;
const DISCHARGE_ONLY = ["BREACH_LETTER_IN_REM", "PROPERTY_INSPECTION_CONTACT"] as const;
const VIA_COUNSEL = new Set<string>(["NOE_RFI_RESPONSE", "PAYOFF_REINSTATEMENT_ON_REQUEST", "LOSSMIT_VIA_COUNSEL"]);
const LEGEND = new Set<string>(["PERIODIC_STATEMENT", "ESCROW_STATEMENT", "INSURANCE_FPI_NOTICE", "EARLY_INTERVENTION_BK", ...DISCHARGE_ONLY]);
const MODES: readonly CommsMode[] = ["stay_in_effect", "stay_relief_granted", "discharged_no_reaffirm", "dismissed", "codebtor_protected"];
function classify(code: string, mode: CommsMode): Omit<MatrixRow, "version" | "classified"> | null {
  const collection = (COLLECTION as readonly string[]).includes(code), informational = (INFORMATIONAL as readonly string[]).includes(code), dischargeOnly = (DISCHARGE_ONLY as readonly string[]).includes(code);
  if (!collection && !informational && !dischargeOnly) return null;
  const modified: CommsAction = code === "PERIODIC_STATEMENT" ? "send_modified" : VIA_COUNSEL.has(code) ? "send_via_counsel" : "send";
  const row = (action: CommsAction, legend_required: boolean, citation: string): Omit<MatrixRow, "version" | "classified"> => ({ communication_code: code, mode, action, legend_required, citation });
  switch (mode) {
    case "stay_in_effect": return collection ? row("suppress", false, STAY_CITE) : dischargeOnly ? row("suppress", false, `${STAY_CITE} — in rem breach/inspection contacts only after discharge or relief`) : row(modified, LEGEND.has(code), INFO_CITE);
    case "stay_relief_granted":
      if (code === "FORECLOSURE_NOTICE") return row("send", false, "11 U.S.C. §362(d) relief order — in rem; 14.3-Q3 (statements continue modified)");
      return collection ? row("suppress", false, STAY_CITE) : dischargeOnly ? row("send_modified", true, "11 U.S.C. §362(d) relief order — in rem only; discharge legend where discharged") : row(modified, LEGEND.has(code), "12 CFR 1026.41(e)(5)/(f); 14.3-Q3");
    case "discharged_no_reaffirm":
      if (dischargeOnly) return row("send_modified", true, `${DISCHARGE_CITE}; Fannie Mae E-2.2-01 informational breach letter`);
      return collection ? row("suppress", false, `${DISCHARGE_CITE} — no personal-liability demands`) : row(modified, true, `${DISCHARGE_CITE} (payments and statements permitted in the ordinary course)`);
    case "dismissed": return row("send", false, RESUME_CITE);
    case "codebtor_protected": return collection ? row("suppress", false, "11 U.S.C. §1301(a) co-debtor stay") : row(informational ? modified : "send_modified", true, "11 U.S.C. §1301(a); comment 41(f)(4)-1 — informational statements permitted");
  }
}
/** Every row of the current matrix version — the seed for the `communications_matrix` table (PK version × code × mode). */
export function communicationsMatrixRows(): readonly MatrixRow[] {
  const out: MatrixRow[] = [];
  for (const code of [...COLLECTION, ...INFORMATIONAL, ...DISCHARGE_ONLY]) for (const mode of MODES) { const r = classify(code, mode); if (r) out.push({ version: COMMUNICATIONS_MATRIX_VERSION, classified: true, ...r }); }
  return out;
}
/**
 * Look a communication up in the matrix. Fails closed: a code the matrix does not classify is suppressed while any bankruptcy mode other than a
 * completed dismissal applies (E-2.1-03 "any and all debt collection efforts"). `dismissed` resumes collection communications only after the
 * next payment due date that follows the dismissal (§1024.39(c)(2)(i)) — pass `triggered_on` and `resume_from_due_date` to apply the gate.
 */
export function communicationsMatrix(code: string, mode: CommsMode, opts: { triggered_on?: PlainDate; resume_from_due_date?: PlainDate | null } = {}): MatrixRow {
  const r = classify(code, mode);
  if (mode === "dismissed") {
    const gated = opts.resume_from_due_date !== undefined && opts.resume_from_due_date !== null && opts.triggered_on !== undefined && opts.triggered_on <= opts.resume_from_due_date;
    const informational = (INFORMATIONAL as readonly string[]).includes(code);
    if (gated && !informational) return { version: COMMUNICATIONS_MATRIX_VERSION, communication_code: code, mode, action: "suppress", legend_required: false, citation: `${RESUME_CITE} (${opts.resume_from_due_date})`, classified: r !== null };
    return { version: COMMUNICATIONS_MATRIX_VERSION, communication_code: code, mode, action: "send", legend_required: false, citation: RESUME_CITE, classified: r !== null };
  }
  if (!r) return { version: COMMUNICATIONS_MATRIX_VERSION, communication_code: code, mode, action: "suppress", legend_required: false, citation: `unclassified communication code — suppressed until classified in communications_matrix (${STAY_CITE})`, classified: false };
  return { version: COMMUNICATIONS_MATRIX_VERSION, classified: true, ...r };
}
/** A reminder/collection trigger on a loan whose matrix row says suppress: nothing is sent and the suppression is recorded with the citation and matrix version. */
export function suppressCommunication(i: { communication_code: string; mode: CommsMode; triggered_on: PlainDate; loan_id: string; resume_from_due_date?: PlainDate | null }): { sent: boolean; row: MatrixRow; suppression: { loan_id: string; communication_code: string; mode: CommsMode; action: "suppress"; citation: string; matrix_version: string; recorded_on: PlainDate } | null } {
  const row = communicationsMatrix(i.communication_code, i.mode, { triggered_on: i.triggered_on, resume_from_due_date: i.resume_from_due_date ?? null });
  if (row.action !== "suppress") return { sent: true, row, suppression: null };
  return { sent: false, row, suppression: { loan_id: i.loan_id, communication_code: i.communication_code, mode: i.mode, action: "suppress", citation: row.citation, matrix_version: row.version, recorded_on: i.triggered_on } };
}

// ============================================================ guardrails behind bk.statement_mode.set
/** No exemption without a linked evidence document; no `standard` while any consumer is a debtor or discharged unless reaffirmed and the rescission window lapsed; never suppressed for returned mail. */
export function statementModeGuard(i: { mode: StatementMode; basis_document_id: string | null; debtor_or_discharged: boolean; reaffirmed: boolean; rescission_window_lapsed: boolean; reason?: string | null }): { allowed: boolean; refusal: string | null } {
  if (isExempt(i.mode) && !i.basis_document_id) return { allowed: false, refusal: "no exemption without a linked evidence document (written request image, plan, order or statement of intention)" };
  if (i.reason === "returned_mail") return { allowed: false, refusal: "statements are never suppressed for returned mail — address research (4.x) instead" };
  if (i.mode === "standard" && i.debtor_or_discharged && !(i.reaffirmed && i.rescission_window_lapsed)) return { allowed: false, refusal: "no `standard` variant while any consumer is a debtor or discharged (unless reaffirmed and the §524(c)(4) window lapsed)" };
  return { allowed: true, refusal: null };
}
/** requests.classify: a cease request is never inferred from a phone call; an authenticated portal message counts as writing; below 0.90 a human verifies. */
export function classifyRequest(i: { channel: RequestChannel; kind: "cease" | "resume" | "other"; confidence: number; from: RequestFrom; at_exclusive_address: boolean }): { kind: "cease" | "resume" | "other"; in_writing: boolean; effective: boolean; human_verification: boolean; refusal: string | null; logged_off_address: boolean } {
  const writing = i.channel !== "phone";
  if (!writing && i.kind !== "other") return { kind: i.kind, in_writing: false, effective: false, human_verification: false, refusal: "a cease/resume request is never inferred from a phone call — answer with instructions for a written request (§1026.41(e)(5)(i)(B)(1), (ii))", logged_off_address: false };
  const verify = i.confidence < 0.9;
  return { kind: i.kind, in_writing: writing, effective: writing && !verify && i.kind !== "other", human_verification: verify, refusal: null, logged_off_address: writing && !i.at_exclusive_address && i.from !== "counsel" };
}
