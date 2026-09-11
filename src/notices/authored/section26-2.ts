/**
 * §26.2 process-owned notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts) and
 * per-code channel/combination overrides. Spread by ../catalog.ts after the servicing files, so a version here
 * supersedes one there for the same code and effective date.
 *
 * `NTC_SM_CLOSING_APPOINTMENT` — the borrower's closing-day instructions: appointment date/time and location (or the
 * platform link for RON/IPEN/hybrid), who attends (signers, notary, settlement agent, witnesses where the state requires
 * them), government-issued ID requirements, identity-proofing / KBA expectations for RON (credential analysis + KBA per
 * A2-4.1-03; Texas 1 TAC §87.70: five questions in two minutes, 80 %, one retake), the paper option (A2-4.1-03: "Under
 * no circumstances may a borrower be required to use electronic records"; "A lender may not require a borrower to use
 * remote notarization") with the right to stop and switch to paper before signing without penalty, the Texas 50(a)(6)
 * office address (§50(a)(6)(N) — lender, attorney or title-company office only), the automation disclosure and the
 * e-consent scope. E-delivered under the closing-package consent or mailed.
 */
import type { ContentRule, NoticeTemplate, VersionInput } from "../registry.ts";
import { V } from "./section01.ts";

const R = (rule_id: string, citation: string, kind: ContentRule["kind"], selector: string, message: string, extra: Partial<ContentRule> = {}): ContentRule => ({ rule_id, citation, kind, selector, severity: "block", message, ...extra });
const present = (...paths: string[]): Record<string, unknown> => ({ and: paths.map((p) => ({ present: p })) });

// ------------------------------------------------------------------ NTC_SM_CLOSING_APPOINTMENT
export const CLOSING_APPOINTMENT_SOURCE = `{{#block "heading" page=1 y=0.04 pt=14 bold}}YOUR CLOSING APPOINTMENT{{/block}}
{{#block "ref" page=1 y=0.09 pt=10}}{{date notice_date}}. {{borrower_names}} — loan application {{application_id}} with {{lender_name}}. Property: {{property_address}}. Prepared by {{fulfillment_contact}} on behalf of the Lender.{{/block}}
{{#block "when" page=1 y=0.15 pt=12 bold}}When: {{appointment_local}} ({{appointment_time_zone}}). Closing type: {{closing_type_label}}.{{/block}}
{{#block "where" page=1 y=0.2 pt=11}}{{#if electronic}}Where: online. Your signing link: {{platform_link}} (session {{platform_session_ref}}). Please join from a computer or tablet with a camera, microphone and a stable connection; {{#if ron}}your notary, commissioned in {{notary_state}}, will join by live audio-video from within {{notary_state}}{{else}}the notary will be present with you at {{location_name}}, {{location_address}}{{/if}}.{{else}}Where: {{location_name}}, {{location_address}}.{{/if}}{{/block}}
{{#block "who" page=1 y=0.3 pt=11}}Who attends: {{#each attendees}}{{this}}; {{/each}}{{#if witness_count}}This state requires {{witness_count}} witness(es) on the security instrument; {{witness_arrangement}}.{{/if}}{{/block}}
{{#block "id" page=1 y=0.38 pt=11 bold}}Identification: every signer must present a valid, unexpired government-issued photo ID ({{id_examples}}).{{#if ron}} For the remote online notarization your ID will be photographed and analyzed for authenticity (credential analysis), and you will answer a short set of identity questions drawn from public records: {{kba_questions}} questions in {{kba_minutes}} minutes, {{kba_pass_pct}}% correct to pass, with one retake permitted{{#if kba_retake_window_hours}} within {{kba_retake_window_hours}} hours{{/if}}. If identity proofing cannot be completed, the session ends and we reschedule an in-person or paper closing at no cost to you.{{/if}}{{/block}}
{{#block "paper_option" page=1 y=0.52 pt=11 bold}}Your paper option: you are never required to sign electronically or to use remote notarization. You may choose an in-person closing with paper documents at any time before you sign, without penalty or delay caused by us, by calling {{team_phone}}. Your consent to electronic records covers the closing package{{#if consent_captured_on}} (consent given {{date consent_captured_on}}){{/if}} and may be withdrawn at any time.{{/block}}
{{#block "texas" page=1 y=0.64 pt=11}}{{#if tx_50a6}}Texas home equity loan: Texas law requires this loan to close only at a permanent office of the lender, an attorney or a title company — never at your home and never remotely. Your closing office: {{tx_office_name}}, {{tx_office_address}}. You may not close before {{date tx_earliest_closing_date}}.{{/if}}{{/block}}
{{#block "documents" page=1 y=0.72 pt=11}}What you will sign: {{#each documents}}{{this}}; {{/each}}Bring: {{bring_items}}. Funds due at closing, if any, are wired per the verified instructions on your Closing Disclosure — never per instructions received by e-mail.{{/block}}
{{#block "automation" page=1 y=0.82 pt=10}}This appointment was arranged with the help of automated systems operated by {{fulfillment_contact}}. A licensed notary performs every notarial act and only you apply your signatures; the system records and never signs. You may ask to speak with a person at any time: {{team_phone}}.{{/block}}
{{#block "contact" page=1 y=0.9 pt=10}}Questions: {{team_name}}, {{team_phone}} (toll-free {{toll_free}}), {{servicer_address}}, {{website}}.{{/block}}`;
export const CLOSING_APPOINTMENT_RULES: ContentRule[] = [
  R("heading", "26.2 closing-appointment notice", "presence", "^YOUR CLOSING APPOINTMENT", "title"),
  R("identifiers", "26.2: borrower, application, lender, property", "data_equality", "borrower_names,application_id,lender_name,property_address,fulfillment_contact", "borrower, application, lender, property and fulfillment contact present", { predicate: present("borrower_names", "application_id", "lender_name", "property_address", "fulfillment_contact") }),
  R("when", "26.2: appointment date/time with time zone and closing type", "presence", "When: .+ \\([A-Za-z/_ ]+\\)\\. Closing type: (Remote online notarization|In-person electronic|Hybrid|Paper)", "appointment time and closing type"),
  R("when-prominent", "26.2: the appointment time is bold on page 1", "layout", "when", "bold ≥ 12pt on page 1", { layout: { page: 1, bold: true, minPt: 12 } }),
  R("platform-link", "26.2: RON/IPEN/hybrid — platform link and session reference", "conditional", "platform_link,platform_session_ref", "platform link and session for an electronic closing", { when: { "==": [{ var: "electronic" }, true] }, predicate: present("platform_link", "platform_session_ref") }),
  R("location", "26.2: paper closing — a physical location", "conditional", "location_name,location_address", "location for a paper closing", { when: { "==": [{ var: "electronic" }, false] }, predicate: present("location_name", "location_address") }),
  R("who-attends", "26.2: signers, notary, settlement agent, witnesses", "presence", "Who attends: .+;", "attendee list"),
  R("id-requirements", "A2-4.1-03: government-issued identification credential", "presence", "valid, unexpired government-issued photo ID", "ID requirements"),
  R("kba-expectations", "A2-4.1-03 (credential analysis + KBA); 1 TAC §87.70 (≥5 questions, 2 minutes, ≥80 %, one retake within 24 hours)", "conditional", "kba_questions,kba_minutes,kba_pass_pct", "KBA parameters stated for RON", { when: { "==": [{ var: "ron" }, true] }, predicate: { and: [{ ">=": [{ var: "kba_questions" }, 5] }, { "<=": [{ var: "kba_minutes" }, 2] }, { ">=": [{ var: "kba_pass_pct" }, 80] }] } }),
  R("kba-text", "1 TAC §87.70", "presence", "identity questions.*questions in \\d+ minutes, \\d+% correct to pass, with one retake|Where: [^.]+\\.", "KBA expectations (RON) or a physical location"),
  R("paper-option", "A2-4.1-03: 'Under no circumstances may a borrower be required to use electronic records'; 'A lender may not require a borrower to use remote notarization'; E-SIGN §101(c)(1)(B)(i)", "presence", "never required to sign electronically or to use remote notarization", "the paper option"),
  R("paper-option-prominent", "26.2: the paper option is bold on page 1", "layout", "paper_option", "bold ≥ 11pt on page 1", { layout: { page: 1, bold: true, minPt: 11 } }),
  R("switch-before-signing", "26.2 AI agent design: the borrower may stop and switch to paper at any time before signing without penalty", "presence", "at any time before you sign, without penalty", "the right to switch to paper"),
  R("consent-withdrawable", "E-SIGN §101(c)(1)(B)(i): withdrawal procedure", "presence", "may be withdrawn at any time", "withdrawal statement"),
  R("texas-office", "Tex. Const. art. XVI §50(a)(6)(N); 7 TAC §153.15: lender/attorney/title-company office only", "conditional", "tx_office_name,tx_office_address,tx_earliest_closing_date", "TX office and earliest closing date when tx_50a6", { when: { "==": [{ var: "tx_50a6" }, true] }, predicate: present("tx_office_name", "tx_office_address", "tx_earliest_closing_date") }),
  R("texas-never-remote", "§50(a)(6)(N)", "conditional", "tx_50a6", "TX 50(a)(6) is never electronic", { when: { "==": [{ var: "tx_50a6" }, true] }, predicate: { "==": [{ var: "electronic" }, false] } }),
  R("automation-disclosed", "26.2 AI agent design: automation disclosed in the appointment notice; the platform records, never signs", "presence", "automated systems.*the system records and never signs", "automation disclosure"),
  R("wire-no-email", "26.3 BEC controls", "presence", "never per instructions received by e-mail", "e-mail wire refusal"),
  R("contact", "contact block with a telephone number", "presence", "Questions: .*\\(\\d{3}\\) \\d{3}-\\d{4}", "contact block"),
  R("no-threat", "UDAP", "absence", "(penalty for choosing paper|must sign electronically)", "no pressure toward electronic records"),
];
/** Worked example 1: the Phoenix, AZ refinance RON session Fri Nov 6, 2026 14:00 MST — borrower and non-borrowing spouse on title; Arizona-commissioned notary in Arizona; Texas 1 TAC §87.70 KBA parameters applied as the default. */
export const CLOSING_APPOINTMENT_SAMPLE: Record<string, unknown> = {
  notice_date: "2026-11-02", borrower_names: "R. Borrower and S. Borrower", application_id: "APP-REFI-1", lender_name: "Partner Bank", fulfillment_contact: "Supermortgage LLC (fulfillment and servicing)", property_address: "1 Palm Ln, Phoenix, AZ 85001",
  appointment_local: "Friday, November 6, 2026 at 2:00 PM", appointment_time_zone: "America/Phoenix", closing_type_label: "Remote online notarization (RON) with an electronic note", electronic: true, ron: true, tx_50a6: false,
  platform_link: "https://eclose.example/s/RON-CLS-1-1", platform_session_ref: "RON-CLS-1-1", notary_state: "Arizona", location_name: "", location_address: "",
  attendees: ["R. Borrower (borrower — signs the electronic note and the deed of trust)", "S. Borrower (spouse on title — signs the deed of trust)", "Arizona notary public (remote, by live audio-video)", "Desert Escrow Company (settlement agent)"], witness_count: 0, witness_arrangement: "",
  id_examples: "driver license, state ID card or passport", kba_questions: 5, kba_minutes: 2, kba_pass_pct: 80, kba_retake_window_hours: 24, consent_captured_on: "2026-10-06",
  documents: ["Electronic Note (Form 3200e)", "Deed of Trust (Form 3003)", "Final Uniform Residential Loan Application", "Notice of Right to Cancel (two copies each)", "Closing Disclosure acknowledgment"], bring_items: "your photo ID and, if applicable, proof of homeowner's insurance",
  team_name: "Closing Team", team_phone: "(800) 555-0199", toll_free: "(800) 555-0199", servicer_address: "PO Box 1, Testville TX 75001", website: "https://www.supermortgage.example",
};
export const VERSIONS_26_2: VersionInput[] = [
  V("NTC_SM_CLOSING_APPOINTMENT", CLOSING_APPOINTMENT_SOURCE, CLOSING_APPOINTMENT_RULES, CLOSING_APPOINTMENT_SAMPLE, "sm.closing_appointment.2026-09.v1", "Selling Guide A2-4.1-03 (electronic records; RON identity proofing; paper option); SEL-2026-05; 15 U.S.C. 7001(c); 1 TAC §87.70; Tex. Const. art. XVI §50(a)(6)(N)"),
];
export const OVERRIDES_26_2: Record<string, Partial<NoticeTemplate>> = {
  NTC_SM_CLOSING_APPOINTMENT: { channelPolicy: "esign_or_mail", noticeClass: "closing", separateDocument: true, mayCombineWith: [], retention: "fnma_loan_file_life_plus_4y", citation: "26.2 closing-appointment notice; Selling Guide A2-4.1-03; E-SIGN §101(c)", piiLevel: "medium" },
};
