/**
 * Copy keys for borrower-facing refusals (docs/ux/02-data-contracts.md §7: errors carry `{code, gate?, copy_key}` and
 * the UI renders `copy_key` from 12-message-copy-library — never the handler's reason text). Keyed by the gate code a
 * refusal names (02 §2's gate column) or by the API's own error code; anything unlisted renders `error.generic`.
 * The strings themselves live in docs/ux/12-message-copy-library.md (the `gate.*` / `auth.*` keys below are to be authored there).
 */
export const DEFAULT_COPY_KEY = "error.generic";

/** Gate code → copy key. The five 02 §2 names first; the rest are the gates 02 §2 lists for commands this surface will issue. */
export const GATE_COPY_KEYS: Readonly<Record<string, string>> = {
  SM_IDENTITY_IAL2_GATE: "gate.identity.verify_first",                 // "Verify your ID first — it takes about a minute."
  REGZ_1026_19E2_INTENT_FEE_GATE: "gate.intent.before_fees",           // "Tell us you'd like to proceed before we charge anything."
  SM_O21_JOINT_INTENT_GATE: "gate.joint_intent.each_borrower",         // "Each borrower confirms they're applying together first."
  SM_QUOTE_VALIDITY_GATE: "gate.quote.expired",                        // "That quote has expired. Here are today's numbers."
  SM_O61_COMPLIANCE_PASS_LOCK_GATE: "gate.lock.compliance_pending",    // "We're finishing a check before your rate can lock."
  FCRA_1681B_A3_SOFT_PULL_PURPOSE_GATE: "gate.credit.authorize_first",
  SM_O72_RON_STATE_AUTH_GATE: "gate.closing.ron_unavailable",
  SM_O72_ESIGN_CONSENT_CLOSING_GATE: "gate.closing.esign_consent",
  ESIGN_7001C_CONSENT_GATE: "gate.esign.consent_first",
  REGB_1002_9_COUNTEROFFER_90: "gate.counteroffer.window",
  REGX_1024_41E1_ACCEPT_14: "gate.lossmit.accept_window",
  FNMA_B4_1_3_12_ROV_CLOSING_GATE: "gate.rov.too_late",
};

/** API error code → copy key (auth, scoping, links, uploads). */
export const ERROR_COPY_KEYS: Readonly<Record<string, string>> = {
  AUTH_REQUIRED: "auth.sign_in",                     // "Sign in with a code to continue."
  SESSION_EXPIRED: "auth.session_expired",           // "You were signed out after a while away. Sign in again."
  LEVEL_REQUIRED: "auth.step_up",                    // "One more check before we show that."
  FRESH_L1_REQUIRED: "auth.fresh_code",              // "For payments we ask for a fresh code. We just sent one."
  OTP_INVALID: "auth.code_wrong",                    // "That code didn't match. Try again."
  OTP_EXPIRED: "auth.code_expired",                  // "That code expired. We can send a new one."
  OTP_TOO_MANY_ATTEMPTS: "auth.code_locked",
  PASSKEY_INVALID: "auth.passkey_failed",
  L2_MATCH_FAILED: "auth.identity_match_failed",     // "Those details didn't match what we have. Try again or talk to a person."
  PARTY_SCOPE: "error.not_yours",                    // "That isn't on your account."
  DEEP_LINK_EXPIRED: "deeplink.expired",             // "That link has expired. Sign in and we'll take you there."
  DEEP_LINK_UNKNOWN: "deeplink.unknown",
  DOCUMENT_NOT_VISIBLE: "documents.not_available",
  DOCUMENT_CONTENT_UNAVAILABLE: "documents.not_available",
  IDENTITY_NO_APPLICATION: "identity.no_application",
  IDENTITY_SESSION_UNKNOWN: "identity.session_unknown",
  BAD_REQUEST: DEFAULT_COPY_KEY,
  NOT_FOUND: DEFAULT_COPY_KEY,
  AI_OFF: "error.human_takes_over",
  FRAUD_HOLD: DEFAULT_COPY_KEY,
};

export function copyKeyFor(code: string, gate?: string): string {
  if (gate && GATE_COPY_KEYS[gate]) return GATE_COPY_KEYS[gate]!;
  if (GATE_COPY_KEYS[code]) return GATE_COPY_KEYS[code]!;
  return ERROR_COPY_KEYS[code] ?? DEFAULT_COPY_KEY;
}
