/**
 * §35.2 rule 7 — `documents.open` outside the bus: the borrower viewer's `/content`, the payoff verification portal and the
 * console's staff view serve bytes through here so the `document_access_log` row and `document.opened` commit in one unit
 * of work on the document's own subject (its loan or application; global for a keyless row). A served mismatch is answered
 * to the caller as `mismatch`; the caller raises the sev 1 through `documents.verify{op: one}` on the bus (never inside this
 * unit — no nested command in a unit of work).
 */
import type { Runtime } from "../app.ts";
import type { Queryable } from "../../infra/db/client.ts";
import type { Actor } from "../../kernel/events/index.ts";
import { openDocument, insertAccessLog, type OpenInput, type OpenResult } from "../../domain/operations-runtime/documents/open.ts";
import { readDocument } from "../../domain/operations-runtime/documents/shared.ts";

export async function openDocumentInUow(runtime: Runtime, input: OpenInput, actor: Actor): Promise<OpenResult> {
  const row = await readDocument(runtime.db, input.document_id);
  if (!row) return { kind: "unknown" };
  const scope = { ...(row.loan_id ? { loanId: row.loan_id } : {}), ...(row.application_id ? { applicationId: row.application_id } : {}) };
  // with 35.1's seam the unit of work carries `ctx.q` and the access-log row is written inside `fn`; before it, the row is written in the `before` hook — the same transaction the event commits in
  let pending: OpenResult | null = null; let logged: string | null = null;
  const r = await runtime.uow.run(scope, async (ctx) => {
    const q = (ctx as { q?: Queryable }).q;
    const out = await openDocument({ q: q ?? runtime.db, blobs: runtime.blobs }, { ...input, log: q ? input.log !== false : false });
    if (out.kind === "bytes") { pending = out; ctx.events.append({ type: "document.opened", ...(row.loan_id ? { loanId: row.loan_id } : {}), ...(row.application_id ? { applicationId: row.application_id } : {}), aggregate: { kind: "document", id: row.id }, actor,
      payload: { document_id: row.id, purpose: input.purpose, ...(input.party_id ? { party_id: input.party_id } : {}), ...(input.staff_user_id ? { staff_user_id: input.staff_user_id } : {}), sha256: out.sha256, byte_size: out.byte_size, served_from: out.served_from, store_missing: out.store_missing } }); }
    return out;
  }, { clock: runtime.clock, before: async (q) => {
    if (!pending || pending.kind !== "bytes" || pending.access_log_id || input.log === false) return;
    logged = await insertAccessLog(q, { document_id: row.id, purpose: input.purpose, party_id: input.party_id ?? null, staff_user_id: input.staff_user_id ?? null, session_id: input.session_id ?? null, ip: input.ip ?? null, user_agent: input.user_agent ?? null, sha256_served: pending.sha256, byte_size_served: pending.byte_size, served_from: pending.served_from });
  } });
  return r.result.kind === "bytes" && logged ? { ...r.result, access_log_id: logged } : r.result;
}

/** A served mismatch (rule 7): the same sev 1 as the daily run, through the bus — after the open's unit of work returned. */
export async function raiseServedMismatch(runtime: Runtime, documentId: string, actor: Actor): Promise<void> {
  const row = await readDocument(runtime.db, documentId);
  await runtime.execute({ process: "35.2", name: "documents.verify", loanId: row?.loan_id ?? "", ...(row?.application_id ? { applicationId: row.application_id } : {}), actor, input: { op: "one", document_id: documentId } });
}
