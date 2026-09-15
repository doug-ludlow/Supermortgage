/**
 * §35.2 "AI agent design" — the decision record every state-changing 35.2 tool leaves:
 *   {document_id | envelope_id | manifest_id, action, sha256, retention_class, hold, subject: {loan_id? application_id?
 *    party_id?}, rule_set_version: docs.v1, model_version: deterministic, prompt_version: 35.2-v1, confidence: 1, rationale}
 * — no rendered text, address or TIN in a decision (NO_PII_IN_DECISION): the rationale is built from fixed phrases plus ids,
 * hashes, class names and counts, and the builder refuses a serialization that looks like a TIN, an EIN or a money figure.
 */
import { PROMPT_VERSION, RULE_SET_VERSION } from "./shared.ts";

export interface DocsDecision {
  readonly action: string; readonly rationale: string; readonly subject: { kind: string; id: string }; readonly ruleCode: string;
  readonly modelVersion: string; readonly promptVersion: string; readonly confidence: number; readonly evidenceDocumentIds?: readonly string[];
}
export interface DocsDecisionInput {
  readonly subject: { kind: "document" | "envelope" | "manifest" | "integrity_run" | "mail_batch"; id: string };
  readonly action: string;
  readonly sha256?: string | null;
  readonly retention_class?: string | null;
  readonly hold?: boolean;
  readonly loan_id?: string | null;
  readonly application_id?: string | null;
  readonly party_id?: string | null;
  readonly counts?: Record<string, number>;
  readonly evidence_document_ids?: readonly string[];
  readonly rationale: string;
}
const TIN = /\b\d{3}-\d{2}-\d{4}\b/; const EIN = /\b\d{2}-\d{7}\b/; const MONEY = /\$\d[\d,]*\.\d{2}/;

export function docsDecision(d: DocsDecisionInput): DocsDecision {
  const record = { [`${d.subject.kind}_id`]: d.subject.id, action: d.action, sha256: d.sha256 ?? null, retention_class: d.retention_class ?? null, hold: d.hold ?? false,
    subject: { loan_id: d.loan_id ?? null, application_id: d.application_id ?? null, party_id: d.party_id ?? null }, ...(d.counts ? { counts: d.counts } : {}),
    rule_set_version: RULE_SET_VERSION, model_version: "deterministic", prompt_version: PROMPT_VERSION, confidence: 1, rationale: d.rationale };
  const s = JSON.stringify(record);
  if (TIN.test(s) || EIN.test(s) || MONEY.test(s)) throw new RangeError(`NO_PII_IN_DECISION: a 35.2 decision carries ids, hashes, class names and counts only (${d.action})`);
  return { action: `${d.subject.kind === "document" ? "documents" : d.subject.kind === "envelope" ? "esign.envelope" : d.subject.kind === "integrity_run" ? "documents.verify" : "mail"}.${d.action}`, rationale: s, subject: d.subject, ruleCode: "35.2",
    modelVersion: "deterministic", promptVersion: PROMPT_VERSION, confidence: 1, ...(d.evidence_document_ids?.length ? { evidenceDocumentIds: d.evidence_document_ids } : {}) };
}
