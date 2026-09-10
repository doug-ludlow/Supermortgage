/** §7.4 E-SIGN consent for e-delivery — consent lifecycle, per-party rule, channel resolution, TCPA evidence guardrail. */
import { type PlainDate, addDays, daysBetween } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";

export type ConsentStatus = "pending_verification" | "active" | "suspect" | "reconsent_required" | "withdrawn" | "expired" | "evidence_only";   // `expired`: 7 days without the (C)(ii) demonstration (7.4 state machine; db 0009 CHECK)
export interface Consent {
  readonly party_id: string;
  /** Classes still consented to; a partial withdrawal (rule 7) removes classes here and lists them in `withdrawn_classes`. */
  classes: readonly string[];
  readonly disclosure_version: string;
  status: ConsentStatus;
  readonly consented_on: PlainDate;
  verified_on?: PlainDate;
  soft_bounces_30d: number;
  withdrawn_classes?: readonly string[];
  /** Set on the row a re-demonstration created (hw/sw change, re-verification after a bounce): the prior row it supersedes. */
  reconsent_of?: string;
}
export function newConsent(partyId: string, classes: readonly string[], version: string, on: PlainDate, via: "portal" | "api_transfer_in" | "voice"): Consent | { error: string } {
  if (via === "voice") return { error: "oral consent cannot be E-SIGN consent (15 U.S.C. 7001(c)(6)); send an invitation instead" };
  return { party_id: partyId, classes, disclosure_version: version, status: via === "api_transfer_in" ? "evidence_only" : "pending_verification", consented_on: on, soft_bounces_30d: 0 };
}
/** (c)(1)(C)(ii) demonstration: link opened from the email + token from the PDF within 7 days. */
export function verify(c: Consent, linkOpened: boolean, tokenOk: boolean, on: PlainDate): Consent { if (c.status === "pending_verification" && linkOpened && tokenOk && daysBetween(c.consented_on, on) <= 7) { c.status = "active"; c.verified_on = on; } return c; }
export function bounce(c: Consent, kind: "hard" | "soft" | "complaint"): { mail_same_day: boolean } { if (kind === "complaint") { c.status = "withdrawn"; return { mail_same_day: true }; } if (kind === "hard") { c.status = "suspect"; return { mail_same_day: true }; } c.soft_bounces_30d++; if (c.soft_bounces_30d >= 3) { c.status = "suspect"; return { mail_same_day: true }; } return { mail_same_day: false }; }
/**
 * 7.4 rule 7 / 7001(c)(1)(A), (c)(4): withdrawal (by any channel — voice is fine for a withdrawal) is applied within
 * 1 business day; every class reverts to mail unless the borrower withdraws only some classes, in which case those
 * classes leave the consent and the rest keep e-delivery; the confirmation goes by mail; records already provided stand.
 */
export function withdraw(c: Consent, on: PlainDate, classes?: readonly string[]): { effective_by: PlainDate; confirmation: "NTC_ESIGN_WITHDRAWAL_CONFIRMATION"; confirmation_channel: "mail"; classes_withdrawn: readonly string[]; classes_remaining: readonly string[]; all_classes_mail: boolean; prior_records_remain_accessible: true; event: { type: "consent.esign.withdrawn"; payload: { party_id: string; classes: readonly string[]; partial: boolean } } } {
  const withdrawn = classes && classes.length ? c.classes.filter((x) => classes.includes(x)) : [...c.classes];
  c.classes = c.classes.filter((x) => !withdrawn.includes(x));
  c.withdrawn_classes = [...(c.withdrawn_classes ?? []), ...withdrawn];
  if (c.classes.length === 0) c.status = "withdrawn";
  const partial = c.classes.length > 0;
  return { effective_by: addBusinessDays(on, 1, servicer), confirmation: "NTC_ESIGN_WITHDRAWAL_CONFIRMATION", confirmation_channel: "mail", classes_withdrawn: withdrawn, classes_remaining: c.classes, all_classes_mail: !partial, prior_records_remain_accessible: true, event: { type: "consent.esign.withdrawn", payload: { party_id: c.party_id, classes: withdrawn, partial } } };
}
/** 7.4 rule 6 / 7001(c)(1)(D): a material hardware/software change flags every active consent `reconsent_required`; e-delivery is blocked until (C) is re-demonstrated. */
export function materialChange(consents: Consent[], effectiveOn?: PlainDate): { flagged: string[]; notice: "NTC_ESIGN_HWSW_CHANGE_RECONSENT"; electronic_blocked: true; gate: "ESIGN_7001C1D_RECONSENT_GATE"; event: { type: "hw_sw_requirements.changed"; payload: { material: true; effective_on: PlainDate | null } } } {
  const flagged: string[] = [];
  for (const c of consents) if (c.status === "active") { c.status = "reconsent_required"; flagged.push(c.party_id); }
  return { flagged, notice: "NTC_ESIGN_HWSW_CHANGE_RECONSENT", electronic_blocked: true, gate: "ESIGN_7001C1D_RECONSENT_GATE", event: { type: "hw_sw_requirements.changed", payload: { material: true, effective_on: effectiveOn ?? null } } };
}
/** Re-demonstration after a hw/sw change or bounce: a new active row (`reconsent_of` the prior); the prior row is superseded. Append-only: the old row is never edited into `active`. */
export function reconsent(prior: Consent, priorId: string, linkOpened: boolean, tokenOk: boolean, on: PlainDate): Consent | { error: string } {
  if (prior.status !== "reconsent_required" && prior.status !== "suspect") return { error: `consent is ${prior.status}; nothing to re-demonstrate` };
  if (!linkOpened || !tokenOk) return { error: "the (c)(1)(C)(ii) demonstration (link opened + PDF token) is required before e-delivery resumes" };
  const next: Consent = { party_id: prior.party_id, classes: prior.classes, disclosure_version: prior.disclosure_version, status: "active", consented_on: on, verified_on: on, soft_bounces_30d: 0, reconsent_of: priorId };
  return next;
}
/** Channel per recipient party; electronic only when every recipient has active consent for the class; state-mandated mail wins. */
export function channelFor(parties: readonly { party_id: string; consent?: Consent }[], notice_class: string, stateMandatedMail = false): { party_id: string; channel: "electronic" | "mail" }[] {
  return parties.map((p) => ({ party_id: p.party_id, channel: !stateMandatedMail && p.consent?.status === "active" && p.consent.classes.includes(notice_class) ? "electronic" : "mail" }));
}
export function irs1098Channel(irsConsent: boolean): "electronic" | "paper" { return irsConsent ? "electronic" : "paper"; }
export function tcpaRevocationDeadline(on: PlainDate): PlainDate { return addBusinessDays(on, 10, servicer); }
export function verificationExpires(c: Consent): PlainDate { return addDays(c.consented_on, 7); }
/**
 * 7.4 guardrail: "the agent cannot mark a TCPA consent from a call transcript unless the recorded call contains the
 * scripted consent language and the number was confirmed (stored as evidence with the recording id)".
 */
export function tcpaConsentFromCall(f: { kind: "tcpa_voice" | "tcpa_sms"; number: string; scripted_language_present: boolean; number_confirmed: boolean; recording_id: string | null; on: PlainDate }): { recorded: boolean; refusal: string | null; consent: { kind: "tcpa_voice" | "tcpa_sms"; number: string; granted_on: PlainDate; evidence: { recording_id: string } } | null } {
  const missing = [!f.scripted_language_present ? "scripted consent language" : null, !f.number_confirmed ? "number confirmation" : null, !f.recording_id ? "recording id" : null].filter((x): x is string => x !== null);
  if (missing.length) return { recorded: false, refusal: `TCPA consent not recorded from the call: missing ${missing.join(", ")} (7.4 guardrail)`, consent: null };
  return { recorded: true, refusal: null, consent: { kind: f.kind, number: f.number, granted_on: f.on, evidence: { recording_id: f.recording_id! } } };
}
