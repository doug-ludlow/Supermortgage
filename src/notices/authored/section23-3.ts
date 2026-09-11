/**
 * §23.3 process-owned notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts) and
 * per-code channel/combination overrides. Spread by ../catalog.ts after the servicing files, so a version here
 * supersedes one there for the same code and effective date.
 *
 * `NTC_REGB_1002_9_APPROVAL` — the conditional-approval / commitment letter: the express notification of approval under
 * §1002.9(a)(1)(i) (comment 9(a)(1)-2 "Notification of approval may be express or by implication"), issued in the
 * partner's name as creditor with its NMLSR ID and the MLO of record (§1026.36(g) consistency with the LE/CD); content:
 * the terms approved, the borrower-facing conditions list (never DU wording or message ids — 23.2 guardrail), the
 * validity date (`decisions.valid_until`), the statement that the approval is conditioned on the listed items and on no
 * adverse change. No ECOA notice content is required on an approval (§1002.9(a)(2) applies to adverse action /
 * counteroffer — 21.6's notices). Channels: e-delivery under E-SIGN consent (21.1) or mail; retention regb_25m.
 * State commitment-letter content rules (e.g. NY 3 NYCRR Part 38) are 31.1/21.3's matrix — UNVERIFIED in the spec.
 */
import type { ContentRule, NoticeTemplate, VersionInput } from "../registry.ts";
import { V } from "./section01.ts";

const R = (rule_id: string, citation: string, kind: ContentRule["kind"], selector: string, message: string, extra: Partial<ContentRule> = {}): ContentRule => ({ rule_id, citation, kind, selector, severity: "block", message, ...extra });
const present = (...paths: string[]): Record<string, unknown> => ({ and: paths.map((p) => ({ present: p })) });
/** DU output never reaches the borrower (23.2 guardrail; Fannie Mae-confidential findings). */
const DU_WORDING = "Desktop Underwriter|\\bDU\\b|Approve/Eligible|Approve/Ineligible|Refer with Caution|underwriting findings";

export const APPROVAL_SOURCE = `{{#block "heading" page=1 y=0.04 pt=14 bold}}CONDITIONAL APPROVAL OF YOUR MORTGAGE APPLICATION{{/block}}
{{#block "parties" page=1 y=0.09 pt=10}}Date: {{date notice_date}}. Applicant: {{applicant_name}}. Application {{application_id}}. Property: {{property_address}}.{{/block}}
{{#block "creditor" page=1 y=0.13 pt=10}}Lender (creditor): {{creditor_name}}, NMLSR ID {{creditor_nmlsr_id}}, {{creditor_address}}. Mortgage loan originator of record: {{mlo_name}}, NMLSR ID {{mlo_nmlsr_id}}.{{/block}}
{{#block "approval" page=1 y=0.18 pt=11 bold}}{{creditor_name}} has approved your application for a mortgage loan on the terms below, subject to the conditions listed in this letter.{{/block}}
{{#block "terms" page=1 y=0.24 pt=11}}Terms approved: loan amount {{money terms.loan_amount_cents}}; note rate {{terms.note_rate_pct}} %; term {{terms.term_months}} months; product {{terms.product}}.{{/block}}
{{#block "conditions" page=1 y=0.32 pt=11}}This approval is conditioned upon the following items ({{conditions_count}}): {{#each conditions}}({{@index}}) {{this}} {{/each}}{{/block}}
{{#block "validity" page=1 y=0.62 pt=11}}This approval is valid until {{date valid_until}}. It is conditioned on the items listed above and on no adverse change in your credit, income, assets, employment or the property before closing. If a condition is not met or an adverse change occurs, {{creditor_name}} will notify you in writing of any change in the decision.{{/block}}
{{#block "closing" page=1 y=0.74 pt=10}}Questions about this letter or the conditions: contact {{creditor_name}} at {{creditor_address}}. This letter is retained for 25 months ({{retention_class}}).{{/block}}`;

export const APPROVAL_RULES: ContentRule[] = [
  R("creditor-identity", "12 CFR 1002.9(a)(1)(i); 23.3 rule 2: the letter states the partner as creditor with its NMLSR ID", "data_equality", "creditor_name,creditor_nmlsr_id,creditor_address", "the creditor (partner) name, NMLSR ID and address are present", { predicate: present("creditor_name", "creditor_nmlsr_id", "creditor_address") }),
  R("creditor-named", "23.3 capacity: the letter is issued in the partner's name; SM never represents itself as the creditor", "presence", "Lender \\(creditor\\): .+, NMLSR ID \\d+", "the lender line names the creditor with an NMLSR ID"),
  R("mlo-of-record", "12 CFR 1026.36(g) (consistency with the LE/CD); 23.3 rule 2", "data_equality", "mlo_name,mlo_nmlsr_id", "the MLO of record and NMLSR ID are present", { predicate: present("mlo_name", "mlo_nmlsr_id") }),
  R("express-approval", "12 CFR 1002.9(a)(1)(i); comment 9(a)(1)-2: express notification of approval", "presence", "has approved your application", "the express approval statement"),
  R("terms-approved", "23.3 data model: `NTC_REGB_1002_9_APPROVAL` content — terms approved", "data_equality", "terms.loan_amount_cents,terms.note_rate_pct,terms.term_months", "loan amount, note rate and term are present", { predicate: present("terms.loan_amount_cents", "terms.note_rate_pct", "terms.term_months") }),
  R("conditions-listed", "23.3 rule 2: the letter lists the borrower-facing conditions", "data_range", "conditions_count", "at least one condition is listed", { range: { min: 1 } }),
  R("conditioned-statement", "23.3 data model: statement that the approval is conditioned on the listed items and on no adverse change", "presence", "conditioned on the items listed above and on no adverse change", "the conditioned-approval statement"),
  R("validity-date", "23.3 rule 2: `valid_until` = min(credit expiry, lock expiry, valuation expiry, DU close-by, 90 days)", "data_equality", "valid_until", "the validity date is present", { predicate: { and: [{ present: "valid_until" }, { matches: ["valid_until", "^\\d{4}-\\d{2}-\\d{2}$"] }] } }),
  R("validity-stated", "23.3 rule 2", "presence", "This approval is valid until", "the validity date is stated"),
  R("no-du-wording", "23.2 guardrail 'never present DU output to the borrower'; DU findings are Fannie Mae-confidential", "absence", DU_WORDING, "no DU wording or recommendation text reaches the borrower"),
  R("no-adverse-content", "12 CFR 1002.9(a)(2): the ECOA statement of reasons belongs to adverse action / counteroffer notices (21.6), not to an approval", "absence", "Principal reason\\(s\\) for the action taken|has been denied", "no adverse-action content on an approval letter"),
  R("approval-prominent", "23.3 audit: the approval statement is bold on page 1", "layout", "approval", "the approval statement is bold on page 1", { layout: { page: 1, bold: true, minPt: 11, maxYFraction: 0.25 } }),
];
/** Worked example 1: refinance fixture — Approve/Eligible Tue Oct 6, 2026; letter e-delivered Wed Oct 7, 2026; valid until Sat Nov 21, 2026 (lock expiry, 45 days from Oct 7). */
export const APPROVAL_SAMPLE: Record<string, unknown> = {
  creditor_name: "Partner Bank", creditor_nmlsr_id: "123456", creditor_address: "100 Partner Plaza, Phoenix, AZ 85004", mlo_name: "M. Originator", mlo_nmlsr_id: "987654", applicant_name: "R. Borrower", application_id: "APP-REFI-560K", property_address: "1 Palm Ln, Phoenix, AZ 85001",
  notice_date: "2026-10-07", terms: { loan_amount_cents: 56_000_000n, note_rate_pct: "6.125", term_months: 360, product: "30-year fixed rate, limited cash-out refinance" },
  conditions: ["Your lender needs your most recent pay stub covering 30 days and your W-2 for the most recent year.", "Your lender needs your two most recent statements for each account used for closing funds.", "Your lender needs the declaration page of your homeowner's insurance policy showing coverage effective on or before closing."],
  conditions_count: 3, valid_until: "2026-11-21", decision_id: "D-REFI-CA-1", retention_class: "regb_25m",
};

export const VERSIONS_23_3: VersionInput[] = [
  V("NTC_REGB_1002_9_APPROVAL", APPROVAL_SOURCE, APPROVAL_RULES, APPROVAL_SAMPLE, "regb.2013 (as amended July 21, 2026); fnma.selling.2026-09-02; SM 23.3 conditional-approval letter v1", "12 CFR 1002.9(a)(1)(i) express approval notification; no prescribed federal form (state commitment-letter content rules per 31.1/21.3 — UNVERIFIED)"),
];
export const OVERRIDES_23_3: Record<string, Partial<NoticeTemplate>> = {
  // Channels: e-delivery with E-SIGN consent (21.1) or mail; one letter per application in the partner's name; Reg B 25-month retention of the notice; never combined with an adverse-action notice.
  NTC_REGB_1002_9_APPROVAL: { citation: "12 CFR 1002.9(a)(1)(i); comment 9(a)(1)-2; 23.3 rule 2", noticeClass: "origination_decisions", channelPolicy: "esign_or_mail", separateDocument: true, mayCombineWith: [], retention: "regb_25m", piiLevel: "medium" },
};
