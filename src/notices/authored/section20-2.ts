/**
 * §20.2 process-owned notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts) and
 * per-code channel/combination overrides. Spread by ../catalog.ts after the servicing files, so a version here
 * supersedes one there for the same code and effective date.
 *
 * NTC_REGZ_1026_24_REFI_OFFER — the trigger offer (email / mail / portal card): an advertisement (comment 2(a)(2)-1),
 *   so rule 4 applies — the APR stated as "annual percentage rate", the terms of repayment and whether the rate may
 *   increase whenever a payment or term is stated ((d)(2)), the taxes-and-insurance statement ((f)(3)), the approved
 *   no-fee phrasing (never "no cost"), "not a commitment to lend", "rates change daily", accurate source (MAP (o):
 *   the partner is the current lender; Supermortgage services the loan for it), the partner's NMLSR ID, no
 *   "guaranteed"/"pre-approved", no investor reference (B2-1.3-04), the CAN-SPAM footer on e-mail.
 * NTC_CANSPAM_7704_FOOTER — 15 U.S.C. 7704(a)(3), (a)(5): advertisement identification, a functioning opt-out, the
 *   sender's valid physical postal address, a functioning return address.
 * NTC_TCPA_64_1200_B_AI_VOICE_IDENT — the artificial-voice opening: identity at the beginning, the callback number,
 *   the interactive opt-out mechanism within two seconds, automation disclosed (20.3 overlay).
 * NTC_FCRA_615D_PRESCREEN_OPTOUT — 12 CFR 1022.54(c)–(d) short notice (front of page 1, ≥ 12-pt, set apart, the right
 *   to opt out and the toll-free number) and long notice headed "PRESCREEN & OPT-OUT NOTICE" (≥ 8-pt) with the
 *   §1681m(d) elements; only rendered when `marketing.prescreen_enabled`.
 * NTC_SM_AI_INTERACTION_DISCLOSURE — automation disclosed at the start of every voice/chat interaction, with the
 *   human hand-off phrase and the Utah/California/Colorado overlay line (20.3 applies the overlays).
 * Every sample is placeholder-only: fictional partner, numbers and addresses.
 */
import type { ContentRule, NoticeTemplate, VersionInput } from "../registry.ts";
import { V } from "./section01.ts";

const R = (rule_id: string, citation: string, kind: ContentRule["kind"], selector: string, message: string, extra: Partial<ContentRule> = {}): ContentRule => ({ rule_id, citation, kind, selector, severity: "block", message, ...extra });
const NO_INVESTOR = (id: string) => R(`${id}-no-investor-reference`, "Fannie Mae Selling Guide B2-1.3-04; 20.2 rule 7", "absence", "\\bFannie\\b|\\bFreddie\\b|\\bMBS\\b|\\bpool\\s*(?:no\\.?|number|#)|\\binvestor\\b", "no investor reference in a borrower-facing creative");
const NO_CLAIMS = (id: string) => R(`${id}-no-guaranteed-preapproved`, "12 CFR 1014.3(q), (r); 20.2 guardrails", "absence", "\\bguarantee[ds]?\\b|\\bpre-?approved\\b|\\bpreapproval\\b|\\bno[- ]cost\\b", "no \"guaranteed\", \"pre-approved\" or \"no-cost\" claim");

// ------------------------------------------------------------------ NTC_REGZ_1026_24_REFI_OFFER (rule 4)
export const REFI_OFFER_SOURCE = `{{#block "heading" page=1 y=0.04 pt=14 bold}}A refinance option on your current mortgage{{/block}}
{{#block "source" page=1 y=0.1 pt=11}}{{partner_name}}, NMLSR ID {{partner_nmlsr_id}}, is your current lender; Supermortgage services your loan for {{partner_name}}. This message is about the mortgage loan ending in {{account_last4}}.{{/block}}
{{#block "terms" page=1 y=0.18 pt=11}}Your current rate {{current_rate_pct}}% → offered rate {{offered_rate_pct}}% ({{apr_pct}}% annual percentage rate (APR)); {{term_payments}} monthly principal-and-interest payments of {{money pi_cents}}; {{#if fixed}}fixed rate for the full term — the annual percentage rate will not increase{{else}}adjustable rate — the annual percentage rate may increase after consummation{{/if}}. Payments do not include amounts for taxes and insurance premiums, and your actual payment obligation will be greater.{{/block}}
{{#block "costs" page=1 y=0.34 pt=11}}No lender fees and no third-party closing costs charged to you; those costs are paid by Supermortgage and reflected in the rate offered.{{/block}}
{{#block "commitment" page=1 y=0.42 pt=11}}This is not a commitment to lend. Rates change daily; the terms shown were available on {{date rate_sheet_date}} and are subject to change until you lock. All terms are subject to underwriting, appraisal and program eligibility.{{/block}}
{{#block "consent" page=1 y=0.52 pt=11}}{{#if invite_pewc}}Want a call or text? In your portal you can let {{partner_name}}, and Supermortgage on its behalf, call or text you at the number you enter using an automated system or an artificial or prerecorded voice about refinance offers. Consent is not a condition of any purchase or loan.{{/if}}{{/block}}
{{#block "footer" page=1 y=0.86 pt=9}}{{#if email_channel}}This is an advertisement from {{partner_name}} (the sender), sent by Supermortgage on its behalf. To stop receiving marketing e-mail, use this unsubscribe link: {{unsubscribe_link}}. {{partner_name}}, {{partner_postal_address}}.{{/if}}{{/block}}`;
export const REFI_OFFER_RULES: ContentRule[] = [
  R("apr-term", "12 CFR 1026.24(c): a rate stated as an \"annual percentage rate,\" using that term", "presence", "\\d+\\.\\d{3}% annual percentage rate \\(APR\\)", "the APR stated with the term \"annual percentage rate\""),
  R("apr-equal-prominence", "12 CFR 1026.24(f)(2): the APR with equal prominence and in close proximity to the rate", "layout", "terms", "rate and APR in the same block at ≥ 11-pt", { layout: { page: 1, minPt: 11 } }),
  R("d2-terms-of-repayment", "12 CFR 1026.24(d)(2)(ii): the terms of repayment reflecting the full obligation", "presence", "\\d{2,3} monthly principal-and-interest payments of \\$[\\d,]+\\.\\d{2}", "number and amount of payments"),
  R("d2-rate-variability", "12 CFR 1026.24(d)(2)(iii): the APR and whether it may increase", "presence", "annual percentage rate (will not increase|may increase)", "whether the rate may increase"),
  R("fixed-only-when-fixed", "12 CFR 1026.24(i)(1); 12 CFR 1014.3(g): \"fixed\" only for a fixed-rate product", "data_equality", "amortization", "amortization is fixed or arm and drives the \"fixed\" wording", { predicate: { in: [{ var: "amortization" }, ["fixed", "arm"]] } }),
  R("fixed-flag-matches", "12 CFR 1026.24(i)(1)", "conditional", "fixed", "the \"fixed\" statement appears only when amortization=fixed", { when: { var: "fixed" }, predicate: { "==": [{ var: "amortization" }, "fixed"] } }),
  R("f3-taxes-insurance", "12 CFR 1026.24(f)(3)(i)(C): payments do not include taxes and insurance premiums; the actual payment obligation will be greater", "presence", "do not include amounts for taxes and insurance premiums, and your actual payment obligation will be greater", "the taxes-and-insurance statement"),
  R("no-fee-phrasing", "20.2 rule 4: the approved phrasing — never \"no cost\"", "presence", "No lender fees and no third-party closing costs charged to you; those costs are paid by Supermortgage and reflected in the rate offered", "the approved no-fee phrasing"),
  R("not-a-commitment", "20.2 rule 4", "presence", "not a commitment to lend", "not a commitment to lend"),
  R("rates-change-daily", "20.2 rule 4 / edge cases: rates change daily", "presence", "Rates change daily", "rate validity statement"),
  R("source-accurate", "12 CFR 1014.3(o): source of the communication; 12 CFR 1026.24(i)(4)", "presence", "is your current lender; Supermortgage services your loan for", "the partner named as the current lender and SM as its servicer"),
  R("nmlsr-id", "COMAR 09.03.06.06 / state overlays: NMLS unique identifier in every advertisement", "presence", "NMLSR ID \\d+", "the partner's NMLSR ID"),
  R("no-temporary-rate-comparison", "12 CFR 1026.24(i)(2)", "absence", "\\b(?:introductory|teaser|temporary|promotional) rate\\b", "no comparison to a temporary rate"),
  R("no-government-claim", "12 CFR 1026.24(i)(3); 12 CFR 1014.3(n)", "absence", "\\bgovernment[- ](?:program|approved|backed|endorsed)\\b", "no government-association claim"),
  R("no-debt-elimination", "12 CFR 1026.24(i)(5); 12 CFR 1014.3(m)", "absence", "\\beliminate your debt\\b|\\bdebt elimination\\b", "no debt-elimination claim"),
  NO_CLAIMS("offer"), NO_INVESTOR("offer"),
  R("email-footer", "15 U.S.C. 7704(a)(5): the CAN-SPAM footer on e-mail", "conditional", "email_channel", "an e-mail carries the advertisement identification, opt-out link and postal address", { when: { var: "email_channel" }, predicate: { and: [{ present: "unsubscribe_link" }, { present: "partner_postal_address" }] } }),
  R("offered-below-current", "20.1 rule 5 / 20.2 rule 4: the offer is a rate reduction", "data_equality", "offered_rate_pct", "the offered rate is below the current rate", { predicate: { "<": [{ var: "offered_rate_pct" }, { var: "current_rate_pct" }] } }),
];
/** Worked example 1 — the fixture offer, Fri Oct 2, 2026: 7.000 % → 6.125 % (6.155 % APR), 360 × $3,402.62, fixed. */
export const REFI_OFFER_SAMPLE = { partner_name: "Partner Bank, N.A.", partner_nmlsr_id: "123456", account_last4: "4242", current_rate_pct: "7.000", offered_rate_pct: "6.125", apr_pct: "6.155", term_payments: 360, pi_cents: 340_262n, fixed: true, amortization: "fixed", rate_sheet_date: "2026-10-02",
  invite_pewc: true, email_channel: true, unsubscribe_link: "https://portal.example.com/marketing/unsubscribe?token=sample", partner_postal_address: "100 Example Way, Anytown, AZ 85000" };

// ------------------------------------------------------------------ NTC_CANSPAM_7704_FOOTER
export const CANSPAM_FOOTER_SOURCE = `{{#block "footer" page=1 y=0.9 pt=9}}This e-mail is an advertisement from {{partner_name}} (the sender), sent by Supermortgage on its behalf. You may opt out of further marketing e-mail at any time by using this unsubscribe link: {{unsubscribe_link}}; opt-out requests are honored within 10 business days. {{partner_name}}, {{partner_postal_address}}. Replies to {{return_email}} reach us.{{/block}}`;
export const CANSPAM_FOOTER_RULES: ContentRule[] = [
  R("ad-identified", "15 U.S.C. 7704(a)(5)(A)(i): clear and conspicuous identification that the message is an advertisement or solicitation", "presence", "is an advertisement", "advertisement identification"),
  R("optout-mechanism", "15 U.S.C. 7704(a)(3)(A), (a)(5)(A)(ii): a functioning opt-out mechanism and notice of it", "presence", "unsubscribe link: \\S+", "the unsubscribe link"),
  R("optout-10bd", "15 U.S.C. 7704(a)(4)(A): honored within 10 business days", "presence", "honored within 10 business days", "the honoring period"),
  R("postal-address", "15 U.S.C. 7704(a)(5)(A)(iii): a valid physical postal address of the sender", "presence", "\\d+ [A-Za-z0-9.' -]+, [A-Za-z.' -]+, [A-Z]{2} \\d{5}", "the sender's postal address"),
  R("return-address", "15 U.S.C. 7704(a)(3)(A): a functioning return electronic mail address", "presence", "[\\w.+-]+@[\\w.-]+\\.[a-z]{2,}", "a return e-mail address"),
  R("sender-named", "15 U.S.C. 7704(a)(1): header information not misleading; the partner is the sender", "data_equality", "partner_name", "the partner is named as the sender", { predicate: { present: "partner_name" } }),
  NO_CLAIMS("footer"), NO_INVESTOR("footer"),
];
export const CANSPAM_FOOTER_SAMPLE = { partner_name: "Partner Bank, N.A.", unsubscribe_link: "https://portal.example.com/marketing/unsubscribe?token=sample", partner_postal_address: "100 Example Way, Anytown, AZ 85000", return_email: "offers@example.com" };

// ------------------------------------------------------------------ NTC_TCPA_64_1200_B_AI_VOICE_IDENT
export const AI_VOICE_IDENT_SOURCE = `{{#block "ident" page=1 y=0.0 pt=11 bold}}This is an automated call from Supermortgage on behalf of {{partner_name}}, your mortgage lender, about a refinance offer.{{/block}}
{{#block "optout" page=1 y=0.02 pt=11}}To stop these calls, press 1 or say "do not call" at any time and we will add your number to our do-not-call list.{{/block}}
{{#block "callback" page=1 y=0.05 pt=11}}You can reach {{partner_name}} through Supermortgage at {{callback_number}}.{{/block}}
{{#block "automation" page=1 y=0.08 pt=11}}You are speaking with an automated assistant, not a person; say "representative" at any time to reach a person.{{/block}}`;
export const AI_VOICE_IDENT_RULES: ContentRule[] = [
  R("identity-at-beginning", "47 CFR 64.1200(b)(1): at the beginning of the message, the identity of the business responsible for initiating the call", "layout", "ident", "the identification is the first block", { layout: { page: 1, maxYFraction: 0.01 } }),
  R("identity-text", "47 CFR 64.1200(b)(1); TSR §310.4(d): the seller's identity and the sales purpose", "presence", "^This is an automated call from Supermortgage on behalf of .+, your mortgage lender, about a refinance offer", "identity, purpose and nature at the start"),
  R("callback-number", "47 CFR 64.1200(b)(2): the telephone number of the business during or after the message", "presence", "\\(?\\d{3}\\)?[ .-]?\\d{3}[ .-]?\\d{4}", "a callback number"),
  R("optout-mechanism", "47 CFR 64.1200(b)(3): an automated, interactive voice- and/or key-press-activated opt-out mechanism", "presence", "press 1 or say \"do not call\"", "the interactive opt-out mechanism"),
  R("optout-within-2s", "47 CFR 64.1200(b)(3): within two seconds of providing the identification information", "data_range", "optout_offer_seconds", "the opt-out is offered within 2 seconds", { range: { min: 0, max: 2 } }),
  R("automation-disclosed", "20.2 guardrails / 20.3 NTC_SM_AI_INTERACTION_DISCLOSURE: disclose automation at the start of every voice interaction", "presence", "automated assistant, not a person", "automation disclosed"),
  R("never-a-person", "20.2 edge cases: the voice model never says it is a person", "absence", "\\bI am a (?:person|human)\\b|\\bI'm a real person\\b", "no claim to be a person"),
  NO_CLAIMS("voice"), NO_INVESTOR("voice"),
];
export const AI_VOICE_IDENT_SAMPLE = { partner_name: "Partner Bank, N.A.", callback_number: "(800) 555-0100", optout_offer_seconds: 2 };

// ------------------------------------------------------------------ NTC_FCRA_615D_PRESCREEN_OPTOUT (rule 9; flag-gated)
export const PRESCREEN_OPTOUT_SOURCE = `{{#block "short_notice" page=1 y=0.02 pt=12 bold}}You can choose to stop receiving "prescreened" offers of credit from this and other companies by calling toll-free {{optout_tollfree}}. See the PRESCREEN & OPT-OUT NOTICE on the next page for more information about prescreened offers.{{/block}}
{{#block "long_heading" page=2 y=0.05 pt=10 bold}}PRESCREEN & OPT-OUT NOTICE{{/block}}
{{#block "long_notice" page=2 y=0.1 pt=8}}This "prescreened" offer of credit is based on information in your credit report indicating that you meet certain criteria set before you were selected. The offer will be honored only if you continue to meet those criteria, including providing acceptable property as collateral; otherwise the credit may be denied. If you do not want to receive prescreened offers of credit from this and other companies, call the consumer reporting agencies toll-free at {{optout_tollfree}} or write to {{optout_address}}. You may choose to opt out for five years or permanently; a permanent election requires a signed form the agencies provide.{{/block}}`;
export const PRESCREEN_OPTOUT_RULES: ContentRule[] = [
  R("short-front-page-12pt", "12 CFR 1022.54(c): the short notice on the front side of the first page of the principal promotional document, in type no smaller than 12-point, set apart", "layout", "short_notice", "short notice on page 1, ≥ 12-pt, bold, at the top", { layout: { page: 1, minPt: 12, bold: true, maxYFraction: 0.1 } }),
  R("short-right-to-opt-out", "12 CFR 1022.54(c)(1): the consumer's right to opt out and the toll-free number", "presence", "stop receiving \"prescreened\" offers of credit from this and other companies by calling toll-free", "the right to opt out"),
  R("short-tollfree", "12 CFR 1022.54(c)(1)", "presence", "toll-free (?:1-)?8\\d\\d[ .-]?\\d{3}[ .-]?\\d{4}", "the toll-free number in the short notice"),
  R("short-refers-to-long", "12 CFR 1022.54(c)(1)(iii): a reference to the long notice", "presence", "See the PRESCREEN & OPT-OUT NOTICE", "reference to the long notice"),
  R("long-heading", "12 CFR 1022.54(d)(1): the heading \"PRESCREEN & OPT-OUT NOTICE\"", "presence", "PRESCREEN & OPT-OUT NOTICE", "the long notice heading"),
  R("long-8pt", "12 CFR 1022.54(d)(2): the long notice in type no smaller than 8-point", "layout", "long_notice", "long notice ≥ 8-pt", { layout: { minPt: 8 } }),
  R("long-criteria-and-denial", "15 U.S.C. 1681m(d)(1)(A)–(C): the selection criteria and that credit may be denied if the criteria are not met", "presence", "meet certain criteria.*honored only if you continue to meet those criteria.*may be denied", "criteria and possible-denial statements"),
  R("long-election", "15 U.S.C. 1681m(d)(1)(D)–(E); 12 CFR 1022.54(d)(1)(v): the five-year or permanent election and the address", "presence", "opt out for five years or permanently", "the five-year / permanent election"),
  R("flag-on", "20.2 rule 9: prescreening only when `marketing.prescreen_enabled`", "data_equality", "prescreen_enabled", "rendered only under the feature flag", { predicate: { "==": [{ var: "prescreen_enabled" }, true] } }),
  R("criteria-frozen", "15 U.S.C. 1681a(l): criteria established before selection (firm offer)", "data_equality", "criteria_frozen", "the firm-offer criteria were frozen before the list pull", { predicate: { "==": [{ var: "criteria_frozen" }, true] } }),
  NO_INVESTOR("prescreen"),
];
export const PRESCREEN_OPTOUT_SAMPLE = { optout_tollfree: "1-888-555-0199", optout_address: "Opt-Out Processing, PO Box 000, Anytown, AZ 85000", prescreen_enabled: true, criteria_frozen: true };

// ------------------------------------------------------------------ NTC_SM_AI_INTERACTION_DISCLOSURE (20.3 applies the overlays)
export const AI_DISCLOSURE_SOURCE = `{{#block "disclosure" page=1 y=0.0 pt=11 bold}}You are interacting with an automated assistant operated by Supermortgage on behalf of {{partner_name}}. It is not a person. {{#if voice}}Say{{else}}Type{{/if}} "representative" at any time to reach a licensed person.{{#if state_overlay_text}} {{state_overlay_text}}{{/if}} (automated-assistance disclosure v{{disclosure_version}}){{/block}}`;
export const AI_DISCLOSURE_RULES: ContentRule[] = [
  R("first-thing", "20.3 SM_AI_INTERACTION_DISCLOSURE_GATE: delivered before the first substantive answer", "layout", "disclosure", "the disclosure is the first block", { layout: { page: 1, maxYFraction: 0.01 } }),
  R("automation", "20.2 guardrails; 12 U.S.C. 5531 (UDAAP): a consumer may not mistake the AI for a human", "presence", "automated assistant operated by Supermortgage on behalf of", "automation and the operator disclosed"),
  R("not-a-person", "20.2 edge cases / Utah AI Policy Act overlay", "presence", "It is not a person", "the not-a-person statement"),
  R("human-handoff", "20.2 escalations: `human_agent` on request", "presence", "\"representative\" at any time to reach a licensed person", "the hand-off phrase"),
  R("state-overlay", "20.3 UT/CA/CO overlays", "conditional", "state", "a state overlay line is present for UT / CA / CO consumers", { when: { in: [{ var: "state" }, ["UT", "CA", "CO"]] }, predicate: { present: "state_overlay_text" } }),
  R("version", "20.3-T1: the disclosure version is logged (v1.2)", "presence", "disclosure v\\d+\\.\\d+", "the disclosure version"),
  NO_CLAIMS("ai"), NO_INVESTOR("ai"),
];
export const AI_DISCLOSURE_SAMPLE = { partner_name: "Partner Bank, N.A.", voice: true, state: "UT", state_overlay_text: "Utah law requires us to tell you clearly that you are interacting with generative AI.", disclosure_version: "1.2" };

export const VERSIONS_20_2: VersionInput[] = [
  V("NTC_REGZ_1026_24_REFI_OFFER", REFI_OFFER_SOURCE, REFI_OFFER_RULES, REFI_OFFER_SAMPLE, "sm.solicitation.2026.v1", "12 CFR 1026.24(c), (d), (f), (i); 12 CFR 1014.3; 15 U.S.C. 7704(a)(5); B2-1.3-04; 20.2 rule 4 and worked example 1 (Fri Oct 2, 2026)"),
  V("NTC_CANSPAM_7704_FOOTER", CANSPAM_FOOTER_SOURCE, CANSPAM_FOOTER_RULES, CANSPAM_FOOTER_SAMPLE, "sm.solicitation.2026.v1", "15 U.S.C. 7704(a)(1), (a)(3)(A), (a)(4)(A), (a)(5)(A); 20.2 rule 1 (e-mail)"),
  V("NTC_TCPA_64_1200_B_AI_VOICE_IDENT", AI_VOICE_IDENT_SOURCE, AI_VOICE_IDENT_RULES, AI_VOICE_IDENT_SAMPLE, "sm.solicitation.2026.v1", "47 CFR 64.1200(b)(1)–(3); TSR §310.4(d); 20.2 rule 1 (AI voice) and T2"),
  V("NTC_FCRA_615D_PRESCREEN_OPTOUT", PRESCREEN_OPTOUT_SOURCE, PRESCREEN_OPTOUT_RULES, PRESCREEN_OPTOUT_SAMPLE, "sm.solicitation.2026.v1", "15 U.S.C. 1681m(d); 12 CFR 1022.54(c)–(d) (Reg V; 16 CFR 642.3 is the motor-vehicle-dealer twin); 20.2 rule 9 and T11"),
  V("NTC_SM_AI_INTERACTION_DISCLOSURE", AI_DISCLOSURE_SOURCE, AI_DISCLOSURE_RULES, AI_DISCLOSURE_SAMPLE, "sm.solicitation.2026.v1", "20.2 guardrails (disclose automation at the start of every voice/chat interaction); 20.3 SM_AI_INTERACTION_DISCLOSURE_GATE and UT/CA/CO overlays; 12 U.S.C. 5531"),
];
export const OVERRIDES_20_2: Record<string, Partial<NoticeTemplate>> = {
  NTC_REGZ_1026_24_REFI_OFFER: { channelPolicy: "electronic_ok_without_esign", noticeClass: "marketing", separateDocument: false, mayCombineWith: ["NTC_CANSPAM_7704_FOOTER", "NTC_FCRA_615D_PRESCREEN_OPTOUT"], retention: "regn_1014_5_24m", piiLevel: "medium",
    citation: "12 CFR 1026.24 (advertisement — comment 2(a)(2)-1; not a required disclosure, so no E-SIGN consent needed; CAN-SPAM applies to e-mail); 12 CFR 1014.5 24-month archive" },
  NTC_CANSPAM_7704_FOOTER: { channelPolicy: "electronic_ok_without_esign", noticeClass: "marketing", separateDocument: false, mayCombineWith: ["NTC_REGZ_1026_24_REFI_OFFER"], retention: "regn_1014_5_24m", piiLevel: "low", citation: "15 U.S.C. 7704(a)(3), (a)(5) — the footer of every commercial e-mail" },
  NTC_TCPA_64_1200_B_AI_VOICE_IDENT: { channelPolicy: "electronic_ok_without_esign", noticeClass: "marketing", separateDocument: true, mayCombineWith: ["NTC_SM_AI_INTERACTION_DISCLOSURE"], retention: "regn_1014_5_24m", piiLevel: "low", citation: "47 CFR 64.1200(b) — the artificial-voice opening (a MAP Rule sales script; 24 months)" },
  NTC_FCRA_615D_PRESCREEN_OPTOUT: { channelPolicy: "esign_or_mail", noticeClass: "marketing", separateDocument: false, mayCombineWith: ["NTC_REGZ_1026_24_REFI_OFFER"], retention: "ecoa_25m", piiLevel: "medium", citation: "12 CFR 1022.54(c)–(d); Reg B §1002.12(b)(7) 25-month retention of prescreened solicitations" },
  NTC_SM_AI_INTERACTION_DISCLOSURE: { channelPolicy: "electronic_ok_without_esign", noticeClass: "marketing", separateDocument: false, mayCombineWith: ["NTC_TCPA_64_1200_B_AI_VOICE_IDENT"], retention: "sm_lead_36m", piiLevel: "low", citation: "20.3 disclosure-first rule; Utah AI Policy Act, California CPPA ADMT, Colorado SB 26-189 overlays" },
};
