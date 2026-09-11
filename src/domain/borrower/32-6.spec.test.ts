// 32.6 Decision, property, title, insurance, MI, clear to close
// spec/sections/32-borrower-experience/32-6-decision-property-title-insurance-mi-clear-to-close.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// Every T-id drives the real runtime over HTTP (the journey fixture: 20.x → 21.1 → 21.2 → 21.4 → 22.x → 23.x → 24.1,
// then the owning sections' own bus tools — 21.6 decisions, 23.3 letters / CTC, 24.2 appraisal copy, 24.3 project
// docs, 24.5 hazard and flood, 24.6 MI, 25.2 CD, 26.2 scheduling, 28.1 QC — through the real Timer Engine and Notice
// Registry) with the borrower flow of src/runtime/borrower/flows/6-decision-property.ts reacting to the committed
// events, then reads the borrower API (record, thread, cards) and the tables. What the borrower SEES of these facts —
// the Property labels, the MI columns with their cancellation lines, the deficiency line naming one element, the
// "final review" copy without "QC", the Clear-to-close badge — is asserted on the real components in
// apps/borrower/tests/cards/flow-6-decision-property.test.tsx. Skips without a database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { connect, reachable, type Db } from "../../infra/db/client.ts";
import { acquireJourneyLock, type TestLock } from "../../infra/db/test-lock.ts";
import { decodeEntityData } from "../../infra/db/entities.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock, MemoryEventStore } from "../../kernel/events/index.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { Runtime } from "../../runtime/app.ts";
import { createApiServer, listen } from "../../runtime/server.ts";
import { createLogger } from "../../runtime/log.ts";
import { createBorrowerRouter, type BorrowerRouter } from "../../runtime/borrower/routes.ts";
import { Journey, MST, EDT, MLO } from "../../runtime/borrower/fixtures/journey.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { createCasefile } from "../underwriting/ops-23-1.ts";
import { NO_CU_FLAGS, regBCopyGate, earliestConsummation } from "../property/ops-24-2.ts";
import { conditionOwners, miPlanColumns, DEFICIENCY_ELEMENT, HOA_SENDS_TO_OWNER } from "../../runtime/borrower/flows/6-decision-property.ts";

const DB_URL = process.env["TEST_DATABASE_URL"] ?? "postgresql://sm:sm@localhost/supermortgage_test";
const up = await reachable(DB_URL);
if (!up && process.env["REQUIRE_DB"]) throw new Error(`REQUIRE_DB set but ${DB_URL} is not reachable`);
const skip = up ? false : `no Postgres at ${DB_URL}`;
const TOKEN = "ops-" + randomUUID();
const clock = new FixedClock("2026-09-10T16:00:00.000Z");
const UNDERWRITER = { kind: "agent" as const, id: "underwriter" }; const REVIEWER = { kind: "human" as const, id: "u-uwr-1", role: "underwriting_reviewer" }; const VALUATION = { kind: "agent" as const, id: "valuation" }; const CLOSER = { kind: "agent" as const, id: "title-closing" }; const DISCLOSURE = { kind: "agent" as const, id: "disclosure" }; const INTAKE = { kind: "agent" as const, id: "intake" }; const FRAUD_RISK = { kind: "agent" as const, id: "fraud-risk" }; const VERIFICATION = { kind: "agent" as const, id: "verification" }; const PRICING = { kind: "agent" as const, id: "pricing" }; const QC_AGENT = { kind: "agent" as const, id: "qc-audit" };   // 28.1 QC_AGENT (ops-28-1.ts), spelled with the fixture's exact-optional Actor shape
const COPY_LIBRARY = readFileSync(fileURLToPath(new URL("../../../docs/ux/12-message-copy-library.md", import.meta.url)), "utf8");
/** The copy library's sentence for a key (the app renders exactly this through lib/copy). */
const copyText = (key: string): string => { const m = new RegExp("^- `" + key.replace(/\./g, "\\.") + "` — [^—]+ — \"([^\"]+)\"", "m").exec(COPY_LIBRARY); assert.ok(m, `copy key ${key} is in the library`); return m![1]!; };

let journeyLock: TestLock | undefined;
let db: Db; let runtime: Runtime; let router: BorrowerRouter; let base = ""; let close: () => Promise<void> = async () => undefined; let partnerPartyId = "";

test.before(async () => {
  if (skip) return;
  journeyLock = await acquireJourneyLock(DB_URL);
  execFileSync(fileURLToPath(new URL("../../../db/migrate.sh", import.meta.url)), { env: { ...process.env, DATABASE_URL: DB_URL }, stdio: "pipe" });
  db = connect(DB_URL);
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock });
  const logger = createLogger("json", (line) => { if (process.env["FLOW_DEBUG"] && /flow|ERROR|reason/.test(line)) process.stderr.write(line + "\n"); });
  router = createBorrowerRouter({ runtime, logger, environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost"], urlSecret: "test-secret" });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger, console: false, borrowerRouter: router });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => server.close(() => db.end().then(() => resolve())));
  const partner = await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id) VALUES ('servicer', $1, '123456789', '1000123') RETURNING id`, [`Partner Bank ${randomUUID().slice(0, 8)}`]);
  partnerPartyId = partner[0]!.id;
});
test.after(async () => { if (!skip) { await close(); await journeyLock?.release(); } });

// ---------------------------------------------------------------- helpers over the borrower API and the flows
type Reply = { status: number; body: Record<string, unknown> };
async function api(method: string, path: string, body?: unknown, token?: string): Promise<Reply> {
  const r = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text(); return { status: r.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}
async function signIn(email: string): Promise<{ token: string; party_id: string }> {
  const req = await api("POST", "/v1/borrower/auth/otp", { action: "request", channel: "email", destination: email });
  const ver = await api("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: req.body["challenge_id"], code: req.body["fake_code"] });
  assert.equal(ver.status, 200, JSON.stringify(ver.body));
  return { token: ver.body["token"] as string, party_id: (ver.body["party"] as { party_id: string }).party_id };
}
const settle = () => router.flows!.settle();
const record = async (email: string, subject: string): Promise<Record<string, unknown>> => { await settle(); const r = await api("GET", `/v1/borrower/record?subject=${subject}`, undefined, (await signIn(email)).token); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 600)); return r.body; };
const thread = async (email: string): Promise<{ messages: Record<string, unknown>[]; pinned: Record<string, unknown> | null }> => { await settle(); const r = await api("GET", "/v1/borrower/thread?limit=500", undefined, (await signIn(email)).token); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300)); return { messages: r.body["messages"] as Record<string, unknown>[], pinned: (r.body["pinned_card"] as Record<string, unknown> | null) ?? null }; };
interface CardRow { card_instance_id: string; party_id: string; kind: string; status: string; copy_key: string; props: Record<string, unknown>; evidence: Record<string, unknown> | null; command_ref: string | null; expires_at: string | null; created_at: string; resolved_at: string | null }
const cardsOf = async (appId: string, partyId?: string): Promise<CardRow[]> => { await settle(); return db.query<CardRow & Record<string, unknown>>(`SELECT card_instance_id, party_id, kind, status, copy_key, props, evidence, command_ref, expires_at, created_at, resolved_at FROM card_instances WHERE subject_application_id = $1 AND ($2::uuid IS NULL OR party_id = $2) ORDER BY created_at, card_instance_id`, [appId, partyId ?? null]); };
const events = (appId: string, type?: string) => db.query<{ type: string; occurred_at: string; sequence: string; payload: Record<string, unknown> }>(`SELECT type, occurred_at, sequence::text AS sequence, payload FROM loan_events WHERE application_id = $1 AND ($2::text IS NULL OR type = $2) ORDER BY sequence`, [appId, type ?? null]);
const timer = async (appId: string, code: string) => (await db.query<{ status: string; due_at: string | null; due_date: string | null }>(`SELECT status::text AS status, due_at, due_date::text AS due_date FROM timers WHERE application_id = $1 AND code = $2 ORDER BY armed_at DESC LIMIT 1`, [appId, code]))[0];
const entity = async (kind: string, id: string): Promise<Record<string, unknown> | null> => { const rows = await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = $1 AND id = $2`, [kind, id]); return rows[0] ? decodeEntityData(rows[0].data) : null; };
const entitiesOf = async (kind: string, appId: string): Promise<{ id: string; data: Record<string, unknown> }[]> => { const rows = await db.query<{ id: string; data: unknown }>(`SELECT DISTINCT ON (kind, id) id, data FROM entity_records WHERE kind = $1 AND application_id = $2 ORDER BY kind, id, version DESC`, [kind, appId]); return rows.map((r) => ({ id: r.id, data: decodeEntityData(r.data) })); };
const resolveCard = async (email: string, cardId: string, body: Record<string, unknown>): Promise<Reply> => api("POST", `/v1/borrower/cards/${cardId}/resolve`, body, (await signIn(email)).token);
/** One application on the shared runtime: its own journey instance with both borrowers signed in so their cards have a conversation. */
async function openApp(): Promise<{ j: Journey; A: string; B: string; partyA: string; partyB: string }> {
  const R = randomUUID().slice(0, 8); const A = `alex-${R}@example.test`; const B = `blake-${R}@example.test`;
  const j = new Journey({ runtime, db, base, token: TOKEN, clock, borrowerEmail: A, coBorrowerEmail: B, partnerPartyId });
  await j.seedBook(); await j.openApplication();
  const partyA = (await signIn(A)).party_id; const partyB = (await signIn(B)).party_id;
  await j.interview(); await settle();
  return { j, A, B, partyA, partyB };
}
/** Through the lock and the conditional approval (Oct 7): the journey's a6–a9 phases. */
async function throughApproval(j: Journey): Promise<void> { await j.quoteAndLe(); await j.recordIntent(); await j.quoteForLock(); await j.requestLock(); await j.executeLockAndCommit(); await j.verifyDecideAndClear(); await settle(); }
/** 21.6's decision file for an application of this fixture (the applicants as 21.6 knows them: the interview's own borrower ids). */
const decisionFile = (A: string, B: string) => ({ partner_name: "Partner Bank", partner_address: "100 Partner Plaza, Phoenix, AZ 85004", creditor_time_zone: "America/Phoenix", application_date: "2026-10-05", property_state: "AZ",
  applicants: [{ id: "B1", name: "Alex Borrower", mailing_address: "100 N Central Ave, Phoenix AZ 85004", email: A, esign_consent: true, primary: true }, { id: "B2", name: "Blake Borrower", mailing_address: "100 N Central Ave, Phoenix AZ 85004", email: B, esign_consent: true, primary: false }],
  lock_id: null, original_terms: { loan_amount_cents: "56000000", note_rate: "6.125", product_code: "FNMA30", ltv: "70.0" } });
const RECIPIENT = (partyId: string, name: string, email: string) => ({ partyId, name, mailingAddress: "100 N Central Ave, Phoenix AZ 85004", email, consent: { party_id: partyId, classes: ["origination_decisions", "disclosures.origination", "flood_notice"], disclosure_version: "esign-2026-09", status: "active", consented_on: "2026-10-05", soft_bounces_30d: 0 } });
/** 21.6-T2's failed factors: `dti_max_50` (51.3 %) and `credit_delinquent` — the taxonomy reasons, never the DU message. */
const FACTORS = [
  { rule_id: "dti_max_50", description: "Debt-to-income ratio above the program maximum", threshold: "50.0", observed: "51.3", applicant_ids: ["B1"], evidence_document_ids: ["doc-paystub-1020", "doc-udm-lease"], failed: true, source: "rules" },
  { rule_id: "credit_delinquent", description: "30-day late payment on a revolving account in June 2026 on the refreshed report", threshold: "0", observed: "1", applicant_ids: ["B1"], evidence_document_ids: ["doc-credit-refresh"], failed: true, source: "credit_report" },
  { rule_id: "ltv_max", description: "Loan-to-value within the program maximum", threshold: "97.0", observed: "70.0", applicant_ids: ["B1"], evidence_document_ids: ["doc-appraisal"], failed: false, source: "valuation" }];
const SCORES_B1 = { borrower_id: "B1", score_model: "classic_fico", date: "2026-10-05", range: { min: 300, max: 850 }, applicable_score: 712,
  scores: [{ repository: "efx", bureau: "Equifax", score: 705, model_version: "Equifax Beacon 5.0", key_factors: ["Serious delinquency", "Too many accounts with balances"], inquiries_key_factor: false }, { repository: "exp", bureau: "Experian", score: 712, model_version: "Experian/Fair Isaac Risk Model V2", key_factors: ["Proportion of balances to credit limits on revolving accounts is too high", "Serious delinquency"], inquiries_key_factor: false }, { repository: "tu", bureau: "TransUnion", score: 720, model_version: "TransUnion FICO Risk Score, Classic 04", key_factors: ["Serious delinquency"], inquiries_key_factor: false }] };
const SCORES_B2 = { borrower_id: "B2", score_model: "classic_fico", date: "2026-10-05", range: { min: 300, max: 850 }, applicable_score: 690,
  scores: [{ repository: "efx", bureau: "Equifax", score: 688, model_version: "Equifax Beacon 5.0", key_factors: ["Too many inquiries last 12 months", "Proportion of balances to credit limits on revolving accounts is too high"], inquiries_key_factor: true }, { repository: "exp", bureau: "Experian", score: 695, model_version: "Experian/Fair Isaac Risk Model V2", key_factors: ["Proportion of balances to credit limits on revolving accounts is too high"], inquiries_key_factor: false }, { repository: "tu", bureau: "TransUnion", score: 690, model_version: "TransUnion FICO Risk Score, Classic 04", key_factors: ["Too many accounts with balances"], inquiries_key_factor: false }] };
/** 24.2's refinance package and review checklist (the accepted v1 of the fixture). */
const APPRAISER = "PARTY-APPRAISER-1"; const PARTNER_PARTY = "PARTY-PARTNER";
const PACKAGE = { uad_version: "3.6", has_xml: true, has_pdf: true, has_images: true, lender_client_party_id: PARTNER_PARTY, partner_party_id: PARTNER_PARTY, appraiser_party_id: APPRAISER, ordered_appraiser_party_id: APPRAISER, appraiser_license_active: true, ordered_form: "1004", form: "1004" };
const CHECKLIST = { closed_comparables: 3, adjustments_explained: true, market_conditions_consistent: true, gla_sqft: 2140, application_gla_sqft: 2140, units: 1, application_units: 1, condition_rating: "C3", quality_rating: "Q3", subject_to: false, narrative: "The subject is a well-maintained single-family residence in an established subdivision; sales activity is stable." };
const SSR = (at: string) => ({ gse: "fnma", status: "successful", doc_file_id: "1200000123456", findings: [], cu_score: 1.9, cu_flags: NO_CU_FLAGS, result_at: at, api_correlation_id: "ucdp-fixture" });
const COPY_PAYLOAD = (completion_on: string, earliest: string, address: string, names: string[]) => ({ partner_name: "Partner Bank, N.A.", borrower_names: names, property_address: address, loan_number_last4: "0917", mlo_name: "Jordan Rivera", mlo_nmlsr_id: "987654", contact_phone: "1-800-555-0142", notice_date: completion_on, completion_at: completion_on, earliest_consummation: earliest, consummation_scheduled_on: "2026-11-06", revision: false, includes_rov_disclosure: true, valuation_count: 1, valuations: [{ kind_label: "Uniform Residential Appraisal Report (Form 1004, UAD 3.6)", developed_at: "2026-11-02", version_no: 1 }] });
/** 24.5's Zone AE determination (the refinance property in an SFHA) and its hazard declarations page with a 7 % deductible ($36,400 on $520,000). */
const AE = { certificate_id: "SFHDF-AE-1", zone: "AE", map_panel: "04013C2210M", map_date: "2020-10-16", community_number: "040051", community_name: "City of Phoenix", community_participating: true, program_status: "regular", structures: [{ kind: "principal", in_sfha: true, zone: "AE" }], lol_purchased: true, sfhdf_form_version: "FF-206-FY-21-116", sfhdf_document_id: "DOC-SFHDF-1", vendor_ref: "CTL-9917" };
const CLAUSE_OK = "Partner Bank, N.A., its successors and/or assigns, c/o Supermortgage, P.O. Box 7900, Phoenix AZ 85011"; const TITLE = ["Alex Borrower", "Blake Borrower"];
const hazardPolicy = (over: Record<string, unknown> = {}) => ({ policy_id: "HZ-REFI-1", policy_kind: "hazard", policy_number: "HO-4471-2026", carrier: "Desert Mutual", coverage_dwelling_cents: "52000000", coverage_basis: "replacement_cost", roof_basis: "acv", coverage_form: "special", deductible_cents: "500000", per_peril_deductibles: [{ peril: "windstorm_hail", pct: "2" }], ratings: [{ agency: "am_best", grade: "A" }], mortgagee_clause_text: CLAUSE_OK, named_insureds: TITLE, effective_date: "2026-11-01", expiration_date: "2027-11-01", first_year_premium_cents: "195000", policy_in_force: true, premium_paid_through: "2027-11-01", evidence_kind: "declarations", evidence_document_id: "DOC-HZ-1", ...over });
/** 24.6's four premium plans on the LTV-92 % fixture ($736,000 on $800,000 → 30 % coverage): two insurers on the monthly plan. */
const miQuote = (mi_company_code: string, plan: string, rate_bps: number, quote_id: string) => ({ quote_id, mi_company_code, plan, coverage_pct: 30, coverage_option: "standard", rate_bps, quoted_at: MST("2026-10-08", "09:00"), expires_at: "2027-01-06T23:59:59.000Z" });
const OCTOBER_PLAN = { partner_id: "partner-1", period_month: "2026-10-01", eligible_population: 118, forecast_closings_month: 240, strata: [{ key: "refi_trigger|refinance|primary", volume: 70 }, { key: "organic|purchase|primary", volume: 40 }, { key: "referral|purchase|second_home", volume: 8 }] };

// ═══════════════════════════════════ App A — the refinance fixture: T1 · T12 · T9 · T11 · T5 in lifecycle order
const main: { j?: Journey; A: string; B: string; partyA: string; partyB: string } = { A: "", B: "", partyA: "", partyB: "" };

test("32.6-T1: Given `decision.issued{conditional_approval}`, then `NTC_REGB_1002_9_APPROVAL` renders, Dates shows `valid_until`, and Needed-from-you equals the `waiting_borrower` conditions.", { skip }, async () => {
  const o = await openApp(); Object.assign(main, o); const { j, A, B, partyA } = o;
  await throughApproval(j);   // 23.3 issueConditionalApproval Wed Oct 7, 2026 (valid_until Nov 21 = the lock expiry)
  const issued = (await events(j.appId, "decision.issued")).find((e) => e.payload["kind"] === "conditional_approval"); assert.ok(issued, "21.6's decision.issued{conditional_approval}");
  assert.equal((await timer(j.appId, "SM_UW_DECISION_VALIDITY"))?.due_date, "2026-11-21");
  // the Reg B approval letter (23.3 Q3 default) rendered and sent through the Notice Registry in the partner's name — the 14 borrower-facing conditions, valid until Nov 21
  clock.set("2026-10-07T15:30:00.000Z");
  const letter = await j.tool({ app: j.appId }, "23.3", "renderApprovalLetter", { decision_id: j.decisionId, letter: { creditor_name: "Partner Bank", creditor_nmlsr_id: "123456", creditor_address: "100 Partner Plaza, Phoenix, AZ 85004", mlo_name: "Jordan Rivera", mlo_nmlsr_id: "987654", applicant_name: "Alex Borrower", property_address: "100 N Central Ave, Phoenix AZ 85004", terms: { loan_amount_cents: "56000000", note_rate_pct: "6.125", term_months: 360, product: "30-year fixed, limited cash-out refinance" } }, recipients: [RECIPIENT("B1", "Alex Borrower", A), RECIPIENT("B2", "Blake Borrower", B)] }, UNDERWRITER);
  assert.equal(letter.output["template"], "NTC_REGB_1002_9_APPROVAL"); assert.equal(letter.output["valid_until"], "2026-11-21"); assert.equal(letter.output["sent"], true);
  const sent = (await events(j.appId, "notice.sent")).find((e) => e.payload["template"] === "NTC_REGB_1002_9_APPROVAL"); assert.ok(sent, "notice.sent{NTC_REGB_1002_9_APPROVAL}");
  await settle();
  // the NoticeCard: the letter's own facts — valid_until and the borrower-facing conditions — never DU output
  const cards = await cardsOf(j.appId, partyA);
  const notice = cards.find((c) => c.kind === "NoticeCard" && c.copy_key === "decision.approval.notice"); assert.ok(notice, "NoticeCard{NTC_REGB_1002_9_APPROVAL}");
  assert.equal(notice!.props["notice_code"], "NTC_REGB_1002_9_APPROVAL"); assert.equal(notice!.props["notice_id"], sent!.payload["notice_id"]); assert.equal(notice!.props["valid_until"], "2026-11-21"); assert.equal(notice!.props["decision_id"], j.decisionId);
  const listed = notice!.props["conditions"] as { text: string }[]; assert.ok(listed.length >= 1); for (const c of listed) assert.doesNotMatch(c.text, /\bDU\b|Desktop Underwriter|V10\d\d|Refer/);
  assert.equal(notice!.status, "resolved", "a notice is filed as read — no action"); assert.equal(notice!.command_ref, null);
  const status = cards.find((c) => c.copy_key === "decision.conditional_approval"); assert.ok(status, "the thread StatusCard"); assert.equal(status!.kind, "StatusCard");
  // the Record: badge, Dates "Your approval is valid through" from the Timer Engine's SM_UW_DECISION_VALIDITY row, Needed-from-you = the conditions waiting on the borrower
  const rec = await record(A, j.appId);
  assert.equal((rec["status"] as { badge: string }).badge, "Approved with conditions"); assert.equal(rec["read_only"], false);
  const dates = rec["dates"] as { timer_code: string; label: string; due_at: string }[];
  const validity = dates.find((d) => d.timer_code === "SM_UW_DECISION_VALIDITY"); assert.ok(validity, JSON.stringify(dates)); assert.equal(validity!.label, "Your approval is valid through"); assert.equal(validity!.due_at, (await timer(j.appId, "SM_UW_DECISION_VALIDITY"))!.due_at);
  assert.ok((rec["documents"] as { notice_code: string }[]).some((d) => d.notice_code === "NTC_REGB_1002_9_APPROVAL"), "the letter is in Documents");
  const conditions = (await entitiesOf("conditions", j.appId)).map((c) => ({ condition_id: c.id, ...(c.data as Record<string, unknown>) })) as unknown as { condition_id: string; status: string; stage: string; text?: string; borrower_visible?: boolean }[];
  const { you, us } = conditionOwners(conditions); assert.ok(you.length >= 1, "at least one condition asks the borrower for something"); assert.ok(us.length >= 1);
  const needed = (rec["needed_from_you"] as { kind: string; item_id: string }[]).filter((x) => x.kind === "condition").map((x) => x.item_id).sort();
  assert.deepEqual(needed, you.map((c) => c.condition_id).sort(), "Needed-from-you = the conditions waiting on the borrower (waiting_borrower, or a live borrower-visible condition asking the borrower for something)");
  for (const c of conditions.filter((x) => x.status === "waiting_borrower")) assert.ok(needed.includes(c.condition_id));
  assert.deepEqual((status!.props["copy_tokens"] as Record<string, string>), { count_you: String(you.length), count_us: String(us.length) });
});

test("32.6-T12: Given `SM_QC_PREFUNDING_HOLD`, then the Thread copy is `ctc.final_review` and contains no \"QC\".", { skip }, async () => {
  const j = main.j!; const { A, partyA } = main;
  // 28.1: the Oct 28 06:00 MST draw selects the file → `qc.hold.applied{kind=prefunding}` (the checklist item SM_QC_PREFUNDING_HOLD — a 28.1 state, not a registry timer)
  clock.set("2026-10-28T13:00:00.000Z");
  const plan = await j.tool({ app: j.appId }, "28.1", "planSample", { ...OCTOBER_PLAN, sample_plan_id: `plan-2026-10-${j.R}` }, QC_AGENT);
  clock.set("2026-10-28T13:00:12.000Z");
  const sel = await j.tool({ app: j.appId }, "28.1", "selectLoans", { plan: plan.output, candidates: [{ application_id: j.appId, features: { dti_bps: 3800, ltv_x100: 7000, occupancy: "primary", transaction_type: "limited_cash_out", property_type: "sfr", credit_alerts: [] }, draw: 0.041 }], random_target_remaining: 7, expected_remaining_population: 96 }, QC_AGENT);
  const s = (sel.output["selections"] as Record<string, unknown>[])[0]!; assert.equal(s["selected"], true); assert.equal(s["application_qc_status"], "hold");
  const hold = (await events(j.appId, "qc.hold.applied")).at(-1)!; assert.equal(hold.payload["kind"], "prefunding"); assert.equal(hold.payload["item_alias"], "SM_QC_PREFUNDING_HOLD");
  await settle();
  // the Thread: one StatusCard `ctc.final_review` — "A final review is in progress — nothing needed from you."; never "QC"
  const card = (await cardsOf(j.appId, partyA)).find((c) => c.copy_key === "ctc.final_review"); assert.ok(card, "StatusCard ctc.final_review"); assert.equal(card!.kind, "StatusCard"); assert.equal(card!.command_ref, null);
  const sentence = copyText("ctc.final_review"); assert.equal(sentence, "A final review is in progress — nothing needed from you."); assert.doesNotMatch(sentence, /\bQC\b/);
  const visible = [card!.copy_key, String(card!.props["state_label"] ?? ""), String(card!.props["detail"] ?? ""), String(card!.props["next_event_label"] ?? "")].join(" "); assert.doesNotMatch(visible, /\bQC\b/i);
  const t = await thread(A); const m = t.messages.find((x) => x["card_instance_id"] === card!.card_instance_id); assert.ok(m, "the thread message carries the card"); assert.doesNotMatch(String(m!["body_text"] ?? ""), /\bQC\b/i);
  const rec = await record(A, j.appId); assert.ok(!(rec["needed_from_you"] as { card_instance_id: string | null }[]).some((x) => x.card_instance_id === card!.card_instance_id), "nothing needed from the borrower");
  // the review closes no_defect Thu Oct 29 (28.1-T2) so CTC can issue Fri Oct 30
  const review = String(s["review_id"]); clock.set("2026-10-28T13:01:00.000Z");
  await j.tool({ app: j.appId }, "28.1", "openReview", { review_id: review, run: { run_id: "qc-run-1", model_version: "qc-audit-2026.09", prompt_version: "28.1-v1" }, application_agent_runs: [{ agent_id: "underwriter", run_id: "uw-run-1" }] }, QC_AGENT);
  clock.set("2026-10-29T17:42:00.000Z"); const closed = await j.tool({ app: j.appId }, "28.1", "closeReview", { review_id: review, outcome: "no_defect" }, QC_AGENT);
  assert.equal((closed.output["gate"] as { open: boolean }).open, true); assert.equal((await events(j.appId, "qc.hold.released")).length, 1);
});

test("32.6-T9: Given `in_sfha = true`, then `NTC_FDPA_4104A_FLOOD_NOTICE` is delivered with `requires_ack` ≥ 10 days before the scheduled closing, and no closing slot renders before `flood.notice.delivered`.", { skip }, async () => {
  const j = main.j!; const { A, B, partyA } = main;
  // 24.5: the determination ordered with title Thu Oct 8 — Zone AE, the principal structure in an SFHA → notice_due (FDPA_4104A_FLOOD_NOTICE_GATE armed)
  clock.set(MST("2026-10-08", "09:00"));
  await j.tool({ app: j.appId }, "24.5", "orderFloodDetermination", { property_id: `PROP-${j.R}`, address_hash: "sha256:phx-100-n-central", fee_gate_result: "open", ordered_at: MST("2026-10-08", "09:00") }, CLOSER);
  const det = await j.tool({ app: j.appId }, "24.5", "parseSFHDF", { sfhdf: AE, received_at: MST("2026-10-08", "12:30") }, CLOSER);
  assert.equal(det.output["in_sfha"], true); assert.equal(det.output["status"], "notice_due"); assert.equal((await timer(j.appId, "FDPA_4104A_FLOOD_NOTICE_GATE"))?.status, "armed");
  // clear to close Thu Oct 29 and the CD Mon Nov 2 (earliest consummation Thu Nov 5): still no closing slot — the notice has not been delivered
  await j.clearToClose(); await settle();
  assert.equal((await cardsOf(j.appId)).filter((c) => c.kind === "ScheduleCard" && c.props["purpose"] === "ron_session").length, 0, "no closing slot without the CD's earliest consummation date");
  await j.closingDisclosure(); await settle();
  assert.equal((await events(j.appId, "disclosure.cd.waiting_period.computed")).at(-1)!.payload["earliest_consummation_date"], "2026-11-05");
  assert.equal((await cardsOf(j.appId)).filter((c) => c.kind === "ScheduleCard" && c.props["purpose"] === "ron_session").length, 0, "no closing slot renders before flood.notice.delivered on an SFHA loan");
  assert.equal((await events(j.appId, "flood.notice.delivered")).length, 0);
  // the notice rendered and e-delivered Fri Oct 9 (e-sign confirmed the same day → effective receipt Oct 9), 28 days before the Nov 6 closing. 24.5 dates the
  // delivery, the receipt and the gate from the notice's own instants (`delivered_at`, `esign_confirmed_at`), and `flood.notice.delivered` carries them as its
  // occurred_at; the platform commits the record after the CD in this fixture's order, so the clock — the instant every card the reaction sends is dated at —
  // stays where the CD left it (Mon Nov 2) and never runs back behind the Oct 29 clear to close (T11: no closing slot is dated before the CTC).
  clock.set(MST("2026-11-02", "09:40"));
  const rendered = await j.tool({ app: j.appId }, "24.5", "renderFloodNotice", { borrower_names: TITLE, property_address: "100 N Central Ave, Phoenix AZ 85004", loan_number_last4: j.appId.slice(-4), notice_date: "2026-10-09", scheduled_consummation_date: "2026-11-06", recipients: [RECIPIENT("B1", "Alex Borrower", A), RECIPIENT("B2", "Blake Borrower", B)] }, CLOSER);
  assert.equal(rendered.output["template_code"], "NTC_FDPA_4104A_FLOOD_NOTICE"); assert.equal(rendered.output["rendered"], true);
  const noticeId = String((rendered.output["notice"] as { id: string }).id);
  const del = await j.tool({ app: j.appId }, "24.5", "deliverNotice", { channel: "esign", notice_document_id: `DOC-FLOOD-${j.R}`, notice_id: noticeId, delivered_at: MST("2026-10-09", "10:05"), esign_confirmed_at: MST("2026-10-09", "14:40"), scheduled_consummation_date: "2026-11-06", esign_consent_scope: "flood_notice" }, CLOSER);
  assert.equal(del.output["effective_receipt_date"], "2026-10-09"); assert.equal(del.output["days_before_consummation"], 28); assert.ok(Number(del.output["days_before_consummation"]) >= 10); assert.equal(del.output["reasonable_period_ok"], true); assert.equal(del.output["status"], "notice_delivered");
  assert.equal((await timer(j.appId, "FDPA_4104A_FLOOD_NOTICE_GATE"))?.status, "satisfied");
  await settle();
  // the DocumentCard{NTC_FDPA_4104A_FLOOD_NOTICE, requires_ack=true} for each borrower; the closing ScheduleCard exists only now
  const flood = (await cardsOf(j.appId, partyA)).find((c) => c.copy_key === "flood.notice"); assert.ok(flood, "DocumentCard flood.notice");
  assert.equal(flood!.kind, "DocumentCard"); assert.equal(flood!.props["notice_code"], "NTC_FDPA_4104A_FLOOD_NOTICE"); assert.equal(flood!.props["requires_ack"], true); assert.equal(flood!.props["effective_receipt_date"], "2026-10-09"); assert.equal(flood!.props["days_before_consummation"], 28); assert.equal(flood!.props["scheduled_consummation_date"], "2026-11-06"); assert.equal(flood!.status, "pending"); assert.equal(flood!.command_ref, "disclosure.acknowledgeReceipt");
  assert.equal((await cardsOf(j.appId)).filter((c) => c.copy_key === "flood.notice").length, 2, "one per borrower party");
  const slots = (await cardsOf(j.appId, partyA)).filter((c) => c.kind === "ScheduleCard" && c.props["purpose"] === "ron_session"); assert.equal(slots.length, 1, "the closing slot renders after flood.notice.delivered");
  const rec = await record(A, j.appId); assert.equal(((rec["property"] as { flood: { status: string; label: string } }).flood).status, "notice_delivered");
  assert.ok((rec["needed_from_you"] as { card_instance_id: string | null; kind: string }[]).some((x) => x.card_instance_id === flood!.card_instance_id && x.kind === "acknowledgment"), "the acknowledgment is a Needed-from-you item");
  // the acknowledgment through the card is 24.5's own `flood.notice.acknowledged` (never a UI-only receipt)
  clock.set(MST("2026-11-02", "09:50"));
  const ack = await resolveCard(A, flood!.card_instance_id, { option_id: "confirm_receipt", evidence: { receipt_evidence: "esign_confirmed", received_at: MST("2026-11-02", "09:50") } });
  assert.equal(ack.status, 201, JSON.stringify(ack.body)); assert.equal(ack.body["command"], "disclosure.acknowledgeReceipt"); assert.ok((ack.body["events"] as string[]).includes("flood.notice.acknowledged"), JSON.stringify(ack.body["events"]));
  assert.equal((await events(j.appId, "flood.notice.acknowledged")).length, 1);
});

test("32.6-T11: Given `ctc_checklists.passed = true`, then the badge is \"Clear to close\" and the closing `ScheduleCard` waits for `earliest_consummation_date`.", { skip }, async () => {
  const j = main.j!; const { A, partyA } = main;
  const ctc = (await events(j.appId, "clear_to_close.issued")).at(-1)!; assert.ok(ctc, "23.3's clear_to_close.issued (T9 ran the journey's CTC)");
  const checklist = (await entitiesOf("ctc_checklists", j.appId)).at(-1)!; assert.equal(checklist.data["passed"], true);
  const rec = await record(A, j.appId); assert.equal((rec["status"] as { badge: string; one_liner: string }).badge, "Clear to close"); assert.equal((rec["status"] as { one_liner: string }).one_liner, "ctc.reached");
  const cards = await cardsOf(j.appId, partyA);
  const reached = cards.find((c) => c.copy_key === "ctc.reached"); assert.ok(reached, "StatusCard ctc.reached"); assert.match(copyText("ctc.reached"), /Closing Disclosure/); assert.doesNotMatch(copyText("ctc.reached"), /\bCTC\b|clear to close/i);
  // the ScheduleCard waited for the CD's earliest_consummation_date (25.2 `disclosure.cd.waiting_period.computed` → Thu Nov 5): every slot on or after it; none existed before that event
  const earliestEvent = (await events(j.appId, "disclosure.cd.waiting_period.computed")).at(-1)!; const earliest = String(earliestEvent.payload["earliest_consummation_date"]); assert.equal(earliest, "2026-11-05");
  const card = cards.find((c) => c.kind === "ScheduleCard" && c.props["purpose"] === "ron_session"); assert.ok(card, "the closing ScheduleCard");
  assert.equal(card!.props["earliest_consummation_date"], earliest); assert.equal(card!.command_ref, "closing.selectSlot"); assert.equal(card!.status, "pending");
  const slots = card!.props["slots"] as { id: string; starts_at: string }[]; assert.ok(slots.length >= 3);
  for (const s of slots) assert.ok(new Date(s.starts_at).toISOString() >= `${earliest}T00:00:00.000Z` && D(new Date(s.starts_at).toLocaleDateString("en-CA", { timeZone: "America/Phoenix" })) >= D(earliest), `slot ${s.starts_at} on or after the earliest consummation date`);
  assert.ok(Number(card!.created_at ? 1 : 0) === 1 && (await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM card_instances WHERE subject_application_id = $1 AND kind = 'ScheduleCard' AND props->>'purpose' = 'ron_session' AND created_at < (SELECT min(occurred_at) FROM loan_events WHERE application_id = $1 AND type = 'clear_to_close.issued')`, [j.appId]))[0]!.n === "0", "no closing slot before clear to close");
  // Needed-from-you carries the closing item pointing at the card; Dates carries the earliest closing date as "Earliest closing date" — 25.2's published `earliest_consummation_date` under
  // REGZ_1026_19F1_CD_3SBD_GATE (the gate is condition-shaped: its `timers` row arms on the CD receipts and carries no due of its own; the date is never recomputed by the record)
  assert.ok((rec["needed_from_you"] as { item_id: string; card_instance_id: string | null }[]).some((x) => x.item_id === "closing:schedule" && x.card_instance_id === card!.card_instance_id));
  const gate = await timer(j.appId, "REGZ_1026_19F1_CD_3SBD_GATE"); assert.equal(gate?.status, "armed", "25.2's gate armed on the CD receipts");
  const earliestRow = (rec["dates"] as { timer_code: string; label: string; due_at: string }[]).find((d) => d.timer_code === "REGZ_1026_19F1_CD_3SBD_GATE")!; assert.ok(earliestRow, "Dates: the earliest closing date"); assert.equal(earliestRow.label, "Earliest closing date"); assert.equal(earliestRow.due_at.slice(0, 10), earliest);
  // the closing scheduled through 26.2 (Fri Nov 6 14:00 MST) resolves the card on every channel
  await j.scheduleClosing(); await settle();
  const after = (await cardsOf(j.appId, partyA)).find((c) => c.card_instance_id === card!.card_instance_id)!; assert.equal(after.status, "resolved"); assert.equal((after.evidence as Record<string, unknown>)["manner"], "receipt_evidence");
  assert.equal(((await record(A, j.appId))["status"] as { badge: string }).badge, "Closing scheduled");
});

test("32.6-T5: Given an appraisal accepted Wed Nov 4, 2026 with consummation Fri Nov 6, then the copy `DocumentCard` was delivered ≥ 3 business days earlier or a `copy_waived` record ≥ 3 BD before consummation exists; otherwise `consummate` is refused.", { skip }, async () => {
  const j = main.j!; const { A, B, partyA } = main; const APPRAISAL = `APR-${j.R}`;
  assert.equal((await timer(j.appId, "REGB_1002_14_APPRAISAL_COPY_3BD_GATE"))?.status, "armed", "26.2's closing.scheduled (T11) armed the gate for the Nov 6 consummation");
  // 24.2: v1 received Tue Nov 3, reviewed and accepted Wed Nov 4 09:00 MST (completion_at Nov 4)
  clock.set(MST("2026-11-03", "14:20"));
  await j.tool({ app: j.appId }, "24.2", "ingestReport", { appraisal_id: APPRAISAL, version_no: 1, package: PACKAGE, appraised_value_cents: "80000000", effective_date: "2026-11-02", appraiser_party_id: APPRAISER, received_at: MST("2026-11-03", "14:20"), valuation_order_id: j.valuationOrderId }, VALUATION);
  clock.set(MST("2026-11-04", "09:00"));
  const review = await j.tool({ app: j.appId }, "24.2", "applyReviewChecklist", { appraisal_id: APPRAISAL, version_no: 1, checklist: CHECKLIST, transaction_type: "refinance", loan_amount_cents: "56000000", consummation_on: "2026-11-06", fnma_ssr: SSR(MST("2026-11-03", "15:07")) }, VALUATION);
  assert.equal(review.output["review_status"], "accepted"); assert.equal(String(review.output["completion_at"]).slice(0, 10), "2026-11-04");
  // the copy e-delivered Wed Nov 4 10:00: provided Nov 4 → earliest consummation Mon Nov 9 (3 business_days_creditor) — the Nov 6 gate is closed
  clock.set(MST("2026-11-04", "10:00"));
  const copy = await j.tool({ app: j.appId }, "24.2", "deliverNotice", { template_code: "NTC_REGB_1002_14_VALUATION_COPY", payload: COPY_PAYLOAD("2026-11-04", "2026-11-09", "100 N Central Ave, Phoenix AZ 85004", TITLE), recipients: [RECIPIENT("B1", "Alex Borrower", A), RECIPIENT("B2", "Blake Borrower", B)], appraisal_id: APPRAISAL, version: 1, is_final_version: true, channel: "electronic", esign_consent_verified: true, receipt_evidence: "esign_confirmed", consummation_on: "2026-11-06", valuation_ids: [`VAL-${APPRAISAL}-v1`] }, VALUATION);
  assert.equal(copy.output["provided_on"], "2026-11-04"); assert.equal(copy.output["earliest_consummation"], "2026-11-09"); assert.equal(copy.output["gate_open_for_scheduled"], false); assert.equal(earliestConsummation(D("2026-11-04")), "2026-11-09");
  await settle();
  const card = (await cardsOf(j.appId, partyA)).find((c) => c.copy_key === "valuation.copy"); assert.ok(card, "DocumentCard{appraisal copy}");
  assert.equal(card!.kind, "DocumentCard"); assert.equal(card!.props["requires_ack"], true); assert.equal(card!.props["notice_code"], "NTC_REGB_1002_14_VALUATION_COPY"); assert.equal(card!.props["provided_on"], "2026-11-04"); assert.equal(card!.props["appraisal_id"], APPRAISAL); assert.equal(card!.props["is_final_version"], true); assert.equal(card!.props["timer_code"], "REGB_1002_14_APPRAISAL_COPY_3BD_GATE");
  assert.equal(((await record(A, j.appId))["property"] as { valuation: { status: string; label: string; value_used_cents: string } }).valuation.label, "Appraised value on file");
  // (a) delivered 2 business days before consummation and no waiver → REGB_1002_14_APPRAISAL_COPY_3BD_GATE closed → `consummate` refused (26.2's pre-session checks name the gate)
  const closed = regBCopyGate({ consummation_on: D("2026-11-06"), latest_version_provided_on: D("2026-11-04") }); assert.equal(closed.open, false); assert.deepEqual(closed.blocking_codes, ["REGB_COPY_LT_3BD"]); assert.equal(closed.proposed_consummation_on, "2026-11-09");
  const gate = evaluateGate("24.2.regbCopy3bdGate", { consummation_date: "2026-11-06", latest_version_provided_on: "2026-11-04" }); assert.equal(gate.open, false); assert.match(gate.reason!, /2026-11-09/);
  assert.equal((await events(j.appId, "valuation.copy.waived")).length, 0);
  const jj = j as unknown as { CLOSING_CONSENT: Record<string, unknown>; PRE_SESSION_FACTS: Record<string, unknown> };
  clock.set(MST("2026-11-06", "13:30"));
  const refused = await j.tool({ app: j.appId }, "26.2", "runPreSessionChecks", { closing_id: j.CLOSING_ID, consent: jj.CLOSING_CONSENT, facts: { ...jj.PRE_SESSION_FACTS, appraisal_copy_gate_open: gate.open } }, CLOSER);
  assert.equal(refused.output["passed"], false); assert.ok((refused.output["blocking"] as string[]).some((b) => b.startsWith("REGB_1002_14_APPRAISAL_COPY_3BD_GATE")), JSON.stringify(refused.output["blocking"]));
  // (b) a dated borrower waiver obtained Tue Nov 3 (≥ 3 BD before Nov 6) → `valuation.copy.waived`; with the copy at or before consummation the gate opens and the checks pass the appraisal item
  clock.set(MST("2026-11-03", "16:00"));
  const waiver = await j.tool({ app: j.appId }, "24.2", "recordWaiver", { appraisal_id: APPRAISAL, statement_channel: "written", obtained_at: MST("2026-11-03", "16:00"), consummation_on: "2026-11-06" }, VALUATION);
  assert.equal(waiver.output["accepted"], true); assert.equal(waiver.output["copies_due_at_or_before"], "2026-11-06");
  const waived = (await events(j.appId, "valuation.copy.waived")).at(-1)!; assert.equal(waived.payload["consent_kind"], "regb_1002_14_timing_waiver"); assert.equal(String(waived.payload["obtained_at"]).slice(0, 10), "2026-11-03");
  assert.ok(await entity("consents", String(waived.payload["consent_id"])), "the copy_waived consent row");
  const opened = regBCopyGate({ consummation_on: D("2026-11-06"), latest_version_provided_on: D("2026-11-04"), waiver_obtained_on: D("2026-11-03") }); assert.equal(opened.open, true);
  const open = evaluateGate("24.2.regbCopy3bdGate", { consummation_date: "2026-11-06", latest_version_provided_on: "2026-11-04", waiver_obtained_on: "2026-11-03" }); assert.equal(open.open, true);
  assert.equal(evaluateGate("24.2.regbCopy3bdGate", { consummation_date: "2026-11-06", latest_version_provided_on: "2026-11-04", waiver_obtained_on: "2026-11-04" }).open, false, "a waiver inside 3 BD does not open the gate");
  clock.set(MST("2026-11-06", "13:31"));
  const allowed = await j.tool({ app: j.appId }, "26.2", "runPreSessionChecks", { closing_id: j.CLOSING_ID, consent: jj.CLOSING_CONSENT, facts: { ...jj.PRE_SESSION_FACTS, appraisal_copy_gate_open: open.open } }, CLOSER);
  assert.ok(!(allowed.output["blocking"] as string[]).some((b) => b.startsWith("REGB_1002_14_APPRAISAL_COPY_3BD_GATE")), JSON.stringify(allowed.output["blocking"]));
});

// ═══════════════════════════════════ App B: the lender-initiated loan-amount reduction (T2)
test("32.6-T2: Given a lender-initiated loan-amount reduction, then a counteroffer notice and `ComparisonCard` exist, `REGB_1002_9_COUNTEROFFER_90` appears in Dates, and no adverse-action notice exists while the window is open.", { skip }, async () => {
  const { j, A, B, partyA } = await openApp(); const DECISION = `D-CO-${j.R}`;
  // 21.6: the collateral factor fails at 70 % against a 62.5 % structure → counteroffer at $500,000 (a loan-amount reduction), reviewer-approved, the C-4 notice without combined content
  const collateral = { rule_id: "ltv_max", description: "Loan-to-value above the structure the borrower qualified for", threshold: "62.5", observed: "70.0", applicant_ids: ["B1", "B2"], evidence_document_ids: ["doc-appraisal"], failed: true, source: "valuation" };
  clock.set(MST("2026-10-29", "13:00"));
  const rec = await j.tool({ app: j.appId }, "21.6", "recommendDisposition", { ...decisionFile(A, B), decision_id: DECISION, factors: [collateral], counteroffer_terms: { loan_amount_cents: "50000000", note_rate: "6.125", product_code: "FNMA30", ltv: "62.5", conditions: [], expires_on: "2026-11-14" } }, UNDERWRITER);
  assert.equal(rec.output["kind"], "counteroffer");
  clock.set(MST("2026-10-30", "07:00")); await j.tool({ app: j.appId }, "21.6", "openReviewerEscalation", { op: "decide", decision_id: DECISION, outcome: "approved" }, REVIEWER);
  const r = await j.tool({ app: j.appId }, "21.6", "renderNotice", { decision_id: DECISION, notice_date: "2026-10-30", combined_notice: false }, UNDERWRITER); assert.equal(r.output["template"], "NTC_REGB_1002_9_COUNTEROFFER");
  clock.set(MST("2026-10-30", "08:00")); const sent = await j.tool({ app: j.appId }, "21.6", "deliverNotice", { decision_id: DECISION, notice_ids: r.output["notice_ids"], combined_notice: false }, UNDERWRITER);
  assert.equal(sent.output["kind"], "counteroffer"); assert.equal(sent.output["disposition"], "counteroffer_pending"); assert.equal(sent.output["combined_notice"], false);
  const issued = (await events(j.appId, "decision.issued")).find((e) => e.payload["kind"] === "counteroffer"); assert.ok(issued); assert.equal(issued!.payload["adverse_notice_due_on"], "2027-01-28");
  assert.equal((await timer(j.appId, "REGB_1002_9_COUNTEROFFER_90"))?.status, "armed"); assert.equal((await timer(j.appId, "REGB_1002_9_COUNTEROFFER_90"))?.due_date, "2027-01-28");
  await settle();
  const cards = await cardsOf(j.appId, partyA);
  // the counteroffer notice (NTC_REGB_1002_9_COUNTEROFFER) as a NoticeCard with the offered and requested terms from the decision file — never "you were declined"
  const notice = cards.find((c) => c.copy_key === "decision.counteroffer.notice"); assert.ok(notice, "NoticeCard{NTC_REGB_1002_9_COUNTEROFFER}"); assert.equal(notice!.props["notice_code"], "NTC_REGB_1002_9_COUNTEROFFER");
  assert.equal((notice!.props["counteroffer"] as { loan_amount_cents: string }).loan_amount_cents, "50000000"); assert.equal((notice!.props["original_terms"] as { loan_amount_cents: string }).loan_amount_cents, "56000000");
  assert.doesNotMatch(copyText("decision.counteroffer.notice"), /declined/i);
  // the ChoiceCard (accept · decline · talk to a person) on `counteroffer.respond`, open until the offer's own expiry; the ComparisonCard requested vs offered
  const choice = cards.find((c) => c.copy_key === "decision.counteroffer" && c.kind === "ChoiceCard"); assert.ok(choice); assert.equal(choice!.status, "pending"); assert.equal(choice!.command_ref, "counteroffer.respond");
  assert.deepEqual((choice!.props["options"] as { id: string }[]).map((x) => x.id), ["accept", "decline", "human"]); assert.equal(choice!.expires_at?.slice(0, 10), "2026-11-14");
  const compare = cards.find((c) => c.copy_key === "decision.counteroffer.compare"); assert.ok(compare, "ComparisonCard"); assert.equal(compare!.kind, "ComparisonCard");
  const columns = compare!.props["columns"] as { id: string; rows: { label: string; value: string }[] }[]; assert.deepEqual(columns.map((c) => c.id), ["requested", "offered"]);
  assert.equal(columns[0]!.rows.find((x) => x.label === "Loan amount")!.value, "$560,000.00"); assert.equal(columns[1]!.rows.find((x) => x.label === "Loan amount")!.value, "$500,000.00"); assert.ok(columns[1]!.rows.some((x) => x.label === "Monthly principal & interest"));
  // Dates: REGB_1002_9_COUNTEROFFER_90 with its allow-listed label; badge Counteroffer; no adverse-action notice while the window is open
  const record_ = await record(A, j.appId); assert.equal((record_["status"] as { badge: string }).badge, "Counteroffer");
  const dates = record_["dates"] as { timer_code: string; label: string; due_at: string }[]; const co = dates.find((d) => d.timer_code === "REGB_1002_9_COUNTEROFFER_90"); assert.ok(co, JSON.stringify(dates)); assert.equal(co!.label, "Counteroffer open until"); assert.equal(co!.due_at, (await timer(j.appId, "REGB_1002_9_COUNTEROFFER_90"))!.due_at);
  assert.equal((await events(j.appId, "notice.sent")).filter((e) => e.payload["template"] === "NTC_REGB_1002_9_ADVERSE_ACTION").length, 0); assert.equal((await events(j.appId, "counteroffer.resolved")).length, 0, "the window is open");
  assert.equal(cards.filter((c) => c.copy_key === "decision.denial.notice").length, 0); assert.equal(record_["read_only"], false);
  assert.ok((record_["needed_from_you"] as { card_instance_id: string | null }[]).some((x) => x.card_instance_id === choice!.card_instance_id), "the response is a Needed-from-you item");
});

// ═══════════════════════════════════ App C: the denial (T3)
test("32.6-T3: Given `decision.issued{denial}`, then the payload contains the specific reasons from the template and no DU recommendation string; the Record is read-only.", { skip }, async () => {
  const { j, A, B, partyA, partyB } = await openApp(); const DECISION = `D-DEN-${j.R}`;
  const before = (await cardsOf(j.appId)).filter((c) => c.status === "pending").length;
  clock.set(MST("2026-10-23", "09:40"));
  const rec = await j.tool({ app: j.appId }, "21.6", "recommendDisposition", { ...decisionFile(A, B), decision_id: DECISION, factors: FACTORS, du_recommendation: "refer_with_caution", data_verified_and_resubmitted: true }, UNDERWRITER);
  assert.equal(rec.output["kind"], "denial");
  clock.set(MST("2026-10-26", "11:05")); await j.tool({ app: j.appId }, "21.6", "openReviewerEscalation", { op: "decide", decision_id: DECISION, outcome: "approved" }, REVIEWER);
  const r = await j.tool({ app: j.appId }, "21.6", "renderNotice", { decision_id: DECISION, score_payloads: [SCORES_B1, SCORES_B2], notice_date: "2026-10-26" }, UNDERWRITER); assert.equal(r.output["template"], "NTC_REGB_1002_9_ADVERSE_ACTION"); assert.equal(r.output["per_applicant"], 2);
  clock.set(MST("2026-10-26", "11:30")); const sent = await j.tool({ app: j.appId }, "21.6", "deliverNotice", { decision_id: DECISION, notice_ids: r.output["notice_ids"], score_payloads: [SCORES_B1, SCORES_B2] }, UNDERWRITER);
  assert.equal(sent.output["kind"], "denial"); assert.equal(sent.output["disposition"], "denied");
  const issued = (await events(j.appId, "decision.issued")).find((e) => e.payload["kind"] === "denial"); assert.ok(issued, "decision.issued{denial}");
  await settle();
  // the NoticeCard per applicant: the template's specific reasons (21.6 rule 3 taxonomy text), never the DU recommendation string
  const notices = (await cardsOf(j.appId)).filter((c) => c.copy_key === "decision.denial.notice"); assert.equal(notices.length, 2, "one adverse-action notice per applicant");
  assert.deepEqual(notices.map((c) => c.party_id).sort(), [partyA, partyB].sort());
  for (const n of notices) {
    assert.equal(n.props["notice_code"], "NTC_REGB_1002_9_ADVERSE_ACTION"); assert.equal(n.props["decision_id"], DECISION);
    assert.deepEqual((n.props["principal_reasons"] as { statement_text: string }[]).map((x) => x.statement_text), ["Excessive obligations in relation to income", "Delinquent past or present credit obligations with others"]);
    const json = JSON.stringify(n.props); assert.doesNotMatch(json, /Refer with Caution|refer_with_caution|\bDU\b|Desktop Underwriter|internal standards|score cutoff/i); assert.ok(!("du_recommendation" in n.props) && !("risk_assessment" in n.props) && !("scores" in n.props));
    assert.equal(n.status, "resolved", "no action on a notice");
  }
  const t = await thread(A); assert.ok(t.messages.some((m) => m["card_instance_id"] === notices.find((n) => n.party_id === partyA)!.card_instance_id));
  assert.ok((await cardsOf(j.appId, partyA)).some((c) => c.copy_key === "decision.denial.next"), "one sentence on next steps (the template's copy key)");
  // the Record: badge "Decision letter sent", read-only, Needed-from-you empty (every pending card cancelled), Documents keep everything
  const record_ = await record(A, j.appId);
  assert.equal((record_["status"] as { badge: string }).badge, "Decision letter sent"); assert.equal(record_["read_only"], true); assert.deepEqual(record_["needed_from_you"], []);
  assert.equal((await cardsOf(j.appId)).filter((c) => c.status === "pending").length, 0); assert.ok(before >= 0);
  assert.ok((record_["documents"] as { notice_code: string }[]).some((d) => d.notice_code === "NTC_REGB_1002_9_ADVERSE_ACTION"));
  // nothing commits on a read-only Record: the withdrawn/denied guard refuses a borrower command
  const tok = (await signIn(A)).token; const refused = await api("POST", "/v1/borrower/commands/application.withdraw", { subject: { application_id: j.appId }, reason: "never mind" }, tok);
  assert.ok(refused.status === 409 || refused.status === 422 || refused.status === 200, JSON.stringify(refused.body));   // 21.6 keeps its own terminal-state rule; the borrower surface renders {code, gate, copy_key}
  if (refused.status !== 200) assert.equal(typeof refused.body["copy_key"], "string");
});

// ═══════════════════════════════════ App D: value acceptance (T4)
test("32.6-T4: Given value acceptance offered at the final DU submission, then Property shows \"No appraisal needed\" and no `ScheduleCard{appraisal_access}` exists.", { skip }, async () => {
  const { j, A, partyA } = await openApp();
  // 24.1 R1 on the DU offer (the findings' `value_acceptance_offer` — read through 24.1's own offer input): value acceptance selected, nothing to order (B4-1.4-10)
  clock.set(MST("2026-10-06", "09:20"));
  const sel = await j.tool({ app: j.appId }, "24.1", "selectMethod", { transaction_type: "limited_cash_out", occupancy: "primary", units: 1, property_type: "sfr", ltv_bps: 7000, offer_type: "value_acceptance", du_recommendation: "approve_eligible", at: MST("2026-10-06", "09:20"), time_zone: "America/Phoenix" }, VALUATION);
  assert.equal(sel.output["method"], "value_acceptance"); assert.equal(sel.output["offer_type"], "value_acceptance");
  assert.equal((await events(j.appId, "valuation.method.selected")).at(-1)!.payload["method"], "value_acceptance"); assert.equal((await events(j.appId, "valuation.ordered")).length, 0);
  assert.equal(await timer(j.appId, "SM_VALUATION_ORDER_SLA_1BD"), undefined, "no order clock for value acceptance");
  await settle();
  const rec = await record(A, j.appId); const valuation = (rec["property"] as { valuation: { method: string; status: string; label: string } }).valuation;
  assert.equal(valuation.status, "no_appraisal_needed"); assert.equal(valuation.label, "No appraisal needed"); assert.equal(valuation.method, "value_acceptance");
  const cards = await cardsOf(j.appId, partyA);
  assert.ok(cards.some((c) => c.copy_key === "valuation.value_acceptance" && c.kind === "StatusCard"), "StatusCard valuation.value_acceptance");
  // 32.6 §1.4 row `offer_recorded`: the library's line says no appraisal and no fee, and never names the AUS by its product name (01 §6 plain language)
  const line = copyText("valuation.value_acceptance"); assert.match(line, /no appraisal/i); assert.match(line, /no fee/i); assert.doesNotMatch(line, /\bDU\b|Desktop Underwriter|LPA/);
  assert.equal((await cardsOf(j.appId)).filter((c) => c.kind === "ScheduleCard" && c.props["purpose"] === "appraisal_access").length, 0, "no ScheduleCard{appraisal_access}");
  assert.equal((await cardsOf(j.appId)).filter((c) => c.kind === "ScheduleCard").length, 0);
});

// ═══════════════════════════════════ App E: the purchase appraisal below price (T6)
test("32.6-T6: Given a purchase appraisal below price, then the `ChoiceCard` offers renegotiate / cash / cancel and a chosen \"cash\" writes the new down payment as `source=borrower` and triggers DU resubmission.", { skip }, async () => {
  // the Columbus purchase: contract $457,800, loan $412,000 sought, application Mon Oct 19, 2026 (the 21.6 / 24.6 / 28.1 purchase fixture)
  const R = randomUUID().slice(0, 8); const A = `casey-${R}@example.test`; const B = `drew-${R}@example.test`; const j = new Journey({ runtime, db, base, token: TOKEN, clock, borrowerEmail: A, coBorrowerEmail: B, partnerPartyId });
  clock.set(EDT("2026-10-19", "10:00"));
  const created = await j.call("POST", "/v1/applications", { actor: INTAKE, application: { partner_party_id: partnerPartyId, channel: "organic", transaction_type: "purchase", occupancy: "primary", intake_channel: "web", interview_language: "en-US",
    borrowers: [{ legal_name: "Alex Borrower", borrower_role: "borrower", citizenship_status: "us_citizen", language_preference: "en", tin_last4: "6789", date_of_birth: "1985-06-15", contact: { email: A } }, { legal_name: "Blake Borrower", borrower_role: "co_borrower", tin_last4: "4321", date_of_birth: "1986-02-20", contact: { email: B } }],
    property: { address_line1: "1420 Neil Ave", city: "Columbus", state: "OH", postal_code: "43201", county: "Franklin", property_type: "sfr", units: 1 } } });
  assert.equal(created.status, 200, JSON.stringify(created.body)); j.appId = (created.body["application"] as { id: string }).id;
  const partyA = (await signIn(A)).party_id; await signIn(B); const scope = { app: j.appId };
  await j.tool(scope, "21.1", "startInterview", { session_id: `S-${R}`, partner_name: "Partner Bank", partner_nmlsr_id: "123456", intake_channel: "web", creditor_time_zone: "America/New_York", property_state: "OH", property_address: "1420 Neil Ave, Columbus, OH 43201", transaction_type: "purchase", occupancy: "primary", borrowers: [{ id: "B1", legal_name: "Alex Borrower", marital_status: "married" }, { id: "B2", legal_name: "Blake Borrower", marital_status: "married" }], model_version: "intake-2026.09", prompt_version: "p-1.4" });
  await j.tool(scope, "21.1", "discloseAI", { session_id: `S-${R}`, utterance_id: `utt-${R}`, state: "OH" });
  clock.set(EDT("2026-10-19", "10:16")); await j.tool(scope, "21.1", "captureField", { field: "credit_request", transaction_type: "purchase", occupancy: "primary", property_state: "OH", identity_verified: true });
  await j.tool(scope, "21.1", "confirmPrefill", { op: "offer", item: "name", value: "Alex Borrower" }); await j.tool(scope, "21.1", "confirmPrefill", { item: "name" });
  await j.tool(scope, "21.1", "captureField", { field: "ssn", value: "123-45-6789", borrower_id: "B1" });
  await j.tool(scope, "21.1", "confirmPrefill", { op: "offer", item: "property_address", value: "1420 Neil Ave, Columbus, OH 43201" }); await j.tool(scope, "21.1", "confirmPrefill", { item: "property_address" });
  await j.tool(scope, "21.1", "captureField", { field: "income", value: "700000", borrower_id: "B1" });
  await j.tool(scope, "21.1", "captureField", { field: "property_value_estimate", value: "45780000" });
  clock.set(EDT("2026-10-19", "10:41")); const sixth = await j.tool(scope, "21.1", "captureField", { field: "loan_amount_sought", value: "41200000" }); assert.equal(sixth.output["trid_emitted"], true);
  await db.query(`INSERT INTO purchase_contracts (application_id, sales_price_cents, seller_concessions_cents, contract_date, closing_date) VALUES ($1, 45780000, 0, '2026-10-15', '2026-11-18')`, [j.appId]);
  // 23.1: the initial DU submission on the purchase (the casefile the resubmission rule re-runs against)
  clock.set(EDT("2026-10-20", "09:00"));
  await j.tool(scope, "22.6", "verifyIdentity", { borrower_id: "B1", borrower_ids: ["B1", "B2"], scheduled_note_date: "2026-11-18" }, FRAUD_RISK); await j.tool(scope, "22.6", "verifyIdentity", { borrower_id: "B2", borrower_ids: ["B1", "B2"], scheduled_note_date: "2026-11-18" }, FRAUD_RISK);
  const joint = { trid_received_at: EDT("2026-10-19", "10:41"), borrowers: [{ id: "B1", joint_intent_affirmed_at: EDT("2026-10-19", "10:10"), added_at: EDT("2026-10-19", "10:05") }, { id: "B2", joint_intent_affirmed_at: EDT("2026-10-19", "10:12"), added_at: EDT("2026-10-19", "10:06") }] };
  // 21.4's fee gate: the credit-report fee handling recorded before the hard pull (22.2 R1 SIX_ITEMS_AND_FEE_FIRST)
  await j.tool(scope, "21.4", "checkFeeGate", { command: "order_credit_report", fee_kind: "credit_report", amount_cents: "7500", vendor_invoice_cents: "6850", op: "impose", fee_item_id: `fee-credit-report-${R}`, method: "card_token", checked_at: EDT("2026-10-20", "08:55"), time_zone: "America/New_York" }, PRICING);
  const order = await j.tool(scope, "22.2", "orderCreditReport", { borrower_ids: ["B1", "B2"], permissible_purpose: "credit_transaction_604a3A", certification_ref: "CERT-PARTNER-1681E-2026", borrower_authorization_ref: `AUTH-${R}`, subscriber_code: "SUB-PARTNER-0417", joint_intent_facts: joint, at: EDT("2026-10-20", "09:00") }, VERIFICATION);
  await j.tool(scope, "22.2", "parseCreditReport", { report_id: order.output["report_id"] }, VERIFICATION);
  const identities = [{ borrower_id: "B1", last_name: "Borrower", suffix: null, ssn_last4: "6789" }, { borrower_id: "B2", last_name: "Borrower", suffix: null, ssn_last4: "4321" }];
  const cf0 = createCasefile(new MemoryEventStore(clock), { application_id: j.appId, seller_number: "123456789", system_id_ref: "SYS-PARTNER-01", tsp_product_ref: "SM-TSP", score_model: "classic_fico", created_at: clock.now() }).casefile;
  await j.tool(scope, "23.1", "associateCredit", { casefile: cf0, reports: [await entity("credit_reports", String(order.output["report_id"]))], borrowers: identities, app_score_model: "classic_fico" }, UNDERWRITER);
  const ulad = { application_id: j.appId, loan_purpose: "purchase", occupancy: "principal_residence", product: "fixed_30", amortization: "fixed", loan_term: 360, property_type: "sfr_detached", sales_price_cents: "45780000", appraised_value_cents: "46000000", loan_amount_cents: "41200000", note_rate_pct: "6.375", qualifying_income_cents: "700000", total_obligations_cents: "287000", borrowers: identities, max_ltv_pct: "97.00" };
  const built = await j.tool(scope, "23.1", "buildDuRequest", { casefile_id: cf0.casefile_id, submission_type: "credit_and_underwriting", reason: "initial", snapshot: ulad }, UNDERWRITER);
  await j.tool(scope, "23.1", "submitCasefile", { casefile_id: cf0.casefile_id, request: built.output["request"], projected_note_date: "2026-11-18", scif_facts: { borrowers: identities.map((b) => ({ id: b.borrower_id, scif_presented_at: EDT("2026-10-19", "10:20") })) } }, UNDERWRITER);
  const findings = await j.tool(scope, "23.1", "fetchFindings", { casefile_id: cf0.casefile_id, submission_number: 1 }, UNDERWRITER); assert.equal((findings.output["submission"] as { status: string }).status, "findings_received");
  await settle();
  // 24.2: the appraisal comes in at $445,000 against the $457,800 contract (Mon Nov 2) — value_used = appraised (the lower), the low-value levers go to the borrower
  const APPRAISAL = `APR-PUR-${R}`; clock.set(EDT("2026-11-02", "14:20"));
  await j.tool(scope, "24.2", "ingestReport", { appraisal_id: APPRAISAL, version_no: 1, package: PACKAGE, appraised_value_cents: "44500000", effective_date: "2026-10-30", appraiser_party_id: APPRAISER, received_at: EDT("2026-11-02", "14:20") }, VALUATION);
  clock.set(EDT("2026-11-03", "10:30"));
  const review = await j.tool(scope, "24.2", "applyReviewChecklist", { appraisal_id: APPRAISAL, version_no: 1, checklist: CHECKLIST, transaction_type: "purchase", purchase_price_cents: "45780000", loan_amount_cents: "41200000", consummation_on: "2026-11-18", fnma_ssr: SSR(EDT("2026-11-02", "15:07")) }, VALUATION);
  assert.equal(review.output["review_status"], "accepted"); assert.deepEqual(review.output["value_used"], { value_used_cents: "44500000", value_basis: "appraised" });
  await settle();
  const cards = await cardsOf(j.appId, partyA); const choice = cards.find((c) => c.copy_key === "valuation.low.choice"); assert.ok(choice, "ChoiceCard valuation.low.choice");
  assert.equal(choice!.kind, "ChoiceCard"); assert.deepEqual((choice!.props["options"] as { id: string }[]).map((x) => x.id), ["renegotiate", "cash", "cancel"]); assert.equal(choice!.status, "pending");
  assert.equal(choice!.props["appraised_value_cents"], "44500000"); assert.equal(choice!.props["purchase_price_cents"], "45780000"); assert.equal(choice!.props["difference_cents"], "1280000"); assert.equal(choice!.props["new_down_payment_cents"], "5860000"); assert.equal(choice!.props["new_loan_amount_cents"], "39920000");
  assert.deepEqual(choice!.props["copy_tokens"], { money: "$445,000.00", price: "$457,800.00" }); assert.equal(choice!.command_ref, "application.confirmField");
  const cash = (choice!.props["command_args_by_option"] as Record<string, { fields: { path: string; value: string; source: string }[] }>)["cash"]!; assert.ok(cash.fields.every((f) => f.source === "borrower"));
  // the borrower chooses "cash": application.confirmField writes the new down payment (and the loan amount it implies) as the borrower's own statement — source=borrower — through 21.1
  clock.set(EDT("2026-11-03", "11:00"));
  const chosen = await resolveCard(A, choice!.card_instance_id, { option_id: "cash" });
  assert.equal(chosen.status, 201, JSON.stringify(chosen.body)); assert.equal(chosen.body["command"], "application.confirmField");
  const result = chosen.body["result"] as { fields: { path: string; source: string }[]; path: string }; assert.equal(result.path, "down_payment"); assert.deepEqual(result.fields, [{ path: "down_payment_cents", source: "borrower" }, { path: "loan_amount_sought", source: "borrower" }]);
  const captured = (await events(j.appId, "application.six_item.captured")).filter((e) => e.payload["item"] === "loan_amount_sought").at(-1)!; assert.equal(captured.payload["source"], "borrower_stated", "21.1 spells a borrower-provided value `borrower_stated` (the UX's `source=borrower`)");
  // 21.1's intake row: the six items keep only a hash and their source (`borrower_stated` = the borrower's own figure); the money lives on `loan_amount_sought_cents`
  const intake = await entity("applications", j.appId); assert.equal(String((intake!["six_items"] as Record<string, { source: string }>)["loan_amount_sought"]!.source), "borrower_stated"); assert.equal(String(intake!["loan_amount_sought_cents"]), "39920000");
  // the down payment itself is not a six-item nor an `applications` column: 21.1 records its capture (`application.field.captured{field: down_payment_cents}`) and the command's result carries the figure with `source: borrower`
  const downCaptured = (await events(j.appId, "application.field.captured")).filter((e) => e.payload["field"] === "down_payment_cents"); assert.equal(downCaptured.length, 1, "application.field.captured{down_payment_cents}"); assert.equal(downCaptured[0]!.payload["valid"], true);
  const cashArgs = (choice!.props["command_args_by_option"] as Record<string, { fields: { path: string; value: string; source: string }[] }>)["cash"]!; assert.deepEqual(cashArgs.fields.find((f) => f.path === "down_payment_cents"), { path: "down_payment_cents", value: "5860000", source: "borrower" });
  await settle();
  // …and triggers DU resubmission: 23.1 evaluateResubmission on the casefile's last findings (purchase: any change resubmits — B3-2-10) → `du.resubmission.required`
  const resub = (await events(j.appId, "du.resubmission.required")).at(-1); assert.ok(resub, "du.resubmission.required");
  assert.match(String(resub!.payload["trigger_event"] ?? ""), /application\.six_item\.captured/);
  // 23.1's own row (`du_resubmission_checks.field` is its CheckField vocabulary — the loan-amount test is `loan_amount`; B3-2-10 purchase: any change resubmits)
  const checks = await entitiesOf("du_resubmission_checks", j.appId); assert.ok(checks.some((c) => c.data["field"] === "loan_amount" && c.data["rule_code"] === "B3_2_10_PURCHASE_AMOUNT" && c.data["result"] === "resubmission_required"), JSON.stringify(checks.map((c) => [c.data["field"], c.data["rule_code"], c.data["result"]])));
  const amountCheck = checks.find((c) => c.data["field"] === "loan_amount")!; assert.equal(String(amountCheck.data["old_value"]), "41200000"); assert.equal(String(amountCheck.data["new_value"]), "39920000", "the loan amount the cash lever wrote");
  assert.equal(((await cardsOf(j.appId, partyA)).find((c) => c.card_instance_id === choice!.card_instance_id)!).status, "resolved");
});

// ═══════════════════════════════════ App F: the condo project's documents (T7)
test("32.6-T7: Given `project_reviews.status = pending_docs`, then SQ-08 cards exist and the item is owner *you* only for documents the HOA sends to the borrower; otherwise owner *third party*.", { skip }, async () => {
  const { j, A, partyA } = await openApp();
  // 24.3: the project review opened on the questionnaire extraction (pending_docs) and the documents requested from the management company
  clock.set(MST("2026-10-09", "10:00"));
  await j.tool({ app: j.appId }, "24.3", "extractProjectData", { fields: { project_name: "Camelback Terrace Condominiums", units_total: 40, units_conveyed: 38 }, confidence: { units_total: 0.98 }, page_references: { units_total: "p.2" } }, VALUATION);
  assert.equal((await entitiesOf("project_reviews", j.appId)).at(-1)!.data["status"], "pending_docs");
  const req = await j.tool({ app: j.appId }, "24.3", "requestProjectDocs", { documents: ["questionnaire", "budget", "reserve_study"], hoa_contact: "Camelback Terrace HOA management", channel: "email" }, VALUATION);
  assert.equal(req.output["event"], "project.docs.requested");
  await settle();
  const cards = (await cardsOf(j.appId, partyA)).filter((c) => c.props["side_quest"] === "SQ-08"); assert.equal(cards.length, 3, "one SQ-08 card per requested document");
  const byDoc = Object.fromEntries(cards.map((c) => [c.props["project_document"] as string, c]));
  // the budget goes to the owners → the borrower uploads it (owner you); the questionnaire and reserve study come from the management company (owner third party)
  assert.equal(byDoc["budget"]!.kind, "UploadCard"); assert.equal(byDoc["budget"]!.props["owner"], "you"); assert.equal(byDoc["budget"]!.copy_key, "hoa.docs.upload"); assert.equal(byDoc["budget"]!.command_ref, "document.upload"); assert.equal(byDoc["budget"]!.status, "pending");
  for (const doc of ["questionnaire", "reserve_study"]) { assert.equal(byDoc[doc]!.kind, "HandoffCard"); assert.equal(byDoc[doc]!.props["owner"], "third_party"); assert.equal(byDoc[doc]!.props["destination"], "hoa_management"); assert.equal(byDoc[doc]!.copy_key, "hoa.docs.handoff"); assert.equal(byDoc[doc]!.status, "resolved", "no action for the borrower"); }
  assert.deepEqual([...HOA_SENDS_TO_OWNER].filter((d) => ["questionnaire", "budget", "reserve_study"].includes(d)), ["budget"]);
  // Needed-from-you carries only the borrower-owned item (SQ global rule 2); Property shows the review waiting on documents
  const rec = await record(A, j.appId); const needed = rec["needed_from_you"] as { card_instance_id: string | null }[];
  assert.ok(needed.some((x) => x.card_instance_id === byDoc["budget"]!.card_instance_id)); assert.ok(!needed.some((x) => x.card_instance_id === byDoc["questionnaire"]!.card_instance_id));
  assert.deepEqual((rec["property"] as { project_review: { status: string; label: string } }).project_review, { status: "pending_docs", label: "Waiting on HOA documents" });
});

// ═══════════════════════════════════ App G: the 7 % deductible (T8)
test("32.6-T8: Given a hazard policy with a 7% deductible, then `deficient` renders a deficiency card naming the deductible only.", { skip }, async () => {
  const { j, A, partyA } = await openApp();
  clock.set(MST("2026-10-07", "10:00"));
  await j.tool({ app: j.appId }, "24.5", "computeInsuranceRequirements", { computed_at: MST("2026-10-07", "10:00"), facts: { computed_from: "du_findings", property: { units: 1, project_type: "detached" }, hazard: { coverage_dwelling_cents: "52000000" } } }, CLOSER);
  // the declarations page: $36,400 deductible = 7 % of the $520,000 dwelling coverage — every other test passes (replacement cost, Special form, AM Best A, the clause, the dates)
  clock.set(MST("2026-10-22", "15:00"));
  const r = await j.tool({ app: j.appId }, "24.5", "evaluateAdequacy", { policy: hazardPolicy({ policy_id: `HZ-7PCT-${j.R}`, deductible_cents: "3640000", evidence_document_id: `DOC-HZ-${j.R}` }), title_holders: TITLE, partner: { legal_name: "Partner Bank, N.A." }, transaction_type: "refinance", disbursement_date: "2026-11-12", verified_at: MST("2026-10-22", "15:00") }, CLOSER);
  assert.equal(r.output["status"], "deficient"); assert.deepEqual(r.output["deficiencies"], ["deductible_excess"]); assert.equal(r.output["deductible_pct"], "0.070000");
  const opened = (await events(j.appId, "insurance.deficiency.opened")); assert.equal(opened.length, 1); assert.equal(opened[0]!.payload["kind"], "deductible_excess");
  await settle();
  // one NoticeCard naming the deductible — and nothing else — with the fix; the corrected page stays a Needed-from-you item
  const cards = await cardsOf(j.appId, partyA);
  const notices = cards.filter((c) => c.copy_key === "insurance.deficient"); assert.equal(notices.length, 1); const n = notices[0]!;
  assert.equal(n.kind, "NoticeCard"); assert.equal(n.props["element"], "deductible"); assert.equal(n.props["deficiency_kind"], "deductible_excess"); assert.equal(DEFICIENCY_ELEMENT["deductible_excess"], "deductible");
  assert.deepEqual(n.props["copy_token_keys"], { element: "insurance.deficient.element.deductible", fix: "insurance.deficient.fix.deductible" });
  assert.equal(copyText("insurance.deficient.element.deductible"), "the deductible"); assert.match(copyText("insurance.deficient.fix.deductible"), /5%/);
  for (const other of ["coverage_form", "carrier_rating", "mortgagee_clause", "effective_date", "flood_coverage"]) assert.doesNotMatch(JSON.stringify(n.props), new RegExp(other));
  assert.equal(n.status, "resolved", "a notice is filed as read");
  const upload = cards.find((c) => c.copy_key === "insurance.upload.policy"); assert.ok(upload, "the corrected declarations page stays in Needed-from-you"); assert.equal(upload!.status, "pending"); assert.equal(upload!.props["deficiency_id"], n.props["deficiency_id"]);
  const rec = await record(A, j.appId);
  assert.ok((rec["needed_from_you"] as { card_instance_id: string | null }[]).some((x) => x.card_instance_id === upload!.card_instance_id));
  assert.deepEqual((rec["property"] as { hazard: { status: string; label: string } }).hazard, { status: "deficient", label: "Insurance — one thing to fix" });
});

// ═══════════════════════════════════ App H: mortgage insurance at 92 % LTV (T10)
test("32.6-T10: Given LTV 92%, then the MI `ComparisonCard` shows four plans with cancellation rules; `mi.selectPlan{lpmi}` produces a revised LE with a higher rate and no MI line.", { skip }, async () => {
  const { j, A, partyA } = await openApp();
  await j.quoteAndLe(); await j.recordIntent(); await j.quoteForLock(); await j.requestLock(); await j.executeLockAndCommit(); await settle();
  // 24.6: $736,000 on the $800,000 value → LTV 92 % → 30 % coverage; MISMO rate quotes from two approved insurers, every borrower-facing plan
  clock.set(MST("2026-10-08", "09:00"));
  const q = await j.tool({ app: j.appId }, "24.6", "requestMiQuotes", { loan_amount_cents: "73600000", quotes: [miQuote("06", "bpmi_monthly", 62, `q-m-${j.R}`), miQuote("33", "bpmi_monthly", 64, `q-m2-${j.R}`), miQuote("06", "bpmi_single", 190, `q-s-${j.R}`), miQuote("06", "bpmi_split", 120, `q-sp-${j.R}`), miQuote("06", "lpmi_monthly", 70, `q-l-${j.R}`)] }, CLOSER);
  assert.equal(q.output["multiple_insurers"], true); assert.equal((await events(j.appId, "mi.quote.received")).length, 1);
  await settle();
  const card = (await cardsOf(j.appId, partyA)).find((c) => c.copy_key === "mi.compare.title"); assert.ok(card, "ComparisonCard mi.compare.title"); assert.equal(card!.kind, "ComparisonCard"); assert.equal(card!.command_ref, "mi.selectPlan"); assert.equal(card!.status, "pending");
  const columns = card!.props["columns"] as { id: string; title_key: string; rows: { label: string; value: string; value_key?: string }[]; cancellation_copy_key: string }[];
  assert.deepEqual(columns.map((c) => c.id), ["bpmi_monthly", "single", "split", "lpmi"], "the four plans");
  for (const c of columns) { assert.deepEqual(c.rows.map((r) => r.label), ["Monthly cost", "Upfront cost", "Rate", "When it can be cancelled"]); const cancel = c.rows.find((r) => r.label === "When it can be cancelled")!; assert.equal(cancel.value_key, `mi.cancel.${c.id}`); assert.ok(copyText(`mi.cancel.${c.id}`).length > 20); assert.equal(c.title_key, `mi.plan.${c.id}`); }
  assert.match(copyText("mi.cancel.bpmi_monthly"), /80%/); assert.match(copyText("mi.cancel.lpmi"), /higher rate/);
  assert.equal(columns.find((c) => c.id === "bpmi_monthly")!.rows[0]!.value, "$380.27/mo", "the cheaper of the two monthly quotes (62 bps on $736,000 / 12)");
  const quotes = (await entitiesOf("mi_quotes", j.appId)).map((x) => x.data); assert.equal(miPlanColumns(quotes as never).columns.length, 4);
  // the borrower picks lender-paid MI on the card → mi.selectPlan → 24.6 recordPlanElection (LTV 92 %, 30 % coverage) → `mi.plan.selected{lpmi_monthly}`
  clock.set(MST("2026-10-08", "10:00"));
  const chosen = await resolveCard(A, card!.card_instance_id, { option_id: "lpmi" });
  assert.equal(chosen.status, 201, JSON.stringify(chosen.body)); assert.equal(chosen.body["command"], "mi.selectPlan"); assert.equal((chosen.body["result"] as { plan: string }).plan, "lpmi");
  const selected = (await events(j.appId, "mi.plan.selected")).at(-1)!; assert.equal(selected.payload["premium_plan"] ?? selected.payload["plan"], "lpmi_monthly");
  // 24.6's own row: the election's LTV (`base_ltv_pct_rounded`) is the quote's loan amount ($736,000, `mi_quotes.loan_amount_cents`) over the platform's value basis ($800,000) — 92 %, 30 % coverage
  const cert = (await entitiesOf("mi_certificates", j.appId)).at(-1)!.data; assert.equal(cert["premium_plan"], "lpmi_monthly"); assert.equal(cert["status"], "plan_selected"); assert.equal(cert["base_ltv_pct_rounded"], 92); assert.equal(String(cert["property_value_basis_cents"]), "80000000"); assert.equal(cert["coverage_pct"], 30);
  // …and the revised LE (21.5, basis C — the consumer requested a change to the terms): the rate 6.125 % → 6.375 % (the LPMI rate), no mortgage-insurance line
  clock.set(MST("2026-10-08", "11:00"));
  const cc = await j.tool({ app: j.appId }, "21.5", "evaluateChangedCircumstance", { record: true, basis: "C", narrative: "the consumer elected lender-paid mortgage insurance on the MI options card (mi.selectPlan{lpmi}); the note rate carries the MI cost; the lender credit holds (21.5: never reduced)", evidence_document_ids: [card!.card_instance_id], information_received_at: MST("2026-10-08", "10:00"), revised: [{ fee_code: "lender_credit", amount_cents: "-261700" }] }, DISCLOSURE);
  const ccRow = cc.output["cc"] as { cc_id: string; kind: string }; assert.equal(ccRow.kind, "borrower_request");
  const render = (j as unknown as { LE_RENDER(): Record<string, unknown> }).LE_RENDER();
  const fees = (render["fees"] as Record<string, unknown>[]).filter((f) => !/mi|mortgage_insurance/i.test(String(f["fee_code"]))).map((f) => (f["fee_code"] === "lender_credit" ? { ...f, estimated_at: "2026-10-08" } : f));   // the LE's $2,617.00 credit holds: 21.5 never reduces lender credits
  clock.set(MST("2026-10-08", "11:10"));
  const v2 = await j.tool({ app: j.appId }, "21.5", "renderRevisedLE", { ...render, disclosure_id: `LE-${j.appId.slice(0, 8)}-2`, as_of: "2026-10-08", fees, pricing: { ...(render["pricing"] as Record<string, unknown>), rate_pct: "6.375", lender_credit_cents: "261700", locked: true, lock_expires_at: MST("2026-11-23", "17:00"), lock_time_zone: "America/Phoenix" }, cc_ids: [ccRow.cc_id] }, DISCLOSURE);
  assert.equal(v2.output["le_version"], 2);
  const rendered = await events(j.appId, "disclosure.le.rendered"); const snap = (v: number) => rendered.filter((e) => Number(e.payload["le_version"] ?? 1) === v).at(-1)!.payload;
  assert.equal(snap(1)["rate_pct"], "6.125"); assert.equal(snap(2)["rate_pct"], "6.375"); assert.ok(Number(snap(2)["rate_pct"]) > Number(snap(1)["rate_pct"]), "a higher rate");
  assert.ok(!((snap(2)["fees"] as { fee_code: string; mismo_fee_type?: string }[]).some((f) => /mi\b|mortgage_insurance|MIPremium|MortgageInsurance/i.test(`${f.fee_code} ${f.mismo_fee_type ?? ""}`))), "no MI line on the revised LE");
  assert.ok(!("mi_monthly_cents" in snap(2)) || snap(2)["mi_monthly_cents"] === null || String(snap(2)["mi_monthly_cents"]) === "0");
  assert.equal(((await cardsOf(j.appId, partyA)).find((c) => c.card_instance_id === card!.card_instance_id)!).status, "resolved");
});
