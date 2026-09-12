/**
 * The allow-list serializer every /v1/borrower/* response goes through (docs/ux/02-data-contracts.md §6; 13 §1 "serializer
 * allow-lists", 13 §3 T-X-03). A response is built from a named shape; a shape lists exactly the field names that may
 * leave the API, and anything else on the object is dropped — so a row read from a shared table can never leak a column
 * the shape does not name, whatever the query selected. `ALL_ALLOWED_FIELDS` is the union the contract test greps against
 * the schema of `du_findings_interpretations`, `risk_assessment`, `credit_reports`, `compliance_test_runs`, `qc_*`,
 * `fraud_*` and `applicant_demographics`; `FORBIDDEN_FIELDS` is the explicit list no shape may ever name.
 */
export interface Shape { readonly [field: string]: true | "opaque" | Shape | readonly [Shape]; }   // true = scalar (or opaque scalar list); "opaque" = a UI-owned free-form object (card props, a tool's summary) copied with every FORBIDDEN_FIELDS key dropped at any depth; Shape = nested object; [Shape] = list of objects

const PARTY: Shape = { party_id: true, party_type: true, display_name: true, first_name: true };
const SESSION: Shape = { session_id: true, level: true, auth_method: true, expires_at: true, last_l1_at: true, fresh_l1: true, created_at: true };
const SUBJECT: Shape = { application_id: true, loan_id: true, role: true, stage: true, label: true };
const CARD: Shape = { card_instance_id: true, conversation_id: true, party_id: true, subject: { application_id: true, loan_id: true }, kind: true, status: true, created_by: true, copy_key: true, props: "opaque", evidence: "opaque", command_ref: true, expires_at: true, created_at: true, resolved_at: true };
const MESSAGE: Shape = { message_id: true, conversation_id: true, at: true, sender: true, sender_label: true, channel: true, body_text: true, card_instance_id: true, subject: { application_id: true, loan_id: true }, voice_turn: true, delivery: { sent: true, delivered: true, read: true }, card: CARD, deep_link: { token: true, path: true, expires_at: true }, copy_key: true, automation_marker: true, copy_tokens: "opaque" };   // 32.14 DELTA-11: a line's copy tokens (entry.resumed's answers), the way cards carry theirs
const NUMBERS: Shape = { note_rate: true, apr: true, pi_payment_cents: true, escrow_payment_cents: true, loan_amount_cents: true, cash_to_close_cents: true, monthly_savings_cents: true, lock: { status: true, expires_at: true, expires_on: true, period_days: true }, figures_source: true,
  upb_cents: true, next_payment: { due_on: true, amount_cents: true, pi_cents: true, escrow_cents: true }, escrow_balance_cents: true, days_past_due: true, paid_off: { payoff_date: true, escrow_refund_pending_cents: true },
  // 32.9 §3 / 7.3: the engine's ARM estimate once the initial notice is sent
  arm_estimate: { basis: true, change_on: true, first_new_payment_due: true, estimated_rate: true, estimated_pi_cents: true, notice_id: true, sent_on: true } };
const RECORD: Shape = {
  subject: { application_id: true, loan_id: true, label: true, transaction_type: true, occupancy: true, stage: true },
  status: { badge: true, state_source: true, one_liner: true, one_liner_tokens: "opaque" },
  read_only: true,
  next: { label: true, due_at: true, timer_code: true, calendar_note: true },
  needed_from_you: [{ item_id: true, kind: true, label: true, due_at: true, card_instance_id: true, created_at: true, source: true, owner: true, label_copy_key: true, copy_tokens: "opaque" }],
  what_we_are_doing: [{ item_id: true, kind: true, label: true, owner: true, owner_copy_key: true, status: true, source: true, created_at: true }],
  needed_summary: { count: true, nothing_needed: true, copy_key: true },
  numbers: NUMBERS,
  dates: [{ timer_code: true, label: true, due_at: true, calendar: true, status: true, tone: true }],
  documents: [{ document_id: true, notice_id: true, disclosure_id: true, notice_code: true, title: true, kind: true, status: true, delivered_at: true, received_at: true, received_on: true, mailed_at: true, requires_ack: true, channel: true, template_version: true, le_version: true, copy_of_disclosure_id: true, card_instance_id: true, deliveries: [{ borrower_id: true, display_name: true, channel: true, status: true, at: true }] }],
  people: [{ party_id: true, role: true, display_name: true, progress: { consents_ok: true, confirmations_ok: true, signed: true }, nmlsr_id: true, direct_number: true, commission_state: true, is_you: true, waiting: true }],
  property: { address: true, tbd: true, property_type: true, units: true, occupancy: true, county: true, valuation: { method: true, status: true, appointment_at: true, value_used_cents: true, label: true }, flood: { status: true, label: true }, hazard: { status: true, label: true }, project_review: { status: true, label: true }, hoa_dues_cents: true },
  loan: { autodraft: { status: true, next_draft_on: true, amount_cents: true, account_last4: true, draft_day: true, amount_rule: true, ends_on: true, terminated_on: true, termination_reason: true }, ratewatch_status: true, escrow_lines: [{ type: true, payee: true, next_disbursement_on: true, annual_cents: true }], mi: { status: true, projected_end_on: true, cancellation_eligible_on: true, midpoint_on: true }, arm: { next_change_on: true, notice_status: true }, year_end: { form_1098_status: true, tax_year: true, furnished_on: true, channel: true }, continuity_team: "opaque", hardship: "opaque", servicer_loan_number_last4: true, first_payment_date: true, maturity_date: true, escrowed: true, remaining_term_months: true, ratewatch: { current_rate: true, best_available_rate: true, rate_sheet_id: true, state: true, worth_it_copy_key: true, state_copy_key: true, offer_card_instance_id: true, application_id: true }, standing_connections: { status: true, consent_id: true, captured_at: true, withdrawn_at: true, manage_card_instance_id: true, vendors: true } },
  offers: [{ refi_opportunity_id: true, status: true, offered_at: true, expires_at: true, terms: { current_rate: true, offered_rate: true, apr: true, new_pi_payment_cents: true, monthly_savings_cents: true, costs_to_borrower_cents: true } }],
  as_of: true,
};
const HISTORY_ROW: Shape = { kind: true, id: true, payment_id: true, status: true, amount_cents: true, received_on: true, credited_as_of: true, channel: true, designation: true, allocation: { principal_cents: true, interest_cents: true, escrow_cents: true, fees_cents: true },
  type: true, payee: true, due_date: true, sent_at: true, confirmed_at: true, as_of: true, new_payment_cents: true, effective_on: true, shortage_cents: true, surplus_cents: true, deficiency_cents: true, months: true, recorded_on: true,
  cycle_id: true, cycle_due_date: true, statement_due_by: true, variant: true, generated_at: true, document_id: true, delivered_at: true,
  case_id: true, opened_at: true, closed_at: true, receipt_date: true, is_qwr: true, determination: true, response_type: true, due: [{ timer_code: true, due_date: true, status: true }],
  application_id: true, received_date: true, protection_tier: true, facially_complete_at: true, complete_at: true, reasonable_date: true, ack_sent_on: true, evaluation_id: true, started_at: true, due_at: true, decided_at: true, provided_at: true, option: true, accept_by: true, responded_on: true, plan_type: true, start_date: true, current_term_end: true, installment_cents: true, term_months: true, appeal_window_ends: true, decision: true };
// 32.14 DELTA-11: the anonymous minute (POST /v1/borrower/lead) — a line is a copy reference with the tokens it needs (never loan data), a step is the next chip, the range is 20.3 rule 7's published low–high
const LEAD_LINE: Shape = { message_id: true, at: true, sender: true, automation_marker: true, copy_key: true, copy_tokens: "opaque", event_type: true, text: true, state_variant: true, reason: true, state: true, personal_terms: true };
const LEAD_STEP: Shape = { id: true, kind: true, copy_key: true, options: [{ id: true, transaction_type: true }], preselected: true, fields: [{ id: true, copy_key: true, kind: true }], limit: { max_ltv_pct: true } };   // the estimate step names no copy_key of its own (its fields do — one accessible name each); cash-out carries the 80% cap as a plain limit
const LEAD_RANGE: Shape = { low_pct: true, high_pct: true, apr_low_pct: true, apr_high_pct: true, product_code: true, product_label: true, rate_sheet_id: true, text: true, checklist_run_id: true, apr_basis: true };
const LEAD_CLOSED: Shape = { reason: true, copy_key: true, gate: true, state: true };
export const SHAPES = {
  me: { party: PARTY, level: true, session: SESSION, subjects: [SUBJECT], partner: { legal_name: true, nmlsr_id: true } } satisfies Shape,   // 32.13: the partner the shell names in the automation marker and the disclosure line
  lead_state: { lead_token: true, lead_id: true, partner: { legal_name: true, nmlsr_id: true }, lines: [LEAD_LINE], step: LEAD_STEP, closed: LEAD_CLOSED, range: LEAD_RANGE } satisfies Shape,   // `lead_token` leaves the API once (start) and the proxy turns it into the cookie; it is never echoed on state/answer/range
  lead_answer: { lead_id: true, lines: [LEAD_LINE], step: LEAD_STEP, closed: LEAD_CLOSED } satisfies Shape,
  lead_range: { lead_id: true, range: LEAD_RANGE, card: { kind: true, copy_key: true, personal_terms: true, copy_tokens: "opaque" }, promise_copy_key: true, disclaimer_copy_key: true, next: LEAD_STEP, refused: true } satisfies Shape,
  // 32.14 T18: the funnel read model (counts per stage from loan_events only)
  funnel: { from: true, to: true, stages: [{ stage: true, event_type: true, count: true }] } satisfies Shape,
  session: { token: true, session: SESSION, party: PARTY, level: true } satisfies Shape,
  otp_request: { challenge_id: true, channel: true, delivery: true, expires_at: true, fake_code: true } satisfies Shape,
  // 32.16 DELTA-29: POST /v1/borrower/auth/account — `create` answers the e-mail challenge (the code only as the FAKE echo outside production); `verify_email` / `sign_in` answer the session shape; `request_reset` / `reset` answer `account_ok` (a reset challenge id and the FAKE echo when the e-mail exists — never whether it does); an unverified sign-in's 403 carries the fresh challenge on the error shape
  account_create: { challenge_id: true, delivery: true, expires_at: true, fake_code: true } satisfies Shape,
  account_ok: { ok: true, challenge_id: true, fake_code: true } satisfies Shape,
  // 32.14 §3 (DELTA-12): Sign in with Google — the provider's authorization URL and the state the callback must echo; never the nonce, the code verifier, a token or a client secret
  oidc_start: { authorization_url: true, state: true, expires_at: true, delivery: true } satisfies Shape,
  passkey_options: { challenge_id: true, challenge: true, rp: { id: true, name: true }, user: { id: true, name: true, display_name: true }, pub_key_cred_params: [{ type: true, alg: true }], allow_credentials: [{ type: true, id: true, transports: true }], timeout_ms: true, attestation: true, expires_at: true } satisfies Shape,
  passkey_registered: { passkey_id: true, credential_id: true, algorithm: true, attestation_verified: true, created_at: true } satisfies Shape,
  level: { level: true, session_id: true } satisfies Shape,
  identity_session: { vendor: true, vendor_session_id: true, client_secret: true, return_url: true, card_instance_id: true, application_id: true, status: true, delivery: true } satisfies Shape,
  identity_webhook: { received: true, vendor: true, vendor_session_id: true, outcome: true, level: true, application_id: true, prefilled: true, all_borrowers_verified: true, gate_open: true } satisfies Shape,
  document_uploaded: { document_id: true, application_id: true, status: true, integrity_status: true, quarantined: true, quarantine_reason: true, duplicate_of: true, matched_request_ids: true, received_at: true, doc_class: true, byte_size: true, sha256: true } satisfies Shape,
  document_link: { document_id: true, title: true, doc_class: true, mime_type: true, url: true, expires_at: true } satisfies Shape,
  deep_link: { token: true, target: { card_instance_id: true, document_id: true, route: true }, expires_at: true } satisfies Shape,
  record: RECORD,
  thread: { conversation_id: true, messages: [MESSAGE], pinned_card: CARD, next_after: true, has_more: true } satisfies Shape,
  history: { loan_id: true, view: true, rows: [HISTORY_ROW] } satisfies Shape,
  message_reply: { message: MESSAGE, reply: MESSAGE, routed_to: true, command_executed: true, command: true } satisfies Shape,
  card_resolved: { card: CARD, command: true, idempotent: true, result: "opaque", events: true } satisfies Shape,
  command_result: { command: true, subject: { application_id: true, loan_id: true }, result: "opaque", events: true, decision_id: true } satisfies Shape,
  error: { code: true, gate: true, copy_key: true, challenge_id: true, fake_code: true } satisfies Shape,   // challenge_id / fake_code: EMAIL_UNVERIFIED only (32.16 DELTA-29) — every other refusal carries {code, gate?, copy_key} and nothing else
  // 32.3: the in-app voice session (E1 "a call to the published number"; the disclosure is spoken first) and the FAKE payroll connector (R3)
  voice_session: { session_id: true, channel: true, vendor: true, started_at: true, first_message: MESSAGE } satisfies Shape,
  connect_session: { vendor: true, vendor_session_id: true, link_token: true, card_instance_id: true, application_id: true, status: true, delivery: true } satisfies Shape,
  connect_webhook: { received: true, vendor: true, vendor_session_id: true, outcome: true, application_id: true, verification_id: true, report_reference_id: true, events: true } satisfies Shape,
  // 32.14 §4: the telephony vendor's inbound webhooks (SMS and voice entry on the same lead) — what went out to the number (copy keys and rendered lines), never a session token, never the number itself
  sms_webhook: { received: true, vendor: true, channel: true, lead_id: true, step: true, outbound: [{ copy_key: true, text: true, message_id: true }], events: true, session_opened: true, level: true, fake_code: true, refused: { code: true, gate: true, copy_key: true } } satisfies Shape,
  talk_turn: { lead_id: true, agent: true, model: true, transcript: [{ role: true, text: true, copy_key: true, at: true }], lines: [{ role: true, text: true, copy_key: true, at: true }], step: true, session_opened: true, level: true, token: true, lead_token: true, fake_code: true } satisfies Shape,   // talk.ts: `token` and `lead_token` leave once and the proxy turns them into cookies
  voice_webhook: { received: true, vendor: true, channel: true, call_id: true, lead_id: true, step: true, say: [{ copy_key: true, text: true }], texted: [{ copy_key: true, text: true, message_id: true }], events: true, session_opened: true, level: true, fake_code: true, refused: { code: true, gate: true, copy_key: true } } satisfies Shape,
} as const;
export type ShapeName = keyof typeof SHAPES;

/** Names that no shape may ever carry: the restricted / internal columns 02 §6 and 13 §3 T-X-03 name, plus the demographic fields. */
export const FORBIDDEN_FIELDS: readonly string[] = [
  "ethnicity", "race", "sex", "age", "declined_ethnicity", "declined_race", "declined_sex", "visual_observation_used", "collection_channel",
  "risk_assessment", "risk_score", "du_findings", "findings", "interpretation", "recommendation_code", "credit_score", "scores", "tradelines", "inquiries", "public_records", "report_xml", "report_json", "raw_report",
  "fraud_score", "fraud_flags", "fraud_hold", "fraud_hold_record", "red_flags", "sar_candidate", "qc_hold", "qc_finding", "qc_defect", "compliance_result", "test_results", "verdict",
  "tin_encrypted", "tin", "ssn", "date_of_birth_full", "account_number", "routing_number", "token_hash", "code_hash",
  // 32.14 DELTA-12: an id token and a PKCE verifier (or its hash) never leave the API (the OAuth client secret is never on any response object; `client_secret` stays a Stripe Identity session's ephemeral field)
  "id_token", "code_verifier", "code_verifier_hash",
  // 32.3 T12 / T19: DU findings and validation-report internals never reach a client payload
  "close_by_date", "validation_results", "value_acceptance_offer", "mi_requirement", "risk_factors", "findings_hash", "du_release", "du_release_applied", "policy_outcome", "policy_generation", "decline_candidate", "dti_du", "ltv_du", "reserves_required_cents", "request_hash",
];

export function fieldsOf(shape: Shape, into = new Set<string>()): Set<string> {
  for (const [k, v] of Object.entries(shape)) { into.add(k); if (v !== true && v !== "opaque") fieldsOf(Array.isArray(v) ? (v as unknown as readonly [Shape])[0] : (v as Shape), into); }
  return into;
}
const FORBIDDEN = new Set(FORBIDDEN_FIELDS);
/** 32.13 / 01 §3.19: a DemographicsCard's prompt lists (`ethnicity`, `race`, `sex` as `[{id, label}]` options) are the questions, not an applicant's answers — they travel as `<key>_options`; the answer-shaped keys never do. */
const DEMOGRAPHIC_PROMPTS = new Set(["ethnicity", "race", "sex"]);
const isOptionList = (x: unknown): boolean => Array.isArray(x) && x.length > 0 && x.every((o) => !!o && typeof o === "object" && typeof (o as Record<string, unknown>)["id"] === "string" && typeof (o as Record<string, unknown>)["label"] === "string");
/** A UI-owned free-form value: copied with bigints as strings and every forbidden key dropped at any depth (the allow-list's guarantee holds inside opaque values too). */
export function opaque(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(opaque);
  if (v && typeof v === "object") { const out: Record<string, unknown> = {}; for (const [k, x] of Object.entries(v as Record<string, unknown>)) { if (!FORBIDDEN.has(k)) out[k] = opaque(x); else if (DEMOGRAPHIC_PROMPTS.has(k) && isOptionList(x)) out[`${k}_options`] = opaque(x); } return out; }
  return v === undefined ? null : v;
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
    if (rule === "opaque") { out[k] = v === null || v === undefined ? null : opaque(v); continue; }
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
