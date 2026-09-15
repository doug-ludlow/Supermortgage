/**
 * §35.2 — `documents.store` outside the bus: the borrower upload route (22.1's `POST /v1/borrower/documents`) and every
 * other caller that has bytes but no command. The store runs in a unit of work of its own so the row, its staged bytes,
 * `document.staged` (the SM_DOC_WORM_DRAIN_1D trigger) and — when the store is reachable — the inline drain's
 * `document.stored` commit together, exactly as they do inside a command (rule 4 "staging first, always").
 *
 * The narrow seam onto 35.1: with the seam merged the unit of work carries `ctx.q` (the command's transaction, after the
 * scope lock) and the store runs inside `fn`. Before it, `fn` rehearses the store on a rolled-back savepoint to learn the
 * events (so the timers arm in this unit) and the real SQL runs in the `before` hook — the same transaction the events
 * commit in, under the id the rehearsal minted. Either way a hash mismatch inside the transaction rolls the whole unit back.
 */
import type { Runtime } from "../app.ts";
import type { Queryable } from "../../infra/db/client.ts";
import { MemoryEventStore, type Actor } from "../../kernel/events/index.ts";
import { storeDocument, type StoreInput, type StoreResult } from "../../domain/operations-runtime/documents/store.ts";

export interface StoreScope { readonly loanId?: string; readonly applicationId?: string; }

export async function storeDocumentInUow(runtime: Runtime, scope: StoreScope, input: StoreInput, actor: Actor): Promise<StoreResult> {
  let result: StoreResult | undefined;
  let rehearsed = false;
  await runtime.uow.run(scope, async (ctx) => {
    const q = (ctx as { q?: Queryable }).q;
    const now = ctx.clock.now();
    if (q) { result = await storeDocument({ q, blobs: runtime.blobs, events: ctx.events, actor, now }, input); return; }
    // HEAD: rehearse on a savepoint that is rolled back — the events the store would append, under the id the real store below reuses
    const rehearsal = new MemoryEventStore(ctx.clock, scope);
    result = await runtime.db.tx(async (tq) => {
      await tq.query("SAVEPOINT sm_store_rehearsal");
      const r = await storeDocument({ q: tq, blobs: runtime.blobs, events: rehearsal, actor, now }, input);
      await tq.query("ROLLBACK TO SAVEPOINT sm_store_rehearsal");
      return r;
    });
    rehearsed = true;
    for (const e of rehearsal.all()) ctx.events.append({ type: e.type, ...(e.loanId ? { loanId: e.loanId } : {}), ...(e.applicationId ? { applicationId: e.applicationId } : {}), ...(e.aggregate ? { aggregate: e.aggregate } : {}), actor: e.actor, payload: e.payload });
  }, { clock: runtime.clock, before: async (q) => {
    if (!rehearsed || !result || result.existing) return;
    const scratch = new MemoryEventStore(runtime.clock, scope);
    result = await storeDocument({ q, blobs: runtime.blobs, events: scratch, actor, now: runtime.clock.now() }, { ...input, id: result.document_id });
  } });
  return result!;
}
