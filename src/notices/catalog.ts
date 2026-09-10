/**
 * The notice catalog: every NTC_/INS_ code the spec names
 * (spec/registry/notices.json, extracted by tools/extract_notices.py) is
 * registered with policy defaults derived from its citation family, and the
 * templates the spec details are given authored, rule-checked versions.
 * Owner sections refine `override` entries as they build their notices.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NoticeRegistry, type NoticeTemplate, type ChannelPolicy, type ContentRule, type VersionInput } from "./registry.ts";
import { plainDate as D } from "../kernel/calendar/date.ts";
import { publishCheck } from "./checklist.ts";
import { SECTION_01_VERSIONS } from "./authored/section01.ts";
import { SECTION_03_VERSIONS } from "./authored/section03.ts";
import { SECTION_04_VERSIONS } from "./authored/section04.ts";
import { SECTION_07_VERSIONS } from "./authored/section07.ts";
import { SECTION_08_VERSIONS } from "./authored/section08.ts";
import { SECTION_09_VERSIONS } from "./authored/section09.ts";
import { SECTION_10_VERSIONS } from "./authored/section10.ts";
import { SECTION_11_VERSIONS } from "./authored/section11.ts";
import { SECTION_12_VERSIONS } from "./authored/section12.ts";
import { SECTION_13_VERSIONS } from "./authored/section13.ts";

interface CatalogEntry { readonly code: string; readonly owner_process: string; readonly mentions: readonly string[]; readonly context: string; }

export function loadCatalog(): readonly CatalogEntry[] {
  return JSON.parse(readFileSync(fileURLToPath(new URL("../../spec/registry/notices.json", import.meta.url)), "utf8")) as CatalogEntry[];
}

/** Class + channel defaults by citation family (7.4 rule 1: a class not covered by consent → mail). */
function defaultsFor(code: string, owner: string): Pick<NoticeTemplate, "noticeClass" | "channelPolicy" | "separateDocument" | "mayCombineWith" | "citation" | "retention" | "piiLevel"> {
  const fam = /^(?:NTC|INS)_([A-Z]+)/.exec(code)?.[1] ?? "SM";
  const base = { separateDocument: false, mayCombineWith: [] as string[], retention: "life_of_loan_plus_4y", piiLevel: "medium" as const };
  const cls = (noticeClass: string, channelPolicy: ChannelPolicy, citation: string) => ({ ...base, noticeClass, channelPolicy, citation });
  if (/^NTC_REGZ_41_STMT/.test(code)) return cls("periodic_statements", "esign_or_mail", "12 CFR 1026.41; Appendix H-30");
  if (/^NTC_REGZ_20[CD]/.test(code) || fam === "ARM") return { ...cls("arm_notices", "esign_or_mail", "12 CFR 1026.20(c)/(d); Appendix H-4(D)"), separateDocument: /20D/.test(code) };
  if (/^NTC_REGX_39/.test(code)) return cls("regx_ei", "esign_or_mail", "12 CFR 1024.39");
  if (/^NTC_REGX_41/.test(code)) return cls("lossmit", "esign_or_mail", "12 CFR 1024.41");
  if (/^NTC_REGX_1024_3[356]/.test(code)) return cls("servicing_requests", "esign_or_mail", "12 CFR 1024.35/1024.36/1024.33");
  if (/^NTC_REGX_1024_17/.test(code)) return cls("escrow_statements", "esign_or_mail", "12 CFR 1024.17");
  if (/^NTC_REGX_1024_37/.test(code) || fam === "FPI" || /^INS_FPI/.test(code)) return cls("fpi_notices", "esign_or_mail", "12 CFR 1024.37; Appendix MS-3");
  if (/^INS_/.test(code) || fam === "FLOOD") return cls("insurance", "esign_or_mail", "12 CFR 1024.37; 42 U.S.C. 4012a");
  if (fam === "REGF") return cls("regf_validation", "esign_or_mail", "12 CFR Part 1006");
  if (fam === "REGP") return cls("privacy", "electronic_ok_without_esign", "12 CFR Part 1016");
  if (fam === "ESIGN" || fam === "EDELIVERY") return cls("esign", "mail_only", "15 U.S.C. 7001");
  if (fam === "IRS") return cls("irs_estatement", "esign_or_mail", "26 CFR 1.6050H-2");
  if (fam === "HPA" || fam === "MI") return cls("mi_notices", "esign_or_mail", "12 U.S.C. 4901 et seq.");
  if (fam === "FCRA") return cls("credit_reporting", "esign_or_mail", "15 U.S.C. 1681s-2");
  if (fam === "PAYOFF" || /36C3/.test(code)) return cls("payoff", "electronic_ok_without_esign", "12 CFR 1026.36(c)(3)");
  if (fam === "SCRA") return cls("scra", "mail_only", "50 U.S.C. 3901 et seq.; HUD-92070");
  if (fam === "BK") return cls("bankruptcy", "mail_only", "Fed. R. Bankr. P. 3002.1");
  if (fam === "STATE" || fam === "CA" || fam === "NY" || fam === "TX" || fam === "IL" || fam === "MN" || fam === "NYDFS") return cls("state_notices", "mail_only", "state statute (see owner section)");
  if (fam === "FNMA") return cls("fnma_borrower_notices", "esign_or_mail", "Fannie Mae Servicing Guide");
  if (fam === "CLAIM" || fam === "LOSS" || fam === "DEFICIENCY" || fam === "EXPIRATION" || fam === "REMEDIATION" || fam === "COMPLAINT") return cls("servicing_general", "esign_or_mail", `owner section ${owner}`);
  return cls("servicing_general", "esign_or_mail", `owner section ${owner}`);
}

const OVERRIDES: Record<string, Partial<NoticeTemplate>> = {
  NTC_REGZ_20D_ARM_INITIAL: { separateDocument: true, mayCombineWith: ["NTC_REGZ_41_STMT_STD", "NTC_REGZ_41_STMT_DELQ"], citation: "12 CFR 1026.20(d); H-4(D)(3)/(4)" },
  NTC_REGZ_20C_ARM_ADJ: { citation: "12 CFR 1026.20(c); H-4(D)(1)/(2)" },
  NTC_REGX_39B_EARLY_INTERVENTION: { mayCombineWith: ["NTC_FNMA_D2_2_05_BSP_FORM745"], citation: "12 CFR 1024.39(b); Appendix MS-4(A)" },
  NTC_REGX_39C_EARLY_INTERVENTION_BK: { channelPolicy: "mail_only", citation: "12 CFR 1024.39(c)(1)(iii)" },
  NTC_REGZ_41_STMT_BK12_13: { citation: "12 CFR 1026.41(f); H-30(F)", channelPolicy: "mail_only" },
  NTC_REGZ_41_STMT_BK7_11: { citation: "12 CFR 1026.41(f); H-30(E)", channelPolicy: "mail_only" },
  NTC_ESIGN_WITHDRAWAL_CONFIRMATION: { channelPolicy: "mail_only", citation: "15 U.S.C. 7001(c); 7.4 rule 7" },
  NTC_EDELIVERY_BOUNCE_PAPER_RESUME: { channelPolicy: "mail_only", citation: "7.4 rule 8" },
  NTC_ESIGN_VERIFICATION_EMAIL: { channelPolicy: "electronic_ok_without_esign", citation: "15 U.S.C. 7001(c)(1)(C)(ii)" },
  NTC_ESIGN_CONSENT_CONFIRMATION: { channelPolicy: "electronic_ok_without_esign", citation: "15 U.S.C. 7001(c)" },
  NTC_TCPA_CONSENT_CONFIRMATION: { channelPolicy: "electronic_ok_without_esign", citation: "47 CFR 64.1200" },
  NTC_REGZ_41_STMT_TPP: { citation: "12 CFR 1026.41(d); comment 41(d)(1)-2" },
  NTC_REGZ_41_STMT_AVAIL_EMAIL: { channelPolicy: "electronic_ok_without_esign", citation: "comment 41(c)-3" },
  INS_FPI_FIRST_MS3A: { citation: "12 CFR 1024.37(c)(2); Appendix MS-3(A)", channelPolicy: "esign_or_mail" },
  INS_FLOOD_FPI_NOTICE_45: { separateDocument: true, mayCombineWith: ["INS_FPI_FIRST_MS3A"], citation: "42 U.S.C. 4012a(e)(1); RESPA §6(l)(4)" },
  INS_FPI_REMINDER_NOINFO_MS3B: { channelPolicy: "mail_only", citation: "12 CFR 1024.37(d)(2)(i); Appendix MS-3(B)" },
  INS_FPI_REMINDER_INSUFF_MS3C: { channelPolicy: "mail_only", citation: "12 CFR 1024.37(d)(2)(ii); Appendix MS-3(C)" },
  INS_FPI_RENEWAL_MS3D: { citation: "12 CFR 1024.37(e)(2); Appendix MS-3(D)" },
  NTC_REGX_1024_33B_HELLO_MS2: { citation: "12 CFR 1024.33(b); Appendix MS-2", mayCombineWith: ["NTC_REGP_1016_4_INITIAL_PRIVACY", "NTC_REGX_1024_17G_INITIAL_ESCROW_STMT"] },
  NTC_SM_ESCROW_VOLUNTARY_LUMPSUM_INSERT: { separateDocument: true, mayCombineWith: ["NTC_REGX_1024_17I_ANNUAL_ESCROW_STMT"], citation: "CFPB escrow FAQ; 12 CFR 1024.17(f)(3)" },
  NTC_HPA_4903A3_ANNUAL: { mayCombineWith: ["NTC_REGX_1024_17I_ANNUAL_ESCROW_STMT"], citation: "12 U.S.C. 4903(a)(3), (c)" },
  NTC_HPA_4903A3_ANNUAL_MN: { mayCombineWith: ["NTC_REGX_1024_17I_ANNUAL_ESCROW_STMT"], citation: "12 U.S.C. 4903(c); Minn. Stat. 47.207 subd. 3 'may be included with other federal disclosures'" },
  NTC_HPA_4903A3_ANNUAL_CA: { mayCombineWith: ["NTC_REGX_1024_17I_ANNUAL_ESCROW_STMT"], citation: "12 U.S.C. 4903(c); Cal. Civ. Code 2954.6 'with each written statement'" },
  NTC_HPA_4903B_ANNUAL_LEGACY: { mayCombineWith: ["NTC_REGX_1024_17I_ANNUAL_ESCROW_STMT"], citation: "12 U.S.C. 4903(b), (c)" },
  NTC_HPA_4904B_AUTO_NOT_CURRENT: { citation: "12 U.S.C. 4904(b)(2); B-8.1-04" },
  NTC_HPA_4905C2_LPMI_OPTIONS: { citation: "12 U.S.C. 4905(c)(2)" },
  NTC_MI_REFUND_ADVICE: { citation: "12 U.S.C. 4902(f); 10.5 outputs" },
  NTC_REGX_39D_EARLY_INTERVENTION_FDCPA: { mayCombineWith: ["NTC_FNMA_D2204_SOLICITATION_PACKAGE", "NTC_REGF_1006_34_VALIDATION_B1"], citation: "12 CFR 1024.39(d)(3); Appendix MS-4(D); comment 39(b)(2)-3" },
  NTC_REGX_39CD_EARLY_INTERVENTION_BK_FDCPA: { channelPolicy: "mail_only", citation: "12 CFR 1024.39(c)(1)(iii), (d)(3)" },
  NTC_FNMA_D2204_SOLICITATION_PACKAGE: { mayCombineWith: ["NTC_REGX_39B_EARLY_INTERVENTION", "NTC_REGX_39D_EARLY_INTERVENTION_FDCPA"], citation: "D2-2-04; 11.2-Q4 combined mailing" },
  NTC_REGB_1002_9_LM_ADVERSE_ACTION: { citation: "12 CFR 1002.9(a)(1), (b)(2); Fannie Mae Form 182; D2-2-05" },
  NTC_CA_2924_10_ACK: { channelPolicy: "mail_only", citation: "Cal. Civ. Code §2924.10 (written acknowledgment)" },
  NTC_FNMA_D2204_SOLICITATION: { mayCombineWith: ["NTC_REGX_39B_EARLY_INTERVENTION"], citation: "D2-2-04; 11.2-Q4 combined mailing" },
  NTC_FNMA_D23206_SOLICIT_STREAMLINED: { citation: "D2-3.2-06; 12 CFR 1024.41(c)(2)(ii) (incomplete-application disclosures when an application is open)" },
  NTC_STATE_PREFC_NY_1304: { channelPolicy: "mail_only", separateDocument: true, citation: "RPAPL §1304(2): separate envelope, registered/certified + first-class mail" },
  NTC_STATE_PREFC_NJ_NOI: { channelPolicy: "mail_only", citation: "N.J.S.A. 2A:50-56(b)" },
  NTC_STATE_PREFC_MA_35A: { channelPolicy: "mail_only", citation: "M.G.L. c.244 §35A(g)" },
  NTC_STATE_PREFC_TX_51002D: { channelPolicy: "mail_only", citation: "Tex. Prop. Code §51.002(d)" },
  NTC_STATE_PREFC_MD_NOI: { channelPolicy: "mail_only", citation: "Md. Real Prop. §7-105.1(c)" },
  NTC_STATE_PREFC_CA_2923_5_LETTER: { channelPolicy: "mail_only", citation: "Cal. Civ. Code §2923.5(e)(2)" },
  NTC_STATE_PREFC_WA_61_24_031_LETTER: { channelPolicy: "mail_only", citation: "RCW 61.24.031(5)" },
  NTC_STATE_PREFC_NV_107_5XX: { channelPolicy: "mail_only", citation: "NRS 107.510" },
  NTC_STATE_PREFC_GA_162_2: { channelPolicy: "mail_only", citation: "O.C.G.A. §44-14-162.2(a)" },
  NTC_SCRA_3953_STAY_CONFIRMATION: { channelPolicy: "mail_only", citation: "13.8 notices: mail" },
  NTC_REGF_1006_34_VALIDATION_B1: { mayCombineWith: ["NTC_REGX_1024_33B_HELLO_MS2", "NTC_REGX_39B_EARLY_INTERVENTION"], citation: "12 CFR 1006.34; 11.4-Q3 (enclosed with the hello letter)" },
  NTC_REGX_41B2_ACK_INCOMPLETE: { citation: "12 CFR 1024.41(b)(2)(i)(B)" },
  NTC_REGX_41B2_ACK_COMPLETE: { citation: "12 CFR 1024.41(b)(2)(i)(B)" },
};

/** Registry with every catalog template and the authored versions drafted; `publishAuthored` approves them. */
export function buildRegistry(): NoticeRegistry {
  const reg = new NoticeRegistry();
  for (const e of loadCatalog()) {
    const d = defaultsFor(e.code, e.owner_process);
    reg.register({ code: e.code, name: e.code.replace(/^(NTC|INS)_/, "").replace(/_/g, " ").toLowerCase(), ownerSection: e.owner_process, mentions: e.mentions, ...d, ...(OVERRIDES[e.code] ?? {}) });
  }
  for (const v of AUTHORED_VERSIONS) reg.draft(v);
  return reg;
}

/** Counsel approval of the authored versions (each must pass its own checklist to publish). */
export function publishAuthored(reg: NoticeRegistry, approvedBy = "counsel", approvedAt = "2026-09-01T00:00:00.000Z"): void {
  for (const v of AUTHORED_VERSIONS) reg.publish(v.templateCode, v.version, approvedBy, approvedAt, publishCheck);
}

// ------------------------------------------------------------------ authored versions
const R = (rule_id: string, citation: string, kind: ContentRule["kind"], selector: string, message: string, extra: Partial<ContentRule> = {}): ContentRule => ({ rule_id, citation, kind, selector, severity: "block", message, ...extra });

/** 7.1 periodic statement (H-30(B)); (d)(1)–(d)(8) as content rules; the worked example is the sample payload. */
const STATEMENT_SOURCE = `{{#block "amount_due" page=1 y=0.05 pt=14 bold}}Amount due {{money amount_due_cents}} — payment due date {{date due_date}}{{/block}}
{{#block "late_fee" page=1 y=0.12 pt=10}}If payment is received after {{date late_fee_after_date}}, a late fee of {{money late_fee_cents}} will be charged.{{/block}}
{{#block "explanation" page=1 y=0.2 pt=10}}Explanation of amount due: principal {{money principal_cents}}, interest {{money interest_cents}}, escrow {{money escrow_cents}}; fees and charges since last statement {{money fees_since_last_cents}}; past due {{money past_due_cents}}; total {{money amount_due_cents}}.{{/block}}
{{#block "past_payments" page=1 y=0.35 pt=10}}Payments received since last statement: {{money payments_since_last.total_cents}} (principal {{money payments_since_last.principal_cents}}, interest {{money payments_since_last.interest_cents}}, escrow {{money payments_since_last.escrow_cents}}, fees {{money payments_since_last.fees_cents}}, unapplied {{money payments_since_last.suspense_cents}}). Year to date: {{money ytd.total_cents}}; unapplied funds currently held {{money ytd.suspense_held_cents}}.{{/block}}
{{#if suspense_instructions}}{{#block "suspense" page=1 y=0.45 pt=10}}{{suspense_instructions}}{{/block}}{{/if}}
{{#block "transactions" page=2 y=0.1 pt=10}}Transaction activity: {{#each transactions}}{{date date}} {{description}} {{money amount_cents}}; {{/each}}{{/block}}
{{#block "contact" page=1 y=0.02 pt=10}}Supermortgage · {{servicer_phone}} · {{servicer_address}} · Notices of error and requests for information: {{exclusive_address}}{{/block}}
{{#block "account" page=1 y=0.03 pt=10}}Loan number ending {{account_last4}} · Unpaid principal balance {{money upb_cents}} · Interest rate {{pct rate_pct}}{{#if next_rate_change_date}} · Next rate change {{date next_rate_change_date}}{{/if}} · {{#if prepay_penalty}}A prepayment penalty may apply{{else}}No prepayment penalty{{/if}}{{/block}}
{{#block "counselor" page=2 y=0.9 pt=10}}Housing counselor information: {{counselor_url}} · HUD {{hud_phone}}{{/block}}
{{#if delinquency}}{{#block "delinquency" page=1 y=0.55 pt=10 bold}}As of {{date statement_date}} you are {{delinquency.days}} days delinquent; your first unpaid payment was due {{date delinquency.began_on}}. {{#each delinquency.history}}{{month}}: {{status}}; {{/each}}{{#if delinquency.lossmit_program}}Loss mitigation: {{delinquency.lossmit_program}}.{{else}}No loss mitigation program in place.{{/if}} {{#if delinquency.first_notice_filed}}Foreclosure has begun.{{else}}No foreclosure filing.{{/if}} Amount to bring the loan current: {{money delinquency.reinstatement_cents}}.{{/block}}{{/if}}
{{#if reminder_panel}}{{#block "reminder" page=1 y=0.7 pt=10}}{{borrower_name}}, we want to work with you to preserve homeownership. Late charges due: {{money late_charges_due_cents}}. Counseling: hud.gov · knowyouroptions.com{{/block}}{{/if}}
{{#block "body" page=2 y=0.5 pt=10}}Questions? Call {{servicer_phone}}.{{/block}}`;

const STATEMENT_RULES: ContentRule[] = [
  R("d1-amount-due", "§1026.41(d)(1)", "layout", "amount_due", "amount due and payment due date must be prominent on page 1", { layout: { page: 1, maxYFraction: 0.1, minFontRatio: 1.2 } }),
  R("d1-late-fee", "§1026.41(d)(1)(ii)", "presence", "late fee of \\$[\\d,]+\\.\\d{2} will be charged", "late-fee amount and date required"),
  R("d2-explanation", "§1026.41(d)(2)", "presence", "Explanation of amount due", "breakdown of P&I, escrow, fees, past due"),
  R("d3-past-payments", "§1026.41(d)(3)", "presence", "Payments received since last statement", "past payment breakdown incl. unapplied funds"),
  R("d3-ytd-suspense", "comment 41(d)(3)-1", "presence", "unapplied funds currently held", "YTD suspense held"),
  R("d4-transactions", "§1026.41(d)(4)", "layout", "transactions", "transaction activity list", {}),
  R("d5-suspense", "§1026.41(d)(5)", "conditional", "suspense_instructions", "partial-payment instructions when funds are in suspense", { when: { ">": [{ var: "ytd.suspense_held_cents" }, 0] }, predicate: { present: "suspense_instructions" } }),
  R("d6-contact", "§1026.41(d)(6); comment 35(c)-2", "presence", "Notices of error and requests for information", "servicer phone and exclusive NoE/RFI address"),
  R("d7-account", "§1026.41(d)(7)", "presence", "Unpaid principal balance .* Interest rate .* (No prepayment penalty|prepayment penalty may apply)", "account information: UPB, rate, prepayment penalty"),
  R("d7-next-rate-change", "§1026.41(d)(7)(iii)", "conditional", "next_rate_change_date", "next rate change date for ARMs", { when: { present: "next_rate_change_date" }, predicate: { present: "next_rate_change_date" } }),
  R("d8-delinquency", "§1026.41(d)(8)", "conditional", "delinquency", "delinquency information required when > 45 days delinquent", { when: { ">": [{ var: "regx_days_delinquent" }, 45] }, predicate: { present: "delinquency.began_on" } }),
  R("d8-delinquency-layout", "§1026.41(d)(8)", "conditional", "delinquency", "delinquency box on page 1", { when: { ">": [{ var: "regx_days_delinquent" }, 45] }, predicate: { present: "delinquency.reinstatement_cents" } }),
  R("counselor", "§1026.41(d)(8)(vii); D2-2-03", "presence", "Housing counselor information", "counselor URL and HUD phone"),
  R("amount-due-ties", "7.1 rule 2", "data_equality", "amount_due_cents", "amount due = current + past due + late charges + fees", { predicate: { "==": [{ var: "amount_due_cents" }, { var: "computed_amount_due_cents" }] } }),
  R("no-suspense-netting", "7.1 rule 2", "absence", "less (funds|amounts?) held in suspense", "suspense is disclosed, never netted against amount due", { severity: "warn" }),
];

const STATEMENT_SAMPLE: Record<string, unknown> = {
  statement_date: "2026-10-17", due_date: "2026-11-01", amount_due_cents: 907_379n, computed_amount_due_cents: 907_379n, late_fee_after_date: "2026-11-16", late_fee_cents: 11_671n,
  principal_cents: 41_750n, interest_cents: 191_679n, escrow_cents: 61_250n, fees_since_last_cents: 11_671n, past_due_cents: 589_358n, late_charges_due_cents: 23_342n,
  payments_since_last: { total_cents: 150_000n, principal_cents: 0n, interest_cents: 0n, escrow_cents: 0n, fees_cents: 0n, suspense_cents: 150_000n },
  ytd: { total_cents: 2_357_432n, suspense_held_cents: 150_000n },
  suspense_instructions: "We received $1,500.00, which is being held. We need $1,446.79 more to apply a full payment.",
  transactions: [{ date: "2026-10-09", description: "Payment received — unapplied", amount_cents: 150_000n }, { date: "2026-10-17", description: "Late fee", amount_cents: 11_671n }],
  servicer_phone: "(800) 555-0100", servicer_address: "PO Box 1, Testville TX 75001", exclusive_address: "PO Box 2, Testville TX 75001", account_last4: "1234",
  upb_cents: 39_802_456n, rate_pct: "5.750", next_rate_change_date: "2026-11-01", prepay_penalty: false, counselor_url: "consumerfinance.gov/find-a-housing-counselor", hud_phone: "(800) 569-4287",
  regx_days_delinquent: 46, borrower_name: "Bea Borrower", reminder_panel: true,
  delinquency: { days: 46, began_on: "2026-09-01", history: [{ month: "Sep", status: "$2,946.79 remaining" }, { month: "Oct", status: "$2,946.79 remaining" }], lossmit_program: null, first_notice_filed: false, reinstatement_cents: 612_700n },
};

/** 9.2 first force-placed notice, Appendix MS-3(A); (c)(2)(i)–(xi). */
const FPI_SOURCE = `{{#block "heading" page=1 y=0.05 pt=14 bold}}IMPORTANT NOTICE ABOUT YOUR HAZARD INSURANCE — PLEASE READ{{/block}}
{{#block "body" page=1 y=0.15 pt=12}}{{date notice_date}}. Loan number ending {{account_last4}}. Our records show that your {{insurance_type}} insurance {{status_phrase}} on {{date coverage_event_date}}. You must provide us with insurance information. We will purchase insurance on your property at your expense if you do not provide evidence of {{insurance_type}} insurance within 45 days. The insurance we buy may cost significantly more than insurance you can buy yourself and may provide less coverage. Insurance we purchase will cost an estimated {{money estimated_annual_premium_cents}} per year. To provide insurance information, contact us at {{servicer_phone}} or {{servicer_address}}; you may also send it to {{email}}. Property: {{property_address}}.{{/block}}
{{#block "bold_items" page=1 y=0.5 pt=12 bold}}You must provide insurance information within 45 days. We will charge you for the insurance we buy.{{/block}}`;
const FPI_RULES: ContentRule[] = [
  R("c2-i-date", "§1024.37(c)(2)(i)", "presence", "(January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4}", "date of the notice"),
  R("c2-ii-servicer", "§1024.37(c)(2)(ii)", "presence", "contact us at \\(\\d{3}\\) \\d{3}-\\d{4}", "servicer name and mailing address/phone"),
  R("c2-iii-borrower-account", "§1024.37(c)(2)(iii)", "presence", "Loan number ending \\d{4}", "borrower name and account number"),
  R("c2-iv-property", "§1024.37(c)(2)(iv)", "presence", "Property: ", "property address"),
  R("c2-v-statement", "§1024.37(c)(2)(v)", "presence", "insurance (is expiring|expired|provides insufficient coverage)", "reasonable-basis statement"),
  R("c2-vi-must-provide", "§1024.37(c)(2)(vi)", "presence", "must provide us with insurance information", "must maintain hazard insurance"),
  R("c2-vii-will-purchase", "§1024.37(c)(2)(vii)", "presence", "will purchase insurance on your property at your expense", "will purchase at borrower's expense — first notices always say 'will purchase' (9.2 rule 5)"),
  R("c2-viii-cost", "§1024.37(c)(2)(viii)", "presence", "may cost significantly more .* may provide less coverage", "cost/coverage warning"),
  R("c2-ix-estimate", "§1024.37(c)(2)(ix); comment 37(c)(2)(ix)-1", "presence", "cost an estimated \\$[\\d,]+\\.\\d{2} per year", "estimated annual premium"),
  R("c2-x-how-to-provide", "§1024.37(c)(2)(x)", "presence", "To provide insurance information", "how to provide evidence"),
  R("c2-xi-type", "§1024.37(c)(2)(xi)", "data_equality", "insurance_type", "insurance type stated", { predicate: { in: [{ var: "insurance_type" }, ["hazard", "wind", "flood"]] } }),
  R("bold-items", "§1024.37(c)(3)", "layout", "bold_items", "items in bold", { layout: { bold: true, page: 1 } }),
  R("nothing-else", "§1024.37(c)(4)", "absence", "(agent list|Spanish|enclosed brochure)", "nothing else on the notice pages; inserts on separate sheets"),
  R("no-bought-yet", "9.2 rule 5", "absence", "we (have )?bought", "'we bought' only after placement"),
];
const FPI_SAMPLE: Record<string, unknown> = { notice_date: "2026-10-05", account_last4: "1234", insurance_type: "hazard", status_phrase: "expired", coverage_event_date: "2026-10-01", estimated_annual_premium_cents: 219_000n, servicer_phone: "(800) 555-0100", servicer_address: "PO Box 1, Testville TX 75001", email: "insurance@example.com", property_address: "1 Test St, Testville TX 75001" };

/** 11.2 early-intervention written notice, MS-4(A); rule 8 content assembly; five items on page 1, 12-pt minimum. */
const EI_SOURCE = `{{#block "ms4a" page=1 y=0.05 pt=12 bold}}{{ms4a_sentence}}{{/block}}
{{#block "contact" page=1 y=0.15 pt=12}}Call your assigned team directly at {{team_phone}}. Write to us at {{servicer_address}}. Notices of error and requests for information: {{exclusive_address}}.{{/block}}
{{#block "options" page=1 y=0.3 pt=12}}Options that may be available: {{#each options}}{{this}}; {{/each}}Not all borrowers qualify.{{/block}}
{{#block "apply" page=1 y=0.5 pt=12}}Contact us for instructions on how to apply. A Mortgage Assistance Application (Form 710) is enclosed and available at {{upload_url}}. Documents we may request: {{#each document_list}}{{this}}; {{/each}}{{/block}}
{{#block "counseling" page=1 y=0.65 pt=12}}Housing counselors: {{cfpb_counselor_url}} · {{hud_counselor_url}} · HUD {{hud_phone}} · Fannie Mae HOPE hotline {{hope_hotline}} · knowyouroptions.com{{/block}}
{{#block "body" page=2 y=0.5 pt=12}}{{#if fdcpa_disclosure}}{{fdcpa_disclosure}}{{/if}}{{/block}}`;
const EI_RULES: ContentRule[] = [
  R("i-ms4a", "§1024.39(b)(2)(i); MS-4(A)", "layout", "ms4a", "MS-4(A) sentence on page 1", { layout: { page: 1, minPt: 12 } }),
  R("ii-contact", "§1024.39(b)(2)(ii); comment 35(c)-2", "presence", "Notices of error and requests for information", "team direct number + exclusive NoE/RFI address"),
  R("iii-options", "§1024.39(b)(2)(iii)", "presence", "Not all borrowers qualify", "generic examples of options with the qualifier"),
  R("iii-options-retention", "rule_sets.fnma.workout_hierarchy", "presence", "repayment plan; payment deferral; forbearance; loan modification", "retention options in hierarchy order"),
  R("iv-apply", "§1024.39(b)(2)(iv)", "presence", "Contact us for instructions on how to apply", "how to apply"),
  R("v-counseling", "§1024.39(b)(2)(v)", "presence", "HUD \\(\\d{3}\\) \\d{3}-\\d{4}", "CFPB/HUD counselor lists and HUD toll-free number"),
  R("hope-hotline", "Fannie Mae Form 745", "presence", "HOPE hotline", "Fannie Mae HOPE hotline"),
  R("page1-five-items", "11.2 rule 8", "layout", "counseling", "the five items sit on page 1", { layout: { page: 1, maxYFraction: 0.9 } }),
  R("min-12pt", "11.2 rule 8 clear-and-conspicuous", "layout", "options", "12-pt minimum", { layout: { minPt: 12 } }),
  R("fdcpa-no-amount", "§1024.39(d)(2); 11.2 rule 5", "conditional", "amount_due_cents", "FDCPA/bankruptcy variants carry no amount due or payment request", { when: { in: [{ var: "variant" }, ["fdcpa", "bk", "bk_fdcpa"]] }, predicate: { "!": { present: "amount_due_cents" } } }),
  R("fdcpa-disclosure", "12 CFR 1006.18(e)", "conditional", "fdcpa_disclosure", "§1006.18(e) disclosure on debt-collector loans", { when: { "==": [{ var: "fdcpa_debt_collector" }, true] }, predicate: { present: "fdcpa_disclosure" } }),
];
const EI_SAMPLE: Record<string, unknown> = { variant: "standard", fdcpa_debt_collector: false, ms4a_sentence: "You are late on your mortgage payments. Failing to bring your loan current may result in fees and foreclosure — the loss of your home.", team_phone: "(800) 555-0199", servicer_address: "PO Box 1, Testville TX 75001", exclusive_address: "PO Box 2, Testville TX 75001",
  options: ["repayment plan", "payment deferral", "forbearance", "loan modification (Flex Modification)", "short sale", "Mortgage Release (deed-in-lieu)"], upload_url: "portal.example.com/upload", document_list: ["pay stubs", "bank statements", "hardship letter"],
  cfpb_counselor_url: "consumerfinance.gov/find-a-housing-counselor", hud_counselor_url: "hud.gov/counseling", hud_phone: "(800) 569-4287", hope_hotline: "(888) 995-4673" };

/** 7.3 ARM initial (d) notice, H-4(D)(3); separate document. */
const ARM_D_SOURCE = `{{#block "heading" page=1 y=0.05 pt=14 bold}}Important notice: your interest rate and payment will change on {{date change_date}}{{/block}}
{{#block "schedule" page=1 y=0.15 pt=11}}Your rate will change on {{date change_date}} and {{schedule_sentence}}; the first payment at the new rate is due {{date first_new_payment_due}}.{{/block}}
{{#block "estimate" page=1 y=0.25 pt=11}}Estimated new rate {{pct estimated_rate_pct}} (estimated) based on the {{index_name}} published {{date index_date}} of {{index_value}} plus a margin of {{pct margin_pct}}; estimated new payment {{money estimated_payment_cents}} (estimated) versus your current payment {{money current_payment_cents}}.{{/block}}
{{#block "caps" page=1 y=0.4 pt=11}}Your rate cannot increase or decrease by more than {{pct first_cap_pct}} at this change, by more than {{pct periodic_cap_pct}} at later changes, or ever exceed {{pct lifetime_cap_pct}}; it will never fall below {{pct floor_pct}}.{{/block}}
{{#block "balance" page=1 y=0.5 pt=11}}Expected balance {{money expected_upb_cents}} over {{remaining_term_months}} months. No prepayment penalty.{{/block}}
{{#block "alternatives" page=1 y=0.6 pt=11}}If you are unable to afford the new payment, you may: refinance your loan with us or another lender; sell your home and use the proceeds to pay off your current loan; modify the terms of your loan with us; seek payment forbearance from us; or contact a housing counselor. Call {{toll_free}}. CFPB: {{cfpb_url}} · HUD (800) 569-4287 · {{state_hfa_contact}}{{/block}}
{{#block "body" page=1 y=0.9 pt=11}}The actual rate and payment will be sent between two and four months before {{date first_new_payment_due}}.{{/block}}`;
const ARM_D_RULES: ContentRule[] = [
  R("ii-schedule", "§1026.20(d)(2)(ii)", "presence", "every (six|6) months thereafter", "schedule sentence"),
  R("iii-estimated", "§1026.20(d)(2)(iii)", "presence", "\\(estimated\\)", "estimates are labeled"),
  R("iv-index", "§1026.20(d)(2)(iv)", "presence", "based on the .* published", "index and source"),
  R("v-caps", "§1026.20(d)(2)(v)", "presence", "cannot increase or decrease by more than", "caps and floor"),
  R("vi-balance", "§1026.20(d)(2)(vi)", "presence", "Expected balance", "balance and term"),
  R("viii-prepay", "§1026.20(d)(2)(viii)", "presence", "prepayment penalty", "prepayment penalty statement"),
  R("ix-phone", "§1026.20(d)(2)(ix)", "presence", "Call \\(\\d{3}\\) \\d{3}-\\d{4}", "toll-free number"),
  R("x-alternatives", "§1026.20(d)(2)(x)", "presence", "refinance your loan .* sell your home .* modify the terms .* forbearance .* housing counselor", "alternatives verbatim"),
  R("xi-cfpb-hud-hfa", "§1026.20(d)(2)(xi)", "presence", "HUD \\(800\\) 569-4287", "CFPB URL, HUD number, state HFA"),
  R("index-recency", "§1026.20(d); 7.3 rule 3", "data_range", "index_age_business_days", "index within 15 business days of disclosure", { range: { max: 15 } }),
  R("timing-window", "§1026.20(d)(1)", "data_range", "days_before_first_payment", "sent 210–240 days before the first new payment", { range: { min: 210, max: 240 } }),
];
const ARM_D_SAMPLE: Record<string, unknown> = { change_date: "2026-11-01", first_new_payment_due: "2026-12-01", schedule_sentence: "every six months thereafter", estimated_rate_pct: "6.375", index_name: "30-day Average SOFR", index_date: "2026-04-20", index_value: "3.64381", margin_pct: "2.750", estimated_payment_cents: 247_644n, current_payment_cents: 233_429n, first_cap_pct: "2.000", periodic_cap_pct: "1.000", lifetime_cap_pct: "10.750", floor_pct: "2.750", expected_upb_cents: 37_104_886n, remaining_term_months: 300, toll_free: "(800) 555-0100", cfpb_url: "consumerfinance.gov", state_hfa_contact: "TDHCA (800) 792-1119", index_age_business_days: 0, days_before_first_payment: 224 };

/** 12.1 acknowledgment of an incomplete application, §1024.41(b)(2)(i)(B). */
const ACK_SOURCE = `{{#block "body" page=1 y=0.1 pt=11}}We received your loss mitigation application on {{date received_date}}. Your application is incomplete. To complete it, please send: {{#each missing_documents}}{{this}}; {{/each}}by {{date reasonable_date}}. {{#if sale_date}}A foreclosure sale is scheduled for {{date sale_date}}.{{/if}} Contact your single point of contact at {{spoc_phone}}. Notices of error and requests for information: {{exclusive_address}}.{{/block}}`;
const ACK_RULES: ContentRule[] = [
  R("receipt", "§1024.41(b)(2)(i)(B)", "presence", "received your loss mitigation application on", "acknowledges receipt"),
  R("incomplete-list", "§1024.41(b)(2)(i)(B)", "presence", "please send: .+; by", "lists the missing documents"),
  R("reasonable-date", "§1024.41(b)(2)(ii)", "data_range", "days_to_reasonable_date", "reasonable date ≥ 7 days after the notice (comment 41(b)(2)(ii)-1)", { range: { min: 7 } }),
  R("noe-address", "comment 35(c)-2", "presence", "Notices of error and requests for information", "exclusive NoE/RFI address"),
  R("sent-within-5bd", "§1024.41(b)(2)(i)(B)", "data_range", "business_days_after_receipt", "sent within 5 business days of receipt", { range: { max: 5 } }),
];
const ACK_SAMPLE: Record<string, unknown> = { received_date: "2026-09-10", missing_documents: ["two most recent pay stubs", "most recent bank statement"], reasonable_date: "2026-10-15", sale_date: null, spoc_phone: "(800) 555-0177", exclusive_address: "PO Box 2, Testville TX 75001", days_to_reasonable_date: 30, business_days_after_receipt: 3 };

const V = (templateCode: string, source: string, contentRules: ContentRule[], samplePayload: Record<string, unknown>, ruleSet: string, sampleFormBasis: string): VersionInput =>
  ({ templateCode, version: "1.0.0", effectiveFrom: D("2026-09-01"), source, contentRules: contentRules.filter((r) => r.kind !== "layout"), layoutRules: contentRules.filter((r) => r.kind === "layout"), samplePayload, ruleSet, sampleFormBasis });

export const AUTHORED_VERSIONS: readonly VersionInput[] = [
  V("NTC_REGZ_41_STMT_STD", STATEMENT_SOURCE, STATEMENT_RULES, { ...STATEMENT_SAMPLE, regx_days_delinquent: 16, delinquency: null, amount_due_cents: 601_029n, computed_amount_due_cents: 601_029n, past_due_cents: 294_679n }, "regz.periodic_statement.2018", "H-30(B), 2018 edition"),
  V("NTC_REGZ_41_STMT_DELQ", STATEMENT_SOURCE, STATEMENT_RULES, STATEMENT_SAMPLE, "regz.periodic_statement.2018", "H-30(C), 2018 edition"),
  V("INS_FPI_FIRST_MS3A", FPI_SOURCE, FPI_RULES, FPI_SAMPLE, "regx.force_placed.2014", "Appendix MS-3(A)"),
  V("NTC_REGX_39B_EARLY_INTERVENTION", EI_SOURCE, EI_RULES, EI_SAMPLE, "regx.early_intervention.2016", "Appendix MS-4(A)"),
  V("NTC_REGZ_20D_ARM_INITIAL", ARM_D_SOURCE, ARM_D_RULES, ARM_D_SAMPLE, "regz.arm_notices.2013", "H-4(D)(3)"),
  V("NTC_REGX_41B2_ACK_INCOMPLETE", ACK_SOURCE, ACK_RULES, ACK_SAMPLE, "regx.lossmit.2013", "12.1 rule 5 worked example"),
  ...SECTION_01_VERSIONS,
  ...SECTION_03_VERSIONS,
  ...SECTION_04_VERSIONS,
  ...SECTION_07_VERSIONS,
  ...SECTION_08_VERSIONS,
  ...SECTION_09_VERSIONS,
  ...SECTION_10_VERSIONS,
  ...SECTION_11_VERSIONS,
  ...SECTION_12_VERSIONS,
  ...SECTION_13_VERSIONS,
];
