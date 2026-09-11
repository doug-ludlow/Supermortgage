/**
 * `agent_decisions` repository — the AI-first audit trail. Append-only in the
 * database (trigger); every decision cites the rule set version, evidence and
 * rationale, and names the human approver when a role gate applied.
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "./client.ts";

export interface DecisionInput {
  readonly agent: string;
  readonly action: string;
  readonly rationale: string;
  readonly ruleSetVersion: string;
  readonly loanId?: string;
  readonly applicationId?: string;
  readonly subject?: { readonly kind: string; readonly id: string };
  readonly ruleCode?: string;
  readonly evidenceDocumentIds?: readonly string[];
  readonly confidence?: number | null;
  readonly modelVersion?: string | null;
  readonly promptVersion?: string | null;
  readonly approvedBy?: string;
  readonly approvedRole?: string;
  readonly eventId?: string;
}

export interface DecisionRecord extends DecisionInput { readonly id: string; readonly createdAt: string; }

interface Row extends Record<string, unknown> {
  id: string; agent: string; loan_id: string | null; application_id: string | null; subject_kind: string | null; subject_id: string | null; rule_code: string | null; action: string; evidence_document_ids: string[];
  confidence: string | null; rule_set_version: string; model_version: string | null; prompt_version: string | null; rationale: string; approved_by: string | null; approved_role: string | null; event_id: string | null; created_at: string;
}

function rowToRecord(r: Row): DecisionRecord {
  return {
    id: r.id, agent: r.agent, action: r.action, rationale: r.rationale, ruleSetVersion: r.rule_set_version, createdAt: r.created_at,
    evidenceDocumentIds: r.evidence_document_ids, confidence: r.confidence === null ? null : Number(r.confidence), modelVersion: r.model_version, promptVersion: r.prompt_version,
    ...(r.loan_id ? { loanId: r.loan_id } : {}), ...(r.application_id ? { applicationId: r.application_id } : {}), ...(r.subject_kind && r.subject_id ? { subject: { kind: r.subject_kind, id: r.subject_id } } : {}), ...(r.rule_code ? { ruleCode: r.rule_code } : {}),
    ...(r.approved_by ? { approvedBy: r.approved_by } : {}), ...(r.approved_role ? { approvedRole: r.approved_role } : {}), ...(r.event_id ? { eventId: r.event_id } : {}),
  };
}

export class PgDecisionRepository {
  private readonly db: Queryable;
  constructor(db: Queryable) { this.db = db; }

  async record(d: DecisionInput, q: Queryable = this.db, id: string = randomUUID()): Promise<DecisionRecord> {
    const rows = await q.query<Row>(
      `INSERT INTO agent_decisions (id, agent, loan_id, subject_kind, subject_id, rule_code, action, evidence_document_ids, confidence, rule_set_version, model_version, prompt_version, rationale, approved_by, approved_role, event_id, application_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid[], $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING *`,
      [id, d.agent, d.loanId || null, d.subject?.kind ?? null, d.subject?.id ?? null, d.ruleCode ?? null, d.action, [...(d.evidenceDocumentIds ?? [])], d.confidence ?? null, d.ruleSetVersion,
        d.modelVersion ?? null, d.promptVersion ?? null, d.rationale, d.approvedBy ?? null, d.approvedRole ?? null, d.eventId ?? null, d.applicationId ?? null]);
    return rowToRecord(rows[0]!);
  }
  async byApplication(applicationId: string): Promise<DecisionRecord[]> {
    return (await this.db.query<Row>(`SELECT * FROM agent_decisions WHERE application_id = $1 ORDER BY created_at`, [applicationId])).map(rowToRecord);
  }
  async byLoan(loanId: string): Promise<DecisionRecord[]> {
    return (await this.db.query<Row>(`SELECT * FROM agent_decisions WHERE loan_id = $1 ORDER BY created_at`, [loanId])).map(rowToRecord);
  }
  async get(id: string): Promise<DecisionRecord | undefined> {
    const rows = await this.db.query<Row>(`SELECT * FROM agent_decisions WHERE id = $1`, [id]);
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }
}
