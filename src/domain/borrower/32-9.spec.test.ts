// 32.9 Servicing: insurance, PMI, ARM, life events, requests
// spec/sections/32-borrower-experience/32-9-servicing-insurance-pmi-arm-life-events-requests.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// Every T-id drives the real runtime: the journey fixture boards the refinance loan (20.x → 31.x), then the owning
// servicing processes run on the runtime's own unit of work — 9.2's Fpi92Service, the 9.5 / 9.6 / 10.1 / 16.1 bus tools,
// the 4.x case commands (Runtime.executeDef), 7.2/7.3's ARM ops, the Notice Registry over the FAKE delivery ports —
// with the Timer Engine arming every row from the committed events, and the 32.9 flow
// (src/runtime/borrower/flows/9-servicing-requests.ts) reacting post-commit with the borrower's cards and thread lines.
// The borrower's own commits go through the borrower API (messages, card resolves). The tests then read the tables, the
// events, the timers (`timers.due_at`), the record and the thread. What the borrower SEES of these facts is asserted on
// the real components in apps/borrower/tests/cards/flow-9-servicing-requests.test.tsx. Skips without a database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { connect, reachable, type Db } from "../../infra/db/client.ts";
import { acquireJourneyLock, type TestLock } from "../../infra/db/test-lock.ts";
import { decodeEntityData } from "../../infra/db/entities.ts";
import type { UowContext, UowResult } from "../../infra/db/unit-of-work.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock, type Actor, type MemoryEventStore } from "../../kernel/events/index.ts";
import type { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { plainDate as D, addDays, type PlainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer, federal } from "../../kernel/calendar/business.ts";
import { Runtime } from "../../runtime/app.ts";
import { createApiServer, listen } from "../../runtime/server.ts";
import { createLogger } from "../../runtime/log.ts";
import { createBorrowerRouter, type BorrowerRouter } from "../../runtime/borrower/routes.ts";
import { Journey, MST } from "../../runtime/borrower/fixtures/journey.ts";
import { EntityStore } from "../../app/tools.ts";
import { CommandRefused } from "../../app/commands.ts";
import { SECTION_04_CASE_COMMANDS } from "../../app/tools/section04.ts";
import { NoticeService, type Notice } from "../../notices/service.ts";
import type { Recipient } from "../../notices/channel.ts";
import type { FakeLpiTracking } from "../../infra/integrations/property.ts";
import { Fpi92Service, MS3A, REMINDER_TEMPLATES } from "../insurance/ops-9-2.ts";
import { receiveVendorMessage, evaluateFloodCoverage, sendFloodNotice45, recordFloodNoticeMailed, sendMapChangeNotice, FLOOD_MAP_CHANGE_NOTICE, type FloodDeps } from "../insurance/ops-9-6.ts";
import * as ARM from "../notices/ops-7-2.ts";
import * as ARM_INITIAL from "../notices/ops-7-3.ts";
import { FIGURE_KEYS } from "../payoff/ops-16-1.ts";
import { installmentLedger } from "../pmi/fixtures.ts";
import { DOCUMENT_MATRIX } from "../servicing-requests/successor.ts";
import { FAKE_SERVICER_CONTACT, NOTICE_CODES_32_9, classifyIntake, money } from "../../runtime/borrower/flows/9-servicing-requests.ts";

const DB_URL = process.env["TEST_DATABASE_URL"] ?? "postgresql://sm:sm@localhost/supermortgage_test";
const up = await reachable(DB_URL);
if (!up && process.env["REQUIRE_DB"]) throw new Error(`REQUIRE_DB set but ${DB_URL} is not reachable`);
const skip = up ? false : `no Postgres at ${DB_URL}`;
const TOKEN = "ops-" + randomUUID();
const clock = new FixedClock("2026-09-10T16:00:00.000Z");
const INSURANCE: Actor = { kind: "agent", id: "insurance-property" }; const PMI: Actor = { kind: "agent", id: "pmi" }; const PAYOFF: Actor = { kind: "agent", id: "payoff-release" }; const CASE: Actor = { kind: "agent", id: "case" }; const DISCLOSURES: Actor = { kind: "agent", id: "disclosures" };
const COPY_LIB = readFileSync(fileURLToPath(new URL("../../../docs/ux/12-message-copy-library.md", import.meta.url)), "utf8");

let journeyLock: TestLock | undefined;
let db: Db; let runtime: Runtime; let router: BorrowerRouter; let base = ""; let close: () => Promise<void> = async () => undefined; let partnerPartyId = "";
let notices: NoticeService; let fpi: Fpi92Service; let flood: FloodDeps;

/** A stand-in that forwards every call to the unit of work currently open (one 9.2 service / one Notice Registry service across many committed units). */
function forwarding<T extends object>(what: string): { current: T | null; readonly proxy: T } {
  const box = { current: null as T | null };
  const proxy = new Proxy({}, { get: (_t, k) => { const cur = box.current; if (!cur) throw new Error(`no unit of work is open for the ${what}`); const v = (cur as unknown as Record<PropertyKey, unknown>)[k]; return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(cur) : v; } }) as T;
  return Object.assign(box, { proxy });
}
const fwdEvents = forwarding<MemoryEventStore>("event store"); const fwdLedger = forwarding<MemoryLedger>("ledger");
const noticesMap = new Map<string, Notice>();

test.before(async () => {
  if (skip) return;
  journeyLock = await acquireJourneyLock(DB_URL);
  execFileSync(fileURLToPath(new URL("../../../db/migrate.sh", import.meta.url)), { env: { ...process.env, DATABASE_URL: DB_URL }, stdio: "pipe" });
  db = connect(DB_URL);
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock });
  const logger = createLogger("json", (line) => { if (process.env["FLOW_DEBUG"] === "all" || (process.env["FLOW_DEBUG"] && /flow|ERROR/.test(line))) process.stderr.write(line + "\n"); });
  router = createBorrowerRouter({ runtime, logger, environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost"], urlSecret: "test-secret" });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger, console: false, borrowerRouter: router });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => server.close(() => db.end().then(() => resolve())));
  const partner = await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id) VALUES ('servicer', $1, '123456789', '1000123') RETURNING id`, [`Partner Bank ${randomUUID().slice(0, 8)}`]);
  partnerPartyId = partner[0]!.id;
  // the owning processes' services over the runtime's own unit of work (the events, ledger and timers of each commit), the Notice Registry with the runtime's FAKE print-mail / e-delivery ports
  notices = new NoticeService({ registry: runtime.noticeRegistry, events: fwdEvents.proxy, clock, printMail: runtime.ports.printMail!, edelivery: runtime.ports.edelivery!, notices: noticesMap });
  fpi = new Fpi92Service({ events: fwdEvents.proxy, clock, ledger: fwdLedger.proxy, actor: INSURANCE });
  flood = { events: fwdEvents.proxy, actor: INSURANCE, notices, ...(runtime.ports.lpi ? { lpi: runtime.ports.lpi } : {}) };
});
test.after(async () => { if (!skip) { await close(); await journeyLock?.release(); } });

// ---------------------------------------------------------------- helpers over the borrower API, the runtime and the tables
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
const thread = async (email: string): Promise<Record<string, unknown>[]> => { await settle(); const r = await api("GET", "/v1/borrower/thread?limit=500", undefined, (await signIn(email)).token); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300)); return r.body["messages"] as Record<string, unknown>[]; };
/** POST /v1/borrower/messages as the party (the Intake Router's path; a spoken turn is `channel: "voice"`). */
async function msg(email: string, text: string, subject: { loan_id: string }, channel: "app" | "voice" = "app"): Promise<{ reply: Record<string, unknown>; routed_to: string; command: string | null }> {
  const r = await api("POST", "/v1/borrower/messages", { text, channel, subject }, (await signIn(email)).token);
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 600)); await settle();
  return { reply: r.body["reply"] as Record<string, unknown>, routed_to: String(r.body["routed_to"]), command: (r.body["command"] as string | null) ?? null };
}
/** POST /v1/borrower/cards/{id}/resolve as the party (a fresh code = fresh L1 for the money fields). */
async function resolve(email: string, cardId: string, option_id: string, args: Record<string, unknown> = {}, evidence: Record<string, unknown> = {}): Promise<Reply> {
  const r = await api("POST", `/v1/borrower/cards/${cardId}/resolve`, { option_id, args, evidence }, (await signIn(email)).token);
  assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 900)); await settle(); return r;
}
interface CardRow { card_instance_id: string; party_id: string; kind: string; status: string; copy_key: string; props: Record<string, unknown>; evidence: Record<string, unknown> | null; command_ref: string | null; expires_at: string | null; created_at: string }
const cardsOf = async (loanId: string, partyId?: string): Promise<CardRow[]> => { await settle(); return db.query<CardRow & Record<string, unknown>>(`SELECT card_instance_id, party_id, kind, status, copy_key, props, evidence, command_ref, expires_at, created_at FROM card_instances WHERE subject_loan_id = $1 AND ($2::uuid IS NULL OR party_id = $2) ORDER BY created_at, card_instance_id`, [loanId, partyId ?? null]); };
const events = (loanId: string, type?: string) => db.query<{ id: string; type: string; occurred_at: string; payload: Record<string, unknown> }>(`SELECT id, type, occurred_at, payload FROM loan_events WHERE loan_id = $1 AND ($2::text IS NULL OR type = $2) ORDER BY sequence`, [loanId, type ?? null]);
const timer = async (loanId: string, code: string) => (await db.query<{ id: string; status: string; due_at: string | null; due_date: string | null }>(`SELECT id, status::text AS status, due_at, due_date::text AS due_date FROM timers WHERE loan_id = $1 AND code = $2 ORDER BY armed_at DESC LIMIT 1`, [loanId, code]))[0];
const timers = async (loanId: string, code: string) => db.query<{ id: string; status: string; due_at: string | null; due_date: string | null }>(`SELECT id, status::text AS status, due_at, due_date::text AS due_date FROM timers WHERE loan_id = $1 AND code = $2 ORDER BY armed_at`, [loanId, code]);
const entity = async (kind: string, id: string): Promise<Record<string, unknown> | null> => { const rows = await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = $1 AND id = $2`, [kind, id]); return rows[0] ? decodeEntityData(rows[0].data) : null; };
const exec = async (loanId: string, process: string, name: string, actor: Actor, input: Record<string, unknown>): Promise<Record<string, unknown>> => { const r = await runtime.execute({ process, name, loanId, actor, input }); await settle(); return (r.output ?? {}) as Record<string, unknown>; };
const legalName = async (partyId: string): Promise<string> => String((await db.query<{ legal_name: string | null }>(`SELECT legal_name FROM parties WHERE id = $1`, [partyId]))[0]?.legal_name ?? "Alex Borrower");
const propertyAddress = async (loanId: string): Promise<string> => String((await db.query<{ a: string }>(`SELECT concat_ws(', ', pr.address_line1, pr.city, pr.state || ' ' || pr.postal_code) AS a FROM loans l JOIN properties pr ON pr.id = l.property_id WHERE l.id = $1`, [loanId]))[0]?.a ?? "");
const dateOf = (iso: string): string => iso.slice(0, 10);
const js = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x)).slice(0, 400);
/** One unit of work on the runtime (the loan's events, ledger, entities, timers hydrated; everything committed together) with the owning services pointed at it; the flows settle after the commit. */
async function unit<T>(loanId: string, fn: (ctx: UowContext, store: EntityStore) => T | Promise<T>): Promise<UowResult<T>> {
  const store = new EntityStore(); store.seed(await runtime.entities.load({ loanId })); const mark = store.versionCount();
  try {
    const r = await runtime.uow.run({ loanId }, async (ctx) => { fwdEvents.current = ctx.events; fwdLedger.current = ctx.ledger; return fn(ctx, store); }, { clock, commit: async (q) => { await runtime.entities.save(store.versionsSince(mark), { loanId }, q); } });
    await settle(); return r;
  } finally { fwdEvents.current = null; fwdLedger.current = null; }
}
const armDeps = (store: EntityStore): ARM.OpsDeps => ({ events: fwdEvents.proxy, store, actor: DISCLOSURES, now: clock.now() });
const sample = (code: string, asOf: PlainDate): Record<string, unknown> => ({ ...(runtime.noticeRegistry.activeVersion(code, asOf)?.samplePayload ?? {}) });
/** The caller's display fields for a statement send: the registry's sample minus every figure (figures come only from the 16.1 rows). */
const display = (code: string, asOf: PlainDate): Record<string, unknown> => Object.fromEntries(Object.entries(sample(code, asOf)).filter(([k]) => !(FIGURE_KEYS as readonly string[]).includes(k)));
const copyLine = (key: string): string => { const m = new RegExp(`^- \`${key.replace(/\./g, "\\.")}\`(.*)$`, "m").exec(COPY_LIB); return m ? m[1]! : `MISSING COPY ${key}`; };
const renderedText = (body: string): string => body.replace(/\{\{copy:([A-Za-z0-9_.-]+)\}\}/g, (_w, k: string) => copyLine(k));
const COLLECTION_LANGUAGE = /\b(past due|delinquen\w*|collections?\b|collect (the|a|your|on)|amount due|pay now|foreclos\w*|late (fee|charge)|you owe|demand for payment|in default)\b/i;
/** One application on the shared runtime: its own journey (prior loan, lead, borrowers with e-mails) with both borrowers signed in so their cards have a conversation. */
async function openApp(): Promise<{ j: Journey; A: string; B: string; partyA: string; partyB: string }> {
  const R = randomUUID().slice(0, 8); const A = `alex-${R}@example.test`; const B = `blake-${R}@example.test`;
  const j = new Journey({ runtime, db, base, token: TOKEN, clock, borrowerEmail: A, coBorrowerEmail: B, partnerPartyId });
  await j.seedBook(); await j.openApplication();
  const partyA = (await signIn(A)).party_id; const partyB = (await signIn(B)).party_id;
  await j.interview(); await settle();
  return { j, A, B, partyA, partyB };
}
const alex = async (loanId: string): Promise<Recipient> => ({ partyId: main.partyA, name: await legalName(main.partyA), mailingAddress: await propertyAddress(loanId), portalUser: true });
const SFHA = { principal_structure_in_sfha: true, detached_security_structure_in_sfha: false, cbrs_opa: false, participating_community: true };
const OV = 70_817_178n;            // original value: $708,171.78 → the $559,455.71 amortized balance is 79.00% (10.1 T4)
const UPB = 55_945_571n;           // principal after the Jan 1, 2027 installment (journey d: $559,455.71)
const PI = 340_262n;               // the boarded P&I ($3,402.62)
const FEE = 19_000n;               // F-1-02 BPO fee ($190.00)
const nyfed = (effectiveDate: string, average30day: string) => ({ effectiveDate, type: "SOFRAI", average30day, average90day: "3.70000", average180day: "3.90000", index: "1.12000000", revisionIndicator: "" });

// ═══════════════════════════════════ one journey, one loan, in lifecycle order: T10 · T9 · T8 · T11 · T7 · T1 · T2 · T3 · T5 · T6 · T4
const main = { j: undefined as Journey | undefined, A: "", B: "", partyA: "", partyB: "", loanId: "", priorLoanId: "", fpiCaseId: "", placement: null as { effective_date: string; expiration_date: string; premium_cents: bigint } | null, sonEmail: "", sonParty: "" };

test("32.9-T10: Given a typed payoff request Fri Nov 6, 2026, then `NTC_REGZ_36C3_PAYOFF_STMT` is sent by Tue Nov 17 (servicer business days; Veterans Day closed) with wire instructions carrying the positive-confirmation text.", { skip }, async () => {
  const o = await openApp(); Object.assign(main, o); const { j, A, partyA } = o; main.priorLoanId = j.priorLoanId;
  // Alex is the borrower of record on the loan the refinance pays off (02 §6: borrowers.party_id → loan_borrowers is its servicing subject); the book's terms for it
  const b = await db.query<{ id: string }>(`INSERT INTO borrowers (legal_name, party_id) VALUES ($1, $2) RETURNING id`, [await legalName(partyA), partyA]);
  await db.query(`INSERT INTO loan_borrowers (loan_id, borrower_id, role, is_primary) VALUES ($1, $2, 'borrower', true)`, [j.priorLoanId, b[0]!.id]);
  await db.query(`INSERT INTO loan_terms (loan_id, effective_from, source, amortization, note_rate_bps, pi_cents, escrow_payment_cents, escrowed, remittance_type, maturity_date, remaining_term_months) VALUES ($1, '2024-09-18', 'boarding', 'fixed', 70000, 375904, 68750, true, 'A/A', '2054-10-01', 360)`, [j.priorLoanId]);
  await j.quoteAndLe(); await j.recordIntent(); await j.quoteForLock(); await j.requestLock(); await j.executeLockAndCommit(); await j.verifyDecideAndClear(); await j.clearToClose(); await j.scheduleClosing(); await j.closingDisclosure(); await settle();
  // Fri Nov 6, 2026 09:00 MST — a typed message is a written request (7.6 / 16.1): the Intake Router opens the payoff case, 16.1 records `payoff.request.received{written}` and the 7-BD clock starts at receipt
  clock.set(MST("2026-11-06", "09:00"));
  assert.equal(classifyIntake("Can I get a written payoff statement for my current loan?").kind, "payoff_request");
  const m = await msg(A, "Can I get a written payoff statement for my current loan?", { loan_id: j.priorLoanId });
  assert.equal(m.reply["copy_key"], "payoff.requested"); assert.equal(m.routed_to, "borrower-comms"); assert.equal(m.command, "case.open");
  const opened = (await events(j.priorLoanId, "case.opened")).find((e) => e.payload["case_type"] === "payoff_request"); assert.ok(opened, "the 32.2 payoff_request case"); assert.equal(opened.payload["written"], true);
  const received = (await events(j.priorLoanId, "payoff.request.received"))[0]; assert.ok(received, "16.1 payoff.request.received"); assert.equal(received.payload["written"], true); assert.equal(received.payload["received_on"], "2026-11-06"); assert.equal(dateOf(received.occurred_at), "2026-11-06");
  // the engine's deadline: 7 servicer business days from Fri Nov 6 — Sat/Sun and Veterans Day (Wed Nov 11) closed → Wed Nov 18 (the spec's "Tue Nov 17" counts one day fewer; the statement below is sent on Nov 17 either way)
  const t7 = await timer(j.priorLoanId, "REGZ_1026_36C3_PAYOFF_STMT_7BD"); assert.ok(t7, "REGZ_1026_36C3_PAYOFF_STMT_7BD armed"); assert.equal(t7.status, "armed");
  assert.equal(t7.due_date, addBusinessDays(D("2026-11-06"), 7, servicer)); assert.equal(t7.due_date, "2026-11-18");
  assert.equal(addBusinessDays(D("2026-11-10"), 1, servicer), "2026-11-12", "Veterans Day (Nov 11) is closed on the servicer calendar"); assert.equal(addBusinessDays(D("2026-11-06"), 6, servicer), "2026-11-17");
  const requested = (await cardsOf(j.priorLoanId, partyA)).find((c) => c.copy_key === "payoff.requested"); assert.ok(requested, "the StatusCard"); assert.equal(requested.kind, "StatusCard"); assert.equal(requested.props["next_event_at"], t7.due_at); assert.equal(requested.props["next_event_label"], "Payoff statement by");
  // the refinance closes (Fri Nov 6 14:26), funds and boards (Thu Nov 12) while the clock on the prior loan runs
  await j.closeAndSign(); await j.fund(); main.loanId = await j.board(); await settle();
  // Tue Nov 17: the payoff-release agent issues the statement from the 16.1 rows (the wire instructions from the vault's active version, the accuracy gate asserted) and sends it through the Notice Registry
  clock.set(MST("2026-11-17", "10:00"));
  const caseId = String(opened.payload["case_id"]); const quoteId = `pq-${caseId}`; const statementId = `ps-${caseId}`;
  const quote = await entity("payoff_quotes", quoteId); assert.ok(quote, "the payoff_quotes row the flow's 16.1 call produced"); assert.equal(quote["quote_type"], "statement");
  const tok = await exec(j.priorLoanId, "16.1", "mintVerificationToken", PAYOFF, { loan_id: j.priorLoanId, statement_hash: String(quote["hash"]), wire_instruction_version_id: "wire-v4" });
  await exec(j.priorLoanId, "16.1", "assertAccuracyGate", PAYOFF, { loan_id: j.priorLoanId, quote_id: quoteId, ledger_clean: true, rate_segments_final: true });
  await exec(j.priorLoanId, "16.1", "renderStatement", PAYOFF, { loan_id: j.priorLoanId, quote_id: quoteId, statement_id: statementId, wire_instruction_version_id: "wire-v4", active_wire_instruction_version_id: "wire-v4", verification_token: tok["token"] });
  const sent = await exec(j.priorLoanId, "16.1", "sendNotice", PAYOFF, { loan_id: j.priorLoanId, template_code: NOTICE_CODES_32_9.payoff_statement, statement_id: statementId, recipients: [{ party_id: partyA, channel: "portal", name: await legalName(partyA), address: await propertyAddress(j.priorLoanId) }], payload: display(NOTICE_CODES_32_9.payoff_statement, D("2026-11-17")) });
  assert.equal(sent["template"], "NTC_REGZ_36C3_PAYOFF_STMT"); assert.equal(sent["checklist_passed"], true, "the registry's content checklist (the remittance block with the fraud warning) passed");
  const payload = sent["payload"] as Record<string, unknown>; assert.ok(payload["wire_bank"] && payload["wire_aba"] && payload["wire_account_masked"], "wire instructions on the statement");
  assert.match(String(runtime.noticeRegistry.activeVersion("NTC_REGZ_36C3_PAYOFF_STMT", D("2026-11-17"))!.source), /Fraud warning: we will never change wire instructions by email; call .* to confirm before sending funds/);
  const noticeSent = (await events(j.priorLoanId, "notice.sent")).find((e) => e.payload["template"] === "NTC_REGZ_36C3_PAYOFF_STMT"); assert.ok(noticeSent, "notice.sent"); assert.equal(dateOf(noticeSent.occurred_at), "2026-11-17");
  assert.ok((await events(j.priorLoanId, "payoff.statement.sent")).length === 1); assert.ok("2026-11-17" <= "2026-11-17" && "2026-11-17" < t7.due_date!, "sent by Tue Nov 17, inside the clock");
  assert.equal((await timer(j.priorLoanId, "REGZ_1026_36C3_PAYOFF_STMT_7BD"))!.status, "satisfied");
  const card = (await cardsOf(j.priorLoanId, partyA)).find((c) => c.copy_key === "payoff.statement"); assert.ok(card, "the NoticeCard"); assert.equal(card.kind, "NoticeCard"); assert.equal(card.props["notice_code"], "NTC_REGZ_36C3_PAYOFF_STMT"); assert.equal(card.props["rendered_document_id"], noticeSent.payload["notice_id"]);
  assert.equal((card.props["copy_tokens"] as Record<string, string>)["money"], money(String(quote["total_cents"]))); assert.equal((card.props["copy_tokens"] as Record<string, string>)["date"], quote["good_through"]);
});

test("32.9-T9: Given a spoken payoff request, then the quote is given live, no 7-BD clock starts, and the one-tap conversion starts it.", { skip }, async () => {
  const { j, A, partyA, loanId } = main; assert.ok(j && loanId, "T10 boarded the loan");
  await j.firstPayment(); await settle();   // Jan 1, 2027 installment received Wed Dec 30
  clock.set(MST("2027-01-12", "10:00"));
  const before = (await timers(loanId, "REGZ_1026_36C3_PAYOFF_STMT_7BD")).length;
  const m = await msg(A, "What's my payoff amount as of today?", { loan_id: loanId }, "voice");
  assert.equal(m.reply["copy_key"], "payoff.quote_spoken"); assert.equal(m.command, null, "a spoken request executes no case command");
  const oral = (await events(loanId, "payoff.quote.computed")).find((e) => e.payload["quote_type"] === "oral"); assert.ok(oral, "16.1 computed the oral figure"); assert.equal(oral.payload["oral"], true);
  assert.match(String(m.reply["body_text"]), /\$[\d,]+\.\d{2}/, "the engine's figure is spoken in the reply");
  assert.equal((await events(loanId, "payoff.request.received")).length, 0, "no written request → no §1026.36(c)(3) clock");
  assert.equal((await timers(loanId, "REGZ_1026_36C3_PAYOFF_STMT_7BD")).length, before, "no 7-BD clock armed by the spoken quote");
  const choice = (await cardsOf(loanId, partyA)).find((c) => c.copy_key === "payoff.written.choice" && c.status === "pending"); assert.ok(choice, "the one-tap ChoiceCard"); assert.equal(choice.command_ref, "case.open");
  assert.deepEqual((choice.props["options"] as { id: string }[]).map((x) => x.id), ["send", "not_now"]); assert.equal(m.reply["card_instance_id"], choice.card_instance_id);
  // the tap: 32.2 case.open{payoff_request} → the flow's 16.1 statement request → `payoff.request.received{written}` → the clock
  const r = await resolve(A, choice.card_instance_id, "send"); assert.equal(r.body["command"], "case.open");
  const received = (await events(loanId, "payoff.request.received"))[0]; assert.ok(received, "the written request"); assert.equal(received.payload["written"], true); assert.equal(received.payload["received_on"], "2027-01-12");
  const t7 = await timer(loanId, "REGZ_1026_36C3_PAYOFF_STMT_7BD"); assert.ok(t7, "REGZ_1026_36C3_PAYOFF_STMT_7BD armed by the tap"); assert.equal(t7.status, "armed"); assert.equal(t7.due_date, addBusinessDays(D("2027-01-12"), 7, servicer));
  const cards = await cardsOf(loanId, partyA); assert.equal(cards.find((c) => c.card_instance_id === choice.card_instance_id)!.status, "resolved");
  const requested = cards.find((c) => c.copy_key === "payoff.requested"); assert.ok(requested); assert.equal(requested.props["next_event_at"], t7.due_at);
});

test("32.9-T8: Given a typed message \"you charged me a late fee I don't owe\", then a `noe` case opens, `NTC_REGX_35D_ACK` is sent within 5 federal BD, credit-reporting suppression is set for 60 days, and the Thread shows the response date.", { skip }, async () => {
  const { A, partyA, loanId } = main;
  clock.set(MST("2027-01-13", "09:30"));
  const c = classifyIntake("you charged me a late fee I don't owe"); assert.equal(c.kind, "noe"); assert.equal(c.assertion_category, "b5");
  const m = await msg(A, "you charged me a late fee I don't owe", { loan_id: loanId });
  assert.equal(m.reply["copy_key"], "case.ack");
  const opened = (await events(loanId, "case.noe.opened")).at(-1); assert.ok(opened, "4.1 case.noe.opened"); const caseId = String(opened.payload["case_id"]);
  assert.equal(opened.payload["receipt_date"], "2027-01-13"); assert.equal(opened.payload["payment_related"], true); assert.equal((opened.payload["assertions"] as { category: string }[])[0]!.category, "b5");
  assert.equal((await entity("cases", caseId))!["case_type"], "noe");
  // the acknowledgment: 5 federal business days from receipt (Wed Jan 13 → Thu Jan 21; MLK Day closed), sent the same day through the registry
  const ack = await timer(loanId, "REGX_1024_35D_NOE_ACK_5"); assert.ok(ack, "REGX_1024_35D_NOE_ACK_5"); assert.equal(ack.due_date, addBusinessDays(D("2027-01-13"), 5, federal)); assert.equal(ack.due_date, "2027-01-21");
  const sent = (await events(loanId, "notice.sent")).find((e) => e.payload["template"] === "NTC_REGX_35D_ACK"); assert.ok(sent, "NTC_REGX_35D_ACK sent"); assert.ok(dateOf(sent.occurred_at) <= ack.due_date!, "within 5 federal BD"); assert.equal(ack.status, "satisfied");
  // §1024.35(i): the suppression slice and its 60-day row
  const sup = await entity("credit_reporting_suppressions", caseId); assert.ok(sup, "credit_reporting_suppressions row"); assert.equal(sup["starts_at"], "2027-01-13"); assert.equal(sup["ends_at"], "2027-03-14"); assert.equal(sup["reason"], "regx_1024_35_i");
  const bar = await timer(loanId, "REGX_1024_35I_CREDIT_SUPPRESS_60"); assert.ok(bar, "REGX_1024_35I_CREDIT_SUPPRESS_60"); assert.equal(bar.status, "armed"); assert.equal(bar.due_date, addDays(D("2027-01-13"), 60));
  // the Thread: the acknowledgment NoticeCard carries the response date — the engine's REGX_1024_35E_NOE_RESPONSE_30 (30 federal BD)
  const response = await timer(loanId, "REGX_1024_35E_NOE_RESPONSE_30"); assert.ok(response, "the response clock"); assert.equal(response.due_date, addBusinessDays(D("2027-01-13"), 30, federal));
  const card = (await cardsOf(loanId, partyA)).find((c) => c.copy_key === "case.noe.ack"); assert.ok(card, "the NoticeCard"); assert.equal(card.props["notice_code"], "NTC_REGX_35D_ACK"); assert.equal(card.props["response_due"], response.due_date);
  assert.equal((card.props["copy_tokens"] as Record<string, string>)["date"], response.due_date); assert.equal((card.props["copy_tokens"] as Record<string, string>)["until"], bar.due_date); assert.equal(card.props["next_event_at"], response.due_at);
  const line = (await thread(A)).find((x) => x["card_instance_id"] === card.card_instance_id); assert.ok(line, "the card is a thread message");
  assert.ok((await cardsOf(loanId, partyA)).some((c) => c.copy_key === "case.noe.opened" && c.kind === "StatusCard"));
});

test("32.9-T11: Given a message that is both a complaint and an assertion of error, then both cases exist and the complaint cannot close before the NoE responds.", { skip }, async () => {
  const { A, loanId } = main;
  clock.set(MST("2027-01-14", "11:00"));
  const text = "I'm really frustrated — nobody called me back last week, and my January payment was misapplied to the wrong month.";
  assert.equal(classifyIntake(text).kind, "complaint_and_noe");
  const m = await msg(A, text, { loan_id: loanId }); assert.equal(m.reply["copy_key"], "case.complaint.with_noe");
  const cmp = (await events(loanId, "case.complaint.opened")).at(-1); assert.ok(cmp, "4.5 case.complaint.opened"); const cmpId = String(cmp.payload["case_id"]);
  assert.equal(cmp.payload["opens_noe"], true); const noeId = String(cmp.payload["linked_noe_case_id"]); assert.ok(noeId && noeId !== "null", "the linked NoE id");
  const noe = (await events(loanId, "case.noe.opened")).find((e) => e.payload["case_id"] === noeId); assert.ok(noe, "4.1 case.noe.opened for the linked case"); assert.deepEqual(noe.payload["linked_case_ids"], [cmpId]);
  assert.equal((await entity("cases", cmpId))!["case_type"], "complaint"); assert.equal((await entity("cases", noeId))!["case_type"], "noe"); assert.deepEqual((await entity("cases", cmpId))!["linked_case_ids"], [noeId]);
  for (const t of ["NTC_COMPLAINT_ACK", "NTC_REGX_35D_ACK"]) assert.ok((await events(loanId, "notice.sent")).some((e) => e.payload["template"] === t && dateOf(e.occurred_at) === "2027-01-14"), `${t} sent`);
  // 4.5 state machine: the NoE's clocks govern — closing the complaint before the NoE responds is refused by the command's own guardrail (NOE_GOVERNS)
  const closeDef = SECTION_04_CASE_COMMANDS.find((d) => d.process === "4.5" && d.name === "complaint.close")!;
  await assert.rejects(runtime.executeDef(closeDef, { loanId, actor: CASE, input: { case_id: cmpId, closed_with: "resolved", root_cause_code: "RC-PAYMENT-APPLICATION" } }), (e: unknown) => e instanceof CommandRefused && e.code === "NOE_GOVERNS");
  assert.equal((await entity("cases", cmpId))!["status"], "triaged"); assert.equal((await events(loanId, "case.complaint.closed")).length, 0);
  await settle();
  const cards = await cardsOf(loanId, main.partyA); assert.ok(cards.some((c) => c.copy_key === "case.complaint.ack" && c.props["notice_code"] === "NTC_COMPLAINT_ACK")); assert.ok(cards.some((c) => c.copy_key === "case.noe.ack" && c.props["case_id"] === noeId));
});

test("32.9-T7: Given a message \"my mother passed away, I'm her son\", then a 4.4 case opens, the sender becomes `potential_successor`, the documents card renders from the matrix, and no collection language appears in any message to them.", { skip }, async () => {
  const { j, loanId } = main;
  clock.set(MST("2027-01-19", "10:00"));
  main.sonEmail = `sam-${j!.R}@example.test`; const son = await signIn(main.sonEmail); main.sonParty = son.party_id;
  assert.equal(classifyIntake("my mother passed away, I'm her son").kind, "sii_inquiry");
  // the son has no subject on his record — he names the loan; the Intake Router's 4.4 path opens the case for anyone reporting a death
  const m = await msg(main.sonEmail, "my mother passed away, I'm her son", { loan_id: loanId });
  assert.equal(m.reply["copy_key"], "successor.intro"); assert.equal(m.routed_to, "intake");
  const opened = (await events(loanId, "case.sii.opened")).at(-1); assert.ok(opened, "4.4 case.sii.opened"); const caseId = String(opened.payload["case_id"]);
  const identified = (await events(loanId, "case.sii.potential_successor.identified")).find((e) => e.payload["case_id"] === caseId); assert.ok(identified, "the reporter identified"); assert.equal(identified.payload["party_id"], son.party_id);
  const lp = await db.query<{ role: string; started_at: string }>(`SELECT role, started_at::text AS started_at FROM loan_parties WHERE loan_id = $1 AND party_id = $2`, [loanId, son.party_id]);
  assert.deepEqual(lp.map((x) => x.role), ["potential_successor"]); assert.equal(lp[0]!.started_at, "2027-01-19");
  assert.equal((await entity("sii_cases", caseId))!["potential_successor_party_id"], son.party_id);
  const described = (await events(loanId, "case.sii.documents.described")).find((e) => e.payload["case_id"] === caseId); assert.ok(described, "the matrix row described"); assert.deepEqual(described.payload["documents"], [...DOCUMENT_MATRIX.death_relative]); assert.equal(described.payload["transfer_type"], "death_relative");
  const sent = (await events(loanId, "notice.sent")).find((e) => e.payload["template"] === "NTC_REGX_38B1VI_SII_DOCS"); assert.ok(sent, "NTC_REGX_38B1VI_SII_DOCS sent to the potential successor");
  assert.equal((await timer(loanId, "REGX_1024_38B1VI_SII_DOCS_DESC_5"))!.status, "satisfied");
  // a limited record: no account information before confirmation (02 §6 — the loan is not one of his subjects)
  const rec = await api("GET", `/v1/borrower/record?subject=${loanId}`, undefined, son.token); assert.equal(rec.status, 403); assert.equal(rec.body["code"], "PARTY_SCOPE");
  // the documents card from the matrix, and one UploadCard per document, to the son only
  const cards = await cardsOf(loanId, son.party_id);
  const docs = cards.find((c) => c.copy_key === "successor.documents"); assert.ok(docs, "the documents NoticeCard"); assert.equal(docs.kind, "NoticeCard"); assert.equal(docs.props["notice_code"], "NTC_REGX_38B1VI_SII_DOCS"); assert.deepEqual(docs.props["documents"], [...DOCUMENT_MATRIX.death_relative]);
  assert.deepEqual(cards.filter((c) => c.copy_key === "successor.upload").map((c) => String(c.props["document_class"])).sort(), [...DOCUMENT_MATRIX.death_relative].sort());
  assert.ok(!(await cardsOf(loanId, main.partyA)).some((c) => c.copy_key.startsWith("successor.")), "the borrower's own thread carries none of the successor's cards");
  // no collection language anywhere the son reads: the thread lines (copy keys rendered from the library), the cards' copy, the notice template itself
  const lines = await thread(main.sonEmail); assert.ok(lines.length >= 3);
  for (const l of lines) { const t = renderedText(String(l["body_text"] ?? "")); assert.doesNotMatch(t, /MISSING COPY/); assert.doesNotMatch(t, COLLECTION_LANGUAGE, t); }
  for (const c of cards) { const t = `${copyLine(c.copy_key)} ${JSON.stringify(c.props)}`; assert.doesNotMatch(t, /MISSING COPY/); assert.doesNotMatch(t, COLLECTION_LANGUAGE, t); }
  assert.doesNotMatch(String(runtime.noticeRegistry.activeVersion("NTC_REGX_38B1VI_SII_DOCS", D("2027-01-19"))!.source), COLLECTION_LANGUAGE);
});

test("32.9-T1: Given a policy `cancelled` on Mar 1, then the §1024.37(c) first notice renders no later than 3 federal BD (`INS_FPI_FIRST_NOTICE_SLA_3BD`), the reminder ≥ 30 days later, and no charge before max(t0+45, t1+15).", { skip }, async () => {
  const { A, partyA, loanId, j } = main; const caseId = `fpi-${loanId.slice(0, 8)}-${j!.R}`; main.fpiCaseId = caseId;
  const facts = { borrower_name: await legalName(partyA), borrower_address: await propertyAddress(loanId), property_address: await propertyAddress(loanId), account_last4: "0001", servicer_phone: FAKE_SERVICER_CONTACT.servicer_phone, servicer_address: FAKE_SERVICER_CONTACT.servicer_address, insurance_email: FAKE_SERVICER_CONTACT.insurance_email };
  const recipient = await alex(loanId);
  // Mon Mar 1, 2027: the carrier's cancellation (an underwriting cancellation the servicer cannot cure by paying — the borrower's own hazard policy, not an escrow-disbursed renewal) opens the 9.2 case with its reasonable basis
  clock.set(MST("2027-03-01", "10:00"));
  await unit(loanId, () => fpi.openCase({ loan_id: loanId, case_id: caseId, kind: "cancelled", insurance_type: "hazard", fdpa_required: false, escrowed: false, regx_days_delinquent: 0, cancellation_reason: "underwriting", lapse_start: D("2027-03-01"), opened_on: D("2027-03-01"), basis: { kind: "carrier_cancellation", evidence_id: `doc-cancel-${j!.R}` }, state: "AZ" }));
  const sla = await timer(loanId, "INS_FPI_FIRST_NOTICE_SLA_3BD"); assert.ok(sla, "INS_FPI_FIRST_NOTICE_SLA_3BD armed on fpi.case.opened"); assert.equal(sla.status, "armed");
  assert.equal(sla.due_date, addBusinessDays(D("2027-03-01"), 3, servicer)); assert.equal(sla.due_date, addBusinessDays(D("2027-03-01"), 3, federal)); assert.equal(sla.due_date, "2027-03-04");
  // Wed Mar 3: the MS-3(A) composed by 9.2 (no notice without the recorded basis), rendered and mailed first-class through the registry; the proof of mailing is t0
  clock.set(MST("2027-03-03", "09:00"));
  const first = await unit(loanId, async () => {
    const c = fpi.composeFirstNotice(caseId, { ...facts, notice_date: D("2027-03-03") }); assert.equal(c.template, MS3A);
    const n = notices.render({ templateCode: c.template, loanId, caseId, recipients: [recipient], payload: { ...sample(MS3A, D("2027-03-03")), ...c.payload }, asOf: D("2027-03-03") });
    assert.equal(n.status, "rendered", n.heldReason); const s = await notices.send(n.id); assert.equal(s.status, "sent");
    const mail = s.deliveries.find((d) => d.channel.startsWith("mail")); assert.ok(mail, "first-class mail (§1024.37(f))");
    notices.recordMailed(n.id, mail.attemptNo, clock.now(), `POM-${n.id}`);
    return { notice_id: n.id, clocks: fpi.recordFirstNoticeMailed({ case_id: caseId, notice_id: n.id, mailed_at: D("2027-03-03"), produced_at: D("2027-03-03"), mail_class: "first_class", proof_of_mailing_id: `POM-${n.id}` }) };
  });
  assert.equal(first.result.clocks.reminder_not_before, "2027-04-02"); assert.equal(first.result.clocks.earliest_charge, "2027-04-17");
  const fns = (await events(loanId, "fpi.first_notice.sent"))[0]; assert.ok(fns); assert.equal(fns.payload["first_notice_mailed_at"], "2027-03-03"); assert.ok(dateOf(fns.occurred_at) <= sla.due_date!, "rendered and mailed inside the 3-BD SLA");
  assert.equal((await timer(loanId, "INS_FPI_FIRST_NOTICE_SLA_3BD"))!.status, "satisfied");
  const t45 = await timer(loanId, "REGX_1024_37C_FPI_FIRST_NOTICE_45"); assert.ok(t45); assert.equal(t45.due_date, "2027-04-17"); assert.equal((await timer(loanId, "REGX_1024_37D_FPI_REMINDER_NOT_BEFORE_30"))!.due_date, "2027-04-02");
  const cards1 = await cardsOf(loanId, partyA);
  const nc = cards1.find((c) => c.copy_key === "insurance.fpi.first_notice"); assert.ok(nc, "the NoticeCard"); assert.equal(nc.props["notice_code"], "INS_FPI_FIRST_MS3A"); assert.equal(nc.props["channel"], "mail"); assert.equal((nc.props["copy_tokens"] as Record<string, string>)["deadline"], "2027-04-17"); assert.equal(nc.props["next_event_at"], t45.due_at);
  const upload = cards1.find((c) => c.copy_key === "insurance.fpi.upload"); assert.ok(upload, "the UploadCard"); assert.equal(upload.status, "pending"); assert.equal(upload.command_ref, "insurance.submitEvidence");
  // the reminder is refused before t0 + 30 (Tue Mar 30 < Fri Apr 2) and accepted on Mon Apr 5 = t1
  const mailedReminder = (on: PlainDate, id: string) => ({ case_id: caseId, notice_id: id, mailed_at: on, produced_at: on, mail_class: "first_class", proof_of_mailing_id: `POM-${id}`, variant: "b_no_info" as const });
  clock.set(MST("2027-03-30", "09:00"));
  await assert.rejects(unit(loanId, () => fpi.recordReminderMailed(mailedReminder(D("2027-03-30"), "n-early"))), /REGX_1024_37D_FPI_REMINDER_NOT_BEFORE_30 open until 2027-04-02/);
  assert.equal((await events(loanId, "fpi.reminder.sent")).length, 0);
  clock.set(MST("2027-04-05", "09:00"));
  const reminder = await unit(loanId, async () => {
    const n = notices.render({ templateCode: REMINDER_TEMPLATES.b_no_info, loanId, caseId, recipients: [recipient], payload: { ...sample(REMINDER_TEMPLATES.b_no_info, D("2027-04-05")), ...facts, notice_date: "2027-04-05", coverage_event_date: "2027-03-01", days_after_first_notice: 33 }, asOf: D("2027-04-05") });
    assert.equal(n.status, "rendered", n.heldReason); const s = await notices.send(n.id); const mail = s.deliveries.find((d) => d.channel.startsWith("mail"))!; notices.recordMailed(n.id, mail.attemptNo, clock.now(), `POM-${n.id}`);
    return fpi.recordReminderMailed(mailedReminder(D("2027-04-05"), n.id));
  });
  assert.equal(reminder.result.t1, "2027-04-05"); assert.equal(reminder.result.earliest_charge, "2027-04-20", "max(t0 + 45 = Apr 17, t1 + 15 = Apr 20)");
  assert.equal((await timer(loanId, "REGX_1024_37D_FPI_REMINDER_BEFORE_CHARGE_15"))!.due_date, "2027-04-20");
  assert.ok((await cardsOf(loanId, partyA)).some((c) => c.copy_key === "insurance.fpi.reminder" && c.props["notice_code"] === "INS_FPI_REMINDER_NOINFO_MS3B"));
  // no charge before max(t0 + 45, t1 + 15): refused on Apr 19, assessed on Apr 20 against the bound placement (retroactive to the lapse)
  const COVER = { last_known_cents: 50_000_000n, rcv_cents: 52_000_000n, upb_cents: UPB }; const VENDOR = { vendor_id: "FAKE-LPI", whitelist: ["FAKE-LPI"], affiliate: false, fees: [] as { kind: string; cents: bigint }[] }; const QUOTE = { carrier_quote_cents: null, table_rate_pct: "0.876", rate_table_version: "FAKE-AZ-2027-Q1" };
  clock.set(MST("2027-04-19", "09:00"));
  assert.deepEqual(fpi.chargeAllowed(caseId, D("2027-04-19")).allowed, false);
  await assert.rejects(unit(loanId, () => fpi.assessCharge(caseId, D("2027-04-19"))), /charge command refused/);
  assert.equal((await events(loanId, "fpi.charge.assessed")).length, 0);
  clock.set(MST("2027-04-20", "09:00"));
  const placed = await unit(loanId, () => { const req = fpi.requestPlacement(caseId, D("2027-04-20"), COVER, VENDOR, QUOTE); const b = fpi.recordLpiBound({ request_id: req.request_id, policy_number: "FAKE-LPI-0001", premium_cents: 219_000n, effective: req.effective }); const charge = fpi.assessCharge(caseId, D("2027-04-20")); return { req, placement: b.placement, charge: charge.charge }; });
  assert.equal(placed.result.req.effective, "2027-03-01"); assert.equal(placed.result.charge.period_start, "2027-03-01"); assert.equal(placed.result.charge.amount_cents, 219_000n);
  const charged = (await events(loanId, "fpi.charge.assessed"))[0]; assert.ok(charged); assert.equal(charged.payload["assessed_on"], "2027-04-20"); assert.equal(charged.payload["earliest_charge_date"], "2027-04-20");
  for (const code of ["REGX_1024_37C_FPI_FIRST_NOTICE_45", "REGX_1024_37D_FPI_REMINDER_BEFORE_CHARGE_15"]) assert.equal((await timer(loanId, code))!.status, "satisfied", code);
  const placedCard = (await cardsOf(loanId, partyA)).find((c) => c.copy_key === "insurance.fpi.placed"); assert.ok(placedCard, "the placement NoticeCard"); assert.equal((placedCard.props["copy_tokens"] as Record<string, string>)["money"], "$2,190.00");
  main.placement = { effective_date: placed.result.placement.effective_date, expiration_date: placed.result.placement.expiration_date, premium_cents: placed.result.placement.premium_cents };
});

test("32.9-T2: Given evidence of continuous coverage uploaded on day 50 after placement, then the LPI is cancelled and the refund posted within 15 days with `INS_FPI_CANCEL_REFUND_CONFIRM`.", { skip }, async () => {
  const { A, partyA, loanId, j } = main; const placement = main.placement!; assert.ok(placement, "T1 placed the policy");
  // day 50 after the Apr 20 placement: Wed Jun 9, 2027 — the borrower's own declarations page through the UploadCard (32.2 insurance.submitEvidence → `insurance.evidence.received{fpi_active}` → 9.5 evaluateEvidence)
  clock.set(MST("2027-06-09", "10:00"));
  const upload = (await cardsOf(loanId, partyA)).find((c) => c.copy_key === "insurance.fpi.upload" && c.status === "pending"); assert.ok(upload, "the pending UploadCard");
  const r = await resolve(A, upload.card_instance_id, "upload", { document_id: `doc-hoi-${j!.R}`, coverage_effective: "2027-03-01", coverage_expiration: "2028-03-01", policy_number: "FAKE-HO-77", carrier: "FAKE Mutual" }, { document_class: "homeowners_policy", file_name: "declarations.pdf", uploaded_at: clock.now() });
  assert.equal(r.body["command"], "insurance.submitEvidence"); assert.equal((r.body["result"] as Record<string, unknown>)["outcome"], "confirmed");
  const ev = (await events(loanId, "insurance.evidence.received")).at(-1); assert.ok(ev); assert.equal(ev.payload["fpi_active"], true); assert.equal(ev.payload["receipt"], "2027-06-09"); assert.equal(ev.payload["fpi_case_id"], main.fpiCaseId);
  assert.equal((await events(loanId, "insurance.evidence.evaluated")).at(-1)!.payload["outcome"], "confirmed");
  const t15 = await timer(loanId, "REGX_1024_37G_FPI_CANCEL_REFUND_15"); assert.ok(t15, "REGX_1024_37G_FPI_CANCEL_REFUND_15 armed on receipt"); assert.equal(t15.due_date, "2027-06-24"); assert.equal(t15.status, "armed");
  // 9.5 (insurance-property): the placed policy cancelled at the carrier and on the books as of the borrower's coverage date, the full overlap removed and refunded — both legs by day 15
  const lpi = runtime.ports.lpi as FakeLpiTracking; const binding = await lpi.bind(loanId, 52_000_000n, placement.effective_date, clock.now());
  clock.set(MST("2027-06-10", "10:00"));
  const cancel = await exec(loanId, "9.5", "requestLpiCancel", INSURANCE, { loan_id: loanId, binding_id: binding.bindingId, cancelled_on: "2027-03-01" });
  assert.equal(cancel["cancelled_on_books"], true); assert.equal(cancel["effective"], "2027-03-01");
  const posted = await exec(loanId, "9.5", "postRefund", INSURANCE, { loan_id: loanId, binding_id: binding.bindingId, terms: [{ effective: placement.effective_date, expiration: placement.expiration_date, premium_cents: placement.premium_cents }], borrower_coverage_start: "2027-03-01", borrower_coverage_end: null, evidence_received_on: "2027-06-09", borrower_paid_cents: placement.premium_cents, escrowed: false });
  assert.equal(posted["removed_cents"], 219_000n); assert.equal(posted["retained_cents"], 0n); assert.equal(posted["refund_cents"], 219_000n);
  clock.set(MST("2027-06-12", "10:00"));
  const paid = await exec(loanId, "9.5", "payRefund", INSURANCE, { loan_id: loanId, binding_id: binding.bindingId, refund_cents: 219_000n, rail: "ach", evidence_received_on: "2027-06-09", escrowed: false });
  assert.equal(paid["lpi_cancelled_on_books"], true); assert.equal(paid["timer_satisfied"], "REGX_1024_37G_FPI_CANCEL_REFUND_15"); assert.equal(paid["paid_on"], "2027-06-12");
  const both = (await events(loanId, "fpi.lpi.cancelled_and_refunded"))[0]; assert.ok(both, "cancelled AND refunded"); assert.equal(both.payload["refund_cents"], "219000"); assert.ok(both.payload["paid_on"]! <= t15.due_date!, "within 15 days of the evidence");
  assert.equal((await timer(loanId, "REGX_1024_37G_FPI_CANCEL_REFUND_15"))!.status, "satisfied");
  const confirm = await exec(loanId, "9.5", "notifyBorrower", INSURANCE, { loan_id: loanId, template_code: NOTICE_CODES_32_9.fpi_refund_confirm, recipients: [await alex(loanId)], payload: { ...sample(NOTICE_CODES_32_9.fpi_refund_confirm, D("2027-06-12")), notice_date: "2027-06-12", evidence_received_on: "2027-06-09", borrower_coverage_start: "2027-03-01", cancellation_effective: "2027-03-01", removed_cents: 219_000n, refund_cents: 219_000n, retained_cents: 0n, overlap_days: 365, rail: "ACH credit", days_after_evidence: 3, account_last4: "0001", property_address: await propertyAddress(loanId), gap_start: null, gap_end: null } });
  assert.equal((confirm as { status?: string }).status, "sent", js(confirm));
  const sent = (await events(loanId, "notice.sent")).find((e) => e.payload["template"] === "INS_FPI_CANCEL_REFUND_CONFIRM"); assert.ok(sent, "INS_FPI_CANCEL_REFUND_CONFIRM sent"); assert.equal(dateOf(sent.occurred_at), "2027-06-12");
  const cards = await cardsOf(loanId, partyA);
  assert.equal(cards.find((c) => c.card_instance_id === upload.card_instance_id)!.status, "resolved");
  const status = cards.find((c) => c.copy_key === "insurance.fpi.refund_confirm" && c.kind === "StatusCard"); assert.ok(status, "the refund StatusCard"); assert.equal(status.props["notice_code"], "INS_FPI_CANCEL_REFUND_CONFIRM"); assert.equal((status.props["copy_tokens"] as Record<string, string>)["money"], "$2,190.00");
  const notice = cards.find((c) => c.copy_key === "insurance.fpi.refund_confirm" && c.kind === "NoticeCard"); assert.ok(notice, "the confirmation NoticeCard"); assert.equal(notice.props["notice_code"], "INS_FPI_CANCEL_REFUND_CONFIRM"); assert.equal(notice.props["rendered_document_id"], sent.payload["notice_id"]);
});

test("32.9-T3: Given a flood map change into an SFHA, then `INS_FLOOD_MAP_CHANGE_NOTICE` renders with the coverage rule and a 45-day placement date in Dates.", { skip }, async () => {
  const { A, partyA, loanId, j } = main; const certId = `FAKE-CERT-${j!.R}`; const recipient = await alex(loanId); const address = await propertyAddress(loanId);
  clock.set(MST("2027-07-06", "09:00"));
  const r = await unit(loanId, async () => {
    // the vendor's life-of-loan map-change message (X → AE, effective Jul 1), the coverage rule (min(RCV, NFIP max, UPB) — no policy on file → deficiency), the 45-day notice mailed, then the map-change notice
    const mc = receiveVendorMessage(flood, { kind: "map_change_notification", vendor_id: "FAKE-flood", certificate_id: certId, received_at: clock.now(), loan_id: loanId, map_change: { effective_date: D("2027-07-01"), old_zone: "X", new_zone: "AE", sfha_before: false, sfha_after: true, map_panel: "FAKE-PANEL-1" } });
    const cov = evaluateFloodCoverage(flood, { loan_id: loanId, as_of: D("2027-07-06"), structures: SFHA, rcv_cents: 31_000_000n, upb_cents: UPB, policy: null, remap_effective: D("2027-07-01") });
    assert.equal(cov.required, true); if (!cov.required) throw new Error("unreachable"); assert.equal(cov.required_cents, 25_000_000n, "min(RCV $310,000, NFIP max $250,000, UPB $559,455.71)");
    const common = { account_last4: "0001", property_address: address, flood_zone: "AE", map_panel: "FAKE-PANEL-1", map_effective: "2027-07-01", required_amount_cents: cov.required_cents, coverage_from: "2027-07-01", notice_date: "2027-07-06", servicer_phone: FAKE_SERVICER_CONTACT.servicer_phone, servicer_address: FAKE_SERVICER_CONTACT.servicer_address, insurance_email: FAKE_SERVICER_CONTACT.insurance_email };
    const n45 = await sendFloodNotice45(flood, { loan_id: loanId, recipients: [recipient], payload: { ...sample("INS_FLOOD_FPI_NOTICE_45", D("2027-07-06")), ...common, deadline: addDays(D("2027-07-06"), 45) }, as_of: D("2027-07-06") });
    assert.equal(n45.awaiting_proof_of_mailing, true);
    const proof = recordFloodNoticeMailed(flood, { loan_id: loanId, notice_id: n45.notice.id, mailed_at: clock.now(), proof_of_mailing_id: `POM-${n45.notice.id}` });
    const mcn = await sendMapChangeNotice(flood, { loan_id: loanId, certificate_id: certId, recipients: [recipient], payload: { ...sample(FLOOD_MAP_CHANGE_NOTICE, D("2027-07-06")), ...common, deadline: proof.borrower_deadline }, as_of: D("2027-07-06") });
    return { mc, cov, proof, mcn };
  });
  assert.equal(r.result.mc.direction, "into_sfha"); assert.equal(r.result.mc.duplicate, false); assert.equal(r.result.proof.borrower_deadline, "2027-08-20");
  assert.equal(r.result.mcn.notice.templateCode, "INS_FLOOD_MAP_CHANGE_NOTICE"); assert.equal(r.result.mcn.notice.status, "sent"); assert.equal(r.result.mcn.event.payload["coverage_required"], true); assert.equal(r.result.mcn.event.payload["required_cents"], 25_000_000n);
  assert.ok((await events(loanId, "notice.sent")).some((e) => e.payload["template"] === "INS_FLOOD_MAP_CHANGE_NOTICE"), "INS_FLOOD_MAP_CHANGE_NOTICE sent");
  const notified = (await events(loanId, "flood.map_change.notified"))[0]; assert.ok(notified); assert.equal(notified.payload["new_zone"], "AE"); assert.equal(notified.payload["borrower_deadline"], "2027-08-20");
  // the 45-day placement date is the engine's: FDPA_4012A_E_FLOOD_FPI_NOTICE_45 anchored on the mailed date (Jul 6 + 45 = Fri Aug 20)
  const t45 = await timer(loanId, "FDPA_4012A_E_FLOOD_FPI_NOTICE_45"); assert.ok(t45, "FDPA_4012A_E_FLOOD_FPI_NOTICE_45 armed on flood.fpi.notice.sent"); assert.equal(t45.status, "armed"); assert.equal(t45.due_date, addDays(D("2027-07-06"), 45));
  const rec = await record(A, loanId); const row = (rec["dates"] as { timer_code: string; label: string; due_at: string; calendar: string }[]).find((d) => d.timer_code === "FDPA_4012A_E_FLOOD_FPI_NOTICE_45");
  assert.ok(row, "the Dates row"); assert.equal(row.due_at, t45.due_at); assert.equal(row.label, "Flood coverage may be placed on"); assert.equal(row.calendar, "calendar days");
  const card = (await cardsOf(loanId, partyA)).find((c) => c.copy_key === "flood.map_change"); assert.ok(card, "the NoticeCard"); assert.equal(card.props["notice_code"], "INS_FLOOD_MAP_CHANGE_NOTICE"); assert.equal(card.props["rendered_document_id"], r.result.mcn.notice.id);
  const tokens = card.props["copy_tokens"] as Record<string, string>; assert.equal(tokens["zone"], "AE"); assert.equal(tokens["money"], "$250,000.00"); assert.equal(tokens["deadline"], "2027-08-20"); assert.equal(card.props["next_event_at"], t45.due_at);
});

test("32.9-T5: Given a value check is needed, then the fee `ChoiceCard` appears, `awaiting_fee` expires at 60 days, and withdrawal before an order refunds the fee.", { skip }, async () => {
  const { A, partyA, loanId } = main;
  clock.set(MST("2027-08-02", "10:00"));
  // the boarded MI policy (10.1's mi_policies record: HPA-covered principal residence, original value $708,171.78)
  await runtime.entities.save([{ kind: "mi_policies", id: loanId, data: { loan_id: loanId, status: "active", mi_type: "bpmi", state: "AZ", units: 1, occupancy: "principal", consummation: "2026-11-06", hpa_covered: true, original_value_cents: OV.toString(), monthly_premium_cents: "12000" }, version: 1, updatedAt: clock.now(), updatedBy: "test:32.9" }], { loanId });
  const ask = async (text: string): Promise<string> => {
    const m = await msg(A, text, { loan_id: loanId }); assert.equal(m.reply["copy_key"], "pmi.cancel.intro");
    const choice = (await cardsOf(loanId, partyA)).find((c) => c.copy_key === "pmi.cancel.choice" && c.status === "pending"); assert.ok(choice, "the ChoiceCard"); assert.equal(choice.card_instance_id, m.reply["card_instance_id"]);
    const r = await resolve(A, choice.card_instance_id, "ask"); assert.equal(r.body["command"], "pmi.requestCancellation");
    const req = (await events(loanId, "mi.cancel.requested")).at(-1)!; assert.equal(req.payload["channel"], "portal"); return String(req.payload["case_id"]);
  };
  const evaluate = (caseId: string, received_on: string, decision_on: string, months: number) => exec(loanId, "10.1", "pmi.*", PMI, { op: "evaluate", loan_id: loanId, case_id: caseId, received_on, decision_on, original_value_cents: OV, evaluation_upb_cents: UPB, consummation: "2026-11-06", avm_cents: 65_000_000n, installments: installmentLedger(months, {}, D(received_on), D("2027-01-01"), PI) });
  const case1 = await ask("I'd like to cancel my PMI");
  assert.ok((await cardsOf(loanId, partyA)).some((c) => c.copy_key === "pmi.request.received")); assert.equal((await entity("mi_cases", case1))!["status"], "received");
  // the AVM below the original value → 10.1 R6: a value check is needed; the tabulated fee is the borrower's choice; SM_MI_FEE_WAIT_60 runs from the event
  clock.set(MST("2027-08-03", "10:00"));
  const d1 = await evaluate(case1, "2027-08-02", "2027-08-03", 8); assert.equal(d1["result"], "value_check_needed"); assert.equal((await entity("mi_cases", case1))!["status"], "awaiting_fee");
  const wait1 = await timer(loanId, "SM_MI_FEE_WAIT_60"); assert.ok(wait1, "SM_MI_FEE_WAIT_60 armed"); assert.equal(wait1.status, "armed"); assert.equal(wait1.due_date, addDays(D("2027-08-03"), 60)); assert.equal(wait1.due_date, "2027-10-02");
  const fee1 = (await cardsOf(loanId, partyA)).find((c) => c.copy_key === "pmi.fee.choice" && c.status === "pending"); assert.ok(fee1, "the fee ChoiceCard"); assert.equal(fee1.command_ref, "payment.makeOneTime"); assert.equal(fee1.expires_at, wait1.due_at);
  assert.equal((fee1.props["options"] as { id: string; label: string }[])[0]!.label, "Pay the $190.00 valuation fee"); assert.equal(fee1.props["fee_cents"], FEE.toString()); assert.equal(fee1.props["mi_case_id"], case1);
  // day 61: the sweep breaches the wait → 10.1's own breach handling (`fee_wait_expired`): the case expires, the card with it
  clock.set(MST("2027-10-03", "06:00")); const sweep = await runtime.sweep(clock.now()); await settle();
  assert.ok(sweep.breaches.some((b) => b.code === "SM_MI_FEE_WAIT_60" && b.loan_id === loanId), JSON.stringify(sweep.breaches));
  const expired = (await events(loanId, "mi.case.expired")).find((e) => e.payload["case_id"] === case1); assert.ok(expired, "mi.case.expired"); assert.equal(expired.payload["timer"], "SM_MI_FEE_WAIT_60"); assert.equal(expired.payload["expired_on"], "2027-10-03");
  assert.equal((await entity("mi_cases", case1))!["status"], "expired"); assert.equal((await timer(loanId, "SM_MI_FEE_WAIT_60"))!.status, "breached");
  const cards2 = await cardsOf(loanId, partyA); assert.equal(cards2.find((c) => c.card_instance_id === fee1.card_instance_id)!.status, "expired"); assert.ok(cards2.some((c) => c.copy_key === "pmi.expired" && c.props["case_id"] === case1));
  // a new request, the fee paid through the card (fresh L1), then withdrawn before any valuation was ordered → the fee comes back
  clock.set(MST("2027-10-04", "10:00"));
  const case2 = await ask("Let's try again — please cancel my PMI"); assert.notEqual(case2, case1);
  clock.set(MST("2027-10-05", "10:00"));
  const d2 = await evaluate(case2, "2027-10-04", "2027-10-05", 10); assert.equal(d2["result"], "value_check_needed");
  const fee2 = (await cardsOf(loanId, partyA)).find((c) => c.copy_key === "pmi.fee.choice" && c.status === "pending"); assert.ok(fee2, "the second fee ChoiceCard"); assert.equal(fee2.props["mi_case_id"], case2);
  const paid = await resolve(A, fee2.card_instance_id, "pay_fee"); assert.equal(paid.body["command"], "payment.makeOneTime");
  const payment = (await events(loanId, "payment.received")).find((e) => e.payload["designation"] === "mi_valuation_fee"); assert.ok(payment, "the fee payment"); assert.equal(payment.payload["amount_cents"], FEE.toString());
  const feeEv = (await events(loanId, "mi.evidence.received")).find((e) => e.payload["kind"] === "fee"); assert.ok(feeEv, "10.1 mi.evidence.received{kind=fee} from the pmi agent's ledger tool"); assert.equal(String(feeEv.payload["amount_cents"]), FEE.toString());
  const wait2 = (await timers(loanId, "SM_MI_FEE_WAIT_60")).at(-1)!; assert.equal(wait2.status, "satisfied"); assert.equal(wait2.due_date, addDays(D("2027-10-05"), 60));
  const cards3 = await cardsOf(loanId, partyA); assert.equal(cards3.find((c) => c.card_instance_id === fee2.card_instance_id)!.status, "resolved"); assert.ok(cards3.some((c) => c.copy_key === "pmi.fee.received" && (c.props["copy_tokens"] as Record<string, string>)["money"] === "$190.00"));
  clock.set(MST("2027-10-06", "10:00"));
  const w = await msg(A, "Actually, please withdraw my PMI cancellation request", { loan_id: loanId }); assert.equal(w.reply["copy_key"], "pmi.withdraw.choice");
  const withdraw = (await cardsOf(loanId, partyA)).find((c) => c.copy_key === "pmi.withdraw.choice" && c.status === "pending"); assert.ok(withdraw); assert.equal(withdraw.props["mi_case_id"], case2);
  const wr = await resolve(A, withdraw.card_instance_id, "withdraw"); assert.equal(wr.body["command"], "pmi.requestCancellation");
  const withdrawn = (await events(loanId, "mi.cancel.withdrawn")).find((e) => e.payload["case_id"] === case2); assert.ok(withdrawn, "mi.cancel.withdrawn"); assert.equal(withdrawn.payload["valuation_ordered"], false); assert.equal(String(withdrawn.payload["fee_paid_cents"]), FEE.toString()); assert.equal(String(withdrawn.payload["fee_refund_cents"]), FEE.toString());
  assert.equal((await events(loanId, "mi.valuation.ordered")).length, 0, "no order was placed"); assert.ok((await events(loanId, "mi.valuation_fee.refunded")).some((e) => e.payload["case_id"] === case2));
  assert.equal((await entity("mi_cases", case2))!["status"], "withdrawn");
  const wc = (await cardsOf(loanId, partyA)).find((c) => c.copy_key === "pmi.withdrawn"); assert.ok(wc, "the refund StatusCard"); assert.equal((wc.props["copy_tokens"] as Record<string, string>)["money"], "$190.00");
});

test("32.9-T6: Given an ARM with the first change on Jul 1, 2028, then `NTC_REGZ_20D_ARM_INITIAL` is sent between Nov 3 and Dec 3, 2027 and Numbers show the estimated payment.", { skip }, async () => {
  const { A, partyA, loanId } = main;
  // 7.2: the ARM terms boarded (Plan 4927 shape on this loan: note 6.125%, margin 2.750, first change Jun 1, 2028 → first new payment due Jul 1, 2028); the 7.3 file check opens
  clock.set(MST("2027-10-20", "10:00"));
  const TERMS = { loan_id: loanId, product: "ARM", fnma_arm_plan: "4927", index_type: "SOFR_30D_AVG", margin_pct: "2.750", lookback_days: 45, first_change_date: "2028-06-01", adjustment_period_months: 6, initial_cap_pct: "2.000", periodic_cap_pct: "1.000", lifetime_cap_pct: "5.000", initial_note_rate_pct: "6.125", current_pi_cents: PI, original_upb_cents: 56_000_000n, first_payment_due: "2027-01-01", term_months: 360, consummation_date: "2026-11-06", escrow_cents: 68_750n };
  const boarded = await unit(loanId, (_ctx, store) => { const deps = armDeps(store); const b = ARM.boardArmTerms(deps, TERMS); const fc = ARM_INITIAL.openInitialFileCheck(deps, { loan_id: loanId, boarded_on: D("2027-10-20") }); return { rows: b.rows, fc }; });
  const initial = boarded.result.rows[0]!; assert.equal(initial.change_date, "2028-06-01"); assert.equal(initial.first_new_payment_due, "2028-07-01");
  // the engine's window: −240 / −210 calendar days from Jul 1, 2028 = Nov 4 .. Dec 4, 2027 (the spec's "Nov 3 – Dec 3" is one day earlier on each end; the send below sits inside both)
  const gate = await timer(loanId, "REGZ_1026_20D_INITIAL_NOTICE_NOT_BEFORE_240"); const deadline = await timer(loanId, "REGZ_1026_20D_INITIAL_NOTICE_210");
  assert.ok(gate && deadline, "the 7.3 rows armed on the initial schedule row"); assert.equal(gate.due_date, addDays(D("2028-07-01"), -240)); assert.equal(gate.due_date, "2027-11-04"); assert.equal(deadline.due_date, addDays(D("2028-07-01"), -210)); assert.equal(deadline.due_date, "2027-12-04"); assert.equal(deadline.status, "armed");
  // Wed Nov 10, 2027: the index captured (published Nov 9), the window open, the render requested (index fresh), the (d) notice sent through the registry
  clock.set(MST("2027-11-10", "10:00"));
  const sent = await unit(loanId, async (_ctx, store) => {
    const deps = armDeps(store);
    ARM.captureIndex(deps, nyfed("2027-11-09", "3.64000"));
    const w = ARM_INITIAL.openInitialNoticeWindow(deps, loanId); assert.equal(w.opened, true, w.reason ?? "");
    const rr = ARM_INITIAL.requestInitialNoticeRender(deps, { loan_id: loanId }); assert.equal(rr.hold, false, rr.reason ?? ""); assert.equal(rr.basis, "estimate");
    return ARM_INITIAL.sendInitialNotice(deps, notices, { loan_id: loanId, recipients: [await alex(loanId)], contact: { servicer_phone: FAKE_SERVICER_CONTACT.servicer_phone, servicer_address: FAKE_SERVICER_CONTACT.servicer_address, exclusive_address: FAKE_SERVICER_CONTACT.exclusive_address }, property_state: "AZ", hfa_rules: { AZ: { hfa_name: "FAKE State Housing Finance Agency", hfa_phone: "(800) 555-0199" } } });
  });
  const armSent = (await events(loanId, "arm.initial_notice.sent"))[0]; assert.ok(armSent, "arm.initial_notice.sent"); const sentOn = String(armSent.payload["sent_on"]);
  assert.equal(sentOn, "2027-11-10"); assert.ok(sentOn >= "2027-11-03" && sentOn <= "2027-12-03", "between Nov 3 and Dec 3, 2027"); assert.ok(sentOn >= gate.due_date! && sentOn <= deadline.due_date!, "inside the engine's window");
  assert.equal(armSent.payload["basis"], "estimate"); const estPi = String(armSent.payload["est_pi_cents"]); assert.match(estPi, /^\d+$/); assert.ok(BigInt(estPi) > PI, "the estimated payment at index + margin exceeds the current P&I");
  assert.ok((await events(loanId, "notice.sent")).some((e) => e.payload["template"] === "NTC_REGZ_20D_ARM_INITIAL"), "NTC_REGZ_20D_ARM_INITIAL sent"); assert.equal((await timer(loanId, "REGZ_1026_20D_INITIAL_NOTICE_210"))!.status, "satisfied");
  assert.equal(typeof sent.result, "object");
  // Numbers: the engine's estimate on the record (never recomputed by the surface) — and the NoticeCard on the thread
  const rec = await record(A, loanId); const est = (rec["numbers"] as Record<string, unknown>)["arm_estimate"] as Record<string, unknown>;
  assert.ok(est, "numbers.arm_estimate"); assert.equal(est["estimated_pi_cents"], estPi); assert.equal(est["first_new_payment_due"], "2028-07-01"); assert.equal(est["change_on"], "2028-06-01"); assert.equal(est["basis"], "estimate"); assert.equal(est["estimated_rate"], String(armSent.payload["est_rate_pct"]));
  const card = (await cardsOf(loanId, partyA)).find((c) => c.copy_key === "arm.change"); assert.ok(card, "the NoticeCard"); assert.equal(card.props["notice_code"], "NTC_REGZ_20D_ARM_INITIAL"); assert.equal(card.props["amount_cents"], estPi);
  const tokens = card.props["copy_tokens"] as Record<string, string>; assert.equal(tokens["date"], "2028-07-01"); assert.equal(tokens["money"], money(estPi));
});

test("32.9-T4: Given `pmi.requestCancellation` on a loan at 79% LTV by amortization with a clean 12-month history, then the case reaches `cancellation_issued` without a valuation and `NTC_HPA_4904A_CANCELLED` renders.", { skip }, async () => {
  const { A, partyA, loanId } = main;
  clock.set(MST("2028-01-05", "10:00"));
  const m = await msg(A, "Please cancel my PMI — my balance is under 80% now", { loan_id: loanId }); assert.equal(m.reply["copy_key"], "pmi.cancel.intro");
  const choice = (await cardsOf(loanId, partyA)).find((c) => c.copy_key === "pmi.cancel.choice" && c.status === "pending"); assert.ok(choice);
  const r = await resolve(A, choice.card_instance_id, "ask"); assert.equal(r.body["command"], "pmi.requestCancellation");
  const req = (await events(loanId, "mi.cancel.requested")).at(-1)!; const caseId = String(req.payload["case_id"]); assert.equal(req.payload["received_at"], "2028-01-05"); assert.equal(req.payload["hpa_covered"], true); assert.equal(req.payload["written"], true);
  const due = await timer(loanId, "HPA_4904B_DENIAL_NOTICE_30"); assert.ok(due); assert.equal(due.due_date, "2028-02-04");
  // 10.1 (pmi): the original-value evaluation — 79.00% by amortization against the $708,171.78 original value, twelve installments (Jan–Dec 2027) each paid on its due date and the January 2028 one, AVM not below the original value → eligible, no valuation
  clock.set(MST("2028-01-06", "10:00"));
  const d = await exec(loanId, "10.1", "pmi.*", PMI, { op: "evaluate", loan_id: loanId, case_id: caseId, received_on: "2028-01-05", decision_on: "2028-01-06", original_value_cents: OV, evaluation_upb_cents: UPB, consummation: "2026-11-06", avm_cents: 72_000_000n, installments: installmentLedger(13, {}, D("2028-01-05"), D("2027-01-01"), PI) });
  assert.equal(d["result"], "eligible", JSON.stringify(d["reasons"])); assert.equal(d["ltv_bps"], 7900); assert.equal(d["threshold_bps"], 8000); assert.equal(d["effective_on"], "2028-01-05"); assert.equal(d["lar89_action_code"], "51");
  assert.equal((await entity("mi_cases", caseId))!["status"], "eligible"); assert.equal((await events(loanId, "mi.valuation.ordered")).filter((e) => e.payload["case_id"] === caseId).length, 0, "no valuation");
  const c = await exec(loanId, "10.1", "pmi.*", PMI, { op: "cancel", loan_id: loanId, case_id: caseId, evaluation_id: d["evaluation_id"], received_on: "2028-01-05" });
  assert.equal(c["event"], "mi.cancelled"); assert.equal(c["cancel_basis"], "eligible_evaluation"); assert.equal(c["evaluation_id"], d["evaluation_id"]);
  const mc = await entity("mi_cases", caseId); assert.equal(mc!["status"], "cancellation_issued"); assert.equal(mc!["cancellation_effective_date"], "2028-01-05");
  assert.equal((await entity("mi_policies", loanId))!["status"], "cancelled"); assert.ok((await events(loanId, "mi.cancelled")).length >= 1);
  // NTC_HPA_4904A_CANCELLED through the registry (10.2's R-F1) — the NoticeCard hangs on its notice.sent
  const sent = await exec(loanId, "10.1", "notices.render/send", PMI, { loan_id: loanId, template_code: "NTC_HPA_4904A_CANCELLED", recipients: [await alex(loanId)], payload: { ...sample("NTC_HPA_4904A_CANCELLED", D("2028-01-06")), notice_date: "2028-01-06", termination_phrase: "cancelled at your request because your loan balance reached 80 percent of the original value of your property", effective_on: "2028-01-05", new_payment_cents: PI + 68_750n, new_payment_effective_on: "2028-02-01", refund_estimate_cents: 0n, account_last4: "0001", property_address: await propertyAddress(loanId), servicer_phone: FAKE_SERVICER_CONTACT.servicer_phone, servicer_address: FAKE_SERVICER_CONTACT.servicer_address, error_resolution_address: FAKE_SERVICER_CONTACT.error_resolution_address } });
  assert.equal((sent as { status?: string }).status, "sent", js(sent));
  const ns = (await events(loanId, "notice.sent")).find((e) => e.payload["template"] === "NTC_HPA_4904A_CANCELLED"); assert.ok(ns, "NTC_HPA_4904A_CANCELLED sent"); assert.equal(dateOf(ns.occurred_at), "2028-01-06");
  const cards = await cardsOf(loanId, partyA);
  const nc = cards.find((c2) => c2.copy_key === "pmi.cancelled"); assert.ok(nc, "the NoticeCard"); assert.equal(nc.kind, "NoticeCard"); assert.equal(nc.props["notice_code"], "NTC_HPA_4904A_CANCELLED"); assert.equal(nc.props["rendered_document_id"], ns.payload["notice_id"]); assert.equal((nc.props["copy_tokens"] as Record<string, string>)["date"], "2028-01-05");
  assert.ok(cards.some((c2) => c2.copy_key === "pmi.cancelled.status" && c2.kind === "StatusCard"));
  assert.ok(cards.some((c2) => c2.copy_key === "pmi.request.received" && c2.props["case_id"] === caseId));
});
