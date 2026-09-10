/**
 * Transfer-in case mechanics the 1.2–1.7 acceptance tests exercise beyond the
 * date arithmetic in batch.ts/respa.ts/custody-mers.ts: the batch state
 * machine and its evidence gates, portal-task SLAs, consent parsing, loan-list
 * versions and the CD25 attestation, notice-run release and recipients,
 * eNote servicing-agent verification and the payoff block, recert forecasts,
 * MERS acknowledgement ingestion, loan-level reconciliation, Escrow Setup
 * acknowledgements, the CO-* carry-over checks, the denial review gate and
 * the rule-set re-issue of (k) timers.
 */
import { addDays, addMonths, parts, startOfMonth, ymd, type PlainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { SYSTEM, type Actor, type DomainEvent, type EventStore } from "../../kernel/events/index.ts";
import type { Breach, TimerEngine, TimerInstance } from "../../kernel/timers/engine.ts";
import type { TimerRegistry } from "../../kernel/timers/registry.ts";
import { recertDeadline, violationResponseDue } from "./custody-mers.ts";
import { form629Clocks, transferDateGate, type TransferType } from "./batch.ts";
import { packageReadyGateBlock } from "./ops-1-2.ts";
import { noticeDates } from "./respa.ts";
import { fnmaPositionLagDeadline } from "./reconciliation.ts";
import type { Cents } from "../../kernel/money/cents.ts";

/** Structural view of the app layer's EscalationService (src/app/escalations.ts) so the domain can open the roles' work items without importing it. */
export interface EscalationOpener { open(input: { kind: "officer" | "human_portal_task" | "lossmit_reviewer" | "signing_officer" | "attorney" | "human_agent" | "sev1" | "sev2" | "sev3" | "sev4"; ownerRole?: string; loanId?: string; batchId?: string; caseId?: string; severity?: string; payload?: Record<string, unknown>; slaTimerId?: string }, by: Actor): { id: string; ownerRole: string; kind: string }; }
const AGG = (id: string) => ({ kind: "transfer_batch", id });

// ---- 1.2 batch state machine ------------------------------------------------
export type BatchStatus = "proposed" | "package_ready" | "submitted" | "info_requested" | "approved" | "loan_list_frozen" | "pre_boarding" | "notice_window" | "cutover" | "post_transfer" | "closed" | "denied" | "withdrawn" | "on_hold";
export interface BatchEvidence {
  readonly first_batch_for_partner?: boolean;
  readonly form101_document_id?: string | null;
  // 1.2 data model / package_ready gates (ops-1-2.ts packageReadyGates): CBAM-executed Forms 1013/1014 (6.1/6.2) and the Form 2017 for the transferee custodian (1.4).
  readonly form1013_document_id?: string | null;
  readonly form1014_document_id?: string | null;
  readonly form2017_document_id?: string | null;
  readonly form2017_custodian?: string | null;
  readonly transferee_custodian?: string | null;
  readonly form629_document_id?: string | null;
  readonly loan_list_version?: number;
  readonly custodian_matrix_document_id?: string | null;
  readonly dq_precheck_passed?: boolean;
  readonly portal_completion_record_id?: string | null;   // fnma_portal_operator completion
  readonly consent_document_hash?: string | null;
  readonly consent_conditions?: readonly string[];
  readonly officer_confirmed_conditions?: boolean;
  readonly officer_attestation_document_id?: string | null;
}
const NEXT: Partial<Record<BatchStatus, readonly BatchStatus[]>> = {
  proposed: ["package_ready", "withdrawn"], package_ready: ["submitted", "withdrawn"], submitted: ["info_requested", "approved", "denied", "on_hold"], info_requested: ["submitted", "denied"],
  approved: ["loan_list_frozen", "withdrawn"], loan_list_frozen: ["pre_boarding"], pre_boarding: ["notice_window"], notice_window: ["cutover"], cutover: ["post_transfer"], post_transfer: ["closed"], on_hold: ["submitted", "withdrawn"],
};
/** Why a transition is refused, or null when its evidence gate is met (1.2 state machine). */
export function batchTransitionBlock(from: BatchStatus, to: BatchStatus, ev: BatchEvidence): string | null {
  if (!(NEXT[from] ?? []).includes(to)) return `no transition ${from} → ${to}`;
  switch (to) {
    case "package_ready": {
      // 1.2 timer table: FNMA_A2_1_07_FORM101_INCEPTION / FNMA_A2_1_07_FORMS_1013_1014_GATE / FNMA_A2_7_03_FORM2017_GATE — "package cannot reach `package_ready`" (ops-1-2.ts).
      const gate = packageReadyGateBlock(ev); if (gate) return gate;
      if (!ev.form629_document_id) return "Form 629 not attached";
      if (!ev.loan_list_version) return "loan list missing";
      if (!ev.custodian_matrix_document_id) return "Custodian Matrix not attached";
      if (ev.dq_precheck_passed !== true) return "DQ pre-check on the loan list has not passed";
      return null;
    }
    case "submitted": return ev.portal_completion_record_id ? null : "submitted requires a fnma_portal_operator completion record";
    case "approved":
      if (!ev.consent_document_hash) return "approved requires the consent document hash";
      if ((ev.consent_conditions?.length ?? 0) > 0 && ev.officer_confirmed_conditions !== true) return "consent carries conditions: an officer must confirm the parsed D-Code and conditions";
      return null;
    case "loan_list_frozen": return ev.officer_attestation_document_id ? null : "loan_list_frozen requires the partner officer's attestation evidence";
    default: return null;
  }
}

/** Portal task SLA (1.2-T5): +2 servicer business days from assignment; past that an officer escalation is due and the batch report shows the breach. */
export function portalTaskStatus(assignedOn: PlainDate, today: PlainDate): { due: PlainDate; breached: boolean; escalation: "officer" | null } {
  const due = addBusinessDays(assignedOn, 2, servicer);
  const breached = today > due;
  return { due, breached, escalation: breached ? "officer" : null };
}

/** Consent notice parsing (1.2-T6): outcome, D-Code, effective date and any conditions; conditions block `approved` until an officer confirms. */
export function parseConsentNotice(text: string): { outcome: "approved" | "denied" | "unclear"; d_code: string | null; effective_date: string | null; conditions: string[]; officer_confirmation_required: boolean } {
  const denied = /\b(den(y|ied)|not approved|reject(ed)?)\b/i.test(text);
  const approved = /\b(approv(e[sd]?|al)|consent(s|ed)?)\b/i.test(text);
  const dCode = /\bD-?Code[:\s]+([A-Z]\d{1,3}|[A-Z]{1,2})\b/i.exec(text)?.[1] ?? null;
  const date = /(\d{4}-\d{2}-\d{2})/.exec(text)?.[1] ?? null;
  const conditions = [...text.matchAll(/(?:condition(?:ed)?(?: on|s?:)|provided that|subject to)\s+([^.;\n]+)/gi)].map((m) => m[1]!.trim());
  return { outcome: denied ? "denied" : approved ? "approved" : "unclear", d_code: dCode, effective_date: date, conditions, officer_confirmation_required: conditions.length > 0 };
}

// ---- 1.2 loan-list versions and the CD25 attestation ---------------------------
export interface LoanListVersion { readonly version: number; readonly loans: readonly string[]; readonly attested: boolean; readonly attested_by?: string; readonly reason?: string; readonly created_on: PlainDate; }
export interface LoanListLoan { readonly fnma_loan_number: string; status: "listed" | "withdrawn"; withdrawn_reason?: string; withdrawn_on?: PlainDate; }
/** 1.2-T7: a payoff/repurchase/foreclosure after approval withdraws the loan and creates a new (unattested) list version. */
export function withdrawFromList(versions: readonly LoanListVersion[], loans: LoanListLoan[], fnmaLoanNumber: string, reason: "paid_off" | "repurchased" | "foreclosed", on: PlainDate): LoanListVersion {
  const loan = loans.find((l) => l.fnma_loan_number === fnmaLoanNumber);
  if (!loan) throw new RangeError(`${fnmaLoanNumber} is not on the Form 629 list`);
  loan.status = "withdrawn"; loan.withdrawn_reason = reason; loan.withdrawn_on = on;
  const last = versions[versions.length - 1];
  return { version: (last?.version ?? 0) + 1, loans: loans.filter((l) => l.status === "listed").map((l) => l.fnma_loan_number), attested: false, reason: `${fnmaLoanNumber} ${reason} ${on}`, created_on: on };
}
/** FNMA_QX_LOAN_LIST_FREEZE_CD25 is satisfied only by an attested version (`transfer.loan_list.attested`). */
export function attestationSatisfies(v: LoanListVersion): boolean { return v.attested === true && !!v.attested_by; }
export function attestList(v: LoanListVersion, officer: Actor): LoanListVersion {
  if (officer.kind !== "human" || officer.role !== "officer") throw new RangeError("loan-list attestation is an officer act");
  return { ...v, attested: true, attested_by: officer.id };
}

// ---- 1.2 batch lifecycle: the emitters every §1 timer arms and satisfies on --------------
/** `transfer.batch.proposed` (1.2 inputs: "created by the `transfer` agent from the partner's instruction: transfer type, candidate transfer date, loan list source"). */
export interface BatchProposal {
  readonly batch_id: string; readonly type: TransferType; readonly transfer_date: PlainDate; readonly sale_date?: PlainDate | null;
  readonly first_batch_for_partner?: boolean; readonly partner_id?: string; readonly transferor_party_id?: string;
  readonly notice_mode?: "separate" | "combined"; readonly loan_count?: number; readonly emortgage_count?: number;
  /** D (servicer change), I (concurrent sale, 30-day recert), C (custodian only), none (subservicer-only change pending Fannie Mae confirmation — 1.4 decision 1). */
  readonly code_type?: "D" | "I" | "C" | "none";
}
/** Fannie Mae consent (1.2 inputs `transfer.fnma_consent.received`): what `approved` carries for 1.1/1.3/1.4/1.5 (`fnma_consent_document_id`, `d_code`, `transfer_date`, `sale_date`, servicer numbers). */
export interface BatchApproval {
  readonly d_code: string | null; readonly fnma_consent_document_id: string; readonly consent_document_hash: string; readonly conditions?: readonly string[];
  readonly respa_effective_date?: PlainDate; readonly exception_basis?: "termination_for_cause" | "bankruptcy" | "fdic" | "ncua" | null;
  readonly transferor_servicer_number?: string; readonly partner_servicer_number?: string;
}
export class TransferDateGateClosed extends RangeError {
  readonly gate = "FNMA_A2_7_03_TRANSFER_DATE_GATE" as const; readonly expected: PlainDate;
  constructor(proposed: PlainDate, expected: PlainDate) { super(`FNMA_A2_7_03_TRANSFER_DATE_GATE: proposed transfer date ${proposed} is not the first business_days_fannie_et of the month (${expected}) — A2-7-03`); this.name = "TransferDateGateClosed"; this.expected = expected; }
}
export class BatchTransitionRefused extends RangeError { readonly block: string; constructor(from: BatchStatus, to: BatchStatus, block: string) { super(`${from} → ${to} refused: ${block}`); this.name = "BatchTransitionRefused"; this.block = block; } }
/** FNMA_QX_LOAN_LIST_FREEZE_CD25: the 25th calendar day of the month before `transfer_date` (1.2 rule 3, CD25 attestation). */
export function loanListFreezeOn(transferDate: PlainDate): PlainDate { const prior = parts(addDays(startOfMonth(transferDate), -1)); return ymd(prior.y, prior.m, 25); }
/** Payload of `transfer.batch.proposed`: the anchors FORM629_SUBSERVICING_30 / SERVICING_60 / INTERNAL_BUFFER_7 read (batch.ts form629Clocks; 1.2 rule 1). */
export function proposedPayload(p: BatchProposal): Record<string, unknown> {
  const clocks = form629Clocks(p.type, p.transfer_date, p.sale_date ?? null);
  const anchor = p.sale_date && p.sale_date < p.transfer_date ? p.sale_date : p.transfer_date;
  return { batch_id: p.batch_id, type: p.type, transfer_date: p.transfer_date, sale_date: p.sale_date ?? null, first_batch_for_partner: p.first_batch_for_partner ?? false, partner_id: p.partner_id ?? null, transferor_party_id: p.transferor_party_id ?? null,
    notice_mode: p.notice_mode ?? "separate", loan_count: p.loan_count ?? 0, emortgage_count: p.emortgage_count ?? 0, code_type: p.code_type ?? "none",
    form629_deadline: clocks.deadline, form629_anchor_date: anchor, form629_rule: clocks.rule, internal_buffer: clocks.internal_buffer, liability_start: clocks.liability_start };
}
/** Payload of `transfer.batch.approved` (1.1 inputs; 1.3/1.4/1.5 triggers): D-Code, consent document, `respa_effective_date` (= `transfer_date` unless the first payment due to Supermortgage differs — 1.3 verified requirement), `notice_mode`, `emortgage_count`, `loan_list_freeze_on`. */
export function approvedPayload(p: BatchProposal, a: BatchApproval): Record<string, unknown> {
  return { ...proposedPayload(p), d_code: a.d_code, fnma_consent_document_id: a.fnma_consent_document_id, consent_document_hash: a.consent_document_hash, fnma_conditions: [...(a.conditions ?? [])],
    respa_effective_date: a.respa_effective_date ?? p.transfer_date, exception_basis: a.exception_basis ?? null, transferor_servicer_number: a.transferor_servicer_number ?? null, partner_servicer_number: a.partner_servicer_number ?? null,
    loan_list_freeze_on: loanListFreezeOn(p.transfer_date), ted: p.transfer_date };
}
/** Payload of `transfer.batch.cutover_completed` (1.1/1.3/1.4/1.5/1.6 triggers): `transfer_date`, `respa_effective_date`, `ted`, `code_type`, the last Fannie Mae business day of the transfer month (SM_RECON_FNMA_POSITION_EOM). */
export function cutoverPayload(p: BatchProposal, extra: { respa_effective_date?: PlainDate; boarded_count?: number; withdrawn_count?: number; last_batch_for_partner?: boolean; cutover_at?: string } = {}): Record<string, unknown> {
  return { batch_id: p.batch_id, type: p.type, transfer_date: p.transfer_date, sale_date: p.sale_date ?? null, respa_effective_date: extra.respa_effective_date ?? p.transfer_date, ted: p.transfer_date, code_type: p.code_type ?? "none", notice_mode: p.notice_mode ?? "separate",
    loan_count: p.loan_count ?? 0, boarded_count: extra.boarded_count ?? p.loan_count ?? 0, withdrawn_count: extra.withdrawn_count ?? 0, last_batch_for_partner: extra.last_batch_for_partner ?? false, fnma_position_deadline: fnmaPositionLagDeadline(p.transfer_date), cutover_at: extra.cutover_at ?? null };
}
/** `proposeBatch` (1.2-T1/T2): the transfer-date gate is asserted before anything is written; the event arms the Form 629 clocks. */
export function proposeBatch(events: EventStore, p: BatchProposal, actor: Actor): DomainEvent {
  const g = transferDateGate(p.transfer_date);
  if (!g.ok) throw new TransferDateGateClosed(p.transfer_date, g.expected);
  return events.append({ type: "transfer.batch.proposed", aggregate: AGG(p.batch_id), actor, payload: proposedPayload(p) });
}
export interface TransferBatch { readonly id: string; status: BatchStatus; readonly proposal: BatchProposal; evidence: BatchEvidence; approval: BatchApproval | null; readonly history: { from: BatchStatus; to: BatchStatus; at: string; by: string }[]; portal_task_ids: string[]; }
/**
 * The batch-level `transfer_in` case (1.2 state machine). Every transition is checked by
 * `batchTransitionBlock` and emits the canonical event the timers of 1.1–1.7 arm on:
 * proposed → `transfer.batch.proposed`; submitted → `transfer.form629.submitted` (from the
 * `fnma_portal_operator`'s completed portal task); approved → `transfer.batch.approved`;
 * loan_list_frozen → `transfer.loan_list.attested` + `.finalized`; cutover →
 * `transfer.batch.cutover_completed`; closed → `transfer.batch.closed`; denied →
 * `transfer.form629.denied`.
 */
export class TransferBatchService {
  private readonly batches = new Map<string, TransferBatch>();
  private readonly portalTasks = new Map<string, string>();   // escalation id → batch id
  private readonly events: EventStore; private readonly clock: { now(): string };
  constructor(deps: { events: EventStore; clock: { now(): string } }) {
    this.events = deps.events; this.clock = deps.clock;
    // 1.2 state machine: "Transitions to `submitted` require a `fnma_portal_operator` completion record" — the completed Form 629 portal task is that record.
    deps.events.subscribe("escalation.created{kind=human_portal_task}", (e) => { const p = e.payload as { task?: unknown; batch_id?: unknown; escalation_id?: unknown }; if (p.task === "form629" && typeof p.batch_id === "string" && typeof p.escalation_id === "string") { this.portalTasks.set(p.escalation_id, p.batch_id); this.batches.get(p.batch_id)?.portal_task_ids.push(p.escalation_id); } });
    deps.events.subscribe("escalation.completed{kind=human_portal_task}", (e) => { const p = e.payload as { escalation_id?: unknown; evidence_document_id?: unknown }; const batchId = typeof p.escalation_id === "string" ? this.portalTasks.get(p.escalation_id) : undefined; const b = batchId ? this.batches.get(batchId) : undefined;
      if (b && b.status === "package_ready") this.transition(b.id, "submitted", { portal_completion_record_id: typeof p.evidence_document_id === "string" ? p.evidence_document_id : e.id }, e.actor, { portal_task_id: p.escalation_id ?? null }); });
  }
  propose(p: BatchProposal, actor: Actor): TransferBatch {
    if (this.batches.has(p.batch_id)) throw new RangeError(`batch ${p.batch_id} already proposed`);
    const ev = proposeBatch(this.events, p, actor);
    const b: TransferBatch = { id: p.batch_id, status: "proposed", proposal: p, evidence: { ...(p.first_batch_for_partner !== undefined ? { first_batch_for_partner: p.first_batch_for_partner } : {}) }, approval: null, history: [{ from: "proposed", to: "proposed", at: ev.occurredAt, by: `${actor.kind}:${actor.id}` }], portal_task_ids: [] };
    this.batches.set(b.id, b);
    return b;
  }
  get(id: string): TransferBatch { const b = this.batches.get(id); if (!b) throw new RangeError(`no transfer batch ${id}`); return b; }
  all(): readonly TransferBatch[] { return [...this.batches.values()]; }
  /** Approval evidence (consent hash, parsed conditions, officer confirmation) is recorded before `transition(id, "approved")`. */
  recordApproval(id: string, a: BatchApproval, officerConfirmed: boolean): TransferBatch { const b = this.get(id); b.approval = a; b.evidence = { ...b.evidence, consent_document_hash: a.consent_document_hash, consent_conditions: [...(a.conditions ?? [])], officer_confirmed_conditions: officerConfirmed }; return b; }
  transition(id: string, to: BatchStatus, evidence: BatchEvidence = {}, actor: Actor = SYSTEM, extra: Record<string, unknown> = {}): TransferBatch {
    const b = this.get(id); const merged = { ...b.evidence, ...evidence };
    const block = batchTransitionBlock(b.status, to, merged);
    if (block) throw new BatchTransitionRefused(b.status, to, block);
    if (to === "approved" && !b.approval) throw new BatchTransitionRefused(b.status, to, "approved requires the recorded Fannie Mae consent (recordApproval)");
    const from = b.status; b.evidence = merged; b.status = to; const now = this.clock.now();
    b.history.push({ from, to, at: now, by: `${actor.kind}:${actor.id}` });
    const emit = (type: string, payload: Record<string, unknown>) => this.events.append({ type, aggregate: AGG(id), actor, payload: { batch_id: id, ...payload } });
    switch (to) {
      case "submitted": emit("transfer.form629.submitted", { form629_submitted_at: now, form629_submitted_by: actor.id, portal_completion_record_id: merged.portal_completion_record_id ?? null, ...extra }); break;
      case "approved": emit("transfer.batch.approved", { ...approvedPayload(b.proposal, b.approval!), ...extra }); break;
      case "denied": emit("transfer.form629.denied", extra); break;
      case "on_hold": emit("transfer.batch.on_hold", extra); break;
      case "withdrawn": emit("transfer.batch.withdrawn", extra); break;
      case "loan_list_frozen": emit("transfer.loan_list.attested", { version: merged.loan_list_version ?? null, attestation_document_id: merged.officer_attestation_document_id ?? null, ...extra }); emit("transfer.loan_list.finalized", { version: merged.loan_list_version ?? null, ...extra }); break;
      case "cutover": emit("transfer.batch.cutover_completed", { ...cutoverPayload(b.proposal, { cutover_at: now, ...(b.approval?.respa_effective_date ? { respa_effective_date: b.approval.respa_effective_date } : {}) }), ...extra }); break;
      case "closed": emit("transfer.batch.closed", { transfer_date: b.proposal.transfer_date, ...extra }); break;
      default: break;
    }
    emit("transfer.batch.status_changed", { from, to });
    return b;
  }
}
/** Breach → the role's work item (1.2-T5, 1.3-T2, 1.4-T4, 1.6-T6): the registry's breach column names the role; the escalation carries the timer. */
export function escalateBreach(esc: EscalationOpener, breach: Breach, by: Actor = SYSTEM, extra: { batchId?: string; caseId?: string } = {}): { id: string; ownerRole: string; kind: string; timer_code: string } {
  const role = breach.escalateTo.find((r) => ["officer", "lossmit_reviewer", "signing_officer", "attorney", "human_agent", "fnma_portal_operator"].includes(r));
  const kind = role === "fnma_portal_operator" ? "human_portal_task" : ((role ?? (breach.severity === 1 || breach.severity === 2 ? "officer" : "sev3")) as Parameters<EscalationOpener["open"]>[0]["kind"]);
  const e = esc.open({ kind, ...(breach.instance.loanId ? { loanId: breach.instance.loanId } : {}), ...(extra.batchId ? { batchId: extra.batchId } : breach.instance.subject.kind === "transfer_batch" ? { batchId: breach.instance.subject.id } : {}), ...(extra.caseId ? { caseId: extra.caseId } : {}),
    severity: breach.severity ? `sev-${breach.severity}` : "sev-3", slaTimerId: breach.instance.id, payload: { timer_code: breach.def.code, timer_id: breach.instance.id, due_date: breach.instance.dueDate ?? null, breached_at: breach.instance.breachedAt ?? null, breach: breach.breachText, escalate_to: [...breach.escalateTo] } }, by);
  return { id: e.id, ownerRole: e.ownerRole, kind: e.kind, timer_code: breach.def.code };
}
/** Batch report (1.2-T5 "the batch report shows the breach"): every timer instance on the batch and its work items, with the breached ones called out. */
export function batchReport(timers: TimerEngine, batchId: string, escalationIds: readonly string[] = []): { batch_id: string; timers: { code: string; status: string; due_date: PlainDate | null; breached_at: string | null }[]; breaches: { code: string; due_date: PlainDate | null; breached_at: string | null }[] } {
  const inst: TimerInstance[] = [...timers.forSubject("transfer_batch", batchId), ...escalationIds.flatMap((id) => [...timers.forSubject("escalation", id)])];
  const rows = inst.map((t) => ({ code: t.code, status: t.status, due_date: t.dueDate ?? null, breached_at: t.breachedAt ?? null }));
  return { batch_id: batchId, timers: rows, breaches: rows.filter((r) => r.status === "breached" || r.status === "satisfied_late").map(({ code, due_date, breached_at }) => ({ code, due_date, breached_at })) };
}

// ---- 1.3 notice runs ------------------------------------------------------------
export type NoticeRunStatus = "planned" | "rendered" | "qc_passed" | "released_to_vendor" | "mailed" | "complete";
/** Release gate (1.3-T4): every rendered notice must pass the required-content checklist and address validation. */
export function releaseGate(run: { status: NoticeRunStatus; notices: readonly { id: string; checklist_missing: readonly string[]; address_valid: boolean }[]; transferor_authorization_on_file: boolean; kind: "goodbye" | "hello" | "combined" | "corrective" }): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (run.status !== "qc_passed" && run.status !== "rendered") reasons.push(`run is ${run.status}`);
  for (const n of run.notices) { if (n.checklist_missing.length) reasons.push(`${n.id}: missing ${n.checklist_missing.join(", ")}`); if (!n.address_valid) reasons.push(`${n.id}: address not validated`); }
  if ((run.kind === "goodbye" || run.kind === "combined") && !run.transferor_authorization_on_file) reasons.push("goodbye run needs the transferor's written authorization on file");
  return { ok: reasons.length === 0, reasons };
}
export interface NoticeParty { readonly party_id: string; readonly role: "borrower" | "successor_in_interest" | "bk_counsel"; readonly address: string; readonly acp_enrolled?: boolean; readonly acp_substitute_address?: string | null; readonly sii_confirmed?: boolean; }
/** Recipients (1.3 rule 6 / T9): each borrower at their own address, confirmed successors, ACP participants at the substitute address only, counsel where known. */
export function noticeRecipients(parties: readonly NoticeParty[]): { party_id: string; address: string; via: "own_address" | "acp_substitute" | "counsel_copy" }[] {
  const out: { party_id: string; address: string; via: "own_address" | "acp_substitute" | "counsel_copy" }[] = [];
  for (const p of parties) {
    if (p.role === "successor_in_interest" && !p.sii_confirmed) continue;
    if (p.role === "bk_counsel") { out.push({ party_id: p.party_id, address: p.address, via: "counsel_copy" }); continue; }
    if (p.acp_enrolled) { if (!p.acp_substitute_address) throw new RangeError(`${p.party_id} is ACP-enrolled with no substitute address`); out.push({ party_id: p.party_id, address: p.acp_substitute_address, via: "acp_substitute" }); }
    else out.push({ party_id: p.party_id, address: p.address, via: "own_address" });
  }
  return out;
}
/** Returned mail (1.3-T8): a skip-trace order within 5 servicer business days; the original proof of mailing stays linked (comment 33(b)(3)-1). */
export function returnedMail(notice: { id: string; proof_of_mailing_id: string }, returnedOn: PlainDate): { notice_id: string; skip_trace_due: PlainDate; original_proof_of_mailing_id: string; still_satisfies_1024_33: true } {
  return { notice_id: notice.id, skip_trace_due: addBusinessDays(returnedOn, 5, servicer), original_proof_of_mailing_id: notice.proof_of_mailing_id, still_satisfies_1024_33: true };
}
/** Master-servicer-only change (1.3-T10, §1024.33(b)(2)(i)(C)): no notices, provided nothing the borrower sees changes, and an officer approval record documents the exclusion. */
export function masterServicerOnlyExclusion(unchanged: { payee: boolean; address: boolean; account: boolean; amount: boolean }, officer: Actor | null): { notices_required: boolean; exclusion_record: { basis: string; approved_by: string } | null; block: string | null } {
  const all = unchanged.payee && unchanged.address && unchanged.account && unchanged.amount;
  if (!all) return { notices_required: true, exclusion_record: null, block: null };
  if (!officer || officer.kind !== "human" || officer.role !== "officer") return { notices_required: false, exclusion_record: null, block: "suppression needs an officer sign-off verifying no payee/address/account/amount change" };
  return { notices_required: false, exclusion_record: { basis: "§1024.33(b)(2)(i)(C): master servicer change, subservicer retained, nothing borrower-facing changes", approved_by: officer.id }, block: null };
}
export const MS2_TEMPLATE = { goodbye: "NTC_REGX_1024_33B_GOODBYE_MS2", hello: "NTC_REGX_1024_33B_HELLO_MS2", combined: "NTC_REGX_1024_33B_COMBINED_MS2", corrective: "NTC_REGX_1024_33B_CORRECTIVE" } as const;
export interface NoticeRun { readonly run_id: string; readonly batch_id: string; readonly kind: keyof typeof MS2_TEMPLATE; readonly template: string; readonly due_at: PlainDate; readonly loans: readonly { loan_id: string; notice_id: string }[]; status: NoticeRunStatus; readonly mailed: Map<string, { mailed_on: PlainDate; proof_of_mailing_id: string }>; }
/** `transfer_notice_runs` row (1.3 data model): one run per kind, due per 1.3 rule 1, one notice per loan on the frozen list. */
export function planNoticeRun(batch: { batch_id: string; respa_effective_date: PlainDate; loan_ids: readonly string[] }, kind: keyof typeof MS2_TEMPLATE, runId = `${batch.batch_id}:${kind}`): NoticeRun {
  const d = noticeDates(batch.respa_effective_date);
  const due_at = kind === "hello" ? d.hello_due : kind === "corrective" ? addBusinessDays(batch.respa_effective_date, 5, servicer) : d.goodbye_due;
  return { run_id: runId, batch_id: batch.batch_id, kind, template: MS2_TEMPLATE[kind], due_at, loans: batch.loan_ids.map((loan_id) => ({ loan_id, notice_id: `${runId}:${loan_id}` })), status: "planned", mailed: new Map() };
}
/**
 * Proof of mailing per loan (1.3 outputs `notices.proof_of_mailing_document_id`): one `notice.mailed` per notice on its loan, and — once
 * every loan on the run has a proof — the run-level `notice.mailed{template, every_loan=true}` on the batch that satisfies
 * REGX_1024_33B3_GOODBYE_15 / HELLO_15 / COMBINED_15 ("for every loan"). Vendor manifests are idempotent by notice id.
 */
export function noticeRunMailed(events: EventStore, run: NoticeRun, proofs: readonly { loan_id: string; proof_of_mailing_id: string; mailed_on: PlainDate }[], actor: Actor = { kind: "external", id: "print-mail" }): { mailed_count: number; every_loan: boolean; run_event: DomainEvent | null } {
  for (const p of proofs) {
    const n = run.loans.find((l) => l.loan_id === p.loan_id); if (!n || run.mailed.has(p.loan_id)) continue;
    run.mailed.set(p.loan_id, { mailed_on: p.mailed_on, proof_of_mailing_id: p.proof_of_mailing_id });
    events.append({ type: "notice.mailed", loanId: p.loan_id, aggregate: { kind: "notice", id: n.notice_id }, actor, payload: { notice_id: n.notice_id, template: run.template, run_id: run.run_id, batch_id: run.batch_id, mailed_at: p.mailed_on, proof_of_mailing_id: p.proof_of_mailing_id, every_loan: false } });
    events.append({ type: `notice.transfer.${run.kind}.sent`, loanId: p.loan_id, actor, payload: { notice_id: n.notice_id, template: run.template, mailed_at: p.mailed_on } });
  }
  const every = run.loans.length > 0 && run.loans.every((l) => run.mailed.has(l.loan_id));
  let run_event: DomainEvent | null = null;
  if (every && run.status !== "mailed" && run.status !== "complete") {
    run.status = "mailed";
    const last = [...run.mailed.values()].map((m) => m.mailed_on).sort().at(-1)!;
    run_event = events.append({ type: "notice.mailed", aggregate: AGG(run.batch_id), actor, payload: { run_id: run.run_id, batch_id: run.batch_id, template: run.template, kind: run.kind, mailed_at: last, mailed_count: run.mailed.size, every_loan: true } });
  }
  return { mailed_count: run.mailed.size, every_loan: every, run_event };
}
/** Returned RESPA notice → `mail.returned{template}` (FNMA_A2_7_03_RETURNED_NOTICE_SKIP_TRACE_5 trigger) and the skip-trace order row (1.3-T8). */
export function orderSkipTrace(events: EventStore, notice: { id: string; loan_id: string; template: string; proof_of_mailing_id: string }, returnedOn: PlainDate, actor: Actor = { kind: "agent", id: "transfer" }): { order: { order_id: string; notice_id: string; loan_id: string; ordered_on: PlainDate; due: PlainDate; original_proof_of_mailing_id: string; status: "ordered" }; returned: ReturnType<typeof returnedMail> } {
  const r = returnedMail({ id: notice.id, proof_of_mailing_id: notice.proof_of_mailing_id }, returnedOn);
  events.append({ type: "mail.returned", loanId: notice.loan_id, aggregate: { kind: "notice", id: notice.id }, actor: { kind: "external", id: "print-mail" }, payload: { notice_id: notice.id, template: notice.template, returned_at: returnedOn, proof_of_mailing_id: notice.proof_of_mailing_id } });
  const order = { order_id: `skiptrace:${notice.id}`, notice_id: notice.id, loan_id: notice.loan_id, ordered_on: returnedOn, due: r.skip_trace_due, original_proof_of_mailing_id: notice.proof_of_mailing_id, status: "ordered" as const };
  events.append({ type: "notice.skip_trace.ordered", loanId: notice.loan_id, aggregate: { kind: "notice", id: notice.id }, actor, payload: { ...order } });
  return { order, returned: r };
}

// ---- 1.4 eNotes and recert forecasts --------------------------------------------
export const SUPERMORTGAGE_ORG_ID = "1009999";
/** eRegistry check (1.4 rule 5): Controller = Fannie Mae, Location = Fannie Mae eVault, Servicing Agent = Supermortgage (or partner with Supermortgage as delegatee). */
export function enoteVerification(reg: { controller: string; location: string; servicing_agent: string; delegatee?: string | null }, partnerOrgId?: string): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (reg.controller !== "FNMA") problems.push(`controller ${reg.controller} ≠ FNMA`);
  if (!/fnma|fannie/i.test(reg.location)) problems.push(`location ${reg.location} is not Fannie Mae's eVault`);
  const agentOk = reg.servicing_agent === SUPERMORTGAGE_ORG_ID || (partnerOrgId !== undefined && reg.servicing_agent === partnerOrgId && reg.delegatee === SUPERMORTGAGE_ORG_ID);
  if (!agentOk) problems.push("enote_servicing_agent_mismatch");
  return { ok: problems.length === 0, problems };
}
/** Payoff/modification command gate on eNotes (1.4-T6): blocked with reason `enote_servicing_agent_mismatch` while FNMA_F1_11_ENOTE_SERVICING_AGENT_T0 is breached. */
export function enotePayoffGate(loan: { enote: boolean; servicing_agent_verified: boolean }): { ok: true } | { ok: false; reason: "enote_servicing_agent_mismatch" } {
  return !loan.enote || loan.servicing_agent_verified ? { ok: true } : { ok: false, reason: "enote_servicing_agent_mismatch" };
}
/** Recert risk forecast (1.4-T7): at-risk when the projected unrecertified count at the forecast date is > 0; the extension draft is due 30 days before the 15-day request cutoff (1.4 agent design: "drafts extension requests 30 days ahead of the 15-day cutoff" — TED Oct 1, 2026 → cutoff Mar 17, 2027 → draft Feb 15, 2027, inside T7's "by Mar. 1, 2027"). */
export function recertForecast(f: { ted: PlainDate; code: "D" | "C" | "I" | "none"; total: number; unrecertified_at_forecast: number; forecast_date: PlainDate }): { deadline: PlainDate; extension_request_by: PlainDate; at_risk: boolean; extension_draft_due: PlainDate | null; officer_task: "recert_extension" | null; pct_unrecertified: number } {
  const d = recertDeadline(f.ted, f.code);
  const atRisk = f.unrecertified_at_forecast > 0 && f.forecast_date < d.deadline;
  return { ...d, at_risk: atRisk, extension_draft_due: atRisk ? addDays(d.extension_request_by, -30) : null, officer_task: atRisk ? "recert_extension" : null, pct_unrecertified: Math.round((10_000 * f.unrecertified_at_forecast) / f.total) / 100 };
}
/** The agent's forecast on the bus (1.4-T7): an at-risk batch emits `custody.recert.at_risk` (FNMA_DTJA_RECERT_EXTENSION_15 trigger, anchored on `recert_deadline`) and opens the `officer` task for the extension request. */
export function forecastRecertRisk(events: EventStore, esc: EscalationOpener | null, batchId: string, f: Parameters<typeof recertForecast>[0], actor: Actor = { kind: "agent", id: "security-records" }): ReturnType<typeof recertForecast> & { officer_task_id: string | null } {
  const r = recertForecast(f);
  if (!r.at_risk) return { ...r, officer_task_id: null };
  events.append({ type: "custody.recert.at_risk", aggregate: AGG(batchId), actor, payload: { batch_id: batchId, recert_deadline: r.deadline, extension_request_by: r.extension_request_by, extension_draft_due: r.extension_draft_due, unrecertified: f.unrecertified_at_forecast, total: f.total, pct_unrecertified: r.pct_unrecertified, forecast_date: f.forecast_date } });
  const task = esc ? esc.open({ kind: "officer", batchId, severity: "sev-1", payload: { task: "recert_extension", recert_deadline: r.deadline, extension_request_by: r.extension_request_by, draft_due: r.extension_draft_due, unrecertified: f.unrecertified_at_forecast } }, actor) : null;
  return { ...r, officer_task_id: task?.id ?? null };
}
// ---- 1.4 custodian feed: the `custody.*` events the custody timers are satisfied and armed by ------
export type CustodianFeedItem =
  | { kind: "trial_balance_ack"; receipt_id: string; acked_on: PlainDate }
  | { kind: "shipment_received"; received_on: PlainDate; first?: boolean; manifest_id?: string; document_count?: number }
  | { kind: "exceptions_notified"; notified_on: PlainDate; exceptions: readonly { fnma_loan_number: string; kind: string }[] }
  | { kind: "exception_review_completed"; completed_on: PlainDate }
  | { kind: "recert_start_acked"; acked_on: PlainDate } | { kind: "recert_completed"; completed_on: PlainDate; code_type?: "D" | "C" | "I" } | { kind: "recert_complete_acked"; acked_on: PlainDate }
  | { kind: "transferor_notice_confirmed"; confirmed_on: PlainDate } | { kind: "extension_requested"; requested_on: PlainDate; until: PlainDate };
const CUSTODIAN: Actor = { kind: "external", id: "custodian" };
/** One custodian feed item → its `custody.*` event on the batch (Document Transfers Job Aid v5 acknowledgments). */
export function ingestCustodianFeedItem(events: EventStore, batchId: string, item: CustodianFeedItem): DomainEvent {
  const at = (type: string, payload: Record<string, unknown>) => events.append({ type, aggregate: AGG(batchId), actor: CUSTODIAN, payload: { batch_id: batchId, ...payload } });
  switch (item.kind) {
    case "trial_balance_ack": return at("custody.trial_balance.sent", { receipt_id: item.receipt_id, acked_at: item.acked_on });
    case "shipment_received": return at("custody.shipment.received", { received_at: item.received_on, first: item.first ?? false, ...(item.first ? { first_docs_received_at: item.received_on } : {}), manifest_id: item.manifest_id ?? null, document_count: item.document_count ?? null });
    case "exceptions_notified": return at("custody.exceptions.notified", { notified_at: item.notified_on, exception_count: item.exceptions.length, exceptions: item.exceptions.map((e) => ({ ...e })) });
    case "exception_review_completed": return at("custody.exception_review.completed", { completed_at: item.completed_on });
    case "recert_start_acked": return at("custody.recert_start.acked", { acked_at: item.acked_on });
    case "recert_completed": return at("custody.recert.completed", { completed_at: item.completed_on, code_type: item.code_type ?? "D" });
    case "recert_complete_acked": return at("custody.recert_complete.acked", { acked_at: item.acked_on });
    case "transferor_notice_confirmed": return at("custody.transferor_notice.confirmed", { confirmed_at: item.confirmed_on });
    case "extension_requested": return at("custody.extension.requested", { requested_at: item.requested_on, extension_until: item.until });
  }
}
/** FNMA_DTJA_MISSING_DOCS_NOTICE_30 breach (1.4-T4): "liability shifts to transferee custodian" — logged on the batch as a liability warning. */
export function missingDocsLiabilityWarning(events: EventStore, breach: Breach, actor: Actor = SYSTEM): { code: "FNMA_DTJA_MISSING_DOCS_NOTICE_30"; batch_id: string; due_date: PlainDate | null; breached_at: string | null; warning: string } {
  if (breach.def.code !== "FNMA_DTJA_MISSING_DOCS_NOTICE_30") throw new RangeError(`not a missing-documents breach: ${breach.def.code}`);
  const rec = { code: "FNMA_DTJA_MISSING_DOCS_NOTICE_30" as const, batch_id: breach.instance.subject.id, due_date: breach.instance.dueDate ?? null, breached_at: breach.instance.breachedAt ?? null, warning: "Document Transfers Job Aid v5: the transferee custodian did not notify missing documents/Form 2009 within 30 days of receipt — it is now responsible for any missing files; Fannie Mae exposure" };
  events.append({ type: "custody.liability_warning.logged", aggregate: AGG(rec.batch_id), actor, payload: { ...rec, timer_id: breach.instance.id } });
  return rec;
}
export interface CustodyExceptionRow { readonly loan_id: string; readonly kind: "missing_note" | "missing_mortgage" | "endorsement_break" | "allonge_missing" | "poa_missing" | "assignment_missing" | "data_mismatch" | "form_2009_missing"; readonly raised_by: "custodian" | "agent"; readonly raised_at: PlainDate; notified_transferor_at: PlainDate | null; resolved_at: PlainDate | null; resolution: string | null; evidence_document_id: string | null; }
/** 1.4 rule 4 / 1.4-T8: a non-MERS loan with no recorded assignment to Fannie Mae carries an open `assignment_missing` exception until the recorded instrument image is received (transferor records; F-1-11). */
export function assignmentException(loan: { loan_id: string; mers_registered: boolean; assignment_to_fnma_recorded: boolean }, raisedOn: PlainDate): CustodyExceptionRow | null {
  if (loan.mers_registered || loan.assignment_to_fnma_recorded) return null;
  return { loan_id: loan.loan_id, kind: "assignment_missing", raised_by: "agent", raised_at: raisedOn, notified_transferor_at: raisedOn, resolved_at: null, resolution: null, evidence_document_id: null };
}
export function resolveCustodyException(row: CustodyExceptionRow, evidence: { document_id: string; received_on: PlainDate; resolution: string }): CustodyExceptionRow {
  return { ...row, resolved_at: evidence.received_on, resolution: evidence.resolution, evidence_document_id: evidence.document_id };
}
/** 90-Day Non-Liquidation Report (1.4-T9, FNMA_RDC_FORM2009_90): releases open more than 90 days for a non-liquidation reason. */
export function form2009Report(releases: readonly { loan_id: string; released_at: PlainDate; reason: string; returned_at?: PlainDate | null }[], asOf: PlainDate): { as_of: PlainDate; rows: { loan_id: string; released_at: PlainDate; reason: string; days_open: number; due_back: PlainDate }[] } {
  const rows = releases.filter((r) => !r.returned_at && r.reason !== "liquidation" && r.reason !== "payoff" && addDays(r.released_at, 90) < asOf)
    .map((r) => ({ loan_id: r.loan_id, released_at: r.released_at, reason: r.reason, days_open: Math.round((Date.parse(asOf) - Date.parse(r.released_at)) / 86_400_000), due_back: addDays(r.released_at, 90) }));
  return { as_of: asOf, rows };
}

// ---- 1.5 MERS ------------------------------------------------------------------
export const MERS_REGISTRATION_FEE_CENTS: Cents = 2_495n;   // $24.95 MOM/Non-MOM registration (research/00b N1)
/** TOS expectations (1.5-T2): pending notices from the seller and a 7-day confirmation timer per MIN. */
export function tosExpectations(batch: { type: string; mins: readonly string[]; pending_received_on?: PlainDate }): { tos_expected: boolean; confirmations: { min: string; confirm_by: PlainDate | null }[] } {
  if (batch.type !== "servicing_sale_with_sub") return { tos_expected: false, confirmations: [] };
  return { tos_expected: true, confirmations: batch.mins.map((min) => ({ min, confirm_by: batch.pending_received_on ? addDays(batch.pending_received_on, 7) : null })) };
}
/** Acknowledgement ingestion (1.5-T4): every rejected MIN opens a boarding exception; the batch report carries the accepted percentage. */
export function ingestMersAcknowledgement(results: readonly { min: string; accepted: boolean; reason?: string }[]): { accepted: number; rejected: number; accepted_pct: number; exceptions: { min: string; kind: "mers_rejected"; reason: string }[] } {
  const rejected = results.filter((r) => !r.accepted);
  return { accepted: results.length - rejected.length, rejected: rejected.length, accepted_pct: Math.round((10_000 * (results.length - rejected.length)) / Math.max(1, results.length)) / 100, exceptions: rejected.map((r) => ({ min: r.min, kind: "mers_rejected", reason: r.reason ?? "rejected" })) };
}
/** Registration fee accrual (1.5 rule 5): to the partner's MERS invoice, never to the borrower. */
export function registrationFeeAccrual(min: string, partnerId: string): { min: string; amount_cents: Cents; bill_to: string; borrower_charge: false } {
  return { min, amount_cents: MERS_REGISTRATION_FEE_CENTS, bill_to: `partner:${partnerId}:mers_invoice`, borrower_charge: false };
}
export const FANNIE_MAE_MERS_ORG_ID = "1000010";
export type MersTxnType = "min_update_subservicer" | "tos_initiate" | "tos_confirm" | "tob_confirm" | "registration" | "deactivation" | "min_update_other";
export interface MersTxnRow { readonly min: string; readonly loan_id: string | null; readonly txn_type: MersTxnType; readonly effective_date: PlainDate; readonly submitted_by_org_id: string; readonly status: "prepared"; }
/** 1.5 rule 1 / 1.5-T1: `mers_transactions` rows by transfer type — a Subservicer MIN Update per MIN for master_to_sub/sub_to_sub (no TOS/TOB), buyer-side TOS confirmations for a servicing sale, nothing otherwise; effective date = transfer date. */
export function planMersTransactions(b: { type: TransferType; transfer_date: PlainDate; mins: readonly { min: string; loan_id?: string }[]; partner_org_id: string }): { transactions: MersTxnRow[]; tos: boolean; tob: false; submit_in_batch_of: PlainDate } {
  const txn: MersTxnType | null = b.type === "master_to_sub" || b.type === "sub_to_sub" ? "min_update_subservicer" : b.type === "servicing_sale_with_sub" || b.type === "servicing_sale" ? "tos_confirm" : null;
  const transactions = txn ? b.mins.map((m) => ({ min: m.min, loan_id: m.loan_id ?? null, txn_type: txn, effective_date: b.transfer_date, submitted_by_org_id: txn === "tos_confirm" ? b.partner_org_id : SUPERMORTGAGE_ORG_ID, status: "prepared" as const })) : [];
  return { transactions, tos: txn === "tos_confirm", tob: false, submit_in_batch_of: addBusinessDays(b.transfer_date, -1, servicer) };
}
/** Acknowledgment-file ingestion with events (1.5 timers): `mers.txn.accepted{txn_type, min}` per MIN, `mers.txn.rejected` per reject (→ 1.1 exception), and the batch-level `mers.txn.accepted{txn_type, all_mins=true}` once every planned MIN is accepted. */
export function recordMersAcknowledgement(events: EventStore, batchId: string, rows: readonly MersTxnRow[], results: readonly { min: string; accepted: boolean; reason?: string }[], ackedOn: PlainDate): ReturnType<typeof ingestMersAcknowledgement> & { all_mins: boolean; batch_event: DomainEvent | null } {
  const summary = ingestMersAcknowledgement(results); const MERS: Actor = { kind: "external", id: "mers" };
  const byMin = new Map(rows.map((r) => [r.min, r] as const));
  for (const r of results) {
    const row = byMin.get(r.min); const txn_type = row?.txn_type ?? "min_update_other";
    events.append({ type: r.accepted ? "mers.txn.accepted" : "mers.txn.rejected", ...(row?.loan_id ? { loanId: row.loan_id } : {}), aggregate: { kind: "mers_txn", id: `${batchId}:${r.min}` }, actor: MERS, payload: { batch_id: batchId, min: r.min, txn_type, effective_date: row?.effective_date ?? null, acked_at: ackedOn, all_mins: false, ...(r.accepted ? {} : { reason: r.reason ?? "rejected" }) } });
  }
  const accepted = new Set(results.filter((r) => r.accepted).map((r) => r.min));
  const all = rows.length > 0 && rows.every((r) => accepted.has(r.min));
  const txnTypes = [...new Set(rows.map((r) => r.txn_type))];
  const batch_event = all ? events.append({ type: "mers.txn.accepted", aggregate: AGG(batchId), actor: MERS, payload: { batch_id: batchId, txn_type: txnTypes[0] ?? "min_update_other", all_mins: true, accepted: summary.accepted, rejected: summary.rejected, acked_at: ackedOn } }) : null;
  return { ...summary, all_mins: all, batch_event };
}
/** 1.5 rule 3 / 1.5-T3: before a MIN Update the system-of-record values are compared to the MERS snapshot; a mismatch other than the field being changed blocks the update and opens `mers_qa_findings{mre_mismatch}`. */
export function mreMismatchFinding(sor: Record<string, string>, snapshot: Record<string, string>, changing: readonly string[], min: string, raisedOn: PlainDate): { blocked: boolean; discrepancies: string[]; finding: { kind: "mre_mismatch"; min: string; fields: string[]; raised_at: PlainDate; due_at: PlainDate; resolved_at: null } | null } {
  const discrepancies = Object.keys(sor).filter((k) => !changing.includes(k) && snapshot[k] !== undefined && snapshot[k] !== sor[k]);
  return { blocked: discrepancies.length > 0, discrepancies, finding: discrepancies.length ? { kind: "mre_mismatch", min, fields: discrepancies, raised_at: raisedOn, due_at: addBusinessDays(raisedOn, 5, servicer), resolved_at: null } : null };
}
/** Post-transfer verification (SM_MERS_POST_TRANSFER_VERIFY_3, 1.5-T5): every MIN must show Servicer = partner, Subservicer = Supermortgage, Investor = Fannie Mae; 100% emits `mers.snapshot.verified{all_mins=true}` on the batch. */
export function verifyPostTransferSnapshots(events: EventStore, batchId: string, snapshots: readonly { min: string; status: string; servicer_org_id: string; subservicer_org_id: string | null; investor_org_id: string }[], expected: { partner_org_id: string; mins: readonly string[] }, verifiedOn: PlainDate): { verified: number; total: number; verified_pct: number; all_mins: boolean; issues: { min: string; problems: string[] }[] } {
  const byMin = new Map(snapshots.map((s) => [s.min, s] as const)); const issues: { min: string; problems: string[] }[] = [];
  for (const min of expected.mins) {
    const s = byMin.get(min); const problems: string[] = [];
    if (!s) problems.push("no snapshot");
    else { if (s.status.toLowerCase() !== "active") problems.push(`MIN is ${s.status}`); if (s.servicer_org_id !== expected.partner_org_id) problems.push(`servicer ${s.servicer_org_id} ≠ partner ${expected.partner_org_id}`); if (s.subservicer_org_id !== SUPERMORTGAGE_ORG_ID) problems.push(`subservicer ${s.subservicer_org_id ?? "none"} ≠ ${SUPERMORTGAGE_ORG_ID}`); if (s.investor_org_id !== FANNIE_MAE_MERS_ORG_ID) problems.push(`investor ${s.investor_org_id} ≠ Fannie Mae`); }
    if (problems.length) issues.push({ min, problems });
  }
  const total = expected.mins.length, verified = total - issues.length, all = total > 0 && issues.length === 0;
  events.append({ type: "mers.snapshot.verified", aggregate: AGG(batchId), actor: { kind: "agent", id: "transfer" }, payload: { batch_id: batchId, verified, total, verified_pct: total ? Math.round((10_000 * verified) / total) / 100 : 0, all_mins: all, verified_at: verifiedOn, issues: issues.map((i) => ({ ...i })) } });
  return { verified, total, verified_pct: total ? Math.round((10_000 * verified) / total) / 100 : 0, all_mins: all, issues };
}
/** Rule 7 violation notice (1.5-T7): `mers.violation_notice.received` arms MERS_RULE7_VIOLATION_RESPONSE_30 (+30 CD) and the response is an `officer` act, so the task opens at once. */
export function violationNoticeReceived(events: EventStore, esc: EscalationOpener, notice: { notice_on: PlainDate; org_id: string; description: string; min?: string }, actor: Actor = { kind: "external", id: "merscorp" }): { response_due: PlainDate; officer_task_id: string; finding: { kind: "violation_notice"; raised_at: PlainDate; due_at: PlainDate; resolved_at: null } } {
  const response_due = violationResponseDue(notice.notice_on);
  events.append({ type: "mers.violation_notice.received", aggregate: { kind: "mers_org", id: notice.org_id }, actor, payload: { notice_date: notice.notice_on, org_id: notice.org_id, description: notice.description, min: notice.min ?? null, response_due } });
  const task = esc.open({ kind: "officer", severity: "sev-1", payload: { task: "mers_rule7_violation_response", notice_date: notice.notice_on, response_due, description: notice.description } }, { kind: "agent", id: "transfer" });
  return { response_due, officer_task_id: task.id, finding: { kind: "violation_notice", raised_at: notice.notice_on, due_at: response_due, resolved_at: null } };
}

// ---- 1.6 reconciliation gates -----------------------------------------------------
/** Loan-level reconciliation (1.6-T3): tape money fields must equal the trial balance to the cent before the loan may board. */
export function loanLevelRecon(tape: Record<string, Cents>, trialBalance: Record<string, Cents>): { status: "reconciled" | "variance"; variances: { field: string; tape: Cents; trial_balance: Cents }[]; gate: "SM_RECON_LOAN_LEVEL_T0" } {
  const variances = Object.keys(tape).filter((k) => trialBalance[k] !== undefined && trialBalance[k] !== tape[k]).map((k) => ({ field: k, tape: tape[k]!, trial_balance: trialBalance[k]! }));
  return { status: variances.length ? "variance" : "reconciled", variances, gate: "SM_RECON_LOAN_LEVEL_T0" };
}
export const ESCROW_SETUP_CATEGORIES = ["tax", "hazard", "flood", "mi", "other"] as const;
/** Escrow Setup events (1.6-T9, LL-2026-05): one per escrow category on the boarded loan; `active` waits for every ack. */
export function escrowSetupEvents(loan: { loan_id: string; escrowed: boolean; boarded_on: PlainDate; categories: readonly string[] }): { type: "EscrowSetup"; category: string; loan_id: string }[] {
  if (!loan.escrowed || loan.boarded_on < "2026-12-01") return [];
  return loan.categories.filter((c) => (ESCROW_SETUP_CATEGORIES as readonly string[]).includes(c)).map((category) => ({ type: "EscrowSetup" as const, category, loan_id: loan.loan_id }));
}
export function activeGate(expected: readonly { category: string }[], acked: readonly string[]): { ok: boolean; missing: string[] } {
  const missing = expected.map((e) => e.category).filter((c) => !acked.includes(c));
  return { ok: missing.length === 0, missing };
}
/** `recon.variance.raised` (SM_RECON_VARIANCE_SLA_5 trigger) — the append-only `recon_variances` row with its category; resolution is a later `recon.variance.resolved` on the same subject. */
export function raiseVariance(events: EventStore, v: { variance_id: string; batch_id: string; loan_id?: string | null; field: string; difference_cents: Cents; category: string; reconciliation_id?: string }, raisedOn: PlainDate, actor: Actor = { kind: "agent", id: "custodial-recon" }): DomainEvent {
  return events.append({ type: "recon.variance.raised", ...(v.loan_id ? { loanId: v.loan_id } : {}), aggregate: { kind: "recon_variance", id: v.variance_id }, actor, payload: { variance_id: v.variance_id, batch_id: v.batch_id, loan_id: v.loan_id ?? null, field: v.field, difference_cents: v.difference_cents, category: v.category, reconciliation_id: v.reconciliation_id ?? null, raised_at: raisedOn } });
}
export function resolveVariance(events: EventStore, v: { variance_id: string; loan_id?: string | null; resolution: "transferor_corrected" | "adjusted_with_evidence" | "absorbed_by_transferor" | "absorbed_by_supermortgage" | "written_off_officer"; evidence_document_id?: string | null }, resolvedOn: PlainDate, actor: Actor): DomainEvent {
  return events.append({ type: "recon.variance.resolved", ...(v.loan_id ? { loanId: v.loan_id } : {}), aggregate: { kind: "recon_variance", id: v.variance_id }, actor, payload: { variance_id: v.variance_id, resolution: v.resolution, evidence_document_id: v.evidence_document_id ?? null, resolved_at: resolvedOn, resolved_by: `${actor.kind}:${actor.id}` } });
}
/** `recon.fnma_position.balanced` (SM_RECON_FNMA_POSITION_EOM satisfaction): Σ boarded UPB by servicer number × remittance type = LSDU position after the transferor's transfer-month LAR posts. */
export function fnmaPositionBalanced(events: EventStore, batchId: string, r: { as_of: PlainDate; boarded_upb_cents: Cents; fnma_position_upb_cents: Cents }, actor: Actor = { kind: "agent", id: "custodial-recon" }): DomainEvent | null {
  if (r.boarded_upb_cents !== r.fnma_position_upb_cents) return null;
  return events.append({ type: "recon.fnma_position.balanced", aggregate: AGG(batchId), actor, payload: { batch_id: batchId, as_of: r.as_of, upb_cents: r.boarded_upb_cents } });
}
/** The transferor's post-transfer accounting (FNMA_F1_11_FINAL_ACCOUNTING_30 satisfaction; SM_ADVANCE_REIMBURSE_TRANSFEROR_30 trigger). */
export function finalAccountingReceived(events: EventStore, batchId: string, a: { document_id: string; received_on: PlainDate; advances_claimed_cents: Cents; shortage_surplus_cents: Cents; fnma_adjustment_request_document_id: string | null }): DomainEvent {
  return events.append({ type: "transfer.final_accounting.received", aggregate: AGG(batchId), actor: { kind: "external", id: "transferor_sftp" }, payload: { batch_id: batchId, ...a } });
}

// ---- 1.7 carry-over checks, denial review, rule-set re-issue ---------------------------
/** The transferor's loss-mit file (Bulletin 2020-02 Appendix A §VII): `null` fields are known-absent facts, `undefined` fields were not delivered. */
export interface TransferorLossmitFile {
  readonly application_present?: boolean;
  readonly application_received_on?: PlainDate | null;
  readonly documents?: readonly { name: string; received_on: PlainDate | null }[];
  readonly completeness?: "incomplete" | "facially_complete" | "complete";
  readonly ack_sent_on?: PlainDate | null; readonly ack_copy_document_id?: string | null;
  readonly reasonable_date?: PlainDate | null;
  readonly determination?: { kind: "offer" | "denial"; sent_on: PlainDate; notice_document_id?: string | null; appeal_window_end?: PlainDate } | null;
  readonly appeal_pending?: boolean; readonly appeal?: { received_on: PlainDate; received_by: "transferor" | "transferee" } | null;
  readonly offer?: { option: string; offered_at: PlainDate; acceptance_deadline: PlainDate; terms?: { payment_cents: Cents; rate_pct?: string; term_months?: number } | null } | null;
  readonly trial?: { schedule: readonly { due_on: PlainDate; amount_cents: Cents }[] } | null;
  readonly forbearance_history?: { initial_start_date: PlainDate; cumulative_months: number | null; increments: readonly { start: PlainDate; months: number }[] } | null;
  readonly workout_in_smdu?: boolean; readonly smdu_case_id?: string | null;
}
/** 1.7 data model `lossmit_carryover_checks.check_code`: CO-01 … CO-10 verbatim; `applies` scopes a check to the file's facts, `pass` is the check. */
export const CARRYOVER_CHECKS: readonly { code: string; title: string; applies: (f: TransferorLossmitFile) => boolean; pass: (f: TransferorLossmitFile) => boolean }[] = [
  { code: "CO-01", title: "application present", applies: () => true, pass: (f) => f.application_present !== false },
  { code: "CO-02", title: "received dates present", applies: () => true, pass: (f) => !!f.application_received_on && (f.documents ?? []).every((d) => !!d.received_on) },
  { code: "CO-03", title: "ack copy present", applies: (f) => !!f.ack_sent_on, pass: (f) => !!f.ack_copy_document_id },
  { code: "CO-04", title: "reasonable date present", applies: (f) => !!f.ack_sent_on && f.completeness !== "complete", pass: (f) => !!f.reasonable_date },
  { code: "CO-05", title: "determination notice present", applies: (f) => !!f.determination, pass: (f) => !!f.determination?.notice_document_id && (f.determination.kind !== "denial" || !!f.determination.appeal_window_end) },
  { code: "CO-06", title: "appeal record", applies: (f) => f.appeal_pending === true, pass: (f) => !!f.appeal?.received_on },
  { code: "CO-07", title: "offer terms", applies: (f) => !!f.offer, pass: (f) => !!f.offer?.terms && f.offer.terms.payment_cents > 0n && !!f.offer.acceptance_deadline },
  { code: "CO-08", title: "trial plan schedule", applies: (f) => !!f.trial, pass: (f) => (f.trial?.schedule.length ?? 0) > 0 && f.trial!.schedule.every((m) => !!m.due_on && m.amount_cents > 0n) },
  { code: "CO-09", title: "forbearance cumulative months", applies: (f) => !!f.forbearance_history, pass: (f) => f.forbearance_history?.cumulative_months !== null && f.forbearance_history?.cumulative_months !== undefined && f.forbearance_history.cumulative_months <= 12 },
  { code: "CO-10", title: "SMDU case id", applies: (f) => f.workout_in_smdu === true || !!f.trial, pass: (f) => !!f.smdu_case_id },
];
export interface CarryoverResult { status: "file_verified" | "file_deficient"; checks: { code: string; title: string; result: "pass" | "fail" | "n_a" }[]; failed: string[]; transferor_request_due: PlainDate | null; borrower_request_allowed: false; ask_order: "ask_transferor"; }
/** 1.7 state machine: `inherited_pending` → `file_verified` (all CO-* pass) or `file_deficient` (transferor request within 2 servicer BD; borrower not asked until the transferor fails to produce). */
export function runCarryoverChecks(file: TransferorLossmitFile | null, boardedOn: PlainDate): CarryoverResult {
  const checks = CARRYOVER_CHECKS.map((c) => ({ code: c.code, title: c.title, result: !file ? (c.code === "CO-01" ? "fail" as const : "n_a" as const) : !c.applies(file) ? "n_a" as const : c.pass(file) ? "pass" as const : "fail" as const }));
  const failed = checks.filter((c) => c.result === "fail").map((c) => c.code);
  return { status: failed.length ? "file_deficient" : "file_verified", checks, failed, transferor_request_due: failed.length ? addBusinessDays(boardedOn, 2, servicer) : null, borrower_request_allowed: false, ask_order: "ask_transferor" };
}
/** The checks with their events: `lossmit.carryover.verified` (SM_LOSSMIT_FILE_VERIFY_T0 satisfaction, per case) or `lossmit.carryover.deficient` (SM_LOSSMIT_MISSING_DOCS_TRANSFEROR_2 trigger). */
export function verifyCarryover(events: EventStore, c: { case_id: string; loan_id: string }, file: TransferorLossmitFile | null, boardedOn: PlainDate, actor: Actor = { kind: "agent", id: "lossmit-underwriter" }): CarryoverResult & { event: DomainEvent } {
  const r = runCarryoverChecks(file, boardedOn);
  const event = events.append({ type: r.status === "file_verified" ? "lossmit.carryover.verified" : "lossmit.carryover.deficient", loanId: c.loan_id, aggregate: { kind: "case", id: c.case_id }, actor, payload: { case_id: c.case_id, checks: r.checks.map((x) => ({ ...x })), failed: [...r.failed], raised_at: boardedOn, ...(r.transferor_request_due ? { transferor_request_due: r.transferor_request_due } : {}) } });
  return { ...r, event };
}
/** `lossmit.transferor_request.sent` (SM_LOSSMIT_MISSING_DOCS_TRANSFEROR_2 satisfaction): the missing CO-* items are requested from the transferor before any borrower contact (comment 41(k)(1)(i)-1; Bulletin 2020-02). */
export function requestFromTransferor(events: EventStore, c: { case_id: string; loan_id: string }, items: readonly string[], sentOn: PlainDate, actor: Actor = { kind: "agent", id: "lossmit-underwriter" }): { request_id: string; items: string[]; sent_on: PlainDate; respond_by: PlainDate; borrower_asked: false } {
  const req = { request_id: `xfer-req:${c.case_id}:${sentOn}`, items: [...items], sent_on: sentOn, respond_by: addBusinessDays(sentOn, 5, servicer), borrower_asked: false as const };
  events.append({ type: "lossmit.transferor_request.sent", loanId: c.loan_id, aggregate: { kind: "case", id: c.case_id }, actor, payload: { case_id: c.case_id, ...req } });
  return req;
}
/** After the transferor fails to respond by the request deadline, the borrower may be asked (comment 41(k)(1)(i)-1). */
export function borrowerRequestAllowed(transferorRequestDue: PlainDate, transferorResponded: boolean, today: PlainDate): boolean { return !transferorResponded && today > transferorRequestDue; }
export type LossmitCaseStatus = "inherited_pending" | "file_verified" | "file_deficient" | "ack_required" | "ack_sent" | "incomplete" | "complete" | "complete_at_transfer" | "under_evaluation" | "determined" | "offer_pending_acceptance" | "accepted" | "plan_active" | "trial_in_progress" | "rejected" | "expired" | "appeal_pending" | "appeal_determined" | "appeal_as_pending_complete" | "not_pending" | "closed";
export interface InheritedOffer { readonly option: string; readonly offered_at: PlainDate; readonly acceptance_deadline: PlainDate; readonly terms: { payment_cents: Cents; rate_pct?: string; term_months?: number }; }
/** 1.7-T4 / (k)(5): a transferor offer accepted (to either servicer) within the unexpired balance is honored on its original terms — `offer_pending_acceptance` → `accepted` → `plan_active` with no re-underwriting; later acceptance → `expired`. */
export function honorTransferorOfferCase(c: { case_id: string; status: LossmitCaseStatus; offer: InheritedOffer }, acceptance: { accepted_on: PlainDate; received_by: "transferor" | "transferee" }): { case_id: string; status: LossmitCaseStatus; transitions: LossmitCaseStatus[]; re_underwritten: false; option: string; terms: InheritedOffer["terms"]; honored: boolean } {
  if (c.status !== "offer_pending_acceptance") throw new RangeError(`case ${c.case_id} is ${c.status}, not offer_pending_acceptance`);
  if (acceptance.accepted_on > c.offer.acceptance_deadline) return { case_id: c.case_id, status: "expired", transitions: ["expired"], re_underwritten: false, option: c.offer.option, terms: c.offer.terms, honored: false };
  return { case_id: c.case_id, status: "plan_active", transitions: ["accepted", "plan_active"], re_underwritten: false, option: c.offer.option, terms: c.offer.terms, honored: true };
}
/** An appeal on an inherited case (§1024.41(k)(4)): `lossmit.appeal.received` (or `.pending_at_transfer`) carries the later of the transfer date and the appeal date as `k4_anchor_date` for REGX_1024_41K4_APPEAL_DETERMINATION_30. */
export function appealReceived(events: EventStore, c: { case_id: string; loan_id: string; transfer_date: PlainDate; appeal_received_on: PlainDate; received_by: "transferor" | "transferee"; pending_at_transfer?: boolean }, actor: Actor = { kind: "agent", id: "lossmit-underwriter" }): { determination_due: PlainDate; k4_anchor_date: PlainDate; event: DomainEvent } {
  const anchor = c.appeal_received_on > c.transfer_date ? c.appeal_received_on : c.transfer_date;
  const event = events.append({ type: c.pending_at_transfer ? "lossmit.appeal.pending_at_transfer" : "lossmit.appeal.received", loanId: c.loan_id, aggregate: { kind: "case", id: c.case_id }, actor, payload: { case_id: c.case_id, transfer_date: c.transfer_date, appeal_received_at: c.appeal_received_on, received_by: c.received_by, k4_anchor_date: anchor } });
  return { determination_due: addDays(anchor, 30), k4_anchor_date: anchor, event };
}
/** 1.7-T3 / §1024.41(h)(3), decision 4: the appeal reviewer is a `lossmit_reviewer` not previously involved in the case (any Supermortgage evaluator or reviewer on it). */
export function assignAppealReviewer(caseParticipants: readonly { id: string; role: "evaluator" | "reviewer" | "agent" }[], reviewers: readonly { id: string; role: string }[]): { reviewer_id: string; excluded: string[] } {
  const involved = new Set(caseParticipants.map((p) => p.id));
  const pick = reviewers.find((r) => r.role === "lossmit_reviewer" && !involved.has(r.id));
  if (!pick) throw new RangeError("no lossmit_reviewer independent of the case's evaluators is available (§1024.41(h)(3))");
  return { reviewer_id: pick.id, excluded: [...involved] };
}
void addMonths;
/** Denial review gate (1.7-T9): an AI-proposed denial cannot go out without a `lossmit_reviewer` approval record. */
export function denialSendGate(determination: { kind: "offer" | "denial"; proposed_by: Actor }, approval: { by: Actor; decision_id: string } | null): { ok: boolean; block: string | null } {
  if (determination.kind !== "denial" || determination.proposed_by.kind !== "agent") return { ok: true, block: null };
  if (approval && approval.by.kind === "human" && approval.by.role === "lossmit_reviewer") return { ok: true, block: null };
  return { ok: false, block: "denial proposed by the AI needs a lossmit_reviewer approval record before the determination notice is sent" };
}
/** Rule-set switch (1.7-T10): inherited cases keep `deemed_received_at`; their open (k) timers are cancelled with reason `rule_set_change` and re-issued under the new definitions. */
export function reissueTimersForRuleSet(engine: TimerEngine, registry: TimerRegistry, events: EventStore, loanId: string, boarded: DomainEvent, newRuleSet: string, actor: Actor): { cancelled: string[]; reissued: string[]; deemed_received_at: unknown } {
  const open = engine.forSubject("loan", loanId).filter((t) => (t.status === "armed" || t.status === "breached") && /^REGX_1024_41/.test(t.code));
  const cancelled: string[] = [], reissued: string[] = [];
  for (const t of open) { engine.cancel(t.id, "rule_set_change", actor); cancelled.push(t.code); }
  const trigger = events.append({ type: "lossmit.rule_set.changed", loanId, actor, causationId: boarded.id, payload: { ...boarded.payload, rule_set: newRuleSet, deemed_received_at: (boarded.payload as { deemed_received_at?: unknown }).deemed_received_at ?? null } });
  for (const code of cancelled) { const def = registry.get(code); if (def) { engine.arm(def, trigger); reissued.push(code); } }
  return { cancelled, reissued, deemed_received_at: (boarded.payload as { deemed_received_at?: unknown }).deemed_received_at ?? null };
}
