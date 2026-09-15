/**
 * §35.2 rule 6 — disposal is 19.1's act. `documents.dispose{disposal_run_id}` runs only inside a 19.1 disposal run that
 * carries the `officer` attestation event (`disposal_run.attested` by a human officer — 19.1 rule 7) and the run's WORM
 * existence check (`worm_integrity.checked{run_halted=false}`); it refuses a held row (HOLD_ACTIVE), a `mismatch`/`missing`
 * row (19.1-T12: WORM_INTEGRITY_FAILED_SEV1) and an unverified row (the WORM existence check), deletes the object
 * (crypto-shred where the bucket is CMEK), nulls nothing on the `documents` row except the permitted status columns, and
 * leaves the tombstone. The checks run in this order so every refusal names its own cause: hold → mismatch → attestation
 * (DISPOSE_NEEDS_OFFICER_ATTESTATION) → WORM verification → 19.1's remaining guards (src/domain/data-security/ops-19-1.ts
 * disposalGuards). The attestation and WORM facts are read from the command's own log first (a loan-scoped command) and
 * from `loan_events` otherwise (a global command hydrates no history) — never from a caller-asserted flag.
 */
import type { DomainEvent } from "../../../kernel/events/index.ts";
import { disposalGuards, attestationFromEvents, wormFromEvents } from "../../data-security/ops-19-1.ts";
import { docKey, requireDocument, DocumentsRefused, type DocsDeps } from "./shared.ts";

type Attestation = ReturnType<typeof attestationFromEvents>;
type Worm = ReturnType<typeof wormFromEvents>;

/** The run's `disposal_run.attested` / `worm_integrity.checked` from the log in memory, else from the persisted event table. */
export async function disposalFacts(deps: Pick<DocsDeps, "q" | "events">, runId: string): Promise<{ attestation: Attestation; worm: Worm }> {
  const memory = deps.events.all();
  let attestation = attestationFromEvents(memory, runId);
  let worm = wormFromEvents(memory, runId);
  if (!attestation || !worm) {
    const rows = await deps.q.query<{ id: string; type: string; occurred_at: string; actor_kind: string; actor_id: string; actor_role: string | null; payload: Record<string, unknown> }>(
      `SELECT id, type, occurred_at, actor_kind, actor_id, actor_role, payload FROM loan_events WHERE type IN ('disposal_run.attested', 'worm_integrity.checked') AND payload->>'run_id' = $1 ORDER BY sequence`, [runId]);
    const persisted: DomainEvent[] = rows.map((r, i) => ({ id: r.id, type: r.type, occurredAt: r.occurred_at, actor: { kind: r.actor_kind as DomainEvent["actor"]["kind"], id: r.actor_id, ...(r.actor_role ? { role: r.actor_role } : {}) }, payload: r.payload, sequence: i }));
    attestation = attestation ?? attestationFromEvents(persisted, runId);
    worm = worm ?? wormFromEvents(persisted, runId);
  }
  return { attestation, worm };
}

export interface DisposeResult { readonly document_id: string; readonly disposal_run_id: string; readonly disposed_at: string; readonly sha256: string; }

export async function disposeDocument(deps: DocsDeps, i: { document_id: string; disposal_run_id: string }): Promise<DisposeResult> {
  const q = deps.q;
  const d = await requireDocument(q, i.document_id);
  if (d.storage_status === "disposed") throw new DocumentsRefused("TOMBSTONE", "35.2 state machine: disposed is terminal", `document ${d.id} was disposed under run ${d.disposal_run_id}`);
  if (d.legal_hold) throw new DocumentsRefused("HOLD_ACTIVE", "35.2 rule 5: a held document is never disposed", `document ${d.id} is under a legal hold`);
  if (d.verify_status === "mismatch" || d.verify_status === "missing") throw new DocumentsRefused("WORM_INTEGRITY_FAILED_SEV1", "19.1-T12: the WORM integrity check failed for this object — its disposal is blocked and a sev-1 incident is open", `document ${d.id} verify_status = ${d.verify_status}`);
  const { attestation, worm } = await disposalFacts(deps, i.disposal_run_id);
  if (!attestation || attestation.by_role !== "officer") throw new DocumentsRefused("DISPOSE_NEEDS_OFFICER_ATTESTATION", "35.2 rule 6 / 19.1 rule 7: disposal executes only inside a 19.1 disposal run that carries the officer attestation (`disposal_run.attested` by a human officer)", `run ${i.disposal_run_id} carries no officer attestation`);
  if (d.verify_status !== "verified" || d.storage_status !== "stored") throw new DocumentsRefused("WORM_INTEGRITY_FAILED_SEV1", "35.2 rule 6: an unverified row fails the WORM existence check — never delete without a verified WORM copy", `document ${d.id} is ${d.storage_status}/${d.verify_status}`);
  if (!worm || !worm.verified || worm.blocked_object_ids.includes(d.id)) throw new DocumentsRefused("WORM_INTEGRITY_FAILED_SEV1", "19.1 integrations: never delete without the verified WORM copy existence check passing first (`worm_integrity.checked` for this run)", `run ${i.disposal_run_id} has no passing worm_integrity.checked`);
  const g = disposalGuards({ op: "dispose", actor: deps.actor, disposal_run_id: i.disposal_run_id, attestation, worm, object_id: d.id });
  if (!g.allowed) throw new DocumentsRefused(g.code ?? "DISPOSAL_REFUSED", g.citation ?? "19.1 guardrails", `disposal of ${d.id} refused by 19.1's guards`);
  await q.query(`SELECT set_config('sm.disposal_run', $1, true)`, [i.disposal_run_id]);
  await deps.blobs.delete(d.id, q);
  await q.query(`UPDATE documents SET storage_status = 'disposed', disposed_at = $2::timestamptz, disposal_run_id = $3 WHERE id = $1`, [d.id, deps.now, i.disposal_run_id]);
  await q.query(`SELECT set_config('sm.disposal_run', '', true)`);
  deps.events.append({ type: "document.disposed", ...docKey(d), aggregate: { kind: "document", id: d.id }, actor: deps.actor, payload: { document_id: d.id, disposal_run_id: i.disposal_run_id, sha256: d.sha256, disposed_at: deps.now, attested_by: attestation.by } });
  return { document_id: d.id, disposal_run_id: i.disposal_run_id, disposed_at: deps.now, sha256: d.sha256 };
}
