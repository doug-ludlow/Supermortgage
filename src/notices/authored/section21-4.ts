/**
 * §21.4 process-owned notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts) and
 * per-code channel/combination overrides. Spread by ../catalog.ts after the servicing files, so a version here
 * supersedes one there for the same code and effective date.
 *
 *   NTC_SM_RATE_LOCK_CONFIRMATION      the "lock agreement" (21.4 data model `notices`): borrower names, property, product, note rate,
 *                                       points/credits in dollars, lock period, expiration date and time with time zone (§1026.37(a)(13)(i)),
 *                                       extension/relock/float-down terms, fee refund rules, conditions, partner as lender, MLO name and NMLSR ID
 *                                       (§1026.36(g)); NY variant (3 NYCRR §38.6 content + applicant and lender signature blocks), NJ variant
 *                                       (N.J.A.C. 3:1-16.4(a) items + advisory), MA variant (honor-after-expiration statement).
 *   NTC_NY_3NYCRR_38_6_LOCK_EXPIRY_NOTICE  the separate written expiration notice sent 12–20 business days before expiry (§38.6(b)(4)); hard copy within 3 BD (b)(8).
 *   NTC_REGZ_1026_37_LE_REVISED         the revised LE's Rate Lock block (21.5 renders the full form): "YES, until <date> at <time> <zone>",
 *                                       closing-costs expiration blank once intent was given (comment 37(a)(13)-4), rate, points, credits, P&I.
 */
import type { ContentRule, NoticeTemplate, VersionInput } from "../registry.ts";
import { V } from "./section01.ts";

const R = (rule_id: string, citation: string, kind: ContentRule["kind"], selector: string, message: string, extra: Partial<ContentRule> = {}): ContentRule => ({ rule_id, citation, kind, selector, severity: "block", message, ...extra });
const DATE_RULE = R("date", "notice date", "presence", "(January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4}", "date of the notice");
const EXPIRY_DISPLAY = "\\d{2}/\\d{2}/\\d{4} at 5:00 p\\.m\\. [A-Z]{2,4}";
const FIXTURE = { borrower_names: ["Alex Fixture"], property_address: "4120 N 44th St, Phoenix AZ 85018", partner_name: "Partner Bank, N.A.", mlo_name: "Jordan Originator", mlo_nmlsr_id: "1234567", time_zone: "America/Phoenix" };

// ------------------------------------------------------------------ NTC_SM_RATE_LOCK_CONFIRMATION
const CONFIRMATION = `{{#block "heading" page=1 y=0.05 pt=14 bold}}Rate Lock Confirmation (Lock Agreement){{/block}}
{{#block "parties" page=1 y=0.1 pt=11}}{{date notice_date}}. Lender: {{partner_name}} (the creditor). Borrower(s): {{#each borrower_names}}{{this}}; {{/each}}Property: {{property_address}} ({{property_state}}).{{/block}}
{{#block "terms" page=1 y=0.2 pt=11 bold}}Your interest rate is locked at {{pct note_rate_pct}} for the {{product_code}} loan of {{money loan_amount_cents}} at a price of {{price_pct}} for {{lock_period_days}} days from {{date locked_on}}. The lock expires on {{expires_display}} ({{time_zone}}). Discount points: {{money points_cents}}. Lender credits: {{money lender_credit_cents}}. Lock-in fee: {{money lock_fee_cents}}. Commitment fee: {{money commitment_fee_cents}}.{{/block}}
{{#block "conditions" page=1 y=0.4 pt=10}}The locked rate, points and credits are subject to these conditions: the loan amount, product, property and occupancy stay as disclosed; the loan closes on or before the expiration date and time; the application is approved. Extensions: {{extension_terms}}. Relock: {{relock_terms}}. Float-down: {{float_down_terms}}. If the lock expires because of a delay caused by the lender or its agents, the locked terms are honored at the later closing at no cost to you. Any lock-in fee is refunded in full if the application is denied, if the appraisal is not favorable for the locked product, or if you withdraw.{{/block}}
{{#block "mlo" page=1 y=0.65 pt=10}}Terms approved by the loan originator of record: {{mlo_name}}, NMLSR ID {{mlo_nmlsr_id}}. This confirmation was prepared by an automated system; the loan originator named here approved the terms.{{/block}}
{{#if variant_ny}}{{#block "ny" page=2 y=0.1 pt=10}}New York (3 NYCRR §38.6): This lock-in agreement is binding on both the applicant and the lender when signed by the applicant and the lender. The lock-in fee and points will be refunded in full if the property appraisal report is not favorable for the product locked in, or if you supplied complete and correct credit information and are rejected as not creditworthy. A separate written notice of the expiration of this lock-in will be sent not less than 12 nor more than 20 business days before the expiration date. A hard copy of this agreement will be provided within three business days if you cannot download or print it. Applicant signature: ______________________ Date: ________ Lender signature ({{partner_name}}, by {{mlo_name}}): ______________________ Date: ________{{/block}}{{/if}}
{{#if variant_nj}}{{#block "nj" page=2 y=0.1 pt=10}}New Jersey (N.J.A.C. 3:1-16.4): The expiration date of the lock-in: {{date expires_on}}. The interest rate locked in: {{pct note_rate_pct}}. The discount points locked in: {{money points_cents}}. The commitment fee locked in: {{money commitment_fee_cents}}. The lock-in fee: {{money lock_fee_cents}}. The lender shall make a good faith effort to process the mortgage loan application before the expiration date of the lock-in agreement and any extension thereof. If the loan applied for is denied, the lender shall promptly refund any lock-in fee paid. This agreement becomes effective when signed by the lender; if it reached you by mail or through a broker, you may rescind it until you receive the lender-signed copy.{{/block}}{{/if}}
{{#if variant_ma}}{{#block "ma" page=2 y=0.1 pt=10}}Massachusetts (Division of Banks, Rate Lock Commitments): A rate lock commitment which, through no fault of the borrower, expires before the closing takes place will be honored at any closing subsequent to the expiration, including delays caused by the lender's agents, servicers or employees.{{/block}}{{/if}}`;
const CONFIRMATION_RULES: ContentRule[] = [
  DATE_RULE,
  R("heading-layout", "21.4 data model: the lock agreement", "layout", "heading", "heading on page 1, ≥ 12 pt, bold", { layout: { page: 1, minPt: 12, bold: true } }),
  R("rate", "12 CFR 1026.37(a)(13); comment 37(a)(13)-1 (locked 'at a given rate')", "presence", "locked at \\d+\\.\\d{3}% for the .* loan of \\$[\\d,]+\\.\\d{2}", "note rate to three decimals and the loan amount"),
  R("expiry-datetime-zone", "12 CFR 1026.37(a)(13)(i): the date and time (including the applicable time zone) when that period ends", "presence", `expires on ${EXPIRY_DISPLAY}`, "expiration date, time and time zone"),
  R("expiry-display-shape", "21.4 rule 4: 17:00 creditor time zone, disclosed as e.g. '11/23/2026 at 5:00 p.m. MST'", "data_equality", "expires_display", "expires_display carries the 5:00 p.m. + zone form", { predicate: { matches: ["expires_display", `^${EXPIRY_DISPLAY}$`] } }),
  R("points-credits", "12 CFR 1026.37(f)(1) points; section J credits — in dollars (21.4 rule 5)", "presence", "Discount points: \\$[\\d,]+\\.\\d{2}\\. Lender credits: \\$[\\d,]+\\.\\d{2}", "points and lender credits in dollars"),
  R("period", "21.4 open question 3: periods 15/30/45/60 days; best-efforts commitment ≤ 90 days", "data_range", "lock_period_days", "lock period between 1 and 90 days", { range: { min: 1, max: 90 } }),
  R("mlo", "12 CFR 1026.36(g); 21.4 rule 11: approval reproduced with the MLO's NMLSR ID", "presence", "NMLSR ID \\d+", "MLO of record name and NMLSR ID"),
  R("automation", "baseline §8.10: the AI discloses automation", "presence", "prepared by an automated system", "automation disclosure"),
  R("lender-delay", "MA Division of Banks letter applied nationally (21.4 rule 6)", "presence", "honored at the later closing at no cost to you", "lender-caused delay honored"),
  R("refund", "3 NYCRR 38.6(b)(1)–(2); N.J.A.C. 3:1-16.4(c); 21.4 edge cases", "presence", "refunded in full", "fee refund rules"),
  R("no-free-lock-claim", "21.4 AI design guardrail: never quote 'no cost to lock' when a lock fee exists", "absence", "no cost to lock", "no 'no cost to lock' claim", { when: { ">": [{ var: "lock_fee_cents" }, 0] } }),
  R("ny-signatures", "3 NYCRR 38.6(b)(3): binding when signed by the applicant and the lender; (b)(5) digital signatures", "presence", "Applicant signature: .* Lender signature", "NY applicant and lender signature blocks", { when: { "==": [{ var: "variant_ny" }, true] } }),
  R("ny-content", "3 NYCRR 38.6(b)(1)–(2), (b)(4), (b)(8)", "presence", "not less than 12 nor more than 20 business days", "NY expiration-notice statement", { when: { "==": [{ var: "variant_ny" }, true] } }),
  R("nj-items", "N.J.A.C. 3:1-16.4(a): expiration date, rate, points, commitment fee, lock-in fee and the advisory statement", "presence", "The lock-in fee: \\$[\\d,]+\\.\\d{2}\\. The lender shall make a good faith effort", "NJ §3:1-16.4(a) items", { when: { "==": [{ var: "variant_nj" }, true] } }),
  R("ma-honor", "Massachusetts Division of Banks industry letter (July 31, 2003)", "presence", "honored at any closing subsequent to the expiration", "MA honor-after-expiration statement", { when: { "==": [{ var: "variant_ma" }, true] } }),
];
/** Worked example 1: 6.125 % / 100.000, 45 days from Wed Oct 7, 2026 → Sat Nov 21 rolled to Mon Nov 23, 2026 5:00 p.m. MST; no points; the −$2,617 credit is the SM-borne-cost credit (21.2 rule 6), not rate-dependent. */
const CONFIRMATION_SAMPLE = { ...FIXTURE, notice_date: "2026-10-07", property_state: "AZ", product_code: "FRM30_CONV", note_rate_pct: "6.125", price_pct: "100.000", points_cents: 0n, lender_credit_cents: 0n, loan_amount_cents: 56_000_000n, lock_period_days: 45, locked_on: "2026-10-07", expires_on: "2026-11-23",
  expires_display: "11/23/2026 at 5:00 p.m. MST", lock_fee_cents: 0n, commitment_fee_cents: 0n, extension_terms: "12.5 basis points of the loan amount per 7-day extension; a delay caused by the lender or its agents is extended at the lender's cost", relock_terms: "a relock after expiration is priced at the worse of the original and current price unless the delay was the lender's",
  float_down_terms: "one float-down per lock at 25 basis points to the market rate plus 0.125 %", variant_ny: false, variant_nj: false, variant_ma: false, state_agreement_variant: null };

// ------------------------------------------------------------------ NTC_NY_3NYCRR_38_6_LOCK_EXPIRY_NOTICE
const NY_EXPIRY = `{{#block "heading" page=1 y=0.05 pt=14 bold}}Notice of Rate Lock-In Expiration (3 NYCRR §38.6(b)(4)){{/block}}
{{#block "body" page=1 y=0.12 pt=11}}{{date notice_date}}. {{#each borrower_names}}{{this}}; {{/each}}Property: {{property_address}}. Lender: {{partner_name}}. This is a separate written notice that the lock-in of your interest rate of {{pct note_rate_pct}}, locked on {{date locked_on}}, expires on {{date expires_on}} ({{expires_display}}). This notice is sent {{business_days_before_expiry}} business days before the expiration, within the required window of not less than 12 nor more than 20 business days ({{date window_opens_on}} to {{date window_closes_on}}). If your loan does not close by the expiration date and time, the locked rate, points and lock-in fee terms of your agreement will no longer apply unless the lock is extended or the delay was caused by the lender or its agents, in which case the locked terms are honored.{{/block}}
{{#if hard_copy_follow_up}}{{#block "hardcopy" page=1 y=0.6 pt=10}}Because you told us you cannot download or print this notice, a hard copy will follow within three business days (3 NYCRR §38.6(b)(8)).{{/block}}{{/if}}
{{#block "contact" page=1 y=0.85 pt=10}}Questions: contact {{partner_name}} through your loan originator of record.{{/block}}`;
const NY_EXPIRY_RULES: ContentRule[] = [
  DATE_RULE,
  R("heading-layout", "3 NYCRR 38.6(b)(4): a separate written notice", "layout", "heading", "heading on page 1, ≥ 12 pt, bold", { layout: { page: 1, minPt: 12, bold: true } }),
  R("separate", "3 NYCRR 38.6(b)(4)", "presence", "separate written notice", "states it is the separate expiration notice"),
  R("expiry", "3 NYCRR 38.6(b)(4); 12 CFR 1026.37(a)(13)(i)", "presence", `expires on (January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4} \\(${EXPIRY_DISPLAY}\\)`, "expiration date with time and zone"),
  R("window", "3 NYCRR 38.6(b)(4): not less than 12 business days nor more than 20 business days prior to the expiration (creditor calendar — 21.4 open question 6)", "data_range", "business_days_before_expiry", "sent 12–20 business days before expiry", { range: { min: 12, max: 20 } }),
  R("hard-copy", "3 NYCRR 38.6(b)(8): hard copy within three business days for applicants who cannot download or print", "presence", "hard copy will follow within three business days", "hard-copy follow-up statement", { when: { "==": [{ var: "hard_copy_follow_up" }, true] } }),
];
/** Worked example 3 (NY overlay): lock Mon Oct 26, 2026 for 30 days → Wed Nov 25; window Tue Oct 27 – Fri Nov 6 (creditor calendar, Veterans Day closed); sent Thu Oct 29 = 18 business days before expiry. */
const NY_EXPIRY_SAMPLE = { ...FIXTURE, notice_date: "2026-10-29", borrower_names: ["Casey Purchaser", "Riley Purchaser"], property_address: "88 Maple Ave, Albany NY 12203", note_rate_pct: "6.375", locked_on: "2026-10-26", expires_on: "2026-11-25", expires_display: "11/25/2026 at 5:00 p.m. MST",
  business_days_before_expiry: 18, window_opens_on: "2026-10-27", window_closes_on: "2026-11-06", hard_copy_follow_up: true };

// ------------------------------------------------------------------ NTC_REGZ_1026_37_LE_REVISED (Rate Lock block; 21.5 renders the full form)
const LE_REVISED = `{{#block "heading" page=1 y=0.03 pt=12 bold}}Loan Estimate — revised (version {{le_version}}){{/block}}
{{#block "ratelock" page=1 y=0.08 pt=11 bold}}Rate Lock: {{#if rate_locked}}YES, until {{lock_expires_display}}{{else}}NO{{/if}}.{{#unless intent_received}} Your interest rate, any points, and any lender credits can change unless you lock the interest rate. All other estimated closing costs expire on {{costs_expire_display}}.{{/unless}}{{/block}}
{{#block "terms" page=1 y=0.2 pt=11}}Loan amount {{money loan_amount_cents}}. Interest rate {{pct note_rate_pct}}. Monthly principal & interest {{money pi_cents}}. Points {{money points_cents}}. Lender credits −{{money lender_credit_cents}}. Reason for revision: {{revision_reason}} (12 CFR 1026.19(e)(3)(iv)({{basis}})). Issued {{date issued_on}}; due no later than {{date due_on}}.{{/block}}
{{#block "originator" page=3 y=0.9 pt=9}}Lender {{partner_name}} NMLS ID {{creditor_nmlsr_id}}. Loan officer {{mlo_name}} NMLS ID {{mlo_nmlsr_id}}.{{/block}}`;
const LE_REVISED_RULES: ContentRule[] = [
  R("ratelock-yes", "12 CFR 1026.37(a)(13)(i): locked → the date and time (including the applicable time zone) when that period ends", "presence", `Rate Lock: YES, until ${EXPIRY_DISPLAY}`, "Rate Lock YES with date, time and zone", { when: { "==": [{ var: "rate_locked" }, true] } }),
  R("ratelock-no", "12 CFR 1026.37(a)(13)(ii)", "presence", "Rate Lock: NO", "Rate Lock NO", { when: { "==": [{ var: "rate_locked" }, false] } }),
  R("costs-expire-blank-after-intent", "comment 37(a)(13)-4: once the consumer indicates an intent to proceed, the closing-costs expiration date and time are left blank on revised disclosures", "absence", "closing costs expire on", "no closing-costs expiration once intent was given", { when: { "==": [{ var: "intent_received" }, true] } }),
  R("costs-expire-before-intent", "12 CFR 1026.37(a)(13)(ii): the closing-costs expiration disclosure is required regardless of whether the rate is locked", "presence", "closing costs expire on", "closing-costs expiration before intent", { when: { "==": [{ var: "intent_received" }, false] } }),
  R("rate-dependent-terms", "12 CFR 1026.19(e)(3)(iv)(D): revised interest rate, points (§1026.37(f)(1)), lender credits and other rate-dependent charges", "presence", "Interest rate \\d+\\.\\d{3}%\\. Monthly principal & interest \\$[\\d,]+\\.\\d{2}\\. Points \\$[\\d,]+\\.\\d{2}\\. Lender credits −\\$[\\d,]+\\.\\d{2}", "rate, P&I, points and credits"),
  R("basis", "12 CFR 1026.19(e)(3)(iv)(A)–(F) (21.5 `basis`)", "data_equality", "basis", "the (e)(3)(iv) basis letter", { predicate: { in: [{ var: "basis" }, ["A", "B", "C", "D", "E", "F"]] } }),
  R("due", "12 CFR 1026.19(e)(3)(iv)(D): no later than three business days after the date the interest rate is locked", "presence", "due no later than", "the 3-business-day due date"),
  R("originator", "12 CFR 1026.36(g); §1026.37(k)", "presence", "NMLS ID \\d+\\. Loan officer .* NMLS ID \\d+", "creditor and loan officer NMLS IDs"),
  R("heading-layout", "12 CFR 1026.37(o): form H-24 layout", "layout", "heading", "heading on page 1", { layout: { page: 1, minPt: 10 } }),
];
/** Worked example 1: LE v2 Thu Oct 8, 2026 — Rate Lock "YES, until 11/23/2026 at 5:00 p.m. MST", closing-costs expiration blank (intent given Oct 6), 6.125 %, points $0, lender credits −$2,617, P&I $3,402.62, due Tue Oct 13. */
const LE_REVISED_SAMPLE = { ...FIXTURE, le_version: 2, rate_locked: true, lock_expires_display: "11/23/2026 at 5:00 p.m. MST", intent_received: true, costs_expire_display: "", loan_amount_cents: 56_000_000n, note_rate_pct: "6.125", pi_cents: 340_262n, points_cents: 0n, lender_credit_cents: 261_700n,
  revision_reason: "interest rate locked Wed Oct 7, 2026", basis: "D", issued_on: "2026-10-08", due_on: "2026-10-13", creditor_nmlsr_id: "7654321" };

export const VERSIONS_21_4: VersionInput[] = [
  V("NTC_SM_RATE_LOCK_CONFIRMATION", CONFIRMATION, CONFIRMATION_RULES, CONFIRMATION_SAMPLE, "sm.lock_policy.2026-09; regz.trid.2017", "21.4 data model `notices`: the lock agreement (NY/NJ/MA variants); worked example 1"),
  V("NTC_NY_3NYCRR_38_6_LOCK_EXPIRY_NOTICE", NY_EXPIRY, NY_EXPIRY_RULES, NY_EXPIRY_SAMPLE, "state.ny.3nycrr38.2026", "3 NYCRR §38.6(b)(4), (b)(8); 21.4 worked example 3 / T10"),
  V("NTC_REGZ_1026_37_LE_REVISED", LE_REVISED, LE_REVISED_RULES, LE_REVISED_SAMPLE, "regz.trid.2017", "12 CFR 1026.37(a)(13) Rate Lock block of the revised LE (H-24); 21.4 worked example 1 (21.5 renders the full form)"),
];
export const OVERRIDES_21_4: Record<string, Partial<NoticeTemplate>> = {
  NTC_SM_RATE_LOCK_CONFIRMATION: { citation: "12 CFR 1026.37(a)(13); 3 NYCRR 38.6; N.J.A.C. 3:1-16.4; MA Division of Banks letter (2003)", noticeClass: "disclosures.origination", channelPolicy: "esign_or_mail", separateDocument: true, retention: "regz_le_3y + fnma_loan_file_life_plus_4y", piiLevel: "high" },
  NTC_NY_3NYCRR_38_6_LOCK_EXPIRY_NOTICE: { citation: "3 NYCRR 38.6(b)(4), (b)(7)–(8)", noticeClass: "disclosures.origination", channelPolicy: "esign_or_mail", separateDocument: true, retention: "regz_le_3y + fnma_loan_file_life_plus_4y", piiLevel: "medium" },
  NTC_REGZ_1026_37_LE_REVISED: { citation: "12 CFR 1026.19(e)(3)(iv)(D); 1026.37(a)(13); Appendix H-24", noticeClass: "disclosures.origination", channelPolicy: "esign_or_mail", separateDocument: true, retention: "regz_le_3y", piiLevel: "high" },
};
