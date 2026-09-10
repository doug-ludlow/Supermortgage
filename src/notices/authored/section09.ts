/**
 * Authored template versions for the §9 insurance notices: hazard tracking
 * (9.1), the force-placed reminder and renewal notices (MS-3(B)/(C)/(D),
 * 9.2–9.4), the cancellation/refund confirmation (9.5), the flood notices
 * (9.6) and the loss-draft letters (9.7). Sample payloads are the sections'
 * worked examples so the publish gate proves every template.
 */
import type { ContentRule, VersionInput } from "../registry.ts";
import { V } from "./section01.ts";

const R = (rule_id: string, citation: string, kind: ContentRule["kind"], selector: string, message: string, extra: Partial<ContentRule> = {}): ContentRule => ({ rule_id, citation, kind, selector, severity: "block", message, ...extra });
const CONTACT = `{{#block "contact" page=1 y=0.9 pt=10}}Supermortgage · {{servicer_phone}} · {{servicer_address}} · Send insurance information to {{insurance_email}} or {{servicer_address}}.{{/block}}`;
const BASE = { servicer_phone: "(800) 555-0100", servicer_address: "PO Box 1, Testville TX 75001", insurance_email: "insurance@example.com", account_last4: "1234", property_address: "1 Test St, Testville TX 75001", notice_date: "2026-11-04" };
const CONTACT_RULE = R("contact", "§1024.37(c)(2)(ii)/(x)", "presence", "Send insurance information to", "how to provide evidence and contact");
const DATE_RULE = R("date", "§1024.37(c)(2)(i)", "presence", "(January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4}", "date of the notice");

// ------------------------------------------------------------------ 9.1 hazard tracking
const DEF_SOURCE = (bk: boolean) => `{{#block "heading" page=1 y=0.05 pt=14 bold}}Important notice about the insurance on your property{{/block}}
${bk ? `{{#block "bk" page=1 y=0.1 pt=10}}This notice is for informational purposes only and is not an attempt to collect a debt from you personally.{{/block}}` : ""}
{{#block "body" page=1 y=0.15 pt=11}}{{date notice_date}}. Loan number ending {{account_last4}}. Property: {{property_address}}. Policy {{policy_number}} with {{carrier_name}}: our records show the following deficiency — {{deficiency_text}}. Your loan requires {{requirement_text}}. To cure it, {{cure_options}}. If the deficiency is not cured, we may purchase insurance on your property at your expense; insurance we buy may cost significantly more than insurance you can buy yourself and may provide less coverage.{{/block}}
${CONTACT}`;
const DEF_RULES = (bk: boolean): ContentRule[] => [R("property-policy", "B-2-02", "presence", "Property: .* Policy .* with", "property and policy identified"), R("deficiency", "B-2-02 'notify the borrower of the insufficiency'", "presence", "the following deficiency — ", "the specific deficiency"), R("requirement", "B-2-02", "presence", "Your loan requires", "the requirement"), R("cure", "B-2-02", "presence", "To cure it, ", "cure options"), R("lpi-warning", "§1024.37(c)(2)(viii)", "presence", "may cost significantly more .* may provide less coverage", "LPI may follow with its cost warning"), ...(bk ? [R("bk-legend", "Section 14 overlay", "presence", "informational purposes only", "bankruptcy disclaimer"), R("no-must-pay", "9.1 edge (bankruptcy)", "absence", "you must pay", "no payment demand beyond the model form")] : []), CONTACT_RULE];
const DEF_SAMPLE = { ...BASE, policy_number: "HO-4471", carrier_name: "Test Mutual", deficiency_text: "the all-peril deductible of $12,501 exceeds 5% of the dwelling coverage", requirement_text: "a deductible of no more than 5% of the dwelling coverage (Fannie Mae B-2-01)", cure_options: "ask your carrier to lower the deductible and send us the updated declarations page" };
const REMINDER_SOURCE = `{{#block "heading" page=1 y=0.05 pt=13 bold}}Annual insurance reminder{{/block}}
{{#block "body" page=1 y=0.12 pt=11}}Your mortgage requires you to maintain property insurance on {{property_address}} for as long as the loan is outstanding. We recommend that you review your coverage with your insurance provider each year to confirm it reflects the cost to rebuild your home and that we are listed as mortgagee. Learn more at {{fnma_consumer_url}}.{{/block}}
${CONTACT}`;
const REMINDER_RULES: ContentRule[] = [R("obligation", "B-2-01", "presence", "requires you to maintain property insurance", "obligation to maintain insurance"), R("review", "B-2-01", "presence", "review your coverage with your insurance provider", "recommendation to review coverage"), R("website", "9.1 rule 7", "presence", "Learn more at ", "website pointer"), R("no-fpi-language", "9.1 rule 7 (not a §1024.37 notice)", "absence", "purchase insurance on your property at your expense", "no FPI language"), R("annual", "9.1 rule 7", "data_range", "days_since_last", "one per 12 months", { range: { min: 365 } })];
const EOI_SOURCE = `{{#block "body" page=1 y=0.1 pt=11}}Our records show the property insurance policy for {{property_address}} (policy {{policy_number}}) expires on {{date expiration_date}}. As a courtesy, please ask your insurance agent to send us the renewal declarations page showing Supermortgage as mortgagee. If you have already renewed, thank you — no further action is needed.{{/block}}
${CONTACT}`;
const EOI_RULES: ContentRule[] = [R("expiration", "9.1 (courtesy request at −30 days)", "presence", "expires on", "expiration date"), R("courtesy", "9.1", "presence", "As a courtesy", "courtesy framing"), R("no-fpi-language", "9.1: must not contain FPI language", "absence", "(purchase insurance on your property at your expense|force-placed|lender-placed)", "no §1024.37 language"), CONTACT_RULE];

// ------------------------------------------------------------------ 9.3 / 9.4 force-placed reminders (MS-3(B), MS-3(C)) and renewal (MS-3(D))
// Layout: every sentence §1024.37(c)(3)/(d)(3)/(e)(3) requires in bold sits in its own bold block, so the checklist's layout
// rule fails when the block is missing or not bold, and the 9.2 (c)(4)/(d)(4)/(e)(4) sentence classifier (fpi.ts
// noticeChecklist) finds nothing on the pages but the required items and the account number. The physical address is
// printed in a non-bold block ((c)(3): "(iv) … except the address itself").
const MS3_HEADER = `{{#block "header" page=1 y=0.11 pt=11}}{{date notice_date}}. From: Supermortgage, {{servicer_address}}. To: {{borrower_name}}, {{borrower_address}}. Loan number ending {{account_last4}}.{{/block}}`;
const MS3_BOLD_WARNINGS = (y: string) => `{{#block "bold_warnings" page=1 y=${y} pt=12 bold}}The insurance we buy may cost significantly more than insurance you can buy yourself and may not provide as much coverage as an insurance policy you buy yourself.{{/block}}`;
const MS3_BOLD_COST = (y: string) => `{{#block "bold_cost" page=1 y=${y} pt=12 bold}}The insurance we buy will cost {{money annual_premium_cents}} annually{{#if premium_is_estimate}} (an estimate){{/if}}.{{/block}}`;
const MS3_HOW = (y: string, lead: string) => `{{#block "how" page=1 y=${y} pt=11}}${lead} please provide the information promptly, and in writing: send a declarations page, certificate or policy showing continuous coverage to {{insurance_email}} or {{servicer_address}}, or upload it through your borrower portal. If you have any questions, contact us at {{servicer_phone}}. {{#if additional_information}}Please review the additional information enclosed in the same envelope.{{/if}}{{/block}}`;
const MS3B_SOURCE = `{{#block "subject" page=1 y=0.05 pt=13 bold}}Subject: Second and final notice about your {{insurance_type}} insurance — please provide insurance information for {{property_address}}{{/block}}
${MS3_HEADER}
{{#block "body" page=1 y=0.18 pt=12}}Dear {{borrower_name}}: Our records show that your {{insurance_type}} insurance {{status_phrase}} on {{date coverage_event_date}}, and we do not have evidence that you have had {{insurance_type}} insurance on the property listed above since then.{{/block}}
{{#block "bold_second_final" page=1 y=0.27 pt=12 bold}}This is the second and final notice.{{/block}}
{{#block "bold_request" page=1 y=0.31 pt=12 bold}}You must immediately provide us with your {{insurance_type}} insurance information for the property at:{{/block}}
{{#block "property" page=1 y=0.35 pt=12}}Property: {{property_address}}.{{/block}}
{{#block "bold_expense" page=1 y=0.39 pt=12 bold}}Because {{insurance_type}} insurance is required on your property, we will purchase insurance on your property at your expense. You must pay us for any period during which the insurance we buy is in effect but you do not have insurance.{{/block}}
${MS3_BOLD_COST("0.49")}
${MS3_BOLD_WARNINGS("0.54")}
${MS3_HOW("0.62", "To avoid being charged,")}
${CONTACT}`;
const MS3C_SOURCE = `{{#block "subject" page=1 y=0.05 pt=13 bold}}Subject: Second and final notice about your {{insurance_type}} insurance — please provide insurance information for {{property_address}}{{/block}}
${MS3_HEADER}
{{#block "body" page=1 y=0.18 pt=12}}Dear {{borrower_name}}: We received the insurance information you provided. However, we are unable to verify that you had {{insurance_type}} insurance on the property listed above for the following period(s): {{#each unverified_ranges}}{{date start}} to {{date end}}; {{/each}}{{/block}}
{{#block "bold_second_final" page=1 y=0.27 pt=12 bold}}This is the second and final notice.{{/block}}
{{#block "bold_request" page=1 y=0.31 pt=12 bold}}If you had {{insurance_type}} insurance for the period(s) stated above, you must immediately provide us with your insurance information for the property at:{{/block}}
{{#block "property" page=1 y=0.36 pt=12}}Property: {{property_address}}.{{/block}}
{{#block "charged" page=1 y=0.4 pt=12}}You will be charged for insurance we purchased for any period during which we cannot verify that you had {{insurance_type}} insurance.{{/block}}
${MS3_BOLD_COST("0.46")}
${MS3_BOLD_WARNINGS("0.51")}
${MS3_HOW("0.6", "To avoid being charged for those period(s),")}
${CONTACT}`;
const MS3_BOLD_RULES: ContentRule[] = [
  R("bold-second-final", "§1024.37(d)(3) — (d)(2)(i)(B) in bold", "layout", "bold_second_final", "'second and final notice' in bold", { layout: { bold: true, page: 1 } }),
  R("bold-request", "§1024.37(d)(3) via (c)(3) — (c)(2)(iv) request in bold (address itself excepted)", "layout", "bold_request", "request for insurance information in bold", { layout: { bold: true, page: 1 } }),
  R("bold-cost", "§1024.37(d)(3) — (d)(2)(i)(D) in bold", "layout", "bold_cost", "annual premium in bold", { layout: { bold: true, page: 1 } }),
  R("bold-warnings", "§1024.37(d)(3) via (c)(3) — (c)(2)(ix)(A)–(B) in bold", "layout", "bold_warnings", "cost and coverage warnings in bold", { layout: { bold: true, page: 1 } }),
];
const MS3_COMMON: ContentRule[] = [DATE_RULE,
  R("servicer", "§1024.37(c)(2)(ii)", "presence", "From: Supermortgage, ", "servicer name and mailing address"),
  R("borrower", "§1024.37(c)(2)(iii)", "presence", "To: [^,.]+, .+", "borrower name and mailing address"),
  R("second-final", "§1024.37(d)(2)(i)(B)", "presence", "This is the second and final notice", "second and final notice statement"),
  R("request", "§1024.37(c)(2)(iv)", "presence", "immediately provide us with your .*insurance information for the property at", "request for insurance information, property by physical address"),
  R("property", "§1024.37(c)(2)(iv)", "presence", "Property: ", "physical address of the property"),
  R("warnings", "§1024.37(c)(2)(ix)(A)–(B)", "presence", "may cost significantly more .* may not provide as much coverage", "cost and coverage warnings"),
  R("prompt-writing", "§1024.37(c)(2)(vii)–(viii)", "presence", "promptly, and in writing", "prompt request; description of the information and how to provide it, in writing"),
  R("phone", "§1024.37(c)(2)(x)", "presence", "contact us at \\(\\d{3}\\) \\d{3}-\\d{4}", "servicer telephone number"),
  R("cost", "§1024.37(d)(2)(i)(D)", "presence", "will cost \\$[\\d,]+\\.\\d{2} annually", "cost as an annual premium"),
  R("estimate-label", "§1024.37(d)(2)(i)(D) (identified as an estimate)", "conditional", "premium_is_estimate", "estimate identified", { when: { "==": [{ var: "premium_is_estimate" }, true] }, predicate: { "==": [{ var: "estimate_basis_present" }, true] } }),
  ...MS3_BOLD_RULES,
  R("timing", "§1024.37(d)(1)", "data_range", "days_after_first_notice", "not earlier than 30 days after the first notice", { range: { min: 30 } }),
  R("no-extra", "§1024.37(d)(4)", "absence", "(agent list|Spanish|enclosed brochure|special offer|home warranty)", "nothing else on the notice pages (inserts on separate sheets)"), CONTACT_RULE];
const MS3B_RULES: ContentRule[] = [...MS3_COMMON,
  R("v-statement", "§1024.37(c)(2)(v)(A)–(B)", "presence", "insurance (is expiring|expired|provides insufficient coverage) on .* we do not have evidence", "expiring/expired/insufficient statement and lack of evidence"),
  R("bold-expense", "§1024.37(d)(3) via (c)(3) — (c)(2)(vi) in bold", "layout", "bold_expense", "required insurance / purchase at the borrower's expense in bold", { layout: { bold: true, page: 1 } }),
  R("expense", "§1024.37(c)(2)(vi)", "presence", "insurance is required on your property, we will purchase insurance on your property at your expense", "hazard insurance is required; the servicer will purchase at the borrower's expense")];
const MS3C_RULES: ContentRule[] = [...MS3_COMMON,
  R("received", "§1024.37(d)(2)(ii)(C)", "presence", "We received the insurance information you provided", "acknowledgment of information received"),
  R("ranges", "§1024.37(d)(2)(ii)(D)", "presence", "unable to verify .* for the following period\\(s\\): (January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4} to (January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4}", "request for the missing period(s) as [Date Range]"),
  R("charge-unverified", "§1024.37(d)(2)(ii)(E)", "presence", "charged for insurance we purchased for any period during which we cannot verify", "will-be-charged statement for unverified periods")];
const MS3_SAMPLE = { ...BASE, borrower_name: "Bea Borrower", borrower_address: "1 Test St, Testville TX 75001", insurance_type: "hazard", status_phrase: "expired", coverage_event_date: "2026-10-01", annual_premium_cents: 219000n, premium_is_estimate: true, estimate_basis_present: true, days_after_first_notice: 30, unverified_ranges: [{ start: "2026-10-01", end: "2026-10-14" }], additional_information: false };
const MS3D_SOURCE = `{{#block "subject" page=1 y=0.05 pt=13 bold}}Subject: Notice about renewing the insurance we purchased for your property — please update the insurance information for {{property_address}}{{/block}}
${MS3_HEADER}
{{#block "body" page=1 y=0.18 pt=12}}Dear {{borrower_name}}: Because we did not have evidence that you had {{insurance_type}} insurance on the property listed above, we previously purchased insurance on your property at your expense, effective {{date placement_effective}}. The insurance we bought {{#if expired}}expired{{else}}is expiring{{/if}} on {{date anniversary}}.{{/block}}
{{#block "bold_required" page=1 y=0.28 pt=12 bold}}Because {{insurance_type}} insurance is required on your property, we intend to maintain insurance on your property by renewing or replacing the insurance we bought. You must pay us for any period during which the insurance we buy is in effect but you do not have insurance.{{/block}}
{{#block "bold_request" page=1 y=0.37 pt=12 bold}}You must immediately provide us with updated {{insurance_type}} insurance information for the property at:{{/block}}
{{#block "property" page=1 y=0.41 pt=12}}Property: {{property_address}}.{{/block}}
${MS3_BOLD_WARNINGS("0.45")}
${MS3_BOLD_COST("0.51")}
${MS3_HOW("0.58", "If you buy your own insurance,")}
${CONTACT}`;
const MS3D_RULES: ContentRule[] = [DATE_RULE,
  R("servicer", "§1024.37(e)(2)(ii)", "presence", "From: Supermortgage, ", "servicer name and mailing address"),
  R("borrower", "§1024.37(e)(2)(iii)", "presence", "To: [^,.]+, .+", "borrower name and mailing address"),
  R("request", "§1024.37(e)(2)(iv)", "presence", "immediately provide us with updated .*insurance information for the property at", "request to update the insurance information, property by physical address"),
  R("property", "§1024.37(e)(2)(iv)", "presence", "Property: ", "physical address of the property"),
  R("previously-purchased", "§1024.37(e)(2)(v)", "presence", "we previously purchased insurance on your property at your expense", "previously purchased at the borrower's expense for lack of evidence"),
  R("expiring", "§1024.37(e)(2)(vi)(A)", "presence", "The insurance we bought (expired|is expiring) on", "LPI expired or expiring, as applicable"),
  R("required-maintain", "§1024.37(e)(2)(vi)(B)", "presence", "insurance is required on your property, we intend to maintain insurance on your property by renewing or replacing", "'because hazard insurance is required' the servicer intends to maintain it by renewing or replacing"),
  R("warnings", "§1024.37(e)(2)(vii)(A)–(B)", "presence", "may cost significantly more .* may not provide as much coverage", "cost and coverage warnings"),
  R("cost", "§1024.37(e)(2)(vii)(C)", "presence", "will cost \\$[\\d,]+\\.\\d{2} annually", "cost as an annual premium"),
  R("estimate-label", "§1024.37(e)(2)(vii)(C); comment 37(e)(2)(vii)-1", "conditional", "premium_is_estimate", "estimate identified", { when: { "==": [{ var: "premium_is_estimate" }, true] }, predicate: { "==": [{ var: "estimate_basis_present" }, true] } }),
  R("prompt-writing", "§1024.37(e)(2)(viii)–(ix)", "presence", "If you buy your own insurance, please provide the information promptly, and in writing", "provide promptly; description of the information and how to provide it, in writing"),
  R("phone", "§1024.37(e)(2)(x)", "presence", "contact us at \\(\\d{3}\\) \\d{3}-\\d{4}", "servicer telephone number"),
  R("bold-request", "§1024.37(e)(3) — (e)(2)(iv) in bold (address itself excepted)", "layout", "bold_request", "request in bold", { layout: { bold: true, page: 1 } }),
  R("bold-required", "§1024.37(e)(3) — (e)(2)(vi)(B) in bold", "layout", "bold_required", "'because hazard insurance is required' statement in bold", { layout: { bold: true, page: 1 } }),
  R("bold-warnings", "§1024.37(e)(3) — (e)(2)(vii)(A)–(B) in bold", "layout", "bold_warnings", "warnings in bold", { layout: { bold: true, page: 1 } }),
  R("bold-cost", "§1024.37(e)(3) — (e)(2)(vii)(C) in bold", "layout", "bold_cost", "annual premium in bold", { layout: { bold: true, page: 1 } }),
  R("timing", "§1024.37(e)(1)(i); 9.4 rule 2 (target A − 60; a later mailing only delays the charge to t2 + 45)", "data_range", "days_before_anniversary", "mailed at least 45 days before the anniversary charge", { range: { min: 45 }, severity: "warn" }),
  R("annual", "§1024.37(e)(5)", "data_range", "days_since_last_renewal_notice", "one per year", { range: { min: 365 } }),
  R("no-extra", "§1024.37(e)(4)", "absence", "(agent list|Spanish|enclosed brochure|special offer|home warranty|refund)", "nothing else on the notice pages (inserts on separate sheets)"), CONTACT_RULE];
const MS3D_SAMPLE = { ...BASE, notice_date: "2027-08-02", borrower_name: "Bea Borrower", borrower_address: "1 Test St, Testville TX 75001", insurance_type: "hazard", placement_effective: "2026-10-01", anniversary: "2027-10-01", expired: false, annual_premium_cents: 225000n, premium_is_estimate: false, estimate_basis_present: true, days_before_anniversary: 60, days_since_last_renewal_notice: 400, additional_information: false };

// ------------------------------------------------------------------ 9.5 cancellation / refund confirmation
const CANCEL_SOURCE = `{{#block "body" page=1 y=0.1 pt=11}}{{date notice_date}}. Loan number ending {{account_last4}}. We received evidence on {{date evidence_received_on}} that you have had {{insurance_type}} insurance since {{date borrower_coverage_start}}. We cancelled the insurance we purchased effective {{date cancellation_effective}} and removed {{money removed_cents}} of charges for the {{overlap_days}} days both policies overlapped. {{#if refund_cents}}A refund of {{money refund_cents}} for the amount you paid toward those charges is being sent by {{rail}}.{{else}}No refund is due because you had not paid toward the removed charges.{{/if}} {{#if retained_cents}}Charges of {{money retained_cents}} remain for {{date gap_start}} to {{date gap_end}}, when we could not verify coverage.{{/if}}{{/block}}
${CONTACT}`;
const CANCEL_RULES: ContentRule[] = [R("cancel", "§1024.37(g)(1)", "presence", "cancelled the insurance we purchased effective", "cancellation within 15 days"), R("removed", "§1024.37(g)(2)", "presence", "removed \\$[\\d,]+\\.\\d{2} of charges for the \\d+ days", "charges removed for the overlap"), R("refund", "§1024.37(g)(2)", "presence", "(A refund of \\$[\\d,]+\\.\\d{2}|No refund is due)", "refund of premiums paid"), R("within-15", "§1024.37(g)", "data_range", "days_after_evidence", "within 15 days of evidence", { range: { max: 15 } }), CONTACT_RULE];
const CANCEL_SAMPLE = { ...BASE, notice_date: "2027-01-20", insurance_type: "hazard", evidence_received_on: "2027-01-12", borrower_coverage_start: "2026-12-15", cancellation_effective: "2026-12-15", removed_cents: 174000n, overlap_days: 290, refund_cents: 15000n, rail: "ACH credit", retained_cents: 45000n, gap_start: "2026-10-01", gap_end: "2026-12-14", days_after_evidence: 8 };

// ------------------------------------------------------------------ 9.6 flood
const FLOOD45_SOURCE = `{{#block "heading" page=1 y=0.05 pt=14 bold}}NOTICE: FLOOD INSURANCE IS REQUIRED FOR YOUR PROPERTY{{/block}}
{{#block "body" page=1 y=0.12 pt=11}}{{date notice_date}}. Loan number ending {{account_last4}}. Property: {{property_address}}. A flood zone determination shows that the building securing your loan is in a Special Flood Hazard Area (zone {{flood_zone}}, map panel {{map_panel}} effective {{date map_effective}}). Federal law requires flood insurance in at least {{money required_amount_cents}} for the remaining term of your loan. You have 45 days from the date of this notice, until {{date deadline}}, to purchase flood insurance through the National Flood Insurance Program or a qualifying private policy. If you do not, we will purchase flood insurance on behalf of the borrower and charge you the premiums and fees for coverage beginning on {{date coverage_from}}. Insurance we purchase may cost significantly more than insurance you can buy yourself and may provide less coverage. Send your declarations page to {{insurance_email}} or {{servicer_address}}.{{/block}}
${CONTACT}`;
const FLOOD45_RULES: ContentRule[] = [R("determination", "42 U.S.C. §4012a(e)(1); 9.6 rule 4", "presence", "Special Flood Hazard Area \\(zone .*, map panel .* effective", "the SFHA determination with zone, panel and date"), R("amount", "§4012a(b)", "presence", "at least \\$[\\d,]+\\.\\d{2} for the remaining term", "required amount for the remaining term"), R("45-days", "§4012a(e)(1)", "presence", "You have 45 days from the date of this notice", "45-day period"), R("on-behalf", "§4012a(e)(2)", "presence", "purchase flood insurance on behalf of the borrower and charge you the premiums and fees for coverage beginning on", "placement and charge statement"), R("cost-warning", "9.6 rule 4", "presence", "may cost significantly more", "cost warning"), R("evidence", "§4012a(e)(4)", "presence", "Send your declarations page", "declarations page acceptable"), R("separate", "RESPA §6(l)(4)", "data_equality", "separate_document", "separate paper when mailed with an MS-3(A)", { predicate: { "==": [{ var: "separate_document" }, true] } }), CONTACT_RULE];
const FLOOD_SAMPLE = { ...BASE, notice_date: "2027-02-05", flood_zone: "AE", map_panel: "48453C0445K", map_effective: "2027-02-03", required_amount_cents: 24000000n, deadline: "2027-03-22", coverage_from: "2027-02-03", separate_document: true, premium_cents: 115000n, placed_on: "2027-03-22", letter_date: "2027-05-10", refund_cents: 93890n, termination_effective: "2027-04-11", days_after_evidence: 20 };
const FLOOD_PLACED_SOURCE = `{{#block "body" page=1 y=0.1 pt=11}}{{date notice_date}}. Loan number ending {{account_last4}}. Because we did not receive evidence of flood insurance by {{date deadline}}, we purchased flood insurance of {{money required_amount_cents}} on your property on {{date placed_on}}, effective {{date coverage_from}}. The annual premium is {{money premium_cents}}, which will be charged to your account. You may replace it at any time with your own NFIP or qualifying private policy: send the declarations page to {{insurance_email}} and we will terminate the insurance we bought and refund the premium for any overlap within 30 days.{{/block}}
${CONTACT}`;
const FLOOD_PLACED_RULES: ContentRule[] = [R("bound", "9.6 rule 5", "presence", "we purchased flood insurance of \\$[\\d,]+\\.\\d{2} on your property on", "coverage bound with amount and date"), R("premium", "9.6 rule 5", "presence", "annual premium is \\$[\\d,]+\\.\\d{2}, which will be charged", "premium and charge"), R("replace", "§4012a(e)(3)", "presence", "terminate the insurance we bought and refund the premium for any overlap within 30 days", "how to replace; 30-day refund"), CONTACT_RULE];
const FLOOD_MAP_SOURCE = `{{#block "body" page=1 y=0.1 pt=11}}{{date notice_date}}. Loan number ending {{account_last4}}. FEMA revised the flood map for {{property_address}} effective {{date map_effective}}: the building securing your loan is now in zone {{flood_zone}} (map panel {{map_panel}}). {{#if coverage_required}}Flood insurance is now required; see the enclosed notice for the amount and the 45-day period.{{else}}Flood insurance is no longer required by federal law for this loan; you may keep your policy if you wish.{{/if}}{{/block}}
${CONTACT}`;
const FLOOD_MAP_RULES: ContentRule[] = [R("revision", "9.6 rule 7 / 44 CFR 61.11", "presence", "FEMA revised the flood map .* effective", "map revision with date"), R("zone", "9.6", "presence", "now in zone", "new zone"), R("consequence", "9.6", "presence", "(Flood insurance is now required|no longer required)", "consequence stated"), CONTACT_RULE];
const FLOOD_REMOVED_SOURCE = `{{#block "body" page=1 y=0.1 pt=11}}{{date notice_date}}. Loan number ending {{account_last4}}. Based on the FEMA letter/map revision dated {{date letter_date}}, the building securing your loan is no longer in a Special Flood Hazard Area. Flood insurance is no longer required for this loan. {{#if lpi_cancelled}}We cancelled the flood insurance we had purchased effective {{date letter_date}} and are refunding {{money refund_cents}} for the period after that date.{{/if}} Any NFIP policy you bought yourself is yours to keep or cancel.{{/block}}
${CONTACT}`;
const FLOOD_REMOVED_RULES: ContentRule[] = [R("no-longer", "9.6 rule 7", "presence", "no longer in a Special Flood Hazard Area", "remapped out"), R("not-required", "9.6 rule 7", "presence", "Flood insurance is no longer required", "requirement removed"), R("cancel-refund", "9.6 rule 7", "conditional", "lpi_cancelled", "LPI cancelled at the letter date with a refund", { when: { "==": [{ var: "lpi_cancelled" }, true] }, predicate: { present: "refund_cents" } }), CONTACT_RULE];
const FLOOD_TERM_SOURCE = `{{#block "body" page=1 y=0.1 pt=11}}{{date notice_date}}. Loan number ending {{account_last4}}. We received your flood insurance declarations page on {{date evidence_received_on}}. We terminated the flood insurance we purchased effective {{date termination_effective}} and are refunding {{money refund_cents}} of premiums and fees for the period both policies were in force, within 30 days of receiving your evidence.{{/block}}
${CONTACT}`;
const FLOOD_TERM_RULES: ContentRule[] = [R("terminated", "42 U.S.C. §4012a(e)(3)", "presence", "terminated the flood insurance we purchased effective", "termination"), R("refund", "§4012a(e)(3)", "presence", "refunding \\$[\\d,]+\\.\\d{2} of premiums and fees", "refund of premiums and fees for the overlap"), R("within-30", "§4012a(e)(3)", "data_range", "days_after_evidence", "within 30 days", { range: { max: 30 } }), CONTACT_RULE];

// ------------------------------------------------------------------ 9.7 loss drafts
const LD_BASE = { ...BASE, claim_number: "CLM-2026-0917", proceeds_cents: 6000000n, initial_release_cents: 4000000n, held_cents: 2000000n, release_cents: 1400000n, pct_complete: "70", cumulative_cents: 5400000n, remaining_cents: 600000n, interest_cents: 13151n, applied_cents: 6000000n, new_upb_cents: 18000000n, track: "current (fewer than 31 days delinquent)", documents: ["adjuster's estimate", "signed contractor bid", "lien waivers at each release", "receipts for prepaid items above $40,000.00"], inspection_kind: "remote photo inspection (app-captured, GPS and timestamp verified)" };
const LD_PACKAGE_SOURCE = `{{#block "heading" page=1 y=0.05 pt=14 bold}}Your insurance claim proceeds — what happens next{{/block}}
{{#block "body" page=1 y=0.12 pt=11}}{{date notice_date}}. Loan number ending {{account_last4}}. We received insurance proceeds of {{money proceeds_cents}} for claim {{claim_number}} on {{property_address}}. Your loan is {{track}}, so we will release {{money initial_release_cents}} now and hold {{money held_cents}} in an interest-bearing custodial account, releasing it as repairs are completed and inspected; interest earned on held funds is paid to you. Please send: {{#each documents}}{{this}}; {{/each}}Amounts the adjuster designated for contents or living expenses are released to you within 2 business days. Checks payable to you and to us must be endorsed by you first; we endorse under our limited power of attorney.{{/block}}
${CONTACT}`;
const LD_PACKAGE_RULES: ContentRule[] = [R("proceeds", "B-5-01", "presence", "received insurance proceeds of \\$[\\d,]+\\.\\d{2} for claim", "proceeds and claim"), R("release-schedule", "9.7 rule 2", "presence", "release \\$[\\d,]+\\.\\d{2} now and hold \\$[\\d,]+\\.\\d{2}", "initial release and held amount"), R("interest", "9.7 rule 5 (interest always paid)", "presence", "interest earned on held funds is paid to you", "interest to the borrower"), R("documents", "9.7 rule 7", "presence", "Please send: .+;", "document list"), R("contents", "9.7 rule 4", "presence", "released to you within 2 business days", "contents/ALE release"), R("endorsement", "9.7 rule 6", "presence", "endorsed by you first", "endorsement instructions"), CONTACT_RULE];
const LD_RELEASE_SOURCE = `{{#block "body" page=1 y=0.1 pt=11}}{{date notice_date}}. Loan number ending {{account_last4}}. Following the {{inspection_kind}} on {{date inspection_on}} showing repairs {{pct_complete}}% complete, we are releasing {{money release_cents}} from your claim funds (cumulative {{money cumulative_cents}} of {{money proceeds_cents}}). {{money remaining_cents}} remains held and will be released at completion after a final check.{{/block}}
${CONTACT}`;
const LD_RELEASE_RULES: ContentRule[] = [R("inspection", "9.7 rule 2 (no release without the required inspection)", "presence", "Following the .* on .* showing repairs \\d+% complete", "inspection basis"), R("amounts", "9.7 rule 2", "presence", "releasing \\$[\\d,]+\\.\\d{2} from your claim funds \\(cumulative \\$[\\d,]+\\.\\d{2} of \\$[\\d,]+\\.\\d{2}\\)", "release and cumulative amounts"), R("within-formula", "9.7 guardrail", "data_equality", "within_formula", "release within the formula limit", { predicate: { "==": [{ var: "within_formula" }, true] } }), CONTACT_RULE];
const LD_FINAL_SOURCE = `{{#block "body" page=1 y=0.1 pt=11}}{{date notice_date}}. Loan number ending {{account_last4}}. Repairs on {{property_address}} are complete. We released the final {{money remaining_cents}} of your claim funds and {{money interest_cents}} of interest earned while the funds were held. Total proceeds disbursed: {{money proceeds_cents}}. Your claim {{claim_number}} is closed.{{/block}}
${CONTACT}`;
const LD_FINAL_RULES: ContentRule[] = [R("complete", "9.7 rule 2 (final inspection / final check)", "presence", "Repairs on .* are complete", "completion"), R("final-release", "9.7", "presence", "released the final \\$[\\d,]+\\.\\d{2}", "final release"), R("interest", "9.7 rule 5", "presence", "\\$[\\d,]+\\.\\d{2} of interest earned", "interest paid"), CONTACT_RULE];
const LD_UPB_SOURCE = `{{#block "body" page=1 y=0.1 pt=11}}{{date notice_date}}. Loan number ending {{account_last4}}. Because the property cannot be rebuilt ({{reason}}), we applied the insurance proceeds of {{money applied_cents}} to your unpaid principal balance on {{date applied_on}}. Your new principal balance is {{money new_upb_cents}}; your monthly payment does not change unless your loan is re-amortized at your request. {{#if payoff}}The proceeds paid your loan in full; a payoff confirmation follows.{{/if}}{{/block}}
${CONTACT}`;
const LD_UPB_RULES: ContentRule[] = [R("reason", "9.7 rule 1 (not_rebuildable)", "presence", "cannot be rebuilt \\(", "reason"), R("applied", "9.7 rule 1", "presence", "applied the insurance proceeds of \\$[\\d,]+\\.\\d{2} to your unpaid principal balance", "curtailment"), R("new-upb", "9.7", "presence", "new principal balance is \\$[\\d,]+\\.\\d{2}", "new balance"), CONTACT_RULE];
const LD_UNINSURED_SOURCE = `{{#block "body" page=1 y=0.1 pt=11}}{{date notice_date}}. Loan number ending {{account_last4}}. We learned that {{property_address}} was damaged on {{date loss_date}} by {{peril}} and that no insurance covers the loss. We have opened a case to help: we will inspect the damage, discuss a repair plan with you, tell you about disaster-relief assistance that may be available, and review whether a payment plan or other assistance fits your situation. Call {{servicer_phone}} to discuss.{{/block}}
${CONTACT}`;
const LD_UNINSURED_RULES: ContentRule[] = [R("uninsured", "B-5-02", "presence", "no insurance covers the loss", "uninsured loss"), R("steps", "9.7 rule 11", "presence", "inspect the damage, discuss a repair plan .* disaster-relief assistance .* payment plan", "damage assessment, repair plan, relief, workout evaluation"), CONTACT_RULE];

export const SECTION_09_VERSIONS: readonly VersionInput[] = [
  V("INS_DEFICIENCY_NOTICE", DEF_SOURCE(false), DEF_RULES(false), DEF_SAMPLE, "fnma.insurance.2026-08", "B-2-02"),
  V("INS_DEFICIENCY_NOTICE_BK", DEF_SOURCE(true), DEF_RULES(true), DEF_SAMPLE, "fnma.insurance.2026-08", "B-2-02 with the Section 14 overlay"),
  V("INS_ANNUAL_REMINDER", REMINDER_SOURCE, REMINDER_RULES, { ...BASE, fnma_consumer_url: "knowyouroptions.com/insurance", days_since_last: 365 }, "fnma.insurance.2026-08", "B-2-01"),
  V("INS_EOI_REQUEST", EOI_SOURCE, EOI_RULES, { ...BASE, policy_number: "HO-4471", expiration_date: "2026-10-01" }, "fnma.insurance.2026-08", "9.1 courtesy request"),
  V("INS_FPI_REMINDER_NOINFO_MS3B", MS3B_SOURCE, MS3B_RULES, MS3_SAMPLE, "regx.force_placed.2014", "Appendix MS-3(B)"),
  V("INS_FPI_REMINDER_INSUFF_MS3C", MS3C_SOURCE, MS3C_RULES, MS3_SAMPLE, "regx.force_placed.2014", "Appendix MS-3(C)"),
  V("INS_FPI_RENEWAL_MS3D", MS3D_SOURCE, MS3D_RULES, MS3D_SAMPLE, "regx.force_placed.2014", "Appendix MS-3(D)"),
  V("INS_FPI_CANCEL_REFUND_CONFIRM", CANCEL_SOURCE, CANCEL_RULES, CANCEL_SAMPLE, "regx.force_placed.2014", "§1024.37(g); 9.5 worked example"),
  V("INS_FLOOD_FPI_NOTICE_45", FLOOD45_SOURCE, FLOOD45_RULES, FLOOD_SAMPLE, "fdpa.4012a.2026", "42 U.S.C. §4012a(e); 9.6 rule 4"),
  V("INS_FLOOD_FPI_PLACED_NOTICE", FLOOD_PLACED_SOURCE, FLOOD_PLACED_RULES, { ...FLOOD_SAMPLE, notice_date: "2027-03-23" }, "fdpa.4012a.2026", "9.6 rule 5"),
  V("INS_FLOOD_MAP_CHANGE_NOTICE", FLOOD_MAP_SOURCE, FLOOD_MAP_RULES, { ...FLOOD_SAMPLE, coverage_required: true }, "fdpa.4012a.2026", "9.6 rule 7"),
  V("INS_FLOOD_REMOVED_NOTICE", FLOOD_REMOVED_SOURCE, FLOOD_REMOVED_RULES, { ...FLOOD_SAMPLE, notice_date: "2027-05-14", lpi_cancelled: true }, "fdpa.4012a.2026", "9.6 rule 7 (LOMA)"),
  V("INS_FLOOD_TERMINATION_REFUND_CONFIRM", FLOOD_TERM_SOURCE, FLOOD_TERM_RULES, { ...FLOOD_SAMPLE, notice_date: "2027-05-04", evidence_received_on: "2027-04-14" }, "fdpa.4012a.2026", "42 U.S.C. §4012a(e)(3); 9.6 worked timeline"),
  V("INS_LOSS_DRAFT_PACKAGE", LD_PACKAGE_SOURCE, LD_PACKAGE_RULES, LD_BASE, "fnma.b5_01.2026", "B-5-01; 9.7 worked example"),
  V("INS_LOSS_DRAFT_RELEASE_LETTER", LD_RELEASE_SOURCE, LD_RELEASE_RULES, { ...LD_BASE, inspection_on: "2027-01-20", within_formula: true }, "fnma.b5_01.2026", "9.7 rule 2"),
  V("INS_LOSS_DRAFT_FINAL_LETTER", LD_FINAL_SOURCE, LD_FINAL_RULES, LD_BASE, "fnma.b5_01.2026", "9.7 rules 2 and 5"),
  V("INS_LOSS_DRAFT_UPB_APPLICATION_NOTICE", LD_UPB_SOURCE, LD_UPB_RULES, { ...LD_BASE, reason: "the county denied the rebuilding permit", applied_on: "2027-02-01", payoff: false }, "fnma.b5_01.2026", "9.7 rule 1 (not rebuildable)"),
  V("INS_UNINSURED_LOSS_LETTER", LD_UNINSURED_SOURCE, LD_UNINSURED_RULES, { ...LD_BASE, loss_date: "2026-12-10", peril: "a tornado" }, "fnma.b5_02.2026", "B-5-02; 9.7 rule 11"),
];
