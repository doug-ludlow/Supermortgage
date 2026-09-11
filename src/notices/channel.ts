/**
 * Channel decision (7.4 rules 1, 4, 6–9; 7.4-T3/T9/T10; 11.2 rule 11).
 * Per recipient: electronic only when the template's policy allows it and
 * that party holds an active E-SIGN consent covering the template's class;
 * `mail_only` templates (state-mandated mail, e.g. NY RPAPL 1304) and a
 * jurisdiction override always mail; a suspect/withdrawn/reconsent-required
 * consent mails. The regulatory timer is satisfied by the mail delivery when
 * parties split (7.4 rule 4). Envelope grouping honours `separate_document`
 * and `may_combine_with`.
 */
import type { NoticeTemplate } from "./registry.ts";
import type { Consent } from "../domain/notices/esign.ts";

/** `esign_portal` (DELTA-08): the notice is delivered by a DocumentCard / NoticeCard in the borrower thread; the card instance is the delivery evidence beside the rendered document. */
export type Channel = "mail_first_class" | "mail_certified" | "email_link" | "portal_post" | "sms_link" | "esign_portal";
export interface Recipient { readonly partyId: string; readonly name: string; readonly mailingAddress: string | null; readonly email?: string; readonly consent?: Consent; readonly portalUser?: boolean; }
export interface ChannelDecision { readonly partyId: string; readonly channel: Channel; readonly reason: string; readonly consentId?: string; readonly satisfiesTimer: boolean; readonly held?: string; readonly cardInstanceId?: string; }
export interface ChannelContext { readonly stateMandatedMail?: boolean; readonly certified?: boolean; readonly preferPortal?: boolean;
  /** DELTA-08: party id → the `card_instances` row that will carry the document; with an active E-SIGN consent for the class the channel is `esign_portal` and the card id is recorded as delivery evidence. */
  readonly cardInstances?: Readonly<Record<string, string>>; }

export function decideChannel(t: NoticeTemplate, recipients: readonly Recipient[], ctx: ChannelContext = {}): ChannelDecision[] {
  const mail: Channel = ctx.certified ? "mail_certified" : "mail_first_class";
  const decisions = recipients.map((r): ChannelDecision => {
    const mailed = (reason: string): ChannelDecision => r.mailingAddress ? { partyId: r.partyId, channel: mail, reason, satisfiesTimer: true } : { partyId: r.partyId, channel: mail, reason, satisfiesTimer: false, held: "address unknown" };
    if (t.channelPolicy === "mail_only") return mailed("template is mail_only");
    if (ctx.stateMandatedMail) return mailed("state-mandated mail (7.4-T10)");
    const c = r.consent;
    if (t.channelPolicy === "electronic_ok_without_esign") {
      if (r.email) return { partyId: r.partyId, channel: "email_link", reason: "electronic permitted without E-SIGN consent", consentId: `policy:${t.channelPolicy}`, satisfiesTimer: true };
      return mailed("no email address on file");
    }
    if (!c) return mailed("no E-SIGN consent (7.4 rule 1)");
    if (c.status !== "active") return mailed(`consent ${c.status} (7.4 rule ${c.status === "suspect" ? "8" : c.status === "reconsent_required" ? "6" : "7"})`);
    if (!c.classes.includes(t.noticeClass)) return mailed(`consent does not cover class ${t.noticeClass} (7.4 rule 1)`);
    const card = ctx.cardInstances?.[r.partyId];
    if (card) return { partyId: r.partyId, channel: "esign_portal", reason: `active E-SIGN consent for ${t.noticeClass}; card-delivered (DELTA-08)`, consentId: `${c.party_id}:${c.disclosure_version}`, satisfiesTimer: true, cardInstanceId: card };
    const channel: Channel = ctx.preferPortal && r.portalUser ? "portal_post" : "email_link";
    return { partyId: r.partyId, channel, reason: `active E-SIGN consent for ${t.noticeClass}`, consentId: `${c.party_id}:${c.disclosure_version}`, satisfiesTimer: true };
  });
  // 7.4 rule 4: when any party mails, the mail delivery is the one that satisfies the regulatory timer.
  const anyMail = decisions.some((d) => d.channel.startsWith("mail") && !d.held);
  return decisions.map((d) => (anyMail && !d.channel.startsWith("mail") ? { ...d, satisfiesTimer: false } : d));
}

/** Envelope planning for a mail batch: separate-document notices get their own PDF (may share an envelope with permitted companions); everything else can co-mail. */
export interface EnvelopeItem { readonly noticeId: string; readonly template: NoticeTemplate; readonly partyId: string; }
export interface Envelope { readonly partyId: string; readonly items: readonly EnvelopeItem[]; readonly separatePdfs: readonly string[]; }
export function planEnvelopes(items: readonly EnvelopeItem[]): Envelope[] {
  const byParty = new Map<string, EnvelopeItem[]>();
  for (const it of items) { let l = byParty.get(it.partyId); if (!l) { l = []; byParty.set(it.partyId, l); } l.push(it); }
  const out: Envelope[] = [];
  for (const [partyId, list] of byParty) {
    const remaining = [...list];
    while (remaining.length) {
      const first = remaining.shift()!;
      const env: EnvelopeItem[] = [first];
      for (const cand of [...remaining]) {
        const ok = env.every((e) => canCombine(e.template, cand.template));
        if (ok) { env.push(cand); remaining.splice(remaining.indexOf(cand), 1); }
      }
      out.push({ partyId, items: env, separatePdfs: env.filter((e) => e.template.separateDocument).map((e) => e.noticeId) });
    }
  }
  return out;
}
function canCombine(a: NoticeTemplate, b: NoticeTemplate): boolean {
  if (a.code === b.code) return true;
  const allows = (x: NoticeTemplate, y: NoticeTemplate) => x.mayCombineWith.includes(y.code) || x.mayCombineWith.includes("*");
  return allows(a, b) || allows(b, a);
}
