// 32.12 Exits
// spec/sections/32-borrower-experience/32-12-exits.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// Every T-id drives the real runtime over HTTP: the journey fixture boards the refinance (20.x → 21.x → 23.x → 26.x →
// 30.2), then the owning servicing tools run on the bus — 16.1 (the statement and its update), 16.2 (funds, shortage,
// paid in full, housekeeping), 16.3 (the California trustee release), 17.1 / 17.2 / 17.3 (the transfer out, the goodbye
// run's proofs of mailing, a post-transfer receipt), 4.4 / 4.2 (a confirmed successor's own request) — with the Timer
// Engine arming and satisfying the registry's clocks and the Notice Registry rendering every notice. The 32.12 flow
// (src/runtime/borrower/flows/12-exits.ts) reacts to the committed events; the tests read the borrower API (record,
// thread, cards, documents, messages) and the tables. What the borrower SEES of these facts is asserted on the real
// components in apps/borrower/tests/cards/flow-12-exits.test.tsx. Skips without a database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { connect, reachable, type Db } from "../../infra/db/client.ts";
import { acquireJourneyLock, type TestLock } from "../../infra/db/test-lock.ts";
import { decodeEntityData } from "../../infra/db/entities.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock } from "../../kernel/events/index.ts";
import type { Actor } from "../../kernel/events/index.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { Runtime } from "../../runtime/app.ts";
import { createApiServer, listen } from "../../runtime/server.ts";
import { createLogger } from "../../runtime/log.ts";
import { createBorrowerRouter, type BorrowerRouter } from "../../runtime/borrower/routes.ts";
import { Journey, OFFICER, CASHIERING } from "../../runtime/borrower/fixtures/journey.ts";
import { SECTION_04_CASE_COMMANDS } from "../../app/tools/section04.ts";
import { FIGURE_KEYS } from "../payoff/ops-16-1.ts";
import { NOTICE_CODES_32_12 } from "../../runtime/borrower/flows/12-exits.ts";
import type { FakeCustodian } from "../../infra/integrations/custody.ts";

const DB_URL = process.env["TEST_DATABASE_URL"] ?? "postgresql://sm:sm@localhost/supermortgage_test";
const up = await reachable(DB_URL);
if (!up && process.env["REQUIRE_DB"]) throw new Error(`REQUIRE_DB set but ${DB_URL} is not reachable`);
const skip = up ? false : `no Postgres at ${DB_URL}`;
const TOKEN = "ops-" + randomUUID();
const clock = new FixedClock("2026-09-10T16:00:00.000Z");
const PAYOFF = { kind: "agent" as const, id: "payoff-release" }; const TRANSFER = { kind: "agent" as const, id: "transfer" }; const CASE_AGENT = { kind: "agent" as const, id: "case" };
const PROPERTY = "100 N Central Ave, Phoenix, AZ 85004";
const UPB = 55_945_571n;   // the UPB after the Jan 1, 2027 installment (journey.firstPayment)

let journeyLock: TestLock | undefined;
let db: Db; let runtime: Runtime; let router: BorrowerRouter; let base = ""; let close: () => Promise<void> = async () => undefined; let partnerPartyId = "";

test.before(async () => {
  if (skip) return;
  journeyLock = await acquireJourneyLock(DB_URL);
  execFileSync(fileURLToPath(new URL("../../../db/migrate.sh", import.meta.url)), { env: { ...process.env, DATABASE_URL: DB_URL }, stdio: "pipe" });
  db = connect(DB_URL);
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock });
  const logger = createLogger("json", (line) => { if (process.env["FLOW_DEBUG"] && /flow|ERROR/.test(line)) process.stderr.write(line + "\n"); });
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
type P = Record<string, unknown>;
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
const tick = (now: string) => { clock.set(now); return router.flows!.tick(now); };
const record = async (email: string, subject: string): Promise<P> => { await settle(); const r = await api("GET", `/v1/borrower/record?subject=${subject}`, undefined, (await signIn(email)).token); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 600)); return r.body; };
const thread = async (email: string): Promise<P[]> => { await settle(); const r = await api("GET", "/v1/borrower/thread?limit=500", undefined, (await signIn(email)).token); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300)); return r.body["messages"] as P[]; };
interface CardRow { card_instance_id: string; party_id: string; kind: string; status: string; copy_key: string; props: P; created_at: string }
const cardsOf = async (loanId: string, partyId?: string): Promise<CardRow[]> => { await settle(); return db.query<CardRow & Record<string, unknown>>(`SELECT card_instance_id, party_id, kind, status, copy_key, props, created_at FROM card_instances WHERE subject_loan_id = $1 AND ($2::uuid IS NULL OR party_id = $2) ORDER BY created_at, card_instance_id`, [loanId, partyId ?? null]); };
const events = (loanId: string, type?: string) => db.query<{ type: string; occurred_at: string; payload: P }>(`SELECT type, occurred_at, payload FROM loan_events WHERE loan_id = $1 AND ($2::text IS NULL OR type = $2) ORDER BY sequence`, [loanId, type ?? null]);
const timer = async (loanId: string, code: string) => (await db.query<{ status: string; due_at: string | null; due_date: string | null }>(`SELECT status::text AS status, due_at, due_date::text AS due_date FROM timers WHERE loan_id = $1 AND code = $2 ORDER BY armed_at DESC LIMIT 1`, [loanId, code]))[0];
const batchTimer = async (batchId: string, code: string) => (await db.query<{ status: string; due_at: string | null; due_date: string | null }>(`SELECT status::text AS status, due_at, due_date::text AS due_date FROM timers WHERE subject_id = $1 AND code = $2 ORDER BY armed_at DESC LIMIT 1`, [batchId, code]))[0];
const entity = async (kind: string, id: string): Promise<P | null> => { const rows = await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = $1 AND id = $2`, [kind, id]); return rows[0] ? decodeEntityData(rows[0].data) : null; };
const badge = (rec: P) => rec["status"] as { badge: string; state_source: string; one_liner: string; one_liner_tokens?: Record<string, string> };
const dates = (rec: P) => rec["dates"] as { timer_code: string; label: string; due_at: string; status: string }[];
const card = (cards: CardRow[], key: string, partyId?: string): CardRow | undefined => cards.find((c) => c.copy_key === key && (!partyId || c.party_id === partyId));
const tokens = (c: CardRow | undefined): Record<string, string> => ((c?.props["copy_tokens"] as Record<string, string> | undefined) ?? {});
const caseCmd = (loanId: string, process: string, name: string, input: P, actor: Actor = CASE_AGENT) => { const def = SECTION_04_CASE_COMMANDS.find((d) => d.process === process && d.name === name)!; return runtime.executeDef(def, { loanId, actor, input, run: { runId: "test:32.12", modelVersion: "test", promptVersion: "test" } }); };
/** The caller's display fields for a statement send: the authored sample payload minus every figure key (16.1 guardrail: figures come only from payoff_quotes). */
const DISPLAY = (code: string, on: string): P => Object.fromEntries(Object.entries(runtime.noticeRegistry.activeVersion(code, D(on))!.samplePayload).filter(([k]) => !(FIGURE_KEYS as readonly string[]).includes(k)));
const sample = (code: string, on: string): P => runtime.noticeRegistry.activeVersion(code, D(on))!.samplePayload as P;

// ---------------------------------------------------------------- the boarded loan (the journey through 30.2 and the Jan 1, 2027 installment)
interface Boarded { j: Journey; A: string; B: string; partyA: string; partyB: string; loanId: string }
async function boardLoan(): Promise<Boarded> {
  const R = randomUUID().slice(0, 8); const A = `alex-${R}@example.test`; const B = `blake-${R}@example.test`;
  const j = new Journey({ runtime, db, base, token: TOKEN, clock, borrowerEmail: A, coBorrowerEmail: B, partnerPartyId });
  await j.seedBook(); await j.openApplication();
  const partyA = (await signIn(A)).party_id; const partyB = (await signIn(B)).party_id;
  await j.interview(); await j.quoteAndLe(); await j.recordIntent(); await j.quoteForLock(); await j.requestLock(); await j.executeLockAndCommit(); await j.verifyDecideAndClear(); await j.clearToClose();
  await j.scheduleClosing(); await j.closingDisclosure(); await j.closeAndSign(); await j.fund();
  const loanId = await j.board(); await settle(); await j.firstPayment(); await settle();
  return { j, A, B, partyA, partyB, loanId };
}
const loanAcct = (loanId: string, account: string) => ({ scope: "loan" as const, loanId, account: account as "principal" });
const cust = (id: string, account: string) => ({ scope: "custodial" as const, custodialAccountId: id, account: account as "clearing_cash" });
/** 2.1's receipt of funds into clearing / suspense (the journey's own posting). */
async function receive(b: Boarded, cents: bigint, on: string, description: string): Promise<void> {
  await runtime.execute({ process: "2.1", name: "ledger.post", loanId: b.loanId, actor: CASHIERING, input: { loan_id: b.loanId, via: "payment.post", entry_set: { effectiveDate: on, description, lines: [{ account: cust(b.j.custodial.clearing, "clearing_cash"), amountCents: cents, ruleRef: "2.1:r8:receipt" }, { account: loanAcct(b.loanId, "suspense_unapplied"), amountCents: -cents, ruleRef: "2.1:r8:receipt" }] } } });
}
const escrowBalance = async (loanId: string): Promise<bigint> => -BigInt((await db.query<{ s: string }>(`SELECT coalesce(sum(amount_cents), 0)::text AS s FROM ledger_lines WHERE scope = 'loan' AND loan_id = $1 AND account = 'escrow'`, [loanId]))[0]!.s);
const ex = async (process: string, name: string, loanId: string, input: P, actor: Actor = PAYOFF) => runtime.execute({ process, name, loanId, actor, input });

/** 7.6 / 16.1: the typed (written) payoff request — `payoff.request.received{written}` starts the §1026.36(c)(3) clock (REGZ_1026_36C3_PAYOFF_STMT_7BD). */
interface Statement { quoteId: string; statementId: string; noticeId: string; total: bigint; interest: bigint; perDiem: bigint; goodThrough: string; recipients: P[]; receivedOn: string }
async function requestStatement(b: Boarded, o: { goodThrough: string; receivedOn: string; suffix?: string }): Promise<Omit<Statement, "noticeId">> {
  const { loanId, partyA, partyB } = b; const sfx = o.suffix ?? ""; const quoteId = `pq-${loanId.slice(0, 8)}${sfx}`; const requestId = `pr-${loanId.slice(0, 8)}${sfx}`; const statementId = `ps-${loanId.slice(0, 8)}${sfx}`;
  clock.set(`${o.receivedOn}T16:00:00.000Z`);
  const quote = await ex("16.1", "computePayoffQuote", loanId, { loan_id: loanId, quote_id: quoteId, request_id: requestId, quote_type: "statement", channel: "portal", written: true, received_on: o.receivedOn, received_at: `${o.receivedOn}T16:00:00.000Z`, requester_type: "borrower", borrower_party_ids: [partyA, partyB], delivery_channel_requested: "portal", upb_cents: UPB, rate_pct: "6.125", lpi_due: "2027-01-01", good_through: o.goodThrough, state: "AZ", ledger_snapshot_id: `ledger-${loanId.slice(0, 8)}${sfx}-1` });
  const q = quote.output as { total_cents: bigint; interest_cents: bigint; per_diem_cents: bigint };
  await settle();
  return { quoteId, statementId, total: q.total_cents, interest: q.interest_cents, perDiem: q.per_diem_cents, goodThrough: o.goodThrough, recipients: [{ party_id: partyA, channel: "portal", name: "Alex Borrower", email: b.A, address: PROPERTY }], receivedOn: o.receivedOn };
}
/** 16.1: the statement rendered behind the accuracy and wire-verify gates and sent through the Notice Registry to the borrower of record (inside the 7 servicer business days). */
async function sendStatement(b: Boarded, r: Omit<Statement, "noticeId">, on: string): Promise<Statement> {
  const { loanId } = b; const { quoteId, statementId, recipients } = r;
  clock.set(`${on}T16:00:00.000Z`);
  const hash = String((await entity("payoff_quotes", quoteId))!["hash"]);
  const tok = (await ex("16.1", "mintVerificationToken", loanId, { loan_id: loanId, statement_hash: hash, wire_instruction_version_id: "wire-v4" })).output as { token: string };
  await ex("16.1", "assertAccuracyGate", loanId, { loan_id: loanId, quote_id: quoteId, ledger_clean: true, rate_segments_final: true });
  await ex("16.1", "renderStatement", loanId, { loan_id: loanId, quote_id: quoteId, statement_id: statementId, wire_instruction_version_id: "wire-v4", active_wire_instruction_version_id: "wire-v4", verification_token: tok.token, state: "AZ", escrow_balance_cents: await escrowBalance(loanId) });
  const sent = await ex("16.1", "sendNotice", loanId, { loan_id: loanId, template_code: NOTICE_CODES_32_12.payoff_statement, statement_id: statementId, recipients, payload: DISPLAY(NOTICE_CODES_32_12.payoff_statement, on) });
  await settle();
  return { ...r, noticeId: String((sent.output as P)["notice_id"]) };
}
const requestAndSendStatement = async (b: Boarded, goodThrough = "2027-02-05"): Promise<Statement> => sendStatement(b, await requestStatement(b, { goodThrough, receivedOn: "2027-01-20" }), "2027-01-22");
/** 16.2: the wire arrives short of the statement total (received into 2.1 suspense, matched, the variance disposed, the demand letter rendered). */
async function shortFunds(b: Boarded, s: Statement, shortBy: bigint, on: string): Promise<{ fundsId: string; amount: bigint; demand: P }> {
  const amount = s.total - shortBy; clock.set(`${on}T16:00:00.000Z`);
  await receive(b, amount, on, `receipt payoff wire ${on}`);
  const matched = await ex("16.2", "matchPayoffFunds", b.loanId, { loan_id: b.loanId, amount_cents: amount, method: "wire", received_at: `${on}T16:00:00.000Z`, bank_reference: `${s.quoteId}-${on}`, remittance_type: "AA" });
  await settle();
  const d = await ex("16.2", "disposeVariance", b.loanId, { loan_id: b.loanId, amount_cents: amount, exact_total_cents: s.total, reliance_state: false, within_good_through: true, received_on: on, state: "AZ", remitter: "borrower", per_diem_cents: s.perDiem });
  assert.equal((d.output as P)["demand"], true, "a $300 shortage is past the tolerance: a demand within 1 BD");
  clock.set(`${on}T18:00:00.000Z`);
  const demand = await ex("16.2", "disposeVariance", b.loanId, { op: "demand", loan_id: b.loanId, amount_cents: amount, exact_total_cents: s.total, received_on: on, recipients: [{ partyId: b.partyA, name: "Alex Borrower", mailingAddress: PROPERTY }], addressee_role: "borrower", per_diem_cents: s.perDiem, state: "AZ", borrower_name: "Alex Borrower", property_address: PROPERTY });
  await settle();
  return { fundsId: String((matched.output as P)["funds_id"]), amount, demand: demand.output as P };
}

// ═══════════════════════════════════ Journey 1: the statement, the uncured shortage (the loan stays open), the confirmed successor
const j1: { b?: Boarded; s?: Statement; updatedId?: string } = {};

test("32.12-T1: Given a typed payoff request, then `NTC_REGZ_36C3_PAYOFF_STMT` renders within 7 servicer business days with the components, good-through date and the positive-confirmation text; a rate change before funds → `NTC_PAYOFF_UPDATED_STMT`.", { skip }, async () => {
  const b = await boardLoan(); j1.b = b; const { loanId, partyA, A } = b;
  // the typed request Wed Jan 20, 2027: 16.1 records `payoff.request.received{written}` and the Timer Engine arms the §1026.36(c)(3) clock — 7 servicer business days → Fri Jan 29 (the Record's Dates row, label from the allow-list)
  const requested = await requestStatement(b, { goodThrough: "2027-02-05", receivedOn: "2027-01-20" });
  const armed = await timer(loanId, "REGZ_1026_36C3_PAYOFF_STMT_7BD"); assert.ok(armed, "REGZ_1026_36C3_PAYOFF_STMT_7BD armed on payoff.request.received{written}"); assert.equal(armed!.status, "armed"); assert.equal(armed!.due_date, "2027-01-29");
  clock.set("2027-01-21T16:00:00.000Z");
  const before = await record(A, loanId); const row = dates(before).find((d) => d.timer_code === "REGZ_1026_36C3_PAYOFF_STMT_7BD"); assert.ok(row, "the Dates row for the statement clock"); assert.equal(row!.label, "Payoff statement by"); assert.equal(row!.due_at, armed!.due_at);
  // the statement Fri Jan 22 (renderStatement behind the accuracy and wire-verify gates, sendNotice through the Notice Registry): the clock is satisfied on day 2 of 7
  const s = await sendStatement(b, requested, "2027-01-22"); j1.s = s;
  assert.equal((await timer(loanId, "REGZ_1026_36C3_PAYOFF_STMT_7BD"))!.status, "satisfied");
  const sentEv = (await events(loanId, "payoff.statement.sent")).at(-1)!; assert.equal(sentEv.payload["template"], NOTICE_CODES_32_12.payoff_statement); assert.equal(sentEv.payload["notice_id"], s.noticeId);
  // the rendered notice (the Notice Registry's own text, kept for the runtime): the components, the good-through date, the positive-confirmation rule
  const rendered = runtime.noticeMemory.get(s.noticeId)!; assert.ok(rendered, "the rendered statement"); assert.equal(rendered.templateCode, NOTICE_CODES_32_12.payoff_statement);
  assert.match(rendered.rendered.text, /February 5, 2027|2027-02-05/, "good-through date"); assert.match(rendered.rendered.text, /never change wire instructions/i, "the positive-confirmation rule"); assert.match(rendered.rendered.text, /\$559,455\.71/, "the principal component");
  // the Thread: the NoticeCard for NTC_REGZ_36C3_PAYOFF_STMT and the components card with the confirmation line, both from 16.1's rows — no client-side arithmetic
  const cards = await cardsOf(loanId, partyA);
  const notice = cards.find((c) => c.kind === "NoticeCard" && c.props["notice_code"] === NOTICE_CODES_32_12.payoff_statement); assert.ok(notice, `the payoff statement NoticeCard: ${cards.map((c) => c.copy_key).join(",")}`); assert.equal(notice!.status, "resolved", "informational: never the pinned ask");
  assert.equal(notice!.props["good_through"], "2027-02-05"); assert.equal(notice!.props["amount_cents"], s.total.toString());
  const components = card(cards, "payoff.statement.components", partyA); assert.ok(components, "the components StatusCard");
  const t = tokens(components); assert.equal(t["principal"], "$559,455.71"); assert.equal(t["good_through"], "2027-02-05"); assert.equal(t["total"], new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(s.total) / 100)); assert.equal(t["interest"], new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(s.interest) / 100)); assert.ok(t["per_diem"]);
  assert.equal(components!.props["detail_copy_key"], "payoff.wire_confirm"); assert.equal(components!.props["positive_confirmation"], true);
  const docs = (await record(A, loanId))["documents"] as P[]; assert.ok(docs.some((d) => d["notice_code"] === NOTICE_CODES_32_12.payoff_statement), "the statement in Documents");
  // a rate change before funds (Mon Jan 25: the ARM change 16.1 recomputes on): Δ ≠ 0 → `payoff.statement.updated`, the update sent to every prior recipient as NTC_PAYOFF_UPDATED_STMT
  clock.set("2027-01-25T16:00:00.000Z");
  const rc = await ex("16.1", "scheduleRecompute", loanId, { loan_id: loanId, statement_id: s.statementId, trigger_event: "arm.rate_change.effective", occurred_on: "2027-01-25", ledger_snapshot_id: `ledger-${loanId.slice(0, 8)}-2`, reason: "the note rate changed to 6.375% on January 25, 2027 (ARM change)", rate_pct: "6.375" });
  const upd = (rc.output as { updated: { id: string } | null }).updated; assert.ok(upd, "a rate change moves the total: an updated statement"); assert.ok((await events(loanId, "payoff.statement.updated")).length >= 1); j1.updatedId = upd!.id;
  const upSent = await ex("16.1", "sendNotice", loanId, { loan_id: loanId, template_code: NOTICE_CODES_32_12.payoff_updated, statement_id: upd!.id, recipients: s.recipients, payload: DISPLAY(NOTICE_CODES_32_12.payoff_updated, "2027-01-25") });
  await settle();
  const upNoticeId = String((upSent.output as P)["notice_id"]); assert.ok((await events(loanId, "notice.sent")).some((e) => e.payload["template"] === NOTICE_CODES_32_12.payoff_updated));
  const updated = card(await cardsOf(loanId, partyA), "payoff.statement.updated", partyA); assert.ok(updated, "the NTC_PAYOFF_UPDATED_STMT NoticeCard"); assert.equal(updated!.props["notice_code"], NOTICE_CODES_32_12.payoff_updated); assert.equal(updated!.props["rendered_document_id"], upNoticeId);
  assert.match(tokens(updated)["reason"]!, /6\.375%/); assert.notEqual(updated!.props["amount_cents"], s.total.toString(), "a new total"); assert.equal(updated!.props["trigger_event"], "arm.rate_change.effective");
  assert.ok(String(updated!.props["plain_language"]).length > 0, "the template's own plain-language text on the card");
});

test("32.12-T2: Given funds $300 short of the good-through figure, then `NTC_PAYOFF_SHORTAGE_DEMAND` renders; cured → `paid_in_full`; uncured at day 30 → funds applied per the note and the loan stays open with a `StatusCard` explaining.", { skip }, async () => {
  const b = j1.b!; const s = j1.s!; const { loanId, partyA, A } = b;
  // Mon Feb 1, 2027: the wire arrives $300.00 short of the updated good-through figure → NTC_PAYOFF_SHORTAGE_DEMAND (16.2 rule 5: nothing applied during the cure window)
  const total = BigInt(String((await entity("payoff_statement_updates", j1.updatedId!))!["total_cents"]));
  const { amount, demand } = await shortFunds(b, { ...s, total }, 30_000n, "2027-02-01");
  assert.equal(demand["template"], NOTICE_CODES_32_12.shortage_demand); assert.equal(demand["shortage_cents"], 30_000n); assert.equal(demand["uncured_on"], "2027-03-03");
  const uncured = await timer(loanId, "SM_PAYOFF_SHORTAGE_UNCURED_30"); assert.equal(uncured!.status, "armed"); assert.equal(uncured!.due_date, "2027-03-03");
  const cards = await cardsOf(loanId, partyA);
  const funds = card(cards, "payoff.funds_received", partyA); assert.ok(funds, "funds received StatusCard"); assert.equal(tokens(funds)["date"], "2027-02-01");
  const shortage = card(cards, "payoff.shortage", partyA); assert.ok(shortage, "the NTC_PAYOFF_SHORTAGE_DEMAND NoticeCard"); assert.equal(shortage!.props["notice_code"], NOTICE_CODES_32_12.shortage_demand);
  assert.equal(tokens(shortage)["money"], "$300.00"); assert.equal(tokens(shortage)["date"], demand["cure_by"]); assert.equal((shortage!.props["copy_token_keys"] as P)["reason"], "payoff.shortage.reason.amount"); assert.match(String(shortage!.props["plain_language"]), /\$300\.00/);
  assert.equal(badge(await record(A, loanId)).badge, "Paying off");
  // day 20 (Sun Feb 21): the scheduled pass says what happens at day 30 — the funds go to the loan under the note and the loan stays open
  await tick("2027-02-21T15:00:00.000Z");
  const day20 = card(await cardsOf(loanId, partyA), "payoff.shortage.day20", partyA); assert.ok(day20, "the day-20 StatusCard"); assert.equal(tokens(day20)["date"], "2027-03-03"); assert.equal(tokens(day20)["money"], "$300.00");
  // day 30 (Wed Mar 3) uncured: 16.2 applies the funds per the note — the installment first, the rest a curtailment — the loan stays active; the StatusCard explains
  clock.set("2027-03-03T16:00:00.000Z");
  const applied = await ex("16.2", "disposeVariance", loanId, { op: "apply_per_note", loan_id: loanId, received_on: "2027-02-01", today: "2027-03-03", funds_cents: amount, installments: [{ due_on: "2027-02-01", amount_cents: 409_012n, interest_cents: 285_556n }, { due_on: "2027-03-01", amount_cents: 409_012n, interest_cents: 284_925n }], reliance_state: false });
  assert.equal((applied.output as P)["loan_status"], "active"); await settle();
  const resolved = (await events(loanId, "payoff.shortage.resolved")).at(-1)!; assert.equal(resolved.payload["outcome"], "applied_per_note"); assert.equal(resolved.payload["loan_status"], "active");
  assert.equal((await timer(loanId, "SM_PAYOFF_SHORTAGE_UNCURED_30"))!.status, "satisfied"); assert.equal((await events(loanId, "loan.paid_in_full")).length, 0, "not paid in full");
  const explain = card(await cardsOf(loanId, partyA), "payoff.shortage.applied_per_note", partyA); assert.ok(explain, "the StatusCard explaining the application per the note"); assert.equal(explain!.props["loan_status"], "active"); assert.equal(tokens(explain)["date"], "2027-03-03");
  const rec = await record(A, loanId); assert.notEqual(badge(rec).badge, "Paid off"); assert.notEqual(badge(rec).badge, "Paying off"); assert.equal(rec["read_only"], false, "the loan stays open");
  // the cured branch is Journey 2 (T3): the same shortage cured on day 5 → `payoff.shortage.resolved{outcome=cured}` → paid in full
});

test("32.12-T7: Given a confirmed successor who declined borrower notices, then no statements are sent to them, but an RFI they submit is acknowledged and answered on the 4.2 clocks.", { skip }, async () => {
  const b = j1.b!; const s = j1.s!; const { loanId, partyA, A } = b;
  // 4.4 on the open loan: the successor (their own sign-in is their party) confirmed by the case agent — the loan_parties{confirmed_successor} row the borrower surface reads — and the acknowledgment returned declining the borrower's notices
  const S = `sam-${loanId.slice(0, 8)}@example.test`; const partyS = (await signIn(S)).party_id; const caseId = `sii-${loanId.slice(0, 8)}`;
  clock.set("2027-03-08T16:00:00.000Z");
  await caseCmd(loanId, "4.4", "sii.open", { case_id: caseId, notice_source: "call", transfer_type: "death_relative", notice_date: "2027-03-08" });
  await caseCmd(loanId, "4.4", "sii.determine", { case_id: caseId, determination: "confirmed", transfer_type: "death_relative", party_id: partyS });
  await caseCmd(loanId, "4.4", "sii.acknowledgment.return", { case_id: caseId, elected_notices: false, via: "form" });
  await settle();
  assert.equal((await db.query(`SELECT 1 FROM loan_parties WHERE loan_id = $1 AND party_id = $2 AND role = 'confirmed_successor' AND ended_at IS NULL`, [loanId, partyS])).length, 1, "the 4.4 confirmation wrote the scoped role");
  assert.equal(((await record(S, loanId))["subject"] as P)["loan_id"], loanId, "the successor's sign-in sees the loan (loan_parties{confirmed_successor})");
  const declined = card(await cardsOf(loanId, partyS), "successor.notices_declined", partyS); assert.ok(declined, "the choice acknowledged in the successor's thread"); assert.equal(declined!.props["elected_notices"], false);
  // no statements to the successor: a further statement update (a fee assessed after the application per the note) reaches the borrower and not the successor; the successor's Documents carry no statement
  const again = await sendStatement(b, await requestStatement(b, { goodThrough: "2027-03-31", receivedOn: "2027-03-09", suffix: "-2" }), "2027-03-09");
  const succCards = await cardsOf(loanId, partyS);
  assert.equal(succCards.filter((c) => /STMT/.test(String(c.props["notice_code"] ?? "")) && c.status !== "cancelled").length, 0, `no statement card stands for the successor who declined: ${JSON.stringify(succCards.map((c) => [c.copy_key, c.status]))}`);
  assert.ok((await cardsOf(loanId, partyA)).some((c) => c.copy_key === "payoff.statement" && c.props["rendered_document_id"] === again.noticeId), "the borrower of record still gets the statement");
  assert.ok(s);
  const succDocs = (await record(S, loanId))["documents"] as P[]; assert.equal(succDocs.filter((d) => /STMT/.test(String(d["notice_code"] ?? ""))).length, 0, "no statements in the successor's Documents");
  // the successor's own request for information (32.2 case.open{rfi}): 4.2 opens it with requester_role=confirmed_successor — the ack clock (5 federal BD) and the response clock (30 federal BD) from the receipt date
  clock.set("2027-03-10T16:00:00.000Z");
  const opened = await api("POST", "/v1/borrower/commands/case.open", { kind: "rfi", text: "Please send me the payment history for this loan.", subject: { loan_id: loanId } }, (await signIn(S)).token);
  assert.equal(opened.status, 200, JSON.stringify(opened.body).slice(0, 400)); await settle();
  const rfiOpened = (await events(loanId, "case.rfi.opened")).at(-1)!; assert.ok(rfiOpened, "4.2 rfi.open ran on the successor's case"); assert.equal(rfiOpened.payload["requester_role"], "confirmed_successor"); assert.equal(rfiOpened.payload["receipt_date"], "2027-03-10");
  const rfiId = String(rfiOpened.payload["case_id"]);
  const ack = await timer(loanId, "REGX_1024_36C_RFI_ACK_5"); assert.ok(ack, "REGX_1024_36C_RFI_ACK_5 armed"); assert.equal(ack!.due_date, "2027-03-17", "5 federal business days from Wed Mar 10");
  const response = await timer(loanId, "REGX_1024_36D_RFI_RESPONSE_30"); assert.ok(response, "REGX_1024_36D_RFI_RESPONSE_30 armed"); assert.equal(response!.due_date, "2027-04-21", "30 federal business days from Mar 10");
  // acknowledged the same day through the Notice Registry (NTC_REGX_36C_ACK satisfies the ack clock) — the card to the successor, and only to them
  assert.equal(ack!.status, "satisfied", "the acknowledgment satisfied the 5-day clock");
  const ackEv = (await events(loanId, "notice.sent")).find((e) => e.payload["template"] === NOTICE_CODES_32_12.rfi_ack)!; assert.ok(ackEv, "notice.sent{NTC_REGX_36C_ACK}");
  const ackCard = card(await cardsOf(loanId, partyS), "case.ack.notice", partyS); assert.ok(ackCard, "the acknowledgment NoticeCard"); assert.equal(ackCard!.props["notice_code"], NOTICE_CODES_32_12.rfi_ack); assert.equal(tokens(ackCard)["due"], "2027-04-21"); assert.equal(ackCard!.props["requester_role"], "confirmed_successor");
  assert.equal(card(await cardsOf(loanId, partyA), "case.ack.notice", partyA), undefined, "the borrower of record does not get the successor's acknowledgment");
  const succDocs2 = (await record(S, loanId))["documents"] as P[]; assert.ok(succDocs2.some((d) => d["notice_code"] === NOTICE_CODES_32_12.rfi_ack), "the successor's own acknowledgment in their Documents");
  // answered on the 4.2 clock (Mon Mar 22): the payment history with the deceased borrower's SSN / contact / financial data redacted (§1024.36(d)(3)), the response event satisfying the 30-day clock
  clock.set("2027-03-22T16:00:00.000Z");
  await caseCmd(loanId, "4.2", "rfi.item.determine", { case_id: rfiId, item_id: "1", determination: "provided" });
  const redaction_log = [{ field: "other_borrower.ssn", rule: "other_borrowers.personal_financial" }, { field: "other_borrower.phone", rule: "other_borrowers.location_contact" }];
  await caseCmd(loanId, "4.2", "rfi.respond", { case_id: rfiId, item_ids: ["1"], response_data: { loan_terms: { rate_pct: "6.125", maturity: "2056-12-01" }, status: "active", payment_history: [{ on: "2026-12-30", amount_cents: "409012" }], other_borrower: {} }, redaction_log, template: NOTICE_CODES_32_12.rfi_response });
  await settle();
  const responded = (await events(loanId, "case.rfi.responded")).at(-1)!; assert.equal(responded.payload["redaction_check_passed"], true); assert.equal((await timer(loanId, "REGX_1024_36D_RFI_RESPONSE_30"))!.status, "satisfied");
  const answered = card(await cardsOf(loanId, partyS), "successor.rfi_answered", partyS); assert.ok(answered, "the answer NoticeCard to the successor"); assert.equal(answered!.props["notice_code"], NOTICE_CODES_32_12.rfi_response); assert.equal(answered!.props["redaction_check_passed"], true); assert.equal(tokens(answered)["date"], "2027-03-10");
  assert.equal(card(await cardsOf(loanId, partyA), "successor.rfi_answered", partyA), undefined);
  assert.ok(A);
});

// ═══════════════════════════════════ Journey 2: the cured shortage → paid in full Mar 3 → escrow refund, autopay, rate-watch → the California trustee release → closed
const j2: { b?: Boarded; s?: Statement; settlementId?: string; enrollmentId?: string; documentId?: string; tasks?: string[] } = {};

test("32.12-T3: Given `paid_in_full` on Mar 3, then the escrow refund is scheduled by Mar 23 (`REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD`), autopay is `terminated`, and rate-watch is `void`.", { skip }, async () => {
  const b = await boardLoan(); j2.b = b; const { j, loanId, partyA, A } = b;
  // autopay on the loan (the borrower's own enrollment through 32.2 → 2.3) and a document of the borrower's on file (T8 reads it back after the close)
  clock.set("2027-01-05T16:00:00.000Z");
  const fresh = await signIn(A);
  const enrolled = await api("POST", "/v1/borrower/commands/autodraft.enroll", { account: { last4: "6789", type: "checking" }, draft_day: 1, amount_rule: "contractual", elements_displayed: true, subject: { loan_id: loanId } }, fresh.token);
  assert.equal(enrolled.status, 200, JSON.stringify(enrolled.body).slice(0, 400)); const enrollmentId = String((enrolled.body["result"] as P)["enrollment_id"]); j2.enrollmentId = enrollmentId;
  const upload = await api("POST", "/v1/borrower/documents", { application_id: j.appId, filename: "homeowners-policy.pdf", mime_type: "application/pdf", content_base64: Buffer.from("%PDF-1.4 FAKE homeowners policy").toString("base64"), document_class: "homeowners_policy" }, fresh.token);
  assert.equal(upload.status, 201, JSON.stringify(upload.body).slice(0, 400)); j2.documentId = String(upload.body["document_id"]);
  // the statement (Jan 22, good through Mar 5), the wire $300 short on Fri Feb 26, cured Wed Mar 3 → `payoff.shortage.resolved{outcome=cured}` → the full amount posts to zero on Mar 3
  const s = await requestAndSendStatement(b, "2027-03-05"); j2.s = s;
  const { amount } = await shortFunds(b, s, 30_000n, "2027-02-26");
  clock.set("2027-03-03T16:00:00.000Z");
  await receive(b, 30_000n, "2027-03-03", "receipt payoff shortage cure");
  const cured = await ex("16.2", "disposeVariance", loanId, { loan_id: loanId, amount_cents: amount, exact_total_cents: s.total, reliance_state: false, within_good_through: true, received_on: "2027-02-26", per_diem_cents: s.perDiem, cure_received_cents: 30_000n, cure_received_on: "2027-03-03", state: "AZ", remitter: "borrower" });
  assert.equal((cured.output as P)["outcome"], "cured"); await settle();
  assert.ok(card(await cardsOf(loanId, partyA), "payoff.shortage.cured", partyA), "the cure StatusCard");
  const matched = await ex("16.2", "matchPayoffFunds", loanId, { loan_id: loanId, amount_cents: s.total, method: "wire", received_at: "2027-03-03T16:00:00.000Z", bank_reference: `${s.quoteId}-cure`, remittance_type: "AA" });
  const escrow = await escrowBalance(loanId);
  const posted = await ex("16.2", "postPayoff", loanId, { loan_id: loanId, funds_id: (matched.output as P)["funds_id"], amount_cents: s.total, payoff_date: "2027-03-03", remittance_type: "AA", escrowed: true, autodraft: true, mi_active: false, buckets: { accrued_interest: s.interest, principal: UPB, escrow_balance: escrow }, custodial_pi_id: j.custodial.pi, custodial_ti_id: j.custodial.ti, custodial_clearing_id: j.custodial.clearing });
  const pif = posted.events.find((e) => e.type === "loan.paid_in_full")!; assert.ok(pif, "loan.paid_in_full"); assert.equal(pif.payload["payoff_date"], "2027-03-03"); assert.equal(pif.payload["escrowed"], true);
  const settlementId = String((posted.output as P)["settlement_id"]); j2.settlementId = settlementId; await settle();
  // the escrow refund clock: REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD armed on loan.paid_in_full{escrowed} from the Mar 3 posting date — the engine's date renders in Dates and on the StatusCard, never a computed one
  const refund = await timer(loanId, "REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD"); assert.ok(refund, "the refund clock armed"); assert.equal(refund!.status, "armed"); assert.match(refund!.due_date!, /^2027-03-/);
  const rec = await record(A, loanId); assert.equal(badge(rec).badge, "Paid off"); assert.equal(badge(rec).one_liner, "payoff.paid_in_full"); assert.equal(badge(rec).one_liner_tokens?.["date"], refund!.due_date);
  const refundRow = dates(rec).find((d) => d.timer_code === "REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD"); assert.ok(refundRow, "Escrow refund by in Dates"); assert.equal(refundRow!.label, "Escrow refund by"); assert.equal(refundRow!.due_at, refund!.due_at);
  const refundCard = card(await cardsOf(loanId, partyA), "payoff.escrow_refund", partyA); assert.ok(refundCard, "the escrow refund StatusCard"); assert.equal(tokens(refundCard)["date"], refund!.due_date); assert.equal(refundCard!.props["next_event_at"], refund!.due_at); assert.equal(refundCard!.props["next_event_label"], "Escrow refund by");
  assert.equal(tokens(refundCard)["money"], new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(escrow) / 100));
  // housekeeping (16.2): the autodraft stop terminates the 2.3 enrollment{reason=payoff}; the refund disbursement satisfies the clock
  const tasks = (await ex("16.2", "createHousekeepingTasks", loanId, { settlement_id: settlementId, loan_id: loanId, payoff_date: "2027-03-03", escrowed: true, mi_active: false, autodraft: true, fnma_advance_repay_cents: 0n })).output as { task: string; due_on: string }[];
  j2.tasks = tasks.map((t) => t.task); assert.ok(j2.tasks.includes("autodraft_stop") && j2.tasks.includes("escrow_refund") && j2.tasks.includes("paid_in_full_letter"), j2.tasks.join(","));
  assert.equal(tasks.find((t) => t.task === "escrow_refund")!.due_on, refund!.due_date, "16.2's refund task due date is the same 20-day clock");
  await ex("16.2", "createHousekeepingTasks", loanId, { op: "complete", settlement_id: settlementId, loan_id: loanId, task: "autodraft_stop", enrollment_id: enrollmentId, evidence_document_id: "doc-stop-1" });
  await settle();
  const terminated = (await events(loanId, "autodraft.enrollment.terminated")).at(-1)!; assert.equal(terminated.payload["reason"], "payoff"); assert.equal(terminated.payload["enrollment_id"], enrollmentId);
  assert.equal((await entity("autodraft_enrollments", enrollmentId))!["status"], "terminated");
  const loanSection = (await record(A, loanId))["loan"] as P; assert.equal((loanSection["autodraft"] as P)["status"], "terminated"); assert.equal((loanSection["autodraft"] as P)["terminated_on"], "2027-03-03");
  assert.ok(card(await cardsOf(loanId, partyA), "payoff.autopay_terminated", partyA), "autopay terminated StatusCard");
  clock.set("2027-03-10T16:00:00.000Z");
  await ex("16.2", "createHousekeepingTasks", loanId, { op: "complete", settlement_id: settlementId, loan_id: loanId, task: "escrow_refund", disbursement_id: `disb-refund-${loanId.slice(0, 8)}`, amount_cents: escrow, evidence_document_id: "doc-refund-1" });
  await settle();
  assert.equal((await timer(loanId, "REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD"))!.status, "satisfied", "disbursement.issued{kind=payoff_refund} satisfies the clock");
  const sentCard = card(await cardsOf(loanId, partyA), "payoff.escrow_refund.sent", partyA); assert.ok(sentCard); assert.equal(tokens(sentCard)["date"], "2027-03-10");
  // rate-watch is void: the Record hides offers and reports the block as void; the StatusCard says so
  const after = await record(A, loanId); assert.deepEqual(after["offers"], []); assert.equal(((after["loan"] as P)["ratewatch_status"]), "void");
  assert.ok(card(await cardsOf(loanId, partyA), "payoff.ratewatch_ended", partyA), "rate-watch ended StatusCard");
});

test("32.12-T4: Given a California trustee-path release, then the `NTC_LIEN_RELEASE_RECORDED` copy explains the reconveyance path and Dates shows the state deadline.", { skip }, async () => {
  const b = j2.b!; const { j, loanId, partyA, A } = b; const settlementId = j2.settlementId!;
  // 16.3 on the Mar 3 payoff: a California deed of trust with a third-party trustee → the request for full reconveyance path; STATE_LIEN_RELEASE_DEADLINE (CA: 30 calendar days → Apr 2) and CA_CC2941_TRUSTEE_DELIVERY_30 arm
  clock.set("2027-03-04T16:00:00.000Z");
  const min = (j as unknown as { MIN: string }).MIN;
  // the FAKE custodian holds the note and deed of trust under the loan's Fannie Mae number (the 16.3 custody request reads the port)
  (runtime.ports.custodian as FakeCustodian).holdingsByLoan.set("1234567890", { fnmaLoanNumber: "1234567890", custodianLoanId: `C-${loanId.slice(0, 8)}`, status: "certified", exceptions: [], documents: ["note", "security_instrument"] });
  const sel = await ex("16.3", "selectReleaseInstrument", loanId, { loan_id: loanId, state: "CA", county: "Los Angeles", security_instrument: "deed_of_trust", mortgagee_of_record: "mers", min_active: true, mers_registered: true, min, fnma_loan_number: "1234567890", payoff_on: "2027-03-03", settlement_id: settlementId, payoff_evidence_document_id: `doc-payoff-${loanId.slice(0, 8)}` });
  const rid = String((sel.output as P)["release_task_id"]); await settle();
  const opened = (await events(loanId, "lien_release.task_opened")).at(-1)!; assert.equal(opened.payload["state"], "CA"); assert.equal(opened.payload["recording_path"], "trustee_third_party");
  const deadline = await timer(loanId, "STATE_LIEN_RELEASE_DEADLINE"); assert.ok(deadline, "STATE_LIEN_RELEASE_DEADLINE armed"); assert.equal(deadline!.due_date, "2027-04-02"); assert.equal(deadline!.status, "armed");
  const trustee30 = await timer(loanId, "CA_CC2941_TRUSTEE_DELIVERY_30"); assert.ok(trustee30, "CA_CC2941_TRUSTEE_DELIVERY_30 armed"); assert.equal(trustee30!.due_date, "2027-04-02");
  const rec = await record(A, loanId); const row = dates(rec).find((d) => d.timer_code === "STATE_LIEN_RELEASE_DEADLINE"); assert.ok(row, "the state deadline in Dates"); assert.equal(row!.label, "Lien release recorded by"); assert.equal(row!.due_at, deadline!.due_at);
  assert.ok(dates(rec).some((d) => d.timer_code === "CA_CC2941_TRUSTEE_DELIVERY_30" && d.label === "Release papers to the trustee by"), "the CA trustee delivery clock in Dates");
  const openedCard = card(await cardsOf(loanId, partyA), "payoff.lien_release.opened", partyA); assert.ok(openedCard); assert.equal(tokens(openedCard)["date"], "2027-04-02"); assert.equal(openedCard!.props["recording_path"], "trustee_third_party");
  // the trustee path: originals from the custodian, the request for reconveyance drafted, checked, executed, delivered to the trustee (the beneficiary's §2941 duty — both clocks satisfied), the trustee's reconveyance recorded
  const cr = await ex("16.3", "requestCustodyDocuments", loanId, { loan_id: loanId, release_task_id: rid, state: "CA", payoff_on: "2027-03-03", fnma_loan_number: "1234567890" });
  clock.set("2027-03-11T16:00:00.000Z"); await ex("16.3", "requestCustodyDocuments", loanId, { op: "received", custody_request_id: (cr.output as P)["custody_request_id"], received_on: "2027-03-11" });
  await ex("16.3", "draftReleaseInstrument", loanId, { release_task_id: rid, borrower_names: ["Alex Borrower", "Blake Borrower"], property_address: "FAKE 1 Sunset Blvd, Los Angeles CA 90028", original_recording_reference: "FAKE Instrument No. 20261110-0001", original_recording_date: "2026-11-10", county: "Los Angeles", original_lender: "Partner Bank", partner_name: "Partner Bank" });
  const ALL_PRESENT = Object.fromEntries(["instrument_title", "min", "fnma_loan_number", "original_recording_reference", "legal_description", "borrower_names_as_recorded", "property_address_apn", "full_satisfaction_statement", "signatory_block", "notary_acknowledgment_form", "pria_cover_sheet", "return_to_address", "fees_from_recorder_schedule"].map((k) => [k, true]));
  await ex("16.3", "runReleaseChecklist", loanId, { release_task_id: rid, present: ALL_PRESENT, county_requires_legal_description: true });
  await ex("16.3", "routeForExecution", loanId, { release_task_id: rid });
  clock.set("2027-03-15T18:00:00.000Z"); await ex("16.3", "scheduleNotarySession", loanId, { release_task_id: rid, recording_state: "CA", op: "completed", signing_officer_id: "so-1", audit_trail: "journal", executed_document: "request for full reconveyance /s/" });
  clock.set("2027-03-16T18:00:00.000Z"); const del = await ex("16.3", "submitRecording", loanId, { release_task_id: rid, op: "trustee_delivery", delivery_evidence_document_id: "doc-courier-1" });
  assert.equal((del.output as P)["statutory_duty"], "satisfied"); await settle();
  assert.equal((await timer(loanId, "STATE_LIEN_RELEASE_DEADLINE"))!.status, "satisfied", "CA §2941(b)(1): delivery to the trustee is the beneficiary's duty"); assert.equal((await timer(loanId, "CA_CC2941_TRUSTEE_DELIVERY_30"))!.status, "satisfied");
  assert.ok(card(await cardsOf(loanId, partyA), "payoff.lien_release.delivered", partyA), "the delivery StatusCard");
  clock.set("2027-03-26T18:00:00.000Z"); const recd = await ex("16.3", "submitRecording", loanId, { release_task_id: rid, op: "trustee_recorded", recording_reference: "FAKE Doc No. 20270326-0001", recorded_on: "2027-03-26", recorded_image: "%PDF FAKE reconveyance" });
  // NTC_LIEN_RELEASE_RECORDED with the recorded image, to the borrower of record: the card explains the trustee's reconveyance path and carries the recording reference
  clock.set("2027-03-29T16:00:00.000Z");
  const ntc = await ex("16.3", "notifyBorrower", loanId, { loan_id: loanId, release_task_id: rid, op: "release_recorded", recorded_document_id: (recd.output as P)["recorded_document_id"], consent_on_file: true, recipients: [{ partyId: partyA, name: "Alex Borrower", mailingAddress: PROPERTY }], payload: sample(NOTICE_CODES_32_12.lien_release_recorded, "2027-03-29") });
  assert.equal((ntc.output as P)["template"], NOTICE_CODES_32_12.lien_release_recorded); await settle();
  assert.ok((await events(loanId, "lien_release.borrower_notified")).length >= 1);
  const notice = card(await cardsOf(loanId, partyA), "payoff.lien_release", partyA); assert.ok(notice, "the NTC_LIEN_RELEASE_RECORDED NoticeCard"); assert.equal(notice!.props["notice_code"], NOTICE_CODES_32_12.lien_release_recorded);
  assert.equal(notice!.props["recording_path"], "trustee_third_party"); assert.equal((notice!.props["copy_token_keys"] as P)["path"], "payoff.lien_release.trustee", "the reconveyance path explained"); assert.equal(tokens(notice)["reference"], "FAKE Doc No. 20270326-0001"); assert.equal(tokens(notice)["date"], "2027-03-26"); assert.equal(tokens(notice)["state"], "CA");
  assert.ok(String(notice!.props["plain_language"]).length > 0, "the template's own text");
  const docs = (await record(A, loanId))["documents"] as P[]; assert.ok(docs.some((d) => d["notice_code"] === NOTICE_CODES_32_12.lien_release_recorded), "the recorded release notice in Documents");
});

test("32.12-T8: Given `closed`, then the Record is read-only, documents remain downloadable, and a new typed question still creates a case.", { skip }, async () => {
  const b = j2.b!; const { loanId, partyA, A } = b; const settlementId = j2.settlementId!;
  // the remaining housekeeping tasks close with their evidence — the paid-in-full letter through the Notice Registry — and the settlement is closed
  clock.set("2027-03-30T16:00:00.000Z");
  for (const task of j2.tasks!.filter((t) => !["autodraft_stop", "escrow_refund"].includes(t))) {
    const input: P = { op: "complete", settlement_id: settlementId, loan_id: loanId, task, evidence_document_id: `doc-${task}-1` };
    if (task === "short_year_statement") input["statement_document_id"] = "doc-sys-1";
    if (task === "paid_in_full_letter") Object.assign(input, { recipients: [{ partyId: partyA, name: "Alex Borrower", mailingAddress: PROPERTY }], letter: { release_county: "Los Angeles", release_days: 30, release_cite: "Cal. Civ. Code §2941", release_by: "2027-04-02", property_address: "FAKE 1 Sunset Blvd, Los Angeles CA 90028" }, mi_active: false, autodraft: true, custodial_ti_id: b.j.custodial.ti });
    await ex("16.2", "createHousekeepingTasks", loanId, input);
  }
  await settle();
  const done = new Set((await events(loanId, "payoff.housekeeping.completed")).map((e) => String(e.payload["task"]))); for (const t of j2.tasks!) assert.ok(done.has(t), `task ${t} completed`);
  assert.ok((await events(loanId, "notice.sent")).some((e) => e.payload["template"] === NOTICE_CODES_32_12.paid_in_full), "NTC_PAYOFF_PAID_IN_FULL sent");
  const cards = await cardsOf(loanId, partyA); assert.ok(card(cards, "payoff.paid_in_full", partyA), "the paid-in-full NoticeCard"); const closed = card(cards, "closed", partyA); assert.ok(closed, "the closed StatusCard"); assert.equal(closed!.props["read_only"], true);
  // the Record: badge Closed, read-only; the borrower's own document and the notices stay downloadable
  const rec = await record(A, loanId); assert.equal(badge(rec).badge, "Closed"); assert.equal(badge(rec).one_liner, "closed"); assert.equal(rec["read_only"], true);
  const docs = rec["documents"] as P[]; assert.ok(docs.some((d) => d["document_id"] === j2.documentId), "the borrower's uploaded policy is still listed"); assert.ok(docs.some((d) => d["notice_code"] === NOTICE_CODES_32_12.paid_in_full)); assert.ok(docs.some((d) => d["notice_code"] === NOTICE_CODES_32_12.payoff_statement));
  const tok = (await signIn(A)).token;
  const link = await api("GET", `/v1/borrower/documents/${j2.documentId}`, undefined, tok); assert.equal(link.status, 200, JSON.stringify(link.body).slice(0, 300)); assert.equal(link.body["document_id"], j2.documentId);
  const content = await fetch(base + String(link.body["url"]), { headers: { authorization: `Bearer ${tok}` } }); assert.equal(content.status, 200, "the bytes behind the signed URL"); assert.match(await content.text(), /FAKE homeowners policy/);
  // a typed question on the closed loan still creates a case (the Thread stays open; RFI / NoE rights survive per 4.x)
  const before = (await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM loan_events WHERE loan_id = $1 AND type = 'case.opened'`, [loanId]))[0]!.n;
  const msg = await api("POST", "/v1/borrower/messages", { text: "Is there anything else I need to do now that the loan is closed?", subject: { loan_id: loanId } }, tok);
  assert.equal(msg.status, 200, JSON.stringify(msg.body).slice(0, 400)); await settle();
  const reply = msg.body["reply"] as P; assert.equal(reply["copy_key"], "closed.question_logged"); assert.equal(msg.body["command_executed"], true); assert.equal(msg.body["command"], "case.open");
  const opened = (await events(loanId, "case.opened")).at(-1)!; assert.equal(opened.payload["case_type"], "general_inquiry"); assert.equal(Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM loan_events WHERE loan_id = $1 AND type = 'case.opened'`, [loanId]))[0]!.n), Number(before) + 1);
  const cases = await api("GET", `/v1/borrower/history/cases?subject=${loanId}`, undefined, tok); assert.equal(cases.status, 200); assert.ok((cases.body["rows"] as P[]).some((c) => c["kind"] === "general_inquiry"), "the case in the cases view");
  const msgs = await thread(A); assert.ok(msgs.some((m) => m["body_text"] === "{{copy:closed.question_logged}}"), "the reply in the Thread");
});

// ═══════════════════════════════════ Journey 3: the transfer out — the combined goodbye mailed Sep 16, 2027 for the Oct 1 transfer; the Oct 14 receipt forwarded and protected; day 61
const j3: { b?: Boarded; batchId?: string } = {};
const TRANSFEREE = { name: "FAKE Northwind Servicing", address: "FAKE 1 Servicer Way, Testville TX 75001", remittance_address: "FAKE PO Box 9, Testville TX 75001", tollfree: "800-555-0100" };

test("32.12-T5: Given a goodbye notice mailed Sep 16 for an Oct 1 transfer, then `REGX_1024_33B3_COMBINED_15` is satisfied, the badge and Dates update, and autopay shows its end date (1.3 T1).", { skip }, async () => {
  const b = await boardLoan(); j3.b = b; const { j, loanId, partyA, A } = b;
  clock.set("2027-01-05T16:00:00.000Z");
  const enrolled = await api("POST", "/v1/borrower/commands/autodraft.enroll", { account: { last4: "4321", type: "checking" }, draft_day: 1, amount_rule: "contractual", elements_displayed: true, subject: { loan_id: loanId } }, (await signIn(A)).token);
  assert.equal(enrolled.status, 200, JSON.stringify(enrolled.body).slice(0, 300));
  // 17.1: the transfer-out batch to the first Fannie Mae business day of October 2027, approved with the combined notice mode — `transfer.batch.approved{direction=out, notice_mode=combined, respa_effective_date}` arms REGX_1024_33B3_COMBINED_15 (due Sep 16) on the batch
  const batchId = `B-out-${loanId.slice(0, 8)}`; j3.batchId = batchId;
  clock.set("2027-08-02T16:00:00.000Z");
  await j.tool({}, "17.1", "buildTransferPlan", { op: "propose", batch_id: batchId, partner_id: j.PARTNER_ID, transfer_type: "sub_to_sub", transfer_date: "2027-10-01", source: "partner_instruction", loan_count: 1, transferee_servicer_number: "987654321" }, TRANSFER);
  await j.tool({}, "17.1", "buildTransferPlan", { op: "milestone", batch_id: batchId, to: "plan_approved" }, OFFICER);
  await j.tool({}, "17.1", "buildTransferPlan", { op: "milestone", batch_id: batchId, to: "package_ready", evidence: { form629_document_id: "doc-629", custodian_matrix_document_id: "doc-cm", loan_list_version: 1, subservicer_answer_recorded: true, special_notifications_listed: true, form101_termination_draft_document_id: "doc-101" } }, TRANSFER);
  await j.tool({}, "17.1", "buildTransferPlan", { op: "milestone", batch_id: batchId, to: "submitted", evidence: { portal_completion_record_id: "pcr-1", qx_request_id: "QX-1" } }, TRANSFER);
  clock.set("2027-08-20T16:00:00.000Z");
  const approved = await j.tool({}, "17.1", "buildTransferPlan", { op: "milestone", batch_id: batchId, to: "approved", notice_mode: "combined", installments_due_on_1st: true, evidence: { approval_letter_document_hash: "sha256:fake-approval", d_code: "D12" } }, OFFICER);
  assert.ok((approved.output["events"] as string[]).includes("transfer.batch.approved"), JSON.stringify(approved.output).slice(0, 300));
  const combined = await batchTimer(batchId, "REGX_1024_33B3_COMBINED_15"); assert.ok(combined, "REGX_1024_33B3_COMBINED_15 armed on the batch"); assert.equal(combined!.status, "armed"); assert.equal(combined!.due_date, "2027-09-16", "15 calendar days before the Oct 1 effective date");
  await j.tool({}, "17.2", "verifyTransfereeBlock", { batch_id: batchId, block: { ...TRANSFEREE, payment_start_date: "2027-10-01", optional_insurance_statement: "none" }, respa_effective_date: "2027-10-01" }, TRANSFER);
  // Thu Sep 16, 2027: the print vendor's proof of mailing for the combined MS-2 — `notice.mailed` on the loan and, every loan on the run mailed, on the batch (every_loan=true) → the clock is satisfied (1.3 T1)
  clock.set("2027-09-16T18:00:00.000Z");
  const mailed = await j.tool({}, "17.2", "ingestMailReturns", { op: "proofs", batch_id: batchId, kind: "combined", transfer_date: "2027-10-01", respa_effective_date: "2027-10-01", installments_due_on_1st: true, loan_ids: [loanId], proofs: [{ loan_id: loanId, proof_of_mailing_id: `pom-${loanId.slice(0, 8)}`, mailed_on: "2027-09-16" }] }, TRANSFER);
  assert.equal(mailed.output["every_loan"], true); assert.equal(mailed.output["template"], "NTC_REGX_1024_33B_COMBINED_MS2");
  await settle();
  assert.equal((await batchTimer(batchId, "REGX_1024_33B3_COMBINED_15"))!.status, "satisfied");
  const loanMailed = (await events(loanId, "notice.mailed")).find((e) => e.payload["template"] === "NTC_REGX_1024_33B_COMBINED_MS2")!; assert.ok(loanMailed, "the loan's own notice.mailed"); assert.equal(loanMailed.payload["mailed_at"], "2027-09-16");
  const run = await entity("transfer_notice_runs", `run-${batchId}-combined`); assert.equal(run!["status"], "complete"); assert.equal(run!["transferor_stops"], "2027-09-30"); assert.equal(run!["transferee_starts"], "2027-10-01"); assert.equal(run!["window_end"], "2027-11-29");
  // the Thread: the mailed NoticeCard with the transferee's name, dates and toll-free number; the autopay StatusCard with its end date
  const cards = await cardsOf(loanId, partyA);
  const notice = card(cards, "transfer.notice", partyA); assert.ok(notice, "the combined notice NoticeCard"); assert.equal(notice!.props["notice_code"], "NTC_REGX_1024_33B_COMBINED_MS2"); assert.equal(notice!.props["channel"], "mail"); assert.match(String(notice!.props["mailed_at"]), /^2027-09-16/);
  assert.equal(tokens(notice)["new_servicer"], TRANSFEREE.name); assert.equal(tokens(notice)["date"], "2027-10-01"); assert.equal(tokens(notice)["through"], "2027-09-30"); assert.equal(tokens(notice)["tollfree"], TRANSFEREE.tollfree);
  const autopay = card(cards, "transfer.autopay_ends", partyA); assert.ok(autopay, "the autopay end StatusCard"); assert.equal(autopay!.props["ends_on"], run!["ach_cancel_by"]); assert.equal(tokens(autopay)["new_servicer"], TRANSFEREE.name);
  // the Record on Sep 17: badge Servicing moving, the Dates rows 17.2 stored (last payment to Supermortgage · the transferee's first · protection ends) and the batch clock; autopay's end date on the Loan section
  clock.set("2027-09-17T16:00:00.000Z");
  const rec = await record(A, loanId); assert.equal(badge(rec).badge, "Servicing moving"); assert.equal(badge(rec).one_liner, "transfer.moving"); assert.equal(badge(rec).one_liner_tokens?.["new_servicer"], TRANSFEREE.name); assert.equal(badge(rec).one_liner_tokens?.["date"], "2027-10-01"); assert.equal(badge(rec).one_liner_tokens?.["through"], "2027-09-30");
  const d = dates(rec); assert.ok(d.some((x) => x.timer_code === "transfer.transferor_stops" && x.due_at.startsWith("2027-09-30")), JSON.stringify(d)); assert.ok(d.some((x) => x.timer_code === "transfer.transferee_starts" && x.due_at.startsWith("2027-10-01"))); assert.ok(d.some((x) => x.timer_code === "transfer.window_end" && x.due_at.startsWith("2027-11-29") && x.label === "Payment protection ends"));
  assert.ok(!d.some((x) => x.timer_code === "REGX_1024_33B3_COMBINED_15"), "a satisfied clock leaves Dates");
  const ad = (rec["loan"] as P)["autodraft"] as P; assert.equal(ad["ends_on"], run!["ach_cancel_by"]); assert.ok(String(ad["ends_on"]) <= "2027-09-30", "the last debit is no later than the last pre-cutover due date");
  assert.equal(rec["read_only"], false, "before cutover the Record is live");
});

test("32.12-T6: Given a payment received by Supermortgage on Oct 14 after an Oct 1 transfer, then the Thread states the payment is forwarded and protected; on day 61+ the protection text is absent.", { skip }, async () => {
  const b = j3.b!; const { j, loanId, partyA, A } = b; const batchId = j3.batchId!;
  // Thu Oct 14, 2027 (day 14 of the 60-day window): 17.3's post-transfer receipt, classified by 17.2's §1024.33(c) rule and forwarded — `payment.misdirected.received{protected=true}` on the loan
  clock.set("2027-10-14T16:00:00.000Z");
  const r1 = await j.tool({ loan: loanId }, "17.3", "runOutboundDqGate", { op: "receipt", batch_id: batchId, loan_id: loanId, received_on: "2027-10-14", transfer_date: "2027-10-01", amount_cents: "409012", payment_id: `MP-${loanId.slice(0, 8)}-1`, channel: "lockbox", listed: true, respa_effective_date: "2027-10-01", due_date: "2027-10-01", grace_days: 15, transferee: TRANSFEREE }, TRANSFER);
  const c1 = r1.output["classification"] as P; assert.equal(c1["protected"], true); assert.equal(c1["window_end"], "2027-11-29"); assert.equal(c1["disposition"], "forwarded");
  await settle();
  const received = (await events(loanId, "payment.misdirected.received")).at(-1)!; assert.equal(received.payload["protected"], true); assert.equal(received.payload["received_at"], "2027-10-14");
  assert.ok((await events(loanId, "payment.misdirected.forwarded")).length >= 1, "forwarded to the transferee");
  assert.equal((await entity("misdirected_payments", `MP-${loanId.slice(0, 8)}-1`))!["protected"], true);
  const fwd = card(await cardsOf(loanId, partyA), "transfer.payment_forwarded", partyA); assert.ok(fwd, "the Thread: forwarded and protected"); assert.equal(fwd!.props["protected"], true); assert.equal(tokens(fwd)["date"], "2027-10-14"); assert.equal(tokens(fwd)["money"], "$4,090.12"); assert.equal(tokens(fwd)["new_servicer"], TRANSFEREE.name);
  const rec = await record(A, loanId); assert.equal(badge(rec).badge, "Transferred out"); assert.equal(badge(rec).one_liner, "transfer.after"); assert.equal(badge(rec).one_liner_tokens?.["through"], "2027-11-29"); assert.equal(rec["read_only"], true, "read-only after cutover");
  assert.equal(((rec["loan"] as P)["ratewatch_status"]), "void");
  // day 62 (Wed Dec 1, 2027): a receipt past the window is forwarded without the protection — no protection line on the card, none on the Record
  clock.set("2027-12-01T16:00:00.000Z");
  const r2 = await j.tool({ loan: loanId }, "17.3", "runOutboundDqGate", { op: "receipt", batch_id: batchId, loan_id: loanId, received_on: "2027-12-01", transfer_date: "2027-10-01", amount_cents: "409012", payment_id: `MP-${loanId.slice(0, 8)}-2`, channel: "lockbox", listed: true, respa_effective_date: "2027-10-01", due_date: "2027-12-01", grace_days: 15, transferee: TRANSFEREE }, TRANSFER);
  assert.equal((r2.output["classification"] as P)["protected"], false); await settle();
  const late = card(await cardsOf(loanId, partyA), "transfer.payment_forwarded.after_window", partyA); assert.ok(late, "the day-61+ card without the protection text"); assert.equal(late!.props["protected"], false); assert.equal(tokens(late)["date"], "2027-12-01");
  assert.equal((await cardsOf(loanId, partyA)).filter((c) => c.copy_key === "transfer.payment_forwarded").length, 1, "the protected line only for the in-window receipt");
  const after = await record(A, loanId); assert.equal(badge(after).badge, "Transferred out"); assert.equal(badge(after).one_liner, "transfer.after_window", "from day 61 the protection line is gone");
  assert.ok(!dates(after).some((x) => x.timer_code === "transfer.window_end"), "the window's end has passed");
});
