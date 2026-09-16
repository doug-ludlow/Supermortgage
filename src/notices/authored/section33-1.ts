/**
 * §33.1 process-owned notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts) and
 * per-code channel/combination overrides. Spread by ../catalog.ts after the servicing files, so a version here
 * supersedes one there for the same code and effective date.
 *
 *   NTC_SM_PARTNER_BOOK_INVITATION   33.1 rule 4 — "Once per provisioned party, `account.invite` renders
 *                                    `NTC_SM_PARTNER_BOOK_INVITATION` by e-mail (channel policy `electronic_ok_without_esign`:
 *                                    the notice is about the account, not a disclosure) with the partner's name, the loan's
 *                                    last four, the sign-in address and the sentence that a code will be sent to this e-mail;
 *                                    by SMS only under the consent rule above." One template, two channel variants selected by
 *                                    the payload's `sms` flag (`channel` = "email" | "sms" is the recorded channel, `sms` the
 *                                    renderer's switch — 20.2's `email_channel` pattern). Outputs checklist: "the partner's legal
 *                                    name as servicer, the loan's last four, the sign-in address, 'we will send a code to this
 *                                    e-mail', no rate, no offer, no figure, the platform's postal address and the one-line
 *                                    reply-to-stop for the SMS". Governing source: CAN-SPAM 15 U.S.C. §7702(17)(A)(v) (a
 *                                    transactional/relationship message about an existing account — no advertisement, no
 *                                    unsubscribe footer needed, but the sender's postal address is carried anyway); TCPA
 *                                    47 U.S.C. §227(b)(1)(A) (the SMS variant only with consent evidence — decided by the
 *                                    caller, never by the template; the STOP line honours 47 CFR 64.1200 revocation).
 *
 * Tokens: `partner_legal_name` (the `parties{servicer}` legal name — the servicer of record), `loan_last4` (the servicer
 * loan number's last four), `sign_in_url` (the app base + /app),
 * `first_name` (the borrower's first name from the tape's legal name), `platform_postal_address` (the FAKE servicer profile's
 * servicer_address — FAKE_SERVICER_PROFILE_V1 in src/domain/operations-runtime/servicing-config.ts, 35.5 rule 9), `channel`/`sms`. Never a destination (e-mail address or phone number)
 * in the payload or the text — rule 3 / T4: "no destination appears in any event payload, decision rationale or log line".
 */
import type { ContentRule, NoticeTemplate, VersionInput } from "../registry.ts";
import { V } from "./section01.ts";

const R = (rule_id: string, citation: string, kind: ContentRule["kind"], selector: string, message: string, extra: Partial<ContentRule> = {}): ContentRule => ({ rule_id, citation, kind, selector, severity: "block", message, ...extra });
const EMAIL_ONLY = { when: { "!": { var: "sms" } } } as const;
const SMS_ONLY = { when: { var: "sms" } } as const;

// ------------------------------------------------------------------ NTC_SM_PARTNER_BOOK_INVITATION
// The e-mail variant is heading + body + sign-in address + footer; the SMS variant is one short block ending in the STOP line.
// The body carries no figure: the only tokens before "Sign-in address:" are the first name (first-name-data: no digit), the loan's
// last four (last4-data: exactly four digits) and the partner's legal name — which may itself carry a digit ("21st Mortgage",
// "360 Mortgage Group"), so no rule scans the rendered body for digits as such; no-rate and no-figure forbid what the spec
// forbids (a percentage, a dollar amount, a decimal figure, a balance, a payment) and a rate or figure never enters the payload.
const INVITATION = `{{#unless sms}}{{#block "heading" page=1 y=0.05 pt=14 bold}}Your loan account at Supermortgage{{/block}}
{{#block "body" page=1 y=0.12 pt=11}}Hello {{first_name}}, {{partner_legal_name}}, the servicer of your mortgage loan ending {{loan_last4}}, now provides you an account here for that loan. {{partner_legal_name}} keeps servicing your loan; this account is where we will talk with you about it. To sign in, enter this e-mail address on the sign-in page and we will send a code to this e-mail. No password is needed; you may add one later.{{/block}}
{{#block "signin" page=1 y=0.45 pt=11 bold}}Sign-in address: {{sign_in_url}}{{/block}}
{{#block "footer" page=1 y=0.85 pt=9}}This message is about your existing loan account with your servicer. Supermortgage, {{platform_postal_address}}.{{/block}}{{/unless}}{{#if sms}}{{#block "sms" page=1 y=0.05 pt=11}}{{partner_legal_name}}: your mortgage loan ending {{loan_last4}} now has an account at Supermortgage, where we will talk with you about it. Sign-in address: {{sign_in_url}} (we will send a code to the e-mail on file). Supermortgage, {{platform_postal_address}}. Reply STOP to end texts.{{/block}}{{/if}}`;

const INVITATION_RULES: ContentRule[] = [
  // --- the content checklist (33.1 Outputs)
  R("partner-named", "33.1 rule 4 / Outputs: the partner's legal name as servicer", "data_equality", "partner_legal_name", "the partner's legal name is carried", { predicate: { and: [{ present: "partner_legal_name" }, { matches: ["partner_legal_name", "\\S"] }] } }),
  R("partner-as-servicer", "33.1 rule 4: 'the partner keeps servicing it'; 33.1 Verified requirement: 'the partner stays servicer of record'", "presence", "the servicer of your mortgage loan ending|keeps servicing your loan", "the partner is named as the servicer", EMAIL_ONLY),
  R("last4-text", "33.1 rule 4 / Outputs: the loan's last four", "presence", "loan ending \\d{4}\\b", "the loan's last four in the text"),
  R("last4-data", "33.1 rule 4: the loan's last four", "data_equality", "loan_last4", "loan_last4 is exactly four digits", { predicate: { matches: ["loan_last4", "^\\d{4}$"] } }),
  R("signin-url-text", "33.1 rule 4 / Outputs: the sign-in address", "presence", "Sign-in address: https://[^ ]+", "the sign-in address in the text"),
  R("signin-url-data", "33.1 brief: the sign-in address is the app base + /app", "data_equality", "sign_in_url", "sign_in_url is an https address ending in /app", { predicate: { matches: ["sign_in_url", "^https://[^ ]+/app$"] } }),
  R("code-sentence", "33.1 rule 4: 'the sentence that a code will be sent to this e-mail'", "presence", "we will send a code to this e-mail", "the code sentence on the e-mail", EMAIL_ONLY),
  R("code-sentence-sms", "33.1 rule 4: the SMS says how to sign in (a code to the e-mail on file)", "presence", "we will send a code to the e-mail on file", "the code sentence on the SMS", SMS_ONLY),
  R("greeting", "33.1 rule 5 / T8: greets the homeowner by first name", "presence", "Hello \\S+,", "the first-name greeting", EMAIL_ONLY),
  R("first-name-data", "33.1 rule 5: the borrower's first name", "data_equality", "first_name", "first_name present", { predicate: { and: [{ present: "first_name" }, { matches: ["first_name", "^[^0-9@]+$"] }] } }),
  R("postal-address", "33.1 Outputs: the platform's postal address; 15 U.S.C. §7704(a)(5)(A)(iii) practice", "presence", "Supermortgage, [^.]*\\d{5}\\.", "the platform's postal address with a ZIP"),
  R("postal-address-data", "33.1 Outputs: the platform's postal address", "data_equality", "platform_postal_address", "platform_postal_address present", { predicate: { and: [{ present: "platform_postal_address" }, { matches: ["platform_postal_address", "\\d{5}"] }] } }),
  R("sms-stop", "33.1 Outputs: 'the one-line reply-to-stop for the SMS'; 47 CFR 64.1200 (revocation by any reasonable means)", "presence", "Reply STOP to end texts\\.", "the STOP line on the SMS", SMS_ONLY),
  R("sms-single-block", "33.1 rule 4: the SMS variant is one short message", "absence", "Sign-in address: https://[^ ]+ \\(we will send a code[^)]*\\)\\. Supermortgage, [^.]*\\. Reply STOP to end texts\\..+", "nothing follows the STOP line", SMS_ONLY),
  // --- never a rate, an offer, a figure (33.1 rule 4: 'Refinance offers are never in the invitation'; T6; 32.11 §1)
  R("no-rate", "33.1 rule 4 / T6: no rate", "absence", "\\d+(\\.\\d+)?\\s*%|\\bpercent\\b|\\bAPR\\b|\\brates?\\b", "no rate or percentage"),
  R("no-offer", "33.1 rule 4 / T6: 'Refinance offers are never in the invitation — they are 20.2's touches with 20.2's gates'", "absence", "\\boffers?\\b|\\brefinanc|\\bsave\\b|\\bsavings\\b|\\blower your\\b|\\bcash[- ]out\\b|\\bapply\\b", "no offer or solicitation"),
  R("no-figure", "33.1 rule 4 / T6: no figure", "absence", "\\$|\\d[\\d,]*\\.\\d{2}\\b|\\bbalance\\b|\\bpayment\\b", "no money figure, balance or payment"),
  // (no rule scans the body for digits as such: the partner's legal name is rendered there and may carry one — see the template's comment)
  // --- never a destination in the text (33.1 rule 3 / T4: 'no destination appears in any event payload, decision rationale or log line')
  R("no-email-address", "33.1 T4: never a destination — the e-mail is 'this e-mail', never spelled", "absence", "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}", "no e-mail address in the text"),
  R("no-phone-number", "33.1 T4: never a destination", "absence", "\\(\\d{3}\\) ?\\d{3}-\\d{4}|\\+1 ?\\d{10}|\\b\\d{3}-\\d{3}-\\d{4}\\b", "no phone number in the text"),
  // --- the channel variant is consistent with the recorded channel (partner_book_invitations.channel ∈ {email, sms})
  R("channel-variant", "33.1 data model: partner_book_invitations.channel ∈ {email, sms}; the `sms` flag selects the variant", "data_equality", "channel,sms", "channel is email with sms=false or sms with sms=true", { predicate: { or: [{ and: [{ "==": [{ var: "channel" }, "email"] }, { "!": { var: "sms" } }] }, { and: [{ "==": [{ var: "channel" }, "sms"] }, { "==": [{ var: "sms" }, true] }] }] } }),
  R("heading-layout", "33.1 rule 4: the e-mail names the account, not a disclosure", "layout", "heading", "heading on page 1, ≥ 12 pt, bold", { layout: { page: 1, minPt: 12, bold: true }, ...EMAIL_ONLY }),
];

/** Worked example A's homeowner (loan 1 of the fixture, NL-100001 → last four 0001) as the e-mail variant; the SMS variant is the same payload with `channel: "sms", sms: true`. */
const INVITATION_SAMPLE: Record<string, unknown> = {
  partner_legal_name: "Northlight Mortgage Servicing (FAKE partner)", loan_last4: "0001", first_name: "Maria",
  sign_in_url: "https://app.supermortgage.example/app", platform_postal_address: "PO Box 1, Testville TX 75001",
  channel: "email", sms: false,
};

export const VERSIONS_33_1: VersionInput[] = [
  V("NTC_SM_PARTNER_BOOK_INVITATION", INVITATION, INVITATION_RULES, INVITATION_SAMPLE, "partner_book.m3.v1 / 33.1 rule 4", "33.1 rule 4 / Outputs: the invitation to the provisioned account — partner as servicer, loan last four, sign-in address, code sentence, no rate/offer/figure, postal address; SMS variant with the STOP line, sent only with TCPA consent evidence"),
];
export const OVERRIDES_33_1: Record<string, Partial<NoticeTemplate>> = {
  // 33.1 rule 4: "channel policy `electronic_ok_without_esign`: the notice is about the account, not a disclosure" — decideChannel
  // then e-mails any recipient with an e-mail (consentId `policy:electronic_ok_without_esign`), no E-SIGN consent needed.
  NTC_SM_PARTNER_BOOK_INVITATION: { channelPolicy: "electronic_ok_without_esign", noticeClass: "account_relationship", citation: "15 U.S.C. §7702(17)(A)(v) (relationship message); 47 U.S.C. §227(b)(1)(A) (SMS only with consent); 33.1 rule 4", retention: "servicing_file", piiLevel: "medium" },
};
