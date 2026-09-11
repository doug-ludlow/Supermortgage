/**
 * The command half of the borrower API over the real journey (docs/ux/02-data-contracts.md §2, §7; 01 §3, §5, §6.4;
 * 13 T-X-05): the 45 UX commands as `borrower-app` bus tools delegating to the owning handlers (src/app/tools/
 * section32-2.ts), card resolution with idempotency on card_instance_id, the chat-affirmative rule (a "yes proceed"
 * to a pending card executes nothing and gets the deep link), a ConsentCard never resolved by voice, the fresh-L1 rule
 * on money commands, the `{code, gate, copy_key}` refusal contract, and DELTA-07's send_card / resolve_card_by_evidence /
 * create_deep_link on the `intake` agent. Skips without a database.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { connect, reachable, type Db } from "../../infra/db/client.ts";
import { acquireJourneyLock, type TestLock } from "../../infra/db/test-lock.ts";
import { loadOverriddenRegistry } from "../../domain/timer-overrides.ts";
import { FixedClock } from "../../kernel/events/index.ts";
import { loadAgentsFile } from "../../app/agents.ts";
import { CommandRefused } from "../../app/commands.ts";
import { Runtime } from "../app.ts";
import { createApiServer, listen } from "../server.ts";
import { createLogger } from "../log.ts";
import { PgBorrowerUiRepository } from "../../infra/db/borrower-ui.ts";
import { COMMAND_NAMES, FRESH_L1_COMMANDS, affirmativeFor } from "./commands.ts";
import { DIRECT_TO_OPS } from "../../app/tools/section32-2.ts";
import { evidenceResolvable } from "../../app/tools/section32-1.ts";
import { Journey, INTAKE, MST } from "./fixtures/journey.ts";

const DB_URL = process.env["TEST_DATABASE_URL"] ?? "postgresql://sm:sm@localhost/supermortgage_test";
const up = await reachable(DB_URL);
if (!up && process.env["REQUIRE_DB"]) throw new Error(`REQUIRE_DB set but ${DB_URL} is not reachable`);
const skip = up ? false : `no Postgres at ${DB_URL}`;
const TOKEN = "ops-" + randomUUID();
const R = randomUUID().slice(0, 8);
const clock = new FixedClock("2026-09-10T16:00:00.000Z");
const EMAIL_A = `alex-${R}@example.test`; const EMAIL_B = `blake-${R}@example.test`;
const lines: string[] = [];

let journeyLock: TestLock | undefined;
let db: Db; let runtime: Runtime; let base = ""; let close: () => Promise<void> = async () => undefined; let journey: Journey; let partyA = ""; let ui: PgBorrowerUiRepository;

test.before(async () => {
  if (skip) return;
  journeyLock = await acquireJourneyLock(DB_URL);   // serialize journey-driving files on the shared test database
  execFileSync(fileURLToPath(new URL("../../../db/migrate.sh", import.meta.url)), { env: { ...process.env, DATABASE_URL: DB_URL }, stdio: "pipe" });
  db = connect(DB_URL); ui = new PgBorrowerUiRepository(db);
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger: createLogger("json", (l) => { lines.push(l); if (process.env["BORROWER_DEBUG"] && l.includes("borrower.unhandled")) process.stderr.write(l + "\n"); }), console: false, borrower: { environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost"], urlSecret: "test-secret" } });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => server.close(() => db.end().then(() => resolve())));
  const partner = await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id) VALUES ('servicer', $1, '123456789', '1000123') RETURNING id`, [`Partner Bank ${R}`]);
  journey = new Journey({ runtime, db, base, token: TOKEN, clock, borrowerEmail: EMAIL_A, coBorrowerEmail: EMAIL_B, partnerPartyId: partner[0]!.id });
  await journey.seedBook(); await journey.openApplication(); await journey.interview(); await journey.quoteAndLe();
});
test.after(async () => { if (!skip) { await close(); await journeyLock?.release(); } });

type Reply = { status: number; body: Record<string, unknown> };
async function api(method: string, path: string, body?: unknown, token?: string): Promise<Reply> {
  const r = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text(); return { status: r.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}
async function signIn(email = EMAIL_A): Promise<string> {
  const req = await api("POST", "/v1/borrower/auth/otp", { action: "request", channel: "email", destination: email });
  const ver = await api("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: req.body["challenge_id"], code: req.body["fake_code"] });
  assert.equal(ver.status, 200, JSON.stringify(ver.body)); partyA = partyA || (ver.body["party"] as { party_id: string }).party_id;
  return ver.body["token"] as string;
}
const errorShape = (b: Record<string, unknown>, code?: string): void => { if (code) assert.equal(b["code"], code, JSON.stringify(b)); assert.equal(typeof b["copy_key"], "string"); for (const k of Object.keys(b)) assert.ok(["code", "gate", "copy_key"].includes(k), `error carries only code/gate/copy_key, not ${k}`); };
const events = async (type: string, appId = journey.appId) => db.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM loan_events WHERE application_id = $1 AND type = $2 ORDER BY sequence`, [appId, type]);
const sendCard = async (kind: string, copy_key: string, command_ref: string | null, props: Record<string, unknown> = {}) => {
  const r = await runtime.execute({ process: "32.1", name: "send_card", loanId: "", applicationId: journey.appId, actor: INTAKE, input: { party_id: partyA, subject: { application_id: journey.appId }, kind, copy_key, command_ref, props } });
  return (r.output as { card_instance_id: string; message_id: string });
};

test("the 45 commands of 32.2 are on the bus as borrower-app tools, one per agents.json entry; the direct-to-ops ones are the ones BACKEND-DELTAS names", { skip }, () => {
  const spec = loadAgentsFile().processes.find((p) => p.process === "32.2")!.tools;
  assert.equal(COMMAND_NAMES.size, 45); assert.deepEqual([...COMMAND_NAMES].sort(), [...spec].sort());
  for (const n of Object.keys(DIRECT_TO_OPS)) assert.ok(COMMAND_NAMES.has(n), n);
  assert.deepEqual([...FRESH_L1_COMMANDS].filter((c) => !COMMAND_NAMES.has(c)), []);
  assert.equal(evidenceResolvable({ kind: "ConsentCard", command_ref: "consent.capture" }), false); assert.equal(evidenceResolvable({ kind: "ChoiceCard", command_ref: "intent.record" }), true); assert.equal(evidenceResolvable({ kind: "PaymentCard", command_ref: "payment.makeOneTime" }), false); assert.equal(evidenceResolvable({ kind: "ChoiceCard", command_ref: "closing.captureEsignConsent" }), false);
});

test("T-X-05 cards commit, chat doesn't: a borrower message matching the pending intent card's affirmative executes no command and is answered with the card's deep link; 'human' routes to human.request; anything else gets the assistant's placeholder", { skip }, async () => {
  clock.set(MST("2026-10-06", "09:10")); const token = await signIn();
  const card = await sendCard("ChoiceCard", "intent.title", "intent.record", { options: [{ id: "proceed", label: "Yes, proceed", is_primary: true }, { id: "wait", label: "Not yet" }], command_args_by_option: { proceed: { statement_text: "I want to proceed with this Loan Estimate" } } });
  const stored = await ui.card(card.card_instance_id); assert.equal(stored?.status, "pending"); assert.equal(stored?.created_by, "agent:intake");
  assert.ok((await ui.message(card.message_id))?.card_instance_id === card.card_instance_id, "send_card wrote the thread message that carries the card");
  assert.equal(affirmativeFor("yes proceed", [stored!])?.card_instance_id, card.card_instance_id); assert.equal(affirmativeFor("what's my rate?", [stored!]), undefined);
  for (const text of ["yes proceed", "Lock it!", "I agree", "Yes, proceed"]) {
    const r = await api("POST", "/v1/borrower/messages", { text }, token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body["command_executed"], false); assert.equal(r.body["routed_to"], "intake");
    const reply = r.body["reply"] as Record<string, unknown>; assert.equal(reply["copy_key"], "thread.card_affirmative_deep_link"); assert.equal(reply["card_instance_id"], card.card_instance_id);
    const link = reply["deep_link"] as { token: string; path: string }; assert.match(link.path, /^\/d\//); assert.match(String(reply["body_text"]), /\/d\//);
    assert.deepEqual((await api("GET", `/v1/borrower/deeplink/${link.token}`, undefined, token)).body["target"], { card_instance_id: card.card_instance_id });
  }
  assert.equal((await events("intent.to_proceed.received")).length, 0, "no command executed from chat"); assert.equal((await ui.card(card.card_instance_id))?.status, "pending");
  const other = await api("POST", "/v1/borrower/messages", { text: "What's my rate going to be?" }, token);
  assert.equal(other.status, 200); assert.equal(other.body["command_executed"], false); assert.equal((other.body["reply"] as { copy_key: string }).copy_key, "thread.assistant_placeholder.intake");
  assert.equal(((other.body["message"] as { sender: string }).sender), "borrower");
  const human = await api("POST", "/v1/borrower/messages", { text: "I'd like to talk to a human please" }, token);
  assert.equal(human.status, 200, JSON.stringify(human.body)); assert.equal(human.body["command_executed"], true); assert.equal(human.body["command"], "human.request"); assert.equal((human.body["reply"] as { copy_key: string }).copy_key, "thread.human_requested");
  assert.equal((await events("human.transfer.requested")).length, 1);
  assert.ok((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM escalations WHERE application_id = $1 AND kind = 'human_agent'`, [journey.appId])).some((r) => Number(r.n) >= 1), "the human_agent escalation opened");
  // the thread shows it all: borrower turns, the agent's replies with the card link, the card itself
  const thread = await api("GET", "/v1/borrower/thread", undefined, token); const msgs = thread.body["messages"] as { sender: string; sender_label: string; card_instance_id: string | null; card: { kind: string } | null }[];
  assert.ok(msgs.some((m) => m.sender === "agent" && m.sender_label === "Supermortgage" && m.card_instance_id === card.card_instance_id && m.card?.kind === "ChoiceCard"));
  assert.ok(msgs.some((m) => m.sender === "borrower" && m.sender_label === "Alex"));
});

test("card resolve → intent.record on the bus (21.4 recordIntent: `intent.to_proceed.received`, REGZ_1026_19E2_INTENT_FEE_GATE satisfied); evidence persisted to card_instances + card_instance_events + ui_events; a second tap is idempotent; a ConsentCard never resolves from voice", { skip }, async () => {
  clock.set(MST("2026-10-06", "09:14")); const token = await signIn();
  const card = (await ui.cardsOf(partyA, { status: "pending" })).find((c) => c.command_ref === "intent.record")!;
  const cross = await api("POST", `/v1/borrower/cards/${card.card_instance_id}/resolve`, { option_id: "proceed" }, await signIn(EMAIL_B));
  assert.equal(cross.status, 403); errorShape(cross.body, "PARTY_SCOPE");
  const r = await api("POST", `/v1/borrower/cards/${card.card_instance_id}/resolve`, { option_id: "proceed", evidence: { disclosure_version_shown: "LE-v1" } }, token);
  assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body["idempotent"], false); assert.equal(r.body["command"], "intent.record");
  assert.ok((r.body["events"] as string[]).includes("intent.to_proceed.received"), JSON.stringify(r.body["events"]));
  const result = r.body["result"] as Record<string, unknown>; assert.equal(result["command"], "intent.record"); assert.equal(result["valid"], true); assert.equal(result["le_effective_receipt_date"], "2026-10-05");
  const resolved = await ui.card(card.card_instance_id); assert.equal(resolved?.status, "resolved"); assert.equal(resolved?.resolved_at, MST("2026-10-06", "09:14"));
  const ev = resolved!.evidence as Record<string, unknown>; assert.equal(ev["option_id"], "proceed"); assert.equal(ev["channel"], "app"); assert.equal(ev["tapped_at"], MST("2026-10-06", "09:14")); assert.equal(ev["disclosure_version_shown"], "LE-v1");
  assert.equal((await db.query(`SELECT 1 FROM card_instance_events WHERE card_instance_id = $1 AND to_status = 'resolved'`, [card.card_instance_id])).length, 1);
  assert.equal((await ui.uiEvents(partyA, "card_resolved")).filter((e) => e.card_instance_id === card.card_instance_id).length, 1);
  const intent = await events("intent.to_proceed.received"); assert.equal(intent.length, 1); assert.equal(intent[0]!.payload["channel"], "app_button");
  assert.equal((await db.query<{ status: string }>(`SELECT status FROM timers WHERE code = 'REGZ_1026_19E2_INTENT_FEE_GATE' AND application_id = $1 ORDER BY armed_at DESC`, [journey.appId]))[0]!.status, "satisfied");
  // 32.2's decision row beside 21.4's (both agents' acts on the record)
  assert.ok((await db.query<{ action: string }>(`SELECT action FROM agent_decisions WHERE application_id = $1 AND action = 'borrower.command:intent.record'`, [journey.appId])).length >= 1);
  // idempotency key = card_instance_id: the same tap again answers the stored outcome and runs nothing
  const again = await api("POST", `/v1/borrower/cards/${card.card_instance_id}/resolve`, { option_id: "proceed" }, token);
  assert.equal(again.status, 200); assert.equal(again.body["idempotent"], true); assert.equal((again.body["result"] as { command: string }).command, "intent.record");
  assert.equal((await events("intent.to_proceed.received")).length, 1);
  // a ConsentCard from a voice channel: sent, never resolved (01 §3.5); by tap it captures the consent (the consents row is the party's)
  const consent = await sendCard("ConsentCard", "consent.esign.title", "consent.capture", { consent_kind: "esign", disclosure_version_id: "esign-2026-09", scope: ["disclosures", "notices"], command_args: { kind: "esign", method: "checkbox_with_text", scope: ["disclosures", "notices"], disclosure_version_id: "esign-2026-09", text_hash: "sha256:esign" } });
  const voice = await api("POST", `/v1/borrower/cards/${consent.card_instance_id}/resolve`, { channel: "voice" }, token);
  assert.equal(voice.status, 409); errorShape(voice.body, "CARD_VOICE_CONSENT"); assert.equal((await ui.card(consent.card_instance_id))?.status, "pending");
  const tap = await api("POST", `/v1/borrower/cards/${consent.card_instance_id}/resolve`, { evidence: { typed_name: "Alex Borrower" } }, token);
  assert.equal(tap.status, 201, JSON.stringify(tap.body)); assert.equal((tap.body["result"] as { status: string }).status, "pending_verification");
  const [row] = await db.query<{ kind: string; status: string; party_id: string; scope: string[] }>(`SELECT kind::text AS kind, status, party_id, scope FROM consents WHERE id = $1`, [(tap.body["result"] as { consent_id: string }).consent_id]);
  assert.equal(row?.kind, "esign"); assert.equal(row?.party_id, partyA); assert.deepEqual(row?.scope, ["disclosures", "notices"]);
  assert.equal((await ui.uiEvents(partyA, "consent_affirmed")).length, 1, "a ConsentCard's resolve logs consent_affirmed (01 §9)");
  // an unknown / another party's card is PARTY_SCOPE, never a 404 that confirms existence
  assert.equal((await api("POST", `/v1/borrower/cards/${randomUUID()}/resolve`, {}, token)).status, 403);
});

test("lock.request through the API → 21.4 requestLock (pending the MLO), the MLO's approval and execution through 21.4's own tools; refusals answer {code, gate, copy_key}: LOCK_NOT_ACTIVE, the rescission gate, the counteroffer clock, the fresh-L1 rule (403 FRESH_L1_REQUIRED after 10 minutes)", { skip }, async () => {
  await journey.quoteForLock(); const token = await signIn();
  const r = await api("POST", "/v1/borrower/commands/lock.request", { quote_id: journey.quoteId, period_days: 45, borrower_statement: "Please lock my rate today" }, token);
  assert.equal(r.status, 200, JSON.stringify(r.body)); const result = r.body["result"] as Record<string, unknown>;
  assert.equal(result["status"], "pending_mlo_approval"); assert.ok(result["lock_id"]); assert.ok((r.body["events"] as string[]).includes("lock.requested"));
  journey.lockId = result["lock_id"] as string; await journey.executeLockAndCommit();
  const lock = await journey.entity("locks", journey.lockId); assert.equal(lock?.["status"], "executed");
  const ext = await api("POST", "/v1/borrower/commands/lock.requestExtension", { lock_id: journey.lockId, new_closing_on: "2026-12-10", lock_status: "expired" }, token);
  assert.equal(ext.status, 409); errorShape(ext.body, "LOCK_NOT_ACTIVE"); assert.equal(ext.body["copy_key"], "lock.expired");
  const resc = await api("POST", "/v1/borrower/commands/rescission.exercise", {}, token);
  assert.equal(resc.status, 409); errorShape(resc.body, "REGZ_1026_23_RESCISSION_3SBD_GATE"); assert.equal(resc.body["gate"], "REGZ_1026_23_RESCISSION_3SBD_GATE"); assert.equal(resc.body["copy_key"], "gate.rescission.window");
  const co = await api("POST", "/v1/borrower/commands/counteroffer.respond", { decision: "accept", decision_id: "D-none" }, token);
  assert.equal(co.status, 409); errorShape(co.body, "REGB_1002_9_COUNTEROFFER_90"); assert.equal(co.body["copy_key"], "gate.counteroffer.window");
  const unknown = await api("POST", "/v1/borrower/commands/not.aCommand", {}, token); assert.equal(unknown.status, 404); errorShape(unknown.body, "COMMAND_UNKNOWN");
  // a bus refusal (21.4's own guardrail) keeps the same shape: a lock request on an unknown quote
  const bad = await api("POST", "/v1/borrower/commands/lock.request", { quote_id: "nope" }, token); assert.ok(bad.status >= 400 && bad.status < 500, JSON.stringify(bad.body)); errorShape(bad.body);
  // the fresh-L1 rule (01 §5): 11 minutes after the code a money command is refused before anything runs
  clock.set(new Date(Date.parse(clock.now()) + 11 * 60_000).toISOString());
  const pay = await api("POST", "/v1/borrower/commands/payment.makeOneTime", { amount_cents: "409012", date: "2026-12-30", subject: { application_id: journey.appId } }, token);
  assert.equal(pay.status, 403); errorShape(pay.body, "FRESH_L1_REQUIRED"); assert.equal(pay.body["copy_key"], "auth.fresh_code");
  // a refusal writes nothing (the unit of work rolls back); the API log names the code and the gate
  assert.ok(lines.some((l) => l.includes('"path":"/v1/borrower/commands/lock.requestExtension"') && l.includes('"code":"LOCK_NOT_ACTIVE"')), "the refusal is logged with its code");
  assert.ok(lines.some((l) => l.includes("rescission.exercise") && l.includes('"gate":"REGZ_1026_23_RESCISSION_3SBD_GATE"')));
});

test("every one of the 45 commands reaches its mapped tool or answers {code, gate?, copy_key} — never a 500, never a TypeError", { skip }, async () => {
  clock.set(MST("2026-10-07", "11:00")); const token = await signIn();
  // 01 §5: a soft pull needs L2 — the SSN last 4 + DOB the application carries (a hard pull would need L3: the identity vendor)
  const l1 = await api("POST", "/v1/borrower/commands/credit.authorize", { kind: "soft_pull", lead_id: journey.leadId, text_hash: "sha256:auth" }, token); assert.equal(l1.status, 403); errorShape(l1.body, "LEVEL_REQUIRED");
  assert.equal((await api("POST", "/v1/borrower/auth/l2", { ssn_last4: "6789", date_of_birth: "1985-06-15" }, token)).status, 200);
  const args: Record<string, Record<string, unknown>> = {
    "lead.start": { partner_id: "partner-1", partner_name: "Partner Bank", consumer_state: "AZ", channel: "web_chat" }, "lead.acknowledgeAiDisclosure": { lead_id: journey.leadId, interaction_id: `i-${journey.R}` }, "party.authenticate": { lead_id: journey.leadId, method: "otp_email" },
    "party.startIdentity": { borrower_id: "B1", result: "verified" }, "consent.capture": { kind: "tcpa_sms", method: "checkbox_with_text", phone_number: "+16025550142", disclosure_version_id: "tcpa-2026-09", text_hash: "sha256:tcpa", purpose: "informational" }, "credit.authorize": { kind: "soft_pull", lead_id: journey.leadId, text_hash: "sha256:auth", order_pull: false },
    "application.confirmField": { path: "income", value: "1480000" }, "application.setGoal": { transaction_type: "limited_cash_out", occupancy: "primary", property: { address: "100 N Central Ave, Phoenix, AZ 85004", state: "AZ" } }, "application.answerDeclarations": { declarations: Array.from({ length: 13 }, () => false) },
    "application.answerDemographics": { declined: true, collection_method: "internet" }, "application.affirmJointIntent": {}, "application.inviteParty": { role: "non_borrowing_spouse", legal_name: "Casey Borrower", contact: { email: `casey-${R}@example.test` } },
    "verification.connect": { vendor: "truv_income", borrower_id: "B1", authorization_consent_id: `cons-standing-${R}` }, "document.upload": { document_id: `doc-cmd-${R}`, sha256: "sha-doc-cmd", document_class: "w2" }, "explanation.submit": { subject_ref: "inquiry:CapitalOne:2026-09-01", text: "I shopped for a car loan and did not open an account.", attestation: "typed_name", typed_name: "Alex Borrower" },
    "disclosure.acknowledgeReceipt": { disclosure_id: `LE-${journey.appId.slice(0, 8)}`, consumer_id: "B1" }, "intent.record": {}, "lock.request": { quote_id: journey.quoteId }, "lock.requestExtension": { lock_id: journey.lockId, new_closing_on: "2026-12-10" },
    "counteroffer.respond": { decision: "decline", decision_id: "D-1" }, "application.withdraw": { reason: "changed my mind" }, "mi.selectPlan": { plan: "bpmi_monthly", quote_id: "mq-1", certificate_status: "quoted" }, "valuation.scheduleAccess": { order_id: "vo-none", slot: "2026-11-03T16:00:00.000Z" },
    "rov.request": { appraisal_id: "apr-1", narrative: "comparable 12 Palm St sold higher" }, "insurance.submitEvidence": { document_id: `doc-hoi-${R}`, kind: "hoi_declaration" }, "closing.selectSlot": { slot: "2026-11-06T21:00:00.000Z", state: "AZ", settlement_agent_party_id: journey.AGENT_PARTY, transaction_type: "limited_cash_out" },
    "closing.captureEsignConsent": { closing_id: journey.CLOSING_ID }, "rescission.exercise": { consumer_id: "B1" }, "autodraft.enroll": { account: { last4: "4417", type: "checking" }, amount_rule: "contractual", draft_day: 1, elements_displayed: true }, "autodraft.change": { enrollment_id: "AD-1", draft_day: 5, elements_displayed: true },
    "autodraft.pause": { enrollment_id: "AD-1" }, "autodraft.revoke": { enrollment_id: "AD-1" }, "payment.makeOneTime": { amount_cents: "409012", date: "2026-12-30" }, "payment.extraPrincipal": { amount_cents: "50000" }, "escrow.electShortage": { option: "spread_12" }, "escrow.requestWaiver": {},
    "pmi.requestCancellation": {}, "case.open": { kind: "rfi", text: "Please send my payment history." }, "lossmit.requestAssistance": { hardship_text: "I lost my job in October." }, "lossmit.respondToOffer": { decision: "accept" }, "lossmit.appeal": { text: "I disagree with the denial." },
    "offer.respond": { decision: "not_now", opportunity_id: journey.opportunityId }, "refi.request": { program_id: journey.PROGRAM_ID }, "human.request": { reason: "question about my rate" }, "party.updateContact": { phone: "+16025550199" },
  };
  const outcomes: Record<string, string> = {};
  for (const name of [...COMMAND_NAMES].sort()) {
    const r = await api("POST", `/v1/borrower/commands/${name}`, args[name] ?? {}, token);
    assert.notEqual(r.status, 500, `${name}: ${JSON.stringify(r.body)}`);
    if (r.status === 200) { assert.equal(r.body["command"], name); const res = r.body["result"] as Record<string, unknown>; assert.equal(res["command"], name, JSON.stringify(res).slice(0, 200)); assert.equal(res["outcome"], "accepted"); if (DIRECT_TO_OPS[name]) assert.equal(res["direct_to_ops"], DIRECT_TO_OPS[name]); outcomes[name] = "accepted"; }
    else { errorShape(r.body); assert.notEqual(r.body["code"], "INTERNAL", name); outcomes[name] = `${r.status} ${String(r.body["code"])}${r.body["gate"] ? ` gate=${String(r.body["gate"])}` : ""}`; }
  }
  assert.ok(!lines.some((l) => l.includes("borrower.unhandled")), lines.filter((l) => l.includes("borrower.unhandled")).join("\n").slice(0, 2000));
  if (process.env["BORROWER_DEBUG"]) for (const [n, o] of Object.entries(outcomes)) process.stderr.write(`${n}: ${o}${o === "accepted" ? "" : ` — ${(lines.filter((l) => l.includes(`/v1/borrower/commands/${n}"`)).at(-1) ?? "").replace(/.*"reason":/, "").slice(0, 160)}`}\n`);
  const accepted = Object.entries(outcomes).filter(([, o]) => o === "accepted").map(([n]) => n);
  for (const n of ["lead.start", "lead.acknowledgeAiDisclosure", "party.authenticate", "party.startIdentity", "consent.capture", "application.answerDeclarations", "application.answerDemographics", "application.affirmJointIntent", "application.inviteParty", "application.setGoal", "application.withdraw", "document.upload", "explanation.submit", "disclosure.acknowledgeReceipt", "human.request", "party.updateContact", "application.confirmField", "credit.authorize", "verification.connect", "lock.request", "intent.record", "rov.request"]) assert.ok(accepted.includes(n), `${n} reached its mapped tool: ${outcomes[n]}`);
  assert.equal(outcomes["lock.requestExtension"], "409 MLO_APPROVAL_REQUIRED", "21.4's own refusal (a borrower-paid extension needs the MLO's NMLSR ID) keeps the shape");
  assert.ok(outcomes["insurance.submitEvidence"] === "accepted" || outcomes["insurance.submitEvidence"] === "409 DUPLICATE_RECORD", `24.5's counter ids collide platform-wide on a shared database — a typed 409, never a 500: ${outcomes["insurance.submitEvidence"]}`);
  assert.equal(outcomes["rescission.exercise"], "409 REGZ_1026_23_RESCISSION_3SBD_GATE gate=REGZ_1026_23_RESCISSION_3SBD_GATE"); assert.equal(outcomes["counteroffer.respond"], "409 REGB_1002_9_COUNTEROFFER_90 gate=REGB_1002_9_COUNTEROFFER_90"); assert.equal(outcomes["closing.selectSlot"], "409 SM_UW_CTC_GATE gate=SM_UW_CTC_GATE");
  assert.equal(outcomes["lossmit.respondToOffer"], "409 REGX_1024_41E1_ACCEPT_14 gate=REGX_1024_41E1_ACCEPT_14");
  for (const n of ["payment.makeOneTime", "payment.extraPrincipal", "autodraft.enroll", "escrow.electShortage", "case.open", "refi.request", "pmi.requestCancellation", "lossmit.requestAssistance"]) assert.match(outcomes[n]!, /^4\d\d /, `${n} needs a serviced loan before funding: ${outcomes[n]}`);
  // own party only: Blake's joint intent or demographics can never be answered from Alex's session
  for (const n of ["application.affirmJointIntent", "application.answerDemographics"]) { const r = await api("POST", `/v1/borrower/commands/${n}`, { borrower_id: "B2", declined: true }, token); assert.equal(r.status, 409, `${n}: ${JSON.stringify(r.body)}`); errorShape(r.body); assert.match(String(r.body["code"]), /OWN_PARTY_ONLY$/); }
  // the demographic answer never echoes values; the invite created the party's own conversation; the explanation letter is a documents row of its class
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ui_events WHERE party_id = $1 AND payload::text LIKE '%ethnicity%'`, [partyA]))[0]!.n, "0");
  assert.equal((await db.query(`SELECT 1 FROM application_borrowers ab JOIN conversations c ON c.party_id = ab.party_id WHERE ab.application_id = $1 AND ab.borrower_role = 'non_borrowing_spouse'`, [journey.appId])).length, 1);
  assert.equal((await db.query(`SELECT 1 FROM documents WHERE application_id = $1 AND doc_class = 'inquiry_explanation'`, [journey.appId])).length, 1);
});

test("DELTA-07 on the intake agent: create_deep_link mints a 7-day opaque token; resolve_card_by_evidence resolves a choice card from a voice transcript (the mapped command runs, the receipt line lands) and refuses a ConsentCard", { skip }, async () => {
  clock.set(MST("2026-10-07", "12:00")); const token = await signIn();
  const link = await runtime.execute({ process: "32.1", name: "create_deep_link", loanId: "", applicationId: journey.appId, actor: INTAKE, input: { party_id: partyA, target: { route: "/documents" } } });
  const out = link.output as { token: string; expires_at: string; path: string }; assert.equal(out.expires_at, new Date(Date.parse(clock.now()) + 7 * 86_400_000).toISOString()); assert.equal(out.path, `/d/${out.token}`);
  assert.deepEqual((await api("GET", `/v1/borrower/deeplink/${out.token}`, undefined, token)).body["target"], { route: "/documents" });
  const choice = await sendCard("ChoiceCard", "hardship.open", "human.request", { options: [{ id: "yes", label: "Yes, connect me" }], command_args_by_option: { yes: { reason: "borrower asked on the phone" } }, affirmatives: ["connect me"] });
  const before = (await events("human.transfer.requested")).length;
  const r = await runtime.execute({ process: "32.1", name: "resolve_card_by_evidence", loanId: "", applicationId: journey.appId, actor: INTAKE, input: { card_instance_id: choice.card_instance_id, option_id: "yes", evidence: { channel: "voice", transcript_ref: `call-${R}#t=41s`, spoken_text: "yes connect me" } } });
  const o = r.output as Record<string, unknown>; assert.equal(o["status"], "resolved"); assert.equal(o["manner"], "out_of_band_evidence"); assert.equal(o["channel"], "voice");
  assert.equal((await ui.card(choice.card_instance_id))?.status, "resolved"); assert.equal(((await ui.card(choice.card_instance_id))?.evidence as { transcript_ref: string }).transcript_ref, `call-${R}#t=41s`);
  assert.equal((await events("human.transfer.requested")).length, before + 1, "the card's command ran inside the same unit of work");
  assert.ok(r.events.some((e) => e.type === "card.resolved"));
  assert.equal((await db.query(`SELECT 1 FROM messages WHERE card_instance_id = $1 AND sender = 'system' AND channel = 'voice'`, [choice.card_instance_id])).length, 1, "the collapsed receipt line, on the channel the evidence came from");
  const consent = await sendCard("ConsentCard", "consent.tcpa.title", "consent.capture", { consent_kind: "tcpa_sms" });
  await assert.rejects(runtime.execute({ process: "32.1", name: "resolve_card_by_evidence", loanId: "", applicationId: journey.appId, actor: INTAKE, input: { card_instance_id: consent.card_instance_id, evidence: { channel: "voice", transcript_ref: `call-${R}#t=60s` } } }), (e: unknown) => (e as { code?: string }).code === "CARD_EVIDENCE_KIND");
  assert.equal((await ui.card(consent.card_instance_id))?.status, "pending");
  await assert.rejects(runtime.execute({ process: "32.1", name: "resolve_card_by_evidence", loanId: "", applicationId: journey.appId, actor: INTAKE, input: { card_instance_id: consent.card_instance_id, card_kind: "ConsentCard", evidence: { channel: "voice", transcript_ref: "x" } } }), (e: unknown) => e instanceof CommandRefused && e.code === "CARD_EVIDENCE_KIND");
  await assert.rejects(runtime.execute({ process: "32.1", name: "send_card", loanId: "", applicationId: journey.appId, actor: INTAKE, input: { party_id: partyA, for_party_id: randomUUID(), kind: "StatusCard", copy_key: "du.running" } }), (e: unknown) => e instanceof CommandRefused && e.code === "CARD_FOR_OWN_PARTY");
});

test("servicing commands on the funded loan: case.open (communication.inbound.received → the 10.1 case row), payment.makeOneTime with a fresh code (2.1 payments.read/write, payment.received{channel=portal}), autodraft.enroll (autodraft.enrollment.requested), refi.request (20.1), human.request → 4.3 human.transfer; every one keyed by the loan", { skip }, async () => {
  await journey.verifyDecideAndClear(); await journey.clearToClose(); await journey.scheduleClosing(); await journey.closingDisclosure(); await journey.closeAndSign(); await journey.fund(); const loanId = await journey.board();
  clock.set("2026-12-01T17:00:00.000Z"); const token = await signIn();
  const subject = { loan_id: loanId };
  const c = await api("POST", "/v1/borrower/commands/case.open", { kind: "rfi", text: "Please send my payment history for the last 12 months.", subject }, token);
  assert.equal(c.status, 200, JSON.stringify(c.body)); assert.ok((c.body["events"] as string[]).includes("communication.inbound.received")); assert.equal((c.body["result"] as { status: string }).status, "received");
  const caseId = (c.body["result"] as { case_id: string }).case_id; assert.equal((await journey.entity("cases", caseId))?.["case_type"], "rfi");
  const p = await api("POST", "/v1/borrower/commands/payment.makeOneTime", { amount_cents: "409012", date: "2026-12-30", account: { last4: "4417" }, subject }, token);
  assert.equal(p.status, 200, JSON.stringify(p.body)); assert.ok((p.body["events"] as string[]).includes("payment.received")); assert.equal((p.body["result"] as { channel: string }).channel, "portal");
  const pay = await journey.entity("payments", (p.body["result"] as { payment_id: string }).payment_id); assert.equal(pay?.["amount_cents"], 409_012n); assert.equal(pay?.["status"], "received");
  const ad = await api("POST", "/v1/borrower/commands/autodraft.enroll", { account: { last4: "4417", type: "checking" }, amount_rule: "contractual", draft_day: 1, elements_displayed: true, subject }, token);
  assert.equal(ad.status, 200, JSON.stringify(ad.body)); assert.ok((ad.body["events"] as string[]).includes("autodraft.enrollment.requested"));
  const badDay = await api("POST", "/v1/borrower/commands/autodraft.change", { enrollment_id: (ad.body["result"] as { enrollment_id: string }).enrollment_id, draft_day: 20, elements_displayed: true, subject }, token); assert.equal(badDay.status, 400); errorShape(badDay.body, "BAD_REQUEST");
  const noElements = await api("POST", "/v1/borrower/commands/autodraft.change", { enrollment_id: (ad.body["result"] as { enrollment_id: string }).enrollment_id, draft_day: 5, elements_displayed: false, subject }, token); assert.equal(noElements.status, 409); errorShape(noElements.body, "REG_E_ELEMENTS_NOT_SHOWN");
  const refi = await api("POST", "/v1/borrower/commands/refi.request", { program_id: journey.PROGRAM_ID, free_text: "can I refinance again?", subject }, token);
  assert.ok(refi.status === 200 || (refi.status >= 400 && refi.status < 500), JSON.stringify(refi.body)); if (refi.status !== 200) errorShape(refi.body);   // 20.1's request needs the loan's v_refi_universe row loaded (the trigger's own act) — a typed refusal until then
  const h = await api("POST", "/v1/borrower/commands/human.request", { reason: "billing question", subject }, token);
  assert.equal(h.status, 200, JSON.stringify(h.body)); assert.ok((h.body["events"] as string[]).includes("human.transfer.requested"));
  assert.ok((await db.query(`SELECT 1 FROM escalations WHERE loan_id = $1 AND kind = 'human_agent'`, [loanId])).length >= 1, "4.3 human.transfer opened the human_agent escalation on the loan");
  for (const type of ["communication.inbound.received", "case.opened", "payment.received", "autodraft.enrollment.requested", "human.transfer.requested"]) assert.ok((await db.query(`SELECT 1 FROM loan_events WHERE loan_id = $1 AND type = $2`, [loanId, type])).length >= 1, `${type} keyed by the loan`);
  const rec = await api("GET", `/v1/borrower/record?subject=${loanId}`, undefined, token);
  assert.equal(((rec.body["loan"] as { autodraft: { status: string } }).autodraft).status, "requested");
  const cases = await api("GET", `/v1/borrower/history/cases?subject=${loanId}`, undefined, token); assert.ok((cases.body["rows"] as { case_id: string }[]).some((r) => r.case_id === caseId));
});
