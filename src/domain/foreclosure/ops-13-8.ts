/**
 * §13.8 operating rules the tool path runs over the calculators in scra.ts and ops.ts — the events the process's
 * registry rows arm on and are satisfied by, each validated here and appended by the `scra.case.get/open/close`,
 * `dmdc.batch.prepare` and `dmdc.results.import` handlers (src/app/tools/section13-8.ts, called from the 13.8 block of
 * src/app/tools/section13.ts):
 *   - D2-3.4-01 quarterly contact ("at a minimum, every three months"): `scra.contact.completed{kind=status_check}` and
 *     its 4.x contact-log alias `contact.scra.status_check` — only a contact that reached the servicemember or their
 *     family (or a mailed status-check letter) satisfies FNMA_D23401_SM_CONTACT_90; an attempt re-queues the cadence;
 *   - the §3919 umbrella consumed by 8.3: `scra.relief.started` with the stay, `scra.relief.ended{plus_one_cycle=true}`
 *     one monthly reporting cycle after the protection window (SCRA_3919_NO_ADVERSE_GATE "until relief/stay end + 1 cycle");
 *   - the spec's own verification event `scra.status.verified{purpose, result}` with the §3931(g) flag
 *     `post_judgment_on_duty` (a judgment entered against an unlocated defendant later found on duty → attorney; the
 *     reopening application is due 90 days after service ends — SCRA_3931G_DEFAULT_JUDGMENT_REOPEN_90);
 *   - inbound attorney-network / eviction records that need a certificate ≤30 days old before the servicer acts
 *     (13.8 Inputs "before first-notice authorization, before any default-judgment/dispositive motion (affidavit) …
 *     before eviction"): `foreclosure.first_notice.authorize.requested`, `firm.dispositive_motion.proposed{judicial}`,
 *     `eviction.referral.requested{eviction_referral_on}`;
 *   - `scra.affidavit.filed` (13.8 Outputs `scra.affidavit.executed/filed`; `scra_affidavits.filed_at`) releasing the
 *     motion instruction, and `judgment.reopen.decided` (the court's §3931(g) decision, recorded by the attorney).
 * Dates are PlainDate; nothing here reads the store — the handlers pass facts in and append what comes back.
 */
import { type PlainDate, addDays, addMonths, endOfMonth } from "../../kernel/calendar/date.ts";

export interface EmittedEvent { readonly type: string; readonly payload: Record<string, unknown>; }
export interface Escalation { readonly kind: "attorney" | "officer" | "signing_officer" | "human_agent"; readonly severity?: "sev1" | "sev2" | "sev3"; readonly reason: string; }

// ============================================================ D2-3.4-01 quarterly contact (FNMA_D23401_SM_CONTACT_90)
/** "should contact the eligible servicemember or their family, at a minimum, every three months" — 90 calendar days (registry). */
export const CONTACT_CADENCE_DAYS = 90;
export const STATUS_CHECK_CHANNELS = ["call", "ai_voice", "letter", "email", "portal"] as const;
export type StatusCheckChannel = (typeof STATUS_CHECK_CHANNELS)[number];
export const STATUS_CHECK_OUTCOMES = ["reached_servicemember", "reached_family", "letter_sent", "attempted"] as const;
export type StatusCheckOutcome = (typeof STATUS_CHECK_OUTCOMES)[number];
/** Outcomes that count as the quarterly contact; `attempted` keeps the cadence timer open. */
const CONTACT_MADE: readonly StatusCheckOutcome[] = ["reached_servicemember", "reached_family", "letter_sent"];

export interface StatusCheckInput {
  readonly case_id: string; readonly case_status: string; readonly contacted_on: PlainDate; readonly channel: string; readonly outcome: string;
  readonly tcpa_consent?: boolean; readonly automation_disclosed?: boolean; readonly expected_service_end_on?: PlainDate | null; readonly contact_id?: string | null; readonly notice_template?: string | null;
}
export interface StatusCheckResult { readonly allowed: boolean; readonly refusal: string | null; readonly contact_made: boolean; readonly next_contact_on: PlainDate | null; readonly events: readonly EmittedEvent[]; }
/**
 * Validates the quarterly status check (13.8 AI agent design: "AI voice status checks require TCPA consent and
 * automation disclosure") and returns the events: `scra.contact.completed{kind=status_check}` (13.8 Outputs) plus the
 * contact-log alias `contact.scra.status_check` the cadence timer names — or `scra.contact.attempted` when nobody was
 * reached, which satisfies nothing. The next cadence date is contacted_on + 90 calendar days.
 */
export function statusCheckContact(i: StatusCheckInput): StatusCheckResult {
  const refuse = (refusal: string): StatusCheckResult => ({ allowed: false, refusal, contact_made: false, next_contact_on: null, events: [] });
  if (i.case_status !== "open_active_duty" && i.case_status !== "open_tail_12m") return refuse(`no open SCRA case to contact (status ${i.case_status || "none"}) — the D2-3.4-01 cadence runs while the case is open`);
  if (!(STATUS_CHECK_CHANNELS as readonly string[]).includes(i.channel)) return refuse(`channel must be one of ${STATUS_CHECK_CHANNELS.join(", ")}`);
  if (!(STATUS_CHECK_OUTCOMES as readonly string[]).includes(i.outcome)) return refuse(`outcome must be one of ${STATUS_CHECK_OUTCOMES.join(", ")}`);
  if (i.channel === "ai_voice" && !(i.tcpa_consent === true && i.automation_disclosed === true)) return refuse("an AI voice status check needs TCPA consent and the automation disclosure on the record (13.8 AI agent design)");
  if (i.channel === "letter" && i.outcome !== "letter_sent") return refuse("a letter's outcome is letter_sent (NTC_FNMA_D23401_SCRA_STATUS_CHECK_90)");
  const outcome = i.outcome as StatusCheckOutcome; const made = CONTACT_MADE.includes(outcome);
  const next = addDays(i.contacted_on, CONTACT_CADENCE_DAYS);
  const payload = { case_id: i.case_id, kind: "status_check", channel: i.channel, outcome, contacted_on: i.contacted_on, next_contact_on: next, expected_service_end_on: i.expected_service_end_on ?? null, contact_id: i.contact_id ?? null, notice_template: i.notice_template ?? null };
  const events: EmittedEvent[] = made
    ? [{ type: "scra.contact.completed", payload }, { type: "contact.scra.status_check", payload }]
    : [{ type: "scra.contact.attempted", payload }];
  return { allowed: true, refusal: null, contact_made: made, next_contact_on: next, events };
}

// ============================================================ §3919 umbrella (SCRA_3919_NO_ADVERSE_GATE; consumed by 8.3)
/** The stay is relief under §3919: 8.3 holds any new adverse status change for `officer` review while the gate is open. */
export function reliefStarted(i: { case_id: string; started_on: PlainDate; status_code: string }): EmittedEvent {
  return { type: "scra.relief.started", payload: { case_id: i.case_id, kind: "foreclosure_stay", started_on: i.started_on, status_code: i.status_code, consumer: "8.3" } };
}
/** "until relief/stay end + 1 cycle": the monthly furnishing cycle after the month in which protection ended. */
export function reliefHoldThrough(endedOn: PlainDate): PlainDate { return endOfMonth(addMonths(endedOn, 1)); }
export interface ReliefSweepCase { readonly case_id: string; readonly status: string; readonly fc_stay_granted_at: string | null; readonly protection_ends_on: PlainDate | null; readonly closed_on: PlainDate | null; readonly relief_ended_at: string | null; }
/** Closed cases whose relief cycle has run out on `today`: one `scra.relief.ended{plus_one_cycle=true}` each, never twice. */
export function reliefCycleSweep(cases: readonly ReliefSweepCase[], today: PlainDate): { case_id: string; ended_on: PlainDate; hold_through: PlainDate; event: EmittedEvent }[] {
  const out: { case_id: string; ended_on: PlainDate; hold_through: PlainDate; event: EmittedEvent }[] = [];
  for (const c of cases) {
    if (c.status !== "closed" || !c.fc_stay_granted_at || c.relief_ended_at) continue;
    const endedOn = c.protection_ends_on ?? c.closed_on; if (!endedOn) continue;
    const holdThrough = reliefHoldThrough(endedOn);
    if (today <= holdThrough) continue;
    out.push({ case_id: c.case_id, ended_on: endedOn, hold_through: holdThrough, event: { type: "scra.relief.ended", payload: { case_id: c.case_id, kind: "foreclosure_stay", ended_on: endedOn, plus_one_cycle: true, hold_through: holdThrough, released_on: today } } });
  }
  return out;
}

// ============================================================ verification outcome (`scra.status.verified`; §3931(g))
export type DmdcStatus = "Y" | "X" | "N" | "Z";
export interface VerificationResultRow { readonly status: DmdcStatus; readonly service_begin_on?: PlainDate | null; readonly service_end_on?: PlainDate | null; readonly left_active_duty_367?: boolean; readonly future_call_up?: boolean; }
export interface VerificationOutcome {
  readonly result: "Y" | "N" | "Z"; readonly post_judgment_on_duty: boolean; readonly service_end_date: PlainDate | null; readonly reopen_application_deadline: PlainDate | null;
  readonly future_call_up: boolean; readonly escalation: Escalation | null; readonly event: EmittedEvent;
}
/**
 * One `scra.status.verified{purpose, result}` per import (13.8 Outputs). X and Z are unknown (edge cases) → Z for the
 * alternate-name retry; any Y governs. `post_judgment_on_duty` (§3931(g)): a judgment was entered on the foreclosure
 * case and the servicemember's period covers that date (a Y with no begin date is taken to cover it) — the attorney is
 * told and the reopening application deadline (service end + 90 calendar days) rides on the event as `service_end_date`
 * for SCRA_3931G_DEFAULT_JUDGMENT_REOPEN_90; a Future Call-Up flag re-verifies weekly until the sale (edge cases).
 */
export function verificationOutcome(i: { purpose: string; results: readonly VerificationResultRow[]; status_date: PlainDate; judgment_entered_on: PlainDate | null; verification_ids?: readonly string[] }): VerificationOutcome {
  if (i.results.length === 0) throw new RangeError("results is empty — a verification needs at least one DMDC result row");
  const ys = i.results.filter((r) => r.status === "Y");
  const result: "Y" | "N" | "Z" = ys.length ? "Y" : i.results.some((r) => r.status === "Z" || r.status === "X") ? "Z" : "N";
  const ends = ys.map((r) => r.service_end_on ?? null).filter((d): d is PlainDate => !!d).sort();
  const serviceEnd = ends.length ? ends[ends.length - 1]! : null;
  const coversJudgment = (r: VerificationResultRow): boolean => !!i.judgment_entered_on && (!r.service_begin_on || r.service_begin_on <= i.judgment_entered_on) && (!r.service_end_on || r.service_end_on >= i.judgment_entered_on);
  const postJudgment = result === "Y" && ys.some(coversJudgment);
  const deadline = serviceEnd ? addDays(serviceEnd, 90) : null;
  const futureCallUp = i.results.some((r) => r.future_call_up === true);
  const escalation: Escalation | null = postJudgment
    ? { kind: "attorney", severity: "sev2", reason: `DMDC Y after the ${i.judgment_entered_on} judgment: 50 U.S.C. 3931(g) — the servicemember may apply to reopen within 90 days after release${deadline ? ` (by ${deadline})` : " (service end unknown — keep the gate closed and contact per the 90-day cadence)"}; no further steps on the judgment` }
    : null;
  const event: EmittedEvent = { type: "scra.status.verified", payload: { purpose: i.purpose, result, status_date: i.status_date, post_judgment_on_duty: postJudgment, judgment_entered_on: i.judgment_entered_on, service_end_date: serviceEnd, reopen_application_deadline: deadline, future_call_up: futureCallUp, verification_ids: [...(i.verification_ids ?? [])] } };
  return { result, post_judgment_on_duty: postJudgment, service_end_date: serviceEnd, reopen_application_deadline: deadline, future_call_up: futureCallUp, escalation, event };
}

// ============================================================ inbound attorney-network / eviction records needing a fresh certificate
export const INBOUND_RECORD_KINDS = ["first_notice_authorization_request", "dispositive_motion_proposal", "eviction_referral_request"] as const;
export type InboundRecordKind = (typeof INBOUND_RECORD_KINDS)[number];
export const MOTION_KINDS = ["default_judgment", "summary_judgment", "judgment_on_pleadings", "other_dispositive"] as const;
export interface InboundFirmRecord {
  readonly kind: string; readonly loan_id: string; readonly firm_id: string; readonly received_on: PlainDate; readonly foreclosure_case_id?: string | null;
  readonly judicial?: boolean; readonly motion_kind?: string | null; readonly court?: string | null; readonly first_notice_kind?: string | null;
  readonly eviction_referral_on?: PlainDate | null; readonly occupant_type?: string | null; readonly record_id?: string | null;
}
export interface IntakeResult { readonly purpose: "first_notice" | "judgment" | "eviction"; readonly freshness_days: 30; readonly verify_by: PlainDate; readonly affidavit_required: boolean; readonly event: EmittedEvent; }
/**
 * Validates the inbound record and names the milestone event the registry rows arm on: the firm's request to authorize
 * the first legal notice (SM_DMDC_VERIFY_PRE_FIRST_NOTICE_30, same day), its proposed default-judgment/dispositive motion
 * (SCRA_3931_AFFIDAVIT_GATE arms only when `judicial=true` — the §3931 affidavit is a judicial requirement), and the
 * eviction referral request (SM_DMDC_VERIFY_PRE_EVICTION_30 anchors on `eviction_referral_on` −30 calendar days).
 */
export function intakeFirmRecord(r: InboundFirmRecord): IntakeResult {
  if (!r.loan_id) throw new RangeError("loan_id is required"); if (!r.firm_id) throw new RangeError("firm_id is required"); if (!r.received_on) throw new RangeError("received_on is required");
  if (!(INBOUND_RECORD_KINDS as readonly string[]).includes(r.kind)) throw new RangeError(`kind must be one of ${INBOUND_RECORD_KINDS.join(", ")}`);
  const base = { loan_id: r.loan_id, firm_id: r.firm_id, foreclosure_case_id: r.foreclosure_case_id ?? null, record_id: r.record_id ?? null, requested_on: r.received_on, freshness_days: 30 };
  if (r.kind === "first_notice_authorization_request") {
    return { purpose: "first_notice", freshness_days: 30, verify_by: r.received_on, affidavit_required: false, event: { type: "foreclosure.first_notice.authorize.requested", payload: { ...base, first_notice_kind: r.first_notice_kind ?? null, verification_purpose: "first_notice" } } };
  }
  if (r.kind === "dispositive_motion_proposal") {
    const motionKind = r.motion_kind ?? "default_judgment"; if (!(MOTION_KINDS as readonly string[]).includes(motionKind)) throw new RangeError(`motion_kind must be one of ${MOTION_KINDS.join(", ")}`);
    const judicial = r.judicial !== false;
    return { purpose: "judgment", freshness_days: 30, verify_by: r.received_on, affidavit_required: judicial, event: { type: "firm.dispositive_motion.proposed", payload: { ...base, judicial, motion_kind: motionKind, court: r.court ?? null, proposed_on: r.received_on, verification_purpose: "judgment", affidavit_required: judicial } } };
  }
  if (!r.eviction_referral_on) throw new RangeError("eviction_referral_on is required for an eviction referral request");
  if (r.eviction_referral_on < r.received_on) throw new RangeError(`eviction_referral_on ${r.eviction_referral_on} precedes the request date ${r.received_on}`);
  const verifyBy = addDays(r.eviction_referral_on, -30);
  return { purpose: "eviction", freshness_days: 30, verify_by: verifyBy, affidavit_required: false, event: { type: "eviction.referral.requested", payload: { ...base, eviction_referral_on: r.eviction_referral_on, occupant_type: r.occupant_type ?? null, verify_by: verifyBy, verification_purpose: "eviction" } } };
}

// ============================================================ affidavit filing (`scra.affidavit.filed`) and the §3931(g) decision
export interface AffidavitFilingInput { readonly affidavit_id: string; readonly executed_at: string | null; readonly executed_by: string | null; readonly records_review_passed: boolean | null; readonly already_filed_at: string | null; readonly filed_at: string; readonly filed_by_firm_id: string; readonly document_id: string; }
export interface AffidavitFilingResult { readonly allowed: boolean; readonly refusal: string | null; readonly motion_instruction_released: boolean; readonly event: EmittedEvent | null; }
/** The firm's filing evidence on an executed affidavit releases the motion instruction (13.8-T5: "released only after filing evidence"). */
export function affidavitFiled(i: AffidavitFilingInput): AffidavitFilingResult {
  const refuse = (refusal: string): AffidavitFilingResult => ({ allowed: false, refusal, motion_instruction_released: false, event: null });
  if (!i.executed_at || !i.executed_by) return refuse(`affidavit ${i.affidavit_id} is not executed — a signing_officer executes it after the records review before the firm files it`);
  if (i.records_review_passed === false) return refuse(`affidavit ${i.affidavit_id} failed its records review — it cannot be filed`);
  if (i.already_filed_at) return refuse(`affidavit ${i.affidavit_id} was already filed at ${i.already_filed_at}`);
  if (!i.filed_by_firm_id) return refuse("filed_by_firm_id is required"); if (!i.document_id) return refuse("document_id (the filing evidence) is required");
  if (i.filed_at < i.executed_at) return refuse(`filed_at ${i.filed_at} precedes execution ${i.executed_at}`);
  return { allowed: true, refusal: null, motion_instruction_released: true, event: { type: "scra.affidavit.filed", payload: { affidavit_id: i.affidavit_id, filed_at: i.filed_at, filed_by_firm_id: i.filed_by_firm_id, document_id: i.document_id, motion_instruction_released: true } } };
}

export const REOPEN_DECISIONS = ["reopened", "denied", "withdrawn", "not_applied"] as const;
export interface ReopenDecisionInput { readonly decision: string; readonly decided_on: PlainDate; readonly applied_on?: PlainDate | null; readonly service_end_on: PlainDate | null; readonly court?: string | null; readonly order_document_id?: string | null; readonly judgment_entered_on?: PlainDate | null; }
export interface ReopenDecisionResult { readonly application_deadline: PlainDate | null; readonly application_within_window: boolean | null; readonly event: EmittedEvent; }
/** §3931(g): the application to reopen is due "not later than 90 days after the date of the termination of or release from military service"; the court's decision closes the window. */
export function judgmentReopenDecided(i: ReopenDecisionInput): ReopenDecisionResult {
  if (!(REOPEN_DECISIONS as readonly string[]).includes(i.decision)) throw new RangeError(`decision must be one of ${REOPEN_DECISIONS.join(", ")}`);
  if (i.decision !== "not_applied" && !i.applied_on) throw new RangeError("applied_on is required unless the servicemember did not apply (decision not_applied)");
  const deadline = i.service_end_on ? addDays(i.service_end_on, 90) : null;
  const within = i.applied_on && deadline ? i.applied_on <= deadline : null;
  return { application_deadline: deadline, application_within_window: within, event: { type: "judgment.reopen.decided", payload: { decision: i.decision, decided_on: i.decided_on, applied_on: i.applied_on ?? null, application_deadline: deadline, application_within_window: within, court: i.court ?? null, order_document_id: i.order_document_id ?? null, judgment_entered_on: i.judgment_entered_on ?? null } } };
}
