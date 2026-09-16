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

const { url: DB_URL, skip } = await testDatabase(import.meta.url);
const TOKEN = "t-" + randomUUID();
const clock = new FixedClock("2026-10-05T16:00:00.000Z");
const logLines: string[] = [];
const logger = createLogger("json", (line) => { logLines.push(line); if (process.env["ORCH_DEBUG"] && /"severity":"(ERROR|WARNING)"/.test(line)) process.stderr.write(line + "\n"); });
type P = Record<string, unknown>;
type Actor = { kind: "agent" | "human" | "system"; id: string; role?: string };
const VERIFICATION: Actor = { kind: "agent", id: "verification" }; const FRAUD_RISK: Actor = { kind: "agent", id: "fraud-risk" }; const VALUATION: Actor = { kind: "agent", id: "valuation" }; const UNDERWRITER: Actor = { kind: "agent", id: "underwriter" };
const DISCLOSURES: Actor = { kind: "agent", id: "disclosures" }; const OPS: Actor = { kind: "human", id: "u-ops", role: "ops_analyst" };
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
/** The counts T1/T12 compare across a pass that must write nothing (the row's `last_event_sequence` is the pass's read cursor — 32.x's reactions to the owners' events move it without any orchestration write). */
const footprint = async (appId: string) => ({ steps: await n(`FROM closing_orchestration_steps WHERE application_id = $1`, [appId]), events: await n(`FROM loan_events WHERE application_id = $1`, [appId]), decisions: await n(`FROM agent_decisions WHERE application_id = $1`, [appId]), row: JSON.stringify(await row(appId), (k, v) => (k === "last_event_sequence" ? undefined : typeof v === "bigint" ? v.toString() : v)), reports: await n(`FROM entity_current WHERE kind = 'credit_reports' AND data->>'application_id' = $1`, [appId]) });
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
  await j.recordIntent();   // 21.4: "I want to proceed" Tue Oct 6 09:14 MST — 24.1's SM-borne order needs the intent in force
  clock.set(MST("2026-10-06", "09:20"));
  await j.tool(scope, "24.1", "readDuOffer", {}, VALUATION);
  await j.tool(scope, "24.1", "placeOrder", { transaction_type: "limited_cash_out", occupancy: "primary", units: 1, property_type: "sfr", ltv_bps: 7000, fee_paid_by: "sm", fee_quote_cents: "65000", fee_test: FEE_TEST, property_state: "AZ", vendor_party_id: "amc-1", channel: "amc", amc_registration: { amc_registration_id: `amcreg-az-${j.R}`, amc_party_id: "amc-1", state: "AZ", registration_number: "AMC-AZ-1234", expires_on: "2027-06-30", asc_amc_registry_status: "active", verified_at: MST("2026-10-01", "09:00") }, order_payload: ORDER_PAYLOAD, le_effective_receipt_date: "2026-10-05", ordered_at: MST("2026-10-06", "09:20"), time_zone: "America/Phoenix" }, VALUATION);
}
/** The shared refinance orchestration the chain T1 → T11 drives in file order; each T-id's Given is the previous T-id's Then. */
const chain: { j: Journey | null } = { j: null };
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
  await settle();   // 32.3's StatusCard reaction to credit.report.ordered lands off the pass's transaction; the footprint is the record at rest
  const before = await footprint(appId);
  clock.set(MST("2026-10-05", "17:51"));
  const r2 = await pass(clock.now());
  assert.equal(r2.wrote, 0, JSON.stringify(r2).slice(0, 300));
  const after = await footprint(appId);
  assert.deepEqual(after, before, "the second pass wrote no row, no event and no decision");
});

test("35.6-T2: Given a usable representative score, when the pass runs, then in one sweep 23.1 `associateCredit`, `buildDuRequest` (23.6's `du.document.emitted`), 23.7 `runDuPreflight` (`du.preflight.passed`), 23.1 `submitCasefile` (`du.submitted`, `du.casefile_id.recorded`), `fetchFindings` (`du.findings.received{recommendation=approve_eligible}`), 23.2 `parseFindings{op: interpret}` and 23.3 `assessRisk` + `issueConditionalApproval` (`decision.issued`) ran as `underwriter`, the row is at `conditions_open` with the conditions 23.2 opened, and a contract test finds no `append(` of `du.submitted`, `clear_to_close.issued`, `closing.consummated`, `funding.authorized`, `loan.funded` or `loan.purchased` anywhere under `src/domain/operations-runtime/`.", { skip }, async () => {
  const j = await chainJourney(); const appId = j.appId;
  assert.equal((await events(appId, "credit.representative_score.computed")).at(-1)!.payload["state"], "usable", "Given a usable representative score");
  await verifyIdentitiesAndValue(j);
  clock.set("2026-10-06T17:00:00.000Z");   // 10:00 MST Tue Oct 6 — one sweep
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
  // the contract: no `append(` of an owning literal anywhere under src/domain/operations-runtime/ (35.6's files) — the owners emit
  const owning = ["du.submitted", "clear_to_close.issued", "closing.consummated", "funding.authorized", "loan.funded", "loan.purchased"];
  const dir = fileURLToPath(new URL("./", import.meta.url));
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts") && !x.endsWith(".test.ts"))) {
    const text = readFileSync(dir + f, "utf8");
    for (const m of text.matchAll(/append\(([^;]{0,400})/g)) for (const lit of owning) assert.ok(!m[1]!.includes(`"${lit}"`), `${f}: append( of the owning literal ${lit}`);
  }
});

test("35.6-T3: Given every condition cleared (the reviewer-only ones by an `underwriting_reviewer` — the FAKE reviewer after 20 s under `INTEGRATIONS=fake`), when the pass runs, then 23.3 `runCtcChecklist{op: ctc}` ran with `facts` built by `facts-35-6.ts` from the record (each item's source event id in the decision record), `issueClearToClose` appended `clear_to_close.issued{passed=true}` keyed by the application, `orchestration.opened` and `orchestration.step.entered{step: clear_to_close, clocked: false, waiting_on: borrower}` follow it, and no `SM_ORCH_STEP_STALLED_2BD` instance exists (the wait is the borrower's).", { skip }, async () => {
  const j = await chainJourney(); const appId = j.appId;
  assert.equal((await row(appId)).step, "conditions_open");
  // 21.4: the borrower's lock request and the MLO's approval Wed Oct 7 (CTC_LOCK reads `lock.executed`; 23.3's validity reads its expiry)
  await j.quoteForLock(); await j.requestLock(); await j.executeLockAndCommit();
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
  // the FAKE reviewer after 20 s under INTEGRATIONS=fake: the pass at +25 s clears the reviewer-only item as {kind: human, id: FAKE:underwriting_reviewer}
  clock.set("2026-10-28T16:00:25.000Z");
  const r2 = await pass(clock.now());
  assert.equal(r2.rows[0]!.wrote, true, JSON.stringify(r2).slice(0, 400));
  const jl = await journal(appId);
  const cleared = jl.find((x) => x.kind === "command_run" && x.command_name === "clearCondition")!;
  assert.ok(cleared, JSON.stringify(jl.map((x) => [x.kind, x.command_name, x.error_class])));
  assert.equal(cleared.actor_kind, "human"); assert.equal(cleared.actor_id, "FAKE:underwriting_reviewer"); assert.equal(cleared.actor_role, "underwriting_reviewer");
  for (const id of c.pending) assert.equal((await entity("conditions", id))!["status"], "cleared", `${id} cleared by the reviewer`);
  assert.equal(jl.filter((x) => x.kind === "command_run" && x.command_name === "clearCondition").length, c.pending.length);
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

test("35.6-T4: Given `closing.scheduled` for Fri Nov 6, 2026 14:00 MST from the borrower's slot (26.2 through 32.7), when the pass runs Mon Nov 2 09:00 MST, then 25.2's figure sources were recorded from 24.4's title order and 30.3's frozen analysis, `reconcileFigureSources` reconciled, 25.1 `computeApr` ran, CD v1 is a 35.2 `documents` row with a sha256, it was delivered to both consumers under their E-SIGN consents with receipts recorded from their acknowledgements the same day, `disclosure.cd.waiting_period.computed{earliest_consummation_date=2026-11-05}` exists, `REGZ_1026_19F1_CD_3SBD_GATE` is armed on the application, `SM_O62_CD_TARGET_4SBD` is satisfied, the row is `waiting_window{REGZ_1026_19F1_CD_3SBD_GATE}`; given a second borrower without E-SIGN consent, then that consumer's delivery is `mail` with a mailing proof and the earliest date is the deemed receipt's.", { todo: true });

test("35.6-T5: Given the waiting period computed, when the pass runs Wed Nov 4, then it ordered 22.2 `orderRefresh{soft_refresh}` (Tue Nov 3), asserted 25.2's gate for Nov 6, read 22.4's `funds_to_close.reconciled` and 23.3's CTC gate, and ran 26.1 `computeNoteTerms`, `evaluateDocGenGates`, `takeClosingSnapshot`, `renderDocument`, `buildSmartDocENote`, `runDocumentQc` and `releaseToSettlementAgent` as `title-closing`: the eNote's `data_hash` equals the canonical note-terms hash for $3,402.62, Jan 1, 2027 → Dec 1, 2056, and `closing.documents.released` is on the log; given the credit refresh gate closed instead (an unresolved `verified_new_debt`), then the row is `held{gate_closed, SM_CREDIT_REFRESH_PRECLOSE_GATE}`, no 26.1 command ran and no document was rendered.", { todo: true });

test("35.6-T6: Given the released set and the FAKE RON platform's session (identity proofing for both signers, start, the eNote created, the 1003 and the eNote signed 14:18 and 14:25/14:26 MST, the deed of trust acknowledged 14:36, the seal 14:41), when the pass polls the port, then 26.2's pre-session checks, `verifyEsignConsent`, `openSigningSession`, every `monitorSession` op, `validateAuthoritativeCopy{op: seal}`, `validateAuthoritativeCopy` and `registerENote` ran from the vendor's events (no operator JSON anywhere in the journal), `closing.consummated{note_date=2026-11-06}` is at 14:26 MST, `enote.registered` satisfies `MERS_PROC_ENOTE_REGISTER_1BD`, 26.3 `computeDates{op: open}` recorded `rescission_expires_at=2026-11-11T07:00:00.000Z`, `earliest_funding_date=2026-11-12`, `funding_type=dry`, 25.3's `rescission.period.started` exists, and after `ingestAuditTrail` and `reviewExecution` the row is at `execution_reviewed`, `waiting_window{REGZ_1026_23_RESCISSION_3SBD_GATE}`.", { todo: true });

test("35.6-T7: Given 25.3's `rescission.confirmed_not_rescinded` at Wed Nov 11 08:00 MST and the settlement agent's statement requesting $556,852.07, when the pass runs Thu Nov 12 08:05 ET, then the worksheet was built from the consummated CD (gross $560,000.00; prepaid 19 × $93.97 = $1,785.43; escrow deposit $2,062.50; lender credit $700.00; net $556,852.07 = 55,685,207 cents), `reconcileToSettlementStatement` passed, `evaluateFundingConditions` ran with every fact from the record (the decision record lists the source event or row of `hazard_effective`, `cpl`, `commitment`, `wire_verification`, `ptf_cleared`, `cash_to_close`, `rescission`, `qc_hold`, `ofac`), `funding.authorized` and, from 27.1 `approveAdvance` as `warehouse`, `warehouse.advance.approved` with advance $548,800.00 and partner contribution $8,052.07 are on the log; given instead a settlement statement whose escrow deposit is $1,665.00 against the CD's $2,062.50, then the row is `held{money_mismatch}` naming both figures and their sources, no `funding.authorized` exists and one `officer` escalation is open.", { todo: true });

test("35.6-T8: Given the advance approved, when the pass runs 08:20 ET, then 26.3 `prepareWire` as `funder` prepared a wire of 55,685,207 cents (`funding.wire.prepared`) and the row is `waiting_human{funding_approver}`; an agent actor's `prepareWire{op: release}` is refused `ROLE_DENIED` and the pass never calls it (contract: no `op: \"release\"` literal under `src/domain/operations-runtime/`); when the FAKE `funding_approver` releases at 09:40 ET, then `funding.wire.released`, the bank's `funding.wire.accepted{imad}`, 27.1's `warehouse.advance.funded{advance_date=2026-11-12}`, `notifySettlementAgent{op: agent_receipt}` and, on the uploaded final settlement statement, `confirmDisbursement` → `loan.funded{disbursement_date=2026-11-12, per_diem_cents=9397, prepaid_interest_cents=178543, prepaid_days=19}` keyed by the application only, and `SM_O73_DUAL_CONTROL_RELEASE_1H` and `SM_O73_WIRE_CUTOFF_1300ET` are satisfied.", { todo: true });

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
  // the claim is one lease per pass: a row the other pass leased is skipped; a row advanced by the pass that finished first may be leased again by the other's later page and finds nothing to do (idempotent) — the advance happened under exactly one pass
  const claimedBy = new Map<string, string[]>();
  for (const [holder, rep] of [["A", a], ["B", b]] as const) for (const r of rep.rows) if (apps.includes(r.application_id) && r.wrote) claimedBy.set(r.application_id, [...(claimedBy.get(r.application_id) ?? []), holder]);
  assert.equal(claimedBy.size, 50, `every row claimed and advanced (${claimedBy.size} of 50; A ${a.rows.length}, B ${b.rows.length})`);
  for (const [id, holders] of claimedBy) assert.equal(holders.length, 1, `${id} advanced under exactly one pass (${holders.join(",")})`);
  assert.ok(a.rows.some((r) => r.wrote) && b.rows.some((r) => r.wrote), `both passes claimed pages (A ${a.rows.length}, B ${b.rows.length})`);
  for (const r of [...a.rows, ...b.rows].filter((x) => apps.includes(x.application_id) && x.wrote)) { assert.equal(r.from, "clear_to_close"); assert.equal(r.to, "closing_scheduled"); }
  for (const r of [...a.rows, ...b.rows].filter((x) => apps.includes(x.application_id) && !x.wrote)) { assert.equal(r.from, "closing_scheduled"); assert.equal(r.to, "closing_scheduled"); assert.equal(r.journal, 0); }
  // each row has exactly one new entered (closing_scheduled) and one completed; no owning event was appended twice
  for (const id of apps) {
    const jl = (await journal(id)).filter((x) => x.created_at > "2026-01-01" && !(x.kind === "entered" && x.step === "clear_to_close"));
    assert.deepEqual(jl.map((x) => `${x.kind}:${x.step}`), ["completed:clear_to_close", "entered:closing_scheduled"], `${id}: ${JSON.stringify(jl.map((x) => [x.kind, x.step]))}`);
    assert.equal(jl.filter((x) => x.kind === "command_run").length, 0);
    assert.equal((await events(id, "closing.scheduled")).length, 1, "the owning event once");
    assert.equal((await events(id, "orchestration.step.entered")).filter((e) => e.payload["step"] === "closing_scheduled").length, 1);
    assert.equal((await events(id, "orchestration.step.completed")).length, 1);
    const o = await row(id); assert.equal(o.step, "closing_scheduled"); assert.equal(o.lease_holder, null, "the lease released after the row");
  }
  assert.equal(await inApps(`FROM closing_orchestration_steps WHERE true`), journalBefore + 100);
  assert.equal(await inApps(`FROM loan_events WHERE type LIKE 'orchestration.%'`), 100);
  // a third pass with no new facts writes nothing
  await settle();
  const eventsAfter = await inApps(`FROM loan_events WHERE true`); const decisionsAfter = await inApps(`FROM agent_decisions WHERE true`); const rowsAfter = JSON.stringify((await db.query(`SELECT id, step, status, waiting_on, step_attempts, updated_at FROM closing_orchestrations WHERE application_id = ANY($1::uuid[]) ORDER BY id`, [apps])));
  clock.set(MST("2026-11-02", "10:02"));
  const c = await runOrchestrationPass(runtime, clock.now(), { holder: "sweep:C" });
  assert.equal(c.rows.filter((r) => apps.includes(r.application_id) && r.wrote).length, 0, JSON.stringify(c.rows.filter((r) => r.wrote)).slice(0, 400));
  assert.equal(await inApps(`FROM closing_orchestration_steps WHERE true`), journalBefore + 100); assert.equal(await inApps(`FROM loan_events WHERE true`), eventsAfter); assert.equal(await inApps(`FROM agent_decisions WHERE true`), decisionsAfter);
  assert.equal(JSON.stringify((await db.query(`SELECT id, step, status, waiting_on, step_attempts, updated_at FROM closing_orchestrations WHERE application_id = ANY($1::uuid[]) ORDER BY id`, [apps]))), rowsAfter);
  assert.ok(eventsAfter >= eventsBefore + 100);
  // a step whose owning command throws: a row at conditions_open with no conditions and no 23.3 decision row — runCtcChecklist throws on the missing credit_decisions row
  const bad = (await db.query<{ id: string }>(`INSERT INTO applications (partner_party_id, channel, transaction_type, occupancy, status, six_items) SELECT partner_party_id, channel, transaction_type, occupancy, status, six_items FROM applications WHERE id = $1 RETURNING id::text AS id`, [seed.appId]))[0]!.id;
  await db.query(`INSERT INTO closing_orchestrations (application_id, transaction_type, step, status, opened_at, updated_at) VALUES ($1, 'limited_cash_out', 'conditions_open', 'open', $2, $2)`, [bad, "2026-10-29T20:00:00.000Z"]);
  const unit = async () => ({ events: await n(`FROM loan_events WHERE application_id = $1 AND type NOT LIKE 'orchestration.%' AND NOT (type = 'escalation.created' AND actor_id = 'disclosures')`, [bad]), entities: await n(`FROM entity_records WHERE application_id = $1`, [bad]), owners: await n(`FROM agent_decisions WHERE application_id = $1 AND agent <> 'disclosures'`, [bad]), timers: await n(`FROM timers WHERE application_id = $1`, [bad]) });
  for (const attempt of [1, 2, 3]) {
    clock.set(MST("2026-11-02", `10:0${2 + attempt}`));
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
  clock.set(MST("2026-11-02", "10:09"));
  const r4 = await pass(clock.now(), bad); assert.equal(r4.wrote, 0);
  assert.equal((await journal(bad)).filter((x) => x.kind === "command_failed").length, 3);
});

test("35.6-T13: Given a row entered `wire_released` at Thu Nov 12 13:00 ET with `clocked=true` (waiting on the settlement agent's statement) and no `confirmDisbursement` through Mon Nov 16, when the sweep runs Tue Nov 17, then `SM_ORCH_STEP_STALLED_2BD` is `breached` with one `ops_analyst` escalation whose payload names `application_id`, `step = wire_released` and `waiting_on = settlement_agent`; given the statement arrived Fri Nov 13, then the timer is `satisfied` by `orchestration.step.completed` and no escalation exists.", { todo: true });

test("35.6-T14: Given a request to `orchestration.step` on the hosted API whose input carries `conditions`, `facts`, a `*_cents` field or `state`, then it is refused `NO_CLIENT_STATE` before any write; given a row whose next step is `documents_released` while 25.2's `assertGateOpen` answers closed, then it is `held{gate_closed}` and no 26.1 command ran; given a money-field change proposed by the agent (an `officer`-only snapshot override on `POST /fund`), when no `officer` approval record exists, then the command is refused and nothing is written; given any pass, then no `timers` row was satisfied, extended or cancelled by this process (a contract test over the timer repository's callers).", { todo: true });

test("35.6-T15: Given `rescission.exercised` on Mon Nov 9 (32.7's ChoiceCard through 25.3) on a row at `execution_reviewed`, when the pass runs, then 26.3 `openUnwind` ran, 26.4's MIN reversal request exists, no `warehouse.advance.requested`, `funding.authorized` or `loan.funded` was ever appended, no `loans` row exists, the row is `unwinding` and, on 26.3's `funding.unwind.completed`, `unwound` (terminal); given `funding.cancelled` after `funding.wire.accepted`, then `SM_O73_FUNDS_RETURN_2BD` is armed by 26.3 and the row is `unwinding` until 27.1 matches the returned funds.", { todo: true });

test("35.6-T16: Given the purchase fixture (Columbus, OH; wet; paper note; the session Wed Nov 18 10:05 ET), when the pass runs Tue Nov 17 16:00 ET, then 26.3 `evaluateFundingConditions{op: pre_signing}` passed the pre-signing subset, the worksheet from the CD nets $412,000.00 − 13 × $71.96 ($935.48) − $1,240.00 + $515.00 = $410,339.52, 27.1's advance is $403,760.00 with partner contribution $6,579.52, the wire released by the FAKE `funding_approver` at 08:55 ET Nov 18 has value date 2026-11-18 (`SM_O73_WET_FUNDS_AT_TABLE_GATE` satisfied before the session), the execution review passed 11:40 ET, the disbursement authorization issued, and `loan.funded{disbursement_date=2026-11-18}`; after boarding the MOM registration is due Nov 25 (`MERS_PROC_MOM_REGISTER_7`) and the wet note's custodian delivery is due Wed Nov 25 (`SM_WH_WET_NOTE_DELIVERY_5BD`, Thanksgiving excluded).", { todo: true });

test("35.6-T17: Given the OH loan delivered Mon Nov 30, certified Tue Dec 1 and the advice dated Wed Dec 2 (price 101.000, LLPA waived, interest due lender $70.10, net wire $416,190.10) with the matching bank credit, when the pass runs, then the payoff is $404,852.72 (principal $403,760.00 + 14 days' interest $1,067.72 + $25.00), cost recovery $2,774.00, SM retained $831.00 (premium $4,120.00 − lender credit $515.00 − LLPA $0.00 − costs $2,774.00), partner residual $7,732.38, `purchase_reconciliations.status = reconciled`, `warehouse.bailee_letter.released{effective=2026-12-02}` exists, and `SM_WH_INTERIM_FUNDER_RELEASE_2BD` is armed by 27.2.", { todo: true });

test("35.6-T18: Given the sweep at 06:00 ET, then 35.3's `closing_orchestration_daily` unit ran `orchestration.pass{op: daily_receipt}` once, `orchestration_daily_receipts` has one row for the date with `open`, `waiting_human`, `waiting_vendor`, `waiting_borrower`, `waiting_window`, `held`, `completed_today` and `fixture_used_today` matching a direct count of `closing_orchestrations`, `orchestration.daily.run_completed` satisfied and re-armed `SM_ORCH_OPEN_BOOK_DAILY` on the global subject (one armed instance), the board document is a 35.2 row, and `orchestration.board` returns every open row with `step`, `status`, `waiting_on`, the next owning clock due and the advance's dwell day.", { todo: true });

test("35.6-T19: Given a row at `funded` on the demo clock at 2026-11-12 and `POST /v1/demo/advance{days: 3}`, then the pass ran inline per crossed day: `loan.staged`/`loan.boarded` dated 2026-11-12, `delivery.package.frozen` dated 2026-11-13, the operator task's SLA 2026-11-16 15:00 MT, `SM_ORCH_HANDOFF_AFTER_FUNDED_4H` and `SM_ORCH_DELIVERY_OPEN_2BD` satisfied, and `closing_orchestration_steps.sweep_run_id` differs per day.", { todo: true });
