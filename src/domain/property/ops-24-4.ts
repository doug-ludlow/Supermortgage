/**
 * §24.4 Title, vesting, settlement-agent vetting, existing-lien payoffs, subordinations, and curative — the
 * `title-closing` agent's rules as small pure functions (one per rule / T-id) plus the event recorders that arm and
 * close the 24.4 timers. Bigint cents, PlainDate arithmetic, erasable TypeScript only.
 *
 * Seams (reused, never re-implemented):
 *   21.4 (src/domain/application/ops-21-4.ts) `checkFeeGate` — the §1026.19(e)(2)(i)(A) fee gate for the command
 *        `order_title` runs before every title order (orderTitleFeeGate).
 *   16.1 (src/domain/payoff/ops-16-1.ts) `payoffRequestIntake` — when the prior lien is a loan SM subservices, the
 *        payoff is requested through servicing's own written-request intake (`payoff.request.received` on the existing
 *        loan, which arms 7.6/16.1's REGZ_1026_36C3_PAYOFF_STMT_7BD); the statement arrives as 16.1's
 *        `payoff.statement.sent`. quote.ts `perDiem` reconciles the external servicer's per diem (±$0.02).
 *   3.5 (src/domain/escrow/refund.ts) `payoffRefundDue` / `refundMethod` — the §1024.34(b)(1) 20-federal-business-day
 *        refund and the (b)(2) credit election; 30.3 (src/domain/orig-boarding/ops-30-3.ts) `creditAgreementGateFacts`
 *        and its `escrow.credit_to_new_loan.posted` posting consume the treatment decided here.
 *   22.4 `subordinate_financing.declared` (ops-22-4.ts) feeds `subordinations`; 25.2 / 26.1 consume
 *        `title.commitment.received`; 30.4's tax-service activation reads the `apn` that event carries.
 *
 * Events (every one carries `applicationId` + payload.application_id so the origination timers arm — engine.ts
 * isOriginationContext):
 *   title.ordered{order_id, order_type, settlement_agent_party_id, apn}                 [satisfies SM_TITLE_ORDER_2BD]
 *   settlement_agent.assigned{settlement_agent_party_id}                                [arms SM_SETTLEMENT_AGENT_VETTING_GATE]
 *   title.commitment.received{commitment_number, apn, policy_form, vesting, legal_description_hash}   (25.2, 26.1, 30.4)
 *   title.order.rejected{reason=insurer_not_licensed}                                   (T4)
 *   title.exception.classified{classification, blocking}  title.endorsements.required{required_endorsements}
 *   title.curative.opened{kind, owner, blocks_consummation} / title.curative.cleared{resolution}
 *   title.order.status_changed{status}                                                  [status ∈ {cleared, dated_down} satisfies FNMA_B7_2_01_TITLE_EVIDENCE_GATE]
 *   title.datedown.received{effective_date, in_window}                                  [satisfies SM_TITLE_COMMITMENT_DATEDOWN_GATE]
 *   title.aol.evaluated{sfc_155} · title.aol.approved / title.aol.refused{reason}
 *   settlement_agent.vetted{vetting_status, vetting_expires_on} / settlement_agent.rejected{reasons}   [satisfies SM_SETTLEMENT_AGENT_VETTING_GATE]
 *   wire.instructions.verified{match_result, callback_number_source} / wire.instructions.change_detected{hours_to_funding, blocked}
 *                                                                                       [satisfy / re-arm SM_WIRE_VERIFICATION_GATE]
 *   cpl.received{cpl_addressee_ok, cpl_agent_ok}                                        [cpl_addressee_ok=true satisfies SM_CPL_BEFORE_FUNDING_GATE]
 *   payoff.demand.requested{same_servicer, refresh}                                     [same_servicer=false arms SM_PAYOFF_DEMAND_FOLLOWUP_7BD]
 *   payoff.statement.received{good_through_date, total_cents, covers_disbursement}       [satisfies SM_PAYOFF_DEMAND_FOLLOWUP_7BD; covers_disbursement=true satisfies SM_PAYOFF_GOOD_THROUGH_GATE]
 *   payoff.statement.stale{good_through_date, disbursement_date}
 *   payoff.escrow_treatment.decided{escrow_treatment, refund_due_on, new_initial_deposit_cents}
 *   subordination.requested{lien_kind, cltv_bps, hcltv_bps}                             [satisfies SM_SUBORDINATION_REQUEST_3BD]
 *   subordination.executed{terms_ok, recordable} / subordination.rejected{reasons}      [the former satisfies FNMA_B2_1_2_04_RESUBORDINATION_GATE]
 *   trust.reviewed{result, sfc_168} / poa.reviewed{result}
 *   vesting.reviews.completed{all_eligible}                                             [all_eligible=true satisfies SM_TRUST_POA_REVIEW_GATE]
 * Consumed: intent.to_proceed.received (21.4), closing.scheduled (26.2), funding.authorized (26.3), du.findings.received (23.2),
 *   subordinate_financing.declared (22.4), payoff.statement.sent / loan.paid_in_full (16.x), escrow.credit_to_new_loan.posted (3.5/30.3).
 */
import { randomUUID, createHash } from "node:crypto";
import { type PlainDate, addDays, addYears, daysBetween, plainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, creditor, federal } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import { perDiem as servicerPerDiem } from "../payoff/quote.ts";
import { payoffRequestIntake, type PayoffRequestReceived } from "../payoff/ops-16-1.ts";
import { payoffRefundDue, refundMethod } from "../escrow/refund.ts";
import { creditAgreementGateFacts } from "../orig-boarding/ops-30-3.ts";
import { checkFeeGate, type FeeGateFacts } from "../application/ops-21-4.ts";

export const AGENT_24_4: Actor = { kind: "agent", id: "title-closing" };
export const RULE_SET_VERSION_24_4 = "fnma.selling.2026-09-02";
export const SFC_AOL = "155", SFC_TRUST = "168", SFC_TX_50A6 = "304";
/** Policy defaults (open questions 24.4-Q2/Q3/Q5): commitment window, E&O / fidelity floors, wire-change freeze. */
export const COMMITMENT_WINDOW_DAYS = 30, WIRE_VERIFICATION_MAX_AGE_DAYS = 30, WIRE_CHANGE_FREEZE_HOURS = 48;
export const EO_MIN_CENTS: Cents = 100_000_000n, FIDELITY_MIN_CENTS: Cents = 50_000_000n, TAX_INSTALLMENT_LOOKAHEAD_DAYS = 60, SUBORDINATE_MIN_YEARS = 5;
const need = (ok: unknown, msg: string): void => { if (!ok) throw new RangeError(msg); };
const isDate = (s: unknown): s is PlainDate => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
export const dateOf = (iso: string): PlainDate => plainDate(iso.slice(0, 10));
const S = (c: Cents): string => c.toString();
export const sha = (s: string): string => "sha256:" + createHash("sha256").update(s).digest("hex").slice(0, 16);

// ============================================================ event recorders
export interface EventCtx { readonly application_id: string; readonly loan_id?: string | null; readonly actor?: Actor; readonly at?: string; }
function appEvent(events: EventStore, c: EventCtx, type: string, payload: Record<string, unknown>): DomainEvent {
  need(!!c.application_id, "application_id is required (every 24.4 event carries it so the origination timers arm)");
  return events.append({ type, applicationId: c.application_id, ...(c.loan_id ? { loanId: c.loan_id } : {}), actor: c.actor ?? AGENT_24_4, ...(c.at ? { occurredAt: c.at } : {}), payload: { application_id: c.application_id, source: "origination", ...payload } });
}

// ============================================================ R1 endorsements (B7-2-03 / B7-2-04)
export interface PropertyTitleFacts {
  readonly condo?: boolean; readonly pud?: boolean; readonly arm?: boolean; readonly manufactured_home?: boolean; readonly leasehold?: boolean;
  readonly tx_50a6?: boolean; readonly state?: string; readonly state_promulgated_forms?: boolean;
}
/** Endorsement family the Guide names: "ALTA 4.1-06" → "ALTA 4" (4 or 4.1 satisfy the condo requirement), "ALTA 8.1-06" → "ALTA 8.1", "ALTA 7.2" → "ALTA 7". */
export function endorsementFamily(name: string): string {
  const s = name.trim().toUpperCase().replace(/\s+/g, " ").replace(/-(06|21)\b.*$/, "").replace(/\s*\(.*\)$/, "").trim();
  if (/^T-?42\.1$/.test(s)) return "T-42.1"; if (/^T-?42$/.test(s)) return "T-42"; if (/^T-?2$/.test(s)) return "T-2";
  const m = /^ALTA\s*(\d+(?:\.\d+)?)/.exec(s); if (!m) return s;
  const n = m[1]!;
  if (n === "8.1") return "ALTA 8.1";
  if (n === "4" || n === "4.1") return "ALTA 4";
  if (n === "5" || n === "5.1") return "ALTA 5";
  if (n === "6" || n === "6.2") return "ALTA 6";
  if (n === "7" || n === "7.1" || n === "7.2") return "ALTA 7";
  if (n === "13.1" || n === "13") return "ALTA 13.1";
  return `ALTA ${n}`;
}
/** Rule 1: base {ALTA 8.1} + 4/4.1 condo + 5/5.1 PUD + 6 ARM + 7/7.1/7.2 MH + 13.1 leasehold; TX 50(a)(6) → T-2 + T-42 + T-42.1. */
export function computeRequiredEndorsements(p: PropertyTitleFacts): string[] {
  if (p.tx_50a6) return ["T-2", "T-42", "T-42.1", ...(p.condo ? ["ALTA 4"] : []), ...(p.pud ? ["ALTA 5"] : [])];
  const out = ["ALTA 8.1"];
  if (p.condo) out.push("ALTA 4"); if (p.pud) out.push("ALTA 5"); if (p.arm) out.push("ALTA 6"); if (p.manufactured_home) out.push("ALTA 7"); if (p.leasehold) out.push("ALTA 13.1");
  return out;
}
export function missingEndorsements(required: readonly string[], issuedOrCommitted: readonly string[]): string[] {
  const have = new Set(issuedOrCommitted.map(endorsementFamily));
  return required.filter((r) => !have.has(endorsementFamily(r)));
}

// ============================================================ R2/R3 policy form, amount, insured
export type PolicyFormResult = { ok: true; form: "alta_2021" | "alta_2021_short" | "state_promulgated_equivalent" } | { ok: false; reason: "policy_form_not_2021" | "policy_form_unknown"; proposed: string };
/** B7-2-03: loans originated on/after Jan 1, 2024 need the 2021 ALTA Loan Policy (07-01-2021); short forms / state-promulgated forms only with equivalent coverage. */
export function policyFormCheck(proposed: string, o: { state_promulgated_equivalent?: boolean } = {}): PolicyFormResult {
  const s = proposed.trim();
  if (/2021|07-01-2021|7-1-2021|7-1-21/.test(s)) return { ok: true, form: /short/i.test(s) ? "alta_2021_short" : "alta_2021" };
  if (o.state_promulgated_equivalent && /T-2|state|promulgated/i.test(s)) return { ok: true, form: "state_promulgated_equivalent" };
  if (/2006|6-17-06|06-17-06|1992|1970/.test(s)) return { ok: false, reason: "policy_form_not_2021", proposed: s };
  return { ok: false, reason: "policy_form_unknown", proposed: s };
}
export interface TitleEvidenceFacts {
  readonly policy_form: string; readonly state_promulgated_equivalent?: boolean;
  readonly required_endorsements: readonly string[]; readonly issued_endorsements: readonly string[]; readonly committed_endorsements?: readonly string[];
  readonly policy_amount_cents: Cents; readonly note_amount_cents: Cents; readonly proposed_insured_text: string;
  readonly creditors_rights_exclusion?: boolean; readonly t42_deletions?: readonly string[];
  readonly aol?: boolean; readonly aol_ok?: boolean;
  readonly order_status?: string;
}
export interface GateOutcome { readonly open: boolean; readonly reason: string | null; readonly reasons: readonly string[]; }
/** FNMA_B7_2_01_TITLE_EVIDENCE_GATE (B7-2-03/-04/-06): 2021 form (or a qualifying AOL), every required endorsement issued or committed, amount ≥ original principal, no MERS as insured, ALTA 8.1 present, no creditors' rights exclusion, no T-42 ¶2(a)–(e) deletion. */
export function titleEvidenceGate(f: TitleEvidenceFacts): GateOutcome {
  const reasons: string[] = [];
  if (f.aol) { if (!f.aol_ok) reasons.push("aol_not_qualifying"); }
  else {
    const form = policyFormCheck(f.policy_form, { state_promulgated_equivalent: f.state_promulgated_equivalent === true });
    if (!form.ok) reasons.push(form.reason);
    const missing = missingEndorsements(f.required_endorsements, [...f.issued_endorsements, ...(f.committed_endorsements ?? [])]);
    for (const m of missing) reasons.push(endorsementFamily(m) === "ALTA 8.1" ? "alta_8_1_missing" : `endorsement_missing:${endorsementFamily(m)}`);
    if (f.creditors_rights_exclusion) reasons.push("creditors_rights_exclusion_language");
    if ((f.t42_deletions ?? []).length) reasons.push(`t42_paragraph_deleted:${(f.t42_deletions ?? []).join(",")}`);
  }
  if (f.policy_amount_cents < f.note_amount_cents) reasons.push("policy_amount_below_original_principal");
  if (/\bMERS\b|Mortgage Electronic Registration/i.test(f.proposed_insured_text)) reasons.push("mers_named_insured");
  // the state machine's `cleared`/`dated_down` follow from this gate plus CPL/agent/wire/payoff/subordination clearance; here only an order without evidence or with open blocking curative items fails on status
  if (f.order_status !== undefined && ["ordered", "curative_open", "cancelled", "rejected"].includes(f.order_status)) reasons.push(`title_order_status:${f.order_status}`);
  return { open: reasons.length === 0, reason: reasons[0] ?? null, reasons };
}

// ============================================================ R4 insurer (B7-2-02) and commitment parsing
export const STRENGTH_BASES = ["rating", "financial_strength", "reserves", "claims_record", "reinsurance_form_858", "iowa_title_guaranty"] as const;
export interface InsurerCheck { readonly insurer_party_id: string; readonly state: string; readonly doi_licensed: boolean | null; readonly strength_basis: string | null; }
export function checkInsurer(i: InsurerCheck): { ok: boolean; reason: "insurer_not_licensed" | "strength_basis_unknown" | null; action: string | null } {
  if (i.doi_licensed !== true) return { ok: false, reason: "insurer_not_licensed", action: `re-issue the commitment under a title insurer licensed in ${i.state} (B7-2-02)` };
  if (!i.strength_basis || !(STRENGTH_BASES as readonly string[]).includes(i.strength_basis)) return { ok: false, reason: "strength_basis_unknown", action: "hold; officer may accept on Form 858 reinsurance evidence" };
  return { ok: true, reason: null, action: null };
}
export interface ScheduleItem { readonly kind: string; readonly text: string; readonly width_ft?: number; readonly subsurface_under_improvements?: boolean; readonly along_property_line?: boolean; readonly forfeiture_or_reversion_or_lien?: boolean; readonly encroachment_ft?: number; readonly removable_fence?: boolean; readonly customarily_waived?: boolean; readonly release_in_hand?: boolean; readonly amount_cents?: Cents; }
export type ExceptionClass = "minor_b7_2_05" | "curative" | "unacceptable" | "to_be_paid" | "resubordinate" | "released";
/** Rule 4 (B7-2-05): utility easements ≤ 12 ft along lines / subsurface not under improvements, CC&Rs without forfeiture, encroachments ≤ 1 ft or removable fences and customarily-waived mineral rights are minor; taxes, HOA liens, PACE and unreleased mortgages are to_be_paid; survey exceptions and everything else are curative. */
export function classifyException(x: ScheduleItem): { classification: ExceptionClass; blocking: boolean; rule: string; curative_kind: string | null } {
  switch (x.kind) {
    case "utility_easement": { const minor = (x.subsurface_under_improvements === false) || ((x.width_ft ?? 99) <= 12 && x.along_property_line !== false); return minor ? { classification: "minor_b7_2_05", blocking: false, rule: "B7-2-05 utility easements ≤ 12 ft / subsurface not under improvements", curative_kind: null } : { classification: "curative", blocking: true, rule: "B7-2-05 easement outside the minor list", curative_kind: "easement_unacceptable" }; }
    case "ccr": return x.forfeiture_or_reversion_or_lien ? { classification: "curative", blocking: true, rule: "B7-2-05 restriction with forfeiture/reversion/lien", curative_kind: "other" } : { classification: "minor_b7_2_05", blocking: false, rule: "B7-2-05 restrictive covenants without forfeiture, reversion or lien", curative_kind: null };
    case "encroachment": return ((x.encroachment_ft ?? 99) <= 1 || x.removable_fence) ? { classification: "minor_b7_2_05", blocking: false, rule: "B7-2-05 encroachment ≤ 1 ft / removable fence", curative_kind: null } : { classification: "curative", blocking: true, rule: "B7-2-05 encroachment > 1 ft", curative_kind: "encroachment" };
    case "mineral_rights": return x.customarily_waived !== false ? { classification: "minor_b7_2_05", blocking: false, rule: "B7-2-05 oil/water/mineral rights customarily waived", curative_kind: null } : { classification: "curative", blocking: true, rule: "B7-2-05 mineral rights not customarily waived", curative_kind: "other" };
    case "unpaid_taxes": case "tax_delinquent": return { classification: "to_be_paid", blocking: true, rule: "B7-2-05 unpaid real estate taxes are an unacceptable impediment until paid", curative_kind: "tax_delinquent" };
    case "survey_exception": return { classification: "curative", blocking: true, rule: "B7-2-05 survey exceptions: deleted or affirmatively insured", curative_kind: "survey_exception" };
    case "unreleased_prior_mortgage": return x.release_in_hand ? { classification: "released", blocking: false, rule: "release obtained", curative_kind: null } : { classification: "to_be_paid", blocking: true, rule: "unreleased prior mortgage: release or funds to the release", curative_kind: "unreleased_prior_mortgage" };
    case "hoa_assessment_lien": return { classification: "to_be_paid", blocking: true, rule: "delinquent assessments paid at closing (rule 5)", curative_kind: "hoa_delinquent" };
    case "pace": return { classification: "to_be_paid", blocking: true, rule: "PACE obligation paid at closing (24.3 eligibility)", curative_kind: "pace" };
    case "subordinate_lien_retained": return { classification: "resubordinate", blocking: true, rule: "B2-1.2-04 resubordination", curative_kind: null };
    default: return { classification: "curative", blocking: true, rule: "B7-2-05: outside the minor list — underwriter deletion, affirmative coverage, or officer indemnity", curative_kind: "other" };
  }
}
export interface TaxInstallment { readonly label: string; readonly due_on: PlainDate; readonly amount_cents: Cents; readonly delinquent: boolean; readonly paid: boolean; }
/** Rule 5: delinquent installments and those due within 60 calendar days after consummation are paid at closing (to_be_paid, blocking). */
export function classifyTaxCertificate(i: { installments: readonly TaxInstallment[]; consummation_on: PlainDate; settlement_statement_shows_payment?: readonly string[] }): { items: { label: string; classification: ExceptionClass | "ok"; blocking: boolean; reason: string; cleared: boolean }[]; blocks_consummation: boolean } {
  const paidOnStatement = new Set(i.settlement_statement_shows_payment ?? []);
  const items = i.installments.map((t) => {
    if (t.paid) return { label: t.label, classification: "ok" as const, blocking: false, reason: "paid", cleared: true };
    const cleared = paidOnStatement.has(t.label);
    if (t.delinquent) return { label: t.label, classification: "to_be_paid" as const, blocking: !cleared, reason: "delinquent installment — pay at closing (B7-2-05)", cleared };
    const d = daysBetween(i.consummation_on, t.due_on);
    if (d >= 0 && d <= TAX_INSTALLMENT_LOOKAHEAD_DAYS) return { label: t.label, classification: "to_be_paid" as const, blocking: !cleared, reason: `due within ${TAX_INSTALLMENT_LOOKAHEAD_DAYS} days after consummation — pay at closing (policy; 30.3 starts clean)`, cleared };
    return { label: t.label, classification: "ok" as const, blocking: false, reason: "not yet due", cleared: true };
  });
  return { items, blocks_consummation: items.some((x) => x.blocking) };
}
export interface CommitmentInput {
  readonly application_id: string; readonly order_id: string; readonly commitment_number: string; readonly commitment_effective_date: PlainDate; readonly received_at: string;
  readonly underwriter_party_id: string; readonly underwriter_state: string; readonly doi_licensed: boolean | null; readonly strength_basis: string | null;
  readonly proposed_insured_text: string; readonly policy_form: string; readonly policy_amount_cents: Cents; readonly note_amount_cents: Cents;
  readonly vesting: { names: readonly string[]; tenancy: string; trust: boolean; estate: "fee_simple" | "leasehold" }; readonly legal_description: string; readonly apn: string;
  readonly schedule_b1_requirements: readonly string[]; readonly schedule_b2_exceptions: readonly ScheduleItem[]; readonly endorsements_committed: readonly string[];
  readonly property: PropertyTitleFacts; readonly appraisal_legal_description?: string | null;
}
export interface ParsedCommitment {
  readonly accepted: boolean; readonly rejection_reason: "insurer_not_licensed" | "strength_basis_unknown" | null; readonly action: string | null;
  readonly required_endorsements: readonly string[]; readonly missing_endorsements: readonly string[];
  readonly exceptions: readonly { text: string; kind: string; classification: ExceptionClass; blocking: boolean; rule: string; curative_kind: string | null }[];
  readonly legal_description_hash: string; readonly legal_description_matches_appraisal: boolean | null; readonly policy_form: PolicyFormResult; readonly status: "commitment_received" | "reviewed" | "curative_open" | "rejected";
}
/** parseCommitment: Schedule A/B data → insurer check (T4), endorsements (rule 1), exception classification (rule 4), legal-description reconciliation. */
export function parseCommitment(c: CommitmentInput): ParsedCommitment {
  need(!!c.commitment_number, "commitment_number is required"); need(isDate(c.commitment_effective_date), "commitment_effective_date must be a date");
  const ins = checkInsurer({ insurer_party_id: c.underwriter_party_id, state: c.underwriter_state, doi_licensed: c.doi_licensed, strength_basis: c.strength_basis });
  const required = computeRequiredEndorsements(c.property);
  const missing = missingEndorsements(required, c.endorsements_committed);
  const exceptions = c.schedule_b2_exceptions.map((x) => ({ text: x.text, kind: x.kind, ...classifyException(x) }));
  const hash = sha(c.legal_description.replace(/\s+/g, " ").trim().toLowerCase());
  const matches = c.appraisal_legal_description === undefined || c.appraisal_legal_description === null ? null : sha(c.appraisal_legal_description.replace(/\s+/g, " ").trim().toLowerCase()) === hash;
  const form = policyFormCheck(c.policy_form, { state_promulgated_equivalent: c.property.state_promulgated_forms === true });
  const blocking = exceptions.some((x) => x.blocking) || missing.length > 0 || matches === false || !form.ok;
  return { accepted: ins.ok, rejection_reason: ins.reason, action: ins.action, required_endorsements: required, missing_endorsements: missing, exceptions, legal_description_hash: hash, legal_description_matches_appraisal: matches, policy_form: form, status: !ins.ok ? "rejected" : blocking ? "curative_open" : "reviewed" };
}

// ============================================================ curative items
export const CURATIVE_KINDS = ["judgment", "lien", "tax_delinquent", "hoa_delinquent", "pace", "ucc", "name_variance", "deceased_vestee", "divorce_decree", "probate", "unreleased_prior_mortgage", "survey_exception", "easement_unacceptable", "encroachment", "legal_description_mismatch", "redemption_period", "other"] as const;
export const CURATIVE_RESOLUTIONS = ["paid_at_closing", "released", "affirmative_coverage", "endorsement", "indemnity_accepted_by_officer", "deleted_by_underwriter", "not_required"] as const;
export interface CurativeItem { readonly id: string; readonly title_order_id: string; readonly kind: string; readonly source: string; readonly amount_cents: Cents | null; readonly resolution: string | null; readonly owner: "settlement_agent" | "borrower" | "title_underwriter" | "sm"; readonly opened_at: string; readonly cleared_at: string | null; readonly evidence_document_id: string | null; readonly blocks_consummation: boolean; readonly description: string; }
export function openCurative(i: { title_order_id: string; kind: string; source: string; owner: CurativeItem["owner"]; description: string; opened_at: string; amount_cents?: Cents | null; blocks_consummation?: boolean }): CurativeItem {
  need((CURATIVE_KINDS as readonly string[]).includes(i.kind), `curative kind ${i.kind} is not one of ${CURATIVE_KINDS.join(", ")}`);
  return { id: randomUUID(), title_order_id: i.title_order_id, kind: i.kind, source: i.source, amount_cents: i.amount_cents ?? null, resolution: null, owner: i.owner, opened_at: i.opened_at, cleared_at: null, evidence_document_id: null, blocks_consummation: i.blocks_consummation ?? true, description: i.description };
}
/** Clearing needs a resolution from the list; `indemnity_accepted_by_officer` is the officer's act (guardrail in the tool). */
export function clearCurative(item: CurativeItem, r: { resolution: string; evidence_document_id: string | null; cleared_at: string }): CurativeItem {
  need((CURATIVE_RESOLUTIONS as readonly string[]).includes(r.resolution), `resolution ${r.resolution} is not one of ${CURATIVE_RESOLUTIONS.join(", ")}`);
  return { ...item, resolution: r.resolution, evidence_document_id: r.evidence_document_id, cleared_at: r.cleared_at };
}
/** T3: an endorsement curative clears when the issued endorsement's family matches ("ALTA 4.1-06" clears an ALTA 4/4.1 item). */
export function endorsementClears(requiredFamily: string, issued: string): boolean { return endorsementFamily(issued) === endorsementFamily(requiredFamily); }

// ============================================================ title order status machine
export const TITLE_ORDER_STATUSES = ["ordered", "commitment_received", "reviewed", "curative_open", "cleared", "dated_down", "closed", "policy_received", "cancelled"] as const;
export type TitleOrderStatus = (typeof TITLE_ORDER_STATUSES)[number];
const TRANSITIONS: Record<TitleOrderStatus, readonly TitleOrderStatus[]> = {
  ordered: ["commitment_received", "cancelled"], commitment_received: ["reviewed", "curative_open", "cancelled"], reviewed: ["curative_open", "cleared", "cancelled"], curative_open: ["reviewed", "cleared", "cancelled"],
  cleared: ["dated_down", "curative_open", "closed", "cancelled"], dated_down: ["closed", "curative_open", "cancelled"], closed: ["policy_received"], policy_received: [], cancelled: [],
};
export function transitionTitleOrder(from: TitleOrderStatus, to: TitleOrderStatus): TitleOrderStatus {
  need(TRANSITIONS[from]?.includes(to), `title_orders.status ${from} → ${to} is not a transition of the 24.4 state machine`);
  return to;
}
export interface ClearanceFacts { readonly open_blocking_items: number; readonly cpl_received: boolean; readonly agent_vetted: boolean; readonly wire_verified: boolean; readonly payoffs_current: boolean; readonly subordinations_executed: boolean; }
/** `reviewed → cleared`: no blocking items; CPL received; agent vetted; wire verified; payoffs current; subordinations executed. */
export function clearanceCheck(f: ClearanceFacts): { can_clear: boolean; missing: string[] } {
  const missing = [f.open_blocking_items > 0 ? `${f.open_blocking_items} blocking curative item(s)` : null, f.cpl_received ? null : "CPL", f.agent_vetted ? null : "settlement agent vetting", f.wire_verified ? null : "wire verification", f.payoffs_current ? null : "current payoff statement(s)", f.subordinations_executed ? null : "executed resubordination(s)"].filter((x): x is string => x !== null);
  return { can_clear: missing.length === 0, missing };
}
/** SM_TITLE_COMMITMENT_DATEDOWN_GATE (24.4-Q2 policy): the effective date of the commitment or its date-down ≥ consummation − 30 calendar days. */
export function commitmentDatedownGate(f: { commitment_effective_date: PlainDate | null; datedown_effective_date?: PlainDate | null; consummation_on: PlainDate | null }): GateOutcome & { window_opens: PlainDate | null } {
  if (!f.consummation_on) return { open: false, reason: "consummation_not_scheduled", reasons: ["consummation_not_scheduled"], window_opens: null };
  const opens = addDays(f.consummation_on, -COMMITMENT_WINDOW_DAYS);
  const eff = f.datedown_effective_date ?? f.commitment_effective_date;
  if (!eff) return { open: false, reason: "no_commitment", reasons: ["no_commitment"], window_opens: opens };
  return eff >= opens ? { open: true, reason: null, reasons: [], window_opens: opens } : { open: false, reason: "commitment_older_than_30_days", reasons: ["commitment_older_than_30_days"], window_opens: opens };
}

// ============================================================ R13/R14 settlement agent vetting and wire controls
export interface AgentVettingInput {
  readonly party_id: string; readonly agent_type: "title_agency" | "underwriter_direct" | "attorney" | "escrow_company"; readonly state: string; readonly property_state: string;
  readonly license_active: boolean; readonly eo_policy_limit_cents: Cents; readonly eo_expires_on: PlainDate; readonly fidelity_limit_cents: Cents; readonly alta_registry_id: string | null; readonly underwriter_confirmed_by: string | null;
  readonly best_practices_attestation_at: PlainDate | null; readonly wire_instructions_on_letterhead: boolean; readonly cpl_available: boolean; readonly underwriter_callback_number_verified: boolean; readonly referral_consideration: boolean; readonly as_of: PlainDate;
}
export type VettingStatus = "approved" | "approved_with_conditions" | "suspended" | "rejected";
export function vetSettlementAgent(i: AgentVettingInput): { vetting_status: VettingStatus; reasons: string[]; conditions: string[]; vetting_expires_on: PlainDate } {
  const reasons: string[] = []; const conditions: string[] = [];
  if (!i.license_active || i.state !== i.property_state) reasons.push(`license_not_active_in_${i.property_state}`);
  if (i.eo_policy_limit_cents < EO_MIN_CENTS || i.eo_expires_on < i.as_of) reasons.push("eo_below_minimum_or_expired");
  if (i.fidelity_limit_cents < FIDELITY_MIN_CENTS && !i.cpl_available) reasons.push("fidelity_below_minimum_without_cpl");
  if (!i.wire_instructions_on_letterhead) reasons.push("wire_instructions_not_on_letterhead");
  if (i.referral_consideration) reasons.push("respa_section_8_referral_consideration");
  if (!i.alta_registry_id && !i.underwriter_confirmed_by) { if (i.cpl_available && i.underwriter_callback_number_verified) conditions.push("no ALTA Registry entry — CPL and underwriter-verified callback number required"); else reasons.push("not_on_alta_registry_and_no_underwriter_confirmation"); }
  if (!i.best_practices_attestation_at) conditions.push("ALTA Best Practices attestation outstanding");
  const status: VettingStatus = reasons.length ? "rejected" : conditions.length ? "approved_with_conditions" : "approved";
  return { vetting_status: status, reasons, conditions, vetting_expires_on: addYears(i.as_of, 1) };
}
/** SM_SETTLEMENT_AGENT_VETTING_GATE: `vetting_status ∈ {approved, approved_with_conditions}` and not expired at the closing date. */
export function settlementAgentVettingGate(f: { vetting_status: string | null; vetting_expires_on: PlainDate | null; as_of: PlainDate }): GateOutcome {
  if (!f.vetting_status || !["approved", "approved_with_conditions"].includes(f.vetting_status)) return { open: false, reason: `agent_vetting_${f.vetting_status ?? "missing"}`, reasons: [`agent_vetting_${f.vetting_status ?? "missing"}`] };
  if (!f.vetting_expires_on || f.vetting_expires_on < f.as_of) return { open: false, reason: "agent_vetting_expired", reasons: ["agent_vetting_expired"] };
  return { open: true, reason: null, reasons: [] };
}
export type WireMatch = "verified" | "mismatch" | "not_found" | "changed";
export type CallbackSource = "alta_registry" | "underwriter" | "prior_verified_record";
export const CALLBACK_SOURCES: readonly CallbackSource[] = ["alta_registry", "underwriter", "prior_verified_record"];
export interface WireVerificationInput {
  readonly application_id: string; readonly purpose: "closing_funds" | "payoff_existing_lien" | "subordinate_payoff"; readonly beneficiary_party_id: string; readonly routing_number: string; readonly account_number: string;
  readonly instructions_channel: "letterhead" | "portal" | "email" | "vendor_registry"; readonly instructions_email_domain?: string | null; readonly registered_email_domain?: string | null;
  readonly vendor: "fundingshield" | "certifid" | "manual_callback"; readonly vendor_match: WireMatch | null; readonly prior_verified: { instructions_hash: string; verified_at: string } | null;
  readonly callback: { number_source: CallbackSource | "email" | null; completed: boolean } | null; readonly received_at: string; readonly funding_at: string | null;
}
export interface WireVerification { readonly id: string; readonly application_id: string; readonly purpose: string; readonly beneficiary_party_id: string; readonly vendor: string; readonly account_last4: string; readonly routing_number_hash: string; readonly instructions_hash: string; readonly match_result: WireMatch; readonly callback_at: string | null; readonly callback_number_source: CallbackSource | null; readonly verified_at: string | null; readonly expires_at: string | null; readonly change_detected_at: string | null; readonly hours_to_funding: number | null; readonly blocks_disbursement: boolean; readonly block_reason: string | null; readonly release_requires: "funding_approver_after_second_callback" | null; }
export const instructionsHash = (routing: string, account: string): string => sha(`${routing}|${account}`);
/** Rule 13: vendor match + SM callback to a registry/underwriter/prior-record number (never the e-mail's); any change → re-verify; a change ≤ 48 hours before funding blocks the wire unless the funding_approver releases after a second callback. */
export function verifyWireInstructions(i: WireVerificationInput): WireVerification {
  need(/^\d{9}$/.test(i.routing_number), "routing_number must be 9 digits"); need(i.account_number.length >= 4, "account_number is required");
  const hash = instructionsHash(i.routing_number, i.account_number);
  const changed = !!i.prior_verified && i.prior_verified.instructions_hash !== hash;
  const hours = i.funding_at ? (Date.parse(i.funding_at) - Date.parse(i.received_at)) / 3_600_000 : null;
  const domainMismatch = i.instructions_channel === "email" && !!i.registered_email_domain && !!i.instructions_email_domain && i.instructions_email_domain.toLowerCase() !== i.registered_email_domain.toLowerCase();
  const callbackOk = !!i.callback && i.callback.completed && (CALLBACK_SOURCES as readonly string[]).includes(String(i.callback.number_source));
  const match: WireMatch = changed ? "changed" : (i.vendor_match ?? "not_found");
  const reasons: string[] = [];
  if (changed) reasons.push("instructions_changed_since_verification");
  if (domainMismatch) reasons.push("email_domain_differs_from_registered");
  if (match === "mismatch" || match === "not_found") reasons.push(`vendor_${match}`);
  if (!callbackOk) reasons.push(i.callback?.number_source === "email" ? "callback_number_from_email_not_allowed" : "callback_missing");
  const inFreeze = changed && hours !== null && hours <= WIRE_CHANGE_FREEZE_HOURS;
  if (inFreeze) reasons.push("change_within_48h_of_funding");
  const verified = reasons.length === 0;
  const verifiedAt = verified ? i.received_at : null;
  return { id: randomUUID(), application_id: i.application_id, purpose: i.purpose, beneficiary_party_id: i.beneficiary_party_id, vendor: i.vendor, account_last4: i.account_number.slice(-4), routing_number_hash: sha(i.routing_number), instructions_hash: hash, match_result: match,
    callback_at: callbackOk ? i.received_at : null, callback_number_source: callbackOk ? (i.callback!.number_source as CallbackSource) : null, verified_at: verifiedAt, expires_at: verifiedAt ? new Date(Date.parse(verifiedAt) + WIRE_VERIFICATION_MAX_AGE_DAYS * 86_400_000).toISOString() : null,
    change_detected_at: changed ? i.received_at : null, hours_to_funding: hours, blocks_disbursement: !verified, block_reason: reasons[0] ?? null, release_requires: inFreeze ? "funding_approver_after_second_callback" : null };
}
/** A blocked late change is released only by the funding_approver after a SECOND callback to a registry/underwriter number (rule 13; T8). */
export function releaseWireBlock(v: WireVerification, r: { actor_role: string; second_callback_number_source: CallbackSource | "email" | null; second_callback_completed: boolean; released_at: string }): WireVerification {
  need(v.release_requires === "funding_approver_after_second_callback", "this verification is not a blocked late change awaiting funding_approver release");
  need(r.actor_role === "funding_approver", "only the funding_approver (26.3) may release a wire change inside the 48-hour freeze");
  need(r.second_callback_completed && (CALLBACK_SOURCES as readonly string[]).includes(String(r.second_callback_number_source)), "release needs a completed second callback to an ALTA Registry / underwriter / prior-record number");
  return { ...v, match_result: "verified", callback_at: r.released_at, callback_number_source: r.second_callback_number_source as CallbackSource, verified_at: r.released_at, expires_at: new Date(Date.parse(r.released_at) + WIRE_VERIFICATION_MAX_AGE_DAYS * 86_400_000).toISOString(), blocks_disbursement: false, block_reason: null, release_requires: null };
}
/** SM_WIRE_VERIFICATION_GATE: verification ≤ 30 days old, no unresolved change, callback on record. */
export function wireVerificationGate(f: { verified_at: string | null; change_detected_at?: string | null; blocks_disbursement?: boolean; callback_number_source?: string | null; as_of: string }): GateOutcome {
  const reasons: string[] = [];
  if (!f.verified_at) reasons.push("wire_not_verified");
  else if (Date.parse(f.as_of) - Date.parse(f.verified_at) > WIRE_VERIFICATION_MAX_AGE_DAYS * 86_400_000) reasons.push("wire_verification_older_than_30_days");
  if (f.blocks_disbursement) reasons.push("wire_change_blocked");
  if (f.change_detected_at && f.verified_at && Date.parse(f.change_detected_at) > Date.parse(f.verified_at)) reasons.push("wire_change_unverified");
  if (f.verified_at && !(CALLBACK_SOURCES as readonly string[]).includes(String(f.callback_number_source))) reasons.push("callback_missing");
  return { open: reasons.length === 0, reason: reasons[0] ?? null, reasons };
}

// ============================================================ CPL (warehouse/partner control; state CPL forms)
export interface CplFacts { readonly cpl_underwriter_party_id: string | null; readonly underwriter_party_id: string | null; readonly cpl_agent_party_id: string | null; readonly settlement_agent_party_id: string | null; readonly addressees: readonly string[]; readonly partner_name: string; readonly sm_addressee_required?: boolean; readonly transaction_ref: string | null; readonly application_ref: string; readonly cpl_date: PlainDate | null; readonly funding_date: PlainDate | null; readonly validity_days?: number | null; }
/** SM_CPL_BEFORE_FUNDING_GATE: CPL from the commitment's underwriter, naming the partner (and SM per facility terms), for `settlement_agent_party_id`, transaction-specific, dated ≤ funding and within the state form's validity. */
export function cplBeforeFundingGate(f: CplFacts): GateOutcome & { cpl_addressee_ok: boolean; cpl_agent_ok: boolean } {
  const reasons: string[] = [];
  if (!f.cpl_date) reasons.push("cpl_missing");
  const agentOk = !!f.cpl_agent_party_id && f.cpl_agent_party_id === f.settlement_agent_party_id; if (f.cpl_date && !agentOk) reasons.push("cpl_agent_mismatch");
  if (f.cpl_date && f.cpl_underwriter_party_id !== f.underwriter_party_id) reasons.push("cpl_underwriter_mismatch");
  const addresseeOk = f.addressees.some((a) => a.toLowerCase().includes(f.partner_name.toLowerCase())) && (!f.sm_addressee_required || f.addressees.some((a) => /supermortgage/i.test(a)));
  if (f.cpl_date && !addresseeOk) reasons.push("cpl_addressee_not_partner");
  if (f.cpl_date && f.transaction_ref !== f.application_ref) reasons.push("cpl_not_transaction_specific");
  if (f.cpl_date && f.funding_date && f.cpl_date > f.funding_date) reasons.push("cpl_dated_after_funding");
  if (f.cpl_date && f.funding_date && f.validity_days && daysBetween(f.cpl_date, f.funding_date) > f.validity_days) reasons.push("cpl_outside_state_form_validity");
  return { open: reasons.length === 0, reason: reasons[0] ?? null, reasons, cpl_addressee_ok: addresseeOk, cpl_agent_ok: agentOk };
}

// ============================================================ R6–R8 payoffs
export interface PayoffStatementInput { readonly principal_cents: Cents; readonly rate_pct: string; readonly interest_paid_through: PlainDate; readonly per_diem_cents: Cents; readonly good_through_date: PlainDate; readonly fees_cents?: Cents; readonly recording_fee_cents?: Cents; readonly escrow_shortage_cents?: Cents; readonly credits_cents?: Cents; readonly statement_date: PlainDate; readonly short_payoff?: boolean; readonly stated_total_cents?: Cents | null; }
export interface ParsedPayoff { readonly interest_days: number; readonly interest_cents: Cents; readonly fees_cents: Cents; readonly total_cents: Cents; readonly computed_per_diem_cents: Cents; readonly per_diem_reconciles: boolean; readonly per_diem_difference_cents: Cents; readonly stated_total_matches: boolean | null; readonly short_payoff: boolean; readonly status: "received" | "rejected"; }
export const PER_DIEM_TOLERANCE_CENTS: Cents = 2n;
/** Rule 6 arithmetic: interest from paid-through + 1 through good-through = days × per diem; total = principal + interest + fees + shortage − credits. Per diem reconciled to the note rate (±$0.02) — the servicer's figure is never "corrected". */
export function parsePayoffStatement(s: PayoffStatementInput): ParsedPayoff {
  need(s.principal_cents > 0n, "principal_cents must be positive"); need(isDate(s.good_through_date) && isDate(s.interest_paid_through), "good_through_date and interest_paid_through must be dates");
  const days = daysBetween(s.interest_paid_through, s.good_through_date);
  need(days >= 0, "good_through_date precedes interest_paid_through");
  const interest = BigInt(days) * s.per_diem_cents;
  const fees = (s.fees_cents ?? 0n) + (s.recording_fee_cents ?? 0n);
  const total = s.principal_cents + interest + fees + (s.escrow_shortage_cents ?? 0n) - (s.credits_cents ?? 0n);
  const computed = servicerPerDiem(s.principal_cents, s.rate_pct);
  const diff = computed - s.per_diem_cents; const abs = diff < 0n ? -diff : diff;
  return { interest_days: days, interest_cents: interest, fees_cents: fees, total_cents: total, computed_per_diem_cents: computed, per_diem_reconciles: abs <= PER_DIEM_TOLERANCE_CENTS, per_diem_difference_cents: diff,
    stated_total_matches: s.stated_total_cents === undefined || s.stated_total_cents === null ? null : s.stated_total_cents === total, short_payoff: s.short_payoff === true, status: s.short_payoff ? "rejected" : "received" };
}
/** Planning only: `total_at(date) = total + per_diem × max(0, days(date − good_through))`; funding never uses it (comment 36(c)(3)-3). */
export function computePayoffAtDate(p: { total_cents: Cents; per_diem_cents: Cents; good_through_date: PlainDate }, on: PlainDate): { total_at_cents: Cents; extra_days: number; planning_only: true; stale: boolean } {
  const extra = Math.max(0, daysBetween(p.good_through_date, on));
  return { total_at_cents: p.total_cents + BigInt(extra) * p.per_diem_cents, extra_days: extra, planning_only: true, stale: extra > 0 };
}
export type PayoffStatus = "requested" | "received" | "stale" | "refreshed" | "funded" | "rejected";
/** Rule 6 refresh triggers: disbursement past good-through, a payment posted on the old loan, or a statement > 30 days old. */
export function payoffStaleness(p: { status: PayoffStatus; good_through_date: PlainDate | null; statement_date: PlainDate | null; disbursement_date: PlainDate | null; payment_posted_since?: boolean; as_of: PlainDate }): { stale: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!["received", "refreshed"].includes(p.status)) reasons.push(`status_${p.status}`);
  if (p.good_through_date && p.disbursement_date && p.good_through_date < p.disbursement_date) reasons.push("good_through_before_disbursement");
  if (p.payment_posted_since) reasons.push("payment_posted_on_old_loan");
  if (p.statement_date && daysBetween(p.statement_date, p.as_of) > 30) reasons.push("statement_older_than_30_days");
  return { stale: reasons.length > 0, reasons };
}
/** SM_PAYOFF_GOOD_THROUGH_GATE: `payoff_demands.status ∈ {received, refreshed}` with `good_through_date ≥ disbursement_date` for every lien being paid. */
export function payoffGoodThroughGate(f: { payoffs: readonly { liability_id: string; status: string; good_through_date: PlainDate | null }[]; disbursement_date: PlainDate | null }): GateOutcome {
  if (!f.disbursement_date) return { open: false, reason: "disbursement_date_unknown", reasons: ["disbursement_date_unknown"] };
  const reasons: string[] = [];
  for (const p of f.payoffs) {
    if (!["received", "refreshed"].includes(p.status)) reasons.push(`payoff_${p.liability_id}_${p.status}`);
    else if (!p.good_through_date || p.good_through_date < f.disbursement_date) reasons.push(`payoff_${p.liability_id}_stale`);
  }
  return { open: reasons.length === 0, reason: reasons[0] ?? null, reasons };
}
/** Follow-up on the external servicer's §1026.36(c)(3) duty: +7 creditor business days from the written request (the servicer's own calendar is unknown). */
export function payoffFollowUpDue(requestedOn: PlainDate): PlainDate { return addBusinessDays(requestedOn, 7, creditor); }
/** Open question 6 (dry states): request good-through = planned disbursement + 5 calendar days. */
export function requestedGoodThrough(plannedDisbursement: PlainDate, dryState: boolean): PlainDate { return dryState ? addDays(plannedDisbursement, 5) : plannedDisbursement; }
export type EscrowTreatment = "refund_by_servicer" | "credit_to_new_loan" | "net_against_shortage";
export interface EscrowTreatmentInput { readonly same_servicer: boolean; readonly payoff_posted_on: PlainDate; readonly escrow_balance_cents: Cents; readonly consent: { kind: string; captured_at: PlainDate } | null; readonly settlement_date: PlainDate; readonly initial_escrow_deposit_cents: Cents | null; readonly payoff_shortfall_cents?: Cents; readonly net_against_shortfall_flag?: boolean; }
/** Rule 7: (a) 3.5 refund within 20 federal business days of the payoff posting; (b) with the `escrow_credit_to_new_loan` consent (§1024.34(b)(2)(iii), same servicer) credit the balance against 30.3's initial deposit — no refund check; (c) netting only under `escrow.payoff.net_against_shortfall`. */
export function decideEscrowTreatment(i: EscrowTreatmentInput): { escrow_treatment: EscrowTreatment; refund_due_on: PlainDate | null; refund_method: "check" | "ach" | "credit_to_new_loan" | null; credited_cents: Cents; new_initial_deposit_cents: Cents | null; refund_check_issued: boolean; excess_refund_cents: Cents; consent_gate: Record<string, unknown>; rule_ref: string } {
  need(i.same_servicer, "escrow treatment is decided only in the same-servicer case (§1024.34(b)(2)(iii)); an external servicer refunds under its own (b)(1) duty");
  need(i.escrow_balance_cents >= 0n, "escrow_balance_cents cannot be negative");
  const gate = creditAgreementGateFacts(i.consent && i.consent.kind === "escrow_credit_to_new_loan" ? { kind: "escrow_credit_to_new_loan", captured_at: i.consent.captured_at } : null, i.settlement_date);
  if (i.net_against_shortfall_flag && (i.payoff_shortfall_cents ?? 0n) > 0n) {
    const netted = i.escrow_balance_cents < (i.payoff_shortfall_cents ?? 0n) ? i.escrow_balance_cents : (i.payoff_shortfall_cents ?? 0n);
    return { escrow_treatment: "net_against_shortage", refund_due_on: payoffRefundDue(i.payoff_posted_on), refund_method: "check", credited_cents: netted, new_initial_deposit_cents: i.initial_escrow_deposit_cents, refund_check_issued: i.escrow_balance_cents - netted > 0n, excess_refund_cents: i.escrow_balance_cents - netted, consent_gate: gate, rule_ref: "3.5 feature flag escrow.payoff.net_against_shortfall; §1024.34(b)(1) for the remainder" };
  }
  if (gate.consent_present === true && gate.captured_by_settlement === true && i.initial_escrow_deposit_cents !== null) {
    const credited = i.escrow_balance_cents < i.initial_escrow_deposit_cents ? i.escrow_balance_cents : i.initial_escrow_deposit_cents;
    const excess = i.escrow_balance_cents - credited;
    const method = refundMethod({ credit_to_new_loan: true }, i.settlement_date, i.consent!.captured_at);
    return { escrow_treatment: "credit_to_new_loan", refund_due_on: excess > 0n ? payoffRefundDue(i.payoff_posted_on) : null, refund_method: method, credited_cents: credited, new_initial_deposit_cents: i.initial_escrow_deposit_cents - credited, refund_check_issued: false, excess_refund_cents: excess, consent_gate: gate, rule_ref: "§1024.34(b)(2)(iii) — same servicer for both loans; 30.3 posts escrow.credit_to_new_loan.posted" };
  }
  return { escrow_treatment: "refund_by_servicer", refund_due_on: payoffRefundDue(i.payoff_posted_on), refund_method: refundMethod({}), credited_cents: 0n, new_initial_deposit_cents: i.initial_escrow_deposit_cents, refund_check_issued: i.escrow_balance_cents > 0n, excess_refund_cents: i.escrow_balance_cents, consent_gate: gate, rule_ref: "§1024.34(b)(1) — 3.5 REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD" };
}

// ============================================================ R9 subordinations (B2-1.2-04)
/** `cltv_bps = floor((first + drawn) × 10000 ÷ value)`, `hcltv_bps = floor((first + line) × 10000 ÷ value)`. */
export function helocRatios(i: { first_cents: Cents; drawn_cents: Cents; line_cents: Cents; value_cents: Cents }): { cltv_bps: number; hcltv_bps: number } {
  need(i.value_cents > 0n, "value_cents must be positive");
  return { cltv_bps: Number(((i.first_cents + i.drawn_cents) * 10_000n) / i.value_cents), hcltv_bps: Number(((i.first_cents + i.line_cents) * 10_000n) / i.value_cents) };
}
export interface SubordinateTerms { readonly note_date: PlainDate; readonly maturity_or_balloon_on: PlainDate | null; readonly payments_cover_interest: boolean; readonly negative_amortization: boolean; readonly employer_deferred_plan?: boolean; readonly market_rate: boolean; readonly shared_appreciation?: boolean; readonly community_seconds?: boolean; readonly clearly_subordinate: boolean; readonly lien_kind?: string; }
/** B2-1.2-04 terms: interest-covering payments (no negative amortization except employer plans), market rate, maturity/balloon ≥ 5 years after the note date, no shared appreciation unless Community Seconds, clearly subordinate. */
export function checkSubordinateTerms(t: SubordinateTerms): { terms_ok: boolean; reasons: string[]; action: "none" | "pay_off_lien_or_restructure" } {
  const reasons: string[] = [];
  if (t.negative_amortization && !t.employer_deferred_plan) reasons.push("negative_amortization");
  if (!t.payments_cover_interest && !t.employer_deferred_plan && t.lien_kind !== "heloc") reasons.push("payments_do_not_cover_interest");
  if (!t.market_rate) reasons.push("below_market_rate");
  if (t.maturity_or_balloon_on && t.maturity_or_balloon_on < addYears(t.note_date, SUBORDINATE_MIN_YEARS)) reasons.push("balloon_or_maturity_within_5_years_of_note_date");
  if (t.shared_appreciation && !t.community_seconds) reasons.push("shared_appreciation_not_community_seconds");
  if (!t.clearly_subordinate) reasons.push("not_clearly_subordinate");
  return { terms_ok: reasons.length === 0, reasons, action: reasons.length ? "pay_off_lien_or_restructure" : "none" };
}
export type SubordinationStatus = "requested" | "received" | "executed" | "recorded" | "waived_statutory" | "rejected";
/** FNMA_B2_1_2_04_RESUBORDINATION_GATE: every lien staying in place is `executed` (recordable) or `waived_statutory`. */
export function resubordinationGate(f: { subordinations: readonly { liability_id: string; status: string; recordable?: boolean; statutory_position_preserved?: boolean }[] }): GateOutcome {
  const reasons: string[] = [];
  for (const s of f.subordinations) {
    if (s.status === "waived_statutory" || s.statutory_position_preserved) continue;
    if (s.status === "executed" || s.status === "recorded") { if (s.recordable === false) reasons.push(`subordination_${s.liability_id}_not_recordable`); continue; }
    reasons.push(`subordination_${s.liability_id}_${s.status}`);
  }
  return { open: reasons.length === 0, reason: reasons[0] ?? null, reasons };
}
/** SM_SUBORDINATION_REQUEST_3BD: +3 creditor business days from the DU findings date (Columbus Day Oct 12, 2026 skipped → Tue Oct 13). */
export function subordinationRequestDue(findingsOn: PlainDate): PlainDate { return addBusinessDays(findingsOn, 3, creditor); }

// ============================================================ R10 trusts (B2-2-05 / B8-5-02) and R11 POA (B8-5-05)
export interface TrustReviewInput { readonly trust_name: string; readonly revocable: boolean; readonly settlor_is_trustee: boolean; readonly institutional_trustee: boolean; readonly primary_beneficiary_is_settlor: boolean; readonly power_to_mortgage: boolean; readonly occupancy_ok: boolean; readonly qualifying_party_ok: boolean; readonly title_insures_without_trustee_exception?: boolean; readonly certification_document_id?: string | null; readonly trust_agreement_document_id?: string | null; readonly certification_statute?: boolean; readonly attorney_opinion_document_id?: string | null; readonly state?: string; }
export interface TrustReview { readonly result: "eligible" | "ineligible" | "needs_documents"; readonly reasons: string[]; readonly sfc_168: boolean; readonly rider_required: boolean; readonly signature_plan: string[]; }
/** Rule 10: eligible iff revocable ∧ primary beneficiary is the settlor ∧ (settlor is a trustee ∨ institutional trustee) ∧ power to mortgage ∧ occupancy ∧ qualifying party; SFC 168; E-2-04 signature blocks (trustee capacity + settlor acknowledgment). */
export function reviewTrust(t: TrustReviewInput): TrustReview {
  const reasons: string[] = [];
  if (!t.revocable) reasons.push("trust_not_revocable");
  if (!t.primary_beneficiary_is_settlor) reasons.push("primary_beneficiary_not_settlor");
  if (!t.settlor_is_trustee && !t.institutional_trustee) reasons.push("trustee_neither_settlor_nor_institutional");
  if (!t.power_to_mortgage) reasons.push("no_power_to_mortgage");
  if (!t.occupancy_ok) reasons.push("no_settlor_occupies_principal_residence");
  if (!t.qualifying_party_ok) reasons.push("no_settlor_income_or_assets_qualify");
  if (t.title_insures_without_trustee_exception === false) reasons.push("title_takes_trustee_exception");
  const docsMissing = !t.certification_document_id && !t.trust_agreement_document_id;
  const needsOpinion = t.certification_statute === false && !t.attorney_opinion_document_id;
  const result: TrustReview["result"] = reasons.length ? "ineligible" : docsMissing || needsOpinion ? "needs_documents" : "eligible";
  if (docsMissing) reasons.push("trust_certification_or_agreement_missing"); if (needsOpinion) reasons.push("attorney_review_required_no_certification_statute");
  return { result, reasons, sfc_168: result === "eligible", rider_required: false /* B8-5-02: the revocable trust rider is optional ("If the lender chooses to require…") */, signature_plan: result === "eligible" ? ["trustee_capacity_signature (note and security instrument, E-2-04)", "settlor_acknowledgment (each settlor whose credit qualifies, B8-5-02)"] : [] };
}
export const POA_INELIGIBLE_CLASSES = ["lender_affiliate", "loan_originator", "title_employee", "seller", "real_estate_agent_interest"] as const;
export interface PoaReviewInput { readonly transaction_type: "purchase" | "limited_cash_out" | "cash_out"; readonly agent_relationship: "relative" | "other"; readonly agent_ineligible_class: "none" | (typeof POA_INELIGIBLE_CLASSES)[number]; readonly interactive_session_recording_id: string | null; readonly cpl_document_id: string | null; readonly notarized: boolean; readonly dated_valid: boolean; readonly references_property: boolean; readonly names_match: boolean; readonly applicable_law_override: boolean; readonly override_statement_document_id: string | null; readonly recording_required?: boolean; readonly original_to_custodian?: boolean; readonly aol_requested?: boolean; }
export interface PoaReview { readonly result: "eligible" | "ineligible" | "needs_documents"; readonly reasons: string[]; readonly cpl_required: boolean; readonly interactive_session_required: boolean; readonly aol_barred: true; }
/** Rule 11: purchase / limited cash-out only (cash-out ineligible unless the applicable-law override with the written file statement); ineligible-class agents need a relative relationship or the recorded interactive session (+ CPL for title-company employees); document tests. */
export function reviewPOA(p: PoaReviewInput): PoaReview {
  const reasons: string[] = []; const docs: string[] = [];
  const override = p.applicable_law_override && !!p.override_statement_document_id;
  if (p.applicable_law_override && !p.override_statement_document_id) docs.push("applicable_law_override_statement_missing");
  if (p.transaction_type === "cash_out" && !override) reasons.push("transaction_type_cash_out_ineligible");
  const inClass = p.agent_ineligible_class !== "none" && p.agent_relationship !== "relative";
  const sessionRequired = inClass && !override;
  const cplRequired = inClass && p.agent_ineligible_class === "title_employee" && !override;
  if (sessionRequired && !p.interactive_session_recording_id) docs.push("recorded_interactive_session_required");
  if (cplRequired && !p.cpl_document_id) docs.push("cpl_required_for_title_employee_agent");
  if (!override) { if (!p.notarized) docs.push("poa_not_notarized"); if (!p.dated_valid) reasons.push("poa_not_valid_at_execution"); if (!p.references_property) docs.push("poa_does_not_reference_property_address"); if (!p.names_match) reasons.push("poa_names_do_not_match_loan_documents"); }
  const result: PoaReview["result"] = reasons.length ? "ineligible" : docs.length ? "needs_documents" : "eligible";
  return { result, reasons: [...reasons, ...docs], cpl_required: cplRequired, interactive_session_required: sessionRequired, aol_barred: true };
}
/** SM_TRUST_POA_REVIEW_GATE: every trust/POA borrower reviewed `eligible`. */
export function trustPoaReviewGate(f: { trust_reviews: readonly { borrower_id: string; result: string }[]; poa_reviews: readonly { borrower_id: string; result: string }[] }): GateOutcome {
  const reasons = [...f.trust_reviews.filter((r) => r.result !== "eligible").map((r) => `trust_${r.borrower_id}_${r.result}`), ...f.poa_reviews.filter((r) => r.result !== "eligible").map((r) => `poa_${r.borrower_id}_${r.result}`)];
  return { open: reasons.length === 0, reason: reasons[0] ?? null, reasons };
}

// ============================================================ R12 AOL (B7-2-06), R15 NY CEMA, R16 TX 50(a)(6)
export interface AolInput { readonly aol_enabled: boolean; readonly co_op?: boolean; readonly leasehold_or_clt?: boolean; readonly manufactured_home?: boolean; readonly homestyle?: boolean; readonly tx_50a6?: boolean; readonly poa?: boolean; readonly attorney_licensed_in_state?: boolean; readonly malpractice_prevailing?: boolean; readonly elements?: Partial<Record<"addressee" | "indemnity" | "gap" | "priority_fee_simple" | "subordinate_liens_listed" | "alta_8_1_language" | "arm_pud_language" | "no_survey_exception" | "jurisdiction_test_documented", boolean>>; readonly arm_or_pud?: boolean; }
export const AOL_ELEMENTS = ["addressee", "indemnity", "gap", "priority_fee_simple", "subordinate_liens_listed", "alta_8_1_language", "no_survey_exception", "jurisdiction_test_documented"] as const;
/** Rule 12: barred for co-op, leasehold/CLT, MH, HomeStyle, TX 50(a)(6) and POA loans; otherwise every B7-2-06 element; SFC 155. */
export function evaluateAolPath(a: AolInput): { allowed: boolean; reason: string | null; missing_elements: string[]; sfc_155: boolean; required_instead: string[] } {
  if (!a.aol_enabled) return { allowed: false, reason: "title.aol_enabled=false", missing_elements: [], sfc_155: false, required_instead: ["ALTA 2021 loan policy"] };
  const barred = a.co_op ? "co_op" : a.leasehold_or_clt ? "leasehold_or_community_land_trust" : a.manufactured_home ? "manufactured_home" : a.homestyle ? "homestyle" : a.tx_50a6 ? "texas_50a6" : a.poa ? "power_of_attorney" : null;
  if (barred) return { allowed: false, reason: `ineligible_transaction:${barred}`, missing_elements: [], sfc_155: false, required_instead: a.tx_50a6 ? ["T-2", "T-42", "T-42.1"] : ["ALTA 2021 loan policy"] };
  const missing: string[] = [];
  if (!a.attorney_licensed_in_state) missing.push("attorney_licensed_in_state"); if (!a.malpractice_prevailing) missing.push("malpractice_cover_prevailing_amount");
  for (const e of AOL_ELEMENTS) if (!a.elements?.[e]) missing.push(e);
  if (a.arm_or_pud && !a.elements?.arm_pud_language) missing.push("arm_pud_language");
  return { allowed: missing.length === 0, reason: missing.length ? "aol_elements_missing" : null, missing_elements: missing, sfc_155: missing.length === 0, required_instead: [] };
}
/** T-42 ¶2(a)–(e) may not be deleted; T-2 + T-42 + T-42.1 required; closing only at a physical office (7 TAC §153.15) — no RON. */
export function tx50a6TitleCheck(i: { endorsements: readonly string[]; t42_deleted_paragraphs?: readonly string[]; closing_type?: string; closing_at_authorized_office?: boolean }): GateOutcome & { required: string[]; ron_refused: boolean } {
  const required = ["T-2", "T-42", "T-42.1"]; const reasons: string[] = [];
  for (const m of missingEndorsements(required, i.endorsements)) reasons.push(`endorsement_missing:${m}`);
  const bad = (i.t42_deleted_paragraphs ?? []).filter((p) => /^2\([a-e]\)$/.test(p)); if (bad.length) reasons.push(`t42_paragraph_deleted:${bad.join(",")}`);
  const ron = i.closing_type === "ron" || i.closing_type === "hybrid_ron"; if (ron) reasons.push("ron_closing_not_permitted_tx_50a6");
  if (i.closing_at_authorized_office === false) reasons.push("closing_not_at_authorized_office");
  return { open: reasons.length === 0, reason: reasons[0] ?? null, reasons, required, ron_refused: ron };
}
/** Rule 15: `new_money = new_note − unpaid principal of the consolidated notes`; mortgage recording tax on new money only; §255 affidavit and the existing lender's assignment are deliverables. */
export function cemaNewMoney(i: { new_note_cents: Cents; consolidated_upb_cents: Cents; existing_lender_will_assign: boolean; mortgage_tax_rate_bps?: number }): { new_money_cents: Cents; mortgage_tax_base_cents: Cents; mortgage_tax_cents: Cents | null; deliverables: string[]; cema_available: boolean; fallback: string | null } {
  need(i.new_note_cents >= i.consolidated_upb_cents, "new note must be at least the consolidated unpaid principal");
  if (!i.existing_lender_will_assign) return { new_money_cents: i.new_note_cents - i.consolidated_upb_cents, mortgage_tax_base_cents: i.new_note_cents, mortgage_tax_cents: i.mortgage_tax_rate_bps === undefined ? null : (i.new_note_cents * BigInt(i.mortgage_tax_rate_bps)) / 10_000n, deliverables: [], cema_available: false, fallback: "standard refinance with full mortgage tax; 21.5 changed circumstance if the CEMA was assumed" };
  const nm = i.new_note_cents - i.consolidated_upb_cents;
  return { new_money_cents: nm, mortgage_tax_base_cents: nm, mortgage_tax_cents: i.mortgage_tax_rate_bps === undefined ? null : (nm * BigInt(i.mortgage_tax_rate_bps)) / 10_000n, deliverables: ["section_255_affidavit", "assignment_of_mortgage_from_existing_lender", "consolidated_lien_insured_for_full_amount", "form_3172 (26.1)"], cema_available: true, fallback: null };
}

// ============================================================ title order + fee gate (21.4) and event recorders
export interface TitleOrderInput { readonly application_id: string; readonly order_type: "commitment" | "datedown" | "final_policy" | "cpl" | "hoa_status" | "tax_cert" | "payoff_wire_check"; readonly settlement_agent_party_id: string; readonly underwriter_party_id: string | null; readonly apn: string; readonly proposed_insured_text: string; readonly note_amount_cents: Cents; readonly requested_endorsements: readonly string[]; readonly closing_date: PlainDate | null; readonly ordered_at: string; }
export interface TitleOrder { readonly id: string; readonly application_id: string; readonly order_type: string; readonly settlement_agent_party_id: string; readonly underwriter_party_id: string | null; readonly apn: string; readonly proposed_insured_text: string; readonly note_amount_cents: Cents; readonly requested_endorsements: readonly string[]; readonly closing_date: PlainDate | null; readonly ordered_at: string; readonly status: TitleOrderStatus; readonly fee_gate_check_id: string | null; }
/** 21.4's fee gate for the command `order_title` runs first (impose/collect the title fee only after LE receipt and intent to proceed); the order itself is placed regardless when no fee is imposed. */
export function orderTitleFeeGate(events: EventStore, f: Omit<FeeGateFacts, "command" | "fee_kind"> & { fee_kind?: string }): ReturnType<typeof checkFeeGate> {
  return checkFeeGate(events, { ...f, command: "order_title", fee_kind: f.fee_kind ?? "title_premium" }, AGENT_24_4);
}
export function placeTitleOrder(events: EventStore, c: EventCtx, i: TitleOrderInput, feeGateCheckId: string | null): { order: TitleOrder; events: DomainEvent[] } {
  need(!!i.settlement_agent_party_id, "settlement_agent_party_id is required"); need(!!i.apn, "apn is required (30.4 tax service)"); need(i.note_amount_cents > 0n, "note_amount_cents must be positive");
  need(!/\bMERS\b/i.test(i.proposed_insured_text), "the proposed insured is the partner, its successors and/or assigns — never MERS (B7-2-03)");
  const order: TitleOrder = { id: `TO-${randomUUID()}`, application_id: i.application_id, order_type: i.order_type, settlement_agent_party_id: i.settlement_agent_party_id, underwriter_party_id: i.underwriter_party_id, apn: i.apn, proposed_insured_text: i.proposed_insured_text, note_amount_cents: i.note_amount_cents, requested_endorsements: i.requested_endorsements, closing_date: i.closing_date, ordered_at: i.ordered_at, status: "ordered", fee_gate_check_id: feeGateCheckId };
  const e1 = appEvent(events, c, "title.ordered", { order_id: order.id, order_type: i.order_type, settlement_agent_party_id: i.settlement_agent_party_id, underwriter_party_id: i.underwriter_party_id, apn: i.apn, proposed_insured_text: i.proposed_insured_text, note_amount_cents: S(i.note_amount_cents), requested_endorsements: [...i.requested_endorsements], closing_date: i.closing_date, ordered_at: i.ordered_at, fee_gate_check_id: feeGateCheckId });
  const e2 = appEvent(events, c, "settlement_agent.assigned", { order_id: order.id, settlement_agent_party_id: i.settlement_agent_party_id, assigned_at: i.ordered_at });
  return { order, events: [e1, e2] };
}
export function recordCommitmentReceived(events: EventStore, c: EventCtx, i: { order_id: string; commitment_number: string; commitment_effective_date: PlainDate; apn: string; policy_form: string; policy_amount_cents: Cents; vesting: unknown; legal_description_hash: string; underwriter_party_id: string; required_endorsements: readonly string[]; missing_endorsements: readonly string[]; status: string; received_at: string }): DomainEvent {
  return appEvent(events, c, "title.commitment.received", { order_id: i.order_id, commitment_number: i.commitment_number, commitment_effective_date: i.commitment_effective_date, apn: i.apn, policy_form: i.policy_form, policy_amount_cents: S(i.policy_amount_cents), vesting: i.vesting, legal_description_hash: i.legal_description_hash, underwriter_party_id: i.underwriter_party_id, required_endorsements: [...i.required_endorsements], missing_endorsements: [...i.missing_endorsements], status: i.status, received_at: i.received_at, consumers: ["25.2", "26.1", "30.4"] });
}
export function recordOrderRejected(events: EventStore, c: EventCtx, i: { order_id: string; reason: string; action: string | null; underwriter_party_id: string }): DomainEvent { return appEvent(events, c, "title.order.rejected", { order_id: i.order_id, reason: i.reason, action: i.action, underwriter_party_id: i.underwriter_party_id, addressed_to: "settlement_agent" }); }
export function recordExceptionClassified(events: EventStore, c: EventCtx, i: { order_id: string; text: string; kind: string; classification: string; blocking: boolean; rule: string }): DomainEvent { return appEvent(events, c, "title.exception.classified", { ...i }); }
export function recordEndorsementsRequired(events: EventStore, c: EventCtx, i: { order_id: string; required_endorsements: readonly string[]; missing_endorsements: readonly string[] }): DomainEvent { return appEvent(events, c, "title.endorsements.required", { order_id: i.order_id, required_endorsements: [...i.required_endorsements], missing_endorsements: [...i.missing_endorsements] }); }
export function recordCurativeOpened(events: EventStore, c: EventCtx, item: CurativeItem): DomainEvent { return appEvent(events, c, "title.curative.opened", { curative_id: item.id, title_order_id: item.title_order_id, kind: item.kind, source: item.source, owner: item.owner, blocks_consummation: item.blocks_consummation, amount_cents: item.amount_cents === null ? null : S(item.amount_cents), description: item.description, opened_at: item.opened_at }); }
export function recordCurativeCleared(events: EventStore, c: EventCtx, item: CurativeItem): DomainEvent { return appEvent(events, c, "title.curative.cleared", { curative_id: item.id, title_order_id: item.title_order_id, kind: item.kind, resolution: item.resolution, evidence_document_id: item.evidence_document_id, cleared_at: item.cleared_at }); }
export function recordOrderStatus(events: EventStore, c: EventCtx, i: { order_id: string; from: TitleOrderStatus; status: TitleOrderStatus; at: string }): DomainEvent { return appEvent(events, c, "title.order.status_changed", { order_id: i.order_id, from: i.from, status: transitionTitleOrder(i.from, i.status), at: i.at }); }
export function recordDatedownReceived(events: EventStore, c: EventCtx, i: { order_id: string; effective_date: PlainDate; consummation_on: PlainDate | null; received_at: string }): { event: DomainEvent; gate: ReturnType<typeof commitmentDatedownGate> } {
  const gate = commitmentDatedownGate({ commitment_effective_date: i.effective_date, consummation_on: i.consummation_on });
  return { event: appEvent(events, c, "title.datedown.received", { order_id: i.order_id, effective_date: i.effective_date, consummation_on: i.consummation_on, in_window: gate.open, received_at: i.received_at }), gate };
}
/** Every AOL evaluation on the bus: `title.aol.evaluated{sfc_155}` is the SFC-155 source 29.3 harvests (its owner map keys this event), whether or not an order is named. */
export function recordAolEvaluated(events: EventStore, c: EventCtx, r: ReturnType<typeof evaluateAolPath>, order_id: string | null = null): DomainEvent {
  return appEvent(events, c, "title.aol.evaluated", { order_id, allowed: r.allowed, sfc_155: r.sfc_155, reason: r.reason, missing_elements: [...r.missing_elements], required_instead: [...r.required_instead] });
}
export function recordAolDecision(events: EventStore, c: EventCtx, r: ReturnType<typeof evaluateAolPath>, o: { order_id: string; approved_by?: string | null }): DomainEvent {
  return r.allowed ? appEvent(events, c, "title.aol.approved", { order_id: o.order_id, sfc_155: true, approved_by: o.approved_by ?? null }) : appEvent(events, c, "title.aol.refused", { order_id: o.order_id, reason: r.reason, missing_elements: [...r.missing_elements], required_instead: [...r.required_instead] });
}
export function recordAgentVetted(events: EventStore, c: EventCtx, i: { party_id: string } & ReturnType<typeof vetSettlementAgent>): DomainEvent {
  return i.vetting_status === "rejected" ? appEvent(events, c, "settlement_agent.rejected", { settlement_agent_party_id: i.party_id, vetting_status: i.vetting_status, reasons: [...i.reasons] }) : appEvent(events, c, "settlement_agent.vetted", { settlement_agent_party_id: i.party_id, vetting_status: i.vetting_status, conditions: [...i.conditions], vetting_expires_on: i.vetting_expires_on });
}
export function recordWireVerification(events: EventStore, c: EventCtx, v: WireVerification): DomainEvent[] {
  const out: DomainEvent[] = [];
  if (v.change_detected_at) out.push(appEvent(events, c, "wire.instructions.change_detected", { wire_verification_id: v.id, purpose: v.purpose, beneficiary_party_id: v.beneficiary_party_id, match_result: v.match_result, hours_to_funding: v.hours_to_funding, blocked: v.blocks_disbursement, release_requires: v.release_requires, change_detected_at: v.change_detected_at }));
  if (v.verified_at && !v.blocks_disbursement) out.push(appEvent(events, c, "wire.instructions.verified", { wire_verification_id: v.id, purpose: v.purpose, beneficiary_party_id: v.beneficiary_party_id, vendor: v.vendor, match_result: v.match_result, callback_number_source: v.callback_number_source, verified_at: v.verified_at, expires_at: v.expires_at }));
  return out;
}
export function recordCplReceived(events: EventStore, c: EventCtx, i: { order_id: string; cpl_document_id: string; cpl_date: PlainDate | null } & ReturnType<typeof cplBeforeFundingGate>): DomainEvent {
  return appEvent(events, c, "cpl.received", { order_id: i.order_id, cpl_document_id: i.cpl_document_id, cpl_date: i.cpl_date, cpl_addressee_ok: i.cpl_addressee_ok && i.open, cpl_agent_ok: i.cpl_agent_ok, reasons: [...i.reasons] });
}
export interface PayoffRequestInput { readonly application_id: string; readonly liability_id: string; readonly same_servicer: boolean; readonly servicing_loan_id?: string | null; readonly existing_servicer_party_id: string; readonly requested_at: string; readonly requested_on: PlainDate; readonly request_channel: string; readonly written_authorization_document_id: string | null; readonly requested_good_through: PlainDate; readonly state: string; readonly refresh?: boolean; }
/** requestPayoff: external servicer → written demand (`payoff.demand.requested{same_servicer=false}` arms the 7-BD follow-up); same servicer → 16.1's `payoffRequestIntake` on the existing loan (7.6's `payoff.request.received` arms REGZ_1026_36C3_PAYOFF_STMT_7BD). */
export function requestPayoff(events: EventStore, c: EventCtx, i: PayoffRequestInput): { demand_event: DomainEvent; servicing_event: DomainEvent | null; servicing_intake: PayoffRequestReceived | null; follow_up_due: PlainDate | null; status: "requested" } {
  need(!!i.written_authorization_document_id, "a written payoff request needs the borrower's authorization on file (comment 36(c)(3)-1)");
  let servicing: DomainEvent | null = null; let intake: PayoffRequestReceived | null = null;
  if (i.same_servicer) {
    need(!!i.servicing_loan_id, "same_servicer needs the servicing loan id (16.1)");
    const r = payoffRequestIntake({ request_id: `PR-${i.application_id}-${i.liability_id}${i.refresh ? "-refresh" : ""}`, loan_id: i.servicing_loan_id!, channel: "api", written: true, received_at: i.requested_at, received_on: i.requested_on, state: i.state, requester_type: "lender_or_title", authorization_evidence: true, requested_good_through: i.requested_good_through });
    intake = r.event;
    servicing = events.append({ type: r.event.type, loanId: i.servicing_loan_id!, applicationId: i.application_id, actor: c.actor ?? AGENT_24_4, ...(c.at ? { occurredAt: c.at } : {}), payload: { ...r.event.payload, requested_by: "origination", application_id: i.application_id } });
  }
  const demand = appEvent(events, c, "payoff.demand.requested", { liability_id: i.liability_id, same_servicer: i.same_servicer, servicing_loan_id: i.servicing_loan_id ?? null, existing_servicer_party_id: i.existing_servicer_party_id, requested_at: i.requested_at, requested_on: i.requested_on, request_channel: i.same_servicer ? "servicing_16_1" : i.request_channel, requested_good_through: i.requested_good_through, refresh: i.refresh === true, written_authorization_document_id: i.written_authorization_document_id, follow_up_timer: i.same_servicer ? "REGZ_1026_36C3_PAYOFF_STMT_7BD (16.1)" : "SM_PAYOFF_DEMAND_FOLLOWUP_7BD" });
  return { demand_event: demand, servicing_event: servicing, servicing_intake: intake, follow_up_due: i.same_servicer ? null : payoffFollowUpDue(i.requested_on), status: "requested" };
}
export function recordPayoffStatement(events: EventStore, c: EventCtx, i: { liability_id: string; statement_document_id: string; statement_date: PlainDate; good_through_date: PlainDate; parsed: ParsedPayoff; disbursement_date: PlainDate | null; refresh: boolean; received_at: string }): DomainEvent {
  const covers = i.disbursement_date !== null && i.good_through_date >= i.disbursement_date;
  return appEvent(events, c, "payoff.statement.received", { liability_id: i.liability_id, statement_document_id: i.statement_document_id, statement_date: i.statement_date, good_through_date: i.good_through_date, total_cents: S(i.parsed.total_cents), interest_cents: S(i.parsed.interest_cents), per_diem_reconciles: i.parsed.per_diem_reconciles, short_payoff: i.parsed.short_payoff, status: i.parsed.status === "rejected" ? "rejected" : i.refresh ? "refreshed" : "received", disbursement_date: i.disbursement_date, covers_disbursement: covers && i.parsed.status !== "rejected", received_at: i.received_at });
}
export function recordPayoffStale(events: EventStore, c: EventCtx, i: { liability_id: string; good_through_date: PlainDate; disbursement_date: PlainDate; reasons: readonly string[]; planning_total_cents: Cents }): DomainEvent {
  return appEvent(events, c, "payoff.statement.stale", { liability_id: i.liability_id, good_through_date: i.good_through_date, disbursement_date: i.disbursement_date, reasons: [...i.reasons], planning_total_cents: S(i.planning_total_cents), action: "refresh requested — funding never uses the planning figure (comment 36(c)(3)-3)" });
}
export function recordEscrowTreatment(events: EventStore, c: EventCtx, i: { liability_id: string; servicing_loan_id: string } & ReturnType<typeof decideEscrowTreatment>): DomainEvent {
  return appEvent(events, c, "payoff.escrow_treatment.decided", { liability_id: i.liability_id, servicing_loan_id: i.servicing_loan_id, escrow_treatment: i.escrow_treatment, refund_due_on: i.refund_due_on, refund_method: i.refund_method, credited_cents: S(i.credited_cents), new_initial_deposit_cents: i.new_initial_deposit_cents === null ? null : S(i.new_initial_deposit_cents), refund_check_issued: i.refund_check_issued, excess_refund_cents: S(i.excess_refund_cents), rule_ref: i.rule_ref, consumers: ["25.2 CD", "30.3 initial deposit", "3.5 refund"] });
}
export function recordSubordinationRequested(events: EventStore, c: EventCtx, i: { liability_id: string; lienholder_party_id: string; lien_kind: string; requested_on: PlainDate; cltv_bps: number; hcltv_bps: number; heloc_line_cents: Cents | null; heloc_drawn_cents: Cents | null }): DomainEvent {
  return appEvent(events, c, "subordination.requested", { liability_id: i.liability_id, lienholder_party_id: i.lienholder_party_id, lien_kind: i.lien_kind, requested_on: i.requested_on, cltv_bps: i.cltv_bps, hcltv_bps: i.hcltv_bps, heloc_line_cents: i.heloc_line_cents === null ? null : S(i.heloc_line_cents), heloc_drawn_cents: i.heloc_drawn_cents === null ? null : S(i.heloc_drawn_cents), status: "requested" });
}
export function recordSubordinationAgreement(events: EventStore, c: EventCtx, i: { liability_id: string; agreement_document_id: string; executed_at: PlainDate | null; recordable: boolean; terms: ReturnType<typeof checkSubordinateTerms> }): { event: DomainEvent; status: SubordinationStatus } {
  if (!i.terms.terms_ok) return { status: "rejected", event: appEvent(events, c, "subordination.rejected", { liability_id: i.liability_id, agreement_document_id: i.agreement_document_id, terms_ok: false, reasons: [...i.terms.reasons], action: i.terms.action }) };
  if (!i.executed_at) return { status: "received", event: appEvent(events, c, "subordination.received", { liability_id: i.liability_id, agreement_document_id: i.agreement_document_id, terms_ok: true, status: "received" }) };
  return { status: "executed", event: appEvent(events, c, "subordination.executed", { liability_id: i.liability_id, agreement_document_id: i.agreement_document_id, executed_at: i.executed_at, recordable: i.recordable, terms_ok: true, status: "executed" }) };
}
export function recordTrustReviewed(events: EventStore, c: EventCtx, i: { borrower_id: string; trust_name: string } & TrustReview): DomainEvent { return appEvent(events, c, "trust.reviewed", { borrower_id: i.borrower_id, trust_name: i.trust_name, result: i.result, reasons: [...i.reasons], sfc_168: i.sfc_168, signature_plan: [...i.signature_plan] }); }
export function recordPoaReviewed(events: EventStore, c: EventCtx, i: { borrower_id: string } & PoaReview): DomainEvent { return appEvent(events, c, "poa.reviewed", { borrower_id: i.borrower_id, result: i.result, reasons: [...i.reasons], cpl_required: i.cpl_required, interactive_session_required: i.interactive_session_required, aol_barred: true }); }
export function recordVestingReviewsCompleted(events: EventStore, c: EventCtx, gate: GateOutcome): DomainEvent { return appEvent(events, c, "vesting.reviews.completed", { all_eligible: gate.open, reasons: [...gate.reasons] }); }

// ============================================================ gate evaluation for the commands 25.2 / 26.1 / 26.3 call
export const GATES_24_4 = { consummate: ["FNMA_B2_1_2_04_RESUBORDINATION_GATE", "SM_TITLE_COMMITMENT_DATEDOWN_GATE", "SM_SETTLEMENT_AGENT_VETTING_GATE"], generate_documents: ["SM_TRUST_POA_REVIEW_GATE"], disburse: ["FNMA_B7_2_01_TITLE_EVIDENCE_GATE", "SM_CPL_BEFORE_FUNDING_GATE", "SM_WIRE_VERIFICATION_GATE", "SM_PAYOFF_GOOD_THROUGH_GATE"] } as const;
export interface GateEvaluation { readonly command: "consummate" | "generate_documents" | "disburse"; readonly open: boolean; readonly refused_by: string | null; readonly gates: { code: string; open: boolean; reason: string | null }[]; }
export function evaluateGates(command: GateEvaluation["command"], results: Record<string, GateOutcome>): GateEvaluation {
  const gates = GATES_24_4[command].map((code) => { const r = results[code]; need(r !== undefined, `no evaluation for ${code}`); return { code, open: r!.open, reason: r!.reason }; });
  const first = gates.find((g) => !g.open);
  return { command, open: !first, refused_by: first?.code ?? null, gates };
}

// ============================================================ vendor ports (fakes for the runtime and tests)
export interface TitleVendorPort { order(i: { order_id: string; application_id: string; settlement_agent_party_id: string; payload: Record<string, unknown> }): Promise<{ vendor_ref: string; accepted: boolean }>; }
export interface WireVerificationPort { verify(i: { application_id: string; purpose: string; beneficiary_party_id: string; routing_number: string; account_number: string }): Promise<{ match: WireMatch; confidence: number; registered_on: string | null; last_verified: string | null; vendor_ref: string }>; }
export interface AltaRegistryPort { lookup(party_id: string): Promise<{ alta_registry_id: string | null; underwriter_confirmed_by: string | null; phone: string | null; cached_at: string }>; }
export interface StateDoiPort { insurerLicensed(insurer_party_id: string, state: string): Promise<boolean | null>; }
export class FakeTitleVendor implements TitleVendorPort { readonly orders: Record<string, unknown>[] = []; async order(i: { order_id: string; application_id: string; settlement_agent_party_id: string; payload: Record<string, unknown> }) { this.orders.push(i); return { vendor_ref: `TV-${this.orders.length}`, accepted: true }; } }
export class FakeWireVerification implements WireVerificationPort {
  private readonly registered = new Map<string, string>(); readonly calls: Record<string, unknown>[] = [];
  register(beneficiary_party_id: string, routing: string, account: string): void { this.registered.set(beneficiary_party_id, instructionsHash(routing, account)); }
  async verify(i: { application_id: string; purpose: string; beneficiary_party_id: string; routing_number: string; account_number: string }) {
    this.calls.push(i); const reg = this.registered.get(i.beneficiary_party_id); const h = instructionsHash(i.routing_number, i.account_number);
    const match: WireMatch = reg === undefined ? "not_found" : reg === h ? "verified" : "changed";
    return { match, confidence: match === "verified" ? 0.99 : 0.2, registered_on: reg ? "2026-01-15" : null, last_verified: reg ? "2026-10-30" : null, vendor_ref: `WV-${this.calls.length}` };
  }
}
export class FakeAltaRegistry implements AltaRegistryPort { private readonly rows = new Map<string, { alta_registry_id: string | null; underwriter_confirmed_by: string | null; phone: string | null }>(); seed(party_id: string, r: { alta_registry_id: string | null; underwriter_confirmed_by: string | null; phone: string | null }): void { this.rows.set(party_id, r); } async lookup(party_id: string) { return { ...(this.rows.get(party_id) ?? { alta_registry_id: null, underwriter_confirmed_by: null, phone: null }), cached_at: "2026-10-05T00:00:00.000Z" }; } }
export class FakeStateDoi implements StateDoiPort { private readonly licensed = new Map<string, boolean>(); seed(insurer_party_id: string, state: string, licensed: boolean): void { this.licensed.set(`${insurer_party_id}|${state}`, licensed); } async insurerLicensed(insurer_party_id: string, state: string) { return this.licensed.get(`${insurer_party_id}|${state}`) ?? null; } }
