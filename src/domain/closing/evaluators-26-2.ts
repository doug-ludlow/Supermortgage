/**
 * §26.2 gate evaluators, keyed "26.2.<name>". Every key must be named by an `evaluator:` override in
 * timers-26-2.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 * Facts are `closingGateFacts(closing, session, enote, consent, eligibility, ron)` from ops-26-2.ts.
 */
import { ok, no, b, s, arr, type Evaluator } from "../../app/evaluator-kit.ts";
import { enoteLocationGate, securedPartyGate, esignConsentCheck, ronStateAuthCheck, agentEclosingEligible, auditTrailGate, type ClosingEsignConsent, type EclosingEligibility, type ClosingTypeInput, type ClosingTypeSigner, type CounselConfirmation } from "./ops-26-2.ts";
import type { ClosingType } from "./ops-26-1.ts";

const str = (f: Record<string, unknown>, k: string): string | null => (typeof f[k] === "string" ? (f[k] as string) : null);
const obj = <T>(f: Record<string, unknown>, k: string): T | null => (f[k] && typeof f[k] === "object" ? (f[k] as T) : null);

export const EVALUATORS_26_2: Record<string, Evaluator> = {
  /** SM_O72_ENOTE_LOCATION_GATE: Authoritative Copy present in the Location eVault with its hash equal to the platform seal (validated against the eRegistry hash). */
  "26.2.enoteLocationGate": (f) => { const r = enoteLocationGate({ tamper_seal_hash: str(f, "tamper_seal_hash"), evault_copy_hash: str(f, "evault_copy_hash"), evault_status: (str(f, "evault_status") as "intact" | "tampered" | "missing" | null) ?? null }); return r.open ? ok : no(r.reason!); },
  /** SM_O72_SECURED_PARTY_BEFORE_ADVANCE_GATE: Change Data naming SM's Org ID as Secured Party accepted before any warehouse advance on an eNote loan (27.1). */
  "26.2.securedPartyGate": (f) => { const r = securedPartyGate({ note_form: (str(f, "note_form") as "enote" | "paper" | null) ?? "enote", secured_party_org_id: str(f, "secured_party_org_id"), registration_status: str(f, "registration_status") }); return r.open ? ok : no(r.reason!); },
  /** SM_O72_ESIGN_CONSENT_CLOSING_GATE (E-SIGN §101(c)): valid, unwithdrawn consent covering the closing package with the hardware/software demonstration and the paper option on record. */
  "26.2.esignConsentGate": (f) => { const r = esignConsentCheck(obj<ClosingEsignConsent>(f, "consent"), (str(f, "closing_type") as ClosingType | null) ?? "ron", str(f, "now") ?? "9999-12-31T00:00:00Z"); return r.open ? ok : no(r.reason!); },
  /** SM_O72_RON_STATE_AUTH_GATE (A2-4.1-03 RON section): state on Fannie Mae's list or counsel-confirmed; county recorder, title underwriter, agent/provider, consent, identity proofing, notary in the state; never TX 50(a)(6). */
  "26.2.ronStateAuthGate": (f) => {
    const agent = obj<EclosingEligibility>(f, "agent") ?? (arr<EclosingEligibility>(f, "eligibility").find((e) => e.settlement_agent_party_id === s(f, "settlement_agent_party_id")) ?? null);
    const i: ClosingTypeInput = { state: s(f, "state"), county_fips: str(f, "county_fips"), tx_50a6: b(f, "tx_50a6"), enote_eligible: b(f, "enote_eligible"), proposed_closing_type: (str(f, "closing_type") as ClosingType | null) ?? "ron", borrower_election: null, signers: arr<ClosingTypeSigner>(f, "signers"),
      county_accepts_ron_instruments: b(f, "county_accepts_ron_instruments"), title_no_ron_exception: b(f, "title_no_ron_exception"), agent, ron_provider_available: b(f, "ron_provider_available"), notary: obj<{ commission_state: string; physical_location_state: string }>(f, "notary"), counsel_confirmation: obj<CounselConfirmation>(f, "counsel_confirmation"), in_person_enotarization_valid: b(f, "in_person_enotarization_valid") };
    const r = ronStateAuthCheck(i); return r.eligible ? ok : no(`RON refused: ${r.refusals.join(", ")} — IPEN/hybrid/wet offered`);
  },
  /** SM_O72_AGENT_ECLOSING_ELIGIBLE_GATE: an `eclosing_eligibility` row for the settlement agent/county matching the closing type. */
  "26.2.agentEclosingEligibleGate": (f) => { const r = agentEclosingEligible(arr<EclosingEligibility>(f, "eligibility"), s(f, "settlement_agent_party_id"), str(f, "county_fips"), (str(f, "closing_type") as ClosingType | null) ?? "ron"); return r.eligible ? ok : no(`${r.reason} — closing type downgraded to ${r.downgrade_to}`); },
  /** SM_O72_AUDIT_TRAIL_BEFORE_FUNDING_GATE: tamper-sealed audit trail received and hash-verified; recording reference and retention custodian recorded; `funding.authorize` (26.3) refused otherwise. */
  "26.2.auditTrailBeforeFundingGate": (f) => { const r = auditTrailGate({ closing_type: (str(f, "closing_type") as ClosingType | null) ?? "ron", audit_trail_received_at: str(f, "audit_trail_received_at"), audit_trail_hash: str(f, "audit_trail_hash"), platform_hash: str(f, "platform_hash"), recording_ref: str(f, "recording_ref"), recording_custodian: str(f, "recording_custodian") }); return r.open ? ok : no(r.reason!); },
};
