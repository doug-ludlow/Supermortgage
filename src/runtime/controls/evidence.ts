/**
 * 34.4 rule 5 — the evidence pack (18.2 / 19.1): for a loan, an application, a person or a period, the STORED ROWS —
 * events, decisions, notices (the row, its checklist results, its deliveries, the rendered text the runtime holds and the
 * rendered document's id and hash), timers with their histories (the timer.* events), escalations (with their completion
 * receipts), ledger sets with their lines (loan subjects), agent turns (model and prompt versions, guard results, the tool
 * names — never the context), consents, verification and credit-report metadata (application subjects: the row's fields only,
 * never the report's scores, factors, tradelines or accounts — what 22.2 / 22.3 store as fields), the partner-book rows
 * (facts, invitations as hashes and dates, reviews, readiness checks), and the staff actions on the subject — each set as
 * `to_jsonb(row)` from Postgres, with a count and a sha256 of its JSON; one pack document with a sha256; the events in parts
 * of at most `EVENT_PART_SIZE` (100,000) rows, each part its own document, the manifest naming every part.
 *
 * PACK_IS_STORED_ROWS: nothing here is computed, estimated or summarized; a figure in the pack is a figure in a row. The
 * 18.2 review file (src/domain/qc-audit/ops.ts compileReviewFile) hashes a document the same way (sha256 of the text);
 * `verifyEvidencePack` re-reads the rows and checks the stored hashes — the pack is reproducible from the records.
 *
 * Produced by `compliance` (the tool's role gate in src/app/tools/section34-4.ts; the runtime function takes the actor for the
 * row's `produced_by` and the event). `evidence.pack.produced{pack_id, subject, sha256, by}` is logged.
 *
 * A PARTY subject is the one-person pack 34.2 rule 5 names ("Export is the evidence pack for one person — 34.4's layout
 * restricted to the party"; review finding: one layout for a person): the rows are scoped the directory's way
 * (src/runtime/directory/scope.ts — the person's loans and applications, a row on a shared subject only when it names no other
 * party), the `directory` section carries the person's own directory rows (sessions, the thread, cards and their transitions,
 * unmasks, earlier exports — selected column by column so no token hash, vendor payload or raw cell enters), and every row set
 * passes the directory's NO_SECRETS / NO_FULL_SSN pass (src/runtime/directory/mask.ts stripSecrets, deterministic — the
 * verification re-reads through the same pass). `retain: "metadata"` keeps the document text with its `documents` row (the
 * console's blob store is not on the runtime's path) so the pack reads back and verifies through GET …/controls/evidence/{id}.
 */
import { randomUUID } from "node:crypto";
import type { Actor } from "../../kernel/events/index.ts";
import type { Queryable } from "../../infra/db/client.ts";
import { toJson } from "../../infra/db/client.ts";
import type { Runtime } from "../app.ts";
import { stripSecrets } from "../directory/mask.ts";
import { ownPartyDecisionPredicate, ownPartyEventPredicate, partyScope } from "../directory/scope.ts";
import { CONTROLS_RULE_SET_VERSION, ControlsRefused, appendEvent, isUuid, rowJson, sha256Hex, type Row } from "./common.ts";

export const EVENT_PART_SIZE = 100_000;
/** The row sets; `directory` (34.2 rule 5) holds a party subject's own directory rows and is empty for every other subject. */
export const EVIDENCE_SECTIONS = ["events", "decisions", "notices", "timers", "escalations", "ledger_sets", "agent_turns", "consents", "verifications", "credit_reports", "partner_book", "staff_actions", "directory"] as const;
export type EvidenceSection = (typeof EVIDENCE_SECTIONS)[number];
export const PACK_DOCUMENT_KIND = "evidence_pack"; export const PART_DOCUMENT_KIND = "evidence_pack_part";
export type EvidenceSubject = { readonly loan_id: string } | { readonly application_id: string } | { readonly party_id: string } | { readonly period: { readonly from: string; readonly to: string } };
export interface EvidenceRequest { readonly subject: EvidenceSubject; readonly sections?: readonly string[] | null; readonly produced_by: Actor; /** tests split smaller; production is the constant */ readonly part_size?: number; /** "metadata": the document text (and each part's) rides in its documents row's metadata — 34.2's export, produced where no blob store is wired */ readonly retain?: "metadata" | null; }
export interface ManifestSection { readonly name: EvidenceSection; readonly count: number; readonly sha256: string; readonly detail?: Record<string, number>; }
export interface ManifestPart { readonly part: number; readonly document_id: string; readonly sha256: string; readonly byte_size: number; readonly event_count: number; readonly from_sequence: number | null; readonly to_sequence: number | null; }
export interface EvidenceManifest { readonly pack_id: string; readonly subject: { kind: string; id: string | null; from_date: string | null; to_date: string | null }; readonly produced_at: string; readonly produced_by: string; readonly produced_role: string | null; readonly rule_set_version: string; readonly sections: readonly ManifestSection[]; readonly parts: readonly ManifestPart[]; readonly part_count: number; readonly part_size: number; readonly sets_sha256: string; }
export interface EvidencePackRow { readonly id: string; readonly subject_kind: string; readonly subject_id: string | null; readonly from_date: string | null; readonly to_date: string | null; readonly sections: readonly string[]; readonly manifest: EvidenceManifest; readonly document_id: string | null; readonly sha256: string; readonly produced_by: string | null; readonly created_at: string; }
export interface EvidencePackResult extends EvidencePackRow { readonly part_count: number; readonly byte_size: number; readonly document: string; readonly parts: readonly { part: number; document_id: string; sha256: string; byte_size: number; content: string }[]; }

type Sets = Record<string, unknown[]>;
/** A party subject's scope (src/runtime/directory/scope.ts partyScope): the ids the person's rows key on; empty for a party that is not a borrower's. */
interface PartyIds { readonly loan_ids: readonly string[]; readonly application_ids: readonly string[]; readonly borrower_ids: readonly string[]; readonly conversation_id: string | null }
interface Subject { readonly kind: "loan" | "application" | "party" | "period"; readonly id: string | null; readonly from: string | null; readonly to: string | null; readonly scope: PartyIds | null }
const NO_SCOPE: PartyIds = { loan_ids: [], application_ids: [], borrower_ids: [], conversation_id: null };
const subjectOf = (sub: EvidenceSubject): Subject => {
  if ("loan_id" in sub) { if (!isUuid(sub.loan_id)) throw new ControlsRefused(400, "BAD_SUBJECT", "loan_id is a uuid"); return { kind: "loan", id: sub.loan_id, from: null, to: null, scope: null }; }
  if ("application_id" in sub) { if (!isUuid(sub.application_id)) throw new ControlsRefused(400, "BAD_SUBJECT", "application_id is a uuid"); return { kind: "application", id: sub.application_id, from: null, to: null, scope: null }; }
  if ("party_id" in sub) { if (!isUuid(sub.party_id)) throw new ControlsRefused(400, "BAD_SUBJECT", "party_id is a uuid"); return { kind: "party", id: sub.party_id, from: null, to: null, scope: NO_SCOPE }; }
  const p = sub.period; if (!p || !/^\d{4}-\d{2}-\d{2}$/.test(p.from ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(p.to ?? "") || p.from > p.to) throw new ControlsRefused(400, "BAD_SUBJECT", "period is {from, to} as YYYY-MM-DD with from ≤ to");
  return { kind: "period", id: null, from: p.from, to: p.to, scope: null };
};
/** The subject with a party's scope resolved (the person's loans, applications, borrower rows and conversation — the directory's own resolution). */
async function resolveSubject(rt: Runtime, sub: EvidenceSubject): Promise<Subject> {
  const r = subjectOf(sub);
  if (r.kind !== "party") return r;
  const sc = await partyScope(rt.db, r.id!);
  return { ...r, scope: sc ? { loan_ids: sc.loan_ids, application_ids: sc.application_ids, borrower_ids: sc.borrower_ids, conversation_id: sc.conversation_id } : NO_SCOPE };
}
export const parseSubject = (v: unknown): EvidenceSubject => {
  const o = (v && typeof v === "object" ? v : {}) as Row;
  if (typeof o["loan_id"] === "string") return { loan_id: o["loan_id"] as string };
  if (typeof o["application_id"] === "string") return { application_id: o["application_id"] as string };
  if (typeof o["party_id"] === "string") return { party_id: o["party_id"] as string };
  const p = o["period"] as Row | undefined; if (p && typeof p === "object") return { period: { from: String(p["from"] ?? ""), to: String(p["to"] ?? "") } };
  throw new ControlsRefused(400, "BAD_SUBJECT", "subject is {loan_id} | {application_id} | {party_id} | {period: {from, to}}");
};

/** The credit-report and verification rows as fields only (22.2 / 22.3): the report's contents are not columns of the pack. */
const CREDIT_REPORT_CONTENT = ["scores", "borrower_applicable_scores", "key_factors", "inquiries_90d", "disputed_tradelines", "public_records", "mortgage_tradelines", "collections", "fraud_alerts"];
const VERIFICATION_CONTENT = ["accounts", "large_deposit_messages"];
const minus = (cols: readonly string[]): string => cols.map((c) => ` - '${c}'`).join("");
const jsonRows = async (q: Queryable, sql: string, p: readonly unknown[]): Promise<unknown[]> => (await q.query<{ row: unknown }>(sql, p)).map((r) => r.row);

/** The row sets for a subject; the events are read separately in sequence order (they part). */
async function collectSets(rt: Runtime, sub: Subject, wanted: ReadonlySet<EvidenceSection>): Promise<{ sets: Sets; detail: Record<string, Record<string, number>> }> {
  const db = rt.db; const sets: Sets = {}; const detail: Record<string, Record<string, number>> = {};
  const id = sub.id; const from = sub.from; const toExcl = sub.to ? `(($2::date + interval '1 day')::timestamptz)` : "";
  // a party subject (34.2 rule 5): $1 the party, $2 its loans, $3 its applications, $4 its borrower rows, $5 its conversation — a row on a shared loan or application only when it names no other party
  const sc = sub.scope ?? NO_SCOPE; const P5: unknown[] = [id, sc.loan_ids, sc.application_ids, sc.borrower_ids, sc.conversation_id];
  const NONE = { sql: `SELECT to_jsonb(x) AS row FROM (SELECT 1 AS none WHERE false) x`, p: [] as unknown[] };
  // Postgres binds exactly the parameters a statement references (and types every one): a party query is renumbered to the placeholders it uses and bound to those of P5
  const bound = (sql: string): { sql: string; p: unknown[] } => {
    const used = [...new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
    const renumber = new Map(used.map((n, i) => [n, i + 1]));
    return { sql: sql.replace(/\$(\d+)/g, (_m, n: string) => `$${renumber.get(Number(n))}`), p: used.map((n) => P5[n - 1]) };
  };
  // the subject predicates per table — every row set is keyed by the subject's own column, so no row of another loan or person enters (T5)
  const P: Record<string, { sql: string; p: unknown[] }> = (() => {
    switch (sub.kind) {
      case "loan": return {
        decisions: { sql: `SELECT to_jsonb(d) AS row FROM agent_decisions d WHERE d.loan_id = $1::uuid ORDER BY d.created_at, d.id`, p: [id] },
        notices: { sql: `SELECT to_jsonb(n) AS row FROM notices n WHERE n.loan_id = $1::uuid ORDER BY n.produced_at, n.id`, p: [id] },
        timers: { sql: `SELECT to_jsonb(t) AS row FROM timers t WHERE t.loan_id = $1::uuid ORDER BY t.armed_at, t.id`, p: [id] },
        escalations: { sql: `SELECT to_jsonb(e) AS row FROM escalations e WHERE e.loan_id = $1::uuid ORDER BY e.opened_at, e.id`, p: [id] },
        ledger_sets: { sql: `SELECT to_jsonb(x) AS row FROM (SELECT s.*, (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.sequence) FROM ledger_lines l WHERE l.set_id = s.id) AS lines FROM ledger_entry_sets s WHERE EXISTS (SELECT 1 FROM ledger_lines l WHERE l.set_id = s.id AND l.loan_id = $1::uuid) ORDER BY s.posted_at, s.id) x`, p: [id] },
        agent_turns: { sql: `SELECT to_jsonb(x) AS row FROM (SELECT t.turn_id, t.conversation_id, t.party_id, t.session_id, t.message_id, t.reply_message_id, t.channel, t.ai_system_version_id, t.model_version, t.prompt_version, t.tier, t.context_hash, t.safe_classification, t.guard_result, t.latency_ms, t.tokens_in, t.tokens_out, t.created_at, (SELECT coalesce(jsonb_agg(c->>'name'), '[]'::jsonb) FROM jsonb_array_elements(t.tool_calls) c) AS tool_names FROM agent_turns t WHERE t.party_id IN (SELECT b.party_id FROM loan_borrowers lb JOIN borrowers b ON b.id = lb.borrower_id WHERE lb.loan_id = $1::uuid AND b.party_id IS NOT NULL) ORDER BY t.created_at, t.turn_id) x`, p: [id] },
        consents: { sql: `SELECT to_jsonb(c) - 'channel_identifier' AS row FROM consents c WHERE c.loan_id = $1::uuid ORDER BY c.captured_at, c.id`, p: [id] },
        verifications: { sql: `SELECT to_jsonb(v)${minus(VERIFICATION_CONTENT)} AS row FROM verifications v WHERE v.application_id = (SELECT origination_application_id FROM loans WHERE id = $1::uuid) ORDER BY v.received_at, v.verification_id`, p: [id] },
        credit_reports: { sql: `SELECT to_jsonb(c)${minus(CREDIT_REPORT_CONTENT)} AS row FROM credit_reports c WHERE c.application_id = (SELECT origination_application_id FROM loans WHERE id = $1::uuid) ORDER BY c.pulled_at, c.id`, p: [id] },
        partner_book: { sql: `SELECT to_jsonb(x) AS row FROM (
            SELECT 'partner_book_facts' AS table_name, f.created_at AS at, to_jsonb(f) AS data FROM partner_book_facts f WHERE f.loan_id = $1::uuid
            UNION ALL SELECT 'partner_book_invitations', i.sent_at, to_jsonb(i) - 'message_id' FROM partner_book_invitations i WHERE i.loan_id = $1::uuid
            UNION ALL SELECT 'partner_book_reviews', r.created_at, to_jsonb(r) FROM partner_book_reviews r WHERE r.loan_id = $1::uuid
            UNION ALL SELECT 'readiness_checks', c.created_at, to_jsonb(c) FROM readiness_checks c WHERE c.loan_id = $1::uuid
            ORDER BY 2, 1) x`, p: [id] },
        staff_actions: { sql: `SELECT to_jsonb(a) AS row FROM staff_actions a WHERE a.subject_id = $1 OR a.subject_id IN (SELECT e.id::text FROM escalations e WHERE e.loan_id = $1::uuid UNION SELECT n.id::text FROM notices n WHERE n.loan_id = $1::uuid UNION SELECT t.id::text FROM timers t WHERE t.loan_id = $1::uuid UNION SELECT m.id::text FROM integration_messages m WHERE m.loan_id = $1::uuid) ORDER BY a.at, a.id`, p: [id] },
        directory: NONE,
      };
      case "application": return {
        decisions: { sql: `SELECT to_jsonb(d) AS row FROM agent_decisions d WHERE d.application_id = $1::uuid ORDER BY d.created_at, d.id`, p: [id] },
        notices: { sql: `SELECT to_jsonb(n) AS row FROM notices n WHERE n.loan_id IN (SELECT id FROM loans WHERE origination_application_id = $1::uuid) OR n.id IN (SELECT (e.payload->>'notice_id')::uuid FROM loan_events e WHERE e.application_id = $1::uuid AND e.payload ? 'notice_id' AND e.payload->>'notice_id' ~ '^[0-9a-f-]{36}$') ORDER BY n.produced_at, n.id`, p: [id] },
        timers: { sql: `SELECT to_jsonb(t) AS row FROM timers t WHERE t.application_id = $1::uuid ORDER BY t.armed_at, t.id`, p: [id] },
        escalations: { sql: `SELECT to_jsonb(e) AS row FROM escalations e WHERE e.application_id = $1::uuid ORDER BY e.opened_at, e.id`, p: [id] },
        ledger_sets: { sql: `SELECT to_jsonb(x) AS row FROM (SELECT s.*, (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.sequence) FROM ledger_lines l WHERE l.set_id = s.id) AS lines FROM ledger_entry_sets s WHERE EXISTS (SELECT 1 FROM ledger_lines l WHERE l.set_id = s.id AND l.loan_id IN (SELECT id FROM loans WHERE origination_application_id = $1::uuid)) ORDER BY s.posted_at, s.id) x`, p: [id] },
        agent_turns: { sql: `SELECT to_jsonb(x) AS row FROM (SELECT t.turn_id, t.conversation_id, t.party_id, t.session_id, t.message_id, t.reply_message_id, t.channel, t.ai_system_version_id, t.model_version, t.prompt_version, t.tier, t.context_hash, t.safe_classification, t.guard_result, t.latency_ms, t.tokens_in, t.tokens_out, t.created_at, (SELECT coalesce(jsonb_agg(c->>'name'), '[]'::jsonb) FROM jsonb_array_elements(t.tool_calls) c) AS tool_names FROM agent_turns t WHERE t.party_id IN (SELECT coalesce(ab.party_id, b.party_id) FROM application_borrowers ab LEFT JOIN borrowers b ON b.id = ab.borrower_id WHERE ab.application_id = $1::uuid AND coalesce(ab.party_id, b.party_id) IS NOT NULL) ORDER BY t.created_at, t.turn_id) x`, p: [id] },
        consents: { sql: `SELECT to_jsonb(c) - 'channel_identifier' AS row FROM consents c WHERE c.application_id = $1::uuid OR c.new_application_id = $1::uuid ORDER BY c.captured_at, c.id`, p: [id] },
        verifications: { sql: `SELECT to_jsonb(v)${minus(VERIFICATION_CONTENT)} AS row FROM verifications v WHERE v.application_id = $1::uuid ORDER BY v.received_at, v.verification_id`, p: [id] },
        credit_reports: { sql: `SELECT to_jsonb(c)${minus(CREDIT_REPORT_CONTENT)} AS row FROM credit_reports c WHERE c.application_id = $1::uuid ORDER BY c.pulled_at, c.id`, p: [id] },
        partner_book: { sql: `SELECT to_jsonb(x) AS row FROM (SELECT 'readiness_checks' AS table_name, c.created_at AS at, to_jsonb(c) AS data FROM readiness_checks c WHERE c.application_id = $1::uuid ORDER BY 2) x`, p: [id] },
        staff_actions: { sql: `SELECT to_jsonb(a) AS row FROM staff_actions a WHERE a.subject_id = $1 OR a.subject_id IN (SELECT e.id::text FROM escalations e WHERE e.application_id = $1::uuid UNION SELECT t.id::text FROM timers t WHERE t.application_id = $1::uuid) ORDER BY a.at, a.id`, p: [id] },
        directory: NONE,
      };
      case "party": return {
        // the person's loans and applications (the directory's scope) plus the rows keyed on the party itself; a decision on a shared application is this person's only when it names no other party (ownPartyDecisionPredicate)
        decisions: { sql: `SELECT to_jsonb(d) AS row FROM agent_decisions d WHERE (d.loan_id = ANY($2::uuid[]) OR d.application_id = ANY($3::uuid[]) OR (d.subject_kind = 'party' AND d.subject_id = $1)) AND ${ownPartyDecisionPredicate("$1")} ORDER BY d.created_at, d.id`, p: P5 },
        notices: { sql: `SELECT to_jsonb(n) AS row FROM notices n WHERE $1::uuid = ANY(n.recipient_party_ids) ORDER BY n.produced_at, n.id`, p: P5 },
        timers: { sql: `SELECT to_jsonb(t) AS row FROM timers t WHERE t.loan_id = ANY($2::uuid[]) OR t.application_id = ANY($3::uuid[]) OR (t.subject_kind = 'party' AND t.subject_id = $1) ORDER BY t.armed_at, t.id`, p: P5 },
        escalations: { sql: `SELECT to_jsonb(e) AS row FROM escalations e WHERE (e.loan_id = ANY($2::uuid[]) OR e.application_id = ANY($3::uuid[]) OR e.payload->>'party_id' = $1) AND (e.payload->>'party_id' IS NULL OR e.payload->>'party_id' = $1) ORDER BY e.opened_at, e.id`, p: P5 },
        ledger_sets: { sql: `SELECT to_jsonb(x) AS row FROM (SELECT s.*, (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.sequence) FROM ledger_lines l WHERE l.set_id = s.id) AS lines FROM ledger_entry_sets s WHERE EXISTS (SELECT 1 FROM ledger_lines l WHERE l.set_id = s.id AND l.loan_id = ANY($2::uuid[])) ORDER BY s.posted_at, s.id) x`, p: P5 },
        // the turn's model and prompt versions, guard result and tool names — never the context hash or the arguments (34.2 rule 2 / NO_SECRETS)
        agent_turns: { sql: `SELECT to_jsonb(x) AS row FROM (SELECT t.turn_id, t.conversation_id, t.party_id, t.session_id, t.message_id, t.reply_message_id, t.channel, t.ai_system_version_id, t.model_version, t.prompt_version, t.tier, t.safe_classification, t.guard_result, t.latency_ms, t.tokens_in, t.tokens_out, t.created_at, (SELECT coalesce(jsonb_agg(c->>'name'), '[]'::jsonb) FROM jsonb_array_elements(t.tool_calls) c) AS tool_names FROM agent_turns t WHERE t.party_id = $1::uuid ORDER BY t.created_at, t.turn_id) x`, p: P5 },
        consents: { sql: `SELECT to_jsonb(c) - 'channel_identifier' AS row FROM consents c WHERE c.party_id = $1::uuid OR c.borrower_id = ANY($4::uuid[]) OR (c.party_id IS NULL AND c.borrower_id IS NULL AND c.loan_id = ANY($2::uuid[])) ORDER BY c.captured_at, c.id`, p: P5 },
        verifications: NONE,
        credit_reports: NONE,
        // the facts without the tape's raw cells (NO_SECRETS); a review or a readiness row on a shared subject only when it names this person or no one
        partner_book: { sql: `SELECT to_jsonb(x) AS row FROM (
            SELECT 'partner_book_facts' AS table_name, f.created_at AS at, to_jsonb(f) - 'raw' AS data FROM partner_book_facts f WHERE f.loan_id = ANY($2::uuid[])
            UNION ALL SELECT 'partner_book_invitations', i.sent_at, to_jsonb(i) - 'message_id' FROM partner_book_invitations i WHERE i.party_id = $1::uuid
            UNION ALL SELECT 'partner_book_reviews', r.created_at, to_jsonb(r) FROM partner_book_reviews r WHERE r.party_id = $1::uuid OR (r.party_id IS NULL AND r.loan_id = ANY($2::uuid[]))
            UNION ALL SELECT 'readiness_checks', c.created_at, to_jsonb(c) FROM readiness_checks c WHERE c.party_id = $1::uuid OR (c.party_id IS NULL AND (c.loan_id = ANY($2::uuid[]) OR c.application_id = ANY($3::uuid[])))
            ORDER BY 2, 1) x`, p: P5 },
        staff_actions: { sql: `SELECT to_jsonb(a) AS row FROM staff_actions a WHERE a.subject_id = $1 ORDER BY a.at, a.id`, p: P5 },
        // 34.2 rule 5: the person's own directory rows, column by column — a session without its token hash, the thread, the cards and their transitions without props / evidence (vendor payloads), the unmasks (the looks at this person); the export receipts (directory_exports, evidence_packs) are the packs' own rows, not the person's record, and would make every pack differ from itself on verification
        directory: { sql: `SELECT to_jsonb(x) AS row FROM (
            SELECT 'sessions' AS table_name, s.created_at AS at, jsonb_build_object('session_id', s.session_id, 'party_id', s.party_id, 'level', s.level, 'auth_method', s.auth_method, 'created_at', s.created_at, 'last_seen_at', s.last_seen_at, 'last_l1_at', s.last_l1_at, 'expires_at', s.expires_at, 'revoked_at', s.revoked_at) AS data FROM sessions s WHERE s.party_id = $1::uuid
            UNION ALL SELECT 'messages', m.at, jsonb_build_object('message_id', m.message_id, 'conversation_id', m.conversation_id, 'at', m.at, 'sender', m.sender, 'sender_ref', m.sender_ref, 'channel', m.channel, 'body_text', m.body_text, 'card_instance_id', m.card_instance_id, 'subject_application_id', m.subject_application_id, 'subject_loan_id', m.subject_loan_id, 'voice_turn', m.voice_turn, 'copy_tokens', m.copy_tokens, 'created_at', m.created_at) FROM messages m WHERE $5::uuid IS NOT NULL AND m.conversation_id = $5::uuid
            UNION ALL SELECT 'card_instances', c.created_at, jsonb_build_object('card_instance_id', c.card_instance_id, 'conversation_id', c.conversation_id, 'party_id', c.party_id, 'subject_application_id', c.subject_application_id, 'subject_loan_id', c.subject_loan_id, 'kind', c.kind, 'status', c.status, 'created_by', c.created_by, 'copy_key', c.copy_key, 'command_ref', c.command_ref, 'expires_at', c.expires_at, 'created_at', c.created_at, 'resolved_at', c.resolved_at) FROM card_instances c WHERE c.party_id = $1::uuid
            UNION ALL SELECT 'card_instance_events', e.at, jsonb_build_object('id', e.id, 'card_instance_id', e.card_instance_id, 'from_status', e.from_status, 'to_status', e.to_status, 'at', e.at, 'actor', e.actor, 'created_at', e.created_at) FROM card_instance_events e JOIN card_instances c ON c.card_instance_id = e.card_instance_id WHERE c.party_id = $1::uuid
            UNION ALL SELECT 'directory_unmasks', u.granted_at, to_jsonb(u) FROM directory_unmasks u WHERE u.party_id = $1::uuid
            ORDER BY 2, 1) x`, p: P5 },
      };
      case "period": return {
        decisions: { sql: `SELECT to_jsonb(d) AS row FROM agent_decisions d WHERE d.created_at >= $1::date AND d.created_at < ${toExcl} ORDER BY d.created_at, d.id`, p: [from, sub.to] },
        notices: { sql: `SELECT to_jsonb(n) AS row FROM notices n WHERE n.produced_at >= $1::date AND n.produced_at < ${toExcl} ORDER BY n.produced_at, n.id`, p: [from, sub.to] },
        timers: { sql: `SELECT to_jsonb(t) AS row FROM timers t WHERE t.armed_at >= $1::date AND t.armed_at < ${toExcl} ORDER BY t.armed_at, t.id`, p: [from, sub.to] },
        escalations: { sql: `SELECT to_jsonb(e) AS row FROM escalations e WHERE e.opened_at >= $1::date AND e.opened_at < ${toExcl} ORDER BY e.opened_at, e.id`, p: [from, sub.to] },
        ledger_sets: { sql: `SELECT to_jsonb(x) AS row FROM (SELECT s.*, (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.sequence) FROM ledger_lines l WHERE l.set_id = s.id) AS lines FROM ledger_entry_sets s WHERE s.posted_at >= $1::date AND s.posted_at < ${toExcl} ORDER BY s.posted_at, s.id) x`, p: [from, sub.to] },
        agent_turns: { sql: `SELECT to_jsonb(x) AS row FROM (SELECT t.turn_id, t.conversation_id, t.party_id, t.session_id, t.message_id, t.reply_message_id, t.channel, t.ai_system_version_id, t.model_version, t.prompt_version, t.tier, t.context_hash, t.safe_classification, t.guard_result, t.latency_ms, t.tokens_in, t.tokens_out, t.created_at, (SELECT coalesce(jsonb_agg(c->>'name'), '[]'::jsonb) FROM jsonb_array_elements(t.tool_calls) c) AS tool_names FROM agent_turns t WHERE t.created_at >= $1::date AND t.created_at < ${toExcl} ORDER BY t.created_at, t.turn_id) x`, p: [from, sub.to] },
        consents: { sql: `SELECT to_jsonb(c) - 'channel_identifier' AS row FROM consents c WHERE c.captured_at >= $1::date AND c.captured_at < ${toExcl} ORDER BY c.captured_at, c.id`, p: [from, sub.to] },
        verifications: { sql: `SELECT to_jsonb(v)${minus(VERIFICATION_CONTENT)} AS row FROM verifications v WHERE v.received_at >= $1::date AND v.received_at < ${toExcl} ORDER BY v.received_at, v.verification_id`, p: [from, sub.to] },
        credit_reports: { sql: `SELECT to_jsonb(c)${minus(CREDIT_REPORT_CONTENT)} AS row FROM credit_reports c WHERE c.pulled_at >= $1::date AND c.pulled_at < ${toExcl} ORDER BY c.pulled_at, c.id`, p: [from, sub.to] },
        partner_book: { sql: `SELECT to_jsonb(x) AS row FROM (
            SELECT 'partner_book_facts' AS table_name, f.created_at AS at, to_jsonb(f) AS data FROM partner_book_facts f WHERE f.created_at >= $1::date AND f.created_at < ${toExcl}
            UNION ALL SELECT 'partner_book_invitations', i.sent_at, to_jsonb(i) - 'message_id' FROM partner_book_invitations i WHERE i.sent_at >= $1::date AND i.sent_at < ${toExcl}
            UNION ALL SELECT 'partner_book_reviews', r.created_at, to_jsonb(r) FROM partner_book_reviews r WHERE r.created_at >= $1::date AND r.created_at < ${toExcl}
            UNION ALL SELECT 'readiness_checks', c.created_at, to_jsonb(c) FROM readiness_checks c WHERE c.created_at >= $1::date AND c.created_at < ${toExcl}
            ORDER BY 2, 1) x`, p: [from, sub.to] },
        staff_actions: { sql: `SELECT to_jsonb(a) AS row FROM staff_actions a WHERE a.at >= $1::date AND a.at < ${toExcl} ORDER BY a.at, a.id`, p: [from, sub.to] },
        directory: NONE,
      };
    }
  })();
  // a party subject's rows pass the directory's NO_SECRETS / NO_FULL_SSN pass (34.2 rule 2: a typed SSN in a message body is redacted, a secret key dropped) — deterministic, so the verification re-reads identically
  const pass = (rows: Row[]): Row[] => (sub.kind === "party" ? stripSecrets(rows) : rows);
  for (const name of EVIDENCE_SECTIONS) {
    if (name === "events" || !wanted.has(name)) continue;
    const q = P[name]!; let raw: Row[];
    const b = q.p === P5 ? bound(q.sql) : { sql: q.sql, p: q.p };
    try { raw = (await jsonRows(db, b.sql, b.p)) as Row[]; } catch (e) { throw new Error(`evidence pack: the ${name} rows of the ${sub.kind} subject could not be read: ${(e as Error).message}`, { cause: e }); }
    const rows = pass(raw);
    if (name === "notices") {
      // the notice with its checklist results, its deliveries, the rendered text the runtime holds (32.12: the shared notice memory) and the rendered document's id and hash
      const ids = rows.map((r) => String(r["id"]));
      const checklists = ids.length ? pass(await jsonRows(db, `SELECT to_jsonb(c) AS row FROM notice_checklist_results c WHERE c.notice_id = ANY($1::uuid[]) ORDER BY c.evaluated_at, c.id`, [ids]) as Row[]) : [];
      const deliveries = ids.length ? pass(await jsonRows(db, `SELECT to_jsonb(d) AS row FROM notice_deliveries d WHERE d.notice_id = ANY($1::uuid[]) ORDER BY d.notice_id, d.attempt_no`, [ids]) as Row[]) : [];
      const docs = ids.length ? await db.query<{ notice_id: string; id: string; sha256: string; byte_size: unknown; mime_type: string | null }>(`SELECT n.id::text AS notice_id, d.id::text AS id, d.sha256, d.byte_size, d.mime_type FROM notices n JOIN documents d ON d.id = n.document_id WHERE n.id = ANY($1::uuid[])`, [ids])  : [];
      sets[name] = pass(rows.map((r) => { const nid = String(r["id"]); const mem = rt.noticeMemory.get(nid); const doc = docs.find((d) => d.notice_id === nid);
        return { ...r, checklist_results: checklists.filter((c) => String(c["notice_id"]) === nid), deliveries: deliveries.filter((d) => String(d["notice_id"]) === nid), rendered: mem ? JSON.parse(toJson(mem.rendered)) : null, rendered_document: doc ? { document_id: doc.id, sha256: doc.sha256, byte_size: String(doc.byte_size), mime_type: doc.mime_type } : null }; }));
      detail[name] = { notices: rows.length, checklist_results: checklists.length, deliveries: deliveries.length, rendered_text: rows.filter((r) => rt.noticeMemory.has(String(r["id"]))).length };
    } else if (name === "timers") {
      const ids = rows.map((r) => String(r["id"]));
      const hist = ids.length ? await jsonRows(db, `SELECT to_jsonb(e) AS row FROM loan_events e WHERE e.type LIKE 'timer.%' AND e.payload->>'timer_id' = ANY($1::text[]) ORDER BY e.sequence`, [ids]) as Row[] : [];
      sets[name] = pass(rows.map((r) => ({ ...r, history: hist.filter((h) => String((h["payload"] as Row)["timer_id"]) === String(r["id"])) })));
      detail[name] = { timers: rows.length, history_events: hist.length };
    } else if (name === "escalations") {
      const ids = rows.map((r) => String(r["id"]));
      const receipts = ids.length ? await jsonRows(db, `SELECT to_jsonb(e) AS row FROM loan_events e WHERE e.type = 'escalation.completed' AND e.payload->>'escalation_id' = ANY($1::text[]) ORDER BY e.sequence`, [ids]) as Row[] : [];
      sets[name] = pass(rows.map((r) => ({ ...r, completions: receipts.filter((c) => String((c["payload"] as Row)["escalation_id"]) === String(r["id"])) })));
      detail[name] = { escalations: rows.length, completion_receipts: receipts.length };
    } else if (name === "partner_book" || name === "directory") {
      sets[name] = rows; const d: Record<string, number> = {}; for (const r of rows) d[String(r["table_name"])] = (d[String(r["table_name"])] ?? 0) + 1; detail[name] = d;
    } else sets[name] = rows;
  }
  return { sets, detail };
}

/** The events of the subject in sequence order, read in parts of `partSize` (`sequence` is the cursor, so a part never repeats a row). */
async function* eventParts(db: Queryable, sub: Subject, partSize: number): AsyncGenerator<Row[]> {
  // a party: the events of the person's loans and applications, the party-scoped ones (a `party` aggregate or `payload.party_id`), never one naming another party (34.2 T5)
  const where = sub.kind === "loan" ? `e.loan_id = $1::uuid` : sub.kind === "application" ? `e.application_id = $1::uuid`
    : sub.kind === "party" ? `(e.loan_id = ANY($2::uuid[]) OR e.application_id = ANY($3::uuid[]) OR (e.loan_id IS NULL AND e.application_id IS NULL AND ((e.aggregate_kind = 'party' AND e.aggregate_id = $1) OR e.payload->>'party_id' = $1))) AND ${ownPartyEventPredicate("$1")}`
    : `e.occurred_at >= $1::date AND e.occurred_at < (($2::date + interval '1 day')::timestamptz)`;
  const base: unknown[] = sub.kind === "period" ? [sub.from, sub.to] : sub.kind === "party" ? [sub.id, (sub.scope ?? NO_SCOPE).loan_ids, (sub.scope ?? NO_SCOPE).application_ids] : [sub.id];
  let after = -1;
  for (;;) {
    const raw = (await jsonRows(db, `SELECT to_jsonb(e) AS row FROM loan_events e WHERE ${where} AND e.sequence > $${base.length + 1} ORDER BY e.sequence LIMIT $${base.length + 2}`, [...base, after, partSize])) as Row[];
    if (!raw.length) return;
    const rows = sub.kind === "party" ? stripSecrets(raw) : raw;
    yield rows;
    after = Number(rows[rows.length - 1]!["sequence"]);
    if (rows.length < partSize) return;
  }
}

const normalizeSections = (v: readonly string[] | null | undefined): EvidenceSection[] => {
  if (!v || !v.length) return [...EVIDENCE_SECTIONS];
  const bad = v.filter((x) => !(EVIDENCE_SECTIONS as readonly string[]).includes(x)); if (bad.length) throw new ControlsRefused(400, "BAD_SECTION", `unknown section(s) ${bad.join(", ")}; sections are ${EVIDENCE_SECTIONS.join(", ")}`, { sections: EVIDENCE_SECTIONS });
  return EVIDENCE_SECTIONS.filter((x) => v.includes(x));
};

/** `controls.evidence.pack{subject, sections?}` → the pack: rows, manifest, one document (+ event parts), the evidence_packs row, the event. */
export async function buildEvidencePack(rt: Runtime, i: EvidenceRequest, nowIso: string = rt.clock.now()): Promise<EvidencePackResult> {
  const sections = normalizeSections(i.sections); const wanted = new Set<EvidenceSection>(sections);
  const partSize = Math.max(1, Math.min(i.part_size ?? EVENT_PART_SIZE, EVENT_PART_SIZE));
  const asked = subjectOf(i.subject);
  if (asked.kind !== "period") {
    const table = asked.kind === "loan" ? "loans" : asked.kind === "application" ? "applications" : "parties";
    const exists = await rt.db.query<{ id: string }>(`SELECT id::text AS id FROM ${table} WHERE id = $1::uuid`, [asked.id]); if (!exists.length) throw new ControlsRefused(404, "NO_SUCH_SUBJECT", `no ${asked.kind} ${asked.id}`);
  }
  const sub = await resolveSubject(rt, i.subject);
  const pack_id = randomUUID(); const producedBy = i.produced_by;
  const { sets, detail } = await collectSets(rt, sub, wanted);
  // the events: parts of ≤ partSize rows, each its own document; the section's hash covers every event in order (the parts' hashes chained)
  const parts: (ManifestPart & { content: string })[] = []; let eventCount = 0; const partHashes: string[] = [];
  if (wanted.has("events")) {
    let n = 0;
    for await (const rows of eventParts(rt.db, sub, partSize)) {
      n += 1; const content = toJson({ pack_id, part: n, subject: { kind: sub.kind, id: sub.id, from_date: sub.from, to_date: sub.to }, events: rows });
      const sha = sha256Hex(content); partHashes.push(sha); eventCount += rows.length;
      parts.push({ part: n, document_id: randomUUID(), sha256: sha, byte_size: Buffer.byteLength(content, "utf8"), event_count: rows.length, from_sequence: Number(rows[0]!["sequence"]), to_sequence: Number(rows[rows.length - 1]!["sequence"]), content });
    }
  }
  const manifestSections: ManifestSection[] = sections.map((name) => name === "events" ? { name, count: eventCount, sha256: sha256Hex(partHashes.join("\n")), detail: { parts: parts.length } } : { name, count: (sets[name] ?? []).length, sha256: sha256Hex(rowJson(sets[name] ?? [])), ...(detail[name] ? { detail: detail[name] } : {}) });
  const setsSha = sha256Hex(manifestSections.map((m) => `${m.name}:${m.count}:${m.sha256}`).join("\n"));
  const manifest: EvidenceManifest = { pack_id, subject: { kind: sub.kind, id: sub.id, from_date: sub.from, to_date: sub.to }, produced_at: nowIso, produced_by: producedBy.id, produced_role: producedBy.role ?? null, rule_set_version: CONTROLS_RULE_SET_VERSION,
    sections: manifestSections, parts: parts.map(({ content: _c, ...p }) => p), part_count: parts.length, part_size: partSize, sets_sha256: setsSha };
  const document = toJson({ manifest, sets });
  const sha256 = sha256Hex(document); const byteSize = Buffer.byteLength(document, "utf8"); const document_id = randomUUID();
  const producedById = producedBy.kind === "human" && isUuid(producedBy.id) ? producedBy.id : null;
  const loanId = sub.kind === "loan" ? sub.id : null; const appId = sub.kind === "application" ? sub.id : null;
  await rt.db.tx(async (q) => {
    // `retain: "metadata"`: the text rides with its row (the pack of a directory export is produced on the runtime's path, where no blob store is wired)
    const retained = i.retain === "metadata";
    await q.query(`INSERT INTO documents (id, loan_id, application_id, kind, sha256, byte_size, storage_uri, mime_type, retention_class, metadata, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 'application/json', 'corporate_7y', $8::jsonb, $9::timestamptz)`,
      [document_id, loanId, appId, PACK_DOCUMENT_KIND, sha256, byteSize, `evidence://packs/${pack_id}`, toJson({ pack_id, subject: manifest.subject, part_count: parts.length, produced_by: producedBy.id, sections, ...(retained ? { retained: "metadata", document } : {}) }), nowIso]);
    for (const p of parts) await q.query(`INSERT INTO documents (id, loan_id, application_id, kind, sha256, byte_size, storage_uri, mime_type, retention_class, metadata, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 'application/json', 'corporate_7y', $8::jsonb, $9::timestamptz)`,
      [p.document_id, loanId, appId, PART_DOCUMENT_KIND, p.sha256, p.byte_size, `evidence://packs/${pack_id}/part/${p.part}`, toJson({ pack_id, part: p.part, event_count: p.event_count, from_sequence: p.from_sequence, to_sequence: p.to_sequence, ...(retained ? { retained: "metadata", content: p.content } : {}) }), nowIso]);
    await q.query(`INSERT INTO evidence_packs (id, subject_kind, subject_id, from_date, to_date, sections, manifest, document_id, sha256, produced_by, created_at) VALUES ($1, $2, $3, $4::date, $5::date, $6::text[], $7::jsonb, $8, $9, $10, $11::timestamptz)`,
      [pack_id, sub.kind, sub.id, sub.from, sub.to, sections, toJson(manifest), document_id, sha256, producedById, nowIso]);
    await appendEvent(q, { type: "evidence.pack.produced", actor: producedBy, loan_id: loanId, application_id: appId, aggregate: { kind: "evidence_pack", id: pack_id }, occurred_at: nowIso, payload: { pack_id, subject: manifest.subject, sections, sha256, document_id, part_count: parts.length, event_count: eventCount, by: producedBy.id, by_role: producedBy.role ?? null } });
  });
  rt.logger?.info("controls.evidence.pack.produced", { pack_id, subject: manifest.subject, sha256, document_id, part_count: parts.length, event_count: eventCount, by: producedBy.id });
  return { id: pack_id, subject_kind: sub.kind, subject_id: sub.id, from_date: sub.from, to_date: sub.to, sections, manifest, document_id, sha256, produced_by: producedById, created_at: nowIso, part_count: parts.length, byte_size: byteSize, document, parts: parts.map((p) => ({ part: p.part, document_id: p.document_id, sha256: p.sha256, byte_size: p.byte_size, content: p.content })) };
}

const packRow = (r: Row): EvidencePackRow => ({ id: String(r["id"]), subject_kind: String(r["subject_kind"]), subject_id: r["subject_id"] ? String(r["subject_id"]) : null, from_date: r["from_date"] ? String(r["from_date"]) : null, to_date: r["to_date"] ? String(r["to_date"]) : null, sections: (r["sections"] as string[] | null) ?? [], manifest: r["manifest"] as EvidenceManifest, document_id: r["document_id"] ? String(r["document_id"]) : null, sha256: String(r["sha256"]), produced_by: r["produced_by"] ? String(r["produced_by"]) : null, created_at: String(r["created_at"]) });
const PACK_COLS = `p.id::text AS id, p.subject_kind, p.subject_id, p.from_date::text AS from_date, p.to_date::text AS to_date, p.sections, p.manifest, p.document_id::text AS document_id, p.sha256, p.produced_by::text AS produced_by, p.created_at::text AS created_at`;
/** `GET /ops/api/controls/evidence/{id}` — the row with its manifest (the document itself is re-read from the blob store when one is wired, else re-assembled and verified with `verifyEvidencePack`). */
export async function getEvidencePack(rt: Runtime, id: string): Promise<EvidencePackRow | null> {
  if (!isUuid(id)) throw new RangeError("pack id is a uuid");
  const r = (await rt.db.query<Row>(`SELECT ${PACK_COLS} FROM evidence_packs p WHERE p.id = $1::uuid`, [id]))[0]; return r ? packRow(r) : null;
}
export async function listEvidencePacks(rt: Runtime, f: { subject_kind?: string | null; subject_id?: string | null; limit?: number } = {}): Promise<EvidencePackRow[]> {
  const where: string[] = []; const p: unknown[] = [];
  if (f.subject_kind) { p.push(f.subject_kind); where.push(`p.subject_kind = $${p.length}`); }
  if (f.subject_id) { p.push(f.subject_id); where.push(`p.subject_id = $${p.length}`); }
  p.push(Math.min(Math.max(Number(f.limit ?? 100) || 100, 1), 1000));
  return (await rt.db.query<Row>(`SELECT ${PACK_COLS} FROM evidence_packs p ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY p.created_at DESC LIMIT $${p.length}`, p)).map(packRow);
}
/** The examiner's check: every non-event row set re-read from the records hashes as the manifest says (the pack is the stored rows); the event parts by their stored document hashes. */
/** The pack's document text when it was retained with its row (`retain: "metadata"`) — the GET route's fallback when the console's blob store has no copy. */
export async function storedPackDocument(rt: Runtime, pack: Pick<EvidencePackRow, "document_id">): Promise<string | null> {
  if (!pack.document_id) return null;
  const r = (await rt.db.query<{ document: string | null }>(`SELECT metadata->>'document' AS document FROM documents WHERE id = $1::uuid`, [pack.document_id]))[0];
  return r?.document ?? null;
}
export async function verifyEvidencePack(rt: Runtime, id: string): Promise<{ pack_id: string; verified: boolean; sections: { name: string; stored: string; now: string; ok: boolean }[]; parts: { part: number; document_id: string; stored: string; ok: boolean }[] } | null> {
  const pack = await getEvidencePack(rt, id); if (!pack) return null;
  const sub = await resolveSubject(rt, pack.subject_kind === "period" ? { period: { from: pack.from_date!, to: pack.to_date! } } : pack.subject_kind === "loan" ? { loan_id: pack.subject_id! } : pack.subject_kind === "application" ? { application_id: pack.subject_id! } : { party_id: pack.subject_id! });
  const { sets } = await collectSets(rt, sub, new Set(pack.sections.filter((x): x is EvidenceSection => x !== "events" && (EVIDENCE_SECTIONS as readonly string[]).includes(x))));
  const sections = pack.manifest.sections.filter((m) => m.name !== "events").map((m) => { const now = sha256Hex(rowJson(sets[m.name] ?? [])); return { name: m.name, stored: m.sha256, now, ok: now === m.sha256 }; });
  const docs = await rt.db.query<{ id: string; sha256: string }>(`SELECT id::text AS id, sha256 FROM documents WHERE id = ANY($1::uuid[])`, [pack.manifest.parts.map((p) => p.document_id)]);
  const parts = pack.manifest.parts.map((p) => ({ part: p.part, document_id: p.document_id, stored: p.sha256, ok: docs.some((d) => d.id === p.document_id && d.sha256 === p.sha256) }));
  return { pack_id: pack.id, verified: sections.every((x) => x.ok) && parts.every((x) => x.ok), sections, parts };
}
