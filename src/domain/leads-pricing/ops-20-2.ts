/**
 * §20.2 Solicitation, marketing and consent compliance — the deterministic rules of the `intake` agent (with
 * `borrower-comms` executing voice/SMS): campaign and creative approval with the Reg Z §1026.24 / MAP Rule (12 CFR
 * 1014) / CAN-SPAM / state / Fannie Mae B2-1.3-04 checklists, the per-touch TCPA/TSR gates (PEWC for AI-voice/SMS
 * marketing to cell phones and AI voice to landlines, national DNC with EBR or written permission, company DNC for
 * five years, 31-day registry versions, quiet hours), the consent-evidence model layered on the servicing `consents`
 * table (7.4), suppression handling against the 10-business-day ceilings and the 24-month MAP archive. One small
 * function per rule / T-id; dates are PlainDate strings on the kernel calendars; nothing here posts to the ledger.
 *
 * Reused, never re-implemented: 11.1's `ingestInboundSms` (STOP keyword → `consent.revoked`, the trigger of
 * `TCPA_64_1200_A10_REVOCATION_HONOR_10BD`, plus the one confirmation text), the kernel calendars (servicer business
 * days for the 10-BD ceilings, federal holidays for the Sunday/holiday voice policy), `wallClock`/`zonedEpochMs`
 * for the called party's local time. `TCPA_64_1200_A1_CELL_CONSENT_GATE` (11.1) and `ESIGN_7001C_CONSENT_GATE` (7.4)
 * are referenced only: an advertisement is not a required disclosure and may be e-mailed without E-SIGN consent.
 *
 * Events (every payload carries `origination: true` so the 20.2 timer rows arm — src/kernel/timers/engine.ts
 * isOriginationContext; `loanId` is set for a servicing customer, else the aggregate is the subject):
 *   campaign.approved{campaign_id, kind, channels} · campaign.launched · campaign.paused · campaign.ended{last_disseminated_on, archive_until}   [campaign.ended anchors REGN_1014_5_RECORDS_24M]
 *   creative.superseded{creative_id, superseded_by, last_disseminated_on, archive_until}   [arms REGN_1014_5_RECORDS_24M]
 *   marketing.archive.verified{creative_id, complete=true, retained_through}   [satisfies it — the MAP archive job proves the record set]
 *   marketing.touch.queued{touch_id, channel, line_class, campaign_kind, …}   [arms the touch gates]
 *   marketing.touch.scheduled{touch_id, scheduled_for, local_time, tz, legal_basis}   [satisfies them — "send permitted"]
 *   marketing.touch.suppressed{touch_id, reason, gates} · marketing.touch.sent{touch_id, channel, opportunity_id, sent_at}   [20.1 writes refi.opportunity.offered from the first sent touch]
 *   marketing.response.received{touch_id, kind, received_on}   [a refinancing reply → 20.3 emits lead.created; the inquiry EBR starts]
 *   marketing.ebr.evaluated{party_id, basis∈{transaction_18m, inquiry_3m, none}, anchor_on, lapses_on}   [arms TCPA_64_1200_F5_EBR_TRANSACTION_18M / _INQUIRY_3M]
 *   marketing.suppression.requested{kind∈{company_dnc, email_optout, sms_stop, mail_optout, all_marketing}, requested_on}   [arms TCPA_64_1200_D3_DNC_REQUEST_10BD / CANSPAM_7704_A4_OPTOUT_10BD]
 *   marketing.suppression.recorded{suppression_id, kind, requested_on, honor_until, processed_at}   [satisfies them; arms TCPA_64_1200_D_COMPANY_DNC_5Y]
 *   marketing.suppression.expired{suppression_id, kind=company_dnc, honor_until}   [satisfies TCPA_64_1200_D_COMPANY_DNC_5Y after the five years]
 *   dnc.scrub.completed{scrub_id, source, registry_version_obtained_at, obtained_on, valid_until}   [arms and re-satisfies TCPA_64_1200_C2_DNC_SCRUB_31]
 *   consent.granted{consent_id, kind, purpose=marketing, written_consent, signature_kind, status} · consent.expired{consent_id, kind, reason=written_confirmation_missing}
 */
import { createHash } from "node:crypto";
import { type PlainDate, addDays, addMonths, addYears, plainDate, dayOfWeek } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { isFederalHoliday } from "../../kernel/calendar/holidays.ts";
import { wallClock, zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import { ingestInboundSms, type InboundSms, type SmsIngestion } from "../early-intervention/ops-11-1.ts";

export const INTAKE_AGENT: Actor = { kind: "agent", id: "intake" };
export const RULE_SET_VERSION_20_2 = "sm.solicitation.2026.v1";
/** Consents name the partner as seller and SM as the caller acting for it (blueprint LoR/SM row). */
export const CALLER_ON_BEHALF = "Supermortgage";
/** §64.1200(c)(2)(i)(D) / TSR §310.4(b)(3)(iv): a registry version obtained no more than 31 days before the call. */
export const DNC_SCRUB_VALIDITY_DAYS = 31;
/** §64.1200(f)(5): 18 months from a transaction, 3 months from an inquiry (TSR: 540 / 90 days). */
export const EBR_TRANSACTION_MONTHS = 18;
export const EBR_INQUIRY_MONTHS = 3;
/** §64.1200(d)(6): a do-not-call request is honored for 5 years. */
export const COMPANY_DNC_YEARS = 5;
/** §64.1200(d)(3) and 15 U.S.C. 7704(a)(4)(A): honored within 10 business days of receipt (policy: immediate at commit). */
export const SUPPRESSION_HONOR_BUSINESS_DAYS = 10;
/** 12 CFR 1014.5: 24 months from the last dissemination. */
export const MAP_ARCHIVE_MONTHS = 24;
/** Open question 1 default: a voice-recorded "yes" is interim evidence until a written channel confirms within 24 h. */
export const INTERIM_CONSENT_CONFIRMATION_HOURS = 24;
/** Rule 5: §64.1200(c)(1) / TSR §310.4(c) 08:00–21:00 called-party local; policy window 09:00–20:00 inside it. */
export const QUIET_HOURS = { rule_open: "08:00", rule_close: "21:00", policy_open: "09:00", policy_close: "20:00" } as const;
/** Worked example 1: the human click-to-dial list for the `mlo_of_record` team is worked at 10:30 called-party local time. */
export const HUMAN_DIAL_LOCAL_TIME = "10:30";
/** §64.1200(b)(3): the opt-out mechanism within two seconds of the identification. */
export const AI_VOICE_OPTOUT_MAX_SECONDS = 2;
/** Rule 6 frequency policy. */
export const FREQUENCY = { voice_per_7_days: 1, voice_total: 3, emails_total: 2, declined_cooldown_days: 90 } as const;
/** §64.1200(a)(12): the one confirmation text — no marketing content. */
export const SMS_STOP_CONFIRMATION_TEXT = "You are unsubscribed from refinance text messages sent by Supermortgage on behalf of your lender. No further marketing texts will be sent to this number.";
export const AI_VOICE_IDENT_TEMPLATE = "NTC_TCPA_64_1200_B_AI_VOICE_IDENT";
export const REFI_OFFER_TEMPLATE = "NTC_REGZ_1026_24_REFI_OFFER";
export const CANSPAM_FOOTER_TEMPLATE = "NTC_CANSPAM_7704_FOOTER";
export const PRESCREEN_TEMPLATE = "NTC_FCRA_615D_PRESCREEN_OPTOUT";
export const AI_DISCLOSURE_TEMPLATE = "NTC_SM_AI_INTERACTION_DISCLOSURE";

export type Channel = "email" | "portal" | "mail" | "sms" | "ai_voice" | "human_voice";
export const CHANNELS: readonly Channel[] = ["email", "portal", "mail", "sms", "ai_voice", "human_voice"];
export type CampaignKind = "refi_trigger_outbound" | "organic_nurture" | "general_advertising" | "prescreen";
export type LineType = "mobile" | "landline" | "voip" | "unknown";
/** §64.1200(a)(1)(iii) cellular / paging / charged-for lines vs (a)(3) residential landlines; VoIP and unknown are treated as charged-for (conservative). */
export type LineClass = "cellular" | "residential_landline" | "unknown";
export type EbrBasis = "transaction_18m" | "inquiry_3m" | "written_permission" | "none";
export type SuppressionKind = "company_dnc" | "email_optout" | "sms_optout" | "mail_optout" | "all_marketing";
export type SuppressionRequestKind = "company_dnc" | "email_optout" | "sms_stop" | "mail_optout" | "all_marketing";
export type SignatureKind = "esign_click_typed_name" | "checkbox_with_text" | "sms_keyword_double_optin" | "wet_ink" | "voice_recording_interim";
export type ConsentStatus = "active" | "pending_written_confirmation" | "expired" | "withdrawn" | "suspect" | "superseded";
export type TouchOutcome = "queued" | "scheduled" | "suppressed" | "sent" | "delivered" | "bounced" | "answered_ai" | "answered_human" | "voicemail_no_message" | "opted_out" | "replied";

const need = (ok: unknown, msg: string): void => { if (!ok) throw new RangeError(msg); };
const nonEmpty = (v: unknown, what: string): string => { if (typeof v !== "string" || !v.trim()) throw new RangeError(`${what} is required`); return v; };
const isoOf = (v: string, what: string): string => { if (!Number.isFinite(Date.parse(v))) throw new RangeError(`${what} must be an ISO instant`); return new Date(v).toISOString(); };
const localDate = (iso: string, tz: string): PlainDate => wallClock(Date.parse(iso), tz).date;
const hhmmToMin = (hhmm: string): number => { const [h, m] = hhmm.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };
const pad = (n: number): string => String(n).padStart(2, "0");
export const contentHash = (text: string): string => createHash("sha256").update(text).digest("hex");
const ORIG = { origination: true } as const;

// ============================================================ consent evidence model (rule 3; TCPA_64_1200_A2/A3 gates)
export interface PewcElements { readonly authorizes_atds_or_artificial_voice: boolean; readonly not_condition_of_purchase: boolean; readonly seller_named: string; readonly caller_on_behalf: string; readonly phone_number_as_entered: string; }
/** A `consents` row (7.4) with the 20.2 marketing columns; kinds reused: tcpa_voice / tcpa_sms with purpose=marketing. */
export interface MarketingConsent {
  readonly consent_id: string; readonly party_id: string; readonly loan_id: string | null;
  readonly kind: "tcpa_voice" | "tcpa_sms"; readonly purpose: "informational" | "marketing";
  readonly phone_number: string; status: ConsentStatus;
  readonly written_consent: boolean; readonly pewc_elements: PewcElements | null; readonly signature_kind: SignatureKind | null;
  readonly disclosure_version: string | null; readonly disclosure_text_hash: string | null;
  readonly captured_at: string; readonly written_confirmation_due_at: string | null; readonly national_dnc_written_permission: boolean;
  /** Evidence: IP/user agent or message-id/call-id, session id (rule 3(iv)). */
  readonly evidence: Record<string, unknown>;
}
export const WRITTEN_SIGNATURE_KINDS: readonly SignatureKind[] = ["esign_click_typed_name", "checkbox_with_text", "sms_keyword_double_optin", "wet_ink"];

/** Rule 3: is this consent marketing-valid PEWC for `number` with `partner_name` as seller (§64.1200(f)(9))? */
export function pewcValid(c: MarketingConsent | null | undefined, f: { partner_name: string; number: string; kind?: "tcpa_voice" | "tcpa_sms" }): { valid: boolean; reasons: string[]; consent_id: string | null } {
  if (!c) return { valid: false, reasons: ["no_consent"], consent_id: null };
  const r: string[] = [];
  if (f.kind && c.kind !== f.kind) r.push(`kind_${c.kind}_not_${f.kind}`);
  if (c.purpose !== "marketing") r.push("purpose_informational");
  if (!c.written_consent) r.push("not_written");
  if (c.status !== "active") r.push(`status_${c.status}`);
  if (!c.signature_kind || !WRITTEN_SIGNATURE_KINDS.includes(c.signature_kind)) r.push("no_written_signature");
  const e = c.pewc_elements;
  if (!e) r.push("pewc_elements_missing");
  else {
    if (!e.authorizes_atds_or_artificial_voice) r.push("f9_authorization_missing");
    if (!e.not_condition_of_purchase) r.push("f9_not_condition_missing");
    if (e.seller_named !== f.partner_name) r.push("seller_named_mismatch");
    if (e.caller_on_behalf !== CALLER_ON_BEHALF) r.push("caller_on_behalf_mismatch");
    if (e.phone_number_as_entered !== f.number || c.phone_number !== f.number) r.push("number_mismatch");
  }
  return { valid: r.length === 0, reasons: r, consent_id: c.consent_id };
}
/** The marketing PEWC for a number among a party's consents (per number, per purpose, per seller — rule 3(v)). */
export function findPewc(consents: readonly MarketingConsent[], f: { partner_name: string; number: string; kind: "tcpa_voice" | "tcpa_sms" }): ReturnType<typeof pewcValid> {
  const candidates = consents.filter((c) => c.kind === f.kind && c.phone_number === f.number && c.purpose === "marketing");
  const valid = candidates.map((c) => pewcValid(c, f)).find((v) => v.valid);
  if (valid) return valid;
  const best = candidates[0] ?? consents.find((c) => c.kind === f.kind && c.phone_number === f.number) ?? null;
  return pewcValid(best, f);
}

export interface CaptureMarketingConsentInput {
  readonly consent_id: string; readonly party_id: string; readonly loan_id?: string | null; readonly kinds: readonly ("tcpa_voice" | "tcpa_sms")[];
  readonly phone_number: string; readonly partner_name: string; readonly signature_kind: SignatureKind; readonly captured_at: string;
  readonly disclosure_version: string; readonly disclosure_text: string; readonly elements: { authorizes_atds_or_artificial_voice: boolean; not_condition_of_purchase: boolean };
  readonly national_dnc_written_permission?: boolean; readonly evidence?: Record<string, unknown>;
}
/**
 * Rule 3 / worked example 1: PEWC captured in the portal → one `consents` row per kind (tcpa_voice, tcpa_sms) with
 * purpose=marketing, written_consent=true, the (f)(9) elements, the disclosure hash and the number as entered. A
 * `voice_recording_interim` capture is `pending_written_confirmation` with a 24-hour written-confirmation due time.
 */
export function captureMarketingConsent(events: EventStore, i: CaptureMarketingConsentInput, actor: Actor = INTAKE_AGENT): { consents: MarketingConsent[]; events: DomainEvent[] } {
  nonEmpty(i.consent_id, "consent_id"); nonEmpty(i.party_id, "party_id"); nonEmpty(i.phone_number, "phone_number"); nonEmpty(i.partner_name, "partner_name"); nonEmpty(i.disclosure_version, "disclosure_version"); nonEmpty(i.disclosure_text, "disclosure_text");
  need(i.kinds.length > 0, "at least one kind (tcpa_voice / tcpa_sms)");
  const at = isoOf(i.captured_at, "captured_at");
  const interim = i.signature_kind === "voice_recording_interim";
  const out: MarketingConsent[] = []; const evs: DomainEvent[] = [];
  for (const kind of i.kinds) {
    const c: MarketingConsent = { consent_id: i.kinds.length === 1 ? i.consent_id : `${i.consent_id}:${kind}`, party_id: i.party_id, loan_id: i.loan_id ?? null, kind, purpose: "marketing", phone_number: i.phone_number,
      status: interim ? "pending_written_confirmation" : "active", written_consent: !interim,
      pewc_elements: { authorizes_atds_or_artificial_voice: i.elements.authorizes_atds_or_artificial_voice, not_condition_of_purchase: i.elements.not_condition_of_purchase, seller_named: i.partner_name, caller_on_behalf: CALLER_ON_BEHALF, phone_number_as_entered: i.phone_number },
      signature_kind: i.signature_kind, disclosure_version: i.disclosure_version, disclosure_text_hash: contentHash(i.disclosure_text), captured_at: at,
      written_confirmation_due_at: interim ? new Date(Date.parse(at) + INTERIM_CONSENT_CONFIRMATION_HOURS * 3_600_000).toISOString() : null,
      national_dnc_written_permission: i.national_dnc_written_permission === true && !interim, evidence: { ...(i.evidence ?? {}), disclosure_hash: contentHash(i.disclosure_text), number_as_entered: i.phone_number } };
    out.push(c);
    evs.push(events.append({ type: "consent.granted", ...(c.loan_id ? { loanId: c.loan_id } : {}), aggregate: { kind: "consent", id: c.consent_id }, actor, occurredAt: at,
      payload: { consent_id: c.consent_id, party_id: c.party_id, kind, purpose: "marketing", written_consent: c.written_consent, signature_kind: c.signature_kind, status: c.status, seller_named: i.partner_name, caller_on_behalf: CALLER_ON_BEHALF, disclosure_version: i.disclosure_version, disclosure_text_hash: c.disclosure_text_hash, written_confirmation_due_at: c.written_confirmation_due_at, national_dnc_written_permission: c.national_dnc_written_permission, ...ORIG } }));
  }
  return { consents: out, events: evs };
}
/** A written channel confirms the interim (voice-recorded) consent inside 24 h → `active`; after the due time it has already expired. */
export function confirmInterimConsent(events: EventStore, c: MarketingConsent, f: { confirmed_at: string; signature_kind: Exclude<SignatureKind, "voice_recording_interim"> }, actor: Actor = INTAKE_AGENT): { consent: MarketingConsent; confirmed: boolean; event: DomainEvent | null } {
  need(c.status === "pending_written_confirmation", `consent ${c.consent_id} is ${c.status}, not pending_written_confirmation`);
  const at = isoOf(f.confirmed_at, "confirmed_at");
  if (c.written_confirmation_due_at && Date.parse(at) > Date.parse(c.written_confirmation_due_at)) return { consent: expireInterimConsent(events, c, at, actor).consent, confirmed: false, event: null };
  const next: MarketingConsent = { ...c, status: "active", written_consent: true, signature_kind: f.signature_kind, evidence: { ...c.evidence, written_confirmation_at: at } };
  const event = events.append({ type: "consent.granted", ...(c.loan_id ? { loanId: c.loan_id } : {}), aggregate: { kind: "consent", id: c.consent_id }, actor, occurredAt: at, payload: { consent_id: c.consent_id, party_id: c.party_id, kind: c.kind, purpose: "marketing", written_consent: true, signature_kind: f.signature_kind, status: "active", confirmed_interim: true, ...ORIG } });
  return { consent: next, confirmed: true, event };
}
/** T12: no written confirmation by captured_at + 24 h → status `expired`; no AI-voice marketing call is placed under it. */
export function expireInterimConsent(events: EventStore, c: MarketingConsent, now: string, actor: Actor = INTAKE_AGENT): { consent: MarketingConsent; expired: boolean; event: DomainEvent | null } {
  const at = isoOf(now, "now");
  if (c.status !== "pending_written_confirmation" || !c.written_confirmation_due_at || Date.parse(at) < Date.parse(c.written_confirmation_due_at)) return { consent: c, expired: false, event: null };
  const next: MarketingConsent = { ...c, status: "expired" };
  const event = events.append({ type: "consent.expired", ...(c.loan_id ? { loanId: c.loan_id } : {}), aggregate: { kind: "consent", id: c.consent_id }, actor, occurredAt: at, payload: { consent_id: c.consent_id, party_id: c.party_id, kind: c.kind, purpose: "marketing", reason: "written_confirmation_missing", written_confirmation_due_at: c.written_confirmation_due_at, ...ORIG } });
  return { consent: next, expired: true, event };
}
/** Revocation by any reasonable method (§64.1200(a)(10)): status `withdrawn` at commit; 11.1 propagates to every list within a minute. */
export function withdrawConsent(c: MarketingConsent, at: string): MarketingConsent { isoOf(at, "at"); return { ...c, status: "withdrawn", evidence: { ...c.evidence, withdrawn_at: at } }; }

// ============================================================ EBR (rule 2; TCPA_64_1200_F5_EBR_*)
export interface EbrFacts { readonly as_of: PlainDate; readonly last_transaction_on?: PlainDate | null; readonly last_inquiry_on?: PlainDate | null; readonly company_dnc_requested_on?: PlainDate | null; }
export interface EbrResult { readonly basis: EbrBasis; readonly anchor_on: PlainDate | null; readonly lapses_on: PlainDate | null; readonly terminated_by_company_dnc: boolean; }
/** Rule 2: transaction_18m if a payment/loan transaction with the partner within 18 months; inquiry_3m within 3 months; none otherwise; a company DNC request sets none regardless ((f)(5)). */
export function ebrBasis(f: EbrFacts): EbrResult {
  need(/^\d{4}-\d{2}-\d{2}$/.test(f.as_of), "as_of must be a PlainDate");
  if (f.company_dnc_requested_on && f.company_dnc_requested_on <= f.as_of) return { basis: "none", anchor_on: null, lapses_on: null, terminated_by_company_dnc: true };
  if (f.last_transaction_on && f.last_transaction_on <= f.as_of) { const lapses_on = addMonths(f.last_transaction_on, EBR_TRANSACTION_MONTHS); if (f.as_of < lapses_on) return { basis: "transaction_18m", anchor_on: f.last_transaction_on, lapses_on, terminated_by_company_dnc: false }; }
  if (f.last_inquiry_on && f.last_inquiry_on <= f.as_of) { const lapses_on = addMonths(f.last_inquiry_on, EBR_INQUIRY_MONTHS); if (f.as_of < lapses_on) return { basis: "inquiry_3m", anchor_on: f.last_inquiry_on, lapses_on, terminated_by_company_dnc: false }; }
  return { basis: "none", anchor_on: null, lapses_on: null, terminated_by_company_dnc: false };
}
/** The platform's statement of a party's EBR window (arms the F5 window rows on the party). */
export function recordEbr(events: EventStore, f: { party_id: string; loan_id?: string | null; at: string } & EbrFacts, actor: Actor = INTAKE_AGENT): { ebr: EbrResult; event: DomainEvent } {
  nonEmpty(f.party_id, "party_id");
  const ebr = ebrBasis(f);
  const event = events.append({ type: "marketing.ebr.evaluated", ...(f.loan_id ? { loanId: f.loan_id } : {}), aggregate: { kind: "party", id: f.party_id }, actor, occurredAt: isoOf(f.at, "at"),
    payload: { party_id: f.party_id, basis: ebr.basis, anchor_on: ebr.anchor_on, lapses_on: ebr.lapses_on, as_of: f.as_of, terminated_by_company_dnc: ebr.terminated_by_company_dnc, ...ORIG } });
  return { ebr, event };
}

// ============================================================ DNC scrubs (TCPA_64_1200_C2_DNC_SCRUB_31)
export interface DncScrub { readonly scrub_id: string; readonly source: "ftc_registry" | "state_registry"; readonly registry_version_obtained_at: string; readonly obtained_on: PlainDate; readonly valid_until: PlainDate; readonly numbers_checked: number; readonly hits: number; readonly file_hash: string; }
/** Worked example 3: obtained Mon Sept 28, 2026 → valid through Thu Oct 29, 2026 (obtained_on + 31 calendar days). */
export function completeDncScrub(events: EventStore, i: { scrub_id: string; source?: DncScrub["source"]; obtained_at: string; numbers_checked: number; hits: number; file_hash: string; time_zone?: string }, actor: Actor = INTAKE_AGENT): { scrub: DncScrub; event: DomainEvent } {
  nonEmpty(i.scrub_id, "scrub_id"); nonEmpty(i.file_hash, "file_hash");
  const at = isoOf(i.obtained_at, "obtained_at");
  const obtained_on = localDate(at, i.time_zone ?? "America/New_York");
  const scrub: DncScrub = { scrub_id: i.scrub_id, source: i.source ?? "ftc_registry", registry_version_obtained_at: at, obtained_on, valid_until: addDays(obtained_on, DNC_SCRUB_VALIDITY_DAYS), numbers_checked: i.numbers_checked, hits: i.hits, file_hash: i.file_hash };
  const event = events.append({ type: "dnc.scrub.completed", aggregate: { kind: "dnc_registry", id: scrub.source }, actor, occurredAt: at, payload: { ...scrub, ...ORIG } });
  return { scrub, event };
}
/** The registry version in force on a (called-party local) date, or null when every version is older than 31 days. */
export function scrubInForce(scrubs: readonly DncScrub[], on: PlainDate): DncScrub | null {
  const live = scrubs.filter((s) => s.obtained_on <= on && on <= s.valid_until).sort((a, b) => (a.valid_until < b.valid_until ? 1 : -1));
  return live[0] ?? null;
}

// ============================================================ quiet hours (rule 5; TCPA_64_1200_C1_QUIET_HOURS_GATE)
export interface QuietHoursInput { readonly at: string; readonly time_zones: readonly string[]; readonly channel: Channel; readonly state_window?: { open: string; close: string } | null; }
export interface QuietHoursCheck { readonly tz: string; readonly local_date: PlainDate; readonly local_time: string; readonly permitted: boolean; readonly reason: string | null; }
export interface QuietHoursResult { readonly time_bound: boolean; readonly permitted: boolean; readonly reason: string | null; readonly window: { open: string; close: string }; readonly checks: readonly QuietHoursCheck[]; readonly reschedule_to: { date: PlainDate; local_time: string; tz: string; at: string } | null; }
export const TIME_BOUND_CHANNELS: readonly Channel[] = ["ai_voice", "human_voice", "sms"];
/** Policy: no voice/SMS on Sundays and federal holidays (open question 5). Saturdays are permitted. */
export const permittedSolicitationDay = (d: PlainDate): boolean => dayOfWeek(d) !== 0 && !isFederalHoliday(d);
/**
 * Rule 5 / T9: local time in every candidate tz (area code and property/mailing address — the stricter wins, so all
 * must pass); outside 08:00–21:00 the rule refuses, outside the 09:00–20:00 policy window the touch is rescheduled to
 * 09:00 on the next permitted day; state overrides may narrow the window further.
 */
export function quietHoursCheck(i: QuietHoursInput): QuietHoursResult {
  const at = isoOf(i.at, "at");
  need(i.time_zones.length > 0, "at least one called-party time zone");
  const open = Math.max(hhmmToMin(QUIET_HOURS.policy_open), i.state_window ? hhmmToMin(i.state_window.open) : 0);
  const close = Math.min(hhmmToMin(QUIET_HOURS.policy_close), i.state_window ? hhmmToMin(i.state_window.close) : 24 * 60);
  const window = { open: `${pad(Math.floor(open / 60))}:${pad(open % 60)}`, close: `${pad(Math.floor(close / 60))}:${pad(close % 60)}` };
  if (!TIME_BOUND_CHANNELS.includes(i.channel)) return { time_bound: false, permitted: true, reason: null, window, checks: [], reschedule_to: null };
  const ms = Date.parse(at);
  const checks: QuietHoursCheck[] = i.time_zones.map((tz) => {
    const w = wallClock(ms, tz); const m = w.hour * 60 + w.minute; const local_time = `${pad(w.hour)}:${pad(w.minute)}`;
    const reason = !permittedSolicitationDay(w.date) ? "sunday_or_federal_holiday" : m < hhmmToMin(QUIET_HOURS.rule_open) ? "before_rule_floor_08:00" : m >= hhmmToMin(QUIET_HOURS.rule_close) ? "after_rule_ceiling_21:00" : m < open ? `before_policy_window_${window.open}` : m >= close ? `after_policy_window_${window.close}` : null;
    return { tz, local_date: w.date, local_time, permitted: reason === null, reason };
  });
  const failing = checks.filter((c) => !c.permitted);
  if (!failing.length) return { time_bound: true, permitted: true, reason: null, window, checks, reschedule_to: null };
  // Reschedule: the next permitted 09:00 (window open) in each tz; the latest instant satisfies every tz.
  const candidates = checks.map((c) => {
    const w = wallClock(ms, c.tz); const m = w.hour * 60 + w.minute;
    let d = permittedSolicitationDay(w.date) && m < open ? w.date : addDays(w.date, 1);
    while (!permittedSolicitationDay(d)) d = addDays(d, 1);
    return { date: d, local_time: window.open, tz: c.tz, epoch: zonedEpochMs(d, window.open, c.tz) };
  }).sort((a, b) => b.epoch - a.epoch);
  const pick = candidates[0]!;
  return { time_bound: true, permitted: false, reason: failing[0]!.reason, window, checks, reschedule_to: { date: pick.date, local_time: pick.local_time, tz: pick.tz, at: new Date(pick.epoch).toISOString() } };
}
/** The human click-to-dial slot (worked example 1: 10:30 called-party local on the plan date, or the next permitted day). */
export function humanDialSlot(on: PlainDate, tz: string): { date: PlainDate; local_time: string; tz: string; at: string } {
  let d = on; while (!permittedSolicitationDay(d)) d = addDays(d, 1);
  return { date: d, local_time: HUMAN_DIAL_LOCAL_TIME, tz, at: new Date(zonedEpochMs(d, HUMAN_DIAL_LOCAL_TIME, tz)).toISOString() };
}

// ============================================================ creatives, templates and the content checklists (rules 4, 7, 9, 10)
export interface Checklists {
  readonly regz_1026_24: { apr_stated: boolean; apr_term_used: boolean; trigger_terms_present: boolean; d2_disclosures_present: boolean; f_rates_periods: boolean; f_payment_taxes_insurance_stmt: boolean; i1_fixed_ok: boolean; i2_no_temp_rate_comparison: boolean; i4_current_lender_ok: boolean; not_a_commitment: boolean };
  readonly map_1014_3: { a_rate_accurate: boolean; b_apr_accurate: boolean; m_no_debt_elimination: boolean; n_no_government_association: boolean; o_source_accurate: boolean; q_no_preapproval_claim: boolean; r_no_guaranteed_claim: boolean; s_no_counseling_claim: boolean; no_cost_phrasing_ok: boolean; no_pressure: boolean; reviewed: "a..s" };
  readonly state: { nmls_id_present: boolean; state_text_present: boolean; no_check_like_solicitation: boolean };
  readonly fnma_b2_1_3_04: { no_investor_reference: boolean };
  readonly tcpa_b: { identity_at_start: boolean; callback_number: boolean; optout_mechanism_2s: boolean } | null;
  readonly canspam: { ad_identified: boolean; optout_link: boolean; postal_address: boolean } | null;
}
export interface ContentChecklistInput {
  readonly text: string; readonly channel: Channel; readonly campaign_kind: CampaignKind;
  readonly amortization?: "fixed" | "arm"; readonly sheet_rates_pct?: readonly string[] | null; readonly sheet_validity_stated?: boolean;
  readonly state?: string | null; readonly state_text?: string | null; readonly other_lender_names?: readonly string[];
  /** Voice scripts: seconds from the start of the message to the opt-out offer (§64.1200(b)(3)). */
  readonly optout_offer_seconds?: number | null;
}
const RE = {
  apr: /\b\d+(?:\.\d+)?\s*%\s*(?:APR|annual percentage rate)\b|\b(?:APR|annual percentage rate)(?:\s*\(APR\))?\s*(?:of|:)?\s*\d+(?:\.\d+)?\s*%/i,
  aprTerm: /\bannual percentage rate\b|\bAPR\b/,
  simpleRate: /\b\d+(?:\.\d+)?\s*%(?!\s*(?:APR|annual percentage rate))/i,
  paymentAmount: /\$\s?[\d,]+(?:\.\d{2})?\s*(?:\/|per|a)\s*month|payments?\s+of\s+\$\s?[\d,]+(?:\.\d{2})?|monthly\s+(?:principal-and-interest\s+)?payments?\s+of\s+\$/i,
  numberOfPayments: /\b\d{2,3}\s+(?:monthly\s+)?(?:principal-and-interest\s+)?payments\b/i,
  repaymentPeriod: /\b\d{1,2}[- ]year\b/i,
  downpayment: /\bdown ?payment\b/i,
  financeCharge: /\bfinance charge\b/i,
  variability: /\bfixed\b|\bmay increase\b|\badjustable\b|\bvariable\b/i,
  taxesInsurance: /do not include amounts for taxes and insurance premiums/i,
  obligationGreater: /actual payment obligation will be greater/i,
  tempRate: /\b(?:introductory|teaser|temporary|promotional)\s+rate\b|\bcompared? (?:to|with) (?:a|your) (?:introductory|teaser|temporary)/i,
  notCommitment: /not a commitment to lend/i,
  nmls: /\bNMLSR?\s*ID\b\s*#?\s*\d+/i,
  investor: /\bFannie\b|\bFreddie\b|\bMBS\b|\bpool\s*(?:no\.?|number|#)|\binvestor\b|\bGinnie\b/i,
  preapproved: /\bpre-?approved\b|\bpreapproval\b|\bpre-approval\b/i,
  guaranteed: /\bguarantee[ds]?\b/i,
  noCost: /\bno[- ]cost\b|\bfree refinance\b|\bfor free\b/i,
  approvedNoFee: /no lender fees and no third-party closing costs charged to you/i,
  debtElimination: /\beliminate your debt\b|\bdebt elimination\b|\bwipe out your (?:debt|mortgage)\b/i,
  government: /\bgovernment[- ](?:program|approved|backed|endorsed)\b|\bfederal program\b|\bgovernment-affiliated\b/i,
  counselor: /\bcounsel(?:or|ing)\b/i,
  pressure: /\blimited[- ]time\b|\bact now\b|\btoday only\b|\blast chance\b/i,
  sourceAccurate: /is your current lender|current lender\/servicer/i,
  smServices: /Supermortgage services your loan for/i,
  notAssociated: /not associated with, or acting on behalf of/i,
  checkLike: /\bpay to the order of\b|\bvoid after\b|\bcheck enclosed\b|\bnon-negotiable\b/i,
  phone: /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/,
  optout: /\b(?:press|say)\b[^.]{0,80}\b(?:do[- ]not[- ]call|opt out|stop|remove)/i,
  advertisement: /\badvertisement\b|\bsolicitation\b/i,
  unsubscribe: /\bunsubscribe\b|\bopt[- ]out\b/i,
  postal: /\d+\s+[A-Za-z0-9.'\- ]+,\s*(?:Suite\s+\w+,\s*)?[A-Za-z.'\- ]+,\s*[A-Z]{2}\s+\d{5}/,
} as const;
/** The rates a creative states (x.xxx %) that are not on the current sheet — guardrail "never state a rate not on the current sheet". */
export function ratesNotOnSheet(text: string, sheetRatesPct: readonly string[] | null | undefined): string[] {
  if (!sheetRatesPct) return [];
  // The borrower's own rate ("current rate 7.000%") is not an offered rate.
  const stated = [...text.matchAll(/\b(\d+\.\d{3})\s*%(?!\s*(?:APR|annual percentage rate))/gi)].filter((m) => !/current rate\s*$/i.test(text.slice(Math.max(0, (m.index ?? 0) - 20), m.index ?? 0))).map((m) => m[1]!);
  return stated.filter((r) => !sheetRatesPct.includes(r));
}
/**
 * Rule 4 (and T7): if the creative states a rate it states the APR using that term; triggering terms (payment amount,
 * number of payments / period, downpayment, finance charge — §1026.24(d)(1)) require the terms of repayment, the APR and
 * whether it may increase ((d)(2)); a dwelling-secured payment ad carries the taxes-and-insurance statement ((f)(3));
 * no "fixed" for an ARM, no temporary-rate comparison, no "no-cost"/"guaranteed"/"pre-approved", accurate source (MAP (o)),
 * NMLS ID, no investor reference (B2-1.3-04), the (b) voice opening, the CAN-SPAM footer.
 */
export function runContentChecklist(i: ContentChecklistInput): Checklists {
  const t = nonEmpty(i.text, "text");
  const apr_stated = RE.apr.test(t);
  const paymentStated = RE.paymentAmount.test(t);
  const trigger_terms_present = paymentStated || RE.numberOfPayments.test(t) || RE.repaymentPeriod.test(t) || RE.downpayment.test(t) || RE.financeCharge.test(t);
  const termsOfRepayment = RE.numberOfPayments.test(t) || RE.repaymentPeriod.test(t);
  const d2_disclosures_present = !trigger_terms_present || (apr_stated && termsOfRepayment && RE.variability.test(t));
  const rateStated = RE.simpleRate.test(t.replace(RE.apr, ""));
  const organic = i.campaign_kind === "organic_nurture" || i.campaign_kind === "general_advertising" || i.campaign_kind === "prescreen";
  const otherLender = (i.other_lender_names ?? []).some((n) => n && t.toLowerCase().includes(n.toLowerCase()));
  const i4_current_lender_ok = organic ? (!otherLender || RE.notAssociated.test(t)) : (!RE.sourceAccurate.test(t) || RE.smServices.test(t));
  const regz_1026_24: Checklists["regz_1026_24"] = {
    apr_stated: !rateStated && !trigger_terms_present ? true : apr_stated, apr_term_used: !rateStated && !apr_stated ? true : RE.aprTerm.test(t),
    trigger_terms_present, d2_disclosures_present, f_rates_periods: !rateStated || apr_stated,
    f_payment_taxes_insurance_stmt: !paymentStated || (RE.taxesInsurance.test(t) && RE.obligationGreater.test(t)),
    i1_fixed_ok: !(/\bfixed\b/i.test(t) && i.amortization === "arm"), i2_no_temp_rate_comparison: !RE.tempRate.test(t), i4_current_lender_ok,
    not_a_commitment: !(rateStated || trigger_terms_present) || RE.notCommitment.test(t) };
  const offSheet = ratesNotOnSheet(t, i.sheet_rates_pct);
  const map_1014_3: Checklists["map_1014_3"] = {
    a_rate_accurate: offSheet.length === 0, b_apr_accurate: !(trigger_terms_present || rateStated) || apr_stated,
    m_no_debt_elimination: !RE.debtElimination.test(t), n_no_government_association: !RE.government.test(t),
    o_source_accurate: organic ? !RE.sourceAccurate.test(t) || RE.notAssociated.test(t) : true,
    q_no_preapproval_claim: !RE.preapproved.test(t), r_no_guaranteed_claim: !RE.guaranteed.test(t), s_no_counseling_claim: !RE.counselor.test(t),
    no_cost_phrasing_ok: !RE.noCost.test(t) || RE.approvedNoFee.test(t), no_pressure: !RE.pressure.test(t) || i.sheet_validity_stated === true, reviewed: "a..s" };
  const state: Checklists["state"] = { nmls_id_present: RE.nmls.test(t), state_text_present: !i.state_text || t.includes(i.state_text), no_check_like_solicitation: !RE.checkLike.test(t) };
  const fnma_b2_1_3_04 = { no_investor_reference: !RE.investor.test(t) };
  const voice = i.channel === "ai_voice" || i.channel === "human_voice";
  const firstSentence = t.split(/[.!?]/)[0] ?? "";
  const tcpa_b = voice ? { identity_at_start: /Supermortgage|on behalf of/i.test(firstSentence), callback_number: RE.phone.test(t), optout_mechanism_2s: RE.optout.test(t) && (i.optout_offer_seconds ?? Number.POSITIVE_INFINITY) <= AI_VOICE_OPTOUT_MAX_SECONDS } : null;
  const canspam = i.channel === "email" ? { ad_identified: RE.advertisement.test(t), optout_link: RE.unsubscribe.test(t), postal_address: RE.postal.test(t) } : null;
  return { regz_1026_24, map_1014_3, state, fnma_b2_1_3_04, tcpa_b, canspam };
}
/** Leaves that describe the creative rather than judge it (`trigger_terms_present` drives (d)(2); false is not a failure). */
const INFORMATIONAL_ITEMS: readonly string[] = ["regz_1026_24.trigger_terms_present"];
/** Every checklist leaf that is false, as "group.item". */
export function checklistFailures(c: Checklists): string[] {
  const out: string[] = [];
  for (const [g, items] of Object.entries(c)) if (items && typeof items === "object") for (const [k, v] of Object.entries(items)) if (v === false && !INFORMATIONAL_ITEMS.includes(`${g}.${k}`)) out.push(`${g}.${k}`);
  return out;
}
export const checklistPasses = (c: Checklists): boolean => checklistFailures(c).length === 0;
/** Rule 7 / T8: the template variable schema has no investor variable — B2-1.3-04 investor blindness at the schema. */
export const FORBIDDEN_VARIABLE_RE = /investor|fnma|fannie|freddie|pool|mbs|security_id|servicing_fee/i;
export function validateVariablesSchema(schema: readonly string[]): { ok: boolean; rejected: string[] } {
  const rejected = schema.filter((v) => FORBIDDEN_VARIABLE_RE.test(v));
  return { ok: rejected.length === 0, rejected };
}
/** Rule 7: regex on the rendered output for "Fannie", "MBS", pool numbers, "investor". */
export const noInvestorReference = (text: string): boolean => !RE.investor.test(text);
export interface RenderedCreative { readonly text: string; readonly content_hash: string; readonly variables_used: string[]; readonly no_investor_reference: boolean; }
/**
 * Renders an approved template's `{{variable}}` slots from the enforced schema only (the LLM may draft copy only
 * inside free-text slots — those are schema'd variables too); an injected or off-schema variable is a RangeError.
 */
export function renderCreative(template: string, variables: Record<string, unknown>, schema: readonly string[]): RenderedCreative {
  nonEmpty(template, "template");
  const s = validateVariablesSchema(schema);
  if (!s.ok) throw new RangeError(`variables_schema rejected: ${s.rejected.join(", ")} (B2-1.3-04 investor blindness; rule 7)`);
  const offSchema = Object.keys(variables).filter((k) => !schema.includes(k));
  if (offSchema.length) throw new RangeError(`variables not in the template schema: ${offSchema.join(", ")}`);
  const used: string[] = [];
  const text = template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, name: string) => {
    if (!schema.includes(name)) throw new RangeError(`template references ${name}, which the schema does not allow`);
    const v = variables[name]; if (v === undefined || v === null) throw new RangeError(`variable ${name} has no value`);
    used.push(name); return String(v);
  });
  return { text, content_hash: contentHash(text), variables_used: used, no_investor_reference: noInvestorReference(text) };
}

export interface Creative {
  readonly creative_id: string; readonly campaign_id: string; readonly channel: Channel; readonly template_code: string; readonly template_version: string;
  content_hash: string | null; readonly rate_sheet_id: string | null; readonly variables_schema: readonly string[]; checklists: Checklists | null;
  status: "draft" | "approved" | "superseded"; approved_by: string | null; approved_at: string | null; superseded_by: string | null;
  readonly prompt_version: string | null; disseminated_from: PlainDate | null; disseminated_to: PlainDate | null; rendered_text: string | null;
}
export interface Campaign {
  readonly campaign_id: string; readonly partner_id: string; readonly program_id: string | null; readonly kind: CampaignKind; readonly channels: readonly Channel[];
  readonly selection_rule_set: string; readonly creative_ids: readonly string[]; approved_by: string | null; approved_at: string | null;
  status: "draft" | "approved" | "live" | "paused" | "ended"; started_at: string | null; ended_at: string | null; map_rule_archive_until: PlainDate | null;
}
export interface Flags { readonly prescreen_enabled?: boolean; }
export const DEFAULT_FLAGS: Flags = { prescreen_enabled: false };

/** Campaign draft (any kind; a prescreen campaign is refused at approval while the flag is off — T11). */
export function createCampaign(i: { campaign_id: string; partner_id: string; program_id?: string | null; kind: CampaignKind; channels: readonly Channel[]; selection_rule_set: string; creative_ids?: readonly string[] }): Campaign {
  nonEmpty(i.campaign_id, "campaign_id"); nonEmpty(i.partner_id, "partner_id"); nonEmpty(i.selection_rule_set, "selection_rule_set");
  need(i.channels.length > 0 && i.channels.every((c) => CHANNELS.includes(c)), `channels must be a non-empty subset of ${CHANNELS.join("/")}`);
  need(/investor/i.test(i.selection_rule_set) === false, "the selection rule set must be investor-blind (B2-1.3-04)");
  return { campaign_id: i.campaign_id, partner_id: i.partner_id, program_id: i.program_id ?? null, kind: i.kind, channels: [...i.channels], selection_rule_set: i.selection_rule_set, creative_ids: [...(i.creative_ids ?? [])], approved_by: null, approved_at: null, status: "draft", started_at: null, ended_at: null, map_rule_archive_until: null };
}
export interface Refusal { readonly refused: true; readonly reason: string; readonly detail?: string; }
export const isRefusal = (x: unknown): x is Refusal => typeof x === "object" && x !== null && (x as Refusal).refused === true;
/** Creative approval by the partner `officer`: the checklist must be all-true and the schema investor-blind. */
export function approveCreative(events: EventStore, c: Creative, f: { approved_by: string; at: string; checklist_input: Omit<ContentChecklistInput, "text" | "channel" | "campaign_kind">; campaign_kind: CampaignKind }, actor: Actor): Creative | Refusal {
  nonEmpty(f.approved_by, "approved_by");
  need(c.rendered_text !== null, `creative ${c.creative_id} has no rendered text to check`);
  const schema = validateVariablesSchema(c.variables_schema);
  if (!schema.ok) return { refused: true, reason: "investor_variable_in_schema", detail: schema.rejected.join(", ") };
  const checklists = runContentChecklist({ ...f.checklist_input, text: c.rendered_text!, channel: c.channel, campaign_kind: f.campaign_kind });
  const failures = checklistFailures(checklists);
  c.checklists = checklists;
  if (failures.length) return { refused: true, reason: "checklist_failed", detail: failures.join(", ") };
  c.status = "approved"; c.approved_by = f.approved_by; c.approved_at = isoOf(f.at, "at"); c.content_hash = contentHash(c.rendered_text!);
  events.append({ type: "creative.approved", aggregate: { kind: "marketing_creative", id: c.creative_id }, actor, occurredAt: c.approved_at, payload: { creative_id: c.creative_id, campaign_id: c.campaign_id, channel: c.channel, content_hash: c.content_hash, template_code: c.template_code, template_version: c.template_version, prompt_version: c.prompt_version, approved_by: f.approved_by, ...ORIG } });
  return c;
}
/** Rule 9 / T11: a prescreen campaign cannot be approved while `marketing.prescreen_enabled=false`; every creative must be approved. */
export function approveCampaign(events: EventStore, c: Campaign, f: { approved_by: string; at: string; creatives: readonly Creative[]; flags?: Flags }, actor: Actor): Campaign | Refusal {
  nonEmpty(f.approved_by, "approved_by");
  const flags = f.flags ?? DEFAULT_FLAGS;
  if (c.kind === "prescreen" && flags.prescreen_enabled !== true) return { refused: true, reason: "feature_disabled", detail: "marketing.prescreen_enabled=false (open question 3 default: off)" };
  const missing = c.creative_ids.filter((id) => !f.creatives.some((x) => x.creative_id === id && x.status === "approved"));
  if (missing.length) return { refused: true, reason: "creatives_not_approved", detail: missing.join(", ") };
  c.status = "approved"; c.approved_by = f.approved_by; c.approved_at = isoOf(f.at, "at");
  events.append({ type: "campaign.approved", aggregate: { kind: "marketing_campaign", id: c.campaign_id }, actor, occurredAt: c.approved_at, payload: { campaign_id: c.campaign_id, kind: c.kind, channels: [...c.channels], selection_rule_set: c.selection_rule_set, approved_by: f.approved_by, ...ORIG } });
  return c;
}
export function launchCampaign(events: EventStore, c: Campaign, at: string, actor: Actor = INTAKE_AGENT): Campaign {
  need(c.status === "approved" || c.status === "paused", `campaign ${c.campaign_id} is ${c.status}; only approved/paused campaigns launch`);
  c.status = "live"; c.started_at = c.started_at ?? isoOf(at, "at");
  events.append({ type: "campaign.launched", aggregate: { kind: "marketing_campaign", id: c.campaign_id }, actor, occurredAt: isoOf(at, "at"), payload: { campaign_id: c.campaign_id, kind: c.kind, ...ORIG } });
  return c;
}
export function pauseCampaign(events: EventStore, c: Campaign, at: string, actor: Actor): Campaign {
  need(c.status === "live", `campaign ${c.campaign_id} is ${c.status}, not live`);
  c.status = "paused";
  events.append({ type: "campaign.paused", aggregate: { kind: "marketing_campaign", id: c.campaign_id }, actor, occurredAt: isoOf(at, "at"), payload: { campaign_id: c.campaign_id, ...ORIG } });
  return c;
}
/** Rule 8: `map_rule_archive_until` = last dissemination + 24 months; `campaign.ended` anchors REGN_1014_5_RECORDS_24M. */
export function endCampaign(events: EventStore, c: Campaign, f: { at: string; last_disseminated_on: PlainDate }, actor: Actor): Campaign {
  need(c.status !== "ended", `campaign ${c.campaign_id} already ended`);
  c.status = "ended"; c.ended_at = isoOf(f.at, "at"); c.map_rule_archive_until = addMonths(f.last_disseminated_on, MAP_ARCHIVE_MONTHS);
  events.append({ type: "campaign.ended", aggregate: { kind: "marketing_campaign", id: c.campaign_id }, actor, occurredAt: c.ended_at, payload: { campaign_id: c.campaign_id, last_disseminated_on: f.last_disseminated_on, archive_until: c.map_rule_archive_until, ...ORIG } });
  return c;
}
/** T10: a creative superseded after its last dissemination keeps its archive 24 months from that date (`archive_until` = due date of REGN_1014_5_RECORDS_24M). */
export function supersedeCreative(events: EventStore, c: Creative, f: { superseded_by: string; at: string; last_disseminated_on: PlainDate }, actor: Actor = INTAKE_AGENT): { creative: Creative; archive_until: PlainDate; event: DomainEvent } {
  nonEmpty(f.superseded_by, "superseded_by");
  need(c.status !== "superseded", `creative ${c.creative_id} already superseded`);
  const archive_until = addMonths(f.last_disseminated_on, MAP_ARCHIVE_MONTHS);
  c.status = "superseded"; c.superseded_by = f.superseded_by; c.disseminated_to = f.last_disseminated_on;
  const event = events.append({ type: "creative.superseded", aggregate: { kind: "marketing_creative", id: c.creative_id }, actor, occurredAt: isoOf(f.at, "at"), payload: { creative_id: c.creative_id, campaign_id: c.campaign_id, superseded_by: f.superseded_by, last_disseminated_on: f.last_disseminated_on, archive_until, ...ORIG } });
  return { creative: c, archive_until, event };
}
export interface MapArchive { readonly rendered_variants: readonly { content_hash: string; channel: Channel }[]; readonly prompt_version: string | null; readonly product_list: readonly string[]; readonly training_materials?: readonly string[]; readonly retained_through: PlainDate; }
/** Rule 8: the MAP archive job proves every rendered variant, the prompt version used and the product list in force are retained through `archive_until`. */
export function verifyMapArchive(events: EventStore, c: Creative, a: MapArchive, f: { archive_until: PlainDate; at: string }, actor: Actor = INTAKE_AGENT): { complete: boolean; missing: string[]; event: DomainEvent } {
  const missing: string[] = [];
  if (!a.rendered_variants.length || (c.content_hash && !a.rendered_variants.some((v) => v.content_hash === c.content_hash))) missing.push("rendered_variants");
  if (c.prompt_version && a.prompt_version !== c.prompt_version) missing.push("prompt_version");
  if (!a.product_list.length) missing.push("product_list");
  if (a.retained_through < f.archive_until) missing.push(`retained_through<${f.archive_until}`);
  const complete = missing.length === 0;
  const event = events.append({ type: "marketing.archive.verified", aggregate: { kind: "marketing_creative", id: c.creative_id }, actor, occurredAt: isoOf(f.at, "at"), payload: { creative_id: c.creative_id, complete, missing, retained_through: a.retained_through, archive_until: f.archive_until, variants: a.rendered_variants.length, prompt_version: a.prompt_version, product_list: [...a.product_list], ...ORIG } });
  return { complete, missing, event };
}

// ============================================================ prescreen (rule 9; FCRA_615D_PRESCREEN_NOTICE_GATE)
export interface PrescreenFacts { readonly short_notice_present: boolean; readonly long_notice_present: boolean; readonly criteria_frozen: boolean; readonly retention_25m_set: boolean; }
export interface GateResult { readonly open: boolean; readonly reason?: string; }
export const WRITTEN_CHANNELS: readonly Channel[] = ["email", "mail", "portal"];
/** 12 CFR 1022.54(c)–(d) short and long notices on a written prescreened solicitation; firm-offer criteria frozen; Reg B §1002.12(b)(7) 25-month retention set. */
export function prescreenNoticeGate(f: { campaign_kind: CampaignKind; channel: Channel; flags?: Flags; prescreen?: PrescreenFacts | null }): GateResult {
  if (f.campaign_kind !== "prescreen") return { open: true };
  if ((f.flags ?? DEFAULT_FLAGS).prescreen_enabled !== true) return { open: false, reason: "feature_disabled" };
  const p = f.prescreen; if (!p) return { open: false, reason: "prescreen_facts_missing" };
  const missing: string[] = [];
  if (WRITTEN_CHANNELS.includes(f.channel)) { if (!p.short_notice_present) missing.push("short_notice_1022_54c"); if (!p.long_notice_present) missing.push("long_notice_1022_54d"); }
  if (!p.criteria_frozen) missing.push("firm_offer_criteria_not_frozen");
  if (!p.retention_25m_set) missing.push("regb_1002_12_retention_not_set");
  return missing.length ? { open: false, reason: missing.join(",") } : { open: true };
}

// ============================================================ suppressions (TCPA_64_1200_D*, CANSPAM_7704_A4)
export interface Suppression { readonly suppression_id: string; readonly kind: SuppressionKind; readonly party_id: string; readonly phone_number_id: string | null; readonly email_id: string | null; readonly address_id: string | null; readonly requested_at: string; readonly requested_on: PlainDate; readonly channel_received: string; readonly honor_until: PlainDate | null; readonly processed_at: string; readonly source_touch_id: string | null; readonly legal_due_on: PlainDate; }
export const REQUEST_KIND_OF: Record<SuppressionKind, SuppressionRequestKind> = { company_dnc: "company_dnc", email_optout: "email_optout", sms_optout: "sms_stop", mail_optout: "mail_optout", all_marketing: "all_marketing" };
/**
 * The consumer's request as received (`marketing.suppression.requested{kind}` — trigger of the 10-business-day honor
 * timers) and its commit (`marketing.suppression.recorded`, policy: immediate). company_dnc honors 5 years from the
 * request (T4: 2026-10-06 → 2031-10-06); email/SMS/mail opt-outs are indefinite. The legal ceiling is +10
 * business_days_servicer from receipt.
 */
export function recordSuppression(events: EventStore, i: { suppression_id: string; kind: SuppressionKind; party_id: string; loan_id?: string | null; phone_number_id?: string | null; email_id?: string | null; address_id?: string | null; requested_at: string; channel_received: string; source_touch_id?: string | null; processed_at?: string; time_zone?: string }, actor: Actor = INTAKE_AGENT): { suppression: Suppression; events: DomainEvent[] } {
  nonEmpty(i.suppression_id, "suppression_id"); nonEmpty(i.party_id, "party_id"); nonEmpty(i.channel_received, "channel_received");
  need(Object.keys(REQUEST_KIND_OF).includes(i.kind), `kind ${String(i.kind)} is not one of ${Object.keys(REQUEST_KIND_OF).join("/")}`);
  const requested_at = isoOf(i.requested_at, "requested_at");
  const processed_at = i.processed_at ? isoOf(i.processed_at, "processed_at") : requested_at;
  need(Date.parse(processed_at) >= Date.parse(requested_at), "processed_at is before requested_at");
  const requested_on = localDate(requested_at, i.time_zone ?? "America/New_York");
  const honor_until = i.kind === "company_dnc" ? addYears(requested_on, COMPANY_DNC_YEARS) : null;
  const legal_due_on = addBusinessDays(requested_on, SUPPRESSION_HONOR_BUSINESS_DAYS, servicer);
  const s: Suppression = { suppression_id: i.suppression_id, kind: i.kind, party_id: i.party_id, phone_number_id: i.phone_number_id ?? null, email_id: i.email_id ?? null, address_id: i.address_id ?? null, requested_at, requested_on, channel_received: i.channel_received, honor_until, processed_at, source_touch_id: i.source_touch_id ?? null, legal_due_on };
  const subject = { ...(i.loan_id ? { loanId: i.loan_id } : {}), aggregate: { kind: "marketing_suppression", id: s.suppression_id } };
  const requested = events.append({ type: "marketing.suppression.requested", ...subject, actor, occurredAt: requested_at, payload: { suppression_id: s.suppression_id, kind: REQUEST_KIND_OF[i.kind], suppression_kind: i.kind, party_id: s.party_id, phone_number_id: s.phone_number_id, email_id: s.email_id, requested_at, requested_on, receipt: requested_on, channel_received: s.channel_received, legal_due_on, source_touch_id: s.source_touch_id, ...ORIG } });
  const recorded = events.append({ type: "marketing.suppression.recorded", ...subject, actor, occurredAt: processed_at, causationId: requested.id, payload: { suppression_id: s.suppression_id, kind: i.kind, party_id: s.party_id, phone_number_id: s.phone_number_id, email_id: s.email_id, requested_at, requested_on, honor_until, processed_at, legal_due_on, terminates_ebr: i.kind === "company_dnc" || i.kind === "all_marketing", ...ORIG } });
  return { suppression: s, events: [requested, recorded] };
}
/** After the five years the company-specific request lapses (§64.1200(d)(6)); the number is again subject to the other gates only. */
export function expireSuppression(events: EventStore, s: Suppression, now: string, actor: Actor = INTAKE_AGENT): { expired: boolean; event: DomainEvent | null } {
  const at = isoOf(now, "now");
  if (!s.honor_until || localDate(at, "America/New_York") <= s.honor_until) return { expired: false, event: null };
  const event = events.append({ type: "marketing.suppression.expired", aggregate: { kind: "marketing_suppression", id: s.suppression_id }, actor, occurredAt: at, payload: { suppression_id: s.suppression_id, kind: s.kind, party_id: s.party_id, honor_until: s.honor_until, ...ORIG } });
  return { expired: true, event };
}
/** Suppressions in force for a channel on a date (company_dnc within its 5 years; the others indefinite; all_marketing covers everything). */
export function activeSuppressions(suppressions: readonly Suppression[], f: { party_id?: string | null; phone_number_id?: string | null; email_id?: string | null; address_id?: string | null; channel: Channel; on: PlainDate }): Suppression[] {
  const matches = (s: Suppression): boolean => (f.phone_number_id != null && s.phone_number_id === f.phone_number_id) || (f.email_id != null && s.email_id === f.email_id) || (f.address_id != null && s.address_id === f.address_id) || (s.phone_number_id === null && s.email_id === null && s.address_id === null && s.party_id === f.party_id);
  const covers = (s: Suppression): boolean => s.kind === "all_marketing" || (s.kind === "company_dnc" && (f.channel === "ai_voice" || f.channel === "human_voice" || f.channel === "sms")) || (s.kind === "email_optout" && f.channel === "email") || (s.kind === "sms_optout" && f.channel === "sms") || (s.kind === "mail_optout" && f.channel === "mail");
  return suppressions.filter((s) => matches(s) && covers(s) && s.requested_on <= f.on && (s.honor_until === null || f.on <= s.honor_until));
}
/** T5: the inbound STOP is 11.1's keyword flow (`consent.revoked` within 60 s, one confirmation text within 5 minutes); 20.2 records the sms_optout suppression and refuses every later SMS to the number. */
export function receiveSmsStop(events: EventStore, i: InboundSms & { party_id: string; suppression_id: string; source_touch_id?: string | null }, actor: Actor = INTAKE_AGENT): { ingestion: SmsIngestion; suppression: Suppression | null; confirmation_text: string | null; confirmation_marketing_free: boolean; events: DomainEvent[] } {
  const ingestion = ingestInboundSms(events, actor, { loan_id: i.loan_id, phone_number_id: i.phone_number_id, party_id: i.party_id, text: i.text, received_at: i.received_at });
  if (!ingestion.revoked) return { ingestion, suppression: null, confirmation_text: null, confirmation_marketing_free: true, events: [...ingestion.events] };
  const r = recordSuppression(events, { suppression_id: i.suppression_id, kind: "sms_optout", party_id: i.party_id, loan_id: i.loan_id, phone_number_id: i.phone_number_id, requested_at: i.received_at, channel_received: "sms", source_touch_id: i.source_touch_id ?? null }, actor);
  return { ingestion, suppression: r.suppression, confirmation_text: SMS_STOP_CONFIRMATION_TEXT, confirmation_marketing_free: !marketingContentPresent(SMS_STOP_CONFIRMATION_TEXT), events: [...ingestion.events, ...r.events] };
}
/** A confirmation text may not carry marketing content (§64.1200(a)(12)): no rate, payment, offer or call-to-action language. */
export const marketingContentPresent = (text: string): boolean => /\d+(?:\.\d+)?\s*%|\$\s?[\d,]+|\boffer\b|\brate\b|\bapply\b|\brefinance today\b|\bcall (?:us|now)\b|\bsave\b/i.test(text);

// ============================================================ per-touch gates (rule 1; the timers table)
export type LegalBasis = { tcpa: { required: "none" | "prior_express" | "pewc"; consent_id: string | null; line_type: LineType | null; line_class: LineClass }; dnc: { national_hit: boolean; ebr_basis: EbrBasis; scrub_id: string | null; company_dnc_hit: boolean }; quiet_hours: { local_time: string | null; tz: string | null; window: string }; canspam: { optout_state: "none" | "opted_out" } | null; state: { rules_applied: string[] } };
export interface GateRecord { readonly code: string; readonly result: "pass" | "fail" | "not_applicable"; readonly basis: Record<string, unknown>; }
export interface TouchInput { readonly touch_id: string; readonly campaign_id: string; readonly campaign_kind: CampaignKind; readonly creative_id: string; readonly channel: Channel; readonly party_id: string; readonly loan_id?: string | null; readonly lead_id?: string | null; readonly opportunity_id?: string | null; readonly destination: string; readonly destination_id?: string | null; readonly line_type?: LineType | null; readonly queued_at: string; readonly time_zones: readonly string[]; readonly state?: string | null; }
export interface TouchFacts {
  readonly touch: TouchInput; readonly partner_name: string;
  readonly consents?: readonly MarketingConsent[]; readonly scrubs?: readonly DncScrub[]; readonly on_national_registry?: boolean;
  readonly ebr?: { last_transaction_on?: PlainDate | null; last_inquiry_on?: PlainDate | null } | null;
  readonly suppressions?: readonly Suppression[]; readonly creative?: Creative | null; readonly rendered_text?: string | null; readonly rate_sheet_current?: boolean;
  readonly flags?: Flags; readonly prescreen?: PrescreenFacts | null; readonly partner_licensed_in_state?: boolean; readonly state_quiet_window?: { open: string; close: string } | null;
  readonly state_rules_applied?: readonly string[];
  readonly history?: { voice_attempts_at?: readonly string[]; emails_sent?: number; declined_on?: PlainDate | null } | null;
}
export interface GateCheck { readonly touch_id: string; readonly channel: Channel; readonly gates: readonly GateRecord[]; readonly pass: boolean; readonly suppression_reason: string | null; readonly reschedule_to: QuietHoursResult["reschedule_to"]; readonly legal_basis: LegalBasis; readonly ebr: EbrResult; readonly quiet_hours: QuietHoursResult; }
export const lineClassOf = (t: LineType | null | undefined): LineClass => (t === "landline" ? "residential_landline" : t === "mobile" || t === "voip" ? "cellular" : "unknown");
const gate = (code: string, applicable: boolean, open: boolean, basis: Record<string, unknown>): GateRecord => ({ code, result: !applicable ? "not_applicable" : open ? "pass" : "fail", basis });
/** SM_CAMPAIGN_CREATIVE_APPROVAL_GATE: creative approved, not superseded, all checklist items true, the rate sheet current, and the rendered text investor-blind (T8). */
export function creativeApprovalGate(f: { creative?: Creative | null; rendered_text?: string | null; rate_sheet_current?: boolean }): GateResult {
  const c = f.creative; if (!c) return { open: false, reason: "creative_missing" };
  if (c.status !== "approved") return { open: false, reason: c.status === "superseded" ? "creative_superseded" : "creative_not_approved" };
  if (!c.checklists) return { open: false, reason: "checklist_missing" };
  const failures = checklistFailures(c.checklists); if (failures.length) return { open: false, reason: `checklist_failed:${failures.join(",")}` };
  if (c.rate_sheet_id && f.rate_sheet_current === false) return { open: false, reason: "rate_sheet_stale" };
  const text = f.rendered_text ?? c.rendered_text; if (text && !noInvestorReference(text)) return { open: false, reason: "investor_reference" };
  return { open: true };
}
/**
 * Every gate in the timers table for one queued touch (rule 1 channel matrix). The first failing gate names the
 * suppression reason; a quiet-hours failure alone reschedules instead of suppressing.
 */
export function checkGates(f: TouchFacts): GateCheck {
  const t = f.touch;
  nonEmpty(t.touch_id, "touch.touch_id"); nonEmpty(t.party_id, "touch.party_id"); nonEmpty(t.destination, "touch.destination"); nonEmpty(f.partner_name, "partner_name");
  need(CHANNELS.includes(t.channel), `channel ${String(t.channel)} is not one of ${CHANNELS.join("/")}`);
  const at = isoOf(t.queued_at, "touch.queued_at");
  const tzs = t.time_zones.length ? t.time_zones : ["America/New_York"];
  const on = localDate(at, tzs[0]!);
  const voice = t.channel === "ai_voice" || t.channel === "human_voice";
  const telephone = voice || t.channel === "sms";
  const line_class = lineClassOf(t.line_type);
  const gates: GateRecord[] = [];
  const reasons: string[] = [];
  const fail = (reason: string) => { reasons.push(reason); };
  // 31.1 owns the licensing matrix; referenced here (rule 10: no solicitation into an unlicensed state).
  const licensed = f.partner_licensed_in_state !== false;
  gates.push(gate("SM_LICENSE_STATE_GATE", true, licensed, { owner: "31.1", state: t.state ?? null }));
  if (!licensed) fail("unlicensed_state");
  const creative = creativeApprovalGate({ creative: f.creative ?? null, rendered_text: f.rendered_text ?? null, ...(f.rate_sheet_current !== undefined ? { rate_sheet_current: f.rate_sheet_current } : {}) });
  gates.push(gate("SM_CAMPAIGN_CREATIVE_APPROVAL_GATE", true, creative.open, { creative_id: t.creative_id, content_hash: f.creative?.content_hash ?? null, reason: creative.reason ?? null }));
  if (!creative.open) fail(creative.reason!.startsWith("investor_reference") ? "investor_reference" : "creative_not_approved");
  const prescreen = prescreenNoticeGate({ campaign_kind: t.campaign_kind, channel: t.channel, ...(f.flags ? { flags: f.flags } : {}), prescreen: f.prescreen ?? null });
  gates.push(gate("FCRA_615D_PRESCREEN_NOTICE_GATE", t.campaign_kind === "prescreen", prescreen.open, { reason: prescreen.reason ?? null }));
  if (t.campaign_kind === "prescreen" && !prescreen.open) fail(prescreen.reason === "feature_disabled" ? "feature_disabled" : "prescreen_notice_missing");
  // TCPA (a)(2)/(a)(3): PEWC for AI voice / SMS to a charged-for line and AI voice to a residential landline.
  const kind: "tcpa_voice" | "tcpa_sms" = t.channel === "sms" ? "tcpa_sms" : "tcpa_voice";
  const pewc = findPewc(f.consents ?? [], { partner_name: f.partner_name, number: t.destination, kind });
  const a2Applies = (t.channel === "ai_voice" || t.channel === "sms") && line_class !== "residential_landline";
  const a3Applies = t.channel === "ai_voice" && line_class === "residential_landline";
  gates.push(gate("TCPA_64_1200_A2_PEWC_GATE", a2Applies, pewc.valid, { line_class, consent_id: pewc.consent_id, reasons: pewc.reasons }));
  gates.push(gate("TCPA_64_1200_A3_LANDLINE_PEWC_GATE", a3Applies, pewc.valid, { line_class, consent_id: pewc.consent_id, reasons: pewc.reasons }));
  if ((a2Applies || a3Applies) && !pewc.valid) fail("no_pewc");
  // Suppressions (company DNC, opt-outs) and the EBR.
  const supp = activeSuppressions(f.suppressions ?? [], { party_id: t.party_id, phone_number_id: t.destination_id ?? null, email_id: t.destination_id ?? null, address_id: t.destination_id ?? null, channel: t.channel, on });
  const companyDnc = supp.find((s) => s.kind === "company_dnc" || s.kind === "all_marketing") ?? null;
  const ebr = ebrBasis({ as_of: on, last_transaction_on: f.ebr?.last_transaction_on ?? null, last_inquiry_on: f.ebr?.last_inquiry_on ?? null, company_dnc_requested_on: companyDnc?.requested_on ?? null });
  gates.push(gate("TCPA_64_1200_D_COMPANY_DNC_5Y", telephone, companyDnc === null, { suppression_id: companyDnc?.suppression_id ?? null, honor_until: companyDnc?.honor_until ?? null, terminates_ebr: companyDnc !== null }));
  if (telephone && companyDnc) fail("company_dnc");
  const optout = supp.find((s) => s.kind !== "company_dnc") ?? null;
  if (optout) { gates.push(gate(`SUPPRESSION_${optout.kind.toUpperCase()}`, true, false, { suppression_id: optout.suppression_id, requested_on: optout.requested_on })); fail(optout.kind); }
  // National DNC: scrub version ≤ 31 days old, then not on the registry / EBR / written permission.
  const scrub = scrubInForce(f.scrubs ?? [], on);
  gates.push(gate("TCPA_64_1200_C2_DNC_SCRUB_31", voice, scrub !== null, { scrub_id: scrub?.scrub_id ?? null, valid_until: scrub?.valid_until ?? null, on }));
  if (voice && !scrub) fail("dnc_scrub_expired");
  const writtenPermission = (f.consents ?? []).some((c) => c.phone_number === t.destination && c.purpose === "marketing" && c.status === "active" && c.national_dnc_written_permission && pewcValid(c, { partner_name: f.partner_name, number: t.destination }).valid);
  const ebrExempts = ebr.basis === "transaction_18m" || ebr.basis === "inquiry_3m";
  const nationalOk = f.on_national_registry !== true || ebrExempts || writtenPermission;
  const ebr_basis: EbrBasis = ebrExempts ? ebr.basis : writtenPermission ? "written_permission" : "none";
  gates.push(gate("TCPA_64_1200_C2_NATIONAL_DNC_GATE", voice, nationalOk, { national_hit: f.on_national_registry === true, ebr_basis, ebr_anchor_on: ebr.anchor_on, ebr_lapses_on: ebr.lapses_on, written_permission: writtenPermission, ebr_terminated_by_company_dnc: ebr.terminated_by_company_dnc }));
  gates.push(gate("TCPA_64_1200_F5_EBR_TRANSACTION_18M", voice && f.on_national_registry === true, ebr.basis === "transaction_18m", { anchor_on: ebr.basis === "transaction_18m" ? ebr.anchor_on : null, lapses_on: ebr.basis === "transaction_18m" ? ebr.lapses_on : null }));
  gates.push(gate("TCPA_64_1200_F5_EBR_INQUIRY_3M", voice && f.on_national_registry === true, ebr.basis === "inquiry_3m", { anchor_on: ebr.basis === "inquiry_3m" ? ebr.anchor_on : null, lapses_on: ebr.basis === "inquiry_3m" ? ebr.lapses_on : null }));
  if (voice && !nationalOk) fail("national_dnc");
  // Frequency (rule 6).
  const h = f.history ?? {};
  const voiceAttempts = (h.voice_attempts_at ?? []).filter((x) => Date.parse(x) <= Date.parse(at));
  const recentVoice = voiceAttempts.filter((x) => Date.parse(at) - Date.parse(x) < 7 * 86_400_000).length;
  const freqOk = voice ? recentVoice < FREQUENCY.voice_per_7_days && voiceAttempts.length < FREQUENCY.voice_total : t.channel === "email" ? (h.emails_sent ?? 0) < FREQUENCY.emails_total : true;
  const cooldownOk = !h.declined_on || on >= addDays(h.declined_on, FREQUENCY.declined_cooldown_days);
  gates.push(gate("SM_TOUCH_FREQUENCY_POLICY", voice || t.channel === "email", freqOk && cooldownOk, { voice_attempts_7d: recentVoice, voice_attempts_total: voiceAttempts.length, emails_sent: h.emails_sent ?? 0, declined_on: h.declined_on ?? null }));
  if (!freqOk) fail("frequency_cap"); else if (!cooldownOk) fail("declined_cooldown");
  // Quiet hours (rule 5) — reschedules rather than suppresses.
  const qh = quietHoursCheck({ at, time_zones: tzs, channel: t.channel, state_window: f.state_quiet_window ?? null });
  gates.push(gate("TCPA_64_1200_C1_QUIET_HOURS_GATE", qh.time_bound, qh.permitted, { window: `${qh.window.open}-${qh.window.close}`, checks: qh.checks, reason: qh.reason, reschedule_to: qh.reschedule_to }));
  const pass = reasons.length === 0 && qh.permitted;
  const legal_basis: LegalBasis = { tcpa: { required: t.channel === "ai_voice" || t.channel === "sms" ? "pewc" : "none", consent_id: pewc.valid ? pewc.consent_id : null, line_type: t.line_type ?? null, line_class },
    dnc: { national_hit: f.on_national_registry === true, ebr_basis, scrub_id: scrub?.scrub_id ?? null, company_dnc_hit: companyDnc !== null },
    quiet_hours: { local_time: qh.checks[0]?.local_time ?? null, tz: qh.checks[0]?.tz ?? null, window: `${qh.window.open}-${qh.window.close}` },
    canspam: t.channel === "email" ? { optout_state: optout?.kind === "email_optout" ? "opted_out" : "none" } : null, state: { rules_applied: [...(f.state_rules_applied ?? [])] } };
  return { touch_id: t.touch_id, channel: t.channel, gates, pass, suppression_reason: reasons[0] ?? null, reschedule_to: qh.reschedule_to, legal_basis, ebr, quiet_hours: qh };
}
/** `assertGateOpen`: the named gate's record must read pass (or not_applicable); otherwise a RangeError naming the basis. */
export function assertGateOpen(check: GateCheck, code: string): GateRecord {
  const g = check.gates.find((x) => x.code === code);
  if (!g) throw new RangeError(`no gate ${code} was evaluated for touch ${check.touch_id}`);
  if (g.result === "fail") throw new RangeError(`GATE_CLOSED ${code} for touch ${check.touch_id}: ${JSON.stringify(g.basis)}`);
  return g;
}

// ============================================================ touch lifecycle (state machine: queued → suppressed | scheduled → sent)
export interface Touch extends TouchInput { outcome: TouchOutcome; scheduled_for: string | null; scheduled_local: { date: PlainDate; local_time: string; tz: string } | null; sent_at: string | null; suppression_reason: string | null; legal_basis: LegalBasis | null; gates: readonly GateRecord[]; agent_decision_id: string | null; call_recording_id: string | null; transcript_id: string | null; }
const touchSubject = (t: TouchInput) => ({ ...(t.loan_id ? { loanId: t.loan_id } : {}), aggregate: { kind: "marketing_touch", id: t.touch_id } });
/** `marketing.touch.queued` — the trigger of every touch gate (carries channel, line_class and campaign_kind for the patterns). */
export function queueTouch(events: EventStore, t: TouchInput, actor: Actor = INTAKE_AGENT): { touch: Touch; event: DomainEvent } {
  nonEmpty(t.touch_id, "touch_id"); nonEmpty(t.campaign_id, "campaign_id"); nonEmpty(t.creative_id, "creative_id"); nonEmpty(t.party_id, "party_id"); nonEmpty(t.destination, "destination");
  need(CHANNELS.includes(t.channel), `channel ${String(t.channel)} is not one of ${CHANNELS.join("/")}`);
  const at = isoOf(t.queued_at, "queued_at");
  const touch: Touch = { ...t, queued_at: at, outcome: "queued", scheduled_for: null, scheduled_local: null, sent_at: null, suppression_reason: null, legal_basis: null, gates: [], agent_decision_id: null, call_recording_id: null, transcript_id: null };
  const event = events.append({ type: "marketing.touch.queued", ...touchSubject(t), actor, occurredAt: at, payload: { touch_id: t.touch_id, campaign_id: t.campaign_id, campaign_kind: t.campaign_kind, creative_id: t.creative_id, channel: t.channel, line_type: t.line_type ?? null, line_class: lineClassOf(t.line_type), party_id: t.party_id, loan_id: t.loan_id ?? null, lead_id: t.lead_id ?? null, opportunity_id: t.opportunity_id ?? null, destination_id: t.destination_id ?? null, queued_at: at, time_zones: [...t.time_zones], ...ORIG } });
  return { touch, event };
}
/** Guards on queued → scheduled: every gate passes and the creative is approved; else `suppressed{reason}`. A quiet-hours refusal schedules the next window (`scheduled_for` moves). */
export function decideTouch(events: EventStore, touch: Touch, check: GateCheck, opts: { scheduled_for?: string; agent_decision_id?: string | null } = {}, actor: Actor = INTAKE_AGENT): { touch: Touch; event: DomainEvent } {
  need(touch.outcome === "queued", `touch ${touch.touch_id} is ${touch.outcome}, not queued`);
  need(check.touch_id === touch.touch_id, "gate record is for another touch");
  touch.gates = check.gates; touch.legal_basis = check.legal_basis; touch.agent_decision_id = opts.agent_decision_id ?? null;
  if (check.suppression_reason) {
    touch.outcome = "suppressed"; touch.suppression_reason = check.suppression_reason;
    const event = events.append({ type: "marketing.touch.suppressed", ...touchSubject(touch), actor, occurredAt: touch.queued_at, payload: { touch_id: touch.touch_id, channel: touch.channel, reason: check.suppression_reason, gates: check.gates.filter((g) => g.result === "fail").map((g) => g.code), legal_basis: check.legal_basis, ...ORIG } });
    return { touch, event };
  }
  const tz = touch.time_zones[0] ?? "America/New_York";
  const when = check.reschedule_to ? check.reschedule_to.at : opts.scheduled_for ? isoOf(opts.scheduled_for, "scheduled_for") : touch.queued_at;
  const w = wallClock(Date.parse(when), check.reschedule_to?.tz ?? tz);
  touch.outcome = "scheduled"; touch.scheduled_for = when; touch.scheduled_local = { date: w.date, local_time: `${pad(w.hour)}:${pad(w.minute)}`, tz: check.reschedule_to?.tz ?? tz };
  const event = events.append({ type: "marketing.touch.scheduled", ...touchSubject(touch), actor, occurredAt: touch.queued_at, payload: { touch_id: touch.touch_id, channel: touch.channel, scheduled_for: when, local_time: touch.scheduled_local.local_time, local_date: touch.scheduled_local.date, tz: touch.scheduled_local.tz, rescheduled: check.reschedule_to !== null, legal_basis: check.legal_basis, gates: check.gates.map((g) => ({ code: g.code, result: g.result })), ...ORIG } });
  return { touch, event };
}
/** queueTouch + checkGates + decideTouch in one step (the `scheduleTouch` tool). */
export function scheduleTouch(events: EventStore, f: TouchFacts, opts: { scheduled_for?: string; agent_decision_id?: string | null } = {}, actor: Actor = INTAKE_AGENT): { touch: Touch; check: GateCheck; events: DomainEvent[] } {
  const q = queueTouch(events, f.touch, actor);
  const check = checkGates(f);
  const d = decideTouch(events, q.touch, check, opts, actor);
  return { touch: d.touch, check, events: [q.event, d.event] };
}
/** `marketing.touch.sent` — 20.1 writes `refi.opportunity.offered` from the first sent touch of an opportunity (its SM_REFI_OFFER_SLA_2BD satisfier). */
export function sendTouch(events: EventStore, touch: Touch, f: { sent_at: string; outcome?: Exclude<TouchOutcome, "queued" | "scheduled" | "suppressed">; notice_id?: string | null; content_hash?: string | null; call_recording_id?: string | null; transcript_id?: string | null; ident_played_first?: boolean; optout_offered_within_s?: number | null }, actor: Actor = INTAKE_AGENT): { touch: Touch; event: DomainEvent } {
  need(touch.outcome === "scheduled", `touch ${touch.touch_id} is ${touch.outcome}, not scheduled (never send without a passing gate record)`);
  const at = isoOf(f.sent_at, "sent_at");
  need(!touch.scheduled_for || Date.parse(at) >= Date.parse(touch.scheduled_for), `touch ${touch.touch_id} is scheduled for ${touch.scheduled_for}; ${at} is earlier`);
  touch.outcome = f.outcome ?? "sent"; touch.sent_at = at; touch.call_recording_id = f.call_recording_id ?? null; touch.transcript_id = f.transcript_id ?? null;
  const event = events.append({ type: "marketing.touch.sent", ...touchSubject(touch), actor, occurredAt: at, payload: { touch_id: touch.touch_id, campaign_id: touch.campaign_id, creative_id: touch.creative_id, channel: touch.channel, party_id: touch.party_id, loan_id: touch.loan_id ?? null, opportunity_id: touch.opportunity_id ?? null, lead_id: touch.lead_id ?? null, sent_at: at, offered_at: at, outcome: touch.outcome, notice_id: f.notice_id ?? null, content_hash: f.content_hash ?? null, legal_basis: touch.legal_basis, call_recording_id: touch.call_recording_id, transcript_id: touch.transcript_id, ident_played_first: f.ident_played_first ?? null, optout_offered_within_s: f.optout_offered_within_s ?? null, ...ORIG } });
  return { touch, event };
}
/** A reply, question, STOP or opt-out on a touch (`marketing.response.received`); a refinancing reply is a consumer inquiry (inquiry EBR, 3 months) and 20.3 opens the lead from it. */
export function recordResponse(events: EventStore, f: { touch_id: string; campaign_id: string; party_id: string; loan_id?: string | null; opportunity_id?: string | null; kind: "reply_refinance" | "question" | "stop" | "optout" | "complaint" | "wrong_number" | "declined"; channel: Channel; received_at: string; consent_ids?: readonly string[]; text?: string | null; time_zone?: string }, actor: Actor = INTAKE_AGENT): { received_on: PlainDate; inquiry: boolean; ebr: EbrResult | null; events: DomainEvent[] } {
  nonEmpty(f.touch_id, "touch_id"); nonEmpty(f.campaign_id, "campaign_id"); nonEmpty(f.party_id, "party_id");
  const at = isoOf(f.received_at, "received_at");
  const received_on = localDate(at, f.time_zone ?? "America/New_York");
  const inquiry = f.kind === "reply_refinance" || f.kind === "question";
  const out: DomainEvent[] = [events.append({ type: "marketing.response.received", ...(f.loan_id ? { loanId: f.loan_id } : {}), aggregate: { kind: "marketing_touch", id: f.touch_id }, actor, occurredAt: at, payload: { touch_id: f.touch_id, campaign_id: f.campaign_id, party_id: f.party_id, loan_id: f.loan_id ?? null, opportunity_id: f.opportunity_id ?? null, kind: f.kind, channel: f.channel, received_at: at, received_on, inquiry, consent_ids: [...(f.consent_ids ?? [])], lead_channel: f.opportunity_id ? "refi_trigger" : "organic", ...ORIG } })];
  let ebr: EbrResult | null = null;
  if (inquiry) { const r = recordEbr(events, { party_id: f.party_id, loan_id: f.loan_id ?? null, at, as_of: received_on, last_inquiry_on: received_on }, actor); ebr = r.ebr; out.push(r.event); }
  return { received_on, inquiry, ebr, events: out };
}

// ============================================================ channel plan (rule 1; planChannels)
export interface ChannelPlanEntry { readonly channel: Channel; readonly permitted: boolean; readonly reason: string | null; readonly scheduled_for: string | null; readonly local: { date: PlainDate; local_time: string; tz: string } | null; readonly check: GateCheck; readonly alternative_for?: Channel; }
export interface ChannelPlan { readonly opportunity_id: string | null; readonly party_id: string; readonly plan_on: PlainDate; readonly entries: readonly ChannelPlanEntry[]; readonly ebr: EbrResult; readonly touches: readonly TouchInput[]; }
export interface PlanInput { readonly campaign: Campaign; readonly creatives: readonly Creative[]; readonly party_id: string; readonly loan_id?: string | null; readonly lead_id?: string | null; readonly opportunity_id?: string | null; readonly at: string; readonly time_zones: readonly string[]; readonly state?: string | null;
  readonly destinations: Partial<Record<Channel, { destination: string; destination_id?: string | null; line_type?: LineType | null }>>; readonly facts: Omit<TouchFacts, "touch" | "creative" | "rendered_text">; readonly touch_id_prefix?: string; }
/**
 * Rule 1 / worked example 1: for each campaign channel with a destination, evaluate the gates; an AI-voice touch
 * refused for lack of PEWC (or a landline) yields a human click-to-dial alternative at 10:30 called-party local when
 * that channel's own gates (EBR/national DNC, company DNC, quiet hours) pass. Email/portal/mail go at the plan instant
 * inside their windows; the plan records the EBR evaluation on the party.
 */
export function planChannels(events: EventStore, p: PlanInput, actor: Actor = INTAKE_AGENT): ChannelPlan {
  nonEmpty(p.party_id, "party_id"); need(p.campaign.status === "approved" || p.campaign.status === "live", `campaign ${p.campaign.campaign_id} is ${p.campaign.status}; only approved/live campaigns plan touches`);
  const at = isoOf(p.at, "at");
  const tzs = p.time_zones.length ? p.time_zones : ["America/New_York"];
  const plan_on = localDate(at, tzs[0]!);
  const prefix = p.touch_id_prefix ?? `${p.campaign.campaign_id}:${p.party_id}`;
  const entries: ChannelPlanEntry[] = []; const touches: TouchInput[] = [];
  const ebrRec = recordEbr(events, { party_id: p.party_id, loan_id: p.loan_id ?? null, at, as_of: plan_on, last_transaction_on: p.facts.ebr?.last_transaction_on ?? null, last_inquiry_on: p.facts.ebr?.last_inquiry_on ?? null }, actor);
  const build = (channel: Channel, queued_at: string, alternative_for?: Channel): ChannelPlanEntry | null => {
    const dest = p.destinations[channel]; if (!dest) return null;
    const creative = p.creatives.find((c) => c.campaign_id === p.campaign.campaign_id && c.channel === channel) ?? null;
    const touch: TouchInput = { touch_id: `${prefix}:${channel}`, campaign_id: p.campaign.campaign_id, campaign_kind: p.campaign.kind, creative_id: creative?.creative_id ?? `${channel}-creative-missing`, channel, party_id: p.party_id, loan_id: p.loan_id ?? null, lead_id: p.lead_id ?? null, opportunity_id: p.opportunity_id ?? null, destination: dest.destination, destination_id: dest.destination_id ?? null, line_type: dest.line_type ?? null, queued_at, time_zones: tzs, state: p.state ?? null };
    const check = checkGates({ ...p.facts, touch, creative, rendered_text: creative?.rendered_text ?? null });
    const permitted = check.suppression_reason === null;
    const when = permitted ? (check.reschedule_to?.at ?? queued_at) : null;
    const w = when ? wallClock(Date.parse(when), check.reschedule_to?.tz ?? tzs[0]!) : null;
    touches.push(touch);
    return { channel, permitted, reason: check.suppression_reason, scheduled_for: when, local: w ? { date: w.date, local_time: `${pad(w.hour)}:${pad(w.minute)}`, tz: check.reschedule_to?.tz ?? tzs[0]! } : null, check, ...(alternative_for ? { alternative_for } : {}) };
  };
  for (const channel of p.campaign.channels) {
    const e = build(channel, at); if (!e) continue;
    entries.push(e);
    if (channel === "ai_voice" && !e.permitted && e.reason === "no_pewc" && p.destinations.human_voice) {
      const slot = humanDialSlot(plan_on, tzs[0]!);
      const alt = build("human_voice", slot.at, "ai_voice"); if (alt) entries.push(alt);
    }
  }
  return { opportunity_id: p.opportunity_id ?? null, party_id: p.party_id, plan_on, entries, ebr: ebrRec.ebr, touches };
}

// ============================================================ voice execution (placeCall; TSR §310.4(d); §64.1200(b))
export interface VoiceScript { readonly opening_text: string; readonly ident_at_s: number; readonly optout_offer_at_s: number; readonly callback_number: string; readonly prompt_version: string | null; readonly ai_disclosure_first?: boolean; }
export interface CallPlacement { readonly touch: Touch; readonly mode: "ai_voice" | "human_voice"; readonly ident_played_first: boolean; readonly optout_offered_within_s: number; readonly tsr_310_4d: { identity: boolean; sales_purpose: boolean; nature: boolean } | null; readonly contact: Record<string, unknown>; readonly event: DomainEvent; }
/**
 * AI voice: only under a passing gate record with a PEWC consent id; the (b) identification plays first and the
 * interactive opt-out is offered within 2 seconds (T2); automation is disclosed at the start (20.3 NTC_SM_AI_INTERACTION_DISCLOSURE).
 * Human click-to-dial: TSR §310.4(d) opening — identity of the seller, sales purpose, nature of the goods.
 */
export function placeCall(events: EventStore, touch: Touch, script: VoiceScript, f: { placed_at: string; outcome?: "answered_ai" | "answered_human" | "voicemail_no_message" | "bounced"; call_recording_id?: string | null; transcript_id?: string | null }, actor: Actor = INTAKE_AGENT): CallPlacement {
  need(touch.channel === "ai_voice" || touch.channel === "human_voice", `touch ${touch.touch_id} is ${touch.channel}, not a voice touch`);
  need(touch.outcome === "scheduled" && touch.gates.length > 0 && touch.gates.every((g) => g.result !== "fail"), `never dial ${touch.touch_id} without a passing gate record`);
  nonEmpty(script.opening_text, "script.opening_text"); nonEmpty(script.callback_number, "script.callback_number");
  const mode: "ai_voice" | "human_voice" = touch.channel === "ai_voice" ? "ai_voice" : "human_voice";
  if (mode === "ai_voice") {
    need(touch.legal_basis?.tcpa.consent_id, `never use an artificial voice without PEWC (touch ${touch.touch_id})`);
    need(script.ident_at_s === 0, "§64.1200(b)(1): the identification is stated at the beginning of the message");
    need(script.optout_offer_at_s - script.ident_at_s <= AI_VOICE_OPTOUT_MAX_SECONDS, `§64.1200(b)(3): the opt-out mechanism within ${AI_VOICE_OPTOUT_MAX_SECONDS} s of the identification (script offers it at ${script.optout_offer_at_s} s)`);
    need(!/\bI am a (?:person|human)\b|\bI'm a real person\b/i.test(script.opening_text), "prohibited output: the voice model may never claim to be a person");
  }
  const tsr = mode === "human_voice" ? { identity: /on behalf of|Supermortgage/i.test(script.opening_text), sales_purpose: /refinance offer|about a refinance|sales call|offer/i.test(script.opening_text), nature: /mortgage|refinance|loan/i.test(script.opening_text) } : null;
  if (tsr) need(tsr.identity && tsr.sales_purpose && tsr.nature, "TSR §310.4(d): the opening must disclose the seller's identity, the sales purpose and the nature of the goods");
  const sent = sendTouch(events, touch, { sent_at: f.placed_at, outcome: f.outcome ?? (mode === "ai_voice" ? "answered_ai" : "answered_human"), call_recording_id: f.call_recording_id ?? null, transcript_id: f.transcript_id ?? null, ident_played_first: true, optout_offered_within_s: mode === "ai_voice" ? script.optout_offer_at_s - script.ident_at_s : null }, actor);
  const contact = { loan_id: touch.loan_id ?? null, party_id: touch.party_id, direction: "outbound", mode, purpose: "marketing", attempted_at: sent.touch.sent_at, result: sent.touch.outcome, disclosure_given: mode === "ai_voice", transcript_id: sent.touch.transcript_id, call_recording_id: sent.touch.call_recording_id, prompt_version: script.prompt_version, touch_id: touch.touch_id };
  return { touch: sent.touch, mode, ident_played_first: true, optout_offered_within_s: mode === "ai_voice" ? script.optout_offer_at_s - script.ident_at_s : 0, tsr_310_4d: tsr, contact, event: sent.event };
}

// ============================================================ gate evaluators' fact adapters (evaluators-20-2.ts)
export function pewcGateFromFacts(f: Record<string, unknown>): GateResult {
  const consents = Array.isArray(f.consents) ? (f.consents as MarketingConsent[]) : [];
  const r = findPewc(consents, { partner_name: String(f.partner_name ?? ""), number: String(f.number ?? ""), kind: (f.kind as "tcpa_voice" | "tcpa_sms" | undefined) ?? (f.channel === "sms" ? "tcpa_sms" : "tcpa_voice") });
  return r.valid ? { open: true } : { open: false, reason: `no_pewc:${r.reasons.join(",")}` };
}
export function nationalDncGateFromFacts(f: Record<string, unknown>): GateResult {
  if (f.on_national_registry !== true) return { open: true };
  const ebr = ebrBasis({ as_of: plainDate(String(f.as_of ?? "")), last_transaction_on: (f.last_transaction_on as PlainDate | null | undefined) ?? null, last_inquiry_on: (f.last_inquiry_on as PlainDate | null | undefined) ?? null, company_dnc_requested_on: (f.company_dnc_requested_on as PlainDate | null | undefined) ?? null });
  if (ebr.basis === "transaction_18m" || ebr.basis === "inquiry_3m") return { open: true };
  if (f.national_dnc_written_permission === true) return { open: true };
  return { open: false, reason: ebr.terminated_by_company_dnc ? "national_dnc:ebr_terminated_by_company_dnc" : "national_dnc:no_ebr_no_written_permission" };
}
export function ebrWindowFromFacts(f: Record<string, unknown>, basis: "transaction_18m" | "inquiry_3m"): GateResult {
  const ebr = ebrBasis({ as_of: plainDate(String(f.as_of ?? "")), last_transaction_on: basis === "transaction_18m" ? ((f.anchor_on ?? f.last_transaction_on) as PlainDate | null | undefined) ?? null : null, last_inquiry_on: basis === "inquiry_3m" ? ((f.anchor_on ?? f.last_inquiry_on) as PlainDate | null | undefined) ?? null : null, company_dnc_requested_on: (f.company_dnc_requested_on as PlainDate | null | undefined) ?? null });
  return ebr.basis === basis ? { open: true } : { open: false, reason: ebr.terminated_by_company_dnc ? "ebr_terminated_by_company_dnc" : `ebr_${basis}_lapsed_or_absent` };
}
export function quietHoursGateFromFacts(f: Record<string, unknown>): GateResult {
  const tzs = Array.isArray(f.time_zones) ? (f.time_zones as string[]) : typeof f.tz === "string" ? [f.tz] : [];
  if (!tzs.length || typeof f.at !== "string") return { open: false, reason: "quiet_hours:called_party_time_zone_unknown" };
  const q = quietHoursCheck({ at: f.at, time_zones: tzs, channel: (f.channel as Channel | undefined) ?? "ai_voice", state_window: (f.state_window as { open: string; close: string } | null | undefined) ?? null });
  return q.permitted ? { open: true } : { open: false, reason: `quiet_hours:${q.reason} (next ${q.reschedule_to?.date} ${q.reschedule_to?.local_time} ${q.reschedule_to?.tz})` };
}
export function creativeApprovalGateFromFacts(f: Record<string, unknown>): GateResult {
  return creativeApprovalGate({ creative: (f.creative as Creative | null | undefined) ?? null, rendered_text: (f.rendered_text as string | null | undefined) ?? null, ...(typeof f.rate_sheet_current === "boolean" ? { rate_sheet_current: f.rate_sheet_current } : {}) });
}
export function prescreenGateFromFacts(f: Record<string, unknown>): GateResult {
  return prescreenNoticeGate({ campaign_kind: (f.campaign_kind as CampaignKind | undefined) ?? "prescreen", channel: (f.channel as Channel | undefined) ?? "mail", flags: { prescreen_enabled: f.prescreen_enabled === true }, prescreen: (f.prescreen as PrescreenFacts | null | undefined) ?? null });
}
