/**
 * §26.4 Post-closing document collection, collateral perfection and trailing documents — pure rule functions, one per
 * rule / T-id, plus the event emitters the 26.4 timers arm on and are satisfied by (the `post-closing` agent runtime).
 * spec/sections/26-closing-execution-documents-eclosing-ron-funding-and-post-cl/26-4-post-closing-document-collection-collateral-perfection-and-t.md
 *
 *   computeMersAnchor          rule 1: anchor_kind (note_date | funding_date | assignment_executed_date), registration_due_at (+7 calendar days),
 *                              policy_target_at (note_date + 7), the next 18:00 local batch (SM_O74_MOM_REGISTER_TARGET_1BD)
 *   validateRegistration       rule 1 guards: MIN component 1 = partner Org ID + check digit; Servicer = partner (never SM); Investor = partner
 *                              before purchase (Fannie Mae after); Subservicer = SM; MOM instrument or Maine 3749; MERS Rider in MT/OR/WA
 *   registerMin / preCloseRegisterMin / updateMinInterimFunder / reverseMin / deactivateMin   MERS System batch transactions over the shared
 *                              MersPort (src/infra/integrations/mers.ts) → mers.min.registered{status=active, registration_kind, interim_funder_org_id}
 *                              (30.2 / 27.1 / 29.3 consume), mers.min.registration_rejected{codes}, mers.min.updated{field=interim_funder},
 *                              mers.min.reversed, mers.min.deactivated{reason}
 *   ensureEndorsement          rule 2 / SM_O74_ENDORSEMENT_BEFORE_SHIP_GATE: printed facsimile with the four-document B8-3-04 file for the state, or
 *                              a pre-executed allonge affixed with identifiers matching the note; else the endorsement desk; never SM / Fannie Mae
 *   decideAssignments          rule 3: MOM everywhere (no assignment of any kind); Maine Form 3749 → non_mom_assignment + recorded_assignment_to_mers
 *   shipmentPlan / prepareShipment / trackShipment / ingestTrustReceipt / openTrace / handleLostNote / decideLostNote   rule 4 / 5
 *   expectTrailingDocuments / trailingDueAt / receiveTrailingDocument / closeTrailingDocument / waiveTrailingDocument / followUp / sweepTrailingDocuments
 *   ingestRecordedImage / reviewRecordedInstrument / requestRerecording          rule 6
 *   ingestFinalPolicy / reviewFinalPolicy / requestPolicyCorrection              rule 7 (B7-2-03)
 *   recordCustodianException / cureCustodianException / custodyCertifiable      rule 2 (RDC §8) + 27.1's collateral defect
 *   dailyEnoteHashCheck / reconcileEregistry / reconcileMersSystem              rules 9 / 11
 *   voidCollateral / submitMinReversal                                          rule 10 (SM_O74_MIN_REVERSAL_2BD)
 *
 * Every event carries `applicationId` and payload.application_id (origination context — src/kernel/timers/engine.ts
 * isOriginationContext) and a local-date anchor field (`*_on`) next to each instant so business-day clocks anchor on the
 * property-local day, never on a UTC roll-over. Upstream events consumed, never re-emitted: `closing.consummated` /
 * `custody.paper_note.shipped` / `recording.submitted` / `recording.confirmed` (26.2), `loan.funded` (26.3),
 * `warehouse.advance.funded` (27.1), `rescission.exercised` (25.3), `funding.cancelled` (26.3). 27.1-owned event names reused
 * with 27.1's payload shape: `warehouse.note.received`, `warehouse.collateral.defect_recorded{cure_owner}` / `.defect_cured`.
 */
import { type PlainDate, addDays, daysBetween, plainDate as D } from "../../kernel/calendar/date.ts";
import { addBusinessDays, rollForward, creditor, servicer } from "../../kernel/calendar/business.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { type MersPort, type MersTxn, type MersTxnResult, FANNIE_MAE_ORG_ID, minCheckDigitOk } from "../../infra/integrations/mers.ts";
import { SUPERMORTGAGE_ORG_ID } from "../transfers/inbound.ts";
import { FACILITY_FIXTURE, wetNoteDeadline, type FacilityTerms } from "../warehouse/ops-27-1.ts";

export const POST_CLOSING_AGENT: Actor = { kind: "agent", id: "post-closing" };
export const SM_ORG_ID = SUPERMORTGAGE_ORG_ID;
export { FANNIE_MAE_ORG_ID };
export const RULE_SETS = { fnma: "fnma.selling.2026-09-02", rdc: "fnma.rdc.15.0", mers: "mers.proc.26.1", eregistry: "mers.eregistry.16.25", policy: "sm.postclosing.v1", warehouse: "sm.warehouse.v1" } as const;
export const POLICY_VERSION = RULE_SETS.policy;
/** MERS Procedures Rel. 26.1: MOM registration ≤ 7 calendar days after the anchor; the daily batch closes 18:00 local. */
export const MERS_REGISTRATION_DAYS = 7;
export const BATCH_CUTOFF_HOUR = 18;
/** MERS Rider (Form 3158) states — B8-7-01. */
export const MERS_RIDER_STATES: readonly string[] = ["MT", "OR", "WA"];
/** Maine: MERS Mortgage Assignment (Form 3749) — the only non-MOM path in scope (B8-7-01). */
export const NON_MOM_STATES: readonly string[] = ["ME"];
export const TRAILING_FOLLOWUP_DAYS = 30, TRAILING_ESCALATE_DAYS = 120, TRAILING_CERTIFIED_COPY_DAYS = 180;
export const FINAL_POLICY_DAYS = 60, RECORDED_SI_ERECORD_BD = 5, RECORDED_SI_PAPER_DAYS = 90, RERECORD_CURE_BD = 10, CUSTODIAN_EXCEPTION_CURE_BD = 5, LNA_DECISION_BD = 5, NOTE_TRANSIT_BD = 3, LOST_NOTE_TRANSIT_BD = 5, MIN_REVERSAL_BD = 2, MERS_VARIANCE_CURE_BD = 10;
/** B7-2-03: loans originated on/after Jan 1, 2024 need the 2021 ALTA Loan Policy. */
export const ALTA_2021_MANDATORY_FROM = D("2024-01-01");

export class PostClosingRefused extends Error { readonly code: string; readonly citation: string; constructor(code: string, citation: string, why: string) { super(`${code}: ${why}`); this.name = "PostClosingRefused"; this.code = code; this.citation = citation; } }
const nonEmpty = (v: unknown, what: string): string => { if (typeof v !== "string" || !v.trim()) throw new RangeError(`${what} is required`); return v; };

// ---- shared helpers -------------------------------------------------------------------------------------------------
export interface Keys { readonly application_id: string; readonly loan_id?: string | null; }
/** Append an event with origination context (applicationId + payload.application_id) and the loan id once 30.2 has created it. */
export function emit(events: EventStore, k: Keys, type: string, payload: Record<string, unknown>, at?: string | null, actor: Actor = POST_CLOSING_AGENT): DomainEvent {
  return events.append({ type, applicationId: k.application_id, ...(k.loan_id ? { loanId: k.loan_id } : {}), actor, ...(at ? { occurredAt: at } : {}), payload: { application_id: k.application_id, ...(k.loan_id ? { loan_id: k.loan_id } : {}), ...payload } });
}
export const localDate = (iso: string, tz: string): PlainDate => wallClock(Date.parse(iso), tz).date;
/** The 18:00-local daily MERS batch an instant lands in: same day before the cutoff, else the next creditor business day (Sat/Sun and holidays: no batch). */
export function nextBatchOn(atIso: string, tz: string): PlainDate {
  const w = wallClock(Date.parse(atIso), tz);
  const d = w.hour >= BATCH_CUTOFF_HOUR ? addDays(w.date, 1) : w.date;
  return rollForward(d, creditor);
}
export const batchRef = (batchOn: PlainDate, channel: MersChannel = "xml"): string => `MERS-${batchOn}-${channel}`;

// ============================================================ rule 1: MERS anchor (`computeMersAnchor`)
export type TransactionType = "purchase" | "refinance" | "limited_cash_out" | "cash_out" | "construction_to_permanent";
export type AnchorKind = "note_date" | "funding_date" | "assignment_executed_date";
export type RegistrationKind = "mom" | "non_mom_assignment";
export interface MersAnchorInput {
  readonly transaction_type: TransactionType; readonly state: string; readonly escrow_state: boolean; readonly note_date: PlainDate;
  readonly funding_date?: PlainDate | null; readonly assignment_executed_on?: PlainDate | null; readonly mom_available?: boolean; readonly consummation_at?: string | null; readonly time_zone?: string;
}
export interface MersAnchor {
  readonly registration_kind: RegistrationKind; readonly anchor_kind: AnchorKind; readonly anchor_date: PlainDate; readonly registration_due_at: PlainDate; readonly policy_target_at: PlainDate;
  /** SM_O74_MOM_REGISTER_TARGET_1BD: the next creditor business day after the note date (the 18:00 batch on the note date or the next). */
  readonly target_batch_on: PlainDate; readonly provisional: boolean; readonly rule: string;
}
/** MERS Procedures Rel. 26.1: note date for purchase loans outside escrow states; funding date for refinances or escrow-state loans; Non-MOM: the Assignment to MERS execution date. Funding unknown → provisional on the note date (recomputed on `loan.funded`, reporting only). */
export function computeMersAnchor(i: MersAnchorInput): MersAnchor {
  const nonMom = i.mom_available === false || NON_MOM_STATES.includes(i.state.toUpperCase());
  const policy_target_at = addDays(i.note_date, MERS_REGISTRATION_DAYS);
  const target_batch_on = addBusinessDays(i.note_date, 1, creditor);
  if (nonMom) {
    if (!i.assignment_executed_on) throw new RangeError(`non-MOM loan (${i.state}): assignment_executed_on (Form 3749) is required`);
    return { registration_kind: "non_mom_assignment", anchor_kind: "assignment_executed_date", anchor_date: i.assignment_executed_on, registration_due_at: addDays(i.assignment_executed_on, MERS_REGISTRATION_DAYS), policy_target_at, target_batch_on, provisional: false,
      rule: "MERS Procedures Rel. 26.1: a Non-MOM loan must be registered no later than seven (7) calendar days after the Assignment to MERS was executed" };
  }
  const useFunding = i.transaction_type !== "purchase" || i.escrow_state;
  if (!useFunding) return { registration_kind: "mom", anchor_kind: "note_date", anchor_date: i.note_date, registration_due_at: policy_target_at, policy_target_at, target_batch_on, provisional: false, rule: "MERS Procedures Rel. 26.1: seven (7) calendar days after the Note Date (purchase loan outside an escrow state)" };
  const anchor_date = i.funding_date ?? i.note_date;
  return { registration_kind: "mom", anchor_kind: "funding_date", anchor_date, registration_due_at: addDays(anchor_date, MERS_REGISTRATION_DAYS), policy_target_at, target_batch_on, provisional: !i.funding_date,
    rule: `MERS Procedures Rel. 26.1: seven (7) calendar days after the Funding Date (${i.transaction_type !== "purchase" ? "refinance loan" : "loan in an escrow state"})${i.funding_date ? "" : " — funding date not yet known; provisional on the note date"}` };
}
/** Registration timeliness against the anchor and the policy target (a rejection never extends the MERS deadline). */
export function registrationTimeliness(a: Pick<MersAnchor, "registration_due_at" | "policy_target_at" | "target_batch_on">, acceptedOn: PlainDate): { on_time: boolean; policy_target_met: boolean; target_batch_met: boolean; days_late: number } {
  return { on_time: acceptedOn <= a.registration_due_at, policy_target_met: acceptedOn <= a.policy_target_at, target_batch_met: acceptedOn <= a.target_batch_on, days_late: Math.max(0, daysBetween(a.registration_due_at, acceptedOn)) };
}

// ============================================================ rule 1: registration record and guards (`registerMin`)
export type MersChannel = "xml" | "flat_file" | "web";
export type RegistrationStatus = "reserved" | "pre_closing" | "active" | "reversed" | "deactivated";
export interface MersRegistration {
  readonly min: string; readonly application_id: string; readonly loan_id: string | null; readonly registration_kind: RegistrationKind; readonly state: string;
  readonly security_instrument_document_id: string | null; readonly mers_rider: boolean; readonly assignment_to_mers_document_id: string | null; readonly assignment_executed_on: PlainDate | null;
  readonly pre_closing_registered_at: string | null; readonly registered_at: string | null;
  readonly anchor_kind: AnchorKind; readonly anchor_date: PlainDate; readonly registration_due_at: PlainDate; readonly policy_target_at: PlainDate; readonly target_batch_on: PlainDate;
  readonly servicer_org_id: string; readonly subservicer_org_id: string; readonly investor_org_id: string; readonly interim_funder_org_id: string | null; readonly interim_funder_set_at: string | null; readonly interim_funder_removed_at: string | null; readonly custodian_org_id: string | null;
  readonly batch_ref: string | null; readonly channel: MersChannel; readonly mers_response: Record<string, unknown> | null; readonly status: RegistrationStatus; readonly reversal_reason: string | null; readonly deactivation_reason: string | null;
  readonly last_reconciled_at: string | null; readonly reconciliation_variances: readonly string[];
}
export interface RegistrationDraft {
  readonly min: string; readonly application_id: string; readonly loan_id?: string | null; readonly state: string; readonly anchor: MersAnchor;
  readonly partner_org_id: string; readonly investor_org_id?: string; readonly servicer_org_id?: string; readonly subservicer_org_id?: string; readonly custodian_org_id?: string | null; readonly interim_funder_org_id?: string | null;
  readonly security_instrument_document_id?: string | null; readonly mom_language_present?: boolean; readonly mers_rider?: boolean; readonly assignment_to_mers_document_id?: string | null; readonly channel?: MersChannel;
}
export const minOrgId = (min: string): string => min.slice(0, 7);
/** The mers_registrations row in `reserved` (the MIN 26.1 rendered) — Investor/Servicer = partner, Subservicer = SM, Interim Funder = SM only when an advance exists. */
export function draftRegistration(d: RegistrationDraft): MersRegistration {
  return { min: d.min, application_id: d.application_id, loan_id: d.loan_id ?? null, registration_kind: d.anchor.registration_kind, state: d.state.toUpperCase(), security_instrument_document_id: d.security_instrument_document_id ?? null, mers_rider: d.mers_rider ?? false,
    assignment_to_mers_document_id: d.assignment_to_mers_document_id ?? null, assignment_executed_on: d.anchor.anchor_kind === "assignment_executed_date" ? d.anchor.anchor_date : null, pre_closing_registered_at: null, registered_at: null,
    anchor_kind: d.anchor.anchor_kind, anchor_date: d.anchor.anchor_date, registration_due_at: d.anchor.registration_due_at, policy_target_at: d.anchor.policy_target_at, target_batch_on: d.anchor.target_batch_on,
    servicer_org_id: d.servicer_org_id ?? d.partner_org_id, subservicer_org_id: d.subservicer_org_id ?? SM_ORG_ID, investor_org_id: d.investor_org_id ?? d.partner_org_id, interim_funder_org_id: d.interim_funder_org_id ?? null, interim_funder_set_at: null, interim_funder_removed_at: null, custodian_org_id: d.custodian_org_id ?? null,
    batch_ref: null, channel: d.channel ?? "xml", mers_response: null, status: "reserved", reversal_reason: null, deactivation_reason: null, last_reconciled_at: null, reconciliation_variances: [] };
}
export interface RegistrationGuards { readonly partner_org_id: string; readonly purchased?: boolean; readonly mom_language_present?: boolean; }
/** B8-7-01 / MERS Procedures: refuses a payload that names any Investor other than the partner before purchase (Fannie Mae after), SM as Servicer, a MIN not on the partner's Org ID or with a bad check digit, a non-MOM instrument without the Maine 3749, or a MT/OR/WA instrument without the MERS Rider. */
export function validateRegistration(r: MersRegistration, g: RegistrationGuards): { ok: true; payload: Record<string, unknown> } {
  if (!minCheckDigitOk(r.min)) throw new PostClosingRefused("MIN_CHECK_DIGIT", "MERS Procedures Rel. 26.1: the Member generates the Check Digit for component 3 of the MIN", `MIN ${r.min} fails the 18-digit format / check digit`);
  if (minOrgId(r.min) !== g.partner_org_id) throw new PostClosingRefused("MIN_ORG_ID_NOT_PARTNER", "26.4 guardrails: never register a MIN on an Org ID other than the partner's (component 1 = partner Org ID)", `MIN component 1 ${minOrgId(r.min)} ≠ partner ${g.partner_org_id}`);
  if (r.servicer_org_id !== g.partner_org_id) throw new PostClosingRefused("SERVICER_NOT_PARTNER", "B8-7-01: the MOM instrument names the originating seller/servicer; SM is Subservicer, never Servicer", `Servicer ${r.servicer_org_id} ≠ partner ${g.partner_org_id}`);
  const expectedInvestor = g.purchased ? FANNIE_MAE_ORG_ID : g.partner_org_id;
  if (r.investor_org_id !== expectedInvestor) throw new PostClosingRefused("INVESTOR_NOT_PARTNER", "B8-7-01: a seller/servicer registering before delivery 'names itself as the investor'; after purchase Fannie Mae is the investor", `Investor ${r.investor_org_id} ≠ ${g.purchased ? "Fannie Mae " + FANNIE_MAE_ORG_ID : "partner " + g.partner_org_id}`);
  if (r.subservicer_org_id !== SM_ORG_ID) throw new PostClosingRefused("SUBSERVICER_NOT_SM", "26.4 rule 1: Subservicer = SM Org ID", `Subservicer ${r.subservicer_org_id} ≠ SM ${SM_ORG_ID}`);
  if (r.registration_kind === "mom" && g.mom_language_present === false) throw new PostClosingRefused("NOT_A_MOM_INSTRUMENT", "B8-7-01: the MOM instrument must show MERS as nominee for the seller/servicer", "security instrument lacks the MERS nominee language");
  if (r.registration_kind === "non_mom_assignment" && (!r.assignment_to_mers_document_id || !r.assignment_executed_on)) throw new PostClosingRefused("ASSIGNMENT_TO_MERS_REQUIRED", "B8-7-01: in the state of Maine, sellers/servicers must use the MERS Mortgage Assignment (Form 3749)", "no executed Form 3749 on file");
  if (MERS_RIDER_STATES.includes(r.state) && !r.mers_rider) throw new PostClosingRefused("MERS_RIDER_REQUIRED", "B8-7-01: Montana, Oregon and Washington require the MERS Rider (Form 3158)", `${r.state} instrument without the MERS Rider`);
  return { ok: true, payload: { min: r.min, registration_kind: r.registration_kind, servicer_org_id: r.servicer_org_id, investor_org_id: r.investor_org_id, subservicer_org_id: r.subservicer_org_id, custodian_org_id: r.custodian_org_id, interim_funder_org_id: r.interim_funder_org_id, anchor_kind: r.anchor_kind, anchor_date: r.anchor_date, registration_due_at: r.registration_due_at } };
}
const txnId = (r: MersRegistration, kind: string, batchOn: PlainDate): string => `${r.min}:${kind}:${batchOn}`;
/** The MERS System transactions of an active registration: Registration (Servicer = Investor = partner), Subservicer = SM, Interim Funder = SM when an advance exists at submission. */
export function registrationTransactions(r: MersRegistration, batchOn: PlainDate): MersTxn[] {
  const t: MersTxn[] = [{ txnId: txnId(r, "registration", batchOn), min: r.min, type: "registration", effectiveDate: batchOn, orgId: r.servicer_org_id, counterpartyOrgId: r.investor_org_id },
    { txnId: txnId(r, "min_update_subservicer", batchOn), min: r.min, type: "min_update_subservicer", effectiveDate: batchOn, orgId: r.subservicer_org_id }];
  if (r.interim_funder_org_id) t.push({ txnId: txnId(r, "min_update_interim_funder", batchOn), min: r.min, type: "min_update_other", effectiveDate: batchOn, orgId: r.interim_funder_org_id, counterpartyOrgId: r.servicer_org_id });
  return t;
}
export interface RegistrationResult { readonly registration: MersRegistration; readonly accepted: boolean; readonly codes: readonly string[]; readonly batch_on: PlainDate; readonly batch_ref: string; readonly events: readonly DomainEvent[]; readonly timeliness: ReturnType<typeof registrationTimeliness> | null; }
/** Active registration in the 18:00 batch of `submitted_at` → `mers.min.registered{status=active, registration_kind, interim_funder_org_id}` (satisfies MERS_PROC_MOM_REGISTER_7 / MERS_PROC_NON_MOM_REGISTER_7 / SM_O74_MOM_REGISTER_TARGET_1BD; 27.1 verifies interim_funder_org_id) or `mers.min.registration_rejected{codes}` (cured and resubmitted the same day; the deadline never extends). */
export async function registerMin(events: EventStore, port: MersPort, r: MersRegistration, g: RegistrationGuards, i: { submitted_at: string; time_zone: string }): Promise<RegistrationResult> {
  if (r.status === "active") throw new PostClosingRefused("ALREADY_ACTIVE", "26.4 state machine: active is reached once", `MIN ${r.min} is already active`);
  if (r.status === "reversed" || r.status === "deactivated") throw new PostClosingRefused("MIN_TERMINAL", "26.4 state machine: reversed / deactivated are terminal", `MIN ${r.min} is ${r.status}`);
  validateRegistration(r, g);
  const batch_on = localDate(i.submitted_at, i.time_zone); const ref = batchRef(batch_on, r.channel);
  const out = await port.submitBatch(registrationTransactions(r, batch_on), i.submitted_at);
  const rejected = out.results.filter((x: MersTxnResult) => x.status === "rejected");
  const k = { application_id: r.application_id, loan_id: r.loan_id };
  if (rejected.length) {
    const codes = rejected.map((x) => x.rejectCode ?? "REJECTED");
    const e = emit(events, k, "mers.min.registration_rejected", { min: r.min, codes, batch_ref: ref, batch_on, mers_batch_id: out.batchId, registration_due_at: r.registration_due_at, deadline_extended: false }, i.submitted_at, { kind: "external", id: "mers" });
    return { registration: { ...r, batch_ref: ref, mers_response: { batch_id: out.batchId, results: [...out.results] } }, accepted: false, codes, batch_on, batch_ref: ref, events: [e], timeliness: null };
  }
  const timeliness = registrationTimeliness(r, batch_on);
  const registration: MersRegistration = { ...r, status: "active", registered_at: i.submitted_at, batch_ref: ref, mers_response: { batch_id: out.batchId, results: [...out.results] }, interim_funder_set_at: r.interim_funder_org_id ? i.submitted_at : null };
  const e = emit(events, k, "mers.min.registered", { min: r.min, status: "active", registration_kind: r.registration_kind, servicer_org_id: r.servicer_org_id, investor_org_id: r.investor_org_id, subservicer_org_id: r.subservicer_org_id, custodian_org_id: r.custodian_org_id, interim_funder_org_id: r.interim_funder_org_id,
    anchor_kind: r.anchor_kind, anchor_date: r.anchor_date, registration_due_at: r.registration_due_at, policy_target_at: r.policy_target_at, batch_ref: ref, batch_on, mers_batch_id: out.batchId, registered_at: i.submitted_at, acknowledged_at: i.submitted_at, ...timeliness }, i.submitted_at, { kind: "external", id: "mers" });
  const evs = [e];
  // Interim Funder set at registration is the designation SM_O74_INTERIM_FUNDER_1BD waits for ("or set at registration").
  if (r.interim_funder_org_id) evs.push(emit(events, k, "mers.min.updated", { min: r.min, field: "interim_funder", interim_funder_org_id: r.interim_funder_org_id, value: r.interim_funder_org_id, set_at: i.submitted_at, batch_ref: ref, batch_on, at_registration: true }, i.submitted_at, { kind: "external", id: "mers" }));
  return { registration, accepted: true, codes: [], batch_on, batch_ref: ref, events: evs, timeliness };
}
/** Optional Pre-Closing Registration at document release (`mers.pre_closing_registration`, default off; 26.1-Q5) → `mers.min.pre_closing_registered` (`pre_closing`: not active, reversible). */
export function preCloseRegisterMin(events: EventStore, r: MersRegistration, g: RegistrationGuards, i: { at: string; time_zone: string; enabled: boolean }): { registration: MersRegistration; event: DomainEvent | null; skipped_reason: string | null } {
  if (!i.enabled) return { registration: r, event: null, skipped_reason: "mers.pre_closing_registration is off (26.4-Q4 default: active registration in the next daily batch after the note date)" };
  if (r.status !== "reserved") throw new PostClosingRefused("PRE_CLOSING_STATE", "26.4 state machine: reserved → pre_closing", `MIN ${r.min} is ${r.status}`);
  validateRegistration(r, g);
  const batch_on = localDate(i.at, i.time_zone);
  const registration: MersRegistration = { ...r, status: "pre_closing", pre_closing_registered_at: i.at, batch_ref: batchRef(batch_on, r.channel) };
  return { registration, event: emit(events, { application_id: r.application_id, loan_id: r.loan_id }, "mers.min.pre_closing_registered", { min: r.min, status: "pre_closing", batch_ref: registration.batch_ref, batch_on, pre_closing_registered_at: i.at }, i.at, { kind: "external", id: "mers" }), skipped_reason: null };
}
export interface InterimFunderUpdate { readonly advance_id: string; readonly advance_funded_at: string; readonly advance_date: PlainDate; readonly time_zone: string; readonly submitted_at?: string | null; }
/** `warehouse.advance.funded` → MIN Update: Interim Funder = SM Org ID in the same day's 18:00 batch → `mers.min.updated{field=interim_funder}` (satisfies SM_O74_INTERIM_FUNDER_1BD; due +1 business_days_servicer from the advance date). */
export async function updateMinInterimFunder(events: EventStore, port: MersPort, r: MersRegistration, u: InterimFunderUpdate): Promise<{ registration: MersRegistration; event: DomainEvent; batch_on: PlainDate; due_on: PlainDate; on_time: boolean; already_set: boolean }> {
  const due_on = addBusinessDays(u.advance_date, 1, servicer);
  const batch_on = nextBatchOn(u.submitted_at ?? u.advance_funded_at, u.time_zone);
  const at = u.submitted_at ?? u.advance_funded_at; const k = { application_id: r.application_id, loan_id: r.loan_id };
  if (r.interim_funder_org_id === SM_ORG_ID && r.status === "active") {
    const event = emit(events, k, "mers.min.updated", { min: r.min, field: "interim_funder", interim_funder_org_id: SM_ORG_ID, value: SM_ORG_ID, advance_id: u.advance_id, set_at: r.interim_funder_set_at, batch_on, batch_ref: r.batch_ref, at_registration: true, due_on, on_time: true }, at, { kind: "external", id: "mers" });
    return { registration: r, event, batch_on, due_on, on_time: true, already_set: true };
  }
  if (r.status !== "active") throw new PostClosingRefused("MIN_NOT_ACTIVE", "MERS Procedures: a Pre-Closing MIN Record cannot be updated; register first", `MIN ${r.min} is ${r.status}`);
  const out = await port.submitBatch([{ txnId: txnId(r, "min_update_interim_funder", batch_on), min: r.min, type: "min_update_other", effectiveDate: batch_on, orgId: SM_ORG_ID, counterpartyOrgId: r.servicer_org_id }], at);
  const res = out.results[0]!;
  if (res.status === "rejected") throw new PostClosingRefused("INTERIM_FUNDER_REJECTED", "MERS Procedures: Interim Funder MIN update", `${res.rejectCode}: ${res.message ?? ""}`);
  const ref = batchRef(batch_on, r.channel);
  const registration: MersRegistration = { ...r, interim_funder_org_id: SM_ORG_ID, interim_funder_set_at: at };
  const event = emit(events, k, "mers.min.updated", { min: r.min, field: "interim_funder", interim_funder_org_id: SM_ORG_ID, value: SM_ORG_ID, advance_id: u.advance_id, set_at: at, batch_on, batch_ref: ref, mers_batch_id: out.batchId, at_registration: false, due_on, on_time: batch_on <= due_on }, at, { kind: "external", id: "mers" });
  return { registration, event, batch_on, due_on, on_time: batch_on <= due_on, already_set: false };
}
/** Registration Reversal (registered in error / never funded / pre-closing) → `mers.min.reversed` (satisfies SM_O74_MIN_REVERSAL_2BD). The shared MersPort has no reversal verb: the reversal goes as the deactivating transaction with kind `registration_reversal` on the SOR row. */
export async function submitMinReversal(events: EventStore, port: MersPort, r: MersRegistration, i: { reason: string; submitted_at: string; time_zone: string; due_on: PlainDate }): Promise<{ registration: MersRegistration; event: DomainEvent; batch_on: PlainDate; on_time: boolean }> {
  if (r.status !== "active" && r.status !== "pre_closing") throw new PostClosingRefused("REVERSAL_STATE", "MERS Procedures: a Registration may be reversed if it was registered in error or a correction is required", `MIN ${r.min} is ${r.status}`);
  const batch_on = localDate(i.submitted_at, i.time_zone);
  const out = await port.submitBatch([{ txnId: txnId(r, "registration_reversal", batch_on), min: r.min, type: "deactivation", effectiveDate: batch_on, orgId: r.servicer_org_id }], i.submitted_at);
  const res = out.results[0]!;
  if (res.status === "rejected" && res.rejectCode !== "MIN_NOT_FOUND") throw new PostClosingRefused("REVERSAL_REJECTED", "MERS Procedures: Registration Reversal", `${res.rejectCode}: ${res.message ?? ""}`);
  const registration: MersRegistration = { ...r, status: "reversed", reversal_reason: i.reason, batch_ref: batchRef(batch_on, r.channel) };
  const event = emit(events, { application_id: r.application_id, loan_id: r.loan_id }, "mers.min.reversed", { min: r.min, status: "reversed", reason: i.reason, kind: "registration_reversal", batch_on, batch_ref: registration.batch_ref, mers_batch_id: out.batchId, due_on: i.due_on, on_time: batch_on <= i.due_on }, i.submitted_at, { kind: "external", id: "mers" });
  return { registration, event, batch_on, on_time: batch_on <= i.due_on };
}
/** Funded-then-unwound loan → Deactivation with the MERS reason → `mers.min.deactivated{reason}` (the MIN_REVERSAL clock is retired by the caller: a deactivation, not a reversal, closes it). */
export async function deactivateMin(events: EventStore, port: MersPort, r: MersRegistration, i: { reason: string; submitted_at: string; time_zone: string }): Promise<{ registration: MersRegistration; event: DomainEvent; batch_on: PlainDate }> {
  if (r.status !== "active") throw new PostClosingRefused("DEACTIVATION_STATE", "26.4 state machine: only an active MIN is deactivated", `MIN ${r.min} is ${r.status}`);
  const batch_on = localDate(i.submitted_at, i.time_zone);
  const out = await port.submitBatch([{ txnId: txnId(r, "deactivation", batch_on), min: r.min, type: "deactivation", effectiveDate: batch_on, orgId: r.servicer_org_id }], i.submitted_at);
  if (out.results[0]!.status === "rejected") throw new PostClosingRefused("DEACTIVATION_REJECTED", "MERS Procedures: Deactivation", `${out.results[0]!.rejectCode}`);
  const registration: MersRegistration = { ...r, status: "deactivated", deactivation_reason: i.reason, batch_ref: batchRef(batch_on, r.channel) };
  return { registration, batch_on, event: emit(events, { application_id: r.application_id, loan_id: r.loan_id }, "mers.min.deactivated", { min: r.min, status: "deactivated", reason: i.reason, batch_on, batch_ref: registration.batch_ref, mers_batch_id: out.batchId }, i.submitted_at, { kind: "external", id: "mers" }) };
}

// ============================================================ rule 2: endorsement (`ensureEndorsement`)
export type EndorsementMethod = "printed_facsimile" | "allonge_pre_executed" | "wet_post_closing";
export interface AllongeIdentifiers { readonly borrower_names: readonly string[]; readonly note_date: PlainDate; readonly note_amount_cents: Cents; readonly property_address: string; }
export interface FacsimileAuthorityFile { readonly jurisdiction_opinion_states: readonly string[]; readonly board_resolution_document_id: string | null; readonly corporate_secretary_certification_document_id: string | null; readonly notarized_facsimile_certification_document_id: string | null; }
export interface NoteEndorsement {
  readonly id: string; readonly closing_document_id: string; readonly method: EndorsementMethod; readonly endorsement_text: string; readonly endorsee: string; readonly signing_officer_party_id: string | null; readonly signed_at: string | null; readonly signature_kind: "wet" | "facsimile" | null;
  readonly facsimile_authority: FacsimileAuthorityFile | null; readonly allonge_document_id: string | null; readonly allonge_identifiers: AllongeIdentifiers | null; readonly note_references_allonge: boolean; readonly affixed_by_party_id: string | null; readonly affixed_at: string | null;
  readonly chain: readonly { endorser: string; endorsee: string; at: string | null }[];
}
export const endorsementText = (partnerLegalName: string): string => `PAY TO THE ORDER OF ______ WITHOUT RECOURSE ${partnerLegalName} By: ______ Name: ______ Title: ______`;
export interface NoteFacts { readonly borrower_names: readonly string[]; readonly note_date: PlainDate; readonly note_amount_cents: Cents; readonly property_address: string; readonly property_state: string; readonly partner_legal_name: string; }
export interface EndorsementGate { readonly open: boolean; readonly reason: string | null; readonly route: "fcc_bailee" | "endorsement_desk"; readonly escalation: "signing_officer" | null; readonly mismatches: readonly string[]; readonly method: EndorsementMethod; }
const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");
/** B8-3-04 / E-2-01 / RDC §8: exactly one endorsement by the partner, in blank, without recourse; never SM, never Fannie Mae, never an attorney-in-fact, never a second endorsement. */
export function endorsementChainOk(e: NoteEndorsement, partnerLegalName: string): string | null {
  const bad = e.chain.find((c) => /supermortgage|fannie mae|federal national mortgage/i.test(c.endorsee) || norm(c.endorsee) !== "blank");
  if (bad) return `endorsement to "${bad.endorsee}" — the endorsement must be in blank (never SM, never Fannie Mae by name)`;
  if (e.chain.length !== 1) return `${e.chain.length} endorsements — exactly one blank endorsement by the partner`;
  if (norm(e.chain[0]!.endorser) !== norm(partnerLegalName)) return `endorser "${e.chain[0]!.endorser}" is not the partner (B8-3-04: the mortgage seller endorses; no attorney-in-fact)`;
  if (!/without recourse/i.test(e.endorsement_text)) return "endorsement text lacks WITHOUT RECOURSE";
  return null;
}
/** SM_O74_ENDORSEMENT_BEFORE_SHIP_GATE: printed facsimile with the four-document authority file for the property's jurisdiction, or a pre-executed allonge affixed whose identifiers match the note (borrower names, note date, note amount, property address) with the note referencing it; else the endorsement desk. */
export function ensureEndorsement(e: NoteEndorsement | null, note: NoteFacts): EndorsementGate {
  if (!e) return { open: false, reason: "no note_endorsements row — route to the endorsement desk (wet_post_closing)", route: "endorsement_desk", escalation: "signing_officer", mismatches: ["missing"], method: "wet_post_closing" };
  const chain = endorsementChainOk(e, note.partner_legal_name);
  if (chain) return { open: false, reason: chain, route: "endorsement_desk", escalation: "signing_officer", mismatches: ["chain"], method: e.method };
  if (e.method === "printed_facsimile") {
    const f = e.facsimile_authority; const missing: string[] = [];
    if (!f || !f.jurisdiction_opinion_states.map((s) => s.toUpperCase()).includes(note.property_state.toUpperCase())) missing.push(`legal opinion for ${note.property_state}`);
    if (!f?.board_resolution_document_id) missing.push("board resolution"); if (!f?.corporate_secretary_certification_document_id) missing.push("corporate secretary certification"); if (!f?.notarized_facsimile_certification_document_id) missing.push("notarized facsimile certification");
    if (missing.length) return { open: false, reason: `B8-3-04 facsimile authority file incomplete: ${missing.join(", ")} — fall back to the allonge or wet endorsement`, route: "endorsement_desk", escalation: "signing_officer", mismatches: missing, method: e.method };
    return { open: true, reason: null, route: "fcc_bailee", escalation: null, mismatches: [], method: e.method };
  }
  if (e.method === "allonge_pre_executed") {
    const id = e.allonge_identifiers; const mm: string[] = [];
    if (!e.allonge_document_id || !id) return { open: false, reason: "no allonge on file", route: "endorsement_desk", escalation: "signing_officer", mismatches: ["allonge"], method: e.method };
    if (!e.signing_officer_party_id || !e.signed_at || e.signature_kind !== "wet") mm.push("allonge not wet-signed by the signing_officer");
    if (id.note_amount_cents !== note.note_amount_cents) mm.push(`note amount ${id.note_amount_cents} ≠ ${note.note_amount_cents}`);
    if (id.note_date !== note.note_date) mm.push(`note date ${id.note_date} ≠ ${note.note_date}`);
    if (norm(id.property_address) !== norm(note.property_address)) mm.push("property address");
    const names = new Set(note.borrower_names.map(norm)); if (id.borrower_names.length !== note.borrower_names.length || !id.borrower_names.every((n) => names.has(norm(n)))) mm.push("borrower names");
    if (!e.affixed_at) mm.push("allonge not affixed to the note"); if (!e.note_references_allonge) mm.push("note does not reference the attached allonge");
    if (mm.length) return { open: false, reason: `allonge does not match the note: ${mm.join("; ")} — replacement allonge by the signing_officer`, route: "endorsement_desk", escalation: "signing_officer", mismatches: mm, method: e.method };
    return { open: true, reason: null, route: "fcc_bailee", escalation: null, mismatches: [], method: e.method };
  }
  return { open: !!e.signed_at && e.signature_kind === "wet", reason: e.signed_at ? null : "wet_post_closing: the note routes to the endorsement desk; signing_officer endorses within 1 business_days_creditor of receipt", route: e.signed_at ? "fcc_bailee" : "endorsement_desk", escalation: e.signed_at ? null : "signing_officer", mismatches: e.signed_at ? [] : ["unsigned"], method: e.method };
}
/** A shipment request asserts the gate: open → `note.endorsed{method}` (satisfies the gate); closed → `note.endorsement.exception` and the desk route. */
export function recordEndorsementCheck(events: EventStore, k: Keys, e: NoteEndorsement | null, note: NoteFacts, at: string): { gate: EndorsementGate; event: DomainEvent } {
  const gate = ensureEndorsement(e, note);
  const event = gate.open ? emit(events, k, "note.endorsed", { method: gate.method, endorsement_id: e!.id, closing_document_id: e!.closing_document_id, signing_officer_party_id: e!.signing_officer_party_id, endorsee: "blank", route: gate.route, checked_at: at }, at)
    : emit(events, k, "note.endorsement.exception", { method: gate.method, reason: gate.reason, mismatches: gate.mismatches, route: gate.route, escalation: gate.escalation, checked_at: at }, at);
  return { gate, event };
}

// ============================================================ rule 3: assignments (`decideAssignments`)
export interface AssignmentDecision { readonly kind: "none" | "form_3749_to_mers"; readonly registration_kind: RegistrationKind; readonly intervening: false; readonly to_fannie_mae: false; readonly trailing_kind: "recorded_assignment_to_mers" | null; readonly executed_by: "signing_officer" | null; readonly basis: string; }
/** B8-6-01 / B8-7-01 / E-2-01: MOM loans carry no assignment of any kind; Maine (or a `mom_available=false` jurisdiction) uses the Form 3749 executed at closing by the partner's signing_officer and recorded promptly after the mortgage. */
export function decideAssignments(i: { state: string; mom_available?: boolean; originator_is_servicer?: boolean }): AssignmentDecision {
  if (i.originator_is_servicer === false) throw new PostClosingRefused("INTERVENING_ASSIGNMENT_OUT_OF_MODEL", "B8-6-01 applies where the originating lender is not the servicer at sale — not this model (partner originates and services)", "originator ≠ servicer");
  const nonMom = i.mom_available === false || NON_MOM_STATES.includes(i.state.toUpperCase());
  if (nonMom) return { kind: "form_3749_to_mers", registration_kind: "non_mom_assignment", intervening: false, to_fannie_mae: false, trailing_kind: "recorded_assignment_to_mers", executed_by: "signing_officer", basis: "B8-7-01: in the state of Maine, sellers/servicers must use the MERS Mortgage Assignment (Form 3749); MERS_PROC_NON_MOM_REGISTER_7 anchors on its execution date" };
  return { kind: "none", registration_kind: "mom", intervening: false, to_fannie_mae: false, trailing_kind: null, executed_by: null, basis: "E-2-01 lists no assignment; RDC v15 'Removed mortgage assignments from required documents'; B8-6-01 is moot for MERS-registered loans — no assignment to MERS, to Fannie Mae or intervening" };
}
/** The signing_officer's execution of the Form 3749 at closing → `closing.assignment_to_mers.executed{assignment_executed_on}` (arms MERS_PROC_NON_MOM_REGISTER_7). */
export function recordAssignmentExecuted(events: EventStore, k: Keys, i: { state: string; document_id: string; executed_at: string; time_zone: string; signing_officer_party_id: string }): { event: DomainEvent; registration_due_at: PlainDate; assignment_executed_on: PlainDate } {
  const d = decideAssignments({ state: i.state }); if (d.kind !== "form_3749_to_mers") throw new PostClosingRefused("NO_ASSIGNMENT_FOR_MOM", d.basis, `${i.state} is a MOM jurisdiction — no assignment is prepared`);
  const assignment_executed_on = localDate(i.executed_at, i.time_zone); const registration_due_at = addDays(assignment_executed_on, MERS_REGISTRATION_DAYS);
  return { assignment_executed_on, registration_due_at, event: emit(events, k, "closing.assignment_to_mers.executed", { state: i.state, form: "3749", document_id: i.document_id, executed_at: i.executed_at, assignment_executed_on, signing_officer_party_id: i.signing_officer_party_id, registration_due_at, trailing_kind: "recorded_assignment_to_mers" }, i.executed_at, { kind: "human", id: i.signing_officer_party_id, role: "signing_officer" }) };
}
/** 26.4-T12 population check: `closing_documents.kind` containing "assignment" outside Maine must return zero rows. */
export function assignmentPopulationCheck(rows: readonly { application_id: string; state: string; kind: string }[]): { application_id: string; state: string; kind: string }[] {
  return rows.filter((r) => /assignment/i.test(r.kind) && !NON_MOM_STATES.includes(r.state.toUpperCase()));
}

// ============================================================ rule 4: paper-note custody chain (`routeNote`, shipments)
export type HolderRole = "settlement_agent" | "courier" | "endorsement_desk" | "fcc_bailee" | "sm_designated_custodian" | "fnma_custodian" | "fnma_evault" | "released";
export type ShipmentToRole = "fcc_bailee" | "endorsement_desk" | "sm_designated_custodian" | "fnma_custodian" | "settlement_agent_return" | "borrower_return";
export type ShipmentStatus = "prepared" | "shipped" | "in_transit" | "delivered" | "receipted" | "exception" | "lost" | "returned";
export interface NoteShipment {
  readonly shipment_id: string; readonly custody_record_id: string; readonly from_party_id: string; readonly to_party_id: string; readonly to_role: ShipmentToRole; readonly bailee_letter_id: string | null; readonly carrier: string; readonly tracking_ref: string;
  readonly contents: readonly { document_kind: string; closing_document_id: string; original: boolean }[]; readonly shipped_at: string | null; readonly pickup_scan_at: string | null; readonly delivered_at: string | null; readonly trust_receipt_at: string | null; readonly exception: Record<string, unknown> | null; readonly status: ShipmentStatus; readonly time_zone: string;
}
/** 27.1 facility arithmetic reused: wet advance → trust receipt within 5 business_days_servicer; SM's own plan ships next creditor business day and targets delivery two days inside the facility clock. */
export function shipmentPlan(advanceDate: PlainDate, facility: FacilityTerms = FACILITY_FIXTURE): { wet_note_due_on: PlainDate; ship_by: PlainDate; target_delivery_on: PlainDate; trust_receipt_target_on: PlainDate } {
  const wet_note_due_on = wetNoteDeadline(facility, advanceDate);
  return { wet_note_due_on, ship_by: addBusinessDays(advanceDate, 1, creditor), target_delivery_on: addBusinessDays(advanceDate, NOTE_TRANSIT_BD, servicer), trust_receipt_target_on: addBusinessDays(advanceDate, NOTE_TRANSIT_BD + 1, servicer) };
}
export interface ShipmentRequest { readonly shipment: Omit<NoteShipment, "status" | "shipped_at" | "pickup_scan_at" | "delivered_at" | "trust_receipt_at" | "exception">; readonly address_on_closing_instructions: boolean; readonly endorsement: NoteEndorsement | null; readonly note: NoteFacts; readonly requested_at: string; }
/** Shipment request: never without a bailee letter to the FCC/SM custodian, never to an address not on the closing instructions, never a copy for the original; asserts the endorsement gate (`note.shipment.requested` arms it; `note.endorsed` satisfies it) → `note.shipment.prepared` or the desk route. */
export function prepareShipment(events: EventStore, k: Keys, r: ShipmentRequest): { shipment: NoteShipment; gate: EndorsementGate; events: readonly DomainEvent[]; refusal: string | null } {
  const s = r.shipment;
  if ((s.to_role === "fcc_bailee" || s.to_role === "sm_designated_custodian") && !s.bailee_letter_id) throw new PostClosingRefused("SHIP_WITHOUT_BAILEE_LETTER", "26.4 rule 4: never ship a paper note without a bailee letter (27.1 SM_WH_BAILEE_LETTER_GATE)", `shipment ${s.shipment_id} to ${s.to_role} has no bailee_letter_id`);
  if (!r.address_on_closing_instructions) throw new PostClosingRefused("SHIP_TO_UNLISTED_ADDRESS", "26.4 rule 4: never ship to an address not on the closing instructions", `shipment ${s.shipment_id}`);
  const note = s.contents.find((c) => c.document_kind === "note"); if (!note || !note.original) throw new PostClosingRefused("COPY_NOT_ORIGINAL", "26.4 rule 4: never accept a copy in place of the original note", `shipment ${s.shipment_id} carries no original note`);
  const requested = emit(events, k, "note.shipment.requested", { shipment_id: s.shipment_id, to_role: s.to_role, bailee_letter_id: s.bailee_letter_id, requested_at: r.requested_at, requested_on: localDate(r.requested_at, s.time_zone) }, r.requested_at);
  const chk = recordEndorsementCheck(events, k, r.endorsement, r.note, r.requested_at);
  if (!chk.gate.open) {
    const shipment: NoteShipment = { ...s, to_role: "endorsement_desk", status: "prepared", shipped_at: null, pickup_scan_at: null, delivered_at: null, trust_receipt_at: null, exception: { gate: "SM_O74_ENDORSEMENT_BEFORE_SHIP_GATE", reason: chk.gate.reason } };
    return { shipment, gate: chk.gate, events: [requested, chk.event], refusal: `SM_O74_ENDORSEMENT_BEFORE_SHIP_GATE closed: ${chk.gate.reason} — shipment to the FCC refused; routed to the endorsement desk` };
  }
  const shipment: NoteShipment = { ...s, status: "prepared", shipped_at: null, pickup_scan_at: null, delivered_at: null, trust_receipt_at: null, exception: null };
  const prepared = emit(events, k, "note.shipment.prepared", { shipment_id: s.shipment_id, custody_record_id: s.custody_record_id, to_role: s.to_role, to_party_id: s.to_party_id, bailee_letter_id: s.bailee_letter_id, carrier: s.carrier, tracking_ref: s.tracking_ref, contents: s.contents.map((c) => ({ document_kind: c.document_kind, closing_document_id: c.closing_document_id })), prepared_at: r.requested_at }, r.requested_at);
  return { shipment, gate: chk.gate, events: [requested, chk.event, prepared], refusal: null };
}
export type ScanKind = "pickup" | "delivery" | "exception";
/** Carrier scans keyed by tracking_ref: pickup → `note.shipment.in_transit{pickup_scan_on}` (satisfies SM_O74_NOTE_PICKUP_SCAN_1BD; arms SM_O74_NOTE_TRANSIT_3BD); delivery → `note.shipment.delivered{delivered_on}` (satisfies TRANSIT; arms SM_O74_TRUST_RECEIPT_1BD). */
export function trackShipment(events: EventStore, k: Keys, s: NoteShipment, scan: { kind: ScanKind; at: string; location?: string | null; code?: string | null }): { shipment: NoteShipment; event: DomainEvent; transit_due_on: PlainDate | null; trust_receipt_due_on: PlainDate | null } {
  const on = localDate(scan.at, s.time_zone);
  if (scan.kind === "pickup") {
    if (s.status !== "prepared" && s.status !== "shipped") throw new PostClosingRefused("SCAN_ORDER", "26.4 state machine: prepared/shipped → in_transit", `shipment ${s.shipment_id} is ${s.status}`);
    const transit_due_on = addBusinessDays(on, NOTE_TRANSIT_BD, servicer);
    const shipment: NoteShipment = { ...s, status: "in_transit", shipped_at: s.shipped_at ?? scan.at, pickup_scan_at: scan.at };
    return { shipment, transit_due_on, trust_receipt_due_on: null, event: emit(events, k, "note.shipment.in_transit", { shipment_id: s.shipment_id, tracking_ref: s.tracking_ref, carrier: s.carrier, pickup_scan_at: scan.at, pickup_scan_on: on, location: scan.location ?? null, transit_due_on, lost_determination_on: addBusinessDays(on, LOST_NOTE_TRANSIT_BD, servicer) }, scan.at, { kind: "external", id: s.carrier }) };
  }
  if (scan.kind === "delivery") {
    if (s.status !== "in_transit" && s.status !== "shipped" && s.status !== "exception") throw new PostClosingRefused("SCAN_ORDER", "26.4 state machine: in_transit → delivered", `shipment ${s.shipment_id} is ${s.status}`);
    const trust_receipt_due_on = addBusinessDays(on, 1, servicer);
    const shipment: NoteShipment = { ...s, status: "delivered", delivered_at: scan.at };
    return { shipment, transit_due_on: null, trust_receipt_due_on, event: emit(events, k, "note.shipment.delivered", { shipment_id: s.shipment_id, tracking_ref: s.tracking_ref, to_party_id: s.to_party_id, to_role: s.to_role, delivered_at: scan.at, delivered_on: on, location: scan.location ?? null, trust_receipt_due_on }, scan.at, { kind: "external", id: s.carrier }) };
  }
  const shipment: NoteShipment = { ...s, status: "exception", exception: { carrier_code: scan.code ?? null, at: scan.at, location: scan.location ?? null } };
  return { shipment, transit_due_on: null, trust_receipt_due_on: null, event: emit(events, k, "note.shipment.exception", { shipment_id: s.shipment_id, tracking_ref: s.tracking_ref, carrier_code: scan.code ?? null, at: scan.at, on }, scan.at, { kind: "external", id: s.carrier }) };
}
/** FCC trust receipt → `custody.trust_receipt.received` (satisfies SM_O74_TRUST_RECEIPT_1BD) and 27.1's `warehouse.note.received` with 27.1's payload shape (collateral_status secured_possession; satisfies SM_WH_WET_NOTE_DELIVERY_5BD when an advance exists). */
export function ingestTrustReceipt(events: EventStore, k: Keys, s: NoteShipment, r: { receipt_id: string; received_at: string; trust_receipt_document_id: string; custodian_loan_id?: string | null; advance_id?: string | null }): { shipment: NoteShipment; holder_role: HolderRole; events: readonly DomainEvent[] } {
  if (s.status !== "delivered") throw new PostClosingRefused("RECEIPT_BEFORE_DELIVERY", "26.4 state machine: delivered → receipted", `shipment ${s.shipment_id} is ${s.status}`);
  if (!s.bailee_letter_id) throw new PostClosingRefused("RECEIPT_WITHOUT_BAILEE_LETTER", "26.4 edge cases: a custodian holding without the bailee letter does not acknowledge SM's interest", `shipment ${s.shipment_id}`);
  const holder_role: HolderRole = s.to_role === "sm_designated_custodian" ? "sm_designated_custodian" : "fcc_bailee";
  const shipment: NoteShipment = { ...s, status: "receipted", trust_receipt_at: r.received_at };
  const on = localDate(r.received_at, s.time_zone);
  const e1 = emit(events, k, "custody.trust_receipt.received", { shipment_id: s.shipment_id, custody_record_id: s.custody_record_id, receipt_id: r.receipt_id, received_at: r.received_at, received_on: on, trust_receipt_document_id: r.trust_receipt_document_id, custodian_loan_id: r.custodian_loan_id ?? null, bailee_letter_id: s.bailee_letter_id, holder_role, holding_for_party_id: "sm" }, r.received_at, { kind: "external", id: "custodian" });
  const e2 = emit(events, k, "warehouse.note.received", { advance_id: r.advance_id ?? null, receipt_id: r.receipt_id, received_at: r.received_at, custody_record_id: s.custody_record_id, bailee_letter_id: s.bailee_letter_id, collateral_status: "secured_possession", note_received_at: r.received_at }, r.received_at, { kind: "external", id: "custodian" });
  return { shipment, holder_role, events: [e1, e2] };
}
/** SM_O74_NOTE_TRANSIT_3BD breach: trace + claim opened with the carrier and the settlement agent's attestation requested → `note.shipment.trace_opened`. */
export function openTrace(events: EventStore, k: Keys, s: NoteShipment, i: { at: string; claim_ref?: string | null }): { shipment: NoteShipment; event: DomainEvent; lost_determination_on: PlainDate } {
  const pickupOn = s.pickup_scan_at ? localDate(s.pickup_scan_at, s.time_zone) : localDate(s.shipped_at ?? i.at, s.time_zone);
  const lost_determination_on = addBusinessDays(pickupOn, LOST_NOTE_TRANSIT_BD, servicer);
  const shipment: NoteShipment = { ...s, status: "exception", exception: { ...(s.exception ?? {}), trace_opened_at: i.at, claim_ref: i.claim_ref ?? null } };
  return { shipment, lost_determination_on, event: emit(events, k, "note.shipment.trace_opened", { shipment_id: s.shipment_id, tracking_ref: s.tracking_ref, carrier: s.carrier, opened_at: i.at, opened_on: localDate(i.at, s.time_zone), claim_ref: i.claim_ref ?? null, lost_determination_on, attestation_requested_from: s.from_party_id }, i.at) };
}

// ============================================================ rule 5: lost note (`handleLostNote`)
export type LnaDecision = "pending" | "re_execute" | "lna" | "both";
export interface LostNoteAffidavit {
  readonly id: string; readonly custody_record_id: string; readonly search_started_at: string; readonly search_evidence_document_ids: readonly string[]; readonly courier_claim_ref: string | null; readonly decision: LnaDecision; readonly decided_by: string | null; readonly decided_at: string | null;
  readonly replacement_note_document_id: string | null; readonly replacement_note_signed_at: string | null; readonly lna_document_id: string | null; readonly executed_by_party_id: string | null; readonly notarized_at: string | null; readonly indemnity_text_ok: boolean | null; readonly note_description_ok: boolean | null; readonly note_copy_attached: boolean | null;
  readonly custodian_accepted_at: string | null; readonly fnma_position: "unknown" | "accepted" | "rejected"; readonly warehouse_effect: "unsecured_wet" | "cured" | "repurchase";
}
/** No delivery by pickup + 5 business_days_servicer with a documented search (carrier trace, settlement-agent attestation, custodian search) → `note.lost_in_transit{determined_on}` (arms SM_O74_LNA_DECISION_5BD; 27.1 `unsecured_wet`). */
export function handleLostNote(events: EventStore, k: Keys, s: NoteShipment, i: { determined_at: string; search_evidence_document_ids: readonly string[]; courier_claim_ref: string | null; lna_id: string }): { shipment: NoteShipment; lna: LostNoteAffidavit; event: DomainEvent; decision_due_on: PlainDate } {
  if (s.status === "delivered" || s.status === "receipted") throw new PostClosingRefused("NOTE_NOT_LOST", "26.4 rule 5: a delivered note is not lost in transit", `shipment ${s.shipment_id} is ${s.status}`);
  if (i.search_evidence_document_ids.length < 2) throw new PostClosingRefused("SEARCH_NOT_DILIGENT", "Servicing Guide E-1.1-02: lost note affidavits only after a thorough and diligent search (carrier trace, settlement-agent attestation, custodian search)", `${i.search_evidence_document_ids.length} evidence document(s)`);
  const determined_on = localDate(i.determined_at, s.time_zone); const decision_due_on = addBusinessDays(determined_on, LNA_DECISION_BD, creditor);
  const lna: LostNoteAffidavit = { id: i.lna_id, custody_record_id: s.custody_record_id, search_started_at: (s.exception?.trace_opened_at as string | undefined) ?? i.determined_at, search_evidence_document_ids: [...i.search_evidence_document_ids], courier_claim_ref: i.courier_claim_ref, decision: "pending", decided_by: null, decided_at: null, replacement_note_document_id: null, replacement_note_signed_at: null, lna_document_id: null, executed_by_party_id: null, notarized_at: null, indemnity_text_ok: null, note_description_ok: null, note_copy_attached: null, custodian_accepted_at: null, fnma_position: "unknown", warehouse_effect: "unsecured_wet" };
  const shipment: NoteShipment = { ...s, status: "lost" };
  return { shipment, lna, decision_due_on, event: emit(events, k, "note.lost_in_transit", { shipment_id: s.shipment_id, tracking_ref: s.tracking_ref, lna_id: i.lna_id, determined_at: i.determined_at, determined_on, decision_due_on, courier_claim_ref: i.courier_claim_ref, search_evidence_document_ids: [...i.search_evidence_document_ids], warehouse_effect: "unsecured_wet", lost_note: true }, i.determined_at) };
}
/** `officer` decision (re-execution first; LNA alone only if the borrower cannot or will not re-execute) → `note.lna.decided{decision}` (satisfies SM_O74_LNA_DECISION_5BD). */
export function decideLostNote(events: EventStore, k: Keys, lna: LostNoteAffidavit, i: { decision: Exclude<LnaDecision, "pending">; decided_by: Actor; decided_at: string; borrower_can_reexecute: boolean; rationale: string }): { lna: LostNoteAffidavit; event: DomainEvent } {
  if (i.decided_by.kind !== "human" || i.decided_by.role !== "officer") throw new PostClosingRefused("LNA_DECISION_OFFICER", "26.4 rule 5: the lost-note decision is the officer's", `decided by ${i.decided_by.kind}:${i.decided_by.id}`);
  if (i.decision === "lna" && i.borrower_can_reexecute) throw new PostClosingRefused("REEXECUTION_FIRST", "26.4-Q3 default: re-execution by the borrower plus an LNA for the lost original; LNA alone only if the borrower cannot or will not re-execute", "borrower can re-execute");
  const out: LostNoteAffidavit = { ...lna, decision: i.decision, decided_by: i.decided_by.id, decided_at: i.decided_at };
  return { lna: out, event: emit(events, k, "note.lna.decided", { lna_id: lna.id, decision: i.decision, decided_by: i.decided_by.id, decided_at: i.decided_at, rationale: i.rationale, certifiability_confirmation_required: i.decision !== "re_execute" }, i.decided_at, i.decided_by) };
}
/** RDC (as extracted): the LNA is executed by the Seller's signing_officer, notarized, with indemnification protecting Fannie Mae, the note description (loan amount, borrower name, note date) and a copy of the note; certifiability confirmed per loan (no E-2-01 row, no SFC). */
export function lnaComplete(l: LostNoteAffidavit): { complete: boolean; missing: readonly string[] } {
  const missing: string[] = [];
  if (!l.lna_document_id) missing.push("lna_document_id"); if (!l.executed_by_party_id) missing.push("executed_by_party_id (signing_officer)"); if (!l.notarized_at) missing.push("notarized_at");
  if (!l.indemnity_text_ok) missing.push("indemnification language protecting Fannie Mae"); if (!l.note_description_ok) missing.push("note description (loan amount, borrower name, note date)"); if (!l.note_copy_attached) missing.push("copy of the note");
  if (l.fnma_position !== "accepted") missing.push("certifiability confirmed with the FCC/Fannie Mae before delivery");
  return { complete: missing.length === 0, missing };
}

// ============================================================ custodian exceptions (RDC §8) and certification
export type CustodianExceptionCode = "missing_endorsement" | "wrong_entity_name" | "unsigned_allonge" | "allonge_not_affixed" | "name_mismatch_no_affidavit" | "poa_invalid_at_signing" | "min_missing" | "endorser_not_on_resolution" | "trust_capacity_missing";
export interface CustodyState { readonly custody_record_id: string; readonly holder_role: HolderRole; readonly custodian_exception_codes: readonly string[]; readonly custodian_exception_cured_at: string | null; readonly certified_at: string | null; }
/** Custodian exception letter → `custody.exception.recorded{code, recorded_on}` (arms SM_O74_CUSTODIAN_EXCEPTION_CURE_5BD: +5 business_days_servicer) and 27.1's `warehouse.collateral.defect_recorded{source=custodian_exception, cure_owner}`. */
export function recordCustodianException(events: EventStore, k: Keys, c: CustodyState, i: { code: CustodianExceptionCode; recorded_at: string; time_zone: string; notice_document_id: string; advance_id?: string | null; description?: string | null }): { custody: CustodyState; cure_due_on: PlainDate; cure_owner: "signing_officer" | "post-closing"; events: readonly DomainEvent[] } {
  const recorded_on = localDate(i.recorded_at, i.time_zone); const cure_due_on = addBusinessDays(recorded_on, CUSTODIAN_EXCEPTION_CURE_BD, servicer);
  const cure_owner: "signing_officer" | "post-closing" = ["missing_endorsement", "wrong_entity_name", "unsigned_allonge", "allonge_not_affixed", "endorser_not_on_resolution"].includes(i.code) ? "signing_officer" : "post-closing";
  const custody: CustodyState = { ...c, custodian_exception_codes: [...c.custodian_exception_codes, i.code], custodian_exception_cured_at: null };
  const e1 = emit(events, k, "custody.exception.recorded", { custody_record_id: c.custody_record_id, code: i.code, recorded_at: i.recorded_at, recorded_on, cure_due_on, cure_owner, notice_document_id: i.notice_document_id, description: i.description ?? null }, i.recorded_at, { kind: "external", id: "custodian" });
  const e2 = emit(events, k, "warehouse.collateral.defect_recorded", { advance_id: i.advance_id ?? null, defect_id: `${c.custody_record_id}:custodian_exception:${i.code}:${recorded_on}`, source: "custodian_exception", recorded_at: i.recorded_at, description: i.description ?? `custodian exception ${i.code}`, cure_due_at: addBusinessDays(recorded_on, 10, servicer), cure_owner }, i.recorded_at);
  return { custody, cure_due_on, cure_owner, events: [e1, e2] };
}
/** Cure evidence delivered to the FCC (corrected allonge by the signing_officer, name affidavit, POA copy, MIN added, corporate secretary certification) → `custody.exception.cured` and 27.1's `warehouse.collateral.defect_cured`. */
export function cureCustodianException(events: EventStore, k: Keys, c: CustodyState, i: { code: CustodianExceptionCode; cured_at: string; time_zone: string; evidence_document_id: string; evidence_kind: string; delivered_by: Actor; advance_id?: string | null }): { custody: CustodyState; events: readonly DomainEvent[] } {
  if (!c.custodian_exception_codes.includes(i.code)) throw new PostClosingRefused("NO_SUCH_EXCEPTION", "26.4: cure of an exception that was not recorded", i.code);
  if (["missing_endorsement", "wrong_entity_name", "unsigned_allonge", "allonge_not_affixed"].includes(i.code) && !(i.delivered_by.kind === "human" && i.delivered_by.role === "signing_officer")) throw new PostClosingRefused("CURE_BY_SIGNING_OFFICER", "26.4 rule 2: cures are executed only by the partner's signing_officer (corrected allonge) — never by SM", `cure delivered by ${i.delivered_by.kind}:${i.delivered_by.id}`);
  const custody: CustodyState = { ...c, custodian_exception_codes: c.custodian_exception_codes.filter((x) => x !== i.code), custodian_exception_cured_at: i.cured_at };
  const cured_on = localDate(i.cured_at, i.time_zone);
  const e1 = emit(events, k, "custody.exception.cured", { custody_record_id: c.custody_record_id, code: i.code, cured_at: i.cured_at, cured_on, evidence_document_id: i.evidence_document_id, evidence_kind: i.evidence_kind, remaining_codes: custody.custodian_exception_codes }, i.cured_at, i.delivered_by);
  const e2 = emit(events, k, "warehouse.collateral.defect_cured", { advance_id: i.advance_id ?? null, defect_id: `${c.custody_record_id}:custodian_exception:${i.code}`, source: "custodian_exception", cured_at: i.cured_at, evidence_document_id: i.evidence_document_id }, i.cured_at);
  return { custody, events: [e1, e2] };
}
/** 29.4 gate fact: the FCC cannot certify while a custodian exception is open (or the note is not in its possession). */
export function custodyCertifiable(c: CustodyState): { ok: boolean; reason: string | null } {
  if (c.custodian_exception_codes.length) return { ok: false, reason: `open custodian exception(s): ${c.custodian_exception_codes.join(", ")}` };
  if (c.holder_role !== "fcc_bailee" && c.holder_role !== "fnma_custodian" && c.holder_role !== "fnma_evault") return { ok: false, reason: `note held by ${c.holder_role}, not the document custodian` };
  return { ok: true, reason: null };
}
/** SM_O74_CUSTODIAN_EXCEPTION_CURE_5BD breach: sev 2 to signing_officer and officer; 29.4 cannot certify → `custody.certification.blocked`. */
export function custodianExceptionBreach(events: EventStore, k: Keys, c: CustodyState, at: string): { escalations: readonly { kind: "signing_officer" | "officer"; severity: "sev2"; owner_role: string }[]; event: DomainEvent } {
  return { escalations: [{ kind: "signing_officer", severity: "sev2", owner_role: "signing_officer" }, { kind: "officer", severity: "sev2", owner_role: "officer" }],
    event: emit(events, k, "custody.certification.blocked", { custody_record_id: c.custody_record_id, codes: c.custodian_exception_codes, reason: custodyCertifiable(c).reason, blocked_at: at, blocks: ["custody.certified"] }, at) };
}

// ============================================================ trailing documents (rules 6–7, follow-up ladder)
export type TrailingKind = "recorded_security_instrument" | "final_title_policy" | "recorded_assignment" | "mi_certificate" | "flood_cert" | "recorded_poa" | "recorded_subordination" | "recorded_cema_3172" | "recorded_tx_affidavit_3185" | "recorded_assignment_to_mers" | "recorded_release_prior_lien" | "final_aol" | "custodian_trust_receipt" | "custodian_certification" | "recorded_correction";
export type ExpectedFrom = "erecording_vendor" | "county" | "settlement_agent" | "title_underwriter" | "mi_company" | "flood_vendor" | "custodian" | "prior_servicer";
export type TrailingStatus = "expected" | "open" | "received" | "reviewed" | "defect_open" | "closed" | "waived";
export interface Followup { readonly at: string; readonly on: PlainDate; readonly channel: "portal" | "email" | "phone" | "vendor_api"; readonly to_party_id: string; readonly response: string | null; readonly next_at: PlainDate; }
export interface TrailingDocument {
  readonly id: string; readonly application_id: string; readonly loan_id: string | null; readonly kind: TrailingKind; readonly expected_from: ExpectedFrom; readonly source_party_id: string | null; readonly anchor_event: string; readonly anchor_on: PlainDate | null; readonly due_at: PlainDate | null;
  readonly received_at: string | null; readonly document_id: string | null; readonly review_status: "pending" | "passed" | "defect"; readonly defects: readonly string[]; readonly followups: readonly Followup[]; readonly escalation_id: string | null; readonly blocks: readonly ("none" | "qc_file" | "servicing_file" | "foreclosure_referral")[];
  readonly status: TrailingStatus; readonly waived_by: string | null; readonly waived_reason: string | null; readonly closed_at: string | null; readonly funded_on: PlainDate;
}
export interface TrailingProfile {
  readonly application_id: string; readonly loan_id?: string | null; readonly funded_on: PlainDate; readonly note_date: PlainDate; readonly state: string; readonly note_form: "enote" | "paper"; readonly ltv_pct: number; readonly flood_lol_on_file: boolean;
  readonly recording: { readonly channel: "erecording" | "paper"; readonly recorded_on: PlainDate | null; readonly submitted_on: PlainDate | null; readonly recording_turnaround_days?: number | null } | null;
  readonly poa_recording_required?: boolean; readonly subordination_required?: boolean; readonly cema?: boolean; readonly tx_50a6?: boolean; readonly aol?: boolean; readonly prior_lien_release_informational?: boolean;
}
/** Due dates by kind: eRecorded image +5 business_days_creditor from recording; paper +90 calendar days (county override) from submission; final policy/AOL +60 calendar days from recording; MI certificate +5 business_days_creditor from the note date; boarding-time items carry no due date. */
export function trailingDueAt(kind: TrailingKind, p: Pick<TrailingProfile, "recording" | "note_date">): { anchor_event: string; anchor_on: PlainDate | null; due_at: PlainDate | null } {
  const rec = p.recording;
  switch (kind) {
    case "recorded_security_instrument": case "recorded_assignment_to_mers": case "recorded_poa": case "recorded_subordination": case "recorded_cema_3172": case "recorded_tx_affidavit_3185": case "recorded_correction":
      if (!rec) return { anchor_event: "recording.submitted", anchor_on: null, due_at: null };
      if (rec.channel === "erecording") return { anchor_event: "recording.confirmed", anchor_on: rec.recorded_on, due_at: rec.recorded_on ? addBusinessDays(rec.recorded_on, RECORDED_SI_ERECORD_BD, creditor) : null };
      return { anchor_event: "recording.submitted", anchor_on: rec.submitted_on, due_at: rec.submitted_on ? addDays(rec.submitted_on, rec.recording_turnaround_days ?? RECORDED_SI_PAPER_DAYS) : null };
    case "final_title_policy": case "final_aol": return { anchor_event: "recording.confirmed", anchor_on: rec?.recorded_on ?? null, due_at: rec?.recorded_on ? addDays(rec.recorded_on, FINAL_POLICY_DAYS) : null };
    case "mi_certificate": return { anchor_event: "loan.funded", anchor_on: p.note_date, due_at: addBusinessDays(p.note_date, 5, creditor) };
    default: return { anchor_event: "loan.funded", anchor_on: null, due_at: null };
  }
}
const FROM: Record<TrailingKind, ExpectedFrom> = { recorded_security_instrument: "erecording_vendor", final_title_policy: "title_underwriter", recorded_assignment: "county", mi_certificate: "mi_company", flood_cert: "flood_vendor", recorded_poa: "county", recorded_subordination: "county", recorded_cema_3172: "county", recorded_tx_affidavit_3185: "county", recorded_assignment_to_mers: "county", recorded_release_prior_lien: "prior_servicer", final_aol: "settlement_agent", custodian_trust_receipt: "custodian", custodian_certification: "custodian", recorded_correction: "county" };
/** The expected-document set from the document-set profile at `loan.funded` → one `trailing_document.expected{kinds, funded_on}` (arms SM_O74_TRAILING_DOC_ESCALATE_120 on the funding date) and `trailing_document.opened{kind, due_at}` per item with a due date. */
export function expectTrailingDocuments(events: EventStore, p: TrailingProfile, at: string): { rows: TrailingDocument[]; events: readonly DomainEvent[] } {
  const kinds: TrailingKind[] = ["recorded_security_instrument", p.aol ? "final_aol" : "final_title_policy", "flood_cert"];
  if (p.ltv_pct > 80) kinds.push("mi_certificate");
  if (NON_MOM_STATES.includes(p.state.toUpperCase())) kinds.push("recorded_assignment_to_mers");
  if (p.poa_recording_required) kinds.push("recorded_poa"); if (p.subordination_required) kinds.push("recorded_subordination"); if (p.cema) kinds.push("recorded_cema_3172"); if (p.tx_50a6) kinds.push("recorded_tx_affidavit_3185"); if (p.prior_lien_release_informational) kinds.push("recorded_release_prior_lien");
  if (p.note_form === "paper") kinds.push("custodian_trust_receipt"); kinds.push("custodian_certification");
  const k = { application_id: p.application_id, loan_id: p.loan_id ?? null };
  const rows: TrailingDocument[] = kinds.map((kind) => { const d = trailingDueAt(kind, p); const src = kind === "recorded_security_instrument" && p.recording?.channel === "paper" ? "county" : FROM[kind];
    return { id: `${p.application_id}:${kind}`, application_id: p.application_id, loan_id: p.loan_id ?? null, kind, expected_from: src, source_party_id: null, anchor_event: d.anchor_event, anchor_on: d.anchor_on, due_at: d.due_at, received_at: kind === "flood_cert" && p.flood_lol_on_file ? at : null, document_id: null, review_status: "pending", defects: [], followups: [], escalation_id: null,
      blocks: kind === "recorded_security_instrument" || kind === "final_title_policy" || kind === "final_aol" ? ["qc_file", "servicing_file", "foreclosure_referral"] : ["servicing_file"], status: d.due_at ? "open" : "expected", waived_by: null, waived_reason: null, closed_at: null, funded_on: p.funded_on }; });
  const evs: DomainEvent[] = [emit(events, k, "trailing_document.expected", { kinds, count: kinds.length, funded_on: p.funded_on, escalate_on: addDays(p.funded_on, TRAILING_ESCALATE_DAYS), note_form: p.note_form }, at)];
  for (const r of rows) if (r.due_at) evs.push(emit(events, k, "trailing_document.opened", { trailing_document_id: r.id, kind: r.kind, expected_from: r.expected_from, anchor_event: r.anchor_event, anchor_on: r.anchor_on, due_at: r.due_at }, at));
  return { rows, events: evs };
}
const keysOf = (r: TrailingDocument): Keys => ({ application_id: r.application_id, loan_id: r.loan_id });
/** A recording anchor learned after the set was created (paper county, late recording) → `open` with its due date. */
export function openTrailingDocument(events: EventStore, r: TrailingDocument, p: Pick<TrailingProfile, "recording" | "note_date">, at: string): { row: TrailingDocument; event: DomainEvent | null } {
  const d = trailingDueAt(r.kind, p); if (!d.due_at) return { row: r, event: null };
  const row: TrailingDocument = { ...r, anchor_event: d.anchor_event, anchor_on: d.anchor_on, due_at: d.due_at, status: r.status === "expected" ? "open" : r.status };
  return { row, event: emit(events, keysOf(r), "trailing_document.opened", { trailing_document_id: r.id, kind: r.kind, expected_from: r.expected_from, anchor_event: d.anchor_event, anchor_on: d.anchor_on, due_at: d.due_at }, at) };
}
export function receiveTrailingDocument(events: EventStore, r: TrailingDocument, i: { document_id: string; received_at: string; from_party_id?: string | null }): { row: TrailingDocument; event: DomainEvent } {
  if (r.status === "closed" || r.status === "waived") throw new PostClosingRefused("TRAILING_TERMINAL", "26.4 state machine", `${r.kind} is ${r.status}`);
  const row: TrailingDocument = { ...r, status: "received", received_at: i.received_at, document_id: i.document_id, source_party_id: i.from_party_id ?? r.source_party_id };
  return { row, event: emit(events, keysOf(r), "trailing_document.received", { trailing_document_id: r.id, kind: r.kind, document_id: i.document_id, received_at: i.received_at, on_time: r.due_at ? i.received_at.slice(0, 10) <= r.due_at : true }, i.received_at) };
}
/** Guard: `closed` for the recorded security instrument requires a passed recorded_instrument_reviews row; for the final policy a passed final_policy_reviews row — never without a passed review. Emits `trailing_document.closed` and, when every item is closed/waived, `collateral.file.complete` (30.4 seeds the servicing file). */
export function closeTrailingDocument(events: EventStore, rows: readonly TrailingDocument[], r: TrailingDocument, at: string): { row: TrailingDocument; rows: TrailingDocument[]; events: readonly DomainEvent[]; file_complete: boolean } {
  if (r.review_status !== "passed") throw new PostClosingRefused("CLOSE_WITHOUT_PASSED_REVIEW", "26.4 guardrails: never close a trailing document without a passed review", `${r.kind} review_status=${r.review_status}`);
  const row: TrailingDocument = { ...r, status: "closed", closed_at: at };
  const out = rows.map((x) => (x.id === r.id ? row : x));
  const evs = [emit(events, keysOf(r), "trailing_document.closed", { trailing_document_id: r.id, kind: r.kind, closed_at: at, document_id: r.document_id }, at)];
  const file_complete = out.every((x) => x.status === "closed" || x.status === "waived");
  if (file_complete) evs.push(emit(events, keysOf(r), "collateral.file.complete", { completed_at: at, kinds: out.map((x) => x.kind), waived: out.filter((x) => x.status === "waived").map((x) => x.kind) }, at));
  return { row, rows: out, events: evs, file_complete };
}
/** Waived only by `officer` with a reason — except the system waiver `loan_cancelled` (rule 10). */
export function waiveTrailingDocument(events: EventStore, r: TrailingDocument, i: { by: Actor; reason: string; at: string }): { row: TrailingDocument; event: DomainEvent } {
  if (i.reason !== "loan_cancelled" && !(i.by.kind === "human" && i.by.role === "officer")) throw new PostClosingRefused("WAIVER_OFFICER_ONLY", "26.4 guardrails: never waive a document (`officer` only)", `waiver by ${i.by.kind}:${i.by.id}`);
  const row: TrailingDocument = { ...r, status: "waived", waived_by: i.reason === "loan_cancelled" && i.by.kind !== "human" ? "system" : i.by.id, waived_reason: i.reason, closed_at: i.at };
  return { row, event: emit(events, keysOf(r), "trailing_document.waived", { trailing_document_id: r.id, kind: r.kind, reason: i.reason, waived_by: row.waived_by, waived_at: i.at }, i.at, i.by) };
}
/** The follow-up cadence from the due date: due, +30, +60 … through `through` (fixture: Jan 8, Feb 7, Mar 9, 2027). */
export function followupSchedule(dueAt: PlainDate, through: PlainDate): PlainDate[] {
  const out: PlainDate[] = []; for (let d = dueAt; d <= through; d = addDays(d, TRAILING_FOLLOWUP_DAYS)) out.push(d); return out;
}
/** A logged follow-up (portal/vendor API first, then e-mail, then phone) → `trailing_document.followup.logged{next_at}`; `next_at` = +30 calendar days. */
export function followUp(events: EventStore, r: TrailingDocument, f: { at: string; channel: Followup["channel"]; to_party_id: string; response?: string | null }): { row: TrailingDocument; event: DomainEvent } {
  if (r.status !== "open" && r.status !== "defect_open" && r.status !== "expected") throw new PostClosingRefused("FOLLOWUP_STATE", "26.4 follow-up ladder applies to open / defect_open items", `${r.kind} is ${r.status}`);
  const on = D(f.at.slice(0, 10)); const fu: Followup = { at: f.at, on, channel: f.channel, to_party_id: f.to_party_id, response: f.response ?? null, next_at: addDays(on, TRAILING_FOLLOWUP_DAYS) };
  const row: TrailingDocument = { ...r, followups: [...r.followups, fu] };
  return { row, event: emit(events, keysOf(r), "trailing_document.followup.logged", { trailing_document_id: r.id, kind: r.kind, attempt: row.followups.length, channel: f.channel, to_party_id: f.to_party_id, at: f.at, on, next_at: fu.next_at }, f.at) };
}
export interface SweepResult { readonly overdue: readonly DomainEvent[]; readonly escalate_120: readonly TrailingDocument[]; readonly certified_copy_180: readonly TrailingDocument[]; readonly events: readonly DomainEvent[]; }
/** 07:00 daily sweep: open/defect_open items past due → `trailing_document.overdue{last_followup_on}` (arms SM_O74_TRAILING_DOC_FOLLOWUP_30); funding + 120 days with any open item → `trailing_document.escalation_120` (sev 2 `officer`) and `qc.file.flagged{process=28.2}`; + 180 → certified-copy / underwriter-CPL path. */
export function sweepTrailingDocuments(events: EventStore, rows: readonly TrailingDocument[], today: PlainDate, at: string): SweepResult {
  const open = rows.filter((r) => r.status === "open" || r.status === "defect_open"); const evs: DomainEvent[] = []; const overdue: DomainEvent[] = [];
  for (const r of open) if (r.due_at && r.due_at < today) { const last = r.followups.at(-1); overdue.push(emit(events, keysOf(r), "trailing_document.overdue", { trailing_document_id: r.id, kind: r.kind, due_at: r.due_at, days_past_due: daysBetween(r.due_at, today), attempts: r.followups.length, last_followup_on: last?.on ?? r.due_at, next_followup_on: last?.next_at ?? r.due_at }, at)); }
  evs.push(...overdue);
  const funded_on = rows[0]?.funded_on; const esc = funded_on && daysBetween(funded_on, today) >= TRAILING_ESCALATE_DAYS ? open : [];
  if (esc.length) { const k = keysOf(esc[0]!); evs.push(emit(events, k, "trailing_document.escalation_120", { kinds: esc.map((r) => r.kind), funded_on, days_since_funding: daysBetween(funded_on!, today), severity: "sev2", escalate_to: "officer", attempts: Object.fromEntries(esc.map((r) => [r.kind, r.followups.length])) }, at)); evs.push(emit(events, k, "qc.file.flagged", { process: "28.2", reason: "trailing_documents_open_120", kinds: esc.map((r) => r.kind), flagged_on: today }, at)); }
  const cc = funded_on && daysBetween(funded_on, today) >= TRAILING_CERTIFIED_COPY_DAYS ? open : [];
  return { overdue, escalate_120: esc, certified_copy_180: cc, events: evs };
}

// ============================================================ rule 6: recorded security instrument
export interface RecordedImageInput {
  readonly recording_id: string; readonly trailing_document_id: string; readonly executed_document_id: string; readonly recorded_image_document_id: string; readonly executed_pages: number; readonly executed_rider_count: number; readonly image_pages: number; readonly image_rider_count: number;
  readonly legal_description_hash_executed: string; readonly legal_description_hash_image: string; readonly names_vesting_match: boolean; readonly min_on_page_1: boolean; readonly mers_nominee_paragraph: boolean; readonly nmlsr_block: boolean;
  readonly notary: { readonly venue: boolean; readonly date: boolean; readonly name: boolean; readonly commission: boolean; readonly seal: boolean }; readonly ron: boolean; readonly ron_statement: boolean; readonly recording_stamp: boolean; readonly instrument_number: string | null; readonly county_expected: string; readonly county_on_stamp: string; readonly signatures_initials_present: boolean; readonly date_match: boolean; readonly image_legible?: boolean;
  readonly mers_rider_required?: boolean; readonly mers_rider_recorded?: boolean; readonly rerecording_method?: RerecordCure | null; readonly county_image_incomplete?: boolean;
}
export type DefectKind = "legal_description" | "missing_rider" | "notary_defect" | "wrong_county" | "missing_pages" | "name_error" | "min_missing" | "image_illegible" | "other";
export type RerecordCure = "rerecord" | "corrective_instrument" | "scriveners_affidavit" | "county_correction" | "certified_copy_request" | "none";
export interface RecordedInstrumentReview { readonly id: string; readonly recording_id: string; readonly trailing_document_id: string; readonly executed_document_id: string; readonly recorded_image_document_id: string; readonly checks: Record<string, boolean>; readonly result: "pass" | "defect"; readonly defect_kind: DefectKind | null; readonly cure: RerecordCure; readonly cure_submitted_at: string | null; readonly cured_at: string | null; readonly title_underwriter_notified_at: string | null; }
/** Cure by defect kind and the county's `rerecording_method`: an incomplete county image → county correction; legal description / granting language → corrective instrument re-signed by the borrower (26.2 session); notary / stamping → re-record with a scrivener's affidavit or the county's method; illegible → certified copy; a wrong MIN is an identifier, not a term (counsel; no re-recording). */
export function cureFor(kind: DefectKind, i: { county_image_incomplete?: boolean; rerecording_method?: RerecordCure | null }): RerecordCure {
  switch (kind) {
    case "missing_rider": case "missing_pages": return i.county_image_incomplete !== false ? "county_correction" : (i.rerecording_method ?? "rerecord");
    case "legal_description": case "name_error": return "corrective_instrument";
    case "notary_defect": return i.rerecording_method ?? "scriveners_affidavit";
    case "wrong_county": return "rerecord";
    case "image_illegible": return "certified_copy_request";
    case "min_missing": return "none";
    default: return i.rerecording_method ?? "rerecord";
  }
}
/** Recorded-image checklist (page count = executed + riders, legal description hash, names/vesting, MIN + nominee paragraph, NMLSR block, notary certificate + RON statement, stamp/instrument number/county, riders incl. MERS Rider in MT/OR/WA) → pass | defect{kind}. */
export function reviewRecordedInstrument(i: RecordedImageInput): RecordedInstrumentReview {
  const n = i.notary; const notary_ok = n.venue && n.date && n.name && n.commission && n.seal;
  const checks: Record<string, boolean> = { legal_description_hash_match: i.legal_description_hash_executed === i.legal_description_hash_image, names_vesting_match: i.names_vesting_match, min_present: i.min_on_page_1, mers_nominee_language_present: i.mers_nominee_paragraph, nmlsr_block_present: i.nmlsr_block, notary_certificate_complete: notary_ok, ron_statement_present_if_ron: !i.ron || i.ron_statement,
    riders_attached_count_match: i.image_rider_count === i.executed_rider_count && (!i.mers_rider_required || i.mers_rider_recorded === true), page_count_match: i.image_pages === i.executed_pages, recording_stamp_present: i.recording_stamp, instrument_number_captured: !!i.instrument_number, county_correct: norm(i.county_on_stamp) === norm(i.county_expected), signatures_initials_present: i.signatures_initials_present, date_match: i.date_match, image_legible: i.image_legible !== false };
  let defect_kind: DefectKind | null = null;
  if (!checks.image_legible) defect_kind = "image_illegible";
  else if (!checks.riders_attached_count_match) defect_kind = "missing_rider";
  else if (!checks.page_count_match) defect_kind = "missing_pages";
  else if (!checks.legal_description_hash_match) defect_kind = "legal_description";
  else if (!checks.names_vesting_match) defect_kind = "name_error";
  else if (!checks.notary_certificate_complete || !checks.ron_statement_present_if_ron) defect_kind = "notary_defect";
  else if (!checks.county_correct) defect_kind = "wrong_county";
  else if (!checks.min_present) defect_kind = "min_missing";
  else if (Object.values(checks).some((v) => !v)) defect_kind = "other";
  const result = defect_kind ? "defect" : "pass";
  return { id: `${i.recording_id}:review`, recording_id: i.recording_id, trailing_document_id: i.trailing_document_id, executed_document_id: i.executed_document_id, recorded_image_document_id: i.recorded_image_document_id, checks, result, defect_kind, cure: defect_kind ? cureFor(defect_kind, i) : "none", cure_submitted_at: null, cured_at: null, title_underwriter_notified_at: null };
}
/** Recorded image / certified copy in hand → `recording.image.received{received_on}` (satisfies SM_O74_RECORDED_SI_ERECORD_5BD / SM_O74_RECORDED_SI_PAPER_90; arms SM_O74_RECORDED_SI_REVIEW_2BD). */
export function ingestRecordedImage(events: EventStore, r: TrailingDocument, i: { recording_id: string; document_id: string; received_at: string; time_zone: string; certified_copy?: boolean; instrument_number?: string | null }): { row: TrailingDocument; events: readonly DomainEvent[]; review_due_on: PlainDate } {
  const rec = receiveTrailingDocument(events, r, { document_id: i.document_id, received_at: i.received_at, from_party_id: null });
  const received_on = localDate(i.received_at, i.time_zone); const review_due_on = addBusinessDays(received_on, 2, creditor);
  const e = emit(events, keysOf(r), "recording.image.received", { recording_id: i.recording_id, trailing_document_id: r.id, kind: r.kind, document_id: i.document_id, received_at: i.received_at, received_on, certified_copy: i.certified_copy ?? false, original_or_certified: true, instrument_number: i.instrument_number ?? null, review_due_on }, i.received_at);
  return { row: rec.row, events: [rec.event, e], review_due_on };
}
/** The review outcome on the row: pass → `trailing_document.reviewed{result=pass}` (closeable); defect → `trailing_document.reviewed{result=defect}` + `trailing_document.defect{kind, defect_kind, defect_on}` (arms SM_O74_RERECORD_CURE_10BD; title underwriter notified for coverage). */
export function recordRecordedInstrumentReview(events: EventStore, r: TrailingDocument, review: RecordedInstrumentReview, i: { reviewed_at: string; time_zone: string; title_underwriter_party_id?: string | null }): { row: TrailingDocument; review: RecordedInstrumentReview; events: readonly DomainEvent[]; cure_due_on: PlainDate | null } {
  const k = keysOf(r); const on = localDate(i.reviewed_at, i.time_zone);
  const e1 = emit(events, k, "trailing_document.reviewed", { trailing_document_id: r.id, kind: r.kind, result: review.result, defect_kind: review.defect_kind, checks: review.checks, reviewed_at: i.reviewed_at, reviewed_on: on, review_id: review.id }, i.reviewed_at);
  if (review.result === "pass") return { row: { ...r, status: "reviewed", review_status: "passed" }, review, events: [e1], cure_due_on: null };
  const cure_due_on = addBusinessDays(on, RERECORD_CURE_BD, creditor);
  const out: RecordedInstrumentReview = { ...review, title_underwriter_notified_at: i.reviewed_at };
  const e2 = emit(events, k, "trailing_document.defect", { trailing_document_id: r.id, kind: r.kind, defect_kind: review.defect_kind, cure: review.cure, defect_at: i.reviewed_at, defect_on: on, cure_due_on, title_underwriter_notified: true, title_underwriter_party_id: i.title_underwriter_party_id ?? null, review_id: review.id }, i.reviewed_at);
  return { row: { ...r, status: "defect_open", review_status: "defect", defects: [...r.defects, review.defect_kind!] }, review: out, events: [e1, e2], cure_due_on };
}
/** Corrective instrument / scrivener's affidavit / county correction submitted → `recording.rerecord.requested` (satisfies SM_O74_RERECORD_CURE_10BD); a corrected image then re-enters review. */
export function requestRerecording(events: EventStore, r: TrailingDocument, review: RecordedInstrumentReview, i: { submitted_at: string; time_zone: string; package_ref: string; borrower_session_required?: boolean }): { review: RecordedInstrumentReview; event: DomainEvent } {
  if (review.result !== "defect" || review.cure === "none") throw new PostClosingRefused("NO_CURE_TO_SUBMIT", "26.4 rule 6: re-recording follows a defect with a cure path", `review ${review.id} result=${review.result} cure=${review.cure}`);
  const out: RecordedInstrumentReview = { ...review, cure_submitted_at: i.submitted_at };
  return { review: out, event: emit(events, keysOf(r), "recording.rerecord.requested", { trailing_document_id: r.id, review_id: review.id, cure: review.cure, defect_kind: review.defect_kind, package_ref: i.package_ref, submitted_at: i.submitted_at, submitted_on: localDate(i.submitted_at, i.time_zone), borrower_session_required: i.borrower_session_required ?? (review.cure === "corrective_instrument") }, i.submitted_at) };
}

// ============================================================ rule 7: final title policy (B7-2-03)
export type PolicyKind = "alta_2021_loan" | "alta_2006_loan" | "state_form" | "short_form" | "aol";
export interface FinalPolicyInput {
  readonly title_order_id: string; readonly trailing_document_id: string; readonly policy_kind: PolicyKind; readonly policy_number: string; readonly date_of_policy: string; readonly insured_text: string; readonly amount_cents: Cents;
  readonly schedule_a: { readonly vesting_match: boolean; readonly legal_description_match: boolean; readonly instrument_number: string | null; readonly recorded_on: PlainDate | null };
  readonly schedule_b: { readonly expected_removed: readonly string[]; readonly present: readonly string[]; readonly new_exceptions: readonly string[] };
  readonly endorsements_issued: readonly string[]; readonly creditors_rights_exclusion_present: boolean; readonly gap_exception_present?: boolean;
}
export interface FinalPolicyExpectations { readonly partner_legal_name: string; readonly original_principal_cents: Cents; readonly recording: { readonly instrument_number: string; readonly recorded_on: PlainDate }; readonly required_endorsements: readonly string[]; readonly tx_50a6?: boolean; readonly originated_on: PlainDate; }
export interface FinalPolicyReview {
  readonly id: string; readonly title_order_id: string; readonly trailing_document_id: string; readonly policy_kind: PolicyKind; readonly policy_number: string; readonly date_of_policy: string; readonly insured_text: string; readonly insured_ok: boolean; readonly amount_cents: Cents; readonly amount_ok: boolean; readonly schedule_a_ok: boolean;
  readonly schedule_b_diff: FinalPolicyInput["schedule_b"]; readonly endorsements_issued: readonly string[]; readonly endorsements_ok: boolean; readonly creditors_rights_exclusion_absent: boolean; readonly gap_ok: boolean; readonly policy_form_ok: boolean; readonly result: "pass" | "defect"; readonly defects: readonly string[]; readonly correction_requested_at: string | null; readonly corrected_policy_document_id: string | null; readonly closed_at: string | null;
}
const normEndorsement = (e: string): string => e.toUpperCase().replace(/\s+/g, "").replace(/^ALTA/, "");
/** Insured = the partner "its successors and/or assigns as their interests may appear" (ISAOA/ATIMA) — under no circumstances MERS (B7-2-03). */
export function insuredOk(insuredText: string, partnerLegalName: string): { ok: boolean; reason: string | null } {
  if (/mortgage electronic registration systems|\bMERS\b/i.test(insuredText)) return { ok: false, reason: "insured names MERS — B7-2-03: under no circumstances may MERS be named as the insured" };
  if (!insuredText.toLowerCase().includes(partnerLegalName.toLowerCase())) return { ok: false, reason: `insured does not name the partner ${partnerLegalName}` };
  if (!/successors and\/?or assigns|isaoa/i.test(insuredText)) return { ok: false, reason: "insured lacks 'its successors and/or assigns as their interests may appear'" };
  return { ok: true, reason: null };
}
export function reviewFinalPolicy(p: FinalPolicyInput, x: FinalPolicyExpectations): FinalPolicyReview {
  const defects: string[] = [];
  const policy_form_ok = p.policy_kind === "aol" || x.originated_on < ALTA_2021_MANDATORY_FROM || p.policy_kind === "alta_2021_loan";
  if (!policy_form_ok) defects.push(`policy_form: ${p.policy_kind} — B7-2-03 requires the 2021 ALTA Loan Policy for loans originated on/after ${ALTA_2021_MANDATORY_FROM}`);
  const ins = insuredOk(p.insured_text, x.partner_legal_name); if (!ins.ok) defects.push(`insured: ${ins.reason}`);
  const amount_ok = p.amount_cents >= x.original_principal_cents; if (!amount_ok) defects.push(`amount_below_principal: ${p.amount_cents} < original principal ${x.original_principal_cents} (B7-2-03: coverage must at least equal the original principal amount)`);
  const schedule_a_ok = p.schedule_a.vesting_match && p.schedule_a.legal_description_match && p.schedule_a.instrument_number === x.recording.instrument_number && p.schedule_a.recorded_on === x.recording.recorded_on;
  if (!schedule_a_ok) defects.push("schedule_a: vesting / legal description / insured mortgage recording data do not match the recorded instrument");
  const removedOk = p.schedule_b.expected_removed.every((e) => !p.schedule_b.present.includes(e)); const newOk = p.schedule_b.new_exceptions.length === 0;
  if (!removedOk) defects.push(`schedule_b: requirement(s) not removed: ${p.schedule_b.expected_removed.filter((e) => p.schedule_b.present.includes(e)).join(", ")}`); if (!newOk) defects.push(`schedule_b: new exception(s): ${p.schedule_b.new_exceptions.join(", ")}`);
  const issued = new Set(p.endorsements_issued.map(normEndorsement)); const required = [...new Set([...x.required_endorsements, "ALTA 8.1", ...(x.tx_50a6 ? ["T-42", "T-42.1"] : [])])];
  const missing = required.filter((e) => !issued.has(normEndorsement(e))); const endorsements_ok = p.policy_kind === "aol" || missing.length === 0;
  if (!endorsements_ok) defects.push(`endorsements_missing: ${missing.join(", ")}`);
  const creditors_rights_exclusion_absent = !p.creditors_rights_exclusion_present; if (!creditors_rights_exclusion_absent) defects.push("creditors_rights_exclusion: the 1990 creditors'-rights exclusion is not acceptable (B7-2-03)");
  const dop = D(p.date_of_policy.slice(0, 10)); const gap_ok = dop >= x.recording.recorded_on || ((p.policy_kind === "alta_2021_loan" || p.policy_kind === "alta_2006_loan") && !p.gap_exception_present);
  if (!gap_ok) defects.push(`date_of_policy ${dop} precedes recording ${x.recording.recorded_on} with a gap exception`);
  return { id: `${p.title_order_id}:final_policy_review`, title_order_id: p.title_order_id, trailing_document_id: p.trailing_document_id, policy_kind: p.policy_kind, policy_number: p.policy_number, date_of_policy: p.date_of_policy, insured_text: p.insured_text, insured_ok: ins.ok, amount_cents: p.amount_cents, amount_ok, schedule_a_ok, schedule_b_diff: p.schedule_b, endorsements_issued: p.endorsements_issued, endorsements_ok, creditors_rights_exclusion_absent, gap_ok, policy_form_ok, result: defects.length ? "defect" : "pass", defects, correction_requested_at: null, corrected_policy_document_id: null, closed_at: null };
}
/** Final policy / AOL from the underwriter or agent → `title.final_policy.received{received_on}` (satisfies SM_O74_FINAL_TITLE_POLICY_60; arms SM_O74_FINAL_POLICY_REVIEW_2BD). */
export function ingestFinalPolicy(events: EventStore, r: TrailingDocument, i: { title_order_id: string; document_id: string; received_at: string; time_zone: string; from_party_id?: string | null; policy_number?: string | null }): { row: TrailingDocument; events: readonly DomainEvent[]; review_due_on: PlainDate } {
  const rec = receiveTrailingDocument(events, r, { document_id: i.document_id, received_at: i.received_at, from_party_id: i.from_party_id ?? null });
  const received_on = localDate(i.received_at, i.time_zone); const review_due_on = addBusinessDays(received_on, 2, creditor);
  return { row: rec.row, review_due_on, events: [rec.event, emit(events, keysOf(r), "title.final_policy.received", { title_order_id: i.title_order_id, trailing_document_id: r.id, kind: r.kind, document_id: i.document_id, policy_number: i.policy_number ?? null, received_at: i.received_at, received_on, review_due_on, on_time: r.due_at ? received_on <= r.due_at : true }, i.received_at, { kind: "external", id: i.from_party_id ?? "title_underwriter" })] };
}
/** Review outcome → `title.final_policy.reviewed{result}` (satisfies SM_O74_FINAL_POLICY_REVIEW_2BD); pass → row `reviewed/passed` (closeable); defect → `title.final_policy.defect` + `title.final_policy.correction_requested{next_followup_on}` on the 30-day cadence; unresolved at 120 days → `officer`. */
export function recordFinalPolicyReview(events: EventStore, r: TrailingDocument, review: FinalPolicyReview, i: { reviewed_at: string; time_zone: string; underwriter_party_id: string }): { row: TrailingDocument; review: FinalPolicyReview; events: readonly DomainEvent[] } {
  const k = keysOf(r); const on = localDate(i.reviewed_at, i.time_zone);
  const e1 = emit(events, k, "title.final_policy.reviewed", { trailing_document_id: r.id, review_id: review.id, result: review.result, defects: review.defects, policy_kind: review.policy_kind, amount_cents: String(review.amount_cents), reviewed_at: i.reviewed_at, reviewed_on: on }, i.reviewed_at);
  if (review.result === "pass") return { row: { ...r, status: "reviewed", review_status: "passed" }, review, events: [e1] };
  const e2 = emit(events, k, "title.final_policy.defect", { trailing_document_id: r.id, review_id: review.id, defects: review.defects, defect_on: on }, i.reviewed_at);
  const req = requestPolicyCorrection(events, r, review, { requested_at: i.reviewed_at, time_zone: i.time_zone, underwriter_party_id: i.underwriter_party_id });
  return { row: { ...req.row, status: "defect_open", review_status: "defect", defects: [...r.defects, ...review.defects] }, review: req.review, events: [e1, e2, req.event] };
}
export function requestPolicyCorrection(events: EventStore, r: TrailingDocument, review: FinalPolicyReview, i: { requested_at: string; time_zone: string; underwriter_party_id: string }): { row: TrailingDocument; review: FinalPolicyReview; event: DomainEvent } {
  const on = localDate(i.requested_at, i.time_zone); const next_followup_on = addDays(on, TRAILING_FOLLOWUP_DAYS);
  const fu: Followup = { at: i.requested_at, on, channel: "vendor_api", to_party_id: i.underwriter_party_id, response: null, next_at: next_followup_on };
  const out: FinalPolicyReview = { ...review, correction_requested_at: i.requested_at };
  return { row: { ...r, followups: [...r.followups, fu] }, review: out, event: emit(events, keysOf(r), "title.final_policy.correction_requested", { trailing_document_id: r.id, review_id: review.id, defects: review.defects, to_party_id: i.underwriter_party_id, requested_at: i.requested_at, requested_on: on, followup_cadence_days: TRAILING_FOLLOWUP_DAYS, next_followup_on, officer_escalation_on: addDays(r.funded_on, TRAILING_ESCALATE_DAYS) }, i.requested_at) };
}
/** Corrected policy / endorsement issued → `title.final_policy.corrected` and the row back to `received` for re-review. */
export function recordCorrectedPolicy(events: EventStore, r: TrailingDocument, review: FinalPolicyReview, i: { corrected_policy_document_id: string; received_at: string }): { row: TrailingDocument; review: FinalPolicyReview; event: DomainEvent } {
  return { row: { ...r, status: "received", document_id: i.corrected_policy_document_id, received_at: i.received_at }, review: { ...review, corrected_policy_document_id: i.corrected_policy_document_id }, event: emit(events, keysOf(r), "title.final_policy.corrected", { trailing_document_id: r.id, review_id: review.id, corrected_policy_document_id: i.corrected_policy_document_id, received_at: i.received_at }, i.received_at) };
}

// ============================================================ rule 9: eNote custody until purchase (`reconcileEnoteCustody`)
export interface EnoteCustodyFacts { readonly enote_id: string; readonly min: string; readonly evault_hash: string; readonly eregistry_hash: string; readonly controller_org_id: string; readonly location_org_id: string; readonly secured_party_org_id: string | null; readonly delegatee_org_id: string | null; readonly unexpected_notifications: readonly string[]; }
/** Daily: eVault tamper-seal hash = eRegistry hash, no unexpected Change Data / Transfer notification → `enote.custody.hash_verified`; a mismatch → sev 1 `officer`, 27.1's `warehouse.collateral.defect_recorded{source=eregistry_mismatch}` (collateral `defect`) and no delivery request is prepared. */
export function dailyEnoteHashCheck(events: EventStore, k: Keys, f: EnoteCustodyFacts, i: { checked_at: string; advance_id?: string | null }): { ok: boolean; delivery_request_blocked: boolean; escalation: { kind: "officer"; severity: "sev1" } | null; events: readonly DomainEvent[] } {
  const mismatch: string[] = [];
  if (f.evault_hash !== f.eregistry_hash) mismatch.push("hash");
  if (f.unexpected_notifications.length) mismatch.push(`notifications: ${f.unexpected_notifications.join(", ")}`);
  if (!mismatch.length) return { ok: true, delivery_request_blocked: false, escalation: null, events: [emit(events, k, "enote.custody.hash_verified", { enote_id: f.enote_id, min: f.min, hash: f.evault_hash, secured_party_org_id: f.secured_party_org_id, checked_at: i.checked_at }, i.checked_at)] };
  const e1 = emit(events, k, "enote.custody.mismatch", { enote_id: f.enote_id, min: f.min, evault_hash: f.evault_hash, eregistry_hash: f.eregistry_hash, mismatch, checked_at: i.checked_at, severity: "sev1", escalate_to: "officer", delivery_request_blocked: true }, i.checked_at);
  const e2 = emit(events, k, "warehouse.collateral.defect_recorded", { advance_id: i.advance_id ?? null, defect_id: `${f.enote_id}:eregistry_mismatch:${i.checked_at.slice(0, 10)}`, source: "eregistry_mismatch", recorded_at: i.checked_at, description: `eVault hash ≠ eRegistry hash for MIN ${f.min}`, cure_due_at: addBusinessDays(D(i.checked_at.slice(0, 10)), 10, servicer), cure_owner: "post-closing", collateral_status: "defect" }, i.checked_at);
  return { ok: false, delivery_request_blocked: true, escalation: { kind: "officer", severity: "sev1" }, events: [e1, e2] };
}
export interface EregistryReconRow { readonly min: string; readonly sor: { controller_org_id: string; location_org_id: string; secured_party_org_id: string | null }; readonly registry: { controller_org_id: string; location_org_id: string; secured_party_org_id: string | null }; readonly hash_match: boolean; }
/** 1st of month → `mers.reconciliation.opened{scope}` (arms the monthly rows; `source=origination` so the population-level clock arms under the origination rule). */
export function openMonthlyReconciliation(events: EventStore, scope: "eregistry" | "mers_system", asOf: PlainDate, at: string): DomainEvent {
  return events.append({ type: "mers.reconciliation.opened", actor: POST_CLOSING_AGENT, occurredAt: at, payload: { scope, as_of: asOf, source: "origination", period_start: asOf } });
}
/** Monthly eVault ↔ eRegistry reconciliation of every eNote in Location (hash, Controller, Location, Secured Party) → `enote.custody.reconciled{scope=eregistry, variances}`; variances → `officer`, MERS QA record. */
export function reconcileEregistry(events: EventStore, rows: readonly EregistryReconRow[], i: { as_of: PlainDate; at: string }): { variances: readonly { min: string; field: string; sor: string | null; registry: string | null }[]; event: DomainEvent } {
  const variances: { min: string; field: string; sor: string | null; registry: string | null }[] = [];
  for (const r of rows) { for (const f of ["controller_org_id", "location_org_id", "secured_party_org_id"] as const) if (r.sor[f] !== r.registry[f]) variances.push({ min: r.min, field: f, sor: r.sor[f], registry: r.registry[f] }); if (!r.hash_match) variances.push({ min: r.min, field: "hash", sor: "evault", registry: "eregistry" }); }
  return { variances, event: events.append({ type: "enote.custody.reconciled", actor: POST_CLOSING_AGENT, occurredAt: i.at, payload: { scope: "eregistry", as_of: i.as_of, source: "origination", population: rows.length, variances: variances.length, variance_rows: variances, custody_reconciled_at: i.at, escalate_to: variances.length ? "officer" : null } }) };
}
export interface MersReconRow { readonly min: string; readonly sor: { status: string; servicer_org_id: string; subservicer_org_id: string | null; investor_org_id: string; interim_funder_org_id: string | null }; readonly mers: { status: string; servicer_org_id: string; subservicer_org_id: string | null; investor_org_id: string; interim_funder_org_id: string | null }; }
/** Monthly SOR ↔ MERS System reconciliation (status, Servicer, Subservicer, Investor — partner pre-purchase / Fannie Mae post-purchase (30.1), Interim Funder — present only while an advance is open (27.2)) → `mers.reconciliation.completed{scope=mers_system, variances}`; variances cured within 10 business_days_servicer; `officer`. */
export function reconcileMersSystem(events: EventStore, rows: readonly MersReconRow[], i: { as_of: PlainDate; at: string }): { variances: readonly { min: string; field: string; sor: string | null; mers: string | null; route: "30.1" | "27.2" | "26.4" }[]; cure_due_on: PlainDate; event: DomainEvent } {
  const variances: { min: string; field: string; sor: string | null; mers: string | null; route: "30.1" | "27.2" | "26.4" }[] = [];
  for (const r of rows) for (const f of ["status", "servicer_org_id", "subservicer_org_id", "investor_org_id", "interim_funder_org_id"] as const) if ((r.sor[f] ?? null) !== (r.mers[f] ?? null)) variances.push({ min: r.min, field: f, sor: r.sor[f] ?? null, mers: r.mers[f] ?? null, route: f === "investor_org_id" ? "30.1" : f === "interim_funder_org_id" ? "27.2" : "26.4" });
  const cure_due_on = addBusinessDays(i.as_of, MERS_VARIANCE_CURE_BD, servicer);
  return { variances, cure_due_on, event: events.append({ type: "mers.reconciliation.completed", actor: POST_CLOSING_AGENT, occurredAt: i.at, payload: { scope: "mers_system", as_of: i.as_of, source: "origination", population: rows.length, variances: variances.length, variance_rows: variances, cure_due_on, escalate_to: variances.length ? "officer" : null, rule_set: RULE_SETS.mers } }) };
}

// ============================================================ rule 10: cancelled and unwound loans (`voidCollateral`)
export interface VoidInput {
  readonly application_id: string; readonly loan_id?: string | null; readonly cause: "rescission_exercised" | "funding_cancelled" | "funding_unwound"; readonly event_at: string; readonly time_zone: string; readonly funded: boolean;
  readonly registration: Pick<MersRegistration, "min" | "status"> | null; readonly note_form: "enote" | "paper"; readonly holder_role: HolderRole | null; readonly recording: { readonly recorded: boolean; readonly instrument_number: string | null } | null; readonly trailing: readonly TrailingDocument[];
}
export interface VoidPlan {
  readonly min_action: "reversal" | "deactivation" | "none"; readonly reversal_due_on: PlainDate; readonly batch_on: PlainDate; readonly note_action: "form_2009_release_officer" | "void_and_return_settlement_agent" | "none"; readonly enote_action: "registration_reversal_26_2" | "none";
  readonly release_tracked: boolean; readonly waived: readonly TrailingKind[]; readonly officer_actions: readonly string[]; readonly rows: readonly TrailingDocument[]; readonly events: readonly DomainEvent[];
}
/** On `funding.cancelled` / `rescission.exercised` / `funding.unwind.opened`: `collateral.void.opened{event_on}` (arms SM_O74_MIN_REVERSAL_2BD: +2 business_days_creditor; reversal in the next business-day batch), the recorded instrument's release tracked as `recorded_correction`, every other trailing item `waived{loan_cancelled}`; `officer` acts only on a paper note held at the FCC (Form 2009 release). */
export function voidCollateral(events: EventStore, i: VoidInput): VoidPlan {
  const k = { application_id: i.application_id, loan_id: i.loan_id ?? null }; const event_on = localDate(i.event_at, i.time_zone);
  const reversal_due_on = addBusinessDays(event_on, MIN_REVERSAL_BD, creditor); const batch_on = addBusinessDays(event_on, 1, creditor);
  const min_action: VoidPlan["min_action"] = !i.registration || i.registration.status === "reserved" || i.registration.status === "reversed" || i.registration.status === "deactivated" ? "none" : i.funded ? "deactivation" : "reversal";
  const note_action: VoidPlan["note_action"] = i.note_form === "enote" ? "none" : i.holder_role === "fcc_bailee" || i.holder_role === "sm_designated_custodian" || i.holder_role === "fnma_custodian" ? "form_2009_release_officer" : "void_and_return_settlement_agent";
  const officer_actions = note_action === "form_2009_release_officer" ? ["Form 2009-content release request signed by the partner officer (note retrieved for voiding)"] : [];
  const evs: DomainEvent[] = [emit(events, k, "collateral.void.opened", { cause: i.cause, event_at: i.event_at, event_on, reversal_due_on, batch_on, min: i.registration?.min ?? null, min_action, note_action, enote_action: i.note_form === "enote" ? "registration_reversal_26_2" : "none", funded: i.funded }, i.event_at)];
  const rows: TrailingDocument[] = []; const waived: TrailingKind[] = [];
  for (const r of i.trailing) {
    if (r.status === "closed" || r.status === "waived") { rows.push(r); continue; }
    const w = waiveTrailingDocument(events, r, { by: POST_CLOSING_AGENT, reason: "loan_cancelled", at: i.event_at }); rows.push(w.row); waived.push(r.kind); evs.push(w.event);
  }
  const release_tracked = !!i.recording?.recorded;
  if (release_tracked) {
    const row: TrailingDocument = { id: `${i.application_id}:recorded_correction`, application_id: i.application_id, loan_id: i.loan_id ?? null, kind: "recorded_correction", expected_from: "settlement_agent", source_party_id: null, anchor_event: "collateral.void.opened", anchor_on: event_on, due_at: addBusinessDays(event_on, RECORDED_SI_ERECORD_BD, creditor), received_at: null, document_id: null, review_status: "pending", defects: [], followups: [], escalation_id: null, blocks: ["none"], status: "open", waived_by: null, waived_reason: null, closed_at: null, funded_on: i.trailing[0]?.funded_on ?? event_on };
    rows.push(row); evs.push(emit(events, k, "trailing_document.opened", { trailing_document_id: row.id, kind: row.kind, expected_from: row.expected_from, anchor_event: row.anchor_event, anchor_on: event_on, due_at: row.due_at, instrument_number: i.recording?.instrument_number ?? null, release: "deed of release / reconveyance prepared by the settlement agent; title underwriter notified" }, i.event_at));
  }
  return { min_action, reversal_due_on, batch_on, note_action, enote_action: i.note_form === "enote" ? "registration_reversal_26_2" : "none", release_tracked, waived, officer_actions, rows, events: evs };
}

// ============================================================ decision record
export interface PostClosingDecision { readonly loan_id: string | null; readonly application_id: string; readonly min: string | null; readonly anchor: Pick<MersAnchor, "anchor_kind" | "anchor_date" | "registration_due_at" | "policy_target_at"> | null; readonly rationale: string; readonly confidence: number; readonly rule_set_versions: typeof RULE_SETS; readonly model_version: string; readonly prompt_version: string; readonly action: string; }
export function decisionRecord(i: { application_id: string; loan_id?: string | null; min?: string | null; anchor?: MersAnchor | null; action: string; rationale: string; confidence?: number; model_version?: string; prompt_version?: string }): PostClosingDecision {
  return { loan_id: i.loan_id ?? null, application_id: i.application_id, min: i.min ?? null, anchor: i.anchor ? { anchor_kind: i.anchor.anchor_kind, anchor_date: i.anchor.anchor_date, registration_due_at: i.anchor.registration_due_at, policy_target_at: i.anchor.policy_target_at } : null, rationale: i.rationale, confidence: i.confidence ?? 1, rule_set_versions: RULE_SETS, model_version: i.model_version ?? "deterministic", prompt_version: i.prompt_version ?? "n/a", action: i.action };
}
