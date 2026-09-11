// 32.4 Disclosures, intent to proceed, lock, revised LEs
// spec/sections/32-borrower-experience/32-4-disclosures-intent-to-proceed-lock-revised-les.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// Every T-id drives the real runtime over HTTP (the journey fixture: 20.x → 21.1 → the 21.2 LE bridge → 21.3/21.4/21.5
// bus tools → 25.2 → 26.x) with the borrower flows of src/runtime/borrower/flows/4-disclosures.ts reacting to the
// committed events, then reads the borrower API (record, thread, cards) and the tables. What the borrower SEES of these
// facts — the Documents labels, the grouped package, the Dates caution, the What-changed block — is asserted on the
// real components in apps/borrower/tests/cards/flow-4-disclosures.test.tsx. Skips without a database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { connect, reachable, type Db } from "../../infra/db/client.ts";
import { acquireJourneyLock, type TestLock } from "../../infra/db/test-lock.ts";
import { decodeEntityData } from "../../infra/db/entities.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock, MemoryEventStore } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { Runtime } from "../../runtime/app.ts";
import { createApiServer, listen } from "../../runtime/server.ts";
import { createLogger } from "../../runtime/log.ts";
import { createBorrowerRouter, type BorrowerRouter } from "../../runtime/borrower/routes.ts";
import { Journey, MST, EDT, MLO, OFFICER } from "../../runtime/borrower/fixtures/journey.ts";
import { EntityStore } from "../../app/tools.ts";
import { EscalationService } from "../../app/escalations.ts";
import { docGenGate } from "../closing/ops-26-1.ts";
import { lockExpiry } from "../application/ops-21-4.ts";
import { deemedReceiptDate } from "../application/ops-21-2.ts";
import { counselingListFreshness, HCL_MAX_AGE_DAYS } from "../application/ops-21-3.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import type { ToleranceService } from "../application/ops-21-5.ts";
import { whatChanged } from "../../runtime/borrower/flows/4-disclosures.ts";

const DB_URL = process.env["TEST_DATABASE_URL"] ?? "postgresql://sm:sm@localhost/supermortgage_test";
const up = await reachable(DB_URL);
if (!up && process.env["REQUIRE_DB"]) throw new Error(`REQUIRE_DB set but ${DB_URL} is not reachable`);
const skip = up ? false : `no Postgres at ${DB_URL}`;
const TOKEN = "ops-" + randomUUID();
const clock = new FixedClock("2026-09-10T16:00:00.000Z");
const DISCLOSURE = { kind: "agent" as const, id: "disclosure" }; const PRICING = { kind: "agent" as const, id: "pricing" }; const INTAKE = { kind: "agent" as const, id: "intake" }; const CLOSER = { kind: "agent" as const, id: "title-closing" }; const COMPLIANCE = { kind: "agent" as const, id: "compliance-tester" };
const ESIGN = (R: string) => ({ id: `CNS-ESIGN-${R}`, scope: ["disclosures", "notices", "closing_package"], granted_at: MST("2026-10-05", "10:20") });

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
/** 01 §5 / 32.3-T3: personal terms (`numbers`) render from L2 — the journey's borrowers step up with SSN last 4 + DOB (Alex 6789 / 1985-06-15, Blake 4321 / 1986-02-20). */
const L2_FACTS = (email: string) => (email.startsWith("alex-") ? { ssn_last4: "6789", date_of_birth: "1985-06-15" } : { ssn_last4: "4321", date_of_birth: "1986-02-20" });
const tokenL2 = async (email: string): Promise<string> => { const t = (await signIn(email)).token; const up = await api("POST", "/v1/borrower/auth/l2", L2_FACTS(email), t); assert.equal(up.status, 200, JSON.stringify(up.body)); return t; };
const record = async (email: string, subject: string): Promise<Record<string, unknown>> => { await settle(); const r = await api("GET", `/v1/borrower/record?subject=${subject}`, undefined, await tokenL2(email)); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 600)); return r.body; };
const thread = async (email: string): Promise<{ messages: Record<string, unknown>[]; pinned: Record<string, unknown> | null }> => { await settle(); const r = await api("GET", "/v1/borrower/thread?limit=500", undefined, (await signIn(email)).token); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300)); return { messages: r.body["messages"] as Record<string, unknown>[], pinned: (r.body["pinned_card"] as Record<string, unknown> | null) ?? null }; };
interface CardRow { card_instance_id: string; party_id: string; kind: string; status: string; copy_key: string; props: Record<string, unknown>; evidence: Record<string, unknown> | null; command_ref: string | null; created_at: string; resolved_at: string | null }
const cardsOf = async (appId: string, partyId?: string): Promise<CardRow[]> => { await settle(); return db.query<CardRow & Record<string, unknown>>(`SELECT card_instance_id, party_id, kind, status, copy_key, props, evidence, command_ref, created_at, resolved_at FROM card_instances WHERE subject_application_id = $1 AND ($2::uuid IS NULL OR party_id = $2) ORDER BY created_at, card_instance_id`, [appId, partyId ?? null]); };
const events = (appId: string, type?: string) => db.query<{ type: string; occurred_at: string; payload: Record<string, unknown> }>(`SELECT type, occurred_at, payload FROM loan_events WHERE application_id = $1 AND ($2::text IS NULL OR type = $2) ORDER BY sequence`, [appId, type ?? null]);
const timer = async (appId: string, code: string) => (await db.query<{ status: string; due_at: string | null; due_date: string | null }>(`SELECT status::text AS status, due_at, due_date::text AS due_date FROM timers WHERE application_id = $1 AND code = $2 ORDER BY armed_at DESC LIMIT 1`, [appId, code]))[0];
const entity = async (kind: string, id: string): Promise<Record<string, unknown> | null> => { const rows = await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = $1 AND id = $2`, [kind, id]); return rows[0] ? decodeEntityData(rows[0].data) : null; };
/** One application on the shared runtime: its own journey instance (prior loan, lead, borrowers with e-mails) with both borrowers signed in so their cards have a conversation. */
async function openApp(): Promise<{ j: Journey; A: string; B: string; partyA: string; partyB: string }> {
  const R = randomUUID().slice(0, 8); const A = `alex-${R}@example.test`; const B = `blake-${R}@example.test`;
  const j = new Journey({ runtime, db, base, token: TOKEN, clock, borrowerEmail: A, coBorrowerEmail: B, partnerPartyId });
  await j.seedBook(); await j.openApplication();
  const partyA = (await signIn(A)).party_id; const partyB = (await signIn(B)).party_id;
  await j.interview(); await settle();
  return { j, A, B, partyA, partyB };
}
/** The 21.2 LE bridge with the journey's render, delivered on the channel under test (the flow's cards follow the committed events). */
async function deliverLe(j: Journey, delivery: Record<string, unknown>): Promise<Reply> {
  const render = (j as unknown as { LE_RENDER(): Record<string, unknown> }).LE_RENDER();
  clock.set(MST("2026-10-05", "16:10"));
  const r = await j.call("POST", `/v1/applications/${j.appId}/disclosures/le`, { actor: MLO, render, mlo: { review_id: `MR-LE-${j.R}`, nmlsr_id: "987654" }, delivery });
  await settle(); return r;
}
/** The runtime-wide 21.5 register (one ToleranceService per runtime, wired as `services.tolerance`) — read for the changed circumstance's status. */
function tolerance(): ToleranceService {
  const svc = runtime.originationServices.forCommand({ events: new MemoryEventStore(clock), clock, ledger: new MemoryLedger() }, new EntityStore(), new EscalationService(new MemoryEventStore(clock), clock));
  return svc["tolerance"] as ToleranceService;
}
const HUD = (snapshot_at: string, n = 12) => ({ snapshot_at, centroid: { lat: "33.5", long: "-112.0" }, agencies: Array.from({ length: n }, (_, k) => ({ agency_name: `Agency ${k + 1}`, phone: `555-01${String(k).padStart(2, "0")}`, street_address: `Street Address ${k + 1}`, street_address_2: "", city: "Phoenix", state: "AZ", zip: "85004", website: `site ${k + 1}`, email: `email ${k + 1}`, services: "Pre-purchase counseling", languages: "English; Spanish", distance_miles: String(((k * 7) % 12) + 1) })) });
const A3 = (fee: string, from: string, to: string) => `the AMC reports information specific to the transaction that the creditor did not rely on when providing the original disclosures — ${fee} moves from ${from} to ${to} cents (new information specific to the consumer or transaction, §1026.19(e)(3)(iv)(A)(3))`;

// ═══════════════════════════════════ the main journey (App A): T5 · T9 · T8 · T10 in lifecycle order
const main: { j?: Journey; A: string; B: string; partyA: string; partyB: string; ccT8: string; leV2: string; cdV2: string } = { A: "", B: "", partyA: "", partyB: "", ccT8: "", leV2: "", cdV2: "" };

test("32.4-T5: Given a spoken \"proceed\" on an in-app call after LE receipt, then the pending intent `ChoiceCard` resolves with evidence `{channel=voice, transcript_ref}` and `intent_records.valid=true`.", { skip }, async () => {
  const o = await openApp(); Object.assign(main, o); const { j, A, B, partyA, partyB } = o;
  // before the LE is received there is no intent card (32.4 §3: the ChoiceCard appears only after received | deemed_received)
  assert.equal((await cardsOf(j.appId)).filter((c) => c.copy_key === "intent.title").length, 0);
  await j.quoteAndLe(); await settle();   // the LE e-signed and received Oct 5 17:42 MST (21.2's recordReceipt)
  const cards = await cardsOf(j.appId);
  const le = cards.filter((c) => c.copy_key === "le.delivered"); assert.equal(le.length, 2, "one LE DocumentCard per borrower party");
  for (const c of le) { assert.equal(c.status, "resolved", "the receipt 21.2 recorded collapses the card"); assert.equal(c.props["requires_ack"], true); assert.equal(c.props["notice_code"], "NTC_REGZ_1026_37_LE"); assert.equal((c.evidence as Record<string, unknown>)["receipt_evidence"], "esign_confirmed"); }
  const intents = cards.filter((c) => c.copy_key === "intent.title" && c.status === "pending"); assert.equal(intents.length, 2, "the intent ChoiceCard for each party, only after receipt");
  const mine = intents.find((c) => c.party_id === partyA)!; assert.equal(mine.command_ref, "intent.record"); assert.deepEqual((mine.props["options"] as { id: string }[]).map((x) => x.id), ["proceed", "not_yet"]);
  assert.equal(((await record(A, j.appId))["status"] as { badge: string }).badge, "Ready to proceed");
  // the in-app call on Tue Oct 6: the spoken "proceed" resolves the card server-side through the 32.1 tool with the transcript as evidence (intent is not a consent — any manner but silence, 21.4)
  clock.set(MST("2026-10-06", "09:14"));
  const r = await j.tool({ app: j.appId }, "32.1", "resolve_card_by_evidence", { card_instance_id: mine.card_instance_id, option_id: "proceed", evidence: { channel: "voice", transcript_ref: `call-${j.R}#t=00:41`, spoken_text: "yes, let's proceed" } }, INTAKE);
  assert.equal(r.output["status"], "resolved"); assert.equal(r.output["command_ref"], "intent.record"); assert.ok(r.events.some((e) => e.type === "intent.to_proceed.received"), r.events.map((e) => e.type).join(","));
  await settle();
  const resolved = (await cardsOf(j.appId)).find((c) => c.card_instance_id === mine.card_instance_id)!;
  assert.equal(resolved.status, "resolved"); assert.equal(resolved.evidence!["channel"], "voice"); assert.equal(resolved.evidence!["transcript_ref"], `call-${j.R}#t=00:41`); assert.equal(resolved.evidence!["option_id"], "proceed"); assert.equal(resolved.evidence!["manner"], "out_of_band_evidence");
  const intentId = String(((r.output["command_output"] as Record<string, unknown>) ?? {})["intent_id"] ?? (await events(j.appId, "intent.to_proceed.received"))[0]!.payload["intent_id"]);
  const intent = await entity("intent_records", intentId); assert.ok(intent, "the 21.4 intent_records row"); assert.equal(intent!["valid"], true); assert.equal(intent!["le_effective_receipt_date"], "2026-10-05");
  // the Thread shows the resolved card with its voice receipt line; the co-borrower's copy of the ask is withdrawn (one intent per application)
  const t = await thread(A); const receipt = t.messages.find((m) => m["card_instance_id"] === mine.card_instance_id && m["sender"] === "system"); assert.ok(receipt, "the receipt line"); assert.equal(receipt!["channel"], "voice");
  assert.equal((await cardsOf(j.appId, partyB)).find((c) => c.copy_key === "intent.title")!.status, "cancelled");
  assert.ok((await cardsOf(j.appId)).some((c) => c.copy_key === "intent.received" && c.kind === "StatusCard"), "the StatusCard listing what the platform is now doing");
  assert.equal(((await record(B, j.appId))["status"] as { badge: string }).badge, "Rate floating");
});

test("32.4-T9: Given `le_v2` differs from `le_v1` in the appraisal fee, then the What-changed block lists exactly that row with both amounts and the kind label.", { skip }, async () => {
  const j = main.j!; const { A } = main;
  await j.quoteForLock(); await j.requestLock(); await j.executeLockAndCommit(); await j.verifyDecideAndClear(); await settle();
  // Tue Oct 20 14:30 MST: the AMC's complex-assignment fee — basis (A)(3) new information, appraisal $650 → $850 (21.5-T2's worked case)
  clock.set(MST("2026-10-20", "14:30"));
  const cc = await j.tool({ app: j.appId }, "21.5", "evaluateChangedCircumstance", { record: true, basis: "A3", narrative: A3("appraisal", "65000", "85000"), evidence_document_ids: [`DOC-AMC-MSG-${j.R}`], information_received_at: MST("2026-10-20", "14:30"), revised: [{ fee_code: "appraisal", amount_cents: "85000" }] }, DISCLOSURE);
  const ccRow = cc.output["cc"] as Record<string, unknown>; assert.equal(ccRow["valid"], true); assert.equal(ccRow["kind"], "new_info"); assert.equal(ccRow["reflected_on"], "le");
  // LE v2: the 21.2 render with the revised appraisal (every other figure the same), delivered and e-signed Wed Oct 21
  const render = (j as unknown as { LE_RENDER(): Record<string, unknown> }).LE_RENDER();
  const fees = (render["fees"] as Record<string, unknown>[]).map((f) => ({ ...f, estimated_at: "2026-10-20", amount_cents: f["fee_code"] === "appraisal" ? "85000" : f["amount_cents"] }));
  main.leV2 = `LE-${j.appId.slice(0, 8)}-2`;
  clock.set(MST("2026-10-21", "09:00"));
  const v2 = await j.tool({ app: j.appId }, "21.5", "renderRevisedLE", { ...render, disclosure_id: main.leV2, as_of: "2026-10-21", fees, pricing: { ...(render["pricing"] as Record<string, unknown>), locked: true, lock_expires_at: MST("2026-11-23", "17:00"), lock_time_zone: "America/Phoenix" }, cc_ids: [ccRow["cc_id"]] }, DISCLOSURE);
  assert.equal(v2.output["le_version"], 2);
  const d = await j.tool({ app: j.appId }, "21.5", "deliverDisclosure", { disclosure_id: main.leV2, channel: "esign_portal", at: MST("2026-10-21", "09:05"), consent: ESIGN(j.R), receipt_evidence_at: MST("2026-10-21", "18:02") }, DISCLOSURE);
  assert.equal(d.output["le_version"], 2); assert.ok(d.events.some((e) => e.type === "disclosure.le.revised"));
  await settle();
  // the card: one What-changed row — the appraisal, both amounts, the changed-circumstance kind's label
  const cards = (await cardsOf(j.appId, main.partyA)).filter((c) => c.copy_key === "revised_le.delivered"); assert.equal(cards.length, 1);
  const wc = cards[0]!.props["what_changed"] as { since_version: number; kind: string; kind_copy_key: string; rows: { key: string; label: string; from: string; to: string; unit: string }[] };
  assert.equal(wc.since_version, 1); assert.equal(wc.kind, "new_info"); assert.equal(wc.kind_copy_key, "revised_le.kind.new_info");
  assert.equal(wc.rows.length, 1, JSON.stringify(wc.rows)); assert.deepEqual(wc.rows[0], { key: "fee:appraisal", label: "Appraisal Fee to AMC", from: "65000", to: "85000", unit: "cents" });
  assert.equal(cards[0]!.props["le_version"], 2); assert.equal(cards[0]!.props["requires_ack"], true); assert.equal(cards[0]!.props["supersedes_disclosure_id"], `LE-${j.appId.slice(0, 8)}`);
  // computed by the API from the two `disclosure.le.rendered` snapshots (never free text): the same diff falls out of the events
  const rendered = await events(j.appId, "disclosure.le.rendered"); const snap = (v: number) => rendered.filter((e) => Number(e.payload["le_version"] ?? 1) === v).at(-1)!.payload;
  assert.deepEqual(whatChanged(snap(1) as never, snap(2) as never), wc.rows);
  assert.equal(snap(1)["rate_pct"], snap(2)["rate_pct"]); assert.equal(snap(1)["pi_cents"], snap(2)["pi_cents"]);
  // the older version's card is superseded; the Record lists v1 under earlier versions and v2 as the current, received, Loan Estimate
  assert.ok((await cardsOf(j.appId)).filter((c) => c.copy_key === "le.delivered").every((c) => c.status === "superseded" || c.status === "resolved"));
  const docs = (await record(A, j.appId))["documents"] as Record<string, unknown>[];
  const v1 = docs.find((x) => x["disclosure_id"] === `LE-${j.appId.slice(0, 8)}`)!; const v2doc = docs.find((x) => x["disclosure_id"] === main.leV2)!;
  assert.equal(v1["status"], "superseded"); assert.equal(v2doc["status"], "received"); assert.equal(v2doc["title"], "Loan Estimate (revised v2)"); assert.equal(v2doc["le_version"], 2);
  assert.equal((await timer(j.appId, "REGZ_1026_19E4_REVISED_LE_3BD"))?.status, "satisfied", "21.5's 3-day clock is satisfied by the delivery");
});

test("32.4-T8: Given `changed_circumstances.evaluated_valid{kind=new_info}` 2 specific business days before consummation, then no revised LE issues; the change is `reflected_on_cd` and the Thread message uses `revised_le.on_cd_instead`.", { skip }, async () => {
  const j = main.j!; const { A } = main;
  await j.clearToClose(); await j.scheduleClosing(); const cdId = await j.closingDisclosure(); await settle();
  const before = (await events(j.appId, "disclosure.le.revised")).length;
  // Wed Nov 4 — two specific business days before the Fri Nov 6 consummation, the CD out since Mon Nov 2: the tax service fee moves on new information (basis A3)
  clock.set(MST("2026-11-04", "11:00"));
  const cc = await j.tool({ app: j.appId }, "21.5", "evaluateChangedCircumstance", { record: true, basis: "A3", narrative: A3("tax_service", "8500", "10500"), evidence_document_ids: [`DOC-TAX-SVC-${j.R}`], information_received_at: MST("2026-11-04", "11:00"), revised: [{ fee_code: "tax_service", amount_cents: "10500" }], consummation_on: "2026-11-06" }, DISCLOSURE);
  const ccRow = cc.output["cc"] as Record<string, unknown>; main.ccT8 = String(ccRow["cc_id"]);
  assert.equal(ccRow["valid"], true); assert.equal(ccRow["kind"], "new_info"); assert.equal(cc.output["event"], "changed_circumstance.recorded");
  assert.equal(ccRow["reflected_on"], "corrected_cd", "the four-day rule routes the estimate to the CD (the CD was provided Nov 2; consummation Nov 6)");
  assert.ok(cc.events.some((e) => e.type === "disclosure.cd.revised_estimate.requested"), "the 25.2 hand-off");
  // no revised LE issues: 21.5 refuses a render on or after the CD date
  const refused = await j.call("POST", `/v1/applications/${j.appId}/tools/21.5/renderRevisedLE`, { actor: DISCLOSURE, input: { ...(j as unknown as { LE_RENDER(): Record<string, unknown> }).LE_RENDER(), disclosure_id: `LE-${j.appId.slice(0, 8)}-3`, as_of: "2026-11-04", cc_ids: [main.ccT8], cd_delivered_on: "2026-11-02" } });
  assert.notEqual(refused.status, 200); assert.match(JSON.stringify(refused.body), /NO_REVISED_LE_AFTER_CD/);
  assert.equal((await events(j.appId, "disclosure.le.revised")).length, before, "no `disclosure.le.revised` for this change");
  await settle();
  // the Thread: a StatusCard carrying `revised_le.on_cd_instead` for the change, no revised-LE DocumentCard for it
  const cards = await cardsOf(j.appId, main.partyA);
  const onCd = cards.filter((c) => c.copy_key === "revised_le.on_cd_instead"); assert.equal(onCd.length, 1); assert.equal(onCd[0]!.props["cc_id"], main.ccT8); assert.equal(onCd[0]!.props["reflected_on"], "corrected_cd"); assert.equal(onCd[0]!.props["kind_copy_key"], "revised_le.kind.new_info");
  assert.ok(!cards.some((c) => c.copy_key === "revised_le.delivered" && (c.props["what_changed"] as { cc_ids: string[] }).cc_ids.includes(main.ccT8)));
  const t = await thread(A); assert.ok(t.messages.some((m) => m["card_instance_id"] === onCd[0]!.card_instance_id), "the thread message carries the card");
  // the corrected CD (25.2) naming the changed circumstance reflects it: `changed_circumstances.status = reflected_on_cd`
  const cdFees = (j as unknown as { CD_FEES: Record<string, unknown>[] }).CD_FEES.map((f) => (f["fee_code"] === "tax_service" ? { ...f, amount_cents: "10500" } : f));
  const apr = await j.tool({ app: j.appId }, "25.1", "computeApr", { loan_amount_cents: "56000000", note_rate_pct: "6.125", term_months: 360, term_start_date: "2026-11-12", first_payment_date: "2027-01-01", prepaid_finance_charges_cents: "384995", prepaid_interest_cents: "178543", checkpoint: "cd" }, COMPLIANCE);
  main.cdV2 = `${cdId}-C2`;
  const corrected = await j.tool({ app: j.appId }, "25.2", "scheduleCorrectedCd", { disclosure_id: main.cdV2, cd_reason: "pre_consummation_no_wait", cc_ids: [main.ccT8], gate: { run_id: "RUN-CD-2", apr_verdict: "pass" },
    input: { transaction_type: "refinance", state: "AZ", loan: { loan_amount_cents: "56000000", rate_pct: "6.125", term_months: 360, pi_cents: "340262", product: "Fixed Rate", loan_type: "Conventional", purpose: "Refinance", prepayment_penalty: false, balloon: false, arm: false, loan_id_number: j.appId, mic_number: null, first_payment_date: "2027-01-01", maturity_date: "2056-12-01" },
      apr: { apr_calculation_id: apr.output["apr_calculation_id"], apr_pct: apr.output["apr_disclosed_str"], finance_charge_cents: apr.output["finance_charge_cents"], amount_financed_cents: apr.output["amount_financed_cents"], total_of_payments_cents: apr.output["total_of_payments_cents"], tip_pct: String(Number(apr.output["tip_pct"]).toFixed(3)) },
      fees: cdFees, escrow: { established: true, monthly_escrow_cents: "68750", initial_escrow_payment_cents: "206250", escrowed_costs_year1_cents: "825000", non_escrowed_costs_year1_cents: "0" },
      parties: { borrowers: ["Alex Borrower", "Blake Borrower"], creditor_name: "Partner Bank, N.A.", creditor_nmlsr_id: "123456", mlo_name: "Jordan Rivera", mlo_nmlsr_id: "987654", settlement_agent_name: "Desert Title Agency LLC", settlement_agent_license_id: "AZ-TA-4471" },
      dates: { date_issued: "2026-11-04", closing_date: "2026-11-06", disbursement_date: "2026-11-12" }, property_address: "100 N Central Ave, Phoenix AZ 85004", cash_to_close_cents: "555043", lender_credits_cents: "70000", payoffs_and_payments_cents: "54820000", rescindable: true },
    deliveries: [{ consumer_id: "B1", channel: "esign_portal", at: MST("2026-11-04", "11:30"), esign_consent_id: "ESIGN-B1" }, { consumer_id: "B2", channel: "esign_portal", at: MST("2026-11-04", "11:30"), esign_consent_id: "ESIGN-B2" }] }, DISCLOSURE);
  assert.equal(corrected.output["cd_version"], 2); assert.ok(corrected.events.some((e) => e.type === "disclosure.cd.corrected" && (e.payload as { cc_ids: string[] }).cc_ids.includes(main.ccT8)));
  assert.ok(corrected.events.some((e) => e.type === "changed_circumstance.reflected" && e.payload["cc_id"] === main.ccT8 && e.payload["reflected_on"] === "corrected_cd"), corrected.events.map((e) => e.type).join(","));
  assert.equal(tolerance().cc(main.ccT8).status, "reflected_on_cd"); assert.equal(tolerance().cc(main.ccT8).revised_le_disclosure_id, main.cdV2);
  await settle();
  assert.equal(((await record(A, j.appId))["documents"] as Record<string, unknown>[]).find((d) => d["disclosure_id"] === main.cdV2)?.["notice_code"], "NTC_REGZ_1026_38_CD_CORRECTED");
  // the receipts of the corrected CD so the consummation path (26.2) keeps the fixture's facts
  for (const consumer of ["B1", "B2"]) await j.tool({ app: j.appId }, "25.2", "recordReceipt", { disclosure_id: main.cdV2, consumer_id: consumer, evidence: "esign_confirmed", at: MST("2026-11-04", "12:00"), evidence_document_id: `DOC-ESIGN-C2-${consumer}` }, DISCLOSURE);
});

test("32.4-T10: Given `tolerance_tests.refund_required` after consummation, then a `NoticeCard` and a ledger refund appear within 60 days and the borrower took no action.", { skip }, async () => {
  const j = main.j!; const { A, partyA } = main;
  await j.closeAndSign(); await settle();   // consummation Fri Nov 6, 2026 14:26 MST (26.2's eNote signing)
  assert.equal((await timer(j.appId, "REGZ_1026_19F2V_TOLERANCE_REFUND_60"))?.due_date, "2027-01-05", "the 60-day refund clock armed on consummation");
  const cardsBefore = (await cardsOf(j.appId)).length;
  // post-closing QC Fri Nov 20: the flood determination came in at $32.00 against the $12.00 baseline — a zero-tolerance excess found after consummation
  clock.set(MST("2026-11-20", "10:00"));
  const render = (j as unknown as { LE_RENDER(): Record<string, unknown> }).LE_RENDER();
  const actuals = (render["fees"] as Record<string, unknown>[]).filter((f) => f["le_section"] !== "J_lender_credit").map((f) => ({ fee_code: f["fee_code"], amount_cents: f["fee_code"] === "flood_cert" ? "3200" : f["fee_code"] === "appraisal" ? "85000" : f["fee_code"] === "tax_service" ? "10500" : f["amount_cents"] }));
  const qc = await j.tool({ app: j.appId }, "21.5", "runToleranceTest", { stage: "qc", comparison_disclosure_id: main.cdV2, actuals, lender_credit_actual_cents: "-261700" }, DISCLOSURE);
  const t = qc.output["test"] as Record<string, unknown>; assert.equal(t["status"], "refund_required"); assert.equal(String(t["total_excess_cents"]), "2000"); assert.equal(t["cure_route"], "refund_post_consummation");
  // the partner officer releases the ACH refund Tue Nov 24 — inside the 60 days (due Tue Jan 5, 2027)
  clock.set(MST("2026-11-24", "09:00"));
  const refund = await j.tool({ app: j.appId }, "21.5", "issueRefund", { test_id: t["test_id"], instrument: "ach", sent_at: MST("2026-11-24", "09:00"), funded_by: "sm", consummation_on: "2026-11-06", assert_timely: true }, OFFICER);
  assert.equal(String(refund.output["amount_cents"]), "2000"); assert.equal(refund.output["due_on"], "2027-01-05"); assert.equal(refund.output["sent_on"], "2026-11-24");
  const issued = refund.events.find((e) => e.type === "tolerance.refund.issued")!; assert.equal(issued.payload["late"], false);
  // the ledger refund: 21.5's entry set (borrower_refunds_payable cleared against corporate cash) persisted with the command
  const set = (await db.query<{ id: string; description: string; effective_date: string }>(`SELECT id, description, effective_date::text AS effective_date FROM ledger_entry_sets WHERE id = $1`, [String(issued.payload["ledger_set_id"])]))[0];
  assert.ok(set, "the refund's ledger entry set"); assert.match(set!.description, /tolerance refund \$20\.00 sent by ach/); assert.equal(set!.effective_date, "2026-11-24");
  const lines = await db.query<{ account: string; amount_cents: string }>(`SELECT account, amount_cents::text AS amount_cents FROM ledger_lines WHERE set_id = $1 ORDER BY account`, [set!.id]);
  assert.deepEqual(lines.map((l) => [l.account, l.amount_cents]), [["borrower_refunds_payable", "2000"], ["corporate_cash", "-2000"]]);
  await settle();
  // the NoticeCard: no action, the amount and dates from the event; the borrower took no action (no card of theirs resolved, nothing in needed_from_you)
  const notices = (await cardsOf(j.appId, partyA)).filter((c) => c.copy_key === "tolerance.refund.notice");
  assert.equal(notices.length, 1); const n = notices[0]!;
  assert.equal(n.kind, "NoticeCard"); assert.equal(n.command_ref, null); assert.equal(n.props["notice_code"], "NTC_REGZ_1026_38_CD_CORRECTED"); assert.equal(n.props["amount_cents"], "2000"); assert.equal(n.props["sent_on"], "2026-11-24"); assert.equal(n.props["due_on"], "2027-01-05"); assert.equal(n.props["ledger_set_id"], set!.id);
  assert.equal(n.status, "resolved"); assert.equal((n.evidence as Record<string, unknown>)["resolved_by"], "system:flow-32.4", "filed as read by the platform, never resolved by the borrower");
  const borrowerActs = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM card_instance_events WHERE actor LIKE 'borrower:%' AND card_instance_id IN (SELECT card_instance_id FROM card_instances WHERE subject_application_id = $1 AND created_at >= $2)`, [j.appId, MST("2026-11-20", "00:00")]);
  assert.equal(borrowerActs[0]!.n, "0"); assert.ok((await cardsOf(j.appId)).length > cardsBefore);
  const rec = await record(A, j.appId); assert.ok(!(rec["needed_from_you"] as { card_instance_id: string | null }[]).some((x) => x.card_instance_id === n.card_instance_id));
  assert.ok(Date.parse(n.created_at) <= Date.parse("2027-01-05T23:59:59Z"), "within 60 days of consummation");
});

// ═══════════════════════════════════ App B: the mailed LE and the electronic copy once E-SIGN is active (T1)
test("32.4-T1: Given `consents{esign}` inactive at LE approval, then `disclosure.le.mailed` and the Documents row reads *Mailed {{date}}*; given consent becomes active later, then a re-delivered electronic copy appears as a new row, and the original mailing evidence remains.", { skip }, async () => {
  const { j, A, partyA } = await openApp();
  // no active E-SIGN consent: 21.2 places the LE in the mail with the print vendor's proof — `disclosure.le.mailed`, never `.delivered`
  const r = await deliverLe(j, { channel: "mail", at: MST("2026-10-05", "16:10"), mailing_proof_id: `PRINT-${j.R}` });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body["status"], "mailed");
  const mailed = await events(j.appId, "disclosure.le.mailed"); assert.equal(mailed.length, 1); assert.equal(mailed[0]!.payload["mailing_proof_id"], `PRINT-${j.R}`); assert.equal((await events(j.appId, "disclosure.le.delivered")).length, 0);
  const leId = `LE-${j.appId.slice(0, 8)}`;
  let docs = (await record(A, j.appId))["documents"] as Record<string, unknown>[];
  const original = docs.find((d) => d["disclosure_id"] === leId && !d["copy_of_disclosure_id"])!;
  assert.equal(original["status"], "mailed"); assert.equal(original["mailed_at"], MST("2026-10-05", "16:10")); assert.equal(original["channel"], "mail"); assert.equal(docs.filter((d) => d["kind"] === "disclosure:le").length, 1);
  // the Thread: "Mailed today to {{mailing address}}" + the E-SIGN ConsentCard re-offered; no DocumentCard (the card exists only under an active consent)
  const cards = await cardsOf(j.appId, partyA);
  assert.ok(cards.some((c) => c.copy_key === "le.mailed" && c.kind === "StatusCard")); assert.equal(cards.filter((c) => c.kind === "DocumentCard").length, 0);
  const consentCard = cards.find((c) => c.copy_key === "consent.esign.title" && c.kind === "ConsentCard" && c.status === "pending")!; assert.ok(consentCard, "the E-SIGN ConsentCard re-offered");
  // the borrower checks the box and types their name (never by voice) → consents{esign} pending verification; the 7001(c) demonstration test then makes it active (20.3's demonstration on the lead)
  clock.set(MST("2026-10-12", "09:00")); const tok = (await signIn(A)).token;
  const resolved = await api("POST", `/v1/borrower/cards/${consentCard.card_instance_id}/resolve`, { option_id: "affirm", evidence: { consent_kind: "esign", method: "checkbox_with_text", typed_name: "Alex Borrower", text_hash: "sha256:esign-7001c", disclosure_version_id: "NTC_ESIGN_7001C_DISCLOSURE", affirmed_at: MST("2026-10-12", "09:00") } }, tok);
  assert.equal(resolved.status, 201, JSON.stringify(resolved.body)); assert.equal(resolved.body["command"], "consent.capture");
  assert.equal((await db.query<{ status: string }>(`SELECT status FROM consents WHERE party_id = $1 AND kind = 'esign' ORDER BY captured_at DESC LIMIT 1`, [partyA]))[0]?.status, "pending_verification");
  const scope = { loan: j.priorLoanId }; const consentId = `c-esign-${j.R}`;
  await j.tool(scope, "20.3", "captureConsent", { lead_id: j.leadId, kind: "esign", consent_id: consentId, party_id: "B1", scopes: ["origination_disclosures"], disclosure_version: "NTC_ESIGN_7001C_DISCLOSURE", captured_via: "portal" });
  clock.set(MST("2026-10-12", "09:20"));
  const demo = await j.tool(scope, "20.3", "captureConsent", { lead_id: j.leadId, kind: "esign", op: "demonstrate", consent_id: consentId, link_opened_at: MST("2026-10-12", "09:15"), token_entered_at: MST("2026-10-12", "09:20"), token_ok: true });
  assert.equal(demo.output["status"], "active"); assert.ok(demo.events.some((e) => e.type === "consent.esign.active"));
  await settle();
  // a re-delivered electronic copy: a new Documents row beside the mailing; the original row and its mailing evidence remain
  docs = (await record(A, j.appId))["documents"] as Record<string, unknown>[];
  const le = docs.filter((d) => d["kind"] === "disclosure:le"); assert.equal(le.length, 2, JSON.stringify(le));
  const still = le.find((d) => !d["copy_of_disclosure_id"])!; assert.equal(still["status"], "mailed"); assert.equal(still["mailed_at"], MST("2026-10-05", "16:10")); assert.equal(still["channel"], "mail");
  const copy = le.find((d) => d["copy_of_disclosure_id"] === leId)!; assert.equal(copy["status"], "delivered"); assert.equal(copy["channel"], "esign_portal"); assert.equal(copy["title"], "Loan Estimate (electronic copy)"); assert.equal(copy["delivered_at"], MST("2026-10-12", "09:20"));
  const copyCard = (await cardsOf(j.appId, partyA)).find((c) => c.copy_key === "le.electronic_copy")!; assert.equal(copyCard.kind, "DocumentCard"); assert.equal(copyCard.props["electronic_copy"], true); assert.equal(copyCard.props["requires_ack"], true); assert.equal(copyCard.command_ref, "disclosure.acknowledgeReceipt");
  assert.equal((await events(j.appId, "disclosure.le.mailed")).length, 1, "the mailing evidence is untouched"); assert.equal((await events(j.appId, "disclosure.le.received")).length, 0, "the mailbox rule still governs receipt of the mailed original");
});

// ═══════════════════════════════════ App C: the e-mailed LE with no confirmation → deemed received on the third specific business day (T2)
test("32.4-T2: Given an e-mailed LE with no confirmation, then `deemed_received` is set on the third specific business day and the Record shows *(deemed)*.", { skip }, async () => {
  const { j, A, partyA } = await openApp();
  const r = await deliverLe(j, { channel: "email", at: MST("2026-10-05", "16:10"), consent: ESIGN(j.R) });   // no receipt
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body["status"], "delivered"); assert.equal(r.body["effective_receipt_date"], null);
  const leId = `LE-${j.appId.slice(0, 8)}`;
  const issued = (await events(j.appId, "disclosure.le.issued"))[0]!; assert.equal(issued.payload["deemed_receipt_date"], "2026-10-08"); assert.equal(deemedReceiptDate(D("2026-10-05")), "2026-10-08");   // Tue 6, Wed 7, Thu 8 (Saturdays count; Sundays and holidays do not)
  assert.equal((await timer(j.appId, "REGZ_1026_19E1IV_LE_MAILBOX_3SBD"))?.status, "armed");
  // Wed Oct 7: still delivered, no receipt; the intent card is not offered yet
  await tick(MST("2026-10-07", "09:00"));
  let docs = (await record(A, j.appId))["documents"] as Record<string, unknown>[]; assert.equal(docs.find((d) => d["disclosure_id"] === leId)!["status"], "delivered");
  assert.equal((await cardsOf(j.appId, partyA)).filter((c) => c.copy_key === "intent.title").length, 0);
  // Thu Oct 8, the third specific business day: the mailbox sweep deems it received — 21.2's own two events; the clock is satisfied
  await tick(MST("2026-10-08", "09:00"));
  const deemed = await events(j.appId, "disclosure.le.deemed_received"); assert.equal(deemed.length, 1); assert.equal(deemed[0]!.payload["deemed_receipt_date"], "2026-10-08");
  const received = await events(j.appId, "disclosure.le.received"); assert.equal(received.length, 1); assert.equal(received[0]!.payload["evidence"], "mailbox_rule"); assert.equal(received[0]!.payload["received_on"], null); assert.equal(received[0]!.payload["effective_receipt_date"], "2026-10-08");
  assert.equal((await entity("disclosures", leId))!["status"], "deemed_received"); assert.equal((await timer(j.appId, "REGZ_1026_19E1IV_LE_MAILBOX_3SBD"))?.status, "satisfied");
  docs = (await record(A, j.appId))["documents"] as Record<string, unknown>[]; const row = docs.find((d) => d["disclosure_id"] === leId)!;
  assert.equal(row["status"], "deemed_received"); assert.equal(row["received_on"], "2026-10-08"); assert.equal(row["channel"], "email");
  // a second pass changes nothing; the intent ChoiceCard is offered now (received | deemed_received)
  await tick(MST("2026-10-09", "09:00")); assert.equal((await events(j.appId, "disclosure.le.deemed_received")).length, 1);
  assert.equal((await cardsOf(j.appId, partyA)).filter((c) => c.copy_key === "intent.title" && c.status === "pending").length, 1);
  assert.equal(((await record(A, j.appId))["status"] as { badge: string }).badge, "Ready to proceed");
});

// ═══════════════════════════════════ App D: the companion package — the stale counseling list (T3) and the ARM pair before the LE card (T4)
test("32.4-T3: Given a companion `hcl` planned with `hud_snapshot_at` 31 days old, then the card is not created until a fresh snapshot exists (21.3 gate).", { skip }, async () => {
  const { j, partyA } = await openApp();
  clock.set(MST("2026-10-05", "10:41"));
  const plan = await j.tool({ app: j.appId }, "21.3", "planCompanionPackage", { application_received_at: MST("2026-10-05", "10:16"), transaction_type: "limited_cash_out", property_state: "AZ", property_zip5: "85004", borrowers: [{ id: "B1", name: "Alex Borrower", current_address_zip5: "85004", current_address_country: "US", primary: true }, { id: "B2", name: "Blake Borrower", current_address_zip5: "85004", current_address_country: "US" }] }, DISCLOSURE);
  const hcl = (plan.output["rows"] as { kind: string; status: string; timer_code: string }[]).find((x) => x.kind === "hcl")!; assert.equal(hcl.status, "planned"); assert.equal(hcl.timer_code, "REGX_1024_20_HCL_3BD");
  // the list generated Oct 5 from HUD data obtained Sat Sept 5: 31 calendar days old on Tue Oct 6 — the 21.3 gate refuses the delivery, so no card is created
  clock.set(MST("2026-10-05", "15:31"));
  const stale = await j.tool({ app: j.appId }, "21.3", "generateCounselingList", { hud: HUD(MST("2026-09-05", "15:31")), at: MST("2026-10-05", "15:31") }, DISCLOSURE);
  assert.equal(stale.output["hud_snapshot_at"], MST("2026-09-05", "15:31")); assert.equal(stale.output["status"], "generated");
  clock.set(MST("2026-10-06", "09:00"));
  const refused = await j.call("POST", `/v1/applications/${j.appId}/tools/21.3/deliver`, { actor: DISCLOSURE, input: { kind: "hcl", channel: "esign_portal", at: MST("2026-10-06", "09:00"), consent: ESIGN(j.R) } });
  assert.notEqual(refused.status, 200, "21.3's CompanionDisclosureService refuses the stale list (STALE_COUNSELING_LIST) and nothing commits");
  assert.deepEqual(counselingListFreshness(MST("2026-09-05", "15:31"), MST("2026-10-06", "09:00"), "America/Phoenix"), { age_days: 31, fresh: false }); assert.equal(HCL_MAX_AGE_DAYS, 30);
  await settle();
  assert.equal((await cardsOf(j.appId)).filter((c) => c.copy_key === "companion.hcl").length, 0, "no counseling-list card until a fresh snapshot exists");
  assert.equal((await events(j.appId, "disclosure.companion.delivered")).length, 0); assert.equal((await timer(j.appId, "REGX_1024_20_HCL_3BD"))?.status, "armed");
  // a fresh snapshot (Sun Sept 6 — 30 days on Oct 6) regenerates the list; the delivery lands and the card appears
  clock.set(MST("2026-10-06", "09:05"));
  const fresh = await j.tool({ app: j.appId }, "21.3", "generateCounselingList", { hud: HUD(MST("2026-09-06", "08:00")), at: MST("2026-10-06", "09:05") }, DISCLOSURE); assert.equal(fresh.output["hud_snapshot_at"], MST("2026-09-06", "08:00"));
  clock.set(MST("2026-10-06", "09:10"));
  const d = await j.tool({ app: j.appId }, "21.3", "deliver", { kind: "hcl", channel: "esign_portal", at: MST("2026-10-06", "09:10"), consent: ESIGN(j.R) }, DISCLOSURE);
  assert.equal(d.output["status"], "delivered"); assert.ok(d.events.some((e) => e.type === "disclosure.companion.delivered" && e.payload["kind"] === "hcl"));
  await settle();
  const cards = (await cardsOf(j.appId, partyA)).filter((c) => c.copy_key === "companion.hcl"); assert.equal(cards.length, 1);
  assert.equal(cards[0]!.kind, "DocumentCard"); assert.equal(cards[0]!.props["requires_ack"], false); assert.equal(cards[0]!.props["notice_code"], "NTC_REGX_1024_20_HCL"); assert.equal(cards[0]!.props["disclosure_id"], d.output["disclosure_id"]); assert.equal(cards[0]!.status, "resolved", "no action: filed as read");
  assert.ok(Date.parse(cards[0]!.created_at) >= Date.parse(MST("2026-10-06", "09:10")));
  assert.equal((await timer(j.appId, "REGX_1024_20_HCL_3BD"))?.status, "satisfied");
  Object.assign(armApp, { j, partyA });
});
const armApp: { j?: Journey; partyA: string } = { partyA: "" };

test("32.4-T4: Given an ARM selected in R7, then `NTC_REGZ_1026_19B_ARM_PROGRAM` and `NTC_REGZ_1026_19B_CHARM` cards exist before the LE receipt card is shown.", { skip }, async () => {
  const j = armApp.j!; const partyA = armApp.partyA;
  // R7 · the borrower picks the adjustable-rate product: 21.1's `application.arm_interest.recorded{fnma_plan_number}`; 21.3 plans the ARM program disclosure and the CHARM booklet with the gate closed
  clock.set(MST("2026-10-05", "12:00"));
  const arm = await j.tool({ app: j.appId }, "21.1", "captureField", { field: "arm_interest", fnma_plan_number: "4928" }, INTAKE);
  assert.equal(arm.output["arm_interest_recorded"], true); assert.ok(arm.events.some((e) => e.type === "application.arm_interest.recorded"));
  const planned = await j.tool({ app: j.appId }, "21.3", "renderArmProgramDisclosure", { application_id: j.appId, fnma_plan_number: "4928", channel: "electronic", record_interest: true, initial_rate_pct: "5.875", illustration_as_of: "2026-10" }, DISCLOSURE);
  const rows = planned.output["rows"] as { program: { status: string; notice_code: string }; charm: { status: string; notice_code: string; asset_version: string } };
  assert.equal(rows.program.status, "planned"); assert.equal(rows.program.notice_code, "NTC_REGZ_1026_19B_ARM_PROGRAM"); assert.equal(rows.charm.notice_code, "NTC_REGZ_1026_19B_CHARM"); assert.equal(rows.charm.asset_version, "2020-06");
  assert.equal((await timer(j.appId, "REGZ_1026_19B_ARM_DISCLOSURE_GATE"))?.status, "armed");
  // the LE is delivered and e-signed at 16:10 — but the ARM pair has not gone out: the LE receipt card is held back
  const r = await deliverLe(j, { channel: "esign_portal", at: MST("2026-10-05", "16:10"), consent: ESIGN(j.R), receipt: { kind: "esignature", at: MST("2026-10-05", "17:42"), borrower_id: "B1" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let cards = await cardsOf(j.appId, partyA);
  assert.equal(cards.filter((c) => c.copy_key === "le.delivered").length, 0, "no LE receipt card while REGZ_1026_19B_ARM_DISCLOSURE_GATE is closed");
  assert.equal(cards.filter((c) => c.copy_key === "companion.arm").length, 0);
  // the CHARM booklet (2020-06) and the Plan 4928 program disclosure viewed in the app at 17:50: `arm.disclosures.delivered` opens the gate
  clock.set(MST("2026-10-05", "17:50"));
  const charm = await j.tool({ app: j.appId }, "21.3", "deliver", { kind: "charm", channel: "esign_portal", at: MST("2026-10-05", "17:50"), consent: ESIGN(j.R), asset_version: "2020-06" }, DISCLOSURE); assert.equal(charm.output["status"], "delivered");
  await settle();
  cards = await cardsOf(j.appId, partyA);
  assert.equal(cards.filter((c) => c.copy_key === "companion.arm").length, 1); assert.equal(cards.filter((c) => c.copy_key === "le.delivered").length, 0, "still held: the program disclosure is the second of the pair");
  clock.set(MST("2026-10-05", "17:51"));
  const prog = await j.tool({ app: j.appId }, "21.3", "deliver", { kind: "arm_program", channel: "esign_portal", at: MST("2026-10-05", "17:51"), consent: ESIGN(j.R) }, DISCLOSURE); assert.equal(prog.output["status"], "delivered");
  assert.ok(prog.events.some((e) => e.type === "arm.disclosures.delivered" && e.payload["fnma_plan_number"] === "4928")); assert.equal((await timer(j.appId, "REGZ_1026_19B_ARM_DISCLOSURE_GATE"))?.status, "satisfied");
  await settle();
  cards = await cardsOf(j.appId, partyA);
  const armCards = cards.filter((c) => c.copy_key === "companion.arm"); const le = cards.filter((c) => c.copy_key === "le.delivered");
  assert.equal(armCards.length, 2); assert.deepEqual(armCards.map((c) => c.props["notice_code"]).sort(), ["NTC_REGZ_1026_19B_ARM_PROGRAM", "NTC_REGZ_1026_19B_CHARM"]);
  assert.equal(le.length, 1, "the LE receipt card now exists — after both ARM cards");
  for (const c of armCards) assert.ok(Date.parse(c.created_at) <= Date.parse(le[0]!.created_at), `${String(c.props["notice_code"])} before the LE card`);
  assert.equal(le[0]!.props["package_id"], `LE-${j.appId.slice(0, 8)}`); assert.ok(armCards.every((c) => c.props["package_id"] === `LE-${j.appId.slice(0, 8)}`), "one grouped message: the companions share the LE's package");
  assert.equal(le[0]!.status, "resolved", "the receipt 21.2 already recorded collapses the LE card");
  assert.ok(cards.some((c) => c.copy_key === "intent.title" && c.status === "pending"), "the intent ChoiceCard follows the receipt");
});

// ═══════════════════════════════════ App E: the lock executed Tue Oct 27 for 45 days (T6) and its expiry (T7)
test("32.4-T6: Given a lock executed Tue Oct 27, 2026 for 45 days, then Numbers show expiry Fri Dec 11, 2026; `SM_LOCK_EXPIRY_WARN_7` styles the Dates row caution on Fri Dec 4.", { skip }, async () => {
  const { j, A, partyA } = await openApp(); Object.assign(lockApp, { j, A, partyA });
  await j.quoteAndLe(); await j.recordIntent(); await settle();
  // Tue Oct 27: the day's sheet, 21.4's quote, the request and the MLO's approval — a 45-day lock executed 10:19 MST
  clock.set(EDT("2026-10-27", "06:35")); await j.tool({}, "20.4", "publishRateSheet", { rate_sheet_id: "rs-2026-10-27", partner_id: j.PARTNER_ID, source: "pe_whole_loan_api", published_at: EDT("2026-10-27", "06:35"), expires_at: EDT("2026-10-27", "17:00"), prices: (j as unknown as { PRICES: unknown }).PRICES }, PRICING);
  clock.set(MST("2026-10-27", "10:05"));
  const quote = await j.tool({ app: j.appId }, "21.4", "getQuote", { loan_amount_cents: "56000000", product_code: "FRM30_CONV", note_rate_pct: "6.125", lock_period_days: 45, at: MST("2026-10-27", "10:05") }, PRICING); const quoteId = quote.output["quote_id"] as string;
  const req = await j.tool({ app: j.appId }, "21.4", "requestLock", { quote_id: quoteId, borrower_statement: "Please lock my rate today", property_state: "AZ", le_loan_amount_cents: "56000000", requested_at: MST("2026-10-27", "10:05") }, PRICING); const lockId = req.output["lock_id"] as string;
  clock.set(MST("2026-10-27", "10:19"));
  await j.tool({ app: j.appId }, "21.4", "executeLock", { lock_id: lockId, op: "approve", quote_id: quoteId, mlo_nmlsr_id: "987654", approved_at: MST("2026-10-27", "10:19") }, MLO);
  const lock = await j.tool({ app: j.appId }, "21.4", "executeLock", { lock_id: lockId, executed_at: MST("2026-10-27", "10:19") }, PRICING);
  assert.equal(lock.output["status"], "executed"); assert.equal(lock.output["rate_set_date"], "2026-10-27"); assert.equal(lock.output["expires_on"], "2026-12-11"); assert.equal(lock.output["expiry_roll_applied"], false);
  assert.deepEqual([lockExpiry(D("2026-10-27"), 45).expires_on, lockExpiry(D("2026-10-27"), 45).display], ["2026-12-11", "12/11/2026 at 5:00 p.m. MST"]);
  lockApp.lockId = lockId;
  // the Timer Engine's own rows: the deadline on Fri Dec 11, the warning on Fri Dec 4 (−7 calendar days)
  assert.equal((await timer(j.appId, "SM_LOCK_EXPIRY_DEADLINE"))?.due_date, "2026-12-11"); assert.equal((await timer(j.appId, "SM_LOCK_EXPIRY_WARN_7"))?.due_date, "2026-12-04"); assert.equal((await timer(j.appId, "SM_LOCK_EXPIRY_WARN_7"))?.status, "armed");
  // Numbers: the lock block shows the Fri Dec 11 expiry; Dates carry the expiry row without caution before the warning day
  clock.set(MST("2026-10-27", "11:00"));
  let rec = await record(A, j.appId);
  assert.equal((rec["status"] as { badge: string }).badge, "Rate locked");
  const lockBlock = (rec["numbers"] as { lock: Record<string, unknown> }).lock; assert.equal(lockBlock["status"], "executed"); assert.equal(lockBlock["expires_on"], "2026-12-11"); assert.equal(lockBlock["expires_at"], MST("2026-12-11", "17:00")); assert.equal(lockBlock["period_days"], 45);
  let dates = rec["dates"] as { timer_code: string; label: string; due_at: string; tone?: string }[];
  const deadline = dates.find((d) => d.timer_code === "SM_LOCK_EXPIRY_DEADLINE")!; assert.equal(deadline.label, "Rate lock expires"); assert.equal(deadline.due_at.slice(0, 10), "2026-12-12"); assert.equal(deadline.tone, undefined);
  assert.equal(dates.find((d) => d.timer_code === "SM_LOCK_EXPIRY_WARN_7")?.tone, undefined);
  assert.ok((await cardsOf(j.appId, partyA)).some((c) => c.copy_key === "lock.executed"), "the StatusCard 'Locked {{rate}} through {{expires_at}}'");
  // Fri Dec 4: the warning day — the 21.4 playbook warns (`lock.expiry.warned` satisfies SM_LOCK_EXPIRY_WARN_7), the Dates row turns caution, the Thread gets the warning card
  await tick(MST("2026-12-04", "09:00"));
  assert.equal((await timer(j.appId, "SM_LOCK_EXPIRY_WARN_7"))?.status, "satisfied"); assert.equal((await events(j.appId, "lock.expiry.warned")).length, 1);
  rec = await record(A, j.appId); dates = rec["dates"] as { timer_code: string; label: string; due_at: string; tone?: string }[];
  assert.equal(dates.find((d) => d.timer_code === "SM_LOCK_EXPIRY_DEADLINE")?.tone, "caution", JSON.stringify(dates));
  assert.equal(((rec["numbers"] as { lock: Record<string, unknown> }).lock)["expires_on"], "2026-12-11");
  const warn = (await cardsOf(j.appId, partyA)).find((c) => c.copy_key === "lock.expiry_warn.no_closing" || c.copy_key === "lock.expiry_warn")!; assert.ok(warn, "the expiry warning StatusCard"); assert.equal((warn.props["copy_tokens"] as { date: string }).date, "2026-12-11");
});
const lockApp: { j?: Journey; A: string; partyA: string; lockId: string } = { A: "", partyA: "", lockId: "" };

test("32.4-T7: Given a lock expired, then no closing slot `ScheduleCard` can be created until a relock (`SM_O71_DOC_GEN_GATE`), and the Thread explains why.", { skip }, async () => {
  const j = lockApp.j!; const { A, partyA, lockId } = lockApp;
  // Sat Dec 12: the expiration instant has passed — the 21.4 playbook expires the lock (`lock.expired`; SM_LOCK_EXPIRY_DEADLINE breached on the sweep)
  await tick(MST("2026-12-12", "09:00"));
  assert.equal((await events(j.appId, "lock.expired")).length, 1); assert.equal((await entity("locks", lockId))!["status"], "expired");
  const rec = await record(A, j.appId); assert.equal(((rec["numbers"] as { lock: Record<string, unknown> }).lock)["status"], "expired");
  // no closing slot: 26.1's SM_O71_DOC_GEN_GATE needs an active lock through the closing date — closed for an expired lock, open again for a relocked one
  const closed = docGenGate({ final_cd_delivered: true, approval_ptd_cleared: true, trust_poa_gate_open: true, compliance_pass_cd_gate_open: true, lock_status: "expired", lock_expires_on: D("2026-12-11"), closing_date: D("2026-12-18") });
  assert.equal(closed.open, false); assert.match(closed.reason ?? "", /lock/i);
  // the borrower cannot pick a closing slot either: closing.selectSlot is refused for an application that is not clear to close, and no ScheduleCard{ron_session} was ever created
  const tok = (await signIn(A)).token;
  const slot = await api("POST", "/v1/borrower/commands/closing.selectSlot", { subject: { application_id: j.appId }, slot: MST("2026-12-18", "14:00"), state: "AZ", settlement_agent_party_id: "P-ESCROW-AZ-1", transaction_type: "limited_cash_out" }, tok);
  assert.notEqual(slot.status, 200); assert.ok(typeof slot.body["copy_key"] === "string");
  assert.equal((await cardsOf(j.appId)).filter((c) => c.kind === "ScheduleCard").length, 0);
  // the Thread explains why: the expired-lock StatusCard and "you'll need to lock before we can prepare closing documents"
  const cards = await cardsOf(j.appId, partyA);
  const expired = cards.find((c) => c.copy_key === "lock.expired")!; assert.ok(expired); assert.equal((expired.props["copy_tokens"] as { date: string }).date, "2026-12-11");
  const why = cards.find((c) => c.copy_key === "lock.required_before_closing")!; assert.ok(why, "the explanation"); assert.equal(why.props["gate"], "SM_O71_DOC_GEN_GATE");
  const t = await thread(A); assert.ok(t.messages.some((m) => m["card_instance_id"] === why.card_instance_id));
  assert.ok(Date.parse(expired.created_at) <= Date.parse(why.created_at));
  // a relock (21.4 rule 7, MLO-approved) makes the gate's lock condition pass again — a new lock version with `supersedes_lock_id`
  clock.set(EDT("2026-12-14", "06:35")); await j.tool({}, "20.4", "publishRateSheet", { rate_sheet_id: "rs-2026-12-14", partner_id: j.PARTNER_ID, source: "pe_whole_loan_api", published_at: EDT("2026-12-14", "06:35"), expires_at: EDT("2026-12-14", "17:00"), prices: (j as unknown as { PRICES: unknown }).PRICES }, PRICING);
  clock.set(MST("2026-12-14", "10:00"));
  const q2 = await j.tool({ app: j.appId }, "21.4", "getQuote", { loan_amount_cents: "56000000", product_code: "FRM30_CONV", note_rate_pct: "6.125", lock_period_days: 30, at: MST("2026-12-14", "10:00") }, PRICING);
  const relock = await j.tool({ app: j.appId }, "21.4", "relock", { lock_id: lockId, quote_id: q2.output["quote_id"], mlo_nmlsr_id: "987654", relocked_at: MST("2026-12-14", "10:05") }, MLO);
  assert.equal(relock.output["supersedes_lock_id"], lockId); assert.equal(relock.output["version"], 2);
  await settle();
  const open = docGenGate({ final_cd_delivered: true, approval_ptd_cleared: true, trust_poa_gate_open: true, compliance_pass_cd_gate_open: true, lock_status: "active", lock_expires_on: D(String(relock.output["expires_on"])), closing_date: D("2026-12-18") });
  assert.equal(open.open, true);
  assert.equal((await entity("locks", String(relock.output["lock_id"])))!["status"], "executed"); assert.equal((await entity("locks", lockId))!["status"], "superseded");
  assert.ok((await cardsOf(j.appId, partyA)).some((c) => c.copy_key === "lock.executed" && c.props["lock_id"] === relock.output["lock_id"]), "the relock's StatusCard");
});
