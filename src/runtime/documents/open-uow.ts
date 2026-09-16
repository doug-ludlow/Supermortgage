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
import { openDocument, type OpenInput, type OpenResult } from "../../domain/operations-runtime/documents/open.ts";
import { readDocument } from "../../domain/operations-runtime/documents/shared.ts";

export async function openDocumentInUow(runtime: Runtime, input: OpenInput, actor: Actor): Promise<OpenResult> {
  const row = await readDocument(runtime.db, input.document_id);
  if (!row) return { kind: "unknown" };
  const scope = { ...(row.loan_id ? { loanId: row.loan_id } : {}), ...(row.application_id ? { applicationId: row.application_id } : {}) };
  const r = await runtime.uow.run(scope, async (ctx) => {
    const q = (ctx as { q?: Queryable }).q ?? runtime.db;
    const out = await openDocument({ q, blobs: runtime.blobs }, input);
    if (out.kind === "bytes") ctx.events.append({ type: "document.opened", ...(row.loan_id ? { loanId: row.loan_id } : {}), ...(row.application_id ? { applicationId: row.application_id } : {}), aggregate: { kind: "document", id: row.id }, actor,
      payload: { document_id: row.id, purpose: input.purpose, ...(input.party_id ? { party_id: input.party_id } : {}), ...(input.staff_user_id ? { staff_user_id: input.staff_user_id } : {}), sha256: out.sha256, byte_size: out.byte_size, served_from: out.served_from, access_log_id: out.access_log_id } });
    return out;
  }, { clock: runtime.clock });
  return r.result;
}

/** A served mismatch (rule 7): the same sev 1 as the daily run, through the bus — after the open's unit of work returned. */
export async function raiseServedMismatch(runtime: Runtime, documentId: string, actor: Actor): Promise<void> {
  const row = await readDocument(runtime.db, documentId);
  await runtime.execute({ process: "35.2", name: "documents.verify", loanId: row?.loan_id ?? "", ...(row?.application_id ? { applicationId: row.application_id } : {}), actor, input: { op: "one", document_id: documentId } });
}
