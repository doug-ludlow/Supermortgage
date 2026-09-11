/**
 * One loan for life, measured against Postgres over the hosted runtime's HTTP surface: the refinance trigger runs on the
 * borrower's EXISTING loan on the subserviced book (20.1 → 20.2 → 20.3), the lead converts to an application that points
 * back at that loan (20.3 → 21.1 with prior_loan_id), the origination processes run through their REAL bus tools
 * (POST /v1/applications/{id}/tools/{process}/{tool}: 21.1 interview, 20.4/21.4 quote + lock + 29.1 commitment, 21.2 LE,
 * 22.x verifications / credit / identity, 23.1 DU, 23.2/23.3 decision + CTC, 24.1 valuation, 26.2 scheduling, 25.2 CD,
 * 26.1 documents, 26.2 consummation + eNote, 26.3 funding → `loan.funded`), the 30.2 hand-off boards ONE servicing `loans`
 * row from that record, 29.4/30.1 deliver and purchase it, servicing runs on the same id (timers, the sweep, a 2.1 payment on
 * the bus, a 16.1/16.2 payoff), and a new refinance application points back at the loan. Every money assertion is a bigint
 * of cents or the spec's own "$1,234.56" figure. Skips without a database (REQUIRE_DB=1 makes that a failure).
 *
 * Phases share one prior loan, one application and one loan and run in file order. Each phase's clock is set explicitly.
 * Actor ids are the spec's agents (spec/registry/agents.json); human acts (officer approvals, the MLO's review, the funding
 * approver's release, the portal operator's evidence) carry the role the process names.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { connect, reachable, type Db } from "../infra/db/client.ts";
import { acquireJourneyLock, type TestLock } from "../infra/db/test-lock.ts";
import { decodeEntityData } from "../infra/db/entities.ts";
import { loadOverriddenRegistry } from "../domain/timer-overrides.ts";
import { FixedClock, MemoryEventStore, type DomainEvent } from "../kernel/events/index.ts";
import { plainDate as D } from "../kernel/calendar/date.ts";
import { allocate } from "../domain/cashiering/allocation.ts";
import { cashStateAtBoarding } from "../domain/orig-boarding/ops-30-2.ts";
import { createCasefile } from "../domain/underwriting/ops-23-1.ts";
import { makeMin } from "../domain/boarding/min.ts";
import { newDecisionFile } from "../domain/application/ops-21-6.ts";
import { REFI_OFFER_SAMPLE } from "../notices/authored/section20-2.ts";
import { Runtime } from "./app.ts";
import { createApiServer, listen } from "./server.ts";
import { createLogger } from "./log.ts";

const DB_URL = process.env["TEST_DATABASE_URL"] ?? "postgresql://sm:sm@localhost/supermortgage_test";
const up = await reachable(DB_URL);
if (!up && process.env["REQUIRE_DB"]) throw new Error(`REQUIRE_DB set but ${DB_URL} is not reachable`);
const skip = up ? false : `no Postgres at ${DB_URL}`;
const TOKEN = "t-" + randomUUID();

let journeyLock: TestLock | undefined;
let db: Db; let runtime: Runtime; let base = ""; let close: () => Promise<void> = async () => undefined;
let partnerPartyId = "";
const custodial = { clearing: "", pi: "", ti: "" };
const clock = new FixedClock("2026-09-10T16:00:00.000Z");

// ---- the state the phases hand each other: one prior loan (the servicing book), one application, one loan for life
let priorLoanId = "";                 // the borrower's existing $565,000 / 7.000% loan the refinance trigger evaluates (v_refi_universe)
let appId = ""; let loanId = ""; let statementLeadTimerId = "";
const leadId = randomUUID();          // 20.3's lead id — convertToApplication makes it the application id (21.1)
const R = leadId.slice(0, 8);         // per-run suffix: entity ids are platform-wide (entity_records pkey = kind, id, version), so every fixture id written in loan/application scope carries it
let opportunityId = "";               // 20.1's refi_opportunities row on the prior loan
let touchId = "";                     // 20.2's e-mail touch
let quoteId = "";                     // 21.4's pricing quote (the lock's basis)
let lockId = ""; let commitmentId = "";
let leDataHash = ""; let creditReportId = ""; let casefileId = ""; let submissionNumber = 0;
const decisionId = `D-REFI-CA-${R}`; let valuationOrderId = ""; let cdDisclosureId = ""; let closingSetId = ""; let noteDataHash = ""; let fundingWireId = "";
let payoff = { quote_id: "", total_cents: 0n, interest_cents: 0n };
// entity ids are platform-wide (entity_records pkey = kind, id, version): key this run's rows by the loan
const PAY_ID = () => `PAY-${loanId.slice(0, 8)}`; const QUOTE_ID = () => `pq-${loanId.slice(0, 8)}`; const REQUEST_ID = () => `pr-${loanId.slice(0, 8)}`;

test.before(async () => {
  if (skip) return;
  journeyLock = await acquireJourneyLock(DB_URL);   // serialize journey-driving files on the shared test database
  execFileSync(fileURLToPath(new URL("../../db/migrate.sh", import.meta.url)), { env: { ...process.env, DATABASE_URL: DB_URL }, stdio: "pipe" });
  db = connect(DB_URL);
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger: createLogger("json", (line) => { if (process.env["LIFECYCLE_DEBUG"] && line.includes("\"severity\":\"ERROR\"")) process.stderr.write(line + "\n"); }) });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => server.close(() => db.end().then(() => resolve())));
  const partner = await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id) VALUES ('servicer', $1, $2, '1000123') RETURNING id`, [`Partner Bank ${randomUUID().slice(0, 8)}`, "123456789"]);
  partnerPartyId = partner[0]!.id;
  // the servicing custodial accounts cashiering and payoff post to (1.1 seeds them for a transfer; an origination partner gets them at onboarding)
  for (const kind of ["clearing", "pi", "ti"] as const) {
    const c = await db.query<{ id: string }>(`INSERT INTO custodial_accounts (partner_party_id, kind, remittance_type) VALUES ($1, $2, 'A/A') RETURNING id`, [partnerPartyId, kind]);
    custodial[kind] = c[0]!.id;
  }
  // the borrower's existing loan on the subserviced book (20.1's worked-example loan: $565,000 30-year fixed 7.000%, note Fri Sept 18, 2024, Phoenix AZ; boarded by a transfer, so it carries a Fannie Mae number)
  const prop = await db.query<{ id: string }>(`INSERT INTO properties (address_line1, city, state, postal_code, county, property_type, occupancy, units) VALUES ('100 N Central Ave', 'Phoenix', 'AZ', '85004', 'Maricopa', 'sfr', 'primary', 1) RETURNING id`);
  const fnma = String(1_000_000_000 + Math.floor(Math.random() * 8_999_999_999)).slice(0, 10);
  const prior = await db.query<{ id: string }>(`INSERT INTO loans (fnma_loan_number, servicer_loan_number, partner_party_id, property_id, status, instrument_date, origination_date, original_upb_cents, original_term_months, first_payment_date, maturity_date, boarded_at) VALUES ($1, $2, $3, $4, 'active', '2024-09-18', '2024-09-18', 56500000, 360, '2024-11-01', '2054-10-01', '2025-01-15T00:00:00Z') RETURNING id`, [fnma, `PRIOR-${randomUUID().slice(0, 8)}`, partnerPartyId, prop[0]!.id]);
  priorLoanId = prior[0]!.id;
});
test.after(async () => { if (!skip) { await close(); await journeyLock?.release(); } });

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)) } : {}) });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}
type Actor = { kind: "agent" | "human" | "system"; id: string; role?: string };
const INTAKE: Actor = { kind: "agent", id: "intake" };
const PRICING: Actor = { kind: "agent", id: "pricing" };
const DISCLOSURE: Actor = { kind: "agent", id: "disclosure" };
const VERIFICATION: Actor = { kind: "agent", id: "verification" };
const UNDERWRITER: Actor = { kind: "agent", id: "underwriter" };
const VALUATION: Actor = { kind: "agent", id: "valuation" };
const CLOSER: Actor = { kind: "agent", id: "title-closing" };
const FUNDER: Actor = { kind: "agent", id: "funder" };
const SECONDARY: Actor = { kind: "agent", id: "secondary" };
const FRAUD_RISK: Actor = { kind: "agent", id: "fraud-risk" };
const COMPLIANCE: Actor = { kind: "agent", id: "compliance-tester" };
const INVESTOR: Actor = { kind: "agent", id: "investor-reporting" };
const FUNDING: Actor = { kind: "agent", id: "funding" };
const CASHIERING: Actor = { kind: "agent", id: "cashiering" };
const PAYOFF: Actor = { kind: "agent", id: "payoff-release" };
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
const MLO: Actor = { kind: "human", id: "u-mlo-rivera", role: "mlo_of_record" };
const APPROVER: Actor = { kind: "human", id: "u-funding-approver", role: "funding_approver" };
const OPERATOR: Actor = { kind: "human", id: "u-op-seller", role: "fnma_portal_operator" };
const MST = (date: string, hhmm: string): string => new Date(`${date}T${hhmm}:00-07:00`).toISOString();   // America/Phoenix, no DST
const EDT = (date: string, hhmm: string): string => new Date(`${date}T${hhmm}:00-04:00`).toISOString();
const EST = (date: string, hhmm: string): string => new Date(`${date}T${hhmm}:00-05:00`).toISOString();
type Scope = { loan?: string; app?: string };
type ToolResult = { output: Record<string, unknown>; events: (DomainEvent & { applicationId?: string; loanId?: string })[]; decisions: unknown[]; escalations: { id: string; kind: string }[] };
/** A tool on the bus over HTTP: application scope (before funding), loan scope (the servicing book, the funded loan) or global. Anything but 200 fails the phase with the runtime's answer. */
async function tool(scope: Scope, process: string, name: string, input: Record<string, unknown>, actor: Actor = INTAKE): Promise<ToolResult> {
  const path = scope.app ? `/v1/applications/${scope.app}/tools/${process}/${name}` : scope.loan ? `/v1/loans/${scope.loan}/tools/${process}/${name}` : `/v1/tools/${process}/${name}`;
  const r = await call("POST", path, { actor, input });
  assert.equal(r.status, 200, `${process} ${name}: ${JSON.stringify(r.body).slice(0, 900)}`);
  return r.body as unknown as ToolResult;
}
const n = async (sql: string, params: unknown[] = []): Promise<number> => Number((await db.query<{ c: string }>(sql, params))[0]!.c);
/** Balance of one loan account from the persisted lines (debit +, credit −). */
const loanBalance = async (account: string): Promise<bigint> => BigInt((await db.query<{ s: string }>(`SELECT coalesce(sum(amount_cents), 0)::text AS s FROM ledger_lines WHERE scope = 'loan' AND loan_id = $1 AND account = $2`, [loanId, account]))[0]!.s);
const loanAcct = (account: string) => ({ scope: "loan" as const, loanId, account: account as "principal" });
const cust = (id: string, account: string) => ({ scope: "custodial" as const, custodialAccountId: id, account: account as "clearing_cash" });
/** The current version of an entity-store row (what the next command hydrates), decoded like the runtime does. */
async function entity(kind: string, id: string): Promise<Record<string, unknown> | null> {
  const rows = await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = $1 AND id = $2`, [kind, id]);
  return rows[0] ? decodeEntityData(rows[0].data) : null;
}
const eventsOf = async (where: string, params: unknown[]) => db.query<{ type: string; loan_id: string | null; application_id: string | null; sequence: string; payload: Record<string, unknown> }>(`SELECT type, loan_id, application_id, sequence::text, payload FROM loan_events WHERE ${where} ORDER BY sequence`, params);

// ---- fixtures shared by the phases (the sections' own worked examples: $560,000 LCOR at 6.125% / 360 on $800,000 in Phoenix; 45-day lock; consummation Fri Nov 6, 2026; disbursement Thu Nov 12)
const PARTNER_ID = "partner-1", PROGRAM_ID = `prog-refi-${R}`, CAMPAIGN = `camp-refi-${R}`, CREATIVE = `cr-email-${R}`, SCRUB_ID = `scrub-${R}`, QUOTE = `Q-A-${R}`, FUNDING_ID = `F-${R}`, CLOSING_ID = `CLS-${R}`, SESSION_ID = `SES-${R}`, CONSENT_ID = `CONS-${R}`;
const grid45 = (rows: [string, string][]) => rows.map(([r, p]) => ({ product_code: "FRM30", term_months: 360, note_rate_pct: r, lock_period_days: 45, price: p }));
const PRICES = grid45([["6.375", "101.875"], ["6.250", "101.375"], ["6.125", "100.875"], ["6.000", "100.375"], ["5.875", "99.750"]]);
const cost = (fee_code: string, description: string, mismo: string, le_section: string, vendor: string, amount_cents: string, provider_source = "creditor_selected_third_party", shoppable = false) => ({ fee_code, description, mismo_fee_type: mismo, le_section, vendor, amount_cents, provider_source, shoppable });
/** 20.4 worked example A / 20.1 worked example 1: SM's AZ / LCOR / hybrid cost schedule — $84 + $450 + $10 + $1,650 + $950 + $61 + $280 = $3,485.00. */
const COST_ITEMS = [cost("credit_report", "Credit report", "CreditReportFee", "B_cannot_shop", "CRA", "8400"), cost("appraisal_hybrid", "Hybrid appraisal / PDC", "AppraisalFee", "B_cannot_shop", "AMC", "45000"), cost("flood_determination", "Flood determination", "FloodCertification", "B_cannot_shop", "FloodCo", "1000"),
  cost("title_lenders_policy", "Lender's title policy", "TitleLendersCoveragePremium", "C_can_shop", "Grand Canyon Title", "165000", "list_provider", true), cost("settlement_agent_fee", "Settlement fee", "TitleSettlementAgentFee", "C_can_shop", "Grand Canyon Title", "95000", "list_provider", true), cost("recording_fee", "Recording", "RecordingFeeForDeed", "E_taxes_gov", "Maricopa County", "6100", "government"), cost("ron_enote", "eNote / RON", "NotaryFee", "B_cannot_shop", "RON vendor", "28000")];
/** The prior loan as `v_refi_universe` shows it (20.1 LOAN_A): 24 payments made, UPB $553,106.41, $800,000 indexed value, score 765 from the origination file. */
const universeRow = () => ({ loan_id: priorLoanId, partner_id: PARTNER_ID, status: "active", product_code: "FRM30", amortization: "fixed", note_date: "2024-09-18", first_payment_date: "2024-11-01", consummation_date: "2024-09-18", title_date: "2019-06-14",
  original_upb_cents: "56500000", original_term_months: 360, note_rate_pct: "7.000", pi_cents: "375896", payments_made: 24, upb_cents: "55310641", next_due_date: "2026-11-01", remaining_term_months: 336,
  escrowed: true, escrow_monthly_cents: "55500", net_escrow_deposit_estimate_cents: "300000", taxes_annual_cents: "480000", insurance_annual_cents: "186000", mi_status: "none", mi_monthly_cents: "0", occupancy: "primary", property_type: "sfr", units: 1, property_state: "AZ", county: "Maricopa", county_limit_cents: "83275000",
  value_estimate: { source: "origination_indexed", value_cents: "80000000", as_of: "2026-09-30", confidence: "high" }, representative_score: 765, score_source: "origination_file",
  regx_days_delinquent: 0, bankruptcy_active: false, foreclosure_referred: false, lossmit_plan_active: false, deceased_or_sii_pending: false, transfer_out_pending: false, refi_do_not_solicit: false, refi_last_offered_at: null, refi_offers_12m: 0, arm_first_adjustment_date: null });
const PARTNER = "[Partner]"; const PARTY = "B1"; const CELL = "+16025550142";
const EMAIL_TEXT = `${PARTNER}, NMLSR ID 123456, is your current lender; Supermortgage services your loan for ${PARTNER}. Your current rate 7.000% → offered rate 6.125% (6.155% annual percentage rate (APR)); 360 monthly principal-and-interest payments of $3,402.62; fixed rate for the full term — the annual percentage rate will not increase. Payments do not include amounts for taxes and insurance premiums, and your actual payment obligation will be greater. No lender fees and no third-party closing costs charged to you; those costs are paid by Supermortgage and reflected in the rate offered. This is not a commitment to lend. Rates change daily. This is an advertisement from ${PARTNER}; unsubscribe: https://portal.example.com/u; ${PARTNER}, 100 Example Way, Anytown, AZ 85000.`;
const SCRUB = { scrub_id: SCRUB_ID, source: "ftc_registry", registry_version_obtained_at: EDT("2026-09-28", "06:00"), obtained_on: "2026-09-28", valid_until: "2026-10-29", numbers_checked: 12_000, hits: 340, file_hash: "sha256:0928" };
const INFORMATIONAL_CONSENT = () => ({ consent_id: `c-info-${R}`, party_id: PARTY, loan_id: priorLoanId, kind: "tcpa_voice", purpose: "informational", phone_number: CELL, status: "active", written_consent: false, pewc_elements: null, signature_kind: null, disclosure_version: null, disclosure_text_hash: null, captured_at: EDT("2025-10-14", "10:00"), written_confirmation_due_at: null, national_dnc_written_permission: false, evidence: { captured_via: "portal_enrollment" } });
/** 20.4 worked example A's quote inputs, priced for the lead at score 768 (the Oct 5 soft pull). */
const QUOTE_INPUTS = { product_code: "FRM30", term_months: 360, amortization: "fixed", transaction_type: "limited_cash_out", occupancy: "primary", property_type: "sfr", units: 1, loan_amount_cents: "56000000", value_cents: "80000000", purchase_price_cents: null, representative_score: 768, score_model: "classic_fico", score_source: "soft_pull_2026-10-05", borrower_score_models: ["classic_fico"],
  state: "AZ", county: "Maricopa", county_limit_cents: "83275000", subordinate_financing_cents: "0", mi_option: "none", homeready: false, homeready_evaluation: null, first_time_homebuyer: false, fthb_ami_waiver: false, dts_waiver: false, very_low_income: false, lock_period_days: 45, expected_purchase_ready_date: "2026-11-19", escrowed: true, valuation_method: "hybrid", borrower_pays_third_party_costs: false,
  taxes_annual_cents: "480000", insurance_annual_cents: "186000", mi_annual_rate_pct: null, assumed_disbursement_date: "2026-11-12", first_payment_date: "2027-01-01" };
/** 21.2's H-24 fixture: the LE fees (finance charges flagged), the pricing scenario, the creditor and the MLO of record. */
const fee = (fee_code: string, description: string, le_section: string, mismo_fee_type: string, amount_cents: string, provider_source: string, shoppable: boolean, estimate_source: string, estimate_source_ref: string, finance_charge: boolean) => ({ fee_code, description, le_section, mismo_fee_type, amount_cents, provider_source, shoppable, estimate_source, estimate_source_ref, estimated_at: "2026-10-05", finance_charge });
const LE_FEES = [fee("appraisal", "Appraisal Fee to AMC", "B_cannot_shop", "AppraisalFee", "65000", "creditor_selected_third_party", false, "vendor_quote", "AMC-Q-88121", false), fee("credit_report", "Credit Report Fee", "B_cannot_shop", "CreditReportFee", "7500", "creditor_selected_third_party", false, "fee_schedule", "N2-price-list-2026-09", false),
  fee("flood_cert", "Flood Determination Fee", "B_cannot_shop", "FloodCertification", "1200", "creditor_selected_third_party", false, "fee_schedule", "N6-flood-2026-09", false), fee("tax_service", "Tax Service Fee", "B_cannot_shop", "TaxServiceFee", "8500", "creditor_selected_third_party", false, "fee_schedule", "tax-svc-2026-09", true),
  fee("title_lenders_policy", "Title – Lender's Title Policy", "C_can_shop", "TitleLendersCoveragePremium", "115000", "list_provider", true, "vendor_quote", "N7-rate-engine-2026-10-05", false), fee("title_settlement", "Title – Settlement Agent Fee", "C_can_shop", "TitleSettlementAgentFee", "49500", "list_provider", true, "vendor_quote", "N7-rate-engine-2026-10-05", false),
  fee("title_endorsements", "Title – Endorsements", "C_can_shop", "TitleEndorsementFee", "15000", "list_provider", true, "vendor_quote", "N7-rate-engine-2026-10-05", false), fee("recording", "Recording Fees", "E_taxes_gov", "RecordingFeeForMortgage", "7000", "government", false, "county_table", "maricopa-recording-2026", false),
  fee("prepaid_interest", "Prepaid Interest ($93.97 per day for 19 days @ 6.125%)", "F_prepaids", "PrepaidInterest", "178543", "creditor", false, "pricing_engine", "disbursement-2026-11-12", true), fee("escrow_taxes", "Property Taxes $400.00 per month for 3 mo.", "G_initial_escrow", "PropertyTaxes", "120000", "none", false, "tax_bill", "maricopa-2026", false),
  fee("escrow_hoi", "Homeowner's Insurance $150.00 per month for 3 mo.", "G_initial_escrow", "HomeownersInsurance", "45000", "none", false, "insurance_policy", "policy-in-force", false), fee("lender_credit", "Lender Credits", "J_lender_credit", "LenderCredit", "-261700", "creditor", false, "pricing_engine", "Q-A-1005", false)];
const LE_RENDER = () => ({ application_id: appId, disclosure_id: `LE-${appId.slice(0, 8)}`, as_of: "2026-10-05", loan_cents: "56000000", term_months: 360, transaction_type: "limited_cash_out", product: "Fixed Rate", pricing: { quote_id: QUOTE, rate_pct: "6.125", price: "100.000", points_cents: "0", lender_credit_cents: "261700", locked: false }, fees: LE_FEES,
  applicants: ["Alex Borrower", "Blake Borrower"], property_address: "100 N Central Ave, Phoenix, AZ 85004", estimated_value_cents: "80000000", creditor: { name: "Partner Bank, N.A.", nmlsr_id: "123456", email: "loans@partnerbank.example", phone: "(800) 555-0155" }, loan_officer: { name: "Jordan Rivera", nmlsr_id: "987654" }, escrow_monthly_cents: "55000", costs_expire_display: "10/20/2026 at 5:00 p.m. MST" });
const ESIGN_CONSENT = { id: `CNS-ESIGN-${R}`, scope: ["disclosures", "notices", "closing_package"], granted_at: MST("2026-10-05", "10:20") };
const JOINT_INTENT = { trid_received_at: MST("2026-10-05", "10:41"), borrowers: [{ id: "B1", joint_intent_affirmed_at: MST("2026-10-05", "10:20"), added_at: MST("2026-10-05", "10:05") }, { id: "B2", joint_intent_affirmed_at: MST("2026-10-05", "10:22"), added_at: MST("2026-10-05", "10:06") }] };
const SDN_LISTS = [{ list: "ofac_sdn", version: "SLS-2026-10-05", published_on: "2026-10-05" }, { list: "ofac_consolidated", version: "CONS-2026-10-05", published_on: "2026-10-05" }];
const BORROWER_IDENTITIES = [{ borrower_id: "B1", last_name: "Borrower", suffix: null, ssn_last4: "6789" }, { borrower_id: "B2", last_name: "Borrower", suffix: null, ssn_last4: "4321" }];
const ULAD = () => ({ application_id: appId, loan_purpose: "limited_cash_out_refinance", occupancy: "principal_residence", product: "fixed_30", amortization: "fixed", loan_term: 360, property_type: "sfr_detached", sales_price_cents: null, appraised_value_cents: "80000000", loan_amount_cents: "56000000", note_rate_pct: "6.125", qualifying_income_cents: "1200000", total_obligations_cents: "456000", borrowers: BORROWER_IDENTITIES, max_ltv_pct: "95.00" });
const msg = (id: string, category: string, text: string, borrower_id: string | null = null) => ({ id, category, text, borrower_id });
/** 23.2's refinance findings (Tue Oct 6): the DU 12.1 catalog's verification messages the interpretation opens PTD conditions from, plus the MI and value-acceptance lines. */
const DU_MESSAGES = [msg("V1001", "verification", "Verify base income with the most recent paystub (30 days) and W-2 (1 year)", "B1"), msg("V1003", "verification", "Verbal verification of employment within 10 business days of the note date", "B1"), msg("V1006", "verification", "Verify 12-month mortgage payment history on the existing lien"), msg("V1008", "verification", "Obtain evidence of hazard insurance coverage"), msg("V1009", "verification", "Obtain the title commitment"), msg("V1010", "verification", "Obtain the payoff statement for the existing first mortgage"), msg("V1012", "verification", "Verify the borrowers' identity"), msg("V1014", "verification", "Obtain the flood zone determination")];
const DU_FACTS = { transaction_type: "limited_cash_out", product: "standard", term_months: 360, ltv_x100: 7000, loan_amount_cents: "56000000", units: 1, county_limit_cents: null, score_model: "classic_fico", borrower_ids: ["B1", "B2"], all_occupying_first_time: false, all_borrowers_first_time: false, du_no_tradelines: false, closing_date: "2026-11-06" };
const QM_OPEN = { qm_type: "general_safe_harbor", apr_test_pass: true, pf_pass: true, product_tests_pass: true, consider_verify_complete: true, consider_verify_missing: [], stage: "le", apor_stale: false, blocked_reason: null, computed_from_final_cd: false };
const GUARD = { policy_outcome: "proceed", qm_facts: QM_OPEN, is_hoepa: false, is_state_high_cost: false, open_red_flag_investigations: 0 };
const RISK = { credit: { score_model: "classic_fico", representative_score: 705, history_summary: "no 30-day lates in 24 months; revolving utilization 31%" }, capacity: { dti_bps: 3800, residual_income_cents: "744000", income_sources: ["base_salary"], income_reconciled_to_22_3: true }, capital: { funds_to_close_cents: "0", reserves_months: 6, assets_reconciled_to_22_4: true },
  collateral: { ltv_x100: 7000, cltv_x100: 7000, hcltv_x100: 7000, valuation_method: "traditional", cu_score: null }, du_risk_factors: ["limited_cash_out_refinance"], eligibility_outside_du_confirmed: true, legal_compliance_confirmed: true };
const VALIDITY = { credit_expires_at: "2027-02-05", lock_expires_at: "2026-11-21", valuation_expires_at: "2027-02-06", du_close_by_date: "2026-12-07" };
const CTC_CODES = ["CTC_DU_FINAL_MATCH", "CTC_PTD_ALL_CLEARED", "CTC_NO_OPEN_INVESTIGATION", "CTC_CREDIT_VALID", "CTC_DU_CLOSE_BY", "CTC_ASSETS_CASH_TO_CLOSE", "CTC_VALUATION", "CTC_PROPERTY_PROJECT", "CTC_TITLE", "CTC_INSURANCE_FLOOD", "CTC_MI", "CTC_COMPLIANCE", "CTC_EDUCATION", "CTC_LOCK", "CTC_IDENTITY_OFAC", "CTC_QC_PREFUNDING", "CTC_MLO_APPROVALS", "CTC_REGB_TIMING", "CTC_DECISION_VALID"];
const CTC_FACTS = Object.fromEntries(CTC_CODES.map((c) => [c, { status: c === "CTC_MI" || c === "CTC_EDUCATION" ? "n/a" : "pass", ...(c === "CTC_INSURANCE_FLOOD" ? { evidence_ref: "doc-hoi-1" } : {}) }]));
/** 24.1 R3 fixture: Maricopa County, Form 1004 (UAD 3.6), median $600 (third-party survey), the AMC's AZ registration, the order payload (no value information — AIR §1.2). */
const FEE_TEST = { benchmark_id: "bench-az-013-urar", customary_and_reasonable: true, reason: "gross $650.00 within the p25–p75 band ($525.00–$700.00) of the Maricopa County URAR survey", gross_cents: "65000", appraiser_share_cents: "55000", amc_share_cents: "10000", held_for_requote: false };
const AMC_REG = { amc_registration_id: `amcreg-az-${R}`, amc_party_id: "amc-1", state: "AZ", registration_number: "AMC-AZ-1234", expires_on: "2027-06-30", asc_amc_registry_status: "active", verified_at: MST("2026-10-01", "09:00") };
const ORDER_PAYLOAD = { address: "100 N Central Ave, Phoenix AZ 85004", legal_description: "Lot 1, Block 2, Palm Estates", unit_count: 1, occupancy: "primary", transaction_type: "limited_cash_out", access_contact: { name: "Alex Borrower", phone: "602-555-0101" }, hoa_contact: null, scope: "traditional", form_code: "urar_uad36", uad_version: "3.6" };
/** 25.2's refinance CD v1 fee lines (with 21.5's tolerance classes) and the settlement agent's / escrow figure sources they reconcile to. */
const CD_FEES = [{ fee_code: "underwriting", description: "Underwriting fee", amount_cents: "195000", section: "A_origination", tolerance_class: "zero", source_id: `SRC-CREDITOR-${R}` }, { fee_code: "tax_service", description: "Tax service fee", amount_cents: "8400", section: "B_cannot_shop", tolerance_class: "zero", source_id: `SRC-CREDITOR-${R}` },
  { fee_code: "title_lender_policy", description: "Title — Lender's policy", amount_cents: "120000", section: "C_can_shop", tolerance_class: "ten_percent", source_id: `SRC-SA-${R}` }, { fee_code: "settlement_fee", description: "Title — Settlement fee", amount_cents: "60000", section: "C_can_shop", tolerance_class: "ten_percent", source_id: `SRC-SA-${R}` }, { fee_code: "recording", description: "Recording fees", amount_cents: "3000", section: "E_taxes_gov", tolerance_class: "ten_percent", source_id: `SRC-SA-${R}` },
  { fee_code: "prepaid_interest", description: "Prepaid interest ($93.97 per day from 11/12/2026 to 12/01/2026)", amount_cents: "178543", section: "F_prepaids", tolerance_class: "unlimited", source_id: `SRC-CREDITOR-${R}` }, { fee_code: "escrow_deposit", description: "Initial escrow payment at closing", amount_cents: "206250", section: "G_initial_escrow", tolerance_class: "unlimited", source_id: `SRC-ESCROW-${R}` }];
const CLOSING_SNAPSHOT = () => ({ application_id: appId, cd_version: 1, du_submission_number: "DU-1", lock_id: lockId, partner: { legal_name: "Partner Bank", nmlsr_id: "123456", mers_org_id: "1000123" }, mlo_of_record: { name: "Jordan Rivera", nmlsr_id: "987654" }, servicer: { name: "Supermortgage LLC", payment_address: "PO Box 1, Phoenix AZ 85001" },
  state: "AZ", county: "Maricopa", property_address: "100 N Central Ave, Phoenix, AZ 85004", legal_description: "Lot 1, Block 2, Palm Estates, per Book 100 of Maps, page 7, Maricopa County records", transaction_type: "limited_cash_out", occupancy: "primary", property_type: "sfr", units: 1, vesting: "individual", vesting_text: "Alex Borrower and Blake Borrower, as community property with right of survivorship",
  borrowers: [{ party_id: "B1", legal_name: "Alex Borrower", credit_used: true, on_title: true, capacities: ["borrower"] }, { party_id: "B2", legal_name: "Blake Borrower", credit_used: true, on_title: true, capacities: ["borrower"] }],
  loan_amount_cents: "56000000", note_rate_pct: "6.125", term_months: 360, product: "fixed", note_date: "2026-11-06", scheduled_disbursement_date: "2026-11-12", scheduled_closing_date: "2026-11-06", escrowed: true, rescindable: true,
  enote_default: true, partner_emortgage_approved: true, ron_authorized_state: true, settlement_agent_eclosing_eligible: true, borrower_declined_electronic: false, min: MIN });
const MIN = makeMin("1000123", String(1_000_000_000 + Number(BigInt("0x" + leadId.replace(/-/g, "").slice(8, 16)) % 8_999_999_999n)));   // MERS MIN under the partner's org 1000123 with its check digit; loans.min is unique on the platform
const DOCGEN_GATE = { final_cd_delivered: true, approval_ptd_cleared: true, trust_poa_gate_open: true, compliance_pass_cd_gate_open: true, lock_status: "active", lock_expires_on: "2026-12-07", closing_date: "2026-11-06" };
const AGENT_PARTY = "P-ESCROW-AZ-1"; const NOTARY = { party_id: "N-AZ-1", commission_state: "AZ", commission_number: "AZ-123456", physical_location_state: "AZ" };
const ELIGIBILITY = [{ settlement_agent_party_id: AGENT_PARTY, county_fips: null, ron_capable: true, ipen_capable: true, erecording_submitter: true, platforms: ["Snapdocs"], remote_witness_service: false, verified_at: "2026-10-20T00:00:00Z", verified_by: "title-closing" }];
const CLOSING_CONSENT = { consent_id: CONSENT_ID, kind: "esign", scope: ["disclosures", "closing_package"], granted_at: MST("2026-10-05", "10:20"), withdrawn_at: null, hw_sw_statement_version: "2026-09", access_demonstrated: true, paper_option_disclosed: true };
const SIGNERS = [{ party_id: "B1", esign_consented: true, identity_proofing_possible: true }, { party_id: "B2", esign_consented: true, identity_proofing_possible: true }];
const PRE_SESSION_FACTS = { ctc: { ctc_issued: true, checklist_passed: true, decision_status: "active" }, le: { earliest_consummation_date: "2026-10-15" }, cd: { earliest_consummation_date: "2026-11-05", receipts_complete: true }, signing_package: [{ consumer_id: "B1", copies: 2, channel: "in_person", material_disclosures_in_package: true, receipt_capture: true }, { consumer_id: "B2", copies: 2, channel: "in_person", material_disclosures_in_package: true, receipt_capture: true }], fraud_hold: { fraud_hold: false }, compliance_consummate_gate_open: true, vvoe_within_10bd: true, mi_commitment_valid: true, lock_valid_through_closing: true };
const VERIFIED_WIRE = { verification_id: `WV-${R}`, beneficiary_party_id: AGENT_PARTY, beneficiary_name: "Escrow Co Trust Account", instructions_hash: "h-verified", verified_at: "2026-11-03T15:00:00.000Z", expires_at: "2026-12-03T15:00:00.000Z", blocks_disbursement: false, change_detected_at: null, callback_number_source: "alta_registry", cpl_agent_party_id: AGENT_PARTY, ofac_screen_ref: "OFAC-1", ofac_clear: true };
/** 26.3 worked example 1's funding-condition facts (Thu Nov 12 08:05 ET): every item passes or is n/a; the rescission period expired midnight ending Tue Nov 10 and the 25.3 sweep confirmed it Wed Nov 11. */
const FUNDING_FACTS = (as_of: string) => ({ as_of, funding: { funding_type: "dry", transaction_type: "limited_cash_out", disbursement_date: "2026-11-12", release_date: "2026-11-12", note_date: "2026-11-06", authorized: false },
  loan: { ltv_pct: 70, sfha: false, project: false, enote: true, tx_50a6: false, record_before_fund: false }, execution: { review_passed: true, all_docs_signed: true, blocking_defects: 0, package_returned: true }, cd: { consummated_version: 1, delivered_with_receipt: true, signed_copy_in_documents: true }, identity: { all_signers_proofed: true },
  rescission: { status: "expired_not_rescinded", expires_at: "2026-11-11T07:00:00.000Z", reasonably_satisfied_at: "2026-11-11T15:00:00.000Z", waiver_id: null, now: as_of }, hazard: { hazard_status: "verified", effective_date: "2026-11-12", transaction_type: "refinance", policy_in_force: true },
  title: { cpl_open: true, commitment_open: true }, vvoe: { verified_on: "2026-11-04", self_employed: false }, credit_refresh_open: true, compliance_disburse_open: true, ptf: { ptf_cleared: true }, cash_to_close: { worksheet: { reconciled_to_cd: true, sufficient: true } }, gifts: [], wire: { verified_at: VERIFIED_WIRE.verified_at, blocks_disbursement: false, callback_number_source: "alta_registry", as_of },
  payoffs: [{ liability_id: "L-PRIOR", status: "received", good_through_date: "2026-11-13" }], first_payment: { first_payment_date: "2027-01-01" }, audit_trail_open: true, enote: { registered: true, secured_party_set: true }, qc_hold: false, commitment: { active: true, expires_on: "2026-12-07" }, worksheet: { reconciled: true }, fraud: { fraud_hold: false, ofac_clear: true } });
const WIRE_INSTRUCTION = { wire_instruction_id: `wire-sm-${R}`, partner_id: PARTNER_ID, payee_code: "SMWH1", receiver_type: "warehouse_lender", warehouse_lender_org_id: "1000123", letter_type: "bailee", bailee_letter_name: "SUPERMORTGAGE WAREHOUSE LENDING, LLC", status: "active", form_482_document_id: "doc-482-1", form_482_signed_by: "officer", approved_by_warehouse_at: "2026-09-15T15:00:00.000Z", approved_by_operator_id: "u-op-warehouse" };
const EVIDENCE = ["import_result_screenshot", "edit_history_csv", "loan_record_print", "wire_details_screenshot"].map((kind, k) => ({ kind, document_id: `doc-ev-${k + 1}` }));
const FNMA_NO = () => String(4_000_000_000 + Number(BigInt("0x" + loanId.replace(/-/g, "").slice(0, 8)) % 999_999_999n)).padStart(10, "0");

// ═══════════════════════════════════════════════ pre-application: the servicing book (prior loan scope) ═══════════════════════════════════════════════

test("a1. 20.4 pricing infrastructure on the bus (global rows): the LLPA matrix 09.09.2026 staged and activated, SM's AZ cost schedule approved by the officer ($3,485.00), 20.1's partner program registered, the daily best-efforts sheet published 06:35 ET Oct 1 — `rate_sheet.published` arms 20.1's daily trigger", { skip }, async () => {
  clock.set(EDT("2026-09-10", "12:00"));
  const llpa = await tool({}, "20.4", "loadLlpaTable", { op: "stage", matrix_version: "09.09.2026", activate: true }, PRICING);
  assert.equal(llpa.output["status"], "active"); assert.ok((llpa.output["grids"] as string[]).includes("lcor_fico"));
  clock.set(EDT("2026-09-01", "12:00"));
  const cs = await tool({}, "20.4", "buildFeeItems", { op: "cost_schedule", cost_schedule_id: "cs-az-lcor-hybrid-2026-09", partner_id: PARTNER_ID, state: "AZ", transaction_type: "limited_cash_out", valuation_method: "hybrid", items: COST_ITEMS, effective_from: "2026-09-01" }, OFFICER);
  assert.equal(cs.output["total_cents"], "348500");   // $3,485.00
  const prog = await tool({}, "20.1", "loadUniverse", { op: "register_program", program: { program_id: PROGRAM_ID, partner_id: PARTNER_ID } });
  assert.equal(prog.output["purpose"], `partner_program:${PROGRAM_ID}`);
  clock.set(EDT("2026-10-01", "06:35"));
  const sheet = await tool({}, "20.4", "publishRateSheet", { rate_sheet_id: "rs-2026-10-01", partner_id: PARTNER_ID, source: "pe_whole_loan_api", published_at: EDT("2026-10-01", "06:35"), expires_at: EDT("2026-10-01", "17:00"), prices: PRICES }, PRICING);
  assert.equal(sheet.output["status"], "active"); assert.equal(sheet.output["price_count"], 5);
  assert.ok(sheet.events.some((e) => e.type === "rate_sheet.published"), "20.4's publish event");
  // global rows: no loan, no application
  for (const e of sheet.events) { assert.equal(e.loanId, undefined); assert.equal(e.applicationId, undefined); }
});

test("a2. 20.1 on the prior loan (loan scope): the v_refi_universe row loaded, the Oct 1 run fires worked example 1 — `candidate_terms.note_rate = 0.06125`, `pi_cents = 340262`, `rate_delta_bps = 87.5`, `npv_cents = 2429278`, status `offer_ready`, SM_REFI_OFFER_SLA_2BD due Mon Oct 5 — and the decision row is keyed by the prior loan", { skip }, async () => {
  clock.set(EDT("2026-10-01", "06:41"));
  const scope = { loan: priorLoanId };
  await tool(scope, "20.1", "loadUniverse", { op: "load_row", row: universeRow(), program_id: PROGRAM_ID, gate_facts: { fnma_purchase_date: null, declined_on: null, offered_at: [] } });
  const run = await tool(scope, "20.1", "emitOfferReady", { op: "run", run_id: `run-2026-10-01-${R}`, trigger_kind: "scheduled", program_id: PROGRAM_ID, loans: [universeRow()] });   // the run's universe: this loan's v_refi_universe row
  assert.equal(run.output["opportunities_detected"], 1); assert.equal(run.output["loans_in_universe"], 1);
  const o = (run.output["opportunities"] as Record<string, unknown>[])[0]!;
  opportunityId = o["opportunity_id"] as string;
  assert.equal(o["loan_id"], priorLoanId); assert.equal(o["status"], "offer_ready"); assert.equal(o["note_rate"], "0.06125"); assert.equal(o["pi_cents"], "340262"); assert.equal(o["loan_amount_cents"], "56000000"); assert.equal(o["ltv"], "0.7000");
  assert.equal(o["rate_delta_bps"], 87.5); assert.equal(o["pi_delta_cents"], "35634"); assert.equal(o["npv_cents"], "2429278"); assert.equal(o["lifetime_interest_delta_cents"], "-4496095");
  assert.ok(run.events.some((e) => e.type === "refi.opportunity.offer_ready" && e.loanId === priorLoanId));
  const sla = await db.query<{ status: string; due_date: string }>(`SELECT status, due_date::text FROM timers WHERE code = 'SM_REFI_OFFER_SLA_2BD' AND loan_id = $1`, [priorLoanId]);
  assert.equal(sla.length, 1); assert.equal(sla[0]!.status, "armed"); assert.equal(sla[0]!.due_date, "2026-10-05");   // Fri Oct 2 BD1, Mon Oct 5 BD2
  const dec = await tool(scope, "20.1", "writeDecision", { opportunity_id: opportunityId, model_version: "intake-2026.09", prompt_version: "20.1-v1", confidence: 0.97 });
  assert.equal(dec.output["fire"], true);
  assert.equal(await n(`SELECT count(*)::text AS c FROM agent_decisions WHERE loan_id = $1 AND action = 'refi.opportunity.fire'`, [priorLoanId]), 1);
  // every event of the trigger is keyed by the prior loan and by no application (the servicing book is the subject)
  const rows = await eventsOf(`loan_id = $1`, [priorLoanId]);
  assert.ok(rows.length >= 3); for (const e of rows) assert.equal(e.application_id, null, `${e.type} has no application`);
});

test("a3. 20.2 solicitation on the prior loan: the officer approves the creative and the campaign, the e-mail touch is gated (CAN-SPAM, DNC scrub, EBR), scheduled Fri Oct 2 09:00 MST and sent through the Notice Registry — `marketing.touch.sent` moves 20.1's opportunity to `offered` and satisfies SM_REFI_OFFER_SLA_2BD", { skip }, async () => {
  const scope = { loan: priorLoanId };
  clock.set(EDT("2026-10-01", "12:00"));
  await tool(scope, "20.2", "planChannels", { op: "create_campaign", campaign_id: CAMPAIGN, partner_id: PARTNER_ID, program_id: PROGRAM_ID, kind: "refi_trigger_outbound", channels: ["email"], selection_rule_set: "sm.refi_trigger.v1", creative_ids: [CREATIVE] });
  const rendered = await tool(scope, "20.2", "renderCreative", { creative_id: CREATIVE, campaign_id: CAMPAIGN, channel: "email", template: EMAIL_TEXT, variables: {}, variables_schema: ["borrower_name", "offered_rate_pct"], rate_sheet_id: "rs-2026-10-01" });
  assert.equal(rendered.output["no_investor_reference"], true);
  const approved = await tool(scope, "20.2", "renderCreative", { op: "approve", creative_id: CREATIVE, campaign_kind: "refi_trigger_outbound", sheet_rates_pct: ["6.125", "6.250", "6.000"], optout_offer_seconds: 2 }, OFFICER);
  assert.equal(approved.output["status"], "approved", JSON.stringify(approved.output).slice(0, 400));
  clock.set(EDT("2026-10-01", "12:30"));
  const camp = await tool(scope, "20.2", "planChannels", { op: "approve_campaign", campaign_id: CAMPAIGN }, OFFICER);
  assert.notEqual(camp.output["refused"], true, JSON.stringify(camp.output).slice(0, 400));
  clock.set(EDT("2026-10-01", "13:00"));
  await tool(scope, "20.2", "planChannels", { op: "launch", campaign_id: CAMPAIGN }, OFFICER);
  clock.set(MST("2026-10-02", "09:00"));
  const scrub = await tool(scope, "20.2", "scheduleTouch", { op: "complete_scrub", scrub_id: SCRUB.scrub_id, obtained_at: SCRUB.registry_version_obtained_at, numbers_checked: SCRUB.numbers_checked, hits: SCRUB.hits, file_hash: SCRUB.file_hash });
  assert.equal(scrub.output["valid_until"], "2026-10-29");
  const facts = { touch: { touch_id: `t-email-${R}`, campaign_id: CAMPAIGN, campaign_kind: "refi_trigger_outbound", creative_id: CREATIVE, channel: "email", party_id: PARTY, loan_id: priorLoanId, opportunity_id: opportunityId, destination: "borrower@example.com", destination_id: "email-1", line_type: null, queued_at: MST("2026-10-02", "09:00"), time_zones: ["America/Phoenix"], state: "AZ" },
    partner_name: PARTNER, consents: [INFORMATIONAL_CONSENT()], scrubs: [SCRUB], suppressions: [], on_national_registry: false, ebr: { last_transaction_on: "2026-10-01" }, rate_sheet_current: true };
  const sched = await tool(scope, "20.2", "scheduleTouch", { facts });
  assert.equal(sched.output["outcome"], "scheduled", JSON.stringify(sched.output).slice(0, 600));
  touchId = sched.output["touch_id"] as string;
  const sent = await tool(scope, "20.2", "scheduleTouch", { op: "send", touch_id: touchId, payload: { ...REFI_OFFER_SAMPLE, pi_cents: "340262", account_last4: "0001" }, recipient: { name: "Alex Borrower", mailing_address: "100 N Central Ave, Phoenix, AZ 85004", email: "borrower@example.com" } });
  assert.equal(sent.output["outcome"], "sent"); assert.ok(sent.events.some((e) => e.type === "marketing.touch.sent" && e.loanId === priorLoanId));
  const offered = await tool(scope, "20.1", "emitOfferReady", { op: "offered", opportunity_id: opportunityId });
  assert.equal(offered.output["status"], "offered");
  assert.equal((await db.query<{ status: string }>(`SELECT status FROM timers WHERE code = 'SM_REFI_OFFER_SLA_2BD' AND loan_id = $1`, [priorLoanId]))[0]!.status, "satisfied");
});

test("a4. 20.3 lead intake on the prior loan (Mon Oct 5, MST): lead created from the touch, AI disclosure before the first substantive answer, L2 portal login, the soft-pull authorization (end user = partner) and the 768 report, four TRID items recorded — then 20.1 records `engaged`; the application opens over HTTP with prior_loan_id = the prior loan and id = the lead id, 20.3 converts the lead (`application.received`, five items replayed) and 20.1 records `converted`", { skip }, async () => {
  const scope = { loan: priorLoanId };
  clock.set(MST("2026-10-05", "08:40"));
  const lead = await tool(scope, "20.3", "deliverDisclosure", { op: "create", lead_id: leadId, partner_id: PARTNER_ID, partner_name: "Partner Bank", channel: "refi_trigger", source_touch_id: touchId, opportunity_id: opportunityId, loan_id: priorLoanId, party_id: PARTY, consumer_state: "AZ", property_state: "AZ", property_address: "100 N Central Ave, Phoenix, AZ 85004", transaction_intent: "refinance", time_zone: "America/Phoenix" });
  assert.equal(lead.output["status"], "new"); assert.ok(lead.events.some((e) => e.type === "lead.created" && e.loanId === priorLoanId));
  clock.set(MST("2026-10-05", "08:41"));
  const started = await tool(scope, "20.3", "deliverDisclosure", { op: "start", lead_id: leadId, interaction_id: `i-${R}`, channel: "web_chat", ai: true });
  assert.equal(started.output["disclosure_required"], true);
  const disclosed = await tool(scope, "20.3", "deliverDisclosure", { lead_id: leadId, interaction_id: `i-${R}`, notice_id: `n-disc-${R}` });
  assert.equal(disclosed.output["version"], "1.2"); assert.match(String(disclosed.output["text"]), /^You're speaking with Partner Bank's automated assistant/);
  clock.set(MST("2026-10-05", "08:43"));
  const auth = await tool(scope, "20.3", "authenticate", { lead_id: leadId, method: "portal_login" });
  assert.equal(auth.output["level"], "L2_account_authenticated");
  clock.set(MST("2026-10-05", "08:47"));
  const cap = await tool(scope, "20.3", "captureConsent", { lead_id: leadId, kind: "credit_authorization", authorization_id: `auth-${R}`, authorization_kind: "soft_prequal", text_version: "soft-prequal-2026-09", channel: "web_chat", end_user: "partner", evidence: { ip: "203.0.113.5", user_agent: "fixture", session_id: `i-${R}` } });
  assert.equal(cap.output["permissible_purpose"], "consumer_initiated_credit_transaction_1681b_a3A"); assert.equal(cap.output["trid_ssn_for_credit"], true);
  const order = await tool(scope, "20.3", "orderSoftPull", { lead_id: leadId });
  assert.equal(order.output["authorization_id"], `auth-${R}`);
  clock.set(new Date("2026-10-05T08:47:30-07:00").toISOString());
  const rcv = await tool(scope, "20.3", "orderSoftPull", { lead_id: leadId, op: "receive", report_id: `rpt-${R}`, representative_score: 768 });
  assert.equal(rcv.output["tier"], "760–779");
  clock.set(MST("2026-10-05", "09:28"));
  for (const [item, source, value] of [["name", "on_file_confirmed", "Alex Borrower"], ["property_address", "on_file_confirmed", "100 N Central Ave, Phoenix, AZ 85004"], ["value_estimate", "consumer_stated", "80000000"], ["loan_amount_sought", "consumer_stated", "56000000"]] as const) {
    const r = await tool(scope, "20.3", "explainProgram", { op: "record_trid_item", lead_id: leadId, item, source, value });
    assert.equal(r.output["complete"], false);   // income is stated in the 21.1 interview (rule 5: never taken from the origination file)
  }
  const engaged = await tool(scope, "20.1", "emitOfferReady", { op: "engaged", opportunity_id: opportunityId });
  assert.equal(engaged.output["status"], "engaged");
  // 21.1 opens the application over HTTP: the runtime's `application.started`, keyed by the application only, pointing back at the prior loan
  clock.set(MST("2026-10-05", "09:35"));
  const r = await call("POST", "/v1/applications", { actor: INTAKE, application: {
    id: leadId, partner_party_id: partnerPartyId, channel: "refi_trigger", transaction_type: "limited_cash_out", occupancy: "primary", intake_channel: "voice", interview_language: "en-US", prior_loan_id: priorLoanId,
    borrowers: [{ legal_name: "Alex Borrower", borrower_role: "borrower", citizenship_status: "us_citizen", language_preference: "en" }, { legal_name: "Blake Borrower", borrower_role: "co_borrower" }],
    property: { address_line1: "100 N Central Ave", city: "Phoenix", state: "AZ", postal_code: "85004", county: "Maricopa", property_type: "sfr", units: 1 } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const app = r.body["application"] as Record<string, unknown>;
  appId = app["id"] as string;
  assert.equal(appId, leadId); assert.equal(app["status"], "started"); assert.equal(app["loan_id"], null); assert.equal(app["prior_loan_id"], priorLoanId);
  const ev = r.body["event"] as Record<string, unknown>;
  assert.equal(ev["type"], "application.started"); assert.equal(ev["applicationId"], appId); assert.equal(ev["loanId"], undefined); assert.equal((ev["payload"] as { prior_loan_id: string }).prior_loan_id, priorLoanId);
  // 20.3's conversion (loan scope: the lead lives on the prior loan; its events name the application) — the Reg B application is received
  const conv = await tool(scope, "20.3", "explainProgram", { op: "convert", lead_id: leadId, transaction_type: "limited_cash_out", occupancy: "primary", creditor_time_zone: "America/Phoenix", borrower_name: "Alex Borrower" });
  assert.equal(conv.output["application_id"], appId); assert.equal(conv.output["status"], "converted"); assert.equal(conv.output["application_date"], "2026-10-05"); assert.equal(conv.output["trid_application_date"], null);
  assert.ok(conv.events.some((e) => e.type === "application.received" && e.applicationId === appId)); assert.ok(conv.events.some((e) => e.type === "lead.qualified"));
  const converted = await tool(scope, "20.1", "emitOfferReady", { op: "converted", opportunity_id: opportunityId, application_id: appId });
  assert.equal(converted.output["status"], "converted"); assert.equal(converted.output["application_id"], appId);
  assert.equal((await entity("refi_opportunities", opportunityId))?.["application_id"], appId);
  // the application's log carries no loan: the conversion's origination events (application.received, the replayed items) are keyed by the application alone even though the lead lives on the prior loan; the lead's own events stay on the prior loan
  const own = await eventsOf(`application_id = $1`, [appId]);
  assert.ok(own.some((e) => e.type === "application.started" && e.loan_id === null));
  assert.ok(own.some((e) => e.type === "application.received" && e.loan_id === null), "the conversion is keyed by the application");
  for (const e of own) if (e.type !== "refi.opportunity.converted") assert.equal(e.loan_id, null, `${e.type} carries no loan before funding`);   // 20.1's conversion record is the one event naming both: the prior loan's opportunity and the application it became
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_events WHERE loan_id = $1 AND type = 'lead.created' AND application_id IS NULL`, [priorLoanId]), 1, "the lead's record is the prior loan's");
  assert.ok(own.some((e) => e.type === "lead.qualified" && e.loan_id === null), "the qualified lead names the application it became");
});

// ═══════════════════════════════════════════════ origination: application scope ═══════════════════════════════════════════════

test("a5. 21.1 the 1003 interview on the bus (application scope, 10:14–10:41 MST): startInterview snapshots ai_intake_mode=assisted, discloseAI, the six items (name and address confirmed from the servicing prefill, SSN / income / value / loan amount stated) — `application.trid_received` once at 10:41 MST, REGZ_1026_19E1_LE_3BD due Thu Oct 8, every event keyed by the application only", { skip }, async () => {
  const scope = { app: appId };
  clock.set(MST("2026-10-05", "10:14"));
  const s = await tool(scope, "21.1", "startInterview", { session_id: `S-${R}`, partner_name: "Partner Bank", partner_nmlsr_id: "123456", intake_channel: "voice", creditor_time_zone: "America/Phoenix", property_state: "AZ", property_address: "100 N Central Ave, Phoenix, AZ 85004", transaction_type: "limited_cash_out", occupancy: "primary", borrowers: [{ id: "B1", legal_name: "Alex Borrower", marital_status: "married" }, { id: "B2", legal_name: "Blake Borrower", marital_status: "married" }], model_version: "intake-2026.09", prompt_version: "p-1.4" });
  assert.equal(s.output["ai_intake_mode"], "assisted");
  clock.set(new Date("2026-10-05T10:14:07-07:00").toISOString()); await tool(scope, "21.1", "discloseAI", { session_id: `S-${R}`, utterance_id: `utt-${R}`, state: "AZ" });
  // 10:16: "I want to refinance to lower my payment" → the interview record's Reg B receipt (application_date 2026-10-05 — the same date 20.3's conversion recorded)
  clock.set(MST("2026-10-05", "10:16")); const rec = await tool(scope, "21.1", "captureField", { field: "credit_request", transaction_type: "limited_cash_out", occupancy: "primary", property_state: "AZ", identity_verified: true });
  assert.deepEqual([rec.output["status"], rec.output["application_date"], rec.output["hmda_application_date"]], ["received", "2026-10-05", "2026-10-05"]);
  await tool(scope, "21.1", "confirmPrefill", { op: "offer", item: "name", value: "Alex Borrower" }); await tool(scope, "21.1", "confirmPrefill", { item: "name" });
  clock.set(MST("2026-10-05", "10:18")); await tool(scope, "21.1", "captureField", { field: "ssn", value: "123-45-6789", borrower_id: "B1" });
  await tool(scope, "21.1", "confirmPrefill", { op: "offer", item: "property_address", value: "100 N Central Ave, Phoenix, AZ 85004" }); clock.set(MST("2026-10-05", "10:19")); await tool(scope, "21.1", "confirmPrefill", { item: "property_address" });
  clock.set(MST("2026-10-05", "10:27")); await tool(scope, "21.1", "captureField", { field: "income", value: "1480000", borrower_id: "B1" });
  clock.set(MST("2026-10-05", "10:33")); const five = await tool(scope, "21.1", "captureField", { field: "property_value_estimate", value: "80000000" });
  assert.equal(five.output["six_items_complete"], false); assert.deepEqual(five.output["missing"], ["loan_amount_sought"]);
  clock.set(MST("2026-10-05", "10:41")); const sixth = await tool(scope, "21.1", "captureField", { field: "loan_amount_sought", value: "56000000" });
  assert.equal(sixth.output["six_items_complete"], true); assert.equal(sixth.output["trid_emitted"], true); assert.equal(sixth.output["trid_received_at"], MST("2026-10-05", "10:41"));
  const again = await tool(scope, "21.1", "detectSixItems", {});
  assert.equal(again.output["emitted"], false); assert.equal(again.output["le_due"], "2026-10-08");
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_events WHERE application_id = $1 AND type = 'application.trid_received'`, [appId]), 1);
  const le = await db.query<{ status: string; due_date: string; anchor_date: string }>(`SELECT status, due_date::text, anchor_date::text FROM timers WHERE code = 'REGZ_1026_19E1_LE_3BD' AND application_id = $1`, [appId]);
  assert.equal(le.length, 1); assert.equal(le[0]!.status, "armed"); assert.equal(le[0]!.anchor_date, "2026-10-05"); assert.equal(le[0]!.due_date, "2026-10-08");
  const own = await eventsOf(`application_id = $1 AND sequence > (SELECT max(sequence) FROM loan_events WHERE type = 'application.started' AND application_id = $1)`, [appId]);
  for (const e of own) if (e.type !== "application.received" && !e.type.startsWith("lead.") && !e.type.startsWith("application.six_item") && !e.type.startsWith("refi.")) assert.equal(e.loan_id, null, `${e.type} keyed by the application only`);
});

test("a6. quote, LE, intent, lock and commitment on the bus: 20.4 prices worked example A (6.125%, $3,402.62, lender credit $700.00), 21.2 renders the H-24 (data hash), the runtime delivers the LE through 21.2's LoanEstimateService (MLO-approved; e-signed Oct 5 → effective receipt Oct 5), 21.4 records intent Tue Oct 6 09:14 MST, the credit-report fee clears the intent gate, the lock executes Wed Oct 7 10:19 MST at 6.125% for 45 days and 29.1 takes the best-efforts commitment expiring Mon Dec 7", { skip }, async () => {
  const scope = { app: appId };
  // the Oct 5 sheet (06:35 ET) — the quote's basis; 20.1's daily trigger re-runs on it (its events stay on the prior loan)
  clock.set(EDT("2026-10-05", "06:35"));
  await tool({}, "20.4", "publishRateSheet", { rate_sheet_id: "rs-2026-10-05", partner_id: PARTNER_ID, source: "pe_whole_loan_api", published_at: EDT("2026-10-05", "06:35"), expires_at: EDT("2026-10-05", "17:00"), prices: PRICES }, PRICING);
  clock.set(MST("2026-10-05", "10:45"));
  const q = await tool(scope, "20.4", "solvePassThrough", { inputs: QUOTE_INPUTS, quote_id: QUOTE, purpose: "lead_quote", partner_id: PARTNER_ID, lead_id: leadId }, PRICING);
  assert.equal(q.output["outcome"], "priced"); assert.equal(q.output["note_rate"], "0.06125"); assert.equal(q.output["pass_through_rate"], "0.05875"); assert.equal(q.output["pi_cents"], "340262"); assert.equal(q.output["lender_credit_cents"], "70000"); assert.equal(q.output["llpa_cents"], "70000"); assert.equal(q.output["rate_sheet_id"], "rs-2026-10-05");
  // 21.4 rule 1: the credit-report fee handled under §1026.19(e)(2)(i)(B) before any LE (exempt; capped at the vendor invoice)
  clock.set(MST("2026-10-05", "10:50"));
  const feeGate = await tool(scope, "21.4", "checkFeeGate", { command: "order_credit_report", fee_kind: "credit_report", amount_cents: "7500", vendor_invoice_cents: "6850", op: "impose", fee_item_id: `fee-credit-report-${R}`, method: "card_token", checked_at: MST("2026-10-05", "10:50") }, PRICING);
  assert.equal(feeGate.output["result"], "exempt_credit_report"); assert.equal(feeGate.output["collected_cents"], "6850");
  // 21.2: the LE rendered on the bus (the data hash the MLO approves), then delivered through the runtime's bridge over LoanEstimateService — e-sign portal 16:10 MST, viewed 17:42 MST → effective receipt Oct 5
  clock.set(MST("2026-10-05", "16:10"));
  const h24 = await tool(scope, "21.2", "renderH24", LE_RENDER(), DISCLOSURE);
  leDataHash = h24.output["data_hash"] as string; assert.match(leDataHash, /^[0-9a-f]{16,}$/); assert.equal(h24.output["template_version"], "H-24 2017");
  const le = await call("POST", `/v1/applications/${appId}/disclosures/le`, { actor: MLO, render: LE_RENDER(), mlo: { review_id: `MR-LE-${R}`, nmlsr_id: "987654" }, delivery: { channel: "esign_portal", at: MST("2026-10-05", "16:10"), consent: ESIGN_CONSENT, receipt: { kind: "esignature", at: MST("2026-10-05", "17:42"), borrower_id: "B1" } } });
  assert.equal(le.status, 200, JSON.stringify(le.body));
  assert.equal(le.body["status"], "received"); assert.equal(le.body["effective_receipt_date"], "2026-10-05"); assert.equal(le.body["le_due_on"], "2026-10-08");
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_events WHERE application_id = $1 AND type = 'disclosure.le.received' AND loan_id IS NULL`, [appId]), 1);
  assert.equal((await db.query<{ status: string }>(`SELECT status FROM timers WHERE code = 'REGZ_1026_19E1_LE_3BD' AND application_id = $1`, [appId]))[0]!.status, "satisfied");
  // 21.4: "I want to proceed" Tue Oct 6 09:14 MST opens the fee gate
  clock.set(MST("2026-10-06", "09:14"));
  const intent = await tool(scope, "21.4", "recordIntent", { channel: "app_button", statement_text: "I want to proceed with this Loan Estimate", evidence_document_id: `evt-app-tap-${R}`, received_at: MST("2026-10-06", "09:14") }, PRICING);
  assert.equal(intent.output["valid"], true); assert.equal(intent.output["le_effective_receipt_date"], "2026-10-05");
  assert.equal((await db.query<{ status: string }>(`SELECT status FROM timers WHERE code = 'REGZ_1026_19E2_INTENT_FEE_GATE' AND application_id = $1 ORDER BY armed_at DESC`, [appId]))[0]!.status, "satisfied");
  // Wed Oct 7: the day's sheet (06:35 ET), the quote at 10:05 MST from the runtime's pricing port over 20.4's sheets, the MLO's approval and the execution at 10:19, the 29.1 commitment
  clock.set(EDT("2026-10-07", "06:35"));
  await tool({}, "20.4", "publishRateSheet", { rate_sheet_id: "rs-2026-10-07", partner_id: PARTNER_ID, source: "pe_whole_loan_api", published_at: EDT("2026-10-07", "06:35"), expires_at: EDT("2026-10-07", "17:00"), prices: PRICES }, PRICING);
  clock.set(MST("2026-10-07", "10:05"));
  const quote = await tool(scope, "21.4", "getQuote", { loan_amount_cents: "56000000", product_code: "FRM30_CONV", note_rate_pct: "6.125", lock_period_days: 45, at: MST("2026-10-07", "10:05") }, PRICING);
  quoteId = quote.output["quote_id"] as string; assert.equal(quote.output["rate_sheet_id"], "rs-2026-10-07"); assert.equal(quote.output["llpa_version"], "09.09.2026");
  const req = await tool(scope, "21.4", "requestLock", { quote_id: quoteId, borrower_statement: "Please lock my rate today", property_state: "AZ", le_loan_amount_cents: "56000000", requested_at: MST("2026-10-07", "10:05") }, PRICING);
  lockId = req.output["lock_id"] as string; assert.equal(req.output["status"], "pending_mlo_approval"); assert.ok(req.escalations.some((e) => e.kind === "mlo_of_record"));
  clock.set(MST("2026-10-07", "10:19"));
  await tool(scope, "21.4", "executeLock", { lock_id: lockId, op: "approve", quote_id: quoteId, mlo_nmlsr_id: "987654", approved_at: MST("2026-10-07", "10:19") }, MLO);
  const lock = await tool(scope, "21.4", "executeLock", { lock_id: lockId, executed_at: MST("2026-10-07", "10:19") }, PRICING);
  assert.equal(lock.output["status"], "executed"); assert.equal(lock.output["note_rate"], "6.125"); assert.equal(lock.output["rate_set_date"], "2026-10-07"); assert.equal(lock.output["expires_on"], "2026-11-23");   // Sat Nov 21 rolls to Mon Nov 23
  assert.ok(lock.events.some((e) => e.type === "lock.executed" && e.applicationId === appId && !e.loanId));
  const c = await tool(scope, "21.4", "requestCommitment", { lock_id: lockId, at: MST("2026-10-07", "10:20") }, PRICING);
  commitmentId = c.output["commitment_id"] as string; assert.ok(commitmentId); assert.equal(c.output["open_commitments"], 1);
  assert.equal(c.output["expires_on"], "2026-12-07");   // 29.1-Q1: lock expiry + 14 rolled forward on the Fannie Mae calendar (Mon Dec 7, 2026)
});

test("a7. 22.x verifications on the bus (Oct 5–8): 22.6 IAL2 identity for both borrowers and the OFAC screen (clear), 22.2's tri-merge after the fee and TRID prerequisites (representative score 705 from borrower B), 22.1 ingests and classifies a paystub, 22.4 declares the checking account — every row and event keyed by the application", { skip }, async () => {
  const scope = { app: appId };
  clock.set(MST("2026-10-05", "11:00"));
  const a = await tool(scope, "22.6", "verifyIdentity", { borrower_id: "B1", borrower_ids: ["B1", "B2"], scheduled_note_date: "2026-11-06" }, FRAUD_RISK);
  assert.equal(a.output["outcome"], "verified"); assert.equal(a.output["all_borrowers_verified"], false);
  const b = await tool(scope, "22.6", "verifyIdentity", { borrower_id: "B2", borrower_ids: ["B1", "B2"], scheduled_note_date: "2026-11-06" }, FRAUD_RISK);
  assert.equal(b.output["outcome"], "verified"); assert.equal(b.output["all_borrowers_verified"], true);
  for (const [party, name] of [["B1", "Alex Borrower"], ["B2", "Blake Borrower"]] as const) {
    const s = await tool(scope, "22.6", "screenParty", { party_id: party, party_role: "borrower", name, lists: SDN_LISTS }, FRAUD_RISK);
    assert.equal(s.output["result"], "clear", JSON.stringify(s.output).slice(0, 300));
  }
  clock.set(MST("2026-10-05", "10:52"));
  const order = await tool(scope, "22.2", "orderCreditReport", { borrower_ids: ["B1", "B2"], permissible_purpose: "credit_transaction_604a3A", certification_ref: "CERT-PARTNER-1681E-2026", borrower_authorization_ref: "AUTH-BLANKET-2026-10-05", subscriber_code: "SUB-PARTNER-0417", joint_intent_facts: JOINT_INTENT, at: MST("2026-10-05", "10:52") }, VERIFICATION);
  creditReportId = order.output["report_id"] as string; assert.ok(creditReportId);
  const parsed = await tool(scope, "22.2", "parseCreditReport", { report_id: creditReportId }, VERIFICATION);
  assert.equal(parsed.output["state"], "usable"); assert.equal(parsed.output["representative_score"], 705);
  assert.ok(parsed.events.some((e) => e.type === "credit.representative_score.computed" && e.applicationId === appId));
  const report = await entity("credit_reports", creditReportId);
  assert.equal(report?.["representative_score_borrower_id"], "B2"); assert.equal(report?.["score_model"], "classic_fico"); assert.equal(report?.["application_id"], appId);
  clock.set(MST("2026-10-08", "09:00"));
  const doc = await tool(scope, "22.1", "ingestDocument", { document_id: `doc-pay-${R}`, source_channel: "borrower_upload", sha256: "sha-doc-pay-1", subject_borrower_id: "B1", applicant_borrower_ids: ["B1", "B2"], page_count: 2 }, VERIFICATION);
  assert.equal(doc.output["quarantined"], false);
  const cls = await tool(scope, "22.1", "classifyDocument", { document_id: `doc-pay-${R}`, doc_class: "paystub", confidence: 0.98 }, VERIFICATION);
  assert.equal(cls.output["doc_class"], "paystub");
  const assets = await tool(scope, "22.4", "declareAssets", { assets: [{ asset_id: `chk-${R}`, asset_type: "checking", borrower_ids: ["B1"], declared_balance_cents: "3124018", institution_name: "First Bank", account_last4: "1234", holder_names: ["Alex Borrower"] }], borrower_names: ["Alex Borrower", "Blake Borrower"] }, VERIFICATION);
  assert.ok(assets.events.some((e) => e.applicationId === appId));
  assert.equal(await n(`SELECT count(*)::text AS c FROM entity_records WHERE application_id = $1 AND kind IN ('credit_reports', 'documents', 'application_assets', 'party_screenings', 'verifications')`, [appId]) >= 5, true);
});

test("a8. 24.1 valuation (Tue Oct 6 09:20 MST, after the intent and before DU): no DU offer → the method selected inside the order is traditional URAR (UAD 3.6) — the order placed with the AMC under the open intent gate (SM-borne $650 fee inside the Maricopa benchmark band): `valuation.ordered` on the application, SM_VALUATION_ASSIGN_SLA_2BD armed", { skip }, async () => {
  const scope = { app: appId };
  clock.set(MST("2026-10-06", "09:20"));
  // R1 runs inside placeOrder (24.1's standalone selectMethod keys its `valuation_method_selections` row `sel-<count>` — a platform-wide id that collides across applications; see the runtime notes)
  const offer = await tool(scope, "24.1", "readDuOffer", {}, VALUATION);
  assert.equal(offer.output["offer_type"], "none");
  const order = await tool(scope, "24.1", "placeOrder", { transaction_type: "limited_cash_out", occupancy: "primary", units: 1, property_type: "sfr", ltv_bps: 7000, fee_paid_by: "sm", fee_quote_cents: "65000", fee_test: FEE_TEST, property_state: "AZ", vendor_party_id: "amc-1", channel: "amc", amc_registration: AMC_REG, order_payload: ORDER_PAYLOAD, le_effective_receipt_date: "2026-10-05", ordered_at: MST("2026-10-06", "09:20"), time_zone: "America/Phoenix" }, VALUATION);
  valuationOrderId = order.output["order_id"] as string;
  assert.equal(order.output["status"], "ordered"); assert.equal(order.output["method"], "traditional");
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_events WHERE application_id = $1 AND type = 'valuation.ordered' AND loan_id IS NULL`, [appId]), 1);
  assert.equal(await n(`SELECT count(*)::text AS c FROM timers WHERE code = 'SM_VALUATION_ASSIGN_SLA_2BD' AND application_id = $1 AND status = 'armed'`, [appId]), 1);
});

test("a9. 23.1 DU and 23.2/23.3 the decision on the bus (Tue Oct 6 → Wed Oct 7): the casefile associates both credit reports (one score model), the request builds and submits over the DI port, findings Approve/Eligible (DTI 38.00%, LTV 70.0000) within the same run; 23.2 interprets the findings into PTD conditions; 23.3 assesses risk, issues the conditional approval valid until Nov 21, runs the CTC checklist and issues clear-to-close", { skip }, async () => {
  const scope = { app: appId };
  clock.set("2026-10-06T17:00:00.000Z");   // 10:00 MST Tue Oct 6
  // 23.1 has no createCasefile tool on the bus: the casefile row is built with the section's own constructor (a throwaway store) and handed to associateCredit, which persists it
  const cf0 = createCasefile(new MemoryEventStore(clock), { application_id: appId, seller_number: "123456789", system_id_ref: "SYS-PARTNER-01", tsp_product_ref: "SM-TSP", score_model: "classic_fico", created_at: clock.now() }).casefile;
  casefileId = cf0.casefile_id;
  const report = await entity("credit_reports", creditReportId);
  const assoc = await tool(scope, "23.1", "associateCredit", { casefile: cf0, reports: [report], borrowers: BORROWER_IDENTITIES, app_score_model: "classic_fico" }, UNDERWRITER);
  assert.equal((assoc.output["casefile"] as { status: string }).status, "credit_associated"); assert.equal(assoc.output["event"], "du.credit.associated");
  const built = await tool(scope, "23.1", "buildDuRequest", { casefile_id: casefileId, submission_type: "credit_and_underwriting", reason: "initial", snapshot: ULAD() }, UNDERWRITER);
  assert.match(String(built.output["request_hash"]), /^[0-9a-f]{64}$/);
  const sub = await tool(scope, "23.1", "submitCasefile", { casefile_id: casefileId, request: built.output["request"], projected_note_date: "2026-11-06", scif_facts: { borrowers: BORROWER_IDENTITIES.map((b) => ({ id: b.borrower_id, scif_presented_at: MST("2026-10-05", "10:20") })) } }, UNDERWRITER);
  submissionNumber = (sub.output["submission"] as { submission_number: number }).submission_number; assert.equal(submissionNumber, 1); assert.equal(sub.output["outage"], null);
  const findings = await tool(scope, "23.1", "fetchFindings", { casefile_id: casefileId, submission_number: 1 }, UNDERWRITER);
  assert.equal(findings.output["recommendation"], "approve_eligible");
  const submission = findings.output["submission"] as Record<string, unknown>;
  assert.equal(submission["dti_du"], "38.00"); assert.equal(submission["ltv_du"], "70.0000"); assert.equal(submission["status"], "findings_received");
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_events WHERE application_id = $1 AND type IN ('du.submitted', 'du.findings.received') AND loan_id IS NULL`, [appId]), 2);
  // 23.2: the interpretation opens the PTD conditions the catalog maps the verification messages to
  clock.set("2026-10-06T17:12:00.000Z");
  const interp = await tool(scope, "23.2", "parseFindings", { op: "interpret", submission_id: submission["submission_id"], submission_number: 1, recommendation: "approve_eligible", messages: DU_MESSAGES, validation_results: [], value_acceptance_offer: { offered: true, property_value_cents: "80000000" }, mi_requirement: { required: false, coverage_pct: null }, du_release: "2026-09-25", policy_generation: "2026_09_26", request_hash: built.output["request_hash"], findings_received_at: "2026-10-06T17:00:00.000Z", facts: DU_FACTS }, UNDERWRITER);
  const conditionIds = interp.output["conditions"] as string[];
  assert.ok(conditionIds.length >= 6, JSON.stringify(interp.output).slice(0, 400)); assert.ok((interp.output["events"] as string[]).includes("du.findings.interpreted"));
  // 23.3: risk, the conditional approval (Wed Oct 7), the CTC checklist and clear-to-close
  clock.set("2026-10-07T15:00:00.000Z");
  const risk = await tool(scope, "23.3", "assessRisk", { risk_input: RISK, decision_id: decisionId }, UNDERWRITER);
  assert.ok(risk.output);
  const file = newDecisionFile({ application_id: appId, partner_name: "Partner Bank", partner_address: "100 Partner Plaza, Phoenix, AZ 85004", creditor_time_zone: "America/Phoenix", application_date: "2026-10-05", property_state: "AZ", applicants: [{ id: "B1", name: "Alex Borrower", mailing_address: "100 N Central Ave, Phoenix AZ 85004", email: "alex@example.com", esign_consent: true, primary: true }, { id: "B2", name: "Blake Borrower", mailing_address: "100 N Central Ave, Phoenix AZ 85004", email: "blake@example.com", esign_consent: true, primary: false }] });
  const approval = await tool(scope, "23.3", "issueConditionalApproval", { decision_id: decisionId, file, guard: GUARD, validity: VALIDITY, inputs: { ulad_snapshot_hash: built.output["request_hash"], verification_ids: ["ver-inc-1"], findings_hash: "findings:sub1" }, du_submission_id: submission["submission_id"], interpretation_id: interp.output["interpretation"] && (interp.output["interpretation"] as { interpretation_id?: string }).interpretation_id, evidence_document_ids: [`doc-pay-${R}`], rationale: "Approve/Eligible loan within policy; verified income, assets and liabilities reconcile to DU; no layering.", confidence: 0.94 }, UNDERWRITER);
  assert.equal(approval.output["valid_until"], "2026-11-21"); assert.ok(Number(approval.output["conditions_listed"]) >= 6 && Number(approval.output["conditions_listed"]) <= conditionIds.length, `${approval.output["conditions_listed"]} borrower-facing conditions of ${conditionIds.length}`); assert.ok((approval.output["events"] as string[]).includes("decision.issued"));
  clock.set("2026-10-29T20:00:00.000Z");
  const checklist = await tool(scope, "23.3", "runCtcChecklist", { op: "ctc", decision_id: decisionId, facts: CTC_FACTS }, UNDERWRITER);
  assert.equal(checklist.output["passed"], true, JSON.stringify(checklist.output).slice(0, 600));
  const ctc = await tool(scope, "23.3", "issueClearToClose", { decision_id: decisionId, checklist: checklist.output }, UNDERWRITER);
  assert.equal(ctc.output["event"], "clear_to_close.issued"); assert.equal((ctc.output["gate"] as { open: boolean }).open, true);
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_events WHERE application_id = $1 AND type = 'clear_to_close.issued' AND loan_id IS NULL`, [appId]), 1);
});

test("a10. closing scheduled and the CD on the bus: 26.2 schedules the RON closing for Fri Nov 6 14:00 MST (`closing.scheduled`); 25.2 records and reconciles the figure sources, renders CD v1 (Mon Nov 2), e-delivers it to both borrowers under their E-SIGN consent with e-sign receipts the same day → `earliest_consummation_date = 2026-11-05`, REGZ_1026_19F1_CD_3SBD_GATE armed on the application", { skip }, async () => {
  const scope = { app: appId };
  clock.set(MST("2026-11-02", "10:00"));
  const sch = await tool(scope, "26.2", "runPreSessionChecks", { op: "schedule", closing_id: CLOSING_ID, application_id: appId, scheduled_at: MST("2026-11-06", "14:00"), time_zone: "America/Phoenix", state: "AZ", county_fips: "04013", transaction_type: "limited_cash_out", dry_state: true, settlement_agent_party_id: AGENT_PARTY, notary_party_id: NOTARY.party_id, ron_provider_party_id: "P-RON-1", eligibility: ELIGIBILITY, signers: SIGNERS }, CLOSER);
  assert.equal(sch.output["closing_type"], "ron"); assert.ok(sch.events.some((e) => e.type === "closing.scheduled" && e.applicationId === appId));
  // 25.2: figure sources (settlement agent, escrow) recorded and reconciled to the fee lines
  await tool(scope, "25.2", "assembleCdFigures", { op: "record_source", source_id: `SRC-SA-${R}`, party: "settlement_agent", payload: { fees: [{ fee_code: "title_lender_policy", amount_cents: "120000" }, { fee_code: "settlement_fee", amount_cents: "60000" }, { fee_code: "recording", amount_cents: "3000" }] }, payload_document_id: "DOC-SA-FEES" }, DISCLOSURE);
  await tool(scope, "25.2", "assembleCdFigures", { op: "record_source", source_id: `SRC-ESCROW-${R}`, party: "escrow", payload: { monthly_cents: "68750", deposit_cents: "206250" } }, DISCLOSURE);
  const rec = await tool(scope, "25.2", "reconcileFigureSources", { fees: CD_FEES }, DISCLOSURE);
  assert.ok((rec.output as unknown as { reconciled: boolean }[]).every((s) => s.reconciled), JSON.stringify(rec.output).slice(0, 400));
  // 25.1's Appendix J APR on the bus for the CD (prepaid finance charges $3,849.95 incl. 19 days of prepaid interest)
  const apr = await tool(scope, "25.1", "computeApr", { loan_amount_cents: "56000000", note_rate_pct: "6.125", term_months: 360, term_start_date: "2026-11-12", first_payment_date: "2027-01-01", prepaid_finance_charges_cents: "384995", prepaid_interest_cents: "178543", checkpoint: "cd" }, COMPLIANCE);
  cdDisclosureId = `CD-${appId.slice(0, 8)}-1`;
  const cd = await tool(scope, "25.2", "renderCd", { disclosure_id: cdDisclosureId, cd_version: 1, transaction_type: "refinance", state: "AZ", required_consumer_ids: ["B1", "B2"],
    loan: { loan_amount_cents: "56000000", rate_pct: "6.125", term_months: 360, pi_cents: "340262", product: "Fixed Rate", loan_type: "Conventional", purpose: "Refinance", prepayment_penalty: false, balloon: false, arm: false, loan_id_number: appId, mic_number: null, first_payment_date: "2027-01-01", maturity_date: "2056-12-01" },
    apr: { apr_calculation_id: apr.output["apr_calculation_id"], apr_pct: apr.output["apr_disclosed_str"], finance_charge_cents: apr.output["finance_charge_cents"], amount_financed_cents: apr.output["amount_financed_cents"], total_of_payments_cents: apr.output["total_of_payments_cents"], tip_pct: String(Number(apr.output["tip_pct"]).toFixed(3)) },
    fees: CD_FEES, escrow: { established: true, monthly_escrow_cents: "68750", initial_escrow_payment_cents: "206250", escrowed_costs_year1_cents: "825000", non_escrowed_costs_year1_cents: "0" },
    parties: { borrowers: ["Alex Borrower", "Blake Borrower"], creditor_name: "Partner Bank, N.A.", creditor_nmlsr_id: "123456", mlo_name: "Jordan Rivera", mlo_nmlsr_id: "987654", settlement_agent_name: "Desert Title Agency LLC", settlement_agent_license_id: "AZ-TA-4471" },
    dates: { date_issued: "2026-11-02", closing_date: "2026-11-06", disbursement_date: "2026-11-12" }, property_address: "100 N Central Ave, Phoenix AZ 85004", cash_to_close_cents: "552943", lender_credits_cents: "70000", payoffs_and_payments_cents: "54820000", rescindable: true }, DISCLOSURE);
  assert.equal(cd.output["cd_version"], 1); assert.equal(cd.output["status"], "drafting", JSON.stringify(cd.output).slice(0, 400));   // gated when 25.1's gate run is recorded at delivery
  clock.set(MST("2026-11-02", "09:14"));
  for (const consumer of ["B1", "B2"]) {
    await tool(scope, "25.2", "deliverDisclosure", { disclosure_id: cdDisclosureId, consumer_id: consumer, channel: "esign_portal", at: MST("2026-11-02", "09:14"), esign_consent_id: `ESIGN-${consumer}`, ...(consumer === "B1" ? { gate_run: { run_id: "RUN-CD-1", open: true, apr_verdict: "pass", blocked_channels: [] } } : {}) }, DISCLOSURE);
    await tool(scope, "25.2", "recordReceipt", { disclosure_id: cdDisclosureId, consumer_id: consumer, evidence: "esign_confirmed", at: MST("2026-11-02", "09:30"), evidence_document_id: `DOC-ESIGN-${consumer}` }, DISCLOSURE);
  }
  const wp = await tool(scope, "25.2", "computeEarliestConsummation", { disclosure_id: cdDisclosureId }, DISCLOSURE);
  assert.equal(wp.output["complete"], true); assert.equal(wp.output["earliest_consummation_date"], "2026-11-05");   // Tue 3, Wed 4, Thu 5
  assert.equal(await n(`SELECT count(*)::text AS c FROM timers WHERE code = 'REGZ_1026_19F1_CD_3SBD_GATE' AND application_id = $1 AND status = 'armed'`, [appId]), 1);
  const gate = await tool(scope, "25.2", "assertGateOpen", { gate: "REGZ_1026_19F1_CD_3SBD_GATE", requested_on: "2026-11-06", op: "evaluate" }, DISCLOSURE);
  assert.equal(gate.output["open"], true);
});

test("a11. 26.1 closing documents on the bus (Wed Nov 4): the doc-gen gates, the closing snapshot, the AZ refinance eNote set (3200e, 3003 07/2021, final 1003, H-8 ×2) rendered — the note's data hash is the canonical note-terms hash ($3,402.62; Jan 1, 2027 → Dec 1, 2056) — QC passes and the set is released to the settlement agent", { skip }, async () => {
  const scope = { app: appId };
  clock.set(MST("2026-11-04", "10:00"));
  const terms = await tool(scope, "26.1", "computeNoteTerms", { principal_cents: "56000000", note_rate_pct: "6.125", term_months: 360, scheduled_disbursement_date: "2026-11-12", state: "AZ" }, CLOSER);
  assert.equal(terms.output["pi_cents"], "340262"); assert.equal(terms.output["first_payment_date"], "2027-01-01"); assert.equal(terms.output["maturity_date"], "2056-12-01");
  const g = await tool(scope, "26.1", "evaluateDocGenGates", { gate: DOCGEN_GATE }, CLOSER);
  assert.equal(g.output["gate_open"], true); closingSetId = g.output["set_id"] as string;
  await tool(scope, "26.1", "takeClosingSnapshot", { set_id: closingSetId, snapshot: CLOSING_SNAPSHOT(), gate: DOCGEN_GATE }, CLOSER);
  const rendered = await tool(scope, "26.1", "renderDocument", { set_id: closingSetId }, CLOSER);
  assert.equal(rendered.output["closing_type"], "ron"); assert.equal(rendered.output["enote"], true);
  const docs = rendered.output["documents"] as { document_id: string; kind: string; form_number: string; data_hash: string }[];
  assert.deepEqual(docs.map((d) => d.form_number), ["3200e", "3003", "URLA_1003_FINAL", "NTC_REGZ_1026_23_H8"]);
  noteDataHash = docs.find((d) => d.kind === "enote")!.data_hash; assert.equal(noteDataHash, terms.output["data_hash"], "closing_documents.data_hash of the note = noteTermsHash (30.2's OB-002 seam)");
  const smart = await tool(scope, "26.1", "buildSmartDocENote", { set_id: closingSetId }, CLOSER);
  assert.equal(smart.output["ok"], true); assert.equal(smart.output["tamper_seal_algorithm"], "SHA-256");
  const qc = await tool(scope, "26.1", "runDocumentQc", { set_id: closingSetId, upstream: { enote: smart.output, cd: { loan_amount_cents: "56000000", note_rate_pct: "6.125", pi_cents: "340262", org_nmlsr_id: "123456", mlo_nmlsr_id: "987654", first_payment_date: "2027-01-01" }, du: { loan_amount_cents: "56000000", note_rate_pct: "6.125", term_months: 360 }, lock: { note_rate_pct: "6.125" }, title: { vesting_text: CLOSING_SNAPSHOT().vesting_text, legal_description: CLOSING_SNAPSHOT().legal_description }, urla_1003: { org_nmlsr_id: "123456", mlo_nmlsr_id: "987654", loan_amount_cents: "56000000", note_rate_pct: "6.125", term_months: 360 }, note_date: "2026-11-06" } }, CLOSER);
  assert.equal(qc.output["passed"], true, JSON.stringify(qc.output["hard_failures"]));
  clock.set(MST("2026-11-05", "09:00"));
  const rel = await tool(scope, "26.1", "releaseToSettlementAgent", { set_id: closingSetId, released_to_party_id: AGENT_PARTY, facts: { qc_pass_gate_open: true, template_version_gate_open: true } }, CLOSER);
  assert.equal(rel.output["status"], "released", JSON.stringify(rel.output).slice(0, 400));
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_events WHERE application_id = $1 AND type = 'closing.documents.released' AND loan_id IS NULL`, [appId]), 1);
});

test("a12. 26.2 consummation on the bus (Fri Nov 6): the released set folded into the closing, pre-session checks pass, both signers proofed (credential analysis + KBA), the eNote signed 14:26 MST = `closing.consummated{note_date 2026-11-06}`, the deed of trust acknowledged, the Authoritative Copy tamper-sealed 14:41 and registered with MERS 14:46 (MERS_PROC_ENOTE_REGISTER_1BD satisfied)", { skip }, async () => {
  const scope = { app: appId };
  clock.set(MST("2026-11-05", "15:00"));
  const released = (await eventsOf(`application_id = $1 AND type = 'closing.documents.released'`, [appId]))[0]!;
  await tool(scope, "26.2", "runPreSessionChecks", { op: "upstream", closing_id: CLOSING_ID, event: { type: "closing.documents.released", occurredAt: MST("2026-11-05", "09:00"), payload: released.payload } }, CLOSER);
  clock.set(MST("2026-11-06", "13:30"));
  await tool(scope, "26.2", "verifyEsignConsent", { closing_id: CLOSING_ID, consent: CLOSING_CONSENT }, CLOSER);
  const pre = await tool(scope, "26.2", "runPreSessionChecks", { closing_id: CLOSING_ID, consent: CLOSING_CONSENT, facts: PRE_SESSION_FACTS }, CLOSER);
  assert.equal(pre.output["passed"], true, JSON.stringify(pre.output["blocking"]));
  clock.set(MST("2026-11-06", "14:00"));
  await tool(scope, "26.2", "openSigningSession", { closing_id: CLOSING_ID, session_id: SESSION_ID, signer_party_ids: ["B1", "B2"], notary: NOTARY, consent_record_id: CONSENT_ID }, CLOSER);
  for (const [party, hhmm, correct] of [["B1", "14:07", 5], ["B2", "14:11", 4]] as const) {
    clock.set(MST("2026-11-06", hhmm));
    await tool(scope, "26.2", "monitorSession", { op: "identity", closing_id: CLOSING_ID, party_id: party, method: "credential_analysis_kba", credential_type: "driver_license", credential_analysis_result: "pass", kba_attempts: [{ questions: 5, correct, seconds: 71, at: MST("2026-11-06", hhmm), notary_party_id: NOTARY.party_id }], notary_party_id: NOTARY.party_id, vendor: "Proof" }, CLOSER);
  }
  await tool(scope, "26.2", "monitorSession", { op: "start", closing_id: CLOSING_ID }, CLOSER);
  await tool(scope, "26.2", "monitorSession", { op: "enote_created", closing_id: CLOSING_ID, closing_document_id: `DOC-ENOTE-${R}`, min: MIN, partner_org_id: "1000123" }, CLOSER);
  await tool(scope, "26.2", "monitorSession", { op: "sign", closing_id: CLOSING_ID, closing_document_id: `DOC-1003-${R}`, kind: "final_1003", signer_party_id: "B1", signed_at: MST("2026-11-06", "14:18"), signature_method: "esign_ron", required_note_signers: ["B1", "B2"] }, CLOSER);
  await tool(scope, "26.2", "monitorSession", { op: "sign", closing_id: CLOSING_ID, closing_document_id: `DOC-ENOTE-${R}`, kind: "enote", signer_party_id: "B1", signed_at: MST("2026-11-06", "14:25"), signature_method: "esign_ron", required_note_signers: ["B1", "B2"] }, CLOSER);
  const signed = await tool(scope, "26.2", "monitorSession", { op: "sign", closing_id: CLOSING_ID, closing_document_id: `DOC-ENOTE-${R}`, kind: "enote", signer_party_id: "B2", signed_at: MST("2026-11-06", "14:26"), signature_method: "esign_ron", required_note_signers: ["B1", "B2"] }, CLOSER);
  assert.equal(signed.output["consummation_at"], MST("2026-11-06", "14:26")); assert.equal(signed.output["note_date"], "2026-11-06");
  assert.ok(signed.events.some((e) => e.type === "closing.consummated" && e.applicationId === appId && !e.loanId));
  for (const party of ["B1", "B2"]) await tool(scope, "26.2", "monitorSession", { op: "sign", closing_id: CLOSING_ID, closing_document_id: `DOC-DOT-${R}`, kind: "security_instrument", signer_party_id: party, signed_at: MST("2026-11-06", "14:31"), signature_method: "esign_ron", required_note_signers: ["B1", "B2"] }, CLOSER);
  await tool(scope, "26.2", "monitorSession", { op: "notarial_act", closing_id: CLOSING_ID, closing_document_id: `DOC-DOT-${R}`, kind: "security_instrument", act_type: "acknowledgment", completed_at: MST("2026-11-06", "14:36"), certificate_indicates_communication_technology: true, recordable: true, last: true, notary_party_id: NOTARY.party_id }, CLOSER);
  const copy = `<SMART_DOCUMENT version="1.02"><DATA min="${MIN}" amount="560000.00" rate="6.125"/></SMART_DOCUMENT>`;
  const { createHash } = await import("node:crypto"); const seal = createHash("sha256").update(copy).digest("hex");
  clock.set(MST("2026-11-06", "14:41"));
  await tool(scope, "26.2", "validateAuthoritativeCopy", { op: "seal", closing_id: CLOSING_ID, seal_hash: seal, signing_completed_at: MST("2026-11-06", "14:26"), authoritative_copy_ref: `EV-${R}`, tamper_sealed_at: MST("2026-11-06", "14:41") }, CLOSER);
  clock.set(MST("2026-11-06", "14:43"));
  const v = await tool(scope, "26.2", "validateAuthoritativeCopy", { closing_id: CLOSING_ID, authoritative_copy: copy }, CLOSER);
  assert.equal(v.output["gate_open"], true, String(v.output["reason"]));
  clock.set(MST("2026-11-06", "14:44"));
  const reg = await tool(scope, "26.2", "registerENote", { closing_id: CLOSING_ID }, CLOSER);
  assert.equal(reg.output["accepted"], true); assert.equal(reg.output["on_time"], true); assert.equal(reg.output["controller_org_id"], "1000123");
  const t = await db.query<{ status: string; due_date: string }>(`SELECT status, due_date::text FROM timers WHERE code = 'MERS_PROC_ENOTE_REGISTER_1BD' AND application_id = $1`, [appId]);
  assert.equal(t.length, 1); assert.equal(t[0]!.status, "satisfied"); assert.equal(t[0]!.due_date, "2026-11-09");
});

test("a13. 26.3 funding on the bus (Wed Nov 11 → Thu Nov 12): the funding opened on the consummation (rescission expired midnight ending Tue Nov 10; Veterans Day excluded → Thu Nov 12), the worksheet reconciled to the settlement statement ($557,249.57), every funding condition passing, `funding.authorized`, the wire prepared by the funder and released by the funding approver (dual control), accepted (IMAD), funds at the agent, and the disbursement confirmed → `loan.funded{disbursement_date 2026-11-12, prepaid interest 19 × $93.97 = $1,785.43}` keyed by the application", { skip }, async () => {
  const scope = { app: appId };
  clock.set(EST("2026-11-11", "11:00"));
  const open = await tool(scope, "26.3", "computeDates", { op: "open", funding_id: FUNDING_ID, state: "AZ", transaction_type: "limited_cash_out", time_zone: "America/Phoenix", consummation_at: MST("2026-11-06", "14:26"), review_completed_on: "2026-11-09", partner_id: PARTNER_ID, partner_loan_number: "PL-1001", gross_loan_cents: "56000000", note_rate_pct: "6.125", note_first_payment_date: "2027-01-01" }, FUNDER);
  const cal = open.output["calendar"] as Record<string, unknown>;
  assert.equal(cal["rescission_expires_at"], "2026-11-11T07:00:00.000Z"); assert.equal(cal["earliest_funding_date"], "2026-11-12"); assert.equal(cal["funding_type"], "dry");
  await tool(scope, "26.3", "buildFundingWorksheet", { funding_id: FUNDING_ID, version: 1, cd_version: 1, gross_loan_cents: "56000000", prepaid_interest_cents: "178543", escrow_deposit_cents: "166500", lender_credits_cents: "70000" }, FUNDER);
  const rec = await tool(scope, "26.3", "reconcileToSettlementStatement", { funding_id: FUNDING_ID, worksheet_id: `${FUNDING_ID}:ws:1`, agent_requested_net_cents: "55724957" }, FUNDER);
  assert.equal((rec.output["item"] as { status: string }).status, "pass");
  clock.set(EST("2026-11-12", "08:05"));
  const conditions = await tool(scope, "26.3", "evaluateFundingConditions", { funding_id: FUNDING_ID, facts: FUNDING_FACTS(EST("2026-11-12", "08:05")) }, FUNDER);
  assert.equal(conditions.output["passed"], true, JSON.stringify(conditions.output["blocking_codes"]));
  clock.set(EST("2026-11-12", "08:12"));
  const auth = await tool(scope, "26.3", "requestWarehouseAdvance", { funding_id: FUNDING_ID, conditions: conditions.output, rescission: FUNDING_FACTS(EST("2026-11-12", "08:12")).rescission, fraud_hold: { fraud_hold: false }, ptf: { ptf_cleared: true }, cash_to_close: { worksheet: { reconciled_to_cd: true, sufficient: true } }, gifts: [] }, FUNDER);
  assert.ok((auth.output["gates_asserted"] as string[]).length >= 1); assert.equal(await n(`SELECT count(*)::text AS c FROM loan_events WHERE application_id = $1 AND type = 'funding.authorized'`, [appId]), 1);
  await tool(scope, "26.3", "requestWarehouseAdvance", { funding_id: FUNDING_ID, op: "advance_approved", advance_id: `ADV-${R}` }, FUNDER);
  clock.set(EST("2026-11-12", "08:20"));
  fundingWireId = `W-${R}`;
  const wire = await tool(scope, "26.3", "prepareWire", { funding_id: FUNDING_ID, wire_id: fundingWireId, record: VERIFIED_WIRE, instructions_hash: VERIFIED_WIRE.instructions_hash, instructions_source: "verified_record", value_date: "2026-11-12", prepared_at: EST("2026-11-12", "08:20"), run_id: "run-funder-1", editors: ["u-analyst"], borrower_last_name: "Borrower", property_short: "100 N Central Ave, Phoenix AZ", funding_account_ref_hash: "sha256:funding", closing_documents: [] }, FUNDER);
  assert.equal((wire.output["wire"] as { amount_cents: string }).amount_cents, "55724957");
  clock.set(EST("2026-11-12", "09:40"));
  const rel = await tool(scope, "26.3", "prepareWire", { funding_id: FUNDING_ID, op: "release", wire_id: fundingWireId, bank_ref: "BK-1", released_at: EST("2026-11-12", "09:40") }, APPROVER);
  assert.equal((rel.output["wire"] as { status: string }).status, "released");
  await tool(scope, "26.3", "prepareWire", { funding_id: FUNDING_ID, op: "accept", wire_id: fundingWireId, imad: "20261112B1QGC01R000123", accepted_at: EST("2026-11-12", "09:41") }, FUNDER);
  clock.set(EST("2026-11-12", "13:00"));
  await tool(scope, "26.3", "notifySettlementAgent", { funding_id: FUNDING_ID, op: "agent_receipt", funds_received_by_agent_at: EST("2026-11-12", "13:00") }, FUNDER);
  clock.set("2026-11-12T18:40:00.000Z");   // 11:40 MST Thu Nov 12 — 26.3's loan.funded
  const funded = await tool(scope, "26.3", "confirmDisbursement", { funding_id: FUNDING_ID, disbursement_date: "2026-11-12", confirmed_at: "2026-11-12T18:40:00.000Z", source: "final_settlement_statement", evidence_document_id: "DOC-FSS", escrow_deposit_cents: "206250" }, FUNDER);
  const lf = funded.output["loan_funded"] as Record<string, unknown>;
  assert.equal(lf["funding_date"], "2026-11-12"); assert.equal(lf["disbursement_date"], "2026-11-12"); assert.equal(lf["per_diem_cents"], "9397"); assert.equal(lf["prepaid_interest_cents"], "178543"); assert.equal(lf["prepaid_days"], 19); assert.equal(lf["first_payment_date"], "2027-01-01"); assert.equal(lf["rescission_expires_at"], "2026-11-11T07:00:00.000Z");
  const e = funded.events.find((x) => x.type === "loan.funded")!;
  assert.equal(e.applicationId, appId); assert.equal(e.loanId, undefined, "no servicing loan exists yet: 26.3's loan.funded is keyed by the application only");
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_events WHERE application_id = $1 AND type = 'loan.funded' AND loan_id IS NULL`, [appId]), 1);
  assert.equal(await n(`SELECT count(*)::text AS c FROM loans WHERE origination_application_id = $1`, [appId]), 0);
});

// ═══════════════════════════════════════════════ the hand-off: 30.2 boards ONE loan from the record ═══════════════════════════════════════════════

test("b. POST /v1/applications/{id}/fund at 2026-11-12T18:40Z boards the loan from the record (26.3's loan.funded, 26.1's note hash, 26.2's consummation and MIN): both ids linked and on every hand-off event, OB-001…OB-022 pass, the opening set balances (principal 56,000,000 / escrow 206,250 / prepaid interest 178,543), SM_ORIG_BOARD_T1BD satisfied, a second call is a no-op", { skip }, async () => {
  clock.set("2026-11-12T18:40:00.000Z");
  // 30.2-T2 at the seam: a CD P&I of $3,402.63 against the note's $3,402.62 fails OB-003 (money field) → boarding refused (409), nothing persisted
  const refused = await call("POST", `/v1/applications/${appId}/fund`, { actor: FUNDING, snapshot: { final_cd: { document_id: cdDisclosureId, pi_cents: "340263", monthly_escrow_cents: "68750", initial_escrow_deposit_cents: "206250", prepaid_interest_cents: "178543", prepaid_interest_days: 19, compliance_tests_passed: true } } });
  assert.equal(refused.status, 409, JSON.stringify(refused.body).slice(0, 500));
  assert.equal(refused.body["error"], "refused"); assert.equal(refused.body["code"], "BOARDING_HARD_FAILURE"); assert.match(String(refused.body["reason"]), /OB-003/);
  assert.equal(await n(`SELECT count(*)::text AS c FROM loans WHERE origination_application_id = $1`, [appId]), 0);
  assert.equal((await db.query<{ loan_id: string | null }>(`SELECT loan_id FROM applications WHERE id = $1`, [appId]))[0]!.loan_id, null);
  assert.equal((await call("POST", `/v1/applications/${randomUUID()}/fund`, { actor: FUNDING })).status, 404);
  // the real hand-off: no funded override (26.3's event on the log is the payload), the CD figures from 25.2's rendered CD, the note terms hash from 26.1's rendered eNote (read from the record by the runtime)
  const r = await call("POST", `/v1/applications/${appId}/fund`, { actor: FUNDING, snapshot: { final_cd: { document_id: cdDisclosureId, pi_cents: "340262", monthly_escrow_cents: "68750", initial_escrow_deposit_cents: "206250", prepaid_interest_cents: "178543", prepaid_interest_days: 19, compliance_tests_passed: true } } });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 2000));
  loanId = r.body["loan_id"] as string;
  assert.equal(r.body["duplicate"], false); assert.equal(r.body["status"], "boarded_with_warnings");   // the worked example's open OW-* rows (OW-002 borrower B, OW-006, OW-008, OW-009)
  assert.match(String(r.body["servicing_loan_number"]), /^\d{10}$/);
  // the seam: loans.origination_application_id ↔ applications.loan_id; the MIN 26.2 registered; no Fannie Mae number until purchase (30.1)
  const loan = (await db.query<{ origination_application_id: string | null; fnma_loan_number: string | null; status: string; servicer_loan_number: string; boarded_at: string | null; partner_party_id: string; min: string | null; emortgage: boolean }>(`SELECT origination_application_id, fnma_loan_number, status, servicer_loan_number, boarded_at, partner_party_id, min, emortgage FROM loans WHERE id = $1`, [loanId]))[0]!;
  assert.equal(loan.origination_application_id, appId); assert.equal(loan.fnma_loan_number, null); assert.equal(loan.status, "active"); assert.equal(loan.servicer_loan_number, r.body["servicing_loan_number"]); assert.ok(loan.boarded_at); assert.equal(loan.partner_party_id, partnerPartyId); assert.equal(loan.min, MIN);
  const app = (await db.query<{ loan_id: string | null; status: string; prior_loan_id: string }>(`SELECT loan_id, status, prior_loan_id FROM applications WHERE id = $1`, [appId]))[0]!;
  assert.equal(app.loan_id, loanId); assert.equal(app.status, "funded"); assert.equal(app.prior_loan_id, priorLoanId);
  // borrowers and the property are linked from the application rows, not copied loose
  assert.equal(await n(`SELECT count(*)::text AS c FROM application_borrowers ab JOIN loan_borrowers lb ON lb.borrower_id = ab.borrower_id AND lb.loan_id = $2 WHERE ab.application_id = $1`, [appId, loanId]), 2);
  assert.equal(await n(`SELECT count(*)::text AS c FROM application_properties ap JOIN loans l ON l.property_id = ap.property_id WHERE ap.application_id = $1 AND l.id = $2`, [appId, loanId]), 1);
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_terms WHERE loan_id = $1 AND source = 'boarding' AND pi_cents = 340262 AND escrow_payment_cents = 68750 AND note_rate_bps = 61250`, [loanId]), 1);
  // every 30.2 event after the funding event carries BOTH ids; 26.3's loan.funded (keyed by the application) is the one 30.2 ingested — no fallback funded event
  const log = await eventsOf(`application_id = $1`, [appId]);
  const fundedRows = log.filter((e) => e.type === "loan.funded");
  assert.equal(fundedRows.length, 1, "30.2 ingested 26.3's loan.funded (no fallback event appended)");
  const fundedAt = log.findIndex((e) => e.type === "loan.funded"); const stagedAt = log.findIndex((e) => e.type === "loan.staged");
  assert.ok(fundedAt > 0 && stagedAt > fundedAt, "26.3's loan.funded precedes 30.2's loan.staged on the application's log");
  for (const e of log.slice(fundedAt + 1, stagedAt)) assert.equal(e.loan_id, null, `${e.type}: 26.3's post-disbursement bookkeeping is the application's alone`);
  for (const e of log.slice(stagedAt)) {
    assert.equal(e.application_id, appId, `${e.type} carries the application id`);
    if (e.type.startsWith("timer.")) continue;
    assert.equal(e.loan_id, loanId, `${e.type} carries the loan id`);
  }
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_events WHERE application_id = $1 AND type = 'timer.armed' AND payload->>'code' = 'SM_ORIG_FIRST_STATEMENT_LEAD_15' AND loan_id = $2`, [appId, loanId]), 1);
  for (const t of ["loan.staged", "loan.validated", "loan.boarded", "ledger.opening_posted", "consents.boarded", "documents.indexed", "timers.seeded", "statement.cycle.opened"]) assert.ok(log.some((e) => e.type === t), `${t} emitted`);
  assert.equal(log.filter((e) => e.type === "notice.sent" && e.loan_id === loanId).length >= 2, true, "a first-payment letter per borrower");
  // OB-001…OB-022 all pass; persisted keyed by the application
  const ob = (r.body["validations"] as { code: string; result: string; severity: string }[]).filter((v) => v.code.startsWith("OB-"));
  assert.equal(ob.length, 22); assert.deepEqual(ob.filter((v) => v.result !== "pass").map((v) => v.code), []);
  assert.equal(await n(`SELECT count(*)::text AS c FROM boarding_validations WHERE application_id = $1 AND rule_code LIKE 'OB-%' AND result = 'pass'`, [appId]), 22);
  // 30.2-T3 figures on the persisted ledger: one balanced opening set
  const ledger = await call("GET", `/v1/loans/${loanId}/ledger`);
  const sets = ledger.body["entry_sets"] as { id: string; lines: { account: string; amount_cents?: string; amountCents?: string }[] }[];
  assert.equal(sets.length, 1); assert.equal(sets[0]!.id, r.body["opening_entry_set_id"]);
  assert.equal(await loanBalance("principal"), 56_000_000n);
  assert.equal(-(await loanBalance("escrow")), 206_250n);            // $2,062.50 = 30.3 required start $687.50 + cushion $1,375.00
  assert.equal(-(await loanBalance("prepaid_interest")), 178_543n);  // $1,785.43 = 19 × $93.97
  assert.equal(await n(`SELECT count(*)::text AS c FROM (SELECT set_id FROM ledger_lines WHERE set_id = $1 GROUP BY set_id HAVING sum(amount_cents) <> 0) x`, [sets[0]!.id]), 0);
  // SM_ORIG_BOARD_T1BD: armed by loan.funded (application subject), satisfied by loan.boarded the same day (due Fri Nov 13)
  const t1bd = await db.query<{ status: string; due_date: string; anchor_date: string }>(`SELECT status, due_date::text, anchor_date::text FROM timers WHERE code = 'SM_ORIG_BOARD_T1BD' AND application_id = $1`, [appId]);
  assert.equal(t1bd.length, 1); assert.equal(t1bd[0]!.status, "satisfied"); assert.equal(t1bd[0]!.anchor_date, "2026-11-12"); assert.equal(t1bd[0]!.due_date, "2026-11-13");
  // 30.2-T13: the same funding delivered twice — the second is ignored with a receipt; one loans row, one ledger set, no second letter
  const lettersBefore = await n(`SELECT count(*)::text AS c FROM loan_events WHERE loan_id = $1 AND type = 'notice.sent'`, [loanId]);
  const again = await call("POST", `/v1/applications/${appId}/fund`, { actor: FUNDING });
  assert.equal(again.status, 200, JSON.stringify(again.body).slice(0, 500));
  assert.equal(again.body["duplicate"], true); assert.equal(again.body["loan_id"], loanId); assert.equal(again.body["servicing_loan_number"], r.body["servicing_loan_number"]);
  assert.equal(await n(`SELECT count(*)::text AS c FROM loans WHERE origination_application_id = $1`, [appId]), 1);
  assert.equal(await n(`SELECT count(DISTINCT set_id)::text AS c FROM ledger_lines WHERE loan_id = $1`, [loanId]), 1);
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_events WHERE loan_id = $1 AND type = 'notice.sent'`, [loanId]), lettersBefore);
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_events WHERE application_id = $1 AND type = 'loan.funded.duplicate_ignored' AND loan_id = $2`, [appId, loanId]), 1);
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_events WHERE application_id = $1 AND type = 'loan.funded'`, [appId]), 1);
  // the application's record over HTTP now shows the loan it became
  const rec = await call("GET", `/v1/applications/${appId}`);
  assert.equal((rec.body["application"] as { loan_id: string }).loan_id, loanId);
});

test("b2. delivery and purchase on the SAME loan id (29.4 / 30.1, Nov 13–20): the delivery registered with SM's warehouse wire instruction, the frozen package's import_and_submit task (SLA Mon Nov 16 15:00 MT), the eNote eDelivered and its same-day Transfer of Control (C1-2-04), the operator's evidence, the eVault's auto-certification, the Purchase Advice (price 101.125, net proceeds $564,503.33) → `loan.purchased` keyed by BOTH ids; 30.1 matches the advice (`loan.investor_updated`, loan_terms v2, SM_FNMA_LOAN_NUMBER_RECORD_T0 satisfied)", { skip }, async () => {
  const scope = { app: appId };   // funded: the application route scopes the command to the application AND its loan
  const dlv = `dlv-${loanId.slice(0, 8)}`;
  const servicingLoanNumber = (await db.query<{ n: string }>(`SELECT servicer_loan_number AS n FROM loans WHERE id = $1`, [loanId]))[0]!.n;
  clock.set(MST("2026-11-13", "10:05"));
  const reg = await tool(scope, "29.4", "openOperatorTask", { op: "register", delivery_id: dlv, loan_id: loanId, application_id: appId, partner_id: PARTNER_ID, seller_loan_number: servicingLoanNumber, commitment_id_fnma: "C-2026-0001", commitment_expires_on: "2026-12-07", note_form: "enote", enote_indicator: true, min: MIN, upb_cents: "56000000", note_rate: "6.125", pass_through_rate: "5.875", servicing_fee_rate: "0.250", commitment_price: "101.125000", remittance_type: "actual_actual", disbursement_date: "2026-11-12", first_payment_date: "2027-01-01", wire_instruction_id: `wire-sm-${R}`, payee_code: "SMWH1", commitment_closed: true, wire: WIRE_INSTRUCTION }, SECONDARY);
  assert.equal(reg.output["delivery_id"], dlv);
  const frozen = await tool(scope, "29.4", "openOperatorTask", { op: "frozen", delivery_id: dlv, package_id: `pkg-refi-${R}`, sha256: "a".repeat(64), file_name: `pkg-refi-${R}.xml`, frozen_at: MST("2026-11-13", "10:05") }, SECONDARY);
  assert.equal(frozen.output["package_id"], `pkg-refi-${R}`);
  clock.set(MST("2026-11-13", "10:06"));
  const task = await tool(scope, "29.4", "openOperatorTask", { delivery_id: dlv, at: MST("2026-11-13", "10:06"), gate_facts: { qm_type: "general_safe_harbor", apr_test_pass: true, pf_pass: true, product_tests_pass: true, consider_verify_complete: true, consider_verify_missing: [], stage: "consummation", computed_from_final_cd: true, is_hoepa: false, state_tests: [] } }, SECONDARY);
  assert.equal(task.output["sla_due_at"], MST("2026-11-16", "15:00")); assert.ok(task.output["task_id"]);
  clock.set(EST("2026-11-16", "11:02")); const ed = await tool(scope, "29.4", "requestEnoteTransfer", { op: "edeliver", delivery_id: dlv, at: EST("2026-11-16", "11:02") }, SECONDARY);
  assert.equal(ed.output["event"], "enote.edelivered");
  clock.set(EST("2026-11-16", "11:05")); const tr = await tool(scope, "29.4", "requestEnoteTransfer", { op: "transfer", delivery_id: dlv, effective_date: "2026-11-16", at: EST("2026-11-16", "11:05"), delegatee_on_file: true }, SECONDARY);
  assert.equal((tr.output["gate"] as { open: boolean }).open, true, JSON.stringify(tr.output).slice(0, 300));
  clock.set(EST("2026-11-16", "13:31"));
  const submitted = await tool(scope, "29.4", "parseOperatorEvidence", { task_id: task.output["task_id"], operator_id: OPERATOR.id, evidence: EVIDENCE, hash_confirmed: true, edits: [], captured_state: { fnma_loan_number: FNMA_NO(), submitted_at: EST("2026-11-16", "13:31"), commitment_number: "C-2026-0001", file_sha256: "a".repeat(64), loan_delivery_status: "Purchase Requested", certification_status: "Awaiting Certification" }, at: EST("2026-11-16", "13:31") }, OPERATOR);
  assert.ok(submitted.output);
  const pkg = await tool(scope, "29.4", "prepareCustodianPackage", { delivery_id: dlv }, SECONDARY);
  assert.equal(pkg.output["custody_mode"], "evault_auto"); assert.deepEqual(pkg.output["documents"], []);   // C1-2-04: an eNote has no paper custodian package
  clock.set(EST("2026-11-16", "18:30"));
  const cert = await tool(scope, "29.4", "trackShipment", { op: "certified", delivery_id: dlv, certified_at: EST("2026-11-16", "18:30"), certification_kind: "auto_certified_enote", notice_document_id: "doc-autocert-1", at: EST("2026-11-16", "18:30") }, SECONDARY);
  assert.equal(cert.output["purchase_ready_at"], "2026-11-16"); assert.equal(cert.output["expected_purchase_date"], "2026-11-17");
  clock.set(EST("2026-11-20", "06:00"));
  const advice = { purchase_advice_id: `pa-${R}`, fnma_loan_number: FNMA_NO(), advice_date: "2026-11-19", purchase_date: "2026-11-19", commitment_id_fnma: "C-2026-0001", payee_code: "SMWH1", remittance_type: "actual_actual", pass_through_rate: "5.875", servicing_fee_rate: "0.250", price: "101.125000", upb_cents: "56000000", principal_proceeds_cents: "56630000", interest_adjustment_cents: "-109667", llpa_total_cents: "70000", llpa_lines: [{ code: "LCOR_762_70", pct: "0.125", cents: "70000" }], fees: [], net_proceeds_cents: "56450333", wire_reference: "FEDW-20261119-001", source: "api", raw_payload_document_id: "doc-pa-json-1", received_at: EST("2026-11-20", "06:00") };
  const purchased = await tool(scope, "29.4", "ingestPurchaseAdvice", { delivery_id: dlv, advice, at: EST("2026-11-20", "06:00") }, SECONDARY);
  assert.ok(purchased.events.some((e) => e.type === "loan.purchased" && e.loanId === loanId && e.applicationId === appId), JSON.stringify(purchased.events.map((e) => e.type)));
  // 30.1: the advice matched on the servicing side → the investor update on the same loan row (loans.fnma_loan_number in the store projection; loan_terms v2 effective on the purchase date)
  clock.set(EST("2026-11-19", "10:30"));
  const m = await tool(scope, "30.1", "matchPurchaseAdvice", { loan: { loan_id: loanId, application_id: appId, servicing_loan_number: servicingLoanNumber, original_upb_cents: "56000000", first_payment_date: "2027-01-01", note_rate_pct: "6.125", commitment_remittance_type: "AA", escrowed: true, note_form: "enote", mers_registered: true, min: MIN },
    advice: { advice_id: `PA-${R}`, fnma_loan_number: FNMA_NO(), fnma_servicer_number: "123456789", lender_loan_number: servicingLoanNumber, advice_date: "2026-11-19", purchase_date: "2026-11-19", remittance_type: "AA", pass_through_rate: "5.875000", note_rate_pct: "6.125", servicing_fee_bps: 25, interest_adjustment_cents: "-109667", net_proceeds_cents: "56590333" } }, INVESTOR);
  assert.equal(m.output["ok"], true, JSON.stringify(m.output).slice(0, 400));
  assert.ok(m.events.some((e) => e.type === "loan.investor_updated" && e.loanId === loanId));
  assert.equal((await entity("loans", loanId))?.["fnma_loan_number"], FNMA_NO());
  assert.equal(await n(`SELECT count(*)::text AS c FROM loans WHERE origination_application_id = $1`, [appId]), 1, "purchase is an investor update, never a re-board");
});

// ═══════════════════════════════════════════════ servicing on the same loan id ═══════════════════════════════════════════════

test("c. servicing takes over on the same loan id: the origination hand-off timers (30.4's SM_TAX_SERVICE_ACTIVATE_2BD, 30.2's SM_ORIG_FIRST_STATEMENT_LEAD_15 due 2026-12-17) list under the loan, and the sweep on 2026-12-18 breaches the statement lead with an escalation on the loan", { skip }, async () => {
  const timers = (await call("GET", `/v1/loans/${loanId}/timers`)).body["timers"] as { id: string; code: string; status: string; dueDate?: string; loanId?: string; applicationId?: string }[];
  const codes = new Set(timers.map((t) => t.code));
  for (const c of ["SM_TAX_SERVICE_ACTIVATE_2BD", "SM_FLOOD_LOL_SERVICING_LINK_2BD", "SM_ORIG_FIRST_STATEMENT_LEAD_15", "SM_ORIG_ACTIVE_BEFORE_FIRST_DUE_GATE", "SM_ORIG_WARNING_CLEAR_10BD"]) assert.ok(codes.has(c), `${c} armed on the loan (have ${[...codes].join(", ")})`);
  const lead = timers.find((t) => t.code === "SM_ORIG_FIRST_STATEMENT_LEAD_15")!;
  assert.equal(lead.status, "armed"); assert.equal(lead.dueDate, "2026-12-17"); assert.equal(lead.loanId, loanId); assert.equal(lead.applicationId, appId);
  statementLeadTimerId = lead.id;
  // 30.2 opens 7.1's first statement cycle (`statement.cycle.opened{first_cycle=true}`) but does not send the statement — 7.1's `statement.sent` is what satisfies the lead; on Dec 18 it has not happened, so the clock breaches
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_events WHERE loan_id = $1 AND type = 'statement.sent'`, [loanId]), 0);
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_events WHERE loan_id = $1 AND type = 'statement.cycle.opened' AND payload->>'first_cycle' = 'true' AND payload->>'cycle_due_date' = '2027-01-01' AND payload->>'amount_due_cents' = '409012'`, [loanId]), 1);
  clock.set("2026-12-18T15:00:00.000Z");
  const sweep = await call("POST", "/v1/sweep");
  assert.equal(sweep.status, 200);
  const breaches = sweep.body["breaches"] as { loan_id: string | null; code: string; timer_id: string; escalate_to: string[] }[];
  const mine = breaches.filter((b) => b.loan_id === loanId);
  assert.ok(mine.some((b) => b.code === "SM_ORIG_FIRST_STATEMENT_LEAD_15" && b.timer_id === statementLeadTimerId), JSON.stringify(mine));
  assert.equal((await db.query<{ status: string }>(`SELECT status FROM timers WHERE id = $1`, [statementLeadTimerId]))[0]!.status, "breached");
  // the sweep's escalations reference the loan (one per breach, to the registry's escalation role)
  for (const b of mine) assert.equal(await n(`SELECT count(*)::text AS c FROM escalations WHERE loan_id = $1 AND sla_timer_id = $2`, [loanId, b.timer_id]), 1, `escalation for ${b.code}`);
  assert.ok(await n(`SELECT count(*)::text AS c FROM loan_events WHERE loan_id = $1 AND type = 'timer.breached' AND payload->>'code' = 'SM_ORIG_FIRST_STATEMENT_LEAD_15'`, [loanId]) === 1);
});

test("d. the Jan 1, 2027 installment ($3,402.62 P&I + $687.50 escrow = $4,090.12) received Wed Dec 30 posts through the 2.1 bus (payments.read/write, then ledger.post via payment.post from the allocation engine's plan): principal after payment 55,945,571 cents ($559,455.71)", { skip }, async () => {
  clock.set("2026-12-30T17:00:00.000Z");
  // 2.1: the receipt is written first (received_on is the immutable fact), the allocation engine produces the plan from the boarded cash state
  const written = await runtime.execute({ process: "2.1", name: "payments.read/write", loanId, actor: CASHIERING, input: { op: "write", id: PAY_ID(), loan_id: loanId,
    data: { payment_id: PAY_ID(), loan_id: loanId, amount_cents: 409_012n, received_on: "2026-12-30", credited_as_of: "2026-12-30", channel: "lockbox", designation: "contractual", status: "posted", identification_confidence: 0.99, conforming: true } } });
  assert.ok(written.events.some((e) => e.type === "payment.written" && e.loanId === loanId));
  const state = cashStateAtBoarding({ loan_id: loanId, note_date: D("2026-11-06"), note_rate_pct: "6.125", amount_cents: 56_000_000n, pi_cents: 340_262n, escrow_payment_cents: 68_750n, first_payment_date: D("2027-01-01"), late_charge_pct: "5.00", late_charge_grace_days: 15, escrowed: true });
  const plan = allocate(state, { payment_id: PAY_ID(), amount_cents: 409_012n, received_on: D("2026-12-30"), credited_as_of: D("2026-12-30"), designation: "contractual" });
  assert.ok(plan.outcome === "applied" || plan.outcome === "prepaid", plan.outcome);
  const inst = plan.installments[0]!;
  // F-1-09 30/360 split for the first installment: interest $2,858.33 (560,000 × 6.125% ÷ 12), principal $544.29, escrow $687.50; UPB after payment 1 $559,455.71 (30.2 worked figures)
  assert.equal(inst.due_date, "2027-01-01"); assert.equal(inst.interest_cents, 285_833n); assert.equal(inst.principal_cents, 54_429n); assert.equal(inst.escrow_cents, 68_750n); assert.equal(inst.upb_after_cents, 55_945_571n); assert.equal(plan.to_suspense_cents, 0n);
  const post = (description: string, lines: { account: ReturnType<typeof loanAcct> | ReturnType<typeof cust>; amountCents: bigint; ruleRef: string }[]) =>
    runtime.execute({ process: "2.1", name: "ledger.post", loanId, actor: CASHIERING, input: { loan_id: loanId, via: "payment.post", entry_set: { effectiveDate: "2026-12-30", description, lines } } });
  // 2.1 rule 8 sets, as CashieringService.postEntries posts them: receipt, allocation, cash split
  const r1 = await post(`receipt ${PAY_ID()}`, [{ account: cust(custodial.clearing, "clearing_cash"), amountCents: 409_012n, ruleRef: "2.1:r8:receipt" }, { account: loanAcct("suspense_unapplied"), amountCents: -409_012n, ruleRef: "2.1:r8:receipt" }]);
  assert.equal(r1.events.some((e) => e.type === "command.executed"), true);
  await post(`allocation ${PAY_ID()}`, [{ account: loanAcct("suspense_unapplied"), amountCents: 409_012n, ruleRef: "2.1:r8:allocation" }, { account: loanAcct("interest_due"), amountCents: -inst.interest_cents, ruleRef: "2.1:r8:allocation:interest" },
    { account: loanAcct("principal"), amountCents: -inst.principal_cents, ruleRef: "2.1:r8:allocation:principal" }, { account: loanAcct("escrow"), amountCents: -inst.escrow_cents, ruleRef: "2.1:r8:allocation:escrow" }]);
  await post(`cash split ${PAY_ID()}`, [{ account: cust(custodial.pi, "custodial_pi_cash"), amountCents: inst.interest_cents + inst.principal_cents, ruleRef: "2.1:r8:cash_split:pi" }, { account: cust(custodial.ti, "custodial_ti_cash"), amountCents: inst.escrow_cents, ruleRef: "2.1:r8:cash_split:escrow" }, { account: cust(custodial.clearing, "clearing_cash"), amountCents: -409_012n, ruleRef: "2.1:r8:cash_split" }]);
  assert.equal(await loanBalance("principal"), 55_945_571n);                 // $559,455.71
  assert.equal(await loanBalance("suspense_unapplied"), 0n);
  assert.equal(-(await loanBalance("escrow")), 206_250n + 68_750n);          // $2,750.00 escrow balance after the first deposit
  assert.equal(-(await loanBalance("interest_due")), 285_833n);              // interest collected (no accrual was posted at boarding — 30.2 opens principal/escrow/prepaid interest only)
  assert.equal(await n(`SELECT count(*)::text AS c FROM (SELECT set_id FROM ledger_lines WHERE set_id IN (SELECT set_id FROM ledger_lines WHERE loan_id = $1) GROUP BY set_id HAVING sum(amount_cents) <> 0) x`, [loanId]), 0);
  const sets = (await call("GET", `/v1/loans/${loanId}/ledger`)).body["entry_sets"] as unknown[];
  assert.equal(sets.length, 3);   // the loan's record lists the sets with a loan-scoped line: opening + receipt + allocation (the cash split moves custodial/corporate cash only)
  assert.equal(await n(`SELECT count(DISTINCT s.id)::text AS c FROM ledger_entry_sets s WHERE s.description LIKE '%' || $1`, [PAY_ID()]), 3);
});

test("e. payoff on the same loan through 16.1/16.2: computePayoffQuote, matchPayoffFunds (record + clear), postPayoff → `loan.paid_in_full` on the loan, every loan account at zero but escrow (refund pending)", { skip }, async () => {
  clock.set("2027-01-20T16:00:00.000Z");   // Wed Jan 20, 2027: the written payoff request
  const quote = await runtime.execute({ process: "16.1", name: "computePayoffQuote", loanId, actor: PAYOFF, input: { loan_id: loanId, quote_id: QUOTE_ID(), request_id: REQUEST_ID(), channel: "email", received_on: "2027-01-20", requester_type: "borrower",
    upb_cents: 55_945_571n, rate_pct: "6.125", lpi_due: "2027-01-01", good_through: "2027-01-29", state: "AZ", ledger_snapshot_id: "ledger-life-1" } });
  const q = quote.output as { total_cents: bigint; interest_cents: bigint; per_diem_cents: bigint; hash: string; request_id: string };
  assert.equal(q.request_id, REQUEST_ID()); assert.ok(quote.events.some((e) => e.type === "payoff.quote.computed" && e.loanId === loanId));
  // the calculator's figure: UPB $559,455.71 plus interest at 6.125% from the Jan 1 LPI through Jan 29 (16.1's accrual; the fixture states no fees); the engine's per diem on this UPB is $93.88
  assert.equal(q.per_diem_cents, 9_388n);
  assert.equal(q.total_cents, 55_945_571n + q.interest_cents);
  assert.ok(q.interest_cents > 0n && q.interest_cents <= 9_388n * 31n, `interest ${q.interest_cents}`);
  payoff = { quote_id: QUOTE_ID(), total_cents: q.total_cents, interest_cents: q.interest_cents };

  clock.set("2027-01-29T16:00:00.000Z");   // Fri Jan 29, 2027 11:00 ET: the wire arrives on the good-through date
  // 2.1 receipt of the wire (Dr clearing / Cr suspense) — the 16.2 application set draws on suspense_unapplied
  await runtime.execute({ process: "2.1", name: "ledger.post", loanId, actor: CASHIERING, input: { loan_id: loanId, via: "payment.post", entry_set: { effectiveDate: "2027-01-29", description: "receipt payoff wire", lines: [
    { account: cust(custodial.clearing, "clearing_cash"), amountCents: payoff.total_cents, ruleRef: "2.1:r8:receipt" }, { account: loanAcct("suspense_unapplied"), amountCents: -payoff.total_cents, ruleRef: "2.1:r8:receipt" }] } } });
  const matched = await runtime.execute({ process: "16.2", name: "matchPayoffFunds", loanId, actor: PAYOFF, input: { loan_id: loanId, amount_cents: payoff.total_cents, method: "wire", received_at: "2027-01-29T16:00:00.000Z", bank_reference: payoff.quote_id, remittance_type: "AA" } });
  const m = matched.output as { funds_id: string; status: string; matched: { quote_id: string } | null; payoff_date: string };
  assert.equal(m.status, "cleared"); assert.equal(m.matched?.quote_id, payoff.quote_id); assert.equal(m.payoff_date, "2027-01-29");
  assert.ok(matched.events.some((e) => e.type === "payoff.funds.received" && e.loanId === loanId)); assert.ok(matched.events.some((e) => e.type === "payoff.funds.cleared" && e.loanId === loanId));
  // the escrow balance rides on the buckets as a refund pending (16.2 rule 2: escrow is refunded separately, never netted)
  const escrowBalance = -(await loanBalance("escrow"));
  const posted = await runtime.execute({ process: "16.2", name: "postPayoff", loanId, actor: PAYOFF, input: { loan_id: loanId, funds_id: m.funds_id, amount_cents: payoff.total_cents, payoff_date: "2027-01-29", remittance_type: "AA", escrowed: true,
    buckets: { accrued_interest: payoff.interest_cents, principal: 55_945_571n, escrow_balance: escrowBalance }, custodial_pi_id: custodial.pi, custodial_ti_id: custodial.ti, custodial_clearing_id: custodial.clearing } });
  const p = posted.output as { settlement_id: string; zero: boolean; applied_cents: bigint; ledger_set_ids: string[] };
  assert.equal(p.zero, true); assert.equal(p.applied_cents, payoff.total_cents);
  const pif = posted.events.find((e) => e.type === "loan.paid_in_full") as DomainEvent | undefined;
  assert.ok(pif, "loan.paid_in_full emitted"); assert.equal(pif.loanId, loanId); assert.equal(pif.payload["payoff_date"], "2027-01-29"); assert.equal(pif.payload["settlement_id"], p.settlement_id);
  assert.ok(posted.events.some((e) => e.type === "payoff.applied" && e.loanId === loanId));
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_events WHERE loan_id = $1 AND type = 'loan.paid_in_full'`, [loanId]), 1);
  // 16.2 rule 3: every loan account posts to zero; the escrow balance stays as the refund pending (3.x's escrow refund clock); the sets balance
  assert.equal(await loanBalance("principal"), 0n); assert.equal(await loanBalance("suspense_unapplied"), 0n);
  assert.equal(-(await loanBalance("escrow")), escrowBalance);
  assert.equal(await n(`SELECT count(*)::text AS c FROM (SELECT set_id FROM ledger_lines WHERE set_id IN (SELECT set_id FROM ledger_lines WHERE loan_id = $1) GROUP BY set_id HAVING sum(amount_cents) <> 0) x`, [loanId]), 0);
  // 16.2 rule 3: `payoff_settlements.status = paid_in_full` and `loan.paid_in_full` on the log; the unit of work's loan projection (PgLoanRepository.projectStatus) sets `loans.status = paid_off` on that event — the same row, retired
  const settlement = await runtime.entities.current("payoff_settlements", p.settlement_id);
  assert.equal(settlement?.data["status"], "paid_in_full"); assert.equal(settlement?.data["loan_id"], loanId);
  assert.equal((await db.query<{ status: string }>(`SELECT status FROM loans WHERE id = $1`, [loanId]))[0]!.status, "paid_off");
});

test("f. the refinance loop: 20.1 evaluates the funded loan as a v_refi_universe row on the servicing book (a borrower request, loan scope — keyed by the loan alone), and a new application with prior_loan_id = the loan references it, shows it over HTTP, has no loan of its own — exactly ONE loans row ever carries the original application id", { skip }, async () => {
  assert.ok(loanId, "the loan this journey produced");
  clock.set(EDT("2027-01-30", "12:00"));
  // the trigger on the loan this journey produced: the same 20.1 tools, the same pricing rows (20.4's sheet re-published for the day), the loan's own id as the universe row
  await tool({}, "20.4", "publishRateSheet", { rate_sheet_id: "rs-2027-01-30", partner_id: PARTNER_ID, source: "pe_whole_loan_api", published_at: EST("2027-01-30", "06:35"), expires_at: EST("2027-01-30", "17:00"), prices: PRICES }, PRICING);
  await tool({ loan: loanId }, "20.1", "loadUniverse", { op: "load_row", program_id: PROGRAM_ID, row: { ...universeRow(), loan_id: loanId, note_date: "2026-11-06", first_payment_date: "2027-01-01", consummation_date: "2026-11-06", original_upb_cents: "56000000", note_rate_pct: "6.125", pi_cents: "340262", payments_made: 1, upb_cents: "55945571", next_due_date: "2027-02-01", remaining_term_months: 359 } });
  const req = await tool({ loan: loanId }, "20.1", "emitOfferReady", { op: "request", loan_id: loanId, program_id: PROGRAM_ID, free_text: "can I refinance again?" });
  assert.equal(req.output["loan_id"], loanId); assert.ok(["requested", "offer_ready", "suppressed"].includes(String(req.output["status"])), String(req.output["status"]));
  for (const e of req.events) { assert.equal(e.loanId, loanId, `${e.type} keyed by the loan`); assert.equal(e.applicationId, undefined, `${e.type} carries no application`); }
  clock.set("2027-01-30T17:00:00.000Z");
  const r = await call("POST", "/v1/applications", { actor: INTAKE, application: {
    partner_party_id: partnerPartyId, channel: "refi_trigger", transaction_type: "limited_cash_out", occupancy: "primary", prior_loan_id: loanId,
    borrowers: [{ legal_name: "Alex Borrower", borrower_role: "borrower" }, { legal_name: "Blake Borrower", borrower_role: "co_borrower" }],
    property: { address_line1: "100 N Central Ave", city: "Phoenix", state: "AZ", postal_code: "85004", county: "Maricopa", property_type: "sfr", units: 1 } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const app2 = r.body["application"] as { id: string; prior_loan_id: string | null; loan_id: string | null };
  assert.equal(app2.prior_loan_id, loanId); assert.equal(app2.loan_id, null); assert.notEqual(app2.id, appId);
  assert.equal((r.body["event"] as { payload: { prior_loan_id: string } }).payload.prior_loan_id, loanId);
  const rec = await call("GET", `/v1/applications/${app2.id}`);
  assert.equal(rec.status, 200);
  assert.equal((rec.body["application"] as { prior_loan_id: string }).prior_loan_id, loanId); assert.equal((rec.body["application"] as { loan_id: string | null }).loan_id, null);
  assert.equal((await db.query<{ prior_loan_id: string }>(`SELECT prior_loan_id FROM applications WHERE id = $1`, [app2.id]))[0]!.prior_loan_id, loanId);
  // one loan for life: the original application boarded exactly one servicing row, and nothing re-boards it (purchase, payoff, refinance all key the same id)
  assert.equal(await n(`SELECT count(*)::text AS c FROM loans WHERE origination_application_id = $1`, [appId]), 1);
  assert.equal(await n(`SELECT count(*)::text AS c FROM loans WHERE origination_application_id = $1`, [app2.id]), 0);
  assert.equal(await n(`SELECT count(DISTINCT loan_id)::text AS c FROM loan_events WHERE application_id = $1 AND loan_id IS NOT NULL AND loan_id <> $2`, [appId, priorLoanId]), 1);
});

test("g. the id grammar over the whole journey: before funding every event of the application is keyed by the application alone, 30.2's hand-off events carry both ids, everything after is keyed by the loan (and the application, until purchase closes the origination side), the loans row's origination_application_id links back, and the prior loan's record (the trigger, the solicitation, the lead) never names the application", { skip }, async () => {
  const log = await eventsOf(`application_id = $1 OR loan_id = $2 OR loan_id = $3`, [appId, loanId, priorLoanId]);
  const fundedSeq = Number(log.find((e) => e.type === "loan.funded" && e.application_id === appId)!.sequence);
  const stagedSeq = Number(log.find((e) => e.type === "loan.staged" && e.loan_id === loanId)!.sequence);
  const boardedSeq = Number(log.find((e) => e.type === "loan.boarded" && e.loan_id === loanId)!.sequence);
  assert.ok(fundedSeq < stagedSeq && stagedSeq < boardedSeq, "26.3 funds, then 30.2 stages and boards");
  let before = 0, during = 0, after = 0;
  for (const e of log) {
    const seq = Number(e.sequence);
    if (e.loan_id === priorLoanId) { if (e.type !== "refi.opportunity.converted") assert.equal(e.application_id, null, `${e.type} on the prior loan (the servicing book) never names the application`); continue; }
    if (e.application_id === appId && seq < stagedSeq) { before++; assert.equal(e.loan_id, null, `${e.type} (#${seq}) before the hand-off must be keyed by the application alone`); continue; }
    if (e.application_id === appId && seq >= stagedSeq && seq <= boardedSeq) { during++; if (e.type.startsWith("timer.")) continue; assert.equal(e.loan_id, loanId, `${e.type} (#${seq}) during the hand-off carries the loan`); continue; }
    if (seq > boardedSeq) { after++; if (e.type.startsWith("timer.") && e.application_id === appId) continue; assert.equal(e.loan_id, loanId, `${e.type} (#${seq}) after boarding is keyed by the loan`); if (e.application_id !== null) assert.equal(e.application_id, appId); }   // an origination clock that closes after boarding keeps its application subject
  }
  assert.ok(before >= 60, `${before} pre-funding events keyed by the application`); assert.ok(during >= 6, `${during} hand-off events`); assert.ok(after >= 10, `${after} servicing events`);
  // the seam in the rows: applications.loan_id ↔ loans.origination_application_id, and the loan's log names its application until purchase
  const link = (await db.query<{ app_loan: string | null; loan_app: string | null; prior: string | null }>(`SELECT a.loan_id AS app_loan, l.origination_application_id AS loan_app, a.prior_loan_id AS prior FROM applications a JOIN loans l ON l.id = a.loan_id WHERE a.id = $1`, [appId]))[0]!;
  assert.equal(link.app_loan, loanId); assert.equal(link.loan_app, appId); assert.equal(link.prior, priorLoanId);
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_events WHERE loan_id = $1 AND type = 'loan.purchased' AND application_id = $2`, [loanId, appId]), 1);
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_events WHERE loan_id = $1 AND type = 'loan.paid_in_full' AND application_id IS NULL`, [loanId]), 1, "servicing events after purchase carry the loan alone");
  // the entity rows: every pre-funding row of the journey is keyed by the application, the post-purchase rows by the loan
  assert.ok(await n(`SELECT count(DISTINCT kind)::text AS c FROM entity_records WHERE application_id = $1 AND loan_id IS NULL`, [appId]) >= 15);
  assert.ok(await n(`SELECT count(*)::text AS c FROM entity_records WHERE loan_id = $1`, [loanId]) >= 3);
});
