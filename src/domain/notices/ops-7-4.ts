/**
 * §7.4 process ops — the consent service: the code paths that turn portal, call, webhook and release events into the
 * `loan_events` the 7.4 timers arm on and close with (spec "Outputs and artifacts": `consent.esign.disclosed/pending/
 * verified/active/suspect/withdrawn/reconsented`, `consent.tcpa.granted/revoked`, `consent.ai_disclosure.acknowledged`).
 * Every state transition is taken strictly from evidence (the `disclosures` agent "owns state transitions strictly from
 * evidence events (no LLM judgment on whether consent 'happened')"); an LLM never reaches `active` — only
 * `completeVerification` / `completeReconsent` do, and only on link + PDF token. Over the calculators in ./esign.ts.
 *
 *   - `captureConsent`          disclosure shown + consent click → `consent.esign.disclosed`, `consent.esign.pending{clicked_at}`
 *                                (arms SM_ESIGN_VERIFY_EXPIRY_7, +7 calendar days from the click).
 *   - `completeVerification`    link opened from the email AND token from the PDF, inside the window → `consent.esign.verified`
 *                                (closes SM_ESIGN_VERIFY_EXPIRY_7) and `consent.esign.active{verified_at}` (arms SM_CONSENT_REVALIDATION_12M).
 *   - `expireVerification`      the breach action of SM_ESIGN_VERIFY_EXPIRY_7: status `expired`; re-invite.
 *   - `decideNoticeChannel`     per-notice channel decision → `notice.channel_decision{requested_channel}` (arms
 *                                ESIGN_7001C_CONSENT_GATE for electronic requests; the evaluator decides; closed → mail, logged).
 *   - `requestForm1098Furnish`  → `tax_form.1098.furnish_requested{channel}` (arms IRS_1098_ECONSENT_GATE; closed → paper 1098).
 *   - `announceHwSwChange`      officer-determined material change → `hw_sw_requirements.changed{material=true, effective_on}`
 *                                (arms ESIGN_7001C1D_RECONSENT_GATE), consents flagged, NTC_ESIGN_HWSW_CHANGE_RECONSENT queued.
 *   - `completeReconsent`       re-demonstration → `consent.esign.reconsented` (closes the gate) + a new `consent.esign.active` row.
 *   - `receiveWithdrawal` / `applyWithdrawal`   → `consent.esign.withdrawal_received{receipt}` / `consent.esign.withdrawn{confirmation_sent=true}`.
 *   - `receiveTcpaRevocation` / `applyTcpaRevocation`   the SMS STOP / free-text ingestion → `consent.tcpa.revocation_received{receipt}`
 *                                / `consent.tcpa.revoked{applied_to_all_lists}`.
 *   - `recordPortalView` / `revalidationCheck`   `edelivery_events.viewed_at` → `consent.esign.revalidated` (informational clock).
 *   - `voiceEnrollment`         an AI voice/chat "yes, email me my statements" → no consent; invitation; `consent.ai_disclosure.acknowledged`.
 */
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import { type PlainDate, addMonths, daysBetween } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import { newConsent, verify, withdraw, materialChange, reconsent, channelFor, irs1098Channel, verificationExpires, type Consent } from "./esign.ts";
import { tcpaStop, voiceEnrollmentRequest } from "./ops.ts";
import { EVALUATORS_7_4, type ChannelRecipientFact } from "./evaluators-7-4.ts";

export interface Deps { readonly events: EventStore; readonly actor?: Actor; }
/** The `disclosures` agent "owns state transitions strictly from evidence events". */
export const DISCLOSURES_AGENT: Actor = { kind: "agent", id: "disclosures" };
const actorOf = (d: Deps): Actor => d.actor ?? DISCLOSURES_AGENT;

export const ESIGN_CLASSES = ["periodic_statements", "escrow_statements", "regx_correspondence", "arm_notices", "privacy_notices", "lossmit_notices", "early_intervention_notices", "insurance_notices", "pmi_notices", "payoff_statements", "general_correspondence"] as const;
export const VERIFICATION_WINDOW_DAYS = 7;
/** The outbound lists a TCPA revocation must reach (rule 12: "applied to all outbound dialer/SMS lists"). */
export const TCPA_OUTBOUND_LISTS = ["dialer", "sms"] as const;

const isIso = (s: string): boolean => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(s);
const isPlainDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s);
/** Civil date (Eastern) of an instant — the platform's anchor convention (kernel defaultAnchorResolver). */
export const etDate = (iso: string): PlainDate => wallClock(Date.parse(iso), "America/New_York").date;
const need = (cond: boolean, msg: string): void => { if (!cond) throw new RangeError(msg); };

// ============================================================ enrollment: disclosure → click → demonstration → active
export interface CaptureConsentInput { readonly loan_id: string; readonly party_id: string; readonly consent_id: string; readonly classes: readonly string[]; readonly disclosure_version: string; readonly disclosure_hash: string; readonly clicked_at: string; readonly captured_via: "portal" | "ai_chat_link" | "paper_form"; readonly ip: string; readonly user_agent: string; }
/**
 * Rule 1–2: the (c)(1)(B)/(C) statement was displayed (version + hash logged) and the borrower clicked consent for the
 * listed classes → `pending_verification`; the verification email (link + token PDF) is queued. The click is the anchor
 * of SM_ESIGN_VERIFY_EXPIRY_7 (`clicked_at`). Portal-only checkbox consent "is `pending_verification` and never used
 * for delivery".
 */
export function captureConsent(deps: Deps, f: CaptureConsentInput): { consent: Consent; expires_on: PlainDate; verification_email: "NTC_ESIGN_VERIFICATION_EMAIL"; timer: "SM_ESIGN_VERIFY_EXPIRY_7"; events: DomainEvent[] } {
  need(f.party_id.length > 0 && f.loan_id.length > 0 && f.consent_id.length > 0, "captureConsent: loan_id, party_id and consent_id are required");
  need(f.classes.length > 0, "captureConsent: at least one E-SIGN class must be consented to (rule 1)");
  const unknown = f.classes.filter((c) => !(ESIGN_CLASSES as readonly string[]).includes(c));
  need(unknown.length === 0, `captureConsent: not an E-SIGN class: ${unknown.join(", ")} (tax_statements is an irs_estatement consent — rule 11)`);
  need(f.disclosure_version.length > 0 && f.disclosure_hash.length > 0, "captureConsent: the pre-consent disclosure version and text hash must be logged (7001(c)(1)(B)/(C), (d))");
  need(isIso(f.clicked_at), "captureConsent: clicked_at must be an ISO instant");
  const created = newConsent(f.party_id, f.classes, f.disclosure_version, etDate(f.clicked_at), "portal");
  if ("error" in created) throw new RangeError(created.error);
  const expires_on = verificationExpires(created);
  const actor = actorOf(deps);
  const disclosed = deps.events.append({ type: "consent.esign.disclosed", loanId: f.loan_id, actor, payload: { party_id: f.party_id, consent_id: f.consent_id, disclosure_version: f.disclosure_version, disclosure_hash: f.disclosure_hash, classes: [...f.classes], displayed_at: f.clicked_at, captured_via: f.captured_via } });
  const pending = deps.events.append({ type: "consent.esign.pending", loanId: f.loan_id, actor, causationId: disclosed.id, payload: { party_id: f.party_id, consent_id: f.consent_id, clicked_at: f.clicked_at, classes: [...f.classes], disclosure_version: f.disclosure_version, captured_via: f.captured_via, ip: f.ip, user_agent: f.user_agent, expires_on, verification_email: "NTC_ESIGN_VERIFICATION_EMAIL" } });
  return { consent: created, expires_on, verification_email: "NTC_ESIGN_VERIFICATION_EMAIL", timer: "SM_ESIGN_VERIFY_EXPIRY_7", events: [disclosed, pending] };
}

export interface VerificationInput { readonly loan_id: string; readonly consent_id: string; readonly consent: Consent; readonly link_opened_at: string | null; readonly token_entered_at: string | null; readonly token_ok: boolean; readonly ip: string; readonly user_agent: string; }
/**
 * Rule 2 / (c)(1)(C)(ii): "the borrower must open the link from the email and enter the token from the PDF within 7
 * days. Both events, IP/user-agent, and the disclosure version are stored." Only this service creates an `active`
 * consent (guardrail); anything short of both evidence items leaves the row `pending_verification` and appends nothing.
 */
export function completeVerification(deps: Deps, f: VerificationInput): { status: Consent["status"]; verified: boolean; reason: string | null; events: DomainEvent[] } {
  need(f.link_opened_at === null || isIso(f.link_opened_at), "completeVerification: link_opened_at must be an ISO instant");
  need(f.token_entered_at === null || isIso(f.token_entered_at), "completeVerification: token_entered_at must be an ISO instant");
  if (f.consent.status !== "pending_verification") return { status: f.consent.status, verified: false, reason: `consent is ${f.consent.status}; nothing to verify`, events: [] };
  const linkOpened = f.link_opened_at !== null, tokenOk = f.token_ok && f.token_entered_at !== null;
  if (!linkOpened || !tokenOk) return { status: f.consent.status, verified: false, reason: !linkOpened ? "verification link not opened from the email (7001(c)(1)(C)(ii))" : "PDF token not entered — the demonstration test is incomplete (rule 2)", events: [] };
  const on = etDate(f.token_entered_at! > f.link_opened_at! ? f.token_entered_at! : f.link_opened_at!);
  if (daysBetween(f.consent.consented_on, on) > VERIFICATION_WINDOW_DAYS) return { status: f.consent.status, verified: false, reason: `demonstration completed ${daysBetween(f.consent.consented_on, on)} days after the click — outside the ${VERIFICATION_WINDOW_DAYS}-day window (SM_ESIGN_VERIFY_EXPIRY_7)`, events: [] };
  verify(f.consent, true, true, on);
  const actor = actorOf(deps);
  const verified = deps.events.append({ type: "consent.esign.verified", loanId: f.loan_id, actor, payload: { party_id: f.consent.party_id, consent_id: f.consent_id, verified_on: on, link_opened_at: f.link_opened_at, token_entered_at: f.token_entered_at, token_ok: true, ip: f.ip, user_agent: f.user_agent, disclosure_version: f.consent.disclosure_version } });
  const active = deps.events.append({ type: "consent.esign.active", loanId: f.loan_id, actor, causationId: verified.id, payload: { party_id: f.consent.party_id, consent_id: f.consent_id, verified_at: f.token_entered_at, classes: [...f.consent.classes], disclosure_version: f.consent.disclosure_version } });
  return { status: f.consent.status, verified: true, reason: null, events: [verified, active] };
}

/** Breach action of SM_ESIGN_VERIFY_EXPIRY_7: "status `expired`; re-invite" — a new invitation, never a silent extension of the window. */
export function expireVerification(deps: Deps, f: { loan_id: string; consent_id: string; consent: Consent; on: PlainDate }): { status: Consent["status"]; expired: boolean; reinvite: "NTC_ESIGN_VERIFICATION_EMAIL" | null; event: DomainEvent | null } {
  if (f.consent.status !== "pending_verification") return { status: f.consent.status, expired: false, reinvite: null, event: null };
  need(daysBetween(f.consent.consented_on, f.on) > VERIFICATION_WINDOW_DAYS, `expireVerification: the ${VERIFICATION_WINDOW_DAYS}-day window runs through ${verificationExpires(f.consent)}; not expired on ${f.on}`);
  f.consent.status = "expired";
  const event = deps.events.append({ type: "consent.esign.expired", loanId: f.loan_id, actor: actorOf(deps), payload: { party_id: f.consent.party_id, consent_id: f.consent_id, expired_on: f.on, window_days: VERIFICATION_WINDOW_DAYS, reinvite: "NTC_ESIGN_VERIFICATION_EMAIL" } });
  return { status: "expired", expired: true, reinvite: "NTC_ESIGN_VERIFICATION_EMAIL", event };
}

// ============================================================ channel decisions (ESIGN_7001C_CONSENT_GATE, IRS_1098_ECONSENT_GATE)
export interface ChannelDecisionInput { readonly loan_id: string; readonly notice_id: string; readonly template: string; readonly notice_class: string; readonly recipients: readonly { party_id: string; consent?: Consent }[]; readonly state_mandated_mail?: boolean; readonly template_mail_only?: boolean; }
export interface PartyChannel { readonly party_id: string; readonly channel: "electronic" | "mail"; readonly consent_active: boolean; readonly covers_class: boolean; readonly satisfies_timer: boolean; }
/**
 * Rules 1, 4, 6–8 and the jurisdiction override: a notice requests electronic delivery unless the template or the state
 * mandates mail; ESIGN_7001C_CONSENT_GATE (evaluator `7.4.esignConsentActiveForEveryRecipient`) opens only when every
 * intended recipient holds an active consent covering the class. A closed gate is not a breach: the non-consenting
 * parties mail, the consenting parties go electronic, and "the mail delivery satisfies the regulatory timer" (rule 4).
 */
export function decideNoticeChannel(deps: Deps, f: ChannelDecisionInput): { requested_channel: "electronic" | "mail"; gate: "ESIGN_7001C_CONSENT_GATE"; gate_open: boolean; gate_reason: string | null; channels: PartyChannel[]; fallback: "mail" | null; event: DomainEvent } {
  need(f.recipients.length > 0, "decideNoticeChannel: a notice needs at least one intended recipient");
  need(f.notice_id.length > 0 && f.template.length > 0 && f.notice_class.length > 0, "decideNoticeChannel: notice_id, template and notice_class are required");
  const stateMail = f.state_mandated_mail === true;
  const requested: "electronic" | "mail" = stateMail || f.template_mail_only === true ? "mail" : "electronic";
  const facts: ChannelRecipientFact[] = f.recipients.map((r) => ({ party_id: r.party_id, consent_active: r.consent?.status === "active", covers_class: r.consent?.classes.includes(f.notice_class) === true }));
  const gate = requested === "electronic" ? EVALUATORS_7_4["7.4.esignConsentActiveForEveryRecipient"]!({ recipients: facts, state_mandated_mail: stateMail }) : { open: false, reason: `${stateMail ? "state-mandated mail" : "template is mail_only"}: electronic not requested` };
  const per = requested === "electronic" ? channelFor(f.recipients, f.notice_class, stateMail) : f.recipients.map((r) => ({ party_id: r.party_id, channel: "mail" as const }));
  const anyMail = per.some((p) => p.channel === "mail");
  const channels: PartyChannel[] = per.map((p, i) => ({ party_id: p.party_id, channel: p.channel, consent_active: facts[i]!.consent_active, covers_class: facts[i]!.covers_class, satisfies_timer: anyMail ? p.channel === "mail" : true }));
  const event = deps.events.append({ type: "notice.channel_decision", loanId: f.loan_id, actor: actorOf(deps), payload: { notice_id: f.notice_id, template: f.template, notice_class: f.notice_class, requested_channel: requested, gate: "ESIGN_7001C_CONSENT_GATE", gate_open: gate.open, gate_reason: gate.reason ?? null, channels, fallback: gate.open ? null : "mail", state_mandated_mail: stateMail } });
  return { requested_channel: requested, gate: "ESIGN_7001C_CONSENT_GATE", gate_open: gate.open, gate_reason: gate.reason ?? null, channels, fallback: gate.open ? null : "mail", event };
}

export interface Form1098FurnishInput { readonly loan_id: string; readonly tax_year: number; readonly party_id: string; readonly channel: "electronic" | "paper"; readonly consents: readonly Consent[]; }
/**
 * Rule 11 / T9: the 1098 is furnished electronically only under a separate, active `irs_estatement` consent (its own
 * IRS-specified disclosures); `periodic_statements` consent never qualifies. Closed gate → paper 1098 by Jan 31.
 */
export function requestForm1098Furnish(deps: Deps, f: Form1098FurnishInput): { channel_requested: "electronic" | "paper"; furnish_channel: "electronic" | "paper"; irs_estatement_consent_active: boolean; gate: "IRS_1098_ECONSENT_GATE"; gate_open: boolean; gate_reason: string | null; furnish_by: PlainDate; event: DomainEvent } {
  need(Number.isInteger(f.tax_year) && f.tax_year >= 2000, "requestForm1098Furnish: tax_year must be a calendar year");
  need(f.party_id.length > 0 && f.loan_id.length > 0, "requestForm1098Furnish: loan_id and party_id are required");
  const irsActive = f.consents.some((c) => c.party_id === f.party_id && c.status === "active" && c.classes.includes("irs_estatement"));
  const gate = f.channel === "electronic" ? EVALUATORS_7_4["7.4.irsEstatementConsentActive"]!({ irs_estatement_consent_active: irsActive }) : { open: false, reason: "paper furnish requested" };
  const furnish = f.channel === "electronic" ? irs1098Channel(gate.open) : "paper";
  const furnish_by = `${f.tax_year + 1}-01-31` as PlainDate;
  const event = deps.events.append({ type: "tax_form.1098.furnish_requested", loanId: f.loan_id, actor: actorOf(deps), payload: { tax_year: f.tax_year, party_id: f.party_id, channel: f.channel, irs_estatement_consent_active: irsActive, gate: "IRS_1098_ECONSENT_GATE", gate_open: gate.open, gate_reason: gate.reason ?? null, furnish_channel: furnish, furnish_by, template: "NTC_IRS_1098" } });
  return { channel_requested: f.channel, furnish_channel: furnish, irs_estatement_consent_active: irsActive, gate: "IRS_1098_ECONSENT_GATE", gate_open: gate.open, gate_reason: gate.reason ?? null, furnish_by, event };
}

// ============================================================ hardware/software change (ESIGN_7001C1D_RECONSENT_GATE)
export interface HwSwChangeInput { readonly loan_id: string; readonly consents: Consent[]; readonly effective_on: PlainDate; readonly change: string; readonly material: boolean; readonly determined_by: "officer"; readonly hw_sw_version: string; }
/**
 * Rule 6 / 7001(c)(1)(D): a "material" change (officer determination — escalations: "`officer` approves … hw/sw
 * 'material change' determinations") flags every active consent `reconsent_required`, queues
 * NTC_ESIGN_HWSW_CHANGE_RECONSENT (revised requirements; right to withdraw without fee) and blocks e-delivery until
 * (C) is re-demonstrated. A non-material change is logged and flags nothing.
 */
export function announceHwSwChange(deps: Deps, f: HwSwChangeInput): { material: boolean; flagged: string[]; notice: "NTC_ESIGN_HWSW_CHANGE_RECONSENT" | null; electronic_blocked: boolean; gate: "ESIGN_7001C1D_RECONSENT_GATE"; events: DomainEvent[] } {
  need(isPlainDate(f.effective_on), "announceHwSwChange: effective_on must be a PlainDate");
  need(f.change.length > 0 && f.hw_sw_version.length > 0, "announceHwSwChange: the change and the revised hw_sw_version must be stated (7001(c)(1)(D))");
  need(f.determined_by === "officer", "announceHwSwChange: the material-change determination is an officer decision (7.4 escalations)");
  const actor = actorOf(deps);
  if (!f.material) {
    const ev = deps.events.append({ type: "hw_sw_requirements.changed", loanId: f.loan_id, actor, payload: { material: false, effective_on: f.effective_on, change: f.change, hw_sw_version: f.hw_sw_version, determined_by: f.determined_by, flagged: [] } });
    return { material: false, flagged: [], notice: null, electronic_blocked: false, gate: "ESIGN_7001C1D_RECONSENT_GATE", events: [ev] };
  }
  const ch = materialChange(f.consents, f.effective_on);
  const changed = deps.events.append({ type: "hw_sw_requirements.changed", loanId: f.loan_id, actor, payload: { ...ch.event.payload, change: f.change, hw_sw_version: f.hw_sw_version, determined_by: f.determined_by, flagged: ch.flagged, notice: ch.notice, electronic_blocked: true } });
  const events = [changed, ...ch.flagged.map((party_id) => deps.events.append({ type: "consent.esign.reconsent_required", loanId: f.loan_id, actor, causationId: changed.id, payload: { party_id, effective_on: f.effective_on, hw_sw_version: f.hw_sw_version, notice: ch.notice } }))];
  return { material: true, flagged: ch.flagged, notice: ch.notice, electronic_blocked: true, gate: ch.gate, events };
}

export interface ReconsentInput { readonly loan_id: string; readonly prior: Consent; readonly prior_id: string; readonly consent_id: string; readonly link_opened_at: string | null; readonly token_entered_at: string | null; readonly token_ok: boolean; }
/** Re-demonstration after a hw/sw change or a bounce: a new active row (`reconsent_of` the prior, append-only); closes ESIGN_7001C1D_RECONSENT_GATE and starts a fresh revalidation clock. */
export function completeReconsent(deps: Deps, f: ReconsentInput): { consent: Consent | null; refusal: string | null; events: DomainEvent[] } {
  const next = reconsent(f.prior, f.prior_id, f.link_opened_at !== null, f.token_ok && f.token_entered_at !== null, etDate(f.token_entered_at ?? f.link_opened_at ?? new Date(0).toISOString()));
  if ("error" in next) return { consent: null, refusal: next.error, events: [] };
  const actor = actorOf(deps);
  const re = deps.events.append({ type: "consent.esign.reconsented", loanId: f.loan_id, actor, payload: { party_id: next.party_id, consent_id: f.consent_id, reconsent_of: f.prior_id, verified_on: next.verified_on, link_opened_at: f.link_opened_at, token_entered_at: f.token_entered_at, classes: [...next.classes] } });
  const active = deps.events.append({ type: "consent.esign.active", loanId: f.loan_id, actor, causationId: re.id, payload: { party_id: next.party_id, consent_id: f.consent_id, verified_at: f.token_entered_at, classes: [...next.classes], disclosure_version: next.disclosure_version, reconsent_of: f.prior_id } });
  return { consent: next, refusal: null, events: [re, active] };
}

// ============================================================ withdrawal (SM_ESIGN_WITHDRAWAL_EFFECT_1BD)
export type WithdrawalChannel = "portal" | "written" | "email" | "phone";
export interface WithdrawalReceivedInput { readonly loan_id: string; readonly consent_id: string; readonly consent: Consent; readonly received_at: string; readonly channel: WithdrawalChannel; readonly classes?: readonly string[]; readonly reason?: string; }
/** Rule 7: withdrawal "accepted via portal, written request, email, or a call (voice withdrawal is fine — it is the *consent* that cannot be oral)"; receipt anchors the 1-BD effect clock. */
export function receiveWithdrawal(deps: Deps, f: WithdrawalReceivedInput): { receipt: PlainDate; effective_by: PlainDate; timer: "SM_ESIGN_WITHDRAWAL_EFFECT_1BD"; event: DomainEvent } {
  need(isIso(f.received_at), "receiveWithdrawal: received_at must be an ISO instant");
  need(f.consent.status === "active" || f.consent.status === "suspect" || f.consent.status === "reconsent_required" || f.consent.status === "pending_verification", `receiveWithdrawal: consent is ${f.consent.status}; nothing to withdraw`);
  const receipt = etDate(f.received_at);
  const effective_by = addBusinessDays(receipt, 1, servicer);
  const event = deps.events.append({ type: "consent.esign.withdrawal_received", loanId: f.loan_id, actor: actorOf(deps), payload: { party_id: f.consent.party_id, consent_id: f.consent_id, receipt, received_at: f.received_at, channel: f.channel, classes: f.classes && f.classes.length ? [...f.classes] : "all", reason: f.reason ?? null, effective_by } });
  return { receipt, effective_by, timer: "SM_ESIGN_WITHDRAWAL_EFFECT_1BD", event };
}
/** Rule 7 / 7001(c)(4): the classes revert to mail (all, unless only some were withdrawn), NTC_ESIGN_WITHDRAWAL_CONFIRMATION goes by mail, records already provided stay accessible. */
export function applyWithdrawal(deps: Deps, f: { loan_id: string; consent_id: string; consent: Consent; on: PlainDate; classes?: readonly string[] }): ReturnType<typeof withdraw> & { applied_on: PlainDate; appended: DomainEvent } {
  need(isPlainDate(f.on), "applyWithdrawal: on must be a PlainDate");
  const w = withdraw(f.consent, f.on, f.classes);
  need(w.classes_withdrawn.length > 0, "applyWithdrawal: no consented class matched the withdrawal");
  const appended = deps.events.append({ type: "consent.esign.withdrawn", loanId: f.loan_id, actor: actorOf(deps), payload: { ...w.event.payload, consent_id: f.consent_id, all_classes_mail: w.all_classes_mail, classes_remaining: [...w.classes_remaining], confirmation: w.confirmation, confirmation_channel: w.confirmation_channel, confirmation_sent: true, prior_records_remain_accessible: true, applied_on: f.on } });
  return { ...w, applied_on: f.on, appended };
}

// ============================================================ TCPA revocation (TCPA_REVOCATION_HONOR_10BD)
export interface TcpaRevocationInput { readonly party_id: string; readonly number: string; readonly kind: "tcpa_sms" | "tcpa_voice"; readonly channel: "sms_reply" | "verbal" | "email" | "portal"; readonly reply: string; readonly received_at: string; readonly loan_id?: string; }
const subjectOf = (f: { loan_id?: string; party_id: string }) => (f.loan_id ? { loanId: f.loan_id } : { aggregate: { kind: "party", id: f.party_id } });
/**
 * Rule 12 / integrations: the SMS provider's STOP/HELP keyword webhook (and any "reasonable means" — verbal, email,
 * portal) is validated and, when it reads as a revocation (keyword or free text; "over-recognition preferred"), the
 * number is suppressed immediately and the revocation clock starts at receipt. A non-revocation reply appends nothing.
 */
export function receiveTcpaRevocation(deps: Deps, f: TcpaRevocationInput): { revocation: boolean; recognized_from: "keyword" | "free_text" | null; suppressed_immediately: boolean; receipt: PlainDate; apply_to_all_lists_by: PlainDate; outside_bound: PlainDate; timer: "TCPA_REVOCATION_HONOR_10BD"; event: DomainEvent | null } {
  need(/^\+[1-9]\d{6,14}$/.test(f.number), "receiveTcpaRevocation: number must be E.164");
  need(f.reply.trim().length > 0, "receiveTcpaRevocation: an empty reply is not a revocation");
  need(isIso(f.received_at), "receiveTcpaRevocation: received_at must be an ISO instant");
  const receipt = etDate(f.received_at);
  const s = tcpaStop({ number: f.number, reply: f.reply, received_on: receipt });
  if (!s.revocation) return { revocation: false, recognized_from: null, suppressed_immediately: false, receipt, apply_to_all_lists_by: s.apply_to_all_lists_by, outside_bound: s.outside_bound, timer: "TCPA_REVOCATION_HONOR_10BD", event: null };
  const event = deps.events.append({ type: "consent.tcpa.revocation_received", ...subjectOf(f), actor: actorOf(deps), payload: { party_id: f.party_id, number: f.number, kind: f.kind, channel: f.channel, reply: f.reply, recognized_from: s.recognized_from, receipt, received_at: f.received_at, suppressed_immediately: true, apply_to_all_lists_by: s.apply_to_all_lists_by, outside_bound: s.outside_bound } });
  return { revocation: true, recognized_from: s.recognized_from, suppressed_immediately: true, receipt, apply_to_all_lists_by: s.apply_to_all_lists_by, outside_bound: s.outside_bound, timer: "TCPA_REVOCATION_HONOR_10BD", event };
}
/** Rule 12: the revocation "is applied to all outbound dialer/SMS lists"; the clock closes only when every list is covered. */
export function applyTcpaRevocation(deps: Deps, f: { party_id: string; number: string; kind: "tcpa_sms" | "tcpa_voice"; lists: readonly string[]; applied_at: string; loan_id?: string }): { applied_to_all_lists: boolean; missing_lists: string[]; applied_on: PlainDate; event: DomainEvent } {
  need(f.lists.length > 0, "applyTcpaRevocation: at least one outbound list must be named");
  need(isIso(f.applied_at), "applyTcpaRevocation: applied_at must be an ISO instant");
  const missing = TCPA_OUTBOUND_LISTS.filter((l) => !f.lists.includes(l));
  const applied_on = etDate(f.applied_at);
  const event = deps.events.append({ type: "consent.tcpa.revoked", ...subjectOf(f), actor: actorOf(deps), payload: { party_id: f.party_id, number: f.number, kind: f.kind, lists: [...f.lists], applied_to_all_lists: missing.length === 0, missing_lists: [...missing], applied_on, applied_at: f.applied_at } });
  return { applied_to_all_lists: missing.length === 0, missing_lists: [...missing], applied_on, event };
}

// ============================================================ revalidation (SM_CONSENT_REVALIDATION_12M, informational)
/** `edelivery_events.viewed_at`: "any notice viewed in the portal in the last 12 months counts" as revalidation of an active consent. */
export function recordPortalView(deps: Deps, f: { loan_id: string; consent_id: string; consent: Consent; notice_id: string; viewed_at: string }): { revalidated: boolean; revalidated_through: PlainDate | null; events: DomainEvent[] } {
  need(isIso(f.viewed_at), "recordPortalView: viewed_at must be an ISO instant");
  need(f.notice_id.length > 0, "recordPortalView: notice_id is required");
  const actor = actorOf(deps);
  const viewed = deps.events.append({ type: "edelivery.viewed", loanId: f.loan_id, actor, payload: { party_id: f.consent.party_id, notice_id: f.notice_id, viewed_at: f.viewed_at } });
  if (f.consent.status !== "active") return { revalidated: false, revalidated_through: null, events: [viewed] };
  const through = addMonths(etDate(f.viewed_at), 12);
  const re = deps.events.append({ type: "consent.esign.revalidated", loanId: f.loan_id, actor, causationId: viewed.id, payload: { party_id: f.consent.party_id, consent_id: f.consent_id, basis: "portal_view", notice_id: f.notice_id, viewed_at: f.viewed_at, revalidated_through: through } });
  return { revalidated: true, revalidated_through: through, events: [viewed, re] };
}
/** Open question 3 — "informational only; no forced re-consent": the 12-month check reports, never withdraws. */
export function revalidationCheck(f: { consent: Consent; portal_views_at: readonly string[]; as_of: PlainDate }): { due_on: PlainDate | null; dormant: boolean; revalidated: boolean; forced_reconsent: false; action: "none_informational" } {
  need(isPlainDate(f.as_of), "revalidationCheck: as_of must be a PlainDate");
  const due_on = f.consent.verified_on ? addMonths(f.consent.verified_on, 12) : null;
  const since = addMonths(f.as_of, -12);
  const revalidated = f.portal_views_at.some((v) => { const d = etDate(v); return d >= since && d <= f.as_of; });
  return { due_on, dormant: due_on !== null && f.as_of >= due_on && !revalidated, revalidated, forced_reconsent: false, action: "none_informational" };
}

// ============================================================ AI voice / chat enrollment (rule 3, rule 13)
/** T2: the call's "yes" creates no E-SIGN consent (7001(c)(6)); the invitation goes out and the automation disclosure is logged per interaction. */
export function voiceEnrollment(deps: Deps, f: Parameters<typeof voiceEnrollmentRequest>[0] & { loan_id: string }): ReturnType<typeof voiceEnrollmentRequest> & { events: DomainEvent[] } {
  need(f.call_id.length > 0 && f.party_id.length > 0, "voiceEnrollment: call_id and party_id are required");
  const r = voiceEnrollmentRequest(f);
  const actor = actorOf(deps);
  const ack = deps.events.append({ type: r.call_log.disclosure_event, loanId: f.loan_id, actor, payload: { party_id: f.party_id, call_id: f.call_id, channel: f.channel, automation_disclosure: true, logged_on: f.on, utterance: f.utterance } });
  const invited = deps.events.append({ type: "consent.esign.invited", loanId: f.loan_id, actor, causationId: ack.id, payload: { party_id: f.party_id, email: r.invitation.email, sms: r.invitation.sms, link: r.invitation.link, esign_consent_created: false, refusal: r.refusal } });
  return { ...r, events: [ack, invited] };
}
