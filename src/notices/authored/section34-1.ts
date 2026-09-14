/**
 * §34.1 process-owned notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts) and
 * per-code channel/combination overrides. Spread by ../catalog.ts after the servicing files, so a version here
 * supersedes one there for the same code and effective date.
 *
 *   NTC_SM_STAFF_INVITATION   34.1 Outputs — "Notice `NTC_SM_STAFF_INVITATION` (e-mail: the inviter's name, the roles, the
 *                             sign-in address, 'a code will be sent to this e-mail'; no borrower data)." Sent by `staff.invite`
 *                             (src/runtime/staff/auth.ts staffInvite) through the Notice Registry by e-mail only; channel policy
 *                             `electronic_ok_without_esign` (the notice is about a staff account, not a consumer disclosure — no
 *                             E-SIGN consent, no mailed fallback: a staff member has no mailing address on file). Governing source:
 *                             16 CFR §314.4(c)(1) (access to customer information only by authorized users — the invitation is how
 *                             an authorized user is provisioned); CAN-SPAM 15 U.S.C. §7702(17)(A) (a relationship message to an
 *                             employee about their own account; the sender's postal address is carried anyway).
 *
 * Tokens: `inviter_name` (the admin's legal name, or "The Supermortgage platform" for the bootstrap admin), `roles` (the roles
 * granted, comma-separated), `sign_in_url` (OPS_URL, else the app base + /ops), `platform_postal_address` (SERVICER_CONTACT
 * .servicer_address). Never a destination (the e-mail is "this e-mail", never spelled), never a borrower's name, loan, figure
 * or rate: T1 — "naming the inviter and the roles and no borrower data".
 */
import type { ContentRule, NoticeTemplate, VersionInput } from "../registry.ts";
import { V } from "./section01.ts";

const R = (rule_id: string, citation: string, kind: ContentRule["kind"], selector: string, message: string, extra: Partial<ContentRule> = {}): ContentRule => ({ rule_id, citation, kind, selector, severity: "block", message, ...extra });

// ------------------------------------------------------------------ NTC_SM_STAFF_INVITATION
const INVITATION = `{{#block "heading" page=1 y=0.05 pt=14 bold}}Your Supermortgage operator portal account{{/block}}
{{#block "body" page=1 y=0.12 pt=11}}{{inviter_name}} invited you to the Supermortgage operator portal with the roles: {{roles}}. To sign in, open the sign-in address below and enter this e-mail address; a code will be sent to this e-mail. You will then set a password of at least twelve characters and may add a passkey. Every action you take in the portal is recorded with your name and role.{{/block}}
{{#block "signin" page=1 y=0.45 pt=11 bold}}Sign-in address: {{sign_in_url}}{{/block}}
{{#block "footer" page=1 y=0.85 pt=9}}This message is about your staff account at Supermortgage; it carries no customer information. If you did not expect it, ignore it: nothing opens without the code and a password. Supermortgage, {{platform_postal_address}}.{{/block}}`;

const INVITATION_RULES: ContentRule[] = [
  // --- the content checklist (34.1 Outputs / T1)
  R("inviter-named", "34.1 Outputs: the inviter's name", "data_equality", "inviter_name", "the inviter's name is carried", { predicate: { and: [{ present: "inviter_name" }, { matches: ["inviter_name", "\\S"] }] } }),
  R("inviter-text", "34.1 Outputs: the inviter's name; T1 'naming the inviter'", "presence", "\\S.* invited you to the Supermortgage operator portal", "the inviter invites in the text"),
  R("roles-named", "34.1 Outputs: the roles; rule 2: roles ⊆ {ops_analyst, officer, compliance, admin}", "data_equality", "roles", "the roles are one or more of the four staff roles", { predicate: { and: [{ present: "roles" }, { matches: ["roles", "^(ops_analyst|officer|compliance|admin)(, (ops_analyst|officer|compliance|admin))*$"] }] } }),
  R("roles-text", "34.1 Outputs: the roles; T1 'naming … the roles'", "presence", "with the roles: (ops_analyst|officer|compliance|admin)", "the roles in the text"),
  R("signin-url-text", "34.1 Outputs: the sign-in address", "presence", "Sign-in address: https://[^ ]+", "the sign-in address in the text"),
  R("signin-url-data", "34.1 Operational prerequisites: the portal host — the sign-in address ends in /ops", "data_equality", "sign_in_url", "sign_in_url is an https address ending in /ops", { predicate: { matches: ["sign_in_url", "^https://[^ ]+/ops$"] } }),
  R("code-sentence", "34.1 Outputs: 'a code will be sent to this e-mail'", "presence", "a code will be sent to this e-mail", "the code sentence"),
  R("two-factors", "34.1 rule 1: a code alone never opens a session — the invitation says a password follows", "presence", "set a password of at least twelve characters", "the password sentence"),
  R("postal-address", "CAN-SPAM practice (15 U.S.C. §7704(a)(5)(A)(iii)): the sender's postal address", "presence", "Supermortgage, [^.]*\\d{5}\\.", "the platform's postal address with a ZIP"),
  R("postal-address-data", "the platform's postal address", "data_equality", "platform_postal_address", "platform_postal_address present", { predicate: { and: [{ present: "platform_postal_address" }, { matches: ["platform_postal_address", "\\d{5}"] }] } }),
  // --- no borrower data (34.1 Outputs / T1): no loan, no borrower, no figure, no rate, no destination
  R("no-borrower-data", "34.1 Outputs: 'no borrower data'; T1", "absence", "\\bloan\\b|\\bborrower\\b|\\bmortgage loan\\b|\\bproperty\\b|\\bpayment\\b|\\bbalance\\b|\\bescrow\\b", "no loan, borrower, property, payment or balance is named"),
  R("no-figure", "34.1 Outputs: no borrower data — never a figure or a rate", "absence", "\\$|\\d[\\d,]*\\.\\d{2}\\b|\\d+(\\.\\d+)?\\s*%|\\bAPR\\b", "no money figure or rate"),
  R("no-email-address", "34.1 rule 4 / T1: the e-mail is 'this e-mail', never spelled; `staff.invited` is logged without the e-mail", "absence", "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}", "no e-mail address in the text"),
  R("no-phone-number", "34.1 rule 4: never a phone number", "absence", "\\(\\d{3}\\) ?\\d{3}-\\d{4}|\\+1 ?\\d{10}|\\b\\d{3}-\\d{3}-\\d{4}\\b", "no phone number in the text"),
  R("heading-layout", "34.1 Outputs: the e-mail names the staff account", "layout", "heading", "heading on page 1, ≥ 12 pt, bold", { layout: { page: 1, minPt: 12, bold: true } }),
];

/** The bootstrap admin inviting the first analyst (T1's colleague with roles [ops_analyst]). */
const INVITATION_SAMPLE: Record<string, unknown> = { inviter_name: "Ada Admin", roles: "ops_analyst", sign_in_url: "https://app.supermortgage.example/ops", platform_postal_address: "PO Box 1, Testville TX 75001" };

export const VERSIONS_34_1: VersionInput[] = [
  V("NTC_SM_STAFF_INVITATION", INVITATION, INVITATION_RULES, INVITATION_SAMPLE, "staff.access.v1 / 34.1 Outputs", "34.1 Outputs: the staff invitation — the inviter's name, the roles, the sign-in address, 'a code will be sent to this e-mail'; no borrower data, no destination, no figure"),
];
export const OVERRIDES_34_1: Record<string, Partial<NoticeTemplate>> = {
  // 34.1: the invitation is about a staff account, not a disclosure — decideChannel e-mails the recipient (consentId `policy:electronic_ok_without_esign`), no E-SIGN consent needed, no mailed fallback wanted
  NTC_SM_STAFF_INVITATION: { channelPolicy: "electronic_ok_without_esign", noticeClass: "staff_account", citation: "16 CFR §314.4(c)(1) (authorized users); 15 U.S.C. §7702(17)(A) (relationship message); 34.1 Outputs", retention: "corporate_7y", piiLevel: "low" },
};
