/** §7.4 E-SIGN consent for e-delivery — consent lifecycle, per-party rule, channel resolution. */
import { type PlainDate, addDays, daysBetween } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";

export type ConsentStatus = "pending_verification" | "active" | "suspect" | "reconsent_required" | "withdrawn" | "evidence_only";
export interface Consent { readonly party_id: string; readonly classes: readonly string[]; readonly disclosure_version: string; status: ConsentStatus; readonly consented_on: PlainDate; verified_on?: PlainDate; soft_bounces_30d: number; }
export function newConsent(partyId: string, classes: readonly string[], version: string, on: PlainDate, via: "portal" | "api_transfer_in" | "voice"): Consent | { error: string } {
  if (via === "voice") return { error: "oral consent cannot be E-SIGN consent (15 U.S.C. 7001(c)(6)); send an invitation instead" };
  return { party_id: partyId, classes, disclosure_version: version, status: via === "api_transfer_in" ? "evidence_only" : "pending_verification", consented_on: on, soft_bounces_30d: 0 };
}
/** (c)(1)(C)(ii) demonstration: link opened from the email + token from the PDF within 7 days. */
export function verify(c: Consent, linkOpened: boolean, tokenOk: boolean, on: PlainDate): Consent { if (c.status === "pending_verification" && linkOpened && tokenOk && daysBetween(c.consented_on, on) <= 7) { c.status = "active"; c.verified_on = on; } return c; }
export function bounce(c: Consent, kind: "hard" | "soft" | "complaint"): { mail_same_day: boolean } { if (kind === "complaint") { c.status = "withdrawn"; return { mail_same_day: true }; } if (kind === "hard") { c.status = "suspect"; return { mail_same_day: true }; } c.soft_bounces_30d++; if (c.soft_bounces_30d >= 3) { c.status = "suspect"; return { mail_same_day: true }; } return { mail_same_day: false }; }
export function withdraw(c: Consent, on: PlainDate, classes?: readonly string[]): { effective_by: PlainDate; confirmation: "NTC_ESIGN_WITHDRAWAL_CONFIRMATION" } { if (!classes) c.status = "withdrawn"; return { effective_by: addBusinessDays(on, 1, servicer), confirmation: "NTC_ESIGN_WITHDRAWAL_CONFIRMATION" }; }
export function materialChange(consents: Consent[]): void { for (const c of consents) if (c.status === "active") c.status = "reconsent_required"; }
/** Channel per recipient party; electronic only when every recipient has active consent for the class; state-mandated mail wins. */
export function channelFor(parties: readonly { party_id: string; consent?: Consent }[], notice_class: string, stateMandatedMail = false): { party_id: string; channel: "electronic" | "mail" }[] {
  return parties.map((p) => ({ party_id: p.party_id, channel: !stateMandatedMail && p.consent?.status === "active" && p.consent.classes.includes(notice_class) ? "electronic" : "mail" }));
}
export function irs1098Channel(irsConsent: boolean): "electronic" | "paper" { return irsConsent ? "electronic" : "paper"; }
export function tcpaRevocationDeadline(on: PlainDate): PlainDate { return addBusinessDays(on, 10, servicer); }
export function verificationExpires(c: Consent): PlainDate { return addDays(c.consented_on, 7); }
