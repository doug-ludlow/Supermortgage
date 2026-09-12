/**
 * The purchase journey, measured against Postgres over the hosted runtime's HTTP surface (src/runtime/borrower/fixtures/journey-purchase.ts —
 * the sibling of lifecycle.test.ts's refinance): an organic "still looking" lead with the price range and the down payment as lead facts
 * (20.3), the application opened with the property to be determined and TWO borrowers (21.1), the signed contract arriving as a document and
 * confirmed through 32.2 (22.1 → `purchase_contracts`; the address and the price as the fifth item; the loan amount as the sixth →
 * `application.trid_received`), the LE on its own clock (21.2), identity / credit / assets (22.x), the traditional appraisal (24.1 → 24.2
 * `lower_of_two`), DU and the decision (23.1 → 23.3), BPMI and the HPA dates (24.6), title / CPL / the wire (24.4), the RON closing (26.2),
 * the CD counted backward from the Wed Nov 18 closing and the seller's CD (25.2), the OH purchase eNote set (26.1), consummation without
 * rescission (26.2), the wet-state funding the same day (26.3 → `loan.funded{2026-11-18}`), 30.2's hand-off into ONE `loans` row with the
 * opening ledger set balanced — and, with the 32.x flows attached to the same runtime, the cards the journey raised, each with its §2.3 case
 * (docs/ux/17 §2.3; `CARD_CASES` in src/runtime/borrower/flows/13-cross-cutting.ts). Every money assertion is a bigint of cents or the spec's
 * own "$1,234.56" figure. Runs on its OWN database (dropped and created here, like src/runtime/borrower/talk.test.ts) so it never collides
 * with another journey; skips without Postgres (REQUIRE_DB=1 makes that a failure).
 *
 * Phases share one application and one loan and run in file order; each phase's clock is set explicitly by the fixture.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { connect, reachable, type Db } from "../infra/db/client.ts";
import { loadOverriddenRegistry } from "../domain/timer-overrides.ts";
import { FixedClock } from "../kernel/events/index.ts";
import { Runtime } from "./app.ts";
import { createApiServer, listen } from "./server.ts";
import { createLogger } from "./log.ts";
import { createBorrowerRouter, type BorrowerRouter } from "./borrower/routes.ts";
import { CARD_CASES, CHAT_TRIGGER, assertCardCase, cardCaseOf } from "./borrower/flows/13-cross-cutting.ts";
import { PurchaseJourney, EDT, EST } from "./borrower/fixtures/journey-purchase.ts";

const DB_URL = process.env["PURCHASE_TEST_DATABASE_URL"] ?? "postgresql://sm:sm@localhost/supermortgage_purchase_test";
/** The server is what has to be reachable: the test's own database is dropped and created in `before` (talk.test.ts's pattern). */
const ADMIN_URL = (() => { const u = new URL(DB_URL); u.pathname = "/postgres"; return u.toString(); })();
const up = await reachable(ADMIN_URL);
if (!up && process.env["REQUIRE_DB"]) throw new Error(`REQUIRE_DB set but ${DB_URL} is not reachable`);
const skip = up ? false : `no Postgres at ${DB_URL}`;
const TOKEN = "t-" + randomUUID();
const R = randomUUID().slice(0, 8);
const EMAIL_A = `casey-${R}@example.test`; const EMAIL_B = `riley-${R}@example.test`;
type P = Record<string, unknown>;

let db: Db; let runtime: Runtime; let router: BorrowerRouter; let base = ""; let close: () => Promise<void> = async () => undefined;
let partnerPartyId = "";
const clock = new FixedClock("2026-09-10T16:00:00.000Z");
const parties = new Map<string, string>();   // e-mail → party id
let j: PurchaseJourney;
let du: Awaited<ReturnType<PurchaseJourney["duSubmitAndInterpret"]>>;

test.before(async () => {
  if (skip) return;
  // own database: dropped and created here, then migrated — nothing this file writes can collide with another test run's journey
  const name = new URL(DB_URL).pathname.slice(1);
  const a = connect(ADMIN_URL); await a.query(`DROP DATABASE IF EXISTS ${name}`); await a.query(`CREATE DATABASE ${name}`); await a.end();
  execFileSync(fileURLToPath(new URL("../../db/migrate.sh", import.meta.url)), { env: { ...process.env, DATABASE_URL: DB_URL }, stdio: "pipe" });
  db = connect(DB_URL);
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock });
  partnerPartyId = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id) VALUES ('servicer', $1, '123456789', '1000123') RETURNING id`, [`Partner Bank ${R}`]))[0]!.id;
  const logger = createLogger("json", (line) => { if (process.env["LIFECYCLE_DEBUG"] && /"severity":"ERROR"|flow/i.test(line)) process.stderr.write(line + "\n"); });
  // the 32.x flows on the same runtime: the owning processes' events become the cards the borrower sees (their §2.3 cases are listed at the end)
  router = createBorrowerRouter({ runtime, logger, environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost"], urlSecret: "test-secret", defaultPartnerId: partnerPartyId });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger, console: false, borrowerRouter: router });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => { router.hub.close(); server.closeAllConnections?.(); server.close(() => db.end().then(() => resolve())); });
  j = new PurchaseJourney({ runtime, db, base, token: TOKEN, clock, borrowerEmail: EMAIL_A, coBorrowerEmail: EMAIL_B, partnerPartyId, settle, linkParties: async () => { for (const email of [EMAIL_A, EMAIL_B]) parties.set(email, (await signIn(email)).party_id); } });
});
test.after(async () => { if (!skip) { await router.flows?.settle(); await close(); } });

const settle = () => router.flows!.settle();
async function api(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: P }> {
  const r = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text(); return { status: r.status, body: text ? (JSON.parse(text) as P) : {} };
}
/** L1 through the FAKE code path (the code comes back in the body in nonprod): the e-mail on the application borrower row links the party. */
async function signIn(email: string): Promise<{ token: string; party_id: string }> {
  await settle();
  const req = await api("POST", "/v1/borrower/auth/otp", { action: "request", channel: "email", destination: email }); assert.equal(req.status, 200, JSON.stringify(req.body));
  const ver = await api("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: req.body["challenge_id"], code: req.body["fake_code"] }); assert.equal(ver.status, 200, JSON.stringify(ver.body));
  await settle();
  return { token: ver.body["token"] as string, party_id: (ver.body["party"] as { party_id: string }).party_id };
}
const n = async (sql: string, params: unknown[] = []): Promise<number> => Number((await db.query<{ c: string }>(sql, params))[0]!.c);
const loanBalance = async (loanId: string, account: string): Promise<bigint> => BigInt((await db.query<{ s: string }>(`SELECT coalesce(sum(amount_cents), 0)::text AS s FROM ledger_lines WHERE scope = 'loan' AND loan_id = $1 AND account = $2`, [loanId, account]))[0]!.s);
const timer = async (code: string, appId: string) => (await db.query<{ status: string; due_date: string | null; anchor_date: string | null }>(`SELECT status, due_date::text, anchor_date::text FROM timers WHERE code = $1 AND application_id = $2 ORDER BY armed_at DESC`, [code, appId]))[0];
/** Run one fixture phase, then let every flow reaction it raised settle before the next commit (the §2.3 attribution rule). */
async function phase<T>(run: () => Promise<T>): Promise<T> { const out = await run(); await settle(); return out; }

// ═══════════════════════════════════════════════ the purchase: lead → application (TBD) → contract → the six items ═══════════════════════════════════════════════

test("purchase a. 20.3 the organic lead Thu Oct 15 (Buy · Still looking · Ohio · $450,000 range, $45,000 down; the soft pull), the application Mon Oct 19 18:40 EDT with the property to be determined (`application.received`, no TRID item for the address), the signed contract through 22.1 and 32.2 (`purchase_contracts`: $457,800, closing Wed Nov 18; the address as the fifth item) and the $412,000 loan amount at 20:44 EDT as the sixth — `application.trid_received`, REGZ_1026_19E1_LE_3BD due Thu Oct 22", { skip }, async () => {
  await phase(() => j.seedPricing()); await phase(() => j.openLead());
  const lead = await j.entity("leads", j.leadId);
  assert.equal(lead?.["transaction_intent"], "purchase"); assert.equal(lead?.["contract_status"], "looking"); assert.equal(String(lead?.["price_range_cents"]), "45000000"); assert.equal(String(lead?.["down_payment_cents"]), "4500000"); assert.equal(lead?.["property_state"], "OH");
  await phase(() => j.openApplication());
  assert.equal(j.appId, j.leadId, "20.3's conversion makes the lead id the application id");
  assert.equal(parties.size, 2, "both borrowers signed in (their parties on application_borrowers) before the conversion");
  const app = (await db.query<{ transaction_type: string; occupancy: string; channel: string; status: string; loan_id: string | null }>(`SELECT transaction_type::text AS transaction_type, occupancy::text AS occupancy, channel::text AS channel, status, loan_id FROM applications WHERE id = $1`, [j.appId]))[0]!;
  assert.equal(app.transaction_type, "purchase"); assert.equal(app.occupancy, "primary"); assert.equal(app.channel, "organic"); assert.equal(app.loan_id, null);
  assert.equal(await n(`SELECT count(*)::text AS c FROM application_properties WHERE application_id = $1`, [j.appId]), 0, "still looking: no subject property row");
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_events WHERE application_id = $1 AND type = 'application.received' AND loan_id IS NULL`, [j.appId]), 1, "a Reg B application, keyed by the application alone");
  assert.ok(await timer("REGB_1002_9_DECISION_30", j.appId), "the Reg B decision clock runs from the application");
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_events WHERE application_id = $1 AND type = 'application.trid_received'`, [j.appId]), 0, "32.3 T26: no TRID application without an address");
  await phase(() => j.interview());
  const stated = (await db.query<{ payload: P }>(`SELECT payload FROM loan_events WHERE application_id = $1 AND type = 'application.six_item.captured' ORDER BY sequence`, [j.appId])).map((e) => String(e.payload["item"]));
  assert.deepEqual([...new Set(stated)].sort(), ["income", "name", "ssn"], `name, SSN (20.3's soft-pull authorization replayed by the conversion, then stated), income — no address, value or amount yet: ${stated.join(", ")}`);
  await phase(() => j.signContract());
  const pc = (await db.query<{ sales_price_cents: string; closing_date: string; contract_date: string; seller_concessions_cents: string; document_id: string | null }>(`SELECT sales_price_cents::text AS sales_price_cents, closing_date::text AS closing_date, contract_date::text AS contract_date, seller_concessions_cents::text AS seller_concessions_cents, document_id FROM purchase_contracts WHERE application_id = $1`, [j.appId]))[0];
  assert.ok(pc, "the purchase_contracts row"); assert.equal(pc.sales_price_cents, "45780000"); assert.equal(pc.closing_date, "2026-11-18"); assert.equal(pc.contract_date, "2026-10-15"); assert.equal(pc.seller_concessions_cents, "500000"); assert.equal(pc.document_id, null, "a bus-ingested contract has no `documents` table row for the FK; the entity row keeps the id");
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_events WHERE application_id = $1 AND type = 'purchase_contract.confirmed'`, [j.appId]), 1);
  const stored = await j.entity("purchase_contracts", j.contractDocumentId);
  assert.equal(((stored?.["fields"] as Record<string, { value: string; source: string }>)["earnest_money_cents"]!).value, "500000"); assert.equal(((stored?.["fields"] as Record<string, { source: string }>)["property_address"]!).source, "document_extraction");
  const items = await db.query<{ payload: P }>(`SELECT payload FROM loan_events WHERE application_id = $1 AND type = 'application.six_item.captured' ORDER BY sequence`, [j.appId]);
  assert.deepEqual(items.slice(-3).map((e) => e.payload["item"]), ["property_value_estimate", "property_address", "loan_amount_sought"], "the contract brings the value and the address; the amount is the sixth");
  const trid = (await db.query<{ occurred_at: string; payload: P }>(`SELECT occurred_at, payload FROM loan_events WHERE application_id = $1 AND type = 'application.trid_received'`, [j.appId]));
  assert.equal(trid.length, 1); assert.equal(new Date(trid[0]!.occurred_at).toISOString(), EDT("2026-10-19", "20:44"));
  const le = await timer("REGZ_1026_19E1_LE_3BD", j.appId);
  assert.ok(le); assert.equal(le.status, "armed"); assert.equal(le.due_date, "2026-10-22");   // Tue 20, Wed 21, Thu 22 (21.2 worked example 2b)
  const intake = await j.entity("applications", j.appId);
  const six = intake?.["six_items"] as Record<string, { submitted_at: string | null; source: string }>;
  assert.equal(six["property_address"]!.source, "borrower_confirmed_prefill", "the extracted address confirmed by the borrower (32.3 T29)"); assert.equal(six["property_address"]!.submitted_at, EDT("2026-10-19", "20:40"));
  assert.equal(intake?.["status"], "trid_received"); assert.equal(intake?.["property_state"], "OH"); assert.equal(String(intake?.["loan_amount_sought_cents"]), "41200000"); assert.equal(String(intake?.["property_value_estimate_cents"]), "45780000");
  assert.equal(intake?.["property_address"], null, "21.1 confirmPrefill{value} records the item, not the record's address (see the fixture's NOTE)");
  const lead2 = await j.entity("leads", j.leadId);
  assert.equal(lead2?.["status"], "converted"); assert.equal((lead2?.["trid_items"] as Record<string, { present: boolean }>)["property_address"]!.present, true, "20.3 T5: the lead's own record carries the item the contract brought");
});

test("purchase b. 22.6 identity for both (B's second pass Oct 20) and the OFAC screen, 21.4's credit-report fee (rule 1, before any LE), 22.2's tri-merge after the joint-intent gate (representative score 705); 20.4 worked example B on the Tue Oct 20 sheet (HomeReady waiver: LLPA $0, 6.375 %, P&I $2,570.34, lender credit $515.00); 21.2's LE delivered and e-signed Thu Oct 22 inside its clock (the $130.47 BPMI in projected payments); 24.6 two insurers' quotes Thu Oct 22 and the monthly BPMI election at 25 % / 0.38 % = $130.47 (LTV 89.99 → 90 %)", { skip }, async () => {
  await phase(() => j.verifyAndOrderCredit());
  const report = await j.entity("credit_reports", j.creditReportId);
  assert.equal(report?.["representative_score"], 705); assert.equal(report?.["score_model"], "classic_fico");
  await phase(() => j.quoteAndLe());
  const q = await j.entity("pricing_quotes", j.QUOTE);
  assert.equal(q?.["note_rate"], "0.06375"); assert.equal(String(q?.["pi_cents"]), "257034"); assert.equal(String(q?.["lender_credit_cents"]), "51500"); assert.equal(String(q?.["llpa_cents"] ?? "0"), "0");
  assert.equal((await timer("REGZ_1026_19E1_LE_3BD", j.appId))!.status, "satisfied", "the LE delivered Oct 22 satisfies the three-business-day clock");
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_events WHERE application_id = $1 AND type = 'disclosure.le.received' AND loan_id IS NULL`, [j.appId]), 1);
  await phase(() => j.miQuotesAndElection());
  const cert = await j.entity("mi_certificates", j.miCertificateId);
  assert.equal(cert?.["status"], "plan_selected"); assert.equal(String(cert?.["monthly_premium_cents"]), "13047"); assert.equal(cert?.["coverage_pct"], 25); assert.equal(cert?.["premium_plan"], "bpmi_monthly"); assert.equal(cert?.["base_ltv_pct_rounded"], 90); assert.equal(String(cert?.["property_value_basis_cents"]), "45780000");
});

test("purchase c. intent Fri Oct 23 09:14 EDT; 24.1 the traditional appraisal ordered after it (24.1 R2 refuses an SM-borne order before intent), assigned the same day, inspected Mon Oct 26, received Thu Oct 29 at $460,000 → 24.2 `value_used = lower_of_two` $457,800.00 and the Reg B copy e-delivered Fri Oct 30 (SM_VALUATION_* clocks satisfied); the 30-day lock Mon Oct 26 → expires Wed Nov 25 (21.4 worked example 3) and 29.1's commitment; 23.1 DU Mon Oct 26: Approve/Eligible, DTI 45.44 %, LTV 89.99, MI required → 23.2 opens the PTD conditions", { skip }, async () => {
  await phase(() => j.recordIntent());
  assert.equal((await timer("REGZ_1026_19E2_INTENT_FEE_GATE", j.appId))!.status, "satisfied");
  await phase(() => j.appraisal());
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_events WHERE application_id = $1 AND type = 'valuation.ordered' AND loan_id IS NULL`, [j.appId]), 1);
  for (const t of ["valuation.assigned", "valuation.inspection.scheduled", "valuation.inspection.completed", "valuation.received", "valuation.value_used.set", "valuation.copy.delivered"]) assert.equal(await n(`SELECT count(*)::text AS c FROM loan_events WHERE application_id = $1 AND type = $2`, [j.appId, t]), 1, `${t} once`);
  const vu = (await db.query<{ payload: P }>(`SELECT payload FROM loan_events WHERE application_id = $1 AND type = 'valuation.value_used.set'`, [j.appId]))[0]!.payload;
  assert.equal(String(vu["value_used_cents"]), "45780000"); assert.equal(vu["value_basis"], "lower_of_two"); assert.equal(String(vu["appraised_value_cents"]), "46000000");
  for (const code of ["SM_VALUATION_ASSIGN_SLA_2BD", "SM_VALUATION_INSPECT_SLA_7CD", "SM_VALUATION_REPORT_SLA_10CD"]) { const t = await timer(code, j.appId); assert.ok(t, `${code} armed`); assert.equal(t.status, "satisfied", `${code} satisfied by the order's own events`); }
  await phase(() => j.quoteForLock()); await phase(() => j.requestLock()); await phase(() => j.executeLockAndCommit());
  const lock = await j.entity("locks", j.lockId);
  assert.equal(lock?.["status"], "executed"); assert.equal(lock?.["note_rate"], "6.375"); assert.equal(lock?.["expires_on"], "2026-11-25"); assert.equal(lock?.["lock_period_days"], 30);
  assert.ok(j.commitmentId); assert.ok(j.commitmentExpiresOn >= "2026-11-25", `the commitment outlives the lock: ${j.commitmentExpiresOn}`);
  du = await phase(() => j.duSubmitAndInterpret());
  const sub = (await db.query<{ payload: P }>(`SELECT payload FROM loan_events WHERE application_id = $1 AND type = 'du.findings.received'`, [j.appId]))[0]!.payload;
  assert.equal(sub["recommendation"], "approve_eligible");
  const submission = await j.entity("du_submissions", du.submission_id);
  assert.equal(submission?.["dti_du"], "45.44"); assert.equal(submission?.["ltv_du"], "89.9956");   // 412,000 / 457,800 (the sales price is the lower of the two) — the spec's "LTV 89.99" at two places assert.equal(submission?.["status"], "findings_received");
  assert.ok(du.conditions.length >= 6, `${du.conditions.length} PTD conditions from the findings`);
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_events WHERE application_id = $1 AND type IN ('du.submitted', 'du.findings.received', 'du.findings.interpreted') AND loan_id IS NULL`, [j.appId]), 3);
});

test("purchase d. 23.3 the conditional approval Mon Oct 26 (valid until Wed Nov 25 — the lock is the earliest component); 24.6 the delegated order, the commitment Tue Oct 27, the initial amortization schedule and the HPA dates (Oct 1, 2034 / Dec 1, 2035 / Jan 1, 2042), the terms verification and the §4903 disclosure → `docs_ready`; 22.4 the assets, the seller's $5,000.00 IPC inside the 3 % band, the funds-to-close worksheet ($43,997.00 to close; $51,140.18 usable; reserves $45,143.18 ≥ $8,000.00 → sufficient); 24.4 the settlement agent vetted, the commitment on the 2021 ALTA form (ALTA 8.1 committed), the wire verified Tue Nov 10, the CPL Mon Nov 16, the consummation gates open; 23.3 clear to close Fri Nov 6", { skip }, async () => {
  await phase(() => j.conditionalApproval(du));
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_events WHERE application_id = $1 AND type = 'decision.issued' AND payload->>'kind' = 'conditional_approval'`, [j.appId]), 1);
  const hpa = await phase(() => j.miOrderAndDisclosure());
  assert.equal(hpa.pi_cents, "257034");                                                   // 24.6 worked example 1: P × r ÷ (1 − (1+r)^−360) at 6.375 %
  assert.equal(hpa.cancellation_date, "2034-10-01");                                      // payment 94: first scheduled balance ≤ 80 % of $457,800
  assert.equal(hpa.termination_date, "2035-12-01");                                       // payment 108: first ≤ 78 %
  assert.equal(hpa.midpoint_termination_date, "2042-01-01");                              // payment 180 → the first day of the following month (§4902(c))
  const cert = await j.entity("mi_certificates", j.miCertificateId);
  assert.equal(cert?.["status"], "docs_ready"); assert.equal(cert?.["hpa_disclosure_kind"], "initial_fixed"); assert.equal(cert?.["certificate_number"], j.miCertificateNumber);
  const ws = await phase(() => j.assetsAndFundsToClose());
  assert.equal(String(ws["cash_to_close_cents"]), "4399700");                  // 45,800.00 + 8,712.00 − 5,000.00 − 5,000.00 − 515.00
  assert.equal(String(ws["verified_usable_closing_cents"]), "5114018");        // 26,240.18 + 14,900.00 + 10,000.00
  assert.equal(String(ws["verified_usable_reserves_cents"]), "4514318");       // 51,140.18 − 43,997.00 + 38,000.00
  assert.equal(ws["sufficient"], true);
  await phase(() => j.title());
  const order = await j.entity("title_orders", j.titleOrderId);
  assert.equal(order?.["status"], "cleared"); assert.equal(order?.["cpl_addressee_ok"], true); assert.equal((order?.["policy_form"] as string), "ALTA Loan Policy (07-01-2021)");
  await phase(() => j.clearToClose());
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_events WHERE application_id = $1 AND type = 'clear_to_close.issued' AND loan_id IS NULL`, [j.appId]), 1);
});

test("purchase e. 26.2 the RON closing scheduled Wed Nov 18 10:05 EST (Ohio on the Fannie Mae RON list; wet state; not rescindable); 25.2 worked example 4: the figures Thu Nov 12, CD v1 e-delivered Fri Nov 13 with e-sign receipts → `earliest_consummation_date = 2026-11-17`, REGZ_1026_19F1_CD_3SBD_GATE armed and open for Nov 18", { skip }, async () => {
  await phase(() => j.scheduleClosing());
  const sch = (await db.query<{ payload: P }>(`SELECT payload FROM loan_events WHERE application_id = $1 AND type = 'closing.scheduled'`, [j.appId]))[0]!.payload;
  assert.equal(sch["closing_type"], "ron"); assert.equal(sch["scheduled_note_date"], "2026-11-18"); assert.equal(sch["enote"], true);
  await phase(() => j.closingDisclosure());
  const cd = await j.entity("disclosures", j.cdDisclosureId);
  assert.equal(cd?.["cd_version"], 1); assert.equal(String((cd?.["figures"] as P)["cash_to_close_cents"]), "4399700"); assert.equal(String((cd?.["figures"] as P)["pi_cents"]), "257034");
  const wp = (await db.query<{ payload: P }>(`SELECT payload FROM loan_events WHERE application_id = $1 AND type = 'disclosure.cd.waiting_period.computed' ORDER BY sequence DESC LIMIT 1`, [j.appId]))[0]!.payload;
  assert.equal(wp["earliest_consummation_date"], "2026-11-17");   // Fri Nov 13 received: Sat 14 (1), Mon 16 (2), Tue 17 (3)
  const gate = await timer("REGZ_1026_19F1_CD_3SBD_GATE", j.appId); assert.ok(gate); assert.equal(gate.status, "armed");
  const open = await j.tool({ app: j.appId }, "25.2", "assertGateOpen", { gate: "REGZ_1026_19F1_CD_3SBD_GATE", requested_on: "2026-11-18", op: "evaluate" }, { kind: "agent", id: "disclosure" });
  assert.equal(open.output["open"], true);
});

test("purchase f. 26.1 the OH purchase eNote set Mon Nov 16 (3200e, the Ohio mortgage, the final 1003 — no H-8), released to the agent; 26.2 Wed Nov 18: both signers proofed, the eNote signed 10:31 EST = `closing.consummated{note_date 2026-11-18}` with no rescission period, the mortgage acknowledged, the Authoritative Copy sealed and registered (MERS_PROC_ENOTE_REGISTER_1BD due Thu Nov 19); the seller's CD; 26.3 worked example 5: wet funding the same day — 13 × $71.96 = $935.48 prepaid interest, net wire $410,339.52 → `loan.funded{2026-11-18}` keyed by the application; 24.6 MI activated effective Nov 18", { skip }, async () => {
  await phase(() => j.closeAndSign());
  const forms = (await db.query<{ data: P }>(`SELECT data FROM entity_current WHERE kind = 'documents' AND (data->>'application_id') = $1`, [j.appId])).map((r) => String((r.data["metadata"] as P | undefined)?.["form_number"] ?? ""));
  assert.ok(forms.includes("3200e"), `the eNote in the set: ${forms.join(", ")}`); assert.ok(!forms.includes("NTC_REGZ_1026_23_H8"), "no Notice of Right to Cancel on a purchase");
  const cons = (await db.query<{ payload: P }>(`SELECT payload FROM loan_events WHERE application_id = $1 AND type = 'closing.consummated'`, [j.appId]))[0]!.payload;
  assert.equal(cons["note_date"], "2026-11-18"); assert.equal(cons["consummation_at"], EST("2026-11-18", "10:31"));
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_events WHERE application_id = $1 AND type = 'rescission.period.started'`, [j.appId]), 0, "§1026.23(f)(1): a purchase-money transaction has no rescission period");
  const reg = await timer("MERS_PROC_ENOTE_REGISTER_1BD", j.appId); assert.ok(reg); assert.equal(reg.status, "satisfied"); assert.equal(reg.due_date, "2026-11-19");
  await phase(() => j.sellerCd());
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_events WHERE application_id = $1 AND type = 'disclosure.seller_cd.received'`, [j.appId]), 1);
  await phase(() => j.fund());
  const funded = (await db.query<{ payload: P; loan_id: string | null }>(`SELECT payload, loan_id FROM loan_events WHERE application_id = $1 AND type = 'loan.funded'`, [j.appId]));
  assert.equal(funded.length, 1); assert.equal(funded[0]!.loan_id, null, "no servicing loan exists yet: 26.3's loan.funded is keyed by the application only");
  const lf = funded[0]!.payload;
  assert.equal(lf["disbursement_date"], "2026-11-18"); assert.equal(lf["funding_date"], "2026-11-18"); assert.equal(String(lf["per_diem_cents"]), "7196"); assert.equal(String(lf["prepaid_interest_cents"]), "93548"); assert.equal(lf["prepaid_days"], 13); assert.equal(lf["first_payment_date"], "2027-01-01"); assert.equal(lf["lpi_date"], "2026-12-01"); assert.equal(lf["rescission_expires_at"], null); assert.equal(String(lf["net_wire_cents"]), "41033952"); assert.equal(String(lf["funded_amount_cents"]), "41200000");
  const mi = await phase(() => j.activateMi());
  assert.equal(mi["status"], "active"); assert.equal(mi["activation_effective_date"], "2026-11-18"); assert.equal(mi["certificate_number"], j.miCertificateNumber);
});

// ═══════════════════════════════════════════════ the hand-off: 30.2 boards ONE loan from the record ═══════════════════════════════════════════════

test("purchase g. POST /v1/applications/{id}/fund at 15:20 EST Wed Nov 18 boards the loan from the record (30.2 worked example 2): OB-001…OB-022 pass (MI active for LTV 90 %; the $412,000 note at 6.375 % hashes to 26.1's eNote; P&I $2,570.34 within $0.01), the opening set balances (principal 41,200,000 / escrow 124,000 / prepaid interest 93,548), loan_terms v1 carries P&I $2,570.34 + escrow $615.00 + MI $130.47, the first statement cycle opens for Jan 1, 2027 at $3,315.81, SM_ORIG_BOARD_T1BD satisfied (due Thu Nov 19), both ids on every hand-off event; 30.4 opens the hand-off", { skip }, async () => {
  const loanId = await phase(() => j.board());
  const r = await api("GET", `/v1/applications/${j.appId}`, undefined, TOKEN); assert.equal((r.body["application"] as P)["loan_id"], loanId);
  const loan = (await db.query<{ origination_application_id: string | null; fnma_loan_number: string | null; status: string; min: string | null; emortgage: boolean; original_upb_cents: string; first_payment_date: string; maturity_date: string }>(`SELECT origination_application_id, fnma_loan_number, status, min, emortgage, original_upb_cents::text AS original_upb_cents, first_payment_date::text AS first_payment_date, maturity_date::text AS maturity_date FROM loans WHERE id = $1`, [loanId]))[0]!;
  assert.equal(loan.origination_application_id, j.appId); assert.equal(loan.fnma_loan_number, null); assert.equal(loan.status, "active"); assert.equal(loan.min, j.MIN); assert.equal(loan.original_upb_cents, "41200000"); assert.equal(loan.first_payment_date, "2027-01-01"); assert.equal(loan.maturity_date, "2056-12-01");
  assert.equal(await n(`SELECT count(*)::text AS c FROM application_borrowers ab JOIN loan_borrowers lb ON lb.borrower_id = ab.borrower_id AND lb.loan_id = $2 WHERE ab.application_id = $1`, [j.appId, loanId]), 2);
  const prop = (await db.query<{ address_line1: string; city: string; state: string; county: string | null }>(`SELECT p.address_line1, p.city, p.state, p.county FROM loans l JOIN properties p ON p.id = l.property_id WHERE l.id = $1`, [loanId]))[0]!;
  assert.deepEqual([prop.address_line1, prop.city, prop.state, prop.county], ["1187 Oakwood Ave", "Columbus", "OH", "Franklin"]);
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_terms WHERE loan_id = $1 AND source = 'boarding' AND pi_cents = 257034 AND escrow_payment_cents = 74547 AND note_rate_bps = 63750`, [loanId]), 1, "P&I $2,570.34; escrow $615.00 + MI $130.47; 6.375 %");
  assert.equal(await n(`SELECT count(*)::text AS c FROM boarding_validations WHERE application_id = $1 AND rule_code LIKE 'OB-%' AND result = 'pass'`, [j.appId]), 22);
  assert.equal(await n(`SELECT count(*)::text AS c FROM boarding_validations WHERE application_id = $1 AND rule_code LIKE 'OB-%' AND result <> 'pass'`, [j.appId]), 0);
  const ledger = await api("GET", `/v1/loans/${loanId}/ledger`, undefined, TOKEN);
  const sets = ledger.body["entry_sets"] as { id: string }[]; assert.equal(sets.length, 1);
  assert.equal(await loanBalance(loanId, "principal"), 41_200_000n);
  assert.equal(-(await loanBalance(loanId, "escrow")), 124_000n);              // $1,240.00 — 26.3 worked example 5's deposit
  assert.equal(-(await loanBalance(loanId, "prepaid_interest")), 93_548n);     // $935.48 = 13 × $71.96
  assert.equal(await n(`SELECT count(*)::text AS c FROM (SELECT set_id FROM ledger_lines WHERE set_id = $1 GROUP BY set_id HAVING sum(amount_cents) <> 0) x`, [sets[0]!.id]), 0, "the opening set balances");
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_events WHERE loan_id = $1 AND type = 'statement.cycle.opened' AND payload->>'first_cycle' = 'true' AND payload->>'cycle_due_date' = '2027-01-01' AND payload->>'amount_due_cents' = '331581'`, [loanId]), 1);   // $2,570.34 + $615.00 + $130.47
  const t1bd = await timer("SM_ORIG_BOARD_T1BD", j.appId); assert.ok(t1bd); assert.equal(t1bd.status, "satisfied"); assert.equal(t1bd.anchor_date, "2026-11-18"); assert.equal(t1bd.due_date, "2026-11-19");
  const log = await j.eventsOf(`application_id = $1`, [j.appId]);
  const stagedAt = log.findIndex((e) => e.type === "loan.staged"); assert.ok(stagedAt > 0);
  for (const e of log.slice(0, stagedAt)) assert.equal(e.loan_id, null, `${e.type} before the hand-off is keyed by the application alone`);
  for (const e of log.slice(stagedAt)) { if (e.type.startsWith("timer.")) continue; assert.equal(e.loan_id, loanId, `${e.type} carries the loan`); assert.equal(e.application_id, j.appId); }
  for (const t of ["loan.staged", "loan.validated", "loan.boarded", "ledger.opening_posted", "consents.boarded", "documents.indexed", "timers.seeded", "statement.cycle.opened"]) assert.ok(log.some((e) => e.type === t), `${t} emitted`);
  assert.ok(await n(`SELECT count(*)::text AS c FROM loan_events WHERE loan_id = $1 AND type = 'notice.sent'`, [loanId]) >= 2, "a first-payment letter per borrower");
  await phase(() => j.openServicingHandoff());
  assert.ok(await n(`SELECT count(*)::text AS c FROM loan_events WHERE loan_id = $1 AND type = 'servicing_handoff.opened' AND application_id = $2`, [loanId, j.appId]) >= 1, "30.4's servicing_handoff.opened carries both ids");
});

// ═══════════════════════════════════════════════ the cards along the way ═══════════════════════════════════════════════

test("purchase h. the cards the 32.x flows raised for the two borrowers along the way, each with its §2.3 case (docs/ux/17 §2.3; CARD_CASES): every `card.sent` maps through its kind and the trigger the flows registry recorded, the evidence / consent / integration / document-or-choice cases all appear, the contract's ConfirmCard was raised on the extraction, and no card exists because the assistant decided to send one", { skip }, async () => {
  await settle();
  const flows = router.flows!; const ids = [...parties.values()];
  const sent = await db.query<{ sequence: string; occurred_at: string; payload: P }>(`SELECT sequence::text AS sequence, occurred_at, payload FROM loan_events WHERE type = 'card.sent' AND payload->>'party_id' = ANY($1::text[]) ORDER BY sequence`, [ids]);
  assert.ok(sent.length >= 15, `a purchase raises cards from the consents to boarding (${sent.length})`);
  const cards = await db.query<{ card_instance_id: string; status: string; props: P }>(`SELECT card_instance_id, status, props FROM card_instances WHERE card_instance_id = ANY($1::uuid[])`, [sent.map((e) => String(e.payload["card_instance_id"]))]);
  const rows = new Map(cards.map((c) => [c.card_instance_id, c]));
  const failures: string[] = []; const byCase = new Map<string, number>(); const kinds = new Map<string, number>(); const listing: string[] = [];
  for (const e of sent) {
    const p = e.payload; const id = String(p["card_instance_id"]); const kind = String(p["kind"]); const copy_key = String(p["copy_key"]);
    const contexts = flows.triggerOf(id); assert.ok(contexts, `card.sent ${kind} ${copy_key} (${id}) was never seen committing by the flows registry`);
    const triggers = [...new Set(contexts.flatMap((c) => c.triggers))]; const flow = String(rows.get(id)?.props["flow"] ?? contexts[0]?.flow ?? "");
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    try {
      const c = assertCardCase({ kind, copy_key, trigger: triggers.length ? triggers : CHAT_TRIGGER, command_ref: (p["command_ref"] as string | null) ?? null, created_by: (p["created_by"] as string | null) ?? null });
      byCase.set(c, (byCase.get(c) ?? 0) + 1);
      listing.push(`${new Date(e.occurred_at).toISOString().slice(0, 16)}  ${flow.padEnd(5)} ${kind.padEnd(17)} ${copy_key.padEnd(34)} ${rows.get(id)?.status ?? "?"}  ← ${triggers.join(" | ") || CHAT_TRIGGER}  → ${c}`);
    } catch (err) { failures.push(`${flow} ${copy_key}: ${err instanceof Error ? err.message : String(err)}`); }
  }
  process.stderr.write(`purchase cards (${sent.length}) — ${[...kinds].map(([k, v]) => `${k}×${v}`).join(", ")}; cases ${JSON.stringify([...byCase])}\n${listing.join("\n")}\n`);
  assert.deepEqual(failures, [], `cards outside §2.3:\n${failures.join("\n")}`);
  for (const c of ["evidence", "consent", "integration", "document_or_choice"]) assert.ok((byCase.get(c) ?? 0) > 0, `the purchase exercises the ${c} case`);
  assert.ok(sent.some((e) => e.payload["copy_key"] === "contract.confirm" && e.payload["kind"] === "ConfirmCard"), "32.3 C1: the contract's ConfirmCard from the FAKE extraction");
  assert.ok(sent.some((e) => e.payload["kind"] === "ConsentCard"), "32.3 E6: the consents on application.received");
  for (const kind of Object.keys(CARD_CASES)) assert.equal(cardCaseOf(kind, CHAT_TRIGGER), null, `${kind} never exists because the assistant decided to send one`);
});
