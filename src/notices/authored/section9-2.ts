/**
 * §9.2 process-owned notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts) and
 * per-code channel/combination overrides; the section's original templates stay in ./section09.ts. Spread by
 * ../catalog.ts after the section files, so a version here supersedes one there for the same code and effective date.
 *
 * INS_FPI_FIRST_MS3A v1.1.0 (effective 2026-09-10) supersedes the catalog's 1.0.0, which contradicted §1024.37(c):
 * it printed an estimated premium on the notice pages ((c)(2) lists no cost figure — that is the reminder's
 * (d)(2)(i)(D) — so (c)(4) forbids it), left (vi) and (ix)(A)–(B) out of bold ((c)(3)), and carried no borrower
 * name/mailing address ((c)(2)(iii)) and no lack-of-evidence statement ((v)(B)). This version follows Appendix MS-3(A)
 * sentence for sentence: every (c)(2) item is a content rule, every (c)(3) bold item its own bold block (the physical
 * address in a non-bold block — "except the address itself"), nothing on the pages but those items and the account
 * number ((c)(4)); the cost estimate the borrower-comms script quotes rides on a separate insert in the same
 * transmittal, pointed to by (c)(2)(xi). The MS-3 family is always mailed first-class ((f); 9.2 outputs: "Always mailed
 * … the mailed copy anchors the timers"), so the channel policy is `mail_only`.
 */
import type { ContentRule, NoticeTemplate, VersionInput } from "../registry.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { V } from "./section01.ts";

const R = (rule_id: string, citation: string, kind: ContentRule["kind"], selector: string, message: string, extra: Partial<ContentRule> = {}): ContentRule => ({ rule_id, citation, kind, selector, severity: "block", message, ...extra });

export const MS3A_SOURCE = `{{#block "subject" page=1 y=0.05 pt=13 bold}}Subject: Notice about your {{insurance_type}} insurance — please provide insurance information for {{property_address}}{{/block}}
{{#block "header" page=1 y=0.11 pt=11}}{{date notice_date}}. From: Supermortgage, {{servicer_address}}. To: {{borrower_name}}, {{borrower_address}}. Loan number ending {{account_last4}}.{{/block}}
{{#block "body" page=1 y=0.18 pt=12}}Dear {{borrower_name}}: Our records show that your {{insurance_type}} insurance {{status_phrase}} on {{date coverage_event_date}}, and we do not have evidence that you have had {{insurance_type}} insurance on the property listed above since then.{{#if type_statement}} {{type_statement}}{{/if}}{{/block}}
{{#block "bold_request" page=1 y=0.28 pt=12 bold}}You must immediately provide us with your {{insurance_type}} insurance information for the property at:{{/block}}
{{#block "property" page=1 y=0.32 pt=12}}Property: {{property_address}}.{{/block}}
{{#block "bold_expense" page=1 y=0.36 pt=12 bold}}Because {{insurance_type}} insurance is required on your property, we will purchase insurance on your property at your expense. You must pay us for any period during which the insurance we buy is in effect but you do not have insurance.{{/block}}
{{#block "bold_warnings" page=1 y=0.45 pt=12 bold}}The insurance we buy may cost significantly more than insurance you can buy yourself and may not provide as much coverage as an insurance policy you buy yourself.{{/block}}
{{#block "how" page=1 y=0.52 pt=11}}To avoid being charged, please provide the information promptly, and in writing: send a declarations page, certificate or policy showing continuous coverage to {{insurance_email}} or {{servicer_address}}, or upload it through your borrower portal. If you have any questions, contact us at {{servicer_phone}}. {{#if additional_information}}Please review the additional information enclosed in the same envelope.{{/if}}{{/block}}
{{#block "contact" page=1 y=0.9 pt=10}}Supermortgage · {{servicer_phone}} · {{servicer_address}} · Send insurance information to {{insurance_email}} or {{servicer_address}}.{{/block}}`;

const MONTH = "(January|February|March|April|May|June|July|August|September|October|November|December)";
export const MS3A_RULES: ContentRule[] = [
  R("c2-i-date", "§1024.37(c)(2)(i)", "presence", `${MONTH} \\d{1,2}, \\d{4}`, "date of the notice"),
  R("c2-ii-servicer", "§1024.37(c)(2)(ii)", "presence", "From: Supermortgage, ", "servicer name and mailing address"),
  R("c2-iii-borrower", "§1024.37(c)(2)(iii)", "presence", "To: [^,.]+, .+", "borrower name and mailing address"),
  R("c2-iv-request", "§1024.37(c)(2)(iv)", "presence", "immediately provide us with your .*insurance information for the property at", "request for hazard insurance information, property identified by physical address"),
  R("c2-iv-property", "§1024.37(c)(2)(iv)", "presence", "Property: ", "physical address of the property"),
  R("c2-v-statement", "§1024.37(c)(2)(v)(A)–(B)", "presence", "insurance (is expiring|expired|provides insufficient coverage) on .* we do not have evidence", "expiring/expired/insufficient statement and lack of evidence of coverage"),
  R("c2-v-c-type", "§1024.37(c)(2)(v)(C); comment 37(c)(2)(v)-1", "conditional", "type_statement", "the type of hazard insurance for which evidence is lacking when it is not the homeowners policy (windstorm)", { when: { "!=": [{ var: "insurance_type" }, "hazard"] }, predicate: { present: "type_statement" } }),
  R("c2-vi-expense", "§1024.37(c)(2)(vi)", "presence", "insurance is required on your property, we will purchase insurance on your property at your expense", "hazard insurance is required; the servicer will purchase it at the borrower's expense — first notices always say 'will purchase' (9.2 rule 5)"),
  R("c2-vii-viii-prompt-writing", "§1024.37(c)(2)(vii)–(viii)", "presence", "provide the information promptly, and in writing: send a declarations page", "prompt request; description of the information and how to provide it, in writing"),
  R("c2-ix-warnings", "§1024.37(c)(2)(ix)(A)–(B)", "presence", "may cost significantly more than insurance you can buy yourself and may not provide as much coverage", "cost and coverage warnings"),
  R("c2-x-phone", "§1024.37(c)(2)(x)", "presence", "contact us at \\(\\d{3}\\) \\d{3}-\\d{4}", "servicer telephone number"),
  R("c2-xi-type", "§1024.37(c)(2)(v)(C); 9.2 rule 2", "data_equality", "insurance_type", "insurance type is hazard or windstorm (flood runs on the FDPA track, never an MS-3(A) — 9.2-T9)", { predicate: { in: [{ var: "insurance_type" }, ["hazard", "windstorm", "wind"]] } }),
  R("c2-ix-estimate", "§1024.37(c)(2)(xi)/(c)(4); 9.2 rule 5 and worked example", "conditional", "estimated_annual_premium_cents", "the cost estimate the additional-information insert carries (separate sheet in the same transmittal, never on the notice pages) is present whenever the (xi) pointer is printed", { when: { "==": [{ var: "additional_information" }, true] }, predicate: { present: "estimated_annual_premium_cents" } }),
  R("bold-request", "§1024.37(c)(3) — (c)(2)(iv) in bold (address itself excepted)", "layout", "bold_request", "request for insurance information in bold", { layout: { bold: true, page: 1 } }),
  R("bold-expense", "§1024.37(c)(3) — (c)(2)(vi) in bold", "layout", "bold_expense", "required insurance / purchase at the borrower's expense in bold", { layout: { bold: true, page: 1 } }),
  R("bold-warnings", "§1024.37(c)(3) — (c)(2)(ix)(A)–(B) in bold", "layout", "bold_warnings", "cost and coverage warnings in bold", { layout: { bold: true, page: 1 } }),
  R("no-cost-on-pages", "§1024.37(c)(4) (no cost figure in (c)(2); the estimate is the reminder's (d)(2)(i)(D))", "absence", "\\$[\\d,]+\\.\\d{2}", "no premium or cost figure on the first-notice pages"),
  R("nothing-else", "§1024.37(c)(4)", "absence", "(agent list|Spanish|enclosed brochure|special offer|home warranty|autopay|credit review|partner offers)", "nothing else on the notice pages; inserts on separate sheets in the same transmittal"),
  R("no-bought-yet", "9.2 rule 5 (placement happens after the cycle — B-6-01)", "absence", "we (have )?bought", "'we bought' only after placement; the first notice says 'will purchase'"),
  R("first-class", "§1024.37(f); 9.2 outputs: always mailed", "data_equality", "mail_class", "mailed by a class not less than first-class mail", { predicate: { in: [{ var: "mail_class" }, ["first_class", "certified"]] } }),
  R("contact", "§1024.37(c)(2)(ii)/(x)", "presence", "Send insurance information to", "how to provide evidence and contact"),
];
/** 9.2 rule 8 worked example: policy expired 2026-10-01, first notice mailed 2026-10-05; the $2,190.00 estimate rides on the insert, not the pages. */
export const MS3A_SAMPLE: Record<string, unknown> = { notice_date: "2026-10-05", servicer_phone: "(800) 555-0100", servicer_address: "PO Box 1, Testville TX 75001", insurance_email: "insurance@example.com", account_last4: "1234", property_address: "1 Test St, Testville TX 75001",
  borrower_name: "Bea Borrower", borrower_address: "1 Test St, Testville TX 75001", insurance_type: "hazard", status_phrase: "expired", coverage_event_date: "2026-10-01", type_statement: null, additional_information: true, estimated_annual_premium_cents: 219000n, mail_class: "first_class" };

export const VERSIONS_9_2: VersionInput[] = [
  { ...V("INS_FPI_FIRST_MS3A", MS3A_SOURCE, MS3A_RULES, MS3A_SAMPLE, "regx.force_placed.2014", "Appendix MS-3(A); 9.2 rule 5 and worked example"), version: "1.1.0", effectiveFrom: D("2026-09-10") },
];
export const OVERRIDES_9_2: Record<string, Partial<NoticeTemplate>> = {
  INS_FPI_FIRST_MS3A: { channelPolicy: "mail_only", citation: "12 CFR 1024.37(c)(2), (f); Appendix MS-3(A); 9.2 outputs: always mailed, the mailed copy anchors the timers" },
  INS_FPI_RENEWAL_MS3D: { channelPolicy: "mail_only", citation: "12 CFR 1024.37(e)(2), (f); Appendix MS-3(D); 9.4: first-class mail, always mailed" },
};
