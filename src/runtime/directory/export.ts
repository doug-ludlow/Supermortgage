/**
 * 34.2 `directory.export` — rule 5: "Export is the evidence pack for one person" (34.4's layout restricted to the party).
 *
 * A `compliance` staff member names the party and a reason (REASON_REQUIRED); the pack IS 34.4's evidence pack with a party
 * subject (src/runtime/controls/evidence.ts buildEvidencePack — review finding: one layout for a person, never two): the
 * manifest with a count and a sha256 per row set, the events in parts, one document with a sha256, an `evidence_packs` row —
 * verifiable through `GET /ops/api/controls/evidence/{id}?verify=1`. The party subject's row sets are the person's rows only
 * (src/runtime/directory/scope.ts: their loans and applications, a row on a shared subject only when it names no other party —
 * T5) and carry the directory's own rows too (the `directory` section: sessions, the thread, the cards and their transitions,
 * the unmasks and the earlier exports), every set through the directory's NO_SECRETS / NO_FULL_SSN pass. The document text is
 * retained with its `documents` row (`retain: "metadata"` — the runtime's path has no blob store), so the pack reads back where
 * it was produced. On top of the pack: one append-only `directory_exports` row (the pack's document and hash), the decision
 * record (agent security-records, action directory.export, the reason as rationale, the person as approver) and
 * `directory.exported{staff_user_id, party_id, export_id, pack_id, document_id, sha256}` (global; ids only). The receipts of the export
 * (the decision, the staff_actions row, the directory_exports row) are keyed on the export, never on the person, so the person's
 * own row sets — the pack's — do not gain the pack's receipt and the pack verifies after it was produced.
 */
import { randomUUID } from "node:crypto";
import type { Actor } from "../../kernel/events/index.ts";
import type { Runtime } from "../app.ts";
import { buildEvidencePack, PACK_DOCUMENT_KIND, type EvidenceManifest } from "../controls/evidence.ts";
import { EXPORT_ROLES } from "./mask.ts";
import { partyScope } from "./scope.ts";
import { DIRECTORY_AGENT, DIRECTORY_MODEL_VERSION, DIRECTORY_PROMPT_VERSION, DIRECTORY_RULE_SET_VERSION, DirectoryRefused } from "./unmask.ts";

/** The export's document is an evidence pack (34.4's kind): `documents.kind`. */
export const EXPORT_DOCUMENT_KIND = PACK_DOCUMENT_KIND;

export interface DirectoryExportInput { readonly staff_user_id: string; readonly session_id?: string | null; readonly party_id: string; readonly reason: string; readonly roles?: readonly string[] }
/** The one-person pack as the caller reads it: the stored document (`{manifest, sets}` — its JSON is the hashed bytes) plus the events of every part. */
export interface DirectoryExportPack { readonly manifest: EvidenceManifest; readonly sets: Record<string, unknown[]>; readonly events: readonly Record<string, unknown>[] }
export interface DirectoryExportResult {
  readonly export_id: string; readonly pack_id: string; readonly document_id: string; readonly sha256: string; readonly byte_size: number; readonly party_id: string;
  readonly sections: readonly string[]; readonly part_count: number; readonly manifest: EvidenceManifest;
  readonly decision_id: string | null; readonly event_id: string | null; readonly pack: DirectoryExportPack;
}

export async function directoryExport(rt: Runtime, i: DirectoryExportInput, actor?: Actor): Promise<DirectoryExportResult> {
  const roles = i.roles ?? (actor?.role ? [actor.role] : []);
  if (roles.length && !roles.some((r) => EXPORT_ROLES.includes(r))) throw new DirectoryRefused(403, "ROLE_REQUIRED", `export needs ${EXPORT_ROLES.join(" or ")}`, { role: "compliance", roles: EXPORT_ROLES });
  const reason = String(i.reason ?? "").trim();
  if (!reason) throw new DirectoryRefused(400, "REASON_REQUIRED", "an export needs a reason");
  if (!i.staff_user_id) throw new DirectoryRefused(401, "SESSION_REQUIRED", "an export is produced by a staff session");
  const now = rt.clock.now();
  // the directory's own scope decides who is a person here (a servicer or an investor party is not in the directory)
  if (!(await partyScope(rt.db, i.party_id))) throw new DirectoryRefused(404, "NOT_FOUND", `no account ${i.party_id}`);
  const by: Actor = actor ?? { kind: "human", id: i.staff_user_id, role: "compliance" };
  // 34.4's pack for the party (its own transaction: the documents, the evidence_packs row, evidence.pack.produced as the person)
  const pack = await buildEvidencePack(rt, { subject: { party_id: i.party_id }, produced_by: by, retain: "metadata" }, now);
  const export_id = randomUUID();
  const events = pack.parts.flatMap((p) => (JSON.parse(p.content) as { events: Record<string, unknown>[] }).events);
  const w = await rt.uow.run({}, async (ctx) => {
    ctx.events.append({ type: "directory.exported", aggregate: { kind: "party", id: i.party_id }, actor: by, payload: { staff_user_id: i.staff_user_id, ...(i.session_id ? { session_id: i.session_id } : {}), party_id: i.party_id, export_id, pack_id: pack.id, document_id: pack.document_id, sha256: pack.sha256, byte_size: pack.byte_size, part_count: pack.part_count, reason } });
    // the decision's subject is the export produced (as 34.4's controls.evidence.pack names the pack): the person's own decisions — a row set of the pack — do not gain the pack's receipt, so the pack verifies after it was produced; the party rides on the event and the directory_exports row
    ctx.decide({ agent: DIRECTORY_AGENT, action: "directory.export", subject: { kind: "directory_export", id: export_id }, rationale: reason, ruleSetVersion: DIRECTORY_RULE_SET_VERSION, ruleCode: "34.2 rule 5", modelVersion: DIRECTORY_MODEL_VERSION, promptVersion: DIRECTORY_PROMPT_VERSION, confidence: 1, evidenceDocumentIds: [pack.document_id!], approvedBy: i.staff_user_id, ...(by.role ? { approvedRole: by.role } : {}) });
  }, { clock: rt.clock, before: async (tx) => {
    await tx.query(`INSERT INTO directory_exports (id, staff_user_id, party_id, document_id, sha256, created_at) VALUES ($1, $2, $3, $4, $5, $6)`, [export_id, i.staff_user_id, i.party_id, pack.document_id, pack.sha256, now]);
  } });
  rt.logger?.info("directory.exported", { export_id, pack_id: pack.id, party_id: i.party_id, document_id: pack.document_id, sha256: pack.sha256, byte_size: pack.byte_size, by: i.staff_user_id });
  return { export_id, pack_id: pack.id, document_id: pack.document_id!, sha256: pack.sha256, byte_size: pack.byte_size, party_id: i.party_id, sections: pack.sections, part_count: pack.part_count, manifest: pack.manifest,
    decision_id: w.decisions[0]?.id ?? null, event_id: w.events[0]?.id ?? null, pack: { manifest: pack.manifest, sets: JSON.parse(pack.document).sets as Record<string, unknown[]>, events } };
}
