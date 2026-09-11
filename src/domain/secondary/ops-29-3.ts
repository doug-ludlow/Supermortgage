/**
 * §29.3 Delivery data preparation and pre-delivery validation — the `secondary` agent builds, validates, freezes and
 * hashes the ULDD Phase 5 (5.2.0) delivery package end-to-end: prerequisites collected from the finished processes'
 * events (never recomputed), Appendix D conditionality evaluated per Sort ID, the Special Feature Code set assembled
 * from the codes those processes queued, identifier consistency (R3) and SFC completeness (R4) gated before any build,
 * EarlyCheck run over Direct Integration XML (a clean run is not a clean import — 3000-series commitment edits are
 * 29.4's), derivable edits fixed by rule (enumeration defaults, formatting, EarlyCheck's standardized address),
 * non-derivable edits routed to their owners, the package frozen with `uldd_sha256` = SHA-256 of the exact bytes the
 * clean run certified, and any post-freeze data change superseding the package. One small function per rule / T-id
 * plus a thin `DeliveryBuildService` over the event store.
 *
 * Seam contracts (every SFC and identifier comes from the owning process's event — see `collectPrerequisites`):
 *   20.4 quote.locked{sfcs}, 22.3 delivery.sfc.queued{code=707}, 22.4 subordinate_financing.declared + SFC 118,
 *   22.6 ssn.validated{sfc_162_required}, 23.2 du.findings.interpreted{sfc_required} / homeownership_education.verified{sfc_184},
 *   24.1 deliveryData() SFC 801/774, 24.3 project.review.completed (SID 39/49.x) / mh.verification.completed{special_feature_codes},
 *   24.4 trust.reviewed{sfc_168} / AOL sfc_155, 24.5 flood.determination.received{sfc_180}, 23.4 compliance.high_cost.determined{fnma_eligible},
 *   24.2 valuation.review.completed{doc_file_id}, 25.2 ucd.accepted{casefile_id_ucd, is_final} / delivery.package.incomplete{reason=seller_cd_missing},
 *   30.2 ulddLenderLoanNumber (the servicing loan number IS the Lender Loan Number), 23.3 rep_warrant_relief.evaluated,
 *   26.1 buydown.agreement.executed{sfc∈{009, 014}}, 27.1/30.1 payee code (Form 482) and bailee Letter Name, 29.1 commitment.executed.
 *
 * Events emitted (all carry `applicationId` and `loanId` — the timer engine arms 29.3 rows only under origination context):
 *   delivery.assembling{delivery_id, build_no}                                   [arms the four `assembling` gates]
 *   delivery.identifiers.reconciled{identifier_snapshot}                          [satisfies FNMA_ULDD_IDENTIFIER_CONSISTENCY_GATE]
 *   delivery.identifier.mismatch.detected{identifier, expected, found, owner}     [breach of that gate]
 *   delivery.correction.requested{owner_process, kind, identifier?}               [the owner's resubmission / data-correction request]
 *   delivery.sfc.assigned{codes, rule_refs}                                       [satisfies FNMA_C1_2_02_SFC_COMPLETENESS_GATE]
 *   delivery.uldd.built{build_no, sha256, phase}                                  [satisfies SM_O103_ULDD_BUILD_SLA_1BD and the two assertion gates; arms the clean gate]
 *   earlycheck.completed{run_id, file_kind, clean, fatal_count, file_sha256, channel}   [satisfies the two EarlyCheck gates; arms SM_O103_PACKAGE_FREEZE_GATE]
 *   delivery.edit.observed{edit_id, source, severity, prefix, owner_process}      [shared with 29.4]
 *   delivery.uldd.rebuilt{reason, build_no}
 *   delivery.package.frozen{package_id, sha256, version}                          [satisfies SM_O103_PACKAGE_FREEZE_SLA_2BD / SM_O103_PACKAGE_FREEZE_GATE]
 *   delivery.package.superseded{reason, package_id}                               [satisfies SM_O103_REBUILD_ON_CHANGE]
 *   delivery.operator_task.cancelled{package_id, escalation_id}                   [29.4 consumes]
 *   property.address.standardized{source=earlycheck_standardization}             [the `properties` audit row]
 */
import { createHash, randomUUID } from "node:crypto";
import { type PlainDate, addMonths, plainDate } from "../../kernel/calendar/date.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import { Decimal } from "../../kernel/money/decimal.ts";
import { type Cents, levelPayment, ratePercent, centsToDecimal } from "../../kernel/money/cents.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import type { EscalationService } from "../../app/escalations.ts";
import { ulddLenderLoanNumber } from "../orig-boarding/ops-30-2.ts";

export const SECONDARY_AGENT: Actor = { kind: "agent", id: "secondary" };
export const ULDD_PHASE = "5.2.0";
export const RULE_SET_VERSIONS_29_3 = { uldd: "fnma.uldd.5.2.0", ucd: "fnma.ucd.2.0", uad: "fnma.uad.3.6", selling: "fnma.selling.2026-09-02", sfc: "fnma.sfc.2026-09-09", du: "fnma.du.12.1", mers: "mers.proc.26.1" } as const;
export const MODEL_VERSION_29_3 = "secondary.delivery.v1";
export const PROMPT_VERSION_29_3 = "29.3.build.v1";
/** "Up to ten SFCs may be reported at delivery on an individual mortgage loan" (SFC list 09.09.2026). */
export const SFC_CAP = 10;
/** EarlyCheck DI: after 60 minutes without a result the same file goes to the `fnma_portal_operator` (UI fallback). */
export const EARLYCHECK_DI_TIMEOUT_MINUTES = 60;
/** B4-1.4-10: the value acceptance offer "is not more than four months old on the date of the note and the mortgage". */
export const VALUE_ACCEPTANCE_OFFER_MAX_MONTHS = 4;
export const SFC_RULE_REFS: Readonly<Record<string, string>> = {
  "127": "23.2/SFC-127-always (A2-2-04 limited waiver; 'all mortgage loans underwritten through DU')", "007": "23.2|20.4/limited_cash_out (SFC list: LCOR)", "003": "23.2/cash_out",
  "067": "LL-2026-06/score_model=vantagescore_4", "900": "23.2|20.4/HomeReady", "184": "23.2/homeownership_education.verified{sfc_184}", "801": "24.1/value_acceptance (B4-1.4-10)", "774": "24.1/value_acceptance_pd (B4-1.4-11)",
  "808": "20.4/high_balance", "118": "22.4/subordinate_financing.declared{kind=community_second}", "009": "26.1/buydown ≤2pt ≤2y", "014": "26.1/buydown >2pt or >2y", "168": "24.4/trust.reviewed{sfc_168} (inter vivos revocable trust)",
  "304": "24.4/texas_50a6", "155": "24.4/attorney_opinion_letter (B7-2-06)", "180": "24.5/flood.determination.received{sfc_180} (B7-3-06)", "019": "24.6/premium_plan∈{lpmi_monthly, lpmi_single}", "281": "24.6/financed_premium_cents>0",
  "508": "26.2/enote_indicator (C1-2-04 eMortgage)", "861": "26.2/signing_sessions.notarization_kind=ron", "920": "26.2/notarization_kind=rin", "707": "22.3/employment offer option 2 (B3-3.3-03)", "859": "24.3/mh.verification.completed (MH Advantage)",
  "235": "20.4|24.3/manufactured_home", "588": "24.3/detached_condominium", "874": "20.4/DTS LLPA waiver", "884": "20.4/pricing flag", "162": "22.6/ssn.validated{sfc_162_required}", "211": "31.1/TPO correspondent (flag delivery.sfc_tpo_code)", "212": "31.1/TPO broker (flag delivery.sfc_tpo_code)",
};
/** Event type → owning process for the rule reference on a harvested SFC. */
const SFC_EVENT_OWNERS: Readonly<Record<string, string>> = { "quote.locked": "20.4", "delivery.sfc.queued": "22.x", "subordinate_financing.declared": "22.4", "ssn.validated": "22.6", "du.findings.interpreted": "23.2", "homeownership_education.verified": "23.2",
  "valuation.delivery_data": "24.1", "project.review.completed": "24.3", "mh.verification.completed": "24.3", "trust.reviewed": "24.4", "title.aol.evaluated": "24.4", "flood.determination.received": "24.5", "mi.activated": "24.6", "buydown.agreement.executed": "26.1", "enote.registered": "26.2", "signing.session.completed": "26.2", "employment.offer.verified": "22.3" };
export const MI_ABSENCE_REASONS = ["NoMIBasedOnOriginalLTV", "MICanceledBasedOnCurrentLTV", "MICanceledBasedOnOriginalLTV", "NoMIBasedOnMHLTV", "MICanceledBasedOnCurrentValue"] as const;
export const COLLATERAL_PROGRAMS = ["ValueAcceptance", "PropertyInspectionAlternative"] as const;
export const SCORE_CATEGORY_VERSIONS: Readonly<Record<ScoreModel, string>> = { classic_fico: "ClassicFICO", vantagescore_4: "VantageScore4" };
/** Guardrail: a derived fix is limited to enumeration defaults and formatting — never these (amounts, dates, scores, values, identifiers). */
export const NON_DERIVABLE_SORT_IDS = ["322", "82", "311", "412", "401", "642", "650.1", "620", "652", "363", "251", "251.5", "590", "208", "NoteAmount", "NoteRatePercent", "ScheduledPrincipalAndInterestPayment", "NoteDate", "DisbursementDate", "ScheduledFirstPaymentDate", "MaturityDate", "PropertyValuationAmount", "UniversalLoanIdentifier", "InvestorCommitmentIdentifier"] as const;
export const DERIVABLE_EDIT_KINDS = ["enumeration_default", "standardized_address", "format_trim"] as const;

export type ScoreModel = "classic_fico" | "vantagescore_4";
export type BuildStatus = "pending_prerequisites" | "assembling" | "du_file_checked" | "uldd_built" | "earlycheck_pending" | "earlycheck_clean" | "earlycheck_failed" | "frozen" | "superseded" | "withdrawn";
export type LoanDeliveryStatus = "not_started" | "draft" | "submitted" | "purchase_requested" | "purchase_ready" | "purchased_and_funded";
export type Conditionality = "R" | "CR" | "CI" | "O";
export type EditSeverity = "fatal" | "warning_to_fatal" | "warning" | "informational" | "observational";
export type EditResolution = "data_corrected" | "source_corrected_upstream" | "bypassed_with_justification" | "unresolved" | "not_applicable";
export type FileKind = "du_spec_3_4" | "uldd_3_0";

export class DeliveryRefused extends Error {
  readonly code: string; readonly citation: string; readonly detail: string;
  constructor(code: string, citation: string, detail: string) { super(`${code}: ${detail}`); this.name = "DeliveryRefused"; this.code = code; this.citation = citation; this.detail = detail; }
}
const nonEmpty = (v: unknown, what: string): string => { if (typeof v !== "string" || !v.trim()) throw new RangeError(`${what} is required`); return v; };
export const sha256Hex = (bytes: string): string => createHash("sha256").update(bytes, "utf8").digest("hex");
const etDate = (iso: string): PlainDate => wallClock(Date.parse(iso), "America/New_York").date;

// ============================================================ the loan file (prerequisite records)
export interface SfcCandidate { readonly code: string; readonly rule_ref: string; readonly source_event: string; readonly required: boolean; readonly evidence_ref: string | null; }
export interface LoanFile {
  readonly application_id: string; readonly loan_id: string; readonly partner_id: string; readonly seller_number: string; readonly servicing_loan_number: string;
  readonly purpose: "purchase" | "limited_cash_out" | "cash_out"; readonly loan_amount_cents: Cents; readonly note_rate_pct: string; readonly term_months: number;
  readonly note_date: PlainDate; readonly disbursement_date: PlainDate; readonly first_payment_date: PlainDate; readonly maturity_date: PlainDate;
  readonly sales_price_cents: Cents | null; readonly appraised_value_cents: Cents; readonly property: { readonly property_id: string; readonly street: string; readonly city: string; readonly state: string; readonly zip: string; readonly units: number; readonly usage: "PrimaryResidence" | "SecondHome" | "Investment"; readonly type: string };
  readonly escrowed: boolean; readonly initial_escrow_deposit_cents: Cents | null;
  readonly du: { readonly casefile_id: string; readonly is_final: boolean; readonly recommendation: string; readonly closed_loan_snapshot_hash: string; readonly du_spec_file_sha256: string; readonly du_spec_document_id: string } | null;
  readonly ucd: { readonly casefile_id_ucd: string | null; readonly status: string; readonly is_final: boolean; readonly embedded_cd_version: number; readonly current_rate_set_date: PlainDate | null } | null;
  readonly ucdp: { readonly doc_file_id: string | null; readonly status: string; readonly uad_version: string | null } | null;
  readonly valuation: { readonly method: string; readonly offer_date: PlainDate | null; readonly property_data_id: string | null; readonly special_feature_codes: readonly string[] };
  readonly project: { readonly review_type: string; readonly cpm_project_id: string | null; readonly cpm_certification_id: string | null; readonly cpm_phase_id: string | null; readonly expires_at: PlainDate | null; readonly project_type_code: string | null } | null;
  readonly mi: { readonly certificate_number: string; readonly mi_company_code: string; readonly coverage_pct: string; readonly premium_plan: string; readonly financed_premium_cents: Cents; readonly status: string; readonly activated_at: string | null } | null;
  readonly lock: { readonly locked_on: PlainDate; readonly extensions: readonly { readonly on: PlainDate; readonly rate_changed: boolean }[] };
  readonly commitment: { readonly commitment_id_fnma: string; readonly expires_on: PlainDate; readonly type: "best_efforts" | "mandatory"; readonly remittance_type: string; readonly pass_through_rate: string; readonly servicing_fee_rate: string } | null;
  readonly warehouse: { readonly advance_outstanding: boolean; readonly payee_code: string | null; readonly warehouse_lender_id: string | null; readonly custodian_fin: string | null; readonly bailee_letter_name: string | null };
  readonly note: { readonly form: "paper" | "enote"; readonly enote_registered_at: string | null; readonly min: string | null; readonly closing_type: "paper" | "hybrid" | "ron" | "ipen" };
  readonly notarization_kind: "in_person" | "ron" | "rin";
  readonly credit: { readonly borrowers: readonly { readonly borrower_id: string; readonly score_model: ScoreModel }[]; readonly representative_score: number; readonly selection_method: string };
  readonly hmda: { readonly rate_spread_pct: string | null; readonly uli: string };
  readonly compliance: { readonly fnma_eligible: boolean; readonly pre_delivery_checkpoint_passed_at: string | null };
  readonly subordinations: readonly { readonly amount_cents: Cents; readonly community_seconds: boolean }[];
  readonly sfc_queue: readonly SfcCandidate[];
  /** Composed gates other processes own, as their events left them (recorded verbatim in `delivery_packages.gate_results`). */
  readonly gates: Readonly<Record<string, "open" | "closed" | "n/a">>;
  readonly rep_warrant_relief: readonly { readonly component: string; readonly status: string }[];
  readonly prerequisite_checks: readonly { readonly name: string; readonly present: boolean; readonly source_event_id: string | null }[];
  /** 25.2's `delivery.package.incomplete{seller_cd_missing}` still open (no later final UCD acceptance). */
  readonly package_incomplete_reason: string | null;
}
type P = Record<string, unknown>;
const str = (p: P, k: string): string | null => (typeof p[k] === "string" && (p[k] as string) !== "" ? (p[k] as string) : null);
const date = (p: P, k: string): PlainDate | null => { const v = str(p, k); return v ? plainDate(v.slice(0, 10)) : null; };
/**
 * R4 sourcing: every SFC a finished process queued on its own event — `special_feature_codes[]`, `sfc_codes[]`, `sfcs[]`,
 * `sfc_required[]`, `sfc` (26.1), `code` on `delivery.sfc.queued`, and flag fields `sfc_<code>` / `sfc_<code>_required` = true.
 * Nothing here evaluates a Selling Guide condition — the owner did; 29.3 only cites the event.
 */
export function harvestSfcs(events: readonly DomainEvent[]): SfcCandidate[] {
  const out = new Map<string, SfcCandidate>();
  const add = (code: string, e: DomainEvent, required = true) => { const c = String(code).padStart(3, "0"); if (!/^\d{3}$/.test(c)) return; if (!out.has(c)) out.set(c, { code: c, rule_ref: SFC_RULE_REFS[c] ?? `${SFC_EVENT_OWNERS[e.type] ?? e.type}/${e.type}`, source_event: `${e.type}#${e.id}`, required, evidence_ref: e.id }); };
  for (const e of events) {
    const p = e.payload as P;
    for (const k of ["special_feature_codes", "sfc_codes", "sfcs", "sfc_required"]) if (Array.isArray(p[k])) for (const c of p[k] as unknown[]) add(String(c), e);
    if (typeof p.sfc === "string") add(p.sfc, e);
    if (e.type === "delivery.sfc.queued" && (typeof p.code === "string" || typeof p.code === "number")) add(String(p.code), e);
    for (const [k, v] of Object.entries(p)) { const m = /^sfc_(\d{3})(?:_required)?$/.exec(k); if (m && v === true) add(m[1]!, e); }
  }
  return [...out.values()].sort((a, b) => a.code.localeCompare(b.code));
}
/** The static snapshot (amounts, dates, property, credit, warehouse context) the events overlay; `collectPrerequisites` fills the rest from the finished processes' events. */
export type LoanFileBase = Omit<LoanFile, "du" | "ucd" | "ucdp" | "mi" | "commitment" | "sfc_queue" | "prerequisite_checks" | "package_incomplete_reason" | "rep_warrant_relief" | "gates" | "project" | "compliance"> & Partial<Pick<LoanFile, "du" | "ucd" | "ucdp" | "mi" | "commitment" | "sfc_queue" | "rep_warrant_relief" | "gates" | "project" | "compliance">>;
export function collectPrerequisites(events: EventStore, base: LoanFileBase): LoanFile {
  const mine = events.all().filter((e) => e.applicationId === base.application_id || e.loanId === base.loan_id);
  const last = (type: string, where: (p: P) => boolean = () => true): DomainEvent | null => [...mine].reverse().find((e) => e.type === type && where(e.payload as P)) ?? null;
  const checks: { name: string; present: boolean; source_event_id: string | null }[] = [];
  /** A prerequisite is present when its record exists; a conditional one (project review, MI, the Doc File ID under value acceptance) is present as "n/a" when the loan has no such record. */
  const check = <T>(name: string, e: DomainEvent | null, fallback: T | null | undefined, build: (p: P, e: DomainEvent) => T, optional = false): T | null => { const v = e ? build(e.payload as P, e) : (fallback ?? null); checks.push({ name, present: optional || (v !== null && v !== undefined), source_event_id: e?.id ?? null }); return v; };
  const valueAcceptance = base.valuation.method === "value_acceptance" || base.valuation.method === "value_acceptance_pd";
  const funded = last("loan.funded");
  const duFinal = last("du.final_submission.recorded"); const duCase = last("du.casefile.created") ?? last("du.credit.associated");
  const du = check("du_final_submission", duFinal, base.du, (p) => ({ casefile_id: str(p, "casefile_id") ?? (duCase ? str(duCase.payload as P, "casefile_id") : null) ?? base.du?.casefile_id ?? "", is_final: p.is_final !== false, recommendation: str(p, "recommendation") ?? "", closed_loan_snapshot_hash: str(p, "closed_loan_snapshot_hash") ?? "", du_spec_file_sha256: str(p, "du_spec_file_sha256") ?? base.du?.du_spec_file_sha256 ?? "", du_spec_document_id: str(p, "du_spec_document_id") ?? base.du?.du_spec_document_id ?? "" }));
  const ucdEv = last("ucd.accepted");
  const ucd = check("ucd_accepted", ucdEv, base.ucd, (p) => ({ casefile_id_ucd: str(p, "casefile_id_ucd"), status: str(p, "status") ?? "accepted", is_final: p.is_final === true, embedded_cd_version: Number(p.embedded_cd_version ?? 0), current_rate_set_date: date(p, "current_rate_set_date") ?? date(p, "rate_set_date") ?? base.ucd?.current_rate_set_date ?? null }));
  const incomplete = last("delivery.package.incomplete");
  const package_incomplete_reason = incomplete && (!ucdEv || incomplete.sequence > ucdEv.sequence) ? (str(incomplete.payload as P, "reason") ?? "incomplete") : null;
  const rev = last("valuation.review.completed", (p) => p.is_final_version !== false) ?? last("valuation.ucdp.submitted");
  const ucdp = check("ucdp_doc_file_id", rev, base.ucdp, (p) => ({ doc_file_id: str(p, "doc_file_id"), status: str(p, "ucdp_status") ?? "successful", uad_version: str(p, "uad_version") ?? base.ucdp?.uad_version ?? null }), valueAcceptance);
  const proj = last("project.review.completed");
  const project = check("project_review", proj, base.project, (p) => ({ review_type: str(p, "review_type") ?? "", cpm_project_id: str(p, "cpm_project_id"), cpm_certification_id: str(p, "cpm_certification_id"), cpm_phase_id: str(p, "cpm_phase_id"), expires_at: date(p, "expires_at"), project_type_code: str(p, "project_type_code") }), true);
  const miEv = last("mi.activated");
  const mi = check("mi_activated", miEv, base.mi, (p) => ({ certificate_number: str(p, "certificate_number") ?? "", mi_company_code: str(p, "mi_company_code") ?? "", coverage_pct: String(p.coverage_pct ?? ""), premium_plan: str(p, "premium_plan") ?? "", financed_premium_cents: BigInt(String(p.financed_premium_cents ?? "0")), status: "active", activated_at: str(p, "activated_at") ?? str(p, "at") ?? null }), true);
  const commEv = last("commitment.executed"); const ext = last("commitment.extended") ?? last("commitment.modified");
  const commitment = check("commitment", commEv, base.commitment, (p) => ({ commitment_id_fnma: str(p, "commitment_id_fnma") ?? "", expires_on: (ext && date(ext.payload as P, "expires_on")) ?? date(p, "expires_on") ?? plainDate("1970-01-01"), type: (str(p, "type") as "best_efforts" | "mandatory" | null) ?? "best_efforts", remittance_type: str(p, "remittance_type") ?? base.commitment?.remittance_type ?? "actual_actual", pass_through_rate: String(p.ptr ?? p.pass_through_rate ?? base.commitment?.pass_through_rate ?? ""), servicing_fee_rate: String(p.servicing_fee_rate ?? base.commitment?.servicing_fee_rate ?? "0.2500") }));
  const hc = last("compliance.high_cost.determined"); const cp = last("compliance.test.passed", (p) => p.checkpoint === "pre_delivery");
  const compliance = { fnma_eligible: hc ? (hc.payload as P).fnma_eligible === true : (base.compliance?.fnma_eligible ?? false), pre_delivery_checkpoint_passed_at: cp?.occurredAt ?? base.compliance?.pre_delivery_checkpoint_passed_at ?? null };
  checks.push({ name: "fnma_eligible (23.4)", present: compliance.fnma_eligible, source_event_id: hc?.id ?? null }, { name: "pre_delivery_compliance_checkpoint (25.1)", present: compliance.pre_delivery_checkpoint_passed_at !== null, source_event_id: cp?.id ?? null });
  const enote = last("enote.registered"); const mom = last("mers.min.registered");
  const note = enote ? { ...base.note, form: "enote" as const, enote_registered_at: str(enote.payload as P, "registered_at") ?? enote.occurredAt, min: str(enote.payload as P, "min") ?? base.note.min } : mom ? { ...base.note, min: str(mom.payload as P, "min") ?? base.note.min } : base.note;
  checks.push({ name: "note_registration (26.2/26.4)", present: note.min !== null, source_event_id: (enote ?? mom)?.id ?? null });
  const wh = last("warehouse.advance.funded"); const repaid = last("warehouse.advance.repaid");
  const warehouse = { ...base.warehouse, advance_outstanding: wh ? !(repaid && repaid.sequence > wh.sequence) : base.warehouse.advance_outstanding };
  checks.push({ name: "warehouse_context (27.1)", present: true, source_event_id: wh?.id ?? null });
  const lockEv = last("lock.executed"); const exts = mine.filter((e) => e.type === "lock.extended");
  const lock = lockEv ? { locked_on: date(lockEv.payload as P, "rate_set_date") ?? etDate(str(lockEv.payload as P, "locked_at") ?? lockEv.occurredAt), extensions: exts.map((e) => ({ on: date(e.payload as P, "extended_on") ?? etDate(e.occurredAt), rate_changed: (e.payload as P).rate_changed === true })) } : base.lock;
  checks.push({ name: "lock (21.4)", present: true, source_event_id: lockEv?.id ?? null });
  const rwr = last("rep_warrant_relief.evaluated");
  const rep_warrant_relief = rwr ? ((rwr.payload as P).components as { component: string; status: string }[] | undefined ?? []).map((c) => ({ component: c.component, status: c.status })) : (base.rep_warrant_relief ?? []);
  const disbursement_date = (funded && date(funded.payload as P, "disbursement_date")) ?? base.disbursement_date;
  checks.push({ name: "loan.funded (26.3)", present: funded !== null, source_event_id: funded?.id ?? null });
  const harvested = harvestSfcs(mine); const queue = new Map<string, SfcCandidate>();
  for (const c of [...(base.sfc_queue ?? []), ...harvested, ...base.valuation.special_feature_codes.map((code): SfcCandidate => ({ code, rule_ref: SFC_RULE_REFS[code] ?? "24.1/deliveryData", source_event: "24.1 deliveryData()", required: true, evidence_ref: null }))]) if (!queue.has(c.code)) queue.set(c.code, c);
  const gates = { ...(base.gates ?? {}) };
  for (const e of mine) { const p = e.payload as P; if (e.type === "compliance.gate.opened" && typeof p.gate === "string") gates[p.gate] = "open"; if (e.type === "compliance.gate.closed" && typeof p.gate === "string") gates[p.gate] = "closed"; }
  return { ...base, du, ucd, ucdp, project, mi, commitment, compliance, note, warehouse, lock, rep_warrant_relief, disbursement_date, sfc_queue: [...queue.values()].sort((a, b) => a.code.localeCompare(b.code)), gates, prerequisite_checks: checks, package_incomplete_reason };
}

// ============================================================ R2/R3/R5 calculators
/** B2-1.2-01 as 23.1 rounds it: the ratio to two decimals, half-up; the value is the lesser of sales price (purchase) and appraised value. */
export function baseLtvPct(loan_amount_cents: Cents, sales_price_cents: Cents | null, appraised_value_cents: Cents): string {
  const value = sales_price_cents !== null && sales_price_cents < appraised_value_cents ? sales_price_cents : appraised_value_cents;
  if (value <= 0n) throw new RangeError("property value must be positive");
  return Decimal.ratio(loan_amount_cents, value).mul(Decimal.fromInt(100)).toFixed(2);
}
/** The sales price at which a loan amount sits exactly at an LTV ceiling (the worked example's $457,777.78 for $412,000 at 90%), rounded half-up to the cent. */
export function priceAtLtv(loan_amount_cents: Cents, ltv_pct: string): Cents { return centsToDecimal(loan_amount_cents).mul(Decimal.fromInt(100)).div(Decimal.parse(ltv_pct)).toCents("HALF_UP"); }
/** R3(f) / FAQ Q11: SID 429 blank when the loan has MI; `NoMIBasedOnOriginalLTV` when base LTV ≤ 80% and no MI (never `MICanceledBasedOnCurrentLTV` — negotiated transactions only). */
export function deriveMiAbsenceReason(mi: { status: string } | null, base_ltv_pct: string): string | null {
  if (mi && mi.status === "active") return null;
  return Decimal.parse(base_ltv_pct).cmp(Decimal.fromInt(80)) <= 0 ? "NoMIBasedOnOriginalLTV" : null;
}
/** FAQ Q25: SID 412 accepts up to 10 characters; leading zeros are never added (and a zero-padded source value is trimmed). */
export function miCertificateIdentifier(certificate_number: string): string {
  const v = certificate_number.trim().replace(/^0+(?=\d)/, "");
  if (v.length > 10) throw new DeliveryRefused("ULDD_SID_412_LENGTH", "ULDD FAQ Q25", `MICertificateIdentifier ${v} exceeds 10 characters`);
  return v;
}
/** FAQ Q23 / R3(g): PriceLockDatetime = the original lock date unless an extension changed the rate — then the extension date (UCD 3.038 must carry the same date). */
export function priceLockDate(lock: LoanFile["lock"]): PlainDate {
  const rateChanging = [...lock.extensions].filter((e) => e.rate_changed).sort((a, b) => (a.on < b.on ? 1 : -1))[0];
  return rateChanging ? rateChanging.on : lock.locked_on;
}
/** B4-1.4-10: the offer is stale when the note date reaches four months after the offer date (Jul 8 → Nov 8 > Nov 6 opens; Jul 6 → Nov 6 = note date fails — the spec reads "not more than four months" as strictly inside the window). */
export function valueAcceptanceOfferAge(offer_date: PlainDate, note_date: PlainDate): { stale: boolean; four_months_on: PlainDate } {
  const four_months_on = addMonths(offer_date, VALUE_ACCEPTANCE_OFFER_MAX_MONTHS);
  return { stale: note_date >= four_months_on, four_months_on };
}
/** ULDD Phase 5: SID 82 "the only reasonable values are 10 characters long"; "UAD 3.6 appraisals begin with a first digit of 2 or higher". */
export function docFileIdCheck(doc_file_id: string | null, uad_version: string | null): { ok: boolean; reason: string | null } {
  if (!doc_file_id) return { ok: false, reason: "Doc File ID missing" };
  if (doc_file_id.length !== 10) return { ok: false, reason: `Doc File ID ${doc_file_id} is ${doc_file_id.length} characters (10 required)` };
  if (uad_version === "3.6" && !/^[2-9]/.test(doc_file_id)) return { ok: false, reason: `UAD 3.6 Doc File ID ${doc_file_id} must begin with a digit ≥ 2` };
  return { ok: true, reason: null };
}
export const scoreCategoryVersion = (m: ScoreModel): string => SCORE_CATEGORY_VERSIONS[m];

// ============================================================ R3 — identifier consistency (FNMA_ULDD_IDENTIFIER_CONSISTENCY_GATE)
export interface IdentifierMismatch { readonly identifier: string; readonly expected: string | null; readonly found: string | null; readonly owner_process: string; readonly rule: string; }
export interface IdentifierSnapshot { readonly du_casefile_id: string | null; readonly ucd_casefile_id: string | null; readonly ucdp_doc_file_id: string | null; readonly property_data_id: string | null; readonly cpm_project_id: string | null; readonly cpm_certification_id: string | null; readonly cpm_phase_id: string | null; readonly mi_certificate_number: string | null; readonly mi_company_code: string | null; readonly commitment_id_fnma: string | null; readonly payee_code: string | null; readonly warehouse_lender_id: string | null; readonly custodian_fin: string | null; readonly mers_min: string | null; readonly uli: string; readonly lender_loan_id: string; readonly price_lock_date: PlainDate; readonly rep_warrant_relief: readonly { component: string; status: string }[]; readonly enote_indicator: boolean; readonly ron_indicator: boolean; }
export function reconcileIdentifiers(f: LoanFile, today: PlainDate): { snapshot: IdentifierSnapshot; mismatches: IdentifierMismatch[]; complete: boolean } {
  const m: IdentifierMismatch[] = [];
  const miss = (identifier: string, expected: string | null, found: string | null, owner_process: string, rule: string) => m.push({ identifier, expected, found, owner_process, rule });
  const va = f.valuation.method === "value_acceptance" || f.valuation.method === "value_acceptance_pd";
  // (a) SID 322 = the final DU submission's casefile id, Approve/Eligible
  if (!f.du || !f.du.casefile_id) miss("casefile", null, null, "23.1", "R3(a)");
  else if (!f.du.is_final || !/approve.?eligible/i.test(f.du.recommendation)) miss("du_final_submission", "is_final=true, approve_eligible", `${f.du.is_final}/${f.du.recommendation}`, "23.1", "R3(a)");
  // (b) UCD keyed by the same casefile id; accepted, final
  if (!f.ucd) miss("ucd", "accepted", null, "25.2", "R3(b)");
  else {
    if (f.du && f.ucd.casefile_id_ucd !== f.du.casefile_id) miss("casefile", f.du.casefile_id, f.ucd.casefile_id_ucd, "25.2", "R3(b): ucd_submissions.casefile_id_ucd = SID 322 (ULDD FAQ Q4)");
    if (!["accepted", "accepted_with_warnings"].includes(f.ucd.status) || !f.ucd.is_final) miss("ucd_status", "accepted{is_final}", `${f.ucd.status}/${f.ucd.is_final}`, "25.2", "R3(b)");
  }
  // (c) SID 82 = the accepted appraisal's Doc File ID (blank only under value acceptance)
  if (!va) { const c = docFileIdCheck(f.ucdp?.doc_file_id ?? null, f.ucdp?.uad_version ?? null); if (!c.ok) miss("doc_file_id", "10-character UCDP Doc File ID (partner-owned)", f.ucdp?.doc_file_id ?? null, "24.2", `R3(c): ${c.reason}`); else if (f.ucdp && f.ucdp.status !== "successful") miss("ucdp_status", "successful", f.ucdp.status, "24.2", "R3(c)"); }
  // (d) value acceptance + property data needs the Property Data ID before the note date
  if (f.valuation.method === "value_acceptance_pd" && !f.valuation.property_data_id) miss("property_data_id", "present", null, "24.1", "R3(d)");
  // (e) CPM ids iff review_type = cpm, unexpired at the note date
  if (f.project?.review_type === "cpm") { if (!f.project.cpm_project_id) miss("cpm_project_id", "present", null, "24.3", "R3(e)"); if (f.project.expires_at && f.project.expires_at < f.note_date) miss("cpm_certification", `unexpired at ${f.note_date}`, f.project.expires_at, "24.3", "R3(e)"); }
  // (f) MI
  if (f.mi && f.mi.status === "active" && !f.mi.certificate_number) miss("mi_certificate_number", "present", null, "24.6", "R3(f)");
  // (g) SID 311 = UCD 3.038 = the lock date (or the rate-changing extension date)
  const pld = priceLockDate(f.lock);
  if (f.ucd?.current_rate_set_date && f.ucd.current_rate_set_date !== pld) miss("price_lock_date", pld, f.ucd.current_rate_set_date, "25.2", "R3(g): SID 311 = UCD CurrentRateSetDate (FAQ Q23)");
  // (h) MIN
  if (!f.note.min) miss("mers_min", "present", null, f.note.form === "enote" ? "26.2" : "26.4", "R3(h)");
  // (i) payee code + warehouse lender identifier whenever the advance is outstanding
  if (f.warehouse.advance_outstanding) { if (!f.warehouse.payee_code) miss("payee_code", "Form 482 payee code", null, "29.4", "R3(i)"); if (!f.warehouse.warehouse_lender_id) miss("warehouse_lender_id", "present", null, "27.1", "R3(i)"); }
  // (j) custodian FIN — a paper note only (the eNote path is 29.4's eVault transfer)
  if (f.note.form === "paper" && !f.warehouse.custodian_fin) miss("custodian_fin", "present", null, "29.4", "R3(j)");
  // (k) commitment open and consistent
  if (!f.commitment) miss("commitment", "commitment.executed", null, "29.1", "R3(k)");
  else if (f.commitment.expires_on <= today) miss("commitment_expiry", `expires_on > ${today}`, f.commitment.expires_on, "29.1", "R3(k)");
  // (l)/(m) indicators
  const enote_indicator = f.note.form === "enote" && f.note.enote_registered_at !== null;
  if (f.note.form === "enote" && !enote_indicator) miss("enote_registration", "registered on the eRegistry", null, "26.2", "R3(l)");
  // 30.2: the servicing loan number IS the Lender Loan Number
  let lender_loan_id = "";
  try { lender_loan_id = ulddLenderLoanNumber({ servicing_loan_number: f.servicing_loan_number }).LoanIdentifier; } catch (e) { miss("lender_loan_id", "allocated servicing loan number", f.servicing_loan_number, "30.2", `30.2 ulddLenderLoanNumber: ${(e as Error).message}`); }
  if (f.hmda.uli.length > 45) miss("uli", "≤ 45 characters", f.hmda.uli, "28.3", "ULDD FAQ Q17");
  const snapshot: IdentifierSnapshot = { du_casefile_id: f.du?.casefile_id ?? null, ucd_casefile_id: f.ucd?.casefile_id_ucd ?? null, ucdp_doc_file_id: va ? null : (f.ucdp?.doc_file_id ?? null), property_data_id: f.valuation.property_data_id, cpm_project_id: f.project?.cpm_project_id ?? null, cpm_certification_id: f.project?.cpm_certification_id ?? null, cpm_phase_id: f.project?.cpm_phase_id ?? null,
    mi_certificate_number: f.mi?.status === "active" ? miCertificateIdentifier(f.mi.certificate_number) : null, mi_company_code: f.mi?.mi_company_code ?? null, commitment_id_fnma: f.commitment?.commitment_id_fnma ?? null, payee_code: f.warehouse.advance_outstanding ? f.warehouse.payee_code : null, warehouse_lender_id: f.warehouse.advance_outstanding ? f.warehouse.warehouse_lender_id : null, custodian_fin: f.note.form === "paper" ? f.warehouse.custodian_fin : null,
    mers_min: f.note.min, uli: f.hmda.uli, lender_loan_id, price_lock_date: pld, rep_warrant_relief: f.rep_warrant_relief, enote_indicator, ron_indicator: f.notarization_kind === "ron" };
  return { snapshot, mismatches: m, complete: m.length === 0 };
}

// ============================================================ R4 — SFC assembly (FNMA_C1_2_02_SFC_COMPLETENESS_GATE, LL-2026-06, B4-1.4-10)
export interface SfcAssignment { readonly sfc_code: string; readonly rule_ref: string; readonly required: boolean; readonly auto_derived_by_fnma: boolean; readonly evidence_ref: string | null; readonly included_in_uldd: boolean; }
export interface SfcFlags { readonly sfc_tpo_code?: "none" | "211" | "212"; readonly fnma_auto_derived?: readonly string[]; }
/** R4: the finished processes' queue plus the indicator-derived codes (508/861/920/019/281/180 are ⇔ facts on the loan file); nothing is ever dropped to fit the cap — over ten is the `officer`'s call. */
export function assignSfcs(f: LoanFile, flags: SfcFlags = {}): { assignments: SfcAssignment[]; included: string[]; count: number; over_cap: boolean; contradictions: string[] } {
  const set = new Map<string, SfcAssignment>();
  const add = (code: string, rule_ref: string, evidence_ref: string | null, required = true) => { if (!set.has(code)) set.set(code, { sfc_code: code, rule_ref, required, auto_derived_by_fnma: false, evidence_ref, included_in_uldd: true }); };
  add("127", SFC_RULE_REFS["127"]!, f.du?.casefile_id ?? null);
  for (const c of f.sfc_queue) add(c.code, c.rule_ref, c.evidence_ref, c.required);
  if (f.note.form === "enote" && f.note.enote_registered_at) add("508", SFC_RULE_REFS["508"]!, f.note.min);
  if (f.notarization_kind === "ron") add("861", SFC_RULE_REFS["861"]!, null);
  if (f.notarization_kind === "rin") add("920", SFC_RULE_REFS["920"]!, null);
  if (f.mi?.status === "active") { if (/^lpmi_/.test(f.mi.premium_plan)) add("019", SFC_RULE_REFS["019"]!, f.mi.certificate_number); if (f.mi.financed_premium_cents > 0n) add("281", SFC_RULE_REFS["281"]!, f.mi.certificate_number); }
  if (f.subordinations.some((s) => s.community_seconds)) add("118", SFC_RULE_REFS["118"]!, null);
  if (flags.sfc_tpo_code && flags.sfc_tpo_code !== "none") add(flags.sfc_tpo_code, SFC_RULE_REFS[flags.sfc_tpo_code]!, "31.1 TPO analysis");
  // Remove only what the Business Rules Dictionary lists as derived by Loan Delivery (never a code the list does not name).
  const derived = new Set(flags.fnma_auto_derived ?? []);
  const assignments = [...set.values()].map((a) => (derived.has(a.sfc_code) ? { ...a, auto_derived_by_fnma: true, included_in_uldd: false } : a)).sort((a, b) => a.sfc_code.localeCompare(b.sfc_code));
  const contradictions: string[] = [];
  const has = (c: string) => assignments.some((a) => a.sfc_code === c && a.included_in_uldd);
  if (has("007") && has("003")) contradictions.push("007 (LCOR) and 003 (cash-out) are mutually exclusive");
  if (has("009") && has("014")) contradictions.push("009 and 014 (buydown classes) are mutually exclusive");
  if (has("801") && has("774")) contradictions.push("801 and 774 (value acceptance variants) are mutually exclusive");
  if (has("211") && has("212")) contradictions.push("211 and 212 (TPO codes) are mutually exclusive");
  const included = assignments.filter((a) => a.included_in_uldd).map((a) => a.sfc_code);
  return { assignments, included, count: included.length, over_cap: included.length > SFC_CAP, contradictions };
}
/** LL-2026-06: SFC 067 ⇔ `applications.score_model = vantagescore_4`, and one model for every borrower on the loan. */
export function sfc067Gate(f: Pick<LoanFile, "credit">, codes: readonly string[]): { open: boolean; reason: string | null; score_model: ScoreModel | null } {
  const models = [...new Set(f.credit.borrowers.map((b) => b.score_model))];
  if (models.length !== 1) return { open: false, reason: `LL-2026-06: the same credit score model must be used for all borrowers (found ${models.join(", ")})`, score_model: null };
  const model = models[0]!; const has067 = codes.includes("067");
  if (has067 !== (model === "vantagescore_4")) return { open: false, reason: `LL-2026-06: SFC 067 ${has067 ? "present" : "absent"} while score_model = ${model}`, score_model: model };
  return { open: true, reason: null, score_model: model };
}
/** B4-1.4-10 / R3(d): SID 376 = ValueAcceptance ⇔ SFC 801 (or 774) ⇔ method ∈ {value_acceptance, value_acceptance_pd}, and the offer ≤ 4 months old at the note date. */
export function valueAcceptanceGate(f: Pick<LoanFile, "valuation" | "note_date">, codes: readonly string[]): { open: boolean; reason: string | null; sid_376: string | null; offer_age: { stale: boolean; four_months_on: PlainDate } | null } {
  const va = f.valuation.method === "value_acceptance" || f.valuation.method === "value_acceptance_pd";
  const has = codes.includes("801") || codes.includes("774");
  if (!va) return has ? { open: false, reason: "SFC 801/774 present without a value acceptance offer exercised", sid_376: null, offer_age: null } : { open: true, reason: null, sid_376: null, offer_age: null };
  const expected = f.valuation.method === "value_acceptance" ? "801" : "774";
  if (!codes.includes(expected)) return { open: false, reason: `B4-1.4-10: SFC ${expected} must be included at delivery`, sid_376: "ValueAcceptance", offer_age: null };
  if (!f.valuation.offer_date) return { open: false, reason: "value acceptance offer date missing (24.1)", sid_376: "ValueAcceptance", offer_age: null };
  const age = valueAcceptanceOfferAge(f.valuation.offer_date, f.note_date);
  if (age.stale) return { open: false, reason: `B4-1.4-10: the value acceptance offer dated ${f.valuation.offer_date} is more than four months old on the note date ${f.note_date} (four months on ${age.four_months_on}); 24.1 must have ordered an appraisal`, sid_376: "ValueAcceptance", offer_age: age };
  return { open: true, reason: null, sid_376: "ValueAcceptance", offer_age: age };
}

// ============================================================ R2 — Sort-ID assembly and conditionality
export interface UlddDataPoint { readonly sort_id: string | null; readonly data_point_name: string; readonly xpath: string; readonly conditionality: Conditionality; readonly value: string | null; readonly value_type: "string" | "date" | "amount" | "percent" | "boolean" | "enum" | "integer"; readonly source_table: string; readonly source_column: string; readonly source_record_id: string | null; readonly derivation: string | null; readonly override_value: string | null; readonly override_reason: string | null; readonly condition_evaluated: boolean; readonly condition: string | null; readonly pii: boolean; }
export interface ConditionalityDecision { readonly sort_id: string | null; readonly data_point_name: string; readonly condition: string; readonly result: boolean; }
const dollars = (c: Cents): string => centsToDecimal(c).toFixed(2);
const XP = "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL";
/**
 * R2: every Appendix D row in `fnma.uldd.5.2.0` this build populates — `R` must be populated, `CR`/`CI` carry the evaluated condition
 * (populated when true, recorded with `value = null, condition_evaluated = true` when false), `O` (Freddie-only) omitted. Sort IDs are
 * the ones the spec verified; a point whose Sort ID the read pages did not show is keyed by its data point name (`sort_id = null`).
 */
export function assembleUlddDataPoints(f: LoanFile, snap: IdentifierSnapshot, sfcs: readonly string[], build_on: PlainDate): { points: UlddDataPoint[]; conditionality_decisions: ConditionalityDecision[] } {
  const points: UlddDataPoint[] = []; const decisions: ConditionalityDecision[] = [];
  const pt = (sort_id: string | null, name: string, xpath: string, cond: Conditionality, value: string | null, value_type: UlddDataPoint["value_type"], src: [string, string, string | null], extra: Partial<Pick<UlddDataPoint, "derivation" | "condition" | "condition_evaluated" | "pii">> = {}) =>
    points.push({ sort_id, data_point_name: name, xpath: `${XP}/${xpath}`, conditionality: cond, value, value_type, source_table: src[0], source_column: src[1], source_record_id: src[2], derivation: extra.derivation ?? null, override_value: null, override_reason: null, condition_evaluated: extra.condition_evaluated ?? cond === "R", condition: extra.condition ?? null, pii: extra.pii ?? false });
  const cond = (sort_id: string | null, name: string, condition: string, result: boolean): boolean => { decisions.push({ sort_id, data_point_name: name, condition, result }); return result; };
  const va = snap.ucdp_doc_file_id === null && (f.valuation.method === "value_acceptance" || f.valuation.method === "value_acceptance_pd");
  const ltv = baseLtvPct(f.loan_amount_cents, f.sales_price_cents, f.appraised_value_cents);
  const pi = levelPayment(f.loan_amount_cents, ratePercent(f.note_rate_pct), f.term_months);
  const L = "LOANS/LOAN"; const C = "COLLATERALS/COLLATERAL"; const B = "PARTIES/PARTY/ROLES/ROLE/BORROWER";
  // Identifiers
  pt("322", "AutomatedUnderwritingCaseIdentifier", `${L}/AUTOMATED_UNDERWRITINGS/AUTOMATED_UNDERWRITING/AutomatedUnderwritingCaseIdentifier`, "R", snap.du_casefile_id, "string", ["du_casefiles", "casefile_id", snap.du_casefile_id]);
  pt("403.1", "LoanIdentifier[SellerLoan]", `${L}/LOAN_IDENTIFIERS/LOAN_IDENTIFIER[LoanIdentifierType=SellerLoan]/LoanIdentifier`, "R", snap.lender_loan_id, "string", ["loans", "servicing_loan_number", f.loan_id]);
  pt(null, "UniversalLoanIdentifier", `${L}/LOAN_IDENTIFIERS/LOAN_IDENTIFIER[LoanIdentifierType=UniversalLoanIdentifier]/LoanIdentifier`, "R", f.hmda.uli, "string", ["hmda_records", "uli", null]);
  pt(null, "InvestorCommitmentIdentifier", `${L}/INVESTOR_LOAN_INFORMATION/InvestorCommitmentIdentifier`, "R", snap.commitment_id_fnma, "string", ["commitments", "commitment_id_fnma", null]);
  pt(null, "SellerIdentifier", `PARTIES/PARTY[Seller]/ROLES/ROLE/ROLE_DETAIL/PartyRoleIdentifier`, "R", f.seller_number, "string", ["partners", "fnma_seller_number", f.partner_id]);
  // Appraisal / collateral program
  const traditional = cond("82", "AppraisalIdentifier", "valuation_orders.method = traditional appraisal (blank only when SID 376 = ValueAcceptance)", !va);
  pt("82", "AppraisalIdentifier", `${C}/PROPERTIES/PROPERTY/PROPERTY_VALUATIONS/PROPERTY_VALUATION/PROPERTY_VALUATION_DETAIL/AppraisalIdentifier`, "CR", traditional ? snap.ucdp_doc_file_id : null, "string", ["ucdp_submissions", "doc_file_id", null], { condition_evaluated: true, condition: "traditional appraisal" });
  pt("85", "PropertyValuationFormType", `${C}/PROPERTIES/PROPERTY/PROPERTY_VALUATIONS/PROPERTY_VALUATION/PROPERTY_VALUATION_DETAIL/PropertyValuationFormType`, "CR", traditional ? (f.ucdp?.uad_version === "3.6" ? "UniformResidentialAppraisalReport" : "Other") : null, "enum", ["valuation_orders", "form_code", null], { condition_evaluated: true, condition: "traditional appraisal" });
  const vaCond = cond("376", "InvestorCollateralProgramIdentifier", "valuation_orders.method ∈ {value_acceptance, value_acceptance_pd}", va);
  pt("376", "InvestorCollateralProgramIdentifier", `${L}/LOAN_DETAIL/EXTENSION/ULDD:LOAN_DETAIL_EXTENSION/ULDD:InvestorCollateralProgramIdentifier`, "CR", vaCond ? "ValueAcceptance" : null, "enum", ["valuation_orders", "method", null], { condition_evaluated: true, condition: "value acceptance exercised" });
  pt(null, "PropertyValuationAmount", `${C}/PROPERTIES/PROPERTY/PROPERTY_VALUATIONS/PROPERTY_VALUATION/PROPERTY_VALUATION_DETAIL/PropertyValuationAmount`, "R", dollars(f.appraised_value_cents), "amount", ["appraisals", "value_cents", null]);
  // Rate lock
  pt("311", "PriceLockDatetime", `${L}/LOAN_DETAIL/EXTENSION/ULDD:LOAN_DETAIL_EXTENSION/ULDD:PriceLockDatetime`, "R", snap.price_lock_date, "date", ["locks", "rate_set_date", null], { derivation: "locks.locked_at::date unless an extension changed the rate (FAQ Q23; UCD 3.038)" });
  // MI
  const hasMi = cond("412", "MICertificateIdentifier", "mi_certificates.status = active", snap.mi_certificate_number !== null);
  pt("412", "MICertificateIdentifier", `${L}/MI_DATA/MI_DATA_DETAIL/MICertificateIdentifier`, "CR", hasMi ? snap.mi_certificate_number : null, "string", ["mi_certificates", "certificate_number", null], { condition_evaluated: true, condition: "MI active" });
  pt(null, "MICompanyNameType", `${L}/MI_DATA/MI_DATA_DETAIL/MICompanyNameType`, "CR", hasMi ? snap.mi_company_code : null, "enum", ["mi_certificates", "mi_company_code", null], { condition_evaluated: true, condition: "MI active" });
  pt(null, "MICoveragePercent", `${L}/MI_DATA/MI_DATA_DETAIL/MICoveragePercent`, "CR", hasMi && f.mi ? Decimal.parse(f.mi.coverage_pct).toFixed(2) : null, "percent", ["mi_certificates", "coverage_pct", null], { condition_evaluated: true, condition: "MI active" });
  const absence = deriveMiAbsenceReason(f.mi, ltv);
  cond("429", "PrimaryMIAbsenceReasonType", "no MI and base LTV ≤ 80% (FAQ Q11)", absence !== null);
  pt("429", "PrimaryMIAbsenceReasonType", `${L}/MI_DATA/MI_DATA_DETAIL/EXTENSION/ULDD:MI_DATA_DETAIL_EXTENSION/ULDD:PrimaryMIAbsenceReasonType`, "CI", absence, "enum", ["mi_certificates", "(absence)", null], { condition_evaluated: true, condition: "no MI and LTV ≤ 80%", derivation: `base LTV ${ltv}% ≤ 80.00 and no mi_certificates row → NoMIBasedOnOriginalLTV` });
  const lpmi = cond("430.1", "MIInterestRateAdjustmentPercent", "premium_plan ∈ {lpmi_monthly, lpmi_single}", hasMi && /^lpmi_/.test(f.mi?.premium_plan ?? ""));
  pt("430.1", "MIInterestRateAdjustmentPercent", `${L}/MI_DATA/MI_DATA_DETAIL/EXTENSION/ULDD:MI_DATA_DETAIL_EXTENSION/ULDD:MIInterestRateAdjustmentPercent`, "CR", lpmi ? "0.0000" : null, "percent", ["mi_certificates", "lpmi_rate_adjustment", null], { condition_evaluated: true, condition: "LPMI" });
  // MERS / eNote / RON
  pt("401", "MERS_MINIdentifier", `${L}/LOAN_IDENTIFIERS/LOAN_IDENTIFIER[LoanIdentifierType=MERS_MIN]/LoanIdentifier`, "CR", snap.mers_min, "string", [f.note.form === "enote" ? "enotes" : "mers_transactions", "min", null], { condition_evaluated: true, condition: "MOM / eNote registered" });
  pt(null, "ENoteIndicator", `${L}/LOAN_DETAIL/EXTENSION/ULDD:LOAN_DETAIL_EXTENSION/ULDD:ENoteIndicator`, "R", snap.enote_indicator ? "true" : "false", "boolean", ["enotes", "registered_at", null], { derivation: "closings.closing_type ∈ {ron, ipen} ∧ enotes.registered_at is not null" });
  pt(null, "RemoteOnlineNotarizationIndicator", `${L}/LOAN_DETAIL/EXTENSION/ULDD:LOAN_DETAIL_EXTENSION/ULDD:RemoteOnlineNotarizationIndicator`, "R", snap.ron_indicator ? "true" : "false", "boolean", ["signing_sessions", "notarization_kind", null]);
  // Payee / warehouse / custodian
  const bailee = cond("642", "PayeeIdentifier", "whole loan under a bailee letter at delivery (warehouse_advances.repaid_at is null)", f.warehouse.advance_outstanding);
  pt("642", "PayeeIdentifier", `${L}/INVESTOR_LOAN_INFORMATION/EXTENSION/ULDD:INVESTOR_LOAN_INFORMATION_EXTENSION/ULDD:PayeeIdentifier`, "CR", bailee ? snap.payee_code : null, "string", ["wire_instructions", "payee_code", null], { condition_evaluated: true, condition: "bailee letter" });
  pt("650.1", "WarehouseLenderIdentifier", `PARTIES/PARTY[WarehouseLender]/ROLES/ROLE/ROLE_DETAIL/PartyRoleIdentifier`, "CR", bailee ? snap.warehouse_lender_id : null, "string", ["warehouse_facilities", "fnma_warehouse_lender_id", null], { condition_evaluated: true, condition: "pledged to a warehouse line (FAQ Q5)" });
  pt(null, "WarehouseLenderIndicator", `${L}/LOAN_DETAIL/EXTENSION/ULDD:LOAN_DETAIL_EXTENSION/ULDD:WarehouseLenderIndicator`, "R", bailee ? "true" : "false", "boolean", ["warehouse_advances", "repaid_at", null]);
  pt("398.3", "WireInstructionReferenceIdentifier", `${L}/LOAN_DETAIL/EXTENSION/ULDD:OTHER/ULDD:LOAN_DETAIL_EXTENSION/ULDD:WireInstructionReferenceIdentifier`, "CR", null, "string", ["(none)", "(MBS pools only — blank for whole loans; open question 2)", null], { condition_evaluated: true, condition: "standard MBS pool (never a whole loan)" });
  const paper = cond("620", "DocumentCustodianIdentifier", "paper note (the eNote path has no custodian FIN dependency — 29.4 eVault)", f.note.form === "paper");
  pt("620", "DocumentCustodianIdentifier", `PARTIES/PARTY[DocumentCustodian]/ROLES/ROLE/ROLE_DETAIL/PartyRoleIdentifier`, "CR", paper ? snap.custodian_fin : null, "string", ["seller_profile", "custodian_fin", null], { condition_evaluated: true, condition: "paper note" });
  pt("652", "DocumentCustodianIdentifier[652]", `PARTIES/PARTY[DocumentCustodian]/ROLES/ROLE/ROLE_DETAIL/PartyRoleIdentifier`, "CR", paper ? snap.custodian_fin : null, "string", ["seller_profile", "custodian_fin", null], { condition_evaluated: true, condition: "paper note" });
  // Escrow
  const escrowed = cond("363", "EscrowBalanceAmount", "escrow_accounts initial deposit exists (escrowed loan)", f.escrowed && f.initial_escrow_deposit_cents !== null);
  pt("363", "EscrowBalanceAmount", `${L}/ESCROW/ESCROW_DETAIL/EscrowBalanceAmount`, "CR", escrowed ? dollars(f.initial_escrow_deposit_cents!) : null, "amount", ["escrow_accounts", "initial_deposit_cents", null], { condition_evaluated: true, condition: "escrowed", derivation: "cents → dollars, two decimals" });
  // Credit
  const model = f.credit.borrowers[0]?.score_model ?? "classic_fico";
  pt("251", "LoanLevelCreditScoreValue", `${L}/LOAN_DETAIL/EXTENSION/ULDD:LOAN_DETAIL_EXTENSION/ULDD:LoanLevelCreditScoreValue`, "R", String(f.credit.representative_score), "integer", ["credit_reports", "representative_score", null], { derivation: "22.2 rule: lower of the borrowers' middle scores" });
  pt("249", "LoanLevelCreditScoreSelectionMethodType", `${L}/LOAN_DETAIL/EXTENSION/ULDD:LOAN_DETAIL_EXTENSION/ULDD:LoanLevelCreditScoreSelectionMethodType`, "R", "MiddleOrLowerThenLowest", "enum", ["credit_reports", "selection_method", null]);
  pt("251.1", "CreditScoreCategoryVersionType", `${L}/LOAN_DETAIL/EXTENSION/ULDD:LOAN_DETAIL_EXTENSION/ULDD:CreditScoreCategoryVersionType`, "R", scoreCategoryVersion(model), "enum", ["applications", "score_model", f.application_id]);
  // HMDA / HomeReady
  pt("208", "HMDARateSpreadPercent", `${L}/GOVERNMENT_MONITORING/GOVERNMENT_MONITORING_DETAIL/HMDARateSpreadPercent`, "CR", f.hmda.rate_spread_pct, "percent", ["hmda_records", "rate_spread", null], { condition_evaluated: true, condition: "HMDA reportable" });
  pt("238", "LoanAffordableIndicator", `${L}/LOAN_DETAIL/LoanAffordableIndicator`, "R", sfcs.includes("900") ? "true" : "false", "boolean", ["applications", "homeready", f.application_id]);
  // CPM
  const cpm = cond("39", "FNMCondominiumProjectManagerProjectIdentifier", "project_reviews.review_type = cpm (FAQ Q24)", f.project?.review_type === "cpm");
  pt("39", "FNMCondominiumProjectManagerProjectIdentifier", `${C}/PROPERTIES/PROPERTY/PROJECT/PROJECT_DETAIL/EXTENSION/ULDD:PROJECT_DETAIL_EXTENSION/ULDD:FNMCondominiumProjectManagerProjectIdentifier`, "CR", cpm ? snap.cpm_project_id : null, "string", ["project_reviews", "cpm_project_id", null], { condition_evaluated: true, condition: "CPM review" });
  pt("49.1", "CPMCertificationIdentifier", `${C}/PROPERTIES/PROPERTY/PROJECT/PROJECT_DETAIL/EXTENSION/ULDD:PROJECT_DETAIL_EXTENSION/ULDD:CPMCertificationIdentifier`, "CR", cpm ? snap.cpm_certification_id : null, "string", ["project_reviews", "cpm_certification_id", null], { condition_evaluated: true, condition: "CPM review" });
  pt("49.2", "CPMPhaseIdentifier", `${C}/PROPERTIES/PROPERTY/PROJECT/PROJECT_DETAIL/EXTENSION/ULDD:PROJECT_DETAIL_EXTENSION/ULDD:CPMPhaseIdentifier`, "CR", cpm ? snap.cpm_phase_id : null, "string", ["project_reviews", "cpm_phase_id", null], { condition_evaluated: true, condition: "CPM review" });
  // Subordinate financing (≤ 3 related loans, FAQ Q39)
  f.subordinations.slice(0, 3).forEach((s, i) => pt("513.1", `RELATED_LOAN[${i + 1}]/LoanAffordableIndicator`, `LOANS/LOAN[RelatedLoan ${i + 1}]/LOAN_DETAIL/LoanAffordableIndicator`, "CR", s.community_seconds ? "true" : "false", "boolean", ["subordinations", "community_seconds", null], { condition_evaluated: true, condition: "subordinate lien" }));
  // Terms / dates / amounts ("At Closing" = the CD-final figures; "At Current" = the build date)
  pt(null, "NoteAmount", `${L}/TERMS_OF_LOAN/NoteAmount`, "R", dollars(f.loan_amount_cents), "amount", ["loan_terms", "amount_cents", f.loan_id]);
  pt(null, "NoteRatePercent", `${L}/TERMS_OF_LOAN/NoteRatePercent`, "R", Decimal.parse(f.note_rate_pct).toFixed(5), "percent", ["loan_terms", "note_rate_pct", f.loan_id]);
  pt(null, "ScheduledPrincipalAndInterestPayment", `${L}/PAYMENT/PAYMENT_DETAIL/InitialPrincipalAndInterestPaymentAmount`, "R", dollars(pi), "amount", ["loan_terms", "pi_cents", f.loan_id], { derivation: "level payment on the note amount, rate and term (kernel levelPayment)" });
  pt(null, "NoteDate", `${L}/TERMS_OF_LOAN/NoteDate`, "R", f.note_date, "date", ["closings", "note_date", null]);
  pt(null, "DisbursementDate", `${L}/LOAN_DETAIL/EXTENSION/ULDD:LOAN_DETAIL_EXTENSION/ULDD:DisbursementDate`, "R", f.disbursement_date, "date", ["fundings", "disbursement_date", null]);
  pt(null, "ScheduledFirstPaymentDate", `${L}/TERMS_OF_LOAN/EXTENSION/ULDD:TERMS_OF_LOAN_EXTENSION/ULDD:ScheduledFirstPaymentDate`, "R", f.first_payment_date, "date", ["loan_terms", "first_payment_date", f.loan_id]);
  pt(null, "LoanMaturityDate", `${L}/MATURITY/MATURITY_RULE/LoanMaturityDate`, "R", f.maturity_date, "date", ["loan_terms", "maturity_date", f.loan_id]);
  pt(null, "LoanPurposeType", `${L}/TERMS_OF_LOAN/LoanPurposeType`, "R", f.purpose === "purchase" ? "Purchase" : "Refinance", "enum", ["applications", "purpose", f.application_id]);
  pt(null, "RefinanceCashOutDeterminationType", `${L}/REFINANCE/RefinanceCashOutDeterminationType`, "CR", f.purpose === "purchase" ? null : f.purpose === "limited_cash_out" ? "LimitedCashOut" : "CashOut", "enum", ["applications", "purpose", f.application_id], { condition_evaluated: true, condition: "refinance" });
  pt(null, "LTVRatioPercent", `${L}/LOAN_DETAIL/EXTENSION/ULDD:LOAN_DETAIL_EXTENSION/ULDD:LTVRatioPercent`, "R", ltv, "percent", ["(computed)", "ltv", null], { derivation: "23.1 rounding: loan amount / lesser of price and value, two decimals" });
  pt(null, "CombinedLTVRatioPercent", `${L}/LOAN_DETAIL/EXTENSION/ULDD:LOAN_DETAIL_EXTENSION/ULDD:CombinedLTVRatioPercent`, "R", baseLtvPct(f.loan_amount_cents + f.subordinations.reduce((s, x) => s + x.amount_cents, 0n), f.sales_price_cents, f.appraised_value_cents), "percent", ["(computed)", "cltv", null]);
  pt(null, "PropertyUsageType", `${C}/PROPERTIES/PROPERTY/PROPERTY_DETAIL/PropertyUsageType`, "R", f.property.usage, "enum", ["application_properties", "occupancy", f.property.property_id]);
  pt(null, "FinancedUnitCount", `${C}/PROPERTIES/PROPERTY/PROPERTY_DETAIL/FinancedUnitCount`, "R", String(f.property.units), "integer", ["application_properties", "units", f.property.property_id]);
  pt(null, "AddressLineText", `${C}/PROPERTIES/PROPERTY/ADDRESS/AddressLineText`, "R", f.property.street, "string", ["properties", "street", f.property.property_id], { pii: true });
  pt(null, "CityName", `${C}/PROPERTIES/PROPERTY/ADDRESS/CityName`, "R", f.property.city, "string", ["properties", "city", f.property.property_id], { pii: true });
  pt(null, "StateCode", `${C}/PROPERTIES/PROPERTY/ADDRESS/StateCode`, "R", f.property.state, "string", ["properties", "state", f.property.property_id], { pii: true });
  pt(null, "PostalCode", `${C}/PROPERTIES/PROPERTY/ADDRESS/PostalCode`, "R", f.property.zip, "string", ["properties", "zip", f.property.property_id], { pii: true });
  pt(null, "LoanStateDate[AtCurrent]", `${L}/LOAN_STATE/LoanStateDate`, "R", build_on, "date", ["(build)", "build_on", null], { derivation: "ULDD FAQ Q37: the At Current snapshot date is the build date" });
  pt(null, "BorrowerCount", `${B}/BORROWER_DETAIL/BorrowerCount`, "R", String(f.credit.borrowers.length), "integer", ["application_borrowers", "count", f.application_id], { pii: true });
  return { points, conditionality_decisions: decisions };
}
/** SFCs as ULDD InvestorFeatureIdentifier containers. */
export const sfcDataPoints = (sfcs: readonly string[]): UlddDataPoint[] => sfcs.map((code, i) => ({ sort_id: "368", data_point_name: `InvestorFeatureIdentifier[${i + 1}]`, xpath: `${XP}/LOANS/LOAN/INVESTOR_FEATURES/INVESTOR_FEATURE[${i + 1}]/InvestorFeatureIdentifier`, conditionality: "CR" as const, value: code, value_type: "string" as const, source_table: "sfc_assignments", source_column: "sfc_code", source_record_id: null, derivation: null, override_value: null, override_reason: null, condition_evaluated: true, condition: SFC_RULE_REFS[code] ?? null, pii: false }));

/** R2 schema/enumeration/format checks (Appendix E enumerations; FAQ Q25/Q36 reasonable-value rules); unknown enumerations fail the build rather than being coerced. */
export function validateSchema(points: readonly UlddDataPoint[], sfcs: readonly string[]): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const byName = new Map(points.map((p) => [p.data_point_name, p] as const)); const sid = (s: string) => points.find((p) => p.sort_id === s) ?? null;
  for (const p of points) if (p.conditionality === "R" && (p.value === null || p.value === "")) errors.push(`R data point ${p.data_point_name}${p.sort_id ? ` (SID ${p.sort_id})` : ""} is not populated`);
  const v429 = sid("429")?.value; if (v429 && !(MI_ABSENCE_REASONS as readonly string[]).includes(v429)) errors.push(`SID 429 enumeration ${v429} is not in Appendix E`);
  const v376 = sid("376")?.value; if (v376 && !(COLLATERAL_PROGRAMS as readonly string[]).includes(v376)) errors.push(`SID 376 enumeration ${v376} is not in Appendix E`);
  const v82 = sid("82")?.value; if (v82 && v82.length !== 10) errors.push(`SID 82 ${v82} must be 10 characters`);
  const v412 = sid("412")?.value; if (v412 && (v412.length > 10 || /^0/.test(v412))) errors.push(`SID 412 ${v412}: ≤ 10 characters, no leading zeros`);
  const uli = byName.get("UniversalLoanIdentifier")?.value; if (uli && uli.length > 45) errors.push("ULI exceeds 45 characters");
  const addr = byName.get("AddressLineText")?.value; if (addr && addr.length > 100) errors.push("AddressLineText exceeds 100 characters (FAQ Q36)");
  for (const c of sfcs) if (!/^\d{3}$/.test(c)) errors.push(`SFC ${c} is not a three-digit code`);
  if (sfcs.length > SFC_CAP) errors.push(`${sfcs.length} SFCs exceed the cap of ${SFC_CAP}`);
  return { valid: errors.length === 0, errors };
}
/** Canonical ULDD XML projection (MISMO V3.0 Build 263-12 with the ULDD extension namespace); deterministic bytes so the SHA-256 is reproducible per build. */
export function buildUlddXml(points: readonly UlddDataPoint[], sfcs: readonly string[], meta: { seller_number: string; build_no: number; build_on: PlainDate }): { xml: string; sha256: string; byte_length: number } {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const rows = [...points, ...sfcDataPoints(sfcs)].filter((p) => p.value !== null && p.value !== "").map((p) => `    <ULDD:DataPoint${p.sort_id ? ` SortID="${esc(p.sort_id)}"` : ""} Name="${esc(p.data_point_name)}" XPath="${esc(p.xpath)}" Conditionality="${p.conditionality}">${esc(p.value!)}</ULDD:DataPoint>`);
  const xml = [`<?xml version="1.0" encoding="UTF-8"?>`, `<MESSAGE xmlns="http://www.mismo.org/residential/2009/schemas" xmlns:ULDD="http://www.datamodelextension.org/Schema/ULDD" MISMOReferenceModelIdentifier="3.0.0.263.12" ULDD:ULDDVersionIdentifier="${ULDD_PHASE}">`,
    `  <ABOUT_VERSIONS><ABOUT_VERSION><CreatedDatetime>${meta.build_on}</CreatedDatetime><DataVersionIdentifier>${meta.build_no}</DataVersionIdentifier><SellerIdentifier>${esc(meta.seller_number)}</SellerIdentifier></ABOUT_VERSION></ABOUT_VERSIONS>`,
    `  <DEAL_SETS><DEAL_SET><DEALS><DEAL>`, ...rows, `  </DEAL></DEALS></DEAL_SET></DEAL_SETS>`, `</MESSAGE>`, ""].join("\n");
  return { xml, sha256: sha256Hex(xml), byte_length: Buffer.byteLength(xml, "utf8") };
}

// ============================================================ EarlyCheck (port + fake) and edit handling
export interface EarlyCheckEdit { readonly edit_code: string; readonly severity: EditSeverity; readonly message: string; readonly sort_ids: readonly string[]; readonly prefix?: "A" | "C" | "D" | "numeric" | "general"; readonly kind?: "du_compare" | "standardized_address" | "enumeration_default" | "format_trim" | "other"; readonly details?: Record<string, unknown>; }
export interface EarlyCheckResult { readonly edits: readonly EarlyCheckEdit[]; readonly standardized_address?: { readonly street: string; readonly city: string; readonly state: string; readonly zip: string } | null; readonly computed_fields?: Record<string, string>; readonly du_compare_results?: readonly Record<string, unknown>[]; readonly result_document_id: string; }
export interface EarlyCheckRequest { readonly delivery_id: string; readonly file_kind: FileKind; readonly file_sha256: string; readonly xml: string; readonly seller_number: string; readonly correlation_id: string; }
/** Direct Integration XML over the legacy DI platform (unverified Fannie Mae material per the spec). `null` = no result yet (outage); the UI fallback follows after 60 minutes. */
export interface EarlyCheckPort { run(req: EarlyCheckRequest): EarlyCheckResult | null; }
export class FakeEarlyCheck implements EarlyCheckPort {
  readonly requests: EarlyCheckRequest[] = [];
  private readonly scripted = new Map<string, EarlyCheckResult>();
  outage = false;
  script(file_sha256: string, result: EarlyCheckResult): void { this.scripted.set(file_sha256, result); }
  run(req: EarlyCheckRequest): EarlyCheckResult | null { this.requests.push(req); if (this.outage) return null; return this.scripted.get(req.file_sha256) ?? { edits: [], result_document_id: `DOC-EC-${req.file_kind}-${req.file_sha256.slice(0, 8)}` }; }
}
export const editPrefix = (code: string): "A" | "C" | "D" | "numeric" | "general" => (/^A/i.test(code) ? "A" : /^C/i.test(code) ? "C" : /^D/i.test(code) ? "D" : /^\d/.test(code) ? "numeric" : "general");
/** A run is clean when it has zero fatal and zero warning-to-fatal edits (Loan Delivery mirrors both as blocking). */
export const isClean = (edits: readonly EarlyCheckEdit[]): boolean => !edits.some((e) => e.severity === "fatal" || e.severity === "warning_to_fatal");
export const editCountBySeverity = (edits: readonly EarlyCheckEdit[]): Record<EditSeverity, number> => { const c: Record<EditSeverity, number> = { fatal: 0, warning_to_fatal: 0, warning: 0, informational: 0, observational: 0 }; for (const e of edits) c[e.severity]++; return c; };
export interface EditRouting { readonly owner_process: string; readonly derivable: boolean; readonly expected_resolution: EditResolution; readonly reason: string; }
/** Edit prefix → owner (Loan Delivery FAQ Q9: A = appraisal/UCDP 24.2, C = closing/UCD 25.2, D = DU 23.1; 3000-series = commitment 29.1); derivable kinds stay with 29.3; DU Compare differences are never fixed here. */
export function mapEditToOwner(edit: EarlyCheckEdit): EditRouting {
  const prefix = edit.prefix ?? editPrefix(edit.edit_code);
  if (edit.kind === "du_compare" || prefix === "D") return { owner_process: "23.1", derivable: false, expected_resolution: "source_corrected_upstream", reason: "DU Compare: the DU casefile is corrected/resubmitted by 23.1 (never bypassed)" };
  if (edit.kind && (DERIVABLE_EDIT_KINDS as readonly string[]).includes(edit.kind) && !edit.sort_ids.some((s) => (NON_DERIVABLE_SORT_IDS as readonly string[]).includes(s))) return { owner_process: "29.3", derivable: true, expected_resolution: "data_corrected", reason: `${edit.kind}: derived by rule (enumeration default / formatting / EarlyCheck standardized output)` };
  if (prefix === "A") return { owner_process: "24.2", derivable: false, expected_resolution: "source_corrected_upstream", reason: "appraisal/UCDP data (A edits)" };
  if (prefix === "C") return { owner_process: "25.2", derivable: false, expected_resolution: "source_corrected_upstream", reason: "closing/UCD data (C edits)" };
  if (prefix === "numeric" && /^3\d{3}$/.test(edit.edit_code)) return { owner_process: "29.1", derivable: false, expected_resolution: "source_corrected_upstream", reason: "3000-series commitment/contract edit (first seen in Loan Delivery — 29.4 observes)" };
  const sidOwner: Record<string, string> = { "412": "24.6", "430.1": "24.6", "82": "24.2", "85": "24.2", "322": "23.1", "311": "25.2", "39": "24.3", "49.1": "24.3", "49.2": "24.3", "401": "26.4", "642": "29.4", "650.1": "27.1", "363": "30.3", "251": "22.2", "208": "28.3" };
  const owner = edit.sort_ids.map((s) => sidOwner[s]).find((o) => o !== undefined) ?? "29.3";
  return { owner_process: owner, derivable: false, expected_resolution: owner === "29.3" ? "unresolved" : "source_corrected_upstream", reason: owner === "29.3" ? "no rule derives this value — human review" : `owner of SID ${edit.sort_ids.join("/")}` };
}
/** The agent's derived-fix guardrail: enumeration defaults and formatting only; never an amount, date, score, value or identifier. */
export function derivedFixAllowed(edit: EarlyCheckEdit): { allowed: boolean; reason: string | null } {
  if (edit.sort_ids.some((s) => (NON_DERIVABLE_SORT_IDS as readonly string[]).includes(s))) return { allowed: false, reason: `SID ${edit.sort_ids.join("/")} is an amount/date/score/value/identifier — corrected only by its owner` };
  if (!edit.kind || !(DERIVABLE_EDIT_KINDS as readonly string[]).includes(edit.kind)) return { allowed: false, reason: `edit kind ${edit.kind ?? "other"} is not derivable` };
  return { allowed: true, reason: null };
}
export interface DeliveryEdit { readonly edit_id: string; readonly delivery_id: string; readonly run_id: string | null; readonly source: "earlycheck" | "ldte" | "loan_delivery"; readonly edit_code: string; readonly prefix: "A" | "C" | "D" | "numeric" | "general"; readonly severity: EditSeverity; readonly message: string; readonly sort_ids: readonly string[]; readonly observed_at: string; readonly owner_process: string; resolution: EditResolution; resolution_ref: string | null; resolved_at: string | null; resolved_by: string | null; readonly kind: EarlyCheckEdit["kind"] | null; readonly details: Record<string, unknown>; }
export interface EarlyCheckRun { readonly run_id: string; readonly delivery_id: string; readonly file_kind: FileKind; readonly file_document_id: string; file_sha256: string; channel: "di" | "ui"; readonly submitted_at: string; completed_at: string | null; result_document_id: string | null; edit_count_by_severity: Record<EditSeverity, number> | null; clean: boolean | null; du_compare_results: readonly Record<string, unknown>[] | null; standardized_address: EarlyCheckResult["standardized_address"] | null; computed_fields: Record<string, string> | null; submitted_by: string; readonly correlation_id: string; readonly build_no: number; }
export const earlyCheckIdempotencyKey = (delivery_id: string, file_sha256: string, file_kind: FileKind): string => `${delivery_id}|${file_kind}|${file_sha256}`;
/** R5: EarlyCheck's computed key fields vs the platform's — beyond 0.01 pp (ratios) / $1 (amounts) is a warning to resolve, not bypass. */
export function computedFieldVariances(platform: Record<string, string>, earlycheck: Record<string, string>): { field: string; platform: string; earlycheck: string; beyond_tolerance: boolean }[] {
  return Object.entries(earlycheck).filter(([k]) => platform[k] !== undefined).map(([k, v]) => { const isRatio = /ltv|dti|percent/i.test(k); const d = Decimal.parse(v).sub(Decimal.parse(platform[k]!)); const abs = d.cmp(Decimal.ZERO) < 0 ? Decimal.ZERO.sub(d) : d; return { field: k, platform: platform[k]!, earlycheck: v, beyond_tolerance: abs.cmp(Decimal.parse(isRatio ? "0.01" : "1.00")) > 0 }; });
}

// ============================================================ gates (facts for the evaluators)
export function earlycheckCleanGate(f: { run_clean?: unknown; run_file_sha256?: unknown; uldd_sha256?: unknown; run_file_kind?: unknown }): { open: boolean; reason?: string } {
  if (f.run_file_kind !== undefined && f.run_file_kind !== "uldd_3_0") return { open: false, reason: `run is ${String(f.run_file_kind)}, not the ULDD file` };
  if (f.run_clean !== true) return { open: false, reason: "no clean EarlyCheck run (zero fatal, zero warning-to-fatal)" };
  if (!f.run_file_sha256 || f.run_file_sha256 !== f.uldd_sha256) return { open: false, reason: `the clean run certified ${String(f.run_file_sha256 ?? "no file")}, not the current build ${String(f.uldd_sha256 ?? "")} (same file, same hash)` };
  return { open: true };
}
export function duFileEarlycheckGate(f: { du_file_run_clean?: unknown; du_file_run_sha256?: unknown; du_spec_file_sha256?: unknown }): { open: boolean; reason?: string } {
  if (f.du_file_run_clean !== true) return { open: false, reason: "the final DU Spec file (du_spec_3_4) has no clean EarlyCheck run" };
  if (f.du_spec_file_sha256 !== undefined && f.du_file_run_sha256 !== f.du_spec_file_sha256) return { open: false, reason: "the DU-file run is for a different file hash — re-run (open question 5)" };
  return { open: true };
}
export function identifierConsistencyGate(f: { mismatches?: unknown; identifier_snapshot_complete?: unknown }): { open: boolean; reason?: string } {
  const m = Array.isArray(f.mismatches) ? (f.mismatches as IdentifierMismatch[]) : [];
  if (m.length) return { open: false, reason: `identifier mismatch: ${m.map((x) => `${x.identifier} (expected ${x.expected ?? "—"}, found ${x.found ?? "—"}; ${x.owner_process})`).join("; ")}` };
  if (f.identifier_snapshot_complete === false) return { open: false, reason: "identifier snapshot incomplete" };
  return { open: true };
}
export function sfcCompletenessGate(f: { sfc_count?: unknown; contradictions?: unknown; required_missing?: unknown }): { open: boolean; reason?: string } {
  const n = Number(f.sfc_count ?? 0); const c = Array.isArray(f.contradictions) ? (f.contradictions as string[]) : []; const missing = Array.isArray(f.required_missing) ? (f.required_missing as string[]) : [];
  if (missing.length) return { open: false, reason: `required SFC missing: ${missing.join(", ")}` };
  if (c.length) return { open: false, reason: `contradictory SFCs: ${c.join("; ")}` };
  if (n > SFC_CAP) return { open: false, reason: `${n} SFCs exceed the cap of ${SFC_CAP} — officer escalation, no code dropped` };
  return { open: true };
}
export function packageFreezeGate(f: { uldd_sha256?: unknown; clean_run_sha256?: unknown; gate_results?: unknown }): { open: boolean; reason?: string } {
  if (!f.uldd_sha256 || f.uldd_sha256 !== f.clean_run_sha256) return { open: false, reason: "delivery_packages.uldd_sha256 must equal the hash of the exact file the clean run certified" };
  const g = (f.gate_results ?? {}) as Record<string, string>; const closed = Object.entries(g).filter(([, v]) => v === "closed").map(([k]) => k);
  if (closed.length) return { open: false, reason: `composed gate closed at freeze: ${closed.join(", ")}` };
  return { open: true };
}

// ============================================================ the service
export interface DeliveryRow { readonly delivery_id: string; readonly loan_id: string; readonly application_id: string; readonly partner_id: string; commitment_id_fnma: string | null; execution_type: "whole_loan_best_efforts" | "whole_loan_mandatory"; remittance_type: string; pass_through_rate: string; servicing_fee_rate: string; readonly uldd_phase: string; uldd_document_id: string | null; uldd_sha256: string | null; uldd_built_at: string | null; uldd_build_no: number; loan_state_at_current_date: PlainDate | null; closed_loan_snapshot_hash: string | null; identifier_snapshot: IdentifierSnapshot | null; sfc_codes: string[]; earlycheck_runs: { last_du_file_run_id: string | null; last_uldd_run_id: string | null; fatal_count: number; warning_count: number; clean: boolean }; package_id: string | null; enote_indicator: boolean; ron_indicator: boolean; rebuild_reason: string | null; build_status: BuildStatus; loan_delivery_status: LoanDeliveryStatus; ucd_casefile_id: string | null; awaiting_cd_version: number | null; file: LoanFile; }
export interface DeliveryPackage { readonly package_id: string; readonly delivery_id: string; readonly version: number; readonly uldd_document_id: string; readonly uldd_sha256: string; readonly earlycheck_run_id: string; readonly identifier_snapshot: IdentifierSnapshot; readonly sfc_codes: readonly string[]; readonly gate_results: Readonly<Record<string, { result: "open" | "closed" | "n/a"; evidence_ref: string | null }>>; readonly frozen_at: string; readonly frozen_by_agent_run_id: string; status: "frozen" | "handed_to_operator" | "imported" | "superseded"; superseded_by: string | null; supersede_reason: string | null; }
export interface AgentDecision29_3 { readonly delivery_id: string; readonly build_no: number; readonly prerequisite_checks: LoanFile["prerequisite_checks"]; readonly conditionality_decisions: readonly ConditionalityDecision[]; readonly sfc_set: readonly { code: string; rule_ref: string }[]; readonly identifier_snapshot: IdentifierSnapshot | null; readonly earlycheck: { run_id: string | null; severities: Record<EditSeverity, number> | null; resolutions: readonly { edit_id: string; resolution: EditResolution }[] }; readonly gate_results: DeliveryPackage["gate_results"] | null; readonly uldd_sha256: string | null; readonly rule_set_versions: typeof RULE_SET_VERSIONS_29_3; readonly model_version: string; readonly prompt_version: string; readonly rationale: string; readonly confidence: number; readonly recorded_at: string; }
export interface BuildResult { readonly build_no: number; readonly points: UlddDataPoint[]; readonly conditionality_decisions: ConditionalityDecision[]; readonly sfcs: string[]; readonly xml: string; readonly sha256: string; readonly document_id: string; readonly built_at: string; readonly schema: { valid: boolean; errors: string[] }; }
export interface AssembleOutcome { readonly status: "built" | "refused"; readonly gate: string | null; readonly reason: string | null; readonly mismatches: IdentifierMismatch[]; readonly build: BuildResult | null; readonly escalation_id: string | null; }
export interface PropertyAuditRow { readonly property_id: string; readonly before: Record<string, string>; readonly after: Record<string, string>; readonly source: "earlycheck_standardization"; readonly run_id: string; readonly at: string; }
interface Deps { readonly events: EventStore; readonly clock: { now(): string }; readonly escalations?: EscalationService; readonly earlycheck?: EarlyCheckPort; readonly flags?: SfcFlags; readonly agent_run_id?: string; }

export class DeliveryBuildService {
  private readonly d: Deps;
  readonly deliveries = new Map<string, DeliveryRow>();
  readonly points: (UlddDataPoint & { delivery_id: string; build_no: number })[] = [];
  readonly assignments: (SfcAssignment & { delivery_id: string; assigned_at: string })[] = [];
  readonly runs: EarlyCheckRun[] = [];
  readonly edits: DeliveryEdit[] = [];
  readonly packages: DeliveryPackage[] = [];
  readonly decisions: AgentDecision29_3[] = [];
  readonly documents = new Map<string, { document_id: string; kind: string; bytes: string; sha256: string; retention_class: "fnma_loan_file_life_plus_4y"; confidentiality: "fnma_confidential" }>();
  readonly propertyAudit: PropertyAuditRow[] = [];
  constructor(d: Deps) { this.d = d; }
  private now(): string { return this.d.clock.now(); }
  private todayEt(): PlainDate { return etDate(this.now()); }
  private emit(r: DeliveryRow, type: string, payload: Record<string, unknown>, actor: Actor = SECONDARY_AGENT): DomainEvent {
    return this.d.events.append({ type, applicationId: r.application_id, loanId: r.loan_id, actor, payload: { delivery_id: r.delivery_id, application_id: r.application_id, loan_id: r.loan_id, source: "origination", ...payload } });
  }
  get(deliveryId: string): DeliveryRow { const r = this.deliveries.get(deliveryId); if (!r) throw new RangeError(`no delivery ${deliveryId}`); return r; }
  byApplication(applicationId: string): DeliveryRow | null { return [...this.deliveries.values()].find((r) => r.application_id === applicationId) ?? null; }
  private storeDocument(kind: string, bytes: string, id = `DOC-${kind}-${randomUUID().slice(0, 8)}`): string { this.documents.set(id, { document_id: id, kind, bytes, sha256: sha256Hex(bytes), retention_class: "fnma_loan_file_life_plus_4y", confidentiality: "fnma_confidential" }); return id; }

  /** `loan.funded` (26.3): the delivery row opens in `pending_prerequisites` (29.4's status columns start `not_started`). */
  open(file: LoanFile, deliveryId = `DLV-${file.loan_id}`): DeliveryRow {
    nonEmpty(file.application_id, "application_id"); nonEmpty(file.loan_id, "loan_id");
    const existing = this.byApplication(file.application_id); if (existing) { existing.file = file; return existing; }
    const r: DeliveryRow = { delivery_id: deliveryId, loan_id: file.loan_id, application_id: file.application_id, partner_id: file.partner_id, commitment_id_fnma: file.commitment?.commitment_id_fnma ?? null, execution_type: file.commitment?.type === "mandatory" ? "whole_loan_mandatory" : "whole_loan_best_efforts", remittance_type: file.commitment?.remittance_type ?? "actual_actual", pass_through_rate: file.commitment?.pass_through_rate ?? "", servicing_fee_rate: file.commitment?.servicing_fee_rate ?? "0.2500",
      uldd_phase: ULDD_PHASE, uldd_document_id: null, uldd_sha256: null, uldd_built_at: null, uldd_build_no: 0, loan_state_at_current_date: null, closed_loan_snapshot_hash: file.du?.closed_loan_snapshot_hash ?? null, identifier_snapshot: null, sfc_codes: [], earlycheck_runs: { last_du_file_run_id: null, last_uldd_run_id: null, fatal_count: 0, warning_count: 0, clean: false }, package_id: null, enote_indicator: false, ron_indicator: false, rebuild_reason: null, build_status: "pending_prerequisites", loan_delivery_status: "not_started", ucd_casefile_id: file.ucd?.casefile_id_ucd ?? null, awaiting_cd_version: null, file };
    this.deliveries.set(deliveryId, r); return r;
  }
  /** Refresh the loan file from the finished processes' events (re-triggers: `disclosure.cd.corrected`, `condition.reopened`, mapped-source writes). */
  refresh(deliveryId: string, base: LoanFileBase): LoanFile { const r = this.get(deliveryId); r.file = collectPrerequisites(this.d.events, base); r.ucd_casefile_id = r.file.ucd?.casefile_id_ucd ?? null; return r.file; }
  private guardNotSubmitted(r: DeliveryRow, what: string): void {
    if (["submitted", "purchase_requested", "purchase_ready", "purchased_and_funded"].includes(r.loan_delivery_status)) throw new DeliveryRefused("REBUILD_AFTER_SUBMISSION", "29.3 guardrails: never rebuilds after submission", `${what} refused: loan_delivery_status = ${r.loan_delivery_status} — post-submission corrections go through 29.4's data-revision or PPA paths`);
  }
  /** The DU-file EarlyCheck gate: 23.1's pre-closing run on the final DU Spec file is reused when the hash is unchanged, else the file is run now (open question 5). */
  runDuFileCheck(deliveryId: string, reuse: { run_id: string; file_sha256: string; clean: boolean; result_document_id: string } | null = null): EarlyCheckRun {
    const r = this.get(deliveryId); const f = r.file; if (!f.du) throw new DeliveryRefused("DU_FINAL_SUBMISSION_MISSING", "FNMA_C1_2_02_DU_FILE_EARLYCHECK_GATE", "no final DU submission (23.1)");
    const existing = this.runs.find((x) => x.delivery_id === deliveryId && x.file_kind === "du_spec_3_4" && x.file_sha256 === f.du!.du_spec_file_sha256 && x.completed_at);
    if (existing) return existing;
    const at = this.now();
    if (reuse && reuse.file_sha256 === f.du.du_spec_file_sha256) {
      const run: EarlyCheckRun = { run_id: reuse.run_id, delivery_id: deliveryId, file_kind: "du_spec_3_4", file_document_id: f.du.du_spec_document_id, file_sha256: reuse.file_sha256, channel: "di", submitted_at: at, completed_at: at, result_document_id: reuse.result_document_id, edit_count_by_severity: null, clean: reuse.clean, du_compare_results: null, standardized_address: null, computed_fields: null, submitted_by: "23.1 (reused: identical hash)", correlation_id: randomUUID(), build_no: r.uldd_build_no };
      this.runs.push(run); r.earlycheck_runs.last_du_file_run_id = run.run_id;
      this.emit(r, "earlycheck.completed", { run_id: run.run_id, file_kind: "du_spec_3_4", clean: run.clean, fatal_count: 0, file_sha256: run.file_sha256, channel: "di", reused: true });
      return run;
    }
    const port = this.d.earlycheck; if (!port) throw new DeliveryRefused("EARLYCHECK_PORT_UNAVAILABLE", "29.3 integrations", "no EarlyCheck DI port and no reusable DU-file run");
    const run: EarlyCheckRun = { run_id: `ECR-${randomUUID().slice(0, 8)}`, delivery_id: deliveryId, file_kind: "du_spec_3_4", file_document_id: f.du.du_spec_document_id, file_sha256: f.du.du_spec_file_sha256, channel: "di", submitted_at: at, completed_at: null, result_document_id: null, edit_count_by_severity: null, clean: null, du_compare_results: null, standardized_address: null, computed_fields: null, submitted_by: this.d.agent_run_id ?? "agent:secondary", correlation_id: randomUUID(), build_no: r.uldd_build_no };
    this.runs.push(run);
    const res = port.run({ delivery_id: deliveryId, file_kind: "du_spec_3_4", file_sha256: run.file_sha256, xml: "", seller_number: f.seller_number, correlation_id: run.correlation_id });
    if (res) this.completeRun(r, run, res);
    return run;
  }
  /** `assembling`: prerequisites → R3 identifier gate → R4 SFC gate → LL-2026-06 → B4-1.4-10 → DU-file run → build. Every refusal names its gate and notifies the owner; nothing is built past a closed gate. */
  assemble(deliveryId: string, opts: { du_file_run?: { run_id: string; file_sha256: string; clean: boolean; result_document_id: string } | null } = {}): AssembleOutcome {
    const r = this.get(deliveryId); this.guardNotSubmitted(r, "assemble");
    const f = r.file; const at = this.now();
    if (r.awaiting_cd_version !== null && !(f.ucd && f.ucd.is_final && f.ucd.embedded_cd_version >= r.awaiting_cd_version)) return this.refuse(r, "SM_O62_UCD_RESUBMIT_ON_CORRECTION", `rebuild waits for ucd.accepted{is_final} for CD v${r.awaiting_cd_version} (25.2)`, [], "25.2", "ucd_resubmission");
    if (f.package_incomplete_reason) return this.refuse(r, "REGZ_1026_19F4_SELLER_CD_GATE", `25.2 delivery.package.incomplete{reason=${f.package_incomplete_reason}}`, [], "25.2", "package_incomplete");
    const missing = f.prerequisite_checks.filter((c) => !c.present).map((c) => c.name);
    if (missing.length) { r.build_status = "pending_prerequisites"; return { status: "refused", gate: "prerequisites", reason: `missing: ${missing.join(", ")}`, mismatches: [], build: null, escalation_id: null }; }
    if (!f.compliance.fnma_eligible) return this.refuse(r, "REGZ_1026_43_QM_DETERMINATION_GATE", "23.4 fnma_eligible = false", [], "23.4", "eligibility");
    r.build_status = "assembling"; r.uldd_build_no += 1;
    this.emit(r, "delivery.assembling", { build_no: r.uldd_build_no, at });
    // R3
    const ids = reconcileIdentifiers(f, this.todayEt());
    if (!ids.complete) {
      for (const m of ids.mismatches) { this.emit(r, "delivery.identifier.mismatch.detected", { identifier: m.identifier, expected: m.expected, found: m.found, owner: m.owner_process, rule: m.rule }); this.emit(r, "delivery.correction.requested", { owner_process: m.owner_process, kind: m.identifier === "casefile" ? "ucd_resubmission" : "data_correction", identifier: m.identifier, expected: m.expected, found: m.found }); }
      r.uldd_build_no -= 1; r.build_status = "pending_prerequisites";
      return { status: "refused", gate: "FNMA_ULDD_IDENTIFIER_CONSISTENCY_GATE", reason: identifierConsistencyGate({ mismatches: ids.mismatches }).reason ?? "mismatch", mismatches: ids.mismatches, build: null, escalation_id: null };
    }
    r.identifier_snapshot = ids.snapshot; r.enote_indicator = ids.snapshot.enote_indicator; r.ron_indicator = ids.snapshot.ron_indicator;
    this.emit(r, "delivery.identifiers.reconciled", { identifier_snapshot: ids.snapshot as unknown as Record<string, unknown> });
    // R4
    const sfc = assignSfcs(f, this.d.flags ?? {});
    const g067 = sfc067Gate(f, sfc.included);
    if (!g067.open) { this.emit(r, "delivery.correction.requested", { owner_process: "22.2", kind: "credit_repull_single_model", reason: g067.reason }); r.uldd_build_no -= 1; r.build_status = "pending_prerequisites"; return { status: "refused", gate: "FNMA_LL_2026_06_SFC_067_CONSISTENCY_GATE", reason: g067.reason, mismatches: [], build: null, escalation_id: null }; }
    const gva = valueAcceptanceGate(f, sfc.included);
    if (!gva.open) { this.emit(r, "delivery.correction.requested", { owner_process: "24.1", kind: "appraisal_required", reason: gva.reason }); r.uldd_build_no -= 1; r.build_status = "pending_prerequisites"; return { status: "refused", gate: "FNMA_B4_1_4_10_VALUE_ACCEPTANCE_SFC_GATE", reason: gva.reason, mismatches: [], build: null, escalation_id: null }; }
    const gsfc = sfcCompletenessGate({ sfc_count: sfc.count, contradictions: sfc.contradictions, required_missing: [] });
    if (!gsfc.open) {
      let escalation_id: string | null = null;
      if (sfc.over_cap && this.d.escalations) escalation_id = this.d.escalations.open({ kind: "officer", ownerRole: "officer", applicationId: r.application_id, loanId: r.loan_id, payload: { reason: "sfc_over_cap", candidates: sfc.assignments.filter((a) => a.included_in_uldd).map((a) => ({ code: a.sfc_code, rule_ref: a.rule_ref })), count: sfc.count, cap: SFC_CAP, instruction: "obtain and document the Fannie Mae instruction before freezing; no code is dropped automatically" } }, SECONDARY_AGENT).id;
      r.uldd_build_no -= 1; r.build_status = "pending_prerequisites";
      return { status: "refused", gate: "FNMA_C1_2_02_SFC_COMPLETENESS_GATE", reason: gsfc.reason ?? "closed", mismatches: [], build: null, escalation_id };
    }
    for (const a of sfc.assignments) this.assignments.push({ ...a, delivery_id: deliveryId, assigned_at: at });
    r.sfc_codes = sfc.included;
    this.emit(r, "delivery.sfc.assigned", { codes: sfc.included, rule_refs: Object.fromEntries(sfc.assignments.map((a) => [a.sfc_code, a.rule_ref])), count: sfc.count });
    // DU-file EarlyCheck gate
    const duRun = this.runDuFileCheck(deliveryId, opts.du_file_run ?? null);
    const gdu = duFileEarlycheckGate({ du_file_run_clean: duRun.clean, du_file_run_sha256: duRun.file_sha256, du_spec_file_sha256: f.du!.du_spec_file_sha256 });
    if (!gdu.open) { r.build_status = "assembling"; return { status: "refused", gate: "FNMA_C1_2_02_DU_FILE_EARLYCHECK_GATE", reason: gdu.reason ?? "closed", mismatches: [], build: null, escalation_id: null }; }
    r.build_status = "du_file_checked";
    const build = this.build(r, ids.snapshot, sfc.included, sfc.assignments.map((a) => ({ code: a.sfc_code, rule_ref: a.rule_ref })));
    return { status: "built", gate: null, reason: null, mismatches: [], build, escalation_id: null };
  }
  private refuse(r: DeliveryRow, gate: string, reason: string, mismatches: IdentifierMismatch[], owner: string, kind: string): AssembleOutcome { this.emit(r, "delivery.correction.requested", { owner_process: owner, kind, reason, gate }); return { status: "refused", gate, reason, mismatches, build: null, escalation_id: null }; }
  /** R1/R2: assemble, validate, serialize, hash — `delivery.uldd.built{build_no, sha256}` (satisfies SM_O103_ULDD_BUILD_SLA_1BD; arms FNMA_C1_2_02_EARLYCHECK_CLEAN_GATE). */
  private build(r: DeliveryRow, snap: IdentifierSnapshot, sfcs: string[], sfcSet: { code: string; rule_ref: string }[]): BuildResult {
    const f = r.file; const at = this.now(); const build_on = this.todayEt();
    if (r.closed_loan_snapshot_hash && f.du && f.du.closed_loan_snapshot_hash !== r.closed_loan_snapshot_hash) throw new DeliveryRefused("FNMA_B3_2_10_DU_FINAL_MATCH_GATE", "29.3 R1", "deliveries.closed_loan_snapshot_hash ≠ du_submissions.closed_loan_snapshot_hash — 23.1 final_closed_loan_match resubmission");
    const asm = assembleUlddDataPoints(f, snap, sfcs, build_on);
    const schema = validateSchema(asm.points, sfcs);
    if (!schema.valid) throw new DeliveryRefused("ULDD_SCHEMA_INVALID", "29.3 R2 (Appendix E)", schema.errors.join("; "));
    const xml = buildUlddXml(asm.points, sfcs, { seller_number: f.seller_number, build_no: r.uldd_build_no, build_on });
    const document_id = this.storeDocument("uldd_xml", xml.xml, `DOC-ULDD-${r.delivery_id}-b${r.uldd_build_no}`);
    for (const p of asm.points) this.points.push({ ...p, delivery_id: r.delivery_id, build_no: r.uldd_build_no });
    r.uldd_document_id = document_id; r.uldd_sha256 = xml.sha256; r.uldd_built_at = at; r.loan_state_at_current_date = build_on; r.build_status = "uldd_built"; r.closed_loan_snapshot_hash = f.du?.closed_loan_snapshot_hash ?? r.closed_loan_snapshot_hash; r.loan_delivery_status = "draft";
    this.emit(r, "delivery.uldd.built", { build_no: r.uldd_build_no, sha256: xml.sha256, phase: ULDD_PHASE, document_id, built_on: build_on, sfc_codes: sfcs, byte_length: xml.byte_length });
    this.decisions.push({ delivery_id: r.delivery_id, build_no: r.uldd_build_no, prerequisite_checks: f.prerequisite_checks, conditionality_decisions: asm.conditionality_decisions, sfc_set: sfcSet, identifier_snapshot: snap, earlycheck: { run_id: null, severities: null, resolutions: [] }, gate_results: null, uldd_sha256: xml.sha256, rule_set_versions: RULE_SET_VERSIONS_29_3, model_version: MODEL_VERSION_29_3, prompt_version: PROMPT_VERSION_29_3, rationale: `build ${r.uldd_build_no}: ${asm.points.filter((p) => p.value !== null).length} Sort IDs populated, SFCs {${sfcs.join(", ")}}`, confidence: 1, recorded_at: at });
    return { build_no: r.uldd_build_no, points: asm.points, conditionality_decisions: asm.conditionality_decisions, sfcs, xml: xml.xml, sha256: xml.sha256, document_id, built_at: at, schema };
  }
  /** EarlyCheck over DI on the current build (idempotent per (delivery, hash, kind)); `null` from the port leaves the run pending for the 60-minute UI fallback. */
  runEarlyCheck(deliveryId: string): EarlyCheckRun {
    const r = this.get(deliveryId); if (!r.uldd_sha256 || !r.uldd_document_id) throw new DeliveryRefused("NO_BUILD", "29.3 state machine", "buildUldd first");
    const existing = this.runs.find((x) => x.delivery_id === deliveryId && x.file_kind === "uldd_3_0" && x.file_sha256 === r.uldd_sha256);
    if (existing) return existing;
    const port = this.d.earlycheck; if (!port) throw new DeliveryRefused("EARLYCHECK_PORT_UNAVAILABLE", "29.3 integrations", "no EarlyCheck DI port wired");
    const at = this.now(); const doc = this.documents.get(r.uldd_document_id)!;
    const run: EarlyCheckRun = { run_id: `ECR-${randomUUID().slice(0, 8)}`, delivery_id: deliveryId, file_kind: "uldd_3_0", file_document_id: r.uldd_document_id, file_sha256: r.uldd_sha256, channel: "di", submitted_at: at, completed_at: null, result_document_id: null, edit_count_by_severity: null, clean: null, du_compare_results: null, standardized_address: null, computed_fields: null, submitted_by: this.d.agent_run_id ?? "agent:secondary", correlation_id: randomUUID(), build_no: r.uldd_build_no };
    this.runs.push(run); r.build_status = "earlycheck_pending"; r.earlycheck_runs.last_uldd_run_id = run.run_id;
    this.storeDocument("earlycheck_request", doc.bytes, `DOC-EC-REQ-${run.run_id}`);
    const res = port.run({ delivery_id: deliveryId, file_kind: "uldd_3_0", file_sha256: run.file_sha256, xml: doc.bytes, seller_number: r.file.seller_number, correlation_id: run.correlation_id });
    if (res) this.completeRun(r, run, res);
    return run;
  }
  private completeRun(r: DeliveryRow, run: EarlyCheckRun, res: EarlyCheckResult): void {
    const at = this.now();
    run.completed_at = at; run.result_document_id = res.result_document_id; run.edit_count_by_severity = editCountBySeverity(res.edits); run.clean = isClean(res.edits); run.du_compare_results = res.du_compare_results ?? null; run.standardized_address = res.standardized_address ?? null; run.computed_fields = res.computed_fields ?? null;
    if (run.file_kind === "uldd_3_0") { r.earlycheck_runs = { ...r.earlycheck_runs, last_uldd_run_id: run.run_id, fatal_count: run.edit_count_by_severity.fatal, warning_count: run.edit_count_by_severity.warning + run.edit_count_by_severity.warning_to_fatal, clean: run.clean }; r.build_status = run.clean ? "earlycheck_clean" : "earlycheck_failed"; }
    else r.earlycheck_runs.last_du_file_run_id = run.run_id;
    for (const e of res.edits) {
      const route = mapEditToOwner(e);
      const edit: DeliveryEdit = { edit_id: `EDT-${randomUUID().slice(0, 8)}`, delivery_id: r.delivery_id, run_id: run.run_id, source: "earlycheck", edit_code: e.edit_code, prefix: e.prefix ?? editPrefix(e.edit_code), severity: e.severity, message: e.message, sort_ids: e.sort_ids, observed_at: at, owner_process: route.owner_process, resolution: "unresolved", resolution_ref: null, resolved_at: null, resolved_by: null, kind: e.kind ?? null, details: e.details ?? {} };
      this.edits.push(edit);
      this.emit(r, "delivery.edit.observed", { edit_id: edit.edit_id, run_id: run.run_id, source: "earlycheck", edit_code: e.edit_code, severity: e.severity, prefix: edit.prefix, sort_ids: e.sort_ids, owner_process: route.owner_process, derivable: route.derivable, fatal: e.severity === "fatal" });
      if (!route.derivable && route.owner_process !== "29.3" && (e.severity === "fatal" || e.severity === "warning_to_fatal" || e.kind === "du_compare")) this.emit(r, "delivery.correction.requested", { owner_process: route.owner_process, kind: route.owner_process === "23.1" ? "du_compare" : "data_correction", edit_id: edit.edit_id, edit_code: e.edit_code, sort_ids: e.sort_ids, reason: route.reason });
    }
    this.emit(r, "earlycheck.completed", { run_id: run.run_id, file_kind: run.file_kind, clean: run.clean, fatal_count: run.edit_count_by_severity.fatal, warning_to_fatal_count: run.edit_count_by_severity.warning_to_fatal, file_sha256: run.file_sha256, channel: run.channel, build_no: run.build_no });
    const dec = this.decisions.find((d) => d.delivery_id === r.delivery_id && d.build_no === run.build_no);
    if (dec && run.file_kind === "uldd_3_0") this.decisions[this.decisions.indexOf(dec)] = { ...dec, earlycheck: { run_id: run.run_id, severities: run.edit_count_by_severity, resolutions: [] } };
  }
  /** Outage handling: a DI run without a result for 60 minutes opens the `fnma_portal_operator` task with the identical file (hash shown). */
  sweep(nowIso = this.now()): { run_id: string; escalation_id: string }[] {
    const out: { run_id: string; escalation_id: string }[] = [];
    for (const run of this.runs) {
      if (run.completed_at || run.channel === "ui") continue;
      if (Date.parse(nowIso) - Date.parse(run.submitted_at) < EARLYCHECK_DI_TIMEOUT_MINUTES * 60_000) continue;
      const r = this.get(run.delivery_id); run.channel = "ui";
      const esc = this.d.escalations?.open({ kind: "human_portal_task", ownerRole: "fnma_portal_operator", applicationId: r.application_id, loanId: r.loan_id, payload: { task: "earlycheck_ui_run", run_id: run.run_id, file_document_id: run.file_document_id, file_sha256: run.file_sha256, file_kind: run.file_kind, instruction: `Run this exact file (SHA-256 ${run.file_sha256}) through the EarlyCheck web UI and attach the result export; a different file is not certified.` } }, SECONDARY_AGENT);
      this.emit(r, "earlycheck.ui_fallback.opened", { run_id: run.run_id, file_sha256: run.file_sha256, escalation_id: esc?.id ?? null, after_minutes: EARLYCHECK_DI_TIMEOUT_MINUTES });
      out.push({ run_id: run.run_id, escalation_id: esc?.id ?? "" });
    }
    return out;
  }
  /** The operator's UI export, recorded against the hash of the file actually run (`channel = ui`); the clean gate compares that hash to the build. */
  attachUiResult(runId: string, i: { file_sha256_run: string; result: EarlyCheckResult; operator: Actor }): EarlyCheckRun {
    const run = this.runs.find((x) => x.run_id === runId); if (!run) throw new RangeError(`no run ${runId}`);
    if (run.completed_at) throw new DeliveryRefused("RUN_ALREADY_COMPLETE", "29.3 integrations", `run ${runId} already has a result`);
    if (i.operator.kind !== "human" || i.operator.role !== "fnma_portal_operator") throw new DeliveryRefused("UI_RESULT_ROLE", "29.3 escalations", "the UI export is attached by the fnma_portal_operator");
    const r = this.get(run.delivery_id); run.channel = "ui"; run.file_sha256 = i.file_sha256_run; run.submitted_by = `human:${i.operator.id}`;
    this.storeDocument("earlycheck_ui_export", JSON.stringify(i.result), i.result.result_document_id);
    this.completeRun(r, run, i.result);
    return run;
  }
  /** T11 / worked example B: apply a derived fix (enumeration default, format trim, EarlyCheck's standardized address) and rebuild; the fix is a rule, not a typed value. */
  applyDerivedFix(editId: string, base: LoanFileBase): { edit: DeliveryEdit; build: BuildResult | null; property_audit: PropertyAuditRow | null } {
    const edit = this.edits.find((e) => e.edit_id === editId); if (!edit) throw new RangeError(`no edit ${editId}`);
    const r = this.get(edit.delivery_id); this.guardNotSubmitted(r, "applyDerivedFix");
    const src: EarlyCheckEdit = { edit_code: edit.edit_code, severity: edit.severity, message: edit.message, sort_ids: edit.sort_ids, ...(edit.kind ? { kind: edit.kind } : {}) };
    const ok = derivedFixAllowed(src); if (!ok.allowed) throw new DeliveryRefused("DERIVED_FIX_NOT_ALLOWED", "29.3 guardrails: never types a value not traceable to a source record", ok.reason!);
    let property_audit: PropertyAuditRow | null = null; let nextBase = base;
    if (edit.kind === "standardized_address") {
      const run = this.runs.find((x) => x.run_id === edit.run_id); const std = run?.standardized_address ?? null;
      if (!std) throw new DeliveryRefused("NO_STANDARDIZED_ADDRESS", "29.3 R2", "EarlyCheck returned no standardized address for this run");
      const before = { street: base.property.street, city: base.property.city, state: base.property.state, zip: base.property.zip };
      property_audit = { property_id: base.property.property_id, before, after: { ...std }, source: "earlycheck_standardization", run_id: run!.run_id, at: this.now() };
      this.propertyAudit.push(property_audit);
      this.emit(r, "property.address.standardized", { property_id: base.property.property_id, before, after: std, source: "earlycheck_standardization", run_id: run!.run_id, edit_id: edit.edit_id });
      nextBase = { ...base, property: { ...base.property, ...std } };
    }
    edit.resolution = "data_corrected"; edit.resolution_ref = `rule:${edit.kind}`; edit.resolved_at = this.now(); edit.resolved_by = this.d.agent_run_id ?? "agent:secondary";
    const build = this.rebuild(r.delivery_id, nextBase, `earlycheck_edit:${edit.edit_code}`);
    return { edit, build: build.build, property_audit };
  }
  /** Warnings need a recorded justification; DU Compare and fatal/warning-to-fatal edits are never bypassed (open question 6 default). */
  resolveEdit(editId: string, resolution: EditResolution, ref: { resolution_ref: string; by?: string }): DeliveryEdit {
    const edit = this.edits.find((e) => e.edit_id === editId); if (!edit) throw new RangeError(`no edit ${editId}`);
    if (resolution === "bypassed_with_justification") {
      if (edit.severity === "fatal" || edit.severity === "warning_to_fatal") throw new DeliveryRefused("EDIT_BYPASS_REFUSED", "C1-2-02: loans may only be submitted if clear of all fatal edits; 29.3 guardrails", `${edit.severity} edit ${edit.edit_code} cannot be bypassed`);
      if (edit.kind === "du_compare" || edit.prefix === "D") throw new DeliveryRefused("EDIT_BYPASS_REFUSED", "29.3 R5 / edit routing", `DU Compare edit ${edit.edit_code} is resolved only by 23.1 (source_corrected_upstream)`);
    }
    if (resolution === "data_corrected" && !derivedFixAllowed({ edit_code: edit.edit_code, severity: edit.severity, message: edit.message, sort_ids: edit.sort_ids, ...(edit.kind ? { kind: edit.kind } : {}) }).allowed) throw new DeliveryRefused("EDIT_NOT_DERIVABLE", "29.3 guardrails", `edit ${edit.edit_code} (${edit.owner_process}) is corrected upstream, not here`);
    edit.resolution = resolution; edit.resolution_ref = ref.resolution_ref; edit.resolved_at = this.now(); edit.resolved_by = ref.by ?? (this.d.agent_run_id ?? "agent:secondary");
    return edit;
  }
  /** Re-assemble with `uldd_build_no + 1` after a correction (`delivery.uldd.rebuilt{reason}`); the previous build and its run are retained. */
  rebuild(deliveryId: string, base: LoanFileBase, reason: string): AssembleOutcome {
    const r = this.get(deliveryId); this.guardNotSubmitted(r, "rebuild");
    r.rebuild_reason = reason; this.refresh(deliveryId, base);
    const out = this.assemble(deliveryId);
    if (out.status === "built") this.emit(r, "delivery.uldd.rebuilt", { reason, build_no: r.uldd_build_no, sha256: r.uldd_sha256 });
    return out;
  }
  /** Gate results at freeze: every composed gate (as its owner's events left it) plus 29.3's own, all `open`; the commitment open; MI active before delivery (freeze after `mi.activated`). */
  gateResults(r: DeliveryRow): DeliveryPackage["gate_results"] {
    const f = r.file; const g: Record<string, { result: "open" | "closed" | "n/a"; evidence_ref: string | null }> = {};
    const own = (code: string, open: boolean, ref: string | null) => { g[code] = { result: open ? "open" : "closed", evidence_ref: ref }; };
    const run = this.runs.find((x) => x.run_id === r.earlycheck_runs.last_uldd_run_id) ?? null;
    own("FNMA_B3_2_10_DU_FINAL_MATCH_GATE", !!f.du && f.du.closed_loan_snapshot_hash === r.closed_loan_snapshot_hash, f.du?.closed_loan_snapshot_hash ?? null);
    own("FNMA_UCD_ACCEPTED_GATE", !!f.ucd && ["accepted", "accepted_with_warnings"].includes(f.ucd.status) && f.ucd.is_final, f.ucd ? `ucd cd_v${f.ucd.embedded_cd_version}` : null);
    const va = f.valuation.method !== "traditional" && f.valuation.method !== "appraisal";
    g["FNMA_B4_1_1_06_UCDP_SUCCESSFUL_GATE"] = va ? { result: "n/a", evidence_ref: "value acceptance" } : { result: f.ucdp?.status === "successful" && docFileIdCheck(f.ucdp.doc_file_id, f.ucdp.uad_version).ok ? "open" : "closed", evidence_ref: f.ucdp?.doc_file_id ?? null };
    g["FNMA_B7_1_01_MI_ACTIVE_BEFORE_DELIVERY_GATE"] = f.mi ? { result: f.mi.status === "active" && f.mi.activated_at !== null && Date.parse(f.mi.activated_at) <= Date.parse(this.now()) ? "open" : "closed", evidence_ref: f.mi.activated_at } : { result: "n/a", evidence_ref: "no MI" };
    const cpm = f.project?.review_type === "cpm";
    for (const code of ["FNMA_B4_2_1_01_CPM_CERT_VALID_GATE", "FNMA_B4_1_2_05_COMPLETION_BEFORE_DELIVERY_GATE", "FNMA_B4_1_3_06_SAFETY_REPAIR_BEFORE_SALE_GATE"]) g[code] = f.gates[code] ? { result: f.gates[code]!, evidence_ref: "24.3" } : cpm && code === "FNMA_B4_2_1_01_CPM_CERT_VALID_GATE" ? { result: f.project!.expires_at && f.project!.expires_at >= f.note_date ? "open" : "closed", evidence_ref: f.project!.expires_at } : { result: "n/a", evidence_ref: null };
    own("REGZ_1026_43_QM_DETERMINATION_GATE", f.compliance.fnma_eligible, "23.4 fnma_eligible");
    own("SM_O61_PRE_DELIVERY_COMPLIANCE_CHECKPOINT", f.compliance.pre_delivery_checkpoint_passed_at !== null, f.compliance.pre_delivery_checkpoint_passed_at);
    g[f.note.form === "enote" ? "MERS_PROC_ENOTE_REGISTER_1BD" : "MERS_PROC_MOM_REGISTER_7"] = { result: f.note.min ? "open" : "closed", evidence_ref: f.note.min };
    own("FNMA_B2_1_5_FIRST_PAYMENT_2M", f.first_payment_date <= addMonths(f.disbursement_date, 2), f.first_payment_date);
    own("FNMA_C2_2_DELIVERY_COMMITMENT_EXPIRY", !!f.commitment && f.commitment.expires_on > this.todayEt(), f.commitment?.expires_on ?? null);
    own("FNMA_ULDD_IDENTIFIER_CONSISTENCY_GATE", r.identifier_snapshot !== null, null);
    own("FNMA_C1_2_02_SFC_COMPLETENESS_GATE", r.sfc_codes.length > 0 && r.sfc_codes.length <= SFC_CAP, r.sfc_codes.join(","));
    own("FNMA_C1_2_02_DU_FILE_EARLYCHECK_GATE", this.runs.some((x) => x.delivery_id === r.delivery_id && x.file_kind === "du_spec_3_4" && x.clean === true && x.file_sha256 === f.du?.du_spec_file_sha256), r.earlycheck_runs.last_du_file_run_id);
    own("FNMA_C1_2_02_EARLYCHECK_CLEAN_GATE", earlycheckCleanGate({ run_clean: run?.clean, run_file_sha256: run?.file_sha256, uldd_sha256: r.uldd_sha256, run_file_kind: run?.file_kind }).open, run?.run_id ?? null);
    for (const [k, v] of Object.entries(f.gates)) if (!g[k]) g[k] = { result: v, evidence_ref: "owner event" };
    return g;
  }
  /** `freezePackage`: the clean run must be over exactly this build's bytes; every gate open; the package is immutable after `frozen_at` (`delivery.package.frozen{package_id, sha256}`). */
  freeze(deliveryId: string): DeliveryPackage {
    const r = this.get(deliveryId); this.guardNotSubmitted(r, "freeze");
    if (!r.uldd_sha256 || !r.uldd_document_id) throw new DeliveryRefused("NO_BUILD", "29.3 state machine", "nothing built");
    if (r.build_status === "superseded" || r.awaiting_cd_version !== null) throw new DeliveryRefused("SM_O103_REBUILD_ON_CHANGE", "29.3 timer table: a stale package can never be imported", `build ${r.uldd_build_no} was superseded (${r.rebuild_reason ?? "data change"})${r.awaiting_cd_version !== null ? `; waiting for ucd.accepted{is_final} for CD v${r.awaiting_cd_version}` : ""} — rebuild first`);
    const run = this.runs.find((x) => x.run_id === r.earlycheck_runs.last_uldd_run_id) ?? null;
    const clean = earlycheckCleanGate({ run_clean: run?.clean, run_file_sha256: run?.file_sha256, uldd_sha256: r.uldd_sha256, run_file_kind: run?.file_kind });
    if (!clean.open) throw new DeliveryRefused("FNMA_C1_2_02_EARLYCHECK_CLEAN_GATE", "C1-2-02: clear of all fatal edits", clean.reason!);
    const gate_results = this.gateResults(r);
    const closed = Object.entries(gate_results).filter(([, v]) => v.result === "closed").map(([k]) => k);
    if (closed.length) throw new DeliveryRefused(closed[0]!, "29.3 state machine: `frozen` requires every composed gate open", `blocking gate(s): ${closed.join(", ")}`);
    const doc = this.documents.get(r.uldd_document_id)!; const sha = sha256Hex(doc.bytes);
    const pf = packageFreezeGate({ uldd_sha256: sha, clean_run_sha256: run!.file_sha256, gate_results: Object.fromEntries(Object.entries(gate_results).map(([k, v]) => [k, v.result])) });
    if (!pf.open) throw new DeliveryRefused("SM_O103_PACKAGE_FREEZE_GATE", "29.3 timer table", pf.reason!);
    const at = this.now(); const version = this.packages.filter((p) => p.delivery_id === deliveryId).length + 1;
    const pkg: DeliveryPackage = { package_id: `PKG-${deliveryId}-v${version}`, delivery_id: deliveryId, version, uldd_document_id: r.uldd_document_id, uldd_sha256: sha, earlycheck_run_id: run!.run_id, identifier_snapshot: r.identifier_snapshot!, sfc_codes: [...r.sfc_codes], gate_results, frozen_at: at, frozen_by_agent_run_id: this.d.agent_run_id ?? "agent:secondary", status: "frozen", superseded_by: null, supersede_reason: null };
    this.packages.push(pkg); r.package_id = pkg.package_id; r.build_status = "frozen";
    this.emit(r, "delivery.package.frozen", { package_id: pkg.package_id, sha256: sha, version, build_no: r.uldd_build_no, sfc_codes: pkg.sfc_codes, frozen_at: at, enote_indicator: r.enote_indicator, commitment_id_fnma: r.commitment_id_fnma });
    pkg.status = "handed_to_operator";
    const dec = this.decisions.findLast((d) => d.delivery_id === deliveryId);
    if (dec) this.decisions[this.decisions.lastIndexOf(dec)] = { ...dec, gate_results, uldd_sha256: sha, earlycheck: { ...dec.earlycheck, resolutions: this.edits.filter((e) => e.delivery_id === deliveryId).map((e) => ({ edit_id: e.edit_id, resolution: e.resolution })) } };
    return pkg;
  }
  /** SM_O103_REBUILD_ON_CHANGE: a frozen package is superseded (never imported) on any mapped-source write, a corrected CD, a 29.4 fatal edit or a commitment change; 29.4's operator task is cancelled. Refused after submission. */
  supersede(deliveryId: string, reason: string, i: { awaiting_cd_version?: number | null } = {}): { package: DeliveryPackage | null; cancelled_task_ids: string[] } {
    const r = this.get(deliveryId); this.guardNotSubmitted(r, "supersede");
    const pkg = this.packages.find((p) => p.package_id === r.package_id && p.status !== "superseded") ?? null;
    if (pkg) { pkg.status = "superseded"; pkg.supersede_reason = reason; }
    r.build_status = "superseded"; r.package_id = null; r.rebuild_reason = reason; r.awaiting_cd_version = i.awaiting_cd_version ?? null;
    this.emit(r, "delivery.package.superseded", { reason, package_id: pkg?.package_id ?? null, uldd_sha256: pkg?.uldd_sha256 ?? r.uldd_sha256, awaiting_cd_version: r.awaiting_cd_version });
    const cancelled: string[] = [];
    if (pkg) for (const e of this.d.events.all()) { const p = e.payload as P; if (e.type === "escalation.created" && p.kind === "human_portal_task" && p.package_id === pkg.package_id && typeof p.escalation_id === "string") { cancelled.push(p.escalation_id); } }
    if (pkg) this.emit(r, "delivery.operator_task.cancelled", { package_id: pkg.package_id, escalation_ids: cancelled, reason });
    return { package: pkg, cancelled_task_ids: cancelled };
  }
  /** `disclosure.cd.corrected` (25.2) after funding before the import: supersede and wait for `ucd.accepted{is_final}` of the corrected CD version. */
  onCdCorrected(applicationId: string, p: { cd_version: number }): ReturnType<DeliveryBuildService["supersede"]> | null {
    const r = this.byApplication(applicationId); if (!r || r.build_status === "withdrawn") return null;
    if (["submitted", "purchase_requested", "purchase_ready", "purchased_and_funded"].includes(r.loan_delivery_status)) return null;   // 29.4's data-revision / PPA paths
    return this.supersede(r.delivery_id, "cd_corrected", { awaiting_cd_version: p.cd_version });
  }
  /** `ucd.accepted{is_final}` (25.2) for the awaited CD version releases the rebuild. */
  onUcdAccepted(applicationId: string, p: { is_final: boolean; embedded_cd_version: number; casefile_id_ucd: string | null }): boolean {
    const r = this.byApplication(applicationId); if (!r) return false;
    r.ucd_casefile_id = p.casefile_id_ucd;
    if (r.awaiting_cd_version !== null && p.is_final && p.embedded_cd_version >= r.awaiting_cd_version) { r.awaiting_cd_version = null; return true; }
    return false;
  }
  /** 29.1's commitment events after freeze: supersede and rebuild with the new commitment number (economics are 29.1's). */
  onCommitmentChanged(applicationId: string, reason: "commitment_modified" | "commitment_extended" | "commitment_expired"): ReturnType<DeliveryBuildService["supersede"]> | null {
    const r = this.byApplication(applicationId); if (!r || r.build_status !== "frozen") return null;
    return this.supersede(r.delivery_id, reason);
  }
  /** 29.4 marks the package imported / the loan submitted (terminal for 29.3); 25.3 rescission or 27.1 repurchase withdraws it. */
  markSubmitted(deliveryId: string): void { const r = this.get(deliveryId); r.loan_delivery_status = "submitted"; const pkg = this.packages.find((p) => p.package_id === r.package_id); if (pkg) pkg.status = "imported"; }
  withdraw(deliveryId: string, reason: string): void { const r = this.get(deliveryId); r.build_status = "withdrawn"; this.emit(r, "delivery.withdrawn", { reason }); }
  decisionRecord(deliveryId: string): AgentDecision29_3 | null { return this.decisions.findLast((d) => d.delivery_id === deliveryId) ?? null; }
}
