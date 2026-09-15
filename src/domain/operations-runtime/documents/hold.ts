/**
 * §35.2 rule 5 — holds are two-sided and logged. `documents.hold{place}` sets `legal_hold = true`, writes a
 * `document_holds{placed}` row and places the object store's temporary hold in the same command (the FAKE records
 * `FAKE:hold:<n>`; a document still `staged` gets its object hold from the drain when the object exists); an agent may place
 * a hold and never release one (HOLD_RELEASE_HUMAN_ONLY — the tool's guardrail and the table's CHECK); release needs a human
 * `compliance` or `counsel` actor and a reason, and writes the `released` row before the flag changes (the
 * documents_column_restricted trigger refuses the flip without it). A release for a document under a second, open matter is
 * refused HOLD_STILL_REQUIRED naming the other `matter_ref`; each matter's hold is its own placed/released pair.
 */
import { actorRef, docKey, requireDocument, DocumentsRefused, type DocsDeps } from "./shared.ts";

export interface HoldResult { readonly document_id: string; readonly hold_id: string; readonly legal_hold: boolean; readonly matter_ref: string; readonly blob_hold_ref: string | null; readonly open_matters: string[]; }

async function openMatters(q: DocsDeps["q"], documentId: string): Promise<string[]> {
  const rows = await q.query<{ matter_ref: string; placed: string; released: string }>(`SELECT matter_ref, count(*) FILTER (WHERE action = 'placed')::text AS placed, count(*) FILTER (WHERE action = 'released')::text AS released FROM document_holds WHERE document_id = $1 GROUP BY matter_ref ORDER BY min(seq)`, [documentId]);
  return rows.filter((r) => Number(r.placed) > Number(r.released)).map((r) => r.matter_ref);
}

export async function placeHold(deps: DocsDeps, i: { document_id: string; reason: string; matter_ref: string }): Promise<HoldResult> {
  const q = deps.q;
  const d = await requireDocument(q, i.document_id);
  if (d.storage_status === "disposed") throw new DocumentsRefused("TOMBSTONE", "35.2 state machine: disposed is terminal", `document ${d.id} was disposed under run ${d.disposal_run_id}; there is nothing to hold`);
  const open = await openMatters(q, d.id);
  if (open.includes(i.matter_ref)) throw new DocumentsRefused("HOLD_ALREADY_PLACED", "35.2 rule 5: each matter's hold is its own placed/released pair", `document ${d.id} is already held for ${i.matter_ref}`);
  const blobHoldRef = d.storage_status === "stored" ? await deps.blobs.hold(d.id) : null;
  await q.query(`SELECT set_config('sm.document_hold', $1, true)`, [d.id]);
  const hold = await q.query<{ id: string }>(`INSERT INTO document_holds (document_id, action, reason, matter_ref, actor_kind, actor_id, actor_role, blob_hold_ref, created_at) VALUES ($1, 'placed', $2, $3, $4::actor_kind, $5, $6, $7, $8::timestamptz) RETURNING id`,
    [d.id, i.reason, i.matter_ref, deps.actor.kind, deps.actor.id, deps.actor.role ?? null, blobHoldRef, deps.now]);
  if (!d.legal_hold) await q.query(`UPDATE documents SET legal_hold = true WHERE id = $1`, [d.id]);
  await q.query(`SELECT set_config('sm.document_hold', '', true)`);
  deps.events.append({ type: "document.hold.placed", ...docKey(d), aggregate: { kind: "document", id: d.id }, actor: deps.actor, payload: { document_id: d.id, reason: i.reason, matter_ref: i.matter_ref, by: actorRef(deps.actor), blob_hold_ref: blobHoldRef, hold_id: hold[0]!.id } });
  return { document_id: d.id, hold_id: hold[0]!.id, legal_hold: true, matter_ref: i.matter_ref, blob_hold_ref: blobHoldRef, open_matters: [...open, i.matter_ref] };
}

export async function releaseHold(deps: DocsDeps, i: { document_id: string; reason: string; matter_ref?: string | null }): Promise<HoldResult> {
  const q = deps.q;
  if (deps.actor.kind !== "human" || !["compliance", "counsel"].includes(deps.actor.role ?? "")) throw new DocumentsRefused("HOLD_RELEASE_HUMAN_ONLY", "35.2 rule 5 / 19.1 AI agent design: holds.release is not allowed — human only", `release needs a human compliance or counsel actor; ${actorRef(deps.actor)} may not`);
  const d = await requireDocument(q, i.document_id);
  const open = await openMatters(q, d.id);
  if (!open.length) throw new DocumentsRefused("NO_OPEN_HOLD", "35.2 rule 5", `document ${d.id} has no open hold`);
  // the document's hold (no matter named) is released only when one matter is open; a named matter releases its own pair and the flag stays while another matter is open
  const matter = i.matter_ref || (open.length === 1 ? open[0]! : "");
  if (!matter || !open.includes(matter)) throw new DocumentsRefused("HOLD_STILL_REQUIRED", "35.2 edge case: a hold release for a document under a second, open matter is refused naming the other matter_ref", `document ${d.id} is still required for ${open.join(", ")} — name the matter_ref whose hold is released`);
  const others = open.filter((m) => m !== matter);
  await q.query(`SELECT set_config('sm.document_hold', $1, true)`, [d.id]);
  // the released row is written before the flag changes (the trigger refuses the flip without it)
  const rel = await q.query<{ id: string }>(`INSERT INTO document_holds (document_id, action, reason, matter_ref, actor_kind, actor_id, actor_role, blob_hold_ref, created_at) VALUES ($1, 'released', $2, $3, 'human', $4, $5, NULL, $6::timestamptz) RETURNING id`,
    [d.id, i.reason, matter, deps.actor.id, deps.actor.role, deps.now]);
  if (!others.length) {
    await q.query(`UPDATE documents SET legal_hold = false WHERE id = $1`, [d.id]);
    if (d.storage_status === "stored") await deps.blobs.unhold(d.id);
  }
  await q.query(`SELECT set_config('sm.document_hold', '', true)`);
  deps.events.append({ type: "document.hold.released", ...docKey(d), aggregate: { kind: "document", id: d.id }, actor: deps.actor, payload: { document_id: d.id, reason: i.reason, matter_ref: matter, by: actorRef(deps.actor), hold_id: rel[0]!.id, still_held_for: others } });
  return { document_id: d.id, hold_id: rel[0]!.id, legal_hold: others.length > 0, matter_ref: matter, blob_hold_ref: null, open_matters: others };
}
