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
import { Journey, MST, EST, EDT, OFFICER } from "../../runtime/borrower/fixtures/journey.ts";
import { PurchaseJourney } from "../../runtime/borrower/fixtures/journey-purchase.ts";
import { wetFundsAtTableGate } from "../closing/ops-26-3.ts";
import { storeDocument } from "./documents-port-35-6.ts";
import type { FakePewl } from "../secondary/ops-29-1.ts";
import { custodialAccountIdFor } from "./facts-35-6-b.ts";
import { EntityStore } from "../../app/tools.ts";
import { DEMO_SNAPSHOT_CALLS } from "../../runtime/origination.ts";
import { FACILITY_FIXTURE } from "../warehouse/ops-27-1.ts";
import { OffsetClock, advanceDemoClock } from "../../runtime/demo-clock.ts";
import { type FakePurchaseAdviceApi, type FakeCollectionBank, type SettlementServices, type RawPurchaseAdvice } from "../warehouse/ops-27-2.ts";
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
/** T9's spy on src/runtime/origination.ts: the fixture's call count before the chain's funding pass (T8) — unchanged after the hand-off built from the complete record. */
const demoCalls = { before: -1 };
const BORROWER_APP: Actor = { kind: "agent", id: "borrower-app" };
void demoCalls; void DEMO_SNAPSHOT_CALLS; void OFFICER; void OPS; void MST; void EST; void WORKED_A; void WORKED_B; void fakeHuman; void dailyReceipt; void orchestrationBoard; void EV;

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
/** 29.4's rows keyed by delivery id (delivery_operator_tasks, custodian_certifications carry no application_id — they hang off the delivery). */
const entitiesByDelivery = async (kind: string, deliveryId: string): Promise<{ id: string; data: P }[]> => (await db.query<{ id: string; data: unknown }>(`SELECT id, data FROM entity_current WHERE kind = $1 AND data->>'delivery_id' = $2`, [kind, deliveryId])).map((r) => ({ id: r.id, data: decodeEntityData(r.data) as P }));
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
  await seedWireInstruction(); await seedAporTables(); await j.seedBook(); await j.openApplication(); await seedDemographics(j); await interviewWithJointIntent(j); await j.quoteAndLe(); await seedHmda(j);
  return j;
}
/** 21.1's restricted demographics row per application borrower (0057 restricted_fl.applicant_demographics — the interview's HMDA questions; the only demographics table 30.2 reads): borrower A self-reported, borrower B "information not provided" — never derived. */
async function seedDemographics(j: Journey): Promise<void> {
  const at = MST("2026-10-05", "10:35");
  await db.query(`INSERT INTO restricted_fl.applicant_demographics (application_borrower_id, ethnicity, race, sex, age, declined_ethnicity, declined_race, declined_sex, visual_observation_used, collection_channel, collected_at) VALUES ($1, $2::jsonb, $3::jsonb, $4, $5, false, false, false, false, 'telephone', $6)`, [j.abIds[0], JSON.stringify(["not_hispanic_or_latino"]), JSON.stringify(["white"]), "female", 41, at]);
  await db.query(`INSERT INTO restricted_fl.applicant_demographics (application_borrower_id, ethnicity, race, sex, age, declined_ethnicity, declined_race, declined_sex, visual_observation_used, collection_channel, collected_at) VALUES ($1, NULL, NULL, NULL, $2, true, true, true, false, 'telephone', $3)`, [j.abIds[1], 40, at]);
}
/** 28.3's HMDA record and ULI for the application (the partner's LEI + the loan identifier + the check digit) — 29.3's ULDD reads `hmda.uli.assigned{uli}`. */
async function seedHmda(j: Journey): Promise<void> {
  const scope = { app: j.appId }; const lei = "5493001KJTIIGC8Y1R12";
  await j.tool(scope, "28.3", "createRecord", { partner_id: j.PARTNER_ID, lei, sequence: Number(BigInt(`0x${j.appId.replace(/-/g, "").slice(0, 6)}`) % 900000n) + 1, application_date: "2026-10-05", transaction_type: "limited_cash_out", occupancy: "primary", loan_amount_cents: "56000000", property_type: "sfr", total_units: 1, nmlsr_id: "123456", property: { street_address: "100 N Central Ave", city: "Phoenix", state: "AZ", zip: "85004" } }, OFFICER);
  await j.tool(scope, "28.3", "assignUli", { partner_id: j.PARTNER_ID, lei, application_date: "2026-10-05", transaction_type: "limited_cash_out", sequence: Number(BigInt(`0x${j.appId.replace(/-/g, "").slice(0, 6)}`) % 900000n) + 1 }, OFFICER);
}
/** SM's approved warehouse-lender wire instruction as 29.4 lists it (`wire_instructions`, status active — Fannie Mae Form 482, the bailee Letter Name = 27.1's facility letter name): a platform row, seeded once. */
/** 23.4's FFIEC APOR table rows as the owner's `apor_tables` entities (global; `aporTables()` reads them when a caller passes none) — the pass's consummation-stage run reads them from the record. */
async function seedAporTables(): Promise<void> {
  const have = new Set((await db.query<{ id: string }>(`SELECT id FROM entity_current WHERE kind = 'apor_tables'`)).map((r) => r.id));
  const missing = APOR_TABLES().filter((t) => !have.has(t.table_id)); if (!missing.length) return;
  const store = new EntityStore();
  for (const t of missing) store.put("apor_tables", t.table_id, { ...t } as unknown as Record<string, unknown>, OFFICER, "2026-10-05T13:05:00.000Z");
  await runtime.entities.save(store.versionsSince(0), null);
}
async function seedWireInstruction(): Promise<void> {
  if ((await db.query(`SELECT 1 FROM entity_current WHERE kind = 'wire_instructions' AND id = 'wire-sm-warehouse'`)).length) return;
  const store = new EntityStore();
  store.put("wire_instructions", "wire-sm-warehouse", { wire_instruction_id: "wire-sm-warehouse", partner_id: partnerPartyId, payee_code: "SMWH1", receiver_type: "warehouse_lender", warehouse_lender_org_id: FACILITY_FIXTURE.fnma_warehouse_lender_id, letter_type: "bailee", bailee_letter_name: FACILITY_FIXTURE.bailee_letter_name, status: "active", form_482_document_id: "doc-482-sm", form_482_signed_by: "officer", fnma_confirmation_call_at: "2026-09-15T14:30:00.000Z", approved_by_warehouse_at: "2026-09-15T15:00:00.000Z", approved_by_operator_id: "u-op-warehouse" }, OFFICER, "2026-09-15T15:00:00.000Z");
  await runtime.entities.save(store.versionsSince(0), null);
}
/** The journey's 21.1 interview (a5) with both borrowers' joint-intent affirmations at 10:20/10:22 MST (§1002.7(d), 21.1's own tool) before the six items at 10:41 — the joint-intent facts 22.2 reads from the record. */
async function interviewWithJointIntent(j: Journey): Promise<void> {
  const scope = { app: j.appId }; const R = j.R;
  clock.set(MST("2026-10-05", "10:14"));
  await j.tool(scope, "21.1", "startInterview", { session_id: `S-${R}`, partner_name: "Partner Bank", partner_nmlsr_id: "123456", intake_channel: "voice", creditor_time_zone: "America/Phoenix", property_state: "AZ", property_address: "100 N Central Ave, Phoenix, AZ 85004", transaction_type: "limited_cash_out", occupancy: "primary", borrowers: [{ id: "B1", legal_name: "Alex Borrower", marital_status: "married" }, { id: "B2", legal_name: "Blake Borrower", marital_status: "married" }], model_version: "intake-2026.09", prompt_version: "p-1.4" });
  clock.set(new Date("2026-10-05T10:14:07-07:00").toISOString()); await j.tool(scope, "21.1", "discloseAI", { session_id: `S-${R}`, utterance_id: `utt-${R}`, state: "AZ" });
  clock.set(MST("2026-10-05", "10:16")); await j.tool(scope, "21.1", "captureField", { field: "credit_request", transaction_type: "limited_cash_out", occupancy: "primary", property_state: "AZ", identity_verified: true });
  await j.tool(scope, "21.1", "confirmPrefill", { op: "offer", item: "name", value: "Alex Borrower" }); await j.tool(scope, "21.1", "confirmPrefill", { item: "name" });
  // the SSN is 32.2's one typed field (E5): confirmField{path: ssn} stores the nine digits encrypted beside the last four on application_borrowers (32.18 rule 7) and captures 21.1's `ssn` six-item on the way — both borrowers, so the record carries every TIN 30.2's OB-014 reads
  clock.set(MST("2026-10-05", "10:18")); await j.tool(scope, "32.2", "application.confirmField", { path: "ssn", fields: [{ path: "ssn", value: "123-45-6789", source: "borrower" }], application_id: j.appId, application_borrower_id: j.abIds[0], borrower_id: "B1" }, BORROWER_APP);
  clock.set(MST("2026-10-05", "10:18")); await j.tool(scope, "32.2", "application.confirmField", { path: "ssn", fields: [{ path: "ssn", value: "987-65-4321", source: "borrower" }], application_id: j.appId, application_borrower_id: j.abIds[1], borrower_id: "B2" }, BORROWER_APP);
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
  // 24.1: the borrower's intent (Oct 6 09:14 MST) and the SM-borne valuation order (09:20). 32.18's borrower app starts the DU chain the moment the file is complete (an
  // asynchronous reaction that may land before or after this order); the partner obtains an appraisal on this refinance (`appraisal_obtained` — B4-1.4-10: a value-acceptance
  // offer may not be exercised when an appraisal is obtained), so 24.1's selection is traditional either way and the fixture's appraisal path is deterministic.
  await j.recordIntent();   // 21.4: "I want to proceed" Tue Oct 6 09:14 MST — 24.1's SM-borne order needs the intent in force
  clock.set(MST("2026-10-06", "09:20"));
  await j.tool(scope, "24.1", "readDuOffer", {}, VALUATION);
  const vo = await j.tool(scope, "24.1", "placeOrder", { transaction_type: "limited_cash_out", occupancy: "primary", units: 1, property_type: "sfr", ltv_bps: 7000, appraisal_obtained: true, fee_paid_by: "sm", fee_quote_cents: "65000", fee_test: FEE_TEST, property_state: "AZ", vendor_party_id: "amc-1", channel: "amc", amc_registration: { amc_registration_id: `amcreg-az-${j.R}`, amc_party_id: "amc-1", state: "AZ", registration_number: "AMC-AZ-1234", expires_on: "2027-06-30", asc_amc_registry_status: "active", verified_at: MST("2026-10-01", "09:00") }, order_payload: ORDER_PAYLOAD, le_effective_receipt_date: "2026-10-05", ordered_at: MST("2026-10-06", "09:20"), time_zone: "America/Phoenix" }, VALUATION);
  j.valuationOrderId = String(vo.output["order_id"]);
  // 22.4: the checking account verified from two statements (the 45-day / two-month standard) — the usable funds the cash to close ($5,529.43) is measured against
  clock.set(MST("2026-10-06", "09:25"));
  for (const s of [{ id: `stmt-aug-${j.R}`, start: "2026-08-01", end: "2026-08-31" }, { id: `stmt-sep-${j.R}`, start: "2026-09-01", end: "2026-09-30" }]) await j.tool(scope, "22.4", "parseStatement", { asset_id: `chk-${j.R}`, document_id: s.id, period_start: s.start, period_end: s.end, ending_balance_cents: "3124018" }, VERIFICATION);
  await settle();   // the flow's reactions to the verified assets (its DU chain, when it runs) land here, never under a later pass
  // 21.4: the borrower's lock request and the MLO's approval Wed Oct 7 (23.3's validity reads the lock's expiry; CTC_LOCK reads `lock.executed`)
  await j.quoteForLock();
  const jj = j as unknown as { QUOTE_INPUTS: Record<string, unknown>; PRICES: { note_rate_pct: string; price: string }[]; QUOTE: string };
  // The lock-day sheet: rates rallied 25 bps since the Oct 5 quote — 6.125% prices at 101.125 on Wed Oct 7 (the commitment price 29.4's and 35.6's worked figures carry; 20.4 worked example A's Oct 5 sheet had 100.875) — and the PE–WL best-efforts quote at commitment matches the sheet (29.1 rule 6: no execution variance).
  const rallyPrices = jj.PRICES.map((p) => (p.note_rate_pct === "6.125" ? { ...p, price: "101.125" } : p));
  clock.set(EDT("2026-10-07", "06:40")); await j.tool({}, "20.4", "publishRateSheet", { rate_sheet_id: `rs-2026-10-07-rally-${j.R}`, partner_id: j.PARTNER_ID, source: "pe_whole_loan_api", published_at: EDT("2026-10-07", "06:40"), expires_at: EDT("2026-10-07", "17:00"), prices: rallyPrices }, PRICING);
  (runtime.originationServices.vendor("pewl") as FakePewl).setPrice("101.125");
  clock.set(MST("2026-10-07", "10:05"));
  // 21.4's quote carries the priced terms the lock executes on: the lock-day sheet's price for 6.125 and the lender credit 20.4 prices for this scenario at that sheet ($700.00 = 0.125 % of the loan — the record's own figure, not a typed one); 20.4's lock-day solve is the quote 27.2 registers at delivery.
  const priced = await j.tool(scope, "20.4", "solvePassThrough", { inputs: jj.QUOTE_INPUTS, quote_id: `${jj.QUOTE}-lock`, purpose: "lead_quote", partner_id: j.PARTNER_ID, lead_id: j.leadId }, PRICING);
  assert.equal(priced.output["outcome"], "priced", JSON.stringify(priced.output).slice(0, 300)); assert.equal(priced.output["lender_credit_cents"], "70000");
  const creditPct = ((Number(priced.output["lender_credit_cents"]) / 56_000_000) * 100).toFixed(3); const sheetPrice = rallyPrices.find((p) => p.note_rate_pct === "6.125")!.price;
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
const WAREHOUSE_A: Actor = { kind: "agent", id: "warehouse" }; const INVESTOR_A: Actor = { kind: "agent", id: "investor-reporting" };
/** 27.2's runtime-wide FAKE ports (the Purchase Advice Sellers API and the collection bank) the fixtures queue on. */
const settlementFakes = (): { advices: FakePurchaseAdviceApi; bank: FakeCollectionBank } => { const s = runtime.originationServices.vendor("settlement") as SettlementServices; return { advices: s.advices as FakePurchaseAdviceApi, bank: s.collectionBank as FakeCollectionBank }; };
/** SOFR 4.30% flat on the federal business days of the fixture window (27.1's index, 1 business-day lookback; Nov 11 is a federal holiday). */
const SOFR_430 = ["2026-11-06", "2026-11-09", "2026-11-10", "2026-11-12", "2026-11-13", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"].map((d) => ({ publication_date: d, rate_bps: 430 }));
const ACCRUAL_DAYS = ["2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17", "2026-11-18"];
/** 27.1's daily accrual over the advance (the sweep's 27.1 cycle; here as `warehouse`): 7 days Nov 12–18 on $548,800.00 at SOFR 4.30% + 250 bps = $725.64 (27.1 fixture A). */
async function accrueAdvance(j: Journey, days: readonly string[]): Promise<{ advance_id: string; facility_id: string }> {
  const adv = (await events(j.appId, "warehouse.advance.funded")).at(-1)!; assert.ok(adv, "27.1's advance funded"); const advance_id = String(adv.payload["advance_id"]); const facility_id = String(adv.payload["facility_id"]);
  for (const d of days) { clock.set(EST(d, "18:00")); await j.tool({ app: j.appId }, "27.1", "accrueInterest", { advance_id, facility_id, accrual_date: d, sofr: SOFR_430 }, WAREHOUSE_A); }
  return { advance_id, facility_id };
}
/** The FAKE Sellers API's advice for the loan — worked example A at the commitment's 101.125: principal $566,300.00, interest −$1,096.67 (12 days to the Dec 1 LPI at 5.875%, 30/360), LLPA $700.00, net $564,503.33, purchase date Thu Nov 19. */
function fnmaAdvice(fnma: string, sln: string, over: Partial<RawPurchaseAdvice> = {}): RawPurchaseAdvice {
  const a = { fnma_loan_number: fnma, seller_loan_number: sln, fnma_servicer_number: "123456789", commitment_id_fnma: "BE-2026-11-0001", advice_date: D("2026-11-19"), purchase_date: D("2026-11-19"), purchase_ready_date: D("2026-11-16"), remittance_type: "aa" as const, note_rate: "0.06125", pass_through_rate: "0.05875", servicing_fee_bps: 25, lpi_date: D("2026-12-01"),
    interest_days: 12, interest_direction: "due_fannie_mae" as const, interest_cents: 109_667n, upb_cents: 56_000_000n, price: "101.125", gross_price_proceeds_cents: 56_630_000n, llpa_items: [{ code: "LCOR_760_779_60_01_70", pct: "0.125", cents: 70_000n }], llpa_total_cents: 70_000n, other_fees_cents: 0n, net_proceeds_cents: 56_450_333n,
    payee_code: "SMWH1", wire_nickname: "SM WAREHOUSE", source: "purchase_advice_api_sellers" as const, ...over };
  return { ...a, raw_json: JSON.stringify({ fnma_loan_number: a.fnma_loan_number, seller_loan_number: a.seller_loan_number, advice_date: a.advice_date, net_proceeds: "564503.33" }) };
}
/** The collection bank's credit of the advice's net on the purchase date, referenced by both loan numbers. */
const bankCredit = (fnma: string, sln: string, R: string, amountCents: bigint) => ({ bank_ref: `FEDW-20261119-${R}`, value_date: D("2026-11-19"), amount_cents: amountCents, originator_name: "Fannie Mae", reference_text: `WHOLE LOAN PURCHASE ${fnma} ${sln}`, account_ref: FACILITY_FIXTURE.collection_account_ref, received_at: EST("2026-11-19", "14:00") });
/** A second journey through T8–T10's passes to `certified` (the FAKE settlement agent's final statement, the hand-off, the delivery gate, the frozen package, the operator's submission, the eVault's certification). */
async function driveToCertified(j: Journey): Promise<Journey> {
  const appId = j.appId;
  try { await driveTo(j, "wire_released"); } catch (e) {
    const du = (await events(appId)).filter((x) => x.type.startsWith("du.")).map((x) => ({ type: x.type, at: x.occurred_at, actor: `${x.actor_kind}:${x.actor_id}`, offer: x.payload["value_acceptance_offer"] ?? null, rec: x.payload["recommendation"] ?? null }));
    const dec = (await decisions(appId)).filter((d) => d.agent === "underwriter" || d.action.toLowerCase().includes("du") || d.action.includes("Casefile") || d.action.includes("Findings")).map((d) => `${d.agent}:${d.action}`);
    const sel = (await events(appId, "valuation.method.selected")).map((x) => ({ at: x.occurred_at, method: x.payload["method"], why: x.payload["rationale"] ?? x.payload["exclusions"] ?? null }));
    const jl = (await journal(appId)).slice(-10).map((x) => [x.step, x.kind, x.command_process, x.command_name, x.error_class, x.refusal_code, x.detail["message"] ?? x.detail["reason"] ?? x.detail["gap"] ?? null]);
    throw new Error(`driveToCertified(${j.R}) failed in driveTo: ${(e as Error).message}\n du=${JSON.stringify(du)}\n decisions=${JSON.stringify(dec)}\n selected=${JSON.stringify(sel)}\n journal=${JSON.stringify(jl)}\n clock=${clock.now()}`);
  }
  const tail = async () => JSON.stringify((await journal(appId)).slice(-8).map((x) => [x.step, x.kind, x.command_process, x.command_name, x.error_class, x.refusal_code, x.detail["message"] ?? x.detail["reason"] ?? x.detail["gap"] ?? null]));
  clock.set(EST("2026-11-12", "13:01")); await reviewers.tick(runtime, clock.now());
  clock.set(EST("2026-11-12", "13:05")); await pass(clock.now(), appId);
  assert.ok((await row(appId)).loan_id, `driveToCertified: the hand-off ran ${await tail()}`);
  await complianceAt(j, MST("2026-11-13", "09:30"), "SM_O61_COMPLIANCE_PASS_DELIVERY_GATE", "cd");
  clock.set(MST("2026-11-13", "10:05")); await pass(clock.now(), appId);
  clock.set(EST("2026-11-16", "13:31")); await pass(clock.now(), appId);
  assert.equal((await row(appId)).step, "certified", `driveToCertified: ${await tail()}`);
  return j;
}
const OPS_ANALYST: Actor = { kind: "human", id: "u-ops-1", role: "ops_analyst" };
/** A journey whose CD receipts are recorded Wed Nov 4 (earliest consummation Mon Nov 9) with the closing still Fri Nov 6: 25.2's REGZ_1026_19F1_CD_3SBD_GATE answers closed when the pass reaches `documents_released` on Nov 4 (T14). */
async function driveToGateClosed(j: Journey): Promise<Journey> {
  const appId = j.appId; const scope = { app: appId };
  await seedCreditAuthorizations(j);
  clock.set(MST("2026-10-05", "17:50")); await pass(clock.now(), appId);
  await verifyIdentitiesAndValue(j);
  clock.set("2026-10-07T18:00:00.000Z"); await pass(clock.now(), appId);
  await titleAndInsurance(j);
  clock.set("2026-10-28T16:00:00.000Z"); await clearConditionsThrough233(j, { stale: 0 }); await pass(clock.now(), appId);
  clock.set("2026-10-28T16:00:25.000Z"); await reviewers.tick(runtime, clock.now()); await pass(clock.now(), appId);
  assert.equal((await row(appId)).step, "clear_to_close", `driveToGateClosed: ${JSON.stringify((await journal(appId)).slice(-5).map((x) => [x.step, x.kind, x.command_name, x.error_class, x.detail["message"] ?? x.detail["reason"] ?? x.detail["gap"] ?? null]))}`);
  await seedEsignConsents(j); await closingPrereqs(j); await j.scheduleClosing(); await complianceAtCd(j, MST("2026-11-02", "08:30"));
  clock.set(MST("2026-11-02", "09:00")); await pass(clock.now(), appId);
  const cd = (await entitiesOf("disclosures", appId)).find((d) => d.data["kind"] === "cd")!; assert.ok(cd, "driveToGateClosed: the CD rendered");
  await valuationCopy(j);
  // the consumers acknowledge only on Wed Nov 4 08:30 MST: 25.2's earliest consummation moves to Mon Nov 9 while the closing stays Fri Nov 6
  clock.set(MST("2026-11-04", "08:30"));
  for (const c of ["B1", "B2"]) await j.tool(scope, "25.2", "recordReceipt", { disclosure_id: cd.id, consumer_id: c, evidence: "esign_confirmed", at: MST("2026-11-04", "08:30"), evidence_document_id: `DOC-ESIGN-${c}-${j.R}` }, { kind: "agent", id: "disclosure" });
  clock.set(MST("2026-11-04", "08:31")); await pass(clock.now(), appId);
  clock.set(MST("2026-11-04", "09:00")); await pass(clock.now(), appId);
  return j;
}
/** A second Runtime over the same database on the demo clock (35.3 rule 10 / T19): an OffsetClock over a fixed base instant, the same registry, FAKE reviewers and logger. */
function demoRuntimeAt(nowIso: string): { rt: Runtime; clock: OffsetClock } {
  const offset = new OffsetClock(new FixedClock(nowIso));
  return { rt: new Runtime({ db, registry: loadOverriddenRegistry(), clock: offset, reviewers, logger }), clock: offset };
}
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
/** The partner's haircut reserve as the ledger carries it (27.1 SM_WH_HAIRCUT_RESERVE_GATE reads the balance of `partner_haircut_reserve` on the facility's reserve bank account, `FACILITY_FIXTURE.haircut_reserve_account_ref`): the LSA fixture's $250,000.00 deposit, posted once per platform (idempotent) by an officer through 2.1 ledger.post — Cr the reserve account / Dr the SM funding account, both custodial rows keyed as the pass keys 27.1's references (custodialAccountIdFor). In-process, so the cents stay bigint. */
async function fundHaircutReserve(j: Journey | PurchaseJourney): Promise<void> {
  const reserveId = custodialAccountIdFor(FACILITY_FIXTURE.haircut_reserve_account_ref); const fundingId = custodialAccountIdFor(FACILITY_FIXTURE.funding_account_ref); const collectionId = custodialAccountIdFor(FACILITY_FIXTURE.collection_account_ref);
  for (const [id, kind] of [[reserveId, "partner_haircut_reserve"], [fundingId, "sm_funding_cash"], [collectionId, "sm_collection_cash"]] as const) await db.query(`INSERT INTO custodial_accounts (id, partner_party_id, kind, remittance_type) VALUES ($1, $2, $3, 'A/A') ON CONFLICT (id) DO NOTHING`, [id, partnerPartyId, kind]);
  const memo = `LSA haircut reserve deposit ${FACILITY_FIXTURE.facility_id}`;
  if ((await db.query(`SELECT 1 FROM ledger_lines WHERE account = 'partner_haircut_reserve' AND custodial_account_id = $1 AND memo = $2`, [reserveId, memo])).length) return;
  await runtime.execute({ process: "2.1", name: "ledger.post", loanId: "", actor: OFFICER, input: { entry_set: { effectiveDate: "2026-11-02", description: "LSA haircut reserve: partner deposit (fixture)", lines: [
    { account: { scope: "custodial", custodialAccountId: reserveId, account: "partner_haircut_reserve" }, amountCents: -25_000_000n, ruleRef: "27.1 LSA haircut reserve", memo },
    { account: { scope: "custodial", custodialAccountId: fundingId, account: "sm_funding_cash" }, amountCents: 25_000_000n, ruleRef: "27.1 LSA haircut reserve", memo }] } } });
  assert.equal(await n(`FROM ledger_lines WHERE account = 'partner_haircut_reserve' AND custodial_account_id = $1 AND memo = $2`, [reserveId, memo]), 1, "the reserve deposit is a ledger_lines row on the facility's reserve account");
  void j;
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
const COPY_RECIPIENT = (partyId: string, name: string, email: string) => ({ partyId, name, mailingAddress: "100 N Central Ave, Phoenix AZ 85004", email, consent: { party_id: partyId, classes: ["origination_decisions", "disclosures.origination", "flood_notice"], disclosure_version: "esign-2026-09", status: "active", consented_on: "2026-10-05", soft_bounces_30d: 0 } });
async function valuationCopy(j: Journey): Promise<void> {
  const scope = { app: j.appId }; const APPRAISAL = `APR-${j.R}`;
  clock.set(MST("2026-11-02", "14:20"));
  await j.tool(scope, "24.2", "ingestReport", { appraisal_id: APPRAISAL, version_no: 1, package: APPRAISAL_PACKAGE, appraised_value_cents: "80000000", effective_date: "2026-11-01", appraiser_party_id: APPRAISER, received_at: MST("2026-11-02", "14:20"), valuation_order_id: j.valuationOrderId }, VALUATION);
  clock.set(MST("2026-11-02", "15:05"));
  await j.tool(scope, "24.2", "submitUcdp", { appraisal_id: APPRAISAL, version_no: 1, package_hash: `sha256:appraisal-r-${j.R}-v1` }, VALUATION);
  clock.set(MST("2026-11-02", "15:07"));
  const polled = await j.tool(scope, "24.2", "pollFindings", { appraisal_id: APPRAISAL, version_no: 1 }, VALUATION);
  assert.equal((polled.output["routing"] as { route: string }).route, "successful", JSON.stringify(polled.output["routing"]));
  clock.set(MST("2026-11-03", "09:00"));
  await j.tool(scope, "24.2", "applyReviewChecklist", { appraisal_id: APPRAISAL, version_no: 1, checklist: APPRAISAL_CHECKLIST, transaction_type: "refinance", loan_amount_cents: "56000000", consummation_on: "2026-11-06" }, VALUATION);
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

// ═══════════════════════════ the OH purchase fixture (worked example B; T16/T17): wet state, paper note, hybrid closing ═══════════════════════════
/** 26.3's `wetFundsAtTableGate` over the record's facts (the evaluator the timer engine runs for SM_O73_WET_FUNDS_AT_TABLE_GATE). */
const ohChain: { j: PurchaseJourney | null } = { j: null };
const CLOSER_A: Actor = { kind: "agent", id: "title-closing" }; const FUNDER_A: Actor = { kind: "agent", id: "funder" }; const ESCROW_A: Actor = { kind: "agent", id: "escrow" };
/** The platform's document custodian (the partner's Form 2017 FCC as SM's bailee — 26.2's default custodian, 27.1's bailee, 29.4's custodian): one `parties` row of type `custodian` per platform (FAKE). */
async function seedCustodian(): Promise<string> {
  const have = await db.query<{ id: string }>(`SELECT id::text AS id FROM parties WHERE party_type = 'custodian' ORDER BY created_at LIMIT 1`);
  if (have[0]) return have[0].id;
  return (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number) VALUES ('custodian', 'FAKE document custodian (Form 2017 FCC)', '900000017') RETURNING id::text AS id`))[0]!.id;
}
/** journey-purchase.ts over this file's runtime: the Columbus, OH purchase ($412,000 at 6.375%, HomeReady, the Wed Nov 18 10:05 ET session) — the borrowers' parties linked as the borrower API's sign-in would link them. */
async function newOhJourney(): Promise<PurchaseJourney> {
  const j = new PurchaseJourney({ runtime, db, base, token: TOKEN, clock, borrowerEmail: `casey.${randomUUID().slice(0, 8)}@example.test`, coBorrowerEmail: `riley.${randomUUID().slice(0, 8)}@example.test`, partnerPartyId, settle,
    linkParties: async (appId) => { const rows = await db.query<{ id: string; legal_name: string | null }>(`SELECT id::text AS id, legal_name FROM application_borrowers WHERE application_id = $1 ORDER BY created_at, id`, [appId]); for (const [k, r] of rows.entries()) { const party = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name) VALUES ('borrower', $1) RETURNING id`, [r.legal_name ?? (k === 0 ? j.A : j.B)]))[0]!.id; await db.query(`UPDATE application_borrowers SET party_id = $2 WHERE id = $1`, [r.id, party]); } } });
  await seedWireInstruction(); await seedAporTables(); await seedCustodian();
  return j;
}
/** 32.2's rows the fixture's bus path does not write (journey-purchase.ts gaps 1 and 2; the refi fixture seeds the same rows): the subject property once the contract names it, the borrowers' standing blanket authorizations and E-SIGN consents, 22.2's hard-application credit authorization. */
async function seedOhRecord(j: PurchaseJourney): Promise<void> {
  const app = j.appId;
  const prop = await db.query<{ id: string }>(`SELECT id::text AS id FROM application_properties WHERE application_id = $1 AND is_subject ORDER BY created_at LIMIT 1`, [app]);
  if (prop[0]) await db.query(`UPDATE application_properties SET address_line1 = '1187 Oakwood Ave', city = 'Columbus', state = 'OH', postal_code = '43206', county = 'Franklin', property_type = 'sfr', units = 1, estimated_value_cents = 45780000 WHERE id = $1`, [prop[0].id]);
  else await db.query(`INSERT INTO application_properties (application_id, address_line1, city, state, postal_code, county, property_type, units, estimated_value_cents, is_subject) VALUES ($1, '1187 Oakwood Ave', 'Columbus', 'OH', '43206', 'Franklin', 'sfr', 1, 45780000, true)`, [app]);
  const rows = await db.query<{ id: string; party_id: string | null }>(`SELECT id::text AS id, party_id::text AS party_id FROM application_borrowers WHERE application_id = $1 ORDER BY created_at, id`, [app]);
  for (const r of rows) {
    await db.query(`INSERT INTO consents (id, kind, granted, provenance, verified, captured_at, scope, status, captured_via, application_id, party_id, purpose, standing) VALUES ($1, 'blanket_verification_authorization'::consent_kind, true, 'portal', true, $2, '{income,assets}'::text[], 'active', 'portal', $3, $4, 'informational', true)`, [randomUUID(), EDT("2026-10-19", "18:47"), app, r.party_id]);
    await db.query(`INSERT INTO consents (id, kind, granted, provenance, verified, captured_at, scope, status, captured_via, application_id, party_id, purpose, hw_sw_version, standing) VALUES ($1, 'esign'::consent_kind, true, 'portal', true, $2, '{disclosures,notices,closing_package,esign_signatures}'::text[], 'active', 'portal', $3, $4, 'informational', '2026.1', true)`, [randomUUID(), EDT("2026-10-19", "18:47"), app, r.party_id]);
  }
  await db.query(`INSERT INTO credit_authorizations (authorization_id, application_id, kind, party_id, text_version, text_version_hash, signature_kind, captured_at, channel, evidence, permissible_purpose, end_user, consumer_initiated) VALUES ($1, $2, 'hard_application', $3, 'hard-application-2026-09', $4, 'esign_click_typed_name', $5, 'portal', $6::jsonb, 'consumer_initiated_credit_transaction_1681b_a3A', 'partner', true)`,
    [randomUUID(), app, rows[0]!.party_id, "b".repeat(64), EDT("2026-10-20", "09:04"), JSON.stringify({ certification_ref: "CERT-PARTNER-1681E-2026", subscriber_code: "SUB-PARTNER-0417", authorization_ref: `AUTH-HARD-${j.R}` })]);
}
/** 21.1's restricted demographics per application borrower (the interview's HMDA questions; the only demographics table 30.2 reads): A self-reported, B not provided — as the refi fixture seeds them. */
async function seedOhDemographics(j: PurchaseJourney): Promise<void> {
  const at = EDT("2026-10-19", "18:48");
  await db.query(`INSERT INTO restricted_fl.applicant_demographics (application_borrower_id, ethnicity, race, sex, age, declined_ethnicity, declined_race, declined_sex, visual_observation_used, collection_channel, collected_at) VALUES ($1, $2::jsonb, $3::jsonb, $4, $5, false, false, false, false, 'internet', $6)`, [j.abIds[0], JSON.stringify(["not_hispanic_or_latino"]), JSON.stringify(["asian"]), "female", 35, at]);
  await db.query(`INSERT INTO restricted_fl.applicant_demographics (application_borrower_id, ethnicity, race, sex, age, declined_ethnicity, declined_race, declined_sex, visual_observation_used, collection_channel, collected_at) VALUES ($1, NULL, NULL, NULL, $2, true, true, true, false, 'internet', $3)`, [j.abIds[1], 34, at]);
}
/** 28.3's HMDA record and ULI for the OH purchase (29.3's ULDD reads `hmda.uli.assigned{uli}`). */
async function seedOhHmda(j: PurchaseJourney): Promise<void> {
  const scope = { app: j.appId }; const lei = "5493001KJTIIGC8Y1R12"; const sequence = Number(BigInt(`0x${j.appId.replace(/-/g, "").slice(0, 6)}`) % 900000n) + 1;
  await j.tool(scope, "28.3", "createRecord", { partner_id: j.PARTNER_ID, lei, sequence, application_date: "2026-10-19", transaction_type: "purchase", occupancy: "primary", loan_amount_cents: "41200000", property_type: "sfr", total_units: 1, nmlsr_id: "123456", property: { street_address: "1187 Oakwood Ave", city: "Columbus", state: "OH", zip: "43206" } }, OFFICER);
  await j.tool(scope, "28.3", "assignUli", { partner_id: j.PARTNER_ID, lei, application_date: "2026-10-19", transaction_type: "purchase", sequence }, OFFICER);
}
/** 23.4 at the CD checkpoint for the OH purchase (the owner's staged run: APR–APOR spread for the Oct 26 rate set, points and fees from the CD's lines, ATR consider-and-verify from the record's evidence) — the `compliance.qm.determined` / `.hpml.determined` the hand-off snapshot reads; the pass re-runs the consummation stage after funding. */
async function ohQmAtCd(j: PurchaseJourney): Promise<void> {
  const scope = { app: j.appId }; clock.set(EST("2026-11-13", "10:30"));
  const apr = await j.tool(scope, "25.1", "computeApr", { loan_amount_cents: "41200000", note_rate_pct: "6.375", term_months: 360, term_start_date: "2026-11-18", first_payment_date: "2027-01-01", prepaid_finance_charges_cents: "106848", prepaid_interest_cents: "93548", checkpoint: "cd" }, COMPLIANCE);
  const reportId = (await db.query<{ id: string }>(`SELECT id FROM entity_current WHERE kind = 'credit_reports' AND data->>'application_id' = $1 ORDER BY updated_at LIMIT 1`, [j.appId]))[0]?.id ?? "CR-P-1";
  const kindOf = (section: string): string => (section === "E_taxes_gov" ? "public_official" : section === "A_origination" || section === "F_prepaids" || section === "G_escrow" ? "creditor" : "third_party");
  const cdFees = j.CD_FEES() as { fee_code: string; description: string; amount_cents: string; section: string }[];
  const fees = [...cdFees.map((f) => { const kind = kindOf(f.section); const payee = kind === "creditor" ? "Partner Bank, N.A." : kind === "public_official" ? "Franklin County Recorder" : f.fee_code.startsWith("title") || f.fee_code === "settlement_fee" || f.fee_code === "owners_title_policy" ? "Buckeye Title Agency LLC" : `${f.fee_code} vendor`; return { fee_item_id: `F-${f.fee_code}`, service_code: f.fee_code === "prepaid_interest" ? "interest_prepaid" : f.fee_code, description: f.description, amount_cents: f.amount_cents, paid_to: payee, paid_to_kind: kind, payee, ...(kind === "third_party" ? { affiliate: false, reasonable: true } : {}) }; }), { fee_item_id: "F-PPI", service_code: "interest_prepaid", description: "Prepaid interest Nov 18–30 (13 × $71.96)", amount_cents: "93548", paid_to: "Partner Bank, N.A.", paid_to_kind: "creditor", payee: "Partner Bank, N.A." }];
  const ev = (kind: string, id: string, source_process: string) => ({ kind, id, source_process });
  const considerVerify = assembleAtrEvidence({
    income: { monthly_cents: 820_000n, evidence: [ev("paystub", `DOC-PAY-P-${j.R}`, "22.3"), ev("du_validation_income_report", `DUV-INC-P-${j.R}`, "22.3")], standard_ref: "SG-2020-06-03/B3-3.1-01 ≡ SG-2026-09-02/B3-3.2-01" },
    employment: { status: "employed_w2", evidence: [ev("vvoe", `VVOE-P-${j.R}`, "22.3")], standard_ref: "SG-2020-06-03/B3-3.1-04 ≡ SG-2026-09-02/B3-3.1-04" },
    payment: { pi_cents: 257_034n, basis: "note_rate_fully_amortizing", evidence: [ev("le_projected_payments", `LE-P-${j.R}`, "21.2")] },
    simultaneous_loans: { monthly_cents: 0n, evidence: [ev("credit_report", reportId, "22.5")], standard_ref: "SG-2020-06-03/B3-6-02" },
    mortgage_obligations: { monthly_cents: 74_547n, evidence: [ev("escrow_estimate", `LE-P-${j.R}`, "21.2"), ev("hoi_declaration", `HOI-P-${j.R}`, "24.5")], standard_ref: "SG-2020-06-03/B3-6-03" },
    debts: { monthly_cents: 41_027n, alimony_child_support_cents: 0n, evidence: [ev("credit_report", reportId, "22.5")], standard_ref: "SG-2020-06-03/B3-6-05" },
    dti: { pct: "45.44", evidence: [ev("dti_worksheet", `DTI-P-${j.R}`, "22.5")], standard_ref: "SG-2020-06-03/B3-6-02" },
    credit_history: { report_id: reportId, pulled_at: D("2026-10-20"), standard_ref: "SG-2020-06-03/B3-5.3-01" } });
  const r = await j.tool(scope, "23.4", "runQmTests", { op: "stage", stage: "cd", apr: apr.output["apr_disclosed_str"], apr_calculation_id: apr.output["apr_calculation_id"], loan_amount_cents: "41200000", locks: [{ lock_id: j.lockId, kind: "initial", locked_at: EDT("2026-10-26", "10:19"), rate_pct: "6.375", product: "fixed", term_years: 30 }], apor_tables: APOR_TABLES(), fee_items: fees, product: { term_months: 360, amortization: "fully_amortizing", substantially_equal_payments: true, arm: null }, consider_verify: considerVerify, state: "OH", county: "Franklin" }, COMPLIANCE);
  assert.ok(r.output, "23.4 staged run");
}
const OH_HOLDERS = (j: PurchaseJourney) => [j.A, j.B];
const OH_CLAUSE = "Partner Bank, its successors and/or assigns, c/o Supermortgage, P.O. Box 7900, Phoenix AZ 85011";
/** 24.5 for the OH purchase: the requirement from DU's findings, the Zone X determination (no flood insurance), the adequate hazard policy effective Nov 18 ($1,140.00/yr — the CD's $95.00/month), as title-closing. */
async function ohInsurance(j: PurchaseJourney): Promise<void> {
  const scope = { app: j.appId }; const R = j.R;
  clock.set(EST("2026-11-02", "10:00"));
  await j.tool(scope, "24.5", "computeInsuranceRequirements", { computed_at: clock.now(), facts: { computed_from: "du_findings", property: { units: 1, project_type: "detached" }, hazard: { coverage_dwelling_cents: "45000000" }, flood: { note_amount_cents: "41200000" } } }, CLOSER_A);
  clock.set(EST("2026-11-02", "10:10"));
  await j.tool(scope, "24.5", "orderFloodDetermination", { property_id: `PROP-OH-${R}`, address_hash: `sha256:oh-1187-oakwood-${R}`, fee_gate_result: "open", ordered_at: clock.now() }, CLOSER_A);
  clock.set(EST("2026-11-02", "11:30"));
  await j.tool(scope, "24.5", "parseSFHDF", { sfhdf: { certificate_id: `SFHDF-X-${R}`, zone: "X", map_panel: "39049C0336K", map_date: "2019-06-17", community_number: "390170", community_name: "City of Columbus", community_participating: true, program_status: "regular", structures: [{ kind: "principal", in_sfha: false, zone: "X" }], lol_purchased: true, sfhdf_form_version: "FF-206-FY-21-116", sfhdf_document_id: `DOC-SFHDF-OH-${R}`, vendor_ref: `CTL-OH-${R}` }, received_at: clock.now() }, CLOSER_A);
  clock.set(EST("2026-11-02", "12:00"));
  const policy = { policy_id: `HZ-OH-${R}`, policy_kind: "hazard", policy_number: `HO-OH-2210-${R.slice(0, 4)}`, carrier: "Buckeye Mutual", coverage_dwelling_cents: "45000000", coverage_basis: "replacement_cost", roof_basis: "replacement_cost", coverage_form: "special", deductible_cents: "250000", per_peril_deductibles: [], ratings: [{ agency: "am_best", grade: "A" }], mortgagee_clause_text: OH_CLAUSE, named_insureds: OH_HOLDERS(j), effective_date: "2026-11-18", expiration_date: "2027-11-18", first_year_premium_cents: "114000", policy_in_force: true, premium_paid_at_closing: true, premium_on_cd: true, premium_paid_through: "2027-11-18", evidence_kind: "declarations", evidence_document_id: `DOC-HZ-OH-${R}` };
  const ad = await j.tool(scope, "24.5", "evaluateAdequacy", { policy, title_holders: OH_HOLDERS(j), partner: { legal_name: "Partner Bank" }, transaction_type: "purchase", disbursement_date: "2026-11-18", verified_at: clock.now() }, CLOSER_A);
  assert.equal(ad.output["status"] ?? ad.output["result"] ?? "verified", ad.output["status"] ?? ad.output["result"] ?? "verified", JSON.stringify(ad.output).slice(0, 300));
}
/** 30.3 for the OH purchase (30.2 worked example 2's escrow: county taxes $520.00 + hazard $95.00 = $615.00/month; the aggregate deposit $1,240.00 — the Franklin County bills as known bills, the hazard declarations), approved as `escrow`. */
async function ohEscrowAnalysis(j: PurchaseJourney): Promise<void> {
  const scope = { app: j.appId }; const R = j.R;
  clock.set(EST("2026-11-03", "09:00"));
  await j.tool(scope, "30.3", "buildEscrowLines", { op: "build", first_payment_date: "2027-01-01", parcel: { apn: j.APN, state: "OH", county: "Franklin", annual_cents: "624000", basis: "known_bill", installments: [{ tax_year: 2026, installment_no: 1, amount_cents: "370000", due_on: "2027-06-01", penalty_on: "2027-06-30" }, { tax_year: 2026, installment_no: 2, amount_cents: "254000", due_on: "2027-12-01", penalty_on: "2027-12-31" }, { tax_year: 2027, installment_no: 1, amount_cents: "370000", due_on: "2028-06-01", penalty_on: "2028-06-30" }, { tax_year: 2027, installment_no: 2, amount_cents: "254000", due_on: "2028-12-01", penalty_on: "2028-12-31" }] }, policies: [{ policy_number: `HO-OH-2210-${R.slice(0, 4)}`, kind: "hazard", first_year_premium_cents: "114000", premium_paid_through: "2027-11-18", renewal_invoice_due_on: "2027-10-19", required_by_creditor: true }] }, ESCROW_A);
  const ran = await j.tool(scope, "30.3", "buildEscrowLines", { op: "run_analysis", analysis_id: `EA-P-${R}`, first_payment_date: "2027-01-01", settlement_date: "2026-11-18", disbursement_date: "2026-11-18", pi_cents: "257034" }, ESCROW_A);
  const a = (ran.output["analysis"] ?? ran.output) as P;
  assert.equal(String(a["base_payment_cents"] ?? (ran.output["base_payment_cents"] as unknown)), "61500", JSON.stringify(ran.output).slice(0, 600));
  assert.equal(String(a["target_at_start_cents"] ?? (ran.output["target_at_start_cents"] as unknown)), "124000", `30.3's aggregate deposit is the CD's $1,240.00: ${JSON.stringify(ran.output).slice(0, 600)}`);
  await j.tool(scope, "30.3", "buildEscrowLines", { op: "approve_analysis", analysis_id: `EA-P-${R}`, reviewed: true, rationale: "engine analysis within the (c)(5) cap; the county's known bills and the hazard declarations" }, ESCROW_A);
}
/** 22.3's verbal VOE for both borrowers inside 10 business days of the Nov 18 note date, and 22.2's soft refresh inside the pre-closing window (the funding conditions FC_VVOE / FC_CREDIT_REFRESH read them). */
async function ohVvoeAndRefresh(j: PurchaseJourney): Promise<void> {
  const scope = { app: j.appId }; const at = EST("2026-11-16", "12:00"); clock.set(at);
  for (const b of ["B1", "B2"]) await j.tool(scope, "22.3", "orderVerificationReport", { op: "du_validation", borrower_id: b, component: "employment", outcome: "validated", report_reference_id: `TRUV-FAKE-P-${j.R}-${b}`, supplier_code: "TRUV", employer_name: "Scioto Logistics (FAKE payroll)", close_by_date: "2027-01-15", message_date: "2026-11-16", note_date: "2026-11-18" }, VERIFICATION);
  clock.set(EST("2026-11-16", "12:10"));
  await j.tool(scope, "22.2", "orderRefresh", { permissible_purpose: "credit_transaction_604a3A", certification_ref: "CERT-PARTNER-1681E-2026", borrower_authorization_ref: `AUTH-HARD-${j.R}`, subscriber_code: "SUB-PARTNER-0417", scheduled_consummation_date: "2026-11-18", at: clock.now() }, VERIFICATION);
}
/** 25.1's own run at a checkpoint gate over the OH fixture's full snapshot (the CD's fees by payee, the FFIEC table for the Oct 26 rate set, the OH licenses, LO comp, steering, pricing at 101.000, RESPA §8 evidence, the E-SIGN consent, the NMLSR blocks) — the fresh run the pass's 25.2 `assertGateOpen` reuses (GATES[gate].freshness_hours). */
async function ohComplianceAt(j: PurchaseJourney, at: string, gate: string, disclosureClass = "cd"): Promise<void> {
  const scope = { app: j.appId }; clock.set(at); const d = at.slice(0, 10);
  const apr = await j.tool(scope, "25.1", "computeApr", { loan_amount_cents: "41200000", note_rate_pct: "6.375", term_months: 360, term_start_date: "2026-11-18", first_payment_date: "2027-01-01", prepaid_finance_charges_cents: "106848", prepaid_interest_cents: "93548", checkpoint: "cd" }, COMPLIANCE);
  const kindOf = (section: string): string => (section === "E_taxes_gov" ? "public_official" : section === "A_origination" || section === "F_prepaids" || section === "G_escrow" ? "creditor" : "third_party");
  const payee = (code: string, kind: string): string => (kind === "creditor" ? "Partner Bank, N.A." : kind === "public_official" ? "Franklin County Recorder" : code.startsWith("title") || code === "settlement_fee" || code === "owners_title_policy" ? "Buckeye Title Agency LLC" : code === "appraisal" ? "Ohio Valley AMC" : code === "credit_report" ? "CreditCo" : code === "flood_cert" ? "FloodCo" : code === "tax_service" ? "TaxServ Inc" : code === "mers_enote" ? "MERSCORP Holdings" : "Buckeye Title Agency LLC");
  const cdFees = j.CD_FEES() as { fee_code: string; description: string; amount_cents: string; section: string }[];
  const items = [...cdFees.map((f) => { const kind = kindOf(f.section); return { fee_item_id: `F-${f.fee_code}`, service_code: f.fee_code === "prepaid_interest" ? "interest_prepaid" : f.fee_code, amount_cents: f.amount_cents, paid_to: payee(f.fee_code, kind), paid_to_kind: kind, ...(kind === "creditor" && f.fee_code !== "prepaid_interest" ? { creditor_retains_portion: true } : {}), ...(f.fee_code === "tax_service" ? { creditor_requires_service: true } : {}), ...(f.fee_code === "appraisal" ? { paid_by: "sm" } : {}) }; }), { fee_item_id: "F-ESC", service_code: "escrow_deposit", amount_cents: "124000", paid_to: "Partner Bank, N.A.", paid_to_kind: "creditor" }];
  if (!items.some((f) => f.service_code === "interest_prepaid")) items.push({ fee_item_id: "F-INT", service_code: "interest_prepaid", amount_cents: "93548", paid_to: "Partner Bank, N.A.", paid_to_kind: "creditor" });
  const providers = [...new Set(items.filter((f) => f.paid_to_kind === "third_party").map((f) => f.paid_to))];
  const evidence = providers.map((p, k) => ({ paid_to: p, service_performed_at: "2026-11-02T17:00:00.000Z", report_id: `RPT-P-${j.R}-${k + 1}` }));
  const snapshot = { application_id: j.appId, loan_id: null, as_of: d, property_state: "OH", property_county: "Franklin", lien_position: "first", occupancy: "primary", loan_amount_cents: 41_200_000n, note_rate_pct: "6.375", term_months: 360, rate_set_date: "2026-10-26",
    apr: { actual: apr.output, disclosed_apr: apr.output["apr_disclosed_str"], disclosed_finance_charge_cents: apr.output["finance_charge_cents"], transaction: { irregular_first_period: true } },
    fees: { items: items.map((f) => ({ ...f, amount_cents: BigInt(f.amount_cents) })), benchmarks: [] }, apor_tables: [{ table_date: "2026-10-26", term_years: 30, product: "fixed", apor_pct: "6.020" }], treasury_yield_pct: "4.10", prepayment_penalty: null, escrow_established: true,
    jurisdiction: { high_cost_statute: null, branch_licensed_state: false, third_party_processor_license_required: false, ai_disclosure_required: false },
    tolerance: { result: "pass", tolerance_test_id: `TT-P-${j.R}`, message: "21.5: no tolerance violation" },
    licenses: { checks: [{ check_id: `LC-CO-P-${j.R}`, party_type: "company", party_ref: "partner", nmls_id: "123456", state: "OH", license_type: "OH Residential Mortgage Lending Act certificate (R.C. 1322)", status: "approved", sponsorship_ok: null, checked_at: "2026-11-10", valid_through: "2027-12-31", source: "nmls_b2b", evidence_document_id: "DOC-LC-CO-OH" }, { check_id: `LC-MLO-P-${j.R}`, party_type: "individual", party_ref: "mlo-okonkwo", nmls_id: "987654", state: "OH", license_type: "OH Loan Originator", status: "approved", sponsorship_ok: true, checked_at: "2026-11-10", valid_through: "2027-12-31", source: "nmls_b2b", evidence_document_id: "DOC-LC-MLO-OH" }], mlo_fitness_attested: true },
    lo_comp_plan: { components: [{ kind: "salary" }, { kind: "flat_per_loan" }], passthrough_by_published_formula: true },
    steering: { record: { presented_at: EDT("2026-10-26", "10:00"), transaction_type: "purchase_30y_fixed", options: [{ kind: "lowest_rate", rate_pct: "6.375", points_fees_cents: 0n }, { kind: "lowest_rate_no_risky_features", rate_pct: "6.375", points_fees_cents: 0n }, { kind: "lowest_points_fees", rate_pct: "6.375", points_fees_cents: 0n }], consumer_choice: "lowest_rate", reason_if_not_lowest_rate: null }, lock_requested_at: EDT("2026-10-26", "10:05") },
    pricing: { locked_price: "101.000", rate_sheet_price: "101.000", review: null },
    respa8: { affiliates: [], referral_at: EDT("2026-10-19", "18:45"), afba_disclosures: [], service_evidence: evidence, msa_providers: [] },
    esign: { consent: { kind: "esign", granted_at: EDT("2026-10-19", "18:47"), withdrawn_at: null, scope: ["disclosures", "notices", "closing_package", "le", "cd", "corrected_cd", "consummation", "closing"], hw_sw_statement_version: "2026.1", access_demonstrated: true }, delivery_channel: "electronic", delivery_at: at, disclosure_class: disclosureClass },
    nmlsr_templates: ["1003", "le", "cd", "note", "security_instrument"].map((form) => ({ form, creditor_name: "Partner Bank, N.A.", creditor_nmlsr_id: "123456", mlo_name: "Ada Okonkwo", mlo_nmlsr_id: "987654" })),
    arbitration_clause_present: false, credit_insurance_financed: false, ai_disclosure_present: false };
  const r = await j.tool(scope, "25.1", "assertGateOpen", { gate, snapshot }, COMPLIANCE);
  assert.equal(r.output["open"], true, `${gate}: ${JSON.stringify(r.output).slice(0, 800)}`);
}
/** 25.4 for the OH purchase: the GLBA privacy gate and the closing-day package (the consummation_ready CD, 30.3's approved analysis, the HPA initial disclosure for the BPMI loan). */
async function ohClosingPackage(j: PurchaseJourney): Promise<void> {
  const scope = { app: j.appId }; clock.set(EST("2026-11-17", "10:00")); const consummationAt = EST("2026-11-18", "10:05");
  const borrowers = ["B1", "B2"].map((b) => ({ borrower_id: b, privacy_delivered_at: EDT("2026-10-19", "18:47"), customer: true }));
  const pg = await j.tool(scope, "25.4", "checkPrivacyNotice", { borrowers, consummation_at: consummationAt }, DISCLOSURE); assert.equal(pg.output["result"], "open", JSON.stringify(pg.output).slice(0, 300));
  const cd = (await entitiesOf("disclosures", j.appId)).find((d) => d.data["kind"] === "cd")!; assert.ok(cd, "the OH CD");
  const wp = (await events(j.appId, "disclosure.cd.waiting_period.computed")).filter((e) => e.payload["disclosure_id"] === cd.id && e.payload["earliest_consummation_date"]).at(-1); const cdReady = !!wp && String(wp.payload["earliest_consummation_date"]) <= "2026-11-18";
  const approved = (await entitiesOf("escrow_analyses", j.appId)).find((a) => a.data["status"] === "approved")!; assert.ok(approved, "30.3's approved analysis");
  // 30.3's freeze against the delivered CD version (the pass's cd_delivered act on the refi; the fixture's CD here — the row the statement, the package and 30.2's hand-off read)
  await j.tool(scope, "30.3", "buildEscrowLines", { op: "freeze", application_id: j.appId, analysis_id: approved.id, cd_version_id: cd.id }, ESCROW_A);
  const analysis = (await entitiesOf("escrow_analyses", j.appId)).find((a) => a.data["status"] === "frozen") ?? approved; const fig = { ...(analysis.data["cd_figures"] as P), ...(cd.data["figures"] as P) };
  const run = await j.tool(scope, "25.4", "composeClosingPackage", { run_id: `RUN-P-${j.R}`, agent_run_id: `AR-P-${j.R}`, consummation_at: consummationAt, property_state: "OH", transaction_type: "purchase", principal_dwelling_refinance: false, cd: { disclosure_id: cd.id, cd_version: Number(cd.data["cd_version"] ?? 1), status: cdReady ? "consummation_ready" : String(cd.data["status"]), escrow: { initial_escrow_payment_cents: String(fig["initial_escrow_payment_cents"] ?? analysis.data["target_at_start_cents"]), monthly_escrow_cents: String(fig["monthly_escrow_cents"] ?? analysis.data["base_payment_cents"]), escrowed_costs_year1_cents: String(fig["escrowed_costs_year1_cents"] ?? analysis.data["escrowed_costs_year1_cents"] ?? "0") } }, escrow_analysis: { analysis: analysis.data, approved_on: String(analysis.data["approved_on"] ?? "2026-11-03").slice(0, 10), rendered_document_id: `DOC-ESCROW-STMT-P-${j.R}` }, borrowers, hpa: { required: true, template: "NTC_HPA_4903_INITIAL_FIXED" }, flood_ack_required: false }, DISCLOSURE);
  assert.equal(run.output["status"], "gated", JSON.stringify(run.output).slice(0, 800)); await settle();
}
/** 26.2 Mon Nov 9 10:00: the closing scheduled for Wed Nov 18 10:05 ET as a HYBRID closing with a PAPER note (the eNote excluded; the borrowers' election) — 26.2's decision, not the fixture's assertion. */
async function ohScheduleHybridPaper(j: PurchaseJourney): Promise<void> {
  clock.set(EST("2026-11-09", "10:00"));
  const sch = await j.tool({ app: j.appId }, "26.2", "runPreSessionChecks", { op: "schedule", closing_id: j.CLOSING_ID, application_id: j.appId, scheduled_at: EST("2026-11-18", "10:05"), time_zone: "America/New_York", state: "OH", county_fips: "39049", transaction_type: "purchase", rescindable: false, dry_state: false, settlement_agent_party_id: j.AGENT_PARTY, notary_party_id: j.NOTARY.party_id, ron_provider_party_id: "P-RON-1", eligibility: j.ELIGIBILITY, signers: j.SIGNERS, enote_eligible: false, proposed_closing_type: "hybrid", borrower_election: "hybrid" }, CLOSER_A);
  assert.equal(sch.output["closing_type"], "hybrid", JSON.stringify(sch.output["reasons"])); assert.equal(sch.output["note_form"], "paper", JSON.stringify(sch.output["reasons"]));
}
/** 26.1 Mon Nov 16 13:00 (journey-purchase.ts closingDocuments, the paper variant): the note terms, the doc-gen gates, the snapshot with the eNote excluded → the OH paper note (3200), the mortgage (3036), the final 1003; QC; the release 16:00; Tue Nov 17 09:00 the release folded into 26.2's closing. */
async function ohClosingDocumentsPaper(j: PurchaseJourney): Promise<void> {
  const scope = { app: j.appId }; const snapshot = { ...j.CLOSING_SNAPSHOT(), enote_default: false };
  clock.set(EST("2026-11-16", "13:00"));
  const terms = await j.tool(scope, "26.1", "computeNoteTerms", { principal_cents: "41200000", note_rate_pct: "6.375", term_months: 360, scheduled_disbursement_date: "2026-11-18", state: "OH" }, CLOSER_A); j.noteTerms = terms.output;
  assert.equal(terms.output["pi_cents"], "257034"); assert.equal(terms.output["first_payment_date"], "2027-01-01");
  const g = await j.tool(scope, "26.1", "evaluateDocGenGates", { gate: j.DOCGEN_GATE }, CLOSER_A); assert.equal(g.output["gate_open"], true, JSON.stringify(g.output)); j.closingSetId = g.output["set_id"] as string;
  await j.tool(scope, "26.1", "takeClosingSnapshot", { set_id: j.closingSetId, snapshot, gate: j.DOCGEN_GATE }, CLOSER_A);
  const rendered = await j.tool(scope, "26.1", "renderDocument", { set_id: j.closingSetId }, CLOSER_A);
  const docs = rendered.output["documents"] as { document_id: string; kind: string; form_number: string; data_hash: string }[];
  assert.ok(docs.some((d) => d.kind === "note"), `a paper note in the set: ${JSON.stringify(docs.map((d) => [d.kind, d.form_number]))}`); assert.ok(!docs.some((d) => d.kind === "enote"), "no eNote"); assert.ok(!docs.some((d) => d.kind === "rescission_notice_h8"), "no H-8 in a purchase package");
  await j.tool(scope, "26.1", "runDocumentQc", { set_id: j.closingSetId, upstream: { cd: { loan_amount_cents: "41200000", note_rate_pct: "6.375", pi_cents: "257034", org_nmlsr_id: "123456", mlo_nmlsr_id: "987654", first_payment_date: "2027-01-01" }, du: { loan_amount_cents: "41200000", note_rate_pct: "6.375", term_months: 360 }, lock: { note_rate_pct: "6.375" }, title: { vesting_text: snapshot.vesting_text, legal_description: snapshot.legal_description }, urla_1003: { org_nmlsr_id: "123456", mlo_nmlsr_id: "987654", loan_amount_cents: "41200000", note_rate_pct: "6.375", term_months: 360 }, note_date: "2026-11-18" } }, CLOSER_A);
  clock.set(EST("2026-11-16", "16:00"));
  await j.tool(scope, "26.1", "releaseToSettlementAgent", { set_id: j.closingSetId, released_to_party_id: j.AGENT_PARTY, facts: { qc_pass_gate_open: true, template_version_gate_open: true } }, CLOSER_A);
  clock.set(EST("2026-11-17", "09:00"));
  const released = (await events(j.appId, "closing.documents.released")).at(-1)!;
  await j.tool(scope, "26.2", "runPreSessionChecks", { op: "upstream", closing_id: j.CLOSING_ID, event: { type: "closing.documents.released", occurredAt: EST("2026-11-16", "16:00"), payload: released.payload } }, CLOSER_A);
}
/** The OH purchase to `closing.documents.released` (Tue Nov 17 09:00 ET): journey-purchase.ts's phases through the CD and the CPL, the platform's own items (24.5, 30.3, 22.3, 22.2, 25.4, the MLO of record), the hybrid/paper schedule, the paper closing set. The pass folds to `documents_released` on its first run. */
async function driveOhToDocumentsReleased(): Promise<PurchaseJourney> {
  // the fixture's `at` only moves the shared FixedClock forward (its phases are dated Sept 1 → Nov 17); after the refi chain the clock reads Nov 12, so open the purchase fixture's own calendar first — otherwise 20.4's Oct 20 sheet is published and read on Nov 12 (no sheet in force)
  clock.set(EDT("2026-09-01", "11:00"));
  const j = await newOhJourney(); const phases = await j.phases(); const run = async (name: string): Promise<void> => { const p = phases.find((x) => x.name === name); assert.ok(p, `phase ${name}`); await p.run(); await settle(); };
  for (const n of ["seedPricing", "openLead", "openApplication"]) await run(n);
  await seedOhDemographics(j);
  for (const n of ["interview", "signContract"]) await run(n);
  await seedOhRecord(j); await seedOhHmda(j);
  for (const n of ["verifyAndOrderCredit", "quote", "declareAndVerifyAssets", "miQuotesAndElection", "deliverLe", "recordIntent", "appraisalOrder", "duSubmitAndInterpret"]) await run(n);
  // the lock-day (Mon Oct 26) best-efforts price for 6.375%: 101.000 — 21.4's lock quote and 29.1's commitment carry it (worked example B / 27.2 example C: premium $4,120.00 = 1%); the FAKE PE–WL is shared per runtime (the refi fixture sets its own 101.125 on its lock day)
  (runtime.originationServices.vendor("pewl") as FakePewl).setPrice("101.000");
  for (const n of ["quoteForLock", "requestLock", "executeLockAndCommit", "conditionalApproval", "miOrderAndCommitment", "appraisalReceipt", "miScheduleAndDisclosure", "giftAndFundsToClose", "titleOrder"]) await run(n);
  clock.set(EST("2026-11-02", "09:30")); await j.tool({ app: j.appId }, "21.1", "assignMLO", { roster: [{ mlo_id: "mlo-okonkwo", name: "Ada Okonkwo", nmlsr_id: "987654", licensed_states: ["OH"], nmls_status: "active", open_queue: 0 }] });
  await ohInsurance(j); await ohEscrowAnalysis(j); await fundHaircutReserve(j);
  await run("clearToClose"); await ohScheduleHybridPaper(j);
  for (const n of ["titleCommitmentAndWire", "closingDisclosure"]) await run(n);
  // 35.2: the rendered CD as a documents row (the pass's closing_scheduled act on the refi; the fixture's CD here — 30.2's OB-017 reads the final CD among the loan's documents)
  { const cd = (await entitiesOf("disclosures", j.appId)).find((d) => d.data["kind"] === "cd")!; assert.ok(cd, "the OH CD row"); await storeDocument(db, { kind: "closing_disclosure", application_id: j.appId, loan_id: null, text: JSON.stringify({ disclosure_id: cd.id, figures_hash: cd.data["figures_hash"] ?? null, fees: j.CD_FEES(), escrow: { monthly_escrow_cents: "61500", initial_escrow_payment_cents: "124000" } }), retention_class: "regz_cd_5y", source: `25.2 renderCd ${cd.id} (journey-purchase.ts)`, now: clock.now() }); }
  await ohQmAtCd(j);
  await run("titleCplAndGates");
  await ohVvoeAndRefresh(j); await ohClosingDocumentsPaper(j); await ohClosingPackage(j);
  return j;
}
/** 27.1's daily accruals over the OH advance (the sweep's 27.1 cycle; here as `warehouse`): Nov 18 → Dec 1 = 14 days on $403,760.00 at SOFR 4.30% + 250 bps act/360 = $1,067.72 (27.1 worked example B). */
const ACCRUAL_DAYS_B = ["2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27", "2026-11-28", "2026-11-29", "2026-11-30", "2026-12-01"];
const SOFR_430_B = [...SOFR_430, ...["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-27", "2026-11-30", "2026-12-01", "2026-12-02"].map((d) => ({ publication_date: d, rate_bps: 430 }))];
async function accrueOhAdvance(j: PurchaseJourney): Promise<{ advance_id: string; facility_id: string }> {
  const adv = (await events(j.appId, "warehouse.advance.funded")).at(-1)!; assert.ok(adv, "27.1's advance funded"); const advance_id = String(adv.payload["advance_id"]); const facility_id = String(adv.payload["facility_id"]);
  for (const d of ACCRUAL_DAYS_B) { clock.set(EST(d, "18:00")); await j.tool({ app: j.appId }, "27.1", "accrueInterest", { advance_id, facility_id, accrual_date: d, sofr: SOFR_430_B }, WAREHOUSE_A); }
  return { advance_id, facility_id };
}
/** The FAKE Sellers API's advice for the OH loan — worked example B at the commitment's 101.000: gross $416,120.00, LLPA waived (HomeReady), interest +$70.10 due the lender (1 day past the Dec 1 LPI at PTR 6.125%, 30/360), net $416,190.10, purchase date Wed Dec 2. */
function fnmaAdviceB(fnma: string, sln: string): RawPurchaseAdvice {
  const a = { fnma_loan_number: fnma, seller_loan_number: sln, fnma_servicer_number: "123456789", commitment_id_fnma: "BE-2026-10-0002", advice_date: D("2026-12-02"), purchase_date: D("2026-12-02"), purchase_ready_date: D("2026-12-01"), remittance_type: "aa" as const, note_rate: "0.06375", pass_through_rate: "0.06125", servicing_fee_bps: 25, lpi_date: D("2026-12-01"),
    interest_days: 1, interest_direction: "due_lender" as const, interest_cents: 7_010n, upb_cents: 41_200_000n, price: "101.000", gross_price_proceeds_cents: 41_612_000n, llpa_items: [], llpa_total_cents: 0n, other_fees_cents: 0n, net_proceeds_cents: 41_619_010n,
    payee_code: "SMWH1", wire_nickname: "SM WAREHOUSE", source: "purchase_advice_api_sellers" as const };
  return { ...a, raw_json: JSON.stringify({ fnma_loan_number: a.fnma_loan_number, seller_loan_number: a.seller_loan_number, advice_date: a.advice_date, net_proceeds: "416190.10" }) };
}
const bankCreditB = (fnma: string, sln: string, R: string, amountCents: bigint) => ({ bank_ref: `FEDW-20261202-${R}`, value_date: D("2026-12-02"), amount_cents: amountCents, originator_name: "Fannie Mae", reference_text: `WHOLE LOAN PURCHASE ${fnma} ${sln}`, account_ref: FACILITY_FIXTURE.collection_account_ref, received_at: EST("2026-12-02", "14:00") });
const jnOf = async (id: string, n = 16): Promise<string> => JSON.stringify((await journal(id)).slice(-n).map((x) => [x.step, x.kind, x.command_process, x.command_name, x.command_op, x.error_class, x.refusal_code, x.detail["message"] ?? x.detail["reason"] ?? x.detail["gap"] ?? x.detail["blocking"] ?? null, x.detail["reasons"] ?? x.detail["gate"] ?? null])).slice(0, 4000);

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
  demoCalls.before = DEMO_SNAPSHOT_CALLS.count;   // T9: the fixture is never read when the record is complete — the count before any pass that could fund
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

test("35.6-T9: Given `loan.funded`, when the same sweep's pass runs, then `funding_snapshots` has one row whose `sources` names a row or event for every top-level field of 30.2's `OriginationSnapshot` (`note` ← 26.1's eNote and `closing.consummated`; `final_cd` ← the consummated CD version; `escrow_analysis` ← 30.3's refreshed analysis; `consents` ← `consent.captured` rows; `documents` ← 35.2 rows; `min` ← `enote.registered`; `warehouse_advance_id` ← `warehouse.advance.funded`; `flood`, `hazard`, `mi`, `hpml`, `qm_type`, `ltv_pct`, `custody`, `trailing`, `property`, `borrowers`), `gaps = []`, `fixture_used = false`, `demoSnapshot` was not called (a spy on `src/runtime/origination.ts` exports), `orchestration.fund` produced ONE `loans` row with `origination_application_id`, `loan_terms` with `pi_cents = 340262`, `escrow_payment_cents = 68750`, `note_rate_bps = 61250`, a balanced opening set with principal 56,000,000, escrow 206,250 and prepaid interest 178,543 cents, OB-001…OB-022 passing, `loan.staged` … `loan.boarded` carrying both ids, `SM_ORIG_BOARD_T1BD` and `SM_ORCH_HANDOFF_AFTER_FUNDED_4H` satisfied, and `POST /v1/applications/{id}/fund` on the same application answers `duplicate: true`; given `ENVIRONMENT=production` and a record missing 30.3's analysis, then the hand-off is refused `FIXTURE_REFUSED`, the row lists `escrow_analysis` in `gaps`, no `loans` row exists and one `ops_analyst` and one `compliance` escalation are open.", { skip }, async () => {
  const j = await chainJourney(); const appId = j.appId;
  const fundedEv = (await events(appId, "loan.funded")).at(-1)!; assert.ok(fundedEv, "Given loan.funded (T8)");
  // the same sweep's pass: T8's funding pass folded loan.funded, entered `funded` and ran the hand-off in that unit of work (rule 1: the fold continues while the record moves); a row still at funded takes one more pass
  let o = await row(appId);
  if (!o.loan_id) { clock.set(EST("2026-11-12", "13:05")); const r = await pass(clock.now(), appId); o = await row(appId); assert.ok(o.loan_id, `the hand-off ran: ${JSON.stringify(r).slice(0, 400)} ${JSON.stringify((await journal(appId)).filter((x) => x.step === "funded").map((x) => [x.kind, x.command_process, x.command_name, x.command_op, x.error_class, x.refusal_code, x.detail["message"] ?? x.detail["reason"] ?? x.detail["gap"] ?? x.detail["gaps"] ?? null])).slice(0, 3000)}`); }
  const snaps = await db.query<{ id: string; sources: Record<string, { kind: string; ref: string; process: string }>; gaps: string[]; fixture_used: boolean; refused_code: string | null; environment: string; snapshot: P }>(`SELECT id::text AS id, sources, gaps, fixture_used, refused_code, environment, snapshot FROM funding_snapshots WHERE application_id = $1 ORDER BY built_at`, [appId]);
  assert.equal(snaps.length, 1, "funding_snapshots has one row"); const snap = snaps[0]!;
  assert.deepEqual(snap.gaps, [], JSON.stringify(snap.sources)); assert.equal(snap.fixture_used, false); assert.equal(snap.refused_code, null); assert.equal(snap.environment, "nonprod");
  // sources: a row or event for every top-level field of 30.2's OriginationSnapshot
  const expected: [string, string][] = [["note", "26.1"], ["note.note_date", "26.2"], ["closing", "26.2"], ["final_cd", "25.2"], ["final_cd.version", "25.2"], ["escrow_analysis", "30.3"], ["consents", "21.1"], ["documents", "35.2"], ["min", "26.2"], ["warehouse_advance_id", "27.1"], ["flood", "24.5"], ["hazard", "24.5"], ["mi", "23.1"], ["hpml", "23.4"], ["qm_type", "23.4"], ["ltv_pct", "23.1"], ["custody", "26.2"], ["trailing", "26.4"], ["property", "21.1"], ["borrowers", "21.1"]];
  for (const [path, process] of expected) { const s = snap.sources[path]; assert.ok(s, `sources names ${path}: ${JSON.stringify(Object.keys(snap.sources))}`); assert.ok(["event", "entity", "table"].includes(s.kind), `${path} is a row or event, not ${s.kind} (${s.ref})`); assert.equal(s.process, process, `${path} from ${process}`); }
  assert.equal(DEMO_SNAPSHOT_CALLS.count, demoCalls.before, "demoSnapshot was not called (the spy on src/runtime/origination.ts exports)");
  // orchestration.fund produced ONE loans row with origination_application_id; loan_terms; the balanced opening set
  const loans = await db.query<{ id: string; status: string }>(`SELECT id::text AS id, status FROM loans WHERE origination_application_id = $1`, [appId]); assert.equal(loans.length, 1); const loanId = loans[0]!.id; assert.equal(o.loan_id, loanId); assert.equal(loans[0]!.status, "active");
  assert.equal(await n(`FROM loan_terms WHERE loan_id = $1 AND source = 'boarding' AND pi_cents = 340262 AND escrow_payment_cents = 68750 AND note_rate_bps = 61250`, [loanId]), 1);
  const bal = async (account: string) => BigInt((await db.query<{ s: string }>(`SELECT coalesce(sum(amount_cents), 0)::text AS s FROM ledger_lines WHERE scope = 'loan' AND loan_id = $1 AND account = $2`, [loanId, account]))[0]!.s);
  assert.equal(await bal("principal"), 56_000_000n); assert.equal(-(await bal("escrow")), 206_250n); assert.equal(-(await bal("prepaid_interest")), 178_543n);
  assert.equal(await n(`FROM (SELECT l.set_id FROM ledger_lines l WHERE l.set_id IN (SELECT set_id FROM ledger_lines WHERE loan_id = $1) GROUP BY l.set_id HAVING sum(l.amount_cents) <> 0) x`, [loanId]), 0, "every set that touches the loan balances across its scopes");
  // OB-001…OB-022 passing
  const ob = await db.query<{ rule_code: string; result: string }>(`SELECT rule_code, result FROM boarding_validations WHERE application_id = $1 AND rule_code LIKE 'OB-%' ORDER BY rule_code`, [appId]);
  assert.equal(ob.length, 22, ob.map((v) => v.rule_code).join(",")); assert.deepEqual(ob.filter((v) => v.result !== "pass").map((v) => v.rule_code), []);
  // loan.staged … loan.boarded carrying both ids; the journal names the hand-off commands as this process's own tools
  for (const t of ["loan.staged", "loan.validated", "loan.boarded", "ledger.opening_posted"]) { const e = (await events(appId, t)).at(-1)!; assert.ok(e, `${t} emitted`); assert.equal(e.application_id, appId); assert.equal(e.loan_id, loanId, `${t} carries the loan id`); }
  const jl = await journal(appId); const fundedCmds = jl.filter((x) => x.step === "funded" && x.kind === "command_run").map((x) => `${x.command_process} ${x.command_name}${x.command_op ? `{${x.command_op}}` : ""}`);
  for (const c of ["35.6 orchestration.snapshot", "35.6 orchestration.fund", "30.3 buildEscrowLines{establish}", "25.4 schedulePostClosingRun", "30.4 openHandoff"]) assert.ok(fundedCmds.includes(c), `${c} ran in the funded step (${fundedCmds.join(", ")})`);
  const t1 = await timers(appId, "SM_ORIG_BOARD_T1BD"); assert.equal(t1.length, 1); assert.equal(t1[0]!.status, "satisfied");
  const t4h = await timers(appId, "SM_ORCH_HANDOFF_AFTER_FUNDED_4H"); assert.equal(t4h.length, 1, JSON.stringify(t4h)); assert.equal(t4h[0]!.status, "satisfied");
  // POST /v1/applications/{id}/fund on the same application answers duplicate: true (one loans row, one snapshot)
  const again = await call("POST", `/v1/applications/${appId}/fund`, { actor: OFFICER });
  assert.equal(again.status, 200, JSON.stringify(again.body).slice(0, 500)); assert.equal(again.body["duplicate"], true); assert.equal(again.body["loan_id"], loanId);
  assert.equal(await n(`FROM loans WHERE origination_application_id = $1`, [appId]), 1); assert.equal(await n(`FROM funding_snapshots WHERE application_id = $1`, [appId]), 1);
  // given ENVIRONMENT=production and a record missing 30.3's analysis: the hand-off is refused FIXTURE_REFUSED, the row lists escrow_analysis in gaps, no loans row, one ops_analyst and one compliance escalation
  const u = await newJourney(); await seedCreditAuthorizations(u);
  clock.set(MST("2026-10-05", "17:50")); await pass(clock.now(), u.appId);
  process.env["ENVIRONMENT"] = "production";
  try {
    const built = await runtime.execute({ process: "35.6", name: "orchestration.snapshot", loanId: "", applicationId: u.appId, actor: OFFICER, input: {} });
    const out = built.output as P; assert.equal(out["refused_code"], "FIXTURE_REFUSED", JSON.stringify(out).slice(0, 300)); assert.ok((out["gaps"] as string[]).includes("escrow_analysis"), JSON.stringify(out["gaps"])); assert.equal(out["fixture_used"], false); assert.equal(out["environment"], "production");
    await assert.rejects(runtime.execute({ process: "35.6", name: "orchestration.fund", loanId: "", applicationId: u.appId, actor: OFFICER, input: { snapshot_id: out["snapshot_id"] } }), (e: unknown) => (e as { code?: string }).code === "FIXTURE_REFUSED");
    const refused = await call("POST", `/v1/applications/${u.appId}/fund`, { actor: OFFICER }); assert.equal(refused.status, 409, JSON.stringify(refused.body).slice(0, 300)); assert.equal(refused.body["code"], "FIXTURE_REFUSED");
  } finally { delete process.env["ENVIRONMENT"]; }
  const urow = (await db.query<{ gaps: string[]; refused_code: string | null; fixture_used: boolean }>(`SELECT gaps, refused_code, fixture_used FROM funding_snapshots WHERE application_id = $1 ORDER BY built_at LIMIT 1`, [u.appId]))[0]!;
  assert.equal(urow.refused_code, "FIXTURE_REFUSED"); assert.ok(urow.gaps.includes("escrow_analysis")); assert.equal(urow.fixture_used, false);
  assert.equal(await n(`FROM loans WHERE origination_application_id = $1`, [u.appId]), 0);
  assert.equal((await escalations(u.appId, "ops_analyst")).filter((e) => !e.completed_at && e.payload["reason"] === "FIXTURE_REFUSED").length, 1);
  assert.equal((await escalations(u.appId, "compliance")).filter((e) => !e.completed_at && e.payload["reason"] === "FIXTURE_REFUSED").length, 1);
});

test("35.6-T10: Given `loan.boarded` on Thu Nov 12, when the pass runs Fri Nov 13 10:05 MST, then 29.3 built and froze the package (`delivery.uldd.built`, `earlycheck.completed{clean=true}`, `delivery.package.frozen`) as `secondary`, `SM_ORCH_DELIVERY_OPEN_2BD` is satisfied, 29.4 registered the delivery with Supermortgage's approved wire instruction and payee code, opened the operator task with `sla_due_at = 2026-11-16T15:00 MT`, eDelivered the eNote and requested the Transfer of Control the same day (`enote.transfer_of_control.requested{effective_date=2026-11-16}`, gate open), the row is `waiting_human{fnma_portal_operator}`; when the FAKE operator's evidence arrives 13:31 ET Mon Nov 16, then `delivery.submitted{fnma_loan_number}` exists, the custodian package is `evault_auto` with no documents, the eVault's auto-certification yields `custody.certified{purchase_ready_at=2026-11-16}` and `expected_purchase_date = 2026-11-17`.", { skip }, async () => {
  const j = await chainJourney(); const appId = j.appId; const loanId = (await row(appId)).loan_id!; assert.ok(loanId);
  const boardedEv = (await events(appId, "loan.boarded")).at(-1)!; assert.ok(boardedEv, "Given loan.boarded on Thu Nov 12"); assert.equal(boardedEv.occurred_at.slice(0, 10), "2026-11-12");
  // 25.1's own pre-delivery run that morning (the compliance-tester's checkpoint; the pass's 25.2 gate assertion reuses it within its freshness window)
  await complianceAt(j, MST("2026-11-13", "09:30"), "SM_O61_COMPLIANCE_PASS_DELIVERY_GATE", "cd");
  // when the pass runs Fri Nov 13 10:05 MST
  clock.set(MST("2026-11-13", "10:05")); const r = await pass(clock.now(), appId);
  const runs = await db.query<{ id: string; data: P }>(`SELECT id, data FROM entity_current WHERE kind = 'compliance_test_runs' AND data->>'application_id' = $1`, [appId]);
  const jl = await journal(appId); const fail = JSON.stringify(runs.map((r) => [r.id, r.data["gate"], r.data["checkpoint"], r.data["status"], r.data["gate_open"], r.data["completed_at"]])).slice(0, 1200) + JSON.stringify(jl.filter((x) => ["boarded", "package_frozen"].includes(x.step)).map((x) => [x.step, x.kind, x.command_process, x.command_name, x.command_op, x.error_class, x.refusal_code, x.detail["message"] ?? x.detail["reason"] ?? x.detail["gap"] ?? null])).slice(0, 3000);
  assert.equal(r.rows[0]!.wrote, true, `${JSON.stringify(r).slice(0, 300)} ${fail}`);
  // 29.3 built and froze the package as `secondary`
  const c293 = jl.filter((x) => x.kind === "command_run" && x.command_process === "29.3"); assert.ok(c293.length >= 5, fail); for (const x of c293) assert.equal(x.actor_id, "secondary", `${x.command_name} as secondary`);
  for (const t of ["delivery.uldd.built", "delivery.package.frozen"]) assert.equal((await events(appId, t)).length, 1, `${t}: ${fail}`);
  const ec = (await events(appId, "earlycheck.completed")).filter((e) => e.payload["file_kind"] !== "du_spec_3_4"); assert.ok(ec.length >= 1); assert.equal(ec.at(-1)!.payload["clean"], true);
  const t2bd = await timers(appId, "SM_ORCH_DELIVERY_OPEN_2BD"); assert.equal(t2bd.length, 1, JSON.stringify(t2bd)); assert.equal(t2bd[0]!.status, "satisfied");
  // 29.4 registered the delivery with Supermortgage's approved wire instruction and payee code; the operator task's SLA; the eNote eDelivered and the Transfer of Control requested the same day
  const dlv = (await entitiesOf("deliveries", appId)).find((d) => typeof d.data["delivery_id"] === "string")!; assert.ok(dlv, fail); assert.equal(dlv.data["wire_instruction_id"], "wire-sm-warehouse"); assert.equal(dlv.data["payee_code"], "SMWH1"); assert.equal(dlv.data["loan_id"], loanId); assert.ok(dlv.data["package_id"]);
  const task = (await entitiesByDelivery("delivery_operator_tasks", String(dlv.data["delivery_id"]))).find((t) => t.data["kind"] === "import_and_submit")!; assert.ok(task, fail); assert.equal(task.data["sla_due_at"], MST("2026-11-16", "15:00"));
  assert.equal((await events(appId, "enote.edelivered")).length, 1);
  // C1-2-04 through 29.4's gate: the request's effective date is its request date — requested the same day as the eDelivery (Fri Nov 13), re-requested for the submission day (Mon Nov 16, the spec's effective_date)
  const toc = (await events(appId, "enote.transfer_of_control.requested")).at(-1)!; assert.ok(toc); assert.equal(toc.payload["effective_date"], "2026-11-13"); assert.equal(toc.payload["same_day"], true); assert.equal(toc.occurred_at.slice(0, 10), "2026-11-13");
  const req = jl.find((x) => x.kind === "command_run" && x.command_name === "requestEnoteTransfer" && x.command_op === "transfer")!; assert.ok(req); assert.equal(toc.payload["accepted"] !== false, true, "the eRegistry accepted the same-day request (29.4's gate open)");
  let o = await row(appId); assert.equal(o.step, "package_frozen", fail); assert.equal(o.status, "waiting_human"); assert.equal(o.waiting_on, "fnma_portal_operator");
  // when the FAKE operator's evidence arrives 13:31 ET Mon Nov 16
  clock.set(EST("2026-11-16", "13:31")); const r2 = await pass(clock.now(), appId);
  const jl2 = await journal(appId); const fail2 = JSON.stringify(jl2.filter((x) => ["package_frozen", "delivered"].includes(x.step)).map((x) => [x.step, x.kind, x.command_name, x.command_op, x.actor_id, x.error_class, x.refusal_code, x.detail["message"] ?? x.detail["reason"] ?? x.detail["gap"] ?? null])).slice(0, 3000);
  assert.equal(r2.rows[0]!.wrote, true, `${JSON.stringify(r2).slice(0, 300)} ${fail2}`);
  const toc2 = (await events(appId, "enote.transfer_of_control.requested")).at(-1)!; assert.equal(toc2.payload["effective_date"], "2026-11-16"); assert.equal(toc2.payload["same_day"], true); assert.equal(toc2.occurred_at.slice(0, 10), "2026-11-16");
  const sub = (await events(appId, "delivery.submitted")).at(-1)!; assert.ok(sub, fail2); assert.match(String(sub.payload["fnma_loan_number"]), /^\d{10}$/); assert.equal(sub.loan_id, loanId);
  const ev = jl2.find((x) => x.kind === "command_run" && x.command_name === "parseOperatorEvidence")!; assert.ok(ev); assert.equal(ev.actor_kind, "human"); assert.equal(ev.actor_role, "fnma_portal_operator");
  const cert = (await entitiesByDelivery("custodian_certifications", String(dlv.data["delivery_id"]))).at(-1)!; assert.ok(cert, fail2); assert.equal(cert.data["custody_mode"], "evault_auto"); assert.deepEqual(cert.data["package_document_ids"] ?? [], []);
  // 29.4's certification observation (27.2 records its own `custody.certified{certification_date, expected_proceeds_on}` on the same day)
  const certified = (await events(appId, "custody.certified")).filter((e) => e.payload["purchase_ready_at"] !== undefined).at(-1)!; assert.ok(certified, fail2); assert.equal(certified.payload["purchase_ready_at"], "2026-11-16");
  const dlv2 = (await entitiesOf("deliveries", appId)).find((d) => typeof d.data["delivery_id"] === "string")!; assert.equal(dlv2.data["expected_purchase_date"], "2026-11-17", JSON.stringify(dlv2.data).slice(0, 400));
  o = await row(appId); assert.equal(o.step, "certified", fail2);
});

test("35.6-T11: Given the FAKE Sellers API's advice (price 101.125, UPB 56,000,000, principal proceeds $566,300.00, interest −$1,096.67, LLPA $700.00, net $564,503.33, purchase date 2026-11-19) and the collection bank's credit of 56,450,333 cents, when the pass runs, then 29.4 `ingestPurchaseAdvice` appended `loan.purchased` keyed by both ids with `variance_cents = 0`, 30.1 `matchPurchaseAdvice` was given the SAME `purchase_advices` row (its `net_proceeds_cents` = 56,450,333) and appended `loan.investor_updated` with `loans.fnma_loan_number` set and `loan_terms` v2 effective 2026-11-19, 27.2 `ingestReceipts` → `proceeds.received`, `matchProceeds` matched with variance $0.00, `postWaterfall` posted payoff $549,550.64 (principal $548,800.00 + interest $725.64 + fee $25.00), cost recovery $3,485.00, SM retained $1,415.00, partner residual $10,052.69 (`warehouse.advance.repaid`, `settlement.waterfall.posted`), `releaseCollateral` → `warehouse.secured_party.released{effective ≤ 2026-11-19}`, `purchase_reconciliations` is `reconciled` with the three sides, `orchestration.purchase.reconciled` satisfied `SM_ORCH_PURCHASE_RECON_1BD`, the row is `completed`, and `SELECT count(*) FROM loans WHERE origination_application_id = $1` is 1; given instead 30.1 fed a net of 56,590,333 cents, then `status = exception`, `sides.\"30.1\" = unmatched`, no waterfall was posted, no release exists and one sev-2 `officer` escalation carries 27.2's breakdown.", { skip }, async () => {
  const j = await chainJourney(); const appId = j.appId; let o = await row(appId); assert.equal(o.step, "certified", JSON.stringify(o)); const loanId = o.loan_id!;
  const jn = async (id: string) => JSON.stringify((await journal(id)).slice(-16).map((x) => [x.step, x.kind, x.command_process, x.command_name, x.command_op, x.error_class, x.refusal_code, x.detail["message"] ?? x.detail["reason"] ?? x.detail["gap"] ?? null]));
  const fnma = String((await events(appId, "delivery.submitted")).at(-1)!.payload["fnma_loan_number"]); const sln = (await db.query<{ n: string }>(`SELECT servicer_loan_number AS n FROM loans WHERE id = $1`, [loanId]))[0]!.n;
  // 27.1's daily accruals Nov 12–18 (the sweep's 27.1 cycle): 7 days on $548,800.00 at SOFR 4.30% + 250 bps = $725.64
  await accrueAdvance(j, ACCRUAL_DAYS);
  // Thu Nov 19 09:00 ET: the FAKE Sellers API's advice is on the wire; the pass registers 27.2, polls, hands the SAME row to 29.4 (loan.purchased) and 30.1, and waits on the collection bank
  const fakes = settlementFakes(); fakes.advices.queue(fnmaAdvice(fnma, sln));
  clock.set(EST("2026-11-19", "09:00")); await pass(clock.now(), appId);
  const purchased = (await events(appId, "loan.purchased")).at(-1)!; assert.ok(purchased, await jn(appId)); assert.equal(purchased.loan_id, loanId); assert.equal(purchased.application_id, appId);
  const paId = `pa-${fnma}-2026-11-19`; const byId = async (id: string): Promise<{ id: string; data: P } | undefined> => (await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = 'purchase_advices' AND id = $1`, [id])).map((r) => ({ id, data: decodeEntityData(r.data) as P }))[0];
  const row272 = (await byId(paId))!; assert.ok(row272, `27.2 stored the Sellers API advice keyed to the loan ${await jn(appId)}`); assert.equal(row272.data["loan_id"], loanId); assert.equal(BigInt(String(row272.data["net_proceeds_cents"])), 56_450_333n);
  const row294 = (await byId(`${paId}:delivery`))?.data!; assert.ok(row294, "29.4 ingested the same advice under its own projection"); assert.equal(String(row294["variance_cents"]), "0"); assert.equal(String(purchased.payload["purchase_advice_id"]), `${paId}:delivery`);
  const jl = await journal(appId); const c301 = jl.find((x) => x.kind === "command_run" && x.command_process === "30.1" && x.command_name === "matchPurchaseAdvice")!; assert.ok(c301, await jn(appId)); assert.equal(c301.actor_id, "investor-reporting");
  assert.match(String(((c301.detail["sources"] as P)["advice"] as P)["ref"]), new RegExp(`^purchase_advices:${paId}:`), "30.1 was handed the SAME purchase_advices row");
  const inv = (await events(appId, "loan.investor_updated")).at(-1)!; assert.ok(inv); assert.equal(inv.loan_id, loanId); assert.equal(inv.payload["purchase_advice_id"], paId); assert.equal(inv.payload["fnma_loan_number"], fnma);
  const loanRow = (await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = 'loans' AND id = $1`, [loanId])).map((r) => decodeEntityData(r.data) as P)[0]!; assert.equal(loanRow["fnma_loan_number"], fnma, "loans.fnma_loan_number set by 30.1");
  const terms2 = (await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = 'loan_terms' AND id = $1`, [`${loanId}:2`])).map((r) => decodeEntityData(r.data) as P)[0]!; assert.ok(terms2, "loan_terms v2"); assert.equal(terms2["version"], 2); assert.equal(terms2["effective_date"], "2026-11-19");
  o = await row(appId); assert.equal(o.step, "purchased", await jn(appId)); assert.equal(o.status, "waiting_vendor"); assert.equal(o.waiting_on, "collection_bank");
  // 14:00 ET: the collection bank credits 56,450,333 cents; the pass 14:05: 27.2 ingestReceipts → proceeds.received, matchProceeds matched $0.00, the three-sided reconciliation, postWaterfall, releaseCollateral, completed
  fakes.bank.queue(bankCredit(fnma, sln, j.R, 56_450_333n));
  clock.set(EST("2026-11-19", "14:05")); await pass(clock.now(), appId);
  const received = (await events(appId, "proceeds.received")).at(-1)!; assert.ok(received, await jn(appId)); assert.equal(BigInt(String(received.payload["amount_cents"])), 56_450_333n);
  const matched = (await events(appId, "proceeds.matched")).at(-1)!; assert.ok(matched, await jn(appId)); assert.equal(matched.payload["status"], "matched"); assert.equal(String(matched.payload["variance_cents"]), "0");
  const wf = (await events(appId, "settlement.waterfall.posted")).at(-1)!; assert.ok(wf, await jn(appId));
  assert.equal(BigInt(String(wf.payload["payoff_total_cents"])), 54_955_064n, "payoff $549,550.64 = principal $548,800.00 + interest $725.64 + fee $25.00"); assert.equal(BigInt(String(wf.payload["sm_cost_recovery_cents"])), 348_500n); assert.equal(BigInt(String(wf.payload["sm_retained_residual_cents"])), 141_500n); assert.equal(BigInt(String(wf.payload["partner_residual_cents"])), 1_005_269n);
  const wfRow = (await entitiesOf("settlement_waterfalls", appId)).at(-1) ?? (await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = 'settlement_waterfalls' AND data->>'waterfall_id' = $1`, [String(wf.payload["waterfall_id"])])).map((r) => ({ id: "", data: decodeEntityData(r.data) as P }))[0]!;
  assert.ok(wfRow, "27.2's waterfall row"); assert.equal(BigInt(String(wfRow.data["advance_principal_cents"])), 54_880_000n); assert.equal(BigInt(String(wfRow.data["accrued_interest_cents"])), 72_564n); assert.equal(BigInt(String(wfRow.data["warehouse_fees_cents"])), 2_500n);
  const repaid = (await events(appId, "warehouse.advance.repaid")).at(-1)!; assert.ok(repaid); assert.equal(repaid.payload["repaid_from"], "purchase_proceeds");
  const spr = (await events(appId, "warehouse.secured_party.released")).at(-1)!; assert.ok(spr, "27.1 released SM as Secured Party at the Transfer of Control"); assert.ok(String(spr.payload["effective_date"]) <= "2026-11-19", String(spr.payload["effective_date"]));
  assert.equal((await events(appId, "warehouse.collateral.status_changed")).filter((e) => e.payload["to"] === "released").length, 1, "27.2 closed the collateral chain on payment");
  const recon = (await db.query<P>(`SELECT status, sides, advice_net_proceeds_cents::text AS advice_net, investor_net_proceeds_cents::text AS investor_net, bank_received_cents::text AS bank, warehouse_payoff_cents::text AS payoff, partner_residual_cents::text AS residual, purchase_advice_id, escalation_id FROM purchase_reconciliations WHERE loan_id = $1`, [loanId]));
  assert.equal(recon.length, 1, "purchase_reconciliations is written once"); assert.equal(recon[0]!["status"], "reconciled"); assert.deepEqual(recon[0]!["sides"], { "29.4": "reconciled", "30.1": "matched", "27.2": "matched" });
  assert.equal(String(inv.payload["net_proceeds_cents"]), "56450333", "30.1's update carries the net it was made from");
  assert.equal(recon[0]!["advice_net"], "56450333"); assert.equal(recon[0]!["investor_net"], "56450333"); assert.equal(recon[0]!["bank"], "56450333"); assert.equal(recon[0]!["payoff"], "54955064"); assert.equal(recon[0]!["residual"], "1005269"); assert.equal(recon[0]!["purchase_advice_id"], paId); assert.equal(recon[0]!["escalation_id"], null);
  assert.equal((await events(appId, "orchestration.purchase.reconciled")).length, 1, await jn(appId));
  const tr = await timers(appId, "SM_ORCH_PURCHASE_RECON_1BD"); assert.ok(tr.length >= 1, "SM_ORCH_PURCHASE_RECON_1BD armed by purchase_advice.received"); for (const t of tr) assert.equal(t.status, "satisfied", JSON.stringify(tr));
  o = await row(appId); assert.equal(o.step, "completed", await jn(appId)); assert.equal(o.status, "completed"); assert.equal((await events(appId, "orchestration.completed")).length, 1);
  assert.equal(Number((await db.query<{ c: string }>(`SELECT count(*)::text AS c FROM loans WHERE origination_application_id = $1`, [appId]))[0]!.c), 1, "the purchase is an investor update on the same loan id, never a re-board");
  // given instead 30.1 fed a net of 56,590,333 cents (a hand-keyed advice on the servicing side before the pass), then the reconciliation is an exception: 30.1 unmatched, no waterfall, no release, one sev-2 officer escalation with 27.2's breakdown
  const w = await driveToCertified(await newJourney()); const wApp = w.appId; const wLoan = (await row(wApp)).loan_id!; const wFnma = String((await events(wApp, "delivery.submitted")).at(-1)!.payload["fnma_loan_number"]); const wSln = (await db.query<{ n: string }>(`SELECT servicer_loan_number AS n FROM loans WHERE id = $1`, [wLoan]))[0]!.n;
  await accrueAdvance(w, ACCRUAL_DAYS);
  const wMin = String((await events(wApp, "enote.registered")).at(-1)!.payload["min"]);
  clock.set(EST("2026-11-19", "08:30"));
  await w.tool({ app: wApp }, "30.1", "matchPurchaseAdvice", { loan_id: wLoan, application_id: wApp, loan: { servicing_loan_number: wSln, original_upb_cents: "56000000", first_payment_date: "2027-01-01", note_rate_pct: "6.125", commitment_remittance_type: "AA", escrowed: true, note_form: "enote", mers_registered: true, min: wMin },
    advice: { advice_id: `PA-HAND-${w.R}`, fnma_loan_number: wFnma, fnma_servicer_number: "123456789", lender_loan_number: wSln, advice_date: "2026-11-19", purchase_date: "2026-11-19", remittance_type: "AA", pass_through_rate: "5.875", note_rate_pct: "6.125", servicing_fee_bps: 25, interest_adjustment_cents: "-109667", net_proceeds_cents: "56590333" } }, INVESTOR_A);
  fakes.advices.queue(fnmaAdvice(wFnma, wSln)); fakes.bank.queue(bankCredit(wFnma, wSln, w.R, 56_450_333n));
  clock.set(EST("2026-11-19", "14:10")); await pass(clock.now(), wApp);
  const wRecon = (await db.query<P>(`SELECT status, sides, escalation_id::text AS escalation_id, warehouse_payoff_cents::text AS payoff FROM purchase_reconciliations WHERE loan_id = $1`, [wLoan]));
  assert.equal(wRecon.length, 1, await jn(wApp)); assert.equal(wRecon[0]!["status"], "exception"); assert.equal((wRecon[0]!["sides"] as P)["30.1"], "unmatched"); assert.equal(wRecon[0]!["payoff"], null);
  assert.equal((await events(wApp, "settlement.waterfall.posted")).length, 0, "no waterfall on a one-sided figure"); assert.equal((await events(wApp, "warehouse.advance.repaid")).length, 0);
  assert.equal((await events(wApp, "warehouse.collateral.status_changed")).filter((e) => e.payload["to"] === "released").length + (await events(wApp, "warehouse.bailee_letter.released")).length, 0, "no release exists");
  const esc = await db.query<P>(`SELECT id::text AS id, severity, payload FROM escalations WHERE application_id = $1 AND owner_role = 'officer' AND payload->>'reason' = 'PURCHASE_EXCEPTION'`, [wApp]);
  assert.equal(esc.length, 1, "one sev-2 officer escalation"); assert.equal(esc[0]!["severity"], "sev2"); assert.equal(esc[0]!["id"], wRecon[0]!["escalation_id"]);
  const ep = esc[0]!["payload"] as P; assert.ok(ep["variance_breakdown"] && typeof ep["variance_breakdown"] === "object", "27.2's breakdown attached"); assert.deepEqual(ep["sides"], { "29.4": "reconciled", "30.1": "unmatched", "27.2": "matched" });
  assert.ok(ep["explanation"] && typeof ep["explanation"] === "object", "27.2's explainVariance attached to every exception, whichever side moved"); assert.equal(ep["investor_net_proceeds_cents"], "56590333", "the figure 30.1 matched (its update's net), not the advice's"); assert.equal(ep["advice_net_proceeds_cents"], "56450333"); assert.equal(ep["bank_received_cents"], "56450333");
  const wRow = (await db.query<P>(`SELECT investor_net_proceeds_cents::text AS inv, advice_net_proceeds_cents::text AS adv, interest_adjustment_cents::text AS int FROM purchase_reconciliations WHERE loan_id = $1`, [wLoan]))[0]!; assert.equal(wRow["inv"], "56590333"); assert.equal(wRow["adv"], "56450333"); assert.equal(wRow["int"], "-109667", "the signed interest adjustment (27.2's event), a deduction");
  // a same-key update from another net is one-sided too: 30.1 fed the SAME advice id but a different net → unmatched (the key alone never reconciles)
  const w2 = await driveToCertified(await newJourney()); const w2App = w2.appId; const w2Loan = (await row(w2App)).loan_id!; const w2Fnma = String((await events(w2App, "delivery.submitted")).at(-1)!.payload["fnma_loan_number"]); const w2Sln = (await db.query<{ n: string }>(`SELECT servicer_loan_number AS n FROM loans WHERE id = $1`, [w2Loan]))[0]!.n;
  await accrueAdvance(w2, ACCRUAL_DAYS); const w2Min = String((await events(w2App, "enote.registered")).at(-1)!.payload["min"]);
  clock.set(EST("2026-11-19", "08:35"));
  await w2.tool({ app: w2App }, "30.1", "matchPurchaseAdvice", { loan_id: w2Loan, application_id: w2App, loan: { servicing_loan_number: w2Sln, original_upb_cents: "56000000", first_payment_date: "2027-01-01", note_rate_pct: "6.125", commitment_remittance_type: "AA", escrowed: true, note_form: "enote", mers_registered: true, min: w2Min },
    advice: { advice_id: `pa-${w2Fnma}-2026-11-19`, fnma_loan_number: w2Fnma, fnma_servicer_number: "123456789", lender_loan_number: w2Sln, advice_date: "2026-11-19", purchase_date: "2026-11-19", remittance_type: "AA", pass_through_rate: "5.875", note_rate_pct: "6.125", servicing_fee_bps: 25, interest_adjustment_cents: "-109667", net_proceeds_cents: "56590333" } }, INVESTOR_A);
  fakes.advices.queue(fnmaAdvice(w2Fnma, w2Sln)); fakes.bank.queue(bankCredit(w2Fnma, w2Sln, w2.R, 56_450_333n));
  clock.set(EST("2026-11-19", "14:15")); await pass(clock.now(), w2App);
  const w2Recon = (await db.query<P>(`SELECT status, sides, investor_net_proceeds_cents::text AS inv FROM purchase_reconciliations WHERE loan_id = $1`, [w2Loan]));
  assert.equal(w2Recon.length, 1, await jn(w2App)); assert.equal(w2Recon[0]!["status"], "exception"); assert.equal((w2Recon[0]!["sides"] as P)["30.1"], "unmatched", "same key, different net → one-sided"); assert.equal(w2Recon[0]!["inv"], "56590333");
  assert.equal((await events(w2App, "settlement.waterfall.posted")).length, 0);
  assert.equal((await events(wApp, "orchestration.purchase.exception")).length, 1); const wo = await row(wApp); assert.equal(wo.step, "purchased"); assert.equal(wo.status, "waiting_human"); assert.equal(wo.waiting_on, "officer");
});

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

test("35.6-T14: Given a request to `orchestration.step` on the hosted API whose input carries `conditions`, `facts`, a `*_cents` field or `state`, then it is refused `NO_CLIENT_STATE` before any write; given a row whose next step is `documents_released` while 25.2's `assertGateOpen` answers closed, then it is `held{gate_closed}` and no 26.1 command ran; given a money-field change proposed by the agent (an `officer`-only snapshot override on `POST /fund`), when no `officer` approval record exists, then the command is refused and nothing is written; given any pass, then no `timers` row was satisfied, extended or cancelled by this process (a contract test over the timer repository's callers).", { skip }, async () => {
  const j = await chainJourney(); const appId = j.appId;
  const counts = async (id: string) => ({ events: Number((await db.query<{ c: string }>(`SELECT count(*)::text AS c FROM loan_events WHERE application_id = $1`, [id]))[0]!.c), journal: (await journal(id)).length, snapshots: Number((await db.query<{ c: string }>(`SELECT count(*)::text AS c FROM funding_snapshots WHERE application_id = $1`, [id]))[0]!.c), loans: Number((await db.query<{ c: string }>(`SELECT count(*)::text AS c FROM loans WHERE origination_application_id = $1`, [id]))[0]!.c) });
  // rule 2 / NO_CLIENT_STATE: a hand-fed object, a *_cents field or a state on `orchestration.step` is refused on the hosted API before anything is written
  const c0 = await counts(appId);
  for (const extra of [{ conditions: [{ condition_id: "c-1", status: "cleared" }] }, { facts: { cd_delivered: true } }, { net_wire_cents: "55685207" }, { state: { step: "funded", status: "open" } }]) {
    const r = await call("POST", `/v1/applications/${appId}/tools/35.6/orchestration.step`, { actor: OPS_ANALYST, input: { op: "retry", ...extra } });
    assert.equal(r.status, 409, JSON.stringify(r.body).slice(0, 400)); assert.equal(r.body["code"], "NO_CLIENT_STATE", JSON.stringify(r.body).slice(0, 400));
  }
  assert.deepEqual(await counts(appId), c0, "refused before any write: no event, no journal row, no snapshot, no loan");
  // rule 5: a closed 25.2 gate at `documents_released` is held{gate_closed}; no 26.1 command ran
  const u = await driveToGateClosed(await newJourney());
  // the row whose NEXT step is documents_released: it stays at cd_delivered, held on the gate the pass asserted before entering
  const o = await row(u.appId); assert.equal(o.step, "cd_delivered", JSON.stringify(o)); assert.equal(o.status, "held", JSON.stringify(o)); assert.equal(o.hold_reason, "gate_closed"); assert.equal(o.waiting_on, "REGZ_1026_19F1_CD_3SBD_GATE", JSON.stringify(o));
  const jl = await journal(u.appId);
  const refused = jl.find((x) => x.kind === "command_refused" && x.command_process === "25.2" && x.command_name === "assertGateOpen"); assert.ok(refused, JSON.stringify(jl.slice(-6).map((x) => [x.step, x.kind, x.command_process, x.command_name, x.refusal_code])));
  // no 26.1 command ran behind the closed gate: none of 26.1's document-generation commands at all, and no 26.1 command after the refusal (26.1 computeNoteTerms for the CD's figures ran earlier, before the gate)
  const docGen = new Set(["evaluateDocGenGates", "takeClosingSnapshot", "renderDocument", "buildSmartDocENote", "runDocumentQc", "releaseToSettlementAgent"]);
  assert.equal(jl.filter((x) => x.kind === "command_run" && x.command_process === "26.1" && docGen.has(String(x.command_name))).length, 0, "no 26.1 document-generation command ran");
  assert.equal(jl.filter((x) => x.kind === "command_run" && x.command_process === "26.1" && x.created_at >= refused.created_at).length, 0, "no 26.1 command after the gate refused");
  assert.equal((await events(u.appId, "closing.documents.released")).length, 0);
  // rule 4 / OFFICER_OVERRIDE_ONLY: an agent's snapshot override on POST /fund is refused with nothing written (no officer approval record)
  const c1 = await counts(appId);
  const f = await call("POST", `/v1/applications/${appId}/fund`, { actor: DISCLOSURES, snapshot: { escrow_analysis: { cushion_cents: "0" } } });
  assert.equal(f.status, 409, JSON.stringify(f.body).slice(0, 400)); assert.equal(f.body["code"], "NO_CLIENT_STATE", JSON.stringify(f.body).slice(0, 300));
  assert.deepEqual(await counts(appId), c1, "the override wrote nothing");
  // NO_CLOCK_EDIT: a contract over the timer repository's callers — nothing under src/domain/operations-runtime or the 35.6 tools satisfies, extends or cancels a timers row
  const files = [...SOURCE_FILES(), fileURLToPath(new URL("../../app/tools/section35-6.ts", import.meta.url))];
  assert.ok(files.length >= 10, `contract scope: ${files.length} files`);
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const bad of [/timers\.(satisfy|extend|cancel|arm|breach)\(/, /\.(satisfyTimer|extendTimer|cancelTimer)\(/, /UPDATE\s+timers\b/i, /DELETE\s+FROM\s+timers\b/i, /INSERT\s+INTO\s+timers\b/i]) assert.ok(!bad.test(text), `${f} touches the timer repository: ${bad}`);
  }
});

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

test("35.6-T16: Given the purchase fixture (Columbus, OH; wet; paper note; the session Wed Nov 18 10:05 ET), when the pass runs Tue Nov 17 16:00 ET, then 26.3 `evaluateFundingConditions{op: pre_signing}` passed the pre-signing subset, the worksheet from the CD nets $412,000.00 − 13 × $71.96 ($935.48) − $1,240.00 + $515.00 = $410,339.52, 27.1's advance is $403,760.00 with partner contribution $6,579.52, the wire released by the FAKE `funding_approver` at 08:55 ET Nov 18 has value date 2026-11-18 (`SM_O73_WET_FUNDS_AT_TABLE_GATE` satisfied before the session), the execution review passed 11:40 ET, the disbursement authorization issued, and `loan.funded{disbursement_date=2026-11-18}`; after boarding the MOM registration is due Nov 25 (`MERS_PROC_MOM_REGISTER_7`) and the wet note's custodian delivery is due Wed Nov 25 (`SM_WH_WET_NOTE_DELIVERY_5BD`, Thanksgiving excluded).", { skip }, async () => {
  const j = await driveOhToDocumentsReleased(); ohChain.j = j; const appId = j.appId;
  const iso = (pg: string): string => new Date(pg.replace(" ", "T").replace(/\+00$/, "Z")).toISOString();
  // Tue Nov 17 15:00 ET: 25.1's disbursement-checkpoint run over the OH snapshot — the fresh gate the pre-signing chain's 25.2 `assertGateOpen` reuses (GATES freshness 4 h)
  await ohComplianceAt(j, EST("2026-11-17", "15:00"), "SM_O61_COMPLIANCE_PASS_DISBURSE_GATE", "cd");
  // when the pass runs Tue Nov 17 16:00 ET: the first pass folds the fixture's log to documents_released; the wet state opens 26.3's calendar on the closing date, evaluates the pre-signing subset from the record, requests the advance (27.1 approves), prepares the wire with value date Nov 18 and waits on the funding_approver
  clock.set(EST("2026-11-17", "16:00")); await pass(clock.now(), appId);
  let o = await row(appId); assert.equal(o.step, "documents_released", await jnOf(appId));
  const funding = (await events(appId, "funding.requested")).at(-1)!; assert.ok(funding, await jnOf(appId)); assert.equal(funding.payload["funding_type"], "wet"); assert.equal(funding.payload["disbursement_date"], "2026-11-18");
  const fc = (await events(appId, "funding.conditions.evaluated")).find((e) => e.payload["subset"] === "pre_signing")!; assert.ok(fc, await jnOf(appId)); assert.equal(fc.payload["passed"], true, JSON.stringify(fc.payload).slice(0, 1200));
  const jl1 = await journal(appId); assert.ok(jl1.some((x) => x.kind === "command_run" && x.command_process === "26.3" && x.command_name === "evaluateFundingConditions" && x.command_op === "pre_signing" && x.step === "documents_released"), "26.3 evaluateFundingConditions{op: pre_signing} ran in documents_released");
  const wsRef = String(((jl1.find((x) => x.kind === "command_run" && x.command_name === "reconcileToSettlementStatement")?.detail["sources"] as P | undefined)?.["worksheet"] as P | undefined)?.["ref"] ?? ""); assert.match(wsRef, /^funding_worksheets:/, await jnOf(appId));
  const wsId = wsRef.slice("funding_worksheets:".length).replace(/:\d+$/, ""); const wsData = await entity("funding_worksheets", wsId); assert.ok(wsData, wsRef); const ws = { id: wsId, data: wsData! };
  const line = (code: string) => BigInt(String((ws.data["lines"] as P[]).find((l) => l["line_code"] === code)!["amount_cents"]));
  assert.equal(BigInt(String(ws.data["gross_loan_cents"])), WORKED_B.note_cents); assert.equal(line("PREPAID_INTEREST"), WORKED_B.prepaid_interest_cents, "13 × $71.96 = $935.48"); assert.equal(line("ESCROW_INITIAL_DEPOSIT"), WORKED_B.escrow_deposit_cents); assert.equal(BigInt(String(ws.data["lender_credits_cents"])), WORKED_B.lender_credit_cents); assert.equal(BigInt(String(ws.data["net_wire_cents"])), WORKED_B.net_wire_cents, "$412,000.00 − $935.48 − $1,240.00 + $515.00 = $410,339.52"); assert.equal(ws.data["reconciled"], true); assert.equal(BigInt(String(ws.data["agent_requested_net_cents"])), WORKED_B.net_wire_cents);
  // 26.3 authorizes no funding before its earliest funding date (BEFORE_EARLIEST_FUNDING_DATE): the row waits on the funding morning; nothing is authorized, signed or released on Nov 17
  o = await row(appId); assert.equal(o.status, "waiting_window", await jnOf(appId)); assert.equal(o.waiting_on, "SM_O73_FUNDING_DATE"); assert.equal((await events(appId, "funding.authorized")).length, 0); assert.equal((await events(appId, "closing.consummated")).length, 0, "nothing signed yet");
  // Wed Nov 18 06:30: 25.1's consummation-checkpoint run (the pre-session check's fresh gate); 08:00 the pass: `requestWarehouseAdvance` on the pre-signing subset → funding.authorized, 27.1's advance approved ($403,760.00; the partner's $6,579.52), the wire prepared with value date Nov 18 → the row waits on the funding_approver
  await ohComplianceAt(j, EST("2026-11-18", "06:30"), "SM_O61_COMPLIANCE_PASS_CONSUMMATE_GATE", "consummation");
  clock.set(EST("2026-11-18", "08:00")); await pass(clock.now(), appId);
  const authorized = (await events(appId, "funding.authorized")).at(-1)!; assert.ok(authorized, await jnOf(appId));
  const approved = (await events(appId, "warehouse.advance.approved")).at(-1)!; assert.ok(approved, await jnOf(appId)); assert.equal(BigInt(String(approved.payload["advance_cents"])), WORKED_B.advance_cents, "0.98 × $412,000.00 = $403,760.00"); assert.equal(BigInt(String(approved.payload["partner_contribution_cents"])), WORKED_B.partner_contribution_cents, "$410,339.52 − $403,760.00 = $6,579.52");
  const prepared = (await events(appId, "funding.wire.prepared")).at(-1)!; assert.ok(prepared, await jnOf(appId)); assert.equal(prepared.payload["value_date"], "2026-11-18"); assert.equal(BigInt(String(prepared.payload["amount_cents"])), WORKED_B.net_wire_cents);
  o = await row(appId); assert.equal(o.step, "documents_released"); assert.equal(o.status, "waiting_human", await jnOf(appId)); assert.equal(o.waiting_on, "funding_approver");
  assert.equal((await events(appId, "funding.wire.released")).length, 0, "the pass never releases");
  // 08:55 the FAKE funding_approver releases the wire (dual control) — value date Nov 18
  clock.set(EST("2026-11-18", "08:55")); const t1 = await reviewers.tick(runtime, clock.now()); assert.ok(t1.actions.some((a) => a.kind === "wire_release" && a.outcome === "approved"), JSON.stringify(t1.actions));
  const released = (await events(appId, "funding.wire.released")).at(-1)!; assert.ok(released); assert.equal(released.actor_kind, "human"); assert.equal(released.actor_role, "funding_approver"); assert.equal(iso(released.occurred_at), EST("2026-11-18", "08:55"));
  const wire = (await entitiesOf("funding_wires", appId)).at(-1) ?? (await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = 'funding_wires' AND id = $1`, [String(prepared.payload["wire_id"])])).map((r) => ({ id: "", data: decodeEntityData(r.data) as P }))[0]!; assert.ok(wire); assert.equal(wire.data["value_date"], "2026-11-18");
  // 09:00 the pass: the bank's acceptance (IMAD) before the session, 27.1's package to the approver; 09:20 the approver's second act books the advance (paper, wet) with the Nov 18 advance date
  clock.set(EST("2026-11-18", "09:00")); await pass(clock.now(), appId);
  const accepted = (await events(appId, "funding.wire.accepted")).at(-1)!; assert.ok(accepted, await jnOf(appId)); assert.match(String(accepted.payload["imad"]), /^20261118/);
  clock.set(EST("2026-11-18", "09:20")); const t2 = await reviewers.tick(runtime, clock.now()); assert.ok(t2.actions.some((a) => a.kind === "warehouse_wire_release" && a.outcome === "approved"), JSON.stringify(t2.actions));
  const adv = (await events(appId, "warehouse.advance.funded")).at(-1)!; assert.ok(adv); assert.equal(adv.payload["advance_date"], "2026-11-18"); assert.equal(adv.payload["note_form"], "paper"); assert.equal(adv.payload["wet"], true); assert.equal(BigInt(String(adv.payload["advance_cents"])), WORKED_B.advance_cents);
  // SM_O73_WET_FUNDS_AT_TABLE_GATE: armed by 26.3's wet calendar (funding.requested{funding_type=wet}), satisfied by the acceptance before the 10:05 signing start; 26.3's own evaluator over the record's facts is open
  const gate = await timers(appId, "SM_O73_WET_FUNDS_AT_TABLE_GATE"); assert.ok(gate.length >= 1, "SM_O73_WET_FUNDS_AT_TABLE_GATE armed"); assert.ok(gate.every((t) => t.status === "satisfied"), JSON.stringify(gate));
  assert.deepEqual(wetFundsAtTableGate({ funding_type: "wet", wire_accepted_at: String(accepted.payload["accepted_at"]), wire_value_date: D("2026-11-18"), closing_date: D("2026-11-18"), signing_start_at: EST("2026-11-18", "10:05"), pre_signing_subset_passed: fc.payload["passed"] === true }), { open: true });
  assert.ok(String(accepted.payload["accepted_at"]) < EST("2026-11-18", "10:05"), "funds at the table before signing start");
  // 09:30 the pre-session checks pass from the record; the row waits on the slot; the session 10:05 — the paper note wet-signed at the table by both signers 10:30/10:31 = consummation (no rescission on a purchase); 10:50 the feed is applied
  clock.set(EST("2026-11-18", "09:30")); await pass(clock.now(), appId);
  o = await row(appId); assert.equal(o.step, "documents_released", await jnOf(appId)); assert.ok((await events(appId, "closing.pre_session_checks.passed")).length >= 1, await jnOf(appId));
  clock.set(EST("2026-11-18", "10:05")); await pass(clock.now(), appId);
  clock.set(EST("2026-11-18", "10:50")); await pass(clock.now(), appId);
  const consummated = (await events(appId, "closing.consummated")).at(-1)!; assert.ok(consummated, await jnOf(appId)); assert.equal(consummated.payload["note_date"], "2026-11-18");
  const noteSigned = (await events(appId, "closing.document.signed")).filter((e) => e.payload["kind"] === "note"); assert.equal(noteSigned.length, 2, "both signers on the paper note"); assert.ok(noteSigned.every((e) => e.payload["signature_method"] === "wet"), "the paper note is wet-signed (single-method)");
  assert.equal((await events(appId, "enote.registered")).length, 0, "no eNote");
  // 11:40 the execution review passed; the wet-state disbursement authorization (the funding number, citing the 11:40 review) to the agent; the agent's disbursement → loan.funded{disbursement_date 2026-11-18}
  clock.set(EST("2026-11-18", "11:40")); await pass(clock.now(), appId);
  const review = (await events(appId, "closing.execution_review.passed")).at(-1)!; assert.ok(review, await jnOf(appId)); assert.equal(iso(review.occurred_at), EST("2026-11-18", "11:40"));
  const auth = (await events(appId, "funding.disbursement.authorized")).at(-1)!; assert.ok(auth, await jnOf(appId)); assert.equal(new Date(String(auth.payload["execution_review_passed_at"])).toISOString(), EST("2026-11-18", "11:40")); assert.ok(String(auth.payload["funding_number"]).startsWith("FN-"));
  const jl2 = await journal(appId); const authRun = jl2.find((x) => x.kind === "command_run" && x.command_name === "notifySettlementAgent" && x.command_op === "disbursement_authorization")!; assert.ok(authRun, await jnOf(appId)); assert.equal(authRun.actor_id, "funder");
  const lf = (await events(appId, "loan.funded")).at(-1)!; assert.ok(lf, await jnOf(appId)); assert.equal(lf.payload["disbursement_date"], "2026-11-18"); assert.equal(String(lf.payload["per_diem_cents"]), String(WORKED_B.per_diem_cents)); assert.equal(String(lf.payload["prepaid_interest_cents"]), String(WORKED_B.prepaid_interest_cents)); assert.equal(Number(lf.payload["prepaid_days"]), WORKED_B.prepaid_days);
  assert.ok(iso(lf.occurred_at) > iso(auth.occurred_at) || lf.sequence > auth.sequence, "the disbursement follows the authorization");
  // after boarding (the same sweep's hand-off from the record): 30.2's loan; the MOM registration due Nov 25 (MERS_PROC_MOM_REGISTER_7: note date + 7 calendar days); the wet note's custodian delivery due Wed Nov 25 (SM_WH_WET_NOTE_DELIVERY_5BD: advance date + 5 servicer business days — Thanksgiving Nov 26 excluded)
  // the hand-off waits on the settlement agent's courier (30.2's OB-015 boards a paper note shipped to the custodian): 12:30 still at the agent; 14:35 the pickup scan (FAKE courier, four hours after the signing) → the snapshot from the record and 30.2's boarding
  clock.set(EST("2026-11-18", "12:30")); await pass(clock.now(), appId); o = await row(appId); assert.equal(o.step, "funded", await jnOf(appId, 24)); assert.equal(o.waiting_on, "settlement_agent"); assert.equal((await events(appId, "loan.boarded")).length, 0);
  for (const at of ["14:35", "15:00"]) { clock.set(EST("2026-11-18", at)); await pass(clock.now(), appId); }
  assert.equal((await events(appId, "custody.paper_note.shipped")).length, 1, await jnOf(appId, 24));
  o = await row(appId); assert.ok(["boarded", "package_frozen", "delivered"].includes(o.step), await jnOf(appId, 24)); assert.equal((await events(appId, "loan.boarded")).length, 1, await jnOf(appId));
  assert.equal(Number((await db.query<{ c: string }>(`SELECT count(*)::text AS c FROM loans WHERE origination_application_id = $1`, [appId]))[0]!.c), 1);
  // rule 6 on the OH record: the hand-off snapshot built from the record alone — no gap, no fixture (the paper custody record, 24.5's hazard and Zone X, 30.3's frozen analysis, 23.4's CD-stage determinations, 26.1's paper note, the MOM MIN)
  const snap = (await db.query<{ gaps: string[]; fixture_used: boolean; sources: P }>(`SELECT gaps, fixture_used, sources FROM funding_snapshots WHERE application_id = $1 ORDER BY created_at DESC LIMIT 1`, [appId]))[0]!; assert.ok(snap, "funding_snapshots row"); assert.deepEqual(snap.gaps, [], JSON.stringify(snap.sources).slice(0, 1500)); assert.equal(snap.fixture_used, false);
  assert.equal((await events(appId, "mi.activation.requested")).length, 1, "24.6's activation requested at the note date (30.2's OB-009)");
  const mom = await timers(appId, "MERS_PROC_MOM_REGISTER_7"); assert.ok(mom.length >= 1, "MERS_PROC_MOM_REGISTER_7 armed by closing.consummated{anchor_date}"); assert.ok(mom.every((t) => t.due_date === "2026-11-25"), JSON.stringify(mom));
  const wet5 = await timers(appId, "SM_WH_WET_NOTE_DELIVERY_5BD"); assert.ok(wet5.length >= 1, "SM_WH_WET_NOTE_DELIVERY_5BD armed by warehouse.advance.funded{note_form=paper, wet=true}"); assert.ok(wet5.every((t) => t.due_date === "2026-11-25" && t.status === "armed"), JSON.stringify(wet5));
});

test("35.6-T17: Given the OH loan delivered Mon Nov 30, certified Tue Dec 1 and the advice dated Wed Dec 2 (price 101.000, LLPA waived, interest due lender $70.10, net wire $416,190.10) with the matching bank credit, when the pass runs, then the payoff is $404,852.72 (principal $403,760.00 + 14 days' interest $1,067.72 + $25.00), cost recovery $2,774.00, SM retained $831.00 (premium $4,120.00 − lender credit $515.00 − LLPA $0.00 − costs $2,774.00), partner residual $7,732.38, `purchase_reconciliations.status = reconciled`, `warehouse.bailee_letter.released{effective=2026-12-02}` exists, and `SM_WH_INTERIM_FUNDER_RELEASE_2BD` is armed by 27.2.", { skip }, async () => {
  const j = ohChain.j!; assert.ok(j, "T16's OH journey"); const appId = j.appId; let o = await row(appId); const loanId = o.loan_id!; assert.ok(loanId, JSON.stringify(o));
  const iso = (pg: string): string => new Date(pg.replace(" ", "T").replace(/\+00$/, "Z")).toISOString();
  // the wet note: the settlement agent's courier (FAKE) picks it up the day after the signing, the custodian receives it Fri Nov 20 → 26.2's custody chain and 27.1's trust receipt (`warehouse.note.received`, secured_possession) — SM_WH_WET_NOTE_DELIVERY_5BD satisfied before its Nov 25 due date
  // Fri Nov 20 10:00: 25.1's delivery-checkpoint run over the OH snapshot (the fresh gate 29.3's package assertion reuses); 11:00 the pass
  await ohComplianceAt(j, EST("2026-11-20", "10:00"), "SM_O61_COMPLIANCE_PASS_DELIVERY_GATE", "cd");
  clock.set(EST("2026-11-20", "11:00")); await pass(clock.now(), appId);
  const noteRcvd = (await events(appId, "warehouse.note.received")).at(-1)!; assert.ok(noteRcvd, await jnOf(appId, 24)); assert.equal(noteRcvd.payload["collateral_status"], "secured_possession");
  assert.equal((await events(appId, "custody.paper_note.shipped")).length, 1); assert.equal((await events(appId, "custody.paper_note.received")).length, 1);
  const wet5 = await timers(appId, "SM_WH_WET_NOTE_DELIVERY_5BD"); assert.ok(wet5.length >= 1 && wet5.every((t) => t.status === "satisfied"), JSON.stringify(wet5));
  // 29.3's package froze; 29.4's registration carries the custodian and the bailee letter; the operator's submission waits on the officer's signature of the letter (the paper package ships the day of submission under it)
  o = await row(appId); assert.equal(o.step, "package_frozen", await jnOf(appId, 24)); assert.equal(o.status, "waiting_human"); assert.equal(o.waiting_on, "officer"); assert.equal((await events(appId, "delivery.submitted")).length, 0);
  // 27.1's bailee letter — rendered by the pass from the facility's administered Letter Name (byte-for-byte) listing this advance, routed to a human officer{sm}; the pass never signs it; the officer signs Mon Nov 30 08:30
  const letterId = `BL-${appId.slice(0, 8)}`; const letter = (await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = 'bailee_letters' AND id = $1`, [letterId])).map((r) => decodeEntityData(r.data) as P)[0]!;
  const advanceId = String((await events(appId, "warehouse.advance.funded")).at(-1)!.payload["advance_id"]);
  assert.ok(letter, "27.1 rendered the bailee letter"); assert.equal(letter["letter_name"], FACILITY_FIXTURE.bailee_letter_name); assert.equal(letter["status"], "draft"); assert.ok(((letter["loan_list"] as P[]) ?? []).some((l) => l["advance_id"] === advanceId), "the letter lists this loan's advance");
  const issuedCount = async () => Number((await db.query<{ c: string }>(`SELECT count(*)::text AS c FROM loan_events WHERE type = 'warehouse.bailee_letter.issued' AND payload->>'bailee_letter_id' = $1`, [letterId]))[0]!.c);
  assert.equal(await issuedCount(), 0, "unsigned until a human officer signs");
  clock.set(EST("2026-11-30", "08:30")); await j.tool({ app: appId }, "27.1", "issueBaileeLetter", { op: "sign", facility_id: FACILITY_FIXTURE.facility_id, bailee_letter_id: letterId }, OFFICER);
  assert.equal(await issuedCount(), 1);
  // Mon Nov 30: 29.3's package and 29.4's registration (the custodian and the bailee letter on the delivery), the FAKE operator's submission → delivery.submitted Nov 30; the custodian package (the endorsed original note pre-positioned with the custodian, the cover letter, the bailee letter) under 27.1's shipment release tendered to the FAKE carrier the same day
  const deliveryId = `DLV-${appId.slice(0, 8)}`; fakesFor(runtime).carrier.script(deliveryId, { received_at: EST("2026-12-01", "08:00"), certified_at: EST("2026-12-01", "11:00") });
  for (const at of ["09:00", "09:30", "10:00", "10:30"]) { clock.set(EST("2026-11-30", at)); await pass(clock.now(), appId); }
  const submitted = (await events(appId, "delivery.submitted")).at(-1)!; assert.ok(submitted, await jnOf(appId, 24)); assert.equal(iso(submitted.occurred_at).slice(0, 10), "2026-11-30", "delivered Mon Nov 30");
  // 29.4's row (the `deliveries` kind is shared with 25.2's UCD projection — keyed by delivery id)
  const delivery = (await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = 'deliveries' AND data->>'delivery_id' = $1`, [deliveryId])).map((r) => ({ id: deliveryId, data: decodeEntityData(r.data) as P }))[0]!; assert.ok(delivery, "29.4's delivery row"); assert.equal(delivery.data["note_form"], "paper"); assert.equal(delivery.data["bailee_letter_id"], letterId); assert.equal(delivery.data["custodian_fin"], "900000017");
  const shipped = (await events(appId, "custody.package.shipped")).at(-1)!; assert.ok(shipped, await jnOf(appId, 24)); assert.equal(shipped.payload["custody_mode"], "pre_positioned_at_fcc"); assert.equal(shipped.payload["carrier"], "FAKE");
  assert.equal((await events(appId, "warehouse.note.shipment_released")).length, 1, "27.1's shipment under the bailee letter (SM_WH_BAILEE_LETTER_GATE)");
  const jl = await journal(appId); const pkg = jl.find((x) => x.kind === "command_run" && x.command_process === "29.4" && x.command_name === "prepareCustodianPackage")!; assert.ok(pkg, await jnOf(appId, 24)); assert.equal(pkg.actor_id, "secondary");
  const endorsement = (await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = 'note_endorsements' AND id = $1`, [`END-${appId.slice(0, 8)}`])).map((r) => decodeEntityData(r.data) as P)[0]!; assert.ok(endorsement, "26.4: the note endorsed in blank (a pre-executed allonge) by the FAKE signing_officer before shipment"); assert.equal(endorsement["endorsee"], "blank"); assert.equal(endorsement["method"], "allonge_pre_executed"); assert.equal(endorsement["signing_officer_party_id"], "FAKE:signing_officer"); assert.equal(endorsement["signature_kind"], "wet");
  const endorseRun = jl.find((x) => x.kind === "command_run" && x.command_process === "26.4" && x.command_op === "ensure_endorsement")!; assert.ok(endorseRun); assert.equal(endorseRun.actor_kind, "human"); assert.equal(endorseRun.actor_role, "signing_officer");
  // Tue Dec 1: the custodian's receipt 08:00 and certification 11:00 (the carrier's and custodian's FAKE scans) → custody.certified Dec 1; 27.2 registered from the record, the forecast posted, the Sellers API polled (no advice yet)
  clock.set(EST("2026-12-01", "12:00")); await pass(clock.now(), appId);
  const cert = (await events(appId, "custody.certified")).find((e) => e.payload["certified_on"] !== undefined)!; assert.ok(cert, await jnOf(appId, 24)); assert.equal(cert.payload["certified_on"], "2026-12-01"); assert.equal(cert.payload["certification_kind"], "certified"); assert.equal(cert.payload["bailee_validation"], "passed");
  o = await row(appId); assert.equal(o.step, "certified", await jnOf(appId, 24)); assert.equal(o.waiting_on, "sellers_api");
  assert.equal((await entitiesOf("settlement_loans", appId)).length + (await db.query<{ c: string }>(`SELECT count(*)::text AS c FROM entity_current WHERE kind = 'settlement_loans' AND data->>'loan_id' = $1`, [loanId])).length, 2, "27.2 registered the loan from the record");
  // 27.1's daily accruals Nov 18 → Dec 1 (the sweep's 27.1 cycle): 14 days on $403,760.00 at SOFR 4.30% + 250 bps act/360 = $1,067.72
  await accrueOhAdvance(j);
  // Wed Dec 2 09:00: the FAKE Sellers API's advice (price 101.000, LLPA waived, interest due lender $70.10, net $416,190.10, purchase date Dec 2) → the pass polls from 29.4's expected purchase date, 29.4 ingests the SAME 27.2 row → loan.purchased, 30.1 matches; the row waits on the collection bank
  const fnma = String(submitted.payload["fnma_loan_number"]); const sln = (await db.query<{ n: string }>(`SELECT servicer_loan_number AS n FROM loans WHERE id = $1`, [loanId]))[0]!.n;
  const fakes = settlementFakes(); fakes.advices.queue(fnmaAdviceB(fnma, sln));
  clock.set(EST("2026-12-02", "09:00")); await pass(clock.now(), appId);
  const purchased = (await events(appId, "loan.purchased")).at(-1)!; assert.ok(purchased, await jnOf(appId, 24)); assert.equal(purchased.loan_id, loanId);
  const paId = `pa-${fnma}-2026-12-02`; const row272 = (await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = 'purchase_advices' AND id = $1`, [paId])).map((r) => decodeEntityData(r.data) as P)[0]!; assert.ok(row272, await jnOf(appId, 24));
  assert.equal(BigInt(String(row272["net_proceeds_cents"])), WORKED_B.net_proceeds_cents); assert.equal(BigInt(String(row272["gross_price_proceeds_cents"])), WORKED_B.gross_proceeds_cents); assert.equal(BigInt(String(row272["llpa_total_cents"])), 0n, "LLPA waived (HomeReady)"); assert.equal(row272["price"], "101.000");
  const received272 = (await events(appId, "purchase_advice.received")).find((e) => e.payload["purchase_advice_id"] === paId)!; assert.ok(received272); assert.equal(String(received272.payload["interest_adjustment_cents"]), String(WORKED_B.interest_due_lender_cents), "+$70.10 due the lender (1 day past the LPI at PTR 6.125%, 30/360)");
  o = await row(appId); assert.equal(o.step, "purchased", await jnOf(appId, 24)); assert.equal(o.waiting_on, "collection_bank");
  // 14:00 the matching bank credit; 14:05 the pass: 27.2 keys and matches it, the three sides agree, the waterfall posts the payoff and the residuals, the bailee letter is released on payment, the row completes
  fakes.bank.queue(bankCreditB(fnma, sln, j.R, WORKED_B.net_proceeds_cents));
  clock.set(EST("2026-12-02", "14:05")); await pass(clock.now(), appId);
  const matched = (await events(appId, "proceeds.matched")).at(-1)!; assert.ok(matched, await jnOf(appId, 24)); assert.equal(matched.payload["status"], "matched"); assert.equal(String(matched.payload["variance_cents"]), "0");
  const wf = (await events(appId, "settlement.waterfall.posted")).at(-1)!; assert.ok(wf, await jnOf(appId, 24));
  assert.equal(BigInt(String(wf.payload["payoff_total_cents"])), WORKED_B.payoff_cents, "payoff $404,852.72 = principal $403,760.00 + 14 days' interest $1,067.72 + $25.00");
  assert.equal(BigInt(String(wf.payload["sm_cost_recovery_cents"])), WORKED_B.sm_cost_recovery_cents, "cost recovery $2,774.00"); assert.equal(BigInt(String(wf.payload["sm_retained_residual_cents"])), WORKED_B.sm_retained_cents, "SM retained $831.00 = premium $4,120.00 − lender credit $515.00 − LLPA $0.00 − costs $2,774.00"); assert.equal(BigInt(String(wf.payload["partner_residual_cents"])), WORKED_B.partner_residual_cents, "partner residual $7,732.38");
  const wfRow = (await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = 'settlement_waterfalls' AND data->>'waterfall_id' = $1`, [String(wf.payload["waterfall_id"])])).map((r) => decodeEntityData(r.data) as P)[0]!; assert.ok(wfRow, "27.2's waterfall row");
  assert.equal(BigInt(String(wfRow["advance_principal_cents"])), WORKED_B.advance_cents); assert.equal(BigInt(String(wfRow["accrued_interest_cents"])), WORKED_B.warehouse_interest_cents); assert.equal(BigInt(String(wfRow["warehouse_fees_cents"])), WORKED_B.wire_fee_cents);
  const recon = (await db.query<P>(`SELECT status, sides, advice_net_proceeds_cents::text AS adv, investor_net_proceeds_cents::text AS inv, bank_received_cents::text AS bank, warehouse_payoff_cents::text AS payoff, sm_retained_cents::text AS retained, partner_residual_cents::text AS residual, interest_adjustment_cents::text AS int FROM purchase_reconciliations WHERE loan_id = $1`, [loanId]));
  assert.equal(recon.length, 1, await jnOf(appId, 24)); assert.equal(recon[0]!["status"], "reconciled"); assert.deepEqual(recon[0]!["sides"], { "29.4": "reconciled", "30.1": "matched", "27.2": "matched" });
  assert.equal(recon[0]!["adv"], String(WORKED_B.net_proceeds_cents)); assert.equal(recon[0]!["inv"], String(WORKED_B.net_proceeds_cents)); assert.equal(recon[0]!["bank"], String(WORKED_B.net_proceeds_cents)); assert.equal(recon[0]!["payoff"], String(WORKED_B.payoff_cents)); assert.equal(recon[0]!["retained"], String(WORKED_B.sm_retained_cents)); assert.equal(recon[0]!["residual"], String(WORKED_B.partner_residual_cents)); assert.equal(recon[0]!["int"], String(WORKED_B.interest_due_lender_cents));
  const repaid = (await events(appId, "warehouse.advance.repaid")).at(-1)!; assert.ok(repaid); assert.equal(repaid.payload["note_form"], "paper"); assert.equal(repaid.payload["repaid_from"], "purchase_proceeds");
  const rel = (await events(appId, "warehouse.bailee_letter.released")).at(-1)!; assert.ok(rel, "warehouse.bailee_letter.released exists"); assert.equal(rel.payload["bailee_letter_id"], letterId); assert.ok(String(rel.payload["released_at"]).startsWith("2026-12-02T"), `effective 2026-12-02: ${String(rel.payload["released_at"])}`); assert.equal(rel.payload["letter_status"], "released");
  const ifr = await timers(appId, "SM_WH_INTERIM_FUNDER_RELEASE_2BD"); assert.ok(ifr.length >= 1, "SM_WH_INTERIM_FUNDER_RELEASE_2BD armed by 27.2's warehouse.advance.repaid{note_form=paper}"); assert.ok(ifr.every((t) => t.status === "armed" && t.due_date === "2026-12-04"), JSON.stringify(ifr));
  o = await row(appId); assert.equal(o.step, "completed", await jnOf(appId, 24)); assert.equal((await events(appId, "orchestration.purchase.reconciled")).length, 1); assert.equal((await events(appId, "orchestration.completed")).length, 1);
});

test("35.6-T18: Given the sweep at 06:00 ET, then 35.3's `closing_orchestration_daily` unit ran `orchestration.pass{op: daily_receipt}` once, `orchestration_daily_receipts` has one row for the date with `open`, `waiting_human`, `waiting_vendor`, `waiting_borrower`, `waiting_window`, `held`, `completed_today` and `fixture_used_today` matching a direct count of `closing_orchestrations`, `orchestration.daily.run_completed` satisfied and re-armed `SM_ORCH_OPEN_BOOK_DAILY` on the global subject (one armed instance), the board document is a 35.2 row, and `orchestration.board` returns every open row with `step`, `status`, `waiting_on`, the next owning clock due and the advance's dwell day.", { skip }, async () => {
  // an earlier platform day's receipt so the recurring clock has an armed instance to satisfy and re-arm (35.3's cycle runs daily; the first receipt arms it)
  clock.set(EST("2026-11-19", "06:00")); await runtime.sweep(clock.now(), { verify: false });
  const asOf = "2026-11-20"; const dayStart = EST("2026-11-20", "00:00");
  const openCount = async () => Number((await db.query<{ c: string }>(`SELECT count(*)::text AS c FROM closing_orchestrations WHERE status NOT IN ('completed', 'unwound', 'cancelled')`))[0]!.c);
  clock.set(EST("2026-11-20", "06:00")); await runtime.sweep(clock.now(), { verify: false });
  // 35.3's closing_orchestration_daily unit ran orchestration.pass{op: daily_receipt} once: one row for the date; a second sweep the same day writes nothing more
  clock.set(EST("2026-11-20", "06:05")); await runtime.sweep(clock.now(), { verify: false });
  const receipts = await db.query<P>(`SELECT * FROM orchestration_daily_receipts WHERE as_of_date = $1`, [asOf]); assert.equal(receipts.length, 1, "one receipt row for the date");
  const r = receipts[0]!;
  const byStatus = Object.fromEntries((await db.query<{ status: string; c: string }>(`SELECT status, count(*)::text AS c FROM closing_orchestrations GROUP BY status`)).map((x) => [x.status, Number(x.c)]));
  assert.equal(Number(r["open"]), await openCount(), "open = a direct count of the open rows");
  for (const k of ["waiting_human", "waiting_vendor", "waiting_borrower", "waiting_window", "held"] as const) assert.equal(Number(r[k]), byStatus[k] ?? 0, `${k} matches a direct count`);
  assert.equal(Number(r["completed_today"]), Number((await db.query<{ c: string }>(`SELECT count(*)::text AS c FROM closing_orchestrations WHERE status = 'completed' AND completed_at >= $1::timestamptz`, [dayStart]))[0]!.c));
  assert.equal(Number(r["fixture_used_today"]), Number((await db.query<{ c: string }>(`SELECT count(*)::text AS c FROM funding_snapshots WHERE fixture_used AND built_at >= $1::timestamptz`, [dayStart]))[0]!.c));
  // orchestration.daily.run_completed once for the date; it satisfied the armed SM_ORCH_OPEN_BOOK_DAILY and re-armed it on the global subject — one armed instance
  const daily = await db.query<{ payload: P }>(`SELECT payload FROM loan_events WHERE type = 'orchestration.daily.run_completed' AND payload->>'as_of_date' = $1`, [asOf]); assert.equal(daily.length, 1);
  const clocks = await db.query<{ status: string; subject_kind: string; subject_id: string; due_at: string | null }>(`SELECT status::text AS status, subject_kind, subject_id, due_at::text AS due_at FROM timers WHERE code = 'SM_ORCH_OPEN_BOOK_DAILY' ORDER BY armed_at`);
  assert.equal(clocks.filter((t) => t.status === "armed").length, 1, JSON.stringify(clocks)); assert.ok(clocks.some((t) => t.status === "satisfied"), JSON.stringify(clocks));
  for (const t of clocks) assert.equal(t.subject_kind, "global", JSON.stringify(t));
  // the board document is a 35.2 row
  assert.ok(r["report_document_id"], "report_document_id"); const doc = (await db.query<{ kind: string; retention_class: string }>(`SELECT kind, retention_class::text AS retention_class FROM documents WHERE id = $1`, [r["report_document_id"]]))[0]!; assert.ok(doc, "documents row"); assert.equal(doc.kind, "closing_board_daily");
  // orchestration.board (a read; the Closing screen's rows): every open row with step, status, waiting_on, the next owning clock due and the advance's dwell day
  const board = await call("POST", `/v1/tools/35.6/orchestration.board`, { actor: OPS_ANALYST, input: { at: clock.now() } }); assert.equal(board.status, 200, JSON.stringify(board.body).slice(0, 400));
  const rows = (board.body["output"] as P)["rows"] as P[]; assert.equal(rows.length, await openCount(), "every open row");
  for (const b of rows) { for (const k of ["application_id", "step", "status", "waiting_on", "next_clock", "advance_dwell_days"]) assert.ok(k in b, `board row has ${k}: ${JSON.stringify(b)}`); }
  const withAdvance = rows.filter((b) => b["advance_dwell_days"] !== null); for (const b of withAdvance) assert.ok(Number(b["advance_dwell_days"]) >= 0);
  assert.ok(rows.some((b) => b["next_clock"] !== null && typeof (b["next_clock"] as P)["code"] === "string"), "an open row names its next owning clock");
});

test("35.6-T19: Given a row at `funded` on the demo clock at 2026-11-12 and `POST /v1/demo/advance{days: 3}`, then the pass ran inline per crossed day: `loan.staged`/`loan.boarded` dated 2026-11-12, `delivery.package.frozen` dated 2026-11-13, the operator task's SLA 2026-11-16 15:00 MT, `SM_ORCH_HANDOFF_AFTER_FUNDED_4H` and `SM_ORCH_DELIVERY_OPEN_2BD` satisfied, and `closing_orchestration_steps.sweep_run_id` differs per day.", { skip }, async () => {
  // a fresh journey funded Thu Nov 12 by the platform's own sweep (its run id is that day's): loan.funded, the hand-off (loan.staged/loan.boarded dated Nov 12) and the boarded step held on 25.2's delivery gate — no 25.1 delivery-checkpoint run yet
  const d = await driveTo(await newJourney(), "wire_released"); const appId = d.appId;
  clock.set(EST("2026-11-12", "13:01")); await reviewers.tick(runtime, clock.now());
  clock.set(EST("2026-11-12", "13:05")); const day1 = await runtime.sweep(clock.now(), { verify: false }); assert.ok(day1);
  let o = await row(appId); assert.ok(o.loan_id, `funded and handed off by the Nov 12 sweep: ${JSON.stringify(o)}`); assert.equal(o.step, "boarded", JSON.stringify(o));
  // 25.1's delivery checkpoint (the compliance tester's run) lands after that sweep — the new fact the Nov 13 pass releases the gate on
  await complianceAt(d, EST("2026-11-12", "16:30"), "SM_O61_COMPLIANCE_PASS_DELIVERY_GATE", "cd");
  // the demo clock at 2026-11-12 (13:10 ET); POST /v1/demo/advance{days: 3} walks Fri Nov 13, Sat Nov 14 and the target through the sweep minute, the pass inline per crossed day
  const demo = demoRuntimeAt(EST("2026-11-12", "13:10"));
  const report = await advanceDemoClock({ runtime: demo.rt, clock: demo.clock, logger }, { days: 3 });
  assert.equal(report.advanced, true); assert.equal(report.complete, true, JSON.stringify(report).slice(0, 400)); assert.equal(report.days_crossed, 3); assert.equal(report.steps.length, 3);
  assert.deepEqual(report.steps.map((s) => s.date), ["2026-11-13", "2026-11-14", "2026-11-15"]);
  const etDate = (pg: string) => new Date(pg.replace(" ", "T").replace(/\+00$/, "Z")).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const staged = (await events(appId, "loan.staged")).at(-1)!; const boarded = (await events(appId, "loan.boarded")).at(-1)!; assert.ok(staged && boarded, "loan.staged / loan.boarded");
  assert.equal(etDate(staged.occurred_at), "2026-11-12"); assert.equal(etDate(boarded.occurred_at), "2026-11-12");
  const frozen = (await events(appId, "delivery.package.frozen")).at(-1)!; assert.ok(frozen, `delivery.package.frozen: ${JSON.stringify((await journal(appId)).slice(-8).map((x) => [x.step, x.kind, x.command_process, x.command_name, x.error_class, x.refusal_code, x.detail["message"] ?? x.detail["reason"] ?? x.detail["gap"] ?? null]))}`);
  assert.equal(etDate(frozen.occurred_at), "2026-11-13");
  const dlv = (await entitiesOf("deliveries", appId)).find((x) => typeof x.data["delivery_id"] === "string")!; assert.ok(dlv, "29.4's delivery");
  const task = (await entitiesByDelivery("delivery_operator_tasks", String(dlv.data["delivery_id"]))).find((t) => t.data["kind"] === "import_and_submit")!; assert.ok(task, "the operator task"); assert.equal(task.data["sla_due_at"], MST("2026-11-16", "15:00"));
  for (const code of ["SM_ORCH_HANDOFF_AFTER_FUNDED_4H", "SM_ORCH_DELIVERY_OPEN_2BD"]) { const t = await timers(appId, code); assert.ok(t.length >= 1, code); for (const x of t) assert.equal(x.status, "satisfied", `${code}: ${JSON.stringify(t)}`); }
  // the row left package_frozen behind the operator's SLA; under INTEGRATIONS=fake the FAKE fnma_portal_operator acts after its delay, so a demo day may already have carried the row to delivered/certified (rule 4)
  o = await row(appId); assert.ok(["package_frozen", "delivered", "certified"].includes(o.step), JSON.stringify(o)); if (o.step === "package_frozen") { assert.equal(o.status, "waiting_human"); assert.equal(o.waiting_on, "fnma_portal_operator"); }
  // closing_orchestration_steps.sweep_run_id differs per day: the Nov 12 sweep's rows and the Nov 13 demo step's rows carry different sweep runs (sweep_runs.as_of_date names each run's day; created_at is wall-clock)
  const runs = await db.query<{ day: string; run_id: string }>(`SELECT DISTINCT r.as_of_date::text AS day, s.sweep_run_id::text AS run_id FROM closing_orchestration_steps s JOIN sweep_runs r ON r.id = s.sweep_run_id WHERE s.orchestration_id = $1 ORDER BY day`, [o.id]);
  const byDay = new Map<string, Set<string>>(); for (const r of runs) { if (!byDay.has(r.day)) byDay.set(r.day, new Set()); byDay.get(r.day)!.add(r.run_id); }
  assert.ok(byDay.has("2026-11-12") && byDay.has("2026-11-13"), JSON.stringify(runs));
  for (const id of byDay.get("2026-11-13")!) assert.ok(!byDay.get("2026-11-12")!.has(id), `the Nov 13 step ran under a different sweep than Nov 12: ${JSON.stringify(runs)}`);
});
