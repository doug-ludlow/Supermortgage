/**
 * The borrower event stream (docs/ux/02-data-contracts.md §3): `GET /v1/borrower/stream` is server-sent events carrying
 * `{event_name, at, subject, payload_ref}` for the events the UI subscribes to — the UI re-fetches the affected
 * projection; nothing else rides on the wire (no payload, no figure). Fed in-process from the runtime's post-commit
 * hook (`Runtime.onCommitted`): after every unit of work commits, the persisted events are mapped to the parties whose
 * subjects they name (application_borrowers.party_id, borrowers.party_id via loan_borrowers, scoped loan_parties) and
 * pushed to that party's open connections. One subscriber list per party; a per-party ring of the last events with
 * monotonically increasing ids so a reconnect with `Last-Event-ID` replays what it missed; a heartbeat comment every
 * HEARTBEAT_MS keeps proxies from closing idle streams.
 */
import type { ServerResponse } from "node:http";
import type { Queryable } from "../../infra/db/client.ts";
import type { DomainEvent } from "../../kernel/events/index.ts";

export interface StreamEvent { readonly id: number; readonly event_name: string; readonly at: string; readonly subject: { application_id: string | null; loan_id: string | null }; readonly payload_ref: { event_id: string; sequence: number; record: string; thread: string } }
export const HEARTBEAT_MS = 15_000;
export const RING_SIZE = 500;

/** The events of 02 §3 (platform spellings — docs/ux/BACKEND-DELTAS.md §2). Exact names and families. */
const EXACT = new Set(["lead.disclosure.delivered", "lead.authenticated", "credit.softpull.received", "credit.report.received", "prequal.letter.issued", "preapproval.letter.issued", "terms.presentation.requested", "mlo.review.completed", "terms.presented", "application.received", "application.trid_received", "application.withdrawn", "intent.to_proceed.received", "verification.received", "du.findings.received", "decision.issued", "clear_to_close.issued", "loan.funded", "loan.boarded", "loan.purchased", "ach.return.received", "escrow.analysis.completed", "loan.delinquency.day_reached", "continuity.assigned", "identity.verified", "human_transferred", "human.transfer.requested", "human.transfer.completed", "loan.paid_in_full", "communication.inbound.received", "consent.granted", "consent.esign.pending", "consent.esign.verified", "consent.esign.active", "card.sent", "card.resolved", "notice.sent", "statement.sent", "application.party.invited", "party.contact.updated", "counteroffer.declined", "application.declarations.answered"]);
const FAMILIES = ["disclosure.", "lock.", "condition.", "valuation.", "flood.", "insurance.", "hazard.", "mi.", "closing.", "rescission.", "funding.", "payment.", "autodraft.", "statement.", "escrow.", "disbursement.", "pmi.", "arm.", "lossmit.", "workout.", "case.", "refi.opportunity.", "payoff.", "lien.", "enote.", "signing.", "appraisal.", "verification.", "document."];
export const subscribed = (type: string): boolean => EXACT.has(type) || FAMILIES.some((f) => type.startsWith(f));

interface Conn { readonly res: ServerResponse; readonly partyId: string }

export class BorrowerStreamHub {
  private readonly db: Queryable;
  private readonly conns = new Map<string, Set<Conn>>();
  private readonly rings = new Map<string, StreamEvent[]>();
  private seq = 0;
  private heartbeat: NodeJS.Timeout | null = null;
  private readonly partyCache = new Map<string, { at: number; parties: string[] }>();
  constructor(db: Queryable) { this.db = db; }

  /** Attach a response as an SSE connection for a party; replay the ring after `lastEventId` when given. */
  subscribe(partyId: string, res: ServerResponse, lastEventId: number | null): () => void {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write(`retry: 5000\n\n`);
    const conn: Conn = { res, partyId };
    let set = this.conns.get(partyId); if (!set) { set = new Set(); this.conns.set(partyId, set); } set.add(conn);
    if (lastEventId !== null) { for (const e of this.rings.get(partyId) ?? []) if (e.id > lastEventId) this.write(conn, e); }
    else res.write(`: connected\n\n`);
    if (!this.heartbeat) { this.heartbeat = setInterval(() => this.ping(), HEARTBEAT_MS); this.heartbeat.unref(); }
    const off = (): void => { set!.delete(conn); if (!set!.size) this.conns.delete(partyId); if (!this.conns.size && this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; } };
    res.on("close", off);
    return off;
  }
  connections(partyId?: string): number { return partyId ? (this.conns.get(partyId)?.size ?? 0) : [...this.conns.values()].reduce((n, s) => n + s.size, 0); }
  ring(partyId: string): readonly StreamEvent[] { return this.rings.get(partyId) ?? []; }

  /** The runtime's post-commit hook: map each subscribed event to its parties and push. */
  async publish(events: readonly DomainEvent[]): Promise<number> {
    let pushed = 0;
    for (const e of events) {
      if (!subscribed(e.type)) continue;
      const appId = e.applicationId ?? null; const loanId = e.loanId ?? null;
      if (!appId && !loanId) continue;
      const parties = await this.partiesFor(appId, loanId);
      for (const partyId of parties) {
        const se: StreamEvent = { id: ++this.seq, event_name: e.type, at: e.occurredAt, subject: { application_id: appId, loan_id: loanId }, payload_ref: { event_id: e.id, sequence: e.sequence, record: `/v1/borrower/record?subject=${encodeURIComponent(appId ?? loanId ?? "")}`, thread: `/v1/borrower/thread` } };
        let ring = this.rings.get(partyId); if (!ring) { ring = []; this.rings.set(partyId, ring); } ring.push(se); if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
        for (const c of this.conns.get(partyId) ?? []) { this.write(c, se); pushed++; }
      }
    }
    return pushed;
  }
  /** Every party that may read the subject (02 §6): the application's borrowers, the loan's borrowers, the scoped loan parties, the origination application's borrowers. */
  private async partiesFor(appId: string | null, loanId: string | null): Promise<string[]> {
    const key = `${appId ?? ""}|${loanId ?? ""}`; const cached = this.partyCache.get(key); const now = Date.now();
    if (cached && now - cached.at < 5_000) return cached.parties;
    const rows = await this.db.query<{ party_id: string }>(
      `SELECT DISTINCT party_id FROM (
         SELECT ab.party_id FROM application_borrowers ab WHERE ab.party_id IS NOT NULL AND ($1::uuid IS NOT NULL AND ab.application_id = $1)
         UNION SELECT ab.party_id FROM application_borrowers ab JOIN applications a ON a.id = ab.application_id WHERE ab.party_id IS NOT NULL AND $2::uuid IS NOT NULL AND a.loan_id = $2
         UNION SELECT b.party_id FROM borrowers b JOIN loan_borrowers lb ON lb.borrower_id = b.id WHERE b.party_id IS NOT NULL AND $2::uuid IS NOT NULL AND lb.loan_id = $2
         UNION SELECT lp.party_id FROM loan_parties lp WHERE $2::uuid IS NOT NULL AND lp.loan_id = $2 AND lp.ended_at IS NULL AND lp.role IN ('confirmed_successor', 'poa', 'authorized_third_party', 'executor')
       ) x WHERE party_id IS NOT NULL`, [appId, loanId]).catch(() => [] as { party_id: string }[]);
    const parties = rows.map((r) => r.party_id);
    this.partyCache.set(key, { at: now, parties });
    return parties;
  }
  private write(c: Conn, e: StreamEvent): void {
    if (c.res.writableEnded || c.res.destroyed) return;
    c.res.write(`id: ${e.id}\nevent: ${e.event_name}\ndata: ${JSON.stringify({ event_name: e.event_name, at: e.at, subject: e.subject, payload_ref: e.payload_ref })}\n\n`);
  }
  private ping(): void { for (const set of this.conns.values()) for (const c of set) if (!c.res.writableEnded && !c.res.destroyed) c.res.write(`: ping ${new Date().toISOString()}\n\n`); }
  close(): void { for (const set of this.conns.values()) for (const c of set) c.res.end(); this.conns.clear(); if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; } }
}
