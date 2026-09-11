/**
 * The one-loan-for-life journey of src/runtime/lifecycle.test.ts as a reusable fixture for the borrower API tests: the
 * same sections' worked examples ($560,000 LCOR at 6.125% / 360 on $800,000 in Phoenix; 45-day lock; consummation Fri
 * Nov 6, 2026; disbursement Thu Nov 12; the Jan 1, 2027 installment; the Jan 29, 2027 payoff), driven through the REAL
 * bus tools over the hosted runtime's HTTP surface, in phases so a test can read the borrower_record between them
 * (application opened → LE delivered → intent → lock → … → funded and boarded → paid off). The application's borrowers
 * carry contact e-mails so the borrower API's one-time code links them to their parties (application_borrowers.party_id).
 *
 * Nothing here asserts the sections' figures — lifecycle.test.ts does; a phase fails loudly on any non-200 answer.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Db } from "../../../infra/db/client.ts";
import { decodeEntityData } from "../../../infra/db/entities.ts";
import { MemoryEventStore, type FixedClock, type DomainEvent } from "../../../kernel/events/index.ts";
import { createCasefile } from "../../../domain/underwriting/ops-23-1.ts";
import { makeMin } from "../../../domain/boarding/min.ts";
import { newDecisionFile } from "../../../domain/application/ops-21-6.ts";
import { REFI_OFFER_SAMPLE } from "../../../notices/authored/section20-2.ts";
import type { Runtime } from "../../app.ts";
import { loanCashState } from "../../servicing.ts";

type Actor = { kind: "agent" | "human" | "system"; id: string; role?: string };
export const INTAKE: Actor = { kind: "agent", id: "intake" }; const PRICING: Actor = { kind: "agent", id: "pricing" }; const DISCLOSURE: Actor = { kind: "agent", id: "disclosure" }; const VERIFICATION: Actor = { kind: "agent", id: "verification" }; const UNDERWRITER: Actor = { kind: "agent", id: "underwriter" }; const VALUATION: Actor = { kind: "agent", id: "valuation" }; const CLOSER: Actor = { kind: "agent", id: "title-closing" }; const FUNDER: Actor = { kind: "agent", id: "funder" }; const FRAUD_RISK: Actor = { kind: "agent", id: "fraud-risk" }; const COMPLIANCE: Actor = { kind: "agent", id: "compliance-tester" }; const FUNDING: Actor = { kind: "agent", id: "funding" }; export const CASHIERING: Actor = { kind: "agent", id: "cashiering" }; const PAYOFF: Actor = { kind: "agent", id: "payoff-release" };
export const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" }; export const MLO: Actor = { kind: "human", id: "u-mlo-rivera", role: "mlo_of_record" }; const APPROVER: Actor = { kind: "human", id: "u-funding-approver", role: "funding_approver" };
export const MST = (date: string, hhmm: string): string => new Date(`${date}T${hhmm}:00-07:00`).toISOString();
export const EDT = (date: string, hhmm: string): string => new Date(`${date}T${hhmm}:00-04:00`).toISOString();
export const EST = (date: string, hhmm: string): string => new Date(`${date}T${hhmm}:00-05:00`).toISOString();
type ToolResult = { output: Record<string, unknown>; events: (DomainEvent & { applicationId?: string; loanId?: string })[]; decisions: unknown[]; escalations: { id: string; kind: string }[] };

export interface JourneyOptions { readonly runtime: Runtime; readonly db: Db; readonly base: string; readonly token: string; readonly clock: FixedClock; readonly borrowerEmail: string; readonly coBorrowerEmail: string; readonly partnerPartyId: string }

export class Journey {
  readonly o: JourneyOptions;
  readonly leadId = randomUUID(); readonly R = this.leadId.slice(0, 8);
  priorLoanId = ""; appId = ""; loanId = ""; opportunityId = ""; touchId = ""; quoteId = ""; lockId = ""; commitmentId = ""; leDataHash = ""; creditReportId = ""; casefileId = ""; valuationOrderId = ""; cdDisclosureId = ""; closingSetId = ""; noteDataHash = ""; abIds: string[] = [];
  readonly custodial = { clearing: "", pi: "", ti: "" };
  /** 32.11 T8: the rescission facts 26.3 funds under when 25.3 computed `not_applicable` (same-creditor rate/term, §1026.23(f)(2)); null keeps the fixture's expired_not_rescinded. */
  rescissionOverride: Record<string, unknown> | null = null;
  private fundingFacts(as_of: string) { const f = this.FUNDING_FACTS(as_of); return this.rescissionOverride ? { ...f, rescission: { ...f.rescission, ...this.rescissionOverride, now: as_of } } : f; }
  readonly PARTNER_ID = "partner-1"; readonly PROGRAM_ID = `prog-refi-${this.R}`; readonly CAMPAIGN = `camp-refi-${this.R}`; readonly CREATIVE = `cr-email-${this.R}`; readonly SCRUB_ID = `scrub-${this.R}`; readonly QUOTE = `Q-A-${this.R}`; readonly FUNDING_ID = `F-${this.R}`; readonly CLOSING_ID = `CLS-${this.R}`; readonly SESSION_ID = `SES-${this.R}`; readonly CONSENT_ID = `CONS-${this.R}`; readonly decisionId = `D-REFI-CA-${this.R}`;
  readonly MIN = makeMin("1000123", String(1_000_000_000 + Number(BigInt("0x" + this.leadId.replace(/-/g, "").slice(8, 16)) % 8_999_999_999n)));
  constructor(o: JourneyOptions) { this.o = o; }
  private get clock() { return this.o.clock; }
  async call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const r = await fetch(this.o.base + path, { method, headers: { authorization: `Bearer ${this.o.token}`, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)) } : {}) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  }
  async tool(scope: { loan?: string; app?: string }, process: string, name: string, input: Record<string, unknown>, actor: Actor = INTAKE): Promise<ToolResult> {
    const path = scope.app ? `/v1/applications/${scope.app}/tools/${process}/${name}` : scope.loan ? `/v1/loans/${scope.loan}/tools/${process}/${name}` : `/v1/tools/${process}/${name}`;
    const r = await this.call("POST", path, { actor, input });
    assert.equal(r.status, 200, `${process} ${name}: ${JSON.stringify(r.body).slice(0, 900)}`);
    return r.body as unknown as ToolResult;
  }
  async entity(kind: string, id: string): Promise<Record<string, unknown> | null> { const rows = await this.o.db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = $1 AND id = $2`, [kind, id]); return rows[0] ? decodeEntityData(rows[0].data) : null; }
  async eventsOf(where: string, params: unknown[]) { return this.o.db.query<{ type: string; loan_id: string | null; application_id: string | null; sequence: string; payload: Record<string, unknown> }>(`SELECT type, loan_id, application_id, sequence::text, payload FROM loan_events WHERE ${where} ORDER BY sequence`, params); }

  // ---- fixtures (the sections' worked examples, verbatim from lifecycle.test.ts)
  private grid45 = (rows: [string, string][]) => rows.map(([r, p]) => ({ product_code: "FRM30", term_months: 360, note_rate_pct: r, lock_period_days: 45, price: p }));
  private PRICES = this.grid45([["6.375", "101.875"], ["6.250", "101.375"], ["6.125", "100.875"], ["6.000", "100.375"], ["5.875", "99.750"]]);
  private cost = (fee_code: string, description: string, mismo: string, le_section: string, vendor: string, amount_cents: string, provider_source = "creditor_selected_third_party", shoppable = false) => ({ fee_code, description, mismo_fee_type: mismo, le_section, vendor, amount_cents, provider_source, shoppable });
  private COST_ITEMS = [this.cost("credit_report", "Credit report", "CreditReportFee", "B_cannot_shop", "CRA", "8400"), this.cost("appraisal_hybrid", "Hybrid appraisal / PDC", "AppraisalFee", "B_cannot_shop", "AMC", "45000"), this.cost("flood_determination", "Flood determination", "FloodCertification", "B_cannot_shop", "FloodCo", "1000"),
    this.cost("title_lenders_policy", "Lender's title policy", "TitleLendersCoveragePremium", "C_can_shop", "Grand Canyon Title", "165000", "list_provider", true), this.cost("settlement_agent_fee", "Settlement fee", "TitleSettlementAgentFee", "C_can_shop", "Grand Canyon Title", "95000", "list_provider", true), this.cost("recording_fee", "Recording", "RecordingFeeForDeed", "E_taxes_gov", "Maricopa County", "6100", "government"), this.cost("ron_enote", "eNote / RON", "NotaryFee", "B_cannot_shop", "RON vendor", "28000")];
  private universeRow = () => ({ loan_id: this.priorLoanId, partner_id: this.PARTNER_ID, status: "active", product_code: "FRM30", amortization: "fixed", note_date: "2024-09-18", first_payment_date: "2024-11-01", consummation_date: "2024-09-18", title_date: "2019-06-14",
    original_upb_cents: "56500000", original_term_months: 360, note_rate_pct: "7.000", pi_cents: "375896", payments_made: 24, upb_cents: "55310641", next_due_date: "2026-11-01", remaining_term_months: 336,
    escrowed: true, escrow_monthly_cents: "55500", net_escrow_deposit_estimate_cents: "300000", taxes_annual_cents: "480000", insurance_annual_cents: "186000", mi_status: "none", mi_monthly_cents: "0", occupancy: "primary", property_type: "sfr", units: 1, property_state: "AZ", county: "Maricopa", county_limit_cents: "83275000",
    value_estimate: { source: "origination_indexed", value_cents: "80000000", as_of: "2026-09-30", confidence: "high" }, representative_score: 765, score_source: "origination_file",
    regx_days_delinquent: 0, bankruptcy_active: false, foreclosure_referred: false, lossmit_plan_active: false, deceased_or_sii_pending: false, transfer_out_pending: false, refi_do_not_solicit: false, refi_last_offered_at: null, refi_offers_12m: 0, arm_first_adjustment_date: null });
  private PARTNER = "[Partner]"; private PARTY = "B1"; private CELL = "+16025550142";
  private EMAIL_TEXT = `${this.PARTNER}, NMLSR ID 123456, is your current lender; Supermortgage services your loan for ${this.PARTNER}. Your current rate 7.000% → offered rate 6.125% (6.155% annual percentage rate (APR)); 360 monthly principal-and-interest payments of $3,402.62; fixed rate for the full term — the annual percentage rate will not increase. Payments do not include amounts for taxes and insurance premiums, and your actual payment obligation will be greater. No lender fees and no third-party closing costs charged to you; those costs are paid by Supermortgage and reflected in the rate offered. This is not a commitment to lend. Rates change daily. This is an advertisement from ${this.PARTNER}; unsubscribe: https://portal.example.com/u; ${this.PARTNER}, 100 Example Way, Anytown, AZ 85000.`;
  private SCRUB = { scrub_id: this.SCRUB_ID, source: "ftc_registry", registry_version_obtained_at: EDT("2026-09-28", "06:00"), obtained_on: "2026-09-28", valid_until: "2026-10-29", numbers_checked: 12_000, hits: 340, file_hash: "sha256:0928" };
  private INFORMATIONAL_CONSENT = () => ({ consent_id: `c-info-${this.R}`, party_id: this.PARTY, loan_id: this.priorLoanId, kind: "tcpa_voice", purpose: "informational", phone_number: this.CELL, status: "active", written_consent: false, pewc_elements: null, signature_kind: null, disclosure_version: null, disclosure_text_hash: null, captured_at: EDT("2025-10-14", "10:00"), written_confirmation_due_at: null, national_dnc_written_permission: false, evidence: { captured_via: "portal_enrollment" } });
  private QUOTE_INPUTS = { product_code: "FRM30", term_months: 360, amortization: "fixed", transaction_type: "limited_cash_out", occupancy: "primary", property_type: "sfr", units: 1, loan_amount_cents: "56000000", value_cents: "80000000", purchase_price_cents: null, representative_score: 768, score_model: "classic_fico", score_source: "soft_pull_2026-10-05", borrower_score_models: ["classic_fico"],
    state: "AZ", county: "Maricopa", county_limit_cents: "83275000", subordinate_financing_cents: "0", mi_option: "none", homeready: false, homeready_evaluation: null, first_time_homebuyer: false, fthb_ami_waiver: false, dts_waiver: false, very_low_income: false, lock_period_days: 45, expected_purchase_ready_date: "2026-11-19", escrowed: true, valuation_method: "hybrid", borrower_pays_third_party_costs: false,
    taxes_annual_cents: "480000", insurance_annual_cents: "186000", mi_annual_rate_pct: null, assumed_disbursement_date: "2026-11-12", first_payment_date: "2027-01-01" };
  private fee = (fee_code: string, description: string, le_section: string, mismo_fee_type: string, amount_cents: string, provider_source: string, shoppable: boolean, estimate_source: string, estimate_source_ref: string, finance_charge: boolean) => ({ fee_code, description, le_section, mismo_fee_type, amount_cents, provider_source, shoppable, estimate_source, estimate_source_ref, estimated_at: "2026-10-05", finance_charge });
  private LE_FEES = [this.fee("appraisal", "Appraisal Fee to AMC", "B_cannot_shop", "AppraisalFee", "65000", "creditor_selected_third_party", false, "vendor_quote", "AMC-Q-88121", false), this.fee("credit_report", "Credit Report Fee", "B_cannot_shop", "CreditReportFee", "7500", "creditor_selected_third_party", false, "fee_schedule", "N2-price-list-2026-09", false),
    this.fee("flood_cert", "Flood Determination Fee", "B_cannot_shop", "FloodCertification", "1200", "creditor_selected_third_party", false, "fee_schedule", "N6-flood-2026-09", false), this.fee("tax_service", "Tax Service Fee", "B_cannot_shop", "TaxServiceFee", "8500", "creditor_selected_third_party", false, "fee_schedule", "tax-svc-2026-09", true),
    this.fee("title_lenders_policy", "Title – Lender's Title Policy", "C_can_shop", "TitleLendersCoveragePremium", "115000", "list_provider", true, "vendor_quote", "N7-rate-engine-2026-10-05", false), this.fee("title_settlement", "Title – Settlement Agent Fee", "C_can_shop", "TitleSettlementAgentFee", "49500", "list_provider", true, "vendor_quote", "N7-rate-engine-2026-10-05", false),
    this.fee("title_endorsements", "Title – Endorsements", "C_can_shop", "TitleEndorsementFee", "15000", "list_provider", true, "vendor_quote", "N7-rate-engine-2026-10-05", false), this.fee("recording", "Recording Fees", "E_taxes_gov", "RecordingFeeForMortgage", "7000", "government", false, "county_table", "maricopa-recording-2026", false),
    this.fee("prepaid_interest", "Prepaid Interest ($93.97 per day for 19 days @ 6.125%)", "F_prepaids", "PrepaidInterest", "178543", "creditor", false, "pricing_engine", "disbursement-2026-11-12", true), this.fee("escrow_taxes", "Property Taxes $400.00 per month for 3 mo.", "G_initial_escrow", "PropertyTaxes", "120000", "none", false, "tax_bill", "maricopa-2026", false),
    this.fee("escrow_hoi", "Homeowner's Insurance $150.00 per month for 3 mo.", "G_initial_escrow", "HomeownersInsurance", "45000", "none", false, "insurance_policy", "policy-in-force", false), this.fee("lender_credit", "Lender Credits", "J_lender_credit", "LenderCredit", "-261700", "creditor", false, "pricing_engine", "Q-A-1005", false)];
  private LE_RENDER = () => ({ application_id: this.appId, disclosure_id: `LE-${this.appId.slice(0, 8)}`, as_of: "2026-10-05", loan_cents: "56000000", term_months: 360, transaction_type: "limited_cash_out", product: "Fixed Rate", pricing: { quote_id: this.QUOTE, rate_pct: "6.125", price: "100.000", points_cents: "0", lender_credit_cents: "261700", locked: false }, fees: this.LE_FEES,
    applicants: ["Alex Borrower", "Blake Borrower"], property_address: "100 N Central Ave, Phoenix, AZ 85004", estimated_value_cents: "80000000", creditor: { name: "Partner Bank, N.A.", nmlsr_id: "123456", email: "loans@partnerbank.example", phone: "(800) 555-0155" }, loan_officer: { name: "Jordan Rivera", nmlsr_id: "987654" }, escrow_monthly_cents: "55000", costs_expire_display: "10/20/2026 at 5:00 p.m. MST" });
  private ESIGN_CONSENT = { id: `CNS-ESIGN-${this.R}`, scope: ["disclosures", "notices", "closing_package"], granted_at: MST("2026-10-05", "10:20") };
  private JOINT_INTENT = { trid_received_at: MST("2026-10-05", "10:41"), borrowers: [{ id: "B1", joint_intent_affirmed_at: MST("2026-10-05", "10:20"), added_at: MST("2026-10-05", "10:05") }, { id: "B2", joint_intent_affirmed_at: MST("2026-10-05", "10:22"), added_at: MST("2026-10-05", "10:06") }] };
  private SDN_LISTS = [{ list: "ofac_sdn", version: "SLS-2026-10-05", published_on: "2026-10-05" }, { list: "ofac_consolidated", version: "CONS-2026-10-05", published_on: "2026-10-05" }];
  private BORROWER_IDENTITIES = [{ borrower_id: "B1", last_name: "Borrower", suffix: null, ssn_last4: "6789" }, { borrower_id: "B2", last_name: "Borrower", suffix: null, ssn_last4: "4321" }];
  private ULAD = () => ({ application_id: this.appId, loan_purpose: "limited_cash_out_refinance", occupancy: "principal_residence", product: "fixed_30", amortization: "fixed", loan_term: 360, property_type: "sfr_detached", sales_price_cents: null, appraised_value_cents: "80000000", loan_amount_cents: "56000000", note_rate_pct: "6.125", qualifying_income_cents: "1200000", total_obligations_cents: "456000", borrowers: this.BORROWER_IDENTITIES, max_ltv_pct: "95.00" });
  private msg = (id: string, category: string, text: string, borrower_id: string | null = null) => ({ id, category, text, borrower_id });
  private DU_MESSAGES = [this.msg("V1001", "verification", "Verify base income with the most recent paystub (30 days) and W-2 (1 year)", "B1"), this.msg("V1003", "verification", "Verbal verification of employment within 10 business days of the note date", "B1"), this.msg("V1006", "verification", "Verify 12-month mortgage payment history on the existing lien"), this.msg("V1008", "verification", "Obtain evidence of hazard insurance coverage"), this.msg("V1009", "verification", "Obtain the title commitment"), this.msg("V1010", "verification", "Obtain the payoff statement for the existing first mortgage"), this.msg("V1012", "verification", "Verify the borrowers' identity"), this.msg("V1014", "verification", "Obtain the flood zone determination")];
  private DU_FACTS = { transaction_type: "limited_cash_out", product: "standard", term_months: 360, ltv_x100: 7000, loan_amount_cents: "56000000", units: 1, county_limit_cents: null, score_model: "classic_fico", borrower_ids: ["B1", "B2"], all_occupying_first_time: false, all_borrowers_first_time: false, du_no_tradelines: false, closing_date: "2026-11-06" };
  private QM_OPEN = { qm_type: "general_safe_harbor", apr_test_pass: true, pf_pass: true, product_tests_pass: true, consider_verify_complete: true, consider_verify_missing: [], stage: "le", apor_stale: false, blocked_reason: null, computed_from_final_cd: false };
  private GUARD = { policy_outcome: "proceed", qm_facts: this.QM_OPEN, is_hoepa: false, is_state_high_cost: false, open_red_flag_investigations: 0 };
  private RISK = { credit: { score_model: "classic_fico", representative_score: 705, history_summary: "no 30-day lates in 24 months; revolving utilization 31%" }, capacity: { dti_bps: 3800, residual_income_cents: "744000", income_sources: ["base_salary"], income_reconciled_to_22_3: true }, capital: { funds_to_close_cents: "0", reserves_months: 6, assets_reconciled_to_22_4: true },
    collateral: { ltv_x100: 7000, cltv_x100: 7000, hcltv_x100: 7000, valuation_method: "traditional", cu_score: null }, du_risk_factors: ["limited_cash_out_refinance"], eligibility_outside_du_confirmed: true, legal_compliance_confirmed: true };
  private VALIDITY = { credit_expires_at: "2027-02-05", lock_expires_at: "2026-11-21", valuation_expires_at: "2027-02-06", du_close_by_date: "2026-12-07" };
  private CTC_CODES = ["CTC_DU_FINAL_MATCH", "CTC_PTD_ALL_CLEARED", "CTC_NO_OPEN_INVESTIGATION", "CTC_CREDIT_VALID", "CTC_DU_CLOSE_BY", "CTC_ASSETS_CASH_TO_CLOSE", "CTC_VALUATION", "CTC_PROPERTY_PROJECT", "CTC_TITLE", "CTC_INSURANCE_FLOOD", "CTC_MI", "CTC_COMPLIANCE", "CTC_EDUCATION", "CTC_LOCK", "CTC_IDENTITY_OFAC", "CTC_QC_PREFUNDING", "CTC_MLO_APPROVALS", "CTC_REGB_TIMING", "CTC_DECISION_VALID"];
  private CTC_FACTS = Object.fromEntries(this.CTC_CODES.map((c) => [c, { status: c === "CTC_MI" || c === "CTC_EDUCATION" ? "n/a" : "pass", ...(c === "CTC_INSURANCE_FLOOD" ? { evidence_ref: "doc-hoi-1" } : {}) }]));
  private FEE_TEST = { benchmark_id: "bench-az-013-urar", customary_and_reasonable: true, reason: "gross $650.00 within the p25–p75 band ($525.00–$700.00) of the Maricopa County URAR survey", gross_cents: "65000", appraiser_share_cents: "55000", amc_share_cents: "10000", held_for_requote: false };
  private AMC_REG = { amc_registration_id: `amcreg-az-${this.R}`, amc_party_id: "amc-1", state: "AZ", registration_number: "AMC-AZ-1234", expires_on: "2027-06-30", asc_amc_registry_status: "active", verified_at: MST("2026-10-01", "09:00") };
  private ORDER_PAYLOAD = { address: "100 N Central Ave, Phoenix AZ 85004", legal_description: "Lot 1, Block 2, Palm Estates", unit_count: 1, occupancy: "primary", transaction_type: "limited_cash_out", access_contact: { name: "Alex Borrower", phone: "602-555-0101" }, hoa_contact: null, scope: "traditional", form_code: "urar_uad36", uad_version: "3.6" };
  private CD_FEES = [{ fee_code: "underwriting", description: "Underwriting fee", amount_cents: "195000", section: "A_origination", tolerance_class: "zero", source_id: `SRC-CREDITOR-${this.R}` }, { fee_code: "tax_service", description: "Tax service fee", amount_cents: "8400", section: "B_cannot_shop", tolerance_class: "zero", source_id: `SRC-CREDITOR-${this.R}` },
    { fee_code: "title_lender_policy", description: "Title — Lender's policy", amount_cents: "120000", section: "C_can_shop", tolerance_class: "ten_percent", source_id: `SRC-SA-${this.R}` }, { fee_code: "settlement_fee", description: "Title — Settlement fee", amount_cents: "60000", section: "C_can_shop", tolerance_class: "ten_percent", source_id: `SRC-SA-${this.R}` }, { fee_code: "recording", description: "Recording fees", amount_cents: "3000", section: "E_taxes_gov", tolerance_class: "ten_percent", source_id: `SRC-SA-${this.R}` },
    { fee_code: "prepaid_interest", description: "Prepaid interest ($93.97 per day from 11/12/2026 to 12/01/2026)", amount_cents: "178543", section: "F_prepaids", tolerance_class: "unlimited", source_id: `SRC-CREDITOR-${this.R}` }, { fee_code: "escrow_deposit", description: "Initial escrow payment at closing", amount_cents: "206250", section: "G_initial_escrow", tolerance_class: "unlimited", source_id: `SRC-ESCROW-${this.R}` }];
  private CLOSING_SNAPSHOT = () => ({ application_id: this.appId, cd_version: 1, du_submission_number: "DU-1", lock_id: this.lockId, partner: { legal_name: "Partner Bank", nmlsr_id: "123456", mers_org_id: "1000123" }, mlo_of_record: { name: "Jordan Rivera", nmlsr_id: "987654" }, servicer: { name: "Supermortgage LLC", payment_address: "PO Box 1, Phoenix AZ 85001" },
    state: "AZ", county: "Maricopa", property_address: "100 N Central Ave, Phoenix, AZ 85004", legal_description: "Lot 1, Block 2, Palm Estates, per Book 100 of Maps, page 7, Maricopa County records", transaction_type: "limited_cash_out", occupancy: "primary", property_type: "sfr", units: 1, vesting: "individual", vesting_text: "Alex Borrower and Blake Borrower, as community property with right of survivorship",
    borrowers: [{ party_id: "B1", legal_name: "Alex Borrower", credit_used: true, on_title: true, capacities: ["borrower"] }, { party_id: "B2", legal_name: "Blake Borrower", credit_used: true, on_title: true, capacities: ["borrower"] }],
    loan_amount_cents: "56000000", note_rate_pct: "6.125", term_months: 360, product: "fixed", note_date: "2026-11-06", scheduled_disbursement_date: "2026-11-12", scheduled_closing_date: "2026-11-06", escrowed: true, rescindable: true,
    enote_default: true, partner_emortgage_approved: true, ron_authorized_state: true, settlement_agent_eclosing_eligible: true, borrower_declined_electronic: false, min: this.MIN });
  private DOCGEN_GATE = { final_cd_delivered: true, approval_ptd_cleared: true, trust_poa_gate_open: true, compliance_pass_cd_gate_open: true, lock_status: "active", lock_expires_on: "2026-12-07", closing_date: "2026-11-06" };
  readonly AGENT_PARTY = "P-ESCROW-AZ-1"; readonly NOTARY = { party_id: "N-AZ-1", commission_state: "AZ", commission_number: "AZ-123456", physical_location_state: "AZ" };
  readonly ELIGIBILITY = [{ settlement_agent_party_id: this.AGENT_PARTY, county_fips: null, ron_capable: true, ipen_capable: true, erecording_submitter: true, platforms: ["Snapdocs"], remote_witness_service: false, verified_at: "2026-10-20T00:00:00Z", verified_by: "title-closing" }];
  private CLOSING_CONSENT = { consent_id: this.CONSENT_ID, kind: "esign", scope: ["disclosures", "closing_package"], granted_at: MST("2026-10-05", "10:20"), withdrawn_at: null, hw_sw_statement_version: "2026-09", access_demonstrated: true, paper_option_disclosed: true };
  readonly SIGNERS = [{ party_id: "B1", esign_consented: true, identity_proofing_possible: true }, { party_id: "B2", esign_consented: true, identity_proofing_possible: true }];
  private PRE_SESSION_FACTS = { ctc: { ctc_issued: true, checklist_passed: true, decision_status: "active" }, le: { earliest_consummation_date: "2026-10-15" }, cd: { earliest_consummation_date: "2026-11-05", receipts_complete: true }, signing_package: [{ consumer_id: "B1", copies: 2, channel: "in_person", material_disclosures_in_package: true, receipt_capture: true }, { consumer_id: "B2", copies: 2, channel: "in_person", material_disclosures_in_package: true, receipt_capture: true }], fraud_hold: { fraud_hold: false }, compliance_consummate_gate_open: true, vvoe_within_10bd: true, mi_commitment_valid: true, lock_valid_through_closing: true };
  private VERIFIED_WIRE = { verification_id: `WV-${this.R}`, beneficiary_party_id: this.AGENT_PARTY, beneficiary_name: "Escrow Co Trust Account", instructions_hash: "h-verified", verified_at: "2026-11-03T15:00:00.000Z", expires_at: "2026-12-03T15:00:00.000Z", blocks_disbursement: false, change_detected_at: null, callback_number_source: "alta_registry", cpl_agent_party_id: this.AGENT_PARTY, ofac_screen_ref: "OFAC-1", ofac_clear: true };
  private FUNDING_FACTS = (as_of: string) => ({ as_of, funding: { funding_type: "dry", transaction_type: "limited_cash_out", disbursement_date: "2026-11-12", release_date: "2026-11-12", note_date: "2026-11-06", authorized: false },
    loan: { ltv_pct: 70, sfha: false, project: false, enote: true, tx_50a6: false, record_before_fund: false }, execution: { review_passed: true, all_docs_signed: true, blocking_defects: 0, package_returned: true }, cd: { consummated_version: 1, delivered_with_receipt: true, signed_copy_in_documents: true }, identity: { all_signers_proofed: true },
    rescission: { status: "expired_not_rescinded", expires_at: "2026-11-11T07:00:00.000Z", reasonably_satisfied_at: "2026-11-11T15:00:00.000Z", waiver_id: null, now: as_of }, hazard: { hazard_status: "verified", effective_date: "2026-11-12", transaction_type: "refinance", policy_in_force: true },
    title: { cpl_open: true, commitment_open: true }, vvoe: { verified_on: "2026-11-04", self_employed: false }, credit_refresh_open: true, compliance_disburse_open: true, ptf: { ptf_cleared: true }, cash_to_close: { worksheet: { reconciled_to_cd: true, sufficient: true } }, gifts: [], wire: { verified_at: this.VERIFIED_WIRE.verified_at, blocks_disbursement: false, callback_number_source: "alta_registry", as_of },
    payoffs: [{ liability_id: "L-PRIOR", status: "received", good_through_date: "2026-11-13" }], first_payment: { first_payment_date: "2027-01-01" }, audit_trail_open: true, enote: { registered: true, secured_party_set: true }, qc_hold: false, commitment: { active: true, expires_on: "2026-12-07" }, worksheet: { reconciled: true }, fraud: { fraud_hold: false, ofac_clear: true } });

  // ═══════════════ phases
  /** The servicing book: custodial accounts and the borrower's existing $565,000 / 7.000% loan (a1 pre-requisite). */
  async seedBook(): Promise<void> {
    const db = this.o.db;
    for (const kind of ["clearing", "pi", "ti"] as const) { const c = await db.query<{ id: string }>(`INSERT INTO custodial_accounts (partner_party_id, kind, remittance_type) VALUES ($1, $2, 'A/A') RETURNING id`, [this.o.partnerPartyId, kind]); this.custodial[kind] = c[0]!.id; }
    const prop = await db.query<{ id: string }>(`INSERT INTO properties (address_line1, city, state, postal_code, county, property_type, occupancy, units) VALUES ('100 N Central Ave', 'Phoenix', 'AZ', '85004', 'Maricopa', 'sfr', 'primary', 1) RETURNING id`);
    const fnma = String(1_000_000_000 + Math.floor(Math.random() * 8_999_999_999)).slice(0, 10);
    const prior = await db.query<{ id: string }>(`INSERT INTO loans (fnma_loan_number, servicer_loan_number, partner_party_id, property_id, status, instrument_date, origination_date, original_upb_cents, original_term_months, first_payment_date, maturity_date, boarded_at) VALUES ($1, $2, $3, $4, 'active', '2024-09-18', '2024-09-18', 56500000, 360, '2024-11-01', '2054-10-01', '2025-01-15T00:00:00Z') RETURNING id`, [fnma, `PRIOR-${randomUUID().slice(0, 8)}`, this.o.partnerPartyId, prop[0]!.id]);
    this.priorLoanId = prior[0]!.id;
  }
  /** a1–a4: pricing rows, the refinance trigger, the solicitation, the lead — and the application opened over HTTP (21.1) with the borrowers' e-mails; 20.3 converts the lead. */
  async openApplication(): Promise<string> {
    const { PARTNER_ID, PROGRAM_ID, CAMPAIGN, CREATIVE, R, leadId } = this; const clock = this.clock;
    clock.set(EDT("2026-09-10", "12:00")); await this.tool({}, "20.4", "loadLlpaTable", { op: "stage", matrix_version: "09.09.2026", activate: true }, PRICING);
    clock.set(EDT("2026-09-01", "12:00")); await this.tool({}, "20.4", "buildFeeItems", { op: "cost_schedule", cost_schedule_id: "cs-az-lcor-hybrid-2026-09", partner_id: PARTNER_ID, state: "AZ", transaction_type: "limited_cash_out", valuation_method: "hybrid", items: this.COST_ITEMS, effective_from: "2026-09-01" }, OFFICER);
    await this.tool({}, "20.1", "loadUniverse", { op: "register_program", program: { program_id: PROGRAM_ID, partner_id: PARTNER_ID } });
    clock.set(EDT("2026-10-01", "06:35")); await this.tool({}, "20.4", "publishRateSheet", { rate_sheet_id: "rs-2026-10-01", partner_id: PARTNER_ID, source: "pe_whole_loan_api", published_at: EDT("2026-10-01", "06:35"), expires_at: EDT("2026-10-01", "17:00"), prices: this.PRICES }, PRICING);
    const scope = { loan: this.priorLoanId };
    clock.set(EDT("2026-10-01", "06:41"));
    await this.tool(scope, "20.1", "loadUniverse", { op: "load_row", row: this.universeRow(), program_id: PROGRAM_ID, gate_facts: { fnma_purchase_date: null, declined_on: null, offered_at: [] } });
    const run = await this.tool(scope, "20.1", "emitOfferReady", { op: "run", run_id: `run-2026-10-01-${R}`, trigger_kind: "scheduled", program_id: PROGRAM_ID, loans: [this.universeRow()] });
    this.opportunityId = (run.output["opportunities"] as Record<string, unknown>[])[0]!["opportunity_id"] as string;
    await this.tool(scope, "20.1", "writeDecision", { opportunity_id: this.opportunityId, model_version: "intake-2026.09", prompt_version: "20.1-v1", confidence: 0.97 });
    clock.set(EDT("2026-10-01", "12:00"));
    await this.tool(scope, "20.2", "planChannels", { op: "create_campaign", campaign_id: CAMPAIGN, partner_id: PARTNER_ID, program_id: PROGRAM_ID, kind: "refi_trigger_outbound", channels: ["email"], selection_rule_set: "sm.refi_trigger.v1", creative_ids: [CREATIVE] });
    await this.tool(scope, "20.2", "renderCreative", { creative_id: CREATIVE, campaign_id: CAMPAIGN, channel: "email", template: this.EMAIL_TEXT, variables: {}, variables_schema: ["borrower_name", "offered_rate_pct"], rate_sheet_id: "rs-2026-10-01" });
    await this.tool(scope, "20.2", "renderCreative", { op: "approve", creative_id: CREATIVE, campaign_kind: "refi_trigger_outbound", sheet_rates_pct: ["6.125", "6.250", "6.000"], optout_offer_seconds: 2 }, OFFICER);
    clock.set(EDT("2026-10-01", "12:30")); await this.tool(scope, "20.2", "planChannels", { op: "approve_campaign", campaign_id: CAMPAIGN }, OFFICER);
    clock.set(EDT("2026-10-01", "13:00")); await this.tool(scope, "20.2", "planChannels", { op: "launch", campaign_id: CAMPAIGN }, OFFICER);
    clock.set(MST("2026-10-02", "09:00"));
    await this.tool(scope, "20.2", "scheduleTouch", { op: "complete_scrub", scrub_id: this.SCRUB.scrub_id, obtained_at: this.SCRUB.registry_version_obtained_at, numbers_checked: this.SCRUB.numbers_checked, hits: this.SCRUB.hits, file_hash: this.SCRUB.file_hash });
    const facts = { touch: { touch_id: `t-email-${R}`, campaign_id: CAMPAIGN, campaign_kind: "refi_trigger_outbound", creative_id: CREATIVE, channel: "email", party_id: this.PARTY, loan_id: this.priorLoanId, opportunity_id: this.opportunityId, destination: "borrower@example.com", destination_id: "email-1", line_type: null, queued_at: MST("2026-10-02", "09:00"), time_zones: ["America/Phoenix"], state: "AZ" },
      partner_name: this.PARTNER, consents: [this.INFORMATIONAL_CONSENT()], scrubs: [this.SCRUB], suppressions: [], on_national_registry: false, ebr: { last_transaction_on: "2026-10-01" }, rate_sheet_current: true };
    const sched = await this.tool(scope, "20.2", "scheduleTouch", { facts }); this.touchId = sched.output["touch_id"] as string;
    await this.tool(scope, "20.2", "scheduleTouch", { op: "send", touch_id: this.touchId, payload: { ...REFI_OFFER_SAMPLE, pi_cents: "340262", account_last4: "0001" }, recipient: { name: "Alex Borrower", mailing_address: "100 N Central Ave, Phoenix, AZ 85004", email: "borrower@example.com" } });
    await this.tool(scope, "20.1", "emitOfferReady", { op: "offered", opportunity_id: this.opportunityId });
    clock.set(MST("2026-10-05", "08:40"));
    await this.tool(scope, "20.3", "deliverDisclosure", { op: "create", lead_id: leadId, partner_id: PARTNER_ID, partner_name: "Partner Bank", channel: "refi_trigger", source_touch_id: this.touchId, opportunity_id: this.opportunityId, loan_id: this.priorLoanId, party_id: this.PARTY, consumer_state: "AZ", property_state: "AZ", property_address: "100 N Central Ave, Phoenix, AZ 85004", transaction_intent: "refinance", time_zone: "America/Phoenix" });
    clock.set(MST("2026-10-05", "08:41")); await this.tool(scope, "20.3", "deliverDisclosure", { op: "start", lead_id: leadId, interaction_id: `i-${R}`, channel: "web_chat", ai: true });
    await this.tool(scope, "20.3", "deliverDisclosure", { lead_id: leadId, interaction_id: `i-${R}`, notice_id: `n-disc-${R}` });
    clock.set(MST("2026-10-05", "08:43")); await this.tool(scope, "20.3", "authenticate", { lead_id: leadId, method: "portal_login" });
    clock.set(MST("2026-10-05", "08:47")); await this.tool(scope, "20.3", "captureConsent", { lead_id: leadId, kind: "credit_authorization", authorization_id: `auth-${R}`, authorization_kind: "soft_prequal", text_version: "soft-prequal-2026-09", channel: "web_chat", end_user: "partner", evidence: { ip: "203.0.113.5", user_agent: "fixture", session_id: `i-${R}` } });
    await this.tool(scope, "20.3", "orderSoftPull", { lead_id: leadId });
    clock.set(new Date("2026-10-05T08:47:30-07:00").toISOString()); await this.tool(scope, "20.3", "orderSoftPull", { lead_id: leadId, op: "receive", report_id: `rpt-${R}`, representative_score: 768 });
    clock.set(MST("2026-10-05", "09:28"));
    for (const [item, source, value] of [["name", "on_file_confirmed", "Alex Borrower"], ["property_address", "on_file_confirmed", "100 N Central Ave, Phoenix, AZ 85004"], ["value_estimate", "consumer_stated", "80000000"], ["loan_amount_sought", "consumer_stated", "56000000"]] as const) await this.tool(scope, "20.3", "explainProgram", { op: "record_trid_item", lead_id: leadId, item, source, value });
    await this.tool(scope, "20.1", "emitOfferReady", { op: "engaged", opportunity_id: this.opportunityId });
    clock.set(MST("2026-10-05", "09:35"));
    const r = await this.call("POST", "/v1/applications", { actor: INTAKE, application: {
      id: leadId, partner_party_id: this.o.partnerPartyId, channel: "refi_trigger", transaction_type: "limited_cash_out", occupancy: "primary", intake_channel: "voice", interview_language: "en-US", prior_loan_id: this.priorLoanId,
      borrowers: [{ legal_name: "Alex Borrower", borrower_role: "borrower", citizenship_status: "us_citizen", language_preference: "en", tin_last4: "6789", date_of_birth: "1985-06-15", contact: { email: this.o.borrowerEmail } }, { legal_name: "Blake Borrower", borrower_role: "co_borrower", tin_last4: "4321", date_of_birth: "1986-02-20", contact: { email: this.o.coBorrowerEmail } }],
      property: { address_line1: "100 N Central Ave", city: "Phoenix", state: "AZ", postal_code: "85004", county: "Maricopa", property_type: "sfr", units: 1 } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const app = r.body["application"] as { id: string; borrowers: { id: string }[] }; this.appId = app.id; this.abIds = app.borrowers.map((b) => b.id);
    await this.tool(scope, "20.3", "explainProgram", { op: "convert", lead_id: leadId, transaction_type: "limited_cash_out", occupancy: "primary", creditor_time_zone: "America/Phoenix", borrower_name: "Alex Borrower" });
    await this.tool(scope, "20.1", "emitOfferReady", { op: "converted", opportunity_id: this.opportunityId, application_id: this.appId });
    return this.appId;
  }
  /** a5: the 21.1 interview — six items → `application.trid_received` at 10:41 MST Oct 5 (REGZ_1026_19E1_LE_3BD due Oct 8). */
  async interview(): Promise<void> {
    const scope = { app: this.appId }; const clock = this.clock; const R = this.R;
    clock.set(MST("2026-10-05", "10:14"));
    await this.tool(scope, "21.1", "startInterview", { session_id: `S-${R}`, partner_name: "Partner Bank", partner_nmlsr_id: "123456", intake_channel: "voice", creditor_time_zone: "America/Phoenix", property_state: "AZ", property_address: "100 N Central Ave, Phoenix, AZ 85004", transaction_type: "limited_cash_out", occupancy: "primary", borrowers: [{ id: "B1", legal_name: "Alex Borrower", marital_status: "married" }, { id: "B2", legal_name: "Blake Borrower", marital_status: "married" }], model_version: "intake-2026.09", prompt_version: "p-1.4" });
    clock.set(new Date("2026-10-05T10:14:07-07:00").toISOString()); await this.tool(scope, "21.1", "discloseAI", { session_id: `S-${R}`, utterance_id: `utt-${R}`, state: "AZ" });
    clock.set(MST("2026-10-05", "10:16")); await this.tool(scope, "21.1", "captureField", { field: "credit_request", transaction_type: "limited_cash_out", occupancy: "primary", property_state: "AZ", identity_verified: true });
    await this.tool(scope, "21.1", "confirmPrefill", { op: "offer", item: "name", value: "Alex Borrower" }); await this.tool(scope, "21.1", "confirmPrefill", { item: "name" });
    clock.set(MST("2026-10-05", "10:18")); await this.tool(scope, "21.1", "captureField", { field: "ssn", value: "123-45-6789", borrower_id: "B1" });
    await this.tool(scope, "21.1", "confirmPrefill", { op: "offer", item: "property_address", value: "100 N Central Ave, Phoenix, AZ 85004" }); clock.set(MST("2026-10-05", "10:19")); await this.tool(scope, "21.1", "confirmPrefill", { item: "property_address" });
    clock.set(MST("2026-10-05", "10:27")); await this.tool(scope, "21.1", "captureField", { field: "income", value: "1480000", borrower_id: "B1" });
    clock.set(MST("2026-10-05", "10:33")); await this.tool(scope, "21.1", "captureField", { field: "property_value_estimate", value: "80000000" });
    clock.set(MST("2026-10-05", "10:41")); const sixth = await this.tool(scope, "21.1", "captureField", { field: "loan_amount_sought", value: "56000000" });
    assert.equal(sixth.output["trid_emitted"], true);
  }
  /** a6 (first half, before the LE): the Oct 5 sheet, 20.4's quote, the credit-report fee and 21.2's H-24 — a caller that delivers the LE its own way (32.13: by the parties' consents, `deliverLeByConsent`) stops here. */
  async quoteOnly(): Promise<void> {
    const scope = { app: this.appId }; const clock = this.clock; const R = this.R;
    clock.set(EDT("2026-10-05", "06:35")); await this.tool({}, "20.4", "publishRateSheet", { rate_sheet_id: "rs-2026-10-05", partner_id: this.PARTNER_ID, source: "pe_whole_loan_api", published_at: EDT("2026-10-05", "06:35"), expires_at: EDT("2026-10-05", "17:00"), prices: this.PRICES }, PRICING);
    clock.set(MST("2026-10-05", "10:45")); await this.tool(scope, "20.4", "solvePassThrough", { inputs: this.QUOTE_INPUTS, quote_id: this.QUOTE, purpose: "lead_quote", partner_id: this.PARTNER_ID, lead_id: this.leadId }, PRICING);
    clock.set(MST("2026-10-05", "10:50")); await this.tool(scope, "21.4", "checkFeeGate", { command: "order_credit_report", fee_kind: "credit_report", amount_cents: "7500", vendor_invoice_cents: "6850", op: "impose", fee_item_id: `fee-credit-report-${R}`, method: "card_token", checked_at: MST("2026-10-05", "10:50") }, PRICING);
    clock.set(MST("2026-10-05", "16:10")); const h24 = await this.tool(scope, "21.2", "renderH24", this.LE_RENDER(), DISCLOSURE); this.leDataHash = h24.output["data_hash"] as string;
  }
  /** a6 (first half): the Oct 5 sheet, 20.4's quote, the credit-report fee, 21.2's H-24 and the LE delivered and e-signed Oct 5. */
  async quoteAndLe(): Promise<void> {
    await this.quoteOnly(); const R = this.R;
    const le = await this.call("POST", `/v1/applications/${this.appId}/disclosures/le`, { actor: MLO, render: this.LE_RENDER(), mlo: { review_id: `MR-LE-${R}`, nmlsr_id: "987654" }, delivery: { channel: "esign_portal", at: MST("2026-10-05", "16:10"), consent: this.ESIGN_CONSENT, receipt: { kind: "esignature", at: MST("2026-10-05", "17:42"), borrower_id: "B1" } } });
    assert.equal(le.status, 200, JSON.stringify(le.body)); assert.equal(le.body["status"], "received");
  }
  /** a6: intent Tue Oct 6 09:14 MST through 21.4's own tool (the borrower API's `intent.record` is the other way in). */
  async recordIntent(): Promise<void> {
    this.clock.set(MST("2026-10-06", "09:14"));
    const intent = await this.tool({ app: this.appId }, "21.4", "recordIntent", { channel: "app_button", statement_text: "I want to proceed with this Loan Estimate", evidence_document_id: `evt-app-tap-${this.R}`, received_at: MST("2026-10-06", "09:14") }, PRICING);
    assert.equal(intent.output["valid"], true);
  }
  /** a6: Wed Oct 7 — the day's sheet and 21.4's quote at 10:05 MST (the lock's basis). */
  async quoteForLock(): Promise<string> {
    this.clock.set(EDT("2026-10-07", "06:35")); await this.tool({}, "20.4", "publishRateSheet", { rate_sheet_id: "rs-2026-10-07", partner_id: this.PARTNER_ID, source: "pe_whole_loan_api", published_at: EDT("2026-10-07", "06:35"), expires_at: EDT("2026-10-07", "17:00"), prices: this.PRICES }, PRICING);
    this.clock.set(MST("2026-10-07", "10:05"));
    const quote = await this.tool({ app: this.appId }, "21.4", "getQuote", { loan_amount_cents: "56000000", product_code: "FRM30_CONV", note_rate_pct: "6.125", lock_period_days: 45, at: MST("2026-10-07", "10:05") }, PRICING);
    this.quoteId = quote.output["quote_id"] as string; return this.quoteId;
  }
  /** a6: the lock requested through 21.4's own tool (pending the MLO). */
  async requestLock(): Promise<string> {
    const req = await this.tool({ app: this.appId }, "21.4", "requestLock", { quote_id: this.quoteId, borrower_statement: "Please lock my rate today", property_state: "AZ", le_loan_amount_cents: "56000000", requested_at: MST("2026-10-07", "10:05") }, PRICING);
    this.lockId = req.output["lock_id"] as string; assert.equal(req.output["status"], "pending_mlo_approval"); return this.lockId;
  }
  /** a6: the MLO approves at 10:19 MST, the lock executes at 6.125% for 45 days (expires Mon Nov 23), 29.1 takes the commitment. */
  async executeLockAndCommit(): Promise<void> {
    const scope = { app: this.appId }; this.clock.set(MST("2026-10-07", "10:19"));
    await this.tool(scope, "21.4", "executeLock", { lock_id: this.lockId, op: "approve", quote_id: this.quoteId, mlo_nmlsr_id: "987654", approved_at: MST("2026-10-07", "10:19") }, MLO);
    const lock = await this.tool(scope, "21.4", "executeLock", { lock_id: this.lockId, executed_at: MST("2026-10-07", "10:19") }, PRICING);
    assert.equal(lock.output["status"], "executed"); assert.equal(lock.output["expires_on"], "2026-11-23");
    const c = await this.tool(scope, "21.4", "requestCommitment", { lock_id: this.lockId, at: MST("2026-10-07", "10:20") }, PRICING); this.commitmentId = c.output["commitment_id"] as string;
  }
  /** 32.3 R2: identity, screening and the tri-merge credit order for both borrowers (Oct 5, 10:52 MST) — the first half of `verifyDecideAndClear`, alone. */
  async orderCredit(at: string = MST("2026-10-05", "10:52")): Promise<string> {
    const scope = { app: this.appId }; const clock = this.clock;
    clock.set(MST("2026-10-05", "11:00"));
    await this.tool(scope, "22.6", "verifyIdentity", { borrower_id: "B1", borrower_ids: ["B1", "B2"], scheduled_note_date: "2026-11-06" }, FRAUD_RISK);
    await this.tool(scope, "22.6", "verifyIdentity", { borrower_id: "B2", borrower_ids: ["B1", "B2"], scheduled_note_date: "2026-11-06" }, FRAUD_RISK);
    for (const [party, name] of [["B1", "Alex Borrower"], ["B2", "Blake Borrower"]] as const) await this.tool(scope, "22.6", "screenParty", { party_id: party, party_role: "borrower", name, lists: this.SDN_LISTS }, FRAUD_RISK);
    clock.set(at);
    const order = await this.tool(scope, "22.2", "orderCreditReport", { borrower_ids: ["B1", "B2"], permissible_purpose: "credit_transaction_604a3A", certification_ref: "CERT-PARTNER-1681E-2026", borrower_authorization_ref: "AUTH-BLANKET-2026-10-05", subscriber_code: "SUB-PARTNER-0417", joint_intent_facts: this.JOINT_INTENT, at }, VERIFICATION);
    this.creditReportId = order.output["report_id"] as string;
    await this.tool(scope, "22.2", "parseCreditReport", { report_id: this.creditReportId }, VERIFICATION);
    return this.creditReportId;
  }
  /** 32.3 R8 / T20: 23.1's casefile → credit association → DU request → submission → findings at `findings_at`, interpreted by 23.2 at `interpreted_at` (SM_DU_CONDITIONS_SLA_4H). */
  async duSubmitAndInterpret(times: { findings_at: string; interpreted_at: string }): Promise<{ submission_id: string; interpretation_id: string | null; request_hash: string }> {
    const scope = { app: this.appId }; const clock = this.clock;
    clock.set(times.findings_at);
    const cf0 = createCasefile(new MemoryEventStore(clock), { application_id: this.appId, seller_number: "123456789", system_id_ref: "SYS-PARTNER-01", tsp_product_ref: "SM-TSP", score_model: "classic_fico", created_at: clock.now() }).casefile; this.casefileId = cf0.casefile_id;
    const report = await this.entity("credit_reports", this.creditReportId);
    await this.tool(scope, "23.1", "associateCredit", { casefile: cf0, reports: [report], borrowers: this.BORROWER_IDENTITIES, app_score_model: "classic_fico" }, UNDERWRITER);
    const built = await this.tool(scope, "23.1", "buildDuRequest", { casefile_id: this.casefileId, submission_type: "credit_and_underwriting", reason: "initial", snapshot: this.ULAD() }, UNDERWRITER);
    await this.tool(scope, "23.1", "submitCasefile", { casefile_id: this.casefileId, request: built.output["request"], projected_note_date: "2026-11-06", scif_facts: { borrowers: this.BORROWER_IDENTITIES.map((b) => ({ id: b.borrower_id, scif_presented_at: MST("2026-10-05", "10:20") })) } }, UNDERWRITER);
    const findings = await this.tool(scope, "23.1", "fetchFindings", { casefile_id: this.casefileId, submission_number: 1 }, UNDERWRITER);
    const submission = findings.output["submission"] as Record<string, unknown>;
    clock.set(times.interpreted_at);
    const interp = await this.tool(scope, "23.2", "parseFindings", { op: "interpret", submission_id: submission["submission_id"], submission_number: 1, recommendation: "approve_eligible", messages: this.DU_MESSAGES, validation_results: [], value_acceptance_offer: { offered: true, property_value_cents: "80000000" }, mi_requirement: { required: false, coverage_pct: null }, du_release: "2026-09-25", policy_generation: "2026_09_26", request_hash: built.output["request_hash"], findings_received_at: times.findings_at, facts: this.DU_FACTS }, UNDERWRITER);
    return { submission_id: String(submission["submission_id"]), interpretation_id: ((interp.output["interpretation"] as { interpretation_id?: string } | undefined)?.interpretation_id) ?? null, request_hash: String(built.output["request_hash"]) };
  }
  /** a7–a9: verifications, valuation, DU, the conditional approval (Oct 7), clear to close (Oct 29). */
  async verifyDecideAndClear(): Promise<void> {
    const scope = { app: this.appId }; const clock = this.clock; const R = this.R;
    clock.set(MST("2026-10-05", "11:00"));
    await this.tool(scope, "22.6", "verifyIdentity", { borrower_id: "B1", borrower_ids: ["B1", "B2"], scheduled_note_date: "2026-11-06" }, FRAUD_RISK);
    await this.tool(scope, "22.6", "verifyIdentity", { borrower_id: "B2", borrower_ids: ["B1", "B2"], scheduled_note_date: "2026-11-06" }, FRAUD_RISK);
    for (const [party, name] of [["B1", "Alex Borrower"], ["B2", "Blake Borrower"]] as const) await this.tool(scope, "22.6", "screenParty", { party_id: party, party_role: "borrower", name, lists: this.SDN_LISTS }, FRAUD_RISK);
    clock.set(MST("2026-10-05", "10:52"));
    const order = await this.tool(scope, "22.2", "orderCreditReport", { borrower_ids: ["B1", "B2"], permissible_purpose: "credit_transaction_604a3A", certification_ref: "CERT-PARTNER-1681E-2026", borrower_authorization_ref: "AUTH-BLANKET-2026-10-05", subscriber_code: "SUB-PARTNER-0417", joint_intent_facts: this.JOINT_INTENT, at: MST("2026-10-05", "10:52") }, VERIFICATION);
    this.creditReportId = order.output["report_id"] as string;
    await this.tool(scope, "22.2", "parseCreditReport", { report_id: this.creditReportId }, VERIFICATION);
    clock.set(MST("2026-10-08", "09:00"));
    await this.tool(scope, "22.1", "ingestDocument", { document_id: `doc-pay-${R}`, source_channel: "borrower_upload", sha256: "sha-doc-pay-1", subject_borrower_id: "B1", applicant_borrower_ids: ["B1", "B2"], page_count: 2 }, VERIFICATION);
    await this.tool(scope, "22.1", "classifyDocument", { document_id: `doc-pay-${R}`, doc_class: "paystub", confidence: 0.98 }, VERIFICATION);
    await this.tool(scope, "22.4", "declareAssets", { assets: [{ asset_id: `chk-${R}`, asset_type: "checking", borrower_ids: ["B1"], declared_balance_cents: "3124018", institution_name: "First Bank", account_last4: "1234", holder_names: ["Alex Borrower"] }], borrower_names: ["Alex Borrower", "Blake Borrower"] }, VERIFICATION);
    clock.set(MST("2026-10-06", "09:20"));
    await this.tool(scope, "24.1", "readDuOffer", {}, VALUATION);
    const vo = await this.tool(scope, "24.1", "placeOrder", { transaction_type: "limited_cash_out", occupancy: "primary", units: 1, property_type: "sfr", ltv_bps: 7000, fee_paid_by: "sm", fee_quote_cents: "65000", fee_test: this.FEE_TEST, property_state: "AZ", vendor_party_id: "amc-1", channel: "amc", amc_registration: this.AMC_REG, order_payload: this.ORDER_PAYLOAD, le_effective_receipt_date: "2026-10-05", ordered_at: MST("2026-10-06", "09:20"), time_zone: "America/Phoenix" }, VALUATION);
    this.valuationOrderId = vo.output["order_id"] as string;
    clock.set("2026-10-06T17:00:00.000Z");
    const cf0 = createCasefile(new MemoryEventStore(clock), { application_id: this.appId, seller_number: "123456789", system_id_ref: "SYS-PARTNER-01", tsp_product_ref: "SM-TSP", score_model: "classic_fico", created_at: clock.now() }).casefile; this.casefileId = cf0.casefile_id;
    const report = await this.entity("credit_reports", this.creditReportId);
    await this.tool(scope, "23.1", "associateCredit", { casefile: cf0, reports: [report], borrowers: this.BORROWER_IDENTITIES, app_score_model: "classic_fico" }, UNDERWRITER);
    const built = await this.tool(scope, "23.1", "buildDuRequest", { casefile_id: this.casefileId, submission_type: "credit_and_underwriting", reason: "initial", snapshot: this.ULAD() }, UNDERWRITER);
    await this.tool(scope, "23.1", "submitCasefile", { casefile_id: this.casefileId, request: built.output["request"], projected_note_date: "2026-11-06", scif_facts: { borrowers: this.BORROWER_IDENTITIES.map((b) => ({ id: b.borrower_id, scif_presented_at: MST("2026-10-05", "10:20") })) } }, UNDERWRITER);
    const findings = await this.tool(scope, "23.1", "fetchFindings", { casefile_id: this.casefileId, submission_number: 1 }, UNDERWRITER);
    const submission = findings.output["submission"] as Record<string, unknown>;
    clock.set("2026-10-06T17:12:00.000Z");
    const interp = await this.tool(scope, "23.2", "parseFindings", { op: "interpret", submission_id: submission["submission_id"], submission_number: 1, recommendation: "approve_eligible", messages: this.DU_MESSAGES, validation_results: [], value_acceptance_offer: { offered: true, property_value_cents: "80000000" }, mi_requirement: { required: false, coverage_pct: null }, du_release: "2026-09-25", policy_generation: "2026_09_26", request_hash: built.output["request_hash"], findings_received_at: "2026-10-06T17:00:00.000Z", facts: this.DU_FACTS }, UNDERWRITER);
    clock.set("2026-10-07T15:00:00.000Z");
    await this.tool(scope, "23.3", "assessRisk", { risk_input: this.RISK, decision_id: this.decisionId }, UNDERWRITER);
    const file = newDecisionFile({ application_id: this.appId, partner_name: "Partner Bank", partner_address: "100 Partner Plaza, Phoenix, AZ 85004", creditor_time_zone: "America/Phoenix", application_date: "2026-10-05", property_state: "AZ", applicants: [{ id: "B1", name: "Alex Borrower", mailing_address: "100 N Central Ave, Phoenix AZ 85004", email: "alex@example.com", esign_consent: true, primary: true }, { id: "B2", name: "Blake Borrower", mailing_address: "100 N Central Ave, Phoenix AZ 85004", email: "blake@example.com", esign_consent: true, primary: false }] });
    const approval = await this.tool(scope, "23.3", "issueConditionalApproval", { decision_id: this.decisionId, file, guard: this.GUARD, validity: this.VALIDITY, inputs: { ulad_snapshot_hash: built.output["request_hash"], verification_ids: ["ver-inc-1"], findings_hash: "findings:sub1" }, du_submission_id: submission["submission_id"], interpretation_id: interp.output["interpretation"] && (interp.output["interpretation"] as { interpretation_id?: string }).interpretation_id, evidence_document_ids: [`doc-pay-${R}`], rationale: "Approve/Eligible loan within policy; verified income, assets and liabilities reconcile to DU; no layering.", confidence: 0.94 }, UNDERWRITER);
    assert.equal(approval.output["valid_until"], "2026-11-21");
  }
  async clearToClose(): Promise<void> {
    const scope = { app: this.appId }; this.clock.set("2026-10-29T20:00:00.000Z");
    const checklist = await this.tool(scope, "23.3", "runCtcChecklist", { op: "ctc", decision_id: this.decisionId, facts: this.CTC_FACTS }, UNDERWRITER);
    const ctc = await this.tool(scope, "23.3", "issueClearToClose", { decision_id: this.decisionId, checklist: checklist.output }, UNDERWRITER);
    assert.equal(ctc.output["event"], "clear_to_close.issued");
  }
  /** a10: the closing scheduled Fri Nov 6 14:00 MST through 26.2's own tool (the borrower API's `closing.selectSlot` is the other way in). */
  async scheduleClosing(): Promise<void> {
    this.clock.set(MST("2026-11-02", "10:00"));
    const sch = await this.tool({ app: this.appId }, "26.2", "runPreSessionChecks", { op: "schedule", closing_id: this.CLOSING_ID, application_id: this.appId, scheduled_at: MST("2026-11-06", "14:00"), time_zone: "America/Phoenix", state: "AZ", county_fips: "04013", transaction_type: "limited_cash_out", dry_state: true, settlement_agent_party_id: this.AGENT_PARTY, notary_party_id: this.NOTARY.party_id, ron_provider_party_id: "P-RON-1", eligibility: this.ELIGIBILITY, signers: this.SIGNERS }, CLOSER);
    assert.equal(sch.output["closing_type"], "ron");
  }
  /** a10: 25.2's CD v1 rendered Mon Nov 2, e-delivered to both borrowers with e-sign receipts → earliest consummation Nov 5.
   *  `deliveries: false` (32.7) stops after `renderCd` so the caller delivers per consumer itself (channel, receipts, the mailbox rule). */
  async closingDisclosure(opts: { receipts?: boolean; deliveries?: boolean } = {}): Promise<string> {
    const scope = { app: this.appId }; const clock = this.clock; const R = this.R;
    clock.set(MST("2026-11-02", "10:00"));
    await this.tool(scope, "25.2", "assembleCdFigures", { op: "record_source", source_id: `SRC-SA-${R}`, party: "settlement_agent", payload: { fees: [{ fee_code: "title_lender_policy", amount_cents: "120000" }, { fee_code: "settlement_fee", amount_cents: "60000" }, { fee_code: "recording", amount_cents: "3000" }] }, payload_document_id: "DOC-SA-FEES" }, DISCLOSURE);
    await this.tool(scope, "25.2", "assembleCdFigures", { op: "record_source", source_id: `SRC-ESCROW-${R}`, party: "escrow", payload: { monthly_cents: "68750", deposit_cents: "206250" } }, DISCLOSURE);
    await this.tool(scope, "25.2", "reconcileFigureSources", { fees: this.CD_FEES }, DISCLOSURE);
    const apr = await this.tool(scope, "25.1", "computeApr", { loan_amount_cents: "56000000", note_rate_pct: "6.125", term_months: 360, term_start_date: "2026-11-12", first_payment_date: "2027-01-01", prepaid_finance_charges_cents: "384995", prepaid_interest_cents: "178543", checkpoint: "cd" }, COMPLIANCE);
    this.cdDisclosureId = `CD-${this.appId.slice(0, 8)}-1`;
    await this.tool(scope, "25.2", "renderCd", { disclosure_id: this.cdDisclosureId, cd_version: 1, transaction_type: "refinance", state: "AZ", required_consumer_ids: ["B1", "B2"],
      loan: { loan_amount_cents: "56000000", rate_pct: "6.125", term_months: 360, pi_cents: "340262", product: "Fixed Rate", loan_type: "Conventional", purpose: "Refinance", prepayment_penalty: false, balloon: false, arm: false, loan_id_number: this.appId, mic_number: null, first_payment_date: "2027-01-01", maturity_date: "2056-12-01" },
      apr: { apr_calculation_id: apr.output["apr_calculation_id"], apr_pct: apr.output["apr_disclosed_str"], finance_charge_cents: apr.output["finance_charge_cents"], amount_financed_cents: apr.output["amount_financed_cents"], total_of_payments_cents: apr.output["total_of_payments_cents"], tip_pct: String(Number(apr.output["tip_pct"]).toFixed(3)) },
      fees: this.CD_FEES, escrow: { established: true, monthly_escrow_cents: "68750", initial_escrow_payment_cents: "206250", escrowed_costs_year1_cents: "825000", non_escrowed_costs_year1_cents: "0" },
      parties: { borrowers: ["Alex Borrower", "Blake Borrower"], creditor_name: "Partner Bank, N.A.", creditor_nmlsr_id: "123456", mlo_name: "Jordan Rivera", mlo_nmlsr_id: "987654", settlement_agent_name: "Desert Title Agency LLC", settlement_agent_license_id: "AZ-TA-4471" },
      dates: { date_issued: "2026-11-02", closing_date: "2026-11-06", disbursement_date: "2026-11-12" }, property_address: "100 N Central Ave, Phoenix AZ 85004", cash_to_close_cents: "552943", lender_credits_cents: "70000", payoffs_and_payments_cents: "54820000", rescindable: true }, DISCLOSURE);
    if (opts.deliveries === false) return this.cdDisclosureId;
    clock.set(MST("2026-11-02", "09:14"));
    for (const consumer of ["B1", "B2"]) {
      await this.tool(scope, "25.2", "deliverDisclosure", { disclosure_id: this.cdDisclosureId, consumer_id: consumer, channel: "esign_portal", at: MST("2026-11-02", "09:14"), esign_consent_id: `ESIGN-${consumer}`, ...(consumer === "B1" ? { gate_run: { run_id: "RUN-CD-1", open: true, apr_verdict: "pass", blocked_channels: [] } } : {}) }, DISCLOSURE);
      if (opts.receipts !== false) await this.tool(scope, "25.2", "recordReceipt", { disclosure_id: this.cdDisclosureId, consumer_id: consumer, evidence: "esign_confirmed", at: MST("2026-11-02", "09:30"), evidence_document_id: `DOC-ESIGN-${consumer}` }, DISCLOSURE);
    }
    if (opts.receipts !== false) { const wp = await this.tool(scope, "25.2", "computeEarliestConsummation", { disclosure_id: this.cdDisclosureId }, DISCLOSURE); assert.equal(wp.output["earliest_consummation_date"], "2026-11-05"); }
    return this.cdDisclosureId;
  }
  /** a11–a12: the closing documents rendered and released, the RON session, the eNote signed 14:26 MST Nov 6 = consummation, sealed and registered. */
  async closeAndSign(opts: { snapshot?: Record<string, unknown> } = {}): Promise<void> {
    const scope = { app: this.appId }; const clock = this.clock; const R = this.R; const snapshot = { ...this.CLOSING_SNAPSHOT(), ...(opts.snapshot ?? {}) };
    clock.set(MST("2026-11-04", "10:00"));
    const terms = await this.tool(scope, "26.1", "computeNoteTerms", { principal_cents: "56000000", note_rate_pct: "6.125", term_months: 360, scheduled_disbursement_date: "2026-11-12", state: "AZ" }, CLOSER);
    const g = await this.tool(scope, "26.1", "evaluateDocGenGates", { gate: this.DOCGEN_GATE }, CLOSER); this.closingSetId = g.output["set_id"] as string;
    await this.tool(scope, "26.1", "takeClosingSnapshot", { set_id: this.closingSetId, snapshot, gate: this.DOCGEN_GATE }, CLOSER);
    const rendered = await this.tool(scope, "26.1", "renderDocument", { set_id: this.closingSetId }, CLOSER);
    const docs = rendered.output["documents"] as { document_id: string; kind: string; data_hash: string }[]; this.noteDataHash = docs.find((d) => d.kind === "enote")!.data_hash; assert.equal(this.noteDataHash, terms.output["data_hash"]);
    const smart = await this.tool(scope, "26.1", "buildSmartDocENote", { set_id: this.closingSetId }, CLOSER);
    await this.tool(scope, "26.1", "runDocumentQc", { set_id: this.closingSetId, upstream: { enote: smart.output, cd: { loan_amount_cents: "56000000", note_rate_pct: "6.125", pi_cents: "340262", org_nmlsr_id: "123456", mlo_nmlsr_id: "987654", first_payment_date: "2027-01-01" }, du: { loan_amount_cents: "56000000", note_rate_pct: "6.125", term_months: 360 }, lock: { note_rate_pct: "6.125" }, title: { vesting_text: snapshot.vesting_text, legal_description: snapshot.legal_description }, urla_1003: { org_nmlsr_id: "123456", mlo_nmlsr_id: "987654", loan_amount_cents: "56000000", note_rate_pct: "6.125", term_months: 360 }, note_date: "2026-11-06" } }, CLOSER);
    clock.set(MST("2026-11-05", "09:00"));
    await this.tool(scope, "26.1", "releaseToSettlementAgent", { set_id: this.closingSetId, released_to_party_id: this.AGENT_PARTY, facts: { qc_pass_gate_open: true, template_version_gate_open: true } }, CLOSER);
    clock.set(MST("2026-11-05", "15:00"));
    const released = (await this.eventsOf(`application_id = $1 AND type = 'closing.documents.released'`, [this.appId]))[0]!;
    await this.tool(scope, "26.2", "runPreSessionChecks", { op: "upstream", closing_id: this.CLOSING_ID, event: { type: "closing.documents.released", occurredAt: MST("2026-11-05", "09:00"), payload: released.payload } }, CLOSER);
    clock.set(MST("2026-11-06", "13:30"));
    await this.tool(scope, "26.2", "verifyEsignConsent", { closing_id: this.CLOSING_ID, consent: this.CLOSING_CONSENT }, CLOSER);
    const pre = await this.tool(scope, "26.2", "runPreSessionChecks", { closing_id: this.CLOSING_ID, consent: this.CLOSING_CONSENT, facts: this.PRE_SESSION_FACTS }, CLOSER); assert.equal(pre.output["passed"], true, JSON.stringify(pre.output["blocking"]));
    clock.set(MST("2026-11-06", "14:00"));
    await this.tool(scope, "26.2", "openSigningSession", { closing_id: this.CLOSING_ID, session_id: this.SESSION_ID, signer_party_ids: ["B1", "B2"], notary: this.NOTARY, consent_record_id: this.CONSENT_ID }, CLOSER);
    for (const [party, hhmm, correct] of [["B1", "14:07", 5], ["B2", "14:11", 4]] as const) { clock.set(MST("2026-11-06", hhmm)); await this.tool(scope, "26.2", "monitorSession", { op: "identity", closing_id: this.CLOSING_ID, party_id: party, method: "credential_analysis_kba", credential_type: "driver_license", credential_analysis_result: "pass", kba_attempts: [{ questions: 5, correct, seconds: 71, at: MST("2026-11-06", hhmm), notary_party_id: this.NOTARY.party_id }], notary_party_id: this.NOTARY.party_id, vendor: "Proof" }, CLOSER); }
    await this.tool(scope, "26.2", "monitorSession", { op: "start", closing_id: this.CLOSING_ID }, CLOSER);
    await this.tool(scope, "26.2", "monitorSession", { op: "enote_created", closing_id: this.CLOSING_ID, closing_document_id: `DOC-ENOTE-${R}`, min: this.MIN, partner_org_id: "1000123" }, CLOSER);
    await this.tool(scope, "26.2", "monitorSession", { op: "sign", closing_id: this.CLOSING_ID, closing_document_id: `DOC-1003-${R}`, kind: "final_1003", signer_party_id: "B1", signed_at: MST("2026-11-06", "14:18"), signature_method: "esign_ron", required_note_signers: ["B1", "B2"] }, CLOSER);
    await this.tool(scope, "26.2", "monitorSession", { op: "sign", closing_id: this.CLOSING_ID, closing_document_id: `DOC-ENOTE-${R}`, kind: "enote", signer_party_id: "B1", signed_at: MST("2026-11-06", "14:25"), signature_method: "esign_ron", required_note_signers: ["B1", "B2"] }, CLOSER);
    const signed = await this.tool(scope, "26.2", "monitorSession", { op: "sign", closing_id: this.CLOSING_ID, closing_document_id: `DOC-ENOTE-${R}`, kind: "enote", signer_party_id: "B2", signed_at: MST("2026-11-06", "14:26"), signature_method: "esign_ron", required_note_signers: ["B1", "B2"] }, CLOSER);
    assert.equal(signed.output["note_date"], "2026-11-06");
    for (const party of ["B1", "B2"]) await this.tool(scope, "26.2", "monitorSession", { op: "sign", closing_id: this.CLOSING_ID, closing_document_id: `DOC-DOT-${R}`, kind: "security_instrument", signer_party_id: party, signed_at: MST("2026-11-06", "14:31"), signature_method: "esign_ron", required_note_signers: ["B1", "B2"] }, CLOSER);
    await this.tool(scope, "26.2", "monitorSession", { op: "notarial_act", closing_id: this.CLOSING_ID, closing_document_id: `DOC-DOT-${R}`, kind: "security_instrument", act_type: "acknowledgment", completed_at: MST("2026-11-06", "14:36"), certificate_indicates_communication_technology: true, recordable: true, last: true, notary_party_id: this.NOTARY.party_id }, CLOSER);
    const copy = `<SMART_DOCUMENT version="1.02"><DATA min="${this.MIN}" amount="560000.00" rate="6.125"/></SMART_DOCUMENT>`;
    const { createHash } = await import("node:crypto"); const seal = createHash("sha256").update(copy).digest("hex");
    clock.set(MST("2026-11-06", "14:41")); await this.tool(scope, "26.2", "validateAuthoritativeCopy", { op: "seal", closing_id: this.CLOSING_ID, seal_hash: seal, signing_completed_at: MST("2026-11-06", "14:26"), authoritative_copy_ref: `EV-${R}`, tamper_sealed_at: MST("2026-11-06", "14:41") }, CLOSER);
    clock.set(MST("2026-11-06", "14:43")); const v = await this.tool(scope, "26.2", "validateAuthoritativeCopy", { closing_id: this.CLOSING_ID, authoritative_copy: copy }, CLOSER); assert.equal(v.output["gate_open"], true, String(v.output["reason"]));
    clock.set(MST("2026-11-06", "14:44")); const reg = await this.tool(scope, "26.2", "registerENote", { closing_id: this.CLOSING_ID }, CLOSER); assert.equal(reg.output["accepted"], true);
  }
  /** a13: 26.3 funds Thu Nov 12 → `loan.funded` (openFunding on Wed Nov 11, then disburse on Thu Nov 12). */
  async fund(): Promise<void> { await this.openFunding(); await this.disburse(); }
  /** a13 (first half): Wed Nov 11 — 26.3's funding calendar opened (`funding.requested`), the worksheet built and reconciled to the settlement statement. */
  async openFunding(): Promise<void> {
    const scope = { app: this.appId }; const clock = this.clock; const F = this.FUNDING_ID;
    clock.set(EST("2026-11-11", "11:00"));
    await this.tool(scope, "26.3", "computeDates", { op: "open", funding_id: F, state: "AZ", transaction_type: "limited_cash_out", time_zone: "America/Phoenix", consummation_at: MST("2026-11-06", "14:26"), review_completed_on: "2026-11-09", partner_id: this.PARTNER_ID, partner_loan_number: "PL-1001", gross_loan_cents: "56000000", note_rate_pct: "6.125", note_first_payment_date: "2027-01-01" }, FUNDER);
    await this.tool(scope, "26.3", "buildFundingWorksheet", { funding_id: F, version: 1, cd_version: 1, gross_loan_cents: "56000000", prepaid_interest_cents: "178543", escrow_deposit_cents: "166500", lender_credits_cents: "70000" }, FUNDER);
    await this.tool(scope, "26.3", "reconcileToSettlementStatement", { funding_id: F, worksheet_id: `${F}:ws:1`, agent_requested_net_cents: "55724957" }, FUNDER);
  }
  /** a13 (second half): Thu Nov 12 — funding conditions, the warehouse advance, the wire, the agent's receipt and 26.3's `confirmDisbursement` → `loan.funded`. */
  async disburse(): Promise<void> {
    const scope = { app: this.appId }; const clock = this.clock; const R = this.R; const F = this.FUNDING_ID;
    clock.set(EST("2026-11-12", "08:05")); const conditions = await this.tool(scope, "26.3", "evaluateFundingConditions", { funding_id: F, facts: this.fundingFacts(EST("2026-11-12", "08:05")) }, FUNDER); assert.equal(conditions.output["passed"], true, JSON.stringify(conditions.output["blocking_codes"]));
    clock.set(EST("2026-11-12", "08:12")); await this.tool(scope, "26.3", "requestWarehouseAdvance", { funding_id: F, conditions: conditions.output, rescission: this.fundingFacts(EST("2026-11-12", "08:12")).rescission, fraud_hold: { fraud_hold: false }, ptf: { ptf_cleared: true }, cash_to_close: { worksheet: { reconciled_to_cd: true, sufficient: true } }, gifts: [] }, FUNDER);
    await this.tool(scope, "26.3", "requestWarehouseAdvance", { funding_id: F, op: "advance_approved", advance_id: `ADV-${R}` }, FUNDER);
    await this.disburseFromAdvance();
  }
  /** a13 (after the advance is approved): the wire prepared, released and accepted, the agent's receipt, 26.3's `confirmDisbursement` → `loan.funded` (32.7-T10 resumes here after T9's hold). */
  async disburseFromAdvance(): Promise<void> {
    const scope = { app: this.appId }; const clock = this.clock; const R = this.R; const F = this.FUNDING_ID;
    clock.set(EST("2026-11-12", "08:20")); const wireId = `W-${R}`;
    await this.tool(scope, "26.3", "prepareWire", { funding_id: F, wire_id: wireId, record: this.VERIFIED_WIRE, instructions_hash: this.VERIFIED_WIRE.instructions_hash, instructions_source: "verified_record", value_date: "2026-11-12", prepared_at: EST("2026-11-12", "08:20"), run_id: "run-funder-1", editors: ["u-analyst"], borrower_last_name: "Borrower", property_short: "100 N Central Ave, Phoenix AZ", funding_account_ref_hash: "sha256:funding", closing_documents: [] }, FUNDER);
    clock.set(EST("2026-11-12", "09:40")); await this.tool(scope, "26.3", "prepareWire", { funding_id: F, op: "release", wire_id: wireId, bank_ref: "BK-1", released_at: EST("2026-11-12", "09:40") }, APPROVER);
    await this.tool(scope, "26.3", "prepareWire", { funding_id: F, op: "accept", wire_id: wireId, imad: "20261112B1QGC01R000123", accepted_at: EST("2026-11-12", "09:41") }, FUNDER);
    clock.set(EST("2026-11-12", "13:00")); await this.tool(scope, "26.3", "notifySettlementAgent", { funding_id: F, op: "agent_receipt", funds_received_by_agent_at: EST("2026-11-12", "13:00") }, FUNDER);
    clock.set("2026-11-12T18:40:00.000Z");
    const funded = await this.tool(scope, "26.3", "confirmDisbursement", { funding_id: F, disbursement_date: "2026-11-12", confirmed_at: "2026-11-12T18:40:00.000Z", source: "final_settlement_statement", evidence_document_id: "DOC-FSS", escrow_deposit_cents: "206250" }, FUNDER);
    assert.ok(funded.events.some((e) => e.type === "loan.funded"));
  }
  /** b: POST /v1/applications/{id}/fund boards ONE servicing loan from the record (30.2). */
  async board(snapshotOverrides: Record<string, unknown> = {}): Promise<string> {
    this.clock.set("2026-11-12T18:40:00.000Z");
    // `snapshotOverrides` (32.8-T10): whole top-level snapshot fields replaced as 30.2's correction rule allows — e.g. `hpml: true` with the escrow analysis's `hpml_escrow_min_cancel_date` (23.4 / 30.3)
    const r = await this.call("POST", `/v1/applications/${this.appId}/fund`, { actor: FUNDING, snapshot: { final_cd: { document_id: this.cdDisclosureId, pi_cents: "340262", monthly_escrow_cents: "68750", initial_escrow_deposit_cents: "206250", prepaid_interest_cents: "178543", prepaid_interest_days: 19, compliance_tests_passed: true }, ...snapshotOverrides } });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 2000));
    this.loanId = r.body["loan_id"] as string; return this.loanId;
  }
  /** b (30.4): the servicing hand-off opened on the boarded loan through 30.4's own tool (HO items from `boarded_at`; 32.7-T13 evidences HO-009 from the borrower's upload). Runs after board(). */
  async openServicingHandoff(): Promise<void> {
    this.clock.set("2026-11-12T18:45:00.000Z");
    await this.tool({ loan: this.loanId }, "30.4", "openHandoff", { loan_id: this.loanId, application_id: this.appId, boarded_at: "2026-11-12T18:40:00.000Z", first_payment_date: "2027-01-01", mi_certificates_present: false, escrowed: true }, { kind: "agent", id: "boarding" });
  }
  /** b2: delivery and purchase on the same loan id (29.4 / 30.1, Nov 13–20, lifecycle.test.ts b2): the delivery registered with SM's warehouse wire instruction, the frozen package, the eNote eDelivered and transferred, the operator's evidence, the eVault's auto-certification, the Purchase Advice → `loan.purchased{purchase_date=2026-11-19}` keyed by BOTH ids; 30.1's `loan.investor_updated`. Runs after board(). */
  async deliverAndPurchase(): Promise<void> {
    const scope = { app: this.appId }; const clock = this.clock; const R = this.R; const loanId = this.loanId; assert.ok(loanId, "board() first");
    const SECONDARY: Actor = { kind: "agent", id: "secondary" }; const INVESTOR: Actor = { kind: "agent", id: "investor-reporting" }; const OPERATOR: Actor = { kind: "human", id: "u-op-seller", role: "fnma_portal_operator" };
    const WIRE_INSTRUCTION = { wire_instruction_id: `wire-sm-${R}`, partner_id: this.PARTNER_ID, payee_code: "SMWH1", receiver_type: "warehouse_lender", warehouse_lender_org_id: "1000123", letter_type: "bailee", bailee_letter_name: "SUPERMORTGAGE WAREHOUSE LENDING, LLC", status: "active", form_482_document_id: "doc-482-1", form_482_signed_by: "officer", approved_by_warehouse_at: "2026-09-15T15:00:00.000Z", approved_by_operator_id: "u-op-warehouse" };
    const EVIDENCE = ["import_result_screenshot", "edit_history_csv", "loan_record_print", "wire_details_screenshot"].map((kind, k) => ({ kind, document_id: `doc-ev-${k + 1}` }));
    const FNMA_NO = String(4_000_000_000 + Number(BigInt("0x" + loanId.replace(/-/g, "").slice(0, 8)) % 999_999_999n)).padStart(10, "0");
    const dlv = `dlv-${loanId.slice(0, 8)}`;
    const servicingLoanNumber = (await this.o.db.query<{ n: string }>(`SELECT servicer_loan_number AS n FROM loans WHERE id = $1`, [loanId]))[0]!.n;
    clock.set(MST("2026-11-13", "10:05"));
    await this.tool(scope, "29.4", "openOperatorTask", { op: "register", delivery_id: dlv, loan_id: loanId, application_id: this.appId, partner_id: this.PARTNER_ID, seller_loan_number: servicingLoanNumber, commitment_id_fnma: "C-2026-0001", commitment_expires_on: "2026-12-07", note_form: "enote", enote_indicator: true, min: this.MIN, upb_cents: "56000000", note_rate: "6.125", pass_through_rate: "5.875", servicing_fee_rate: "0.250", commitment_price: "101.125000", remittance_type: "actual_actual", disbursement_date: "2026-11-12", first_payment_date: "2027-01-01", wire_instruction_id: `wire-sm-${R}`, payee_code: "SMWH1", commitment_closed: true, wire: WIRE_INSTRUCTION }, SECONDARY);
    await this.tool(scope, "29.4", "openOperatorTask", { op: "frozen", delivery_id: dlv, package_id: `pkg-refi-${R}`, sha256: "a".repeat(64), file_name: `pkg-refi-${R}.xml`, frozen_at: MST("2026-11-13", "10:05") }, SECONDARY);
    clock.set(MST("2026-11-13", "10:06"));
    const task = await this.tool(scope, "29.4", "openOperatorTask", { delivery_id: dlv, at: MST("2026-11-13", "10:06"), gate_facts: { qm_type: "general_safe_harbor", apr_test_pass: true, pf_pass: true, product_tests_pass: true, consider_verify_complete: true, consider_verify_missing: [], stage: "consummation", computed_from_final_cd: true, is_hoepa: false, state_tests: [] } }, SECONDARY);
    clock.set(EST("2026-11-16", "11:02")); await this.tool(scope, "29.4", "requestEnoteTransfer", { op: "edeliver", delivery_id: dlv, at: EST("2026-11-16", "11:02") }, SECONDARY);
    clock.set(EST("2026-11-16", "11:05")); await this.tool(scope, "29.4", "requestEnoteTransfer", { op: "transfer", delivery_id: dlv, effective_date: "2026-11-16", at: EST("2026-11-16", "11:05"), delegatee_on_file: true }, SECONDARY);
    clock.set(EST("2026-11-16", "13:31"));
    await this.tool(scope, "29.4", "parseOperatorEvidence", { task_id: task.output["task_id"], operator_id: OPERATOR.id, evidence: EVIDENCE, hash_confirmed: true, edits: [], captured_state: { fnma_loan_number: FNMA_NO, submitted_at: EST("2026-11-16", "13:31"), commitment_number: "C-2026-0001", file_sha256: "a".repeat(64), loan_delivery_status: "Purchase Requested", certification_status: "Awaiting Certification" }, at: EST("2026-11-16", "13:31") }, OPERATOR);
    await this.tool(scope, "29.4", "prepareCustodianPackage", { delivery_id: dlv }, SECONDARY);
    clock.set(EST("2026-11-16", "18:30"));
    await this.tool(scope, "29.4", "trackShipment", { op: "certified", delivery_id: dlv, certified_at: EST("2026-11-16", "18:30"), certification_kind: "auto_certified_enote", notice_document_id: "doc-autocert-1", at: EST("2026-11-16", "18:30") }, SECONDARY);
    clock.set(EST("2026-11-20", "06:00"));
    const advice = { purchase_advice_id: `pa-${R}`, fnma_loan_number: FNMA_NO, advice_date: "2026-11-19", purchase_date: "2026-11-19", commitment_id_fnma: "C-2026-0001", payee_code: "SMWH1", remittance_type: "actual_actual", pass_through_rate: "5.875", servicing_fee_rate: "0.250", price: "101.125000", upb_cents: "56000000", principal_proceeds_cents: "56630000", interest_adjustment_cents: "-109667", llpa_total_cents: "70000", llpa_lines: [{ code: "LCOR_762_70", pct: "0.125", cents: "70000" }], fees: [], net_proceeds_cents: "56450333", wire_reference: "FEDW-20261119-001", source: "api", raw_payload_document_id: "doc-pa-json-1", received_at: EST("2026-11-20", "06:00") };
    const purchased = await this.tool(scope, "29.4", "ingestPurchaseAdvice", { delivery_id: dlv, advice, at: EST("2026-11-20", "06:00") }, SECONDARY);
    assert.ok(purchased.events.some((e) => e.type === "loan.purchased"), JSON.stringify(purchased.events.map((e) => e.type)));
    clock.set(EST("2026-11-19", "10:30"));
    await this.tool(scope, "30.1", "matchPurchaseAdvice", { loan: { loan_id: loanId, application_id: this.appId, servicing_loan_number: servicingLoanNumber, original_upb_cents: "56000000", first_payment_date: "2027-01-01", note_rate_pct: "6.125", commitment_remittance_type: "AA", escrowed: true, note_form: "enote", mers_registered: true, min: this.MIN },
      advice: { advice_id: `PA-${R}`, fnma_loan_number: FNMA_NO, fnma_servicer_number: "123456789", lender_loan_number: servicingLoanNumber, advice_date: "2026-11-19", purchase_date: "2026-11-19", remittance_type: "AA", pass_through_rate: "5.875000", note_rate_pct: "6.125", servicing_fee_bps: 25, interest_adjustment_cents: "-109667", net_proceeds_cents: "56590333" } }, INVESTOR);
  }
  /** d: the Jan 1, 2027 installment ($4,090.12) received Wed Dec 30 posts through the 2.1 bus (principal after: $559,455.71). */
  async firstPayment(): Promise<void> {
    const { runtime } = this.o; const loanId = this.loanId; this.clock.set("2026-12-30T17:00:00.000Z");
    const PAY_ID = `PAY-${loanId.slice(0, 8)}`;
    await runtime.execute({ process: "2.1", name: "payments.read/write", loanId, actor: CASHIERING, input: { op: "write", id: PAY_ID, loan_id: loanId, data: { payment_id: PAY_ID, loan_id: loanId, amount_cents: 409_012n, received_on: "2026-12-30", credited_as_of: "2026-12-30", channel: "lockbox", designation: "contractual", status: "posted", identification_confidence: 0.99, conforming: true } } });
    const loanAcct = (account: string) => ({ scope: "loan" as const, loanId, account: account as "principal" }); const cust = (id: string, account: string) => ({ scope: "custodial" as const, custodialAccountId: id, account: account as "clearing_cash" });
    const post = (description: string, lines: { account: ReturnType<typeof loanAcct> | ReturnType<typeof cust>; amountCents: bigint; ruleRef: string }[]) => runtime.execute({ process: "2.1", name: "ledger.post", loanId, actor: CASHIERING, input: { loan_id: loanId, via: "payment.post", entry_set: { effectiveDate: "2026-12-30", description, lines } } });
    await post(`receipt ${PAY_ID}`, [{ account: cust(this.custodial.clearing, "clearing_cash"), amountCents: 409_012n, ruleRef: "2.1:r8:receipt" }, { account: loanAcct("suspense_unapplied"), amountCents: -409_012n, ruleRef: "2.1:r8:receipt" }]);
    await post(`allocation ${PAY_ID}`, [{ account: loanAcct("suspense_unapplied"), amountCents: 409_012n, ruleRef: "2.1:r8:allocation" }, { account: loanAcct("interest_due"), amountCents: -285_833n, ruleRef: "2.1:r8:allocation:interest" }, { account: loanAcct("principal"), amountCents: -54_429n, ruleRef: "2.1:r8:allocation:principal" }, { account: loanAcct("escrow"), amountCents: -68_750n, ruleRef: "2.1:r8:allocation:escrow" }]);
    await post(`cash split ${PAY_ID}`, [{ account: cust(this.custodial.pi, "custodial_pi_cash"), amountCents: 285_833n + 54_429n, ruleRef: "2.1:r8:cash_split:pi" }, { account: cust(this.custodial.ti, "custodial_ti_cash"), amountCents: 68_750n, ruleRef: "2.1:r8:cash_split:escrow" }, { account: cust(this.custodial.clearing, "clearing_cash"), amountCents: -409_012n, ruleRef: "2.1:r8:cash_split" }]);
  }
  /**
   * 32.8: one installment received on `receivedOn` (lockbox, the full P&I + escrow the loan's terms state for `dueDate`) written through 2.1
   * `payments.read/write{write}` and posted through `payments.read/write{op=post}` — the allocation engine's plan and the rule-8 entry sets
   * (src/runtime/servicing.ts loanCashState is the state the engine reads; the journey states no figure of its own).
   */
  async postInstallment(dueDate: string, receivedOn: string, opts: { amount_cents?: bigint; channel?: string } = {}): Promise<{ payment_id: string; outcome: string; installments: string[] }> {
    const { runtime } = this.o; const loanId = this.loanId; this.clock.set(`${receivedOn}T17:00:00.000Z`);
    const facts = await loanCashState(runtime, loanId, receivedOn as never);
    const inst = facts.state.installments.find((x) => x.due_date === dueDate); if (!inst) throw new Error(`no installment ${dueDate} on ${loanId}`);
    const amount = opts.amount_cents ?? inst.pi_cents + inst.escrow_cents; const payment_id = `PAY-${loanId.slice(0, 8)}-${dueDate}`;
    await runtime.execute({ process: "2.1", name: "payments.read/write", loanId, actor: CASHIERING, input: { op: "write", id: payment_id, loan_id: loanId, data: { payment_id, loan_id: loanId, amount_cents: amount, received_on: receivedOn, credited_as_of: receivedOn, channel: opts.channel ?? "lockbox", designation: "contractual", status: "received", identification_confidence: 0.99, conforming: true } } });
    if (!facts.custodial) throw new Error("no custodial accounts for the loan's partner (seedBook first)");
    const posted = await runtime.execute({ process: "2.1", name: "payments.read/write", loanId, actor: CASHIERING, input: { op: "post", id: payment_id, loan_id: loanId, state: facts.state, custodial: facts.custodial } });
    const o = posted.output as { outcome: string; installments: string[] };
    return { payment_id, outcome: o.outcome, installments: o.installments };
  }
  /** e: the 16.1 quote (Jan 20, 2027), the wire on Jan 29 and 16.2's postPayoff → `loan.paid_in_full`. */
  async payoff(): Promise<void> {
    const { runtime, db } = this.o; const loanId = this.loanId; const QUOTE_ID = `pq-${loanId.slice(0, 8)}`; const REQUEST_ID = `pr-${loanId.slice(0, 8)}`;
    this.clock.set("2027-01-20T16:00:00.000Z");
    const quote = await runtime.execute({ process: "16.1", name: "computePayoffQuote", loanId, actor: PAYOFF, input: { loan_id: loanId, quote_id: QUOTE_ID, request_id: REQUEST_ID, channel: "email", received_on: "2027-01-20", requester_type: "borrower", upb_cents: 55_945_571n, rate_pct: "6.125", lpi_due: "2027-01-01", good_through: "2027-01-29", state: "AZ", ledger_snapshot_id: "ledger-life-1" } });
    const q = quote.output as { total_cents: bigint; interest_cents: bigint };
    this.clock.set("2027-01-29T16:00:00.000Z");
    const loanAcct = (account: string) => ({ scope: "loan" as const, loanId, account: account as "principal" }); const cust = (id: string, account: string) => ({ scope: "custodial" as const, custodialAccountId: id, account: account as "clearing_cash" });
    await runtime.execute({ process: "2.1", name: "ledger.post", loanId, actor: CASHIERING, input: { loan_id: loanId, via: "payment.post", entry_set: { effectiveDate: "2027-01-29", description: "receipt payoff wire", lines: [{ account: cust(this.custodial.clearing, "clearing_cash"), amountCents: q.total_cents, ruleRef: "2.1:r8:receipt" }, { account: loanAcct("suspense_unapplied"), amountCents: -q.total_cents, ruleRef: "2.1:r8:receipt" }] } } });
    const matched = await runtime.execute({ process: "16.2", name: "matchPayoffFunds", loanId, actor: PAYOFF, input: { loan_id: loanId, amount_cents: q.total_cents, method: "wire", received_at: "2027-01-29T16:00:00.000Z", bank_reference: QUOTE_ID, remittance_type: "AA" } });
    const m = matched.output as { funds_id: string };
    const escrowBalance = -BigInt((await db.query<{ s: string }>(`SELECT coalesce(sum(amount_cents), 0)::text AS s FROM ledger_lines WHERE scope = 'loan' AND loan_id = $1 AND account = 'escrow'`, [loanId]))[0]!.s);
    const posted = await runtime.execute({ process: "16.2", name: "postPayoff", loanId, actor: PAYOFF, input: { loan_id: loanId, funds_id: m.funds_id, amount_cents: q.total_cents, payoff_date: "2027-01-29", remittance_type: "AA", escrowed: true, buckets: { accrued_interest: q.interest_cents, principal: 55_945_571n, escrow_balance: escrowBalance }, custodial_pi_id: this.custodial.pi, custodial_ti_id: this.custodial.ti, custodial_clearing_id: this.custodial.clearing } });
    assert.ok(posted.events.some((e) => e.type === "loan.paid_in_full"));
  }
  /** 32.11: 21.1's MLO of record on the application from a one-entry roster (the LE/CD fixtures' Jordan Rivera, NMLSR ID 987654, licensed AZ) — `application.mlo_of_record.assigned`. */
  async assignMlo(): Promise<void> {
    await this.tool({ app: this.appId }, "21.1", "assignMLO", { roster: [{ mlo_id: "mlo-rivera", name: "Jordan Rivera", nmlsr_id: "987654", licensed_states: ["AZ"], nmls_status: "active", open_queue: 0 }] });
  }
  /**
   * 32.10: the party adopts the servicing book's prior loan as a serviced borrower (borrowers.party_id → loan_borrowers →
   * "Your loan ····last4"): loan_terms v1 (the $565,000 / 7.000% / 360 fixture; escrowed $687.50) and one `loan_installments`
   * row per unpaid month from `first_unpaid_due` (status `due`) — the counter job (11.1 `delinquencyCounterJob`, run by the
   * 32.10 flow's tick through src/runtime/delinquency.ts) reads them. Flags for the 11.4 / 13.1 paths ride on the loans row.
   */
  async adoptPriorLoan(partyId: string, o: { first_unpaid_due?: string; unpaid_months?: number; fdcpa_debt_collector?: boolean; regx_days_delinquent_at_boarding?: number; legal_name?: string; tin_last4?: string } = {}): Promise<string> {
    const db = this.o.db; const loanId = this.priorLoanId; assert.ok(loanId, "seedBook() first");
    const b = await db.query<{ id: string }>(`INSERT INTO borrowers (legal_name, tin_last4, party_id) VALUES ($1, $2, $3) RETURNING id`, [o.legal_name ?? "Alex Borrower", o.tin_last4 ?? "6789", partyId]);
    await db.query(`INSERT INTO loan_borrowers (loan_id, borrower_id, role, is_primary) VALUES ($1, $2, 'borrower', true)`, [loanId, b[0]!.id]);
    await db.query(`INSERT INTO loan_terms (loan_id, effective_from, source, amortization, note_rate_bps, pi_cents, escrow_payment_cents, escrowed, remittance_type, maturity_date, remaining_term_months) VALUES ($1, '2024-11-01', 'boarding', 'fixed', 7000, 375875, 68750, true, 'A/A', '2054-10-01', 360)`, [loanId]);
    await db.query(`UPDATE loans SET principal_residence = true, fdcpa_debt_collector_flag = $2, regx_days_delinquent_at_boarding = $3, default_status_at_boarding = $4 WHERE id = $1`, [loanId, o.fdcpa_debt_collector === true, o.regx_days_delinquent_at_boarding ?? 0, (o.regx_days_delinquent_at_boarding ?? 0) > 0]);
    if (o.first_unpaid_due) {
      const first = new Date(`${o.first_unpaid_due}T12:00:00Z`);
      for (let k = 0; k < (o.unpaid_months ?? 1); k += 1) {
        const d = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + k, first.getUTCDate())).toISOString().slice(0, 10);
        await db.query(`INSERT INTO loan_installments (loan_id, due_date, pi_cents, interest_cents, principal_cents, escrow_cents, status) VALUES ($1, $2::date, 375875, 329583, 46292, 68750, 'due') ON CONFLICT (loan_id, due_date) DO NOTHING`, [loanId, d]);
      }
    }
    return loanId;
  }
}
