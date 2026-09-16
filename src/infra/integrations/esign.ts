/**
 * §35.2 integrations — `esign`: the in-house envelope over the borrower surface; in every nonprod stage the FAKE signer port
 * (`FakeEsignSigner`) drives `esign.envelope.sign` on the bus with a fixed ip and user agent, as a human party through an L2
 * session (the session is the borrower's real one — rule 8: no agent ever signs). A production vendor, if one is chosen, maps
 * its webhooks onto the same `esign_signature_events` kinds; none is selected (the spec's [UNVERIFIED] note).
 */
import type { Runtime, ExecuteResponse } from "../../runtime/app.ts";
import { envelopeDocuments, requireEnvelope } from "../../domain/operations-runtime/documents/esign.ts";

export interface FakeSignInput { readonly envelope_id: string; readonly session_id: string; readonly party_id: string; readonly typed_name?: string; readonly scope?: { loanId?: string; applicationId?: string }; }

export class FakeEsignSigner {
  readonly vendorName = "FAKE";
  readonly ip = "203.0.113.10";
  readonly userAgent = "FAKE-signer/1";
  readonly log: { envelope_id: string; document_id: string; field_ids: string[]; at: string }[] = [];
  /** Every required field of the party on every document of the envelope, one `esign.envelope.sign` command per document on the envelope's own subject. */
  async sign(runtime: Runtime, i: FakeSignInput): Promise<{ results: ExecuteResponse[]; completed: boolean; signed_document_ids: string[]; evidence_document_id: string | null }> {
    const e = await requireEnvelope(runtime.db, i.envelope_id);
    const scope = i.scope ?? { ...(e.loan_id ? { loanId: e.loan_id } : {}), ...(e.application_id ? { applicationId: e.application_id } : {}) };
    const docs = await envelopeDocuments(runtime.db, e.id);
    const results: ExecuteResponse[] = []; let completed = false; let signedIds: string[] = []; let evidence: string | null = null;
    for (const d of docs) {
      const fieldIds = d.required_fields.filter((f) => f.signer_party_id === i.party_id).map((f) => f.field_id);
      if (!fieldIds.length) continue;
      const r = await runtime.execute({ process: "35.2", name: "esign.envelope.sign", loanId: scope.loanId ?? "", ...(scope.applicationId ? { applicationId: scope.applicationId } : {}), actor: { kind: "human", id: i.party_id, role: "borrower" },
        input: { envelope_id: e.id, document_id: d.document_id, signer_party_id: i.party_id, field_ids: fieldIds, auth: { method: "session_l2", session_id: i.session_id, ip: this.ip, user_agent: this.userAgent, typed_name: i.typed_name ?? "FAKE Signer" } } });
      this.log.push({ envelope_id: e.id, document_id: d.document_id, field_ids: fieldIds, at: runtime.clock.now() });
      results.push(r);
      const o = r.output as { completed?: boolean; signed_document_ids?: string[]; evidence_document_id?: string | null };
      if (o.completed) { completed = true; signedIds = o.signed_document_ids ?? []; evidence = o.evidence_document_id ?? null; }
    }
    return { results, completed, signed_document_ids: signedIds, evidence_document_id: evidence };
  }
}
