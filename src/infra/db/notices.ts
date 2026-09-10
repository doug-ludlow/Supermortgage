/** Notice Registry persistence: notice_templates / notice_template_versions / notices / notice_checklist_results / notice_deliveries. */
import type { Queryable } from "./client.ts";
import { toJson } from "./client.ts";
import type { NoticeTemplate, TemplateVersion } from "../../notices/registry.ts";
import type { Notice } from "../../notices/service.ts";

export class PgNoticeRepository {
  private readonly db: Queryable;
  constructor(db: Queryable) { this.db = db; }

  async upsertTemplate(t: NoticeTemplate, q: Queryable = this.db): Promise<void> {
    await q.query(`INSERT INTO notice_templates (code, name, citation, owner_section, notice_class, channel_policy, separate_document, may_combine_with, pii_level) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, citation = EXCLUDED.citation, owner_section = EXCLUDED.owner_section, notice_class = EXCLUDED.notice_class, channel_policy = EXCLUDED.channel_policy, separate_document = EXCLUDED.separate_document, may_combine_with = EXCLUDED.may_combine_with, pii_level = EXCLUDED.pii_level`,
      [t.code, t.name, t.citation, t.ownerSection, t.noticeClass, t.channelPolicy, t.separateDocument, [...t.mayCombineWith], t.piiLevel]);
  }
  /** Versions are immutable once approved: an approved row is never updated; a draft may be re-saved. */
  async saveVersion(v: TemplateVersion, q: Queryable = this.db): Promise<void> {
    const rows = await q.query<{ plain_language_status: string }>(`SELECT plain_language_status FROM notice_template_versions WHERE template_code = $1 AND version = $2`, [v.templateCode, v.version]);
    if (rows[0]?.plain_language_status === "counsel_approved" && v.plainLanguageStatus !== "retired") return;
    await q.query(`INSERT INTO notice_template_versions (template_code, version, effective_from, effective_to, source_hash, sample_form_basis, content_rules, layout_rules, readability, plain_language_status, approved_by, approved_at, rule_set)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12, $13)
      ON CONFLICT (template_code, version) DO UPDATE SET effective_to = EXCLUDED.effective_to, plain_language_status = EXCLUDED.plain_language_status, approved_by = EXCLUDED.approved_by, approved_at = EXCLUDED.approved_at`,
      [v.templateCode, v.version, v.effectiveFrom, v.effectiveTo ?? null, v.sourceHash, v.sampleFormBasis ?? null, toJson(v.contentRules), toJson(v.layoutRules), v.readability ? toJson(v.readability) : null, v.plainLanguageStatus, v.approvedBy ?? null, v.approvedAt ?? null, v.ruleSet]);
  }
  async saveNotice(n: Notice, q: Queryable = this.db): Promise<void> {
    await q.query(`INSERT INTO notices (id, template_code, template_version, loan_id, case_id, recipient_party_ids, address_snapshot, payload_hash, payload, channel_decision, status, held_reason, produced_at, sent_at, superseded_by)
      VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7::jsonb, $8, $9::jsonb, $10::jsonb, $11, $12, $13, $14, $15)
      ON CONFLICT (id) DO UPDATE SET channel_decision = EXCLUDED.channel_decision, status = EXCLUDED.status, held_reason = EXCLUDED.held_reason, sent_at = EXCLUDED.sent_at, superseded_by = EXCLUDED.superseded_by`,
      [n.id, n.templateCode, n.templateVersion, n.loanId ?? null, n.caseId ?? null, n.recipients.map((r) => r.partyId).filter((p) => /^[0-9a-f-]{36}$/i.test(p)), toJson(n.recipients.map((r) => ({ party_id: r.partyId, name: r.name, address: r.mailingAddress }))),
        n.payloadHash, toJson(n.payload), n.channelDecision ? toJson(n.channelDecision) : null, n.status, n.heldReason ?? null, n.producedAt, n.sentAt ?? null, n.supersededBy ?? null]);
    await q.query(`INSERT INTO notice_checklist_results (notice_id, template_version, passed, results) VALUES ($1, $2, $3, $4::jsonb)`, [n.id, n.templateVersion, n.checklist.passed, toJson(n.checklist.results)]);
    for (const d of n.deliveries) {
      await q.query(`INSERT INTO notice_deliveries (notice_id, attempt_no, channel, vendor, vendor_piece_id, submitted_at, mailed_at, email_status, returned_at, return_reason) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (notice_id, attempt_no) DO UPDATE SET mailed_at = EXCLUDED.mailed_at, email_status = EXCLUDED.email_status, returned_at = EXCLUDED.returned_at, return_reason = EXCLUDED.return_reason`,
        [n.id, d.attemptNo, d.channel, d.vendor, d.vendorPieceId, d.submittedAt, d.mailedAt ?? null, d.emailStatus ?? null, d.returnedAt ?? null, d.returnReason ?? null]);
    }
  }
  async statusOf(id: string): Promise<{ status: string; template_version: string; payload_hash: string } | undefined> {
    const rows = await this.db.query<{ status: string; template_version: string; payload_hash: string }>(`SELECT status, template_version, payload_hash FROM notices WHERE id = $1`, [id]);
    return rows[0];
  }
}
