/**
 * The borrower flows (spec section 32, one file per process 32.3 … 32.13): flow-specific server logic that turns the
 * owning processes' events into the cards, StatusCards and thread lines the borrower sees. The shell renders whatever
 * cards the API creates; a flow makes the API create the right card at the right event, through the 32.1 card tools
 * of the thread-owning agent (`send_card` / `resolve_card_by_evidence`), never by transitioning an owning process's state.
 *
 *   BorrowerFlows   the registry: subscribes to the runtime's post-commit hook (`Runtime.onCommitted`, the same feed the
 *                   SSE stream reads), hands each flow the events it reacts to, serialized in commit order (a flow's own
 *                   commands commit and re-enter the queue like any other unit of work), and exposes `tick(now)` — the
 *                   scheduled pass (POST /v1/sweep) a flow uses for the owning processes' daily sweeps.
 *   FLOWS           one entry per 32.x process — sibling processes register additively here.
 *
 * `settle()` resolves once every queued reaction has run: tests drive the journey, settle, then read the record/thread.
 */
import type { DomainEvent } from "../../../kernel/events/index.ts";
import type { Runtime } from "../../app.ts";
import type { Logger } from "../../log.ts";
import type { PgBorrowerUiRepository } from "../../../infra/db/borrower-ui.ts";
import type { BlobStorePort } from "../vendors/fake-blob-store.ts";
import { FLOW_3_ENTRY } from "./3-entry.ts";
import { FLOW_4_DISCLOSURES } from "./4-disclosures.ts";
import { FLOW_5_VERIFICATION } from "./5-verification.ts";
import { FLOW_6_DECISION_PROPERTY } from "./6-decision-property.ts";
import { FLOW_7_CLOSING } from "./7-closing.ts";
import { FLOW_8_SERVICING } from "./8-servicing-payments.ts";
import { FLOW_9_SERVICING_REQUESTS } from "./9-servicing-requests.ts";
import { FLOW_10_HARDSHIP } from "./10-hardship.ts";
import { FLOW_11_RATE_WATCH } from "./11-rate-watch.ts";
import { FLOW_12_EXITS } from "./12-exits.ts";
import { FLOW_13_CROSS_CUTTING, SESSION_TRIGGER, MESSAGE_TRIGGER, TICK_TRIGGER, COMMAND_TRIGGERS } from "./13-cross-cutting.ts";
import { FLOW_14_ENTRY_SIGN_IN } from "./14-entry-sign-in.ts";
import { FLOW_14_ENTRY_LEAD } from "./14-entry-lead.ts";
import { FLOW_14_PREQUAL } from "./14-prequal.ts";

export interface FlowDeps { readonly runtime: Runtime; readonly ui: PgBorrowerUiRepository; readonly logger?: Logger | undefined; /** the uploaded bytes (32.3 C1: the FAKE contract extraction reads them) */ readonly blobs?: BlobStorePort | undefined; /** 32.14 DELTA-15: the Phase I partner party id from configuration (`BORROWER_DEFAULT_PARTNER_ID`); unset → the newest servicer party that is not Supermortgage itself (partner.ts) */ readonly defaultPartnerId?: string | undefined }
/** A borrower session opened on a channel (32.3 E1–E2: the automation disclosure is the first assistant content of every session, every channel). */
export interface SessionOpened { readonly party_id: string; readonly session_id: string; readonly channel: "app" | "sms" | "voice"; readonly auth_method: string; readonly at: string; /** 32.14 DELTA-11: the lead the `sm_borrower_lead` cookie named at verify, linked to the party before the hook ran (`lead.linked{party_id}`); the 32.14 flow creates the application from it */ readonly lead_id?: string | null }
/** A borrower message a flow may answer before the generic placeholder (32.3 T2 "are you a real person?", P9 "send me the listing"). */
export interface InboundMessage { readonly party_id: string; readonly session_id: string; readonly conversation_id: string; readonly message_id: string; readonly text: string; readonly channel: "app" | "sms" | "email" | "voice"; readonly subject: { application_id: string | null; loan_id: string | null } | null; /** the subject the borrower named in the request body, even when it is not one of the party's own (32.9 P4: a potential successor names the loan) */ readonly claimed_subject?: { application_id?: string | null; loan_id?: string | null } | null; readonly at: string }
export interface FlowReply { readonly copy_key: string; readonly body_text?: string; readonly command?: string | null; readonly card_instance_id?: string | null }
/**
 * DELTA-26 / 32.16 T28: what raised a card. The flows send every card through 32.1's `send_card` from inside a reaction
 * (`onEvents`), a session hook, a borrower message or the scheduled pass, so the `card.sent` commit lands while that
 * context is active on the registry — the registry records it per card_instance_id (`triggerOf`). A `card.sent` that
 * commits with no context active was sent inside a command's own unit of work (`triggers` = the owning events committed
 * with it) or by nobody the flows know of (`triggers` empty — the assistant's own decision, §2.3's forbidden case).
 */
export interface CardTrigger { readonly source: "event" | "session" | "message" | "tick" | "command"; readonly flow: string | null; readonly triggers: readonly string[] }
const CARD_TRIGGER_CAP = 5000;
const BUS_OR_THREAD_EVENT = /^(command|card|message)\./;

export interface BorrowerFlow {
  /** The 32.x process id, e.g. "32.4". */
  readonly id: string;
  /** Which event types this flow reacts to (the 32.2 §3 subscriptions of its file). */
  reacts(type: string): boolean;
  /** React to the events one unit of work committed (all of one application's events arrive in order). */
  onEvents(deps: FlowDeps, events: readonly DomainEvent[]): Promise<void>;
  /** The scheduled pass, when the flow has one (the owning processes' daily sweeps). */
  tick?(deps: FlowDeps, nowIso: string): Promise<void>;
  /** A session opened (32.3 E1/E2): runs before the sign-in response returns, so the disclosure precedes any other assistant content. */
  onSessionOpened?(deps: FlowDeps, session: SessionOpened): Promise<void>;
  /** A borrower message the flow answers itself (returns null to leave it to the generic reply). */
  onMessage?(deps: FlowDeps, message: InboundMessage): Promise<FlowReply | null>;
}

/** Every registered flow — sibling processes append theirs (additive). */
// 32.14's lead flow sits right after 3-entry: the session hook order is the spec's S3 (i) → (ii) — 3-entry's disclosure line and the lead's `party.authenticate` first, then the application from the lead and the `entry.resumed` receipt (T7: "the session's disclosure line then entry.resumed")
// 32.14's S4 flow (DELTA-13) follows the lead flow: its identity ask opens once 3-entry's session hook and the application from the lead have run, and its reactions to the 20.3 soft-pull / review events run after 3-entry's R9 cards for the same commit
export const FLOWS: BorrowerFlow[] = [FLOW_3_ENTRY, FLOW_14_ENTRY_LEAD, FLOW_14_PREQUAL, FLOW_4_DISCLOSURES, FLOW_6_DECISION_PROPERTY, FLOW_5_VERIFICATION, FLOW_7_CLOSING, FLOW_8_SERVICING, FLOW_9_SERVICING_REQUESTS, FLOW_10_HARDSHIP, FLOW_11_RATE_WATCH, FLOW_12_EXITS, FLOW_13_CROSS_CUTTING, FLOW_14_ENTRY_SIGN_IN];

export class BorrowerFlows {
  private readonly deps: FlowDeps;
  private readonly flows: readonly BorrowerFlow[];
  private queue: Promise<void> = Promise.resolve();
  private inflight = 0;
  private stopFn: (() => void) | null = null;
  /** The contexts a card.sent committing now is attributed to (a queued reaction and a session hook can overlap; a test settles between them). */
  private active: CardTrigger[] = [];
  private readonly cardTriggers = new Map<string, readonly CardTrigger[]>();
  constructor(deps: FlowDeps, flows: readonly BorrowerFlow[] = FLOWS) { this.deps = deps; this.flows = flows; }

  /** Subscribe to the runtime's post-commit hook; returns the unsubscribe. */
  start(): () => void {
    if (this.stopFn) return this.stopFn;
    const off = this.deps.runtime.onCommitted((events) => this.enqueue(events));
    this.stopFn = () => { off(); this.stopFn = null; };
    return this.stopFn;
  }
  /** Queue one commit's events behind whatever is already running (commit order is reaction order). */
  enqueue(events: readonly DomainEvent[]): void {
    this.attribute(events);
    const relevant = events.filter((e) => this.flows.some((f) => f.reacts(e.type)));
    if (!relevant.length) return;
    this.inflight += 1;
    this.queue = this.queue.then(() => this.run(relevant)).catch((e: unknown) => { this.deps.logger?.error("borrower.flows.failed", { error: e instanceof Error ? e.message : String(e), events: relevant.map((x) => x.type) }); }).finally(() => { this.inflight -= 1; });
  }
  private async run(events: readonly DomainEvent[]): Promise<void> {
    for (const f of this.flows) {
      const mine = events.filter((e) => f.reacts(e.type));
      if (!mine.length) continue;
      try { await this.within({ source: "event", flow: f.id, triggers: [...new Set(mine.map((x) => x.type))] }, () => f.onEvents(this.deps, mine)); }
      catch (e) { this.deps.logger?.error("borrower.flow.failed", { flow: f.id, error: e instanceof Error ? e.message : String(e), events: mine.map((x) => x.type) }); }
    }
  }
  // ---- DELTA-26 / 32.16 T28: trigger attribution
  private async within<T>(ctx: CardTrigger, fn: () => Promise<T>): Promise<T> { this.active.push(ctx); try { return await fn(); } finally { const i = this.active.lastIndexOf(ctx); if (i >= 0) this.active.splice(i, 1); } }
  private attribute(events: readonly DomainEvent[]): void {
    for (const e of events) {
      if (e.type !== "card.sent") continue;
      const id = (e.payload as { card_instance_id?: unknown }).card_instance_id; if (typeof id !== "string") continue;
      // no flow context: the owning events committed with the card (never the bus's own `command.*` receipt or the thread's `card.*`) — or the 32.16 tool command the card.sent names (`card.request`, COMMAND_TRIGGERS)
      const declared = (e.payload as { trigger?: unknown }).trigger;
      const ctx: readonly CardTrigger[] = this.active.length ? [...this.active] : typeof declared === "string" && COMMAND_TRIGGERS.includes(declared) ? [{ source: "command", flow: null, triggers: [declared] }] : [{ source: "command", flow: null, triggers: [...new Set(events.filter((x) => !BUS_OR_THREAD_EVENT.test(x.type)).map((x) => x.type))] }];
      if (this.cardTriggers.size >= CARD_TRIGGER_CAP) { const oldest = this.cardTriggers.keys().next().value; if (oldest !== undefined) this.cardTriggers.delete(oldest); }
      this.cardTriggers.set(id, ctx);
    }
  }
  /** What raised the card (see `CardTrigger`); undefined for a card this registry never saw commit. */
  triggerOf(cardInstanceId: string): readonly CardTrigger[] | undefined { return this.cardTriggers.get(cardInstanceId); }
  /** The session hooks, in flow order (awaited by the sign-in routes: 32.3 T1 — the disclosure is logged before any other assistant content). */
  async sessionOpened(session: SessionOpened): Promise<void> {
    for (const f of this.flows) if (f.onSessionOpened) { try { await this.within({ source: "session", flow: f.id, triggers: [SESSION_TRIGGER] }, () => f.onSessionOpened!(this.deps, session)); } catch (e) { this.deps.logger?.error("borrower.flow.session.failed", { flow: f.id, error: e instanceof Error ? e.message : String(e) }); } }
  }
  /** The first flow that answers a borrower message wins; null leaves the generic reply to the API. */
  async message(message: InboundMessage): Promise<FlowReply | null> {
    for (const f of this.flows) if (f.onMessage) { try { const r = await this.within({ source: "message", flow: f.id, triggers: [MESSAGE_TRIGGER] }, () => f.onMessage!(this.deps, message)); if (r) return r; } catch (e) { this.deps.logger?.error("borrower.flow.message.failed", { flow: f.id, error: e instanceof Error ? e.message : String(e) }); } }
    return null;
  }
  /** Resolves when every queued reaction (including the ones a reaction's own commands queued) has run. */
  async settle(): Promise<void> { while (this.inflight > 0) await this.queue; }
  /** The scheduled pass: every flow's tick, then whatever it queued. */
  async tick(nowIso: string = this.deps.runtime.clock.now()): Promise<void> {
    for (const f of this.flows) if (f.tick) { try { await this.within({ source: "tick", flow: f.id, triggers: [TICK_TRIGGER] }, () => f.tick!(this.deps, nowIso)); } catch (e) { this.deps.logger?.error("borrower.flow.tick.failed", { flow: f.id, error: e instanceof Error ? e.message : String(e) }); } }
    await this.settle();
  }
}
