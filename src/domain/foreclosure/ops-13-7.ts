/**
 * §13.7 Environmental hazard / non-routine litigation — the operating rules over the pure calculators in
 * ./litigation.ts and ./ops.ts, each validating the inbound record and returning the events the process appends
 * (the §14.1 `EmittedEvent` pattern: the tool handlers in src/app/tools/section13-7.ts append them, never a bare
 * literal). Every event a 13.7 registry row is armed or satisfied by comes from here:
 *
 *   litigation.notice.received{source, notice_received_at, classification, exception_category, environmental}
 *     — rule 3: "receiving notice" is the earliest of service on the partner/Supermortgage, firm notice or docket
 *       alert; the 2-BD Form 20 clock (E-1.3-02) runs from it, the environmental-litigation clock the same day
 *       (F-1-08 "immediately"); a standing/MERS/HAMP matter reports only on its trigger (E-1.3-02 exception).
 *   litigation.matter.opened{classification, category} / litigation.hold.opened{code=LITIGATION_HOLD, steps}
 *     — rule 4: enforceability/standing/priority attacks or an injunction hold judgment_motion + sale_conduct;
 *       damages-only counterclaims do not (status 33 for delay credit).
 *   litigation.classification.confirmed{classification} — rule 1: confidence < 0.8 or any damages claim ⇒ the
 *       `attorney` confirms before "routine" is accepted (over-reporting has no penalty).
 *   litigation.trigger{matter, event, trigger_on} — rule 2: summary judgment sought, briefing required, expected at
 *       trial ⇒ the 2-BD clock runs from the trigger (policy: same clock).
 *   form20.submitted{kind, environmental, channel, outage_note} / form20.portal_filed / form20.responded
 *     — Integrations: quatro is the portal; when it is unavailable the package goes to Legal by email with the
 *       outage note "immediately" and is filed on the portal when restored (both timestamps kept; 13.7-T8).
 *   litigation.status_update.sent — E-1.3-01 "periodically update Fannie Mae" (monthly, policy).
 *   litigation.pleading.due{filing_deadline} / .draft_sent / .review.closed{result} — E-1.3-01 "sufficient
 *       opportunity in advance of any deadline": ≥5 servicer business days (policy; 13.7-T7).
 *   litigation.removal_or_appeal.proposed{kind} / litigation.approval.requested / litigation.approval.granted{kind}
 *     — E-1.3-01 prior written approval before removal on the Charter or any appeal (13.7-T6).
 *   litigation.counsel.notified{kind=workout_notice} / litigation.counsel.acknowledged{kind=workout_notice}
 *     — E-1.3-01: counsel notified of a deferral/modification proposal with sufficient opportunity (13.7-T9).
 *   environmental.hazard.suspected / .confirmed{kind, referred, referral_on} / .cleared / .direction.received
 *     — F-1-08: "must not begin foreclosure proceedings" on a hazard; report to the Servicing Representative;
 *       lead-paint notification within 30 days after referral with value, debt, children under 8, documentation.
 *   fnma.servicing_rep.notified{kind=environmental_hazard|lead_paint} + environmental.report.sent /
 *       lead_paint.notification.sent — the F-4-02 Servicing Representative channel.
 */
import { type PlainDate, addDays, min as minDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { classify, form20Due, motionDraftDue, type Category } from "./litigation.ts";
import { litigationIntake, form20ExceptionTrigger, environmentalHazard, leadPaintNotification, pleadingReviewGate, appealFilingGate, workoutCounselGate, ENVIRONMENTAL_REPORT_ELEMENTS, LEAD_PAINT_ELEMENTS, type Escalation } from "./ops.ts";

export const RULE_SET_VERSION_13_7 = "13.7@E-1.3-01(10/11/2023)+E-1.3-02(05/10/2023)+F-1-08(05/10/2023)";
export interface EmittedEvent { readonly type: string; readonly payload: Record<string, unknown>; readonly occurred_at?: string; }
export type NoticeSource = "service_of_process" | "firm" | "docket" | "complaint" | "regulator";
export const NOTICE_SOURCES: readonly NoticeSource[] = ["service_of_process", "firm", "docket", "complaint", "regulator"];
export type ExceptionCategory = "standing" | "mers" | "hamp" | "none";
export type ExceptionEvent = "answer" | "summary_judgment_motion" | "briefing" | "trial";
export type Form20Kind = "non_routine_litigation" | "environmental_litigation" | "method_deviation" | "other_escalation";
export const FORM20_KINDS: readonly Form20Kind[] = ["non_routine_litigation", "environmental_litigation", "method_deviation", "other_escalation"];
export type FnmaDirection = "proceed" | "hold" | "charge_off" | "deed_in_lieu" | "other";
export const FNMA_DIRECTIONS: readonly FnmaDirection[] = ["proceed", "hold", "charge_off", "deed_in_lieu", "other"];
export type HazardKind = "lead_paint" | "asbestos" | "contamination" | "meth_lab" | "underground_tank" | "flood_mold" | "other";
export const HAZARD_KINDS: readonly HazardKind[] = ["lead_paint", "asbestos", "contamination", "meth_lab", "underground_tank", "flood_mold", "other"];
export type HazardSource = "inspection" | "code_violation" | "borrower" | "firm" | "disaster";
export const HAZARD_SOURCES: readonly HazardSource[] = ["inspection", "code_violation", "borrower", "firm", "disaster"];
export const LITIGATION_HOLD_STEPS = ["judgment_motion", "sale_conduct"] as const;
/** Policy (13.7 open question 2): the draft reaches Fannie Mae ≥5 servicer business days before the filing deadline. */
export const PLEADING_REVIEW_LEAD_BD = 5;
/** Policy: counsel gets 5 BD on a workout proposal (13.7 timer table `FNMA_E1301_WORKOUT_NOTIFY_COUNSEL_GATE`). */
export const WORKOUT_COUNSEL_LEAD_BD = 5;

const nonEmpty = (v: unknown, what: string): string => { if (typeof v !== "string" || v.trim() === "") throw new RangeError(`${what} is required`); return v; };
const oneOf = <T extends string>(v: unknown, set: readonly T[], what: string): T => { if (!set.includes(v as T)) throw new RangeError(`${what} must be one of ${set.join(", ")}`); return v as T; };
const isDate = (v: unknown): v is PlainDate => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const roleOf = (by: { kind: string; role?: string } | null | undefined): string | null => (by && by.kind === "human" && by.role ? by.role : null);
const requireRole = (by: { kind: string; id: string; role?: string } | null | undefined, roles: readonly string[], what: string): string => {
  const r = roleOf(by); if (!r || !roles.includes(r)) throw new RangeError(`${what} is recorded by ${roles.join("/")}, not ${by ? `${by.kind}:${by.id}${by.role ? ` (${by.role})` : ""}` : "nobody"}`); return r;
};
/** Servicer business days from `from` (exclusive) to `to` (inclusive) — how long Fannie Mae has a draft before the deadline. */
export function servicerBusinessDaysBetween(from: PlainDate, to: PlainDate): number {
  if (to <= from) return 0;
  let n = 0; for (let d = addDays(from, 1); d <= to; d = addDays(d, 1)) if (servicer.isBusinessDay(d)) n++;
  return n;
}

// ============================================================ intake and classification (rules 1–4)
export interface Claims { readonly damages_against_fnma?: boolean; readonly attacks_validity_priority_enforceability?: boolean; readonly enumerated_risk?: boolean; readonly damages_claim?: boolean; readonly seeks_injunction?: boolean; readonly damages_only?: boolean; readonly environmental?: boolean; readonly putative_class?: boolean; }
/** Rule 3: "receiving notice" = earliest of service on the partner/Supermortgage, firm notice, or docket alert. */
export function noticeReceivedOn(i: { served_on?: PlainDate | null; firm_notice_on?: PlainDate | null; docket_alert_on?: PlainDate | null }): PlainDate {
  const ds = [i.served_on, i.firm_notice_on, i.docket_alert_on].filter(isDate);
  if (!ds.length) throw new RangeError("a notice date is required: served_on, firm_notice_on or docket_alert_on (13.7 rule 3)");
  return minDate(...ds);
}
export interface IntakeResult {
  readonly matter_id: string; readonly notice_received_at: PlainDate; readonly classification: "non_routine" | "routine" | "attorney_confirmation_required"; readonly category: Category; readonly exception_category: ExceptionCategory; readonly environmental: boolean;
  readonly form20: { required: boolean; deferred_to_trigger: boolean; due: PlainDate | null; task_due: PlainDate | null; kind: Form20Kind };
  readonly hold: { code: "LITIGATION_HOLD"; steps: readonly ["judgment_motion", "sale_conduct"]; opened_on: PlainDate } | null;
  readonly status_code: "33"; readonly events: EmittedEvent[]; readonly escalations: Escalation[]; readonly row: Record<string, unknown>; readonly decision: { rationale: string; confidence: number };
}
/**
 * Rules 1–4 on an inbound notice: the earliest receipt date, rules+model classification (E-1.3-01 categories; a
 * putative class or environmental litigation is an enumerated risk), the E-1.3-02 exception categories (Form 20 only on
 * the trigger), the 2-BD Form 20 clock and portal task, and the LITIGATION_HOLD on judgment/sale.
 */
export function litigationNoticeIntake(i: { matter_id: string; loan_id: string; source: NoticeSource; served_on?: PlainDate | null; firm_notice_on?: PlainDate | null; docket_alert_on?: PlainDate | null; documents?: readonly string[]; claims: Claims; confidence: number; exception_category?: ExceptionCategory; court?: string; docket_no?: string; caption?: string; counsel_firm_id?: string | null }): IntakeResult {
  nonEmpty(i.matter_id, "matter_id"); nonEmpty(i.loan_id, "loan_id"); oneOf(i.source, NOTICE_SOURCES, "source");
  if (!Number.isFinite(i.confidence) || i.confidence < 0 || i.confidence > 1) throw new RangeError("confidence is 0..1");
  const on = noticeReceivedOn(i); const environmental = i.claims.environmental === true; const exception = i.exception_category ?? "none"; oneOf(exception, ["standing", "mers", "hamp", "none"], "exception_category");
  const r = litigationIntake({ served_on: on, damages_against_fnma: i.claims.damages_against_fnma === true, attacks_validity_priority_enforceability: i.claims.attacks_validity_priority_enforceability === true, enumerated_risk: i.claims.enumerated_risk === true || environmental || i.claims.putative_class === true, damages_claim: i.claims.damages_claim === true, confidence: i.confidence, seeks_injunction: i.claims.seeks_injunction === true, damages_only: i.claims.damages_only === true });
  const deferred = r.classification === "non_routine" && exception !== "none";   // E-1.3-02: standing/MERS/HAMP report only on the trigger
  const required = r.form20.required && !deferred;
  const due = required ? (environmental ? on : r.form20.due) : null;   // F-1-08: environmental litigation "immediately" (same day)
  const taskDue = required ? (environmental ? on : minDate(addBusinessDays(on, 1, servicer), r.form20.due)) : null;   // portal task due 1 BD after the package is ready
  const kind: Form20Kind = environmental ? "environmental_litigation" : "non_routine_litigation";
  const events: EmittedEvent[] = [
    { type: "litigation.notice.received", payload: { matter_id: i.matter_id, loan_id: i.loan_id, source: i.source, documents: [...(i.documents ?? [])], notice_received_at: on, served_on: i.served_on ?? null, firm_notice_on: i.firm_notice_on ?? null, docket_alert_on: i.docket_alert_on ?? null, classification: r.classification, category: r.category, exception_category: exception, environmental, form20_required: required, form20_due: due } },
    { type: "litigation.matter.opened", payload: { matter_id: i.matter_id, loan_id: i.loan_id, classification: r.classification, category: r.category, exception_category: exception, environmental, status_code: r.status_code, opened_on: on } },
  ];
  if (r.hold) events.push({ type: "litigation.hold.opened", payload: { code: "LITIGATION_HOLD", matter_id: i.matter_id, loan_id: i.loan_id, steps: [...LITIGATION_HOLD_STEPS], opened_on: on, reason: `${r.classification} category ${r.category}${i.claims.seeks_injunction ? ", injunction sought" : ""} — judgment/sale wait for Fannie Mae direction (13.7 rule 4)` } });
  const escalations: Escalation[] = [];
  if (required) escalations.push({ kind: "fnma_portal_operator", reason: `Form 20 (${kind}) on quatro.fanniemae.com by ${due} — task due ${taskDue} (E-1.3-02${environmental ? "; F-1-08 immediately" : ""})` });
  escalations.push(r.escalation ?? { kind: "attorney", reason: `classification confirmation: ${r.classification}${r.category ? ` category ${r.category}` : ""} (confidence ${i.confidence})` });
  const row = { matter_id: i.matter_id, loan_id: i.loan_id, court: i.court ?? null, docket_no: i.docket_no ?? null, caption: i.caption ?? null, source: i.source, served_at: i.served_on ?? null, notice_received_at: on, classification: r.classification, category: r.category, categories: r.category ? [`category_${r.category}`] : [], exception_category: exception, exception_trigger: "none", environmental, form20_required: required, form20_due_at: due, form20_submission_id: null, fnma_direction: null, counsel_firm_id: i.counsel_firm_id ?? null, status_code: r.status_code, hold: r.hold ? r.hold.code : null, status: "open", privileged: true, confidence: i.confidence };
  const rationale = `${r.classification}${r.category ? ` (category ${r.category})` : ""}; notice received ${on} (earliest of service/firm/docket); ${required ? `Form 20 by ${due}` : deferred ? `E-1.3-02 ${exception} exception — Form 20 on the trigger` : "no Form 20"}; ${r.hold ? "LITIGATION_HOLD on judgment_motion/sale_conduct" : "no hold"}`;
  return { matter_id: i.matter_id, notice_received_at: on, classification: r.classification, category: r.category, exception_category: exception, environmental, form20: { required, deferred_to_trigger: deferred, due, task_due: taskDue, kind }, hold: r.hold, status_code: r.status_code, events, escalations, row, decision: { rationale, confidence: i.confidence } };
}

/** Rule 1: the attorney confirms a classification; "routine" is accepted only from the attorney; a routine confirmation ends the conservative 2-BD clock. */
export function classificationConfirmed(i: { matter_id: string; loan_id: string; classification: "routine" | "non_routine"; category?: Category; confirmed_by: { kind: string; id: string; role?: string }; confirmed_on: PlainDate; notice_received_at: PlainDate }): { classification: "routine" | "non_routine"; category: Category; form20_due: PlainDate | null; cancel_form20_clock: boolean; events: EmittedEvent[]; row: Record<string, unknown> } {
  nonEmpty(i.matter_id, "matter_id"); nonEmpty(i.loan_id, "loan_id"); oneOf(i.classification, ["routine", "non_routine"], "classification");
  requireRole(i.confirmed_by, ["attorney"], "classification confirmation (13.7 rule 1: attorney confirmation required before \"routine\" is accepted)");
  const category = i.classification === "non_routine" ? (i.category ?? 3) : null; const due = i.classification === "non_routine" ? form20Due(i.notice_received_at) : null;
  return { classification: i.classification, category, form20_due: due, cancel_form20_clock: i.classification === "routine",
    events: [{ type: "litigation.classification.confirmed", payload: { matter_id: i.matter_id, loan_id: i.loan_id, classification: i.classification, category, confirmed_by: `${i.confirmed_by.kind}:${i.confirmed_by.id}`, confirmed_on: i.confirmed_on, form20_due: due } }],
    row: { classification: i.classification, category, form20_required: i.classification === "non_routine", form20_due_at: due, confirmed_by_role: "attorney", confirmed_on: i.confirmed_on } };
}

/** Rule 2 / E-1.3-02: a standing/MERS/HAMP matter files Form 20 only when summary judgment is sought, briefing is required or the issue is expected at trial — within 2 BD of the trigger. An answer alone is no trigger. */
export function exceptionTriggerDetected(i: { matter_id: string; loan_id: string; matter: "standing" | "mers" | "hamp"; event: ExceptionEvent; on: PlainDate; source?: "docket" | "firm" }): { form20_required: boolean; due: PlainDate | null; timer: "FNMA_E1302_FORM20_EXCEPTION_TRIGGER" | null; events: EmittedEvent[]; escalations: Escalation[]; row: Record<string, unknown> } {
  nonEmpty(i.matter_id, "matter_id"); nonEmpty(i.loan_id, "loan_id"); oneOf(i.matter, ["standing", "mers", "hamp"], "matter"); oneOf(i.event, ["answer", "summary_judgment_motion", "briefing", "trial"], "event");
  if (!isDate(i.on)) throw new RangeError("on is a date");
  const t = form20ExceptionTrigger({ matter: i.matter, event: i.event, on: i.on });
  const events: EmittedEvent[] = t.form20_required ? [{ type: "litigation.trigger", payload: { matter_id: i.matter_id, loan_id: i.loan_id, matter: i.matter, event: i.event, trigger_on: i.on, source: i.source ?? "docket", form20_due: t.due } }] : [];
  const stage = i.event === "summary_judgment_motion" ? "summary_judgment" : i.event === "answer" ? "none" : i.event;
  return { ...t, events, escalations: t.form20_required ? [{ kind: "fnma_portal_operator", reason: `Form 20 for the ${i.matter} matter on the ${i.event} trigger — by ${t.due} (E-1.3-02)` }] : [], row: { exception_trigger: stage, form20_required: t.form20_required, form20_due_at: t.due } };
}

// ============================================================ Form 20 (quatro / Legal email), direction, status updates
/** The portal operator records the Form 20 submission — on quatro with its reference, or by email to Legal with the outage note when quatro is down (Integrations: failure mode). */
export function form20Submission(i: { submission_id: string; matter_id: string | null; loan_id: string; kind: Form20Kind; environmental?: boolean; package_document_id: string; submitted_at: string; submitted_by: { kind: string; id: string; role?: string }; channel: "quatro" | "email"; quatro_reference?: string | null; outage_note?: boolean; notice_received_at?: PlainDate | null; form20_due?: PlainDate | null }): { submitted_on: PlainDate; due: PlainDate | null; on_time: boolean | null; events: EmittedEvent[]; row: Record<string, unknown> } {
  nonEmpty(i.submission_id, "submission_id"); nonEmpty(i.loan_id, "loan_id"); oneOf(i.kind, FORM20_KINDS, "kind"); nonEmpty(i.package_document_id, "package_document_id"); oneOf(i.channel, ["quatro", "email"], "channel");
  if (!/^\d{4}-\d{2}-\d{2}T/.test(i.submitted_at)) throw new RangeError("submitted_at is an ISO timestamp");
  requireRole(i.submitted_by, ["fnma_portal_operator", "officer"], "Form 20 filing (13.7: quatro filing is a fnma_portal_operator task)");
  if (i.channel === "quatro" && !i.quatro_reference) throw new RangeError("a quatro submission carries its quatro_reference");
  if (i.channel === "email" && i.outage_note !== true) throw new RangeError("email to Legal is the quatro-outage fallback only: outage_note is required (13.7 Integrations failure mode)");
  const environmental = i.environmental === true || i.kind === "environmental_litigation";
  const on = i.submitted_at.slice(0, 10) as PlainDate; const due = i.form20_due ?? (i.notice_received_at ? (environmental ? i.notice_received_at : form20Due(i.notice_received_at)) : null);
  const payload = { submission_id: i.submission_id, matter_id: i.matter_id, loan_id: i.loan_id, kind: i.kind, environmental, submitted_on: on, submitted_at: i.submitted_at, submitted_by: `${i.submitted_by.kind}:${i.submitted_by.id}`, channel: i.channel, quatro_reference: i.quatro_reference ?? null, outage_note: i.outage_note === true, package_document_id: i.package_document_id, due, on_time: due ? on <= due : null };
  return { submitted_on: on, due, on_time: due ? on <= due : null,
    events: [{ type: "form20.prepared", payload: { submission_id: i.submission_id, matter_id: i.matter_id, loan_id: i.loan_id, kind: i.kind, package_document_id: i.package_document_id } }, { type: "form20.submitted", occurred_at: i.submitted_at, payload }],
    row: { id: i.submission_id, matter_id: i.matter_id, loan_id: i.loan_id, kind: i.kind, environmental, prepared_at: i.submitted_at, package_document_id: i.package_document_id, submitted_at: i.submitted_at, submitted_by: payload.submitted_by, channel: i.channel, quatro_reference: i.quatro_reference ?? null, ...(i.channel === "email" ? { emailed_at: i.submitted_at, outage_note: true, portal_filed_at: null } : { portal_filed_at: i.submitted_at }), fnma_response: null, responded_at: null } };
}
/** The portal filing completed when quatro is restored — the email timestamp stays on the row next to the portal one (13.7-T8). */
export function form20PortalFiled(i: { submission_id: string; matter_id: string | null; loan_id: string; filed_at: string; quatro_reference: string; emailed_at: string }): { events: EmittedEvent[]; row: Record<string, unknown>; timestamps: { email: string; portal: string } } {
  nonEmpty(i.submission_id, "submission_id"); nonEmpty(i.quatro_reference, "quatro_reference"); nonEmpty(i.emailed_at, "emailed_at");
  if (!/^\d{4}-\d{2}-\d{2}T/.test(i.filed_at) || i.filed_at < i.emailed_at) throw new RangeError("filed_at is an ISO timestamp on or after the outage email");
  return { events: [{ type: "form20.portal_filed", occurred_at: i.filed_at, payload: { submission_id: i.submission_id, matter_id: i.matter_id, loan_id: i.loan_id, quatro_reference: i.quatro_reference, emailed_at: i.emailed_at, portal_filed_at: i.filed_at } }], row: { portal_filed_at: i.filed_at, quatro_reference: i.quatro_reference }, timestamps: { email: i.emailed_at, portal: i.filed_at } };
}
/** Fannie Mae's direction on a Form 20 — recorded with its document; a direction to proceed releases the LITIGATION_HOLD only over the officer's acknowledgment (the servicer of record's). */
export function form20Response(i: { submission_id: string; matter_id: string | null; loan_id: string; direction: FnmaDirection | "approved" | "denied"; response_document_id: string; responded_at: string; recorded_by: { kind: string; id: string; role?: string }; hold_open: boolean }): { hold_released: boolean; events: EmittedEvent[]; row: Record<string, unknown>; matter: Record<string, unknown>; escalations: Escalation[] } {
  nonEmpty(i.submission_id, "submission_id"); nonEmpty(i.loan_id, "loan_id"); nonEmpty(i.response_document_id, "response_document_id"); oneOf(i.direction, [...FNMA_DIRECTIONS, "approved", "denied"], "direction");
  const role = roleOf(i.recorded_by); const releases = i.hold_open && (i.direction === "proceed" || i.direction === "approved");
  const released = releases && role === "officer";
  const events: EmittedEvent[] = [{ type: "form20.responded", occurred_at: i.responded_at, payload: { submission_id: i.submission_id, matter_id: i.matter_id, loan_id: i.loan_id, direction: i.direction, response_document_id: i.response_document_id, responded_at: i.responded_at } }];
  if (released) events.push({ type: "litigation.hold.released", occurred_at: i.responded_at, payload: { code: "LITIGATION_HOLD", matter_id: i.matter_id, loan_id: i.loan_id, direction: i.direction, acknowledged_by: `${i.recorded_by.kind}:${i.recorded_by.id}` } });
  return { hold_released: released, events, row: { fnma_response: i.direction, responded_at: i.responded_at, response_document_id: i.response_document_id }, matter: { fnma_direction: i.direction, fnma_direction_document_id: i.response_document_id, ...(released ? { hold: null } : {}) },
    escalations: releases && !released ? [{ kind: "officer", reason: `Fannie Mae directs "${i.direction}" on ${i.submission_id}: the servicer of record acknowledges before the LITIGATION_HOLD releases (13.7 escalations)` }] : [] };
}
/** E-1.3-01 "periodically update Fannie Mae": the monthly status update to Legal. */
export function statusUpdateSent(i: { matter_id: string; loan_id: string; period: string; sent_at: string; document_id: string; channel?: "fnma_legal_email" | "quatro" }): { events: EmittedEvent[] } {
  nonEmpty(i.matter_id, "matter_id"); nonEmpty(i.document_id, "document_id"); if (!/^\d{4}-\d{2}$/.test(i.period)) throw new RangeError("period is YYYY-MM");
  return { events: [{ type: "litigation.status_update.sent", occurred_at: i.sent_at, payload: { matter_id: i.matter_id, loan_id: i.loan_id, period: i.period, document_id: i.document_id, channel: i.channel ?? "fnma_legal_email", to: "loanservicing@fanniemae.com" } }] };
}

// ============================================================ pleadings, removal/appeal, workout notice (E-1.3-01)
export type PleadingKind = "motion" | "response" | "reply" | "brief";
/** A substantive pleading's deadline: the draft is due to Fannie Mae ≥5 servicer BD before it. */
export function pleadingDue(i: { matter_id: string; loan_id: string; pleading_id: string; kind: PleadingKind; filing_deadline: PlainDate }): { draft_due_to_fnma: PlainDate; events: EmittedEvent[] } {
  nonEmpty(i.pleading_id, "pleading_id"); oneOf(i.kind, ["motion", "response", "reply", "brief"], "kind"); if (!isDate(i.filing_deadline)) throw new RangeError("filing_deadline is a date");
  const draftDue = motionDraftDue(i.filing_deadline);
  return { draft_due_to_fnma: draftDue, events: [{ type: "litigation.pleading.due", payload: { matter_id: i.matter_id, loan_id: i.loan_id, pleading_id: i.pleading_id, kind: i.kind, filing_deadline: i.filing_deadline, draft_due_to_fnma: draftDue, lead_business_days: PLEADING_REVIEW_LEAD_BD } }] };
}
export function draftGivenToFnma(i: { matter_id: string; loan_id: string; pleading_id: string; filing_deadline: PlainDate; given_on: PlainDate; document_id: string }): { business_days_before_deadline: number; in_time: boolean; events: EmittedEvent[] } {
  nonEmpty(i.document_id, "document_id"); if (!isDate(i.given_on)) throw new RangeError("given_on is a date");
  const bd = servicerBusinessDaysBetween(i.given_on, i.filing_deadline); const inTime = pleadingReviewGate({ filing_due: i.filing_deadline, draft_given_on: i.given_on }).allowed;
  return { business_days_before_deadline: bd, in_time: inTime, events: [{ type: "litigation.pleading.draft_sent", payload: { matter_id: i.matter_id, loan_id: i.loan_id, pleading_id: i.pleading_id, given_on: i.given_on, document_id: i.document_id, filing_deadline: i.filing_deadline, business_days_before_deadline: bd, in_time: inTime } }] };
}
export function pleadingReviewClosed(i: { matter_id: string; loan_id: string; pleading_id: string; result: "comments_received" | "window_elapsed"; on: PlainDate; comments_document_id?: string | null }): { events: EmittedEvent[] } {
  oneOf(i.result, ["comments_received", "window_elapsed"], "result"); if (i.result === "comments_received") nonEmpty(i.comments_document_id, "comments_document_id");
  return { events: [{ type: "litigation.pleading.review.closed", payload: { matter_id: i.matter_id, loan_id: i.loan_id, pleading_id: i.pleading_id, result: i.result, on: i.on, comments_document_id: i.comments_document_id ?? null } }] };
}
/** The attorney files only after the review window: the gate reads the draft date stored on the pleading, never the caller's say-so. */
export function pleadingFilingGate(i: { filing_deadline: PlainDate; draft_given_on: PlainDate | null; review_closed: boolean }): { allowed: boolean; refusal: string | null; draft_due: PlainDate; business_days_before_deadline_when_given: number; gate: "FNMA_E1301_PLEADING_REVIEW_GATE" } {
  const g = pleadingReviewGate({ filing_due: i.filing_deadline, draft_given_on: i.draft_given_on });
  const bd = i.draft_given_on ? servicerBusinessDaysBetween(i.draft_given_on, i.filing_deadline) : 0;
  const ok = g.allowed || i.review_closed;   // Fannie Mae's comments received (or the window elapsed) close the gate even on a shorter lead with attorney justification
  return { allowed: ok, refusal: ok ? null : g.refusal, draft_due: g.draft_due, business_days_before_deadline_when_given: bd, gate: "FNMA_E1301_PLEADING_REVIEW_GATE" };
}
/** Removal to federal court on the Charter or an appeal is proposed: the approval request goes to Fannie Mae through the partner officer (decision 5). */
export function removalOrAppealProposed(i: { matter_id: string; loan_id: string; kind: "removal" | "appeal"; proposed_on: PlainDate; basis: string; judgment_document_id?: string | null }): { events: EmittedEvent[]; escalations: Escalation[]; row: Record<string, unknown> } {
  oneOf(i.kind, ["removal", "appeal"], "kind"); nonEmpty(i.basis, "basis"); if (i.kind === "appeal") nonEmpty(i.judgment_document_id, "judgment_document_id (the adverse judgment)");
  return { events: [{ type: "litigation.removal_or_appeal.proposed", payload: { matter_id: i.matter_id, loan_id: i.loan_id, kind: i.kind, proposed_on: i.proposed_on, basis: i.basis, judgment_document_id: i.judgment_document_id ?? null } }, { type: "litigation.approval.requested", payload: { matter_id: i.matter_id, loan_id: i.loan_id, kind: i.kind, requested_on: i.proposed_on, transmitted_by_role: "officer" } }],
    escalations: [{ kind: "officer", reason: `transmit the ${i.kind} approval request to Fannie Mae Legal (E-1.3-01 prior written approval; the servicer of record's position)` }], row: { status: i.kind === "appeal" ? "appeal" : "open", pending_approval: i.kind, fnma_written_approval_document_id: null } };
}
export function approvalGranted(i: { matter_id: string; loan_id: string; kind: "removal" | "appeal"; document_id: string; granted_on: PlainDate; recorded_by: { kind: string; id: string; role?: string } }): { events: EmittedEvent[]; row: Record<string, unknown> } {
  oneOf(i.kind, ["removal", "appeal"], "kind"); nonEmpty(i.document_id, "document_id (Fannie Mae's written approval)"); requireRole(i.recorded_by, ["officer"], "Fannie Mae's written approval (13.7 rule 7: the partner officer transmits and records)");
  return { events: [{ type: "litigation.approval.granted", payload: { matter_id: i.matter_id, loan_id: i.loan_id, kind: i.kind, document_id: i.document_id, granted_on: i.granted_on, recorded_by: `${i.recorded_by.kind}:${i.recorded_by.id}` } }], row: { fnma_written_approval_document_id: i.document_id, fnma_written_approval_kind: i.kind, pending_approval: null } };
}
export function removalOrAppealFilingGate(i: { kind: "removal" | "appeal"; approval_document_id: string | null; approval_kind: string | null }): { allowed: boolean; refusal: string | null; gate: "FNMA_E1301_REMOVAL_APPEAL_APPROVAL_GATE" } {
  return appealFilingGate({ fnma_written_approval_document_id: i.approval_document_id && (i.approval_kind === null || i.approval_kind === i.kind) ? i.approval_document_id : null });
}
/** A 12.x deferral/modification proposal on a litigated loan: counsel is notified with sufficient opportunity (policy 5 BD) and acknowledges before the offer leaves. */
export function workoutCounselNotice(i: { matter_id: string; loan_id: string; firm_id: string; option: string; notified_on: PlainDate; evaluation_id?: string | null }): { counsel_window_ends: PlainDate; events: EmittedEvent[] } {
  nonEmpty(i.firm_id, "firm_id"); nonEmpty(i.option, "option"); if (!isDate(i.notified_on)) throw new RangeError("notified_on is a date");
  const ends = addBusinessDays(i.notified_on, WORKOUT_COUNSEL_LEAD_BD, servicer);
  return { counsel_window_ends: ends, events: [{ type: "litigation.counsel.notified", payload: { matter_id: i.matter_id, loan_id: i.loan_id, kind: "workout_notice", firm_id: i.firm_id, option: i.option, notified_on: i.notified_on, counsel_window_ends: ends, evaluation_id: i.evaluation_id ?? null } }] };
}
export function counselAcknowledged(i: { matter_id: string; loan_id: string; firm_id: string; acknowledged_on: PlainDate; acknowledged_by: { kind: string; id: string; role?: string }; position?: string | null }): { events: EmittedEvent[]; row: Record<string, unknown> } {
  nonEmpty(i.firm_id, "firm_id"); requireRole(i.acknowledged_by, ["attorney"], "counsel's acknowledgment of the workout notice");
  return { events: [{ type: "litigation.counsel.acknowledged", payload: { matter_id: i.matter_id, loan_id: i.loan_id, kind: "workout_notice", firm_id: i.firm_id, acknowledged_on: i.acknowledged_on, acknowledged_by: `${i.acknowledged_by.kind}:${i.acknowledged_by.id}`, position: i.position ?? null } }], row: { counsel_acknowledged_workout_on: i.acknowledged_on } };
}
export function workoutOfferReleaseGate(i: { litigated: boolean; counsel_notified_on: PlainDate | null; counsel_acknowledged: boolean }): ReturnType<typeof workoutCounselGate> { return workoutCounselGate(i); }

// ============================================================ environmental hazards (F-1-08)
/** Rule 5 / decision 3: a suspected hazard opens the environmental hold immediately (policy) and a confirmation task due in 10 days. */
export function hazardSuspected(i: { hazard_id: string; loan_id: string; property_id?: string | null; kind: HazardKind; source: HazardSource; detected_on: PlainDate; note: string; inspection_id?: string | null }): { confirmation_due: PlainDate; hold: { kind: "environmental"; policy: "hold_on_suspicion" }; events: EmittedEvent[]; escalations: Escalation[]; row: Record<string, unknown> } {
  nonEmpty(i.hazard_id, "hazard_id"); nonEmpty(i.loan_id, "loan_id"); oneOf(i.kind, HAZARD_KINDS, "kind"); oneOf(i.source, HAZARD_SOURCES, "source"); nonEmpty(i.note, "note"); if (!isDate(i.detected_on)) throw new RangeError("detected_on is a date");
  const e = environmentalHazard({ state: "suspected", on: i.detected_on });
  return { confirmation_due: e.confirmation_task!.due, hold: { kind: "environmental", policy: "hold_on_suspicion" },
    events: [{ type: "environmental.hazard.suspected", payload: { hazard_id: i.hazard_id, loan_id: i.loan_id, kind: i.kind, source: i.source, detected_on: i.detected_on, note: i.note, confirm_by: e.confirmation_task!.due, inspection_id: i.inspection_id ?? null } }, { type: "environmental.hold.opened", payload: { hazard_id: i.hazard_id, loan_id: i.loan_id, kind: "environmental", policy: "hold_on_suspicion", confirm_by: e.confirmation_task!.due } }],
    escalations: [{ kind: "human_agent", reason: `confirm the suspected ${i.kind} hazard (second inspection/expert/citation) by ${e.confirmation_task!.due} (13.7 rule 5)` }],
    row: { id: i.hazard_id, loan_id: i.loan_id, property_id: i.property_id ?? null, kind: i.kind, source: i.source, detected_at: i.detected_on, severity: "suspected", note: i.note, confirmation_due_at: e.confirmation_task!.due, servicing_rep_reported_at: null, fnma_direction: null, status: "open" } };
}
/** Confirmed (second inspection, expert or citation on file) ⇒ the F-1-08 gate closes, the Servicing Representative report is due in 2 BD and, on a referred 1–4 unit lead-paint citation, the 30-day notification runs from referral. */
export function hazardConfirmed(i: { hazard_id: string; loan_id: string; kind: HazardKind; source: HazardSource; confirmed_on: PlainDate; evidence_document_id: string; referred: boolean; referral_on?: PlainDate | null; units?: number | null; citation_document_id?: string | null }): { gate: "FNMA_F108_ENV_NO_FORECLOSURE_GATE"; gate_closed: true; report_by: PlainDate; lead_paint_notification_due: PlainDate | null; refusal: string; events: EmittedEvent[]; escalations: Escalation[]; row: Record<string, unknown> } {
  nonEmpty(i.hazard_id, "hazard_id"); nonEmpty(i.loan_id, "loan_id"); oneOf(i.kind, HAZARD_KINDS, "kind"); oneOf(i.source, HAZARD_SOURCES, "source"); nonEmpty(i.evidence_document_id, "evidence_document_id (second inspection/expert/citation)"); if (!isDate(i.confirmed_on)) throw new RangeError("confirmed_on is a date");
  if (i.referred && !isDate(i.referral_on)) throw new RangeError("a referred loan carries its referral_on");
  const e = environmentalHazard({ state: "confirmed", on: i.confirmed_on, report: null });
  const leadPaint = i.kind === "lead_paint" && i.referred && i.units !== undefined && i.units !== null && i.units >= 1 && i.units <= 4;
  const lpDue = leadPaint ? leadPaintNotification({ referral_on: i.referral_on!, units: i.units!, notification: null }).due : null;
  const payload = { hazard_id: i.hazard_id, loan_id: i.loan_id, kind: i.kind, source: i.source, confirmed_on: i.confirmed_on, evidence_document_id: i.evidence_document_id, referred: i.referred, referral_on: i.referred ? i.referral_on : null, units: i.units ?? null, report_by: e.report_by, lead_paint_notification_due: lpDue, gate: "FNMA_F108_ENV_NO_FORECLOSURE_GATE" };
  return { gate: "FNMA_F108_ENV_NO_FORECLOSURE_GATE", gate_closed: true, report_by: e.report_by!, lead_paint_notification_due: lpDue, refusal: e.refusal!,
    events: [{ type: "environmental.hazard.confirmed", payload }],
    escalations: [{ kind: "officer", severity: "sev2", reason: `environmental hazard (${i.kind}) confirmed: Servicing Representative report by ${e.report_by}${lpDue ? `; lead-paint notification by ${lpDue} (30 days after referral)` : ""} (F-1-08)` }],
    row: { id: i.hazard_id, loan_id: i.loan_id, kind: i.kind, source: i.source, severity: "confirmed", confirmed_at: i.confirmed_on, evidence_document_id: i.evidence_document_id, citation_document_id: i.citation_document_id ?? null, referred: i.referred, referral_on: i.referred ? i.referral_on : null, units: i.units ?? null, report_due_at: e.report_by, lead_paint_notification_due_at: lpDue, status: "open" } };
}
export type EnvironmentalReport = { value: Cents; debt: Cents; occupancy: "owner" | "tenant" | "vacant" | "unknown"; children_under_8: boolean; documentation: readonly string[]; recommendation: "hold" | "proceed" | "charge_off" | "deed_in_lieu" | "other" };
/** The F-1-08 report to the Servicing Representative: value, debt, occupancy, children under 8, documentation and a recommendation — refused when an element is missing. */
export function servicingRepReport(i: { hazard_id: string; loan_id: string; confirmed_on: PlainDate; report: Partial<EnvironmentalReport> | null; sent_at: string; servicing_rep: string }): { due: PlainDate; sent_on: PlainDate; on_time: boolean; events: EmittedEvent[]; row: Record<string, unknown> } {
  nonEmpty(i.hazard_id, "hazard_id"); nonEmpty(i.servicing_rep, "servicing_rep");
  const e = environmentalHazard({ state: "confirmed", on: i.confirmed_on, report: i.report ?? null });
  if (e.report_elements_missing.length) throw new RangeError(`Servicing Representative report is missing ${e.report_elements_missing.join(", ")} (F-1-08: ${ENVIRONMENTAL_REPORT_ELEMENTS.join(", ")})`);
  const r = i.report as EnvironmentalReport; if (typeof r.value !== "bigint" || typeof r.debt !== "bigint") throw new RangeError("value and debt are bigint cents"); if (!r.documentation.length) throw new RangeError("documentation is required");
  const on = i.sent_at.slice(0, 10) as PlainDate; const due = e.report_by!;
  const payload = { hazard_id: i.hazard_id, loan_id: i.loan_id, kind: "environmental_hazard", to: i.servicing_rep, sent_on: on, sent_at: i.sent_at, due, on_time: on <= due, property_value_cents: r.value, outstanding_debt_cents: r.debt, occupancy: r.occupancy, children_under_8: r.children_under_8, documentation_ids: [...r.documentation], recommendation: r.recommendation };
  return { due, sent_on: on, on_time: on <= due, events: [{ type: "fnma.servicing_rep.notified", occurred_at: i.sent_at, payload }, { type: "environmental.report.sent", occurred_at: i.sent_at, payload: { hazard_id: i.hazard_id, loan_id: i.loan_id, sent_at: i.sent_at, to: i.servicing_rep } }],
    row: { servicing_rep_reported_at: i.sent_at, property_value_cents: r.value, outstanding_debt_cents: r.debt, children_under_8: r.children_under_8, occupancy: r.occupancy, recommendation: r.recommendation, report_documentation_ids: [...r.documentation] } };
}
/** F-1-08 lead-based paint: on a referred 1–4 unit property the notification (current value, outstanding debt, children under 8, documentation of the violations) goes within 30 days after referral. */
export function leadPaintNotice(i: { hazard_id: string; loan_id: string; referral_on: PlainDate; units: number; notification: { property_value_cents?: Cents; total_debt_cents?: Cents; children_under_8?: boolean; documentation_ids?: readonly string[] } | null; sent_at: string; servicing_rep: string }): { due: PlainDate; sent_on: PlainDate; on_time: boolean; events: EmittedEvent[]; row: Record<string, unknown> } {
  nonEmpty(i.hazard_id, "hazard_id"); nonEmpty(i.servicing_rep, "servicing_rep"); if (!isDate(i.referral_on)) throw new RangeError("referral_on is a date");
  const r = leadPaintNotification({ referral_on: i.referral_on, units: i.units, notification: i.notification, sent_on: i.sent_at.slice(0, 10) as PlainDate });
  if (!r.applies) throw new RangeError(`the lead-paint notification applies to 1–4 unit properties (units=${i.units})`);
  if (r.elements_missing.length) throw new RangeError(`lead-paint notification is missing ${r.elements_missing.join(", ")} (F-1-08: ${LEAD_PAINT_ELEMENTS.join(", ")})`);
  const n = i.notification!; if (typeof n.property_value_cents !== "bigint" || typeof n.total_debt_cents !== "bigint") throw new RangeError("value and debt are bigint cents");
  const on = i.sent_at.slice(0, 10) as PlainDate;
  const payload = { hazard_id: i.hazard_id, loan_id: i.loan_id, kind: "lead_paint", to: i.servicing_rep, sent_on: on, sent_at: i.sent_at, referral_on: i.referral_on, due: r.due, on_time: r.on_time === true, property_value_cents: n.property_value_cents, outstanding_debt_cents: n.total_debt_cents, children_under_8: n.children_under_8 === true, documentation_ids: [...(n.documentation_ids ?? [])] };
  return { due: r.due, sent_on: on, on_time: r.on_time === true, events: [{ type: "fnma.servicing_rep.notified", occurred_at: i.sent_at, payload }, { type: "lead_paint.notification.sent", occurred_at: i.sent_at, payload: { hazard_id: i.hazard_id, loan_id: i.loan_id, sent_at: i.sent_at, due: r.due, on_time: r.on_time === true } }],
    row: { lead_paint_notification_sent_at: i.sent_at, lead_paint_notification_due_at: r.due, property_value_cents: n.property_value_cents, outstanding_debt_cents: n.total_debt_cents, children_under_8: n.children_under_8 === true, citation_document_id: n.documentation_ids?.[0] ?? null } };
}
/** Fannie Mae's direction on a confirmed hazard (proceed / hold / charge-off / deed-in-lieu / other): the officer records it with its document; "proceed" opens the F-1-08 gate and releases the environmental hold. */
export function hazardDirection(i: { hazard_id: string; loan_id: string; direction: FnmaDirection; document_id: string; received_on: PlainDate; recorded_by: { kind: string; id: string; role?: string } }): { status: "fnma_directed_proceed" | "fnma_directed_hold" | "charged_off" | "open"; hold_released: boolean; events: EmittedEvent[]; row: Record<string, unknown> } {
  nonEmpty(i.hazard_id, "hazard_id"); oneOf(i.direction, FNMA_DIRECTIONS, "direction"); nonEmpty(i.document_id, "document_id (Fannie Mae's direction)"); requireRole(i.recorded_by, ["officer"], "Fannie Mae's direction (the servicer of record's acknowledgment)");
  const status = i.direction === "proceed" ? "fnma_directed_proceed" : i.direction === "hold" ? "fnma_directed_hold" : i.direction === "charge_off" ? "charged_off" : "open";
  const events: EmittedEvent[] = [{ type: "environmental.hazard.direction.received", payload: { hazard_id: i.hazard_id, loan_id: i.loan_id, direction: i.direction, document_id: i.document_id, received_on: i.received_on, recorded_by: `${i.recorded_by.kind}:${i.recorded_by.id}` } }];
  if (i.direction === "proceed") events.push({ type: "environmental.hold.released", payload: { hazard_id: i.hazard_id, loan_id: i.loan_id, kind: "environmental", direction: i.direction } });
  return { status, hold_released: i.direction === "proceed", events, row: { fnma_direction: i.direction, fnma_direction_document_id: i.document_id, fnma_direction_received_on: i.received_on, status } };
}
/** Guardrail: environmental "cleared" requires human-reviewed evidence — an attorney's or a licensed inspector's report. */
export function hazardCleared(i: { hazard_id: string; loan_id: string; reviewer: "attorney" | "licensed_inspector"; evidence_document_id: string; cleared_on: PlainDate; recorded_by: { kind: string; id: string; role?: string } }): { events: EmittedEvent[]; row: Record<string, unknown> } {
  nonEmpty(i.hazard_id, "hazard_id"); oneOf(i.reviewer, ["attorney", "licensed_inspector"], "reviewer"); nonEmpty(i.evidence_document_id, "evidence_document_id (the reviewer's report)");
  if (i.reviewer === "attorney") requireRole(i.recorded_by, ["attorney"], "an attorney-reviewed clearance"); else if (roleOf(i.recorded_by) === null) throw new RangeError("a licensed inspector's clearance is recorded by a human (the agent never clears a hazard)");
  return { events: [{ type: "environmental.hazard.cleared", payload: { hazard_id: i.hazard_id, loan_id: i.loan_id, reviewer: i.reviewer, evidence_document_id: i.evidence_document_id, cleared_on: i.cleared_on, recorded_by: `${i.recorded_by.kind}:${i.recorded_by.id}` } }, { type: "environmental.hold.released", payload: { hazard_id: i.hazard_id, loan_id: i.loan_id, kind: "environmental", direction: "cleared" } }], row: { status: "cleared", cleared_on: i.cleared_on, cleared_evidence_document_id: i.evidence_document_id, cleared_reviewer: i.reviewer } };
}
/** F-1-08 Massachusetts: the actual lead-paint citation search is completed before referral (13.4 checklist item; 13.7-T5). */
export function maCitationSearchCompleted(i: { loan_id: string; state: string; search_document_id: string; completed_on: PlainDate; citations_found: number }): { events: EmittedEvent[] } {
  nonEmpty(i.loan_id, "loan_id"); nonEmpty(i.search_document_id, "search_document_id"); if (i.state.toUpperCase() !== "MA") throw new RangeError("the citation search is the Massachusetts pre-referral requirement (F-1-08)");
  if (!Number.isInteger(i.citations_found) || i.citations_found < 0) throw new RangeError("citations_found is a count");
  return { events: [{ type: "environmental.ma_citation_search.completed", payload: { loan_id: i.loan_id, state: "MA", search_document_id: i.search_document_id, completed_on: i.completed_on, citations_found: i.citations_found, ma_lead_paint_citation_search_completed: true } }] };
}

/** Classification only (no notice date): the rules+model mapping the tool exposes for a pleading extract. */
export function classifyClaims(claims: Claims, confidence: number): ReturnType<typeof classify> {
  return classify({ damages_against_fnma: claims.damages_against_fnma === true, attacks_validity_priority_enforceability: claims.attacks_validity_priority_enforceability === true, enumerated_risk: claims.enumerated_risk === true || claims.environmental === true || claims.putative_class === true, damages_claim: claims.damages_claim === true, confidence });
}
