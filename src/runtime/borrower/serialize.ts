/**
 * The allow-list serializer every /v1/borrower/* response goes through (docs/ux/02-data-contracts.md §6; 13 §1 "serializer
 * allow-lists", 13 §3 T-X-03). A response is built from a named shape; a shape lists exactly the field names that may
 * leave the API, and anything else on the object is dropped — so a row read from a shared table can never leak a column
 * the shape does not name, whatever the query selected. `ALL_ALLOWED_FIELDS` is the union the contract test greps against
 * the schema of `du_findings_interpretations`, `risk_assessment`, `credit_reports`, `compliance_test_runs`, `qc_*`,
 * `fraud_*` and `applicant_demographics`; `FORBIDDEN_FIELDS` is the explicit list no shape may ever name.
 */
export interface Shape { readonly [field: string]: true | Shape | readonly [Shape]; }   // true = scalar (or opaque scalar list); Shape = nested object; [Shape] = list of objects

const PARTY: Shape = { party_id: true, party_type: true, display_name: true, first_name: true };
const SESSION: Shape = { session_id: true, level: true, auth_method: true, expires_at: true, last_l1_at: true, fresh_l1: true, created_at: true };
const SUBJECT: Shape = { application_id: true, loan_id: true, role: true, stage: true, label: true };
export const SHAPES = {
  me: { party: PARTY, level: true, session: SESSION, subjects: [SUBJECT] } satisfies Shape,
  session: { token: true, session: SESSION, party: PARTY, level: true } satisfies Shape,
  otp_request: { challenge_id: true, channel: true, delivery: true, expires_at: true, fake_code: true } satisfies Shape,
  passkey_options: { challenge_id: true, challenge: true, rp: { id: true, name: true }, user: { id: true, name: true, display_name: true }, pub_key_cred_params: [{ type: true, alg: true }], allow_credentials: [{ type: true, id: true, transports: true }], timeout_ms: true, attestation: true, expires_at: true } satisfies Shape,
  passkey_registered: { passkey_id: true, credential_id: true, algorithm: true, attestation_verified: true, created_at: true } satisfies Shape,
  level: { level: true, session_id: true } satisfies Shape,
  identity_session: { vendor: true, vendor_session_id: true, client_secret: true, return_url: true, card_instance_id: true, application_id: true, status: true, delivery: true } satisfies Shape,
  identity_webhook: { received: true, vendor: true, vendor_session_id: true, outcome: true, level: true, application_id: true, prefilled: true, all_borrowers_verified: true, gate_open: true } satisfies Shape,
  document_uploaded: { document_id: true, application_id: true, status: true, integrity_status: true, quarantined: true, quarantine_reason: true, duplicate_of: true, matched_request_ids: true, received_at: true, doc_class: true, byte_size: true, sha256: true } satisfies Shape,
  document_link: { document_id: true, title: true, doc_class: true, mime_type: true, url: true, expires_at: true } satisfies Shape,
  deep_link: { token: true, target: { card_instance_id: true, document_id: true, route: true }, expires_at: true } satisfies Shape,
  error: { code: true, gate: true, copy_key: true } satisfies Shape,
} as const;
export type ShapeName = keyof typeof SHAPES;

/** Names that no shape may ever carry: the restricted / internal columns 02 §6 and 13 §3 T-X-03 name, plus the demographic fields. */
export const FORBIDDEN_FIELDS: readonly string[] = [
  "ethnicity", "race", "sex", "age", "declined_ethnicity", "declined_race", "declined_sex", "visual_observation_used", "collection_channel",
  "risk_assessment", "risk_score", "du_findings", "findings", "interpretation", "recommendation_code", "credit_score", "scores", "tradelines", "inquiries", "public_records", "report_xml", "report_json", "raw_report",
  "fraud_score", "fraud_flags", "fraud_hold", "fraud_hold_record", "red_flags", "sar_candidate", "qc_hold", "qc_finding", "qc_defect", "compliance_result", "test_results", "verdict",
  "tin_encrypted", "tin", "ssn", "date_of_birth_full", "account_number", "routing_number", "token_hash", "code_hash",
];

export function fieldsOf(shape: Shape, into = new Set<string>()): Set<string> {
  for (const [k, v] of Object.entries(shape)) { into.add(k); if (v !== true) fieldsOf(Array.isArray(v) ? (v as unknown as readonly [Shape])[0] : (v as Shape), into); }
  return into;
}
export const ALL_ALLOWED_FIELDS: ReadonlySet<string> = (() => { const s = new Set<string>(); for (const sh of Object.values(SHAPES)) fieldsOf(sh, s); return s; })();
for (const f of FORBIDDEN_FIELDS) if (ALL_ALLOWED_FIELDS.has(f)) throw new Error(`serializer shape names a forbidden field: ${f}`);

const scalar = (v: unknown): unknown => (typeof v === "bigint" ? v.toString() : v === undefined ? undefined : v);
function project(shape: Shape, value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined || typeof value !== "object") return null;
  const src = value as Record<string, unknown>; const out: Record<string, unknown> = {};
  for (const [k, rule] of Object.entries(shape)) {
    if (!(k in src)) continue;
    const v = src[k];
    if (rule === true) { if (v === null) out[k] = null; else if (Array.isArray(v)) out[k] = v.map((x) => (x && typeof x === "object" ? undefined : scalar(x))).filter((x) => x !== undefined); else if (v && typeof v === "object") continue; else out[k] = scalar(v); }
    else if (Array.isArray(rule)) { const inner = (rule as unknown as readonly [Shape])[0]; out[k] = Array.isArray(v) ? v.map((x) => project(inner, x)).filter((x): x is Record<string, unknown> => x !== null) : []; }
    else out[k] = v === null ? null : project(rule as Shape, v);
  }
  return out;
}
/** Project `value` onto the named shape: fields outside the shape never leave. */
export function serialize<N extends ShapeName>(shape: N, value: unknown): Record<string, unknown> {
  return project(SHAPES[shape], value) ?? {};
}
