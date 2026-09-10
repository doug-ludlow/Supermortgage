/**
 * §9.1 operating rules over the pure calculators in hazard.ts — the code paths that append the
 * `insurance.*` events the timer registry arms and satisfies from:
 *
 *   - the `insurance-tracking/lpi` inbound handler (policy snapshots, EOI images, cancellation /
 *     non-renewal / reinstatement notices, rating updates), idempotent on the spec's key
 *     (vendor loan id, policy id, message type, vendor sequence) — build spec "Integrations";
 *   - evidence intake, carrier/agent confirmation (rule 4, T4) and the guardrailed transition to
 *     `verified` (rule 2, T1) with the B-2-02 renewal shortcut (rule 3, T3) — `insurance.evidence.
 *     received/confirmed/rejected`, `insurance.policy.verified`, `insurance.deficiency.detected`;
 *   - the B-2-03 annual master-policy check (T7) — `insurance.master_policy.verified`;
 *   - the daily `insurance_sweep` (build spec "Schedules"): expiring at −60, `INS_EOI_REQUEST` at −30,
 *     `insurance.policy.expired{evidence_received=false}` when the expiration date passes, the lapse at +1
 *     that opens 9.2 with the §1024.17(k)(5) check applied (T5), the annual reminder (rule 7, T6), the
 *     annual re-verification queue and the vendor heartbeat (T9);
 *   - Fannie Mae documentation requests (B-6-01 30 calendar days; B-3-01 10 Fannie business days) on the
 *     platform's `fnma.request.received` / `fnma.request.responded{kind}` aggregate;
 *   - the B-2-02 insufficiency notice (`INS_DEFICIENCY_NOTICE`, `_BK` under Section 14) and the annual
 *     reminder through the Notice Registry, whose `notice.sent{template}` closes the 5-BD and 365-day rows.
 *
 * bigint cents; PlainDate; every transition is an appended event; no ledger postings (premiums are 3.7).
 */
import { type PlainDate, addDays, daysBetween, plainDate } from "../../kernel/calendar/date.ts";
import { type Calendar, addBusinessDays, servicer, fannieEt } from "../../kernel/calendar/business.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import type { EventStore, DomainEvent, Actor } from "../../kernel/events/index.ts";
import { evaluateAdequacy, verifyPolicy, renewalShortcut, coverageDecreaseFollowUp, confirmationRequired, masterPolicyDeficiencies, deficiencyNoticeDue, lapseDetectedOn, annualReminderDue, annualReminderNextDue, ANNUAL_REMINDER_MANDATORY_FROM, vendorFeedSeverity, mortgageeChangeRequest, CRITICAL_FIELDS, type HazardPolicy, type Deficiency, type AdequacyResult } from "./hazard.ts";
import { lapseDetected, type LapseDetectedOutcome } from "./ops.ts";
import type { InsuranceType } from "./fpi.ts";

export const RULE_SET_9_1 = "fnma.insurance.2026-08";
export const EXTRACTION_MODEL_VERSION = "eoi-extract.2026-09";
export const INSURANCE_AGENT: Actor = { kind: "agent", id: "insurance-property" };
export const VENDOR_ADAPTER: Actor = { kind: "external", id: "insurance-tracking/lpi" };
const ET = "America/New_York";

// ---- data model (spec "Data model") ------------------------------------------------------------------------------
export type PolicyKind = "hazard" | "wind" | "hail" | "flood" | "earthquake" | "unit_owner" | "master_condo" | "master_pud" | "master_coop" | "rcbap" | "lpi_hazard" | "lpi_wind" | "lpi_flood" | "other";
export type TrackedPolicyStatus = "pending_verification" | "verified" | "deficient" | "expiring" | "expired" | "cancelled" | "nonrenewed" | "replaced" | "superseded";
export type EvidenceKind = "new" | "renewal";
export type EvidenceStatus = "received" | "extracted" | "needs_carrier_confirmation" | "confirmed" | "rejected" | "superseded";
/** Comment 37(c)(1)(iii)-2: the only two grounds on which evidence may be rejected. */
export type RejectReason = "not_confirmed_by_carrier_or_agent" | "terms_noncompliant";
export type ConfirmedVia = "vendor" | "carrier_api" | "agent_call" | "borrower_portal_link";
export type EvidenceChannel = "boarding" | "vendor_feed" | "eoi_document" | "carrier_api" | "borrower_portal" | "mail" | "agent_call";
export type FnmaRequestKind = "lpi_documentation" | "flood_evidence";
export type DeficiencyStatus = "open" | "notified" | "cured" | "escalated_to_fpi" | "waived";
export type ExtractionConfidence = Partial<Record<(typeof CRITICAL_FIELDS)[number], number>>;

export interface TrackedPolicy {
  readonly policy_id: string; readonly loan_id: string; readonly policy_kind: PolicyKind;
  readonly effective_date: PlainDate; readonly expiration_date: PlainDate;
  readonly coverage_dwelling_cents: Cents; readonly last_known_coverage_cents: Cents | null;
  readonly status: TrackedPolicyStatus; readonly verified_at: PlainDate | null; readonly source: EvidenceChannel; readonly version: number;
  readonly cancellation_effective: PlainDate | null;
  /** Renewal evidence confirmed for the term after `expiration_date` (stops the expiration path). */
  readonly renewal_evidence_on: PlainDate | null;
  readonly expiring_flagged_on: PlainDate | null; readonly eoi_requested_on: PlainDate | null; readonly expired_flagged_on: PlainDate | null; readonly lapse_detected_on: PlainDate | null; readonly reverification_flagged_on: PlainDate | null;
}
export interface TrackedLoan {
  readonly loan_id: string; readonly vendor_loan_id?: string; readonly boarded_on: PlainDate;
  readonly escrowed: boolean; readonly regx_days_delinquent: number;
  readonly cancellation_reason?: "nonpayment" | "underwriting" | "other" | null; readonly vacant?: boolean; readonly bankruptcy_active?: boolean; readonly fdpa_flood_required?: boolean;
  readonly title_holders: readonly string[]; readonly recipients?: readonly RecipientLike[];
  readonly last_reminder_sent_on: PlainDate | null;
}
export interface EvidenceRecord {
  readonly evidence_id: string; readonly loan_id: string; readonly policy_id: string | null; readonly kind: EvidenceKind; readonly channel: EvidenceChannel;
  readonly received_on: PlainDate; readonly document_sha256: string | null; readonly extraction_model_version: string | null;
  readonly confidence: ExtractionConfidence | null; readonly confirmation_required: readonly string[];
  readonly verification_status: EvidenceStatus; readonly confirmed_via: ConfirmedVia | null; readonly reject_reason: RejectReason | null;
}
export interface DeficiencyRecord {
  readonly deficiency_id: string; readonly loan_id: string; readonly policy_id: string | null; readonly kinds: readonly Deficiency[]; readonly detected_at: string; readonly detected_on: PlainDate;
  readonly notice_due: PlainDate; readonly regx_reasonable_basis: boolean; readonly status: DeficiencyStatus; readonly notice_id: string | null; readonly notice_template: string | null; readonly decision_id: string;
}
export interface FnmaRequestRecord { readonly request_id: string; readonly loan_id: string | null; readonly kind: FnmaRequestKind; readonly received_on: PlainDate; readonly due: PlainDate; readonly timer: "FNMA_B601_LPI_DOC_REQUEST_30" | "FNMA_B301_FLOOD_EVIDENCE_TO_FNMA_10BD"; readonly responded_on: PlainDate | null; readonly document_ids: readonly string[]; }
/** Spec "AI agent design" decision record: what the agent looked at and why it moved the policy. */
export interface DecisionRecord {
  readonly decision_id: string; readonly loan_id: string; readonly policy_id: string | null; readonly evidence_id: string | null; readonly evidence_hash: string | null;
  readonly extraction_confidence: ExtractionConfidence | null; readonly adequacy: AdequacyResult | null; readonly last_known_comparison: { coverage_cents: Cents; last_known_cents: Cents | null; result: "verified" | "coverage_decrease_unconfirmed" } | null;
  readonly steps: readonly string[]; readonly notices: readonly string[]; readonly rationale: string; readonly rule_set: string; readonly model_version: string; readonly outcome: string; readonly at: string;
}

// ---- structural dependencies (the platform services; typed here so the domain stays free of app/infra imports) ---
export interface RecipientLike { readonly partyId: string; readonly name: string; readonly mailingAddress: string | null; readonly email?: string; }
export interface NoticeSender {
  render(input: { templateCode: string; loanId?: string; recipients: readonly RecipientLike[]; payload: Record<string, unknown>; asOf: PlainDate }): { readonly id: string; readonly status: string; readonly heldReason?: string };
  send(id: string): Promise<{ readonly id: string; readonly status: string }>;
}
export interface EscalationSink { open(input: { kind: "sev1" | "sev2" | "sev3" | "sev4" | "officer" | "human_portal_task" | "human_agent" | "attorney"; loanId?: string; severity?: string; payload?: Record<string, unknown> }, by: Actor): { readonly id: string }; }
/** Inbound `insurance-tracking/lpi` message (src/infra/integrations/property.ts PolicyMessage plus the spec's `expiration_alert`). */
export type VendorMessageType = "policy_snapshot" | "eoi" | "cancellation" | "non_renewal" | "reinstatement" | "rating_update" | "expiration_alert";
export interface VendorPolicyMessage { readonly vendorLoanId: string; readonly policyId: string; readonly type: VendorMessageType; readonly vendorSequence: number; readonly carrier: string; readonly coverageCents: bigint; readonly deductibleCents: bigint; readonly effectiveOn: string; readonly expiresOn: string; readonly documentSha256?: string; readonly cancelledOn?: string; }
export interface VendorInbox { inbound(since: string): Promise<readonly VendorPolicyMessage[]>; }

export interface HazardTrackingDeps {
  readonly events: EventStore; readonly clock: { now(): string };
  readonly notices?: NoticeSender; readonly escalations?: EscalationSink;
  readonly servicerCalendar?: Calendar; readonly fannieCalendar?: Calendar;
  /** 9.1-T6: the annual-reminder feature flag is on before the LL-2026-03 mandatory date (2027-01-01). */
  readonly annual_reminder_enabled?: boolean;
  /** Servicer contact block merged into every 9.1 notice payload (phone, address, insurance e-mail, Fannie Mae consumer URL). */
  readonly notice_defaults?: Record<string, unknown>;
}

export interface IngestResult { readonly accepted: boolean; readonly duplicate: boolean; readonly reason: string | null; readonly key: string; readonly events: readonly DomainEvent[]; readonly evidence?: EvidenceRecord; readonly policy?: TrackedPolicy; }
export interface EvaluationResult { readonly status: TrackedPolicyStatus; readonly adequacy: AdequacyResult | null; readonly deficiencies: readonly Deficiency[]; readonly deficiency_id: string | null; readonly notice_due: PlainDate | null; readonly task: ReturnType<typeof coverageDecreaseFollowUp>; readonly change_request: ReturnType<typeof mortgageeChangeRequest>; readonly decision: DecisionRecord; readonly reason: string | null; readonly event: DomainEvent | null; }
export interface SweepResult { readonly today: PlainDate; readonly expiring: string[]; readonly eoi_requested: string[]; readonly expired: string[]; readonly lapses: { policy_id: string; loan_id: string; outcome: LapseDetectedOutcome; case_opened: boolean }[]; readonly reminders_sent: string[]; readonly reminders_due: string[]; readonly reverification_due: string[]; readonly vendor_feed: "ok" | "sev2" | "unknown"; readonly escalations: string[]; }

const TERMINAL: ReadonlySet<TrackedPolicyStatus> = new Set(["replaced", "superseded"]);
const DEFAULT_DEFICIENCY_TEXT: Record<Deficiency, string> = {
  coverage_basis: "the dwelling is not insured on a replacement cost basis", coverage_form: "the policy is not written on a Special (all-risk) form and omits a required peril",
  deductible_excess: "the deductible exceeds 5% of the dwelling coverage", carrier_rating: "the insurer does not carry an acceptable financial rating", mortgagee_clause: "the mortgagee clause does not name the lender, its successors and/or assigns, c/o Supermortgage (MERS may not be named)",
  named_insured: "the named insureds do not match the title holders", coverage_decrease_unconfirmed: "the coverage amount decreased and the loss-settlement basis is not stated", wind_gap: "windstorm is excluded without a separate wind policy",
  master_lapse: "the project master policy's per-unit deductible exceeds $50,000", unit_policy_missing: "no unit-owner (HO-6) policy covers the interior / the master policy's per-unit deductible",
};
const insuranceTypeOf = (k: PolicyKind): InsuranceType => (k === "wind" || k === "lpi_wind" ? "wind" : k === "flood" || k === "rcbap" || k === "lpi_flood" ? "flood" : "hazard");
const isoDate = (s: string, what: string): PlainDate => { if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new RangeError(`${what} must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(s)}`); return plainDate(s); };
const noonEt = (d: PlainDate): string => `${d}T16:00:00.000Z`;

/** The 9.1 tracker: policy / evidence / deficiency / request registers and every transition of the state machine. */
export class HazardTracking {
  private readonly deps: HazardTrackingDeps;
  readonly policies = new Map<string, TrackedPolicy>();
  readonly policyVersions: TrackedPolicy[] = [];
  readonly loans = new Map<string, TrackedLoan>();
  readonly evidence = new Map<string, EvidenceRecord>();
  readonly deficiencies = new Map<string, DeficiencyRecord>();
  readonly fnmaRequests = new Map<string, FnmaRequestRecord>();
  readonly decisions: DecisionRecord[] = [];
  private readonly vendorKeys = new Set<string>();
  private readonly vendorLoanIds = new Map<string, string>();
  private feedLastMessageOn: PlainDate | null = null;
  private feedEscalatedFor: PlainDate | null = null;
  private seq = 0;
  constructor(deps: HazardTrackingDeps) { this.deps = deps; }

  today(): PlainDate { return wallClock(Date.parse(this.deps.clock.now()), ET).date; }
  private nextId(prefix: string): string { this.seq += 1; return `${prefix}-${this.seq}`; }
  private append(type: string, loanId: string | null, payload: Record<string, unknown>, actor: Actor = INSURANCE_AGENT, occurredAt?: string): DomainEvent {
    return this.deps.events.append({ type, ...(loanId ? { loanId } : {}), actor, payload, ...(occurredAt ? { occurredAt } : {}) });
  }
  private putPolicy(next: TrackedPolicy): TrackedPolicy { const rec = { ...next, version: (this.policies.get(next.policy_id)?.version ?? 0) + 1 }; this.policies.set(rec.policy_id, rec); this.policyVersions.push(rec); return rec; }
  private requireLoan(loanId: string): TrackedLoan { const l = this.loans.get(loanId); if (!l) throw new RangeError(`loan ${loanId} is not tracked (board it first)`); return l; }
  private recordDecision(d: Omit<DecisionRecord, "decision_id" | "at" | "rule_set" | "model_version">): DecisionRecord {
    const rec: DecisionRecord = { decision_id: this.nextId("dec"), at: this.deps.clock.now(), rule_set: RULE_SET_9_1, model_version: EXTRACTION_MODEL_VERSION, ...d };
    this.decisions.push(rec); return rec;
  }
  /** The loan's current (non-terminal) policy of a kind, latest expiration first. */
  activePolicy(loanId: string, kind: PolicyKind = "hazard"): TrackedPolicy | undefined {
    return [...this.policies.values()].filter((p) => p.loan_id === loanId && p.policy_kind === kind && !TERMINAL.has(p.status)).sort((a, b) => (a.expiration_date < b.expiration_date ? 1 : -1))[0];
  }

  // ---- boarding ------------------------------------------------------------------------------------------------
  /** `loan.boarded` (1.1) → the loan is tracked; the vendor's loan id is mapped for the feed. */
  boardLoan(loan: TrackedLoan): TrackedLoan {
    if (!loan.loan_id) throw new RangeError("loan_id is required");
    this.loans.set(loan.loan_id, loan);
    if (loan.vendor_loan_id) this.vendorLoanIds.set(loan.vendor_loan_id, loan.loan_id);
    return loan;
  }
  /** A policy row from the boarding file / vendor snapshot / any channel opens a `pending_verification` review (`insurance.policy.received`). */
  receivePolicy(p: { policy_id: string; loan_id: string; policy_kind?: PolicyKind; effective_date: PlainDate; expiration_date: PlainDate; coverage_dwelling_cents: Cents; source: EvidenceChannel; last_known_coverage_cents?: Cents | null }, actor: Actor = INSURANCE_AGENT): TrackedPolicy {
    this.requireLoan(p.loan_id);
    if (p.coverage_dwelling_cents <= 0n) throw new RangeError("coverage_dwelling_cents must be positive");
    if (!(p.expiration_date > p.effective_date)) throw new RangeError(`expiration_date ${p.expiration_date} must follow effective_date ${p.effective_date}`);
    const prior = this.policies.get(p.policy_id);
    const rec = this.putPolicy({
      policy_id: p.policy_id, loan_id: p.loan_id, policy_kind: p.policy_kind ?? prior?.policy_kind ?? "hazard", effective_date: p.effective_date, expiration_date: p.expiration_date,
      coverage_dwelling_cents: p.coverage_dwelling_cents, last_known_coverage_cents: p.last_known_coverage_cents ?? prior?.last_known_coverage_cents ?? null,
      status: prior?.status ?? "pending_verification", verified_at: prior?.verified_at ?? null, source: p.source, version: 0, cancellation_effective: prior?.cancellation_effective ?? null,
      renewal_evidence_on: prior?.renewal_evidence_on ?? null, expiring_flagged_on: prior?.expiring_flagged_on ?? null, eoi_requested_on: prior?.eoi_requested_on ?? null, expired_flagged_on: prior?.expired_flagged_on ?? null, lapse_detected_on: prior?.lapse_detected_on ?? null, reverification_flagged_on: null,
    });
    this.append("insurance.policy.received", p.loan_id, { policy_id: rec.policy_id, policy_kind: rec.policy_kind, source: p.source, effective_date: rec.effective_date, expiration_date: rec.expiration_date, coverage_dwelling_cents: rec.coverage_dwelling_cents, status: rec.status }, actor);
    return rec;
  }

  // ---- evidence (rule 4) ---------------------------------------------------------------------------------------
  /** Documents from any channel → `insurance_evidence` intake. Below 0.90 on a critical field the record waits for vendor/carrier/agent confirmation (T4). */
  receiveEvidence(e: { evidence_id: string; loan_id: string; policy_id?: string | null; channel: EvidenceChannel; document_sha256?: string | null; extraction?: { confidence: ExtractionConfidence; model_version?: string } | null; kind?: EvidenceKind }, actor: Actor = INSURANCE_AGENT): EvidenceRecord {
    this.requireLoan(e.loan_id);
    if (!e.evidence_id) throw new RangeError("evidence_id is required");
    if (this.evidence.has(e.evidence_id)) throw new RangeError(`evidence ${e.evidence_id} already received`);
    const required = e.extraction ? confirmationRequired(e.extraction.confidence) : [...CRITICAL_FIELDS];
    const prior = this.activePolicy(e.loan_id);
    const kind: EvidenceKind = e.kind ?? (prior && prior.verified_at ? "renewal" : "new");   // renewal = a term follows one the servicer already verified
    const rec: EvidenceRecord = { evidence_id: e.evidence_id, loan_id: e.loan_id, policy_id: e.policy_id ?? null, kind, channel: e.channel, received_on: this.today(), document_sha256: e.document_sha256 ?? null,
      extraction_model_version: e.extraction ? e.extraction.model_version ?? EXTRACTION_MODEL_VERSION : null, confidence: e.extraction?.confidence ?? null, confirmation_required: required,
      verification_status: required.length ? "needs_carrier_confirmation" : "extracted", confirmed_via: null, reject_reason: null };
    this.evidence.set(rec.evidence_id, rec);
    this.append("insurance.evidence.received", e.loan_id, { evidence_id: rec.evidence_id, kind, channel: e.channel, policy_id: rec.policy_id, document_sha256: rec.document_sha256, verification_status: rec.verification_status, confirmation_required: required, extraction_model_version: rec.extraction_model_version }, actor);
    return rec;
  }
  /** Vendor / carrier API / agent call / borrower-portal link confirms the evidence → `insurance.evidence.confirmed{kind}` (renewal evidence closes INS_EXPIRATION_WATCH_60). */
  confirmEvidence(c: { evidence_id: string; confirmed_via: ConfirmedVia }, actor: Actor = INSURANCE_AGENT): EvidenceRecord {
    const cur = this.evidence.get(c.evidence_id); if (!cur) throw new RangeError(`no evidence ${c.evidence_id}`);
    if (cur.verification_status === "rejected") throw new RangeError(`evidence ${c.evidence_id} was rejected (${cur.reject_reason}); a new evidence record is required`);
    const rec: EvidenceRecord = { ...cur, verification_status: "confirmed", confirmed_via: c.confirmed_via };
    this.evidence.set(rec.evidence_id, rec);
    const policy = (rec.policy_id ? this.policies.get(rec.policy_id) : undefined) ?? this.activePolicy(rec.loan_id);
    if (rec.kind === "renewal" && policy) this.putPolicy({ ...policy, renewal_evidence_on: this.today() });
    this.append("insurance.evidence.confirmed", rec.loan_id, { evidence_id: rec.evidence_id, kind: rec.kind, confirmed_via: c.confirmed_via, policy_id: policy?.policy_id ?? null }, actor);
    return rec;
  }
  /** Rejection only for the two comment 37(c)(1)(iii)-2 reasons, recorded with the reason. */
  rejectEvidence(r: { evidence_id: string; reject_reason: RejectReason }, actor: Actor = INSURANCE_AGENT): EvidenceRecord {
    const cur = this.evidence.get(r.evidence_id); if (!cur) throw new RangeError(`no evidence ${r.evidence_id}`);
    if (r.reject_reason !== "not_confirmed_by_carrier_or_agent" && r.reject_reason !== "terms_noncompliant") throw new RangeError(`evidence may be rejected only when neither the insurer nor the agent confirms it or its terms do not comply (comment 37(c)(1)(iii)-2); got ${String(r.reject_reason)}`);
    const rec: EvidenceRecord = { ...cur, verification_status: "rejected", reject_reason: r.reject_reason, confirmed_via: null };
    this.evidence.set(rec.evidence_id, rec);
    const policy = (rec.policy_id ? this.policies.get(rec.policy_id) : undefined) ?? this.activePolicy(rec.loan_id);
    if (rec.kind === "renewal" && policy && policy.renewal_evidence_on) this.putPolicy({ ...policy, renewal_evidence_on: null });
    this.append("insurance.evidence.rejected", rec.loan_id, { evidence_id: rec.evidence_id, reject_reason: r.reject_reason, policy_id: policy?.policy_id ?? null }, actor);
    return rec;
  }

  // ---- adequacy → verified | deficient (rules 2–3) ------------------------------------------------------------
  /**
   * Rule 2 adequacy on the extracted policy. `verified` only with a confirmed evidence record (guardrail);
   * FAIL → `insurance_deficiencies` row + `insurance.deficiency.detected` (the 5-BD notice SLA); renewal
   * evidence silent on the loss-settlement basis takes the B-2-02 shortcut against `last_known_coverage_cents`.
   */
  evaluatePolicy(e: { policy_id: string; loan_id: string; evidence_id: string; policy: HazardPolicy; basis_stated?: boolean; effective_date?: PlainDate; expiration_date?: PlainDate; policy_kind?: PolicyKind; title_holders?: readonly string[] }, actor: Actor = INSURANCE_AGENT): EvaluationResult {
    const loan = this.requireLoan(e.loan_id);
    const ev = this.evidence.get(e.evidence_id); if (!ev) throw new RangeError(`no evidence ${e.evidence_id}`);
    const holders = e.title_holders ?? loan.title_holders;
    const today = this.today();
    let rec = this.policies.get(e.policy_id);
    if (!rec) {
      if (!e.effective_date || !e.expiration_date) throw new RangeError(`policy ${e.policy_id} is new: effective_date and expiration_date are required`);
      rec = this.receivePolicy({ policy_id: e.policy_id, loan_id: e.loan_id, ...(e.policy_kind ? { policy_kind: e.policy_kind } : {}), effective_date: e.effective_date, expiration_date: e.expiration_date, coverage_dwelling_cents: e.policy.coverage_dwelling_cents, source: ev.channel, last_known_coverage_cents: this.activePolicy(e.loan_id)?.last_known_coverage_cents ?? null }, actor);
    } else if (e.expiration_date && e.expiration_date > rec.expiration_date) {
      rec = this.putPolicy({ ...rec, effective_date: e.effective_date ?? rec.expiration_date, expiration_date: e.expiration_date, coverage_dwelling_cents: e.policy.coverage_dwelling_cents });
    }
    const confirmed = ev.verification_status === "confirmed";
    const priorTerm = rec.verified_at !== null;
    // Rule 3 — the renewal shortcut runs before the full test when the evidence is silent on the basis.
    if (e.basis_stated === false) {
      const result = renewalShortcut(e.policy.coverage_dwelling_cents, rec.last_known_coverage_cents, false);
      if (result === "coverage_decrease_unconfirmed") {
        const task = coverageDecreaseFollowUp(result)!;
        const decision = this.recordDecision({ loan_id: e.loan_id, policy_id: rec.policy_id, evidence_id: ev.evidence_id, evidence_hash: ev.document_sha256, extraction_confidence: ev.confidence, adequacy: null,
          last_known_comparison: { coverage_cents: e.policy.coverage_dwelling_cents, last_known_cents: rec.last_known_coverage_cents, result }, steps: task.steps, notices: [],
          rationale: `renewal evidence silent on the loss-settlement basis; coverage ${e.policy.coverage_dwelling_cents} vs last known ${rec.last_known_coverage_cents ?? "unknown"} → additional steps (B-2-02)`, outcome: "coverage_decrease_unconfirmed" });
        const d = this.openDeficiency({ loan_id: e.loan_id, policy_id: rec.policy_id, evidence_id: ev.evidence_id, kinds: ["coverage_decrease_unconfirmed"], decision, task_steps: task.steps }, actor);
        this.putPolicy({ ...rec, status: "deficient" });
        return { status: "deficient", adequacy: null, deficiencies: ["coverage_decrease_unconfirmed"], deficiency_id: d.rec.deficiency_id, notice_due: d.rec.notice_due, task, change_request: null, decision, reason: "coverage decrease unconfirmed (B-2-02)", event: d.event };
      }
    }
    const v = verifyPolicy(e.policy, holders, confirmed);
    const comparison = { coverage_cents: e.policy.coverage_dwelling_cents, last_known_cents: rec.last_known_coverage_cents, result: renewalShortcut(e.policy.coverage_dwelling_cents, rec.last_known_coverage_cents, e.basis_stated ?? true) };
    if (v.status === "verified") {
      const term = priorTerm ? "renewal" : "initial";
      rec = this.putPolicy({ ...rec, status: "verified", verified_at: today, last_known_coverage_cents: v.last_known_coverage_cents, expiring_flagged_on: null, eoi_requested_on: null, expired_flagged_on: null, lapse_detected_on: null, reverification_flagged_on: null, renewal_evidence_on: null, cancellation_effective: null });
      for (const other of this.policies.values()) if (other.loan_id === rec.loan_id && other.policy_kind === rec.policy_kind && other.policy_id !== rec.policy_id && !TERMINAL.has(other.status)) { this.putPolicy({ ...other, status: "replaced" }); this.append("insurance.policy.replaced", rec.loan_id, { policy_id: other.policy_id, replaced_by: rec.policy_id }, actor); }
      const decision = this.recordDecision({ loan_id: e.loan_id, policy_id: rec.policy_id, evidence_id: ev.evidence_id, evidence_hash: ev.document_sha256, extraction_confidence: ev.confidence, adequacy: v.adequacy, last_known_comparison: comparison, steps: [], notices: [], rationale: `adequacy PASS (${RULE_SET_9_1}); evidence confirmed via ${ev.confirmed_via}`, outcome: "verified" });
      const event = this.append("insurance.policy.verified", e.loan_id, { policy_id: rec.policy_id, policy_kind: rec.policy_kind, evidence_id: ev.evidence_id, verified_at: today, effective_date: rec.effective_date, expiration_date: rec.expiration_date, term, coverage_dwelling_cents: rec.coverage_dwelling_cents, last_known_coverage_cents: rec.last_known_coverage_cents, deductible_pct: v.adequacy.deductible_pct, rule_set: RULE_SET_9_1, decision_id: decision.decision_id }, actor);
      return { status: "verified", adequacy: v.adequacy, deficiencies: [], deficiency_id: null, notice_due: null, task: null, change_request: null, decision, reason: null, event };
    }
    if (v.status === "deficient") {
      const changeRequest = mortgageeChangeRequest(e.policy);
      const decision = this.recordDecision({ loan_id: e.loan_id, policy_id: rec.policy_id, evidence_id: ev.evidence_id, evidence_hash: ev.document_sha256, extraction_confidence: ev.confidence, adequacy: v.adequacy, last_known_comparison: comparison, steps: changeRequest ? [`change request to the carrier/agent: ${changeRequest.clause}${changeRequest.remove_mers ? " (remove MERS)" : ""}`] : [], notices: [], rationale: `adequacy FAIL: ${v.adequacy.deficiencies.join(", ")}`, outcome: "deficient" });
      const d = this.openDeficiency({ loan_id: e.loan_id, policy_id: rec.policy_id, evidence_id: ev.evidence_id, kinds: v.adequacy.deficiencies, decision, ...(changeRequest ? { change_request: changeRequest } : {}) }, actor);
      this.putPolicy({ ...rec, status: "deficient" });
      return { status: "deficient", adequacy: v.adequacy, deficiencies: v.adequacy.deficiencies, deficiency_id: d.rec.deficiency_id, notice_due: d.rec.notice_due, task: null, change_request: changeRequest, decision, reason: v.reason, event: d.event };
    }
    const decision = this.recordDecision({ loan_id: e.loan_id, policy_id: rec.policy_id, evidence_id: ev.evidence_id, evidence_hash: ev.document_sha256, extraction_confidence: ev.confidence, adequacy: v.adequacy, last_known_comparison: comparison, steps: ev.confirmation_required.map((f) => `carrier/agent confirmation of ${f} (extraction confidence < 0.90)`), notices: [], rationale: "adequacy PASS but the evidence record is not confirmed — the agent cannot mark the policy verified (9.1 guardrail)", outcome: "pending_verification" });
    this.putPolicy({ ...rec, status: rec.status === "verified" ? "verified" : "pending_verification" });
    return { status: "pending_verification", adequacy: v.adequacy, deficiencies: [], deficiency_id: null, notice_due: null, task: null, change_request: null, decision, reason: v.reason, event: null };
  }
  private openDeficiency(d: { loan_id: string; policy_id: string | null; evidence_id: string | null; kinds: readonly Deficiency[]; decision: DecisionRecord; task_steps?: readonly string[]; change_request?: NonNullable<ReturnType<typeof mortgageeChangeRequest>> }, actor: Actor): { rec: DeficiencyRecord; event: DomainEvent } {
    const now = this.deps.clock.now(); const today = this.today();
    const adequacy = this.decisions.find((x) => x.decision_id === d.decision.decision_id)?.adequacy ?? null;
    const rec: DeficiencyRecord = { deficiency_id: this.nextId("def"), loan_id: d.loan_id, policy_id: d.policy_id, kinds: d.kinds, detected_at: now, detected_on: today, notice_due: deficiencyNoticeDue(today, this.deps.servicerCalendar ?? servicer),
      regx_reasonable_basis: adequacy?.lpi_curable ?? false, status: "open", notice_id: null, notice_template: null, decision_id: d.decision.decision_id };
    this.deficiencies.set(rec.deficiency_id, rec);
    const event = this.append("insurance.deficiency.detected", d.loan_id, { deficiency_id: rec.deficiency_id, policy_id: d.policy_id, evidence_id: d.evidence_id, deficiencies: [...d.kinds], detected_at: now, notice_due: rec.notice_due, notice_template: "INS_DEFICIENCY_NOTICE", regx_reasonable_basis: rec.regx_reasonable_basis, decision_id: d.decision.decision_id,
      ...(d.task_steps ? { additional_steps: [...d.task_steps], task: "carrier_confirmation" } : {}), ...(d.change_request ? { change_request: { to: d.change_request.to, clause: d.change_request.clause, remove_mers: d.change_request.remove_mers } } : {}) }, actor);
    return { rec, event };
  }
  /** Cure: evidence received / LPI placed / waived by policy — `insurance.deficiency.cured`. */
  cureDeficiency(c: { deficiency_id: string; resolution: "evidence_received" | "lpi_placed" | "waived_by_policy" | "paid_off" | "transferred" | "reo" }, actor: Actor = INSURANCE_AGENT): DeficiencyRecord {
    const cur = this.deficiencies.get(c.deficiency_id); if (!cur) throw new RangeError(`no deficiency ${c.deficiency_id}`);
    const rec: DeficiencyRecord = { ...cur, status: c.resolution === "lpi_placed" ? "escalated_to_fpi" : c.resolution === "waived_by_policy" ? "waived" : "cured" };
    this.deficiencies.set(rec.deficiency_id, rec);
    this.append("insurance.deficiency.cured", rec.loan_id, { deficiency_id: rec.deficiency_id, resolution: c.resolution, resolved_at: this.deps.clock.now() }, actor);
    return rec;
  }

  // ---- B-2-03 master policy (rule 1, T7) ---------------------------------------------------------------------
  /** Annual confirmation that the project master policy meets B-2-03 → `insurance.master_policy.verified` (FNMA_B203_MASTER_POLICY_ANNUAL_VERIFY_365) or the master/unit deficiencies. */
  verifyMasterPolicy(m: { project_id: string; loan_id: string; per_unit_deductible_cents: Cents | null; has_unit_policy: boolean; interior_covered: boolean; evidence_id?: string | null }, actor: Actor = INSURANCE_AGENT): { status: "verified" | "deficient"; deficiencies: readonly Deficiency[]; deficiency_id: string | null; verified_at: PlainDate | null; event: DomainEvent } {
    this.requireLoan(m.loan_id);
    const kinds = masterPolicyDeficiencies(m.per_unit_deductible_cents, m.has_unit_policy, m.interior_covered);
    const today = this.today();
    if (kinds.length === 0) {
      const decision = this.recordDecision({ loan_id: m.loan_id, policy_id: m.project_id, evidence_id: m.evidence_id ?? null, evidence_hash: null, extraction_confidence: null, adequacy: null, last_known_comparison: null, steps: [], notices: [], rationale: `master policy meets B-2-03 (per-unit deductible ${m.per_unit_deductible_cents ?? "none"} ≤ $50,000; interior ${m.interior_covered ? "covered" : "covered by unit policy"})`, outcome: "master_verified" });
      const event = this.append("insurance.master_policy.verified", m.loan_id, { project_id: m.project_id, verified_at: today, per_unit_deductible_cents: m.per_unit_deductible_cents, has_unit_policy: m.has_unit_policy, rule_set: RULE_SET_9_1, decision_id: decision.decision_id }, actor);
      return { status: "verified", deficiencies: [], deficiency_id: null, verified_at: today, event };
    }
    const decision = this.recordDecision({ loan_id: m.loan_id, policy_id: m.project_id, evidence_id: m.evidence_id ?? null, evidence_hash: null, extraction_confidence: null, adequacy: null, last_known_comparison: null, steps: [], notices: [], rationale: `master policy fails B-2-03/B7-3-04: ${kinds.join(", ")}`, outcome: "deficient" });
    const d = this.openDeficiency({ loan_id: m.loan_id, policy_id: m.project_id, evidence_id: m.evidence_id ?? null, kinds, decision }, actor);
    return { status: "deficient", deficiencies: kinds, deficiency_id: d.rec.deficiency_id, verified_at: null, event: d.event };
  }

  // ---- notices -------------------------------------------------------------------------------------------------
  private notices(): NoticeSender { const n = this.deps.notices; if (!n) throw new RangeError("the Notice Registry is not wired into this tracker"); return n; }
  /** B-2-02 "notify the borrower of the insufficiency": INS_DEFICIENCY_NOTICE (INS_DEFICIENCY_NOTICE_BK under Section 14) through the Notice Registry; its `notice.sent{template}` closes FNMA_B202_INSUFFICIENCY_NOTICE_5BD. */
  async sendDeficiencyNotice(s: { deficiency_id: string; recipients?: readonly RecipientLike[]; payload: Record<string, unknown>; as_of?: PlainDate }, actor: Actor = INSURANCE_AGENT): Promise<{ sent: boolean; notice_id: string | null; template: "INS_DEFICIENCY_NOTICE" | "INS_DEFICIENCY_NOTICE_BK"; held: string | null; sent_on: PlainDate | null; on_time: boolean | null }> {
    const cur = this.deficiencies.get(s.deficiency_id); if (!cur) throw new RangeError(`no deficiency ${s.deficiency_id}`);
    const loan = this.requireLoan(cur.loan_id);
    const template = loan.bankruptcy_active ? "INS_DEFICIENCY_NOTICE_BK" : "INS_DEFICIENCY_NOTICE";
    const recipients = s.recipients ?? loan.recipients ?? [];
    if (!recipients.length) throw new RangeError("the deficiency notice needs at least one recipient");
    const asOf = s.as_of ?? this.today();
    const payload = { ...(this.deps.notice_defaults ?? {}), deficiency_text: cur.kinds.map((k) => DEFAULT_DEFICIENCY_TEXT[k]).join("; "), notice_date: asOf, ...s.payload };
    const n = this.notices().render({ templateCode: template, loanId: cur.loan_id, recipients, payload, asOf });
    if (n.status === "held") return { sent: false, notice_id: n.id, template, held: n.heldReason ?? "held", sent_on: null, on_time: null };
    await this.notices().send(n.id);
    const sentOn = this.today();
    this.deficiencies.set(cur.deficiency_id, { ...cur, status: "notified", notice_id: n.id, notice_template: template });
    this.append("insurance.deficiency.notified", cur.loan_id, { deficiency_id: cur.deficiency_id, notice_id: n.id, template, sent_on: sentOn, notice_due: cur.notice_due, on_time: sentOn <= cur.notice_due }, actor);
    return { sent: true, notice_id: n.id, template, held: null, sent_on: sentOn, on_time: sentOn <= cur.notice_due };
  }
  /** Rule 7 / B-2-01: one INS_ANNUAL_REMINDER per loan per 12 months; `notice.sent{template=INS_ANNUAL_REMINDER}` resets FNMA_B201_ANNUAL_INSURANCE_REMINDER_365. */
  async sendAnnualReminder(s: { loan_id: string; recipients?: readonly RecipientLike[]; payload?: Record<string, unknown>; as_of?: PlainDate }, actor: Actor = INSURANCE_AGENT): Promise<{ sent: boolean; notice_id: string | null; held: string | null; sent_on: PlainDate | null; next_due: PlainDate | null; mandatory_from: PlainDate }> {
    const loan = this.requireLoan(s.loan_id);
    const today = s.as_of ?? this.today();
    if (this.deps.annual_reminder_enabled === false) throw new RangeError("the annual insurance reminder feature flag is off");
    if (!annualReminderDue(loan.last_reminder_sent_on, today)) throw new RangeError(`9.1 rule 7: one reminder per loan per 12 months — last sent ${loan.last_reminder_sent_on}, next due ${annualReminderNextDue(loan.last_reminder_sent_on!)}`);
    const recipients = s.recipients ?? loan.recipients ?? [];
    if (!recipients.length) throw new RangeError("the annual reminder needs at least one recipient");
    // A never-reminded loan has no prior send to measure from; the registry's one-per-12-months rule is asserted as satisfied (365).
    const payload = { ...(this.deps.notice_defaults ?? {}), days_since_last: loan.last_reminder_sent_on ? daysBetween(loan.last_reminder_sent_on, today) : 365, notice_date: today, ...(s.payload ?? {}) };
    const n = this.notices().render({ templateCode: "INS_ANNUAL_REMINDER", loanId: loan.loan_id, recipients, payload, asOf: today });
    if (n.status === "held") return { sent: false, notice_id: n.id, held: n.heldReason ?? "held", sent_on: null, next_due: null, mandatory_from: ANNUAL_REMINDER_MANDATORY_FROM };
    await this.notices().send(n.id);
    const next = annualReminderNextDue(today);
    this.loans.set(loan.loan_id, { ...loan, last_reminder_sent_on: today });
    this.append("insurance.reminder.sent", loan.loan_id, { notice_id: n.id, template: "INS_ANNUAL_REMINDER", sent_on: today, next_due: next, mandatory_from: ANNUAL_REMINDER_MANDATORY_FROM }, actor);
    return { sent: true, notice_id: n.id, held: null, sent_on: today, next_due: next, mandatory_from: ANNUAL_REMINDER_MANDATORY_FROM };
  }
  /** −30 days: the INS_EOI_REQUEST courtesy request (not a §1024.37 notice). */
  async requestEoi(r: { policy_id: string; recipients?: readonly RecipientLike[]; payload?: Record<string, unknown> }, actor: Actor = INSURANCE_AGENT): Promise<{ notice_id: string | null; policy_id: string; expiration_date: PlainDate }> {
    const rec = this.policies.get(r.policy_id); if (!rec) throw new RangeError(`no policy ${r.policy_id}`);
    const loan = this.requireLoan(rec.loan_id);
    const today = this.today();
    let noticeId: string | null = null;
    const recipients = r.recipients ?? loan.recipients ?? [];
    if (this.deps.notices && recipients.length) {
      const n = this.deps.notices.render({ templateCode: "INS_EOI_REQUEST", loanId: rec.loan_id, recipients, payload: { ...(this.deps.notice_defaults ?? {}), policy_number: rec.policy_id, expiration_date: rec.expiration_date, notice_date: today, ...(r.payload ?? {}) }, asOf: today });
      if (n.status !== "held") { await this.deps.notices.send(n.id); noticeId = n.id; }
    }
    this.putPolicy({ ...rec, eoi_requested_on: today });
    this.append("insurance.eoi.requested", rec.loan_id, { policy_id: rec.policy_id, expiration_date: rec.expiration_date, template: "INS_EOI_REQUEST", notice_id: noticeId }, actor);
    return { notice_id: noticeId, policy_id: rec.policy_id, expiration_date: rec.expiration_date };
  }

  // ---- Fannie Mae documentation requests (B-6-01, B-3-01) -------------------------------------------------------
  /** `fnma.request.received{kind}` on the platform's Fannie Mae request aggregate: LPI documentation → 30 calendar days (B-6-01); flood evidence → 10 Fannie business days (B-3-01). */
  receiveFnmaRequest(r: { request_id: string; kind: FnmaRequestKind; loan_id?: string | null; received_on?: PlainDate }, actor: Actor = { kind: "external", id: "fnma" }): { request: FnmaRequestRecord; event: DomainEvent; escalation_id: string | null } {
    if (!r.request_id) throw new RangeError("request_id is required");
    if (r.kind !== "lpi_documentation" && r.kind !== "flood_evidence") throw new RangeError(`kind must be lpi_documentation or flood_evidence, got ${String(r.kind)}`);
    if (this.fnmaRequests.has(r.request_id)) throw new RangeError(`Fannie Mae request ${r.request_id} already received`);
    const receivedOn = r.received_on ?? this.today();
    const due = r.kind === "lpi_documentation" ? addDays(receivedOn, 30) : addBusinessDays(receivedOn, 10, this.deps.fannieCalendar ?? fannieEt);
    const timer = r.kind === "lpi_documentation" ? "FNMA_B601_LPI_DOC_REQUEST_30" : "FNMA_B301_FLOOD_EVIDENCE_TO_FNMA_10BD";
    const request: FnmaRequestRecord = { request_id: r.request_id, loan_id: r.loan_id ?? null, kind: r.kind, received_on: receivedOn, due, timer, responded_on: null, document_ids: [] };
    this.fnmaRequests.set(request.request_id, request);
    const event = this.append("fnma.request.received", request.loan_id, { request_id: request.request_id, kind: request.kind, received_at: receivedOn, due_at: due, timer, requester: "fannie_mae" }, actor, r.received_on ? noonEt(r.received_on) : undefined);
    // Spec escalations: Fannie Mae documentation requests go to the `officer`; the upload itself is the `fnma_portal_operator`'s work item.
    const esc = this.deps.escalations?.open({ kind: "human_portal_task", ...(request.loan_id ? { loanId: request.loan_id } : {}), payload: { request_id: request.request_id, kind: request.kind, due, timer, reviewer: "officer" } }, INSURANCE_AGENT) ?? null;
    return { request, event, escalation_id: esc?.id ?? null };
  }
  /** The documents go to Fannie Mae (e-mail/upload by the `fnma_portal_operator`) → `fnma.request.responded{kind}` closes the row. */
  respondToFnmaRequest(r: { request_id: string; document_ids: readonly string[]; sent_on?: PlainDate; sent_by?: string }, actor: Actor = { kind: "human", id: "fnma_portal_operator", role: "fnma_portal_operator" }): { request: FnmaRequestRecord; event: DomainEvent; on_time: boolean } {
    const cur = this.fnmaRequests.get(r.request_id); if (!cur) throw new RangeError(`no Fannie Mae request ${r.request_id}`);
    if (cur.responded_on) throw new RangeError(`Fannie Mae request ${r.request_id} was answered on ${cur.responded_on}`);
    if (!r.document_ids.length) throw new RangeError("a response to a Fannie Mae documentation request carries at least one document");
    const sentOn = r.sent_on ?? this.today();
    const request: FnmaRequestRecord = { ...cur, responded_on: sentOn, document_ids: [...r.document_ids] };
    this.fnmaRequests.set(request.request_id, request);
    const event = this.append("fnma.request.responded", request.loan_id, { request_id: request.request_id, kind: request.kind, document_ids: [...r.document_ids], sent_at: sentOn, sent_by: r.sent_by ?? actor.id, due_at: request.due, on_time: sentOn <= request.due }, actor, r.sent_on ? noonEt(r.sent_on) : undefined);
    return { request, event, on_time: sentOn <= request.due };
  }

  // ---- vendor feed (Integrations: `insurance-tracking/lpi` adapter) --------------------------------------------
  recordFeedHeartbeat(on: PlainDate = this.today()): void { this.feedLastMessageOn = on; }
  get feedLastMessage(): PlainDate | null { return this.feedLastMessageOn; }
  /** Drain the vendor inbox: every message is ingested once (idempotency key) and counts as a feed heartbeat. */
  async drainVendorInbox(port: VendorInbox, since: string, extraction?: (m: VendorPolicyMessage) => ExtractionConfidence | undefined): Promise<{ ingested: IngestResult[]; duplicates: number; rejected: IngestResult[] }> {
    const messages = await port.inbound(since);
    if (messages.length) this.recordFeedHeartbeat();
    const ingested: IngestResult[] = []; const rejected: IngestResult[] = []; let duplicates = 0;
    for (const m of messages) {
      const conf = extraction?.(m);
      const r = this.ingestVendorMessage(m, conf ? { confidence: conf } : undefined);
      if (r.duplicate) duplicates += 1; else if (r.accepted) ingested.push(r); else rejected.push(r);
    }
    return { ingested, duplicates, rejected };
  }
  /** One inbound vendor message: validated, deduplicated on (vendor loan id, policy id, message type, vendor sequence), then applied to the policy register. */
  ingestVendorMessage(m: VendorPolicyMessage, extraction?: { confidence: ExtractionConfidence; model_version?: string }): IngestResult {
    const key = `${m.vendorLoanId}|${m.policyId}|${m.type}|${m.vendorSequence}`;
    const reject = (reason: string): IngestResult => { this.append("insurance.vendor_message.rejected", this.vendorLoanIds.get(m.vendorLoanId) ?? null, { key, reason, message_type: m.type }, VENDOR_ADAPTER); return { accepted: false, duplicate: false, reason, key, events: [] }; };
    if (this.vendorKeys.has(key)) return { accepted: false, duplicate: true, reason: "duplicate (vendor loan id, policy id, message type, vendor sequence)", key, events: [] };
    const loanId = this.vendorLoanIds.get(m.vendorLoanId) ?? (this.loans.has(m.vendorLoanId) ? m.vendorLoanId : null);
    if (!loanId) return reject(`vendor loan id ${m.vendorLoanId} is not a tracked loan`);
    if (!Number.isInteger(m.vendorSequence) || m.vendorSequence < 0) return reject(`vendor sequence ${String(m.vendorSequence)} is not a non-negative integer`);
    let effective: PlainDate, expires: PlainDate;
    try { effective = isoDate(m.effectiveOn, "effectiveOn"); expires = isoDate(m.expiresOn, "expiresOn"); } catch (e) { return reject((e as Error).message); }
    if (!(expires > effective)) return reject(`expiresOn ${m.expiresOn} must follow effectiveOn ${m.effectiveOn}`);
    if ((m.type === "policy_snapshot" || m.type === "eoi") && m.coverageCents <= 0n) return reject("coverageCents must be positive");
    this.vendorKeys.add(key);
    const before = this.deps.events.all().length;
    const existing = this.policies.get(m.policyId);
    let evidence: EvidenceRecord | undefined; let policy: TrackedPolicy | undefined;
    switch (m.type) {
      case "policy_snapshot": policy = this.receivePolicy({ policy_id: m.policyId, loan_id: loanId, effective_date: effective, expiration_date: expires, coverage_dwelling_cents: m.coverageCents, source: "vendor_feed" }, VENDOR_ADAPTER); break;
      case "eoi": {
        const conf = extraction?.confidence;
        evidence = this.receiveEvidence({ evidence_id: `eoi:${key}`, loan_id: loanId, policy_id: m.policyId, channel: "vendor_feed", document_sha256: m.documentSha256 ?? null, extraction: conf ? { confidence: conf, ...(extraction?.model_version ? { model_version: extraction.model_version } : {}) } : null }, VENDOR_ADAPTER);
        // Rule 4: the vendor's EOI service is the confirming party when every critical field extracted at ≥ 0.90; otherwise the record waits for a carrier/agent confirmation.
        if (evidence.confirmation_required.length === 0) evidence = this.confirmEvidence({ evidence_id: evidence.evidence_id, confirmed_via: "vendor" }, VENDOR_ADAPTER);
        break;
      }
      case "cancellation": {
        if (!existing) return { ...reject(`cancellation for unknown policy ${m.policyId}`), key };
        const on = m.cancelledOn ? isoDate(m.cancelledOn, "cancelledOn") : this.today();
        policy = this.putPolicy({ ...existing, status: "cancelled", cancellation_effective: on });
        this.append("insurance.policy.cancelled", loanId, { policy_id: m.policyId, cancelled_on: on, carrier: m.carrier, source: "vendor_feed" }, VENDOR_ADAPTER);
        break;
      }
      case "non_renewal": {
        if (!existing) return { ...reject(`non-renewal for unknown policy ${m.policyId}`), key };
        policy = this.putPolicy({ ...existing, status: "nonrenewed", expiration_date: expires });
        this.append("insurance.policy.nonrenewed", loanId, { policy_id: m.policyId, expiration_date: expires, carrier: m.carrier, source: "vendor_feed" }, VENDOR_ADAPTER);
        break;
      }
      case "reinstatement": {
        if (!existing) return { ...reject(`reinstatement for unknown policy ${m.policyId}`), key };
        policy = this.putPolicy({ ...existing, status: existing.verified_at ? "verified" : "pending_verification", cancellation_effective: null, lapse_detected_on: null, expired_flagged_on: null, expiration_date: expires });
        this.append("insurance.policy.reinstated", loanId, { policy_id: m.policyId, expiration_date: expires, carrier: m.carrier, source: "vendor_feed" }, VENDOR_ADAPTER);
        break;
      }
      case "rating_update": {
        this.append("insurance.carrier_rating.updated", loanId, { policy_id: m.policyId, carrier: m.carrier, reverification_required: true }, VENDOR_ADAPTER);
        if (existing) policy = this.putPolicy({ ...existing, reverification_flagged_on: null });
        break;
      }
      case "expiration_alert": {
        if (!existing) return { ...reject(`expiration alert for unknown policy ${m.policyId}`), key };
        policy = existing.expiring_flagged_on ? existing : this.putPolicy({ ...existing, status: existing.status === "verified" ? "expiring" : existing.status, expiring_flagged_on: this.today() });
        if (!existing.expiring_flagged_on) this.append("insurance.policy.expiring", loanId, { policy_id: m.policyId, expiration_date: existing.expiration_date, days_to_expiration: daysBetween(this.today(), existing.expiration_date), source: "vendor_feed" }, VENDOR_ADAPTER);
        break;
      }
      default: return reject(`unknown message type ${String(m.type)}`);
    }
    return { accepted: true, duplicate: false, reason: null, key, events: this.deps.events.all().slice(before), ...(evidence ? { evidence } : {}), ...(policy ? { policy } : {}) };
  }

  // ---- daily insurance_sweep -----------------------------------------------------------------------------------
  /**
   * Expirations at −60 / −30 / 0 / +1, annual reminders, annual re-verification and the vendor heartbeat. The
   * lapse at +1 opens the 9.2 case with the escrow / §1024.17(k)(5) guard evaluated first (`insurance.lapse_detected`,
   * `fpi.case.opened{escrowed}` — the (k)(5) gate arms on the escrowed case).
   */
  async sweep(input: { today?: PlainDate } = {}): Promise<SweepResult> {
    const today = input.today ?? this.today();
    const out: SweepResult = { today, expiring: [], eoi_requested: [], expired: [], lapses: [], reminders_sent: [], reminders_due: [], reverification_due: [], vendor_feed: "unknown", escalations: [] };
    for (const start of [...this.policies.values()]) {
      let rec = this.policies.get(start.policy_id)!;
      if (TERMINAL.has(rec.status) || rec.lapse_detected_on) continue;
      const lapseOn = rec.status === "cancelled" && rec.cancellation_effective ? rec.cancellation_effective : lapseDetectedOn(rec.expiration_date, rec.renewal_evidence_on !== null);
      if (rec.status === "cancelled" && rec.cancellation_effective) {
        if (today >= rec.cancellation_effective) { out.lapses.push(this.detectLapse(rec, today)); }
        continue;
      }
      if (rec.renewal_evidence_on !== null || rec.status === "pending_verification" || rec.status === "deficient") { this.flagReverification(rec, today, out); continue; }
      const exp = rec.expiration_date;
      if (!rec.expiring_flagged_on && today >= addDays(exp, -60) && today < exp) {
        rec = this.putPolicy({ ...rec, status: rec.status === "verified" ? "expiring" : rec.status, expiring_flagged_on: today });
        this.append("insurance.policy.expiring", rec.loan_id, { policy_id: rec.policy_id, expiration_date: exp, days_to_expiration: daysBetween(today, exp) });
        out.expiring.push(rec.policy_id);
      }
      if (!rec.eoi_requested_on && today >= addDays(exp, -30) && today < exp) { await this.requestEoi({ policy_id: rec.policy_id }); rec = this.policies.get(rec.policy_id)!; out.eoi_requested.push(rec.policy_id); }
      if (!rec.expired_flagged_on && today >= exp) {
        // "expiration_date passes without evidence" → INS_EXPIRATION_LAPSE_1 arms on the expiration date, due +1 calendar day; a late `insurance.policy.verified` satisfies it.
        rec = this.putPolicy({ ...rec, status: "expired", expired_flagged_on: today });
        this.append("insurance.policy.expired", rec.loan_id, { policy_id: rec.policy_id, expiration_date: exp, evidence_received: false, lapse_on: lapseOn });
        out.expired.push(rec.policy_id);
      }
      if (lapseOn && today >= lapseOn) out.lapses.push(this.detectLapse(rec, today));
      else this.flagReverification(rec, today, out);
    }
    for (const loan of [...this.loans.values()]) {
      if (this.deps.annual_reminder_enabled === false || !annualReminderDue(loan.last_reminder_sent_on, today)) continue;
      if (this.deps.notices && loan.recipients?.length) { const r = await this.sendAnnualReminder({ loan_id: loan.loan_id, as_of: today }); if (r.sent) out.reminders_sent.push(loan.loan_id); else out.reminders_due.push(loan.loan_id); }
      else out.reminders_due.push(loan.loan_id);
    }
    if (this.feedLastMessageOn) {
      const sev = vendorFeedSeverity(this.feedLastMessageOn, today, this.deps.servicerCalendar ?? servicer);
      (out as { vendor_feed: SweepResult["vendor_feed"] }).vendor_feed = sev;
      if (sev === "sev2" && this.feedEscalatedFor !== this.feedLastMessageOn) {
        this.feedEscalatedFor = this.feedLastMessageOn;
        this.append("insurance.vendor_feed.stale", null, { last_message_on: this.feedLastMessageOn, severity: "sev2", direct_channel_intake: "continues" });
        const esc = this.deps.escalations?.open({ kind: "sev2", severity: "sev2", payload: { reason: "insurance-tracking/lpi feed silent for 3 servicer business days (9.1 edge: vendor outage/feed gaps)", last_message_on: this.feedLastMessageOn, sweep_on: today } }, INSURANCE_AGENT);
        if (esc) out.escalations.push(esc.id);
      }
    }
    return out;
  }
  private flagReverification(rec: TrackedPolicy, today: PlainDate, out: SweepResult): void {
    if (rec.verified_at && !rec.reverification_flagged_on && addDays(rec.verified_at, 365) <= today) {
      this.putPolicy({ ...rec, reverification_flagged_on: today });
      this.append("insurance.policy.reverification_due", rec.loan_id, { policy_id: rec.policy_id, verified_at: rec.verified_at, due: addDays(rec.verified_at, 365), rule: "B-2-02 renewal confirmed at a minimum annually" });
      out.reverification_due.push(rec.policy_id);
    }
  }
  /** `insurance.lapse_detected` → 9.2 opens with the escrow/(k)(5) check applied (T5): the escrowed >30-day borrower without documented inability is `k5_blocked` (3.7 advances). */
  private detectLapse(rec: TrackedPolicy, today: PlainDate): SweepResult["lapses"][number] {
    const loan = this.requireLoan(rec.loan_id);
    const outcome = lapseDetected({ escrowed: loan.escrowed, regx_days_delinquent: loan.regx_days_delinquent, cancellation_reason: loan.cancellation_reason ?? (rec.status === "cancelled" ? "other" : null), vacant: loan.vacant ?? false, insurance_type: insuranceTypeOf(rec.policy_kind), fdpa_required: loan.fdpa_flood_required ?? false, opened_on: today });
    this.putPolicy({ ...rec, status: rec.status === "cancelled" ? "cancelled" : "expired", lapse_detected_on: today });
    const base = { policy_id: rec.policy_id, policy_kind: rec.policy_kind, expiration_date: rec.status === "cancelled" ? rec.cancellation_effective : rec.expiration_date, lapse_on: today, escrowed: loan.escrowed, regx_days_delinquent: loan.regx_days_delinquent, guard: outcome.guard, k5_gate: outcome.k5_gate, case_status: outcome.case_status, premium: outcome.premium, track: outcome.track, first_notice: outcome.first_notice };
    this.append("insurance.lapse_detected", rec.loan_id, { ...base, reason: rec.status === "cancelled" ? "cancelled" : "expired" });
    const caseOpened = outcome.case_status !== "closed_servicer_pays";
    if (caseOpened) this.append("fpi.case.opened", rec.loan_id, { case_id: `fpi-${rec.loan_id}-${rec.policy_id}`, ...base, insurance_type: insuranceTypeOf(rec.policy_kind), opened_on: today, opened_by: "9.1 lapse" });
    return { policy_id: rec.policy_id, loan_id: rec.loan_id, outcome, case_opened: caseOpened };
  }
}

/** Convenience: the adequacy result and rule-set stamp for a decision record without touching the register (read-only agents / console). */
export function adequacyDecision(policy: HazardPolicy, titleHolders: readonly string[]): { adequacy: AdequacyResult; rule_set: string; change_request: ReturnType<typeof mortgageeChangeRequest> } {
  return { adequacy: evaluateAdequacy(policy, titleHolders), rule_set: RULE_SET_9_1, change_request: mortgageeChangeRequest(policy) };
}
