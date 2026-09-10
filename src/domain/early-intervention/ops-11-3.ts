/**
 * §11.3 QRPC — the three registry gates this process arms on its own events, evaluated at the command boundary
 * (src/app/tools/section11.ts calls these from `identity.verify`, `authorization.record`, `lossmit_facts.get` and
 * `qrpc.capture`) and appended to the event store with the facts the evaluators (src/app/evaluators.ts "11.3.*")
 * were computed from:
 *   - `SM_THIRD_PARTY_AUTH_GATE`         trigger `contact.started{party_role∈{trusted_advisor, authorized_third_party}}`,
 *                                        evaluator 11.3.thirdPartyAuthorized — "valid unexpired authorization or in-call
 *                                        recorded consent"; breach "NPI withheld; general information only" (11.3-T5/T6);
 *   - `SM_LICENSED_NEGOTIATION_GATE`     trigger `contact.modification_terms.discussed`, evaluator 11.3.licensedNegotiator —
 *                                        "`jurisdiction_rules.mlo_licensing_for_lossmit=false` or `licensed_specialist` on
 *                                        the call"; breach "AI declines to negotiate; warm transfer" (11.3-T10);
 *   - `FNMA_LL202605_QRPC_REASON_REQUIRED` trigger `investor_events.building{family=qrpc}`, evaluator 11.3.qrpcReasonPresent —
 *                                        "QRPC action event build (5.7): reason type present"; breach "event refused at
 *                                        build; `default-collections` supplies `declined` or `unable_to_contact`" (rule 7, T11).
 */
import type { PlainDate } from "../../kernel/calendar/date.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { thirdPartyCall, licensedNegotiationGate, disasterReasonType } from "./ops.ts";
import { reasonCode } from "./qrpc.ts";

export interface GateContext { readonly events: EventStore; readonly actor: Actor; readonly now: string; readonly loanId?: string | undefined; }

export const THIRD_PARTY_AUTH_GATE = "SM_THIRD_PARTY_AUTH_GATE";
export const LICENSED_NEGOTIATION_GATE = "SM_LICENSED_NEGOTIATION_GATE";
export const QRPC_REASON_REQUIRED = "FNMA_LL202605_QRPC_REASON_REQUIRED";
export const QRPC_ACTION_TYPE = "Quality Right Party Contact";
/** The party roles the 11.3 trigger names: a caller who is not the borrower/co-borrower/successor. */
export const THIRD_PARTY_ROLES = new Set(["trusted_advisor", "authorized_third_party"]);

// ---- LL-2026-05 Delinquency Reason Type (event rail) -------------------------------------------
/**
 * 11.3 rule 2 (`rule_sets.fnma.qrpc.reason_map.v1`): the event-rail reason type for a Form 710 reason. The four names the
 * spec verified — "Borrower Declined to Provide a Reason", "Disaster Impact – FEMA-declared IA area", "Casualty Loss",
 * "Property Problem" — are exact; the others carry the F-1-21 legacy descriptions until the CIT schema is received
 * (spec: "LL-2026-05 reason-type names added when the CIT schema is received — [PARTIALLY VERIFIED names]").
 */
export const REASON_TYPE_MAP: Record<string, string> = {
  unemployment: "Unemployment", reduction_in_income: "Curtailment of Income", increase_in_expenses: "Excessive Obligations", excessive_obligations: "Excessive Obligations",
  death_of_borrower: "Death of Borrower", death_of_borrower_or_wage_earner: "Death of Borrower", death_of_family_member: "Death of Family Member",
  disability_or_illness: "Illness of Borrower", disability_or_illness_borrower: "Illness of Borrower", disability_or_illness_family: "Illness of Family Member",
  divorce_or_separation: "Marital Difficulties", separation_unmarried: "Marital Difficulties", distant_employment_transfer: "Distant Employment Transfer", business_failure: "Business Failure",
  property_problem: "Property Problem", inability_to_sell: "Inability to Sell Property", inability_to_sell_or_rent: "Inability to Sell Property", inability_to_rent: "Inability to Rent Property",
  military_service: "Military Service", incarceration: "Incarceration", payment_dispute: "Payment Dispute", servicing_problem: "Servicing Problems", other: "Other",
  declined: "Borrower Declined to Provide a Reason",
};
/** 5.7 fatal rule: Property Problem / Disaster Impact / Casualty Loss are mutually exclusive; "Borrower Declined" cannot pair. */
export const DISASTER_REASON_TYPES: readonly string[] = ["Disaster Impact – FEMA-declared IA area", "Casualty Loss"];

/**
 * The reason type for the QRPC action event: an explicit one wins; a disaster reason resolves through the FEMA IA fact
 * (rule 2: "Disaster Impact – FEMA-declared IA area" when the property is in a declared IA county, else "Casualty Loss";
 * never also "Property Problem" — 11.3-T11); anything outside the taxonomy has none (the build then refuses).
 */
export function qrpcReasonType(reasonPrimary: string | null | undefined, o: { explicit?: string | null; fema_ia_county?: boolean } = {}): string | null {
  if (o.explicit) return o.explicit;
  if (!reasonPrimary) return null;
  if (reasonPrimary === "disaster" || reasonPrimary === "disaster_casualty" || reasonPrimary === "disaster_property_problem") return disasterReasonType({ fema_ia_county: o.fema_ia_county === true }).reason_type;
  return REASON_TYPE_MAP[reasonPrimary] ?? null;
}

export interface QrpcInvestorEventInput {
  readonly loan_id: string; readonly qrpc_id: string; readonly contact_id?: string | null;
  readonly reason_primary: string | null; readonly reason_type?: string | null; readonly reason_code?: string | null;
  readonly fema_ia_county?: boolean;
  /** The QRPC date — legacy AW "effective date = QRPC date" (F-1-21). */
  readonly achieved_on: string;
}
export interface QrpcInvestorEventResult {
  readonly built: boolean; readonly refused_by: string | null; readonly reason: string | null;
  readonly action: typeof QRPC_ACTION_TYPE; readonly legacy_status_code: "AW"; readonly reason_code: string | null; readonly reason_type: string | null; readonly reason_types: readonly string[];
  /** Breach action: the reasons `default-collections` may supply when the build is refused (rule 2: declined → 015; no QRPC at all → 031 unable to contact, set by 5.7). */
  readonly fallback: { readonly declined: string; readonly unable_to_contact: string } | null;
  readonly events: readonly DomainEvent[];
}
/**
 * Rule 7 / `FNMA_LL202605_QRPC_REASON_REQUIRED`: build the 5.7 investor event for an established QRPC — legacy AW (effective
 * the QRPC date, reason code) + event-rail "Quality Right Party Contact" with its Delinquency Reason Type. Appends
 * `investor_events.building{family=qrpc, reason_type}` (the gate's trigger), evaluates the gate, and either appends
 * `delinquency.servicer_action{Quality Right Party Contact}` or refuses the build with `investor_events.refused`.
 */
export function buildQrpcInvestorEvent(ctx: GateContext, i: QrpcInvestorEventInput): QrpcInvestorEventResult {
  if (!i.loan_id || !i.qrpc_id || !i.achieved_on) throw new RangeError("loan_id, qrpc_id and achieved_on are required");
  const reasonType = qrpcReasonType(i.reason_primary, { explicit: i.reason_type ?? null, ...(i.fema_ia_county !== undefined ? { fema_ia_county: i.fema_ia_county } : {}) });
  const code = i.reason_code ?? (i.reason_primary ? reasonCode(i.reason_primary) : null);
  const events: DomainEvent[] = [];
  const loanId = i.loan_id;
  events.push(ctx.events.append({ type: "investor_events.building", loanId, actor: ctx.actor, payload: { family: "qrpc", action: QRPC_ACTION_TYPE, loan_id: loanId, qrpc_id: i.qrpc_id, contact_id: i.contact_id ?? null, reason_primary: i.reason_primary, reason_code: code, reason_type: reasonType, gate: QRPC_REASON_REQUIRED } }));
  const g = evaluateGate("11.3.qrpcReasonPresent", { reason_type: reasonType ?? "" });
  const base = { action: QRPC_ACTION_TYPE, legacy_status_code: "AW", reason_code: code } as const;
  if (!g.open) {
    const fallback = { declined: REASON_TYPE_MAP.declined!, unable_to_contact: "Unable to Contact Borrower" };
    events.push(ctx.events.append({ type: "investor_events.refused", loanId, actor: ctx.actor, payload: { family: "qrpc", action: QRPC_ACTION_TYPE, qrpc_id: i.qrpc_id, code: QRPC_REASON_REQUIRED, reason: g.reason ?? QRPC_REASON_REQUIRED, reason_primary: i.reason_primary, supplied_by: "default-collections", fallback } }));
    return { built: false, refused_by: QRPC_REASON_REQUIRED, reason: g.reason ?? QRPC_REASON_REQUIRED, ...base, reason_type: null, reason_types: [], fallback, events };
  }
  const reasonTypes = [reasonType as string];
  events.push(ctx.events.append({ type: "delinquency.servicer_action", loanId, actor: ctx.actor, payload: { ...base, family: "qrpc", qrpc_id: i.qrpc_id, effective_on: i.achieved_on, reason_type: reasonType, reason_types: reasonTypes, exclusive_with: DISASTER_REASON_TYPES.includes(reasonType as string) ? ["Property Problem"] : [] } }));
  return { built: true, refused_by: null, reason: null, ...base, reason_type: reasonType, reason_types: reasonTypes, fallback: null, events };
}

// ---- SM_THIRD_PARTY_AUTH_GATE ----------------------------------------------------------------
export interface ThirdPartyConversationInput {
  readonly loan_id: string; readonly contact_id?: string | null;
  readonly party_role: "trusted_advisor" | "authorized_third_party";
  readonly claimed_relation?: string | null;
  /** The authorization on file for the party (`parties.authorization_*` / `party_authorizations`), if any. */
  readonly authorization?: { readonly id: string; readonly scope?: string | null; readonly expires_on: PlainDate | null } | null;
  /** Recorded oral consent by the verified borrower on this call (rule 4: a three-way call). */
  readonly in_call_consent_recorded?: boolean;
  readonly on: PlainDate;
}
export interface ThirdPartyConversationResult {
  readonly gate: typeof THIRD_PARTY_AUTH_GATE; readonly open: boolean; readonly reason: string | null;
  readonly authorization_valid_unexpired: boolean; readonly in_call_consent_recorded: boolean;
  readonly disclose_account_details: boolean; readonly npi_withheld: boolean; readonly general_information_only: boolean;
  readonly offer: "FRM_SM_THIRD_PARTY_AUTH" | null; readonly qrpc_recorded_allowed: boolean; readonly outcome: "answered_unverified_third_party" | "authorized_third_party";
  readonly event: DomainEvent;
}
/**
 * A conversation with a trusted advisor / third party: appends `contact.started{party_role, authorization_valid_unexpired,
 * in_call_consent_recorded}` (the gate's trigger) and evaluates 11.3.thirdPartyAuthorized. Closed → NPI withheld, general
 * information and the authorization form only, no QRPC (T5); open → the party may complete QRPC on the borrower's behalf (T6).
 */
export function thirdPartyConversation(ctx: GateContext, i: ThirdPartyConversationInput): ThirdPartyConversationResult {
  if (!i.loan_id || !i.on) throw new RangeError("loan_id and on are required");
  if (!THIRD_PARTY_ROLES.has(i.party_role)) throw new RangeError(`party_role ${i.party_role} is not a third party`);
  const auth = i.authorization ?? null;
  const validUnexpired = auth !== null && (auth.expires_on === null || auth.expires_on >= i.on);
  const consent = i.in_call_consent_recorded === true;
  const g = evaluateGate("11.3.thirdPartyAuthorized", { authorization_valid_unexpired: validUnexpired, in_call_consent_recorded: consent });
  const event = ctx.events.append({ type: "contact.started", loanId: i.loan_id, actor: ctx.actor, payload: { loan_id: i.loan_id, contact_id: i.contact_id ?? null, party_role: i.party_role, claimed_relation: i.claimed_relation ?? null, authorization_id: auth?.id ?? null, authorization_scope: auth?.scope ?? null, authorization_valid_unexpired: validUnexpired, in_call_consent_recorded: consent, gate: THIRD_PARTY_AUTH_GATE, open: g.open, on: i.on } });
  const tp = thirdPartyCall({ claimed_relation: i.claimed_relation ?? i.party_role, authorization_valid: g.open });
  return { gate: THIRD_PARTY_AUTH_GATE, open: g.open, reason: g.open ? null : g.reason ?? THIRD_PARTY_AUTH_GATE, authorization_valid_unexpired: validUnexpired, in_call_consent_recorded: consent, ...tp, npi_withheld: !g.open, general_information_only: !g.open, event };
}

// ---- SM_LICENSED_NEGOTIATION_GATE ------------------------------------------------------------
export interface ModificationTermsInput {
  readonly loan_id: string; readonly contact_id?: string | null; readonly question: string;
  /** `jurisdiction_rules.mlo_licensing_for_lossmit` for the property state (00a §5.1 counsel matrix). */
  readonly mlo_licensing_for_lossmit: boolean; readonly licensed_specialist_on_call?: boolean; readonly state?: string | null;
}
export interface ModificationTermsResult {
  readonly gate: typeof LICENSED_NEGOTIATION_GATE; readonly asks_terms: boolean; readonly open: boolean; readonly reason: string | null;
  readonly decline_quote: boolean; readonly warm_transfer: "licensed_specialist" | null; readonly response: string; readonly terms_quoted: false;
  readonly events: readonly DomainEvent[];
}
/**
 * The borrower raises modification terms: appends `contact.modification_terms.discussed{mlo_licensing_for_lossmit,
 * licensed_specialist_on_call}` (the gate's trigger) and evaluates 11.3.licensedNegotiator. Closed → the AI declines to
 * quote and the warm transfer to `licensed_specialist` starts (`contact.human_transfer.started`); the response carries no
 * terms (T10). A question that does not ask for terms is not a discussion of terms — nothing is appended.
 */
export function modificationTermsDiscussed(ctx: GateContext, i: ModificationTermsInput): ModificationTermsResult {
  if (!i.loan_id || !i.question) throw new RangeError("loan_id and question are required");
  const specialist = i.licensed_specialist_on_call === true;
  const lg = licensedNegotiationGate({ question: i.question, mlo_licensing_for_lossmit: i.mlo_licensing_for_lossmit, licensed_specialist_on_call: specialist });
  if (!lg.asks_terms) return { gate: LICENSED_NEGOTIATION_GATE, asks_terms: false, open: true, reason: null, decline_quote: false, warm_transfer: null, response: lg.response, terms_quoted: false, events: [] };
  const g = evaluateGate("11.3.licensedNegotiator", { mlo_licensing_for_lossmit: i.mlo_licensing_for_lossmit, licensed_specialist_on_call: specialist });
  const events: DomainEvent[] = [];
  events.push(ctx.events.append({ type: "contact.modification_terms.discussed", loanId: i.loan_id, actor: ctx.actor, payload: { loan_id: i.loan_id, contact_id: i.contact_id ?? null, question: i.question, asks_terms: true, state: i.state ?? null, mlo_licensing_for_lossmit: i.mlo_licensing_for_lossmit, licensed_specialist_on_call: specialist, gate: LICENSED_NEGOTIATION_GATE, open: g.open, terms_quoted: false } }));
  const decline = !g.open;
  if (decline) events.push(ctx.events.append({ type: "contact.human_transfer.started", loanId: i.loan_id, actor: ctx.actor, payload: { reason: LICENSED_NEGOTIATION_GATE, target: "licensed_specialist", start_within_s: 10, contact_id: i.contact_id ?? null, question: i.question } }));
  return { gate: LICENSED_NEGOTIATION_GATE, asks_terms: true, open: g.open, reason: g.open ? null : g.reason ?? LICENSED_NEGOTIATION_GATE, decline_quote: decline, warm_transfer: decline ? "licensed_specialist" : null, response: decline ? lg.response : "Let me explain the options that may be available and how to apply.", terms_quoted: false, events };
}
