// 32.5 Verification, needs list, conditions, second borrower
// spec/sections/32-borrower-experience/32-5-verification-needs-list-conditions-second-borrower.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// Every T-id drives the real runtime over HTTP (the journey fixture: 20.x → 21.1 → the 21.2 LE bridge → 21.4 → 22.x/23.x
// bus tools → 26.2) with the borrower flows of src/runtime/borrower/flows/5-verification.ts reacting to the committed
// events, then reads the borrower API (record, thread, cards) and the tables. The owning processes' own steps — 22.1's
// classification/extraction/review, 22.2's UDM alert, 22.4's deposit test, 26.2's reschedule — are driven as their own
// agents (the FAKE classifier/vendor path), never mocked. What the borrower SEES of these facts — the mismatch/stale
// copy, the owner chips, the nothing-needed state and the strip count, the per-party delivery line — is asserted on the
// real components in apps/borrower/tests/cards/flow-5-verification.test.tsx. Skips without a database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connect, type Db } from "../../infra/db/client.ts";
import { testDatabase } from "../../infra/db/test-db.ts";
import { decodeEntityData } from "../../infra/db/entities.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock } from "../../kernel/events/index.ts";
import { Runtime } from "../../runtime/app.ts";
import { createApiServer, listen } from "../../runtime/server.ts";
import { createLogger } from "../../runtime/log.ts";
import { createBorrowerRouter, type BorrowerRouter } from "../../runtime/borrower/routes.ts";
import { Journey, MST } from "../../runtime/borrower/fixtures/journey.ts";
import { paystubFloor, requestSchedule } from "../verification/ops-22-1.ts";
import { plainDate as D, addDays } from "../../kernel/calendar/date.ts";
import { FAKE_ASSET_ACCOUNTS } from "../../runtime/borrower/vendors/fake-plaid.ts";
import { deterministicUuid } from "../underwriting/du/writer.ts";
import { readDuGraph } from "../underwriting/du/graph.ts";
import { loadGraph } from "../underwriting/du/emit.ts";
import { DECLARATIONS, firstDeclarationsCard } from "../../runtime/borrower/flows/3-entry.ts";

const { url: DB_URL, skip } = await testDatabase(import.meta.url);
const TOKEN = "ops-" + randomUUID();
const clock = new FixedClock("2026-09-10T16:00:00.000Z");
const INTAKE = { kind: "agent" as const, id: "intake" }; const VERIFICATION = { kind: "agent" as const, id: "verification" }; const CLOSER = { kind: "agent" as const, id: "title-closing" }; const HUMAN_AGENT = { kind: "human" as const, id: "u-agent-7", role: "human_agent" };
const ESIGN = (R: string) => ({ id: `CNS-ESIGN-${R}`, scope: ["disclosures", "notices", "closing_package"], granted_at: MST("2026-10-05", "10:20") });
const DECISION_WORDS = /approv|declin|qualif|decision|denied|eligib|underwrit/i;

let db: Db; let runtime: Runtime; let router: BorrowerRouter; let base = ""; let close: () => Promise<void> = async () => undefined; let partnerPartyId = "";

test.before(async () => {
  if (skip) return;
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
test.after(async () => { if (!skip) { await close(); } });

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
type Rec = Record<string, unknown>;
const record = async (email: string, subject: string): Promise<Rec> => { await settle(); const r = await api("GET", `/v1/borrower/record?subject=${subject}`, undefined, (await signIn(email)).token); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 600)); return r.body; };
const thread = async (email: string): Promise<{ messages: Rec[]; pinned: Rec | null }> => { await settle(); const r = await api("GET", "/v1/borrower/thread?limit=500", undefined, (await signIn(email)).token); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300)); return { messages: r.body["messages"] as Rec[], pinned: (r.body["pinned_card"] as Rec | null) ?? null }; };
interface CardRow { card_instance_id: string; party_id: string; kind: string; status: string; copy_key: string; props: Rec; evidence: Rec | null; command_ref: string | null; created_at: string; resolved_at: string | null }
const cardsOf = async (appId: string, partyId?: string): Promise<CardRow[]> => { await settle(); return db.query<CardRow & Record<string, unknown>>(`SELECT card_instance_id, party_id, kind, status, copy_key, props, evidence, command_ref, created_at, resolved_at FROM card_instances WHERE subject_application_id = $1 AND ($2::uuid IS NULL OR party_id = $2) ORDER BY created_at, card_instance_id`, [appId, partyId ?? null]); };
const events = (appId: string, type?: string) => db.query<{ id: string; type: string; occurred_at: string; payload: Rec }>(`SELECT id, type, occurred_at, payload FROM loan_events WHERE application_id = $1 AND ($2::text IS NULL OR type = $2) ORDER BY sequence`, [appId, type ?? null]);
const timer = async (appId: string, code: string) => (await db.query<{ status: string; due_at: string | null; due_date: string | null; satisfied_by_event_id: string | null }>(`SELECT status::text AS status, due_at, due_date::text AS due_date, satisfied_by_event_id FROM timers WHERE application_id = $1 AND code = $2 ORDER BY armed_at DESC LIMIT 1`, [appId, code]))[0];
const entity = async (kind: string, id: string): Promise<Rec | null> => { const rows = await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = $1 AND id = $2`, [kind, id]); return rows[0] ? decodeEntityData(rows[0].data) : null; };
const entitiesOf = async (kind: string, appId: string): Promise<{ id: string; data: Rec }[]> => (await db.query<{ id: string; data: unknown }>(`SELECT DISTINCT ON (id) id, data FROM entity_records WHERE kind = $1 AND application_id = $2 ORDER BY id, version DESC`, [kind, appId])).map((r) => ({ id: r.id, data: decodeEntityData(r.data) }));
/** One application on the shared runtime: its own journey instance with both borrowers signed in so their cards have a conversation. */
async function openApp(): Promise<{ j: Journey; A: string; B: string; partyA: string; partyB: string }> {
  const R = randomUUID().slice(0, 8); const A = `alex-${R}@example.test`; const B = `blake-${R}@example.test`;
  const j = new Journey({ runtime, db, base, token: TOKEN, clock, borrowerEmail: A, coBorrowerEmail: B, partnerPartyId });
  await j.seedBook(); await j.openApplication();
  const partyA = (await signIn(A)).party_id; const partyB = (await signIn(B)).party_id;
  await j.interview(); await settle();
  return { j, A, B, partyA, partyB };
}
/** The borrower's upload through the card: the resolve carries what the upload endpoint returned (document id, hash, pages) — the mapped `document.upload` runs 22.1 ingestDocument against the card's request. */
async function uploadThrough(card: CardRow, token: string, doc: { document_id: string; sha256: string; page_count: number; file_name: string }): Promise<Reply> {
  return api("POST", `/v1/borrower/cards/${card.card_instance_id}/resolve`, { option_id: "upload", evidence: { document_class: card.props["document_class"], file_name: doc.file_name, uploaded_at: clock.now() }, args: { document_id: doc.document_id, sha256: doc.sha256, page_count: doc.page_count } }, token);
}
/** 22.1's own pipeline after an upload (the FAKE classifier and extractor as the verification agent) up to the review that satisfies or re-opens the request. */
async function classifyAndReview(j: Journey, document_id: string, doc_class: string, fields: Rec): Promise<Rec> {
  await j.tool({ app: j.appId }, "22.1", "classifyDocument", { document_id, doc_class, confidence: 0.98 }, VERIFICATION);
  await j.tool({ app: j.appId }, "22.1", "extractFields", { document_id, extraction_id: `x-${document_id}`, fields }, VERIFICATION);   // an explicit id: 22.1's `x-n` counter is per application, entity_records' key is global
  await j.tool({ app: j.appId }, "22.1", "runIntegrityBattery", { document_id }, VERIFICATION);
  const rv = await j.tool({ app: j.appId }, "22.1", "matchToRequests", { document_id, op: "review" }, VERIFICATION);
  await settle(); return rv.output;
}
const pendingUploadFor = (cards: CardRow[], partyId: string, requestId: string): CardRow | undefined => cards.filter((c) => c.party_id === partyId && c.kind === "UploadCard" && c.props["request_id"] === requestId && c.status === "pending").at(-1);

// ═══════════════════════════════════ the main journey (App M): T1 · T2 · T3 · T5 · T6 · T10 · T4 in lifecycle order
const main: { j?: Journey; A: string; B: string; partyA: string; partyB: string; incomeCondition: string; paystubRequest: string; alertId: string } = { A: "", B: "", partyA: "", partyB: "", incomeCondition: "", paystubRequest: "", alertId: "" };

test("32.5-T1: Given a DU verification message opens a `conditions` row, then within `SM_DU_CONDITIONS_SLA_4H` it appears in Needed-from-you with owner *you* and a verb-first label.", { skip }, async () => {
  const o = await openApp(); Object.assign(main, o); const { j, A, partyA } = o;
  await j.quoteAndLe(); await j.recordIntent(); await j.quoteForLock(); await j.requestLock(); await j.executeLockAndCommit(); await settle();
  // Tue Oct 6, 2026: 23.1 delivers the findings (10:00Z) and 23.2 interprets them at 17:12Z — DU message V1001 ("verify base income … paystub (30 days) and W-2") opens COND_DU_VERIFY_INCOME_BASE for B1
  await j.verifyDecideAndClear(); await settle();
  const conds = await entitiesOf("conditions", j.appId);
  const income = conds.find((c) => c.data["template_code"] === "COND_DU_VERIFY_INCOME_BASE")!; assert.ok(income, "the V1001 condition"); main.incomeCondition = income.id;
  assert.equal(income.data["borrower_id"], "B1"); assert.equal(income.data["source"], "du"); assert.equal(income.data["borrower_visible"], true);
  assert.equal(income.data["status"], "waiting_borrower", "23.3's lifecycle step — the needs-list item was sent (condition.waiting), never a UI transition");
  assert.ok((await events(j.appId, "condition.waiting")).some((e) => e.payload["condition_id"] === income.id && e.payload["on"] === "borrower"));
  // the 4-hour clock: armed on du.findings.received, satisfied by du.findings.interpreted{conditions_materialized} — the item is in front of the borrower inside it
  const sla = (await timer(j.appId, "SM_DU_CONDITIONS_SLA_4H"))!; assert.ok(sla, "SM_DU_CONDITIONS_SLA_4H"); assert.equal(sla.status, "satisfied"); assert.ok(sla.due_at);
  const opened = (await events(j.appId, "condition.opened")).find((e) => e.payload["condition_id"] === income.id)!; assert.ok(Date.parse(opened.occurred_at) <= Date.parse(sla.due_at!));
  // 22.1's request for each document class the condition names (linked to the condition, never free-typed), with its 5-day clock
  const reqs = (await entitiesOf("document_requests", j.appId)).filter((r) => r.data["condition_id"] === income.id);
  assert.deepEqual(reqs.map((r) => r.data["doc_class"]).sort(), ["paystub", "w2"]); assert.ok(reqs.every((r) => r.data["status"] === "open" && r.data["reason_code"] === "V1001"));
  const paystubReq = reqs.find((r) => r.data["doc_class"] === "paystub")!; main.paystubRequest = paystubReq.id;
  const dueOn = requestSchedule(String(paystubReq.data["requested_at"])).due_at; assert.equal(paystubReq.data["due_at"], dueOn, "22.1's own schedule: +5 calendar days from the request (the clock the flow reacted on)");
  assert.equal((await timer(j.appId, "SM_NEEDS_LIST_BORROWER_RESPONSE_5"))?.status, "armed");
  // Needed from you: the item with owner *you*, a verb-first line from the copy library (`upload.title` + the class in words), its due date and its own UploadCard — created inside the SLA
  const rec = await record(A, j.appId);
  const item = (rec["needed_from_you"] as Rec[]).find((x) => x["item_id"] === income.id)!; assert.ok(item, JSON.stringify(rec["needed_from_you"]).slice(0, 400));
  assert.equal(item["owner"], "you"); assert.equal(item["kind"], "condition"); assert.match(String(item["label"]), /^Upload your most recent pay stub/); assert.equal(item["label_copy_key"], "upload.title"); assert.deepEqual(item["copy_tokens"], { document: "most recent pay stub" });
  assert.equal(item["due_at"], `${dueOn}T23:59:59.000Z`, "the item's due date is the request's, never computed by the UI");
  const card = (await cardsOf(j.appId, partyA)).find((c) => c.card_instance_id === item["card_instance_id"])!; assert.ok(card, "the item's action chip opens the flow's UploadCard");
  assert.equal(card.kind, "UploadCard"); assert.equal(card.status, "pending"); assert.equal(card.command_ref, "document.upload"); assert.equal(card.props["condition_id"], income.id); assert.equal(card.props["request_id"], paystubReq.id); assert.equal(card.props["document_class"], "paystub"); assert.equal(card.props["timer_code"], "SM_NEEDS_LIST_BORROWER_RESPONSE_5");
  assert.ok(Date.parse(card.created_at) <= Date.parse(sla.due_at!), "the card exists within SM_DU_CONDITIONS_SLA_4H");
  assert.equal((rec["needed_summary"] as Rec)["count"], (rec["needed_from_you"] as Rec[]).length); assert.equal((rec["needed_summary"] as Rec)["copy_key"], "needs.title");
  assert.ok((rec["dates"] as Rec[]).some((d) => d["timer_code"] === "SM_NEEDS_LIST_BORROWER_RESPONSE_5" && d["label"] === "Please send by"), "the 5-day clock renders from `timers`");
  // one list, one owner per item: the title commitment and the payoff statement sit under What we're doing with their owner label; the pinned ChecklistCard mirrors the list
  const doing = rec["what_we_are_doing"] as Rec[];
  assert.equal(doing.find((x) => x["label"] === conds.find((c) => c.data["template_code"] === "COND_DU_TITLE_COMMITMENT")!.data["text"])?.["owner"], "title_company");
  assert.equal(doing.find((x) => x["label"] === conds.find((c) => c.data["template_code"] === "COND_DU_PAYOFF_EXISTING_LIEN")!.data["text"])?.["owner"], "prior_servicer");
  assert.ok(doing.every((x) => x["owner_copy_key"] && String(x["owner_copy_key"]).startsWith("needs.owner.")));
  assert.ok(!doing.some((x) => x["item_id"] === income.id), "the borrower's own item is never also under What we're doing");
  const t = await thread(A); assert.equal(t.pinned?.["kind"], "ChecklistCard"); assert.equal(t.pinned?.["copy_key"], "needs.title");
  const items = (t.pinned!["props"] as Rec)["items"] as Rec[]; const mine = items.find((x) => x["condition_id"] === income.id)!;
  assert.equal(mine["owner"], "you"); assert.equal(mine["status"], "waiting_borrower"); assert.equal((mine["action"] as Rec)["card_instance_id"], card.card_instance_id); assert.match(String(mine["label"]), /^Upload your/);
  assert.ok(items.some((x) => x["owner"] === "third_party"), "the title company's item is listed with its owner, not the borrower's");
});

test("32.5-T2: Given an `UploadCard{paystub}` receives a W-2, then the item stays `waiting_borrower` and the card shows the mismatch copy with the detected class.", { skip }, async () => {
  const j = main.j!; const { A, partyA } = main;
  const first = pendingUploadFor(await cardsOf(j.appId), partyA, main.paystubRequest)!; assert.ok(first, "the paystub UploadCard");
  // Thu Oct 8: the borrower uploads a W-2 against the paystub card — `document.upload` → 22.1 ingestDocument{request_id} → `document.received{request_id}`
  clock.set(MST("2026-10-08", "10:00")); const tok = (await signIn(A)).token;
  const up = await uploadThrough(first, tok, { document_id: `doc-w2-${j.R}`, sha256: `sha-w2-${j.R}`, page_count: 1, file_name: "w2-2025.pdf" });
  assert.equal(up.status, 201, JSON.stringify(up.body)); assert.equal(up.body["command"], "document.upload");
  const received = (await events(j.appId, "document.received")).filter((e) => e.payload["document_id"] === `doc-w2-${j.R}`); assert.equal(received.length, 1); assert.equal(received[0]!.payload["request_id"], main.paystubRequest);
  // the FAKE classifier reads a W-2; 22.1's review refuses it for the paystub request and re-opens the request with the reason (22.1's own verdict)
  const rv = await classifyAndReview(j, `doc-w2-${j.R}`, "w2", { employer_name: "Acme Manufacturing", tax_year: 2025, wages_cents: "9500000" });
  const review = (rv["reviews"] as Rec[]).find((r) => r["request_id"] === main.paystubRequest)!; assert.equal(review["satisfied"], false); assert.match(String(review["reason"]), /document class w2 does not satisfy a paystub request/);
  assert.equal((await entity("document_requests", main.paystubRequest))!["status"], "open");
  assert.equal((await entity("conditions", main.incomeCondition))!["status"], "waiting_borrower", "the item stays waiting_borrower");
  // the card re-opens: a newer UploadCard for the same request carries the mismatch (detected class in the borrower's words), the borrower's resolved card stays as history
  const cards = await cardsOf(j.appId, partyA);
  assert.equal(cards.find((c) => c.card_instance_id === first.card_instance_id)!.status, "resolved");
  const reopened = pendingUploadFor(cards, partyA, main.paystubRequest)!; assert.ok(reopened, "the re-opened card"); assert.notEqual(reopened.card_instance_id, first.card_instance_id);
  assert.deepEqual(reopened.props["mismatch"], { detected: "W-2", expected: "most recent pay stub" }); assert.equal(reopened.props["rejected_document_id"], `doc-w2-${j.R}`); assert.equal(reopened.copy_key, "upload.title");
  const rec = await record(A, j.appId); const item = (rec["needed_from_you"] as Rec[]).find((x) => x["item_id"] === main.incomeCondition)!;
  assert.ok(item, "still needed from you"); assert.equal(item["owner"], "you"); assert.equal(item["card_instance_id"], reopened.card_instance_id);
});

test("32.5-T3: Given a paystub dated 40 days before the application date, then the freshness copy renders the 30-day rule and the request stays open.", { skip }, async () => {
  const j = main.j!; const { A, partyA } = main;
  const card = pendingUploadFor(await cardsOf(j.appId), partyA, main.paystubRequest)!;
  // the application date is Mon Oct 5, 2026 (21.1); 40 days before is Wed Aug 26 — below 22.1's floor of Sept 5 (30 days before application, never re-based)
  const APPLICATION_DATE = "2026-10-05"; const payDate = addDays(D(APPLICATION_DATE), -40); assert.equal(payDate, "2026-08-26"); assert.equal(paystubFloor(D(APPLICATION_DATE)), "2026-09-05");
  clock.set(MST("2026-10-09", "09:30")); const tok = (await signIn(A)).token;
  const up = await uploadThrough(card, tok, { document_id: `doc-stub-old-${j.R}`, sha256: `sha-stub-old-${j.R}`, page_count: 2, file_name: "paystub-aug.pdf" }); assert.equal(up.status, 201, JSON.stringify(up.body));
  const rv = await classifyAndReview(j, `doc-stub-old-${j.R}`, "paystub", { employer_name: "Acme Manufacturing", pay_date: payDate, pay_period_start: "2026-08-10", pay_period_end: "2026-08-23", gross_current_cents: "625000", gross_ytd_cents: "10000000", medicare_withholding_ytd_cents: "145000" });
  const review = (rv["reviews"] as Rec[]).find((r) => r["request_id"] === main.paystubRequest)!; assert.equal(review["satisfied"], false); assert.match(String(review["reason"]), /2026-08-26 is before the floor 2026-09-05/);
  assert.equal((await timer(j.appId, "FNMA_B3_3_2_01_PAYSTUB_30D_GATE"))?.status, "armed", "22.1's paystub floor gate");
  assert.equal((await entity("document_requests", main.paystubRequest))!["status"], "open", "the request stays open");
  // the freshness copy: `upload.stale` with the date and the rule's 30 days (a rule constant, never a computed date)
  const cards = await cardsOf(j.appId, partyA); const stale = pendingUploadFor(cards, partyA, main.paystubRequest)!; assert.ok(stale);
  assert.notEqual(stale.card_instance_id, card.card_instance_id); assert.deepEqual(stale.props["stale"], { date: "Aug 26, 2026", n: 30 }); assert.equal(stale.props["mismatch"], undefined);
  assert.equal(cards.find((c) => c.card_instance_id === card.card_instance_id)!.status, "resolved");
  assert.equal((await entity("conditions", main.incomeCondition))!["status"], "waiting_borrower");
});

test("32.5-T5: Given the pre-closing credit refresh finds a new tradeline, then a `ConfirmCard` renders naming creditor and open date and nothing about the decision; a yes adds `application_liabilities` and triggers DU resubmission per 23.1 tolerances.", { skip }, async () => {
  const j = main.j!; const { A, partyA, partyB } = main;
  assert.equal((await entitiesOf("application_liabilities", j.appId)).length, 0);
  // Thu Oct 29, 08:05 MST: the FAKE UDM vendor reports a new tradeline for B1 (22.2's own alert; the borrower is not told the source's verdict)
  clock.set(MST("2026-10-29", "08:05"));
  const rec22 = await j.tool({ app: j.appId }, "22.2", "triageUdmAlert", { op: "receive", borrower_id: "B1", alert_type: "new_tradeline", vendor_alert_id: `UDV-${j.R}`, payload: { creditor_name: "Conn's Home Plus", account_ref: "CHP-5521", opened: "2026-10-22", monthly_payment_cents: "45000", balance_cents: "1480000", liability_kind: "installment" }, received_at: MST("2026-10-29", "08:05") }, VERIFICATION);
  main.alertId = String((rec22.output["alert"] as Rec)["alert_id"]); assert.equal((rec22.output["alert"] as Rec)["status"], "open");
  await settle();
  const confirm = (await cardsOf(j.appId, partyA)).find((c) => c.kind === "ConfirmCard" && c.props["alert_id"] === main.alertId)!; assert.ok(confirm, "the ConfirmCard for the finding");
  assert.equal(confirm.status, "pending"); assert.equal(confirm.copy_key, "new_debt.confirm"); assert.equal(confirm.command_ref, "application.confirmField");
  assert.deepEqual(confirm.props["copy_tokens"], { creditor: "Conn's Home Plus", date: "Oct 22, 2026" }); assert.equal(confirm.props["source"], "credit_refresh"); assert.equal(confirm.props["helper_copy_key"], "new_debt.source");
  assert.doesNotMatch(JSON.stringify(confirm.props), DECISION_WORDS, "nothing about the decision"); assert.equal(confirm.evidence, null);
  assert.equal((await cardsOf(j.appId, partyB)).filter((c) => c.props["alert_id"] === main.alertId).length, 0, "the finding is B1's — the co-borrower's thread carries no card for it");
  // Fri Oct 30: yes — the liability is added (22.2 verified_new_debt → application_liabilities), 22.5's DTI moves 38.00% → 41.75% (+3.75), 23.1's B3-2-10 test requires a resubmission
  clock.set(MST("2026-10-30", "10:15")); const tok = (await signIn(A)).token;
  const yes = await api("POST", `/v1/borrower/cards/${confirm.card_instance_id}/resolve`, { option_id: "yes", evidence: { fields: [{ path: `credit.alert.${main.alertId}`, value_confirmed: "Conn's Home Plus", source: "credit_report", confirmed_at: clock.now() }], edited: false } }, tok);
  assert.equal(yes.status, 201, JSON.stringify(yes.body)); const out = yes.body["result"] as Rec;
  assert.equal(out["is_mine"], true); assert.equal(out["alert_id"], main.alertId); assert.equal((out["resubmission"] as Rec)["result"], "resubmission_required"); assert.ok(((out["resubmission"] as Rec)["rule_codes"] as string[]).includes("B3_2_10_DTI_45_OR_3PT"), JSON.stringify(out["resubmission"]));
  assert.equal(out["dti_after_tenths"], 418, "22.5: (456,000 + 45,000) / 1,200,000 = 41.75% → 417.5 tenths → 418 (half-up)");
  const liabilities = await entitiesOf("application_liabilities", j.appId); assert.equal(liabilities.length, 1); assert.equal(liabilities[0]!.data["monthly_payment_cents"], "45000"); assert.equal(liabilities[0]!.data["source"], "udm_alert");
  const found = await events(j.appId, "credit.undisclosed_debt.found"); assert.equal(found.length, 1); assert.equal(found[0]!.payload["disclosed_before_closing"], true);
  const resub = await events(j.appId, "du.resubmission.required"); assert.equal(resub.length, 1); assert.equal(resub[0]!.payload["trigger_event"], "credit.undisclosed_debt.found");
  assert.ok((await entitiesOf("du_resubmission_checks", j.appId)).some((c) => c.data["result"] === "resubmission_required" && c.data["rule_code"] === "B3_2_10_DTI_45_OR_3PT"));
  assert.equal((await entity("credit_alerts", main.alertId))!["status"], "verified_new_debt");
  const after = (await cardsOf(j.appId, partyA)); assert.equal(after.find((c) => c.card_instance_id === confirm.card_instance_id)!.status, "resolved");
  assert.ok(after.some((c) => c.copy_key === "new_debt.rechecking" && c.kind === "StatusCard"), "the assistant states that the application is being re-checked");
});

test("32.5-T6: Given a large deposit of $9,000 against $8,200 monthly qualifying income, then an `ExplanationCard` is created for that deposit only.", { skip }, async () => {
  const j = main.j!; const { partyA } = main;
  // 22.4's own test on the fixture checking account (declared for B1): the $9,000.00 deposit is unsourced above the $4,100.00 threshold (50% of $8,200.00); a $1,200.00 payroll deposit is not
  clock.set(MST("2026-10-21", "09:00"));
  const r = await j.tool({ app: j.appId }, "22.4", "evaluateDeposits", { asset_id: `chk-${j.R}`, transaction: "purchase", total_monthly_qualifying_income_cents: "820000", deposits: [
    { deposit_id: `dep-9000-${j.R}`, posted_on: "2026-09-14", amount_cents: "900000", description_on_statement: "DEPOSIT", sources: [] }, { deposit_id: `dep-small-${j.R}`, posted_on: "2026-09-20", amount_cents: "120000", description_on_statement: "PAYROLL ACME", sources: [] }] }, VERIFICATION);
  assert.equal(String(r.output["threshold_cents"]), "410000");
  const deposits = r.output["deposits"] as Rec[]; assert.equal(deposits.find((d) => d["deposit_id"] === `dep-9000-${j.R}`)!["large_deposit"], true); assert.equal(deposits.find((d) => d["deposit_id"] === `dep-small-${j.R}`)!["large_deposit"], false);
  const flagged = await events(j.appId, "asset.deposit.flagged_large"); assert.equal(flagged.length, 1); assert.equal(flagged[0]!.payload["deposit_id"], `dep-9000-${j.R}`);
  await settle();
  const cards = (await cardsOf(j.appId)).filter((c) => c.kind === "ExplanationCard" && typeof c.props["deposit_id"] === "string");
  assert.equal(cards.length, 1, "one ExplanationCard, for that deposit only"); const card = cards[0]!;
  assert.equal(card.party_id, partyA); assert.equal(card.props["deposit_id"], `dep-9000-${j.R}`); assert.equal(card.status, "pending"); assert.equal(card.command_ref, "explanation.submit"); assert.equal(card.copy_key, "explain.title");
  assert.equal(card.props["prompt_copy_key"], "explain.deposit"); assert.equal(card.props["subject_copy_key"], "explain.deposit.subject"); assert.equal(card.props["gate"], "FNMA_B3_4_2_02_LARGE_DEPOSIT_GATE");
  const tokens = card.props["copy_tokens"] as Rec; assert.equal(tokens["money"], "$9,000.00"); assert.equal(tokens["date"], "Sep 14, 2026"); assert.equal(tokens["account_last4"], "····1234");
  assert.equal(cards.some((c) => c.props["deposit_id"] === `dep-small-${j.R}`), false);
  const rec = await record(main.A, j.appId); assert.ok((rec["needed_from_you"] as Rec[]).some((x) => x["card_instance_id"] === card.card_instance_id && x["owner"] === "you"), "the explanation is the borrower's item");
});

test("32.5-T10: Given a human agent is engaged, when the agent attempts to resolve a `ConsentCard` on the borrower's behalf, then the API refuses (`party_id` mismatch).", { skip }, async () => {
  const j = main.j!; const { A, B, partyA } = main;
  // the borrower asks for a person: human.request → `human.transfer.requested` → the Thread's PersonCard{human_agent}
  clock.set(MST("2026-11-01", "09:00")); const tokA = (await signIn(A)).token;
  const msg = await api("POST", "/v1/borrower/messages", { text: "I'd like to talk to a human about this", subject: { application_id: j.appId } }, tokA);
  assert.equal(msg.status, 200, JSON.stringify(msg.body)); assert.equal(msg.body["command_executed"], true); assert.equal(msg.body["command"], "human.request");
  assert.equal((await events(j.appId, "human.transfer.requested")).length, 1);
  await settle();
  const person = (await cardsOf(j.appId, partyA)).find((c) => c.kind === "PersonCard")!; assert.ok(person, "PersonCard{human_agent}"); assert.equal(person.props["role"], "human_agent"); assert.equal(person.props["name_copy_key"], "human.agent.pending"); assert.equal(person.status, "resolved", "no action: filed as read");
  // the human agent can SEND a card (the standing-connection consent, 32.1 send_card as a human) …
  const sent = await j.call("POST", `/v1/applications/${j.appId}/tools/32.1/send_card`, { actor: HUMAN_AGENT, input: { party_id: partyA, kind: "ConsentCard", copy_key: "consent.standing.title", command_ref: "consent.capture", subject: { application_id: j.appId },
    props: { consent_kind: "blanket_verification_authorization", disclosure_version_id: "NTC_SM_STANDING_AUTHORIZATION", scope: ["income", "assets"], affirmation_method: "checkbox_with_text", title: "", body_text: "", requires_typed_name: true, verification_state: "none", command_args: { kind: "blanket_verification_authorization", method: "checkbox_with_text", scope: ["income", "assets"], disclosure_version_id: "NTC_SM_STANDING_AUTHORIZATION", standing: true } } } });
  assert.equal(sent.status, 200, JSON.stringify(sent.body)); const consentCardId = String((sent.body["output"] as Rec)["card_instance_id"]); assert.equal((sent.body["output"] as Rec)["created_by"], "human:human_agent");
  // … but never resolve one for the borrower: the borrower API scopes the resolve to the session's party — the human's session (another party) is refused with a party_id mismatch
  const tokOther = (await signIn(B)).token;
  const refused = await api("POST", `/v1/borrower/cards/${consentCardId}/resolve`, { option_id: "affirm", evidence: { consent_kind: "blanket_verification_authorization", method: "checkbox_with_text", typed_name: "Alex Borrower" } }, tokOther);
  assert.equal(refused.status, 403); assert.equal(refused.body["code"], "PARTY_SCOPE"); assert.equal(refused.body["copy_key"], "error.not_yours"); assert.equal(refused.body["gate"], undefined);
  // and the agent tool path refuses a ConsentCard from any out-of-band evidence, whoever holds it (32.1 guardrails / 01 §3.5)
  const byEvidence = await j.call("POST", `/v1/applications/${j.appId}/tools/32.1/resolve_card_by_evidence`, { actor: HUMAN_AGENT, input: { card_instance_id: consentCardId, option_id: "affirm", evidence: { channel: "voice", transcript_ref: `call-${j.R}#t=03:12`, spoken_text: "yes I consent" } } });
  assert.notEqual(byEvidence.status, 200, "32.1's CardRefused(CARD_EVIDENCE_KIND) — the ops tool route answers it untyped (a seam outside 32.5); the borrower API's answer above is the typed one");
  const still = (await cardsOf(j.appId, partyA)).find((c) => c.card_instance_id === consentCardId)!; assert.equal(still.status, "pending"); assert.equal(still.evidence, null);
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM consents WHERE party_id = $1 AND kind::text = 'blanket_verification_authorization'`, [partyA]))[0]!.n, "0", "no consent row was written by anyone but the borrower");
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM card_instance_events WHERE card_instance_id = $1 AND to_status <> 'pending'`, [consentCardId]))[0]!.n, "0");
});

test("32.5-T4: Given the closing date moves from Nov 6 to Dec 15, 2026 and an asset statement would exceed 4 months at the new note date, then `SM_DOC_EXPIRY_WARN_14` shows in Dates and a re-request is created on expiry with the reason text.", { skip }, async () => {
  const j = main.j!; const { A, partyA } = main;
  await j.clearToClose(); await j.scheduleClosing(); await settle();   // the closing Fri Nov 6, 2026 14:00 MST (26.2)
  // Mon Nov 2: the July statement on file — period end Jul 31 → 22.1's four-month expiry Nov 30 (fresh for a Nov 6 note date); SM_DOC_EXPIRY_WARN_14 arms on `document.extracted{expires_at}` (−14 days = Nov 16)
  clock.set(MST("2026-11-02", "10:30")); const docId = `doc-stmt-jul-${j.R}`;
  await j.tool({ app: j.appId }, "22.1", "ingestDocument", { document_id: docId, source_channel: "borrower_upload", sha256: `sha-stmt-jul-${j.R}`, subject_borrower_id: "B1", applicant_borrower_ids: ["B1", "B2"], page_count: 4 }, VERIFICATION);
  await j.tool({ app: j.appId }, "22.1", "classifyDocument", { document_id: docId, doc_class: "bank_statement", confidence: 0.99 }, VERIFICATION);
  const x = await j.tool({ app: j.appId }, "22.1", "extractFields", { document_id: docId, extraction_id: `x-${docId}`, fields: { institution: "First Bank", account_last4: "1234", period_start: "2026-07-01", period_end: "2026-07-31", ending_balance_cents: "3124018" } }, VERIFICATION);
  assert.equal(x.output["document_date"], "2026-07-31"); assert.equal(x.output["expires_at"], "2026-11-30"); assert.equal(x.output["freshness_status"], "fresh");
  const warn = (await timer(j.appId, "SM_DOC_EXPIRY_WARN_14"))!; assert.ok(warn, "SM_DOC_EXPIRY_WARN_14"); assert.equal(warn.status, "armed"); assert.equal(warn.due_date, "2026-11-16");
  let rec = await record(A, j.appId); let dates = rec["dates"] as Rec[];
  const row = dates.find((d) => d["timer_code"] === "SM_DOC_EXPIRY_WARN_14")!; assert.ok(row, JSON.stringify(dates)); assert.equal(row["label"], "A document is about to go out of date — we may ask again"); assert.equal(new Date(String(row["due_at"])).toISOString(), new Date(warn.due_at!).toISOString(), "the Dates row renders `timers.due_at`, never a computed date"); assert.equal(row["status"], "armed");
  // the closing moves to Tue Dec 15, 2026 (26.2's own reschedule): the statement would be more than four months old at the new note date
  clock.set(MST("2026-11-02", "15:00"));
  const moved = await j.tool({ app: j.appId }, "26.2", "monitorSession", { op: "reschedule", closing_id: j.CLOSING_ID, scheduled_at: MST("2026-12-15", "14:00"), closing_type: "ron", reason: "borrower travel" }, CLOSER);
  assert.equal(moved.output["scheduled_note_date"], "2026-12-15"); assert.ok((await events(j.appId, "closing.rescheduled")).length >= 1);
  // the nightly sweep (22.1 computeFreshness{op=sweep} through the flow's tick): `document.expired` and the replacement request with 22.1's reason — the flow's card carries the moved date
  const before = (await entitiesOf("document_requests", j.appId)).length;
  await tick(MST("2026-11-03", "02:00"));
  const expired = (await events(j.appId, "document.expired")).filter((e) => e.payload["document_id"] === docId); assert.equal(expired.length, 1); assert.equal(expired[0]!.payload["scheduled_note_date"], "2026-12-15"); assert.equal(expired[0]!.payload["expires_at"], "2026-11-30");
  const reqs = (await entitiesOf("document_requests", j.appId)).filter((r) => r.data["reason_code"] === "sm_freshness"); assert.equal(reqs.length, 1); assert.ok((await entitiesOf("document_requests", j.appId)).length > before);
  const req = reqs[0]!; assert.equal(req.data["doc_class"], "bank_statement"); assert.equal(req.data["borrower_id"], "B1"); assert.equal(req.data["status"], "open"); assert.equal((req.data["qualifier"] as Rec)["replaces_document_id"], docId);
  assert.match(String(req.data["reason_text"]), /more recent bank statement/); assert.match(String(req.data["reason_text"]), /Jul 31, 2026/); assert.match(String(req.data["reason_text"]), /more than four months old/);
  await settle();
  const card = pendingUploadFor(await cardsOf(j.appId), partyA, req.id)!; assert.ok(card, "the re-request's UploadCard");
  assert.equal(card.props["reason_copy_key"], "upload.rerequest.closing_moved"); assert.deepEqual(card.props["copy_tokens"], { document: "bank statement", date: "Dec 15, 2026", n: "120" }); assert.equal(card.props["document_class"], "bank_statement"); assert.match(String(card.props["reason_text"]), /more than four months old/);
  rec = await record(A, j.appId); dates = rec["dates"] as Rec[];
  assert.ok(dates.some((d) => d["timer_code"] === "SM_DOC_EXPIRY_WARN_14" && new Date(String(d["due_at"])).toISOString() === new Date(warn.due_at!).toISOString()), "the warning stays in Dates until the replacement arrives or closing is confirmed before expiry");
  assert.ok((rec["needed_from_you"] as Rec[]).some((x) => x["item_id"] === req.id && x["owner"] === "you" && x["card_instance_id"] === card.card_instance_id));
});

// ═══════════════════════════════════ App J: the second borrower (T7) and a non-borrowing spouse (T8)
const second: { j?: Journey; A: string; partyA: string; C: string; partyC: string } = { A: "", partyA: "", C: "", partyC: "" };

test("32.5-T7: Given a co-borrower invite, then a `credit.authorize` for the invitee is refused until `joint_intent` is affirmed by that invitee (`SM_O21_JOINT_INTENT_GATE`).", { skip }, async () => {
  const { j, A, partyA } = await openApp(); Object.assign(second, { j, A, partyA }); const C = `casey-${j.R}@example.test`; second.C = C;
  // the agent puts the InviteCard in front of Alex (any point before intake_complete); Alex names Casey — never answers for them
  clock.set(MST("2026-10-05", "11:05"));
  const invite = await j.tool({ app: j.appId }, "32.1", "send_card", { party_id: partyA, kind: "InviteCard", copy_key: "coborrower.invite", command_ref: "application.inviteParty", subject: { application_id: j.appId }, props: { party_role: "co_borrower", title: "", contact_fields: ["first_name", "last_name", "email"], copy_tokens: { first_name: "Casey" } } }, INTAKE);
  const tokA = (await signIn(A)).token;
  const r = await api("POST", `/v1/borrower/cards/${invite.output["card_instance_id"]}/resolve`, { option_id: "invite", evidence: { party_role: "co_borrower", contact: { first_name: "Casey", last_name: "Cosigner", email: C }, invited_at: clock.now() }, args: { role: "co_borrower", contact: { first_name: "Casey", last_name: "Cosigner", email: C }, legal_name: "Casey Cosigner" } }, tokA);
  assert.equal(r.status, 201, JSON.stringify(r.body)); const out = r.body["result"] as Rec; const partyC = String(out["party_id"]); second.partyC = partyC; assert.equal(out["role"], "co_borrower");
  await settle();
  // the invitee's own rows: parties, application_borrowers, conversations, a deep link — and 21.1's borrower row arming SM_O21_JOINT_INTENT_GATE
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM application_borrowers WHERE application_id = $1 AND party_id = $2 AND borrower_role = 'co_borrower'`, [j.appId, partyC]))[0]!.n, "1");
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM conversations WHERE party_id = $1`, [partyC]))[0]!.n, "1");
  assert.equal(Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM deep_links WHERE party_id = $1`, [partyC]))[0]!.n) >= 1, true);
  const added = (await events(j.appId, "application.borrower.added")).at(-1)!; assert.equal(added.payload["joint_intent_required"], true); assert.equal(added.payload["role"], "co_borrower");
  const intake = (await entity("applications", j.appId))!; const casey = (intake["borrowers"] as Rec[]).find((b) => b["legal_name"] === "Casey Cosigner")!; assert.ok(casey); assert.equal(casey["joint_intent_affirmed_at"], null);
  assert.equal((await timer(j.appId, "SM_O21_JOINT_INTENT_GATE"))?.status, "armed");
  assert.ok(((await record(A, j.appId))["people"] as Rec[]).some((p) => p["display_name"] === "Casey" && p["role"] === "co_borrower" && p["waiting"] === true), "People: Casey — invited, waiting");
  // joint intent FIRST: the invitee's thread holds the ConsentCard{joint_intent} and no credit card
  const cardsC = await cardsOf(j.appId, partyC);
  const ji = cardsC.find((c) => c.kind === "ConsentCard" && c.props["consent_kind"] === "joint_intent")!; assert.ok(ji, "ConsentCard{joint_intent}"); assert.equal(ji.status, "pending"); assert.equal(ji.command_ref, "application.affirmJointIntent"); assert.equal(ji.copy_key, "consent.joint_intent.title"); assert.deepEqual(ji.props["copy_tokens"], { other_first_name: "Alex" }); assert.equal(ji.props["requires_typed_name"], true);
  assert.equal(cardsC.filter((c) => c.command_ref === "credit.authorize" || c.copy_key === "consent.credit.title").length, 0, "no credit card before joint intent");
  // Casey signs in with their own code and asks for credit: refused with the gate until they affirm — the API answers {code, gate, copy_key}
  clock.set(MST("2026-10-05", "11:40")); const sC = await signIn(C); assert.equal(sC.party_id, partyC, "the code links the invitee to their own party"); const tokC = sC.token;
  const early = await api("POST", "/v1/borrower/commands/credit.authorize", { kind: "soft_pull", lead_id: j.leadId, text_hash: `sha256:credit-${j.R}`, subject: { application_id: j.appId } }, tokC);
  assert.equal(early.status, 409, JSON.stringify(early.body)); assert.equal(early.body["code"], "SM_O21_JOINT_INTENT_GATE"); assert.equal(early.body["gate"], "SM_O21_JOINT_INTENT_GATE"); assert.equal(early.body["copy_key"], "gate.joint_intent.each_borrower");
  assert.equal((await events(j.appId, "credit.authorization.captured")).length, 0);
  // the same gate on the bus itself (32.2's guardrail with the API's facts) — refused whoever issues the command
  const bus = await j.call("POST", `/v1/applications/${j.appId}/tools/32.2/credit.authorize`, { actor: { kind: "agent", id: "borrower-app" }, input: { kind: "soft_pull", lead_id: j.leadId, text_hash: `sha256:credit-${j.R}`, party_id: partyC, assurance_level: "L2", joint_intent_required: true, joint_intent_affirmed: false } });
  assert.notEqual(bus.status, 200); assert.match(JSON.stringify(bus.body), /SM_O21_JOINT_INTENT_GATE/);
  // Casey affirms on their own card (checkbox + typed name): 21.1's affirmation for B3; the gate no longer answers
  clock.set(MST("2026-10-05", "11:44"));
  const aff = await api("POST", `/v1/borrower/cards/${ji.card_instance_id}/resolve`, { option_id: "affirm", evidence: { consent_kind: "joint_intent", method: "checkbox_with_text", typed_name: "Casey Cosigner", checked: true, affirmed_at: clock.now() } }, tokC);
  assert.equal(aff.status, 201, JSON.stringify(aff.body)); assert.equal(aff.body["command"], "application.affirmJointIntent");
  const affirmed = (await events(j.appId, "application.joint_intent.affirmed")).at(-1)!; assert.equal(affirmed.payload["borrower_id"], casey["id"]); assert.equal(affirmed.payload["method"], "web_checkbox");
  assert.ok(((await entity("applications", j.appId))!["borrowers"] as Rec[]).find((b) => b["legal_name"] === "Casey Cosigner")!["joint_intent_affirmed_at"]);
  const later = await api("POST", "/v1/borrower/commands/credit.authorize", { kind: "soft_pull", lead_id: j.leadId, text_hash: `sha256:credit-${j.R}`, subject: { application_id: j.appId } }, tokC);
  assert.notEqual(later.body["code"], "SM_O21_JOINT_INTENT_GATE", JSON.stringify(later.body)); assert.notEqual(later.body["gate"], "SM_O21_JOINT_INTENT_GATE");
  // then R2–R6 for themselves
  await settle(); const after = await cardsOf(j.appId, partyC);
  for (const [kind, key] of [["ConnectCard", "income.connect.purpose"], ["ConfirmCard", "credit.liabilities.confirm"], ["ProfileCard", "profile.title"], ["ChoiceCard", "declarations.occupancy"], ["DemographicsCard", "demographics.title"]] as const) assert.ok(after.some((c) => c.kind === kind && c.copy_key === key && c.status === "pending"), `${kind} ${key} for the invitee`);   // R5 opens with 5a.A (32.3 R5); the list follows the invitee's own tap (T13)
  assert.ok(Date.parse(ji.created_at) <= Math.min(...after.filter((c) => ["ProfileCard", "DemographicsCard"].includes(c.kind)).map((c) => Date.parse(c.created_at))), "joint intent came first");
});

test("32.5-T8: Given a non-borrowing spouse party, then no `ProfileCard`, `DemographicsCard`, income or liability card is ever created for that party.", { skip }, async () => {
  const j = second.j!; const { A, partyA, partyC } = second; const S = `sam-${j.R}@example.test`;
  // Alex invites Sam as the non-borrowing spouse (Arizona: signs the security instrument only — 21.1 rule 4 / §1002.7(d)(4))
  clock.set(MST("2026-10-05", "12:10"));
  const invite = await j.tool({ app: j.appId }, "32.1", "send_card", { party_id: partyA, kind: "InviteCard", copy_key: "coborrower.invite", command_ref: "application.inviteParty", subject: { application_id: j.appId }, props: { party_role: "non_borrowing_spouse", title: "", contact_fields: ["first_name", "last_name", "email"], copy_tokens: { first_name: "Sam" } } }, INTAKE);
  const tokA = (await signIn(A)).token;
  const r = await api("POST", `/v1/borrower/cards/${invite.output["card_instance_id"]}/resolve`, { option_id: "invite", evidence: { party_role: "non_borrowing_spouse", contact: { first_name: "Sam", last_name: "Spouse", email: S }, invited_at: clock.now() }, args: { role: "non_borrowing_spouse", contact: { first_name: "Sam", last_name: "Spouse", email: S }, legal_name: "Sam Spouse" } }, tokA);
  assert.equal(r.status, 201, JSON.stringify(r.body)); const partyS = String((r.body["result"] as Rec)["party_id"]);
  await settle();
  assert.equal((await db.query<{ role: string }>(`SELECT borrower_role AS role FROM application_borrowers WHERE application_id = $1 AND party_id = $2`, [j.appId, partyS]))[0]?.role, "non_borrowing_spouse");
  const spouse = ((await entity("applications", j.appId))!["borrowers"] as Rec[]).find((b) => b["legal_name"] === "Sam Spouse");
  if (spouse) { assert.equal(spouse["credit_requested"], false); assert.equal(spouse["borrower_role"], "non_borrowing_spouse"); }
  assert.ok(!(await events(j.appId, "application.borrower.added")).some((e) => e.payload["role"] === "non_borrowing_spouse" && e.payload["joint_intent_required"] === true), "a security-instrument signer never arms SM_O21_JOINT_INTENT_GATE");
  // Sam signs in: their thread carries no credit question of any kind — now, and after the co-borrower's own cards were issued
  clock.set(MST("2026-10-05", "12:30")); const sS = await signIn(S); assert.equal(sS.party_id, partyS);
  await settle();
  const forbidden = (c: CardRow): boolean => c.kind === "ProfileCard" || c.kind === "DemographicsCard" || (c.kind === "ConnectCard" && c.props["vendor"] === "truv_income") || (c.kind === "ConfirmCard" && (c.copy_key === "credit.liabilities.confirm" || c.copy_key === "income.confirm.title")) || (c.kind === "ConsentCard" && (c.props["consent_kind"] === "joint_intent" || c.props["consent_kind"] === "credit_authorization")) || c.command_ref === "credit.authorize";
  const cardsS = await cardsOf(j.appId, partyS);
  assert.deepEqual(cardsS.filter(forbidden).map((c) => `${c.kind}:${c.copy_key}`), [], "no ProfileCard, DemographicsCard, income or liability card for the spouse");
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM card_instances WHERE party_id = $1 AND kind IN ('ProfileCard', 'DemographicsCard')`, [partyS]))[0]!.n, "0");
  // the contrast on the same application: the co-borrower's thread has each of them
  const cardsC = await cardsOf(j.appId, partyC);
  assert.ok(cardsC.some((c) => c.kind === "ProfileCard") && cardsC.some((c) => c.kind === "DemographicsCard") && cardsC.some((c) => c.kind === "ConnectCard" && c.props["vendor"] === "truv_income") && cardsC.some((c) => c.kind === "ConfirmCard" && c.copy_key === "credit.liabilities.confirm"));
  const people = (await record(A, j.appId))["people"] as Rec[]; assert.ok(people.some((p) => p["display_name"] === "Sam" && p["role"] === "non_borrowing_spouse"));
});

// ═══════════════════════════════════ App L: one LE, two consumers, two channels (T9)
test("32.5-T9: Given borrower A has active E-SIGN and borrower B does not, then the LE is electronic to A (`DocumentCard`) and mailed to B; the Record shows both statuses; the LE timer is satisfied by the mailing to B.", { skip }, async () => {
  const { j, A, B, partyA, partyB } = await openApp();
  assert.equal((await timer(j.appId, "REGZ_1026_19E1_LE_3BD"))?.status, "armed", "the 3-business-day clock from application.trid_received");
  // Mon Oct 5, 16:10 MST: the MLO-approved LE issued to both consumers — electronically to Alex (active E-SIGN), by print/mail to Blake (no consent; the vendor's mailing proof)
  const render = (j as unknown as { LE_RENDER(): Rec }).LE_RENDER(); clock.set(MST("2026-10-05", "16:10"));
  const r = await j.call("POST", `/v1/applications/${j.appId}/disclosures/le`, { actor: { kind: "human", id: "u-mlo-rivera", role: "mlo_of_record" }, render, mlo: { review_id: `MR-LE-${j.R}`, nmlsr_id: "987654" },
    delivery: { channel: "mail", at: MST("2026-10-05", "16:10"), deliveries: [{ borrower_id: "B1", channel: "esign_portal", consent: ESIGN(j.R) }, { borrower_id: "B2", channel: "mail", mailing_proof_id: `PRINT-${j.R}` }] } });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body["status"], "mailed", "the mailed delivery governs the one LE's receipt presumption");
  const leId = `LE-${j.appId.slice(0, 8)}`;
  const delivered = await events(j.appId, "disclosure.le.delivered"); assert.equal(delivered.length, 1); assert.equal(delivered[0]!.payload["borrower_id"], "B1"); assert.equal(delivered[0]!.payload["channel"], "esign_portal"); assert.equal(delivered[0]!.payload["esign_consent_id"], `CNS-ESIGN-${j.R}`);
  const mailed = await events(j.appId, "disclosure.le.mailed"); assert.equal(mailed.length, 1); assert.equal(mailed[0]!.payload["borrower_id"], "B2"); assert.equal(mailed[0]!.payload["mailing_proof_id"], `PRINT-${j.R}`);
  // the LE timer: satisfied by the issuance the mailing to B completed (7.4 rule 4: mail to the non-consenting party satisfies it)
  const t = (await timer(j.appId, "REGZ_1026_19E1_LE_3BD"))!; assert.equal(t.status, "satisfied"); assert.ok(t.satisfied_by_event_id);
  const issued = (await events(j.appId, "disclosure.le.issued")).find((e) => e.id === t.satisfied_by_event_id)!; assert.ok(issued, "satisfied by disclosure.le.issued");
  assert.equal(issued.payload["completed_by_borrower_id"], "B2"); assert.equal(issued.payload["completed_by_channel"], "mail"); assert.equal(issued.payload["channel"], "mail"); assert.deepEqual(issued.payload["per_borrower"], [{ borrower_id: "B1", channel: "esign_portal" }, { borrower_id: "B2", channel: "mail" }]);
  assert.equal((await timer(j.appId, "REGZ_1026_19E1IV_LE_MAILBOX_3SBD"))?.status, "armed", "the mailbox presumption runs from the mailing");
  await settle();
  // the cards: the DocumentCard (electronic) to A only; B gets the mailed StatusCard and the E-SIGN re-offer, never the electronic document
  const cardsA = await cardsOf(j.appId, partyA); const cardsB = await cardsOf(j.appId, partyB);
  const docA = cardsA.find((c) => c.kind === "DocumentCard" && c.props["disclosure_id"] === leId)!; assert.ok(docA, "A's LE DocumentCard"); assert.equal(docA.copy_key, "le.delivered"); assert.equal(docA.props["requires_ack"], true); assert.equal(docA.props["channel"], "esign_portal"); assert.equal(docA.status, "pending");
  assert.equal(cardsB.filter((c) => c.kind === "DocumentCard").length, 0, "no electronic document to the party without E-SIGN");
  assert.ok(cardsB.some((c) => c.copy_key === "le.mailed" && c.kind === "StatusCard")); assert.ok(cardsB.some((c) => c.kind === "ConsentCard" && c.props["consent_kind"] === "esign" && c.status === "pending"), "the E-SIGN ConsentCard re-offered to B");
  assert.equal(cardsA.filter((c) => c.copy_key === "le.mailed").length, 0);
  // the Record shows both statuses on the one document, for either party
  for (const [email, who] of [[A, "A"], [B, "B"]] as const) {
    const docs = (await record(email, j.appId))["documents"] as Rec[]; const le = docs.find((d) => d["disclosure_id"] === leId && d["kind"] === "disclosure:le")!; assert.ok(le, `${who}: the LE row`);
    const deliveries = le["deliveries"] as Rec[]; assert.equal(deliveries.length, 2, `${who}: both consumers' statuses`);
    assert.deepEqual(deliveries.map((d) => [d["borrower_id"], d["channel"], d["status"], d["display_name"]]), [["B1", "esign_portal", "delivered", "Alex"], ["B2", "mail", "mailed", "Blake"]]);
    assert.equal(le["status"], "mailed"); assert.equal(le["mailed_at"], MST("2026-10-05", "16:10")); assert.equal(le["delivered_at"], MST("2026-10-05", "16:10"));
  }
});

// ═══════════════════════════════════ App Z: nothing needed (T11)
test("32.5-T11: Given zero `owner=you` items, then the Record shows the nothing-needed state and the status strip count is 0.", { skip }, async () => {
  const R = randomUUID().slice(0, 8); const A = `alex-${R}@example.test`; const B = `blake-${R}@example.test`;
  const j = new Journey({ runtime, db, base, token: TOKEN, clock, borrowerEmail: A, coBorrowerEmail: B, partnerPartyId });
  await j.seedBook(); await j.openApplication(); await j.interview();   // an application received with no ask outstanding — nothing was put in front of the borrower before their first sign-in
  clock.set(MST("2026-10-05", "10:50"));
  const partyA = (await signIn(A)).party_id; await settle();
  const rec = await record(A, j.appId);
  assert.deepEqual(rec["needed_from_you"], [], JSON.stringify(rec["needed_from_you"]).slice(0, 400));
  assert.deepEqual(rec["needed_summary"], { count: 0, nothing_needed: true, copy_key: "needs.none" }, "the nothing-needed state: `needs.none` — \"Nothing needed from you. We'll message you when something is.\"");
  assert.equal((rec["needed_from_you"] as Rec[]).filter((x) => x["owner"] === "you").length, 0, "count(owner=you) — the status strip's number — is 0");
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM card_instances WHERE party_id = $1 AND kind = 'ChecklistCard' AND status = 'pending'`, [partyA]))[0]!.n, "0", "no checklist is pinned when there is nothing to list");
  const t = await thread(A); assert.notEqual(t.pinned?.["kind"], "ChecklistCard");
  // the strip renders `needed_from_you.length` and the section renders `needs.none` for an empty list — asserted on the real components in apps/borrower/tests/cards/flow-5-verification.test.tsx
});

// Phase 7 amendments (the Homestead DU handoff): scaffolded as todo; implement by replacing each line with the real test (never edit the name)
test("32.5-T12: Given two borrowers on one application each connect the FAKE Plaid report that names the same account (equal institution, subtype and last four), then after the second pull exactly one live `du_assets` row exists for the account with two `du_asset_parties` arcs (one per borrower) and the other row is retired with `retired_by_verification_id` = the second pull's verification, the Record's assets show the account once, and the graph 23.6 reads carries one `ASSET` container for it with two owner arcs — 22.4's reconciliation, not the emitter, does the merging.", { skip }, async () => {
  const { j, A, partyA } = await openApp(); const C = `casey-${j.R}@example.test`;
  const ASSETS_CARD = { kind: "ConnectCard", copy_key: "assets.connect.purpose", props: { vendor: "plaid_assets", purpose_text: "", what_we_get: ["balances", "twelve months of deposits"], fallback: { label: "Send two months of statements per account instead", document_class: "bank_statement" }, state: "not_started", pre_intent_optional: true, vendor_fake: "FAKE" } };
  const plaid = async (token: string, card: CardRow): Promise<Rec> => { const s = await api("POST", "/v1/borrower/connect/plaid_assets/session", { card_instance_id: card.card_instance_id, fake_complete: true }, token); assert.equal(s.status, 200, JSON.stringify(s.body)); assert.equal(s.body["outcome"], "connected"); assert.equal(s.body["delivery"], "FAKE"); await settle(); return s.body; };
  const assetsCardOf = async (partyId: string): Promise<CardRow | undefined> => (await cardsOf(j.appId, partyId)).filter((c) => c.kind === "ConnectCard" && c.props["vendor"] === "plaid_assets" && c.status === "pending").at(-1);
  // Alex: the interview's borrower — the assets ConnectCard 3-entry sends with the connectors (this journey drives 21.1 directly, so the intake agent puts the same card in front of Alex here)
  clock.set(MST("2026-10-05", "12:30")); const tokA = (await signIn(A)).token;
  if (!(await assetsCardOf(partyA))) await j.tool({ app: j.appId }, "32.1", "send_card", { party_id: partyA, ...ASSETS_CARD, subject: { application_id: j.appId } }, INTAKE);
  // Casey: invited by Alex, affirms joint intent on their own card (T7's path) — then their own R2–R6 cards AND their own assets ConnectCard (32.5 §7 as amended: `cob.assets`)
  const invite = await j.tool({ app: j.appId }, "32.1", "send_card", { party_id: partyA, kind: "InviteCard", copy_key: "coborrower.invite", command_ref: "application.inviteParty", subject: { application_id: j.appId }, props: { party_role: "co_borrower", title: "", contact_fields: ["first_name", "last_name", "email"], copy_tokens: { first_name: "Casey" } } }, INTAKE);
  const inv = await api("POST", `/v1/borrower/cards/${invite.output["card_instance_id"]}/resolve`, { option_id: "invite", evidence: { party_role: "co_borrower", contact: { first_name: "Casey", last_name: "Cosigner", email: C }, invited_at: clock.now() }, args: { role: "co_borrower", contact: { first_name: "Casey", last_name: "Cosigner", email: C }, legal_name: "Casey Cosigner" } }, tokA);
  assert.equal(inv.status, 201, JSON.stringify(inv.body)); const partyC = String((inv.body["result"] as Rec)["party_id"]); await settle();
  clock.set(MST("2026-10-05", "12:34")); const sC = await signIn(C); assert.equal(sC.party_id, partyC); const tokC = sC.token;
  const ji = (await cardsOf(j.appId, partyC)).find((c) => c.kind === "ConsentCard" && c.props["consent_kind"] === "joint_intent")!; assert.ok(ji, "ConsentCard{joint_intent}");
  const aff = await api("POST", `/v1/borrower/cards/${ji.card_instance_id}/resolve`, { option_id: "affirm", evidence: { consent_kind: "joint_intent", method: "checkbox_with_text", typed_name: "Casey Cosigner", checked: true, affirmed_at: clock.now() } }, tokC); assert.equal(aff.status, 201, JSON.stringify(aff.body)); await settle();
  const cardC = (await assetsCardOf(partyC))!; assert.ok(cardC, "the invitee's own ConnectCard{plaid_assets}"); assert.equal(cardC.copy_key, "assets.connect.purpose"); assert.equal(cardC.props["vendor_fake"], "FAKE"); assert.equal(cardC.command_ref, null, "no command of its own: the vendor's settlement resolves it");
  assert.equal(cardC.props["flow_key"], `cob.assets:${partyC}`, "flow_key cob.assets:<party_id>");
  const abA = (await db.query<{ id: string }>(`SELECT id::text AS id FROM application_borrowers WHERE application_id = $1 AND party_id = $2`, [j.appId, partyA]))[0]!.id;
  const abC = (await db.query<{ id: string }>(`SELECT id::text AS id FROM application_borrowers WHERE application_id = $1 AND party_id = $2`, [j.appId, partyC]))[0]!.id;
  // the first pull (Alex): one du_assets row per FAKE account, Alex the one owner — nothing to reconcile yet
  const cardA = (await assetsCardOf(partyA))!; const first = await plaid(tokA, cardA);
  type AssetRow = { id: string; institution_name: string; asset_type: string; account_last4: string; retired_at: string | null; retired_by_verification_id: string | null; owners: string[] };
  const rowsOf = () => db.query<AssetRow>(`SELECT a.id::text AS id, a.institution_name, a.asset_type, a.account_last4, a.retired_at::text AS retired_at, a.retired_by_verification_id::text AS retired_by_verification_id, coalesce(array_agg(p.application_borrower_id::text ORDER BY p.created_at) FILTER (WHERE p.id IS NOT NULL), '{}') AS owners FROM du_assets a LEFT JOIN du_asset_parties p ON p.asset_id = a.id WHERE a.application_id = $1 GROUP BY a.id ORDER BY a.created_at, a.id`, [j.appId]);
  const afterFirst = await rowsOf(); assert.equal(afterFirst.length, FAKE_ASSET_ACCOUNTS.length); for (const r of afterFirst) { assert.deepEqual(r.owners, [abA]); assert.equal(r.retired_at, null); }
  const firstIds = new Map(afterFirst.map((r) => [r.account_last4, r.id]));
  // the second pull (Casey): the same FAKE accounts under Casey's own prefix — two rows per account for a moment, then 22.4's reconciliation in the same transaction: Alex's row survives with Casey's arc, Casey's row is retired by Casey's pull
  clock.set(MST("2026-10-05", "12:40")); const second = await plaid(tokC, cardC);
  const secondVerificationId = String(second["verification_id"]); assert.ok(secondVerificationId.startsWith(`${j.appId}:${abC}:assets:`), `the pull is the invitee's own: ${secondVerificationId}`); assert.notEqual(secondVerificationId, first["verification_id"]);
  const secondRow = deterministicUuid("verifications", secondVerificationId);
  assert.equal((await db.query<{ borrower_id: string }>(`SELECT borrower_id::text AS borrower_id FROM verifications WHERE verification_id = $1`, [secondRow]))[0]?.borrower_id, abC, "the verifications row names the invitee");
  const all = await rowsOf(); assert.equal(all.length, 2 * FAKE_ASSET_ACCOUNTS.length, "the retired rows stay (never deleted)");
  for (const acct of FAKE_ASSET_ACCOUNTS) {
    const twins = all.filter((r) => r.account_last4 === acct.last4 && r.institution_name === acct.institution); assert.equal(twins.length, 2, acct.last4);
    const live = twins.filter((r) => r.retired_at === null); assert.equal(live.length, 1, `exactly one live du_assets row for ····${acct.last4}`);
    assert.equal(live[0]!.id, firstIds.get(acct.last4), "the earlier-created row survives"); assert.deepEqual([...live[0]!.owners].sort(), [abA, abC].sort(), "two du_asset_parties arcs, one per borrower");
    const retired = twins.find((r) => r.retired_at !== null)!; assert.deepEqual(retired.owners, [abC]); assert.equal(retired.retired_by_verification_id, secondRow, "retired by the second pull's verification");
  }
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM du_assets WHERE application_id = $1 AND retired_at IS NULL AND last_seen_verification_id = $2`, [j.appId, secondRow]))[0]!.n, String(FAKE_ASSET_ACCOUNTS.length), "the survivors were last seen by the second pull");
  // the merge went through 23.5's own arc writer: du.graph.owner.linked per account, citing the receive — and the arc was added in the receive's transaction (23.5 rule 1 judged the set at COMMIT)
  const linked = (await events(j.appId, "du.graph.owner.linked")).filter((e) => e.payload["application_borrower_id"] === abC && e.payload["kind"] === "asset");
  assert.deepEqual(linked.map((e) => e.payload["row_id"]).sort(), [...firstIds.values()].sort()); for (const e of linked) assert.equal(e.payload["cites_decision_id"], `verification.received:${secondVerificationId}`);
  // the Record's assets (its `accounts` list — never an `assets` key, 32.13 T6): each account once, for either borrower, marked joint — the projection reads live rows only
  for (const [email, ab] of [[A, abA], [C, abC]] as const) {
    const rec = await record(email, j.appId); const mine = rec["accounts"] as Rec[]; assert.equal(rec["assets"], undefined, "no `assets` key on the Record");
    assert.deepEqual(mine.map((x) => [x["account_last4"], x["kind"], x["joint"], x["verified"]]).sort(), FAKE_ASSET_ACCOUNTS.map((a) => [a.last4, a.account_type, true, true]).sort(), `${ab}: ${JSON.stringify(mine)}`);
    assert.deepEqual(mine.map((x) => x["asset_id"]).sort(), [...firstIds.values()].sort()); for (const x of mine) assert.equal(x["balance_cents"], undefined, "no balance on the Record (32.5 §4)");
  }
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM application_assets WHERE application_id = $1`, [j.appId]))[0]!.n, String(FAKE_ASSET_ACCOUNTS.length), "0134's projection shows each account once");
  // the graph as 23.5 reads it and as 23.6 loads it: one ASSET container per account with two ASSET_IsAssociatedWith_ROLE arcs — the emitter merged nothing
  const graph = await readDuGraph(db, j.appId); assert.equal(graph.assets.length, FAKE_ASSET_ACCOUNTS.length); for (const a of graph.assets) assert.deepEqual(a.owners.map((o) => o.application_borrower_id).sort(), [abA, abC].sort());
  const loaded = await loadGraph(db, j.appId); const containers = loaded.containers.filter((c) => c.kind === "ASSET"); assert.equal(containers.length, FAKE_ASSET_ACCOUNTS.length);
  for (const c of containers) assert.deepEqual(loaded.arcs.filter((a) => a.arcrole === "ASSET_IsAssociatedWith_ROLE" && a.from === c.id).map((a) => a.to).sort(), [`role:${abA}`, `role:${abC}`].sort(), `two owner arcs on ${c.id}`);
  assert.equal(loaded.arcs.filter((a) => a.arcrole === "ASSET_IsAssociatedWith_ROLE").length, 2 * FAKE_ASSET_ACCOUNTS.length);
  // the merge holds across a re-pull (23.5 rule 5 is an invariant, not a one-shot): Casey pulls a third time — writeDuAsset matches Casey's retired row under Casey's own key and revives it
  // (writer.ts revision: "an account reported again is live again"), and 22.4's reconciliation retires it again in the same transaction in favour of the survivor, which already carries Casey's arc —
  // never "one borrower holds two live rows", never a second live twin for 23.7's DU_PREFLIGHT_DUPLICATE_ASSET
  clock.set(MST("2026-10-05", "12:50")); await j.tool({ app: j.appId }, "32.1", "send_card", { party_id: partyC, ...ASSETS_CARD, props: { ...ASSETS_CARD.props, flow_key: `cob.assets:${partyC}:again` }, subject: { application_id: j.appId } }, INTAKE);
  const cardC2 = (await assetsCardOf(partyC))!; assert.ok(cardC2, "a fresh assets card for Casey's re-pull"); const third = await plaid(tokC, cardC2);
  const thirdVerificationId = String(third["verification_id"]); assert.notEqual(thirdVerificationId, secondVerificationId); const thirdRow = deterministicUuid("verifications", thirdVerificationId);
  const afterThird = await rowsOf(); assert.equal(afterThird.length, 2 * FAKE_ASSET_ACCOUNTS.length, "no new row: the re-pull matched Casey's own row");
  for (const acct of FAKE_ASSET_ACCOUNTS) {
    const twins = afterThird.filter((r) => r.account_last4 === acct.last4 && r.institution_name === acct.institution); const live = twins.filter((r) => r.retired_at === null);
    assert.equal(live.length, 1, `exactly one live du_assets row for ····${acct.last4} after the third pull`); assert.equal(live[0]!.id, firstIds.get(acct.last4), "the survivor is still the earliest row"); assert.deepEqual([...live[0]!.owners].sort(), [abA, abC].sort());
    const retired = twins.find((r) => r.retired_at !== null)!; assert.deepEqual(retired.owners, [abC]); assert.equal(retired.retired_by_verification_id, thirdRow, "retired again, by the third pull's verification");
  }
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM du_assets WHERE application_id = $1 AND retired_at IS NULL AND last_seen_verification_id = $2`, [j.appId, thirdRow]))[0]!.n, String(FAKE_ASSET_ACCOUNTS.length), "the survivors were last seen by the third pull");
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM application_assets WHERE application_id = $1`, [j.appId]))[0]!.n, String(FAKE_ASSET_ACCOUNTS.length), "0134's projection still shows each account once");
  assert.equal((await readDuGraph(db, j.appId)).assets.length, FAKE_ASSET_ACCOUNTS.length, "one ASSET per account for 23.6");
});
test("32.5-T13: Given an invited co-borrower who affirmed joint intent, then their own declarations card runs the fourteen-question sequence of 32.3 R5 (`cob.declarations`), a tap on it from the inviter's session is refused (`PARTY_SCOPE`), and the invitee's last tap writes their `du_declarations` row with `asserted_by_actor` = the invitee's own session while the inviter's row is untouched.", { skip }, async () => {
  const j = second.j!; const { A, C, partyA, partyC } = second; assert.ok(j && partyC, "T7's invitee (Casey) on Alex's application");
  clock.set(MST("2026-10-05", "13:30"));
  // the invitee's own R5 opens with 5a.A under the cob.declarations prefix (32.3 R5's sequence — the list, SQ-05 on "Something applies"); no command on that card
  const occ = (await cardsOf(j.appId, partyC)).find((c) => c.copy_key === "declarations.occupancy" && c.status === "pending")!; assert.ok(occ, "the invitee's own 5a.A card"); assert.equal(occ.kind, "ChoiceCard"); assert.equal(occ.props["flow_key"], `cob.declarations.occupancy:${partyC}`); assert.equal(occ.command_ref, null);
  assert.deepEqual((occ.props["options"] as { id: string }[]).map((o) => o.id), ["yes_no_prior", "yes_prior", "no"]);
  const abC = (await db.query<{ id: string }>(`SELECT id FROM application_borrowers WHERE application_id = $1 AND party_id = $2`, [j.appId, partyC]))[0]!.id;
  const abA = (await db.query<{ id: string }>(`SELECT id FROM application_borrowers WHERE application_id = $1 AND party_id = $2`, [j.appId, partyA]))[0]!.id;
  const rowsA = () => db.query<Record<string, unknown>>(`SELECT id, asserted_by_actor, asserted_at::text AS asserted_at, intent_to_occupy, property_proposed_clean_energy_lien FROM du_declarations WHERE application_borrower_id = $1`, [abA]);
  // the inviter's own row first (their own sequence, their own session — 5a.A, 5a.E, None), so "untouched" below compares against a row that exists
  const tokA0 = (await signIn(A)).token;
  const abAIntake = ((await entity("applications", j.appId))!["borrowers"] as Rec[]).find((b) => b["legal_name"] !== "Casey Cosigner" && b["legal_name"] !== "Sam Cosigner")?.["id"] as string | undefined;
  if (!(await cardsOf(j.appId, partyA)).some((c) => c.copy_key === "declarations.occupancy" && c.status === "pending")) await j.tool({ app: j.appId }, "32.1", "send_card", { party_id: partyA, ...firstDeclarationsCard({ prefix: "declarations", key: abA, borrower_id: abAIntake ?? "B1" }), subject: { application_id: j.appId } }, INTAKE);
  const tapA = async (key: string, option: string): Promise<Reply> => { const card = (await cardsOf(j.appId, partyA)).filter((x) => x.copy_key === key && x.status === "pending").at(-1)!; assert.ok(card, `pending ${key} for the inviter`); assert.equal(String(card.props["flow_key"]).startsWith("declarations."), true, "the inviter's own prefix"); const r = await api("POST", `/v1/borrower/cards/${card.card_instance_id}/resolve`, { option_id: option, evidence: { option_id: option, tapped_at: clock.now() } }, tokA0); assert.equal(r.status, 201, `${key}: ${JSON.stringify(r.body)}`); await settle(); return r; };
  await tapA("declarations.occupancy", "yes_no_prior"); await tapA("declarations.clean_energy_lien", "no"); const aNone = await tapA("declarations.title", "none"); assert.equal(aNone.body["command"], "application.answerDeclarations");
  const inviterBefore = await rowsA(); assert.equal(inviterBefore.length, 1, "the inviter's own du_declarations row, before the invitee taps anything"); assert.deepEqual(inviterBefore[0]!["asserted_by_actor"], { kind: "human", id: partyA, role: "borrower" });
  // the inviter's session tapping the invitee's card: refused before anything runs (PARTY_SCOPE); the card stays pending, no row exists
  const tokA = (await signIn(A)).token;
  const wrong = await api("POST", `/v1/borrower/cards/${occ.card_instance_id}/resolve`, { option_id: "yes_no_prior", evidence: { option_id: "yes_no_prior", tapped_at: clock.now() } }, tokA);
  assert.equal(wrong.status, 403, JSON.stringify(wrong.body)); assert.equal(wrong.body["code"], "PARTY_SCOPE");
  await settle(); assert.equal(((await cardsOf(j.appId, partyC)).find((c) => c.card_instance_id === occ.card_instance_id))!.status, "pending");
  assert.equal((await db.query(`SELECT 1 FROM du_declarations WHERE application_borrower_id = $1`, [abC])).length, 0, "nothing asserted for the invitee by the inviter");
  // the invitee's own session: 5a.A (no command), then the list — "None" runs application.answerDeclarations once as the invitee's own actor
  clock.set(MST("2026-10-05", "13:32")); const tokC = (await signIn(C)).token;
  const tap = async (key: string, option: string): Promise<{ card: CardRow; r: Reply }> => {
    const card = (await cardsOf(j.appId, partyC)).filter((x) => x.copy_key === key && x.status === "pending").at(-1)!; assert.ok(card, `pending ${key} for the invitee`);
    const r = await api("POST", `/v1/borrower/cards/${card.card_instance_id}/resolve`, { option_id: option, evidence: { option_id: option, tapped_at: clock.now() } }, tokC); assert.equal(r.status, 201, `${key}: ${JSON.stringify(r.body)}`); await settle(); return { card, r };
  };
  const o = await tap("declarations.occupancy", "yes_no_prior"); assert.equal(o.r.body["command"], null); assert.deepEqual(o.r.body["events"], []);
  const e = await tap("declarations.clean_energy_lien", "no"); assert.equal(e.r.body["command"], null); assert.equal(e.card.props["flow_key"], `cob.declarations.clean_energy_lien:${partyC}`);
  // "Something here applies" → SQ-05 under the cob prefix: the thirteen listed items one ChoiceCard at a time, every card before the last without a command, the last tap the one command
  const l = await tap("declarations.title", "some"); assert.deepEqual(l.r.body["events"], [], "no command on Something applies (the response echoes the card's command_ref; nothing ran)"); assert.equal(l.card.props["flow_key"], `cob.declarations.list:${partyC}`); assert.equal((l.card.props["list"] as string[]).length, 13); assert.deepEqual(l.card.props["side_quest_on"], { some: "SQ-05" });
  const none = (l.card.props["command_args_by_option"] as Record<string, Record<string, unknown>>)["none"]!; assert.equal(Object.keys(none["answers"] as Record<string, string>).length, 14, "the fourteen typed answers ride the None tap too");
  let last: { card: CardRow; r: Reply } | null = null;
  for (let n = 0; n < DECLARATIONS.length; n++) {
    const q = await tap("declarations.item", n === 10 ? "yes" : "no");   // a co-signed debt: Yes; the rest No
    assert.equal(q.card.props["flow_key"], `cob.declarations.q:${n}:${partyC}`, `question ${n + 1} under the invitee's own prefix`); assert.equal(q.card.props["item_index"], n);
    if (n < DECLARATIONS.length - 1) { assert.equal(q.card.command_ref, null); assert.deepEqual(q.r.body["events"], [], `question ${n + 1} runs nothing`); assert.equal((await db.query(`SELECT 1 FROM du_declarations WHERE application_borrower_id = $1`, [abC])).length, 0, "nothing asserted before the last tap"); }
    last = q;
  }
  assert.equal(last!.card.command_ref, "application.answerDeclarations"); assert.equal(last!.r.body["command"], "application.answerDeclarations"); assert.ok((last!.r.body["events"] as string[]).includes("application.declarations.answered"));
  const du = (await db.query<Record<string, unknown>>(`SELECT * FROM du_declarations WHERE application_borrower_id = $1`, [abC]))[0]!; assert.ok(du, "the invitee's own du_declarations row");
  assert.deepEqual(du["asserted_by_actor"], { kind: "human", id: partyC, role: "borrower" }, "asserted by the invitee's own session, never the inviter's or the app's");
  assert.equal(du["intent_to_occupy"], "Yes"); assert.equal(du["homeowner_past_three_years"], "No"); assert.equal(du["property_proposed_clean_energy_lien"], "No"); assert.equal(du["bankruptcy"], "No"); assert.equal(du["outstanding_judgments"], "No"); assert.equal(du["undisclosed_comaker_of_note"], "Yes", "the one Yes, as tapped");
  assert.deepEqual(await rowsA(), inviterBefore, "the inviter's row is untouched");
  assert.equal((await events(j.appId, "du.graph.declaration.asserted")).filter((e) => e.payload["party_id"] === partyC).length, 1);
  const cobBorrowerId = (last!.card.props["command_args_by_option"] as Record<string, Record<string, unknown>>)["no"]!["borrower_id"];
  assert.equal((await events(j.appId, "application.declarations.answered")).filter((e) => e.payload["borrower_id"] === cobBorrowerId).length, 1, "one command for the invitee's borrower");
});
