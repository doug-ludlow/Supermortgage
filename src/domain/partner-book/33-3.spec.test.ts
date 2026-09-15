// 33.3 Refinance readiness: what a refinance needs, what is on file, what is asked for
// spec/sections/33-partner-book/33-3-refinance-readiness-what-is-on-file-and-what-is-asked-for.md
// One node:test per T-id, named exactly as the spec. The harness is 33-2.spec.test.ts's: the fixture book of 33.1 imported through
// importPartnerBook, the FAKE sheet / program / LLPA matrix / cost schedule seeded the way the entry demo seeds them, a FixedClock at
// 07:20 America/New_York on 2026-09-15 (past 20.1's 06:30 run, 33.2's 07:00 review and this process's 07:15 pass) and runtime.sweep()
// taking the day's passes — the review with a scripted analyst, the offer delivered, the FAKE MLO's terms review on a second sweep so
// loan 1's OfferCard is on the rail. The homeowners sign in through the borrower API's own doors; the journey after the Yes is driven
// through the same API the app drives it with (the taps, the FAKE vendors finishing on the tap — src/domain/borrower/32-18.spec.test.ts
// and the eval personas' steps) with the scripted model of src/domain/borrower/eval/scripted-client.ts behind the turn. Own database `<base>_33_3`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connect, type Db } from "../../infra/db/client.ts";
import { testDatabase } from "../../infra/db/test-db.ts";
import { decodeEntityData } from "../../infra/db/entities.ts";
import { PgBorrowerUiRepository, type CardInstanceRow } from "../../infra/db/borrower-ui.ts";
import type { Subject } from "../../infra/db/borrower-parties.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock } from "../../kernel/events/index.ts";
import { addDays, plainDate } from "../../kernel/calendar/date.ts";
import { Runtime, type SweepReport } from "../../runtime/app.ts";
import { createApiServer, listen } from "../../runtime/server.ts";
import { createLogger } from "../../runtime/log.ts";
import { createBorrowerRouter, type BorrowerRouter } from "../../runtime/borrower/routes.ts";
import { BorrowerRecordReader } from "../../runtime/borrower/record.ts";
import { copyText } from "../../runtime/borrower/channels.ts";
import { READINESS_COPY_KEYS, READINESS_READY_KEY } from "../../runtime/borrower/copy-keys.ts";
import { AnthropicLlm } from "../../runtime/borrower/agent/llm.ts";
import { provenanceViolation } from "../../runtime/borrower/agent/guard.ts";
import { seedEntryDemo } from "../../runtime/entry-seed.ts";
import { importPartnerBook } from "../../runtime/partner-book.ts";
import { opportunityIdFor } from "../../runtime/partner-book-review.ts";
import { ASK_ORDER, PROJECTED_NOTE_DAYS, READINESS_MODEL_VERSION, READINESS_PROMPT_VERSION, READINESS_RULE_SET_VERSION, REQUIRED_FOR_READY, openRefinanceApplication, readinessRead, readinessRun, readinessSubjects, type ReadinessItem, type ReadinessItemName, type ReadinessRow } from "../../runtime/partner-book-readiness.ts";
import { LOAN_PAID_OFF_EVENT } from "../../runtime/borrower/flows/16-readiness.ts";
import { demoFunded, demoSnapshot, fundApplication } from "../../runtime/origination.ts";
import { identityPass } from "../verification/ops-22-6.ts";
import { esignVerificationToken } from "../../app/tools/section32-2.ts";
import { FakeRateFeed } from "../../infra/integrations/rates.ts";
import { FakeReviewers } from "../../infra/integrations/reviewers.ts";
import { scriptedClient, parseSituation, type Scene, type Situation } from "../borrower/eval/scripted-client.ts";
import { REFINANCE_PROFILE } from "../borrower/eval/personas.ts";
import { DEMO_AS_OF, DEMO_PARTNER, demoBook, type DemoLoan } from "./fixtures/partner-book-demo.ts";

const { url: DB_URL, skip } = await testDatabase(import.meta.url);
const TOKEN = "ops-" + randomUUID();
type Json = Record<string, unknown>;
/** The first day: 2026-09-15 07:20 America/New_York (EDT) — after 20.1's 06:30 run, 33.2's 07:00 review and this process's 07:15 pass. */
const AS_OF = "2026-09-15"; const NOW = "2026-09-15T11:20:00.000Z";
/** The projected note date of a refinance opened on the first day: as_of + 45 days (rule 1). */
const PROJECTED = String(addDays(plainDate(AS_OF), PROJECTED_NOTE_DAYS));
/** Day 2's pass (the recurring clock: the receipt of 09-16 satisfies the instance armed on 09-15 and re-arms it). */
const NOW_DAY2 = "2026-09-16T11:20:00.000Z";
/** Funding day (30.2's demo fixture: the rescission expired 2026-11-11 06:59:59Z, disbursement 2026-11-12). */
const NOW_FUNDING = "2026-11-12T18:40:00.000Z";
/** The morning after the funding: 2026-11-13 07:20 America/New_York (EST). */
const NOW_AFTER_FUNDING = "2026-11-13T12:20:00.000Z";
const clock = new FixedClock(NOW);

// ---------------------------------------------------------------- the scripted analyst (33.2 rule 4): review_facts then review_write, the figures only as tokens
const CLEAN_RATIONALE = "Your rate today is {{facts.rate_now}} and this morning's sheet shows {{facts.candidate_rate}}, which lowers the payment by {{facts.monthly_delta}}. The offer is on the card here.";
const ANALYST_CANDIDATE: Scene = { when: /verdict is candidate/, calls: [{ name: "review.facts", input: {} }, { name: "review.write", input: { rationale: CLEAN_RATIONALE, flags: [] } }], text: "Written." };
const ANALYST_WATCHING: Scene = { when: /verdict is watching/, calls: [{ name: "review.facts", input: {} }, { name: "review.write", input: { rationale: "Rates are not below yours yet; the book is checked every morning.", flags: [] } }], text: "Written." };
const ANALYST_OTHER: Scene = { when: /verdict is (excluded|not_now)/, calls: [{ name: "review.facts", input: {} }, { name: "review.write", input: { rationale: "The loan is out of today's review because of what is on the partner's file; nothing is offered.", flags: [] } }], text: "Written." };
const analystScripted = scriptedClient([ANALYST_CANDIDATE, ANALYST_WATCHING, ANALYST_OTHER]);

// ---------------------------------------------------------------- the scripted borrower model (rule 4 / T5): the answer comes from the situation's readiness, in the copy library's words
const MONITORED_FIRST_TURN: Scene = { when: /signed in for the first time to the account their servicer set up/, text: "Hi {{party.first_name}}, I'm Michelle, the automated assistant here. Your loan with {{partner_book.partner_name}} is on the record here and {{partner_book.partner_name}} keeps servicing it." };
const RETURNING: Scene = { when: /the borrower is back/, text: "Welcome back, {{party.first_name}}. The next thing I need from you is on the rail." };
const READY_REPLY = "Underwriting has what it needs, {{party.first_name}}. The checklist card here shows what comes next.";
const readinessOfSituation = (s: Situation): Json | null => { const r = s.record?.["readiness"] as Json | undefined; if (r) return r; const pb = s.record?.["partner_book"] as Json | undefined; return (pb?.["readiness"] as Json | undefined) ?? null; };
/** The scene names only the items the situation lists as missing, in the copy library's words (the copy keys the situation carries), and points at the current card; when ready, the checklist. */
const NEEDS_QUESTION: Scene = { when: /still need|what do you need|what is (still )?missing/i, text: (s) => {
  const r = readinessOfSituation(s); if (!r) return "I do not have a checklist for you yet, {{party.first_name}}.";
  if (r["ready"] === true) return READY_REPLY;
  const keys = (r["copy_keys"] as string[] | undefined) ?? [];
  return `Still to do, {{party.first_name}}: ${keys.map((k) => copyText(k)).join(" ")} The card here is the next thing to do.`;
} };
const scripted = scriptedClient([MONITORED_FIRST_TURN, RETURNING, NEEDS_QUESTION]);

let db: Db; let runtime: Runtime; let router: BorrowerRouter; let base = ""; let close: () => Promise<void> = async () => undefined;
let partnerPartyId = "";
const logLines: string[] = [];
const book = demoBook();
const loanN = (n: number): DemoLoan => book.loans.find((l) => l.n === n)!;

test.before(async () => {
  if (skip) return;
  db = connect(DB_URL);
  const logger = createLogger("json", (line) => { logLines.push(line); if (process.env["FLOW_DEBUG"] && /flow|error|unhandled|partner|readiness|"status":[45]/i.test(line)) process.stderr.write(line + "\n"); });
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock, logger, rateFeed: new FakeRateFeed(), reviewers: new FakeReviewers({ delaySeconds: 0 }), analystLlm: new AnthropicLlm({ client: analystScripted.client, model: "scripted" }) });
  partnerPartyId = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id, contact) VALUES ('servicer', $1, $2, $3, '{"phone": "+18005550199"}'::jsonb) RETURNING id`, [DEMO_PARTNER.legal_name, DEMO_PARTNER.servicer_number, DEMO_PARTNER.mers_org_id]))[0]!.id;
  router = createBorrowerRouter({ runtime, logger, environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost", "http://127.0.0.1"], urlSecret: "test-secret", defaultPartnerId: partnerPartyId, llm: { client: scripted.client, model: "scripted" } });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger, console: false, borrowerRouter: router });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => { router.hub.close(); server.closeAllConnections?.(); server.close(() => db.end().then(() => resolve())); });
});
test.after(async () => { if (!skip) { await router.flows?.settle(); await close(); } });

// ---------------------------------------------------------------- helpers
type Reply = { status: number; body: Json };
async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, ip = "10.33.3.1"): Promise<Reply> {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-forwarded-for": ip, ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text(); return { status: r.status, body: text ? (JSON.parse(text) as Json) : {} };
}
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
const settle = async () => { await router.flows!.settle(); await router.agent?.settle(); await router.flows!.settle(); };
const bytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "utf8"));
type LoanRow = { id: string; servicer_loan_number: string; status: string; partner_party_id: string };
const loanByNumber = async (number: string): Promise<LoanRow> => { const l = (await db.query<LoanRow>(`SELECT id::text AS id, servicer_loan_number, status::text AS status, partner_party_id::text AS partner_party_id FROM loans WHERE partner_party_id = $1 AND servicer_loan_number = $2`, [partnerPartyId, number]))[0]; assert.ok(l, `loan ${number} on the book`); return l; };
const loanOf = (n: number): Promise<LoanRow> => loanByNumber(loanN(n).servicer_loan_number);
type PartyRow = { id: string; legal_name: string; contact: Json };
const partyOfLoan = async (loanId: string): Promise<PartyRow> => { const r = (await db.query<PartyRow>(`SELECT p.id::text AS id, p.legal_name, p.contact FROM loan_borrowers lb JOIN borrowers b ON b.id = lb.borrower_id JOIN parties p ON p.id = b.party_id WHERE lb.loan_id = $1 ORDER BY lb.is_primary DESC LIMIT 1`, [loanId]))[0]; assert.ok(r, "the loan's party"); return r; };
type EventRow = { id: string; type: string; loan_id: string | null; application_id: string | null; actor_kind: string; actor_id: string; payload: Json; sequence: string; occurred_at: string };
const EVENT_COLS = `id::text AS id, type, loan_id::text AS loan_id, application_id::text AS application_id, actor_kind::text AS actor_kind, actor_id, payload, sequence::text AS sequence, occurred_at::text AS occurred_at`;
const events = async (type: string, loanId?: string): Promise<EventRow[]> => db.query<EventRow>(`SELECT ${EVENT_COLS} FROM loan_events WHERE type = $1 AND ($2::uuid IS NULL OR loan_id = $2::uuid) ORDER BY sequence`, [type, loanId ?? null]);
const appEvents = async (appId: string, type?: string): Promise<EventRow[]> => db.query<EventRow>(`SELECT ${EVENT_COLS} FROM loan_events WHERE application_id = $1 AND ($2::text IS NULL OR type = $2) ORDER BY sequence`, [appId, type ?? null]);
type TimerRow = { code: string; subject_kind: string; subject_id: string; loan_id: string | null; status: string; anchor_date: string; due_date: string | null; due_at: string | null; satisfied_at: string | null; breached_at: string | null };
const timers = async (code: string): Promise<TimerRow[]> => db.query<TimerRow>(`SELECT code, subject_kind, subject_id, loan_id::text AS loan_id, status::text AS status, anchor_date::text AS anchor_date, due_date::text AS due_date, due_at::text AS due_at, satisfied_at::text AS satisfied_at, breached_at::text AS breached_at FROM timers WHERE code = $1 ORDER BY armed_at, id`, [code]);
const entity = async (kind: string, id: string): Promise<Json | null> => { const r = (await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = $1 AND id = $2`, [kind, id]))[0]; return r ? decodeEntityData(r.data) : null; };
const entitiesOf = async (kind: string, appId: string): Promise<Json[]> => (await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = $1 AND data->>'application_id' = $2`, [kind, appId])).map((r) => decodeEntityData(r.data) as Json);
const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM (${sql}) x`, params))[0]!.n);
const ui = (): PgBorrowerUiRepository => new PgBorrowerUiRepository(db);
/** The party's cards oldest first (the rail's order). */
const cardsOf = async (partyId: string): Promise<CardInstanceRow[]> => (await ui().cardsOf(partyId)).reverse();
const offerCards = async (partyId: string): Promise<CardInstanceRow[]> => (await cardsOf(partyId)).filter((c) => c.kind === "OfferCard");
const programId = (): string => `prog-refi-${partnerPartyId.slice(0, 8)}`;   // seedEntryDemo's id scheme = importPartnerBook's
const oppOf = (loan: LoanRow, asOf = AS_OF): string => opportunityIdFor(loan.id, plainDate(asOf), programId());
/** Every readiness row of a loan, oldest first (created_at, then the checked event's sequence — rows of one instant under the fixed clock). */
const rowsOf = async (loanId: string): Promise<ReadinessRow[]> => db.query<ReadinessRow>(`SELECT r.id::text AS id, r.loan_id::text AS loan_id, r.party_id::text AS party_id, r.application_id::text AS application_id, r.as_of_date::text AS as_of_date, r.items, r.ready, r.missing, r.decision_id::text AS decision_id, r.created_at::text AS created_at FROM readiness_checks r LEFT JOIN LATERAL (SELECT max(e.sequence) AS seq FROM loan_events e WHERE e.loan_id = r.loan_id AND e.type = 'partner_book.readiness.checked' AND e.payload->>'readiness_check_id' = r.id::text) ev ON true WHERE r.loan_id = $1 ORDER BY r.created_at, ev.seq NULLS FIRST`, [loanId]);
const latest = async (loanId: string): Promise<ReadinessRow> => { const r = await readinessRead(runtime, loanId); assert.ok(r, `a readiness row for ${loanId}`); return r; };
const itemOf = (row: ReadinessRow, name: ReadinessItemName): ReadinessItem => { const it = row.items.find((x) => x.item === name); assert.ok(it, `${name} on the row`); return it; };
const statuses = (row: ReadinessRow): Record<string, string> => Object.fromEntries(row.items.map((x) => [x.item, x.status]));
/** missing[] is the required items missing or stale, in the order asked (ASK_ORDER). */
const assertAskOrder = (row: ReadinessRow): void => { const ranks = row.missing.map((m) => ASK_ORDER.indexOf(m)); for (let k = 1; k < ranks.length; k += 1) assert.ok(ranks[k]! >= ranks[k - 1]!, `missing in the order asked: ${JSON.stringify(row.missing)}`); for (const m of row.missing) assert.ok(REQUIRED_FOR_READY.includes(m), `${m} is required`); };
const subjectFor = (loan: LoanRow): Subject => ({ application_id: null, loan_id: loan.id, role: "borrower", stage: "servicing", label: loan.servicer_loan_number, application_borrower_id: null });
const record = async (loan: LoanRow) => { const party = await partyOfLoan(loan.id); return new BorrowerRecordReader(db).record(party, subjectFor(loan), await ui().cardsOf(party.id), clock.now()); };
const NO_FIGURE = (text: string, where: string): void => { assert.doesNotMatch(text, /\d/, `${where} carries a digit: ${text}`); assert.doesNotMatch(text, /%|\$|basis points/i, `${where} carries a rate or amount: ${text}`); };
const onlyTokens = (text: string, where: string): void => { assert.equal(provenanceViolation(text), null, `${where}: ${provenanceViolation(text)} — ${text}`); assert.doesNotMatch(text.replace(/\{\{[a-zA-Z0-9_.:-]+\}\}/g, ""), /\d/, `${where} carries a digit outside a token: ${text}`); };
/** The vendor orders and consumer reports on the platform (rule 2: none before the Yes). */
const orders = async (): Promise<Record<string, number>> => ({
  verification_ordered: await count(`SELECT 1 FROM loan_events WHERE type = 'verification.ordered'`), verification_received: await count(`SELECT 1 FROM loan_events WHERE type = 'verification.received'`),
  credit_ordered: await count(`SELECT 1 FROM loan_events WHERE type = 'credit.report.ordered'`), credit_received: await count(`SELECT 1 FROM loan_events WHERE type = 'credit.report.received'`),
  asset_ordered: await count(`SELECT 1 FROM loan_events WHERE type = 'asset_report.ordered'`), identity: await count(`SELECT 1 FROM loan_events WHERE type = 'identity.verified'`),
  verifications: await count(`SELECT 1 FROM entity_current WHERE kind = 'verifications'`), credit_reports: await count(`SELECT 1 FROM entity_current WHERE kind = 'credit_reports'`), cards: await count(`SELECT 1 FROM card_instances`) });

// ---------------------------------------------------------------- the borrower API: sign-in by the e-mailed code (33.1's door), the taps, the FAKE connectors (32-18.spec.test.ts's helpers)
type B = { token: string; party_id: string; app_id: string; name: string };
async function signIn(email: string, ip: string): Promise<{ token: string; party_id: string; level: string }> {
  const req = await api("POST", "/v1/borrower/auth/otp", { action: "request", channel: "email", destination: email }, {}, ip);
  assert.equal(req.status, 200, JSON.stringify(req.body)); assert.equal(req.body["delivery"], "FAKE");
  const v = await api("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: req.body["challenge_id"], code: req.body["fake_code"] }, {}, ip);
  assert.equal(v.status, 200, JSON.stringify(v.body)); await settle();
  return { token: v.body["token"] as string, party_id: (v.body["party"] as Json)["party_id"] as string, level: String((v.body["session"] as Json | undefined)?.["level"] ?? "") };
}
const fieldsEvidence = (card: CardInstanceRow, edits: Record<string, string> = {}) => ({ evidence: { fields: (card.props["fields"] as { path: string; value: string; source: string }[]).map((f) => ({ path: f.path, value_confirmed: edits[f.path] ?? f.value, source: f.source, confirmed_at: clock.now() })), edited: Object.keys(edits).length > 0 } });
async function pending(b: B, copyKey: string): Promise<CardInstanceRow> { await settle(); const c = (await cardsOf(b.party_id)).filter((x) => x.copy_key === copyKey && x.status === "pending").at(-1); assert.ok(c, `a pending ${copyKey} card (pending: ${(await cardsOf(b.party_id)).filter((x) => x.status === "pending").map((x) => x.copy_key).join(", ")})`); return c; }
async function tap(b: B, card: CardInstanceRow, body: Json): Promise<Reply> { const r = await api("POST", `/v1/borrower/cards/${card.card_instance_id}/resolve`, body, bearer(b.token)); assert.equal(r.status, 201, `tap ${card.copy_key}: ${JSON.stringify(r.body).slice(0, 600)}`); await settle(); return r; }
/** The Yes on the OfferCard — 32.2 offer.respond{decision=yes} on the loan subject → refi.opportunity.engaged. */
async function tapYes(b: B, card: CardInstanceRow): Promise<Reply> { const r = await api("POST", `/v1/borrower/cards/${card.card_instance_id}/resolve`, { option_id: "yes", evidence: { option_id: "yes", tapped_at: clock.now() } }, bearer(b.token)); await settle(); return r; }
/** 32.3 E5 on the FAKE, finishing on the tap (32.17 rule 19; the eval runner's step `identity: true`): identity.verified, the prefill, L3; then the identity ConfirmCard. */
async function identity(b: B): Promise<Reply> {
  const r = await api("POST", "/v1/borrower/identity/stripe/session", { application_id: b.app_id, fake_complete: true }, bearer(b.token)); assert.equal(r.status, 200, JSON.stringify(r.body)); await settle();
  assert.equal(r.body["delivery"], "FAKE"); assert.equal(r.body["status"], "verified"); assert.equal(r.body["application_id"], b.app_id);
  return r;
}
const SSN = "123-45-6789";
async function typeSsn(b: B): Promise<void> { const ssn = await pending(b, "identity.ssn.title"); await tap(b, ssn, fieldsEvidence(ssn, { ssn: SSN })); }
/** R3 on the FAKE: the payroll connection finishing on the tap → verification.received{kind=income}; then the income ConfirmCard as the report shows it. */
async function income(b: B): Promise<Reply> {
  const connect = await pending(b, "income.connect.purpose");
  const s = await api("POST", "/v1/borrower/connect/truv_income/session", { card_instance_id: connect.card_instance_id, fake_complete: true }, bearer(b.token)); assert.equal(s.status, 200, JSON.stringify(s.body)); await settle();
  return s;
}
async function confirmIncome(b: B): Promise<void> { const card = await pending(b, "income.confirm.title"); await tap(b, card, fieldsEvidence(card)); }
async function assets(b: B): Promise<Reply> { const card = await pending(b, "assets.connect.purpose"); const s = await api("POST", "/v1/borrower/connect/plaid_assets/session", { card_instance_id: card.card_instance_id, fake_complete: true }, bearer(b.token)); assert.equal(s.status, 200, JSON.stringify(s.body)); await settle(); return s; }
/** A ConsentCard affirmed the way the app affirms it: checkbox + typed name (32-11.spec.test.ts's standing card tap). */
async function affirm(b: B, card: CardInstanceRow): Promise<Reply> { return tap(b, card, { option_id: "affirm", evidence: { consent_kind: card.props["consent_kind"], method: "checkbox_with_text", typed_name: b.name, disclosure_version_id: card.props["disclosure_version_id"], affirmed_at: clock.now() } }); }
/** The E-SIGN demonstration test (32.3 E6 / 7.4 rule 2): the e-mailed link + PDF code (FAKE mailer) — only now is the row `active`. */
async function verifyEsign(b: B, consentId: string): Promise<void> { const r = await api("POST", "/v1/borrower/commands/consent.capture", { op: "verify", consent_id: consentId, token: esignVerificationToken(consentId), scope: ["disclosures", "notices"] }, bearer(b.token)); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 600)); await settle(); }
/** 32.11 §3's compressed cards: the home (servicing record), the name, the profile, the declarations, the demographics, the value (the partner's), the loan amount (the candidate's), the product when asked. */
async function sixItems(b: B): Promise<void> {
  const home = await pending(b, "refi.home.confirm"); await tap(b, home, fieldsEvidence(home, { estate_type: "fee_simple", existing_clean_energy_lien: "no" }));   // 32.18 rule 7: the home card asks both on every file
  const name = await pending(b, "refi.name.confirm"); await tap(b, name, fieldsEvidence(name));
  const profile = await pending(b, "refi.profile.confirm"); await tap(b, profile, fieldsEvidence(profile, Object.fromEntries(REFINANCE_PROFILE.map((x) => [x.path, x.value]))));
  // 32.3 R5's sequence on the compressed application too (32.11 T6): 5a.A, then 5a.E, then the list — the None tap asserts the fourteen answers as the homeowner's own actor
  const occ = await pending(b, "declarations.occupancy"); await tap(b, occ, { option_id: "yes_no_prior", evidence: { option_id: "yes_no_prior", tapped_at: clock.now() } });
  const lien = await pending(b, "declarations.clean_energy_lien"); await tap(b, lien, { option_id: "no", evidence: { option_id: "no", tapped_at: clock.now() } });
  const decl = await pending(b, "declarations.title"); await tap(b, decl, { option_id: "none", evidence: { option_id: "none", tapped_at: clock.now() } });
  const demo = await pending(b, "demographics.title"); await tap(b, demo, { option_id: "submit", evidence: { collection_method: "internet", answered_at: clock.now(), answers: { ethnicity: ["do_not_wish"], race: ["do_not_wish"], sex: "do_not_wish" } } });
  const value = await pending(b, "value.confirm.title"); await tap(b, value, fieldsEvidence(value));
  const amount = await pending(b, "loan_amount.confirm.title"); await tap(b, amount, fieldsEvidence(amount));
  const product = (await cardsOf(b.party_id)).filter((x) => x.copy_key === "refi.product.choice" && x.status === "pending").at(-1);
  if (product) await tap(b, product, { option_id: "FRM30", evidence: { option_id: "FRM30", tapped_at: clock.now() } });
}
/** The open refinance application of a monitored loan (prior_loan_id = the loan). */
type AppRow = { id: string; channel: string; status: string; transaction_type: string; occupancy: string; prior_loan_id: string | null; loan_id: string | null; intake_channel: string | null; partner_party_id: string };
const applicationsOf = async (loanId: string): Promise<AppRow[]> => db.query<AppRow>(`SELECT id::text AS id, channel::text AS channel, status::text AS status, transaction_type::text AS transaction_type, occupancy::text AS occupancy, prior_loan_id::text AS prior_loan_id, loan_id::text AS loan_id, intake_channel::text AS intake_channel, partner_party_id::text AS partner_party_id FROM applications WHERE prior_loan_id = $1 ORDER BY created_at`, [loanId]);

// ---------------------------------------------------------------- day 1, once per file: the seed, the import, the homeowner's first sign-in, the 07:20 ET sweep (20.1's run → the review → offer delivery → this process's readiness pass), the FAKE MLO's approval on a second same-day sweep
let day1: { sweep: SweepReport; again: SweepReport; import_id: string; maria: { token: string; party_id: string; level: string } } | undefined;
async function firstDay(): Promise<NonNullable<typeof day1>> {
  if (day1) return day1;
  assert.equal(clock.now(), NOW);
  const seed = await seedEntryDemo(runtime, { partner_id: partnerPartyId, nmlsr_id: DEMO_PARTNER.nmlsr_id });
  assert.equal(seed.partner_id, partnerPartyId, "the demo partner is the fixture partner");
  const actor = { kind: "human" as const, id: "u-ops-analyst", role: "ops_analyst" };
  const imp = await importPartnerBook(runtime, { partner: DEMO_PARTNER, as_of_date: DEMO_AS_OF, profile: "m3-v1", tape: { filename: "partner-book-demo.xlsx", content: book.tape }, supplement: { filename: "partner-book-demo-supplement.csv", content: bytes(book.supplement) } }, actor);
  assert.equal(imp.status, "loaded", JSON.stringify(imp.report).slice(0, 600)); assert.equal(imp.rows_loaded, 12);
  await settle();
  // the homeowner of loan 1 signs in first (33.1's door: the e-mailed code) — `account` is present on the day's row (T1)
  const loan = await loanOf(1); const party = await partyOfLoan(loan.id);
  const maria = await signIn(loanN(1).email!, "10.33.3.11"); assert.equal(maria.party_id, party.id, "signed in on loan 1's party");
  assert.equal((await events("partner_book.account.activated", loan.id)).length, 1, "the first sign-in activates the account (33.1 rule 6)");
  const sweep = await runtime.sweep(); await settle();
  const again = await runtime.sweep(); await settle();   // the FAKE MLO's terms review (32.11: offer_ready → review → presented → the OfferCard)
  day1 = { sweep, again, import_id: imp.import_id, maria }; return day1;
}

test("33.3-T1: Given loan 1 a `candidate` on the day's review and no application, when the sweep passes at 07:15 ET, then one `readiness_checks` row exists for the loan with `ready = false`, `contact`, `account` (after the homeowner's first sign-in) and `value` present, `identity`, `ssn`, `credit`, `income`, `assets`, `esign` and `credit_authorization` missing, no vendor order, no card and no consumer report, `partner_book.readiness.checked` logged and `SM_PARTNER_BOOK_READINESS_DAILY` satisfied and re-armed.", { skip }, async () => {
  const { sweep, again } = await firstDay();
  const loan = await loanOf(1); const party = await partyOfLoan(loan.id); const l1 = loanN(1);
  // loan 1 a candidate on the day's review, no application
  const review = (await db.query<{ verdict: string }>(`SELECT verdict FROM partner_book_reviews WHERE loan_id = $1 AND as_of_date = $2`, [loan.id, AS_OF]))[0]; assert.ok(review); assert.equal(review.verdict, "candidate");
  assert.deepEqual(await applicationsOf(loan.id), [], "no application on the loan");
  // the pass ran on the sweep after the review (07:15 ET < 07:20 ET), over the day's candidates
  const r = sweep.partner_book_readiness; assert.ok(r.ran, `the readiness pass ran: ${r.skipped}`); assert.equal(r.skipped, ""); assert.equal(r.as_of_date, AS_OF);
  assert.equal(r.checked, 2, "loans 1 and 2 — the day's candidates (no open application yet)"); assert.equal(r.ready, 0); assert.equal(r.not_ready, 2); assert.deepEqual(r.loans_skipped, []);
  assert.ok(sweep.partner_book_review.ran, "the review runs first"); assert.equal(sweep.partner_book_review.as_of_date, AS_OF);
  // one readiness_checks row for the loan: ready = false; contact, account, value present; identity, ssn, credit, income, assets, esign, credit_authorization missing
  const rows = await rowsOf(loan.id); assert.equal(rows.length, 1, "one row for the loan"); const row = rows[0]!;
  assert.equal(row.ready, false); assert.equal(row.as_of_date, AS_OF); assert.equal(row.party_id, party.id); assert.equal(row.application_id, null, "no application yet"); assert.ok(row.decision_id, "the readiness.check decision");
  const st = statuses(row);
  assert.equal(st["contact"], "present"); assert.equal(st["account"], "present"); assert.equal(st["value"], "present");
  for (const m of ["identity", "ssn", "credit", "income", "assets", "esign", "credit_authorization"]) assert.equal(st[m], "missing", `${m} missing`);
  assert.equal(st["verification_authorization"], "missing"); assert.equal(st["insurance"], "missing", "not required"); assert.equal(st["payoff"], "not_applicable", "not_applicable until the application exists");
  assert.equal(row.items.length, 13, "one entry per item");
  for (const it of row.items) { assert.ok(["present", "stale", "missing", "not_applicable"].includes(it.status)); assert.match(it.rule_ref, /^33\.3 rule 1/); }
  assert.deepEqual(row.missing, ["identity", "ssn", "income", "assets", "esign", "credit_authorization", "credit"], "the required items missing, in the order asked"); assertAskOrder(row);
  // each present item names its source row: the party's contact (an e-mail and a phone), the activation event, the facts' value dated within 12 months
  const contact = itemOf(row, "contact"); assert.equal(contact.source_table, "parties"); assert.equal(contact.source_id, party.id); assert.equal(party.contact["email"], l1.email); assert.ok(party.contact["phone"]);
  const activated = (await events("partner_book.account.activated", loan.id))[0]!; const account = itemOf(row, "account"); assert.equal(account.source_table, "loan_events"); assert.equal(account.source_id, activated.id); assert.equal(account.as_of, AS_OF);
  const value = itemOf(row, "value"); assert.equal(value.source_table, "partner_book_facts"); assert.equal(value.as_of, String(l1.tape["fmv_date"]), "the newest of FMV and BPO (33.2 rule 1)"); assert.equal(value.valid_until, "2027-08-31", "+12 months");
  assert.equal((await db.query<{ id: string }>(`SELECT id::text AS id FROM partner_book_facts WHERE loan_id = $1 ORDER BY as_of_date DESC, created_at DESC LIMIT 1`, [loan.id]))[0]!.id, value.source_id);
  for (const name of ["identity", "ssn", "credit", "income", "assets", "esign", "credit_authorization"] as const) { const it = itemOf(row, name); assert.equal(it.source_id, null); assert.ok(it.refresh_via, `${name} names how it is refreshed`); }
  // the decision record: agent refi-readiness, rule set partner_book.readiness.v1, model deterministic, prompt 33.3-v1, confidence 1
  const decision = (await db.query<{ agent: string; action: string; rule_set_version: string; model_version: string; prompt_version: string; confidence: string; loan_id: string; application_id: string | null }>(`SELECT agent, action, rule_set_version, model_version, prompt_version, confidence::text AS confidence, loan_id::text AS loan_id, application_id::text AS application_id FROM agent_decisions WHERE id = $1`, [row.decision_id]))[0];
  assert.ok(decision, "the decision row"); assert.equal(decision.agent, "refi-readiness"); assert.equal(decision.action, "readiness.check"); assert.equal(decision.rule_set_version, READINESS_RULE_SET_VERSION); assert.equal(decision.model_version, READINESS_MODEL_VERSION); assert.equal(decision.prompt_version, READINESS_PROMPT_VERSION); assert.equal(Number(decision.confidence), 1); assert.equal(decision.loan_id, loan.id); assert.equal(decision.application_id, null);
  // rule 2: no vendor order, no consumer report, no card — the check reads
  const o = await orders();
  for (const k of ["verification_ordered", "verification_received", "credit_ordered", "credit_received", "asset_ordered", "identity", "verifications", "credit_reports"]) assert.equal(o[k], 0, `no ${k} before the Yes`);
  const cards = await cardsOf(party.id);
  assert.ok(cards.every((c) => c.kind === "StatusCard" || c.kind === "OfferCard"), `only 33.2's offer delivery on the rail: ${cards.map((c) => `${c.kind}:${c.copy_key}`).join(", ")}`);
  assert.ok(!cards.some((c) => /readiness|33\.3/.test(c.created_by) || c.props["flow"] === "33.3"), "no card from readiness");
  assert.equal((await db.query(`SELECT 1 FROM agent_decisions WHERE agent = 'refi-readiness' AND action NOT IN ('readiness.check', 'readiness.run', 'readiness.read')`)).length, 0);
  // partner_book.readiness.checked logged (loan-scoped, origination: true) and the day's receipt (global)
  const checked = await events("partner_book.readiness.checked", loan.id); assert.equal(checked.length, 1); const cp = checked[0]!.payload;
  assert.equal(checked[0]!.actor_kind, "agent"); assert.equal(checked[0]!.actor_id, "refi-readiness");
  assert.equal(cp["loan_id"], loan.id); assert.equal(cp["party_id"], party.id); assert.equal(cp["application_id"], null); assert.equal(cp["as_of_date"], AS_OF); assert.equal(cp["ready"], false); assert.deepEqual(cp["missing"], row.missing); assert.equal(cp["origination"], true); assert.equal(cp["readiness_check_id"], row.id);
  const completed = (await events("partner_book.readiness.run_completed")).filter((e) => e.payload["as_of_date"] === AS_OF); assert.equal(completed.length, 1, "one receipt per day"); const rp = completed[0]!.payload;
  assert.equal(completed[0]!.loan_id, null, "global"); assert.equal(rp["checked"], 2); assert.equal(rp["ready"], 0); assert.equal(rp["not_ready"], 2); assert.equal(rp["origination"], true);
  assert.deepEqual((rp["loans"] as Json[]).map((x) => x["loan_id"]).sort(), [loan.id, (await loanOf(2)).id].sort(), "loans 1 and 2 checked");
  // SM_PARTNER_BOOK_READINESS_DAILY: armed by the receipt for tomorrow 07:15 ET (recurring: the next day's receipt satisfies it and re-arms it)
  let clocks = await timers("SM_PARTNER_BOOK_READINESS_DAILY"); assert.equal(clocks.length, 1, "one instance after the first run"); const t = clocks[0]!;
  assert.equal(t.status, "armed"); assert.equal(t.subject_kind, "global"); assert.equal(t.loan_id, null); assert.equal(t.anchor_date, AS_OF); assert.equal(t.due_date, "2026-09-16");
  assert.equal(new Date(t.due_at!).toISOString(), "2026-09-16T11:15:00.000Z", "+1 calendar day, 07:15 America/New_York (EDT)");
  // the same day again: idempotent — no second row, no second receipt
  assert.equal(again.partner_book_readiness.ran, false); assert.match(again.partner_book_readiness.skipped, /already ran today/);
  assert.equal((await rowsOf(loan.id)).length, 1); assert.equal((await events("partner_book.readiness.run_completed")).filter((e) => e.payload["as_of_date"] === AS_OF).length, 1);
  // day 2's pass (the runtime function the sweep calls): the receipt of 09-16 satisfies the instance armed on 09-15 and re-arms it for 09-17 07:15 ET; still nothing ordered, no card
  const before = await orders();
  const day2 = await readinessRun(runtime, NOW_DAY2, { logger: runtime.logger }); assert.ok(day2.ran, day2.skipped); assert.equal(day2.as_of_date, "2026-09-16"); assert.equal(day2.checked, 2);
  clocks = await timers("SM_PARTNER_BOOK_READINESS_DAILY"); assert.equal(clocks.length, 2, JSON.stringify(clocks));
  const first = clocks.find((c) => c.anchor_date === AS_OF); const second = clocks.find((c) => c.anchor_date === "2026-09-16"); assert.ok(first && second, JSON.stringify(clocks));
  assert.equal(first.status, "satisfied", "the instance armed on 09-15 is satisfied by the receipt of 09-16"); assert.ok(first.satisfied_at);
  assert.equal(second.status, "armed", "and re-armed for the next day"); assert.equal(second.subject_kind, "global"); assert.equal(new Date(second.due_at!).toISOString(), "2026-09-17T11:15:00.000Z");
  const rows2 = await rowsOf(loan.id); assert.equal(rows2.length, 2); assert.equal(rows2[1]!.as_of_date, "2026-09-16"); assert.equal(rows2[1]!.ready, false); assert.deepEqual(rows2[1]!.missing, row.missing);
  assert.deepEqual(await orders(), before, "day 2 read the same rows and ordered nothing: no vendor order, no consumer report, no card");
  // rule 2 on the record: the situation's readiness block is on the loan, no card opened for it
  const rec = await record(loan); assert.ok(rec.readiness, "readiness on the record"); assert.equal(rec.readiness.ready, false); assert.deepEqual(rec.readiness.missing, row.missing); assert.equal(rec.readiness.current_card_instance_id, null, "no card before the Yes");
  assert.deepEqual(rec.partner_book?.readiness?.missing, row.missing);
});

test("33.3-T2: Given the homeowner of loan 1 taps Yes on the OfferCard, then `refi.open` creates one application with `channel = refi_trigger`, `prior_loan_id` = the loan, the party linked on `application_borrowers`, the property with the facts' value, 20.3's conversion, `refi.opportunity.converted` and `partner_book.refinance.opened` logged, the identity, payroll and assets connector cards and the six-item cards on the rail, and a second Yes creates nothing more.", { skip }, async () => {
  const { maria } = await firstDay();
  const loan = await loanOf(1); const party = await partyOfLoan(loan.id); const l1 = loanN(1); const oppId = oppOf(loan);
  const b: B = { token: maria.token, party_id: party.id, app_id: "", name: party.legal_name };
  const offer = (await offerCards(party.id)).find((c) => c.props["flow_key"] === `offer:${oppId}`); assert.ok(offer, "the OfferCard on the rail"); assert.equal(offer.status, "pending"); assert.equal(offer.command_ref, "offer.respond");
  const facts = (await db.query<{ facts: Json }>(`SELECT facts FROM partner_book_facts WHERE loan_id = $1 ORDER BY as_of_date DESC, created_at DESC LIMIT 1`, [loan.id]))[0]!.facts;
  // the Yes: 32.2 offer.respond{decision=yes} → 20.3's lead, 20.1's engaged → refi.open (the flow's reaction on the monitored loan; 32.11's convert defers)
  const yes = await tapYes(b, offer); assert.equal(yes.status, 201, JSON.stringify(yes.body).slice(0, 600));
  const engaged = await events("refi.opportunity.engaged", loan.id); assert.equal(engaged.length, 1); assert.equal(engaged[0]!.payload["opportunity_id"], oppId); const leadId = String(engaged[0]!.payload["lead_id"]);
  // one application: channel refi_trigger, prior_loan_id = the loan, the party linked, the property with the facts' value
  const apps = await applicationsOf(loan.id); assert.equal(apps.length, 1, "one application on the loan"); const app = apps[0]!; b.app_id = app.id;
  assert.equal(app.id, leadId, "the lead id is the application id (20.3)"); assert.equal(app.channel, "refi_trigger"); assert.equal(app.prior_loan_id, loan.id); assert.equal(app.loan_id, null); assert.equal(app.status, "started");
  assert.equal(app.transaction_type, "limited_cash_out"); assert.equal(app.occupancy, "primary"); assert.equal(app.intake_channel, "web"); assert.equal(app.partner_party_id, partnerPartyId);
  const abs = await db.query<{ id: string; legal_name: string; party_id: string | null; borrower_role: string; tin_last4: string | null; contact: Json }>(`SELECT id::text AS id, legal_name, party_id::text AS party_id, borrower_role::text AS borrower_role, tin_last4, contact FROM application_borrowers WHERE application_id = $1 ORDER BY created_at`, [app.id]);
  assert.equal(abs.length, 1); assert.equal(abs[0]!.party_id, party.id, "the party linked on application_borrowers"); assert.equal(abs[0]!.legal_name, l1.name); assert.equal(abs[0]!.borrower_role, "borrower"); assert.equal(abs[0]!.tin_last4, null, "no SSN on file for a partner-book homeowner"); assert.equal(abs[0]!.contact["email"], l1.email);
  const props = await db.query<{ address_line1: string; city: string; state: string; postal_code: string; county: string | null; estimated_value_cents: string | null; is_subject: boolean }>(`SELECT address_line1, city, state, postal_code, county, estimated_value_cents::text AS estimated_value_cents, is_subject FROM application_properties WHERE application_id = $1`, [app.id]);
  assert.equal(props.length, 1); assert.equal(props[0]!.address_line1, String(l1.tape["property_address"])); assert.equal(props[0]!.city, "Phoenix"); assert.equal(props[0]!.state, "AZ"); assert.equal(props[0]!.postal_code, "85013"); assert.equal(props[0]!.is_subject, true);
  assert.equal(props[0]!.estimated_value_cents, String(facts["fmv_cents"]), "the facts' value (the newest of FMV and BPO — 33.2 rule 1's selection), never a computed one"); assert.equal(props[0]!.estimated_value_cents, "60500000");
  // 20.3's conversion: the lead converted onto the application; 20.1's opportunity converted; the interview started (21.1) with the prefills offered, never stated
  const lead = await entity("leads", leadId); assert.ok(lead, "20.3's lead"); assert.equal(lead["status"], "converted"); assert.equal(lead["application_id"], app.id); assert.equal(lead["channel"], "refi_trigger"); assert.equal(lead["party_id"], party.id);
  const opp = await entity("refi_opportunities", oppId); assert.ok(opp); assert.equal(opp["status"], "converted"); assert.equal(opp["lead_id"], leadId);
  assert.ok((await appEvents(app.id, "application.received")).length >= 1, "application.received on the application"); assert.equal((await appEvents(app.id, "application.started")).length, 1);
  const intake = await entity("applications", app.id); assert.ok(intake, "21.1's intake record"); assert.equal(intake["partner_nmlsr_id"], DEMO_PARTNER.nmlsr_id);
  const six = intake["six_items"] as Json; for (const item of ["name", "property_address", "property_value_estimate", "loan_amount_sought"]) { assert.equal((six[item] as Json)["source"], "prefill_unconfirmed", `${item} offered as a prefill (21.1 rule 1), not stated`); assert.equal((six[item] as Json)["submitted_at"], null); }
  assert.equal((six["ssn"] as Json)["source"], null, "no SSN on file: typed after the scan (rule 4)");
  // refi.opportunity.converted and partner_book.refinance.opened logged, with the refi.open decision
  const converted = (await events("refi.opportunity.converted", loan.id)).filter((e) => e.payload["opportunity_id"] === oppId); assert.equal(converted.length, 1); assert.equal(converted[0]!.payload["application_id"], app.id); assert.equal(converted[0]!.payload["prior_loan_id"], loan.id); assert.equal(converted[0]!.application_id, app.id);
  const opened = await events("partner_book.refinance.opened", loan.id); assert.equal(opened.length, 1); const op = opened[0]!.payload;
  assert.equal(opened[0]!.application_id, app.id); assert.equal(opened[0]!.actor_id, "refi-readiness");
  assert.equal(op["loan_id"], loan.id); assert.equal(op["application_id"], app.id); assert.equal(op["party_id"], party.id); assert.equal(op["opportunity_id"], oppId); assert.equal(op["origination"], true); assert.equal(op["prior_loan_id"], loan.id);
  const decision = (await db.query<{ agent: string; rule_set_version: string; application_id: string; loan_id: string }>(`SELECT agent, rule_set_version, application_id::text AS application_id, loan_id::text AS loan_id FROM agent_decisions WHERE id = $1`, [String(op["decision_id"])]))[0];
  assert.ok(decision, "the refi.open decision"); assert.equal(decision.agent, "refi-readiness"); assert.equal(decision.rule_set_version, READINESS_RULE_SET_VERSION); assert.equal(decision.application_id, app.id); assert.equal(decision.loan_id, loan.id);
  assert.equal((await db.query(`SELECT 1 FROM agent_decisions WHERE loan_id = $1 AND action = 'refi.open'`, [loan.id])).length, 1);
  // the identity, payroll and assets connector cards (32.3 E5 / R3, 32.18 rule 1) and the six-item cards (32.11 §3) on the rail, on the application
  const onApp = (await cardsOf(party.id)).filter((c) => c.subject_application_id === app.id);
  const connectors = onApp.filter((c) => c.kind === "ConnectCard" && c.status === "pending").map((c) => [c.copy_key, c.props["vendor"]]);
  assert.deepEqual([...connectors].sort(), [["assets.connect.purpose", "plaid_assets"], ["identity.stripe.purpose", "stripe_identity"], ["income.connect.purpose", "truv_income"]], `the three connectors once each: ${JSON.stringify(connectors)}`);
  for (const c of onApp.filter((x) => x.kind === "ConnectCard")) assert.equal(c.props["vendor_fake"], "FAKE");
  const pendingKeys = onApp.filter((c) => c.status === "pending").map((c) => c.copy_key);
  for (const key of ["refi.home.confirm", "refi.name.confirm", "value.confirm.title", "loan_amount.confirm.title", "refi.profile.confirm", "declarations.occupancy", "demographics.title", "consent.credit.title", "consent.esign.extend"]) assert.equal(pendingKeys.filter((k) => k === key).length, 1, `${key} once on the rail: ${pendingKeys.join(", ")}`);
  assert.equal(pendingKeys.filter((k) => k === "declarations.title").length, 0, "the list follows 5a.A and 5a.E (32.3 R5's sequence), never first");
  const valueCard = onApp.find((c) => c.copy_key === "value.confirm.title")!; assert.equal((valueCard.props["fields"] as Json[])[0]!["value"], "60500000", "the partner's value on the card (the AVM stand-in)");
  const amountCard = onApp.find((c) => c.copy_key === "loan_amount.confirm.title")!; assert.equal((amountCard.props["fields"] as Json[])[0]!["value"], String((opp["candidate_terms"] as Json)["loan_amount_cents"]), "the candidate's loan amount (20.1), never a computed one");
  const masked = onApp.find((c) => c.copy_key === "refi.ssn.confirm"); assert.ok(masked && masked.status !== "pending", "32.11's masked SSN-on-file card is withdrawn: the SSN is typed (rule 4)");
  // the first readiness row with the application (rule 4): account and payoff present now, the application-level items still to come
  const row = await latest(loan.id); assert.equal(row.application_id, app.id); assert.equal(row.ready, false); const st = statuses(row);
  assert.equal(st["payoff"], "present", "the facts' UPB once the application exists"); assert.equal(itemOf(row, "payoff").as_of, DEMO_AS_OF); assert.equal(st["account"], "present"); assert.equal(st["contact"], "present"); assert.equal(st["value"], "present");
  assert.deepEqual(row.missing, ["identity", "ssn", "income", "assets", "esign", "credit_authorization", "credit"]);
  const checked = await events("partner_book.readiness.checked", loan.id); assert.equal(checked.at(-1)!.payload["application_id"], app.id);
  // nothing ordered by the Yes itself (32.11 §5: data refreshed only after a Yes — by the borrower's taps, not by the opening)
  assert.equal((await appEvents(app.id, "credit.report.ordered")).length, 0); assert.equal((await appEvents(app.id, "verification.received")).length, 0);
  // a second Yes creates nothing more: the card answers idempotently, the bus tool returns the open application, one application, one opened event
  const again = await tapYes(b, offer); assert.ok(again.status === 200 || again.status === 201, JSON.stringify(again.body).slice(0, 300)); assert.equal(again.body["idempotent"], true);
  const tool = await runtime.execute({ process: "33.3", name: "refi.open", loanId: loan.id, actor: { kind: "agent", id: "refi-readiness" }, input: { loan_id: loan.id, opportunity_id: oppId }, run: { runId: "33.3-T2", modelVersion: "test", promptVersion: "test" } });
  const out = tool.output as Json; assert.equal(out["created"], false, "refi.open finds the open application"); assert.equal(out["application_id"], app.id); await settle();
  assert.equal((await applicationsOf(loan.id)).length, 1, "one application"); assert.equal((await events("partner_book.refinance.opened", loan.id)).length, 1); assert.equal((await events("refi.opportunity.converted", loan.id)).length, 1); assert.equal((await events("refi.opportunity.engaged", loan.id)).length, 1);
  assert.equal((await cardsOf(party.id)).filter((c) => c.kind === "ConnectCard" && c.status === "pending").length, 3, "no second set of connector cards");
});

test("33.3-T3: Given the open refinance application, when the homeowner completes the FAKE identity scan, types the SSN, connects Truv and Plaid on the FAKE and confirms the six items, then the readiness row is recomputed on each event, the missing list shrinks in order, `ready = true` once credit, income, assets, identity, ssn, esign and the hard-pull authorization are present, and 32.18's DU moment has run (`du.findings.received` on the application).", { skip }, async () => {
  const { maria } = await firstDay();
  const loan = await loanOf(1); const party = await partyOfLoan(loan.id);
  const app = (await applicationsOf(loan.id))[0]; assert.ok(app, "the open refinance application (T2)");
  const b: B = { token: maria.token, party_id: party.id, app_id: app.id, name: party.legal_name };
  const trail: ReadinessItemName[][] = [(await latest(loan.id)).missing];
  const rowsBefore = (await rowsOf(loan.id)).length;
  /** After each event: a new row on the application, its missing list a subset of the last one, in the order asked. */
  const recomputed = async (why: string, expectPresent: ReadinessItemName[]): Promise<ReadinessRow> => {
    const row = await latest(loan.id); assert.equal(row.application_id, app.id, why); assertAskOrder(row);
    const last = trail.at(-1)!; for (const m of row.missing) assert.ok(last.includes(m), `${why}: ${m} came back — ${JSON.stringify(last)} → ${JSON.stringify(row.missing)}`);
    for (const p of expectPresent) assert.equal(itemOf(row, p).status, "present", `${why}: ${p} present`); assert.ok(!row.missing.some((m) => expectPresent.includes(m)), why);
    trail.push(row.missing); return row;
  };
  // the FAKE identity scan (32.17 rule 19: finishing on the tap) → identity.verified → the row: identity present (valid_until = the ID's expiry, at or after the projected note date)
  await identity(b);
  const idv = await appEvents(app.id, "identity.verified"); assert.equal(idv.length, 1); assert.equal(idv[0]!.payload["all_borrowers_verified"], true);
  const r1 = await recomputed("after the scan", ["identity"]); const idItem = itemOf(r1, "identity"); assert.equal(idItem.source_table, "verifications"); assert.ok(idItem.valid_until! >= PROJECTED, `${idItem.valid_until} ≥ ${PROJECTED}`);
  assert.deepEqual(r1.missing, ["ssn", "income", "assets", "esign", "credit_authorization", "credit"]);
  const confirm = await pending(b, "identity.confirm.title"); assert.deepEqual(confirm.props["required_paths"], ["residency_basis", "months_at_address"], "32.3 E5: the residence asks on the card");
  await tap(b, confirm, fieldsEvidence(confirm, { residency_basis: "own", months_at_address: "72" }));   // 32.3 E5: the residence basis and the months on the same card
  assert.deepEqual(await db.query<{ residency_type: string; residency_basis: string; duration_months: number }>(`SELECT residency_type, residency_basis, duration_months FROM du_residences WHERE application_borrower_id = (SELECT id FROM application_borrowers WHERE application_id = $1 AND party_id = $2)`, [app.id, party.id]), [{ residency_type: "Current", residency_basis: "Own", duration_months: 72 }], "the tap wrote the Current du_residences row (23.5 writeResidence)");
  // the SSN typed (32.18 rule 1: the one typed field) → application.six_item.captured{ssn} → ssn present
  await typeSsn(b);
  assert.equal((await appEvents(app.id, "application.six_item.captured")).filter((e) => e.payload["item"] === "ssn").length, 1);
  assert.equal((await db.query<{ tin_last4: string | null }>(`SELECT tin_last4 FROM application_borrowers WHERE application_id = $1`, [app.id]))[0]!.tin_last4, "6789");
  const r2 = await recomputed("after the SSN", ["identity", "ssn"]); assert.deepEqual(r2.missing, ["income", "assets", "esign", "credit_authorization", "credit"]); assert.equal(itemOf(r2, "ssn").source_table, "application_borrowers");
  assert.equal((await appEvents(app.id, "credit.report.ordered")).length, 0, "nothing ordered before the six items (22.2 R1)");
  // Truv on the FAKE → verification.received{kind=income} → income present (the report dated today, within 120 days)
  const truv = await income(b); assert.equal(truv.body["delivery"], "FAKE");
  const inc = (await appEvents(app.id, "verification.received")).filter((e) => e.payload["kind"] === "income"); assert.equal(inc.length, 1);
  const r3 = await recomputed("after Truv", ["identity", "ssn", "income"]); assert.deepEqual(r3.missing, ["assets", "esign", "credit_authorization", "credit"]);
  const incItem = itemOf(r3, "income"); assert.equal(incItem.source_table, "verifications"); assert.equal(incItem.as_of, AS_OF); assert.equal(incItem.valid_until, "2027-01-13", "+120 days");
  await confirmIncome(b);
  // Plaid on the FAKE → verification.received{kind=assets, report_days=365} → assets present
  const plaid = await assets(b); assert.equal(plaid.body["delivery"], "FAKE"); assert.equal(plaid.body["outcome"], "connected");
  const ast = (await appEvents(app.id, "verification.received")).filter((e) => e.payload["kind"] === "assets"); assert.equal(ast.length, 1); assert.equal(ast[0]!.payload["report_days"], 365);
  const r4 = await recomputed("after Plaid", ["identity", "ssn", "income", "assets"]); assert.deepEqual(r4.missing, ["esign", "credit_authorization", "credit"]); assert.equal(itemOf(r4, "assets").as_of, AS_OF);
  // E-SIGN extended to the origination classes (32.11's card): affirmed → pending verification (still missing: rule 1 wants `active`); the demonstration test → active → present
  const esignCard = await pending(b, "consent.esign.extend"); const affirmed = await affirm(b, esignCard); const consentId = String((affirmed.body["result"] as Json)["consent_id"]);
  const pendingRow = (await db.query<{ status: string; scope: string[] }>(`SELECT status, scope FROM consents WHERE id = $1`, [consentId]))[0]!; assert.equal(pendingRow.status, "pending_verification"); assert.deepEqual(pendingRow.scope, ["disclosures", "notices"]);
  const r5 = await recomputed("after the E-SIGN affirmation", ["identity", "ssn", "income", "assets"]); assert.equal(itemOf(r5, "esign").status, "missing", "not active until the demonstration test");
  await verifyEsign(b, consentId);
  assert.equal((await db.query<{ status: string }>(`SELECT status FROM consents WHERE id = $1`, [consentId]))[0]!.status, "active"); assert.equal((await appEvents(app.id, "consent.esign.active")).length, 1);
  const r6 = await recomputed("after the E-SIGN verification", ["identity", "ssn", "income", "assets", "esign"]); assert.deepEqual(r6.missing, ["credit_authorization", "credit"]); assert.equal(itemOf(r6, "esign").source_id, consentId);
  // the hard-pull authorization (32.11's consent.credit card → 32.2 credit.authorize{hard_application} → 20.3's record on the lead) → credit_authorization present
  const creditCard = await pending(b, "consent.credit.title"); assert.equal((creditCard.props["command_args"] as Json)["authorization_kind"], "hard_application"); await affirm(b, creditCard);
  const authz = await appEvents(app.id, "credit.authorization.captured"); assert.ok(authz.length >= 1, "credit.authorization.captured");
  const lead = await entity("leads", app.id); assert.ok(((lead!["credit_authorizations"] as Json[]) ?? []).some((a) => a["kind"] === "hard_application"), "the hard_application authorization on the lead (20.3)");
  const r7 = await recomputed("after the authorization", ["identity", "ssn", "income", "assets", "esign", "credit_authorization"]); assert.deepEqual(r7.missing, ["credit"]); assert.equal(itemOf(r7, "credit_authorization").source_table, "leads");
  assert.equal((await appEvents(app.id, "credit.report.ordered")).length, 0, "the authorization alone orders nothing before the six items");
  // the six items confirmed (32.11 §3's compressed cards) → application.trid_received → the platform's one credit pull (32.18 rule 2) → credit present → ready
  await sixItems(b);
  assert.equal((await appEvents(app.id, "application.trid_received")).length, 1, "the six items are in");
  assert.equal((await appEvents(app.id, "credit.report.ordered")).length, 1, "one order on the six items"); assert.ok((await appEvents(app.id, "credit.report.received")).length >= 1, "the FAKE bureau answered");
  const report = (await entitiesOf("credit_reports", app.id))[0]!; assert.equal(report["state"], "usable"); assert.match(String(report["report_type"]), /^tri_merge/);
  const r8 = await recomputed("after the credit pull", [...REQUIRED_FOR_READY]);
  assert.equal(r8.ready, true, `ready once credit, income, assets, identity, ssn, esign and the hard-pull authorization are present: ${JSON.stringify(statuses(r8))}`); assert.deepEqual(r8.missing, []);
  const creditItem = itemOf(r8, "credit"); assert.equal(creditItem.source_table, "credit_reports"); assert.equal(creditItem.as_of, String(report["report_date"]).slice(0, 10)); assert.equal(creditItem.valid_until, String(report["expires_at"]).slice(0, 10)); assert.ok(creditItem.valid_until! >= String(addDays(plainDate(AS_OF), 45)), "room to close");
  // the missing list shrank in order on every event: each row's list a subset of the previous, never re-grown
  assert.equal(trail[0]!.length, 7); assert.equal(trail.at(-1)!.length, 0); for (let k = 1; k < trail.length; k += 1) assert.ok(trail[k]!.length <= trail[k - 1]!.length, JSON.stringify(trail));
  assert.ok((await rowsOf(loan.id)).length >= rowsBefore + 8, "a row per triggering event");
  const readyEvent = (await events("partner_book.readiness.checked", loan.id)).at(-1)!; assert.equal(readyEvent.payload["ready"], true); assert.deepEqual(readyEvent.payload["missing"], []);
  // 32.18's DU moment has run: du.findings.received on the application (once), the ChecklistCard on the record
  for (const type of ["du.casefile.created", "du.submitted", "du.findings.received", "du.findings.interpreted"]) assert.equal((await appEvents(app.id, type)).length, 1, `${type} once`);
  const findings = (await appEvents(app.id, "du.findings.received"))[0]!; assert.ok(findings.payload["recommendation"], "the FAKE findings");
  assert.equal((await entitiesOf("du_casefiles", app.id)).length, 1, "one casefile");
  assert.ok((await cardsOf(party.id)).some((c) => c.kind === "ChecklistCard" && c.subject_application_id === app.id), "the ChecklistCard of conditions (32.18)");
  // no readiness order: every vendor call on the application is the owning process's, on the borrower's taps
  assert.equal((await db.query(`SELECT 1 FROM agent_decisions WHERE agent = 'refi-readiness' AND action NOT IN ('readiness.check', 'readiness.run', 'readiness.read', 'refi.open')`)).length, 0);
});

test("33.3-T4: Given an identity verified on an earlier application with `valid_until` before the projected note date, then `identity` reads `stale` and the scan card is asked again; given a standing payroll connection, then `income` is refreshed by 22.3's order and no payroll card is asked.", { skip }, async () => {
  await firstDay();
  const loan = await loanOf(2); const party = await partyOfLoan(loan.id); const l2 = loanN(2); const oppId = oppOf(loan);
  assert.equal((await db.query<{ verdict: string }>(`SELECT verdict FROM partner_book_reviews WHERE loan_id = $1 AND as_of_date = $2`, [loan.id, AS_OF]))[0]!.verdict, "candidate", "loan 2 is the day's other candidate");
  // an earlier application of the party on the platform, its identity verified with valid_until = a note date (22.6: valid_until = scheduled_note_date) at or after today's
  // projected note date — present today (rule 4: not asked again) and stale two mornings later, when the projected note date passes it (the state machine's present → stale)
  const INTAKE = { kind: "agent" as const, id: "intake" };
  const earlier = await runtime.createApplication({ partner_party_id: partnerPartyId, channel: "refi_trigger", transaction_type: "limited_cash_out", occupancy: "primary", intake_channel: "web", interview_language: "en-US", prior_loan_id: null, borrowers: [{ legal_name: party.legal_name, borrower_role: "borrower" }], property: null }, INTAKE);
  const earlierApp = earlier.application.id; const abId = earlier.application.borrowers[0]!.id;
  await db.query(`UPDATE application_borrowers SET party_id = $2 WHERE id = $1`, [abId, party.id]);
  const VALID_UNTIL = "2026-10-31"; assert.ok(VALID_UNTIL >= PROJECTED, `${VALID_UNTIL} at or after today's projected note date ${PROJECTED}`);
  const DAY3 = "2026-09-17"; const NOW_DAY3 = "2026-09-17T11:20:00.000Z"; const PROJECTED_DAY3 = String(addDays(plainDate(DAY3), PROJECTED_NOTE_DAYS)); assert.ok(VALID_UNTIL < PROJECTED_DAY3, `${VALID_UNTIL} before ${DAY3}'s projected note date ${PROJECTED_DAY3}`);
  const v = await runtime.execute({ process: "22.6", name: "verifyIdentity", loanId: "", applicationId: earlierApp, actor: { kind: "agent", id: "fraud-risk" }, run: { runId: "33.3-T4", modelVersion: "test", promptVersion: "test" },
    input: { application_id: earlierApp, borrower_id: abId, method: "remote_doc_biometric", result: identityPass("S-earlier-1"), borrower_ids: [abId], scheduled_note_date: VALID_UNTIL, at: "2026-06-01T16:00:00.000Z" } });
  const vo = v.output as Json; assert.equal(vo["outcome"], "verified"); const verification = vo["verification"] as Json; assert.equal(String(verification["valid_until"]), VALID_UNTIL);
  await settle();
  // a standing payroll connection on the party (DELTA-05: consents{kind=blanket_verification_authorization, standing, active})
  const standingId = randomUUID();
  await db.query(`INSERT INTO consents (id, kind, granted, provenance, verified, captured_at, scope, status, disclosure_version_id, hw_sw_version, captured_via, application_id, loan_id, lead_id, party_id, purpose, disclosure_text_hash, standing, loan_ids) VALUES ($1, 'blanket_verification_authorization'::consent_kind, true, 'portal', true, $2, $3::text[], 'active', NULL, 'DELTA-05-standing-authorization-v1', 'portal', NULL, $4, NULL, $5, 'informational', NULL, true, $6::uuid[])`,
    [standingId, "2026-06-01T16:05:00.000Z", ["truv_income", "plaid_assets"], loan.id, party.id, [loan.id]]);
  // the homeowner of loan 2 signs in and says Yes
  const s = await signIn(l2.email!, "10.33.3.12"); assert.equal(s.party_id, party.id);
  const b: B = { token: s.token, party_id: party.id, app_id: "", name: party.legal_name };
  const offer = (await offerCards(party.id)).find((c) => c.props["flow_key"] === `offer:${oppId}`); assert.ok(offer, "loan 2's OfferCard"); assert.equal(offer.status, "pending");
  const yes = await tapYes(b, offer); assert.equal(yes.status, 201, JSON.stringify(yes.body).slice(0, 600));
  const apps = await applicationsOf(loan.id); assert.equal(apps.length, 1); const app = apps[0]!; b.app_id = app.id; assert.notEqual(app.id, earlierApp);
  assert.equal((await db.query<{ party_id: string | null }>(`SELECT party_id::text AS party_id FROM application_borrowers WHERE application_id = $1`, [app.id]))[0]!.party_id, party.id);
  // identity: present — the earlier application's verification is on file for the party within its validity (rule 4: not asked again): no scan card on the refinance application; the SSN card, the one typed field, opens at once
  const row = await latest(loan.id); assert.equal(row.application_id, app.id); assert.equal(row.ready, false);
  const idItem = itemOf(row, "identity"); assert.equal(idItem.status, "present"); assert.equal(idItem.source_table, "verifications"); assert.equal(idItem.source_id, String(verification["verification_id"])); assert.equal(idItem.valid_until, VALID_UNTIL); assert.equal(idItem.as_of, "2026-06-01");
  assert.ok(!row.missing.includes("identity"), `identity on file is not asked: ${JSON.stringify(row.missing)}`);
  let onApp = (await cardsOf(party.id)).filter((c) => c.subject_application_id === app.id);
  assert.equal(onApp.filter((c) => c.kind === "ConnectCard" && c.props["vendor"] === "stripe_identity").length, 0, "an identity verified on an earlier application within its validity is not asked again — no scan card");
  const ssnCard = onApp.find((c) => c.copy_key === "identity.ssn.title" && c.status === "pending"); assert.ok(ssnCard, `the SSN card pending at once: ${onApp.filter((c) => c.status === "pending").map((c) => c.copy_key).join(", ")}`); assert.equal((ssnCard.props["command_args"] as Json)["path"], "ssn");
  assert.equal((await appEvents(app.id, "identity.verified")).length, 0, "nothing verified on the new application");
  // income: refreshed by 22.3's order under the standing authorization (32.11 §5 / DELTA-05) — verification.ordered then verification.received{kind=income}, the row present; no payroll card
  const ordered = await appEvents(app.id, "verification.ordered"); assert.equal(ordered.length, 1, "22.3's order"); assert.equal(ordered[0]!.payload["component"], "income"); assert.equal(ordered[0]!.payload["authorization_consent_id"], standingId); assert.equal(ordered[0]!.payload["supplier_code"], "TRUV");
  const received = (await appEvents(app.id, "verification.received")).filter((e) => e.payload["kind"] === "income"); assert.equal(received.length, 1); assert.equal(received[0]!.payload["authorization_consent_id"], standingId);
  const incItem = itemOf(row, "income"); assert.equal(incItem.status, "present"); assert.equal(incItem.source_table, "verifications"); assert.equal(incItem.as_of, AS_OF);
  assert.ok(!row.missing.includes("income"), JSON.stringify(row.missing));
  assert.equal(onApp.filter((c) => c.kind === "ConnectCard" && c.props["vendor"] === "truv_income" && c.status === "pending").length, 0, "no payroll card asked");
  assert.ok(onApp.some((c) => c.copy_key === "income.confirm.title" && c.status === "pending" && c.props["standing_connection"] === true), "the income ConfirmCard from the refreshed report (a fresh statement — 21.2 rule 2)");
  assert.equal(itemOf(row, "verification_authorization").status, "present"); assert.equal(itemOf(row, "verification_authorization").source_id, standingId);
  assert.deepEqual(row.missing, ["ssn", "assets", "esign", "credit_authorization", "credit"]);
  // the record's current ask is the SSN card (rule 4: the first missing item's card)
  let rec = await record(loan); assert.ok(rec.readiness); assert.equal(rec.readiness.current_card_instance_id, ssnCard.card_instance_id); assert.equal(rec.readiness.missing[0], "ssn");
  // identity: stale — two mornings later the projected note date passes the verification's valid_until: the daily pass (it orders nothing) reads it stale, first in the order asked, and the scan card is asked once more (the flow's reaction to the checked row; the edge case)
  const before = await orders();
  const day3 = await readinessRun(runtime, NOW_DAY3, { logger: runtime.logger }); assert.ok(day3.ran, day3.skipped); assert.equal(day3.as_of_date, DAY3); await settle();
  const stale = await latest(loan.id); assert.equal(stale.as_of_date, DAY3); assert.equal(stale.application_id, app.id); assert.equal(stale.ready, false);
  const staleItem = itemOf(stale, "identity"); assert.equal(staleItem.status, "stale"); assert.equal(staleItem.source_id, String(verification["verification_id"])); assert.equal(staleItem.valid_until, VALID_UNTIL);
  assert.equal(stale.missing[0], "identity", `stale counts as missing, first in the order asked: ${JSON.stringify(stale.missing)}`); assert.deepEqual(stale.missing, ["identity", "ssn", "assets", "esign", "credit_authorization", "credit"]); assertAskOrder(stale);
  onApp = (await cardsOf(party.id)).filter((c) => c.subject_application_id === app.id);
  const scan = onApp.filter((c) => c.kind === "ConnectCard" && c.props["vendor"] === "stripe_identity" && c.status === "pending"); assert.equal(scan.length, 1, "the scan card asked once more"); assert.equal(scan[0]!.props["vendor_fake"], "FAKE"); assert.equal(scan[0]!.props["flow"], "33.3");
  assert.equal((await appEvents(app.id, "identity.verified")).length, 0, "nothing verified on the new application yet");
  const after = await orders(); for (const k of Object.keys(before).filter((x) => x !== "cards")) assert.equal(after[k], before[k], `the daily pass ordered no ${k}`); assert.equal(after["cards"], before["cards"]! + 1, "one card: the scan asked once more, nothing else");
  assert.ok(onApp.some((c) => c.card_instance_id === ssnCard.card_instance_id && c.status === "pending"), "the SSN card still pending");
  // the record's current ask is the scan card now (rule 4: identity → SSN → …)
  rec = await record(loan); assert.ok(rec.readiness); assert.equal(rec.readiness.current_card_instance_id, scan[0]!.card_instance_id); assert.equal(rec.readiness.missing[0], "identity");
  assert.equal((await appEvents(app.id, "credit.report.ordered")).length, 0, "nothing else ordered");
});

test("33.3-T5: Given the homeowner asks what is still needed, then the turn's situation carries `readiness{ready, missing}` and the reply names only the missing items in the copy library's words and points at the current card; given `ready = true`, then the reply says underwriting has what it needs and points at the checklist.", { skip }, async () => {
  const { maria } = await firstDay();
  const QUESTION = "What do you still need from me for the refinance?";
  const ask = async (token: string, ip: string, subject: Json): Promise<{ reply: Json; situation: Situation; turn: (typeof scripted.turns)[number] }> => {
    const before = scripted.requests.length; const turnsBefore = scripted.turns.length;
    const m = await api("POST", "/v1/borrower/messages", { text: QUESTION, subject }, bearer(token), ip);
    assert.equal(m.status, 200, JSON.stringify(m.body).slice(0, 600)); await settle();
    const turn = scripted.turns.slice(turnsBefore).find((t) => NEEDS_QUESTION.when.test(t.borrower)); assert.ok(turn, "the question reached the model"); assert.equal(turn.scene, NEEDS_QUESTION); assert.equal(turn.regenerated, false, "the guard accepted the reply");
    const request = scripted.requests.slice(before).find((q) => { const c = q.messages.at(-1)?.content; return typeof c === "string" && c.startsWith("[situation]") && NEEDS_QUESTION.when.test(parseSituation(c).borrower); }); assert.ok(request, "the turn's request");
    const situation = parseSituation(String(request.messages.at(-1)!.content)).situation;
    const reply = m.body["reply"] as Json; assert.equal(reply["sender"], "agent");
    return { reply, situation, turn };
  };
  const words = (key: string): string => { const t = copyText(key); assert.ok(t && !t.startsWith("{{copy:"), `${key} in the copy library`); return t; };
  // loan 2's homeowner (T4): not ready — identity stale, income refreshed — the situation carries readiness{ready:false, missing[]}; the reply names only the missing items, in the copy library's words, and points at the current card (the scan)
  const loan2 = await loanOf(2); const party2 = await partyOfLoan(loan2.id); const app2 = (await applicationsOf(loan2.id))[0]!; const row2 = await latest(loan2.id); assert.equal(row2.ready, false);
  const s2 = await signIn(loanN(2).email!, "10.33.3.22");
  const a = await ask(s2.token, "10.33.3.22", { application_id: app2.id });
  const readiness = (a.situation.record as Json)["readiness"] as Json; assert.ok(readiness, `readiness on the situation: ${Object.keys(a.situation.record ?? {}).join(",")}`);
  assert.equal(readiness["ready"], false); assert.deepEqual(readiness["missing"], row2.missing); assert.equal(readiness["has_application"], true);
  assert.deepEqual(readiness["copy_keys"], row2.missing.map((m) => READINESS_COPY_KEYS[m]), "one copy key per missing item, in order");
  const scan = (await cardsOf(party2.id)).find((c) => c.subject_application_id === app2.id && c.kind === "ConnectCard" && c.props["vendor"] === "stripe_identity" && c.status === "pending")!; assert.ok(scan);
  assert.equal(readiness["current_card_instance_id"], scan.card_instance_id, "the current ask: the first missing item's card"); assert.ok(a.situation.pending_cards.some((c) => c["card_instance_id"] === scan.card_instance_id), "the card in the situation's pending cards");
  assert.equal(readiness["as_of_date"], "{{readiness.as_of_date}}", "the date as a token"); assert.ok(a.situation.tokens_available.includes("readiness.as_of_date"));
  assert.ok(!JSON.stringify(readiness).match(/verifications|partner_book_facts|2026-|TRUV|Truv|plaid/i), "never a source row, a date of an item or a vendor name in the block");
  const text = String(a.reply["body_text"]); onlyTokens(a.turn.text, "the model's reply (tokens only)"); NO_FIGURE(text, "the reply as delivered");
  for (const m of row2.missing) assert.ok(text.includes(words(READINESS_COPY_KEYS[m])), `names ${m} in the copy library's words: ${text}`);
  for (const p of REQUIRED_FOR_READY.filter((x) => !row2.missing.includes(x))) assert.ok(!text.includes(words(READINESS_COPY_KEYS[p])), `never asks for ${p}, which is on file: ${text}`);
  assert.ok(!text.includes(words(READINESS_READY_KEY))); assert.match(text, /\bcard\b/i, `points at the current card: ${text}`); assert.ok(text.startsWith(`Still to do, ${party2.legal_name.split(" ")[0]}`), text);
  assert.equal((a.reply["subject"] as Json)["application_id"], app2.id, "the answer is on the refinance application");
  // the same block on the loan subject (mirrored under partner_book for the monitored loan)
  const onLoan = await ask(s2.token, "10.33.3.22", { loan_id: loan2.id });
  const pb = (onLoan.situation.record as Json)["partner_book"] as Json; assert.equal(pb["monitored"], true); assert.deepEqual((pb["readiness"] as Json)["missing"], row2.missing); assert.equal((pb["readiness"] as Json)["current_card_instance_id"], scan.card_instance_id);
  assert.deepEqual(((onLoan.situation.record as Json)["readiness"] as Json)["missing"], row2.missing);
  // loan 1's homeowner (T3): ready — the reply says underwriting has what it needs and points at the checklist
  const loan1 = await loanOf(1); const app1 = (await applicationsOf(loan1.id))[0]!; const row1 = await latest(loan1.id); assert.equal(row1.ready, true, "loan 1's file is ready (T3)");
  const m = await ask(maria.token, "10.33.3.11", { application_id: app1.id });
  const ready = (m.situation.record as Json)["readiness"] as Json; assert.ok(ready); assert.equal(ready["ready"], true); assert.deepEqual(ready["missing"], []); assert.deepEqual(ready["copy_keys"], [READINESS_READY_KEY]); assert.equal(ready["current_card_instance_id"], null, "nothing to ask");
  const readyText = String(m.reply["body_text"]); assert.equal(m.turn.text, READY_REPLY); NO_FIGURE(readyText, "the ready reply");
  assert.match(readyText, /underwriting has what it needs/i); assert.match(readyText, /checklist/i, `points at the checklist: ${readyText}`);
  assert.ok((await cardsOf((await partyOfLoan(loan1.id)).id)).some((c) => c.kind === "ChecklistCard" && c.subject_application_id === app1.id), "the checklist card is on the rail (32.18)");
  assert.doesNotMatch(readyText, /\bDU\b|approve|eligible|findings/i, "no DU word");
});

test("33.3-T6: Given a loan not a candidate, then no readiness row is written for it; given a funded refinance, then no further rows are written for that loan and the monitored loan reads `paid_off`.", { skip }, async () => {
  await firstDay();
  // loan 9 (watching on the day's review — 33.2-T3) is not a candidate: no readiness row, never in a day's receipt
  const loan9 = await loanOf(9);
  assert.equal((await db.query<{ verdict: string }>(`SELECT verdict FROM partner_book_reviews WHERE loan_id = $1 ORDER BY as_of_date DESC, created_at DESC LIMIT 1`, [loan9.id]))[0]!.verdict, "watching");
  assert.equal((await rowsOf(loan9.id)).length, 0, "no readiness row for loan 9"); assert.equal((await events("partner_book.readiness.checked", loan9.id)).length, 0);
  for (const e of await events("partner_book.readiness.run_completed")) assert.ok(!(e.payload["loans"] as Json[]).some((x) => x["loan_id"] === loan9.id), "never checked");
  assert.equal(await readinessRead(runtime, loan9.id), null);
  assert.ok(!(await readinessSubjects(db)).some((s) => s.loan_id === loan9.id), "not a subject of the pass");
  // the funded refinance (loan 1's application, ready and through the DU moment — T3): 30.2 boards the new loan from the demo snapshot the lifecycle tests fund with
  const loan = await loanOf(1); const app = (await applicationsOf(loan.id))[0]; assert.ok(app, "loan 1's refinance application");
  const rowsBefore = (await rowsOf(loan.id)).length; assert.ok(rowsBefore >= 3);
  assert.equal(loan.status, "monitored"); assert.ok((await readinessSubjects(db)).some((s) => s.loan_id === loan.id && s.application_id === app.id), "the open application is a subject before the funding");
  clock.set(NOW_FUNDING);
  const record = await runtime.applications.get(app.id); assert.ok(record);
  const funded = await fundApplication(runtime, app.id, demoSnapshot(record, { partner_name: DEMO_PARTNER.legal_name }), demoFunded(app.id), { kind: "agent", id: "funding" });
  assert.match(funded.status, /^boarded/, JSON.stringify(funded).slice(0, 600)); await settle();
  const after = (await db.query<AppRow>(`SELECT id::text AS id, channel::text AS channel, status::text AS status, transaction_type::text AS transaction_type, occupancy::text AS occupancy, prior_loan_id::text AS prior_loan_id, loan_id::text AS loan_id, intake_channel::text AS intake_channel, partner_party_id::text AS partner_party_id FROM applications WHERE id = $1`, [app.id]))[0]!;
  assert.equal(after.status, "funded"); assert.ok(after.loan_id, "the new loan boarded"); assert.notEqual(after.loan_id, loan.id);
  assert.equal((await appEvents(app.id, "loan.boarded")).length, 1); assert.equal((await appEvents(app.id, "loan.funded")).length, 1);
  assert.equal((await db.query<{ status: string }>(`SELECT status::text AS status FROM loans WHERE id = $1`, [after.loan_id]))[0]!.status, "active", "the refinance is a serviced loan now");
  // the monitored loan reads paid_off, with the receipt on the loan (rule 5)
  assert.equal((await db.query<{ status: string }>(`SELECT status::text AS status FROM loans WHERE id = $1`, [loan.id]))[0]!.status, "paid_off");
  const paid = await events(LOAN_PAID_OFF_EVENT, loan.id); assert.equal(paid.length, 1, "one paid-off receipt"); const pp = paid[0]!.payload;
  assert.equal(pp["loan_id"], loan.id); assert.equal(pp["application_id"], app.id); assert.equal(pp["new_loan_id"], after.loan_id); assert.equal(pp["status"], "paid_off"); assert.equal(pp["prior_status"], "monitored"); assert.equal(pp["origination"], true); assert.equal(pp["funding_date"], "2026-11-12");
  assert.equal(paid[0]!.actor_id, "refi-readiness");
  // no further rows for that loan: not a subject of the next morning's pass (the loan is not monitored, the application funded), the rows unchanged
  assert.equal((await rowsOf(loan.id)).length, rowsBefore, "the funding wrote no readiness row");
  assert.ok(!(await readinessSubjects(db)).some((s) => s.loan_id === loan.id), "no longer a subject");
  const next = await readinessRun(runtime, NOW_AFTER_FUNDING, { logger: runtime.logger }); assert.ok(next.ran, next.skipped); assert.equal(next.as_of_date, "2026-11-13");
  assert.equal((await rowsOf(loan.id)).length, rowsBefore, "no further rows for the funded loan");
  const receipt = (await events("partner_book.readiness.run_completed")).find((e) => e.payload["as_of_date"] === "2026-11-13")!; assert.ok(receipt);
  assert.ok(!(receipt.payload["loans"] as Json[]).some((x) => x["loan_id"] === loan.id), "the funded loan is not in the day's receipt");
  const loan2 = await loanOf(2); assert.ok((receipt.payload["loans"] as Json[]).some((x) => x["loan_id"] === loan2.id), "loan 2's open refinance is still checked"); assert.equal((await rowsOf(loan9.id)).length, 0);
  assert.equal((await timers("SM_PARTNER_BOOK_READINESS_DAILY")).filter((t) => t.status === "armed").length, 1, "the daily clock re-armed once");
  // the situation stops carrying readiness for a loan that is no longer monitored (the rows stay for the examiner)
  const party1 = await partyOfLoan(loan.id);
  const rec = await new BorrowerRecordReader(db).record(party1, subjectFor({ ...loan, status: "paid_off" }), await ui().cardsOf(party1.id), clock.now());
  assert.equal(rec.partner_book?.readiness ?? null, null);
  // rule 5's other half: the homeowner of loan 2 withdraws the open refinance application (32.2 application.withdraw: the event only — nothing on the platform writes applications.status
  // for a withdrawal) → readiness rows stop for that application; the loan returns to the daily review (its latest verdict still candidate) with no application on its row
  const app2 = (await applicationsOf(loan2.id)).find((a) => a.status !== "funded"); assert.ok(app2, "loan 2's open refinance application (T4)");
  const s2 = await signIn(loanN(2).email!, "10.33.3.62");
  const w = await api("POST", "/v1/borrower/commands/application.withdraw", { application_id: app2.id, reason: "We decided not to refinance right now" }, bearer(s2.token), "10.33.3.62"); assert.equal(w.status, 200, JSON.stringify(w.body).slice(0, 600)); await settle();
  assert.equal((await appEvents(app2.id, "application.withdrawn")).length, 1, "the withdrawal logged");
  assert.equal((await db.query<{ status: string }>(`SELECT status::text AS status FROM applications WHERE id = $1`, [app2.id]))[0]!.status, "started", "no status written for a withdrawal: openness is judged by the event");
  const rows2Before = (await rowsOf(loan2.id)).length;
  assert.equal(await openRefinanceApplication(db, loan2.id), null, "no open refinance application on the loan");
  const subject2 = (await readinessSubjects(db)).find((x) => x.loan_id === loan2.id); assert.ok(subject2, "the loan stays a subject: its latest review verdict is candidate"); assert.equal(subject2.application_id, null); assert.equal(subject2.why, "candidate");
  // a late triggering event on the withdrawn application writes no row (22.6 verifies the identity on it)
  const ab2 = (await db.query<{ id: string }>(`SELECT id::text AS id FROM application_borrowers WHERE application_id = $1 ORDER BY created_at LIMIT 1`, [app2.id]))[0]!.id;
  const late = await runtime.execute({ process: "22.6", name: "verifyIdentity", loanId: "", applicationId: app2.id, actor: { kind: "agent", id: "fraud-risk" }, run: { runId: "33.3-T6", modelVersion: "test", promptVersion: "test" },
    input: { application_id: app2.id, borrower_id: ab2, method: "remote_doc_biometric", result: identityPass("S-late-1"), borrower_ids: [ab2], scheduled_note_date: "2027-01-15", at: clock.now() } });
  assert.equal((late.output as Json)["outcome"], "verified"); await settle();
  assert.equal((await appEvents(app2.id, "identity.verified")).length, 1); assert.equal((await rowsOf(loan2.id)).length, rows2Before, "no readiness row for the withdrawn application");
  // the next morning's pass: the loan's row carries no application (the candidate branch), none names the withdrawn one
  const afterWithdrawal = await readinessRun(runtime, "2026-11-14T12:20:00.000Z", { logger: runtime.logger }); assert.ok(afterWithdrawal.ran, afterWithdrawal.skipped); assert.equal(afterWithdrawal.as_of_date, "2026-11-14");
  const row2 = await latest(loan2.id); assert.equal(row2.as_of_date, "2026-11-14"); assert.equal(row2.application_id, null, "the candidate's row, no application"); assert.equal(itemOf(row2, "payoff").status, "not_applicable");
  assert.ok(!(await rowsOf(loan2.id)).some((r) => r.application_id === app2.id && r.as_of_date > "2026-11-13"), "no row names the withdrawn application after the withdrawal");
  const receipt2 = (await events("partner_book.readiness.run_completed")).find((e) => e.payload["as_of_date"] === "2026-11-14")!; assert.ok(receipt2);
  const entry2 = (receipt2.payload["loans"] as Json[]).find((x) => x["loan_id"] === loan2.id); assert.ok(entry2, "loan 2 in the day's receipt"); assert.equal(entry2["application_id"], null); assert.equal(entry2["why"], "candidate");
  // the bus tool resolves the loan the same way: readiness.check with no application given finds none open
  const chk = await runtime.execute({ process: "33.3", name: "readiness.check", loanId: loan2.id, actor: { kind: "agent", id: "refi-readiness" }, input: { loan_id: loan2.id }, run: { runId: "33.3-T6", modelVersion: "test", promptVersion: "test" } });
  assert.equal((chk.output as Json)["application_id"], null);
});
