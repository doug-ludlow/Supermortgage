// 32.11 Rate-watch and the re-refinance loop
// spec/sections/32-borrower-experience/32-11-rate-watch-and-the-re-refinance-loop.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// Every T-id drives the real runtime over HTTP (the journey fixture: the servicing book → 20.x → 21.x … → 26.3 → 30.2)
// with the borrower flow of src/runtime/borrower/flows/11-rate-watch.ts reacting to the committed events, then reads
// the borrower API (record, thread, cards) and the owning processes' tables. What the borrower SEES — the Rate-watch
// block, the OfferCard fields, the funded StatusCard, the escrow line, no cancel window — is asserted on the real
// components in apps/borrower/tests/cards/flow-11-rate-watch.test.tsx. T10 is a string test over the copy library and
// runs without a database; the rest skip without one.
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
import { FixedClock } from "../../kernel/events/index.ts";
import { Runtime } from "../../runtime/app.ts";
import { createApiServer, listen } from "../../runtime/server.ts";
import { createLogger } from "../../runtime/log.ts";
import { createBorrowerRouter, type BorrowerRouter } from "../../runtime/borrower/routes.ts";
import { Journey, MST, EDT, EST, MLO, OFFICER, CASHIERING } from "../../runtime/borrower/fixtures/journey.ts";
import { REFI_OFFER_SAMPLE } from "../../notices/authored/section20-2.ts";
import { determineRescindability } from "../compliance-disclosures/ops-25-3.ts";
import { NOT_A_COMMITMENT_TEXT, RATES_CHANGE_DAILY_TEXT, NO_COST_LINE, paymentLine, lenderLine, offerCardProps, bestAvailableRate, pct } from "../../runtime/borrower/flows/11-rate-watch.ts";

const DB_URL = process.env["TEST_DATABASE_URL"] ?? "postgresql://sm:sm@localhost/supermortgage_test";
const up = await reachable(DB_URL);
if (!up && process.env["REQUIRE_DB"]) throw new Error(`REQUIRE_DB set but ${DB_URL} is not reachable`);
const skip = up ? false : `no Postgres at ${DB_URL}`;
const TOKEN = "ops-" + randomUUID();
const clock = new FixedClock("2026-09-10T16:00:00.000Z");
const PRICING = { kind: "agent" as const, id: "pricing" }; const DISCLOSURE = { kind: "agent" as const, id: "disclosure" }; const PAYOFF = { kind: "agent" as const, id: "payoff-release" }; const ESCROW = { kind: "agent" as const, id: "escrow" };
type P = Record<string, unknown>;

let journeyLock: TestLock | undefined;
let db: Db; let runtime: Runtime; let router: BorrowerRouter; let base = ""; let close: () => Promise<void> = async () => undefined; let partnerPartyId = "";

test.before(async () => {
  if (skip) return;
  journeyLock = await acquireJourneyLock(DB_URL);
  execFileSync(fileURLToPath(new URL("../../../db/migrate.sh", import.meta.url)), { env: { ...process.env, DATABASE_URL: DB_URL }, stdio: "pipe" });
  db = connect(DB_URL);
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock });
  const logger = createLogger("json", (line) => { if (process.env["FLOW_DEBUG"] && /flow|ERROR|error|"reason"/.test(line)) process.stderr.write(line + "\n"); });
  router = createBorrowerRouter({ runtime, logger, environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost"], urlSecret: "test-secret" });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger, console: false, borrowerRouter: router });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => server.close(() => db.end().then(() => resolve())));
  const partner = await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id) VALUES ('servicer', $1, '123456789', '1000123') RETURNING id`, [`Partner Bank ${randomUUID().slice(0, 8)}`]);
  partnerPartyId = partner[0]!.id;
});
test.after(async () => { if (!skip) { await close(); await journeyLock?.release(); } });

// ---------------------------------------------------------------- helpers over the borrower API and the flow
type Reply = { status: number; body: P };
async function api(method: string, path: string, body?: unknown, token?: string): Promise<Reply> {
  const r = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text(); return { status: r.status, body: text ? (JSON.parse(text) as P) : {} };
}
async function signIn(email: string): Promise<{ token: string; party_id: string }> {
  const req = await api("POST", "/v1/borrower/auth/otp", { action: "request", channel: "email", destination: email });
  const ver = await api("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: req.body["challenge_id"], code: req.body["fake_code"] });
  assert.equal(ver.status, 200, JSON.stringify(ver.body));
  return { token: ver.body["token"] as string, party_id: (ver.body["party"] as { party_id: string }).party_id };
}
const settle = () => router.flows!.settle();
const record = async (email: string, subject: string): Promise<P> => { await settle(); const r = await api("GET", `/v1/borrower/record?subject=${subject}`, undefined, (await signIn(email)).token); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 600)); return r.body; };
const thread = async (email: string): Promise<P[]> => { await settle(); const r = await api("GET", "/v1/borrower/thread?limit=500", undefined, (await signIn(email)).token); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300)); return r.body["messages"] as P[]; };
interface CardRow { card_instance_id: string; party_id: string; kind: string; status: string; copy_key: string; props: P; evidence: P | null; command_ref: string | null; created_at: string; resolved_at: string | null; subject_loan_id: string | null; subject_application_id: string | null; created_by: string; expires_at: string | null }
const CARD_COLS = "card_instance_id, party_id, kind, status, copy_key, props, evidence, command_ref, created_at, resolved_at, subject_loan_id, subject_application_id, created_by, expires_at";
const cardsOfLoan = async (loanId: string, partyId?: string): Promise<CardRow[]> => { await settle(); return db.query<CardRow & P>(`SELECT ${CARD_COLS} FROM card_instances WHERE subject_loan_id = $1 AND ($2::uuid IS NULL OR party_id = $2) ORDER BY created_at, card_instance_id`, [loanId, partyId ?? null]); };
const cardsOfApp = async (appId: string, partyId?: string): Promise<CardRow[]> => { await settle(); return db.query<CardRow & P>(`SELECT ${CARD_COLS} FROM card_instances WHERE subject_application_id = $1 AND ($2::uuid IS NULL OR party_id = $2) ORDER BY created_at, card_instance_id`, [appId, partyId ?? null]); };
const loanEvents = (loanId: string, type?: string) => db.query<{ type: string; occurred_at: string; payload: P; application_id: string | null }>(`SELECT type, occurred_at, payload, application_id FROM loan_events WHERE loan_id = $1 AND ($2::text IS NULL OR type = $2) ORDER BY sequence`, [loanId, type ?? null]);
const appEvents = (appId: string, type?: string) => db.query<{ type: string; occurred_at: string; payload: P }>(`SELECT type, occurred_at, payload FROM loan_events WHERE application_id = $1 AND ($2::text IS NULL OR type = $2) ORDER BY sequence`, [appId, type ?? null]);
const timerOn = async (where: { loan_id?: string; application_id?: string }, code: string) => (await db.query<{ status: string; due_at: string | null; due_date: string | null }>(`SELECT status::text AS status, due_at, due_date::text AS due_date FROM timers WHERE code = $3 AND (($1::uuid IS NOT NULL AND loan_id = $1) OR ($2::uuid IS NOT NULL AND application_id = $2)) ORDER BY armed_at DESC LIMIT 1`, [where.loan_id ?? null, where.application_id ?? null, code]))[0];
const entity = async (kind: string, id: string): Promise<P | null> => { const rows = await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = $1 AND id = $2`, [kind, id]); return rows[0] ? decodeEntityData(rows[0].data) : null; };
const resolve = (token: string, cardId: string, body: P) => api("POST", `/v1/borrower/cards/${cardId}/resolve`, body, token);
const say = (token: string, text: string, subject: P) => api("POST", "/v1/borrower/messages", { text, subject }, token);
const fresh = async (email: string) => (await signIn(email)).token;   // a session lives 30 minutes past its last activity: sign in again after every clock jump
const grid45 = (rows: [string, string][]) => rows.map(([r, p]) => ({ product_code: "FRM30", term_months: 360, note_rate_pct: r, lock_period_days: 45, price: p }));
/** A sheet a quarter-point-plus below the loan's 6.125% (the fixture's 20.1 rule: ≥ 25 bps and a positive 84-month benefit at $0 borrower-paid costs). */
const LOW_PRICES = grid45([["5.750", "101.875"], ["5.625", "101.375"], ["5.500", "100.875"], ["5.375", "100.375"], ["5.250", "99.750"]]);
/** The v_refi_universe row for a loan this journey funded (lifecycle.test.ts f: the same servicing-book row keyed by the loan alone). */
const universeRowFor = (loanId: string, partnerId: string, o: P = {}): P => ({ loan_id: loanId, partner_id: partnerId, status: "active", product_code: "FRM30", amortization: "fixed", note_date: "2026-11-06", first_payment_date: "2027-01-01", consummation_date: "2026-11-06", title_date: "2019-06-14",
  original_upb_cents: "56000000", original_term_months: 360, note_rate_pct: "6.125", pi_cents: "340262", payments_made: 1, upb_cents: "55945571", next_due_date: "2027-02-01", remaining_term_months: 359,
  escrowed: true, escrow_monthly_cents: "68750", net_escrow_deposit_estimate_cents: "300000", taxes_annual_cents: "480000", insurance_annual_cents: "186000", mi_status: "none", mi_monthly_cents: "0", occupancy: "primary", property_type: "sfr", units: 1, property_state: "AZ", county: "Maricopa", county_limit_cents: "83275000",
  value_estimate: { source: "origination_indexed", value_cents: "80000000", as_of: "2026-11-30", confidence: "high" }, representative_score: 765, score_source: "origination_file",
  regx_days_delinquent: 0, bankruptcy_active: false, foreclosure_referred: false, lossmit_plan_active: false, deceased_or_sii_pending: false, transfer_out_pending: false, refi_do_not_solicit: false, refi_last_offered_at: null, refi_offers_12m: 0, arm_first_adjustment_date: null, ...o });
/** The book by March 2027: three installments paid (Jan, Feb, Mar), the April 1 installment next — 20.1's payoff estimate accrues from `next_due_date`. */
const MAR_BOOK: P = { payments_made: 3, upb_cents: "55835642", next_due_date: "2027-04-01", remaining_term_months: 357 };
/** The day's sheet (20.4) and the loan's universe row (20.1) with the gate facts under test, then the daily run. */
async function sheet(j: Journey, id: string, publishedAt: string, expiresAt: string, prices = LOW_PRICES): Promise<void> {
  await j.tool({}, "20.4", "publishRateSheet", { rate_sheet_id: id, partner_id: j.PARTNER_ID, source: "pe_whole_loan_api", published_at: publishedAt, expires_at: expiresAt, prices }, PRICING);
}
async function loadRow(j: Journey, loanId: string, gate_facts: P, o: P = {}): Promise<P> {
  const row = universeRowFor(loanId, j.PARTNER_ID, o);
  await j.tool({ loan: loanId }, "20.1", "loadUniverse", { op: "load_row", row, program_id: j.PROGRAM_ID, gate_facts: { fnma_purchase_date: null, declined_on: null, offered_at: [], ...gate_facts } });
  return row;
}
async function runTrigger(j: Journey, loanId: string, row: P, runId: string): Promise<P> {
  const run = await j.tool({ loan: loanId }, "20.1", "emitOfferReady", { op: "run", run_id: runId, trigger_kind: "scheduled", program_id: j.PROGRAM_ID, loans: [row] });
  const opp = (run.output["opportunities"] as P[]).find((o) => o["loan_id"] === loanId)!; assert.ok(opp, JSON.stringify(run.output).slice(0, 300)); await settle(); return opp;
}
/** The MLO of record's review of the offer's terms (20.3 requestQuote{review}: the mlo_of_record's act) on the inquiry lead and quote the flow opened at offer_ready — never the agent's. */
async function mloApproves(j: Journey, loanId: string, opportunityId: string): Promise<void> {
  await settle();
  const r = await j.tool({ loan: loanId }, "20.3", "requestQuote", { op: "review", lead_id: `L-offer-${opportunityId}`, quote_id: `Q-OFFER-${opportunityId}`, review_id: `MR-${opportunityId.slice(-12)}`, outcome: "approved" }, MLO);
  assert.ok(r.events.some((e) => e.type === "mlo.review.completed" && e.payload["outcome"] === "approved"), r.events.map((e) => e.type).join(","));
  await settle();
}
const offerCardFor = async (loanId: string, partyId: string, opportunityId: string): Promise<CardRow | undefined> => (await cardsOfLoan(loanId, partyId)).find((c) => c.kind === "OfferCard" && c.props["refi_opportunity_id"] === opportunityId);
/** A serviced loan on the book: the whole journey (origination → funded Thu Nov 12, 2026 → boarded), the MLO of record assigned on the record. */
async function bootLoan(o: { A: string; B: string; priorLoanId?: string; custodial?: { clearing: string; pi: string; ti: string } }): Promise<{ j: Journey; partyA: string; partyB: string; loanId: string }> {
  const j = new Journey({ runtime, db, base, token: TOKEN, clock, borrowerEmail: o.A, coBorrowerEmail: o.B, partnerPartyId });
  if (o.priorLoanId) { j.priorLoanId = o.priorLoanId; if (o.custodial) Object.assign(j.custodial, o.custodial); } else await j.seedBook();
  await j.openApplication();
  const partyA = (await signIn(o.A)).party_id; const partyB = (await signIn(o.B)).party_id;
  await j.interview(); await j.assignMlo(); await settle();
  await j.quoteAndLe(); await j.recordIntent(); await j.quoteForLock(); await j.requestLock(); await j.executeLockAndCommit(); await j.verifyDecideAndClear(); await j.clearToClose(); await j.scheduleClosing(); await j.closingDisclosure(); await settle();
  return { j, partyA, partyB, loanId: "" };
}
async function closeFundBoard(j: Journey, opts: { rescission?: P; snapshot?: P } = {}): Promise<string> {
  await j.closeAndSign(); if (opts.rescission) j.rescissionOverride = opts.rescission; await j.fund(); const loanId = await j.board(opts.snapshot ?? {}); await settle(); return loanId;
}
const NO_INVESTOR = /\b(fannie|freddie|fnma|fhlmc|investor|owns your loan|mbs|pool|gse|ginnie)\b/i;
const NO_FUTURE_TERMS = /\b(guarantee[ds]?|guaranteeing|promise[sd]?|we will (always|automatically)|automatically (lower|drop|refinance)|locked (in )?for life|self-improving|pre-?approved|next time your rate|whenever rates drop we will)\b/i;

// ═══════════════════════════════════ J1: the funded loan L1 on the book — the recapture window, the proactive offer, Not now / ask / Never (T1–T5)
const j1: { j?: Journey; A: string; B: string; partyA: string; partyB: string; loanId: string; requestOpp: string; proactiveOpp: string; day10Opp: string } = { A: `alex-${randomUUID().slice(0, 8)}@example.test`, B: `blake-${randomUUID().slice(0, 8)}@example.test`, partyA: "", partyB: "", loanId: "", requestOpp: "", proactiveOpp: "", day10Opp: "" };

test("32.11-T1: Given `loan.purchased` on Nov 19, 2026, then no `OfferCard` exists before Mar 19, 2027 regardless of rates (`FNMA_C1_1_01_PREMIUM_RECAPTURE_120`); a borrower-initiated `refi.request` in that window produces `offer_ready` with the recapture acknowledgment internal only.", { skip }, async () => {
  const boot = await bootLoan({ A: j1.A, B: j1.B }); const j = boot.j; Object.assign(j1, { j, partyA: boot.partyA, partyB: boot.partyB });
  const loanId = await closeFundBoard(j); j1.loanId = loanId;
  // 29.4 delivers and Fannie Mae purchases the loan Thu Nov 19, 2026 (the journey's b2): `loan.purchased{purchase_date}` arms 20.1's recapture gate — Nov 19 + 120 calendar days = Fri Mar 19, 2027
  await j.deliverAndPurchase(); await settle();
  const purchased = await loanEvents(loanId, "loan.purchased"); assert.equal(purchased.length, 1); assert.equal(purchased[0]!.payload["purchase_date"], "2026-11-19");
  const gate = await timerOn({ loan_id: loanId }, "FNMA_C1_1_01_PREMIUM_RECAPTURE_120"); assert.ok(gate, "the recapture gate armed on loan.purchased"); assert.equal(gate!.due_date, "2027-03-19"); assert.equal(gate!.status, "armed");
  assert.equal((await cardsOfLoan(loanId)).filter((c) => c.kind === "OfferCard").length, 0);
  // Tue Dec 1, 2026 — rates a full 62.5 bps below the note (regardless of rates): the daily run suppresses inside the window; nothing reaches the borrower
  clock.set(EST("2026-12-01", "06:35")); await sheet(j, "rs-2026-12-01", EST("2026-12-01", "06:35"), EST("2026-12-01", "17:00"));
  clock.set(EST("2026-12-01", "06:41")); const row = await loadRow(j, loanId, { fnma_purchase_date: "2026-11-19" });
  const dec = await runTrigger(j, loanId, row, `run-2026-12-01-${j.R}`);
  assert.equal(dec["status"], "suppressed"); assert.deepEqual((dec["suppression_reasons"] as string[]).slice(0, 1), ["premium_recapture_window"]);
  const suppressed = (await loanEvents(loanId, "refi.opportunity.suppressed")).at(-1)!; assert.equal(suppressed.payload["reason"], "premium_recapture_window"); assert.equal(suppressed.payload["opens_on"], "2027-03-19"); assert.equal(suppressed.payload["gate"], "FNMA_C1_1_01_PREMIUM_RECAPTURE_120");
  let cards = await cardsOfLoan(loanId); assert.equal(cards.filter((c) => c.kind === "OfferCard").length, 0, "no OfferCard inside the recapture window");
  assert.equal(cards.filter((c) => c.copy_key === "terms.pending_mlo").length, 0, "nothing about the suppressed opportunity reaches the thread (the block stays passive)");
  // Thu Dec 10 — the borrower asks: "can I refinance?" (a typed message → 32.2 refi.request → 20.1's request path). Inside the window the request needs the partner officer's acknowledgment of the recapture — an escalation, internal only
  clock.set(EST("2026-12-10", "06:35")); await sheet(j, "rs-2026-12-10", EST("2026-12-10", "06:35"), EST("2026-12-10", "17:00"));
  clock.set(MST("2026-12-10", "09:00")); const tokA = (await signIn(j1.A)).token;
  const asked = await say(tokA, "Can I refinance? What would a refinance look like?", { loan_id: loanId });
  assert.equal(asked.status, 200, JSON.stringify(asked.body)); assert.equal(asked.body["command_executed"], true); assert.equal(asked.body["command"], "refi.request"); assert.equal((asked.body["reply"] as P)["copy_key"], "refi.request.received");
  await settle();
  const requested = (await loanEvents(loanId, "refi.opportunity.requested")).at(-1)!; assert.ok(requested, "refi.opportunity.requested"); assert.equal(requested.payload["officer_acknowledgment_required"], true); assert.equal(requested.payload["recapture_window_opens_on"], "2027-03-19"); assert.equal(requested.payload["path"], "borrower_request");
  j1.requestOpp = String(requested.payload["opportunity_id"]);
  assert.equal((await loanEvents(loanId, "refi.opportunity.offer_ready")).length, 0, "not offer_ready until the officer acknowledges the recapture");
  const esc = await db.query<{ kind: string; payload: P }>(`SELECT kind, payload FROM escalations WHERE loan_id = $1 AND kind = 'officer' ORDER BY opened_at DESC LIMIT 1`, [loanId]); assert.ok(esc[0], "the officer's recapture acknowledgment escalation (internal)"); assert.equal(esc[0]!.payload["reason"], "premium_recapture_acknowledgment");
  // the partner officer acknowledges the modelled recapture (20.1 timer table: the request path allowed with `officer` acknowledgment) → pricing runs → offer_ready
  clock.set(MST("2026-12-10", "09:30"));
  const reqProgram = j1.requestOpp.slice(`opp-${loanId}-2026-12-10-`.length).replace(/-req$/, "");
  const ack = await j.tool({ loan: loanId }, "20.1", "emitOfferReady", { op: "request", loan_id: loanId, program_id: reqProgram, free_text: "Can I refinance?", officer_acknowledged: true }, OFFICER);
  assert.equal(ack.output["status"], "offer_ready", JSON.stringify(ack.output).slice(0, 300)); assert.equal(ack.output["opportunity_id"], j1.requestOpp); assert.equal(ack.output["officer_acknowledgment_required"], true);
  const ready = (await loanEvents(loanId, "refi.opportunity.offer_ready")).at(-1)!; assert.equal(ready.payload["path"], "borrower_request"); assert.equal(ready.payload["opportunity_id"], j1.requestOpp);
  await settle();
  // the flow asked the MLO of record to review the offer's terms (20.3 rule 7, assisted) before any personal rate renders; the MLO approves → the OfferCard for the borrower's own inquiry
  cards = await cardsOfLoan(loanId, j1.partyA); assert.ok(cards.some((c) => c.copy_key === "terms.pending_mlo" && c.props["opportunity_id"] === j1.requestOpp), "the terms are with the MLO of record first");
  assert.ok((await loanEvents(loanId, "terms.presentation.requested")).some((e) => e.payload["quote_id"] === `Q-OFFER-${j1.requestOpp}`));
  await mloApproves(j, loanId, j1.requestOpp);
  const offer = await offerCardFor(loanId, j1.partyA, j1.requestOpp); assert.ok(offer, "the OfferCard for the borrower-initiated request inside the window"); assert.equal(offer!.status, "pending"); assert.equal(offer!.props["path"], "borrower_request"); assert.equal(offer!.command_ref, "offer.respond");
  // the recapture acknowledgment stays internal: no card, no thread line, no copy names it
  // (this flow's own cards and every thread line since the request; 32.7's Fannie Mae servicing-transfer letter cards are that section's own and name the investor by design)
  const since = Date.parse(MST("2026-12-10", "09:00"));
  const visible = JSON.stringify([...(await cardsOfLoan(loanId)).filter((c) => c.props["flow"] === "32.11").map((c) => [c.copy_key, c.props]), ...(await thread(j1.A)).filter((m) => Date.parse(String(m["at"] ?? m["created_at"] ?? "")) >= since).map((m) => m["body_text"])]).toLowerCase();
  assert.ok(!/recapture|premium|acknowledg|escalat|fnma|fannie/.test(visible), "the recapture acknowledgment is internal only");
  // Thu Mar 18, 2027 — the day before the gate opens: still suppressed, still no proactive OfferCard; Fri Mar 19 the gate opens (T2 continues there)
  clock.set(EDT("2027-03-18", "06:35")); await sheet(j, "rs-2027-03-18", EDT("2027-03-18", "06:35"), EDT("2027-03-18", "17:00"));
  clock.set(EDT("2027-03-18", "06:41")); const mar18 = await runTrigger(j, loanId, row, `run-2027-03-18-${j.R}`);
  assert.equal(mar18["status"], "suppressed"); assert.equal((mar18["suppression_reasons"] as string[])[0], "premium_recapture_window");
  assert.equal((await cardsOfLoan(loanId)).filter((c) => c.kind === "OfferCard" && c.props["path"] === "proactive").length, 0, "no proactive OfferCard before Mar 19, 2027");
  assert.equal((await timerOn({ loan_id: loanId }, "FNMA_C1_1_01_PREMIUM_RECAPTURE_120"))!.status, "armed");
  // the borrower's own request is answered but not left open into the proactive window: Not now (the cooldown it opens is the request path's own affair — T4 tests the proactive one)
  clock.set(MST("2027-03-18", "10:00"));
  const r = await resolve((await signIn(j1.A)).token, offer!.card_instance_id, { option_id: "not_now", evidence: { decision: "not_now", decided_at: clock.now() } }); assert.equal(r.status, 201, JSON.stringify(r.body));
  await settle();
});

test("32.11-T2: Given `offer_ready` and no marketing consent, then delivery is e-mail + in-app only; no `tcpa_voice` call or SMS is attempted; a human click-to-dial is permitted under the EBR (20.2 worked example 1).", { skip }, async () => {
  const j = j1.j!; const loanId = j1.loanId; const scope = { loan: loanId };
  // Fri Mar 19, 2027 06:41 EDT — the gate is open: the daily run fires (the cooldown from Thu's Not now is the request path's; the proactive gate reads the last proactive decline — none)
  clock.set(EDT("2027-03-19", "06:35")); await sheet(j, "rs-2027-03-19", EDT("2027-03-19", "06:35"), EDT("2027-03-19", "17:00"));
  clock.set(EDT("2027-03-19", "06:41")); const row = await loadRow(j, loanId, { fnma_purchase_date: "2026-11-19" }, MAR_BOOK);
  const opp = await runTrigger(j, loanId, row, `run-2027-03-19-${j.R}`);
  assert.equal(opp["status"], "offer_ready", JSON.stringify(opp).slice(0, 300)); j1.proactiveOpp = String(opp["opportunity_id"]);
  assert.equal((await timerOn({ loan_id: loanId }, "SM_REFI_OFFER_SLA_2BD"))?.status, "armed");
  // 20.2's channel plan for a borrower with an informational tcpa_voice consent only (no marketing PEWC), not on the national registry, EBR from the Jan 1 installment: e-mail sent, SMS and AI voice refused, human click-to-dial permitted
  clock.set(MST("2027-03-15", "09:00")); const scrub = { scrub_id: `scrub-mar-${j.R}`, source: "ftc_registry", registry_version_obtained_at: EDT("2027-03-15", "06:00"), obtained_on: "2027-03-15", valid_until: "2027-04-15", numbers_checked: 12_000, hits: 340, file_hash: "sha256:0315" };
  await j.tool(scope, "20.2", "scheduleTouch", { op: "complete_scrub", scrub_id: scrub.scrub_id, obtained_at: scrub.registry_version_obtained_at, numbers_checked: scrub.numbers_checked, hits: scrub.hits, file_hash: scrub.file_hash });
  const CELL = "+16025550142"; const informational = { consent_id: `c-info-${j.R}`, party_id: "B1", loan_id: loanId, kind: "tcpa_voice", purpose: "informational", phone_number: CELL, status: "active", written_consent: false, pewc_elements: null, signature_kind: null, disclosure_version: null, disclosure_text_hash: null, captured_at: EDT("2025-10-14", "10:00"), written_confirmation_due_at: null, national_dnc_written_permission: false, evidence: { captured_via: "portal_enrollment" } };
  const facts = (channel: string, destination: string, destination_id: string, line_type: string | null) => ({ touch: { touch_id: `t-${channel}-${j.R}-mar`, campaign_id: j.CAMPAIGN, campaign_kind: "refi_trigger_outbound", creative_id: j.CREATIVE, channel, party_id: "B1", loan_id: loanId, opportunity_id: j1.proactiveOpp, destination, destination_id, line_type, queued_at: MST("2027-03-19", "09:00"), time_zones: ["America/Phoenix"], state: "AZ" },
    partner_name: "[Partner]", consents: [informational], scrubs: [scrub], suppressions: [], on_national_registry: true, ebr: { last_transaction_on: "2027-01-01" }, rate_sheet_current: true, creative });
  const creative = await entity("marketing_creatives", j.CREATIVE); assert.equal(creative?.["status"], "approved", "the campaign's approved e-mail creative");
  clock.set(MST("2027-03-19", "09:00"));
  const email = await j.tool(scope, "20.2", "scheduleTouch", { facts: facts("email", "borrower@example.com", "email-1", null) }); assert.equal(email.output["outcome"], "scheduled", JSON.stringify(email.output).slice(0, 300));
  const sent = await j.tool(scope, "20.2", "scheduleTouch", { op: "send", touch_id: email.output["touch_id"], payload: { ...REFI_OFFER_SAMPLE, pi_cents: "340262", account_last4: "0001" }, recipient: { name: "Alex Borrower", mailing_address: "100 N Central Ave, Phoenix, AZ 85004", email: "borrower@example.com" } });
  assert.equal(sent.output["outcome"], "sent"); assert.ok(sent.events.some((e) => e.type === "marketing.touch.sent" && e.payload["channel"] === "email"));
  const sms = await j.tool(scope, "20.2", "scheduleTouch", { facts: facts("sms", CELL, "phone-1", "mobile") }); assert.equal(sms.output["outcome"], "suppressed"); assert.equal(sms.output["suppression_reason"], "no_pewc");
  const voice = await j.tool(scope, "20.2", "scheduleTouch", { facts: facts("ai_voice", CELL, "phone-1", "mobile") }); assert.equal(voice.output["outcome"], "suppressed"); assert.equal(voice.output["suppression_reason"], "no_pewc");
  assert.ok((sms.output["gates"] as { code: string; result: string }[]).some((g) => g.code === "TCPA_64_1200_A2_PEWC_GATE" && g.result === "fail")); assert.ok((voice.output["gates"] as { code: string; result: string }[]).some((g) => g.code === "TCPA_64_1200_A2_PEWC_GATE" && g.result === "fail"));
  const human = await j.tool(scope, "20.2", "scheduleTouch", { facts: facts("human_voice", CELL, "phone-1", "mobile"), scheduled_for: MST("2027-03-19", "10:30") }); assert.equal(human.output["outcome"], "scheduled", JSON.stringify(human.output).slice(0, 400));   // 20.2's click-to-dial slot (humanDialSlot: 10:30 called-party local)
  const basis = human.output["legal_basis"] as { dnc: { ebr_basis: string; national_hit: boolean }; tcpa: { required: string } }; assert.equal(basis.dnc.ebr_basis, "transaction_18m"); assert.equal(basis.dnc.national_hit, true); assert.equal(basis.tcpa.required, "none");
  assert.ok((human.output["gates"] as { code: string; result: string }[]).some((g) => g.code === "TCPA_64_1200_C2_NATIONAL_DNC_GATE" && g.result === "pass"));
  assert.equal((human.output["scheduled_local"] as { local_time: string }).local_time, "10:30", "worked example 1: the click-to-dial slot at 10:30 called-party local");
  // the first sent touch makes the opportunity `offered` (SM_REFI_OPPORTUNITY_EXPIRY_30 armed); the MLO of record approves the terms → the in-app OfferCard — the same offer, the same content (worked example 1 "(2) portal card")
  await j.tool(scope, "20.1", "emitOfferReady", { op: "offered", opportunity_id: j1.proactiveOpp }); await settle();
  assert.equal((await entity("refi_opportunities", j1.proactiveOpp))?.["status"], "offered"); assert.equal((await timerOn({ loan_id: loanId }, "SM_REFI_OPPORTUNITY_EXPIRY_30"))?.status, "armed");
  await mloApproves(j, loanId, j1.proactiveOpp);
  const card = await offerCardFor(loanId, j1.partyA, j1.proactiveOpp); assert.ok(card, "the in-app OfferCard"); assert.equal(card!.props["path"], "proactive"); assert.equal(card!.created_by, "agent:borrower-comms");
  // in-app + e-mail only: the touches sent are exactly one e-mail; no SMS or voice touch was sent or dialed; nothing on the borrower's thread went out by SMS or voice
  const touches = await loanEvents(loanId, "marketing.touch.sent"); const mine = touches.filter((e) => e.payload["opportunity_id"] === j1.proactiveOpp); assert.equal(mine.length, 1); assert.equal(mine[0]!.payload["channel"], "email");
  assert.equal((await loanEvents(loanId, "marketing.call.placed")).length, 0);
  const msgs = await thread(j1.A); assert.ok(!msgs.some((m) => (m["channel"] === "sms" || m["channel"] === "voice") && m["sender"] !== "borrower"), "no assistant SMS or voice message");
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM consents WHERE party_id = $1 AND purpose = 'marketing'`, [j1.partyA]))[0]!.n, "0", "no marketing consent on file");
});

test("32.11-T3: Given the `OfferCard`, then it contains every field in §2 and no \"guarantee\"; the MLO attribution is present; the expiry equals `SM_REFI_OPPORTUNITY_EXPIRY_30.due_at`.", { skip }, async () => {
  const j = j1.j!; const loanId = j1.loanId;
  const card = (await offerCardFor(loanId, j1.partyA, j1.proactiveOpp))!; const p = card.props; const opp = (await entity("refi_opportunities", j1.proactiveOpp))!;
  const candidate = opp["candidate_terms"] as P; const existing = opp["existing_terms"] as P; const benefit = opp["benefit_metrics"] as P; const quote = (await entity("pricing_quotes", `Q-OFFER-${j1.proactiveOpp}`))!;
  // every §2 field, from refi_opportunities / pricing_quotes — never a figure the UI computed
  assert.equal(p["current_rate"], pct(existing["note_rate"])); assert.equal(p["current_rate"], "6.125");
  assert.equal(p["offered_rate"], pct(candidate["note_rate"])); assert.ok(Number(p["offered_rate"]) <= 6.125 - 0.25, `at least 25 bps lower: ${String(p["offered_rate"])}`);
  assert.equal(p["apr"], pct(quote["apr_estimate"])); assert.ok(/^\d\.\d{3}$/.test(String(p["apr"])));
  assert.equal(p["new_pi_payment_cents"], String(candidate["pi_cents"])); assert.equal(p["term_months"], candidate["term_months"]);
  const savings = BigInt(String(benefit["pi_delta_cents"])); assert.equal(p["monthly_savings_cents"], (savings < 0n ? -savings : savings).toString()); assert.ok(BigInt(String(p["monthly_savings_cents"])) > 0n);
  assert.equal(p["costs_to_borrower_cents"], "0"); assert.equal(p["no_cost_line"], NO_COST_LINE);
  assert.equal(p["payment_line"], paymentLine(Number(candidate["term_months"]), new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(candidate["pi_cents"]) / 100)));
  assert.match(String(p["payment_line"]), /payments do not include taxes and insurance, so your actual payment will be higher/);
  assert.equal(p["not_a_commitment_text"], NOT_A_COMMITMENT_TEXT); assert.equal(p["rates_change_daily_text"], RATES_CHANGE_DAILY_TEXT);
  assert.equal(p["lender_legal_name"], (await db.query<{ n: string }>(`SELECT legal_name AS n FROM parties WHERE id = $1`, [partnerPartyId]))[0]!.n); assert.equal(p["lender_nmlsr_id"], "123456"); assert.equal(p["lender_line"], lenderLine(String(p["lender_legal_name"]), "123456"));
  // the MLO attribution — the MLO of record whose review approved the terms (mlo.review.completed{approved}), never the agent
  assert.equal(p["mlo_name"], "Jordan Rivera"); assert.equal(p["mlo_nmlsr_id"], "987654"); assert.equal(p["mlo_attribution"], "Jordan Rivera, NMLSR ID 987654");
  const review = (await loanEvents(loanId, "mlo.review.completed")).find((e) => e.payload["quote_id"] === `Q-OFFER-${j1.proactiveOpp}`)!; assert.equal(review.payload["outcome"], "approved"); assert.equal(review.payload["nmlsr_id"], "987654");
  assert.ok(Date.parse(card.created_at) >= Date.parse(review.occurred_at), "no personal rate before the MLO review");
  // the expiry is the Timer Engine's own due_at for SM_REFI_OPPORTUNITY_EXPIRY_30 (offered_at + 30 calendar days), copied, never computed
  const expiry = (await timerOn({ loan_id: loanId }, "SM_REFI_OPPORTUNITY_EXPIRY_30"))!; assert.ok(expiry.due_at); assert.equal(p["expires_at"], expiry.due_at); assert.equal(card.expires_at, expiry.due_at); assert.equal(expiry.due_date, "2027-04-18"); assert.equal(p["expiry_timer_code"], "SM_REFI_OPPORTUNITY_EXPIRY_30");
  // the three options, the command they issue, and no "guarantee" (32.1 §7.3) or investor anywhere on the card
  assert.deepEqual((p["options"] as { id: string }[]).map((o) => o.id), ["yes", "not_now", "never"]); assert.equal(card.command_ref, "offer.respond"); assert.deepEqual(Object.keys(p["command_args_by_option"] as P).sort(), ["never", "not_now", "yes"]);
  const text = JSON.stringify(p); assert.ok(!/guarantee/i.test(text), "no guarantee"); assert.ok(!NO_INVESTOR.test(text), "no investor reference");
  assert.equal(card.copy_key, "offer.card");
  // the Record: Offers lists the opportunity with the same expiry; the Loan section's Rate-watch block says an offer is open
  const rec = await record(j1.A, loanId);
  const offers = rec["offers"] as P[]; const mine = offers.find((o) => o["refi_opportunity_id"] === j1.proactiveOpp)!; assert.ok(mine); assert.equal(mine["status"], "offered");
  const rw = (rec["loan"] as P)["ratewatch"] as P; assert.equal(rw["state"], "offer_open"); assert.equal(rw["offer_card_instance_id"], card.card_instance_id); assert.equal(rw["current_rate"], "6.125"); assert.equal(rw["best_available_rate"], bestAvailableRate([(await entity("rate_sheets", "rs-2027-03-19"))!], clock.now(), "FRM30").rate);
});

test("32.11-T4: Given **Not now**, then `refi.opportunity.declined` and no proactive offer for 90 days; a typed \"can I refinance?\" on day 10 still yields `offer_ready`.", { skip }, async () => {
  const j = j1.j!; const loanId = j1.loanId; const card = (await offerCardFor(loanId, j1.partyA, j1.proactiveOpp))!;
  // Sat Mar 20, 2027: Not now on the card → 20.1's decline; the 90-day quiet (SM_REFI_RESOLICIT_COOLDOWN_90) opens Fri Jun 18
  clock.set(MST("2027-03-20", "10:00"));
  const r = await resolve(await fresh(j1.A), card.card_instance_id, { option_id: "not_now", evidence: { decision: "not_now", decided_at: clock.now() } });
  assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body["command"], "offer.respond"); assert.ok((r.body["events"] as string[]).includes("refi.opportunity.declined"));
  assert.equal((r.body["result"] as P)["cooldown_until"], "2027-06-18");
  const declined = (await loanEvents(loanId, "refi.opportunity.declined")).find((e) => e.payload["opportunity_id"] === j1.proactiveOpp)!; assert.equal(declined.payload["declined_on"], "2027-03-20"); assert.equal(declined.payload["cooldown_until"], "2027-06-18");
  assert.equal((await entity("refi_opportunities", j1.proactiveOpp))?.["status"], "declined");
  await settle();
  const resolved = (await cardsOfLoan(loanId, j1.partyA)).find((c) => c.card_instance_id === card.card_instance_id)!; assert.equal(resolved.status, "resolved"); assert.equal(resolved.evidence!["decision"], "not_now");
  assert.ok((await thread(j1.A)).some((m) => m["body_text"] === "{{copy:offer.not_now}}"), "the card says: we'll stay quiet for 90 days; ask any time");
  const rw = ((await record(j1.A, loanId))["loan"] as P)["ratewatch"] as P; assert.equal(rw["state"], "passive");
  // day 10 (Tue Mar 30): the borrower types "can I refinance?" — the request path skips the cooldown (the gate is not_applicable on it) → offer_ready
  clock.set(EDT("2027-03-30", "06:35")); await sheet(j, "rs-2027-03-30", EDT("2027-03-30", "06:35"), EDT("2027-03-30", "17:00"));
  clock.set(MST("2027-03-30", "09:00"));
  const asked = await say(await fresh(j1.A), "can I refinance?", { loan_id: loanId }); assert.equal(asked.status, 200, JSON.stringify(asked.body)); assert.equal(asked.body["command"], "refi.request");
  await settle();
  const ready = (await loanEvents(loanId, "refi.opportunity.offer_ready")).at(-1)!; assert.equal(ready.payload["path"], "borrower_request"); assert.equal(ready.occurred_at.slice(0, 10), "2027-03-30");
  j1.day10Opp = String(ready.payload["opportunity_id"]); assert.notEqual(j1.day10Opp, j1.proactiveOpp);
  const opp = (await entity("refi_opportunities", j1.day10Opp))!; assert.equal(opp["status"], "offer_ready"); assert.equal(opp["trigger_kind"], "borrower_request");
  const cooldownGate = (opp["gates"] as { code: string; status: string }[]).find((g) => g.code === "SM_REFI_RESOLICIT_COOLDOWN_90")!; assert.equal(cooldownGate.status, "not_applicable", "the request path is unaffected by the cooldown");
  await mloApproves(j, loanId, j1.day10Opp);
  assert.ok(await offerCardFor(loanId, j1.partyA, j1.day10Opp), "the OfferCard for the borrower's own ask on day 10");
  // day 30 (Mon Apr 19): the proactive run is refused for 90 days — suppressed{cooldown}, no card, nothing sent
  clock.set(EDT("2027-04-19", "06:35")); await sheet(j, "rs-2027-04-19", EDT("2027-04-19", "06:35"), EDT("2027-04-19", "17:00"));
  clock.set(EDT("2027-04-19", "06:41")); const row = universeRowFor(loanId, j.PARTNER_ID, { ...MAR_BOOK, payments_made: 4, upb_cents: "55780962", next_due_date: "2027-05-01", remaining_term_months: 356 });
  const day30 = await runTrigger(j, loanId, row, `run-2027-04-19-${j.R}`);
  assert.equal(day30["status"], "suppressed"); assert.equal((day30["suppression_reasons"] as string[])[0], "cooldown");
  const sup = (await loanEvents(loanId, "refi.opportunity.suppressed")).at(-1)!; assert.equal(sup.payload["reason"], "cooldown"); assert.equal(sup.payload["opens_on"], "2027-06-18"); assert.equal(sup.payload["gate"], "SM_REFI_RESOLICIT_COOLDOWN_90");
  assert.equal((await cardsOfLoan(loanId)).filter((c) => c.kind === "OfferCard" && c.props["path"] === "proactive" && c.props["refi_opportunity_id"] !== j1.proactiveOpp).length, 0, "no proactive offer inside the 90 days");
});

test("32.11-T5: Given **Never**, then `consents{purpose=marketing}` is revoked, servicing informational consent remains, and the Rate-watch block stays passive.", { skip }, async () => {
  const j = j1.j!; const loanId = j1.loanId;
  // the consents on the book: the marketing PEWC offered once after the first funding (the ConsentCard on loan.boarded) — captured now — and a servicing informational text consent
  const marketingCard = (await cardsOfLoan(loanId, j1.partyA)).find((c) => c.kind === "ConsentCard" && c.copy_key === "consent.tcpa.marketing.title")!; assert.ok(marketingCard, "the PEWC ConsentCard offered after the first funding"); assert.equal(marketingCard.props["purpose"], "marketing");
  clock.set(MST("2027-03-31", "08:12"));
  const m = await resolve(await fresh(j1.A), marketingCard.card_instance_id, { option_id: "affirm", evidence: { consent_kind: "tcpa_voice", method: "checkbox_with_text", typed_name: "Alex Borrower", text_hash: "sha256:pewc-v2.1", disclosure_version_id: "NTC_TCPA_CONSENT_CONFIRMATION", affirmed_at: clock.now() } });
  assert.equal(m.status, 201, JSON.stringify(m.body));
  const info = await api("POST", "/v1/borrower/commands/consent.capture", { kind: "tcpa_sms", purpose: "informational", method: "checkbox_with_text", disclosure_version_id: "NTC_TCPA_CONSENT_CONFIRMATION", phone_number: "+16025550142", scope: ["informational"], subject: { loan_id: loanId } }, await fresh(j1.A));
  assert.equal(info.status, 200, JSON.stringify(info.body));
  const rows = () => db.query<{ id: string; kind: string; purpose: string; status: string | null; revoked_at: string | null; withdrawal_reason: string | null }>(`SELECT id, kind::text AS kind, purpose, status, revoked_at::text AS revoked_at, withdrawal_reason FROM consents WHERE party_id = $1 AND kind IN ('tcpa_voice', 'tcpa_sms') ORDER BY captured_at`, [j1.partyA]);
  let consents = await rows(); assert.ok(consents.some((c) => c.purpose === "marketing" && c.status === "active")); assert.ok(consents.some((c) => c.purpose === "informational" && c.status === "active"));
  // Never on the open card (the borrower's own day-10 offer): 20.1's decline + the marketing consents revoked; the card says what stops (proactive offers) and what doesn't (asking; loan messages)
  const card = (await offerCardFor(loanId, j1.partyA, j1.day10Opp))!;
  clock.set(MST("2027-04-01", "09:00"));
  const r = await resolve(await fresh(j1.A), card.card_instance_id, { option_id: "never", evidence: { decision: "never", decided_at: clock.now() } });
  assert.equal(r.status, 201, JSON.stringify(r.body)); assert.ok((r.body["events"] as string[]).includes("refi.opportunity.declined")); assert.ok((r.body["events"] as string[]).includes("consent.marketing.revoked")); assert.equal((r.body["result"] as P)["marketing_consent_revoked"], true);
  await settle();
  consents = await rows();
  // revoked in 7.4's row vocabulary: status `withdrawn`, `revoked_at` stamped, the reason on the row (the 0076 check admits no `revoked` status)
  assert.deepEqual(consents.filter((c) => c.purpose === "marketing").map((c) => [c.status, !!c.revoked_at, c.withdrawal_reason]), [["withdrawn", true, "never_proactive_offers"]], "consents{purpose=marketing} revoked");
  assert.deepEqual(consents.filter((c) => c.purpose === "informational").map((c) => c.status), ["active"], "the servicing informational consent remains");
  assert.ok((await thread(j1.A)).some((m) => m["body_text"] === "{{copy:offer.never}}"));
  assert.ok((await loanEvents(loanId, "marketing.suppression.recorded")).some((e) => e.payload["kind"] === "all_marketing" && e.payload["party_id"] === j1.partyA), "20.2's all_marketing suppression: proactive touches stop");
  // the Rate-watch block stays passive — now, and when the daily run fires again after the quiet period (Thu Jul 1): no card, no line, no MLO review for a proactive offer; the borrower may still ask
  let rw = ((await record(j1.A, loanId))["loan"] as P)["ratewatch"] as P; assert.equal(rw["state"], "passive"); assert.equal(rw["offer_card_instance_id"], null);
  clock.set(EDT("2027-07-01", "06:35")); await sheet(j, "rs-2027-07-01", EDT("2027-07-01", "06:35"), EDT("2027-07-01", "17:00"));
  clock.set(EDT("2027-07-01", "06:41")); const row = universeRowFor(loanId, j.PARTNER_ID, { ...MAR_BOOK, payments_made: 6, upb_cents: "55670246", next_due_date: "2027-07-01", remaining_term_months: 354 });
  const jul = await runTrigger(j, loanId, row, `run-2027-07-01-${j.R}`); assert.equal(jul["status"], "offer_ready", JSON.stringify(jul).slice(0, 300));
  const julOpp = String(jul["opportunity_id"]); const before = (await cardsOfLoan(loanId)).length;
  assert.equal((await cardsOfLoan(loanId)).filter((c) => c.props["opportunity_id"] === julOpp || c.props["refi_opportunity_id"] === julOpp).length, 0, "nothing for a proactive opportunity after Never");
  assert.equal((await loanEvents(loanId, "terms.presentation.requested")).filter((e) => e.payload["quote_id"] === `Q-OFFER-${julOpp}`).length, 0);
  rw = ((await record(j1.A, loanId))["loan"] as P)["ratewatch"] as P; assert.equal(rw["state"], "passive"); assert.equal((await cardsOfLoan(loanId)).length, before);
  assert.equal((await cardsOfLoan(loanId, j1.partyA)).filter((c) => c.kind === "OfferCard" && c.status === "pending").length, 0);
});

// ═══════════════════════════════════ J2: the refinance of L1 by the same servicer (T8, T7), then the compressed application from a Yes on L2 (T9, T6)
const j2: { j?: Journey; loanId: string; appId: string; standingId: string; convApp: string } = { loanId: "", appId: "", standingId: "", convApp: "" };

test("32.11-T8: Given the partner was the original creditor and the new loan is rate/term, then the rescission state is whatever 25.3 computes and the UI renders no cancel window when `not_applicable`.", { skip }, async () => {
  // the second origination on L1 (prior_loan_id = the loan J1 funded; the same parties): the journey through the CD, then 25.3 on the closing facts
  const boot = await bootLoan({ A: j1.A, B: j1.B, priorLoanId: j1.loanId, custodial: j1.j!.custodial }); const j = boot.j; j2.j = j; j2.appId = j.appId;
  assert.equal((await db.query<{ p: string }>(`SELECT prior_loan_id AS p FROM applications WHERE id = $1`, [j.appId]))[0]!.p, j1.loanId);
  // 25.3 determineRescindability: the partner originated the existing loan; amount financed ≤ UPB + earned unpaid finance charge + refinancing costs → §1026.23(f)(2): exempt_same_creditor_no_new_money, status not_applicable
  clock.set(MST("2026-11-05", "10:00"));
  const consumers = [{ consumer_id: "B1", role: "borrower", ownership_interest: true, occupancy: "primary" }, { consumer_id: "B2", role: "borrower", ownership_interest: true, occupancy: "primary" }];
  const existing_loan = { original_creditor_id: j.PARTNER_ID, upb_cents: "55945571", earned_unpaid_finance_charge_cents: "210055", refinancing_costs_cents: "0" };
  const d = await j.tool({ app: j.appId }, "25.3", "determineRescindability", { transaction_type: "rate_term", consumers, partner_id: j.PARTNER_ID, existing_loan, amount_financed_cents: "56000000", time_zone: "America/Phoenix" }, DISCLOSURE);
  assert.equal(d.output["applicability"], "exempt_same_creditor_no_new_money"); assert.equal(d.output["form"], "none"); assert.equal(d.output["gated"], false); assert.equal(d.output["original_creditor_match"], true); assert.equal(d.output["status"], "not_applicable"); assert.equal(String(d.output["rescindable_amount_cents"]), "-155626");
  // the same facts with a different original creditor: 25.3 computes rescindable_full (H-8) — the UI renders whichever state 25.3 wrote, never its own
  const other = determineRescindability({ application_id: j.appId, transaction_type: "rate_term", consumers: consumers as never, partner_id: j.PARTNER_ID, existing_loan: { original_creditor_id: "some-other-lender", upb_cents: 55_945_571n, earned_unpaid_finance_charge_cents: 210_055n, refinancing_costs_cents: 0n }, amount_financed_cents: 56_000_000n });
  assert.equal(other.applicability, "rescindable_full"); assert.equal(other.form, "h8"); assert.equal(other.gated, true);
  // close, fund (26.3 under 25.3's not_applicable state — no rescission hold) and board (30.2: not rescindable)
  const loanId = await closeFundBoard(j, { rescission: { status: "not_applicable", expires_at: null, reasonably_satisfied_at: null, waiver_id: null }, snapshot: { rescindable: false, rescission_expires_at: null } }); j2.loanId = loanId;
  const period = await entity("rescission_periods", `${j.appId}:rescission`); assert.ok(period, "25.3's rescission_periods row"); assert.equal(period!["status"], "not_applicable"); assert.equal(period!["expires_at"], null);
  assert.equal((await appEvents(j.appId, "rescission.period.started")).length, 0); assert.equal(await timerOn({ application_id: j.appId }, "REGZ_1026_23_RESCISSION_3SBD_GATE"), undefined, "no rescission clock");
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM loans WHERE id = $1`, [loanId]))[0]!.n, "1");
  // the UI: no "Cancel window" badge, no "Cancel window ends" date, no cancel card, no "you have until midnight … to cancel" line
  const rec = await record(j1.A, j.appId);
  assert.notEqual((rec["status"] as P)["badge"], "Cancel window"); assert.ok(!(rec["dates"] as P[]).some((x) => x["timer_code"] === "REGZ_1026_23_RESCISSION_3SBD_GATE"), JSON.stringify(rec["dates"]));
  const cards = await cardsOfApp(j.appId); assert.ok(!cards.some((c) => /^rescission\./.test(c.copy_key) || c.copy_key === "signed.refi"), cards.map((c) => c.copy_key).join(","));
  assert.ok(!(await thread(j1.A)).some((m) => /rescission\.|signed\.refi/.test(String(m["body_text"] ?? ""))));
});

test("32.11-T7: Given the same-servicer funding, then the old loan reaches `paid_in_full` without a third-party wire, the escrow balance is `credited_to_new_loan`, and the Thread message says so; `REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD` is satisfied by the credit.", { skip }, async () => {
  const j = j2.j!; const oldLoan = j1.loanId; const newLoan = j2.loanId; const appId = j.appId;
  // the funded StatusCard on the new application: rate, new payment, first payment date, the autopay line — all from the owning rows
  const funded = (await cardsOfApp(appId, j1.partyA)).find((c) => c.copy_key === "refi.same_servicer.funded")!; assert.ok(funded, "StatusCard refi.same_servicer.funded"); assert.equal(funded.kind, "StatusCard");
  const tokens = funded.props["copy_tokens"] as P; assert.equal(tokens["rate"], "6.125%"); assert.equal(tokens["date"], "2027-01-01"); assert.equal(tokens["money"], "$4,090.12"); assert.equal(funded.props["prior_loan_id"], oldLoan); assert.equal(funded.props["detail_copy_key"], "refi.same_servicer.autopay");
  // the old loan pays off internally at funding: 16.2 matches the internal transfer (no wire to a third party), posts the payoff → loan.paid_in_full{escrowed}
  const scope = { loan: oldLoan }; const balances = async (loanId: string) => Object.fromEntries((await db.query<{ account: string; s: string }>(`SELECT account, coalesce(sum(amount_cents), 0)::text AS s FROM ledger_lines WHERE scope = 'loan' AND loan_id = $1 GROUP BY account`, [loanId])).map((r) => [r.account, r.s]));
  const before = await balances(oldLoan); const upb = BigInt(before["principal"] ?? "0"); const escrowBalance = -BigInt(before["escrow"] ?? "0"); assert.ok(upb > 0n, JSON.stringify(before)); assert.ok(escrowBalance > 0n, "the old loan's escrow balance");
  clock.set("2026-11-12T19:00:00.000Z");
  const quote = await j.tool(scope, "16.1", "computePayoffQuote", { loan_id: oldLoan, quote_id: `pq-ss-${j.R}`, request_id: `pr-ss-${j.R}`, channel: "api", received_on: "2026-11-12", requester_type: "lender_or_title", authorization_evidence: true, upb_cents: upb.toString(), rate_pct: "6.125", lpi_due: "2026-11-12", good_through: "2026-11-12", state: "AZ", ledger_snapshot_id: `ledger-ss-${j.R}` }, PAYOFF);
  const total = BigInt(String(quote.output["total_cents"])); const interest = BigInt(String(quote.output["interest_cents"]));
  const loanAcct = (loanId: string, account: string) => ({ scope: "loan" as const, loanId, account: account as "principal" }); const cust = (id: string, account: string) => ({ scope: "custodial" as const, custodialAccountId: id, account: account as "clearing_cash" });
  await runtime.execute({ process: "2.1", name: "ledger.post", loanId: oldLoan, actor: CASHIERING, input: { loan_id: oldLoan, via: "payment.post", entry_set: { effectiveDate: "2026-11-12", description: "receipt: same-servicer refinance payoff (internal transfer from the new loan's funding)", lines: [{ account: cust(j.custodial.clearing, "clearing_cash"), amountCents: total, ruleRef: "2.1:r8:receipt" }, { account: loanAcct(oldLoan, "suspense_unapplied"), amountCents: -total, ruleRef: "2.1:r8:receipt" }] } } });
  const matched = await j.tool(scope, "16.2", "matchPayoffFunds", { loan_id: oldLoan, amount_cents: total.toString(), method: "internal_transfer", received_at: "2026-11-12T19:00:00.000Z", bank_reference: `pq-ss-${j.R}`, remittance_type: "AA", source_party_id: `funding:${newLoan}` }, PAYOFF);
  assert.equal(matched.output["status"], "cleared"); assert.ok(matched.events.some((e) => e.type === "payoff.funds.received" && e.payload["method"] === "internal_transfer"));
  // 16.2 postPayoff takes bigint buckets (the journey's own path: in-process, as the payoff agent)
  const posted = await runtime.execute({ process: "16.2", name: "postPayoff", loanId: oldLoan, actor: PAYOFF, input: { loan_id: oldLoan, funds_id: matched.output["funds_id"], amount_cents: total, payoff_date: "2026-11-12", remittance_type: "AA", escrowed: true, buckets: { accrued_interest: interest, principal: upb, escrow_balance: escrowBalance }, custodial_pi_id: j.custodial.pi, custodial_ti_id: j.custodial.ti, custodial_clearing_id: j.custodial.clearing } });
  const pif = posted.events.find((e) => e.type === "loan.paid_in_full")!; assert.ok(pif, "loan.paid_in_full"); assert.equal(pif.payload["escrowed"], true); assert.equal(pif.payload["payoff_date"], "2026-11-12");
  assert.equal((await db.query<{ s: string }>(`SELECT status::text AS s FROM loans WHERE id = $1`, [oldLoan]))[0]!.s, "paid_off");
  const funds = await entity("payoff_funds", String(matched.output["funds_id"])); assert.equal(funds!["method"], "internal_transfer"); assert.equal(funds!["source_party_id"], `funding:${newLoan}`);
  assert.equal((await loanEvents(oldLoan)).filter((e) => /^funding\.wire\.|^wire\./.test(e.type)).length, 0, "no wire to a third party for the payoff");
  assert.equal((await loanEvents(oldLoan, "disbursement.issued")).filter((e) => e.payload["method"] === "check" || e.payload["method"] === "wire").length, 0);
  // 3.5's 20-day refund clock armed by the payoff; 30.3 rule 8 (§1024.34(b)(2)): the agreement recorded at intent, the escrow balance credited to the new loan — no refund check; the clock is satisfied by the credit
  const refund = await timerOn({ loan_id: oldLoan }, "REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD"); assert.ok(refund, "REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD armed on loan.paid_in_full"); assert.equal(refund!.status, "armed"); assert.equal(refund!.due_date, "2026-12-11");
  // 30.3 runs on the old loan's subject (the 3.5 refund clock lives there; the new application named explicitly)
  const agreed = await j.tool({ loan: oldLoan }, "30.3", "buildEscrowLines", { op: "record_credit_agreement", application_id: appId, old_loan_id: oldLoan, borrower_id: "B1", evidence: { kind: "portal_esign", document_id: `DOC-ESCROW-CREDIT-${j.R}` }, captured_on: "2026-10-06", settlement_date: "2026-11-06" }, ESCROW);
  assert.equal(agreed.output["kind"], "escrow_credit_to_new_loan");
  // the servicer's pre-purchase T&I custodial account and the Fannie Mae T&I account are custodial_accounts rows on the Postgres ledger (30.3 rule 8's second set)
  const prepurchaseTi = (await db.query<{ id: string }>(`INSERT INTO custodial_accounts (partner_party_id, kind, remittance_type) VALUES ($1, 'ti', 'A/A') RETURNING id`, [partnerPartyId]))[0]!.id;
  const credit = await j.tool({ loan: oldLoan }, "30.3", "buildEscrowLines", { op: "post_credit_transfer", application_id: appId, old_loan_id: oldLoan, new_loan_id: newLoan, payoff_date: "2026-11-12", settlement_date: "2026-11-06", old_balance_after_final_disbursements_cents: escrowBalance.toString(), target_at_start_cents: "206250", fnma_ti_account_id: j.custodial.ti, custodial_ti_prepurchase_id: prepurchaseTi }, ESCROW);
  assert.equal(String(credit.output["credited_cents"]), (escrowBalance < 206_250n ? escrowBalance : 206_250n).toString()); assert.equal(credit.output["refund_check_issued"], false);
  const creditEv = credit.events.find((e) => e.type === "escrow.credit_to_new_loan.posted")!; assert.ok(creditEv); assert.equal(creditEv.loanId, oldLoan); assert.equal(creditEv.payload["new_loan_id"], newLoan);
  assert.ok(credit.events.some((e) => e.type === "disbursement.issued" && e.payload["method"] === "credit_to_new_loan" && e.payload["check_issued"] === false), "credited_to_new_loan — never a check");
  const after = await timerOn({ loan_id: oldLoan }, "REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD"); assert.ok(after!.status === "satisfied" || after!.status === "satisfied_late", `satisfied by the credit: ${after!.status}`);
  await settle();
  // the Thread says so: "your escrow balance moves to the new loan — no refund to wait for", and the funded card already said the old loan is paid off and the escrow moved over
  const msgs = await thread(j1.A);
  assert.ok(msgs.some((m) => m["body_text"] === "{{copy:refi.escrow.moved}}" && (m["subject"] as P)["loan_id"] === oldLoan), "the refi.escrow.moved line on the old loan's thread");
  assert.ok(msgs.some((m) => m["card_instance_id"] === funded.card_instance_id));
  const rec = await record(j1.A, oldLoan); assert.equal((rec["status"] as P)["badge"], "Paid off");
});

test("32.11-T9: Given a standing connection consent revoked from the Loan section, then the next conversion creates `ConnectCard{truv_income}` again.", { skip }, async () => {
  const j = j2.j!; const loanId = j2.loanId;
  // the standing authorization offered after the funding (loan.boarded) — captured on the card → consents{kind=blanket_verification_authorization, standing=true}
  const standingCard = (await cardsOfLoan(loanId, j1.partyA)).find((c) => c.kind === "ConsentCard" && c.copy_key === "consent.standing.title")!; assert.ok(standingCard, "the standing ConsentCard after the first funding"); assert.equal(standingCard.props["standing"], true);
  clock.set(MST("2026-11-20", "09:00"));
  const s = await resolve(await fresh(j1.A), standingCard.card_instance_id, { option_id: "affirm", evidence: { consent_kind: "blanket_verification_authorization", method: "checkbox_with_text", typed_name: "Alex Borrower", text_hash: "sha256:standing-v1", disclosure_version_id: "DELTA-05-standing-authorization-v1", affirmed_at: clock.now() } });
  assert.equal(s.status, 201, JSON.stringify(s.body)); j2.standingId = String((s.body["result"] as P)["consent_id"]);
  const row = (await db.query<{ standing: boolean; status: string | null }>(`SELECT standing, status FROM consents WHERE id = $1`, [j2.standingId]))[0]!; assert.equal(row.standing, true); assert.equal(row.status, "active");
  await settle();
  // the Loan section shows the standing connections and the card that turns them off; the borrower turns them off → consent.<kind>.withdrawn; the row keeps its history
  let rec = await record(j1.A, loanId); let sc = (rec["loan"] as P)["standing_connections"] as P; assert.equal(sc["status"], "active"); assert.equal(sc["consent_id"], j2.standingId); assert.ok(sc["manage_card_instance_id"], "the Loan section deep-links to the manage card");
  const manage = (await cardsOfLoan(loanId, j1.partyA)).find((c) => c.card_instance_id === sc["manage_card_instance_id"])!; assert.equal(manage.copy_key, "consent.standing.manage"); assert.equal(manage.kind, "ChoiceCard");
  clock.set(MST("2026-11-21", "09:00"));
  const off = await resolve(await fresh(j1.A), manage.card_instance_id, { option_id: "turn_off", evidence: { option_id: "turn_off", tapped_at: clock.now() } });
  assert.equal(off.status, 201, JSON.stringify(off.body)); assert.ok((off.body["events"] as string[]).includes("consent.blanket_verification_authorization.withdrawn"));
  assert.equal((await db.query<{ status: string }>(`SELECT status FROM consents WHERE id = $1`, [j2.standingId]))[0]!.status, "withdrawn");
  await settle(); rec = await record(j1.A, loanId); sc = (rec["loan"] as P)["standing_connections"] as P; assert.equal(sc["status"], "withdrawn"); assert.ok(sc["withdrawn_at"]);
  assert.ok((await thread(j1.A)).some((m) => m["body_text"] === "{{copy:consent.standing.off}}"));
  // the next conversion: the borrower asks, the MLO approves, the borrower says Yes → the compressed application asks for the payroll connection again
  clock.set(EST("2026-12-01", "06:35")); await sheet(j, "rs-2026-12-01b", EST("2026-12-01", "06:35"), EST("2026-12-01", "17:00"));
  clock.set(MST("2026-12-01", "09:00")); await loadRow(j, loanId, {});
  const asked = await say(await fresh(j1.A), "can I refinance again?", { loan_id: loanId }); assert.equal(asked.status, 200, JSON.stringify(asked.body)); assert.equal(asked.body["command"], "refi.request"); await settle();
  const ready = (await loanEvents(loanId, "refi.opportunity.offer_ready")).at(-1)!; const oppId = String(ready.payload["opportunity_id"]); await mloApproves(j, loanId, oppId);
  const offer = (await offerCardFor(loanId, j1.partyA, oppId))!; assert.ok(offer);
  clock.set(MST("2026-12-01", "10:00"));
  const yes = await resolve(await fresh(j1.A), offer.card_instance_id, { option_id: "yes", evidence: { decision: "yes", decided_at: clock.now() } }); assert.equal(yes.status, 201, JSON.stringify(yes.body));
  assert.ok((yes.body["events"] as string[]).includes("lead.created")); assert.ok((yes.body["events"] as string[]).includes("refi.opportunity.engaged")); const leadId = String((yes.body["result"] as P)["lead_id"]);
  await settle(); await settle();
  const app = (await db.query<{ id: string; prior_loan_id: string }>(`SELECT id, prior_loan_id FROM applications WHERE id = $1`, [leadId]))[0]; assert.ok(app, "the compressed application (id = the lead)"); assert.equal(app!.prior_loan_id, loanId); j2.convApp = app!.id;
  assert.ok((await appEvents(app!.id, "application.received")).length >= 1); assert.equal((await entity("refi_opportunities", oppId))?.["status"], "converted");
  const cards = await cardsOfApp(app!.id, j1.partyA);
  const connect = cards.find((c) => c.kind === "ConnectCard" && c.props["vendor"] === "truv_income")!; assert.ok(connect, "ConnectCard{truv_income} again"); assert.equal(connect.status, "pending"); assert.equal(connect.command_ref, "verification.connect");
  assert.ok(!cards.some((c) => c.copy_key === "income.confirm.title"), "no income from a standing connection");
  assert.equal((await appEvents(app!.id, "verification.ordered")).filter((e) => e.payload["authorization_consent_id"] === j2.standingId).length, 0, "nothing refreshed under the withdrawn authorization");
  // the borrower withdraws this application so the loan re-enters rate-watch for the next test's conversion
  clock.set(MST("2026-12-01", "11:00"));
  const w = await api("POST", "/v1/borrower/commands/application.withdraw", { reason: "not now", subject: { application_id: app!.id } }, await fresh(j1.A)); assert.equal(w.status, 200, JSON.stringify(w.body)); await settle();
});

test("32.11-T6: Given **Yes**, then the compressed application asks income (fresh statement), hard-pull authorization, declarations and demographics again, and does not re-ask address (ConfirmCard from `servicing_record`) or identity documents; `application.trid_received` fires on the sixth confirmation.", { skip }, async () => {
  const j = j2.j!; const loanId = j2.loanId;
  // the standing authorization kept (DELTA-05): captured through the same command the ConsentCard issues
  clock.set(MST("2026-12-02", "09:00"));
  const keep = await api("POST", "/v1/borrower/commands/consent.capture", { kind: "blanket_verification_authorization", method: "checkbox_with_text", standing: true, scope: ["truv_income", "plaid_assets"], disclosure_version_id: "DELTA-05-standing-authorization-v1", purpose: "informational", text_hash: "sha256:standing-v1", subject: { loan_id: loanId } }, await fresh(j1.A));
  assert.equal(keep.status, 200, JSON.stringify(keep.body)); const standingId = String((keep.body["result"] as P)["consent_id"]);
  await settle(); assert.equal(((( await record(j1.A, loanId))["loan"] as P)["standing_connections"] as P)["status"], "active");
  // the borrower asks, the MLO approves, the borrower says Yes → lead.created linked, converted, the compressed application
  clock.set(EST("2026-12-02", "06:35")); await sheet(j, "rs-2026-12-02", EST("2026-12-02", "06:35"), EST("2026-12-02", "17:00"));
  clock.set(MST("2026-12-02", "09:30")); await loadRow(j, loanId, {});
  const asked = await say(await fresh(j1.A), "What would a refinance look like?", { loan_id: loanId }); assert.equal(asked.status, 200, JSON.stringify(asked.body)); await settle();
  const ready = (await loanEvents(loanId, "refi.opportunity.offer_ready")).at(-1)!; const oppId = String(ready.payload["opportunity_id"]); await mloApproves(j, loanId, oppId);
  const offer = (await offerCardFor(loanId, j1.partyA, oppId))!; assert.ok(offer);
  clock.set(MST("2026-12-02", "10:00"));
  const yes = await resolve(await fresh(j1.A), offer.card_instance_id, { option_id: "yes", evidence: { decision: "yes", decided_at: clock.now() } }); assert.equal(yes.status, 201, JSON.stringify(yes.body));
  const events = yes.body["events"] as string[]; assert.ok(events.includes("lead.created")); assert.ok(events.includes("refi.opportunity.engaged")); assert.ok(events.includes("marketing.response.received") || events.includes("lead.created"));
  const leadId = String((yes.body["result"] as P)["lead_id"]); await settle(); await settle();
  const appId = (await db.query<{ id: string }>(`SELECT id FROM applications WHERE id = $1 AND prior_loan_id = $2`, [leadId, loanId]))[0]?.id; assert.ok(appId, "the compressed application"); j2.convApp = appId!;
  assert.ok((await loanEvents(loanId, "refi.opportunity.converted")).some((e) => e.payload["application_id"] === appId)); assert.ok((await loanEvents(loanId, "lead.created")).some((e) => e.payload["opportunity_id"] === oppId));
  const cards = await cardsOfApp(appId!, j1.partyA); const keys = cards.map((c) => `${c.kind}:${c.copy_key}`);
  // asked again: income as a fresh statement from the standing payroll connection (refreshed only now, after the Yes; the FAKE vendor), the hard-pull authorization, the declarations, the demographics
  const income = cards.find((c) => c.kind === "ConfirmCard" && c.copy_key === "income.confirm.title")!; assert.ok(income, `the income ConfirmCard: ${keys.join(" ")}`);
  const incomeFields = income.props["fields"] as { path: string; value: string; source: string }[]; const base = incomeFields.find((f) => f.path === "monthly_base_cents")!; assert.equal(base.source, "payroll_connection"); assert.equal(base.value, "820000", "the FAKE payroll report of today, not the origination file's 1480000"); assert.equal(income.props["standing_connection"], true); assert.equal(income.props["standing_consent_id"], standingId);
  assert.ok((await appEvents(appId!, "verification.ordered")).some((e) => e.payload["authorization_consent_id"] === standingId && e.payload["component"] === "income"), "22.3 ordered the refresh under the standing authorization"); assert.ok((await appEvents(appId!, "verification.received")).some((e) => e.payload["kind"] === "income"));
  assert.equal(cards.filter((c) => c.kind === "ConnectCard" && c.props["vendor"] === "truv_income" && c.status === "pending").length, 0, "no payroll connector to re-do");
  const credit = cards.find((c) => c.kind === "ConsentCard" && c.copy_key === "consent.credit.title")!; assert.ok(credit); assert.equal((credit.props["command_args"] as P)["kind"], "hard_pull"); assert.equal(credit.command_ref, "credit.authorize");
  assert.ok(cards.some((c) => c.kind === "ChoiceCard" && c.copy_key === "declarations.title" && c.status === "pending")); assert.ok(cards.some((c) => c.kind === "DemographicsCard" && c.status === "pending"));
  // not re-asked: the address is a ConfirmCard from the servicing record (never from an ID), and there is no identity ConnectCard, no ID/SSN typing
  const home = cards.find((c) => c.copy_key === "refi.home.confirm")!; assert.ok(home); const homeFields = home.props["fields"] as { path: string; value: string; source: string }[]; assert.equal(homeFields.find((f) => f.path === "property_address")!.source, "servicing_record"); assert.match(homeFields.find((f) => f.path === "property_address")!.value, /100 N Central Ave/);
  assert.equal(cards.filter((c) => c.kind === "ConnectCard" && c.props["vendor"] === "stripe_identity").length, 0, "identity documents are not re-asked"); assert.ok(!cards.some((c) => c.copy_key === "identity.confirm.title" || c.copy_key === "identity.ssn.title" || c.copy_key === "identity.stripe.purpose"));
  assert.ok(!cards.some((c) => ((c.props["fields"] as { source: string }[] | undefined) ?? []).some((f) => f.source === "stripe_identity")));
  const ssn = cards.find((c) => c.copy_key === "refi.ssn.confirm")!; assert.ok(ssn); assert.equal((ssn.props["fields"] as { value: string }[])[0]!.value, "••••6789"); assert.equal(ssn.props["identity_on_file"], true);
  assert.equal((await appEvents(appId!, "identity.verified")).length, 0); assert.equal((await appEvents(appId!, "application.trid_received")).length, 0);
  // the six confirmations — name, SSN on file, the home, the value, the loan amount, the income — TRID's six items; `application.trid_received` fires on the sixth, not before
  const confirm = async (copy_key: string, fields: { path: string; value_confirmed: string; source: string }[]) => { const c = cards.find((x) => x.copy_key === copy_key)!; assert.ok(c, copy_key); const r = await resolve(await fresh(j1.A), c.card_instance_id, { evidence: { fields: fields.map((f) => ({ ...f, confirmed_at: clock.now() })), edited: false } }); assert.equal(r.status, 201, `${copy_key}: ${JSON.stringify(r.body)}`); return r.body["result"] as P; };
  const fieldsOf = (copy_key: string) => (cards.find((x) => x.copy_key === copy_key)!.props["fields"] as { path: string; value: string; source: string }[]).map((f) => ({ path: f.path, value_confirmed: f.value, source: f.source }));
  clock.set(MST("2026-12-02", "10:05")); await confirm("refi.name.confirm", fieldsOf("refi.name.confirm"));
  clock.set(MST("2026-12-02", "10:06")); await confirm("refi.ssn.confirm", fieldsOf("refi.ssn.confirm"));
  clock.set(MST("2026-12-02", "10:07")); await confirm("refi.home.confirm", fieldsOf("refi.home.confirm"));
  clock.set(MST("2026-12-02", "10:08")); await confirm("value.confirm.title", fieldsOf("value.confirm.title"));
  clock.set(MST("2026-12-02", "10:09")); const fifth = await confirm("loan_amount.confirm.title", fieldsOf("loan_amount.confirm.title"));
  assert.equal(fifth["trid_emitted"], false); assert.equal((await appEvents(appId!, "application.trid_received")).length, 0, "five of six: not yet");
  clock.set(MST("2026-12-02", "10:11")); const sixth = await confirm("income.confirm.title", fieldsOf("income.confirm.title"));
  assert.equal(sixth["trid_emitted"], true, JSON.stringify(sixth)); assert.equal(sixth["source"], "payroll_connection");
  const trid = await appEvents(appId!, "application.trid_received"); assert.equal(trid.length, 1); assert.equal(trid[0]!.payload["trid_received_at"], MST("2026-12-02", "10:11"));
  const items = trid[0]!.payload["items"] as Record<string, string>; assert.equal(items["income"], "borrower_confirmed_prefill"); assert.equal(items["ssn"], "borrower_confirmed_prefill"); assert.equal(items["property_address"], "borrower_confirmed_prefill");
  const intake = await entity("applications", appId!); assert.equal(String(intake!["income_monthly_cents"]), "820000", "the income stated fresh for this application");
  assert.equal((await timerOn({ application_id: appId! }, "REGZ_1026_19E1_LE_3BD"))?.status, "armed", "the LE clock from the sixth confirmation");
  const rec = await record(j1.A, appId!); assert.equal((rec["status"] as P)["badge"], "Application received"); assert.equal((((await record(j1.A, loanId))["loan"] as P)["ratewatch"] as P)["state"], "in_progress");
});

// ═══════════════════════════════════ the copy library (no database)
test("32.11-T10: Given any Rate-watch copy, then it contains no reference to the investor and no future-terms promise (string tests on the copy library).", () => {
  const md = readFileSync(fileURLToPath(new URL("../../../spec/sections/32-borrower-experience/copy-library.md", import.meta.url)), "utf8");
  const section = md.split(/^## /m).find((s) => s.startsWith("Rate-watch and re-refinance"))!; assert.ok(section, "the Rate-watch section of the copy library");
  const entries = section.split("\n").filter((l) => l.startsWith("- `")).map((l) => ({ key: /^- `([^`]+)`/.exec(l)![1]!, line: l }));
  const keys = entries.map((e) => e.key);
  for (const k of ["ratewatch.block", "ratewatch.worth_it", "offer.card", "offer.not_now", "offer.never", "refi.same_servicer.funded", "ratewatch.passive", "refi.escrow.moved", "refi.request.received", "consent.standing.manage", "consent.standing.off"]) assert.ok(keys.includes(k), `copy key ${k}`);
  // the consent strings this loop offers are Rate-watch copy too (32.11 §2, §5)
  const consents = md.split("\n").filter((l) => /^- `consent\.(tcpa\.marketing\.title|standing\.title)`/.test(l)).map((line) => ({ key: /^- `([^`]+)`/.exec(line)![1]!, line }));
  assert.equal(consents.length, 2);
  for (const { key, line } of [...entries, ...consents]) {
    assert.ok(!NO_INVESTOR.test(line), `${key}: no investor reference — ${line}`);
    assert.ok(!NO_FUTURE_TERMS.test(line), `${key}: no future-terms promise — ${line}`);
    assert.ok(!/\bguaranteed?\b/i.test(line), `${key}: never "guaranteed"`);
  }
  // the block describes monitoring and offers, never a commitment: "we'll tell you when a change is worth it", "not a commitment to lend; rates change daily"
  assert.match(entries.find((e) => e.key === "ratewatch.block")!.line, /we'll tell you when a change is worth it/);
  assert.match(entries.find((e) => e.key === "ratewatch.worth_it")!.line, /at least 0\.25% lower/);
  // the OfferCard's fixed lines and a rendered card carry the same discipline
  const sample = offerCardProps({ opp: { opportunity_id: "opp-1", trigger_kind: "scheduled", status: "offered", candidate_terms: { note_rate: "0.055", pi_cents: "317000", term_months: 360 }, existing_terms: { note_rate: "0.06125" }, benefit_metrics: { pi_delta_cents: "-23262", borrower_paid_costs_cents: "0" } }, quote: { quote_id: "Q-OFFER-opp-1", apr_estimate: "5.530" }, expires_at: "2027-04-18T06:59:59.000Z", partner_name: "Partner Bank", partner_nmlsr_id: "123456", mlo: { name: "Jordan Rivera", nmlsr_id: "987654" }, partner_id: "partner-1", state: "AZ", time_zone: "America/Phoenix" });
  for (const text of [NOT_A_COMMITMENT_TEXT, RATES_CHANGE_DAILY_TEXT, NO_COST_LINE, paymentLine(360, "$3,170.00"), lenderLine("Partner Bank", "123456"), JSON.stringify(sample)]) { assert.ok(!NO_INVESTOR.test(text), text); assert.ok(!NO_FUTURE_TERMS.test(text), text); assert.ok(!/guarantee/i.test(text), text); }
  assert.equal(sample["monthly_savings_cents"], "23262"); assert.equal(sample["offered_rate"], "5.500"); assert.equal(sample["current_rate"], "6.125"); assert.equal(sample["mlo_attribution"], "Jordan Rivera, NMLSR ID 987654");
  assert.match(String(sample["lender_line"]), /Partner Bank, NMLSR ID 123456, is your lender; Supermortgage services your loan for Partner Bank\./);
});
