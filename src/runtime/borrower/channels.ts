/**
 * 32.14 §4 — SMS and voice entry on the same lead (phase 3). The telephony vendor's inbound webhooks
 *
 *   POST /v1/webhooks/sms     { from, to, text|body, message_sid }              (x-fake-telephony: FAKE)
 *   POST /v1/webhooks/voice   { from, to, call_sid, digits?, speech? }          (x-fake-telephony: FAKE)
 *
 * (mounted from ./routes.ts) drive the anonymous minute on a 20.3 lead keyed to the number the message came from:
 *
 *   an unknown number      32.2 `lead.start{channel: sms | voice_inbound}` as borrower-app in global scope (party_id null,
 *                          `prospect.phone` = the number — the key), then `lead.acknowledgeAiDisclosure` → the FIRST outbound
 *                          text (spoken line on voice) is the disclosure (`entry.disclosure.first`; `lead.disclosure.delivered`,
 *                          `consent.granted{kind=ai_disclosure_ack}` logged before anything else — T-03-01), the number given
 *                          in the inquiry is 20.3 rule 10's informational consent (`consent.granted{kind=tcpa_sms|tcpa_voice}`),
 *                          then the goal prompt as a 20.3 script line (`entry.goal.question` with the three options spelled out).
 *   a reply                the S1 steps exactly as the app's chips (goal → contract | occupancy → state → estimate): the text
 *                          is mapped onto the step's option ids / a USPS state / bigint cents and written through the 32.14
 *                          tool `lead.answer` (rule 6 in the domain; L0_FACTS_ONLY / STATE_GATE_FIRST / STEP_ORDER / LEAD_CLOSED
 *                          refusals answer with their copy key); the range through `lead.requestRange`; every outbound prompt
 *                          passes 20.3's utterance classifier first (`explainProgram{op=screen}` — no decline language, no
 *                          rule-6 inquiry). "human" → 20.3 `transfer_to_human`; "are you a real person?" → 20.3's own answer.
 *   identity               the code sent to that number: the same `auth_challenges{kind=otp, channel=sms}` row and the same
 *                          e-delivery send as `POST /v1/borrower/auth/otp {channel: sms}`; the six digits texted back verify
 *                          it (attempt cap, expiry — auth.ts's constants), the party is resolved by the destination, the lead
 *                          is linked (DELTA-11 `lead.linked{party_id}`), an L1 `otp_phone` session opens and `flows.sessionOpened`
 *                          runs on channel `sms` (`voice` for a call) — the 32.3 hook posts the session's disclosure line and
 *                          the 32.14 flow the `entry.resumed` receipt, both on the same lead. Consents are never taken by
 *                          voice (`CONSENT_VOICE_VOID`): a call only speaks the lines and texts the code to the calling number.
 *   after L1               a text from a linked number with a live `otp_phone` session is a borrower message on the party's
 *                          conversation (32.2 `borrowerMessage` on channel sms) and the agent lines on that channel are
 *                          texted back — the SMS thread and the app thread are one conversation.
 *
 * Every outbound text goes through the platform's e-delivery port on channel `sms` (`FakeEdelivery` under INTEGRATIONS=fake —
 * the same rail the OTP route uses): `noticeId` carries the copy key, the text is the copy library's line rendered with the
 * lead's partner (docs/ux/12; the disclosure falls back to 20.3's own notice text). Nothing here computes a regulatory date,
 * writes a lead fact outside the owning tool, or stores the number anywhere but the lead's own `prospect` (rule 10's
 * channel identifier). No session token ever leaves on this channel: the session is the SMS thread's, not a bearer.
 */
import { randomInt, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { fileURLToPath } from "node:url";
import type { Actor } from "../../kernel/events/index.ts";
import type { Runtime } from "../app.ts";
import type { Logger } from "../log.ts";
import { decodeEntityData } from "../../infra/db/entities.ts";
import { normalizePhone } from "../../infra/db/borrower-parties.ts";
import { hashCode, type SessionRow } from "../../infra/db/borrower-sessions.ts";
import type { PgBorrowerUiRepository } from "../../infra/db/borrower-ui.ts";
import { FakeEdelivery, FakeTelephonyWebhooks, type EdeliveryPort, type InboundVoice, type TelephonyWebhookPort } from "../../infra/integrations/delivery.ts";
import { BorrowerAuth, OTP_MAX_ATTEMPTS, OTP_MINUTES, minutesAfter, sessionExpiry, type BorrowerContext } from "./auth.ts";
import type { BorrowerCommands } from "./commands.ts";
import { toBorrowerError, type BorrowerErrorBody } from "./errors.ts";
import { partnerOf } from "./flows/3-entry.ts";
import type { BorrowerFlows, SessionOpened } from "./flows/index.ts";

export interface BorrowerChannelDeps {
  readonly runtime: Runtime; readonly logger: Logger; readonly auth: BorrowerAuth; readonly ui: PgBorrowerUiRepository; readonly flows: BorrowerFlows; readonly commands: BorrowerCommands;
  /** The vendor's inbound webhook adapter (FakeTelephonyWebhooks unless a real one is wired). */
  readonly telephony?: TelephonyWebhookPort | undefined;
  /** Non-production: the FAKE code is echoed in the webhook body (as the OTP route echoes `fake_code`). */
  readonly nonProduction: boolean;
  /** DELTA-15: the Phase I partner party id from configuration. */
  readonly defaultPartnerId?: string | undefined;
  /** DELTA-15: the partner's numeric NMLSR ID for the published range's footer (`BORROWER_DEFAULT_PARTNER_NMLSR_ID` when unset). */
  readonly defaultPartnerNmlsrId?: string | undefined;
}
/** One outbound text: the copy key it renders, the rendered text, the e-delivery message id. */
export interface OutboundLine { readonly copy_key: string; readonly text: string; readonly message_id: string; }
export interface SpokenLine { readonly copy_key: string; readonly text: string; }
export interface SmsWebhookBody { readonly received: true; readonly vendor: string; readonly channel: "sms"; readonly lead_id: string | null; readonly step: string | null; readonly outbound: readonly OutboundLine[]; readonly events: readonly string[]; readonly session_opened: boolean; readonly level: string | null; readonly fake_code?: string; readonly refused?: BorrowerErrorBody; }
export interface VoiceWebhookBody { readonly received: true; readonly vendor: string; readonly channel: "voice"; readonly call_id: string; readonly lead_id: string | null; readonly step: string | null; readonly say: readonly SpokenLine[]; readonly texted: readonly OutboundLine[]; readonly events: readonly string[]; readonly session_opened: boolean; readonly level: string | null; readonly fake_code?: string; readonly refused?: BorrowerErrorBody; }
/** The lead an SMS/voice number keys (the number is the lead's `prospect.phone`; a linked lead names its party). */
export interface NumberLead { readonly lead_id: string; readonly party_id: string | null; readonly status: string; readonly data: Record<string, unknown>; }
export interface BorrowerChannels {
  sms(req: IncomingMessage): Promise<SmsWebhookBody>;
  voice(req: IncomingMessage): Promise<VoiceWebhookBody>;
  /** The live lead keyed to a number (E.164 or any spelling) — the OTP-verify route's number key (32.14 §4: identity by the number the message came from). */
  leadForNumber(number: string): Promise<NumberLead | null>;
  readonly telephony: TelephonyWebhookPort;
}

export const STEPS = ["goal", "contract", "occupancy", "state", "estimate", "range", "identify", "closed"] as const;
export type Step = (typeof STEPS)[number];
const BORROWER_APP: Actor = { kind: "agent", id: "borrower-app" };
const INTAKE: Actor = { kind: "agent", id: "intake" };
const RUN = { runId: "channels:32.14", modelVersion: "borrower channels (deterministic)", promptVersion: "32.14" } as const;
const MAX_BODY = 64 * 1024;
type P = Record<string, unknown>;

// ---------------------------------------------------------------- the copy library (docs/ux/12) rendered for a channel that has no app to render `{{copy:key}}`
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const COPY_FILES = ["docs/ux/12-message-copy-library.md", "spec/sections/32-borrower-experience/copy-library.md"];
interface CopyLine { readonly text: string; readonly options: readonly string[]; }
let copyCache: Map<string, CopyLine> | null = null;
/** The copy library file the API renders from, or null when none is on disk (every `{{copy:key}}` then leaves as the token — the Docker image must carry docs/ux/12). */
export const copyLibraryFile = (): string | null => COPY_FILES.map((f) => `${ROOT}${f}`).find((f) => existsSync(f)) ?? null;
function copyLibrary(): Map<string, CopyLine> {
  if (copyCache) return copyCache;
  const map = new Map<string, CopyLine>();
  const file = copyLibraryFile();
  if (file) for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^- `([a-z0-9_.]+)` — [^—"]*? — "((?:[^"\\]|\\.)*)"(.*)$/.exec(line); if (!m || map.has(m[1]!)) continue;
    const opts = /options ((?:`[^`]+`\s*(?:·\s*)?)+)/.exec(m[3]!); const options = opts ? [...opts[1]!.matchAll(/`([^`]+)`/g)].map((x) => x[1]!) : [];
    map.set(m[1]!, { text: m[2]!, options });
  }
  copyCache = map; return map;
}
/** The copy line rendered with its tokens (`{{partner.legal_name}}` …); markdown emphasis stripped; the `{{copy:key}}` token itself when the library is not on disk. */
export function copyText(key: string, tokens: Readonly<Record<string, string>> = {}): string {
  const line = copyLibrary().get(key); if (!line) return `{{copy:${key}}}`;
  return line.text.replace(/\{\{([a-z0-9_.]+)\}\}/g, (all, k: string) => tokens[k] ?? all).replace(/\*([^*]+)\*/g, "$1");
}
export const copyOptions = (key: string): readonly string[] => copyLibrary().get(key)?.options ?? [];

// ---------------------------------------------------------------- the S1 steps as SMS/voice prompts and reply mappers (the app's chips, spelled out)
interface Option { readonly id: string; readonly match: RegExp; }
const GOAL: readonly Option[] = [{ id: "buy", match: /^(1|buy|purchas|home)/i }, { id: "lower_rate", match: /^(2|lower|rate|payment|refi)/i }, { id: "cash_out", match: /^(3|cash)/i }];
const CONTRACT: readonly Option[] = [{ id: "signed", match: /^(1|yes|y$|signed|contract|have)/i }, { id: "looking", match: /^(2|no|n$|still|looking|not yet)/i }];
const OCCUPANCY: readonly Option[] = [{ id: "primary", match: /^(1|primary|yes|y$|live|my home)/i }, { id: "second_home", match: /^(2|second|vacation)/i }, { id: "investment", match: /^(3|invest|rental|rent)/i }];
const STATE_NAMES: Readonly<Record<string, string>> = { alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE", "district of columbia": "DC", "washington dc": "DC", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY" };
const STATE_CODES: ReadonlySet<string> = new Set(Object.values(STATE_NAMES));
const HUMAN = /\b(human|person|someone|representative|agent|operator)\b/i;
const REAL_PERSON = /\bare you (?:a )?(?:real person|human|a bot|an? ai|a person|a robot)\b|\bis this (?:a )?(?:bot|person|human)\b/i;
const WANTS_CODE = /^(code|sign ?in|log ?in|verify|resend|new code|send (me )?(a |the )?code)\b/i;
const SIX_DIGITS = /^\d{6}$/;
/** The three goal tiles map one-to-one onto `transaction_type` (§1.6). */
export const GOAL_INTENT: Readonly<Record<string, string>> = { buy: "purchase", lower_rate: "limited_cash_out", cash_out: "cash_out" };
const pick = (opts: readonly Option[], text: string): string | null => opts.find((o) => o.match.test(text.trim()))?.id ?? null;
/** Money in a reply → bigint cents, never a float: "$300,000" → 30000000n; "300k" → 30000000n; "1.5m" → 150000000n; "0" / "nothing" → 0n. */
export function parseMoney(text: string): bigint[] {
  const out: bigint[] = []; const t = text.trim();
  if (/^(0|nothing|none|zero|nil|paid off)$/i.test(t)) return [0n];
  for (const m of t.matchAll(/\$?\s*(\d[\d,]*)(?:\.(\d{1,2}))?\s*(k|m)?\b/gi)) {
    const whole = BigInt(m[1]!.replace(/,/g, "")); const frac = BigInt((m[2] ?? "0").padEnd(2, "0")); let cents = whole * 100n + frac;
    if (m[3]?.toLowerCase() === "k") cents *= 1000n; else if (m[3]?.toLowerCase() === "m") cents *= 1_000_000n;
    if (cents === 0n || cents >= 100_000n) out.push(cents);   // under $1,000 is not a home value, a balance, a price or a down payment — except an explicit zero
  }
  return out;
}
export function parseState(text: string): string | null {
  const t = text.trim().toLowerCase().replace(/[.,]/g, ""); if (!t) return null;
  if (t.length === 2 && STATE_CODES.has(t.toUpperCase())) return t.toUpperCase();
  const name = STATE_NAMES[t]; if (name) return name;
  const inText = Object.entries(STATE_NAMES).find(([n]) => t.includes(n))?.[1]; if (inText) return inText;
  const code = /\b([a-z]{2})\b/i.exec(t)?.[1]?.toUpperCase(); return code && STATE_CODES.has(code) ? code : null;
}
/** A reply mapped onto the step's lead fact — the same values the app's chips post (PHASE2 lead API contract). */
export function mapReply(step: Step, text: string, intent: string): Record<string, unknown> | null {
  switch (step) {
    case "goal": { const id = pick(GOAL, text); return id ? { goal: id } : null; }
    case "contract": { const id = pick(CONTRACT, text); return id ? { contract: id } : null; }
    case "occupancy": { const id = pick(OCCUPANCY, text); return id ? { occupancy: id } : null; }
    case "state": { const s = parseState(text); return s ? { state: s } : null; }
    case "estimate": { const m = parseMoney(text); if (m.length < 2) return null; return intent === "purchase" ? { estimate: { price_range_cents: m[0]!.toString(), down_payment_cents: m[1]!.toString() } } : { estimate: { value_estimate_cents: m[0]!.toString(), stated_existing_balance_cents: m[1]!.toString() } }; }
    default: return null;
  }
}
const intentOf = (lead: P): string => String(lead["transaction_intent"] ?? "undecided");
const isPurchase = (lead: P): boolean => intentOf(lead) === "purchase";
const isRefi = (lead: P): boolean => ["refinance", "limited_cash_out", "cash_out"].includes(intentOf(lead));
const present = (v: unknown): boolean => v !== undefined && v !== null && v !== "";
/** The next step, measured from the lead's own facts (S1's fixed order; nothing remembered outside the lead). */
export function stepOf(lead: P, rangeShown: boolean): Step {
  const status = String(lead["status"] ?? "");
  if (status === "closed_lost" || status === "expired" || status === "converted") return "closed";
  if (!isPurchase(lead) && !isRefi(lead)) return "goal";
  if (isPurchase(lead) && !present(lead["contract_status"])) return "contract";
  if (isRefi(lead) && !present(lead["occupancy"])) return "occupancy";
  if (!present(lead["consumer_state"])) return "state";
  if (isPurchase(lead) ? !present(lead["price_range_cents"]) : !present(lead["value_estimate_cents"])) return "estimate";
  if (!rangeShown) return "range";
  return "identify";
}
/** The prompt for a step: the copy key and its options (`options` from the copy line, spelled out as "1) … 2) … 3) …"). */
function promptFor(step: Step, lead: P): { copy_key: string; extra: string[] }[] {
  switch (step) {
    case "goal": return [{ copy_key: "entry.goal.question", extra: [] }];
    case "contract": return [{ copy_key: "entry.buy.contract_question", extra: [] }];
    case "occupancy": return [{ copy_key: "entry.occupancy.question", extra: [] }];
    case "state": return [{ copy_key: "entry.state.question", extra: [] }];
    case "estimate": return isPurchase(lead) ? [{ copy_key: "entry.estimate.price_range", extra: [] }, { copy_key: "entry.estimate.down_payment", extra: [] }] : [{ copy_key: "entry.estimate.value", extra: [] }, { copy_key: "entry.estimate.balance", extra: [] }];
    default: return [];
  }
}
const spellOptions = (key: string): string => { const o = copyOptions(key); return o.length ? " " + o.map((label, k) => `${k + 1}) ${label}`).join(" ") : ""; };

// ---------------------------------------------------------------- the module
export function createBorrowerChannels(deps: BorrowerChannelDeps): BorrowerChannels {
  const { runtime, logger, auth, ui, flows, commands } = deps;
  const telephony: TelephonyWebhookPort = deps.telephony ?? new FakeTelephonyWebhooks();
  const vendor = telephony instanceof FakeTelephonyWebhooks ? "FAKE" : telephony.vendorName;
  const edelivery: EdeliveryPort | undefined = runtime.ports.edelivery;
  const deliveryIsFake = (): boolean => !edelivery || edelivery instanceof FakeEdelivery;
  const now = (): string => runtime.clock.now();
  const exec = (process: string, name: string, actor: Actor, input: P) => runtime.execute({ process, name, loanId: "", actor, input, run: { ...RUN } });
  const onBus = (process: string, name: string): boolean => runtime.tool(process, name) !== undefined;

  async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = []; let size = 0;
    for await (const c of req) { size += (c as Buffer).length; if (size > MAX_BODY) throw new RangeError(`webhook body over ${MAX_BODY} bytes`); chunks.push(c as Buffer); }
    return Buffer.concat(chunks).toString("utf8");
  }
  const header = (req: IncomingMessage, name: string): string | undefined => { const h = req.headers[name]; return Array.isArray(h) ? h[0] : h; };

  // ---- the lead keyed to a number
  async function leadForNumber(number: string): Promise<NumberLead | null> {
    const phone = normalizePhone(number); if (!phone) return null;
    const rows = await runtime.db.query<{ id: string; data: unknown; updated_at: string }>(`SELECT DISTINCT ON (id) id, data, updated_at FROM entity_records WHERE kind = 'leads' AND loan_id IS NULL AND application_id IS NULL AND data->'prospect'->>'phone' = $1 ORDER BY id, version DESC`, [phone]);
    const live = rows.map((r) => ({ lead_id: r.id, data: decodeEntityData(r.data), updated_at: r.updated_at })).filter((r) => !["expired", "closed_lost", "converted"].includes(String(r.data["status"]))).sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
    const l = live[0]; return l ? { lead_id: l.lead_id, party_id: (l.data["party_id"] as string | null) ?? null, status: String(l.data["status"]), data: l.data } : null;
  }
  const reloadLead = async (leadId: string): Promise<P> => (await runtime.entities.current("leads", leadId))?.data ?? {};
  const rangeShown = async (leadId: string): Promise<boolean> => (await runtime.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM loan_events WHERE type = 'lead.range.shown' AND payload->>'lead_id' = $1`, [leadId]))[0]?.n !== "0";
  const interactionOf = (lead: P, channel: "sms" | "voice_inbound", sid: string | null): string | null => { const all = ((lead["interactions"] as P[] | undefined) ?? []); const own = sid ? all.find((i) => i["interaction_id"] === sid) : undefined; return String((own ?? all.filter((i) => i["channel"] === channel).at(-1))?.["interaction_id"] ?? "") || null; };
  /** The partner's NMLSR ID for the §1026.24 footer: configured (DELTA-15) when set, else the global `partners/<id>` row the demo seed and 20.3 keep, else "" (the 20.2 checklist then refuses the range). */
  const nmlsrOf = async (lead: P): Promise<string> => {
    const configured = (deps.defaultPartnerNmlsrId ?? process.env["BORROWER_DEFAULT_PARTNER_NMLSR_ID"] ?? "").trim();
    if (configured) return configured;
    const id = String(lead["partner_id"] ?? ""); const row = id ? await deps.runtime.entities.current("partners", id) : undefined;
    return String(row?.data["nmlsr_id"] ?? "").trim();
  };
  const partnerTokens = (lead: P, nmlsr = ""): Record<string, string> => ({ "partner.legal_name": String(lead["partner_name"] ?? ""), "partner.nmlsr_id": nmlsr });

  // ---- one webhook turn: what goes out (texted through e-delivery; spoken on a call), what happened
  interface Turn { readonly channel: "sms" | "voice"; readonly number: string; readonly sid: string; readonly input: string | null; readonly at: string; }
  class Out {
    readonly texted: OutboundLine[] = []; readonly spoken: SpokenLine[] = []; readonly events: string[] = []; lead_id: string | null = null; step: Step | null = null; session_opened = false; level: string | null = null; fake_code: string | undefined; refused: BorrowerErrorBody | undefined;
    private n = 0; private consentId = "policy:ai_interaction_disclosure";
    readonly t: Turn;
    constructor(t: Turn) { this.t = t; }
    withConsent(id: string): void { this.consentId = id; }
    /** A line to the number: texted on SMS; spoken on a call. */
    async line(copy_key: string, text: string): Promise<void> { if (this.t.channel === "voice") { this.spoken.push({ copy_key, text }); return; } await this.text(copy_key, text); }
    /** A text to the number on either channel (the code on a call is texted, never spoken). */
    async text(copy_key: string, text: string, consentId = this.consentId): Promise<void> {
      const message_id = `${this.t.channel}:${this.t.sid}:${this.n++}`;   // idempotent on the vendor's retry of the same inbound post
      if (edelivery) await edelivery.send({ messageId: message_id, noticeId: copy_key, channel: "sms", to: this.t.number, subject: text, consentId }, this.t.at);
      this.texted.push({ copy_key, text, message_id });
    }
    record(events: readonly { type: string }[]): void { for (const e of events) this.events.push(e.type); }
  }

  /** A prompt through 20.3's classifier (rule 3: no decline language; rule 6: no prohibited inquiry) before it goes out. */
  async function prompt(lead: P, interaction_id: string | null, out: Out, step: Step): Promise<void> {
    out.step = step;
    for (const p of promptFor(step, lead)) {
      const draft = copyText(p.copy_key, partnerTokens(lead)) + spellOptions(p.copy_key) + (p.extra.length ? " " + p.extra.join(" ") : "");
      let text = draft;
      if (interaction_id) { const r = await exec("20.3", "explainProgram", INTAKE, { op: "screen", lead_id: String(lead["lead_id"]), interaction_id, draft }); out.record(r.events); text = String((r.output as P)["delivered_text"] ?? draft); }
      await out.line(p.copy_key, text);
    }
  }
  /** The identity code to the number: the same row and the same send as POST /v1/borrower/auth/otp {channel: sms}. */
  async function sendCode(out: Out): Promise<void> {
    const { number, at } = out.t; const code = randomInt(0, 1_000_000).toString().padStart(6, "0"); const expiresAt = minutesAfter(at, OTP_MINUTES);
    const ch = await auth.sessions.createChallenge({ kind: "otp", channel: "sms", destination: number, code, expires_at: expiresAt, delivery: deliveryIsFake() ? "FAKE" : "sms" });
    if (edelivery) await edelivery.send({ messageId: `otp:${ch.challenge_id}`, noticeId: `otp:${ch.challenge_id}`, channel: "sms", to: number, subject: "Your Supermortgage sign-in code", consentId: "policy:authentication_otp" }, at);
    out.texted.push({ copy_key: "auth.code.sent", text: "", message_id: `otp:${ch.challenge_id}` });
    logger.info("borrower.otp.requested", { challenge_id: ch.challenge_id, channel: "sms", delivery: ch.delivery, vendor: deliveryIsFake() ? "FAKE" : "e-delivery", via: out.t.channel === "voice" ? "voice_inbound" : "sms_inbound" });
    if (deliveryIsFake() && deps.nonProduction) out.fake_code = code;
    await out.line(out.t.channel === "voice" ? "entry.voice.code_texted" : "auth.code.enter", copyText(out.t.channel === "voice" ? "entry.voice.code_texted" : "auth.code.enter", { destination: "this number" }));
    out.step = "identify";
  }
  async function pendingChallenge(number: string, at: string): Promise<{ challenge_id: string; code_hash: string | null; expires_at: string } | undefined> {
    return (await runtime.db.query<{ challenge_id: string; code_hash: string | null; expires_at: string }>(`SELECT challenge_id, code_hash, expires_at FROM auth_challenges WHERE kind = 'otp' AND channel = 'sms' AND destination = $1 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1`, [number]))[0];
  }
  /** DELTA-11 `lead.linked{party_id}` on the lead through 20.3's own op when it is on the bus (builder C); otherwise logged and left to the session hook. */
  async function linkLead(leadId: string, partyId: string, out: Out): Promise<boolean> {
    const link = LEAD_LINK.find((l) => onBus(l.process, l.name));
    if (!link) { logger.info("borrower.channels.link.unavailable", { lead_id: leadId, party_id: partyId }); return false; }
    try { const r = await exec(link.process, link.name, link.actor, link.input(leadId, partyId)); out.record(r.events); return true; }
    catch (e) { logger.error("borrower.channels.link.failed", { lead_id: leadId, error: e instanceof Error ? e.message : String(e) }); return false; }
  }
  /** The six digits texted back: verify → the party by the destination → the lead linked → an L1 otp_phone session → the session hook on this channel. */
  async function verify(lead: NumberLead, code: string, out: Out): Promise<void> {
    const { number, at, channel } = out.t; const ch = await pendingChallenge(number, at);
    if (!ch) { await sendCode(out); return; }
    if (Date.parse(ch.expires_at) <= Date.parse(at)) { await out.line("auth.code_expired", copyText("auth.code_expired")); await sendCode(out); return; }
    const attempts = await auth.sessions.bumpAttempts(ch.challenge_id);
    if (attempts > OTP_MAX_ATTEMPTS) { await out.line("auth.code_locked", copyText("auth.code_locked")); out.step = "identify"; return; }
    if (ch.code_hash !== hashCode(ch.challenge_id, code)) { await out.line("auth.code_wrong", copyText("auth.code_wrong")); out.step = "identify"; return; }
    await auth.sessions.consume(ch.challenge_id, at);
    const resolved = await auth.parties.resolveOrCreateByDestination("sms", number);
    await auth.sessions.setChallengeParty(ch.challenge_id, resolved.party.id);
    const linked = await linkLead(lead.lead_id, resolved.party.id, out);
    const opened = await auth.openSession({ party_id: resolved.party.id, auth_method: "otp_phone", now: at, otp: true, ip: null, user_agent: `telephony:${vendor}:${channel}` });
    await ui.conversationFor(resolved.party.id);
    const session = { party_id: resolved.party.id, session_id: opened.session.session_id, channel, auth_method: opened.session.auth_method, at, lead_id: lead.lead_id } as SessionOpened;   // `lead_id` (DELTA-11) rides on the SessionOpened for the 32.14 flow
    await flows.sessionOpened(session);
    out.session_opened = true; out.level = opened.session.level; out.step = null;
    logger.info("borrower.session.opened", { session_id: opened.session.session_id, level: opened.session.level, auth_method: "otp_phone", channel, lead_id: lead.lead_id, lead_linked: linked, party_created: resolved.created, vendor });
    await forwardThread(resolved.party.id, at, out);
  }
  /** The conversation's agent lines on this channel since `at`, texted to the number (the SMS thread is the conversation; idempotent by message id). */
  async function forwardThread(partyId: string, since: string, out: Out): Promise<void> {
    if (out.t.channel !== "sms") return;
    const conv = await ui.conversationFor(partyId);
    const lines = (await ui.messagesAfter(conv.conversation_id, null, 500)).filter((m) => m.channel === "sms" && m.sender !== "borrower" && m.at >= since && m.body_text);
    for (const m of lines) {
      const key = /^\{\{copy:([a-z0-9_.]+)\}\}/.exec(m.body_text ?? "")?.[1] ?? "thread.line";
      const text = (m.body_text ?? "").replace(/\{\{copy:([a-z0-9_.]+)\}\}/g, (_all, k: string) => copyText(k));
      if (edelivery) await edelivery.send({ messageId: `msg:${m.message_id}`, noticeId: key, channel: "sms", to: out.t.number, subject: text, consentId: "policy:session_thread" }, out.t.at);
      out.texted.push({ copy_key: key, text, message_id: `msg:${m.message_id}` });
    }
  }
  /** A linked number with a live otp_phone session: the text is a borrower message on the party's conversation (32.2 borrowerMessage). */
  async function liveContext(partyId: string, at: string): Promise<BorrowerContext | null> {
    const session = (await runtime.db.query<SessionRow & Record<string, unknown>>(`SELECT session_id, party_id, level, auth_method, created_at, last_seen_at, last_l1_at, expires_at, revoked_at, passkey_id, ip, user_agent FROM sessions WHERE party_id = $1 AND auth_method = 'otp_phone' AND revoked_at IS NULL AND expires_at > $2 ORDER BY created_at DESC LIMIT 1`, [partyId, at]))[0];
    if (!session) return null;
    const [party, subjects] = await Promise.all([auth.parties.get(partyId), auth.parties.subjectsOf(partyId)]);
    if (!party) return null;
    const expiresAt = sessionExpiry(session.auth_method, subjects, at); await auth.sessions.touch(session.session_id, at, expiresAt);
    return { session: { ...session, last_seen_at: at, expires_at: expiresAt }, party, subjects, token: "", ip: null, userAgent: `telephony:${vendor}` };
  }

  /** An unknown number: the lead, the disclosure first, rule 10's informational consent, the goal prompt. */
  async function startLead(out: Out): Promise<NumberLead> {
    const { channel, number, sid, at } = out.t;
    const partner = await partnerOf({ runtime, ui, logger, defaultPartnerId: deps.defaultPartnerId });
    if (!partner) throw new Error("no partner: BORROWER_DEFAULT_PARTNER_ID is unset and no servicer party exists (32.14 DELTA-15)");
    const lead_id = randomUUID(); const interaction_id = channel === "sms" ? `sms-${lead_id.slice(0, 8)}` : sid; const ch = channel === "sms" ? "sms" : "voice_inbound";
    const started = await exec("32.2", "lead.start", BORROWER_APP, { partner_id: partner.id, partner_name: partner.legal_name, lead_id, interaction_id, channel: ch, lead_channel: "organic", party_id: null, time_zone: "America/New_York", prospect: { phone: number }, utm: { channel: ch, vendor } });
    out.record(started.events); out.lead_id = lead_id;
    // E2 / T-03-01: the disclosure is delivered and logged before anything else — the first outbound text (spoken on a call)
    const ack = await exec("32.2", "lead.acknowledgeAiDisclosure", BORROWER_APP, { lead_id, interaction_id, notice_id: `n-disc-${interaction_id}`, channel: ch });
    out.record(ack.events);
    const lead = await reloadLead(lead_id);
    const text = copyLibrary().has("entry.disclosure.first") ? copyText("entry.disclosure.first", partnerTokens(lead)) : String((ack.output as P)["text"] ?? "");
    await out.line("entry.disclosure.first", text);
    // rule 10: the number the inquiry came from is prior express consent for informational contact about this inquiry (never marketing)
    const consent = await exec("20.3", "captureConsent", INTAKE, { lead_id, kind: channel === "sms" ? "tcpa_sms" : "tcpa_voice", consent_id: `tcpa-${interaction_id}`, number });
    out.record(consent.events); out.withConsent(String((consent.output as P)["consent_id"] ?? `tcpa-${interaction_id}`));
    if (channel === "voice") await out.line("entry.voice.started", copyText("entry.voice.started"));
    await prompt(lead, interaction_id, out, stepOf(lead, false));
    logger.info("borrower.channels.lead.started", { lead_id, channel: ch, vendor, partner_id: partner.id });
    return { lead_id, party_id: null, status: String(lead["status"] ?? "disclosed"), data: lead };
  }
  /** A new call on an existing lead: the disclosure is re-delivered on the new interaction (channel change), then the current prompt. */
  async function resumeOnCall(lead: NumberLead, out: Out): Promise<void> {
    const { sid, at } = out.t; const lead_id = lead.lead_id;
    const started = await exec("20.3", "deliverDisclosure", INTAKE, { op: "start", lead_id, interaction_id: sid, channel: "voice_inbound", ai: true, at }); out.record(started.events);
    const ack = await exec("32.2", "lead.acknowledgeAiDisclosure", BORROWER_APP, { lead_id, interaction_id: sid, notice_id: `n-disc-${sid}`, channel: "voice_inbound" }); out.record(ack.events);
    const data = await reloadLead(lead_id);
    await out.line("entry.disclosure.first", copyLibrary().has("entry.disclosure.first") ? copyText("entry.disclosure.first", partnerTokens(data)) : String((ack.output as P)["text"] ?? ""));
    await out.line("entry.voice.started", copyText("entry.voice.started"));
    await prompt(data, sid, out, stepOf(data, await rangeShown(lead_id)));
  }
  /** The reply on a step: the lead fact through `lead.answer`, then the next prompt; the range and the code when the chips are done. */
  async function reply(lead: NumberLead, out: Out): Promise<void> {
    const text = (out.t.input ?? "").trim(); const lead_id = lead.lead_id; let data = await reloadLead(lead_id);
    const interaction_id = interactionOf(data, out.t.channel === "sms" ? "sms" : "voice_inbound", out.t.channel === "voice" ? out.t.sid : null);
    if (REAL_PERSON.test(text) && interaction_id) { const r = await exec("20.3", "deliverDisclosure", INTAKE, { op: "are_you_human", lead_id, interaction_id }); out.record(r.events); await out.line("entry.disclosure.real_person", String((r.output as P)["answer"] ?? copyText("entry.disclosure.real_person", partnerTokens(data)))); out.step = stepOf(data, await rangeShown(lead_id)); return; }
    if (HUMAN.test(text) && interaction_id) { const r = await exec("20.3", "deliverDisclosure", INTAKE, { op: "transfer_to_human", lead_id, interaction_id, reason: "consumer_request" }); out.record(r.events); await out.line("thread.human_requested", copyText("thread.human_requested")); out.step = stepOf(data, await rangeShown(lead_id)); return; }
    if (SIX_DIGITS.test(text) && (await pendingChallenge(out.t.number, out.t.at))) { await verify(lead, text, out); return; }
    if (WANTS_CODE.test(text)) { await sendCode(out); return; }
    let step = stepOf(data, await rangeShown(lead_id));
    if (step === "closed") { await out.line("lead.state_closed", copyText("lead.state_closed", { state: String(data["consumer_state"] ?? "") })); out.step = step; return; }
    if (step !== "range" && step !== "identify") {
      const value = mapReply(step, text, intentOf(data));
      if (!value) { await prompt(data, interaction_id, out, step); return; }   // not one of the options: the same prompt again
      if (!onBus("32.14", "lead.answer")) { out.refused = { code: "NOT_WIRED", copy_key: "error.generic" }; logger.error("borrower.channels.lead_answer.unavailable", { lead_id, step }); await out.line("error.generic", copyText("error.generic")); out.step = step; return; }
      try {
        const r = await exec("32.14", "lead.answer", BORROWER_APP, { lead_id, step, value: value[step], ...(interaction_id ? { interaction_id } : {}), channel: out.t.channel === "sms" ? "sms" : "voice_inbound" });
        out.record(r.events);
        const o = r.output as P;
        for (const l of ((o["lines"] as P[] | undefined) ?? [])) { const key = String(l["copy_key"] ?? ""); if (key) await out.line(key, copyText(key, { ...partnerTokens(data), ...(l["copy_tokens"] as Record<string, string> | undefined ?? {}) })); }
        const closed = o["closed"] as P | undefined;
        data = await reloadLead(lead_id);
        if (closed) { const key = String(closed["copy_key"] ?? "lead.state_closed"); if (!((o["lines"] as P[] | undefined) ?? []).some((l) => l["copy_key"] === key)) await out.line(key, copyText(key, { state: String(data["consumer_state"] ?? "") })); out.step = "closed"; return; }
      } catch (e) {
        const be = toBorrowerError(e); out.refused = be.body(); logger.info("borrower.channels.lead_answer.refused", { lead_id, step, code: be.code, gate: be.gate ?? null });
        await out.line(be.body().copy_key, copyText(be.body().copy_key, partnerTokens(data))); out.step = step; return;
      }
      step = stepOf(data, await rangeShown(lead_id));
    }
    if (step === "range") {
      if (onBus("32.14", "lead.requestRange")) {
        try {
          // the partner's numeric NMLSR ID for the 1026.24 footer — from configuration or the partner row, as the lead route names it (DELTA-15); without it the 20.2 checklist refuses the range
          const nmlsr = await nmlsrOf(data);
          const r = await exec("32.14", "lead.requestRange", BORROWER_APP, { lead_id, ...(interaction_id ? { interaction_id } : {}), ...(nmlsr ? { partner_nmlsr_id: nmlsr } : {}) }); out.record(r.events); const o = r.output as P; const range = o["range"] as P | null | undefined;
          if (range && typeof range["text"] === "string") { await out.line("entry.range.card", range["text"]); await out.line("entry.range.promise", copyText("entry.range.promise")); await out.line("entry.range.disclaimer", copyText("entry.range.disclaimer", partnerTokens(data, nmlsr))); }
        } catch (e) { const be = toBorrowerError(e); logger.info("borrower.channels.range.refused", { lead_id, code: be.code, gate: be.gate ?? null }); if (be.code === "STATE_GATE_FIRST" || be.code === "LEAD_CLOSED") { out.refused = be.body(); await out.line(be.body().copy_key, copyText(be.body().copy_key, partnerTokens(data))); out.step = "closed"; return; } }
      } else logger.info("borrower.channels.range.unavailable", { lead_id });
      step = "identify";
    }
    if (step === "identify") { if (await pendingChallenge(out.t.number, out.t.at)) { await out.line("auth.code.enter", copyText("auth.code.enter", { destination: "this number" })); out.step = "identify"; } else await sendCode(out); return; }
    await prompt(data, interaction_id, out, step);
  }

  async function turn(t: Turn): Promise<Out> {
    const out = new Out(t);
    let lead = await leadForNumber(t.number);
    // a linked number with a live session on this channel: the borrower's message on their own conversation
    if (lead?.party_id && t.input) {
      const ctx = await liveContext(lead.party_id, t.at);
      if (ctx) {
        const r = await commands.borrowerMessage(ctx, { text: t.input, channel: t.channel }, t.at); out.lead_id = lead.lead_id; out.level = ctx.session.level;
        const key = r.reply.copy_key; const text = (r.reply.body_text ?? `{{copy:${key}}}`).replace(/\{\{copy:([a-z0-9_.]+)\}\}/g, (_all, k: string) => copyText(k, partnerTokens(lead!.data)));
        if (t.channel === "voice") out.spoken.push({ copy_key: key, text }); else await out.text(key, text, "policy:session_thread");
        logger.info("borrower.channels.message", { lead_id: lead.lead_id, party_id: lead.party_id, channel: t.channel, routed_to: r.routed_to, command_executed: r.command_executed, reply_copy_key: key, vendor });
        return out;
      }
    }
    if (!lead) lead = await startLead(out);
    else if (t.channel === "voice" && !t.input) await resumeOnCall(lead, out);
    else if (t.input) { out.lead_id = lead.lead_id; await reply(lead, out); }
    else { out.lead_id = lead.lead_id; const data = await reloadLead(lead.lead_id); await prompt(data, interactionOf(data, "sms", null), out, stepOf(data, await rangeShown(lead.lead_id))); }
    return out;
  }

  const body = (out: Out) => ({ lead_id: out.lead_id, step: out.step, events: out.events, session_opened: out.session_opened, level: out.level, ...(out.fake_code ? { fake_code: out.fake_code } : {}), ...(out.refused ? { refused: out.refused } : {}) });
  async function sms(req: IncomingMessage): Promise<SmsWebhookBody> {
    const at = now(); const inbound = telephony.parseSms(await readBody(req), header(req, "x-fake-telephony") ?? header(req, "x-telephony-signature"));
    const number = normalizePhone(inbound.from); if (!/^\+\d{10,15}$/.test(number)) throw new RangeError("from is not a phone number");
    const out = await turn({ channel: "sms", number, sid: inbound.message_sid, input: inbound.text || null, at });
    logger.info("borrower.channels.sms", { vendor, message_sid: inbound.message_sid, lead_id: out.lead_id, step: out.step, outbound: out.texted.map((l) => l.copy_key), events: out.events, session_opened: out.session_opened });
    return { received: true, vendor, channel: "sms", outbound: out.texted, ...body(out) };
  }
  async function voice(req: IncomingMessage): Promise<VoiceWebhookBody> {
    const at = now(); const inbound: InboundVoice = telephony.parseVoice(await readBody(req), header(req, "x-fake-telephony") ?? header(req, "x-telephony-signature"));
    const number = normalizePhone(inbound.from); if (!/^\+\d{10,15}$/.test(number)) throw new RangeError("from is not a phone number");
    const out = await turn({ channel: "voice", number, sid: inbound.call_sid, input: inbound.digits ?? inbound.speech, at });
    logger.info("borrower.channels.voice", { vendor, call_sid: inbound.call_sid, lead_id: out.lead_id, step: out.step, say: out.spoken.map((l) => l.copy_key), texted: out.texted.map((l) => l.copy_key), events: out.events, session_opened: out.session_opened });
    return { received: true, vendor, channel: "voice", call_id: inbound.call_sid, say: out.spoken, texted: out.texted, ...body(out) };
  }
  return { sms, voice, leadForNumber, telephony };
}

/**
 * DELTA-11 `lead.linked{party_id}` — 20.3's own op (`explainProgram{op: link_party}` → linkParty: the lead is linked, never
 * copied; a lead already linked to another party is never re-pointed), executed as the intake agent in the lead's global
 * scope. Resolved by name at runtime; were it ever absent the link is skipped (logged) and the session hook opens the
 * party's own lead.
 */
const LEAD_LINK: readonly { process: string; name: string; actor: Actor; input: (lead_id: string, party_id: string) => P }[] = [
  { process: "20.3", name: "explainProgram", actor: INTAKE, input: (lead_id, party_id) => ({ op: "link_party", lead_id, party_id, method: "otp_sms" }) },
];
