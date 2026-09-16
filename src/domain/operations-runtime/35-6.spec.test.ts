// 35.6 Closing, funding and delivery orchestration: the state machine from clear-to-close through the CD, consummation, funding, the hand-off from the record, delivery, purchase-advice reconciliation and the warehouse paydown
// spec/sections/35-operations-runtime/35-6-closing-funding-and-delivery-orchestration.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// The harness: this file's own database (src/infra/db/test-db.ts), one Runtime with a FixedClock and the FAKE reviewers
// (20 s delay), the API server in-process (the /v1 tools, POST /fund, the demo advance on a side runtime), and the sections'
// own worked examples driven through their REAL bus tools by the journey fixture (src/runtime/borrower/fixtures/journey.ts:
// the $560,000 LCOR at 6.125% in Phoenix; the OH purchase for T16/T17) — the "record" every pass derives its inputs from.
// Every money assertion is a bigint of cents against the section's exported constants (figures-35-6.ts) or the owner's output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { connect, type Db } from "../../infra/db/client.ts";
import { testDatabase } from "../../infra/db/test-db.ts";
import { decodeEntityData } from "../../infra/db/entities.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock } from "../../kernel/events/index.ts";
import { Runtime } from "../../runtime/app.ts";
import { createApiServer, listen } from "../../runtime/server.ts";
import { createBorrowerRouter } from "../../runtime/borrower/routes.ts";
let router: ReturnType<typeof createBorrowerRouter>;
import { createLogger } from "../../runtime/log.ts";
import { FakeReviewers } from "../../infra/integrations/reviewers.ts";
import { Journey, MST, EST, OFFICER } from "../../runtime/borrower/fixtures/journey.ts";
import { runOrchestrationPass, orchestrationByApplication, dailyReceipt, orchestrationBoard, EV } from "./orchestration-35-6.ts";
import { fakesFor, fakeHuman } from "./fakes-35-6.ts";
import { WORKED_A, WORKED_B } from "./figures-35-6.ts";
import { assembleAtrEvidence, type AporTableRow, type ConsiderVerifyFactor } from "../underwriting/ops-23-4.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { computeNoteTerms } from "../closing/ops-26-1.ts";
import { NO_CU_FLAGS } from "../property/ops-24-2.ts";

const { url: DB_URL, skip } = await testDatabase(import.meta.url);
const TOKEN = "t-" + randomUUID();
const clock = new FixedClock("2026-10-05T16:00:00.000Z");
const logLines: string[] = [];
const logger = createLogger("json", (line) => { logLines.push(line); if (process.env["ORCH_DEBUG"] && /"severity":"(ERROR|WARNING)"/.test(line)) process.stderr.write(line + "\n"); });
type P = Record<string, unknown>;
type Actor = { kind: "agent" | "human" | "system"; id: string; role?: string };
const VERIFICATION: Actor = { kind: "agent", id: "verification" }; const COMPLIANCE: Actor = { kind: "agent", id: "compliance-tester" }; const FRAUD_RISK: Actor = { kind: "agent", id: "fraud-risk" }; const VALUATION: Actor = { kind: "agent", id: "valuation" }; const UNDERWRITER: Actor = { kind: "agent", id: "underwriter" };
const DISCLOSURES: Actor = { kind: "agent", id: "disclosures" }; const PRICING: Actor = { kind: "agent", id: "pricing" }; const DISCLOSURE: Actor = { kind: "agent", id: "disclosure" }; const OPS: Actor = { kind: "human", id: "u-ops", role: "ops_analyst" };
void OFFICER; void OPS; void MST; void EST; void WORKED_A; void WORKED_B; void fakeHuman; void dailyReceipt; void orchestrationBoard; void EV;

let db: Db; let runtime: Runtime; let base = ""; let partnerPartyId = ""; let close: () => Promise<void> = async () => undefined;
const reviewers = new FakeReviewers({ delaySeconds: 20, logger: undefined });
test.before(async () => {
  if (skip) return;
  db = connect(DB_URL);
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock, reviewers, logger });
  router = createBorrowerRouter({ runtime, logger, environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost"], urlSecret: "test-secret" });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger, console: false, borrowerRouter: router });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => server.close(() => db.end().then(() => resolve())));
  const partner = await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id) VALUES ('servicer', $1, '123456789', '1000123') RETURNING id`, [`Partner Bank ${randomUUID().slice(0, 8)}`]);
  partnerPartyId = partner[0]!.id;
});
test.after(async () => { if (!skip) await close(); });

// ───────── helpers ─────────
const n = async (sql: string, params: unknown[] = []): Promise<number> => Number((await db.query<{ c: string }>(`SELECT count(*)::text AS c ${sql}`, params))[0]!.c);
const events = (appId: string, type?: string) => db.query<{ id: string; type: string; loan_id: string | null; application_id: string | null; occurred_at: string; sequence: string; payload: P; actor_kind: string; actor_id: string; actor_role: string | null }>(`SELECT id, type, loan_id, application_id, occurred_at::text AS occurred_at, sequence::text AS sequence, payload, actor_kind, actor_id, actor_role FROM loan_events WHERE (application_id = $1 OR loan_id = (SELECT loan_id FROM applications WHERE id = $1)) AND ($2::text IS NULL OR type = $2) ORDER BY sequence`, [appId, type ?? null]);
const entity = async (kind: string, id: string): Promise<P | null> => { const rows = await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = $1 AND id = $2`, [kind, id]); return rows[0] ? decodeEntityData(rows[0].data) : null; };
const entitiesOf = async (kind: string, appId: string): Promise<{ id: string; data: P }[]> => (await db.query<{ id: string; data: unknown }>(`SELECT id, data FROM entity_current WHERE kind = $1 AND data->>'application_id' = $2`, [kind, appId])).map((r) => ({ id: r.id, data: decodeEntityData(r.data) as P }));
const journal = (appId: string) => db.query<{ step: string; kind: string; clocked: boolean; waiting_on: string | null; command_process: string | null; command_name: string | null; command_op: string | null; actor_kind: string | null; actor_id: string | null; actor_role: string | null; decision_id: string | null; refusal_code: string | null; error_class: string | null; detail: P; sweep_run_id: string | null; trigger_event_id: string | null; created_at: string }>(`SELECT step, kind, clocked, waiting_on, command_process, command_name, command_op, actor_kind, actor_id, actor_role, decision_id, refusal_code, error_class, detail, sweep_run_id, trigger_event_id, created_at::text AS created_at FROM closing_orchestration_steps WHERE application_id = $1 ORDER BY created_at, id`, [appId]);
const timers = (appId: string, code: string) => db.query<{ status: string; due_date: string | null; due_at: string | null; loan_id: string | null; application_id: string | null; subject_kind: string; subject_id: string }>(`SELECT status::text AS status, due_date::text AS due_date, due_at::text AS due_at, loan_id, application_id, subject_kind, subject_id FROM timers WHERE code = $2 AND (application_id = $1 OR loan_id = (SELECT loan_id FROM applications WHERE id = $1)) ORDER BY armed_at`, [appId, code]);
const decisions = (appId: string) => db.query<{ id: string; agent: string; action: string; rationale: string }>(`SELECT id, agent, action, rationale FROM agent_decisions WHERE application_id = $1 ORDER BY created_at, id`, [appId]);
const escalations = (appId: string, ownerRole?: string) => db.query<{ id: string; kind: string; owner_role: string; severity: string | null; payload: P; completed_at: string | null }>(`SELECT id, kind, owner_role, severity, payload, completed_at::text AS completed_at FROM escalations WHERE application_id = $1 AND ($2::text IS NULL OR owner_role = $2) ORDER BY opened_at`, [appId, ownerRole ?? null]);
/** The 32.x flows react to committed events off the command's transaction (a StatusCard, a decision row); a footprint is taken only once they have landed. */
const settle = () => router.flows!.settle();
const pass = (at: string, appId?: string) => runOrchestrationPass(runtime, at, { ...(appId ? { applicationId: appId } : {}), holder: `test:${randomUUID().slice(0, 8)}` });
const row = async (appId: string) => (await orchestrationByApplication(db, appId))!;
const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: P }> => { const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) } : {}) }); return { status: r.status, body: (await r.json()) as P }; };
/** The counts T1/T12 compare across a pass that must write nothing: the whole row but the claim's own columns (the lease and `last_pass_as_of`, which every claim writes). */
const footprint = async (appId: string) => ({ steps: await n(`FROM closing_orchestration_steps WHERE application_id = $1`, [appId]), events: await n(`FROM loan_events WHERE application_id = $1`, [appId]), decisions: await n(`FROM agent_decisions WHERE application_id = $1`, [appId]), row: JSON.stringify(await row(appId), (k, v) => (k === "last_pass_as_of" || k === "lease_holder" || k === "lease_until" ? undefined : typeof v === "bigint" ? v.toString() : v)), reports: await n(`FROM entity_current WHERE kind = 'credit_reports' AND data->>'application_id' = $1`, [appId]) });
const SDN_LISTS = [{ list: "ofac_sdn", version: "SLS-2026-10-05", published_on: "2026-10-05" }, { list: "ofac_consolidated", version: "CONS-2026-10-05", published_on: "2026-10-05" }];
const FEE_TEST = { benchmark_id: "bench-az-013-urar", customary_and_reasonable: true, reason: "gross $650.00 within the p25–p75 band ($525.00–$700.00) of the Maricopa County URAR survey", gross_cents: "65000", appraiser_share_cents: "55000", amc_share_cents: "10000", held_for_requote: false };
const ORDER_PAYLOAD = { address: "100 N Central Ave, Phoenix AZ 85004", legal_description: "Lot 1, Block 2, Palm Estates", unit_count: 1, occupancy: "primary", transaction_type: "limited_cash_out", access_contact: { name: "Alex Borrower", phone: "602-555-0101" }, hoa_contact: null, scope: "traditional", form_code: "urar_uad36", uad_version: "3.6" };

/** A journey (the lifecycle fixture) over this file's runtime: the book, the application, the interview (trid), the LE received under 21.2, the credit fee handled. */
async function newJourney(): Promise<Journey> {
  const j = new Journey({ runtime, db, base, token: TOKEN, clock, borrowerEmail: `alex.${randomUUID().slice(0, 8)}@example.test`, coBorrowerEmail: `blake.${randomUUID().slice(0, 8)}@example.test`, partnerPartyId });
  await j.seedBook(); await j.openApplication(); await interviewWithJointIntent(j); await j.quoteAndLe();
  return j;
}
/** The journey's 21.1 interview (a5) with both borrowers' joint-intent affirmations at 10:20/10:22 MST (§1002.7(d), 21.1's own tool) before the six items at 10:41 — the joint-intent facts 22.2 reads from the record. */
async function interviewWithJointIntent(j: Journey): Promise<void> {
  const scope = { app: j.appId }; const R = j.R;
  clock.set(MST("2026-10-05", "10:14"));
  await j.tool(scope, "21.1", "startInterview", { session_id: `S-${R}`, partner_name: "Partner Bank", partner_nmlsr_id: "123456", intake_channel: "voice", creditor_time_zone: "America/Phoenix", property_state: "AZ", property_address: "100 N Central Ave, Phoenix, AZ 85004", transaction_type: "limited_cash_out", occupancy: "primary", borrowers: [{ id: "B1", legal_name: "Alex Borrower", marital_status: "married" }, { id: "B2", legal_name: "Blake Borrower", marital_status: "married" }], model_version: "intake-2026.09", prompt_version: "p-1.4" });
  clock.set(new Date("2026-10-05T10:14:07-07:00").toISOString()); await j.tool(scope, "21.1", "discloseAI", { session_id: `S-${R}`, utterance_id: `utt-${R}`, state: "AZ" });
  clock.set(MST("2026-10-05", "10:16")); await j.tool(scope, "21.1", "captureField", { field: "credit_request", transaction_type: "limited_cash_out", occupancy: "primary", property_state: "AZ", identity_verified: true });
  await j.tool(scope, "21.1", "confirmPrefill", { op: "offer", item: "name", value: "Alex Borrower" }); await j.tool(scope, "21.1", "confirmPrefill", { item: "name" });
  clock.set(MST("2026-10-05", "10:18")); await j.tool(scope, "21.1", "captureField", { field: "ssn", value: "123-45-6789", borrower_id: "B1" });
  await j.tool(scope, "21.1", "confirmPrefill", { op: "offer", item: "property_address", value: "100 N Central Ave, Phoenix, AZ 85004" }); clock.set(MST("2026-10-05", "10:19")); await j.tool(scope, "21.1", "confirmPrefill", { item: "property_address" });
  clock.set(MST("2026-10-05", "10:20")); await j.tool(scope, "21.1", "affirmJointIntent", { borrower_id: "B1", method: "web_checkbox", evidence_id: `ji-B1-${R}` });
  clock.set(MST("2026-10-05", "10:22")); await j.tool(scope, "21.1", "affirmJointIntent", { borrower_id: "B2", method: "web_checkbox", evidence_id: `ji-B2-${R}` });
  clock.set(MST("2026-10-05", "10:27")); await j.tool(scope, "21.1", "captureField", { field: "income", value: "1480000", borrower_id: "B1" });
  clock.set(MST("2026-10-05", "10:33")); await j.tool(scope, "21.1", "captureField", { field: "property_value_estimate", value: "80000000" });
  clock.set(MST("2026-10-05", "10:41")); const sixth = await j.tool(scope, "21.1", "captureField", { field: "loan_amount_sought", value: "56000000" });
  assert.equal(sixth.output["trid_emitted"], true);
}
/** T1's Given: a `consents` row of kind blanket_verification_authorization for both borrowers (32.2's row shape) and the partner's `credit_authorizations` row carrying the certification and subscriber code. */
async function seedCreditAuthorizations(j: Journey): Promise<{ consentIds: string[]; authorizationId: string }> {
  const consentIds: string[] = []; const partyIds: string[] = [];
  // the borrowers' parties (the borrower API's sign-in would link them; the fixture links them here) — consents.party_id and credit_authorizations.party_id reference parties
  for (const [k, abId] of j.abIds.entries()) {
    const party = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name) VALUES ('borrower', $1) RETURNING id`, [k === 0 ? "Alex Borrower" : "Blake Borrower"]))[0]!.id; partyIds.push(party);
    await db.query(`UPDATE application_borrowers SET party_id = $2 WHERE id = $1`, [abId, party]);
    const id = randomUUID(); consentIds.push(id);
    await db.query(`INSERT INTO consents (id, kind, granted, provenance, verified, captured_at, scope, status, captured_via, application_id, party_id, purpose, standing) VALUES ($1, 'blanket_verification_authorization'::consent_kind, true, 'portal', true, $2, '{income,assets}'::text[], 'active', 'portal', $3, $4, 'informational', true)`, [id, MST("2026-10-05", "10:22"), j.appId, party]);
  }
  const authorizationId = randomUUID();
  await db.query(`INSERT INTO credit_authorizations (authorization_id, application_id, kind, party_id, text_version, text_version_hash, signature_kind, captured_at, channel, evidence, permissible_purpose, end_user, consumer_initiated) VALUES ($1, $2, 'hard_application', $3, 'hard-application-2026-09', $4, 'esign_click_typed_name', $5, 'portal', $6::jsonb, 'consumer_initiated_credit_transaction_1681b_a3A', 'partner', true)`,
    [authorizationId, j.appId, partyIds[0]!, "a".repeat(64), MST("2026-10-05", "10:22"), JSON.stringify({ certification_ref: "CERT-PARTNER-1681E-2026", subscriber_code: "SUB-PARTNER-0417", authorization_ref: "AUTH-BLANKET-2026-10-05" })]);
  return { consentIds, authorizationId };
}
/** T2's Given beyond the score: 22.6 identity for both borrowers and the OFAC screen (clear), 24.1's valuation order — the identities the DU casefile carries. */
async function verifyIdentitiesAndValue(j: Journey): Promise<void> {
  const scope = { app: j.appId };
  clock.set(MST("2026-10-05", "11:00"));
  await j.tool(scope, "22.6", "verifyIdentity", { borrower_id: "B1", borrower_ids: ["B1", "B2"], scheduled_note_date: "2026-11-06" }, FRAUD_RISK);
  await j.tool(scope, "22.6", "verifyIdentity", { borrower_id: "B2", borrower_ids: ["B1", "B2"], scheduled_note_date: "2026-11-06" }, FRAUD_RISK);
  for (const [party, name] of [["B1", "Alex Borrower"], ["B2", "Blake Borrower"]] as const) await j.tool(scope, "22.6", "screenParty", { party_id: party, party_role: "borrower", name, lists: SDN_LISTS }, FRAUD_RISK);
  // 22.3: the income the casefile and 23.3's assessment reconcile to — a paystub ingested and classified under 22.1, the vendor's income verification received under the borrower's blanket authorization (B3-2-02)
  clock.set(MST("2026-10-05", "11:30"));
  await j.tool(scope, "22.1", "ingestDocument", { document_id: `doc-pay-${j.R}`, source_channel: "borrower_upload", sha256: "sha-doc-pay-1", subject_borrower_id: "B1", applicant_borrower_ids: ["B1", "B2"], page_count: 2 }, VERIFICATION);
  await j.tool(scope, "22.1", "classifyDocument", { document_id: `doc-pay-${j.R}`, doc_class: "paystub", confidence: 0.98 }, VERIFICATION);
  const consent = (await db.query<{ id: string }>(`SELECT id::text AS id FROM consents WHERE application_id = $1 AND kind::text = 'blanket_verification_authorization' ORDER BY captured_at LIMIT 1`, [j.appId]))[0]!;
  await j.tool(scope, "22.3", "orderVerificationReport", { op: "receive", borrower_id: "B1", kind: "income", supplier_code: "TRUV", report_reference_id: `TRUV-FAKE-${j.R}`, vendor_data_as_of: "2026-10-05", report_document_id: `doc-pay-${j.R}`, authorization_consent_id: consent.id, verification_id: `ver-inc-${j.R}`, employer_name: "Acme Manufacturing (FAKE payroll)" }, VERIFICATION);
  await j.tool(scope, "22.4", "declareAssets", { assets: [{ asset_id: `chk-${j.R}`, asset_type: "checking", borrower_ids: ["B1"], declared_balance_cents: "3124018", institution_name: "First Bank", account_last4: "1234", holder_names: ["Alex Borrower"] }], borrower_names: ["Alex Borrower", "Blake Borrower"] }, VERIFICATION);
  // 22.4: the checking account verified from two statements (the 45-day / two-month standard) — the usable funds the cash to close ($5,529.43) is measured against
  clock.set(MST("2026-10-06", "09:05"));
  for (const s of [{ id: `stmt-aug-${j.R}`, start: "2026-08-01", end: "2026-08-31" }, { id: `stmt-sep-${j.R}`, start: "2026-09-01", end: "2026-09-30" }]) await j.tool(scope, "22.4", "parseStatement", { asset_id: `chk-${j.R}`, document_id: s.id, period_start: s.start, period_end: s.end, ending_balance_cents: "3124018" }, VERIFICATION);
  await j.recordIntent();   // 21.4: "I want to proceed" Tue Oct 6 09:14 MST — 24.1's SM-borne order needs the intent in force
  clock.set(MST("2026-10-06", "09:20"));
  await j.tool(scope, "24.1", "readDuOffer", {}, VALUATION);
  const vo = await j.tool(scope, "24.1", "placeOrder", { transaction_type: "limited_cash_out", occupancy: "primary", units: 1, property_type: "sfr", ltv_bps: 7000, fee_paid_by: "sm", fee_quote_cents: "65000", fee_test: FEE_TEST, property_state: "AZ", vendor_party_id: "amc-1", channel: "amc", amc_registration: { amc_registration_id: `amcreg-az-${j.R}`, amc_party_id: "amc-1", state: "AZ", registration_number: "AMC-AZ-1234", expires_on: "2027-06-30", asc_amc_registry_status: "active", verified_at: MST("2026-10-01", "09:00") }, order_payload: ORDER_PAYLOAD, le_effective_receipt_date: "2026-10-05", ordered_at: MST("2026-10-06", "09:20"), time_zone: "America/Phoenix" }, VALUATION);
  j.valuationOrderId = String(vo.output["order_id"]);
  // 21.4: the borrower's lock request and the MLO's approval Wed Oct 7 (23.3's validity reads the lock's expiry; CTC_LOCK reads `lock.executed`)
  await j.quoteForLock();
  // 21.4's quote carries the priced terms the lock executes on: the sheet's price for 6.125 (the journey's rs-2026-10-07 row) and the lender credit 20.4 prices for this scenario ($700.00 = 0.125 % of the loan — the record's own figure, not a typed one); the lock's `lender_credit_cents` is what the CD, the funding worksheet and 27.1 read
  const jj = j as unknown as { QUOTE_INPUTS: Record<string, unknown>; PRICES: { note_rate_pct: string; price: string }[]; QUOTE: string };
  const priced = await j.tool(scope, "20.4", "solvePassThrough", { inputs: jj.QUOTE_INPUTS, quote_id: `${jj.QUOTE}-lock`, purpose: "lead_quote", partner_id: j.PARTNER_ID, lead_id: j.leadId }, PRICING);
  assert.equal(priced.output["outcome"], "priced", JSON.stringify(priced.output).slice(0, 300)); assert.equal(priced.output["lender_credit_cents"], "70000");
  const creditPct = ((Number(priced.output["lender_credit_cents"]) / 56_000_000) * 100).toFixed(3); const sheetPrice = jj.PRICES.find((p) => p.note_rate_pct === "6.125")!.price;
  const lockQuote = await j.tool(scope, "21.4", "getQuote", { loan_amount_cents: "56000000", product_code: "FRM30_CONV", note_rate_pct: "6.125", lock_period_days: 45, price_pct: sheetPrice, lender_credit_pct: creditPct, at: MST("2026-10-07", "10:06") }, PRICING);
  j.quoteId = String(lockQuote.output["quote_id"]);
  await j.requestLock(); await j.executeLockAndCommit();
  await complianceAtLe(j);
}
const APOR_TABLES = (): AporTableRow[] => ["2026-10-05", "2026-10-19", "2026-11-02"].map((week) => ({ table_id: `T-${week}`, published_on: D(week), effective_week: D(week), type: "fixed", rows: { "30": "6.020", "15": "5.400" }, source_url: "https://ffiec.cfpb.gov/tools/rate-spread", fetched_at: `${week}T13:05:00.000Z`, hash: `sha256:${week}` }));
const ATR = (creditReportId: string): ConsiderVerifyFactor[] => { const ev = (kind: string, id: string, source_process: string) => ({ kind, id, source_process }); return assembleAtrEvidence({
  income: { monthly_cents: 1_200_000n, evidence: [ev("paystub", "DOC-PAY-1", "22.3"), ev("du_validation_income_report", "DUV-INC-1", "22.3")], standard_ref: "SG-2020-06-03/B3-3.1-01 ≡ SG-2026-09-02/B3-3.2-01" },
  employment: { status: "employed_w2", evidence: [ev("vvoe", "VVOE-1", "22.3")], standard_ref: "SG-2020-06-03/B3-3.1-04 ≡ SG-2026-09-02/B3-3.1-04" },
  payment: { pi_cents: 340_262n, basis: "note_rate_fully_amortizing", evidence: [ev("le_projected_payments", "LE-1", "21.2")] },
  simultaneous_loans: { monthly_cents: 0n, evidence: [ev("credit_report", creditReportId, "22.5")], standard_ref: "SG-2020-06-03/B3-6-02" },
  mortgage_obligations: { monthly_cents: 68_750n, evidence: [ev("escrow_estimate", "LE-1", "21.2"), ev("hoi_declaration", "HOI-1", "24.5")], standard_ref: "SG-2020-06-03/B3-6-03" },
  debts: { monthly_cents: 142_000n, alimony_child_support_cents: 0n, evidence: [ev("credit_report", creditReportId, "22.5")], standard_ref: "SG-2020-06-03/B3-6-05" },
  dti: { pct: "38.00", evidence: [ev("dti_worksheet", "DTI-1", "22.5")], standard_ref: "SG-2020-06-03/B3-6-02" },
  credit_history: { report_id: creditReportId, pulled_at: D("2026-10-05"), standard_ref: "SG-2020-06-03/B3-5.1-01" } }); };
/** 25.1 / 23.4 at the LE stage — the platform's own compliance determinations the record must carry before 23.3 approves (B3-2-01: DU does not evaluate legal compliance): the APR at the LE checkpoint and the QM / HPML / HOEPA rows over the FFIEC table as ingested. */
async function complianceAtLe(j: Journey): Promise<void> {
  const scope = { app: j.appId };
  clock.set(MST("2026-10-07", "10:30"));
  const apr = await j.tool(scope, "25.1", "computeApr", { loan_amount_cents: "56000000", note_rate_pct: "6.125", term_months: 360, term_start_date: "2026-11-12", first_payment_date: "2027-01-01", prepaid_finance_charges_cents: "384995", prepaid_interest_cents: "178543", checkpoint: "le" }, COMPLIANCE);
  const reportId = (await db.query<{ id: string }>(`SELECT id FROM entity_current WHERE kind = 'credit_reports' AND data->>'application_id' = $1 AND data->>'report_type' = 'tri_merge_infile' LIMIT 1`, [j.appId]))[0]?.id ?? "CR-1";
  const fees = [{ fee_item_id: "F-ORIG", service_code: "origination", description: "Origination fee", amount_cents: "199500", paid_to: "Partner Lender", paid_to_kind: "creditor", payee: "Partner Lender", retained_by_creditor: true }, { fee_item_id: "F-PPI", service_code: "interest_prepaid", description: "Prepaid interest Nov 12–30 (19 × $93.97)", amount_cents: "178543", paid_to: "Partner Lender", paid_to_kind: "creditor", payee: "Partner Lender" }, { fee_item_id: "F-CR", service_code: "credit_report", description: "Credit report", amount_cents: "7500", paid_to: "Xactus LLC", paid_to_kind: "third_party", payee: "Xactus LLC" }, { fee_item_id: "F-TITLE", service_code: "settlement_fee", description: "Title / settlement services", amount_cents: "180000", paid_to: "Desert Title Agency", paid_to_kind: "third_party", payee: "Desert Title Agency", affiliate: false, reasonable: true }, { fee_item_id: "F-REC", service_code: "recording", description: "Recording fee", amount_cents: "9500", paid_to: "Maricopa County Recorder", paid_to_kind: "public_official", payee: "Maricopa County Recorder" }];
  await j.tool(scope, "23.4", "runQmTests", { op: "stage", stage: "le", apr: apr.output["apr_disclosed_str"], apr_calculation_id: apr.output["apr_calculation_id"], loan_amount_cents: "56000000", locks: [{ lock_id: j.lockId, kind: "initial", locked_at: MST("2026-10-07", "10:19"), rate_pct: "6.125", product: "fixed", term_years: 30 }], apor_tables: APOR_TABLES(), fee_items: fees, product: { term_months: 360, amortization: "fully_amortizing", substantially_equal_payments: true, arm: null }, consider_verify: ATR(reportId), state: "AZ", county: "Maricopa" }, COMPLIANCE);
}
/** The shared refinance orchestration the chain T1 → T11 drives in file order; each T-id's Given is the previous T-id's Then. */
const chain: { j: Journey | null; m: Journey | null; u: Journey | null } = { j: null, m: null, u: null };   // j: the main line; m: T4's second journey (the mailed CD), carried into T5's held branch
async function chainJourney(): Promise<Journey> { if (!chain.j) { chain.j = await newJourney(); await seedCreditAuthorizations(chain.j); } return chain.j; }
/** 23.3 evaluateClearance + clearCondition through 23.3's own tools: the borrower-supplied evidence (32.6's cards would do the same); a stale document leaves the item `satisfied_pending_review` for the reviewer. */
async function clearConditionsThrough233(j: Journey, o: { stale?: number } = {}): Promise<{ cleared: string[]; pending: string[] }> {
  const conds = await entitiesOf("conditions", j.appId);
  const cleared: string[] = []; const pending: string[] = [];
  let k = 0;
  for (const c of conds.filter((x) => !["cleared", "waived", "superseded", "not_applicable"].includes(String(x.data["status"])))) {
    const kinds = (c.data["evidence_kinds"] as string[] | undefined) ?? [];
    const stale = k < (o.stale ?? 0); k++;
    const evidence = (kinds.length ? kinds : ["letter_of_explanation"]).map((kind, m) => ({ document_id: `doc-${c.id.slice(0, 8)}-${m}`, kind, document_date: stale ? "2026-05-01" : "2026-10-20", classified_at: MST("2026-10-28", "09:00") }));
    const ev = await j.tool({ app: j.appId }, "23.3", "evaluateClearance", { condition_id: c.id, note_date: "2026-11-06", evidence }, UNDERWRITER);
    if (ev.output["outcome"] === "cleared") { await j.tool({ app: j.appId }, "23.3", "clearCondition", { condition_id: c.id, evaluation: ev.output, closing_date: "2026-11-06" }, UNDERWRITER); cleared.push(c.id); }
    else pending.push(c.id);
  }
  return { cleared, pending };
}
const CLOSER: Actor = { kind: "agent", id: "title-closing" };
const TITLE_HOLDERS = ["Alex Borrower", "Blake Borrower"];
const MORTGAGEE_CLAUSE = "Partner Bank, N.A., its successors and/or assigns, c/o Supermortgage, P.O. Box 7900, Phoenix AZ 85011";
const SFHDF_AE = { certificate_id: "SFHDF-AE-1", zone: "AE", map_panel: "04013C2210M", map_date: "2020-10-16", community_number: "040051", community_name: "City of Phoenix", community_participating: true, program_status: "regular", structures: [{ kind: "principal", in_sfha: true, zone: "AE" }], lol_purchased: true, sfhdf_form_version: "FF-206-FY-21-116", sfhdf_document_id: "DOC-SFHDF-1", vendor_ref: "CTL-9917" };
const hazardPolicy = (R: string) => ({ policy_id: `HZ-REFI-${R}`, policy_kind: "hazard", policy_number: "HO-4471-2026", carrier: "Desert Mutual", coverage_dwelling_cents: "52000000", coverage_basis: "replacement_cost", roof_basis: "acv", coverage_form: "special", deductible_cents: "500000", per_peril_deductibles: [{ peril: "windstorm_hail", pct: "2" }], ratings: [{ agency: "am_best", grade: "A" }], mortgagee_clause_text: MORTGAGEE_CLAUSE, named_insureds: TITLE_HOLDERS, effective_date: "2026-11-01", expiration_date: "2027-11-01", first_year_premium_cents: "195000", policy_in_force: true, premium_paid_through: "2027-11-01", evidence_kind: "declarations", evidence_document_id: `DOC-HZ-${R}` });
/** 24.4 and 24.5 — the platform's own items the CTC checklist and 26.3's funding conditions read: the settlement agent vetted, the title order, the commitment, the CPL; the insurance requirement, the adequate hazard policy, the flood determination. Returns the title order id (25.2's figure source). */
async function titleAndInsurance(j: Journey): Promise<{ titleOrderId: string; uwParty: string }> {
  const scope = { app: j.appId }; const AGENT = j.AGENT_PARTY; const uwParty = `TU-AZ-${j.R}`; const partnerName = "Partner Bank, N.A.";
  clock.set(MST("2026-10-07", "10:00"));
  await j.tool(scope, "24.5", "computeInsuranceRequirements", { computed_at: MST("2026-10-07", "10:00"), facts: { computed_from: "du_findings", property: { units: 1, project_type: "detached" }, hazard: { coverage_dwelling_cents: "52000000" } } }, CLOSER);
  clock.set(MST("2026-10-08", "09:00"));
  await j.tool(scope, "24.5", "orderFloodDetermination", { property_id: `PROP-${j.R}`, address_hash: "sha256:phx-100-n-central", fee_gate_result: "open", ordered_at: MST("2026-10-08", "09:00") }, CLOSER);
  clock.set(MST("2026-10-08", "12:30"));
  await j.tool(scope, "24.5", "parseSFHDF", { sfhdf: SFHDF_AE, received_at: MST("2026-10-08", "12:30") }, CLOSER);
  clock.set(MST("2026-10-22", "15:00"));
  await j.tool(scope, "24.5", "evaluateAdequacy", { policy: hazardPolicy(j.R), title_holders: TITLE_HOLDERS, partner: { legal_name: partnerName }, transaction_type: "refinance", disbursement_date: "2026-11-12", verified_at: MST("2026-10-22", "15:00") }, CLOSER);
  // 24.5: the property sits in Zone AE (the fixture's SFHDF) — the NFIP policy verified against the closing date (44 CFR 61.11) → `flood.coverage.verified` (FNMA_B7_3_06_FLOOD_COVERAGE_GATE)
  const nfip = { policy_id: `FL-NFIP-${j.R}`, nfip: true, building_coverage_cents: "25000000", deductible_cents: "500000", applied_on: "2026-10-20", premium_paid_on: "2026-10-20", effective_date: "2026-11-06", expiration_date: "2027-11-06", annual_premium_cents: "115000", mortgagee_clause_text: MORTGAGEE_CLAUSE, evidence_kind: "flood_declarations", evidence_document_id: `DOC-FLOOD-DEC-${j.R}` };
  const flood = await j.tool(scope, "24.5", "computeFloodAmount", { op: "verify", policy: nfip, partner: { legal_name: partnerName }, rcv_improvements_cents: "52000000", note_amount_cents: "56000000", closing_date: "2026-11-06", transaction_type: "refinance", verified_at: MST("2026-10-22", "15:10") }, CLOSER);
  assert.equal(flood.output["pass"], true, JSON.stringify(flood.output).slice(0, 400));
  clock.set(MST("2026-10-27", "09:00"));
  await j.tool(scope, "24.4", "vetSettlementAgent", { party_id: AGENT, agent_type: "title_agency", state: "AZ", property_state: "AZ", license_active: true, license_number: "AZ-TA-4471", eo_policy_limit_cents: "200000000", eo_expires_on: "2027-06-30", fidelity_limit_cents: "100000000", alta_registry_id: "ALTA-AZ-4471", underwriter_confirmed_by: uwParty, best_practices_attestation_at: "2026-08-15", wire_instructions_on_letterhead: true, cpl_available: true, underwriter_callback_number_verified: true, referral_consideration: false, at: clock.now() }, CLOSER);
  const titleOrder = await j.tool(scope, "24.4", "orderTitle", { settlement_agent_party_id: AGENT, underwriter_party_id: uwParty, apn: "112-23-045", note_amount_cents: "56000000", proposed_insured_text: `${partnerName}, its successors and/or assigns`, closing_date: "2026-11-06", property: { state: "AZ" }, at: clock.now() }, CLOSER);
  const titleOrderId = (titleOrder.output["order"] as { id: string }).id;
  clock.set(MST("2026-10-28", "10:00"));
  await j.tool(scope, "24.4", "parseCommitment", { order_id: titleOrderId, commitment_number: `CMT-AZ-${j.R}`, commitment_effective_date: "2026-10-27", underwriter_party_id: uwParty, underwriter_state: "AZ", doi_licensed: true, strength_basis: "rating", policy_form: "ALTA Loan Policy (07-01-2021)", policy_amount_cents: "56000000", legal_description: "Lot 1, Block 2, Palm Estates, per Book 100 of Maps, page 7, Maricopa County records", apn: "112-23-045", vesting: { names: TITLE_HOLDERS, tenancy: "joint", trust: false, estate: "fee_simple" }, schedule_b1_requirements: ["Release of the existing first deed of trust, recorded"], schedule_b2_exceptions: [], endorsements_committed: ["ALTA 8.1-06"], property: { state: "AZ" }, appraisal_legal_description: "Lot 1, Block 2, Palm Estates, per Book 100 of Maps, page 7, Maricopa County records", at: clock.now() }, CLOSER);
  await j.tool(scope, "24.4", "requestCPL", { order_id: titleOrderId, partner_name: partnerName, sm_addressee_required: true, at: clock.now() }, CLOSER);
  await j.tool(scope, "24.4", "requestCPL", { op: "receive", order_id: titleOrderId, cpl_document_id: `doc-cpl-${j.R}`, cpl_date: "2026-10-28", cpl_underwriter_party_id: uwParty, cpl_agent_party_id: AGENT, addressees: [`${partnerName}, its successors and/or assigns`, "Supermortgage LLC, as bailee/secured party"], partner_name: partnerName, sm_addressee_required: true, funding_date: "2026-11-12", at: clock.now() }, CLOSER);
  return { titleOrderId, uwParty };
}
const ESCROW_AGENT: Actor = { kind: "agent", id: "escrow" };
/** The borrowers' E-SIGN consents (32.2's `consent.captureEsign` writes the same row): scope disclosures + closing_package, the hardware/software statement version, access demonstrated. `without` leaves that borrower on paper. */
async function seedEsignConsents(j: Journey, without: readonly string[] = []): Promise<void> {
  const rows = await db.query<{ id: string; borrower_id: string | null; party_id: string | null }>(`SELECT id::text AS id, borrower_id, party_id::text AS party_id FROM application_borrowers WHERE application_id = $1 ORDER BY created_at, id`, [j.appId]);
  for (const [k, r] of rows.entries()) {
    if (without.includes(String(r.borrower_id)) || without.includes(`B${k + 1}`)) continue;   // application_borrowers rows in creation order are the interview's B1, B2 (the order facts-35-6-b.ts esignConsents reads them in)
    await db.query(`INSERT INTO consents (id, kind, granted, provenance, verified, captured_at, scope, status, captured_via, application_id, party_id, purpose, hw_sw_version, standing) VALUES ($1, 'esign'::consent_kind, true, 'portal', true, $2, '{disclosures,notices,closing_package,esign_signatures}'::text[], 'active', 'portal', $3, $4, 'informational', '2026.1', true)`, [randomUUID(), MST("2026-10-05", "10:20"), j.appId, r.party_id]);   // hw_sw_version: the 25.1 esign.7001c rule set's current hardware/software statement (2026.1)
  }
}
/** The platform's own items the closing steps read from the record: 30.3's initial escrow analysis (approved), 22.4's funds-to-close worksheet, 24.4's payoff statement and the verified wire, 22.3's VVOE (after the slot is scheduled — the window is measured to the note date). */
async function closingPrereqs(j: Journey): Promise<void> {
  const scope = { app: j.appId };
  clock.set(MST("2026-10-26", "09:00"));
  await j.assignMlo();   // 21.1: the MLO of record (the CD's contact block)
  await j.tool(scope, "24.4", "requestPayoff", { liability_id: `L-PRIOR-${j.R}`, existing_servicer_party_id: partnerPartyId, requested_good_through: "2026-11-13", state: "AZ", written_authorization_document_id: `DOC-AUTH-${j.R}`, request_channel: "email", requested_on: "2026-10-26" }, CLOSER);
  clock.set(MST("2026-10-28", "11:00"));
  await j.tool(scope, "24.4", "parsePayoffStatement", { liability_id: `L-PRIOR-${j.R}`, statement_document_id: `DOC-PAYOFF-${j.R}`, statement_date: "2026-10-28", principal_cents: "55916588", rate_pct: "7.000", interest_paid_through: "2026-10-31", per_diem_cents: "10724", good_through_date: "2026-11-13", disbursement_date: "2026-11-12" }, CLOSER);
  clock.set(MST("2026-10-29", "09:00"));
  await j.tool(scope, "30.3", "buildEscrowLines", { op: "build", first_payment_date: "2027-01-01", parcel: { apn: "112-23-045", state: "AZ", county: "Maricopa", annual_cents: "640000", basis: "known_bill", installments: [{ tax_year: 2026, installment_no: 1, amount_cents: "320000", due_on: "2026-10-01", penalty_on: "2026-11-01", paid: true }, { tax_year: 2026, installment_no: 2, amount_cents: "320000", due_on: "2027-03-01", penalty_on: "2027-05-01" }, { tax_year: 2027, installment_no: 1, amount_cents: "320000", due_on: "2027-10-01", penalty_on: "2027-11-01" }, { tax_year: 2027, installment_no: 2, amount_cents: "320000", due_on: "2028-03-01", penalty_on: "2028-05-01" }] }, policies: [{ policy_number: "HO-7781", kind: "hazard", first_year_premium_cents: "185000", premium_paid_through: "2027-11-06", renewal_invoice_due_on: "2027-10-07", required_by_creditor: true }] }, ESCROW_AGENT);
  await j.tool(scope, "30.3", "buildEscrowLines", { op: "run_analysis", analysis_id: `EA-${j.R}`, first_payment_date: "2027-01-01", settlement_date: "2026-11-06", disbursement_date: "2026-11-12", pi_cents: "340262" }, ESCROW_AGENT);
  await j.tool(scope, "30.3", "buildEscrowLines", { op: "approve_analysis", analysis_id: `EA-${j.R}`, reviewed: true, rationale: "engine analysis within the (c)(5) cap; every line from a known bill or a declarations page" }, ESCROW_AGENT);
  clock.set(MST("2026-10-29", "10:00"));
  await j.tool(scope, "22.4", "buildFundsToCloseWorksheet", { worksheet_id: `ws-${j.appId}`, stage: "pre_cd", transaction: "lcor", sales_price_cents: "0", appraised_value_cents: "80000000", loan_amount_cents: "56000000", total_closing_costs_cents: "566943", payoffs_cents: "56056000", lender_credit_premium_cents: "70000", reserves_required_cents: "0" }, VERIFICATION);
  clock.set("2026-11-03T15:00:00.000Z");
  await j.tool(scope, "24.4", "verifyWireInstructions", { purpose: "closing_funds", beneficiary_party_id: j.AGENT_PARTY, routing_number: "122105278", account_number: "4471009822", instructions_channel: "portal", vendor: "fundingshield", vendor_match: "verified", vendor_ref: `FS-${j.R}`, callback: { completed: true, number_source: "alta_registry" }, funding_at: EST("2026-11-12", "08:00"), at: "2026-11-03T15:00:00.000Z" }, CLOSER);
}
/** 22.3's verbal VOE inside 10 business days of the note date (the DU validation path: the vendor's employment validation with its close-by date). */
async function vvoe(j: Journey, at: string): Promise<void> {
  clock.set(at);
  for (const b of ["B1", "B2"]) await j.tool({ app: j.appId }, "22.3", "orderVerificationReport", { op: "du_validation", borrower_id: b, component: "employment", outcome: "validated", report_reference_id: `TRUV-FAKE-${j.R}-${b}`, supplier_code: "TRUV", employer_name: "Acme Manufacturing (FAKE payroll)", close_by_date: "2027-01-15", message_date: at.slice(0, 10), note_date: "2026-11-06" }, VERIFICATION);
}
/** 25.1's CD-checkpoint compliance run as the owner runs it at the checkpoint (the 25.1 spec's canonical snapshot on this application: fees with their payees, the FFIEC table, licensing, LO comp, steering, pricing, RESPA §8 evidence, the E-SIGN consent, the NMLSR blocks). The gate's fresh run is what the pass's `assertGateOpen` reuses when it records the run on the CD (freshness 4 h). */
/** 25.1's own run at a checkpoint gate over the fixture's full snapshot (the run the pass's 25.2 `assertGateOpen` reuses while fresh — GATES[gate].freshness_hours); the CD checkpoint by default, the consummation checkpoint for 26.2's pre-session check. */
async function complianceAt(j: Journey, at: string, gate = "SM_O61_COMPLIANCE_PASS_CD_GATE", disclosureClass = "cd"): Promise<void> {
  const scope = { app: j.appId }; clock.set(at); const d = at.slice(0, 10);
  const apr = await j.tool(scope, "25.1", "computeApr", { loan_amount_cents: "56000000", note_rate_pct: "6.125", term_months: 360, term_start_date: "2026-11-12", first_payment_date: "2027-01-01", prepaid_finance_charges_cents: "384995", prepaid_interest_cents: "178543", checkpoint: "cd" }, COMPLIANCE);
  const fee = (id: string, service_code: string, amount_cents: string, paid_to: string, paid_to_kind: string, extra: P = {}) => ({ fee_item_id: id, service_code, amount_cents, paid_to, paid_to_kind, ...extra });
  const items = [fee("F-INT", "interest_prepaid", "178543", "Partner Bank, N.A.", "creditor"), fee("F-UW", "underwriting", "195000", "Partner Bank, N.A.", "creditor", { creditor_retains_portion: true }), fee("F-TAX", "tax_service", "8400", "TaxServ Inc", "third_party", { creditor_requires_service: true }), fee("F-APPR", "appraisal", "65000", "Phoenix AMC", "third_party", { paid_by: "sm" }), fee("F-CR", "credit_report", "7500", "CreditCo", "third_party"), fee("F-TPOL", "title_lender_policy", "120000", "Desert Title Agency LLC", "third_party"), fee("F-SETT", "settlement_fee", "60000", "Desert Title Agency LLC", "third_party"), fee("F-REC", "recording", "3000", "Maricopa County Recorder", "public_official"), fee("F-ESC", "escrow_deposit", "206250", "Partner Bank, N.A.", "creditor")];
  const evidence = ["TaxServ Inc", "Phoenix AMC", "CreditCo", "Desert Title Agency LLC"].map((p, k) => ({ paid_to: p, service_performed_at: "2026-10-20T17:00:00.000Z", report_id: `RPT-${j.R}-${k + 1}` }));
  const snapshot = { application_id: j.appId, loan_id: null, as_of: d, property_state: "AZ", property_county: "Maricopa", lien_position: "first", occupancy: "primary", loan_amount_cents: 56_000_000n, note_rate_pct: "6.125", term_months: 360, rate_set_date: "2026-10-07",
    apr: { actual: apr.output, disclosed_apr: apr.output["apr_disclosed_str"], disclosed_finance_charge_cents: apr.output["finance_charge_cents"], transaction: { irregular_first_period: true } },
    fees: { items: items.map((f) => ({ ...f, amount_cents: BigInt(f.amount_cents) })), benchmarks: [] }, apor_tables: [{ table_date: "2026-10-05", term_years: 30, product: "fixed", apor_pct: "6.020" }], treasury_yield_pct: "4.10", prepayment_penalty: null, escrow_established: true,
    jurisdiction: { high_cost_statute: null, branch_licensed_state: false, third_party_processor_license_required: false, ai_disclosure_required: false },
    tolerance: { result: "pass", tolerance_test_id: `TT-${j.R}`, message: "21.5: no tolerance violation" },
    licenses: { checks: [{ check_id: `LC-CO-${j.R}`, party_type: "company", party_ref: "partner", nmls_id: "123456", state: "AZ", license_type: "AZ Mortgage Banker (A.R.S. Title 6, ch. 9)", status: "approved", sponsorship_ok: null, checked_at: "2026-10-30", valid_through: "2027-12-31", source: "nmls_b2b", evidence_document_id: "DOC-LC-CO" }, { check_id: `LC-MLO-${j.R}`, party_type: "individual", party_ref: "mlo-rivera", nmls_id: "987654", state: "AZ", license_type: "AZ Loan Originator", status: "approved", sponsorship_ok: true, checked_at: "2026-10-30", valid_through: "2027-12-31", source: "nmls_b2b", evidence_document_id: "DOC-LC-MLO" }], mlo_fitness_attested: true },
    lo_comp_plan: { components: [{ kind: "salary" }, { kind: "flat_per_loan" }], passthrough_by_published_formula: true },
    steering: { record: { presented_at: "2026-10-07T15:00:00.000Z", transaction_type: "limited_cash_out_30y_fixed", options: [{ kind: "lowest_rate", rate_pct: "6.125", points_fees_cents: 206_452n }, { kind: "lowest_rate_no_risky_features", rate_pct: "6.125", points_fees_cents: 206_452n }, { kind: "lowest_points_fees", rate_pct: "6.375", points_fees_cents: 0n }], consumer_choice: "lowest_rate", reason_if_not_lowest_rate: null }, lock_requested_at: MST("2026-10-07", "10:05") },
    pricing: { locked_price: "100.875", rate_sheet_price: "100.875", review: null },
    respa8: { affiliates: [], referral_at: "2026-10-05T17:30:00.000Z", afba_disclosures: [], service_evidence: evidence, msa_providers: [] },
    esign: { consent: { kind: "esign", granted_at: MST("2026-10-05", "10:20"), withdrawn_at: null, scope: ["disclosures", "notices", "closing_package", "le", "cd", "corrected_cd", "consummation", "closing"], hw_sw_statement_version: "2026.1", access_demonstrated: true }, delivery_channel: "electronic", delivery_at: at, disclosure_class: disclosureClass },
    nmlsr_templates: ["1003", "le", "cd", "note", "security_instrument"].map((form) => ({ form, creditor_name: "Partner Bank, N.A.", creditor_nmlsr_id: "123456", mlo_name: "Jordan Rivera", mlo_nmlsr_id: "987654" })),
    arbitration_clause_present: false, credit_insurance_financed: false, ai_disclosure_present: false };
  const r = await j.tool(scope, "25.1", "assertGateOpen", { gate, snapshot }, COMPLIANCE);
  assert.equal(r.output["open"], true, JSON.stringify(r.output).slice(0, 600));
}
const complianceAtCd = (j: Journey, at: string) => complianceAt(j, at);
/** A second journey driven through the chain the way T1–T8 drive the main line (the same passes at the same instants), stopping at `target` — the fixture for the branches that need their own row (T7's money mismatch, T13's stall, T15's unwind). */
/** The partner's haircut reserve as the ledger carries it (27.1 SM_WH_HAIRCUT_RESERVE_GATE reads the balance of `partner_haircut_reserve`): the LSA fixture's $250,000.00 deposit, posted once per journey by an officer through 2.1 ledger.post on the corporate books — Cr partner_haircut_reserve / Dr sm_funding_cash (27.1's draw at the wire is the mirror image). In-process, so the cents stay bigint. */
async function fundHaircutReserve(j: Journey): Promise<void> {
  const memo = `partner haircut reserve deposit ${j.R}`;
  if ((await db.query(`SELECT 1 FROM ledger_lines WHERE account = 'partner_haircut_reserve' AND memo = $1`, [memo])).length) return;
  await runtime.execute({ process: "2.1", name: "ledger.post", loanId: "", actor: OFFICER, input: { entry_set: { effectiveDate: "2026-11-02", description: "LSA haircut reserve: partner deposit (fixture)", lines: [
    { account: { scope: "corporate", account: "partner_haircut_reserve" }, amountCents: -25_000_000n, ruleRef: "27.1 LSA haircut reserve", memo },
    { account: { scope: "corporate", account: "sm_funding_cash" }, amountCents: 25_000_000n, ruleRef: "27.1 LSA haircut reserve", memo }] } } });
  assert.equal(await n(`FROM ledger_lines WHERE account = 'partner_haircut_reserve' AND memo = $1`, [memo]), 1, "the reserve deposit is a ledger_lines row");
}
async function driveTo(j: Journey, target: "execution_reviewed" | "wire_released"): Promise<Journey> {
  const appId = j.appId; const scope = { app: appId };
  await seedCreditAuthorizations(j);
  clock.set(MST("2026-10-05", "17:50")); await pass(clock.now(), appId);
  await verifyIdentitiesAndValue(j);
  clock.set("2026-10-07T18:00:00.000Z"); await pass(clock.now(), appId);
  await titleAndInsurance(j);
  clock.set("2026-10-28T16:00:00.000Z"); await clearConditionsThrough233(j, { stale: 0 }); await pass(clock.now(), appId);
  clock.set("2026-10-28T16:00:25.000Z"); await reviewers.tick(runtime, clock.now()); await pass(clock.now(), appId);
  assert.equal((await row(appId)).step, "clear_to_close", `driveTo: ${JSON.stringify((await journal(appId)).slice(-5).map((x) => [x.step, x.kind, x.command_name, x.error_class, x.detail["message"] ?? x.detail["reason"] ?? x.detail["gap"] ?? null]))}`);
  await seedEsignConsents(j); await closingPrereqs(j); await j.scheduleClosing(); await complianceAtCd(j, MST("2026-11-02", "08:30"));
  clock.set(MST("2026-11-02", "09:00")); await pass(clock.now(), appId);
  const cd = (await entitiesOf("disclosures", appId)).find((d) => d.data["kind"] === "cd")!; assert.ok(cd, "driveTo: the CD rendered");
  clock.set(MST("2026-11-02", "09:30"));
  for (const c of ["B1", "B2"]) await j.tool(scope, "25.2", "recordReceipt", { disclosure_id: cd.id, consumer_id: c, evidence: "esign_confirmed", at: MST("2026-11-02", "09:30"), evidence_document_id: `DOC-ESIGN-${c}-${j.R}` }, { kind: "agent", id: "disclosure" });
  clock.set(MST("2026-11-02", "09:31")); await pass(clock.now(), appId);
  clock.set(MST("2026-11-03", "09:00")); await pass(clock.now(), appId);
  await valuationCopy(j);
  clock.set(MST("2026-11-04", "09:00")); await pass(clock.now(), appId);
  assert.equal((await row(appId)).step, "documents_released", `driveTo: ${JSON.stringify((await journal(appId)).slice(-5).map((x) => [x.step, x.kind, x.command_name, x.error_class, x.detail["message"] ?? x.detail["reason"] ?? x.detail["gap"] ?? null]))}`);
  await vvoe(j, MST("2026-11-04", "10:00")); await closingPackageNotices(j); await complianceAt(j, MST("2026-11-06", "13:00"), "SM_O61_COMPLIANCE_PASS_CONSUMMATE_GATE", "consummation");
  clock.set(MST("2026-11-06", "13:30")); await pass(clock.now(), appId);
  clock.set(MST("2026-11-06", "14:45")); await pass(clock.now(), appId);
  clock.set(MST("2026-11-06", "14:46")); await pass(clock.now(), appId);
  assert.equal((await row(appId)).step, "execution_reviewed", `driveTo: ${JSON.stringify((await journal(appId)).slice(-6).map((x) => [x.step, x.kind, x.command_name, x.error_class, x.detail["message"] ?? x.detail["reason"] ?? x.detail["gap"] ?? null]))} rejected: ${JSON.stringify((await events(appId, "enote.registration.rejected")).map((e) => e.payload))} enotes: ${JSON.stringify((await entitiesOf("enotes", appId)).map((e) => [e.id, e.data["min"], e.data["status"]]))} snapshots: ${JSON.stringify((await entitiesOf("closing_data_snapshots", appId)).map((e) => [e.id, e.data["min"], (e.data["payload"] as P | undefined)?.["min"]]))}`);
  if (target === "execution_reviewed") return j;
  await rescissionSweep(j); await complianceAt(j, EST("2026-11-12", "07:30"), "SM_O61_COMPLIANCE_PASS_DISBURSE_GATE", "cd"); await fundHaircutReserve(j);
  clock.set(EST("2026-11-12", "08:05")); await pass(clock.now(), appId);
  clock.set(EST("2026-11-12", "08:20")); await pass(clock.now(), appId);
  assert.equal((await row(appId)).waiting_on, "funding_approver", `driveTo: ${JSON.stringify(await row(appId))}`);
  clock.set(EST("2026-11-12", "09:40")); await reviewers.tick(runtime, clock.now());
  clock.set(EST("2026-11-12", "13:00")); await pass(clock.now(), appId);
  assert.equal((await row(appId)).step, "wire_released", `driveTo: ${JSON.stringify((await journal(appId)).slice(-6).map((x) => [x.step, x.kind, x.command_name, x.error_class, x.detail["message"] ?? x.detail["reason"] ?? x.detail["gap"] ?? null]))}`);
  return j;
}
/** 24.2's appraisal on the record: v1 received Mon Nov 2, reviewed and accepted Tue Nov 3, the copy e-delivered Tue Nov 3 10:00 MST → provided Nov 3, earliest consummation Fri Nov 6 (REGB_1002_14_APPRAISAL_COPY_3BD_GATE open for the slot). The 32-6 fixture's report package, checklist and SSR. */
const APPRAISER = "PARTY-APPRAISER-1";
const APPRAISAL_PACKAGE = { uad_version: "3.6", has_xml: true, has_pdf: true, has_images: true, lender_client_party_id: "PARTY-PARTNER", partner_party_id: "PARTY-PARTNER", appraiser_party_id: APPRAISER, ordered_appraiser_party_id: APPRAISER, appraiser_license_active: true, ordered_form: "1004", form: "1004" };
const APPRAISAL_CHECKLIST = { closed_comparables: 3, adjustments_explained: true, market_conditions_consistent: true, gla_sqft: 2140, application_gla_sqft: 2140, units: 1, application_units: 1, condition_rating: "C3", quality_rating: "Q3", subject_to: false, narrative: "The subject is a well-maintained single-family residence in an established subdivision; sales activity is stable." };
const SSR = (at: string) => ({ gse: "fnma", status: "successful", doc_file_id: "1200000123456", findings: [], cu_score: 1.9, cu_flags: NO_CU_FLAGS, result_at: at, api_correlation_id: "ucdp-fixture" });
const COPY_RECIPIENT = (partyId: string, name: string, email: string) => ({ partyId, name, mailingAddress: "100 N Central Ave, Phoenix AZ 85004", email, consent: { party_id: partyId, classes: ["origination_decisions", "disclosures.origination", "flood_notice"], disclosure_version: "esign-2026-09", status: "active", consented_on: "2026-10-05", soft_bounces_30d: 0 } });
async function valuationCopy(j: Journey): Promise<void> {
  const scope = { app: j.appId }; const APPRAISAL = `APR-${j.R}`;
  clock.set(MST("2026-11-02", "14:20"));
  await j.tool(scope, "24.2", "ingestReport", { appraisal_id: APPRAISAL, version_no: 1, package: APPRAISAL_PACKAGE, appraised_value_cents: "80000000", effective_date: "2026-11-01", appraiser_party_id: APPRAISER, received_at: MST("2026-11-02", "14:20"), valuation_order_id: j.valuationOrderId }, VALUATION);
  clock.set(MST("2026-11-03", "09:00"));
  await j.tool(scope, "24.2", "applyReviewChecklist", { appraisal_id: APPRAISAL, version_no: 1, checklist: APPRAISAL_CHECKLIST, transaction_type: "refinance", loan_amount_cents: "56000000", consummation_on: "2026-11-06", fnma_ssr: SSR(MST("2026-11-02", "15:07")) }, VALUATION);
  clock.set(MST("2026-11-03", "10:00"));
  const payload = { partner_name: "Partner Bank, N.A.", borrower_names: ["Alex Borrower", "Blake Borrower"], property_address: "100 N Central Ave, Phoenix AZ 85004", loan_number_last4: "0917", mlo_name: "Jordan Rivera", mlo_nmlsr_id: "987654", contact_phone: "1-800-555-0142", notice_date: "2026-11-03", completion_at: "2026-11-03", earliest_consummation: "2026-11-06", consummation_scheduled_on: "2026-11-06", revision: false, includes_rov_disclosure: true, valuation_count: 1, valuations: [{ kind_label: "Uniform Residential Appraisal Report (Form 1004, UAD 3.6)", developed_at: "2026-11-01", version_no: 1 }] };
  const copy = await j.tool(scope, "24.2", "deliverNotice", { template_code: "NTC_REGB_1002_14_VALUATION_COPY", payload, recipients: [COPY_RECIPIENT("B1", "Alex Borrower", j.o.borrowerEmail), COPY_RECIPIENT("B2", "Blake Borrower", j.o.coBorrowerEmail)], appraisal_id: APPRAISAL, version: 1, is_final_version: true, channel: "electronic", esign_consent_verified: true, receipt_evidence: "esign_confirmed", consummation_on: "2026-11-06", valuation_ids: [`VAL-${APPRAISAL}-v1`] }, VALUATION);
  assert.equal(copy.output["gate_open_for_scheduled"], true, JSON.stringify(copy.output).slice(0, 300)); await settle();
}
/** 25.4's closing-package run for the slot (Wed Nov 4 11:00 MST, after 26.1's release): the GLBA privacy gate over 21.3's delivery evidence, then the package composed and gated against the CD and 30.3's approved analysis — `notice.closing_package.composed{status: gated}`, the two gates 26.2's pre-session check reads. */
async function closingPackageNotices(j: Journey): Promise<void> {
  const scope = { app: j.appId }; clock.set(MST("2026-11-04", "11:00")); const consummationAt = MST("2026-11-06", "14:00");
  const borrowers = ["B1", "B2"].map((b) => ({ borrower_id: b, privacy_delivered_at: MST("2026-10-05", "10:30"), customer: true }));
  const pg = await j.tool(scope, "25.4", "checkPrivacyNotice", { borrowers, consummation_at: consummationAt }, DISCLOSURE); assert.equal(pg.output["result"], "open", JSON.stringify(pg.output).slice(0, 300));
  const cd = (await entitiesOf("disclosures", j.appId)).find((d) => d.data["kind"] === "cd")!;
  // 25.2 moves a version to consummation_ready only through a waiver (ops-25-2 CdService.acceptWaiver); on the ordinary path the version is ready once its waiting period has run: 25.2's own `disclosure.cd.waiting_period.computed{earliest_consummation_date}` on or before the slot (plan §7: a 25.2 ask)
  const wp = (await events(j.appId, "disclosure.cd.waiting_period.computed")).filter((e) => e.payload["disclosure_id"] === cd.id && e.payload["earliest_consummation_date"]).at(-1); const cdReady = !!wp && String(wp.payload["earliest_consummation_date"]) <= "2026-11-06";
  const analysis = (await entitiesOf("escrow_analyses", j.appId)).find((a) => a.data["status"] === "approved" || a.data["status"] === "frozen")!; const fig = { ...(analysis.data["cd_figures"] as P), ...(cd.data["figures"] as P) };   // the CD carries 30.3's (g)(3)/(l)(7) figures; the year-one escrowed costs sit on the analysis's cd_figures
  const run = await j.tool(scope, "25.4", "composeClosingPackage", { run_id: `RUN-${j.R}`, agent_run_id: `AR-${j.R}`, consummation_at: consummationAt, property_state: "AZ", transaction_type: "refinance", principal_dwelling_refinance: true, cd: { disclosure_id: cd.id, cd_version: Number(cd.data["cd_version"] ?? 1), status: cdReady ? "consummation_ready" : String(cd.data["status"]), escrow: { initial_escrow_payment_cents: String(fig["initial_escrow_payment_cents"] ?? analysis.data["target_at_start_cents"]), monthly_escrow_cents: String(fig["monthly_escrow_cents"] ?? analysis.data["base_payment_cents"]), escrowed_costs_year1_cents: String(fig["escrowed_costs_year1_cents"] ?? analysis.data["escrowed_costs_year1_cents"] ?? "0") } }, escrow_analysis: { analysis: analysis.data, approved_on: String(analysis.data["approved_on"] ?? "2026-10-30").slice(0, 10), rendered_document_id: `DOC-ESCROW-STMT-${j.R}` }, borrowers, hpa: null, flood_ack_required: false }, DISCLOSURE);
  assert.equal(run.output["status"], "gated", JSON.stringify(run.output).slice(0, 600)); await settle();
}
/** 25.3's inbound sweep at the end of the rescission period (the flow's own tool call; nothing inbound → `rescission.confirmed_not_rescinded`). */
async function rescissionSweep(j: Journey): Promise<void> { clock.set(MST("2026-11-11", "08:00")); await j.tool({ app: j.appId }, "25.3", "sweepInboundForRescission", { swept_at: MST("2026-11-11", "08:00"), channels_checked: ["mail", "email", "portal", "fax", "voicemail"], items: [] }, DISCLOSURE); await settle(); }
const SOURCE_FILES = (): string[] => { const dir = fileURLToPath(new URL("./", import.meta.url)); return [...readdirSync(dir).filter((f) => /-35-6(-[a-z])?\.ts$/.test(f) && !f.endsWith(".test.ts")).map((f) => dir + f), fileURLToPath(new URL("../../app/tools/section35-6.ts", import.meta.url))]; };

test("35.6-T1: Given an application on the hosted runtime whose log carries `application.trid_received`, an LE received under 21.2, the credit fee handled and a `consents` row of kind `blanket_verification_authorization` for both borrowers, when `orchestration.pass` runs, then 22.2 `orderCreditReport` and `parseCreditReport` ran as `verification` with `permissible_purpose`, `certification_ref`, `borrower_authorization_ref` and `subscriber_code` read from the consent row and the partner's `credit_authorizations` row (never from the request), a `credit_reports` row and `credit.representative_score.computed` are keyed by the application alone, `closing_orchestrations` has one row at step `credit_ordered`, and a second pass with no new event writes no row, no event and no decision.", { skip }, async () => {
  const j = await chainJourney(); const appId = j.appId;
  const auth = (await db.query<{ authorization_id: string; evidence: P }>(`SELECT authorization_id::text AS authorization_id, evidence FROM credit_authorizations WHERE application_id = $1`, [appId]))[0]!;
  const consents = await db.query<{ id: string }>(`SELECT id::text AS id FROM consents WHERE application_id = $1 AND kind::text = 'blanket_verification_authorization' ORDER BY captured_at`, [appId]);
  assert.equal(consents.length, 2, "a consents row of kind blanket_verification_authorization for both borrowers");
  assert.equal(await n(`FROM loan_events WHERE application_id = $1 AND type = 'application.trid_received'`, [appId]), 1);
  assert.equal(await n(`FROM loan_events WHERE application_id = $1 AND type = 'disclosure.le.received'`, [appId]), 1, "an LE received under 21.2");
  assert.equal(await n(`FROM loan_events WHERE application_id = $1 AND type = 'fee.gate.checked' AND payload->>'fee_kind' = 'credit_report'`, [appId]), 1, "the credit fee handled");
  clock.set(MST("2026-10-05", "17:50"));
  const r = await pass(clock.now());
  assert.equal(r.discovered, 1, JSON.stringify(r).slice(0, 400)); assert.equal(r.rows.length, 1);
  // 22.2 orderCreditReport and parseCreditReport ran as `verification` with the four refs read from the consent row and the partner's credit_authorizations row (never from the request)
  const jl = await journal(appId);
  const order = jl.find((x) => x.kind === "command_run" && x.command_process === "22.2" && x.command_name === "orderCreditReport")!;
  assert.ok(order, JSON.stringify(jl)); assert.equal(order.actor_kind, "agent"); assert.equal(order.actor_id, "verification");
  const src = order.detail["sources"] as Record<string, { kind: string; ref: string; process: string }>;
  assert.equal(src["certification_ref"]!.kind, "table"); assert.equal(src["certification_ref"]!.ref, `credit_authorizations:${auth.authorization_id}`); assert.equal(src["subscriber_code"]!.ref, `credit_authorizations:${auth.authorization_id}`); assert.equal(src["permissible_purpose"]!.ref, `credit_authorizations:${auth.authorization_id}`);
  assert.equal(src["borrower_authorization_ref"]!.kind, "table"); assert.equal(src["borrower_authorization_ref"]!.ref, `consents:${consents.map((c) => c.id).join(",")}`);
  assert.deepEqual(order.detail["consents"], consents.map((c) => c.id));
  const ordered = (await events(appId, "credit.report.ordered"))[0]!;
  assert.equal(ordered.payload["certification_ref"], auth.evidence["certification_ref"]); assert.equal(ordered.payload["subscriber_code"], auth.evidence["subscriber_code"]); assert.equal(ordered.payload["permissible_purpose"], "credit_transaction_604a3A"); assert.equal(ordered.actor_id, "verification");
  const parsed = jl.find((x) => x.kind === "command_run" && x.command_name === "parseCreditReport")!; assert.ok(parsed); assert.equal(parsed.actor_id, "verification");
  assert.ok(parsed.decision_id, "the owner's decision record is bound to the journal row"); assert.ok(order.decision_id);
  // a credit_reports row and credit.representative_score.computed keyed by the application alone
  const reports = (await entitiesOf("credit_reports", appId)).filter((r) => !String(r.data["report_type"]).startsWith("soft"));   // 20.3's soft prequal pull is the lead's; the tri-merge is the order
  assert.equal(reports.length, 1); assert.equal(reports[0]!.data["state"], "usable"); assert.equal(reports[0]!.data["report_type"], "tri_merge_infile");
  const score = await events(appId, "credit.representative_score.computed"); assert.ok(score.length >= 1); for (const e of score) { assert.equal(e.application_id, appId); assert.equal(e.loan_id, null); } assert.equal(score.at(-1)!.payload["state"], "usable"); assert.equal(score.at(-1)!.payload["report_id"], reports[0]!.id);
  assert.equal(await n(`FROM entity_records WHERE kind = 'credit_reports' AND id = $1 AND (application_id IS DISTINCT FROM $2 OR loan_id IS NOT NULL)`, [reports[0]!.id, appId]), 0, "every version of the report row is keyed by the application alone");
  // closing_orchestrations has one row at step credit_ordered
  assert.equal(await n(`FROM closing_orchestrations WHERE application_id = $1`, [appId]), 1);
  const o = await row(appId); assert.equal(o.step, "credit_ordered"); assert.equal(o.status, "waiting_borrower");
  assert.ok(jl.some((x) => x.kind === "entered" && x.step === "credit_ordered"));
  // a second pass with no new event writes no row, no event and no decision
  await settle();   // 32.3's StatusCard reaction to credit.report.ordered lands off the pass's transaction; a pass absorbs it (the read cursor moves), then the footprint is the record at rest
  clock.set(MST("2026-10-05", "17:51")); await pass(clock.now()); await settle();
  const before = await footprint(appId);
  clock.set(MST("2026-10-05", "17:52"));
  const r2 = await pass(clock.now());
  assert.equal(r2.wrote, 0, JSON.stringify(r2).slice(0, 300));
  const after = await footprint(appId);
  assert.deepEqual(after, before, "the second pass wrote no row, no event and no decision");
});

test("35.6-T2: Given a usable representative score, when the pass runs, then in one sweep 23.1 `associateCredit`, `buildDuRequest` (23.6's `du.document.emitted`), 23.7 `runDuPreflight` (`du.preflight.passed`), 23.1 `submitCasefile` (`du.submitted`, `du.casefile_id.recorded`), `fetchFindings` (`du.findings.received{recommendation=approve_eligible}`), 23.2 `parseFindings{op: interpret}` and 23.3 `assessRisk` + `issueConditionalApproval` (`decision.issued`) ran as `underwriter`, the row is at `conditions_open` with the conditions 23.2 opened, and a contract test finds no `append(` of `du.submitted`, `clear_to_close.issued`, `closing.consummated`, `funding.authorized`, `loan.funded` or `loan.purchased` anywhere under `src/domain/operations-runtime/`.", { skip }, async () => {
  const j = await chainJourney(); const appId = j.appId;
  assert.equal((await events(appId, "credit.representative_score.computed")).at(-1)!.payload["state"], "usable", "Given a usable representative score");
  await verifyIdentitiesAndValue(j);
  clock.set("2026-10-07T18:00:00.000Z");   // 11:00 MST Wed Oct 7 — one sweep
  const r = await pass(clock.now());
  assert.equal(r.rows.length, 1); assert.equal(r.rows[0]!.wrote, true, JSON.stringify(r).slice(0, 400));
  const jl = await journal(appId);
  const ran = jl.filter((x) => x.kind === "command_run" && x.created_at >= jl.find((y) => y.kind === "completed" && y.step === "credit_ordered")!.created_at).map((x) => `${x.command_process} ${x.command_name}${x.command_op ? `{${x.command_op}}` : ""}`);
  assert.deepEqual(ran, ["23.1 associateCredit", "23.1 buildDuRequest", "23.1 submitCasefile", "23.1 fetchFindings", "23.2 parseFindings{interpret}", "23.3 assessRisk", "23.3 issueConditionalApproval"], JSON.stringify(jl.map((x) => [x.step, x.kind, x.command_name, x.error_class, x.refusal_code, x.detail["message"] ?? x.detail["reason"] ?? null])));
  for (const x of jl.filter((y) => y.kind === "command_run" && y.command_process?.startsWith("23."))) assert.equal(x.actor_id, "underwriter", `${x.command_name} ran as underwriter`);
  // 23.6's du.document.emitted, 23.7's du.preflight.passed, du.submitted + du.casefile_id.recorded, the findings, the interpretation, the decision — all keyed by the application, in one sweep
  const types = (await events(appId)).map((e) => e.type);
  for (const t of ["du.credit.associated", "du.document.emitted", "du.preflight.passed", "du.submitted", "du.casefile_id.recorded", "du.findings.received", "du.findings.interpreted", "decision.issued"]) assert.ok(types.includes(t), `${t} on the log (have ${types.filter((x) => x.startsWith("du.") || x.startsWith("decision.")).join(",")})`);
  assert.equal((await events(appId, "du.findings.received"))[0]!.payload["recommendation"], "approve_eligible");
  assert.equal(await n(`FROM loan_events WHERE application_id = $1 AND type IN ('du.submitted', 'du.findings.received', 'decision.issued') AND loan_id IS NOT NULL`, [appId]), 0);
  // the row is at conditions_open with the conditions 23.2 opened
  const o = await row(appId); assert.equal(o.step, "conditions_open");
  const conds = await entitiesOf("conditions", appId); assert.ok(conds.length >= 6, `23.2 opened ${conds.length} conditions`);
  assert.equal(await n(`FROM loan_events WHERE application_id = $1 AND type = 'condition.opened'`, [appId]), conds.length);
  assert.ok(jl.some((x) => x.kind === "entered" && x.step === "du_submitted") && jl.some((x) => x.kind === "completed" && x.step === "du_submitted") && jl.some((x) => x.kind === "entered" && x.step === "conditions_open"));
  // the contract: no `append(` of an owning literal anywhere under src/domain/operations-runtime/ (recursively) — the owners emit
  const owning = ["du.submitted", "clear_to_close.issued", "closing.consummated", "funding.authorized", "loan.funded", "loan.purchased"];
  const dir = fileURLToPath(new URL("./", import.meta.url));
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}${e.name}/`) : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [`${d}${e.name}`] : []));
  const files = walk(dir); assert.ok(files.length > 10, `${files.length} source files under src/domain/operations-runtime/`);
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/append\(([^;]{0,400})/g)) for (const lit of owning) assert.ok(!m[1]!.includes(`"${lit}"`), `${f}: append( of the owning literal ${lit}`);
    for (const lit of owning) assert.ok(!new RegExp(`type:\\s*"${lit.replace(/\./g, "\\.")}"`).test(text), `${f}: an event of the owning type ${lit} is constructed here`);
  }
});

test("35.6-T3: Given every condition cleared (the reviewer-only ones by an `underwriting_reviewer` — the FAKE reviewer after 20 s under `INTEGRATIONS=fake`), when the pass runs, then 23.3 `runCtcChecklist{op: ctc}` ran with `facts` built by `facts-35-6.ts` from the record (each item's source event id in the decision record), `issueClearToClose` appended `clear_to_close.issued{passed=true}` keyed by the application, `orchestration.opened` and `orchestration.step.entered{step: clear_to_close, clocked: false, waiting_on: borrower}` follow it, and no `SM_ORCH_STEP_STALLED_2BD` instance exists (the wait is the borrower's).", { skip }, async () => {
  const j = await chainJourney(); const appId = j.appId;
  assert.equal((await row(appId)).step, "conditions_open");
  // 24.4 / 24.5: the title order, the commitment, the CPL, the hazard policy and the flood determination — the platform's items CTC_TITLE and CTC_INSURANCE_FLOOD read
  await titleAndInsurance(j);
  // the borrower-supplied conditions cleared through 23.3 (as 32.6's cards do); one stale document leaves an item satisfied_pending_review — the reviewer-only one
  clock.set("2026-10-28T16:00:00.000Z");
  const c = await clearConditionsThrough233(j, { stale: 1 });
  assert.ok(c.cleared.length >= 5 && c.pending.length >= 1, JSON.stringify(c));
  for (const id of c.pending) assert.equal((await entity("conditions", id))!["status"], "satisfied_pending_review", `${id} is the reviewer's`);
  const r1 = await pass(clock.now());
  assert.equal(r1.rows[0]!.status, "waiting_human"); assert.equal(r1.rows[0]!.waiting_on, "underwriting_reviewer");
  assert.equal((await entity("conditions", c.pending[0]!))!["status"], "satisfied_pending_review");
  // the FAKE reviewer after 20 s under INTEGRATIONS=fake (reviewers.ts, the sweep's step before the pass): at +25 s it clears the reviewer-only items through 23.3 clearCondition as {kind: human, id: FAKE:underwriting_reviewer}; the pass never performs the reviewer's act — it folds `condition.cleared`
  clock.set("2026-10-28T16:00:25.000Z");
  const tick = await reviewers.tick(runtime, clock.now());
  assert.ok(tick.actions.some((a) => a.kind === "condition_review" && a.outcome === "approved"), JSON.stringify(tick.actions));
  for (const id of c.pending) assert.equal((await entity("conditions", id))!["status"], "cleared", `${id} cleared by the reviewer`);
  const clearedEvents = (await events(appId, "condition.cleared")).filter((e) => c.pending.includes(String(e.payload["condition_id"])));
  assert.equal(clearedEvents.length, c.pending.length); for (const e of clearedEvents) { assert.equal(e.actor_kind, "human"); assert.equal(e.actor_id, "FAKE:underwriting_reviewer"); assert.equal(e.actor_role, "underwriting_reviewer"); }
  const r2 = await pass(clock.now());
  assert.equal(r2.rows[0]!.wrote, true, JSON.stringify(r2).slice(0, 400));
  const jl = await journal(appId);
  assert.equal(jl.filter((x) => x.kind === "command_run" && x.command_name === "clearCondition").length, 0, "the pass ran no clearCondition (HUMAN_ACTS_STAY_HUMAN)");
  // 23.3 runCtcChecklist{op: ctc} ran with facts built by facts-35-6.ts from the record (each item's source event id in the decision record)
  const ctc = jl.find((x) => x.kind === "command_run" && x.command_name === "runCtcChecklist")!;
  assert.ok(ctc); assert.equal(ctc.command_op, "ctc"); assert.equal(ctc.actor_id, "underwriter");
  const sources = ctc.detail["sources"] as Record<string, { kind: string; ref: string; process: string }>;
  const codes = ["CTC_DU_FINAL_MATCH", "CTC_PTD_ALL_CLEARED", "CTC_NO_OPEN_INVESTIGATION", "CTC_CREDIT_VALID", "CTC_DU_CLOSE_BY", "CTC_ASSETS_CASH_TO_CLOSE", "CTC_VALUATION", "CTC_PROPERTY_PROJECT", "CTC_TITLE", "CTC_INSURANCE_FLOOD", "CTC_MI", "CTC_COMPLIANCE", "CTC_EDUCATION", "CTC_LOCK", "CTC_IDENTITY_OFAC", "CTC_QC_PREFUNDING", "CTC_MLO_APPROVALS", "CTC_REGB_TIMING", "CTC_DECISION_VALID"];
  for (const code of codes) assert.ok(sources[code], `${code} has a source`);
  const eventIds = new Set((await events(appId)).map((e) => e.id));
  for (const code of ["CTC_DU_FINAL_MATCH", "CTC_CREDIT_VALID", "CTC_LOCK", "CTC_IDENTITY_OFAC", "CTC_DECISION_VALID", "CTC_VALUATION"]) { assert.equal(sources[code]!.kind, "event", `${code}: ${JSON.stringify(sources[code])}`); assert.ok(eventIds.has(sources[code]!.ref.split(":").at(-1)!), `${code}'s source ${sources[code]!.ref} is an event id on the log`); }
  const dec = (await decisions(appId)).filter((d) => d.agent === "disclosures").at(-1)!;
  assert.ok(dec.rationale.includes("23.3 runCtcChecklist{ctc}") && dec.rationale.includes("23.3 issueClearToClose"), dec.rationale);
  for (const code of ["CTC_DU_FINAL_MATCH", "CTC_CREDIT_VALID", "CTC_LOCK", "CTC_IDENTITY_OFAC", "CTC_DECISION_VALID", "CTC_VALUATION"]) assert.ok(dec.rationale.includes(sources[code]!.ref), `${code}'s source event id ${sources[code]!.ref} is in the decision record`);
  // issueClearToClose appended clear_to_close.issued{passed=true} keyed by the application
  const issued = await events(appId, "clear_to_close.issued"); assert.equal(issued.length, 1, JSON.stringify((await journal(appId)).filter((x) => x.step === "conditions_open").map((x) => [x.kind, x.command_name, x.error_class, x.detail, x.waiting_on])).slice(0, 6000)); assert.equal(issued[0]!.payload["passed"], true); assert.equal(issued[0]!.application_id, appId); assert.equal(issued[0]!.loan_id, null); assert.equal(issued[0]!.actor_id, "underwriter");
  // orchestration.opened and orchestration.step.entered{step: clear_to_close, clocked: false, waiting_on: borrower} follow it
  const log = await events(appId);
  const iIssued = log.findIndex((e) => e.type === "clear_to_close.issued"); const opened = log.findIndex((e) => e.type === "orchestration.opened"); const entered = log.findIndex((e) => e.type === "orchestration.step.entered" && e.payload["step"] === "clear_to_close");
  assert.ok(opened > iIssued && entered > opened, `${iIssued} < ${opened} < ${entered}`);
  assert.equal(log[entered]!.payload["clocked"], false); assert.equal(log[entered]!.payload["waiting_on"], "borrower");
  const o = await row(appId); assert.equal(o.step, "clear_to_close"); assert.equal(o.status, "waiting_borrower"); assert.equal(o.waiting_on, "borrower");
  // no SM_ORCH_STEP_STALLED_2BD instance exists (the wait is the borrower's)
  assert.equal((await timers(appId, "SM_ORCH_STEP_STALLED_2BD")).length, 0);
});

test("35.6-T4: Given `closing.scheduled` for Fri Nov 6, 2026 14:00 MST from the borrower's slot (26.2 through 32.7), when the pass runs Mon Nov 2 09:00 MST, then 25.2's figure sources were recorded from 24.4's title order and 30.3's frozen analysis, `reconcileFigureSources` reconciled, 25.1 `computeApr` ran, CD v1 is a 35.2 `documents` row with a sha256, it was delivered to both consumers under their E-SIGN consents with receipts recorded from their acknowledgements the same day, `disclosure.cd.waiting_period.computed{earliest_consummation_date=2026-11-05}` exists, `REGZ_1026_19F1_CD_3SBD_GATE` is armed on the application, `SM_O62_CD_TARGET_4SBD` is satisfied, the row is `waiting_window{REGZ_1026_19F1_CD_3SBD_GATE}`; given a second borrower without E-SIGN consent, then that consumer's delivery is `mail` with a mailing proof and the earliest date is the deemed receipt's.", { skip }, async () => {
  const j = await chainJourney(); const appId = j.appId;
  assert.equal((await row(appId)).step, "clear_to_close");
  // the platform's own items (30.3, 22.4, 24.4), the borrowers' E-SIGN consents, and the borrower's slot: Fri Nov 6 14:00 MST through 26.2 (as 32.7's closing.selectSlot delegates)
  await seedEsignConsents(j); await closingPrereqs(j); await j.scheduleClosing();
  await complianceAtCd(j, MST("2026-11-02", "08:30"));   // 25.1's own CD-checkpoint run (the gate the delivery cites; fresh for 4 h)
  const scheduled = (await events(appId, "closing.scheduled")).at(-1)!; assert.equal(scheduled.payload["scheduled_at"], MST("2026-11-06", "14:00"));
  // when the pass runs Mon Nov 2 09:00 MST
  clock.set(MST("2026-11-02", "09:00"));
  const r1 = await pass(clock.now(), appId);
  assert.equal(r1.rows[0]!.wrote, true, JSON.stringify(r1).slice(0, 500));
  const jl = await journal(appId);
  const ran = jl.filter((x) => x.kind === "command_run" && x.step === "closing_scheduled").map((x) => `${x.command_process} ${x.command_name}${x.command_op ? `{${x.command_op}}` : ""}`);
  assert.ok(ran.includes("25.2 assembleCdFigures{record_source}") && ran.includes("25.2 reconcileFigureSources") && ran.includes("25.1 computeApr") && ran.includes("25.2 renderCd") && ran.includes("25.2 deliverDisclosure"), JSON.stringify(jl.filter((x) => x.step === "closing_scheduled").map((x) => [x.kind, x.command_name, x.error_class, x.refusal_code, x.detail["message"] ?? x.detail["reason"] ?? null])).slice(0, 3000));
  // 25.2's figure sources were recorded from 24.4's title order and 30.3's frozen analysis
  const srcRuns = jl.filter((x) => x.kind === "command_run" && x.command_name === "assembleCdFigures");
  const sa = srcRuns.find((x) => (x.detail["sources"] as P)["title_order"])!; assert.ok(sa, "the settlement agent's source cites the title order");
  const titleOrder = (await entitiesOf("title_orders", appId))[0]!; assert.equal(((sa.detail["sources"] as P)["title_order"] as P)["ref"], `title_orders:${titleOrder.id}:${(await db.query<{ v: number }>(`SELECT version AS v FROM entity_current WHERE kind = 'title_orders' AND id = $1`, [titleOrder.id]))[0]!.v}`);
  const es = srcRuns.find((x) => (x.detail["sources"] as P)["escrow_analysis"])!; assert.ok(es, "the escrow source cites 30.3's analysis");
  const analysis = (await entitiesOf("escrow_analyses", appId)).find((a) => a.data["status"] === "approved" || a.data["status"] === "frozen")!; assert.ok(analysis); assert.ok(String(((es.detail["sources"] as P)["escrow_analysis"] as P)["ref"]).startsWith(`escrow_analyses:${analysis.id}:`));
  assert.equal(analysis.data["target_at_start_cents"] === undefined ? null : String(analysis.data["target_at_start_cents"]), String(WORKED_A.escrow_deposit_cents));
  const sources = (await entitiesOf("cd_figure_sources", appId)); assert.ok(sources.some((s) => s.data["party"] === "settlement_agent" && s.data["reconciled"] === true) && sources.some((s) => s.data["party"] === "escrow" && s.data["reconciled"] === true), JSON.stringify(sources.map((s) => [s.data["party"], s.data["reconciled"]])));
  // CD v1 is a 35.2 documents row with a sha256
  const cd = (await entitiesOf("disclosures", appId)).find((d) => d.data["kind"] === "cd")!; assert.ok(cd); assert.equal(cd.data["cd_version"], 1);
  const doc = (await db.query<{ sha256: string; kind: string }>(`SELECT sha256, kind FROM documents WHERE application_id = $1 AND kind = 'closing_disclosure'`, [appId]))[0]!; assert.ok(doc, "a documents row for the CD"); assert.match(doc.sha256, /^[0-9a-f]{64}$/);
  // delivered to both consumers under their E-SIGN consents
  const delivered = await events(appId, "disclosure.cd.delivered"); assert.equal(delivered.length, 2);
  for (const d of delivered) { assert.equal(d.payload["channel"], "esign_portal"); assert.ok(d.payload["esign_consent_id"]); assert.equal(await n(`FROM consents WHERE id::text = $1 AND kind::text = 'esign'`, [String(d.payload["esign_consent_id"])]), 1, "the consent id is the consumer's consents row"); assert.equal(d.actor_id, "disclosure"); }
  assert.equal((await row(appId)).step, "closing_scheduled");
  // the receipts recorded from their acknowledgements the same day (32.7's disclosure.acknowledgeReceipt → 25.2 recordReceipt); the next pass computes the waiting period
  clock.set(MST("2026-11-02", "09:30"));
  for (const c of ["B1", "B2"]) await j.tool({ app: appId }, "25.2", "recordReceipt", { disclosure_id: cd.id, consumer_id: c, evidence: "esign_confirmed", at: MST("2026-11-02", "09:30"), evidence_document_id: `DOC-ESIGN-${c}-${j.R}` }, { kind: "agent", id: "disclosure" });
  clock.set(MST("2026-11-02", "09:31"));
  const r2 = await pass(clock.now(), appId); assert.equal(r2.rows[0]!.wrote, true, JSON.stringify(r2).slice(0, 400));
  const wp = (await events(appId, "disclosure.cd.waiting_period.computed")).at(-1)!; assert.ok(wp, "disclosure.cd.waiting_period.computed exists"); assert.equal(wp.payload["earliest_consummation_date"], "2026-11-05");
  // REGZ_1026_19F1_CD_3SBD_GATE is armed on the application; SM_O62_CD_TARGET_4SBD is satisfied
  const gate = await timers(appId, "REGZ_1026_19F1_CD_3SBD_GATE"); assert.ok(gate.some((t) => t.status === "armed" && t.application_id === appId), JSON.stringify(gate));
  const target = await timers(appId, "SM_O62_CD_TARGET_4SBD"); assert.ok(target.length >= 1 && target.every((t) => t.status === "satisfied"), JSON.stringify(target));
  // the row is waiting_window{REGZ_1026_19F1_CD_3SBD_GATE}
  const o = await row(appId); assert.equal(o.step, "cd_delivered"); assert.equal(o.status, "waiting_window"); assert.equal(o.waiting_on, "REGZ_1026_19F1_CD_3SBD_GATE");
  // given a second borrower without E-SIGN consent: that consumer's delivery is mail with a mailing proof and the earliest date is the deemed receipt's
  const m = await newJourney(); chain.m = m; await seedCreditAuthorizations(m); await verifyIdentitiesAndValue(m); await titleAndInsurance(m);
  clock.set("2026-10-07T18:00:00.000Z"); await pass(clock.now(), m.appId);
  clock.set("2026-10-28T16:00:00.000Z"); await clearConditionsThrough233(m, { stale: 0 }); await pass(clock.now(), m.appId);
  clock.set("2026-10-28T16:00:25.000Z"); await reviewers.tick(runtime, clock.now()); await pass(clock.now(), m.appId);
  assert.equal((await row(m.appId)).step, "clear_to_close", JSON.stringify((await journal(m.appId)).slice(-6).map((x) => [x.step, x.kind, x.command_name, x.error_class, x.detail["message"] ?? x.detail["reason"] ?? x.detail["gap"] ?? null])));
  await seedEsignConsents(m, ["B2"]); await closingPrereqs(m); await m.scheduleClosing(); await complianceAtCd(m, MST("2026-11-02", "08:30"));
  clock.set(MST("2026-11-02", "09:00")); const rm = await pass(clock.now(), m.appId); assert.equal(rm.rows[0]!.wrote, true, JSON.stringify(rm).slice(0, 400));
  const md = await events(m.appId, "disclosure.cd.delivered"); assert.equal(md.length, 2);
  const b2 = md.find((d) => d.payload["consumer_id"] === "B2")!; assert.equal(b2.payload["channel"], "mail"); assert.ok(String(b2.payload["mailing_proof_id"]).length > 0, "a mailing proof"); assert.equal(b2.payload["presumed_receipt_date"], "2026-11-05");
  assert.equal(md.find((d) => d.payload["consumer_id"] === "B1")!.payload["channel"], "esign_portal");
  const mcd = (await entitiesOf("disclosures", m.appId)).find((d) => d.data["kind"] === "cd")!;
  clock.set(MST("2026-11-02", "09:30")); await m.tool({ app: m.appId }, "25.2", "recordReceipt", { disclosure_id: mcd.id, consumer_id: "B1", evidence: "esign_confirmed", at: MST("2026-11-02", "09:30"), evidence_document_id: `DOC-ESIGN-B1-${m.R}` }, { kind: "agent", id: "disclosure" });
  clock.set(MST("2026-11-03", "09:00")); await pass(clock.now(), m.appId); assert.equal((await events(m.appId, "disclosure.cd.waiting_period.computed")).filter((e) => e.payload["earliest_consummation_date"]).length, 0, "no earliest date before the deemed receipt");
  clock.set(MST("2026-11-05", "09:00")); const rd = await pass(clock.now(), m.appId); assert.equal(rd.rows[0]!.wrote, true, JSON.stringify(rd).slice(0, 400));
  const mwp = (await events(m.appId, "disclosure.cd.waiting_period.computed")).filter((e) => e.payload["earliest_consummation_date"]).at(-1)!; assert.ok(mwp); assert.equal(mwp.payload["latest_effective_receipt_date"], "2026-11-05"); assert.equal(mwp.payload["earliest_consummation_date"], "2026-11-09");
  assert.ok((await journal(m.appId)).some((x) => x.kind === "command_run" && x.command_name === "computeEarliestConsummation" && x.command_op === "deem"), "25.2 deemed the mailed CD received");
});

test("35.6-T5: Given the waiting period computed, when the pass runs Wed Nov 4, then it ordered 22.2 `orderRefresh{soft_refresh}` (Tue Nov 3), asserted 25.2's gate for Nov 6, read 22.4's `funds_to_close.reconciled` and 23.3's CTC gate, and ran 26.1 `computeNoteTerms`, `evaluateDocGenGates`, `takeClosingSnapshot`, `renderDocument`, `buildSmartDocENote`, `runDocumentQc` and `releaseToSettlementAgent` as `title-closing`: the eNote's `data_hash` equals the canonical note-terms hash for $3,402.62, Jan 1, 2027 → Dec 1, 2056, and `closing.documents.released` is on the log; given the credit refresh gate closed instead (an unresolved `verified_new_debt`), then the row is `held{gate_closed, SM_CREDIT_REFRESH_PRECLOSE_GATE}`, no 26.1 command ran and no document was rendered.", { skip }, async () => {
  const j = await chainJourney(); const appId = j.appId;
  const o0 = await row(appId); assert.equal(o0.step, "cd_delivered"); assert.equal(o0.status, "waiting_window");
  // Tue Nov 3 (3 creditor business days before Fri Nov 6): the refresh window opens and the pass orders 22.2's soft refresh with the four refs read from the record; the order ends the row's pass
  clock.set(MST("2026-11-03", "09:00"));
  const r3 = await pass(clock.now(), appId); assert.equal(r3.rows[0]!.wrote, true, JSON.stringify(r3).slice(0, 500));
  const jl3 = await journal(appId);
  const refresh = jl3.filter((x) => x.kind === "command_run" && x.command_process === "22.2" && x.command_name === "orderRefresh" && !x.command_op);
  assert.equal(refresh.length, 1, JSON.stringify(jl3.filter((x) => x.step === "cd_delivered").map((x) => [x.kind, x.command_name, x.command_op, x.error_class, x.refusal_code, x.detail["message"] ?? x.detail["reason"] ?? x.detail["gap"] ?? null])).slice(0, 3000));
  assert.equal(refresh[0]!.actor_id, "verification"); assert.equal((refresh[0]!.detail["sources"] as Record<string, { kind: string }>)["certification_ref"]!.kind, "table");
  const received = (await events(appId, "credit.refresh.received")).at(-1)!; assert.ok(received); assert.equal(received.payload["report_type"], "soft_refresh"); assert.equal(received.payload["report_date"], "2026-11-03"); assert.equal(received.payload["scheduled_consummation_date"], "2026-11-06");
  assert.equal(jl3.filter((x) => x.kind === "command_run" && x.step === "cd_delivered" && x.command_process === "26.1").length, 0, "no 26.1 command before the gate is asserted over the received refresh");
  const o3 = await row(appId); assert.equal(o3.step, "cd_delivered"); assert.equal(o3.waiting_on, "SM_CREDIT_REFRESH_PRECLOSE_GATE");
  await valuationCopy(j);   // 24.2's appraisal copy (the platform's own item; REGB_1002_14_APPRAISAL_COPY_3BD_GATE for the slot)
  // when the pass runs Wed Nov 4
  clock.set(MST("2026-11-04", "09:00"));
  const r4 = await pass(clock.now(), appId); assert.equal(r4.rows[0]!.wrote, true, JSON.stringify(r4).slice(0, 500));
  const jl = await journal(appId); const since = jl.filter((x) => x.created_at > jl3.at(-1)!.created_at);
  const ran = since.filter((x) => x.kind === "command_run").map((x) => `${x.command_process} ${x.command_name}${x.command_op ? `{${x.command_op}}` : ""}`);
  const fail = JSON.stringify(since.map((x) => [x.step, x.kind, x.command_name, x.command_op, x.error_class, x.refusal_code, x.detail["message"] ?? x.detail["reason"] ?? x.detail["gap"] ?? null])).slice(0, 4000);
  // it asserted 22.2's gate over the Nov 3 refresh and 25.2's gate for Nov 6
  assert.ok(ran.includes("22.2 orderRefresh{assert_gate}"), fail); assert.ok(ran.includes("25.2 assertGateOpen"), fail);
  const cdGate = since.find((x) => x.kind === "command_run" && x.command_name === "assertGateOpen")!; assert.equal(cdGate.detail["gate"], "REGZ_1026_19F1_CD_3SBD_GATE"); assert.equal(cdGate.detail["requested_on"], "2026-11-06");
  // it read 22.4's funds_to_close.reconciled and 23.3's CTC gate: the doc-gen gate's sources name both events
  const reconciled = (await events(appId, "funds_to_close.reconciled")).at(-1)!; assert.ok(reconciled, "22.4 reconciled the worksheet to the CD: " + JSON.stringify((await events(appId)).filter((e) => e.type.startsWith("funds_to_close")).map((e) => [e.type, e.payload])) + " journal " + JSON.stringify(jl.filter((x) => x.command_name === "reconcileToCd" || x.kind === "waiting").map((x) => [x.step, x.kind, x.command_name, x.error_class, x.detail])).slice(0, 3000)); assert.equal(reconciled.payload["reconciled"] ?? true, true);
  const ctcIssued = (await events(appId, "clear_to_close.issued"))[0]!;
  const gates = since.find((x) => x.kind === "command_run" && x.command_name === "evaluateDocGenGates")!; assert.ok(gates, fail);
  const gs = gates.detail["sources"] as Record<string, { kind: string; ref: string; process: string }>;
  assert.equal(gs["cash_to_close"]!.ref, `funds_to_close.reconciled:${reconciled.id}`); assert.equal(gs["cash_to_close"]!.process, "22.4"); assert.equal(gs["approval_ptd_cleared"]!.ref, `clear_to_close.issued:${ctcIssued.id}`); assert.equal(gs["approval_ptd_cleared"]!.process, "23.3");
  // 26.1's seven commands as title-closing, in order
  const c261 = since.filter((x) => x.kind === "command_run" && x.command_process === "26.1").map((x) => x.command_name);
  assert.deepEqual(c261, ["computeNoteTerms", "evaluateDocGenGates", "takeClosingSnapshot", "renderDocument", "buildSmartDocENote", "runDocumentQc", "releaseToSettlementAgent"], fail);
  for (const x of since.filter((y) => y.kind === "command_run" && y.command_process === "26.1")) assert.equal(x.actor_id, "title-closing", `${x.command_name} ran as title-closing`);
  // the eNote's data_hash equals the canonical note-terms hash for $3,402.62, Jan 1, 2027 → Dec 1, 2056
  const terms = computeNoteTerms({ principal_cents: 56_000_000n, note_rate_pct: "6.125", term_months: 360, scheduled_disbursement_date: D("2026-11-12"), state: "AZ" });
  assert.equal(terms.pi_cents, 340_262n); assert.equal(terms.first_payment_date, "2027-01-01"); assert.equal(terms.maturity_date, "2056-12-01");
  const enotes = (await entitiesOf("closing_documents", appId)).filter((d) => d.data["kind"] === "enote"); assert.equal(enotes.length, 1, JSON.stringify((await entitiesOf("closing_documents", appId)).map((d) => d.data["kind"])));
  assert.equal(enotes[0]!.data["data_hash"], terms.data_hash); assert.ok(enotes[0]!.data["smart_doc"], "26.1 built the SMART Doc");
  // closing.documents.released is on the log; the row moved on
  const released = await events(appId, "closing.documents.released"); assert.equal(released.length, 1); assert.equal(released[0]!.application_id, appId); assert.equal(released[0]!.loan_id, null); assert.equal(released[0]!.actor_id, "title-closing");
  assert.equal(await n(`FROM loan_events WHERE application_id = $1 AND type = 'closing.document_qc.passed'`, [appId]), 1);
  const o = await row(appId); assert.equal(o.step, "documents_released");
  // given the credit refresh gate closed instead (an unresolved verified_new_debt): the second journey's refresh raised a new tradeline the borrower confirmed
  const m = chain.m!; const mo = await row(m.appId); assert.equal(mo.step, "cd_delivered", JSON.stringify(mo));
  clock.set(MST("2026-11-05", "10:00")); const rm1 = await pass(clock.now(), m.appId); assert.equal(rm1.rows[0]!.wrote, true, JSON.stringify(rm1).slice(0, 400));
  assert.equal((await events(m.appId, "credit.refresh.received")).length, 1, "the refresh was ordered inside the window");
  const alert = await m.tool({ app: m.appId }, "22.2", "triageUdmAlert", { op: "receive", borrower_id: "B1", alert_type: "new_tradeline", vendor_alert_id: `UDV-${m.R}`, payload: { creditor_name: "Conn's Home Plus", account_ref: `CHP-${m.R}`, opened: "2026-10-29" }, received_at: MST("2026-11-05", "10:05") }, VERIFICATION);
  const alertId = (alert.output["alert"] as P)["alert_id"] as string;
  await m.tool({ app: m.appId }, "22.2", "triageUdmAlert", { alert_id: alertId, status: "verified_new_debt", rationale: "borrower confirmed the furniture installment; statement uploaded", explanation: "Furniture financing opened Oct 29", evidence_document_id: `doc-chp-${m.R}`, creditor_name: "Conn's Home Plus", liability_kind: "installment", monthly_payment_cents: "41000", balance_cents: "1480000", qualifying_income_cents: "1350000", obligations_cents: "513000", triaged_at: MST("2026-11-05", "10:15") }, VERIFICATION);
  clock.set(MST("2026-11-05", "10:30")); const rm2 = await pass(clock.now(), m.appId); assert.equal(rm2.rows[0]!.wrote, true, JSON.stringify(rm2).slice(0, 400));
  const mrow = await row(m.appId); assert.equal(mrow.status, "held", JSON.stringify(mrow)); assert.equal(mrow.hold_reason, "gate_closed"); assert.equal(mrow.waiting_on, "SM_CREDIT_REFRESH_PRECLOSE_GATE"); assert.equal(mrow.step, "cd_delivered");
  const mjl = await journal(m.appId);
  const refused = mjl.find((x) => x.kind === "command_refused" && x.command_name === "orderRefresh" && x.command_op === "assert_gate")!; assert.ok(refused, JSON.stringify(mjl.slice(-8).map((x) => [x.kind, x.command_name, x.command_op, x.refusal_code])));
  assert.equal(refused.refusal_code, "SM_CREDIT_REFRESH_PRECLOSE_GATE"); assert.ok(String(refused.detail["reason"]).includes("verified_new_debt"), String(refused.detail["reason"]));
  assert.equal(mjl.filter((x) => x.kind === "command_run" && x.step === "cd_delivered" && x.command_process === "26.1").length, 0, "no 26.1 command ran");
  assert.equal((await entitiesOf("closing_document_sets", m.appId)).length, 0); assert.equal((await entitiesOf("closing_documents", m.appId)).length, 0, "no document was rendered");
  assert.equal(await n(`FROM loan_events WHERE application_id = $1 AND type IN ('closing.documents.generated', 'closing.documents.released')`, [m.appId]), 0);
});

test("35.6-T6: Given the released set and the FAKE RON platform's session (identity proofing for both signers, start, the eNote created, the 1003 and the eNote signed 14:18 and 14:25/14:26 MST, the deed of trust acknowledged 14:36, the seal 14:41), when the pass polls the port, then 26.2's pre-session checks, `verifyEsignConsent`, `openSigningSession`, every `monitorSession` op, `validateAuthoritativeCopy{op: seal}`, `validateAuthoritativeCopy` and `registerENote` ran from the vendor's events (no operator JSON anywhere in the journal), `closing.consummated{note_date=2026-11-06}` is at 14:26 MST, `enote.registered` satisfies `MERS_PROC_ENOTE_REGISTER_1BD`, 26.3 `computeDates{op: open}` recorded `rescission_expires_at=2026-11-11T07:00:00.000Z`, `earliest_funding_date=2026-11-12`, `funding_type=dry`, 25.3's `rescission.period.started` exists, and after `ingestAuditTrail` and `reviewExecution` the row is at `execution_reviewed`, `waiting_window{REGZ_1026_23_RESCISSION_3SBD_GATE}`.", { skip }, async () => {
  const j = await chainJourney(); const appId = j.appId;
  assert.equal((await row(appId)).step, "documents_released");
  // the record's remaining pre-session facts: 22.3's VVOE inside the 10-business-day window, 25.1's own consummation-checkpoint run (the gate 26.2's check reads; the pass's 25.2 assertGateOpen reuses it while fresh)
  await vvoe(j, MST("2026-11-04", "10:00")); await closingPackageNotices(j); await complianceAt(j, MST("2026-11-06", "13:00"), "SM_O61_COMPLIANCE_PASS_CONSUMMATE_GATE", "consummation");
  clock.set(MST("2026-11-06", "13:30")); const r0 = await pass(clock.now(), appId); assert.equal(r0.rows[0]!.wrote, true, JSON.stringify(r0).slice(0, 400));
  const jl0 = await journal(appId);
  const fail0 = JSON.stringify(jl0.filter((x) => x.step === "documents_released").map((x) => [x.kind, x.command_name, x.command_op, x.error_class, x.refusal_code, x.detail["message"] ?? x.detail["reason"] ?? x.detail["gap"] ?? x.detail["blocking"] ?? null])).slice(0, 4000);
  assert.ok(await n(`FROM loan_events WHERE application_id = $1 AND type = 'closing.pre_session_checks.passed'`, [appId]) >= 1, fail0);
  assert.ok(await n(`FROM loan_events WHERE application_id = $1 AND type = 'closing.consent.verified'`, [appId]) >= 1, fail0);
  const o0 = await row(appId); assert.equal(o0.step, "documents_released"); assert.equal(o0.status, "waiting_window"); assert.equal(o0.waiting_on, "closing.scheduled");
  // when the pass polls the port after the seal (14:41): the FAKE platform's session events are replayed into 26.2, in the vendor's order
  clock.set(MST("2026-11-06", "14:45")); const r1 = await pass(clock.now(), appId); assert.equal(r1.rows[0]!.wrote, true, JSON.stringify(r1).slice(0, 400));
  clock.set(MST("2026-11-06", "14:46")); await pass(clock.now(), appId);
  const jl = await journal(appId);
  const fail = JSON.stringify(jl.filter((x) => x.step === "documents_released" || x.step === "consummated").map((x) => [x.step, x.kind, x.command_name, x.command_op, x.error_class, x.refusal_code, x.kind === "held" || x.kind === "waiting" ? x.detail : x.detail["message"] ?? x.detail["reason"] ?? x.detail["gap"] ?? null])).slice(0, 8000) + " review: " + JSON.stringify((await events(appId, "closing.execution_review.failed")).map((e) => e.payload)).slice(0, 3000);
  const ran = jl.filter((x) => x.kind === "command_run" && (x.step === "documents_released" || x.step === "consummated")).map((x) => `${x.command_process} ${x.command_name}${x.command_op ? `{${x.command_op}}` : ""}`);
  const expect262 = ["26.2 runPreSessionChecks{upstream}", "26.2 verifyEsignConsent", "26.2 runPreSessionChecks", "26.2 openSigningSession", "26.2 monitorSession{identity}", "26.2 monitorSession{identity}", "26.2 monitorSession{start}", "26.2 monitorSession{enote_created}", "26.2 monitorSession{sign}", "26.2 monitorSession{sign}", "26.2 monitorSession{sign}", "26.2 monitorSession{sign}", "26.2 monitorSession{sign}", "26.2 monitorSession{sign}", "26.2 monitorSession{notarial_act}", "26.2 validateAuthoritativeCopy{seal}", "26.2 validateAuthoritativeCopy", "26.2 registerENote"];
  assert.deepEqual(ran.filter((x) => x.startsWith("26.2 ") && !["26.2 setSecuredParty", "26.2 ingestAuditTrail", "26.2 reviewExecution"].includes(x)), expect262, fail);
  for (const x of jl.filter((y) => y.kind === "command_run" && y.command_process === "26.2")) assert.equal(x.actor_id, "title-closing", `${x.command_name} ran as title-closing`);
  // from the vendor's events (no operator JSON anywhere in the journal): every session command cites the platform feed, and no journal detail carries a hand-typed evidence block
  for (const x of jl.filter((y) => y.kind === "command_run" && (y.command_name === "monitorSession" || y.command_name === "validateAuthoritativeCopy"))) { const s = (x.detail["sources"] as Record<string, { kind: string; ref: string }>)["session_event"] ?? (x.detail["sources"] as Record<string, { kind: string; ref: string }>)["copy"]; assert.ok(s && s.kind === "platform" && (s.ref.startsWith("FAKE RON feed") || s.ref.startsWith("FAKE RON platform")), JSON.stringify(x.detail)); }
  for (const x of jl) { const text = JSON.stringify(x.detail); for (const key of ["\"operator\"", "\"captured_state\"", "\"kba_answers\"", "\"evidence\":{"]) assert.ok(!text.includes(key), `${x.kind} ${x.command_name}: ${key} in the journal`); }
  // closing.consummated{note_date=2026-11-06} at 14:26 MST (the last note signature), keyed by the application
  const consummated = await events(appId, "closing.consummated"); assert.equal(consummated.length, 1, fail);
  assert.equal(Date.parse(consummated[0]!.occurred_at), Date.parse(MST("2026-11-06", "14:26"))); assert.equal(consummated[0]!.payload["note_date"], "2026-11-06"); assert.equal(consummated[0]!.application_id, appId); assert.equal(consummated[0]!.loan_id, null); assert.equal(consummated[0]!.actor_id, "title-closing");
  // enote.registered satisfies MERS_PROC_ENOTE_REGISTER_1BD
  assert.equal((await events(appId, "enote.registered")).length, 1);
  const reg = await timers(appId, "MERS_PROC_ENOTE_REGISTER_1BD"); assert.ok(reg.length >= 1 && reg.every((t) => t.status === "satisfied"), JSON.stringify(reg));
  // 26.3 computeDates{op: open} as funder: rescission expiry, earliest funding, dry
  const cd = jl.find((x) => x.kind === "command_run" && x.command_process === "26.3" && x.command_name === "computeDates" && x.command_op === "open")!; assert.ok(cd, fail); assert.equal(cd.actor_id, "funder");
  const fr = (await events(appId, "funding.requested")).at(-1)!; assert.ok(fr);
  assert.equal(fr.payload["rescission_expires_at"], "2026-11-11T07:00:00.000Z"); assert.equal(fr.payload["earliest_funding_date"], "2026-11-12"); assert.equal(fr.payload["funding_type"], "dry"); assert.equal(fr.payload["disbursement_date"], "2026-11-12");
  // 25.3's period started; 26.2's audit trail ingested and the execution reviewed
  assert.equal((await events(appId, "rescission.period.started")).length, 1, fail);
  assert.ok(ran.includes("26.2 ingestAuditTrail") && ran.includes("26.2 reviewExecution"), fail);
  assert.equal((await events(appId, "closing.execution_review.passed")).length, 1, fail);
  const o = await row(appId); assert.equal(o.step, "execution_reviewed"); assert.equal(o.status, "waiting_window"); assert.equal(o.waiting_on, "REGZ_1026_23_RESCISSION_3SBD_GATE");
});

test("35.6-T7: Given 25.3's `rescission.confirmed_not_rescinded` at Wed Nov 11 08:00 MST and the settlement agent's statement requesting $556,852.07, when the pass runs Thu Nov 12 08:05 ET, then the worksheet was built from the consummated CD (gross $560,000.00; prepaid 19 × $93.97 = $1,785.43; escrow deposit $2,062.50; lender credit $700.00; net $556,852.07 = 55,685,207 cents), `reconcileToSettlementStatement` passed, `evaluateFundingConditions` ran with every fact from the record (the decision record lists the source event or row of `hazard_effective`, `cpl`, `commitment`, `wire_verification`, `ptf_cleared`, `cash_to_close`, `rescission`, `qc_hold`, `ofac`), `funding.authorized` and, from 27.1 `approveAdvance` as `warehouse`, `warehouse.advance.approved` with advance $548,800.00 and partner contribution $8,052.07 are on the log; given instead a settlement statement whose escrow deposit is $1,665.00 against the CD's $2,062.50, then the row is `held{money_mismatch}` naming both figures and their sources, no `funding.authorized` exists and one `officer` escalation is open.", { skip }, async () => {
  const j = await chainJourney(); const appId = j.appId;
  assert.equal((await row(appId)).step, "execution_reviewed");
  // 25.3's rescission.confirmed_not_rescinded at Wed Nov 11 08:00 MST (25.3's own sweep tool, as 32.7's flow runs it)
  await rescissionSweep(j);
  assert.equal((await events(appId, "rescission.confirmed_not_rescinded")).length, 1);
  await complianceAt(j, EST("2026-11-12", "07:30"), "SM_O61_COMPLIANCE_PASS_DISBURSE_GATE", "cd");   // 25.1's own disbursement-checkpoint run (the gate the pass's 25.2 assertGateOpen reuses while fresh)
  // when the pass runs Thu Nov 12 08:05 ET
  clock.set(EST("2026-11-12", "08:05")); const r = await pass(clock.now(), appId); assert.equal(r.rows[0]!.wrote, true, JSON.stringify(r).slice(0, 400));
  const jl = await journal(appId);
  const fail = JSON.stringify(jl.filter((x) => x.step === "execution_reviewed").map((x) => [x.kind, x.command_name, x.command_op, x.error_class, x.refusal_code, x.kind === "held" || x.kind === "waiting" ? x.detail : x.detail["message"] ?? x.detail["reason"] ?? x.detail["gap"] ?? null])).slice(0, 6000) + " conditions: " + JSON.stringify((await events(appId, "funding.conditions.evaluated")).map((e) => e.payload)).slice(0, 4000);
  const ran = jl.filter((x) => x.kind === "command_run" && x.step === "execution_reviewed").map((x) => `${x.command_process} ${x.command_name}${x.command_op ? `{${x.command_op}}` : ""}`);
  assert.deepEqual(ran, ["26.3 buildFundingWorksheet", "26.3 reconcileToSettlementStatement", "26.3 evaluateFundingConditions", "26.3 requestWarehouseAdvance", "27.1 evaluateEligibility", "27.1 computeBorrowingBase", "27.1 approveAdvance", "26.3 requestWarehouseAdvance{advance_approved}"], fail);
  for (const x of jl.filter((y) => y.kind === "command_run" && y.step === "execution_reviewed")) assert.equal(x.actor_id, x.command_process === "27.1" ? "warehouse" : "funder", `${x.command_name} ran as ${x.command_process === "27.1" ? "warehouse" : "funder"}`);
  // the worksheet from the consummated CD: gross $560,000.00; prepaid 19 × $93.97 = $1,785.43; escrow deposit $2,062.50; lender credit $700.00; net $556,852.07 = 55,685,207 cents
  const wsRef = String(((jl.find((x) => x.kind === "command_run" && x.command_name === "reconcileToSettlementStatement")!.detail["sources"] as P)["worksheet"] as P)["ref"]); assert.match(wsRef, /^funding_worksheets:/);
  const wsId = wsRef.slice("funding_worksheets:".length).replace(/:\d+$/, ""); const wsData = await entity("funding_worksheets", wsId); assert.ok(wsData, wsRef); const ws = { id: wsId, data: wsData! };
  const line = (code: string) => BigInt(String((ws.data["lines"] as P[]).find((l) => l["line_code"] === code)!["amount_cents"]));
  assert.equal(BigInt(String(ws.data["gross_loan_cents"])), WORKED_A.note_cents); assert.equal(line("PREPAID_INTEREST"), WORKED_A.prepaid_interest_cents); assert.equal(line("ESCROW_INITIAL_DEPOSIT"), WORKED_A.escrow_deposit_cents); assert.equal(BigInt(String(ws.data["lender_credits_cents"])), WORKED_A.lender_credit_cents); assert.equal(BigInt(String(ws.data["net_wire_cents"])), WORKED_A.net_wire_cents);
  assert.equal(WORKED_A.prepaid_interest_cents, BigInt(WORKED_A.prepaid_days) * WORKED_A.per_diem_cents); assert.equal(WORKED_A.net_wire_cents, WORKED_A.note_cents - WORKED_A.prepaid_interest_cents - WORKED_A.escrow_deposit_cents + WORKED_A.lender_credit_cents);
  assert.equal(ws.data["reconciled"], true, "reconcileToSettlementStatement passed"); assert.equal(BigInt(String(ws.data["agent_requested_net_cents"])), WORKED_A.net_wire_cents);
  const worksheetCmd = jl.find((x) => x.kind === "command_run" && x.command_name === "buildFundingWorksheet")!; const cdRowEnt = (await entitiesOf("disclosures", appId)).find((d) => d.data["kind"] === "cd")!;
  assert.ok(String(((worksheetCmd.detail["sources"] as P)["cd"] as P)["ref"]).startsWith(`disclosures:${cdRowEnt.id}:`), "the worksheet cites the consummated CD");
  // evaluateFundingConditions ran with every fact from the record: the decision record lists the source event or row of each
  const ev = jl.find((x) => x.kind === "command_run" && x.command_name === "evaluateFundingConditions")!; const srcs = ev.detail["sources"] as Record<string, { kind: string; ref: string; process: string }>;
  const dec = (await decisions(appId)).filter((d) => d.agent === "disclosures").at(-1)!;
  for (const k of ["hazard_effective", "cpl", "commitment", "wire_verification", "ptf_cleared", "cash_to_close", "rescission", "qc_hold", "ofac"]) { assert.ok(srcs[k], `${k} has a source (${Object.keys(srcs).join(",")})`); assert.ok(["event", "entity", "table"].includes(srcs[k]!.kind), `${k}: ${JSON.stringify(srcs[k])}`); assert.ok(dec.rationale.includes(srcs[k]!.ref), `${k}'s source ${srcs[k]!.ref} is in the decision record`); }
  // funding.authorized and, from 27.1 approveAdvance as warehouse, warehouse.advance.approved with advance $548,800.00 and partner contribution $8,052.07
  const auth = await events(appId, "funding.authorized"); assert.equal(auth.length, 1); assert.equal(auth[0]!.application_id, appId); assert.equal(auth[0]!.loan_id, null); assert.equal(auth[0]!.actor_id, "funder");
  const adv = await events(appId, "warehouse.advance.approved"); assert.equal(adv.length, 1); assert.equal(adv[0]!.actor_id, "warehouse");
  assert.equal(BigInt(String(adv[0]!.payload["advance_cents"])), WORKED_A.advance_cents); assert.equal(BigInt(String(adv[0]!.payload["partner_contribution_cents"])), WORKED_A.partner_contribution_cents);
  assert.equal(WORKED_A.advance_cents, WORKED_A.note_cents * 98n / 100n); assert.equal(WORKED_A.partner_contribution_cents, WORKED_A.net_wire_cents - WORKED_A.advance_cents);
  // given instead a settlement statement whose escrow deposit is $1,665.00 against the CD's $2,062.50: a second journey at execution_reviewed with the agent's scripted statement
  const u = await driveTo(await newJourney(), "execution_reviewed"); chain.u = u;
  fakesFor(runtime).settlementAgent.script(u.appId, { statement_id: `FAKE-SS-${u.R}-mismatch`, kind: "requested_net", requested_net_cents: WORKED_A.hand_fed_net_cents, escrow_deposit_cents: WORKED_A.hand_fed_escrow_deposit_cents, received_at: EST("2026-11-12", "07:50") });
  await rescissionSweep(u); await complianceAt(u, EST("2026-11-12", "07:30"), "SM_O61_COMPLIANCE_PASS_DISBURSE_GATE", "cd");
  clock.set(EST("2026-11-12", "08:05")); const ru = await pass(clock.now(), u.appId); assert.equal(ru.rows[0]!.wrote, true, JSON.stringify(ru).slice(0, 400));
  const uo = await row(u.appId); assert.equal(uo.status, "held", JSON.stringify(uo)); assert.equal(uo.hold_reason, "money_mismatch"); assert.equal(uo.step, "execution_reviewed");
  const held = (await journal(u.appId)).filter((x) => x.kind === "held").at(-1)!; assert.ok(held);
  assert.equal(held.detail["field"], "escrow_deposit_cents"); assert.equal(held.detail["statement_cents"], String(WORKED_A.hand_fed_escrow_deposit_cents)); assert.equal(held.detail["cd_cents"], String(WORKED_A.escrow_deposit_cents));
  assert.ok(String((held.detail["statement_source"] as P)["ref"]).startsWith("documents:"), "the statement's source is the 35.2 documents row"); assert.ok(String((held.detail["cd_source"] as P)["ref"]).startsWith("disclosures:"), "the CD's source is the disclosures row");
  assert.equal(await n(`FROM loan_events WHERE application_id = $1 AND type = 'funding.authorized'`, [u.appId]), 0);
  assert.equal(await n(`FROM escalations WHERE application_id = $1 AND owner_role = 'officer' AND completed_at IS NULL`, [u.appId]), 1, "one officer escalation is open");
});

test("35.6-T8: Given the advance approved, when the pass runs 08:20 ET, then 26.3 `prepareWire` as `funder` prepared a wire of 55,685,207 cents (`funding.wire.prepared`) and the row is `waiting_human{funding_approver}`; an agent actor's `prepareWire{op: release}` is refused `ROLE_DENIED` and the pass never calls it (contract: no `op: \"release\"` literal under `src/domain/operations-runtime/`); when the FAKE `funding_approver` releases at 09:40 ET, then `funding.wire.released`, the bank's `funding.wire.accepted{imad}`, 27.1's `warehouse.advance.funded{advance_date=2026-11-12}`, `notifySettlementAgent{op: agent_receipt}` and, on the uploaded final settlement statement, `confirmDisbursement` → `loan.funded{disbursement_date=2026-11-12, per_diem_cents=9397, prepaid_interest_cents=178543, prepaid_days=19}` keyed by the application only, and `SM_O73_DUAL_CONTROL_RELEASE_1H` and `SM_O73_WIRE_CUTOFF_1300ET` are satisfied.", { skip }, async () => {
  const j = await chainJourney(); const appId = j.appId; const scope = { app: appId };
  await fundHaircutReserve(j);   // the partner's LSA haircut reserve on the ledger (27.1's gate reads its balance)
  // when the pass runs 08:20 ET: 26.3 prepareWire as funder prepared the wire; the row waits on the funding_approver
  clock.set(EST("2026-11-12", "08:20")); const r1 = await pass(clock.now(), appId);
  const jl1 = await journal(appId); const fail1 = JSON.stringify(jl1.filter((x) => x.step === "funding_authorized").map((x) => [x.kind, x.command_name, x.command_op, x.error_class, x.refusal_code, x.detail["message"] ?? x.detail["reason"] ?? x.detail["gap"] ?? null])).slice(0, 3000);
  const prep = jl1.find((x) => x.kind === "command_run" && x.command_process === "26.3" && x.command_name === "prepareWire" && !x.command_op)!; assert.ok(prep, `${fail1} ${JSON.stringify(r1).slice(0, 300)}`); assert.equal(prep.actor_id, "funder");
  const prepared = (await events(appId, "funding.wire.prepared")).at(-1)!; assert.ok(prepared); assert.equal(BigInt(String(prepared.payload["amount_cents"])), WORKED_A.net_wire_cents); assert.equal(prepared.payload["value_date"], "2026-11-12");
  const o1 = await row(appId); assert.equal(o1.step, "funding_authorized"); assert.equal(o1.status, "waiting_human"); assert.equal(o1.waiting_on, "funding_approver");
  const wireId = String(prepared.payload["wire_id"]); const fundingId = String(prepared.payload["funding_id"]);
  // an agent actor's prepareWire{op: release} is refused (26.3's role guard: the funder prepares, only a funding_approver releases) and the pass never calls it
  const refused = await call("POST", `/v1/applications/${appId}/tools/26.3/prepareWire`, { actor: { kind: "agent", id: "funder" }, input: { funding_id: fundingId, op: "release", wire_id: wireId, bank_ref: `TEST-${j.R}`, released_at: clock.now() } });
  assert.notEqual(refused.status, 200, JSON.stringify(refused.body).slice(0, 400));
  const code = String(refused.body["code"] ?? (refused.body["error"] as P | undefined)?.["code"] ?? refused.body["refusal_code"] ?? JSON.stringify(refused.body)); assert.equal(code, "AGENT_NEVER_RELEASES");
  assert.equal(await n(`FROM loan_events WHERE application_id = $1 AND type = 'funding.wire.released'`, [appId]), 0);
  // contract: no `op: "release"` literal under src/domain/operations-runtime/ (recursively) — the release is the approver's act in reviewers.ts / the console
  const dir = fileURLToPath(new URL("./", import.meta.url));
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}${e.name}/`) : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [`${d}${e.name}`] : []));
  for (const f of walk(dir)) assert.ok(!/op:\s*"release"/.test(readFileSync(f, "utf8")), `${f}: an op: "release" literal`);
  // when the FAKE funding_approver releases at 09:40 ET (reviewers.ts, dual control)
  clock.set(EST("2026-11-12", "09:40")); const tick = await reviewers.tick(runtime, clock.now());
  assert.ok(tick.actions.some((a) => a.kind === "wire_release" && a.outcome === "approved"), JSON.stringify(tick.actions));
  const released = (await events(appId, "funding.wire.released")).at(-1)!; assert.ok(released); assert.equal(released.actor_kind, "human"); assert.equal(released.actor_role, "funding_approver");
  // the pass: the bank's acceptance, 27.1's package to the approver; the approver's second act books the advance; the agent's receipt and final statement → loan.funded
  clock.set(EST("2026-11-12", "09:42")); const r2 = await pass(clock.now(), appId); assert.equal(r2.rows[0]!.wrote, true, JSON.stringify(r2).slice(0, 400));
  const accepted = (await events(appId, "funding.wire.accepted")).at(-1)!; assert.ok(accepted, JSON.stringify((await journal(appId)).slice(-6).map((x) => [x.step, x.kind, x.command_name, x.command_op, x.error_class, x.detail["message"] ?? x.detail["reason"] ?? null]))); assert.match(String(accepted.payload["imad"]), /^20261112/);
  assert.equal((await row(appId)).step, "wire_released");
  clock.set(EST("2026-11-12", "10:05")); const tick2 = await reviewers.tick(runtime, clock.now());
  assert.ok(tick2.actions.some((a) => a.kind === "warehouse_wire_release" && a.outcome === "approved"), JSON.stringify(tick2.actions));
  const funded27 = (await events(appId, "warehouse.advance.funded")).at(-1)!; assert.ok(funded27); assert.equal(funded27.payload["advance_date"], "2026-11-12");
  clock.set(EST("2026-11-12", "10:10")); const r3 = await pass(clock.now(), appId); assert.equal(r3.rows[0]!.wrote, true, JSON.stringify(r3).slice(0, 400));
  const jl = await journal(appId); const fail = JSON.stringify(jl.filter((x) => x.step === "wire_released").map((x) => [x.kind, x.command_name, x.command_op, x.error_class, x.refusal_code, x.detail["message"] ?? x.detail["reason"] ?? x.detail["gap"] ?? null])).slice(0, 3000);
  assert.ok(jl.some((x) => x.kind === "command_run" && x.command_name === "notifySettlementAgent" && x.command_op === "agent_receipt"), fail);
  assert.ok(jl.some((x) => x.kind === "command_run" && x.command_name === "confirmDisbursement"), fail);
  const funded = await events(appId, "loan.funded"); assert.equal(funded.length, 1, fail);
  const p = funded[0]!.payload; assert.equal(p["disbursement_date"], "2026-11-12"); assert.equal(String(p["per_diem_cents"]), String(WORKED_A.per_diem_cents)); assert.equal(String(p["prepaid_interest_cents"]), String(WORKED_A.prepaid_interest_cents)); assert.equal(Number(p["prepaid_days"]), WORKED_A.prepaid_days);
  assert.equal(funded[0]!.application_id, appId); assert.equal(funded[0]!.loan_id, null, "loan.funded is keyed by the application only");
  for (const code of ["SM_O73_DUAL_CONTROL_RELEASE_1H", "SM_O73_WIRE_CUTOFF_1300ET"]) { const ts = await timers(appId, code); assert.ok(ts.length >= 1 && ts.every((t) => t.status === "satisfied"), `${code}: ${JSON.stringify(ts)}`); }
  assert.ok(["funded", "boarded", "package_frozen", "delivered", "certified", "purchased", "completed"].includes((await row(appId)).step), JSON.stringify(await row(appId)));
});

test("35.6-T9: Given `loan.funded`, when the same sweep's pass runs, then `funding_snapshots` has one row whose `sources` names a row or event for every top-level field of 30.2's `OriginationSnapshot` (`note` ← 26.1's eNote and `closing.consummated`; `final_cd` ← the consummated CD version; `escrow_analysis` ← 30.3's refreshed analysis; `consents` ← `consent.captured` rows; `documents` ← 35.2 rows; `min` ← `enote.registered`; `warehouse_advance_id` ← `warehouse.advance.funded`; `flood`, `hazard`, `mi`, `hpml`, `qm_type`, `ltv_pct`, `custody`, `trailing`, `property`, `borrowers`), `gaps = []`, `fixture_used = false`, `demoSnapshot` was not called (a spy on `src/runtime/origination.ts` exports), `orchestration.fund` produced ONE `loans` row with `origination_application_id`, `loan_terms` with `pi_cents = 340262`, `escrow_payment_cents = 68750`, `note_rate_bps = 61250`, a balanced opening set with principal 56,000,000, escrow 206,250 and prepaid interest 178,543 cents, OB-001…OB-022 passing, `loan.staged` … `loan.boarded` carrying both ids, `SM_ORIG_BOARD_T1BD` and `SM_ORCH_HANDOFF_AFTER_FUNDED_4H` satisfied, and `POST /v1/applications/{id}/fund` on the same application answers `duplicate: true`; given `ENVIRONMENT=production` and a record missing 30.3's analysis, then the hand-off is refused `FIXTURE_REFUSED`, the row lists `escrow_analysis` in `gaps`, no `loans` row exists and one `ops_analyst` and one `compliance` escalation are open.", { todo: true });

test("35.6-T10: Given `loan.boarded` on Thu Nov 12, when the pass runs Fri Nov 13 10:05 MST, then 29.3 built and froze the package (`delivery.uldd.built`, `earlycheck.completed{clean=true}`, `delivery.package.frozen`) as `secondary`, `SM_ORCH_DELIVERY_OPEN_2BD` is satisfied, 29.4 registered the delivery with Supermortgage's approved wire instruction and payee code, opened the operator task with `sla_due_at = 2026-11-16T15:00 MT`, eDelivered the eNote and requested the Transfer of Control the same day (`enote.transfer_of_control.requested{effective_date=2026-11-16}`, gate open), the row is `waiting_human{fnma_portal_operator}`; when the FAKE operator's evidence arrives 13:31 ET Mon Nov 16, then `delivery.submitted{fnma_loan_number}` exists, the custodian package is `evault_auto` with no documents, the eVault's auto-certification yields `custody.certified{purchase_ready_at=2026-11-16}` and `expected_purchase_date = 2026-11-17`.", { todo: true });

test("35.6-T11: Given the FAKE Sellers API's advice (price 101.125, UPB 56,000,000, principal proceeds $566,300.00, interest −$1,096.67, LLPA $700.00, net $564,503.33, purchase date 2026-11-19) and the collection bank's credit of 56,450,333 cents, when the pass runs, then 29.4 `ingestPurchaseAdvice` appended `loan.purchased` keyed by both ids with `variance_cents = 0`, 30.1 `matchPurchaseAdvice` was given the SAME `purchase_advices` row (its `net_proceeds_cents` = 56,450,333) and appended `loan.investor_updated` with `loans.fnma_loan_number` set and `loan_terms` v2 effective 2026-11-19, 27.2 `ingestReceipts` → `proceeds.received`, `matchProceeds` matched with variance $0.00, `postWaterfall` posted payoff $549,550.64 (principal $548,800.00 + interest $725.64 + fee $25.00), cost recovery $3,485.00, SM retained $1,415.00, partner residual $10,052.69 (`warehouse.advance.repaid`, `settlement.waterfall.posted`), `releaseCollateral` → `warehouse.secured_party.released{effective ≤ 2026-11-19}`, `purchase_reconciliations` is `reconciled` with the three sides, `orchestration.purchase.reconciled` satisfied `SM_ORCH_PURCHASE_RECON_1BD`, the row is `completed`, and `SELECT count(*) FROM loans WHERE origination_application_id = $1` is 1; given instead 30.1 fed a net of 56,590,333 cents, then `status = exception`, `sides.\"30.1\" = unmatched`, no waterfall was posted, no release exists and one sev-2 `officer` escalation carries 27.2's breakdown.", { todo: true });

test("35.6-T12: Given 50 open orchestrations with a new fact each and two sweeps' passes started in the same minute, then every row was claimed by exactly one pass (`FOR UPDATE SKIP LOCKED`), each row has exactly one new `entered`/`command_run` journal entry, no owning event was appended twice, and a third pass with no new facts writes nothing; given a step whose owning command throws, then the journal has `command_failed{error_class}`, no other row of that unit of work exists, the next pass retries, and after the third failure the row is `held{failed}` with one `ops_analyst` escalation.", { skip }, async () => {
  // fifty open orchestrations at clear_to_close (the borrower's wait), each on its own application, each with one new fact: 26.2's closing.scheduled
  const seed = await chainJourney();
  const apps: string[] = [];
  for (let i = 0; i < 50; i++) {
    const id = (await db.query<{ id: string }>(`INSERT INTO applications (partner_party_id, channel, transaction_type, occupancy, status, six_items) SELECT partner_party_id, channel, transaction_type, occupancy, status, six_items FROM applications WHERE id = $1 RETURNING id::text AS id`, [seed.appId]))[0]!.id;
    const oid = (await db.query<{ id: string }>(`INSERT INTO closing_orchestrations (application_id, transaction_type, step, status, waiting_on, opened_at, updated_at) VALUES ($1, 'limited_cash_out', 'clear_to_close', 'waiting_borrower', 'borrower', $2, $2) RETURNING id::text AS id`, [id, "2026-10-29T20:00:00.000Z"]))[0]!.id;
    await db.query(`INSERT INTO closing_orchestration_steps (orchestration_id, application_id, step, kind, clocked, waiting_on, actor_kind, actor_id, detail) VALUES ($1, $2, 'clear_to_close', 'entered', false, 'borrower', 'agent', 'disclosures', '{}'::jsonb)`, [oid, id]);
    apps.push(id);
  }
  clock.set(MST("2026-11-02", "10:00"));
  for (const id of apps) await runtime.uow.run({ applicationId: id }, async (ctx) => { ctx.events.append({ type: "closing.scheduled", applicationId: id, actor: { kind: "agent", id: "title-closing" }, payload: { closing_id: `CL-${id.slice(0, 8)}`, application_id: id, scheduled_at: MST("2026-11-06", "14:00"), time_zone: "America/Phoenix", closing_type: "ron", state: "AZ" } }); }, { clock });
  const inApps = (sql: string) => n(`${sql} AND application_id = ANY($1::uuid[])`, [apps]);
  const journalBefore = await inApps(`FROM closing_orchestration_steps WHERE true`); const eventsBefore = await inApps(`FROM loan_events WHERE true`);
  // two sweeps' passes started in the same minute, pages of ten: every row claimed by exactly one pass (FOR UPDATE SKIP LOCKED)
  clock.set(MST("2026-11-02", "10:01"));
  const [a, b] = await Promise.all([runOrchestrationPass(runtime, clock.now(), { holder: "sweep:A", limit: 10 }), runOrchestrationPass(runtime, clock.now(), { holder: "sweep:B", limit: 10 })]);
  // the claim is one lease per row per sweep instant (`last_pass_as_of`): a row the other pass leased is skipped, and a row the pass that finished first advanced is not claimed again by the other's later page
  const claimedBy = new Map<string, string[]>();
  for (const [holder, rep] of [["A", a], ["B", b]] as const) for (const r of rep.rows) if (apps.includes(r.application_id)) claimedBy.set(r.application_id, [...(claimedBy.get(r.application_id) ?? []), holder]);
  assert.equal(claimedBy.size, 50, `every row claimed (${claimedBy.size} of 50; A ${a.rows.length}, B ${b.rows.length})`);
  for (const [id, holders] of claimedBy) assert.equal(holders.length, 1, `${id} claimed by exactly one pass (${holders.join(",")})`);
  assert.ok(a.rows.some((r) => apps.includes(r.application_id)) && b.rows.some((r) => apps.includes(r.application_id)), `both passes claimed pages (A ${a.rows.length}, B ${b.rows.length})`);
  for (const r of [...a.rows, ...b.rows].filter((x) => apps.includes(x.application_id))) { assert.equal(r.wrote, true); assert.equal(r.from, "clear_to_close"); assert.equal(r.to, "closing_scheduled"); }
  // each row has exactly one new entered (closing_scheduled) and one completed; no owning event was appended twice
  for (const id of apps) {
    const jl = (await journal(id)).filter((x) => x.created_at > "2026-01-01" && !(x.kind === "entered" && x.step === "clear_to_close"));
    // the step's one journal line beyond the transition is the record gap the thin fixture rows carry (no 26.2 closings row / 30.3 analysis → `waiting` on the owner named by the gap, journaled once; facts-35-6.ts RecordGap) — never a command
    assert.deepEqual(jl.map((x) => `${x.kind}:${x.step}`), ["completed:clear_to_close", "entered:closing_scheduled", "waiting:closing_scheduled"], `${id}: ${JSON.stringify(jl.map((x) => [x.kind, x.step]))}`);
    const gap = jl.find((x) => x.kind === "waiting")!; assert.ok(gap.waiting_on && gap.detail["gap"] === gap.waiting_on, JSON.stringify(gap.detail));
    assert.equal(jl.filter((x) => x.kind === "command_run").length, 0);
    assert.equal((await events(id, "closing.scheduled")).length, 1, "the owning event once");
    assert.equal((await events(id, "orchestration.step.entered")).filter((e) => e.payload["step"] === "closing_scheduled").length, 1);
    assert.equal((await events(id, "orchestration.step.completed")).length, 1);
    const o = await row(id); assert.equal(o.step, "closing_scheduled"); assert.equal(o.lease_holder, null, "the lease released after the row");
  }
  assert.equal(await inApps(`FROM closing_orchestration_steps WHERE true`), journalBefore + 150);
  assert.equal(await inApps(`FROM loan_events WHERE type LIKE 'orchestration.%'`), 100);
  // a third pass with no new facts writes nothing
  await settle();
  clock.set(MST("2026-11-02", "10:02")); await runOrchestrationPass(runtime, clock.now(), { holder: "sweep:C0" }); await settle();   // absorbs the platform's reactions to the passes above (the read cursor); the record is at rest
  const eventsAfter = await inApps(`FROM loan_events WHERE true`); const decisionsAfter = await inApps(`FROM agent_decisions WHERE true`); const rowsAfter = JSON.stringify((await db.query(`SELECT id, step, status, waiting_on, hold_reason, step_attempts, last_event_sequence::text AS last_event_sequence, updated_at FROM closing_orchestrations WHERE application_id = ANY($1::uuid[]) ORDER BY id`, [apps])));
  clock.set(MST("2026-11-02", "10:03"));
  const c = await runOrchestrationPass(runtime, clock.now(), { holder: "sweep:C" });
  assert.equal(c.rows.filter((r) => apps.includes(r.application_id) && r.wrote).length, 0, JSON.stringify(c.rows.filter((r) => r.wrote)).slice(0, 400));
  assert.equal(await inApps(`FROM closing_orchestration_steps WHERE true`), journalBefore + 150); assert.equal(await inApps(`FROM loan_events WHERE true`), eventsAfter); assert.equal(await inApps(`FROM agent_decisions WHERE true`), decisionsAfter);
  assert.equal(JSON.stringify((await db.query(`SELECT id, step, status, waiting_on, hold_reason, step_attempts, last_event_sequence::text AS last_event_sequence, updated_at FROM closing_orchestrations WHERE application_id = ANY($1::uuid[]) ORDER BY id`, [apps]))), rowsAfter);
  assert.ok(eventsAfter >= eventsBefore + 100);
  // a step whose owning command throws: a row at conditions_open with no conditions and no 23.3 decision row — runCtcChecklist throws on the missing credit_decisions row
  const bad = (await db.query<{ id: string }>(`INSERT INTO applications (partner_party_id, channel, transaction_type, occupancy, status, six_items) SELECT partner_party_id, channel, transaction_type, occupancy, status, six_items FROM applications WHERE id = $1 RETURNING id::text AS id`, [seed.appId]))[0]!.id;
  await db.query(`INSERT INTO closing_orchestrations (application_id, transaction_type, step, status, opened_at, updated_at) VALUES ($1, 'limited_cash_out', 'conditions_open', 'open', $2, $2)`, [bad, "2026-10-29T20:00:00.000Z"]);
  const unit = async () => ({ events: await n(`FROM loan_events WHERE application_id = $1 AND type NOT LIKE 'orchestration.%' AND NOT (type = 'escalation.created' AND actor_id = 'disclosures')`, [bad]), entities: await n(`FROM entity_records WHERE application_id = $1`, [bad]), owners: await n(`FROM agent_decisions WHERE application_id = $1 AND agent <> 'disclosures'`, [bad]), timers: await n(`FROM timers WHERE application_id = $1`, [bad]) });
  for (const attempt of [1, 2, 3]) {
    clock.set(MST("2026-11-02", `10:0${3 + attempt}`));
    const r = await pass(clock.now(), bad);
    assert.equal(r.rows.length, 1); assert.equal(r.rows[0]!.wrote, true);
    const failed = (await journal(bad)).filter((x) => x.kind === "command_failed");
    assert.equal(failed.length, attempt, `attempt ${attempt}: ${JSON.stringify((await journal(bad)).map((x) => [x.kind, x.command_name, x.error_class, x.detail["message"]]))}`);
    assert.ok(failed.at(-1)!.error_class && failed.at(-1)!.error_class!.length > 0, "command_failed{error_class}"); assert.equal(failed.at(-1)!.error_class, failed[0]!.error_class); assert.equal(failed.at(-1)!.step, "conditions_open");
    assert.deepEqual(await unit(), { events: 0, entities: 0, owners: 0, timers: 0 }, `no other row of that unit of work exists: the owner's command rolled back to its savepoint (${JSON.stringify((await events(bad)).map((e) => [e.type, e.actor_id, e.payload]))})`);
    const o = await row(bad); assert.equal(o.step_attempts, attempt);
    if (attempt < 3) { assert.equal(o.status, "open", "the next pass retries"); assert.equal(o.hold_reason, null); }
    else { assert.equal(o.status, "held"); assert.equal(o.hold_reason, "failed"); assert.equal(o.waiting_on, "ops_analyst"); }
  }
  assert.equal((await journal(bad)).filter((x) => x.kind === "command_run").length, 0, "no command ever completed");
  const held = await events(bad, "orchestration.held"); assert.equal(held.length, 1); assert.equal(held[0]!.payload["reason"], "failed");
  const esc = await escalations(bad, "ops_analyst"); assert.equal(esc.length, 1); assert.equal(esc[0]!.completed_at, null); assert.equal(await n(`FROM escalations WHERE application_id = $1`, [bad]), 1);
  // held{failed} is not retried by a fourth pass
  clock.set(MST("2026-11-02", "10:10"));
  const r4 = await pass(clock.now(), bad); assert.equal(r4.wrote, 0);
  assert.equal((await journal(bad)).filter((x) => x.kind === "command_failed").length, 3);
});

test("35.6-T13: Given a row entered `wire_released` at Thu Nov 12 13:00 ET with `clocked=true` (waiting on the settlement agent's statement) and no `confirmDisbursement` through Mon Nov 16, when the sweep runs Tue Nov 17, then `SM_ORCH_STEP_STALLED_2BD` is `breached` with one `ops_analyst` escalation whose payload names `application_id`, `step = wire_released` and `waiting_on = settlement_agent`; given the statement arrived Fri Nov 13, then the timer is `satisfied` by `orchestration.step.completed` and no escalation exists.", { skip }, async () => {
  // the row of T7's money-mismatch branch, released by the ops_analyst once the agent's corrected statement is on file, then driven to wire_released with the final statement withheld
  const u = chain.u!; assert.ok(u, "T7's second journey");
  fakesFor(runtime).settlementAgent.script(u.appId, { statement_id: `FAKE-SS-${u.R}-corrected`, kind: "requested_net", requested_net_cents: WORKED_A.net_wire_cents, escrow_deposit_cents: WORKED_A.escrow_deposit_cents, received_at: EST("2026-11-12", "08:40") });
  clock.set(EST("2026-11-12", "08:45")); await u.tool({ app: u.appId }, "35.6", "orchestration.release", { application_id: u.appId, reason: "corrected settlement statement on file" }, OPS);
  clock.set(EST("2026-11-12", "08:50")); await pass(clock.now(), u.appId);
  clock.set(EST("2026-11-12", "08:55")); await pass(clock.now(), u.appId);
  assert.equal((await row(u.appId)).waiting_on, "funding_approver", JSON.stringify((await journal(u.appId)).slice(-6).map((x) => [x.step, x.kind, x.command_name, x.command_op, x.error_class, x.detail["message"] ?? x.detail["reason"] ?? x.detail["gap"] ?? null])));
  clock.set(EST("2026-11-12", "09:40")); await reviewers.tick(runtime, clock.now());
  fakesFor(runtime).settlementAgent.withholdFinal(u.appId, null);
  clock.set(EST("2026-11-12", "13:00")); const r = await pass(clock.now(), u.appId);
  const o = await row(u.appId); assert.equal(o.step, "wire_released", JSON.stringify([o, r]).slice(0, 600));
  const entered = (await journal(u.appId)).filter((x) => x.kind === "entered" && x.step === "wire_released").at(-1)!; assert.ok(entered); assert.equal(entered.clocked, true);
  clock.set(EST("2026-11-12", "13:05")); await reviewers.tick(runtime, clock.now());   // the FAKE approver books 27.1's advance; the agent's final statement stays withheld
  clock.set(EST("2026-11-12", "13:10")); await pass(clock.now(), u.appId);
  assert.equal((await row(u.appId)).waiting_on, "settlement_agent", JSON.stringify(await row(u.appId)));
  assert.equal(await n(`FROM loan_events WHERE application_id = $1 AND type = 'loan.funded'`, [u.appId]), 0);
  const armed = (await timers(u.appId, "SM_ORCH_STEP_STALLED_2BD")).filter((t) => t.status === "armed"); assert.equal(armed.length, 1, JSON.stringify(await timers(u.appId, "SM_ORCH_STEP_STALLED_2BD"))); assert.equal(armed[0]!.due_date, "2026-11-16");
  // no confirmDisbursement through Mon Nov 16; when the sweep runs Tue Nov 17
  clock.set(EST("2026-11-17", "09:00")); await runtime.sweep(clock.now(), { verify: false }); await settle();
  const breached = (await timers(u.appId, "SM_ORCH_STEP_STALLED_2BD")).filter((t) => t.status === "breached"); assert.equal(breached.length, 1, JSON.stringify(await timers(u.appId, "SM_ORCH_STEP_STALLED_2BD")));
  const esc = await db.query<{ payload: P; owner_role: string }>(`SELECT payload, owner_role FROM escalations WHERE owner_role = 'ops_analyst' AND payload->>'application_id' = $1 AND payload->>'step' = 'wire_released'`, [u.appId]);
  assert.equal(esc.length, 1, JSON.stringify(esc)); assert.equal(esc[0]!.payload["waiting_on"], "settlement_agent"); assert.equal(esc[0]!.payload["application_id"], u.appId);
  // given the statement arrived Fri Nov 13 instead (the main line's row, funded Thu Nov 12): the timer is satisfied by orchestration.step.completed and no escalation exists
  const j = await chainJourney();
  const ts = (await timers(j.appId, "SM_ORCH_STEP_STALLED_2BD")); assert.ok(ts.length >= 1, "the main line's wire_released entry armed the stall clock");
  const completed = (await events(j.appId, "orchestration.step.completed")).filter((e) => e.payload["step"] === "wire_released"); assert.equal(completed.length, 1);
  // the wire_released entry (Thu Nov 12 → due Mon Nov 16) is satisfied by its completion the same day; the row's later `funded` entry (boarding is 30.2's hand-off, T9) is the instance the Nov 17 sweep may breach — not this step's
  const satisfiedAt = (await events(j.appId, "timer.satisfied")).filter((e) => e.payload["code"] === "SM_ORCH_STEP_STALLED_2BD"); assert.ok(satisfiedAt.length >= 1, JSON.stringify(ts));
  assert.ok(ts.filter((t) => t.due_date === "2026-11-16").some((t) => t.status === "satisfied"), JSON.stringify(ts));
  assert.equal(await n(`FROM escalations WHERE owner_role = 'ops_analyst' AND payload->>'application_id' = $1 AND payload->>'step' = 'wire_released'`, [j.appId]), 0);
});

test("35.6-T14: Given a request to `orchestration.step` on the hosted API whose input carries `conditions`, `facts`, a `*_cents` field or `state`, then it is refused `NO_CLIENT_STATE` before any write; given a row whose next step is `documents_released` while 25.2's `assertGateOpen` answers closed, then it is `held{gate_closed}` and no 26.1 command ran; given a money-field change proposed by the agent (an `officer`-only snapshot override on `POST /fund`), when no `officer` approval record exists, then the command is refused and nothing is written; given any pass, then no `timers` row was satisfied, extended or cancelled by this process (a contract test over the timer repository's callers).", { todo: true });

test("35.6-T15: Given `rescission.exercised` on Mon Nov 9 (32.7's ChoiceCard through 25.3) on a row at `execution_reviewed`, when the pass runs, then 26.3 `openUnwind` ran, 26.4's MIN reversal request exists, no `warehouse.advance.requested`, `funding.authorized` or `loan.funded` was ever appended, no `loans` row exists, the row is `unwinding` and, on 26.3's `funding.unwind.completed`, `unwound` (terminal); given `funding.cancelled` after `funding.wire.accepted`, then `SM_O73_FUNDS_RETURN_2BD` is armed by 26.3 and the row is `unwinding` until 27.1 matches the returned funds.", { skip }, async () => {
  // a row at execution_reviewed (its own journey, consummated Fri Nov 6) and rescission.exercised on Mon Nov 9 through 25.3's own tool (32.7's ChoiceCard → 25.3 record_exercise)
  const v = await driveTo(await newJourney(), "execution_reviewed");
  clock.set(MST("2026-11-09", "10:00"));
  const ex = await v.tool({ app: v.appId }, "25.3", "sweepInboundForRescission", { op: "record_exercise", exercise_id: `X-${v.R}`, consumer_id: "B1", method: "portal", received_at: MST("2026-11-09", "10:00"), document_id: `DOC-RESCIND-${v.R}`, written: true, enote_registered: true }, DISCLOSURE);
  assert.equal((ex.output["exercise"] as P)["valid"], true, JSON.stringify(ex.output).slice(0, 300)); await settle();
  assert.equal((await events(v.appId, "rescission.exercised")).length, 1);
  // when the pass runs: 26.3 openUnwind, 26.4's MIN reversal request; nothing of the funding path was ever appended; no loans row; the row is unwinding
  clock.set(MST("2026-11-09", "10:05")); const r = await pass(clock.now(), v.appId); assert.equal(r.rows[0]!.wrote, true, JSON.stringify(r).slice(0, 400));
  const jl = await journal(v.appId); const fail = JSON.stringify(jl.slice(-8).map((x) => [x.step, x.kind, x.command_name, x.command_op, x.error_class, x.refusal_code, x.detail["message"] ?? x.detail["reason"] ?? x.detail["gap"] ?? null])).slice(0, 3000);
  assert.ok(jl.some((x) => x.kind === "command_run" && x.command_process === "26.3" && x.command_name === "openUnwind" && x.command_op === "open"), fail);
  const rev = jl.find((x) => x.kind === "command_run" && x.command_process === "26.4" && x.command_name === "registerMin" && x.command_op === "reverse")!; assert.ok(rev, fail); assert.equal(rev.actor_id, "post-closing");
  assert.equal((await events(v.appId, "mers.min.reversed")).length, 1, "26.4's MIN reversal request (the eRegistry batch) exists");
  assert.equal(await n(`FROM loan_events WHERE application_id = $1 AND type IN ('warehouse.advance.requested', 'funding.authorized', 'loan.funded')`, [v.appId]), 0);
  // no loans row exists for the new loan (the refinance's prior loan is the servicing book's, seeded before the application): nothing funded or boarded names a loan, and no loans row carries the eNote's MIN
  const vMin = String((await entitiesOf("enotes", v.appId)).at(-1)!.data["min"]);
  assert.equal(await n(`FROM loan_events WHERE application_id = $1 AND type IN ('loan.funded', 'loan.boarded') AND loan_id IS NOT NULL`, [v.appId]), 0);
  assert.equal(await n(`FROM loans WHERE min = $1`, [vMin]), 0, "no loans row exists");
  const o = await row(v.appId); assert.equal(o.status, "unwinding", JSON.stringify(o));
  assert.equal(await n(`FROM loan_events WHERE application_id = $1 AND type = 'funding.unwind.opened'`, [v.appId]), 1);
  // on 26.3's funding.unwind.completed (the officer's sign-off through 26.3's own tool): unwound (terminal)
  const opened = (await events(v.appId, "funding.unwind.opened")).at(-1)!; const unwind = { id: String(opened.payload["unwind_id"]), data: { funding_id: opened.payload["funding_id"] } };
  // the unwind file's steps (26.3 rule 10: the wire cancelled, the advance request withdrawn, the sets voided, the registrations reversed …) executed by the officer with evidence, then the completion
  const steps = (opened.payload["steps"] as P[]) ?? []; assert.ok(steps.length >= 1, JSON.stringify(opened.payload));
  clock.set(MST("2026-11-10", "09:00"));
  for (const [k, s] of steps.entries()) await v.tool({ app: v.appId }, "26.3", "openUnwind", { op: "step", funding_id: unwind.data["funding_id"], unwind_id: unwind.id, step_index: k, evidence: `DOC-UNWIND-${v.R}-${k}: ${String(s["step"]).slice(0, 60)}`, at: MST("2026-11-10", "09:00") }, OFFICER);
  await v.tool({ app: v.appId }, "26.3", "openUnwind", { op: "complete", funding_id: unwind.data["funding_id"], unwind_id: unwind.id, outcome: "rescinded_before_disbursement", at: MST("2026-11-10", "09:05") }, OFFICER); await settle();
  assert.equal((await events(v.appId, "funding.unwind.completed")).length, 1);
  clock.set(MST("2026-11-10", "09:05")); await pass(clock.now(), v.appId);
  const o2 = await row(v.appId); assert.equal(o2.status, "unwound", JSON.stringify(o2));
  clock.set(MST("2026-11-10", "09:06")); const r3 = await pass(clock.now(), v.appId); assert.equal(r3.rows.length, 0, "a terminal row is never claimed again");
  // given funding.cancelled after funding.wire.accepted: a row at the wire's acceptance (its own journey, entered wire_released Thu Nov 12 13:00 ET, the funds not yet at the agent), the officer cancels through 26.3's own tool
  const w = await driveTo(await newJourney(), "wire_released"); assert.equal((await events(w.appId, "funding.wire.accepted")).length, 1);
  const wf = (await events(w.appId, "funding.requested")).at(-1)!;
  clock.set(EST("2026-11-12", "13:20")); await w.tool({ app: w.appId }, "26.3", "openUnwind", { op: "cancel", funding_id: wf.payload["funding_id"], unwind_id: `UNW-${w.R}`, reason: "documents_not_returned", at: clock.now() }, OFFICER); await settle();
  const cancelled = await events(w.appId, "funding.cancelled"); assert.equal(cancelled.length, 1); assert.equal(cancelled[0]!.payload["after_wire_accepted"], true);
  const fr = await timers(w.appId, "SM_O73_FUNDS_RETURN_2BD"); assert.ok(fr.some((t) => t.status === "armed"), JSON.stringify(fr));
  clock.set(EST("2026-11-12", "13:25")); await pass(clock.now(), w.appId);
  const wo = await row(w.appId); assert.equal(wo.status, "unwinding", JSON.stringify(wo)); assert.equal(wo.step, "wire_released");
  assert.equal(await n(`FROM loan_events WHERE application_id = $1 AND type = 'loan.funded'`, [w.appId]), 0, "unwinding until 27.1 matches the returned funds");
});

test("35.6-T16: Given the purchase fixture (Columbus, OH; wet; paper note; the session Wed Nov 18 10:05 ET), when the pass runs Tue Nov 17 16:00 ET, then 26.3 `evaluateFundingConditions{op: pre_signing}` passed the pre-signing subset, the worksheet from the CD nets $412,000.00 − 13 × $71.96 ($935.48) − $1,240.00 + $515.00 = $410,339.52, 27.1's advance is $403,760.00 with partner contribution $6,579.52, the wire released by the FAKE `funding_approver` at 08:55 ET Nov 18 has value date 2026-11-18 (`SM_O73_WET_FUNDS_AT_TABLE_GATE` satisfied before the session), the execution review passed 11:40 ET, the disbursement authorization issued, and `loan.funded{disbursement_date=2026-11-18}`; after boarding the MOM registration is due Nov 25 (`MERS_PROC_MOM_REGISTER_7`) and the wet note's custodian delivery is due Wed Nov 25 (`SM_WH_WET_NOTE_DELIVERY_5BD`, Thanksgiving excluded).", { todo: true });

test("35.6-T17: Given the OH loan delivered Mon Nov 30, certified Tue Dec 1 and the advice dated Wed Dec 2 (price 101.000, LLPA waived, interest due lender $70.10, net wire $416,190.10) with the matching bank credit, when the pass runs, then the payoff is $404,852.72 (principal $403,760.00 + 14 days' interest $1,067.72 + $25.00), cost recovery $2,774.00, SM retained $831.00 (premium $4,120.00 − lender credit $515.00 − LLPA $0.00 − costs $2,774.00), partner residual $7,732.38, `purchase_reconciliations.status = reconciled`, `warehouse.bailee_letter.released{effective=2026-12-02}` exists, and `SM_WH_INTERIM_FUNDER_RELEASE_2BD` is armed by 27.2.", { todo: true });

test("35.6-T18: Given the sweep at 06:00 ET, then 35.3's `closing_orchestration_daily` unit ran `orchestration.pass{op: daily_receipt}` once, `orchestration_daily_receipts` has one row for the date with `open`, `waiting_human`, `waiting_vendor`, `waiting_borrower`, `waiting_window`, `held`, `completed_today` and `fixture_used_today` matching a direct count of `closing_orchestrations`, `orchestration.daily.run_completed` satisfied and re-armed `SM_ORCH_OPEN_BOOK_DAILY` on the global subject (one armed instance), the board document is a 35.2 row, and `orchestration.board` returns every open row with `step`, `status`, `waiting_on`, the next owning clock due and the advance's dwell day.", { todo: true });

test("35.6-T19: Given a row at `funded` on the demo clock at 2026-11-12 and `POST /v1/demo/advance{days: 3}`, then the pass ran inline per crossed day: `loan.staged`/`loan.boarded` dated 2026-11-12, `delivery.package.frozen` dated 2026-11-13, the operator task's SLA 2026-11-16 15:00 MT, `SM_ORCH_HANDOFF_AFTER_FUNDED_4H` and `SM_ORCH_DELIVERY_OPEN_2BD` satisfied, and `closing_orchestration_steps.sweep_run_id` differs per day.", { todo: true });
