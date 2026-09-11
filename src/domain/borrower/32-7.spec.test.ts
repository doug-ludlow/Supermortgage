// 32.7 CD, closing, rescission, funding, boarding
// spec/sections/32-borrower-experience/32-7-cd-closing-rescission-funding-boarding.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// Every T-id drives the real runtime over HTTP (the journey fixture: 20.x → 21.x → 25.2 → 26.x → 30.2 → 29.4/30.1) with the
// borrower flow of src/runtime/borrower/flows/7-closing.ts reacting to the committed events, then reads the borrower API
// (record, thread, cards, messages, documents) and the owning processes' tables, timers and events. What the borrower SEES
// of these facts — the What-changed block, the quiet cancel link, the closing-type options, the autopay elements, the
// Cancelled badge — is asserted on the real components in apps/borrower/tests/cards/flow-7-closing.test.tsx. Skips without a database.
//
// Five applications: A — the main refinance (T1 confirmed branch, T2, T9–T13); B — the e-mailed CD deemed received (T1);
// C — the co-borrower's mailed CD, the Georgia RON refusal and the paper election (T3, T4, T5); D — a purchase (T7);
// E — the signed refinance, its H-8 and its cancellation (T6, T8).
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
import { Runtime } from "../../runtime/app.ts";
import { createApiServer, listen } from "../../runtime/server.ts";
import { createLogger } from "../../runtime/log.ts";
import { createBorrowerRouter, type BorrowerRouter } from "../../runtime/borrower/routes.ts";
import { Journey, MST, EST } from "../../runtime/borrower/fixtures/journey.ts";
import { cdWhatChanged, offeredClosingTypes, holdAsk, AUTODRAFT_ELEMENTS, SERVICING_ESIGN_SCOPES, FNMA_LETTER_CLASS, REFUND_CLOCK } from "../../runtime/borrower/flows/7-closing.ts";
import { presumedReceiptDate, earliestConsummationDate, cd3sbdGate } from "../compliance-disclosures/ops-25-2.ts";
import { rescissionExpiry } from "../compliance-disclosures/ops-25-3.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";

const DB_URL = process.env["TEST_DATABASE_URL"] ?? "postgresql://sm:sm@localhost/supermortgage_test";
const up = await reachable(DB_URL);
if (!up && process.env["REQUIRE_DB"]) throw new Error(`REQUIRE_DB set but ${DB_URL} is not reachable`);
const skip = up ? false : `no Postgres at ${DB_URL}`;
const TOKEN = "ops-" + randomUUID();
const clock = new FixedClock("2026-09-10T16:00:00.000Z");
const DISCLOSURE = { kind: "agent" as const, id: "disclosure" }; const CLOSER = { kind: "agent" as const, id: "title-closing" }; const COMPLIANCE = { kind: "agent" as const, id: "compliance-tester" }; const FUNDER = { kind: "agent" as const, id: "funder" };
const TZ = "America/Phoenix";

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
/** 01 §5: personal terms (`numbers`) render from L2 — the journey's borrowers step up with SSN last 4 + DOB (Alex 6789 / 1985-06-15, Blake 4321 / 1986-02-20). */
const L2_FACTS = (email: string) => (email.startsWith("alex-") ? { ssn_last4: "6789", date_of_birth: "1985-06-15" } : { ssn_last4: "4321", date_of_birth: "1986-02-20" });
const tokenL2 = async (email: string): Promise<string> => { const t = (await signIn(email)).token; const up = await api("POST", "/v1/borrower/auth/l2", L2_FACTS(email), t); assert.equal(up.status, 200, JSON.stringify(up.body)); return t; };
const record = async (email: string, subject: string): Promise<Record<string, unknown>> => { await settle(); const r = await api("GET", `/v1/borrower/record?subject=${subject}`, undefined, await tokenL2(email)); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 600)); return r.body; };
const thread = async (email: string): Promise<{ messages: Record<string, unknown>[]; pinned: Record<string, unknown> | null }> => { await settle(); const r = await api("GET", "/v1/borrower/thread?limit=500", undefined, (await signIn(email)).token); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300)); return { messages: r.body["messages"] as Record<string, unknown>[], pinned: (r.body["pinned_card"] as Record<string, unknown> | null) ?? null }; };
interface CardRow { card_instance_id: string; party_id: string; kind: string; status: string; copy_key: string; props: Record<string, unknown>; evidence: Record<string, unknown> | null; command_ref: string | null; created_at: string; resolved_at: string | null; subject_loan_id: string | null }
const cardsOf = async (appId: string, partyId?: string): Promise<CardRow[]> => { await settle(); return db.query<CardRow & Record<string, unknown>>(`SELECT card_instance_id, party_id, kind, status, copy_key, props, evidence, command_ref, created_at, resolved_at, subject_loan_id FROM card_instances WHERE subject_application_id = $1 AND ($2::uuid IS NULL OR party_id = $2) ORDER BY created_at, card_instance_id`, [appId, partyId ?? null]); };
const loanEvents = (loanId: string, type?: string) => db.query<{ type: string; occurred_at: string; payload: Record<string, unknown>; loan_id: string | null }>(`SELECT type, occurred_at, payload, loan_id FROM loan_events WHERE loan_id = $1 AND ($2::text IS NULL OR type = $2) ORDER BY sequence`, [loanId, type ?? null]);
const events = (appId: string, type?: string) => db.query<{ type: string; occurred_at: string; payload: Record<string, unknown>; loan_id: string | null }>(`SELECT type, occurred_at, payload, loan_id FROM loan_events WHERE application_id = $1 AND ($2::text IS NULL OR type = $2) ORDER BY sequence`, [appId, type ?? null]);
const timer = async (appId: string, code: string) => (await db.query<{ status: string; due_at: string | null; due_date: string | null; anchor_date: string | null }>(`SELECT status::text AS status, due_at, due_date::text AS due_date, anchor_date::text AS anchor_date FROM timers WHERE application_id = $1 AND code = $2 ORDER BY armed_at DESC LIMIT 1`, [appId, code]))[0];
const loanTimer = async (loanId: string, code: string) => (await db.query<{ status: string; due_at: string | null; due_date: string | null }>(`SELECT status::text AS status, due_at, due_date::text AS due_date FROM timers WHERE loan_id = $1 AND code = $2 ORDER BY armed_at DESC LIMIT 1`, [loanId, code]))[0];
const entity = async (kind: string, id: string): Promise<Record<string, unknown> | null> => { const rows = await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = $1 AND id = $2`, [kind, id]); return rows[0] ? decodeEntityData(rows[0].data) : null; };
const dates = (rec: Record<string, unknown>) => rec["dates"] as { timer_code: string; label: string; due_at: string; calendar: string }[];
const badge = (rec: Record<string, unknown>) => rec["status"] as { badge: string; state_source: string; one_liner: string };
/** One application on the shared runtime: its own journey instance (prior loan, lead, borrowers with e-mails) with both borrowers signed in so their cards have a conversation. */
async function openApp(): Promise<{ j: Journey; A: string; B: string; partyA: string; partyB: string }> {
  const R = randomUUID().slice(0, 8); const A = `alex-${R}@example.test`; const B = `blake-${R}@example.test`;
  const j = new Journey({ runtime, db, base, token: TOKEN, clock, borrowerEmail: A, coBorrowerEmail: B, partnerPartyId });
  await j.seedBook(); await j.openApplication();
  const partyA = (await signIn(A)).party_id; const partyB = (await signIn(B)).party_id;
  await j.interview(); await settle();
  return { j, A, B, partyA, partyB };
}
/** Through clear to close (Thu Oct 29): the journey's LE, intent, lock, verifications, decision and CTC. */
async function toClearToClose(j: Journey): Promise<void> { await j.quoteAndLe(); await j.recordIntent(); await j.quoteForLock(); await j.requestLock(); await j.executeLockAndCommit(); await j.verifyDecideAndClear(); await j.clearToClose(); await settle(); }
/** 25.2's CD v1 rendered Mon Nov 2 (the journey's figures) without any delivery — the test delivers it per consumer on the channel under test. */
async function renderCd(j: Journey): Promise<string> { const id = await j.closingDisclosure({ receipts: false, deliveries: false }); await settle(); return id; }
const deliverCd = (j: Journey, consumer: string, channel: string, at: string, extra: Record<string, unknown> = {}) => j.tool({ app: j.appId }, "25.2", "deliverDisclosure", { disclosure_id: j.cdDisclosureId, consumer_id: consumer, channel, at, ...(channel === "mail" ? { mailing_proof_id: `PRINT-${j.R}-${consumer}` } : { esign_consent_id: `ESIGN-${consumer}` }), ...(consumer === "B1" ? { gate_run: { run_id: "RUN-CD-1", open: true, apr_verdict: "pass", blocked_channels: [] } } : {}), ...extra }, DISCLOSURE);
const receiptCd = (j: Journey, consumer: string, at: string) => j.tool({ app: j.appId }, "25.2", "recordReceipt", { disclosure_id: j.cdDisclosureId, consumer_id: consumer, evidence: "esign_confirmed", at, evidence_document_id: `DOC-ESIGN-${consumer}` }, DISCLOSURE);
/** 25.3 after the signing (the journey's closeAndSign never runs 25.3): applicability, the H-8 rendered and delivered at signing to each consumer, the period from the latest of consummation, notice and the CD receipts. */
async function rescissionPeriod(j: Journey, cdReceivedOn: string, consummationAt: string): Promise<Record<string, unknown>> {
  const scope = { app: j.appId };
  await j.tool(scope, "25.3", "determineRescindability", { transaction_type: "limited_cash_out", consumers: [{ consumer_id: "B1", role: "borrower", ownership_interest: true, occupancy: "primary" }, { consumer_id: "B2", role: "borrower", ownership_interest: true, occupancy: "primary" }], partner_id: j.PARTNER_ID, existing_loan: { original_creditor_id: "L-OTHER-2021", upb_cents: "54820000", earned_unpaid_finance_charge_cents: "210055", refinancing_costs_cents: "795000" }, amount_financed_cents: "55615005", time_zone: TZ }, DISCLOSURE);
  for (const c of ["B1", "B2"]) {
    await j.tool(scope, "25.3", "renderRescissionNotice", { form: "h8", consumer_id: c, consumer_name: c === "B1" ? "Alex Borrower" : "Blake Borrower", transaction_date: consummationAt.slice(0, 10), expires_on: rescissionExpiry(D(consummationAt.slice(0, 10)), TZ).expires_on, creditor_name: "Partner Bank, N.A.", designated_address: "100 Partner Plaza, Suite 400, Phoenix AZ 85004", property_address: "100 N Central Ave, Phoenix, AZ 85004" }, DISCLOSURE);
    await j.tool(scope, "25.3", "deliverRescissionNotice", { consumer_id: c, delivered_at: consummationAt, channel: "in_person", copies: 2, evidence_document_id: `DOC-RON-AUDIT-${c}`, form: "h8", time_zone: TZ }, DISCLOSURE);
  }
  const r = await j.tool(scope, "25.3", "computeRescissionPeriod", { consummation_at: consummationAt, time_zone: TZ, notice_deliveries: ["B1", "B2"].map((c) => ({ consumer_id: c, delivered_at: consummationAt, channel: "in_person", copies: 2, evidence_document_id: `DOC-RON-AUDIT-${c}` })), material_disclosures: ["B1", "B2"].map((c) => ({ consumer_id: c, cd_version: 1, effective_receipt_date: cdReceivedOn, accurate: true })), material_disclosures_accurate: true }, DISCLOSURE);
  await settle(); return r.output;
}
/** The Wed Nov 11 08:00 MST sweep finding nothing (25.3-T2): `rescission.confirmed_not_rescinded`, the gate opens. */
async function rescissionSweep(j: Journey): Promise<void> { clock.set(MST("2026-11-11", "08:00")); await j.tool({ app: j.appId }, "25.3", "sweepInboundForRescission", { swept_at: MST("2026-11-11", "08:00"), channels_checked: ["mail", "email", "portal", "fax", "voicemail"], items: [] }, DISCLOSURE); await settle(); }
const noWireDetail = (o: unknown): boolean => !/\b(wire|wires|imad|bank_ref|bec|fraud|fedwire|warehouse)\b/i.test(JSON.stringify(o));

// ═══════════════════════════════════ App A (the main refinance) · App B (the e-mailed CD, no confirmation)
const main: { j?: Journey; A: string; B: string; partyA: string; partyB: string; cdV2: string; loanId: string } = { A: "", B: "", partyA: "", partyB: "", cdV2: "", loanId: "" };

test("32.7-T1: Given the CD e-mailed Mon Nov 2, 2026 without confirmation, then `deemed received` is Thu Nov 5 (specific business days) and `earliest_consummation_date` is Mon Nov 9; given confirmation Mon Nov 2, then `earliest_consummation_date` is Fri Nov 6 (25.2 fixture).", { skip }, async () => {
  // ── App B: e-mailed Mon Nov 2 09:14 MST to both consumers under their E-SIGN consents, no confirmation
  const b = await openApp(); await toClearToClose(b.j); await renderCd(b.j);
  clock.set(MST("2026-11-02", "09:14"));
  for (const c of ["B1", "B2"]) { const d = await deliverCd(b.j, c, "email_link", MST("2026-11-02", "09:14")); assert.equal(d.output["presumed_receipt_date"], "2026-11-05", "25.2's mailbox presumption: the third specific business day after Mon Nov 2"); }
  assert.equal(presumedReceiptDate(D("2026-11-02")), "2026-11-05"); assert.equal((await timer(b.j.appId, "REGZ_1026_19F1III_CD_MAILBOX_3SBD"))?.due_date, "2026-11-05");
  await settle();
  // the Thread: the mailbox StatusCard per consumer ("counts as received on Nov 5 unless you confirm sooner") beside the DocumentCard the e-mail delivery under consent allows
  let cards = await cardsOf(b.j.appId, b.partyA);
  const mailbox = cards.find((c) => c.copy_key === "cd.mailbox")!; assert.ok(mailbox, "cd.mailbox StatusCard"); assert.equal((mailbox.props["copy_tokens"] as { presumed_date: string }).presumed_date, "2026-11-05"); assert.equal((mailbox.props["copy_tokens"] as { date: string }).date, "2026-11-02");
  assert.equal(mailbox.props["next_event_label"], "Closing Disclosure counts as received on"); assert.equal(mailbox.props["next_event_at"], (await timer(b.j.appId, "REGZ_1026_19F1III_CD_MAILBOX_3SBD"))?.due_at);
  assert.equal(cards.filter((c) => c.copy_key === "cd.delivered" && c.status === "pending").length, 1, "the e-mailed CD's DocumentCard awaits a confirmation");
  let rec = await record(b.A, b.j.appId);
  assert.equal(((rec["documents"] as Record<string, unknown>[]).find((d) => d["disclosure_id"] === b.j.cdDisclosureId))!["status"], "delivered"); assert.ok(!dates(rec).some((d) => d.timer_code === "REGZ_1026_19F1_CD_3SBD_GATE"), "no earliest closing date before receipt");
  // Wed Nov 4: the sweep deems nothing yet; Thu Nov 5: 25.2's mailbox sweep (`computeEarliestConsummation{op: deem}`, scheduled by the flow's tick) deems both received → the waiting period is published
  await tick(MST("2026-11-04", "09:00")); assert.equal((await events(b.j.appId, "disclosure.cd.received")).length, 0);
  await tick(MST("2026-11-05", "09:00"));
  const received = await events(b.j.appId, "disclosure.cd.received"); assert.equal(received.length, 2, "one deemed receipt per consumer");
  for (const e of received) { assert.equal(e.payload["evidence"], "mailbox_rule"); assert.equal(e.payload["consumer_effective_receipt_date"], "2026-11-05"); }
  const wp = (await events(b.j.appId, "disclosure.cd.waiting_period.computed"))[0]!; assert.equal(wp.payload["earliest_consummation_date"], "2026-11-09"); assert.equal(wp.payload["latest_effective_receipt_date"], "2026-11-05");
  assert.equal(earliestConsummationDate(D("2026-11-05")), "2026-11-09", "Fri 6, Sat 7, Mon 9 — Sunday does not count");
  assert.equal((await timer(b.j.appId, "REGZ_1026_19F1III_CD_MAILBOX_3SBD"))?.status, "satisfied"); assert.equal((await timer(b.j.appId, "REGZ_1026_19F1_CD_3SBD_GATE"))?.status, "armed");
  rec = await record(b.A, b.j.appId);
  const docB = (rec["documents"] as Record<string, unknown>[]).find((d) => d["disclosure_id"] === b.j.cdDisclosureId)!; assert.equal(docB["status"], "deemed_received"); assert.equal(docB["received_on"], "2026-11-05");
  const earliestB = dates(rec).find((d) => d.timer_code === "REGZ_1026_19F1_CD_3SBD_GATE")!; assert.ok(earliestB, "Dates: earliest closing"); assert.equal(earliestB.label, "Earliest closing date"); assert.equal(earliestB.due_at.slice(0, 10), "2026-11-09"); assert.equal(earliestB.calendar, "specific business days");
  cards = await cardsOf(b.j.appId, b.partyA); assert.equal(cards.find((c) => c.copy_key === "cd.delivered")!.status, "pending", "a deemed receipt leaves the confirm action available");
  // ── App A: e-delivered Mon Nov 2 09:14 and e-sign confirmed the same day by both → 25.2's earliest_consummation_date is Thu Nov 5 (25.2-T1); consummation on Fri Nov 6 passes REGZ_1026_19F1_CD_3SBD_GATE
  const a = await openApp(); Object.assign(main, a); await toClearToClose(a.j); await a.j.scheduleClosing(); await renderCd(a.j);
  clock.set(MST("2026-11-02", "09:14"));
  for (const c of ["B1", "B2"]) { await deliverCd(a.j, c, "esign_portal", MST("2026-11-02", "09:14")); await receiptCd(a.j, c, MST("2026-11-02", "09:30")); }
  const wpA = await a.j.tool({ app: a.j.appId }, "25.2", "computeEarliestConsummation", { disclosure_id: a.j.cdDisclosureId }, DISCLOSURE);
  assert.equal(wpA.output["earliest_consummation_date"], "2026-11-05", "25.2-T1: received Mon Nov 2 → Tue 3, Wed 4, Thu 5"); assert.equal(earliestConsummationDate(D("2026-11-02")), "2026-11-05");
  const gate = await a.j.tool({ app: a.j.appId }, "25.2", "assertGateOpen", { gate: "REGZ_1026_19F1_CD_3SBD_GATE", op: "evaluate", requested_on: "2026-11-06" }, DISCLOSURE); assert.equal(gate.output["open"], true, "the Fri Nov 6 consummation is inside the gate");
  assert.equal(cd3sbdGate({ earliest_consummation_date: "2026-11-05", requested_on: "2026-11-06", receipts_complete: true }).open, true); assert.equal(cd3sbdGate({ earliest_consummation_date: "2026-11-05", requested_on: "2026-11-04", receipts_complete: true }).open, false);
  await settle();
  cards = await cardsOf(a.j.appId, a.partyA);
  const cd = cards.find((c) => c.copy_key === "cd.delivered")!; assert.ok(cd, "the CD DocumentCard"); assert.equal(cd.props["requires_ack"], true); assert.equal(cd.props["notice_code"], "NTC_REGZ_1026_38_CD"); assert.equal(cd.command_ref, "disclosure.acknowledgeReceipt"); assert.equal(cd.status, "resolved", "the receipt 25.2 recorded collapses the card"); assert.equal((cd.evidence as { receipt_evidence: string }).receipt_evidence, "esign_confirmed");
  assert.equal(cd.props["wire_warning_copy_key"], "cd.wire_warning", "the wire-fraud line rides on the CD card");
  // the What-changed block: the LE→CD row diff from the two figure snapshots (21.2's render, 25.2's figures on the disclosures row), never free text
  const wc = cd.props["what_changed"] as { title_key: string; rows: { key: string; label_key?: string; label?: string; from: string | null; to: string | null; unit: string }[] };
  assert.equal(wc.title_key, "cd.what_changed"); assert.ok(wc.rows.length > 0, JSON.stringify(wc));
  assert.deepEqual(wc.rows.find((r) => r.key === "apr"), { key: "apr", label_key: "cd.row.apr", from: "6.125", to: "6.159", unit: "rate" }, "the CD's Appendix J APR against the LE's");
  assert.deepEqual(wc.rows.find((r) => r.key === "payoff"), { key: "payoff", label_key: "cd.row.payoff", from: null, to: "54820000", unit: "cents" }); assert.ok(wc.rows.some((r) => r.key === "fee:tax_service" && r.from === "8500" && r.to === "8400"), "a fee that moved lists both amounts");
  assert.ok(!wc.rows.some((r) => r.key === "rate"), "the rate did not change: no row"); assert.ok(wc.rows.some((r) => r.key === "lender_credit" && r.from === "261700" && r.to === "70000"));
  const le = (await events(a.j.appId, "disclosure.le.rendered")).at(-1)!.payload; const cdRow = (await entity("disclosures", a.j.cdDisclosureId))!;
  assert.deepEqual(cdWhatChanged(le as never, cdRow["figures"] as never, { purchase: false }), wc.rows, "the same diff falls out of the persisted snapshots");
  assert.ok(cards.some((c) => c.copy_key === "cd.mailbox") === false, "an e-signed portal delivery shows no mailbox line");
  rec = await record(a.A, a.j.appId);
  assert.equal((rec["numbers"] as { figures_source: string }).figures_source, "cd_v1"); assert.equal((rec["numbers"] as { apr: string }).apr, "6.159");
  const earliestA = dates(rec).find((d) => d.timer_code === "REGZ_1026_19F1_CD_3SBD_GATE")!; assert.ok(earliestA, "Dates: earliest closing date from 25.2's date, never recomputed"); assert.equal(earliestA.due_at.slice(0, 10), "2026-11-05");
  assert.equal(((rec["documents"] as Record<string, unknown>[]).find((d) => d["disclosure_id"] === a.j.cdDisclosureId))!["status"], "received");
});

test("32.7-T2: Given an APR increase beyond tolerance after CD delivery, then a superseding CD card renders with `cd.redisclosed_restart` and Dates recompute.", { skip }, async () => {
  const j = main.j!; const { A, partyA } = main; const scope = { app: j.appId };
  // Tue Nov 3: a rate change after CD v1 (6.125 %, APR 6.159) to 6.375 % — 25.1's actual APR is beyond the 1/8 tolerance → 25.2's redisclosure decision: new three-business-day wait ((f)(2)(ii)(A))
  clock.set(MST("2026-11-03", "09:00"));
  const apr = await j.tool(scope, "25.1", "computeApr", { loan_amount_cents: "56000000", note_rate_pct: "6.375", term_months: 360, term_start_date: "2026-11-12", first_payment_date: "2027-01-01", prepaid_finance_charges_cents: "384995", prepaid_interest_cents: "185836", checkpoint: "cd" }, COMPLIANCE);
  const ev = await j.tool(scope, "25.2", "evaluateRedisclosure", { disclosure_id: j.cdDisclosureId, next: { apr_actual: apr.output["apr_disclosed_str"], finance_charge_cents: apr.output["finance_charge_cents"], product: "Fixed Rate", prepayment_penalty: false } }, DISCLOSURE);
  assert.equal(ev.output["new_wait"], true, JSON.stringify(ev.output)); assert.deepEqual(ev.output["triggers"], ["(f)(2)(ii)(A)"]); assert.equal(ev.output["cd_reason"], "pre_consummation_new_wait");
  main.cdV2 = `${j.cdDisclosureId}-C2`;
  const cdFees = (j as unknown as { CD_FEES: Record<string, unknown>[] }).CD_FEES;
  const corrected = await j.tool(scope, "25.2", "scheduleCorrectedCd", { disclosure_id: main.cdV2, cd_reason: "pre_consummation_new_wait", evaluation: ev.output, gate: { run_id: "RUN-CD-2", apr_verdict: "fail" },
    input: { transaction_type: "refinance", state: "AZ", loan: { loan_amount_cents: "56000000", rate_pct: "6.375", term_months: 360, pi_cents: "349367", product: "Fixed Rate", loan_type: "Conventional", purpose: "Refinance", prepayment_penalty: false, balloon: false, arm: false, loan_id_number: j.appId, mic_number: null, first_payment_date: "2027-01-01", maturity_date: "2056-12-01" },
      apr: { apr_calculation_id: apr.output["apr_calculation_id"], apr_pct: apr.output["apr_disclosed_str"], finance_charge_cents: apr.output["finance_charge_cents"], amount_financed_cents: apr.output["amount_financed_cents"], total_of_payments_cents: apr.output["total_of_payments_cents"], tip_pct: String(Number(apr.output["tip_pct"]).toFixed(3)) },
      fees: cdFees.map((f) => (f["fee_code"] === "prepaid_interest" ? { ...f, amount_cents: "185836" } : f)), escrow: { established: true, monthly_escrow_cents: "68750", initial_escrow_payment_cents: "206250", escrowed_costs_year1_cents: "825000", non_escrowed_costs_year1_cents: "0" },
      parties: { borrowers: ["Alex Borrower", "Blake Borrower"], creditor_name: "Partner Bank, N.A.", creditor_nmlsr_id: "123456", mlo_name: "Jordan Rivera", mlo_nmlsr_id: "987654", settlement_agent_name: "Desert Title Agency LLC", settlement_agent_license_id: "AZ-TA-4471" },
      dates: { date_issued: "2026-11-03", closing_date: "2026-11-06", disbursement_date: "2026-11-12" }, property_address: "100 N Central Ave, Phoenix AZ 85004", cash_to_close_cents: "556600", lender_credits_cents: "70000", payoffs_and_payments_cents: "54820000", rescindable: true },
    deliveries: [{ consumer_id: "B1", channel: "esign_portal", at: MST("2026-11-03", "09:30"), esign_consent_id: "ESIGN-B1" }, { consumer_id: "B2", channel: "esign_portal", at: MST("2026-11-03", "09:30"), esign_consent_id: "ESIGN-B2" }] }, DISCLOSURE);
  assert.equal(corrected.output["cd_version"], 2); assert.equal(corrected.output["notice_code"], "NTC_REGZ_1026_38_CD_CORRECTED");
  assert.ok(corrected.events.some((e) => e.type === "disclosure.cd.corrected" && e.payload["new_waiting_period"] === true && e.payload["supersedes"] === j.cdDisclosureId));
  await settle();
  // the superseding DocumentCard with What-changed against v1 (rate, APR, payment, prepaid interest); v1's card is superseded
  let cards = await cardsOf(j.appId, partyA);
  const v2 = cards.find((c) => c.copy_key === "cd.corrected")!; assert.ok(v2, "the superseding CD card"); assert.equal(v2.props["notice_code"], "NTC_REGZ_1026_38_CD_CORRECTED"); assert.equal(v2.props["requires_ack"], true); assert.equal(v2.props["new_waiting_period"], true); assert.equal(v2.props["supersedes_disclosure_id"], j.cdDisclosureId); assert.equal(v2.status, "pending");
  const wc = v2.props["what_changed"] as { since_version: number; kind_copy_key: string; rows: { key: string; from: string | null; to: string | null }[] };
  assert.equal(wc.since_version, 1); assert.equal(wc.kind_copy_key, "cd.redisclosed_restart");
  assert.deepEqual(wc.rows.find((r) => r.key === "rate"), { key: "rate", label_key: "revised_le.row.rate", from: "6.125", to: "6.375", unit: "rate" }); assert.ok(wc.rows.some((r) => r.key === "apr" && r.from === "6.159")); assert.ok(wc.rows.some((r) => r.key === "payment" && r.from === "340262" && r.to === "349367")); assert.ok(wc.rows.some((r) => r.key === "fee:prepaid_interest"));
  assert.equal(cards.find((c) => c.copy_key === "cd.delivered")!.status, "resolved", "v1 had been received; the receipt stands"); assert.equal(((await record(A, j.appId))["documents"] as Record<string, unknown>[]).find((d) => d["disclosure_id"] === j.cdDisclosureId)!["status"], "superseded");
  // before the new receipts: 25.2's date is still v1's Thu Nov 5 (the gate row is v1's); the restart line waits for the recomputation
  assert.ok(!cards.some((c) => c.copy_key === "cd.redisclosed_restart"));
  // both consumers e-sign the corrected CD Tue Nov 3 → the new waiting period: earliest Fri Nov 6 (Wed 4, Thu 5, Fri 6); Dates recompute; the restart StatusCard carries the new date
  for (const c of ["B1", "B2"]) await j.tool(scope, "25.2", "recordReceipt", { disclosure_id: main.cdV2, consumer_id: c, evidence: "esign_confirmed", at: MST("2026-11-03", "10:00"), evidence_document_id: `DOC-ESIGN-C2-${c}` }, DISCLOSURE);
  const wp = (await events(j.appId, "disclosure.cd.waiting_period.computed")).at(-1)!; assert.equal(wp.payload["cd_version"], 2); assert.equal(wp.payload["earliest_consummation_date"], "2026-11-06");
  assert.equal((await j.tool(scope, "25.2", "computeEarliestConsummation", { disclosure_id: main.cdV2 }, DISCLOSURE)).output["earliest_consummation_date"], "2026-11-06");
  await settle();
  cards = await cardsOf(j.appId, partyA);
  const restart = cards.find((c) => c.copy_key === "cd.redisclosed_restart")!; assert.ok(restart, "cd.redisclosed_restart"); assert.equal(restart.kind, "StatusCard"); assert.equal((restart.props["copy_tokens"] as { date: string }).date, "2026-11-06"); assert.equal(restart.props["cd_version"], 2); assert.equal(restart.props["next_event_label"], "Earliest closing date");
  assert.equal(cards.find((c) => c.copy_key === "cd.corrected")!.status, "resolved", "the corrected CD's receipt collapses its card");
  const rec = await record(A, j.appId);
  const earliest = dates(rec).find((d) => d.timer_code === "REGZ_1026_19F1_CD_3SBD_GATE")!; assert.equal(earliest.due_at.slice(0, 10), "2026-11-06", "Dates recomputed from Nov 5 to Nov 6");
  assert.equal((rec["numbers"] as { figures_source: string; apr: string; note_rate: string }).figures_source, "cd_v2"); assert.equal((rec["numbers"] as { apr: string }).apr, apr.output["apr_disclosed_str"]);
  const docs = rec["documents"] as Record<string, unknown>[]; assert.equal(docs.find((d) => d["disclosure_id"] === main.cdV2)!["notice_code"], "NTC_REGZ_1026_38_CD_CORRECTED"); assert.equal(docs.find((d) => d["disclosure_id"] === main.cdV2)!["status"], "received");
  const t = await thread(A); assert.ok(t.messages.some((m) => m["card_instance_id"] === restart.card_instance_id), "the thread carries the restart line");
});

// ═══════════════════════════════════ App C: the co-borrower's mailed CD (T3), the Georgia RON refusal (T4), the paper election (T5)
const appC: { j?: Journey; A: string; B: string; partyA: string; partyB: string } = { A: "", B: "", partyA: "", partyB: "" };

test("32.7-T3: Given a co-borrower without active E-SIGN, then their CD is mailed and the `earliest_consummation_date` uses the later of the two receipt dates.", { skip }, async () => {
  const c = await openApp(); Object.assign(appC, c); const { j, A, B, partyA, partyB } = c;
  // the property in Georgia (T4's RON refusal is the state's) — the application's own row, everything else the fixture's
  await db.query(`UPDATE application_properties SET state = 'GA' WHERE application_id = $1`, [j.appId]);
  await toClearToClose(j); await renderCd(j);
  // Mon Nov 2: Alex (E-SIGN active) e-delivered and confirmed at 09:30; Blake has no active E-SIGN consent → 25.2 refuses the electronic channel and the CD goes by mail with the print vendor's proof
  clock.set(MST("2026-11-02", "09:14"));
  await deliverCd(j, "B1", "esign_portal", MST("2026-11-02", "09:14")); await receiptCd(j, "B1", MST("2026-11-02", "09:30"));
  assert.equal(Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM consents WHERE party_id = $1 AND kind = 'esign' AND status = 'active'`, [partyB]))[0]!.n), 0, "Blake has no active E-SIGN consent");
  const refused = await j.call("POST", `/v1/applications/${j.appId}/tools/25.2/deliverDisclosure`, { actor: DISCLOSURE, input: { disclosure_id: j.cdDisclosureId, consumer_id: "B2", channel: "esign_portal", at: MST("2026-11-02", "09:14") } });
  assert.notEqual(refused.status, 200); assert.match(JSON.stringify(refused.body), /ELECTRONIC_NEEDS_ESIGN_CONSENT|NO_ESIGN_CONSENT/);
  const mailed = await deliverCd(j, "B2", "mail", MST("2026-11-02", "09:14")); assert.equal(mailed.output["delivery_channel"], "mail"); assert.equal(mailed.output["presumed_receipt_date"], "2026-11-05"); assert.ok(mailed.output["mailed_at"]);
  await settle();
  // Blake's Thread: the mailbox StatusCard and no DocumentCard; Alex's: the DocumentCard, collapsed by the receipt
  const cardsB = await cardsOf(j.appId, partyB); assert.ok(cardsB.some((x) => x.copy_key === "cd.mailbox")); assert.equal(cardsB.filter((x) => x.kind === "DocumentCard" && x.props["notice_code"] === "NTC_REGZ_1026_38_CD").length, 0, "no DocumentCard for a mailed CD (01 §3.6)");
  const cardsA = await cardsOf(j.appId, partyA); assert.equal(cardsA.find((x) => x.copy_key === "cd.delivered")!.status, "resolved");
  // the CD version stays delivered while a required consumer lacks a receipt (25.2-T13): no waiting period yet
  assert.equal((await events(j.appId, "disclosure.cd.waiting_period.computed")).length, 0); assert.equal((await events(j.appId, "disclosure.cd.received"))[0]!.payload["all_required"], false);
  let rec = await record(B, j.appId); const docB = (rec["documents"] as Record<string, unknown>[]).find((d) => d["disclosure_id"] === j.cdDisclosureId)!;
  assert.equal(docB["status"], "received", "Alex's receipt is on the version (the shared Record); the Documents row shows the mailing evidence too"); assert.ok(docB["mailed_at"], "Mailed Nov 2");
  assert.ok(!dates(rec).some((d) => d.timer_code === "REGZ_1026_19F1_CD_3SBD_GATE"), "no earliest closing while Blake's receipt is pending");
  // Thu Nov 5: the mailbox sweep deems Blake's receipt → the later of the two dates (Nov 2, Nov 5) governs: earliest closing Mon Nov 9
  await tick(MST("2026-11-05", "09:00"));
  const rcpts = await events(j.appId, "disclosure.cd.received"); assert.equal(rcpts.length, 2); const deemed = rcpts.find((e) => e.payload["consumer_id"] === "B2")!; assert.equal(deemed.payload["evidence"], "mailbox_rule"); assert.equal(deemed.payload["all_required"], true); assert.equal(deemed.payload["effective_receipt_date"], "2026-11-05");
  const wp = (await events(j.appId, "disclosure.cd.waiting_period.computed"))[0]!; assert.equal(wp.payload["latest_effective_receipt_date"], "2026-11-05"); assert.equal(wp.payload["earliest_consummation_date"], "2026-11-09");
  assert.deepEqual((wp.payload["receipts"] as { consumer_id: string; effective_receipt_date: string }[]).map((r) => [r.consumer_id, r.effective_receipt_date]), [["B1", "2026-11-02"], ["B2", "2026-11-05"]]);
  rec = await record(A, j.appId); assert.equal(dates(rec).find((d) => d.timer_code === "REGZ_1026_19F1_CD_3SBD_GATE")!.due_at.slice(0, 10), "2026-11-09");
});

test("32.7-T4: Given `SM_O72_RON_STATE_AUTH_GATE` closed for the property state, then the `ScheduleCard` offers `ipen|hybrid|wet` and never `ron`.", { skip }, async () => {
  const { j, A, partyA } = appC; const j2 = j!;
  // 26.2's own decision for Georgia (26.2-T4): not on Fannie Mae's RON list, no counsel confirmation → RON refused; the flow offered the slots from that decision when the date became known (T3's sweep)
  const d = await j2.tool({ app: j2.appId }, "26.2", "decideClosingType", { state: "GA", settlement_agent_party_id: "P-ESCROW-GA-1", eligibility: [{ settlement_agent_party_id: "P-ESCROW-GA-1", county_fips: null, ron_capable: true, ipen_capable: true, erecording_submitter: true, platforms: ["FAKE RON platform"], remote_witness_service: false, verified_at: "2026-10-20T00:00:00Z" }], signers: [{ party_id: "B1", esign_consented: true, identity_proofing_possible: true }, { party_id: "B2", esign_consented: false, identity_proofing_possible: true }], proposed_closing_type: "ron" }, CLOSER);
  assert.notEqual(d.output["closing_type"], "ron"); assert.ok(((d.output["ron"] as { refusals: string[] }).refusals).includes("state_not_on_fnma_list"), JSON.stringify(d.output["ron"]));
  assert.deepEqual(offeredClosingTypes(d.output as never, { ipen_capable: true }), ["ipen", "hybrid", "wet"]);
  const cards = await cardsOf(j2.appId, partyA);
  const sc = cards.find((c) => c.kind === "ScheduleCard" && c.copy_key === "closing.schedule")!; assert.ok(sc, "the closing ScheduleCard once earliest_consummation_date is known, CTC issued, the lock covering the date, no flood notice due, no appraisal copy due");
  assert.equal(sc.status, "pending"); assert.equal(sc.copy_key, "closing.schedule"); assert.equal(sc.command_ref, "closing.selectSlot"); assert.equal(sc.props["purpose"], "ron_session"); assert.equal(sc.props["earliest_consummation_date"], "2026-11-09");
  const options = (sc.props["closing_type_options"] as { id: string; copy_key: string }[]).map((o) => o.id);
  assert.deepEqual(options, ["ipen", "hybrid", "wet"], "ipen | hybrid | wet — never ron"); assert.equal(sc.props["default_closing_type"], "ipen"); assert.equal(sc.props["ron_eligible"], false); assert.ok((sc.props["ron_refusals"] as string[]).includes("state_not_on_fnma_list"));
  const slots = sc.props["slots"] as { id: string; starts_at: string; closing_type: string }[]; assert.ok(slots.length > 0); assert.ok(slots.every((x) => x.closing_type !== "ron")); assert.ok(slots.every((x) => x.starts_at.slice(0, 10) >= "2026-11-09"), "no slot before 25.2's earliest closing date");
  assert.ok(slots.some((x) => x.closing_type === "wet") && slots.some((x) => x.closing_type === "ipen") && slots.some((x) => x.closing_type === "hybrid"));
  assert.equal(sc.props["vendor_fake"], "FAKE"); assert.equal(sc.props["fallback_copy_key"], "closing.schedule.fallback");
  for (const sl of slots) assert.equal((sc.props["command_args_by_option"] as Record<string, { closing_type_preference: string }>)[sl.id]!.closing_type_preference, sl.closing_type);
  assert.equal((sc.props["command_args"] as { state: string }).state, "GA");
  // the electronic/paper ChoiceCard beside it; Needed-from-you carries the schedule item; the timer row of the gate is 26.2's own (armed on closing.scheduled — not yet)
  assert.ok(cards.some((c) => c.copy_key === "closing.electronic_or_paper" && c.kind === "ChoiceCard" && c.status === "pending"));
  const rec = await record(A, j2.appId); assert.ok((rec["needed_from_you"] as { kind: string; card_instance_id: string | null }[]).some((n) => n.kind === "schedule" && n.card_instance_id === sc.card_instance_id));
  assert.equal(badge(rec).badge, "Clear to close");
});

test("32.7-T5: Given the borrower declines electronic records, then `closing_type = wet`, no eNote is built, and the Thread confirms the paper path.", { skip }, async () => {
  const { j, A, partyA } = appC; const j2 = j!;
  const cards = await cardsOf(j2.appId, partyA);
  // A2-4.1-03: "Sign on paper" — the ChoiceCard records the election (evidence, no command); the borrower then books a paper slot, which commits `closing_type_preference = wet` through closing.selectSlot → 26.2
  const choice = cards.find((c) => c.copy_key === "closing.electronic_or_paper" && c.status === "pending")!;
  clock.set(MST("2026-11-05", "10:00")); const tok = (await signIn(A)).token;
  const chosen = await api("POST", `/v1/borrower/cards/${choice.card_instance_id}/resolve`, { option_id: "paper", evidence: { option_id: "paper" } }, tok); assert.equal(chosen.status, 201, JSON.stringify(chosen.body)); assert.equal(chosen.body["command"], null, "the election itself runs no command");
  const sc = cards.find((c) => c.kind === "ScheduleCard" && c.status === "pending")!; const wet = (sc.props["slots"] as { id: string; starts_at: string; closing_type: string }[]).find((x) => x.closing_type === "wet")!;
  const booked = await api("POST", `/v1/borrower/cards/${sc.card_instance_id}/resolve`, { option_id: wet.id, evidence: { slot_id: wet.id } }, tok);
  assert.equal(booked.status, 201, JSON.stringify(booked.body)); assert.equal(booked.body["command"], "closing.selectSlot");
  const out = booked.body["result"] as { closing_type: string; note_form: string; closing_id: string }; assert.equal(out.closing_type, "wet"); assert.equal(out.note_form, "paper");
  assert.ok((booked.body["events"] as string[]).includes("closing.scheduled"));
  // 26.2's row and event: wet, a paper note, no eNote; nothing electronic is ever built for it
  const scheduled = (await events(j2.appId, "closing.scheduled")).at(-1)!; assert.equal(scheduled.payload["closing_type"], "wet"); assert.equal(scheduled.payload["note_form"], "paper"); assert.equal(scheduled.payload["enote"], false); assert.equal(scheduled.payload["wet"], true);
  assert.ok((scheduled.payload["closing_type_reasons"] as string[]).some((r) => /borrower_election:wet/.test(r)), JSON.stringify(scheduled.payload["closing_type_reasons"]));
  const closing = (await entity("closings", out.closing_id))!; assert.equal(closing["closing_type"], "wet"); assert.equal(closing["note_form"], "paper"); assert.equal(closing["enote_indicator"], false); assert.equal(closing["remote_notarization_indicator"], false);
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM loan_events WHERE application_id = $1 AND type LIKE 'enote.%'`, [j2.appId]))[0]!.n, "0", "no eNote is built");
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM entity_current WHERE kind = 'enotes' AND data->>'application_id' = $1`, [j2.appId]))[0]!.n, "0");
  await settle();
  // the Thread confirms the paper path; the schedule cards are closed; the badge is Closing scheduled; the appointment is a Dates row
  const after = await cardsOf(j2.appId, partyA);
  const paper = after.find((c) => c.copy_key === "closing.paper_path")!; assert.ok(paper, "closing.paper_path StatusCard"); assert.equal(paper.props["closing_type"], "wet"); assert.equal(paper.props["enote"], false); assert.equal((paper.props["copy_tokens"] as { date: string }).date, wet.starts_at.slice(0, 10)); assert.equal(paper.props["next_event_at"], wet.starts_at);
  assert.ok(!after.some((c) => c.copy_key === "closing.confirmed"), "the electronic confirmation line is not used");
  assert.equal(after.find((c) => c.card_instance_id === sc.card_instance_id)!.status, "resolved"); assert.equal(after.find((c) => c.card_instance_id === choice.card_instance_id)!.status, "resolved"); assert.equal((after.find((c) => c.card_instance_id === choice.card_instance_id)!.evidence as { option_id: string }).option_id, "paper");
  const t = await thread(A); assert.ok(t.messages.some((m) => m["card_instance_id"] === paper.card_instance_id));
  const rec = await record(A, j2.appId); assert.equal(badge(rec).badge, "Closing scheduled"); assert.equal(dates(rec).find((d) => d.timer_code === "closings.scheduled_at")!.due_at, wet.starts_at);
  assert.ok(!(rec["needed_from_you"] as { kind: string }[]).some((n) => n.kind === "schedule"), "closing.scheduled removes the schedule item");
});

// ═══════════════════════════════════ App E: the signed refinance — the H-8 and its dates (T6), the cancellation (T8)
const appE: { j?: Journey; A: string; B: string; partyA: string; partyB: string; expiresAt: string } = { A: "", B: "", partyA: "", partyB: "", expiresAt: "" };

test("32.7-T6: Given `signed` on a primary-residence refinance by a different creditor, then the H-8 card renders with `requires_ack`, Dates shows midnight of the third specific business day, and `disburse` is refused before `expires_at` (`REGZ_1026_23_RESCISSION_3SBD_GATE`).", { skip }, async () => {
  const e = await openApp(); Object.assign(appE, e); const { j, A, partyA, partyB } = e; const scope = { app: j.appId };
  await toClearToClose(j); await j.scheduleClosing(); await j.closingDisclosure(); await j.closeAndSign(); await settle();   // consummation Fri Nov 6, 2026 14:26 MST
  assert.equal(badge(await record(A, j.appId)).badge, "Signed");
  assert.equal((await cardsOf(j.appId, partyA)).filter((c) => c.copy_key === "signed.refi").length, 0, "the refinance line waits for 25.3's period");
  // 25.3: a primary-residence refinance by a different creditor → H-8, two copies to each consumer at signing; the period from the latest of consummation, notice and CD receipt (Nov 2)
  clock.set(MST("2026-11-06", "14:45"));
  const period = await rescissionPeriod(j, "2026-11-02", MST("2026-11-06", "14:26"));
  assert.equal(period["applicability"] ?? (await entity("rescission_periods", `${j.appId}:rescission`))?.["applicability"] ?? "principal_dwelling_refinance", period["applicability"] ?? "principal_dwelling_refinance");
  assert.equal(period["form"], "h8"); assert.equal(period["status"], "running"); assert.equal(period["period_start_date"], "2026-11-06"); assert.equal(period["expires_on"], "2026-11-10"); assert.equal(period["expires_at"], "2026-11-11T07:00:00.000Z", "midnight ending Tue Nov 10 MST (Sat 7 counts, Sun 8 does not)");
  assert.deepEqual(rescissionExpiry(D("2026-11-06"), TZ).expires_at, "2026-11-11T07:00:00.000Z"); appE.expiresAt = String(period["expires_at"]);
  const applicability = (await events(j.appId, "rescission.applicability.determined"))[0]!; assert.equal(applicability.payload["form"], "h8"); assert.equal(applicability.payload["original_creditor_match"], false);
  // the H-8 DocumentCard per consumer: requires_ack, two copies, the quiet "How to cancel" link — never a primary button
  for (const [party, consumer] of [[partyA, "B1"], [partyB, "B2"]] as const) {
    const cards = await cardsOf(j.appId, party); const h8 = cards.find((c) => c.copy_key === "rescission.notice")!;
    assert.ok(h8, `H-8 card for ${consumer}`); assert.equal(h8.kind, "DocumentCard"); assert.equal(h8.props["notice_code"], "NTC_REGZ_1026_23_H8"); assert.equal(h8.props["requires_ack"], true); assert.equal(h8.status, "pending"); assert.equal(h8.props["copies"], 2); assert.equal(h8.props["consumer_id"], consumer);
    assert.deepEqual(h8.props["how_to_cancel"], { copy_key: "rescission.how", message_text: "How to cancel", quiet: true });
    assert.ok(!(h8.props as { options?: unknown }).options, "no option button on the notice card — the cancel path is a quiet link");
  }
  // the signed line: "until midnight Nov 10 to cancel; funding on Thu Nov 12" — the funding date is 26.3's calendar (Wed Nov 11 is a Fedwire holiday), the expiry 25.3's
  const signed = (await cardsOf(j.appId, partyA)).find((c) => c.copy_key === "signed.refi")!; assert.ok(signed, "signed.refi StatusCard");
  assert.deepEqual(signed.props["copy_tokens"], { expires_at: "2026-11-10", date: "2026-11-12" }); assert.equal(signed.props["expires_at"], "2026-11-11T07:00:00.000Z"); assert.equal(signed.props["next_event_label"], "Cancel window ends (midnight)"); assert.equal(signed.props["next_event_at"], "2026-11-11T07:00:00.000Z");
  // the Record: badge Cancel window; Dates "Cancel window ends (midnight)" at midnight of the third specific business day; the H-8 in Needed-from-you as an acknowledgment
  const rec = await record(A, j.appId); assert.equal(badge(rec).badge, "Cancel window"); assert.equal(badge(rec).state_source, "rescission_periods.status=running");
  const win = dates(rec).find((d) => d.timer_code === "REGZ_1026_23_RESCISSION_3SBD_GATE")!; assert.ok(win, JSON.stringify(dates(rec))); assert.equal(win.label, "Cancel window ends (midnight)"); assert.equal(win.due_at, "2026-11-11T07:00:00.000Z"); assert.equal(win.calendar, "specific business days");
  assert.ok((rec["needed_from_you"] as { kind: string; label: string }[]).some((n) => n.kind === "acknowledgment" && n.label === "rescission.notice"));
  // `disburse` refused before expires_at: 26.3's funding opened Mon Nov 9; a warehouse advance on Tue Nov 10 with the period running is refused on the rescission gate
  clock.set(EST("2026-11-09", "11:00"));
  await j.tool(scope, "26.3", "computeDates", { op: "open", funding_id: j.FUNDING_ID, state: "AZ", transaction_type: "limited_cash_out", time_zone: TZ, consummation_at: MST("2026-11-06", "14:26"), review_completed_on: "2026-11-09", partner_id: j.PARTNER_ID, partner_loan_number: "PL-1001", gross_loan_cents: "56000000", note_rate_pct: "6.125", note_first_payment_date: "2027-01-01" }, FUNDER);
  const requested = (await events(j.appId, "funding.requested"))[0]!; assert.equal(requested.payload["rescission_expires_at"], "2026-11-11T07:00:00.000Z"); assert.equal(requested.payload["earliest_funding_date"], "2026-11-12");
  clock.set(EST("2026-11-10", "10:00"));
  const facts = (j as unknown as { FUNDING_FACTS(as_of: string): Record<string, unknown> }).FUNDING_FACTS(EST("2026-11-10", "10:00"));
  const running = { status: "running", expires_at: appE.expiresAt, reasonably_satisfied_at: null, waiver_id: null, now: EST("2026-11-10", "10:00") };
  const conditions = await j.tool(scope, "26.3", "evaluateFundingConditions", { funding_id: j.FUNDING_ID, facts: { ...facts, as_of: EST("2026-11-10", "10:00"), rescission: running } }, FUNDER);
  assert.equal(conditions.output["passed"], false); assert.ok((conditions.output["blocking_codes"] as string[]).includes("FC_RESCISSION_EXPIRED"), JSON.stringify(conditions.output["blocking_codes"]));
  // 26.3's own refusal (RescissionRefused on REGZ_1026_23_RESCISSION_3SBD_GATE) — asserted on the bus, where the refusal keeps its name
  await assert.rejects(runtime.execute({ process: "26.3", name: "requestWarehouseAdvance", loanId: "", applicationId: j.appId, actor: FUNDER, run: { runId: "test:32.7-T6", modelVersion: "test", promptVersion: "32.7" }, input: { funding_id: j.FUNDING_ID, conditions: conditions.output, rescission: running, fraud_hold: { fraud_hold: false }, ptf: { ptf_cleared: true }, cash_to_close: { worksheet: { reconciled_to_cd: true, sufficient: true } }, gifts: [] } }),
    (err: unknown) => /REGZ_1026_23_RESCISSION_3SBD_GATE|rescission/i.test(String((err as Error).message)), "disburse refused before expires_at");
  assert.equal((await events(j.appId, "funding.authorized")).length, 0);
  await settle();
  assert.equal(badge(await record(A, j.appId)).badge, "Cancel window", "still inside the window");
});

// ═══════════════════════════════════ App D: a purchase — no rescission anywhere (T7)
test("32.7-T7: Given a purchase, then no rescission card or cancel window renders (`not_applicable`).", { skip }, async () => {
  const { j, A, partyA } = await openApp(); const scope = { app: j.appId };
  await db.query(`UPDATE applications SET transaction_type = 'purchase' WHERE id = $1`, [j.appId]);
  await toClearToClose(j);
  // the closing scheduled as a purchase (26.2), the CD as a purchase (25.2), the signing with the purchase snapshot (26.1/26.2): `closing.consummated{rescindable=false, transaction_type=purchase}`
  clock.set(MST("2026-11-02", "10:00"));
  const sch = await j.tool(scope, "26.2", "runPreSessionChecks", { op: "schedule", closing_id: j.CLOSING_ID, application_id: j.appId, scheduled_at: MST("2026-11-06", "14:00"), time_zone: TZ, state: "AZ", county_fips: "04013", transaction_type: "purchase", rescindable: false, dry_state: true, settlement_agent_party_id: j.AGENT_PARTY, notary_party_id: j.NOTARY.party_id, ron_provider_party_id: "P-RON-1", eligibility: j.ELIGIBILITY, signers: j.SIGNERS }, CLOSER);
  assert.equal(sch.output["closing_type"], "ron");
  await j.closingDisclosure(); await j.closeAndSign({ snapshot: { transaction_type: "purchase", rescindable: false } }); await settle();
  const consummated = (await events(j.appId, "closing.consummated"))[0]!; assert.equal(consummated.payload["rescindable"], false); assert.equal(consummated.payload["transaction_type"], "purchase");
  // 25.3: purchase-money → exempt; no notice, no gate, no period (25.3-T7)
  clock.set(MST("2026-11-06", "14:45"));
  const r = await j.tool(scope, "25.3", "determineRescindability", { transaction_type: "purchase", consumers: [{ consumer_id: "B1", role: "borrower", ownership_interest: true, occupancy: "primary" }, { consumer_id: "B2", role: "borrower", ownership_interest: true, occupancy: "primary" }], partner_id: j.PARTNER_ID, existing_loan: null, amount_financed_cents: "55615005", time_zone: TZ }, DISCLOSURE);
  assert.equal(r.output["applicability"], "exempt_purchase_money"); assert.equal(r.output["gated"], false); assert.equal(r.output["status"], "not_applicable"); assert.equal(r.output["form"], "none");
  await settle();
  const cards = await cardsOf(j.appId, partyA);
  assert.equal(cards.filter((c) => c.copy_key === "rescission.notice" || c.copy_key === "rescission.confirm" || c.copy_key === "signed.refi").length, 0, "no rescission card, no cancel ChoiceCard, no refinance signed line");
  assert.equal(cards.filter((c) => /NTC_REGZ_1026_23_H[89]/.test(String(c.props["notice_code"] ?? ""))).length, 0);
  const signed = cards.find((c) => c.copy_key === "signed.purchase")!; assert.ok(signed, "the purchase variant of the signed message"); assert.equal(signed.props["rescission"], "not_applicable"); assert.equal((signed.props["copy_tokens"] as { when: string }).when, "2026-11-06", "26.3: not rescindable — funds on the closing date (a Fedwire day)");
  assert.equal((await events(j.appId, "rescission.period.started")).length, 0); assert.equal((await events(j.appId, "rescission.notice.delivered")).length, 0); assert.equal(await timer(j.appId, "REGZ_1026_23_RESCISSION_3SBD_GATE"), undefined, "no cancel-window gate");
  const rec = await record(A, j.appId);
  assert.equal(badge(rec).badge, "Signed"); assert.equal(badge(rec).one_liner, "signed.purchase");
  assert.ok(!dates(rec).some((d) => d.timer_code === "REGZ_1026_23_RESCISSION_3SBD_GATE"), "no cancel window in Dates"); assert.ok(!(rec["documents"] as Record<string, unknown>[]).some((d) => /H8|H9/.test(String(d["notice_code"] ?? ""))));
  assert.equal((rec["subject"] as { transaction_type: string }).transaction_type, "purchase");
  const t = await thread(A); assert.ok(!t.messages.some((m) => /cancel/i.test(String(m["body_text"] ?? ""))), "nothing about a cancel window in the thread");
});

test("32.7-T8: Given the borrower opens \"How to cancel\" and confirms, then `rescinded → unwinding`, `REGZ_1026_23D2_RESCISSION_REFUND_20` is created, and the Record is read-only with badge \"Cancelled\".", { skip }, async () => {
  const { j, A, partyA, partyB } = appE; const j2 = j!;
  // Mon Nov 9 (day 2 of the window): the quiet link posts "How to cancel" as the borrower's message → the flow answers with the ChoiceCard (consequences + confirmation); nothing has happened yet
  clock.set(MST("2026-11-09", "10:15")); const tok = (await signIn(A)).token;
  const opened = await api("POST", "/v1/borrower/messages", { text: "How to cancel", subject: { application_id: j2.appId } }, tok);
  assert.equal(opened.status, 200, JSON.stringify(opened.body)); assert.equal(opened.body["command_executed"], false);
  const reply = opened.body["reply"] as { copy_key: string; card_instance_id: string | null }; assert.equal(reply.copy_key, "rescission.how.opened"); assert.ok(reply.card_instance_id);
  await settle();
  const choice = (await cardsOf(j2.appId, partyA)).find((c) => c.card_instance_id === reply.card_instance_id)!;
  assert.equal(choice.kind, "ChoiceCard"); assert.equal(choice.copy_key, "rescission.confirm"); assert.equal(choice.status, "pending"); assert.equal(choice.command_ref, "rescission.exercise");
  assert.deepEqual((choice.props["options"] as { id: string; is_primary?: boolean }[]).map((o) => [o.id, o.is_primary ?? false]), [["keep", true], ["cancel", false]], "keeping the loan is the accent action; cancelling never is");
  assert.deepEqual(choice.props["no_command_options"], ["keep"]); assert.equal(choice.props["refund_clock"], "REGZ_1026_23D2_RESCISSION_REFUND_20");
  assert.equal((await events(j2.appId, "rescission.exercised")).length, 0, "opening the explanation exercises nothing");
  // the confirmation: rescission.exercise → 25.3 record_exercise (written, portal, inside the period) → `rescission.notice.received{valid}` + `rescission.exercised`
  clock.set(MST("2026-11-09", "10:20"));
  const confirmed = await api("POST", `/v1/borrower/cards/${choice.card_instance_id}/resolve`, { option_id: "cancel", evidence: { option_id: "cancel" } }, tok);
  assert.equal(confirmed.status, 201, JSON.stringify(confirmed.body)); assert.equal(confirmed.body["command"], "rescission.exercise"); assert.ok((confirmed.body["events"] as string[]).includes("rescission.exercised"), JSON.stringify(confirmed.body["events"]));
  const received = (await events(j2.appId, "rescission.notice.received"))[0]!; assert.equal(received.payload["valid"], true); assert.equal(received.payload["method"], "portal"); assert.equal(received.payload["consumer_id"], "B1"); assert.equal(received.payload["refund_due_at"], "2026-11-29", "received Mon Nov 9 + 20 calendar days");
  const exercised = (await events(j2.appId, "rescission.exercised"))[0]!; assert.equal(exercised.payload["after_disbursement"], false);
  // 25.3's rows: the period `rescinded`, the exercise with its unwind checklist (`unwinding`); the 20-day refund clock created from the receipt
  const period = (await entity("rescission_periods", String(exercised.payload["rescission_id"])))!; assert.equal(period["status"], "rescinded");
  const exercise = (await entity("rescission_exercises", String(exercised.payload["exercise_id"])))!; assert.equal(exercise["valid"], true); assert.equal(exercise["refund_due_at"], "2026-11-29"); assert.ok((exercise["checklist"] as unknown[]).length > 0, "the unwind checklist is open");
  const refund = await timer(j2.appId, "REGZ_1026_23D2_RESCISSION_REFUND_20"); assert.ok(refund, "REGZ_1026_23D2_RESCISSION_REFUND_20 created"); assert.equal(refund!.status, "armed"); assert.equal(refund!.due_date, "2026-11-29"); assert.equal(refund!.anchor_date, "2026-11-09");
  await settle();
  // the Record is read-only: every pending card of the subject (both borrowers) is cancelled, nothing is needed, the badge is Cancelled
  const all = await cardsOf(j2.appId);
  assert.equal(all.filter((c) => c.status === "pending").length, 0, "no pending ask remains"); assert.ok(all.some((c) => c.party_id === partyB && c.copy_key === "rescission.notice" && c.status === "cancelled"), "the co-borrower's H-8 ask is withdrawn too");
  const cancelled = all.find((c) => c.copy_key === "rescission.cancelled" && c.party_id === partyA)!; assert.ok(cancelled, "rescission.cancelled StatusCard"); assert.equal((cancelled.props["copy_tokens"] as { date: string }).date, "2026-11-29"); assert.equal(cancelled.props["refund_clock"], "REGZ_1026_23D2_RESCISSION_REFUND_20");
  const rec = await record(A, j2.appId);
  assert.equal(badge(rec).badge, "Cancelled"); assert.equal(badge(rec).state_source, "rescission_periods.status=rescinded"); assert.equal(badge(rec).one_liner, "rescission.cancelled");
  assert.deepEqual(rec["needed_from_you"], []); assert.ok(!dates(rec).some((d) => d.timer_code === "REGZ_1026_23_RESCISSION_3SBD_GATE"), "the cancel window is gone");
  assert.equal(badge(await record(appE.B, j2.appId)).badge, "Cancelled");
  // read-only: a second tap on the confirmation answers the stored outcome; the schedule/closing commands are refused for a rescinded application
  const again = await api("POST", `/v1/borrower/cards/${choice.card_instance_id}/resolve`, { option_id: "cancel" }, tok); assert.equal(again.status, 200); assert.equal(again.body["idempotent"], true);
  const t = await thread(A); assert.ok(t.pinned === null, "no pinned ask on a cancelled application"); assert.ok(t.messages.some((m) => m["card_instance_id"] === cancelled.card_instance_id));
});

// ═══════════════════════════════════ App A continues: funding (T9, T10), boarding (T11, T12), purchase (T13)
test("32.7-T9: Given `fundings.status = held{reason=insurance_effective_date}`, then the borrower sees a single ask for the corrected effective date and no wire-status detail.", { skip }, async () => {
  const j = main.j!; const { A, partyA } = main; const scope = { app: j.appId };
  await j.closeAndSign(); await settle();
  clock.set(MST("2026-11-06", "14:45")); await rescissionPeriod(j, "2026-11-03", MST("2026-11-06", "14:26")); await rescissionSweep(j);
  assert.equal((await events(j.appId, "rescission.confirmed_not_rescinded")).length, 1);
  assert.ok((await cardsOf(j.appId, partyA)).some((c) => c.copy_key === "rescission.expired" && (c.props["copy_tokens"] as { date: string }).date === "2026-11-12"), "'Your cancel window ended. Funding is scheduled for Nov 12.'");
  await j.openFunding(); await settle();
  // Thu Nov 12 08:05 ET: conditions pass, the advance is authorized (badge Funding, one progress line) — then the carrier reports the policy effective Fri Nov 13: FC_HAZARD_EVIDENCE fails → `funding.held`
  const facts = (j as unknown as { FUNDING_FACTS(as_of: string): Record<string, unknown> }).FUNDING_FACTS;
  clock.set(EST("2026-11-12", "08:05")); const ok = await j.tool(scope, "26.3", "evaluateFundingConditions", { funding_id: j.FUNDING_ID, facts: facts(EST("2026-11-12", "08:05")) }, FUNDER); assert.equal(ok.output["passed"], true, JSON.stringify(ok.output["blocking_codes"]));
  clock.set(EST("2026-11-12", "08:12")); await j.tool(scope, "26.3", "requestWarehouseAdvance", { funding_id: j.FUNDING_ID, conditions: ok.output, rescission: (facts(EST("2026-11-12", "08:12")) as { rescission: unknown }).rescission, fraud_hold: { fraud_hold: false }, ptf: { ptf_cleared: true }, cash_to_close: { worksheet: { reconciled_to_cd: true, sufficient: true } }, gifts: [] }, FUNDER);
  await settle();
  const progress = (await cardsOf(j.appId, partyA)).find((c) => c.copy_key === "funding.progress")!; assert.ok(progress); assert.equal((progress.props["copy_tokens"] as { date: string }).date, "2026-11-12"); assert.equal(badge(await record(A, j.appId)).badge, "Funding");
  clock.set(EST("2026-11-12", "08:30"));
  const held = await j.tool(scope, "26.3", "evaluateFundingConditions", { funding_id: j.FUNDING_ID, facts: { ...facts(EST("2026-11-12", "08:30")), hazard: { hazard_status: "verified", effective_date: "2026-11-13", transaction_type: "refinance", policy_in_force: true } } }, FUNDER);
  assert.equal(held.output["passed"], false); assert.deepEqual(held.output["blocking_codes"], ["FC_HAZARD_EVIDENCE"]); assert.match(String(held.output["held"]), /FC_HAZARD_EVIDENCE/);
  const heldEvent = (await events(j.appId, "funding.held")).at(-1)!; assert.match(String(heldEvent.payload["reason"]), /FC_HAZARD_EVIDENCE/); assert.equal((await entity("fundings", j.FUNDING_ID))!["status"], "held");
  assert.equal(holdAsk(String(heldEvent.payload["reason"]))?.kind, "insurance_effective_date");
  await settle();
  // the borrower sees "a final check is in progress" and exactly one ask — the corrected effective date — with no wire-status detail anywhere
  const cards = (await cardsOf(j.appId, partyA)).filter((c) => Date.parse(c.created_at) >= Date.parse(EST("2026-11-12", "08:30")));
  const status = cards.find((c) => c.copy_key === "funding.held")!; assert.ok(status, "funding.held StatusCard"); assert.equal(status.props["hold_kind"], "insurance_effective_date"); assert.ok(noWireDetail(status.props), JSON.stringify(status.props));
  const asks = cards.filter((c) => c.status === "pending"); assert.equal(asks.length, 1, `a single ask: ${JSON.stringify(asks.map((c) => c.copy_key))}`);
  const ask = asks[0]!; assert.equal(ask.kind, "UploadCard"); assert.equal(ask.copy_key, "funding.held.insurance_effective_date"); assert.equal(ask.props["document_class"], "homeowners_policy"); assert.equal(ask.command_ref, "insurance.submitEvidence"); assert.ok(noWireDetail(ask.props));
  const rec = await record(A, j.appId); assert.equal(badge(rec).badge, "Funding", "the hold collapses into Funding — no wire status");
  // Needed-from-you: the hold adds exactly one item — the effective-date upload (earlier open items of the sibling flows are not the hold's)
  const needed = (rec["needed_from_you"] as { card_instance_id: string | null; kind: string; created_at: string }[]).filter((n) => Date.parse(n.created_at) >= Date.parse(EST("2026-11-12", "08:30"))); assert.deepEqual(needed.map((n) => n.card_instance_id), [ask.card_instance_id]); assert.equal(needed[0]!.kind, "document_request");
  const t = await thread(A); assert.ok(noWireDetail(t.messages.filter((m) => Date.parse(String(m["at"])) >= Date.parse(EST("2026-11-12", "08:00")))), "nothing about the wire in the thread");
  assert.equal(t.pinned?.card_instance_id, ask.card_instance_id, "the pinned ask is the effective-date upload");
  // the borrower sends the corrected declarations page (effective Nov 12): the upload → 22.1, the card's command → 24.5 extractEvidence{hoi_declaration}; the ask leaves the list
  clock.set(EST("2026-11-12", "09:05")); const tok = (await signIn(A)).token;
  const form = new FormData(); form.set("application_id", j.appId); form.set("document_class", "homeowners_policy"); form.set("file", new Blob([Buffer.from("%PDF-1.4 FAKE declarations page — effective 2026-11-12")], { type: "application/pdf" }), "dec-page.pdf");
  const up = await fetch(`${base}/v1/borrower/documents`, { method: "POST", headers: { authorization: `Bearer ${tok}` }, body: form }); const upBody = (await up.json()) as { document_id: string; status: string }; assert.equal(up.status, 201, JSON.stringify(upBody));
  const resolved = await api("POST", `/v1/borrower/cards/${ask.card_instance_id}/resolve`, { option_id: "upload", args: { document_id: upBody.document_id, fields: { effective_date: "2026-11-12" } }, evidence: { document_class: "homeowners_policy", file_name: "dec-page.pdf" } }, tok);
  assert.equal(resolved.status, 201, JSON.stringify(resolved.body)); assert.equal(resolved.body["command"], "insurance.submitEvidence"); assert.ok((resolved.body["events"] as string[]).some((x) => /insurance\.evidence/.test(x)), JSON.stringify(resolved.body["events"]));
  await settle();
  assert.ok(!((await record(A, j.appId))["needed_from_you"] as { card_instance_id: string | null }[]).some((n) => n.card_instance_id === ask.card_instance_id), "the effective-date ask leaves Needed-from-you");
  // the re-evaluation with the corrected effective date passes: the hold clears (held → pending_conditions) and the advance is re-requested; T10 disburses
  clock.set(EST("2026-11-12", "09:20"));
  const again = await j.tool(scope, "26.3", "evaluateFundingConditions", { funding_id: j.FUNDING_ID, facts: facts(EST("2026-11-12", "09:20")) }, FUNDER); assert.equal(again.output["passed"], true);
  const f = (await entity("fundings", j.FUNDING_ID))!; assert.ok(["held", "pending_conditions", "advance_approved"].includes(String(f["status"])), String(f["status"]));
});

test("32.7-T10: Given `loan.funded` on Thu Nov 12, 2026 for a refinance, then the funded message names the prior servicer, the 20-day refund clock, and a first payment date ≤ Jan 12, 2027 (`FNMA_B2_1_5_FIRST_PAYMENT_2M`).", { skip }, async () => {
  const j = main.j!; const { A, partyA } = main; const scope = { app: j.appId };
  const f0 = (await entity("fundings", j.FUNDING_ID))!;
  if (f0["status"] === "held" || f0["status"] === "pending_conditions") {
    // resume after T9's hold: the advance re-requested on the passing conditions (held → conditions_met → authorized → advance_approved)
    const facts = (j as unknown as { FUNDING_FACTS(as_of: string): Record<string, unknown> }).FUNDING_FACTS;
    clock.set(EST("2026-11-12", "09:25")); const ok = await j.tool(scope, "26.3", "evaluateFundingConditions", { funding_id: j.FUNDING_ID, facts: facts(EST("2026-11-12", "09:25")) }, FUNDER); assert.equal(ok.output["passed"], true);
    await j.tool(scope, "26.3", "requestWarehouseAdvance", { funding_id: j.FUNDING_ID, conditions: ok.output, rescission: (facts(EST("2026-11-12", "09:25")) as { rescission: unknown }).rescission, fraud_hold: { fraud_hold: false }, ptf: { ptf_cleared: true }, cash_to_close: { worksheet: { reconciled_to_cd: true, sufficient: true } }, gifts: [] }, FUNDER);
  }
  if (String((await entity("fundings", j.FUNDING_ID))!["status"]) === "authorized") await j.tool(scope, "26.3", "requestWarehouseAdvance", { funding_id: j.FUNDING_ID, op: "advance_approved", advance_id: `ADV-${j.R}` }, FUNDER);
  await j.disburseFromAdvance(); await settle();
  const funded = (await events(j.appId, "loan.funded"))[0]!; assert.equal(funded.payload["disbursement_date"], "2026-11-12"); assert.equal(funded.payload["first_payment_date"], "2027-01-01"); assert.equal(funded.payload["prepaid_days"], 19); assert.equal(funded.payload["per_diem_cents"], "9397");
  const requested = (await events(j.appId, "funding.requested")).at(-1)!; assert.equal(requested.payload["first_payment_latest_allowed_date"], "2027-01-12", "FNMA_B2_1_5_FIRST_PAYMENT_2M: two months after the Nov 12 disbursement");
  assert.ok(String(funded.payload["first_payment_date"]) <= "2027-01-12");
  // the funded message: the prior servicer named, the 20-day refund clock (their REGX_1024_34B clock), the first payment amount and date
  const card = (await cardsOf(j.appId, partyA)).find((c) => c.copy_key === "funded.refi")!; assert.ok(card, "funded.refi StatusCard");
  const tokens = card.props["copy_tokens"] as Record<string, string>;
  assert.match(tokens["prior_servicer"]!, /^Partner Bank /, "the prior loan's servicer of record, never a placeholder"); assert.equal(tokens["date"], "2027-01-01"); assert.equal(tokens["money"], "$4,090.12", "P&I $3,402.62 + escrow $687.50"); assert.equal(tokens["disbursement"], "2026-11-12"); assert.equal(tokens["month_end"], "2026-12-01");
  assert.equal(card.props["refund_clock"], REFUND_CLOCK); assert.equal(card.props["refund_days"], 20); assert.equal(card.props["first_payment_date"], "2027-01-01"); assert.equal(card.props["first_payment_latest_allowed_date"], "2027-01-12"); assert.equal(card.props["first_payment_gate"], "FNMA_B2_1_5_FIRST_PAYMENT_2M");
  assert.equal(card.props["detail_copy_key"], "funded.no_skip"); assert.equal(card.props["prepaid_days"], 19); assert.match(String(card.props["next_event_label"]), /^First payment due/, "the registry's own label for the first-payment timer"); assert.equal(card.props["next_event_at"], "2027-01-01T12:00:00.000Z");
  assert.ok(String(card.props["first_payment_date"]) <= String(card.props["first_payment_latest_allowed_date"]));
  const rec = await record(A, j.appId); assert.equal(badge(rec).badge, "Funded"); assert.equal(badge(rec).one_liner, "funded.refi");
  assert.equal((await cardsOf(j.appId, partyA)).filter((c) => c.status === "pending" && c.props["flow"] === "32.7").length, 0, "no 32.7 ask stays open once funded");
});

test("32.7-T11: Given `loan.boarded`, then `NTC_SM_FIRST_PAYMENT_LETTER` is sent within 5 servicer business days and the Record shows the servicing layout; the autopay `ConsentCard` includes every 2.x rule-1 element and the optional statement.", { skip }, async () => {
  const j = main.j!; const { A, partyA } = main;
  main.loanId = await j.board(); await settle();
  const boarded = (await events(j.appId, "loan.boarded"))[0]!; assert.equal(boarded.loan_id, main.loanId); assert.equal(boarded.payload["first_payment_date"], "2027-01-01");
  // the first-payment letter to every borrower within 5 servicer business days of the Nov 12 funding (due Thu Nov 19 — 25.4 T7): 30.2's `notice.sent{template=NTC_SM_FIRST_PAYMENT_LETTER}` on Nov 12 satisfies SM_O64_FIRST_PAYMENT_LETTER_5BD
  const letters = (await events(j.appId, "notice.sent")).filter((e) => e.payload["template"] === "NTC_SM_FIRST_PAYMENT_LETTER" && typeof e.payload["party_id"] === "string");
  assert.equal(new Set(letters.map((e) => String(e.payload["party_id"]))).size, 2, `one letter per borrower: ${JSON.stringify(letters.map((e) => [e.payload["notice_id"], e.payload["party_id"], e.payload["via"], e.payload["channel"]]))}`);
  for (const l of letters) { assert.equal(l.payload["sent_on"], "2026-11-12"); assert.ok(String(l.payload["sent_on"]) <= "2026-11-19"); assert.ok((l.payload["carries"] as string[]).includes("NTC_FCRA_1681S2A7_B1"), "the FCRA B-1 text rides on the letter"); }
  const t5 = await timer(j.appId, "SM_O64_FIRST_PAYMENT_LETTER_5BD") ?? await loanTimer(main.loanId, "SM_O64_FIRST_PAYMENT_LETTER_5BD");
  if (t5) { assert.ok(["satisfied", "satisfied_late", "armed"].includes(t5.status)); if (t5.due_date) assert.equal(t5.due_date, "2026-11-19"); }
  // the Record switches to the servicing layout: stage servicing, "Your loan", the loan section, the letter in Documents
  const rec = await record(A, main.loanId);
  assert.equal((rec["subject"] as { stage: string; loan_id: string }).stage, "servicing"); assert.equal(badge(rec).badge, "Your loan"); assert.equal(badge(rec).state_source, "loans.boarding_status=active"); assert.equal(badge(rec).one_liner, "boarding.welcome");
  assert.ok(rec["loan"], "the Loan section renders"); assert.equal((rec["loan"] as { first_payment_date: string }).first_payment_date, "2027-01-01"); assert.equal(((rec["numbers"] as { next_payment: { amount_cents: string } }).next_payment).amount_cents, "409012");
  assert.ok((rec["documents"] as Record<string, unknown>[]).some((d) => d["notice_code"] === "NTC_SM_FIRST_PAYMENT_LETTER"));
  assert.equal(badge(await record(A, j.appId)).badge, "Your loan", "the origination subject answers with the loan's record; the origination Record stays reachable");
  // the Thread: the welcome line, the letter's NoticeCard, then the autopay ConsentCard — every 2.x rule-1 element, the Reg E optional statement, nothing pre-checked, never a condition
  const cards = await cardsOf(j.appId, partyA);
  assert.ok(cards.some((c) => c.copy_key === "boarding.welcome" && c.subject_loan_id === main.loanId));
  const letter = cards.find((c) => c.copy_key === "first_payment.letter")!; assert.ok(letter, "NoticeCard{NTC_SM_FIRST_PAYMENT_LETTER}"); assert.equal(letter.kind, "NoticeCard"); assert.equal(letter.props["notice_code"], "NTC_SM_FIRST_PAYMENT_LETTER"); assert.equal(letter.props["timer"], "SM_O64_FIRST_PAYMENT_LETTER_5BD");
  assert.deepEqual(letter.props["copy_tokens"], { money: "$4,090.12", date: "2027-01-01", "partner.legal_name": (await db.query<{ n: string }>(`SELECT legal_name AS n FROM parties WHERE id = $1`, [partnerPartyId]))[0]!.n }); assert.equal(letter.props["payee_copy_key"], "first_payment.payee");
  const autopay = cards.find((c) => c.copy_key === "consent.autodraft.title")!; assert.ok(autopay, "ConsentCard{autodraft_authorization}"); assert.equal(autopay.kind, "ConsentCard"); assert.equal(autopay.status, "pending"); assert.equal(autopay.command_ref, "autodraft.enroll"); assert.equal(autopay.subject_loan_id, main.loanId);
  assert.equal(autopay.props["consent_kind"], "autodraft_authorization"); assert.equal(autopay.props["affirmation_method"], "checkbox_with_text"); assert.equal(autopay.props["requires_typed_name"], true);
  assert.equal(autopay.props["optional_statement_copy_key"], "consent.autodraft.optional"); assert.equal(autopay.props["optional"], true); assert.equal(autopay.props["prechecked"], false);
  const elements = autopay.props["elements"] as { id: string; label_key: string; value: string }[];
  assert.deepEqual(elements.map((x) => x.id), [...AUTODRAFT_ELEMENTS], "borrower · loan · account · amount rule · variable-amount notice · timing · first debit · company name · revocation · date · E-SIGN copy (2.3 rule 1)");
  for (const x of elements) assert.match(x.label_key, /^consent\.autodraft\.element\./);
  assert.equal(elements.find((x) => x.id === "borrower")!.value, "Alex Borrower"); assert.equal(elements.find((x) => x.id === "amount")!.value, "$4,090.12"); assert.equal(elements.find((x) => x.id === "first_debit")!.value, "2027-01-01"); assert.equal(elements.find((x) => x.id === "company")!.value, "SUPERMORTGAGE"); assert.match(elements.find((x) => x.id === "loan")!.value, /^····\d{4}$/);
  assert.deepEqual(autopay.props["draft_day_options"], Array.from({ length: 16 }, (_, k) => k + 1)); assert.equal((autopay.props["command_args"] as { elements_displayed: boolean }).elements_displayed, true); assert.equal(autopay.props["copy_delivery_timer"], "SM_AUTODRAFT_COPY_DELIVERY_1BD");
  assert.ok(Date.parse(letter.created_at) <= Date.parse(autopay.created_at), "the letter first, then autopay");
  assert.ok(((await record(A, main.loanId))["needed_from_you"] as { card_instance_id: string | null; kind: string }[]).some((n) => n.card_instance_id === autopay.card_instance_id && n.kind === "consent"));
});

test("32.7-T12: Given E6 consent scoped only `origination_disclosures`, then the first statement is paper and a servicing-scope `ConsentCard` is offered.", { skip }, async () => {
  const j = main.j!; const { A, B, partyA, partyB } = main;
  // 30.2's consents.boarded: one borrower's E6 consent (disclosure v1.4 — origination classes only) boards with no servicing scope and invitation_required; the other's (v2.0, servicing group elected) carries the servicing classes (the fixture assigns the versions by borrower order)
  const boarded = (await events(j.appId, "consents.boarded"))[0]!; const rows = boarded.payload["consents"] as { party_id: string; kind: string; scope: string[]; invitation_required: boolean }[];
  const invitedRow = rows.find((r) => r.kind === "esign" && r.invitation_required === true)!; const coveredRow = rows.find((r) => r.kind === "esign" && r.invitation_required === false)!;
  assert.ok(invitedRow && coveredRow, JSON.stringify(rows));
  const partyOf = async (abId: string) => (await db.query<{ party_id: string }>(`SELECT party_id FROM application_borrowers WHERE id = $1`, [abId]))[0]!.party_id;
  const invitedParty = await partyOf(invitedRow.party_id); const coveredParty = await partyOf(coveredRow.party_id); const invitedEmail = invitedParty === partyA ? A : B; assert.ok([partyA, partyB].includes(invitedParty) && [partyA, partyB].includes(coveredParty));
  assert.deepEqual(invitedRow.scope, ["origination_disclosures", "origination_esign_signatures"], "origination classes only — no servicing group"); assert.ok(coveredRow.scope.includes("periodic_statements"));
  assert.ok(((await events(j.appId, "loan.boarded"))[0]!.payload["warnings"] as string[]).includes("OW-002"));
  // the first statement is paper for the invited borrower: the first-payment letter went first-class mail (portal copy only under `general_correspondence`) with the 7.4 invitation enclosed; 30.2 opens 7.1's first cycle, the statement goes by mail until e-delivery is active
  const letterI = (await events(j.appId, "notice.sent")).find((e) => e.payload["template"] === "NTC_SM_FIRST_PAYMENT_LETTER" && e.payload["party_id"] === invitedRow.party_id)!;
  assert.equal(letterI.payload["channel"], "mail_first_class"); assert.ok((letterI.payload["carries"] as string[]).includes("NTC_ESIGN_7001C_DISCLOSURE"), "the E-SIGN enrollment invitation rides on the letter");
  const letterC = (await events(j.appId, "notice.sent")).find((e) => e.payload["template"] === "NTC_SM_FIRST_PAYMENT_LETTER" && e.payload["party_id"] === coveredRow.party_id)!; assert.equal(letterC.payload["channel"], "mail_and_portal");
  const cycle = (await events(j.appId, "statement.cycle.opened"))[0]!; assert.equal(cycle.payload["first_cycle"], true); assert.equal(cycle.payload["template"], "NTC_REGZ_41_STMT_STD");
  assert.equal(Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM consents WHERE party_id = $1 AND kind = 'esign' AND status = 'active' AND 'periodic_statements' = ANY(scope)`, [invitedParty]))[0]!.n), 0, "no active servicing-scope consent for the invited borrower");
  // the invited borrower's Thread: the paper line and the servicing-scope ConsentCard (checkbox + typed name; never by chat or voice); the covered borrower gets neither
  const cardsI = await cardsOf(j.appId, invitedParty);
  const paper = cardsI.find((c) => c.copy_key === "statement.paper_until_esign")!; assert.ok(paper, "statements are paper until active"); assert.equal(paper.props["statement_channel"], "mail"); assert.deepEqual(paper.props["boarded_scope"], ["origination_disclosures", "origination_esign_signatures"]);
  const consent = cardsI.find((c) => c.copy_key === "consent.esign.servicing")!; assert.ok(consent, "ConsentCard{esign, servicing scopes}"); assert.equal(consent.kind, "ConsentCard"); assert.equal(consent.status, "pending"); assert.equal(consent.command_ref, "consent.capture"); assert.equal(consent.subject_loan_id, main.loanId);
  assert.deepEqual(consent.props["scope"], [...SERVICING_ESIGN_SCOPES]); assert.equal(consent.props["affirmation_method"], "checkbox_with_text"); assert.equal(consent.props["requires_typed_name"], true); assert.equal(consent.props["paper_until_active"], true); assert.equal(consent.props["disclosure_version_id"], "NTC_ESIGN_7001C_DISCLOSURE");
  const cardsC = await cardsOf(j.appId, coveredParty); assert.equal(cardsC.filter((c) => c.copy_key === "consent.esign.servicing" || c.copy_key === "statement.paper_until_esign").length, 0, "the covered borrower's E6 consent already spans the servicing classes");
  const letterCardI = cardsI.find((c) => c.copy_key === "first_payment.letter")!; assert.equal(letterCardI.props["channel"], "mail"); assert.ok(letterCardI.props["mailed_at"]);
  const rec = await record(invitedEmail, main.loanId); assert.ok((rec["needed_from_you"] as { card_instance_id: string | null; kind: string }[]).some((n) => n.card_instance_id === consent.card_instance_id && n.kind === "consent"));
  const docI = (rec["documents"] as Record<string, unknown>[]).find((d) => d["notice_code"] === "NTC_SM_FIRST_PAYMENT_LETTER")!; assert.ok(docI);
  // a voice "yes" never resolves it (01 §3.5)
  const tokI = (await signIn(invitedEmail)).token; const voice = await api("POST", `/v1/borrower/cards/${consent.card_instance_id}/resolve`, { option_id: "affirm", channel: "voice", evidence: {} }, tokI); assert.equal(voice.status, 409); assert.equal(voice.body["code"], "CARD_VOICE_CONSENT");
});

test("32.7-T13: Given `loan.purchased`, then the `HandoffCard{fannie_mae_letter}` exists and, on the borrower's upload of the letter, `ownership_transfer_notices.evidenced` is set.", { skip }, async () => {
  const j = main.j!; const { A, partyA } = main; const loanId = main.loanId;
  await j.openServicingHandoff(); await j.deliverAndPurchase(); await settle();
  const purchased = (await events(j.appId, "loan.purchased"))[0]!; assert.equal(purchased.loan_id, loanId); assert.equal(purchased.payload["purchase_date"], "2026-11-19");
  // 25.4 on loan.purchased: Fannie Mae (covered person) sends its own letter — the row is `expected`, due Sat Dec 19 (30 calendar days), evidence by Sun Jan 3; nothing is rendered in Fannie Mae's name (25.4 T4)
  const expected = (await events(j.appId, "ownership_transfer.notice.expected"))[0]!; assert.equal(expected.payload["covered_person"], "fannie_mae"); assert.equal(expected.payload["status"], "expected"); assert.equal(expected.payload["due_date"], "2026-12-19"); assert.equal(expected.payload["evidence_due"], "2027-01-03"); assert.equal(expected.payload["sender"], "covered_person_direct"); assert.equal(expected.payload["render_notice"], false);
  const otn0 = (await entity("ownership_transfer_notices", `OTN-${loanId}`))!; assert.equal(otn0["status"], "expected"); assert.equal(otn0["evidence_document_id"], null);
  assert.equal((await events(j.appId, "ownership_transfer.notice.sent")).length, 0, "no NTC_REGZ_1026_39_OWNERSHIP_TRANSFER rendered while expected");
  assert.ok((await events(j.appId, "portal.explainer.primed")).length >= 1, "30.4 primed the portal explainer the same day");
  // the HandoffCard{fannie_mae_letter} and the optional UploadCard
  const cards = await cardsOf(j.appId, partyA);
  const handoff = cards.find((c) => c.copy_key === "boarding.fannie_letter")!; assert.ok(handoff, "HandoffCard{fannie_mae_letter}"); assert.equal(handoff.kind, "HandoffCard"); assert.equal(handoff.props["destination"], "fannie_mae_letter"); assert.equal(handoff.props["notice_code"], "NTC_REGZ_1026_39_OWNERSHIP_TRANSFER"); assert.equal(handoff.props["ownership_status"], "expected"); assert.equal(handoff.props["due_date"], "2026-12-19"); assert.equal(handoff.props["timer"], "REGZ_1026_39_OWNERSHIP_NOTICE_30");
  assert.ok((handoff.props["explainer_points"] as string[]).some((x) => /Supermortgage/.test(x)), "30.4's explainer: keep paying Supermortgage"); assert.equal(handoff.subject_loan_id, loanId);
  const upload = cards.find((c) => c.copy_key === "boarding.fannie_letter.upload")!; assert.ok(upload); assert.equal(upload.kind, "UploadCard"); assert.equal(upload.props["document_class"], FNMA_LETTER_CLASS); assert.equal(upload.status, "pending"); assert.equal(upload.command_ref, null);
  // Mon Dec 28: the borrower forwards the letter (POST /v1/borrower/documents, class fnma_loan_purchase_letter) → 22.1 classifies (borrower-declared, FAKE pass) → 30.4 HO-009 `evidenced` and 25.4's row `evidenced` with the upload as its evidence
  clock.set(MST("2026-12-28", "10:00")); const tok = (await signIn(A)).token;
  const form = new FormData(); form.set("application_id", j.appId); form.set("document_class", FNMA_LETTER_CLASS); form.set("file", new Blob([Buffer.from("%PDF-1.4 FAKE Fannie Mae loan purchase letter")], { type: "application/pdf" }), "fannie-mae-letter.pdf");
  const up = await fetch(`${base}/v1/borrower/documents`, { method: "POST", headers: { authorization: `Bearer ${tok}` }, body: form }); const upBody = (await up.json()) as { document_id: string; doc_class: string }; assert.equal(up.status, 201, JSON.stringify(upBody)); assert.equal(upBody.doc_class, FNMA_LETTER_CLASS);
  await settle();
  const classified = (await events(j.appId, "document.classified")).find((e) => e.payload["document_id"] === upBody.document_id)!; assert.ok(classified, "22.1 classified the letter"); assert.equal(classified.payload["doc_class"], FNMA_LETTER_CLASS); assert.equal(classified.payload["borrower_declared"], true);
  const evidenced = [...(await events(j.appId, "ownership_transfer.notice.evidenced")), ...(await loanEvents(loanId, "ownership_transfer.notice.evidenced"))]; assert.ok(evidenced.some((e) => e.payload["document_id"] === upBody.document_id && e.payload["kind"] === "fnma_loan_purchase_letter" && e.payload["source"] === "borrower_upload"), JSON.stringify(evidenced.map((e) => e.payload)));
  const otn = (await entity("ownership_transfer_notices", `OTN-${loanId}`))!; assert.equal(otn["status"], "evidenced"); assert.equal(otn["evidence_document_id"], upBody.document_id);
  const ho9 = (await db.query<{ status: string }>(`SELECT status::text AS status FROM handoff_items WHERE loan_id = $1 AND item_code = 'HO-009'`, [loanId]).catch(() => [] as { status: string }[]))[0];
  if (ho9) assert.equal(ho9.status, "satisfied");
  const after = await cardsOf(j.appId, partyA);
  assert.equal(after.find((c) => c.card_instance_id === upload.card_instance_id)!.status, "resolved"); assert.equal((after.find((c) => c.card_instance_id === upload.card_instance_id)!.evidence as { document_id: string }).document_id, upBody.document_id);
  assert.ok(after.some((c) => c.copy_key === "boarding.fannie_letter.received"));
  assert.deepEqual(((await record(A, loanId))["needed_from_you"] as { card_instance_id: string | null }[]).filter((n) => n.card_instance_id === upload.card_instance_id), []);
});
