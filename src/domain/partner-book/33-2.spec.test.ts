// 33.2 The daily refinance review: every monitored loan reviewed each day by the refinance analyst
// spec/sections/33-partner-book/33-2-the-daily-refinance-review-of-the-partner-book.md
// One node:test per T-id, named exactly as the spec. The fixture book of 33.1 is imported through importPartnerBook, the FAKE sheet /
// program / LLPA matrix / cost schedule are seeded the way the entry demo seeds them (src/runtime/entry-seed.ts seedEntryDemo, the demo
// partner = the fixture partner), a FixedClock stands at 07:05 America/New_York on 2026-09-15 and runtime.sweep() takes the day's passes
// (20.1's refinance check, then this process's review with a scripted analyst, offer delivery and expiry). The homeowners sign in through
// the borrower API's own doors and the scripted model of src/domain/borrower/eval/scripted-client.ts plays both the analyst (its own
// client) and the borrower turn. Own database `<base>_33_2`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { connect, reachable, type Db } from "../../infra/db/client.ts";
import { decodeEntityData } from "../../infra/db/entities.ts";
import { PgBorrowerUiRepository, type CardInstanceRow } from "../../infra/db/borrower-ui.ts";
import type { Subject } from "../../infra/db/borrower-parties.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock } from "../../kernel/events/index.ts";
import { addMonths, plainDate } from "../../kernel/calendar/date.ts";
import { Runtime, type SweepReport } from "../../runtime/app.ts";
import { createApiServer, listen } from "../../runtime/server.ts";
import { createLogger } from "../../runtime/log.ts";
import { createBorrowerRouter, type BorrowerRouter } from "../../runtime/borrower/routes.ts";
import { BorrowerRecordReader } from "../../runtime/borrower/record.ts";
import { AnthropicLlm } from "../../runtime/borrower/agent/llm.ts";
import { provenanceViolation } from "../../runtime/borrower/agent/guard.ts";
import { seedEntryDemo } from "../../runtime/entry-seed.ts";
import { importPartnerBook } from "../../runtime/partner-book.ts";
import { CANDIDATE_REASONS, REVIEW_RULE_SET_VERSION, opportunityIdFor, pctOfRate, reviewRunIdFor } from "../../runtime/partner-book-review.ts";
import { ANALYST_PROMPT_VERSION } from "../../runtime/partner-book-analyst.ts";
import { FAKE_OFFICER, campaignIdFor, creativeIdFor, deliverOffers, ensureCampaign, fakeOfficerFromEnv, partnerFacts, sheetRatesPct, touchIdFor } from "../../runtime/partner-book-offers.ts";
import { EntityStore } from "../../app/tools.ts";
import type { PartnerProgram } from "../leads-pricing/ops-20-1.ts";
import type { RateSheet } from "../leads-pricing/ops-20-4.ts";
import { FakeRateFeed } from "../../infra/integrations/rates.ts";
import { FakeReviewers } from "../../infra/integrations/reviewers.ts";
import { FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { scriptedClient, parseSituation, type Scene } from "../borrower/eval/scripted-client.ts";
import { writeXlsx } from "../../infra/files/xlsx.ts";
import { INVESTOR_FIELDS, PROHIBITED_SELECTION_FIELDS, scheduledUpb } from "../leads-pricing/ops-20-1.ts";
import { M3_V1 } from "./profiles/m3-v1.ts";
import { DEMO_AS_OF, DEMO_PARTNER, demoBook, demoMin, type DemoLoan } from "./fixtures/partner-book-demo.ts";

const BASE_URL = process.env["TEST_DATABASE_URL"] ?? "postgresql://sm:sm@localhost/supermortgage_test";
const DB_URL = ((): string => { const u = new URL(BASE_URL); u.pathname = `${u.pathname}_33_2`; return u.toString(); })();
const ADMIN_URL = ((): string => { const u = new URL(DB_URL); u.pathname = "/postgres"; return u.toString(); })();
const up = await reachable(ADMIN_URL);   // the database itself is dropped and created by the setup
if (!up && process.env["REQUIRE_DB"]) throw new Error(`REQUIRE_DB set but ${ADMIN_URL} is not reachable`);
const skip = up ? false : `no Postgres at ${ADMIN_URL}`;
const TOKEN = "ops-" + randomUUID();
type Json = Record<string, unknown>;
/** The first review day: 2026-09-15 07:05 America/New_York (EDT) — after 20.1's 06:30 run and this process's 07:00 pass. */
const AS_OF = "2026-09-15"; const NOW = "2026-09-15T11:05:00.000Z";
/** Day 31: the offer of 2026-09-15 is valid until 2026-10-15; the sweep of 2026-10-16 07:05 ET expires it (rule 6). */
const AS_OF_31 = "2026-10-16"; const NOW_31 = "2026-10-16T11:05:00.000Z";
/** Day 32: the offers of 2026-10-16 are open (valid until 2026-11-15) — the morning after, nothing is offered twice (rule 5: one open offer per loan). */
const AS_OF_32 = "2026-10-17"; const NOW_32 = "2026-10-17T11:05:00.000Z";
const clock = new FixedClock(NOW);
const PROGRAM_RULE_SET = "sm.refi_trigger.v1";

// ---------------------------------------------------------------- the scripted analyst (rule 4): review_facts then review_write, the figures only as {{facts.*}} tokens
/** A clean rationale: every figure a token the surface resolves. */
const CLEAN_RATIONALE = "Your rate today is {{facts.rate_now}} and this morning's sheet shows {{facts.candidate_rate}}, which lowers the payment by {{facts.monthly_delta}}. The offer is on the card here.";
const CANDIDATE_FLAGS = ["value_low_confidence"];
const EXCLUDED_FLAGS = ["pay_string_late"];
/** The user message of the analyst's turn reads "The engine's verdict is <verdict> — …" (partner-book-analyst.ts analystUserMessage). */
const ANALYST_CANDIDATE: Scene = { when: /verdict is candidate/, calls: [{ name: "review.facts", input: {} }, { name: "review.write", input: { rationale: CLEAN_RATIONALE, flags: CANDIDATE_FLAGS } }], text: "Written." };
/** A digit outside a token → the guard refuses it → one regeneration → a second violation (a spelled-out amount) → analyst.skipped = provenance. */
const WATCHING_DIGIT = "Your rate is 5.875% today and the sheet is not below it yet.";
const WATCHING_SPELLED = "Still five point eight seven five percent today; we check every morning.";
const ANALYST_WATCHING: Scene = { when: /verdict is watching/, calls: [{ name: "review.facts", input: {} }, { name: "review.write", input: { rationale: WATCHING_DIGIT, flags: [] } }], text: "Written.", regenerate: WATCHING_SPELLED };
/** A digit outside a token → one regeneration that comes back clean → written (the one regeneration runs and is enough). */
const EXCLUDED_DIGIT = "The loan is out of today's review for 1 reason on the partner's file.";
const EXCLUDED_CLEAN = "The loan is out of today's review because of what is on the partner's file; nothing is offered.";
const ANALYST_EXCLUDED: Scene = { when: /verdict is excluded/, calls: [{ name: "review.facts", input: {} }, { name: "review.write", input: { rationale: EXCLUDED_DIGIT, flags: EXCLUDED_FLAGS } }], text: "Written.", regenerate: EXCLUDED_CLEAN };
const analystScripted = scriptedClient([ANALYST_CANDIDATE, ANALYST_WATCHING, ANALYST_EXCLUDED]);

// ---------------------------------------------------------------- the scripted borrower model (rule 7): the answer comes from the situation's partner_book.review, in words
const MONITORED_FIRST_TURN: Scene = { when: /signed in for the first time to the account their servicer set up/, text: "Hi {{party.first_name}}, I'm Michelle, the automated assistant here. Your loan with {{partner_book.partner_name}} is on the record here and {{partner_book.partner_name}} keeps servicing it." };
const RETURNING: Scene = { when: /the borrower is back/, text: "Welcome back, {{party.first_name}}. Your loan with {{partner_book.partner_name}} is on the record here and nothing is needed from you now." };
const REFI_CANDIDATE_REPLY = "Yes, {{party.first_name}}, this morning's check says a refinance would put you ahead. The card here has the terms.";
const REFI_WATCHING_REPLY = "Not yet, {{party.first_name}}. Rates have not come down far enough for you. I look at your loan every morning and will say so the day they do.";
const REFI_OTHER_REPLY = "Not right now, {{party.first_name}}. I look at your loan every morning and will say so when that changes.";
const REFI_QUESTION: Scene = { when: /refinanc/i, text: (s) => { const review = (s.record?.["partner_book"] as Json | undefined)?.["review"] as Json | undefined; const verdict = String(review?.["verdict"] ?? "none"); return verdict === "candidate" ? REFI_CANDIDATE_REPLY : verdict === "watching" ? REFI_WATCHING_REPLY : REFI_OTHER_REPLY; } };
const scripted = scriptedClient([MONITORED_FIRST_TURN, RETURNING, REFI_QUESTION]);

let db: Db; let runtime: Runtime; let router: BorrowerRouter; let base = ""; let close: () => Promise<void> = async () => undefined;
let partnerPartyId = "";
const logLines: string[] = [];
const book = demoBook();
const loanN = (n: number): DemoLoan => book.loans.find((l) => l.n === n)!;
const edelivery = (): FakeEdelivery => runtime.ports.edelivery as FakeEdelivery;
/** Loan 13: a copy of loan 1's tape row (the same AZ 7.250 % loan, so the engine prices it the same way) for a homeowner the supplement never named — no e-mail, no phone: the portal-only party of T5. */
const PORTAL_LOAN_NUMBER = "NL-100013";

test.before(async () => {
  if (skip) return;
  const name = new URL(DB_URL).pathname.slice(1);
  const a = connect(ADMIN_URL); await a.query(`DROP DATABASE IF EXISTS ${name}`); await a.query(`CREATE DATABASE ${name}`); await a.end();
  execFileSync(fileURLToPath(new URL("../../../db/migrate.sh", import.meta.url)), { env: { ...process.env, DATABASE_URL: DB_URL }, stdio: "pipe" });
  db = connect(DB_URL);
  const logger = createLogger("json", (line) => { logLines.push(line); if (process.env["FLOW_DEBUG"] && /flow|error|unhandled|partner|analyst|"status":[45]/i.test(line)) process.stderr.write(line + "\n"); });
  // the FAKE feed publishes the day's sheet (20.1), the FAKE MLO approves the offer's terms on the next sweep (32.11), the scripted analyst plays rule 4's turn
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock, logger, rateFeed: new FakeRateFeed(), reviewers: new FakeReviewers({ delaySeconds: 0 }), analystLlm: new AnthropicLlm({ client: analystScripted.client, model: "scripted" }) });
  // the partner's parties{servicer} row (ensurePartner finds it by legal name) doubles as the borrower surface's configured partner and the entry seed's demo partner
  partnerPartyId = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id, contact) VALUES ('servicer', $1, $2, $3, '{"phone": "+18005550199"}'::jsonb) RETURNING id`, [DEMO_PARTNER.legal_name, DEMO_PARTNER.servicer_number, DEMO_PARTNER.mers_org_id]))[0]!.id;
  router = createBorrowerRouter({ runtime, logger, environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost", "http://127.0.0.1"], urlSecret: "test-secret", defaultPartnerId: partnerPartyId, llm: { client: scripted.client, model: "scripted" } });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger, console: false, borrowerRouter: router });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => { router.hub.close(); server.closeAllConnections?.(); server.close(() => db.end().then(() => resolve())); });
});
test.after(async () => { if (!skip) { await router.flows?.settle(); await close(); } });

// ---------------------------------------------------------------- helpers
type Reply = { status: number; body: Json };
async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, ip = "10.33.2.1"): Promise<Reply> {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-forwarded-for": ip, ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text(); return { status: r.status, body: text ? (JSON.parse(text) as Json) : {} };
}
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
const settle = async () => { await router.flows!.settle(); await router.agent?.settle(); await router.flows!.settle(); };
const usd = (c: bigint): string => { const neg = c < 0n; const abs = neg ? -c : c; const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ","); return `${neg ? "-" : ""}$${whole}.${(abs % 100n).toString().padStart(2, "0")}`; };
const bytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "utf8"));
const J = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x));
const col = (key: string): number => { const i = M3_V1.columns.findIndex((c) => c.key === key); assert.ok(i >= 0, `the profile's ${key} column`); return i; };
type LoanRow = { id: string; servicer_loan_number: string; status: string; partner_party_id: string };
const monitoredLoans = async (): Promise<LoanRow[]> => db.query<LoanRow>(`SELECT id::text AS id, servicer_loan_number, status::text AS status, partner_party_id::text AS partner_party_id FROM loans WHERE partner_party_id = $1 AND status = 'monitored' ORDER BY servicer_loan_number`, [partnerPartyId]);
const loanByNumber = async (number: string): Promise<LoanRow> => { const l = (await monitoredLoans()).find((x) => x.servicer_loan_number === number); assert.ok(l, `loan ${number} on the book`); return l; };
const loanOf = (n: number): Promise<LoanRow> => loanByNumber(loanN(n).servicer_loan_number);
type PartyRow = { id: string; legal_name: string; contact: Json };
const partyOfLoan = async (loanId: string): Promise<PartyRow> => { const r = (await db.query<PartyRow>(`SELECT p.id::text AS id, p.legal_name, p.contact FROM loan_borrowers lb JOIN borrowers b ON b.id = lb.borrower_id JOIN parties p ON p.id = b.party_id WHERE lb.loan_id = $1 ORDER BY lb.is_primary DESC LIMIT 1`, [loanId]))[0]; assert.ok(r, "the loan's party"); return r; };
type EventRow = { type: string; loan_id: string | null; payload: Json; sequence: string; occurred_at: string };
const events = async (type: string, loanId?: string): Promise<EventRow[]> => db.query<EventRow>(`SELECT type, loan_id::text AS loan_id, payload, sequence::text AS sequence, occurred_at::text AS occurred_at FROM loan_events WHERE type = $1 AND ($2::uuid IS NULL OR loan_id = $2::uuid) ORDER BY loan_events.sequence`, [type, loanId ?? null]);
type TimerRow = { code: string; subject_kind: string; subject_id: string; loan_id: string | null; status: string; anchor_date: string; due_date: string | null; due_at: string | null; satisfied_at: string | null; breached_at: string | null };
const timers = async (code: string, loanId?: string): Promise<TimerRow[]> => db.query<TimerRow>(`SELECT code, subject_kind, subject_id, loan_id::text AS loan_id, status::text AS status, anchor_date::text AS anchor_date, due_date::text AS due_date, due_at::text AS due_at, satisfied_at::text AS satisfied_at, breached_at::text AS breached_at FROM timers WHERE code = $1 AND ($2::uuid IS NULL OR loan_id = $2::uuid) ORDER BY armed_at, id`, [code, loanId ?? null]);
const entity = async (kind: string, id: string): Promise<Json | null> => { const r = (await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = $1 AND id = $2`, [kind, id]))[0]; return r ? decodeEntityData(r.data) : null; };
type ReviewRow = { id: string; loan_id: string; party_id: string | null; as_of_date: string; run_id: string; opportunity_id: string | null; verdict: string; reasons: string[]; facts: Json; analyst: Json; decision_id: string | null; created_at: string };
const reviewsOf = async (asOf: string): Promise<ReviewRow[]> => db.query<ReviewRow>(`SELECT id::text AS id, loan_id::text AS loan_id, party_id::text AS party_id, as_of_date::text AS as_of_date, run_id, opportunity_id, verdict, reasons, facts, analyst, decision_id::text AS decision_id, created_at::text AS created_at FROM partner_book_reviews WHERE as_of_date = $1 ORDER BY loan_id`, [asOf]);
const reviewOf = async (loanId: string, asOf: string): Promise<ReviewRow> => { const r = (await reviewsOf(asOf)).find((x) => x.loan_id === loanId); assert.ok(r, `the review of ${loanId} as of ${asOf}`); return r; };
const latestFacts = async (loanId: string): Promise<{ as_of_date: string; facts: Json }> => (await db.query<{ as_of_date: string; facts: Json }>(`SELECT as_of_date::text AS as_of_date, facts FROM partner_book_facts WHERE loan_id = $1 ORDER BY as_of_date DESC, created_at DESC LIMIT 1`, [loanId]))[0]!;
const ui = (): PgBorrowerUiRepository => new PgBorrowerUiRepository(db);
const offerCards = async (partyId: string): Promise<CardInstanceRow[]> => (await ui().cardsOf(partyId)).filter((c) => c.kind === "OfferCard");
const subjectFor = (loan: LoanRow): Subject => ({ application_id: null, loan_id: loan.id, role: "borrower", stage: "servicing", label: loan.servicer_loan_number, application_borrower_id: null });
const record = async (loan: LoanRow) => { const party = await partyOfLoan(loan.id); return new BorrowerRecordReader(db).record(party, subjectFor(loan), await ui().cardsOf(party.id), clock.now()); };
/** No figure outside a {{token}}: the guard's own provenance rule (src/runtime/borrower/agent/guard.ts) plus no digit at all once the tokens are stripped. */
const onlyTokens = (text: string, where: string): void => { assert.equal(provenanceViolation(text), null, `${where}: ${provenanceViolation(text)} — ${text}`); assert.doesNotMatch(text.replace(/\{\{[a-zA-Z0-9_.:-]+\}\}/g, ""), /\d/, `${where} carries a digit outside a token: ${text}`); };
const NO_FIGURE = (text: string, where: string): void => { assert.doesNotMatch(text, /\d/, `${where} carries a digit: ${text}`); assert.doesNotMatch(text, /%|\$|basis points/i, `${where} carries a rate or amount: ${text}`); };
const programId = (): string => `prog-refi-${partnerPartyId.slice(0, 8)}`;   // seedEntryDemo's id scheme = importPartnerBook's (33.1 registers the same program when absent)
const oppOf = (loan: LoanRow, asOf = AS_OF): string => opportunityIdFor(loan.id, plainDate(asOf), programId());

/** The 13th loan's tape: loan 1's row under another number, MIN, name and address; no supplement row → a party without contact (33.1: gaps: contact, no invitation). */
function portalTape(): Uint8Array {
  const row = [...book.tapeRows[1]!]; assert.equal(row[col("servicer_loan_number")], loanN(1).servicer_loan_number, "row 1 of the tape is loan 1");
  row[col("servicer_loan_number")] = PORTAL_LOAN_NUMBER; row[col("borrower_name")] = "Nora Portal"; row[col("mers_min")] = demoMin(13); row[col("property_address")] = "77 Portal Ct";
  return writeXlsx([book.tapeRows[0]!, row], "M3");
}
/** The partner's next monthly tape (as of 2026-10-01): every loan one payment further along — next due and last payment a month later, the UPB one scheduled payment lower. */
function nextMonthTape(): Uint8Array {
  const rows = book.tapeRows.map((r) => [...r]); const portal = [...book.tapeRows[1]!];
  portal[col("servicer_loan_number")] = PORTAL_LOAN_NUMBER; portal[col("borrower_name")] = "Nora Portal"; portal[col("mers_min")] = demoMin(13); portal[col("property_address")] = "77 Portal Ct"; rows.push(portal);
  const shift = (cell: string | number | null): string | number | null => (typeof cell === "string" && /^\d{4}-\d{2}-\d{2}$/.test(cell) ? addMonths(plainDate(cell), 1) : cell);
  for (let i = 1; i < rows.length; i += 1) {
    const r = rows[i]!; const number = String(r[col("servicer_loan_number")]); const l = book.loans.find((x) => x.servicer_loan_number === number) ?? loanN(1);
    r[col("as_of_date")] = "2026-10-01"; r[col("next_due_date")] = shift(r[col("next_due_date")] ?? null); r[col("last_payment_date")] = shift(r[col("last_payment_date")] ?? null);
    r[col("upb_cents")] = Number(scheduledUpb(l.original_cents, l.note_rate_pct, l.term_months, l.payments_made + 1)) / 100;
  }
  return writeXlsx(rows, "M3");
}

/** Day 1, once per file: the seed, the two imports, the 07:05 ET sweep (20.1's run → the review → offer delivery), the flows, and the FAKE MLO's approval on a second same-day sweep (idempotent for the run and the review). */
let day1: { sweep: SweepReport; again: SweepReport; import_id: string } | undefined;
async function firstDay(): Promise<{ sweep: SweepReport; again: SweepReport; import_id: string }> {
  if (day1) return day1;
  assert.equal(clock.now(), NOW);
  const seed = await seedEntryDemo(runtime, { partner_id: partnerPartyId, nmlsr_id: DEMO_PARTNER.nmlsr_id });
  assert.equal(seed.partner_id, partnerPartyId, "the demo partner is the fixture partner");
  const actor = { kind: "human" as const, id: "u-ops-analyst", role: "ops_analyst" };
  const imp = await importPartnerBook(runtime, { partner: DEMO_PARTNER, as_of_date: DEMO_AS_OF, profile: "m3-v1", tape: { filename: "partner-book-demo.xlsx", content: book.tape }, supplement: { filename: "partner-book-demo-supplement.csv", content: bytes(book.supplement) } }, actor);
  assert.equal(imp.status, "loaded", JSON.stringify(imp.report).slice(0, 600)); assert.equal(imp.rows_loaded, 12);
  const portal = await importPartnerBook(runtime, { partner: DEMO_PARTNER, as_of_date: DEMO_AS_OF, profile: "m3-v1", tape: { filename: "partner-book-demo-13.xlsx", content: portalTape() } }, actor);
  assert.equal(portal.status, "loaded", JSON.stringify(portal.report).slice(0, 600)); assert.equal(portal.rows_loaded, 1); assert.equal(portal.loans_created, 1); assert.equal(portal.invitations_sent, 0, "no contact, no invitation");
  await settle();
  const sweep = await runtime.sweep(); await settle();
  const again = await runtime.sweep(); await settle();   // the FAKE MLO's terms review (32.11: offer_ready → review → presented → the OfferCard)
  day1 = { sweep, again, import_id: imp.import_id }; return day1;
}

test("33.2-T1: Given the fixture book imported and the FAKE sheet published, when the sweep passes at 07:00 ET, then `20.1 loadUniverse{op=load_row}` has written a `refi_universe` row per monitored loan carrying `value_estimate{source=partner_fmv, confidence=medium}` and `representative_score` from the tape and no investor or prohibited-basis key, 20.1's run evaluated every monitored loan, one `partner_book_reviews` row per loan exists for the day, `partner_book.review.run_completed` is logged with the counts and `SM_PARTNER_BOOK_REVIEW_DAILY` is satisfied and re-armed for tomorrow.", { skip }, async () => {
  const { sweep } = await firstDay();
  const loans = await monitoredLoans(); assert.equal(loans.length, 13, "the fixture's 12 loans and the portal-only 13th");
  // 20.1's run of the day (06:30 pass, forced by the clock past 07:00) on the FAKE sheet
  const refi = sweep.refi; assert.ok(refi && refi.ran, `the refinance check ran: ${refi?.reason}`);
  assert.deepEqual(refi.rate_sheet, { rate_sheet_id: `rs-${AS_OF}-FAKE`, published: true, source: "pe_whole_loan_api", price_count: 9 });
  assert.equal(refi.universe.monitored.rows, 13, "rule 1: a row per monitored loan from the facts"); assert.equal(refi.universe.monitored.skipped, 0); assert.deepEqual(refi.universe.skipped, []);
  assert.equal(refi.universe.loaded, 13, "every monitored row loaded through 20.1 loadUniverse{op=load_row}");
  const run = refi.programs.find((p) => p.program_id === programId()); assert.ok(run, "the partner's program ran"); assert.equal(run.partner_id, partnerPartyId); assert.equal(run.error, null);
  assert.equal(run.loans_in_universe, 13, "monitored loans count in loans_in_universe (rule 2)"); assert.equal(run.loans_evaluated, 13, "20.1's run evaluated every monitored loan");
  const runCompleted = (await events("refi.trigger.run_completed")).filter((e) => e.payload["as_of_date"] === AS_OF && e.payload["program_id"] === programId());
  assert.equal(runCompleted.length, 1); assert.equal(runCompleted[0]!.payload["loans_evaluated"], 13); assert.equal(runCompleted[0]!.payload["loans_in_universe"], 13);
  for (const l of loans) {
    const f = (await latestFacts(l.id)).facts;
    const row = await entity("refi_universe", l.id); assert.ok(row, `a refi_universe row for ${l.servicer_loan_number}`);
    assert.equal(row["loan_id"], l.id); assert.equal(row["partner_id"], partnerPartyId); assert.equal(row["status"], "active", "status active for the engine");
    // the partner's value: the newest of Current FMV and Most Recent BPO by date, medium within 12 months of the as-of date
    const ve = row["value_estimate"] as Json; const fmvNewer = String(f["fmv_date"]) >= String(f["bpo_date"]);
    assert.equal(ve["source"], fmvNewer ? "partner_fmv" : "partner_bpo", `${l.servicer_loan_number}: the newer of FMV and BPO`); assert.equal(String(ve["value_cents"]), fmvNewer ? f["fmv_cents"] : f["bpo_value_cents"]); assert.equal(ve["as_of"], fmvNewer ? f["fmv_date"] : f["bpo_date"]);
    assert.equal(ve["confidence"], String(ve["as_of"]) >= "2025-09-15" ? "medium" : "low");
    assert.equal(row["representative_score"], f["fico_current"], "the partner's Current FICO as representative_score"); assert.equal(row["score_source"], "partner_file");
    assert.equal(String(row["upb_cents"]), f["upb_cents"]); assert.equal(row["note_rate_pct"], f["note_rate_pct"]); assert.equal(String(row["pi_cents"]), f["pi_cents"]); assert.equal(row["next_due_date"], f["next_due_date"]);
    // 20.1 rules 7–8: no investor key, no prohibited-basis key, none of the tape's columns that never reach selection
    const keys = Object.keys(row);
    for (const k of keys) { assert.ok(!INVESTOR_FIELDS.includes(k), `${l.servicer_loan_number}: investor key ${k} on the row`); assert.ok(!PROHIBITED_SELECTION_FIELDS.includes(k), `${l.servicer_loan_number}: prohibited-basis key ${k} on the row`); }
    for (const k of ["borrower_name", "property_zip", "property_address", "dti_pct", "fico_current", "fico_original", "credit_score", "mers_min", "servicer_name", "investor_net_rate_pct", "agency_remittance_type", "servicer_retained_rate_pct", "zip_toxic_ranking"]) assert.ok(!keys.includes(k), `${l.servicer_loan_number}: ${k} never reaches the row`);
    assert.equal(J(row).includes(String(f["borrower_name"])), false, "the name is not on the row"); assert.equal(J(row).includes(String(f["property_zip"])), false, "the ZIP is not on the row");
    const opp = await entity("refi_opportunities", oppOf(l)); assert.ok(opp, `20.1's opportunity row of the day for ${l.servicer_loan_number}`); assert.equal(opp["run_id"], run.run_id); assert.equal(opp["as_of_date"], AS_OF);
  }
  // the review: one partner_book_reviews row per loan for the day, the receipt with the counts
  const review = sweep.partner_book_review; assert.ok(review.ran, `the review ran: ${review.reason}`); assert.equal(review.as_of_date, AS_OF); assert.equal(review.monitored_loans, 13);
  const pr = review.programs.find((p) => p.program_id === programId()); assert.ok(pr); assert.equal(pr.run_id, reviewRunIdFor(plainDate(AS_OF), programId())); assert.equal(pr.error, null); assert.deepEqual(pr.skipped, []);
  assert.equal(pr.loans, 13); assert.equal(pr.reviewed, 13); assert.equal(pr.written, 13);
  const rows = await reviewsOf(AS_OF);
  assert.equal(rows.length, 13, "one review row per loan for the day"); assert.equal(new Set(rows.map((r) => r.loan_id)).size, 13); assert.deepEqual(rows.map((r) => r.loan_id).sort(), loans.map((l) => l.id).sort());
  for (const r of rows) { assert.equal(r.run_id, pr.run_id); assert.ok(["candidate", "watching", "not_now", "excluded"].includes(r.verdict), r.verdict); assert.ok(r.decision_id, "the review.write decision"); assert.equal(r.opportunity_id, oppOf(loans.find((l) => l.id === r.loan_id)!)); assert.ok(r.party_id, "the homeowner's party"); }
  const counts = { candidate: rows.filter((r) => r.verdict === "candidate").length, watching: rows.filter((r) => r.verdict === "watching").length, not_now: rows.filter((r) => r.verdict === "not_now").length, excluded: rows.filter((r) => r.verdict === "excluded").length };
  // the whole book priced (a FAKE cost schedule per demo state, seedEntryDemo): loans 1, 2 and 13 fire, loans 8 (30 days late), 10 (foreclosure referral) and 11 (bankruptcy) are excluded, the rest are watching — no loan `not_now` for `pricing_refused`
  const numberOf = (loanId: string): string => loans.find((l) => l.id === loanId)!.servicer_loan_number; const numbers = (v: string): string[] => rows.filter((r) => r.verdict === v).map((r) => numberOf(r.loan_id)).sort();
  assert.deepEqual(numbers("candidate"), [loanN(1).servicer_loan_number, loanN(2).servicer_loan_number, PORTAL_LOAN_NUMBER], "loans 1, 2 and 13 candidates");
  assert.deepEqual(numbers("excluded"), [loanN(8).servicer_loan_number, loanN(10).servicer_loan_number, loanN(11).servicer_loan_number], "loans 8, 10 and 11 excluded");
  assert.deepEqual(counts, { candidate: 3, watching: 7, not_now: 0, excluded: 3 });
  for (const r of rows) assert.ok(!r.reasons.some((x) => x.startsWith("pricing_refused")), `${numberOf(r.loan_id)}: the engine priced every state of the book (a cost schedule per state): ${JSON.stringify(r.reasons)}`);
  for (const r of rows.filter((x) => x.verdict === "candidate")) assert.ok(["offer_ready", "offered"].includes(String((await entity("refi_opportunities", r.opportunity_id!))?.["status"])), `${numberOf(r.loan_id)}: a candidate's opportunity fired`);
  assert.equal((await events("partner_book.review.written")).filter((e) => e.payload["as_of_date"] === AS_OF).length, 13, "partner_book.review.written per loan");
  const completed = (await events("partner_book.review.run_completed")).filter((e) => e.payload["as_of_date"] === AS_OF);
  assert.equal(completed.length, 1, "one receipt per program per day"); const p = completed[0]!.payload;
  assert.equal(completed[0]!.loan_id, null, "global"); assert.equal(p["run_id"], pr.run_id); assert.equal(p["program_id"], programId()); assert.equal(p["origination"], true);
  assert.equal(p["reviewed"], 13); assert.equal(p["candidates"], counts.candidate); assert.equal(p["watching"], counts.watching); assert.equal(p["not_now"], counts.not_now); assert.equal(p["excluded"], counts.excluded);
  assert.equal(p["analyst_turns"], 13, "every loan had a model turn: the receipt counts the day's agent_turns rows (a provenance skip ran the model too)"); assert.ok(Number(p["analyst_skipped"]) <= 13); assert.equal(p["analyst_turns"], pr.analyst_turns); assert.equal(p["analyst_skipped"], pr.analyst_skipped);
  assert.equal(p["analyst_turns"], Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM agent_turns WHERE channel = 'analyst'`))[0]!.n), "analyst_turns = the agent_turns rows the pass wrote");
  assert.equal(p["offers_delivered"], 2, "loans 1 and 2 by e-mail"); assert.equal(p["offers_portal_only"], 1, "loan 13 by the portal only"); assert.equal(p["expired"], 0);
  // SM_PARTNER_BOOK_REVIEW_DAILY: armed by the receipt for tomorrow 07:00 ET (recurring: the next day's receipt satisfies it and re-arms it — observed on the day-31 sweep of T6)
  const clocks = await timers("SM_PARTNER_BOOK_REVIEW_DAILY");
  assert.equal(clocks.length, 1, "one instance after the first run"); const t = clocks[0]!;
  assert.equal(t.status, "armed"); assert.equal(t.subject_kind, "global"); assert.equal(t.loan_id, null); assert.equal(t.anchor_date, AS_OF); assert.equal(t.due_date, "2026-09-16");
  assert.equal(new Date(t.due_at!).toISOString(), "2026-09-16T11:00:00.000Z", "+1 calendar day, 07:00 America/New_York (EDT)");
  // a second pass on the same day: the run and the review are idempotent — no second row, no second receipt
  const { again } = await firstDay();
  assert.equal(again.refi?.ran, false); assert.match(String(again.refi?.reason), /already ran today/);
  assert.equal(again.partner_book_review.ran, false); assert.match(again.partner_book_review.reason ?? "", /already ran today/);
  assert.equal((await reviewsOf(AS_OF)).length, 13); assert.equal((await events("partner_book.review.run_completed")).filter((e) => e.payload["as_of_date"] === AS_OF).length, 1); assert.equal((await timers("SM_PARTNER_BOOK_REVIEW_DAILY")).length, 1);
});

test("33.2-T2: Given loan 1 of the fixture on the first review, then the review's facts read note rate 7.250%, UPB $441,366.13, P&I $3,069.79, value $605,000.00 and LTV 0.7295, the opportunity is `offer_ready` with a candidate at 6.375% (the lowest sheet rate whose premium covers the costs) and a rate delta of 87.5 basis points, the review's candidate loan amount, candidate P&I, monthly delta and NPV equal the opportunity row's to the cent, and the verdict is `candidate`.", { skip }, async () => {
  await firstDay();
  const l1 = loanN(1); const loan = await loanOf(1); const r = await reviewOf(loan.id, AS_OF); const f = r.facts;
  // worked example A: the facts as the engine saw them — the tape's figures, copied
  assert.equal(f["note_rate_pct"], "7.250"); assert.equal(l1.note_rate_pct, "7.250");
  assert.equal(f["upb_cents"], "44136613"); assert.equal(BigInt(String(f["upb_cents"])), 44136613n); assert.equal(usd(44136613n), "$441,366.13"); assert.equal(l1.upb_cents, 44136613n); assert.equal(l1.payments_made, 23);
  assert.equal(f["pi_cents"], "306979"); assert.equal(BigInt(String(f["pi_cents"])), 306979n); assert.equal(usd(306979n), "$3,069.79");
  assert.equal(f["value_cents"], "60500000"); assert.equal(BigInt(String(f["value_cents"])), 60500000n); assert.equal(usd(60500000n), "$605,000.00");
  assert.equal(f["value_source"], "partner_fmv"); assert.equal(f["value_as_of"], "2026-08-31"); assert.equal(f["value_confidence"], "medium");
  assert.equal(f["ltv"], "0.7295", "441,366.13 ÷ 605,000.00 at 4 dp"); assert.equal(f["remaining_term_months"], 337, "337 of 360 remaining"); assert.equal(f["days_delinquent"], 0); assert.deepEqual(f["flags"], [], "no flags");
  assert.equal(l1.ti_cents, 61250n); assert.equal(usd(61250n), "$612.50");
  // the opportunity of the day: offer_ready by the fire rule (delivered on the same pass by T5's offer.deliver → offered)
  const opp = await entity("refi_opportunities", oppOf(loan)); assert.ok(opp); assert.equal(r.opportunity_id, oppOf(loan));
  assert.equal((await events("refi.opportunity.offer_ready", loan.id)).filter((e) => e.payload["opportunity_id"] === oppOf(loan)).length, 1, "refi.opportunity.offer_ready logged for the day's opportunity");
  assert.ok(["offer_ready", "offered"].includes(String(opp["status"])), `offer_ready (offered once delivered): ${opp["status"]}`);
  const ct = opp["candidate_terms"] as Json; const m = opp["benefit_metrics"] as Json; assert.ok(ct && m, "candidate terms and benefit metrics on the row");
  assert.equal(ct["product_code"], "FRM30"); assert.equal(ct["term_months"], 360); assert.equal(ct["transaction_type"], "limited_cash_out");
  // THE ENGINE'S CANDIDATE, NOT THE SPEC'S WORKED FIGURE: the FAKE sheet (FRM30 6.375 → 101.875 … 5.875 → 99.750) with 20.4's LLPA matrix 09.09.2026 (0.750 % at FICO 740–759 / LTV
  // 70.01–75 %) and the FAKE AZ cost schedule ($3,485.00 of third-party costs) prices loan 1's 30-year fixed candidate at 6.375 %, not 6.125 %: at 6.125 % the premium nets $557.50 and at
  // 6.250 % $2,787.50, both short of the costs; 6.375 % nets $5,017.50 and is the first rate that covers them. The rate delta is therefore 87.5 basis points, not 112.5. The engine's
  // figures are asserted here as the spec directs ("the engine's figures, asserted by 33.2-T2 from the opportunity row"); the worked example's 6.125 % / 112.5 bps must be corrected in the spec.
  assert.equal(ct["note_rate"], "0.06375", "the candidate note rate the FAKE sheet prices (6.375 %)"); assert.equal(f["candidate_rate_pct"], "6.375"); assert.equal(f["candidate_rate_pct"], pctOfRate(String(ct["note_rate"])));
  assert.equal(m["rate_delta_bps"], 87.5, "7.250 − 6.375 = 87.5 basis points"); assert.equal(f["rate_delta_bps"], m["rate_delta_bps"]); assert.ok(Number(m["rate_delta_bps"]) >= 25, "the fire rule's floor");
  assert.notEqual(ct["note_rate"], "0.06125", "the spec's worked example (6.125 %, 112.5 bps) does not reproduce on the FAKE sheet — reported, not bent");
  // the review's candidate loan amount, candidate P&I, monthly delta and NPV equal the opportunity row's to the cent (and the seven-year delta and breakeven)
  assert.equal(f["candidate_loan_amount_cents"], String(ct["loan_amount_cents"])); assert.equal(BigInt(String(f["candidate_loan_amount_cents"])), 44600000n); assert.equal(usd(44600000n), "$446,000.00");
  assert.equal(f["candidate_pi_cents"], String(ct["pi_cents"])); assert.equal(BigInt(String(f["candidate_pi_cents"])), 278246n); assert.equal(usd(278246n), "$2,782.46");
  assert.equal(f["monthly_delta_cents"], String(m["payment_delta_cents"])); assert.equal(BigInt(String(f["monthly_delta_cents"])), 306979n - 278246n); assert.equal(usd(28733n), "$287.33"); assert.equal(m["pi_delta_cents"], m["payment_delta_cents"]);
  assert.equal(f["npv_cents"], String(m["npv_cents"])); assert.ok(BigInt(String(f["npv_cents"])) > 0n, "a positive 84-month NPV"); assert.equal(m["holding_period_months"], 84);
  assert.equal(BigInt(String(f["npv_cents"])), 1942864n, "NPV over 84 months $19,428.64 (worked example A)"); assert.equal(usd(1942864n), "$19,428.64");
  assert.equal(f["seven_year_delta_cents"], String(m["seven_year_total_cost_delta_cents"])); assert.ok(BigInt(String(f["seven_year_delta_cents"])) > 0n, "a positive seven-year total-cost delta");
  assert.equal(BigInt(String(f["seven_year_delta_cents"])), 1913940n, "seven-year total-cost delta $19,139.40 (worked example A)"); assert.equal(usd(1913940n), "$19,139.40");
  assert.equal(f["breakeven_months"], m["breakeven_months"]); assert.equal(String(m["borrower_paid_costs_cents"]), "0", "no cost to the borrower: the premium pays the third-party costs");
  const ex = opp["existing_terms"] as Json; assert.equal(ex["note_rate"], "0.07250"); assert.equal(String(ex["upb_cents"]), "44136613"); assert.equal(String(ex["pi_cents"]), "306979"); assert.equal(ex["remaining_term_months"], 337);
  assert.equal(ct["ltv"], "0.7372", "the candidate's own LTV is the candidate loan amount over the value (20.4); the review's 0.7295 is UPB over value");
  // the verdict and the fire rule's satisfied conditions as the reasons
  assert.equal(r.verdict, "candidate"); assert.deepEqual(r.reasons, ["rate_delta", "npv_positive", "seven_year_delta_positive", "prescreen", "state_rule"]); assert.deepEqual(r.reasons, [...CANDIDATE_REASONS]);
  assert.ok(String(opp["explanation_text"]).length > 0, "the engine's own explanation text");
  // 20.1's decision beside the review's: intake's fire, then the analyst's review.write (never in place of it)
  const decisions = await db.query<{ agent: string; action: string; rule_set_version: string }>(`SELECT agent, action, rule_set_version FROM agent_decisions WHERE loan_id = $1 ORDER BY created_at`, [loan.id]);
  assert.ok(decisions.some((d) => d.agent === "intake" && d.action === "refi.opportunity.fire" && d.rule_set_version === PROGRAM_RULE_SET), JSON.stringify(decisions));
  assert.ok(decisions.some((d) => d.agent === "refi-analyst" && d.action === "review.write" && d.rule_set_version === REVIEW_RULE_SET_VERSION), JSON.stringify(decisions));
});

test("33.2-T3: Given loan 9 (5.875%, current) and loan 11 (an active bankruptcy) on the same review, then loan 9's verdict is `watching` with `watch_rate_pct` 5.625 and no offer, and loan 11's verdict is `excluded` with reason `bankruptcy_active` and no opportunity beyond `suppressed`.", { skip }, async () => {
  await firstDay();
  // loan 9: 5.875 % fixed, current — the FAKE sheet's best 30-year rate that covers the costs is above it: no rate reduction, the numbers are not there today
  const loan9 = await loanOf(9); assert.equal(loanN(9).note_rate_pct, "5.875");
  const r9 = await reviewOf(loan9.id, AS_OF); const f9 = r9.facts;
  assert.equal(r9.verdict, "watching"); assert.equal(f9["watch_rate_pct"], "5.625", "the current rate minus 25 bps, floored to the 0.125 grid"); assert.equal(f9["note_rate_pct"], "5.875"); assert.equal(f9["days_delinquent"], 0);
  assert.ok(r9.reasons.length > 0 && r9.reasons.every((x) => typeof x === "string")); assert.match(r9.reasons[0]!, /^rate_delta_bps -?\d+(\.\d+)? < 25$/, "the fire rule's rate-delta miss is the first reason");
  assert.ok(Number(f9["rate_delta_bps"]) < 25, `under the floor: ${f9["rate_delta_bps"]}`);
  const opp9 = await entity("refi_opportunities", oppOf(loan9)); assert.ok(opp9); assert.equal(opp9["status"], "suppressed"); assert.deepEqual(opp9["suppression_reasons"], r9.reasons, "reasons = the engine's suppression reasons");
  assert.equal((await events("refi.opportunity.offer_ready", loan9.id)).length, 0, "no offer"); assert.equal((await events("refi.opportunity.offered", loan9.id)).length, 0); assert.equal((await events("marketing.touch.scheduled", loan9.id)).length, 0);
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM entity_current WHERE kind = 'marketing_touches' AND data->>'loan_id' = $1`, [loan9.id]))[0]!.n, "0", "no touch");
  assert.equal((await offerCards((await partyOfLoan(loan9.id)).id)).length, 0, "no OfferCard"); assert.equal((await timers("SM_REFI_OFFER_SLA_2BD", loan9.id)).length, 0, "no offer SLA clock");
  const sup9 = (await events("refi.opportunity.suppressed", loan9.id)).find((e) => e.payload["opportunity_id"] === oppOf(loan9)); assert.ok(sup9); assert.match(String(sup9.payload["reason"]), /^rate_delta_bps/);
  // loan 11: an active Chapter 13 bankruptcy — excluded before pricing; the engine writes only a suppressed opportunity
  const loan11 = await loanOf(11); const f11 = (await latestFacts(loan11.id)).facts; assert.equal(f11["bk_status"], true); assert.equal(String(f11["bk_chapter"]), "13"); assert.equal(f11["mba_delinquency_status"], "BK");
  const r11 = await reviewOf(loan11.id, AS_OF);
  assert.equal(r11.verdict, "excluded"); assert.deepEqual(r11.reasons, ["bankruptcy_active"]); assert.ok((r11.facts["flags"] as string[]).includes("bankruptcy_active"));
  assert.equal(r11.facts["candidate_rate_pct"], null, "never priced"); assert.equal(r11.facts["npv_cents"], null); assert.equal(r11.facts["watch_rate_pct"], undefined, "no watch rate for an excluded loan");
  const row11 = await entity("refi_universe", loan11.id); assert.ok(row11); assert.equal(row11["bankruptcy_active"], true); assert.equal(row11["foreclosure_referred"], false);
  const opp11 = await entity("refi_opportunities", oppOf(loan11)); assert.ok(opp11, "one opportunity row, suppressed");
  assert.equal(opp11["status"], "suppressed"); assert.deepEqual(opp11["suppression_reasons"], ["bankruptcy_active"]); assert.equal(opp11["candidate_terms"], null); assert.equal(opp11["benefit_metrics"], null);
  const opps11 = await db.query<{ id: string; status: string }>(`SELECT id, data->>'status' AS status FROM entity_current WHERE kind = 'refi_opportunities' AND data->>'loan_id' = $1`, [loan11.id]);
  assert.deepEqual(opps11, [{ id: oppOf(loan11), status: "suppressed" }], "no opportunity beyond suppressed");
  assert.equal((await events("refi.opportunity.offer_ready", loan11.id)).length, 0); assert.equal((await events("refi.opportunity.suppressed", loan11.id))[0]!.payload["reason"], "bankruptcy_active");
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM agent_decisions WHERE loan_id = $1 AND agent = 'intake' AND action = 'refi.opportunity.fire'`, [loan11.id]))[0]!.n, "0", "no fire decision");
  // the same review: both rows under the day's run
  assert.equal(r9.run_id, r11.run_id); assert.equal(r9.as_of_date, AS_OF); assert.equal(r11.as_of_date, AS_OF);
});

test("33.2-T4: Given the analyst's scripted turn for loan 1, then `review.facts` answered with tokens and no raw figure, `review.write` stored a rationale whose only figures are tokens and the flags the scene set, an `agent_turns` row exists for the turn with `model_version` and `prompt_version`, and `agent_decisions` carries the analyst's decision; given a scripted rationale with a digit outside a token, then the guard refuses it, one regeneration runs, and on a second violation the review is written with `analyst.skipped = provenance` and the engine's explanation text.", { skip }, async () => {
  await firstDay();
  const loan = await loanOf(1); const party = await partyOfLoan(loan.id); const r = await reviewOf(loan.id, AS_OF);
  // the scripted turn for loan 1: review_facts answered with tokens and no raw figure
  const turn1 = analystScripted.turns.find((t) => /verdict is candidate/.test(t.borrower) && new RegExp(`loan ${loan.id}`).test(t.borrower)); assert.ok(turn1, "the analyst's turn for loan 1 reached the model"); assert.equal(turn1.scene, ANALYST_CANDIDATE);
  assert.match(turn1.borrower, /^\[review\]/); NO_FIGURE(turn1.borrower.replace(loan.id, "").replace(AS_OF, ""), "the analyst's user message (no figure beyond the loan id and the date)");
  assert.deepEqual(turn1.calls.map((c) => c.name), ["review.facts", "review.write"], "at most two tool calls: review_facts then review_write");
  const factsResult = turn1.results.find((x) => x.name === "review.facts"); assert.ok(factsResult, "review_facts answered"); assert.equal(factsResult.is_error, false);
  const facts = factsResult.content as Json;
  assert.equal(facts["verdict"], "candidate");
  const tokens = facts["facts"] as Record<string, string>;
  for (const [k, v] of Object.entries(tokens)) assert.equal(v, `{{facts.${k}}}`, `${k} is a token`);
  for (const k of ["rate_now", "candidate_rate", "rate_delta", "upb", "value", "ltv", "payment_now", "candidate_payment", "monthly_delta", "npv", "seven_year_delta", "days_delinquent"]) assert.ok(k in tokens, `token ${k}`);
  assert.ok(!("watch_rate" in tokens), "no watch rate for a candidate");
  onlyTokens(String(facts["text"]), "review_facts text"); onlyTokens(String(facts["verdict_text"]), "the verdict in words"); for (const s of facts["reasons_text"] as string[]) onlyTokens(s, "a reason in words");
  for (const raw of ["7.250", "6.375", "441,366", "605,000", "3,069", "87.5", "0.7295"]) assert.equal(JSON.stringify(facts).includes(raw), false, `no raw figure ${raw} in the tool result`);
  // review_write stored the rationale (only tokens as figures) and the flags the scene set
  const writeResult = turn1.results.find((x) => x.name === "review.write"); assert.ok(writeResult); assert.equal(writeResult.is_error, false); assert.equal(turn1.regenerated, false, "a clean rationale needs no regeneration");
  const analyst = r.analyst;
  assert.equal(analyst["rationale"], CLEAN_RATIONALE); onlyTokens(String(analyst["rationale"]), "the stored rationale"); assert.match(String(analyst["rationale"]), /\{\{facts\.rate_now\}\}/);
  assert.deepEqual(analyst["flags"], CANDIDATE_FLAGS, "the flags the scene set"); assert.equal(analyst["confidence"], 1); assert.equal(analyst["model_version"], "scripted"); assert.equal(analyst["prompt_version"], ANALYST_PROMPT_VERSION); assert.equal(ANALYST_PROMPT_VERSION, "33.2-p1");
  assert.equal(analyst["skipped"], undefined);
  // an agent_turns row for the turn with model_version and prompt_version, under ai_systems{refi-analyst}
  type TurnRow = { turn_id: string; channel: string; party_id: string; conversation_id: string; model_version: string; prompt_version: string; tier: string; tool_calls: Json[]; guard_result: Json; system_code: string | null; version: string | null; tokens_in: number; tokens_out: number };
  const turnsOf = (partyId: string) => db.query<TurnRow>(`SELECT t.turn_id::text AS turn_id, t.channel, t.party_id::text AS party_id, t.conversation_id::text AS conversation_id, t.model_version, t.prompt_version, t.tier, t.tool_calls, t.guard_result, v.system_code, v.version, t.tokens_in, t.tokens_out FROM agent_turns t LEFT JOIN ai_system_versions v ON v.id = t.ai_system_version_id WHERE t.channel = 'analyst' AND t.party_id = $1 ORDER BY t.created_at`, [partyId]);
  const turns1 = await turnsOf(party.id); assert.equal(turns1.length, 1, "one analyst turn for loan 1's party on the day"); const t1 = turns1[0]!;
  assert.equal(t1.turn_id, analyst["turn_id"], "the review row's turn_id joins agent_turns"); assert.equal(t1.model_version, "scripted"); assert.equal(t1.prompt_version, "33.2-p1"); assert.equal(t1.tier, "T3_internal");
  assert.equal(t1.system_code, "refi-analyst"); assert.equal(t1.version, "33.2-p1@scripted");
  assert.deepEqual(t1.tool_calls.map((c) => [c["name"], c["is_error"]]), [["review.facts", false], ["review.write", false]]); assert.ok(t1.tool_calls.every((c) => typeof c["args_hash"] === "string" && !("args" in c)), "the args hash, never the args");
  assert.equal(t1.guard_result["ok"], true); assert.equal(t1.guard_result["regenerated"], false); assert.equal(t1.guard_result["verdict"], "candidate");
  const conv = await db.query<{ party_id: string }>(`SELECT party_id::text AS party_id FROM conversations WHERE conversation_id = $1`, [t1.conversation_id]); assert.equal(conv[0]?.party_id, party.id, "the party's conversation");
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ai_systems WHERE code = 'refi-analyst' AND kind = 'agent'`))[0]!.n, "1");
  // agent_decisions carries the analyst's decision: review.write by refi-analyst with the turn's model and prompt, the id the review row carries
  const d1 = (await db.query<{ id: string; agent: string; action: string; rule_set_version: string; model_version: string; prompt_version: string; confidence: string; rationale: string; subject_kind: string; subject_id: string }>(`SELECT id::text AS id, agent, action, rule_set_version, model_version, prompt_version, confidence::text AS confidence, rationale, subject_kind, subject_id FROM agent_decisions WHERE id = $1`, [r.decision_id]))[0];
  assert.ok(d1, "the decision the review row names"); assert.equal(d1.agent, "refi-analyst"); assert.equal(d1.action, "review.write"); assert.equal(d1.rule_set_version, "sm.refi_trigger.v1+partner_book.review.v1"); assert.equal(d1.model_version, "scripted"); assert.equal(d1.prompt_version, "33.2-p1"); assert.equal(d1.confidence, "1.0000");
  assert.equal(d1.subject_kind, "partner_book_review"); assert.equal(d1.subject_id, r.id); assert.ok(d1.rationale.includes("verdict candidate") && d1.rationale.includes(CLEAN_RATIONALE) && d1.rationale.includes(CANDIDATE_FLAGS[0]!), d1.rationale);
  // a scripted rationale with a digit outside a token (loan 9, watching): the guard refuses it, one regeneration runs, the second violation → analyst.skipped = provenance and the engine's explanation text
  const loan9 = await loanOf(9); const party9 = await partyOfLoan(loan9.id); const r9 = await reviewOf(loan9.id, AS_OF);
  const turn9 = analystScripted.turns.find((t) => new RegExp(`loan ${loan9.id}`).test(t.borrower)); assert.ok(turn9); assert.equal(turn9.scene, ANALYST_WATCHING); assert.equal(turn9.regenerated, true, "one regeneration ran");
  assert.notEqual(provenanceViolation(WATCHING_DIGIT), null, "the first rationale carries a raw figure"); assert.notEqual(provenanceViolation(WATCHING_SPELLED), null, "the regeneration spells the amount out");
  const guardRequest = analystScripted.requests.find((q) => { const c = q.messages.at(-1)?.content; return typeof c === "string" && c.startsWith("[guard]") && /loan/.test(String(q.messages[0]?.content)) && String(q.messages[0]?.content).includes(loan9.id); });
  assert.ok(guardRequest, "the [guard] correction went back to the model"); assert.match(String(guardRequest.messages.at(-1)!.content), /raw figure/);
  assert.equal(r9.analyst["skipped"], "provenance"); assert.equal(r9.analyst["rationale"], undefined, "no rationale of the analyst stands");
  assert.equal(r9.analyst["explanation_text"], `watching: ${r9.reasons.join(", ")}`, "the engine's own explanation stands in");
  const turns9 = await turnsOf(party9.id); assert.equal(turns9.length, 1, "the turn is still logged"); const t9 = turns9[0]!;
  assert.equal(r9.analyst["turn_id"], t9.turn_id, "the skipped review still names the agent_turns row the model ran (the cap and the receipt count it)");
  assert.equal(t9.guard_result["ok"], false); assert.equal(t9.guard_result["rejected_by"], "provenance"); assert.equal(t9.guard_result["regenerated"], true); assert.equal(t9.guard_result["attempts"], 2); assert.equal(t9.guard_result["skipped"], "provenance");
  assert.match(String((t9.guard_result["checks"] as Json)["provenance"] && ((t9.guard_result["checks"] as Json)["provenance"] as Json)["detail"]), /raw figure.*then/);
  const d9 = (await db.query<{ model_version: string; prompt_version: string; rationale: string }>(`SELECT model_version, prompt_version, rationale FROM agent_decisions WHERE id = $1`, [r9.decision_id]))[0]!;
  assert.equal(d9.model_version, "engine (deterministic)"); assert.equal(d9.prompt_version, "33.2-v1"); assert.match(d9.rationale, /analyst skipped: provenance/);
  assert.ok(!d9.rationale.includes("5.875%"), "the refused rationale is nowhere on the record");
  // the same one regeneration, coming back clean (loan 11, excluded): written with the regenerated rationale and the first call's flags
  const loan11 = await loanOf(11); const r11 = await reviewOf(loan11.id, AS_OF);
  const turn11 = analystScripted.turns.find((t) => new RegExp(`loan ${loan11.id}`).test(t.borrower)); assert.ok(turn11); assert.equal(turn11.scene, ANALYST_EXCLUDED); assert.equal(turn11.regenerated, true);
  assert.equal(r11.analyst["rationale"], EXCLUDED_CLEAN); onlyTokens(String(r11.analyst["rationale"]), "the regenerated rationale"); assert.deepEqual(r11.analyst["flags"], EXCLUDED_FLAGS); assert.equal(r11.analyst["confidence"], 0.75, "a regenerated rationale carries less confidence");
  const t11 = (await turnsOf((await partyOfLoan(loan11.id)).id))[0]!; assert.equal(t11.guard_result["ok"], true); assert.equal(t11.guard_result["regenerated"], true); assert.equal(t11.guard_result["attempts"], 2);
  // every review of the day: a turn or a skip, never an unreviewed loan; the receipt counts them
  const rows = await reviewsOf(AS_OF); const skipped = rows.filter((x) => typeof x.analyst["skipped"] === "string"); const written = rows.filter((x) => typeof x.analyst["rationale"] === "string");
  assert.equal(skipped.length + written.length, 13); assert.ok(skipped.every((x) => x.analyst["skipped"] === "provenance"), JSON.stringify(skipped.map((x) => x.analyst)));
  const watching = rows.filter((x) => x.verdict === "watching").length; assert.equal(watching, 7);
  assert.equal(skipped.length, watching, "the watching scene's second violation on every watching loan"); assert.equal(written.length, 13 - watching, "the three candidates and the three excluded");
  const receipt = (await events("partner_book.review.run_completed")).find((e) => e.payload["as_of_date"] === AS_OF)!.payload;
  assert.equal(receipt["analyst_turns"], 13, "every model turn counted, the provenance skips included (rule 4: the cap bounds model spend)"); assert.equal(receipt["analyst_skipped"], watching); assert.deepEqual(receipt["analyst_skipped_by_reason"], { provenance: watching });
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM agent_turns WHERE channel = 'analyst'`))[0]!.n, "13", "every turn the model took is on agent_turns");
});

test("33.2-T5: Given loan 1's `offer_ready` opportunity and a party with an e-mail, when `offer.deliver` runs, then the partner's campaign and creative exist and are approved, a 20.2 touch was scheduled and sent by e-mail (the FAKE delivery holds the offer message), `marketing.touch.sent` and `refi.opportunity.offered` are logged, `SM_REFI_OFFER_SLA_2BD` is satisfied, and the OfferCard is on the homeowner's rail with the record's rate-watch block reading `offer_open`; given a party with no e-mail, then only the portal channel is used and nothing is sent.", { skip }, async () => {
  const { sweep } = await firstDay();
  const loan = await loanOf(1); const party = await partyOfLoan(loan.id); const oppId = oppOf(loan); const l1 = loanN(1);
  assert.equal(party.contact["email"], l1.email, "a party with an e-mail");
  const pr = sweep.partner_book_review.programs.find((p) => p.program_id === programId())!;
  assert.equal(pr.offers.delivered, 2, "loans 1 and 2 by e-mail"); assert.equal(pr.offers.portal_only, 1, "loan 13 by the portal only");
  // the partner's campaign and creative exist and are approved (once per program, by the FAKE officer outside production)
  const camp = await entity("marketing_campaigns", campaignIdFor(partnerPartyId)); assert.ok(camp, "the program's campaign");
  assert.equal(camp["status"], "live"); assert.equal(camp["program_id"], programId()); assert.equal(camp["partner_id"], partnerPartyId); assert.equal(camp["kind"], "refi_trigger_outbound"); assert.equal(camp["approved_by"], "human:FAKE:officer"); assert.ok(camp["approved_at"]);
  const cr = await entity("marketing_creatives", creativeIdFor(partnerPartyId)); assert.ok(cr, "the program's e-mail creative");
  assert.equal(cr["status"], "approved"); assert.equal(cr["approved_by"], "human:FAKE:officer"); assert.equal(cr["campaign_id"], campaignIdFor(partnerPartyId)); assert.equal(cr["channel"], "email"); assert.equal(cr["rate_sheet_id"], `rs-${AS_OF}-FAKE`);
  const text = String(cr["rendered_text"]); assert.ok(text.includes(DEMO_PARTNER.legal_name) && text.includes(`NMLSR ID ${DEMO_PARTNER.nmlsr_id}`) && /advertisement/i.test(text) && /unsubscribe/i.test(text) && /not a commitment to lend/i.test(text), text);
  assert.ok(camp["started_at"], "launched (20.2 keeps the approvals on the rows: approved_by, approved_at, started_at)"); assert.equal(camp["selection_rule_set"], PROGRAM_RULE_SET);
  // a 20.2 touch scheduled and sent by e-mail: the FAKE delivery holds the offer message
  const touchId = touchIdFor(oppId, "email"); const touch = await entity("marketing_touches", touchId); assert.ok(touch, "the e-mail touch");
  assert.equal(touch["channel"], "email"); assert.equal(touch["outcome"], "sent"); assert.equal(touch["party_id"], party.id); assert.equal(touch["loan_id"], loan.id); assert.equal(touch["opportunity_id"], oppId); assert.equal(touch["destination"], l1.email); assert.equal(touch["campaign_id"], campaignIdFor(partnerPartyId));
  const gates = touch["gates"] as { code: string; result: string }[]; assert.ok(gates.some((g) => g.code === "SM_CAMPAIGN_CREATIVE_APPROVAL_GATE" && g.result === "pass") && gates.some((g) => g.code === "SM_LICENSE_STATE_GATE" && g.result === "pass"), JSON.stringify(gates));
  assert.ok(gates.every((g) => g.result === "pass" || g.result === "not_applicable"), "every 20.2 gate passed or did not apply (e-mail: no TCPA gate)");
  const scheduled = (await events("marketing.touch.scheduled", loan.id)).filter((e) => e.payload["touch_id"] === touchId); assert.equal(scheduled.length, 1);
  const sent = (await events("marketing.touch.sent", loan.id)).filter((e) => e.payload["touch_id"] === touchId); assert.equal(sent.length, 1, "marketing.touch.sent logged");
  assert.equal(sent[0]!.payload["opportunity_id"], oppId); assert.equal(sent[0]!.payload["channel"], "email"); assert.equal(sent[0]!.payload["party_id"], party.id); assert.equal(sent[0]!.payload["origination"], true); assert.equal(typeof sent[0]!.payload["notice_id"], "string");
  const noticeId = String(sent[0]!.payload["notice_id"]); const notice = runtime.noticeMemory.get(noticeId); assert.ok(notice, "the offer notice");
  assert.equal(notice.templateCode, "NTC_REGZ_1026_24_REFI_OFFER"); assert.equal(notice.status, "sent"); assert.equal(notice.loanId, loan.id);
  const offerText = String((notice.rendered as { text?: string }).text ?? "");
  assert.ok(offerText.includes("7.250%") && offerText.includes("6.375%") && offerText.includes("$2,782.46") && /annual percentage rate/i.test(offerText) && offerText.includes(`ending in ${l1.servicer_loan_number.slice(-4)}`) && /not a commitment to lend/i.test(offerText), offerText);
  const held = [...edelivery().messages.values()].filter((m) => m.message.noticeId === noticeId);
  assert.equal(held.length, 1, "the FAKE delivery holds the offer message"); assert.equal(held[0]!.status, "sent"); assert.equal(held[0]!.message.channel, "email"); assert.equal(held[0]!.message.to, l1.email); assert.equal(held[0]!.message.consentId, "policy:electronic_ok_without_esign");
  assert.ok(![...edelivery().messages.values()].some((m) => m.message.channel === "sms"), "never a text from this pass");
  // refi.opportunity.offered logged (20.1's recordOffered on the touch), SM_REFI_OFFER_SLA_2BD satisfied, the 30-day expiry armed
  const offered = (await events("refi.opportunity.offered", loan.id)).filter((e) => e.payload["opportunity_id"] === oppId); assert.equal(offered.length, 1, "refi.opportunity.offered logged");
  assert.equal(offered[0]!.payload["offered_at"], NOW); assert.equal(offered[0]!.payload["campaign_id"], campaignIdFor(partnerPartyId));
  const opp = await entity("refi_opportunities", oppId); assert.ok(opp); assert.equal(opp["status"], "offered"); assert.equal(opp["campaign_id"], campaignIdFor(partnerPartyId)); assert.equal(opp["offer_valid_until"], "2026-10-15", "+30 days");
  const sla = await timers("SM_REFI_OFFER_SLA_2BD", loan.id); assert.equal(sla.length, 1); assert.equal(sla[0]!.status, "satisfied", "the 2-BD offer SLA is satisfied by the offer"); assert.ok(sla[0]!.satisfied_at);
  const expiry = await timers("SM_REFI_OPPORTUNITY_EXPIRY_30", loan.id); assert.equal(expiry.length, 1); assert.equal(expiry[0]!.status, "armed"); assert.equal(expiry[0]!.anchor_date, AS_OF);
  // the OfferCard on the homeowner's rail (32.11: offer_ready → the FAKE MLO's terms review → presented; placed once the opportunity is `offered`) and the record's rate-watch block reading offer_open
  const cards = await offerCards(party.id); assert.equal(cards.length, 1, "one OfferCard on the rail"); const card = cards[0]!;
  assert.equal(card.status, "pending"); assert.equal(card.copy_key, "offer.card"); assert.equal(card.props["flow_key"], `offer:${oppId}`); assert.equal(card.props["current_rate"], "7.250"); assert.equal(card.props["offered_rate"], "6.375"); assert.equal(card.command_ref, "offer.respond");
  assert.equal((await events("terms.presented", loan.id)).filter((e) => e.payload["quote_id"] === `Q-OFFER-${oppId}`).length, 1, "the FAKE MLO presented the offer's terms");
  const rec = await record(loan); const rw = (rec.loan as Json)["ratewatch"] as Json;
  assert.equal(rw["state"], "offer_open"); assert.equal(rw["state_copy_key"], "ratewatch.offer_open"); assert.equal(rw["offer_card_instance_id"], card.card_instance_id); assert.equal(rw["current_rate"], "7.250"); assert.equal(rw["rate_sheet_id"], `rs-${AS_OF}-FAKE`);
  assert.equal(rec.offers.length, 1); const offer = rec.offers[0] as unknown as Json; assert.equal(offer["refi_opportunity_id"], oppId); assert.equal(offer["status"], "offered"); assert.equal(offer["offered_at"], NOW); assert.equal(offer["expires_at"], "2026-10-15");
  const terms = offer["terms"] as Json; assert.equal(terms["current_rate"], "7.250"); assert.equal(terms["offered_rate"], "6.375"); assert.equal(String(terms["new_pi_payment_cents"]), "278246"); assert.equal(String(terms["monthly_savings_cents"]), "28733"); assert.equal(String(terms["costs_to_borrower_cents"]), "0");
  assert.equal(rec.partner_book?.review?.outcome, "candidate"); assert.equal(rec.partner_book?.review?.offer_card_instance_id, card.card_instance_id);
  // a party with no e-mail (loan 13): only the portal channel is used and nothing is sent — no notice, no message; the card is the delivery
  const loan13 = await loanByNumber(PORTAL_LOAN_NUMBER); const party13 = await partyOfLoan(loan13.id); const opp13 = oppOf(loan13);
  assert.equal(party13.contact["email"], undefined); assert.equal(party13.contact["phone"], undefined); assert.equal(party13.legal_name, "Nora Portal");
  assert.equal((await reviewOf(loan13.id, AS_OF)).verdict, "candidate");
  assert.equal(await entity("marketing_touches", touchIdFor(opp13, "email")), null, "no e-mail touch");
  const portal = await entity("marketing_touches", touchIdFor(opp13, "portal")); assert.ok(portal, "the portal touch"); assert.equal(portal["channel"], "portal"); assert.equal(portal["outcome"], "sent"); assert.equal(portal["notice_id"] ?? null, null, "no notice on the portal touch (20.2's touch row names none; the sent event carries notice_id null)");
  const sent13 = (await events("marketing.touch.sent", loan13.id)); assert.equal(sent13.length, 1); assert.equal(sent13[0]!.payload["channel"], "portal"); assert.equal(sent13[0]!.payload["notice_id"], null);
  assert.equal((await events("refi.opportunity.offered", loan13.id)).length, 1); assert.equal((await entity("refi_opportunities", opp13))?.["status"], "offered");
  assert.equal((await timers("SM_REFI_OFFER_SLA_2BD", loan13.id))[0]?.status, "satisfied");
  assert.ok(![...runtime.noticeMemory.values()].some((n) => n.loanId === loan13.id && n.templateCode === "NTC_REGZ_1026_24_REFI_OFFER"), "nothing rendered for the portal-only homeowner");
  assert.equal([...runtime.noticeMemory.values()].filter((n) => n.templateCode === "NTC_REGZ_1026_24_REFI_OFFER").length, 2, "two offer notices on the day: loans 1's and 2's (the e-mail candidates)");
  assert.equal((await events("notice.sent", loan13.id)).length, 0, "nothing sent"); assert.equal((await events("notice.rendered", loan13.id)).length, 0);
  assert.ok(![...edelivery().messages.values()].some((m) => String(m.message.to).includes("portal") || m.message.to === ""), "no message to a party without a destination");
  const cards13 = await offerCards(party13.id); assert.equal(cards13.length, 1); assert.equal(cards13[0]!.status, "pending"); assert.equal(cards13[0]!.props["flow_key"], `offer:${opp13}`);
  assert.equal(((await record(loan13)).loan as Json)["ratewatch"] && (((await record(loan13)).loan as Json)["ratewatch"] as Json)["state"], "offer_open");
});

test("33.2 rule 5: without an officer — production, or the FAKE reviewers off — the partner's campaign and creative wait for a person and nothing is offered", { skip }, async () => {
  await firstDay();
  // the FAKE officer never approves in production, nor when the FAKE reviewers are off (fakeReviewersFromEnv's rule)
  assert.equal(fakeOfficerFromEnv({ ENVIRONMENT: "production" }), null); assert.equal(fakeOfficerFromEnv({ ENVIRONMENT: "production", INTEGRATIONS: "fake" }), null); assert.equal(fakeOfficerFromEnv({ ENVIRONMENT: "Production", FAKE_REVIEWERS: "on" }), null);
  assert.equal(fakeOfficerFromEnv({ ENVIRONMENT: "test", FAKE_REVIEWERS: "off" }), null); assert.equal(fakeOfficerFromEnv({ INTEGRATIONS: "real" }), null); assert.deepEqual(fakeOfficerFromEnv({ ENVIRONMENT: "test" }), FAKE_OFFICER); assert.deepEqual(fakeOfficerFromEnv({}), FAKE_OFFICER);
  // a second partner's program (a synthetic program row, never stored): the pass creates the campaign and the creative and stops at the officer's approval — the creative stays unapproved, the campaign draft
  const other = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id, contact) VALUES ('servicer', 'Southlight Servicing (FAKE partner)', '300099999', '1000999', '{"nmlsr_id": "7654321", "postal_address": "2 Example Way, Anytown, AZ 85000"}'::jsonb) RETURNING id`))[0]!.id;
  const store = new EntityStore(); store.seed(await runtime.entities.load({}));
  const program = store.list("partner_programs").map((r) => r.data as unknown as PartnerProgram).find((p) => p.program_id === programId()); assert.ok(program);
  const partner = await partnerFacts(db, store, other, false); assert.ok(partner); assert.equal(partner.nmlsr_id, "7654321"); assert.equal(partner.postal_address_fake, false);
  const sheet = sheetRatesPct(store.list("rate_sheets").map((r) => r.data as unknown as RateSheet), clock.now()); assert.equal(sheet.rate_sheet_id, `rs-${AS_OF}-FAKE`);
  const blocked = await ensureCampaign(runtime, store, { ...program, partner_id: other, program_id: "prog-refi-other" }, partner, sheet, null, { ENVIRONMENT: "production" });
  assert.ok("blocked" in blocked, JSON.stringify(blocked)); assert.match(blocked.blocked, /awaits the partner officer's approval/);
  const cr = await entity("marketing_creatives", creativeIdFor(other)); assert.ok(cr, "the creative rendered"); assert.notEqual(cr["status"], "approved"); assert.equal(cr["approved_by"] ?? null, null, "no FAKE approval");
  const camp = await entity("marketing_campaigns", campaignIdFor(other)); assert.ok(camp); assert.equal(camp["status"], "draft"); assert.equal(camp["approved_by"] ?? null, null);
  assert.equal((await ensureCampaign(runtime, store, { ...program, partner_id: other, program_id: "prog-refi-other" }, partner, sheet, null, { ENVIRONMENT: "production" }) as { blocked: string }).blocked, blocked.blocked, "the same block on the next pass: nothing else is created");
  // offer.deliver with no officer delivers nothing new: the day's offers went out under the FAKE officer once (T5); with none, every undelivered opportunity waits and no e-mail leaves
  const notices = [...runtime.noticeMemory.values()].filter((n) => n.templateCode === "NTC_REGZ_1026_24_REFI_OFFER").length;
  const r = await deliverOffers(runtime, clock.now(), { officer: null, as_of_date: plainDate(AS_OF) });
  assert.equal(r.delivered, 0); assert.equal(r.portal_only, 0); assert.ok(r.skipped.every((x) => /awaits the partner officer's approval|open_offer:/.test(x.reason)), JSON.stringify(r.skipped));
  assert.equal([...runtime.noticeMemory.values()].filter((n) => n.templateCode === "NTC_REGZ_1026_24_REFI_OFFER").length, notices, "no offer notice rendered without an officer");
});

test("33.2-T6: Given an offered opportunity 30 days old with no answer, when the sweep passes, then `offer.expire` runs `refi.opportunity.expired`, the OfferCard is cancelled, and the next review reads the loan under the cooldown gate.", { skip }, async () => {
  await firstDay();
  const loan = await loanOf(1); const party = await partyOfLoan(loan.id); const oppId = oppOf(loan);
  assert.equal((await entity("refi_opportunities", oppId))?.["status"], "offered"); assert.equal((await entity("refi_opportunities", oppId))?.["offer_valid_until"], "2026-10-15");
  const cardBefore = (await offerCards(party.id)).find((c) => c.props["flow_key"] === `offer:${oppId}`); assert.ok(cardBefore); assert.equal(cardBefore.status, "pending", "no answer on the card");
  // the partner's next monthly tape arrives as of 2026-10-01 (the loans one payment further along); the day-1 review clock is still armed for 09-16 — nothing swept in between
  const later = await importPartnerBook(runtime, { partner: DEMO_PARTNER, as_of_date: "2026-10-01", profile: "m3-v1", tape: { filename: "partner-book-2026-10.xlsx", content: nextMonthTape() }, supplement: { filename: "partner-book-demo-supplement.csv", content: bytes(book.supplement) } }, { kind: "human", id: "u-ops-analyst", role: "ops_analyst" });
  assert.equal(later.status, "loaded", JSON.stringify(later.report).slice(0, 600)); assert.equal(later.rows_loaded, 13); assert.equal(later.loans_updated, 13);
  assert.equal((await latestFacts(loan.id)).facts["next_due_date"], "2026-11-01"); assert.equal((await latestFacts(loan.id)).facts["upb_cents"], scheduledUpb(loanN(1).original_cents, "7.250", 360, 24).toString());
  assert.equal((await timers("SM_PARTNER_BOOK_REVIEW_DAILY"))[0]!.status, "armed");
  // day 31: 30 days old with no answer
  clock.set(NOW_31);
  const sweep = await runtime.sweep(); await settle();
  const pr = sweep.partner_book_review.programs.find((p) => p.program_id === programId()); assert.ok(pr, sweep.partner_book_review.line); assert.equal(pr.error, null);
  assert.ok(pr.expired >= 1, `offer.expire ran on the pass: ${sweep.partner_book_review.line}`);
  const expired = (await events("refi.opportunity.expired", loan.id)).filter((e) => e.payload["opportunity_id"] === oppId);
  assert.equal(expired.length, 1, "refi.opportunity.expired logged"); assert.equal(expired[0]!.payload["expired_at"], NOW_31); assert.equal(expired[0]!.payload["offer_valid_until"], "2026-10-15");
  assert.equal((await entity("refi_opportunities", oppId))?.["status"], "expired");
  const expiryClock = (await timers("SM_REFI_OPPORTUNITY_EXPIRY_30", loan.id)).find((t) => t.anchor_date === AS_OF); assert.ok(expiryClock); assert.notEqual(expiryClock.status, "armed", "the 30-day clock is closed");
  // 32.11 closes the card: cancelled on the rail (status expired, the expiry as evidence)
  const cardAfter = (await ui().cardsOf(party.id)).find((c) => c.card_instance_id === cardBefore.card_instance_id); assert.ok(cardAfter);
  assert.equal(cardAfter.status, "expired"); assert.equal((cardAfter.evidence as Json)["expired_at"], NOW_31); assert.match(String((cardAfter.evidence as Json)["resolved_by"]), /32\.11/);
  assert.equal((await events("refi.opportunity.expired", loan.id)).length, 1, "only the offer of 09-15 expired: no borrower-request opportunity was ever opened on the monitored loan");
  // the next review reads the loan afresh under 20.1's cooldown and frequency-cap gates: a new opportunity of the day, its gates evaluated (no decline → the cooldown is open; one offer in 12 months → the cap is open), the review written
  const next = await reviewOf(loan.id, AS_OF_31); assert.equal(next.run_id, reviewRunIdFor(plainDate(AS_OF_31), programId())); assert.equal(next.opportunity_id, oppOf(loan, AS_OF_31)); assert.notEqual(next.opportunity_id, oppId);
  const opp31 = await entity("refi_opportunities", oppOf(loan, AS_OF_31)); assert.ok(opp31, "the day's opportunity");
  const gates = opp31["gates"] as { code: string; status: string; reason: string | null }[]; assert.ok(Array.isArray(gates) && gates.length > 0, "the solicitation gates on the row");
  const cooldown = gates.find((g) => g.code === "SM_REFI_RESOLICIT_COOLDOWN_90"); assert.ok(cooldown, "read under the cooldown gate"); assert.equal(cooldown.status, "open", "no decline: the cooldown is open (an expiry is not a decline)");
  const cap = gates.find((g) => g.code === "SM_REFI_OFFER_FREQUENCY_CAP"); assert.ok(cap, "read under the frequency cap"); assert.equal(cap.status, "open", "one offer in the last 12 months, two allowed");
  const facts = await entity("refi_gate_facts", loan.id); assert.ok(facts); const offeredAt = facts["offered_at"] as string[]; assert.equal(facts["declined_on"], null, "an expiry is not a decline");
  assert.ok(offeredAt.some((x) => x.startsWith(AS_OF)), "the offer of 09-15 on the gate facts the run read"); assert.equal(offeredAt.length, 2, "…and the day's own offer once the pass delivered it (the cap counts two per 12 months)"); assert.ok(offeredAt.some((x) => x.startsWith(AS_OF_31)));
  assert.equal(opp31["status"], "offered", "the engine fired again and offer.deliver sent it: the loan is not under a closed gate after one expired offer");
  assert.equal(next.facts["days_delinquent"], 0, "current on the new tape"); assert.equal(next.facts["upb_cents"], (await latestFacts(loan.id)).facts["upb_cents"], "the review reads the re-uploaded facts");
  assert.equal(next.verdict, "candidate", "the gates are open and the sheet still prices the candidate: the engine fires again");
  assert.equal((await reviewsOf(AS_OF_31)).length, 13, "the whole book reviewed again");
  // T1's clock: the receipt of 10-16 satisfies the instance armed on 09-15 and re-arms it for the next day 07:00 ET (recurring)
  const clocks = await timers("SM_PARTNER_BOOK_REVIEW_DAILY"); assert.equal(clocks.length, 2, JSON.stringify(clocks));
  assert.equal(clocks[0]!.anchor_date, AS_OF); assert.equal(clocks[0]!.status, "satisfied"); assert.ok(clocks[0]!.satisfied_at);
  assert.equal(clocks[1]!.anchor_date, AS_OF_31); assert.equal(clocks[1]!.status, "armed"); assert.equal(new Date(clocks[1]!.due_at!).toISOString(), "2026-10-17T11:00:00.000Z");
  assert.equal((await events("partner_book.review.run_completed")).filter((e) => e.payload["as_of_date"] === AS_OF_31).length, 1);
  await runtime.sweep(); await settle();   // the FAKE MLO's review of the new offer's terms (32.11) — the rail is whole again for T7
});

test("33.2-T7: Given the homeowner of loan 1 signed in, when they ask whether refinancing makes sense, then the turn's situation carries `partner_book.review{verdict=candidate}` and the reply points at the offer card in words with no figure outside a token; given the homeowner of loan 9, then the reply says the rate is not there yet and that the book is checked every morning, with no rate.", { skip }, async () => {
  await firstDay();
  const loan = await loanOf(1); const l1 = loanN(1); const party = await partyOfLoan(loan.id);
  const latest = (await db.query<{ verdict: string; as_of_date: string }>(`SELECT verdict, as_of_date::text AS as_of_date FROM partner_book_reviews WHERE loan_id = $1 ORDER BY as_of_date DESC, created_at DESC LIMIT 1`, [loan.id]))[0]!;
  assert.equal(latest.verdict, "candidate", `the latest review of loan 1 (${latest.as_of_date})`);
  const ask = async (email: string, ip: string, partyId: string, loanId: string): Promise<{ reply: string; situation: ReturnType<typeof parseSituation>; turn: (typeof scripted.turns)[number] }> => {
    const req = await api("POST", "/v1/borrower/auth/otp", { action: "request", channel: "email", destination: email }, {}, ip);
    assert.equal(req.status, 200, JSON.stringify(req.body)); assert.equal(req.body["delivery"], "FAKE");
    const v = await api("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: req.body["challenge_id"], code: req.body["fake_code"] }, {}, ip);
    assert.equal(v.status, 200, JSON.stringify(v.body)); assert.equal((v.body["party"] as Json)["party_id"], partyId, "signed in on the loan's party"); await settle();
    const before = scripted.requests.length; const turnsBefore = scripted.turns.length;
    const m = await api("POST", "/v1/borrower/messages", { text: "Does refinancing make sense for me right now?" }, bearer(v.body["token"] as string), ip);
    assert.equal(m.status, 200, JSON.stringify(m.body).slice(0, 600)); await settle();
    const turn = scripted.turns.slice(turnsBefore).find((t) => REFI_QUESTION.when.test(t.borrower)); assert.ok(turn, "the question reached the model"); assert.equal(turn.scene, REFI_QUESTION); assert.equal(turn.regenerated, false, "the guard accepted the reply");
    const request = scripted.requests.slice(before).find((q) => { const c = q.messages.at(-1)?.content; return typeof c === "string" && c.startsWith("[situation]") && REFI_QUESTION.when.test(parseSituation(c).borrower); }); assert.ok(request, "the turn's request");
    const situation = parseSituation(String(request.messages.at(-1)!.content));
    const reply = m.body["reply"] as Json; assert.equal(reply["sender"], "agent"); assert.equal((reply["subject"] as Json)["loan_id"], loanId, "the answer is on the monitored loan");
    return { reply: String(reply["body_text"]), situation, turn };
  };
  // loan 1's homeowner: the situation carries partner_book.review{verdict=candidate}; the reply points at the offer card in words with no figure outside a token
  const maria = await ask(l1.email!, "10.33.2.11", party.id, loan.id);
  const pb = (maria.situation.situation.record as Json)["partner_book"] as Json; assert.equal(pb["monitored"], true);
  const review = pb["review"] as Json; assert.ok(review, "partner_book.review in the situation");
  assert.equal(review["verdict"], "candidate"); assert.equal(review["as_of_date"], "{{partner_book.review.as_of_date}}", "the date as a token");
  assert.deepEqual((review["reasons_copy_keys"] as string[]).slice(0, 1), ["refi.review.candidate"]); assert.ok((review["reasons_copy_keys"] as string[]).includes("refi.review.reason.rate_delta"));
  assert.equal(typeof review["offer_card_instance_id"], "string", "the pending OfferCard"); assert.equal(review["watch_rate_token"], undefined);
  assert.ok(maria.situation.situation.tokens_available.includes("partner_book.review.as_of_date")); assert.ok(!maria.situation.situation.tokens_available.includes("partner_book.watch_rate"));
  assert.ok(!JSON.stringify(review).match(/7\.250|6\.375|441,366|605,000|87\.5/), "never a figure of the review in the situation");
  assert.ok(maria.situation.situation.pending_cards.some((c) => c["kind"] === "OfferCard"), "the card is in the situation's pending cards");
  assert.equal(maria.turn.text, REFI_CANDIDATE_REPLY); onlyTokens(REFI_CANDIDATE_REPLY, "the model's reply (tokens only)");
  assert.match(maria.reply, /\bcard\b/i, `points at the offer card: ${maria.reply}`); assert.ok(maria.reply.startsWith("Yes, Maria"), maria.reply); NO_FIGURE(maria.reply, "the reply as delivered");
  assert.doesNotMatch(maria.reply, /\bDU\b|credit|approved|pre-approved|guarantee/i, "no DU or credit word");
  // no command ran for the question on a monitored loan (33.2: the turn reads the review; 32.11's request path is for a serviced loan)
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM entity_current WHERE kind = 'refi_opportunities' AND data->>'loan_id' = $1 AND data->>'trigger_kind' = 'borrower_request'`, [loan.id]))[0]!.n, "0", "no borrower-request opportunity");
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM agent_decisions WHERE loan_id = $1 AND action = 'refi.request'`, [loan.id]))[0]!.n, "0");
  const turnRow = (await db.query<{ guard_result: Json; prompt_version: string }>(`SELECT guard_result, prompt_version FROM agent_turns WHERE party_id = $1 AND channel <> 'analyst' ORDER BY created_at DESC LIMIT 1`, [party.id]))[0]!;
  assert.equal(turnRow.guard_result["ok"], true, JSON.stringify(turnRow.guard_result)); assert.equal((turnRow.guard_result["checks"] as Json)["provenance"] && ((turnRow.guard_result["checks"] as Json)["provenance"] as Json)["ok"], true);
  // loan 9's homeowner: watching — the reply says the rate is not there yet and that the book is checked every morning, with no rate
  const loan9 = await loanOf(9); const party9 = await partyOfLoan(loan9.id);
  const thomas = await ask(loanN(9).email!, "10.33.2.19", party9.id, loan9.id);
  const review9 = ((thomas.situation.situation.record as Json)["partner_book"] as Json)["review"] as Json; assert.ok(review9);
  assert.equal(review9["verdict"], "watching"); assert.equal(review9["watch_rate_token"], "{{partner_book.watch_rate}}", "the watch rate only as a token name"); assert.equal(review9["offer_card_instance_id"], null);
  assert.ok((review9["reasons_copy_keys"] as string[]).includes("refi.review.watching")); assert.ok(thomas.situation.situation.tokens_available.includes("partner_book.watch_rate"));
  assert.ok(!JSON.stringify(thomas.situation.situation.record).includes("5.625"), "the watch rate's value never reaches the model");
  assert.equal(thomas.turn.text, REFI_WATCHING_REPLY);
  assert.match(thomas.reply, /not (yet|there)/i); assert.match(thomas.reply, /every morning/i); assert.ok(thomas.reply.startsWith("Not yet, Thomas"), thomas.reply); NO_FIGURE(thomas.reply, "the reply as delivered"); assert.ok(!thomas.reply.includes("5.625") && !thomas.reply.includes("5.875"), "no rate");
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM entity_current WHERE kind = 'refi_opportunities' AND data->>'loan_id' = $1 AND data->>'trigger_kind' = 'borrower_request'`, [loan9.id]))[0]!.n, "0");
  // 32.11 §1 stands: the review is never announced in the thread — the only agent lines are the greeting and the answers to the two questions
  const thread = await api("GET", "/v1/borrower/thread?limit=500", undefined, bearer((await (async () => { const r = await api("POST", "/v1/borrower/auth/otp", { action: "request", channel: "email", destination: l1.email }, {}, "10.33.2.12"); const v = await api("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: r.body["challenge_id"], code: r.body["fake_code"] }, {}, "10.33.2.12"); await settle(); return v.body["token"] as string; })())));
  assert.equal(thread.status, 200); const agentLines = (thread.body["messages"] as Json[]).filter((x) => x["sender"] === "agent" && typeof x["body_text"] === "string" && x["body_text"]).map((x) => String(x["body_text"]));
  assert.ok(agentLines.some((x) => /\bcard\b/i.test(x)), JSON.stringify(agentLines)); for (const line of agentLines) assert.doesNotMatch(line, /\d/, `no figure on the thread: ${line}`);
});

test("33.2 rule 5: one open offer per loan — the morning after an offer went out, the engine holds the loan, the review continues the open offer, no second e-mail, no second card, the frequency cap untouched", { skip }, async () => {
  await firstDay();
  const loan = await loanOf(1); const party = await partyOfLoan(loan.id); const open = oppOf(loan, AS_OF_31);
  assert.equal((await entity("refi_opportunities", open))?.["status"], "offered", "T6 left the offer of 10-16 open"); assert.equal((await entity("refi_opportunities", open))?.["offer_valid_until"], "2026-11-15");
  const offeredBefore = (await events("refi.opportunity.offered", loan.id)).length; const noticesBefore = [...runtime.noticeMemory.values()].filter((n) => n.templateCode === "NTC_REGZ_1026_24_REFI_OFFER").length;
  const openLoans = (await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM entity_current WHERE kind = 'refi_opportunities' AND data->>'status' = 'offered' AND data->>'offer_valid_until' >= $1 AND loan_id = ANY($2::text[])`, [AS_OF_32, (await monitoredLoans()).map((l) => l.id)]))[0]!.n;
  clock.set(NOW_32);
  const sweep = await runtime.sweep(); await settle();
  // 20.1's run: every monitored row built and loaded, the loans with an open offer held out of the evaluation
  const refi = sweep.refi; assert.ok(refi && refi.ran, `the refinance check ran: ${refi?.reason}`);
  assert.equal(refi.universe.monitored.rows, 13); assert.equal(refi.universe.monitored.open_offer, Number(openLoans)); assert.equal(refi.universe.monitored.open_offer, 3, "loans 1, 2 and 13: the offers of 10-16 are open");
  const run = refi.programs.find((p) => p.program_id === programId()); assert.ok(run); assert.equal(run.error, null); assert.equal(run.loans, 10); assert.equal(run.loans_evaluated, 10); assert.equal(run.opportunities_detected, 0); assert.deepEqual(run.offer_ready, []);
  assert.match(refi.line, /monitored_open_offer=3/);
  assert.equal(await entity("refi_opportunities", oppOf(loan, AS_OF_32)), null, "no opportunity of the day for a loan with an open offer");
  // the review of the day continues the open offer: candidate, opportunity_id = the open one
  const review = await reviewOf(loan.id, AS_OF_32); assert.equal(review.verdict, "candidate"); assert.equal(review.opportunity_id, open); assert.deepEqual(review.reasons, [...CANDIDATE_REASONS]);
  assert.equal(String(review.facts["candidate_rate_pct"]), "6.375", "the open offer's own terms are the day's facts");
  const pr = sweep.partner_book_review.programs.find((p) => p.program_id === programId()); assert.ok(pr, sweep.partner_book_review.line); assert.equal(pr.error, null); assert.equal(pr.reviewed, 13); assert.equal(pr.candidates, 3); assert.equal(pr.offers.delivered, 0); assert.equal(pr.offers.portal_only, 0); assert.equal(pr.expired, 0);
  assert.equal((await reviewsOf(AS_OF_32)).length, 13, "the whole book reviewed");
  // nothing offered twice: no second offered event, no second offer e-mail, one pending card, the gate facts' offer history unchanged, no SLA clock armed on a duplicate
  assert.equal((await events("refi.opportunity.offered", loan.id)).length, offeredBefore, "no second refi.opportunity.offered");
  assert.equal([...runtime.noticeMemory.values()].filter((n) => n.templateCode === "NTC_REGZ_1026_24_REFI_OFFER").length, noticesBefore, "no second offer e-mail");
  const pending = (await offerCards(party.id)).filter((c) => c.status === "pending"); assert.equal(pending.length, 1, "one pending OfferCard"); assert.equal(pending[0]!.props["flow_key"], `offer:${open}`);
  const rec = await record(loan); assert.equal(rec.partner_book?.review?.as_of_date, AS_OF_32); assert.equal(rec.partner_book?.review?.outcome, "candidate"); assert.equal(rec.partner_book?.review?.offer_card_instance_id, pending[0]!.card_instance_id, "the situation points at the live card");
  assert.equal(((rec.loan as Json)["ratewatch"] as Json)["state"], "offer_open"); assert.equal(rec.offers.filter((o) => (o as unknown as Json)["status"] === "offered").length, 1);
  const facts = await entity("refi_gate_facts", loan.id); assert.ok(facts); assert.equal((facts["offered_at"] as string[]).length, 2, "the frequency cap counts the two real offers (09-15, 10-16), never a duplicate");
  const sla = await timers("SM_REFI_OFFER_SLA_2BD", loan.id); assert.equal(sla.length, 2); assert.ok(sla.every((t) => t.status === "satisfied"), JSON.stringify(sla));
  assert.equal((await timers("SM_PARTNER_BOOK_REVIEW_DAILY")).filter((t) => t.status === "armed").length, 1, "the daily clock re-armed once");
  // the pass's own guard: offer.deliver on the day finds nothing to send
  const direct = await deliverOffers(runtime, NOW_32, { as_of_date: plainDate(AS_OF_32), program_id: programId() }); assert.equal(direct.delivered, 0); assert.equal(direct.portal_only, 0); assert.deepEqual(direct.skipped, []);
});
