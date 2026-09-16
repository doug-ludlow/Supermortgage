/**
 * §36.1 process-owned notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts) and
 * per-code channel/combination overrides. Spread by ../catalog.ts after the section-35 files, so a version here
 * supersedes one there for the same code and effective date.
 *
 *   NTC_SM_PARTNER_USER_INVITE   36.1 Outputs — "Notice `NTC_SM_PARTNER_USER_INVITE` (e-mail to the new partner user: the partner's
 *                                legal name, the roles, the sign-in address `/partners/sign-in`, 'a code will be sent to this
 *                                e-mail'; no loan figure, no homeowner data, no offer). Not a borrower notice; 33.1's invitation to
 *                                homeowners is never sent from here." Sent by `partner.user.invite` (src/runtime/partner-portal/auth.ts
 *                                partnerInvite) through the Notice Registry by e-mail only; channel policy `electronic_ok_without_esign`
 *                                (the notice is about a partner user's account, not a consumer disclosure — no E-SIGN consent, no
 *                                mailed fallback). Governing source: 16 CFR §314.4(c)(1) (access to customer information only by
 *                                authorized users — the invitation is how a partner's authorized user is provisioned); 12 CFR §1016.13
 *                                (the partner's data for the partner's program — the portal is the partner's book, named by the
 *                                partner's legal name, never a Supermortgage acquisition funnel); CAN-SPAM 15 U.S.C. §7702(17)(A) (a
 *                                relationship message about the recipient's own account; the sender's postal address is carried anyway).
 *
 * Tokens: `partner_legal_name` (the tenant's parties{servicer} legal name — the door is branded with it, brief §3 rule 10),
 * `roles` (the partner roles granted, comma-separated — partner_admin / partner_ops / partner_auditor, never a staff role),
 * `sign_in_url` (PARTNER_URL or the app base, + /partners/sign-in), `platform_postal_address` (FAKE_SERVICER_PROFILE_V1's
 * servicer_address). Never a destination (the e-mail is "this e-mail", never spelled), never a homeowner's name, a loan, a figure,
 * a rate or an offer.
 */
import type { ContentRule, NoticeTemplate, VersionInput } from "../registry.ts";
import { V } from "./section01.ts";

const R = (rule_id: string, citation: string, kind: ContentRule["kind"], selector: string, message: string, extra: Partial<ContentRule> = {}): ContentRule => ({ rule_id, citation, kind, selector, severity: "block", message, ...extra });

// ------------------------------------------------------------------ NTC_SM_PARTNER_USER_INVITE
const INVITE = `{{#block "heading" page=1 y=0.05 pt=14 bold}}Your {{partner_legal_name}} partner portal account{{/block}}
{{#block "body" page=1 y=0.12 pt=11}}{{partner_legal_name}} invited you to its partner portal on the Supermortgage platform with the roles: {{roles}}. To sign in, open the sign-in address below and enter this e-mail address; a code will be sent to this e-mail. You will then set a password of at least twelve characters and may add a passkey. Every action you take in the portal is recorded with your name and role. The portal shows {{partner_legal_name}}'s own servicing book and nothing else.{{/block}}
{{#block "signin" page=1 y=0.45 pt=11 bold}}Sign-in address: {{sign_in_url}}{{/block}}
{{#block "footer" page=1 y=0.85 pt=9}}This message is about your partner portal account; it carries no customer information. If you did not expect it, ignore it: nothing opens without the code and a password. Supermortgage, {{platform_postal_address}}.{{/block}}`;

const INVITE_RULES: ContentRule[] = [
  // --- the content checklist (36.1 Outputs)
  R("partner-named", "36.1 Outputs: the partner's legal name; brief §3 rule 10: the portal is the partner's book, branded with the partner's legal name", "data_equality", "partner_legal_name", "the partner's legal name is carried", { predicate: { and: [{ present: "partner_legal_name" }, { matches: ["partner_legal_name", "\\S"] }] } }),
  R("partner-text", "36.1 Outputs: the partner's legal name in the text", "presence", "\\S.* invited you to its partner portal", "the partner invites in the text"),
  R("roles-named", "36.1 Outputs: the roles; rule 2: roles ⊆ {partner_admin, partner_ops, partner_auditor}, never a staff role", "data_equality", "roles", "the roles are one or more of the three partner roles", { predicate: { and: [{ present: "roles" }, { matches: ["roles", "^(partner_admin|partner_ops|partner_auditor)(, (partner_admin|partner_ops|partner_auditor))*$"] }] } }),
  R("roles-text", "36.1 Outputs: the roles in the text", "presence", "with the roles: (partner_admin|partner_ops|partner_auditor)", "the roles in the text"),
  R("signin-url-text", "36.1 Outputs: the sign-in address", "presence", "Sign-in address: https://[^ ]+", "the sign-in address in the text"),
  R("signin-url-data", "36.1 Outputs: the sign-in address `/partners/sign-in`", "data_equality", "sign_in_url", "sign_in_url is an https address ending in /partners/sign-in", { predicate: { matches: ["sign_in_url", "^https://[^ ]+/partners/sign-in$"] } }),
  R("code-sentence", "36.1 Outputs: 'a code will be sent to this e-mail'", "presence", "a code will be sent to this e-mail", "the code sentence"),
  R("two-factors", "36.1 rule 1: a code alone never opens a session — the invitation says a password follows", "presence", "set a password of at least twelve characters", "the password sentence"),
  R("tenant-sentence", "36.1 rule 4 / 12 CFR §1016.13: the portal shows the partner's own book and nothing else", "presence", "own servicing book and nothing else", "the tenant sentence"),
  R("postal-address", "CAN-SPAM practice (15 U.S.C. §7704(a)(5)(A)(iii)): the sender's postal address", "presence", "Supermortgage, [^.]*\\d{5}\\.", "the platform's postal address with a ZIP"),
  R("postal-address-data", "the platform's postal address", "data_equality", "platform_postal_address", "platform_postal_address present", { predicate: { and: [{ present: "platform_postal_address" }, { matches: ["platform_postal_address", "\\d{5}"] }] } }),
  // --- no loan figure, no homeowner data, no offer (36.1 Outputs): no loan, no borrower, no figure, no rate, no offer, no destination
  R("no-homeowner-data", "36.1 Outputs: 'no loan figure, no homeowner data, no offer'", "absence", "\\bloan\\b|\\bborrower\\b|\\bhomeowner\\b|\\bmortgage loan\\b|\\bproperty\\b|\\bpayment\\b|\\bbalance\\b|\\bescrow\\b|\\boffer\\b|\\brefinanc", "no loan, borrower, homeowner, property, payment, balance, offer or refinance is named"),
  R("no-figure", "36.1 Outputs: no loan figure — never a figure or a rate", "absence", "\\$|\\d[\\d,]*\\.\\d{2}\\b|\\d+(\\.\\d+)?\\s*%|\\bAPR\\b", "no money figure or rate"),
  R("no-email-address", "36.1 rule 5: the e-mail is 'this e-mail', never spelled; no log row and no event carries it", "absence", "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}", "no e-mail address in the text"),
  R("no-phone-number", "36.1 rule 5: never a phone number", "absence", "\\(\\d{3}\\) ?\\d{3}-\\d{4}|\\+1 ?\\d{10}|\\b\\d{3}-\\d{3}-\\d{4}\\b", "no phone number in the text"),
  R("no-staff-role", "36.1 rule 2: a partner user is never a staff role", "absence", "\\bops_analyst\\b|\\bofficer\\b|\\bcompliance\\b|\\badmin\\b", "no staff role is named"),
  R("heading-layout", "36.1 Outputs: the e-mail names the partner portal account", "layout", "heading", "heading on page 1, ≥ 12 pt, bold", { layout: { page: 1, minPt: 12, bold: true } }),
];

/** The demo partner's first partner_admin (Operational prerequisites: seeded against the demo partner in non-production). */
const INVITE_SAMPLE: Record<string, unknown> = { partner_legal_name: "Northlight Mortgage Servicing (FAKE partner)", roles: "partner_admin", sign_in_url: "https://app.supermortgage.example/partners/sign-in", platform_postal_address: "PO Box 1, Testville TX 75001" };

export const VERSIONS_36_1: VersionInput[] = [
  V("NTC_SM_PARTNER_USER_INVITE", INVITE, INVITE_RULES, INVITE_SAMPLE, "partner_portal.access.v1 / 36.1 Outputs", "36.1 Outputs: the partner user invitation — the partner's legal name, the roles, the sign-in address /partners/sign-in, 'a code will be sent to this e-mail'; no loan figure, no homeowner data, no offer, no destination"),
];
export const OVERRIDES_36_1: Record<string, Partial<NoticeTemplate>> = {
  // 36.1: the invitation is about a partner user's account, not a disclosure — decideChannel e-mails the recipient (consentId `policy:electronic_ok_without_esign`), no E-SIGN consent needed, no mailed fallback wanted
  NTC_SM_PARTNER_USER_INVITE: { channelPolicy: "electronic_ok_without_esign", noticeClass: "partner_account", citation: "16 CFR §314.4(c)(1) (authorized users); 12 CFR §1016.13 (the partner's program); 15 U.S.C. §7702(17)(A) (relationship message); 36.1 Outputs", retention: "corporate_7y", piiLevel: "low" },
};
