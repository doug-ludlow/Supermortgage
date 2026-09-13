// The conversational product, end to end (docs/ux/17 §1 principles 1–10, §2.3 the four card cases, §3 the turn): a borrower goes
// from sign-up to a boarded loan BY TALKING — the refinance persona, then the purchase persona — with a card only where §2.3 requires
// one. A scripted model plays the assistant deterministically over the REAL agent turn (src/runtime/borrower/agent/*, the 32.16 bus
// tools) and the test plays the borrower: every line through POST /v1/borrower/messages, every commit a tap through the card resolve
// API, the vendors the in-repo FAKEs (Stripe Identity, Truv, DU, RON, print), the humans the FAKE reviewers (DELTA-30) where a tool
// closes their queue, and the owning processes' own bus tools where the machine has no other way in (credit, DU, the decision, the
// appraisal order, title, the CD figures, the closing package, funding) — the way src/runtime/borrower/fixtures/journey.ts drives them.
// Own database (the talk.test.ts setup), a FixedClock advanced day by day so the LE/CD clocks and the daily sweeps run
// (flows.tick + runtime.sweep, as src/runtime/demo-clock.ts does). Skips without Postgres (not a spec unit).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { connect, reachable, type Db } from "../../infra/db/client.ts";
import { decodeEntityData } from "../../infra/db/entities.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock, MemoryEventStore } from "../../kernel/events/index.ts";
import { Runtime } from "../../runtime/app.ts";
import { createApiServer, listen } from "../../runtime/server.ts";
import { createLogger } from "../../runtime/log.ts";
import { createBorrowerRouter, type BorrowerRouter } from "../../runtime/borrower/routes.ts";
import { FakeStripeIdentity } from "../../runtime/borrower/vendors/fake-stripe-identity.ts";
import { seedEntryDemo } from "../../runtime/entry-seed.ts";
import { FakeReviewers } from "../../infra/integrations/reviewers.ts";
import { Journey, MST, EST, EDT } from "../../runtime/borrower/fixtures/journey.ts";
import { ET } from "../../runtime/borrower/fixtures/journey-purchase.ts";
import { deliverLeByConsent } from "../../runtime/borrower/flows/3-entry.ts";
import { CARD_CASES, CHAT_TRIGGER, cardCaseOf, assertCardCase } from "../../runtime/borrower/flows/13-cross-cutting.ts";
import { esignVerificationToken } from "../../app/tools/section32-2.ts";
import { copyTemplates } from "../../runtime/borrower/channels.ts";
import { PROMPT_VERSION } from "../../runtime/borrower/agent/context.ts";
import { MIN_REPLY_WORDS, substanceViolation } from "../../runtime/borrower/agent/guard.ts";
import { scriptedClient, type Scene, type Situation, type Call } from "./eval/scripted-client.ts";
import { provenanceCheck, verbatimCheck, evidenceCheck, factsOf, resolutionsOf, commandsOf } from "./eval/checks.ts";
import type { EvalMessage, EvalCard, EvalEvent, EvalCardEvent } from "./eval/types.ts";
import { createCasefile } from "../underwriting/ops-23-1.ts";
import { newDecisionFile } from "../application/ops-21-6.ts";
import { rescissionExpiry } from "../compliance-disclosures/ops-25-3.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { makeMin } from "../../domain/boarding/min.ts";

const DB_URL = process.env["CONVERSATION_TEST_DATABASE_URL"] ?? "postgresql://sm:sm@localhost/supermortgage_conversation_test";
const ADMIN_URL = ((): string => { const u = new URL(DB_URL); u.pathname = "/postgres"; return u.toString(); })();
const up = await reachable(ADMIN_URL);   // the database itself is dropped and created by the setup
if (!up && process.env["REQUIRE_DB"]) throw new Error(`REQUIRE_DB set but ${DB_URL} is not reachable`);
const skip = up ? false : `no Postgres at ${DB_URL}`;
const TOKEN = "ops-" + randomUUID();
/** A run tag without digits: the party's provisional name is its e-mail (the account door), and the assistant greets by it — no figure may ride in it. */
const R = randomUUID().replace(/-/g, "").replace(/[0-9]/g, (d) => "ghijklmnop"[Number(d)]!).slice(0, 6);
type Json = Record<string, unknown>;
type P = Json;
const TZ = "America/Phoenix";
const START = EDT("2026-10-19", "09:00");   // Mon Oct 19, 2026
const clock = new FixedClock(START);

const INTAKE = { kind: "agent" as const, id: "intake" }; const PRICING = { kind: "agent" as const, id: "pricing" }; const DISCLOSURE = { kind: "agent" as const, id: "disclosure" }; const VERIFICATION = { kind: "agent" as const, id: "verification" }; const UNDERWRITER = { kind: "agent" as const, id: "underwriter" };
const VALUATION = { kind: "agent" as const, id: "valuation" }; const CLOSER = { kind: "agent" as const, id: "title-closing" }; const FUNDER = { kind: "agent" as const, id: "funder" }; const FRAUD_RISK = { kind: "agent" as const, id: "fraud-risk" }; const COMPLIANCE = { kind: "agent" as const, id: "compliance-tester" }; const FUNDING = { kind: "agent" as const, id: "funding" };
const MLO = { kind: "human" as const, id: "u-mlo-rivera", role: "mlo_of_record" }; const APPROVER = { kind: "human" as const, id: "u-funding-approver", role: "funding_approver" }; const REVIEWER = { kind: "human" as const, id: "FAKE:underwriting_reviewer", role: "underwriting_reviewer" };

let db: Db; let runtime: Runtime; let router: BorrowerRouter; let base = ""; let close: () => Promise<void> = async () => undefined; let partnerId = ""; let partnerName = "";
let J: Journey;   // the journey fixture as the worked example's constants and the ops-token tool caller (no phase of it runs: the application here is the borrower's own)
const scripted = scriptedClient([], { fallbackText: "Sorry, I did not catch that. Could you say it another way?", regenerateText: "Let me say that more simply. The next step is on the card here." });

test.before(async () => {
  if (skip) return;
  const name = new URL(DB_URL).pathname.slice(1);
  const a = connect(ADMIN_URL); await a.query(`DROP DATABASE IF EXISTS ${name}`); await a.query(`CREATE DATABASE ${name}`); await a.end();
  execFileSync(fileURLToPath(new URL("../../../db/migrate.sh", import.meta.url)), { env: { ...process.env, DATABASE_URL: DB_URL }, stdio: "pipe" });
  db = connect(DB_URL);
  const logger = createLogger("json", (line) => { if (process.env["FLOW_DEBUG"] && /flow|error|unhandled|agent|reviewer|BAD_REQUEST|"reason"/i.test(line)) process.stderr.write(line + "\n"); });
  // DELTA-30: every human a journey waits on is a FAKE that approves on the next sweep (delay 0 — the clock is ours)
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock, reviewers: new FakeReviewers({ delaySeconds: 0, logger }) });
  const seeded = await seedEntryDemo(runtime, { states: ["AZ", "CO"], now: START }); partnerId = seeded.partner_id; partnerName = seeded.partner_name;
  router = createBorrowerRouter({ runtime, logger, environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost"], urlSecret: "test-secret", defaultPartnerId: partnerId, llm: { client: scripted.client, model: "scripted" } });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger, console: false, borrowerRouter: router });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => { router.hub.close(); server.closeAllConnections?.(); server.close(() => db.end().then(() => resolve())); });
  J = new Journey({ runtime, db, base, token: TOKEN, clock, borrowerEmail: `unused-a-${R}@example.test`, coBorrowerEmail: `unused-b-${R}@example.test`, partnerPartyId: partnerId });
});
test.after(async () => { if (!skip) { await router.flows?.settle(); await close(); } });

// ---------------------------------------------------------------- helpers over the borrower API and the tables
type Reply = { status: number; body: Json };
async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, ip = "10.32.0.1"): Promise<Reply> {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-forwarded-for": ip, ...headers }, ...(body !== undefined ? { body: JSON.stringify(body, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)) } : {}) });
  const text = await r.text(); return { status: r.status, body: text ? (JSON.parse(text) as Json) : {} };
}
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
/** The flows' reactions and the agent's queued turns have run (the first turn of a session runs behind the session hooks). */
const settle = async (): Promise<void> => { await router.flows!.settle(); await router.agent?.settle(); await router.flows!.settle(); };
type CardRow = { card_instance_id: string; party_id: string; kind: string; status: string; copy_key: string; props: Json; evidence: Json | null; command_ref: string | null; created_by: string; created_at: string; resolved_at: string | null; subject_application_id: string | null; subject_loan_id: string | null; misses: number };
const cardsOf = async (partyId: string): Promise<CardRow[]> => db.query<CardRow>(`SELECT card_instance_id, party_id, kind, status, copy_key, props, evidence, command_ref, created_by, created_at, resolved_at, subject_application_id, subject_loan_id, misses FROM card_instances WHERE party_id = $1 ORDER BY created_at, card_instance_id`, [partyId]);
const events = async (appId: string, type?: string) => db.query<{ type: string; sequence: string; occurred_at: string; payload: Json; loan_id: string | null; application_id: string | null }>(`SELECT type, sequence::text AS sequence, occurred_at, payload, loan_id, application_id FROM loan_events WHERE application_id = $1 AND ($2::text IS NULL OR type = $2) ORDER BY loan_events.sequence`, [appId, type ?? null]);
const entity = async (kind: string, id: string): Promise<Json | null> => { const rows = await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = $1 AND id = $2`, [kind, id]); return rows[0] ? decodeEntityData(rows[0].data) : null; };
const entitiesOf = async (kind: string, appId: string): Promise<{ id: string; data: Json }[]> => (await db.query<{ id: string; data: unknown }>(`SELECT DISTINCT ON (id) id, data FROM entity_records WHERE kind = $1 AND application_id = $2 ORDER BY id, version DESC`, [kind, appId])).map((r) => ({ id: r.id, data: decodeEntityData(r.data) }));
const timer = async (appId: string, code: string) => (await db.query<{ status: string; due_at: string | null; due_date: string | null }>(`SELECT status::text AS status, due_at, due_date::text AS due_date FROM timers WHERE application_id = $1 AND code = $2 ORDER BY armed_at DESC LIMIT 1`, [appId, code]))[0];
type TurnRow = { turn_id: string; message_id: string | null; reply_message_id: string | null; model_version: string; prompt_version: string; context_hash: string; tool_calls: Json[]; safe_classification: string | null; guard_result: Json; created_at: string };
const turnsOf = (partyId: string) => db.query<TurnRow>(`SELECT turn_id, message_id, reply_message_id, model_version, prompt_version, context_hash, tool_calls, safe_classification, guard_result, created_at FROM agent_turns WHERE party_id = $1 ORDER BY created_at, turn_id`, [partyId]);
const tool = (appId: string, process: string, name: string, input: Json, actor: { kind: "agent" | "human" | "system"; id: string; role?: string } = INTAKE) => J.tool({ app: appId }, process, name, input, actor as never);
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const LEGAL_P = "Lot 9, Saguaro Estates, per Book 200 of Maps, page 12, Maricopa County records";
/** The purchase's own MIN (the FAKE eRegistry refuses a MIN registered once — the refinance persona's is the journey fixture's). */
const MIN_P = makeMin("1000123", String(3_000_000_000 + (parseInt(R, 36) % 999_999_999)));
/** The level P&I of a fixed-rate note (cents, rounded half up) — asserted equal to 26.1 computeNoteTerms' own figure before it is used anywhere. */
function piCents(principal: bigint, ratePct: number, months: number): string { const r = ratePct / 100 / 12; const f = Math.pow(1 + r, months); return String(Math.round(Number(principal) * r * f / (f - 1))); }
const fieldsEvidence = (card: CardRow, edits: Record<string, string> = {}, at = clock.now()) => ({ evidence: { fields: (card.props["fields"] as { path: string; value: string; source: string }[]).map((f) => ({ path: f.path, value_confirmed: edits[f.path] ?? f.value, source: f.source, confirmed_at: at })), edited: Object.keys(edits).length > 0 } });
/** Confirm on a proposal the assistant read back (32.16 §3.4): `evidence.source = borrower_stated` with the proposed fields. */
const proposalEvidence = (card: CardRow, at = clock.now()) => { const p = card.props["proposal"] as { fields?: { path: string; value: string }[] } | undefined; assert.ok(p?.fields?.length, `a proposal on ${card.copy_key}`); return { evidence: { source: "borrower_stated", fields: p!.fields!.map((f) => ({ path: f.path, value: f.value })), tapped_at: at } }; };
const civilDateEt = (iso: string): string => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
/** The clock forward: a day at a time at noon Eastern (src/runtime/demo-clock.ts DAY_STEP_TIME) so every day's sweeps run — the flows' tick (the LE/CD mailbox rules, the origination and servicing sweeps) and the runtime's (the FAKE reviewers, the breach pass) — then the target instant. */
async function advance(to: string): Promise<void> {
  assert.ok(Date.parse(to) >= Date.parse(clock.now()), `advance goes forward only (${clock.now()} → ${to})`);
  for (;;) { const d = D(civilDateEt(clock.now())); const [y, m, dd] = d.split("-").map(Number) as [number, number, number]; const next = new Date(Date.UTC(y, m - 1, dd + 1)).toISOString().slice(0, 10); const noon = ET(next, "12:00"); if (Date.parse(noon) >= Date.parse(to)) break; clock.set(noon); await tickAll(noon); }
  clock.set(to); await tickAll(to);
}
async function tickAll(at: string): Promise<void> { await router.flows!.tick(at); await settle(); await runtime.sweep(at); await settle(); }
/** A moment later on the same sitting (the clock moves by minutes; sessions idle out at 30). */
const later = (minutes: number): string => { const at = new Date(Date.parse(clock.now()) + minutes * 60_000).toISOString(); clock.set(at); return at; };

// ---------------------------------------------------------------- the borrower (the test's side of the conversation)
class Borrower {
  token = ""; party_id = ""; app_id = ""; loan_id = ""; conversation_id = "";
  readonly said: string[] = [];
  readonly email: string; readonly password: string; readonly name: string; readonly ssn: string; readonly dob: string;
  constructor(email: string, password: string, name: string, ssn: string, dob: string) { this.email = email; this.password = password; this.name = name; this.ssn = ssn; this.dob = dob; }
  get last4(): string { return this.ssn.replace(/\D/g, "").slice(-4); }
  /** Create: the whole front door (32.16 §2.0) — a session at once, the disclosure row, the goal card, the first turn. */
  async signUp(): Promise<void> {
    const v = await api("POST", "/v1/borrower/auth/account", { action: "create", email: this.email, password: this.password }); assert.equal(v.status, 200, JSON.stringify(v.body));
    this.token = v.body["token"] as string; this.party_id = (v.body["party"] as Json)["party_id"] as string; await settle();
    const apps = await db.query<{ id: string }>(`SELECT a.id FROM applications a JOIN application_borrowers ab ON ab.application_id = a.id WHERE ab.party_id = $1 ORDER BY a.created_at`, [this.party_id]); assert.equal(apps.length, 1, "the organic application behind the account"); this.app_id = apps[0]!.id;
    this.conversation_id = (await this.thread()).conversation_id;
  }
  /** A fresh sitting: the password sign-in (L1), stepped up to L2 when the SSN's last four and the birth date are on the borrower row (01 §5). Every sign-in is a session the flows greet — a turn of its own. */
  async signIn(level: "L1" | "L2" = "L2"): Promise<string> {
    const s = await api("POST", "/v1/borrower/auth/account", { action: "sign_in", email: this.email, password: this.password }); assert.equal(s.status, 200, JSON.stringify(s.body)); this.token = s.body["token"] as string;
    if (level === "L2") { const l2 = await api("POST", "/v1/borrower/auth/l2", { ssn_last4: this.last4, date_of_birth: this.dob }, bearer(this.token)); assert.equal(l2.status, 200, JSON.stringify(l2.body)); }
    await settle(); return this.token;
  }
  /** A one-time code sign-in: the fresh L1 a money command needs (32.1 §5). */
  async signInFresh(): Promise<string> {
    const req = await api("POST", "/v1/borrower/auth/otp", { action: "request", channel: "email", destination: this.email }); assert.equal(req.status, 200, JSON.stringify(req.body));
    const ver = await api("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: req.body["challenge_id"], code: req.body["fake_code"] }); assert.equal(ver.status, 200, JSON.stringify(ver.body));
    this.token = ver.body["token"] as string; await settle(); return this.token;
  }
  /** One borrower line through the thread; the agent turn answers (or a flow / the affirmative path does). */
  async say(text: string): Promise<Reply & { reply: Json }> {
    this.said.push(text);
    const r = await api("POST", "/v1/borrower/messages", { text, channel: "app" }, bearer(this.token)); assert.equal(r.status, 200, `"${text}": ${JSON.stringify(r.body).slice(0, 600)}`); await settle();
    return { ...r, reply: (r.body["reply"] as Json) ?? {} };
  }
  /** A tap: the only commit path (docs/ux/17 §1 principle 6). */
  async tap(card: CardRow | string, body: Json): Promise<Reply> {
    const id = typeof card === "string" ? card : card.card_instance_id;
    const r = await api("POST", `/v1/borrower/cards/${id}/resolve`, body, bearer(this.token)); assert.equal(r.status, 201, `tap ${typeof card === "string" ? card : card.copy_key}: ${JSON.stringify(r.body).slice(0, 800)} — body ${JSON.stringify(body).slice(0, 600)}`); await settle(); return r;
  }
  async cards(): Promise<CardRow[]> { await settle(); return cardsOf(this.party_id); }
  async pending(copyKey: string, where: (c: CardRow) => boolean = () => true): Promise<CardRow> { const c = (await this.cards()).filter((x) => x.copy_key === copyKey && x.status === "pending" && where(x)).at(-1); assert.ok(c, `a pending ${copyKey} card (pending: ${(await this.cards()).filter((x) => x.status === "pending").map((x) => x.copy_key).join(", ")})`); return c; };
  async noPending(copyKey: string): Promise<void> { assert.ok(!(await this.cards()).some((x) => x.copy_key === copyKey && x.status === "pending"), `${copyKey} no longer pending`); }
  async thread(): Promise<{ conversation_id: string; messages: Json[]; pinned_card: Json | null }> { await settle(); const r = await api("GET", "/v1/borrower/thread?limit=1000", undefined, bearer(this.token)); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300)); return r.body as { conversation_id: string; messages: Json[]; pinned_card: Json | null }; }
  async record(subject = this.app_id): Promise<Json> { await settle(); const r = await api("GET", `/v1/borrower/record?subject=${subject}`, undefined, bearer(this.token)); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 600)); return r.body; }
  async turns(): Promise<TurnRow[]> { return turnsOf(this.party_id); }
  /** The turn that answered the last line: its agent_turns row (by the reply's turn_id) with its tool calls. */
  async turnOf(r: { reply: Json }): Promise<TurnRow> { const id = (r.reply["copy_tokens"] as Json | null)?.["turn_id"]; assert.ok(id, `an agent turn answered: ${JSON.stringify(r.reply).slice(0, 300)}`); const row = (await this.turns()).find((t) => t.turn_id === id); assert.ok(row, "the agent_turns row"); return row; }
}
/** The reply was the model's own accepted sentence (no default copy, no placeholder), and it read back through a proposal into `copyKey` (the confirm chip). */
async function assertModelReply(b: Borrower, r: Reply & { reply: Json }, o: { proposedInto?: string; refused?: string; text?: RegExp } = {}): Promise<TurnRow> {
  const t = await b.turnOf(r);
  assert.equal((t.guard_result as Json)["ok"], true, `the guard accepted the sentence: ${JSON.stringify(t.guard_result)}`); assert.equal((r.reply["copy_tokens"] as Json)["fallback"], undefined, `no default copy: ${JSON.stringify(r.reply["copy_tokens"])}`);
  assert.doesNotMatch(String(r.reply["body_text"]), /\{\{/, "every token filled"); if (o.text) assert.match(String(r.reply["body_text"]), o.text);
  if (o.proposedInto) { const card = await b.pending(o.proposedInto); assert.equal(r.reply["card_instance_id"], card.card_instance_id, "the reply refers to the card it proposed into (the confirm chip)"); assert.ok(card.props["proposal"], "the proposal is on the card"); }
  if (o.refused) { const call = t.tool_calls.find((c) => c["name"] === "card.propose"); assert.ok(call, "the model tried card.propose"); assert.equal(call!["is_error"], true); assert.equal(call!["error"], o.refused, `refused with ${o.refused}: ${JSON.stringify(call)}`); }
  return t;
}

// ---------------------------------------------------------------- the scripted assistant: the scenes both personas share
const pendingIn = (s: Situation, copyKey: string): string | null => { const c = [...s.pending_cards].reverse().find((x) => x["copy_key"] === copyKey); return c ? String(c["card_instance_id"]) : null; };
const next = (): Call[] => [{ name: "session.next", input: {} }];
const propose = (copyKey: string, input: Json) => (s: Situation): Call[] => { const id = pendingIn(s, copyKey); return id ? [{ name: "card.propose", input: { card_instance_id: id, ...input } }] : next(); };
const proposed = (r: readonly { name: string; is_error: boolean }[]): boolean => r.some((x) => x.name === "card.propose" && !x.is_error);
const readBack = (yes: string, no: string) => (_s: Situation, r: readonly { name: string; is_error: boolean }[]): string => (proposed(r) ? yes : no);
const head = (s: Situation): string => (s.session_next.step === "card" ? "The next thing for you is on the card here." : "Nothing is needed from you right now; I will say when something is.");
const sent = (r: readonly { name: string; is_error: boolean; content: unknown }[]): boolean => r.some((x) => x.name === "card.request" && !x.is_error && (x.content as Json | null)?.["sent"] === true);
const SCENES: readonly Scene[] = [
  { when: /has not said anything yet/, calls: next(), text: "Hi {{party.first_name}}, welcome. Are you here to buy a home, lower the payment on the one you have, or take cash out?" },
  { when: /the borrower is back/, calls: next(), text: (s) => `Welcome back. ${head(s)}` },
  // the goal (32.3 E3): proposed into the ChoiceCard, confirmed by the tap
  { when: /lower my (monthly )?payment/i, calls: propose("entry.goal.question", { option_id: "lower_rate" }), text: readBack("Got it: {{proposal.option}}. Tap Confirm on the goal card here so it counts, and then we will look at the home.", "Got it. The goal card here is where that choice counts: pick the one that fits and tap it.") },
  { when: /buy(ing)? (a )?(house|home)|still looking/i, calls: propose("entry.goal.question", { option_id: "buy" }), text: readBack("Got it: {{proposal.option}}. Tap Confirm on the goal card here so it counts, and then we will talk about where you are in the search.", "Got it. The goal card here is where that choice counts: pick the one that fits and tap it.") },
  // a consent in words: the model tries and the tool refuses (docs/ux/17 §1 principle 6)
  { when: /put me down as consenting|count that as my consent/i, calls: (s) => { const id = pendingIn(s, "consent.esign.title"); return id ? [{ name: "card.propose", input: { card_instance_id: id, fields: [{ path: "typed_name", value: "as stated" }] } }] : next(); }, text: "I can't take a consent in words. The e-delivery card here is where it counts: check the box and type your name there." },
  // the SSN in words: masked on the card, never repeated
  { when: /my social (security number )?is/i, calls: (s) => { const id = pendingIn(s, "identity.ssn.title"); return id ? [{ name: "card.propose", input: { card_instance_id: id, fields: [{ path: "ssn", value: "123456789" }] } }] : next(); }, text: "I never repeat that here. Type it on the card, where it stays masked and is stored once." },
  // the home (32.3 R1)
  { when: /main home|primary home|live there/i, calls: propose("refi.home.confirm", { fields: [{ path: "property_address", value: "100 N Central Ave, Phoenix, AZ 85004" }, { path: "occupancy", value: "primary" }] }), text: readBack("So the home is {{proposal.property_address}} and you live there as your main home. Tap Confirm on the home card if that's right.", "Got it. Confirm the home on the card here.") },
  // income: the typed path (R3 SQ-03) — the card on request, then the figure proposed into it
  { when: /rather type|type (in )?my income/i, calls: [{ name: "card.request", input: { kind: "income" } }], text: (_s, r) => (sent(r) ? "Sure. The income card is on the rail; tell me the monthly figure and where you work and I will put them in for you to confirm." : "Let me get that card up for you.") },
  { when: /a month at/i, calls: propose("income.confirm.title", { fields: [{ path: "employer", value: "Acme Manufacturing" }, { path: "monthly_income", value: "820000" }] }), text: readBack("I heard {{proposal.monthly_income}} a month at {{proposal.employer}}. Tap Confirm on the income card so it counts, or edit it there.", "Thanks. I will take that on the income card when we get there; nothing is written from words alone.") },
  // assets: the typed path (SQ-01) with the figure as the card's editable default
  { when: /in checking at|in my checking/i, calls: [{ name: "card.request", input: { kind: "assets", args: { amount_cents: "4000000", institution: "Chase" } } }], text: (_s, r) => (sent(r) ? "Thanks. The account card is on the rail with what you told me; check it and tap Confirm. A bank connection is asked for only if underwriting needs it." : "I will note the account; a card for it comes when it is needed.") },
  // about you (R4): proposed into the ProfileCard
  { when: /citizen/i, calls: propose("profile.title", { fields: [{ path: "citizenship_status", value: "us_citizen" }, { path: "marital_status", value: "unmarried" }, { path: "dependents", value: "0" }, { path: "military_service", value: "none" }, { path: "language_preference", value: "english" }] }), text: readBack("Here is what I have: {{proposal.citizenship_status}}, {{proposal.marital_status}}, dependents {{proposal.dependents}}, military service {{proposal.military_service}}, language {{proposal.language_preference}}. Tap Confirm on the profile card if that's right.", "Thanks. The profile card here takes those answers.") },
  // declarations and demographics in words: refused
  { when: /mark (all )?the declarations|declarations (as|are) (all )?no/i, calls: propose("declarations.title", { option_id: "none" }), text: "Those answers are yours to give, not mine to enter. The declarations card here lists them; tap the one that fits." },
  { when: /white woman|not hispanic/i, calls: (s) => { const id = pendingIn(s, "demographics.title"); return id ? [{ name: "card.propose", input: { card_instance_id: id, fields: [{ path: "sex", value: "female" }] } }] : next(); }, text: "That part is answered on the card only, never through me. It is optional, and it never changes the outcome of your application." },
  // the six items (R7): value, amount and product proposed into their three cards
  { when: /worth about|owe about/i, calls: (s) => [...propose("refi.value.confirm", { fields: [{ path: "property_value_estimate", value: "80000000" }] })(s), ...propose("refi.loan_amount.confirm", { fields: [{ path: "loan_amount_sought", value: "56000000" }] })(s), ...propose("refi.product.choice", { option_id: "FRM30" })(s)].filter((c) => c.name === "card.propose"), text: readBack("So the home is worth about {{proposal.property_value_estimate}}, you would like to borrow {{proposal.loan_amount_sought}}, and {{proposal.option}}. Tap Confirm on each of the three cards.", "Thanks. The value, the amount and the product each have a card here; confirm them there.") },
  // the preapproval (P1/P8) for the purchase persona
  { when: /looking in arizona|between four/i, calls: propose("preapproval.where", { fields: [{ path: "state", value: "AZ" }, { path: "price_min_cents", value: "45000000" }, { path: "price_max_cents", value: "52500000" }, { path: "down_payment_cents", value: "10500000" }, { path: "first_time_buyer", value: "yes" }] }), text: readBack("So: {{proposal.state}}, a price from {{proposal.price_min_cents}} to {{proposal.price_max_cents}}, {{proposal.down_payment_cents}} down, first home {{proposal.first_time_buyer}}. Tap Confirm on the card if that's right.", "Got it. The where-and-how-much card here takes those answers.") },
  { when: /aim for|target price/i, calls: propose("preapproval.target", { fields: [{ path: "target_price_cents", value: "52500000" }, { path: "down_payment_cents", value: "10500000" }, { path: "loan_amount_sought", value: "42000000" }, { path: "product_code", value: "FRM30" }] }), text: readBack("So a target of {{proposal.target_price_cents}} with {{proposal.down_payment_cents}} down, borrowing {{proposal.loan_amount_sought}} on {{proposal.product_code}}. Tap Confirm on the card so it counts.", "Thanks. The target card here takes those figures.") },
  { when: /don'?t know the seller|do not know the seller|never met the seller/i, calls: propose("contract.seller_relationship", { option_id: "no" }), text: readBack("Got it: {{proposal.option}}. Tap Confirm on the seller card here so it counts; it matters for how the sale is reviewed.", "Thanks. The seller card here asks whether you know the seller; tap the answer that fits.") },
  { when: /under contract|signed a contract/i, calls: [{ name: "card.request", input: { kind: "upload", args: { document_class: "purchase_contract" } } }], text: (_s, r) => (sent(r) ? "Congratulations. Send the signed contract with the upload card here and I will read the address and the price from it for you to confirm." : "Send the signed contract when you have it; the upload card appears here.") },
  // narration along the way: the head of the agenda, plain words, no figure
  { when: /those debts|debts on my report/i, calls: next(), text: (s) => `The debts card shows what your report lists; check it and tap Confirm, then the current-loan card beside it. ${head(s)}` },
  { when: /loan estimate|got the estimate/i, calls: [{ name: "explain", input: { topic: "loan_estimate" } }, ...next()], text: "The Loan Estimate is here as a document: it lays out the terms, the payment and the costs so you can compare. Open it, read to the end and tap Confirm receipt." },
  { when: /happy with it|ready to move forward/i, calls: next(), text: (s) => `Good. The go-ahead is a card: tap Proceed there and the lock choices follow. ${head(s)}` },
  { when: /which lock|should i lock/i, calls: next(), text: "The lock card shows the choices side by side with their periods; pick the one that fits, or keep floating. I cannot pick one for you." },
  { when: /what (else )?do you need from me/i, calls: [...next(), { name: "record.get", input: {} }], text: (s) => (s.session_next.step === "card" ? "Underwriting's list is on the rail: each upload card names the document it needs from you. Tap each card and add its file, and I will say when they are through." : head(s)) },
  { when: /appraiser|appraisal/i, calls: [{ name: "explain", input: { topic: "appraisal" } }, ...next()], text: "An appraiser visits to confirm the home's condition and value; nothing about the value goes through me. Pick a window that works on the schedule card here." },
  { when: /closing disclosure|final numbers/i, calls: [{ name: "explain", input: { topic: "closing_disclosure" } }, ...next()], text: "The Closing Disclosure is the final form with your loan's actual terms and costs. Open it here, read it to the end and tap Confirm receipt; signing follows after the waiting period." },
  { when: /when can we sign|sign on friday/i, calls: next(), text: "Pick a signing window on the schedule card here; signing electronically is the default, and paper is a choice on the card beside it." },
  { when: /set up autopay|autopay from my checking/i, calls: next(), text: "Autopay is a card on the rail: add the account and type your name there. It needs a fresh sign-in code, and you can stop it any time." },
  { when: /^thanks/i, text: "You are welcome. I am here whenever you need me." },
  // the demo's defect (2): a model that answers a bare "What next?" is refused by the guard's substance check and regenerated once with the head of the agenda
  { when: /anything else you need from me/i, calls: next(), text: "What next?", regenerate: "Yes. The next thing for you is on the card here; open it and tap when you are ready, and I will say what follows." },
  { when: /what'?s next|what next|where are we/i, calls: next(), text: (s) => (s.session_next.step === "card" ? `Right now the loan needs one thing from you: the ${String(s.session_next.kind ?? "card").replace(/Card$/, "").toLowerCase()} card here. Open it and tap when you are ready.` : head(s)) },
];
scripted.use(SCENES);

// ---------------------------------------------------------------- the platform's side (the owning processes' own tools, as journey.ts drives them; single borrower B1)
const K = <T,>(key: string): T => (J as unknown as Record<string, T>)[key]!;   // the journey's private constants (the worked example's figures)
interface RefiFacts { readonly name: string; readonly last: string; readonly email: string; readonly address: string; readonly quoteId: string; lockQuoteId: string; readonly decisionId: string }
async function orderCredit(b: Borrower, at: string): Promise<string> {
  const order = await tool(b.app_id, "22.2", "orderCreditReport", { borrower_ids: ["B1"], permissible_purpose: "credit_transaction_604a3A", certification_ref: "CERT-PARTNER-1681E-2026", borrower_authorization_ref: `AUTH-${b.party_id.slice(0, 8)}`, subscriber_code: "SUB-PARTNER-0417", fee_sm_borne: true, trid_received: true, at }, VERIFICATION);
  await tool(b.app_id, "22.2", "parseCreditReport", { report_id: order.output["report_id"] }, VERIFICATION); await settle();
  return order.output["report_id"] as string;
}
const QUOTE_INPUTS = (loan: string, value: string, transaction_type: "limited_cash_out" | "purchase", purchase_price: string | null = null) => ({ product_code: "FRM30", term_months: 360, amortization: "fixed", transaction_type, occupancy: "primary", property_type: "sfr", units: 1, loan_amount_cents: loan, value_cents: value, purchase_price_cents: purchase_price, representative_score: 742, score_model: "classic_fico", score_source: "tri_merge_2026-10-19", borrower_score_models: ["classic_fico"],
  state: "AZ", county: "Maricopa", county_limit_cents: "83275000", subordinate_financing_cents: "0", mi_option: "none", homeready: false, homeready_evaluation: null, first_time_homebuyer: transaction_type === "purchase", fthb_ami_waiver: false, dts_waiver: false, very_low_income: false, lock_period_days: 45, expected_purchase_ready_date: "2026-12-01", escrowed: true, valuation_method: "hybrid", borrower_pays_third_party_costs: false,
  taxes_annual_cents: "480000", insurance_annual_cents: "186000", mi_annual_rate_pct: null, assumed_disbursement_date: "2026-11-12", first_payment_date: "2027-01-01" });
const grid = (rows: [string, string][]) => rows.map(([r, p]) => ({ product_code: "FRM30", term_months: 360, note_rate_pct: r, lock_period_days: 45, price: p }));
const PRICES = grid([["6.375", "101.875"], ["6.250", "101.375"], ["6.125", "100.875"], ["6.000", "100.375"], ["5.875", "99.750"]]);
async function publishSheet(date: string): Promise<void> { await J.tool({}, "20.4", "publishRateSheet", { rate_sheet_id: `rs-${date}-${R}`, partner_id: partnerId, source: "pe_whole_loan_api", published_at: ET(date, "06:35"), expires_at: ET(date, "17:00"), prices: PRICES }, PRICING as never); }
/** 20.4's personalized quote under the MLO of record's review (assisted mode): the FAKE MLO approves it on the next sweep → 20.3 presents the terms. */
async function priceAndReview(b: Borrower, loan: string, value: string, tt: "limited_cash_out" | "purchase", price: string | null, quoteId: string): Promise<void> {
  const q = await tool(b.app_id, "20.4", "solvePassThrough", { inputs: QUOTE_INPUTS(loan, value, tt, price), quote_id: quoteId, purpose: "lead_quote", partner_id: partnerId, lead_id: b.app_id }, PRICING); assert.equal(q.output["quote_id"], quoteId);
  await tool(b.app_id, "20.3", "requestQuote", { op: "assign_mlo", lead_id: b.app_id, mlo_of_record_id: "u-mlo-rivera", mlo_name: "Jordan Rivera", mlo_nmlsr_id: "987654", mlo_time_zone: TZ });
  const req = await tool(b.app_id, "20.3", "requestQuote", { op: "request_review", lead_id: b.app_id, quote_id: quoteId }); assert.ok(req.events.some((e) => e.type === "terms.presentation.requested")); await settle();
  assert.ok((await b.cards()).some((x) => x.copy_key === "terms.pending_mlo" && x.kind === "StatusCard"), "the review StatusCard (informational: resolved by the flow as it is sent)");
  // the FAKE MLO of record approves on the sweep (DELTA-30; 20.3 requestQuote{op: review, outcome: approved})
  const at = later(1); await tickAll(at);
  const done = (await events(b.app_id, "mlo.review.completed")).filter((e) => e.payload["quote_id"] === quoteId); assert.equal(done.length, 1, "the FAKE reviewer approved the terms review"); assert.equal(done[0]!.payload["outcome"], "approved"); assert.match(String(done[0]!.payload["review_id"] ?? ""), /^FAKE-MR-/);
  assert.equal((await events(b.app_id, "terms.presented")).length, 1, "20.3 presented the terms after the approval");
}
function leRender(b: Borrower, over: Json): Json {
  const revive = (v: unknown): unknown => (Array.isArray(v) ? v.map(revive) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Json).map(([k, x]) => [k, k.endsWith("_cents") && (typeof x === "string" || typeof x === "number") && x !== "" ? BigInt(x) : revive(x)])) : v);
  const r = revive({ ...K<() => Json>("LE_RENDER")(), application_id: b.app_id, disclosure_id: `LE-${b.app_id.slice(0, 8)}`, applicants: [b.name], ...over }) as Json;
  return { ...r, as_of: D(String(r["as_of"])), fees: ((r["fees"] as Json[] | undefined) ?? []).map((f) => ({ ...f, estimated_at: D(String(f["estimated_at"])) })) };
}
const BORROWER_IDENTITY = (b: Borrower, last: string) => [{ borrower_id: "B1", last_name: last, suffix: null, ssn_last4: b.last4 }];
/** 23.1's casefile, the credit association, the DU request and its findings (Approve/Eligible, the worked example's messages), 23.2's interpretation → the conditions (32.3 R8 / 32.5). */
async function duRun(b: Borrower, f: RefiFacts, reportId: string, times: { findings_at: string; interpreted_at: string }): Promise<{ submission_id: string; interpretation_id: string | null; request_hash: string }> {
  clock.set(times.findings_at);
  const cf0 = createCasefile(new MemoryEventStore(clock), { application_id: b.app_id, seller_number: "123456789", system_id_ref: "SYS-PARTNER-01", tsp_product_ref: "SM-TSP", score_model: "classic_fico", created_at: clock.now() }).casefile;
  await tool(b.app_id, "23.1", "associateCredit", { casefile: cf0, reports: [await entity("credit_reports", reportId)], borrowers: BORROWER_IDENTITY(b, f.last), app_score_model: "classic_fico" }, UNDERWRITER);
  const snapshot = { application_id: b.app_id, loan_purpose: "limited_cash_out_refinance", occupancy: "principal_residence", product: "fixed_30", amortization: "fixed", loan_term: 360, property_type: "sfr_detached", sales_price_cents: null, appraised_value_cents: "80000000", loan_amount_cents: "56000000", note_rate_pct: "6.125", qualifying_income_cents: "820000", total_obligations_cents: "312000", borrowers: BORROWER_IDENTITY(b, f.last), max_ltv_pct: "95.00" };
  const built = await tool(b.app_id, "23.1", "buildDuRequest", { casefile_id: cf0.casefile_id, submission_type: "credit_and_underwriting", reason: "initial", snapshot }, UNDERWRITER);
  await tool(b.app_id, "23.1", "submitCasefile", { casefile_id: cf0.casefile_id, request: built.output["request"], projected_note_date: "2026-11-06", scif_facts: { borrowers: [{ id: "B1", scif_presented_at: START }] } }, UNDERWRITER);
  const findings = await tool(b.app_id, "23.1", "fetchFindings", { casefile_id: cf0.casefile_id, submission_number: 1 }, UNDERWRITER); const submission = findings.output["submission"] as Json;
  clock.set(times.interpreted_at);
  const interp = await tool(b.app_id, "23.2", "parseFindings", { op: "interpret", submission_id: submission["submission_id"], submission_number: 1, recommendation: "approve_eligible", messages: K<Json[]>("DU_MESSAGES"), validation_results: [], value_acceptance_offer: { offered: true, property_value_cents: "80000000" }, mi_requirement: { required: false, coverage_pct: null }, du_release: "2026-09-25", policy_generation: "2026_09_26", request_hash: built.output["request_hash"], findings_received_at: times.findings_at, facts: { ...K<Json>("DU_FACTS"), borrower_ids: ["B1"] } }, UNDERWRITER);
  await settle();
  return { submission_id: String(submission["submission_id"]), interpretation_id: ((interp.output["interpretation"] as { interpretation_id?: string } | undefined)?.interpretation_id) ?? null, request_hash: String(built.output["request_hash"]) };
}
/** 22.1's own pipeline after an upload (the FAKE classifier and extractor as the verification agent) up to the review that satisfies the request. */
async function review(b: Borrower, document_id: string, doc_class: string, fields: Json): Promise<void> {
  await tool(b.app_id, "22.1", "classifyDocument", { document_id, doc_class, confidence: 0.98 }, VERIFICATION);
  await tool(b.app_id, "22.1", "extractFields", { document_id, extraction_id: `x-${document_id}`, fields }, VERIFICATION);
  await tool(b.app_id, "22.1", "runIntegrityBattery", { document_id }, VERIFICATION);
  const rv = await tool(b.app_id, "22.1", "matchToRequests", { document_id, op: "review" }, VERIFICATION); await settle();
  const reviews = (rv.output["reviews"] as Json[] | undefined) ?? []; assert.ok(reviews.some((r) => r["satisfied"] === true), `22.1's review satisfied a request with the ${doc_class}: ${JSON.stringify(reviews).slice(0, 400)}`);
}
/** 23.3's clearance (the underwriter) on the reviewed evidence: the condition clears and the checklist refreshes. */
async function clear(b: Borrower, conditionId: string, evidence: { document_id: string; kind: string; document_date: string }[], closing_date = "2026-11-06"): Promise<void> {
  const ev = await tool(b.app_id, "23.3", "evaluateClearance", { condition_id: conditionId, note_date: closing_date, evidence: evidence.map((e) => ({ ...e, classified_at: clock.now() })) }, UNDERWRITER);
  // the FAKE underwriting reviewer signs the clearance (DELTA-30): 23.3 rule 3 sends any evaluation with a pending-review finding (a document's age against the closing date) to `underwriting_reviewer`
  await tool(b.app_id, "23.3", "clearCondition", { condition_id: conditionId, evaluation: ev.output, closing_date, notes: `FAKE reviewer: ${evidence.map((e) => e.kind).join(" + ")} reviewed by 22.1; cleared automatically (INTEGRATIONS=fake, DELTA-30)` }, REVIEWER); await settle();
}
/** The evidence kind each platform-owned DU condition accepts (23.2's catalogue): the platform's own document, cleared by the FAKE underwriting reviewer — a DU verification message is never waived (23.3 WAIVER_NOT_PERMITTED_DU_MESSAGE). */
const PLATFORM_EVIDENCE: Readonly<Record<string, string>> = { COND_DU_VERIFY_EMPLOYMENT_VOE: "vvoe_record", COND_DU_TITLE_COMMITMENT: "title_commitment", COND_DU_PAYOFF_EXISTING_LIEN: "payoff_statement", COND_DU_IDENTITY_VERIFICATION: "government_id", COND_DU_FLOOD_DETERMINATION: "flood_determination" };
/** Every open condition the borrower does not hold the document for is the platform's (the employer, the title company, the prior servicer, the identity vendor, the flood vendor): its evidence arrives outside the thread and the FAKE reviewer clears it. */
async function clearPlatformConditions(b: Borrower, borrowerCodes: readonly string[], dated: string, closing_date: string): Promise<void> {
  for (const x of (await entitiesOf("conditions", b.app_id)).filter((y) => !borrowerCodes.includes(String(y.data["template_code"])))) {
    if (["cleared", "waived"].includes(String((await entity("conditions", x.id))?.["status"]))) continue;
    const code = String(x.data["template_code"]); const kind = PLATFORM_EVIDENCE[code] ?? (Array.isArray(x.data["evidence_kinds"]) ? String((x.data["evidence_kinds"] as unknown[])[0] ?? "") : ""); assert.ok(kind, `an evidence kind for the platform's ${code} (${JSON.stringify(x.data["evidence_kinds"])})`);
    await clear(b, x.id, [{ document_id: `doc-${kind}-${R}`, kind, document_date: dated }], closing_date);
  }
}

// ═══════════════════════════════════ the audit at the end of a persona's journey (docs/ux/17 §9 T-17-…; the eval harness's checks)
const ROUTE_CARD_TRIGGER: Readonly<Record<string, string>> = { stripe_identity: "identity.session" };   // routes.ts creates the Stripe ConnectCard itself (ui.createCard, no card.sent): the identity session is what raised it
async function audit(b: Borrower, o: { minCards: number; subjects: string[] }): Promise<{ cases: Map<string, number>; cards: CardRow[]; byKind: Map<string, number> }> {
  const cards = await b.cards(); const t = await b.thread(); const turns = await b.turns();
  // ---- every card is one of the four §2.3 cases through its kind and what raised it (32.16 T28's contract: the flows registry's triggers on the commit)
  const cases = new Map<string, number>(); const byKind = new Map<string, number>(); const failures: string[] = []; const lines: string[] = [];
  for (const c of cards) {
    const contexts = router.flows!.triggerOf(c.card_instance_id); let triggers = contexts ? [...new Set(contexts.flatMap((x) => x.triggers))] : [];
    if (!triggers.length && c.kind === "ConnectCard" && ROUTE_CARD_TRIGGER[String(c.props["vendor"])]) triggers = [ROUTE_CARD_TRIGGER[String(c.props["vendor"])]!];
    byKind.set(c.kind, (byKind.get(c.kind) ?? 0) + 1);
    try { const cs = assertCardCase({ kind: c.kind, copy_key: c.copy_key, trigger: triggers.length ? triggers : CHAT_TRIGGER, command_ref: c.command_ref, created_by: c.created_by }); cases.set(cs, (cases.get(cs) ?? 0) + 1); lines.push(`${c.kind} ${c.copy_key} [${cs}] ← ${triggers.join("|") || CHAT_TRIGGER} (${c.status})`); }
    catch (e) { failures.push(e instanceof Error ? e.message : String(e)); }
  }
  assert.deepEqual(failures, [], `cards outside §2.3:\n${failures.join("\n")}`);
  for (const kind of new Set(cards.map((c) => c.kind))) assert.ok(CARD_CASES[kind], `${kind} has a §2.3 case`); assert.equal(cardCaseOf("StatusCard", CHAT_TRIGGER), null);
  assert.ok(cards.length >= o.minCards, `about ${o.minCards} cards over the journey (§2.3): ${cards.length}`);
  // ---- no agent message carries a figure a tool did not supply; none equals a docs/ux/12 template
  const messages: EvalMessage[] = t.messages.map((m) => ({ message_id: String(m["message_id"]), sender: m["sender"] as EvalMessage["sender"], body_text: (m["body_text"] as string | null) ?? null, at: String(m["at"]), card_instance_id: (m["card_instance_id"] as string | null) ?? null, copy_tokens: (m["copy_tokens"] as Json | null) ?? null }));
  const evalCards: EvalCard[] = cards.map((c) => ({ card_instance_id: c.card_instance_id, kind: c.kind, status: c.status, copy_key: c.copy_key, command_ref: c.command_ref, props: c.props, evidence: c.evidence, created_at: c.created_at, resolved_at: c.resolved_at }));
  const records: Json[] = []; for (const s of o.subjects) records.push(await b.record(s));
  const provenance = provenanceCheck({ messages, record: Object.assign({}, ...records) as Json, cards: evalCards }); assert.ok(provenance.pass, `provenance: ${JSON.stringify(provenance).slice(0, 1200)}`);
  const verbatim = verbatimCheck({ messages, templates: copyTemplates() }); assert.ok(verbatim.pass, `verbatim: ${JSON.stringify(verbatim).slice(0, 800)}`);
  const modelReplies = messages.filter((m) => m.sender === "agent" && m.copy_tokens?.["source"] === "agent_turn");
  assert.ok(modelReplies.length >= 10, `the assistant spoke in its own words (${modelReplies.length} turns)`);
  for (const m of modelReplies) { assert.equal(m.copy_tokens?.["fallback"], undefined, `no default copy stood in for the model (${m.message_id}: ${JSON.stringify(m.copy_tokens)})`); assert.doesNotMatch(m.body_text ?? "", /^\{\{copy:/); }
  // ---- no agent reply is a bare line: at least MIN_REPLY_WORDS words, never a bare question (the demo's "What next?") — the guard's substance check, re-asserted over the thread
  for (const m of modelReplies) { const v = substanceViolation(m.body_text ?? "", {}); assert.equal(v, null, `a thin reply reached the thread (${m.message_id}): ${v}`); assert.ok((m.body_text ?? "").split(/\s+/).filter(Boolean).length >= MIN_REPLY_WORDS); }
  // ---- every fact on the application has a card.resolved behind it (the six items, the fields, the liabilities, the declarations, the demographics, the goal)
  const evs: EvalEvent[] = (await events(b.app_id)).map((e) => ({ type: e.type, occurred_at: e.occurred_at, payload: e.payload, application_id: e.application_id, loan_id: e.loan_id }));
  const cardEvents: EvalCardEvent[] = (await db.query<{ card_instance_id: string; to_status: string; at: string }>(`SELECT e.card_instance_id, e.to_status::text AS to_status, e.at FROM card_instance_events e JOIN card_instances c ON c.card_instance_id = e.card_instance_id WHERE c.party_id = $1`, [b.party_id]));
  const facts = factsOf(evs); assert.ok(facts.length >= 10, `facts captured through cards: ${facts.length}`);
  const evidence = evidenceCheck({ facts, resolutions: resolutionsOf(evalCards, evs, cardEvents), commands: commandsOf(evs) }); assert.ok(evidence.pass, `evidence: ${JSON.stringify(evidence).slice(0, 1500)}`);
  // ---- agent_turns: one row per turn with its guard result, the model and prompt versions, the reply it appended; no turn fell back
  for (const m of modelReplies) { const row = turns.find((x) => x.turn_id === m.copy_tokens?.["turn_id"]); assert.ok(row, `an agent_turns row for turn ${m.copy_tokens?.["turn_id"]}`); assert.equal(row.reply_message_id, m.message_id); assert.equal(row.model_version, "scripted"); assert.equal(row.prompt_version, PROMPT_VERSION); assert.equal((row.guard_result as Json)["ok"], true, JSON.stringify(row.guard_result)); assert.ok(typeof (row.guard_result as Json)["checks"] === "object"); }
  assert.equal(turns.filter((x) => x.reply_message_id !== null).length, modelReplies.length, "one accepted turn per model reply");
  for (const x of turns) assert.match(x.context_hash, /^[0-9a-f]{64}$/);
  process.stderr.write(`conversation ${b.name}: ${cards.length} cards — ${[...byKind].map(([k, n]) => `${k}×${n}`).join(", ")}; cases ${JSON.stringify([...cases])}; ${modelReplies.length} model turns, ${b.said.length} borrower lines\n${lines.join("\n")}\n`);
  return { cases, cards, byKind };
}

// ═══════════════════════════════════ the three defects the live demo showed (reproduced through the API, then fixed in record.ts / guard.ts / routes.ts)
test("conversation: the demo's three defects — a goal answered Buy a home reads purchase on the record (subject, label, journey), the reply after it leads with the next item and is never a bare question, and the borrower's own line is on the thread with the reply and the stream hub told", { skip }, async () => {
  const b = new Borrower(`demo-${R}@example.test`, `pw-demo-${R}`, "Demo Buyer", "123-45-1111", "1990-01-01");
  clock.set(START); await b.signUp();
  // the organic application opened at the account door carries the door's placeholder until the goal is tapped
  let rec = await b.record(); assert.equal((rec["subject"] as Json)["transaction_type"], "limited_cash_out", "the door's placeholder"); assert.equal(((rec["journey_progress"] as Json)["steps"] as Json[])[0]!["id"], "R1");
  const notified: string[] = []; const hub = router.hub; const orig = hub.notify.bind(hub);
  hub.notify = (partyId, e) => { if (partyId === b.party_id) notified.push(e.ref); return orig(partyId, e); };
  try {
    // (3) the borrower's own typed line: the thread carries the borrower row and the reply row after POST /v1/borrower/messages, and the hub was told about both
    later(1); const r = await b.say("Buy a home");   // the goal card's own affirmative: on the app with the turn configured it goes to the turn, which proposes into the card (commands.ts)
    await assertModelReply(b, r, { proposedInto: "entry.goal.question", text: /Buy a home/ });
    const th = await b.thread(); const mine = th.messages.filter((m) => m["sender"] === "borrower"); const myId = String((r.body["message"] as Json)["message_id"]);
    assert.equal(mine.length, 1, "the borrower's row is on the thread"); assert.equal(mine[0]!["body_text"], "Buy a home"); assert.equal(mine[0]!["message_id"], myId); assert.ok(String(mine[0]!["sender_label"]), "the borrower row carries a sender label (the party's provisional name until the ID scan names them)");
    const replyIx = th.messages.findIndex((m) => m["message_id"] === r.reply["message_id"]); assert.ok(replyIx > th.messages.findIndex((m) => m["message_id"] === myId), "the reply row follows the borrower's row");
    assert.ok(notified.includes(myId), `the stream hub was told about the borrower's row (${notified.length} notifications)`); assert.ok(notified.includes(String(r.reply["message_id"])), "…and about the reply");
    // (1) the goal card resolves to Buy a home: the record's subject, its label and the journey read purchase
    const goal = await b.pending("entry.goal.question"); later(1); const g = await b.tap(goal, { option_id: "buy", evidence: { option_id: "buy", tapped_at: clock.now() } }); assert.equal(g.body["command"], "application.setGoal");
    const row = (await db.query<{ transaction_type: string; occupancy: string }>(`SELECT transaction_type::text AS transaction_type, occupancy::text AS occupancy FROM applications WHERE id = $1`, [b.app_id]))[0]!;
    assert.equal(row.transaction_type, "purchase", "applications.transaction_type follows the goal (section32-2.ts setGoal's deferred UPDATE, committed with the command)"); assert.equal(row.occupancy, "primary");
    rec = await b.record(); const subj = rec["subject"] as Json;
    assert.equal(subj["transaction_type"], "purchase"); assert.equal(subj["occupancy"], "primary"); assert.equal(subj["stage"], "origination");
    assert.doesNotMatch(String(subj["label"]), /^(Refinancing|Buying)$/, "the loan label is never the purpose word (the app's header is purpose · loan label)"); assert.match(String(subj["label"]), /^Application ····[0-9a-f]{4}$/);
    const steps = (rec["journey_progress"] as Json)["steps"] as Json[]; assert.equal(steps[0]!["id"], "P1", "the purchase journey"); assert.equal(steps.length, 16); assert.equal((rec["journey_progress"] as Json)["total"], 16);
    assert.ok((await b.cards()).some((x) => x.copy_key === "preapproval.intro"), "the purchase path's first card");
    // (2) the reply to the next message leads with the next item: a model that answers "What next?" is refused by the guard (substance) and regenerated once; the accepted line carries the item
    later(1); const r2 = await b.say("Anything else you need from me?");
    const rows = (await b.turns()).filter((x) => x.message_id === String((r2.body["message"] as Json)["message_id"])).sort((x, y) => Number((x.guard_result as Json)["attempt"]) - Number((y.guard_result as Json)["attempt"]));
    assert.equal(rows.length, 2, "the rejected attempt and the accepted one are both agent_turns rows");
    assert.equal((rows[0]!.guard_result as Json)["rejected_by"], "substance"); assert.match(String((rows[0]!.guard_result as Json)["violation"]), /bare question|What next/); assert.equal(rows[0]!.reply_message_id, null);
    assert.equal((rows[1]!.guard_result as Json)["ok"], true); assert.equal(rows[1]!.reply_message_id, r2.reply["message_id"]); assert.equal((r2.reply["copy_tokens"] as Json)["fallback"], undefined, "the regenerated line stood, not the default copy");
    assert.match(String(r2.reply["body_text"]), /next thing for you is on the card here/); assert.ok(String(r2.reply["body_text"]).split(/\s+/).length >= MIN_REPLY_WORDS);
    later(1); const r3 = await b.say("So what's next?"); await assertModelReply(b, r3, { text: /Right now the loan needs one thing from you/ });
    assert.notEqual(String(r3.reply["body_text"]).trim(), "What next?");
    for (const m of (await b.thread()).messages.filter((x) => x["sender"] === "agent" && (x["copy_tokens"] as Json | null)?.["source"] === "agent_turn")) assert.equal(substanceViolation(String(m["body_text"]), {}), null, `every agent reply says what comes next: ${m["body_text"]}`);
  } finally { hub.notify = orig; }
});

// ═══════════════════════════════════ the refinance persona: Morgan Ellis lowers the payment on 100 N Central Ave, Phoenix
test("conversation: the refinance persona goes from sign-up to a boarded loan by talking — a card only where §2.3 requires one, every commit a tap, the FAKE vendors and reviewers in between", { skip }, async () => {
  const b = new Borrower(`morgan-${R}@example.test`, `pw-morgan-${R}`, "Morgan Ellis", "123-45-6789", "1988-03-14");
  const f: RefiFacts = { name: b.name, last: "Ellis", email: b.email, address: "100 N Central Ave, Phoenix, AZ 85004", quoteId: `Q-M-${R}`, lockQuoteId: "", decisionId: `D-REFI-M-${R}` };
  // ── E1–E3: the account, the disclosure, the greeting in the model's words, the goal proposed and confirmed
  clock.set(START); await b.signUp(); J.appId = b.app_id;
  const t0 = await b.thread(); const agent0 = t0.messages.filter((m) => m["sender"] !== "borrower");
  assert.equal(agent0[0]!["body_text"], "{{copy:entry.disclosure.first}}"); assert.equal(agent0[0]!["sender"], "system");
  const greeting = agent0.find((m) => (m["copy_tokens"] as Json | null)?.["source"] === "agent_turn")!; assert.ok(greeting, "the first turn greeted"); assert.match(String(greeting["body_text"]), /^Hi \S+, welcome\. Are you here to buy a home/); assert.equal(t0.pinned_card?.["copy_key"], "entry.goal.question");
  const first = (await b.turns()).find((x) => x.message_id === null)!; assert.ok(first, "the first turn's agent_turns row (no borrower message)"); assert.equal((first.guard_result as Json)["ok"], true);
  later(1); let r = await b.say("I want to lower my payment on the house.");
  await assertModelReply(b, r, { proposedInto: "entry.goal.question", text: /Lower my rate or payment/ });
  const goal = await b.pending("entry.goal.question"); assert.equal((goal.props["proposal"] as Json)["option_id"], "lower_rate");
  later(1); const g = await b.tap(goal, { option_id: "lower_rate", evidence: { option_id: "lower_rate", tapped_at: clock.now() } }); assert.ok((g.body["events"] as string[]).includes("application.received"), JSON.stringify(g.body["events"]));
  assert.equal((await events(b.app_id, "application.goal.set")).length + (await events(b.app_id, "application.received")).length >= 1, true);
  // ── E6: the consents as cards; the model's attempt to take one in words is refused by the tool
  later(1); r = await b.say("Just put me down as consenting to e-delivery, I do not want to tap anything.");
  await assertModelReply(b, r, { refused: "CARD_PROPOSE_KIND", text: /can't take a consent in words/ });
  const esign = await b.pending("consent.esign.title"); assert.equal(esign.status, "pending", "nothing resolved from words");
  later(1); const c = await b.tap(esign, { evidence: { affirmation_method: "checkbox_with_text", typed_name: b.name, checkbox: true, disclosure_version_shown: esign.props["disclosure_version_id"] } });
  const consentId = String((c.body["result"] as Json)["consent_id"]); assert.equal((await db.query<{ status: string }>(`SELECT status FROM consents WHERE id = $1`, [consentId]))[0]!.status, "pending_verification");
  later(1); const verify = await api("POST", "/v1/borrower/commands/consent.capture", { op: "verify", consent_id: consentId, token: esignVerificationToken(consentId), scope: ["disclosures", "notices"] }, bearer(b.token)); assert.equal(verify.status, 200, JSON.stringify(verify.body)); await settle();
  assert.equal((await db.query<{ status: string }>(`SELECT status FROM consents WHERE id = $1`, [consentId]))[0]!.status, "active");
  const tcpa = await b.pending("consent.tcpa.title"); later(1); await b.tap(tcpa, { evidence: { affirmation_method: "checkbox_with_text", typed_name: b.name, checkbox: true, disclosure_version_shown: tcpa.props["disclosure_version_id"] } });
  // ── E5: the ID scan (Stripe FAKE) before the hard pull — the ConnectCard the identity session raises, the FAKE extraction, the webhook → L3 and the identity ConfirmCard
  later(1); const vs = await api("POST", "/v1/borrower/identity/stripe/session", { application_id: b.app_id }, bearer(b.token)); assert.equal(vs.status, 200, JSON.stringify(vs.body));
  (router.stripe as FakeStripeIdentity).complete(vs.body["vendor_session_id"] as string, clock.now(), { legal_name: b.name, date_of_birth: b.dob, address: f.address });
  const hook = await api("POST", "/v1/webhooks/stripe", { id: `evt-${R}`, type: "identity.verification_session.verified", data: { object: { id: vs.body["vendor_session_id"], status: "verified" } } }, { "stripe-signature": "FAKE" }); assert.equal(hook.status, 200, JSON.stringify(hook.body)); assert.equal(hook.body["level"], "L3"); await settle();
  const identity = await b.pending("identity.confirm.title"); assert.deepEqual((identity.props["fields"] as { path: string; value: string; source: string }[]).map((x) => [x.path, x.value, x.source]), [["legal_name", b.name, "stripe_identity"], ["date_of_birth", b.dob, "stripe_identity"], ["current_address", f.address, "stripe_identity"]]);
  later(1); await b.tap(identity, fieldsEvidence(identity));
  // the SSN: the model's attempt to repeat it is refused (a masked path); the borrower types it on the card
  later(1); r = await b.say(`My social security number is ${b.ssn}`); await assertModelReply(b, r, { refused: "CARD_PROPOSE_MASKED", text: /never repeat that here/ });
  const ssn = await b.pending("identity.ssn.title"); later(1); await b.tap(ssn, fieldsEvidence(ssn, { ssn: b.ssn }));
  const ssnCard = (await b.cards()).find((x) => x.card_instance_id === ssn.card_instance_id)!; assert.ok(!JSON.stringify(ssnCard.evidence).includes(b.ssn.replace(/\D/g, "")) && !JSON.stringify(ssnCard.evidence).includes(b.ssn), "the SSN never sits on the card");
  assert.ok(!(await b.thread()).messages.some((m) => m["sender"] !== "borrower" && String(m["body_text"] ?? "").includes(b.last4)), "the assistant never repeated the number");
  // ── R1: the home, proposed and confirmed
  later(1); r = await b.say("It is my main home, at 100 N Central Ave in Phoenix, and I live there."); await assertModelReply(b, r, { proposedInto: "refi.home.confirm", text: /100 N Central Ave/ });
  const home = await b.pending("refi.home.confirm"); later(1); await b.tap(home, proposalEvidence(home));
  assert.equal((await events(b.app_id, "application.six_item.captured")).filter((e) => e.payload["item"] === "property_address").length, 1);
  // the credit authorization (L3 in this sitting) — a ConsentCard, typed name; then the payroll connection card stays for later
  const credit = await b.pending("consent.credit.title"); assert.equal(credit.props["requires_level"], "L3");
  later(1); await b.tap(credit, { evidence: { affirmation_method: "checkbox_with_text", typed_name: b.name, checkbox: true, disclosure_version_shown: credit.props["disclosure_version_id"] } });
  assert.equal((await events(b.app_id, "credit.authorization.captured")).filter((e) => e.payload["card_instance_id"] === credit.card_instance_id).length, 1, "32.2's authorization event names the card (20.3 captureConsent appends the lead's own row beside it)");
  // ── R3: income typed (the card on request, the figure proposed, the tap), then assets typed with the figure as the card's default
  later(1); r = await b.say("I would rather type my income than connect payroll."); await assertModelReply(b, r, { text: /income card is on the rail/ });
  const typedIncome = await b.pending("income.confirm.title"); assert.equal(typedIncome.created_by, "agent:intake"); assert.equal(typedIncome.props["requested_by"], "card.request");
  later(1); r = await b.say("About 8,200 a month at Acme Manufacturing."); await assertModelReply(b, r, { proposedInto: "income.confirm.title", text: /\$8,200\.00 a month at Acme Manufacturing/ });
  const incomeBefore = await db.query(`SELECT 1 FROM application_income WHERE application_id = $1`, [b.app_id]); assert.equal(incomeBefore.length, 0, "nothing written from words");
  later(1); await b.tap(typedIncome, proposalEvidence(await b.pending("income.confirm.title", (x) => x.card_instance_id === typedIncome.card_instance_id)));   // the row re-read: the proposal landed on it after the first read
  const incomeRows = await db.query<{ monthly_amount_cents: string; calculation: Json }>(`SELECT monthly_amount_cents::text AS monthly_amount_cents, calculation FROM application_income WHERE application_id = $1 ORDER BY created_at`, [b.app_id]); assert.equal(incomeRows.length, 1); assert.equal(incomeRows[0]!.monthly_amount_cents, "820000"); assert.equal(incomeRows[0]!.calculation["source"], "borrower");
  later(1); r = await b.say("I have about 40k in checking at Chase."); await assertModelReply(b, r, { text: /account card is on the rail/ });
  const assets = await b.pending("assets.confirm.title"); assert.equal((assets.props["fields"] as { path: string; value: string }[]).find((x) => x.path === "asset_balance_cents")!.value, "4000000");
  later(1); await b.tap(assets, { evidence: { source: "borrower_stated", fields: [{ path: "asset_institution", value: "Chase" }, { path: "asset_account_type", value: "checking" }, { path: "asset_balance_cents", value: "4000000" }], tapped_at: clock.now() } });
  // ── R3 again: employment through the Truv FAKE — the ConnectCard tap, the vendor session, the webhook → the income ConfirmCard from the report, confirmed
  const connect = await b.pending("income.connect.purpose"); later(1); await b.tap(connect, { evidence: { vendor: "truv_income", started_at: clock.now() } });
  const ts = await api("POST", "/v1/borrower/connect/truv_income/session", { card_instance_id: connect.card_instance_id }, bearer(b.token)); assert.equal(ts.status, 200, JSON.stringify(ts.body));
  later(1); const truv = await api("POST", "/v1/webhooks/truv", { type: "voie.report.ready", data: { vendor_session_id: ts.body["vendor_session_id"], report: { employer: "Acme Manufacturing (FAKE payroll)", monthly_base_cents: "820000" } } }, { "x-truv-signature": "FAKE" }); assert.equal(truv.status, 200, JSON.stringify(truv.body)); await settle();
  const payroll = await b.pending("income.confirm.title", (x) => x.props["requested_by"] !== "card.request"); assert.equal((payroll.props["fields"] as { path: string; value: string; source: string }[]).find((x) => x.path === "monthly_base_cents")!.source, "payroll_connection");
  later(1); await b.tap(payroll, fieldsEvidence(payroll));
  // ── R4–R6: the profile proposed and confirmed; the declarations and the demographics never in words (refused), then tapped
  later(1); r = await b.say("I am a US citizen, not married, no dependents, never served in the military, and English is fine."); await assertModelReply(b, r, { proposedInto: "profile.title", text: /U\.S\. citizen, Unmarried, dependents 0/ });
  const profile = await b.pending("profile.title"); const pf = (profile.props["proposal"] as { fields: { path: string; value: string }[] }).fields;
  later(1); await b.tap(profile, { option_id: "submit", evidence: { fields: pf.map((x) => ({ path: x.path, value: x.value, answered_at: clock.now() })) } });
  later(1); r = await b.say("Just mark the declarations as all no for me."); await assertModelReply(b, r, { refused: "CARD_PROPOSE_NEVER_IN_WORDS", text: /yours to give/ });
  const decl = await b.pending("declarations.title"); assert.equal(decl.props["proposal"], undefined, "no proposal reached the declarations card");
  later(1); await b.tap(decl, { option_id: "none", evidence: { option_id: "none", tapped_at: clock.now() } }); assert.equal((await events(b.app_id, "application.declarations.answered")).length, 1);
  later(1); r = await b.say("I am a white woman, not hispanic, if that matters."); await assertModelReply(b, r, { refused: "CARD_PROPOSE_KIND", text: /answered on the card only/ });
  const demo = await b.pending("demographics.title"); later(1); await b.tap(demo, { option_id: "submit", evidence: { collection_method: "internet", answered_at: clock.now(), answers: { ethnicity: ["not_hispanic_or_latino"], race: ["white"], sex: "female" } } });
  assert.equal((await events(b.app_id, "application.demographics.collected")).length, 1);
  // ── R7: the six items — the value, the amount and the product proposed into their three cards in one turn, each confirmed; the sixth item is the TRID moment
  later(1); r = await b.say("The house is worth about 800,000 and I owe about 560,000 on it; keep it a thirty year fixed."); const six = await assertModelReply(b, r, { text: /\$800,000\.00.*\$560,000\.00.*30-year fixed/ });
  assert.equal(six.tool_calls.filter((x) => x["name"] === "card.propose" && x["is_error"] === false).length, 3, "three proposals in the turn");
  const value = await b.pending("refi.value.confirm"); later(1); await b.tap(value, proposalEvidence(value));
  const product = await b.pending("refi.product.choice"); later(1); await b.tap(product, { option_id: "FRM30", evidence: { option_id: "FRM30", tapped_at: clock.now() } });
  assert.equal((await events(b.app_id, "application.trid_received")).length, 0, "five of six");
  const amount = await b.pending("refi.loan_amount.confirm"); later(1); const sixth = await b.tap(amount, proposalEvidence(amount)); assert.ok((sixth.body["events"] as string[]).includes("application.trid_received"), JSON.stringify(sixth.body["events"]));
  const tridAt = clock.now(); assert.equal((await timer(b.app_id, "REGZ_1026_19E1_LE_3BD"))?.status, "armed");
  assert.ok((await b.cards()).some((x) => x.copy_key === "application.received" && x.kind === "StatusCard"), "the TRID StatusCard");
  // ── R2 (the platform): the credit report on the authorization → the liabilities and current-loan cards, narrated, then tapped
  later(2); const reportId = await orderCredit(b, clock.now());
  later(1); r = await b.say("What are those debts on my report about?"); await assertModelReply(b, r, { text: /debts card shows what your report lists/ });
  const liabilities = await b.pending("credit.liabilities.confirm"); later(1); await b.tap(liabilities, fieldsEvidence(liabilities));
  const current = await b.pending("refi.current_loan.confirm"); later(1); await b.tap(current, fieldsEvidence(current));
  // ── R9 (the platform): the day's sheet, the personalized quote under the FAKE MLO's review (approved on the sweep), the terms presented, then the LE e-delivered under the E-SIGN consent
  await publishSheet("2026-10-19"); later(2); await priceAndReview(b, "56000000", "80000000", "limited_cash_out", null, f.quoteId);
  clock.set(EDT("2026-10-19", "16:00"));
  const le = await deliverLeByConsent(runtime, b.app_id, { render: leRender(b, { as_of: "2026-10-19", property_address: f.address, pricing: { quote_id: f.quoteId, rate_pct: "6.125", price: "100.000", points_cents: "0", lender_credit_cents: "261700", locked: false } }) as never, mlo: { review_id: `MR-LE-M-${R}`, nmlsr_id: "987654" }, actor: MLO });
  assert.equal(le.channel, "esign_portal"); assert.deepEqual(le.consent_ids, [consentId]); const leId = le.result.disclosure_id; await settle();
  assert.equal((await timer(b.app_id, "REGZ_1026_19E1_LE_3BD"))?.status, "satisfied", `the LE within three business days of ${tridAt}`);
  // the borrower is back (a fresh sitting: password + L2 now that the SSN and birth date are on file): the LE DocumentCard, narrated, received by the tap
  clock.set(EDT("2026-10-19", "16:30")); await b.signIn("L2");
  r = await b.say("I got the loan estimate, what do I do with it?"); await assertModelReply(b, r, { text: /Loan Estimate is here as a document/ });
  const leCard = await b.pending("le.delivered"); assert.equal(leCard.kind, "DocumentCard"); assert.equal(leCard.props["disclosure_id"], leId);
  later(2); await b.tap(leCard, { option_id: "confirm", evidence: { opened_at: clock.now(), scrolled_to_end: true } });
  assert.equal((await events(b.app_id, "disclosure.le.received")).length, 1); assert.ok(await b.pending("intent.title").catch(() => null), "the Proceed ChoiceCard after receipt");
  // ── R10–R11: Tue Oct 20 — the day's sheet and 21.4's quote (the lock's basis, inside its validity), the go-ahead tapped, the lock ComparisonCard from the valid quotes, the lock tapped
  await advance(MST("2026-10-20", "10:05")); await publishSheet("2026-10-20");
  const lq = await tool(b.app_id, "21.4", "getQuote", { loan_amount_cents: "56000000", product_code: "FRM30_CONV", note_rate_pct: "6.125", lock_period_days: 45, at: clock.now() }, PRICING); f.lockQuoteId = lq.output["quote_id"] as string;
  later(3); await b.signIn("L2");
  r = await b.say("I read it and I am happy with it, ready to move forward."); await assertModelReply(b, r, { text: /go-ahead is a card/ });
  const intent = await b.pending("intent.title"); later(1); const p = await b.tap(intent, { option_id: "proceed", evidence: { option_id: "proceed", tapped_at: clock.now() } }); assert.equal((p.body["result"] as Json)["valid"], true);
  const compare = await b.pending("lock.compare.title"); assert.equal(compare.kind, "ComparisonCard"); assert.ok((compare.props["columns"] as Json[]).some((x) => x["id"] === f.lockQuoteId), "the 21.4 quote is a column"); assert.equal((compare.props["command_args"] as Json)["property_state"], "AZ", "the lock request knows the home's state");
  later(1); r = await b.say("Which lock should I pick?"); await assertModelReply(b, r, { text: /lock card shows the choices/ });
  later(1); const locked = await b.tap(compare, { option_id: f.lockQuoteId, evidence: { option_id: f.lockQuoteId, tapped_at: clock.now() } }); assert.equal(locked.body["command"], "lock.request"); const lockId = String((locked.body["result"] as Json)["lock_id"]); assert.equal((locked.body["result"] as Json)["status"], "pending_mlo_approval");
  // the MLO of record approves and executes the lock (21.4's own tools — the FAKE reviewer closes the queue item but the lock's approval is the MLO's act on the lock itself; noted in the report); 29.1 takes the commitment
  clock.set(MST("2026-10-20", "10:19"));
  await tool(b.app_id, "21.4", "executeLock", { lock_id: lockId, op: "approve", quote_id: f.lockQuoteId, mlo_nmlsr_id: "987654", approved_at: clock.now() }, MLO);
  const lock = await tool(b.app_id, "21.4", "executeLock", { lock_id: lockId, executed_at: clock.now() }, PRICING); assert.equal(lock.output["status"], "executed");
  await tool(b.app_id, "21.4", "requestCommitment", { lock_id: lockId, at: MST("2026-10-20", "10:20") }, PRICING); await settle();
  assert.ok((await b.cards()).some((x) => x.copy_key === "lock.executed"), "the lock StatusCard");
  // ── the appraisal (24.1) the same morning — after the intent (24.1 R2 refuses an SM-borne order before it) and before DU (24.1 reads the DU offer as a string while 23.1's FAKE findings carry an object; journey.ts orders before DU for the same reason): the order, the appraiser assigned (SM_APPRAISER_LICENSE_GATE) → the access ScheduleCard, narrated, the window tapped
  clock.set(MST("2026-10-20", "10:30")); await tool(b.app_id, "24.1", "readDuOffer", {}, VALUATION);
  const vo = await tool(b.app_id, "24.1", "placeOrder", { transaction_type: "limited_cash_out", occupancy: "primary", units: 1, property_type: "sfr", ltv_bps: 7000, fee_paid_by: "sm", fee_quote_cents: "65000", fee_test: K<Json>("FEE_TEST"), property_state: "AZ", vendor_party_id: "amc-1", channel: "amc", amc_registration: K<Json>("AMC_REG"), order_payload: { ...K<Json>("ORDER_PAYLOAD"), access_contact: { name: b.name, phone: "602-555-0101" } }, le_effective_receipt_date: "2026-10-19", ordered_at: clock.now(), time_zone: TZ }, VALUATION);
  const orderId = vo.output["order_id"] as string;
  const assigned = await tool(b.app_id, "24.1", "verifyAppraiserLicense", { order_id: orderId, assigned_at: MST("2026-10-20", "10:45"), appraiser: { party_id: `APR-AZ-${R}`, license_state: "AZ", license_type: "certified_residential", license_number: "AZ-CR-12345", license_expires_on: "2027-12-31", asc_registry_status: "active", asc_registry_checked_on: "2026-10-20" } }, VALUATION); assert.equal(assigned.output["status"], "assigned"); await settle();
  later(1); r = await b.say("When does the appraiser come by?"); await assertModelReply(b, r, { text: /schedule card here/ });
  const access = await b.pending("valuation.schedule"); assert.equal(access.kind, "ScheduleCard"); const slot = (access.props["slots"] as { id: string; starts_at: string }[])[2]!;
  later(1); const sched = await b.tap(access, { option_id: slot.id, evidence: { slot_id: slot.id } }); assert.equal(sched.body["command"], "valuation.scheduleAccess");
  assert.equal((await events(b.app_id, "valuation.inspection.scheduled")).length, 1);
  // the revised LE (v2) under the lock's changed circumstance, e-delivered Wed Oct 21 → the DocumentCard, received by the tap
  await advance(EDT("2026-10-21", "09:00"));
  const cc = lock.events.find((e) => e.type === "changed_circumstance.recorded")!; const consent = (await db.query<{ id: string; scope: string[]; captured_at: string }>(`SELECT id, scope, captured_at FROM consents WHERE id = $1`, [consentId]))[0]!;
  const v2 = leRender(b, { as_of: "2026-10-21", property_address: f.address, disclosure_id: `LE-${b.app_id.slice(0, 8)}-2`, pricing: { quote_id: f.lockQuoteId, rate_pct: "6.125", price: "100.000", points_cents: "0", lender_credit_cents: "261700", locked: true, lock_expires_at: String(lock.output["expires_at"]), lock_time_zone: TZ }, cc_ids: [cc.payload["cc_id"]] });
  await tool(b.app_id, "21.5", "renderRevisedLE", { ...v2, fees: (v2["fees"] as Json[]).map((x) => ({ ...x, estimated_at: "2026-10-21" })) }, DISCLOSURE);
  await tool(b.app_id, "21.5", "deliverDisclosure", { disclosure_id: v2["disclosure_id"], channel: "esign_portal", at: EDT("2026-10-21", "09:05"), consent: { id: consent.id, scope: consent.scope, granted_at: consent.captured_at } }, DISCLOSURE); await settle();
  // ── R8 (the platform): DU (FAKE) Wed Oct 21 → the findings interpreted → the conditions → the UploadCards; the model narrates the list in plain words; the uploads are taps, 22.1 reviews, 23.3 clears
  const du = await duRun(b, f, reportId, { findings_at: MST("2026-10-21", "09:00"), interpreted_at: MST("2026-10-21", "09:12") });
  const conds = await entitiesOf("conditions", b.app_id); const cond = (code: string) => { const x = conds.find((y) => y.data["template_code"] === code); assert.ok(x, `condition ${code}`); return x; };
  // ── the decision (23.3) the same morning: the conditional approval while its conditions are open (rule 2: the letter lists the borrower-facing ones), its letter → the StatusCard and the NoticeCard
  clock.set(MST("2026-10-21", "09:30"));
  await tool(b.app_id, "23.3", "assessRisk", { risk_input: K<Json>("RISK"), decision_id: f.decisionId }, UNDERWRITER);
  const file = newDecisionFile({ application_id: b.app_id, partner_name: partnerName, partner_address: "100 Partner Plaza, Phoenix, AZ 85004", creditor_time_zone: TZ, application_date: "2026-10-19", property_state: "AZ", applicants: [{ id: "B1", name: b.name, mailing_address: f.address, email: b.email, esign_consent: true, primary: true }] });
  const approval = await tool(b.app_id, "23.3", "issueConditionalApproval", { decision_id: f.decisionId, file, guard: K<Json>("GUARD"), validity: { credit_expires_at: "2027-02-19", lock_expires_at: String(lock.output["expires_on"]), valuation_expires_at: "2027-02-06", du_close_by_date: "2026-12-07" }, inputs: { ulad_snapshot_hash: du.request_hash, verification_ids: [], findings_hash: "findings:sub1" }, du_submission_id: du.submission_id, interpretation_id: du.interpretation_id, evidence_document_ids: [], rationale: "Approve/Eligible loan within policy; verified income and liabilities reconcile to DU; no layering.", confidence: 0.94 }, UNDERWRITER);
  assert.ok(approval.output["valid_until"]);
  await tool(b.app_id, "23.3", "renderApprovalLetter", { decision_id: f.decisionId, letter: { creditor_name: partnerName, creditor_nmlsr_id: "123456", creditor_address: "100 Partner Plaza, Phoenix, AZ 85004", mlo_name: "Jordan Rivera", mlo_nmlsr_id: "987654", applicant_name: b.name, property_address: f.address, terms: { loan_amount_cents: "56000000", note_rate_pct: "6.125", term_months: 360, product: "30-year fixed, limited cash-out refinance" } }, recipients: [{ partyId: "B1", name: b.name, mailingAddress: f.address, email: b.email, consent: { party_id: "B1", classes: ["origination_decisions", "disclosures.origination", "flood_notice"], disclosure_version: "esign-2026-09", status: "active", consented_on: "2026-10-19", soft_bounces_30d: 0 } }] }, UNDERWRITER); await settle();
  assert.ok((await b.cards()).some((x) => x.copy_key === "decision.conditional_approval" && x.kind === "StatusCard")); assert.ok((await b.cards()).some((x) => x.copy_key === "decision.approval.notice" && x.kind === "NoticeCard"));
  clock.set(MST("2026-10-21", "10:00")); await b.signIn("L2");
  const revised = await b.pending("revised_le.delivered"); later(1); await b.tap(revised, { option_id: "confirm", evidence: { opened_at: clock.now(), scrolled_to_end: true } });
  later(1); r = await b.say("What do you need from me now?"); await assertModelReply(b, r, { text: /Underwriting's list is on the rail/ });
  const uploads = (await b.cards()).filter((x) => x.kind === "UploadCard" && x.status === "pending"); assert.ok(uploads.length >= 4, `the borrower's uploads (${uploads.map((x) => x.props["document_class"]).join(", ")})`);
  const requests = await entitiesOf("document_requests", b.app_id);
  const docs: [string, string, Json, string][] = [["paystub", "COND_DU_VERIFY_INCOME_BASE", { employer_name: "Acme Manufacturing", pay_date: "2026-10-09", pay_period_start: "2026-09-26", pay_period_end: "2026-10-09", gross_current_cents: "378500", gross_ytd_cents: "7570000" }, "2026-10-09"], ["w2", "COND_DU_VERIFY_INCOME_BASE", { employer_name: "Acme Manufacturing", tax_year: 2025, wages_cents: "9840000" }, "2026-01-31"], ["mortgage_statement", "COND_DU_LIABILITY_MORTGAGE_HISTORY", { servicer: "Prior Servicer", statement_date: "2026-10-01", unpaid_balance_cents: "54820000" }, "2026-10-01"], ["homeowners_policy", "COND_DU_PROPERTY_HAZARD_INSURANCE", { carrier: "FAKE Mutual", policy_number: "HO-1", effective_date: "2026-05-01", expiration_date: "2027-05-01" }, "2026-05-01"]];
  const reviewed = new Map<string, { document_id: string; kind: string; document_date: string }[]>();
  for (const [cls, code, fields, dated] of docs) {
    const card = uploads.find((x) => x.props["document_class"] === cls); assert.ok(card, `an UploadCard for the ${cls}`); assert.equal(card.command_ref, "document.upload"); assert.equal(card.props["condition_id"], cond(code).id);
    later(1); const id = randomUUID(); const up = await b.tap(card, { option_id: "upload", evidence: { document_class: cls, file_name: `${cls}.pdf`, uploaded_at: clock.now() }, args: { document_id: id, sha256: sha(id), page_count: 1 } }); assert.equal(up.body["command"], "document.upload");
    const request = requests.find((q) => q.id === card.props["request_id"]); assert.ok(request, "22.1's request behind the card");
    await review(b, id, cls, fields);   // 22.1's class is the registry's code (document_classes); 23.3's evidence kind for the policy is the condition's own (`hoi_declaration`, 23.2 V1008)
    reviewed.set(code, [...(reviewed.get(code) ?? []), { document_id: id, kind: cls === "homeowners_policy" ? "hoi_declaration" : cls, document_date: dated }]);
  }
  // 23.3 clears each condition on every piece of evidence its template asks for (the income condition wants the paystub and the W-2 together)
  for (const [code, evidence] of reviewed) await clear(b, cond(code).id, evidence);
  assert.ok((await events(b.app_id, "condition.cleared")).length >= 3, "the borrower's conditions cleared");
  for (const code of ["COND_DU_VERIFY_INCOME_BASE", "COND_DU_LIABILITY_MORTGAGE_HISTORY", "COND_DU_PROPERTY_HAZARD_INSURANCE"]) assert.equal((await entity("conditions", cond(code).id))!["status"], "cleared", code);
  // the identity item is the borrower's on DU's list (an UploadCard for the ID) but the Stripe scan already verified them: the platform's evidence clears it and its card closes with the condition
  assert.deepEqual((await b.cards()).filter((x) => x.kind === "UploadCard" && x.status === "pending").map((x) => `${x.copy_key}:${x.props["document_class"]}`), ["upload.title:drivers_license"], "only the ID upload stays open until the identity condition clears");
  // the third-party items (the employer, the title company, the prior servicer, the identity vendor, the flood vendor) are the platform's: their evidence arrives outside the thread; the FAKE underwriting reviewer clears each (never a waiver: a DU message is never waived)
  await clearPlatformConditions(b, ["COND_DU_VERIFY_INCOME_BASE", "COND_DU_LIABILITY_MORTGAGE_HISTORY", "COND_DU_PROPERTY_HAZARD_INSURANCE"], "2026-10-21", "2026-11-06");
  assert.deepEqual((await b.cards()).filter((x) => x.kind === "UploadCard" && x.status === "pending").map((x) => `${x.copy_key}:${x.props["document_class"]}`), [], "every upload ask answered or closed by its condition");
  // the appraiser's visit (the window the borrower picked Oct 20): 24.1 completes the inspection
  clock.set(new Date(Date.parse(slot.starts_at) + 90 * 60_000).toISOString()); await tool(b.app_id, "24.1", "scheduleInspection", { order_id: orderId, op: "complete", completed_at: clock.now() }, VALUATION);
  // ── title (24.4): the settlement agent vetted, the commitment, the CPL, the wire verification — the platform's own items
  await advance(MST("2026-10-27", "09:00")); const AGENT = J.AGENT_PARTY; const UW_PARTY = `TU-AZ-${R}`;
  await tool(b.app_id, "24.4", "vetSettlementAgent", { party_id: AGENT, agent_type: "title_agency", state: "AZ", property_state: "AZ", license_active: true, license_number: "AZ-TA-4471", eo_policy_limit_cents: "200000000", eo_expires_on: "2027-06-30", fidelity_limit_cents: "100000000", alta_registry_id: "ALTA-AZ-4471", underwriter_confirmed_by: UW_PARTY, best_practices_attestation_at: "2026-08-15", wire_instructions_on_letterhead: true, cpl_available: true, underwriter_callback_number_verified: true, referral_consideration: false, at: clock.now() }, CLOSER);
  const titleOrder = await tool(b.app_id, "24.4", "orderTitle", { settlement_agent_party_id: AGENT, underwriter_party_id: UW_PARTY, apn: "112-23-045", note_amount_cents: "56000000", proposed_insured_text: `${partnerName}, its successors and/or assigns`, closing_date: "2026-11-06", property: { state: "AZ" }, at: clock.now() }, CLOSER); const titleOrderId = (titleOrder.output["order"] as { id: string }).id;
  clock.set(MST("2026-10-28", "10:00"));
  await tool(b.app_id, "24.4", "parseCommitment", { order_id: titleOrderId, commitment_number: `CMT-AZ-${R}`, commitment_effective_date: "2026-10-27", underwriter_party_id: UW_PARTY, underwriter_state: "AZ", doi_licensed: true, strength_basis: "rating", policy_form: "ALTA Loan Policy (07-01-2021)", policy_amount_cents: "56000000", legal_description: "Lot 1, Block 2, Palm Estates, per Book 100 of Maps, page 7, Maricopa County records", apn: "112-23-045", vesting: { names: [b.name], tenancy: "sole", trust: false, estate: "fee_simple" }, schedule_b1_requirements: ["Release of the existing first deed of trust, recorded"], schedule_b2_exceptions: [], endorsements_committed: ["ALTA 8.1-06"], property: { state: "AZ" }, appraisal_legal_description: "Lot 1, Block 2, Palm Estates, per Book 100 of Maps, page 7, Maricopa County records", at: clock.now() }, CLOSER);
  await tool(b.app_id, "24.4", "requestCPL", { order_id: titleOrderId, partner_name: partnerName, sm_addressee_required: true, at: clock.now() }, CLOSER);
  await tool(b.app_id, "24.4", "requestCPL", { op: "receive", order_id: titleOrderId, cpl_document_id: `doc-cpl-${R}`, cpl_date: "2026-10-28", cpl_underwriter_party_id: UW_PARTY, cpl_agent_party_id: AGENT, addressees: [`${partnerName}, its successors and/or assigns`, "Supermortgage LLC, as bailee/secured party"], partner_name: partnerName, sm_addressee_required: true, funding_date: "2026-11-12", at: clock.now() }, CLOSER);
  await settle();
  // ── clear to close (23.3) Thu Oct 29 → the StatusCard
  await advance("2026-10-29T20:00:00.000Z");
  const checklist = await tool(b.app_id, "23.3", "runCtcChecklist", { op: "ctc", decision_id: f.decisionId, facts: K<Json>("CTC_FACTS") }, UNDERWRITER);
  const ctc = await tool(b.app_id, "23.3", "issueClearToClose", { decision_id: f.decisionId, checklist: checklist.output }, UNDERWRITER); assert.equal(ctc.output["event"], "clear_to_close.issued"); await settle();
  assert.ok((await b.cards()).some((x) => x.copy_key === "ctc.reached"));
  // ── the CD (25.2) Mon Nov 2: the figures, the APR, the render, e-delivered under the consent → the DocumentCard, narrated, received by the tap; the waiting period → the closing ScheduleCard
  await advance(MST("2026-11-02", "09:00"));
  await tool(b.app_id, "25.2", "assembleCdFigures", { op: "record_source", source_id: `SRC-SA-${R}`, party: "settlement_agent", payload: { fees: [{ fee_code: "title_lender_policy", amount_cents: "120000" }, { fee_code: "settlement_fee", amount_cents: "60000" }, { fee_code: "recording", amount_cents: "3000" }] }, payload_document_id: "DOC-SA-FEES" }, DISCLOSURE);
  await tool(b.app_id, "25.2", "assembleCdFigures", { op: "record_source", source_id: `SRC-ESCROW-${R}`, party: "escrow", payload: { monthly_cents: "68750", deposit_cents: "206250" } }, DISCLOSURE);
  const cdFees = (K<Json[]>("CD_FEES")).map((x) => ({ ...x, source_id: String(x["source_id"]).replace(J.R, R) }));
  await tool(b.app_id, "25.2", "reconcileFigureSources", { fees: cdFees }, DISCLOSURE);
  const apr = await tool(b.app_id, "25.1", "computeApr", { loan_amount_cents: "56000000", note_rate_pct: "6.125", term_months: 360, term_start_date: "2026-11-12", first_payment_date: "2027-01-01", prepaid_finance_charges_cents: "384995", prepaid_interest_cents: "178543", checkpoint: "cd" }, COMPLIANCE);
  const cdId = `CD-${b.app_id.slice(0, 8)}-1`;
  await tool(b.app_id, "25.2", "renderCd", { disclosure_id: cdId, cd_version: 1, transaction_type: "refinance", state: "AZ", required_consumer_ids: ["B1"],
    loan: { loan_amount_cents: "56000000", rate_pct: "6.125", term_months: 360, pi_cents: "340262", product: "Fixed Rate", loan_type: "Conventional", purpose: "Refinance", prepayment_penalty: false, balloon: false, arm: false, loan_id_number: b.app_id, mic_number: null, first_payment_date: "2027-01-01", maturity_date: "2056-12-01" },
    apr: { apr_calculation_id: apr.output["apr_calculation_id"], apr_pct: apr.output["apr_disclosed_str"], finance_charge_cents: apr.output["finance_charge_cents"], amount_financed_cents: apr.output["amount_financed_cents"], total_of_payments_cents: apr.output["total_of_payments_cents"], tip_pct: String(Number(apr.output["tip_pct"]).toFixed(3)) },
    fees: cdFees, escrow: { established: true, monthly_escrow_cents: "68750", initial_escrow_payment_cents: "206250", escrowed_costs_year1_cents: "825000", non_escrowed_costs_year1_cents: "0" },
    parties: { borrowers: [b.name], creditor_name: partnerName, creditor_nmlsr_id: "123456", mlo_name: "Jordan Rivera", mlo_nmlsr_id: "987654", settlement_agent_name: "Desert Title Agency LLC", settlement_agent_license_id: "AZ-TA-4471" },
    dates: { date_issued: "2026-11-02", closing_date: "2026-11-06", disbursement_date: "2026-11-12" }, property_address: "100 N Central Ave, Phoenix AZ 85004", cash_to_close_cents: "552943", lender_credits_cents: "70000", payoffs_and_payments_cents: "54820000", rescindable: true }, DISCLOSURE);
  clock.set(MST("2026-11-02", "09:14"));
  await tool(b.app_id, "25.2", "deliverDisclosure", { disclosure_id: cdId, consumer_id: "B1", channel: "esign_portal", at: clock.now(), esign_consent_id: consentId, gate_run: { run_id: "RUN-CD-1", open: true, apr_verdict: "pass", blocked_channels: [] } }, DISCLOSURE); await settle();
  clock.set(MST("2026-11-02", "09:30")); await b.signIn("L2");
  r = await b.say("The closing disclosure just arrived, are these the final numbers?"); await assertModelReply(b, r, { text: /Closing Disclosure is the final form/ });
  const cdCard = await b.pending("cd.delivered"); assert.equal(cdCard.kind, "DocumentCard"); later(2); await b.tap(cdCard, { option_id: "confirm", evidence: { opened_at: clock.now(), scrolled_to_end: true } });
  assert.equal((await events(b.app_id, "disclosure.cd.received")).length, 1);
  const wp = await tool(b.app_id, "25.2", "computeEarliestConsummation", { disclosure_id: cdId }, DISCLOSURE); assert.equal(wp.output["earliest_consummation_date"], "2026-11-05"); await settle();
  // ── the closing slot (26.2): electronic signing chosen on the card beside it, the Friday afternoon window tapped → scheduled (RON, the FAKE eClosing directory's agent), the people cards
  later(2); r = await b.say("When can we sign? Friday afternoon would be best."); await assertModelReply(b, r, { text: /signing window on the schedule card/ });
  const electronic = await b.pending("closing.electronic_or_paper"); later(1); await b.tap(electronic, { option_id: "electronic", evidence: { option_id: "electronic" } });
  const closingCard = await b.pending("closing.schedule"); assert.equal(closingCard.props["earliest_consummation_date"], "2026-11-05");
  const ron = (closingCard.props["slots"] as { id: string; starts_at: string; closing_type: string }[]).find((x) => x.closing_type === "ron" && x.id === "ron:2026-11-06T14"); assert.ok(ron, `a Friday afternoon RON window: ${JSON.stringify(closingCard.props["slots"]).slice(0, 300)}`);
  later(1); const booked = await b.tap(closingCard, { option_id: ron.id, evidence: { slot_id: ron.id } }); assert.equal(booked.body["command"], "closing.selectSlot"); const closingId = String((booked.body["result"] as Json)["closing_id"]); assert.equal((booked.body["result"] as Json)["closing_type"], "ron");
  assert.ok((await b.cards()).some((x) => x.copy_key === "closing.confirmed")); assert.ok((await b.cards()).some((x) => x.kind === "PersonCard"), "the notary / settlement agent PersonCards");
  // ── the closing package (26.1) and the RON signing (26.2, FAKE) Fri Nov 6 14:00 MST: the HandoffCard before the session, the eNote signed = consummation
  await advance(MST("2026-11-04", "10:00"));
  const snapshot: Json = { ...K<() => Json>("CLOSING_SNAPSHOT")(), partner: { legal_name: partnerName, nmlsr_id: "123456", mers_org_id: "1000123" }, vesting_text: `${b.name}, an unmarried person`, borrowers: [{ party_id: "B1", legal_name: b.name, credit_used: true, on_title: true, capacities: ["borrower"] }], lock_id: lockId };
  const terms = await tool(b.app_id, "26.1", "computeNoteTerms", { principal_cents: "56000000", note_rate_pct: "6.125", term_months: 360, scheduled_disbursement_date: "2026-11-12", state: "AZ" }, CLOSER);
  const gate = K<Json>("DOCGEN_GATE"); const g26 = await tool(b.app_id, "26.1", "evaluateDocGenGates", { gate }, CLOSER); const setId = g26.output["set_id"] as string;
  await tool(b.app_id, "26.1", "takeClosingSnapshot", { set_id: setId, snapshot, gate }, CLOSER);
  const rendered = await tool(b.app_id, "26.1", "renderDocument", { set_id: setId }, CLOSER); const noteHash = (rendered.output["documents"] as { kind: string; data_hash: string }[]).find((d) => d.kind === "enote")!.data_hash; assert.equal(noteHash, terms.output["data_hash"]);
  const smart = await tool(b.app_id, "26.1", "buildSmartDocENote", { set_id: setId }, CLOSER);
  await tool(b.app_id, "26.1", "runDocumentQc", { set_id: setId, upstream: { enote: smart.output, cd: { loan_amount_cents: "56000000", note_rate_pct: "6.125", pi_cents: "340262", org_nmlsr_id: "123456", mlo_nmlsr_id: "987654", first_payment_date: "2027-01-01" }, du: { loan_amount_cents: "56000000", note_rate_pct: "6.125", term_months: 360 }, lock: { note_rate_pct: "6.125" }, title: { vesting_text: snapshot["vesting_text"], legal_description: snapshot["legal_description"] }, urla_1003: { org_nmlsr_id: "123456", mlo_nmlsr_id: "987654", loan_amount_cents: "56000000", note_rate_pct: "6.125", term_months: 360 }, note_date: "2026-11-06" } }, CLOSER);
  clock.set(MST("2026-11-05", "09:00")); await tool(b.app_id, "26.1", "releaseToSettlementAgent", { set_id: setId, released_to_party_id: AGENT, facts: { qc_pass_gate_open: true, template_version_gate_open: true } }, CLOSER); await settle();
  assert.ok((await b.cards()).some((x) => x.copy_key === "closing.presign" && x.kind === "HandoffCard" && x.status === "pending"), "the pre-signing HandoffCard");
  clock.set(MST("2026-11-05", "15:00")); const released = (await events(b.app_id, "closing.documents.released"))[0]!;
  await tool(b.app_id, "26.2", "runPreSessionChecks", { op: "upstream", closing_id: closingId, event: { type: "closing.documents.released", occurredAt: MST("2026-11-05", "09:00"), payload: released.payload } }, CLOSER);
  await advance(MST("2026-11-06", "13:30"));
  const closingConsent = { ...K<Json>("CLOSING_CONSENT"), consent_id: consentId, granted_at: consent.captured_at, scope: ["disclosures", "closing_package"] };
  await tool(b.app_id, "26.2", "verifyEsignConsent", { closing_id: closingId, consent: closingConsent }, CLOSER);
  const pre = await tool(b.app_id, "26.2", "runPreSessionChecks", { closing_id: closingId, consent: closingConsent, facts: { ...K<Json>("PRE_SESSION_FACTS"), signing_package: [{ consumer_id: "B1", copies: 2, channel: "in_person", material_disclosures_in_package: true, receipt_capture: true }] } }, CLOSER); assert.equal(pre.output["passed"], true, JSON.stringify(pre.output["blocking"]));
  clock.set(MST("2026-11-06", "14:00")); const sessionId = `SES-${R}`; const NOTARY = J.NOTARY;
  await tool(b.app_id, "26.2", "openSigningSession", { closing_id: closingId, session_id: sessionId, signer_party_ids: ["B1"], notary: NOTARY, consent_record_id: consentId }, CLOSER);
  clock.set(MST("2026-11-06", "14:07")); await tool(b.app_id, "26.2", "monitorSession", { op: "identity", closing_id: closingId, party_id: "B1", method: "credential_analysis_kba", credential_type: "driver_license", credential_analysis_result: "pass", kba_attempts: [{ questions: 5, correct: 5, seconds: 71, at: clock.now(), notary_party_id: NOTARY.party_id }], notary_party_id: NOTARY.party_id, vendor: "Proof" }, CLOSER);
  await tool(b.app_id, "26.2", "monitorSession", { op: "start", closing_id: closingId }, CLOSER); await settle();
  assert.ok(!(await b.cards()).some((x) => x.copy_key === "closing.presign" && x.status === "pending"), "the hand-off closed when the session started");
  await tool(b.app_id, "26.2", "monitorSession", { op: "enote_created", closing_id: closingId, closing_document_id: `DOC-ENOTE-${R}`, min: J.MIN, partner_org_id: "1000123" }, CLOSER);
  await tool(b.app_id, "26.2", "monitorSession", { op: "sign", closing_id: closingId, closing_document_id: `DOC-1003-${R}`, kind: "final_1003", signer_party_id: "B1", signed_at: MST("2026-11-06", "14:18"), signature_method: "esign_ron", required_note_signers: ["B1"] }, CLOSER);
  const signed = await tool(b.app_id, "26.2", "monitorSession", { op: "sign", closing_id: closingId, closing_document_id: `DOC-ENOTE-${R}`, kind: "enote", signer_party_id: "B1", signed_at: MST("2026-11-06", "14:26"), signature_method: "esign_ron", required_note_signers: ["B1"] }, CLOSER); assert.equal(signed.output["note_date"], "2026-11-06");
  await tool(b.app_id, "26.2", "monitorSession", { op: "sign", closing_id: closingId, closing_document_id: `DOC-DOT-${R}`, kind: "security_instrument", signer_party_id: "B1", signed_at: MST("2026-11-06", "14:31"), signature_method: "esign_ron", required_note_signers: ["B1"] }, CLOSER);
  await tool(b.app_id, "26.2", "monitorSession", { op: "notarial_act", closing_id: closingId, closing_document_id: `DOC-DOT-${R}`, kind: "security_instrument", act_type: "acknowledgment", completed_at: MST("2026-11-06", "14:36"), certificate_indicates_communication_technology: true, recordable: true, last: true, notary_party_id: NOTARY.party_id }, CLOSER);
  const copy = `<SMART_DOCUMENT version="1.02"><DATA min="${J.MIN}" amount="560000.00" rate="6.125"/></SMART_DOCUMENT>`;
  clock.set(MST("2026-11-06", "14:41")); await tool(b.app_id, "26.2", "validateAuthoritativeCopy", { op: "seal", closing_id: closingId, seal_hash: sha(copy), signing_completed_at: MST("2026-11-06", "14:26"), authoritative_copy_ref: `EV-${R}`, tamper_sealed_at: clock.now() }, CLOSER);
  clock.set(MST("2026-11-06", "14:43")); const valid = await tool(b.app_id, "26.2", "validateAuthoritativeCopy", { closing_id: closingId, authoritative_copy: copy }, CLOSER); assert.equal(valid.output["gate_open"], true, String(valid.output["reason"]));
  clock.set(MST("2026-11-06", "14:44")); const reg = await tool(b.app_id, "26.2", "registerENote", { closing_id: closingId }, CLOSER); assert.equal(reg.output["accepted"], true); await settle();
  // ── rescission (25.3): the H-8 notice at signing → the DocumentCard, the period, the Wednesday sweep finding nothing
  clock.set(MST("2026-11-06", "14:45")); const consummationAt = MST("2026-11-06", "14:26");
  await tool(b.app_id, "25.3", "determineRescindability", { transaction_type: "limited_cash_out", consumers: [{ consumer_id: "B1", role: "borrower", ownership_interest: true, occupancy: "primary" }], partner_id: partnerId, existing_loan: { original_creditor_id: "L-OTHER-2021", upb_cents: "54820000", earned_unpaid_finance_charge_cents: "210055", refinancing_costs_cents: "795000" }, amount_financed_cents: "55615005", time_zone: TZ }, DISCLOSURE);
  await tool(b.app_id, "25.3", "renderRescissionNotice", { form: "h8", consumer_id: "B1", consumer_name: b.name, transaction_date: "2026-11-06", expires_on: rescissionExpiry(D("2026-11-06"), TZ).expires_on, creditor_name: partnerName, designated_address: "100 Partner Plaza, Suite 400, Phoenix AZ 85004", property_address: f.address }, DISCLOSURE);
  await tool(b.app_id, "25.3", "deliverRescissionNotice", { consumer_id: "B1", delivered_at: consummationAt, channel: "in_person", copies: 2, evidence_document_id: "DOC-RON-AUDIT-B1", form: "h8", time_zone: TZ }, DISCLOSURE);
  await tool(b.app_id, "25.3", "computeRescissionPeriod", { consummation_at: consummationAt, time_zone: TZ, notice_deliveries: [{ consumer_id: "B1", delivered_at: consummationAt, channel: "in_person", copies: 2, evidence_document_id: "DOC-RON-AUDIT-B1" }], material_disclosures: [{ consumer_id: "B1", cd_version: 1, effective_receipt_date: "2026-11-02", accurate: true }], material_disclosures_accurate: true }, DISCLOSURE); await settle();
  assert.ok((await b.cards()).some((x) => x.copy_key === "rescission.notice" && x.kind === "DocumentCard")); assert.ok((await b.cards()).some((x) => x.copy_key === "signed.refi"));
  await advance(MST("2026-11-11", "08:00")); await tool(b.app_id, "25.3", "sweepInboundForRescission", { swept_at: clock.now(), channels_checked: ["mail", "email", "portal", "fax", "voicemail"], items: [] }, DISCLOSURE); await settle();
  assert.equal((await events(b.app_id, "rescission.confirmed_not_rescinded")).length, 1);
  // ── funding (26.3) Wed Nov 11 / Thu Nov 12: the calendar, the worksheet, the conditions, the advance, the wire — released by the FAKE funding approver on the sweep (dual control) — the agent's receipt, the disbursement → loan.funded
  clock.set(EST("2026-11-11", "11:00")); const F = `F-${R}`;
  await tool(b.app_id, "26.3", "computeDates", { op: "open", funding_id: F, state: "AZ", transaction_type: "limited_cash_out", time_zone: TZ, consummation_at: consummationAt, review_completed_on: "2026-11-09", partner_id: partnerId, partner_loan_number: "PL-1001", gross_loan_cents: "56000000", note_rate_pct: "6.125", note_first_payment_date: "2027-01-01" }, FUNDER);
  await tool(b.app_id, "26.3", "buildFundingWorksheet", { funding_id: F, version: 1, cd_version: 1, gross_loan_cents: "56000000", prepaid_interest_cents: "178543", escrow_deposit_cents: "166500", lender_credits_cents: "70000" }, FUNDER);
  await tool(b.app_id, "26.3", "reconcileToSettlementStatement", { funding_id: F, worksheet_id: `${F}:ws:1`, agent_requested_net_cents: "55724957" }, FUNDER);
  await advance(EST("2026-11-12", "08:05")); const fundingFacts = (as_of: string) => (K<(as_of: string) => Json>("FUNDING_FACTS"))(as_of);
  const conditions = await tool(b.app_id, "26.3", "evaluateFundingConditions", { funding_id: F, facts: fundingFacts(clock.now()) }, FUNDER); assert.equal(conditions.output["passed"], true, JSON.stringify(conditions.output["blocking_codes"]));
  clock.set(EST("2026-11-12", "08:12")); await tool(b.app_id, "26.3", "requestWarehouseAdvance", { funding_id: F, conditions: conditions.output, rescission: (fundingFacts(clock.now())["rescission"]), fraud_hold: { fraud_hold: false }, ptf: { ptf_cleared: true }, cash_to_close: { worksheet: { reconciled_to_cd: true, sufficient: true } }, gifts: [] }, FUNDER);
  await tool(b.app_id, "26.3", "requestWarehouseAdvance", { funding_id: F, op: "advance_approved", advance_id: `ADV-${R}` }, FUNDER);
  clock.set(EST("2026-11-12", "08:20")); const wireId = `W-${R}`; const wireRecord = K<Json>("VERIFIED_WIRE");
  await tool(b.app_id, "26.3", "prepareWire", { funding_id: F, wire_id: wireId, record: wireRecord, instructions_hash: wireRecord["instructions_hash"], instructions_source: "verified_record", value_date: "2026-11-12", prepared_at: clock.now(), run_id: "run-funder-1", editors: ["u-analyst"], borrower_last_name: f.last, property_short: "100 N Central Ave, Phoenix AZ", funding_account_ref_hash: "sha256:funding", closing_documents: [] }, FUNDER);
  clock.set(EST("2026-11-12", "09:40")); const sweep = await runtime.sweep(clock.now()); await settle();
  const wireRow = await entity("funding_wires", wireId); let releasedBy = "FAKE:funding_approver";
  if (!["released", "accepted"].includes(String(wireRow?.["status"]))) { await tool(b.app_id, "26.3", "prepareWire", { funding_id: F, op: "release", wire_id: wireId, bank_ref: "BK-1", released_at: clock.now() }, APPROVER); releasedBy = APPROVER.id; }
  process.stderr.write(`wire ${wireId} released by ${releasedBy} (${sweep.reviewers?.line ?? "no reviewers"})\n`);
  await tool(b.app_id, "26.3", "prepareWire", { funding_id: F, op: "accept", wire_id: wireId, imad: "20261112B1QGC01R000123", accepted_at: EST("2026-11-12", "09:41") }, FUNDER);
  clock.set(EST("2026-11-12", "13:00")); await tool(b.app_id, "26.3", "notifySettlementAgent", { funding_id: F, op: "agent_receipt", funds_received_by_agent_at: clock.now() }, FUNDER);
  clock.set("2026-11-12T18:40:00.000Z"); const funded = await tool(b.app_id, "26.3", "confirmDisbursement", { funding_id: F, disbursement_date: "2026-11-12", confirmed_at: clock.now(), source: "final_settlement_statement", evidence_document_id: "DOC-FSS", escrow_deposit_cents: "206250" }, FUNDER); assert.ok(funded.events.some((e) => e.type === "loan.funded")); await settle();
  assert.ok((await b.cards()).some((x) => x.copy_key === "funded.refi"));
  // ── boarding (30.2): POST /fund from the record → the servicing loan with balanced opening entries; the welcome, the first-payment letter and the autopay card
  const boarded = await J.call("POST", `/v1/applications/${b.app_id}/fund`, { actor: FUNDING, snapshot: { final_cd: { document_id: cdId, pi_cents: "340262", monthly_escrow_cents: "68750", initial_escrow_deposit_cents: "206250", prepaid_interest_cents: "178543", prepaid_interest_days: 19, compliance_tests_passed: true } } });
  assert.equal(boarded.status, 200, JSON.stringify(boarded.body).slice(0, 1500)); b.loan_id = boarded.body["loan_id"] as string; await settle();
  const loan = (await db.query<{ origination_application_id: string | null; status: string; boarded_at: string | null; partner_party_id: string }>(`SELECT origination_application_id, status, boarded_at, partner_party_id FROM loans WHERE id = $1`, [b.loan_id]))[0]!;
  assert.equal(loan.origination_application_id, b.app_id); assert.equal(loan.status, "active"); assert.ok(loan.boarded_at); assert.equal(loan.partner_party_id, partnerId);
  const app = (await db.query<{ loan_id: string | null; status: string }>(`SELECT loan_id, status FROM applications WHERE id = $1`, [b.app_id]))[0]!; assert.equal(app.loan_id, b.loan_id); assert.equal(app.status, "funded");
  const n = async (sql: string, params: unknown[]): Promise<number> => Number((await db.query<{ c: string }>(sql, params))[0]!.c);
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_terms WHERE loan_id = $1 AND source = 'boarding' AND pi_cents = 340262 AND escrow_payment_cents = 68750 AND note_rate_bps = 61250`, [b.loan_id]), 1);
  const log = await events(b.app_id); for (const t of ["loan.funded", "loan.staged", "loan.validated", "loan.boarded", "ledger.opening_posted", "consents.boarded", "documents.indexed", "timers.seeded", "statement.cycle.opened"]) assert.ok(log.some((e) => e.type === t), `${t} emitted`);
  assert.equal(await n(`SELECT count(*)::text AS c FROM boarding_validations WHERE application_id = $1 AND rule_code LIKE 'OB-%' AND result = 'pass'`, [b.app_id]), 22);
  const setIdOpening = boarded.body["opening_entry_set_id"] as string; assert.ok(setIdOpening);
  assert.equal(await n(`SELECT count(*)::text AS c FROM (SELECT set_id FROM ledger_lines WHERE set_id = $1 GROUP BY set_id HAVING sum(amount_cents) <> 0) x`, [setIdOpening]), 0, "the opening set balances");
  const balance = async (account: string): Promise<bigint> => BigInt((await db.query<{ s: string }>(`SELECT coalesce(sum(amount_cents), 0)::text AS s FROM ledger_lines WHERE loan_id = $1 AND account = $2`, [b.loan_id, account]))[0]!.s);
  assert.equal(await balance("principal"), 56_000_000n); assert.equal(-(await balance("escrow")), 206_250n); assert.equal(-(await balance("prepaid_interest")), 178_543n);
  const t1bd = (await db.query<{ status: string }>(`SELECT status::text AS status FROM timers WHERE code = 'SM_ORIG_BOARD_T1BD' AND application_id = $1`, [b.app_id]))[0]; assert.equal(t1bd?.status, "satisfied");
  const boardingCards = await b.cards();
  assert.ok(boardingCards.some((x) => x.copy_key === "boarding.welcome" && x.subject_loan_id === b.loan_id), "the welcome"); assert.ok(boardingCards.some((x) => x.copy_key === "first_payment.letter" && x.kind === "NoticeCard"), "the first-payment letter");
  const autopay = boardingCards.find((x) => x.copy_key === "consent.autodraft.title" && x.status === "pending")!; assert.ok(autopay, "the autopay ConsentCard"); assert.equal(autopay.command_ref, "autodraft.enroll");
  // the borrower, back on a fresh code (the money command's fresh L1): autopay narrated, then the card with the account and the typed name
  clock.set("2026-11-12T19:00:00.000Z"); await b.signInFresh();
  r = await b.say("Can I set up autopay from my checking?"); await assertModelReply(b, r, { text: /Autopay is a card on the rail/ });
  later(1); await b.tap(autopay, { option_id: "affirm", evidence: { affirmation_method: "checkbox_with_text", typed_name: b.name, checkbox: true, disclosure_version_shown: autopay.props["disclosure_version_id"], account: { last4: "9876", type: "checking", routing: "021000021" } } });
  assert.ok((await db.query(`SELECT 1 FROM loan_events WHERE loan_id = $1 AND type LIKE 'autodraft.%'`, [b.loan_id])).length >= 1, "the enrollment on the loan's log");
  later(1); r = await b.say("Thanks, that is everything."); await assertModelReply(b, r, { text: /You are welcome/ });
  // ── the audit: §2.3 for every card, provenance, verbatim, evidence, the turn ledger
  const out = await audit(b, { minCards: 20, subjects: [b.app_id, b.loan_id] });
  for (const c of ["evidence", "consent", "integration", "document_or_choice"]) assert.ok((out.cases.get(c) ?? 0) > 0, `the journey exercised the ${c} case`);
  for (const kind of ["ChoiceCard", "ConfirmCard", "ConsentCard", "ConnectCard", "ProfileCard", "DemographicsCard", "DocumentCard", "ComparisonCard", "UploadCard", "ChecklistCard", "ScheduleCard", "StatusCard", "NoticeCard", "PersonCard", "HandoffCard"]) assert.ok((out.byKind.get(kind) ?? 0) > 0, `the journey raised a ${kind}`);
  assert.deepEqual(out.cards.filter((x) => x.status === "pending" && x.subject_application_id === b.app_id && !x.subject_loan_id && x.kind !== "ChecklistCard").map((x) => `${x.kind} ${x.copy_key}`), [], `no origination ask stays open once boarded (the servicing consents and autopay are the loan's): ${out.cards.filter((x) => x.status === "pending").map((x) => x.copy_key).join(", ")}`);
});

// ═══════════════════════════════════ the purchase persona: Casey Rivera, still looking in Arizona, then a contract on 9 Saguaro Way
test("conversation: the purchase persona goes from sign-up to a boarded loan by talking — the preapproval, the contract, the LE, the lock, underwriting's items, the appraiser hand-off, the CD, the RON signing, the same-day funding and boarding", { skip }, async () => {
  const b = new Borrower(`casey-${R}@example.test`, `pw-casey-${R}`, "Casey Rivera", "123-45-3333", "1992-08-30");
  clock.set(EDT("2026-11-02", "09:00")); await b.signUp(); J.appId = b.app_id;
  let r = await b.say("We are buying a home, still looking at places."); await assertModelReply(b, r, { proposedInto: "entry.goal.question", text: /Buy a home/ });
  const goal = await b.pending("entry.goal.question"); later(1); const g = await b.tap(goal, { option_id: "buy", evidence: { option_id: "buy", tapped_at: clock.now() } }); assert.ok((g.body["events"] as string[]).includes("application.received"));
  assert.equal((await events(b.app_id, "application.trid_received")).length, 0, "no address, no TRID application");
  assert.ok((await b.cards()).some((x) => x.copy_key === "preapproval.intro"));
  // P1: where and how much — proposed into the ConfirmCard, confirmed → 20.3's preapproval request
  later(1); r = await b.say("Looking in Arizona, between four hundred fifty and five twenty five thousand, with about a hundred and five thousand down; it is our first home."); await assertModelReply(b, r, { proposedInto: "preapproval.where", text: /AZ.*\$450,000\.00.*\$525,000\.00.*\$105,000\.00/ });
  const where = await b.pending("preapproval.where"); later(1); await b.tap(where, proposalEvidence(where));
  assert.equal(String((await entity("leads", b.app_id))?.["status"]), "prequal_requested");
  // E5/E6: identity, the SSN, the consents (with the hard-pull authorization at L3), the profile, the declarations, the demographics — the same cards as the refinance
  const esign = await b.pending("consent.esign.title"); later(1); const c = await b.tap(esign, { evidence: { affirmation_method: "checkbox_with_text", typed_name: b.name, checkbox: true, disclosure_version_shown: esign.props["disclosure_version_id"] } }); const consentId = String((c.body["result"] as Json)["consent_id"]);
  later(1); assert.equal((await api("POST", "/v1/borrower/commands/consent.capture", { op: "verify", consent_id: consentId, token: esignVerificationToken(consentId), scope: ["disclosures", "notices"] }, bearer(b.token))).status, 200); await settle();
  const tcpa = await b.pending("consent.tcpa.title"); later(1); await b.tap(tcpa, { evidence: { affirmation_method: "checkbox_with_text", typed_name: b.name, checkbox: true, disclosure_version_shown: tcpa.props["disclosure_version_id"] } });
  later(1); const vs = await api("POST", "/v1/borrower/identity/stripe/session", { application_id: b.app_id }, bearer(b.token)); assert.equal(vs.status, 200, JSON.stringify(vs.body));
  (router.stripe as FakeStripeIdentity).complete(vs.body["vendor_session_id"] as string, clock.now(), { legal_name: b.name, date_of_birth: b.dob, address: "7 Mesa Ct, Phoenix, AZ 85018" });
  const hook = await api("POST", "/v1/webhooks/stripe", { id: `evt-p-${R}`, type: "identity.verification_session.verified", data: { object: { id: vs.body["vendor_session_id"], status: "verified" } } }, { "stripe-signature": "FAKE" }); assert.equal(hook.body["level"], "L3", JSON.stringify(hook.body)); await settle();
  const identity = await b.pending("identity.confirm.title"); later(1); await b.tap(identity, fieldsEvidence(identity));
  const ssn = await b.pending("identity.ssn.title"); later(1); await b.tap(ssn, fieldsEvidence(ssn, { ssn: b.ssn }));
  assert.ok(!(await b.cards()).some((x) => x.copy_key === "refi.home.confirm"), "no home card on a purchase");
  const credit = await b.pending("consent.credit.title"); later(1); await b.tap(credit, { evidence: { affirmation_method: "checkbox_with_text", typed_name: b.name, checkbox: true, disclosure_version_shown: credit.props["disclosure_version_id"] } });
  later(1); r = await b.say("I would rather type my income."); await assertModelReply(b, r, { text: /income card is on the rail/ });
  later(1); r = await b.say("About 8,200 a month at Acme Manufacturing."); await assertModelReply(b, r, { proposedInto: "income.confirm.title" });
  const income = await b.pending("income.confirm.title"); later(1); await b.tap(income, proposalEvidence(income));
  // the payroll connection too (Truv FAKE): the ConnectCard tap, the vendor session, the webhook → the income ConfirmCard from the report, confirmed
  const connect = await b.pending("income.connect.purpose"); later(1); await b.tap(connect, { evidence: { vendor: "truv_income", started_at: clock.now() } });
  const ts = await api("POST", "/v1/borrower/connect/truv_income/session", { card_instance_id: connect.card_instance_id }, bearer(b.token)); assert.equal(ts.status, 200, JSON.stringify(ts.body));
  later(1); const truv = await api("POST", "/v1/webhooks/truv", { type: "voie.report.ready", data: { vendor_session_id: ts.body["vendor_session_id"], report: { employer: "Acme Manufacturing (FAKE payroll)", monthly_base_cents: "820000" } } }, { "x-truv-signature": "FAKE" }); assert.equal(truv.status, 200, JSON.stringify(truv.body)); await settle();
  const payroll = await b.pending("income.confirm.title", (x) => x.props["requested_by"] !== "card.request"); assert.equal((payroll.props["fields"] as { path: string; value: string; source: string }[]).find((x) => x.path === "monthly_base_cents")!.value, "820000", "the report's figure is on the card (the webhook writes it before the flow reads it)");
  later(1); await b.tap(payroll, fieldsEvidence(payroll));
  later(1); r = await b.say("I am a US citizen, not married, no dependents, never served, English."); await assertModelReply(b, r, { proposedInto: "profile.title" });
  const profile = await b.pending("profile.title"); later(1); await b.tap(profile, { option_id: "submit", evidence: { fields: (profile.props["proposal"] as { fields: { path: string; value: string }[] }).fields.map((x) => ({ path: x.path, value: x.value, answered_at: clock.now() })) } });
  const decl = await b.pending("declarations.title"); later(1); await b.tap(decl, { option_id: "none", evidence: { option_id: "none", tapped_at: clock.now() } });
  const demo = await b.pending("demographics.title"); later(1); await b.tap(demo, { option_id: "submit", evidence: { collection_method: "internet", answered_at: clock.now(), answers: { ethnicity: ["do_not_wish"], race: ["do_not_wish"], sex: "do_not_wish" } } });
  // P8: the target (price, down payment, amount, product) proposed and confirmed
  later(1); r = await b.say("We aim for a target price of five twenty five with the same down payment, so borrowing four twenty on a thirty year fixed."); await assertModelReply(b, r, { proposedInto: "preapproval.target", text: /\$525,000\.00.*\$105,000\.00.*\$420,000\.00/ });
  const target = await b.pending("preapproval.target"); later(1); await b.tap(target, proposalEvidence(target));
  // the platform: the credit report, the day's sheet and the FAKE MLO's review of the quote, DU on the TBD casefile, 23.3's decision → the preapproval letter DocumentCard (DELTA-01)
  later(2); const reportId = await orderCredit(b, clock.now());
  later(1); r = await b.say("What are those debts on my report about?"); await assertModelReply(b, r, { text: /debts card shows what your report lists/ });
  const liabilities = await b.pending("credit.liabilities.confirm"); later(1); await b.tap(liabilities, fieldsEvidence(liabilities));
  await J.tool({}, "20.4", "buildFeeItems", { op: "cost_schedule", cost_schedule_id: `cs-az-purchase-hybrid-${R}`, partner_id: partnerId, state: "AZ", transaction_type: "purchase", valuation_method: "hybrid", items: K<Json[]>("COST_ITEMS"), effective_from: "2026-09-01" }, { kind: "human", id: "u-officer", role: "officer" } as never);
  await publishSheet("2026-11-02"); later(2); const quoteId = `Q-C-${R}`; await priceAndReview(b, "42000000", "52500000", "purchase", "52500000", quoteId);
  clock.set(EDT("2026-11-02", "12:00"));
  const cf0 = createCasefile(new MemoryEventStore(clock), { application_id: b.app_id, seller_number: "123456789", system_id_ref: "SYS-PARTNER-01", tsp_product_ref: "SM-TSP", score_model: "classic_fico", created_at: clock.now() }).casefile;
  const borrowers = BORROWER_IDENTITY(b, "Rivera");
  await tool(b.app_id, "23.1", "associateCredit", { casefile: cf0, reports: [await entity("credit_reports", reportId)], borrowers, app_score_model: "classic_fico" }, UNDERWRITER);
  const snapshot = { application_id: b.app_id, loan_purpose: "purchase", occupancy: "principal_residence", product: "fixed_30", amortization: "fixed", loan_term: 360, property_type: "sfr_detached", sales_price_cents: "52500000", appraised_value_cents: "52500000", loan_amount_cents: "42000000", note_rate_pct: "6.125", qualifying_income_cents: "820000", total_obligations_cents: "280000", borrowers, max_ltv_pct: "97.00" };
  const built = await tool(b.app_id, "23.1", "buildDuRequest", { casefile_id: cf0.casefile_id, submission_type: "credit_and_underwriting", reason: "initial", snapshot }, UNDERWRITER);
  await tool(b.app_id, "23.1", "submitCasefile", { casefile_id: cf0.casefile_id, request: built.output["request"], projected_note_date: "2026-12-15", scif_facts: { borrowers: [{ id: "B1", scif_presented_at: EDT("2026-11-02", "09:10") }] } }, UNDERWRITER);
  const findings = await tool(b.app_id, "23.1", "fetchFindings", { casefile_id: cf0.casefile_id, submission_number: 1 }, UNDERWRITER); const submission = findings.output["submission"] as Json;
  clock.set(EDT("2026-11-02", "12:12"));
  const messages = [{ id: "V1001", category: "verification", text: "Verify base income with the most recent paystub (30 days) and W-2 (1 year)", borrower_id: "B1" }, { id: "V1008", category: "verification", text: "Obtain evidence of hazard insurance coverage", borrower_id: null }, { id: "V1012", category: "verification", text: "Verify the borrowers' identity", borrower_id: null }];
  const interp = await tool(b.app_id, "23.2", "parseFindings", { op: "interpret", submission_id: submission["submission_id"], submission_number: 1, recommendation: "approve_eligible", messages, validation_results: [], value_acceptance_offer: { offered: false }, mi_requirement: { required: false, coverage_pct: null }, du_release: "2026-09-25", policy_generation: "2026_09_26", request_hash: built.output["request_hash"], findings_received_at: EDT("2026-11-02", "12:00"), facts: { transaction_type: "purchase", product: "standard", term_months: 360, ltv_x100: 8000, loan_amount_cents: "42000000", units: 1, county_limit_cents: null, score_model: "classic_fico", borrower_ids: ["B1"], all_occupying_first_time: true, all_borrowers_first_time: true, du_no_tradelines: false, closing_date: "2026-12-15" } }, UNDERWRITER);
  clock.set(EDT("2026-11-03", "09:00")); const decisionId = `D-PA-${R}`;
  await tool(b.app_id, "23.3", "assessRisk", { risk_input: { credit: { score_model: "classic_fico", representative_score: 742, history_summary: "no 30-day lates in 24 months" }, capacity: { dti_bps: 3300, residual_income_cents: "540000", income_sources: ["base_salary"], income_reconciled_to_22_3: true }, capital: { funds_to_close_cents: "11500000", reserves_months: 4, assets_reconciled_to_22_4: true }, collateral: { ltv_x100: 8000, cltv_x100: 8000, hcltv_x100: 8000, valuation_method: "traditional", cu_score: null }, du_risk_factors: [], eligibility_outside_du_confirmed: true, legal_compliance_confirmed: true }, decision_id: decisionId }, UNDERWRITER);
  const file = newDecisionFile({ application_id: b.app_id, partner_name: partnerName, partner_address: "100 Partner Plaza, Phoenix, AZ 85004", creditor_time_zone: "America/New_York", application_date: "2026-11-02", property_state: "AZ", applicants: [{ id: "B1", name: b.name, mailing_address: "7 Mesa Ct, Phoenix AZ 85018", email: b.email, esign_consent: true, primary: true }] });
  await tool(b.app_id, "23.3", "issueConditionalApproval", { decision_id: decisionId, file, guard: K<Json>("GUARD"), validity: { credit_expires_at: "2027-03-02", lock_expires_at: null, valuation_expires_at: null, du_close_by_date: null }, inputs: { ulad_snapshot_hash: built.output["request_hash"], verification_ids: [], findings_hash: "findings:sub1" }, du_submission_id: submission["submission_id"], interpretation_id: (interp.output["interpretation"] as { interpretation_id?: string } | undefined)?.interpretation_id, evidence_document_ids: [], rationale: "Approve/Eligible on a TBD property; income and credit within policy.", confidence: 0.93 }, UNDERWRITER); await settle();
  assert.equal((await events(b.app_id, "preapproval.letter.issued")).length, 1, "the flow issued the letter through 20.3 on the decision");
  assert.ok((await b.cards()).some((x) => x.kind === "DocumentCard" && x.copy_key === "preapproval.letter"), "the letter DocumentCard");
  // C1/C2 (a day later): under contract — the upload card on request, the contract uploaded (the FAKE extractor reads it), the extracted fields confirmed on the card → the sixth item, TRID
  await advance(EDT("2026-11-04", "09:20")); await b.signIn("L2");
  r = await b.say("Good news, we are under contract on a house in Phoenix."); await assertModelReply(b, r, { text: /Send the signed contract with the upload card/ });
  const uploadCard = await b.pending("documents.upload.fallback"); assert.equal(uploadCard.props["document_class"], "purchase_contract");
  const contract = { property_address: "9 Saguaro Way, Phoenix, AZ 85018", purchase_price_cents: "52500000", contract_date: "2026-11-03", closing_date: "2026-12-15", earnest_money_cents: "1000000", earnest_money_holder: "Desert Title Agency LLC", financing_contingency_date: "2026-11-24", appraisal_contingency_date: "2026-11-24", seller_concessions_cents: "500000", seller_names: ["S. Seller"] };
  const bytes = Buffer.from(JSON.stringify(contract)); later(1);
  const up = await api("POST", "/v1/borrower/documents", { application_id: b.app_id, document_class: "purchase_contract", filename: "contract.json", mime_type: "application/json", content_base64: bytes.toString("base64") }, bearer(b.token)); assert.equal(up.status, 201, JSON.stringify(up.body)); await settle();
  await b.tap(uploadCard, { option_id: "upload", evidence: { document_class: "purchase_contract", file_name: "contract.json", uploaded_at: clock.now() }, args: { document_id: up.body["document_id"], sha256: up.body["sha256"], page_count: 1 } });
  const contractCard = await b.pending("contract.confirm"); assert.equal((contractCard.props["fields"] as { path: string; value: string }[]).find((x) => x.path === "property_address")!.value, contract.property_address);
  later(1); const confirmed = await b.tap(contractCard, fieldsEvidence(contractCard)); assert.ok((confirmed.body["events"] as string[]).includes("application.trid_received"), JSON.stringify(confirmed.body["events"]));
  assert.ok(await timer(b.app_id, "REGZ_1026_19E1_LE_3BD"), "the LE clock starts with the address");
  // the seller relationship (a regulated choice on the contract): stated in words, proposed into the ChoiceCard, confirmed by the tap
  later(1); r = await b.say("We do not know the seller at all, it came through the listing."); await assertModelReply(b, r, { proposedInto: "contract.seller_relationship", text: /No relationship/ });
  const seller = await b.pending("contract.seller_relationship"); later(1); await b.tap(seller, { option_id: "no", evidence: { option_id: "no", tapped_at: clock.now() } });
  // the LE the same afternoon under the E-SIGN consent → the DocumentCard, received by the tap; then the go-ahead and the lock the same way as the refinance
  clock.set(EDT("2026-11-04", "16:00"));
  const le = await deliverLeByConsent(runtime, b.app_id, { render: leRender(b, { as_of: "2026-11-04", loan_cents: "42000000", transaction_type: "purchase", property_address: contract.property_address, estimated_value_cents: "52500000", pricing: { quote_id: quoteId, rate_pct: "6.125", price: "100.000", points_cents: "0", lender_credit_cents: "51500", locked: false } }) as never, mlo: { review_id: `MR-LE-C-${R}`, nmlsr_id: "987654" }, actor: MLO });
  assert.equal(le.channel, "esign_portal"); await settle();
  clock.set(EDT("2026-11-04", "16:30")); await b.signIn("L2");
  r = await b.say("I got the loan estimate for the house, what now?"); await assertModelReply(b, r, { text: /Loan Estimate is here as a document/ });
  const leCard = await b.pending("le.delivered"); later(2); await b.tap(leCard, { option_id: "confirm", evidence: { opened_at: clock.now(), scrolled_to_end: true } });
  await advance(MST("2026-11-05", "10:05")); await publishSheet("2026-11-05");
  const lq = await tool(b.app_id, "21.4", "getQuote", { loan_amount_cents: "42000000", product_code: "FRM30_CONV", note_rate_pct: "6.125", lock_period_days: 45, at: clock.now() }, PRICING); const lockQuoteId = lq.output["quote_id"] as string;
  later(3); await b.signIn("L2");
  r = await b.say("We are happy with it and ready to move forward."); await assertModelReply(b, r, { text: /go-ahead is a card/ });
  const intent = await b.pending("intent.title"); later(1); const p = await b.tap(intent, { option_id: "proceed", evidence: { option_id: "proceed", tapped_at: clock.now() } }); assert.equal((p.body["result"] as Json)["valid"], true);
  const compare = await b.pending("lock.compare.title"); assert.equal((compare.props["command_args"] as Json)["property_state"], "AZ", "the state read from the confirmed contract address");
  later(1); const locked = await b.tap(compare, { option_id: lockQuoteId, evidence: { option_id: lockQuoteId, tapped_at: clock.now() } }); assert.equal((locked.body["result"] as Json)["status"], "pending_mlo_approval");
  const lockId = String((locked.body["result"] as Json)["lock_id"]); clock.set(MST("2026-11-05", "10:19"));
  await tool(b.app_id, "21.4", "executeLock", { lock_id: lockId, op: "approve", quote_id: lockQuoteId, mlo_nmlsr_id: "987654", approved_at: clock.now() }, MLO);
  const lock = await tool(b.app_id, "21.4", "executeLock", { lock_id: lockId, executed_at: clock.now() }, PRICING); assert.equal(lock.output["status"], "executed"); await settle();
  assert.ok((await b.cards()).some((x) => x.copy_key === "lock.executed"));
  await tool(b.app_id, "21.4", "requestCommitment", { lock_id: lockId, at: MST("2026-11-05", "10:20") }, PRICING); await settle();
  const lockExpiresOn = String(lock.output["expires_on"]);
  // ── C: underwriting's items from the Nov 2 DU run (V1001 the pay stub and the W-2, V1008 the policy; V1012 the platform's) — the UploadCards narrated in plain words, each a tap, 22.1 reviews, the FAKE reviewer clears
  later(1); r = await b.say("What do you need from me now?"); await assertModelReply(b, r, { text: /Underwriting's list is on the rail/ });
  const conds = await entitiesOf("conditions", b.app_id); const cond = (code: string) => { const x = conds.find((y) => y.data["template_code"] === code); assert.ok(x, `condition ${code}`); return x; };
  const uploads = (await b.cards()).filter((x) => x.kind === "UploadCard" && x.status === "pending" && x.props["condition_id"]); assert.ok(uploads.length >= 3, `the borrower's uploads (${uploads.map((x) => x.props["document_class"]).join(", ")})`);
  const requests = await entitiesOf("document_requests", b.app_id);
  const docs: [string, string, Json, string][] = [["paystub", "COND_DU_VERIFY_INCOME_BASE", { employer_name: "Acme Manufacturing", pay_date: "2026-10-30", pay_period_start: "2026-10-17", pay_period_end: "2026-10-30", gross_current_cents: "378500", gross_ytd_cents: "8327000" }, "2026-10-30"], ["w2", "COND_DU_VERIFY_INCOME_BASE", { employer_name: "Acme Manufacturing", tax_year: 2025, wages_cents: "9840000" }, "2026-01-31"], ["homeowners_policy", "COND_DU_PROPERTY_HAZARD_INSURANCE", { carrier: "FAKE Mutual", policy_number: "HO-9", effective_date: "2026-11-18", expiration_date: "2027-11-18" }, "2026-11-04"]];
  const reviewed = new Map<string, { document_id: string; kind: string; document_date: string }[]>();
  for (const [cls, code, fields, dated] of docs) {
    const card = uploads.find((x) => x.props["document_class"] === cls); assert.ok(card, `an UploadCard for the ${cls}`); assert.equal(card.props["condition_id"], cond(code).id);
    later(1); const id = randomUUID(); await b.tap(card, { option_id: "upload", evidence: { document_class: cls, file_name: `${cls}.pdf`, uploaded_at: clock.now() }, args: { document_id: id, sha256: sha(id), page_count: 1 } });
    assert.ok(requests.some((q) => q.id === card.props["request_id"]), "22.1's request behind the card");
    await review(b, id, cls, fields); reviewed.set(code, [...(reviewed.get(code) ?? []), { document_id: id, kind: cls === "homeowners_policy" ? "hoi_declaration" : cls, document_date: dated }]);
  }
  for (const [code, evidence] of reviewed) await clear(b, cond(code).id, evidence, "2026-11-18");
  await clearPlatformConditions(b, ["COND_DU_VERIFY_INCOME_BASE", "COND_DU_PROPERTY_HAZARD_INSURANCE"], "2026-11-05", "2026-11-18");
  for (const code of ["COND_DU_VERIFY_INCOME_BASE", "COND_DU_PROPERTY_HAZARD_INSURANCE"]) assert.equal((await entity("conditions", cond(code).id))!["status"], "cleared", code);
  assert.equal((await b.cards()).filter((x) => x.kind === "UploadCard" && x.status === "pending").length, 0, "every upload ask answered");
  // ── the appraisal: on a purchase the appraiser is met by the seller's side (32.6 T4: the access ScheduleCard is the refinance's; a HandoffCard tells the buyer). GAP (journey-purchase.ts gap 3): 24.1 reads `du.findings.received.value_acceptance_offer` as a string while 23.1's FAKE findings carry `{offered, property_value_cents}`, so no 24.1 order can be placed once DU has run — and here DU ran on the to-be-determined file for the preapproval letter, before the contract and the intent 24.1 R2 requires. The valuation stays the platform's (CTC_VALUATION is a fact of the checklist); nothing is faked past the gap.
  // ── title (24.4) Mon Nov 9 / Tue Nov 10: the settlement agent vetted, the commitment, the CPL — the platform's own items
  await advance(MST("2026-11-09", "13:00")); const AGENT = J.AGENT_PARTY; const UW_PARTY = `TU-AZ-C-${R}`;
  await tool(b.app_id, "24.4", "vetSettlementAgent", { party_id: AGENT, agent_type: "title_agency", state: "AZ", property_state: "AZ", license_active: true, license_number: "AZ-TA-4471", eo_policy_limit_cents: "200000000", eo_expires_on: "2027-06-30", fidelity_limit_cents: "100000000", alta_registry_id: "ALTA-AZ-4471", underwriter_confirmed_by: UW_PARTY, best_practices_attestation_at: "2026-08-15", wire_instructions_on_letterhead: true, cpl_available: true, underwriter_callback_number_verified: true, referral_consideration: false, at: clock.now() }, CLOSER);
  const titleOrder = await tool(b.app_id, "24.4", "orderTitle", { settlement_agent_party_id: AGENT, underwriter_party_id: UW_PARTY, apn: "301-45-118", note_amount_cents: "42000000", proposed_insured_text: `${partnerName}, its successors and/or assigns`, closing_date: "2026-11-18", property: { state: "AZ" }, at: clock.now() }, CLOSER); const titleOrderId = (titleOrder.output["order"] as { id: string }).id;
  clock.set(MST("2026-11-10", "10:00"));
  await tool(b.app_id, "24.4", "parseCommitment", { order_id: titleOrderId, commitment_number: `CMT-AZ-C-${R}`, commitment_effective_date: "2026-11-09", underwriter_party_id: UW_PARTY, underwriter_state: "AZ", doi_licensed: true, strength_basis: "rating", policy_form: "ALTA Loan Policy (07-01-2021)", policy_amount_cents: "42000000", legal_description: LEGAL_P, apn: "301-45-118", vesting: { names: [b.name], tenancy: "sole", trust: false, estate: "fee_simple" }, schedule_b1_requirements: ["Deed from S. Seller to the insured borrower, recorded"], schedule_b2_exceptions: [], endorsements_committed: ["ALTA 8.1-06"], property: { state: "AZ" }, appraisal_legal_description: LEGAL_P, at: clock.now() }, CLOSER);
  await tool(b.app_id, "24.4", "requestCPL", { order_id: titleOrderId, partner_name: partnerName, sm_addressee_required: true, at: clock.now() }, CLOSER);
  await tool(b.app_id, "24.4", "requestCPL", { op: "receive", order_id: titleOrderId, cpl_document_id: `doc-cpl-c-${R}`, cpl_date: "2026-11-10", cpl_underwriter_party_id: UW_PARTY, cpl_agent_party_id: AGENT, addressees: [`${partnerName}, its successors and/or assigns`, "Supermortgage LLC, as bailee/secured party"], partner_name: partnerName, sm_addressee_required: true, funding_date: "2026-11-18", at: clock.now() }, CLOSER);
  await settle();
  // ── clear to close (23.3) Wed Nov 11 → the StatusCard
  await advance("2026-11-11T20:00:00.000Z");
  const checklist = await tool(b.app_id, "23.3", "runCtcChecklist", { op: "ctc", decision_id: decisionId, facts: K<Json>("CTC_FACTS") }, UNDERWRITER);
  const ctc = await tool(b.app_id, "23.3", "issueClearToClose", { decision_id: decisionId, checklist: checklist.output }, UNDERWRITER); assert.equal(ctc.output["event"], "clear_to_close.issued"); await settle();
  assert.ok((await b.cards()).some((x) => x.copy_key === "ctc.reached"));
  // ── the CD (25.2) Thu Nov 12: the settlement agent's and the escrow figures, the APR, the render (a purchase: not rescindable, the seller named), e-delivered under the consent → the DocumentCard, narrated, received by the tap; the waiting period → the closing cards
  await advance(MST("2026-11-12", "09:00"));
  await tool(b.app_id, "25.2", "assembleCdFigures", { op: "record_source", source_id: `SRC-SA-C-${R}`, party: "settlement_agent", payload: { fees: [{ fee_code: "title_lender_policy", amount_cents: "120000" }, { fee_code: "settlement_fee", amount_cents: "60000" }, { fee_code: "recording", amount_cents: "3000" }] }, payload_document_id: "DOC-SA-FEES-C" }, DISCLOSURE);
  await tool(b.app_id, "25.2", "assembleCdFigures", { op: "record_source", source_id: `SRC-ESCROW-C-${R}`, party: "escrow", payload: { monthly_cents: "68750", deposit_cents: "206250" } }, DISCLOSURE);
  const PREPAID_C = "84576";   // 26.3: $420,000 × 6.125 % ÷ 365 = $70.48 a day × 12 days (Nov 19–30): Arizona is a dry state, so a purchase signed Wed Nov 18 funds Thu Nov 19
  const cdFees = (K<Json[]>("CD_FEES")).map((x) => ({ ...x, source_id: String(x["source_id"]).replace(`SRC-SA-${J.R}`, `SRC-SA-C-${R}`).replace(`SRC-ESCROW-${J.R}`, `SRC-ESCROW-C-${R}`).replace(`SRC-CREDITOR-${J.R}`, `SRC-CREDITOR-C-${R}`), ...(x["fee_code"] === "prepaid_interest" ? { amount_cents: PREPAID_C, description: "Prepaid interest ($70.48 per day from 11/19/2026 to 12/01/2026)" } : {}) }));
  await tool(b.app_id, "25.2", "reconcileFigureSources", { fees: cdFees }, DISCLOSURE);
  const apr = await tool(b.app_id, "25.1", "computeApr", { loan_amount_cents: "42000000", note_rate_pct: "6.125", term_months: 360, term_start_date: "2026-11-19", first_payment_date: "2027-01-01", prepaid_finance_charges_cents: "287976", prepaid_interest_cents: PREPAID_C, checkpoint: "cd" }, COMPLIANCE);
  const PI_C = piCents(42_000_000n, 6.125, 360); const cdId = `CD-${b.app_id.slice(0, 8)}-1`;
  await tool(b.app_id, "25.2", "renderCd", { disclosure_id: cdId, cd_version: 1, transaction_type: "purchase", state: "AZ", required_consumer_ids: ["B1"],
    loan: { loan_amount_cents: "42000000", rate_pct: "6.125", term_months: 360, pi_cents: PI_C, product: "Fixed Rate", loan_type: "Conventional", purpose: "Purchase", prepayment_penalty: false, balloon: false, arm: false, loan_id_number: b.app_id, mic_number: null, first_payment_date: "2027-01-01", maturity_date: "2056-12-01" },
    apr: { apr_calculation_id: apr.output["apr_calculation_id"], apr_pct: apr.output["apr_disclosed_str"], finance_charge_cents: apr.output["finance_charge_cents"], amount_financed_cents: apr.output["amount_financed_cents"], total_of_payments_cents: apr.output["total_of_payments_cents"], tip_pct: String(Number(apr.output["tip_pct"]).toFixed(3)) },
    fees: cdFees, escrow: { established: true, monthly_escrow_cents: "68750", initial_escrow_payment_cents: "206250", escrowed_costs_year1_cents: "825000", non_escrowed_costs_year1_cents: "0" },
    parties: { borrowers: [b.name], seller_name: "S. Seller", creditor_name: partnerName, creditor_nmlsr_id: "123456", mlo_name: "Jordan Rivera", mlo_nmlsr_id: "987654", settlement_agent_name: "Desert Title Agency LLC", settlement_agent_license_id: "AZ-TA-4471" },
    dates: { date_issued: "2026-11-12", closing_date: "2026-11-18", disbursement_date: "2026-11-19" }, property_address: "9 Saguaro Way, Phoenix AZ 85018", cash_to_close_cents: "11500000", lender_credits_cents: "51500", payoffs_and_payments_cents: "0", rescindable: false }, DISCLOSURE);
  clock.set(MST("2026-11-12", "09:14"));
  await tool(b.app_id, "25.2", "deliverDisclosure", { disclosure_id: cdId, consumer_id: "B1", channel: "esign_portal", at: clock.now(), esign_consent_id: consentId, gate_run: { run_id: "RUN-CD-C-1", open: true, apr_verdict: "pass", blocked_channels: [] } }, DISCLOSURE); await settle();
  clock.set(MST("2026-11-12", "09:30")); await b.signIn("L2");
  r = await b.say("The closing disclosure just arrived, are these the final numbers?"); await assertModelReply(b, r, { text: /Closing Disclosure is the final form/ });
  const cdCard = await b.pending("cd.delivered"); assert.equal(cdCard.kind, "DocumentCard"); later(2); await b.tap(cdCard, { option_id: "confirm", evidence: { opened_at: clock.now(), scrolled_to_end: true } });
  assert.equal((await events(b.app_id, "disclosure.cd.received")).length, 1);
  const wp = await tool(b.app_id, "25.2", "computeEarliestConsummation", { disclosure_id: cdId }, DISCLOSURE); const earliest = String(wp.output["earliest_consummation_date"]); assert.ok(earliest <= "2026-11-18", `the waiting period ends by the closing date (${earliest})`); await settle();
  // ── the closing slot (26.2): electronic signing chosen on the card beside it, the Wednesday morning RON window tapped → scheduled, the people cards
  later(2); r = await b.say("When can we sign? Wednesday morning would be best."); await assertModelReply(b, r, { text: /signing window on the schedule card/ });
  const electronic = await b.pending("closing.electronic_or_paper"); later(1); await b.tap(electronic, { option_id: "electronic", evidence: { option_id: "electronic" } });
  const closingCard = await b.pending("closing.schedule"); assert.equal(closingCard.props["earliest_consummation_date"], earliest); assert.equal((closingCard.props["command_args"] as Json)["rescindable"], false, "a purchase is not rescindable"); assert.equal((closingCard.props["command_args"] as Json)["transaction_type"], "purchase");
  const ron = (closingCard.props["slots"] as { id: string; starts_at: string; closing_type: string }[]).find((x) => x.closing_type === "ron" && x.id === "ron:2026-11-18T10"); assert.ok(ron, `a Wednesday morning RON window: ${JSON.stringify(closingCard.props["slots"]).slice(0, 300)}`);
  later(1); const booked = await b.tap(closingCard, { option_id: ron.id, evidence: { slot_id: ron.id } }); assert.equal(booked.body["command"], "closing.selectSlot"); const closingId = String((booked.body["result"] as Json)["closing_id"]); assert.equal((booked.body["result"] as Json)["closing_type"], "ron");
  assert.ok((await b.cards()).some((x) => x.copy_key === "closing.confirmed")); assert.ok((await b.cards()).some((x) => x.kind === "PersonCard"), "the notary / settlement agent PersonCards");
  // ── the closing package (26.1) Mon Nov 16 and the RON signing (26.2, FAKE) Wed Nov 18 10:00 MST: the HandoffCard before the session, the eNote signed = consummation (no rescission on a purchase)
  await advance(MST("2026-11-16", "10:00"));
  const closingSnapshot: Json = { ...K<() => Json>("CLOSING_SNAPSHOT")(), min: MIN_P, lock_id: lockId, partner: { legal_name: partnerName, nmlsr_id: "123456", mers_org_id: "1000123" }, property_address: contract.property_address, legal_description: LEGAL_P, transaction_type: "purchase", vesting: "individual", vesting_text: `${b.name}, an unmarried person`, borrowers: [{ party_id: "B1", legal_name: b.name, credit_used: true, on_title: true, capacities: ["borrower"] }], loan_amount_cents: "42000000", note_rate_pct: "6.125", note_date: "2026-11-18", scheduled_disbursement_date: "2026-11-19", scheduled_closing_date: "2026-11-18", rescindable: false };
  const terms = await tool(b.app_id, "26.1", "computeNoteTerms", { principal_cents: "42000000", note_rate_pct: "6.125", term_months: 360, scheduled_disbursement_date: "2026-11-19", state: "AZ" }, CLOSER); assert.equal(terms.output["pi_cents"], PI_C, "26.1's P&I is the CD's"); assert.equal(terms.output["first_payment_date"], "2027-01-01");
  const gate = { ...K<Json>("DOCGEN_GATE"), lock_expires_on: lockExpiresOn, closing_date: "2026-11-18" }; const g26 = await tool(b.app_id, "26.1", "evaluateDocGenGates", { gate }, CLOSER); const setId = g26.output["set_id"] as string;
  await tool(b.app_id, "26.1", "takeClosingSnapshot", { set_id: setId, snapshot: closingSnapshot, gate }, CLOSER);
  const rendered = await tool(b.app_id, "26.1", "renderDocument", { set_id: setId }, CLOSER); const rdocs = rendered.output["documents"] as { kind: string; data_hash: string }[]; assert.equal(rdocs.find((d) => d.kind === "enote")!.data_hash, terms.output["data_hash"]); assert.ok(!rdocs.some((d) => d.kind === "rescission_notice_h8"), "no H-8 in a purchase package");
  const smart = await tool(b.app_id, "26.1", "buildSmartDocENote", { set_id: setId }, CLOSER);
  await tool(b.app_id, "26.1", "runDocumentQc", { set_id: setId, upstream: { enote: smart.output, cd: { loan_amount_cents: "42000000", note_rate_pct: "6.125", pi_cents: PI_C, org_nmlsr_id: "123456", mlo_nmlsr_id: "987654", first_payment_date: "2027-01-01" }, du: { loan_amount_cents: "42000000", note_rate_pct: "6.125", term_months: 360 }, lock: { note_rate_pct: "6.125" }, title: { vesting_text: closingSnapshot["vesting_text"], legal_description: closingSnapshot["legal_description"] }, urla_1003: { org_nmlsr_id: "123456", mlo_nmlsr_id: "987654", loan_amount_cents: "42000000", note_rate_pct: "6.125", term_months: 360 }, note_date: "2026-11-18" } }, CLOSER);
  clock.set(MST("2026-11-16", "16:00")); await tool(b.app_id, "26.1", "releaseToSettlementAgent", { set_id: setId, released_to_party_id: AGENT, facts: { qc_pass_gate_open: true, template_version_gate_open: true } }, CLOSER); await settle();
  assert.ok((await b.cards()).some((x) => x.copy_key === "closing.presign" && x.kind === "HandoffCard" && x.status === "pending"), "the pre-signing HandoffCard");
  await advance(MST("2026-11-17", "09:00")); const released = (await events(b.app_id, "closing.documents.released"))[0]!;
  await tool(b.app_id, "26.2", "runPreSessionChecks", { op: "upstream", closing_id: closingId, event: { type: "closing.documents.released", occurredAt: MST("2026-11-16", "16:00"), payload: released.payload } }, CLOSER);
  await advance(MST("2026-11-18", "09:00")); const consent = (await db.query<{ id: string; scope: string[]; captured_at: string }>(`SELECT id, scope, captured_at FROM consents WHERE id = $1`, [consentId]))[0]!;
  const closingConsent = { ...K<Json>("CLOSING_CONSENT"), consent_id: consentId, granted_at: consent.captured_at, scope: ["disclosures", "closing_package"] };
  await tool(b.app_id, "26.2", "verifyEsignConsent", { closing_id: closingId, consent: closingConsent }, CLOSER);
  const pre = await tool(b.app_id, "26.2", "runPreSessionChecks", { closing_id: closingId, consent: closingConsent, facts: { ...K<Json>("PRE_SESSION_FACTS"), le: { earliest_consummation_date: "2026-11-11" }, cd: { earliest_consummation_date: earliest, receipts_complete: true }, signing_package: [{ consumer_id: "B1", copies: 1, channel: "ron", material_disclosures_in_package: true, receipt_capture: true }] } }, CLOSER); assert.equal(pre.output["passed"], true, JSON.stringify(pre.output["blocking"]));
  clock.set(MST("2026-11-18", "10:00")); const sessionId = `SES-C-${R}`; const NOTARY = J.NOTARY;
  await tool(b.app_id, "26.2", "openSigningSession", { closing_id: closingId, session_id: sessionId, signer_party_ids: ["B1"], notary: NOTARY, consent_record_id: consentId }, CLOSER);
  clock.set(MST("2026-11-18", "10:07")); await tool(b.app_id, "26.2", "monitorSession", { op: "identity", closing_id: closingId, party_id: "B1", method: "credential_analysis_kba", credential_type: "driver_license", credential_analysis_result: "pass", kba_attempts: [{ questions: 5, correct: 5, seconds: 64, at: clock.now(), notary_party_id: NOTARY.party_id }], notary_party_id: NOTARY.party_id, vendor: "Proof" }, CLOSER);
  await tool(b.app_id, "26.2", "monitorSession", { op: "start", closing_id: closingId }, CLOSER); await settle();
  assert.ok(!(await b.cards()).some((x) => x.copy_key === "closing.presign" && x.status === "pending"), "the hand-off closed when the session started");
  await tool(b.app_id, "26.2", "monitorSession", { op: "enote_created", closing_id: closingId, closing_document_id: `DOC-ENOTE-C-${R}`, min: MIN_P, partner_org_id: "1000123" }, CLOSER);
  await tool(b.app_id, "26.2", "monitorSession", { op: "sign", closing_id: closingId, closing_document_id: `DOC-1003-C-${R}`, kind: "final_1003", signer_party_id: "B1", signed_at: MST("2026-11-18", "10:18"), signature_method: "esign_ron", required_note_signers: ["B1"] }, CLOSER);
  const signed = await tool(b.app_id, "26.2", "monitorSession", { op: "sign", closing_id: closingId, closing_document_id: `DOC-ENOTE-C-${R}`, kind: "enote", signer_party_id: "B1", signed_at: MST("2026-11-18", "10:26"), signature_method: "esign_ron", required_note_signers: ["B1"] }, CLOSER); assert.equal(signed.output["note_date"], "2026-11-18"); assert.ok(signed.events.some((e) => e.type === "closing.consummated"), "the eNote's signature is consummation");
  await tool(b.app_id, "26.2", "monitorSession", { op: "sign", closing_id: closingId, closing_document_id: `DOC-DOT-C-${R}`, kind: "security_instrument", signer_party_id: "B1", signed_at: MST("2026-11-18", "10:31"), signature_method: "esign_ron", required_note_signers: ["B1"] }, CLOSER);
  await tool(b.app_id, "26.2", "monitorSession", { op: "notarial_act", closing_id: closingId, closing_document_id: `DOC-DOT-C-${R}`, kind: "security_instrument", act_type: "acknowledgment", completed_at: MST("2026-11-18", "10:36"), certificate_indicates_communication_technology: true, recordable: true, last: true, notary_party_id: NOTARY.party_id }, CLOSER);
  const copy = `<SMART_DOCUMENT version="1.02"><DATA min="${MIN_P}" amount="420000.00" rate="6.125"/></SMART_DOCUMENT>`;
  clock.set(MST("2026-11-18", "10:41")); await tool(b.app_id, "26.2", "validateAuthoritativeCopy", { op: "seal", closing_id: closingId, seal_hash: sha(copy), signing_completed_at: MST("2026-11-18", "10:26"), authoritative_copy_ref: `EV-C-${R}`, tamper_sealed_at: clock.now() }, CLOSER);
  clock.set(MST("2026-11-18", "10:43")); const valid = await tool(b.app_id, "26.2", "validateAuthoritativeCopy", { closing_id: closingId, authoritative_copy: copy }, CLOSER); assert.equal(valid.output["gate_open"], true, String(valid.output["reason"]));
  clock.set(MST("2026-11-18", "10:44")); const reg = await tool(b.app_id, "26.2", "registerENote", { closing_id: closingId }, CLOSER); assert.equal(reg.output["accepted"], true, JSON.stringify(reg.output).slice(0, 300)); await settle();
  assert.ok((await b.cards()).some((x) => x.copy_key === "signed.purchase"), "the purchase's signed StatusCard"); assert.equal((await events(b.app_id, "rescission.period.computed")).length, 0, "no rescission period on a purchase");
  // ── funding (26.3): the calendar opened on the note date (Arizona is a dry state — a purchase signed Wednesday funds Thursday, 26.3's own rule), the worksheet, then Thu Nov 19 the conditions, the advance, the wire released by the FAKE funding approver on the sweep (dual control), the agent's receipt, the disbursement → loan.funded
  clock.set(MST("2026-11-18", "11:00")); const F = `F-C-${R}`;
  const opened = await tool(b.app_id, "26.3", "computeDates", { op: "open", funding_id: F, state: "AZ", transaction_type: "purchase", time_zone: TZ, closing_date: "2026-11-18", closing_id: closingId, consummation_at: MST("2026-11-18", "10:26"), partner_id: partnerId, partner_loan_number: "PL-C-1001", gross_loan_cents: "42000000", note_rate_pct: "6.125", note_first_payment_date: "2027-01-01" }, FUNDER);
  const cal = opened.output["calendar"] as Json; assert.equal(cal["rescission_expires_at"], null, "no rescission on a purchase"); assert.ok(String(cal["earliest_funding_date"]) <= "2026-11-19", `the calendar allows funding by Thursday (${cal["earliest_funding_date"]}, ${cal["funding_type"]})`);   // the wire released after the afternoon cut-off on the note date would settle Thursday anyway (26.3 funding_date on the release)
  await tool(b.app_id, "26.3", "buildFundingWorksheet", { funding_id: F, version: 1, cd_version: 1, gross_loan_cents: "42000000", prepaid_interest_cents: PREPAID_C, escrow_deposit_cents: "206250", lender_credits_cents: "51500" }, FUNDER);
  const rec = await tool(b.app_id, "26.3", "reconcileToSettlementStatement", { funding_id: F, worksheet_id: `${F}:ws:1`, agent_requested_net_cents: String(42_000_000n - BigInt(PREPAID_C) - 206_250n + 51_500n) }, FUNDER); assert.equal((rec.output["item"] as Json)["status"], "pass", JSON.stringify(rec.output).slice(0, 300));
  await advance(MST("2026-11-19", "08:30")); const fundingFacts = (as_of: string): Json => ({ as_of, funding: { funding_type: cal["funding_type"], transaction_type: "purchase", disbursement_date: "2026-11-19", release_date: "2026-11-19", note_date: "2026-11-18", authorized: false },
    loan: { ltv_pct: 80, sfha: false, project: false, enote: true, tx_50a6: false, record_before_fund: false }, execution: { review_passed: true, all_docs_signed: true, blocking_defects: 0, package_returned: true }, cd: { consummated_version: 1, delivered_with_receipt: true, signed_copy_in_documents: true }, identity: { all_signers_proofed: true },
    rescission: { status: "not_applicable", expires_at: null, reasonably_satisfied_at: null, waiver_id: null, now: as_of }, hazard: { hazard_status: "verified", effective_date: "2026-11-18", transaction_type: "purchase", policy_in_force: true, premium_on_cd: true },
    title: { cpl_open: true, commitment_open: true }, vvoe: { verified_on: "2026-11-16", self_employed: false }, credit_refresh_open: true, compliance_disburse_open: true, ptf: { ptf_cleared: true }, cash_to_close: { worksheet: { reconciled_to_cd: true, sufficient: true } }, gifts: [], mi: { status: "none" }, wire: { verified_at: (K<Json>("VERIFIED_WIRE"))["verified_at"], blocks_disbursement: false, callback_number_source: "alta_registry", as_of },
    payoffs: [], first_payment: { first_payment_date: "2027-01-01" }, audit_trail_open: true, enote: { registered: true, secured_party_set: true }, qc_hold: false, commitment: { active: true, expires_on: "2026-12-20" }, worksheet: { reconciled: true }, fraud: { fraud_hold: false, ofac_clear: true } });
  const conditions = await tool(b.app_id, "26.3", "evaluateFundingConditions", { funding_id: F, facts: fundingFacts(clock.now()) }, FUNDER); assert.equal(conditions.output["passed"], true, JSON.stringify({ blocking: conditions.output["blocking_codes"], pending: conditions.output["pending_codes"] }));
  clock.set(MST("2026-11-19", "08:45")); await tool(b.app_id, "26.3", "requestWarehouseAdvance", { funding_id: F, conditions: conditions.output, rescission: { status: "not_applicable" }, fraud_hold: { fraud_hold: false }, ptf: { ptf_cleared: true }, cash_to_close: { worksheet: { reconciled_to_cd: true, sufficient: true } }, gifts: [] }, FUNDER);
  await tool(b.app_id, "26.3", "requestWarehouseAdvance", { funding_id: F, op: "advance_approved", advance_id: `ADV-C-${R}` }, FUNDER);
  clock.set(MST("2026-11-19", "09:00")); const wireId = `W-C-${R}`; const wireRecord = K<Json>("VERIFIED_WIRE");
  await tool(b.app_id, "26.3", "prepareWire", { funding_id: F, wire_id: wireId, record: wireRecord, instructions_hash: wireRecord["instructions_hash"], instructions_source: "verified_record", value_date: "2026-11-19", prepared_at: clock.now(), run_id: "run-funder-c-1", editors: ["u-analyst"], borrower_last_name: "Rivera", property_short: "9 Saguaro Way, Phoenix AZ", funding_account_ref_hash: "sha256:funding", closing_documents: [] }, FUNDER);
  clock.set(MST("2026-11-19", "09:20")); const sweep = await runtime.sweep(clock.now()); await settle();
  const wireRow = await entity("funding_wires", wireId); let releasedBy = "FAKE:funding_approver";
  if (!["released", "accepted"].includes(String(wireRow?.["status"]))) { await tool(b.app_id, "26.3", "prepareWire", { funding_id: F, op: "release", wire_id: wireId, bank_ref: "BK-C-1", released_at: clock.now() }, APPROVER); releasedBy = APPROVER.id; }
  process.stderr.write(`wire ${wireId} released by ${releasedBy} (${sweep.reviewers?.line ?? "no reviewers"})\n`);
  await tool(b.app_id, "26.3", "prepareWire", { funding_id: F, op: "accept", wire_id: wireId, imad: "20261119B1QGC01R000420", accepted_at: MST("2026-11-19", "09:21") }, FUNDER);
  clock.set(MST("2026-11-19", "09:40")); await tool(b.app_id, "26.3", "notifySettlementAgent", { funding_id: F, op: "agent_receipt", funds_received_by_agent_at: clock.now() }, FUNDER);
  clock.set(MST("2026-11-19", "10:15")); const funded = await tool(b.app_id, "26.3", "confirmDisbursement", { funding_id: F, disbursement_date: "2026-11-19", confirmed_at: clock.now(), source: "final_settlement_statement", evidence_document_id: "DOC-FSS-C", escrow_deposit_cents: "206250" }, FUNDER); assert.ok(funded.events.some((e) => e.type === "loan.funded")); await settle();
  const lf = funded.output["loan_funded"] as Json; assert.equal(lf["prepaid_interest_cents"], PREPAID_C, JSON.stringify(lf).slice(0, 300)); assert.equal(lf["prepaid_days"], 12);
  assert.ok((await b.cards()).some((x) => x.copy_key === "funded.purchase"), "the purchase's funded StatusCard");
  // ── boarding (30.2): POST /fund from the record with the purchase snapshot (the note 26.1 computed, the final CD, the escrow analysis, LTV 80 — no MI, the contract's property) → the servicing loan with balanced opening entries; the welcome, the first-payment letter and the autopay card
  clock.set(MST("2026-11-19", "12:20"));
  const boarded = await J.call("POST", `/v1/applications/${b.app_id}/fund`, { actor: FUNDING, snapshot: {
    note: { amount_cents: "42000000", note_rate_pct: "6.125", term_months: 360, first_payment_date: "2027-01-01", maturity_date: "2056-12-01", late_charge_pct: String(terms.output["late_charge_pct"] ?? "5.00"), late_charge_grace_days: Number(terms.output["late_charge_grace_days"] ?? 15), partner_nmlsr_id: "123456", mlo_nmlsr_id: "987654" },
    final_cd: { document_id: cdId, pi_cents: PI_C, monthly_escrow_cents: "68750", initial_escrow_deposit_cents: "206250", prepaid_interest_cents: PREPAID_C, prepaid_interest_days: 12, compliance_tests_passed: true },
    escrow_analysis: { source: "origination", type: "initial", required_start_balance_cents: "68750", cushion_cents: "137500", monthly_escrow_cents: "68750", lines: [{ line_type: "county_tax", annual_amount_cents: "640000", monthly_cents: "53333" }, { line_type: "hazard", annual_amount_cents: "185000", monthly_cents: "15417" }], status: "active" },
    ltv_pct: "80.00", mi: null,
    property: { address_line1: "9 Saguaro Way", city: "Phoenix", state: "AZ", postal_code: "85018", county: "Maricopa", apn: "301-45-118", property_type: "sfr", units: 1, occupancy: "primary", flood_zone: "X", sfha: false, appraised_value_cents: "52500000", original_value_cents: "52500000" },
    hazard: { verified: true, mortgagee_clause_partner_isaoa_co_sm: true, expires_on: "2027-11-18" } } });
  assert.equal(boarded.status, 200, JSON.stringify(boarded.body).slice(0, 1500)); b.loan_id = boarded.body["loan_id"] as string; await settle();
  const loan = (await db.query<{ origination_application_id: string | null; status: string; boarded_at: string | null; partner_party_id: string }>(`SELECT origination_application_id, status, boarded_at, partner_party_id FROM loans WHERE id = $1`, [b.loan_id]))[0]!;
  assert.equal(loan.origination_application_id, b.app_id); assert.equal(loan.status, "active"); assert.ok(loan.boarded_at); assert.equal(loan.partner_party_id, partnerId);
  const app = (await db.query<{ loan_id: string | null; status: string; transaction_type: string }>(`SELECT loan_id, status, transaction_type::text AS transaction_type FROM applications WHERE id = $1`, [b.app_id]))[0]!; assert.equal(app.loan_id, b.loan_id); assert.equal(app.status, "funded"); assert.equal(app.transaction_type, "purchase");
  const n = async (sql: string, params: unknown[]): Promise<number> => Number((await db.query<{ c: string }>(sql, params))[0]!.c);
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_terms WHERE loan_id = $1 AND source = 'boarding' AND pi_cents = $2 AND escrow_payment_cents = 68750 AND note_rate_bps = 61250`, [b.loan_id, PI_C]), 1);
  const log = await events(b.app_id); for (const t of ["loan.funded", "loan.staged", "loan.validated", "loan.boarded", "ledger.opening_posted", "consents.boarded", "documents.indexed", "timers.seeded", "statement.cycle.opened"]) assert.ok(log.some((e) => e.type === t), `${t} emitted`);
  assert.equal(await n(`SELECT count(*)::text AS c FROM boarding_validations WHERE application_id = $1 AND rule_code LIKE 'OB-%' AND result = 'pass'`, [b.app_id]), 22);
  const setIdOpening = boarded.body["opening_entry_set_id"] as string; assert.ok(setIdOpening);
  assert.equal(await n(`SELECT count(*)::text AS c FROM (SELECT set_id FROM ledger_lines WHERE set_id = $1 GROUP BY set_id HAVING sum(amount_cents) <> 0) x`, [setIdOpening]), 0, "the opening set balances");
  const balance = async (account: string): Promise<bigint> => BigInt((await db.query<{ s: string }>(`SELECT coalesce(sum(amount_cents), 0)::text AS s FROM ledger_lines WHERE loan_id = $1 AND account = $2`, [b.loan_id, account]))[0]!.s);
  assert.equal(await balance("principal"), 42_000_000n); assert.equal(-(await balance("escrow")), 206_250n); assert.equal(-(await balance("prepaid_interest")), BigInt(PREPAID_C));
  assert.equal((await db.query<{ status: string }>(`SELECT status::text AS status FROM timers WHERE code = 'SM_ORIG_BOARD_T1BD' AND application_id = $1`, [b.app_id]))[0]?.status, "satisfied");
  const boardingCards = await b.cards();
  assert.ok(boardingCards.some((x) => x.copy_key === "boarding.welcome" && x.subject_loan_id === b.loan_id), "the welcome"); assert.ok(boardingCards.some((x) => x.copy_key === "first_payment.letter" && x.kind === "NoticeCard"), "the first-payment letter");
  const autopay = boardingCards.find((x) => x.copy_key === "consent.autodraft.title" && x.status === "pending")!; assert.ok(autopay, "the autopay ConsentCard"); assert.equal(autopay.command_ref, "autodraft.enroll");
  // the borrower, back on a fresh code (the money command's fresh L1): autopay narrated, then the card with the account and the typed name
  clock.set(MST("2026-11-19", "13:00")); await b.signInFresh();
  r = await b.say("Can I set up autopay from my checking?"); await assertModelReply(b, r, { text: /Autopay is a card on the rail/ });
  later(1); await b.tap(autopay, { option_id: "affirm", evidence: { affirmation_method: "checkbox_with_text", typed_name: b.name, checkbox: true, disclosure_version_shown: autopay.props["disclosure_version_id"], account: { last4: "4321", type: "checking", routing: "021000021" } } });
  assert.ok((await db.query(`SELECT 1 FROM loan_events WHERE loan_id = $1 AND type LIKE 'autodraft.%'`, [b.loan_id])).length >= 1, "the enrollment on the loan's log");
  later(1); r = await b.say("Thanks, that is everything."); await assertModelReply(b, r, { text: /You are welcome/ });
  // ── the audit: §2.3 for every card, provenance, verbatim, evidence, the turn ledger; the purchase journey's own cards (the preapproval letter, the contract, the appraiser hand-off) beside the shared ones
  const out = await audit(b, { minCards: 20, subjects: [b.app_id, b.loan_id] });
  for (const c of ["evidence", "consent", "integration", "document_or_choice"]) assert.ok((out.cases.get(c) ?? 0) > 0, `the journey exercised the ${c} case`);
  for (const kind of ["ChoiceCard", "ConfirmCard", "ConsentCard", "ConnectCard", "ProfileCard", "DemographicsCard", "DocumentCard", "ComparisonCard", "UploadCard", "ChecklistCard", "ScheduleCard", "StatusCard", "NoticeCard", "PersonCard", "HandoffCard"]) assert.ok((out.byKind.get(kind) ?? 0) > 0, `the purchase raised a ${kind}`);
  for (const key of ["preapproval.where", "preapproval.target", "preapproval.letter", "contract.confirm"]) assert.ok(out.cards.some((x) => x.copy_key === key), `the purchase's own ${key}`);
  assert.deepEqual(out.cards.filter((x) => x.status === "pending" && x.subject_application_id === b.app_id && !x.subject_loan_id && x.kind !== "ChecklistCard").map((x) => `${x.kind} ${x.copy_key}`), [], `no origination ask stays open once boarded (the servicing consents and autopay are the loan's): ${out.cards.filter((x) => x.status === "pending").map((x) => x.copy_key).join(", ")}`);
});
