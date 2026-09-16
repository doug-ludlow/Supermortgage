/**
 * §35.2 rule 8 / 7.4 — `consent.esign.withdrawn` is consumed here: every open envelope the withdrawing party is a signer of is
 * voided (an envelope is an electronic channel; the audit trail is written, `esign.envelope.voided{reason:
 * consent.esign.withdrawn}` tells the owning process to mail). The listener rides the runtime's post-commit feed (the same feed
 * the borrower flows use) and runs one transaction per withdrawal after the command that logged it committed — never inside
 * that command's unit of work. `idle()` resolves when every queued withdrawal has been applied (tests await it).
 */
import type { Runtime } from "../app.ts";
import type { DomainEvent } from "../../kernel/events/index.ts";
import { MemoryEventStore } from "../../kernel/events/index.ts";
import type { Queryable } from "../../infra/db/client.ts";
import { consumeConsentWithdrawn } from "../../domain/operations-runtime/documents/esign.ts";
import { SYSTEM_DOCUMENTS } from "./sweep.ts";

export class ConsentWithdrawalListener {
  private queue: Promise<void> = Promise.resolve();
  private inflight = 0;
  readonly applied: { party_id: string; consent_id: string | null; voided: string[]; at: string }[] = [];
  private readonly off: () => void;
  private readonly runtime: Runtime;
  constructor(runtime: Runtime) { this.runtime = runtime; this.off = runtime.onCommitted((events) => this.enqueue(events)); }
  stop(): void { this.off(); }
  /** Resolves once every withdrawal committed so far has been applied. */
  async idle(): Promise<void> { while (this.inflight > 0) await this.queue; }
  private enqueue(events: readonly DomainEvent[]): void {
    for (const e of events) {
      if (e.type !== "consent.esign.withdrawn") continue;
      const partyId = typeof e.payload["party_id"] === "string" ? e.payload["party_id"] : null;
      if (!partyId || !/^[0-9a-f-]{36}$/i.test(partyId)) continue;
      const consentId = typeof e.payload["consent_id"] === "string" ? e.payload["consent_id"] : null;
      this.inflight += 1;
      this.queue = this.queue.then(() => this.apply(partyId, consentId, e)).catch((err: unknown) => { this.runtime.logger?.error("esign consent withdrawal consumer failed", { party_id: partyId, error: err }); }).finally(() => { this.inflight -= 1; });
    }
  }
  private async apply(partyId: string, consentId: string | null, trigger: DomainEvent): Promise<void> {
    const { runtime } = this;
    const key = { ...(trigger.loanId ? { loanId: trigger.loanId } : {}), ...(trigger.applicationId ? { applicationId: trigger.applicationId } : {}) };
    const now = runtime.clock.now();
    const persisted = await runtime.db.tx(async (q: Queryable) => {
      const events = new MemoryEventStore(runtime.clock, key);
      const voided = await consumeConsentWithdrawn({ q, blobs: runtime.blobs, events, actor: SYSTEM_DOCUMENTS, now }, { party_id: partyId, consent_id: consentId });
      this.applied.push({ party_id: partyId, consent_id: consentId, voided: voided.map((v) => v.envelope_id), at: now });
      return runtime.uow.events.append(events.since(0), q);
    });
    runtime.uow.notifyCommitted(persisted);
  }
}
