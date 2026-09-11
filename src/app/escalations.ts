/**
 * Escalations — what a guardrail refusal, a breach or a "human act" opens
 * for a person (`escalations` table, 0019). Each carries the package the
 * role needs to decide without re-deriving anything, the SLA timer that
 * watches it, and the evidence document that closes it.
 */
import { randomUUID } from "node:crypto";
import type { Actor, EventStore } from "../kernel/events/index.ts";
import type { Queryable } from "../infra/db/client.ts";
import { toJson } from "../infra/db/client.ts";

export type EscalationKind = "human_portal_task" | "officer" | "attorney" | "signing_officer" | "lossmit_reviewer" | "fraud_officer" | "human_agent" | "sev1" | "sev2" | "sev3" | "sev4"
  | "mlo_of_record" | "underwriting_reviewer" | "notary" | "settlement_agent" | "closing_attorney" | "appraiser" | "property_data_collector" | "funding_approver" | "bsa_officer" | "qc_officer" | "licensed_specialist";
export interface Escalation {
  readonly id: string; readonly kind: EscalationKind; readonly ownerRole: string; readonly loanId?: string; readonly applicationId?: string; readonly caseId?: string; readonly batchId?: string; readonly severity?: string;
  readonly openedAt: string; readonly openedBy: string; readonly payload: Record<string, unknown>; readonly slaTimerId?: string;
  status: "open" | "completed"; completedAt?: string; completedBy?: string; evidenceDocumentId?: string;
}
export interface EscalationInput { readonly kind: EscalationKind; readonly ownerRole?: string; readonly loanId?: string; readonly applicationId?: string; readonly caseId?: string; readonly batchId?: string; readonly severity?: string; readonly payload?: Record<string, unknown>; readonly slaTimerId?: string; }

const DEFAULT_ROLE: Record<EscalationKind, string> = { human_portal_task: "fnma_portal_operator", officer: "officer", attorney: "attorney", signing_officer: "signing_officer", lossmit_reviewer: "lossmit_reviewer", fraud_officer: "fraud_officer", human_agent: "human_agent", sev1: "officer", sev2: "officer", sev3: "ops_analyst", sev4: "ops_analyst",
  mlo_of_record: "mlo_of_record", underwriting_reviewer: "underwriting_reviewer", notary: "notary", settlement_agent: "settlement_agent", closing_attorney: "closing_attorney", appraiser: "appraiser", property_data_collector: "property_data_collector", funding_approver: "funding_approver", bsa_officer: "bsa_officer", qc_officer: "qc_officer", licensed_specialist: "licensed_specialist" };

export class EscalationService {
  private readonly events: EventStore;
  private readonly clock: { now(): string };
  readonly opened: Escalation[] = [];
  constructor(events: EventStore, clock: { now(): string }) { this.events = events; this.clock = clock; }
  open(input: EscalationInput, by: Actor): Escalation {
    const e: Escalation = { id: randomUUID(), kind: input.kind, ownerRole: input.ownerRole ?? DEFAULT_ROLE[input.kind], openedAt: this.clock.now(), openedBy: `${by.kind}:${by.id}`, payload: input.payload ?? {}, status: "open",
      ...(input.loanId ? { loanId: input.loanId } : {}), ...(input.applicationId ? { applicationId: input.applicationId } : {}), ...(input.caseId ? { caseId: input.caseId } : {}), ...(input.batchId ? { batchId: input.batchId } : {}), ...(input.severity ? { severity: input.severity } : {}), ...(input.slaTimerId ? { slaTimerId: input.slaTimerId } : {}) };
    this.opened.push(e);
    this.events.append({ type: "escalation.created", ...(e.loanId ? { loanId: e.loanId } : {}), ...(e.applicationId ? { applicationId: e.applicationId } : {}), aggregate: { kind: "escalation", id: e.id }, actor: by, payload: { escalation_id: e.id, kind: e.kind, owner_role: e.ownerRole, severity: e.severity ?? null, ...e.payload } });
    return e;
  }
  /** Every escalation opened through this service (open and completed), oldest first. */
  list(): readonly Escalation[] { return this.opened; }
  complete(id: string, by: Actor, evidenceDocumentId?: string): Escalation {
    const e = this.opened.find((x) => x.id === id); if (!e) throw new RangeError(`no escalation ${id}`);
    if (by.kind !== "human" || by.role !== e.ownerRole) throw new RangeError(`escalation ${id} is completed by role ${e.ownerRole}, not ${by.kind}:${by.id}${by.role ? ` (${by.role})` : ""}`);
    e.status = "completed"; e.completedAt = this.clock.now(); e.completedBy = by.id; if (evidenceDocumentId) e.evidenceDocumentId = evidenceDocumentId;
    this.events.append({ type: "escalation.completed", ...(e.loanId ? { loanId: e.loanId } : {}), ...(e.applicationId ? { applicationId: e.applicationId } : {}), aggregate: { kind: "escalation", id: e.id }, actor: by, payload: { escalation_id: e.id, kind: e.kind, evidence_document_id: evidenceDocumentId ?? null } });
    return e;
  }
}

export class PgEscalationRepository {
  private readonly db: Queryable;
  constructor(db: Queryable) { this.db = db; }
  async save(e: Escalation, q: Queryable = this.db): Promise<void> {
    await q.query(`INSERT INTO escalations (id, kind, loan_id, case_id, batch_id, severity, owner_role, sla_timer_id, opened_at, opened_by, completed_at, completed_evidence_document_id, payload, application_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14)
      ON CONFLICT (id) DO UPDATE SET completed_at = EXCLUDED.completed_at, completed_evidence_document_id = EXCLUDED.completed_evidence_document_id`,
      [e.id, e.kind, e.loanId || null, e.caseId ?? null, e.batchId ?? null, e.severity ?? null, e.ownerRole, e.slaTimerId ?? null, e.openedAt, e.openedBy, e.completedAt ?? null, e.evidenceDocumentId ?? null, toJson(e.payload), e.applicationId ?? null]);
  }
  async open(ownerRole?: string): Promise<{ id: string; kind: string; owner_role: string; loan_id: string | null; opened_at: string }[]> {
    return ownerRole ? this.db.query(`SELECT id, kind, owner_role, loan_id, opened_at FROM escalations WHERE owner_role = $1 AND completed_at IS NULL ORDER BY opened_at`, [ownerRole])
      : this.db.query(`SELECT id, kind, owner_role, loan_id, opened_at FROM escalations WHERE completed_at IS NULL ORDER BY opened_at`);
  }
}
