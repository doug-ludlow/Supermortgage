/**
 * §20.3 Lead intake, identity, E-SIGN/TCPA consents and the pre-qualification interview — the pure rules of the
 * `intake` agent over the `leads` aggregate (migration 0077: leads, lead_interactions, prequalifications,
 * credit_authorizations; consents{kind=ai_disclosure_ack|esign} on the 7.4 table). One small function per rule / T-id;
 * every function validates, returns a copy of the lead and appends its event with `aggregate: {kind: "lead"}` and
 * `origination: true` (src/kernel/timers/engine.ts arms origination rows only on origination context).
 *
 * The lead becomes the application: `convertToApplication` opens 21.1's intake record with `id = lead_id` (one id
 * space — pricing_quotes.lead_id, consents.lead_id and applications.id name the same file), so `application.received`
 * and `application.trid_received` are 21.1's emissions (receiveApplication / captureSixItem → detectSixItems) and 21.2's
 * `REGZ_1026_19E1_LE_3BD` and 21.6's `REGB_1002_9_DECISION_30` arm exactly once on them.
 *
 * Events (subject = the lead unless noted):
 *   lead.created{channel, loan_id, opportunity_id, party_id, consumer_state, last_activity_at, last_activity_on, expires_on}   [arms SM_LEAD_INACTIVITY_EXPIRY_90]
 *   lead.interaction.started{interaction_id, channel, ai}                    [ai=true arms SM_AI_INTERACTION_DISCLOSURE_GATE]
 *   lead.disclosure.delivered{interaction_id, version, template, state_variant, reason}   [satisfies the disclosure gate]
 *   lead.utterance.blocked{gate|classification, interaction_id}             [a substantive answer before disclosure; a decline draft]
 *   consent.granted{kind, version, scope, status, consent_id, covers_origination_disclosures}   [ai_disclosure_ack / esign / tcpa_*]
 *   lead.authenticated{level, assurance_level, method}                     [level=L2 satisfies SM_LEAD_AUTH_BEFORE_DISCLOSURE_GATE]
 *   lead.onfile_data.requested{what, assurance_level, withheld}            [arms SM_LEAD_AUTH_BEFORE_DISCLOSURE_GATE]
 *   credit.authorization.captured{authorization_id, kind, end_user, permissible_purpose}
 *   credit.softpull.requested{authorization_id, end_user, permissible_purpose}   [arms FCRA_1681B_A3_SOFT_PULL_PURPOSE_GATE]
 *   credit.softpull.refused{gate, reason} · credit.softpull.received{report_id, authorization_id, representative_score, frozen}   [satisfies the FCRA gate]
 *   prequal.information_provided{prequal_id} · prequal.letter.issued{prequal_id, is_preapproval=false, hmda_record=false}
 *   lead.decline.attempted{application_received}                           [arms REGB_1002_2F_NO_PREQUAL_DECLINE_GATE; satisfied by 21.1's application.received]
 *   terms.presentation.requested (20.4's requestTermsReview; subject = the pricing quote)   [arms SM_MLO_PREAPP_TERMS_REVIEW_1BH]
 *   mlo.review.completed{quote_id, review_id, outcome, mlo_of_record_id, mlo_name, nmlsr_id} (subject = the pricing quote)   [satisfies it]
 *   terms.presented{quote_id, mlo_name, nmlsr_id, attribution}
 *   consent.esign.pending / consent.esign.verified / consent.esign.active (7.4's names; the origination scopes)
 *   lead.esign.invited{reason=oral_consent_void}                            [a voice "yes" is never a consent — 7001(c)(6)]
 *   co_admt.preuse_notice.delivered (21.6's recordPreuseNoticeDelivered; subject = the lead/application id)
 *   lead.trid_item.recorded{item, source, present, complete}
 *   lead.qualified{application_id, assurance_level, consents, channel, trid_items}   [the hand-off; satisfies SM_LEAD_INACTIVITY_EXPIRY_90]
 *   lead.expired{purged, retained, closed_reason} · lead.closed{reason} · human.transfer.requested{interaction_id, sla_seconds}
 *   DELTA-11 (32.14, the anonymous minute on the L0 lead — docs/ux/15 §2 S1–S3, §6):
 *   lead.goal.set{transaction_intent, contract_status, occupancy, step}   [the goal tile; re-emitted with the addition by the contract / occupancy chip]
 *   lead.state.set{consumer_state, property_state, state_variant} · lead.estimate.set{value_estimate_cents, stated_existing_balance_cents | price_range_cents, down_payment_cents, max_ltv_pct}
 *   lead.range.shown{low_pct, high_pct, apr_low_pct, apr_high_pct, product_code, rate_sheet_id, checklist_run_id, personal_terms=false}
 *   lead.linked{party_id} (the L1 link at verify) · intent.deferred{lead_id, status} (DELTA-13: "Not yet" — nothing ordered, pulled or converted)
 */
import { createHash } from "node:crypto";
import { type PlainDate, addDays, addMonths, startOfMonth, plainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { wallClock, zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { type Cents, levelPayment, ratePercent } from "../../kernel/money/cents.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import type { EscalationService, Escalation } from "../../app/escalations.ts";
import { newConsent, verify, channelFor, type Consent } from "../notices/esign.ts";
import { INTAKE_AGENT, AI_DISCLOSURE_TEMPLATE, ESIGN_CONSENT_TEMPLATE, newIntakeApplication, receiveApplication, captureSixItem, offerPrefill, confirmPrefill, leDueDate, localIso, type IntakeApplication, type SixItemKey } from "../application/ops-21-1.ts";
import { recordPreuseNoticeDelivered, decisionClock, CO_SB26_189_EFFECTIVE_FROM, coPreuseNoticeGate } from "../application/ops-21-6.ts";
import { requestTermsReview as requestQuoteTermsReview, presentQuote, DISCLAIMER_TEMPLATE, type PricingQuote, type MloReview } from "./ops-20-4.ts";
import { runContentChecklist, checklistFailures, type Checklists } from "./ops-20-2.ts";
import { computeApr } from "../compliance-disclosures/ops-25-1.ts";
import { prepaidInterest } from "../orig-boarding/ops-30-2.ts";

export { INTAKE_AGENT };
export const RULE_SET_VERSION_20_3 = "sm.lead_intake.2026.v1";
/** Rule 1: the first-contact disclosure version the fixture logs (T1: `consents(kind=ai_disclosure_ack)` with version 1.2). */
export const AI_DISCLOSURE_VERSION = "1.2";
export const PREQUAL_LETTER_TEMPLATE = "NTC_SM_PREQUAL_LETTER";
export const CO_ADMT_NOTICE_TEMPLATE = "NTC_CO_SB26_189_ADMT_NOTICE";
/** Open question 4: the Colorado pre-use line is delivered from Dec 1, 2026 by policy; the statutory gate applies to decisions on/after 2027-01-01. */
export const CO_PREUSE_POLICY_FROM = plainDate("2026-12-01");
/** Timer table: `SM_LEAD_INACTIVITY_EXPIRY_90` — +90 calendar days from the last consumer activity. */
export const LEAD_INACTIVITY_DAYS = 90;
/** Timer table: `SM_MLO_PREAPP_TERMS_REVIEW_1BH` — one business hour inside the MLO's 08:00–20:00 local window. */
export const MLO_REVIEW_HOURS = 1;
export const MLO_WINDOW = { open: "08:00", close: "20:00" } as const;
/** Rule 12 / 11.1: warm transfer to a `human_agent` starts within 10 seconds. */
export const HUMAN_TRANSFER_SLA_SECONDS = 10;
/** Rule 3: the criteria the agent may explain (max LTV by transaction type). */
export const PROGRAM_MAX_LTV_PCT = { limited_cash_out: 97, cash_out: 80, purchase: 97 } as const;
/** Rule 1: the disclosure line — the partner is named, SM appears as the operator. */
export const aiDisclosureText = (partner: string): string => `You're speaking with ${partner}'s automated assistant, operated by Supermortgage. I'm an AI, not a person. You can ask for a person at any time and I'll connect you.`;
/** Rule 1 (Utah request rule; UDAAP): a direct "are you a bot/human?" is always answered truthfully. */
export const areYouHumanAnswer = (partner: string): string => `No — I'm ${partner}'s automated assistant, operated by Supermortgage. I'm an AI, not a person. You can ask for a person at any time and I'll connect you.`;
/** Worked example 4: the Colorado point-of-interaction line (C.R.S. 6-1-1704). */
export const coPreuseLine = (partner: string, url: string): string => `${partner} uses automated decision-making technology in decisions about your loan; here's how to get more information: ${url}`;
/** State overlays (`jurisdiction_rules.ai_disclosure_rule`): UT high-risk up-front (repeat after 20 minutes / channel change); CA pre-use notice text; CO pre-use notice. */
export const AI_DISCLOSURE_STATE_VARIANTS: Readonly<Record<string, string>> = { UT: "ut_high_risk_upfront", CA: "ca_admt_preuse", CO: "co_sb26_189_preuse" };

// ============================================================ types
export type LeadChannel = "refi_trigger" | "organic" | "referral";
/** `refinance`/`undecided` are 20.1/20.2's coarse intents; the three 32.14 goal tiles write the 21.1 `transaction_type` itself (DELTA-11). */
export type TransactionIntent = "refinance" | "purchase" | "limited_cash_out" | "cash_out" | "undecided";
export type LeadStatus = "new" | "disclosed" | "authenticated" | "exploring" | "prequal_requested" | "prequalified" | "terms_review" | "terms_presented" | "applying" | "converted" | "expired" | "closed_lost";
export const ASSURANCE_LEVELS = ["L0_contact_unverified", "L1_channel_otp", "L2_account_authenticated", "L3_document_biometric", "L4_ssa_cbsv"] as const;
export type AssuranceLevel = (typeof ASSURANCE_LEVELS)[number];
export const assuranceRank = (l: AssuranceLevel): number => ASSURANCE_LEVELS.indexOf(l);
export const shortLevel = (l: AssuranceLevel): "L0" | "L1" | "L2" | "L3" | "L4" => l.slice(0, 2) as "L0" | "L1" | "L2" | "L3" | "L4";
export type InteractionChannel = "web_chat" | "voice_inbound" | "voice_outbound" | "sms" | "portal" | "email" | "human_call";
export type TridItemKey = "name" | "income" | "ssn_for_credit" | "property_address" | "value_estimate" | "loan_amount_sought";
export const TRID_ITEMS: readonly TridItemKey[] = ["name", "income", "ssn_for_credit", "property_address", "value_estimate", "loan_amount_sought"];
export type TridSource = "consumer_stated" | "on_file_confirmed" | "derived_not_counted";
export interface TridItem { readonly present: boolean; readonly source: TridSource | null; readonly at: string | null; readonly value: string | null; }
const EMPTY_TRID: TridItem = { present: false, source: null, at: null, value: null };
export interface LeadInteraction { readonly interaction_id: string; readonly channel: InteractionChannel; readonly started_at: string; readonly ended_at: string | null; readonly ai: boolean; readonly disclosure_delivered_at: string | null; readonly disclosure_version: string | null; readonly human_transfer_requested_at: string | null; readonly human_agent_id: string | null; readonly transcript_id: string | null; readonly recording_id: string | null; readonly state_rules_applied: readonly string[]; readonly agent_run_id: string | null; }
export type LeadConsentKind = "esign" | "tcpa_voice" | "tcpa_sms" | "ai_disclosure_ack";
export interface LeadConsent { readonly consent_id: string; readonly kind: LeadConsentKind; readonly party_id: string; readonly scope: readonly string[]; readonly status: Consent["status"] | "active"; readonly version: string; readonly captured_at: string; readonly captured_via: string; readonly verified_at: string | null; readonly evidence: Record<string, unknown>; }
export type PermissiblePurpose = "consumer_initiated_credit_transaction_1681b_a3A" | "account_review_1681b_a3A";
export interface CreditAuthorization { readonly authorization_id: string; readonly lead_id: string; readonly application_id: string | null; readonly kind: "soft_prequal" | "hard_application"; readonly party_id: string; readonly text_version: string; readonly text_version_hash: string; readonly signature_kind: "esign_click_typed_name" | "wet_ink"; readonly captured_at: string; readonly channel: InteractionChannel; readonly evidence: { readonly ip?: string; readonly user_agent?: string; readonly session_id?: string }; readonly permissible_purpose: PermissiblePurpose; readonly end_user: "partner"; readonly consumer_initiated: boolean; }
export interface SoftPullReport { readonly report_id: string; readonly authorization_id: string; readonly received_at: string; readonly representative_score: number | null; readonly score_model: "classic_fico" | "vantagescore_4"; readonly frozen: boolean; readonly fraud_alert: boolean; readonly tier: string | null; }
export type PrequalBasis = "consumer_stated_only" | "soft_pull";
export type PrequalOutcome = "information_provided" | "letter_issued" | "converted_to_application" | "abandoned";
/** DELTA-01: `prequalifications.kind` — the soft-pull prequalification (rule 4) or the Reg C §1003.2(b)(2) preapproval program (adopted; README §7). */
export type PrequalKind = "prequalification" | "preapproval";
export interface Prequalification { readonly prequal_id: string; readonly lead_id: string; readonly requested_at: string; readonly basis: PrequalBasis; readonly soft_pull_report_id: string | null; readonly estimated_representative_score: number | null; readonly score_source: string | null; readonly stated_income_cents: Cents | null; readonly stated_assets_cents: Cents | null; readonly value_estimate_cents: Cents | null; readonly loan_amount_range_cents: readonly [Cents, Cents] | null; readonly ltv_estimate: string | null; readonly program_fit: Record<string, unknown>; readonly quote_id: string | null; readonly outcome: PrequalOutcome | null; readonly letter_document_id: string | null; readonly retention_class: "regb_25m" | "sm_lead_36m"; readonly regb_decline_risk_flag: boolean;
  /** DELTA-01 (migration 0113): the preapproval program's columns — absent (or `prequalification`) on a rule-4 prequalification. */
  readonly kind?: PrequalKind; readonly du_casefile_id?: string | null; readonly approved_amount_cents?: Cents | null; readonly valid_until?: PlainDate | null; }
export interface ClassifierResult { readonly at: string; readonly interaction_id: string; readonly blocked: boolean; readonly matches: readonly string[]; readonly delivered: boolean; }
export interface Lead {
  readonly lead_id: string; readonly partner_id: string; readonly partner_name: string; readonly channel: LeadChannel; readonly source_touch_id: string | null; readonly opportunity_id: string | null;
  readonly loan_id: string | null; readonly party_id: string | null; readonly prospect: { readonly name?: string; readonly email?: string; readonly phone?: string; readonly state?: string } | null;
  readonly consumer_state: string | null; readonly property_state: string | null; readonly property_address: string | null; readonly transaction_intent: TransactionIntent; readonly time_zone: string;
  readonly status: LeadStatus; readonly assurance_level: AssuranceLevel; readonly first_interaction_at: string | null;
  readonly ai_disclosure_notice_id: string | null; readonly ai_disclosure_version: string | null; readonly co_admt_preuse_notice_id: string | null; readonly co_admt_preuse_delivered_at: string | null;
  readonly esign_consent_id: string | null; readonly tcpa_consent_ids: readonly string[]; readonly consents: readonly LeadConsent[];
  readonly credit_authorization_id: string | null; readonly credit_authorizations: readonly CreditAuthorization[]; readonly soft_pull_report: SoftPullReport | null; readonly soft_pull_purged: { readonly report_id: string; readonly deleted_on: PlainDate } | null;
  readonly prequal_id: string | null; readonly prequalifications: readonly Prequalification[]; readonly quote_ids: readonly string[];
  readonly mlo_of_record_id: string | null; readonly mlo_name: string | null; readonly mlo_nmlsr_id: string | null; readonly mlo_time_zone: string;
  readonly trid_items: Readonly<Record<TridItemKey, TridItem>>; readonly application_id: string | null; readonly regb_application_at: string | null; readonly trid_application_at: string | null;
  readonly last_activity_at: string; readonly expires_on: PlainDate; readonly closed_reason: string | null; readonly interactions: readonly LeadInteraction[]; readonly classifier_log: readonly ClassifierResult[];
  /** DELTA-11 (32.14 S1): the anonymous minute's rule-6 facts — nullable; cents ride the wire as decimal strings and are coerced on read (an older stored lead lacks the keys). */
  readonly occupancy: EntryOccupancy | null; readonly contract_status: ContractStatus | null; readonly value_estimate_cents: Cents | null; readonly stated_existing_balance_cents: Cents | null; readonly price_range_cents: Cents | null; readonly down_payment_cents: Cents | null;
}
/** A rule the intake agent refuses on — the gate code is the timer/guardrail code the spec names. */
export class IntakeRefused extends RangeError { readonly code: string; constructor(code: string, message: string) { super(`${code}: ${message}`); this.name = "IntakeRefused"; this.code = code; } }

// ============================================================ helpers
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const nonEmpty = (v: string | null | undefined, what: string): string => { if (typeof v !== "string" || v.trim() === "") throw new RangeError(`${what} is required`); return v; };
const isoInstant = (v: string, what: string): string => { if (typeof v !== "string" || Number.isNaN(Date.parse(v))) throw new RangeError(`${what} must be an ISO instant`); return v; };
export const civilDate = (iso: string, tz: string): PlainDate => wallClock(Date.parse(iso), tz).date;
const emit = (events: EventStore, lead: Lead, type: string, payload: Record<string, unknown>, at: string, actor: Actor = INTAKE_AGENT): DomainEvent =>
  events.append({ type, aggregate: { kind: "lead", id: lead.lead_id }, ...(lead.application_id ? { applicationId: lead.application_id } : {}), actor, occurredAt: at, payload: { lead_id: lead.lead_id, origination: true, ...payload } });
const interactionOf = (lead: Lead, id: string): LeadInteraction => { const x = lead.interactions.find((i) => i.interaction_id === id); if (!x) throw new RangeError(`no interaction ${id} on lead ${lead.lead_id}`); return x; };
const withInteraction = (lead: Lead, id: string, patch: Partial<LeadInteraction>): Lead => ({ ...lead, interactions: lead.interactions.map((i) => (i.interaction_id === id ? { ...i, ...patch } : i)) });
export const leadExpiresOn = (lastActivityOn: PlainDate): PlainDate => addDays(lastActivityOn, LEAD_INACTIVITY_DAYS);
/** Every consumer activity re-anchors the 90-day inactivity clock (rule: `lead.created` / each consumer activity). */
const touched = (lead: Lead, at: string): Lead => (lead.status === "converted" || lead.status === "expired" || lead.status === "closed_lost" ? lead : { ...lead, last_activity_at: at, expires_on: leadExpiresOn(civilDate(at, lead.time_zone)) });
const money = (c: Cents): string => { const neg = c < 0n; const v = neg ? -c : c; const d = v / 100n, r = v % 100n; return `${neg ? "-" : ""}$${d.toLocaleString("en-US")}.${r.toString().padStart(2, "0")}`; };
const cents = (v: string | Cents | number): Cents => (typeof v === "bigint" ? v : BigInt(String(v).replace(/[^0-9-]/g, "") || "0"));

// ============================================================ lead creation and interactions
export interface NewLeadInput { readonly lead_id: string; readonly partner_id: string; readonly partner_name: string; readonly channel: LeadChannel; readonly at: string; readonly source_touch_id?: string | null; readonly opportunity_id?: string | null; readonly loan_id?: string | null; readonly party_id?: string | null; readonly prospect?: Lead["prospect"]; readonly consumer_state?: string | null; readonly property_state?: string | null; readonly property_address?: string | null; readonly transaction_intent?: TransactionIntent; readonly time_zone?: string; readonly mlo_time_zone?: string; }
/** `lead.created{channel, loan_id, opportunity_id}` — the response to a 20.2 touch, an organic inquiry, a referral or a subserviced borrower's request; arms the 90-day inactivity clock on `last_activity_on`. */
export function createLead(events: EventStore, i: NewLeadInput): { lead: Lead; event: DomainEvent } {
  const at = isoInstant(i.at, "at"); const tz = i.time_zone ?? "America/New_York";
  if (!["refi_trigger", "organic", "referral"].includes(i.channel)) throw new RangeError(`channel ${String(i.channel)} is not one of refi_trigger/organic/referral`);
  if (i.channel === "refi_trigger" && !i.loan_id) throw new RangeError("a refi_trigger lead names the subserviced loan (loan_id)");
  const on = civilDate(at, tz);
  const lead: Lead = { lead_id: nonEmpty(i.lead_id, "lead_id"), partner_id: nonEmpty(i.partner_id, "partner_id"), partner_name: nonEmpty(i.partner_name, "partner_name"), channel: i.channel, source_touch_id: i.source_touch_id ?? null, opportunity_id: i.opportunity_id ?? null,
    loan_id: i.loan_id ?? null, party_id: i.party_id ?? null, prospect: i.prospect ?? null, consumer_state: i.consumer_state ?? i.prospect?.state ?? null, property_state: i.property_state ?? null, property_address: i.property_address ?? null, transaction_intent: i.transaction_intent ?? (i.loan_id ? "refinance" : "undecided"), time_zone: tz,
    status: "new", assurance_level: "L0_contact_unverified", first_interaction_at: null, ai_disclosure_notice_id: null, ai_disclosure_version: null, co_admt_preuse_notice_id: null, co_admt_preuse_delivered_at: null,
    esign_consent_id: null, tcpa_consent_ids: [], consents: [], credit_authorization_id: null, credit_authorizations: [], soft_pull_report: null, soft_pull_purged: null, prequal_id: null, prequalifications: [], quote_ids: [],
    mlo_of_record_id: null, mlo_name: null, mlo_nmlsr_id: null, mlo_time_zone: i.mlo_time_zone ?? tz, trid_items: { name: EMPTY_TRID, income: EMPTY_TRID, ssn_for_credit: EMPTY_TRID, property_address: EMPTY_TRID, value_estimate: EMPTY_TRID, loan_amount_sought: EMPTY_TRID },
    application_id: null, regb_application_at: null, trid_application_at: null, last_activity_at: at, expires_on: leadExpiresOn(on), closed_reason: null, interactions: [], classifier_log: [],
    occupancy: null, contract_status: null, value_estimate_cents: null, stated_existing_balance_cents: null, price_range_cents: null, down_payment_cents: null };
  return { lead, event: emit(events, lead, "lead.created", { channel: lead.channel, loan_id: lead.loan_id, opportunity_id: lead.opportunity_id, party_id: lead.party_id, source_touch_id: lead.source_touch_id, consumer_state: lead.consumer_state, property_state: lead.property_state, transaction_intent: lead.transaction_intent, last_activity_at: at, last_activity_on: on, expires_on: lead.expires_on, timer: "SM_LEAD_INACTIVITY_EXPIRY_90" }, at) };
}
/** Rule 10: a phone number given in the inquiry is prior express consent for informational calls/texts about that inquiry (marketing PEWC only through 20.2). */
export function informationalTcpaConsent(events: EventStore, lead: Lead, c: { consent_id: string; kind: "tcpa_voice" | "tcpa_sms"; number: string; at: string; party_id?: string }): { lead: Lead; consent: LeadConsent; event: DomainEvent } {
  const at = isoInstant(c.at, "at"); nonEmpty(c.number, "number");
  const consent: LeadConsent = { consent_id: nonEmpty(c.consent_id, "consent_id"), kind: c.kind, party_id: c.party_id ?? lead.party_id ?? lead.lead_id, scope: ["informational_about_this_inquiry"], status: "active", version: "20.3-r10", captured_at: at, captured_via: "inquiry_number_provided", verified_at: at, evidence: { channel_identifier: c.number, marketing: false } };
  const next = touched({ ...lead, consents: [...lead.consents, consent], tcpa_consent_ids: [...lead.tcpa_consent_ids, consent.consent_id] }, at);
  return { lead: next, consent, event: emit(events, next, "consent.granted", { kind: c.kind, consent_id: consent.consent_id, scope: consent.scope, status: "active", version: consent.version, marketing: false, covers_origination_disclosures: false }, at) };
}
/** `lead.interaction.started{channel, ai}` — every new conversation; `ai=true` arms SM_AI_INTERACTION_DISCLOSURE_GATE (human channels skip the disclosure). */
export function startInteraction(events: EventStore, lead: Lead, s: { interaction_id: string; channel: InteractionChannel; started_at: string; ai: boolean; agent_run_id?: string | null; transcript_id?: string | null; recording_id?: string | null }): { lead: Lead; interaction: LeadInteraction; event: DomainEvent } {
  const at = isoInstant(s.started_at, "started_at");
  if (lead.interactions.some((i) => i.interaction_id === s.interaction_id)) throw new RangeError(`interaction ${s.interaction_id} already exists`);
  if (lead.status === "expired" || lead.status === "closed_lost") throw new RangeError(`lead ${lead.lead_id} is ${lead.status}`);
  const rules = [lead.consumer_state, lead.property_state].filter((st): st is string => !!st && st in AI_DISCLOSURE_STATE_VARIANTS).map((st) => `${st}:${AI_DISCLOSURE_STATE_VARIANTS[st]}`);
  const interaction: LeadInteraction = { interaction_id: nonEmpty(s.interaction_id, "interaction_id"), channel: s.channel, started_at: at, ended_at: null, ai: s.ai, disclosure_delivered_at: null, disclosure_version: null, human_transfer_requested_at: null, human_agent_id: null, transcript_id: s.transcript_id ?? null, recording_id: s.recording_id ?? null, state_rules_applied: [...new Set(rules)], agent_run_id: s.agent_run_id ?? null };
  const next = touched({ ...lead, first_interaction_at: lead.first_interaction_at ?? at, interactions: [...lead.interactions, interaction], status: !s.ai && lead.status === "new" ? "disclosed" : lead.status }, at);
  return { lead: next, interaction, event: emit(events, next, "lead.interaction.started", { interaction_id: interaction.interaction_id, channel: interaction.channel, ai: s.ai, state_rules_applied: interaction.state_rules_applied, timer: "SM_AI_INTERACTION_DISCLOSURE_GATE" }, at) };
}
/** SM_AI_INTERACTION_DISCLOSURE_GATE facts: `{ai, disclosure_delivered, substantive?}` — no substantive exchange on an AI channel before the disclosure; "how to reach a person" is always allowed. */
export function aiDisclosureGate(f: Record<string, unknown>): { open: boolean; reason?: string } {
  if (f.ai !== true) return { open: true };
  if (f.substantive === false) return { open: true };
  return f.disclosure_delivered === true ? { open: true } : { open: false, reason: "no substantive exchange before NTC_SM_AI_INTERACTION_DISCLOSURE is delivered and logged (rule 1; UT/CA/CO overlays); the conversation is limited to how to reach a person" };
}
export const aiDisclosureFacts = (lead: Lead, interaction_id: string, substantive = true): Record<string, unknown> => { const i = interactionOf(lead, interaction_id); return { ai: i.ai, disclosure_delivered: i.disclosure_delivered_at !== null, substantive }; };
/** Rule 1 / T1: the first substantive answer is blocked until `deliverDisclosure`; the gate refusal is logged as a blocked utterance. */
export function answerQuestion(events: EventStore, lead: Lead, q: { interaction_id: string; question: string; at: string; substantive?: boolean }): { lead: Lead; allowed: true; event: DomainEvent } {
  const at = isoInstant(q.at, "at"); const g = aiDisclosureGate(aiDisclosureFacts(lead, q.interaction_id, q.substantive ?? true));
  if (!g.open) { emit(events, lead, "lead.utterance.blocked", { interaction_id: q.interaction_id, gate: "SM_AI_INTERACTION_DISCLOSURE_GATE", question: q.question, fallback: "deliverDisclosure first; only 'how to reach a person' may be answered" }, at); throw new IntakeRefused("SM_AI_INTERACTION_DISCLOSURE_GATE", g.reason!); }
  const next = touched(lead, at);
  return { lead: next, allowed: true, event: emit(events, next, "lead.question.answered", { interaction_id: q.interaction_id, question: q.question, substantive: q.substantive ?? true }, at) };
}
export type DisclosureReason = "first_contact" | "direct_question" | "repeat_20_minutes" | "channel_change";
/** Rule 1: `NTC_SM_AI_INTERACTION_DISCLOSURE` (state variant) delivered and logged as `consents(kind=ai_disclosure_ack)` with version and timestamp → `lead.disclosure.delivered` closes the gate; `new → disclosed`. */
export function deliverDisclosure(events: EventStore, lead: Lead, d: { interaction_id: string; at: string; notice_id?: string | null; version?: string; reason?: DisclosureReason }): { lead: Lead; consent: LeadConsent; text: string; state_variant: string | null; events: DomainEvent[] } {
  const at = isoInstant(d.at, "at"); const i = interactionOf(lead, d.interaction_id); const version = d.version ?? AI_DISCLOSURE_VERSION; const reason = d.reason ?? (i.disclosure_delivered_at ? "direct_question" : "first_contact");
  const state = [lead.consumer_state, lead.property_state].find((st) => !!st && st in AI_DISCLOSURE_STATE_VARIANTS) ?? null; const state_variant = state ? AI_DISCLOSURE_STATE_VARIANTS[state]! : null;
  const consent: LeadConsent = { consent_id: `${lead.lead_id}:ai_disclosure_ack:${d.interaction_id}:${lead.consents.filter((c) => c.kind === "ai_disclosure_ack").length + 1}`, kind: "ai_disclosure_ack", party_id: lead.party_id ?? lead.lead_id, scope: ["ai_interaction"], status: "active", version, captured_at: at, captured_via: i.channel, verified_at: at, evidence: { interaction_id: d.interaction_id, notice_id: d.notice_id ?? null, state_variant, reason } };
  let next = withInteraction(lead, d.interaction_id, { disclosure_delivered_at: i.disclosure_delivered_at ?? at, disclosure_version: version });
  next = touched({ ...next, status: next.status === "new" ? "disclosed" : next.status, ai_disclosure_notice_id: next.ai_disclosure_notice_id ?? d.notice_id ?? null, ai_disclosure_version: version, consents: [...next.consents, consent] }, at);
  const delivered = emit(events, next, "lead.disclosure.delivered", { interaction_id: d.interaction_id, version, template: AI_DISCLOSURE_TEMPLATE, state_variant, reason, notice_id: d.notice_id ?? null }, at);
  const granted = emit(events, next, "consent.granted", { kind: "ai_disclosure_ack", consent_id: consent.consent_id, version, scope: consent.scope, status: "active", interaction_id: d.interaction_id, covers_origination_disclosures: false }, at);
  return { lead: next, consent, text: aiDisclosureText(lead.partner_name), state_variant, events: [delivered, granted] };
}
/** Rule 1 / T11: "am I talking to a real person?" — answered truthfully and the disclosure re-logged (Utah request rule; UDAAP). */
export function answerAreYouHuman(events: EventStore, lead: Lead, q: { interaction_id: string; at: string }): { lead: Lead; answer: string; relogged: DomainEvent; events: DomainEvent[] } {
  const r = deliverDisclosure(events, lead, { interaction_id: q.interaction_id, at: q.at, reason: "direct_question" });
  return { lead: r.lead, answer: areYouHumanAnswer(lead.partner_name), relogged: r.events[0]!, events: r.events };
}
/** Rule 12: "person" at any time → warm transfer to a `human_agent` (SLA 10 s per 11.1); the human continues in the same lead record. */
export function transferToHuman(events: EventStore, escalations: EscalationService, lead: Lead, r: { interaction_id: string; at: string; reason?: string; terms_to_be_discussed?: boolean }): { lead: Lead; escalation: Escalation; sla_seconds: number; event: DomainEvent } {
  const at = isoInstant(r.at, "at"); interactionOf(lead, r.interaction_id);
  const role = r.terms_to_be_discussed ? "mlo_of_record" : "human_agent";
  const escalation = escalations.open({ kind: role === "mlo_of_record" ? "mlo_of_record" : "human_agent", ownerRole: role, ...(lead.application_id ? { applicationId: lead.application_id } : {}), payload: { lead_id: lead.lead_id, interaction_id: r.interaction_id, reason: r.reason ?? "consumer_request", sla_seconds: HUMAN_TRANSFER_SLA_SECONDS, safe_act: r.terms_to_be_discussed ? "terms are discussed by the mlo_of_record" : null } }, INTAKE_AGENT);
  const next = touched(withInteraction(lead, r.interaction_id, { human_transfer_requested_at: at }), at);
  return { lead: next, escalation, sla_seconds: HUMAN_TRANSFER_SLA_SECONDS, event: emit(events, next, "human.transfer.requested", { interaction_id: r.interaction_id, escalation_id: escalation.id, owner_role: role, sla_seconds: HUMAN_TRANSFER_SLA_SECONDS, reason: r.reason ?? "consumer_request" }, at) };
}
/**
 * 32.13 T-X-08 / SQ-30 (docs/ux/BACKEND-DELTAS.md §6): the person joins the interaction — `human.transfer.completed{interaction_id,
 * escalation_id, human_agent_id, human_agent_name, joined_at}`; the interaction records the agent and is no longer AI-led. Only after
 * `transferToHuman` on that interaction; the escalation is completed by the caller (the agent's own role closes it).
 */
export function completeHumanTransfer(events: EventStore, lead: Lead, r: { interaction_id: string; at: string; human_agent_id: string; human_agent_name?: string | null; escalation_id?: string | null }): { lead: Lead; event: DomainEvent } {
  const at = isoInstant(r.at, "at"); const i = interactionOf(lead, r.interaction_id);
  if (!i.human_transfer_requested_at) throw new RangeError(`no human transfer was requested on interaction ${r.interaction_id} (transfer_to_human first)`);
  const next = touched(withInteraction(lead, r.interaction_id, { human_agent_id: nonEmpty(r.human_agent_id, "human_agent_id"), ai: false }), at);
  return { lead: next, event: emit(events, next, "human.transfer.completed", { interaction_id: r.interaction_id, escalation_id: r.escalation_id ?? null, human_agent_id: r.human_agent_id, human_agent_name: r.human_agent_name ?? null, requested_at: i.human_transfer_requested_at, joined_at: at }, at) };
}

// ============================================================ Colorado pre-use notice (21.6's gate; 20.3 asserts it at the first interaction)
/** Worked example 4: the line is delivered to every Colorado consumer/property (policy from Dec 1, 2026 — always delivered here); the statutory gate exists only for interactions on/after 2027-01-01. */
export function coPreuseNoticeRequired(lead: Pick<Lead, "consumer_state" | "property_state">, on: PlainDate): { deliver: boolean; gate_required: boolean; basis: "statute" | "policy" | null } {
  const co = lead.consumer_state === "CO" || lead.property_state === "CO";
  if (!co) return { deliver: false, gate_required: false, basis: null };
  const statute = on >= CO_SB26_189_EFFECTIVE_FROM;
  return { deliver: true, gate_required: statute, basis: statute ? "statute" : "policy" };
}
export const coPreuseFacts = (lead: Lead, on: PlainDate): Record<string, unknown> => ({ consumer_state: lead.consumer_state, property_state: lead.property_state, interaction_on: on, preuse_notice_delivered: lead.co_admt_preuse_notice_id !== null });
/** 6-1-1704: the point-of-interaction line + public notice URL before any ADMT-influenced eligibility/pricing output — 21.6's `co_admt.preuse_notice.delivered` on the lead's id (the application id it becomes). */
/** 21.6 keys the pre-use event on the application; a lead that has no application yet records it on its own aggregate (the hosted store keys `loan_events.application_id` to `applications`), the payload still naming the id the lead becomes (32.14 DELTA-11: the Colorado line at the state chip, T2). */
function leadKeyed(events: EventStore, lead: Lead): EventStore {
  if (lead.application_id) return events;
  return new Proxy(events, { get: (target, prop, receiver) => (prop === "append" ? (input: Parameters<EventStore["append"]>[0]) => { const { applicationId: _application, ...rest } = input; return target.append({ ...rest, aggregate: { kind: "lead", id: lead.lead_id } }); } : Reflect.get(target, prop, receiver)) });
}
export function deliverCoPreuseNotice(events: EventStore, lead: Lead, d: { at: string; notice_id: string; public_notice_url: string }): { lead: Lead; text: string; gate_required: boolean; event: DomainEvent } {
  const at = isoInstant(d.at, "at"); const on = civilDate(at, lead.time_zone); const req = coPreuseNoticeRequired(lead, on);
  if (!req.deliver) throw new RangeError("the Colorado pre-use notice is delivered only where consumer_state=CO or property_state=CO");
  const event = recordPreuseNoticeDelivered(leadKeyed(events, lead), { application_id: lead.application_id ?? lead.lead_id, notice_id: nonEmpty(d.notice_id, "notice_id"), delivered_at: at, state: "CO", public_notice_url: nonEmpty(d.public_notice_url, "public_notice_url") }, INTAKE_AGENT);
  const next = touched({ ...lead, co_admt_preuse_notice_id: d.notice_id, co_admt_preuse_delivered_at: at }, at);
  return { lead: next, text: coPreuseLine(lead.partner_name, d.public_notice_url), gate_required: req.gate_required, event };
}
/** Any eligibility/pricing output for a Colorado consumer on/after 2027-01-01 asserts 21.6's gate first. */
export function assertPricingOutputAllowed(lead: Lead, at: string): void {
  const g = coPreuseNoticeGate(coPreuseFacts(lead, civilDate(at, lead.time_zone)));
  if (!g.open) throw new IntakeRefused("CO_SB26_189_1704_PREUSE_NOTICE_GATE", g.reason ?? "pre-use notice not delivered");
}

// ============================================================ rule 2: identity levels and the on-file-data gate
/** 32.14 §3 (DELTA-12): `oidc_google` — a verified Google identity — is L1 like a code (no on-file data before L2). */
export type AuthMethod = "otp_email" | "otp_sms" | "portal_login" | "auth_script_4x" | "oidc_google";
export const authLevelFor = (method: AuthMethod): AssuranceLevel => (method === "portal_login" || method === "auth_script_4x" ? "L2_account_authenticated" : "L1_channel_otp");
/** L1: OTP to the entered email/phone (prospects); L2: portal login or the 4.x authentication script (existing borrowers). */
export function authenticate(events: EventStore, lead: Lead, a: { method: AuthMethod; at: string; evidence?: Record<string, unknown> }): { lead: Lead; level: AssuranceLevel; event: DomainEvent } {
  const at = isoInstant(a.at, "at"); const level = authLevelFor(a.method);
  if (level === "L2_account_authenticated" && !lead.party_id && !lead.loan_id) throw new RangeError("L2 is an existing borrower's authentication (portal login / 4.x script) — the lead names no party_id/loan_id");
  const next = touched({ ...lead, assurance_level: assuranceRank(level) > assuranceRank(lead.assurance_level) ? level : lead.assurance_level, status: lead.status === "disclosed" || lead.status === "new" ? "authenticated" : lead.status }, at);
  return { lead: next, level: next.assurance_level, event: emit(events, next, "lead.authenticated", { level: shortLevel(next.assurance_level), assurance_level: next.assurance_level, method: a.method, evidence: a.evidence ?? {} }, at) };
}
/** SM_LEAD_AUTH_BEFORE_DISCLOSURE_GATE facts: `{assurance_level, data_class}` — on-file loan/servicing data needs L2; a prospect's own entered data needs L1. */
export function authBeforeDisclosureGate(f: Record<string, unknown>): { open: boolean; reason?: string } {
  const level = String(f.assurance_level ?? "L0_contact_unverified") as AssuranceLevel; const rank = ASSURANCE_LEVELS.includes(level) ? assuranceRank(level) : 0;
  const cls = String(f.data_class ?? "on_file");
  if (cls === "own_entered") return rank >= 1 ? { open: true } : { open: false, reason: "a prospect's own entered data is discussed at L1 (OTP) or above" };
  return rank >= 2 ? { open: true } : { open: false, reason: "on-file loan/servicing data is withheld until assurance_level ≥ L2 (portal login or the 4.x authentication script)" };
}
/** T2: "what's my rate?" — the on-file rate is withheld until L2; the request itself is logged (the gate's trigger). */
export function requestOnFileData<T>(events: EventStore, lead: Lead, r: { what: string; at: string; interaction_id?: string; onfile: () => T }): { lead: Lead; provided: T; event: DomainEvent } {
  const at = isoInstant(r.at, "at"); const g = authBeforeDisclosureGate({ assurance_level: lead.assurance_level, data_class: "on_file" });
  const event = emit(events, lead, "lead.onfile_data.requested", { what: r.what, interaction_id: r.interaction_id ?? null, assurance_level: lead.assurance_level, withheld: !g.open, timer: "SM_LEAD_AUTH_BEFORE_DISCLOSURE_GATE" }, at);
  if (!g.open) throw new IntakeRefused("SM_LEAD_AUTH_BEFORE_DISCLOSURE_GATE", g.reason!);
  return { lead: touched(lead, at), provided: r.onfile(), event };
}

// ============================================================ rule 2 / 9: credit authorizations and the soft pull (FCRA_1681B_A3_SOFT_PULL_PURPOSE_GATE)
export interface AuthorizationInput { readonly authorization_id: string; readonly kind: "soft_prequal" | "hard_application"; readonly party_id?: string; readonly text_version: string; readonly signature_kind?: CreditAuthorization["signature_kind"]; readonly captured_at: string; readonly channel: InteractionChannel; readonly evidence?: CreditAuthorization["evidence"]; readonly permissible_purpose?: PermissiblePurpose; readonly end_user?: string; readonly consumer_initiated?: boolean; readonly consumer_entered_identity?: boolean; }
/** `credit_authorizations{kind=soft_prequal, permissible_purpose=consumer_initiated_credit_transaction_1681b_a3A, end_user=partner}` captured by the consumer at ≥ L1; open question 1 (default yes): the authorization is the TRID "SSN to obtain a credit report" item. */
export function captureCreditAuthorization(events: EventStore, lead: Lead, a: AuthorizationInput): { lead: Lead; authorization: CreditAuthorization; event: DomainEvent } {
  const at = isoInstant(a.captured_at, "captured_at");
  if ((a.end_user ?? "partner") !== "partner") throw new RangeError("the partner is the FCRA end user of every consumer report (end_user=partner)");
  if (assuranceRank(lead.assurance_level) < 1) throw new IntakeRefused("FCRA_1681B_A3_SOFT_PULL_PURPOSE_GATE", "a soft-pull authorization requires assurance_level ≥ L1 and the consumer's own entry/confirmation of name, address, DOB and SSN/ITIN (rule 2)");
  if (a.consumer_entered_identity === false) throw new IntakeRefused("FCRA_1681B_A3_SOFT_PULL_PURPOSE_GATE", "the on-file SSN of an L2 borrower may be used only after the consumer authorizes it in-session (rule 2)");
  const authorization: CreditAuthorization = { authorization_id: nonEmpty(a.authorization_id, "authorization_id"), lead_id: lead.lead_id, application_id: lead.application_id, kind: a.kind, party_id: a.party_id ?? lead.party_id ?? lead.lead_id, text_version: nonEmpty(a.text_version, "text_version"), text_version_hash: sha256(a.text_version), signature_kind: a.signature_kind ?? "esign_click_typed_name", captured_at: at, channel: a.channel, evidence: a.evidence ?? {}, permissible_purpose: a.permissible_purpose ?? "consumer_initiated_credit_transaction_1681b_a3A", end_user: "partner", consumer_initiated: a.consumer_initiated ?? true };
  let next: Lead = { ...lead, credit_authorizations: [...lead.credit_authorizations, authorization], credit_authorization_id: a.kind === "soft_prequal" ? authorization.authorization_id : lead.credit_authorization_id, status: lead.status === "authenticated" || lead.status === "disclosed" ? "exploring" : lead.status };
  if (a.kind === "soft_prequal") next = { ...next, trid_items: { ...next.trid_items, ssn_for_credit: { present: true, source: "consumer_stated", at, value: `authorization:${authorization.authorization_id}` } } };
  next = touched(next, at);
  return { lead: next, authorization, event: emit(events, next, "credit.authorization.captured", { authorization_id: authorization.authorization_id, kind: a.kind, end_user: "partner", permissible_purpose: authorization.permissible_purpose, text_version_hash: authorization.text_version_hash, signature_kind: authorization.signature_kind, trid_item_ssn_for_credit: a.kind === "soft_prequal" }, at) };
}
/** FCRA_1681B_A3_SOFT_PULL_PURPOSE_GATE facts: `{authorization_kind, assurance_level, consumer_initiated, end_user}`. */
export function softPullPurposeGate(f: Record<string, unknown>): { open: boolean; reason?: string } {
  if (f.authorization_kind !== "soft_prequal") return { open: false, reason: "no credit_authorizations(kind=soft_prequal) captured by the consumer — 15 U.S.C. 1681b(a)(3)(A): the pull is refused" };
  const level = String(f.assurance_level ?? "") as AssuranceLevel; if (!ASSURANCE_LEVELS.includes(level) || assuranceRank(level) < 1) return { open: false, reason: "assurance_level ≥ L1 is required for a soft pull" };
  if (f.consumer_initiated !== true) return { open: false, reason: "the request must be consumer-initiated and logged (a soft pull to select borrowers is a prescreen — 20.1)" };
  if (f.end_user !== "partner") return { open: false, reason: "end_user must be the partner (the creditor is the FCRA end user)" };
  return { open: true };
}
export const softPullFacts = (lead: Lead): Record<string, unknown> => { const a = lead.credit_authorizations.find((x) => x.authorization_id === lead.credit_authorization_id && x.kind === "soft_prequal"); return { authorization_kind: a?.kind ?? null, assurance_level: lead.assurance_level, consumer_initiated: a?.consumer_initiated ?? false, end_user: a?.end_user ?? null }; };
/** T3: `orderSoftPull` — refused without the authorization; otherwise `credit.softpull.requested{authorization_id}` keyed by the authorization (idempotent vendor request). */
export function orderSoftPull(events: EventStore, lead: Lead, o: { at: string; requested_by?: "consumer" | "agent" }): { lead: Lead; authorization_id: string; event: DomainEvent } {
  const at = isoInstant(o.at, "at"); const g = softPullPurposeGate(softPullFacts(lead));
  if (!g.open) { emit(events, lead, "credit.softpull.refused", { gate: "FCRA_1681B_A3_SOFT_PULL_PURPOSE_GATE", reason: g.reason, severity_if_bypassed: 1 }, at); throw new IntakeRefused("FCRA_1681B_A3_SOFT_PULL_PURPOSE_GATE", g.reason!); }
  if (lead.soft_pull_report) throw new RangeError(`soft pull ${lead.soft_pull_report.report_id} already received for authorization ${lead.credit_authorization_id}`);
  const a = lead.credit_authorizations.find((x) => x.authorization_id === lead.credit_authorization_id)!;
  const next = touched(lead, at);
  return { lead: next, authorization_id: a.authorization_id, event: emit(events, next, "credit.softpull.requested", { authorization_id: a.authorization_id, end_user: a.end_user, permissible_purpose: a.permissible_purpose, requested_by: o.requested_by ?? "consumer", idempotency_key: a.authorization_id, timer: "FCRA_1681B_A3_SOFT_PULL_PURPOSE_GATE" }, at) };
}
/** 20.4 rule 2's Classic FICO bands (the 09.09.2026 matrix rows): representative score → tier label. */
export function scoreTier(score: number | null): string | null {
  if (score === null) return null;
  if (score >= 780) return "≥780"; if (score >= 760) return "760–779"; if (score >= 740) return "740–759"; if (score >= 720) return "720–739"; if (score >= 700) return "700–719"; if (score >= 680) return "680–699"; if (score >= 660) return "660–679"; if (score >= 640) return "640–659"; return "≤639";
}
/** `credit.softpull.received{report_id, authorization_id}` — the report is linked to the authorization; a freeze is reported (no adverse inference; the consumer is told how to lift it). */
export function receiveSoftPull(events: EventStore, lead: Lead, r: { report_id: string; received_at: string; representative_score: number | null; score_model?: SoftPullReport["score_model"]; frozen?: boolean; fraud_alert?: boolean }): { lead: Lead; report: SoftPullReport; tier: string | null; freeze_instructions: string | null; event: DomainEvent } {
  const at = isoInstant(r.received_at, "received_at"); const authorization_id = lead.credit_authorization_id; if (!authorization_id) throw new IntakeRefused("FCRA_1681B_A3_SOFT_PULL_PURPOSE_GATE", "no authorization to link the report to");
  const report: SoftPullReport = { report_id: nonEmpty(r.report_id, "report_id"), authorization_id, received_at: at, representative_score: r.frozen ? null : r.representative_score, score_model: r.score_model ?? "classic_fico", frozen: r.frozen ?? false, fraud_alert: r.fraud_alert ?? false, tier: r.frozen ? null : scoreTier(r.representative_score) };
  const next = touched({ ...lead, soft_pull_report: report }, at);
  return { lead: next, report, tier: report.tier, freeze_instructions: report.frozen ? "your credit file is frozen; a temporary lift takes effect within one hour when requested electronically (15 U.S.C. 1681c-1(i)) — no adverse inference is drawn" : null,
    event: emit(events, next, "credit.softpull.received", { report_id: report.report_id, authorization_id, representative_score: report.representative_score, score_model: report.score_model, tier: report.tier, frozen: report.frozen, fraud_alert: report.fraud_alert, use_limited_to: ["representative_score_tier", "freeze_fraud_alert_detection", "liability_prefill_offered"] }, at) };
}

// ============================================================ rule 3 / 4: information-giving, the decline classifier, prequalification and the letter
/** Rule 3: the utterances the agent may never deliver — "does not qualify", "would be denied", "cannot get" and their contractions. */
export const DECLINE_PATTERNS: readonly RegExp[] = [
  /\b(?:would(?:n't| not)|will(?:n't| not)|won't|can(?:'t|not)|could(?:n't| not)|do(?:es)?(?:n't| not)|don't|aren't|isn't|not)\s+(?:be\s+)?(?:qualif(?:y|ied)|approved|eligible|get\s+(?:the|a|this)\s+loan)\b/i,
  /\b(?:be|been|were|was|are|is|get|got)\s+(?:denied|declined|turned\s+down|rejected)\b/i, /\bineligible\b/i, /\bno\s+way\s+(?:to|you)\b.*\b(?:qualify|approve)/i,
];
export function classifyDecline(text: string): { blocked: boolean; matches: string[] } {
  const matches = DECLINE_PATTERNS.map((p) => p.exec(text)?.[0] ?? null).filter((m): m is string => m !== null);
  return { blocked: matches.length > 0, matches };
}
/** Rule 3 / worked example 3: the criteria statement that replaces a blocked draft ("up to 97% of the value, which at $600,000 is $582,000"). */
export function criteriaStatement(i: { max_ltv_pct: number; value_cents: Cents }): { text: string; max_loan_cents: Cents } {
  const max_loan_cents = (i.value_cents * BigInt(i.max_ltv_pct)) / 100n;
  return { max_loan_cents, text: `For this program the loan can be up to ${i.max_ltv_pct}% of the value, which at ${money(i.value_cents)} is ${money(max_loan_cents)}; you could pay the difference down at closing, or we can revisit if the value estimate changes. If you'd like a formal decision, I can start an application.` };
}
/** Every generated utterance passes the classifier; a positive classification blocks it and the criteria statement is delivered instead — `regb_decline_risk_flag` stays false because no decline was communicated. */
export function screenUtterance(events: EventStore, lead: Lead, u: { interaction_id: string; draft: string; at: string; value_cents?: Cents; max_ltv_pct?: number }): { lead: Lead; blocked: boolean; delivered_text: string; matches: string[]; event: DomainEvent | null } {
  const at = isoInstant(u.at, "at"); interactionOf(lead, u.interaction_id); const c = classifyDecline(u.draft);
  const entry: ClassifierResult = { at, interaction_id: u.interaction_id, blocked: c.blocked, matches: c.matches, delivered: !c.blocked };
  let next: Lead = touched({ ...lead, classifier_log: [...lead.classifier_log, entry] }, at);
  if (!c.blocked) return { lead: next, blocked: false, delivered_text: u.draft, matches: [], event: null };
  const value = u.value_cents ?? (next.trid_items.value_estimate.value ? cents(next.trid_items.value_estimate.value) : null); if (value === null) throw new RangeError("a blocked decline draft is rewritten as a criteria statement — the value estimate is required");
  const rewritten = criteriaStatement({ max_ltv_pct: u.max_ltv_pct ?? PROGRAM_MAX_LTV_PCT.limited_cash_out, value_cents: value });
  next = { ...next, prequalifications: next.prequalifications.map((p) => (p.prequal_id === next.prequal_id ? { ...p, regb_decline_risk_flag: false } : p)) };
  return { lead: next, blocked: true, delivered_text: rewritten.text, matches: c.matches, event: emit(events, next, "lead.utterance.blocked", { interaction_id: u.interaction_id, classification: "regb_decline", matches: c.matches, rewritten_as: "criteria_statement", max_loan_cents: String(rewritten.max_loan_cents), regb_decline_risk_flag: false }, at) };
}
/** REGB_1002_2F_NO_PREQUAL_DECLINE_GATE facts: `{application_received}` — a decline may be communicated only once `application.received` exists (then 21.6 governs). */
export function noPrequalDeclineGate(f: Record<string, unknown>): { open: boolean; reason?: string } {
  return f.application_received === true ? { open: true } : { open: false, reason: "comment 2(f)-3: communicating a decline turns the inquiry into an application — the tool is refused at lead stage; the output is rewritten as a criteria explanation and a requested decision converts the lead (21.6 governs)" };
}
/** The `communicateDecline` tool exists only to fail loudly and route to conversion. */
export function communicateDecline(events: EventStore, lead: Lead, d: { at: string; interaction_id?: string }): never {
  const at = isoInstant(d.at, "at"); const g = noPrequalDeclineGate({ application_received: lead.regb_application_at !== null });
  // subject = the application the lead becomes (one id space), so 21.1's `application.received{applicationId=lead_id}` closes the gate instance
  events.append({ type: "lead.decline.attempted", aggregate: { kind: "application", id: lead.lead_id }, actor: INTAKE_AGENT, occurredAt: at, payload: { lead_id: lead.lead_id, origination: true, interaction_id: d.interaction_id ?? null, application_received: lead.regb_application_at !== null, gate: "REGB_1002_2F_NO_PREQUAL_DECLINE_GATE", route: g.open ? "21.6" : "criteria_explanation_or_conversion" } });
  throw new IntakeRefused("REGB_1002_2F_NO_PREQUAL_DECLINE_GATE", g.open ? "a communicated decline is 21.6's adverse action notice, never an intake utterance" : g.reason!);
}
/** Rule 3: general information the agent may give — criteria and the process, never a decision. */
export function explainProgram(i: { transaction_type: keyof typeof PROGRAM_MAX_LTV_PCT; occupancy?: string }): { criteria: string[]; decision_timeline: string } {
  return { criteria: [`maximum loan-to-value ${PROGRAM_MAX_LTV_PCT[i.transaction_type]}% for a ${i.transaction_type.replace(/_/g, " ")} transaction`, `${i.occupancy ?? "primary residence"} occupancy`, "DU-eligible products only", "third-party costs are paid by Supermortgage under the partner's program and recovered from the price the investor pays for the loan"], decision_timeline: "a written decision follows within 30 days of an application (Reg B §1002.9)" };
}
/** Rule 7: the general rate-sheet range ("today's 30-year fixed rates for this program range from X% to Y%") — published rates, not particular terms; always available, even while the MLO review is pending. */
export function generalRateRange(sheet: { readonly prices: readonly { readonly note_rate?: string; readonly note_rate_pct?: string; readonly product_code?: string }[] }, product_code = "FRM30"): { low_pct: string; high_pct: string; text: string } {
  const pct = (p: { note_rate?: string; note_rate_pct?: string }): string => p.note_rate_pct ?? (p.note_rate !== undefined ? (Math.round(Number(p.note_rate) * 100_000) / 1000).toFixed(3) : "");
  const rates = sheet.prices.filter((p) => !p.product_code || p.product_code === product_code).map(pct).filter((r) => r !== "").sort((a, b) => Number(a) - Number(b));
  if (!rates.length) throw new RangeError(`no ${product_code} prices on the sheet`);
  const low_pct = rates[0]!, high_pct = rates[rates.length - 1]!;
  return { low_pct, high_pct, text: `Today's 30-year fixed rates for this program range from ${low_pct}% to ${high_pct}% depending on credit and loan-to-value.` };
}
export interface PrequalInput { readonly prequal_id: string; readonly at: string; readonly stated_income_cents?: Cents | null; readonly stated_assets_cents?: Cents | null; readonly value_estimate_cents?: Cents | null; readonly loan_amount_range_cents?: readonly [Cents, Cents] | null; readonly program_fit?: Record<string, unknown>; /** DELTA-01: a preapproval request (P1) is a Reg B application; the row is `kind=preapproval` from the start */ readonly kind?: PrequalKind; }
/** `prequalifications{basis}` — soft_pull when a report is on the lead, else consumer_stated_only; income here is the purchase-prequal volunteer (rule 5), never the six-item income. */
export function requestPrequalification(events: EventStore, lead: Lead, p: PrequalInput): { lead: Lead; prequal: Prequalification; event: DomainEvent } {
  const at = isoInstant(p.at, "at"); const r = lead.soft_pull_report;
  const value = p.value_estimate_cents ?? null; const range = p.loan_amount_range_cents ?? null;
  const ltv = value && range ? ((Number(range[1]) / Number(value)) * 100).toFixed(2) : null;
  const prequal: Prequalification = { prequal_id: nonEmpty(p.prequal_id, "prequal_id"), lead_id: lead.lead_id, requested_at: at, basis: r ? "soft_pull" : "consumer_stated_only", soft_pull_report_id: r?.report_id ?? null, estimated_representative_score: r?.representative_score ?? null, score_source: r ? "soft_pull" : null, stated_income_cents: p.stated_income_cents ?? null, stated_assets_cents: p.stated_assets_cents ?? null, value_estimate_cents: value, loan_amount_range_cents: range, ltv_estimate: ltv, program_fit: p.program_fit ?? {}, quote_id: null, outcome: null, letter_document_id: null, retention_class: p.kind === "preapproval" ? "regb_25m" : "sm_lead_36m", regb_decline_risk_flag: false, kind: p.kind ?? "prequalification", du_casefile_id: null, approved_amount_cents: null, valid_until: null };
  const next = touched({ ...lead, prequal_id: prequal.prequal_id, prequalifications: [...lead.prequalifications, prequal], status: "prequal_requested" }, at);
  return { lead: next, prequal, event: emit(events, next, "prequal.requested", { prequal_id: prequal.prequal_id, basis: prequal.basis, soft_pull_report_id: prequal.soft_pull_report_id }, at) };
}
const currentPrequal = (lead: Lead): Prequalification => { const p = lead.prequalifications.find((x) => x.prequal_id === lead.prequal_id); if (!p) throw new RangeError("no prequalification requested (requestPrequalification first)"); return p; };
const withPrequal = (lead: Lead, patch: Partial<Prequalification>): Lead => ({ ...lead, prequalifications: lead.prequalifications.map((p) => (p.prequal_id === lead.prequal_id ? { ...p, ...patch } : p)) });
/** Outcome `information_provided` → `prequalified`. */
export function provideInformation(events: EventStore, lead: Lead, i: { at: string; program_fit?: Record<string, unknown> }): { lead: Lead; prequal: Prequalification; event: DomainEvent } {
  const at = isoInstant(i.at, "at"); currentPrequal(lead);
  const next = touched({ ...withPrequal(lead, { outcome: "information_provided", program_fit: i.program_fit ?? currentPrequal(lead).program_fit }), status: "prequalified" }, at);
  return { lead: next, prequal: currentPrequal(next), event: emit(events, next, "prequal.information_provided", { prequal_id: next.prequal_id, program_fit: currentPrequal(next).program_fit }, at) };
}
/** Rule 4 / T5: the prequalification letter is not a Reg C §1003.2(b)(2) preapproval (no written commitment after comprehensive analysis) — no `hmda_records` row; `NTC_SM_PREQUAL_LETTER` with the "not a commitment, not a preapproval" language. */
export function issuePrequalLetter(events: EventStore, lead: Lead, l: { at: string; letter_document_id: string; notice_id?: string | null }): { lead: Lead; prequal: Prequalification; template: string; is_preapproval: false; hmda_record_created: false; event: DomainEvent } {
  const at = isoInstant(l.at, "at"); const p = currentPrequal(lead);
  if (lead.trid_application_at) throw new RangeError("a lead with the six items is an application — 21.1/21.2 govern; no prequal letter after application.trid_received");
  const next = touched({ ...withPrequal(lead, { outcome: "letter_issued", letter_document_id: nonEmpty(l.letter_document_id, "letter_document_id") }), status: "prequalified" }, at);
  return { lead: next, prequal: currentPrequal(next), template: PREQUAL_LETTER_TEMPLATE, is_preapproval: false, hmda_record_created: false, event: emit(events, next, "prequal.letter.issued", { prequal_id: p.prequal_id, basis: p.basis, letter_document_id: l.letter_document_id, notice_id: l.notice_id ?? null, template: PREQUAL_LETTER_TEMPLATE, is_preapproval: false, hmda_record: false, hmda_preapproval_program: false, retention_class: p.retention_class }, at) };
}
// ============================================================ DELTA-01: the Reg C preapproval program (README §7 adopted; 32.3 P8; 28.3 `preapproval: 1`)
export const PREAPPROVAL_LETTER_TEMPLATE = "NTC_SM_PREAPPROVAL_LETTER";
export interface PreapprovalLetterInput { readonly at: string; readonly du_casefile_id: string; readonly approved_amount_cents: Cents; readonly valid_until: PlainDate; readonly letter_document_id: string; readonly application_id?: string | null; readonly quote_id?: string | null; readonly decision_id?: string | null; readonly product?: string | null; readonly prequal_id?: string | null; readonly notice_id?: string | null; }
/**
 * The written commitment after comprehensive analysis (DU on a property to be determined, 23.1 TBD casefile; the conditional approval of 23.3):
 * `prequalifications{kind=preapproval, du_casefile_id, approved_amount_cents, valid_until}` on the lead and `preapproval.letter.issued` on the
 * application (a HMDA preapproval record follows — 28.3). Never after `application.trid_received`: an address makes the request a TRID
 * application and 21.2's Loan Estimate governs; never without the Reg B application (`application.received`) the request is.
 */
export function issuePreapprovalLetter(events: EventStore, lead0: Lead, l: PreapprovalLetterInput): { lead: Lead; prequal: Prequalification; template: string; is_preapproval: true; hmda_preapproval_program: true; event: DomainEvent } {
  const at = isoInstant(l.at, "at"); nonEmpty(l.du_casefile_id, "du_casefile_id"); nonEmpty(l.letter_document_id, "letter_document_id"); nonEmpty(l.valid_until, "valid_until");
  if (l.approved_amount_cents <= 0n) throw new RangeError("approved_amount_cents must be positive");
  if (lead0.trid_application_at) throw new RangeError("a lead with the six items is a TRID application — 21.2's Loan Estimate governs; no preapproval letter after application.trid_received");
  const lead: Lead = { ...lead0, application_id: lead0.application_id ?? l.application_id ?? null, regb_application_at: lead0.regb_application_at ?? at };
  if (!lead.application_id) throw new RangeError("a preapproval request is a Reg B application — the lead names no application_id");
  const prequalId = l.prequal_id ?? lead.prequal_id ?? `PA-${lead.lead_id.slice(0, 8)}`;
  const existing = lead.prequalifications.find((p) => p.prequal_id === prequalId);
  const r = lead.soft_pull_report;
  const base: Prequalification = existing ?? { prequal_id: prequalId, lead_id: lead.lead_id, requested_at: at, basis: r ? "soft_pull" : "consumer_stated_only", soft_pull_report_id: r?.report_id ?? null, estimated_representative_score: r?.representative_score ?? null, score_source: r ? "soft_pull" : null, stated_income_cents: null, stated_assets_cents: null, value_estimate_cents: null, loan_amount_range_cents: null, ltv_estimate: null, program_fit: {}, quote_id: null, outcome: null, letter_document_id: null, retention_class: "regb_25m", regb_decline_risk_flag: false };
  const prequal: Prequalification = { ...base, kind: "preapproval", du_casefile_id: l.du_casefile_id, approved_amount_cents: l.approved_amount_cents, valid_until: l.valid_until, quote_id: l.quote_id ?? base.quote_id, outcome: "letter_issued", letter_document_id: l.letter_document_id, retention_class: "regb_25m" };
  const next = touched({ ...lead, prequal_id: prequalId, prequalifications: existing ? lead.prequalifications.map((p) => (p.prequal_id === prequalId ? prequal : p)) : [...lead.prequalifications, prequal] }, at);
  const event = emit(events, next, "preapproval.letter.issued", { application_id: next.application_id, prequal_id: prequalId, kind: "preapproval", du_casefile_id: l.du_casefile_id, approved_amount_cents: String(l.approved_amount_cents), valid_until: l.valid_until, letter_document_id: l.letter_document_id, quote_id: prequal.quote_id, decision_id: l.decision_id ?? null, product: l.product ?? "30-year fixed", notice_id: l.notice_id ?? null, template: PREAPPROVAL_LETTER_TEMPLATE, is_preapproval: true, is_commitment: true, hmda_preapproval_program: true, retention_class: "regb_25m" }, at);
  return { lead: next, prequal, template: PREAPPROVAL_LETTER_TEMPLATE, is_preapproval: true, hmda_preapproval_program: true, event };
}
/** The NTC_SM_PREAPPROVAL_LETTER payload: the partner as lender, the MLO of record with NMLSR ID, the approved amount and product, validity, the general conditions — never a promise (no "guarantee"). */
export function preapprovalLetterPayload(lead: Lead, p: Prequalification, i: { prepared_on: PlainDate; consumer_name: string; partner_nmlsr_id: string; product?: string | null; general_conditions?: readonly string[] }): Record<string, unknown> {
  const general_conditions = i.general_conditions ?? ["the property you choose must appraise for at least the purchase price and meet the program's eligibility requirements", "no material change in your income, assets, credit or debts before closing", "a signed purchase contract and the documentation the lender regularly obtains", "program eligibility and pricing on the day your rate is locked"];
  return { prepared_on: i.prepared_on, consumer_name: i.consumer_name, partner_name: lead.partner_name, partner_nmlsr_id: i.partner_nmlsr_id, mlo_name: lead.mlo_name ?? "[MLO of record]", mlo_nmlsr_id: lead.mlo_nmlsr_id ?? "[NMLSR ID]", prequal_id: p.prequal_id, approved_amount_cents: p.approved_amount_cents ?? 0n, product: i.product ?? "30-year fixed", valid_until: p.valid_until, du_casefile_id: p.du_casefile_id ?? null,
    is_preapproval: true, is_commitment: true, hmda_preapproval_program: true, general_conditions, condition_count: general_conditions.length };
}
/** The NTC_SM_PREQUAL_LETTER payload (placeholders for the partner/MLO identities the roster supplies). */
export function prequalLetterPayload(lead: Lead, p: Prequalification, i: { prepared_on: PlainDate; consumer_name: string; partner_nmlsr_id: string; general_conditions?: readonly string[] }): Record<string, unknown> {
  const range = p.loan_amount_range_cents;
  return { prepared_on: i.prepared_on, consumer_name: i.consumer_name, partner_name: lead.partner_name, partner_nmlsr_id: i.partner_nmlsr_id, mlo_name: lead.mlo_name ?? "[MLO of record]", mlo_nmlsr_id: lead.mlo_nmlsr_id ?? "[NMLSR ID]", prequal_id: p.prequal_id, basis: p.basis, soft_inquiry: p.basis === "soft_pull",
    amount_low_cents: range?.[0] ?? 0n, amount_high_cents: range?.[1] ?? 0n, has_amount_range: range !== null, transaction_intent: lead.transaction_intent, is_preapproval: false, is_commitment: false, hmda_preapproval_program: false,
    general_conditions: i.general_conditions ?? ["a full application and the documentation the lender regularly obtains", "verification of income, assets and credit", "an acceptable property, appraisal and title", "program eligibility at the time of application"] };
}

// ============================================================ rule 7: SAFE Act — personalized terms only after the MLO of record's review
export function assignMlo(lead: Lead, m: { mlo_of_record_id: string; name: string; nmlsr_id: string; time_zone?: string }): Lead {
  return { ...lead, mlo_of_record_id: nonEmpty(m.mlo_of_record_id, "mlo_of_record_id"), mlo_name: nonEmpty(m.name, "name"), mlo_nmlsr_id: nonEmpty(m.nmlsr_id, "nmlsr_id"), mlo_time_zone: m.time_zone ?? lead.mlo_time_zone };
}
/** `SM_MLO_PREAPP_TERMS_REVIEW_1BH`: +1 business hour inside the MLO's 08:00–20:00 local window on a `business_days_servicer` day (T7: 08:50 MST → 09:50 MST); outside the window the hour runs from the next window opening. */
export function mloReviewDueAt(requestedAtIso: string, tz: string): string {
  const ms = Date.parse(isoInstant(requestedAtIso, "requested_at")); const w = wallClock(ms, tz); const hhmm = `${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`;
  const isBd = (d: PlainDate) => servicer.isBusinessDay(d);
  const closeMs = zonedEpochMs(w.date, MLO_WINDOW.close, tz), openMs = zonedEpochMs(w.date, MLO_WINDOW.open, tz);
  let start = ms; let day = w.date;
  if (!isBd(day) || hhmm >= MLO_WINDOW.close) { day = addBusinessDays(day, 1, servicer); start = zonedEpochMs(day, MLO_WINDOW.open, tz); }
  else if (ms < openMs) start = openMs;
  let due = start + MLO_REVIEW_HOURS * 3_600_000;
  const close = day === w.date ? closeMs : zonedEpochMs(day, MLO_WINDOW.close, tz);
  if (due > close) { const carry = due - close; due = zonedEpochMs(addBusinessDays(day, 1, servicer), MLO_WINDOW.open, tz) + carry; }
  return toIso(due);
}
/** The personalized quote (20.4) asks for the MLO review — 20.4's `terms.presentation.requested` (the timer's trigger) on the quote; `prequalified → terms_review`. */
export function requestTermsReview(events: EventStore, lead: Lead, quote: PricingQuote, r: { requested_at: string }): { lead: Lead; due_at: string; event: DomainEvent } {
  const at = isoInstant(r.requested_at, "requested_at"); if (!lead.mlo_of_record_id) throw new RangeError("assign the mlo_of_record before personalized terms are requested (§1026.36(g))");
  if (quote.lead_id !== lead.lead_id) throw new RangeError(`quote ${quote.quote_id} belongs to lead ${quote.lead_id}, not ${lead.lead_id}`);
  assertPricingOutputAllowed(lead, at);
  const event = requestQuoteTermsReview(events, quote, { requested_at: at, mlo_of_record_id: lead.mlo_of_record_id }, INTAKE_AGENT);
  const next = touched({ ...lead, quote_ids: lead.quote_ids.includes(quote.quote_id) ? lead.quote_ids : [...lead.quote_ids, quote.quote_id], status: "terms_review", prequalifications: lead.prequalifications.map((p) => (p.prequal_id === lead.prequal_id ? { ...p, quote_id: quote.quote_id } : p)) }, at);
  return { lead: next, due_at: mloReviewDueAt(at, lead.mlo_time_zone), event };
}
/** `mlo.review.completed{outcome}` — the `mlo_of_record`'s own act on the quote (satisfies SM_MLO_PREAPP_TERMS_REVIEW_1BH); `returned` sends the lead back to `exploring`. */
export function completeMloReview(events: EventStore, lead: Lead, r: { quote_id: string; review_id: string; outcome: "approved" | "returned"; completed_at: string; by: Actor; notes?: string | null }): { lead: Lead; review: MloReview; event: DomainEvent } {
  const at = isoInstant(r.completed_at, "completed_at");
  if (r.by.kind !== "human" || r.by.role !== "mlo_of_record") throw new RangeError("the terms review is the mlo_of_record's act (SAFE Act: presenting particular terms)");
  if (!lead.mlo_of_record_id || !lead.mlo_name || !lead.mlo_nmlsr_id) throw new RangeError("no mlo_of_record assigned");
  if (!lead.quote_ids.includes(r.quote_id)) throw new RangeError(`quote ${r.quote_id} was not sent for review on lead ${lead.lead_id}`);
  const review: MloReview = { review_id: nonEmpty(r.review_id, "review_id"), outcome: r.outcome, mlo_of_record_id: lead.mlo_of_record_id, mlo_name: lead.mlo_name, nmlsr_id: lead.mlo_nmlsr_id, completed_at: at };
  const next: Lead = { ...lead, status: r.outcome === "returned" ? "exploring" : lead.status };
  const event = events.append({ type: "mlo.review.completed", actor: r.by, occurredAt: at, ...(lead.application_id ? { applicationId: lead.application_id } : {}), aggregate: { kind: "pricing_quote", id: r.quote_id }, payload: { lead_id: lead.lead_id, quote_id: r.quote_id, review_id: review.review_id, outcome: r.outcome, mlo_of_record_id: review.mlo_of_record_id, mlo_name: review.mlo_name, nmlsr_id: review.nmlsr_id, notes: r.notes ?? null, origination: true } });
  return { lead: next, review, event };
}
/** The presentation after approval names the MLO ("reviewed by [MLO name], NMLSR ID ####") with 20.4's written-quote disclaimer; 20.4's presentQuote refuses without `mlo.review.completed{approved}`. */
export function presentTerms(events: EventStore, lead: Lead, quote: PricingQuote, review: MloReview | null, p: { at: string }): { lead: Lead; quote: PricingQuote; attribution: string; text: string; events: DomainEvent[] } {
  const at = isoInstant(p.at, "at"); assertPricingOutputAllowed(lead, at);
  const r = presentQuote(events, quote, review, at, INTAKE_AGENT);
  const attribution = `reviewed by ${review!.mlo_name}, NMLSR ID ${review!.nmlsr_id}`;
  const next = touched({ ...lead, status: "terms_presented" }, at);
  const text = `Your rate would be ${quote.note_rate_pct ?? String(quote.note_rate)}%, with a monthly principal-and-interest payment of ${money(quote.pi_cents)} (${attribution}). This is an estimate — get an official Loan Estimate before choosing a loan.`;
  return { lead: next, quote: r.quote, attribution, text, events: [r.event, emit(events, next, "terms.presented", { quote_id: quote.quote_id, mlo_review_id: review!.review_id, mlo_name: review!.mlo_name, nmlsr_id: review!.nmlsr_id, attribution, disclaimer_template: DISCLAIMER_TEMPLATE, negotiation: "never — requests to negotiate route to the mlo_of_record" }, at)] };
}

// ============================================================ rule 8: E-SIGN capture on the 7.4 mechanism with the origination scopes
export const ORIGINATION_ESIGN_SCOPES = ["origination_disclosures", "origination_esign_signatures", "servicing_communications"] as const;
export interface EsignCaptureInput { readonly consent_id: string; readonly party_id?: string; readonly scopes: readonly string[]; readonly captured_via: "portal" | "ai_chat_link" | "voice"; readonly disclosure_version: string; readonly clicked_at: string; readonly ip?: string; readonly user_agent?: string; }
/** The (c)(1)(B)/(C) statement (NTC_SM_ESIGN_CONSENT) and the click → `pending_verification`; a chat/voice "yes" never counts (7001(c)(6)) — the link is sent instead. */
export function captureEsignConsent(events: EventStore, lead: Lead, c: EsignCaptureInput): { lead: Lead; consent: LeadConsent; underlying: Consent; events: DomainEvent[] } {
  const at = isoInstant(c.clicked_at, "clicked_at"); const party_id = c.party_id ?? lead.party_id ?? lead.lead_id;
  const unknown = c.scopes.filter((s) => !(ORIGINATION_ESIGN_SCOPES as readonly string[]).includes(s)); if (!c.scopes.length || unknown.length) throw new RangeError(`E-SIGN scopes must be among ${ORIGINATION_ESIGN_SCOPES.join("/")} (${unknown.join(", ") || "none given"})`);
  const created = newConsent(party_id, c.scopes, nonEmpty(c.disclosure_version, "disclosure_version"), civilDate(at, lead.time_zone), c.captured_via === "voice" ? "voice" : "portal");
  if ("error" in created) { emit(events, lead, "lead.esign.invited", { party_id, reason: "oral_consent_void", citation: "15 U.S.C. 7001(c)(6)", template: ESIGN_CONSENT_TEMPLATE, invitation: "NTC_ESIGN_VERIFICATION_EMAIL" }, at); throw new IntakeRefused("ESIGN_7001C6_ORAL_CONSENT_VOID", created.error); }
  const consent: LeadConsent = { consent_id: nonEmpty(c.consent_id, "consent_id"), kind: "esign", party_id, scope: [...c.scopes], status: "pending_verification", version: c.disclosure_version, captured_at: at, captured_via: c.captured_via, verified_at: null, evidence: { ip: c.ip ?? null, user_agent: c.user_agent ?? null, disclosure_hash: sha256(`${ESIGN_CONSENT_TEMPLATE}:${c.disclosure_version}`) } };
  const next = touched({ ...lead, consents: [...lead.consents, consent], esign_consent_id: consent.consent_id }, at);
  const disclosed = emit(events, next, "consent.esign.disclosed", { party_id, consent_id: consent.consent_id, disclosure_version: c.disclosure_version, template: ESIGN_CONSENT_TEMPLATE, classes: [...c.scopes], displayed_at: at, captured_via: c.captured_via }, at);
  const pending = emit(events, next, "consent.esign.pending", { party_id, consent_id: consent.consent_id, clicked_at: at, classes: [...c.scopes], disclosure_version: c.disclosure_version, captured_via: c.captured_via, expires_on: addDays(civilDate(at, lead.time_zone), 7), verification_email: "NTC_ESIGN_VERIFICATION_EMAIL" }, at);
  return { lead: next, consent, underlying: created, events: [disclosed, pending] };
}
/** (c)(1)(C)(ii): link opened from the email + token from the PDF → `active` (7.4's verify), `consent.esign.active` and the baseline `consent.granted{kind=esign, covers_origination_disclosures}` (closes SM_ESIGN_BEFORE_LE_GATE). */
export function completeEsignDemonstration(events: EventStore, lead: Lead, d: { consent_id: string; link_opened_at: string | null; token_entered_at: string | null; token_ok: boolean; ip?: string; user_agent?: string }): { lead: Lead; consent: LeadConsent; verified: boolean; reason: string | null; events: DomainEvent[] } {
  const c = lead.consents.find((x) => x.consent_id === d.consent_id && x.kind === "esign"); if (!c) throw new RangeError(`no esign consent ${d.consent_id} on lead ${lead.lead_id}`);
  if (c.status !== "pending_verification") return { lead, consent: c, verified: false, reason: `consent is ${c.status}; nothing to verify`, events: [] };
  if (!d.link_opened_at || !d.token_entered_at || !d.token_ok) return { lead, consent: c, verified: false, reason: !d.link_opened_at ? "verification link not opened from the email (7001(c)(1)(C)(ii))" : "PDF token not entered — the demonstration test is incomplete", events: [] };
  const at = Date.parse(d.token_entered_at) > Date.parse(d.link_opened_at) ? d.token_entered_at : d.link_opened_at;
  const underlying: Consent = { party_id: c.party_id, classes: c.scope, disclosure_version: c.version, status: "pending_verification", consented_on: civilDate(c.captured_at, lead.time_zone), soft_bounces_30d: 0 };
  verify(underlying, true, true, civilDate(at, lead.time_zone));
  if (underlying.status !== "active") return { lead, consent: c, verified: false, reason: "demonstration completed outside the 7-day window (SM_ESIGN_VERIFY_EXPIRY_7)", events: [] };
  const active: LeadConsent = { ...c, status: "active", verified_at: at, evidence: { ...c.evidence, link_opened_at: d.link_opened_at, token_entered_at: d.token_entered_at, ip: d.ip ?? c.evidence.ip ?? null, user_agent: d.user_agent ?? c.evidence.user_agent ?? null } };
  const next = touched({ ...lead, consents: lead.consents.map((x) => (x.consent_id === c.consent_id ? active : x)) }, at);
  const covers = active.scope.includes("origination_disclosures");
  const verified = emit(events, next, "consent.esign.verified", { party_id: c.party_id, consent_id: c.consent_id, verified_on: civilDate(at, lead.time_zone), link_opened_at: d.link_opened_at, token_entered_at: d.token_entered_at, token_ok: true, disclosure_version: c.version }, at);
  const activeEv = emit(events, next, "consent.esign.active", { party_id: c.party_id, consent_id: c.consent_id, verified_at: at, classes: [...active.scope], disclosure_version: c.version }, at);
  const granted = emit(events, next, "consent.granted", { kind: "esign", consent_id: c.consent_id, party_id: c.party_id, scope: [...active.scope], status: "active", version: c.version, covers_origination_disclosures: covers, timer: "SM_ESIGN_BEFORE_LE_GATE" }, at);
  return { lead: next, consent: active, verified: true, reason: null, events: [verified, activeEv, granted] };
}
/** SM_ESIGN_BEFORE_LE_GATE facts: `{applicants: string[], consents: [{party_id, kind, scope[], status}]}` — every applicant holds an active esign consent whose scope includes origination_disclosures before 21.2 chooses electronic delivery (a closed gate mails the LE; no breach). */
export function esignBeforeLeGate(f: Record<string, unknown>): { open: boolean; reason?: string } {
  const applicants = Array.isArray(f.applicants) ? (f.applicants as string[]) : []; const consents = Array.isArray(f.consents) ? (f.consents as { party_id?: string; kind?: string; scope?: string[]; status?: string }[]) : [];
  if (!applicants.length) return { open: false, reason: "no applicants named" };
  const missing = applicants.filter((a) => !consents.some((c) => c.party_id === a && c.kind === "esign" && c.status === "active" && (c.scope ?? []).includes("origination_disclosures")));
  return missing.length ? { open: false, reason: `no active consents(kind=esign, scope ∋ origination_disclosures) for ${missing.join(", ")} — 21.2 mails the LE (mailbox rule)` } : { open: true };
}
export const esignGateFacts = (lead: Lead, applicants?: readonly string[]): Record<string, unknown> => ({ applicants: applicants ?? [lead.party_id ?? lead.lead_id], consents: lead.consents.map((c) => ({ party_id: c.party_id, kind: c.kind, scope: [...c.scope], status: c.status })) });
/** 7.4's channel resolution over the lead's consents: electronic only with an active consent covering the class. */
export function leChannelFor(lead: Lead, party_id?: string): "electronic" | "mail" {
  const pid = party_id ?? lead.party_id ?? lead.lead_id; const c = lead.consents.find((x) => x.kind === "esign" && x.party_id === pid && x.status === "active");
  const underlying: Consent | undefined = c ? { party_id: pid, classes: c.scope, disclosure_version: c.version, status: "active", consented_on: civilDate(c.captured_at, lead.time_zone), soft_bounces_30d: 0 } : undefined;
  return channelFor([{ party_id: pid, ...(underlying ? { consent: underlying } : {}) }], "origination_disclosures")[0]!.channel;
}

// ============================================================ rule 5: the TRID six-item detector and the hand-off to 21.1
export interface TridItemInput { readonly item: TridItemKey; readonly source: TridSource; readonly at: string; readonly value: string | Cents; }
/** `trid_items[k] = {present, source, at}`; `derived_not_counted` (an AVM, a payoff-based amount the consumer has not accepted, on-file income) never counts. Six present → `trid_application_at = max(at)`. */
export function recordTridItem(events: EventStore, lead: Lead, t: TridItemInput): { lead: Lead; complete: boolean; missing: TridItemKey[]; trid_application_at: string | null; event: DomainEvent } {
  const at = isoInstant(t.at, "at"); if (!TRID_ITEMS.includes(t.item)) throw new RangeError(`item ${String(t.item)} is not one of ${TRID_ITEMS.join("/")}`);
  if (t.item === "income" && t.source === "on_file_confirmed") throw new RangeError("income is stated by the consumer for the new transaction — never taken from the origination file (rule 5)");
  if (t.item === "income" && !["applying", "prequalified", "terms_presented", "terms_review", "exploring", "prequal_requested", "authenticated"].includes(lead.status)) throw new RangeError("income is collected only when the consumer proceeds (rule 6)");
  const value = typeof t.value === "bigint" ? String(t.value) : nonEmpty(t.value, t.item);
  if (t.item === "property_address" && /^\s*(tbd|to be determined|n\/?a)\s*$/i.test(value)) throw new RangeError("property_address 'TBD' is not an identified property (rule 5)");
  const present = t.source !== "derived_not_counted";
  let next: Lead = { ...lead, trid_items: { ...lead.trid_items, [t.item]: { present, source: t.source, at, value } }, ...(t.item === "property_address" && present ? { property_address: value, property_state: /\b([A-Z]{2})\b\s*\d{5}(?:-\d{4})?\s*$/.exec(value)?.[1] ?? lead.property_state } : {}) };
  const missing = TRID_ITEMS.filter((k) => !next.trid_items[k].present);
  const complete = missing.length === 0;
  if (complete && !next.trid_application_at) { const max = TRID_ITEMS.map((k) => next.trid_items[k].at!).reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a)); next = { ...next, trid_application_at: max, regb_application_at: next.regb_application_at ?? max, status: next.status === "converted" ? next.status : "applying" }; }
  next = touched(next, at);
  return { lead: next, complete, missing, trid_application_at: next.trid_application_at, event: emit(events, next, "lead.trid_item.recorded", { item: t.item, source: t.source, present, at, complete, missing, trid_application_at: next.trid_application_at }, at) };
}
export const tridSnapshot = (lead: Lead): Record<TridItemKey, { present: boolean; source: TridSource | null; at: string | null }> => Object.fromEntries(TRID_ITEMS.map((k) => [k, { present: lead.trid_items[k].present, source: lead.trid_items[k].source, at: lead.trid_items[k].at }])) as Record<TridItemKey, { present: boolean; source: TridSource | null; at: string | null }>;
const SIX_ITEM_MAP: Readonly<Record<TridItemKey, SixItemKey>> = { name: "name", income: "income", ssn_for_credit: "ssn", property_address: "property_address", value_estimate: "property_value_estimate", loan_amount_sought: "loan_amount_sought" };
export interface ConversionInput { readonly at: string; readonly transaction_type: "purchase" | "limited_cash_out" | "cash_out"; readonly occupancy: string; readonly intake_channel?: "voice" | "chat" | "web" | "human_agent"; readonly creditor_time_zone?: string; readonly partner_nmlsr_id?: string | null; readonly borrower_name?: string; readonly ssn_for_credit?: string; readonly ai_intake_mode?: string | null; }
/**
 * The `applying → converted` hand-off: 21.1's intake record opens with `id = lead_id` (one id space), `application.received`
 * (Reg B) at `regb_application_at`, then every present six item is submitted with its own timestamp (consumer_stated →
 * captureSixItem; on_file_confirmed → offerPrefill + confirmPrefill) so 21.1's detector emits `application.trid_received`
 * once with `trid_received_at = max(at)`. The lead snapshot travels on `lead.qualified` for 21.1/21.3.
 */
export function convertToApplication(events: EventStore, lead: Lead, c: ConversionInput): { lead: Lead; application: IntakeApplication; application_date: PlainDate; trid_application_date: PlainDate | null; le_due_on: PlainDate | null; decision_due_on: PlainDate; events: DomainEvent[] } {
  const at = isoInstant(c.at, "at"); if (lead.application_id) throw new RangeError(`lead ${lead.lead_id} already converted to application ${lead.application_id}`);
  if (lead.status === "expired" || lead.status === "closed_lost") throw new RangeError(`lead ${lead.lead_id} is ${lead.status}`);
  const tz = c.creditor_time_zone ?? lead.time_zone; const regb_at = lead.regb_application_at ?? at;
  const borrowerId = lead.party_id ?? lead.lead_id; const name = c.borrower_name ?? lead.prospect?.name ?? lead.trid_items.name.value ?? "[consumer]";
  let app = newIntakeApplication({ id: lead.lead_id, partner_name: lead.partner_name, partner_nmlsr_id: c.partner_nmlsr_id ?? null, intake_channel: c.intake_channel ?? (lead.interactions.some((i) => i.channel.startsWith("voice")) ? "voice" : "chat"), started_at: lead.first_interaction_at ?? regb_at, creditor_time_zone: tz, property_state: lead.property_state, property_address: lead.property_address, transaction_type: c.transaction_type, occupancy: c.occupancy, ai_intake_mode: c.ai_intake_mode ?? null, borrowers: [{ id: borrowerId, legal_name: name }] });
  const out: DomainEvent[] = [];
  const received = receiveApplication(events, app, { at: regb_at, transaction_type: c.transaction_type, occupancy: c.occupancy, property_state: lead.property_state, property_address: lead.property_address }); app = received.app; if (received.event) out.push(received.event);
  const ordered = TRID_ITEMS.filter((k) => lead.trid_items[k].present).sort((a, b) => Date.parse(lead.trid_items[a].at!) - Date.parse(lead.trid_items[b].at!));
  for (const k of ordered) {
    const it = lead.trid_items[k]; const item = SIX_ITEM_MAP[k];
    const value: string | Cents = k === "ssn_for_credit" ? (c.ssn_for_credit ?? "000-00-0000") : k === "income" || k === "value_estimate" || k === "loan_amount_sought" ? cents(it.value!) : it.value!;
    if (it.source === "on_file_confirmed") { app = offerPrefill(app, item, value); const r = confirmPrefill(events, app, { item, at: it.at!, borrower_id: borrowerId }); app = r.app; out.push(r.event); if (r.trid.event) out.push(r.trid.event); }
    else { const r = captureSixItem(events, app, { item, value, at: it.at!, borrower_id: borrowerId }); app = r.app; out.push(r.event); if (r.trid.event) out.push(r.trid.event); }
  }
  let next: Lead = { ...lead, application_id: app.id, regb_application_at: regb_at, trid_application_at: app.trid_received_at ?? lead.trid_application_at, status: "converted", last_activity_at: at, prequalifications: lead.prequalifications.map((p) => (p.prequal_id === lead.prequal_id ? { ...p, outcome: "converted_to_application", retention_class: "regb_25m" } : p)) };
  if (lead.co_admt_preuse_notice_id && lead.co_admt_preuse_delivered_at) out.push(recordPreuseNoticeDelivered(events, { application_id: app.id, notice_id: lead.co_admt_preuse_notice_id, delivered_at: lead.co_admt_preuse_delivered_at, state: "CO", public_notice_url: "[public notice URL]" }, INTAKE_AGENT));
  out.push(emit(events, next, "lead.qualified", { application_id: app.id, application_date: app.application_date, trid_application_date: app.trid_application_date, assurance_level: next.assurance_level, consents: next.consents.map((x) => ({ consent_id: x.consent_id, kind: x.kind, scope: x.scope, status: x.status })), softpull_authorization_id: next.credit_authorization_id, channel: next.channel, trid_items: tridSnapshot(next), mlo_of_record_id: next.mlo_of_record_id, timer: "SM_LEAD_INACTIVITY_EXPIRY_90" }, at));
  next = { ...next, application_id: app.id };
  return { lead: next, application: app, application_date: app.application_date!, trid_application_date: app.trid_application_date, le_due_on: app.trid_application_date ? leDueDate(app.trid_application_date) : null, decision_due_on: decisionClock(app.application_date!, tz).decision_due_on, events: out };
}
/** Rule 3 / worked example 3: "just tell me if I'll be approved" → conversion offered and taken; the written decision follows within 30 days (21.6). */
export function requestDecision(events: EventStore, lead: Lead, c: ConversionInput): ReturnType<typeof convertToApplication> & { decision_process: "21.6" } {
  return { ...convertToApplication(events, lead, c), decision_process: "21.6" };
}
export const tridApplicationLocal = (lead: Lead): string | null => (lead.trid_application_at ? localIso(lead.trid_application_at, lead.time_zone) : null);

// ============================================================ rule 6 / 12: what may not be collected; expiry (rule 9)
/** §1002.13 / HMDA App. B: demographic monitoring information is requested only at application (21.1's askDemographics) — the tool does not exist at lead stage. */
export function requestDemographics(lead: Lead): never {
  throw new IntakeRefused("LEAD_STAGE_TOOL_UNAVAILABLE", `§1002.13 demographic information is requested only at application (21.1 askDemographics); lead ${lead.lead_id} is ${lead.status}`);
}
/** Rule 6: never before application — demographic, marital status beyond married/unmarried/separated, alimony/child support, citizenship, documents. */
export const PRE_APPLICATION_PROHIBITED: readonly { code: string; pattern: RegExp; citation: string }[] = [
  { code: "demographic_inquiry", pattern: /\b(race|ethnicity|national origin|religion|(?<!marital )sex\b|gender)\b/i, citation: "12 CFR 1002.5(b), 1002.13; HMDA App. B" },
  { code: "childbearing_inquiry", pattern: /\b(pregnan|plan(?:ning)? (?:to have|on) (?:children|kids)|birth control|family planning)/i, citation: "12 CFR 1002.5(d)(3)" },
  { code: "alimony_child_support", pattern: /\b(alimony|child support|separate maintenance)\b/i, citation: "12 CFR 1002.5(d)(2)" },
  { code: "citizenship_inquiry", pattern: /\b(citizen(?:ship)?|immigration status|green card)\b/i, citation: "B2-2-02 — collected at application (21.1)" },
  { code: "document_request", pattern: /\b(upload|send|provide|attach)\b.*\b(pay ?stubs?|w-?2s?|tax returns?|bank statements?)\b/i, citation: "12 CFR 1026.19(e)(2)(iii)" },
  { code: "promise", pattern: /\b(guaranteed|pre-?approved)\b/i, citation: "20.3 guardrails: no promises" },
];
export function preApplicationCheck(text: string): { allowed: boolean; findings: { code: string; citation: string; excerpt: string }[] } {
  const findings = PRE_APPLICATION_PROHIBITED.flatMap((p) => { const m = p.pattern.exec(text); return m ? [{ code: p.code, citation: p.citation, excerpt: m[0] }] : []; });
  return { allowed: findings.length === 0, findings };
}
/** SM_LEAD_INACTIVITY_EXPIRY_90 breach: `expired`; the soft-pull report is deleted (no application ever existed) and the authorization with its text hash is retained (FCRA audit); consents are retained (7.4). */
export function expireLead(events: EventStore, lead: Lead, e: { on: PlainDate }): { lead: Lead; purged: string[]; retained: string[]; event: DomainEvent } {
  if (lead.application_id) throw new RangeError(`lead ${lead.lead_id} converted to application ${lead.application_id}; the soft report is part of the Reg B file (regb_25m)`);
  if (e.on < lead.expires_on) throw new RangeError(`lead ${lead.lead_id} expires on ${lead.expires_on}; not expired on ${e.on}`);
  const purged = lead.soft_pull_report ? [`soft_pull_report:${lead.soft_pull_report.report_id}`] : [];
  const retained = [...lead.credit_authorizations.map((a) => `credit_authorization:${a.authorization_id}:${a.text_version_hash.slice(0, 12)}`), ...lead.consents.map((c) => `consent:${c.consent_id}`)];
  const next: Lead = { ...lead, status: "expired", closed_reason: "inactivity_90d", soft_pull_report: null, soft_pull_purged: lead.soft_pull_report ? { report_id: lead.soft_pull_report.report_id, deleted_on: e.on } : null, prequalifications: lead.prequalifications.map((p) => ({ ...p, outcome: p.outcome ?? "abandoned", soft_pull_report_id: null })) };
  return { lead: next, purged, retained, event: emit(events, next, "lead.expired", { expired_on: e.on, closed_reason: "inactivity_90d", purged, retained, authorization_hash_retained: lead.credit_authorizations.map((a) => a.text_version_hash), consents_retained: true }, toIso(zonedEpochMs(e.on, "00:00", lead.time_zone))) };
}
export function closeLead(events: EventStore, lead: Lead, c: { at: string; reason: string }): { lead: Lead; event: DomainEvent } {
  const at = isoInstant(c.at, "at"); const next: Lead = { ...lead, status: "closed_lost", closed_reason: nonEmpty(c.reason, "reason") };
  return { lead: next, event: emit(events, next, "lead.closed", { reason: c.reason }, at) };
}

// ============================================================ DELTA-11 (32.14): the anonymous minute on the L0 lead — rule-6 facts, the party link, the published range, the deferred intent
/** 32.14 §1.3 / 20.3 rule 6: the only chips a lead without a party answers — goal, contract status (Buy), occupancy (refi / cash-out), state, one estimate pair. Fixed order (S1). */
export const ENTRY_STEPS = ["goal", "contract", "occupancy", "state", "estimate"] as const;
export type EntryStep = (typeof ENTRY_STEPS)[number];
export type EntryTransactionType = "purchase" | "limited_cash_out" | "cash_out";
export type EntryOccupancy = "primary" | "second_home" | "investment";
export type ContractStatus = "signed" | "looking";
export const ENTRY_TRANSACTION_TYPES: readonly EntryTransactionType[] = ["purchase", "limited_cash_out", "cash_out"];
export const ENTRY_OCCUPANCIES: readonly EntryOccupancy[] = ["primary", "second_home", "investment"];
/** 32.14 §1.6: the three goal tiles map one-to-one onto 21.1's `transaction_type` ("Get preapproved" is Buy → Still looking). */
export const GOAL_TRANSACTION_TYPES: Readonly<Record<"buy" | "lower_rate" | "cash_out", EntryTransactionType>> = { buy: "purchase", lower_rate: "limited_cash_out", cash_out: "cash_out" };
/** Never on a lead without a party (rule 6; 20.3 T12; 32.14 T6): name, contact, SSN, income, demographics, marital status, citizenship, documents, military service, DOB, address, assets, the loan amount sought. */
export const L0_PROHIBITED_FACTS: readonly string[] = ["name", "legal_name", "first_name", "last_name", "email", "e_mail", "phone", "mobile", "contact", "ssn", "tin", "itin", "income", "employment", "employer", "assets", "demographics", "demographic", "race", "ethnicity", "sex", "gender", "religion", "national_origin", "marital_status", "married", "divorced", "widowed", "alimony", "child_support", "citizenship", "immigration_status", "documents", "document", "paystub", "w2", "tax_return", "bank_statement", "military", "military_service", "veteran", "dob", "date_of_birth", "address", "current_address", "loan_amount", "loan_amount_sought", "children", "pregnancy"];
export const isL0PermittedFact = (kind: string): kind is EntryStep => (ENTRY_STEPS as readonly string[]).includes(kind);
/** The rule-6 guard: a permitted kind returns; anything else is `L0_FACTS_ONLY` (the tool maps it to the 409 the API answers) and nothing is written. */
export function assertL0Fact(kind: string): EntryStep {
  if (isL0PermittedFact(kind)) return kind;
  throw new IntakeRefused("L0_FACTS_ONLY", `"${kind || "(none)"}" is never a lead fact before a session (20.3 rule 6; 32.14 §1.3): only ${ENTRY_STEPS.join("/")} may be written on a lead without a party — nothing was written`);
}
const normFact = (s: string): string => s.trim().toLowerCase().replace(/[\s-]+/g, "_");
/** The prohibited-fact names an input carries — its `step` / `kind` / `fact.kind` outside the permitted set, or a prohibited key inside `fact` / `value` — the L0_FACTS_ONLY guardrail's predicate (an empty input carries none). */
export function l0ProhibitedKeys(input: Record<string, unknown>): string[] {
  const found = new Set<string>();
  const fact = (input["fact"] && typeof input["fact"] === "object" && !Array.isArray(input["fact"]) ? input["fact"] : {}) as Record<string, unknown>;
  const value = (input["value"] && typeof input["value"] === "object" && !Array.isArray(input["value"]) ? input["value"] : {}) as Record<string, unknown>;
  for (const k of [input["step"], input["kind"], fact["kind"]]) if (typeof k === "string" && k !== "" && !isL0PermittedFact(normFact(k))) found.add(normFact(k));
  for (const k of [...Object.keys(fact), ...Object.keys(value)]) if (L0_PROHIBITED_FACTS.includes(normFact(k))) found.add(normFact(k));
  return [...found];
}
export type EntryFact =
  | { readonly kind: "goal"; readonly transaction_intent: EntryTransactionType }
  | { readonly kind: "contract"; readonly contract_status: ContractStatus }
  | { readonly kind: "occupancy"; readonly occupancy: EntryOccupancy }
  | { readonly kind: "state"; readonly consumer_state: string }
  | { readonly kind: "estimate"; readonly value_estimate_cents?: Cents | string | null; readonly stated_existing_balance_cents?: Cents | string | null; readonly price_range_cents?: Cents | string | null; readonly down_payment_cents?: Cents | string | null };
/** The 21.1 `transaction_type` the goal tile wrote; null while the lead is `undecided` / a 20.1 `refinance` intent (the goal card is still due). */
export const transactionTypeOf = (lead: Pick<Lead, "transaction_intent">): EntryTransactionType | null => ((ENTRY_TRANSACTION_TYPES as readonly string[]).includes(lead.transaction_intent) ? (lead.transaction_intent as EntryTransactionType) : null);
const nullableCents = (v: unknown): Cents | null => (v === undefined || v === null || v === "" ? null : cents(v as string | Cents | number));
const centsOrNull = (v: Cents | null | undefined): string | null => (v === undefined || v === null ? null : String(v));
/** The fixed S1 order: goal → (purchase: contract · refi / cash-out: occupancy) → state → one estimate pair; null once every chip is answered (the range and the identity ask follow). */
export function nextEntryStep(lead: Lead): EntryStep | null {
  const tt = transactionTypeOf(lead); if (!tt) return "goal";
  if (tt === "purchase" && !lead.contract_status) return "contract";
  if (tt !== "purchase" && !lead.occupancy) return "occupancy";
  if (!lead.consumer_state) return "state";
  if ((tt === "purchase" ? nullableCents(lead.price_range_cents) : nullableCents(lead.value_estimate_cents)) === null) return "estimate";
  return null;
}
/** The lead's rule-6 facts as the wire carries them (cents as decimal strings; never a name, a contact or a figure that is not the consumer's own estimate). */
export function entryFacts(lead: Lead): { transaction_type: EntryTransactionType | null; contract_status: ContractStatus | null; occupancy: EntryOccupancy | null; consumer_state: string | null; value_estimate_cents: string | null; stated_existing_balance_cents: string | null; price_range_cents: string | null; down_payment_cents: string | null; next_step: EntryStep | null } {
  return { transaction_type: transactionTypeOf(lead), contract_status: lead.contract_status ?? null, occupancy: lead.occupancy ?? null, consumer_state: lead.consumer_state, value_estimate_cents: centsOrNull(nullableCents(lead.value_estimate_cents)), stated_existing_balance_cents: centsOrNull(nullableCents(lead.stated_existing_balance_cents)), price_range_cents: centsOrNull(nullableCents(lead.price_range_cents)), down_payment_cents: centsOrNull(nullableCents(lead.down_payment_cents)), next_step: nextEntryStep(lead) };
}
const leadIsClosed = (lead: Lead): void => { if (lead.status === "expired" || lead.status === "closed_lost") throw new IntakeRefused("LEAD_CLOSED", `lead ${lead.lead_id} is ${lead.status}${lead.closed_reason ? ` (${lead.closed_reason})` : ""}; nothing further is written on it`); };
/**
 * DELTA-11: one rule-6 fact → one event on the lead. `lead.goal.set{transaction_intent, contract_status, occupancy, step}` is written by
 * the goal tile and re-emitted, carrying the addition, by the contract chip (Buy) or the occupancy chip (refi / cash-out) — 32.14 S1
 * says "Buy adds contract_status; refi/cash-out adds occupancy" and names no separate event, so occupancy is folded into goal.set (a
 * funnel counts distinct lead ids per stage, never events). A goal change clears its refinements and estimates. `lead.state.set
 * {consumer_state, property_state}` (the chip asks where the home is; the disclosure variant and 31.1 readiness read it).
 * `lead.estimate.set` carries the pair the goal implies — value + own-stated existing balance (never the loan-amount item) or price
 * range + down payment; cash-out shows `PROGRAM_MAX_LTV_PCT.cash_out` as a plain limit. Anything outside the permitted set is
 * `L0_FACTS_ONLY` and nothing is written; no fact before the disclosure (rule 1); none on a closed, expired or converted lead.
 */
export function setFact(events: EventStore, lead: Lead, fact: EntryFact, at: string): { lead: Lead; step: EntryStep; next_step: EntryStep | null; event: DomainEvent } {
  const when = isoInstant(at, "at"); const kind = assertL0Fact(String((fact as { kind?: unknown }).kind ?? ""));
  leadIsClosed(lead); if (lead.status === "converted") throw new IntakeRefused("LEAD_CLOSED", `lead ${lead.lead_id} is converted to application ${lead.application_id}; its facts are 21.1's now`);
  const last = lead.interactions.at(-1); if (last && last.ai && !last.disclosure_delivered_at) throw new IntakeRefused("SM_AI_INTERACTION_DISCLOSURE_GATE", "no lead fact before NTC_SM_AI_INTERACTION_DISCLOSURE is delivered and logged (rule 1; 32.14 T1)");
  const tt = transactionTypeOf(lead); let next: Lead; let type: string; let payload: Record<string, unknown>;
  switch (kind) {
    case "goal": { const f = fact as Extract<EntryFact, { kind: "goal" }>; if (!(ENTRY_TRANSACTION_TYPES as readonly string[]).includes(f.transaction_intent)) throw new RangeError(`transaction_intent ${JSON.stringify(f.transaction_intent)} is not one of ${ENTRY_TRANSACTION_TYPES.join("/")} (buy / lower_rate / cash_out)`);
      next = { ...lead, transaction_intent: f.transaction_intent, contract_status: null, occupancy: null, value_estimate_cents: null, stated_existing_balance_cents: null, price_range_cents: null, down_payment_cents: null };
      type = "lead.goal.set"; payload = { transaction_intent: f.transaction_intent, transaction_type: f.transaction_intent, contract_status: null, occupancy: null, step: "goal" }; break; }
    case "contract": { const f = fact as Extract<EntryFact, { kind: "contract" }>; if (tt !== "purchase") throw new RangeError("contract_status is a purchase lead's fact (Buy → signed | looking); answer the goal first");
      if (f.contract_status !== "signed" && f.contract_status !== "looking") throw new RangeError(`contract_status ${JSON.stringify(f.contract_status)} is not signed | looking`);
      next = { ...lead, contract_status: f.contract_status }; type = "lead.goal.set"; payload = { transaction_intent: lead.transaction_intent, transaction_type: tt, contract_status: f.contract_status, occupancy: lead.occupancy ?? null, step: "contract" }; break; }
    case "occupancy": { const f = fact as Extract<EntryFact, { kind: "occupancy" }>; if (!tt) throw new RangeError("occupancy follows the goal (refi / cash-out → primary | second_home | investment); answer the goal first");
      if (!(ENTRY_OCCUPANCIES as readonly string[]).includes(f.occupancy)) throw new RangeError(`occupancy ${JSON.stringify(f.occupancy)} is not one of ${ENTRY_OCCUPANCIES.join("/")}`);
      next = { ...lead, occupancy: f.occupancy }; type = "lead.goal.set"; payload = { transaction_intent: lead.transaction_intent, transaction_type: tt, contract_status: lead.contract_status ?? null, occupancy: f.occupancy, step: "occupancy" }; break; }
    case "state": { const f = fact as Extract<EntryFact, { kind: "state" }>; const st = String(f.consumer_state ?? "").trim().toUpperCase(); if (!/^[A-Z]{2}$/.test(st)) throw new RangeError(`consumer_state ${JSON.stringify(f.consumer_state)} is not a two-letter USPS state code`);
      next = { ...lead, consumer_state: st, property_state: st }; type = "lead.state.set"; payload = { consumer_state: st, property_state: st, state_variant: AI_DISCLOSURE_STATE_VARIANTS[st] ?? null }; break; }
    case "estimate": { const f = fact as Extract<EntryFact, { kind: "estimate" }>; if (!tt) throw new RangeError("the estimate pair follows the goal; answer the goal first");
      const value = nullableCents(f.value_estimate_cents), balance = nullableCents(f.stated_existing_balance_cents), price = nullableCents(f.price_range_cents), down = nullableCents(f.down_payment_cents);
      if (tt === "purchase") { if (price === null || down === null) throw new RangeError("a purchase estimate is {price_range_cents, down_payment_cents}"); if (price <= 0n || down < 0n || down > price) throw new RangeError("price_range_cents must be positive and down_payment_cents between 0 and the price");
        next = { ...lead, price_range_cents: price, down_payment_cents: down, value_estimate_cents: null, stated_existing_balance_cents: null }; }
      else { if (value === null || balance === null) throw new RangeError("a refinance / cash-out estimate is {value_estimate_cents, stated_existing_balance_cents}"); if (value <= 0n || balance < 0n) throw new RangeError("value_estimate_cents must be positive and stated_existing_balance_cents non-negative");
        next = { ...lead, value_estimate_cents: value, stated_existing_balance_cents: balance, price_range_cents: null, down_payment_cents: null }; }
      type = "lead.estimate.set"; payload = { transaction_type: tt, value_estimate_cents: centsOrNull(next.value_estimate_cents), stated_existing_balance_cents: centsOrNull(next.stated_existing_balance_cents), price_range_cents: centsOrNull(next.price_range_cents), down_payment_cents: centsOrNull(next.down_payment_cents), max_ltv_pct: PROGRAM_MAX_LTV_PCT[tt], counted_as_trid_item: false, source: "consumer_stated" }; break; }
  }
  next = touched(next, when);
  return { lead: next, step: kind, next_step: nextEntryStep(next), event: emit(events, next, type, payload, when) };
}
/** DELTA-11: the L1 link at verify — `lead.linked{party_id}`; the lead is linked, never copied (32.14 §4). A lead already linked to another party is never re-pointed. */
export function linkParty(events: EventStore, lead: Lead, l: { party_id: string; at: string; method?: string | null; session_id?: string | null }): { lead: Lead; event: DomainEvent } {
  const at = isoInstant(l.at, "at"); const party_id = nonEmpty(l.party_id, "party_id"); leadIsClosed(lead);
  if (lead.party_id && lead.party_id !== party_id) throw new RangeError(`lead ${lead.lead_id} is linked to party ${lead.party_id}, not ${party_id}`);
  const next = touched({ ...lead, party_id }, at);
  return { lead: next, event: emit(events, next, "lead.linked", { party_id, method: l.method ?? null, session_id: l.session_id ?? null, already_linked: lead.party_id === party_id }, at) };
}
/** DELTA-13: "Not yet" — `intent.deferred{lead_id, status}`: nothing is ordered, pulled or converted; the lead keeps its status (SM_QUOTE_VALIDITY_GATE governs a re-quote; SM_LEAD_INACTIVITY_EXPIRY_90 is the only clock). */
export function deferIntent(events: EventStore, lead: Lead, d: { at: string; reason?: string | null }): { lead: Lead; event: DomainEvent } {
  const at = isoInstant(d.at, "at"); leadIsClosed(lead);
  if (lead.status === "converted") throw new RangeError(`lead ${lead.lead_id} is converted to application ${lead.application_id}; intent is 21.4's (intent.record)`);
  const next = touched(lead, at);
  return { lead: next, event: emit(events, next, "intent.deferred", { status: next.status, reason: d.reason ?? "not_yet", quote_id: next.quote_ids.at(-1) ?? null, ordered: false, pulled: false, document: null, clocks: ["SM_LEAD_INACTIVITY_EXPIRY_90"] }, at) };
}

// ---- the published range as an advertisement (32.14 S2; 20.3 rule 7; 20.2 rule 4 / §1026.24)
/** The representative loan the APR beside each published rate is computed on when the sheet's price rows carry no APR (a no-point loan; third-party costs are paid under the partner's program, so prepaid interest is the only prepaid charge). */
export const RANGE_REPRESENTATIVE_LOAN_CENTS: Cents = 30_000_000n;
/** The representative schedule for a disbursement: the odd days to month-end are prepaid interest (30.2's `interest_paid_through_date`), the amortizing term starts the day after it (Appendix J (b)(3)(i): the date the finance charge begins to be earned on the schedule) and the first payment falls one regular period later. */
export const representativeSchedule = (disbursement: PlainDate): { term_start_date: PlainDate; first_payment_date: PlainDate } => { const term_start_date = startOfMonth(addMonths(disbursement, 1)); return { term_start_date, first_payment_date: addMonths(term_start_date, 1) }; };
/** 20.4's own APR (25.1 Appendix J through computeApr, as computePayment does) on the representative loan: note rate, term, disbursement today, the odd-days interest as the only prepaid finance charge, no points. */
export function representativeApr(note_rate_pct: string, term_months: number, disbursement: PlainDate, loan_cents: Cents = RANGE_REPRESENTATIVE_LOAN_CENTS): string {
  const prepaid = prepaidInterest(loan_cents, note_rate_pct, disbursement); const s = representativeSchedule(disbursement);
  return computeApr({ loan_amount_cents: loan_cents, note_rate_pct, term_months, term_start_date: s.term_start_date, first_payment_date: s.first_payment_date, prepaid_finance_charges_cents: 0n, prepaid_interest_cents: prepaid.prepaid_interest_cents }).apr_disclosed_str;
}
export interface RangeSheetPriceLike { readonly note_rate?: string; readonly note_rate_pct?: string; readonly product_code?: string; readonly term_months?: number; readonly amortization?: string; readonly apr_pct?: string | null; }
export interface RangeAdvertisementInput { readonly product_code?: string; readonly partner_name: string; readonly partner_nmlsr_id?: string | null; readonly at: string; readonly time_zone?: string; readonly representative_loan_cents?: Cents; }
export interface RangeAdvertisement {
  readonly product_code: string; readonly product_label: string; readonly amortization: "fixed" | "arm"; readonly term_months: number;
  readonly low_pct: string; readonly high_pct: string; readonly apr_low_pct: string; readonly apr_high_pct: string; readonly apr_source: "sheet" | "computed_representative_loan"; readonly representative_loan_cents: Cents;
  readonly text: string; readonly sheet_rates_pct: readonly string[]; readonly checklist: Checklists; readonly failures: readonly string[]; readonly passes: boolean; readonly personal_terms: false;
}
const productLabel = (term_months: number, amortization: "fixed" | "arm"): string => `${Math.round(term_months / 12)}-year ${amortization === "fixed" ? "fixed" : "adjustable-rate"}`;
/**
 * 32.14 S2 / 20.3 rule 7 (RANGE_IS_PUBLISHED): the sheet's low–high for the product — never an LLPA-adjusted figure, a tier or a borrower
 * figure — written as an advertisement: the APR beside each rate (the sheet row's `apr_pct` when the rows carry one, else 20.4's APR on the
 * representative loan, and the footer says so), "not a commitment to lend; rates change daily", the partner's name and NMLSR ID, then
 * 20.2 `runContentChecklist` like any creative (`regz_1026_24.apr_stated`, (d)(2) — "30-year" is a triggering term — `not_a_commitment`,
 * the NMLS ID, no investor reference). `passes=false` refuses the card (RANGE_CONTENT_CHECK); a missing NMLSR ID is the ordinary failure.
 */
export function rangeAdvertisement(sheet: { readonly prices: readonly RangeSheetPriceLike[] }, i: RangeAdvertisementInput): RangeAdvertisement {
  const product_code = i.product_code || "FRM30"; const at = isoInstant(i.at, "at"); const on = civilDate(at, i.time_zone ?? "America/New_York");
  const pct = (p: RangeSheetPriceLike): string => p.note_rate_pct ?? (p.note_rate !== undefined ? (Math.round(Number(p.note_rate) * 100_000) / 1000).toFixed(3) : "");
  const rows = sheet.prices.filter((p) => !p.product_code || p.product_code === product_code).map((row) => ({ pct: pct(row), row })).filter((r) => r.pct !== "").sort((a, b) => Number(a.pct) - Number(b.pct));
  if (!rows.length) throw new RangeError(`no ${product_code} prices on the sheet`);
  const low = rows[0]!, high = rows[rows.length - 1]!;
  const term_months = low.row.term_months ?? (product_code === "FRM15" ? 180 : 360); const amortization: "fixed" | "arm" = (low.row.amortization ?? "fixed") === "fixed" ? "fixed" : "arm";
  const loan = i.representative_loan_cents ?? RANGE_REPRESENTATIVE_LOAN_CENTS;
  const apr_source: RangeAdvertisement["apr_source"] = low.row.apr_pct && high.row.apr_pct ? "sheet" : "computed_representative_loan";
  const aprOf = (r: { pct: string; row: RangeSheetPriceLike }): string => (apr_source === "sheet" ? String(r.row.apr_pct) : representativeApr(r.pct, term_months, on, loan));
  const apr_low_pct = aprOf(low), apr_high_pct = aprOf(high); const product_label = productLabel(term_months, amortization);
  const nmlsr = (i.partner_nmlsr_id ?? "").trim();
  const text = `Today's ${product_label} rates for this program range from ${low.pct}% (${apr_low_pct}% APR) to ${high.pct}% (${apr_high_pct}% APR) depending on credit and loan-to-value. This is not a commitment to lend; rates change daily. ${apr_source === "sheet" ? "APR as published on the rate sheet in force." : "APR is computed on a representative loan with no points; third-party costs are paid under the partner's program."} ${i.partner_name}${nmlsr ? `, NMLSR ID ${nmlsr}` : ""}.`;
  const sheet_rates_pct = rows.map((r) => r.pct);
  const checklist = runContentChecklist({ text, channel: "portal", campaign_kind: "general_advertising", amortization, sheet_rates_pct, sheet_validity_stated: true });
  const failures = checklistFailures(checklist);
  return { product_code, product_label, amortization, term_months, low_pct: low.pct, high_pct: high.pct, apr_low_pct, apr_high_pct, apr_source, representative_loan_cents: loan, text, sheet_rates_pct, checklist, failures, passes: failures.length === 0, personal_terms: false };
}
export interface RangeShownInput { readonly at: string; readonly product_code: string; readonly rate_sheet_id: string; readonly low_pct: string; readonly high_pct: string; readonly apr_low_pct: string; readonly apr_high_pct: string; readonly apr_source: string; readonly checklist_run_id: string; }
/** DELTA-11: `lead.range.shown{…, checklist_run_id}` — logged as it happens (a bounced visitor leaves a record); refused on a lead a closed state ended (STATE_GATE_FIRST) and, for Colorado on/after 2027-01-01, before the pre-use notice (21.6's gate). */
export function showRange(events: EventStore, lead: Lead, r: RangeShownInput): { lead: Lead; event: DomainEvent } {
  const at = isoInstant(r.at, "at");
  if (lead.status === "closed_lost" && lead.closed_reason === "state_not_licensed") throw new IntakeRefused("STATE_GATE_FIRST", `${lead.consumer_state ?? "the state"} readiness is closed: no range and no identity ask (31.1 SM_LICENSE_STATE_GATE)`);
  leadIsClosed(lead); nonEmpty(r.checklist_run_id, "checklist_run_id"); nonEmpty(r.rate_sheet_id, "rate_sheet_id");
  assertPricingOutputAllowed(lead, at);
  const next = touched(lead, at);
  return { lead: next, event: emit(events, next, "lead.range.shown", { low_pct: r.low_pct, high_pct: r.high_pct, apr_low_pct: r.apr_low_pct, apr_high_pct: r.apr_high_pct, product_code: r.product_code, rate_sheet_id: r.rate_sheet_id, checklist_run_id: r.checklist_run_id, apr_source: r.apr_source, personal_terms: false, tier: null, llpa_applied: false }, at) };
}

// ============================================================ getBenefit (20.1 payload for L2 borrowers) and the decision record
export interface BenefitInput { readonly existing_upb_or_amount_cents: Cents; readonly existing_rate_pct: string; readonly existing_term_months: number; readonly remaining_term_months: number; readonly candidate_amount_cents: Cents; readonly candidate_rate_pct: string; readonly candidate_term_months: number; readonly borrower_paid_costs_cents?: Cents; }
export interface BenefitSummary { readonly current_pi_cents: Cents; readonly new_pi_cents: Cents; readonly pi_delta_cents: Cents; readonly same_term_pi_cents: Cents; readonly same_term_delta_cents: Cents; readonly term_reset_months: number; readonly borrower_paid_costs_cents: Cents; readonly rate_delta_bps: number; readonly text: string; }
/** Worked example 1 / 20.1 rule 4: 7.000% → 6.125%; $3,758.96 → $3,402.62; $0 borrower-paid costs; the term reset disclosed with the same-remaining-term (336-month) alternative $3,488.97. */
export function benefitSummary(i: BenefitInput): BenefitSummary {
  const current_pi_cents = levelPayment(i.existing_upb_or_amount_cents, ratePercent(i.existing_rate_pct), i.existing_term_months);
  const new_pi_cents = levelPayment(i.candidate_amount_cents, ratePercent(i.candidate_rate_pct), i.candidate_term_months);
  const same_term_pi_cents = levelPayment(i.candidate_amount_cents, ratePercent(i.candidate_rate_pct), i.remaining_term_months);
  const costs = i.borrower_paid_costs_cents ?? 0n; const term_reset_months = i.candidate_term_months - i.remaining_term_months;
  const rate_delta_bps = Math.round((Number(i.existing_rate_pct) - Number(i.candidate_rate_pct)) * 1000) / 10;
  return { current_pi_cents, new_pi_cents, pi_delta_cents: current_pi_cents - new_pi_cents, same_term_pi_cents, same_term_delta_cents: current_pi_cents - same_term_pi_cents, term_reset_months, borrower_paid_costs_cents: costs, rate_delta_bps,
    text: `Your current rate is ${i.existing_rate_pct}% with a principal-and-interest payment of ${money(current_pi_cents)}. The candidate refinance is ${i.candidate_rate_pct}% with a payment of ${money(new_pi_cents)} over ${i.candidate_term_months} months; ${money(costs)} of third-party costs are paid by you. That resets your remaining ${i.remaining_term_months}-month term by ${term_reset_months} months; keeping the ${i.remaining_term_months}-month term instead would be ${money(same_term_pi_cents)} per month. This is not a commitment to lend.` };
}
/** `getBenefit` — the 20.1 payload for a subserviced borrower is on-file data: L2 first (SM_LEAD_AUTH_BEFORE_DISCLOSURE_GATE). */
export function getBenefit(lead: Lead, opportunity: BenefitInput): BenefitSummary {
  const g = authBeforeDisclosureGate({ assurance_level: lead.assurance_level, data_class: "on_file" }); if (!g.open) throw new IntakeRefused("SM_LEAD_AUTH_BEFORE_DISCLOSURE_GATE", g.reason!);
  if (!lead.loan_id) throw new RangeError("the 20.1 benefit is a subserviced borrower's (loan_id) on-file computation");
  return benefitSummary(opportunity);
}
/** The decision record per interaction (AI agent design). */
export function leadDecisionRecord(lead: Lead, interaction_id: string, rationale: string): Record<string, unknown> {
  const i = interactionOf(lead, interaction_id);
  return { lead_id: lead.lead_id, interaction_id, disclosure_version: i.disclosure_version, assurance_level: lead.assurance_level, consents_captured: lead.consents.map((c) => ({ consent_id: c.consent_id, kind: c.kind, status: c.status })), softpull_authorization_id: lead.credit_authorization_id,
    utterance_classifier_results: lead.classifier_log.filter((c) => c.interaction_id === interaction_id), trid_items_snapshot: tridSnapshot(lead), conversion_decision: lead.status === "converted" ? "converted" : lead.status === "applying" ? "applying" : "not_converted", rationale, rule_set_version: RULE_SET_VERSION_20_3 };
}
