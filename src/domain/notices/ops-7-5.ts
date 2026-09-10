/**
 * §7.5 process ops — the code paths that append the GLBA / Reg P privacy events the 7.5 registry clocks arm on and close
 * with (spec/sections/07-compliance-notices-disclosures/7-5-glba-privacy-notice.md). The `disclosures` agent has no bus
 * tools for 7.5 (spec/registry/agents.json: tools []; "AI-off: calendar jobs + ops console"), so these are the ops-console
 * and calendar-job entry points plus the ingestion handlers for the partner, transfer and borrower feeds. Every handler
 * validates its inbound record and appends the event with the fields the timer patterns condition on
 * (src/domain/notices/timers.ts + timers-7-5.ts).
 *
 *   - `privacyInitialNoticeDue` — the partner's MSR acquisition (transfer file, 1.2/1.3 scenario (c)) or an assumption
 *     confirmation (4.4): appends the inbound event (`transfer_in.msr_acquired_by_partner{transfer_date}` /
 *     `sii.assumption.confirmed{assumption_date}`) and the state transition `privacy.initial_due{anchor_date, reason}`
 *     (state machine: no_notice_due → initial_due "MSR acquisition or assumption") that arms
 *     REGP_1016_4A1_INITIAL_NOTICE_REASONABLE_30 with the row's anchor "acquisition (transfer) date / assumption date".
 *   - `recordPartnerNoticeOnFile` — master-to-subservicer / sub-to-sub boarding: no initial notice (rule 2, §1016.4(d));
 *     the partner's notice version and date are recorded; optional courtesy copy (decision 2) labelled `kind=courtesy`.
 *   - `sendInitialPrivacyNotice` / `postInitialNoticeToPortal` / `recordPortalAcknowledgment` / `portalAcknowledgmentSweep`
 *     — the deliveries (`notice.sent{template=NTC_REGP_1016_4_INITIAL, kind=initial, basis}` + `privacy.initial_sent{sent_on}`,
 *     the anchor of REGP_1016_5A_ANNUAL_NOTICE_12M), the §1016.9(b)(1)(iii) posting-with-acknowledgment path for
 *     `privacy_notices` e-consent and its 30-day paper fallback (rule 6; T6).
 *   - `partnerAttestationReceived` — partner attestation feed → `partner.privacy_attestation.received{attestation_id, no_change}`
 *     (SM_PARTNER_PRIVACY_ATTESTATION_0131).
 *   - `openAnnualCycle` / `applyAnnualCycle` / `sendAnnualPrivacyNotice` — the Jan 2 exception test (rule 4):
 *     `privacy.annual_exception.applied{attestation_id, outcome=exception_applied}` or `privacy.annual_due` then the mailing
 *     (`notice.sent{template=NTC_REGP_1016_5_ANNUAL, kind=annual}` + `privacy.annual_sent{outcome=annual_sent}`); no attestation
 *     by Mar 31 defaults to the mailing (breach column). `outcome` is what REGP_1016_5A conditions on, so the Jan 2 input
 *     `privacy.annual_cycle.opened` never closes the clock.
 *   - `recordPolicyChange` / `sendRevisedPrivacyNotice` / `closeOptOutWindow` / `recordOptOut` / `marketingShareExport` —
 *     the partner change-control feed → `privacy_policy.changed{new_sharing, exception_lost, change_date}` (rule 5), the
 *     §1016.8 revised notice with its 30-day opt-out window (`privacy.revised_notice.sent`; the annual clock restarts —
 *     §1016.5(e)(2)(i)), the gate-closing `privacy.revised_notice.optout_window_elapsed`, opt-outs, and the guardrail that
 *     hard-blocks any data export tagged `marketing_share` until REGP_1016_8_REVISED_NOTICE_GATE clears.
 *   - `requestPrivacyCopy` / `sendPrivacyCopy` — borrower copy requests by any channel → `privacy_notice.copy_requested
 *     {requested_on}` and the copy within 5 servicer business days by the consented channel (`notice.sent{kind=on_request}`).
 *   - `terminatePrivacyRelationship` / `privacyPartyStatus` — payoff / transfer-out (§1016.5(b), rule 9):
 *     `privacy.relationship.terminated`, open 7.5 clocks cancelled, party status `terminated`.
 *   - `assemblePrivacyNoticePayload` — rule 7: the Appendix A model-form fields from the `privacy_notice_programs` row,
 *     the sharing grid, and the state lines of "Other important information" (CalFIPA / VT only when the sharing profile
 *     requires it; the CCPA is never cited — Civ. Code §1798.145(e)).
 */
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import type { TimerInstance } from "../../kernel/timers/engine.ts";
import { type PlainDate, addDays, ymd } from "../../kernel/calendar/date.ts";
import type { Consent } from "./esign.ts";
import { initialNoticePlan, annualCycle, policyChange, portalAcknowledgmentFallback } from "./privacy.ts";
import { otherImportantInformation, privacyCopyOnRequest, privacyPortalPosting, annualNoticeAfterTermination } from "./ops.ts";

export interface OpsDeps { readonly events: EventStore; readonly actor: Actor; readonly now: string; }
/** The engine surface the process needs to retire clocks (src/kernel/timers/engine.ts TimerEngine, structurally). */
export interface TimerSurface { open(): readonly TimerInstance[]; cancel(id: string, reason: string, actor?: Actor): void; }

export const PRIVACY_TIMER_CODES = ["REGP_1016_4A1_INITIAL_NOTICE_REASONABLE_30", "REGP_1016_5A_ANNUAL_NOTICE_12M", "REGP_1016_5E2II_ANNUAL_AFTER_CHANGE_100", "REGP_1016_8_REVISED_NOTICE_GATE", "SM_PRIVACY_COPY_ON_REQUEST_5BD"] as const;
export const PRIVACY_TEMPLATES = ["NTC_REGP_1016_4_INITIAL", "NTC_REGP_1016_5_ANNUAL", "NTC_REGP_1016_8_REVISED"] as const;
export type PrivacyTemplate = (typeof PRIVACY_TEMPLATES)[number];
/** `privacy_notice_programs.sharing_profile` (db/migrations/0009_notices.sql). */
export const SHARING_PROFILES = ["exceptions_only", "optout_required", "optin_state"] as const;
export type SharingProfile = (typeof SHARING_PROFILES)[number];
/** `privacy_notice_deliveries.kind` / `.basis` (7.5 data model). */
export const DELIVERY_KINDS = ["initial", "annual", "revised", "courtesy", "on_request"] as const;
export type DeliveryKind = (typeof DELIVERY_KINDS)[number];
export const DELIVERY_BASES = ["mail", "hello_insert", "portal_ack", "website_only"] as const;
export type DeliveryBasis = (typeof DELIVERY_BASES)[number];
export const COPY_REQUEST_CHANNELS = ["chat", "call", "portal", "email", "mail", "sms"] as const;
export type CopyRequestChannel = (typeof COPY_REQUEST_CHANNELS)[number];
/** Rule 5: the §1016.8 "reasonable opportunity" to opt out is 30 days (policy). */
export const OPT_OUT_WINDOW_DAYS = 30;
/** Breach column of SM_PARTNER_PRIVACY_ATTESTATION_0131: no attestation by Mar 31 → default to sending annual notices. */
export const ATTESTATION_DEFAULT_AFTER = (year: number): PlainDate => ymd(year, 3, 31);

export type PartyStatus = "no_notice_due" | "initial_due" | "initial_sent" | "annual_exempt" | "annual_due" | "annual_sent" | "revised_due" | "revised_sent" | "terminated";

/** A `privacy_notice_programs` row plus the partner-approved model-form content the renderer needs (rule 7). */
export interface PrivacyProgram {
  readonly partner_id: string;
  readonly partner_name: string;
  readonly notice_version: string;
  readonly sharing_profile: SharingProfile;
  /** Decision 1: joint notice naming the partner and Supermortgage (default true). */
  readonly joint?: boolean;
  readonly partner_phone?: string;
  readonly partner_url?: string;
  readonly information_types?: readonly string[];
  readonly collection_examples?: readonly string[];
  /** Sharing grid: affiliates' everyday purposes = per partner; marketing = as configured (default No). */
  readonly affiliates_everyday?: boolean;
  readonly marketing?: boolean;
  readonly optout_phone?: string;
  readonly model_form_variant?: string;
}

const isoDate = (s: string, name: string): PlainDate => { if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new RangeError(`${name} must be an ISO date (got ${JSON.stringify(s)})`); return s as PlainDate; };
const nonEmpty = (s: string | undefined, name: string): string => { if (typeof s !== "string" || s.trim() === "") throw new RangeError(`${name} is required`); return s; };
const loanEvents = (events: EventStore, loanId: string, type: string): readonly DomainEvent[] => events.ofType(type).filter((e) => e.loanId === loanId);
const last = <T>(xs: readonly T[]): T | undefined => xs[xs.length - 1];
const forParty = (e: DomainEvent, partyId: string): boolean => e.payload.party_id === undefined || e.payload.party_id === partyId;
/** The domain's two-valued profile (privacy.ts): anything beyond the §§1016.13–.15 exceptions is "broader". */
export const domainProfile = (p: SharingProfile): "exceptions_only" | "broader" => (p === "exceptions_only" ? "exceptions_only" : "broader");

// ---- initial notice: trigger and deliveries -----------------------------------------------------------------------------

export type InitialNoticeTrigger =
  | { readonly kind: "msr_acquisition"; readonly loan_id: string; readonly party_id: string; readonly partner_id: string; readonly transfer_date: PlainDate; readonly transfer_file_id?: string }
  | { readonly kind: "assumption"; readonly loan_id: string; readonly party_id: string; readonly assumption_date: PlainDate; readonly sii_case_id: string };

export interface InitialDuePayload extends Record<string, unknown> { party_id: string; reason: "msr_acquisition" | "assumption"; anchor_date: PlainDate; due_on: PlainDate; hello_notice_by: PlainDate | null; template: "NTC_REGP_1016_4_INITIAL"; basis: DeliveryBasis; timer: "REGP_1016_4A1_INITIAL_NOTICE_REASONABLE_30"; }

/**
 * Rule 2 / 3: the initial notice is due only when the partner acquires servicing rights (transfer-in with an MSR sale) or a
 * party becomes a new customer by assumption (§1016.4(c)(2), (e)(2)(i)); it may follow "within a reasonable time" —
 * with the hello notice (15 days) and never later than 30 days (policy). Appends the inbound record and `privacy.initial_due`.
 */
export function privacyInitialNoticeDue(deps: OpsDeps, t: InitialNoticeTrigger): { inbound: DomainEvent; due: DomainEvent<InitialDuePayload>; plan: ReturnType<typeof initialNoticePlan> } {
  nonEmpty(t.loan_id, "loan_id"); nonEmpty(t.party_id, "party_id");
  if (last(loanEvents(deps.events, t.loan_id, "privacy.relationship.terminated"))) throw new RangeError(`privacy relationship on ${t.loan_id} is terminated (§1016.5(b)); a new relationship needs a new boarding`);
  let inbound: DomainEvent; let anchor: PlainDate;
  if (t.kind === "msr_acquisition") {
    anchor = isoDate(t.transfer_date, "transfer_date"); nonEmpty(t.partner_id, "partner_id");
    inbound = deps.events.append({ type: "transfer_in.msr_acquired_by_partner", loanId: t.loan_id, actor: deps.actor, payload: { transfer_date: anchor, partner_id: t.partner_id, party_id: t.party_id, transfer_file_id: t.transfer_file_id ?? null, scenario: "partner buys MSR and names Supermortgage subservicer (Section 1 scenario (c))" } });
  } else {
    anchor = isoDate(t.assumption_date, "assumption_date"); nonEmpty(t.sii_case_id, "sii_case_id");
    inbound = deps.events.append({ type: "sii.assumption.confirmed", loanId: t.loan_id, aggregate: { kind: "case", id: t.sii_case_id }, actor: deps.actor, payload: { assumption_date: anchor, party_id: t.party_id, sii_case_id: t.sii_case_id } });
  }
  const plan = initialNoticePlan(anchor);
  const due = deps.events.append<InitialDuePayload>({ type: "privacy.initial_due", loanId: t.loan_id, actor: deps.actor, causationId: inbound.id, payload: {
    party_id: t.party_id, reason: t.kind, anchor_date: anchor, due_on: plan.due_on, hello_notice_by: t.kind === "msr_acquisition" ? plan.hello_notice_by : null, template: plan.template, basis: t.kind === "msr_acquisition" ? plan.basis : "mail", timer: plan.timer } });
  return { inbound, due, plan };
}

/** Rule 2 / §1016.4(d): a master-to-subservicer or subservicer-to-subservicer move generates no initial notice; the partner's version is recorded from the transfer file. */
export function recordPartnerNoticeOnFile(deps: OpsDeps, f: { loan_id: string; party_id: string; transfer: "master_to_sub" | "sub_to_sub"; partner_notice_version: string; partner_notice_date: PlainDate; courtesy_copy?: boolean; sent_on?: PlainDate }): { initial_notice: false; recorded: { partner_privacy_notice_version: string; partner_privacy_notice_date: PlainDate }; event: DomainEvent; courtesy: DomainEvent<NoticeSentPayload> | null } {
  nonEmpty(f.loan_id, "loan_id"); nonEmpty(f.party_id, "party_id"); nonEmpty(f.partner_notice_version, "partner_notice_version");
  const on = isoDate(f.partner_notice_date, "partner_notice_date");
  if (f.transfer !== "master_to_sub" && f.transfer !== "sub_to_sub") throw new RangeError(`transfer ${String(f.transfer)}: an MSR acquisition or assumption takes privacyInitialNoticeDue`);
  const recorded = { partner_privacy_notice_version: f.partner_notice_version, partner_privacy_notice_date: on };
  const event = deps.events.append({ type: "privacy.partner_notice.recorded", loanId: f.loan_id, actor: deps.actor, payload: { party_id: f.party_id, transfer: f.transfer, ...recorded, initial_notice: false, basis: "§1016.4(d): the partner's existing notice stands" } });
  let courtesy: DomainEvent<NoticeSentPayload> | null = null;
  if (f.courtesy_copy) {
    const sent_on = f.sent_on ? isoDate(f.sent_on, "sent_on") : isoDate(deps.now.slice(0, 10), "now");
    courtesy = deps.events.append<NoticeSentPayload>({ type: "notice.sent", loanId: f.loan_id, actor: deps.actor, causationId: event.id, payload: { template: "NTC_REGP_1016_4_INITIAL", kind: "courtesy", basis: "hello_insert", party_id: f.party_id, sent_on, notice_version: f.partner_notice_version, channel: "mail", label: "partner's current privacy notice (courtesy copy; not an initial notice)" } });
  }
  return { initial_notice: false, recorded, event, courtesy };
}

export interface NoticeSentPayload extends Record<string, unknown> { template: PrivacyTemplate; kind: DeliveryKind; basis: DeliveryBasis; party_id: string; sent_on: PlainDate; notice_version: string; channel: "mail" | "electronic"; }
export interface InitialSentPayload extends Record<string, unknown> { template: "NTC_REGP_1016_4_INITIAL" | "NTC_REGP_1016_8_REVISED"; basis: DeliveryBasis; party_id: string; sent_on: PlainDate; notice_version: string; annual_timing_basis: "initial_notice" | "revised_notice"; }

/** The open `privacy.initial_due` on the loan for the party (none once `privacy.initial_sent` follows it). */
export function initialNoticeDueFor(events: EventStore, loanId: string, partyId: string): DomainEvent | null {
  const due = last(loanEvents(events, loanId, "privacy.initial_due").filter((e) => forParty(e, partyId)));
  if (!due) return null;
  const sent = loanEvents(events, loanId, "privacy.initial_sent").some((e) => forParty(e, partyId) && e.sequence > due.sequence);
  return sent ? null : due;
}

function appendInitialSent(deps: OpsDeps, f: { loan_id: string; party_id: string; sent_on: PlainDate; basis: DeliveryBasis; notice_version: string; channel: "mail" | "electronic"; extra?: Record<string, unknown> }): { sent: DomainEvent<NoticeSentPayload>; initial_sent: DomainEvent<InitialSentPayload> } {
  const due = initialNoticeDueFor(deps.events, f.loan_id, f.party_id);
  if (!due) throw new RangeError(`no initial notice is due on ${f.loan_id} for ${f.party_id} (rule 2: only an MSR acquisition or an assumption makes one due; a master-to-subservicer move keeps the partner's notice)`);
  const sent = deps.events.append<NoticeSentPayload>({ type: "notice.sent", loanId: f.loan_id, actor: deps.actor, causationId: due.id, payload: { template: "NTC_REGP_1016_4_INITIAL", kind: "initial", basis: f.basis, party_id: f.party_id, sent_on: f.sent_on, notice_version: f.notice_version, channel: f.channel, ...(f.extra ?? {}) } });
  const initial_sent = deps.events.append<InitialSentPayload>({ type: "privacy.initial_sent", loanId: f.loan_id, actor: deps.actor, causationId: sent.id, payload: { template: "NTC_REGP_1016_4_INITIAL", basis: f.basis, party_id: f.party_id, sent_on: f.sent_on, notice_version: f.notice_version, annual_timing_basis: "initial_notice" } });
  return { sent, initial_sent };
}

/** Rule 3 / 6: the initial notice by mail — as an insert with the RESPA hello notice or standalone. */
export function sendInitialPrivacyNotice(deps: OpsDeps, f: { loan_id: string; party_id: string; sent_on: PlainDate; basis: "mail" | "hello_insert"; notice_version: string; hello_notice_id?: string }): { sent: DomainEvent<NoticeSentPayload>; initial_sent: DomainEvent<InitialSentPayload> } {
  nonEmpty(f.loan_id, "loan_id"); nonEmpty(f.party_id, "party_id"); nonEmpty(f.notice_version, "notice_version");
  if (f.basis !== "mail" && f.basis !== "hello_insert") throw new RangeError(`basis ${String(f.basis)}: a mailed initial notice is 'mail' or 'hello_insert'; electronic delivery takes postInitialNoticeToPortal`);
  if (f.basis === "hello_insert") nonEmpty(f.hello_notice_id, "hello_notice_id");
  return appendInitialSent(deps, { loan_id: f.loan_id, party_id: f.party_id, sent_on: isoDate(f.sent_on, "sent_on"), basis: f.basis, notice_version: f.notice_version, channel: "mail", extra: { hello_notice_id: f.hello_notice_id ?? null } });
}

const eConsented = (c: Consent | null | undefined): boolean => !!c && c.status === "active" && c.classes.includes("privacy_notices");

/** Rule 6 / §1016.9(b)(1)(iii): an e-consented (`privacy_notices` class) initial notice is posted with a required acknowledgment; the posting is the delivery (`basis=portal_ack`). */
export function postInitialNoticeToPortal(deps: OpsDeps, f: { loan_id: string; party_id: string; posted_on: PlainDate; consent: Consent | null; notice_version: string }): { sent: DomainEvent<NoticeSentPayload>; initial_sent: DomainEvent<InitialSentPayload>; acknowledgment_required: true; paper_fallback_on: PlainDate } {
  nonEmpty(f.loan_id, "loan_id"); nonEmpty(f.party_id, "party_id"); nonEmpty(f.notice_version, "notice_version");
  const posted_on = isoDate(f.posted_on, "posted_on");
  if (!eConsented(f.consent)) throw new RangeError(`party ${f.party_id} has no active E-SIGN consent for the privacy_notices class (7.4); mail the initial notice (sendInitialPrivacyNotice)`);
  if (f.consent!.party_id !== f.party_id) throw new RangeError(`consent belongs to ${f.consent!.party_id}, not ${f.party_id}`);
  const paper_fallback_on = portalAcknowledgmentFallback(posted_on);
  const r = appendInitialSent(deps, { loan_id: f.loan_id, party_id: f.party_id, sent_on: posted_on, basis: "portal_ack", notice_version: f.notice_version, channel: "electronic", extra: { acknowledgment_required: true, posted_on, acknowledged_at: null, paper_fallback_on, consent_class: "privacy_notices" } });
  return { ...r, acknowledgment_required: true, paper_fallback_on };
}

/** The portal's acknowledgment capture (7.4) → `privacy.notice.acknowledged{acknowledged_at}` stored against the posting. */
export function recordPortalAcknowledgment(deps: OpsDeps, f: { loan_id: string; party_id: string; acknowledged_at: string }): { event: DomainEvent; posting: DomainEvent<NoticeSentPayload> } {
  const posting = latestPosting(deps.events, f.loan_id, f.party_id);
  if (!posting) throw new RangeError(`no portal posting on ${f.loan_id} for ${f.party_id} to acknowledge`);
  if (Number.isNaN(Date.parse(f.acknowledged_at))) throw new RangeError(`acknowledged_at must be an ISO instant`);
  if (Date.parse(f.acknowledged_at) < Date.parse(posting.occurredAt) - 86_400_000) throw new RangeError(`acknowledged_at ${f.acknowledged_at} precedes the posting`);
  const event = deps.events.append({ type: "privacy.notice.acknowledged", loanId: f.loan_id, actor: deps.actor, causationId: posting.id, payload: { party_id: f.party_id, template: posting.payload.template, kind: posting.payload.kind, acknowledged_at: f.acknowledged_at, posting_event_id: posting.id } });
  return { event, posting };
}

function latestPosting(events: EventStore, loanId: string, partyId: string): DomainEvent<NoticeSentPayload> | undefined {
  return last(loanEvents(events, loanId, "notice.sent").filter((e) => e.payload.basis === "portal_ack" && e.payload.template === "NTC_REGP_1016_4_INITIAL" && forParty(e, partyId))) as DomainEvent<NoticeSentPayload> | undefined;
}

/** Daily sweep (rule 6; T6): a posting unacknowledged 30 days after `posted_on` gets a paper copy mailed — once. */
export function portalAcknowledgmentSweep(deps: OpsDeps, f: { loan_id: string; party_id: string; today: PlainDate }): { acknowledgment_required: true; acknowledged_at: string | null; paper_fallback_on: PlainDate; mail_paper: boolean; paper: DomainEvent<NoticeSentPayload> | null } {
  const today = isoDate(f.today, "today");
  const posting = latestPosting(deps.events, f.loan_id, f.party_id);
  if (!posting) throw new RangeError(`no portal posting on ${f.loan_id} for ${f.party_id}`);
  const ack = last(loanEvents(deps.events, f.loan_id, "privacy.notice.acknowledged").filter((e) => forParty(e, f.party_id) && e.sequence > posting.sequence));
  const r = privacyPortalPosting({ posted_on: posting.payload.posted_on as PlainDate, acknowledged_at: ack ? String(ack.payload.acknowledged_at) : null, today });
  const alreadyMailed = loanEvents(deps.events, f.loan_id, "notice.sent").some((e) => e.sequence > posting.sequence && e.payload.paper_fallback === true && forParty(e, f.party_id));
  let paper: DomainEvent<NoticeSentPayload> | null = null;
  if (r.mail_paper && !alreadyMailed) {
    paper = deps.events.append<NoticeSentPayload>({ type: "notice.sent", loanId: f.loan_id, actor: deps.actor, causationId: posting.id, payload: { template: "NTC_REGP_1016_4_INITIAL", kind: "initial", basis: "mail", party_id: f.party_id, sent_on: today, notice_version: String(posting.payload.notice_version), channel: "mail", paper_fallback: true, posting_event_id: posting.id, reason: "no portal acknowledgment within 30 days (rule 6)" } });
  }
  return { acknowledgment_required: true, acknowledged_at: r.acknowledged_at, paper_fallback_on: r.paper_fallback_on, mail_paper: r.mail_paper && !alreadyMailed, paper };
}

// ---- annual cycle: attestation and the §1016.5(e) exception ------------------------------------------------------------

export interface AttestationPayload extends Record<string, unknown> { partner_id: string; year: number; attestation_id: string; no_change: boolean; received_on: PlainDate; late: boolean; document_id: string | null; }

/** Partner attestation feed (each January): "no policy change" evidence for the 1016.5(e) determination → `partner.privacy_attestation.received`. */
export function partnerAttestationReceived(deps: OpsDeps, f: { partner_id: string; year: number; attestation_id: string; no_change: boolean; received_on: PlainDate; document_id?: string }): { event: DomainEvent<AttestationPayload>; late: boolean } {
  nonEmpty(f.partner_id, "partner_id"); nonEmpty(f.attestation_id, "attestation_id");
  if (!Number.isInteger(f.year) || f.year < 2000) throw new RangeError(`year ${String(f.year)} is not a calendar year`);
  if (typeof f.no_change !== "boolean") throw new RangeError("no_change must be a boolean attestation");
  const received_on = isoDate(f.received_on, "received_on");
  const late = received_on > ymd(f.year, 1, 31);
  const event = deps.events.append<AttestationPayload>({ type: "partner.privacy_attestation.received", aggregate: { kind: "partner", id: f.partner_id }, actor: deps.actor, payload: { partner_id: f.partner_id, year: f.year, attestation_id: f.attestation_id, no_change: f.no_change, received_on, late, document_id: f.document_id ?? null } });
  return { event, late };
}

/** Jan 2 calendar job: opens the annual cycle (`privacy.annual_cycle.opened`) — an input, never a satisfaction of REGP_1016_5A. */
export function openAnnualCycle(deps: OpsDeps, f: { year: number; partner_id: string }): DomainEvent {
  nonEmpty(f.partner_id, "partner_id");
  if (!Number.isInteger(f.year) || f.year < 2000) throw new RangeError(`year ${String(f.year)} is not a calendar year`);
  return deps.events.append({ type: "privacy.annual_cycle.opened", aggregate: { kind: "partner", id: f.partner_id }, actor: deps.actor, payload: { year: f.year, opened_on: ymd(f.year, 1, 2), partner_id: f.partner_id, determination: "§1016.5(e) exception test (rule 4)" } });
}

export type AnnualCycleOutcome =
  | { status: "terminated"; annual_notice: false; event: null }
  | { status: "awaiting_attestation"; annual_notice: null; default_on: PlainDate; event: null }
  | { status: "exception_applied"; annual_notice: false; attestation_id: string; event: DomainEvent<AnnualExceptionPayload> }
  | { status: "annual_due"; annual_notice: true; annual_by: PlainDate; attestation_defaulted: boolean; event: DomainEvent };
export interface AnnualExceptionPayload extends Record<string, unknown> { year: number; attestation_id: string; template: null; outcome: "exception_applied"; party_id: string; sharing_profile: SharingProfile; }
export interface AnnualSentPayload extends Record<string, unknown> { year: number; attestation_id: string | null; template: "NTC_REGP_1016_5_ANNUAL"; outcome: "annual_sent"; party_id: string; sent_on: PlainDate; basis: DeliveryBasis; annual_by: PlainDate; }

/**
 * Rule 4 (Jan 2 each year): `annual_exception_eligible = sharing_profile == exceptions_only AND no change per partner
 * attestation` → `privacy.annual_exception.applied` with the attestation id and no mailing; otherwise annual notices by
 * Dec 31 (`privacy.annual_due`). Without an attestation the determination waits until Mar 31, then defaults to mailing.
 */
export function applyAnnualCycle(deps: OpsDeps, f: { loan_id: string; party_id: string; year: number; program: PrivacyProgram; attestation: { attestation_id: string; no_change: boolean } | null; today: PlainDate }): AnnualCycleOutcome {
  nonEmpty(f.loan_id, "loan_id"); nonEmpty(f.party_id, "party_id");
  const today = isoDate(f.today, "today");
  if (!Number.isInteger(f.year)) throw new RangeError(`year ${String(f.year)} is not a calendar year`);
  const term = last(loanEvents(deps.events, f.loan_id, "privacy.relationship.terminated").filter((e) => forParty(e, f.party_id)));
  if (term && !annualNoticeAfterTermination({ terminated_on: term.payload.on as PlainDate, notice_year: f.year }).annual_notice) return { status: "terminated", annual_notice: false, event: null };
  const defaultOn = addDays(ATTESTATION_DEFAULT_AFTER(f.year), 1);
  if (!f.attestation && today < defaultOn) return { status: "awaiting_attestation", annual_notice: null, default_on: defaultOn, event: null };
  const attestation_defaulted = !f.attestation;
  const a = annualCycle({ sharing_profile: domainProfile(f.program.sharing_profile), attested_no_change: f.attestation?.no_change ?? false, attestation_id: f.attestation?.attestation_id ?? null, year: f.year });
  if (!a.mailing) {
    const event = deps.events.append<AnnualExceptionPayload>({ type: "privacy.annual_exception.applied", loanId: f.loan_id, actor: deps.actor, payload: { year: f.year, attestation_id: f.attestation!.attestation_id, template: null, outcome: "exception_applied", party_id: f.party_id, sharing_profile: f.program.sharing_profile } });
    return { status: "exception_applied", annual_notice: false, attestation_id: f.attestation!.attestation_id, event };
  }
  const event = deps.events.append({ type: "privacy.annual_due", loanId: f.loan_id, actor: deps.actor, payload: { year: f.year, annual_by: a.annual_by, party_id: f.party_id, sharing_profile: f.program.sharing_profile, attestation_id: f.attestation?.attestation_id ?? null, attestation_defaulted, reason: attestation_defaulted ? "no partner attestation by Mar 31 — default to sending annual notices (conservative)" : f.attestation!.no_change ? "sharing profile is not exceptions_only" : "partner attested a change in practices" } });
  return { status: "annual_due", annual_notice: true, annual_by: a.annual_by!, attestation_defaulted, event };
}

/** The annual mailing (§1016.5(a); also the §1016.5(e)(2)(ii) 100-day notice): `notice.sent{template=NTC_REGP_1016_5_ANNUAL}` + `privacy.annual_sent{outcome=annual_sent}`. */
export function sendAnnualPrivacyNotice(deps: OpsDeps, f: { loan_id: string; party_id: string; year: number; sent_on: PlainDate; basis: DeliveryBasis; notice_version: string; consent?: Consent | null }): { sent: DomainEvent<NoticeSentPayload>; annual_sent: DomainEvent<AnnualSentPayload> } {
  nonEmpty(f.loan_id, "loan_id"); nonEmpty(f.party_id, "party_id"); nonEmpty(f.notice_version, "notice_version");
  const sent_on = isoDate(f.sent_on, "sent_on");
  if (!DELIVERY_BASES.includes(f.basis)) throw new RangeError(`basis ${String(f.basis)} is not one of ${DELIVERY_BASES.join(", ")}`);
  if ((f.basis === "website_only" || f.basis === "portal_ack") && !eConsented(f.consent)) throw new RangeError(`electronic annual delivery (${f.basis}) needs active privacy_notices e-consent (§1016.9(c)(1)); mail it`);
  if (last(loanEvents(deps.events, f.loan_id, "privacy.relationship.terminated").filter((e) => forParty(e, f.party_id)))) throw new RangeError(`privacy relationship on ${f.loan_id} is terminated: no annual notice (§1016.5(b))`);
  const due = last(loanEvents(deps.events, f.loan_id, "privacy.annual_due").filter((e) => forParty(e, f.party_id) && e.payload.year === f.year));
  const annual_by = (due?.payload.annual_by as PlainDate | undefined) ?? ymd(f.year, 12, 31);
  const sent = deps.events.append<NoticeSentPayload>({ type: "notice.sent", loanId: f.loan_id, actor: deps.actor, ...(due ? { causationId: due.id } : {}), payload: { template: "NTC_REGP_1016_5_ANNUAL", kind: "annual", basis: f.basis, party_id: f.party_id, sent_on, notice_version: f.notice_version, channel: f.basis === "website_only" || f.basis === "portal_ack" ? "electronic" : "mail", year: f.year } });
  const annual_sent = deps.events.append<AnnualSentPayload>({ type: "privacy.annual_sent", loanId: f.loan_id, actor: deps.actor, causationId: sent.id, payload: { year: f.year, attestation_id: (due?.payload.attestation_id as string | null | undefined) ?? null, template: "NTC_REGP_1016_5_ANNUAL", outcome: "annual_sent", party_id: f.party_id, sent_on, basis: f.basis, annual_by } });
  return { sent, annual_sent };
}

// ---- policy changes: revised notice, opt-out window, sharing gate ----------------------------------------------------------

export interface PolicyChangedPayload extends Record<string, unknown> { partner_id: string; change_date: PlainDate; new_sharing: boolean; exception_lost: boolean; description: string; revised_notice_required: boolean; annual_notice_due: PlainDate | null; gate: "REGP_1016_8_REVISED_NOTICE_GATE" | null; }

/** Partner change-control feed (rule 5): `privacy_policy.changed{new_sharing, exception_lost, change_date}` and the §1016.8 assessment. New sharing outside the exceptions always ends the exception. */
export function recordPolicyChange(deps: OpsDeps, f: { partner_id: string; loan_id: string; change_date: PlainDate; new_sharing: boolean; exception_lost: boolean; description: string }): { event: DomainEvent<PolicyChangedPayload>; assessment: ReturnType<typeof policyChange> } {
  nonEmpty(f.partner_id, "partner_id"); nonEmpty(f.loan_id, "loan_id"); nonEmpty(f.description, "description");
  const change_date = isoDate(f.change_date, "change_date");
  if (typeof f.new_sharing !== "boolean" || typeof f.exception_lost !== "boolean") throw new RangeError("new_sharing and exception_lost must be booleans");
  const exception_lost = f.new_sharing || f.exception_lost;
  const assessment = policyChange(f.new_sharing, exception_lost, change_date);
  const event = deps.events.append<PolicyChangedPayload>({ type: "privacy_policy.changed", loanId: f.loan_id, aggregate: { kind: "partner", id: f.partner_id }, actor: deps.actor, payload: { partner_id: f.partner_id, change_date, new_sharing: f.new_sharing, exception_lost, description: f.description, revised_notice_required: assessment.revised_notice, annual_notice_due: assessment.annual_notice_due, gate: assessment.gate } });
  return { event, assessment };
}

/** The pending new-sharing change (a `privacy_policy.changed{new_sharing=true}` with no revised notice sent after it). */
function pendingNewSharing(events: EventStore, loanId: string): DomainEvent | null {
  const change = last(loanEvents(events, loanId, "privacy_policy.changed").filter((e) => e.payload.new_sharing === true));
  if (!change) return null;
  return loanEvents(events, loanId, "privacy.revised_notice.sent").some((e) => e.sequence > change.sequence) ? null : change;
}

export interface RevisedSentPayload extends Record<string, unknown> { template: "NTC_REGP_1016_8_REVISED"; party_id: string; sent_on: PlainDate; optout_days: number; opt_out_window_ends: PlainDate; sharing_allowed_from: PlainDate; annual_clock_restarts_from: PlainDate; notice_version: string; basis: DeliveryBasis; }

/**
 * §1016.8 / rule 5: the revised notice with a 30-day opt-out window (policy) before any sharing; the send restarts the
 * annual clock (§1016.5(e)(2)(i): treated as the initial notice for annual timing) — the prior REGP_1016_5A instance is
 * retired and `privacy.initial_sent{annual_timing_basis=revised_notice}` re-arms it from the send date.
 */
export function sendRevisedPrivacyNotice(deps: OpsDeps, f: { loan_id: string; party_id: string; sent_on: PlainDate; optout_days?: number; notice_version: string; basis: DeliveryBasis; timers?: TimerSurface }): { sent: DomainEvent<NoticeSentPayload>; revised: DomainEvent<RevisedSentPayload>; annual_restart: DomainEvent<InitialSentPayload>; retired_timers: string[] } {
  nonEmpty(f.loan_id, "loan_id"); nonEmpty(f.party_id, "party_id"); nonEmpty(f.notice_version, "notice_version");
  const sent_on = isoDate(f.sent_on, "sent_on");
  const optout_days = f.optout_days ?? OPT_OUT_WINDOW_DAYS;
  if (!Number.isInteger(optout_days) || optout_days < OPT_OUT_WINDOW_DAYS) throw new RangeError(`optout_days ${String(optout_days)}: the reasonable opportunity to opt out is at least ${OPT_OUT_WINDOW_DAYS} days (§1016.8(a)(3); policy)`);
  const change = pendingNewSharing(deps.events, f.loan_id);
  if (!change) throw new RangeError(`no pending privacy_policy.changed{new_sharing=true} on ${f.loan_id}: a revised notice is issued only for new sharing outside the exceptions (§1016.8)`);
  if (sent_on < (change.payload.change_date as PlainDate)) throw new RangeError(`sent_on ${sent_on} precedes the change date ${String(change.payload.change_date)}`);
  const p = policyChange(true, true, change.payload.change_date as PlainDate, sent_on);
  const opt_out_window_ends = addDays(sent_on, optout_days);
  const sharing_allowed_from = addDays(opt_out_window_ends, 1);
  const sent = deps.events.append<NoticeSentPayload>({ type: "notice.sent", loanId: f.loan_id, actor: deps.actor, causationId: change.id, payload: { template: "NTC_REGP_1016_8_REVISED", kind: "revised", basis: f.basis, party_id: f.party_id, sent_on, notice_version: f.notice_version, channel: f.basis === "portal_ack" || f.basis === "website_only" ? "electronic" : "mail", optout_days } });
  const revised = deps.events.append<RevisedSentPayload>({ type: "privacy.revised_notice.sent", loanId: f.loan_id, actor: deps.actor, causationId: sent.id, payload: { template: "NTC_REGP_1016_8_REVISED", party_id: f.party_id, sent_on, optout_days, opt_out_window_ends, sharing_allowed_from, annual_clock_restarts_from: p.annual_clock_restarts_from!, notice_version: f.notice_version, basis: f.basis } });
  const retired_timers: string[] = [];
  if (f.timers) for (const i of f.timers.open()) if (i.loanId === f.loan_id && i.code === "REGP_1016_5A_ANNUAL_NOTICE_12M") { f.timers.cancel(i.id, "§1016.5(e)(2)(i): the revised notice restarts the annual clock", deps.actor); retired_timers.push(i.code); }
  const annual_restart = deps.events.append<InitialSentPayload>({ type: "privacy.initial_sent", loanId: f.loan_id, actor: deps.actor, causationId: revised.id, payload: { template: "NTC_REGP_1016_8_REVISED", basis: f.basis, party_id: f.party_id, sent_on, notice_version: f.notice_version, annual_timing_basis: "revised_notice" } });
  return { sent, revised, annual_restart, retired_timers };
}

/** Daily calendar job: once the opt-out window of the latest revised notice has run, `privacy.revised_notice.optout_window_elapsed` closes REGP_1016_8_REVISED_NOTICE_GATE. */
export function closeOptOutWindow(deps: OpsDeps, f: { loan_id: string; today: PlainDate }): { elapsed: boolean; window_ends: PlainDate; sharing_allowed_from: PlainDate; event: DomainEvent | null; opted_out: string[] } {
  const today = isoDate(f.today, "today");
  const revised = last(loanEvents(deps.events, f.loan_id, "privacy.revised_notice.sent")) as DomainEvent<RevisedSentPayload> | undefined;
  if (!revised) throw new RangeError(`no revised privacy notice on ${f.loan_id}`);
  const window_ends = revised.payload.opt_out_window_ends, sharing_allowed_from = revised.payload.sharing_allowed_from;
  const opted_out = loanEvents(deps.events, f.loan_id, "privacy.optout.recorded").filter((e) => e.sequence > revised.sequence).map((e) => String(e.payload.party_id));
  const already = last(loanEvents(deps.events, f.loan_id, "privacy.revised_notice.optout_window_elapsed").filter((e) => e.sequence > revised.sequence));
  if (today < sharing_allowed_from) return { elapsed: false, window_ends, sharing_allowed_from, event: null, opted_out };
  const event = already ?? deps.events.append({ type: "privacy.revised_notice.optout_window_elapsed", loanId: f.loan_id, actor: deps.actor, causationId: revised.id, payload: { window_ended: window_ends, sharing_allowed_from, elapsed_on: today, opted_out, template: "NTC_REGP_1016_8_REVISED", gate: "REGP_1016_8_REVISED_NOTICE_GATE" } });
  return { elapsed: true, window_ends, sharing_allowed_from, event, opted_out };
}

/** §1016.7: an opt-out direction (any time; honored as soon as reasonably practicable) → `privacy.optout.recorded`; the confirmation template is dormant unless the profile shares outside the exceptions. */
export function recordOptOut(deps: OpsDeps, f: { loan_id: string; party_id: string; received_on: PlainDate; choices: readonly string[]; program: PrivacyProgram }): { event: DomainEvent; confirmation: "NTC_REGP_OPT_OUT_CONFIRMATION" | null } {
  nonEmpty(f.loan_id, "loan_id"); nonEmpty(f.party_id, "party_id");
  const received_on = isoDate(f.received_on, "received_on");
  if (!f.choices.length) throw new RangeError("choices are required");
  const event = deps.events.append({ type: "privacy.optout.recorded", loanId: f.loan_id, actor: deps.actor, payload: { party_id: f.party_id, received_on, choices: [...f.choices], honored_by: addDays(received_on, 30) } });
  return { event, confirmation: domainProfile(f.program.sharing_profile) === "broader" ? "NTC_REGP_OPT_OUT_CONFIRMATION" : null };
}

/** Guardrail: any data export tagged `marketing_share` is hard-blocked while REGP_1016_8_REVISED_NOTICE_GATE is open, and never covers an opted-out party (enforced here, in the export layer — not by prompt). */
export function marketingShareGate(events: EventStore, f: { loan_id: string; party_id: string }): { allowed: boolean; reason: string; gate: "REGP_1016_8_REVISED_NOTICE_GATE" | null; blocked_until: PlainDate | null } {
  const change = last(loanEvents(events, f.loan_id, "privacy_policy.changed").filter((e) => e.payload.new_sharing === true));
  if (!change) return { allowed: false, reason: "no privacy notice discloses nonaffiliate marketing sharing (sharing stays within §§1016.13–.15)", gate: null, blocked_until: null };
  const revised = last(loanEvents(events, f.loan_id, "privacy.revised_notice.sent").filter((e) => e.sequence > change.sequence)) as DomainEvent<RevisedSentPayload> | undefined;
  const elapsed = revised ? last(loanEvents(events, f.loan_id, "privacy.revised_notice.optout_window_elapsed").filter((e) => e.sequence > revised.sequence)) : undefined;
  if (!revised) return { allowed: false, reason: "revised notice not yet sent (§1016.8)", gate: "REGP_1016_8_REVISED_NOTICE_GATE", blocked_until: null };
  if (!elapsed) return { allowed: false, reason: `opt-out window runs through ${revised.payload.opt_out_window_ends}`, gate: "REGP_1016_8_REVISED_NOTICE_GATE", blocked_until: revised.payload.opt_out_window_ends };
  if (loanEvents(events, f.loan_id, "privacy.optout.recorded").some((e) => e.payload.party_id === f.party_id)) return { allowed: false, reason: `party ${f.party_id} opted out (§1016.7)`, gate: null, blocked_until: null };
  return { allowed: true, reason: `revised notice sent ${revised.payload.sent_on}; opt-out window ended ${revised.payload.opt_out_window_ends}`, gate: null, blocked_until: null };
}

/** The export layer's check: a refused `marketing_share` export leaves `privacy.export.blocked`; other tags are not privacy-gated. */
export function marketingShareExport(deps: OpsDeps, f: { loan_id: string; party_id: string; tag: string; export_id?: string }): { allowed: boolean; reason: string; gate: "REGP_1016_8_REVISED_NOTICE_GATE" | null; event: DomainEvent | null } {
  nonEmpty(f.loan_id, "loan_id"); nonEmpty(f.party_id, "party_id"); nonEmpty(f.tag, "tag");
  if (f.tag !== "marketing_share") return { allowed: true, reason: `tag ${f.tag} is not privacy-gated`, gate: null, event: null };
  const g = marketingShareGate(deps.events, f);
  if (g.allowed) return { allowed: true, reason: g.reason, gate: null, event: null };
  const event = deps.events.append({ type: "privacy.export.blocked", loanId: f.loan_id, actor: deps.actor, payload: { party_id: f.party_id, tag: f.tag, export_id: f.export_id ?? null, reason: g.reason, gate: g.gate, blocked_until: g.blocked_until } });
  return { allowed: false, reason: g.reason, gate: g.gate, event };
}

// ---- copies on request ------------------------------------------------------------------------------------------------------

/** The notice currently in force for the loan: the latest revised notice, else the initial notice on file. */
export function currentPrivacyNotice(events: EventStore, loanId: string): { template: PrivacyTemplate; notice_version: string | null; sent_on: PlainDate | null } {
  const revised = last(loanEvents(events, loanId, "privacy.revised_notice.sent"));
  if (revised) return { template: "NTC_REGP_1016_8_REVISED", notice_version: String(revised.payload.notice_version), sent_on: revised.payload.sent_on as PlainDate };
  const initial = last(loanEvents(events, loanId, "privacy.initial_sent"));
  if (initial) return { template: "NTC_REGP_1016_4_INITIAL", notice_version: String(initial.payload.notice_version), sent_on: initial.payload.sent_on as PlainDate };
  const onFile = last(loanEvents(events, loanId, "privacy.partner_notice.recorded"));
  return { template: "NTC_REGP_1016_4_INITIAL", notice_version: onFile ? String(onFile.payload.partner_privacy_notice_version) : null, sent_on: onFile ? (onFile.payload.partner_privacy_notice_date as PlainDate) : null };
}

export interface CopyRequestedPayload extends Record<string, unknown> { party_id: string; channel: CopyRequestChannel; requested_on: PlainDate; send_by: PlainDate; delivery_channel: "electronic" | "mail"; kind: "on_request"; template: PrivacyTemplate; }

/** T9 / policy: a copy requested by any channel (chat, call, portal, …) → `privacy_notice.copy_requested{requested_on}`; the copy goes within 5 servicer business days by the borrower's consented channel. */
export function requestPrivacyCopy(deps: OpsDeps, f: { loan_id: string; party_id: string; channel: CopyRequestChannel; requested_on: PlainDate; consent: Consent | null }): { event: DomainEvent<CopyRequestedPayload>; send_by: PlainDate; channel: "electronic" | "mail"; kind: "on_request"; template: PrivacyTemplate } {
  nonEmpty(f.loan_id, "loan_id"); nonEmpty(f.party_id, "party_id");
  if (!COPY_REQUEST_CHANNELS.includes(f.channel)) throw new RangeError(`channel ${String(f.channel)} is not one of ${COPY_REQUEST_CHANNELS.join(", ")}`);
  const requested_on = isoDate(f.requested_on, "requested_on");
  const r = privacyCopyOnRequest({ requested_on, consent: f.consent && f.consent.party_id === f.party_id ? f.consent : null });
  const { template } = currentPrivacyNotice(deps.events, f.loan_id);
  const event = deps.events.append<CopyRequestedPayload>({ type: "privacy_notice.copy_requested", loanId: f.loan_id, actor: deps.actor, payload: { party_id: f.party_id, channel: f.channel, requested_on, send_by: r.send_by, delivery_channel: r.channel, kind: r.kind, template } });
  return { event, send_by: r.send_by, channel: r.channel, kind: r.kind, template };
}

/** The copy itself: `notice.sent{kind=on_request, template=<current notice>}` by the channel decided at request time (SM_PRIVACY_COPY_ON_REQUEST_5BD). */
export function sendPrivacyCopy(deps: OpsDeps, f: { loan_id: string; party_id: string; sent_on: PlainDate }): { sent: DomainEvent<NoticeSentPayload>; on_time: boolean; send_by: PlainDate } {
  nonEmpty(f.loan_id, "loan_id"); nonEmpty(f.party_id, "party_id");
  const sent_on = isoDate(f.sent_on, "sent_on");
  const req = last(loanEvents(deps.events, f.loan_id, "privacy_notice.copy_requested").filter((e) => forParty(e, f.party_id))) as DomainEvent<CopyRequestedPayload> | undefined;
  if (!req) throw new RangeError(`no privacy copy request on ${f.loan_id} for ${f.party_id}`);
  if (loanEvents(deps.events, f.loan_id, "notice.sent").some((e) => e.sequence > req.sequence && e.payload.kind === "on_request" && forParty(e, f.party_id))) throw new RangeError(`the copy requested ${req.payload.requested_on} was already sent`);
  const current = currentPrivacyNotice(deps.events, f.loan_id);
  const electronic = req.payload.delivery_channel === "electronic";
  const sent = deps.events.append<NoticeSentPayload>({ type: "notice.sent", loanId: f.loan_id, actor: deps.actor, causationId: req.id, payload: { template: current.template, kind: "on_request", basis: electronic ? "portal_ack" : "mail", party_id: f.party_id, sent_on, notice_version: current.notice_version ?? "current", channel: req.payload.delivery_channel, requested_on: req.payload.requested_on, send_by: req.payload.send_by } });
  return { sent, on_time: sent_on <= req.payload.send_by, send_by: req.payload.send_by };
}

// ---- termination and status ---------------------------------------------------------------------------------------------------

/** Rule 9 / §1016.5(b): payoff or transfer-out ends the customer relationship — no further notices; open 7.5 clocks on the loan are cancelled. */
export function terminatePrivacyRelationship(deps: OpsDeps, f: { loan_id: string; party_id: string; reason: "payoff" | "transfer_out"; on: PlainDate; timers?: TimerSurface }): { party_status: "terminated"; event: DomainEvent; cancelled: string[]; annual_notice_this_year: boolean } {
  nonEmpty(f.loan_id, "loan_id"); nonEmpty(f.party_id, "party_id");
  const on = isoDate(f.on, "on");
  if (f.reason !== "payoff" && f.reason !== "transfer_out") throw new RangeError(`reason ${String(f.reason)}: the relationship ends on payoff or transfer-out`);
  const cancelled: string[] = [];
  if (f.timers) for (const i of f.timers.open()) if (i.loanId === f.loan_id && (PRIVACY_TIMER_CODES as readonly string[]).includes(i.code)) { f.timers.cancel(i.id, `privacy relationship terminated (${f.reason} ${on}; §1016.5(b))`, deps.actor); cancelled.push(i.code); }
  const year = Number(on.slice(0, 4));
  const event = deps.events.append({ type: "privacy.relationship.terminated", loanId: f.loan_id, actor: deps.actor, payload: { party_id: f.party_id, reason: f.reason, on, party_status: "terminated", cancelled_timers: cancelled, annual_notice_this_year: annualNoticeAfterTermination({ terminated_on: on, notice_year: year }).annual_notice, former_customer_sharing: "per the notice's former-customer statement" } });
  return { party_status: "terminated", event, cancelled, annual_notice_this_year: false };
}

const STATUS_OF: Record<string, PartyStatus> = {
  "privacy.initial_due": "initial_due", "privacy.initial_sent": "initial_sent", "privacy.annual_exception.applied": "annual_exempt", "privacy.annual_due": "annual_due", "privacy.annual_sent": "annual_sent",
  "privacy.revised_notice.sent": "revised_sent", "privacy.relationship.terminated": "terminated",
};
/** The per-party state machine, read back from the loan's events (no_notice_due → initial_due → initial_sent → annual_exempt | annual_due → annual_sent …; revised_due → revised_sent; terminated). */
export function privacyPartyStatus(events: EventStore, loanId: string, partyId: string): PartyStatus {
  let status: PartyStatus = "no_notice_due";
  for (const e of events.all()) {
    if (e.loanId !== loanId || !forParty(e, partyId)) continue;
    if (e.type === "privacy_policy.changed" && e.payload.new_sharing === true) { status = "revised_due"; continue; }
    if (e.type === "privacy.initial_sent" && e.payload.annual_timing_basis === "revised_notice") continue;   // the annual-clock restart rides the revised send
    const s = STATUS_OF[e.type]; if (s) status = s;
  }
  return status;
}

// ---- content assembly -----------------------------------------------------------------------------------------------------------

/** Rule 7: model-form fields from the program row; "Other important information" carries the state lines (CalFIPA / VT) only when the sharing profile requires them, and never cites the CCPA. */
export function assemblePrivacyNoticePayload(f: { program: PrivacyProgram; property_state: string; kind: "initial" | "annual" | "revised"; basis?: DeliveryBasis; optout_days?: number }): Record<string, unknown> & { state_lines: string[]; sharing_profile: "exceptions_only" | "broader" } {
  const p = f.program; const profile = domainProfile(p.sharing_profile);
  const broader = profile === "broader";
  if (f.kind === "revised" && !broader) throw new RangeError("a revised notice with an opt-out block is issued only when the program shares outside the exceptions (§1016.8)");
  const info = otherImportantInformation({ state: f.property_state, sharing_profile: profile });
  return {
    partner_name: p.partner_name, partner_phone: p.partner_phone ?? "(800) 555-0177", partner_url: p.partner_url ?? "partner.example.com/privacy", joint: p.joint ?? true,
    information_types: [...(p.information_types ?? ["Social Security number and income", "account balances and payment history", "credit history and credit scores"])],
    collection_examples: [...(p.collection_examples ?? ["apply for a loan", "pay your bills", "give us your contact information"])],
    share_marketing: p.marketing ? "Yes" : "No", limit_marketing: p.marketing ? "No" : "We don't share", share_joint: "No", limit_joint: "We don't share",
    share_affiliates_everyday: p.affiliates_everyday ? "Yes" : "No", share_affiliates_credit: "No", limit_affiliates_credit: "We don't share", share_affiliates_marketing: "No", limit_affiliates_marketing: "We don't share",
    share_nonaffiliates: broader ? "Yes" : "No", limit_nonaffiliates: broader ? "Yes" : "We don't share",
    sharing_profile: profile, state_lines: info.lines, cites_ccpa: info.cites_ccpa, optout_phone: p.optout_phone ?? "(800) 555-0188", optout_days: f.optout_days ?? OPT_OUT_WINDOW_DAYS, basis: f.basis ?? "mail",
    notice_version: p.notice_version, model_form_variant: p.model_form_variant ?? "appendix_a", kind: f.kind,
  };
}
